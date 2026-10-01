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
      <div class="ds-modal-header">🚀 Deploy — pick the target</div>
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
                extra:   (p.lastScan.onlyInTarget || []).length, ambiguous: (p.lastScan.ambiguous || []).length,
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
  // ✨ Deploy view (beta) — the switch on Data Deployment decides which page a
  // deployment opens in. Off (the default) → exactly the classic page.
  _currentView = (typeof sftkDeployViewOn === 'function' && sftkDeployViewOn()) ? 'deploy' : 'reconcile';
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
          changed: (s.changed || []).length, extra: (s.onlyInTarget || []).length, ambiguous: (s.ambiguous || []).length, at: s.runAt };
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
      extra:   (fs.onlyInTarget || []).length, ambiguous: (fs.ambiguous || []).length,
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

// Selection belongs to ONE deployment pair. _recFileSel MUST reset too: its
// keys are source-side only (`sourceId|checksum`), so two pairs sharing a
// source org produce IDENTICAL keys — a selection made for target A would
// render pre-checked and arm 📎 Move against target B (QA sweep 2026-08-16,
// confirmed HIGH). Shared by ⚖ Reconcile and the Deploy view.
function sftkRecResetSelectionFor(p) {
  if (_recLastProfileId === p.id) return;
  _recSel = { push: new Set(), overwrite: new Set(), updSrc: new Set(), del: new Set(), pull: new Set() };
  _recChildSel = {}; _recOrderOverride = {}; _recChildOpen = {};
  _recFileSel = new Set();
  _recLastProfileId = p.id;
}

// PURE. The newest History entry (a run OR a rollback — both write) that
// finished after the scan and touched either org of this pair, or null.
// Shared by the classic page, the Deploy page and the record picker.
function sftkScanStaleRun(history, p, scanRunAt) {
  if (!p || !scanRunAt) return null;
  const okey = u => sftkOrgKey(u);
  const pair = new Set([okey(p.sourceOrg), okey(p.targetOrg)]);
  for (let i = (history || []).length - 1; i >= 0; i--) {
    const h = history[i];
    const done = h && (h.completedAt || h.startedAt);
    if (done && done > scanRunAt &&
        (pair.has(okey(h.sourceOrg || h.srcOrgUrl)) || pair.has(okey(h.targetOrg || h.tgtOrgUrl)))) return h;
  }
  return null;
}

// Is p.lastScan usable for THIS deployment? The objectType check is
// SAFETY-critical, not cosmetic: if the profile's root object changed after
// the last scan, the old buckets carry record Ids of a DIFFERENT object — and
// Delete passes those raw Ids to SF_COLLECTIONS_DELETE, which deletes by Id
// regardless of type. Org identity, not string identity — a crown move or a
// ring-follow rewrite can change the URL FORM of the same org and must not
// fake-stale the scan (QA sweep 2026-08-10). Shared by both pages.
function sftkRecScanFresh(p) {
  const scan = p && p.lastScan;
  const objType = p?.tree?.objectType || p?.tree?.childSObject || '?';
  return !!(
    scan && scan.status === 'success' &&
    (!scan.objectType || scan.objectType === objType) &&
    (!scan.sourceOrg || sftkOrgKey(scan.sourceOrg) === sftkOrgKey(p.sourceOrg || '')) &&
    (!scan.targetOrg || sftkOrgKey(scan.targetOrg) === sftkOrgKey(p.targetOrg || ''))
  );
}

// PURE. Where a child Insert row's PARENT stands — decides whether the row is
// selectable. 'untracked' is NOT selectable ('deepblock' is kept as a state
// name for the callers, but is no longer returned). Shared by both pages so
// the rule cannot drift.
// Campaign 3 phase 4 (2026-09-29): a parent missing in the target no longer
// blocks a grandchild — the run inserts the missing ancestors first, in the
// same run (sftkRecOnePassPlan), so every depth answers 'missing'
// ("comes along"). The `depth` argument stays for the callers' signature.
function sftkRecChildRowState(r, depth, pMissingSet, pExistsSet) {
  if (!r || !r.parentSrcId) return 'none';
  if (pMissingSet.has(r.parentSrcId)) return 'missing';
  if (pExistsSet.has(r.parentSrcId)) return 'exists';
  return 'untracked';
}

// PURE. Campaign 3 phase 4 — the whole tree in ONE pass. Before this a
// grandchild whose parent was missing in the target could not be selected:
// a real hierarchy took two or three runs (insert, rescan, insert…).
// Input:
//   rootSel      root source ids ticked for insert
//   rootMissing  Set of root source ids missing in the target
//   nodes        { [pathKey '0', '0.1'…]: { missing: Map(srcId → parentSrcId|null),
//                  parentMissing: Set, parentExists: Set } }  (the parent's scan)
//   sel          { [pathKey]: Set of ticked source ids }
// 1. Closure, deepest level first: a ticked record whose parent is missing in
//    the target pulls that parent into the run (counted in `auto`), and so on
//    up to the root.
// 2. Anchors, shallowest first: each record rides under the TOPMOST ancestor
//    this run inserts. Anchor '' = the root tree call; anchor = its own path
//    when its parent already exists in the target (a call rooted there, the
//    parent attached by the scan's pairing); a record whose parent can be
//    neither found nor inserted is `dropped` (named in the run log).
// 3. Calls: root = { recordIds, rides: {path: ids} }; b[path] = the call
//    rooted at that path with its own rides. Inside one call the engine
//    writes parents before children and links each child to the id its
//    parent got moments earlier (the run's id map).
function sftkRecOnePassPlan(input) {
  const { rootSel, rootMissing, nodes, sel } = input || {};
  const parentPath = k => String(k).split('.').slice(0, -1).join('.');
  const depth = k => (k === '' ? 0 : String(k).split('.').length);
  const paths = Object.keys(nodes || {});
  const ins = { '': new Set(rootSel || []) };
  const auto = { '': 0 };
  for (const k of paths) {
    ins[k] = new Set(); auto[k] = 0;
    for (const id of ((sel && sel[k]) || [])) if (nodes[k].missing.has(id)) ins[k].add(id);
  }
  for (const k of [...paths].sort((a, b) => depth(b) - depth(a))) {
    const pk = parentPath(k);
    for (const id of ins[k]) {
      const p = nodes[k].missing.get(id);
      if (!p || !nodes[k].parentMissing.has(p)) continue;
      if (pk === '') {
        if (rootMissing && rootMissing.has(p) && !ins[''].has(p)) { ins[''].add(p); auto['']++; }
      } else if (nodes[pk] && nodes[pk].missing.has(p) && !ins[pk].has(p)) { ins[pk].add(p); auto[pk]++; }
    }
  }
  const anchor = { '': new Map([...ins['']].map(id => [id, ''])) };
  const dropped = {};
  for (const k of [...paths].sort((a, b) => depth(a) - depth(b))) {
    const pk = parentPath(k);
    anchor[k] = new Map(); dropped[k] = 0;
    for (const id of ins[k]) {
      const p = nodes[k].missing.get(id);
      if (p && anchor[pk] && anchor[pk].has(p)) anchor[k].set(id, anchor[pk].get(p));
      else if (!p || nodes[k].parentExists.has(p)) anchor[k].set(id, k);
      else dropped[k]++;
    }
  }
  const root = { recordIds: [...ins['']], rides: {} };
  const b = {};
  for (const k of paths) {
    for (const [id, at] of anchor[k]) {
      if (at === '') (root.rides[k] = root.rides[k] || []).push(id);
      else {
        const call = (b[at] = b[at] || { recordIds: [], rides: {} });
        if (at === k) call.recordIds.push(id);
        else (call.rides[k] = call.rides[k] || []).push(id);
      }
    }
  }
  return { ins, auto, anchor, dropped, root, b };
}

// PURE. The tree for one engine call: only the child nodes that carry rides
// in this call, each with exactly those records (never "every child of the
// parents" — a node without picks would copy the whole child table), at any
// depth. `decorate(copy, path)` applies the run's per-node choices (insert
// order). `children` are the profile's nodes under `basePath` ('' = root).
function sftkRecPruneTree(children, basePath, rides, decorate) {
  return (children || []).map((c, i) => {
    const p = basePath === '' ? String(i) : `${basePath}.${i}`;
    const ids = rides && rides[p];
    if (!ids || !ids.length) return null;
    const cc = JSON.parse(JSON.stringify(c));
    cc.recordIds = ids;
    cc.children = sftkRecPruneTree(c.children, p, rides, decorate);
    if (typeof decorate === 'function') decorate(cc, p);
    return cc;
  }).filter(Boolean);
}

async function renderReconcile() {
  // ✨ Deploy view (beta): every repaint the classic code asks for — after a
  // run, a rescan, a child scan — lands on the page the user is actually on.
  // 1.5.0 — every door into this page (cards, History, Compare, Ring, Seeder)
  // opens the Deploy view; they all end in renderReconcile(), so this is the one seam.
  if (typeof renderDeploy === 'function' && typeof sftkDeployViewOn === 'function' && sftkDeployViewOn()) { _currentView = 'deploy'; return renderDeploy(); }
  if (_currentView === 'deploy' && typeof renderDeploy === 'function') return renderDeploy();
  const p = _reconcileProfile;
  if (!p) { renderProfiles(); return; }

  // Reset selection when switching to a different profile (shared rule).
  sftkRecResetSelectionFor(p);

  const objType = p.tree?.objectType || p.tree?.childSObject || '?';
  const scan    = p.lastScan;
  // objectType check is SAFETY-critical, not cosmetic: if the profile's root
  // object changed after the last scan, the old scan's buckets carry record
  // Ids of a DIFFERENT object — and Delete passes those raw Ids to
  // SF_COLLECTIONS_DELETE, which deletes by Id regardless of type.
  // Org identity, not string identity — a crown move or ring-follow rewrite
  // can change the URL FORM of the same org and must not fake-stale the scan
  // (same trap the QA sweep confirmed in the ring deposits, 2026-08-10).
  const scanFresh = sftkRecScanFresh(p);

  // 🎯 — how trustworthy this scan's matching was (fields + confidence %).
  const _acc = (scanFresh && typeof sftkScanAccuracy === 'function') ? sftkScanAccuracy(scan) : null;

  // Deposit this scan's verdict in the session sync map — the Builder's
  // lookup rows and other objects' parents-first panels read it.
  if (scanFresh) {
    sftkParentSyncPut(p.sourceOrg, p.targetOrg, objType, {
      missing: (scan.missingInTarget || []).length,
      changed: (scan.changed || []).length,
      extra:   (scan.onlyInTarget || []).length, ambiguous: (scan.ambiguous || []).length,
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
    try { staleRun = sftkScanStaleRun(_history, p, scan.runAt); } catch (_) { staleRun = null; }
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
    help: 'The repair shop of the compare trio, for ONE source → target pair. Every number here comes from the last 🔄 scan — a point-in-time measurement, matched by your match key, never by record Id. Each bucket has its own action: push what’s missing, overwrite what changed, relink children, review extras — nothing writes until you click its action. For the same measurement across every ring target, use the Sync Ring matrix — its ⚖ opens this page for that target.',
    subtitle: `${esc(orgLabel(p.sourceOrg || ''))} → ${esc(orgLabel(p.targetOrg || ''))} ${prodBadge(p.targetOrg)}${scanFresh ? ` · scanned ${esc(timeAgo(scan.runAt))}` : ''}${scanFresh && scan.fetched ? ` · read ${scan.fetched.src}${scan.fetched.srcTotal != null ? ` of ${scan.fetched.srcTotal}` : ''} source / ${scan.fetched.tgt}${scan.fetched.tgtTotal != null ? ` of ${scan.fetched.tgtTotal}` : ''} target` : ''}${scanFresh && scan.where ? ` · <span class="ds-mm-chip" style="font-size:11px;padding:1px 7px;border-radius:9px;background:#fef3c7;color:#92400e" title="This WHERE scoped BOTH orgs' fetches — a record it excludes appears in NO bucket. Clear it in the builder's WHERE box if you expected that record here.">WHERE ${esc(scan.where)}</span>` : ''}${scanFresh && scan.memoryMatched ? ` · <span class="ds-mm-chip" style="font-size:11px;padding:1px 7px;border-radius:9px;background:#eef2ff;color:#4338ca;white-space:nowrap" title="${scan.memoryMatched} record pair(s) matched by remembered identity (match memory) instead of key — they survive renames on either side.">🧠 ${scan.memoryMatched} matched from memory</span>` : ''}${_acc ? ` · ${accuracyChip(_acc)}` : ''}`,
    actions: `${p.ephemeral ? `<button class="ds-btn ds-btn-sm ds-btn-primary" data-dsaction="saveEphemeralProfile"
          title="Keep this as a saved deployment — re-run it, retry failures, and track sync from the Data Deployment page. Right now it disappears when you leave this view.">💾 Save as deployment</button>` : ''}
        <button class="ds-btn ds-btn-sm" data-dsaction="openDeployView" title="Open this deployment in the new Deploy view (beta): one page that says what is already in the target and lists every object's records. Same scan, same selection, same engine — ↩ Classic view brings you back here.">✨ New view</button>
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
  // 🔒 Write locks (Connected Orgs → Lock writes). A locked SOURCE makes every
  // ← control unavailable here; a locked TARGET is stopped at ▶ Run.
  const _isLocked = u => (typeof window.sftkOrgLocked === 'function') && window.sftkOrgLocked(u);
  const srcLocked = _isLocked(p.sourceOrg), tgtLocked = _isLocked(p.targetOrg);
  const srcLockTip = `🔒 Writes to ${orgLabel(p.sourceOrg)} are locked (Connected Orgs → Unlock writes) — nothing on this page can write into it`;
  const lkpN = id => Object.keys(sftkLkpOvGet(p.tree, p.targetOrg, id)).length;
  const lkpLink = (id, tgtId) => {
    if (!id) return '';
    const n = lkpN(id);
    return `<span class="ds-rec-drift-link${n ? ' ds-lkp-on' : ''}" data-rec-lkp="${esc(id)}"${tgtId ? ` data-rec-lkp-tgt="${esc(tgtId)}"` : ''} title="Hand-pick which TARGET record each lookup field should point at for THIS record — saved per target org, beats name-matching in the engine.">🔗<span class="ds-lkp-count">${n ? ` ${n}` : ''}</span></span>`;
  };
  const lkpExpand = id => id ? `<div class="ds-rec-drift-expand ds-rec-lkp-expand" data-lkp-expand="${esc(id)}" style="display:none"></div>` : '';
  // Child rows: the same link, counting the CHILD node's picks; data-recc-lkp
  // (the node path) routes the click to the child handler.
  const lkpLinkC = (pathKey, node, id, tgtId) => {
    if (!id) return '';
    const n = Object.keys(sftkLkpOvGet(node, p.targetOrg, id)).length;
    return `<span class="ds-rec-drift-link${n ? ' ds-lkp-on' : ''}" data-rec-lkp="${esc(id)}" data-recc-lkp="${esc(pathKey)}"${tgtId ? ` data-rec-lkp-tgt="${esc(tgtId)}"` : ''} title="Hand-pick which TARGET record each lookup field should point at for THIS record — saved per target org, beats name-matching in the engine.">🔗<span class="ds-lkp-count">${n ? ` ${n}` : ''}</span></span>`;
  };

  // NOTHING is selected until the user selects it (user 2026-09-14, from a
  // work session: "when we open the reconcile everything is checked by
  // default. I want to make sure it's not and let the user pick every
  // record"). The old seed also re-armed itself on every re-render once the
  // user had unticked everything — the "✓ All" button per column is the
  // one-click way to select a whole bucket on purpose.

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
                  data-rec-driftdir="updSrc" data-rec-id="${esc(sid)}" ${srcLocked ? 'disabled' : ''}
                  title="${srcLocked ? esc(srcLockTip) : 'Update the SOURCE record with the target\'s values'}">←</button>
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
          <button class="ds-btn ds-btn-xs" data-rec-driftdir-all="updSrc" ${srcLocked ? 'disabled' : ''} title="${srcLocked ? esc(srcLockTip) : 'Target wins everywhere — update all source records'}">← all</button>
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
                  data-rec-extra="pull" data-rec-id="${esc(tgtId)}" ${srcLocked ? 'disabled' : ''}
                  title="${srcLocked ? esc(srcLockTip) : 'Pull this record into the source org'}">← Pull</button>
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
          <button class="ds-btn ds-btn-xs" data-rec-extra-all="pull" ${srcLocked ? 'disabled' : ''} title="${srcLocked ? esc(srcLockTip) : 'Pull all'}">← Pull all</button>
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
      // Point at the toggle that actually exists for THIS profile. An
      // ephemeral pair has no Builder node, so telling its user to \"toggle
      // it in the Builder\" sends them somewhere they cannot act.
      const where = p?.ephemeral
        ? 'this pair was scanned without them — re-open ⚖ from the Seeder to include attachments'
        : 'toggle 📎 Files on this object in the Builder, rescan, and missing attachments appear here';
      filesHtml = `<div style="margin:4px 8px;font-size:11px;opacity:.75">📎 files not compared — ${where}.</div>`;
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
          <button class="ds-btn ds-btn-xs" id="dsStampPairsBtn"
            title="🪪 Write each matched source record's Id into the target's SFTK_ID__c identity field. From then on these pairs match EXACTLY — renames and duplicate names can no longer confuse them. Requires the identity field in the target — ${esc(sftkIdHowToCreate())}. One quoted, chunked update; nothing else is touched.">🪪 Stamp identity</button>
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
    const rowState = r => sftkRecChildRowState(r, depth, pMissingSet, pExistsSet);
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
        <span class="ds-rec-drift-link" data-recc-drift="${pathKey}" data-rec-pair="${esc(r.sourceId)}|${esc(r.targetId)}" title="See which fields differ">▸ fields</span>
        ${lkpLinkC(pathKey, node, r.sourceId, r.targetId)}
      </div>
      ${r.sourceId ? `<div class="ds-rec-drift-expand ds-rec-lkp-expand" data-lkp-expand-c="${pathKey}|${esc(r.sourceId)}" style="display:none"></div>` : ''}`;
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

    // Nothing to do in ANY bucket → one line instead of four empty columns
    // (user 2026-09-18: a clean Contact section cost two screens of "none").
    const kidAllEmpty = !(cs.missingInTarget || []).length && !(cs.linkMismatch || []).length
      && !(cs.changed || []).length && !(cs.onlyInTarget || []).length;
    const kidEmptyCls = kidAllEmpty ? ' ds-rec-cols-hide' : '';
    const _pa = cs.personContacts;
    const kidEmptyStrip = kidAllEmpty ? `<div class="ds-rec-card ds-rec-card-good ds-rec-card-tight"><span class="ds-rec-card-ico">✓</span><div><b>Nothing to do for ${esc(childObj)}</b> — no records to insert, relink, update or delete under these parents${(cs.identical || []).length ? ` · ${(cs.identical || []).length.toLocaleString()} synced (listed below)` : ''}.${_pa && (_pa.src || _pa.tgt) ? ` ${esc(sftkPaContactsLine(_pa, orgLabel(p.sourceOrg), orgLabel(p.targetOrg)))}` : ''}</div></div>` : '';

    return `
    <div class="ds-rec-child-body">
      ${scopeNote}${capNote}${collisionNote}${nearNote}${blankNote}${orphanNote}${plNote}${phNote}
      ${kidEmptyStrip}
      ${!kidAllEmpty && _pa && (_pa.src || _pa.tgt) ? `<div class="ds-rec-child-info">${esc(sftkPaContactsLine(_pa, orgLabel(p.sourceOrg), orgLabel(p.targetOrg)))}</div>` : ''}
      <div class="ds-rec-cols ds-rec-cols-child${kidEmptyCls}">
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
      <div class="ds-rec-cols ds-rec-cols-child${kidEmptyCls}">
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
      ${(() => {
        // 🟢 Synced fold for CHILDREN (user 2026-08-18: "we don't show
        // synced for the childs") — matched pairs were only a header count;
        // the root's green column never covers child objects. Same pair
        // rows + both-org links, collapsed so the action buckets stay the
        // focus.
        const idn = cs.identical || [];
        const rh = (org, id) => `${esc(String(org || '').replace(/\/$/, ''))}/lightning/r/${esc(id)}/view`;
        const syncRows = idn.slice(0, 200).map(r => `
          <div class="ds-rec-col-row ds-rec-row-sync">
            <span class="ds-rec-col-key" title="${keyLbl(r.matchKey)}">${keyLbl(r.matchKey)}</span>
            ${r.personAccount ? '<span class="ds-rec-pnote" title="The Contact behind a Person Account — Salesforce creates and owns it. Shown because it matches; never offered for insert, update or delete.">👤 person account</span>' : ''}
            <span style="margin-left:auto;white-space:nowrap;font-size:11px">
              <a href="${rh(p.sourceOrg, r.sourceId)}" target="_blank" rel="noopener">src</a> ·
              <a href="${rh(p.targetOrg, r.targetId)}" target="_blank" rel="noopener">tgt</a></span>
          </div>`).join('');
        return `<details class="ds-rec-child-syncfold">
          <summary class="ds-rec-col-hdr ds-diff-sync" style="cursor:pointer"${csAttr(cs, 'identical', 'synced')}>🟢 <strong>Synced ${csLbl(cs, 'identical')}</strong>
            <span class="ds-rec-col-sub">verified matching — records in both orgs with equal values${csInfo(cs, 'identical').capped ? ' · list truncated' : ''}</span></summary>
          <div class="ds-rec-col-list" style="max-height:240px;overflow-y:auto">${syncRows || '<div class="ds-rec-col-empty">none</div>'}</div>
          ${idn.length > 200 ? `<div class="ds-rec-child-info">first 200 of ${idn.length} pair(s) listed — the header count is the truth.</div>` : ''}
        </details>`;
      })()}
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
    _health.push(sftkRecDupsHtml(scan, p));
  }
  // The memory note earns its place ONLY next to actual key oddities it is
  // excusing — "review them deliberately" with nothing shown to review is a
  // call to action without objects (user 2026-08-10: "yea but i shows
  // nothing"). A clean state speaks for itself.
  if (scan.memoryMatched && scan.dupKeys?.rows) {
    _health.push(`<div class="ds-rec-card-line">🧠 ${scan.memoryMatched} pair(s) matched by remembered identity, not by name — that is why the duplicates did not block matching. Fix the duplicates; matching itself is fine.</div>`);
  }
  if (srcLocked) _health.push(`<div class="ds-rec-card-line">🔒 Writes to <b>${esc(orgLabel(p.sourceOrg))}</b> are locked — every ← control on this page is off. Unlock it in Connected Orgs if you really mean to write into the source.</div>`);
  if (tgtLocked) _health.push(`<div class="ds-rec-card-line">🔒 Writes to <b>${esc(orgLabel(p.targetOrg))}</b> are locked — ▶ Run will refuse anything that writes into it. Unlock it in Connected Orgs first.</div>`);
  if (scan.personContacts && (scan.personContacts.src || scan.personContacts.tgt)) {
    _health.push(`<div class="ds-rec-card-line">${esc(sftkPaContactsLine(scan.personContacts, orgLabel(p.sourceOrg), orgLabel(p.targetOrg)))}</div>`);
  }
  const _healthHtml = _health.length ? _health.join('') : '';
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
  // Compact cards (user 2026-09-15: "can we improve the following ui
  // section"): counts as chips, one hint line, warnings folded — same facts.
  const _kidChips = _kids.map(k => `<span class="ds-rec-stat ds-rec-stat-kid"><b>${esc(k.obj)}</b> ${[
    k.m ? `${k.m} to insert` : null, k.c ? `${k.c} changed` : null,
    k.l ? `${k.l} to relink` : null, k.e ? `${k.e} target-only` : null,
  ].filter(Boolean).join(' · ')} <span class="ds-rec-stat-sub">child section below</span></span>`);
  const _syncStrip = (_rootClean && !_kids.length)
    ? ((_health.length || _fdRecs || _kidsUnscanned)
      ? `<div class="ds-rec-card ds-rec-card-warn">
          <div class="ds-rec-card-hd"><span class="ds-rec-card-ico">${_fdRecs ? '📎' : _kidsUnscanned ? '🔎' : '⚠'}</span>
            <span class="ds-rec-card-title">${_fdRecs ? 'Fields in sync — files still missing' : _kidsUnscanned ? 'Root object in sync — children unverified' : 'Worth reading before you run'}</span></div>
          ${_fdRecs ? `<div class="ds-rec-card-line">📎 <b>${scan.fileDrift.missingFiles}</b> file(s) exist in <b>${esc(orgLabel(p.sourceOrg))}</b> but not on the matched records in <b>${esc(orgLabel(p.targetOrg))}</b> — not fully synced until they move (🟢 Synced tab → select &amp; move). Changed the source or direction just now? Then these are the same files measured the other way, not new work.</div>` : ''}
          ${_kidsUnscanned ? `<div class="ds-rec-card-line">🔎 ${_kidsUnscanned} child section(s) below ${_kidsUnscanned === 1 ? 'has' : 'have'} no fresh scan against this target — child records are unknown, not verified. Open each section and Scan.</div>` : ''}
          ${_healthHtml}
        </div>`
      : '')
    : `<div class="ds-rec-card ds-rec-card-warn">
        <div class="ds-rec-card-hd"><span class="ds-rec-card-ico">🎯</span>
          <span class="ds-rec-card-title">Still needed to be in sync</span>
          <span class="ds-rec-card-hint">select below → ▶ Run → this re-checks itself</span></div>
        <div class="ds-rec-stats">
          ${missing.length ? `<span class="ds-rec-stat ds-rec-stat-ins"><b>${missing.length}</b> to insert <span class="ds-rec-stat-sub">Insert column</span></span>` : ''}
          ${drift.length ? `<span class="ds-rec-stat ds-rec-stat-chg"><b>${drift.length}</b> changed <span class="ds-rec-stat-sub">pick a winner per row · → source · ← target</span></span>` : ''}
          ${extras.length ? `<span class="ds-rec-stat ds-rec-stat-ext"><b>${extras.length}</b> target-only <span class="ds-rec-stat-sub">🗑 delete, or ← pull into the source (rewrites the source of truth)</span></span>` : ''}
          ${_fdRecs ? `<span class="ds-rec-stat">📎 <b>${scan.fileDrift.missingFiles}</b> file(s) on ${_fdRecs} record(s) <span class="ds-rec-stat-sub">Synced tab</span></span>` : ''}
          ${_kidChips.join('')}
        </div>
        ${_kidsUnscanned ? `<div class="ds-rec-card-line">🔎 ${_kidsUnscanned} child section(s) not scanned against this target yet — unknown until scanned.</div>` : ''}
        ${_healthHtml}
      </div>`;

  setMain(`${headerHtml}
    ${_sessNote}
    ${_journeyHtml}
    <div id="dsRecParentGaps"></div>
    ${_syncStrip}
    <div class="ds-rec-legend" title="What each control on this page writes, and where">
      <span class="ds-rec-legend-dir">⚖ <b>${esc(orgLabel(p.sourceOrg))}</b> → <b>${esc(orgLabel(p.targetOrg))}</b></span>
      <span class="ds-rec-legend-item"><b>→</b> writes into ${esc(orgLabel(p.targetOrg))}</span>
      <span class="ds-rec-legend-item"><b>←</b> writes back into ${esc(orgLabel(p.sourceOrg))} — opt-in, per row</span>
      <span class="ds-rec-legend-item"><b>🗑</b> deletes from ${esc(orgLabel(p.targetOrg))}</span>
      <span class="ds-rec-legend-item">nothing writes until you ▶ Run</span>
    </div>

    ${_recCapNote ? `<div class="ds-rec-card ds-rec-card-warn ds-rec-card-tight"><span class="ds-rec-card-ico">⚠</span><div>${esc(_recCapNote)}</div></div>` : ''}
    ${scan.nearMisses ? `<div class="ds-rec-card ds-rec-card-warn ds-rec-card-tight"><span class="ds-rec-card-ico">≈</span><div>${scan.nearMisses} record pair(s) almost matched — keys differ only by whitespace or case (marked ≈ below). Enable Trim spaces / Case-insensitive in 🎯 Pick Records → Matching, or fix the values, then rescan.</div></div>` : ''}

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
          <span>batch size</span>
          <input id="dsRecBatchSize" class="ds-input ds-input-sm" type="number" min="1" max="200" step="1"
            style="width:72px;text-align:right" value="${Math.max(1, Math.min(200, Number(p.batchSize) || 200))}"
            ${p.apiMode === 'bulk' ? 'disabled' : ''}>
          <span>per call</span>
        </span>
        <span id="dsRecThreadsWrap" style="display:inline-flex;align-items:center;gap:4px${p.apiMode === 'bulk' ? ';opacity:.45' : ''}"
          title="How many batches run in parallel (1-6). Higher values are faster at scale, but parallel writes can hit row locks when records share a parent — lower this if you see UNABLE_TO_LOCK_ROW. Applies to the synchronous engine only; a Bulk job is a single upload, so this is disabled in Async mode.">
          <span>threads</span>
          <input id="dsRecThreads" class="ds-input ds-input-sm" type="number" min="1" max="6" step="1"
            style="width:56px;text-align:right" value="${Math.max(1, Math.min(6, Number(p.threads) || 1))}"
            ${p.apiMode === 'bulk' ? 'disabled' : ''}>
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
  // Drift "▸ fields" — the field-by-field compare opens in a wide modal
  // (sftkOpenDriftCompare); the inline expander was too narrow to read.
  const rawKey = r => r ? (typeof sftkMatchKeyLabel === 'function' ? sftkMatchKeyLabel(r.matchKey) : String(r.matchKey ?? '')) : '';
  document.querySelectorAll('[data-rec-drift]').forEach(link => {
    link.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const [srcId, tgtId] = (link.dataset.recDrift || '').split('|');
      const row = drift.find(r => r.sourceId === srcId);
      sftkOpenDriftCompare(p, objType, srcId, tgtId,
        scan.compareFields || [], scan.compareFieldsTgt || scan.compareFields || [],
        rawKey(row) || srcId, row?.fields || []);
    });
  });

  // Child changed rows: the same ▸ fields and 🔗 the root rows have, driven
  // by the CHILD's object, node and scan (user 2026-09-16: "On child records
  // who are changed you can't open them and see their lookups").
  const childView = (pathKey) => {
    const node = getNodeByPath(p.tree, pathKey);
    const cs = scan.children?.[pathKey];
    const obj = node?.objectType || node?.childSObject;
    if (!node || !cs || !obj) return null;
    // A view of the profile rooted at the child node — NOT a clone: a pick
    // made through it lands on the real node and is saved with the profile.
    return { node, cs, obj, prof: { ...p, tree: node, lastScan: cs } };
  };
  document.querySelectorAll('[data-recc-drift]').forEach(link => {
    link.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const v = childView(link.dataset.reccDrift); if (!v) return;
      const [srcId, tgtId] = (link.dataset.recPair || '').split('|');
      const row = (v.cs.changed || []).find(r => r.sourceId === srcId);
      sftkOpenDriftCompare(v.prof, v.obj, srcId, tgtId,
        v.cs.compareFields || [], v.cs.compareFieldsTgt || v.cs.compareFields || [],
        rawKey(row) || srcId, row?.fields || []);
    });
  });
  document.querySelectorAll('[data-recc-lkp]').forEach(link => {
    link.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const v = childView(link.dataset.reccLkp); if (!v) return;
      const srcId = link.dataset.recLkp;
      const expand = document.querySelector(`.ds-rec-lkp-expand[data-lkp-expand-c="${CSS.escape(link.dataset.reccLkp + '|' + srcId)}"]`);
      if (!expand) return;
      const wasOpen = expand.style.display !== 'none';
      expand.style.display = wasOpen ? 'none' : 'block';
      if (!wasOpen && expand.dataset.loaded !== '1') {
        expand.dataset.loaded = '1';
        renderLkpOverridePanel(v.prof, v.obj, srcId, expand, link.dataset.recLkpTgt || null);
      }
    });
  });

  // W2-UI — 🔗 lookup override panel toggles (missing + changed rows).
  // preventDefault matters on the missing rows: the link sits inside the
  // row's <label>, and a plain click would also toggle its push checkbox.
  document.querySelectorAll('[data-rec-lkp]:not([data-recc-lkp])').forEach(link => {
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
  const _recEnginePersist = () => sftkRecEnginePersist(p);
  eid('dsRecApiMode')?.addEventListener('change', async e => {
    const v = e.target.value;
    if (v === 'sync' || v === 'bulk') p.apiMode = v; else delete p.apiMode;
    // Batch size is a SYNCHRONOUS-engine knob — Bulk jobs ignore it, so the
    // input goes inert the moment Async is picked (user 2026-08-18: "user
    // has no idea what he is selecting").
    const bi = eid('dsRecBatchSize'), bw = eid('dsRecBatchWrap');
    if (bi) bi.disabled = v === 'bulk';
    if (bw) bw.style.opacity = v === 'bulk' ? '.45' : '';
    const ti = eid('dsRecThreads'), tw = eid('dsRecThreadsWrap');
    if (ti) ti.disabled = v === 'bulk';
    if (tw) tw.style.opacity = v === 'bulk' ? '.45' : '';
    await _recEnginePersist();
  });
  eid('dsRecThreads')?.addEventListener('change', async e => {
    const n = Math.max(1, Math.min(6, parseInt(e.target.value, 10) || 1));
    e.target.value = n;
    if (n === 1) delete p.threads; else p.threads = n;
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
  sftkRecWireDupFix(document, p, scan);
  eid('dsMatchReviewBtn')?.addEventListener('click', () => openMatchReview(p));
  eid('dsInSyncTableBtn')?.addEventListener('click', () => sftkShowInSyncRecords(p, scan));
  eid('dsStampPairsBtn')?.addEventListener('click', () => reconcileStampPairs(p, scan));
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
// What a run is about to write, per org, in the words the typed confirmation
// shows. Pure. An empty string means "this run writes nothing into that org".
// 2026-09-21: the typed gate covered deletes only, so a plain insert or
// overwrite into a production target ran on a single click.
function sftkRecGuardedWrites(c, objType) {
  const n = v => Number(v) || 0;
  const join = a => { const l = a.filter(Boolean); return l.length ? l.join(' + ') + ' record(s)' : ''; };
  return {
    tgt: join([
      n(c.ins)      ? `insert ${n(c.ins)} ${objType}` : null,
      n(c.ovw)      ? `overwrite ${n(c.ovw)} ${objType}` : null,
      n(c.childIns) ? `insert ${n(c.childIns)} child` : null,
      n(c.childOvw) ? `overwrite ${n(c.childOvw)} child` : null,
      n(c.relink)   ? `re-link ${n(c.relink)} child` : null,
      n(c.del)      ? `delete ${n(c.del)} ${objType}` : null,
      n(c.childDel) ? `delete ${n(c.childDel)} child` : null
    ]),
    src: join([
      n(c.pull)   ? `insert ${n(c.pull)} ${objType}` : null,
      n(c.updSrc) ? `update ${n(c.updSrc)} ${objType}` : null
    ])
  };
}

// PURE. Is a run log line a real error (work not done), or a note? One
// reading, shared with History's card: the friendly classifier decides; the
// ℹ marker stays honoured on its own in case the classifier is not loaded.
function sftkRunLineIsError(line) {
  const s = String(line == null ? '' : line);
  if (/(^|: )ℹ /.test(s)) return false;
  if (typeof sftkFriendlyError === 'function') { try { return sftkFriendlyError(s).kind === 'error'; } catch (_) {} }
  return true;
}

// PURE. Per-record lookup overrides that attach group-B children (parent
// already in the target) to their parent by the parent's SCANNED identity —
// the srcId→tgtId pair the parent scan established — instead of re-matching
// the parent's key by one exact value (live run 2026-09-22: OrderItem lost
// its Order because Order's key is a composite). A hand-pick already on the
// row wins. Returns { overrides, exact, missing }.
function sftkRecParentOverrides(groupB, rows, pairs, field, existing, orgKey) {
  const ov = JSON.parse(JSON.stringify(existing || {}));
  const keys = Object.keys(ov);
  const sameOrg = k => (typeof sftkOrgKey === 'function' ? sftkOrgKey(k) : String(k)) === (typeof sftkOrgKey === 'function' ? sftkOrgKey(orgKey) : String(orgKey));
  const bucket = keys.find(sameOrg) || orgKey;
  let exact = 0, missing = 0;
  for (const id of (groupB || [])) {
    const row = (rows || []).find(r => r && r.sourceId === id);
    const tgt = row && row.parentSrcId ? (pairs instanceof Map ? pairs.get(row.parentSrcId) : (pairs || {})[row.parentSrcId]) : null;
    if (!tgt) { if (row && row.parentSrcId) missing++; continue; }
    ov[bucket] = ov[bucket] || {};
    const cur = ov[bucket][id] || {};
    if (cur[field]) continue;                    // the user's hand-pick stands
    ov[bucket][id] = { ...cur, [field]: tgt }; exact++;
  }
  return { overrides: ov, exact, missing };
}

// The one write discipline (sftk-write.js) — the shared `verify` for every
// delete in this file: re-read exactly the Ids the write claimed to delete,
// chunked the same way every other Id-list query here is (SOQL IN-list
// limits), and report which ones the org still shows. Never throws on a
// normal "some still there" answer — only on a read failure, so the helper's
// own "could not be re-read to confirm it" wording carries it.
async function sftkReconcileVerifyGone(sess, obj, okIds) {
  if (!okIds.length) return { ok: true, detail: [] };
  const stillThere = [];
  for (let i = 0; i < okIds.length; i += 200) {
    const lit = okIds.slice(i, i + 200).map(id => soqlStrLit(id)).join(',');
    const q = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false, _suppressError: true,
      query: `SELECT Id FROM ${obj} WHERE Id IN (${lit})` });
    if (q?.error) throw new Error(q.error);
    stillThere.push(...(q.records || []).map(r => r.Id));
  }
  return stillThere.length
    ? { ok: false, detail: stillThere, text: `${obj} delete: accepted by Salesforce, but ${stillThere.length} record(s) still show in the org` }
    : { ok: true, detail: [] };
}

async function runReconcile(profile, objType, buckets, opts) {
  // ⏸ Record-triggered flows paused for this run (user 2026-09-29, Deploy page
  // option — sftk-flowpause.js): opts.flowPause = { flows, managed } is listed
  // in the confirmation; opts.beforeWrites(tgtSess, log) switches them off
  // after it and before the first write, and returns false to stop the run.
  // opts.afterWrites(log) switches them back on right after the last write; the
  // caller also does it when this returns, if that did not happen (studio-deploy.js).
  const _fp = opts && opts.flowPause && (opts.flowPause.flows || []).length ? opts.flowPause : null;
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

  // 🔒 Write locks: refuse here, by org and direction, instead of letting the
  // engine chokepoint fail every write half-way through a run.
  {
    const locked = u => (typeof window.sftkOrgLocked === 'function') && window.sftkOrgLocked(u);
    const childWrites = Object.values(_recChildSel).some(s => s && (s.push.size || s.relink.size || s.overwrite.size || s.del.size));
    if (locked(profile.targetOrg) && (pushIds.length || ovwIds.length || delIds.length || childWrites)) {
      showToast(`🔒 Writes to ${orgLabel(profile.targetOrg)} are locked — nothing was written. Unlock it in Connected Orgs, or clear the selections that write into it.`, 'error', 9000);
      return;
    }
    if (locked(profile.sourceOrg) && (updSrcIds.length || pullIds.length)) {
      showToast(`🔒 Writes to ${orgLabel(profile.sourceOrg)} are locked — ← selections write into it, so nothing was written. Unlock it in Connected Orgs, or clear the ← selections.`, 'error', 9000);
      return;
    }
  }

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
  // Campaign 3 phase 4 — the whole tree in one pass (sftkRecOnePassPlan):
  // ticked records pull their missing ancestors into the run, at any depth,
  // and each record rides the call of its topmost ancestor being inserted.
  const _opNodes = {};
  for (const [k, cs] of Object.entries(rootScan.children || {})) {
    if (!cs || !getNodeByPath(profile.tree, k)) continue;
    const pk = String(k).split('.').slice(0, -1).join('.');
    const ps = pk ? rootScan.children?.[pk] : rootScan;
    if (!ps) continue;
    _opNodes[k] = {
      missing: new Map((cs.missingInTarget || []).map(r => [r.sourceId, r.parentSrcId || null])),
      parentMissing: new Set((ps.missingInTarget || []).map(r => r.sourceId)),
      parentExists: new Set([...(ps.changed || []), ...(ps.identical || [])].map(r => r.sourceId)),
    };
  }
  const onePass = sftkRecOnePassPlan({ rootSel: pushIds, rootMissing: rootMissingSrc, nodes: _opNodes,
    sel: Object.fromEntries(Object.entries(_recChildSel).map(([k, v]) => [k, (v && v.push) || new Set()])) });
  // A level nobody ticked can still receive ancestors pulled in by a deeper pick.
  for (const k of Object.keys(onePass.ins)) {
    if (!k || !onePass.ins[k].size || childActs.some(a => a.pathKey === k)) continue;
    const node = getNodeByPath(profile.tree, k), cs = rootScan.children?.[k];
    if (node && cs) childActs.push({ pathKey: k, node, cs, sel: { push: new Set(), relink: new Set(), overwrite: new Set(), del: new Set() } });
  }
  for (const a of childActs) {
    a.groupA = []; a.groupB = []; a.groupC = []; a.autoParents = new Set(); a.skippedDeep = 0;
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
    // Phase 4: the partition comes from the one-pass plan. groupA rides the
    // root tree call; groupB is rooted here (its parent already exists in the
    // target); groupC rides a call rooted at an ancestor level that is itself
    // being inserted under an existing parent. skippedDeep = records whose
    // parent can be neither found in the target nor inserted by this run.
    void pMissingSet; void pExistsSet;   // parent context above still feeds parentObj / parentScan
    for (const [id, at] of (onePass.anchor[a.pathKey] || new Map())) {
      if (at === '') a.groupA.push(id);
      else if (at === a.pathKey) a.groupB.push(id);
      else a.groupC.push(id);
    }
    a.autoAdded   = onePass.auto[a.pathKey] || 0;
    a.skippedDeep = onePass.dropped[a.pathKey] || 0;
    // R4 — drift overwrites + target-only deletes, validated against the
    // child scan's buckets so stray ids can never reach the writers.
    a.ovwIds = [...(a.sel.overwrite || [])].filter(id => (a.cs.changed || []).some(r => r.sourceId === id));
    a.delIds = [...(a.sel.del || [])].filter(id => (a.cs.onlyInTarget || []).some(r => r.targetId === id));
  }
  const childDelTotal = childActs.reduce((s, a) => s + a.delIds.length, 0);
  const anyChildAct = childActs.some(a => a.groupA.length || a.groupB.length || a.groupC.length || a.sel.relink.size || a.ovwIds.length || a.delIds.length);

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
        (a.groupA.length || a.groupB.length || a.groupC.length) ? 'push' : null,
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
  // Only a CONFIRMED sandbox / dev org escapes the production guards. An org
  // whose type could not be read is treated like production — ambiguity fails
  // closed, exactly as 🪪 Stamp identity and the rollback already do (parity
  // inventory 2026-09-18: these two guards checked `=== 'production'` only, so
  // an unreadable org type allowed hard deletes with no typed confirmation).
  const tgtGuarded = tgtOrgType !== 'sandbox' && tgtOrgType !== 'dev';
  if (tgtGuarded && isHard && (delIds.length || childDelTotal)) {
    showToast(tgtOrgType === 'production'
      ? '🔥 Hard delete is disabled against PRODUCTION orgs — switch Delete mode to Recycle Bin.'
      : `🔥 Hard delete is disabled: ${orgLabel(profile.targetOrg)} could not be confirmed as a sandbox or dev org, so it is treated like production. Switch Delete mode to Recycle Bin, or open the org in a tab and 🔄 Refresh state.`, 'error', 9000);
    return;
  }

  // Numbered execution plan — mirrors the exact order the phases run in, so
  // what the user reads in the confirm modal is literally what happens.
  const planLines = [];
  if (anyChildAct) {
    let n = 1;
    const totalAutoParents = onePass.auto[''] || 0;
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
      // Phase 4: a level that received ancestors for deeper picks says so once.
      let _sfxUsed = false;
      const sfx = () => (!_sfxUsed && a.autoAdded) ? (_sfxUsed = true, ` (+${a.autoAdded} added so the records below them have a parent)`) : '';
      if (a.groupA.length && cf)  planLines.push(`${n++}. Reconnect ${a.groupA.length} ${obj} → ${objType} (link patched after the parents exist)${sfx()}`);
      if (a.groupA.length && !cf) planLines.push(`${n++}. Insert ${a.groupA.length} ${obj} under the new ${a.depth > 1 ? pObj : objType} (linked at insert)${sfx()}`);
      if (a.groupB.length)        planLines.push(`${n++}. Insert ${a.groupB.length} ${obj} under existing ${pObj} (matched by ${((a.parentScan || rootScan).matching?.fields || [(a.parentScan || rootScan).matchField || 'Name']).join(' + ')})${sfx()}`);
      if (a.groupC.length)        planLines.push(`${n++}. Insert ${a.groupC.length} ${obj} under the new ${pObj} (linked at insert, same run)${sfx()}`);
      if (a.sel.relink.size)      planLines.push(`${n++}. Relink ${a.sel.relink.size} ${obj} to the right ${pObj}`);
      if (a.ovwIds.length)        planLines.push(`${n++}. Update ${a.ovwIds.length} drifted ${obj} in target`);
    }
    if (ovwIds.length)    planLines.push(`${n++}. Update ${ovwIds.length} drifted ${objType} in target`);
    if (updSrcIds.length) planLines.push(`${n++}. Update ${updSrcIds.length} ${objType} in source`);
  }

  // ANY write into a production org requires typing the org name — inserts,
  // overwrites and re-links as well as deletes, children included. One typed
  // confirmation per org, naming everything the run will do there. The source
  // org gets the same gate when the run writes back into it (← pull / update).
  // Same fail-closed rule as above: only a confirmed sandbox / dev org is exempt.
  const guardedWrites = sftkRecGuardedWrites({
    ins: onePass.ins[''].size,
    ovw: ovwIds.length, del: delIds.length, childDel: childDelTotal,
    childIns: childActs.reduce((t, a) => t + a.groupA.length + a.groupB.length + a.groupC.length, 0),
    childOvw: childActs.reduce((t, a) => t + a.ovwIds.length, 0),
    relink:   childActs.reduce((t, a) => t + a.sel.relink.size, 0),
    pull: pullIds.length, updSrc: updSrcIds.length
  }, objType);

  // L6 — a plain "Insert only" run used to write with NO confirmation at all.
  // That is still true when the scan was complete; when it wasn't, the guard
  // above has something to say, so the dialog opens to say it.
  // The one confirmation (sftk-confirm.js, campaign 3 phase 2): the plan's own
  // form (capped-scan warning, numbered execution plan, per-action blocks)
  // rides along as extraHtml, and the target's production typed-name step
  // rides in the SAME dialog — replacing the old #dsRecDelOk showModal() and
  // the confirmTypedProd(profile.targetOrg, …) call that used to follow it.
  if (delIds.length || pullIds.length || updSrcIds.length || anyChildAct || capWarnLines.length || _fp) {
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
    const _fpOnly = !!_fp && !delIds.length && !childDelTotal && !pullIds.length && !updSrcIds.length && !anyChildAct && !capWarnLines.length;
    const title = _fpOnly ? '⏸ Confirm the run — record-triggered flows paused'
      : (delIds.length || childDelTotal)
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
    const _fpList = fl => fl.map(x => `${esc(x.label)} <span class="ds-subtext">(${esc(x.object)} · v${esc(String(x.version))})</span>`).join(', ');
    const flowBlock = _fp
      ? `<div style="margin-top:10px;padding:10px 12px;background:#fffbeb;border-left:3px solid #d97706;border-radius:4px;font-size:12px">
           ⏸ <strong>Before the first write:</strong> switch OFF ${_fp.flows.length} record-triggered flow(s) in
           <strong>${esc(orgLabel(profile.targetOrg))}</strong> — ${_fpList(_fp.flows)}.<br>
           ▶ <strong>When the run ends</strong> (finished, failed or stopped): switch each back ON at the version that was active.
           Records written while they are off are <strong>never</strong> processed by these flows.
           ${(_fp.managed || []).length ? `<br>Flows from installed packages cannot be switched and stay ON: ${esc(_fp.managed.join(', '))}.` : ''}</div>`
      : '';
    const bodyHtml = `
      Review the changes before continuing:
      ${flowBlock}
      ${capWarnBlock}
      ${planBlock}
      ${pullBlock}
      ${updSrcBlock}
      ${childDelBlock}
      ${delBlock}`;
    const isDeleting = !!(delIds.length || childDelTotal);
    // Fail-closed exactly as before: tgtGuarded (computed above from
    // ensureOrgType, above) — not sftkOrgWriteGate's stored-org lookup —
    // decides whether the typed-name step fires; an org whose type could not
    // be confirmed is guarded like production. sftkOrgWriteGate supplies only
    // the display label.
    const tgtGate = tgtGuarded ? await sftkOrgWriteGate(profile.targetOrg, _orgs) : null;
    const ok = await sftkConfirmDestructive({
      title,
      icon: isDeleting ? (isHard ? '🔥' : '⚠') : '⚖',
      revOverride: isDeleting
        ? (isHard
          ? { html: '🔥 <strong>Permanent</strong> — hard-deleted records are purged from the Recycle Bin and cannot be recovered.', needsCheckbox: true }
          : { html: '♻ <strong>Recoverable</strong> — deleted records go to the Recycle Bin and can be restored for 15 days.', needsCheckbox: false })
        : { html: '↩ A restore point is captured before anything writes — this run can be rolled back afterward from History.', needsCheckbox: false },
      confirmLabel: 'Proceed',
      extraHtml: bodyHtml,
      production: (guardedWrites.tgt && tgtGuarded) ? { label: tgtGate?.label || orgLabel(profile.targetOrg) } : null,
    });
    if (!ok) return;
  } else if (guardedWrites.tgt && tgtGuarded) {
    // No Proceed dialog was needed (plain insert-only, complete scan) but the
    // target is still production (or unconfirmed) — the typed-name step
    // alone, in the shared shape.
    const tgtGate = await sftkOrgWriteGate(profile.targetOrg, _orgs);
    const okProd = await sftkConfirmDestructive({
      title: '🛑 Confirm writes into a production org',
      icon: '🛑',
      items: [{ label: guardedWrites.tgt }],
      revOverride: { html: '↩ A restore point is captured before anything writes — this run can be rolled back afterward from History.', needsCheckbox: false },
      confirmLabel: 'Proceed',
      production: { label: tgtGate.label || orgLabel(profile.targetOrg) },
    });
    if (!okProd) return;
  }

  if (guardedWrites.src) {
    const srcOrgType = await ensureOrgType(profile.sourceOrg);
    if (srcOrgType !== 'sandbox' && srcOrgType !== 'dev') {
      // Same fail-closed rule: entry into this block already means
      // "unconfirmed sandbox/dev" — sftkOrgWriteGate only supplies the label.
      const srcGate = await sftkOrgWriteGate(profile.sourceOrg, _orgs);
      const okSrc = await sftkConfirmDestructive({
        title: '← Confirm writes into source',
        icon: '←',
        items: [{ label: guardedWrites.src }],
        revOverride: { html: '⚠ This run also writes into the SOURCE org.', needsCheckbox: false },
        confirmLabel: 'Proceed',
        production: { label: srcGate.label || orgLabel(profile.sourceOrg) },
      });
      if (!okSrc) return;
    }
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
  // ⏸ after the confirmation, before the first write (see opts above)
  if (_fp && opts && typeof opts.beforeWrites === 'function') {
    let go = false;
    try { go = await opts.beforeWrites(tgtSess, log); } catch (e) { log('❌', `Pausing the flows failed — the run did not start: ${e?.message || e}`, 'ds-prog-err'); go = false; }
    if (!go) { if (runBtn) runBtn.disabled = false; return; }
  }

  // Stream the engine's per-batch progress into the reconcile log (also
  // keeps the worker alive across the multi-phase pipeline).
  const recPort = _openRunPort(_runProgressHandler(prog));

  // ↩ RESTORE POINT (studio-undo.js) — the target's before-image of every
  // object this run can write, plus the SOURCE's root object when the run
  // writes there (pull / ← update). Read before phase 0; never blocks the run.
  const runId = genId('run');
  const undoLegs = [{ orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, objects: sftkUndoTreeObjects(profile.tree, 'reconcile') }];
  if (pullIds.length || updSrcIds.length) undoLegs.push({ orgUrl: srcSess.orgUrl, sid: srcSess.sid, objects: [{ objType, depth: 0, mode: 'reconcile' }] });
  const undoStub = await sftkUndoCaptureForRun({ evidenceId: runId, scope: 'run', profileName: profile.name, legs: undoLegs }, log);

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

  // Phase 4 — a selected record whose parent can be neither found in the
  // target nor inserted by this run (the parent's own parent is untracked by
  // the scan) is skipped, never inserted without its parent. Say so.
  for (const a of childActs) {
    if (!a.skippedDeep) continue;
    const m = `⚠ ${a.node.objectType || a.node.childSObject}: ${a.skippedDeep} selected row(s) skipped — their parent is missing in the target and cannot be inserted in this run (its own parent is not in the target or in the scan); rescan the level above, then re-run`;
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
        // The one write discipline (sftk-write.js): the delete response's own
        // per-record success used to BE "deleted" — one re-read of exactly
        // these Ids (chunked, same as every other Id-list query here) closes
        // the same gap a PATCH accepted-but-unchanged taught elsewhere.
        // confirmed-by: runReconcile's Proceed/production sftkConfirmDestructive above.
        // history-by: the deployment's own History entry (rollback in studio-undo.js)
        const dw = await sftkWriteVerified({
          describe: `${obj} hard delete`,
          write: () => sendBg({ type: 'SF_HARD_DELETE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, ids: a.delIds }),
          verify: (r) => sftkReconcileVerifyGone(tgtSess, obj, (r.deleteResults || []).filter(x => x.success).map(x => x.id)),
        });
        if (!dw.accepted) { allErrors.push(`Delete ${obj} failed: ${dw.raw?.error || dw.text}`); log('❌', `Delete ${obj} failed: ${dw.raw?.error || dw.text}`, 'ds-prog-err'); continue; }
        const res = dw.raw || {};
        const okN   = (res.deleteResults || []).filter(r => r.success).length;
        const failN = (res.deleteResults || []).length - okN;
        bumpChild(obj, 'deleted', okN); bumpChild(obj, 'deleteFailed', failN);
        counts.purged += (res.purgedOk || 0);
        log(failN ? '⚠' : (dw.ok ? '✅' : '⚠'), `${obj}: deleted ${okN}${failN ? `, ${failN} failed` : ''} → purged ${res.purgedOk || 0} from Recycle Bin`, (failN || !dw.ok) ? 'ds-prog-err' : '');
        if (!dw.ok) { allErrors.push(dw.text); log('  ⚠', dw.text, 'ds-prog-warn'); }
        (res.purgeErrors || []).slice(0, 3).forEach(e => { allErrors.push(`purge ${obj}: ${e}`); log('  ⚠', `purge: ${e}`, 'ds-prog-warn'); });
        (res.deleteResults || []).filter(r => !r.success).slice(0, 5).forEach(r => {
          const m = (r.errors || []).map(x => x.message).join('; ');
          if (m) allErrors.push(`delete ${obj} ${r.id || ''}: ${m}`);
        });
      } else {
        log('🗑', `Deleting ${a.delIds.length} ${obj} from target (→ Recycle Bin)…`);
        // confirmed-by: runReconcile's Proceed/production sftkConfirmDestructive above.
        // history-by: the deployment's own History entry (rollback in studio-undo.js)
        const dw = await sftkWriteVerified({
          describe: `${obj} delete`,
          write: () => sendBg({ type: 'SF_COLLECTIONS_DELETE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, ids: a.delIds }),
          verify: (r) => sftkReconcileVerifyGone(tgtSess, obj, (Array.isArray(r) ? r : []).filter(x => x.success).map(x => x.id)),
        });
        if (!dw.accepted) { allErrors.push(`Delete ${obj} failed: ${dw.raw?.error || dw.text}`); log('❌', `Delete ${obj} failed: ${dw.raw?.error || dw.text}`, 'ds-prog-err'); continue; }
        const res = dw.raw || [];
        const okN   = (res || []).filter(r => r.success).length;
        const failN = (res || []).length - okN;
        bumpChild(obj, 'deleted', okN); bumpChild(obj, 'deleteFailed', failN);
        log(failN ? '⚠' : (dw.ok ? '✅' : '⚠'), `${obj}: deleted ${okN}${failN ? `, ${failN} failed` : ''}`, (failN || !dw.ok) ? 'ds-prog-err' : '');
        if (!dw.ok) { allErrors.push(dw.text); log('  ⚠', dw.text, 'ds-prog-warn'); }
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
        // The one write discipline (sftk-write.js): the delete response's own
        // per-record success used to BE "deleted" — one re-read of exactly
        // these Ids (chunked, same as every other Id-list query here) closes
        // the same gap a PATCH accepted-but-unchanged taught elsewhere.
        // confirmed-by: runReconcile's Proceed/production sftkConfirmDestructive above.
        // history-by: the deployment's own History entry (rollback in studio-undo.js)
        const dw = await sftkWriteVerified({
          describe: `${objType} hard delete`,
          write: () => sendBg({ type: 'SF_HARD_DELETE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, ids: delIds }),
          verify: (r) => sftkReconcileVerifyGone(tgtSess, objType, (r.deleteResults || []).filter(x => x.success).map(x => x.id)),
        });
        if (!dw.accepted) throw new Error(dw.raw?.error || dw.text);
        const res = dw.raw || {};
        const delOk   = (res.deleteResults || []).filter(r => r.success).length;
        const delFail = (res.deleteResults || []).length - delOk;
        counts.deleted += delOk; counts.deletedFailed += delFail; counts.purged += (res.purgedOk || 0);
        log(delFail ? '⚠' : (dw.ok ? '✅' : '⚠'), `Deleted ${delOk}${delFail ? `, ${delFail} failed` : ''} → purged ${res.purgedOk || 0} from Recycle Bin`, (delFail || !dw.ok) ? 'ds-prog-err' : '');
        if (!dw.ok) { allErrors.push(dw.text); log('  ⚠', dw.text, 'ds-prog-warn'); }
        (res.purgeErrors || []).slice(0, 3).forEach(e => { allErrors.push(`purge: ${e}`); log('  ⚠', `purge: ${e}`, 'ds-prog-warn'); });
        (res.deleteResults || []).filter(r => !r.success).slice(0, 5).forEach(r => {
          const m = (r.errors || []).map(x => x.message).join('; ');
          if (m) allErrors.push(`delete ${r.id || ''}: ${m}`);
        });
      } catch (e) { allErrors.push(`Hard delete failed: ${e?.message || e}`); log('❌', `Hard delete failed: ${e?.message || e}`, 'ds-prog-err'); }
    } else {
      log('🗑', `Deleting ${delIds.length} record(s) from target (→ Recycle Bin)…`);
      try {
        // confirmed-by: runReconcile's Proceed/production sftkConfirmDestructive above.
        // history-by: the deployment's own History entry (rollback in studio-undo.js)
        const dw = await sftkWriteVerified({
          describe: `${objType} delete`,
          write: () => sendBg({ type: 'SF_COLLECTIONS_DELETE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, ids: delIds }),
          verify: (r) => sftkReconcileVerifyGone(tgtSess, objType, (Array.isArray(r) ? r : []).filter(x => x.success).map(x => x.id)),
        });
        if (!dw.accepted) throw new Error(dw.raw?.error || dw.text);
        const res = dw.raw || [];
        const ok = (res || []).filter(r => r.success).length;
        const fail = (res || []).length - ok;
        counts.deleted += ok; counts.deletedFailed += fail;
        log(fail ? '⚠' : (dw.ok ? '✅' : '⚠'), `Deleted ${ok}${fail ? `, ${fail} failed` : ''}`, (fail || !dw.ok) ? 'ds-prog-err' : '');
        if (!dw.ok) { allErrors.push(dw.text); log('  ⚠', dw.text, 'ds-prog-warn'); }
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
        // verified-by: the engine's post-run re-read — summary[obj].verified = { checked, found } (background.js, campaign 3 phase 1)
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
  // Phase 4 — per-node choices for every call's pruned tree: child-first only
  // for a direct child (as before), never across a master-detail link.
  const _opDecorate = (cc, p) => {
    const d = String(p).split('.').length;
    const ord = _recOrderOverride[p] ?? cc.insertOrder;
    if (ord === 'childFirst' && d === 1) {
      if (rootScan.children?.[p]?.linkMasterDetail) {
        allErrors.push(`⚠ ${cc.objectType || cc.childSObject}: child-first ignored — ${cc.field || 'the link'} is a master-detail relationship (parent required at insert); running parent-first instead`);
        delete cc.insertOrder;
      } else cc.insertOrder = 'childFirst';
    } else delete cc.insertOrder;
  };
  const treePushIds = [...onePass.ins['']];
  const groupATotal = childActs.reduce((s, a) => s + a.groupA.length, 0);
  if (treePushIds.length || groupATotal) {
    const autoN = treePushIds.length - pushIds.length;
    log('⬆', `Pushing ${treePushIds.length} ${objType}${autoN > 0 ? ` (${autoN} parent(s) auto-included)` : ''}${groupATotal ? ` + ${groupATotal} child record(s)` : ''} to target…`);
    try {
      const pushProfile = JSON.parse(JSON.stringify(profile));
      delete pushProfile.lastScan;
      pushProfile.tree.recordIds = treePushIds;
      // Phase 4: every level that rides this call, at any depth — the engine
      // writes root → children → grandchildren and links each to the id its
      // parent got earlier in the same run. R2 (master-detail ⇒ parent-first)
      // lives in _opDecorate.
      pushProfile.tree.children  = sftkRecPruneTree(profile.tree.children, '', onePass.root.rides, _opDecorate);
      const res = await sendBg({
        // verified-by: the engine's post-run re-read — summary[obj].verified = { checked, found } (background.js, campaign 3 phase 1)
        type: 'SF_EXECUTE_PROFILE_TRANSFER',
        profile: pushProfile, runId,
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
      const _seenRootObj = new Set();
      for (const a of childActs) {
        if (!a.groupA.length) continue;
        const obj  = a.node.objectType || a.node.childSObject;
        if (obj === objType) continue;   // self-relationship: counts already in root line
        if (_seenRootObj.has(obj)) continue;   // the engine's summary is per object
        _seenRootObj.add(obj);
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
    // Attach by the parent's scanned identity (exact); the key bridge below is
    // only the fallback for a row whose parent pair the scan did not record.
    const _pScan = a.parentScan || rootScan;
    const _pairs = new Map([...(_pScan.changed || []), ...(_pScan.identical || [])].filter(r => r && r.sourceId && r.targetId).map(r => [r.sourceId, r.targetId]));
    const _att = sftkRecParentOverrides(a.groupB, a.cs.missingInTarget || [], _pairs, a.node.field, a.node.lookupOverrides || {}, profile.targetOrg);
    if (_att.exact) log('🔗', `${obj}: ${_att.exact} of ${a.groupB.length} attached to their existing ${pObj} by the scan's own pairing${_att.missing ? ` — ${_att.missing} fall back to matching by ${pMatch}` : ''}`);
    if (_att.missing && pScanM && ((pScanM.fields || []).length > 1 || Object.values(pScanM.normalize || {}).some(Boolean))) {
      const mW = `⚠ ${obj}: parent matching uses ${(pScanM.fields || []).length > 1 ? 'a composite key' : 'normalization'} — the insert bridge attaches by ${pMatch} with exact values (engine limit), so parents that differ only ${(pScanM.fields || []).length > 1 ? 'in later key components' : 'by case/spacing'} may not attach`;
      allErrors.push(mW); log('⚠', mW, 'ds-prog-warn');
    }
    const _bRides = onePass.b[a.pathKey]?.rides || {};
    const _bRideN = Object.values(_bRides).reduce((t, ids) => t + ids.length, 0);
    log('⬆', `Inserting ${a.groupB.length} ${obj} under existing ${pObj} (matched by ${pMatch})${_bRideN ? ` + ${_bRideN} record(s) under them` : ''}…`);
    try {
      const bProfile = JSON.parse(JSON.stringify(profile));
      delete bProfile.lastScan;
      bProfile.tree = {
        objectType: obj,
        where: '',
        recordIds: a.groupB,
        children: sftkRecPruneTree(a.node.children, a.pathKey, _bRides, _opDecorate),   // phase 4: the levels below ride along
        fieldMappings: a.node.fieldMappings || {},
        lookupOverrides: _att.overrides,                 // 🔗 hand-picks + the scan's own parent pairing
        lookupResolutions: {
          ...(a.node.lookupResolutions || {}),
          [a.node.field]: { strategy: 'match', matchObject: pObj, matchField: pMatch }
        }
      };
      const res = await sendBg({
        // verified-by: the engine's post-run re-read — summary[obj].verified = { checked, found } (background.js, campaign 3 phase 1)
        type: 'SF_EXECUTE_PROFILE_TRANSFER',
        profile: bProfile, runId,
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
      // Phase 4: the levels that rode this call.
      const _seenBObj = new Set([obj]);
      for (const rp of Object.keys(_bRides)) {
        const rn = getNodeByPath(profile.tree, rp);
        const rObj = rn?.objectType || rn?.childSObject;
        if (!rObj || _seenBObj.has(rObj)) continue;
        _seenBObj.add(rObj);
        const rs = res.summary?.[rObj] || {};
        bumpChild(rObj, 'created', rs.created || 0);
        bumpChild(rObj, 'failed',  rs.failed  || 0);
        if (rs.targetRecords?.length) childCounts[rObj].targetRecords = (childCounts[rObj].targetRecords || []).concat(rs.targetRecords);
        if (rs.failedSourceIds?.length) childCounts[rObj].failedSourceIds = (childCounts[rObj].failedSourceIds || []).concat(rs.failedSourceIds);
        log('  ' + (rs.failed ? '⚠' : '✅'), `${rObj}: ${rs.created || 0} created under the new ${obj}${rs.failed ? `, ${rs.failed} failed` : ''}`, rs.failed ? 'ds-prog-err' : '');
      }
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
        const slice = updates.slice(ci, ci + 200);
        try {
          // The one write discipline (sftk-write.js): Collections' per-record
          // success used to BE "relinked" — one re-read of exactly this
          // slice's Ids, comparing the link field to the parent it was meant
          // to point at, closes the same gap a PATCH accepted-but-unchanged
          // taught elsewhere.
          // confirmed-by: runReconcile's Proceed/production sftkConfirmDestructive above.
          // history-by: the deployment's own History entry (rollback in studio-undo.js)
          const dw = await sftkWriteVerified({
            describe: `relink ${obj}`,
            write: () => sendBg({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, records: slice }),
            verify: async (res) => {
              const okIds = (Array.isArray(res) ? res : []).filter(rr => rr.success).map(rr => rr.id);
              if (!okIds.length) return { ok: true, detail: [] };
              const wantById = new Map(slice.map(u => [u.Id, u[tgtLinkField]]));
              const vq = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, tooling: false, _suppressError: true,
                query: `SELECT Id, ${tgtLinkField} FROM ${obj} WHERE Id IN (${okIds.map(id => soqlStrLit(id)).join(',')})` });
              if (vq?.error) return { ok: false, text: `relink ${obj}: accepted by Salesforce, but the org could not be re-read to confirm it (${vq.error})` };
              const stale = (vq.records || []).filter(r => String(r[tgtLinkField] || '') !== String(wantById.get(r.Id) || ''));
              return stale.length
                ? { ok: false, detail: stale.map(r => r.Id), text: `relink ${obj}: accepted by Salesforce, but ${stale.length} record(s) still point at the old parent` }
                : { ok: true, detail: [] };
            },
          });
          if (!dw.accepted) { fail += slice.length; allErrors.push(`relink ${obj}: ${dw.raw?.error || dw.text}`); continue; }
          const res = dw.raw || [];
          const staleSet = new Set(Array.isArray(dw.detail) ? dw.detail : []);
          (Array.isArray(res) ? res : []).forEach(rr => {
            if (rr.success && !staleSet.has(rr.id)) ok++;
            else if (rr.success) { fail++; allErrors.push(`relink ${obj}: accepted by Salesforce, but the org still shows the old parent for ${rr.id}`); }
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
        lookupResolutions: a.node.lookupResolutions || {},
        lookupOverrides: a.node.lookupOverrides || {}     // 🔗 hand-picks made on child rows
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

  // 🔗 Lookups still waiting at the end of the run: every step that wrote into
  // the target shared one ledger, so what is left points at records nothing
  // in this run created. Said once, with the fix. (The ← pull step writes into
  // the SOURCE and never shares the ledger.)
  try {
    const closed = await sendBg({ type: 'SF_RUN_LEDGER_CLOSE', runId });
    for (const u of ((closed && closed.unresolved) || [])) {
      const line = `⚠ ${u.objType}: ${u.n} lookup value(s) left empty (${u.field}) — the ${u.refObj} record they point at is neither in the target nor created by this run. Deploy it first, or widen this deployment to include it.`;
      allErrors.push(line); log('⚠', line, 'ds-prog-warn');
    }
  } catch (_) { /* advisory */ }

  // ▶ The writes are over: paused flows go back on NOW — not after the History
  // save and the post-run refresh (live 2026-09-29: they stayed off seconds
  // longer than the writes). The caller's finally is the safety net.
  if (_fp && opts && typeof opts.afterWrites === 'function') {
    try { await opts.afterWrites(log); } catch (e) { log('⚠', `Switching the paused flows back on failed here — tried again when the run ends: ${e?.message || e}`, 'ds-prog-warn'); }
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
  // 2026-09-22 (user's card: 2 updated, 0 failed, "partial"): ⚠ / 🔗 lines are
  // NOTES — a skipped field, a lookup resolved by name — and History already
  // reads them so through sftkFriendlyError. Status must use the same reading,
  // or a run that wrote every record wears "partial" over a note.
  const hardErrs = allErrors.filter(e => sftkRunLineIsError(e)).length;
  const status   = (totalFail === 0 && hardErrs === 0) ? 'success' : (totalOk > 0 ? 'partial' : 'failed');
  // ↩ end-of-run boundary from Salesforce's own clock (studio-undo.js) —
  // PER ORG: the target's last write says nothing about when the SOURCE was
  // written (pull / ← update is the run's last phase, into the other org).
  const runEnd = await sftkUndoRunEnd(tgtSess.orgUrl, tgtSess.sid, undoStub.objects);
  const runEndByOrg = { [tgtSess.orgUrl]: runEnd };
  if (undoLegs.length > 1) runEndByOrg[srcSess.orgUrl] = await sftkUndoRunEnd(srcSess.orgUrl, srcSess.sid, [objType]);
  _history.push({
    id:           runId,
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
    undo: { ...undoStub, ...runEnd, runEndByOrg },
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
            extra:   (fs.onlyInTarget || []).length, ambiguous: (fs.ambiguous || []).length,
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
// 🪪 Make a scan's fuzzy matches PERMANENT. identical+changed pairs are
// the one moment name-matching is verified by a human-visible scan — write
// each source Id into the target's identity field and those pairs never
// depend on fuzzy matching again (user 2026-08-29: "a more reliable way to
// match between records between environments").
// How to get SFTK_ID__c into an org — the Seeder's one-click deploy exists
// only in the dev build (studio-seed.js is held back from the store), so the
// store build must say the Setup path instead of pointing at a view that is
// not there (re-review 2026-09-12).
function sftkIdHowToCreate() {
  const here = 'use 🪪 Identity on this page (creates the field and your access in one click)';
  return (typeof window.renderSeed === 'function')
    ? `${here}, or create it from the Org Seeder's Match key picker (deploys the field + your access in one click)`
    : `${here}, or create ${sftkIdFieldName()} on the object in Setup — a Text(18) field marked External ID, visible to your profile`;
}

// ── 🪪 Identity for a WHOLE deployment tree ───────────────────────────────
// User 2026-09-21: "we should offer the field creation and do it ourselves for
// the selected trees". The recipe used to live only in the Org Seeder, which
// the store build does not ship. Same recipe, same gates, every object of the
// tree, shipped.

// Does each object of the tree have a VISIBLE identity field, per org, and
// can it take one? 'no' = missing or not visible to you (both read the same).
async function sftkIdStatusFor(p) {
  const all = _buildAllSessions();
  const srcSess = _resolveSession(p.sourceOrg, all), tgtSess = _resolveSession(p.targetOrg, all);
  const objects = [];
  (function walk(node, path, depth, parentObj) {
    if (!node) return;
    const obj = node.objectType || node.childSObject;
    if (obj) objects.push({ pathKey: path.join('.'), obj, depth, parentObj, src: 'unknown', tgt: 'unknown', customizable: null });
    (node.children || []).forEach((c, i) => walk(c, [...path, i], depth + 1, obj));
  })(p.tree, [], 0, null);
  const probe = async (sess, obj) => {
    if (!sess?.sid) return 'unknown';
    const q = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid, _suppressError: true,
      query: `SELECT ${sftkIdFieldName()} FROM ${obj} LIMIT 1` });
    if (q && !q.error) return 'yes';
    return /INVALID_FIELD|No such column/i.test(String(q?.error || '')) ? 'no' : 'unknown';
  };
  const cache = new Map();
  for (const o of objects) {
    if (!cache.has(o.obj)) cache.set(o.obj, { src: await probe(srcSess, o.obj), tgt: await probe(tgtSess, o.obj) });
    Object.assign(o, cache.get(o.obj));
  }
  const names = [...new Set(objects.map(o => o.obj))];
  const anySess = tgtSess?.sid ? tgtSess : srcSess;
  if (anySess?.sid && names.length) {
    const lit = names.map(n => `'${String(n).replace(/'/g, '')}'`).join(',');
    const q = await sendBg({ type: 'SF_QUERY', tooling: true, orgUrl: anySess.orgUrl, sid: anySess.sid, _suppressError: true,
      query: `SELECT QualifiedApiName, IsCustomizable FROM EntityDefinition WHERE QualifiedApiName IN (${lit})` });
    if (q && !q.error) for (const r of (q.records || [])) for (const o of objects) if (o.obj === r.QualifiedApiName) o.customizable = r.IsCustomizable !== false;
  }
  return { srcOnline: !!srcSess?.sid, tgtOnline: !!tgtSess?.sid, objects };
}

// Create the identity field on `objects` in each of `orgUrls`: field + the
// SFTK_Identity permission set (a field deployed with no access is invisible
// even to an admin) + assign it to the running user. Production, or an org
// whose type cannot be confirmed, gets the typed confirmation BEFORE anything
// is built. The permission set is deployed with every object it ALREADY
// covers in that org, so granting access for one tree never narrows another.
async function sftkIdDeployTo(orgUrls, objects) {
  const out = { ok: 0, errors: [], perOrg: [] };
  const objs = [...new Set((objects || []).filter(Boolean))];
  const orgs = [...new Set((orgUrls || []).filter(Boolean))];
  if (!objs.length || !orgs.length) return out;

  // The one confirmation (sftk-confirm.js, campaign 3 phase 2): one combined
  // dialog naming every guarded org, replacing the per-org confirmTypedProd() loop.
  const guarded = [];
  for (const orgUrl of orgs) {
    const t = await ensureOrgType(orgUrl);
    if (t !== 'sandbox' && t !== 'dev') { guarded.push(orgUrl); }
  }
  if (guarded.length) {
    const gates = await Promise.all(guarded.map(u => sftkOrgWriteGate(u, _orgs)));
    const prodLabel = guarded.map((u, i) => gates[i].label || orgLabel(u)).join(', ');
    const ok = await sftkConfirmDestructive({
      title: `Create the ${sftkIdFieldName()} field on ${objs.length} object(s)`,
      icon: '🪪',
      items: [{ label: objs.join(', '), sub: `and assign the "${sftkIdPermSetName()}" permission set to you` }],
      revOverride: { html: '🔁 <strong>Reversible</strong> — the field and permission set can be removed again in Setup.', needsCheckbox: false },
      confirmLabel: 'Deploy',
      production: { label: prodLabel },
    });
    if (!ok) { out.errors.push('cancelled — nothing was deployed to any org'); return out; }
  }
  const enc = new TextEncoder();
  for (const orgUrl of orgs) {
    const label = orgLabel(orgUrl);
    const sess = await getOrgSession(orgUrl);
    if (!sess?.sid) { out.errors.push(`${label}: not open in a Chrome tab`); continue; }
    // what the permission set already grants here
    let covered = [];
    const fp = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid, _suppressError: true,
      query: `SELECT Field FROM FieldPermissions WHERE Parent.Name = '${sftkIdPermSetName()}'` });
    if (fp && !fp.error) covered = (fp.records || []).map(r => String(r.Field || '')).filter(f => f.endsWith('.' + sftkIdFieldName())).map(f => f.split('.')[0]);
    const { files, packageXml } = sftkIdPackageFiles(objs, '62.0');
    const psFile = { name: `permissionsets/${sftkIdPermSetName()}.permissionset`, text: sftkIdPermSetXml([...new Set([...covered, ...objs])]) };
    const zipBase64 = window.sftkBuildStoredZip([
      { name: 'package.xml', data: enc.encode(packageXml) },
      ...files.filter(f => !/^permissionsets\//.test(f.name)).map(f => ({ name: f.name, data: enc.encode(f.text) })),
      { name: psFile.name, data: enc.encode(psFile.text) },
    ]);
    // History (sftk-history.js): one journal per org — done here (outside
    // runReconcile) because it is an identity-stamp setup step, not a step
    // of a deployment run. The field deploy has no verified undo (see the
    // note below); the permission set assignment does, when this run
    // created it.
    const journal = sftkHistoryBegin({ tool: 'Reconcile', title: `🪪 ${sftkIdFieldName()} + ${sftkIdPermSetName()} — ${label}`, orgUrl: sess.orgUrl });
    const undoSteps = [];
    let undoNote = `the ${sftkIdFieldName()} field can be removed again in Setup (Object Manager → the object → Fields & Relationships) — deleting a field here has no honest re-read: a successful removal makes the same probe query fail, indistinguishable from a broken one`;
    try {
      // The one write discipline (sftk-write.js): a deploy job's own "done"
      // used to BE the report — one probe read per object of the field it was
      // meant to create closes the same gap a PATCH accepted-but-unchanged
      // taught elsewhere (a deploy can report success with the field still
      // invisible to this user's FLS).
      // confirmed-by: sftkIdDeployTo's sftkConfirmDestructive above (before this loop).
      const dw = await sftkWriteVerified({
        describe: `${sftkIdFieldName()} in ${label}`,
        write: () => sendBg({ type: 'SF_METADATA_DEPLOY', orgUrl: sess.orgUrl, sid: sess.sid, zipBase64 }),
        journal,
        verify: async () => {
          const missing = [];
          for (const o of objs) {
            const probe = await sendBg({ type: 'SF_QUERY', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false, _suppressError: true,
              query: `SELECT ${sftkIdFieldName()} FROM ${o} LIMIT 1` });
            if (probe?.error) missing.push(o);
          }
          return missing.length
            ? { ok: false, text: `${sftkIdFieldName()} in ${label}: accepted by Salesforce, but could not be re-read on ${missing.join(', ')}` }
            : { ok: true };
        },
      });
      if (!dw.ok) { out.errors.push(`${label}: deploy failed — ${dw.raw?.error || dw.text}`); out.perOrg.push({ orgUrl, ok: false }); undoNote = 'the field deploy did not verify — nothing to undo'; continue; }
      try {
        const ps = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid,
          query: `SELECT Id FROM PermissionSet WHERE Name = '${sftkIdPermSetName()}' LIMIT 1` });
        const psId = ps?.records?.[0]?.Id;
        const root = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid, path: 'services/data/v62.0/' });
        const userId = sftkIdUserFromIdentity(root?.identity);
        if (!psId || !userId) throw new Error('could not resolve the permission set or your user');
        // confirmed-by: sftkIdDeployTo's sftkConfirmDestructive above (before this loop).
        const aw = await sftkWriteVerified({
          describe: `${sftkIdPermSetName()} assignment in ${label}`,
          write: async () => {
            const r = await sendBg({ type: 'SF_REST_POST', orgUrl: sess.orgUrl, sid: sess.sid,
              path: 'services/data/v62.0/sobjects/PermissionSetAssignment', body: { AssigneeId: userId, PermissionSetId: psId } });
            if (r?.error && !/DUPLICATE_VALUE|already assigned/i.test(String(r.error))) throw new Error(r.error);
            return { success: true, id: r?.id || null, alreadyAssigned: !!r?.error };
          },
          journal,
          noVerify: 'an insert returns the new row, and "already assigned" already means the grant exists',
        });
        if (!aw.accepted) throw new Error(aw.text);
        out.ok++; out.perOrg.push({ orgUrl, ok: true });
        // History: undo removes the assignment ONLY when THIS run created it.
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
        out.perOrg.push({ orgUrl, ok: false });
        out.errors.push(`${label}: the field was created but the permission set could not be assigned (${e?.message || e}) — assign "SFTK Identity" to yourself in Setup, or the field stays invisible`);
      }
    } finally {
      await sftkHistoryEnd(journal, { undo: undoSteps.length ? { steps: undoSteps, note: undoNote } : { none: undoNote } });
    }
  }
  _describeCache = {};   // a new field must be visible to the next describe
  return out;
}

// The dialog: every object of the tree × both orgs, what is there, what can
// be created, and — where the target has the field and pairs are matched —
// the stamp.
async function sftkOpenIdentityModal(p, scan) {
  const srcL = orgLabel(p.sourceOrg || ''), tgtL = orgLabel(p.targetOrg || '');
  showModal(`<div class="ds-modal-header">🪪 Identity — ${esc(p.name || '')}
      <button class="ds-btn ds-btn-xs ds-dc-modal-close" data-dsaction="closeModal" title="Close">✕</button></div>
    <div class="ds-modal-body ds-dc-modal-body"><div id="dsIdBody" style="padding:12px 0">⏳ checking each object in ${esc(srcL)} and ${esc(tgtL)} — one 1-row read per object per org…</div></div>`);
  const paint = async () => {
    const host = eid('dsIdBody'); if (!host) return;
    let st; try { st = await sftkIdStatusFor(p); } catch (e) { host.textContent = `Could not check: ${e?.message || e}`; return; }
    if (!eid('dsIdBody')) return;
    const pill = v => v === 'yes' ? '<span class="ds-psync ds-psync-ok">✓ has it</span>' : v === 'no' ? '<span class="ds-psync ds-psync-bad">✗ missing</span>' : '<span class="ds-lkp-hint">? not checked</span>';
    const scanOf = o => o.depth === 0 ? scan : ((scan?.children?.[o.pathKey]?.status === 'success' && scan.children[o.pathKey].rootRunAt === scan.runAt) ? scan.children[o.pathKey] : null);
    const canT = sftkIdCreatable(st.objects, 'tgt'), canS = sftkIdCreatable(st.objects, 'src');
    host.innerHTML = `
      <div class="ds-rec-card-line" style="margin-bottom:8px">The identity field <code>${esc(sftkIdFieldName())}</code> stores, on each target record, the Id of the source record it came from. With it a record is recognised across orgs <b>exactly</b> — renames and duplicate names stop mattering, and an object with no usable name becomes comparable.</div>
      <div class="ds-dep-tblwrap"><table class="ds-dep-plan"><thead><tr><th>Object</th><th>${esc(srcL)} (source)</th><th>${esc(tgtL)} (target)</th><th class="ds-dep-num">Matched pairs</th><th></th></tr></thead><tbody>
      ${st.objects.map(o => { const s = scanOf(o); const pairs = s ? sftkIdBackfillPairs(s).length : null;
        return `<tr><td><span style="padding-left:${o.depth * 16}px">${o.depth ? '↳ ' : ''}<b>${esc(o.obj)}</b></span>${o.customizable === false ? ' <span class="ds-lkp-hint" title="Salesforce does not allow custom fields on this object, so it cannot carry an identity.">cannot take custom fields</span>' : ''}</td>
          <td>${pill(o.src)}</td><td>${pill(o.tgt)}</td><td class="ds-dep-num">${pairs == null ? '<span class="ds-dep-muted">not scanned</span>' : pairs.toLocaleString()}</td>
          <td>${o.tgt === 'yes' && pairs ? `<button class="ds-btn ds-btn-xs" data-id-stamp="${esc(o.pathKey)}" title="Write each matched source record's Id onto its target record — do this only when the pairs are right">🪪 Stamp ${pairs.toLocaleString()}</button>` : ''}</td></tr>`; }).join('')}
      </tbody></table></div>
      <div class="ds-rec-card-line" style="margin-top:10px"><b>Create the field</b> — a Text(18) External ID field, unique and case-sensitive, plus the permission set <code>${esc(sftkIdPermSetName())}</code> assigned to you (a field without access is invisible even to an admin). Nothing else in the org changes. Production asks you to type its name first.</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;margin-top:6px">
        <label><input type="checkbox" id="dsIdT" ${canT.length ? 'checked' : 'disabled'}> in <b>${esc(tgtL)}</b> — ${canT.length ? `${canT.length} object(s): ${esc(canT.join(', '))}` : 'nothing to create'}</label>
        <label title="Needed when this org is later a SOURCE for another org, or for ← pulls: the identity travels with the record."><input type="checkbox" id="dsIdS" ${canS.length ? '' : 'disabled'}> also in <b>${esc(srcL)}</b> (the source) — ${canS.length ? `${canS.length} object(s)` : 'nothing to create'}</label>
        <button class="ds-btn ds-btn-primary" id="dsIdGo">🪪 Create the field</button>
        <span id="dsIdProg" class="ds-lkp-hint"></span>
      </div>
      ${scan?.dupKeys?.rows ? '<div class="ds-rec-card-line" style="margin-top:8px">⚠ This scan found names used by more than one record. Stamp only after those are sorted out — stamping cements whichever pairing the names happened to give.</div>' : ''}
      <div id="dsIdOut" style="margin-top:8px"></div>`;
    const sync = () => { const b = eid('dsIdGo'); if (b) b.disabled = !((eid('dsIdT')?.checked) || (eid('dsIdS')?.checked)); };
    eid('dsIdT')?.addEventListener('change', sync); eid('dsIdS')?.addEventListener('change', sync); sync();
    eid('dsIdGo')?.addEventListener('click', async () => {
      const jobs = [];
      if (eid('dsIdT')?.checked && canT.length) jobs.push([p.targetOrg, canT]);
      if (eid('dsIdS')?.checked && canS.length) jobs.push([p.sourceOrg, canS]);
      if (!jobs.length) return;
      eid('dsIdGo').disabled = true;
      const lines = [];
      for (const [org, objs] of jobs) {
        eid('dsIdProg').textContent = `⏳ creating on ${objs.length} object(s) in ${orgLabel(org)} — one metadata deploy…`;
        const r = await sftkIdDeployTo([org], objs);
        lines.push(r.errors.length ? `⚠ ${esc(orgLabel(org))}: ${esc(r.errors.join(' · '))}` : `✓ ${esc(orgLabel(org))}: field created on ${esc(objs.join(', '))} and access granted`);
      }
      eid('dsIdProg').textContent = '';
      await paint();
      const o = eid('dsIdOut'); if (o) o.innerHTML = lines.map(l => `<div class="ds-rec-card-line">${l}</div>`).join('');
      try { window.sftkDeployIdentityChanged?.(); } catch (_) {}
    });
    host.querySelectorAll('[data-id-stamp]').forEach(b => b.addEventListener('click', () => {
      const o = st.objects.find(x => x.pathKey === b.dataset.idStamp); if (!o) return;
      const node = o.depth === 0 ? p.tree : getNodeByPath(p.tree, o.pathKey);
      // reconcileStampPairs reads p.tree.objectType — a child node may name itself childSObject
      reconcileStampPairs({ ...p, tree: { ...node, objectType: o.obj } }, scanOf(o));
    }));
  };
  await paint();
}

async function reconcileStampPairs(p, scan) {
  const objType = p?.tree?.objectType;
  const pairs = sftkIdBackfillPairs(scan);
  if (!pairs.length) { showToast('No matched pairs to stamp — run a scan first.', 'warning', 5000); return; }
  const allSess = _buildAllSessions();
  const tgtSess = _resolveSession(p.targetOrg, allSess);
  if (!tgtSess?.sid) { showToast(`${orgLabel(p.targetOrg)} is not reachable`, 'error', 6000); return; }
  // The field must exist AND be visible — an invisible field would make
  // every chunk fail with "No such column" and no hint of the real cause.
  const probe = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
    _suppressError: true, query: `SELECT ${sftkIdFieldName()} FROM ${objType} LIMIT 1` });
  if (probe?.error) {
    showToast(`🪪 ${objType} in ${orgLabel(p.targetOrg)} has no visible ${sftkIdFieldName()} field — ${sftkIdHowToCreate()} first.`, 'warning', 9000);
    if (!eid('dsIdBody')) sftkOpenIdentityModal(p, scan);
    return;
  }
  // The one confirmation (sftk-confirm.js, campaign 3 phase 2) — production,
  // or an org whose type could not be confirmed, gets the typed-name step in
  // the SAME dialog, replacing the confirmTypedProd() / window.confirm() pair
  // that used to live here. Same fail-closed rule as before: only a
  // CONFIRMED sandbox / dev org is exempt (ensureOrgType decides; sftkOrgWriteGate
  // supplies only the display label).
  let gate = null;
  const tgtType = await ensureOrgType(p.targetOrg);
  if (tgtType !== 'sandbox' && tgtType !== 'dev') {
    gate = await sftkOrgWriteGate(p.targetOrg, _orgs);
  }
  const stampOk = await sftkConfirmDestructive({
    title: `🪪 Stamp ${pairs.length} matched ${objType} record(s)`,
    icon: '🪪',
    items: [{ label: orgLabel(p.targetOrg), sub: `${Math.ceil(pairs.length / 200)} update call(s)` }],
    revOverride: { html: `⚠ Writes each source record's Id into <code>${esc(sftkIdFieldName())}</code> — nothing else is changed. These pairs then match EXACTLY on every future scan and seed.`, needsCheckbox: false },
    confirmLabel: '🪪 Stamp',
    production: gate ? { label: gate.label || orgLabel(p.targetOrg) } : null,
  });
  if (!stampOk) return;
  let ok = 0, failed = 0; const errs = [];
  const idField = sftkIdFieldName();
  // History (sftk-history.js): one journal for this button press — done
  // here (outside runReconcile) because it is an identity-stamp step, not a
  // deployment run. The before-value of the identity field is read first so
  // a confirmed stamp can be undone by writing it back.
  const journal = sftkHistoryBegin({ tool: 'Reconcile', title: `🪪 ${pairs.length} ${objType} record(s) stamped — ${orgLabel(p.targetOrg)}`, orgUrl: p.targetOrg });
  const undoSteps = [];
  try {
    const oldValById = new Map();
    for (let i = 0; i < pairs.length; i += 200) {
      const ids = pairs.slice(i, i + 200).map(pr => pr.targetId).filter(Boolean);
      if (!ids.length) continue;
      const oq = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, tooling: false, _suppressError: true,
        query: `SELECT Id, ${idField} FROM ${objType} WHERE Id IN (${ids.map(id => soqlStrLit(id)).join(',')})` });
      if (!oq?.error) for (const r of (oq.records || [])) oldValById.set(r.Id, r[idField] ?? null);
    }
    for (let i = 0; i < pairs.length; i += 200) {
      const recs = sftkIdStampPayload(objType, pairs.slice(i, i + 200));
      // The one write discipline (sftk-write.js): Collections' per-record
      // success used to BE "stamped" — one re-read of exactly this slice's
      // Ids, comparing the identity field to the source Id it was meant to
      // carry, closes the same gap a PATCH accepted-but-unchanged taught
      // elsewhere.
      // confirmed-by: reconcileStampPairs's sftkConfirmDestructive above.
      const dw = await sftkWriteVerified({
        describe: `${objType} identity stamp`,
        write: () => sendBg({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, records: recs }),
        journal,
        verify: async (r) => {
          const okIds = (Array.isArray(r) ? r : (r?.results || [])).filter(x => x && x.success).map(x => x.id);
          if (!okIds.length) return { ok: true, detail: [] };
          const wantById = new Map(recs.map(rec => [rec.Id, rec[idField]]));
          const vq = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, tooling: false, _suppressError: true,
            query: `SELECT Id, ${idField} FROM ${objType} WHERE Id IN (${okIds.map(id => soqlStrLit(id)).join(',')})` });
          if (vq?.error) return { ok: false, text: `${objType} identity stamp: accepted by Salesforce, but the org could not be re-read to confirm it (${vq.error})` };
          const stale = (vq.records || []).filter(rec => String(rec[idField] || '') !== String(wantById.get(rec.Id) || ''));
          return stale.length
            ? { ok: false, detail: stale.map(rec => rec.Id), text: `${objType} identity stamp: accepted by Salesforce, but ${stale.length} record(s) still show the old value` }
            : { ok: true, detail: [] };
        },
      });
      if (!dw.accepted) { failed += recs.length; errs.push(dw.raw?.error || dw.text); continue; }
      const r = dw.raw;
      const staleSet = new Set(Array.isArray(dw.detail) ? dw.detail : []);
      const doneIds = [];
      for (const x of (Array.isArray(r) ? r : (r?.results || []))) {
        if (x && x.success && !staleSet.has(x.id)) { ok++; doneIds.push(x.id); }
        else if (x && x.success) { failed++; if (errs.length < 3) errs.push('accepted by Salesforce, but the org still shows the old value'); }
        else { failed++; if (errs.length < 3) errs.push((x?.errors || []).map(e => e.message).join('; ') || 'rejected'); }
      }
      if (doneIds.length) {
        // Bucket by their OWN previous value — records in this chunk can
        // have different previous values (a mix of first-ever stamps, which
        // were blank, and re-stamps of an already-stamped record), and the
        // verify below can only check "this bucket's Ids now share this ONE
        // value again" — so each bucket becomes its own undo step.
        const buckets = new Map();   // String(oldVal) → { val, ids: [] }
        for (const id of doneIds) {
          const v = oldValById.get(id) ?? null;
          const key = v === null ? '\u0000null' : String(v);
          if (!buckets.has(key)) buckets.set(key, { val: v, ids: [] });
          buckets.get(key).ids.push(id);
        }
        for (const { val, ids } of buckets.values()) {
          undoSteps.push({
            describe: `${objType}: restore the previous ${idField} value (${val === null ? 'blank' : val}) on ${ids.length} record(s)`,
            // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
            msg: { type: 'SF_COLLECTIONS_UPDATE', records: ids.map(id => ({ attributes: { type: objType }, Id: id, [idField]: val })) },
            verify: { query: `SELECT Id FROM ${objType} WHERE Id IN (${ids.map(id => soqlStrLit(id)).join(',')}) AND ${idField} ${val === null ? '= null' : `= ${soqlStrLit(val)}`}`, tooling: false,
              count: ids.length,
              text: { ok: `${objType}: ${ids.length} record(s) back to their previous ${idField} — verified by re-reading the org`,
                      bad: `${objType}: the restore was accepted, but the org doesn't show all ${ids.length} record(s) back on their previous value` } },
          });
        }
      }
    }
  } finally {
    await sftkHistoryEnd(journal, { undo: undoSteps.length ? { steps: undoSteps, note: 'each step restores the exact records it stamped, whether their previous identity value was blank or already set' } : { none: 'nothing was confirmed stamped' } });
  }
  showToast(failed
    ? `🪪 ${ok} stamped, ${failed} failed: ${errs.join(' · ')}`
    : `🪪 ${ok} record(s) stamped — these pairs now match exactly, forever. Re-scan to see matching ride the identity field.`,
    failed ? 'warning' : 'success', 8000);
}

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
      // Lookups → resolve-by-key pairs (mirrors buildLookupCompareMap).
      // They ride by DEFAULT now, not only when hand-mapped: the scan
      // compares lookups by the related record's key, so an overwrite that
      // skipped unmapped ones left that drift permanently unfixable — the
      // user could SEE the wrong parent and not select it (user 2026-08-27:
      // "when updating i want to be able to select lookups as well"). An
      // explicit exclusion (fm[f] === null) still wins, and engine-owned /
      // audit references never ride.
      const lkpCfg = (node.lookupResolutions || {});
      const LKP_NEVER = new Set(['OwnerId', 'CreatedById', 'LastModifiedById']);
      const lkpAuto = [];
      for (const f of d.fields) {
        if (f.type !== 'reference' || f.name === 'RecordTypeId' || LKP_NEVER.has(f.name)) continue;
        if (fm[f.name] === null) continue;
        const mapped = srcFields.includes(f.name);
        const cfg  = lkpCfg[f.name];
        const poly = f.polymorphicForeignKey || (f.referenceTo || []).length > 1;
        if (!f.relationshipName || (poly && !cfg?.matchObject)) continue;
        if (!f.updateable) continue;
        if (!mapped) lkpAuto.push(`${f.name} (by ${cfg?.matchField || 'Name'})`);
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
      if (lkpAuto.length) {
        warnings.push(`🔗 ${lkpAuto.length} lookup(s) included and resolved by matching: ${lkpAuto.join(', ')} — exclude one in Fields & mapping (✕) if it must not be touched.`);
      }
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
    ...(srcNameFld ? [srcNameFld] : []),   // labels for History links only
    // A person account's Name cannot be written (derived from its parts) —
    // the flag lets the loop below leave it out (user 2026-09-15).
    ...(descByLower['ispersonaccount'] ? ['IsPersonAccount'] : [])
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
        if (!k) continue;
        // A key matching MORE THAN ONE target parent is ambiguous — linking
        // to either would be a guess, so it is EXCLUDED (fail closed, same
        // rule as the engine bridge since 2026-08-27). Those lookups stay
        // unchanged and the warning names the values.
        if (rp.byKey.has(k)) { (rp.dupKeys = rp.dupKeys || new Set()).add(k); continue; }
        rp.byKey.set(k, rec.Id);
      }
    }
    if (rp.dupKeys && rp.dupKeys.size) {
      for (const k of rp.dupKeys) rp.byKey.delete(k);
      const ex = [...rp.dupKeys].slice(0, 3).map(v => `“${v}”`).join(', ');
      warnings.push(`⚠ ${rp.sf}: ${rp.dupKeys.size} ${rp.parentObj}.${rp.matchField} value(s) match MORE THAN ONE target record (${ex}${rp.dupKeys.size > 3 ? '…' : ''}) — linking to either would be a guess, so those lookups were left unchanged. Deduplicate the target or match on an External ID.`);
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
      // Person Account: Salesforce refuses the whole Name ("Unable to
      // create/update fields: Name") — FirstName/LastName carry the change.
      if (sf === 'Name' && sr.IsPersonAccount === true) continue;
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

  // The one write discipline (sftk-write.js): Collections' per-record
  // success used to BE "updated" — one re-read of exactly the accepted Ids,
  // comparing each record's OWN written fields (they vary per row — PII
  // masking, lookups, owner reassignment), closes the same gap a PATCH
  // accepted-but-unchanged taught elsewhere.
  const writeFields = [...new Set(payloads.flatMap(p => Object.keys(p).filter(k => k !== 'Id' && k !== 'attributes')))];
  // confirmed-by: every caller (runReconcile's root/inverse/child overwrite
  // paths) confirms via runReconcile's Proceed/production sftkConfirmDestructive first.
  // history-by: the deployment's own History entry (rollback in studio-undo.js)
  const dw = await sftkWriteVerified({
    describe: `${objType} overwrite`,
    write: () => sendBg({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, records: payloads }),
    verify: async (r) => {
      const arr0 = Array.isArray(r) ? r : [];
      const okById = new Map();
      arr0.forEach((x, i) => { if (x && x.success && payloads[i]) okById.set(payloads[i].Id, payloads[i]); });
      if (!okById.size || !writeFields.length) return { ok: true, detail: [] };
      const ids = [...okById.keys()];
      const stale = [];
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        const vq = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, tooling: false, _suppressError: true,
          query: `SELECT Id, ${writeFields.join(', ')} FROM ${objType} WHERE Id IN (${chunk.map(id => soqlStrLit(id)).join(',')})` });
        if (vq?.error) return { ok: false, text: `${objType} overwrite: accepted by Salesforce, but the org could not be re-read to confirm it (${vq.error})` };
        for (const rec of (vq.records || [])) {
          const want = okById.get(rec.Id);
          const mism = Object.keys(want).filter(k => k !== 'Id' && k !== 'attributes' && String(rec[k] ?? '') !== String(want[k] ?? ''));
          if (mism.length) stale.push(rec.Id);
        }
      }
      return stale.length
        ? { ok: false, detail: stale, text: `${objType} overwrite: accepted by Salesforce, but ${stale.length} record(s) still show a different value` }
        : { ok: true, detail: [] };
    },
  });
  const res = dw.accepted ? dw.raw : { error: dw.raw?.error || dw.text };
  const arr = Array.isArray(res) ? res : [];
  const staleSet = new Set(Array.isArray(dw.detail) ? dw.detail : []);
  const ok = arr.filter((r, i) => r.success && !(payloads[i] && staleSet.has(payloads[i].Id))).length;
  const errors = [...warnings, ...ovwErrors];
  if (!dw.accepted) errors.push(`${objType}: ${dw.raw?.error || dw.text}`);
  else if (!dw.ok) errors.push(dw.text);
  // Per-record outcomes with labels — History renders both as links:
  // updated → the target record; failed update → also the target record
  // (it exists — the PATCH was refused), with the error on hover.
  const updatedRecords = [];
  const failedRecords  = [];
  arr.forEach((r, i) => {
    if (!rowMeta[i]) return;
    const stale = r.success && payloads[i] && staleSet.has(payloads[i].Id);
    if (r.success && !stale) { if (updatedRecords.length < 200) updatedRecords.push(rowMeta[i]); }
    else if (failedRecords.length < 200) {
      failedRecords.push({ ...rowMeta[i], error: stale ? 'accepted by Salesforce, but the org still shows a different value' : (r.errors || []).map(e => e.message).join('; ') });
    }
  });
  // Dedupe identical per-record failures — 20 rows all failing with the same
  // "No such column 'X'" should read as ONE line with a count, not a wall.
  const failCounts = new Map();
  for (const [i, r] of arr.entries()) {
    const stale = r.success && payloads[i] && staleSet.has(payloads[i].Id);
    if (r.success && !stale) continue;
    const m = stale ? `${objType}: accepted by Salesforce, but the org still shows a different value` : `${objType}: ${(r.errors || []).map(e => e.message).join('; ')}`;
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
// The field-by-field compare opens in a WIDE modal, never inside a column
// (user 2026-09-16: "you can't see the field values because it's too
// small"). Root and child rows share it. `prof` is the profile — or, for a
// child row, a view of it whose tree is the child node — so field mapping,
// lookups and the per-field push all read the right node.
async function sftkOpenDriftCompare(prof, obj, srcId, tgtId, srcFields, tgtFields, keyLabel, fallbackFields) {
  showModal(`
    <div class="ds-modal-header">▸ ${esc(obj)} · ${esc(keyLabel || srcId)}
      <span class="ds-dc-modal-sub">${esc(orgLabel(prof.sourceOrg || ''))} (source) vs ${esc(orgLabel(prof.targetOrg || ''))} (target)</span>
      <button class="ds-btn ds-btn-xs ds-dc-modal-close" data-dsaction="closeModal" title="Close">✕</button>
    </div>
    <div class="ds-modal-body ds-dc-modal-body"><div class="ds-drift-compare-loading">Loading…</div></div>`);
  const box = eid('dsModalBox');
  const body = box ? box.querySelector('.ds-dc-modal-body') : null;
  if (!body) return;
  const res = await fetchDriftRowDetail(prof, obj, srcId, tgtId, srcFields, tgtFields);
  if (!body.isConnected) return;   // closed while loading
  if (res.error) {
    // Fall back to the scan-time answer when the live fetch can't run.
    const fieldsNote = (fallbackFields || []).length
      ? `<div class="ds-drift-compare-fallback">At the last scan these field(s) differed: <strong>${esc(fallbackFields.join(', '))}</strong></div>`
      : '';
    body.innerHTML = `${fieldsNote}<div class="ds-drift-compare-err">⚠ ${esc(res.error)}</div>`;
    return;
  }
  // selectable: ticked fields (lookups included) push straight onto THIS
  // target record — the refetch repaints from live values so a fixed field
  // never keeps showing as drifted.
  const paint = r => {
    body.innerHTML = renderDriftCompareTable(r.srcRec, r.tgtRec, srcFields, tgtFields, r.lookupMap || {}, r.types || null, { selectable: true });
    // A synced record has no differing rows — then the matching fields ARE the
    // answer, so show them instead of a folded line (user 2026-09-21).
    if (!body.querySelector('.ds-dc-diff')) body.querySelector('details.ds-dc-fold')?.setAttribute('open', '');
    sftkWireDriftCompare(body, prof, obj, srcId, tgtId, async () => {
      const fresh = await fetchDriftRowDetail(prof, obj, srcId, tgtId, srcFields, tgtFields);
      if (!fresh.error && body.isConnected) paint(fresh);
    });
  };
  paint(res);
}

// PURE. The Person Account contacts line — what happened to them, in words.
//   pa: scan.personContacts = { src, tgt, synced, waiting, follows, targetOnly }
function sftkPaContactsLine(pa, srcLabel, tgtLabel) {
  if (!pa || !(pa.src || pa.tgt)) return '';
  const parts = [];
  if (pa.synced)     parts.push(`${pa.synced} synced (listed under 🟢 Synced, tagged 👤)`);
  if (pa.waiting)    parts.push(`${pa.waiting} arrive with their Person Account — never inserted on their own`);
  if (pa.follows)    parts.push(`${pa.follows} differ — they follow their Account: resolve the Account's 🟡 Changed row`);
  if (pa.targetOnly) parts.push(`${pa.targetOnly} exist only in ${tgtLabel} — delete the Person Account, not its contact`);
  return `👤 Person Account contacts (${pa.src} in ${srcLabel}, ${pa.tgt} in ${tgtLabel}): ${parts.length ? parts.join(' · ') : 'none matched'}. Salesforce creates and owns them, so they are never offered for insert, update or delete.`;
}

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
// The duplicate-name warning: WHO they are (linked in both orgs — user
// 2026-08-10 "where are the records", 2026-09-21 "who are they?") and WHAT to
// do about it, in the order that is safe (user 2026-09-21: "What operations we
// can suggest in order to fix"). Shared by ⚖ Reconcile and the Deploy view.
// Buttons carry data-rec-dupfix; each page wires them (sftkRecWireDupFix).
function sftkRecDupsHtml(scan, p) {
  const ex = (scan && scan.dupKeys && scan.dupKeys.examples) || [];
  if (!scan || !scan.dupKeys || !scan.dupKeys.rows) return '';
  const key = k => esc(typeof sftkMatchKeyLabel === 'function' ? sftkMatchKeyLabel(k) : String(k ?? ''));
  const rl = (org, id, i) => `<a href="${esc(String(org || '').replace(/\/$/, ''))}/lightning/r/${esc(id)}/view" target="_blank" rel="noopener" class="ds-lkpo-vallink" title="${esc(id)}">copy ${i + 1}</a>`;
  const rows = ex.map(e => {
    const parts = [];
    if ((e.src || []).length > 1) parts.push(`${e.src.length}× in ${esc(orgLabel(p.sourceOrg))}: ${e.src.map((id, i) => rl(p.sourceOrg, id, i)).join(' · ')}`);
    if ((e.tgt || []).length > 1) parts.push(`${e.tgt.length}× in ${esc(orgLabel(p.targetOrg))}: ${e.tgt.map((id, i) => rl(p.targetOrg, id, i)).join(' · ')}`);
    return `<div class="ds-rec-dup-row">“<strong>${key(e.key)}</strong>” ${parts.join(' and ')}</div>`;
  }).join('');
  const more = (scan.dupKeys.keys || []).length > ex.length ? `<div class="ds-rec-dup-note">Showing ${ex.length} of ${(scan.dupKeys.keys || []).length} duplicated name(s).</div>` : '';
  const saved = !p.ephemeral && !!p.id;
  // Match review only has something to do when BOTH unmatched buckets hold rows
  // (user 2026-09-21: followed the advice, the dialog was empty).
  const unS = (scan.missingInTarget || []).length, unT = (scan.onlyInTarget || []).length;
  return `<details class="ds-rec-dups">
      <summary>⚠ ${ex.length} name(s) used by more than one record — the scan never guesses which copy is which</summary>
      <div class="ds-rec-dup-rows">${rows}</div>${more}
      <div class="ds-rec-dup-note"><b>Why it matters:</b> records are matched by this name. With two “same” names the pairing is a coin flip, and so is anything else that finds records by name — lookups, other deployments.</div>
      <div class="ds-rec-dup-fix"><b>How to fix it, safest first</b>
        <ol>
          <li><b>Make the copies one record.</b> Open the copies above. If they are the same real thing, merge them in Salesforce (Accounts, Contacts and Leads have Merge — it keeps one record and moves the related records onto it). If one is junk, delete or rename it. Do it in <i>both</i> orgs, then 🔄 Refresh state.</li>
          <li><b>Or make the match key unique.</b> If both records are legitimate, the name alone cannot tell them apart — add a second field to the key (for example Name + Billing City, or an account number). ${saved ? `<button class="ds-btn ds-btn-xs" data-dsaction="editProfile" data-arg="${esc(p.id)}" title="Opens this deployment in the builder — Pick Records → Matching">✏ Change the match key</button>` : '<span class="ds-lkp-hint">Save this pair as a deployment to change its match key.</span>'}</li>
          ${unS && unT
            ? `<li><b>Or pair them by hand.</b> <button class="ds-btn ds-btn-xs" data-rec-dupfix="review" title="Pick, for each unmatched source record, the target record it really is — remembered for this org pair">🔗 Match review</button> pairs the ${unS.toLocaleString()} unmatched source record(s) with the ${unT.toLocaleString()} unmatched target record(s) — you say which is which.</li>`
            : `<li><b>Pairing by hand is not possible here.</b> 🔗 Match review pairs records the scan could <i>not</i> match, and this scan left none unmatched: every copy above already got a partner — by name, in whatever order Salesforce returned them, which is exactly the coin flip. Matched records cannot be re-paired from here, so use step 1 or 2.</li>`}
          <li><b>Then make it stick.</b> Once the pairs are right, <button class="ds-btn ds-btn-xs" data-rec-dupfix="stamp" title="Writes each source record's Id into SFTK_ID__c on its matched target record — future scans match on that, whatever the names are">🪪 Stamp identity</button> writes each source record’s Id onto its target record, so later scans match on that and never on the name again. <i>Do this last</i> — stamping while copies are still ambiguous would cement a coin flip.</li>
        </ol>
      </div>
    </details>`;
}
function sftkRecWireDupFix(root, p, scan) {
  (root || document).querySelectorAll('[data-rec-dupfix]').forEach(b => b.addEventListener('click', e => {
    e.preventDefault();
    if (b.dataset.recDupfix === 'review') openMatchReview(p);
    else if (b.dataset.recDupfix === 'stamp') reconcileStampPairs(p, scan);
  }));
}

// Engine settings live ON THE PROFILE (the engine reads profile.apiMode /
// batchSize / threads at run start). For an ephemeral chooser pair, mirror
// onto the REAL profile via _ringOf so the choice survives the session.
async function sftkRecEnginePersist(p) {
  const realP = p._ringOf?.profileId ? _profiles.find(x => x.id === p._ringOf.profileId) : null;
  if (realP) {
    if (p.apiMode) realP.apiMode = p.apiMode; else delete realP.apiMode;
    if (p.batchSize) realP.batchSize = p.batchSize; else delete realP.batchSize;
    if (p.threads) realP.threads = p.threads; else delete realP.threads;
  }
  try { await storageSaveProfiles(); } catch (_) {}
}
// One engine setting, the SAME rules the classic controls apply: auto = no
// key; batch size 1–200 with 200 the implicit default; threads 1–6 with 1 the
// implicit default. Returns the value actually stored.
async function sftkRecSetEngine(p, key, raw) {
  let out;
  if (key === 'apiMode') { if (raw === 'sync' || raw === 'bulk') p.apiMode = raw; else delete p.apiMode; out = p.apiMode || 'auto'; }
  else if (key === 'batchSize') { const n = Math.max(1, Math.min(200, parseInt(raw, 10) || 200)); if (n === 200) delete p.batchSize; else p.batchSize = n; out = n; }
  else if (key === 'threads') { const n = Math.max(1, Math.min(6, parseInt(raw, 10) || 1)); if (n === 1) delete p.threads; else p.threads = n; out = n; }
  else if (key === 'duplicateRules') { if (raw === 'bypass') p.duplicateRules = 'bypass'; else delete p.duplicateRules; out = p.duplicateRules || 'respect'; }
  await sftkRecEnginePersist(p);
  return out;
}

// ── Parents-first: the shared data side (classic advisor + Deploy view) ──
// PURE. Where one parent object stands for this org pair.
//   g:  { empty }                       from the LIMIT-1 probe
//   vd: { missing, changed, at } | null from the session verdict map
function sftkParentStepState(g, vd) {
  // The SOURCE has none of this object → no record can point at one → it is
  // not a gap, whatever the target holds (user 2026-09-21: sent to "deploy
  // Individual first" with 0 Individuals in both orgs).
  if (g && g.srcCount === 0) return 'notneeded';
  if (g && g.empty) return 'empty';
  if (!vd) return 'unknown';
  return (!vd.missing && !vd.changed) ? 'done' : 'behind';
}

// Which objects OUTSIDE this deployment does `objType` point at, and does the
// target hold any of them? One LIMIT-1 probe per referenced object; an
// unknowable probe says nothing rather than guess. `probeCache` (optional) lets
// a caller that walks several objects probe each referenced object once.
async function sftkParentGapsFor(objType, desc, tdesc, treeObjs, tgtSess, probeCache) {
  const seen = new Set(); const parents = [];
  for (const f of sftkLkpRefFields(desc?.fields)) {
    const refObj = (f.referenceTo || [])[0];
    if (!refObj || treeObjs.has(refObj) || seen.has(refObj)) continue;
    seen.add(refObj);
    let empty;
    if (probeCache && probeCache.has(refObj)) empty = probeCache.get(refObj);
    else {
      const probe = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
        _suppressError: true, query: `SELECT Id FROM ${refObj} LIMIT 1` });
      empty = probe?.error ? null : !(probe?.records || []).length;
      if (probeCache) probeCache.set(refObj, empty);
    }
    if (empty === null) continue;   // unknowable → say nothing rather than guess
    const tf = (tdesc?.fields || []).find(x => x.name === f.name);
    parents.push({ field: f.name, refObj, empty, required: !!tf && tf.nillable === false });
  }
  return parents;
}

// EVERY object of the deployment (root, children, grandchildren) with the
// outside objects it points at — the Deploy view's "Start with parents first".
async function sftkParentOrderFor(p) {
  await sftkParentSyncLoad();
  const all = _buildAllSessions();
  const srcSess = _resolveSession(p.sourceOrg, all), tgtSess = _resolveSession(p.targetOrg, all);
  if (!srcSess?.sid || !tgtSess?.sid) return { offline: true, objects: [] };
  const objects = [];
  (function walk(node, path, depth, parentObj) {
    if (!node) return;
    const obj = node.objectType || node.childSObject;
    if (obj) objects.push({ pathKey: path.join('.'), obj, depth, parentObj, parents: [] });
    (node.children || []).forEach((c, i) => walk(c, [...path, i], depth + 1, obj));
  })(p.tree, [], 0, null);
  const treeObjs = new Set(objects.map(o => o.obj));
  const probeCache = new Map();
  for (const o of objects) {
    let desc = null, tdesc = null;
    try { desc = await describe(o.obj, srcSess.orgUrl, srcSess.sid); } catch (_) { desc = null; }
    try { tdesc = await describe(o.obj, tgtSess.orgUrl, tgtSess.sid); } catch (_) { tdesc = null; }
    try { o.parents = await sftkParentGapsFor(o.obj, desc, tdesc, treeObjs, tgtSess, probeCache); } catch (_) { o.parents = []; }
  }
  // How many of each parent object the SOURCE holds — one COUNT() per object.
  // 0 means nothing can point at one; the number also decides whether the
  // page may check alignment on its own or should ask first. null = unknown.
  const counts = new Map();
  for (const o of objects) for (const g of o.parents) {
    if (!counts.has(g.refObj)) {
      const c = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: srcSess.orgUrl, sid: srcSess.sid,
        _suppressError: true, query: `SELECT COUNT() FROM ${g.refObj}` });
      counts.set(g.refObj, (c && !c.error && Number.isFinite(c.totalSize)) ? c.totalSize : null);
    }
    g.srcCount = counts.get(g.refObj);
  }
  return { offline: false, objects };
}

// One background alignment check of a parent object: scan it across this org
// pair and deposit the verdict. Never throws.
async function sftkParentVerifyOne(p, refObj) {
  try {
    const eph = { id: `chk_${Date.now()}`, name: `${refObj} check`,
      sourceOrg: p.sourceOrg, targetOrg: p.targetOrg, ephemeral: true,
      scanConfig: { matchField: 'Name', compareFields: [] },
      tree: { objectType: refObj, where: '', children: [] } };
    const res = await runDiffScan(eph);
    if (res?.error) return false;
    sftkParentSyncPut(p.sourceOrg, p.targetOrg, refObj, {
      missing: (res.missingInTarget || []).length,
      changed: (res.changed || []).length,
      extra:   (res.onlyInTarget || []).length, ambiguous: (res.ambiguous || []).length,
      at:      res.runAt || new Date().toISOString(),
    });
    return true;
  } catch (_) { return false; }
}

// The one-click journey: scan the parent object across this pair and open it,
// stamped so the page offers "Continue to <child>" once it is aligned (user
// 2026-08-10: "we deployed the parents. now we need to be able to deploy the
// childrens"). Returns false when the scan failed.
async function sftkOpenParentsFirst(p, refObj, forObj) {
  const eph = {
    id: `gap_${Date.now()}`,
    name: `${refObj} — parents first`,
    sourceOrg: p.sourceOrg, targetOrg: p.targetOrg,
    ephemeral: true,
    scanConfig: { matchField: 'Name', compareFields: [] },
    tree: { objectType: refObj, where: '', children: [] },
    // The origin may itself be unsaved (a pair clone from 🚀 Deploy with a
    // non-primary target, a ring ⚖): then it is not in _profiles, so keep the
    // object — the way back must always exist (user 2026-10-01: "when i click
    // back to account. nothing occurs").
    _parentOf: { profileId: p.id, objType: forObj, ...(p.ephemeral ? { profile: p } : {}) },
  };
  const res = await runDiffScan(eph);
  if (res?.error) { showToast(`Scan failed: ${res.error}`, 'error', 6000); return false; }
  eph.lastScan = res;
  _reconcileProfile = eph;
  renderReconcile();
  showToast(`Push these ${(res.missingInTarget || []).length} record(s), then continue back to ${forObj} — the banner up top takes you there.`, 'info', 6500);
  return true;
}

// The RUN GATE the advisor feeds (runReconcile reads it): a required lookup
// into an object the target has NONE of dooms the root inserts.
function sftkParentGapSetGate(p, scan, rootParents, rootHasMissing) {
  const key = `${p.id}|${scan.runAt}`;
  // an object the source has none of cannot doom anything
  const ps = rootHasMissing ? (rootParents || []).filter(s => s.srcCount !== 0) : [];
  _recParentGapState = { key,
    doomed:  ps.filter(s => s.empty && s.required).map(s => s.refObj),
    empties: ps.filter(s => s.empty && !s.required).map(s => s.refObj) };
  return _recParentGapState;
}

async function sftkRecParentGapAdvisor(p, scan, objType, missing) {
  const host = eid('dsRecParentGaps');
  if (!host) return;
  const key = `${p.id}|${scan.runAt}`;
  const wire = () => host.querySelectorAll('[data-recgap]').forEach(b => b.addEventListener('click', async () => {
    const refObj = b.dataset.recgap;
    b.disabled = true; b.textContent = '⏳ scanning…';
    if (!(await sftkOpenParentsFirst(p, refObj, objType))) { b.disabled = false; b.textContent = `➕ Deploy ${refObj} first`; }
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
    const parents = await sftkParentGapsFor(objType, desc, tdesc, treeObjs, tgtSess);
    if (!parents.length) { _recParentGapState = { key, doomed: [], empties: [] }; return; }
    // Numbered plan (user 2026-08-10: "its very unclear what is the correct
    // order") — the panel is now an explicit ordered checklist: every parent
    // is a numbered step with live status from the session sync map; this
    // deployment is always the LAST step, and the first unfinished step
    // carries a "← next" marker. No more inferring the order.
    const steps = parents.map(g => {
      const vd = _parentSyncVerdicts[sftkParentSyncKey(p.sourceOrg, p.targetOrg, g.refObj)];
      return { ...g, vd, done: sftkParentStepState(g, vd) === 'done',
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
    _recParentGapHtml = `<div class="ds-rec-card ${doomed.length ? 'ds-rec-card-bad' : anyEmpty ? 'ds-rec-card-warn' : ''}">
      <div class="ds-rec-card-hd"><span class="ds-rec-card-ico">⛓</span>
        <span class="ds-rec-card-title">${doomed.length ? '⛔ Stop — inserts here fail until the parents exist · ' : ''}Deployment order</span>
        <span class="ds-rec-card-hint">parents first — this deployment's lookups land on them by name</span></div>
      <div class="ds-rec-card-body">
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
            await sftkParentVerifyOne(p, s.refObj);
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

