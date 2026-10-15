'use strict';
// ════════════════════════════════════════════════════════════════════════
// DEPLOY VIEW (BETA) — one page instead of "Run Transfer" + "⚖ Reconcile"
// ════════════════════════════════════════════════════════════════════════
// User 2026-09-19: "Can you implement it with the option for us to go back to
// the current view?" — so this page sits BESIDE the classic pages, behind a
// switch (Data Deployment → ✨ New Deploy view), and replaces nothing.
//
// THE RULE OF THIS FILE: it is a PRESENTATION. It owns no engine, no scan and
// no selection state of its own:
//   • the scan        → p.lastScan / scan.children[pathKey]   (runDiffScan, scanReconcileChild)
//   • the selection   → _recSel / _recChildSel                (the Sets ⚖ Reconcile uses)
//   • the run         → runReconcile(p, objType, buckets)     (unchanged)
//   • the compare     → sftkOpenDriftCompare, renderLkpOverridePanel
//   • the advisor     → sftkRecParentGapAdvisor               (paints #dsRecParentGaps)
// A record ticked here is written by exactly the code the classic page runs.
// Design + parity checklist: docs/deploy-merge-parity.md, docs/mockups/deploy-merged.html.

// ── the switch ────────────────────────────────────────────────────────────
function sftkDeployViewOn() {
  // 1.5.0: this page IS Data Deployment's page — every door opens it. The one
  // way out is a settings key with no button (support fallback): deployViewClassic.
  return !(typeof _settings === 'object' && _settings && _settings.deployViewClassic === true);
}
async function sftkDeployViewSet(on) {
  _settings.deployViewClassic = !on;
  await storageSaveSettings();
}

// ── PURE helpers (tested in test/deploy-view-0919.test.mjs) ───────────────
// Every object in the deployment, root first, with its tree path.
function sftkDeployObjects(tree) {
  const out = [];
  (function walk(node, path, depth, parentObj) {
    if (!node) return;
    const obj = node.objectType || node.childSObject || '?';
    out.push({ pathKey: path.join('.'), obj, depth, parentObj: parentObj || null, field: node.field || null });
    (node.children || []).forEach((c, i) => walk(c, [...path, i], depth + 1, obj));
  })(tree, [], 0, null);
  return out;
}

// Is this child scan usable for the CURRENT root scan? Same three conditions
// the classic page checks: it succeeded, it belongs to this root scan, and it
// is for this object (a tree edit can put another object on the same path).
function sftkDeployChildFresh(scan, pathKey, obj) {
  const cs = scan && scan.children ? scan.children[pathKey] : null;
  return !!(cs && cs.status === 'success' && cs.rootRunAt === scan.runAt && cs.objectType === obj);
}

// The scan to read for one object: the root scan itself, or its fresh child
// scan; null when that object has no usable scan yet.
function sftkDeployScanFor(scan, o) {
  if (!scan || !o) return null;
  if (o.depth === 0) return scan;
  return sftkDeployChildFresh(scan, o.pathKey, o.obj) ? scan.children[o.pathKey] : null;
}

// Today's Reconcile vocabulary, colours and order (user 2026-09-18).
const SFTK_DEPLOY_TABS = [
  { k: 'ins',  bucket: 'missingInTarget', label: '🔴 Insert',         noun: 'to insert',      childOnly: false },
  { k: 'chg',  bucket: 'changed',         label: '🟡 Changed',        noun: 'changed',        childOnly: false },
  { k: 'ext',  bucket: 'onlyInTarget',    label: '🔵 In target only', noun: 'in target only', childOnly: false },
  { k: 'link', bucket: 'linkMismatch',    label: '⇄ Link differs',    noun: 'point at a different parent', childOnly: true },
  { k: 'same', bucket: 'identical',       label: '🟢 Synced',         noun: 'synced',         childOnly: false },
  // Campaign 3 phase 5 — a key both orgs hold more than once: never guessed.
  { k: 'amb',  bucket: 'ambiguous',       label: '⚠ Needs a decision', noun: 'need a decision — not deployed until you choose', childOnly: false },
];

// One plan row per object. `info(scanLike, bucket)` is sftkScanBucketInfo —
// the measured TOTAL even when the stored list is capped; `label(...)` is
// sftkBucketCountLabel. Both injected so this stays pure.
// The count a person reads in a cell or on a tab: the TRUE total. A truncated
// list is a property of the LIST, not of the number — "5,000 of 9,899" under
// SYNCED read as "4,899 are not synced" (user 2026-10-03: "where do i see
// those who are not synced?"). The list itself says how many it shows.
//   complete / capped with a known total → "9,899" ("+" when the total is a floor)
//   capped, total not measured           → "5,000+"
// PURE.
function sftkDeployCountLabel(shown, total, capped, totalIsFloor) {
  const group = n => String(Math.floor(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const known = total != null && Number.isFinite(Number(total)) && Number(total) >= 0;
  if (!capped) return known ? `${group(total)}${totalIsFloor ? '+' : ''}` : group(shown);
  if (known && Number(total) > Number(shown)) return `${group(total)}${totalIsFloor ? '+' : ''}`;
  return `${group(shown)}+`;
}

function sftkDeployPlanRows(tree, scan, info, label) {
  return sftkDeployObjects(tree).map(o => {
    const s = sftkDeployScanFor(scan, o);
    const row = { ...o, scanned: !!s, src: null, tgt: null, cells: {} };
    if (!s) return row;
    row.src = s.fetched && Number.isFinite(s.fetched.src) ? s.fetched.src : null;
    row.tgt = s.fetched && Number.isFinite(s.fetched.tgt) ? s.fetched.tgt : null;
    for (const t of SFTK_DEPLOY_TABS) {
      if (t.childOnly && o.depth === 0) continue;
      const i = info(s, t.bucket);
      const n = i.total != null ? i.total : i.shown;
      row.cells[t.k] = { n, shown: i.shown, capped: !!i.capped, text: label(i.shown, i.total, i.capped, i.totalIsFloor) };
    }
    return row;
  });
}

// The objects THIS run writes: every object with something selected, plus its
// ancestors in the tree (a selected child rides with its missing parents).
// The ⏸ pauses use it — automation is switched off only on the objects in use
// (user 2026-10-03: "it should cancel the validation only for the used objects
// and re enble them afterwards"). PURE. objects: sftkDeployObjects(tree).
function sftkDeployWrittenObjects(objects, recSel, recChildSel) {
  const size = s => (s && typeof s.size === 'number') ? s.size : 0;
  const any = sel => !!sel && Object.values(sel).some(v => size(v) > 0);
  const byPath = new Map((objects || []).map(o => [o.pathKey, o.obj]));
  const out = new Set();
  const addWithAncestors = pathKey => {
    let k = String(pathKey || '');
    for (;;) {
      if (byPath.has(k)) out.add(byPath.get(k));
      if (k === '') break;
      const i = k.lastIndexOf('.');
      k = i < 0 ? '' : k.slice(0, i);
    }
  };
  if (any(recSel)) addWithAncestors('');
  for (const [k, sel] of Object.entries(recChildSel || {})) if (any(sel)) addWithAncestors(k);
  return out;
}

// What is selected, in words and as one number — from the SAME Sets the
// classic page fills. objByPath: { pathKey → object name }.
function sftkDeploySelection(recSel, recChildSel, rootObj, objByPath) {
  const parts = [];
  let total = 0;
  const add = (n, txt) => { if (n) { parts.push(`${n.toLocaleString()} ${txt}`); total += n; } };
  const r = recSel || {};
  const size = s => (s && typeof s.size === 'number') ? s.size : 0;
  add(size(r.push),      `${rootObj} to insert`);
  add(size(r.overwrite), `${rootObj} to update (source wins)`);
  add(size(r.updSrc),    `${rootObj} to update in the SOURCE (target wins)`);
  add(size(r.pull),      `${rootObj} to pull into the source`);
  add(size(r.del),       `${rootObj} to delete`);
  for (const [k, s] of Object.entries(recChildSel || {})) {
    const o = (objByPath && objByPath[k]) || 'child';
    add(size(s && s.push),      `${o} to insert`);
    add(size(s && s.relink),    `${o} to relink`);
    add(size(s && s.overwrite), `${o} to update`);
    add(size(s && s.del),       `${o} to delete`);
  }
  return { parts, total };
}

// PURE. The deployment as a nested tree (root → children → grandchildren).
function sftkDeployTreeNodes(tree) {
  return (function walk(node, path, depth) {
    if (!node) return null;
    return { pathKey: path.join('.'), obj: node.objectType || node.childSObject || '?', depth, field: node.field || null,
      children: (node.children || []).map((c, i) => walk(c, [...path, i], depth + 1)).filter(Boolean) };
  })(tree, [], 0);
}

// PURE. What one object's card in the tree says (user 2026-10-05, on the tree:
// "the view of the objects and their relation. how many each hold"): how the
// object hangs under its parent, how many records each org holds, and what is
// left to do — or that it has not been counted, which is never "zero".
//   n          tree node { obj, depth, field }
//   parentObj  the object above it ('' for the root)
//   row        its plan row (sftkDeployPlanRows) or null
// → { role, counted, src, tgt, work: [{ k, icon, n, text, words }], total, inSync }
const SFTK_DEPLOY_NODE_WORK = [
  ['ins', '🔴', 'to insert'], ['chg', '🟡', 'changed'], ['ext', '🔵', 'only in the target'],
  ['link', '⇄', 'linked differently'], ['amb', '⚠', 'need a decision'],
];
function sftkDeployNodeFacts(n, parentObj, row) {
  const role = (n && n.depth) ? `under ${parentObj || '?'} · ${n.field || '?'}` : 'the root object';
  if (!row || !row.scanned) return { role, counted: false, src: null, tgt: null, work: [], total: null, inSync: false };
  const work = SFTK_DEPLOY_NODE_WORK
    .map(([k, icon, words]) => ({ k, icon, words, n: (row.cells && row.cells[k] && Number(row.cells[k].n)) || 0, text: (row.cells && row.cells[k] && row.cells[k].text) || '0' }))
    .filter(w => w.n > 0);
  const total = work.reduce((t, w) => t + w.n, 0);
  return { role, counted: true, src: row.src, tgt: row.tgt, work, total, inSync: total === 0 };
}

// ── page state (presentation only) ────────────────────────────────────────
let _depObjPath = '';      // which object the records panel shows ('' = root)
let _depTab     = 'ins';
let _depFilter  = '';
let _depForProfile = null;
let _depLastRunLog = null;   // { pid, html } — the last run's log, kept across the post-run repaint
const SFTK_DEPLOY_WINDOW = 300;   // rows painted per tab at first; "Show more" / "Show all" extend it
// The window grows per list (object × tab × filter) and resets when the list
// changes (user 2026-10-02: "Showing 300 of 350 … Filter to find a record" —
// "dont think its a good user exp. we need to give the info somehow").
let _depWindow = SFTK_DEPLOY_WINDOW, _depWindowKey = '';
// ⚠ Needs a decision: what the user chose per source record (target id, or
// '__new__'), kept until Apply; reset when the scan or the pair changes. A
// row's suggestion (scan: one field proves the pair) is the default.
let _depAmbPick = new Map(), _depAmbPickKey = '';

function _depChildSel(pathKey) {
  if (!_recChildSel[pathKey]) _recChildSel[pathKey] = { push: new Set(), relink: new Set(), overwrite: new Set(), del: new Set() };
  return _recChildSel[pathKey];
}

// ↻ Retry failed (History) lands here: the failed records that are still under
// 🔴 Insert get ticked, the rest are reported — never guessed at.
let _depRetry = null;        // { profileId, byPath: { pathKey: [sourceId] } }
let _depRetryNote = '';

// PURE. Every record the target lacks, per scanned object — the input of "tick
// every insert" (user 2026-10-15: "just select all"): sftkDeployRetryPicks then
// applies the parent rule, so a child whose parent is not on the way stays out.
//   → { pathKey: [sourceId] } for the root and every scanned child
function sftkDeployEveryInsert(scan) {
  const out = {};
  if (!scan) return out;
  const ids = s => (s && s.missingInTarget || []).map(r => r.sourceId).filter(Boolean);
  const root = ids(scan);
  if (root.length) out[''] = root;
  for (const [k, s] of Object.entries((scan && scan.children) || {})) { const l = ids(s); if (l.length) out[k] = l; }
  return out;
}

// PURE. Which of a failed run's records can be ticked on this page right now?
// Only Insert rows, and for a child only rows the page would let the user tick
// (rowState is the classic parent rule). Changed rows are counted, not ticked:
// which org wins a row is the user's call.
function sftkDeployRetryPicks(scan, byPath, rowState) {
  const out = { picks: {}, found: 0, inChanged: 0, inTarget: 0, lost: 0, total: 0 };
  for (const [pathKey, ids] of Object.entries(byPath || {})) {
    const want = new Set(ids || []);
    out.total += want.size;
    const isRoot = pathKey === '';
    const s = isRoot ? scan : (scan && scan.children && scan.children[pathKey]);
    if (!s || !want.size) { out.lost += want.size; continue; }
    const depth = isRoot ? 0 : pathKey.split('.').length;
    let pMissing = new Set(), pExists = new Set();
    if (!isRoot) {
      const pk = depth > 1 ? pathKey.split('.').slice(0, -1).join('.') : null;
      const ps = pk === null ? scan : ((scan.children && scan.children[pk]) || {});
      pMissing = new Set((ps.missingInTarget || []).map(r => r.sourceId));
      pExists  = new Set([...(ps.changed || []).map(r => r.sourceId), ...(ps.identical || []).map(r => r.sourceId)]);
    }
    const ok = r => {
      if (isRoot || typeof rowState !== 'function') return isRoot;
      const st = rowState(r, depth, pMissing, pExists);
      return st !== 'deepblock' && st !== 'untracked';
    };
    const hit = (s.missingInTarget || []).filter(r => want.has(r.sourceId) && ok(r)).map(r => r.sourceId);
    const chg = (s.changed || []).filter(r => want.has(r.sourceId)).length;
    // identical now = written before a stop (or by hand since) — ▶ Continue says so
    const same = (s.identical || []).filter(r => want.has(r.sourceId)).length;
    if (hit.length) out.picks[pathKey] = hit;
    out.found += hit.length; out.inChanged += chg; out.inTarget += same;
    out.lost += Math.max(0, want.size - hit.length - chg);
  }
  return out;
}
function sftkDeployRetryLine(r) {
  if (!r || !r.total) return '';
  return `↻ Retry: ${r.found} of ${r.total} failed record(s) are ticked under 🔴 Insert — check them, then ▶ Run.`
    + (r.inChanged ? ` ${r.inChanged} are under 🟡 Changed — pick which org wins each row.` : '')
    + (r.lost ? ` ${r.lost} are not in an Insert list of the last scan (already in the target, outside the scan, or an object not scanned yet) — 🔄 Refresh state measures again.` : '');
}
// PURE. The sentence for ▶ Continue (a paused or interrupted run): what was
// ticked then is ticked again where the scan still lists it as missing.
function sftkDeployContinueLine(r) {
  if (!r || !r.total) return '';
  const written = r.inTarget || 0, lost = Math.max(0, (r.lost || 0) - written);
  return `▶ Continue: ${r.found} of the ${r.total} record(s) you had ticked are ticked again under 🔴 Insert — the run did not reach them.`
    + (written ? ` ${written} ${written === 1 ? 'is' : 'are'} in the target already (written before the stop) and ${written === 1 ? 'is' : 'are'} left alone.` : '')
    + (r.inChanged ? ` ${r.inChanged} are under 🟡 Changed — pick which org wins each row.` : '')
    + (lost ? ` ${lost} ${lost === 1 ? 'is' : 'are'} not listed by this scan (a record that failed keeps its place under ↻ Retry failed).` : '')
    + ' Check the ticks, then ▶ Deploy.';
}
window.sftkDeployRetry = function (profileId, byPath, targetUrl, mode) {
  _depRetry = { profileId, byPath: byPath || {}, mode: mode || 'retry' };
  _depRetryNote = '';
  window.openReconcile?.(profileId, targetUrl);
};

// PURE. Which of the deployment's two orgs has no live session? `resolve`
// is the page's session resolver (org identity aware); an empty list means
// both orgs can be read right now.
function sftkDeployOffline(p, sessions, resolve) {
  const out = [];
  for (const u of [p && p.sourceOrg, p && p.targetOrg]) {
    if (!u) continue;
    let s = null;
    try { s = resolve ? resolve(u) : null; } catch (_) { s = null; }
    if (!s || !s.sid) out.push(u);
  }
  return out;
}

// ── entry points ──────────────────────────────────────────────────────────
// Classic page → this page (the ✨ button in the Reconcile header).
window.sftkOpenDeployView = function () {
  if (!_reconcileProfile) return;
  _currentView = 'deploy';
  renderReconcile();            // the seam at the top of renderReconcile routes here
};
// This page → classic Reconcile, for this visit only (the switch stays on).
window.sftkDeployToClassic = function () {
  _currentView = 'reconcile';
  renderReconcile();
};

// ▶ on a deployment card opens THIS page while the switch is on — it is the
// merged page. With the switch off, ▶ is exactly what it was.
(function () {
  const classicRun = window.runProfile;
  window.sftkClassicRunProfile = classicRun;
  window.runProfile = function (profileId, targetUrl) {
    if (sftkDeployViewOn() && typeof window.openReconcile === 'function') return window.openReconcile(profileId, targetUrl);
    return typeof classicRun === 'function' ? classicRun.apply(this, arguments) : undefined;
  };
})();

// ── the page ──────────────────────────────────────────────────────────────
// ── Between which orgs ──────────────────────────────────────────────────
// Campaign 4 phase 2 (user 2026-10-01): a deployment is a SHAPE; the orgs are
// picked here, from the orgs open in Chrome, every time. The saved pair is
// only "last used". PURE: tests drive it with a canned open-org list.
//   p     the deployment ({ sourceOrg, targetOrg })
//   open  [{ url, key, label }] — sftkOpenOrgs()
//   label (url) → org label;  key (url) → org key
// → { src, tgt (keys, '' when not open), sources, targets, notes[] }
function sftkDeployOrgPicker(p, open, label, key) {
  const srcKey = p.sourceOrg ? key(p.sourceOrg) : '', tgtKey = p.targetOrg ? key(p.targetOrg) : '';
  const srcOpen = !!srcKey && open.some(o => o.key === srcKey);
  const tgtOpen = !!tgtKey && open.some(o => o.key === tgtKey);
  const src = srcOpen ? srcKey : '';
  const targets = open.filter(o => o.key !== src);
  const tgt = tgtOpen && tgtKey !== src ? tgtKey : '';
  const notes = [];
  if (!open.length) notes.push('No Salesforce org is open in Chrome. Open the two orgs in tabs, then come back — this page reads them live.');
  else if (open.length === 1) notes.push(`Only ${open[0].label} is open in Chrome. Open the other org in a tab to deploy between them.`);
  if ((p.sourceOrg || p.targetOrg) && (!srcOpen || !tgtOpen)) {
    const miss = [!srcOpen && p.sourceOrg ? label(p.sourceOrg) : '', !tgtOpen && p.targetOrg ? label(p.targetOrg) : ''].filter(Boolean);
    notes.push(`Last used: ${label(p.sourceOrg || '') || '—'} → ${label(p.targetOrg || '') || '—'}. ${miss.join(' and ')} ${miss.length > 1 ? 'are' : 'is'} not open — open ${miss.length > 1 ? 'them' : 'it'} in Chrome, or pick other open orgs above.`);
  }
  return { src, tgt, sources: open, targets, notes };
}

function _depOrgPickerHtml(p) {
  const open = (typeof sftkOpenOrgs === 'function') ? sftkOpenOrgs() : [];
  // typeof guards: the runtime test renders this page in a bare VM context
  const m = sftkDeployOrgPicker(p, open, (typeof orgLabel === 'function') ? orgLabel : (u => String(u || '')), (typeof _orgKey === 'function') ? _orgKey : (u => String(u || '')));
  const opt = (o, sel) => `<option value="${esc(o.key)}" ${sel ? 'selected' : ''}>${esc(o.label)}</option>`;
  return `<div class="ds-rec-card ds-dep-orgs">
    <div class="ds-rec-card-hd"><span class="ds-rec-card-ico">🏢</span><span class="ds-rec-card-title">Between which orgs</span><span class="ds-dep-orgs-hint">only orgs open in Chrome are offered · picking writes nothing</span></div>
    <div class="ds-dep-orgs-row">
      <label>From <select id="dsDepSrc" class="ds-select ds-select-sm" aria-label="Source org"><option value="" ${m.src ? '' : 'selected'} disabled>— pick the source —</option>${m.sources.map(o => opt(o, o.key === m.src)).join('')}</select></label>
      <span class="ds-dep-orgs-arrow">→</span>
      <label>To <select id="dsDepTgt" class="ds-select ds-select-sm" aria-label="Target org" ${m.src ? '' : 'disabled'}><option value="" ${m.tgt ? '' : 'selected'} disabled>— pick the target —</option>${m.targets.map(o => opt(o, o.key === m.tgt)).join('')}</select></label>
      <button class="ds-btn ds-btn-xs" id="dsDepSwap" title="Swap source and target" ${m.src && m.tgt ? '' : 'disabled'}>⇄</button>
    </div>
    ${m.notes.map(n => `<div class="ds-dep-orgs-note">${esc(n)}</div>`).join('')}
  </div>`;
}

// The pick: set the pair on the deployment (saved as "last used"), drop any
// selection made against the old pair, and repaint — the page then shows the
// pair's scan if it is fresh, else "Read both orgs now". Writes nothing.
async function _depSetPair(p, srcKey, tgtKey) {
  const open = (typeof sftkOpenOrgs === 'function') ? sftkOpenOrgs() : [];
  const src = open.find(o => o.key === srcKey), tgt = open.find(o => o.key === tgtKey);
  if (src && tgt && src.key === tgt.key) { showToast('Source and target must be two different orgs.', 'warning', 3500); return; }
  if (src) p.sourceOrg = src.url;
  if (tgt) p.targetOrg = tgt.url;
  delete p.sourcePinned; delete p.targetOrgs; delete p._srcCrownMoved;   // old ring fields, retired
  if (src && typeof dsSetPreferredSource === 'function') { try { await dsSetPreferredSource(src.url, { rerender: false }); } catch (_) {} }
  if (!p.ephemeral && typeof storageSaveProfiles === 'function') { try { await storageSaveProfiles(); } catch (_) {} }
  _depForProfile = '';   // a new pair: selections, tab and filter start over
  renderDeploy();
}

function _depWireOrgPicker(p) {
  const cur = () => ({ src: eid('dsDepSrc')?.value || '', tgt: eid('dsDepTgt')?.value || '' });
  eid('dsDepSrc')?.addEventListener('change', () => { const c = cur(); _depSetPair(p, c.src, c.tgt === c.src ? '' : c.tgt); });
  eid('dsDepTgt')?.addEventListener('change', () => { const c = cur(); _depSetPair(p, c.src, c.tgt); });
  eid('dsDepSwap')?.addEventListener('click', () => { const c = cur(); if (c.src && c.tgt) _depSetPair(p, c.tgt, c.src); });
}

async function renderDeploy() {
  const p = _reconcileProfile;
  if (!p) { _currentView = 'profiles'; renderProfiles(); return; }
  sftkRecResetSelectionFor(p);
  if (_depForProfile !== p.id) { _depForProfile = p.id; _depObjPath = ''; _depTab = 'ins'; _depFilter = ''; if (!_depRetry) _depRetryNote = ''; _depLastRunLog = null; }
  // The post-run refresh repaints this page and used to wipe the run log with
  // it (live run 2026-09-22) — keep the last one and show it under the bar.
  // Mid-run the log is LIVE: keep the node itself (the progress handler and
  // runReconcile's log() hold a reference to it) and put it back after the
  // repaint; snapshot only a finished run (user 2026-10-01: a tab switch froze
  // the counter at 2071/5000 while the engine kept writing).
  const liveLog = window._sftkRunActive ? (window._sftkRunLogNode || eid('dsRecProgress')) : null;
  if (!liveLog) { const cur = eid('dsRecProgress'); if (cur && cur.innerText && cur.innerText.trim()) _depLastRunLog = { pid: p.id, html: cur.innerHTML }; }
  if (_depLastRunLog && _depLastRunLog.pid !== p.id) _depLastRunLog = null;

  const objType = p.tree?.objectType || p.tree?.childSObject || '?';
  const scan = p.lastScan;
  const fresh = sftkRecScanFresh(p);
  const srcL = orgLabel(p.sourceOrg || ''), tgtL = orgLabel(p.targetOrg || '');
  // Sessions: said up front, like the classic page's banner — not discovered by
  // a failed click (headless live test 2026-09-22: target closed → the page
  // looked ready and only a toast said otherwise).
  const offline = sftkDeployOffline(p, (typeof _buildAllSessions === 'function') ? _buildAllSessions() : [], u => (typeof _resolveSession === 'function') ? _resolveSession(u, (typeof _buildAllSessions === 'function') ? _buildAllSessions() : []) : null);
  const offlineHtml = offline.length
    ? `<div class="ds-rec-card ds-rec-card-warn"><div class="ds-rec-card-line">⚠ ${offline.map(u => `<b>${esc(orgLabel(u))}</b>`).join(' and ')} ${offline.length > 1 ? 'are' : 'is'} not open in a Chrome tab — this page reads both orgs live, so open ${offline.length > 1 ? 'them' : 'it'} and come back. Nothing here is stale on purpose: what you see below is the last scan, if there is one.</div></div>`
    : '';
  // A run or a rollback that finished after this scan makes its numbers a
  // fiction — refresh once, unasked, exactly as the classic page did (user
  // 2026-09-22: "i rolled back so i need to see two of them now").
  if (fresh && scan.runAt) {
    let staleRun = null;
    try { staleRun = sftkScanStaleRun(_history, p, scan.runAt); } catch (_) { staleRun = null; }
    if (staleRun && _recAutoRefreshKey !== `${p.id}|${staleRun.id}`) {
      _recAutoRefreshKey = `${p.id}|${staleRun.id}`;
      showToast(`↻ ${staleRun.kind === 'rollback' ? 'A rollback' : 'A run'} changed these orgs after the last scan — refreshing state…`, 'info', 3000);
      setTimeout(() => _depRescan(p), 0);
    }
  }

  // A parents-first step was opened FROM another deployment — the way back is
  // to that deployment, not to the list (user 2026-09-21).
  const origin = _depOrigin(p);
  const header = dsViewHeader({
    icon: 'swap',
    back: origin
      ? `<button class="ds-back-link" id="dsDepBackOrigin" title="Return to the deployment this parents-first step was opened from">‹ Back to ${esc(origin.name || p._parentOf.objType)}</button>`
      : `<button class="ds-back-link" id="dsDepBack" title="Back to Data Deployment">‹ Back to deployments</button>`,
    title: `Deploy — <span style="color:var(--brand)">${esc(p.name || objType)}</span>`,
    help: 'Reads both orgs, says what is already in the target, and writes only what you select. Nothing is selected until you select it. More than 5,000 records in one list? Run what is listed, 🔄 Refresh state, repeat.',
    subtitle: `${esc(srcL)} → ${esc(tgtL)} ${prodBadge(p.targetOrg)}${fresh ? ` · scanned ${esc(timeAgo(scan.runAt))}` : ''}${fresh ? ' · <span id="dsDepParentsChip" class="ds-dep-pchip ds-dep-pchip-wait" title="Are the objects this deployment points at aligned between the two orgs? Details in the card below.">⏳ parents…</span>' : ''}`,
    actions: `${p.ephemeral ? `<button class="ds-btn ds-btn-sm ds-btn-primary" data-dsaction="saveEphemeralProfile" title="Keep this as a saved deployment — right now it disappears when you leave this page.">💾 Save as deployment</button>` : ''}
      ${fresh && !p.ephemeral && (scan.missingInTarget || []).length && (scan.onlyInTarget || []).length ? `<button class="ds-btn ds-btn-sm" id="dsDepMatchReview" title="The same record on both sides under different names? Pair a 🔴 Insert row with a 🔵 In target only row once — the pair is remembered for this target.">🔗 Match review</button>` : ''}
      <button class="ds-btn ds-btn-sm" id="dsDepRefresh" ${offline.length ? 'disabled title="Open the org(s) named on the page first"' : ''}>🔄 Refresh state</button>`,
  });

  if (!fresh) {
    setMain(`${header}<div class="ds-dep-page">${_depOrgPickerHtml(p)}
      <div class="ds-rec-card ds-rec-card-warn">
        <div class="ds-rec-card-hd"><span class="ds-rec-card-ico">🔄</span><span class="ds-rec-card-title">${scan ? 'The last scan does not match this deployment any more' : 'Nothing has been read yet'}</span></div>
        <div class="ds-rec-card-line">This page shows what is in <b>${esc(srcL)}</b>, what is already in <b>${esc(tgtL)}</b>, and what differs. It needs one read of both orgs first. Nothing is written.</div>
        <div><button class="ds-btn ds-btn-primary" id="dsDepScan" ${offline.length ? 'disabled title="Open the org(s) named above first"' : ''}>🔄 Read both orgs now</button></div>
      </div>${offlineHtml}</div>`);
    _depWireChrome(p);
    _depWireOrgPicker(p);
    eid('dsDepScan')?.addEventListener('click', () => _depRescan(p));
    return;
  }

  if (_depRetry && (_depRetry.profileId === p.id || _depRetry.profileId === p._ringOf?.profileId)) {
    const rp = sftkDeployRetryPicks(scan, _depRetry.byPath, sftkRecChildRowState);
    for (const [k, ids] of Object.entries(rp.picks)) { const set = k === '' ? _recSel.push : _depChildSel(k).push; ids.forEach(id => set.add(id)); }
    _depRetryNote = _depRetry.mode === 'continue' ? sftkDeployContinueLine(rp) : sftkDeployRetryLine(rp);
    _depRetry = null;
  }
  const objects = sftkDeployObjects(p.tree);
  const objByPath = Object.fromEntries(objects.map(o => [o.pathKey, o.obj]));
  const plan = sftkDeployPlanRows(p.tree, scan, sftkScanBucketInfo, sftkDeployCountLabel);
  if (!objects.some(o => o.pathKey === _depObjPath)) _depObjPath = '';

  // ── plan card ──
  const sum = k => plan.reduce((n, r) => n + ((r.cells[k] && r.cells[k].n) || 0), 0);
  const unscanned = plan.filter(r => !r.scanned);
  // what "✓ Tick every insert" would tick: every missing record of every scanned object, the parent rule applied
  const every = sftkDeployRetryPicks(scan, sftkDeployEveryInsert(scan), sftkRecChildRowState);
  const cell = (r, k) => r.cells[k]
    ? `<td class="ds-dep-num${r.cells[k].n ? ` ds-dep-n-${k}` : ' ds-dep-muted'}" data-dep-obj="${esc(r.pathKey)}" data-dep-tab="${k}" title="${r.cells[k].capped ? `${Number(r.cells[k].n || 0).toLocaleString()} in total — the list shows the first ${Number(r.cells[k].shown || 0).toLocaleString()} of them` : 'Show these records'}">${esc(r.cells[k].text)}</td>`
    : `<td class="ds-dep-num ds-dep-muted">${r.scanned ? '—' : ''}</td>`;
  const planHtml = `
    <div class="ds-rec-card">
      <div class="ds-rec-card-hd"><span class="ds-rec-card-ico">📋</span><span class="ds-rec-card-title">What the two orgs hold</span>
        <span class="ds-rec-card-hint">every number opens its records · nothing is selected until you select it</span></div>
      <div class="ds-dep-tblwrap"><table class="ds-dep-plan">
        <thead><tr><th>Object</th><th class="ds-dep-num" title="Records read from the source for this deployment">In source</th><th class="ds-dep-num" title="Records read from the target">In target</th>
          <th class="ds-dep-num" title="In the source only — inserted when you select them">🔴 Insert</th><th class="ds-dep-num" title="In both orgs with different values — pick a winner per row">🟡 Changed</th>
          <th class="ds-dep-num" title="In the target only — never deleted unless you choose it">🔵 In target only</th><th class="ds-dep-num" title="Child records that exist in both orgs but point at a different parent">⇄ Link differs</th>
          <th class="ds-dep-num" title="In both orgs with equal values — left alone">🟢 Synced</th><th class="ds-dep-num" title="The match key is held more than once where both orgs have it — the scan cannot tell which copy is which, so nothing is deployed for these until you pair each copy with its target or mark it as new">⚠ Needs a decision</th><th></th></tr></thead>
        <tbody>${plan.map(r => `<tr>
          <td><button class="ds-dep-objlink" data-dep-obj="${esc(r.pathKey)}" data-dep-tab="ins" style="padding-left:${r.depth * 16}px">${r.depth ? '↳ ' : ''}${esc(r.obj)}</button>
            <span class="ds-dep-sub">${r.depth ? `under ${esc(r.parentObj || '')}` : 'root'}</span></td>
          <td class="ds-dep-num">${r.src == null ? '' : r.src.toLocaleString()}</td><td class="ds-dep-num">${r.tgt == null ? '' : r.tgt.toLocaleString()}</td>
          ${cell(r, 'ins')}${cell(r, 'chg')}${cell(r, 'ext')}${r.depth ? cell(r, 'link') : '<td class="ds-dep-num ds-dep-muted"></td>'}${cell(r, 'same')}${cell(r, 'amb')}
          <td>${r.depth ? `<button class="ds-btn ds-btn-xs" data-dep-scan="${esc(r.pathKey)}" title="${r.scanned ? 'Read this object again, under the records of the scan above' : 'This object has not been read against this target yet — its records are unknown, not zero'}">${r.scanned ? '🔎 Rescan' : '🔎 Scan'}</button>` : ''}</td>
        </tr>`).join('')}
        ${plan.length > 1 ? `<tr class="ds-dep-total"><td>All objects</td><td></td><td></td>${['ins', 'chg', 'ext', 'link', 'same', 'amb'].map(k => `<td class="ds-dep-num${sum(k) ? ` ds-dep-n-${k}` : ' ds-dep-muted'}">${sum(k).toLocaleString()}</td>`).join('')}<td></td></tr>` : ''}</tbody></table></div>
      ${unscanned.length ? `<div class="ds-rec-card-line"><button class="ds-btn ds-btn-xs ds-btn-primary" id="dsDepScanAll" title="Read every object below against the target, one after the other, parents before their children">🔎 Scan all ${unscanned.length}</button> <b>${unscanned.map(r => esc(r.obj)).join(', ')}</b> not read against this target yet — unknown, not zero. Scan ${unscanned.length === 1 ? 'it' : 'them'} before calling this pair in sync.</div>` : ''}
      ${every.found ? `<div class="ds-rec-card-line"><button class="ds-btn ds-btn-xs" id="dsDepTickAll" title="Tick every record the target lacks, in every object read against it — parents before their children. A child whose parent is not on the way stays out; an object not read stays out. Nothing is written until you press Deploy.">✓ Tick every insert — ${every.found.toLocaleString()} record${every.found === 1 ? '' : 's'} in ${Object.keys(every.picks).length} object${Object.keys(every.picks).length === 1 ? '' : 's'}</button>${unscanned.length ? ' <span class="ds-dep-muted">objects not read yet are not included</span>' : ''}</div>` : ''}
    </div>`;

  // ── notes: the same facts the classic header shows ──
  const notes = [];
  const locked = u => (typeof window.sftkOrgLocked === 'function') && window.sftkOrgLocked(u);
  const srcLocked = locked(p.sourceOrg), tgtLocked = locked(p.targetOrg);
  if (srcLocked) notes.push(`🔒 Writes to <b>${esc(srcL)}</b> are locked — every ← control is off.`);
  if (tgtLocked) notes.push(`🔒 Writes to <b>${esc(tgtL)}</b> are locked — ▶ Deploy will refuse anything that writes into it.`);
  // The full sanctioned wording lives on the truncated tab itself; here, one line.
  if (scan.bucketCapNote) notes.push(`⚠ ${esc(String(scan.bucketCapNote).replace(/^[⚠\s]+/, '').split(/\. /)[0])}. Open that tab for what it means for ▶ Deploy.`);
  if (scan.dupKeys?.rows) notes.push(sftkRecDupsHtml(scan, p));
  // Phase 5 — the ambiguous copies are listed, not guessed: say where.
  { const nAmb = (scan.ambiguous || []).length;
    if (nAmb) notes.push(`⚠ <b>${nAmb.toLocaleString()} ${esc(p.tree?.objectType || p.tree?.childSObject || '')} record(s) are ambiguous</b> — more than one record carries the same name, so the scan cannot tell which is which. Nothing is deployed for them until you choose: open <b>⚠ Needs a decision</b> below and say, per record, 📌 which ${esc(orgLabel(p.targetOrg))} record it is the same as, or ➕ that it is new there.`); }
  // child objects: the same card, without the root's fix buttons (they act on the root's key)
  for (const [pk, cs] of Object.entries(scan.children || {})) {
    if (!cs || !cs.dupKeys || !cs.dupKeys.rows) continue;
    const node = getNodeByPath(p.tree, pk);
    const obj = node ? (node.objectType || node.childSObject) : pk;
    const card = sftkRecDupsHtml(cs, { ...p, tree: node || p.tree }).replace(/<button[^>]*data-rec-dupfix[^>]*>[\s\S]*?<\/button>/g, '');
    if (card) notes.push(`<div class="ds-dep-childdup"><b>${esc(obj)}</b> — ${card}</div>`);
  }
  if (scan.nearMisses) notes.push(`≈ ${scan.nearMisses} record pair(s) almost matched — keys differ only by whitespace or case (marked ≈ on the rows).`);
  if (scan.personContacts) { const l = sftkPaContactsLine(scan.personContacts, srcL, tgtL); if (l) notes.push(esc(l)); }
  for (const w of (scan.warnings || [])) notes.push(`⚠ ${esc(String(w).replace(/^[⚠\s]+/, ''))}`);
  const notesHtml = notes.length ? `<div class="ds-rec-card ds-rec-card-warn"><div class="ds-rec-card-hd"><span class="ds-rec-card-ico">⚠</span><span class="ds-rec-card-title">Worth reading before you deploy</span></div>${notes.map(n => `<div class="ds-rec-card-line">${n}</div>`).join('')}</div>` : '';

  // ── records panel ──
  const cur = objects.find(o => o.pathKey === _depObjPath) || objects[0];
  const curScan = sftkDeployScanFor(scan, cur);
  const tabs = SFTK_DEPLOY_TABS.filter(t => !t.childOnly || cur.depth > 0);
  if (!tabs.some(t => t.k === _depTab)) _depTab = 'ins';
  const tabDef = tabs.find(t => t.k === _depTab);
  const planRow = plan.find(r => r.pathKey === cur.pathKey);
  const recordsHtml = `
    <div class="ds-dep-rec" id="dsDepRecords">
      <div class="ds-dep-objsw"><span class="ds-dep-lbl">Object</span>${objects.map(o => {
        const pr = plan.find(r => r.pathKey === o.pathKey);
        const work = pr && pr.scanned ? ['ins', 'chg', 'ext', 'link', 'amb'].reduce((n, k) => n + ((pr.cells[k] && pr.cells[k].n) || 0), 0) : null;
        return `<button class="ds-dep-objbtn" data-dep-obj="${esc(o.pathKey)}" aria-pressed="${o.pathKey === cur.pathKey}">${o.depth ? '↳ '.repeat(o.depth) : ''}${esc(o.obj)} <small>${work == null ? 'not scanned' : `${work.toLocaleString()} to act on`}</small></button>`;
      }).join('')}</div>
      <div class="ds-dep-tabs" role="tablist">${tabs.map(t => `<button role="tab" data-dep-tab="${t.k}" aria-selected="${t.k === _depTab}">${t.label} <b>${planRow && planRow.cells[t.k] ? esc(planRow.cells[t.k].text) : '—'}</b></button>`).join('')}</div>
      <div id="dsDepList"></div>
    </div>`;

  setMain(`${header}<div class="ds-dep-page">${_depOrgPickerHtml(p)}
    ${p._parentOf?.objType ? `<div class="ds-rec-card ds-dep-journey"><div class="ds-rec-card-line">⛓ Parents-first step: you opened this to align <b>${esc(objType)}</b> before deploying <b>${esc(p._parentOf.objType)}</b>. When it reads in sync — or when there is nothing to align — go back. <button class="ds-btn ds-btn-sm ds-btn-primary" id="dsDepJourneyBack">‹ Back to ${esc(origin ? (origin.name || p._parentOf.objType) : p._parentOf.objType)}</button></div></div>` : ''}
    ${_depRetryNote ? `<div class="ds-rec-card"><div class="ds-rec-card-line">${esc(_depRetryNote)}</div></div>` : ''}
    ${offlineHtml}
    <div id="dsDepTree"></div>
    <div id="dsDepFlowLeft"></div>
    <div id="dsDepRuleLeft"></div>
    ${planHtml}
    <div id="dsDepOrder"></div>
    ${notesHtml}
    ${recordsHtml}
    <div class="ds-dep-actionbar">
      <div class="ds-dep-summary" id="dsDepSummary"></div>
      <span class="ds-dep-engine" title="How records are written. Auto: synchronous Collections calls below the threshold, one async Bulk API 2.0 job at or above it. Saved on the deployment — the classic pages use the same setting.">
        <label class="ds-dep-delmode">Engine
          <select id="dsDepApiMode" class="ds-select ds-select-sm">
            <option value="auto" ${(p.apiMode || 'auto') === 'auto' ? 'selected' : ''}>Auto — Bulk at ≥ ${(Number(p.bulkThreshold) > 0 ? Number(p.bulkThreshold) : 2000).toLocaleString()}</option>
            <option value="sync" ${p.apiMode === 'sync' ? 'selected' : ''}>Synchronous — Collections</option>
            <option value="bulk" ${p.apiMode === 'bulk' ? 'selected' : ''}>Async — Bulk API 2.0 job</option>
          </select></label>
        ${p.apiMode === 'bulk'
          ? `<span class="ds-dep-sub" title="Bulk API 2.0 takes the whole set as one job and splits it into chunks itself — batch size and threads only apply to synchronous Collections calls.">Bulk API 2.0 splits the job itself — no batch size or threads</span>`
          : `<label class="ds-dep-delmode" title="Records per synchronous Collections call (1–200). Smaller batches isolate failures and duck per-transaction trigger limits.${(p.apiMode || 'auto') === 'auto' ? ' In Auto, used below the Bulk threshold.' : ''}">batch size
          <input id="dsDepBatch" class="ds-input ds-input-sm" type="number" min="1" max="200" step="1" style="width:68px;text-align:right" value="${Math.max(1, Math.min(200, Number(p.batchSize) || 200))}"></label>
        <label class="ds-dep-delmode" title="How many Collections batches run in parallel (1–6). Faster at scale, but parallel writes can hit row locks when records share a parent — lower it if you see UNABLE_TO_LOCK_ROW.${(p.apiMode || 'auto') === 'auto' ? ' In Auto, used below the Bulk threshold.' : ''}">threads
          <input id="dsDepThreads" class="ds-input ds-input-sm" type="number" min="1" max="6" step="1" style="width:52px;text-align:right" value="${Math.max(1, Math.min(6, Number(p.threads) || 1))}"></label>`}
      </span>
      <label class="ds-dep-delmode" title="Duplicate rules in the target org. Respect: a record a rule flags is NOT written and the run says so. Bypass: the records are written with Salesforce's duplicate-rule header (they are copies of existing records — a fuzzy name rule would block most of a migration). Bulk API 2.0 cannot bypass rules, so a bypass run uses synchronous Collections calls whatever the Engine setting says. Saved on the deployment.">Duplicate rules
        <select id="dsDepDupRules" class="ds-select ds-select-sm">
          <option value="respect" ${p.duplicateRules === 'bypass' ? '' : 'selected'}>Respect — blocked records fail</option>
          <option value="bypass" ${p.duplicateRules === 'bypass' ? 'selected' : ''}>Bypass for this deployment</option>
        </select></label>
      <label class="ds-dep-delmode" style="cursor:pointer" title="Before anything is written, every object this run can touch is read from the target and kept on this PC as a restore point (the newest 10 runs). History then offers ↩ Roll back. One setting for every deployment.">
        <input type="checkbox" id="dsDepUndoCapture" ${_settings.undoCapture === false ? '' : 'checked'}> 📸 restore point</label>
      <label class="ds-dep-delmode" title="How 🗑 selections are deleted">Delete mode
        <select id="dsDepDeleteMode" class="ds-select ds-select-sm">
          <option value="recycle" ${_recDeleteMode === 'recycle' ? 'selected' : ''}>🗑 Recycle Bin</option>
          <option value="hard" ${_recDeleteMode === 'hard' ? 'selected' : ''}>🔥 Hard delete</option>
        </select></label>
      <span id="dsDepHardNote" class="ds-dep-hardnote" style="${_recDeleteMode === 'hard' ? '' : 'display:none'}">🔥 Hard-deleted records skip the Recycle Bin — <strong>↩ Roll back cannot bring them back</strong>. Only the Recycle Bin mode can be undone.</span>
      <label class="ds-dep-delmode" style="cursor:pointer" title="Off (the default): the run writes with every flow active, as usual. On: the record-triggered flows on this deployment's objects in the target are switched off after the confirmation, and back on at their exact versions when the run ends — even if it fails. Records written while they are off are never processed by them.">
        <input type="checkbox" id="dsDepFlowPause" ${_depFlowPause.on ? 'checked' : ''}> ⏸ pause record-triggered flows</label>
      <label class="ds-dep-delmode" style="cursor:pointer" title="Off (the default): the run writes with every validation rule active, as usual — a record a rule rejects is refused and named. On: the active validation rules on this deployment's objects in the target org are switched off after you confirm and back on as soon as the run ends (finished, failed or stopped). While they are off they are off for EVERY user of that org, and records written meanwhile are never validated later.">
        <input type="checkbox" id="dsDepRulePause" ${_depRulePause.on ? 'checked' : ''}> ⏸ pause validation rules</label>
      <button class="ds-btn ds-btn-lg ds-btn-primary" id="dsRecRunBtn" disabled>▶ Deploy</button>
    </div>
    <div id="dsDepFlowPauseList" class="ds-dep-foot"></div>
    <div id="dsDepRulePauseList" class="ds-dep-foot"></div>
    <div id="dsRecProgress" class="ds-rec-progress"></div></div>
    ${_depLastRunLog ? `<details open class="ds-rec-card ds-dep-lastlog"><summary class="ds-rec-card-title">📜 Last run on this page — the numbers above are already refreshed; History keeps this run too</summary><div class="ds-rec-progress">${_depLastRunLog.html}</div></details>` : ''}`);

  if (liveLog) { const slot = eid('dsRecProgress'); if (slot && slot !== liveLog) slot.replaceWith(liveLog); }
  _depWireChrome(p);
  _depWireOrgPicker(p);
  _depPaintList(p, scan, cur, curScan, tabDef, { srcLocked });
  _depSummary(p, objType, objByPath);

  // plan numbers, chips, object buttons and tabs all navigate the records panel
  document.querySelectorAll('[data-dep-tab]').forEach(el => {
    const go = () => {
      if (el.dataset.depObj != null) _depObjPath = el.dataset.depObj;
      _depTab = el.dataset.depTab; _depFilter = '';
      renderDeploy().then(() => eid('dsDepRecords')?.scrollIntoView({ block: 'nearest' }));
    };
    el.addEventListener('click', go);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
  document.querySelectorAll('.ds-dep-objbtn').forEach(b => b.addEventListener('click', () => { _depObjPath = b.dataset.depObj; _depTab = 'ins'; _depFilter = ''; renderDeploy(); }));
  eid('dsDepScanAll')?.addEventListener('click', () => _depScanAll(p, unscanned.map(r => r.pathKey)));
  // ✓ every insert in one press — the same sets the per-tab "All" buttons fill, object by object
  eid('dsDepTickAll')?.addEventListener('click', () => {
    let n = 0;
    for (const [k, ids] of Object.entries(every.picks)) {
      const set = k === '' ? _recSel.push : _depChildSel(k).push;
      for (const id of ids) { set.add(id); n++; }
    }
    showToast(`✓ ${n.toLocaleString()} record${n === 1 ? '' : 's'} ticked in ${Object.keys(every.picks).length} object${Object.keys(every.picks).length === 1 ? '' : 's'} — untick what should stay out, then Deploy.`, 'success', 5000);
    renderDeploy();
  });
  document.querySelectorAll('[data-dep-scan]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = '⏳ reading…';
    const res = await scanReconcileChild(p, b.dataset.depScan);
    if (res?.error) showToast(`Child scan: ${res.error}`, 'error', 7000);
    else _depObjPath = b.dataset.depScan;
    renderDeploy();
  }));
  eid('dsDepDeleteMode')?.addEventListener('change', e => {
    _recDeleteMode = e.target.value;
    // the consequence is said the moment the mode is picked, not only at the confirmation
    const note = eid('dsDepHardNote'); if (note) note.style.display = _recDeleteMode === 'hard' ? '' : 'none';
    if (_recDeleteMode === 'hard') showToast('🔥 Hard delete: deleted records cannot be brought back by ↩ Roll back — they skip the Recycle Bin.', 'warning', 7000);
  });
  // Engine settings: the same rules and the same save as the classic page.
  eid('dsDepApiMode')?.addEventListener('change', async e => { await sftkRecSetEngine(p, 'apiMode', e.target.value); renderDeploy(); });
  eid('dsDepBatch')?.addEventListener('change', async e => { e.target.value = await sftkRecSetEngine(p, 'batchSize', e.target.value); });
  eid('dsDepThreads')?.addEventListener('change', async e => { e.target.value = await sftkRecSetEngine(p, 'threads', e.target.value); });
  eid('dsDepDupRules')?.addEventListener('change', async e => { await sftkRecSetEngine(p, 'duplicateRules', e.target.value); });
  eid('dsDepUndoCapture')?.addEventListener('change', async e => {
    _settings.undoCapture = !!e.target.checked;
    await storageSaveSettings();
    showToast(_settings.undoCapture
      ? '📸 Restore points on — every data deployment can be rolled back from History'
      : '📸 Restore points off — runs from now on can NOT be rolled back', _settings.undoCapture ? 'info' : 'warning', 4500);
  });
  sftkRecWireDupFix(document, p, scan);
  eid('dsRecRunBtn')?.addEventListener('click', () => _depRun(p, objType,
    { missing: scan.missingInTarget || [], drift: scan.changed || [], extras: scan.onlyInTarget || [] }));
  _depFlowPauseWire(p);
  _depRulePauseWire(p);
  eid('dsDepJourneyBack')?.addEventListener('click', () => _depGoOrigin(p));
  // 🌳 the shape of the deployment, then ⛓ what it points at outside itself
  _depPaintTree(p, scan);
  _depPaintOrder(p, scan);
}

// ── 🌳 The deployment as a tree ───────────────────────────────────────────
// User 2026-09-21: "i see data deployment also as a tool for defining cross
// org data … the user should be presented with the trees also in visual way".
// One node per object: how it hangs under its parent, how records are
// recognised, whether each org can hold an identity, what is left to do, and
// which outside objects it points at.
let _depIdKey = '', _depIdData = null;
window.sftkDeployIdentityChanged = function () { _depIdKey = ''; _depIdData = null; if (_currentView === 'deploy' && _reconcileProfile) _depPaintTree(_reconcileProfile, _reconcileProfile.lastScan); };

async function _depPaintTree(p, scan) {
  const host = eid('dsDepTree');
  if (!host || !scan) return;
  const key = `${p.id}|${sftkOrgKey(p.targetOrg || '')}`;
  const plan = sftkDeployPlanRows(p.tree, scan, sftkScanBucketInfo, sftkDeployCountLabel);
  const order = (_depOrderKey === `${p.id}|${scan.runAt}` && _depOrderData) ? (_depOrderData.objects || []) : [];
  const idOf = pathKey => (_depIdKey === key && _depIdData) ? (_depIdData.objects || []).find(o => o.pathKey === pathKey) : null;
  const srcOrgL = orgLabel(p.sourceOrg || '') || 'source', tgtOrgL = orgLabel(p.targetOrg || '') || 'target';
  const num = v => (v == null ? '?' : Number(v).toLocaleString());
  // The identity field is optional: a card mentions it only where an org HAS
  // it. "✗ ✗" on every card read as two errors per object (user 2026-10-05:
  // "this part seems a bit broken"); the line under the tree says the rest.
  const idLine = id => {
    if (!id || (id.src !== 'yes' && id.tgt !== 'yes')) return '';
    const one = (v, lbl) => `${esc(lbl)} ${v === 'yes' ? '✓' : v === 'no' ? '✗' : '…'}`;
    return `<div class="ds-dtree-line" title="The identity field (SFTK_ID__c) lets a record be recognised exactly, whatever its name">🪪 identity field: ${one(id.src, srcOrgL)} · ${one(id.tgt, tgtOrgL)}</div>`;
  };
  const nodeHtml = (n, parent) => {
    const pr = plan.find(r => r.pathKey === n.pathKey) || null;
    const s = sftkDeployScanFor(scan, n);
    const f = sftkDeployNodeFacts(n, parent ? parent.obj : '', pr);
    const keyFields = s ? ((s.matching && s.matching.fields && s.matching.fields.length) ? s.matching.fields : [s.matchField || 'Name']) : null;
    const needs = (order.find(o => o.pathKey === n.pathKey) || {}).parents || [];
    // a child is counted against its parent's records, so the parent comes first
    const parentCounted = !parent || !!(plan.find(r => r.pathKey === parent.pathKey) || {}).scanned;
    const counts = f.counted
      ? `<div class="ds-dtree-counts"><span><b>${num(f.src)}</b> in ${esc(srcOrgL)}</span><span class="ds-dtree-arrow">→</span><span><b>${num(f.tgt)}</b> in ${esc(tgtOrgL)}</span></div>
         <div class="ds-dtree-todo">${f.inSync ? '<span class="ds-dtree-sync">✓ in sync</span>' : f.work.map(w => `<span class="ds-dtree-chip ds-dtree-chip-${w.k}" data-tree-tab="${w.k}" title="Show these ${esc(n.obj)} records">${w.icon} ${esc(w.text)} ${esc(w.words)}</span>`).join('')}</div>`
      : `<div class="ds-dtree-counts ds-dep-muted">not counted yet — unknown, not zero
           ${parentCounted ? `<button class="ds-btn ds-btn-xs" data-tree-scan="${esc(n.pathKey)}" title="Read ${esc(n.obj)} in both orgs and count it. Nothing is changed.">🔎 Count</button>` : `<span>(count ${esc(parent.obj)} first)</span>`}</div>`;
    return `<li><div class="ds-dtree-node${n.pathKey === _depObjPath ? ' ds-dtree-node-on' : ''}" data-tree-obj="${esc(n.pathKey)}" role="button" tabindex="0" title="Show this object's records below">
        <div class="ds-dtree-name">${esc(n.obj)} <span class="ds-dtree-role"${n.depth ? ` title="Each ${esc(n.obj)} belongs to one ${esc(parent ? parent.obj : '')} through its ${esc(n.field || '?')} field"` : ''}>${esc(f.role)}</span></div>
        ${counts}
        ${keyFields ? `<div class="ds-dtree-line">matched by <b>${esc(keyFields.join(' + '))}</b></div>` : ''}
        ${idLine(idOf(n.pathKey))}
        ${needs.length ? `<div class="ds-dtree-needs" title="Objects outside this deployment that these records look up — see Start with parents first">looks up, outside this deployment: ${needs.map(g => `<span class="ds-dtree-need${g.srcCount === 0 ? ' ds-dtree-need-off' : g.empty ? ' ds-dtree-need-bad' : ''}" title="${g.srcCount === 0 ? 'no record here uses it' : g.empty ? `${esc(tgtOrgL)} has none yet` : 'used by these records'}">${esc(g.refObj)}</span>`).join(' ')}</div>` : ''}
      </div>${n.children.length ? `<ul>${n.children.map(ch => nodeHtml(ch, n)).join('')}</ul>` : ''}</li>`;
  };
  const root = sftkDeployTreeNodes(p.tree);
  const missingTgt = (_depIdKey === key && _depIdData) ? sftkIdCreatable(_depIdData.objects, 'tgt') : [];
  host.innerHTML = `<div class="ds-rec-card">
    <div class="ds-rec-card-hd"><span class="ds-rec-card-ico">📦</span><span class="ds-rec-card-title">This deployment</span>
      <span class="ds-rec-card-hint">every object of this deployment, how it hangs under its parent, and how many records ${esc(orgLabel(p.sourceOrg || ''))} and ${esc(orgLabel(p.targetOrg || ''))} hold — click an object to see its records</span></div>
    <div class="ds-dtree"><ul>${root ? nodeHtml(root, null) : ''}</ul></div>
    <div class="ds-dtree-foot"><button class="ds-btn ds-btn-sm" id="dsDepIdBtn" title="See which objects carry the identity field in each org, create it where it is missing, and stamp matched pairs">🪪 Identity…</button>
      ${missingTgt.length ? `<span class="ds-rec-card-line">Optional. Records are matched by the fields shown on each card. An identity field makes that match exact even when a name changes — ${missingTgt.length} object(s) have none in ${esc(orgLabel(p.targetOrg || ''))} yet (${esc(missingTgt.join(', '))}). 🪪 Identity… can create it.</span>` : ''}</div>
  </div>`;
  host.querySelectorAll('[data-tree-obj]').forEach(el => {
    // a chip opens its own tab of that object; the card opens the object
    const go = tab => { _depObjPath = el.dataset.treeObj; _depTab = tab || 'ins'; _depFilter = ''; renderDeploy().then(() => eid('dsDepRecords')?.scrollIntoView({ block: 'nearest' })); };
    el.addEventListener('click', e => { if (e.target.closest?.('[data-tree-scan]')) return; go(e.target.closest?.('[data-tree-tab]')?.dataset.treeTab); });
    el.addEventListener('keydown', e => { if (e.target !== el) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
  // 🔎 Count on a card: the same child read the plan table's 🔎 Scan does
  host.querySelectorAll('[data-tree-scan]').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    b.disabled = true; b.textContent = '⏳ reading both orgs…';
    let res = null;
    try { res = await scanReconcileChild(p, b.dataset.treeScan); } catch (err) { res = { error: (err && err.message) || String(err) }; }
    if (res && res.error) showToast(`Could not count it: ${res.error}`, 'error', 7000);
    if (_currentView === 'deploy') renderDeploy();
  }));
  eid('dsDepIdBtn')?.addEventListener('click', () => sftkOpenIdentityModal(p, scan));
  if (_depIdKey !== key) {
    _depIdKey = key; _depIdData = null;
    let data = null;
    try { data = await sftkIdStatusFor(p); } catch (_) { data = null; }
    if (_depIdKey !== key) return;
    _depIdData = data || { objects: [] };
    if (_currentView === 'deploy' && _reconcileProfile === p && eid('dsDepTree')) _depPaintTree(p, scan);
  }
}

// ── ⛓ Start with parents first ───────────────────────────────────────────
// User 2026-09-21: "where is the start with parents first. of both root and
// its childs?" The classic advisor speaks only when the ROOT has inserts, and
// only about the ROOT's lookups. This card is always there and covers every
// object. The data comes from studio-reconcile.js (sftkParentOrderFor); this
// function only draws it and feeds the same run gate.
let _depOrderKey = '', _depOrderData = null;
const _depOrderChecked = new Set();
// A parent object is checked for alignment ON LOAD when that is cheap: up to
// this many source records (the scan's own list cap). Above it the page asks.
const SFTK_DEPLOY_AUTOCHECK_MAX = 5000;

// PURE. The one-glance verdict for the card title and the page header.
function sftkDeployParentsVerdict(steps) {
  const s = steps || [];
  if (!s.length) return { cls: 'ok', text: '✓ no outside parents' };
  const n = k => s.filter(x => x.state === k).length;
  const bad = n('empty') + n('behind'), checking = n('checking'), ask = n('large') + n('unknown');
  if (bad) return { cls: 'bad', text: `⚠ ${bad} of ${s.length} parent object(s) not aligned` };
  if (checking) return { cls: 'wait', text: `⏳ checking ${checking} of ${s.length} parent object(s)…` };
  if (ask) return { cls: 'wait', text: `? ${ask} of ${s.length} parent object(s) not checked yet` };
  return { cls: 'ok', text: `✓ all ${s.length} parent object(s) aligned` };
}

// PURE. One numbered step per OUTSIDE object, in first-seen order, naming every
// object.field of the deployment that needs it.
function sftkDeployOrderSteps(objects) {
  const byRef = new Map();
  for (const o of (objects || [])) for (const g of (o.parents || [])) {
    if (!byRef.has(g.refObj)) byRef.set(g.refObj, { refObj: g.refObj, empty: !!g.empty, required: false, neededBy: [], forObj: o.obj,
      srcCount: (g.srcCount === undefined ? null : g.srcCount) });
    const s = byRef.get(g.refObj);
    s.neededBy.push({ obj: o.obj, field: g.field, required: !!g.required });
    if (g.required) s.required = true;
  }
  return [...byRef.values()];
}

async function _depPaintOrder(p, scan) {
  const host = eid('dsDepOrder');
  if (!host) return;
  const key = `${p.id}|${scan.runAt}`;
  const tgtL = orgLabel(p.targetOrg || '');
  if (_depOrderKey !== key || !_depOrderData) {
    host.innerHTML = `<div class="ds-rec-card"><div class="ds-rec-card-hd"><span class="ds-rec-card-ico">⛓</span><span class="ds-rec-card-title">Start with parents first</span>
      <span class="ds-rec-card-hint">⏳ reading what each object points at — one describe per object, one 1-row probe per parent object</span></div></div>`;
    _depOrderKey = key; _depOrderData = null;
    let data = null;
    try { data = await sftkParentOrderFor(p); } catch (_) { data = null; }
    if (_depOrderKey !== key) return;          // a newer scan took over while we were reading
    _depOrderData = data || { offline: false, objects: [], failed: true };
  }
  const h = eid('dsDepOrder');
  if (!h) return;                               // the user left the page
  if (eid('dsDepTree') && !eid('dsDepTree').dataset.needs) { eid('dsDepTree').dataset.needs = '1'; _depPaintTree(p, scan); }
  const data = _depOrderData;
  const objects = data.objects || [];
  const chain = sftkDeployObjects(p.tree).map(o => esc(o.obj)).join(' → ');
  if (data.offline || data.failed) {
    h.innerHTML = `<div class="ds-rec-card ds-rec-card-warn"><div class="ds-rec-card-hd"><span class="ds-rec-card-ico">⛓</span><span class="ds-rec-card-title">Start with parents first</span></div>
      <div class="ds-rec-card-line">${data.offline ? 'Both orgs must be open and signed in to check which parent objects these records point at.' : 'Could not read the objects’ lookups — 🔄 Refresh state to try again.'} Until then the order is unknown, not fine.</div></div>`;
    return;
  }
  const steps = sftkDeployOrderSteps(objects).map(s => {
    const vd = _parentSyncVerdicts[sftkParentSyncKey(p.sourceOrg, p.targetOrg, s.refObj)];
    let state = sftkParentStepState(s, vd);
    // Checked on load when it is cheap; a big object waits for a click.
    if (state === 'unknown' && !_depOrderChecked.has(`${key}|${s.refObj}`)) {
      state = (s.srcCount != null && s.srcCount <= SFTK_DEPLOY_AUTOCHECK_MAX) ? 'checking' : 'large';
    }
    return { ...s, vd, state };
  });
  const verdict = sftkDeployParentsVerdict(steps);
  const chip = eid('dsDepParentsChip');
  if (chip) { chip.textContent = verdict.text; chip.className = `ds-dep-pchip ds-dep-pchip-${verdict.cls}`; }
  // feed the SAME run gate the classic advisor feeds (root inserts only)
  const rootObj = objects.find(o => o.depth === 0);
  sftkParentGapSetGate(p, scan, rootObj ? rootObj.parents : [], (scan.missingInTarget || []).length > 0);

  const settled = s => s.state === 'done' || s.state === 'notneeded';
  const nextIdx = steps.findIndex(s => !settled(s));
  const anyDoomed = steps.some(s => s.state === 'empty' && s.required);
  const anyEmpty = steps.some(s => s.state === 'empty');
  const need = s => s.neededBy.map(n => `${esc(n.obj)}.${esc(n.field)}${n.required ? ' <b>(required)</b>' : ''}`).join(' · ');
  const stepHtml = (s, i) => {
    const isNext = i === nextIdx;
    const btn = (label, primary) => `<button class="ds-btn ds-btn-xs${primary ? ' ds-btn-primary' : ''}" data-dep-gap="${esc(s.refObj)}" data-dep-gap-for="${esc(s.forObj)}" title="Scans ${esc(s.refObj)} across this org pair and opens it here — align it, then the banner brings you back.">${label}</button>`;
    const status = s.state === 'notneeded' ? `<span class="ds-psync ds-psync-ok" title="${esc(orgLabel(p.sourceOrg || ''))} holds no ${esc(s.refObj)} records, so none of these records can point at one.">✓ not needed — the source has none</span>`
      : s.state === 'large' ? `<span class="ds-lkp-hint">${s.srcCount == null ? 'size unknown' : `${s.srcCount.toLocaleString()} records`} — too large to check on its own</span> ${btn('🔍 Check now', isNext)}`
      : s.state === 'done' ? `<span class="ds-psync ds-psync-ok">✓ in sync${s.vd ? ` · ${esc(timeAgo(s.vd.at))}` : ''}</span> ${btn('⚖ Open', false)}`
      : s.state === 'empty' ? `<span class="ds-psync ds-psync-bad">${esc(tgtL)} has none at all${s.required ? ' — and a field above requires it' : ''}</span> ${btn(`➕ Deploy ${esc(s.refObj)} first`, true)}`
      : s.state === 'checking' ? `<span class="ds-lkp-hint">⏳ checking alignment…</span>`
      : s.state === 'behind' ? `<span class="ds-psync ds-psync-bad">🔴 ${s.vd.missing} missing · 🟡 ${s.vd.changed} changed · ${esc(timeAgo(s.vd.at))}</span> ${btn('⚖ Open & fix', isNext)}`
      : `<span class="ds-lkp-hint">couldn't check automatically</span> ${btn('🔍 Compare & fix', false)}`;
    return `<div class="ds-ordstep${settled(s) ? ' ds-ordstep-done' : ''}${isNext ? ' ds-ordstep-next' : ''}">
      <span class="ds-ordstep-num">${i + 1}</span>
      <span class="ds-dep-ordwhat"><strong>${esc(s.refObj)}</strong> <span class="ds-lkp-hint">needed by ${need(s)}</span></span>
      ${status}${isNext ? '<span class="ds-ordstep-arrow">← next</span>' : ''}
    </div>`;
  };
  const allDone = nextIdx === -1;
  h.innerHTML = `<div class="ds-rec-card ${anyDoomed ? 'ds-rec-card-bad' : anyEmpty ? 'ds-rec-card-warn' : allDone ? 'ds-rec-card-good' : ''}">
    <div class="ds-rec-card-hd"><span class="ds-rec-card-ico">⛓</span>
      <span class="ds-rec-card-title">${anyDoomed ? '⛔ Stop — some inserts here fail until their parents exist · ' : ''}Start with parents first</span>
      <span class="ds-dep-pchip ds-dep-pchip-${verdict.cls}">${esc(verdict.text)}</span>
      <span class="ds-rec-card-hint">every object in this deployment, and what it points at outside it — those records must be in ${esc(tgtL)} first, lookups land on them by name</span></div>
    <div class="ds-rec-card-body">
      ${steps.length ? steps.map(stepHtml).join('') : `<div class="ds-ordstep ds-ordstep-done"><span class="ds-ordstep-num">✓</span><span class="ds-dep-ordwhat">None of ${chain} points at an object outside this deployment — there is nothing to deploy first.</span></div>`}
      <div class="ds-ordstep${allDone ? ' ds-ordstep-next' : ''}">
        <span class="ds-ordstep-num">${steps.length + 1}</span>
        <span class="ds-dep-ordwhat"><strong>${chain}</strong> <span class="ds-lkp-hint">— this deployment, in this order: a parent object goes in before the object under it</span></span>
        ${allDone ? '<span class="ds-psync ds-psync-ok">parents ready ✓</span><span class="ds-ordstep-arrow">← next</span>' : '<span class="ds-lkp-hint">waits for the steps above</span>'}
      </div>
    </div></div>`;
  h.querySelectorAll('[data-dep-gap]').forEach(b => b.addEventListener('click', async () => {
    const label = b.textContent; b.disabled = true; b.textContent = '⏳ scanning…';
    if (!(await sftkOpenParentsFirst(p, b.dataset.depGap, b.dataset.depGapFor))) { b.disabled = false; b.textContent = label; }
  }));
  // background alignment check, one attempt per parent per scan, then repaint
  const toCheck = steps.filter(s => s.state === 'checking');
  if (toCheck.length) {
    (async () => {
      for (const s of toCheck) { _depOrderChecked.add(`${key}|${s.refObj}`); await sftkParentVerifyOne(p, s.refObj); }
      if (_depOrderKey === key && _currentView === 'deploy' && _reconcileProfile === p) _depPaintOrder(p, scan);
    })();
  }
}

// ⚠ Needs a decision — the tab explains itself and makes each group DECIDABLE
// (user 2026-10-01: "what these means? insert as new, pair, etc."; 2026-10-03:
// "we need to make the ambigious page more understandble"). The scan says which
// compared field tells the copies apart (row.tell, scan.ambiguousCand) and
// suggests the pairs one field proves (row.suggest); the page groups by name
// and asks ONE question per record.
//
// 2026-10-05 (user, on this tab): "i would like to be able to also fix them one
// by one. also the options … are not clear. i think the user should select
// which record to keep and which of the dupes to delete. no?"
//   • one by one — every group has its own 📌 Apply this one: the decision is
//     remembered at once (match memory) and both orgs are read again ONCE,
//     when the user asks, not after every group;
//   • the options — each answer is a sentence that carries the values of the
//     record it means ("Same record as #2 (Phone: 555-9 · Paris)"), listed in
//     the open, not behind a dropdown of "#1 / #2";
//   • duplicates — this tab decides which record IS which; it never deletes.
//     The copy that is left over is then listed under 🔵 Only in the target,
//     where deleting it is already offered. The intro says so.
function _depAmbIntro(p, isRoot, s) {
  const srcL = esc(orgLabel(p.sourceOrg)), tgtL = esc(orgLabel(p.targetOrg));
  const adv = (s && s.ambiguousAdvice && s.ambiguousAdvice[0]) || null;
  const nSug = ((s && s.ambiguous) || []).filter(r => r && r.suggest).length;
  return `<div class="ds-dep-note ds-dep-amb-intro">
    <div><b>Why these records are here.</b> Each one shares its name with another record, so the name alone cannot say which record in ${srcL} is which record in ${tgtL}. Nothing here is deployed until you decide.</div>
    ${isRoot ? `<div><b>What to do.</b> For each ${srcL} record, say which ${tgtL} record it is — or that it is not there yet. The values next to each record are the ones that differ between the copies. Decide one name at a time with <b>📌 Apply this one</b>: the answer is remembered for ${tgtL} right away. When you are done, the button above reads both orgs again, once, and the records move to their own tabs.</div>
    <div><b>Two copies of the same thing?</b> This tab never deletes. Say which copy is the same record; after the re-read the copy that is left over is listed under 🔵 Only in ${tgtL}, where you can tick it for deletion.</div>
    ${adv && nSug ? `<div>💡 <b>${nSug.toLocaleString()} are already filled in.</b> Where exactly one copy on each side has the same <b>${esc(adv.field)}</b>, that pair is suggested below — check them, then apply. To never be asked again, add ${esc(adv.field)} to how records are recognised (✏ Edit → Records → Matching).</div>` : ''}`
    : `<div>For a child object the choice cannot be made by hand: give it a second match field (✏ Edit → Records → Matching) so its records can be told apart by more than the name, then scan again.</div>`}
  </div>`;
}

// The groups: one block per shared name — the target records it could be
// (numbered, with the values that tell them apart), then each source record
// with ONE question, its answers written out. pickOf(r) = the answer on
// screen; memOf(r) = the answer already remembered ('' when none).
const SFTK_AMB_RADIO_MAX = 6;   // more candidates than this: a dropdown, same sentences
function _depAmbGroupsHtml(p, rows, s, pickOf, keyOf, memOf) {
  const srcL = esc(orgLabel(p.sourceOrg)), tgtL = esc(orgLabel(p.targetOrg));
  const candTell = (s && s.ambiguousCand) || {};
  const url = (org, id) => `${esc(String(org || '').replace(/\/$/, ''))}/lightning/r/${esc(id)}/view`;
  const tellText = tell => (tell || []).filter(x => x && x[1] !== '').map(x => `${x[0]}: ${x[1]}`).join(' · ');
  const chips = tell => { const t = (tell || []).filter(x => x && x[1] !== ''); return t.length ? t.map(x => `<span class="ds-amb-chip" title="${esc(x[0])}">${esc(x[0])}: <b>${esc(x[1])}</b></span>`).join('') : '<span class="ds-dep-muted">no compared field differs between the copies — open the record to tell</span>'; };
  const groups = new Map();
  for (const r of rows) { const k = keyOf(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  let html = '';
  for (const [k, rs] of groups) {
    const cands = rs[0].candidates || [];
    const nSrc = (rs[0].twins || []).length + 1;
    const radios = cands.length <= SFTK_AMB_RADIO_MAX;
    const pending = rs.some(r => pickOf(r) !== memOf(r));
    const kept = rs.some(r => memOf(r));
    // every answer as one plain sentence — the same words in the list and in the dropdown
    const answers = r => [
      ...cands.map((t, i) => ({ v: t, text: `Same record as #${i + 1} in ${orgLabel(p.targetOrg)}${tellText(candTell[t]) ? ` (${tellText(candTell[t])})` : ''}${r.suggest === t ? ` — suggested: same ${r.suggestBy || 'value'}` : ''}` })),
      { v: '__new__', text: `Not in ${orgLabel(p.targetOrg)} yet — create it there as a new record` },
      { v: '', text: 'Not decided — it stays out of the deployment' },
    ];
    html += `<div class="ds-amb-group">
      <div class="ds-amb-ghd"><b>${esc(k)}</b><span class="ds-dep-muted">${nSrc} in ${srcL} · ${cands.length} in ${tgtL}</span><span class="ds-dep-sp"></span>
        ${kept && !pending ? '<span class="ds-amb-done">✓ remembered — takes effect when both orgs are read again</span>' : ''}
        <button class="ds-btn ds-btn-xs" data-dep-amb-one="${esc(k)}" ${pending ? '' : 'disabled'} title="Remember the answers of this name now. Both orgs are read again later, once.">📌 Apply this one</button></div>
      <div class="ds-amb-side"><div class="ds-amb-sidelbl">in ${tgtL} — the records it could be${cands.length > 1 ? ` <button class="ds-btn ds-btn-xs ds-amb-merge" data-dep-amb-merge="tgt" data-dep-amb-key="${esc(k)}" title="Merge these records into one: you choose which one stays and which values it keeps; the others are merged into it and deleted.">🔀 Merge these ${cands.length} into one</button>` : ''}</div>${cands.map((t, i) => `<div class="ds-amb-cand"><span class="ds-amb-n">#${i + 1}</span>${chips(candTell[t])}<a class="ds-dep-open" href="${url(p.targetOrg, t)}" target="_blank" rel="noopener" title="Open this ${tgtL} record">open ↗</a></div>`).join('')}</div>
      <div class="ds-amb-side"><div class="ds-amb-sidelbl">in ${srcL} — which ${tgtL} record is each one?${nSrc > 1 ? ` <button class="ds-btn ds-btn-xs ds-amb-merge" data-dep-amb-merge="src" data-dep-amb-key="${esc(k)}" title="Merge these records into one: you choose which one stays and which values it keeps; the others are merged into it and deleted.">🔀 Merge these ${nSrc} into one</button>` : ''}</div>${rs.map(r => { const pick = pickOf(r); const ans = answers(r); return `<div class="ds-amb-src">${chips(r.tell)}<a class="ds-dep-open" href="${url(p.sourceOrg, r.sourceId)}" target="_blank" rel="noopener" title="Open this ${srcL} record">open ↗</a>
          ${radios ? '' : `<select class="ds-select ds-select-sm ds-amb-sel" data-dep-amb-sel="${esc(r.sourceId)}" aria-label="Which ${tgtL} record is this">
            ${[ans[ans.length - 1], ...ans.slice(0, -1)].map(a => `<option value="${esc(a.v)}" ${pick === a.v ? 'selected' : ''}>${esc(a.text)}</option>`).join('')}
          </select>`}</div>
          ${radios ? `<div class="ds-amb-opts" role="radiogroup" aria-label="Which ${tgtL} record is this">${ans.map(a => `<label class="ds-amb-opt${pick === a.v ? ' ds-amb-opt-on' : ''}"><input type="radio" name="amb_${esc(r.sourceId)}" data-dep-amb-sel="${esc(r.sourceId)}" value="${esc(a.v)}" ${pick === a.v ? 'checked' : ''}><span>${esc(a.text)}</span></label>`).join('')}</div>` : ''}`; }).join('')}</div>
    </div>`;
  }
  return html;
}

// The deployment a parents-first step was opened FROM: the saved one by id,
// else the unsaved object the step kept (a pair clone / ring ⚖ origin is not
// in _profiles — the old lookup found nothing and the button did nothing).
function _depOrigin(p) {
  const id = p._parentOf?.profileId;
  if (!id) return null;
  return _profiles.find(x => x.id === id) || p._parentOf.profile || null;
}
// Go back to it — never a dead click: saved → the normal open; unsaved → the
// kept object with its scan; gone → the deployments list.
function _depGoOrigin(p) {
  const orig = _depOrigin(p);
  if (orig && _profiles.includes(orig)) return window.openReconcile(orig.id);
  if (orig) {
    _reconcileProfile = orig;
    _currentView = (typeof sftkDeployViewOn === 'function' && sftkDeployViewOn()) ? 'deploy' : 'reconcile';
    renderReconcile();
    return;
  }
  _currentView = 'profiles'; renderProfiles();
}

function _depWireChrome(p) {
  eid('dsDepBack')?.addEventListener('click', () => { _currentView = 'profiles'; renderProfiles(); });
  eid('dsDepBackOrigin')?.addEventListener('click', () => _depGoOrigin(p));
  eid('dsDepRefresh')?.addEventListener('click', () => _depRescan(p));
  eid('dsDepMatchReview')?.addEventListener('click', () => openMatchReview(p));
}

// ── 🔀 Merge the copies of one name into one of them ─────────────────────────
// (user 2026-10-11: "maybe we can provide merging mechanism? so the user ends up
// with a unique data and without dupes" / "It's only merge into this one. User
// needs to be able to select the merged values"; shipped in 1.0 on 2026-10-12.)
// From ⚠ Needs a decision, on the side that holds more than one record of the
// name: the copies are read live, the user picks the record that stays and, for
// every field that differs, the value it keeps; after the shared confirmation
// the copies are merged into it (sftk-merge.js), the memory forgets the copies
// that are gone, and both orgs are read again — the name is unique then.
async function _depMergeCopies(p, side, name, ids) {
  const orgUrl = side === 'src' ? p.sourceOrg : p.targetOrg;
  const obj = (p.tree && p.tree.objectType) || '';
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!obj || uniq.length < 2) return showToast('Nothing to merge: this name has one record on that side.', 'info', 5000);
  if (!uniq.every(sftkMergeIdOk)) return showToast('These records could not be merged: an id is not a Salesforce id.', 'error', 6000);
  const sess = await getOrgSession(orgUrl);
  if (!sess) return showToast(`No open session for ${orgLabel(orgUrl)} — open it in a Salesforce tab first.`, 'error', 7000);
  showToast(`Reading the ${uniq.length} copies of "${name}" in ${orgLabel(orgUrl)}…`, 'info', 3000);
  const desc = await describe(obj, sess.orgUrl, sess.sid);
  if (!desc || !Array.isArray(desc.fields)) return showToast(`${obj} could not be described in ${orgLabel(orgUrl)}.`, 'error', 7000);
  const read = await sftkMergeRead({ send: sendBg, orgUrl: sess.orgUrl, sid: sess.sid, obj, fields: desc.fields, ids: uniq });
  if (read.error) return showToast(`The copies could not be read: ${read.error}`, 'error', 8000);
  const recs = read.records;
  if (recs.length < 2) return showToast(`Only ${recs.length} of the ${uniq.length} copies could be read — one is gone already? Read both orgs again.`, 'error', 8000);
  const diff = sftkMergeDiff(desc.fields, recs);
  const native = sftkMergeNative(obj);
  const rels = native ? [] : sftkMergeChildPlan(desc.childRelationships);
  const label = desc.label || obj, plural = desc.labelPlural || `${label}s`;
  const org = orgLabel(orgUrl);
  const when = iso => String(iso || '').slice(0, 10);
  const fmt = v => esc(sftkMergeValueText(v));
  const base = String(orgUrl || '').replace(/\/$/, '');
  const head = recs.map((r, i) => `<th class="ds-merge-col${i === 0 ? ' ds-merge-keep' : ''}" data-merge-col="${i}"><label class="ds-merge-keeplbl"><input type="radio" name="dsMergeKeep" value="${i}" ${i === 0 ? 'checked' : ''}> Keep copy ${i + 1}</label><div class="ds-dep-muted"><a href="${esc(base)}/lightning/r/${esc(r.Id)}/view" target="_blank" rel="noopener">${esc(r.Id)}</a> · created ${esc(when(r.CreatedDate))} · changed ${esc(when(r.LastModifiedDate))}</div></th>`).join('');
  // every differing field: one radio per copy, and a third — a value typed here (user 2026-10-14)
  const hint = t => t === 'date' ? 'YYYY-MM-DD' : t === 'datetime' ? '2026-10-14T09:30:00Z' : t === 'boolean' ? 'true / false' : t === 'reference' ? 'a Salesforce id' : 'type a value…';
  const rows = diff.differ.map(f => `<tr data-merge-field="${esc(f.name)}" data-merge-type="${esc(f.type)}"><th scope="row">${esc(f.label)}<div class="ds-dep-muted">${esc(f.name)}</div></th>${f.values.map((v, i) => `<td class="ds-merge-col${i === 0 ? ' ds-merge-keep' : ''}" data-merge-col="${i}"><label class="ds-merge-val"><input type="radio" name="dsMergeF_${esc(f.name)}" value="${i}" ${i === 0 ? 'checked' : ''}> <span>${fmt(v)}</span></label></td>`).join('')}<td class="ds-merge-typed">${sftkMergeTypable(f.type) ? `<label class="ds-merge-val"><input type="radio" name="dsMergeF_${esc(f.name)}" value="custom"> <input type="text" class="ds-input ds-input-sm" data-merge-custom="${esc(f.name)}" placeholder="${esc(hint(f.type))}" aria-label="A value typed for ${esc(f.label)}"></label>` : ''}</td></tr>`).join('');
  const sameRows = (diff.sameList || []).map(f => `<tr><th scope="row">${esc(f.label)}<div class="ds-dep-muted">${esc(f.name)}</div></th><td colspan="${recs.length + 1}">${fmt(f.value)}</td></tr>`).join('');
  const table = `<div class="ds-merge-wrap"><table class="ds-merge-table"><thead><tr><th>Which record stays?</th>${head}<th class="ds-merge-typed">or a value you type</th></tr></thead><tbody>${rows || `<tr><td colspan="${recs.length + 2}" class="ds-dep-muted">Every writable field holds the same value in all copies — nothing to choose.</td></tr>`}</tbody></table></div>
    <div class="ds-dep-muted ds-merge-same">${diff.differ.length ? 'For each field above, tick the value the record that stays keeps (its own values are ticked), or type one. ' : ''}${diff.same.toLocaleString()} writable field${diff.same === 1 ? ' is' : 's are'} the same in every copy.</div>
    ${sameRows ? `<details class="ds-merge-samefold"><summary>Show the ${diff.same.toLocaleString()} field${diff.same === 1 ? '' : 's'} that ${diff.same === 1 ? 'is' : 'are'} the same</summary><div class="ds-merge-wrap"><table class="ds-merge-table">${sameRows}</table></div></details>` : ''}`;
  const others = recs.length === 2 ? 'the other copy is' : `the other ${recs.length - 1} copies are`;
  const stakes = native
    ? `<b>One record stays; ${others} merged into it and deleted.</b> <b>The Toolkit cannot undo a merge.</b>` +
      `<div class="sftk-cf-plan"><ol class="sftk-cf-rows"><li><b>Salesforce</b><span>Merges ${esc(plural)} itself: related records, activities, files, notes and feed move to the record that stays</span></li></ol></div>`
    : `<b>One record stays; ${others} deleted.</b> <b>The Toolkit cannot undo a merge.</b>` +
      `<div class="sftk-cf-plan"><ol class="sftk-cf-rows">` +
      `<li><b>No merge</b><span>Salesforce has no merge for ${esc(plural)}, so the Toolkit does it by hand</span></li>` +
      `<li><b>Moves</b><span>What hangs under a copy goes to the record that stays, one relationship at a time (${rels.length.toLocaleString()} relationship${rels.length === 1 ? '' : 's'})</span></li>` +
      `<li><b>Deletes</b><span>A copy only when everything under it moved</span></li>` +
      `<li><b>Refusal</b><span>A relationship that refuses stops the merge before that copy is deleted</span></li>` +
      `<li><b>Goes with it</b><span>History, sharing and feed rows of a copy</span></li></ol>` +
      (rels.length ? `<details class="sftk-cf-more"><summary>The relationships (${rels.length.toLocaleString()})</summary>${esc(rels.map(r => r.child).join(', '))}</details>` : '') + `</div>`;
  const choice = await new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    sftkDialog({
      icon: '🔀', title: `Merge the ${recs.length} copies of "${name}" in ${org}`, sev: 'red',
      facts: [label, `${recs.length} copies`, `${diff.differ.length.toLocaleString()} field${diff.differ.length === 1 ? '' : 's'} differ`, native ? 'Salesforce merge' : 'moved, then deleted'],
      stakes, bodyHtml: table,
      note: 'The copies go to the Recycle Bin for 15 days; restoring them there does not take back what moved to the record that stays.',
      actions: [{ id: 'dsMergeCancel', label: 'Cancel' }, { id: 'dsMergeGo', label: '🔀 Merge into the chosen record…', kind: 'danger' }],
      onRender: () => {
        const box = eid('dsModalBox');
        if (!box) return finish(null);
        const paint = () => {
          const keep = Number((box.querySelector('input[name="dsMergeKeep"]:checked') || {}).value || 0);
          box.querySelectorAll('[data-merge-col]').forEach(el => el.classList.toggle('ds-merge-keep', Number(el.dataset.mergeCol) === keep));
        };
        box.querySelectorAll('input[name="dsMergeKeep"]').forEach(r => r.addEventListener('change', () => {
          // the record that stays keeps its own values until the user says otherwise
          box.querySelectorAll('tr[data-merge-field]').forEach(tr => { const x = tr.querySelector(`input[value="${r.value}"]`); if (x) x.checked = true; });
          paint();
        }));
        // typing in a row's box is choosing it
        box.querySelectorAll('input[data-merge-custom]').forEach(inp => inp.addEventListener('input', () => { const r = inp.closest('tr')?.querySelector('input[type="radio"][value="custom"]'); if (r) r.checked = true; }));
        eid('dsMergeCancel')?.addEventListener('click', () => { closeModal(); finish(null); });
        eid('dsMergeGo')?.addEventListener('click', () => {
          const keep = Number((box.querySelector('input[name="dsMergeKeep"]:checked') || {}).value || 0);
          const picks = {};
          box.querySelectorAll('tr[data-merge-field]').forEach(tr => {
            const x = tr.querySelector('input[type="radio"]:checked'); if (!x) return;
            picks[tr.dataset.mergeField] = x.value === 'custom' ? { custom: (tr.querySelector('input[data-merge-custom]') || {}).value || '' } : Number(x.value);
          });
          // a typed value that does not fit its field is said now, in the dialog, not after it closed
          const bad = sftkMergeChosen(diff, picks, keep).errors;
          if (bad.length) { showToast(`${bad.map(b => `${b.label}: needs ${b.error}`).join(' · ')}`, 'error', 7000); return; }
          closeModal(); finish({ keep, picks });
        });
        const mo = new MutationObserver(() => { if (!box.querySelector('.sftk-cf')) { mo.disconnect(); finish(null); } });
        mo.observe(box, { childList: true });
      },
    });
  });
  if (!choice) return;
  const survivor = recs[choice.keep], dups = recs.filter((_, i) => i !== choice.keep);
  const chosen = sftkMergeChosen(diff, choice.picks, choice.keep);
  const gate = await sftkOrgWriteGate(orgUrl, _orgs);
  const tell = r => diff.differ.slice(0, 3).map(f => `${f.label}: ${sftkMergeValueText(r[f.name])}`).join(' · ');
  const ok = await sftkConfirmDestructive({
    icon: '🔀', title: `Merge ${dups.length === 1 ? 'one copy' : `${dups.length} copies`} of "${name}" into ${survivor.Id} in ${org}`,
    items: [
      ...dups.map(r => ({ label: `${label} ${r.Id} — merged into ${survivor.Id} and deleted`, sub: tell(r) })),
      ...chosen.changes.map(ch => ({ label: `${ch.label}: ${sftkMergeValueText(ch.from)} → ${sftkMergeValueText(ch.to)}`, sub: ch.typed ? 'typed by you — written to the record that stays' : 'written to the record that stays' })),
    ],
    reversibility: 'permanent',
    revOverride: { html: '⛔ <strong>Cannot be undone</strong> — the Toolkit offers no undo for a merge.' +
      '<div class="sftk-cf-plan"><ol class="sftk-cf-rows">' +
      '<li><b>Recycle Bin</b><span>The copies go there, but restoring them does not take back what moved to the record that stays</span></li></ol></div>', needsCheckbox: true },
    confirmLabel: '🔀 Merge now',
    production: gate.production ? { label: gate.label } : null,
    undoHint: native ? 'Salesforce performs the merge (Database.merge); the result is verified by re-reading the org.' : 'Each relationship is moved and re-counted before a copy is deleted.',
  });
  if (!ok) return;
  const journal = sftkHistoryBegin({ tool: 'Merge', title: `🔀 ${label} "${name}": ${dups.length === 1 ? 'one copy' : `${dups.length} copies`} merged into ${survivor.Id} in ${org}`, orgUrl });
  let res = null;
  try {
    res = await sftkMergeRun({ send: sendBg, orgUrl: sess.orgUrl, sid: sess.sid, obj, label, name, survivorId: survivor.Id, dupIds: dups.map(r => r.Id), body: chosen.body, native, rels, journal });
  } finally {
    await sftkHistoryEnd(journal, {
      undo: { none: 'a merge cannot be undone by the Toolkit — the copies are in the Recycle Bin, but restoring them does not take back what moved to the record that stays' },
      errors: res && !res.ok ? [res.text] : [],
    });
  }
  // the memory: a copy that is gone can no longer be an answer
  const gone = new Set((res && res.deleted) || []);
  if (gone.size && !p.ephemeral) {
    const mem = ((_profiles.find(x => x.id === p.id) || p).matchMemory || {})[_orgKey(p.targetOrg || '')] || {};
    const forget = side === 'src' ? [...gone] : Object.entries(mem).filter(([, t]) => gone.has(t)).map(([s]) => s);
    if (forget.length) await window.sftkForgetPairs?.(p.id, p.targetOrg, forget);
  }
  for (const id of gone) _depAmbPick.delete(id);
  showToast(res.text, res.ok ? 'success' : 'error', res.ok ? 7000 : 12000);
  await _depRescan(p);
}

async function _depRescan(p) {
  const b = eid('dsDepRefresh') || eid('dsDepScan');
  if (b) { b.disabled = true; b.textContent = '⏳ reading both orgs…'; }
  // same reset the classic 🔄 does: a new scan invalidates every selection
  _recSel = { push: new Set(), overwrite: new Set(), updSrc: new Set(), del: new Set(), pull: new Set() };
  _recChildSel = {}; _depRetryNote = '';
  // children read before are read again — a root refresh alone left every one
  // of them "🔎 Scan" (live run 2026-09-22: 11 clicks after each run)
  const kids = sftkDeployChildOrder(Object.keys((p.lastScan && p.lastScan.children) || {}));
  await window.refreshProfileState?.(p.id);
  const fp = _profiles.find(x => x.id === p.id) || p;
  const failed = [];
  for (let i = 0; i < kids.length; i++) {
    const bb = eid('dsDepRefresh') || eid('dsDepScan');
    if (bb) { bb.disabled = true; bb.textContent = `⏳ reading children ${i + 1}/${kids.length}…`; }
    try { const res = await scanReconcileChild(fp, kids[i]); if (res?.error) failed.push(`${_depObjName(fp, kids[i])}: ${res.error}`); }
    catch (e) { failed.push(`${_depObjName(fp, kids[i])}: ${e?.message || e}`); }
  }
  if (failed.length) showToast(`Child scan: ${failed.join(' · ')}`, 'error', 9000);
  if (_currentView === 'deploy') renderDeploy();
}

// PURE. Child path keys in read order: parents before their children ('0', '1', '1.0', '1.1', '2').
function sftkDeployChildOrder(keys) {
  return [...(keys || [])].filter(k => k !== '').sort((a, b) => (a.split('.').length - b.split('.').length) || (a < b ? -1 : a > b ? 1 : 0));
}
function _depObjName(p, pathKey) { const n = getNodeByPath(p.tree, pathKey); return (n && (n.objectType || n.childSObject)) || pathKey; }

// 🔎 Scan all: every unread child, one after the other, parents first.
async function _depScanAll(p, keys) {
  const order = sftkDeployChildOrder(keys);
  const b = eid('dsDepScanAll');
  const failed = [];
  for (let i = 0; i < order.length; i++) {
    if (b) { b.disabled = true; b.textContent = `⏳ ${i + 1}/${order.length} ${_depObjName(p, order[i])}…`; }
    try { const res = await scanReconcileChild(p, order[i]); if (res?.error) failed.push(`${_depObjName(p, order[i])}: ${res.error}`); }
    catch (e) { failed.push(`${_depObjName(p, order[i])}: ${e?.message || e}`); }
  }
  if (failed.length) showToast(`Child scan: ${failed.join(' · ')}`, 'error', 9000);
  renderDeploy();
}

// ── one bucket of one object ──────────────────────────────────────────────
function _depPaintList(p, scan, cur, s, tabDef, opts) {
  const host = eid('dsDepList');
  if (!host) return;
  if (!s) {
    host.innerHTML = `<div class="ds-dep-empty">${esc(cur.obj)} has not been read against ${esc(orgLabel(p.targetOrg))} yet, so its records are unknown — not zero.
      <div style="margin-top:8px"><button class="ds-btn ds-btn-sm ds-btn-primary" data-dep-scan-here="${esc(cur.pathKey)}">🔎 Scan ${esc(cur.obj)}</button></div></div>`;
    host.querySelector('[data-dep-scan-here]')?.addEventListener('click', async e => {
      e.target.disabled = true; e.target.textContent = '⏳ reading…';
      const res = await scanReconcileChild(p, cur.pathKey);
      if (res?.error) showToast(`Child scan: ${res.error}`, 'error', 7000);
      renderDeploy();
    });
    return;
  }
  const isRoot = cur.depth === 0;
  const node = isRoot ? p.tree : getNodeByPath(p.tree, cur.pathKey);
  // The profile a row's helpers read: the deployment itself, or a VIEW of it
  // rooted at the child node (not a clone — a 🔗 pick lands on the real node).
  const prof = isRoot ? p : { ...p, tree: node, lastScan: s };
  const sel = isRoot ? null : _depChildSel(cur.pathKey);
  const all = s[tabDef.bucket] || [];
  const info = sftkScanBucketInfo(s, tabDef.bucket);
  const key = r => (typeof sftkMatchKeyLabel === 'function') ? sftkMatchKeyLabel(r.matchKey) : String(r.matchKey ?? '');
  const q = _depFilter.trim().toLowerCase();
  const rows = q ? all.filter(r => key(r).toLowerCase().includes(q) || String(r.parentKeySrc || '').toLowerCase().includes(q)) : all;
  const wkey = `${cur.pathKey}|${tabDef.k}|${q}`;
  { const ak = `${p.id}|${p.targetOrg}|${(s && s.runAt) || ''}`; if (ak !== _depAmbPickKey) { _depAmbPickKey = ak; _depAmbPick = new Map(); } }
  // An answer already remembered (match memory — it survives a reload; the
  // scan on screen is older than it, so the record is still listed here).
  const ambMemNow = () => ((_profiles.find(x => x.id === p.id) || p).matchMemory || {})[_orgKey(p.targetOrg || '')] || {};
  const ambMem = r => { const v = ambMemNow()[r.sourceId]; return v === SFTK_MEM_NEW ? '__new__' : (v && (r.candidates || []).includes(v) ? v : ''); };
  const ambPick = r => _depAmbPick.has(r.sourceId) ? _depAmbPick.get(r.sourceId) : (ambMem(r) || r.suggest || '');
  const ambRoot = tabDef.k === 'amb' && isRoot;
  if (wkey !== _depWindowKey) { _depWindowKey = wkey; _depWindow = SFTK_DEPLOY_WINDOW; }
  const shown = rows.slice(0, _depWindow);
  const recUrl = (org, id) => `${esc(String(org || '').replace(/\/$/, ''))}/lightning/r/${esc(id)}/view`;

  // child Insert rows: the SAME parent rule the classic page applies
  let pMissing = new Set(), pExists = new Set();
  if (!isRoot) {
    const parentKey = cur.depth > 1 ? cur.pathKey.split('.').slice(0, -1).join('.') : null;
    const ps = parentKey === null ? scan : (scan.children?.[parentKey] || {});
    pMissing = new Set((ps.missingInTarget || []).map(r => r.sourceId));
    pExists  = new Set([...(ps.changed || []).map(r => r.sourceId), ...(ps.identical || []).map(r => r.sourceId)]);
  }
  const relinkBlocked = !isRoot && !!(s.linkMasterDetail && s.linkUpdateable === false);
  const lkpN = id => Object.keys(sftkLkpOvGet(node, p.targetOrg, id)).length;
  const lkpBtn = (id, tgtId) => id ? `<button class="ds-dep-link${lkpN(id) ? ' ds-lkp-on' : ''}" data-rec-lkp="${esc(id)}" data-dep-lkp="1"${tgtId ? ` data-rec-lkp-tgt="${esc(tgtId)}"` : ''} title="Hand-pick which TARGET record each lookup field should point at for THIS record — saved per target org, beats name matching in the run.">🔗 lookups<span class="ds-lkp-count">${lkpN(id) ? ` ${lkpN(id)}` : ''}</span></button>` : '';
  const srcLockTip = `🔒 Writes to ${orgLabel(p.sourceOrg)} are locked (Connected Orgs → Unlock writes)`;

  const rowHtml = r => {
    const k = esc(key(r));
    const near = r.nearMiss ? `<span class="ds-rec-pnote ds-rec-pnote-missing" title="A record on the other side has the same key except for ${esc(r.nearMiss.reason || 'spacing/case')} — acting on it as-is would duplicate or delete the wrong thing.">≈ near match</span>` : '';
    const links = `${r.sourceId ? `<a href="${recUrl(p.sourceOrg, r.sourceId)}" target="_blank" rel="noopener">src ↗</a>` : ''}${r.sourceId && r.targetId ? ' · ' : ''}${r.targetId ? `<a href="${recUrl(p.targetOrg, r.targetId)}" target="_blank" rel="noopener">tgt ↗</a>` : ''}`;
    let ctl = '', extra = '', tail = '';
    if (tabDef.k === 'ins') {
      const st = isRoot ? 'ok' : sftkRecChildRowState(r, cur.depth, pMissing, pExists);
      const blocked = st === 'deepblock' || st === 'untracked';
      const on = isRoot ? _recSel.push.has(r.sourceId) : sel.push.has(r.sourceId);
      ctl = `<input type="checkbox" data-dep-push="${esc(r.sourceId)}" ${on && !blocked ? 'checked' : ''} ${blocked ? 'disabled' : ''} aria-label="insert ${k}">`;
      if (!isRoot) extra = st === 'missing' ? `<span class="ds-rec-pnote ds-rec-pnote-missing" title="Its parent is missing in the target too — selecting this row also inserts the parent, automatically, at run time.">parent ${esc(r.parentKeySrc || '')} ✗ missing — comes along</span>`
        : st === 'exists' ? `<span class="ds-rec-pnote ds-rec-pnote-ok" title="Its parent already exists in the target — this record attaches to it at insert.">parent ${esc(r.parentKeySrc || '')} ✓ exists</span>`
        : st === 'deepblock' ? `<span class="ds-rec-pnote ds-rec-pnote-unknown" title="Its parent is missing in the target too, and inserting both in one run is not supported at this depth — insert the parent level first, then rescan.">parent missing — insert the parent level first</span>`
        : st === 'untracked' ? `<span class="ds-rec-pnote ds-rec-pnote-unknown" title="Its parent is outside the scan above (scope or a duplicate key) — it cannot be attached safely.">parent untracked</span>`
        : `<span class="ds-rec-pnote ds-rec-pnote-none">no parent</span>`;
      tail = lkpBtn(r.sourceId, null);
    } else if (tabDef.k === 'chg') {
      const push = isRoot ? _recSel.overwrite.has(r.sourceId) : sel.overwrite.has(r.sourceId);
      const pull = isRoot && _recSel.updSrc.has(r.sourceId);
      ctl = `<span class="ds-rec-extra-actions">
        <button class="ds-rec-extra-btn ${push ? 'ds-rec-extra-on-push' : ''}" data-dep-dir="overwrite" data-dep-id="${esc(r.sourceId)}" title="Update the TARGET record with the source's values">→</button>
        ${isRoot ? `<button class="ds-rec-extra-btn ${pull ? 'ds-rec-extra-on-pull' : ''}" data-dep-dir="updSrc" data-dep-id="${esc(r.sourceId)}" ${opts.srcLocked ? 'disabled' : ''} title="${opts.srcLocked ? esc(srcLockTip) : 'Update the SOURCE record with the target\'s values'}">←</button>` : ''}</span>`;
      extra = (r.fields || []).length ? `<span class="ds-rec-drift-why" title="Differs on: ${esc(r.fields.join(', '))}">${esc(r.fields.slice(0, 3).join(', '))}${r.fields.length > 3 ? ` +${r.fields.length - 3}` : ''}</span>` : '';
      tail = `<button class="ds-dep-link" data-dep-fields="${esc(r.sourceId)}|${esc(r.targetId)}" title="The whole record, both orgs side by side — tick fields to update on the target">▸ record</button> ${lkpBtn(r.sourceId, r.targetId)}`;
    } else if (tabDef.k === 'ext') {
      const del = isRoot ? _recSel.del.has(r.targetId) : sel.del.has(r.targetId);
      const pull = isRoot && _recSel.pull.has(r.targetId);
      ctl = `<span class="ds-rec-extra-actions">
        <button class="ds-rec-extra-btn ${del ? 'ds-rec-extra-on-del' : ''}" data-dep-ext="del" data-dep-id="${esc(r.targetId)}" title="Delete this record from the target org">🗑</button>
        ${isRoot ? `<button class="ds-rec-extra-btn ${pull ? 'ds-rec-extra-on-pull' : ''}" data-dep-ext="pull" data-dep-id="${esc(r.targetId)}" ${opts.srcLocked ? 'disabled' : ''} title="${opts.srcLocked ? esc(srcLockTip) : 'Pull this record into the source org'}">← Pull</button>` : ''}</span>`;
      extra = r.orphan ? `<span class="ds-rec-pnote ds-rec-pnote-unknown" title="Its link field is empty in the target — possibly left by a partial run. Left out of ‘select all’; ⇄ Relink can re-attach it instead.">⚠ orphan</span>` : '';
    } else if (tabDef.k === 'link') {
      const on = !relinkBlocked && sel.relink.has(r.targetId);
      ctl = `<button class="ds-rec-extra-btn ${on ? 'ds-rec-extra-on-push' : ''}" data-dep-relink="${esc(r.targetId)}" ${relinkBlocked ? 'disabled title="Master-detail and not reparentable — Salesforce blocks changing it after insert"' : 'title="Point this target record at the parent the source says it belongs to"'}>⇄ Relink</button>`;
      extra = `<span class="ds-rec-link-detail" title="currently → should be">${esc(r.parentKeyTgt || '∅')} → ${esc(r.parentKeySrc || '∅')}</span>`;
      tail = `<button class="ds-dep-link" data-dep-fields="${esc(r.sourceId)}|${esc(r.targetId)}">▸ record</button>`;
    } else if (tabDef.k === 'amb') {
      // a child object's ambiguous rows (the root object uses _depAmbGroupsHtml)
      const cands = r.candidates || [];
      const nSrc = (r.twins || []).length + 1, srcL = orgLabel(p.sourceOrg), tgtL = orgLabel(p.targetOrg);
      extra = `<span class="ds-rec-pnote ds-rec-pnote-unknown" title="${nSrc} record(s) in ${esc(srcL)} and ${cands.length} in ${esc(tgtL)} carry this name — the name alone cannot say which is which.">${nSrc > 1 ? `${nSrc} with this name in ${esc(srcL)} · ` : ''}${cands.length} with this name in ${esc(tgtL)}</span>`;
      tail = `<span class="ds-rec-pnote" title="Choosing by hand works for the first object of the deployment only. A child object needs a second match field so its records can be told apart by more than the name.">cannot be chosen by hand for a child object — add a second match field (✏ Edit → Records → Matching)</span>`;
    } else {
      extra = r.personAccount ? '<span class="ds-rec-pnote" title="The Contact behind a Person Account — Salesforce creates and owns it.">👤 person account</span>' : '';
      // Synced = the COMPARED fields are equal. ▸ compare reads both records
      // live and shows every compared field side by side (user 2026-09-21).
      tail = `<button class="ds-dep-link" data-dep-fields="${esc(r.sourceId)}|${esc(r.targetId)}" title="Reads this record live from both orgs and shows every compared field side by side — what is equal, and anything that changed since the scan">▸ compare</button>`;
    }
    return `<div class="ds-dep-row${tabDef.k === 'amb' ? ' ds-dep-row-amb' : ''}">${ctl || '<span></span>'}<span class="ds-dep-key" title="${k}">${k}</span><span class="ds-dep-mid">${near}${extra}</span><span class="ds-dep-tail">${tail} <span class="ds-dep-open">${links}</span></span></div>`;
  };

  const nAll = rows.length.toLocaleString();
  const bulk = tabDef.k === 'ins' ? `<button class="ds-btn ds-btn-xs" data-dep-bulk="all" title="Select every ${nAll} record(s) in this list${rows.length > shown.length ? ` — including the ${(rows.length - shown.length).toLocaleString()} not shown yet (Show all lists them)` : ''}">✓ All ${nAll}</button><button class="ds-btn ds-btn-xs" data-dep-bulk="none">✗ None</button>`
    : tabDef.k === 'chg' ? `<button class="ds-btn ds-btn-xs" data-dep-bulk="all" title="Overwrite every ${nAll} changed record(s) in this list with the source's values">→ all ${nAll}</button><button class="ds-btn ds-btn-xs" data-dep-bulk="none">✗ None</button>`
    : tabDef.k === 'ext' ? `<button class="ds-btn ds-btn-xs" data-dep-bulk="all" title="Select every ${nAll} record(s) in this list for deletion">🗑 all ${nAll}${!isRoot ? ' (no orphans)' : ''}</button><button class="ds-btn ds-btn-xs" data-dep-bulk="none">✗ None</button>`
    : tabDef.k === 'link' ? `<button class="ds-btn ds-btn-xs" data-dep-bulk="all" ${relinkBlocked ? 'disabled' : ''}>⇄ all ${nAll}</button><button class="ds-btn ds-btn-xs" data-dep-bulk="none">✗ None</button>` : '';
  host.innerHTML = `
    <div class="ds-dep-tools">
      <input type="search" id="dsDepFilter" class="ds-dep-filter" placeholder="🔍 filter by name${isRoot ? '' : ' or parent'}…" value="${esc(_depFilter)}" aria-label="Filter records">
      <span>${esc(sftkDeployCountLabel(info.shown, info.total, info.capped, info.totalIsFloor))} ${esc(cur.obj)} ${esc(tabDef.noun)}${info.capped ? ` — the first ${Number(info.shown || 0).toLocaleString()} are listed here` : ''}</span>
      <span class="ds-dep-sp"></span>${bulk}${ambRoot && rows.length ? `<button class="ds-btn ds-btn-xs ds-btn-primary" id="dsDepAmbApply" disabled>📌 Apply</button>` : ''}
    </div>
    ${info.capped ? `<div class="ds-dep-note">⚠ This list is truncated — ${tabDef.k === 'same'
      ? `${info.shown.toLocaleString()} of the synced records are listed; the rest exist and are in sync, they were just not loaded into this result.`
      : `only the ${info.shown.toLocaleString()} listed record(s) exist in this result, so “all listed” means those, not every record. Run what is listed, 🔄 Refresh state, and repeat — or narrow the deployment.`}</div>` : ''}
    ${!isRoot && s.personContacts ? `<div class="ds-dep-note">${esc(sftkPaContactsLine(s.personContacts, orgLabel(p.sourceOrg), orgLabel(p.targetOrg)))}</div>` : ''}
    ${!isRoot ? (s.warnings || []).map(w => `<div class="ds-dep-note">⚠ ${esc(String(w).replace(/^[⚠\s]+/, ''))}</div>`).join('') : ''}
    ${tabDef.k === 'amb' && rows.length ? _depAmbIntro(p, isRoot, s) : ''}
    <div class="ds-dep-list">${shown.length ? (ambRoot ? _depAmbGroupsHtml(p, shown, s, ambPick, key, ambMem) : shown.map(rowHtml).join('')) : `<div class="ds-dep-empty">${q ? 'No record matches that filter.' : `Nothing ${esc(tabDef.noun)}.`}</div>`}</div>
    ${rows.length > shown.length ? `<div class="ds-dep-note ds-dep-more">Showing ${shown.length.toLocaleString()} of ${rows.length.toLocaleString()}
      <button class="ds-btn ds-btn-xs" data-dep-more="step">Show ${Math.min(SFTK_DEPLOY_WINDOW, rows.length - shown.length).toLocaleString()} more</button>
      <button class="ds-btn ds-btn-xs" data-dep-more="all">Show all ${rows.length.toLocaleString()}</button></div>` : ''}`;
  // Show more / all: grow the window for THIS list and repaint in place,
  // keeping the scroll position.
  host.querySelectorAll('[data-dep-more]').forEach(b => b.addEventListener('click', () => {
    const list = host.querySelector('.ds-dep-list'); const top = list ? list.scrollTop : 0;
    _depWindow = b.dataset.depMore === 'all' ? rows.length : _depWindow + SFTK_DEPLOY_WINDOW;
    _depPaintList(p, scan, cur, s, tabDef, opts);
    const again = host.querySelector('.ds-dep-list'); if (again) again.scrollTop = top;
  }));

  // ── wiring: every control writes into the classic Sets ──
  const repaint = () => { _depPaintList(p, scan, cur, s, tabDef, opts); _depSummary(p, p.tree?.objectType || p.tree?.childSObject || '?', null); };
  const fEl = eid('dsDepFilter');
  fEl?.addEventListener('input', () => { _depFilter = fEl.value; const pos = fEl.selectionStart; repaint(); const n = eid('dsDepFilter'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (_) {} } });
  const selectable = r => isRoot || (() => { const st = sftkRecChildRowState(r, cur.depth, pMissing, pExists); return st !== 'deepblock' && st !== 'untracked'; })();
  // Phase 5 — ⚠ Needs a decision: an answer is remembered in match memory (a
  // pair, or SFTK_MEM_NEW for "create it as new"). Nothing is written to
  // Salesforce here. One name at a time (📌 Apply this one) remembers at once
  // and leaves the re-read for later; the button above remembers what is still
  // open and reads both orgs again, once (user 2026-10-05: "i would like to be
  // able to also fix them one by one").
  const ambPending = () => (ambRoot ? all : []).filter(r => ambPick(r) !== ambMem(r));   // to remember, change or forget
  const ambKept = () => (ambRoot ? all : []).filter(r => ambMem(r));
  // Remember / forget, then READ THE MEMORY BACK: a decision that was not kept
  // (a deployment that is not saved has no memory) is counted, never assumed.
  const ambSave = async recs => {
    const learn = recs.filter(r => ambPick(r)).map(r => [r.sourceId, ambPick(r) === '__new__' ? SFTK_MEM_NEW : ambPick(r)]);
    const forget = recs.filter(r => !ambPick(r)).map(r => r.sourceId);
    if (learn.length) await window.sftkLearnPairs?.(p.id, p.targetOrg, learn);
    if (forget.length) await window.sftkForgetPairs?.(p.id, p.targetOrg, forget);
    const now = ((_profiles.find(x => x.id === p.id) || p).matchMemory || {})[_orgKey(p.targetOrg || '')] || {};
    const lost = learn.filter(([sId, t]) => now[sId] !== t).length + forget.filter(sId => now[sId]).length;
    if (!lost) for (const [sId] of learn) _depAmbPick.delete(sId);   // the memory is the answer now
    return lost;
  };
  const ambNotKept = n => showToast(`${n.toLocaleString()} decision(s) could not be remembered — this deployment is not a saved one, so it has no memory to keep them in. Nothing changed.`, 'error', 9000);
  // one record in the target can be the same as only ONE record in the source
  const ambTwice = recs => {
    const sId = sftkAmbTwice(recs.map(r => [r.sourceId, ambPick(r)]));
    if (!sId) return false;
    const r = recs.find(x => x.sourceId === sId);
    showToast(`Two ${orgLabel(p.sourceOrg)} records named "${r ? key(r) : ''}" were both said to be the same ${orgLabel(p.targetOrg)} record — one record there can be only one record here. Change one of them.`, 'warning', 9000);
    return true;
  };
  const ambPaintApply = () => {
    const b = eid('dsDepAmbApply'); if (!b) return;
    const nP = ambPending().length, nK = ambKept().length;
    b.disabled = !(nP || nK);
    b.textContent = nP ? `📌 Apply ${nP.toLocaleString()} decision${nP === 1 ? '' : 's'} and read both orgs again`
      : nK ? `🔄 Read both orgs again — ${nK.toLocaleString()} remembered decision${nK === 1 ? '' : 's'} take${nK === 1 ? 's' : ''} effect`
      : '📌 Apply — decide at least one below';
  };
  host.querySelectorAll('[data-dep-amb-sel]').forEach(el => el.addEventListener('change', () => {
    if (el.type === 'radio' && !el.checked) return;
    _depAmbPick.set(el.dataset.depAmbSel, el.value);
    // in place: the chosen answer is marked, the group's own button wakes up
    const grp = el.closest('.ds-amb-group');
    if (grp) {
      if (el.type === 'radio') grp.querySelectorAll(`input[name="${el.name}"]`).forEach(x => x.closest('.ds-amb-opt')?.classList.toggle('ds-amb-opt-on', x.checked));
      const gb = grp.querySelector('[data-dep-amb-one]');
      if (gb) {
        const open = shown.filter(r => key(r) === gb.dataset.depAmbOne).some(r => ambPick(r) !== ambMem(r));
        gb.disabled = !open;
        if (open) grp.querySelector('.ds-amb-done')?.remove();
      }
    }
    ambPaintApply();
  }));
  // 🔀 the copies of one name, on the side that holds more than one, merged into one record
  host.querySelectorAll('[data-dep-amb-merge]').forEach(b => b.addEventListener('click', () => {
    const side = b.dataset.depAmbMerge, name = b.dataset.depAmbKey;
    const rs = all.filter(r => key(r) === name);
    const ids = side === 'src' ? rs.map(r => r.sourceId) : ((rs[0] && rs[0].candidates) || []);
    _depMergeCopies(p, side, name, ids);
  }));
  host.querySelectorAll('[data-dep-amb-one]').forEach(b => b.addEventListener('click', async () => {
    const name = b.dataset.depAmbOne;
    const rs = shown.filter(r => key(r) === name);
    if (ambTwice(rs)) return;
    const todo = rs.filter(r => ambPick(r) !== ambMem(r));
    if (!todo.length) return;
    b.disabled = true; b.textContent = '⏳ remembering…';
    const lost = await ambSave(todo);
    if (lost) ambNotKept(lost);
    else showToast(`📌 "${name}" — remembered for ${orgLabel(p.targetOrg)}. It takes effect when both orgs are read again.`, 'success', 4000);
    repaint();
  }));
  eid('dsDepAmbApply')?.addEventListener('click', async () => {
    const pend = ambPending();
    if (!pend.length && !ambKept().length) return;
    if (ambTwice(all.filter(r => ambPick(r)))) return;
    host.querySelectorAll('[data-dep-amb-sel], [data-dep-amb-one], #dsDepAmbApply').forEach(x => { x.disabled = true; });
    const lost = pend.length ? await ambSave(pend) : 0;
    if (lost) { ambNotKept(lost); repaint(); return; }
    showToast(`📌 ${ambKept().length.toLocaleString()} decision(s) remembered for ${orgLabel(p.targetOrg)} — reading both orgs again…`, 'success', 5000);
    await _depRescan(p);
  });
  ambPaintApply();
  host.querySelectorAll('[data-dep-push]').forEach(cb => cb.addEventListener('change', () => {
    const set = isRoot ? _recSel.push : sel.push;
    if (cb.checked) set.add(cb.dataset.depPush); else set.delete(cb.dataset.depPush);
    _depSummary(p, null, null);
  }));
  host.querySelectorAll('[data-dep-dir]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.depId, dir = b.dataset.depDir;
    if (isRoot) {
      const other = dir === 'overwrite' ? 'updSrc' : 'overwrite';
      if (_recSel[dir].has(id)) _recSel[dir].delete(id); else { _recSel[dir].add(id); _recSel[other].delete(id); }
    } else if (sel.overwrite.has(id)) sel.overwrite.delete(id); else sel.overwrite.add(id);
    repaint();
  }));
  host.querySelectorAll('[data-dep-ext]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.depId, act = b.dataset.depExt;
    if (isRoot) {
      const other = act === 'del' ? 'pull' : 'del';
      if (_recSel[act].has(id)) _recSel[act].delete(id); else { _recSel[act].add(id); _recSel[other].delete(id); }
    } else if (sel.del.has(id)) sel.del.delete(id); else sel.del.add(id);
    repaint();
  }));
  host.querySelectorAll('[data-dep-relink]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.depRelink;
    if (sel.relink.has(id)) sel.relink.delete(id); else sel.relink.add(id);
    repaint();
  }));
  host.querySelectorAll('[data-dep-bulk]').forEach(b => b.addEventListener('click', () => {
    const on = b.dataset.depBulk === 'all';
    // the WHOLE list (every row that matches the filter), not the 300-row
    // window painted below — "5,000 of 6,000" + All gave 300 (live run 2026-09-22)
    for (const r of rows) {
      if (tabDef.k === 'ins') { if (!selectable(r)) continue; const set = isRoot ? _recSel.push : sel.push; on ? set.add(r.sourceId) : set.delete(r.sourceId); }
      else if (tabDef.k === 'chg') { const set = isRoot ? _recSel.overwrite : sel.overwrite; on ? set.add(r.sourceId) : set.delete(r.sourceId); if (isRoot) _recSel.updSrc.delete(r.sourceId); }
      else if (tabDef.k === 'ext') { if (on && r.orphan) continue; const set = isRoot ? _recSel.del : sel.del; on ? set.add(r.targetId) : set.delete(r.targetId); if (isRoot) _recSel.pull.delete(r.targetId); }
      else if (tabDef.k === 'link') { on ? sel.relink.add(r.targetId) : sel.relink.delete(r.targetId); }
    }
    repaint();
  }));
  host.querySelectorAll('[data-dep-fields]').forEach(b => b.addEventListener('click', () => {
    const [srcId, tgtId] = b.dataset.depFields.split('|');
    const row = all.find(r => r.sourceId === srcId);
    sftkOpenDriftCompare(prof, cur.obj, srcId, tgtId, s.compareFields || [], s.compareFieldsTgt || s.compareFields || [], row ? key(row) : srcId, row?.fields || []);
  }));
  host.querySelectorAll('[data-dep-lkp]').forEach(b => b.addEventListener('click', () => {
    const srcId = b.dataset.recLkp;
    const row = all.find(r => r.sourceId === srcId);
    showModal(`<div class="ds-modal-header">🔗 Lookups · ${esc(cur.obj)} · ${esc(row ? key(row) : srcId)}
        <span class="ds-dc-modal-sub">where each lookup lands in ${esc(orgLabel(p.targetOrg))} — pick a record to override name matching</span>
        <button class="ds-btn ds-btn-xs ds-dc-modal-close" data-dsaction="closeModal" title="Close">✕</button></div>
      <div class="ds-modal-body ds-dc-modal-body"><div id="dsDepLkpHost" style="padding:12px 0"></div></div>`);
    const h = eid('dsDepLkpHost');
    if (h) renderLkpOverridePanel(prof, cur.obj, srcId, h, b.dataset.recLkpTgt || null);
  }));
}

// ── ⏸ pause record-triggered flows during the run (user 2026-09-29) ───────
// An option, off by default ("this or just deploy regularly with flows
// active"). The list is read when the box is ticked, so the user sees exactly
// which flows go off before pressing ▶ Deploy; the run's confirmation lists
// them again; they come back on when the run ends (sftk-flowpause.js).
let _depFlowPause = { on: false, key: '', list: null, error: '' };

async function _depFlowPauseWire(p) {
  const objects = sftkDeployObjects(p.tree).map(o => o.obj);
  const key = `${p.targetOrg}|${objects.join(',')}`;
  const box = eid('dsDepFlowPause'), host = eid('dsDepFlowPauseList');
  const paint = () => {
    if (!host) return;
    const fp = _depFlowPause;
    if (!fp.on) { host.innerHTML = ''; return; }
    if (fp.error) { host.innerHTML = `⚠ The flows could not be listed — ${esc(fp.error)}. Untick to deploy with flows active, or open ${esc(orgLabel(p.targetOrg))} and tick again.`; return; }
    if (!fp.list) { host.textContent = `⏳ reading the record-triggered flows on ${objects.join(', ')} in ${orgLabel(p.targetOrg)}…`; return; }
    const l = fp.list;
    host.innerHTML = !l.flows.length
      ? `No active record-triggered flow on ${esc(objects.join(', '))} in ${esc(orgLabel(p.targetOrg))} — nothing to pause; the run writes as usual.${l.managed.length ? ` (${l.managed.length} from installed packages cannot be switched: ${esc(l.managed.join(', '))})` : ''}`
      : `⏸ Active record-triggered flows on this deployment's objects — the run switches off ONLY the ones on objects it writes (listed in its confirmation), and back on when it ends: ${l.flows.map(f => `${esc(f.label)} <span class="ds-subtext">(${esc(f.object)})</span>`).join(', ')}.${l.managed.length ? ` Installed-package flows stay on: ${esc(l.managed.join(', '))}.` : ''}`;
  };
  const load = async () => {
    _depFlowPause = { on: true, key, list: null, error: '' };
    paint();
    try {
      const sess = await getOrgSession(p.targetOrg);
      if (!sess) throw new Error(`${orgLabel(p.targetOrg)} is not open in a Chrome tab`);
      const list = await sftkFlowPauseList(sess, objects);
      if (_depFlowPause.key === key && _depFlowPause.on) _depFlowPause.list = list;
    } catch (e) { if (_depFlowPause.key === key) _depFlowPause.error = (e && e.message) || String(e); }
    paint();
  };
  box?.addEventListener('change', () => { if (box.checked) load(); else { _depFlowPause = { on: false, key: '', list: null, error: '' }; paint(); } });
  if (_depFlowPause.on && _depFlowPause.key !== key) load(); else paint();
  _depFlowLeftovers(p);
}

// Flows a run paused and never switched back on (the tab closed mid-run):
// said at the top of the page, with the one button that fixes it.
async function _depFlowLeftovers(p) {
  const host = eid('dsDepFlowLeft');
  if (!host || typeof sftkFlowPausedLeftovers !== 'function') return;
  const left = await sftkFlowPausedLeftovers(p.targetOrg);
  const names = Object.keys(left);
  if (!names.length) { host.innerHTML = ''; return; }
  host.innerHTML = `<div class="ds-rec-card ds-rec-card-bad"><div class="ds-rec-card-hd"><span class="ds-rec-card-ico">⏸</span><span class="ds-rec-card-title">${names.length} record-triggered flow(s) in ${esc(orgLabel(p.targetOrg))} are still OFF</span></div>
    <div class="ds-rec-card-line">A deployment switched them off and did not get to switch them back on (the page closed during the run): ${names.map(n => `${esc(left[n].label || n)} <span class="ds-subtext">(${esc(left[n].object || '')} · v${esc(String(left[n].version))})</span>`).join(', ')}.</div>
    <div class="ds-rec-card-line"><button class="ds-btn ds-btn-sm ds-btn-primary" id="dsDepFlowLeftOn">▶ Switch them back on</button></div></div>`;
  eid('dsDepFlowLeftOn')?.addEventListener('click', async () => {
    const flows = names.map(n => ({ apiName: n, label: left[n].label || n, object: left[n].object || '', version: left[n].version, defId: left[n].defId || '' }));
    const gate = await sftkOrgWriteGate(p.targetOrg, _orgs);
    const sure = await sftkConfirmDestructive({
      title: `▶ Switch ${flows.length} flow(s) back on in ${orgLabel(p.targetOrg)}`, icon: '▶',
      items: flows.map(f => ({ label: `${f.label} (${f.object}) → v${f.version}` })),
      revOverride: { html: 'Each flow is switched back on at the version that was active before the deployment paused it, and re-read.', needsCheckbox: false },
      confirmLabel: '▶ Switch back on',
      production: gate.production ? { label: gate.label } : null,
    });
    if (!sure) return;
    const sess = await getOrgSession(p.targetOrg);
    if (!sess) { showToast(`${orgLabel(p.targetOrg)} is not open in a Chrome tab — open it first`, 'warning', 6000); return; }
    const r = await sftkFlowPauseOn(sess, flows);
    showToast(r.failed.length ? `⚠ ${r.done.length} back on; ${r.failed.length} NOT: ${r.failed.join(' · ')}` : `▶ ${r.done.length} flow(s) back on — verified by re-reading the org`, r.failed.length ? 'error' : 'success', r.failed.length ? 15000 : 7000);
    _depFlowLeftovers(p);
  });
}

// ── ⏸ pause validation rules during the run (campaign 4 phase 4) ─────────────
// The same contract as the flows above (sftk-vrpause.js): an option, OFF by
// default; the rules are listed when it is ticked; they go off after the run's
// one confirmation and back on when it ends; leftovers get a banner.
let _depRulePause = { on: false, key: '', list: null, error: '' };

async function _depRulePauseWire(p) {
  const objects = sftkDeployObjects(p.tree).map(o => o.obj);
  const key = `${p.targetOrg}|${objects.join(',')}`;
  const box = eid('dsDepRulePause'), host = eid('dsDepRulePauseList');
  const paint = () => {
    if (!host) return;
    const vp = _depRulePause;
    if (!vp.on) { host.innerHTML = ''; return; }
    if (vp.error) { host.innerHTML = `⚠ The validation rules could not be listed — ${esc(vp.error)}. Untick to deploy with the rules active, or open ${esc(orgLabel(p.targetOrg))} and tick again.`; return; }
    if (!vp.list) { host.textContent = `⏳ reading the active validation rules on ${objects.join(', ')} in ${orgLabel(p.targetOrg)}…`; return; }
    const l = vp.list;
    host.innerHTML = !l.rules.length
      ? `No active validation rule on ${esc(objects.join(', '))} in ${esc(orgLabel(p.targetOrg))} — nothing to pause; the run writes as usual.${l.managed.length ? ` (${l.managed.length} from installed packages cannot be switched: ${esc(l.managed.join(', '))}.)` : ''}`
      : `⏸ Active validation rules on this deployment's objects — the run switches off ONLY the ones on objects it writes (decided when you press ▶ Deploy and listed in its confirmation), and back on when it ends: ${l.rules.map(r => `${esc(r.name)} <span class="ds-subtext">(${esc(r.object)})</span>`).join(', ')}. <b>While they are off they are off for every user of ${esc(orgLabel(p.targetOrg))}.</b>${l.managed.length ? ` Rules from installed packages cannot be switched and stay on: ${esc(l.managed.join(', '))}.` : ''}`;
  };
  const load = async () => {
    _depRulePause = { on: true, key, list: null, error: '' };
    paint();
    try {
      const sess = await getOrgSession(p.targetOrg);
      if (!sess) throw new Error(`${orgLabel(p.targetOrg)} is not open in a Chrome tab`);
      const list = await sftkVrPauseList(sess, objects);
      if (_depRulePause.key === key && _depRulePause.on) _depRulePause.list = list;
    } catch (e) { if (_depRulePause.key === key) _depRulePause.error = (e && e.message) || String(e); }
    paint();
  };
  box?.addEventListener('change', () => { if (box.checked) load(); else { _depRulePause = { on: false, key: '', list: null, error: '' }; paint(); } });
  if (_depRulePause.on && _depRulePause.key !== key) load(); else paint();
  _depRuleLeftovers(p);
}

// Rules a run paused and never switched back on (the tab closed mid-run):
// said at the top of the page, with the one button that fixes it.
async function _depRuleLeftovers(p) {
  const host = eid('dsDepRuleLeft');
  if (!host || typeof sftkVrPausedLeftovers !== 'function') return;
  const left = await sftkVrPausedLeftovers(p.targetOrg);
  const ids = Object.keys(left);
  if (!ids.length) { host.innerHTML = ''; return; }
  host.innerHTML = `<div class="ds-rec-card ds-rec-card-bad"><div class="ds-rec-card-hd"><span class="ds-rec-card-ico">⏸</span><span class="ds-rec-card-title">${ids.length} validation rule(s) in ${esc(orgLabel(p.targetOrg))} are still OFF</span></div>
    <div class="ds-rec-card-line">A deployment switched them off and did not get to switch them back on (the page closed during the run): ${ids.map(i => `${esc(left[i].name || i)} <span class="ds-subtext">(${esc(left[i].object || '')})</span>`).join(', ')}. Until they are back on, nothing in that org is validated by them.</div>
    <div class="ds-rec-card-line"><button class="ds-btn ds-btn-sm ds-btn-primary" id="dsDepRuleLeftOn">▶ Switch them back on</button></div></div>`;
  eid('dsDepRuleLeftOn')?.addEventListener('click', async () => {
    const rules = ids.map(i => ({ id: i, name: left[i].name || i, object: left[i].object || '' }));
    const gate = await sftkOrgWriteGate(p.targetOrg, _orgs);
    const sure = await sftkConfirmDestructive({
      title: `▶ Switch ${rules.length} validation rule(s) back on in ${orgLabel(p.targetOrg)}`, icon: '▶',
      items: rules.map(r => ({ label: `${r.name} (${r.object})` })),
      revOverride: { html: 'Each rule is switched back on and re-read.', needsCheckbox: false },
      confirmLabel: '▶ Switch back on',
      production: gate.production ? { label: gate.label } : null,
    });
    if (!sure) return;
    const sess = await getOrgSession(p.targetOrg);
    if (!sess) { showToast(`${orgLabel(p.targetOrg)} is not open in a Chrome tab — open it first`, 'warning', 6000); return; }
    const r = await sftkVrPauseOn(sess, rules);
    showToast(r.failed.length ? `⚠ ${r.done.length} back on; ${r.failed.length} NOT: ${r.failed.join(' · ')}` : `▶ ${r.done.length} validation rule(s) back on — verified by re-reading the org`, r.failed.length ? 'error' : 'success', r.failed.length ? 15000 : 6000);
    _depRuleLeftovers(p);
  });
}

// The run, with the rule pause on top of whatever else it was given (the flow
// pause passes its own hooks through here): rules go off AFTER the flows, come
// back on BEFORE them, and again in a finally if the run never reached its end.
async function _depReconcile(p, objType, buckets, opts) {
  const vpAll = _depRulePause.on && _depRulePause.list && _depRulePause.list.rules.length ? _depRulePause.list : null;
  // only the rules on the objects this run writes — the others stay on, and are named in the confirmation
  const written = sftkDeployWrittenObjects(sftkDeployObjects(p.tree), _recSel, _recChildSel);
  const vp = vpAll ? { ...vpAll, rules: vpAll.rules.filter(r => written.has(r.object)), untouched: vpAll.rules.filter(r => !written.has(r.object)).map(r => `${r.name} (${r.object})`) } : null;
  if (!vp || !vp.rules.length) return runReconcile(p, objType, buckets, opts);
  let pausedR = null, tgtSessR = null, backR = null;
  const resumeR = async () => {
    if (backR || !pausedR || !pausedR.ok || !pausedR.off.length) return backR;
    const sess = (await getOrgSession(p.targetOrg)) || tgtSessR;
    backR = await sftkVrPauseOn(sess, pausedR.off);
    return backR;
  };
  try {
    await runReconcile(p, objType, buckets, { ...(opts || {}), rulePause: vp,
      beforeWrites: async (sess, log) => {
        tgtSessR = sess;
        if (opts && typeof opts.beforeWrites === 'function') { const ok = await opts.beforeWrites(sess, log); if (!ok) return false; }
        log('⏸', `Switching off ${vp.rules.length} validation rule(s) in ${orgLabel(sess.orgUrl)}…`);
        pausedR = await sftkVrPauseOff(sess, vp.rules);
        if (!pausedR.ok) {
          log('❌', `Not every validation rule could be switched off, so the run did not start: ${pausedR.failed.join(' · ')}${pausedR.restored.length ? ` — ${pausedR.restored.length} already off switched back on` : ''}${pausedR.restoreFailed.length ? ` — NOT back on: ${pausedR.restoreFailed.join(' · ')}` : ''}`, 'ds-prog-err');
          // whatever the flow option switched off goes back on too — the run is not starting
          if (opts && typeof opts.afterWrites === 'function') { try { await opts.afterWrites(log); } catch (_) { /* its own finally tries again */ } }
          return false;
        }
        log('✅', `${pausedR.off.length} validation rule(s) switched off — verified by re-reading the org; they go back on as soon as the writes end`);
        return true;
      },
      afterWrites: async log => {
        if (pausedR && pausedR.ok && pausedR.off.length) {
          log('▶', `Switching ${pausedR.off.length} validation rule(s) back on…`);
          const r = await resumeR();
          log(r.failed.length ? '⚠' : '✅', r.failed.length
            ? `${r.done.length} back on; NOT: ${r.failed.join(' · ')} — the Deploy page lists them with a button`
            : `${r.done.length} validation rule(s) back on — verified by re-reading the org`, r.failed.length ? 'ds-prog-err' : '');
        }
        if (opts && typeof opts.afterWrites === 'function') await opts.afterWrites(log);
      },
    });
  } finally {
    // the safety net: a run that failed or stopped before its last write
    if (pausedR && pausedR.ok && pausedR.off.length) {
      const r = await resumeR();
      if (r.failed.length) showToast(`⚠ ${r.failed.length} validation rule(s) could NOT be switched back on in ${orgLabel(p.targetOrg)}: ${r.failed.join(' · ')} — the Deploy page lists them with a button to switch them on.`, 'error', 20000);
      else showToast(`▶ ${r.done.length} validation rule(s) back on in ${orgLabel(p.targetOrg)} — verified by re-reading the org`, 'success', 8000);
      if (_currentView === 'deploy') _depRuleLeftovers(p);
    }
  }
}

// ▶ Deploy: as always — or, with ⏸ ticked and flows found, the run pauses them
// after its confirmation and they are switched back on when it returns, in a
// finally (a failed or stopped run switches them back too).
async function _depRun(p, objType, buckets) {
  const fpAll = _depFlowPause.on && _depFlowPause.list && _depFlowPause.list.flows.length ? _depFlowPause.list : null;
  // only the flows on the objects this run writes (2026-10-03) — a flow on an object with nothing selected stays on
  const writtenF = sftkDeployWrittenObjects(sftkDeployObjects(p.tree), _recSel, _recChildSel);
  const fpNarrow = fpAll ? { ...fpAll, flows: fpAll.flows.filter(f => writtenF.has(f.object)) } : null;
  const fp = fpNarrow && fpNarrow.flows.length ? fpNarrow : null;
  if (!fp) return _depReconcile(p, objType, buckets);
  let paused = null, tgtSess = null, back = null;
  const resume = async () => {
    if (back || !paused || !paused.ok || !paused.off.length) return back;
    const sess = (await getOrgSession(p.targetOrg)) || tgtSess;
    back = await sftkFlowPauseOn(sess, paused.off);
    return back;
  };
  try {
    await _depReconcile(p, objType, buckets, { flowPause: fp,
      beforeWrites: async (sess, log) => {
        tgtSess = sess;
        log('⏸', `Switching off ${fp.flows.length} record-triggered flow(s) in ${orgLabel(sess.orgUrl)}…`);
        paused = await sftkFlowPauseOff(sess, fp.flows);
        if (!paused.ok) {
          log('❌', `Not every flow could be switched off, so the run did not start: ${paused.failed.join(' · ')}${paused.restored.length ? ` — ${paused.restored.length} already off switched back on` : ''}${paused.restoreFailed.length ? ` — STILL OFF: ${paused.restoreFailed.join(' · ')}` : ''}`, 'ds-prog-err');
          return false;
        }
        log('✅', `${paused.off.length} flow(s) switched off — verified by re-reading the org; they go back on as soon as the writes end`);
        return true;
      },
      afterWrites: async log => {
        if (!paused || !paused.ok || !paused.off.length) return;
        log('▶', `Switching ${paused.off.length} record-triggered flow(s) back on…`);
        const r = await resume();
        log(r.failed.length ? '⚠' : '✅', r.failed.length
          ? `${r.done.length} back on; NOT: ${r.failed.join(' · ')} — the Deploy page lists them with a button`
          : `${r.done.length} flow(s) back on at their versions — verified by re-reading the org`, r.failed.length ? 'ds-prog-err' : '');
      },
    });
  } finally {
    // the safety net: a run that failed or stopped before its last write
    if (paused && paused.ok && paused.off.length) {
      const r = await resume();
      if (r.failed.length) showToast(`⚠ ${r.failed.length} flow(s) could NOT be switched back on in ${orgLabel(p.targetOrg)}: ${r.failed.join(' · ')} — the Deploy page lists them with a button to switch them on.`, 'error', 20000);
      else showToast(`▶ ${r.done.length} record-triggered flow(s) back on in ${orgLabel(p.targetOrg)} — verified by re-reading the org`, 'success', 8000);
      if (_currentView === 'deploy') _depFlowLeftovers(p);
    }
  }
}

// ── the action bar: what ▶ Deploy will do, in words ───────────────────────
function _depSummary(p, objTypeOrNull, objByPathOrNull) {
  const objType = objTypeOrNull || p.tree?.objectType || p.tree?.childSObject || '?';
  const objByPath = objByPathOrNull || Object.fromEntries(sftkDeployObjects(p.tree).map(o => [o.pathKey, o.obj]));
  const s = sftkDeploySelection(_recSel, _recChildSel, objType, objByPath);
  const el = eid('dsDepSummary'), run = eid('dsRecRunBtn');
  if (el) el.innerHTML = s.total ? s.parts.map(x => `<span class="ds-diff-chip">${esc(x)}</span>`).join(' ') : '<span class="ds-dep-muted">Nothing selected — tick records above. ▶ Deploy writes only what you select.</span>';
  if (run) { run.disabled = !s.total; run.textContent = s.total ? `▶ Deploy ${s.total.toLocaleString()} selected into ${orgLabel(p.targetOrg)}` : '▶ Deploy'; }
}
