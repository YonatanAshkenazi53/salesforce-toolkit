'use strict';
// ════════════════════════════════════════════════════════════════
// RECONCILE (Phase 3A) — one screen to review + fix sync state
// ════════════════════════════════════════════════════════════════
// Three columns from profile.lastScan:
//   missing in target → push (insert)
//   drift             → push source values (overwrite) or skip
//   only in target    → delete from target
// Root object only in v1. Bulk actions execute in one Run with a
// confirmation modal before any destructive delete.

window.openReconcile = function(profileId, targetUrl) {
  const p = _profiles.find(x => x.id === profileId) || null;
  if (!p) { _reconcileProfile = null; renderReconcile(); return; }
  // Reconcile is PER PAIR (user 2026-08-11: "reconcile occurs per target,
  // no?") — a multi-target deployment must say WHICH target this session
  // fixes. One target → straight in, exactly as before.
  const tgts = (typeof profileTargets === 'function' ? profileTargets(p) : []).filter(Boolean);
  if (tgts.length > 1 && !targetUrl) {
    showModal(`
      <div class="ds-modal-header">⚖ Reconcile — pick the target</div>
      <div class="ds-modal-body" style="font-size:12.5px">
        <div style="margin-bottom:8px">Reconcile fixes <strong>one source → target pair</strong> at a time. ${esc(orgLabel(p.sourceOrg))} pushes to ${tgts.length} targets — which one is this session about?</div>
        ${tgts.map(u => {
          let rs = null;
          try {
            // QA sweep round 2: _ringScanKey(u) with no srcUrl DEFAULTS to
            // the ring's current crown — for a profile that follows the
            // ring that's correct (p.sourceOrg === crown), but a
            // sourcePinned profile's source can differ from the crown, and
            // this preview must describe THIS profile's own source→target
            // flow, never a different pair wearing its label.
            rs = (p.ringScans || {})[(typeof _ringScanKey === 'function') ? _ringScanKey(u, p.sourceOrg) : ''] || null;
            // Freshest-wins with the native lastScan for the profile's own
            // pair — the chooser said "not scanned yet" while a fresh native
            // scan sat on lastScan (QA sweep 2026-08-11).
            // BOTH stamps, same as the ring matrix (studio-ring.js) — the
            // stamps exist precisely so consumers can detect a re-pointed
            // profile. Checking only sourceOrg let a lastScan measured
            // against the OLD primary target wear the NEW target's row
            // (QA sweep 2026-08-16: unticking the primary ring org or a
            // pin-mode target edit re-points p.targetOrg without clearing
            // lastScan).
            if (_orgKey(u) === _orgKey(p.targetOrg || '') && p.lastScan?.runAt
                && (!p.lastScan.sourceOrg || _orgKey(p.lastScan.sourceOrg) === _orgKey(p.sourceOrg || ''))
                && (!p.lastScan.targetOrg || _orgKey(p.lastScan.targetOrg) === _orgKey(p.targetOrg || ''))) {
              const nat = { runAt: p.lastScan.runAt,
                missing: (p.lastScan.missingInTarget || []).length,
                changed: (p.lastScan.changed || []).length,
                extra:   (p.lastScan.onlyInTarget || []).length,
                fileMiss: (p.lastScan.fileDrift && !p.lastScan.fileDrift.error && p.lastScan.fileDrift.records) || 0,
                ...(p.lastScan.fileDrift?.error ? { fileErr: true } : {}) };
              rs = (typeof sftkRingCellPick === 'function') ? sftkRingCellPick(nat, rs) : (rs || nat);
            }
          } catch (_) {}
          const drift = rs ? (rs.missing || 0) + (rs.changed || 0) + (rs.extra || 0) : null;
          // A FAILED file check must never read as "✓ in sync" — file state
          // is unknown, not zero (same contract as the Synced tab's error
          // line; QA sweep 2026-08-16).
          // A ring/native summary knows the ROOT only — with child objects on
          // the tree, an unqualified "✓ in sync" would overclaim (children
          // are verified by the child sections inside, never by these tiles).
          const kidQ = (p.tree?.children || []).length ? '✓ root in sync · children unverified' : '✓ in sync';
          const st = !rs ? 'not scanned yet'
            : drift === 0 ? (rs.fileMiss ? `📎 ${rs.fileMiss} missing files`
                : rs.fileErr ? '✓ fields in sync · 📎 file check failed' : kidQ)
            : `${rs.missing} missing · ${rs.changed} changed · ${rs.extra} extra`;
          return `<button class="ds-btn" style="display:flex;width:100%;margin:4px 0;justify-content:space-between;align-items:center" data-rec-target="${esc(u)}">
            <span>${esc(orgLabel(u))} ${prodBadge(u)}</span>
            <span style="font-size:11px;opacity:.75">${st}${rs?.runAt ? ` · ${timeAgo(rs.runAt)}` : ''}</span>
          </button>`;
        }).join('')}
      </div>
      <div class="ds-modal-footer"><button class="ds-btn" data-dsaction="closeModal">Cancel</button></div>`);
    document.querySelectorAll('[data-rec-target]').forEach(b =>
      b.addEventListener('click', () => { closeModal(); window.openReconcile(profileId, b.dataset.recTarget); }));
    return;
  }
  const tgt = targetUrl || tgts[0] || p.targetOrg;
  if (tgt && _orgKey(tgt) !== _orgKey(p.targetOrg || '')) {
    // Non-primary target → ephemeral clone, the org-compare pattern (same
    // as the ring's ⚖). The _ringOf stamp lets the post-run writeback and
    // ring tiles credit the REAL profile; the saved pair stays untouched.
    _reconcileProfile = { ...p, id: `pair_${Date.now()}_${p.id}`, _ringOf: { profileId: p.id },
      name: `${p.name} · ${orgLabel(p.sourceOrg)} → ${orgLabel(tgt)}`,
      targetOrg: tgt, lastScan: null, ringScans: undefined, ephemeral: true };
  } else {
    _reconcileProfile = p;
  }
  document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-view="profiles"]')?.classList.add('active');
  _currentView = 'reconcile';
  renderReconcile();
  if (_reconcileProfile.ephemeral && !_reconcileProfile.lastScan) {
    // Fresh pair → scan it now; the chokepoint's auto-reload repaints this
    // view (and deposits verdicts + ring tiles) when the scan lands.
    showToast(`Scanning ${orgLabel(tgt)}…`, 'info', 2500);
    window.refreshProfileState?.(_reconcileProfile.id);
  }
};

// Module-scope selection sets so re-renders (after an action) preserve picks
// where it makes sense. Reset when the profile changes.
// Reconcile selection state. Buckets:
//   push      — sourceIds, insert into target ("in source only")
//   overwrite — sourceIds, update TARGET with source values ("drift" →)
//   updSrc    — sourceIds, update SOURCE with target values ("drift" ←, 3B v2)
//   pull      — targetIds, insert into source ("in target only", Phase 3B)
//   del       — targetIds, delete from target ("in target only")
// Mutually exclusive pairs (picking one auto-clears the other):
//   overwrite/updSrc per drift row, pull/del per target-only row.
let _recSel = { push: new Set(), overwrite: new Set(), updSrc: new Set(), del: new Set(), pull: new Set() };
let _recLastProfileId = null;
// Auto-refresh guard: `${profileId}|${runId}` of the newest run already
// re-scanned for — pins the run id so a failing scan can't refresh-loop.
let _recAutoRefreshKey = '';
// ⛓ Parent-gap advisor cache — probe once per (profile, scan), reuse the
// rendered banner on repaints so navigation doesn't re-query the target.
let _recParentGapKey  = '';
let _recParentGapHtml = '';
// Auto-verify attempts — `${key}|${refObj}` scanned in the background once
// per (profile, scan); a failed scan falls back to the manual button
// instead of retrying forever.
let _recParentGapChecked = new Set();
// What the advisor's probe found for the CURRENT scan — consulted by
// runReconcile as a RUN GATE (user 2026-08-10: "the recommendation to sync
// parents first is not strong enough"): doomed = empty parent behind a
// REQUIRED field (inserts guaranteed to fail); empties = lookups that
// would land null. Keyed to profile+scan so a stale verdict never gates.
let _recParentGapState = null;   // { key, doomed: [obj], empties: [obj] }
// Session-wide sync verdicts: `${srcKey}|${tgtKey}|${objType}` → { missing,
// changed, extra, at }. EVERY fresh reconcile scan deposits its verdict here,
// and every surface that mentions a parent object reads it — so once the
// parents have been scanned anywhere, the Builder rows and the parents-first
// panel SHOW "✓ in sync" instead of making the user click to find out
// (user 2026-08-10: "since the parents are synced we need to show it").
let _parentSyncVerdicts = {};
function sftkParentSyncKey(srcOrg, tgtOrg, obj) {
  return `${sftkOrgKey(srcOrg)}|${sftkOrgKey(tgtOrg)}|${obj}`;
}
// Verdicts PERSIST (user 2026-08-10: "i want it to update after the correct
// insert of a parent tree", without clicking) — the flow is run → post-run
// auto-rescan → deposit → every later render shows it; storage makes that
// survive reloads, and saved profiles' lastScans hydrate pairs scanned in
// earlier sessions. Newest runAt wins everywhere.
let _parentSyncLoaded = false;
async function sftkParentSyncLoad() {
  if (_parentSyncLoaded) return;
  _parentSyncLoaded = true;
  try {
    const d = await chrome.storage.local.get('sftk_parent_sync');
    for (const [k, v] of Object.entries(d?.sftk_parent_sync || {})) {
      if (!_parentSyncVerdicts[k] || (v?.at || '') > (_parentSyncVerdicts[k].at || '')) _parentSyncVerdicts[k] = v;
    }
  } catch (_) { /* storage unavailable — session map still works */ }
  try {
    for (const pr of (_profiles || [])) {
      const s = pr?.lastScan;
      if (!s || s.status !== 'success' || !s.objectType) continue;
      const src = s.sourceOrg || pr.sourceOrg, tgt = s.targetOrg || pr.targetOrg;
      if (!src || !tgt) continue;
      const k = sftkParentSyncKey(src, tgt, s.objectType);
      if (!_parentSyncVerdicts[k] || (s.runAt || '') > (_parentSyncVerdicts[k].at || '')) {
        _parentSyncVerdicts[k] = { missing: (s.missingInTarget || []).length,
          changed: (s.changed || []).length, extra: (s.onlyInTarget || []).length, at: s.runAt };
      }
    }
  } catch (_) { /* hydration is best-effort */ }
}
function sftkParentSyncPut(srcOrg, tgtOrg, obj, v) {
  try {
    const k = sftkParentSyncKey(srcOrg, tgtOrg, obj);
    // Newest runAt wins EVERYWHERE — the two load paths above already
    // enforce this, but the runtime write path didn't, so re-rendering an
    // OLD reconcile (every accordion toggle re-renders) resurrected a stale
    // verdict over a fresher one — a stale "in sync" could green-light a
    // parents-first step whose parents were freshly missing (QA sweep
    // 2026-08-10). Ties keep the existing entry: same scan, same verdict.
    const prev = _parentSyncVerdicts[k];
    if (prev && (v?.at || '') <= (prev.at || '')) return;
    _parentSyncVerdicts[k] = v;
    chrome.storage.local.set({ sftk_parent_sync: _parentSyncVerdicts });
  } catch (_) { /* advisory map only */ }
}

// 🗂 "I want a new tab or something — show the ACTUAL records" (user
// 2026-08-11): the in-sync fold's key list wasn't enough. Opens the matched
// records as a real table — field VALUES read fresh from the source org
// (never from the scan snapshot), one row per pair, links to both orgs.
// Columns: the match key field(s) + up to 6 mapped fields; if a mapped field
// no longer exists the fetch falls back to key columns only.
async function sftkShowInSyncRecords(p, scan) {
  const rowsAll = (scan?.identical || []).filter(r => r.sourceId);
  const CAP = 500;
  const rows = rowsAll.slice(0, CAP);
  const tgtBySrc = {};
  rowsAll.forEach(r => { tgtBySrc[r.sourceId] = r.targetId; });
  const objType = scan?.objectType || p?.tree?.objectType || '';
  showModal(`
    <div class="ds-modal-header">🟢 In-sync records — ${esc(objType)} <span style="font-weight:400;font-size:12px;opacity:.75">${esc(orgLabel(p.sourceOrg))} ↔ ${esc(orgLabel(p.targetOrg))}</span></div>
    <div class="ds-modal-body" id="dsInSyncBody" style="max-height:62vh;overflow:auto;font-size:12px">Reading live values from the source org…</div>
    <div class="ds-modal-footer">
      <span style="margin-right:auto;font-size:11px;opacity:.75">${rowsAll.length > CAP ? `first ${CAP} of ${rowsAll.length} pairs — the scan count is the truth` : `${rowsAll.length} pair(s)`} · values are read LIVE, not replayed from the scan</span>
      <button class="ds-btn" data-dsaction="closeModal">Close</button>
    </div>`);
  const body = eid('dsInSyncBody');
  if (!body) return;
  try {
    const sess = await getOrgSession(p.sourceOrg);
    if (!sess?.sid) {
      body.innerHTML = `<div class="ds-drift-compare-err">Source org not open — open ${esc(orgLabel(p.sourceOrg))} in a Chrome tab.</div>`;
      return;
    }
    const keyFields = (scan?.matching?.fields?.length ? scan.matching.fields : [p?.tree?.matchField || 'Name']);
    const mapped = Object.keys(p?.tree?.fieldMappings || {}).filter(f => f && f !== 'Id').slice(0, 6);
    const wanted = [...new Set(['Id', ...keyFields, ...mapped])];
    const ids = rows.map(r => r.sourceId);
    const fetchWith = async (flds) => {
      const out = [];
      for (let i = 0; i < ids.length; i += 200) {
        const lit = ids.slice(i, i + 200).map(id => `'${id}'`).join(',');
        const q = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid,
          query: `SELECT ${flds.join(',')} FROM ${objType} WHERE Id IN (${lit})` });
        if (q?.error) throw new Error(q.error);
        out.push(...(q.records || []));
      }
      return out;
    };
    let used = wanted, recs;
    try { recs = await fetchWith(wanted); }
    catch (_) { used = [...new Set(['Id', ...keyFields])]; recs = await fetchWith(used); }
    const cols = used.filter(f => f !== 'Id');
    const cell = v => { const s = v == null ? '' : String(v); return `<td style="padding:3px 8px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(s)}">${esc(s)}</td>`; };
    const rhref = (org, id) => `${esc(String(org || '').replace(/\/$/, ''))}/lightning/r/${esc(id)}/view`;
    body.innerHTML = `<div style="overflow:auto"><table style="border-collapse:collapse;width:100%">
      <thead><tr>${cols.map(c => `<th style="text-align:left;padding:3px 8px;border-bottom:1px solid var(--border,#3A3F4B);position:sticky;top:0;background:var(--card,#20232B)">${esc(c)}</th>`).join('')}
        <th style="border-bottom:1px solid var(--border,#3A3F4B)"></th></tr></thead>
      <tbody>${recs.map(r => `<tr>
        ${cols.map(c => cell(r[c])).join('')}
        <td style="white-space:nowrap;padding:3px 8px"><a href="${rhref(p.sourceOrg, r.Id)}" target="_blank" rel="noopener">source ↗</a>${tgtBySrc[r.Id] ? ` · <a href="${rhref(p.targetOrg, tgtBySrc[r.Id])}" target="_blank" rel="noopener">target ↗</a>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>`;
  } catch (e) {
    body.innerHTML = `<div class="ds-drift-compare-err">Could not read the records: ${esc(e?.message || String(e))}</div>`;
  }
}

// 📎 Move the files SELECTED in the Synced tab — the direct path when the
// records are already in sync and only attachments differ ("you said run
// transfer but there's nothing to run", user 2026-08-11). Reuses the
// engine's file pass via SFTK_TRANSFER_FILES with a per-file checksum
// filter; the post-move rescan re-runs the file comparison so the tab
// tells the truth without another click.
let _fileMoveInFlight = false;
async function sftkMoveSelectedFiles(p, scan) {
  const fd = scan?.fileDrift;
  if (!fd || !_recFileSel.size) return;
  if (_fileMoveInFlight) return;   // checkbox handlers re-arm the button mid-flight
  // PII fail-closed — file bodies cannot be masked, so an active policy
  // blocks EVERY file write path, this direct move included (same gate the
  // engine's files pass and the relink path enforce; QA sweep 2026-08-16
  // found this path hard-coding piiActive=false).
  if (Object.keys(p?.piiPolicy || {}).length) {
    showToast('📎 blocked: a PII policy is active on this deployment and file bodies cannot be masked (fail-closed).', 'error', 6000);
    return;
  }
  // The scan must describe THIS pair — org identity, not object identity,
  // is what a crown move / ring-follow rewrite changes under an open view.
  if ((scan.sourceOrg && sftkOrgKey(scan.sourceOrg) !== sftkOrgKey(p.sourceOrg || ''))
      || (scan.targetOrg && sftkOrgKey(scan.targetOrg) !== sftkOrgKey(p.targetOrg || ''))) {
    showToast('📎 blocked: this file list came from a different org pair — rescan first.', 'error', 6000);
    return;
  }
  const idMap = {}; const only = {};
  for (const r of (fd.rows || [])) {
    for (const f of (r.files || [])) {
      if (_recFileSel.has(`${r.sourceId}|${f.checksum}`)) {
        idMap[r.sourceId] = r.targetId;
        (only[r.sourceId] = only[r.sourceId] || []).push(f.checksum);
      }
    }
  }
  if (!Object.keys(idMap).length) return;
  const btn = eid('dsRecMoveFiles');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ moving…'; }
  _fileMoveInFlight = true;
  try {
    const [srcSess, tgtSess] = await Promise.all([getOrgSession(p.sourceOrg), getOrgSession(p.targetOrg)]);
    if (!srcSess?.sid || !tgtSess?.sid) {
      showToast('Open both orgs in Chrome tabs to move files.', 'error', 5000);
      if (btn) { btn.disabled = false; btn.textContent = `📎 Move ${_recFileSel.size} selected`; }
      return;
    }
    const res = await sendBg({ type: 'SFTK_TRANSFER_FILES',
      objType: scan.objectType || p.tree?.objectType,
      srcOrgUrl: srcSess.orgUrl, srcSid: srcSess.sid,
      tgtOrgUrl: tgtSess.orgUrl, tgtSid: tgtSess.sid,
      piiActive: Object.keys(p?.piiPolicy || {}).length > 0,
      idMap, only });
    if (res?.error) throw new Error(res.error);
    const s = res?.stats || {};
    showToast(`📎 ${s.copied || 0} file(s) moved${s.linksCreated ? ` · ${s.linksCreated} link(s)` : ''}${s.skippedExisting ? ` · ${s.skippedExisting} already existed` : ''}${s.failed ? ` · ${s.failed} FAILED` : ''}`,
      s.failed ? 'warning' : 'success', 5500);
    _recFileSel.clear();
    await window.refreshProfileState?.(p.id);
    renderReconcile();
  } catch (e) {
    showToast(`📎 move failed: ${e?.message || String(e)}`, 'error', 6000);
    if (btn) { btn.disabled = false; btn.textContent = `📎 Move ${_recFileSel.size} selected`; }
  } finally {
    _fileMoveInFlight = false;
  }
}

// Ring tiles refresh from ANY fresh scan of the pair, not just from runs —
// the user aligned the orgs via console Apex + a manual re-scan and the
// ring kept showing a 44-minute-old "21" (2026-08-10: "still in sync but
// not in sync"). Guarded: only when the ring's golden source IS this
// profile's source, so a tile scanned from a different golden org is
// never overwritten.
function sftkRingTileFromScan(p) {
  try {
    const fs = p?.lastScan;
    if (!p || p.ephemeral || !fs || fs.status !== 'success' || !p.ringScans) return;
    if (typeof _ring === 'undefined' || !_ring?.sourceUrl) return;
    if (sftkOrgKey(_ring.sourceUrl) !== sftkOrgKey(p.sourceOrg)) return;
    if (typeof _ringScanKey !== 'function') return;
    const rk = _ringScanKey(p.targetOrg);
    if (!p.ringScans[rk]) return;
    // Freshest wins here too — a ▶ Sync Plan may have JUST written a newer
    // ringScans summary that this profile-scan deposit must not roll back
    // (QA sweep 2026-08-10; same law as sftkRingCellPick on the read side).
    const prev = p.ringScans[rk];
    if (prev.runAt && fs.runAt
        && new Date(prev.runAt).getTime() > new Date(fs.runAt).getTime()) return;
    p.ringScans[rk] = { runAt: fs.runAt,
      missing: (fs.missingInTarget || []).length,
      changed: (fs.changed || []).length,
      extra:   (fs.onlyInTarget || []).length,
      status:  'success',
      ...(fs.fileDrift && !fs.fileDrift.error && fs.fileDrift.records ? { fileMiss: fs.fileDrift.records } : {}),
      ...(fs.fileDrift?.error ? { fileErr: true } : {}) };
    storageSaveProfiles();
  } catch (_) { /* tile refresh is best-effort */ }
}
// Child-aware reconcile (v2: children + grandchildren; Insert, Relink,
// Overwrite drift, Delete extras). Selections and UI state are keyed by tree
// pathKey ('0', '1', '0.1' for grandchildren, …).
let _recChildSel      = {};   // pathKey → { push:Set(sourceIds), relink:Set(targetIds), overwrite:Set(sourceIds), del:Set(targetIds) }
let _recOrderOverride = {};   // pathKey → 'childFirst' (run-scoped; absent = node's own order)
let _recChildOpen     = {};   // pathKey → bool (accordion expanded)
// Delete mode for the reconcile "In target only" column.
//   'recycle' — DELETE → Recycle Bin (recoverable 15 days)
//   'hard'    — DELETE then SOAP emptyRecycleBin (permanent)
let _recDeleteMode = 'recycle';
// 📎 Synced-tab file selection — `${sourceId}|${checksum}` keys. Cleared
// after a successful move AND on profile switch (renderReconcile's reset
// block): the keys carry no target component, so pairs sharing a source
// org would otherwise inherit each other's selections.
let _recFileSel = new Set();

// ── T7 — phantom State/Country drift note ────────────────────────────────
// runDiffScan drops field differences where BOTH orgs hold the same
// `${field}Code` and only the label differs: the target org has State &
// Country Picklists enabled and rewrites the label from the code on every
// write. Those rows are in "in sync", NOT in drift — say so out loud, because
// silently hiding a difference is exactly the kind of thing that erodes trust.
function sftkPhantomDriftNote(scan) {
  const n = scan?.phantomFields || 0;
  if (!n) return '';
  return `<div class="ds-rec-child-info" style="border-left:3px solid #6366f1;padding-left:8px;margin:6px 0"
    title="Salesforce owns the State/Country LABEL when State &amp; Country Picklists are enabled: on every write it re-derives BillingState from BillingStateCode. If the source says 'TX' and the target labels that code 'Texas', pushing 'TX' is normalized straight back to 'Texas' — or rejected with &quot;There's a problem with this state…&quot;. The row would show as drift forever.">
    ≡ ${n} field difference${n === 1 ? '' : 's'} ignored — State/Country <strong>label</strong> rewritten by the target org
    (same underlying code on both sides). ${n === 1 ? 'It is' : 'They are'} not counted as drift because an overwrite
    could <strong>never</strong> make ${n === 1 ? 'it' : 'them'} converge — the target's State &amp; Country Picklists
    re-derive the label from the code on every write. Rows with no other differences are counted as in sync.
  </div>`;
}

// ── T6 — picklist readiness note (above the buckets) ─────────────────────
// scan.picklistGaps = [{ field, tgtField, missing[], missingTotal, affected,
// multi, restricted, valuesTruncated, distinctCapped }]. Every cap and every
// failure is stated; the check NEVER claims a clean bill of health it didn't
// earn (picklistGapsError = it couldn't run at all).
function sftkPicklistGapNote(scan, tgtOrgUrl, objectType) {
  if (!scan) return '';
  const gaps = scan.picklistGaps || [];
  const err  = scan.picklistGapsError;
  if (err) {
    return `<div class="ds-rec-child-info" style="border-left:3px solid #f59e0b;padding-left:8px;margin:6px 0">⚠ Picklist readiness could <strong>not</strong> be checked for ${esc(objectType || '')} (${esc(String(err))}) — this is inconclusive, not clean. A record can still fail on a missing picklist value.</div>`;
  }
  if (!gaps.length) return '';
  const cap    = scan.picklistGapsCap || null;
  const tgtLbl = typeof orgLabel === 'function' ? orgLabel(tgtOrgUrl || '') : String(tgtOrgUrl || 'the target org');
  const totalVals = gaps.reduce((a, g) => a + (g.missingTotal || (g.missing || []).length), 0);
  const rows = gaps.map((g, i) => {
    const shown  = g.missing || [];
    const more   = Math.max(0, (g.missingTotal || shown.length) - shown.length);
    const first  = shown[0] || '';
    const rename = g.field !== g.tgtField ? `<span class="ds-drift-compare-rename"> → ${esc(g.tgtField)}</span>` : '';
    const consequence = g.restricted
      ? 'restricted picklist — the write is rejected'
      : 'unrestricted picklist — Salesforce may accept the value but it will not appear in the list';
    return `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:4px 0 4px 4px">
      <code style="font-weight:600">${esc(g.field)}${rename}</code>
      <span style="color:var(--subtext)">${g.multi ? '(multi-select)' : ''}</span>
      <span>→ ${shown.map(v => `<span class="ds-diff-chip ds-diff-drift" style="margin-right:3px">${esc(v)}</span>`).join('')}${more ? `<span style="color:var(--subtext)">+${more} more</span>` : ''}</span>
      <span style="color:var(--subtext)">· ${g.affected} record(s) affected · ${esc(consequence)}</span>
      <button class="ds-btn ds-btn-xs" data-recpl-fix="${i}"
        data-pl-org="${esc(tgtOrgUrl || '')}" data-pl-obj="${esc(objectType || '')}"
        data-pl-field="${esc(g.tgtField || g.field)}" data-pl-value="${esc(first)}"
        title="Open the Picklist Manager on ${esc(tgtLbl)} for ${esc(objectType || '')}.${esc(g.tgtField || g.field)}, pre-filled with &quot;${esc(first)}&quot;.">🎚 Fix in Picklist Manager</button>
    </div>`;
  }).join('');
  const capNote = cap ? `<div style="color:var(--subtext);font-size:11.5px;margin-top:4px">
      Capped check — examined ${cap.fieldsExamined} of ${cap.fieldsTotal} picklist field(s) and ${cap.recordsExamined} of ${cap.recordsTotal} record(s);
      up to ${cap.valueCap} distinct value(s) per field, ${cap.reportCap} listed. There may be more gaps than shown.
    </div>` : '';
  return `<div class="ds-rec-child-info" style="border-left:3px solid #f59e0b;padding-left:8px;margin:6px 0">
    <div>⚠ <strong>${totalVals} value(s)</strong> used by these records don't exist in <strong>${esc(tgtLbl)}</strong>'s picklist — the records will fail or drop the field.</div>
    ${rows}
    <div style="color:var(--subtext);font-size:11.5px;margin-top:4px">Checked against the target's field-level picklist values only — record-type availability and dependent-picklist controlling values are <strong>not</strong> checked, so a listed value can still be unavailable to a given record type.</div>
    ${capNote}
  </div>`;
}

// Shared click wiring for every 🎚 Fix in Picklist Manager button on screen
// (root + child sections). window.sftkOpenPicklistFix is owned by the Picklist
// Manager; call it defensively — if it isn't loaded, say so instead of doing
// nothing.
function sftkWirePicklistFixButtons() {
  document.querySelectorAll('[data-recpl-fix]').forEach(btn => btn.addEventListener('click', (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    const arg = {
      orgUrl: btn.dataset.plOrg || '',
      object: btn.dataset.plObj || '',
      field:  btn.dataset.plField || '',
      value:  btn.dataset.plValue || ''
    };
    if (typeof window.sftkOpenPicklistFix !== 'function') {
      showToast('The Picklist Manager quick-fix isn\'t available in this build — open 🎚 Picklists from the sidebar and add the value manually.', 'warning', 7000);
      return;
    }
    try { window.sftkOpenPicklistFix(arg); }
    catch (e) { showToast(`Couldn't open the Picklist Manager: ${e?.message || e}`, 'error', 6000); }
  }));
}

async function renderReconcile() {
  const p = _reconcileProfile;
  if (!p) { renderProfiles(); return; }

  // Reset selection when switching to a different profile. _recFileSel MUST
  // reset here too: its keys are source-side only (`sourceId|checksum`), so
  // two pairs sharing a source org produce IDENTICAL keys — a selection made
  // for target A would render pre-checked and arm 📎 Move against target B
  // (QA sweep 2026-08-16, confirmed HIGH).
  if (_recLastProfileId !== p.id) {
    _recSel = { push: new Set(), overwrite: new Set(), updSrc: new Set(), del: new Set(), pull: new Set() };
    _recChildSel = {}; _recOrderOverride = {}; _recChildOpen = {};
    _recFileSel = new Set();
    _recLastProfileId = p.id;
  }

  const objType = p.tree?.objectType || p.tree?.childSObject || '?';
  const scan    = p.lastScan;
  // objectType check is SAFETY-critical, not cosmetic: if the profile's root
  // object changed after the last scan, the old scan's buckets carry record
  // Ids of a DIFFERENT object — and Delete passes those raw Ids to
  // SF_COLLECTIONS_DELETE, which deletes by Id regardless of type.
  // Org identity, not string identity — a crown move or ring-follow rewrite
  // can change the URL FORM of the same org and must not fake-stale the scan
  // (same trap the QA sweep confirmed in the ring deposits, 2026-08-10).
  const scanFresh = !!(
    scan && scan.status === 'success' &&
    (!scan.objectType || scan.objectType === objType) &&
    (!scan.sourceOrg || sftkOrgKey(scan.sourceOrg) === sftkOrgKey(p.sourceOrg || '')) &&
    (!scan.targetOrg || sftkOrgKey(scan.targetOrg) === sftkOrgKey(p.targetOrg || ''))
  );

  // 🎯 — how trustworthy this scan's matching was (fields + confidence %).
  const _acc = (scanFresh && typeof sftkScanAccuracy === 'function') ? sftkScanAccuracy(scan) : null;

  // Deposit this scan's verdict in the session sync map — the Builder's
  // lookup rows and other objects' parents-first panels read it.
  if (scanFresh) {
    sftkParentSyncPut(p.sourceOrg, p.targetOrg, objType, {
      missing: (scan.missingInTarget || []).length,
      changed: (scan.changed || []).length,
      extra:   (scan.onlyInTarget || []).length,
      at:      scan.runAt || new Date().toISOString(),
    });
    sftkRingTileFromScan(p);
  }

  // ⛓ Journey-back banner — this reconcile was opened as a PARENTS-FIRST
  // step for another deployment; once aligned, walk the user back to the
  // children (user 2026-08-10: "we deployed the parents. now we need to be
  // able to deploy the childrens and match them to their parents").
  let _journeyHtml = '';
  if (p._parentOf?.objType) {
    const aligned = scanFresh && !(scan.missingInTarget || []).length && !(scan.changed || []).length;
    const orig = _profiles.find(x => x.id === p._parentOf.profileId);
    _journeyHtml = `<div class="ds-op-banner" style="border-left:3px solid ${aligned ? '#16a34a' : 'var(--brand)'}">
      <span class="ds-op-banner-icon">⛓</span>
      <div class="ds-op-banner-body">
        <div class="ds-op-banner-title">${aligned ? '✓ Parents aligned' : 'Parents-first step'} — for <strong>${esc(p._parentOf.objType)}</strong></div>
        <div class="ds-op-banner-desc">${aligned
          ? `These records now exist in the target. Continue to the children: deploy <strong>${esc(p._parentOf.objType)}</strong> — its lookups match onto these records by name.`
          : `Align this object first (push missing, fix changed), then continue to <strong>${esc(p._parentOf.objType)}</strong>.`}
          ${orig ? ` <button class="ds-btn ds-btn-sm ${aligned ? 'ds-btn-primary' : ''}" id="dsRecJourneyBack" title="Back to the ${esc(p._parentOf.objType)} deployment — its view refreshes itself with these new parents in place.">→ Continue to ${esc(p._parentOf.objType)}</button>` : ''}
        </div>
      </div>
    </div>`;
  }

  // A run ANYWHERE that touched either org of this pair AFTER the scan makes
  // the stored buckets fiction — refresh WITHOUT being asked (user
  // 2026-08-09: "i need to see the current state updates after every run").
  // The stale view still paints first below so the page is never blank; the
  // fresh scan re-renders over it when it lands.
  if (scanFresh && scan.runAt) {
    let staleRun = null;
    try {
      const okey = u => sftkOrgKey(u);
      const pair = new Set([okey(p.sourceOrg), okey(p.targetOrg)]);
      for (let i = (_history || []).length - 1; i >= 0; i--) {
        const h = _history[i];
        const done = h && (h.completedAt || h.startedAt);
        if (done && done > scan.runAt &&
            (pair.has(okey(h.sourceOrg)) || pair.has(okey(h.targetOrg)))) { staleRun = h; break; }
      }
    } catch (_) { staleRun = null; }
    if (staleRun && _recAutoRefreshKey !== `${p.id}|${staleRun.id}`) {
      _recAutoRefreshKey = `${p.id}|${staleRun.id}`;
      showToast('↻ A run changed these orgs — refreshing state…', 'info', 2500);
      (async () => {
        try {
          await window.refreshProfileState(p.id);
          const _fp = _profiles.find(x => x.id === p.id);
          if (_fp) _reconcileProfile = _fp;
          if (_recLastProfileId === p.id) renderReconcile();
        } catch (_) { /* the stale view stays up — the 🔄 button still works */ }
      })();
    }
  }

  // Header with back link + refresh.
  const headerHtml = dsViewHeader({
    // 'swap' — records move between the two orgs named in the subtitle; no
    // sidebar row exists for this sub-page, so no nav glyph to mirror.
    icon: 'swap',
    back: `<button class="ds-back-link" id="dsRecBackBtn" title="Back to Data Deployment">‹ Back to deployments</button>`,
    title: `Reconcile — <span style="color:var(--brand)">${esc(objType)}</span>`,
    help: 'The repair shop of the compare trio, for ONE source → target pair. Every number here comes from the last 🔄 scan — a point-in-time measurement, matched by your match key, never by record Id. Each bucket has its own action: push what’s missing, overwrite what changed, relink children, review extras — nothing writes until you click its action. For the same picture across EVERY environment at once, use 🌳 Tree diff on the deployment card.',
    subtitle: `${esc(orgLabel(p.sourceOrg || ''))} → ${esc(orgLabel(p.targetOrg || ''))} ${prodBadge(p.targetOrg)}${scanFresh ? ` · scanned ${esc(timeAgo(scan.runAt))}` : ''}${scanFresh && scan.fetched ? ` · read ${scan.fetched.src} source / ${scan.fetched.tgt} target` : ''}${scanFresh && scan.where ? ` · <span class="ds-mm-chip" style="font-size:11px;padding:1px 7px;border-radius:9px;background:#fef3c7;color:#92400e" title="This WHERE scoped BOTH orgs' fetches — a record it excludes appears in NO bucket. Clear it in the builder's WHERE box if you expected that record here.">WHERE ${esc(scan.where)}</span>` : ''}${scanFresh && scan.memoryMatched ? ` · <span class="ds-mm-chip" style="font-size:11px;padding:1px 7px;border-radius:9px;background:#eef2ff;color:#4338ca;white-space:nowrap" title="${scan.memoryMatched} record pair(s) matched by remembered identity (match memory) instead of key — they survive renames on either side.">🧠 ${scan.memoryMatched} matched from memory</span>` : ''}${_acc ? ` · ${accuracyChip(_acc)}` : ''}`,
    actions: `${p.ephemeral ? `<button class="ds-btn ds-btn-sm ds-btn-primary" data-dsaction="saveEphemeralProfile"
          title="Keep this as a saved deployment — re-run it, retry failures, and track sync from the Data Deployment page. Right now it disappears when you leave this view.">💾 Save as deployment</button>` : ''}
        <button class="ds-btn ds-btn-sm" id="dsRecRefreshBtn">🔄 Refresh state</button>`,
  });

  if (!p.sourceOrg || !p.targetOrg) {
    setMain(`${headerHtml}
      <div class="ds-empty-page">
        <div class="ds-empty-icon">⚖</div>
        <div class="ds-empty-title">Set source and target orgs first</div>
        <div class="ds-empty-sub">Reconcile needs both orgs configured. Open the profile in <strong>✏ Edit</strong> to set them.</div>
      </div>`);
    eid('dsRecBackBtn')?.addEventListener('click', renderProfiles);
    return;
  }

  if (!scanFresh) {
    setMain(`${headerHtml}
      <div class="ds-empty-page">
        <div class="ds-empty-icon">🔄</div>
        <div class="ds-empty-title">${scan ? 'State is stale (orgs changed since last scan)' : 'No state captured yet'}</div>
        <div class="ds-empty-sub">Click <strong>🔄 Refresh state</strong> to compare the two orgs, then reconcile.</div>
        <div class="ds-empty-actions"><button class="ds-btn ds-btn-primary" id="dsRecRefreshBtn2">🔄 Refresh state</button></div>
      </div>`);
    eid('dsRecBackBtn')?.addEventListener('click', renderProfiles);
    const doRefresh = async () => { await window.refreshProfileState(p.id); const _fp = _profiles.find(x => x.id === p.id); if (_fp) _reconcileProfile = _fp; renderReconcile(); };
    eid('dsRecRefreshBtn')?.addEventListener('click', doRefresh);
    eid('dsRecRefreshBtn2')?.addEventListener('click', doRefresh);
    return;
  }

  const missing = scan.missingInTarget || [];   // {matchKey, sourceId}
  const drift   = scan.changed || [];           // {matchKey, sourceId, targetId}
  const extras  = scan.onlyInTarget || [];      // {matchKey, targetId}
  const inSync  = scan.identical || [];

  // L6 — every bucket count on this page goes through these two. The arrays
  // above are what the scan SHIPPED (capped at 5,000 each); `.length` is
  // therefore a floor whenever the scan hit that cap, and printing it bare
  // told the user "there are 5,000" when there were 47,213. capInfo reads the
  // totals the scan measured (or falls back to the length>=cap rule for a
  // scan stored before L6); capLbl turns them into the only wording allowed.
  // On a complete scan both collapse to the plain number this page always
  // showed, and capTitle returns '' so no tooltip is emitted.
  // (via window.* — studio-scan.js owns these builders and loads first; the
  // prefix keeps the reference resolvable to the linter's generated globals
  // map and degrades to the old plain count if the file ever fails to load.)
  const capInfo = k => (typeof window.sftkScanBucketInfo === 'function'
    ? window.sftkScanBucketInfo(scan, k)
    : { shown: (scan[k] || []).length, total: null, capped: false, totalIsFloor: false });
  const capLbl = (k, info) => {
    const i = info || capInfo(k);
    return typeof window.sftkBucketCountLabel === 'function'
      ? window.sftkBucketCountLabel(i.shown, i.total, i.capped, i.totalIsFloor)
      : String(i.shown);
  };
  const capTitle = (k, what, info) => {
    const i = info || capInfo(k);
    return typeof window.sftkBucketCapTitle === 'function'
      ? window.sftkBucketCapTitle(i.shown, i.total, i.capped, i.totalIsFloor, what)
      : '';
  };
  // Merge the cap disclosure into an existing tooltip instead of replacing it.
  const capAttr = (k, what, base) => {
    const t = capTitle(k, what);
    const full = [base || '', t].filter(Boolean).join(' — ');
    return full ? ` title="${esc(full)}"` : '';
  };

  // The page-level banner. Prefer the wording the scan already built; a scan
  // stored before L6 has no bucketCapNote, so rebuild it from the arrays it
  // does carry (sftkBucketCapNote falls back to the length>=cap rule). ''
  // when nothing was capped — no banner, no layout shift for a small org.
  let _recCapNote = '';
  try {
    _recCapNote = scan.bucketCapNote
      || (typeof window.sftkBucketCapNote === 'function' ? window.sftkBucketCapNote(scan, objType) : '');
  } catch (_) { _recCapNote = ''; }

  // M3a — composite match keys carry a U+0001 separator; render it as ' · '
  // (display only — the raw key stays the matching identity).
  const keyLbl = k => esc(typeof sftkMatchKeyLabel === 'function' ? sftkMatchKeyLabel(k) : String(k ?? ''));

  // ≈ near-match chip — this row's key differs from a record on the OTHER
  // side only by whitespace/case (scan near-miss pass). Acting on it as-is
  // duplicates or deletes the wrong thing, so the chip says why it didn't
  // match and both fixes.
  const nearChip = nm => nm ? `<span class="ds-rec-pnote ds-rec-pnote-missing" title="A ${nm.targetId ? 'target' : 'source'} record has the same key except for ${esc(nm.reason)} — exact matching kept them apart, so pushing would DUPLICATE (and deleting would strand the twin). Fix: enable Trim spaces / Case-insensitive under 🎯 Pick Records → Matching, or correct the value in one org.">≈ near match — ${esc(nm.reason)}</span>` : '';

  // W2-UI — 🔗 hand-pick lookup targets for one record (missing + changed
  // rows). Link opens a lazy panel (renderLkpOverridePanel); the badge is
  // how many picks the record carries for the CURRENT target org.
  const lkpN = id => Object.keys(sftkLkpOvGet(p.tree, p.targetOrg, id)).length;
  const lkpLink = (id, tgtId) => {
    if (!id) return '';
    const n = lkpN(id);
    return `<span class="ds-rec-drift-link${n ? ' ds-lkp-on' : ''}" data-rec-lkp="${esc(id)}"${tgtId ? ` data-rec-lkp-tgt="${esc(tgtId)}"` : ''} title="Hand-pick which TARGET record each lookup field should point at for THIS record — saved per target org, beats name-matching in the engine.">🔗<span class="ds-lkp-count">${n ? ` ${n}` : ''}</span></span>`;
  };
  const lkpExpand = id => id ? `<div class="ds-rec-drift-expand ds-rec-lkp-expand" data-lkp-expand="${esc(id)}" style="display:none"></div>` : '';

  // Default-select all missing + all drift for push (the common intent:
  // bring target up to match source). Extras default UNCHECKED — deletion
  // is destructive, opt-in only. Only seed defaults on first load.
  if (!_recSel.push.size && !_recSel.overwrite.size && !_recSel.updSrc.size && !_recSel.del.size && !_recSel.pull.size) {
    missing.forEach(r => r.sourceId && _recSel.push.add(r.sourceId));
    drift.forEach(r => r.sourceId && _recSel.overwrite.add(r.sourceId));
    // updSrc + Pull + Delete left empty — writing into SOURCE (or deleting)
    // is opt-in only; the default direction matches "bring target up to source".
  }

  // dml = the plain Salesforce operation this column performs (Insert/Update/
  // Delete). subtitle = the diff state that put records here. Leading with the
  // DML verb so it's obvious what ▶ Run reconcile will actually do.
  function colHtml(dml, subtitle, badgeClass, icon, items, kind, bucket) {
    const info = capInfo(bucket || 'missingInTarget');
    const rows = items.length ? items.map(r => {
      const id = kind === 'del' ? r.targetId : r.sourceId;
      const sel = _recSel[kind].has(id);
      return `<label class="ds-rec-col-row">
        <input type="checkbox" data-rec-kind="${kind}" data-rec-id="${esc(id)}" ${sel ? 'checked' : ''}>
        <span class="ds-rec-col-key" title="${keyLbl(r.matchKey)}">${keyLbl(r.matchKey)}</span>
        ${nearChip(r.nearMiss)}
        ${kind === 'overwrite' ? `<span class="ds-rec-drift-link" data-rec-drift="${esc(r.sourceId)}|${esc(r.targetId)}" title="See which fields differ">▸ fields</span>` : ''}
        ${kind === 'push' ? lkpLink(r.sourceId) : ''}
      </label>
      ${kind === 'push' ? lkpExpand(r.sourceId) : ''}
      ${kind === 'overwrite' ? `<div class="ds-rec-drift-expand" data-drift-expand="${esc(r.sourceId)}" style="display:none"></div>` : ''}`;
    }).join('') : `<div class="ds-rec-col-empty">none</div>`;
    return `
      <div class="ds-rec-col">
        <div class="ds-rec-col-hdr ${badgeClass}"${capAttr(bucket || 'missingInTarget', subtitle)}>
          ${icon} <strong>${dml} ${capLbl(bucket || 'missingInTarget', info)}</strong>
          <span class="ds-rec-col-sub">${subtitle}${info.capped ? ' · list truncated' : ''}</span>
        </div>
        <div class="ds-rec-col-actions">
          <button class="ds-btn ds-btn-xs" data-rec-all="${kind}"${info.capped ? ` title="Selects the ${capLbl(bucket || 'missingInTarget', { shown: info.shown, total: null, capped: false })} record(s) listed here — NOT every record in this bucket. The scan was truncated."` : ''}>✓ All</button>
          <button class="ds-btn ds-btn-xs" data-rec-none="${kind}">✗ None</button>
        </div>
        <div class="ds-rec-col-list">${rows}</div>
      </div>`;
  }

  // Drift column gets a per-row DIRECTION picker (Phase 3B v2): → Update
  // target with source values, or ← Update source with target values
  // (mutually exclusive; click the active one to skip the row). The "▸
  // fields" expander stays so the user can see the differing values before
  // picking a winner.
  function driftColHtml(items) {
    const empty = !items.length;
    const rows = empty ? `<div class="ds-rec-col-empty">none</div>` : items.map(r => {
      const sid = r.sourceId;
      const isPush = _recSel.overwrite.has(sid);
      const isPull = _recSel.updSrc.has(sid);
      // Inline "why is this drifted" — the scan already recorded which
      // fields differed (capped at 10); show the first few right on the row
      // so diagnosing drift doesn't require expanding each record.
      const why = (r.fields || []).length
        ? `<span class="ds-rec-drift-why" title="Differs on: ${esc(r.fields.join(', '))}">${esc(r.fields.slice(0, 3).join(', '))}${r.fields.length > 3 ? ` +${r.fields.length - 3}` : ''}</span>`
        : '';
      return `<div class="ds-rec-col-row ds-rec-row-drift">
        <span class="ds-rec-extra-actions">
          <button class="ds-rec-extra-btn ${isPush ? 'ds-rec-extra-on-push' : ''}"
                  data-rec-driftdir="overwrite" data-rec-id="${esc(sid)}"
                  title="Update the TARGET record with the source's values">→</button>
          <button class="ds-rec-extra-btn ${isPull ? 'ds-rec-extra-on-pull' : ''}"
                  data-rec-driftdir="updSrc" data-rec-id="${esc(sid)}"
                  title="Update the SOURCE record with the target's values">←</button>
        </span>
        <span class="ds-rec-col-key" title="${keyLbl(r.matchKey)}">${keyLbl(r.matchKey)}</span>
        ${why}
        <span class="ds-rec-drift-link" data-rec-drift="${esc(r.sourceId)}|${esc(r.targetId)}" title="See which fields differ">▸ fields</span>
        ${lkpLink(sid, r.targetId)}
      </div>
      ${lkpExpand(sid)}
      <div class="ds-rec-drift-expand" data-drift-expand="${esc(r.sourceId)}" style="display:none"></div>`;
    }).join('');
    const pushCount = items.filter(r => _recSel.overwrite.has(r.sourceId)).length;
    const pullCount = items.filter(r => _recSel.updSrc.has(r.sourceId)).length;
    const info = capInfo('changed');
    return `
      <div class="ds-rec-col">
        <div class="ds-rec-col-hdr ds-diff-drift"${capAttr('changed', 'changed')}>
          🟡 <strong>Changed ${capLbl('changed', info)}</strong>
          <span class="ds-rec-col-sub">values differ — pick a winner per row${info.capped ? ' · list truncated' : ''}</span>
        </div>
        <div class="ds-rec-col-actions ds-rec-col-actions-extra">
          <button class="ds-btn ds-btn-xs" data-rec-driftdir-all="overwrite" title="Source wins everywhere — update all target records">→ all</button>
          <button class="ds-btn ds-btn-xs" data-rec-driftdir-all="updSrc" title="Target wins everywhere — update all source records">← all</button>
          <button class="ds-btn ds-btn-xs" data-rec-driftdir-clear="1">✗ None</button>
        </div>
        ${empty ? '' : `<div class="ds-rec-extra-subcounts ds-rec-drift-subcounts">
          <span class="ds-rec-drift-sub-push">→ ${pushCount} to target</span>
          <span class="ds-rec-extra-sub-pull">← ${pullCount} to source</span>
          <span class="ds-rec-extra-sub-skip">${items.length - pushCount - pullCount} skipped</span>
        </div>`}
        <div class="ds-rec-col-list">${rows}</div>
      </div>`;
  }

  // "In target only" column gets per-row action picker: Skip / ← Pull /
  // 🗑 Delete (mutually exclusive). Phase 3B — bidirectional reconcile.
  // The whole column header doesn't say "Delete" anymore because rows can
  // go either way, so we split the count by what's currently selected.
  function extrasColHtml(items) {
    const empty = !items.length;
    const rows = empty ? `<div class="ds-rec-col-empty">none</div>` : items.map(r => {
      const tgtId = r.targetId;
      const isPull = _recSel.pull.has(tgtId);
      const isDel  = _recSel.del.has(tgtId);
      return `<div class="ds-rec-col-row ds-rec-row-extra">
        <span class="ds-rec-extra-actions">
          <button class="ds-rec-extra-btn ${isPull ? 'ds-rec-extra-on-pull' : ''}"
                  data-rec-extra="pull" data-rec-id="${esc(tgtId)}"
                  title="Pull this record into the source org">← Pull</button>
          <button class="ds-rec-extra-btn ${isDel ? 'ds-rec-extra-on-del' : ''}"
                  data-rec-extra="del" data-rec-id="${esc(tgtId)}"
                  title="Delete this record from the target org">🗑 Delete</button>
        </span>
        <span class="ds-rec-col-key" title="${keyLbl(r.matchKey)}">${keyLbl(r.matchKey)}</span>
      </div>`;
    }).join('');
    const pullCount = items.filter(r => _recSel.pull.has(r.targetId)).length;
    const delCount  = items.filter(r => _recSel.del.has(r.targetId)).length;
    const info = capInfo('onlyInTarget');
    return `
      <div class="ds-rec-col">
        <div class="ds-rec-col-hdr ds-diff-extra"${capAttr('onlyInTarget', 'in target only')}>
          🔵 <strong>In target only ${capLbl('onlyInTarget', info)}</strong>
          <span class="ds-rec-col-sub">pick an action per row${info.capped ? ' · list truncated' : ''}</span>
        </div>
        <div class="ds-rec-col-actions ds-rec-col-actions-extra">
          <button class="ds-btn ds-btn-xs" data-rec-extra-all="pull" title="Pull all">← Pull all</button>
          <button class="ds-btn ds-btn-xs" data-rec-extra-all="del"  title="Delete all">🗑 Delete all</button>
          <button class="ds-btn ds-btn-xs" data-rec-extra-clear="1">✗ None</button>
        </div>
        ${empty ? '' : `<div class="ds-rec-extra-subcounts">
          <span class="ds-rec-extra-sub-pull">← ${pullCount} to pull</span>
          <span class="ds-rec-extra-sub-del">🗑 ${delCount} to delete</span>
          <span class="ds-rec-extra-sub-skip">${items.length - pullCount - delCount} skipped</span>
        </div>`}
        <div class="ds-rec-col-list">${rows}</div>
      </div>`;
  }

  // ── 🟢 SYNCED column (user 2026-08-11: "i want the synced in a tab named
  // synced like the tabs in red yellow and blue") — the fourth bucket:
  // verified-matching pairs with links, the 🗂 live-values table, and the
  // 📎 file-drift block where every missing file is a SELECTABLE row with a
  // direct "Move selected" action — no Run detour when the buckets are
  // empty and only attachments differ.
  function syncedColHtml(items, scan, p) {
    const fd = scan.fileDrift;
    const info = capInfo('identical');
    const fileRows = (fd && !fd.error) ? (fd.rows || []) : [];
    const missByRec = {};
    fileRows.forEach(r => { missByRec[r.sourceId] = r; });
    const rhref = (org, id) => `${esc(String(org || '').replace(/\/$/, ''))}/lightning/r/${esc(id)}/view`;
    const empty = !items.length;
    const rows = empty ? `<div class="ds-rec-col-empty">none</div>` : items.map(r => `
      <div class="ds-rec-col-row ds-rec-row-sync">
        <span class="ds-rec-col-key" title="${keyLbl(r.matchKey)}">${missByRec[r.sourceId] ? '📎 ' : ''}${keyLbl(r.matchKey)}</span>
        <span style="margin-left:auto;white-space:nowrap;font-size:11px">
          <a href="${rhref(p.sourceOrg, r.sourceId)}" target="_blank" rel="noopener">src</a> ·
          <a href="${rhref(p.targetOrg, r.targetId)}" target="_blank" rel="noopener">tgt</a></span>
      </div>`).join('');
    let filesHtml = '';
    if (fd?.error) {
      filesHtml = `<div style="margin:4px 8px;font-size:11.5px">📎 file check failed (${esc(fd.error)}) — differences are UNKNOWN, not zero.</div>`;
    } else if (fd && !fd.records) {
      filesHtml = `<div style="margin:4px 8px;font-size:11px;opacity:.75">📎 files verified for ${fd.pairsChecked} pair(s) — none missing.${fd.extraFiles ? `<br>ℹ the target holds ${fd.extraFiles} file(s) on ${fd.extraRecords} matched record(s) that the source doesn't — not drift (a push never deletes files), listed so it can't hide.` : ''}</div>`;
    } else if (fd) {
      const selCount = _recFileSel.size;
      filesHtml = `<div class="ds-rec-files-block" style="margin:4px 6px;padding:6px;border:1px solid var(--c-warn-border,#6B4A15);border-radius:6px">
        <div style="font-size:12px;margin-bottom:4px">📎 <strong>${fd.missingFiles} file(s)</strong> in <strong>${esc(orgLabel(p.sourceOrg))}</strong> that <strong>${esc(orgLabel(p.targetOrg))}</strong> doesn't have${fd.capped ? ` · first ${fd.pairsChecked} of ${fd.pairsTotal} pairs checked` : ''} — select &amp; move:</div>
        <div style="max-height:200px;overflow-y:auto;min-height:0;scrollbar-width:thin">
        ${fileRows.slice(0, 100).map(r => (r.files || []).map(f => {
          const k = `${r.sourceId}|${f.checksum}`;
          return `<label style="display:flex;gap:6px;align-items:center;font-size:12px;padding:1px 0;cursor:pointer">
            <input type="checkbox" data-rec-fsel="${esc(k)}" ${_recFileSel.has(k) ? 'checked' : ''}>
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(f.title || f.checksum)}">${esc(f.title || '(untitled)')}</span>
            <a href="${rhref(p.sourceOrg, r.sourceId)}" target="_blank" rel="noopener" style="margin-left:auto;font-size:11px;white-space:nowrap">record ↗</a>
          </label>`;
        }).join('')).join('')}
        ${fd.records > 100 ? `<div style="font-size:11px;opacity:.7">…more records with missing files beyond the first 100 shown.</div>` : ''}
        </div>
        <div style="display:flex;gap:6px;margin-top:5px;flex-wrap:wrap">
          <button class="ds-btn ds-btn-xs" data-rec-fsel-all="1">✓ All</button>
          <button class="ds-btn ds-btn-xs" data-rec-fsel-none="1">✗ None</button>
          <button class="ds-btn ds-btn-xs ds-btn-primary" id="dsRecMoveFiles" ${selCount ? '' : 'disabled'}
            title="Copy the selected files (latest versions) onto their matched target records — checksum skip keeps this idempotent">📎 Move ${selCount || ''} selected</button>
        </div>
        ${fd.extraFiles ? `<div style="font-size:11px;opacity:.75;margin-top:4px">ℹ the target also holds ${fd.extraFiles} file(s) on ${fd.extraRecords} matched record(s) that the source doesn't — not drift (a push never deletes files), said so it can't hide.</div>` : ''}
      </div>`;
    } else if (items.length && !p?.tree?.includeFiles) {
      filesHtml = `<div style="margin:4px 8px;font-size:11px;opacity:.75">📎 files not compared — toggle 📎 Files on this object in the Builder, rescan, and missing attachments appear here.</div>`;
    }
    return `
      <div class="ds-rec-col">
        <div class="ds-rec-col-hdr ds-diff-sync"${capAttr('identical', 'synced')}>
          🟢 <strong>Synced ${capLbl('identical', info)}</strong>
          <span class="ds-rec-col-sub">${fd && fd.records
            ? `📎 ${fd.records} matched record(s) missing files — not fully synced`
            : `verified matching${info.capped ? ' · list truncated' : ''}`}</span>
        </div>
        <div class="ds-rec-col-actions">
          <button class="ds-btn ds-btn-xs" id="dsInSyncTableBtn"
            title="Open these records as a table — field values read LIVE from the source org, links to both orgs">🗂 Table</button>
        </div>
        ${filesHtml}
        <div class="ds-rec-col-list">${rows}</div>
      </div>`;
  }

  // ── Child-aware reconcile (v1) — direct children of the root ──────────
  // Each child renders as a collapsible section: Scan → buckets. Actionable
  // in v1: Insert (delegates to the transfer engine, which handles ordering
  // — child-first hoisting — scoping and the reconnect step) and ⇄ Relink
  // (re-point an existing child at the parent the source says it belongs
  // to). Drift / target-only counts show for awareness.
  const rootChildren = p.tree?.children || [];
  function childSel(pathKey) {
    if (!_recChildSel[pathKey]) _recChildSel[pathKey] = { push: new Set(), relink: new Set(), overwrite: new Set(), del: new Set() };
    const s = _recChildSel[pathKey];
    // R4 — backfill the v2 sets on state created before this session's render.
    if (!s.overwrite) s.overwrite = new Set();
    if (!s.del)       s.del       = new Set();
    return s;
  }
  // Parent status from the ROOT scan — annotates child Insert rows.
  const rootMissingBySrc = new Set(missing.map(r => r.sourceId));
  const rootExistsSrc    = new Set([...drift.map(r => r.sourceId), ...inSync.map(r => r.sourceId)]);

  // L6 — the same three helpers as the root, bound to a CHILD scan result.
  // Child scans ship with the identical 5,000-row caps (linkMismatch 2,000),
  // so every count in a child section had the same "floor printed as total"
  // bug the root did.
  const csInfo = (cs, k) => (typeof window.sftkScanBucketInfo === 'function'
    ? window.sftkScanBucketInfo(cs, k)
    : { shown: (cs?.[k] || []).length, total: null, capped: false, totalIsFloor: false });
  const csLbl = (cs, k) => {
    const i = csInfo(cs, k);
    return typeof window.sftkBucketCountLabel === 'function'
      ? window.sftkBucketCountLabel(i.shown, i.total, i.capped, i.totalIsFloor)
      : String(i.shown);
  };
  const csAttr = (cs, k, what, base) => {
    const i = csInfo(cs, k);
    const t = typeof window.sftkBucketCapTitle === 'function'
      ? window.sftkBucketCapTitle(i.shown, i.total, i.capped, i.totalIsFloor, what) : '';
    const full = [base || '', t].filter(Boolean).join(' — ');
    return full ? ` title="${esc(full)}"` : '';
  };

  function childBucketsHtml(node, pathKey, cs, sel, pMissingSet, pExistsSet, depth) {
    pMissingSet = pMissingSet || rootMissingBySrc;
    pExistsSet  = pExistsSet  || rootExistsSrc;
    depth       = depth || 1;
    // Insert bucket readability (user 2026-08-17: "the view there of the
    // child is kinda messy"). Three rules:
    //   1. GROUPING — past 30 rows, records collapse under their parent
    //      (the picker's W3 pattern); the parent chip lives ONCE on the
    //      group header instead of once per row. The state is derived from
    //      the PARENT, so every row in a group shares it by construction.
    //   2. EXCEPTION-ONLY CHIPS — when ≥90% of rows share one parent state,
    //      that state is said ONCE in a banner and chips mark only the
    //      outliers. 1,850 identical amber chips are one fact, not 1,850.
    //   3. LIVE COUNT — the actions row carries "n/N selected" (wired in
    //      the recc handlers below).
    const mRows = cs.missingInTarget || [];
    const rowState = r => {
      if (!r.parentSrcId) return 'none';
      if (pMissingSet.has(r.parentSrcId)) return depth > 1 ? 'deepblock' : 'missing';
      if (pExistsSet.has(r.parentSrcId)) return 'exists';
      return 'untracked';
    };
    const chipFor = (st, r) => st === 'none'
      ? `<span class="ds-rec-pnote ds-rec-pnote-none" title="No parent in the source either — inserts unlinked.">no parent</span>`
      : st === 'deepblock'
        ? `<span class="ds-rec-pnote ds-rec-pnote-unknown" title="Its parent is missing in the target too, and tree-ride inserts aren't supported at this depth (v2) — insert the parent level first, rescan this section, then insert this row.">parent ${esc(r.parentKey || '?')} ✗ missing — insert parent level first</span>`
        : st === 'missing'
          ? `<span class="ds-rec-pnote ds-rec-pnote-missing" title="Its parent is missing in the target too — selecting this row also inserts the parent (added automatically at run time).">parent ${esc(r.parentKey || '?')} ✗ missing</span>`
          : st === 'exists'
            ? `<span class="ds-rec-pnote ds-rec-pnote-ok" title="Its parent already exists in the target — this record attaches to it at insert, matched by the parent's key.">parent ${esc(r.parentKey || '?')} ✓ exists</span>`
            : `<span class="ds-rec-pnote ds-rec-pnote-unknown" title="Its parent isn't tracked by the ${depth > 1 ? 'parent child scan' : 'root scan'} (outside its scope or a key collision) — can't be safely inserted.">parent untracked</span>`;
    const stCount = {};
    for (const r of mRows) { const s = rowState(r); stCount[s] = (stCount[s] || 0) + 1; }
    const domEntry = Object.entries(stCount).sort((a, b) => b[1] - a[1])[0] || null;
    const domState = (mRows.length >= 20 && domEntry && domEntry[1] / mRows.length >= 0.9
      && (domEntry[0] === 'missing' || domEntry[0] === 'exists')) ? domEntry[0] : null;
    const pnoteBanner = domState
      ? `<div class="ds-rec-child-info ds-rec-pnote-banner">ℹ ${domEntry[1] === mRows.length ? `all ${mRows.length}` : `${domEntry[1]} of ${mRows.length}`} record(s): ${domState === 'missing'
          ? 'their parents are missing in the target too — selecting a record also inserts its parent automatically at run time'
          : 'their parents already exist in the target — records attach at insert, matched by the parent\'s key'}.${domEntry[1] === mRows.length ? '' : ' Chips below mark only the exceptions.'}</div>`
      : '';
    const selectableN = mRows.filter(r => { const s = rowState(r); return s !== 'deepblock' && s !== 'untracked'; }).length;
    const rowHtml = (r, st, withChip) => {
      const disabled = st === 'deepblock' || st === 'untracked';
      return `<label class="ds-rec-col-row ${disabled ? 'ds-rec-row-disabled' : ''}">
        <input type="checkbox" data-recc-push="${pathKey}" data-rec-id="${esc(r.sourceId)}" data-rec-pgroup="${esc(r.parentSrcId || '')}" ${!disabled && sel.push.has(r.sourceId) ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
        <span class="ds-rec-col-key" title="${keyLbl(r.matchKey)}">${keyLbl(r.matchKey)}</span>
        ${nearChip(r.nearMiss)}
        ${withChip ? chipFor(st, r) : ''}
      </label>`;
    };
    const distinctParents = new Set(mRows.map(r => r.parentSrcId || '')).size;
    let missingRows;
    if (mRows.length >= 30 && distinctParents > 1) {
      const groups = new Map();   // parentSrcId → { label, state, rows }
      for (const r of mRows) {
        const gid = r.parentSrcId || '';
        if (!groups.has(gid)) groups.set(gid, { label: r.parentKey || (gid ? '?' : '(no parent)'), state: rowState(r), rows: [] });
        groups.get(gid).rows.push(r);
      }
      const openAttr = groups.size <= 6 ? ' open' : '';
      missingRows = [...groups.entries()].map(([gid, g]) => {
        const gDisabled = g.state === 'deepblock' || g.state === 'untracked';
        return `<details class="ds-rec-pgroup"${openAttr}>
          <summary class="ds-rec-pgroup-sum">
            <button type="button" class="ds-btn ds-btn-xs" data-recc-gall="${pathKey}" data-rec-pgroup="${esc(gid)}" ${gDisabled ? 'disabled' : ''} title="Select every listed record under this parent">✓</button>
            <button type="button" class="ds-btn ds-btn-xs" data-recc-gnone="${pathKey}" data-rec-pgroup="${esc(gid)}" title="Unselect this parent's records">✗</button>
            <strong class="ds-rec-pgroup-name">${esc(g.label)}</strong>
            <span class="ds-rec-pgroup-cnt">${g.rows.length} record(s)</span>
            ${g.state !== domState ? chipFor(g.state, g.rows[0]) : ''}
          </summary>
          ${g.rows.map(r => rowHtml(r, g.state, false)).join('')}
        </details>`;
      }).join('');
    } else {
      missingRows = mRows.map(r => { const st = rowState(r); return rowHtml(r, st, st !== domState); }).join('') || `<div class="ds-rec-col-empty">none</div>`;
    }

    // R2 — master-detail links can be re-parented only when the field is
    // reparentable (updateable on the describe). Otherwise disable Relink
    // and say why.
    const relinkBlocked = !!(cs.linkMasterDetail && cs.linkUpdateable === false);
    const relinkBlockTitle = `${esc(node.field || 'The link')} is a master-detail relationship that isn't reparentable — Salesforce blocks changing it after insert, so Relink can't run. Enable 'Allow reparenting' on the field, or recreate the record under the right parent.`;
    const linkRows = (cs.linkMismatch || []).map(r => {
      const on = !relinkBlocked && sel.relink.has(r.targetId);
      return `<div class="ds-rec-col-row ds-rec-row-link">
        <button class="ds-rec-extra-btn ${on ? 'ds-rec-extra-on-push' : ''}" data-recc-relink="${pathKey}" data-rec-id="${esc(r.targetId)}" ${relinkBlocked ? 'disabled' : ''}
          title="${relinkBlocked ? relinkBlockTitle : `Update this target record so ${esc(node.field || 'its parent link')} points at the parent the source says it belongs to. This is a real update — the child's triggers/flows fire.`}">⇄ Relink</button>
        <span class="ds-rec-col-key" title="${keyLbl(r.matchKey)}">${keyLbl(r.matchKey)}</span>
        <span class="ds-rec-link-detail" title="currently → should be">${esc(r.parentKeyTgt || '∅')} → ${esc(r.parentKeySrc || '∅')}</span>
      </div>`;
    }).join('') || `<div class="ds-rec-col-empty">none</div>`;

    // R4 — child drift rows get the same → overwrite picker the root has
    // (source values win; no ← for children in v2).
    const driftRows = (cs.changed || []).map(r => {
      const on = sel.overwrite.has(r.sourceId);
      const why = (r.fields || []).length
        ? `<span class="ds-rec-drift-why" title="Differs on: ${esc(r.fields.join(', '))}">${esc(r.fields.slice(0, 3).join(', '))}${r.fields.length > 3 ? ` +${r.fields.length - 3}` : ''}</span>`
        : '';
      return `<div class="ds-rec-col-row ds-rec-row-drift">
        <button class="ds-rec-extra-btn ${on ? 'ds-rec-extra-on-push' : ''}" data-recc-ovw="${pathKey}" data-rec-id="${esc(r.sourceId)}"
          title="Update the TARGET record with the source's values (fields from this node's field mapping)">→</button>
        <span class="ds-rec-col-key" title="${keyLbl(r.matchKey)}">${keyLbl(r.matchKey)}</span>
        ${why}
      </div>`;
    }).join('') || `<div class="ds-rec-col-empty">none</div>`;

    // R4 — child target-only rows get a 🗑 delete picker. R3 — rows whose
    // link field is NULL in the target are tagged "possible orphan" and are
    // excluded from 🗑 All by default (individually selectable).
    const orphanN = (cs.onlyInTarget || []).filter(r => r.orphan).length;
    const extraRows = (cs.onlyInTarget || []).map(r => {
      const on = sel.del.has(r.targetId);
      return `<div class="ds-rec-col-row ds-rec-row-extra">
        <button class="ds-rec-extra-btn ${on ? 'ds-rec-extra-on-del' : ''}" data-recc-del="${pathKey}" data-rec-id="${esc(r.targetId)}"
          title="Delete this record from the target org (honors the Delete mode below)">🗑</button>
        <span class="ds-rec-col-key" title="${keyLbl(r.matchKey)}">${keyLbl(r.matchKey)}</span>
        ${r.orphan ? `<span class="ds-rec-pnote ds-rec-pnote-unknown" title="Its ${esc(node.field || 'link')} field is empty in the target — a prior partial run may have created it, then failed to reconnect it. ⇄ Relink can re-attach it to the right parent instead of deleting. Excluded from '🗑 All' — select it individually if you're sure.">⚠ orphan</span>` : ''}
      </div>`;
    }).join('') || `<div class="ds-rec-col-empty">none</div>`;

    // R1 — rows sharing duplicate match keys were excluded from every bucket.
    const collisionNote = cs.keyCollisions
      ? `<div class="ds-rec-child-info" style="border-left:3px solid #f59e0b;padding-left:8px" title="Duplicate keys: ${esc((cs.keyCollisions.keys || []).slice(0, 10).map(k => typeof sftkMatchKeyLabel === 'function' ? sftkMatchKeyLabel(k) : k).join(', '))}">⚠ ${cs.keyCollisions.rows} row(s) share duplicate match keys — excluded from all actions; pick a better match field in the profile (e.g. an external Id).</div>`
      : '';
    // M3a — rows whose match key was blank (every component empty) are
    // unmatchable and were excluded from every bucket. Counted, not hidden.
    const nearNote = cs.nearMisses
      ? `<div class="ds-rec-child-info" style="border-left:3px solid #f59e0b;padding-left:8px">≈ ${cs.nearMisses} record pair(s) almost matched — their keys differ only by whitespace/case (marked ≈ on the rows). Enable Trim spaces / Case-insensitive in 🎯 Pick Records → Matching, or fix the values, then rescan.</div>`
      : '';
    const blankNote = cs.blankKeys
      ? `<div class="ds-rec-child-info ds-match-blank-note" style="border-left:3px solid #f59e0b;padding-left:8px">⚠ ${cs.blankKeys.rows} row(s) have a blank match key — excluded from all actions (${cs.blankKeys.src} source, ${cs.blankKeys.tgt} target). Pick a better-populated match field, or use 🧪 Test this key in Pick Records.</div>`
      : '';
    // R3 — the possible-orphan probe reads ONE page of the target. When that
    // page was a cap (or the probe failed outright) the scan hands us the
    // wording; rendering it is not optional — without it the orphan count
    // below reads as a total when it is only a floor.
    const orphanNote = cs.orphanNote
      ? `<div class="ds-rec-child-info" style="border-left:3px solid #f59e0b;padding-left:8px">${esc(cs.orphanNote)}</div>`
      : '';
    // L6 — this child scan's own buckets hit their ship cap. Same contract as
    // orphanNote: the scan hands over the wording, rendering it is mandatory.
    let _csCapText = '';
    try {
      _csCapText = cs.bucketCapNote
        || (typeof window.sftkBucketCapNote === 'function'
          ? window.sftkBucketCapNote(cs, node.objectType || node.childSObject || '') : '');
    } catch (_) { _csCapText = ''; }
    const capNote = _csCapText
      ? `<div class="ds-rec-child-info ds-rec-cap-note" style="border-left:3px solid #f59e0b;padding-left:8px">${esc(_csCapText)}</div>`
      : '';
    // L6 — and the harder one: this scan was SCOPED to the parent ids the
    // parent scan listed, and that scan was truncated. Rows under the parents
    // past the cap were never queried, so nothing below is a total — and no
    // number in this section would ever hint at it.
    const scopeNote = cs.parentScopeNote
      ? `<div class="ds-rec-child-info ds-rec-scope-note" style="border-left:3px solid #dc2626;padding-left:8px">${esc(cs.parentScopeNote)}</div>`
      : '';

    // T6/T7 — same readiness + phantom notes the root gets, for this child's
    // own object and its own scan result.
    const childObj = node.objectType || node.childSObject || '';
    let plNote = '', phNote = '';
    try {
      plNote = sftkPicklistGapNote(cs, p.targetOrg, childObj);
      phNote = sftkPhantomDriftNote(cs);
    } catch (_) { plNote = ''; phNote = ''; }

    return `
    <div class="ds-rec-child-body">
      ${scopeNote}${capNote}${collisionNote}${nearNote}${blankNote}${orphanNote}${plNote}${phNote}
      <div class="ds-rec-cols ds-rec-cols-child">
        <div class="ds-rec-col">
          <div class="ds-rec-col-hdr ds-diff-missing"${csAttr(cs, 'missingInTarget', 'in source only')}>🔴 <strong>Insert ${csLbl(cs, 'missingInTarget')}</strong>
            <span class="ds-rec-col-sub">in source only${csInfo(cs, 'missingInTarget').capped ? ' · list truncated' : ''}</span></div>
          <div class="ds-rec-col-actions">
            <button class="ds-btn ds-btn-xs" data-recc-all="${pathKey}"${csInfo(cs, 'missingInTarget').capped ? ` title="Selects the ${csInfo(cs, 'missingInTarget').shown} record(s) listed here — NOT every record in this bucket. The scan was truncated."` : ''}>✓ All</button>
            <button class="ds-btn ds-btn-xs" data-recc-none="${pathKey}">✗ None</button>
            <span class="ds-rec-selcount" data-recc-count="${pathKey}">${sel.push.size}/${selectableN} selected</span>
          </div>
          ${pnoteBanner}
          <div class="ds-rec-col-list">${missingRows}</div>
        </div>
        <div class="ds-rec-col">
          <div class="ds-rec-col-hdr ds-rec-chip-link"${csAttr(cs, 'linkMismatch', 'link differs')}>🔗 <strong>Link differs ${csLbl(cs, 'linkMismatch')}</strong>
            <span class="ds-rec-col-sub">${relinkBlocked ? 'master-detail — not reparentable' : cs.linkTrackable ? 'same record, different parent' : 'link not trackable for this relationship'}${csInfo(cs, 'linkMismatch').capped ? ' · list truncated' : ''}</span></div>
          <div class="ds-rec-col-actions">
            <button class="ds-btn ds-btn-xs" data-recc-relink-all="${pathKey}" ${relinkBlocked ? `disabled title="${relinkBlockTitle}"` : ''}>⇄ All</button>
            <button class="ds-btn ds-btn-xs" data-recc-relink-none="${pathKey}">✗ None</button>
          </div>
          <div class="ds-rec-col-list">${linkRows}</div>
        </div>
      </div>
      <div class="ds-rec-cols ds-rec-cols-child">
        <div class="ds-rec-col">
          <div class="ds-rec-col-hdr ds-diff-drift"${csAttr(cs, 'changed', 'changed')}>🟡 <strong>Changed ${csLbl(cs, 'changed')}</strong>
            <span class="ds-rec-col-sub">values differ — → updates target${csInfo(cs, 'changed').capped ? ' · list truncated' : ''}</span></div>
          <div class="ds-rec-col-actions">
            <button class="ds-btn ds-btn-xs" data-recc-ovw-all="${pathKey}" title="Source wins everywhere — update all drifted target records${csInfo(cs, 'changed').capped ? `. ⚠ Only the ${csInfo(cs, 'changed').shown} row(s) listed here — the scan was truncated.` : ''}">→ All</button>
            <button class="ds-btn ds-btn-xs" data-recc-ovw-none="${pathKey}">✗ None</button>
          </div>
          <div class="ds-rec-col-list">${driftRows}</div>
        </div>
        <div class="ds-rec-col">
          <div class="ds-rec-col-hdr ds-diff-extra"${csAttr(cs, 'onlyInTarget', 'in target only')}>🔵 <strong>In target only ${csLbl(cs, 'onlyInTarget')}</strong>
            <span class="ds-rec-col-sub">${orphanN ? `${esc(cs.orphanLabel || `${orphanN} possible orphan(s)`)} — ⇄ Relink can re-attach them` : 'pick rows to delete'}${csInfo(cs, 'onlyInTarget').capped ? ' · list truncated' : ''}</span></div>
          <div class="ds-rec-col-actions">
            <button class="ds-btn ds-btn-xs" data-recc-del-all="${pathKey}" title="Select all for delete${orphanN ? ` — ⚠ orphan rows are excluded (select them individually)` : ''}">🗑 All</button>
            <button class="ds-btn ds-btn-xs" data-recc-del-none="${pathKey}">✗ None</button>
          </div>
          <div class="ds-rec-col-list">${extraRows}</div>
        </div>
      </div>
    </div>`;
  }

  function childSectionHtml(node, pathKey, depth = 1) {
    pathKey        = String(pathKey);
    const childObj = node.objectType || node.childSObject || '?';
    const cs       = scan.children?.[pathKey];
    const fresh    = !!(cs && cs.status === 'success' && cs.rootRunAt === scan.runAt && cs.objectType === childObj);
    const open     = !!_recChildOpen[pathKey];
    const orderCf  = (_recOrderOverride[pathKey] ?? node.insertOrder) === 'childFirst';
    const sel      = childSel(pathKey);

    // R5 — grandchild scans are scoped by their PARENT child scan's ids,
    // which must exist (and be fresh) first.
    const parentKey   = depth > 1 ? pathKey.split('.').slice(0, -1).join('.') : null;
    const parentNode  = parentKey !== null ? getNodeByPath(p.tree, parentKey) : null;
    const parentObj   = depth > 1 ? (parentNode?.objectType || parentNode?.childSObject || '?') : objType;
    const parentCs    = parentKey !== null ? scan.children?.[parentKey] : null;
    const parentFresh = depth === 1 || !!(parentCs && parentCs.status === 'success' && parentCs.rootRunAt === scan.runAt);
    // Parent-status sets for the Insert column notes: root buckets for direct
    // children (v1, unchanged), the parent child scan's buckets for grandchildren.
    const pMissingSet = depth === 1 ? rootMissingBySrc
      : new Set((parentCs?.missingInTarget || []).map(r => r.sourceId));
    const pExistsSet  = depth === 1 ? rootExistsSrc
      : new Set([...(parentCs?.changed || []).map(r => r.sourceId), ...(parentCs?.identical || []).map(r => r.sourceId)]);

    // R2 — master-detail link: children require their parent at insert, so
    // child-first ordering is impossible. R5 — grandchildren only attach to
    // existing parents, so ordering doesn't apply at depth 2 either.
    const isMD = !!(fresh && cs.linkMasterDetail);
    const orderDisabled = depth > 1 || isMD;
    const orderTitle = depth > 1
      ? `Grandchild records always attach to EXISTING parents in v2 — child-first / tree-ride ordering isn't supported at this depth.`
      : isMD
        ? `${esc(node.field || 'The link')} is a master-detail relationship — Salesforce requires the parent at insert, so these records can never be created before their parents.`
        : (orderCf
          ? 'Child-first for THIS run: these records are created before their parents, then reconnected once the parents exist. Click for default order.'
          : 'Default order for THIS run: parents are created first, then these records with the link set at insert. Click to create these records BEFORE their parents instead (for parents whose lookups need them to exist).');
    const showCf = orderCf && !orderDisabled;
    const scanBlocked = depth > 1 && !parentFresh;

    // L6 — the collapsed-section chips are the numbers most users read first,
    // and they were the plain shipped lengths. Same labels as the columns.
    const badges = fresh ? `
      ${(cs.parentScopeCapped || cs.bucketCaps) ? `<span class="ds-diff-chip ds-diff-drift ds-rec-cap-chip" title="${esc(cs.parentScopeNote || cs.bucketCapNote || 'This scan is truncated — the counts below are floors, not totals.')}">⚠ truncated</span>` : ''}
      <span class="ds-diff-chip ds-diff-missing"${csAttr(cs, 'missingInTarget', 'in source only')}>${csLbl(cs, 'missingInTarget')} missing</span>
      <span class="ds-diff-chip ds-diff-drift"${csAttr(cs, 'changed', 'changed', 'Values differ — pick → per row inside')}>${csLbl(cs, 'changed')} changed</span>
      <span class="ds-diff-chip ds-diff-extra"${csAttr(cs, 'onlyInTarget', 'in target only', 'In target only — pick 🗑 per row inside')}>${csLbl(cs, 'onlyInTarget')} target-only</span>
      ${cs.linkTrackable ? `<span class="ds-diff-chip ds-rec-chip-link"${csAttr(cs, 'linkMismatch', 'link differs', 'Same record on both sides, pointing at a DIFFERENT parent in the target')}>${csLbl(cs, 'linkMismatch')} link differs</span>` : ''}
      ${cs.keyCollisions ? `<span class="ds-diff-chip ds-diff-drift" title="${cs.keyCollisions.rows} row(s) share duplicate match keys and were excluded from all buckets — pick a better match field in the profile">⚠ ${cs.keyCollisions.rows} dup keys</span>` : ''}
      ${isMD ? `<span class="ds-diff-chip" title="${esc(node.field || 'The link')} is a master-detail relationship — parent required at insert${cs.linkUpdateable === false ? '; not reparentable, so Relink is disabled' : ''}">MD</span>` : ''}
      <span class="ds-diff-chip ds-diff-sync"${csAttr(cs, 'identical', 'in sync')}>${csLbl(cs, 'identical')} in sync</span>`
      : (cs ? `<span class="ds-rec-child-stale">scan stale — ${depth > 1 ? 'the parent' : 'root'} was re-scanned</span>` : '');

    return `
    <div class="ds-rec-child"${depth > 1 ? ' style="margin-left:26px"' : ''}>
      <div class="ds-rec-child-head">
        <button class="ds-tree-toggle" data-recc-toggle="${pathKey}">${open ? '▼' : '▶'}</button>
        <span class="ds-rec-child-title">${'↳'.repeat(depth)} <strong>${esc(childObj)}</strong> <span class="ds-rec-child-via">via ${esc(node.field || '?')}${depth > 1 ? ` · child of ${esc(parentObj)}` : ''}</span></span>
        ${badges}
        ${depth > 1 && (node.children || []).length ? `<span class="ds-rec-child-via" title="Reconcile scans two levels deep (children + grandchildren) in v2 — this object's own children aren't scanned here">· deeper levels not scanned (v2)</span>` : ''}
        <span class="ds-rec-child-actions">
          <button class="ds-btn ds-btn-xs ${showCf ? 'ds-btn-config--active' : ''}" ${orderDisabled ? 'disabled' : ''} data-recc-order="${pathKey}"
            title="${orderTitle}">
            ${showCf ? '⤴ before parent' : '⤵ after parent'}
          </button>
          <button class="ds-btn ds-btn-xs" data-recc-scan="${pathKey}" ${scanBlocked ? 'disabled' : ''}
            title="${scanBlocked ? `Scan the parent (${esc(parentObj)}) first — this scan is scoped to its results.` : ''}">${fresh ? '🔎 Rescan' : '🔎 Scan'}</button>
        </span>
      </div>
      ${open && fresh ? childBucketsHtml(node, pathKey, cs, sel, pMissingSet, pExistsSet, depth) : ''}
      ${open && !fresh ? `<div class="ds-rec-child-empty">${scanBlocked ? `Scan the parent (${esc(parentObj)}) section first — this scan is scoped to its results.` : `No fresh scan for this object yet — click 🔎 Scan. The scan is scoped to the ${esc(parentObj)} records above.`}</div>` : ''}
    </div>`;
  }

  // Session visibility (user 2026-08-09: "When an org is not currently
  // authenticated the user needs to know — i have an error because of that
  // that was misleading"). Say it HERE, before any action fails weirdly.
  let _sessNote = '';
  try {
    const _all = _buildAllSessions();
    const _deadOrgs = [
      !_resolveSession(p.sourceOrg, _all)?.sid ? orgLabel(p.sourceOrg) : null,
      !_resolveSession(p.targetOrg, _all)?.sid ? orgLabel(p.targetOrg) : null,
    ].filter(Boolean);
    if (_deadOrgs.length) {
      _sessNote = `<div class="ds-op-banner ds-op-banner-danger" style="border-left:3px solid #dc2626">
        <span class="ds-op-banner-icon">🔒</span>
        <div class="ds-op-banner-body">
          <div class="ds-op-banner-title">${esc(_deadOrgs.join(' and '))} ${_deadOrgs.length > 1 ? 'are' : 'is'} not signed in</div>
          <div class="ds-op-banner-desc">The numbers below come from the last scan, but every button that reads or writes ${_deadOrgs.length > 1 ? 'these orgs' : 'this org'} will fail until you open ${_deadOrgs.length > 1 ? 'them' : 'it'} in a Chrome tab and sign in. Then click 🔄 Refresh state.</div>
        </div>
      </div>`;
    }
  } catch (_) { _sessNote = ''; }

  // SYNC CONTRACT strip (user 2026-08-10: "you are not showing the user
  // what he needs to do to be considered In Sync") — state the definition
  // and the exact remaining work, instead of implying it through columns.
  // HEALTH NOTES (user 2026-08-10: "the user doesn't even know what he
  // needs to fix in this state") — hazards the scan KNOWS but a green
  // light would otherwise swallow: duplicate match keys inside an org
  // (name-ambiguity survives identity matching), and verdicts resting on
  // memory instead of keys.
  const _health = [];
  if (scan.dupKeys?.rows) {
    // Plain speech + THE RECORDS THEMSELVES, linked in both orgs (user
    // 2026-08-10: "where are the records. and the issue is not
    // understandable") — a warning without its suspects is unactionable.
    const _rl = (org, id, i) => `<a href="${esc(String(org || '').replace(/\/$/, ''))}/lightning/r/${esc(id)}/view" target="_blank" rel="noopener" class="ds-lkpo-vallink" title="${esc(id)}">copy ${i + 1}</a>`;
    const _exHtml = (scan.dupKeys.examples || []).map(ex => {
      const parts = [];
      if ((ex.src || []).length > 1) parts.push(`${ex.src.length}× in ${esc(orgLabel(p.sourceOrg))}: ${ex.src.map((id, i) => _rl(p.sourceOrg, id, i)).join(' · ')}`);
      if ((ex.tgt || []).length > 1) parts.push(`${ex.tgt.length}× in ${esc(orgLabel(p.targetOrg))}: ${ex.tgt.map((id, i) => _rl(p.targetOrg, id, i)).join(' · ')}`);
      return `<div style="margin-top:4px">“<strong>${keyLbl(ex.key)}</strong>” exists ${parts.join(' and ')}</div>`;
    }).join('');
    _health.push(`⚠ <strong>The same name is used by more than one record.</strong> Anything that finds records by this name — matching, lookups, other deployments — can land on EITHER copy, so results become a coin flip. Open the copies below, decide which one is real, and rename or delete the others (in both orgs):${_exHtml}`);
  }
  // The memory note earns its place ONLY next to actual key oddities it is
  // excusing — "review them deliberately" with nothing shown to review is a
  // call to action without objects (user 2026-08-10: "yea but i shows
  // nothing"). A clean state speaks for itself.
  if (scan.memoryMatched && scan.dupKeys?.rows) {
    _health.push(`ℹ ${scan.memoryMatched} pair(s) matched by remembered identity rather than by key — rename-proof, and it's why the duplicates above didn't block matching. Fix the duplicates; matching itself is fine.`);
  }
  const _healthHtml = _health.length
    ? `<div class="ds-op-banner-desc" style="margin-top:6px">${_health.join('<br>')}</div>` : '';
  // In-sync + clean → NO banner: the green Synced tab IS the message (user
  // 2026-08-11: "remove the message. It will be under the new tab"). Health
  // warnings still surface — a warning must never be swallowed by a redesign.
  // 📎 With the Files toggle ON, missing files BLOCK the silent-clean state:
  // "it should be considered as synced only after the file is transferred".
  const _fdRecs = (scan.fileDrift && !scan.fileDrift.error) ? (scan.fileDrift.records || 0) : 0;
  // CHILDREN gate the verdict too (user 2026-08-18: "when childs are not
  // deployed, it must not show as synced") — this strip previously read the
  // ROOT buckets only, so a clean root hid 1,850 missing children behind a
  // silent-clean state (load test: parents upserted, children dead). Fresh
  // child scans feed the needs-list; child sections WITHOUT a fresh scan
  // make the pair UNVERIFIED, never silently clean.
  const _kids = [];        // fresh child scans that still carry work
  let _kidsUnscanned = 0;  // child sections with no fresh scan for THIS root scan
  {
    const walkKid = (node, pathKey) => {
      const obj = node.objectType || node.childSObject || '?';
      const cs = scan.children?.[pathKey];
      const fresh = !!(cs && cs.status === 'success' && cs.rootRunAt === scan.runAt && cs.objectType === obj);
      if (!fresh) {
        _kidsUnscanned++;
      } else {
        const m = (cs.missingInTarget || []).length, c = (cs.changed || []).length,
              l = (cs.linkMismatch || []).length,  e = (cs.onlyInTarget || []).length;
        if (m + c + l + e) _kids.push({ obj, m, c, l, e });
      }
      (node.children || []).forEach((g, j) => walkKid(g, `${pathKey}.${j}`));
    };
    (p.tree?.children || []).forEach((c, i) => walkKid(c, String(i)));
  }
  const _kidItems = _kids.map(k => `<strong>${esc(k.obj)}</strong>: ${[
    k.m ? `${k.m} pushed` : null, k.c ? `${k.c} resolved` : null,
    k.l ? `${k.l} relinked` : null, k.e ? `${k.e} target-only decided` : null,
  ].filter(Boolean).join(', ')} (child section below)`);
  const _rootClean = !missing.length && !drift.length && !extras.length;
  const _syncStrip = (_rootClean && !_kids.length)
    ? ((_health.length || _fdRecs || _kidsUnscanned)
      ? `<div class="ds-op-banner" style="border-left:3px solid #f59e0b">
          <span class="ds-op-banner-icon">${_fdRecs ? '📎' : _kidsUnscanned ? '🔎' : '⚠'}</span>
          <div class="ds-op-banner-body">
            <div class="ds-op-banner-title">${_fdRecs ? 'Fields in sync — files still missing' : _kidsUnscanned ? 'Root object in sync — children UNVERIFIED' : 'Warnings worth reading'}</div>
            ${_fdRecs ? `<div class="ds-op-banner-desc">📎 ${scan.fileDrift.missingFiles} file(s) exist in <strong>${esc(orgLabel(p.sourceOrg))}</strong> but not on the matched records in <strong>${esc(orgLabel(p.targetOrg))}</strong> — this pair is NOT fully synced until they move (🟢 Synced tab → select &amp; move). Just changed the source or direction? Then this is the SAME files measured the other way around, not new work.</div>` : ''}
            ${_kidsUnscanned ? `<div class="ds-op-banner-desc">${_kidsUnscanned} child section(s) below ${_kidsUnscanned === 1 ? 'has' : 'have'} no fresh scan against this target — child records are UNKNOWN, not verified. Open each section and 🔎 Scan; only then can this pair claim full sync.</div>` : ''}
            ${_healthHtml}
          </div>
        </div>`
      : '')
    : `<div class="ds-op-banner" style="border-left:3px solid #f59e0b">
        <span class="ds-op-banner-icon">🎯</span>
        <div class="ds-op-banner-body">
          <div class="ds-op-banner-title">To be IN SYNC, this pair still needs:</div>
          <div class="ds-op-banner-desc">${[
            missing.length ? `<strong>${missing.length}</strong> record(s) pushed into the target (Insert column)` : null,
            drift.length ? `<strong>${drift.length}</strong> changed record(s) resolved — pick a winner per row (→ source wins · ← target wins)` : null,
            extras.length ? `<strong>${extras.length}</strong> target-only record(s) DECIDED — 🗑 delete the unwanted, or ← pull the legitimate ones INTO YOUR SOURCE (pull rewrites the source of truth — be sure that's what you mean)` : null,
            _fdRecs ? `📎 <strong>${scan.fileDrift.missingFiles}</strong> file(s) moved onto ${_fdRecs} record(s) (🟢 Synced tab → select &amp; move)` : null,
            ..._kidItems,
          ].filter(Boolean).join(' · ')}. Select below, ▶ Run, and this strip re-checks itself.</div>
          ${_kidsUnscanned ? `<div class="ds-op-banner-desc">Plus ${_kidsUnscanned} child section(s) not scanned against this target yet — their state is unknown until scanned.</div>` : ''}
          ${_healthHtml}
        </div>
      </div>`;

  setMain(`${headerHtml}
    ${_sessNote}
    ${_journeyHtml}
    <div id="dsRecParentGaps"></div>
    ${_syncStrip}
    <div class="ds-op-banner ds-op-banner-write">
      <span class="ds-op-banner-icon">⚖</span>
      <div class="ds-op-banner-body">
        <div class="ds-op-banner-title">Pushing <strong>${esc(orgLabel(p.sourceOrg))}</strong> → <strong>${esc(orgLabel(p.targetOrg))}</strong></div>
        <div class="ds-op-banner-desc"><strong>→</strong> writes FROM ${esc(orgLabel(p.sourceOrg))} INTO <strong>${esc(orgLabel(p.targetOrg))}</strong> (the normal direction). <strong>←</strong> writes back FROM ${esc(orgLabel(p.targetOrg))} INTO <strong>${esc(orgLabel(p.sourceOrg))}</strong> — opt-in, per row. On changed records pick a winner per row with those arrows. Delete permanently removes records from ${esc(orgLabel(p.targetOrg))}. Review your selections before running.</div>
      </div>
    </div>

    ${_recCapNote ? `<div class="ds-rec-child-info ds-rec-cap-note" style="border-left:3px solid #f59e0b;padding-left:8px;margin:6px 0">${esc(_recCapNote)}</div>` : ''}
    ${scan.nearMisses ? `<div class="ds-rec-child-info" style="border-left:3px solid #f59e0b;padding-left:8px;margin:6px 0">≈ ${scan.nearMisses} record pair(s) almost matched — their keys differ only by whitespace/case (marked ≈ on the rows below). Enable Trim spaces / Case-insensitive in 🎯 Pick Records → Matching, or fix the values, then rescan.</div>` : ''}

    ${sftkPicklistGapNote(scan, p.targetOrg, objType)}

    <div class="ds-rec-cols ds-rec-cols-4">
      ${colHtml('Insert', 'in source only', 'ds-diff-missing', '🔴', missing, 'push', 'missingInTarget')}
      ${driftColHtml(drift)}
      ${extrasColHtml(extras)}
      ${syncedColHtml(inSync, scan, p)}
    </div>

    ${!p.ephemeral && (missing.length || extras.length) ? `
    <div class="ds-mm-review-row" style="display:flex;align-items:center;gap:10px;margin:8px 0 2px">
      <button class="ds-btn ds-btn-sm" id="dsMatchReviewBtn"
        title="Manually pair 'in source only' rows with 'in target only' rows that are actually the same record (renamed, typo'd, …). Pairs are remembered per target org and match by identity on every future scan.${(capInfo('missingInTarget').capped || capInfo('onlyInTarget').capped) ? ' Both lists are truncated by this scan — only the rows it carries can be paired here.' : ''}">🔗 Match review (${missing.length} + ${extras.length} listed${(capInfo('missingInTarget').capped || capInfo('onlyInTarget').capped) ? ', truncated' : ' unmatched'})</button>
      <span style="font-size:11.5px;color:var(--subtext)">same record on both sides under different keys? Pair them once — matching then survives renames.</span>
    </div>` : ''}


    ${sftkPhantomDriftNote(scan)}
    ${scan.blankKeys ? `<div class="ds-rec-child-info ds-match-blank-note" style="border-left:3px solid #f59e0b;padding-left:8px;margin:6px 0">⚠ ${scan.blankKeys.rows} row(s) have a blank match key — excluded from matching (${scan.blankKeys.src} source, ${scan.blankKeys.tgt} target). Pick a better-populated match field in 🎯 Pick Records (🧪 Test this key grades candidates).</div>` : ''}
    ${(scan.warnings || []).length ? `<div class="ds-rec-child-info ds-mm-warn-note" style="border-left:3px solid #f59e0b;padding-left:8px;margin:6px 0">⚠ ${esc(scan.warnings.join(' · '))}</div>` : ''}

    ${rootChildren.length ? `
    <div class="ds-rec-children">
      <div class="ds-rec-children-hdr">🔗 Related objects
        <span class="ds-rec-children-sub">insert child records and reconnect them to their parents — scans are scoped to the ${esc(objType)} records above · two levels deep (children + grandchildren) in v2</span>
      </div>
      ${rootChildren.map((c, i) => {
        let html = childSectionHtml(c, String(i), 1);
        // R5 — grandchildren: one level deeper, rendered indented under their
        // parent section. A render error in the new depth-2 path degrades to
        // a warning line instead of killing the whole view.
        (c.children || []).forEach((g, j) => {
          try { html += childSectionHtml(g, `${i}.${j}`, 2); }
          catch (e) { html += `<div class="ds-rec-child-empty">⚠ couldn't render the ${esc(g?.objectType || g?.childSObject || 'grandchild')} section: ${esc(e?.message || String(e))}</div>`; }
        });
        return html;
      }).join('')}
    </div>` : ''}

    <div class="ds-rec-action-bar">
      <div class="ds-rec-action-summary" id="dsRecSummary"></div>
      <label class="ds-rec-delmode" title="How records are written for THIS pair's actions. Auto: synchronous Collections below the threshold, one async Bulk API 2.0 job at or above it. Synchronous: always Collections — slower at scale, every error immediate and per-record. Async: always a Bulk job. Saved on the deployment — the Run page and fan-out use the same setting.">
        <span>Engine:</span>
        <select id="dsRecApiMode" class="ds-select ds-select-sm">
          <option value="auto" ${(p.apiMode || 'auto') === 'auto' ? 'selected' : ''}>Auto — Bulk at ≥ ${(Number(p.bulkThreshold) > 0 ? Number(p.bulkThreshold) : 2000).toLocaleString()}</option>
          <option value="sync" ${p.apiMode === 'sync' ? 'selected' : ''}>Synchronous — Collections</option>
          <option value="bulk" ${p.apiMode === 'bulk' ? 'selected' : ''}>Async — Bulk API 2.0 job</option>
        </select>
        <span id="dsRecBatchWrap" style="display:inline-flex;align-items:center;gap:4px${p.apiMode === 'bulk' ? ';opacity:.45' : ''}"
          title="Records per synchronous Collections call (1-200; 200 is the Salesforce maximum). Smaller batches isolate failures and duck per-transaction trigger limits. ONLY the synchronous engine batches on the client — a Bulk API 2.0 job uploads everything at once and Salesforce chunks it internally, so this is disabled in Async mode. One exception rides along: with child-first children, the reconnect step always patches links via synchronous calls in batches of the saved value, even on Async runs.">
          <span>batch</span>
          <input id="dsRecBatchSize" class="ds-input ds-input-sm" type="number" min="1" max="200" step="1"
            style="width:72px;text-align:right" value="${Math.max(1, Math.min(200, Number(p.batchSize) || 200))}"
            ${p.apiMode === 'bulk' ? 'disabled' : ''}>
          <span>per call</span>
        </span>
      </label>
      <label class="ds-rec-delmode" title="Recycle Bin: deleted records recoverable for 15 days. Hard delete: permanently purged, not recoverable.">
        <span>Delete mode:</span>
        <select id="dsRecDeleteMode" class="ds-select ds-select-sm">
          <option value="recycle" ${_recDeleteMode === 'recycle' ? 'selected' : ''}>🗑 Recycle Bin (recoverable)</option>
          <option value="hard" ${_recDeleteMode === 'hard' ? 'selected' : ''}>🔥 Hard delete (permanent)</option>
        </select>
      </label>
      <div class="ds-rec-action-btns">
        <button class="ds-btn" id="dsRecCancelBtn">Cancel</button>
        <button class="ds-btn ds-btn-primary ds-btn-lg" id="dsRecRunBtn">▶ Run reconcile</button>
      </div>
    </div>

    <div id="dsRecProgress"></div>
  `);

  function updateSummary() {
    const el = eid('dsRecSummary');
    if (!el) return;
    const parts = [];
    if (_recSel.push.size)      parts.push(`<span class="ds-diff-chip ds-diff-missing">Insert ${_recSel.push.size}</span>`);
    if (_recSel.overwrite.size) parts.push(`<span class="ds-diff-chip ds-diff-drift">→ Update target ${_recSel.overwrite.size}</span>`);
    if (_recSel.updSrc.size)    parts.push(`<span class="ds-diff-chip ds-diff-pull">← Update source ${_recSel.updSrc.size}</span>`);
    if (_recSel.pull.size)      parts.push(`<span class="ds-diff-chip ds-diff-pull">← Pull ${_recSel.pull.size}</span>`);
    if (_recSel.del.size)       parts.push(`<span class="ds-diff-chip ds-diff-extra">Delete ${_recSel.del.size}</span>`);
    // Child-object actions (insert / relink), per relationship.
    for (const [k, sel] of Object.entries(_recChildSel)) {
      const node = getNodeByPath(p.tree, k);
      const obj  = node?.objectType || node?.childSObject || '?';
      if (sel.push.size)        parts.push(`<span class="ds-diff-chip ds-diff-missing">Insert ${sel.push.size} ${esc(obj)}</span>`);
      if (sel.relink.size)      parts.push(`<span class="ds-diff-chip ds-rec-chip-link">⇄ Relink ${sel.relink.size} ${esc(obj)}</span>`);
      if (sel.overwrite?.size)  parts.push(`<span class="ds-diff-chip ds-diff-drift">→ Update ${sel.overwrite.size} ${esc(obj)}</span>`);
      if (sel.del?.size)        parts.push(`<span class="ds-diff-chip ds-diff-extra">Delete ${sel.del.size} ${esc(obj)}</span>`);
    }
    el.innerHTML = parts.length ? `Actions: ${parts.join(' ')}` : '<span style="color:var(--subtext)">Nothing selected</span>';
    const runBtn = eid('dsRecRunBtn');
    if (runBtn) runBtn.disabled = !parts.length;
    // Refresh the extras column subcounts as the user toggles per-row picks.
    const sub = document.querySelector('.ds-rec-extra-subcounts:not(.ds-rec-drift-subcounts)');
    if (sub) {
      const totalExtras = extras.length;
      const pullN = _recSel.pull.size;
      const delN  = _recSel.del.size;
      sub.innerHTML = `
        <span class="ds-rec-extra-sub-pull">← ${pullN} to pull</span>
        <span class="ds-rec-extra-sub-del">🗑 ${delN} to delete</span>
        <span class="ds-rec-extra-sub-skip">${totalExtras - pullN - delN} skipped</span>`;
    }
    // Drift column subcounts likewise.
    const dsub = document.querySelector('.ds-rec-drift-subcounts');
    if (dsub) {
      const pushN = _recSel.overwrite.size;
      const usN   = _recSel.updSrc.size;
      dsub.innerHTML = `
        <span class="ds-rec-drift-sub-push">→ ${pushN} to target</span>
        <span class="ds-rec-extra-sub-pull">← ${usN} to source</span>
        <span class="ds-rec-extra-sub-skip">${drift.length - pushN - usN} skipped</span>`;
    }
  }
  updateSummary();

  // Wire checkboxes for the source-driven columns (push, overwrite)
  document.querySelectorAll('[data-rec-kind]').forEach(cb => {
    cb.addEventListener('change', () => {
      const kind = cb.dataset.recKind, id = cb.dataset.recId;
      if (cb.checked) _recSel[kind].add(id); else _recSel[kind].delete(id);
      updateSummary();
    });
  });
  // All / None per column (push + overwrite only — extras has its own handlers)
  document.querySelectorAll('[data-rec-all]').forEach(btn => btn.addEventListener('click', () => {
    const kind = btn.dataset.recAll;
    document.querySelectorAll(`[data-rec-kind="${kind}"]`).forEach(cb => { cb.checked = true; _recSel[kind].add(cb.dataset.recId); });
    updateSummary();
  }));
  document.querySelectorAll('[data-rec-none]').forEach(btn => btn.addEventListener('click', () => {
    const kind = btn.dataset.recNone;
    document.querySelectorAll(`[data-rec-kind="${kind}"]`).forEach(cb => { cb.checked = false; _recSel[kind].delete(cb.dataset.recId); });
    updateSummary();
  }));

  // Phase 3B — extras column per-row Pull/Delete buttons (mutually exclusive).
  // Click an already-selected action to deselect it (= Skip).
  function paintExtraRow(rowEl, tgtId) {
    const pullBtn = rowEl.querySelector('[data-rec-extra="pull"]');
    const delBtn  = rowEl.querySelector('[data-rec-extra="del"]');
    if (pullBtn) pullBtn.classList.toggle('ds-rec-extra-on-pull', _recSel.pull.has(tgtId));
    if (delBtn)  delBtn.classList.toggle('ds-rec-extra-on-del',   _recSel.del.has(tgtId));
  }
  document.querySelectorAll('[data-rec-extra]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      const action = btn.dataset.recExtra;            // 'pull' or 'del'
      const tgtId  = btn.dataset.recId;
      const other  = action === 'pull' ? 'del' : 'pull';
      if (_recSel[action].has(tgtId)) {
        _recSel[action].delete(tgtId);                // toggle off → Skip
      } else {
        _recSel[action].add(tgtId);
        _recSel[other].delete(tgtId);                 // mutually exclusive
      }
      paintExtraRow(btn.closest('.ds-rec-row-extra'), tgtId);
      updateSummary();
    });
  });
  // Bulk: Pull all / Delete all / None for the extras column.
  document.querySelectorAll('[data-rec-extra-all]').forEach(btn => btn.addEventListener('click', () => {
    const action = btn.dataset.recExtraAll;           // 'pull' or 'del'
    const other  = action === 'pull' ? 'del' : 'pull';
    extras.forEach(r => {
      _recSel[action].add(r.targetId);
      _recSel[other].delete(r.targetId);
    });
    document.querySelectorAll('.ds-rec-row-extra').forEach(row => {
      const id = row.querySelector('[data-rec-id]')?.dataset.recId;
      if (id) paintExtraRow(row, id);
    });
    updateSummary();
  }));
  document.querySelector('[data-rec-extra-clear]')?.addEventListener('click', () => {
    extras.forEach(r => { _recSel.pull.delete(r.targetId); _recSel.del.delete(r.targetId); });
    document.querySelectorAll('.ds-rec-row-extra').forEach(row => {
      const id = row.querySelector('[data-rec-id]')?.dataset.recId;
      if (id) paintExtraRow(row, id);
    });
    updateSummary();
  });

  // Phase 3B v2 — drift column per-row direction buttons (→ target wins /
  // ← source wins, mutually exclusive; click the active one to skip).
  function paintDriftRow(rowEl, sid) {
    const pushBtn = rowEl.querySelector('[data-rec-driftdir="overwrite"]');
    const pullBtn = rowEl.querySelector('[data-rec-driftdir="updSrc"]');
    if (pushBtn) pushBtn.classList.toggle('ds-rec-extra-on-push', _recSel.overwrite.has(sid));
    if (pullBtn) pullBtn.classList.toggle('ds-rec-extra-on-pull', _recSel.updSrc.has(sid));
  }
  document.querySelectorAll('[data-rec-driftdir]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      const action = btn.dataset.recDriftdir;          // 'overwrite' | 'updSrc'
      const sid    = btn.dataset.recId;
      const other  = action === 'overwrite' ? 'updSrc' : 'overwrite';
      if (_recSel[action].has(sid)) {
        _recSel[action].delete(sid);                   // toggle off → Skip
      } else {
        _recSel[action].add(sid);
        _recSel[other].delete(sid);                    // mutually exclusive
      }
      paintDriftRow(btn.closest('.ds-rec-row-drift'), sid);
      updateSummary();
    });
  });
  document.querySelectorAll('[data-rec-driftdir-all]').forEach(btn => btn.addEventListener('click', () => {
    const action = btn.dataset.recDriftdirAll;
    const other  = action === 'overwrite' ? 'updSrc' : 'overwrite';
    drift.forEach(r => {
      _recSel[action].add(r.sourceId);
      _recSel[other].delete(r.sourceId);
    });
    document.querySelectorAll('.ds-rec-row-drift').forEach(row => {
      const id = row.querySelector('[data-rec-id]')?.dataset.recId;
      if (id) paintDriftRow(row, id);
    });
    updateSummary();
  }));
  document.querySelector('[data-rec-driftdir-clear]')?.addEventListener('click', () => {
    drift.forEach(r => { _recSel.overwrite.delete(r.sourceId); _recSel.updSrc.delete(r.sourceId); });
    document.querySelectorAll('.ds-rec-row-drift').forEach(row => {
      const id = row.querySelector('[data-rec-id]')?.dataset.recId;
      if (id) paintDriftRow(row, id);
    });
    updateSummary();
  });
  // Drift "fields" expander — reuse fetchDriftRowDetail + renderDriftCompareTable
  document.querySelectorAll('[data-rec-drift]').forEach(link => {
    link.addEventListener('click', async (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const [srcId, tgtId] = (link.dataset.recDrift || '').split('|');
      const expand = document.querySelector(`.ds-rec-drift-expand[data-drift-expand="${srcId}"]`);
      if (!expand) return;
      if (expand.dataset.loaded === '1') {
        expand.style.display = expand.style.display === 'none' ? 'block' : 'none';
        return;
      }
      expand.style.display = 'block';
      expand.innerHTML = `<div class="ds-drift-compare-loading">Loading…</div>`;
      const srcFields = scan.compareFields || [];
      const tgtFields = scan.compareFieldsTgt || scan.compareFields || [];
      const res = await fetchDriftRowDetail(p, objType, srcId, tgtId, srcFields, tgtFields);
      if (res.error) {
        // Fall back to the scan-time answer when the live fetch can't run.
        const row = drift.find(r => r.sourceId === srcId);
        const fieldsNote = (row?.fields || []).length
          ? `<div class="ds-drift-compare-fallback">At the last scan these field(s) differed:
               <strong>${esc(row.fields.join(', '))}</strong></div>`
          : '';
        expand.innerHTML = `${fieldsNote}<div class="ds-drift-compare-err">⚠ ${esc(res.error)}</div>`;
      } else {
        expand.innerHTML = renderDriftCompareTable(res.srcRec, res.tgtRec, srcFields, tgtFields, res.lookupMap || {}, res.types || null);
      }
      expand.dataset.loaded = '1';
    });
  });

  // W2-UI — 🔗 lookup override panel toggles (missing + changed rows).
  // preventDefault matters on the missing rows: the link sits inside the
  // row's <label>, and a plain click would also toggle its push checkbox.
  document.querySelectorAll('[data-rec-lkp]').forEach(link => {
    link.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const srcId = link.dataset.recLkp;
      const expand = document.querySelector(`.ds-rec-lkp-expand[data-lkp-expand="${CSS.escape(srcId)}"]`);
      if (!expand) return;
      const wasOpen = expand.style.display !== 'none';
      expand.style.display = wasOpen ? 'none' : 'block';
      if (!wasOpen && expand.dataset.loaded !== '1') {
        expand.dataset.loaded = '1';
        renderLkpOverridePanel(p, objType, srcId, expand, link.dataset.recLkpTgt || null);
      }
    });
  });

  // T6 — 🎚 Fix in Picklist Manager buttons (root + every child section).
  sftkWirePicklistFixButtons();

  // ⛓ Parent-gap advisor — recognizes tonight's 401-failure pattern before
  // it happens and offers the fix as one click. Async; never blocks paint.
  sftkRecParentGapAdvisor(p, scan, objType, missing);
  eid('dsRecJourneyBack')?.addEventListener('click', () => {
    const orig = _profiles.find(x => x.id === p._parentOf?.profileId);
    if (!orig) return;
    _reconcileProfile = orig;
    renderReconcile();   // stale-run detection re-scans it with the new parents
  });

  // ── Child section wiring ────────────────────────────────────────────
  document.querySelectorAll('[data-recc-toggle]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.reccToggle;
    _recChildOpen[k] = !_recChildOpen[k];
    renderReconcile();
  }));
  document.querySelectorAll('[data-recc-scan]').forEach(b => b.addEventListener('click', async () => {
    const k = b.dataset.reccScan;
    b.disabled = true; b.textContent = '⏳ scanning…';
    const res = await scanReconcileChild(p, k);
    if (res?.error) showToast(`Child scan: ${res.error}`, 'error', 6000);
    else _recChildOpen[k] = true;
    renderReconcile();
  }));
  document.querySelectorAll('[data-recc-order]').forEach(b => b.addEventListener('click', () => {
    const k    = b.dataset.reccOrder;
    const node = getNodeByPath(p.tree, k);
    const cur  = (_recOrderOverride[k] ?? node?.insertOrder) === 'childFirst';
    _recOrderOverride[k] = cur ? 'parentFirst' : 'childFirst';   // run-scoped, never saved
    renderReconcile();
  }));
  // Live "n/N selected" — repainted on every selection change so the count
  // stays true while the list scrolls (part of the messy-child-view fix).
  const _reccCount = k => {
    const el = document.querySelector(`[data-recc-count="${k}"]`);
    if (!el) return;
    const total = document.querySelectorAll(`[data-recc-push="${k}"]:not(:disabled)`).length;
    el.textContent = `${childSel(k).push.size}/${total} selected`;
  };
  document.querySelectorAll('[data-recc-push]').forEach(cb => cb.addEventListener('change', () => {
    const sel = childSel(cb.dataset.reccPush);
    if (cb.checked) sel.push.add(cb.dataset.recId); else sel.push.delete(cb.dataset.recId);
    updateSummary(); _reccCount(cb.dataset.reccPush);
  }));
  document.querySelectorAll('[data-recc-all]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.reccAll, sel = childSel(k);
    document.querySelectorAll(`[data-recc-push="${k}"]:not(:disabled)`).forEach(cb => { cb.checked = true; sel.push.add(cb.dataset.recId); });
    updateSummary(); _reccCount(k);
  }));
  document.querySelectorAll('[data-recc-none]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.reccNone, sel = childSel(k);
    document.querySelectorAll(`[data-recc-push="${k}"]`).forEach(cb => { cb.checked = false; });
    sel.push.clear();
    updateSummary(); _reccCount(k);
  }));
  // Per-parent-group select/clear — the buttons live inside a <summary>, so
  // preventDefault keeps a click from also toggling the fold.
  document.querySelectorAll('[data-recc-gall]').forEach(b => b.addEventListener('click', e => {
    e.preventDefault();
    const k = b.dataset.reccGall, sel = childSel(k);
    document.querySelectorAll(`[data-recc-push="${k}"][data-rec-pgroup="${b.dataset.recPgroup}"]:not(:disabled)`)
      .forEach(cb => { cb.checked = true; sel.push.add(cb.dataset.recId); });
    updateSummary(); _reccCount(k);
  }));
  document.querySelectorAll('[data-recc-gnone]').forEach(b => b.addEventListener('click', e => {
    e.preventDefault();
    const k = b.dataset.reccGnone, sel = childSel(k);
    document.querySelectorAll(`[data-recc-push="${k}"][data-rec-pgroup="${b.dataset.recPgroup}"]`)
      .forEach(cb => { cb.checked = false; sel.push.delete(cb.dataset.recId); });
    updateSummary(); _reccCount(k);
  }));
  document.querySelectorAll('[data-recc-relink]').forEach(b => b.addEventListener('click', e => {
    e.preventDefault();
    const sel = childSel(b.dataset.reccRelink), id = b.dataset.recId;
    if (sel.relink.has(id)) sel.relink.delete(id); else sel.relink.add(id);
    b.classList.toggle('ds-rec-extra-on-push', sel.relink.has(id));
    updateSummary();
  }));
  document.querySelectorAll('[data-recc-relink-all]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.reccRelinkAll, sel = childSel(k);
    (scan.children?.[k]?.linkMismatch || []).forEach(r => sel.relink.add(r.targetId));
    document.querySelectorAll(`[data-recc-relink="${k}"]`).forEach(x => x.classList.add('ds-rec-extra-on-push'));
    updateSummary();
  }));
  document.querySelectorAll('[data-recc-relink-none]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.reccRelinkNone;
    childSel(k).relink.clear();
    document.querySelectorAll(`[data-recc-relink="${k}"]`).forEach(x => x.classList.remove('ds-rec-extra-on-push'));
    updateSummary();
  }));
  // R4 — child drift → overwrite toggles (per-row + All/None).
  document.querySelectorAll('[data-recc-ovw]').forEach(b => b.addEventListener('click', e => {
    e.preventDefault();
    const sel = childSel(b.dataset.reccOvw), id = b.dataset.recId;
    if (sel.overwrite.has(id)) sel.overwrite.delete(id); else sel.overwrite.add(id);
    b.classList.toggle('ds-rec-extra-on-push', sel.overwrite.has(id));
    updateSummary();
  }));
  document.querySelectorAll('[data-recc-ovw-all]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.reccOvwAll, sel = childSel(k);
    (scan.children?.[k]?.changed || []).forEach(r => { if (r.sourceId) sel.overwrite.add(r.sourceId); });
    document.querySelectorAll(`[data-recc-ovw="${k}"]`).forEach(x => x.classList.add('ds-rec-extra-on-push'));
    updateSummary();
  }));
  document.querySelectorAll('[data-recc-ovw-none]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.reccOvwNone;
    childSel(k).overwrite.clear();
    document.querySelectorAll(`[data-recc-ovw="${k}"]`).forEach(x => x.classList.remove('ds-rec-extra-on-push'));
    updateSummary();
  }));
  // R4 — child target-only 🗑 delete toggles. R3 — "🗑 All" skips rows tagged
  // as possible orphans; they stay individually selectable.
  document.querySelectorAll('[data-recc-del]').forEach(b => b.addEventListener('click', e => {
    e.preventDefault();
    const sel = childSel(b.dataset.reccDel), id = b.dataset.recId;
    if (sel.del.has(id)) sel.del.delete(id); else sel.del.add(id);
    b.classList.toggle('ds-rec-extra-on-del', sel.del.has(id));
    updateSummary();
  }));
  document.querySelectorAll('[data-recc-del-all]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.reccDelAll, sel = childSel(k);
    (scan.children?.[k]?.onlyInTarget || []).forEach(r => { if (r.targetId && !r.orphan) sel.del.add(r.targetId); });
    document.querySelectorAll(`[data-recc-del="${k}"]`).forEach(x => {
      x.classList.toggle('ds-rec-extra-on-del', sel.del.has(x.dataset.recId));
    });
    updateSummary();
  }));
  document.querySelectorAll('[data-recc-del-none]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.reccDelNone;
    childSel(k).del.clear();
    document.querySelectorAll(`[data-recc-del="${k}"]`).forEach(x => x.classList.remove('ds-rec-extra-on-del'));
    updateSummary();
  }));

  eid('dsRecBackBtn')?.addEventListener('click', renderProfiles);
  eid('dsRecCancelBtn')?.addEventListener('click', renderProfiles);
  eid('dsRecRefreshBtn')?.addEventListener('click', async () => {
    await window.refreshProfileState(p.id);
    { const _fp = _profiles.find(x => x.id === p.id); if (_fp) _reconcileProfile = _fp; }
    _recSel = { push: new Set(), overwrite: new Set(), updSrc: new Set(), del: new Set(), pull: new Set() };
    _recChildSel = {};   // child buckets changed too — selections are stale
    renderReconcile();
  });
  // Engine controls (user 2026-08-17: "since we deploy to each target
  // separately, i want to select bulk api / batch size in reconcile").
  // Same persistence contract as the Run page and the fan-out: saved ON THE
  // PROFILE (the engine reads profile.apiMode/batchSize at run start, and
  // Reconcile's push spreads this profile object into the engine message).
  // For an ephemeral chooser pair, mirror onto the REAL profile via _ringOf
  // so the choice survives the session — the clone alone would evaporate.
  const _recEnginePersist = async () => {
    const realP = p._ringOf?.profileId ? _profiles.find(x => x.id === p._ringOf.profileId) : null;
    if (realP) {
      if (p.apiMode) realP.apiMode = p.apiMode; else delete realP.apiMode;
      if (p.batchSize) realP.batchSize = p.batchSize; else delete realP.batchSize;
    }
    try { await storageSaveProfiles(); } catch (_) {}
  };
  eid('dsRecApiMode')?.addEventListener('change', async e => {
    const v = e.target.value;
    if (v === 'sync' || v === 'bulk') p.apiMode = v; else delete p.apiMode;
    // Batch size is a SYNCHRONOUS-engine knob — Bulk jobs ignore it, so the
    // input goes inert the moment Async is picked (user 2026-08-18: "user
    // has no idea what he is selecting").
    const bi = eid('dsRecBatchSize'), bw = eid('dsRecBatchWrap');
    if (bi) bi.disabled = v === 'bulk';
    if (bw) bw.style.opacity = v === 'bulk' ? '.45' : '';
    await _recEnginePersist();
  });
  eid('dsRecBatchSize')?.addEventListener('change', async e => {
    const n = Math.max(1, Math.min(200, parseInt(e.target.value, 10) || 200));
    e.target.value = n;
    if (n === 200) delete p.batchSize; else p.batchSize = n;
    await _recEnginePersist();
  });
  eid('dsRecDeleteMode')?.addEventListener('change', e => { _recDeleteMode = e.target.value; });
  eid('dsRecRunBtn')?.addEventListener('click', () => runReconcile(p, objType, { missing, drift, extras }));
  eid('dsMatchReviewBtn')?.addEventListener('click', () => openMatchReview(p));
  eid('dsInSyncTableBtn')?.addEventListener('click', () => sftkShowInSyncRecords(p, scan));
  // 📎 Synced-tab file selection + direct move.
  const _fselBtnSync = () => {
    const btn = eid('dsRecMoveFiles');
    // Never re-arm mid-flight — a checkbox change during a move would
    // otherwise re-enable the button and allow a concurrent transfer whose
    // target-checksum snapshot predates the first run's writes (dup files).
    if (btn && !_fileMoveInFlight) { btn.disabled = !_recFileSel.size; btn.textContent = `📎 Move ${_recFileSel.size || ''} selected`; }
  };
  document.querySelectorAll('[data-rec-fsel]').forEach(cb => cb.addEventListener('change', () => {
    if (cb.checked) _recFileSel.add(cb.dataset.recFsel); else _recFileSel.delete(cb.dataset.recFsel);
    _fselBtnSync();
  }));
  document.querySelector('[data-rec-fsel-all]')?.addEventListener('click', () => {
    document.querySelectorAll('[data-rec-fsel]').forEach(cb => { cb.checked = true; _recFileSel.add(cb.dataset.recFsel); });
    _fselBtnSync();
  });
  document.querySelector('[data-rec-fsel-none]')?.addEventListener('click', () => {
    _recFileSel.clear();
    document.querySelectorAll('[data-rec-fsel]').forEach(cb => { cb.checked = false; });
    _fselBtnSync();
  });
  eid('dsRecMoveFiles')?.addEventListener('click', () => sftkMoveSelectedFiles(p, scan));
}

// ════════════════════════════════════════════════════════════════
// M3c — MATCH REVIEW: human pairing of unmatched rows → match memory
// ════════════════════════════════════════════════════════════════
// Left list: "in source only" rows. For the selected row, the right list
// shows the top-5 "in target only" candidates ranked by sftkPairSimilarity
// on the (already-normalized) match keys. The % is a RANKING HINT ONLY —
// nothing is ever paired automatically; [Pair ⇒] is the human decision.
// Pairing records srcId→tgtId via window.sftkLearnPairs (persistent match
// memory, per target org), removes both rows from the scan buckets in
// place, and re-renders the modal. Not offered on ephemeral profiles
// (ring/compare clones) — memory belongs to the saved deployment.
function openMatchReview(p) {
  const scan = p?.lastScan;
  if (!scan) return;
  const tgtKey = _orgKey(p.targetOrg || '');
  const lbl = k => esc(typeof sftkMatchKeyLabel === 'function' ? sftkMatchKeyLabel(k) : String(k ?? ''));
  let paired = 0;         // pairs made this modal session
  let selSrcId = null;    // selected "in source only" row
  let clearArmed = false; // two-click confirm for the clear-memory button

  function finish() {
    closeModal();
    if (paired > 0) {
      showToast(`${paired} pair(s) remembered — 🔄 Refresh state to see their drift status`, 'success', 6000);
      renderReconcile();
    }
  }

  function render() {
    const missing = scan.missingInTarget || [];
    const extras  = scan.onlyInTarget || [];
    const memN    = Object.keys((p.matchMemory || {})[tgtKey] || {}).length;
    clearArmed = false;
    if (!selSrcId || !missing.some(r => r.sourceId === selSrcId)) {
      selSrcId = missing.length ? missing[0].sourceId : null;
    }
    const selRow = missing.find(r => r.sourceId === selSrcId) || null;

    const listHtml = missing.length ? missing.map(r => `
      <div class="ds-mm-src" data-mm-src="${esc(r.sourceId)}"
        style="padding:5px 8px;cursor:pointer;border-bottom:1px solid rgba(128,128,128,.15);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap${r.sourceId === selSrcId ? ';background:#eef2ff;font-weight:600' : ''}"
        title="${lbl(r.matchKey)}">${lbl(r.matchKey)}</div>`).join('')
      : `<div class="ds-rec-col-empty" style="padding:10px">no unmatched source records 🎉</div>`;

    let candHtml;
    if (!selRow) {
      candHtml = `<div class="ds-rec-col-empty" style="padding:10px">select a source row on the left</div>`;
    } else if (!extras.length) {
      candHtml = `<div class="ds-rec-col-empty" style="padding:10px">no unmatched target records to pair with</div>`;
    } else {
      let ranked;
      try {
        ranked = extras
          .map(r => ({ r, sim: sftkPairSimilarity(String(selRow.matchKey ?? ''), String(r.matchKey ?? '')) }))
          .sort((a, b) => b.sim - a.sim)
          .slice(0, 5);
      } catch (_) {
        ranked = extras.slice(0, 5).map(r => ({ r, sim: 0 }));   // degrade: unranked
      }
      candHtml = ranked.map(c => `
        <div class="ds-mm-cand" style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-bottom:1px solid rgba(128,128,128,.15);font-size:12px">
          <span style="min-width:38px;text-align:right;color:var(--subtext);font-variant-numeric:tabular-nums" title="Key similarity — a ranking hint only, never an automatic match">${Math.round(c.sim * 100)}%</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${lbl(c.r.matchKey)}">${lbl(c.r.matchKey)}${c.r.orphan ? ' <span class="ds-chip">possible orphan</span>' : ''}</span>
          <button class="ds-btn ds-btn-xs ds-btn-primary" data-mm-pair="${esc(c.r.targetId)}"
            title="These two are the SAME record — remember the pair. Future scans match them by identity, even after renames.">Pair ⇒</button>
        </div>`).join('');
    }

    // L6 — Match review pairs rows out of the SHIPPED buckets, so on a capped
    // scan "no unmatched target records to pair with" can mean "none in the
    // slice", and the row you want may simply not be here. Say it once, at the
    // top; '' (and no banner) when the scan was complete.
    let mmCapNote = '';
    try {
      const mi = window.sftkScanBucketInfo(scan, 'missingInTarget');
      const ei = window.sftkScanBucketInfo(scan, 'onlyInTarget');
      if (mi.capped || ei.capped) {
        mmCapNote = `⚠ Both lists come from a TRUNCATED scan — in source only ${window.sftkBucketCountLabel(mi.shown, mi.total, mi.capped, mi.totalIsFloor)}, in target only ${window.sftkBucketCountLabel(ei.shown, ei.total, ei.capped, ei.totalIsFloor)}. `
          + `A record that isn't listed here has NOT been ruled out as a match — it was never loaded. Narrow the deployment's WHERE filter and re-scan to pair the rest.`;
      }
    } catch (_) { mmCapNote = ''; }

    showModal(`
      <div class="ds-modal-header">🔗 Match review — ${esc(scan.objectType || '')}</div>
      <div class="ds-modal-body">
        <p style="font-size:12px;color:var(--subtext);margin:0 0 10px">Pick a source record, then pair it with the target record it actually is (renamed, retyped, …). Pairs are remembered 🧠 per target org and matched by identity on every future scan. The % is a similarity <em>hint</em> — pairing is always your call.</p>
        ${mmCapNote ? `<div class="ds-rec-child-info ds-rec-cap-note" style="border-left:3px solid #f59e0b;padding-left:8px;margin:0 0 10px;font-size:12px">${esc(mmCapNote)}</div>` : ''}
        <div class="ds-mm-grid" style="display:flex;gap:12px;max-height:340px">
          <div style="flex:1;min-width:0;overflow:auto;border:1px solid rgba(128,128,128,.35);border-radius:6px">
            <div style="padding:5px 8px;font-weight:600;font-size:11px;position:sticky;top:0;background:inherit;border-bottom:1px solid rgba(128,128,128,.25)">🔴 In source only (${missing.length}${mmCapNote ? ' listed' : ''})</div>
            ${listHtml}
          </div>
          <div style="flex:1.25;min-width:0;overflow:auto;border:1px solid rgba(128,128,128,.35);border-radius:6px">
            <div style="padding:5px 8px;font-weight:600;font-size:11px;position:sticky;top:0;background:inherit;border-bottom:1px solid rgba(128,128,128,.25)">🔵 Closest "in target only" candidates${selRow ? ` for <em>${lbl(selRow.matchKey)}</em>` : ''}</div>
            ${candHtml}
          </div>
        </div>
      </div>
      <div class="ds-modal-footer" style="display:flex;gap:8px;align-items:center">
        <button class="ds-btn ds-btn-sm" id="dsMmClearMem" ${memN ? '' : 'disabled'}
          title="Forget every remembered pair for this target org — those records fall back to key matching on the next scan.">🧠 Clear memory for this org (${memN} remembered)</button>
        <span style="flex:1"></span>
        ${paired ? `<span class="ds-chip">🧠 ${paired} paired</span>` : ''}
        <button class="ds-btn ds-btn-primary" id="dsMmClose">Done</button>
      </div>`);

    document.querySelectorAll('[data-mm-src]').forEach(el =>
      el.addEventListener('click', () => { selSrcId = el.dataset.mmSrc; render(); }));

    document.querySelectorAll('[data-mm-pair]').forEach(btn =>
      btn.addEventListener('click', async () => {
        const tgtId  = btn.dataset.mmPair;
        const srcRow = (scan.missingInTarget || []).find(r => r.sourceId === selSrcId);
        const tgtRow = (scan.onlyInTarget || []).find(r => r.targetId === tgtId);
        if (!srcRow || !tgtRow) return;
        try {
          await window.sftkLearnPairs?.(p.id, p.targetOrg, [[srcRow.sourceId, tgtRow.targetId]]);
          // Remove BOTH rows from the scan buckets in place — the pair is no
          // longer "missing"/"extra". Its identical-vs-drift status needs a
          // rescan (the closing toast says so).
          const mi = (scan.missingInTarget || []).indexOf(srcRow);
          if (mi !== -1) scan.missingInTarget.splice(mi, 1);
          const ei = (scan.onlyInTarget || []).indexOf(tgtRow);
          if (ei !== -1) scan.onlyInTarget.splice(ei, 1);
          // Drop them from pending reconcile selections — running an Insert
          // (or Delete/Pull) against a just-paired record would duplicate it.
          _recSel.push.delete(srcRow.sourceId);
          _recSel.del.delete(tgtRow.targetId);
          _recSel.pull.delete(tgtRow.targetId);
          paired++;
          if (!p.ephemeral) await storageSaveProfiles();   // persist the bucket edit
        } catch (e) {
          showToast(`Couldn't record the pair: ${e?.message || e}`, 'error', 5000);
        }
        render();
      }));

    eid('dsMmClearMem')?.addEventListener('click', async () => {
      const b = eid('dsMmClearMem');
      if (!clearArmed) {
        clearArmed = true;
        if (b) {
          b.textContent = `⚠ Really forget ${memN} remembered pair(s)? Click again`;
          b.classList.add('ds-btn-danger');
        }
        return;
      }
      try {
        if (p.matchMemory) delete p.matchMemory[tgtKey];
        const real = _profiles.find(x => x.id === p.id);
        if (real && real !== p && real.matchMemory) delete real.matchMemory[tgtKey];
        await storageSaveProfiles();
        showToast('Match memory cleared for this org — the next scan matches by key only', 'success', 4500);
      } catch (e) {
        showToast(`Couldn't clear match memory: ${e?.message || e}`, 'error', 5000);
      }
      render();
    });

    eid('dsMmClose')?.addEventListener('click', finish);
  }
  render();
}

// Execute the selected reconcile actions. Deletes require a confirmation
// modal (destructive). Push reuses the transfer engine (root-only profile
// clone). Overwrite uses SF_COLLECTIONS_UPDATE.
async function runReconcile(profile, objType, buckets) {
  // ⛔ RUN GATE (user 2026-08-10: "the recommendation to sync parents first
  // is not strong enough") — the advisor's probe already knows when the
  // selected inserts are DOOMED (empty parent object behind a required
  // field) or will land with EMPTY lookups. A banner is advice; this is a
  // stop. Keyed to the current scan so a stale probe never gates.
  const _gap = (_recParentGapState && _recParentGapState.key === `${profile.id}|${profile.lastScan?.runAt}`)
    ? _recParentGapState : null;
  const _pushN = _recSel.push.size;
  if (_pushN && _gap?.doomed?.length) {
    if (!confirm(`⛔ STOP — all ${_pushN} selected insert(s) are GUARANTEED to fail.\n\n${_gap.doomed.join(' and ')} has NO records in ${orgLabel(profile.targetOrg)} and the lookup pointing there is REQUIRED.\n\nUse the numbered plan at the top: deploy the parent object first (one click), then run this.\n\nRun anyway? (every insert will fail)`)) return;
  } else if (_pushN && _gap?.empties?.length) {
    if (!confirm(`⚠ ${_gap.empties.join(' and ')} has NO records in ${orgLabel(profile.targetOrg)} — the lookups pointing there will land EMPTY on all ${_pushN} inserted record(s).\n\nDeploy the parents first (numbered plan up top) to get connected records.\n\nContinue anyway?`)) return;
  }
  const pushIds   = [..._recSel.push];
  const ovwIds    = [..._recSel.overwrite];
  const updSrcIds = [..._recSel.updSrc];
  const delIds    = [..._recSel.del];
  const pullIds   = [..._recSel.pull];

  // ── Child-aware selections (v1: Insert + Relink) ──────────────────────
  // Each selected child insert is partitioned by where its parent lives:
  //   group A — parent is missing in target too → the child rides a TREE
  //             transfer with its parent (auto-including parents the user
  //             didn't tick); the engine orders + reconnects.
  //   group B — parent already exists in target → child-rooted transfer
  //             with a match bridge on the link field (attached at insert).
  const rootScan         = profile.lastScan || {};
  const rootMissingSrc   = new Set((rootScan.missingInTarget || []).map(r => r.sourceId));
  const rootExistsSrcSet = new Set([...(rootScan.changed || []).map(r => r.sourceId),
                                    ...(rootScan.identical || []).map(r => r.sourceId)]);
  const childActs = Object.entries(_recChildSel)
    .map(([k, sel]) => ({ pathKey: k, node: getNodeByPath(profile.tree, k), sel,
                          cs: rootScan.children?.[k] }))
    .filter(a => a.node && a.cs && (a.sel.push.size || a.sel.relink.size || a.sel.overwrite?.size || a.sel.del?.size));
  for (const a of childActs) {
    a.groupA = []; a.groupB = []; a.autoParents = new Set(); a.skippedDeep = 0;
    // R5 — depth + parent context. Direct children ('0') use the ROOT scan's
    // buckets (v1, unchanged). Grandchildren ('0.1') use their PARENT child
    // scan's buckets, and only support push-with-existing-parent + relink —
    // tree-ride (group A) stays root+child. Any failure resolving the parent
    // context degrades to v1 root-based behavior.
    a.depth = String(a.pathKey).split('.').length;
    let pMissingSet = rootMissingSrc, pExistsSet = rootExistsSrcSet;
    a.parentObj = objType; a.parentScan = rootScan;
    if (a.depth > 1) {
      try {
        const pk    = String(a.pathKey).split('.').slice(0, -1).join('.');
        const pNode = getNodeByPath(profile.tree, pk);
        a.parentObj  = pNode?.objectType || pNode?.childSObject || objType;
        a.parentScan = rootScan.children?.[pk] || rootScan;
        pMissingSet  = new Set((a.parentScan.missingInTarget || []).map(r => r.sourceId));
        pExistsSet   = new Set([...(a.parentScan.changed || []).map(r => r.sourceId),
                                ...(a.parentScan.identical || []).map(r => r.sourceId)]);
      } catch (_) { a.parentObj = objType; a.parentScan = rootScan; }
    }
    for (const id of a.sel.push) {
      const row = (a.cs.missingInTarget || []).find(r => r.sourceId === id);
      if (!row) continue;
      if (row.parentSrcId && pMissingSet.has(row.parentSrcId)) {
        if (a.depth > 1) { a.skippedDeep++; continue; }   // R5 — no tree-ride at this depth
        a.groupA.push(id);
        if (!_recSel.push.has(row.parentSrcId)) a.autoParents.add(row.parentSrcId);
      } else if (!row.parentSrcId || pExistsSet.has(row.parentSrcId)) {
        a.groupB.push(id);   // parent exists in target (or record has no parent)
      }
      // parent untracked → row was disabled in the UI; unreachable here
    }
    // R4 — drift overwrites + target-only deletes, validated against the
    // child scan's buckets so stray ids can never reach the writers.
    a.ovwIds = [...(a.sel.overwrite || [])].filter(id => (a.cs.changed || []).some(r => r.sourceId === id));
    a.delIds = [...(a.sel.del || [])].filter(id => (a.cs.onlyInTarget || []).some(r => r.targetId === id));
  }
  const childDelTotal = childActs.reduce((s, a) => s + a.delIds.length, 0);
  const anyChildAct = childActs.some(a => a.groupA.length || a.groupB.length || a.sel.relink.size || a.ovwIds.length || a.delIds.length);

  if (!pushIds.length && !ovwIds.length && !updSrcIds.length && !delIds.length && !pullIds.length && !anyChildAct) return;

  // ── L6 — TRUNCATED-SET WRITE GUARD ───────────────────────────────────
  // Every id above was picked from a list the scan may have cut off at its
  // ship cap. "Insert 5,000" then means "insert the 5,000 rows I was shown",
  // not "insert everything that's missing" — and that difference is exactly
  // what decides whether the user has to run again. This does not block or
  // change the run; it refuses to let a truncated basis stay invisible at the
  // moment of writing. A complete scan produces no lines, no extra dialog and
  // no behaviour change at all.
  const capWarnLines = [];
  let capWarnTail = '';
  try {
    const rootKinds = [
      pushIds.length   ? 'push'      : null,
      ovwIds.length    ? 'overwrite' : null,
      updSrcIds.length ? 'updSrc'    : null,
      delIds.length    ? 'del'       : null,
      pullIds.length   ? 'pull'      : null
    ].filter(Boolean);
    const rootNote = window.sftkCappedWriteNote(rootScan, rootKinds, objType);
    for (const l of rootNote.lines) capWarnLines.push(l);
    if (rootNote.text) capWarnTail = rootNote.text;
    for (const a of childActs) {
      const obj = a.node.objectType || a.node.childSObject || 'child';
      const kinds = [
        (a.groupA.length || a.groupB.length) ? 'push'      : null,
        a.sel.relink.size                    ? 'relink'    : null,
        a.ovwIds.length                      ? 'overwrite' : null,
        a.delIds.length                      ? 'del'       : null
      ].filter(Boolean);
      const n = window.sftkCappedWriteNote(a.cs, kinds, obj);
      for (const l of n.lines) capWarnLines.push(`${obj} — ${l}`);
      if (n.text && !capWarnTail) capWarnTail = n.text;
      // A child scan can be complete in itself and still be scoped to a
      // TRUNCATED parent list — the rows it never saw are invisible to both.
      if (a.cs && a.cs.parentScopeNote) capWarnLines.push(`${obj} — ${a.cs.parentScopeNote}`);
    }
  } catch (_) { capWarnLines.length = 0; }   // never block a run on the warning builder
  const capWarnBlock = capWarnLines.length
    ? `<div style="margin-top:10px;padding:10px 12px;background:#fffbeb;border-left:3px solid #f59e0b;border-radius:4px;font-size:12px;color:#92400e">
         ⚠ <strong>This run is based on a TRUNCATED scan</strong>
         ${capWarnLines.map(l => `<div style="margin-top:6px">• ${esc(l)}</div>`).join('')}
         <div style="margin-top:8px">${esc(capWarnTail || 'This run acts on the listed rows ONLY. Re-scan after it finishes and run again until the counts stop shrinking.')}</div>
       </div>`
    : '';

  // ── Confirmation step ────────────────────────────────────────────────
  // If anything destructive (delete) or anything that writes to the SOURCE
  // org (pull insert / ← update) is selected, surface a single combined
  // confirm modal so the user sees the full impact before any writes happen.
  const isHard = _recDeleteMode === 'hard';

  // ── Production-org guard ──────────────────────────────────────────────
  // Hard delete is flatly disabled against production; regular deletes into
  // production require typing the org name (after the standard confirm).
  const tgtOrgType = await ensureOrgType(profile.targetOrg);
  if (tgtOrgType === 'production' && isHard && (delIds.length || childDelTotal)) {
    showToast('🔥 Hard delete is disabled against PRODUCTION orgs — switch Delete mode to Recycle Bin.', 'error', 7000);
    return;
  }

  // Numbered execution plan — mirrors the exact order the phases run in, so
  // what the user reads in the confirm modal is literally what happens.
  const planLines = [];
  if (anyChildAct) {
    let n = 1;
    const totalAutoParents = childActs.reduce((s, a) => s + a.autoParents.size, 0);
    const rootInsertTotal  = pushIds.length + totalAutoParents;
    // R2 — for master-detail links a run-scoped child-first override is
    // silently impossible (parent required at insert); the executor below
    // forces parent-first, so the plan must say the same.
    const actCf = (a) => a.depth === 1 && !a.cs?.linkMasterDetail &&
      (_recOrderOverride[a.pathKey] ?? a.node.insertOrder) === 'childFirst';
    for (const a of childActs) {
      if (a.delIds.length) planLines.push(`${n++}. Delete ${a.delIds.length} ${a.node.objectType || a.node.childSObject} from target (${isHard ? 'PERMANENT' : 'Recycle Bin'})`);
    }
    if (delIds.length) planLines.push(`${n++}. Delete ${delIds.length} ${objType} from target (${isHard ? 'PERMANENT' : 'Recycle Bin'})`);
    if (pullIds.length) planLines.push(`${n++}. Pull ${pullIds.length} ${objType} into source`);
    for (const a of childActs) {
      const obj = a.node.objectType || a.node.childSObject;
      if (a.groupA.length && actCf(a)) planLines.push(`${n++}. Insert ${a.groupA.length} ${obj} (child-first — created before their parents, without ${a.node.field})`);
    }
    if (rootInsertTotal) planLines.push(`${n++}. Insert ${rootInsertTotal} ${objType}${totalAutoParents ? ` (${totalAutoParents} parent(s) auto-included for selected children)` : ''}`);
    for (const a of childActs) {
      const obj  = a.node.objectType || a.node.childSObject;
      const pObj = a.parentObj || objType;
      const cf   = actCf(a);
      if (a.groupA.length && cf)  planLines.push(`${n++}. Reconnect ${a.groupA.length} ${obj} → ${objType} (link patched after the parents exist)`);
      if (a.groupA.length && !cf) planLines.push(`${n++}. Insert ${a.groupA.length} ${obj} under the new ${objType} (linked at insert)`);
      if (a.groupB.length)        planLines.push(`${n++}. Insert ${a.groupB.length} ${obj} under existing ${pObj} (matched by ${((a.parentScan || rootScan).matching?.fields || [(a.parentScan || rootScan).matchField || 'Name']).join(' + ')})`);
      if (a.sel.relink.size)      planLines.push(`${n++}. Relink ${a.sel.relink.size} ${obj} to the right ${pObj}`);
      if (a.ovwIds.length)        planLines.push(`${n++}. Update ${a.ovwIds.length} drifted ${obj} in target`);
    }
    if (ovwIds.length)    planLines.push(`${n++}. Update ${ovwIds.length} drifted ${objType} in target`);
    if (updSrcIds.length) planLines.push(`${n++}. Update ${updSrcIds.length} ${objType} in source`);
  }

  // L6 — a plain "Insert only" run used to write with NO confirmation at all.
  // That is still true when the scan was complete; when it wasn't, the guard
  // above has something to say, so the dialog opens to say it.
  if (delIds.length || pullIds.length || updSrcIds.length || anyChildAct || capWarnLines.length) {
    const ok = await new Promise(resolve => {
      const delBlock = delIds.length ? (isHard
        ? `<div style="margin-top:10px;padding:10px 12px;background:#fef2f2;border-left:3px solid #dc2626;border-radius:4px;font-size:12px;color:#991b1b">
             🔥 <strong>Hard-delete ${delIds.length} ${esc(objType)} record(s)</strong> from
             <strong>${esc(orgLabel(profile.targetOrg))}</strong> — purged from the Recycle Bin and
             <strong>cannot be recovered</strong>.</div>`
        : `<div style="margin-top:10px;padding:10px 12px;background:#fffbeb;border-left:3px solid #f59e0b;border-radius:4px;font-size:12px;color:#92400e">
             🗑 <strong>Delete ${delIds.length} ${esc(objType)} record(s)</strong> from
             <strong>${esc(orgLabel(profile.targetOrg))}</strong> — recoverable from the Recycle Bin for 15 days.</div>`) : '';
      // R4 — child deletes get their own warning block (they run FIRST).
      const childDelBlock = childDelTotal ? (isHard
        ? `<div style="margin-top:10px;padding:10px 12px;background:#fef2f2;border-left:3px solid #dc2626;border-radius:4px;font-size:12px;color:#991b1b">
             🔥 <strong>Hard-delete ${childDelTotal} child record(s)</strong> from
             <strong>${esc(orgLabel(profile.targetOrg))}</strong> — purged from the Recycle Bin and
             <strong>cannot be recovered</strong>.</div>`
        : `<div style="margin-top:10px;padding:10px 12px;background:#fffbeb;border-left:3px solid #f59e0b;border-radius:4px;font-size:12px;color:#92400e">
             🗑 <strong>Delete ${childDelTotal} child record(s)</strong> from
             <strong>${esc(orgLabel(profile.targetOrg))}</strong> — recoverable from the Recycle Bin for 15 days.</div>`) : '';
      const pullBlock = pullIds.length
        ? `<div style="margin-top:10px;padding:10px 12px;background:#eff6ff;border-left:3px solid #2563eb;border-radius:4px;font-size:12px;color:#1e3a8a">
             ← <strong>Pull ${pullIds.length} ${esc(objType)} record(s)</strong> into
             <strong>${esc(orgLabel(profile.sourceOrg))}</strong> (source). New rows will be inserted there.</div>`
        : '';
      const updSrcBlock = updSrcIds.length
        ? `<div style="margin-top:10px;padding:10px 12px;background:#eff6ff;border-left:3px solid #2563eb;border-radius:4px;font-size:12px;color:#1e3a8a">
             ← <strong>Update ${updSrcIds.length} ${esc(objType)} record(s)</strong> in
             <strong>${esc(orgLabel(profile.sourceOrg))}</strong> (source) with the target's values — the target wins those rows.</div>`
        : '';
      const title = (delIds.length || childDelTotal)
        ? (isHard ? '🔥 Confirm HARD delete' : '⚠ Confirm reconcile actions')
        : (anyChildAct && !pullIds.length && !updSrcIds.length)
          ? '⚖ Confirm the execution plan'
          : (!pullIds.length && !updSrcIds.length && capWarnLines.length)
            ? '⚠ Confirm — this run is based on a truncated scan'
            : '← Confirm writes into source';
      const planBlock = planLines.length
        ? `<div class="ds-rec-plan">
             <div class="ds-rec-plan-hdr">Execution plan — steps run in this exact order:</div>
             ${planLines.map(l => `<div class="ds-rec-plan-line">${esc(l)}</div>`).join('')}
           </div>`
        : '';
      showModal(`
        <div class="ds-modal-header">${title}</div>
        <div class="ds-modal-body">
          Review the changes before continuing:
          ${capWarnBlock}
          ${planBlock}
          ${pullBlock}
          ${updSrcBlock}
          ${childDelBlock}
          ${delBlock}
        </div>
        <div class="ds-modal-footer">
          <button class="ds-btn" id="dsRecDelCancel">Cancel</button>
          <button class="ds-btn ${(delIds.length || childDelTotal) ? 'ds-btn-danger' : 'ds-btn-primary'}" id="dsRecDelOk">Proceed</button>
        </div>`);
      eid('dsRecDelCancel')?.addEventListener('click', () => { closeModal(); resolve(false); });
      eid('dsRecDelOk')?.addEventListener('click', () => { closeModal(); resolve(true); });
    });
    if (!ok) return;
  }

  // Deletes into a PRODUCTION org additionally require typing the org name.
  // Child deletes (R4) go through the SAME typed confirmation as root deletes.
  if ((delIds.length || childDelTotal) && tgtOrgType === 'production') {
    const what = [
      delIds.length ? `${delIds.length} ${objType}` : null,
      childDelTotal ? `${childDelTotal} child` : null
    ].filter(Boolean).join(' + ');
    const okProd = await confirmTypedProd(orgLabel(profile.targetOrg), `delete ${what} record(s)`);
    if (!okProd) return;
  }

  const prog = eid('dsRecProgress');
  const log = (icon, msg, cls = '') => {
    if (!prog) return;
    const row = document.createElement('div');
    row.className = `ds-prog-row ${cls}`;
    row.textContent = `${icon} ${msg}`;
    prog.appendChild(row);
  };
  if (prog) prog.innerHTML = '<div class="ds-prog-hdr">Reconcile progress</div>';
  const runBtn = eid('dsRecRunBtn'); if (runBtn) runBtn.disabled = true;

  const allSess = _buildAllSessions();
  const srcSess = _resolveSession(profile.sourceOrg, allSess);
  const tgtSess = _resolveSession(profile.targetOrg, allSess);
  if (!srcSess?.sid || !tgtSess?.sid) {
    log('❌', 'Source or target org session not active — open both in Chrome tabs.', 'ds-prog-err');
    if (runBtn) runBtn.disabled = false;
    return;
  }

  // Stream the engine's per-batch progress into the reconcile log (also
  // keeps the worker alive across the multi-phase pipeline).
  const recPort = _openRunPort(_runProgressHandler(prog));

  // Per-action counters — captured into a History entry at the end so the
  // History view can show what was actually inserted/updated/deleted, not
  // just "errors". Hard-delete tracks the bin-purge count separately.
  const startedAt = new Date().toISOString();
  const counts = { inserted: 0, updated: 0, deleted: 0, purged: 0, pulled: 0, updatedSource: 0,
                   insertedFailed: 0, updatedFailed: 0, deletedFailed: 0, pulledFailed: 0, updatedSourceFailed: 0 };
  // Per-child-object counters — merged into the History summary alongside
  // the root object's counts.
  const childCounts = {};
  const bumpChild = (obj, key, by) => {
    if (!childCounts[obj]) childCounts[obj] = { created: 0, failed: 0, connected: 0, connectFailed: 0, relinked: 0, relinkFailed: 0,
                                                overwritten: 0, overwriteFailed: 0, deleted: 0, deleteFailed: 0 };
    childCounts[obj][key] += by;
  };
  // Written-record refs ({id, label}) for History links, per object.
  const rootTargets = [];
  // Failure refs: failed INSERTS link to the SOURCE record (nothing exists in
  // target); failed UPDATES link to the TARGET record (PATCH refused).
  const rootFailedInserts = [];
  const rootFailedUpdates = [];
  const allErrors = [];

  // R5 — grandchild rows whose parent is missing in the target were skipped
  // at partition time (tree-ride isn't supported at that depth). Say so.
  for (const a of childActs) {
    if (!a.skippedDeep) continue;
    const m = `⚠ ${a.node.objectType || a.node.childSObject}: ${a.skippedDeep} selected row(s) skipped — their parent isn't in the target yet and tree-ride inserts aren't supported at this depth; insert the parent level first, rescan, then re-run`;
    allErrors.push(m); log('⚠', m, 'ds-prog-warn');
  }

  // ── 0. Child deletes (R4) — run BEFORE the root delete so children go
  // first (FK-safe), through the SAME delete modes and prod guards as the
  // root (typed prod confirm + hard-delete block already covered both above).
  for (const a of childActs) {
    if (!a.delIds.length) continue;
    const obj = a.node.objectType || a.node.childSObject;
    try {
      if (isHard) {
        log('🔥', `Hard-deleting ${a.delIds.length} ${obj} from target…`);
        const res = await sendBg({ type: 'SF_HARD_DELETE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, ids: a.delIds });
        const okN   = (res.deleteResults || []).filter(r => r.success).length;
        const failN = (res.deleteResults || []).length - okN;
        bumpChild(obj, 'deleted', okN); bumpChild(obj, 'deleteFailed', failN);
        counts.purged += (res.purgedOk || 0);
        log(failN ? '⚠' : '✅', `${obj}: deleted ${okN}${failN ? `, ${failN} failed` : ''} → purged ${res.purgedOk || 0} from Recycle Bin`, failN ? 'ds-prog-err' : '');
        (res.purgeErrors || []).slice(0, 3).forEach(e => { allErrors.push(`purge ${obj}: ${e}`); log('  ⚠', `purge: ${e}`, 'ds-prog-warn'); });
        (res.deleteResults || []).filter(r => !r.success).slice(0, 5).forEach(r => {
          const m = (r.errors || []).map(x => x.message).join('; ');
          if (m) allErrors.push(`delete ${obj} ${r.id || ''}: ${m}`);
        });
      } else {
        log('🗑', `Deleting ${a.delIds.length} ${obj} from target (→ Recycle Bin)…`);
        const res = await sendBg({ type: 'SF_COLLECTIONS_DELETE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, ids: a.delIds });
        const okN   = (res || []).filter(r => r.success).length;
        const failN = (res || []).length - okN;
        bumpChild(obj, 'deleted', okN); bumpChild(obj, 'deleteFailed', failN);
        log(failN ? '⚠' : '✅', `${obj}: deleted ${okN}${failN ? `, ${failN} failed` : ''}`, failN ? 'ds-prog-err' : '');
        (res || []).filter(r => !r.success).slice(0, 5).forEach(r => {
          const m = (r.errors || []).map(x => x.message).join('; ');
          if (m) allErrors.push(`delete ${obj} ${r.id || ''}: ${m}`);
        });
      }
    } catch (e) { allErrors.push(`Delete ${obj} failed: ${e?.message || e}`); log('❌', `Delete ${obj} failed: ${e?.message || e}`, 'ds-prog-err'); }
  }

  // ── 1. Delete extras (regular → Recycle Bin, or hard → purge) ────────
  if (delIds.length) {
    if (isHard) {
      log('🔥', `Hard-deleting ${delIds.length} record(s) from target…`);
      try {
        const res = await sendBg({ type: 'SF_HARD_DELETE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, ids: delIds });
        const delOk   = (res.deleteResults || []).filter(r => r.success).length;
        const delFail = (res.deleteResults || []).length - delOk;
        counts.deleted += delOk; counts.deletedFailed += delFail; counts.purged += (res.purgedOk || 0);
        log(delFail ? '⚠' : '✅', `Deleted ${delOk}${delFail ? `, ${delFail} failed` : ''} → purged ${res.purgedOk || 0} from Recycle Bin`, delFail ? 'ds-prog-err' : '');
        (res.purgeErrors || []).slice(0, 3).forEach(e => { allErrors.push(`purge: ${e}`); log('  ⚠', `purge: ${e}`, 'ds-prog-warn'); });
        (res.deleteResults || []).filter(r => !r.success).slice(0, 5).forEach(r => {
          const m = (r.errors || []).map(x => x.message).join('; ');
          if (m) allErrors.push(`delete ${r.id || ''}: ${m}`);
        });
      } catch (e) { allErrors.push(`Hard delete failed: ${e?.message || e}`); log('❌', `Hard delete failed: ${e?.message || e}`, 'ds-prog-err'); }
    } else {
      log('🗑', `Deleting ${delIds.length} record(s) from target (→ Recycle Bin)…`);
      try {
        const res = await sendBg({ type: 'SF_COLLECTIONS_DELETE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, ids: delIds });
        const ok = (res || []).filter(r => r.success).length;
        const fail = (res || []).length - ok;
        counts.deleted += ok; counts.deletedFailed += fail;
        log(fail ? '⚠' : '✅', `Deleted ${ok}${fail ? `, ${fail} failed` : ''}`, fail ? 'ds-prog-err' : '');
        (res || []).filter(r => !r.success).slice(0, 5).forEach(r => {
          const m = (r.errors || []).map(x => x.message).join('; ');
          if (m) allErrors.push(`delete ${r.id || ''}: ${m}`);
        });
      } catch (e) { allErrors.push(`Delete failed: ${e?.message || e}`); log('❌', `Delete failed: ${e?.message || e}`, 'ds-prog-err'); }
    }
  }

  // ── 2. Pull target-only rows into source (Phase 3B) ──────────────────
  // Same transfer engine, but src/tgt swapped. Field mappings are inverted
  // so { srcFld → tgtFld } applied during push becomes { tgtFld → srcFld }
  // during pull. Only the root object — children stay in their own org.
  if (pullIds.length) {
    log('←', `Pulling ${pullIds.length} record(s) from target into source…`);
    try {
      const pullProfile = JSON.parse(JSON.stringify(profile));
      const fm = pullProfile.tree?.fieldMappings || {};
      const inverseFm = {};
      // Keep null EXCLUSIONS when inverting — `if (t)` alone dropped them,
      // and an absent mapping means identity passthrough in the executor,
      // so deliberately-excluded fields were copied into the source on Pull.
      for (const [s, t] of Object.entries(fm)) {
        if (t === null) inverseFm[s] = null;
        else if (t) inverseFm[t] = s;
      }
      pullProfile.tree.fieldMappings = inverseFm;
      pullProfile.tree.recordIds = pullIds;
      pullProfile.tree.children  = [];
      // Swap the profile's orgs so anything downstream that inspects them
      // (logging, lookup-bridge resolution, error messages) sees the
      // reverse direction consistently.
      pullProfile.sourceOrg = profile.targetOrg;
      pullProfile.targetOrg = profile.sourceOrg;
      const res = await sendBg({
        type: 'SF_EXECUTE_PROFILE_TRANSFER',
        profile: pullProfile,
        srcOrgUrl: tgtSess.orgUrl, srcSid: tgtSess.sid,   // read from TARGET
        tgtOrgUrl: srcSess.orgUrl, tgtSid: srcSess.sid    // write to SOURCE
      });
      const s = res.summary?.[objType] || {};
      counts.pulled       += (s.created || 0);
      counts.pulledFailed += (s.failed  || 0);
      log(s.failed ? '⚠' : '✅', `Pulled ${s.created || 0}${s.failed ? `, ${s.failed} failed` : ''} into source`, s.failed ? 'ds-prog-err' : '');
      (res.errors || []).forEach(e => allErrors.push(`pull: ${e}`));
      (res.errors || []).slice(0, 5).forEach(e => log('  ❌', e, 'ds-prog-err'));
    } catch (e) { allErrors.push(`Pull failed: ${e?.message || e}`); log('❌', `Pull failed: ${e?.message || e}`, 'ds-prog-err'); }
  }

  // ── 3. Push missing (insert) — delegate to the transfer engine ────────
  // With child selections this is a real TREE run: the pruned profile keeps
  // the root plus each child node with group-A rows (parents being inserted
  // this run), per-node recordIds, and the run-scoped insert order. The
  // engine does the rest — child-first hoisting, scoping, and the reconnect
  // step — exactly like a normal deployment.
  const treePushIds = [...new Set([...pushIds, ...childActs.flatMap(a => [...a.autoParents])])];
  const groupATotal = childActs.reduce((s, a) => s + a.groupA.length, 0);
  if (treePushIds.length || groupATotal) {
    const autoN = treePushIds.length - pushIds.length;
    log('⬆', `Pushing ${treePushIds.length} ${objType}${autoN > 0 ? ` (${autoN} parent(s) auto-included)` : ''}${groupATotal ? ` + ${groupATotal} child record(s)` : ''} to target…`);
    try {
      const pushProfile = JSON.parse(JSON.stringify(profile));
      delete pushProfile.lastScan;
      pushProfile.tree.recordIds = treePushIds;
      pushProfile.tree.children  = (profile.tree.children || []).map((c, i) => {
        const a = childActs.find(x => x.pathKey === String(i));
        if (!a || !a.groupA.length) return null;      // no group-A rows → drop node
        const cc = JSON.parse(JSON.stringify(c));
        cc.recordIds = a.groupA;
        cc.children  = [];                            // tree-ride stays one level deep (grandchildren go via group B)
        const ord = _recOrderOverride[a.pathKey] ?? c.insertOrder;
        if (ord === 'childFirst') {
          // R2 — master-detail links require the parent at insert: child-first
          // is impossible, so force the default order and say why.
          if (a.cs?.linkMasterDetail) {
            allErrors.push(`⚠ ${cc.objectType || cc.childSObject}: child-first ignored — ${cc.field || 'the link'} is a master-detail relationship (parent required at insert); running parent-first instead`);
            delete cc.insertOrder;
          } else {
            cc.insertOrder = 'childFirst';
          }
        } else delete cc.insertOrder;
        return cc;
      }).filter(Boolean);
      const res = await sendBg({
        type: 'SF_EXECUTE_PROFILE_TRANSFER',
        profile: pushProfile,
        srcOrgUrl: srcSess.orgUrl, srcSid: srcSess.sid,
        tgtOrgUrl: tgtSess.orgUrl, tgtSid: tgtSess.sid
      });
      const s = res.summary?.[objType] || {};
      // M3c — remember the srcId→tgtId pairs this push just created (root
      // object). sftkLearnPairs no-ops for ephemeral profile ids; the guard
      // mirrors runTransfer's (reconcile always runs the profile's own pair,
      // but ephemeral ring clones override sourceOrg — belt and braces).
      try {
        if (s.idPairs?.length && !profile.ephemeral
            && _orgKey(srcSess.orgUrl) === _orgKey(profile.sourceOrg || '')) {
          await window.sftkLearnPairs?.(profile.id, tgtSess.orgUrl, s.idPairs);
        }
        delete s.idPairs;
      } catch (_) { /* memory is an optimization — never fail the run */ }
      // Upsert split (engine reports Salesforce's per-row verdict): rows the
      // upsert UPDATED land in the updated count, not "inserted" — an
      // 1,850-row pure-update run must never read "1850 inserted".
      if (s.upsertCreated != null || s.upsertUpdated != null) {
        counts.inserted += (s.upsertCreated || 0);
        counts.updated  += (s.upsertUpdated || 0);
      } else {
        counts.inserted += (s.created || 0);
      }
      counts.insertedFailed += (s.failed || 0);
      rootTargets.push(...(s.targetRecords || []));
      rootFailedInserts.push(...(s.failedSourceIds || []));
      log(s.failed ? '⚠' : '✅', `${s.upsertUpdated ? `Upserted ${s.created || 0} ${objType} (${s.upsertCreated || 0} created, ${s.upsertUpdated} updated)` : `Inserted ${s.created || 0} ${objType}`}${s.failed ? `, ${s.failed} failed` : ''}`, s.failed ? 'ds-prog-err' : '');
      for (const a of childActs) {
        if (!a.groupA.length) continue;
        const obj  = a.node.objectType || a.node.childSObject;
        if (obj === objType) continue;   // self-relationship: counts already in root line
        const cSum = res.summary?.[obj] || {};
        bumpChild(obj, 'created', cSum.created || 0);
        bumpChild(obj, 'failed',  cSum.failed  || 0);
        bumpChild(obj, 'connected', cSum.connected || 0);
        bumpChild(obj, 'connectFailed', cSum.connectFailed || 0);
        if (cSum.targetRecords?.length) {
          childCounts[obj].targetRecords = (childCounts[obj].targetRecords || []).concat(cSum.targetRecords);
        }
        if (cSum.failedSourceIds?.length) {
          childCounts[obj].failedSourceIds = (childCounts[obj].failedSourceIds || []).concat(cSum.failedSourceIds);
        }
        log('  ' + (cSum.failed ? '⚠' : '✅'),
          `${obj}: ${cSum.created || 0} created${cSum.connected ? `, ${cSum.connected} linked to parent` : ''}${cSum.connectOrphaned ? `, ${cSum.connectOrphaned} unlinked (parent failed)` : ''}${cSum.failed ? `, ${cSum.failed} failed` : ''}`,
          cSum.failed ? 'ds-prog-err' : '');
      }
      (res.errors || []).forEach(e => allErrors.push(`insert: ${e}`));
      (res.errors || []).slice(0, 5).forEach(e => log('  ❌', e, 'ds-prog-err'));
    } catch (e) { allErrors.push(`Push failed: ${e?.message || e}`); log('❌', `Push failed: ${e?.message || e}`, 'ds-prog-err'); }
  }

  // ── 3b. Group-B child inserts — parent already exists in target ───────
  // Child-rooted transfer with the link field seeded as a match bridge, so
  // each record attaches to its pre-existing parent at insert time.
  for (const a of childActs) {
    if (!a.groupB.length) continue;
    const obj = a.node.objectType || a.node.childSObject;
    // R5 — the match bridge points at the node's ACTUAL parent: the root for
    // direct children (v1, identical values), the parent CHILD node + its
    // scan's match field for grandchildren.
    const pObj   = a.parentObj || objType;
    // M3a — the bridge's match field comes from the parent SCAN's stored
    // matching config (scan.matching, first source component) so it can't
    // diverge from the keys the scan matched on. The transfer engine resolves
    // a 'match' bridge by ONE exact-value field, so composite/normalized
    // configs degrade to first-component exact matching — warn instead of
    // silently pretending full fidelity.
    const pScanM = (a.parentScan || rootScan).matching || null;
    const pMatch = pScanM?.fields?.[0] || (a.parentScan || rootScan).matchField || 'Name';
    if (pScanM && ((pScanM.fields || []).length > 1 || Object.values(pScanM.normalize || {}).some(Boolean))) {
      const mW = `⚠ ${obj}: parent matching uses ${(pScanM.fields || []).length > 1 ? 'a composite key' : 'normalization'} — the insert bridge attaches by ${pMatch} with exact values (engine limit), so parents that differ only ${(pScanM.fields || []).length > 1 ? 'in later key components' : 'by case/spacing'} may not attach`;
      allErrors.push(mW); log('⚠', mW, 'ds-prog-warn');
    }
    log('⬆', `Inserting ${a.groupB.length} ${obj} under existing ${pObj} (matched by ${pMatch})…`);
    try {
      const bProfile = JSON.parse(JSON.stringify(profile));
      delete bProfile.lastScan;
      bProfile.tree = {
        objectType: obj,
        where: '',
        recordIds: a.groupB,
        children: [],
        fieldMappings: a.node.fieldMappings || {},
        lookupResolutions: {
          ...(a.node.lookupResolutions || {}),
          [a.node.field]: { strategy: 'match', matchObject: pObj, matchField: pMatch }
        }
      };
      const res = await sendBg({
        type: 'SF_EXECUTE_PROFILE_TRANSFER',
        profile: bProfile,
        srcOrgUrl: srcSess.orgUrl, srcSid: srcSess.sid,
        tgtOrgUrl: tgtSess.orgUrl, tgtSid: tgtSess.sid
      });
      const s2 = res.summary?.[obj] || {};
      // Same upsert split as the root push — upsert-updates are not creates.
      if (s2.upsertCreated != null || s2.upsertUpdated != null) {
        bumpChild(obj, 'created', s2.upsertCreated || 0);
        bumpChild(obj, 'overwritten', s2.upsertUpdated || 0);
      } else {
        bumpChild(obj, 'created', s2.created || 0);
      }
      bumpChild(obj, 'failed',  s2.failed  || 0);
      if (s2.targetRecords?.length) {
        childCounts[obj].targetRecords = (childCounts[obj].targetRecords || []).concat(s2.targetRecords);
      }
      if (s2.failedSourceIds?.length) {
        childCounts[obj].failedSourceIds = (childCounts[obj].failedSourceIds || []).concat(s2.failedSourceIds);
      }
      log(s2.failed ? '⚠' : '✅', `${obj}: ${s2.created || 0} created under existing parents${s2.failed ? `, ${s2.failed} failed` : ''}`, s2.failed ? 'ds-prog-err' : '');
      (res.errors || []).forEach(e => allErrors.push(`insert ${obj}: ${e}`));
      (res.errors || []).slice(0, 5).forEach(e => log('  ❌', e, 'ds-prog-err'));
    } catch (e) { allErrors.push(`Insert ${obj} failed: ${e?.message || e}`); log('❌', `Insert ${obj} failed: ${e?.message || e}`, 'ds-prog-err'); }
  }

  // ── 3c. Relink — re-point existing children at the right parent ───────
  // Fresh target-parent resolution by key (so parents inserted seconds ago
  // count), then chunked PATCHes of the child's link field. Rows whose
  // parent still isn't in the target are SKIPPED — never nulled.
  for (const a of childActs) {
    if (!a.sel.relink.size) continue;
    const obj       = a.node.objectType || a.node.childSObject;
    const linkField = a.node.field;
    // R2 — master-detail links that aren't reparentable can't be PATCHed:
    // Salesforce rejects the update. Skip defensively with a warning (the UI
    // disables these toggles, but stale in-session selections could linger).
    if (a.cs?.linkMasterDetail && a.cs?.linkUpdateable === false) {
      const m = `⚠ relink ${obj}: skipped — ${linkField} is a master-detail relationship that isn't reparentable (Salesforce blocks changing it after insert)`;
      allErrors.push(m); log('⚠', m, 'ds-prog-warn');
      continue;
    }
    const fmLink    = a.node.fieldMappings ? a.node.fieldMappings[linkField] : undefined;
    if (fmLink === null) {
      allErrors.push(`relink ${obj}: the link field ${linkField} is excluded by the field mapping — nothing to patch`);
      continue;
    }
    const tgtLinkField = fmLink || linkField;
    const rows = (a.cs.linkMismatch || []).filter(r => a.sel.relink.has(r.targetId));
    if (!rows.length) continue;
    // R5 — resolve parents against the node's ACTUAL parent object/scan: the
    // root for direct children (identical to v1), the parent child node for
    // grandchildren.
    const relParentObj  = a.parentObj || objType;
    const relParentScan = a.parentScan || rootScan;
    log('⇄', `Relinking ${rows.length} ${obj} in target…`);
    try {
      // M3a — parent resolution honors the parent scan's STORED matching
      // config (scan.matching), so relink resolves parents with EXACTLY the
      // keys the scan matched on. Composite/normalized configs: query
      // candidates by the FIRST target component IN (raw first-component
      // values), then client-filter by FULL sftkMatchKey equality — SOQL
      // text '=' is case-insensitive, JS is not, so normalization has to be
      // applied in the client-side comparison, never trusted to the query.
      // Legacy scans without .matching resolve through the same builder with
      // the single stored matchField (byte-identical to the old behavior
      // when no normalization is configured).
      const pm = relParentScan.matching || null;
      const pmSrcFields = (pm?.fields || []).length ? pm.fields : [relParentScan.matchField || 'Name'];
      const pmTgtFields = (pm?.tgtFields || []).length ? pm.tgtFields
        : [relParentScan.matchFieldTgt || relParentScan.matchField || 'Name'];
      const pmNorm   = pm?.normalize || {};
      const tgtMatch = pmTgtFields[0];

      // PII fail-closed: relink embeds RAW source parent-key values in a
      // target-org SOQL IN-list (visible in that org's API/event logs). When
      // any match component is under the profile's PII policy, skip this
      // object's relink and say so — the deployment engine's masked anchor
      // bridge is the supported path for masked seeds.
      const piiPol = profile?.piiPolicy || {};
      const piiCoveredAnchor = pmSrcFields.find(f => Object.keys(piiPol).some(k =>
        piiPol[k] && k.toLowerCase() === `${String(relParentObj)}.${String(f)}`.toLowerCase()));
      if (piiCoveredAnchor) {
        const mW = `🔒 relink ${obj}: parent matching uses ${relParentObj}.${piiCoveredAnchor}, which is under the PII policy — skipped so raw values never reach the target org; deploy through the engine's masked bridge instead`;
        allErrors.push(mW); log('🔒', mW, 'ds-prog-warn');
        continue;
      }

      // Full source-side parent key per child row. linkMismatch rows carry
      // only the FIRST component (parentKeySrc), so for composite configs
      // every component is re-read via the link's dot-path. Any failure
      // degrades to first-component matching with a warning.
      const srcKeyByChild = new Map();   // child sourceId → full parent key
      let fullKeys = false;
      try {
        const cd = await describe(obj, srcSess.orgUrl, srcSess.sid);
        const lf = (cd?.fields || []).find(f => f.name === linkField);
        if (lf?.relationshipName) {
          const rel  = lf.relationshipName;
          const cIds = rows.map(r => r.sourceId).filter(Boolean);
          for (let ci = 0; ci < cIds.length; ci += 200) {
            const idLit = cIds.slice(ci, ci + 200).map(id => soqlStrLit(id)).join(',');
            const q0 = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: srcSess.orgUrl, sid: srcSess.sid, tooling: false,
              query: `SELECT Id, ${pmSrcFields.map(f => `${rel}.${f}`).join(', ')} FROM ${obj} WHERE Id IN (${idLit})` });
            if (q0?.error) throw new Error(q0.error);
            for (const rec of (q0.records || [])) {
              srcKeyByChild.set(rec.Id, rec[rel]
                ? sftkMatchKey(rec[rel], { fields: pmSrcFields, normalize: pmNorm }) : '');
            }
          }
          fullKeys = true;
        }
      } catch (e0) {
        window.SFToolkitDebug?.log('scan', 'warn',
          `relink ${obj}: couldn't rebuild full parent keys from the source — falling back to first-component matching`,
          e0?.message || String(e0));
      }
      if (!fullKeys && pmSrcFields.length > 1) {
        const mW = `⚠ relink ${obj}: parent matching is a composite key but only its first component (${pmSrcFields[0]}) could be read — matching by that component alone`;
        allErrors.push(mW); log('⚠', mW, 'ds-prog-warn');
      }

      // Candidate fetch by FIRST component; candidates indexed by the SAME
      // key form the source side uses (full when available, else component 1).
      const keys = [...new Set(rows.map(r => r.parentKeySrc).filter(Boolean))];
      const parentByKey = new Map();     // normalized key → target parent Id
      for (let ci = 0; ci < keys.length; ci += 100) {
        const lit = keys.slice(ci, ci + 100).map(v => soqlStrLit(v)).join(',');
        const q = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, tooling: false,
          query: `SELECT Id, ${pmTgtFields.join(', ')} FROM ${relParentObj} WHERE ${tgtMatch} IN (${lit})` });
        if (q?.error) throw new Error(q.error);
        for (const rec of (q.records || [])) {
          const kk = fullKeys
            ? sftkMatchKey(rec, { fields: pmTgtFields, normalize: pmNorm })
            : sftkMatchKey(rec, { fields: [tgtMatch], normalize: pmNorm });
          if (kk && !parentByKey.has(kk)) parentByKey.set(kk, rec.Id);
        }
      }
      const updates = [];
      let skippedNoParent = 0;
      for (const r of rows) {
        const wantKey = fullKeys
          ? (srcKeyByChild.get(r.sourceId) || '')
          : (r.parentKeySrc ? sftkNormalizeValue(r.parentKeySrc, pmNorm) : '');
        const pid = wantKey ? parentByKey.get(wantKey) : null;
        if (!pid) { skippedNoParent++; continue; }
        updates.push({ attributes: { type: obj }, Id: r.targetId, [tgtLinkField]: pid });
      }
      let ok = 0, fail = 0;
      for (let ci = 0; ci < updates.length; ci += 200) {
        try {
          const res = await sendBg({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
            records: updates.slice(ci, ci + 200) });
          (Array.isArray(res) ? res : []).forEach(rr => {
            if (rr.success) ok++;
            else { fail++; allErrors.push(`relink ${obj}: ${(rr.errors || []).map(x => x.message).join('; ')}`); }
          });
        } catch (e2) {
          fail += Math.min(200, updates.length - ci);
          allErrors.push(`relink ${obj}: ${e2?.message || e2}`);
        }
      }
      bumpChild(obj, 'relinked', ok);
      bumpChild(obj, 'relinkFailed', fail);
      if (skippedNoParent) allErrors.push(`relink ${obj}: ${skippedNoParent} skipped — their parent isn't in the target yet (insert it first)`);
      log(fail ? '⚠' : '✅', `Relinked ${ok} ${obj}${fail ? `, ${fail} failed` : ''}${skippedNoParent ? `, ${skippedNoParent} skipped (no parent in target)` : ''}`, fail ? 'ds-prog-err' : '');
    } catch (e) { allErrors.push(`Relink ${obj} failed: ${e?.message || e}`); log('❌', `Relink ${obj} failed: ${e?.message || e}`, 'ds-prog-err'); }
  }

  // ── 3d. Child overwrites (R4) — update drifted child records in target,
  // scoped to the CHILD node's fieldMappings. Reuses reconcileOverwrite with
  // a child-rooted profile clone (it reads profile.tree as its node), driven
  // by the child scan's drift bucket. Failures degrade to a warning; the
  // rest of the run continues.
  for (const a of childActs) {
    if (!a.ovwIds.length) continue;
    const obj = a.node.objectType || a.node.childSObject;
    log('✏', `Updating ${a.ovwIds.length} drifted ${obj} in target…`);
    try {
      const cProfile = JSON.parse(JSON.stringify(profile));
      delete cProfile.lastScan;
      cProfile.tree = {
        objectType: obj,
        where: '',
        children: [],
        fieldMappings: a.node.fieldMappings || {},
        lookupResolutions: a.node.lookupResolutions || {}
      };
      const result = await reconcileOverwrite(cProfile, obj, a.ovwIds, a.cs.changed || [], srcSess, tgtSess);
      bumpChild(obj, 'overwritten',     result.ok     || 0);
      bumpChild(obj, 'overwriteFailed', result.failed || 0);
      log(result.failed ? '⚠' : '✅', `${obj}: updated ${result.ok || 0}${result.failed ? `, ${result.failed} failed` : ''}`, result.failed ? 'ds-prog-err' : '');
      (result.errors || []).forEach(e2 => allErrors.push(`update ${obj}: ${e2}`));
      (result.errors || []).slice(0, 5).forEach(e2 => log('  ❌', e2, 'ds-prog-err'));
    } catch (e) { allErrors.push(`⚠ Update ${obj} failed: ${e?.message || e}`); log('❌', `Update ${obj} failed: ${e?.message || e}`, 'ds-prog-err'); }
  }

  // ── 4. Overwrite drift (update target with source values) ────────────
  if (ovwIds.length) {
    log('✏', `Updating ${ovwIds.length} drifted record(s) in target…`);
    try {
      const result = await reconcileOverwrite(profile, objType, ovwIds, buckets.drift, srcSess, tgtSess);
      counts.updated += (result.ok || 0); counts.updatedFailed += (result.failed || 0);
      rootTargets.push(...(result.updatedRecords || []));
      rootFailedUpdates.push(...(result.failedRecords || []));
      log(result.failed ? '⚠' : '✅', `Updated ${result.ok}${result.failed ? `, ${result.failed} failed` : ''}`, result.failed ? 'ds-prog-err' : '');
      (result.errors || []).forEach(e => allErrors.push(`update: ${e}`));
      (result.errors || []).slice(0, 5).forEach(e => log('  ❌', e, 'ds-prog-err'));
    } catch (e) { allErrors.push(`Overwrite failed: ${e?.message || e}`); log('❌', `Overwrite failed: ${e?.message || e}`, 'ds-prog-err'); }
  }

  // ── 4b. Reverse drift (update SOURCE with target values, 3B v2) ───────
  // Same engine as step 4 with everything mirrored: profile clone gets
  // inverted fieldMappings + swapped orgs, the drift bucket swaps
  // sourceId/targetId per row, and the sessions swap roles — so
  // reconcileOverwrite "reads from source, patches target" becomes
  // "reads from target, patches source" without touching its internals.
  if (updSrcIds.length) {
    log('←', `Updating ${updSrcIds.length} drifted record(s) in source with target values…`);
    try {
      const invProfile = JSON.parse(JSON.stringify(profile));
      const fm = invProfile.tree?.fieldMappings || {};
      const invFm = {};
      for (const [s, t] of Object.entries(fm)) {
        if (t === null) invFm[s] = null;       // keep exclusions on inversion
        else if (t) invFm[t] = s;
      }
      invProfile.tree.fieldMappings = invFm;
      invProfile.sourceOrg = profile.targetOrg;
      invProfile.targetOrg = profile.sourceOrg;
      const sel = new Set(updSrcIds);
      const swappedBucket = (buckets.drift || [])
        .filter(r => sel.has(r.sourceId))
        .map(r => ({ matchKey: r.matchKey, sourceId: r.targetId, targetId: r.sourceId }));
      const readIds = swappedBucket.map(r => r.sourceId);   // = original targetIds
      const result = await reconcileOverwrite(invProfile, objType, readIds, swappedBucket, tgtSess, srcSess);
      counts.updatedSource += (result.ok || 0); counts.updatedSourceFailed += (result.failed || 0);
      log(result.failed ? '⚠' : '✅', `Updated ${result.ok} in source${result.failed ? `, ${result.failed} failed` : ''}`, result.failed ? 'ds-prog-err' : '');
      (result.errors || []).forEach(e => allErrors.push(`update-source: ${e}`));
      (result.errors || []).slice(0, 5).forEach(e => log('  ❌', e, 'ds-prog-err'));
    } catch (e) { allErrors.push(`Source update failed: ${e?.message || e}`); log('❌', `Source update failed: ${e?.message || e}`, 'ds-prog-err'); }
  }

  // ── 5. Save to History so the run is visible later ───────────────────
  const childOk   = Object.values(childCounts).reduce((s, c) => s + c.created + c.relinked + (c.overwritten || 0) + (c.deleted || 0), 0);
  const childFail = Object.values(childCounts).reduce((s, c) => s + c.failed + c.connectFailed + c.relinkFailed + (c.overwriteFailed || 0) + (c.deleteFailed || 0), 0);
  const totalOk   = counts.inserted + counts.updated + counts.deleted + counts.pulled + counts.updatedSource + childOk;
  const totalFail = counts.insertedFailed + counts.updatedFailed + counts.deletedFailed + counts.pulledFailed + counts.updatedSourceFailed + childFail;
  // Fail counts alone lied (load test 2026-08-17): a child pass that DIED
  // wholesale (HTTP 431, zero rows attempted) contributes zero per-record
  // failures, and the card wore a green "success" over 1,850 unwritten
  // records. Any HARD error (the ℹ marker tags engine notes) blocks
  // 'success' — the failed rescue is real work not done.
  const hardErrs = allErrors.filter(e => !/(^|: )ℹ /.test(String(e))).length;
  const status   = (totalFail === 0 && hardErrs === 0) ? 'success' : (totalOk > 0 ? 'partial' : 'failed');
  _history.push({
    id:           genId('run'),
    kind:         'reconcile',
    profileId:    profile.id,
    profileName:  profile.name,
    sourceOrg:    profile.sourceOrg,
    targetOrg:    profile.targetOrg,
    srcOrgUrl:    profile.sourceOrg,
    tgtOrgUrl:    profile.targetOrg,
    startedAt,
    completedAt:  new Date().toISOString(),
    status,
    summary: {
      [objType]: {
        inserted: counts.inserted, insertedFailed: counts.insertedFailed,
        updated:  counts.updated,  updatedFailed:  counts.updatedFailed,
        deleted:  counts.deleted,  deletedFailed:  counts.deletedFailed,
        pulled:   counts.pulled,   pulledFailed:   counts.pulledFailed,
        updatedSource: counts.updatedSource, updatedSourceFailed: counts.updatedSourceFailed,
        purged:   counts.purged,
        deleteMode: _recDeleteMode,
        ...(rootTargets.length ? { targetRecords: rootTargets.slice(0, 200) } : {}),
        ...(rootFailedInserts.length ? { failedSourceIds: sftkCapFailedIds(rootFailedInserts) } : {}),
        ...(rootFailedUpdates.length ? { failedRecords: rootFailedUpdates.slice(0, 200) } : {})
      },
      // Child objects — inserted/linked/relinked counts per relationship.
      ...Object.fromEntries(Object.entries(childCounts)
        .filter(([obj]) => obj !== objType)
        .map(([obj, c]) => [obj, {
          inserted: c.created, insertedFailed: c.failed,
          connected: c.connected, connectFailed: c.connectFailed,
          relinked: c.relinked, relinkFailed: c.relinkFailed,
          // R4 — child drift overwrites + target-only deletes.
          overwritten: c.overwritten || 0, overwrittenFailed: c.overwriteFailed || 0,
          deleted: c.deleted || 0, deletedFailed: c.deleteFailed || 0,
          ...(c.targetRecords?.length ? { targetRecords: c.targetRecords.slice(0, 200) } : {}),
          ...(c.failedSourceIds?.length ? { failedSourceIds: sftkCapFailedIds(c.failedSourceIds) } : {})
        }]))
    },
    errors: allErrors.slice(0, 50)
  });
  await storageSaveHistory();

  log('✅', `Reconcile complete — refreshing state…`);
  // Remember which child sections had scans BEFORE the root refresh wipes
  // lastScan.children — they get re-scanned right after so the accordion
  // reflects the new reality (and just-created orphans are visible).
  // Parents before grandchildren — a grandchild rescan requires its parent
  // child scan to exist and be stamped with the NEW root runAt (R5).
  const scannedChildKeys = Object.keys(profile.lastScan?.children || {})
    .sort((x, y) => x.split('.').length - y.split('.').length);
  // Refresh diff + snapshots so the columns reflect the new reality.
  await window.refreshProfileState(profile.id);
  // Keep the ephemeral Org Compare profile (not in _profiles) — refreshProfileDiff
  // already updated its lastScan in place. Only re-point at a saved profile.
  { const _fp = _profiles.find(x => x.id === profile.id); if (_fp) _reconcileProfile = _fp; }
  for (const k of scannedChildKeys) {
    log('🔎', `Re-scanning child section ${k}…`);
    const res2 = await scanReconcileChild(_reconcileProfile, k);
    if (res2?.error) log('⚠', `Child rescan: ${res2.error}`, 'ds-prog-warn');
  }
  _recSel = { push: new Set(), overwrite: new Set(), updSrc: new Set(), del: new Set(), pull: new Set() };
  _recChildSel = {};
  const toastParts = [];
  if (counts.inserted)      toastParts.push(`${counts.inserted} inserted`);
  if (childOk) {
    const cIns = Object.values(childCounts).reduce((s, c) => s + c.created, 0);
    const cRel = Object.values(childCounts).reduce((s, c) => s + c.relinked, 0);
    const cOvw = Object.values(childCounts).reduce((s, c) => s + (c.overwritten || 0), 0);
    const cDel = Object.values(childCounts).reduce((s, c) => s + (c.deleted || 0), 0);
    if (cIns) toastParts.push(`${cIns} child record(s) inserted`);
    if (cRel) toastParts.push(`⇄ ${cRel} relinked`);
    if (cOvw) toastParts.push(`${cOvw} child record(s) updated`);
    if (cDel) toastParts.push(`${cDel} child record(s) deleted`);
  }
  if (counts.updated)       toastParts.push(`${counts.updated} updated`);
  if (counts.updatedSource) toastParts.push(`← ${counts.updatedSource} updated in source`);
  if (counts.pulled)        toastParts.push(`${counts.pulled} pulled`);
  if (counts.deleted)       toastParts.push(`${counts.deleted} deleted`);
  const toastMsg = `Reconcile: ${toastParts.join(' · ') || 'no actions'}` +
    (totalFail ? ` · ${totalFail} failed` : '');
  // TOTAL failure must be unmissable — the user ran 401 doomed inserts and
  // walked away believing they succeeded (2026-08-09). toastParts only gets
  // entries for non-zero success counts, so empty + failures = nothing landed.
  if (!toastParts.length && totalFail) {
    showToast(`Nothing was written — all ${totalFail} action(s) failed. The run log above has the first error per record; fix the cause and run again.`, 'error', 9000);
  } else {
    showToast(toastMsg, totalFail ? 'warning' : 'success', 4500);
  }
  try { recPort?.disconnect(); } catch (_) {}
  // Re-scan so the buckets reflect what ACTUALLY happened (user: records
  // "not deducted from the view" — the old render replayed the PRE-run
  // scan). This also makes the columns the RETRY QUEUE for leftovers:
  // whatever failed is still missing/drifted, stays listed, and re-seeds
  // selected — running again IS the retry.
  try {
    await window.refreshProfileState(profile.id);
    const _fp = _profiles.find(x => x.id === profile.id);
    if (_fp) _reconcileProfile = _fp;
    _recSel = { push: new Set(), overwrite: new Set(), updSrc: new Set(), del: new Set(), pull: new Set() };
    _recChildSel = {};
    // Ring tiles must reflect the run too (user 2026-08-10: after inserting
    // all the children, the ring still said stale until a manual scan).
    // Only when the ring's source IS the RUN's source — a tile scanned
    // from a different golden org must never be overwritten with this pair.
    // QA sweep 2026-08-10: a ⚖ ring clone's ring_* id isn't in _profiles,
    // so _fp is undefined there and this block no-op'd on the ring's own
    // repair path — resolve the REAL profile via the clone's _ringOf stamp;
    // the post-run rescan lives on _reconcileProfile in that case.
    try {
      const realP = (_fp && !_fp.ephemeral) ? _fp
        : (profile._ringOf ? _profiles.find(x => x.id === profile._ringOf.profileId && !x.ephemeral) : null);
      const fs = _fp ? _fp.lastScan : _reconcileProfile?.lastScan;
      const runSrc = profile.sourceOrg, runTgt = profile.targetOrg;
      const ringSrcOk = typeof _ring !== 'undefined' && _ring?.sourceUrl &&
        sftkOrgKey(_ring.sourceUrl) === sftkOrgKey(runSrc);
      if (realP && fs?.status === 'success' && ringSrcOk &&
          typeof _ringScanKey === 'function' && realP.ringScans) {
        const rk = _ringScanKey(runTgt, runSrc);
        if (realP.ringScans[rk]) {
          realP.ringScans[rk] = { runAt: fs.runAt,
            missing: (fs.missingInTarget || []).length,
            changed: (fs.changed || []).length,
            extra:   (fs.onlyInTarget || []).length,
            status:  'success',
            ...(fs.fileDrift && !fs.fileDrift.error && fs.fileDrift.records ? { fileMiss: fs.fileDrift.records } : {}),
            ...(fs.fileDrift?.error ? { fileErr: true } : {}) };
          // ⚖ clone whose ring flow IS the real profile's own pair → the
          // post-run scan is a native scan; deposit it (stripped, restamped
          // — same contract as _ringScanOne). The direct-_fp case already
          // holds this scan as its lastScan.
          if (realP !== _fp
              && sftkOrgKey(runSrc) === sftkOrgKey(realP.sourceOrg || '')
              && sftkOrgKey(runTgt) === sftkOrgKey(realP.targetOrg || '')) {
            const dep = { ...fs, sourceOrg: realP.sourceOrg, targetOrg: realP.targetOrg };
            delete dep.learnedPairs;
            realP.lastScan = dep;
          }
          await storageSaveProfiles();
        }
      }
    } catch (_) { /* tile refresh is best-effort */ }
  } catch (_) { /* stale view is still better than no view */ }
  renderReconcile();
}

// Overwrite drifted target records with source values. Fetches the source
// records' mapped fields, builds PATCH payloads keyed by the TARGET Id, and
// sends via SF_COLLECTIONS_UPDATE. Honors fieldMappings (src→tgt rename) and
// skips system/non-writable fields. Returns { ok, failed, errors }.
async function reconcileOverwrite(profile, objType, sourceIds, driftBucket, srcSess, tgtSess) {
  // Map sourceId → targetId from the drift bucket.
  const srcToTgt = new Map();
  for (const r of driftBucket) { if (r.sourceId && r.targetId) srcToTgt.set(r.sourceId, r.targetId); }

  const node = profile.tree;
  const fm   = node.fieldMappings || {};

  // W2 — hand-picked lookup targets for THIS target org (the Reconcile 🔗
  // panel). Applied LAST in the payload build: a pick is already a
  // target-org id, so it needs no by-key resolution and beats the
  // name-matching refPairs below — the same Priority-0 the run engine
  // gives node.lookupOverrides. Without this, a pick made on the very row
  // being overwritten would silently lose to name-matching.
  const lkpOv = (typeof sftkLkpOvBucket === 'function')
    ? sftkLkpOvBucket(node, profile.targetOrg) : null;
  let lkpOvUsed = 0;
  let lkpOvEligible = null;   // srcField → mapped target field (built from describe)
  let tgtUpdMap = null;       // target field → updateable (null = describe unavailable)

  // PII policy applies to EVERY write path. This function sends
  // SF_COLLECTIONS_UPDATE itself instead of going through the engine, and
  // the adversarial review confirmed it as THE leak: masked deploys, raw
  // overwrites. Same contract as executeProfileTransfer — a non-empty
  // policy without a salt is a hard error BEFORE any read, and a covered
  // value never leaves unmasked (the caller's try/catch degrades the throw
  // to a logged failure, which is the correct fail-closed outcome).
  const piiRules = {};   // FieldApi (lowercased) → rule, for THIS object
  for (const [k, rule] of Object.entries(profile?.piiPolicy || {})) {
    if (!rule) continue;
    const dot = k.indexOf('.');
    if (dot < 0 || k.slice(0, dot).toLowerCase() !== String(objType).toLowerCase()) continue;
    piiRules[k.slice(dot + 1).toLowerCase()] = rule;
  }
  const piiActive = Object.keys(piiRules).length > 0;
  if (piiActive && !profile.piiSalt) {
    throw new Error('PII policy has no salt — open the deployment in the builder once');
  }
  const piiCounts = { hashed: 0, nulled: 0, fixed: 0 };
  // Source fields to read = the mapped source field names (those that map to
  // a non-null target). Drop system fields.
  // OwnerId excluded from the mapping-driven fields — owners are handled by
  // the profile's ownerMapping setting below, not by field mapping.
  const SYS = new Set(['Id','CreatedDate','CreatedById','LastModifiedDate','LastModifiedById','SystemModstamp','IsDeleted','OwnerId']);
  let srcFields = Object.keys(fm).filter(k => fm[k] !== null && fm[k] !== '' && !SYS.has(k));

  // Owner mapping ('match'): resolve source Owner.Name → target user;
  // unmatched → the profile's fallback user; updates without a fallback
  // leave the target's current owner untouched.
  const ownerMode     = profile?.ownerMapping?.mode === 'match';
  const ownerFallback = ownerMode ? (profile.ownerMapping.fallbackUserId || null) : null;
  let   wantOwners    = false;

  // Validate the mapping against the SOURCE describe. Filters + resolution:
  //  - STALE fields: fieldMappings keys persist in the profile, so a field
  //    later deleted from the org 400s the whole source read
  //    ("No such column 'X' on entity 'Y'") and kills the entire overwrite
  //    phase. Drop them and say so, instead of failing everything.
  //  - LOOKUP fields (type 'reference'): raw ids are org-local, so they are
  //    RESOLVED, not copied — the source parent's key (Name / configured
  //    match field) is read via dot-path and matched against the target's
  //    parents, exactly like the child-section Relink. The old behavior of
  //    skipping lookups entirely left records permanently "drifted": the
  //    scan compares lookups by related-record name, so an overwrite that
  //    never touched them could never bring records in sync. Polymorphic /
  //    relationship-less lookups are still skipped; RecordTypeId keeps its
  //    own DeveloperName remap below.
  const warnings = [];
  let refPairs = [];   // [{sf, tf, relName, matchField, parentObj, unresolved}]
  let srcNameFld = null;   // the object's name field — fetched for link labels only
  let descByLower = {};    // source field describe by lowercased name — masking needs type/length
  try {
    const [d, dt] = await Promise.all([
      sendBg({ type: 'SF_REST_GET', orgUrl: srcSess.orgUrl, sid: srcSess.sid,
        path: `services/data/v62.0/sobjects/${objType}/describe` }),
      sendBg({ type: 'SF_REST_GET', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
        path: `services/data/v62.0/sobjects/${objType}/describe` })
    ]);
    if (d && !d.error && Array.isArray(d.fields) && d.fields.length) {
      const srcNames = new Set(d.fields.map(f => f.name));
      wantOwners = ownerMode && srcNames.has('OwnerId');
      srcNameFld = d.fields.find(f => f.nameField)?.name || null;
      for (const f of d.fields) descByLower[f.name.toLowerCase()] = f;
      const stale    = srcFields.filter(k => !srcNames.has(k));
      if (stale.length) {
        warnings.push(`⚠ skipped ${stale.length} mapped field(s) that no longer exist on ${objType} in the source org: ${stale.join(', ')} — open ✏ Edit → Fields & mapping to clean them up`);
      }
      // W4 (user 2026-08-05: updated values "not captured") — Overwrite used
      // to write ONLY the mapping's keys, while the run engine copies EVERY
      // createable field. A drifted unmapped field was detected by the
      // (expanded) scan yet silently NOT fixed here. Union in the engine's
      // data-field set; reference fields keep their existing fm-driven
      // resolution path below, byte-for-byte.
      if (typeof sftkEngineCompareSet === 'function') {
        const keep = new Set(srcFields.filter(k => srcNames.has(k)));
        for (const p of sftkEngineCompareSet(d.fields, fm)) keep.add(p.srcField);
        srcFields = [...keep];
      }
      // Mapped lookups → resolve-by-key pairs (mirrors buildLookupCompareMap).
      const lkpCfg = (node.lookupResolutions || {});
      for (const f of d.fields) {
        if (f.type !== 'reference' || f.name === 'RecordTypeId') continue;
        if (!srcFields.includes(f.name)) continue;
        const cfg  = lkpCfg[f.name];
        const poly = f.polymorphicForeignKey || (f.referenceTo || []).length > 1;
        if (!f.relationshipName || (poly && !cfg?.matchObject)) continue;
        refPairs.push({
          sf: f.name,
          tf: fm[f.name] || f.name,
          relName:    f.relationshipName,
          matchField: cfg?.matchField || 'Name',
          parentObj:  cfg?.matchObject || (f.referenceTo || [])[0],
          unresolved: 0
        });
      }
      const refs = new Set(d.fields.filter(f => f.type === 'reference' && f.name !== 'RecordTypeId').map(f => f.name));
      srcFields = srcFields.filter(k => srcNames.has(k) && !refs.has(k));
      // W2 — every non-engine-owned reference can take a hand-pick, even
      // ones refPairs skips (polymorphic without a configured matchObject,
      // no relationshipName): the pick IS the target id, no resolution
      // needed. Same rename rule as the plain-field loop.
      if (lkpOv) {
        lkpOvEligible = {};
        for (const f of d.fields) {
          if (f.type !== 'reference') continue;
          if (['OwnerId', 'RecordTypeId', 'CreatedById', 'LastModifiedById'].includes(f.name)) continue;
          lkpOvEligible[f.name] = (fm[f.name] && fm[f.name] !== null) ? fm[f.name] : f.name;
        }
      }
    }
    // TARGET-side validation — the PATCH writes the MAPPED names into the
    // target org; a mapped name that's missing there (e.g. test__c, or
    // MailingCountryCode when State/Country picklists are only enabled in
    // the source) or read-only fails EVERY row with "No such column".
    if (dt && !dt.error && Array.isArray(dt.fields) && dt.fields.length) {
      const tgtUpd = new Map(dt.fields.map(f => [f.name, f.updateable !== false]));
      tgtUpdMap = tgtUpd;   // W2 — pick application checks the same map
      const badTgt = [];
      srcFields = srcFields.filter(sf => {
        const tf = (sf === 'RecordTypeId') ? 'RecordTypeId' : (fm[sf] || sf);
        if (!tgtUpd.has(tf)) { badTgt.push(`${sf} → ${tf} (missing in target)`);   return false; }
        if (!tgtUpd.get(tf)) { badTgt.push(`${sf} → ${tf} (read-only in target)`); return false; }
        return true;
      });
      refPairs = refPairs.filter(rp => {
        if (!tgtUpd.has(rp.tf)) { badTgt.push(`${rp.sf} → ${rp.tf} (missing in target)`);   return false; }
        if (!tgtUpd.get(rp.tf)) { badTgt.push(`${rp.sf} → ${rp.tf} (read-only in target)`); return false; }
        return true;
      });
      if (badTgt.length) {
        warnings.push(`⚠ skipped ${badTgt.length} mapped field(s) the target org can't accept: ${badTgt.join(', ')} — open ✏ Edit → Fields & mapping to fix`);
      }
      if (wantOwners && tgtUpd.size && !tgtUpd.get('OwnerId')) {
        warnings.push('⚠ owners: OwnerId is not updateable in the target — owner matching skipped');
        wantOwners = false;
      }
    }
  } catch (_) { /* best effort — proceed with the unfiltered list */ }

  if (!srcFields.length && !refPairs.length && !wantOwners) {
    return { ok: 0, failed: sourceIds.length, errors: [...warnings, 'No mapped fields to overwrite — configure Field Mapping on the root node.'] };
  }

  // Fetch source records in chunks — plain fields plus each lookup's parent
  // KEY via dot-path (Account.Name style) for target-side resolution.
  const idList = sourceIds.filter(id => srcToTgt.has(id));
  const selFields = [...new Set([
    'Id', ...srcFields,
    ...refPairs.map(rp => `${rp.relName}.${rp.matchField}`),
    ...(wantOwners ? ['Owner.Name'] : []),
    ...(srcNameFld ? [srcNameFld] : [])   // labels for History links only
  ])];
  const srcRecs = [];
  for (let i = 0; i < idList.length; i += 200) {
    const chunk = idList.slice(i, i + 200);
    const soql = `SELECT ${selFields.join(',')} FROM ${objType} WHERE Id IN (${chunk.map(id => `'${id}'`).join(',')})`;
    const res  = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: srcSess.orgUrl, sid: srcSess.sid, query: soql });
    if (res?.error) return { ok: 0, failed: idList.length, errors: [...warnings, `Source read failed: ${res.error}`] };
    srcRecs.push(...(res.records || []));
  }

  // Resolve each lookup's target parents by key (fresh query, so parents
  // inserted earlier in this same reconcile run count). First match wins.
  // M3a NOTE (deliberate skip): refPairs matching keeps its OWN per-lookup
  // matchField concept (node.lookupResolutions[field].matchField, default
  // 'Name') and is NOT wired to node.matching — these are per-LOOKUP parent
  // resolutions, a different axis from the node's own record identity, and
  // rewiring them here would not be a small contained change. Revisit in M3c.
  for (const rp of refPairs) {
    rp.byKey = new Map();
    const keys = [...new Set(srcRecs
      .map(r => r[rp.relName] ? r[rp.relName][rp.matchField] : null)
      .filter(v => v != null && v !== ''))];
    for (let i = 0; i < keys.length; i += 100) {
      const lit = keys.slice(i, i + 100)
        .map(v => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(',');
      const q = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
        query: `SELECT Id, ${rp.matchField} FROM ${rp.parentObj} WHERE ${rp.matchField} IN (${lit})` });
      if (q?.error) {
        warnings.push(`⚠ ${rp.sf}: couldn't look up ${rp.parentObj} by ${rp.matchField} in the target (${q.error}) — this lookup left unchanged`);
        rp.failed = true;
        break;
      }
      for (const rec of (q.records || [])) {
        const k = String(rec[rp.matchField] ?? '');
        if (k && !rp.byKey.has(k)) rp.byKey.set(k, rec.Id);
      }
    }
  }

  // Resolve source owner names against the target's active users.
  const ownerByName = new Map();
  let ownerFellBack = 0, ownerKept = 0;
  if (wantOwners) {
    const names = [...new Set(srcRecs.map(r => r.Owner ? r.Owner.Name : null).filter(Boolean))];
    for (let i = 0; i < names.length; i += 100) {
      const lit = names.slice(i, i + 100)
        .map(n => `'${String(n).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(',');
      const q = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
        query: `SELECT Id, Name FROM User WHERE IsActive = true AND Name IN (${lit})` });
      if (q?.error) {
        warnings.push(`⚠ owners: couldn't load target users (${q.error}) — owner matching skipped`);
        wantOwners = false;
        break;
      }
      for (const u of (q.records || [])) if (!ownerByName.has(u.Name)) ownerByName.set(u.Name, u.Id);
    }
  }

  // Match RecordTypes by DeveloperName when RecordTypeId is being written.
  // The raw source RecordTypeId is invalid in the target org, so we resolve
  // srcRtId → tgtRtId by API name; unmatched RTs are skipped (the target
  // record keeps its existing RT) rather than pushing a garbage Id.
  const ovwErrors = [];
  let rtRemap = null;   // { srcRtId: tgtRtId|null }
  if (srcFields.includes('RecordTypeId')) {
    const srcRtIds = [...new Set(srcRecs.map(r => r.RecordTypeId).filter(Boolean))];
    if (srcRtIds.length) {
      const [srcRtRes, tgtRtRes] = await Promise.all([
        sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: srcSess.orgUrl, sid: srcSess.sid,
                 query: `SELECT Id, DeveloperName FROM RecordType WHERE Id IN (${srcRtIds.map(id => `'${id}'`).join(',')})` }),
        sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
                 query: `SELECT Id, DeveloperName FROM RecordType WHERE SObjectType = '${objType}'` })
      ]);
      const tgtByName = {};
      for (const r of (tgtRtRes.records || [])) tgtByName[r.DeveloperName] = r.Id;
      rtRemap = {};
      const unmatched = [];
      for (const r of (srcRtRes.records || [])) {
        rtRemap[r.Id] = tgtByName[r.DeveloperName] || null;
        if (!rtRemap[r.Id]) unmatched.push(r.DeveloperName);
      }
      if (unmatched.length) ovwErrors.push(`record type(s) ${unmatched.join(', ')} not in target — left unchanged on those records`);
    }
  }

  // Build PATCH payloads keyed by target Id. rowMeta stays aligned with
  // payloads so per-record results can be turned into History record links.
  const payloads = [];
  const rowMeta  = [];   // [{ id, label }]
  for (const sr of srcRecs) {
    const tgtId = srcToTgt.get(sr.Id);
    if (!tgtId) continue;
    const p = { attributes: { type: objType }, Id: tgtId };
    for (const sf of srcFields) {
      // Unmapped fields (the engine-set expansion) write under their own
      // name; a non-empty mapping renames, exactly like the run engine.
      const tf = (fm[sf] && fm[sf] !== null) ? fm[sf] : sf;
      let v    = sr[sf];
      if (v == null) continue;
      // Remap RecordTypeId by DeveloperName; drop it if there's no target
      // match so we don't PATCH an invalid Id (which would fail the row).
      if (sf === 'RecordTypeId' && rtRemap) {
        const mapped = rtRemap[v];
        if (!mapped) continue;
        v = mapped;
      }
      // Mask BEFORE the mapped target name receives the value (policy keys
      // are source api names). An UPDATE writes the null explicitly rather
      // than skipping the field: leaving it unchanged would preserve raw
      // PII a pre-policy seed may have planted in the target.
      const piiRule = piiActive && sf !== 'RecordTypeId' ? piiRules[sf.toLowerCase()] : null;
      if (piiRule) {
        const m = await sftkPiiMaskValue(v, descByLower[sf.toLowerCase()] || {}, profile.piiSalt, piiRule);
        if (m.action !== 'kept') {
          piiCounts[m.action] = (piiCounts[m.action] || 0) + 1;
          p[tf] = m.value == null ? null : m.value;
          continue;
        }
      }
      p[tf] = v;
    }
    // Lookups: write the resolved TARGET parent id. Unresolvable parents
    // are left unchanged (never nulled) and counted for the summary.
    for (const rp of refPairs) {
      if (rp.failed) continue;
      const key = sr[rp.relName] ? sr[rp.relName][rp.matchField] : null;
      if (key == null || key === '') continue;      // no parent in source — leave as-is
      const pid = rp.byKey.get(String(key));
      if (!pid) { rp.unresolved++; continue; }
      p[rp.tf] = pid;
    }
    // W2 — hand-picks are the FINAL word on lookups (after refPairs, so a
    // pick beats by-key matching). Target-side gate mirrors the mapped-field
    // filter above: never PATCH a field the target lacks or can't update.
    const ovForRec = (lkpOv && lkpOv[sr.Id] && typeof lkpOv[sr.Id] === 'object') ? lkpOv[sr.Id] : null;
    if (ovForRec && lkpOvEligible) {
      for (const [sf, pickId] of Object.entries(ovForRec)) {
        const tf = lkpOvEligible[sf];
        if (!tf || !pickId) continue;
        if (tgtUpdMap && tgtUpdMap.get(tf) !== true) continue;
        p[tf] = pickId;
        lkpOvUsed++;
      }
    }
    // Owners: matched name → that user; unmatched → fallback; no fallback →
    // the target's current owner stays untouched.
    if (wantOwners) {
      const oname = sr.Owner ? sr.Owner.Name : null;
      if (oname) {
        const matched = ownerByName.get(oname);
        if (matched)           p.OwnerId = matched;
        else if (ownerFallback) { p.OwnerId = ownerFallback; ownerFellBack++; }
        else                    ownerKept++;
      }
    }
    payloads.push(p);
    // History/audit outlive the run — a raw label for a record whose name
    // (or name parts) are under policy would leak the exact data the
    // masking exists to keep out of persistent storage. Fall back to the id.
    const piiNameCovered = piiActive && (
      (srcNameFld && piiRules[srcNameFld.toLowerCase()]) ||
      piiRules['name'] || piiRules['firstname'] || piiRules['lastname']);
    rowMeta.push({ id: tgtId, label: piiNameCovered ? tgtId : ((srcNameFld && sr[srcNameFld]) || sr.Name || tgtId) });
  }

  if (piiActive) {
    warnings.push(`🔒 PII: ${piiCounts.hashed + piiCounts.nulled + piiCounts.fixed} value(s) masked before writing (${piiCounts.hashed} hashed, ${piiCounts.nulled} nulled${piiCounts.fixed ? `, ${piiCounts.fixed} fixed` : ''})`);
  }
  if (ownerFellBack) warnings.push(`⚠ owners: ${ownerFellBack} record(s) reassigned to the fallback user (owner had no name match in the target)`);
  if (ownerKept)     warnings.push(`⚠ owners: ${ownerKept} record(s) kept their current target owner (no name match and no fallback user set)`);

  for (const rp of refPairs) {
    if (rp.unresolved) {
      warnings.push(`⚠ ${rp.sf}: ${rp.unresolved} record(s) point at a ${rp.parentObj} with no match in the target (by ${rp.matchField}) — left unchanged; insert the parent first or pick a better match field`);
    }
  }

  // W2 — disclose applied hand-picks the way the run engine does, so the
  // user can tell name-matching results from their own overrides.
  if (lkpOvUsed) warnings.push(`🔗 ${lkpOvUsed} lookup value(s) written from hand-picked targets (your Reconcile 🔗 picks — they beat name-matching)`);

  const res = await sendBg({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, records: payloads });
  const arr = Array.isArray(res) ? res : [];
  const ok = arr.filter(r => r.success).length;
  const errors = [...warnings, ...ovwErrors];
  // Per-record outcomes with labels — History renders both as links:
  // updated → the target record; failed update → also the target record
  // (it exists — the PATCH was refused), with the error on hover.
  const updatedRecords = [];
  const failedRecords  = [];
  arr.forEach((r, i) => {
    if (!rowMeta[i]) return;
    if (r.success) { if (updatedRecords.length < 200) updatedRecords.push(rowMeta[i]); }
    else if (failedRecords.length < 200) {
      failedRecords.push({ ...rowMeta[i], error: (r.errors || []).map(e => e.message).join('; ') });
    }
  });
  // Dedupe identical per-record failures — 20 rows all failing with the same
  // "No such column 'X'" should read as ONE line with a count, not a wall.
  const failCounts = new Map();
  for (const r of arr) {
    if (r.success) continue;
    const m = `${objType}: ${(r.errors || []).map(e => e.message).join('; ')}`;
    failCounts.set(m, (failCounts.get(m) || 0) + 1);
  }
  for (const [m, c] of failCounts) errors.push(c > 1 ? `${m}  (×${c})` : m);
  return { ok, failed: arr.length - ok, errors, updatedRecords, failedRecords };
}

// ═════════════════════════════════════════════════════════════════════════
// W2-UI — per-record lookup overrides (user 2026-08-07: "select lookups
// manually for every lookup of the record… for every record and for
// multiple org targets"). Stored at node.lookupOverrides[orgKey][srcId]
// [FieldApi] = target record Id. The engine reads them as Priority 0 in
// its payload builder (background.js) and profile export strips them —
// they're org-local target ids. Keys match by org IDENTITY (sftkOrgKey)
// on both the read and write side, so casing/alias drift can't fork or
// orphan a bucket.

// The per-source-record map for tgtOrgUrl, or null. Mirrors the engine's
// reader exactly: any stored key resolving to the same org identity counts.
function sftkLkpOvBucket(node, tgtOrgUrl) {
  const all = node?.lookupOverrides;
  if (!all || typeof all !== 'object') return null;
  const want = sftkOrgKey(tgtOrgUrl);
  for (const [k, v] of Object.entries(all)) {
    if (sftkOrgKey(k) === want && v && typeof v === 'object') return v;
  }
  return null;
}

function sftkLkpOvGet(node, tgtOrgUrl, srcId) {
  const b = sftkLkpOvBucket(node, tgtOrgUrl);
  return (b && b[srcId] && typeof b[srcId] === 'object') ? b[srcId] : {};
}

// Write one override. Reuses an existing bucket whose key matches the
// target's identity — never forks two buckets for one org; the first
// write for an org creates the bucket under the canonical key.
function sftkLkpOvSet(node, tgtOrgUrl, srcId, field, tgtId) {
  if (!node || !srcId || !field || !tgtId) return;
  if (!node.lookupOverrides || typeof node.lookupOverrides !== 'object') node.lookupOverrides = {};
  const all = node.lookupOverrides;
  const want = sftkOrgKey(tgtOrgUrl);
  let key = Object.keys(all).find(k => sftkOrgKey(k) === want);
  if (!key) key = want;
  const bucket = all[key] = (all[key] && typeof all[key] === 'object') ? all[key] : {};
  const rec = bucket[srcId] = (bucket[srcId] && typeof bucket[srcId] === 'object') ? bucket[srcId] : {};
  rec[field] = tgtId;
}

// Remove one override and prune every branch it leaves empty — a profile
// with no picks carries no lookupOverrides key at all.
function sftkLkpOvClear(node, tgtOrgUrl, srcId, field) {
  const all = node?.lookupOverrides;
  if (!all || typeof all !== 'object') return;
  const want = sftkOrgKey(tgtOrgUrl);
  for (const k of Object.keys(all)) {
    if (sftkOrgKey(k) !== want) continue;
    const bucket = all[k];
    if (bucket && bucket[srcId] && typeof bucket[srcId] === 'object') {
      delete bucket[srcId][field];
      if (!Object.keys(bucket[srcId]).length) delete bucket[srcId];
    }
    if (bucket && typeof bucket === 'object' && !Object.keys(bucket).length) delete all[k];
  }
  if (!Object.keys(all).length) delete node.lookupOverrides;
}

// Reference fields a hand-pick can actually STEER. The engine skips audit
// fields, resolves OwnerId through owner matching and RecordTypeId through
// the RT map — a pick on those would be stored and silently ignored, so
// they're not offered.
function sftkLkpRefFields(descFields) {
  const ENGINE_OWNED = new Set(['Id', 'OwnerId', 'CreatedById', 'LastModifiedById', 'RecordTypeId']);
  return (descFields || []).filter(f =>
    f && f.type === 'reference' && f.createable &&
    !ENGINE_OWNED.has(f.name) && (f.referenceTo || []).length > 0);
}

// SOQL LIKE-literal escape: quote + backslash plus the LIKE wildcards.
function sftkLkpSoqlLike(term) {
  return String(term || '').replace(/([\\'%_])/g, '\\$1');
}

// History cap for failed-record lists (user 2026-08-10: "Retry failed (200)"
// on a 401-failure run — 201 records had NO retry path). Detail is what
// costs storage, ids are cheap: keep the first 200 entries rich (error,
// label, captured field values) and store the remainder as BARE ID STRINGS
// up to the engine's own 2000 cap. The History consumer already reads both
// shapes (`typeof f === 'string' ? f : f.id`), so Retry covers everything
// while storage stays sane. PURE — unit-tested.
function sftkCapFailedIds(list, richCap, idCap) {
  const rc = Number(richCap) > 0 ? Math.floor(Number(richCap)) : 200;
  const ic = Number(idCap) > 0 ? Math.floor(Number(idCap)) : 2000;
  const arr = Array.isArray(list) ? list : [];
  if (arr.length <= rc) return arr.slice();
  return [
    ...arr.slice(0, rc),
    ...arr.slice(rc, ic).map(f => (typeof f === 'string' ? f : (f && f.id) || null)).filter(Boolean),
  ];
}

// ═════════════════════════════════════════════════════════════════════════
// ⛓ PARENT-GAP ADVISOR (user 2026-08-09: "How can we suggest this operation
// to the user if we recognize this pattern?"). The recognizable pattern:
// the scanned object has a lookup whose referenced object has ZERO records
// in the target org — every name-bridge must resolve nothing, and when the
// field is also required in the target, every insert is doomed (tonight's
// 401 × "Required field missing"). Probe once per scan (one LIMIT-1 query
// per referenced object), cache the verdict, and offer the fix as ONE
// CLICK: an ephemeral parents-first deployment on the same org pair,
// opened straight in Reconcile with its missing records pre-selected (the
// ring / tree-diff ephemeral recipe). Advisory only — any failure inside
// leaves the page untouched.
async function sftkRecParentGapAdvisor(p, scan, objType, missing) {
  const host = eid('dsRecParentGaps');
  if (!host) return;
  const key = `${p.id}|${scan.runAt}`;
  const wire = () => host.querySelectorAll('[data-recgap]').forEach(b => b.addEventListener('click', async () => {
    const refObj = b.dataset.recgap;
    b.disabled = true; b.textContent = '⏳ scanning…';
    const eph = {
      id: `gap_${Date.now()}`,
      name: `${refObj} — parents first`,
      sourceOrg: p.sourceOrg, targetOrg: p.targetOrg,
      ephemeral: true,
      scanConfig: { matchField: 'Name', compareFields: [] },
      tree: { objectType: refObj, where: '', children: [] },
      // The journey back (user 2026-08-10: "we deployed the parents. now we
      // need to be able to deploy the childrens") — the parent view offers
      // "Continue to <child>" once aligned.
      _parentOf: { profileId: p.id, objType },
    };
    const res = await runDiffScan(eph);
    if (res?.error) {
      showToast(`Scan failed: ${res.error}`, 'error', 6000);
      b.disabled = false; b.textContent = `➕ Deploy ${refObj} first`;
      return;
    }
    eph.lastScan = res;
    _reconcileProfile = eph;
    renderReconcile();
    showToast(`Push these ${(res.missingInTarget || []).length} record(s), then continue back to ${objType} — the banner up top takes you there.`, 'info', 6500);
  }));
  // Same scan → same verdict; reuse the cached banner without re-probing.
  if (_recParentGapKey === key) {
    if (_recParentGapHtml) { host.innerHTML = _recParentGapHtml; wire(); }
    return;
  }
  if (!(missing || []).length) { _recParentGapState = { key, doomed: [], empties: [] }; return; }
  _recParentGapKey = key; _recParentGapHtml = '';   // claim BEFORE awaiting (no double-probe)
  try {
    await sftkParentSyncLoad();
    const all = _buildAllSessions();
    const srcSess = _resolveSession(p.sourceOrg, all);
    const tgtSess = _resolveSession(p.targetOrg, all);
    if (!srcSess?.sid || !tgtSess?.sid) return;
    const desc = await describe(objType, srcSess.orgUrl, srcSess.sid);
    let tdesc = null;
    try { tdesc = await describe(objType, tgtSess.orgUrl, tgtSess.sid); } catch (_) { tdesc = null; }
    // Objects the profile itself deploys are the engine's job, not a gap.
    const treeObjs = new Set([p.tree?.objectType,
      ...(p.tree?.children || []).map(c => c.objectType || c.childSObject)].filter(Boolean));
    const seen = new Set(); const parents = [];
    for (const f of sftkLkpRefFields(desc?.fields)) {
      const refObj = (f.referenceTo || [])[0];
      if (!refObj || treeObjs.has(refObj) || seen.has(refObj)) continue;
      seen.add(refObj);
      const probe = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
        _suppressError: true, query: `SELECT Id FROM ${refObj} LIMIT 1` });
      if (probe?.error) continue;   // unknowable → say nothing rather than guess
      const tf = (tdesc?.fields || []).find(x => x.name === f.name);
      parents.push({ field: f.name, refObj,
        empty: !(probe?.records || []).length,
        required: !!tf && tf.nillable === false });
    }
    if (!parents.length) { _recParentGapState = { key, doomed: [], empties: [] }; return; }
    // Numbered plan (user 2026-08-10: "its very unclear what is the correct
    // order") — the panel is now an explicit ordered checklist: every parent
    // is a numbered step with live status from the session sync map; this
    // deployment is always the LAST step, and the first unfinished step
    // carries a "← next" marker. No more inferring the order.
    const steps = parents.map(g => {
      const vd = _parentSyncVerdicts[sftkParentSyncKey(p.sourceOrg, p.targetOrg, g.refObj)];
      return { ...g, vd, done: !g.empty && !!vd && !vd.missing && !vd.changed,
        // AUTO-VERIFY (user 2026-08-10: "two first steps here should be done
        // automatically on load and not route the user to a reconcile screen
        // without nothing if its aligned") — a parent that EXISTS but has no
        // verdict yet gets scanned in the BACKGROUND below; the checklist
        // fills itself and navigation only appears when there's work to do.
        checking: !g.empty && !vd && !_recParentGapChecked.has(`${key}|${g.refObj}`) };
    });
    const anyEmpty = parents.some(g => g.empty);
    // Two tiers, one flow (user 2026-08-10: "offer the user to compare
    // parent records per orgs first and fix them and then only transfer
    // the childs"): an EMPTY parent object is urgent — deploy it or every
    // lookup lands null; an existing one still deserves a compare-first
    // pass (missing rows / drift there break the children's bridges too).
    // Both buttons run the same one-click: scan the parent pair, open its
    // Reconcile, fix, come back — this view refreshes itself.
    const nextIdx = steps.findIndex(s => !s.done);
    const allDone = nextIdx === -1;
    // Feed the RUN GATE — a banner is advice; guaranteed failure gets a stop.
    const doomed = steps.filter(s => s.empty && s.required).map(s => s.refObj);
    _recParentGapState = { key, doomed,
      empties: steps.filter(s => s.empty && !s.required).map(s => s.refObj) };
    const stepHtml = (s, i) => {
      const isNext = i === nextIdx;
      const status = s.done
        ? `<span class="ds-psync ds-psync-ok" title="Last ${esc(s.refObj)} scan on this org pair found nothing missing and nothing changed.">✓ in sync${s.vd ? ` · ${esc(timeAgo(s.vd.at))}` : ''}</span> <button class="ds-btn ds-btn-xs" data-recgap="${esc(s.refObj)}" title="Re-scan ${esc(s.refObj)} if the orgs changed since.">↻</button>`
        : s.empty
          ? `<span class="ds-psync ds-psync-bad">missing from target entirely${s.required ? ` · ${esc(objType)}.${esc(s.field)} is REQUIRED` : ''}</span> <button class="ds-btn ds-btn-xs ds-btn-primary" data-recgap="${esc(s.refObj)}" title="Creates a ready-made ${esc(s.refObj)} deployment on this org pair (match by Name) and opens it here — push it, come back, run this one.">➕ Deploy ${esc(s.refObj)}</button>`
        : s.checking
          ? `<span class="ds-lkp-hint">⏳ checking alignment…</span>`
          : s.vd
            ? `<span class="ds-psync ds-psync-bad">🔴 ${s.vd.missing} missing · 🟡 ${s.vd.changed} changed · ${esc(timeAgo(s.vd.at))}</span> <button class="ds-btn ds-btn-xs${isNext ? ' ds-btn-primary' : ''}" data-recgap="${esc(s.refObj)}" title="Opens the ${esc(s.refObj)} Reconcile with this work waiting — fix, come back, continue down the list.">⚖ Open &amp; fix</button>`
            : `<span class="ds-lkp-hint">couldn't check automatically</span> <button class="ds-btn ds-btn-xs" data-recgap="${esc(s.refObj)}" title="Scans ${esc(s.refObj)} across this org pair and opens its Reconcile.">🔍 Compare &amp; fix</button>`;
      return `<div class="ds-ordstep${s.done ? ' ds-ordstep-done' : ''}${isNext ? ' ds-ordstep-next' : ''}">
        <span class="ds-ordstep-num">${i + 1}</span>
        <strong>${esc(s.refObj)}</strong> <span class="ds-lkp-hint">(via ${esc(s.field)})</span>
        ${status}${isNext ? '<span class="ds-ordstep-arrow">← next</span>' : ''}
      </div>`;
    };
    _recParentGapHtml = `<div class="ds-op-banner" style="border-left:3px solid ${doomed.length ? '#dc2626' : anyEmpty ? '#f59e0b' : 'var(--brand)'}">
      <span class="ds-op-banner-icon">⛓</span>
      <div class="ds-op-banner-body">
        <div class="ds-op-banner-title">${doomed.length ? '⛔ STOP — inserts here are guaranteed to fail until the parents exist. ' : ''}The correct order for this deployment</div>
        ${steps.map(stepHtml).join('')}
        <div class="ds-ordstep${allDone ? ' ds-ordstep-next' : ''}">
          <span class="ds-ordstep-num">${steps.length + 1}</span>
          <strong>${esc(objType)}</strong> <span class="ds-lkp-hint">— this deployment</span>
          ${allDone
            ? `<span class="ds-psync ds-psync-ok">parents ready — run the columns below ✓</span><span class="ds-ordstep-arrow">← next</span>`
            : `<span class="ds-lkp-hint">waits for the steps above — its lookups land on those records by name</span>`}
        </div>
      </div>
    </div>`;
    host.innerHTML = _recParentGapHtml;
    wire();
    // Background auto-verify: scan unchecked parents sequentially (parents
    // are reference-sized in a deployment context; the scan has its own
    // 5,000 caps regardless), deposit verdicts, then repaint this panel if
    // it's still on screen. One attempt per parent per scan — a failure
    // falls back to the manual button, never a retry loop.
    const toCheck = steps.filter(s => s.checking);
    if (toCheck.length) {
      (async () => {
        for (const s of toCheck) {
          _recParentGapChecked.add(`${key}|${s.refObj}`);
          try {
            const eph = { id: `chk_${Date.now()}`, name: `${s.refObj} check`,
              sourceOrg: p.sourceOrg, targetOrg: p.targetOrg, ephemeral: true,
              scanConfig: { matchField: 'Name', compareFields: [] },
              tree: { objectType: s.refObj, where: '', children: [] } };
            const res = await runDiffScan(eph);
            if (!res?.error) {
              sftkParentSyncPut(p.sourceOrg, p.targetOrg, s.refObj, {
                missing: (res.missingInTarget || []).length,
                changed: (res.changed || []).length,
                extra:   (res.onlyInTarget || []).length,
                at:      res.runAt || new Date().toISOString(),
              });
            }
          } catch (_) { /* manual button remains */ }
        }
        if (_recParentGapKey === key && eid('dsRecParentGaps')) {
          _recParentGapKey = ''; _recParentGapHtml = '';
          sftkRecParentGapAdvisor(p, scan, objType, missing);
        }
      })();
    }
  } catch (_) { /* advisory only — never break the page */ }
}

// tgtId → Name, learned from picks + panel-open resolution this session —
// keeps the chip readable without re-querying on every re-render.
const _lkpNameCache = new Map();

// Repaint every 🔗 badge for one record after a pick/clear — cheaper than
// a full renderReconcile, and it doesn't lose scroll position or selection.
function sftkLkpBadgeRefresh(p, srcId) {
  const n = Object.keys(sftkLkpOvGet(p.tree, p.targetOrg, srcId)).length;
  document.querySelectorAll(`[data-rec-lkp="${CSS.escape(srcId)}"]`).forEach(el => {
    el.classList.toggle('ds-lkp-on', n > 0);
    const c = el.querySelector('.ds-lkp-count');
    if (c) c.textContent = n ? ` ${n}` : '';
  });
}

// The expandable panel behind the 🔗 link: one row per steerable lookup,
// with what the SOURCE currently points at and a target-org search box.
// Picks persist immediately — they're profile config, not run-scoped
// selection state.
async function renderLkpOverridePanel(p, objType, srcId, host, tgtRecId) {
  // Self-heal the target id from the scan instead of trusting the caller:
  // the DOM-threaded attribute went missing on internal re-renders (pick/
  // clear called with 4 args) and the tgt → line silently vanished (user
  // 2026-08-09: "Still doesn't show the target record value"). The changed
  // bucket already knows this record's pair.
  if (!tgtRecId) {
    try {
      tgtRecId = (p.lastScan?.changed || []).find(r => r.sourceId === srcId)?.targetId || null;
    } catch (_) { tgtRecId = null; }
  }
  host.innerHTML = `<div class="ds-drift-compare-loading">Loading lookups…</div>`;
  const allSess = _buildAllSessions();
  const srcSess = _resolveSession(p.sourceOrg, allSess);
  const tgtSess = _resolveSession(p.targetOrg, allSess);
  if (!tgtSess?.sid) {
    host.innerHTML = `<div class="ds-drift-compare-err">⚠ Open ${esc(orgLabel(p.targetOrg || ''))} in a Chrome tab to search its records.</div>`;
    return;
  }
  let desc = null;
  try {
    const d = srcSess?.sid ? srcSess : tgtSess;
    desc = await describe(objType, d.orgUrl, d.sid);
  } catch (_) { desc = null; }
  const refs = sftkLkpRefFields(desc?.fields);
  if (!refs.length) {
    host.innerHTML = `<div class="ds-drift-compare-empty">${esc(objType)} has no lookup fields a hand-pick can steer (audit fields, owner and record type are resolved by the engine itself).</div>`;
    return;
  }
  const cur = sftkLkpOvGet(p.tree, p.targetOrg, srcId);

  // Current values on BOTH sides — what each lookup points at NOW, by the
  // related record's Name when the relationship exposes one (user 2026-08-09:
  // "Why we don't see the actual values of the fields"). Same enhanced-
  // select-with-plain-fallback pattern as fetchDriftRowDetail. The target
  // side only exists for CHANGED rows (missing rows have no target record).
  const fetchRecWithRels = async (sess, recId) => {
    if (!sess?.sid || !recId) return null;
    const enh = ['Id'], plain = ['Id'];
    for (const f of refs) {
      plain.push(f.name); enh.push(f.name);
      if (f.relationshipName) enh.push(`${f.relationshipName}.Name`);
    }
    const q = sel => sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid,
      _suppressError: true, query: `SELECT ${[...new Set(sel)].join(',')} FROM ${objType} WHERE Id = '${recId}'` });
    let r = await q(enh);
    if (r?.error) r = await q(plain);
    return r?.records?.[0] || null;
  };
  const [srcRec, tgtRec] = await Promise.all([
    fetchRecWithRels(srcSess, srcId),
    fetchRecWithRels(tgtSess, tgtRecId),
  ]);

  // SUGGESTED target records (user 2026-08-10: "I mean the suggested lookup
  // records") — the panel previews what the engine's name-bridge will pick
  // at run time: for each lookup whose source parent has a Name, find the
  // target record with that exact Name. One row → confident suggestion
  // (pinnable); several → ambiguity warning (first match wins — pin to be
  // sure); none → the lookup would land EMPTY, say it loudly.
  const suggestions = {};
  if (tgtSess?.sid && srcRec) {
    await Promise.all(refs.map(async f => {
      const relName = f.relationshipName && srcRec[f.relationshipName] ? srcRec[f.relationshipName].Name : null;
      const refObj = (f.referenceTo || [])[0];
      if (relName == null || !refObj) return;
      try {
        const q = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
          _suppressError: true,
          query: `SELECT Id, Name FROM ${refObj} WHERE Name = '${String(relName).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' LIMIT 2` });
        if (q?.error) return;
        const recs = q?.records || [];
        suggestions[f.name] = { srcName: relName, count: recs.length, id: recs[0]?.Id || null };
        if (recs[0]?.Name != null) _lkpNameCache.set(recs[0].Id, recs[0].Name);
      } catch (_) { /* suggestion is advisory — silence is the fallback */ }
    }));
  }

  // Resolve Names for already-picked target ids (one query per ref object;
  // failures degrade to showing the raw id).
  const byObj = {};
  for (const f of refs) {
    const id = cur[f.name];
    if (id && !_lkpNameCache.has(id)) {
      const obj = (f.referenceTo || [])[0];
      if (obj) (byObj[obj] = byObj[obj] || []).push(id);
    }
  }
  await Promise.all(Object.entries(byObj).map(async ([obj, ids]) => {
    const r = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
      _suppressError: true, query: `SELECT Id, Name FROM ${obj} WHERE Id IN ('${ids.join("','")}')` });
    for (const rec of (r?.records || [])) { if (rec.Name != null) _lkpNameCache.set(rec.Id, rec.Name); }
  }));

  // Record deep-link — lets the user jump from a value straight to the
  // actual record in its org (user: "we should be able to go to the next
  // level"). Plain Lightning URL; opens in a new tab.
  const recHref = (orgUrl, id) => `${String(orgUrl || '').replace(/\/$/, '')}/lightning/r/${id}/view`;
  const valOf = (rec, f) => {
    if (!rec) return { text: null, id: null };
    const rel = f.relationshipName ? rec[f.relationshipName] : null;
    const id = rec[f.name] || null;
    const text = (rel && rel.Name != null) ? String(rel.Name)
               : (id != null && id !== '') ? String(id) : null;
    return { text, id };
  };
  const valHtml = (orgUrl, rec, f, title) => {
    const v = valOf(rec, f);
    const label = v.text == null ? '∅ empty' : v.text;
    return v.id
      ? `<a href="${esc(recHref(orgUrl, v.id))}" target="_blank" rel="noopener" class="ds-lkpo-vallink" title="${esc(title)} — click to open the record in ${esc(orgLabel(orgUrl || ''))}">${esc(label)}</a>`
      : `<span class="ds-lkpo-valempty">${esc(label)}</span>`;
  };
  const rowsHtml = refs.map(f => {
    const refObjs = f.referenceTo || [];
    const picked = cur[f.name];
    const pickedNm = picked ? (_lkpNameCache.get(picked) || picked) : null;
    const sug = picked ? null : suggestions[f.name];
    const sugHtml = !sug ? ''
      : sug.count === 1 && sug.id
        ? `<div class="ds-lkpo-suggest">will connect → <a href="${esc(recHref(p.targetOrg, sug.id))}" target="_blank" rel="noopener" class="ds-lkpo-vallink">${esc(_lkpNameCache.get(sug.id) || sug.srcName)}</a> <span class="ds-psync ds-psync-ok" title="Exactly one ${esc((f.referenceTo || [])[0] || '')} record with this name exists in the target — the engine's name-bridge lands here at run time.">✓ name match</span> <button class="ds-btn ds-btn-xs" data-lkp-pin="${esc(f.name)}|${esc(sug.id)}" title="Pin this exact record — identical to what the engine would do, but explicit and immune to future renames or duplicate names.">📌 pin</button></div>`
      : sug.count >= 2
        ? `<div class="ds-lkpo-suggest"><span class="ds-psync ds-psync-bad">⚠ ${sug.count}+ records named “${esc(sug.srcName)}” in the target</span> — first match wins at run time; pin the right one from the search below.</div>`
        : `<div class="ds-lkpo-suggest"><span class="ds-psync ds-psync-bad">no “${esc(sug.srcName)}” in the target</span> — this lookup would land EMPTY at run time. Deploy the parents first, or pick a record below.</div>`;
    const sv = valOf(srcRec, f), tv = valOf(tgtRec, f);
    const differs = !!tgtRec && String(sv.text ?? '') !== String(tv.text ?? '');
    const same    = !!tgtRec && !differs;
    return `<div class="ds-lkpo-row${differs ? ' ds-lkpo-row-diff' : ''}" data-lkp-field="${esc(f.name)}" data-lkp-objs="${esc(refObjs.join(','))}">
      <div class="ds-lkpo-hd">
        <span class="ds-lkpo-field" title="${esc(f.name)}">${esc(f.label || f.name)}</span>
        <span class="ds-lkpo-type">Lookup(${esc(refObjs.join('/'))})</span>
        ${differs ? `<span class="ds-lkpo-diffchip" title="The two orgs point at different related records — this is the drift an overwrite or a hand-pick fixes">≠ differs</span>` : ''}
        ${same ? `<span class="ds-lkpo-samechip" title="Both orgs point at the same related record (by name)">= in sync</span>` : ''}
      </div>
      <div class="ds-lkpo-valgrid">
        <span class="ds-lkpo-sidetag" title="What the SOURCE record points at right now">SRC</span>
        <span class="ds-lkpo-val">${valHtml(p.sourceOrg, srcRec, f, 'What the SOURCE record points at right now')}</span>
        ${tgtRecId ? `
        <span class="ds-lkpo-sidetag ds-lkpo-sidetag-tgt" title="What the TARGET record points at right now — an overwrite or pick changes this">TGT</span>
        <span class="ds-lkpo-val">${valHtml(p.targetOrg, tgtRec, f, 'What the TARGET record points at right now')}</span>` : ''}
      </div>
      <span class="ds-lkpo-pick">
        ${sugHtml}
        ${picked
          ? `<span class="ds-lkpo-chip" title="Hand-picked target record (${esc(picked)}) — for THIS record in ${esc(orgLabel(p.targetOrg || ''))} the engine writes this exact Id, beating name-matching.">→ <a href="${esc(recHref(p.targetOrg, picked))}" target="_blank" rel="noopener" class="ds-lkpo-vallink" title="Open the picked record in ${esc(orgLabel(p.targetOrg || ''))}">${esc(pickedNm)}</a> <button class="ds-lkpo-clear" data-lkp-clear="${esc(f.name)}" title="Remove the pick — the engine falls back to matching by name">✕</button></span>`
          : `${refObjs.length > 1 ? `<select class="ds-lkpo-objsel" title="Polymorphic lookup — pick which object to search">${refObjs.map(o => `<option>${esc(o)}</option>`).join('')}</select>` : ''}
             <input type="text" class="ds-lkpo-search" data-lkp-search="${esc(f.name)}" placeholder="🔍 search ${esc(refObjs[0] || '')} in ${esc(orgLabel(p.targetOrg || 'target'))}…">
             <div class="ds-lkpo-results" style="display:none"></div>`}
      </span>
    </div>`;
  }).join('');
  host.innerHTML = `<div class="ds-lkpo-panel">
    <div class="ds-lkpo-hdr" title="Hand-pick the exact target record each lookup should point at AFTER deploy — per record, per target org. Picks are saved on the deployment (never exported) and beat name-matching in the engine.">🔗 Lookup targets for this record <span class="ds-lkpo-hdr-sub">saved per target org · overrides name-matching</span></div>
    ${rowsHtml}</div>`;

  host.querySelectorAll('[data-lkp-search]').forEach(inp => {
    const row = inp.closest('.ds-lkpo-row');
    const res = row.querySelector('.ds-lkpo-results');
    let timer = null;
    const run = async () => {
      const term = inp.value.trim();
      const obj = row.querySelector('.ds-lkpo-objsel')?.value || (row.dataset.lkpObjs || '').split(',')[0];
      if (!obj) return;
      res.style.display = 'block';
      res.innerHTML = `<div class="ds-drift-compare-loading">Searching…</div>`;
      const where = term ? ` WHERE Name LIKE '%${sftkLkpSoqlLike(term)}%'` : '';
      // Never fail SILENTLY here — an exception without this catch left the
      // dropdown blank with no explanation (user 2026-08-10: "blank").
      let r;
      try {
        r = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
          _suppressError: true, query: `SELECT Id, Name FROM ${obj}${where} ORDER BY LastModifiedDate DESC LIMIT 15` });
      } catch (e) {
        r = { error: e?.message || String(e) };
      }
      if (r?.error) { res.innerHTML = `<div class="ds-drift-compare-err">⚠ Search failed: ${esc(r.error)} — is ${esc(orgLabel(p.targetOrg || ''))} still signed in?</div>`; return; }
      const recs = r?.records || [];
      res.innerHTML = recs.length
        ? recs.map(x => `<button class="ds-lkpo-hit" data-lkp-hit="${esc(x.Id)}" title="${esc(x.Id)}">${esc(x.Name != null ? x.Name : x.Id)}</button>`).join('')
        : `<div class="ds-drift-compare-empty">No ${esc(obj)} record matches ${term ? `“${esc(term)}”` : 'that'} in the target.</div>`;
      res.querySelectorAll('[data-lkp-hit]').forEach(b => b.addEventListener('click', async () => {
        const field = row.dataset.lkpField;
        sftkLkpOvSet(p.tree, p.targetOrg, srcId, field, b.dataset.lkpHit);
        _lkpNameCache.set(b.dataset.lkpHit, b.textContent);
        if (!p.ephemeral) await storageSaveProfiles();
        sftkLkpBadgeRefresh(p, srcId);
        renderLkpOverridePanel(p, objType, srcId, host, tgtRecId);
      }));
    };
    inp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 300); });
    inp.addEventListener('focus', () => { if (res.style.display === 'none') run(); });
  });
  host.querySelectorAll('[data-lkp-clear]').forEach(b => b.addEventListener('click', async () => {
    sftkLkpOvClear(p.tree, p.targetOrg, srcId, b.dataset.lkpClear);
    if (!p.ephemeral) await storageSaveProfiles();
    sftkLkpBadgeRefresh(p, srcId);
    renderLkpOverridePanel(p, objType, srcId, host, tgtRecId);
  }));
  // 📌 pin the suggested name-match as an explicit pick.
  host.querySelectorAll('[data-lkp-pin]').forEach(b => b.addEventListener('click', async () => {
    const [field, id] = (b.dataset.lkpPin || '').split('|');
    if (!field || !id) return;
    sftkLkpOvSet(p.tree, p.targetOrg, srcId, field, id);
    if (!p.ephemeral) await storageSaveProfiles();
    sftkLkpBadgeRefresh(p, srcId);
    renderLkpOverridePanel(p, objType, srcId, host, tgtRecId);
  }));
}

