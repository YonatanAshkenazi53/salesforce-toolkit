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
    'Contract', 'Order', 'OrderItem', 'Task', 'Event', 'Note'];
}

// ── View state ─────────────────────────────────────────────────────────
let _seedTargets = new Set();      // selected target org urls
let _seedRows    = null;           // [{ name, custom, srcCount, tgtCounts: {url: n} }]
let _seedSel     = new Set();      // selected object api names
let _seedDesc    = {};             // source describes by object (fields)
let _seedBusy    = false;
let _seedDelMode = 'recycle';
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

// Text-ish fields worth sampling — the only ones a pattern can be read from.
function sftkSeedSampleFields(desc) {
  return (desc.fields || []).filter(f =>
    f && f.name && f.createable &&
    (f.type === 'string' || f.type === 'textarea' || f.type === 'email' ||
     f.type === 'phone' || f.type === 'url')).slice(0, 40);
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
    (onlyObj ? r.name === onlyObj : _seedSel.has(r.name)) && (r.pii || []).length);
  if (!rows.length) {
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
  const body = rows.map(r => `
    <div style="margin:12px 0 4px"><strong>${esc(r.name)}</strong> <span class="ds-oc-sub">${r.pii.length} suggestion(s)</span></div>
    ${r.pii.map(s => {
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
    <div id="dsSeedBody">${_seedRows ? '' : '<div class="ds-pk-note">Tick at least one target, then load objects. Custom objects are listed first; system objects are excluded.</div>'}</div>
    <div id="dsSeedLog"></div>` : ''}
  `);
  document.querySelectorAll('.ds-seed-tgt').forEach(cb => cb.addEventListener('change', () => {
    if (cb.checked) _seedTargets.add(cb.value); else _seedTargets.delete(cb.value);
  }));
  eid('dsSeedLoad')?.addEventListener('click', () => sftkSeedLoad());
  // Masking rules are machine-local and persist across sessions — load them
  // before the table can claim an object is unmasked.
  sftkSeedPiiLoad().then(() => { if (_seedRows) sftkSeedRenderRows(); });
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
    const names = (gd.sobjects || []).filter(s =>
      s.queryable && s.createable && s.updateable && s.deletable
      && !s.customSetting && !s.deprecatedAndHidden
      && !/__(mdt|e|Share|Tag|History|Feed|ChangeEvent)$/.test(s.name)
      && (s.custom || std.has(s.name)))
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

    const count = async (sess, obj) => {
      try {
        const r = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid,
          query: `SELECT COUNT() FROM ${obj}` });
        return (r && !r.error && Number.isFinite(r.totalSize)) ? r.totalSize : null;
      } catch (_) { return null; }
    };
    const paint = (obj, key, v) => {
      const cell = document.querySelector(`[data-seed-cell="${CSS.escape(obj + '|' + key)}"]`);
      if (cell) cell.textContent = v == null ? '?' : Number(v).toLocaleString();
    };

    for (const row of _seedRows) {
      if (_seedLoadCancel) break;
      say(`counting ${row.name} — ${counted} / ${names.length} object(s)`);
      row.srcCount = await count(srcSess, row.name);
      paint(row.name, 'src', row.srcCount);
      for (const t of targets) {
        if (_seedLoadCancel) break;
        row.tgtCounts[t] = await count(tgtSess[t], row.name);
        paint(row.name, _orgKey(t), row.tgtCounts[t]);
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
  const n = v => v === undefined ? '<span title="not counted yet">…</span>'
    : v == null ? '<span title="count unavailable — treated as UNKNOWN">?</span>'
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
        <span class="ds-oc-sub" id="dsSeedPiiProg"></span>
      </div>
      <div style="overflow-x:auto;margin-top:8px">
      <table style="border-collapse:collapse;width:100%;font-size:12.5px">
        <tr>
          <th style="text-align:left;padding:4px 8px"></th>
          <th style="text-align:left;padding:4px 8px">Object</th>
          <th style="text-align:left;padding:4px 8px">PII</th>
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
              if (r.pii) return '<span class="ds-oc-sub" title="Nothing matched the value patterns, compliance tags or name heuristics.">none found</span>';
              return '<span class="ds-oc-sub" title="Run 🎭 Scan for PII to check this object.">not scanned</span>';
            })()}</td>
            <td style="padding:3px 8px;text-align:right;font-variant-numeric:tabular-nums" data-seed-cell="${esc(r.name)}|src">${n(r.srcCount)}</td>
            ${targets.map(t => {
              const tc = r.tgtCounts[t];
              const same = r.srcCount != null && tc != null && r.srcCount === tc;
              return `<td style="padding:3px 8px;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;${same ? 'opacity:.65' : 'color:var(--c-warn-text, #d97706)'}"><span data-seed-cell="${esc(r.name)}|${esc(_orgKey(t))}">${n(tc)}</span> <button class="ds-btn ds-btn-xs" data-seed-rec="${esc(r.name)}|${esc(t)}" title="Open ⚖ Reconcile for ${esc(r.name)} against ${esc(orgLabel(t))} — compare row by row and pick exactly which records to push, overwrite or delete.">⚖</button></td>`;
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
  body.querySelectorAll('[data-seed-pii-open]').forEach(b => b.addEventListener('click', () =>
    sftkSeedPiiModal(b.dataset.seedPiiOpen)));
  body.querySelectorAll('[data-seed-rec]').forEach(b => b.addEventListener('click', () => {
    const [obj, tgt] = String(b.dataset.seedRec).split('|');
    sftkSeedOpenReconcile(obj, tgt);
  }));
  eid('dsSeedWipe')?.addEventListener('click', () => sftkSeedConfirmAndRun({ wipe: true, seed: false }));
  eid('dsSeedGo')?.addEventListener('click', () => sftkSeedConfirmAndRun({ wipe: false, seed: true }));
  eid('dsSeedReset')?.addEventListener('click', () => sftkSeedConfirmAndRun({ wipe: true, seed: true }));
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
  const pair = {
    ...sftkSeedProfileFor(obj, srcUrl, tgtUrl, [..._seedSel]),
    id: `seedpair_${Date.now()}_${obj}`,
    name: `${obj} · ${orgLabel(srcUrl)} → ${orgLabel(tgtUrl)}`,
    // Origin stamp so a post-run writeback credits the REAL deployment when
    // one exists (same contract as the ring's ⚖ clone).
    ...(saved ? { _ringOf: { profileId: saved.id } } : {}),
    lastScan: null, ringScans: undefined, ephemeral: true,
  };
  showToast(`Scanning ${obj} in ${orgLabel(tgtUrl)}…`, 'info', 3000);
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
  if (!objs.length) { showToast('Select at least one object', 'warning'); return; }
  if (!targets.length) { showToast('Tick at least one target org', 'warning'); return; }
  if (targets.some(t => _orgKey(t) === _orgKey(currentSourceOrg()))) {
    showToast('The source of truth can never be a target.', 'error', 6000); return;
  }
  // A target ticked AFTER "Load objects & counts" has no counts at all —
  // it must never reach the confirm dialog as "~0 record(s)".
  const unloaded = targets.filter(t => !_seedLoadedTargets.has(t));
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
  const prodConfirms = async () => {
    for (const t of prodTargets) {
      const summary = what.wipe
        ? `wipe ${what.seed ? 'and re-seed ' : ''}${objs.length} object(s)`
        : `seed ${objs.length} object(s)`;
      if (!(await confirmTypedProd(orgLabel(t), summary))) return false;
    }
    return true;
  };
  if (!what.wipe) {
    if (what.seed && !(await sftkSeedRawPiiGate(objs))) return;
    if (!(await prodConfirms())) return;
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
  showModal(`
    <div class="ds-modal-header">🧹 ${what.seed ? 'Reset & Seed' : 'Wipe targets'} — this DELETES data</div>
    <div class="ds-modal-body" style="font-size:12.5px">
      <div>You are about to delete the selected objects' rows in:</div>
      ${lines}
      <div class="ds-pk-note" style="margin-top:6px">Counts are the loaded totals per object. Master-detail children of deleted records cascade-delete too. ${what.seed ? 'Seeding runs right after each wipe.' : ''}</div>
      ${(() => {
        const masked = objs.reduce((n, o) => n + Object.keys(sftkSeedPiiForObject(o)).length, 0);
        return masked ? `<div class="ds-pk-note" style="margin-top:4px">🎭 ${masked} field(s) will be pseudonymized on the way in — masked, never anonymized.</div>` : '';
      })()}
      <div style="margin-top:10px">Type <strong>RESET</strong> to confirm:</div>
      <input id="dsSeedConfirmInput" class="ds-input" style="margin-top:4px" autocomplete="off" placeholder="RESET">
    </div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn ds-btn-danger" id="dsSeedConfirmGo" disabled>🧹 ${what.seed ? 'Reset & Seed' : 'Wipe'} ${targets.length} org(s)</button>
    </div>`);
  const inp = eid('dsSeedConfirmInput'), go = eid('dsSeedConfirmGo');
  inp?.addEventListener('input', () => { if (go) go.disabled = inp.value.trim() !== 'RESET'; });
  inp?.focus();
  go?.addEventListener('click', async () => {
    closeModal();
    if (what.seed && !(await sftkSeedRawPiiGate(objs))) return;
    if (!(await prodConfirms())) return;
    sftkSeedRun(what, objs, targets);
  });
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
      _seedPort = (typeof _openRunPort === 'function') ? _openRunPort(_trProgressHandler(liveEl)) : null;
      try {
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
          const seedOne = async (o, label) => {
            const prof = sftkSeedProfileFor(o, srcUrl, t, objs);
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
function sftkSeedProfileFor(obj, srcUrl, tgtUrl, selected) {
  const saved = (_profiles || []).find(p => p && !p.ephemeral && p.tree?.objectType === obj);
  const desc = _seedDesc[obj] || { fields: [] };
  const extIds = (desc.fields || []).filter(f => f.externalId && f.createable);
  const auto = extIds.length === 1 ? extIds[0].name : null;
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
    id: `seed_${obj}_${_orgKey(tgtUrl)}`, name: `Seed ${obj}`, ephemeral: true,
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
      objectType: obj, where: '', children: [],
      fieldMappings: saved?.tree?.fieldMappings || {},
      ...(saved?.tree?.matching ? { matching: saved.tree.matching }
        : auto ? { matching: { strategy: 'externalId', fields: [auto], normalize: {} } } : {}),
      ...(saved?.tree?.upsert ? { upsert: saved.tree.upsert }
        : auto ? { upsert: { field: auto } } : {}),
      lookupResolutions,
    },
  };
}
