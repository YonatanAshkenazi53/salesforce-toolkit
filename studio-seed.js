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
          title="Reads the object list (source describe) and LIVE record counts — 1 count query per object per org.">🔍 Load objects &amp; counts</button>
      </div>
    </div>
    <div id="dsSeedBody">${_seedRows ? '' : '<div class="ds-pk-note">Tick at least one target, then load objects. Custom objects are listed first; system objects are excluded.</div>'}</div>
    <div id="dsSeedLog"></div>` : ''}
  `);
  document.querySelectorAll('.ds-seed-tgt').forEach(cb => cb.addEventListener('change', () => {
    if (cb.checked) _seedTargets.add(cb.value); else _seedTargets.delete(cb.value);
  }));
  eid('dsSeedLoad')?.addEventListener('click', () => sftkSeedLoad());
  if (_seedRows) sftkSeedRenderRows();
};

// ── Load objects + live counts ─────────────────────────────────────────
async function sftkSeedLoad() {
  const srcUrl = currentSourceOrg();
  const targets = [..._seedTargets];
  if (!targets.length) { showToast('Tick at least one target org first', 'warning'); return; }
  const btn = eid('dsSeedLoad');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ reading…'; }
  try {
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

    // Live counts: source once + each target. Sequential, disclosed cost.
    const count = async (sess, obj) => {
      try {
        const r = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid,
          query: `SELECT COUNT() FROM ${obj}` });
        return (r && !r.error && Number.isFinite(r.totalSize)) ? r.totalSize : null;
      } catch (_) { return null; }
    };
    const tgtSess = {};
    for (const t of targets) {
      tgtSess[t] = await getOrgSession(t);
      if (!tgtSess[t]?.sid) throw new Error(`${orgLabel(t)} is not open in a Chrome tab`);
    }
    const rows = [];
    for (const o of names) {
      const row = { ...o, srcCount: await count(srcSess, o.name), tgtCounts: {} };
      for (const t of targets) row.tgtCounts[t] = await count(tgtSess[t], o.name);
      rows.push(row);
    }
    _seedRows = rows;
    _seedLoadedTargets = new Set(targets);
    // Default selection: custom objects that hold source data.
    _seedSel = new Set(rows.filter(r => r.custom && (r.srcCount || 0) > 0).map(r => r.name));
    sftkSeedRenderRows();
  } catch (e) {
    showToast(`Load failed: ${e?.message || e}`, 'error', 6000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔍 Load objects & counts'; }
  }
}

function sftkSeedRenderRows() {
  const body = eid('dsSeedBody');
  if (!body || !_seedRows) return;
  const targets = [..._seedTargets];
  const n = v => v == null ? '<span title="count unavailable">?</span>' : String(v);
  body.innerHTML = `
    <div class="ds-ring-cfg" style="padding:12px 14px;margin-top:10px">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <strong>Objects</strong>
        <button class="ds-btn ds-btn-xs" id="dsSeedAllCustom">✓ All custom with data</button>
        <button class="ds-btn ds-btn-xs" id="dsSeedAll">✓ All listed</button>
        <button class="ds-btn ds-btn-xs" id="dsSeedNone">✗ None</button>
        <span class="ds-oc-sub" id="dsSeedSelCount">${_seedSel.size} selected</span>
      </div>
      <div style="overflow-x:auto;margin-top:8px">
      <table style="border-collapse:collapse;width:100%;font-size:12.5px">
        <tr>
          <th style="text-align:left;padding:4px 8px"></th>
          <th style="text-align:left;padding:4px 8px">Object</th>
          <th style="text-align:right;padding:4px 8px">${esc(orgLabel(currentSourceOrg()))} (source)</th>
          ${targets.map(t => `<th style="text-align:right;padding:4px 8px">${esc(orgLabel(t))}</th>`).join('')}
        </tr>
        ${_seedRows.map(r => `
          <tr style="border-top:1px solid var(--c-border, #333)">
            <td style="padding:3px 8px"><input type="checkbox" class="ds-seed-obj" value="${esc(r.name)}" ${_seedSel.has(r.name) ? 'checked' : ''}></td>
            <td style="padding:3px 8px">${esc(r.name)}${r.custom ? '' : ' <span class="ds-oc-sub">standard</span>'}</td>
            <td style="padding:3px 8px;text-align:right;font-variant-numeric:tabular-nums">${n(r.srcCount)}</td>
            ${targets.map(t => {
              const tc = r.tgtCounts[t];
              const same = r.srcCount != null && tc != null && r.srcCount === tc;
              return `<td style="padding:3px 8px;text-align:right;font-variant-numeric:tabular-nums;${same ? 'opacity:.65' : 'color:var(--c-warn-text, #d97706)'}">${n(tc)}</td>`;
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
        <button class="ds-btn" id="dsSeedGo" title="Deploy every source row of the selected objects into every ticked target — parents-first, through the normal engine (Bulk API, matching, PII masking, live progress).">⬆ Seed targets</button>
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
  eid('dsSeedWipe')?.addEventListener('click', () => sftkSeedConfirmAndRun({ wipe: true, seed: false }));
  eid('dsSeedGo')?.addEventListener('click', () => sftkSeedConfirmAndRun({ wipe: false, seed: true }));
  eid('dsSeedReset')?.addEventListener('click', () => sftkSeedConfirmAndRun({ wipe: true, seed: true }));
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
    </div><div class="ds-seed-runlog"></div>`;
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
            if (_seedCancelled) { line('✋', `${orgLabel(t)} · wipe ${o}: skipped — cancelled`); continue; }
            const res = await sendBg({ type: 'SFTK_WIPE_OBJECT',
              orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, objType: o, mode: _seedDelMode });
            if (res?.error) { line('❌', `${orgLabel(t)} · wipe ${o}: ${res.error}`); continue; }
            line(res.failed ? '⚠' : '🧹', `${orgLabel(t)} · ${o}: ${res.deleted} deleted${res.failed ? `, ${res.failed} failed` : ''}${_seedDelMode === 'hard' ? ' (hard)' : ''}`);
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
            if (_seedCancelled) { line('✋', `${orgLabel(t)} · seed ${o}: skipped — cancelled`); continue; }
            // Bridges matched by Name are a guess, not an identity — say so
            // BEFORE the write (review: silent mis-linking on dup names).
            const probe = sftkSeedProfileFor(o, srcUrl, t, objs);
            const nameBridges = Object.entries(probe.tree.lookupResolutions || {})
              .filter(([, r]) => r && r.matchField === 'Name').map(([f]) => f);
            if (nameBridges.length) {
              line('⚠', `${o}: bridging ${nameBridges.join(', ')} by Name — duplicate names can mis-link; an External ID on the referenced object makes this exact.`);
            }
            const prof = await seedOne(o, `seed ${o}`);
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
        line('🏁', `${orgLabel(t)} — ${_seedCancelled ? 'stopped by cancel' : 'done'}`);
      } finally {
        try { _seedPort?.disconnect(); } catch (_) {}
        _seedPort = null;
      }
    }
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
    ...(saved?.piiPolicy ? { piiPolicy: saved.piiPolicy, piiSalt: saved.piiSalt } : {}),
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
