'use strict';

// ── B3: live Bulk API job state in the run panel ─────────────────────────────
// The engine already streams {phase:'bulk'|'bulkQuery', obj, state, processed,
// failed, total} over the run Port, but the SHARED handler in studio-scan.js
// only knows node/fetched/batch — so a bulk job used to look like a frozen
// "reading records…" line for minutes. These two helpers give it its own live
// row per object: "⚡ Account — Bulk write: InProgress — 12,000 / 40,000
// processed, 3 failed".
//
// Inline styles (no CSS file is owned here) match the ds-prog-row look.
function _trRenderBulkRow(logEl, evt) {
  if (!logEl || !logEl.isConnected) return;
  const isRead = evt.phase === 'bulkQuery';
  const obj    = String(evt.obj || evt.objType || '?');
  const id     = `dsTrBulk_${isRead ? 'r' : 'w'}_${obj.replace(/[^\w]/g, '_')}`;
  let row = logEl.querySelector(`#${id}`);
  if (!row) {
    row = document.createElement('div');
    row.id = id;
    row.className = 'ds-prog-row ds-prog-live';
    logEl.appendChild(row);
  }
  const num  = n => (Number.isFinite(Number(n)) ? Number(n).toLocaleString() : '?');
  const done = num(evt.processed);
  // total is unknown while the job is still being sized — say "?" rather than
  // inventing a denominator.
  const tot  = (evt.total === null || evt.total === undefined) ? '?' : num(evt.total);
  const verb = isRead ? 'read' : 'processed';
  const tail = (!isRead && evt.failed) ? `, ${num(evt.failed)} failed` : '';
  const icon = evt.state === 'Aborted' ? '✋' : (evt.state === 'JobComplete' ? '✅' : '⚡');
  row.textContent = `${icon} ${obj} — Bulk ${isRead ? 'read' : 'write'} job: ${evt.state || 'InProgress'} — ${done} / ${tot} ${verb}${tail}`;
  if (evt.state === 'Aborted') row.style.color = '#b45309';
  logEl.scrollTop = logEl.scrollHeight;
}

// Wraps the shared progress handler: bulk phases get the dedicated row above,
// everything else falls through unchanged.
function _trProgressHandler(logEl) {
  // Cross-file call (studio-scan.js) — guarded per the load-order rule.
  const base = (typeof _runProgressHandler === 'function') ? _runProgressHandler(logEl) : () => {};
  return evt => {
    if (evt && (evt.phase === 'bulk' || evt.phase === 'bulkQuery')) {
      _trRenderBulkRow(logEl, evt);
      return;
    }
    // Real-time error feed (user 2026-08-18) — red rows as failures land,
    // appended (not updated in place) so nothing scrolls out of history.
    if (evt && evt.phase === 'errs' && Array.isArray(evt.lines) && logEl?.isConnected) {
      for (const ln of evt.lines) {
        const row = document.createElement('div');
        row.className = 'ds-prog-row ds-prog-err';
        row.textContent = `❌ ${ln}`;
        logEl.appendChild(row);
      }
      if (evt.more) {
        const r = document.createElement('div');
        r.className = 'ds-prog-row ds-prog-err';
        r.textContent = `…and ${evt.more} more error(s) in this batch — the full list lands in History.`;
        logEl.appendChild(r);
      }
      logEl.scrollTop = logEl.scrollHeight;
      return;
    }
    base(evt);
  };
}

// ════════════════════════════════════════════════════════════════
// E3 — API-BUDGET AWARENESS
// ════════════════════════════════════════════════════════════════
// Big orgs meter API calls and the daily pool is shared with every other
// integration — one surprise bulk run is how tools get banned. These helpers
// (a) read an org's DailyApiRequests limit, (b) estimate what a run will
// cost BEFORE it starts, and (c) restate the cost after the run from actual
// record counts. Estimates carry '≈' on purpose: poll counts, retries and
// the optional resolution queries (record types, owners, lookup bridges)
// can't be known from the plan — only the derivable calls are counted
// (describes, reads, batched writes, child-first link updates). The line
// NEVER blocks a run; it informs. This file loads before studio-ring.js
// (studio.html order), so the ring's Sync Plan footer shares these via
// window.* below.

// sftkBudgetCacheFresh / sftkExtractDailyApi / window.sftkApiBudget /
// window.sftkApiBudgetInvalidate moved to sftk-api-budget.js (E3b hoist) —
// loaded by BOTH apps so the popup's operations get the meter too.

// Pure — flatten a preview-counts tree (previewTransfer's { count, children })
// plus the index-parallel profile tree into the estimator's plan shape.
// A null count (COUNT() failed) stays null — the estimator then reports
// known:false instead of inventing a number.
function sftkPlanFromCounts(counts, tree, bulkThreshold, ownerMatch, engine) {
  const nodes = [];
  (function walk(c, t, parentRecords, isRoot) {
    if (!c) return;
    const records = Number.isFinite(c.count) ? Math.max(0, c.count) : null;
    nodes.push({
      records,
      isRoot: !!isRoot,
      parentRecords: isRoot ? null : parentRecords,
      childFirst: !!(t && t.insertOrder === 'childFirst'),
    });
    const kids = c.children || [];
    const tkids = (t && t.children) || [];
    for (let i = 0; i < kids.length; i++) walk(kids[i], tkids[i], records, false);
  })(counts, tree, null, true);
  return { bulkThreshold, ownerMatch: !!ownerMatch, nodes,
    apiMode: engine?.apiMode, batchSize: engine?.batchSize };
}

// Pure — same plan shape, but from a finished run's summary (actuals).
// records = created + failed + notProcessed per reported object. An object
// ABSENT from the summary is unknown (→ known:false downstream), never zero.
// viaBulk from the summary pins the write path (bulkWrite true/false) so the
// post-run figure reflects what the engine actually did, not the threshold.
function sftkPlanFromRunSummary(tree, summary, bulkThreshold, ownerMatch, engine) {
  const nodes = [];
  (function walk(t, parentRecords, isRoot) {
    if (!t) return;
    const obj = t.objectType || t.childSObject;
    const s = summary && obj ? summary[obj] : null;
    const records = s ? (s.created || 0) + (s.failed || 0) + (s.notProcessed || 0) : null;
    nodes.push({
      records,
      isRoot: !!isRoot,
      parentRecords: isRoot ? null : parentRecords,
      childFirst: !!(t.insertOrder === 'childFirst'),
      bulkWrite: s ? !!s.viaBulk : null,
    });
    for (const c of (t.children || [])) walk(c, records, false);
  })(tree, null, true);
  return { bulkThreshold, ownerMatch: !!ownerMatch, nodes,
    apiMode: engine?.apiMode, batchSize: engine?.batchSize };
}

// Pure — estimate the API calls a run will make, derived from what
// executeProfileTransfer (background.js) actually does:
//   per node: 1 source describe + 1 target describe (paid even for 0 records)
//   root read: 1 COUNT() routing call, then EITHER one Bulk API 2.0 query
//     job when records ≥ bulkThreshold (job create + status polls + result
//     download — a 4-call floor; polls grow with job duration) OR
//     ceil(records / 2000) REST pages
//   child read: fetches chunk by 200 parent ids —
//     max(ceil(parentRecords/200), ceil(records/2000)) queries; a child
//     whose parent scope is EMPTY is skipped before any fetch or write
//   write: EITHER one Bulk ingest job when records ≥ bulkThreshold (create
//     + CSV upload + close + polls + 2 result files — a 7-call floor) OR
//     ceil(records / 200) Collections calls; zero records write nothing
//   child-first connect step: up to ceil(records / 200) update calls
//   owner matching on (plan.ownerMatch, profile.ownerMapping.mode==='match'):
//     +1 target call — the owner index / first name-lookup query, made once
//     per run by the first node that has records; per-name lookup chunks
//     beyond that floor depend on distinct owner names and aren't counted
// NOT counted (unknowable from the plan): record-type / lookup resolution
// queries, retries, polls beyond the floors — hence the '≈'.
// plan: { bulkThreshold, ownerMatch, nodes: [{ records, isRoot,
//   parentRecords, childFirst, bulkWrite }] } — null records/parentRecords
//   = unknown.
// Returns { total, source, target, known } — split per org so each side can
// be weighed against ITS OWN remaining daily budget.
function sftkEstimateRunCalls(plan) {
  const thr = Number(plan && plan.bulkThreshold) > 0 ? Number(plan.bulkThreshold) : 2000;
  // Engine settings shift the estimate exactly as they shift the engine:
  // apiMode 'bulk' → every read/write is a job (threshold 0); 'sync' → no
  // job ever (threshold ∞); batchSize divides the Collections call count.
  const mode   = (plan && (plan.apiMode === 'sync' || plan.apiMode === 'bulk')) ? plan.apiMode : 'auto';
  const bulkAt = mode === 'bulk' ? 0 : mode === 'sync' ? Infinity : thr;
  const bs     = Math.max(1, Math.min(200, Number(plan && plan.batchSize) || 200));
  const BULK_READ_CALLS = 4, BULK_WRITE_CALLS = 7;
  let source = 0, target = 0, known = true, anyRecords = false;
  for (const node of ((plan && plan.nodes) || [])) {
    const n = Number.isFinite(node && node.records) ? Math.max(0, node.records) : null;
    if (n === null) known = false;
    if (n === null || n > 0) anyRecords = true;     // unknown might have records
    source += 1; target += 1;                       // the two describes
    let nodeSkipped = false;                        // empty parent scope → engine skips the node
    if (node.isRoot) {
      source += 1;                                  // COUNT() routing call
      if (n === null) source += 1;                  // at least one read page
      else if (n >= bulkAt) source += BULK_READ_CALLS;
      else source += Math.max(1, Math.ceil(n / 2000));
    } else {
      const pn = Number.isFinite(node && node.parentRecords) ? Math.max(0, node.parentRecords) : null;
      if (pn === null) { known = false; source += 1; }
      else if (pn === 0) nodeSkipped = true;
      else source += Math.max(Math.ceil(pn / 200), Math.ceil((n || 0) / 2000));
    }
    if (!nodeSkipped) {
      if (n === null) target += 1;                  // at least one write attempt
      else if (n > 0) {
        const bulk = node.bulkWrite === true || (node.bulkWrite == null && n >= bulkAt);
        target += bulk ? BULK_WRITE_CALLS : Math.ceil(n / bs);
        if (node.childFirst) target += Math.ceil(n / bs);    // connect-step updates
      }
    }
  }
  // Owner matching resolves against the TARGET org's users — one index (or
  // first name-lookup) query per run, paid by the first node with records.
  // All-zero-record runs never reach the owner code, so they don't pay it.
  if (plan && plan.ownerMatch && anyRecords) target += 1;
  return { total: source + target, source, target, known };
}

// Pure — the one-line budget display. est: { total, known } (estimator
// output or compatible). budgets: [{ label, budget, calls }] where budget is
// { max, remaining } | null — null means the meter could NOT be read, which
// is SAID ("API budget unavailable"), never hidden. calls is the estimate
// against that specific org. Returns { text, warn }; warn flips when any
// org's estimated calls EXCEED its remaining daily budget (equal is not
// over). The caller styles the line — nothing here blocks anything.
function sftkApiBudgetLine(est, budgets) {
  const fmt = v => Number(v).toLocaleString();
  const total = est && Number.isFinite(est.total) ? est.total : null;
  const unknown = !!(est && est.known === false);
  const parts = [];
  if (total !== null) {
    parts.push(`≈${fmt(total)}${unknown ? '+' : ''} API call${total === 1 && !unknown ? '' : 's'}`);
  }
  let warn = false;
  const over = [];
  for (const b of (budgets || [])) {
    const label = b && b.label ? String(b.label) : 'org';
    if (b && b.budget && Number.isFinite(b.budget.remaining) && Number.isFinite(b.budget.max)) {
      parts.push(`${label} has ${fmt(b.budget.remaining)} of ${fmt(b.budget.max)} daily API calls remaining`);
      if (Number.isFinite(b.calls) && b.calls > b.budget.remaining) { warn = true; over.push(label); }
    } else {
      parts.push(`${label}: API budget unavailable`);
    }
  }
  let text = parts.join(' · ');
  if (warn) {
    text = `⚠ ${text} — this run may exhaust the org's remaining daily API budget${over.length > 1 ? 's' : ''} (${over.join(', ')})`;
  }
  return { text, warn };
}

// Pure — API-call estimate for a ring Sync Plan run (studio-ring.js). One
// shared source, N independent target jobs. Per target the plan can PUSH
// missing records (a real executeProfileTransfer scoped to the ticked root
// ids — the profile tree's children ride along, their counts unknowable
// until the run → known:false) and/or OVERWRITE drifted ones
// (reconcileOverwrite: 1 describe per org, source reads chunked by 200 ids,
// SF_COLLECTIONS_UPDATE batches of 200; its lookup/owner/record-type
// resolution queries aren't derivable — same '≈' rule as the transfer
// estimator). sel: [{ label, push, ovw }] — the ticked record counts.
// opts: { tree, bulkThreshold, ownerMatch }.
// Returns { total, source, known, perOrg: [{ label, calls }] } — perOrg
// aligns with sel by index so each target's cost can be weighed against ITS
// remaining daily budget; source aggregates every job's reads against the
// source of truth.
function sftkEstimateSyncPlanCalls(sel, opts) {
  const tree = opts && opts.tree;
  let source = 0, known = true;
  const perOrg = [];
  for (const s of (sel || [])) {
    const push = Math.max(0, Number(s && s.push) || 0);
    const ovw  = Math.max(0, Number(s && s.ovw) || 0);
    let calls = 0;
    if (push > 0) {
      const nodes = [];
      (function walk(t, parentRecords, isRoot) {
        if (!t) return;
        const records = isRoot ? push : null;   // children ride along — unknown here
        nodes.push({ records, isRoot, parentRecords: isRoot ? null : parentRecords,
          childFirst: !!(t.insertOrder === 'childFirst') });
        for (const c of (t.children || [])) walk(c, records, false);
      })(tree || {}, null, true);
      const est = sftkEstimateRunCalls({
        bulkThreshold: opts && opts.bulkThreshold,
        ownerMatch: !!(opts && opts.ownerMatch),
        nodes,
      });
      source += est.source;
      calls  += est.target;
      if (est.known === false) known = false;
    }
    if (ovw > 0) {
      const chunks = Math.ceil(ovw / 200);
      source += 1 + chunks;   // source describe + id-chunked reads
      calls  += 1 + chunks;   // target describe + 200-record update batches
    }
    perOrg.push({ label: (s && s.label) || 'org', calls });
  }
  const total = source + perOrg.reduce((n, o) => n + o.calls, 0);
  return { total, source, known, perOrg };
}

window.sftkEstimateRunCalls      = sftkEstimateRunCalls;
window.sftkPlanFromCounts        = sftkPlanFromCounts;
window.sftkPlanFromRunSummary    = sftkPlanFromRunSummary;
window.sftkApiBudgetLine         = sftkApiBudgetLine;
window.sftkEstimateSyncPlanCalls = sftkEstimateSyncPlanCalls;

// The counts tree from the last previewTransfer — the estimator's input.
let _trLastCounts = null;
let _trLastTotalIsBound = false;   // true when a grandchild could not be scoped to its filtered parents (count is an upper bound)
// Last-render-wins token for the async meter fetch below.
let _trBudgetToken = 0;

// E3 — paint the budget line under the run footer. The estimate renders
// synchronously; the two orgs' meters fill in when fetched (5-min cached).
// No counts yet → nothing honest to show → empty line (the auto-count that
// populates the preview also lands here).
async function _trUpdateApiBudget() {
  const el = eid('dsTrApiBudget');
  if (!el) return;
  if (!_transferProfile?.tree || !_trLastCounts) { el.textContent = ''; return; }
  const tok = ++_trBudgetToken;
  const plan = sftkPlanFromCounts(_trLastCounts, buildTransferProfile().tree,
    _transferProfile.bulkThreshold, _transferProfile?.ownerMapping?.mode === 'match',
    { apiMode: _transferProfile?.apiMode, batchSize: _transferProfile?.batchSize });
  const est = sftkEstimateRunCalls(plan);
  el.textContent = sftkApiBudgetLine(est, []).text;   // estimate now, meters next
  const [sb, tb] = await Promise.all([
    window.sftkApiBudget(_transferSrc?.orgUrl, _transferSrc?.sid),
    window.sftkApiBudget(_transferTgt?.orgUrl, _transferTgt?.sid),
  ]);
  if (tok !== _trBudgetToken) return;                 // a newer render won
  const el2 = eid('dsTrApiBudget');
  if (!el2) return;
  const line = sftkApiBudgetLine(est, [
    { label: orgLabel(_transferSrc?.orgUrl || '') || 'source org', budget: sb, calls: est.source },
    { label: orgLabel(_transferTgt?.orgUrl || '') || 'target org', budget: tb, calls: est.target },
  ]);
  el2.textContent = line.text;
  el2.style.color = line.warn ? '#b45309' : '';
}

async function renderTransfer() {
  setMain(`<div class="ds-init-loading">${window.sftkCat ? sftkCat('Refreshing sessions…') : 'Refreshing sessions…'}</div>`);

  // Refresh open-tab sessions so we use the freshest SIDs.
  const freshRes = await sendBg({ type: 'GET_ALL_SF_SESSIONS' });
  if (Array.isArray(freshRes?.sessions)) _allSessionsOk = true;
  if (freshRes?.sessions?.length) {
    _allSessions = freshRes.sessions;
    _allSessions.forEach(s => upsertOrg(s.orgUrl, s.label));
  }

  const allSess = _buildAllSessions();
  window._dsTrSessions = allSess;

  // ── Source/target: profile defaults + per-run override. ──────────────────
  // The profile defines the default org pair, but the user can switch either
  // side (or swap) for THIS run via the dropdowns on the org pair — stored in
  // _transferOrgOverride, never written back to the profile. The org card's
  // Transfer button also seeds the source override.
  function refreshTransferOrgsFromProfile() {
    if (!_transferProfile && !_transferOrgOverride.src && !_transferOrgOverride.tgt) {
      _transferSrc = null; _transferTgt = null; return;
    }
    // Precedence: run-time override > the profile's own orgs > working pair.
    const srcUrl = _transferOrgOverride.src || _transferProfile?.sourceOrg || _workingPair.src || '';
    const tgtUrl = _transferOrgOverride.tgt || _transferProfile?.targetOrg || _workingPair.tgt || '';
    _transferSrc = srcUrl ? _resolveSession(srcUrl, allSess) || { orgUrl: srcUrl, sid: null } : null;
    _transferTgt = tgtUrl ? _resolveSession(tgtUrl, allSess) || { orgUrl: tgtUrl, sid: null } : null;
  }
  window._dsTrRefreshOrgs = refreshTransferOrgsFromProfile;   // used by the org-pair dropdowns
  refreshTransferOrgsFromProfile();

  const profileOptions = _profiles.map((p, i) =>
    `<option value="${i}" ${_transferProfile?.id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`
  ).join('');

  setMain(`
    ${dsViewHeader({
      // 'play' — this is Data Deployment's run screen; no sidebar row of its
      // own, so the glyph states the verb rather than mirroring a nav icon.
      icon: 'play',
      back: `<button class="ds-back-link" id="dsTrBackBtn" title="Back to Data Deployment">‹ Back to deployments</button>`,
      title: 'Run Transfer',
      subtitle: 'Copy records using a saved profile',
    })}

    <div class="ds-op-banner ds-op-banner-write">
      <span class="ds-op-banner-icon">✍️</span>
      <div class="ds-op-banner-body">
        <div class="ds-op-banner-title">Write operation — this inserts records into the target org</div>
        <div class="ds-op-banner-desc">Records will be <strong>inserted</strong> (not updated) in the target org.
          The source org is never modified. You can always undo by deleting the inserted records in the target.
        </div>
      </div>
    </div>

    ${!_profiles.length ? `
      <div class="ds-empty-page">
        <div class="ds-empty-icon">📦</div>
        <div class="ds-empty-title">No deployment profiles yet</div>
        <div class="ds-empty-sub">A profile defines which records to copy and which orgs are source/target. Create one in <strong>Data Deployment</strong> first.</div>
        <div class="ds-empty-actions">
          <button class="ds-btn ds-btn-primary" id="dsGoToProfiles">📦 Go to Data Deployment</button>
        </div>
      </div>` : `
    <div class="ds-transfer-config">
      <div class="ds-transfer-row">
        <div class="ds-field-group">
          <label class="ds-lbl">Profile <span style="font-size:11px;font-weight:400;color:var(--subtext)">(defines records + orgs)</span></label>
          <div class="ds-tr-profile-row">
            <select id="dsTrProfile" class="ds-select">
              <option value="">— Select a profile —</option>
              ${profileOptions}
            </select>
            <button class="ds-btn ds-btn-sm" id="dsTrEditProfile"
              title="Open this profile in the builder to edit objects, orgs, filters, and field mappings"
              ${_transferProfile ? '' : 'disabled'}>
              ✏ Edit profile
            </button>
          </div>
        </div>
      </div>

      <!-- Read-only org pair (defined by the profile) -->
      <div id="dsTrOrgPair"></div>

      <div id="dsTrPreviewArea"></div>

      <div id="dsTrSessionWarn" style="display:none;margin:8px 0 0;padding:8px 12px;background:#fff8f0;border:1px solid #e07b39;border-radius:6px;font-size:12px;color:#7a3a00;"></div>

      <div class="ds-transfer-options">
        <div class="ds-transfer-option">
          <label class="ds-transfer-option-label" for="dsTrWriteMode">Write mode:</label>
          <select id="dsTrWriteMode" class="ds-select ds-select-sm" style="width:auto">
            <option value="insert" ${_transferWriteMode === 'insert' ? 'selected' : ''}>Insert (always create)</option>
            <option value="upsert" ${_transferWriteMode === 'upsert' ? 'selected' : ''}>Upsert (update if exists)</option>
          </select>
          <select id="dsTrUpsertSelect" class="ds-select ds-select-sm"
            style="width:220px;display:none"
            title="External ID fields found on the root object in the TARGET org. Records matching on this field are updated instead of duplicated."></select>
          <input id="dsTrUpsertField" class="ds-input ds-input-sm"
            style="width:200px;${_transferWriteMode === 'upsert' ? '' : 'display:none'}"
            placeholder="External ID field (e.g. External_Id__c)"
            title="The external-Id field on the ROOT object used to match existing target records. Insert if no match, update if matched."
            value="${esc(_transferUpsertField)}">
        </div>
        <div class="ds-transfer-option">
          <label class="ds-transfer-option-label" for="dsTrApiMode">Engine:</label>
          <select id="dsTrApiMode" class="ds-select ds-select-sm" style="width:auto"
            title="How records are written. Auto: synchronous Collections calls (immediate per-record errors) below the threshold, one async Bulk API 2.0 job at or above it. Synchronous: always Collections, any volume — slower at scale but every error is immediate and per-record. Async: always a Bulk API 2.0 job, even for small sets — one job, results collected when Salesforce finishes.">
            <option value="auto" ${(_transferProfile?.apiMode || 'auto') === 'auto' ? 'selected' : ''}>Auto — Bulk job at ≥ ${Number(_transferProfile?.bulkThreshold) > 0 ? Number(_transferProfile.bulkThreshold).toLocaleString() : '2,000'}</option>
            <option value="sync" ${_transferProfile?.apiMode === 'sync' ? 'selected' : ''}>Synchronous — Collections only</option>
            <option value="bulk" ${_transferProfile?.apiMode === 'bulk' ? 'selected' : ''}>Async — Bulk API 2.0 job</option>
          </select>
          <label class="ds-transfer-option-label" for="dsTrBatchSize" style="margin-left:10px"
            title="Records per synchronous Collections call (1-200; 200 is the Salesforce maximum and the default). Smaller batches are slower but isolate failures and can duck per-transaction trigger CPU / row-lock limits in a busy target. Bulk jobs ignore this — Salesforce chunks those internally.">Batch size:</label>
          <input id="dsTrBatchSize" class="ds-input ds-input-sm" type="number" min="1" max="200" step="1"
            style="width:76px;text-align:right" value="${Math.max(1, Math.min(200, Number(_transferProfile?.batchSize) || 200))}"
            ${_transferProfile?.apiMode === 'bulk' ? 'disabled' : ''}>
          <label class="ds-transfer-option-label" for="dsTrThreads" style="margin-left:10px"
            title="How many batches run in parallel (1-6). Higher values are faster at scale, but parallel writes can hit row locks when records share a parent — lower this if you see UNABLE_TO_LOCK_ROW. Applies to the synchronous engine only; a Bulk job is a single upload.">Threads:</label>
          <input id="dsTrThreads" class="ds-input ds-input-sm" type="number" min="1" max="6" step="1"
            style="width:56px;text-align:right" value="${Math.max(1, Math.min(6, Number(_transferProfile?.threads) || 1))}"
            ${_transferProfile?.apiMode === 'bulk' ? 'disabled' : ''}>
          <span class="ds-subtext" style="font-size:11px" id="dsTrEngineNote">${_transferProfile?.apiMode === 'bulk' ? 'batch size / threads do not apply to Bulk jobs' : ''}</span>
        </div>
      </div>

      <div class="ds-transfer-footer">
        <button class="ds-btn" id="dsTrPreviewBtn" title="Re-count the records in scope">👁 Refresh counts</button>
        <button class="ds-btn" id="dsTrRecPreviewBtn" title="A record-by-record table of what this run will DO — every in-scope record with its operation (Insert / Update / duplicate warning), read from the last 🔄 scan.">📋 Records preview</button>
        <label class="ds-transfer-option-label" style="display:flex;align-items:center;gap:5px;cursor:pointer"
          title="Before anything is written, every object in this deployment is read from the target and kept on this PC as a restore point (the newest 10 runs). History then offers ↩ Roll back: delete what the run created, restore what it overwrote — after you review the exact counts. Objects above 50,000 rows (250,000 for insert-only runs) are skipped and the run log says so.">
          <input type="checkbox" id="dsTrUndoCapture" ${_settings.undoCapture === false ? '' : 'checked'}> 📸 restore point
        </label>
        <span id="dsTrValidHint" class="ds-tr-valid-hint"></span>
        <button class="ds-btn ds-btn-lg" id="dsTrValidateBtn" disabled
          title="Runs every safety check WITHOUT writing anything — required fields, lookup bridges (with live target probes), record types, child-first feasibility, value-level checks against sampled data. Honest limits: target validation rules, triggers and duplicate rules only fire on real writes, so a passing dry run can't vouch for those.">🧪 Dry Run (validate — no writes)</button>
        <button class="ds-btn ds-btn-lg" id="dsTrRunBtn" disabled>▶ Run Transfer</button>
      </div>
      <!-- E3: API-cost estimate + each org's daily-budget meter (informs, never blocks) -->
      <div id="dsTrApiBudget" class="ds-pk-note" style="margin:8px 0 0" aria-live="polite"></div>
    </div>`}

    <div id="dsTrProgressArea"></div>
  `);

  renderTrOrgPair();   // initial paint of the read-only org pair

  eid('dsTrBackBtn')?.addEventListener('click', () => {
    renderProfiles();
  });

  eid('dsTrProfile')?.addEventListener('change', e => {
    _transferProfile = _profiles[parseInt(e.target.value, 10)] || null;
    _transferNodeFilters = {};
    _transferOrgOverride = { src: null, tgt: null };   // new profile → its own org pair
    refreshTransferOrgsFromProfile();
    renderTrOrgPair();
    updateTransferPreview();
    updateTransferBtn();
    _trLastTotal = null;      // stale count belongs to the previous profile
    _trLastCounts = null;     // …and so does the API-cost estimate (E3)
    _trUpdateApiBudget();
    _syncRunButtons();
    _maybeAutoCount();
    if (_transferWriteMode === 'upsert') _loadUpsertFieldOptions();
    const editBtn = eid('dsTrEditProfile');
    if (editBtn) editBtn.disabled = !_transferProfile;
  });
  eid('dsTrEditProfile')?.addEventListener('click', () => {
    if (_transferProfile?.id) window.editProfile?.(_transferProfile.id);
  });
  eid('dsTrPreviewBtn')?.addEventListener('click', previewTransfer);
  eid('dsTrRecPreviewBtn')?.addEventListener('click', openRunRecordsPreview);
  eid('dsTrRunBtn')?.addEventListener('click', runTransfer);
  eid('dsTrUndoCapture')?.addEventListener('change', async e => {
    _settings.undoCapture = !!e.target.checked;
    await storageSaveSettings();
    showToast(_settings.undoCapture
      ? '📸 Restore points on — every data deployment can be rolled back from History'
      : '📸 Restore points off — runs from now on can NOT be rolled back', _settings.undoCapture ? 'info' : 'warning', 4500);
  });
  // ONE dry-run control (user 2026-08-09: "we have two dry run buttons why
  // do we need both" — the old checkbox merely relabelled ▶ Run into the
  // SAME validator this button triggers; two doors, one room). The flag
  // flips only for the duration of this click.
  eid('dsTrValidateBtn')?.addEventListener('click', async () => {
    _transferDryRun = true;
    try { await runTransfer(); }
    finally { _transferDryRun = false; _syncRunButtons(); }
  });
  eid('dsTrWriteMode')?.addEventListener('change', e => {
    _transferWriteMode = e.target.value;
    const fld = eid('dsTrUpsertField');
    if (fld) fld.style.display = _transferWriteMode === 'upsert' ? '' : 'none';
    if (_transferWriteMode === 'upsert') _loadUpsertFieldOptions();
    else { const sel = eid('dsTrUpsertSelect'); if (sel) sel.style.display = 'none'; }
  });
  eid('dsTrUpsertField')?.addEventListener('input', e => { _transferUpsertField = e.target.value.trim(); });
  // Engine controls persist ON THE PROFILE — the engine reads
  // profile.apiMode / profile.batchSize at run time, so a saved choice
  // applies to scheduled/fan-out runs of this deployment too.
  eid('dsTrApiMode')?.addEventListener('change', async e => {
    if (!_transferProfile) return;
    const v = e.target.value;
    if (v === 'sync' || v === 'bulk') _transferProfile.apiMode = v;
    else delete _transferProfile.apiMode;
    const note = eid('dsTrEngineNote');
    if (note) note.textContent = v === 'bulk' ? 'batch size / threads do not apply to Bulk jobs' : '';
    // Only the SYNCHRONOUS engine batches on the client — the inputs go
    // inert in Async mode so editable-but-ignored numbers can't mislead
    // (user 2026-08-18).
    const bi = eid('dsTrBatchSize');
    if (bi) bi.disabled = v === 'bulk';
    const ti = eid('dsTrThreads');
    if (ti) ti.disabled = v === 'bulk';
    await storageSaveProfiles();
  });
  eid('dsTrThreads')?.addEventListener('change', async e => {
    if (!_transferProfile) return;
    const n = Math.max(1, Math.min(6, parseInt(e.target.value, 10) || 1));
    e.target.value = n;
    if (n === 1) delete _transferProfile.threads;   // default stays implicit
    else _transferProfile.threads = n;
    await storageSaveProfiles();
  });
  eid('dsTrBatchSize')?.addEventListener('change', async e => {
    if (!_transferProfile) return;
    const n = Math.max(1, Math.min(200, parseInt(e.target.value, 10) || 200));
    e.target.value = n;
    if (n === 200) delete _transferProfile.batchSize;   // default stays implicit
    else _transferProfile.batchSize = n;
    await storageSaveProfiles();
  });
  eid('dsGoToProfiles')?.addEventListener('click', () => {
    document.querySelectorAll('.ds-nav-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.view === 'profiles'));
    _currentView = 'profiles';
    renderView('profiles');
  });

  if (_transferProfile) updateTransferPreview();
  updateTransferBtn();
  _syncRunButtons();
  if (_transferWriteMode === 'upsert') _loadUpsertFieldOptions();
  // Auto-count once per profile+pair+filters so the Run button shows the
  // magnitude without requiring the manual Preview click.
  _maybeAutoCount();
}

// Which footer button is the primary CTA? Until this profile+org-pair has a
// passing dry run this session, Validate leads; afterwards Run leads (with a
// "dry run passed" hint). The dry-run checkbox turns the Run button into the
// dry-run trigger, preserving the old behavior for users who prefer it.
// PURE — stable fingerprint of the payload a dry run actually validated:
// the effective tree plus the write mode ('insert', or the upsert External-ID
// field). Underscore keys (UI state like _meta.expanded) are stripped so
// folding a tree node doesn't un-validate a run. djb2-xor over the JSON.
function sftkValFingerprint(tree, upsertField) {
  let s;
  try {
    s = JSON.stringify(tree ?? null,
      (k, v) => (typeof k === 'string' && k.startsWith('_')) ? undefined : v)
      + '|' + (upsertField == null ? 'insert' : 'upsert:' + upsertField);
  } catch (_) { return 'fp0'; }
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return 'fp' + h.toString(36);
}

// The "✓ dry run passed" bookkeeping key. Fingerprints the EXACT payload the
// dry run validated — effective tree (run-time node filters and per-target
// mapping overrides applied) plus write mode — so a chip can only vouch for
// the write it actually checked. Pre-fix the key was profile|src|tgt alone:
// a clean fan-out dry run (raw saved tree, always insert) lit "✓ dry run
// passed" on a Transfer tab holding different run-time filters or Upsert
// mode, and vice versa. Org urls normalize via _orgKey so session urls and
// org-map urls build the same key.
function _valKey() {
  const fp = sftkValFingerprint(
    _transferProfile ? buildTransferProfile().tree : null,
    _transferWriteMode === 'upsert' ? (_transferUpsertField || '') : null);
  return `${_transferProfile?.id}|${_orgKey(_transferSrc?.orgUrl || '')}|${_orgKey(_transferTgt?.orgUrl || '')}|${fp}`;
}
function _syncRunButtons() {
  const run  = eid('dsTrRunBtn');
  const val  = eid('dsTrValidateBtn');
  const hint = eid('dsTrValidHint');
  if (!run) return;
  const validated = _validatedRuns.has(_valKey());
  if (_transferDryRun) {
    run.textContent = '🧪 Dry Run';
    run.classList.remove('ds-btn-primary');
    run.classList.add('ds-btn-primary-outline');
  } else {
    run.textContent = `▶ Run Transfer${_trLastTotal != null ? ` (${_trLastTotalIsBound ? '≤ ' : ''}${_trLastTotal.toLocaleString()} records)` : ''}`;
    run.classList.remove('ds-btn-primary-outline');
    run.classList.toggle('ds-btn-primary', validated);
  }
  if (val) val.classList.toggle('ds-btn-primary', !validated && !_transferDryRun);
  if (hint) hint.innerHTML = validated ? '<span class="ds-tr-validated">✓ dry run passed</span>' : '';
}

// Debounced-by-key auto count: runs the existing previewTransfer pass when
// the profile / org pair / run-time filters change, at most once per setup.
function _maybeAutoCount() {
  if (!_transferProfile || !_transferSrc?.sid) return;
  const key = `${_transferProfile.id}|${_transferSrc.orgUrl}|${JSON.stringify(_transferNodeFilters)}`;
  if (_trAutoCountKey === key) return;
  _trAutoCountKey = key;
  previewTransfer();
}

// Populate the upsert External-ID picker from the TARGET org's describe of
// the root object. Fields flagged externalId are the only ones Salesforce
// accepts for upsert — a select prevents the typo-fails-at-runtime path. The
// free-text input stays for the "Other…" escape hatch and when the describe
// finds nothing.
async function _loadUpsertFieldOptions() {
  const sel = eid('dsTrUpsertSelect');
  const inp = eid('dsTrUpsertField');
  if (!sel || !inp || !_transferTgt?.sid || !_transferProfile?.tree) return;
  const obj = _transferProfile.tree.objectType || _transferProfile.tree.childSObject;
  if (!obj) return;
  const desc = await sendBg({
    type: 'SF_REST_GET', orgUrl: _transferTgt.orgUrl, sid: _transferTgt.sid,
    path: `services/data/v62.0/sobjects/${obj}/describe`
  });
  if (_transferWriteMode !== 'upsert') return;   // user switched away mid-fetch
  const ext = (!desc?.error && Array.isArray(desc.fields))
    ? desc.fields.filter(f => f.externalId === true)
    : [];
  if (!ext.length) {   // no External-ID fields → keep the free-text input
    sel.style.display = '';
    sel.innerHTML = `<option value="">⚠ No External ID fields on ${esc(obj)} in target</option>`;
    // Say what to DO, not just what's missing (user 2026-08-09: "upsert can
    // work with regular id field too"): true — but a SOURCE record's Id
    // doesn't exist in the target org, so Id-keyed upsert needs the match
    // key to translate first. That flow exists today: Reconcile.
    sel.title = `Salesforce upsert needs a key the TARGET org can match on. It does accept Id — but a source record's Id doesn't exist in the target, so cross-org Id-upsert needs the match key to translate first. That flow exists today: run a scan and use Reconcile — it updates matched records by their target Id and inserts the rest (exact upsert semantics, no External ID field needed). Or add an External ID field to ${obj} in both orgs for direct upsert here.`;
    sel.disabled = true;
    inp.style.display = '';
    return;
  }
  sel.disabled = false;
  const known = ext.some(f => f.name === _transferUpsertField);
  sel.innerHTML = `
    <option value="">— pick External ID field —</option>
    ${ext.map(f => `<option value="${esc(f.name)}" ${f.name === _transferUpsertField ? 'selected' : ''}>${esc(f.label)} (${esc(f.name)})</option>`).join('')}
    <option value="__other__">✏ Other…</option>`;
  sel.style.display = '';
  inp.style.display = (known || !_transferUpsertField) ? 'none' : '';
  sel.onchange = () => {
    if (sel.value === '__other__') { inp.style.display = ''; inp.focus(); return; }
    _transferUpsertField = sel.value;
    inp.value = sel.value;
    inp.style.display = 'none';
  };
}

// Render the read-only "Source → Target" panel (replaces the old dropdowns).
// Shows the URLs the active profile points at + whether we can actually
// reach them right now. If a profile has no orgs set OR the orgs aren't
// reachable, this is where the user finds out (with a "✏ Edit profile" link).
function renderTrOrgPair() {
  const wrap = eid('dsTrOrgPair');
  if (!wrap) return;

  if (!_transferProfile) {
    wrap.innerHTML = '';
    return;
  }

  const p       = _transferProfile;
  const allSess = _buildAllSessions();
  const srcUrl  = _transferOrgOverride.src || p.sourceOrg || _workingPair.src || '';
  const tgtUrl  = _transferOrgOverride.tgt || p.targetOrg || _workingPair.tgt || '';
  const overridden = !!(_transferOrgOverride.src || _transferOrgOverride.tgt);

  // The target is ONE of this deployment's ring targets (user 2026-09-14:
  // "when you start a profile you select a ring: the source and targets …
  // you do it one by one"); the source is the deployment's source. No free
  // org pair here any more — the ring is chosen in the builder.
  const ringTargets = (typeof profileTargets === 'function' ? profileTargets(p) : []).filter(Boolean);
  const tgtChoices = ringTargets.slice();
  if (tgtUrl && !tgtChoices.some(u => _orgKey(u) === _orgKey(tgtUrl))) tgtChoices.push(tgtUrl);
  const knownOrgs = allMapOrgs();
  const labelOf = url => (knownOrgs.find(o => o.url === url) || {}).label || orgLabel(url);

  function chip(url, role, choices) {
    const sess      = url ? _resolveSession(url, allSess) : null;
    const reachable = !!(sess && sess.sid);
    const liveSet   = new Set(allSess.filter(s => s.sid).map(s => _orgKey(s.orgUrl)));
    const picker = Array.isArray(choices)
      ? `<select class="ds-select ds-select-sm ds-tr-org-select" data-tr-org-role="${role.toLowerCase()}" ${choices.length <= 1 ? 'disabled title="This deployment has one target — add more in ✏ Edit"' : ''}>
          ${url ? '' : '<option value="" selected>— pick a target —</option>'}
          ${choices.map(u => `<option value="${esc(u)}" ${u === url ? 'selected' : ''}>${esc(orgOptionLabel(u, labelOf(u), liveSet))}</option>`).join('')}
        </select>`
      : `<div class="ds-select ds-select-sm" style="pointer-events:none" title="The deployment's source — change it in ✏ Edit">${esc(orgOptionLabel(url, labelOf(url), liveSet))}</div>`;
    return `<div class="ds-tr-org-chip ${url && !reachable ? 'ds-tr-org-chip-unreachable' : ''}">
      <div class="ds-tr-org-chip-role">${role}</div>
      ${picker}
      <div class="ds-tr-org-chip-status">
        ${!url
          ? '<span style="color:#EA001E">●</span> Not set'
          : reachable
            ? '<span style="color:#2E844A">●</span> Session ready'
            : '<span style="color:#EA001E">●</span> Not open in Chrome — open it in a tab'}
      </div>
    </div>`;
  }

  wrap.innerHTML = `
    <div class="ds-tr-org-pair">
      ${chip(srcUrl, 'Source', null)}
      <span class="ds-tr-org-swap" style="pointer-events:none" title="records flow from the source to the chosen target">→</span>
      ${chip(tgtUrl, 'Target', tgtChoices)}
    </div>
    ${overridden ? `
      <div class="ds-tr-org-override-note">
        ⚙ Target changed for this run only — the deployment's first target is
        <strong>${esc(orgLabel(p.targetOrg || ''))}</strong>.
        <button class="ds-btn ds-btn-xs" id="dsTrOrgReset">↺ Reset to profile</button>
      </div>` : ''}`;

  // Wire: target change → set override (null when it matches the profile,
  // so the override note disappears when the user dials it back manually).
  wrap.querySelectorAll('.ds-tr-org-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const url  = sel.value || null;
      _transferOrgOverride.tgt = (url === p.targetOrg) ? null : url;
      window._dsTrRefreshOrgs?.();
      renderTrOrgPair();
      updateTransferPreview();
      updateTransferBtn();
      _trUpdateApiBudget();   // E3 — different org, different meter
    });
  });
  eid('dsTrOrgReset')?.addEventListener('click', () => {
    _transferOrgOverride = { src: null, tgt: null };
    window._dsTrRefreshOrgs?.();
    renderTrOrgPair();
    updateTransferPreview();
    updateTransferBtn();
    _trUpdateApiBudget();   // E3
  });
}

function updateTransferBtn() {
  const btn  = eid('dsTrRunBtn');
  const warn = eid('dsTrSessionWarn');
  if (!btn) return;

  // SIDs must be non-null — a session detected without a valid cookie would
  // appear in the dropdown but fail silently during the actual transfer.
  const srcOk = _transferSrc && !!_transferSrc.sid;
  const tgtOk = _transferTgt && !!_transferTgt.sid;
  const ready = !!_transferProfile && srcOk && tgtOk
    && _transferSrc.orgUrl !== _transferTgt.orgUrl;

  btn.disabled = !ready;
  const valBtn = eid('dsTrValidateBtn');
  if (valBtn) valBtn.disabled = !ready;

  // Surface a clear message instead of a silent failure when a session is expired
  if (warn) {
    const srcBad = _transferSrc && !_transferSrc.sid;
    const tgtBad = _transferTgt && !_transferTgt.sid;
    if (srcBad || tgtBad) {
      warn.style.display = '';
      warn.textContent = srcBad
        ? '⚠️ Source org session expired — open it in a browser tab and come back.'
        : '⚠️ Target org session expired — open it in a browser tab and come back.';
    } else {
      warn.style.display = 'none';
    }
  }
}

// ── Transfer filter helpers ───────────────────────────────────────
// Returns the effective { where, recordIds } for a node during a transfer run:
// run-time override from _transferNodeFilters takes priority over the saved profile.
function effectiveFilter(node, pathKey) {
  if (pathKey in _transferNodeFilters) return _transferNodeFilters[pathKey];
  return { where: node.where || null, recordIds: node.recordIds || null };
}

// Deep-clones the selected profile and patches each node's where/recordIds with
// any run-time overrides before sending to background.js or using in dry run.
function buildTransferProfile() {
  const clone = JSON.parse(JSON.stringify(_transferProfile));
  // Per-target mapping overrides resolve HERE — the engine sees one plain map.
  if (typeof treeForTarget === 'function' && clone.tree) {
    clone.tree = treeForTarget(clone.tree, _transferTgt?.orgUrl || clone.targetOrg);
  }
  function patch(node, path) {
    const pathKey = path.join('.');
    if (pathKey in _transferNodeFilters) {
      const ov = _transferNodeFilters[pathKey];
      node.where     = ov.where     ?? null;
      node.recordIds = ov.recordIds ?? null;
    }
    (node.children || []).forEach((c, i) => patch(c, [...path, i]));
  }
  patch(clone.tree, []);
  // Upsert config (root object only, v1) — attach when the user picked
  // Upsert mode and gave an external-Id field. executeProfileTransfer reads
  // profile.upsert.field and uses the Collections upsert endpoint for root.
  if (_transferWriteMode === 'upsert' && _transferUpsertField) {
    clone.upsert = { field: _transferUpsertField };
    // 🪪 Upserting on the identity field means the payload must carry THIS
    // source record's Id there — the engine writes it only when the node
    // names a stampField (re-review 2026-09-12: Run Transfer sent an empty
    // key, so nothing could ever match).
    if (clone.tree && typeof sftkIdFieldName === 'function'
        && String(_transferUpsertField).toLowerCase() === sftkIdFieldName().toLowerCase()) {
      clone.tree.stampField = sftkIdFieldName();
    }
  }
  // Keep the clone's org fields in step with the run-time override so
  // anything downstream that inspects profile.sourceOrg/targetOrg (logging,
  // error messages) reflects the orgs actually used this run.
  if (_transferOrgOverride.src) clone.sourceOrg = _transferOrgOverride.src;
  if (_transferOrgOverride.tgt) clone.targetOrg = _transferOrgOverride.tgt;
  return clone;
}

function updateTransferPreview(counts = null) {
  const area = eid('dsTrPreviewArea');
  if (!area || !_transferProfile?.tree) return;

  function renderNode(node, depth, path, countsNode) {
    const pathKey  = path.join('.');
    const name     = node.objectType || node.childSObject;
    const pad      = depth * 20;
    const ef       = effectiveFilter(node, pathKey);
    const isOverride = pathKey in _transferNodeFilters;

    // Build filter badge
    const filterBadge = ef.recordIds?.length
      ? `<span class="ds-tr-filter-badge ds-tr-filter-badge--ids">🎯 ${ef.recordIds.length} selected</span>`
      : ef.where
        ? `<span class="ds-tr-filter-badge">WHERE ${esc(ef.where)}</span>`
        : '';

    // Count badge (populated after Preview Counts)
    const countBadge = countsNode
      ? countsNode.count !== null
        ? `<span class="ds-tr-plan-count"${countsNode.unscoped ? ' title="Upper bound: SOQL cannot scope a grandchild to filtered parents, so this is the whole table — the run inserts only the children of the records actually in the run"' : ''}>${countsNode.unscoped ? '≤ ' : ''}${countsNode.count.toLocaleString()}</span>`
        : `<span class="ds-tr-plan-err">count failed</span>`
      : '';

    // Override indicator
    const overrideDot = isOverride
      ? `<span class="ds-tr-override-dot" title="Run-time filter override (profile not changed)">⚙</span>`
      : '';

    const canFilter = !!_transferSrc;
    const hasFilter = isOverride || ef.recordIds?.length || ef.where;
    // Label carries the object name so it's unambiguous WHICH object each
    // button filters — the buttons right-align per row and were reading as
    // one ambiguous pair. "Edit" vs "Filter" reflects whether this object
    // already has a record filter / WHERE set.
    const filterBtn = canFilter
      ? `<button class="ds-btn ds-btn-xs ds-tr-filter-btn" data-tr-filter-path="${esc(pathKey)}" data-tr-filter-obj="${esc(name)}"
           title="${hasFilter ? `Edit which ${esc(name)} records transfer` : `Choose which ${esc(name)} records transfer (pick records or set a WHERE clause)`}">
           ${hasFilter ? `🎯 Edit filter: ${esc(name)}` : `🎯 Filter ${esc(name)}`}
         </button>`
      // No source session ≠ no feature: a silently ABSENT button reads as
      // "record picking doesn't exist" (user report 2026-08-04). Render it
      // disabled and say exactly what unlocks it.
      : `<button class="ds-btn ds-btn-xs ds-tr-filter-btn" disabled
           title="Record filtering needs the source org — open ${esc(orgLabel(_transferProfile?.sourceOrg || '') || 'the source org')} in a Chrome tab, then reopen this page">
           🎯 Filter ${esc(name)}
         </button>`;

    const children = (node.children || []).map((c, i) =>
      renderNode(c, depth + 1, [...path, i], countsNode?.children?.[i])
    ).join('');

    return `
      <div class="ds-tr-plan-row" style="padding-left:${pad}px">
        <span class="ds-tr-plan-icon">${depth === 0 ? '📂' : '↳'}</span>
        <span class="ds-tr-plan-obj">${esc(name)}</span>
        ${overrideDot}${filterBadge}${countBadge}
        <span class="ds-tr-plan-row-actions">${filterBtn}</span>
      </div>
      ${children}`;
  }

  area.innerHTML = `
    <div class="ds-tr-tree-preview">
      <div class="ds-section-title" style="margin-bottom:8px;display:flex;align-items:center;gap:8px">
        Transfer Plan
        ${Object.keys(_transferNodeFilters).length
          ? `<span style="font-size:11px;font-weight:400;color:#5a3dbd">⚙ ${Object.keys(_transferNodeFilters).length} run-time filter${Object.keys(_transferNodeFilters).length !== 1 ? 's' : ''} active</span>`
          : ''}
      </div>
      ${renderNode(_transferProfile.tree, 0, [], counts)}
    </div>`;

  // Wire filter buttons
  area.querySelectorAll('.ds-tr-filter-btn').forEach(btn => {
    btn.addEventListener('click', () =>
      openTransferRecordFilterModal(btn.dataset.trFilterPath, btn.dataset.trFilterObj)
    );
  });
}

// PURE. The WHERE for counting ONE tree node the way the engine will READ it.
// The engine scopes every child to the parents actually in the run; a count
// that ignores that (SELECT COUNT() FROM Contact with no filter) reports the
// whole table — "I picked two records and it said 18" (user 2026-09-14).
//   node:   { objectType|childSObject, field, recordIds?, where? }
//   parent: null for the root, else { obj, where, semiJoin } from the parent's own count
// Returns { where, semiJoin, unscoped }. `unscoped` = SOQL cannot express the
// scope (a grandchild under a filtered parent — semi-joins do not nest), so
// the number must be shown as an upper bound, never as the count.
function sftkChildCountWhere(node, parent) {
  const ids = node && Array.isArray(node.recordIds) ? node.recordIds.filter(Boolean) : [];
  const own = ids.length
    ? `Id IN (${ids.map(id => `'${String(id).replace(/'/g, "\\'")}'`).join(',')})`
    : ((node && node.where) || null);
  if (!parent || !parent.where) return { where: own, semiJoin: false, unscoped: false };
  if (!node || !node.field || parent.semiJoin) return { where: own, semiJoin: false, unscoped: true };
  const scope = `${node.field} IN (SELECT Id FROM ${parent.obj} WHERE ${parent.where})`;
  return { where: own ? `(${own}) AND ${scope}` : scope, semiJoin: true, unscoped: false };
}

// PURE. "2 Account · ≤ 16 Contact" from a counts tree — the breakdown every
// "N records" claim carries, so a child count is never mistaken for parents.
function sftkCountBreakdown(counts) {
  const parts = [];
  (function walk(n) {
    if (!n) return;
    if (n.count != null) parts.push(`${n.unscoped ? '≤ ' : ''}${Number(n.count).toLocaleString()} ${n.obj}`);
    else if (n.obj) parts.push(`? ${n.obj}`);
    (n.children || []).forEach(walk);
  })(counts);
  return parts.join(' · ');
}

async function previewTransfer() {
  if (!_transferProfile || !_transferSrc) return;
  const area = eid('dsTrPreviewArea');

  // Show plan with a "counting…" skeleton first so filter buttons stay visible
  updateTransferPreview();
  if (area) {
    const title = area.querySelector('.ds-section-title');
    if (title) title.innerHTML = `Transfer Plan — <span style="color:var(--subtext);font-weight:400">counting in ${esc(orgLabel(_transferSrc.orgUrl))}…</span>`;
  }

  // Use the patched clone so overrides from _transferNodeFilters are applied
  const runProfile = buildTransferProfile();

  async function countNode(node, parent) {
    const obj = node.objectType || node.childSObject;
    // Children are counted INSIDE their parents' scope, like the engine reads
    // them (sftkChildCountWhere) — never the whole child table.
    const cw = sftkChildCountWhere(node, parent);   // node already patched by buildTransferProfile
    const where = cw.where;
    const res = await sendBg({
      type: 'SF_QUERY', tooling: false,
      orgUrl: _transferSrc.orgUrl, sid: _transferSrc.sid,
      query: `SELECT COUNT() FROM ${obj}${where ? ' WHERE ' + where : ''}`
    });
    const count    = res.error ? null : (res.totalSize ?? 0);
    const children = await Promise.all((node.children || []).map(c => countNode(c, { obj, where: cw.where, semiJoin: cw.semiJoin })));
    return { obj, count, unscoped: cw.unscoped, children };
  }

  const counts = await countNode(runProfile.tree, null);

  // Total across the tree — feeds the Run button label + the big-run gate.
  // An unscoped node makes the total an UPPER BOUND, and it is shown as one.
  let total = null, bound = false;
  (function sum(n) {
    if (!n) return;
    if (n.count != null) total = (total ?? 0) + n.count;
    if (n.unscoped) bound = true;
    (n.children || []).forEach(sum);
  })(counts);
  _trLastTotal = total;
  _trLastTotalIsBound = bound;
  _syncRunButtons();

  // E3 — fresh counts → refresh the API-cost line under the footer.
  _trLastCounts = counts;
  _trUpdateApiBudget();

  // Re-render plan with count badges inline — filter buttons stay wired
  updateTransferPreview(counts);
  const area2 = eid('dsTrPreviewArea');
  if (area2) {
    const title = area2.querySelector('.ds-section-title');
    if (title) {
      const overrideNote = title.querySelector('span');
      title.innerHTML = `Transfer Plan — <span style="color:var(--subtext);font-weight:400">counts from ${esc(orgLabel(_transferSrc.orgUrl))}</span>`;
      if (overrideNote) title.appendChild(overrideNote);
    }
  }
}

// ════════════════════════════════════════════════════════════════
// PII MASKING v1 — dry-run disclosure & masked-value planning
// ════════════════════════════════════════════════════════════════
// The engine masks policy-covered fields AT WRITE TIME (background.js:
// sftkPiiRulesForObject → sftkPiiMaskRows), so the dry run must validate the
// MASKED values — a hashed string can never pass a restricted picklist, and
// a raw sample passing proves nothing about what actually lands. These
// helpers mirror the engine's rule resolution (SOURCE describe,
// case-insensitive API names, engine-resolved fields excluded) studio-side;
// the masking itself always goes through sftkPiiMaskValue (sftk-pii.js),
// the ONE implementation, so dry run and real run can never disagree.

// PURE — does any policy key target this object? Cheap pre-describe gate so
// uncovered objects never pay the extra describe fetch.
function sftkPiiPolicyCovers(policy, objectApi) {
  if (!policy || !objectApi) return false;
  const prefix = String(objectApi).toLowerCase() + '.';
  return Object.keys(policy).some(k => policy[k] && k.toLowerCase().startsWith(prefix));
}

// PURE — the policy rule covering <objectApi>.<fieldApi>, or null. API names
// compare case-insensitively — same rule as the engine's rule resolution.
function sftkPiiRuleFor(policy, objectApi, fieldApi) {
  if (!policy || !objectApi || !fieldApi) return null;
  const want = (String(objectApi) + '.' + String(fieldApi)).toLowerCase();
  for (const [k, rule] of Object.entries(policy)) {
    if (rule && k.toLowerCase() === want) return rule;
  }
  return null;
}

// PURE — per-object mask plan: which fields the engine will mask, and HOW.
// Mirrors background.js sftkPiiRulesForObject: engine-resolved fields
// (Id/RecordTypeId/OwnerId/audit) and fields absent from the SOURCE describe
// are excluded — their rules cannot change what lands. `action` is the plan
// for a NON-EMPTY value ('kept' never appears at plan level):
//   'fixed'  — fixed strategy;
//   'hashed' — hash strategy on a maskable type;
//   'nulled' — null strategy, hash on a non-maskable type, or an
//              unrecognized strategy (the library's fail-closed branch).
// → null when no rule touches this object, else
//   { fields: { <FieldApi>: { rule, desc, action } },
//     counts: { hashed, nulled, fixed }, total,
//     unwritable: [<FieldApi>] } — rules on non-createable fields (the
//     compound-Name trap), excluded from counts, surfaced as a warning.
function sftkPiiDryPlan(policy, objectApi, srcFields) {
  if (!policy || !objectApi) return null;
  const RESOLVED = new Set(['id', 'recordtypeid', 'ownerid', 'createdbyid',
    'lastmodifiedbyid', 'createddate', 'lastmodifieddate', 'systemmodstamp', 'isdeleted']);
  const descByLower = Object.create(null);
  for (const f of (srcFields || [])) if (f && f.name) descByLower[f.name.toLowerCase()] = f;
  const objLower = String(objectApi).toLowerCase();
  let fields = null;
  const counts = { hashed: 0, nulled: 0, fixed: 0 };
  const unwritable = [];
  for (const [key, rule] of Object.entries(policy)) {
    if (!rule) continue;
    const dot = key.indexOf('.');
    if (dot <= 0) continue;
    if (key.slice(0, dot).toLowerCase() !== objLower) continue;
    const fLower = key.slice(dot + 1).toLowerCase();
    if (RESOLVED.has(fLower)) continue;
    const desc = descByLower[fLower];
    if (!desc) continue;
    // The payload never sends a non-createable field (the compound-Name
    // trap) — the engine excludes it and emits a diagnostic; counting it
    // here would over-disclose. Carried separately so the dry run can
    // mirror that warning instead of silently under-reporting coverage.
    if (desc.createable === false) { unwritable.push(desc.name); continue; }
    const action = rule.strategy === 'fixed' ? 'fixed'
      : (rule.strategy === 'hash' && sftkPiiMaskable(desc)) ? 'hashed'
      : 'nulled';
    counts[action]++;
    if (!fields) fields = Object.create(null);
    fields[desc.name] = { rule, desc, action };
  }
  return (fields || unwritable.length)
    ? { fields: fields || Object.create(null), counts,
        total: counts.hashed + counts.nulled + counts.fixed, unwritable }
    : null;
}

// PURE — the per-object disclosure line ("masked", never the banned
// stronger claim — deterministic hashing is pseudonymization). "fixed" only
// appears when a fixed rule is present, so the common two-count line reads
// exactly as specified.
function sftkPiiDryPlanLine(objectApi, plan) {
  const c = plan.counts;
  const fixedTail = c.fixed ? `, ${c.fixed} fixed` : '';
  return `${objectApi}: ${plan.total} field(s) masked before writing (${c.hashed} hashed, ${c.nulled} set to null${fixedTail})`;
}

// Substitute each sampled row's covered fields with the value the engine
// would WRITE. Empty values pass through untouched (the library's 'kept').
// Per-call cache: 200-row samples repeat values and hashing is async crypto.
async function sftkPiiMaskSampleRows(rows, plan, salt) {
  const out = [];
  const cache = new Map();
  for (const r of (rows || [])) {
    const m = Object.assign({}, r);
    for (const fn of Object.keys(plan.fields)) {
      const v = m[fn];
      if (v === null || v === undefined || v === '') continue;
      const ck = fn + '|' + String(v);
      let res = cache.get(ck);
      if (!res) {
        res = await sftkPiiMaskValue(v, plan.fields[fn].desc, salt, plan.fields[fn].rule);
        cache.set(ck, res);
      }
      m[fn] = res.value;
    }
    out.push(m);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// THE DRY-RUN VALIDATOR — one implementation, any (source → target) pair
// ════════════════════════════════════════════════════════════════
// This used to be a 430-line block welded inside runTransfer's
// `if (_transferDryRun)`, closing over _transferSrc / _transferTgt /
// logRow / dryRunIssues. That made it unreachable from the fan-out runner —
// so the moment a deployment had 2+ targets (runProfile routes straight into
// openFanOut), the best safety net in the product silently vanished and the
// run went to real writes across every org. Lifting it out changes nothing
// about WHAT it checks: every message string, every counter increment and
// the order of every log line are preserved exactly.
//
// It WRITES NOTHING. The only messages it can send are SF_QUERY (read) and
// SF_REST_GET (describe) — see test/fanout-dryrun.test.mjs, which pins that
// at the source level.
//
//   profileTree — the tree the REAL run would send (already patched by
//                 buildTransferProfile() / treeForTarget()), not the raw one.
//   srcSess/tgtSess — { orgUrl, sid }.
//   log(icon, msg, cls) — caller-supplied line writer, so the same validator
//                 can paint the transfer progress log or a fan-out panel.
//   ownerMapping — profile.ownerMapping, for the owner-fallback sanity line.
//   piiPolicy / piiSalt — profile.piiPolicy / profile.piiSalt (PII MASKING
//                 v1), threaded like ownerMapping: per-object masking
//                 disclosure, masked-value preflight, match-key warnings,
//                 and the missing-salt hard error the engine would throw.
//   upsertField — the root object's External-ID for an Upsert run (null on
//                 insert) — read ONLY to warn when the policy masks it.
//
// Returns { issues, checked, unchecked }:
//   issues    — the original dryRunIssues counter, unchanged.
//   checked   — objects whose validation actually ran.
//   unchecked — objects whose validation could NOT run (source query failed,
//               target describe failed). NOT the same as "clean": a caller
//               that reports a target clean while this is non-zero is lying.
async function sftkDryRunAgainst(profileTree, srcSess, tgtSess, log, ownerMapping, piiPolicy, piiSalt, upsertField) {
  const logRow = log;
  let issues = 0, checked = 0, unchecked = 0;
  // Every node in a subtree, itself included — when a node's source query
  // fails we bail before recursing, and its NEVER-VISITED children must land
  // in `unchecked`, not silently vanish from both counters.
  const subtreeSize = n => 1 + (n.children || []).reduce((s, c) => s + subtreeSize(c), 0);

  // PII MASKING v1 — a policy without its machine-local salt is the SAME
  // hard error the engine throws before any org call (falling back would
  // write raw PII). Surfaced as an issue BEFORE any target work, with the
  // whole tree unchecked: nothing was validated, and the real run cannot
  // start until the salt exists. Unfiltered Object.keys mirrors the engine's
  // gate exactly.
  const piiKeys = (piiPolicy && typeof piiPolicy === 'object') ? Object.keys(piiPolicy) : [];
  if (piiKeys.length && !piiSalt) {
    logRow('❌', 'PII policy has no salt — open the deployment in the builder once', 'ds-prog-err');
    return { issues: 1, checked: 0, unchecked: profileTree ? subtreeSize(profileTree) : 0 };
  }

  async function dryRunNode(node) {
    const obj = node.objectType || node.childSObject;

    // Match the REAL executor's record scoping: picked recordIds take
    // priority over the WHERE clause (background.js does the same). The
    // dry run previously used only node.where, so a "🎯 N selected"
    // profile was validated against the ENTIRE table — wrong counts,
    // null-sampling false alarms from unselected rows, missed issues.
    const dryWhere = (Array.isArray(node.recordIds) && node.recordIds.length)
      ? `Id IN (${node.recordIds.filter(Boolean).map(id => `'${id}'`).join(',')})`
      : (node.where || '');

    // ── Step 1: count records in source ──────────────────────────
    const countRes = await sendBg({
      type: 'SF_QUERY', tooling: false,
      orgUrl: srcSess.orgUrl, sid: srcSess.sid,
      query: `SELECT COUNT() FROM ${obj}${dryWhere ? ' WHERE ' + dryWhere : ''}`
    });
    if (countRes.error) {
      logRow('❌', `${obj}: source query failed — ${countRes.error}`, 'ds-prog-err');
      issues++;
      // The early return skips this node AND its whole subtree — count all
      // of them as unchecked so the verdict can't call this target clean.
      unchecked += subtreeSize(node);
      return;
    }
    const srcCount = countRes.totalSize ?? 0;

    // ── Step 2: get required fields from TARGET org describe ──────
    const tgtDesc = await sendBg({
      type: 'SF_REST_GET',
      orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
      path: `services/data/v62.0/sobjects/${obj}/describe`
    });
    // LATENT BUG, reported not fixed (extraction is a refactor): when the
    // TARGET describe fails, requiredInTarget silently falls back to [] and
    // Step 4 below logs "all required fields present" — a green line for a
    // check that never ran. Every message here is byte-identical to the
    // pre-extraction code, so that line still lies to a single-target dry
    // run; what IS new is the `unchecked` counter, which lets a caller
    // refuse to call this target clean. Fix the message in a separate change.
    //
    // W1 — say when a node UPSERTS: the single biggest behavior difference
    // a run can have (re-runs update instead of duplicate).
    if (node.upsert?.field) {
      logRow('⬆', `${obj}: upserts on ${node.upsert.field} — records whose key already exists in the target are UPDATED, not duplicated.`);
    }
    // A node lands in exactly ONE bucket: `checked` only when its target
    // describe was readable (pre-fix it got checked++ AND unchecked++, so
    // one describe-failed node inflated both counters at once).
    if (tgtDesc.error) unchecked++; else checked++;
    const SYSTEM_SKIP = new Set(['Id','IsDeleted','CreatedDate','CreatedById',
      'LastModifiedDate','LastModifiedById','SystemModstamp','OwnerId']);
    const requiredInTarget = tgtDesc.error ? [] :
      (tgtDesc.fields || [])
        .filter(f => f.createable && !f.nillable && f.defaultValue === null && !SYSTEM_SKIP.has(f.name))
        .map(f => f.name);

    // ── Child-first feasibility ───────────────────────────────────────────
    // A child-first node inserts BEFORE its parent (parent-link field left
    // empty) and gets linked by an UPDATE afterwards. That's only possible
    // when the link field is optional at insert AND updateable in the
    // target. The generic required-field check below can't catch this (the
    // source rows DO have parent values — they're just deliberately not
    // sent), so a real run would fail 100% while dry run passed.
    if (node.insertOrder === 'childFirst' && node.field && !tgtDesc.error) {
      // Resolve the link field the way the executor does — through the
      // node's field mapping. null = user excluded the link (records will
      // never be wired); a rename means the TARGET name must be checked.
      const fmLink = node.fieldMappings ? node.fieldMappings[node.field] : undefined;
      if (fmLink === null) {
        logRow('⚠️', `${obj}: child-first — the parent link field ${node.field} is excluded by the field mapping ("Set null"), so these records will be created but never linked to their parent.`, 'ds-prog-warn');
      } else {
        const linkName = fmLink || node.field;
        const mapped   = linkName !== node.field ? ` (mapped from ${node.field})` : '';
        const pf = (tgtDesc.fields || []).find(f => f.name === linkName);
        if (!pf) {
          logRow('❌', `${obj}: child-first — parent link field ${linkName}${mapped} doesn't exist in the target org`, 'ds-prog-err');
          issues++;
        } else {
          if (pf.nillable === false) {
            logRow('❌', `${obj}: child-first won't work — ${linkName}${mapped} is REQUIRED in the target (master-detail or required lookup), so these records can't be created before their parent. Switch the node back to default order.`, 'ds-prog-err');
            issues++;
          }
          if (pf.updateable === false) {
            logRow('❌', `${obj}: child-first won't work — ${linkName}${mapped} is not updateable in the target, so these records can't be linked to their parent after creation.`, 'ds-prog-err');
            issues++;
          }
          if (pf.nillable !== false && pf.updateable !== false) {
            logRow('✅', `${obj}: child-first OK — ${linkName}${mapped} is optional and updateable in the target ✓`);
          }
        }
      }
    }

    // ── PII MASKING v1: per-object disclosure + masked-value planning ─────
    // The plan resolves against the SOURCE describe, exactly like the
    // engine, and the value checks below then validate what the run will
    // WRITE (masked values), never the raw sample.
    let piiPlan = null;
    if (piiKeys.length && sftkPiiPolicyCovers(piiPolicy, obj)) {
      const srcDescPii = await sendBg({
        type: 'SF_REST_GET',
        orgUrl: srcSess.orgUrl, sid: srcSess.sid,
        path: `services/data/v62.0/sobjects/${obj}/describe`
      });
      if (srcDescPii.error) {
        logRow('⚠️', `${obj}: PII masking is configured here but the source describe failed (${srcDescPii.error}) — masked values could NOT be validated on this object.`, 'ds-prog-warn');
      } else {
        piiPlan = sftkPiiDryPlan(piiPolicy, obj, srcDescPii.fields);
        if (piiPlan && piiPlan.total > 0) logRow('🎭', sftkPiiDryPlanLine(obj, piiPlan));
        // Mirror the engine's compound-Name diagnostic: a rule on a field
        // the payload never sends must not read as coverage.
        if (piiPlan && piiPlan.unwritable.length) {
          logRow('⚠️', `${obj}: the PII policy covers [${piiPlan.unwritable.join(', ')}] which the payload never sends (not createable in the source) — make sure the writable field(s) carrying that data have their own rules (a compound Name writes through FirstName/LastName).`, 'ds-prog-warn');
        }
      }
    }
    // A lookup bridge that matches on a masked anchor: the engine compares
    // hash-covered anchors masked-to-masked and SKIPS null/fixed-covered
    // bridges entirely — either way, matching an unmasked target breaks.
    if (piiKeys.length && node.lookupResolutions) {
      for (const [lookupField, lr] of Object.entries(node.lookupResolutions)) {
        if (!lr || lr.strategy !== 'match' || !lr.matchField || !lr.matchObject) continue;
        const anchorRule = sftkPiiRuleFor(piiPolicy, lr.matchObject, lr.matchField);
        if (!anchorRule) continue;
        if (anchorRule.strategy === 'hash') {
          logRow('⚠', `${obj}.${lookupField}: resolves by matching ${lr.matchObject}.${lr.matchField}, which this policy masks — deterministic masking only matches targets seeded with the same salt, so against an unmasked target the bridge finds nothing and the lookup lands null.`, 'ds-prog-warn');
        } else {
          logRow('⚠', `${obj}.${lookupField}: resolves by matching ${lr.matchObject}.${lr.matchField}, but its "${anchorRule.strategy}" rule collapses every anchor to one value — the engine skips this bridge entirely and the lookup lands null.`, 'ds-prog-warn');
        }
      }
    }

    // ── Step 3: cross-check which required-target fields exist in source ──
    // CRITICAL: this must apply the same field-mapping logic the real transfer
    // uses, otherwise a profile that maps `LastName → null` (or maps it to a
    // different target field) passes dry run but fails the real INSERT with
    // "Required fields are missing: [LastName]".
    let fieldIssues = [];
    if (requiredInTarget.length && srcCount > 0) {
      // Get source describe to know which fields actually exist there
      const srcDesc = await sendBg({
        type: 'SF_REST_GET',
        orgUrl: srcSess.orgUrl, sid: srcSess.sid,
        path: `services/data/v62.0/sobjects/${obj}/describe`
      });
      const srcFields = srcDesc.error ? [] : (srcDesc.fields || []);
      const srcFieldNames = new Set(srcFields.map(f => f.name));

      // Build the "what source field will populate each target field" map by
      // simulating the executor's payload-building loop.
      //   - fm[srcField] === null   → source field is dropped entirely
      //   - fm[srcField] === 'X'    → source field is renamed to target.X
      //   - srcField not in fm      → identity passthrough (source.X → target.X)
      const fm = node.fieldMappings || {};
      const sourceForTarget = {};  // tgtField → srcField that will populate it
      const dupTargets = [];       // mapping collisions — two sources, one target
      for (const f of srcFields) {
        if (!f.createable) continue;
        if (fm[f.name] === null) continue;                       // user-excluded
        const tgtField = (f.name in fm && fm[f.name]) ? fm[f.name] : f.name;
        // First source field "wins" the target slot (matches executor behaviour)
        if (!(tgtField in sourceForTarget)) sourceForTarget[tgtField] = f.name;
        else dupTargets.push(`${tgtField} ← ${sourceForTarget[tgtField]} AND ${f.name}`);
      }
      // Two source fields writing the same target silently means "one value
      // wins" — almost always a corrupted or experimental mapping. Warn.
      if (dupTargets.length) {
        logRow('⚠', `${obj}: ${dupTargets.length} field-mapping collision(s) — two source fields write the same target field (${dupTargets.slice(0, 5).join('; ')}) — only one value can win. Fix in ✏ Edit → Fields & mapping.`, 'ds-prog-warn');
      }

      // Bucket each required-in-target field by how it will (or won't) be populated
      const droppedByMapping = [];   // required field is in source but mapped to null
      const missingInSrc     = [];   // required field has no source field producing it
      const nullCheckPairs   = [];   // [{ tgtField, srcField }] — needs row-level null check

      for (const reqTgt of requiredInTarget) {
        const srcFieldForReq = sourceForTarget[reqTgt];
        if (srcFieldForReq) {
          nullCheckPairs.push({ tgtField: reqTgt, srcField: srcFieldForReq });
        } else if (fm[reqTgt] === null && srcFieldNames.has(reqTgt)) {
          droppedByMapping.push(reqTgt);
        } else {
          missingInSrc.push(reqTgt);
        }
      }

      droppedByMapping.forEach(f => fieldIssues.push({ fieldName: f, droppedByMapping: true }));
      missingInSrc.forEach(f    => fieldIssues.push({ fieldName: f, missingFromSource: true }));

      // Row-level null check — sample real data on the source side of the mapping
      if (nullCheckPairs.length) {
        const selectFields = ['Id', ...new Set(nullCheckPairs.map(p => p.srcField))].join(', ');
        const sampleRes = await sendBg({
          type: 'SF_QUERY', tooling: false,
          orgUrl: srcSess.orgUrl, sid: srcSess.sid,
          query: `SELECT ${selectFields} FROM ${obj}${dryWhere ? ' WHERE ' + dryWhere : ''} LIMIT 200`
        });
        if (!sampleRes.error) {
          // PII MASKING v1 — count nulls in what the engine will WRITE: a
          // null rule (or hash on a non-maskable type) nulls every non-empty
          // row, and a raw sample passing would hide that certain failure.
          const nullCheckRows = piiPlan
            ? await sftkPiiMaskSampleRows(sampleRes.records || [], piiPlan, piiSalt)
            : (sampleRes.records || []);
          for (const { tgtField, srcField } of nullCheckPairs) {
            const nullCount = nullCheckRows
              .filter(r => r[srcField] === null || r[srcField] === undefined || r[srcField] === '').length;
            if (nullCount > 0) {
              fieldIssues.push({
                fieldName: tgtField, srcField,
                nullCount, total: sampleRes.records.length
              });
            }
          }
        }
      }
    }

    // ── Step 4: log required-field results ───────────────────────
    if (fieldIssues.length) {
      issues += fieldIssues.length;
      logRow('⚠️', `${obj}: ${srcCount} record(s) found — ${fieldIssues.length} required field issue(s):`, 'ds-prog-warn');
      for (const issue of fieldIssues) {
        if (issue.droppedByMapping) {
          logRow('❌',
            `  ${issue.fieldName}: required in target but excluded by your field mapping — ` +
            `target inserts will fail. Open "Edit profile" and map this field back.`,
            'ds-prog-err');
        } else if (issue.missingFromSource) {
          logRow('❌',
            `  ${issue.fieldName}: required in target, but no source field is mapped to it`,
            'ds-prog-err');
        } else {
          const via = issue.srcField && issue.srcField !== issue.fieldName
            ? ` (via source field ${issue.srcField})` : '';
          logRow('❌',
            `  ${issue.fieldName}: ${issue.nullCount} of ${issue.total} sampled records have no value (required in target)${via}`,
            'ds-prog-err');
        }
      }
    } else {
      logRow('✅', `${obj}: ${srcCount} record(s) — all required fields present`);
    }

    // ── Step 4b: source fields the target org can't accept ───────
    // Mirrors the real transfer, which skips fields that aren't createable
    // in the target. Without this, a dry run could pass while the real run
    // dropped fields — the "dry run passes, real fails" gap.
    if (srcCount > 0 && !tgtDesc.error) {
      const tgtCreatable = new Set(
        (tgtDesc.fields || []).filter(f => f.createable).map(f => f.name)
      );
      const srcDescFull = await sendBg({
        type: 'SF_REST_GET',
        orgUrl: srcSess.orgUrl, sid: srcSess.sid,
        path: `services/data/v62.0/sobjects/${obj}/describe`
      });
      if (!srcDescFull.error) {
        const fm = node.fieldMappings || {};
        const wontTransfer = [];
        for (const f of (srcDescFull.fields || [])) {
          if (!f.createable || SYSTEM_SKIP.has(f.name) || f.name === 'RecordTypeId') continue;
          if (fm[f.name] === null) continue;  // user-excluded — intentional
          const tgtField = (f.name in fm && fm[f.name]) ? fm[f.name] : f.name;
          if (!tgtCreatable.has(tgtField)) wontTransfer.push(tgtField);
        }
        if (wontTransfer.length) {
          logRow('⚠️',
            `${obj}: ${wontTransfer.length} field(s) won't transfer — not writable in target ` +
            `(${wontTransfer.slice(0, 8).join(', ')}${wontTransfer.length > 8 ? '…' : ''})`,
            'ds-prog-warn');
        }

        // ── Step 4c: VALUE preflight — restricted picklists, State/Country,
        // field lengths. This is the classic "dry run passes, real run
        // fails" gap: Salesforce only validates VALUES on a real write, but
        // INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST, FIELD_INTEGRITY_EXCEPTION
        // (state/country) and STRING_TOO_LONG are all predictable from the
        // two describes plus a sample of the actual source data.
        const tgtByName = new Map((tgtDesc.fields || []).map(f => [f.name, f]));
        const valueChecks = [];   // { srcField, tgtField, tgtMeta, kind }
        for (const f of (srcDescFull.fields || [])) {
          if (!f.createable || SYSTEM_SKIP.has(f.name) || f.name === 'RecordTypeId') continue;
          if (fm[f.name] === null) continue;
          const tgtField = (f.name in fm && fm[f.name]) ? fm[f.name] : f.name;
          const t = tgtByName.get(tgtField);
          if (!t || !t.createable) continue;   // already reported in 4b
          if ((t.type === 'picklist' || t.type === 'multipicklist') && t.restrictedPicklist) {
            valueChecks.push({ srcField: f.name, tgtField, tgtMeta: t, kind: 'picklist' });
          } else if (typeof t.length === 'number' && t.length > 0 && typeof f.length === 'number' && f.length > t.length
                     && ['string', 'textarea', 'url', 'email', 'phone'].includes(t.type)) {
            valueChecks.push({ srcField: f.name, tgtField, tgtMeta: t, kind: 'length' });
          }
          // State/Country picklists: the TEXT field (e.g. BillingState)
          // validates against integration values when the target org has
          // them enabled — visible in the describe as a sibling *Code field.
          const sc = /^(Billing|Shipping|Mailing|Other)?(State|Country)$/.exec(tgtField);
          if (sc && tgtByName.has(`${sc[1] || ''}${sc[2]}Code`)) {
            valueChecks.push({ srcField: f.name, tgtField, tgtMeta: tgtByName.get(`${sc[1] || ''}${sc[2]}Code`), kind: 'state' });
          }
        }
        if (valueChecks.length) {
          const CHECK_CAP = 40;
          const capped = valueChecks.slice(0, CHECK_CAP);
          if (valueChecks.length > CHECK_CAP) {
            logRow('⚠️', `${obj}: value preflight covers the first ${CHECK_CAP} of ${valueChecks.length} checkable fields — the rest are NOT value-checked.`, 'ds-prog-warn');
          }
          const sampleQ = await sendBg({
            type: 'SF_QUERY', tooling: false,
            orgUrl: srcSess.orgUrl, sid: srcSess.sid,
            query: `SELECT ${['Id', ...new Set(capped.map(c => c.srcField))].join(', ')} FROM ${obj}${dryWhere ? ' WHERE ' + dryWhere : ''} LIMIT 200`,
          });
          if (sampleQ.error) {
            logRow('⚠️', `${obj}: value preflight sample failed — ${sampleQ.error}`, 'ds-prog-warn');
          } else {
            // PII MASKING v1 — the checks below must see the MASKED values:
            // they are what the real run writes, and e.g. a hashed string
            // can never satisfy a restricted picklist even when every raw
            // value would. Also keeps raw covered values out of log lines.
            const rows = piiPlan
              ? await sftkPiiMaskSampleRows(sampleQ.records || [], piiPlan, piiSalt)
              : (sampleQ.records || []);
            for (const c of capped) {
              if (c.kind === 'length') {
                let worst = 0, hits = 0;
                for (const r of rows) {
                  const len = (r[c.srcField] == null) ? 0 : String(r[c.srcField]).length;
                  if (len > c.tgtMeta.length) { hits++; if (len > worst) worst = len; }
                }
                if (hits) {
                  issues++;
                  // A covered field's oversize values are the MASKED ones —
                  // "shorten the data" would be the wrong advice there.
                  const remedy = (piiPlan && piiPlan.fields[c.srcField])
                    ? 'These are the MASKED values the PII policy writes — widen the target field or switch the field\'s rule to "null" or a shorter "fixed" value.'
                    : 'Shorten the data or widen the target field.';
                  logRow('❌', `${obj}.${c.tgtField}: target field takes ${c.tgtMeta.length} chars but ${hits} of ${rows.length} sampled record(s) exceed that (longest ${worst}) — the real run fails with STRING_TOO_LONG. ${remedy}`, 'ds-prog-err');
                }
                continue;
              }
              // picklist + state share the "value must be in this set" shape;
              // state also accepts the code-field's codes (TX) AND labels (Texas).
              const allowed = new Set();
              for (const v of (c.tgtMeta.picklistValues || [])) {
                if (v.active === false) continue;
                allowed.add(v.value);
                if (c.kind === 'state' && v.label) allowed.add(v.label);
              }
              const bad = new Map();   // offending value → sampled record count
              for (const r of rows) {
                const raw = r[c.srcField];
                if (raw == null || raw === '') continue;
                const vals = (c.kind === 'picklist' && c.tgtMeta.type === 'multipicklist') ? String(raw).split(';') : [String(raw)];
                for (const v of vals) if (v && !allowed.has(v)) bad.set(v, (bad.get(v) || 0) + 1);
              }
              if (bad.size) {
                issues++;
                const list = [...bad.entries()].slice(0, 6).map(([v, n]) => `“${v}” (${n}×)`).join(', ');
                if (c.kind === 'state') {
                  logRow('❌', `${obj}.${c.tgtField}: the target enforces State/Country picklists and these sampled value(s) match neither a code nor a label there: ${list}${bad.size > 6 ? '…' : ''} — the real run fails with FIELD_INTEGRITY_EXCEPTION. Fix the source data or align the target's integration values.`, 'ds-prog-err');
                } else if (piiPlan && piiPlan.fields[c.srcField]) {
                  // Masked variant: a hashed value can NEVER be in the value
                  // set, and "fix the source data" would be the wrong advice.
                  logRow('❌', `${obj}.${c.tgtField}: restricted picklist in the target — this field is masked by the PII policy, and its masked value(s) can never be in the target's active value set: ${list}${bad.size > 6 ? '…' : ''} — the real run fails with INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST. Point the field's rule at "null" or a "fixed" allowed value instead of hashing.`, 'ds-prog-err');
                } else {
                  logRow('❌', `${obj}.${c.tgtField}: restricted picklist in the target — sampled value(s) not in its active value set: ${list}${bad.size > 6 ? '…' : ''} — the real run fails with INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST. Add the value(s) in the target via the Picklist Manager, or remap the data first.`, 'ds-prog-err');
                }
              } else {
                logRow('✅', `${obj}.${c.tgtField}: all sampled values are accepted by the target ${c.kind === 'state' ? 'State/Country picklist' : 'restricted picklist'} ✓`);
              }
            }
          }
        }
      }
    }

    // ── Step 4d: what a dry run CANNOT test — say so, with names ──
    // Validation rules, Apex triggers and duplicate rules only fire on a
    // real write. List the active ones in the target so a clean dry run is
    // never read as "the real run cannot fail".
    if (srcCount > 0) {
      const auto = [];
      const vr = await sendBg({ type: 'SF_QUERY', tooling: true, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
        query: `SELECT ValidationName FROM ValidationRule WHERE Active = true AND EntityDefinition.QualifiedApiName = '${obj}'` });
      if (!vr.error && (vr.records || []).length) auto.push(`${vr.records.length} validation rule(s) — ${vr.records.slice(0, 5).map(r => r.ValidationName).join(', ')}${vr.records.length > 5 ? '…' : ''}`);
      const tg = await sendBg({ type: 'SF_QUERY', tooling: true, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
        query: `SELECT Name FROM ApexTrigger WHERE Status = 'Active' AND TableEnumOrId = '${obj}'` });
      if (!tg.error && (tg.records || []).length) auto.push(`${tg.records.length} Apex trigger(s) — ${tg.records.slice(0, 5).map(r => r.Name).join(', ')}${tg.records.length > 5 ? '…' : ''}`);
      const dr = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
        query: `SELECT DeveloperName FROM DuplicateRule WHERE IsActive = true AND SobjectType = '${obj}'` });
      if (!dr.error && (dr.records || []).length) auto.push(`${dr.records.length} duplicate rule(s) — ${dr.records.slice(0, 5).map(r => r.DeveloperName).join(', ')}${dr.records.length > 5 ? '…' : ''}`);
      if (auto.length) {
        logRow('ℹ️', `${obj}: target automation a dry run CANNOT test (it only fires on real writes): ${auto.join(' · ')}. If the real run fails with a custom error message, start here.`, 'ds-prog-warn');
      }
    }

    // ── Step 5: validate lookup resolution bridges ────────────────
    // For each 'match' resolution, probe a sample to see how many IDs resolve.
    if (node.lookupResolutions && srcCount > 0 && tgtSess) {
      for (const [fieldName, res] of Object.entries(node.lookupResolutions)) {
        if (res.strategy !== 'match' || !res.matchField || !res.matchObject) continue;

        // Grab a 50-record sample from source and check how many AccountId values
        // we can bridge via the chosen anchor field
        const sampleRes = await sendBg({
          type: 'SF_QUERY', tooling: false,
          orgUrl: srcSess.orgUrl, sid: srcSess.sid,
          query: `SELECT ${fieldName} FROM ${obj}${dryWhere ? ' WHERE ' + dryWhere : ''} LIMIT 50`
        });
        if (sampleRes.error) continue;

        const sampleIds = [...new Set(
          (sampleRes.records || []).map(r => r[fieldName]).filter(Boolean)
        )];
        if (!sampleIds.length) continue;

        // Lookup anchor values from source
        const idList = sampleIds.map(id => `'${id}'`).join(',');
        const srcLookup = await sendBg({
          type: 'SF_QUERY', tooling: false,
          orgUrl: srcSess.orgUrl, sid: srcSess.sid,
          query: `SELECT Id, ${res.matchField} FROM ${res.matchObject} WHERE Id IN (${idList})`
        });
        if (srcLookup.error) continue;

        const anchorValues = [...new Set(
          (srcLookup.records || []).map(r => r[res.matchField]).filter(Boolean)
        )];
        if (!anchorValues.length) continue;

        // PII MASKING v1 — the engine compares a hash-covered anchor
        // masked-to-masked (raw-to-masked can never match), so the probe
        // must too — and a covered field's RAW values must never ride into
        // a target-org query from here either. Null/fixed-covered anchors
        // collapse: the engine skips that bridge (warned above), so probing
        // it would validate a query the real run never makes — skip.
        let probeValues = anchorValues;
        if (piiKeys.length) {
          const anchorRule = sftkPiiRuleFor(piiPolicy, res.matchObject, res.matchField);
          if (anchorRule) {
            if (anchorRule.strategy !== 'hash') continue;
            const anchorDesc = await sendBg({
              type: 'SF_REST_GET',
              orgUrl: srcSess.orgUrl, sid: srcSess.sid,
              path: `services/data/v62.0/sobjects/${res.matchObject}/describe`
            });
            const anchorField = anchorDesc.error ? null : (anchorDesc.fields || [])
              .find(f => f.name.toLowerCase() === res.matchField.toLowerCase());
            // Hash on a non-maskable anchor nulls it in the target — the
            // engine skips that bridge too; nothing honest to probe.
            if (!anchorField || !sftkPiiMaskable(anchorField)) continue;
            probeValues = [];
            for (const av of anchorValues) {
              const mres = await sftkPiiMaskValue(av, anchorField, piiSalt, anchorRule);
              probeValues.push(mres.action === 'kept' ? av : mres.value);
            }
          }
        }

        // Match against target
        // Use soqlStrLit so values like O'Brien (or anything containing
        // a backslash) are safely escaped — the old inline escape only
        // handled single quotes, leaving backslashes to corrupt the query.
        const valList = probeValues.map(soqlStrLit).join(',');
        const tgtLookup = await sendBg({
          type: 'SF_QUERY', tooling: false,
          orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
          query: `SELECT Id, ${res.matchField} FROM ${res.matchObject} WHERE ${res.matchField} IN (${valList})`
        });
        if (tgtLookup.error) {
          logRow('⚠️', `  ${fieldName}: lookup probe failed — ${tgtLookup.error}`, 'ds-prog-warn');
          issues++;
          continue;
        }

        const matched = (tgtLookup.records || []).length;
        const total   = anchorValues.length;
        // W2 — 🔗 hand-picks bypass this bridge per record, so a probe that
        // ignores them OVERSTATES "will be null". Disclose rather than
        // re-compute: the probe is a 50-row sample, picks are per-record
        // surgery, and mixing the two would fake precision.
        let pickNote = '';
        if (typeof sftkLkpOvBucket === 'function') {
          const bkt = sftkLkpOvBucket(node, tgtSess.orgUrl);
          const nPicks = bkt ? Object.values(bkt).filter(r2 => r2 && r2[fieldName]).length : 0;
          if (nPicks) pickNote = ` · ${nPicks} record(s) carry a 🔗 hand-pick for this lookup and skip matching entirely`;
        }
        if (matched === 0) {
          logRow('❌', `  ${fieldName} → ${res.matchObject}.${res.matchField}: no matches found in target — all will be null${pickNote}`, 'ds-prog-err');
          issues++;
        } else if (matched < total) {
          logRow('⚠️', `  ${fieldName} → ${res.matchObject}.${res.matchField}: ${matched}/${total} sampled values found in target — some will be null${pickNote}`, 'ds-prog-warn');
        } else {
          logRow('✅', `  ${fieldName} → ${res.matchObject}.${res.matchField}: all ${total} sampled values resolve in target ✓${pickNote}`);
        }
      }
    }

    // ── Step 6: Record-type matching preview ──────────────────────
    // The transfer matches source → target RecordTypes by DeveloperName
    // (API name). Show, before running, which record types used by the
    // source records have an equivalent in the target — unmatched ones
    // mean those records will land with the target's DEFAULT record type.
    if (srcCount > 0) {
      const rtWhere = dryWhere
        ? `WHERE (${dryWhere}) AND RecordTypeId != null`
        : `WHERE RecordTypeId != null`;
      const srcRtRes = await sendBg({
        type: 'SF_QUERY', tooling: false,
        orgUrl: srcSess.orgUrl, sid: srcSess.sid,
        // GROUP BY → distinct record-type names cheaply (no row payload).
        query: `SELECT RecordType.DeveloperName FROM ${obj} ${rtWhere} GROUP BY RecordType.DeveloperName`
      });
      // Some objects have no RecordTypeId field → the query errors; that
      // just means "no record types here", which is fine, so ignore it.
      if (!srcRtRes.error) {
        const usedNames = [...new Set(
          (srcRtRes.records || []).map(r => r.RecordType?.DeveloperName).filter(Boolean)
        )];
        if (usedNames.length) {
          const tgtRtRes = await sendBg({
            type: 'SF_QUERY', tooling: false,
            orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
            query: `SELECT DeveloperName FROM RecordType WHERE SObjectType = '${obj}'`
          });
          const tgtNames = new Set((tgtRtRes.records || []).map(r => r.DeveloperName));
          const matchedRt   = usedNames.filter(n => tgtNames.has(n));
          const unmatchedRt = usedNames.filter(n => !tgtNames.has(n));
          if (unmatchedRt.length) {
            logRow('⚠️',
              `${obj}: record type(s) ${unmatchedRt.join(', ')} have no match in target — those records will use the target's default record type` +
              (matchedRt.length ? ` (${matchedRt.length} other type(s) match ✓)` : ''),
              'ds-prog-warn');
          } else {
            logRow('✅', `${obj}: all ${matchedRt.length} record type(s) match in target by API name ✓`);
          }
        }
      }
    }

    for (const c of (node.children || [])) await dryRunNode(c);
  }

  // Owner-mapping sanity: matching without a fallback is allowed but easy
  // to pick by accident — say what will happen to unmatched owners.
  if (ownerMapping?.mode === 'match' && !ownerMapping.fallbackUserId) {
    logRow('⚠', 'Owner matching is ON but no fallback user is picked — owners with no name match get the target default on inserts, and keep their current owner on updates.', 'ds-prog-warn');
  }

  // PII MASKING v1 — masking vs matching collisions. Deterministic masking
  // only matches targets seeded with the SAME salt, so a match key that is
  // itself masked silently stops matching unmasked targets. Warnings, never
  // issues: re-seeding into a same-salt masked target works by design.
  if (piiKeys.length) {
    if (ownerMapping?.mode === 'match') {
      for (const ownerField of (ownerMapping.matching?.fields || ['Name'])) {
        if (sftkPiiRuleFor(piiPolicy, 'User', ownerField)) {
          logRow('⚠', `Owner matching uses User.${ownerField}, which this policy masks — deterministic masking only matches targets seeded with the same salt, so against an unmasked target no owner matches and every record falls back.`, 'ds-prog-warn');
        }
      }
    }
    const piiRootObj = profileTree ? (profileTree.objectType || profileTree.childSObject) : null;
    if (upsertField && sftkPiiRuleFor(piiPolicy, piiRootObj, upsertField)) {
      logRow('⚠', `Upsert matches on ${piiRootObj}.${upsertField}, which this policy masks — deterministic masking only matches targets seeded with the same salt, so against an unmasked target no row matches and every record inserts as new.`, 'ds-prog-warn');
    }
  }

  await dryRunNode(profileTree);
  return { issues, checked, unchecked };
}

// PURE — the operation ONE record gets from this run, derived from its scan
// state and whether its node upserts. Insert mode on an already-existing
// record is named for what it is: a DUPLICATE.
function sftkRunOpFor(state, hasUpsert) {
  if (state === 'missing') return { op: '➕ Insert', cls: 'ds-diff-missing' };
  if (hasUpsert) {
    return state === 'changed'
      ? { op: '✏ Update', cls: 'ds-diff-drift' }
      : { op: '✏ Update (no changes)', cls: 'ds-diff-sync' };
  }
  return { op: '⚠ Insert — would DUPLICATE (exists in target)', cls: 'ds-diff-drift' };
}

// W5 (user 2026-08-04: "displaying a table of the records and child records
// to be deployed could be cool along with the operation") — a per-record
// table of what THIS run will do, read from the last scan. Point-in-time by
// construction and says so; extras are omitted because a run never touches
// them.
function openRunRecordsPreview() {
  const p = _transferProfile;
  const scan = p?.lastScan;
  const rootObj = p?.tree?.objectType;
  const fresh = !!(scan && scan.status === 'success' && scan.objectType === rootObj
    && (!scan.sourceOrg || scan.sourceOrg === p.sourceOrg)
    && (!scan.targetOrg || scan.targetOrg === p.targetOrg));
  if (!fresh) {
    showModal(`<div class="ds-modal-header">📋 Records preview</div>
      <div class="ds-modal-body">No fresh scan for this deployment — the preview reads the last 🔄 scan to know each record's state in the target. Run <strong>🔄 Refresh state</strong> on the deployment card, then reopen.</div>
      <div class="ds-modal-footer"><button class="ds-btn" data-dsaction="closeModal">Close</button></div>`);
    return;
  }
  const ROW_CAP = 200;
  const rootUpsert = (_transferWriteMode === 'upsert' && _transferUpsertField) || !!p.tree?.upsert?.field;
  const keyL = k => esc(typeof sftkMatchKeyLabel === 'function' ? sftkMatchKeyLabel(k) : String(k ?? ''));

  function sectionHtml(node, pathKey, cs, hasUpsert, label) {
    const ef = effectiveFilter(node, pathKey);
    const picks = ef.recordIds?.length ? new Set(ef.recordIds) : null;
    const rows = [];
    for (const [state, bucket] of [['missing', cs.missingInTarget], ['changed', cs.changed], ['insync', cs.identical]]) {
      for (const r of (bucket || [])) {
        if (picks && !picks.has(r.sourceId)) continue;
        rows.push({ r, state });
      }
    }
    const shown = rows.slice(0, ROW_CAP);
    const body = shown.map(({ r, state }) => {
      const o = sftkRunOpFor(state, hasUpsert);
      return `<div class="ds-runprev-row">
        <span class="ds-rec-col-key" title="${keyL(r.matchKey)}">${keyL(r.matchKey)}</span>
        ${r.nearMiss ? `<span class="ds-rec-pnote ds-rec-pnote-missing" title="A target record differs only by ${esc(r.nearMiss.reason)} — see Reconcile">≈ near match</span>` : ''}
        <span class="ds-runprev-op ${o.cls}">${o.op}</span>
      </div>`;
    }).join('') || '<div class="ds-rec-col-empty">nothing in scope</div>';
    const capNote = rows.length > shown.length
      ? `<div class="ds-pk-hint">+${rows.length - shown.length} more record(s) not listed — the run includes them all.</div>` : '';
    const pickNote = picks
      ? `<div class="ds-pk-hint">Scoped to the ${picks.size} hand-picked record(s); picked records missing from the scan are not listed.</div>` : '';
    return `<div class="ds-runprev-section">
      <div class="ds-runprev-hdr"><strong>${esc(label)}</strong>
        <span class="ds-pk-hint">${hasUpsert ? '⬆ upserts — existing records update' : 'insert mode — existing records would duplicate'}</span>
      </div>
      ${pickNote}${body}${capNote}
    </div>`;
  }

  let html = sectionHtml(p.tree, '', scan, rootUpsert, `${rootObj} (root)`);
  (p.tree.children || []).forEach((c, i) => {
    const pathKey = String(i);
    const cs = scan.children?.[pathKey];
    const obj = c.objectType || c.childSObject;
    if (cs && cs.status === 'success' && cs.rootRunAt === scan.runAt) {
      html += sectionHtml(c, pathKey, cs, !!c.upsert?.field, `${obj} (child)`);
    } else {
      html += `<div class="ds-runprev-section"><div class="ds-runprev-hdr"><strong>${esc(obj)} (child)</strong>
        <span class="ds-pk-hint">no fresh child scan — open its 🎯 picker and 🔎 Compare with target</span></div></div>`;
    }
  });
  showModal(`<div class="ds-modal-header">📋 Records preview — ${esc(p.name)}</div>
    <div class="ds-modal-body">
      <div class="ds-pk-hint" style="margin-bottom:8px">Read from the scan of ${esc(timeAgo(scan.runAt))} — a point-in-time reading, not live state. Records that exist ONLY in the target are never touched by a run and aren't listed.</div>
      ${html}
    </div>
    <div class="ds-modal-footer"><button class="ds-btn" data-dsaction="closeModal">Close</button></div>`);
}

async function runTransfer() {
  if (!_transferProfile || !_transferSrc || !_transferTgt) return;
  if (_transferSrc.orgUrl === _transferTgt.orgUrl) return;

  const btn = eid('dsTrRunBtn');
  if (btn) btn.disabled = true;

  const progArea = eid('dsTrProgressArea');
  if (progArea) progArea.innerHTML = `
    <div class="ds-progress-wrap">
      <div class="ds-progress-title">
        Transferring from ${esc(orgLabel(_transferSrc.orgUrl))} → ${esc(orgLabel(_transferTgt.orgUrl))}…
      </div>
      <div id="dsTrProgLog" class="ds-progress-log"></div>
    </div>`;

  function logRow(icon, msg, cls = '') {
    const log = eid('dsTrProgLog');
    if (!log) return;
    const row = document.createElement('div');
    row.className = `ds-prog-row ${cls}`;
    row.innerHTML = `<span class="ds-prog-icon">${icon}</span><span>${esc(msg)}</span>`;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  // Feature 5: Dry run mode — validate fields + count, no writes.
  // The validator itself lives in sftkDryRunAgainst (above) so the fan-out
  // runner can use the identical checks against every target.
  if (_transferDryRun) {
    logRow('🧪', `DRY RUN — validating "${_transferProfile.name}" (nothing will be written)…`);
    const dryRes = await sftkDryRunAgainst(
      buildTransferProfile().tree, _transferSrc, _transferTgt, logRow,
      _transferProfile?.ownerMapping,
      // PII MASKING v1 — the policy+salt ride on the profile the same way
      // ownerMapping does; the upsert External-ID only matters here when the
      // run would actually upsert on it.
      _transferProfile?.piiPolicy, _transferProfile?.piiSalt,
      _transferWriteMode === 'upsert' ? (_transferUpsertField || null) : null);

    // Same three-state verdict the fan-out uses. The old branch read
    // `issues` alone — a run whose target describe FAILED had issues:0 and
    // still printed "Dry run passed" and lit the ✓ chip, exactly the lying
    // caller the validator's contract comment warns about. 'No issues' only
    // counts when every object could actually be checked.
    const verdict = sftkFanoutDryVerdict(dryRes);
    const dryRunIssues = dryRes?.issues || 0;
    if (verdict.state === 'dirty') {
      logRow('❌', `Dry run found ${dryRunIssues} issue(s) — fix these before running the real transfer.`, 'ds-prog-err');
      showToast(`Dry run found ${dryRunIssues} issue(s) — see details`, 'warning', 6000);
      _validatedRuns.delete(_valKey());
    } else if (verdict.state !== 'clean') {
      // 'unknown' — a source query or target describe never ran. Zero
      // issues in what WAS read proves nothing about what wasn't.
      logRow('❔', `Dry run incomplete — ${verdict.detail}. This pair is NOT marked validated.`, 'ds-prog-warn');
      showToast('Dry run could not check everything — see details', 'warning', 6000);
      _validatedRuns.delete(_valKey());
    } else {
      logRow('✅', 'Dry run passed — no issues found, including value-level checks (restricted picklists, state/country, field lengths) against sampled data. Remaining risk on the real run: target validation rules, triggers and duplicate rules, which only fire on real writes (listed above per object when present).');
      showToast('Dry run passed ✓ — no field issues found', 'success', 4000);
      // Flip the footer: Run Transfer becomes the primary CTA for this
      // profile+org pair now that it's validated.
      _validatedRuns.add(_valKey());
    }
    _syncRunButtons();
    if (btn) btn.disabled = false;
    return;
  }

  // Guard: Upsert mode needs an external-Id field to match on.
  if (_transferWriteMode === 'upsert' && !_transferUpsertField) {
    logRow('❌', 'Upsert mode is selected but no External ID field was entered. Enter the field name or switch to Insert.', 'ds-prog-err');
    showToast('Enter an External ID field for Upsert mode', 'error', 5000);
    if (btn) btn.disabled = false;
    return;
  }

  // Magnitude / production gate — a large write, or ANY write into a
  // production org, should never start on a single click. Uses the
  // auto-counted total when available; the prod check is authoritative
  // (detected + cached via the Organization object).
  const tgtProd = (await ensureOrgType(_transferTgt.orgUrl)) === 'production';
  if ((tgtProd || (_trLastTotal != null && _trLastTotal > 2000)) && !_trBigRunConfirmed) {
    const nTxt = _trLastTotal != null ? `${_trLastTotalIsBound ? '≤ ' : ''}${_trLastTotal.toLocaleString()} records` : 'records';
    // Per-object breakdown — "18 records" must never hide that 16 of them are
    // children of the two parents actually picked (user 2026-09-14).
    const breakdown = _trLastCounts ? sftkCountBreakdown(_trLastCounts) : '';
    showModal(`
      <div class="ds-modal-header">${tgtProd ? '🛑 Writing into PRODUCTION' : '⚠ Large transfer'}</div>
      <div class="ds-modal-body">
        ${tgtProd ? `<div style="margin-bottom:8px;padding:8px 12px;background:#fef2f2;border-left:3px solid #dc2626;border-radius:4px;font-size:12px;color:#991b1b">
          🛑 <strong>${esc(orgLabel(_transferTgt.orgUrl))} looks like a PRODUCTION org.</strong> Writes here affect real users.</div>` : ''}
        You're about to write <strong>${nTxt}</strong>
        into <strong>${esc(orgLabel(_transferTgt.orgUrl))}</strong>
        (${_transferWriteMode === 'upsert' ? `upsert on ${esc(_transferUpsertField)}` : 'insert — always creates new records'}).
        ${breakdown ? `<div style="margin-top:6px;font-size:12px;color:var(--subtext)">By object: ${esc(breakdown)}${_trLastTotalIsBound ? ' — ≤ marks an upper bound (children counted without their parent filter)' : ''}</div>` : ''}
      </div>
      <div class="ds-modal-footer">
        <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
        <button class="ds-btn ${tgtProd ? 'ds-btn-danger' : 'ds-btn-primary'}" id="dsTrBigRunGo">Proceed${_trLastTotal != null ? ` with ${_trLastTotal.toLocaleString()} records` : ''}</button>
      </div>`);
    eid('dsTrBigRunGo')?.addEventListener('click', () => {
      _trBigRunConfirmed = true;
      closeModal();
      runTransfer();
    });
    if (btn) btn.disabled = false;
    return;
  }
  _trBigRunConfirmed = false;   // consumed — next gated run asks again

  const modeLabel = _transferWriteMode === 'upsert' ? `upsert on ${_transferUpsertField}` : 'insert';
  logRow('📤', `Starting transfer of profile "${_transferProfile.name}" (${modeLabel})…`);

  // ↩ RESTORE POINT (studio-undo.js) — the target's before-image of every
  // object this run can write, read BEFORE the first write. The History
  // entry is created under runId so the evidence and the run share a key.
  const runId = genId('run');
  // ✋ Cancel exists BEFORE the restore point is read — a large before-image
  // (up to 50,000 rows × every field) could not be stopped until now
  // (re-review 2026-09-12). The capture checks the flag between objects; a
  // cancel here ends the run with nothing written and nothing recorded.
  let captureCancelled = false;
  const titleEl = document.querySelector('#dsTrProgressArea .ds-progress-title');
  if (titleEl && !eid('dsTrCancelBtn')) {
    const cbtn = document.createElement('button');
    cbtn.id = 'dsTrCancelBtn';
    cbtn.className = 'ds-btn ds-btn-xs ds-btn-danger';
    cbtn.style.marginLeft = 'auto';
    cbtn.textContent = '✋ Cancel';
    cbtn.title = 'Stop after the current batch — records already written stay written. '
               + 'During a Bulk API job the job itself is aborted on the org, so records it hadn\'t reached yet are never written.';
    titleEl.appendChild(cbtn);
  }
  eid('dsTrCancelBtn')?.addEventListener('click', () => { captureCancelled = true; });
  const undoStub = await sftkUndoCaptureForRun({
    evidenceId: runId, scope: 'run', profileName: _transferProfile?.name,
    legs: [{ orgUrl: _transferTgt.orgUrl, sid: _transferTgt.sid,
      objects: sftkUndoTreeObjects(buildTransferProfile().tree, _transferWriteMode === 'upsert' ? 'upsert' : 'insert') }],
    shouldCancel: () => captureCancelled,
  }, logRow);
  if (captureCancelled) {
    eid('dsTrCancelBtn')?.remove();
    logRow('✋', 'Cancelled while the restore point was being read — nothing was written to the target and nothing was recorded.', 'ds-prog-warn');
    showToast('Transfer cancelled before any write', 'warning', 5000);
    if (btn) btn.disabled = false;
    return;
  }

  // Live progress + Cancel: the Port streams per-batch counts into the log
  // (keeping the worker alive) and carries the cancel command back.
  const runPort = _openRunPort(_trProgressHandler(eid('dsTrProgLog')));
  eid('dsTrCancelBtn')?.addEventListener('click', () => {
    try { runPort?.postMessage({ cmd: 'cancel' }); } catch (_) {}
    const cb = eid('dsTrCancelBtn');
    if (cb) { cb.disabled = true; cb.textContent = '⏳ cancelling…'; }
    // B3 — say exactly what "cancel" does at this moment, including the bulk
    // case (the job is aborted on the org; partial writes stay).
    logRow('✋', 'Cancelling — the current batch finishes and nothing further starts. '
      + 'If a Bulk API job is running it is aborted on the org: records it already wrote stay written, '
      + 'records it never reached are reported as "not processed" and can be finished with ↻ Retry failed.',
      'ds-prog-warn');
  });

  const result = await sendBg({
    // verified-by: the engine's post-run re-read — summary[obj].verified = { checked, found } (background.js, campaign 3 phase 1)
    type:             'SF_EXECUTE_PROFILE_TRANSFER',
    profile:          buildTransferProfile(),   // patched clone — incl. upsert config if set
    srcOrgUrl:        _transferSrc.orgUrl,
    srcSid:           _transferSrc.sid,
    tgtOrgUrl:        _transferTgt.orgUrl,
    tgtSid:           _transferTgt.sid
  });

  try { runPort?.disconnect(); } catch (_) {}
  eid('dsTrCancelBtn')?.remove();
  if (result?.cancelled) {
    logRow('✋', 'Run cancelled — everything written before the cancel stays in the target; the partial result is recorded in History.', 'ds-prog-warn');
    showToast('Transfer cancelled — partial results recorded', 'warning', 5000);
  }

  if (result.error) {
    logRow('❌', result.error, 'ds-prog-err');
    showToast('Transfer failed: ' + result.error, 'error', 6000);
    // ↩ the engine may have written before it died — the run is recorded with
    // its restore point so ↩ Roll back in History can still reach it.
    if (undoStub.status !== 'none') {
      const runEnd = await sftkUndoRunEnd(_transferTgt.orgUrl, _transferTgt.sid, undoStub.objects);
      _history.push({
        id: runId, profileId: _transferProfile?.id, profileName: _transferProfile?.name,
        srcOrgUrl: _transferSrc?.orgUrl, tgtOrgUrl: _transferTgt?.orgUrl,
        sourceOrg: _transferSrc?.orgUrl, targetOrg: _transferTgt?.orgUrl,
        startedAt: new Date().toISOString(), status: 'failed', summary: {}, errors: [String(result.error)],
        undo: { ...undoStub, ...runEnd },
      });
      await storageSaveHistory();
      logRow('↩', 'The run is recorded in History with its restore point — use ↩ Roll back there if anything was written before it failed.');
    }
    if (btn) btn.disabled = false;
    return;
  }

  // Log per-object results
  let anySessionExpired = false;
  for (const [obj, s] of Object.entries(result.summary || {})) {
    const isExpired = /SESSION_EXPIRED|session.*expired|INVALID_SESSION/i.test(s.error || '');
    if (isExpired) anySessionExpired = true;
    const icon = s.error ? '❌' : ((s.failed > 0 || s.connectFailed || s.connectOrphaned) ? '⚠' : '✅');
    // Child-first link outcomes (only present on child-first nodes)
    const linkInfo =
      `${s.connected ? `, ${s.connected} linked to parent` : ''}` +
      `${s.connectFailed ? `, ${s.connectFailed} link failed` : ''}` +
      `${s.connectOrphaned ? `, ${s.connectOrphaned} unlinked (parent failed)` : ''}`;
    // B3 — bulk provenance and the cancelled-but-never-attempted count are
    // part of the result, not footnotes: "0 failed" next to 38 000 untouched
    // records would be a lie of omission.
    const bulkInfo = s.viaBulk ? ' · ⚡ via Bulk API' : '';
    const npInfo   = s.notProcessed ? `, ${s.notProcessed} not confirmed written (Bulk job aborted by cancel)` : '';
    const msg  = s.error
      ? (isExpired
          ? `${obj}: Session expired — the Salesforce session ended during the transfer`
          : `${obj}: ${s.error}`)
      : `${obj}: ${s.created} created${s.failed > 0 ? `, ${s.failed} failed` : ''}${npInfo}${linkInfo}${bulkInfo}`;
    logRow(icon, msg, s.error || s.failed || s.connectFailed ? 'ds-prog-err' : '');
    // Fields skipped because the target org can't accept them (non-fatal).
    if (s.skippedFields && s.skippedFields.length) {
      logRow('ℹ️',
        `  ${obj}: ${s.skippedFields.length} field(s) skipped — not writable in the target org ` +
        `(${s.skippedFields.slice(0, 8).join(', ')}${s.skippedFields.length > 8 ? '…' : ''})`,
        'ds-prog-warn');
    }
  }

  (result.errors || []).forEach(e => logRow('❌', e, 'ds-prog-err'));

  const total = Object.values(result.summary || {}).reduce((n,s)=>n+(s.created||0),0);
  logRow(result.status === 'success' ? '✅' : '⚠',
    `Done — ${total} records transferred · Status: ${result.status}`);

  // E3 — restate the API cost from ACTUALS: created+failed+notProcessed per
  // object pins each node's record count, viaBulk pins its write path. Same
  // estimator as the pre-run line; still '≈' (polls and resolution queries
  // beyond the floors aren't counted), and a '+' when an object never
  // reported (its cost is unknown, not zero). Purely informational.
  try {
    const usedPlan = sftkPlanFromRunSummary(buildTransferProfile().tree, result.summary,
      _transferProfile?.bulkThreshold, _transferProfile?.ownerMapping?.mode === 'match',
      { apiMode: _transferProfile?.apiMode, batchSize: _transferProfile?.batchSize });
    const used = sftkEstimateRunCalls(usedPlan);
    if (Number.isFinite(used.total)) {
      const plus = used.known === false ? '+' : '';
      logRow('🧮', `This run used ≈${used.total.toLocaleString()}${plus} API calls — `
        + `≈${used.source.toLocaleString()}${plus} on the source org, `
        + `≈${used.target.toLocaleString()}${plus} on the target.`);
    }
  } catch (_) { /* informational only — never fail a finished run over it */ }
  // The run just spent calls — drop both meters so the next budget line
  // re-reads instead of showing pre-run numbers, then repaint it.
  window.sftkApiBudgetInvalidate?.(_transferSrc?.orgUrl, _transferTgt?.orgUrl);
  _trUpdateApiBudget();

  // Session-expired hint — guide the user to reopen their org tab
  if (anySessionExpired) {
    const log = eid('dsTrProgLog');
    if (log) {
      const hint = document.createElement('div');
      hint.style.cssText = 'margin:10px 0 4px;padding:10px 12px;background:#fff8f0;border:1px solid #e07b39;border-radius:6px;font-size:12px;color:#7a3a00;';
      hint.innerHTML = `⚠️ <strong>Session expired</strong> — open the affected org in a browser tab to refresh your Salesforce login, then run the transfer again. The Transfer view will re-detect the fresh session automatically.`;
      log.appendChild(hint);
    }
  }
  showToast(
    result.status === 'success'
      ? `✅ ${total} records transferred successfully`
      : `⚠️ Transfer finished with warnings — ${total} records`,
    result.status === 'success' ? 'success' : 'warning',
    5000
  );

  // M3c — MATCH MEMORY: remember the root object's srcId→tgtId pairs from
  // this run's successful creates/upserts, so future scans match these
  // records by identity (rename-proof). M-followup guard: only when this
  // run's SOURCE equals the profile's own source — pairs learned under a
  // run-time src override must never enter the profile's memory. The pairs
  // are then stripped from the result so History stays lean (they live in
  // profile.matchMemory). Any failure here degrades silently — the transfer
  // result is already complete.
  try {
    const mmRootObj = _transferProfile?.tree?.objectType || _transferProfile?.tree?.childSObject;
    const mmPairs = mmRootObj ? (result.summary?.[mmRootObj]?.idPairs || []) : [];
    if (mmPairs.length) {
      if (_transferProfile?.id
          && _orgKey(_transferSrc.orgUrl) === _orgKey(_transferProfile.sourceOrg || '')) {
        await window.sftkLearnPairs?.(_transferProfile.id, _transferTgt.orgUrl, mmPairs);
      }
      delete result.summary[mmRootObj].idPairs;
    }
  } catch (_) { /* memory is an optimization — never fail the run for it */ }

  // Record activity & save to history (Feature 12: include org URLs for health tiles)
  recordActivity('transfer');
  // ↩ end-of-run boundary from Salesforce's own clock (studio-undo.js).
  const runEnd = await sftkUndoRunEnd(_transferTgt.orgUrl, _transferTgt.sid, undoStub.objects);
  _history.push({
    id:        runId,
    profileId: _transferProfile?.id,
    profileName: _transferProfile?.name,
    // Set BOTH the *OrgUrl and sourceOrg/targetOrg keys: History (renderHistory)
    // and the Connected-Orgs "N transfers logged" counter read sourceOrg/
    // targetOrg, while health tiles read *OrgUrl. Reconcile entries set all
    // four — transfers must too, or they render "Unknown → Unknown".
    srcOrgUrl: _transferSrc?.orgUrl,
    tgtOrgUrl: _transferTgt?.orgUrl,
    sourceOrg: _transferSrc?.orgUrl,
    targetOrg: _transferTgt?.orgUrl,
    startedAt: new Date().toISOString(),
    ...result,
    // ↩ after the spread — the engine result must not clobber it. runEndedAt
    // lets a rollback leave records created/edited by others AFTER the run alone.
    undo: { ...undoStub, ...runEnd }
  });
  await storageSaveHistory();

  // After ANY transfer that wrote records, both the profile diff AND the
  // org snapshots are stale. Re-refresh both in the background so the next
  // picker open / profile card render / Org Map view reflects the new state.
  // Fire-and-forget — failures surface as toasts. Only triggers when at
  // least one record was created (skip on pure-failed runs).
  if (_transferProfile?.id && !_transferDryRun) {
    const totalCreated = Object.values(result.summary || {}).reduce((n, s) => n + (s.created || 0), 0);
    if (totalCreated > 0) {
      // Only auto-refresh the diff when the run used the profile's OWN org
      // pair — refreshProfileState scans profile.sourceOrg/targetOrg, so
      // after an org-override run it would compare the wrong pair and mark
      // the just-transferred records as still "missing".
      if (_transferOrgOverride.src || _transferOrgOverride.tgt) {
        showToast('Diff not auto-refreshed — this run used a different org pair than the saved profile.', 'info', 4500);
      } else {
        window.refreshProfileState?.(_transferProfile.id);
      }
    }
  }

  // Show history link
  const log = eid('dsTrProgLog');
  if (log) {
    const done = document.createElement('div');
    done.className = 'ds-done-row';
    done.innerHTML = `<button class="ds-btn" id="dsViewHistory">📜 View History</button>`;
    log.appendChild(done);

    // After the run finishes, scroll the panel back to the TOP so the
    // diagnostic rows are visible — they're far more actionable than the
    // 20-deep "Required fields are missing" tail. Then bring the panel
    // itself into view in case the page has been scrolled past it.
    log.scrollTop = 0;
    log.scrollIntoView({ behavior: 'smooth', block: 'start' });
    eid('dsViewHistory')?.addEventListener('click', () => {
      document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('[data-view="history"]')?.classList.add('active');
      _currentView = 'history';
      renderHistory();
    });
  }

  if (btn) btn.disabled = false;
}


// ════════════════════════════════════════════════════════════════
// M1 — (RETIRED 2026-09-14) the fan-out runner is gone; what remains here is
// the pure per-target advice helper, kept for its tests and for a future
// per-target status line on the deployment card.
// ════════════════════════════════════════════════════════════════
// PURE — what a fan-out will actually do to ONE target, from whatever is
// already known about it. The fan-out modal used to list target checkboxes and
// nothing else (user 2026-07-30: "you don't see any information about the
// operation… suggest actions against both targets"), which asked the user to
// authorize real writes to N orgs blind.
//
// scan: the cached per-target summary { runAt, missing, changed, extra,
// status } that ring scans already store on the profile — or null when this
// pair was never scanned. `live` = the org has an open tab (no tab = the
// runner skips it, so that outranks everything else). writeMode 'insert' can
// only ADD, so a target whose only difference is `changed` gets nothing from
// a run — saying so beforehand is the whole point.
// Returns { tone, headline, detail, actionable }.
function sftkFanoutTargetAdvice(scan, live, writeMode, now, kids) {
  if (!live) {
    return { tone: 'skip', actionable: false,
      headline: 'no open tab — will be skipped',
      detail: 'Open this org in a Chrome tab, then reopen this dialog.' };
  }
  if (!scan || scan.status === 'error' || (!Number.isFinite(scan.missing) && !Number.isFinite(scan.changed))) {
    return { tone: 'unknown', actionable: true,
      headline: 'never scanned — outcome unknown',
      detail: 'Run a scan against this org first, or fan out and read the result afterwards.' };
  }
  const miss = Math.max(0, Number(scan.missing) || 0);
  const chg  = Math.max(0, Number(scan.changed) || 0);
  const extra = Math.max(0, Number(scan.extra) || 0);
  const age = sftkFanoutScanAge(scan.runAt, now);
  const extraNote = extra ? ` ${extra} record(s) exist only here and are never touched by a deploy.` : '';
  if (!miss && !chg) {
    // CHILDREN gate this verdict too (user 2026-08-18: a7 showed "in sync —
    // nothing to write" over 1,850 never-pushed children; ring summaries
    // cover the ROOT object only). kids: { need, unscanned } from the
    // caller — need counted from fresh child scans, unscanned = child
    // sections this summary knows nothing about.
    if (kids && Number(kids.need) > 0) {
      return { tone: 'act', actionable: true,
        headline: `root in sync — will write ${kids.need} child record(s) (scanned ${age})`,
        detail: `The root object matches, but child sections carry work. Counts are from the last scan.${extraNote}` };
    }
    if (kids && kids.unscanned > 0) {
      return { tone: 'unknown', actionable: true,
        headline: `root in sync as of ${age} — child records not checked here`,
        detail: `This summary covers the root object only; ${kids.unscanned} child section(s) have no fresh scan for this target. A run upserts everything in scope, children included — scan the pair in ⚖ Reconcile to see child counts first.${extraNote}` };
    }
    return { tone: 'clean', actionable: false,
      headline: `in sync as of ${age} — nothing to write`,
      detail: `Running this target would write nothing.${extraNote}` };
  }
  if (writeMode === 'insert' && !miss && chg) {
    return { tone: 'warn', actionable: false,
      headline: `${chg} record(s) differ, but Insert can't update them`,
      detail: `Nothing would be written here (scanned ${age}). Switch the write mode to Upsert to push these changes.${extraNote}` };
  }
  const bits = [];
  if (miss) bits.push(`add ${miss}`);
  if (chg) bits.push(writeMode === 'upsert' ? `update ${chg}` : `${chg} differing (Insert skips)`);
  return { tone: 'act', actionable: true,
    headline: `will ${bits.join(' · ')} — scanned ${age}`,
    detail: `Counts are from the last scan${extraNote}` };
}

// PURE — "4 minutes ago" / "3 days ago" for a stored ISO timestamp.
function sftkFanoutScanAge(runAt, now) {
  const t = Date.parse(runAt || '');
  if (!Number.isFinite(t)) return 'an unknown time ago';
  const mins = Math.floor(((Number(now) || Date.now()) - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// ════════════════════════════════════════════════════════════════
// M1b — FAN-OUT DRY RUN: the same validator, against every target
// ════════════════════════════════════════════════════════════════
// HISTORY: the fan-out dialog, its multi-target dry run (dryRunFanOut) and
// the runner (runFanOut) were RETIRED on 2026-09-14 — a run now writes to
// ONE ring target, chosen in runProfile(). The pure verdict/summary helpers
// below stay because Run Transfer's own dry run reports through them.

// PURE — one target's dry-run outcome → the verdict shown in the panel and in
// the summary line. THREE states, never two: a target whose validation could
// not run is "could not check", which is NOT clean. Reporting it as clean
// would be the exact lie this feature exists to prevent.
//   res: { skipped:true } | { error } | { issues, checked, unchecked }
// Returns { state, icon, label, detail }; state ∈
//   'skipped' | 'unknown' | 'dirty' | 'clean'.
function sftkFanoutDryVerdict(res) {
  if (!res || res.skipped) {
    return { state: 'skipped', icon: '⏭', label: 'skipped',
      detail: 'skipped — no open tab, so nothing was checked here (the real run skips it the same way)' };
  }
  if (res.error) {
    return { state: 'unknown', icon: '❔', label: 'could not check',
      detail: `could not check — ${res.error}` };
  }
  const issues    = Math.max(0, Number(res.issues) || 0);
  const checked   = Math.max(0, Number(res.checked) || 0);
  const unchecked = Math.max(0, Number(res.unchecked) || 0);
  if (issues > 0) {
    const tail = unchecked ? ` · ${unchecked} object(s) could not be checked` : '';
    return { state: 'dirty', icon: '❌', label: `${issues} issue(s)`,
      detail: `${issues} issue(s) found${tail}` };
  }
  if (unchecked > 0) {
    return { state: 'unknown', icon: '❔', label: 'could not check',
      detail: `no issues in what could be read, but ${unchecked} object(s) could not be checked — this is NOT a clean result` };
  }
  if (checked === 0) {
    return { state: 'unknown', icon: '❔', label: 'could not check',
      detail: 'nothing was checked — this is NOT a clean result' };
  }
  return { state: 'clean', icon: '✅', label: 'clean',
    detail: `clean — ${checked} object(s) checked, 0 issues` };
}

// PURE — the honest end-of-run lines: per target, then the grand total.
// Each state is tallied separately so "clean" never absorbs "could not
// check" or "skipped". rows: [{ label, issues, verdict }].
function sftkFanoutDrySummary(rows) {
  const list = rows || [];
  const per = list.map(r => `${r.label}: ${r.verdict.label}`).join(' · ');
  const tally = { clean: 0, dirty: 0, unknown: 0, skipped: 0, issues: 0 };
  for (const r of list) {
    tally[r.verdict.state] = (tally[r.verdict.state] || 0) + 1;
    tally.issues += Math.max(0, Number(r.issues) || 0);
  }
  const bits = [];
  if (tally.clean)   bits.push(`${tally.clean} clean`);
  if (tally.dirty)   bits.push(`${tally.dirty} with issues (${tally.issues} total)`);
  if (tally.unknown) bits.push(`${tally.unknown} could not be checked`);
  if (tally.skipped) bits.push(`${tally.skipped} skipped`);
  return { per, total: bits.join(' · ') || 'no targets', tally };
}

// The runner. Validates every ticked target sequentially against the SAME
// source, streaming each target's lines into its own section of the fan-out
// result panel. It WRITES NOTHING: the only messages this path can send are
// GET_ALL_SF_SESSIONS (via getOrgSession), SF_QUERY and SF_REST_GET — all
// reads. There is deliberately no SF_EXECUTE_PROFILE_TRANSFER, no history
// push and no storage write anywhere below.
