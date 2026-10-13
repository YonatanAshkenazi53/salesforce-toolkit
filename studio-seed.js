'use strict';
// ════════════════════════════════════════════════════════════════
// ORG SEEDER — reset & seed whole targets from the source of truth
// ════════════════════════════════════════════════════════════════
// User request (2026-08-19): "compare and deploy the whole source org data
// to targets… delete the targets data on objects you select… support delete
// of all of them… from one source to multiple targets."
//
// The view: pick target orgs + objects (live record counts per org), then
//   🧹 Wipe      — delete the selected objects' TARGET rows (children-first)
//   ⬆ Seed      — deploy source rows through the EXISTING engine
//                  (parents-first, lookups between selected objects bridged
//                  by match keys, saved deployment config inherited)
//   🔄 Reset & Seed — wipe then seed: the clean full copy.
// Every leg streams through the live progress panel; wipes demand a typed
// confirmation listing the exact live counts; the source of truth can never
// be a target; read-only orgs are blocked at the engine chokepoint.

// ── Pure: dependency order for a set of objects ────────────────────────
// objs: string[]; refs: { obj: [objects it looks up to] }. Returns
// { order, cycle } — parents first (deploy order); wipes run it REVERSED.
// Only references within the selection matter. A reference cycle can't be
// ordered — remaining objects keep input order and are named, never hidden.
function sftkSeedOrder(objs, refs) {
  const list = Array.isArray(objs) ? objs : [];
  const set = new Set(list);
  const dep = {};
  for (const o of list) {
    dep[o] = new Set(((refs || {})[o] || []).filter(r => set.has(r) && r !== o));
  }
  const order = [];
  const left = new Set(list);
  while (left.size) {
    let progressed = false;
    for (const o of list) {
      if (!left.has(o)) continue;
      if ([...dep[o]].every(p => !left.has(p))) { order.push(o); left.delete(o); progressed = true; }
    }
    if (!progressed) {
      const cycle = list.filter(o => left.has(o));
      return { order: [...order, ...cycle], cycle };
    }
  }
  return { order, cycle: [] };
}

// Standard objects worth seeding — everything else standard is system noise.
// Custom objects are always offered.
function sftkSeedStdWhitelist() {
  return ['Account', 'Contact', 'Lead', 'Opportunity', 'Case', 'Campaign',
    'CampaignMember', 'Product2', 'Pricebook2', 'PricebookEntry', 'Asset',
    'Contract', 'Order', 'OrderItem', 'Task', 'Event', 'Note',
    // Email history (user 2026-08-22). EmailMessage is an ordinary row to
    // the engine — ParentId bridges to Case like any lookup — but its
    // BODY-adjacent parts are not: attachments ride the 📎 Files pass, and
    // recipients live in EmailMessageRelation below.
    'EmailMessage'];
}

// Objects worth seeding that Salesforce marks NOT updateable. The main
// filter demands updateable because the engine's normal contract is
// insert-or-update; these are append-only junctions where insert IS the
// whole story, so they are let through deliberately rather than by
// loosening the filter for everything.
function sftkSeedInsertOnlyStd() {
  return ['EmailMessageRelation'];
}

// ── View state ─────────────────────────────────────────────────────────
let _seedTargets = new Set();      // selected target org urls
let _seedRows    = null;           // [{ name, custom, srcCount, tgtCounts: {url: n} }]
let _seedSel     = new Set();      // selected object api names
let _seedDesc    = {};             // source describes by object (fields)
let _seedBusy    = false;
let _seedDelMode = 'recycle';
// 📎 Files and 🗄 archived rows are OFF by default: both multiply the cost
// of a run (one binary round-trip per file; a second query pass per
// archivable object) and neither is what most seeds are for.
let _seedFiles = false;
let _seedArchived = false;
// Targets whose counts were ACTUALLY loaded — a target ticked after Load has
// no counts and must never reach the wipe confirm as "~0 record(s)"
// (Seeder review wt02z57at, HIGH).
let _seedLoadedTargets = new Set();
let _seedCancelled = false;        // ✋ — checked between objects and targets
let _seedPort = null;              // current leg's run port (cancel channel)

// ── Seed-level PII policy ──────────────────────────────────────────────
// The Seeder IS the seeding product masking was built for, but rules used
// to arrive only when a saved deployment happened to exist for an object —
// so whole-org seeds of profile-less objects went out RAW and silent. This
// policy covers every object in the seed, and ONE salt covers them all:
// that is what keeps masked values joinable across objects (a masked email
// on Contact matches the masked anchor wherever it is referenced) and
// re-seeds idempotent. Machine-local by contract, exactly like piiSalt.
let _seedPii = { salt: '', policy: {} };   // policy keyed "Object.Field"
let _seedPiiLoaded = false;
let _seedPiiScanning = false;
let _seedLoading = false;          // counts sweep in flight
let _seedLoadCancel = false;       // stop pressed during the sweep

async function sftkSeedPiiLoad() {
  if (_seedPiiLoaded) return _seedPii;
  try {
    const r = await chrome.storage.local.get('sftk_seed_pii');
    const v = r && r.sftk_seed_pii;
    if (v) _seedPii = { salt: v.salt || '', policy: v.policy || {} };
  } catch (_) { /* first run — defaults stand */ }
  _seedPiiLoaded = true;
  return _seedPii;
}

// Previews must show what the seed will ACTUALLY write, so the salt has to
// exist before the first preview — not only once a rule is saved.
async function sftkSeedEnsureSalt() {
  if (_seedPii.salt) return _seedPii.salt;
  _seedPii.salt = Array.from(crypto.getRandomValues(new Uint8Array(16)),
    b => b.toString(16).padStart(2, '0')).join('');
  try { await chrome.storage.local.set({ sftk_seed_pii: _seedPii }); } catch (_) {}
  return _seedPii.salt;
}

// One field's real before → after, computed with the SAME functions the
// engine uses at write time.
async function sftkSeedPiiPreview(obj, field, strat) {
  const row = (_seedRows || []).find(r => r.name === obj);
  const sg = ((row && row.pii) || []).find(x => x.field === field);
  const desc = ((_seedDesc[obj] && _seedDesc[obj].fields) || [])
    .find(f => f.name === field) || { type: 'string', length: 255 };
  const src = sg && sg.sample;
  if (src == null || src === '') return { text: 'no sample value found in this org — nothing to preview' };
  const rule = (strat === 'hash' || strat === 'null')
    ? { strategy: strat } : { strategy: 'pattern', pattern: strat };
  const r = await sftkPiiMaskValue(src, desc, await sftkSeedEnsureSalt(), rule);
  const cut = v => { const t = String(v); return t.length > 44 ? t.slice(0, 44) + '…' : t; };
  return {
    before: cut(src),
    after: r.value == null ? '(blank)' : cut(r.value),
    nulled: r.value == null,
  };
}

async function sftkSeedPiiSave() {
  // Mint the salt the moment a rule exists — the engine hard-errors on a
  // policy without one, and that error must never reach a seed.
  if (!_seedPii.salt && Object.keys(_seedPii.policy).length) {
    _seedPii.salt = Array.from(crypto.getRandomValues(new Uint8Array(16)),
      b => b.toString(16).padStart(2, '0')).join('');
  }
  try { await chrome.storage.local.set({ sftk_seed_pii: _seedPii }); } catch (_) {}
}

// The masking rules that apply to ONE object, as the engine wants them.
function sftkSeedPiiForObject(obj) {
  const out = {};
  const pre = String(obj || '').toLowerCase() + '.';
  for (const k of Object.keys(_seedPii.policy || {})) {
    if (k.toLowerCase().startsWith(pre)) out[k] = _seedPii.policy[k];
  }
  return out;
}

// Fields worth sampling: text AND numbers (user 2026-08-21: "mainly we
// should focus on number and text fields"). An identifier or a salary
// stored as a Number is just as sensitive as one stored as Text, and the
// value detector can read either.
function sftkSeedSampleFields(desc) {
  return (desc.fields || []).filter(f =>
    f && f.name && f.createable &&
    (f.type === 'string' || f.type === 'textarea' || f.type === 'email' ||
     f.type === 'phone' || f.type === 'url' ||
     f.type === 'int' || f.type === 'double' || f.type === 'currency' || f.type === 'percent'))
    .slice(0, 40);
}

// Every field on an object that masking can actually write — the menu for
// adding one by hand when the heuristics stayed quiet (a person's name in
// Account.Name, say, which no pattern can detect).
function sftkSeedMaskableFields(obj) {
  return ((_seedDesc[obj] && _seedDesc[obj].fields) || [])
    .filter(f => f && f.name && f.createable && sftkPiiMaskable(f))
    .map(f => f.name);
}

// 🎭 Scan the selected objects for PII — reads sampled VALUES (patterns
// beat field names) plus the org's own compliance tags. Cost is quoted
// BEFORE it runs and progress ticks per object: enterprise orgs make a
// silent multi-minute sweep unacceptable (No Silent Waits).
async function sftkSeedPiiScan() {
  if (_seedPiiScanning) { _seedCancelled = true; return; }
  const objs = [..._seedSel];
  if (!objs.length) { showToast('Select at least one object first', 'warning'); return; }
  await sftkSeedPiiLoad();
  const srcUrl = currentSourceOrg();
  const srcSess = await getOrgSession(srcUrl);
  if (!srcSess?.sid) { showToast(`${orgLabel(srcUrl)} is not open in a Chrome tab`, 'error', 6000); return; }
  const calls = objs.length * 2 + objs.filter(o => !_seedDesc[o]).length;
  const secs = Math.max(1, Math.round(calls * 0.6));
  if (!confirm(`🎭 Scan ${objs.length} object(s) in ${orgLabel(srcUrl)} for personal data?\n\n` +
      `~${calls} API call(s), roughly ${secs < 60 ? `${secs}s` : `${Math.round(secs / 60)} min`}: for each object one sample read (50 rows of its text fields) and one compliance-tag query.\n\n` +
      `Nothing is written and no value leaves your browser — the sample is read, judged, and dropped.`)) return;
  _seedPiiScanning = true;
  _seedCancelled = false;
  const prog = eid('dsSeedPiiProg');
  let done = 0;
  try {
    for (const o of objs) {
      if (_seedCancelled) break;
      if (prog) prog.textContent = `🎭 scanning ${o} — ${done}/${objs.length} object(s)…`;
      try {
        if (!_seedDesc[o]) {
          const d = await sendBg({ type: 'SF_REST_GET', orgUrl: srcSess.orgUrl, sid: srcSess.sid,
            path: `/services/data/v62.0/sobjects/${o}/describe` });
          if (d?.error) throw new Error(d.error);
          _seedDesc[o] = d;
        }
        const fields = sftkSeedSampleFields(_seedDesc[o]);
        const samples = {};
        if (fields.length) {
          const q = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: srcSess.orgUrl, sid: srcSess.sid,
            query: `SELECT ${fields.map(f => f.name).join(',')} FROM ${o} LIMIT 50` });
          for (const f of fields) {
            samples[f.name] = (q && !q.error ? (q.records || []) : []).map(r => r[f.name]);
          }
        }
        let compliance = null;
        try {
          const c = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: srcSess.orgUrl, sid: srcSess.sid,
            query: `SELECT QualifiedApiName, ComplianceGroup FROM FieldDefinition WHERE EntityDefinitionId = '${o}'` });
          if (c && !c.error) {
            compliance = {};
            for (const r of (c.records || [])) compliance[r.QualifiedApiName] = r.ComplianceGroup;
          }
        } catch (_) { /* orgs without the tag are common — heuristics still run */ }
        const row = (_seedRows || []).find(r => r.name === o);
        if (row) {
          row.pii = sftkPiiSuggest(o, _seedDesc[o].fields || [], compliance, samples);
          // Keep ONE real value per suggested field: the masking modal shows
          // "before → after" with the user's own data, which is the only way
          // "Hash (pseudonymize)" ever means anything (user 2026-08-20:
          // "give example, this is il ssn before masking and after").
          for (const sg of row.pii) {
            const v = (samples[sg.field] || []).find(x => x != null && String(x).trim() !== '');
            if (v != null) sg.sample = String(v);
          }
        }
      } catch (e) {
        const row = (_seedRows || []).find(r => r.name === o);
        if (row) row.piiError = e?.message || String(e);
      }
      done++;
    }
  } finally {
    _seedPiiScanning = false;
    const stopped = _seedCancelled;
    _seedCancelled = false;
    sftkSeedRenderRows();
    showToast(stopped
      ? `🎭 PII scan stopped after ${done} of ${objs.length} object(s) — what was scanned is shown.`
      : `🎭 PII scan finished — ${done} object(s) examined.`, stopped ? 'warning' : 'success', 5000);
  }
}

// The accept-or-refuse modal: every suggestion across the whole seed, with
// the proposed strategy (a detected pattern when values gave one away) and
// the honest caveat for that pattern.
function sftkSeedPiiModal(onlyObj) {
  const rows = (_seedRows || []).filter(r =>
    onlyObj ? r.name === onlyObj : (_seedSel.has(r.name) && (r.pii || []).length));
  if (!rows.length || (!onlyObj && !rows.some(r => (r.pii || []).length))) {
    showToast('No PII suggestions yet — run 🎭 Scan for PII first.', 'info', 5000);
    return;
  }
  const patterns = (typeof sftkPiiPatternList === 'function') ? sftkPiiPatternList() : [];
  const patternOpts = patterns.map(p => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
  const strategyFor = (obj, s) => {
    const cur = _seedPii.policy[`${obj}.${s.field}`];
    if (cur) return cur.strategy === 'pattern' ? cur.pattern : cur.strategy;
    return s.pattern || 'hash';
  };
  // Fields the heuristics stayed quiet about. A person's name in
  // Account.Name is real PII that no pattern can detect — so the menu is
  // always one click away, collapsed, per object.
  const manualFold = (r) => {
    const suggested = new Set((r.pii || []).map(x => x.field));
    const rest = sftkSeedMaskableFields(r.name).filter(n => !suggested.has(n));
    if (!rest.length) return '';
    return `<details style="margin:4px 0 0 26px">
      <summary class="ds-oc-sub" style="cursor:pointer">＋ Add a field by hand (${rest.length} maskable)</summary>
      <div style="max-height:150px;overflow:auto;margin-top:4px">
        ${rest.map(n => {
          const key = `${r.name}.${n}`;
          const cur = _seedPii.policy[key];
          const sel = cur ? (cur.strategy === 'pattern' ? cur.pattern : cur.strategy) : 'hash';
          return `<label style="display:flex;gap:8px;align-items:center;font-size:12.5px;padding:1px 0;cursor:pointer">
            <input type="checkbox" data-seed-pii="${esc(key)}" ${cur ? 'checked' : ''}>
            <span style="min-width:180px"><code>${esc(n)}</code></span>
            <select class="ds-select ds-select-sm" data-seed-pii-strat="${esc(key)}" style="width:auto">
              <option value="hash" ${sel === 'hash' ? 'selected' : ''}>Hash (pseudonymize)</option>
              <option value="null" ${sel === 'null' ? 'selected' : ''}>Null (blank it)</option>
              ${patternOpts.replace(`value="${sel}"`, `value="${sel}" selected`)}
            </select>
          </label>`;
        }).join('')}
      </div>
    </details>`;
  };
  const body = rows.map(r => `
    <div style="margin:12px 0 4px"><strong>${esc(r.name)}</strong> <span class="ds-oc-sub">${(r.pii || []).length} suggestion(s)</span></div>
    ${!(r.pii || []).length ? '<div class="ds-oc-sub" style="margin-left:26px">Nothing matched — the record Name is only suggested on person-shaped objects (Contact, Lead, and objects named for people), so labels like <code>LC-0400</code> stay out of your way. Add anything by hand below.</div>' : ''}
    ${manualFold(r)}
    ${(r.pii || []).map(s => {
      const key = `${r.name}.${s.field}`;
      const sel = strategyFor(r.name, s);
      return `<div style="padding:5px 0;border-top:1px solid var(--c-border, #333)">
        <label style="display:flex;gap:8px;align-items:center;font-size:12.5px;cursor:pointer">
          <input type="checkbox" data-seed-pii="${esc(key)}" ${_seedPii.policy[key] ? 'checked' : (s.sure ? 'checked' : '')}>
          <span style="min-width:180px"><code>${esc(s.field)}</code></span>
          <select class="ds-select ds-select-sm" data-seed-pii-strat="${esc(key)}" style="width:auto">
            <option value="hash" ${sel === 'hash' ? 'selected' : ''}>Hash (pseudonymize)</option>
            <option value="null" ${sel === 'null' ? 'selected' : ''}>Null (blank it)</option>
            ${patternOpts.replace(`value="${sel}"`, `value="${sel}" selected`)}
          </select>
          <span class="ds-oc-sub" style="flex:1" title="${esc(s.reason)}">${esc(s.reason)}</span>
        </label>
        <div class="ds-oc-sub" data-seed-pii-prev="${esc(key)}"
             style="margin:2px 0 0 26px;font-family:Consolas,monospace;font-size:11.5px">reading a real value from your org…</div>
      </div>`;
    }).join('')}`).join('');
  const caveats = patterns.map(p => `<div style="margin:2px 0"><strong>${esc(p.label)}</strong> — ${esc(p.caveat)}</div>`).join('');
  showModal(`
    <div class="ds-modal-header">🎭 Mask personal data ${onlyObj ? `in ${esc(onlyObj)}` : 'in this seed'}</div>
    <div class="ds-modal-body" style="font-size:12.5px;max-height:60vh;overflow:auto">
      <div class="ds-pk-note">Every line below shows a <strong>real value from your source org</strong> and exactly what the target will receive.
        <div style="margin-top:5px;font-family:Consolas,monospace;font-size:11.5px">
          Israeli ID &nbsp;<code>039128053</code> → <code>284617035</code> <span class="ds-oc-sub">— a different number that still passes the ת״ז check digit, so validation rules accept it</span><br>
          Email &nbsp;<code>dana@acme.co.il</code> → <code>k3f9x2q1a7@masked.invalid</code> <span class="ds-oc-sub">— undeliverable by design</span><br>
          Hash &nbsp;<code>Dana Levi</code> → <code>4n98bcncg23</code> <span class="ds-oc-sub">— scrambled, no shape kept: use it where nothing validates the format</span>
        </div>
        <div style="margin-top:5px">The same source value always produces the same fake, so records still join across objects and a re-seed stays idempotent. This is <strong>pseudonymization, not anonymization</strong>.</div>
      </div>
      ${body}
      <details style="margin-top:10px"><summary style="cursor:pointer">What each pattern guarantees — and what it doesn't</summary>
        <div style="margin-top:6px">${caveats}</div>
      </details>
    </div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn ds-btn-primary" id="dsSeedPiiApply">✓ Apply masking rules</button>
    </div>`);
  // Fill every preview with the user's OWN data, then keep each one in step
  // with its dropdown — a strategy name means nothing until you see what it
  // does to a value you recognize.
  const paintPrev = async (key) => {
    const el = document.querySelector(`[data-seed-pii-prev="${CSS.escape(key)}"]`);
    if (!el) return;
    const dot = key.indexOf('.');
    const obj = key.slice(0, dot), field = key.slice(dot + 1);
    const strat = document.querySelector(`[data-seed-pii-strat="${CSS.escape(key)}"]`)?.value || 'hash';
    try {
      const p = await sftkSeedPiiPreview(obj, field, strat);
      if (p.text) { el.textContent = p.text; return; }
      el.innerHTML = `<span style="opacity:.8">${esc(p.before)}</span> → <strong style="color:${p.nulled ? 'var(--c-warn-text, #d97706)' : 'var(--c-ok-text, #16a34a)'}">${esc(p.after)}</strong>` +
        (p.nulled ? ' <span class="ds-oc-sub">— this field type can\'t hold that shape, so it is blanked and counted</span>' : '');
    } catch (e) { el.textContent = `preview failed: ${e?.message || e}`; }
  };
  document.querySelectorAll('[data-seed-pii-prev]').forEach(el => paintPrev(el.dataset.seedPiiPrev));
  document.querySelectorAll('[data-seed-pii-strat]').forEach(sel =>
    sel.addEventListener('change', () => paintPrev(sel.dataset.seedPiiStrat)));
  eid('dsSeedPiiApply')?.addEventListener('click', async () => {
    const next = { ..._seedPii.policy };
    document.querySelectorAll('[data-seed-pii]').forEach(cb => {
      const key = cb.dataset.seedPii;
      const strat = document.querySelector(`[data-seed-pii-strat="${CSS.escape(key)}"]`)?.value || 'hash';
      if (!cb.checked) { delete next[key]; return; }
      next[key] = (strat === 'hash' || strat === 'null')
        ? { strategy: strat } : { strategy: 'pattern', pattern: strat };
    });
    _seedPii.policy = next;
    await sftkSeedPiiSave();
    closeModal();
    sftkSeedRenderRows();
    showToast(`🎭 ${Object.keys(next).length} field(s) will be masked in every seed from this machine.`, 'success', 5000);
  });
}

window.renderSeed = function renderSeed() {
  const srcUrl = (typeof currentSourceOrg === 'function') ? currentSourceOrg() : '';
  const orgs = allMapOrgs().filter(o => _orgKey(o.url) !== _orgKey(srcUrl));
  const ls = _liveOrgSet();
  setMain(`
    ${dsViewHeader({
      icon: 'upload',
      title: 'Org Seeder',
      help: 'Aligns WHOLE ORGS to the source of truth, object by object. Pick targets and objects, then Wipe (delete the targets’ rows), Seed (deploy every source row through the normal engine — Bulk API, matching, PII masking and live progress included), or Reset & Seed for a clean copy. Wipes ask for a typed confirmation with exact record counts; the source of truth can never be a target.',
      subtitle: srcUrl
        ? `Source of truth: <strong>${esc(orgLabel(srcUrl))}</strong> — every seed reads FROM it. Deletes touch TARGETS only.`
        : `No source of truth set — pick one in the topbar <strong>SOURCE</strong> menu first.`,
    })}
    ${srcUrl ? `
    <div class="ds-ring-cfg" style="padding:12px 14px">
      <strong>Targets</strong> <span class="ds-oc-sub">seed writes to every ticked org, one after another</span>
      <div class="ds-ring-orgs" style="margin-top:6px">
        ${orgs.map(o => `
          <label class="ds-fanout-org">
            <input type="checkbox" class="ds-seed-tgt" value="${esc(o.url)}"
              ${_seedTargets.has(o.url) ? 'checked' : ''}>
            <span>${esc(orgOptionLabel(o.url, o.label, ls))}</span> ${prodBadge(o.url)}
          </label>`).join('') || '<div class="ds-seq-empty">No other orgs known — open them in Chrome tabs.</div>'}
      </div>
      <div style="margin-top:8px">
        <button class="ds-btn ds-btn-primary" id="dsSeedLoad"
          title="Reads the object list (source describe) and LIVE record counts — one COUNT() per object per org. The cost is quoted before the sweep starts, the table fills as counts land, and you can stop at any point.">🔍 Load objects &amp; counts</button>
        <span class="ds-oc-sub" id="dsSeedLoadProg" style="margin-left:8px"></span>
      </div>
    </div>
    <div class="ds-ring-cfg" style="padding:12px 14px;margin-top:10px">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <strong>&#9881; Configuration</strong>
        <span class="ds-oc-sub">Custom Metadata &middot; Custom Settings &middot; Custom Labels</span>
        <span style="flex:1"></span>
        <button class="ds-btn ds-btn-xs" id="dsSeedCfgLoad"
          title="Lists this org's Custom Metadata types and Custom Settings with live row counts per org. One COUNT() per item per org; the cost is quoted first and the table fills as answers land.">${_seedCfgBusy ? '&#9209; Stop' : '&#128269; Load configuration'}</button>
      </div>
      <div id="dsSeedCfgBody"></div>
    </div>
    <div id="dsSeedBody">${_seedRows ? '' : '<div class="ds-pk-note">Tick at least one target, then load objects. Custom objects are listed first; system objects are excluded.</div>'}</div>
    <div id="dsSeedLog"></div>` : ''}
  `);
  document.querySelectorAll('.ds-seed-tgt').forEach(cb => cb.addEventListener('change', () => {
    if (cb.checked) _seedTargets.add(cb.value); else _seedTargets.delete(cb.value);
  }));
  eid('dsSeedLoad')?.addEventListener('click', () => sftkSeedLoad());
  eid('dsSeedCfgLoad')?.addEventListener('click', () => sftkSeedCfgLoad());
  sftkSeedCfgRender();
  // The target list must be as LIVE as the topbar (user 2026-08-31: "not
  // show the current logged org. not dynamic like the others"). allMapOrgs
  // merges _allSessions — but that snapshot is taken at Studio BOOT, so an
  // org logged into afterwards never appears here. Re-ask Chrome on every
  // visit and repaint once when a new org shows up; the second pass finds
  // nothing new, so this cannot loop.
  sendBg({ type: 'GET_ALL_SF_SESSIONS' }).then(r => {
    const fresh = (r && r.sessions) || [];
    if (!fresh.length) return;
    const known = new Set(allMapOrgs().map(o => _orgKey(o.url)));
    _allSessions = fresh;
    const grew = fresh.some(x => x && x.orgUrl && !known.has(_orgKey(x.orgUrl)));
    if (grew && _currentView === 'seed') window.renderSeed();
  }).catch(() => { /* the boot snapshot keeps working */ });
  // Masking rules are machine-local and persist across sessions — load them
  // before the table can claim an object is unmasked.
  sftkSeedPiiLoad().then(() => { if (_seedRows) sftkSeedRenderRows(); });
  // Same for the per-object match keys — the table states which field the
  // run WILL use, so it must not render before the saved picks are in.
  sftkSeedKeysLoad().then(() => { if (_seedRows) sftkSeedRenderRows(); });
  if (_seedRows) sftkSeedRenderRows();
};

// ── Load objects + live counts ─────────────────────────────────────────
async function sftkSeedLoad() {
  // While a sweep runs the button IS the Stop control (No Silent Waits:
  // quote → run → tick → stop).
  if (_seedLoading) { _seedLoadCancel = true; return; }
  const srcUrl = currentSourceOrg();
  const targets = [..._seedTargets];
  if (!targets.length) { showToast('Tick at least one target org first', 'warning'); return; }
  const btn = eid('dsSeedLoad');
  const say = t => { const p = eid('dsSeedLoadProg'); if (p) p.textContent = t; };
  _seedLoading = true;
  _seedLoadCancel = false;
  if (btn) btn.textContent = '⏹ Stop';
  let counted = 0;
  try {
    say('reading the object list…');
    const srcSess = await getOrgSession(srcUrl);
    if (!srcSess?.sid) throw new Error(`${orgLabel(srcUrl)} is not open in a Chrome tab`);
    const gd = await sendBg({ type: 'SF_REST_GET', orgUrl: srcSess.orgUrl, sid: srcSess.sid,
      path: '/services/data/v62.0/sobjects/' });
    if (gd?.error) throw new Error(gd.error);
    const std = new Set(sftkSeedStdWhitelist());
    const insertOnly = new Set(sftkSeedInsertOnlyStd());
    const names = (gd.sobjects || []).filter(s =>
      s.queryable && s.createable && s.deletable
      && (s.updateable || insertOnly.has(s.name))
      && !s.customSetting && !s.deprecatedAndHidden
      && !/__(mdt|e|Share|Tag|History|Feed|ChangeEvent)$/.test(s.name)
      && (s.custom || std.has(s.name) || insertOnly.has(s.name)))
      .map(s => ({ name: s.name, custom: !!s.custom }))
      .sort((a, b) => (a.custom === b.custom) ? a.name.localeCompare(b.name) : (a.custom ? -1 : 1));

    const tgtSess = {};
    for (const t of targets) {
      tgtSess[t] = await getOrgSession(t);
      if (!tgtSess[t]?.sid) throw new Error(`${orgLabel(t)} is not open in a Chrome tab`);
    }

    // State the cost BEFORE spending it. One COUNT() per object per org is
    // instant on a dev org and minutes on an enterprise one, so the number
    // is always shown — and above a threshold the user approves it first.
    const planned = names.length * (1 + targets.length);
    const secs = Math.max(1, Math.round(planned * 0.4));
    const est = secs < 60 ? `${secs}s` : `${Math.round(secs / 60)} min`;
    if (planned > 150 && !confirm(`Count ${names.length} object(s) across ${1 + targets.length} org(s)?\n\n` +
        `~${planned} read-only COUNT() calls, roughly ${est}. Nothing is written.\n\n` +
        `You can stop at any point and keep what was already counted.`)) {
      say('');
      return;
    }

    // The table appears IMMEDIATELY with every object listed and its counts
    // pending, then each cell fills as its query lands — a blank screen for
    // the length of the sweep is exactly what this replaces.
    _seedRows = names.map(o => ({ ...o, srcCount: undefined, tgtCounts: {} }));
    _seedLoadedTargets = new Set(targets);
    _seedSel = new Set();
    sftkSeedRenderRows();
    say(`0 / ${names.length} objects · ~${planned} calls (~${est})`);

    // A '?' used to be a dead end: the cell said "unavailable" and threw
    // away the ONE thing that would let the user act on it — Salesforce's
    // own reason (user 2026-08-22: "i have some with question mark").
    // The reason now rides with the count and lands in the cell's tooltip.
    const count = async (sess, obj) => {
      try {
        const r = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid,
          query: `SELECT COUNT() FROM ${obj}` });
        if (r && !r.error && Number.isFinite(r.totalSize)) return { n: r.totalSize, why: null };
        return { n: null, why: sftkSeedCountWhy(r && r.error, obj) };
      } catch (e) { return { n: null, why: sftkSeedCountWhy(e?.message || String(e), obj) }; }
    };
    const paint = (obj, key, v, why) => {
      const cell = document.querySelector(`[data-seed-cell="${CSS.escape(obj + '|' + key)}"]`);
      if (!cell) return;
      cell.textContent = v == null ? '?' : Number(v).toLocaleString();
      if (v == null && why) cell.title = why;
    };

    for (const row of _seedRows) {
      if (_seedLoadCancel) break;
      say(`counting ${row.name} — ${counted} / ${names.length} object(s)`);
      const sc = await count(srcSess, row.name);
      row.srcCount = sc.n; row.srcWhy = sc.why;
      paint(row.name, 'src', row.srcCount, row.srcWhy);
      row.tgtWhy = row.tgtWhy || {};
      for (const t of targets) {
        if (_seedLoadCancel) break;
        const tc = await count(tgtSess[t], row.name);
        row.tgtCounts[t] = tc.n; row.tgtWhy[t] = tc.why;
        paint(row.name, _orgKey(t), row.tgtCounts[t], row.tgtWhy[t]);
      }
      counted++;
      // The default selection grows as data arrives: custom objects that
      // actually hold source rows.
      if (row.custom && (row.srcCount || 0) > 0) {
        _seedSel.add(row.name);
        const cb = document.querySelector(`.ds-seed-obj[value="${CSS.escape(row.name)}"]`);
        if (cb) cb.checked = true;
        const el = eid('dsSeedSelCount');
        if (el) el.textContent = `${_seedSel.size} selected`;
      }
    }
    if (_seedLoadCancel) {
      say(`stopped — ${counted} of ${names.length} object(s) counted; the rest stay UNKNOWN.`);
      showToast(`Stopped after ${counted} of ${names.length} object(s). Uncounted objects stay UNKNOWN — never assumed empty.`, 'warning', 6500);
    } else {
      say(`${counted} object(s) counted.`);
    }
    sftkSeedRenderRows();
  } catch (e) {
    say('');
    showToast(`Load failed: ${e?.message || e}`, 'error', 6000);
  } finally {
    _seedLoading = false;
    _seedLoadCancel = false;
    const b = eid('dsSeedLoad');
    if (b) { b.disabled = false; b.textContent = '🔍 Load objects & counts'; }
  }
}

function sftkSeedRenderRows() {
  const body = eid('dsSeedBody');
  if (!body || !_seedRows) return;
  const targets = [..._seedTargets];
  // '…' = not counted YET (sweep in flight) · '?' = counted and FAILED.
  // Both are unknown, but only one is final — never render either as 0.
  const n = (v, why) => v === undefined ? '<span title="not counted yet">…</span>'
    : v == null ? `<span style="cursor:help" title="${esc(why || 'The count did not come back — treated as UNKNOWN, never as 0.')}">?</span>`
    : Number(v).toLocaleString();
  body.innerHTML = `
    <div class="ds-ring-cfg" style="padding:12px 14px;margin-top:10px">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <strong>Objects</strong>
        <button class="ds-btn ds-btn-xs" id="dsSeedAllCustom">✓ All custom with data</button>
        <button class="ds-btn ds-btn-xs" id="dsSeedAll">✓ All listed</button>
        <button class="ds-btn ds-btn-xs" id="dsSeedNone">✗ None</button>
        <span class="ds-oc-sub" id="dsSeedSelCount">${_seedSel.size} selected</span>
        <span style="flex:1"></span>
        <button class="ds-btn ds-btn-xs" id="dsSeedPiiScan"
          title="Reads a 50-row sample of each selected object's text fields and the org's compliance tags, then suggests what to mask. Values decide, not field names — a field called Custom_Field_12__c holding ID numbers is caught. Cost is quoted before it runs; nothing is written.">${_seedPiiScanning ? '⏹ Stop scan' : '🎭 Scan for PII'}</button>
        <button class="ds-btn ds-btn-xs" id="dsSeedPiiRules"
          title="Review and accept the masking rules for this seed.">🎭 Masking rules…</button>
        <button class="ds-btn ds-btn-xs" id="dsSeedKeyScan"
          title="Fills the Match key column: reads each object once to find the External ID it would be matched on when seeding WITHOUT deleting. Objects already read are skipped, the cost is quoted first, and you can stop at any point.">${_seedKeyScanning ? '⏹ Stop' : '🔑 Find match keys'}</button>
        <span class="ds-oc-sub" id="dsSeedKeyProg"></span>
        <span class="ds-oc-sub" id="dsSeedPiiProg"></span>
      </div>
      <div style="overflow-x:auto;margin-top:8px">
      <table style="border-collapse:collapse;width:100%;font-size:12.5px">
        <tr>
          <th style="text-align:left;padding:4px 8px"></th>
          <th style="text-align:left;padding:4px 8px">Object</th>
          <th style="text-align:left;padding:4px 8px">PII</th>
          <th style="text-align:left;padding:4px 8px" title="The field the engine uses to recognise a record it already wrote. Only matters when seeding WITHOUT deleting: with a key the record updates, without one it is inserted again.">Match key</th>
          <th style="text-align:right;padding:4px 8px">${esc(orgLabel(currentSourceOrg()))} (source)</th>
          ${targets.map(t => `<th style="text-align:right;padding:4px 8px">${esc(orgLabel(t))}</th>`).join('')}
        </tr>
        ${_seedRows.map(r => `
          <tr style="border-top:1px solid var(--c-border, #333)">
            <td style="padding:3px 8px"><input type="checkbox" class="ds-seed-obj" value="${esc(r.name)}" ${_seedSel.has(r.name) ? 'checked' : ''}></td>
            <td style="padding:3px 8px">${esc(r.name)}${r.custom ? '' : ' <span class="ds-oc-sub">standard</span>'}</td>
            <td style="padding:3px 8px;font-size:11.5px">${(() => {
              const masked = Object.keys(sftkSeedPiiForObject(r.name)).length;
              if (masked) return `<button class="ds-btn ds-btn-xs" data-seed-pii-open="${esc(r.name)}" style="color:var(--c-ok-text, #16a34a)" title="Review or change what is masked on ${esc(r.name)}.">✓ ${masked} masked</button>`;
              if (r.piiError) return `<span style="color:var(--c-warn-text, #d97706)" title="${esc(r.piiError)}">scan failed — UNKNOWN</span>`;
              if (r.pii && r.pii.length) return `<button class="ds-btn ds-btn-xs" data-seed-pii-open="${esc(r.name)}" style="color:var(--c-warn-text, #d97706)" title="Click to review and accept: ${esc(r.pii.map(s => s.field).join(', '))}">🎭 ${r.pii.length} suggested</button>`;
              if (r.pii) return `<button class="ds-btn ds-btn-xs ds-oc-sub" data-seed-pii-open="${esc(r.name)}" title="Nothing matched the value patterns, compliance tags or name heuristics. Click to add a field by hand.">none found</button>`;
              return '<span class="ds-oc-sub" title="Run 🎭 Scan for PII to check this object.">not scanned</span>';
            })()}</td>
            <td style="padding:3px 8px;font-size:11.5px">${(() => {
              const k = sftkSeedKeyInfo(r.name);
              const btn = (color, label, tip) =>
                `<button class="ds-btn ds-btn-xs" data-seed-key-open="${esc(r.name)}" style="${color}" title="${esc(tip)}">${label}</button>`;
              if (k.field && k.merge) {
                return btn('color:var(--c-ok-text, #16a34a)', `🔑 ${esc(k.field)}`,
                  `${k.source}. Seeding without deleting UPDATES matching records instead of inserting copies. Click to change.`);
              }
              if (k.field) {
                return btn('color:var(--c-warn-text, #d97706)', `⚠ ${esc(k.field)}`,
                  `${k.source}, but it is not an External ID — Salesforce cannot upsert on it, so the seed still inserts. Click to change.`);
              }
              if (k.unknown) {
                return btn('', 'not read yet',
                  `${esc(r.name)} has not been described yet. Click to read it and see the key.`);
              }
              return btn('color:var(--c-warn-text, #d97706)', '⚠ none — inserts only',
                `${k.source}. Every source row is inserted; into a non-empty target that means duplicates. Click to pick a key.`);
            })()}</td>
            <td style="padding:3px 8px;text-align:right;font-variant-numeric:tabular-nums" data-seed-cell="${esc(r.name)}|src">${n(r.srcCount, r.srcWhy)}</td>
            ${targets.map(t => {
              const tc = r.tgtCounts[t];
              const same = r.srcCount != null && tc != null && r.srcCount === tc;
              return `<td style="padding:3px 8px;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;${same ? 'opacity:.65' : 'color:var(--c-warn-text, #d97706)'}"><span data-seed-cell="${esc(r.name)}|${esc(_orgKey(t))}">${n(tc, (r.tgtWhy || {})[t])}</span> <button class="ds-btn ds-btn-xs" data-seed-rec="${esc(r.name)}|${esc(t)}" title="Open ⚖ Reconcile for ${esc(r.name)} against ${esc(orgLabel(t))} — compare row by row and pick exactly which records to push, overwrite or delete.">⚖</button></td>`;
            }).join('')}
          </tr>`).join('')}
      </table>
      </div>
      <div class="ds-pk-note" style="margin-top:6px">Counts are live totals — equal counts don't prove equal DATA (🔍 scans do); different counts always mean drift.</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px">
        <label style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px" title="Recycle Bin: deleted records recoverable for 15 days. Hard delete: permanently purged.">
          <span>Delete mode:</span>
          <select id="dsSeedDelMode" class="ds-select ds-select-sm">
            <option value="recycle" ${_seedDelMode === 'recycle' ? 'selected' : ''}>🗑 Recycle Bin (recoverable)</option>
            <option value="hard" ${_seedDelMode === 'hard' ? 'selected' : ''}>🔥 Hard delete (permanent)</option>
          </select>
        </label>
        <label style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px" title="Copy the files attached to every seeded record (ContentVersion + its links), including email attachments. Adds one download and one upload per file. Fails closed when masking is on — file BODIES cannot be masked, so they are skipped and the run says so.">
          <input type="checkbox" id="dsSeedFiles" ${_seedFiles ? 'checked' : ''}>
          <span>📎 Files${Object.keys(_seedPii.policy || {}).length && _seedFiles ? ' <span style="color:var(--c-warn-text, #d97706)">(blocked by masking)</span>' : ''}</span>
        </label>
        <label style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px" title="Also carry ARCHIVED rows. Salesforce hides them from ordinary SOQL, so objects that have them (Task, Event, EmailMessage in some orgs) get a second explicit pass.">
          <input type="checkbox" id="dsSeedArchived" ${_seedArchived ? 'checked' : ''}>
          <span>🗄 Archived rows</span>
        </label>
        <span style="flex:1"></span>
        <button class="ds-btn" id="dsSeedWipe" title="Delete the selected objects' rows in EVERY ticked target — children-first, typed confirmation with exact counts.">🧹 Wipe targets…</button>
        <button class="ds-btn" id="dsSeedGo" title="Seed WITHOUT deleting anything: matching records are updated, missing ones inserted, and the target keeps whatever else it holds. Objects with no match key can only insert — you are warned before, and every duplicate the run leaves is listed after.">⬆ Seed targets <span class="ds-oc-sub">(no delete)</span></button>
        <button class="ds-btn ds-btn-primary" id="dsSeedReset" title="Wipe, then seed: the clean full copy of the source's data.">🔄 Reset &amp; Seed…</button>
      </div>
    </div>`;
  const selSync = () => { const el = eid('dsSeedSelCount'); if (el) el.textContent = `${_seedSel.size} selected`; };
  body.querySelectorAll('.ds-seed-obj').forEach(cb => cb.addEventListener('change', () => {
    if (cb.checked) _seedSel.add(cb.value); else _seedSel.delete(cb.value);
    selSync();
  }));
  eid('dsSeedAllCustom')?.addEventListener('click', () => {
    _seedSel = new Set(_seedRows.filter(r => r.custom && (r.srcCount || 0) > 0).map(r => r.name));
    sftkSeedRenderRows();
  });
  eid('dsSeedAll')?.addEventListener('click', () => { _seedSel = new Set(_seedRows.map(r => r.name)); sftkSeedRenderRows(); });
  eid('dsSeedNone')?.addEventListener('click', () => { _seedSel = new Set(); sftkSeedRenderRows(); });
  eid('dsSeedDelMode')?.addEventListener('change', e => { _seedDelMode = e.target.value; });
  eid('dsSeedPiiScan')?.addEventListener('click', () => sftkSeedPiiScan());
  eid('dsSeedPiiRules')?.addEventListener('click', () => sftkSeedPiiModal());
  eid('dsSeedKeyScan')?.addEventListener('click', () => sftkSeedKeyScan());
  body.querySelectorAll('[data-seed-pii-open]').forEach(b => b.addEventListener('click', () =>
    sftkSeedPiiModal(b.dataset.seedPiiOpen)));
  body.querySelectorAll('[data-seed-key-open]').forEach(b => b.addEventListener('click', () =>
    sftkSeedKeyPicker(b.dataset.seedKeyOpen)));
  body.querySelectorAll('[data-seed-rec]').forEach(b => b.addEventListener('click', () => {
    const [obj, tgt] = String(b.dataset.seedRec).split('|');
    sftkSeedOpenReconcile(obj, tgt);
  }));
  eid('dsSeedWipe')?.addEventListener('click', () => sftkSeedConfirmAndRun({ wipe: true, seed: false }));
  // A seed run also carries the ticked configuration — the whole point of
  // the configuration block is that the data lands in an org set up to
  // accept it, so leaving it behind would defeat it.
  eid('dsSeedGo')?.addEventListener('click', () => sftkSeedConfirmAndRun({ wipe: false, seed: true, config: _seedCfgSel.size > 0 }));
  eid('dsSeedReset')?.addEventListener('click', () => sftkSeedConfirmAndRun({ wipe: true, seed: true, config: _seedCfgSel.size > 0 }));
  eid('dsSeedFiles')?.addEventListener('change', e => { _seedFiles = e.target.checked; sftkSeedRenderRows(); });
  eid('dsSeedArchived')?.addEventListener('change', e => { _seedArchived = e.target.checked; sftkSeedRenderRows(); });
}

// Turn a failed COUNT() into a reason the user can act on. Salesforce
// answers a missing or unreadable object with a raw API code that reads
// like a bug in the extension; naming the real cause is the difference
// between an actionable '?' and a dead one.
function sftkSeedCountWhy(err, obj) {
  const e = String(err || '').trim();
  if (!e) return `${obj}: the count did not come back — treated as UNKNOWN, never as 0.`;
  if (/INVALID_TYPE|is not supported|does not exist|sObject type/i.test(e)) {
    return `${obj} does not exist in this org (or the running user cannot see it) — UNKNOWN, not 0. Seeding it here would fail; wiping it is skipped.`;
  }
  if (/INSUFFICIENT_ACCESS|not allowed|FIELD_INTEGRITY/i.test(e)) {
    return `${obj}: the running user lacks read access in this org — UNKNOWN, not 0. Grant read on the object and re-load.`;
  }
  if (/INVALID_SESSION|SESSION_EXPIRED/i.test(e)) {
    return `${obj}: the session for this org expired — re-open the org in a Chrome tab and re-load.`;
  }
  if (/REQUEST_LIMIT_EXCEEDED|limit/i.test(e)) {
    return `${obj}: the org's API limit was hit — UNKNOWN, not 0. Re-load later.`;
  }
  if (/QUERY_TIMEOUT|timed out|timeout/i.test(e)) {
    return `${obj}: the count timed out — UNKNOWN, not 0. Common on very large objects; the seed itself still works.`;
  }
  return `${obj}: ${e} — UNKNOWN, never assumed 0.`;
}

// Salesforce hides archived rows from ordinary SOQL: a Task older than the
// org's archive horizon is simply absent from "SELECT ... FROM Task", and
// only "WHERE IsArchived = true" brings it back. A seed that ignores this
// copies the recent history and quietly loses the rest — so archivable
// objects get a SECOND pass, and only when the user asks for it.
function sftkSeedIsArchivable(obj) {
  return ((_seedDesc[obj] && _seedDesc[obj].fields) || [])
    .some(f => f && f.name === 'IsArchived');
}

// 🪪 Deploy the identity field + its permission set to the source and
// every ticked target, then assign the permission set to the running user
// in each org — without FLS the field is invisible even to admins, and the
// deploy would "succeed" into uselessness. Per-org: one deploy + three
// small calls; failures are named per org, never averaged away.
async function sftkSeedIdDeploy(obj) {
  const out = { ok: 0, errors: [] };
  const orgs = [currentSourceOrg(), ..._seedTargets];
  // This deploys metadata and grants a permission set in EVERY listed org —
  // production, or an org whose type cannot be confirmed, gets the typed
  // confirmation every other seeder write gets (re-review 2026-09-12).
  // The one confirmation (sftk-confirm.js, campaign 3 phase 2): one combined
  // dialog naming every guarded org, replacing the per-org confirmTypedProd()
  // loop. Same fail-closed rule as before — ensureOrgType decides which orgs
  // are guarded; sftkOrgWriteGate supplies only the display label.
  const guarded = [];
  for (const orgUrl of orgs) {
    const t = await ensureOrgType(orgUrl);
    if (t !== 'sandbox' && t !== 'dev') { guarded.push(orgUrl); }
  }
  if (guarded.length) {
    const gates = await Promise.all(guarded.map(u => sftkOrgWriteGate(u, _orgs)));
    const prodLabel = guarded.map((u, i) => gates[i].label || orgLabel(u)).join(', ');
    const ok = await sftkConfirmDestructive({
      title: `Deploy the ${sftkIdFieldName()} field on ${obj}`,
      icon: '🪪',
      items: [{ label: obj, sub: `and assign the "${sftkIdPermSetName()}" permission set to you` }],
      revOverride: { html: '🔁 <strong>Reversible</strong> — the field and permission set can be removed again in Setup.', needsCheckbox: false },
      confirmLabel: 'Deploy',
      production: { label: prodLabel },
    });
    if (!ok) { out.errors.push('cancelled — nothing was deployed to any org'); return out; }
  }
  const { files, packageXml } = sftkIdPackageFiles([obj], '62.0');
  const enc = new TextEncoder();
  const zipBase64 = window.sftkBuildStoredZip([
    { name: 'package.xml', data: enc.encode(packageXml) },
    ...files.map(f => ({ name: f.name, data: enc.encode(f.text) })),
  ]);
  for (const orgUrl of orgs) {
    const label = orgLabel(orgUrl);
    const sess = await getOrgSession(orgUrl);
    if (!sess?.sid) { out.errors.push(`${label}: not open in a Chrome tab`); continue; }
    // History (sftk-history.js): one journal per org — the field deploy has
    // no verified undo (see the note below); the permission set assignment
    // does, when this run is the one that created it.
    const journal = sftkHistoryBegin({ tool: 'Org Seeder', title: `🪪 ${sftkIdFieldName()} + ${sftkIdPermSetName()} — ${label}`, orgUrl: sess.orgUrl });
    const undoSteps = [];
    let undoNote = `the ${sftkIdFieldName()} field on ${obj} can be removed again in Setup (Object Manager → ${obj} → Fields & Relationships) — deleting a field here has no honest re-read: a successful removal makes the same probe query fail, indistinguishable from a broken one`;
    try {
      // The one write discipline (sftk-write.js): a deploy job's "done" used to
      // BE the report — one probe read of the field it was meant to create
      // closes the same gap a PATCH accepted-but-unchanged taught elsewhere
      // (a deploy can report success with the field still invisible to FLS).
      // confirmed-by: sftkSeedIdDeploy's sftkConfirmDestructive above (before this loop).
      const dw = await sftkWriteVerified({
        describe: `${sftkIdFieldName()} on ${obj} in ${label}`,
        write: () => sendBg({ type: 'SF_METADATA_DEPLOY', orgUrl: sess.orgUrl, sid: sess.sid, zipBase64 }),
        journal,
        verify: async () => {
          const probe = await sendBg({ type: 'SF_QUERY', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false, _suppressError: true,
            query: `SELECT ${sftkIdFieldName()} FROM ${obj} LIMIT 1` });
          return probe?.error
            ? { ok: false, text: `${sftkIdFieldName()} on ${obj} in ${label}: accepted by Salesforce, but the field could not be re-read (${probe.error})` }
            : { ok: true };
        },
      });
      if (!dw.ok) { out.errors.push(`${label}: deploy failed — ${dw.raw?.error || dw.text}`); undoNote = 'the field deploy did not verify — nothing to undo'; continue; }
      // FLS: find the permission set, find ME, assign. An already-assigned
      // error is SUCCESS — the goal is the grant existing, not the insert.
      try {
        const ps = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid,
          query: `SELECT Id FROM PermissionSet WHERE Name = '${sftkIdPermSetName()}' LIMIT 1` });
        const psId = ps?.records?.[0]?.Id;
        const root = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
          path: 'services/data/v62.0/' });
        const userId = sftkIdUserFromIdentity(root?.identity);
        if (!psId || !userId) throw new Error('could not resolve the permission set or your user');
        // confirmed-by: sftkSeedIdDeploy's sftkConfirmDestructive above (before this loop).
        const aw = await sftkWriteVerified({
          describe: `${sftkIdPermSetName()} assignment in ${label}`,
          write: async () => {
            const r = await sendBg({ type: 'SF_REST_POST', orgUrl: sess.orgUrl, sid: sess.sid,
              path: 'services/data/v62.0/sobjects/PermissionSetAssignment',
              body: { AssigneeId: userId, PermissionSetId: psId } });
            if (r?.error && !/DUPLICATE_VALUE|already assigned/i.test(String(r.error))) throw new Error(r.error);
            return { success: true, id: r?.id || null, alreadyAssigned: !!r?.error };
          },
          journal,
          noVerify: 'an insert returns the new row, and "already assigned" already means the grant exists',
        });
        if (!aw.accepted) throw new Error(aw.text);
        out.ok++;
        // History: undo removes the assignment ONLY when THIS run created it —
        // one that already existed (DUPLICATE_VALUE) is not ours to remove.
        if (aw.raw && aw.raw.id && !aw.raw.alreadyAssigned) {
          undoSteps.push({
            describe: `${label}: remove the ${sftkIdPermSetName()} assignment this created`,
            // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
            msg: { type: 'SF_COLLECTIONS_DELETE', ids: [aw.raw.id] },
            verify: { query: `SELECT Id FROM PermissionSetAssignment WHERE Id = '${aw.raw.id}'`, tooling: false, count: 0,
              text: { ok: `${label}: the permission set assignment was removed — verified by re-reading the org`,
                      bad: `${label}: the removal was accepted, but the org still shows the assignment` } },
          });
        }
      } catch (e) {
        out.errors.push(`${label}: field deployed but the permission set could not be assigned (${e?.message || e}) — assign "SFTK Identity" to yourself in Setup, or the field stays invisible`);
      }
    } finally {
      await sftkHistoryEnd(journal, { undo: undoSteps.length ? { steps: undoSteps, note: undoNote } : { none: undoNote } });
    }
  }
  return out;
}

// ── Which key identifies a record? ─────────────────────────────
// A no-delete seed only avoids duplicates when the engine can recognise a
// record it already wrote. That identity rule was derived silently (saved
// deployment → single External ID → nothing), so the user couldn't see it
// before writing to several orgs (user 2026-08-22: "how do we know which
// key is selected for every object?"). Now it is shown per object, and
// choosable. Overrides are machine-local, like the masking policy.
let _seedKeys = {};              // objectApi → field name, or '__none__'
let _seedKeysLoaded = false;

async function sftkSeedKeysLoad() {
  if (_seedKeysLoaded) return _seedKeys;
  try {
    const r = await chrome.storage.local.get('sftk_seed_keys');
    if (r && r.sftk_seed_keys) _seedKeys = r.sftk_seed_keys;
  } catch (_) { /* first run */ }
  _seedKeysLoaded = true;
  return _seedKeys;
}
async function sftkSeedKeysSave() {
  try { await chrome.storage.local.set({ sftk_seed_keys: _seedKeys }); } catch (_) {}
}

// External IDs are the ONLY fields Salesforce can upsert on, so they are
// the only fields that make a seed merge instead of insert. Everything
// else about an object's identity is a comparison rule, not a write rule.
function sftkSeedExtIdFields(obj) {
  return ((_seedDesc[obj] && _seedDesc[obj].fields) || [])
    .filter(f => f && f.externalId && f.createable).map(f => f.name);
}

// The full answer for one object: which field, where it came from, and
// whether it actually makes the seed merge-safe.
function sftkSeedKeyInfo(obj) {
  const saved = (_profiles || []).find(p => p && !p.ephemeral && p.tree && p.tree.objectType === obj);
  const extIds = sftkSeedExtIdFields(obj);
  const scanned = !!_seedDesc[obj];
  const ov = _seedKeys[obj];
  if (ov === '__none__') {
    return { field: null, merge: false, source: 'you chose: no key', chosen: true };
  }
  if (ov) {
    return { field: ov, merge: extIds.includes(ov), source: 'you chose this field', chosen: true };
  }
  const savedKey = saved && saved.tree && saved.tree.upsert && saved.tree.upsert.field;
  if (savedKey) {
    return { field: savedKey, merge: true, source: `from deployment “${saved.name}”` };
  }
  if (extIds.length === 1) return { field: extIds[0], merge: true, source: 'the object’s only External ID' };
  if (extIds.length > 1) return { field: null, merge: false, source: `${extIds.length} External IDs — pick one`, candidates: extIds };
  if (!scanned) return { field: null, merge: false, source: 'not read yet', unknown: true };
  return { field: null, merge: false, source: 'this object has no External ID' };
}

// Fill the Match key column for every listed object in one go.
//
// The column can only name a field once the object has been DESCRIBED, and
// nothing describes objects at load time — counting is one cheap query per
// object, describing is a much heavier call, so paying for it on every load
// would be wrong. The result was a column full of "not read yet" and a user
// who still could not see what a run would match on (user 2026-08-22: "i
// still can't see by what field they are matched"). This is the missing
// middle: one explicit, quoted, cancellable sweep that answers the question
// for every object at once.
let _seedKeyScanning = false;

async function sftkSeedKeyScan() {
  if (_seedKeyScanning) { _seedCancelled = true; return; }
  if (!_seedRows || !_seedRows.length) { showToast('Load objects first', 'warning'); return; }
  await sftkSeedKeysLoad();
  const srcSess = await getOrgSession(currentSourceOrg());
  if (!srcSess?.sid) { showToast(`${orgLabel(currentSourceOrg())} is not open in a Chrome tab`, 'error', 6000); return; }

  // Only objects we have never described cost anything — a re-run after a
  // PII scan is nearly free, and the quote says so rather than re-charging
  // for work already done.
  const todo = _seedRows.map(r => r.name).filter(o => !_seedDesc[o]);
  if (!todo.length) {
    sftkSeedRenderRows();
    showToast('Every listed object was already read — the Match key column is complete.', 'success', 4000);
    return;
  }
  const secs = Math.max(1, Math.round(todo.length * 0.5));
  const est = secs < 60 ? `${secs}s` : `${Math.round(secs / 60)} min`;
  if (todo.length > 25) {
    const go = await new Promise(res => {
      showModal(`
        <div class="ds-modal-header">Read ${todo.length} object(s) to find their match keys</div>
        <div class="ds-modal-body" style="font-size:12.5px">
          <div>One describe per object — ${todo.length} read-only call(s), roughly ${est}. Nothing is written.</div>
          <div class="ds-pk-note" style="margin-top:8px">This is what fills the <strong>Match key</strong> column: the External ID field each object would be matched on when seeding <em>without</em> deleting. Objects already read are skipped.</div>
        </div>
        <div class="ds-modal-footer">
          <button class="ds-btn" data-dsaction="closeModal" id="dsKeyQuoteNo">Cancel</button>
          <button class="ds-btn ds-btn-primary" id="dsKeyQuoteYes">Read them</button>
        </div>`);
      eid('dsKeyQuoteNo')?.addEventListener('click', () => res(false));
      eid('dsKeyQuoteYes')?.addEventListener('click', () => { closeModal(); res(true); });
    });
    if (!go) return;
  }

  _seedKeyScanning = true; _seedCancelled = false;
  const btn = eid('dsSeedKeyScan');
  if (btn) btn.textContent = '⏹ Stop';
  const prog = eid('dsSeedKeyProg');
  let done = 0, failed = 0;
  try {
    for (const o of todo) {
      if (_seedCancelled) break;
      if (prog) prog.textContent = `reading ${o} — ${done} / ${todo.length}`;
      const d = await sendBg({ type: 'SF_REST_GET', orgUrl: srcSess.orgUrl, sid: srcSess.sid,
        path: `/services/data/v62.0/sobjects/${o}/describe` });
      // A describe that fails leaves the object UNKNOWN, never "no key".
      if (d?.error) { failed++; } else { _seedDesc[o] = d; }
      done++;
      // Repaint just this row's key cell as its answer lands.
      const cell = document.querySelector(`[data-seed-key-open="${CSS.escape(o)}"]`);
      if (cell) {
        const k = sftkSeedKeyInfo(o);
        cell.textContent = k.field ? `${k.merge ? '🔑' : '⚠'} ${k.field}`
          : k.unknown ? 'could not read' : '⚠ none \u2014 inserts only';
        cell.style.color = k.field && k.merge ? 'var(--c-ok-text, #16a34a)' : 'var(--c-warn-text, #d97706)';
      }
    }
  } finally {
    _seedKeyScanning = false;
    const b = eid('dsSeedKeyScan');
    if (b) b.textContent = '🔑 Find match keys';
    if (prog) prog.textContent = '';
    sftkSeedRenderRows();
    const withKey = _seedRows.filter(r => sftkSeedKeyInfo(r.name).field).length;
    const noKey = _seedRows.filter(r => { const k = sftkSeedKeyInfo(r.name); return !k.field && !k.unknown; }).length;
    showToast(_seedCancelled
      ? `Stopped after ${done} of ${todo.length}. Unread objects stay UNKNOWN — never "no key".`
      : `${withKey} object(s) have a match key, ${noKey} have none (those can only INSERT)${failed ? `, ${failed} could not be read` : ''}.`,
      _seedCancelled ? 'warning' : 'success', 7000);
  }
}

// The picker. Lazily reads the describe for objects that were never
// scanned, so the key can be inspected without running anything first.
async function sftkSeedKeyPicker(obj) {
  await sftkSeedKeysLoad();
  if (!_seedDesc[obj]) {
    const srcSess = await getOrgSession(currentSourceOrg());
    if (!srcSess?.sid) { showToast(`${orgLabel(currentSourceOrg())} is not open in a Chrome tab`, 'error', 6000); return; }
    showToast(`Reading ${obj}…`, 'info', 2000);
    const d = await sendBg({ type: 'SF_REST_GET', orgUrl: srcSess.orgUrl, sid: srcSess.sid,
      path: `/services/data/v62.0/sobjects/${obj}/describe` });
    if (d?.error) { showToast(`Could not read ${obj}: ${d.error}`, 'error', 6000); return; }
    _seedDesc[obj] = d;
  }
  const info = sftkSeedKeyInfo(obj);
  const extIds = sftkSeedExtIdFields(obj);
  const opt = (val, label, note, on) => `
    <label style="display:flex;gap:8px;align-items:flex-start;padding:4px 0;cursor:pointer">
      <input type="radio" name="dsSeedKeyPick" value="${esc(val)}" ${on ? 'checked' : ''} style="margin-top:3px">
      <span><strong>${esc(label)}</strong><br><span class="ds-oc-sub">${note}</span></span>
    </label>`;
  showModal(`
    <div class="ds-modal-header">🔑 Match key for ${esc(obj)}</div>
    <div class="ds-modal-body" style="font-size:12.5px">
      <div class="ds-pk-note">Seeding without deleting can only <strong>update</strong> a record it recognises. Salesforce recognises records across orgs by an <strong>External ID</strong> field — with one, a re-seed updates in place; without one, every row is inserted again.</div>
      ${extIds.length
        ? extIds.map(fname => opt(fname, fname, 'External ID — merge-safe: existing records update, new ones insert.', info.field === fname)).join('')
        : `<div style="margin:8px 0;color:var(--c-warn-text, #d97706)">${esc(obj)} has no External ID field — so nothing can make a no-delete seed merge instead of duplicate.</div>
           <div style="margin:8px 0;padding:8px 10px;border:1px solid var(--c-border,#333);border-radius:6px">
             <strong>🪪 Create the identity field</strong>
             <div class="ds-oc-sub" style="margin:4px 0 6px">Deploys <code>SFTK_ID__c</code> (Text 18 · External ID · unique) to ${esc(obj)} in the source and every ticked target, with a permission set granting you access. Every seed then writes each record's SOURCE Id into it — matching becomes exact, immune to renames and duplicate names. One deploy per org, quoted below; removable any time in Setup.</div>
             <button class="ds-btn ds-btn-xs ds-btn-primary" id="dsSeedIdCreate">🪪 Deploy SFTK_ID__c to ${1 + [..._seedTargets].length} org(s)</button>
           </div>`}
      ${opt('__none__', 'No key — insert only', 'Every source row is inserted. Into a non-empty target that means duplicates, which the run will list afterwards.', info.chosen && !info.field)}
      <div class="ds-pk-note" style="margin-top:8px">Currently: <strong>${info.field ? esc(info.field) : 'no key'}</strong> <span class="ds-oc-sub">(${esc(info.source)})</span></div>
    </div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      ${(_seedKeys[obj] ? '<button class="ds-btn" id="dsSeedKeyClear">Reset to automatic</button>' : '')}
      <button class="ds-btn ds-btn-primary" id="dsSeedKeyApply">✓ Use this key</button>
    </div>`);
  eid('dsSeedKeyClear')?.addEventListener('click', async () => {
    delete _seedKeys[obj];
    await sftkSeedKeysSave();
    closeModal();
    sftkSeedRenderRows();
  });
  eid('dsSeedIdCreate')?.addEventListener('click', async () => {
    const b = eid('dsSeedIdCreate');
    if (b) { b.disabled = true; b.textContent = '⏳ deploying…'; }
    const res = await sftkSeedIdDeploy(obj);
    if (res.errors.length) {
      showToast(`🪪 ${res.ok} org(s) done, ${res.errors.length} failed: ${res.errors.join(' · ')}`, res.ok ? 'warning' : 'error', 9000);
    } else {
      showToast(`🪪 SFTK_ID__c deployed to ${res.ok} org(s) and assigned to you. Re-open the picker — it is now the recommended key.`, 'success', 7000);
    }
    delete _seedDesc[obj];   // stale: the describe predates the new field
    closeModal();
  });
  eid('dsSeedKeyApply')?.addEventListener('click', async () => {
    const picked = document.querySelector('input[name="dsSeedKeyPick"]:checked');
    if (picked) _seedKeys[obj] = picked.value;
    await sftkSeedKeysSave();
    closeModal();
    sftkSeedRenderRows();
  });
}

// ── Merge safety: seeding WITHOUT deleting ─────────────────────────────
// "Seed targets" leaves the target's data alone: rows that match are
// UPDATED, missing ones inserted. That only holds when the engine has a key
// to match ON. With no key every source row is INSERTED — into a non-empty
// target that means duplicates, silently. So: warn before, and prove it
// after (user 2026-08-21: "if duplication occur we will tell the user the
// list of dupes").
function sftkSeedMatchKeyFor(obj, tgtUrl) {
  const prof = sftkSeedProfileFor(obj, currentSourceOrg(), tgtUrl || '', [..._seedSel]);
  return (prof.tree.upsert && prof.tree.upsert.field)
    || ((prof.tree.matching && prof.tree.matching.fields) || [])[0]
    || null;
}

// Duplicate key values living in a target RIGHT NOW. Pure SOQL aggregate —
// no assumptions, no sampling: this is the target's own answer.
async function sftkSeedFindDupes(sess, obj, keyField) {
  if (!keyField) return { unknown: 'no match key — duplicates cannot be identified' };
  try {
    const r = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid,
      query: `SELECT ${keyField} k, COUNT(Id) c FROM ${obj} GROUP BY ${keyField} HAVING COUNT(Id) > 1 LIMIT 200` });
    if (r?.error) return { unknown: r.error };
    const rows = (r.records || []).map(x => ({ key: x.k, count: x.c })).filter(x => x.key != null);
    return { rows, extra: rows.reduce((n, x) => n + (x.count - 1), 0) };
  } catch (e) { return { unknown: e?.message || String(e) }; }
}

// The pre-flight for a no-wipe seed. Resolves true to proceed.
function sftkSeedDupeGate(risky) {
  if (!risky.length) return Promise.resolve(true);
  return new Promise(resolve => {
    showModal(`
      <div class="ds-modal-header">⚠ These objects would DUPLICATE</div>
      <div class="ds-modal-body" style="font-size:12.5px">
        <div>Seeding without deleting only avoids duplicates when the engine can match existing records. These objects have <strong>no match key</strong>, so every source row is inserted — on top of what the target already holds:</div>
        <div style="margin-top:6px;max-height:180px;overflow:auto">
          ${risky.map(r => `<div style="margin:2px 0"><code>${esc(r.obj)}</code> → ${r.holders.map(h => `${esc(orgLabel(h.url))} <strong>already holds ${Number(h.count).toLocaleString()}</strong>`).join(' · ')}</div>`).join('')}
        </div>
        <div class="ds-pk-note" style="margin-top:8px">Fixes, cheapest first: add an <strong>External ID</strong> field on the object (the engine then upserts instead of inserting) · configure Matching in a saved deployment for it · or use <strong>Reset &amp; Seed</strong> to wipe first. You can also proceed and review the duplicate list this run will produce.</div>
      </div>
      <div class="ds-modal-footer">
        <button class="ds-btn" data-dsaction="closeModal" id="dsSeedDupeCancel">Cancel</button>
        <button class="ds-btn" id="dsSeedDupeGo">Seed anyway — show me the duplicates after</button>
      </div>`);
    eid('dsSeedDupeCancel')?.addEventListener('click', () => resolve(false));
    eid('dsSeedDupeGo')?.addEventListener('click', () => { closeModal(); resolve(true); });
  });
}

// The after-the-fact proof: every duplicate key the run left behind.
function sftkSeedDupeReport(found) {
  const body = found.map(f => `
    <div style="margin:10px 0 3px"><strong>${esc(f.obj)}</strong> in ${esc(orgLabel(f.target))}
      <span class="ds-oc-sub">— matched on <code>${esc(f.key || '—')}</code></span></div>
    ${f.unknown
      ? `<div class="ds-oc-sub">could not be checked: ${esc(f.unknown)}</div>`
      : `<div class="ds-oc-sub">${f.rows.length} duplicated key value(s) · ${f.extra} extra record(s)</div>
         <div style="max-height:150px;overflow:auto;font-family:Consolas,monospace;font-size:11.5px;margin-top:3px">
           ${f.rows.slice(0, 100).map(r => `<div>${esc(String(r.key))} <span class="ds-oc-sub">×${r.count}</span></div>`).join('')}
           ${f.rows.length > 100 ? `<div class="ds-oc-sub">…and ${f.rows.length - 100} more key(s)</div>` : ''}
         </div>`}`).join('');
  showModal(`
    <div class="ds-modal-header">🔎 Duplicates in the target${found.length > 1 ? 's' : ''}</div>
    <div class="ds-modal-body" style="font-size:12.5px;max-height:60vh;overflow:auto">
      <div class="ds-pk-note">These key values appear more than once in the target. Each row shows the value and how many records carry it.</div>
      ${body}
      <div class="ds-pk-note" style="margin-top:10px">To clean them up: open ⚖ Reconcile for the object and target (the ⚖ button on its row), where "In target only" lists the extras record by record and you choose what to delete.</div>
    </div>
    <div class="ds-modal-footer"><button class="ds-btn" data-dsaction="closeModal">Close</button></div>`);
}

// ⚖ — the door from the bulldozer to the scalpel (user 2026-08-20: "we
// need a way for the user to reconcile against one target, to select the
// records he wants to seed"). Builds the same ephemeral pair the ring's ⚖
// uses, scans it, and hands it to Reconcile: from there every bucket is
// per-record. Works for objects with NO saved deployment — the seed's own
// derived config (matching, lookup bridges, masking) carries it.
async function sftkSeedOpenReconcile(obj, tgtUrl) {
  const srcUrl = currentSourceOrg();
  if (!obj || !tgtUrl) return;
  if (_orgKey(tgtUrl) === _orgKey(srcUrl)) {
    showToast('That org IS the source of truth — nothing to reconcile against itself.', 'warning', 5000);
    return;
  }
  const saved = (_profiles || []).find(p => p && !p.ephemeral && p.tree?.objectType === obj);
  const base = sftkSeedProfileFor(obj, srcUrl, tgtUrl, [..._seedSel]);
  const pair = {
    ...base,
    // COMPARING is not the same decision as SEEDING. The 📎 toggle guards
    // the cost of MOVING files on a whole-org run; this is one object
    // against one target, opened deliberately to see what differs \u2014 and a
    // comparison that silently leaves out attachments reports \"in sync\" for
    // records whose files are missing (user 2026-08-22: \"don't see the
    // files in the comparison\"). So the compare always includes them.
    tree: { ...base.tree, includeFiles: true },
    id: `seedpair_${Date.now()}_${obj}`,
    name: `${obj} · ${orgLabel(srcUrl)} → ${orgLabel(tgtUrl)}`,
    // Origin stamp so a post-run writeback credits the REAL deployment when
    // one exists (same contract as the ring's ⚖ clone).
    ...(saved ? { _ringOf: { profileId: saved.id } } : {}),
    lastScan: null, ringScans: undefined, ephemeral: true,
  };
  showToast(`Scanning ${obj} in ${orgLabel(tgtUrl)} — fields and 📎 attached files…`, 'info', 3500);
  const res = await runDiffScan(pair);
  if (res?.error) {
    const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(res.error) : { message: res.error };
    showToast(`Scan failed: ${fe.message}`, 'error', 6500);
    return;
  }
  pair.lastScan = res;
  _reconcileProfile = pair;
  _currentView = 'reconcile';
  document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-view="seed"]')?.classList.add('active');
  renderReconcile();
}

// The fail-safe: contactable fields (email, phone) that NO rule covers.
// Seeding those raw is how a sandbox's automation emails or texts real
// customers — the exact accident masking exists to prevent. Not a hard
// block (plenty of sandboxes have deliverability off), but never silent.
// Resolves true to proceed.
function sftkSeedRawPiiGate(objs) {
  const raw = [];
  let unscanned = 0;
  for (const o of objs) {
    const d = _seedDesc[o];
    if (!d) { unscanned++; continue; }
    const covered = new Set(Object.keys(sftkSeedPiiForObject(o)).map(k => k.toLowerCase()));
    for (const f of (d.fields || [])) {
      if (!f || !f.createable) continue;
      if (f.type !== 'email' && f.type !== 'phone') continue;
      if (covered.has(`${o}.${f.name}`.toLowerCase())) continue;
      raw.push({ obj: o, field: f.name, type: f.type });
    }
  }
  if (!raw.length && !unscanned) return Promise.resolve(true);
  return new Promise(resolve => {
    const emails = raw.filter(r => r.type === 'email');
    const phones = raw.filter(r => r.type === 'phone');
    showModal(`
      <div class="ds-modal-header">⚠ Contactable data will be copied RAW</div>
      <div class="ds-modal-body" style="font-size:12.5px">
        ${raw.length ? `<div>${emails.length ? `<strong>${emails.length} email field(s)</strong>` : ''}${emails.length && phones.length ? ' and ' : ''}${phones.length ? `<strong>${phones.length} phone field(s)</strong>` : ''} are not covered by a masking rule. Automations in the target org can reach real people through them.</div>
        <div style="margin-top:6px;max-height:130px;overflow:auto">${raw.slice(0, 40).map(r => `<code>${esc(r.obj)}.${esc(r.field)}</code>`).join(' · ')}${raw.length > 40 ? ` <span class="ds-oc-sub">…and ${raw.length - 40} more</span>` : ''}</div>` : ''}
        ${unscanned ? `<div class="ds-pk-note" style="margin-top:8px">${unscanned} selected object(s) were never scanned for PII — their fields are <strong>UNKNOWN</strong>, not clean.</div>` : ''}
      </div>
      <div class="ds-modal-footer">
        <button class="ds-btn" data-dsaction="closeModal" id="dsSeedRawCancel">Cancel</button>
        ${raw.length ? `<button class="ds-btn ds-btn-primary" id="dsSeedRawMask">🎭 Mask them, then continue</button>` : ''}
        <button class="ds-btn" id="dsSeedRawGo">Continue with raw values</button>
      </div>`);
    eid('dsSeedRawCancel')?.addEventListener('click', () => resolve(false));
    eid('dsSeedRawGo')?.addEventListener('click', () => { closeModal(); resolve(true); });
    eid('dsSeedRawMask')?.addEventListener('click', async () => {
      for (const r of raw) {
        // A pattern the scan actually detected wins; otherwise email keeps
        // its undeliverable shape and phone falls back to the hash's digits.
        const sugg = ((_seedRows || []).find(x => x.name === r.obj)?.pii || [])
          .find(s => s.field === r.field);
        _seedPii.policy[`${r.obj}.${r.field}`] = sugg && sugg.pattern
          ? { strategy: 'pattern', pattern: sugg.pattern }
          : (r.type === 'email' ? { strategy: 'pattern', pattern: 'email' } : { strategy: 'hash' });
      }
      await sftkSeedPiiSave();
      closeModal();
      sftkSeedRenderRows();
      showToast(`🎭 ${raw.length} contactable field(s) will be masked.`, 'success', 5000);
      resolve(true);
    });
  });
}

// ── Confirmation — typed, with the exact counts on the table ───────────
async function sftkSeedConfirmAndRun(what) {
  if (_seedBusy) return;
  const objs = [..._seedSel];
  const targets = [..._seedTargets];
  // A configuration-only run carries no data objects and needs no record
  // counts — its guards are the target checks and the prod confirmation.
  const cfgOnly = !!what.config && !what.seed && !what.wipe;
  if (cfgOnly && !_seedCfgSel.size) { showToast('Tick at least one configuration item', 'warning'); return; }
  if (!cfgOnly && !objs.length) { showToast('Select at least one object', 'warning'); return; }
  if (!targets.length) { showToast('Tick at least one target org', 'warning'); return; }
  if (targets.some(t => _orgKey(t) === _orgKey(currentSourceOrg()))) {
    showToast('The source of truth can never be a target.', 'error', 6000); return;
  }
  // A target ticked AFTER "Load objects & counts" has no counts at all —
  // it must never reach the confirm dialog as "~0 record(s)".
  const unloaded = cfgOnly ? [] : targets.filter(t => !_seedLoadedTargets.has(t));
  if (unloaded.length) {
    showToast(`Counts were never loaded for ${unloaded.map(orgLabel).join(', ')} — click 🔍 Load objects & counts again first.`, 'error', 7000);
    return;
  }
  // Production gates — same laws as Reconcile and the fan-out: hard delete
  // is flatly refused against prod; every OTHER prod write demands the
  // typed-org-name confirmation (the promise the PROD badge itself makes).
  const orgTypes = {};
  for (const t of targets) orgTypes[t] = await ensureOrgType(t);
  const prodTargets = targets.filter(t => orgTypes[t] === 'production');
  if (what.wipe && _seedDelMode === 'hard' && prodTargets.length) {
    showToast('🔥 Hard delete is disabled against PRODUCTION orgs — switch Delete mode to Recycle Bin.', 'error', 7000);
    return;
  }
  // The one confirmation (sftk-confirm.js, campaign 3 phase 2): one combined
  // production typed-name step naming every production target, replacing the
  // confirmTypedProd() loop. sftkOrgWriteGate supplies only the display label —
  // which targets are guarded is still decided by ensureOrgType above.
  const prodLabelFor = async () => {
    if (!prodTargets.length) return '';
    const gates = await Promise.all(prodTargets.map(t => sftkOrgWriteGate(t, _orgs)));
    return prodTargets.map((t, i) => gates[i].label || orgLabel(t)).join(', ');
  };
  if (!what.wipe) {
    if (what.seed && !(await sftkSeedRawPiiGate(objs))) return;
    // Replacing a Custom Setting DELETES the target's rows. That is the
    // honest semantic for configuration, but it is still a delete and the
    // user has to know before it happens, not after.
    if (what.config && !(await sftkSeedCfgReplaceGate())) return;
    if (prodTargets.length) {
      const summary = cfgOnly ? `deploy ${_seedCfgSel.size} configuration item(s)` : `seed ${objs.length} object(s)`;
      const ok = await sftkConfirmDestructive({
        title: '🛑 Confirm writes into production',
        icon: '🛑',
        items: [{ label: summary }],
        revOverride: { html: '⚠ This writes into org(s) treated as PRODUCTION — their type could not be confirmed as sandbox or dev.', needsCheckbox: false },
        confirmLabel: 'Proceed',
        production: { label: await prodLabelFor() },
      });
      if (!ok) return;
    }
    sftkSeedRun(what, objs, targets);
    return;
  }
  const rowsByName = Object.fromEntries((_seedRows || []).map(r => [r.name, r]));
  const lines = targets.map(t => {
    // Unknown counts stay UNKNOWN — coercing them to 0 on the single most
    // destructive dialog in the product was the review's other HIGH.
    let total = 0, unknown = 0;
    for (const o of objs) {
      const v = rowsByName[o]?.tgtCounts?.[t];
      if (v == null) unknown++; else total += v;
    }
    return `<div style="margin:2px 0"><strong>${esc(orgLabel(t))}</strong> ${prodBadge(t)}: ~${total.toLocaleString()} record(s) across ${objs.length - unknown} object(s)${unknown ? ` <strong>+ ${unknown} object(s) with UNKNOWN count — ALL of their rows will be deleted</strong>` : ''}${_seedDelMode === 'hard' ? ' — <strong>permanently</strong>' : ' → Recycle Bin'}</div>`;
  }).join('');
  const bodyHtml = `
    <div>You are about to delete the selected objects' rows in:</div>
    ${lines}
    <div class="ds-pk-note" style="margin-top:6px">Counts are the loaded totals per object. Master-detail children of deleted records cascade-delete too. ${what.seed ? 'Seeding runs right after each wipe.' : ''}</div>
    ${(() => {
      const masked = objs.reduce((n, o) => n + Object.keys(sftkSeedPiiForObject(o)).length, 0);
      return masked ? `<div class="ds-pk-note" style="margin-top:4px">🎭 ${masked} field(s) will be pseudonymized on the way in — masked, never anonymized.</div>` : '';
    })()}`;
  // The acknowledgement and the production typed-name step live in the SAME
  // shared dialog (sftk-confirm.js).
  const ok = await sftkConfirmDestructive({
    title: `🧹 ${what.seed ? 'Reset & Seed' : 'Wipe targets'} — this DELETES data`,
    icon: '🧹',
    revOverride: _seedDelMode === 'hard'
      ? { html: '🔥 <strong>Permanent</strong> — hard-deleted records are purged from the Recycle Bin and cannot be recovered.', needsCheckbox: true }
      : { html: '♻ <strong>Recoverable</strong> — deleted records go to the Recycle Bin and can be restored for 15 days.', needsCheckbox: true, ack: 'I understand and want to proceed' },
    confirmLabel: `🧹 ${what.seed ? 'Reset & Seed' : 'Wipe'} ${targets.length} org(s)`,
    extraHtml: bodyHtml,
    production: prodTargets.length ? { label: await prodLabelFor() } : null,
  });
  if (!ok) return;
  if (what.seed && !(await sftkSeedRawPiiGate(objs))) return;
  sftkSeedRun(what, objs, targets);
}

// ── The run: per target, wipe (children-first) then seed (parents-first) ─
async function sftkSeedRun(what, objs, targets) {
  if (_seedBusy) return;
  _seedBusy = true;
  _seedCancelled = false;
  const srcUrl = currentSourceOrg();
  const logHost = eid('dsSeedLog');
  const panel = document.createElement('div');
  panel.className = 'ds-fanout-panel';
  panel.innerHTML = `<div class="ds-pk-res-title" style="display:flex;align-items:center;gap:10px">🌱 ${what.wipe && what.seed ? 'Reset & Seed' : what.wipe ? 'Wipe' : 'Seed'}: ${objs.length} object(s) → ${targets.length} target(s)
      <button class="ds-btn ds-btn-xs" id="dsSeedCancel" style="margin-left:auto" title="Stops between chunks/objects — work already done stays done; the log reports honest partial counts.">✋ Cancel</button>
    </div>
    <div style="display:flex;align-items:center;gap:10px;padding:4px 10px 8px">
      <div style="flex:1;height:8px;border-radius:4px;background:var(--c-surface-sunk, #23262d);overflow:hidden">
        <div id="dsSeedBarFill" style="width:0%;height:100%;background:var(--c-brand, #3b82f6);transition:width .2s"></div>
      </div>
      <span class="ds-oc-sub" id="dsSeedBarText" style="min-width:230px;text-align:right">starting…</span>
    </div>
    <div class="ds-seed-runlog"></div>`;
  logHost?.prepend(panel);
  panel.querySelector('#dsSeedCancel')?.addEventListener('click', () => {
    _seedCancelled = true;
    try { _seedPort?.postMessage({ cmd: 'cancel' }); } catch (_) {}
    const b = panel.querySelector('#dsSeedCancel');
    if (b) { b.disabled = true; b.textContent = '✋ cancelling…'; }
  });
  const runlog = panel.querySelector('.ds-seed-runlog');
  const line = (icon, msg) => {
    const el = document.createElement('div');
    el.className = 'ds-pk-res-row';
    el.innerHTML = `<span>${icon}</span><span>${esc(msg)}</span>`;
    runlog.appendChild(el);
  };
  try {
    const srcSess = await getOrgSession(srcUrl);
    if (!srcSess?.sid) throw new Error(`${orgLabel(srcUrl)} is not open in a Chrome tab`);
    // Source describes → reference graph + external-id config, once.
    for (const o of objs) {
      if (!_seedDesc[o]) {
        const d = await sendBg({ type: 'SF_REST_GET', orgUrl: srcSess.orgUrl, sid: srcSess.sid,
          path: `/services/data/v62.0/sobjects/${o}/describe` });
        if (d?.error) throw new Error(`describe ${o}: ${d.error}`);
        _seedDesc[o] = d;
      }
    }
    const refs = {};
    for (const o of objs) {
      refs[o] = [...new Set((_seedDesc[o].fields || [])
        .filter(f => f.type === 'reference' && f.createable && !/^(OwnerId|CreatedById|LastModifiedById|RecordTypeId)$/.test(f.name))
        .flatMap(f => f.referenceTo || []))];
    }
    const { order, cycle } = sftkSeedOrder(objs, refs);

    // Overall progress — a run this long must never be a wall of log lines
    // with no sense of how far in it is (user 2026-08-20).
    const perObject = (what.wipe ? 1 : 0) + (what.seed ? 1 : 0);
    const totalSteps = Math.max(1, targets.length * order.length * perObject);
    let step = 0;
    const bar = (label) => {
      const fill = panel.querySelector('#dsSeedBarFill');
      const txt = panel.querySelector('#dsSeedBarText');
      const pct = Math.min(100, Math.round((step / totalSteps) * 100));
      if (fill) fill.style.width = `${pct}%`;
      if (txt) txt.textContent = `${pct}% · ${label}`;
    };
    // An object that simply doesn't exist in a target is a SKIP, not an
    // error — Salesforce answers with a raw HTTP 400 that reads like a bug.
    const notPresent = e => /is not supported|INVALID_TYPE|no such column|does not exist/i.test(String(e || ''));

    // Seeding WITHOUT deleting: warn before writing when an object has no
    // match key and the target already holds rows — that combination is
    // what produces duplicates.
    if (what.seed && !what.wipe) {
      const risky = [];
      for (const o of order) {
        if (sftkSeedMatchKeyFor(o, targets[0])) continue;
        const row = (_seedRows || []).find(r => r.name === o);
        const holders = targets
          .map(t => ({ url: t, count: (row && row.tgtCounts && row.tgtCounts[t]) || 0 }))
          .filter(h => h.count > 0);
        if (holders.length) risky.push({ obj: o, holders });
      }
      if (risky.length && !(await sftkSeedDupeGate(risky))) {
        line('✋', 'cancelled before anything was written');
        return;
      }
    }
    const dupeFindings = [];
    if (cycle.length) line('⚠', `Reference cycle between ${cycle.join(', ')} — seeding them in listed order; some lookups may need a second Seed pass to connect.`);

    for (const t of targets) {
      if (_seedCancelled) { line('✋', `${orgLabel(t)}: skipped — run cancelled`); continue; }
      const tgtSess = await getOrgSession(t);
      if (!tgtSess?.sid) { line('⏭', `${orgLabel(t)}: skipped — org not open in a tab`); continue; }
      line('🎯', `${orgLabel(t)} — starting`);
      const liveEl = document.createElement('div');
      liveEl.className = 'ds-prog-log';
      liveEl.style.cssText = 'max-height:220px;overflow-y:auto;margin:2px 0 8px 18px;font-size:12px';
      runlog.appendChild(liveEl);
      _seedPort = (typeof _openRunPort === 'function') ? _openRunPort(sftkRunProgressHandler(liveEl)) : null;
      try {
        // Configuration BEFORE data, always: validation rules, flows and
        // Apex read Custom Settings, Custom Metadata and Labels, so rows
        // that arrive first are judged by the target's OLD configuration.
        if (what.config && _seedCfgSel.size && !_seedCancelled) {
          bar(`${orgLabel(t)} · configuration`);
          await sftkSeedCfgRunOne(srcSess, tgtSess, (icon, msg) => line(
            icon === 'OK' ? '✅' : icon === 'X' ? '❌' : icon === '!' ? '⚠' : icon === 'R' ? '📖' : 'ℹ',
            `${orgLabel(t)} · ${msg}`));
        }
        if (what.wipe) {
          for (const o of [...order].reverse()) {
            if (_seedCancelled) { line('✋', `${orgLabel(t)} · wipe ${o}: skipped — cancelled`); step++; bar('cancelled'); continue; }
            bar(`${orgLabel(t)} · wiping ${o}`);
            const res = await sendBg({ type: 'SFTK_WIPE_OBJECT',
              orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, objType: o, mode: _seedDelMode });
            step++;
            if (res?.error) {
              line(notPresent(res.error) ? '⏭' : '❌', notPresent(res.error)
                ? `${orgLabel(t)} · ${o}: not present in this org — nothing to wipe`
                : `${orgLabel(t)} · wipe ${o}: ${res.error}`);
              bar(`${orgLabel(t)} · ${o}`);
              continue;
            }
            line(res.failed ? '⚠' : '🧹', `${orgLabel(t)} · ${o}: ${res.deleted} deleted${res.failed ? `, ${res.failed} failed` : ''}${_seedDelMode === 'hard' ? ' (hard)' : ''}`);
            bar(`${orgLabel(t)} · ${o} wiped`);
          }
        }
        if (what.seed) {
          const seedOne = async (o, label, opts) => {
            const prof = sftkSeedProfileFor(o, srcUrl, t, objs, opts);
            // verified-by: the recount loop below ("Verification: recount
            // every object") re-reads COUNT() per object after every seedOne()
            // in this pass and reports source vs. target.
            const result = await sendBg({ type: 'SF_EXECUTE_PROFILE_TRANSFER', profile: prof,
              srcOrgUrl: srcSess.orgUrl, srcSid: srcSess.sid,
              tgtOrgUrl: tgtSess.orgUrl, tgtSid: tgtSess.sid });
            if (result?.error) { line('❌', `${orgLabel(t)} · ${label}: ${result.error}`); return null; }
            const s = result.summary?.[o] || {};
            delete (result.summary?.[o] || {}).idPairs;
            _history.push({ id: genId('run'), profileId: prof.id,
              srcOrgUrl: srcSess.orgUrl, tgtOrgUrl: tgtSess.orgUrl,
              sourceOrg: srcSess.orgUrl, targetOrg: tgtSess.orgUrl,
              startedAt: new Date().toISOString(), ...result,
              profileName: `Seed ${o}` });
            const arm = (s.upsertCreated != null || s.upsertUpdated != null)
              ? ` (${s.upsertCreated || 0} created · ${s.upsertUpdated || 0} updated)` : '';
            // A leg whose node DIED wholesale has 0 per-record failures —
            // status is the truth (same lie the reconcile card once told).
            const dead = result.status && result.status !== 'success';
            line((s.failed || dead) ? (dead && !(s.created || 0) ? '❌' : '⚠') : '✅',
              `${orgLabel(t)} · ${label}: ${s.created || 0} written${arm}${s.failed ? `, ${s.failed} failed` : ''}${dead ? ` — run ${result.status}, see History` : ''}`);
            return prof;
          };
          for (const o of order) {
            if (_seedCancelled) { line('✋', `${orgLabel(t)} · seed ${o}: skipped — cancelled`); step++; bar('cancelled'); continue; }
            bar(`${orgLabel(t)} · seeding ${o}`);
            // Bridges matched by Name are a guess, not an identity — say so
            // BEFORE the write (review: silent mis-linking on dup names).
            const probe = sftkSeedProfileFor(o, srcUrl, t, objs);
            const nameBridges = Object.entries(probe.tree.lookupResolutions || {})
              .filter(([, r]) => r && r.matchField === 'Name').map(([f]) => f);
            if (nameBridges.length) {
              line('⚠', `${o}: bridging ${nameBridges.join(', ')} by Name — duplicate names can mis-link; an External ID on the referenced object makes this exact.`);
            }
            const prof = await seedOne(o, `seed ${o}`);
            step++;
            bar(`${orgLabel(t)} · ${o} seeded`);
            // SELF-referencing lookups (hierarchies) can't resolve while
            // their targets are still being inserted. With upsert matching
            // a second idempotent pass connects them; without it, a rerun
            // would duplicate — disclose instead.
            const selfBridge = prof && Object.values(prof.tree.lookupResolutions || {}).some(r => r && r.matchObject === o);
            if (selfBridge && !_seedCancelled) {
              if (prof.tree.upsert?.field) {
                line('🔁', `${o}: self-referencing lookup detected — running the reconnect pass (idempotent upsert).`);
                await seedOne(o, `reconnect ${o}`);
              } else {
                line('⚠', `${o}: self-referencing lookup could NOT fully connect — without an External ID a second pass would duplicate rows. Add an External ID and re-seed to wire the hierarchy.`);
              }
            }
            // 🗄 Archived rows are invisible to the query that just ran —
            // Salesforce excludes them unless IsArchived is filtered ON.
            // A second explicit pass is the only way to carry them.
            if (_seedArchived && sftkSeedIsArchivable(o) && !_seedCancelled) {
              line('🗄', `${o}: archived rows are hidden from normal SOQL — running the archived pass.`);
              await seedOne(o, `archived ${o}`, { where: 'IsArchived = true', idSuffix: '_arch' });
            }
          }
          // Verification: recount every object — the "compare" that closes the loop.
          for (const o of order) {
            const r = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
              query: `SELECT COUNT() FROM ${o}` });
            const tc = (r && !r.error && Number.isFinite(r.totalSize)) ? r.totalSize : null;
            const sc = (_seedRows || []).find(x => x.name === o)?.srcCount;
            line(tc != null && sc != null && tc === sc ? '✔' : 'ℹ',
              `${orgLabel(t)} · ${o}: source ${sc ?? '?'} → target ${tc ?? '?'}${tc != null && sc != null && tc !== sc ? ' — counts differ; 🔍 scan the pair for the row-level truth' : ''}`);
          }
        }
        // VERIFY, then refresh the table. Counts loaded before a run are
        // stale the moment it starts — leaving them on screen is what made a
        // finished wipe look like it did nothing (user 2026-08-20). One
        // recount per object closes the loop and doubles as the honest
        // answer to "did everything actually go?".
        bar(`${orgLabel(t)} · verifying`);
        const leftovers = [];
        for (const o of order) {
          const r = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
            query: `SELECT COUNT() FROM ${o}` });
          const now = (r && !r.error && Number.isFinite(r.totalSize)) ? r.totalSize : null;
          const row = (_seedRows || []).find(x => x.name === o);
          if (row) {
            row.tgtCounts[t] = now;
            const cell = document.querySelector(`[data-seed-cell="${CSS.escape(o + '|' + _orgKey(t))}"]`);
            if (cell) cell.textContent = now == null ? '?' : Number(now).toLocaleString();
          }
          if (what.wipe && !what.seed && now) leftovers.push(`${o} (${now})`);
          // Did this seed leave duplicates behind? Ask the TARGET, not our
          // own bookkeeping — an aggregate over the match key is the only
          // answer that can't be wrong.
          if (what.seed && now) {
            const key = sftkSeedMatchKeyFor(o, t);
            const d = await sftkSeedFindDupes(tgtSess, o, key);
            if (d && ((d.rows && d.rows.length) || d.unknown)) {
              dupeFindings.push({ obj: o, target: t, key, ...d });
            }
          }
        }
        if (leftovers.length) {
          line('ℹ', `${orgLabel(t)}: ${leftovers.length} object(s) still hold rows Salesforce refused to delete — ${leftovers.slice(0, 6).join(', ')}${leftovers.length > 6 ? '…' : ''}. Standard records (the standard Pricebook), records linked to portal users, and rows locked by approvals cannot be deleted by any tool.`);
        }
        line('🏁', `${orgLabel(t)} — ${_seedCancelled ? 'stopped by cancel' : 'done'}`);
      } finally {
        try { _seedPort?.disconnect(); } catch (_) {}
        _seedPort = null;
      }
    }
    // The duplicate verdict — stated even when it is "none", because
    // "did this duplicate anything?" is the question a no-wipe seed always
    // raises and silence is not an answer.
    if (what.seed) {
      const real = dupeFindings.filter(f => f.rows && f.rows.length);
      const unknown = dupeFindings.filter(f => f.unknown);
      if (real.length) {
        const extra = real.reduce((n, f) => n + (f.extra || 0), 0);
        line('⚠', `${extra} duplicate record(s) across ${real.length} object/target pair(s) — see the list.`);
        const btn = document.createElement('button');
        btn.className = 'ds-btn ds-btn-xs';
        btn.textContent = `🔎 View ${extra} duplicate(s)`;
        btn.addEventListener('click', () => sftkSeedDupeReport(dupeFindings));
        runlog.appendChild(btn);
      } else if (unknown.length) {
        line('ℹ', `Duplicate check could not run for ${unknown.length} object(s) — ${esc(unknown[0].unknown)}. Their duplicate state is UNKNOWN, not clean.`);
      } else {
        line('✔', 'No duplicate key values in any target — every seeded record matched or was new.');
      }
    }
    { const fill = panel.querySelector('#dsSeedBarFill'); const txt = panel.querySelector('#dsSeedBarText');
      if (fill) fill.style.width = '100%';
      if (txt) txt.textContent = _seedCancelled ? 'stopped — partial work kept' : 'done · counts above refreshed'; }
    await storageSaveHistory();
    showToast('Org Seeder finished — counts are in the log; run 🔍 scans for row-level verification.', 'success', 6000);
  } catch (e) {
    line('❌', `stopped: ${e?.message || e}`);
    showToast(`Seeder stopped: ${e?.message || e}`, 'error', 6500);
  } finally {
    _seedBusy = false;
  }
}

// One flat engine profile per object. Saved deployment config for the same
// root object is INHERITED (matching, mappings, upsert, PII policy+salt);
// otherwise a single external-id field auto-configures upsert matching, and
// lookups pointing at other SELECTED objects are bridged by match keys so
// relationships survive without cross-run id maps.
function sftkSeedProfileFor(obj, srcUrl, tgtUrl, selected, opts) {
  const saved = (_profiles || []).find(p => p && !p.ephemeral && p.tree?.objectType === obj);
  const desc = _seedDesc[obj] || { fields: [] };
  const extIds = (desc.fields || []).filter(f => f.externalId && f.createable);
  // Precedence, highest first: the user's pick in the Match key picker
  // (including '__none__', which deliberately forces insert-only) → a saved
  // deployment's configured key → the object's sole External ID. Whatever
  // wins here is exactly what sftkSeedKeyInfo() shows in the table, so the
  // column can never disagree with the run.
  const ov = _seedKeys[obj];
  const overridden = ov != null;
  // 🪪 The identity field, when deployed, is the most exact key there is
  // (the source record's own Id) — it wins every guess, loses only to an
  // explicit pick in the Match key picker.
  const hasStamp = extIds.some(f => f.name === sftkIdFieldName());
  const auto = overridden
    ? (ov !== '__none__' && extIds.some(f => f.name === ov) ? ov : null)
    : hasStamp ? sftkIdFieldName()
    : (saved?.tree?.upsert?.field || (extIds.length === 1 ? extIds[0].name : null));
  const selSet = new Set(selected);
  const matchFieldOf = ref => {
    const savedRef = (_profiles || []).find(p => p && !p.ephemeral && p.tree?.objectType === ref);
    if (savedRef?.tree?.upsert?.field) return savedRef.tree.upsert.field;
    const rd = _seedDesc[ref];
    const re = (rd?.fields || []).filter(f => f.externalId && f.createable);
    return re.length === 1 ? re[0].name : 'Name';
  };
  const lookupResolutions = { ...(saved?.tree?.lookupResolutions || {}) };
  for (const f of (desc.fields || [])) {
    if (f.type !== 'reference' || !f.createable) continue;
    if (/^(OwnerId|CreatedById|LastModifiedById|RecordTypeId)$/.test(f.name)) continue;
    const ref = (f.referenceTo || []).find(r => selSet.has(r));
    if (ref && !lookupResolutions[f.name]) {
      lookupResolutions[f.name] = { strategy: 'match', matchObject: ref, matchField: matchFieldOf(ref) };
    }
  }
  return {
    id: `seed_${obj}_${_orgKey(tgtUrl)}${(opts && opts.idSuffix) || ''}`, name: `Seed ${obj}`, ephemeral: true,
    sourceOrg: srcUrl, targetOrg: tgtUrl,
    ...(saved?.apiMode ? { apiMode: saved.apiMode } : {}),
    ...(saved?.batchSize ? { batchSize: saved.batchSize } : {}),
    ...(saved?.threads ? { threads: saved.threads } : {}),
    // Masking: the seed's own policy for this object merged over anything
    // the saved deployment already carried, under ONE salt for the whole
    // seed so masked values stay joinable across objects.
    ...(() => {
      const merged = { ...(saved?.piiPolicy || {}), ...sftkSeedPiiForObject(obj) };
      if (!Object.keys(merged).length) return {};
      return { piiPolicy: merged, piiSalt: _seedPii.salt || saved?.piiSalt };
    })(),
    tree: {
      objectType: obj, where: (opts && opts.where) || '', children: [],
      // Attachments ride the engine's own files pass. It fails CLOSED when
      // a masking policy is active — file bodies cannot be masked — and
      // says so in the run log rather than shipping raw bytes.
      ...(_seedFiles ? { includeFiles: true } : {}),
      fieldMappings: saved?.tree?.fieldMappings || {},
      ...((!overridden && saved?.tree?.matching) ? { matching: saved.tree.matching }
        : auto ? { matching: { strategy: 'externalId', fields: [auto], normalize: {} } } : {}),
      ...(auto ? { upsert: { field: auto } } : {}),
      lookupResolutions,
      // Stamp every written record with its source Id whenever the target
      // carries the identity field — even when matching rides another key
      // this run, the NEXT run can then match exactly.
      ...(auto === sftkIdFieldName() || extIds.some(f => f.name === sftkIdFieldName())
        ? { stampField: sftkIdFieldName() } : {}),
    },
  };
}

// Custom Settings are REPLACED, and replacement starts with a delete. The
// user is told which settings, and how many rows each target loses, before
// a single row goes. Metadata (CMDT, labels) needs no gate — deploying is
// upsert by name and destroys nothing.
function sftkSeedCfgReplaceGate() {
  const settings = [..._seedCfgSel].filter(n => n !== '__labels__' && !/__mdt$/i.test(n));
  if (!settings.length) return Promise.resolve(true);
  const targets = [..._seedTargets];
  const rows = (_seedCfgRows || []).filter(r => settings.includes(r.name));
  // The one confirmation (sftk-confirm.js, campaign 3 phase 2) — same wording,
  // moved into the shared shape.
  const bodyHtml = `
    <div>A Custom Setting is configuration, so it is copied whole: each target's existing rows are <strong>deleted</strong>, then the source's rows are written. What the target ends up with is exactly what the source has — nothing merges.</div>
    <div style="margin-top:8px;max-height:200px;overflow:auto">
      ${rows.map(r => `<div style="margin:2px 0"><code>${esc(r.name)}</code> — ${targets.map(t => {
        const c = r.tgtCounts[t];
        return `${esc(orgLabel(t))} loses ${c == null ? '<strong>an unknown number of</strong>' : `<strong>${Number(c).toLocaleString()}</strong>`} row(s)`;
      }).join(' &middot; ')}</div>`).join('') || '<div class="ds-oc-sub">Counts were not loaded — the row totals are UNKNOWN.</div>'}
    </div>`;
  return sftkConfirmDestructive({
    title: 'Custom Settings will be REPLACED',
    icon: '⚠',
    revOverride: { html: 'Custom Setting rows do not go to the Recycle Bin the way records do — treat this as permanent. Untick a setting above if you only meant to deploy metadata.', needsCheckbox: true },
    confirmLabel: 'Replace them',
    extraHtml: bodyHtml,
  });
}

// ── Configuration: Custom Metadata & Custom Settings ───────────────────
// Seeded data does not behave the same in an org whose CONFIGURATION is
// different: validation rules read Custom Settings, flows and Apex read
// Custom Metadata. Copying rows into a target that lacks them produces
// records that look right and behave wrong (user 2026-08-22: "they may be
// essential for seeding operation"). So configuration is its own pass,
// and it runs BEFORE data.
//
// The two are NOT the same mechanism, and the difference is not cosmetic:
//   · Custom Metadata (__mdt) is metadata. The REST sObject API refuses to
//     create it; it travels as a deployed package, like a Flow.
//   · Custom Settings ARE rows — but a hierarchy setting's SetupOwnerId
//     points at an Organization, Profile or User whose Id differs in every
//     org, so it has to be re-resolved by NAME, not carried.
let _seedCfgRows = null;      // [{ name, kind, label, srcCount, tgtCounts }]
let _seedCfgSel  = new Set();
let _seedCfgBusy = false;

function sftkSeedCfgKind(sobj) {
  if (/__mdt$/i.test(sobj.name)) return 'mdt';
  // customSetting + a SetupOwnerId field ⇒ hierarchy; otherwise list. The
  // global describe doesn't carry fields, so the flavour is refined later
  // from the object describe; 'setting' is the honest interim answer.
  return 'setting';
}

// Refine 'setting' into list vs hierarchy once the describe is in hand.
function sftkSeedSettingFlavour(describe) {
  return ((describe && describe.fields) || []).some(f => f && f.name === 'SetupOwnerId')
    ? 'hierarchy' : 'list';
}

// Fields of a custom setting that actually carry configuration. Name is
// kept for list settings (it IS the key); SetupOwnerId is handled by the
// resolver, never copied raw.
function sftkSeedSettingFields(describe) {
  return ((describe && describe.fields) || [])
    .filter(f => f && f.createable && f.name !== 'SetupOwnerId'
      && !/^(Id|OwnerId|CreatedById|LastModifiedById|IsDeleted)$/.test(f.name))
    .map(f => f.name);
}

// Map a source SetupOwnerId onto the target. Organization rows are the
// org-default and always map; Profile rows map by profile NAME; User rows
// map by USERNAME, which rarely survives an org copy — those are reported,
// never guessed at.
// srcOwners: { srcId: {type, name} } · tgt: { orgId, profilesByName, usersByName }
function sftkSeedResolveOwner(srcOwnerId, srcOwners, tgt) {
  if (!srcOwnerId) return { id: null, why: 'no SetupOwnerId' };
  const meta = (srcOwners || {})[srcOwnerId];
  if (!meta) return { id: null, why: 'owner not readable in the source' };
  if (meta.type === 'Organization') return { id: tgt.orgId, why: null };
  if (meta.type === 'Profile') {
    const hit = (tgt.profilesByName || {})[meta.name];
    return hit ? { id: hit, why: null } : { id: null, why: `no profile named “${meta.name}” in the target` };
  }
  if (meta.type === 'User') {
    const hit = (tgt.usersByName || {})[meta.name];
    return hit ? { id: hit, why: null } : { id: null, why: `no user “${meta.name}” in the target` };
  }
  return { id: null, why: `owner type ${meta.type} cannot be matched across orgs` };
}

// Load the configuration objects and their live counts. Same No-Silent-
// Waits contract as the data sweep: quote the cost, fill the table as
// answers land, stop on demand.
async function sftkSeedCfgLoad() {
  if (_seedCfgBusy) { _seedCancelled = true; return; }
  const srcUrl = currentSourceOrg();
  const targets = [..._seedTargets];
  if (!srcUrl) { showToast('Set a source of truth in the topbar first', 'error', 5000); return; }
  const srcSess = await getOrgSession(srcUrl);
  if (!srcSess?.sid) { showToast(`${orgLabel(srcUrl)} is not open in a Chrome tab`, 'error', 6000); return; }
  const gd = await sendBg({ type: 'SF_REST_GET', orgUrl: srcSess.orgUrl, sid: srcSess.sid,
    path: '/services/data/v62.0/sobjects' });
  if (gd?.error) { showToast(`Could not list objects: ${gd.error}`, 'error', 7000); return; }

  const list = (gd.sobjects || []).filter(so =>
    so.queryable && !so.deprecatedAndHidden
    && (/__mdt$/i.test(so.name) || so.customSetting === true))
    .map(so => ({ name: so.name, kind: sftkSeedCfgKind(so), label: so.label || so.name }))
    .sort((a, b) => (a.kind === b.kind) ? a.name.localeCompare(b.name) : (a.kind === 'mdt' ? -1 : 1));
  if (!list.length) {
    _seedCfgRows = [];
    sftkSeedCfgRender();
    showToast('This org has no Custom Metadata types and no Custom Settings. Custom Labels can still be deployed.', 'info', 6000);
    return;
  }

  const planned = list.length * (1 + targets.length);
  if (planned > 150) {
    const go = await new Promise(res => {
      showModal(`
        <div class="ds-modal-header">This will make ${planned} API calls</div>
        <div class="ds-modal-body" style="font-size:12.5px">
          <div>${list.length} configuration object(s) \u00d7 ${1 + targets.length} org(s) \u2014 roughly ${Math.max(1, Math.round(planned / 12))}s. Nothing is written; these are counts only.</div>
        </div>
        <div class="ds-modal-footer">
          <button class="ds-btn" data-dsaction="closeModal" id="dsCfgQuoteNo">Cancel</button>
          <button class="ds-btn ds-btn-primary" id="dsCfgQuoteYes">Count them</button>
        </div>`);
      eid('dsCfgQuoteNo')?.addEventListener('click', () => res(false));
      eid('dsCfgQuoteYes')?.addEventListener('click', () => { closeModal(); res(true); });
    });
    if (!go) return;
  }

  _seedCfgBusy = true; _seedCancelled = false;
  // The Stop affordance has to appear the MOMENT the sweep starts, not on
  // the next full re-render \u2014 the whole point of No Silent Waits is that
  // the user can get out of a long scan (user 2026-08-21).
  const cfgBtn = eid('dsSeedCfgLoad');
  if (cfgBtn) cfgBtn.textContent = '⏹ Stop';
  _seedCfgRows = list.map(r => ({ ...r, srcCount: undefined, tgtCounts: {} }));
  sftkSeedCfgRender();
  const tgtSess = {};
  try {
    for (const t of targets) {
      tgtSess[t] = await getOrgSession(t);
      if (!tgtSess[t]?.sid) { showToast(`${orgLabel(t)} is not open in a Chrome tab`, 'error', 6000); return; }
    }
    const paint = (obj, key, val) => {
      const cell = document.querySelector(`[data-cfg-cell="${CSS.escape(obj + '|' + key)}"]`);
      if (cell) cell.textContent = val == null ? '?' : Number(val).toLocaleString();
    };
    const count = async (sess, obj) => {
      const r = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid,
        query: `SELECT COUNT() FROM ${obj}` });
      return (r && !r.error && Number.isFinite(r.totalSize)) ? r.totalSize : null;
    };
    for (const row of _seedCfgRows) {
      if (_seedCancelled) break;
      row.srcCount = await count(srcSess, row.name);
      paint(row.name, 'src', row.srcCount);
      for (const t of targets) {
        if (_seedCancelled) break;
        row.tgtCounts[t] = await count(tgtSess[t], row.name);
        paint(row.name, _orgKey(t), row.tgtCounts[t]);
      }
    }
  } finally {
    _seedCfgBusy = false;
    const b = eid('dsSeedCfgLoad');
    if (b) b.textContent = '🔍 Load configuration';
    sftkSeedCfgRender();
  }
}

// Deploy every selected Custom Metadata type's records into one target as
// ONE package. A metadata deploy is upsert-by-fullName, so a re-run
// updates instead of duplicating and no wipe is ever needed.
async function sftkSeedCfgDeployMdt(srcSess, tgtSess, types, line) {
  const files = [], members = [];
  const devNamesByType = {};
  for (const t of types) {
    if (_seedCancelled) return { cancelled: true };
    let desc = _seedDesc[t];
    if (!desc) {
      const d = await sendBg({ type: 'SF_REST_GET', orgUrl: srcSess.orgUrl, sid: srcSess.sid,
        path: `/services/data/v62.0/sobjects/${t}/describe` });
      if (d?.error) { line('X', `${t}: describe failed - ${d.error}`); continue; }
      desc = _seedDesc[t] = d;
    }
    const plan = sftkCmdtFieldPlan(desc);
    if (plan.unsupported.length) {
      line('i', `${t}: ${plan.unsupported.length} field(s) not carried - ${plan.unsupported.slice(0, 3).map(u => `${u.name} (${u.why})`).join('; ')}${plan.unsupported.length > 3 ? '...' : ''}`);
    }
    const q = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: srcSess.orgUrl, sid: srcSess.sid,
      query: sftkCmdtSoql(t, plan) });
    if (q?.error) { line('X', `${t}: read failed - ${q.error}`); continue; }
    if (q?.incomplete) { line('X', `${t}: read INCOMPLETE (Salesforce says ${q.incomplete.expected}, got ${q.incomplete.got}) - skipped, not deployed from a partial read.`); continue; }
    const built = sftkCmdtBuildFiles(t, q.records || [], plan);
    files.push(...built.files); members.push(...built.members);
    devNamesByType[t] = (q.records || []).map(r => r.DeveloperName).filter(Boolean);
    line('R', `${t}: ${built.members.length} record(s) read.`);
  }
  if (!members.length) return { deployed: 0, note: 'nothing to deploy' };
  const enc = new TextEncoder();
  const zipFiles = [
    { name: 'package.xml', data: enc.encode(sftkCmdtPackageXml(members, '62.0')) },
    ...files.map(f => ({ name: f.name, data: enc.encode(f.text) })),
  ];
  const zipBase64 = window.sftkBuildStoredZip(zipFiles);
  // History (sftk-history.js): one journal for this deploy. It always writes
  // the SOURCE's current values, and this tool does not read the target's
  // prior values first — so there is nothing here to write back; see `none`.
  const journal = sftkHistoryBegin({ tool: 'Org Seeder', title: `⚙ Custom Metadata deploy (${types.length} type${types.length === 1 ? '' : 's'}) — ${orgLabel(tgtSess.orgUrl)}`, orgUrl: tgtSess.orgUrl });
  let dw;
  try {
    // The one write discipline (sftk-write.js): a deploy job's own "done" used
    // to BE the report — one re-read PER TYPE (bounded, not per record) of the
    // Developer Names it was meant to carry closes the same gap a PATCH
    // accepted-but-unchanged taught elsewhere.
    // confirmed-by: sftkSeedConfirmAndRun's sftkConfirmDestructive (RESET or
    // production step) before sftkSeedRun ever calls into this.
    dw = await sftkWriteVerified({
      describe: 'Custom Metadata deploy',
      write: () => sendBg({ type: 'SF_METADATA_DEPLOY', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, zipBase64 }),
      journal,
      verify: async () => {
        const missing = [];
        for (const [t, names] of Object.entries(devNamesByType)) {
          if (!names.length) continue;
          const lit = names.map(n => `'${String(n).replace(/'/g, "\\'")}'`).join(',');
          const q2 = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, _suppressError: true,
            query: `SELECT DeveloperName FROM ${t} WHERE DeveloperName IN (${lit})` });
          if (q2?.error) { missing.push(`${t} could not be re-read (${q2.error})`); continue; }
          const got = new Set((q2.records || []).map(r => r.DeveloperName));
          const gone = names.filter(n => !got.has(n));
          if (gone.length) missing.push(`${t}: ${gone.length} record(s) not found after deploy`);
        }
        return missing.length
          ? { ok: false, text: `Custom Metadata deploy: accepted by Salesforce, but ${missing.join('; ')}` }
          : { ok: true };
      },
    });
    if (!dw.accepted) return { deployed: 0, error: dw.raw?.error || dw.text, attempted: members.length };
    if (!dw.ok) return { deployed: 0, error: dw.text, attempted: members.length };
    return { deployed: members.length };
  } finally {
    await sftkHistoryEnd(journal, { undo: { none: 'this deploy writes the source org\'s current values; the target\'s previous values were never read, so there is nothing to write back — re-deploy from a backup, or fix the record(s) by hand in Setup' } });
  }
}

// Replace one Custom Setting's rows in a target. REPLACE, not merge: a
// setting is configuration, and a half-copied setting is worse than either
// state - the target's own rows go first so what remains is exactly what
// the source says. Hierarchy owners are re-resolved by NAME.
async function sftkSeedCfgSyncSetting(srcSess, tgtSess, obj, line) {
  const out = { inserted: 0, deleted: 0, skipped: [], failed: 0 };
  let desc = _seedDesc[obj];
  if (!desc) {
    const d = await sendBg({ type: 'SF_REST_GET', orgUrl: srcSess.orgUrl, sid: srcSess.sid,
      path: `/services/data/v62.0/sobjects/${obj}/describe` });
    if (d?.error) { line('X', `${obj}: describe failed - ${d.error}`); return out; }
    desc = _seedDesc[obj] = d;
  }
  const flavour = sftkSeedSettingFlavour(desc);
  const fields = sftkSeedSettingFields(desc);
  const cols = ['Id', ...fields, ...(flavour === 'hierarchy' ? ['SetupOwnerId'] : [])];
  const q = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: srcSess.orgUrl, sid: srcSess.sid,
    query: `SELECT ${[...new Set(cols)].join(', ')} FROM ${obj}` });
  if (q?.error) { line('X', `${obj}: read failed - ${q.error}`); return out; }
  // REPLACE deletes the target's rows first, so every refusal below happens
  // BEFORE the delete: a partial or unresolvable source must never empty a
  // setting (re-review 2026-09-12).
  if (q?.incomplete) { line('X', `${obj}: source read INCOMPLETE (Salesforce says ${q.incomplete.expected}, got ${q.incomplete.got}) - nothing removed, nothing written.`); return out; }
  const rows = q.records || [];

  let tgtCtx = null; const srcOwners = {};
  if (flavour === 'hierarchy') {
    const ownerIds = [...new Set(rows.map(r => r.SetupOwnerId).filter(Boolean))];
    const srcOrg = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: srcSess.orgUrl, sid: srcSess.sid,
      query: 'SELECT Id FROM Organization LIMIT 1' });
    const short = id => String(id || '').substring(0, 15);
    const srcOrg15 = short(srcOrg?.records?.[0]?.Id);
    for (const id of ownerIds) {
      if (srcOrg15 && short(id) === srcOrg15) srcOwners[id] = { type: 'Organization', name: 'Organization' };
    }
    const byPrefix = (p) => ownerIds.filter(id => id.startsWith(p) && !srcOwners[id]);
    const readNames = async (sobject, ids, field) => {
      for (let i = 0; i < ids.length; i += 200) {
        const lit = ids.slice(i, i + 200).map(x => `'${x}'`).join(',');
        const r = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: srcSess.orgUrl, sid: srcSess.sid,
          query: `SELECT Id, ${field} FROM ${sobject} WHERE Id IN (${lit})` });
        for (const rec of (r?.records || [])) srcOwners[rec.Id] = { type: sobject, name: rec[field] };
      }
    };
    const profIds = byPrefix('00e'), userIds = byPrefix('005');
    if (profIds.length) await readNames('Profile', profIds, 'Name');
    if (userIds.length) await readNames('User', userIds, 'Username');

    const tOrg = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
      query: 'SELECT Id FROM Organization LIMIT 1' });
    const profilesByName = {}, usersByName = {};
    const want = (type) => [...new Set(Object.values(srcOwners).filter(o => o.type === type).map(o => o.name).filter(Boolean))];
    const lookup = async (sobject, field, values, sink) => {
      for (let i = 0; i < values.length; i += 100) {
        const lit = values.slice(i, i + 100).map(v => `'${String(v).replace(/'/g, "\\'")}'`).join(',');
        const r = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
          query: `SELECT Id, ${field} FROM ${sobject} WHERE ${field} IN (${lit})` });
        for (const rec of (r?.records || [])) sink[rec[field]] = rec.Id;
      }
    };
    const wantProfiles = want('Profile'), wantUsers = want('User');
    if (wantProfiles.length) await lookup('Profile', 'Name', wantProfiles, profilesByName);
    if (wantUsers.length) await lookup('User', 'Username', wantUsers, usersByName);
    tgtCtx = { orgId: tOrg?.records?.[0]?.Id || '', profilesByName, usersByName };
    if (!tgtCtx.orgId) { line('X', `${obj}: the target's Organization Id could not be read${tOrg?.error ? ` (${tOrg.error})` : ''} - org-default rows could not be re-owned, so nothing was removed and nothing written.`); return out; }
  }

  // Build the payload FIRST - a row whose owner cannot be resolved is
  // skipped and NAMED, never written to the wrong owner.
  const payload = [];
  for (const r of rows) {
    const rec = { attributes: { type: obj } };
    for (const f of fields) if (r[f] !== undefined) rec[f] = r[f];
    if (flavour === 'hierarchy') {
      const res = sftkSeedResolveOwner(r.SetupOwnerId, srcOwners, tgtCtx);
      if (!res.id) { out.skipped.push(`${r.Id}: ${res.why}`); continue; }
      rec.SetupOwnerId = res.id;
    }
    payload.push(rec);
  }

  if (rows.length && !payload.length) {
    line('X', `${obj}: none of the ${rows.length} source row(s) could be re-owned in the target - nothing removed, nothing written.`);
    return out;
  }
  // Full rows (not just Id) — captured so a confirmed delete can be undone
  // by re-inserting the same values (History, sftk-history.js).
  const existing = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
    query: `SELECT ${[...new Set(cols)].join(', ')} FROM ${obj}` });
  if (existing?.error) { line('X', `${obj}: the target's rows could not be listed - ${existing.error}. Nothing removed, nothing written.`); return out; }
  if (existing?.incomplete) { line('X', `${obj}: the target's row list came back INCOMPLETE (Salesforce says ${existing.incomplete.expected}, got ${existing.incomplete.got}) - a replace over a partial list would leave stray rows. Nothing removed, nothing written.`); return out; }
  const oldRows = existing?.records || [];
  const oldRowById = new Map(oldRows.map(r => [r.Id, r]));
  const oldIds = oldRows.map(r => r.Id);
  // History (sftk-history.js): one journal for the whole replace (delete +
  // insert) — undo restores the deleted rows' own values, then removes
  // whatever this run created, same "restore what was confirmed" rule as
  // everywhere else.
  const journal = sftkHistoryBegin({ tool: 'Org Seeder', title: `🔁 ${obj} replaced — ${orgLabel(tgtSess.orgUrl)}`, orgUrl: tgtSess.orgUrl });
  const restoreRows = [];    // old rows confirmed deleted — re-insert to undo
  const createdIds = [];     // new rows confirmed created — delete to undo
  try {
    for (let i = 0; i < oldIds.length; i += 200) {
      const delIds = oldIds.slice(i, i + 200);
      // The one write discipline (sftk-write.js): Collections' per-record
      // success used to BE "removed" — one re-read of exactly this slice's
      // Ids confirms the org actually shows them gone.
      // confirmed-by: sftkSeedConfirmAndRun's sftkConfirmDestructive (RESET or
      // production step, plus sftkSeedCfgReplaceGate's own delete warning)
      // before sftkSeedRun ever calls into this.
      const dw = await sftkWriteVerified({
        describe: `${obj} replace`,
        write: () => sendBg({ type: 'SF_COLLECTIONS_DELETE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, ids: delIds }),
        journal,
        verify: async (writeRes) => {
          const del = Array.isArray(writeRes) ? writeRes : (writeRes?.results || []);
          const okIds = del.filter(d => d && d.success).map(d => d.id);
          out.deleted += okIds.length;
          for (const id of okIds) { const r = oldRowById.get(id); if (r) restoreRows.push(r); }
          if (!okIds.length) return { ok: true };
          const vq = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, _suppressError: true,
            query: `SELECT Id FROM ${obj} WHERE Id IN (${okIds.map(id => soqlStrLit(id)).join(',')})` });
          if (vq?.error) return { ok: false, text: `${obj} replace: accepted by Salesforce, but the org could not be re-read to confirm the delete (${vq.error})` };
          const stillThere = (vq.records || []).length;
          return stillThere
            ? { ok: false, text: `${obj} replace: accepted by Salesforce, but ${stillThere} record(s) still show in the org` }
            : { ok: true };
        },
      });
      if (!dw.accepted) { line('X', `${obj}: delete failed - ${dw.raw?.error || dw.text}`); }
      else if (!dw.ok) { line('!', dw.text); }
    }
    for (let i = 0; i < payload.length; i += 200) {
      const slice = payload.slice(i, i + 200);
      // History (sftk-history.js): the Org Seeder's inserts — undo deletes
      // exactly the Ids Salesforce confirmed creating.
      // confirmed-by: sftkSeedConfirmAndRun's sftkConfirmDestructive (RESET or
      // production step) before sftkSeedRun ever calls into this.
      const iw = await sftkWriteVerified({
        describe: `${obj} replace insert`,
        write: () => sendBg({ type: 'SF_COLLECTIONS_CREATE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, records: slice }),
        journal,
        verify: async (writeRes) => {
          const ins = Array.isArray(writeRes) ? writeRes : (writeRes?.results || writeRes || []);
          const okIds = ins.filter(r => r && r.success).map(r => r.id);
          out.inserted += okIds.length;
          createdIds.push(...okIds);
          for (const r of ins) {
            if (!(r && r.success)) { out.failed++; if (out.failed <= 3) line('!', `${obj}: ${(r?.errors || []).map(e => e.message).join('; ') || 'insert rejected'}`); }
          }
          if (!okIds.length) return { ok: ins.length === 0 };
          const vq = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, _suppressError: true,
            query: `SELECT Id FROM ${obj} WHERE Id IN (${okIds.map(id => soqlStrLit(id)).join(',')})` });
          if (vq?.error) return { ok: false, text: `${obj} replace insert: accepted by Salesforce, but the org could not be re-read to confirm it (${vq.error})` };
          const found = (vq.records || []).length;
          return found === okIds.length ? { ok: true } : { ok: false, text: `${obj} replace insert: accepted by Salesforce, but only ${found} of ${okIds.length} record(s) re-read back` };
        },
      });
      if (!iw.accepted) { out.failed += slice.length; line('X', `${obj}: insert failed - ${iw.raw?.error || iw.text}`); }
    }
    line(out.failed ? '!' : 'OK',
      `${obj} (${flavour}): ${out.deleted} removed, ${out.inserted} written${out.failed ? `, ${out.failed} failed` : ''}${out.skipped.length ? `, ${out.skipped.length} skipped` : ''}`);
    if (out.skipped.length) {
      line('i', `${obj}: not written - ${out.skipped.slice(0, 5).join(' | ')}${out.skipped.length > 5 ? ` | +${out.skipped.length - 5} more` : ''}`);
    }
    return out;
  } finally {
    const steps = [];
    if (restoreRows.length) {
      let cum = 0;
      for (let i = 0; i < restoreRows.length; i += 200) {
        const chunk = restoreRows.slice(i, i + 200);
        cum += chunk.length;
        steps.push({
          describe: `${obj}: restore ${chunk.length} deleted row(s) (${i + 1}-${i + chunk.length} of ${restoreRows.length})`,
          // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
          msg: { type: 'SF_COLLECTIONS_CREATE', records: chunk.map(r => { const rec = { attributes: { type: obj } }; for (const f of fields) if (r[f] !== undefined) rec[f] = r[f]; if (flavour === 'hierarchy' && r.SetupOwnerId) rec.SetupOwnerId = r.SetupOwnerId; return rec; }) },
          verify: { query: `SELECT Id FROM ${obj}`, tooling: false, count: cum,
            text: { ok: `${obj}: ${cum} row(s) now in the object — the deleted rows appear restored (re-inserted rows get new Ids, so this checks the count, not identity)`,
                    bad: `${obj}: the restore was accepted, but the object doesn't show ${cum} row(s) yet` } },
        });
      }
    }
    if (createdIds.length) {
      for (let i = 0; i < createdIds.length; i += 200) {
        const chunk = createdIds.slice(i, i + 200);
        steps.push({
          describe: `${obj}: remove ${chunk.length} row(s) this replace created`,
          // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
          msg: { type: 'SF_COLLECTIONS_DELETE', ids: chunk },
          verify: { query: `SELECT Id FROM ${obj} WHERE Id IN (${chunk.map(id => soqlStrLit(id)).join(',')})`, tooling: false, count: 0,
            text: { ok: `${obj}: ${chunk.length} created row(s) removed — verified by re-reading the org`,
                    bad: `${obj}: the removal was accepted, but the org still shows some of these rows` } },
        });
      }
    }
    await sftkHistoryEnd(journal, { undo: steps.length ? { steps, note: 'restoring deleted rows re-inserts them with new record Ids' } : { none: 'nothing was confirmed changed' } });
  }
}

// Custom Labels. Read through the Tooling API (they are ExternalString
// there), deployed as one CustomLabels file. Managed-package labels are
// named and skipped rather than allowed to fail the whole package.
async function sftkSeedCfgDeployLabels(srcSess, tgtSess, wanted, line) {
  const q = await sendBg({ type: 'SF_QUERY_ALL', tooling: true, orgUrl: srcSess.orgUrl, sid: srcSess.sid,
    query: sftkLabelSoql() });
  if (q?.error) { line('X', `Custom Labels: read failed - ${q.error}`); return { deployed: 0, error: q.error }; }
  const want = wanted && wanted.size ? wanted : null;
  const rows = (q.records || []).filter(r => !want || want.has(r.Name));
  const split = sftkLabelDeployable(rows);
  if (split.skipped.length) {
    line('i', `Custom Labels: ${split.skipped.length} skipped - ${split.skipped.slice(0, 3).map(x => `${x.name} (${x.why})`).join('; ')}${split.skipped.length > 3 ? '...' : ''}`);
  }
  if (!split.deployable.length) return { deployed: 0, note: 'nothing deployable' };

  // Translations ride in the SAME package. Without them a multi-language
  // org looks seeded and reads wrong: every non-default language silently
  // falls back to the English value (user 2026-08-22).
  const nameById = {};
  for (const r of split.deployable) nameById[r.Id] = r.Name;
  const tq = await sendBg({ type: 'SF_QUERY_ALL', tooling: true, orgUrl: srcSess.orgUrl, sid: srcSess.sid,
    query: sftkLabelTransSoql() });
  let byLang = {}, transCount = 0;
  if (tq?.error) {
    // Translation Workbench off, or no read access - say so, deploy the
    // labels anyway. Half a deploy the user knows about beats none.
    line('i', `Custom Labels: translations not read (${tq.error}) - labels deploy WITHOUT translated values.`);
  } else {
    const grouped = sftkLabelTransGroup(tq.records || [], nameById);
    byLang = grouped.byLang;
    transCount = Object.values(byLang).reduce((n, a) => n + a.length, 0);
    if (grouped.orphaned) {
      line('i', `Custom Labels: ${grouped.orphaned} translation(s) belong to labels outside this deploy - not carried.`);
    }
    if (transCount) {
      line('R', `Custom Labels: ${transCount} translation(s) across ${Object.keys(byLang).length} language(s).`);
    }
  }

  const enc = new TextEncoder();
  const langs = Object.keys(byLang);
  const zipBase64 = window.sftkBuildStoredZip([
    { name: 'package.xml', data: enc.encode(sftkMetaPackageXml({
      CustomLabel: split.deployable.map(r => r.Name),
      ...(langs.length ? { Translations: langs } : {}),
    }, '62.0')) },
    { name: 'labels/CustomLabels.labels', data: enc.encode(sftkLabelsFileXml(split.deployable)) },
    ...langs.map(l => ({ name: `translations/${l}.translation`, data: enc.encode(sftkLabelTransFileXml(byLang[l])) })),
  ]);
  // History (sftk-history.js): one journal for this deploy. Like the Custom
  // Metadata deploy above, it writes the SOURCE's current label text and
  // never reads the target's prior text first — nothing here to write back.
  const journal = sftkHistoryBegin({ tool: 'Org Seeder', title: `🏷 Custom Labels deploy (${split.deployable.length}) — ${orgLabel(tgtSess.orgUrl)}`, orgUrl: tgtSess.orgUrl });
  try {
    // The one write discipline (sftk-write.js): a deploy job's own "done" used
    // to BE the report — one re-read of the label names it was meant to carry
    // closes the same gap a PATCH accepted-but-unchanged taught elsewhere.
    // confirmed-by: sftkSeedConfirmAndRun's sftkConfirmDestructive (RESET or
    // production step) before sftkSeedRun ever calls into this.
    const names = split.deployable.map(r => r.Name);
    const dw = await sftkWriteVerified({
      describe: 'Custom Labels deploy',
      write: () => sendBg({ type: 'SF_METADATA_DEPLOY', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, zipBase64 }),
      journal,
      verify: async () => {
        if (!names.length) return { ok: true };
        const lit = names.map(n => `'${String(n).replace(/'/g, "\\'")}'`).join(',');
        const q2 = await sendBg({ type: 'SF_QUERY_ALL', tooling: true, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, _suppressError: true,
          query: `SELECT Name FROM ExternalString WHERE Name IN (${lit})` });
        if (q2?.error) return { ok: false, text: `Custom Labels deploy: accepted by Salesforce, but the org could not be re-read to confirm it (${q2.error})` };
        const got = new Set((q2.records || []).map(r => r.Name));
        const gone = names.filter(n => !got.has(n));
        return gone.length
          ? { ok: false, text: `Custom Labels deploy: accepted by Salesforce, but ${gone.length} label(s) not found after deploy` }
          : { ok: true };
      },
    });
    if (!dw.accepted) return { deployed: 0, error: dw.raw?.error || dw.text, attempted: split.deployable.length };
    if (!dw.ok) return { deployed: 0, error: dw.text, attempted: split.deployable.length };
    return { deployed: split.deployable.length, translations: transCount, languages: langs.length };
  } finally {
    await sftkHistoryEnd(journal, { undo: { none: 'this deploy writes the source org\'s current label text; the target\'s previous text was never read, so there is nothing to write back — re-deploy from a backup, or fix the label(s) by hand in Setup' } });
  }
}

// The configuration pass for ONE target: metadata deploys first (they are
// upsert-by-name and cheap to repeat), then settings replacement.
async function sftkSeedCfgRunOne(srcSess, tgtSess, line) {
  const sel = [..._seedCfgSel];
  const mdt = sel.filter(n => /__mdt$/i.test(n));
  const settings = sel.filter(n => !/__mdt$/i.test(n) && n !== '__labels__');
  const doLabels = _seedCfgSel.has('__labels__');
  if (doLabels) {
    const r = await sftkSeedCfgDeployLabels(srcSess, tgtSess, null, line);
    line(r.error ? 'X' : 'OK', `Custom Labels: ${r.error ? `deploy failed - ${r.error}`
      : `${r.deployed} deployed${r.translations ? ` + ${r.translations} translation(s) in ${r.languages} language(s)` : ''}`}`);
  }
  if (mdt.length && !_seedCancelled) {
    const r = await sftkSeedCfgDeployMdt(srcSess, tgtSess, mdt, line);
    if (r.cancelled) return;
    line(r.error ? 'X' : 'OK', `Custom Metadata: ${r.error ? `deploy failed - ${r.error}` : `${r.deployed} record(s) deployed`}`);
  }
  for (const o of settings) {
    if (_seedCancelled) { line('!', `${o}: skipped - cancelled`); continue; }
    await sftkSeedCfgSyncSetting(srcSess, tgtSess, o, line);
  }
}

// Render the configuration block. Deliberately its own table: these rows
// are NOT seeded like data (no wipe ordering, no PII masking, no match
// key), and blending them into the objects table would imply they were.
function sftkSeedCfgRender() {
  const host = eid('dsSeedCfgBody');
  if (!host) return;
  if (!_seedCfgRows) {
    host.innerHTML = '<div class="ds-pk-note">Custom Metadata, Custom Settings and Custom Labels are configuration your DATA depends on: validation rules, flows and Apex read them. Load them to seed configuration before rows.</div>';
    return;
  }
  const targets = [..._seedTargets];
  const n = v => v === undefined ? '<span title="not counted yet">...</span>'
    : v == null ? '<span title="count unavailable - treated as UNKNOWN">?</span>'
    : Number(v).toLocaleString();
  const kindChip = k => k === 'mdt'
    ? '<span class="ds-oc-sub" title="Custom Metadata: deployed as metadata, upsert by name - re-runs update, never duplicate.">metadata</span>'
    : '<span class="ds-oc-sub" title="Custom Setting: real rows. The target\u2019s rows are REPLACED so the target matches the source exactly.">setting</span>';
  host.innerHTML = `
    <div style="overflow-x:auto;margin-top:8px">
      <table style="border-collapse:collapse;width:100%;font-size:12.5px">
        <tr>
          <th style="text-align:left;padding:4px 8px"></th>
          <th style="text-align:left;padding:4px 8px">Configuration</th>
          <th style="text-align:left;padding:4px 8px">Kind</th>
          <th style="text-align:right;padding:4px 8px">${esc(orgLabel(currentSourceOrg()))} (source)</th>
          ${targets.map(t => `<th style="text-align:right;padding:4px 8px">${esc(orgLabel(t))}</th>`).join('')}
        </tr>
        <tr style="border-top:1px solid var(--c-border, #333)">
          <td style="padding:3px 8px"><input type="checkbox" class="ds-seed-cfg" value="__labels__" ${_seedCfgSel.has('__labels__') ? 'checked' : ''}></td>
          <td style="padding:3px 8px">Custom Labels <span class="ds-oc-sub">all unmanaged</span></td>
          <td style="padding:3px 8px">${kindChip('mdt')}</td>
          <td style="padding:3px 8px;text-align:right" class="ds-oc-sub" colspan="${1 + targets.length}">deployed by name - counted per deploy, not before</td>
        </tr>
        ${_seedCfgRows.map(r => `
          <tr style="border-top:1px solid var(--c-border, #333)">
            <td style="padding:3px 8px"><input type="checkbox" class="ds-seed-cfg" value="${esc(r.name)}" ${_seedCfgSel.has(r.name) ? 'checked' : ''}></td>
            <td style="padding:3px 8px">${esc(r.name)}</td>
            <td style="padding:3px 8px">${kindChip(r.kind)}</td>
            <td style="padding:3px 8px;text-align:right;font-variant-numeric:tabular-nums" data-cfg-cell="${esc(r.name)}|src">${n(r.srcCount)}</td>
            ${targets.map(t => {
              const tc = r.tgtCounts[t];
              const same = r.srcCount != null && tc != null && r.srcCount === tc;
              return `<td style="padding:3px 8px;text-align:right;font-variant-numeric:tabular-nums;${same ? 'opacity:.65' : 'color:var(--c-warn-text, #d97706)'}" data-cfg-cell="${esc(r.name)}|${esc(_orgKey(t))}">${n(tc)}</td>`;
            }).join('')}
          </tr>`).join('')}
      </table>
    </div>
    <div class="ds-pk-note" style="margin-top:6px">Custom Metadata and Labels are <strong>deployed</strong> (upsert by name, safe to repeat). Custom Settings are <strong>replaced</strong> — the target's rows are deleted first, so the target ends up matching the source exactly. Hierarchy settings re-resolve their owner by profile name or username; owners the target doesn't have are listed, never guessed.</div>
    <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
      <span class="ds-oc-sub">${_seedCfgSel.size} selected</span>
      <span style="flex:1"></span>
      <button class="ds-btn" id="dsSeedCfgGo" ${_seedCfgSel.size ? '' : 'disabled'}
        title="Deploy the ticked configuration into every ticked target. Runs on its own; a Reset &amp; Seed also runs it first.">&#9881; Seed configuration now</button>
    </div>`;
  host.querySelectorAll('.ds-seed-cfg').forEach(cb => cb.addEventListener('change', () => {
    if (cb.checked) _seedCfgSel.add(cb.value); else _seedCfgSel.delete(cb.value);
    sftkSeedCfgRender();
  }));
  eid('dsSeedCfgGo')?.addEventListener('click', () => sftkSeedConfirmAndRun({ wipe: false, seed: false, config: true }));
}
