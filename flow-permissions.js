// PURE. Can a person be given this flow? A screen flow, or an autolaunched flow that has no trigger of its own.
// Anything with a trigger (record, schedule, platform event, and whatever Salesforce adds next) starts by itself.
function sftkFlowIsAssignable(r) {
  if (!r) return false;
  if (r.ProcessType === 'Flow') return true;
  return r.ProcessType === 'AutoLaunchedFlow' && !String(r.TriggerType || '').trim();
}
if (typeof globalThis !== 'undefined') globalThis.sftkFlowIsAssignable = sftkFlowIsAssignable;

// PURE. Why this tool must not grant flow access on a permission set, or null when it may (2026-11-14).
// A packaged set (NamespacePrefix) belongs to its package: the subscriber org cannot change it, and the old
// deploy by bare Name made a stray unmanaged copy instead. A set of Type Group is the one Salesforce keeps
// for a permission set group: it holds what the group's sets give, nothing is granted on it directly.
function sftkFlowAccessLockedReason(ps) {
  if (!ps) return 'unknown permission set';
  if (ps.NamespacePrefix) return `it belongs to the ${ps.NamespacePrefix} package`;
  if (ps.Type === 'Group') return 'it is the permission set of a permission set group';
  return null;
}
if (typeof globalThis !== 'undefined') globalThis.sftkFlowAccessLockedReason = sftkFlowAccessLockedReason;

// PURE. Which (flow, permission set) pairs the SetupEntityAccess rows show (2026-11-14).
// rows: [{ Id, ParentId, SetupEntityId }]. Returns { ok, missing: ['Flow → Set'], missingKeys: ['flowId|psId'], present: { 'flowId|psId': rowId } }.
function sftkFlowAccessCheck(flows, permSets, rows) {
  const have = new Map();
  for (const r of (rows || [])) if (r && r.SetupEntityId && r.ParentId) have.set(`${r.SetupEntityId}|${r.ParentId}`, r.Id);
  const missing = [];
  const missingKeys = [];
  const present = {};
  for (const f of (flows || [])) for (const ps of (permSets || [])) {
    const k = `${f.Id}|${ps.Id}`;
    if (have.has(k)) { present[k] = have.get(k); continue; }
    missing.push(`${f.MasterLabel || f.DeveloperName || f.Id} → ${ps.Label || ps.Name || ps.Id}`);
    missingKeys.push(k);
  }
  return { ok: missing.length === 0, missing, missingKeys, present };
}
if (typeof globalThis !== 'undefined') globalThis.sftkFlowAccessCheck = sftkFlowAccessCheck;

'use strict';
/* ============================================================
   Flow Permissions — bulk-assign Screen Flows to Permission Sets
   ============================================================
   WRITE (grant): one SetupEntityAccess row per (flow, permission set),
   inserted through the REST collections API (ParentId = the set,
   SetupEntityId = the FlowDefinition Id). 2026-11-14: this replaced a
   PermissionSet metadata deploy that carried only <flowAccesses> + <label>.
   Salesforce took that deploy as the WHOLE set: on npc it cleared the set's
   description and dropped its field permissions (SetupAuditTrail
   19:03:46Z), and on a packaged set it created a new unmanaged copy. A row
   insert touches nothing else on the set. (The older note here said a REST
   insert gives no usable grant; a live insert on npc2 the same day was
   stored as SetupEntityType FlowDefinition, and a retrieve of the set then
   listed it under <flowAccesses>.) Packaged and group-owned sets are not
   offered: the subscriber org cannot change them.

   READ (show existing grants): query SetupEntityAccess by
   `SetupEntityId IN (<FlowDefinition Ids>)`. We do NOT filter on
   `SetupEntityType = 'Flow'` — the stored type string isn't reliable —
   matching on the flow Ids we display is robust.

   Flow Id resolution: each assignable flow (FlowDefinitionView) is joined
   to its FlowDefinition.Id by DeveloperName; flows with no FlowDefinition
   row (managed-package / read-only) are skipped.

   NOTE: we do NOT modify runInMode (a Flow-builder setting, not an access
   grant; not a valid FlowDefinition.Metadata property in the Tooling API).

   Compatible flow types: Screen Flows only (ProcessType = 'Flow').
   ============================================================ */
// 2026-11-15 (live re-check): after ↩ Undo of a Flow Access run from the tool's History, the lists and the chips
// kept the old grants until a reload. History now says when an undo has run ('sftk:history-undone', see
// sftkHistoryUndoAnnounce); this decides what Flow Access does with it. PURE.
//   detail: { tool, ok }   state: { ready (the tool was opened), loading (a read is under way) }
//   → 'reload' | 'after-load' (re-read once the running read ends — it may have started before the undo wrote) | null
function sftkFlowAccessOnUndo(detail, state) {
  if (!detail || detail.tool !== 'Flow Access') return null;   // another tool's undo does not touch flow access
  if (!state || !state.ready) return null;                     // never opened: the first open reads the org anyway
  return state.loading ? 'after-load' : 'reload';              // ok or not — a partly-run undo changed the org too
}
// Listens on `doc` and acts on the verdict. api: { state(), reload(), later() }. → the listener (for the tests).
function sftkFlowAccessWireUndo(doc, api) {
  const on = ev => {
    const v = sftkFlowAccessOnUndo(ev && ev.detail, api.state());
    if (v === 'reload') api.reload(); else if (v === 'after-load') api.later();
    return v;
  };
  doc.addEventListener('sftk:history-undone', on);
  return on;
}
if (typeof globalThis !== 'undefined') { globalThis.sftkFlowAccessOnUndo = sftkFlowAccessOnUndo; globalThis.sftkFlowAccessWireUndo = sftkFlowAccessWireUndo; }

const FlowPermissions = (() => {
  let _orgUrl, _sid;
  let _container;
  let _undoWired = false, _loading = false, _reloadAfter = false, _loadRun = null;   // the refresh after a History undo (2026-11-15)
  let _flows     = [];   // FlowDefinitionView records
  let _permSets  = [];   // PermissionSet records
  let _accessMap = {};   // flowDefId  -> [{ permSetId, label, accessId }]
  let _flowsByPS = {};   // permSetId  -> [{ flowId, label }]  (reverse of _accessMap)
  let _selFlows  = new Set();
  let _selPS     = new Set();
  let _psOnlyWithFlows = false;   // filter toggle: show only PS that grant ≥1 flow
  let _psExpanded = new Set();    // permSetIds whose inline flow list is expanded

  // ── tiny helpers ────────────────────────────────────────────
  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function sendBgRaw(msg) {
    return new Promise(r =>
      chrome.runtime.sendMessage(msg, res =>
        r(res || { error: chrome.runtime.lastError?.message || 'No response' })
      )
    );
  }

  async function sendBg(msg) {
    const _t   = window.SFToolkitDebug?.enabled ? Date.now() : null;
    const resp = await sendBgRaw(msg);
    // ── Debug logging ────────────────────────────────────────
    if (window.SFToolkitDebug?.enabled) {
      const dur = _t !== null ? Date.now() - _t : null;
      const tag = msg.query?.substring(0, 80) || msg.path || msg.sobject || '';
      window.SFToolkitDebug.log('flow-perms',
        resp?.error === 'SESSION_EXPIRED' ? 'session' : resp?.error ? 'error' : 'api',
        `${msg.type}${tag ? '  ' + tag : ''}`, resp?.error || null, dur);
    }
    if (resp?.error !== 'SESSION_EXPIRED') return resp;
    const fresh = await sendBgRaw({ type: 'GET_SF_SESSION', activeTabUrl: _orgUrl });
    if (fresh?.sid && fresh?.orgUrl) {
      _orgUrl = fresh.orgUrl;
      _sid    = fresh.sid;
      const retry = msg.sid !== undefined
        ? { ...msg, orgUrl: fresh.orgUrl, sid: fresh.sid }
        : msg;
      return sendBgRaw(retry);
    }
    return resp;
  }

  // ── Public ──────────────────────────────────────────────────
  function init(container, orgUrl, sid) {
    _container = container;
    _orgUrl    = orgUrl;
    _sid       = sid;
    renderShell();
    if (!_undoWired) {   // once per page: init runs again on a new session
      _undoWired = true;
      sftkFlowAccessWireUndo(document, { state: () => ({ ready: !!_container, loading: _loading }), reload: loadData, later: () => { _reloadAfter = true; } });
    }
    loadData();
  }

  function updateSession(orgUrl, sid) {
    _orgUrl = orgUrl;
    _sid    = sid;
  }

  // ── Shell ───────────────────────────────────────────────────
  function renderShell() {
    _container.innerHTML = `
      <div class="fp-wrap">
        <div class="fp-toolbar">
          <span style="flex:1;font-size:12px;font-weight:700;color:var(--subtext)">Flow Access Control</span>
          <button class="btn-icon" id="fpRefreshBtn" title="Refresh">🔄</button>
        </div>

        <div id="fpLoading" class="fp-loading">
          ${sftkCat('Loading flows &amp; permission sets…')}
        </div>

        <div id="fpContent" class="fp-content" style="display:none">
          <div class="fp-panels">

            <!-- Left: Assignable Flows -->
            <div class="fp-panel">
              <div class="fp-panel-hdr">
                <span class="fp-panel-title">🌊 Flows</span>
                <span id="fpFlowCount" class="fp-panel-count">0</span>
                <button class="fp-mini-btn" id="fpFlowSelAll">All</button>
                <button class="fp-mini-btn" id="fpFlowDesel">None</button>
              </div>
              <div class="fp-panel-search">
                <input type="text" class="fp-panel-search-input" id="fpFlowSearch" placeholder="🔍 Search flows…">
              </div>
              <div id="fpFlowList" class="fp-list"></div>
              <div id="fpFlowNote" class="fp-flow-note" hidden></div>
            </div>

            <!-- Right: Permission Sets -->
            <div class="fp-panel">
              <div class="fp-panel-hdr">
                <span class="fp-panel-title">🔑 Permission Sets</span>
                <span id="fpPsCount" class="fp-panel-count">0</span>
                <button class="fp-mini-btn" id="fpPsSelAll">All</button>
                <button class="fp-mini-btn" id="fpPsDesel">None</button>
              </div>
              <div class="fp-panel-search">
                <input type="text" class="fp-panel-search-input" id="fpPsSearch" placeholder="🔍 Search perm sets…">
              </div>
              <label class="fp-ps-filter" title="Show only permission sets that already grant access to at least one flow">
                <input type="checkbox" id="fpPsOnlyFlows"> ⚡ Only show perm sets with flows enabled
              </label>
              <div id="fpPsList" class="fp-list"></div>
              <div id="fpPsNote" class="fp-flow-note" hidden></div>
            </div>

          </div>
        </div>

        <!-- Bottom action bar -->
        <div id="fpActionBar" class="fp-action-bar" style="display:none">
          <span id="fpActionSummary" class="fp-action-summary">Select flows and permission sets</span>
          <button class="btn btn-primary fp-assign-btn" id="fpAssignBtn" disabled>🔑 Assign</button>
        </div>

        <div id="fpError" class="fp-error-msg" style="display:none"></div>
      </div>
    `;

    document.getElementById('fpRefreshBtn').addEventListener('click', loadData);
  }

  // ── Data loading ────────────────────────────────────────────
  async function loadData() {
    // one read at a time: asked again while one runs (an undo that ended meanwhile), the running read is followed
    // by another, and every caller waits for the last of them
    if (_loading) { _reloadAfter = true; return _loadRun; }
    _loading = true;
    _loadRun = (async () => { try { do { _reloadAfter = false; await _loadDataOnce(); } while (_reloadAfter); } finally { _loading = false; } })();
    return _loadRun;
  }
  async function _loadDataOnce() {
    setLoading(true);
    hideError();
    // the cat, one segment per step and the time left (user 2026-11-08: "every loading that might take time")
    const prog = window.sftkProgress ? sftkProgress(document.getElementById('fpLoading'), { what: 'Reading the flows that can be granted, and who has access to them today…', key: 'flowaccess', orgUrl: _orgUrl,
      legs: [{ key: 'flows', label: 'the flows', weight: 2 }, { key: 'defs', label: 'flow definitions', weight: 2 }, { key: 'access', label: 'permission sets and today’s access', weight: 3 }] }) : null;
    _selFlows.clear();
    _selPS.clear();

    try {
      // ── Step 1: FlowDefinitionView (standard REST) ───────────────────────
      // This view always exposes ProcessType AND TriggerType, making it the
      // most reliable way to identify which flows can be assigned to permission sets.
      //
      // Assignable types:
      //   • Screen Flows     → ProcessType = 'Flow'
      //   • Autolaunched     → ProcessType = 'AutoLaunchedFlow', TriggerType = null/empty
      //
      // NOT assignable (must be excluded):
      //   • Record-Triggered → ProcessType = 'AutoLaunchedFlow', TriggerType in BLOCKED_TRIGGERS
      //   • Scheduled / Platform Event / Data Cloud → same ProcessType, different TriggerType
      const fdvRes = await sendBg({
        type: 'SF_QUERY_ALL', tooling: false, orgUrl: _orgUrl, sid: _sid,
        query: `SELECT DurableId, Label, ApiName, ProcessType, TriggerType
                FROM FlowDefinitionView
                WHERE (ProcessType = 'Flow' OR ProcessType = 'AutoLaunchedFlow')
                AND ActiveVersionId != null
                ORDER BY Label ASC`
      });
      if (fdvRes.error) throw new Error('Could not load flows: ' + fdvRes.error);

      // A flow somebody can be GIVEN is one somebody starts: a screen flow, or an autolaunched flow with NO trigger.
      // The test is "has no trigger", not a list of known triggers (2026-11-10, the lesson of the colleague's missing
      // flows: a list of kinds goes stale — the old blocklist let a before-delete record-triggered flow through as
      // assignable). What starts by itself is counted and said under the list, never silently left out.
      const assignable = (fdvRes.records || []).filter(r => sftkFlowIsAssignable(r));
      _selfRunning = (fdvRes.records || []).length - assignable.length;

      // ── Step 2: FlowDefinition (Tooling) — Id ────────────────────────────
      // Id is the only thing we need from FlowDefinition: it's the
      // SetupEntityAccess.SetupEntityId used to grant the flow to a
      // permission set.
      //
      // Query EVERY FlowDefinition (no ActiveVersionId filter — we still want
      // permission management on inactive ones) so the client-side join by
      // DeveloperName resolves as many flows as possible.
      if (prog) prog.step('defs');
      const fdRes = await sendBg({
        type: 'SF_QUERY_ALL', tooling: true, orgUrl: _orgUrl, sid: _sid,
        query: `SELECT Id, DeveloperName FROM FlowDefinition`
      });
      // Build a lookup: DeveloperName → FlowDefinition.Id
      const fdIdByName = {};
      if (!fdRes || fdRes.error) throw new Error(`the org's flows could not be read — ${(fdRes && fdRes.error) || 'no answer'}`);   // not "No active assignable flows found" (QA 2026-11-11)
      if (fdRes.records) {
        for (const r of fdRes.records) fdIdByName[r.DeveloperName] = r.Id;
      }

      // ── Step 3: Build normalised _flows array ─────────────────────────────
      // CRITICAL: only the real FlowDefinition.Id is valid as a SetupEntityId.
      // DurableId from FlowDefinitionView is a SYNTHETIC string — for
      // managed-package flows (cms_orch__*, etc.) it looks like the API name
      // (e.g. "cms_orch__CMS_ReviseContent"), and Salesforce will interpret
      // that as an external-Id field lookup → 404. So: no fallback. If we
      // couldn't resolve a flow to its FlowDefinition row, drop it from the
      // assignable list — managed-package / read-only flows can't get
      // SetupEntityAccess granted to them anyway.
      const unresolved = [];
      _flows = assignable
        .map(r => {
          const fdId = fdIdByName[r.ApiName];
          if (!fdId) { unresolved.push(r.ApiName); return null; }
          return {
            Id:            fdId,                        // real FlowDefinition.Id
            MasterLabel:   r.Label,
            DeveloperName: r.ApiName,
            ProcessType:   r.ProcessType,
            TriggerType:   r.TriggerType || null
          };
        })
        .filter(Boolean);
      if (unresolved.length && window.SFToolkitDebug?.enabled) {
        window.SFToolkitDebug.log('flow-perms', 'info',
          `${unresolved.length} flow(s) skipped — no matching FlowDefinition row (likely managed-package): ` +
          unresolved.slice(0, 5).join(', ') + (unresolved.length > 5 ? ', …' : ''));
      }

      // ── Step 4: Permission sets + existing access map ─────────────────────
      // Read SetupEntityAccess by SetupEntityId IN (our FlowDefinition Ids),
      // NOT by `WHERE SetupEntityType = 'Flow'`. The grant we create (REST
      // insert with just SetupEntityId) is stored with a type string that
      // doesn't reliably equal 'Flow', so the type filter missed it even
      // though Salesforce Setup shows the access. Matching on the flow Ids
      // we already display sidesteps the type-string entirely. Chunked to
      // keep the IN() clause within SOQL limits.
      if (prog) prog.step('access');
      const flowDefIds = _flows.map(f => f.Id).filter(Boolean);
      const accessRecsP = (async () => {
        const out = [];
        for (let i = 0; i < flowDefIds.length; i += 200) {
          const chunk = flowDefIds.slice(i, i + 200);
          const inList = chunk.map(id => `'${id}'`).join(',');
          const res = await sendBg({
            type: 'SF_QUERY_ALL', tooling: false, orgUrl: _orgUrl, sid: _sid,
            query: `SELECT Id, ParentId, Parent.Label, SetupEntityId, SetupEntityType
                    FROM SetupEntityAccess WHERE SetupEntityId IN (${inList})`
          });
          // A failed chunk is NOT "no grants" (QA 2026-11-11): the grants it held were missing from the picture, and ↩ Undo
          // of the next change then removed access this run never created. The load fails as a whole instead.
          if (!res || res.error) throw new Error(`the flows' permission-set access could not be read — ${(res && res.error) || 'no answer'}`);
          if (res.incomplete) throw new Error(`the flows' permission-set access came back incomplete (${res.incomplete.got} of ${res.incomplete.expected})`);
          out.push(...(res.records || []));
        }
        return out;
      })();
      const [psRes, accessRecords] = await Promise.all([
        sendBg({
          type: 'SF_QUERY_ALL', tooling: false, orgUrl: _orgUrl, sid: _sid,
          // NamespacePrefix + Type (2026-11-14): packaged and group-owned sets are counted and left out, see sftkFlowAccessLockedReason
          query: `SELECT Id, Name, Label, NamespacePrefix, Type FROM PermissionSet
                  WHERE IsOwnedByProfile = false ORDER BY Label ASC`
        }),
        accessRecsP
      ]);
      if (psRes.error) throw new Error(psRes.error);

      // Diagnostic: how many access records matched our flow Ids, and what
      // SetupEntityType did Salesforce actually store for them.
      if (window.SFToolkitDebug?.enabled) {
        window.SFToolkitDebug.log('flow-perms', 'info',
          `SetupEntityAccess grants for ${flowDefIds.length} flows: ${accessRecords.length} — ` +
          JSON.stringify(accessRecords.slice(0, 15).map(r => ({ ps: r.ParentId, flow: r.SetupEntityId, type: r.SetupEntityType }))));
      }

      const allPs = psRes.records || [];
      _permSets = allPs.filter(p => !sftkFlowAccessLockedReason(p));
      _psLocked = allPs.length - _permSets.length;

      // flowDefId → label, for naming flows in the reverse (per-PS) view.
      // Covers the assignable screen flows; flows we couldn't resolve fall
      // back to their raw Id below.
      const flowLabelById = {};
      for (const f of _flows) flowLabelById[f.Id] = f.MasterLabel || f.DeveloperName || f.Id;

      _accessMap = {};
      _flowsByPS = {};
      for (const r of accessRecords) {
        if (!_accessMap[r.SetupEntityId]) _accessMap[r.SetupEntityId] = [];
        _accessMap[r.SetupEntityId].push({
          permSetId: r.ParentId,
          label:     r.Parent?.Label || r.ParentId,
          accessId:  r.Id
        });
        // Reverse index: which flows does each permission set grant?
        if (!_flowsByPS[r.ParentId]) _flowsByPS[r.ParentId] = [];
        _flowsByPS[r.ParentId].push({
          flowId: r.SetupEntityId,
          label:  flowLabelById[r.SetupEntityId] || r.SetupEntityId
        });
      }

      if (prog) prog.done();
      setLoading(false);
      renderContent();
    } catch (e) {
      if (prog) prog.fail();
      setLoading(false);
      const raw = e.message || String(e);
      showError(raw);   // showError translates via sftkFriendlyError (handles SESSION_EXPIRED too)
    }
  }

  // ── Render helpers ──────────────────────────────────────────
  function renderContent() {
    const content   = document.getElementById('fpContent');
    const actionBar = document.getElementById('fpActionBar');
    content.style.display   = '';
    actionBar.style.display = '';

    // Wire per-panel search inputs
    const flowSearchEl = document.getElementById('fpFlowSearch');
    if (flowSearchEl) {
      flowSearchEl.addEventListener('input', () => { renderFlows(); updateActionBar(); });
    }
    const psSearchEl = document.getElementById('fpPsSearch');
    if (psSearchEl) {
      psSearchEl.addEventListener('input', () => { renderPermSets(); updateActionBar(); });
    }
    const psOnlyFlowsEl = document.getElementById('fpPsOnlyFlows');
    if (psOnlyFlowsEl) {
      psOnlyFlowsEl.checked = _psOnlyWithFlows;
      psOnlyFlowsEl.addEventListener('change', () => {
        _psOnlyWithFlows = psOnlyFlowsEl.checked;
        renderPermSets(); updateActionBar();
      });
    }

    // Wire panel-level select/deselect buttons — select/deselect the currently filtered items
    document.getElementById('fpFlowSelAll').onclick  = () => {
      const q = (document.getElementById('fpFlowSearch')?.value || '').toLowerCase().trim();
      const visible = q ? _flows.filter(f => (f.MasterLabel || f.DeveloperName || '').toLowerCase().includes(q)) : _flows;
      visible.forEach(f => _selFlows.add(f.Id));
      renderFlows(); updateActionBar();
    };
    document.getElementById('fpFlowDesel').onclick   = () => {
      const q = (document.getElementById('fpFlowSearch')?.value || '').toLowerCase().trim();
      const visible = q ? _flows.filter(f => (f.MasterLabel || f.DeveloperName || '').toLowerCase().includes(q)) : _flows;
      visible.forEach(f => _selFlows.delete(f.Id));
      renderFlows(); updateActionBar();
    };
    document.getElementById('fpPsSelAll').onclick    = () => {
      const q = (document.getElementById('fpPsSearch')?.value || '').toLowerCase().trim();
      const visible = q ? _permSets.filter(p => (p.Label || p.Name || '').toLowerCase().includes(q)) : _permSets;
      visible.forEach(p => _selPS.add(p.Id));
      renderPermSets(); updateActionBar();
    };
    document.getElementById('fpPsDesel').onclick     = () => {
      const q = (document.getElementById('fpPsSearch')?.value || '').toLowerCase().trim();
      const visible = q ? _permSets.filter(p => (p.Label || p.Name || '').toLowerCase().includes(q)) : _permSets;
      visible.forEach(p => _selPS.delete(p.Id));
      renderPermSets(); updateActionBar();
    };

    // Assign button (wire only once to avoid duplicate listeners)
    const assignBtn = document.getElementById('fpAssignBtn');
    if (assignBtn && !assignBtn._fpWired) {
      assignBtn._fpWired = true;
      assignBtn.addEventListener('click', onAssign);
    }

    renderFlows();
    renderPermSets();
    updateActionBar();
  }

  // Map ProcessType + TriggerType → a short human-readable flow type.
  // Returns { label, cls } — cls is a CSS modifier for badge colour.
  function flowTypeInfo(f) {
    const pt = f.ProcessType || '';
    const tt = f.TriggerType || '';
    if (pt === 'Flow') {
      return { label: 'Screen Flow', cls: 'fp-ft-screen' };
    }
    if (pt === 'AutoLaunchedFlow') {
      switch (tt) {
        case 'RecordBeforeSave':    return { label: 'Record-Triggered (Before Save)', cls: 'fp-ft-record' };
        case 'RecordAfterSave':     return { label: 'Record-Triggered (After Save)',  cls: 'fp-ft-record' };
        case 'RecordBeforeDelete':  return { label: 'Record-Triggered (Before Delete)', cls: 'fp-ft-record' };
        case 'Scheduled':           return { label: 'Scheduled Flow',        cls: 'fp-ft-sched' };
        case 'PlatformEvent':       return { label: 'Platform Event-Triggered', cls: 'fp-ft-event' };
        case 'DataCloudDataChange': return { label: 'Data Cloud-Triggered',  cls: 'fp-ft-event' };
        case 'Segment':             return { label: 'Segment-Triggered',     cls: 'fp-ft-event' };
        default:                    return { label: 'Autolaunched Flow',     cls: 'fp-ft-auto' };
      }
    }
    return { label: pt || 'Flow', cls: 'fp-ft-auto' };
  }

  let _selfRunning = 0;   // active flows left out because they start by themselves
  function renderFlows() {
    const list    = document.getElementById('fpFlowList');
    const countEl = document.getElementById('fpFlowCount');
    if (!list) return;
    const note = document.getElementById('fpFlowNote');
    if (note) {
      note.hidden = !_selfRunning;
      note.textContent = _selfRunning ? `${_selfRunning} more active flow${_selfRunning === 1 ? ' is' : 's are'} not listed: record-triggered, scheduled and event flows start by themselves, so nobody is given access to them. Inactive flows are not listed either.` : '';
    }

    const search   = (document.getElementById('fpFlowSearch')?.value || '').toLowerCase().trim();
    const filtered = search
      ? _flows.filter(f => (f.MasterLabel || f.DeveloperName || '').toLowerCase().includes(search))
      : _flows;

    const selCount = filtered.filter(f => _selFlows.has(f.Id)).length;
    if (countEl) countEl.textContent = selCount > 0
      ? `${selCount} / ${filtered.length}`
      : filtered.length;

    if (filtered.length === 0) {
      list.innerHTML = `<div class="fp-empty">${search ? 'No flows match' : 'No active assignable flows found'}</div>`;
      return;
    }

    list.innerHTML = filtered.map(f => {
      const sel      = _selFlows.has(f.Id);
      const assigned = _accessMap[f.Id] || [];
      const psBadge  = assigned.length > 0
        ? `<span class="fp-ps-badge" title="${assigned.map(a => esc(a.label)).join(', ')}">${assigned.length} PS</span>`
        : '';

      const ft = flowTypeInfo(f);
      const ftBadge = `<span class="fp-ft-badge ${ft.cls}" title="Flow type: ${esc(ft.label)}">${esc(ft.label)}</span>`;

      return `
        <label class="fp-item${sel ? ' fp-item-sel' : ''}" title="${esc(f.DeveloperName || '')}">
          <input type="checkbox" class="fp-cb fp-flow-cb" data-id="${esc(f.Id)}"${sel ? ' checked' : ''}>
          <span class="fp-item-name">${esc(f.MasterLabel || f.DeveloperName || f.Id)}</span>
          <span class="fp-item-meta">${ftBadge}${psBadge}</span>
        </label>`;
    }).join('');

    list.querySelectorAll('.fp-flow-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) _selFlows.add(cb.dataset.id);
        else            _selFlows.delete(cb.dataset.id);
        cb.closest('.fp-item').classList.toggle('fp-item-sel', cb.checked);
        // update count badge
        const el = document.getElementById('fpFlowCount');
        const q  = (document.getElementById('fpFlowSearch')?.value || '').toLowerCase().trim();
        const vis = q ? _flows.filter(f => (f.MasterLabel || f.DeveloperName || '').toLowerCase().includes(q)) : _flows;
        const sc  = vis.filter(f => _selFlows.has(f.Id)).length;
        if (el) el.textContent = sc > 0 ? `${sc} / ${vis.length}` : vis.length;
        updateActionBar();
      });
    });
  }

  let _psLocked = 0;   // packaged / group-owned permission sets left out (2026-11-14)
  function renderPermSets() {
    const list    = document.getElementById('fpPsList');
    const countEl = document.getElementById('fpPsCount');
    if (!list) return;
    const psNote = document.getElementById('fpPsNote');
    if (psNote) {
      psNote.hidden = !_psLocked;
      psNote.textContent = _psLocked ? `${_psLocked} more permission set${_psLocked === 1 ? ' is' : 's are'} not listed: sets from installed packages and the sets Salesforce keeps for permission set groups cannot be changed here.` : '';
    }

    const search   = (document.getElementById('fpPsSearch')?.value || '').toLowerCase().trim();
    let filtered = search
      ? _permSets.filter(p => (p.Label || p.Name || '').toLowerCase().includes(search))
      : _permSets.slice();
    // "Only with flows" filter — keep permission sets that already grant ≥1 flow.
    if (_psOnlyWithFlows) {
      filtered = filtered.filter(p => (_flowsByPS[p.Id] || []).length > 0);
    }

    const selCount = filtered.filter(p => _selPS.has(p.Id)).length;
    if (countEl) countEl.textContent = selCount > 0
      ? `${selCount} / ${filtered.length}`
      : filtered.length;

    if (filtered.length === 0) {
      const why = _psOnlyWithFlows ? 'No permission sets have flows enabled'
                : search ? 'No permission sets match'
                : 'No custom permission sets found';
      list.innerHTML = `<div class="fp-empty">${why}</div>`;
      return;
    }

    list.innerHTML = filtered.map(ps => {
      const sel   = _selPS.has(ps.Id);
      const flows = _flowsByPS[ps.Id] || [];
      const open  = _psExpanded.has(ps.Id);
      // Clickable badge showing how many flows this PS grants. Click it to
      // expand an inline list of those flows right under the row.
      const flowBadge = flows.length > 0
        ? `<span class="fp-flowcount-badge" data-ps-flows="${esc(ps.Id)}"
                 title="Click to ${open ? 'hide' : 'show'} the ${flows.length} flow(s) this permission set grants">⚡ ${flows.length} flow${flows.length !== 1 ? 's' : ''} ${open ? '▾' : '▸'}</span>`
        : '';
      // Inline expandable list of the granted flows.
      const flowListHtml = (flows.length > 0 && open)
        ? `<div class="fp-ps-flowlist">
             ${flows.map(fl => `<div class="fp-ps-flowlist-row">⚡ ${esc(fl.label)}</div>`).join('')}
           </div>`
        : '';
      return `
        <div class="fp-ps-wrap">
          <label class="fp-item${sel ? ' fp-item-sel' : ''}" title="${esc(ps.Name)}">
            <input type="checkbox" class="fp-cb fp-ps-cb" data-id="${esc(ps.Id)}"${sel ? ' checked' : ''}>
            <span class="fp-item-name">${esc(ps.Label)}</span>
            <span class="fp-item-api">${esc(ps.Name)}</span>
            ${flowBadge}
          </label>
          ${flowListHtml}
        </div>`;
    }).join('');

    // Click a flow-count badge → toggle the inline flow list under that PS.
    // stopPropagation keeps the <label> from flipping the PS checkbox.
    list.querySelectorAll('[data-ps-flows]').forEach(badge => {
      badge.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        const psId = badge.dataset.psFlows;
        if (_psExpanded.has(psId)) _psExpanded.delete(psId);
        else                       _psExpanded.add(psId);
        renderPermSets();
      });
    });

    list.querySelectorAll('.fp-ps-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) _selPS.add(cb.dataset.id);
        else            _selPS.delete(cb.dataset.id);
        cb.closest('.fp-item').classList.toggle('fp-item-sel', cb.checked);
        // update count badge — apply BOTH filters (search + "only with
        // flows"), matching renderPermSets, or the denominator flips to the
        // unfiltered total whenever a checkbox is ticked with the filter on.
        const el = document.getElementById('fpPsCount');
        const q  = (document.getElementById('fpPsSearch')?.value || '').toLowerCase().trim();
        let vis = q ? _permSets.filter(p => (p.Label || p.Name || '').toLowerCase().includes(q)) : _permSets;
        if (_psOnlyWithFlows) vis = vis.filter(p => (_flowsByPS[p.Id] || []).length > 0);
        const sc  = vis.filter(p => _selPS.has(p.Id)).length;
        if (el) el.textContent = sc > 0 ? `${sc} / ${vis.length}` : vis.length;
        updateActionBar();
      });
    });
  }

  function updateActionBar() {
    const btn     = document.getElementById('fpAssignBtn');
    const summary = document.getElementById('fpActionSummary');
    if (!btn || !summary) return;

    const fc = _selFlows.size;
    const pc = _selPS.size;
    btn.disabled = fc === 0 || pc === 0;

    if      (fc === 0 && pc === 0) summary.textContent = 'Select flows and permission sets';
    else if (fc === 0)             summary.textContent = `${pc} perm set${pc !== 1 ? 's' : ''} selected — pick flows`;
    else if (pc === 0)             summary.textContent = `${fc} flow${fc !== 1 ? 's' : ''} selected — pick perm sets`;
    else                           summary.textContent = `${fc} flow${fc !== 1 ? 's' : ''} → ${pc} perm set${pc !== 1 ? 's' : ''}`;
  }

  // ── Assignment ──────────────────────────────────────────────
  async function onAssign() {
    const flows    = _flows.filter(f => _selFlows.has(f.Id));
    const permSets = _permSets.filter(p => _selPS.has(p.Id) && !sftkFlowAccessLockedReason(p));   // 2026-11-14: never a packaged or group set
    if (!flows.length || !permSets.length) return;

    const confirmed = await showConfirmModal(flows, permSets);
    if (!confirmed) return;

    await doAssign(flows, permSets);
  }

  async function showConfirmModal(flows, permSets) {
    const gate = await sftkOrgWriteGate(_orgUrl);
    return sftkConfirmDestructive({
      title: 'Confirm Assignment',
      icon: '🔑',
      items: [
        ...flows.map(f => ({ label: f.MasterLabel, sub: 'Flow' })),
        ...permSets.map(p => ({ label: p.Label, sub: 'Permission set' })),
      ],
      revOverride: {
        html: `Grant <strong>Flow Access</strong> (permission to run these flows) to the selected permission sets — ${flows.length} flow(s) → ${permSets.length} permission set(s).` +
          '<div class="sftk-cf-plan"><ol class="sftk-cf-rows">' +
          '<li><b>Not touched</b><span>Additive: existing object/field/Apex permissions on the sets are left untouched</span></li>' +
          '<li><b>Undo</b><span>The grant can be revoked again any time</span></li></ol></div>',
        needsCheckbox: false,
      },
      confirmLabel: '🔑 Assign',
      production: gate.production ? { label: gate.label } : null,
    });
  }

  // ── Grant: SetupEntityAccess rows, nothing else on the set ─────────────
  // 2026-11-14: the old PermissionSet deploy (only <flowAccesses> + <label>)
  // was taken by Salesforce as the whole set — it wiped the set's description
  // and field permissions on npc, and on a packaged set it made a new
  // unmanaged copy. Inserting the access rows changes only the access.
  // Returns { created: [{ key, id }], refused: { key: reason }, duplicate:
  // { key: true } } and never throws: rows made before a later chunk fails
  // must still reach the undo. `duplicate` (2026-11-15) marks the refusals
  // that only say the grant is already there, so doAssign re-reads the org
  // instead of calling a grant that exists a failure.
  async function insertFlowAccess(pairs) {
    const created = [];
    const refused = {};
    const duplicate = {};
    for (let i = 0; i < pairs.length; i += 200) {
      const chunk = pairs.slice(i, i + 200);
      const records = chunk.map(p => ({ attributes: { type: 'SetupEntityAccess' }, ParentId: p.psId, SetupEntityId: p.flowId }));
      let res;
      // verified-by: doAssign's sftkWriteVerified — its verify re-reads SetupEntityAccess for every (flow, permission set) pair
      try { res = await sendBg({ type: 'SF_COLLECTIONS_CREATE', orgUrl: _orgUrl, sid: _sid, records }); }
      catch (e) { res = { error: (e && e.message) || String(e) }; }
      if (!Array.isArray(res)) {
        const why = (res && res.error) || 'no answer from Salesforce';
        for (const p of chunk) refused[p.key] = why;
        continue;
      }
      chunk.forEach((p, j) => {
        const r = res[j];
        if (r && r.success && r.id) created.push({ key: p.key, id: r.id });
        else {
          const errs = (r && Array.isArray(r.errors)) ? r.errors : [];
          refused[p.key] = errs.map(e => e.message || e.statusCode).join('; ') || 'not accepted';
          if (errs.length && errs.every(e => /DUPLICATE_VALUE/i.test(String(e.statusCode || '')) || /duplicate value/i.test(String(e.message || '')))) duplicate[p.key] = true;
        }
      });
    }
    return { created, refused, duplicate };
  }

  // The verify's own read (2026-11-14). It used to call loadData(), which
  // swallows its errors: a failed re-read left the PRE-change map in place,
  // so every new grant looked missing (a false "not granted") and the undo,
  // built from that same old map, offered nothing. This read throws instead,
  // and sftkWriteVerified then says "unverified" — never a guessed verdict.
  async function readFlowAccessRows(flows, permSets) {
    const rows = [];
    const fIds = flows.map(f => f.Id).filter(Boolean);
    const pIds = permSets.map(p => p.Id).filter(Boolean);
    for (let i = 0; i < fIds.length; i += 150) for (let j = 0; j < pIds.length; j += 150) {
      const fl = fIds.slice(i, i + 150).map(id => `'${id}'`).join(',');
      const pl = pIds.slice(j, j + 150).map(id => `'${id}'`).join(',');
      const res = await sendBg({
        type: 'SF_QUERY_ALL', tooling: false, orgUrl: _orgUrl, sid: _sid,
        query: `SELECT Id, ParentId, SetupEntityId FROM SetupEntityAccess WHERE SetupEntityId IN (${fl}) AND ParentId IN (${pl})`
      });
      if (!res || res.error) throw new Error(`the flow access could not be re-read — ${(res && res.error) || 'no answer'}`);
      if (res.incomplete) throw new Error(`the flow access re-read came back incomplete (${res.incomplete.got} of ${res.incomplete.expected})`);
      rows.push(...(res.records || []));
    }
    return rows;
  }

  async function doAssign(flows, permSets) {
    const btn     = document.getElementById('fpAssignBtn');
    const summary = document.getElementById('fpActionSummary');
    if (btn) btn.disabled = true;
    const n = v => Number(v).toLocaleString('en-US');
    const pairName = p => `${p.flow.MasterLabel || p.flow.DeveloperName || p.flow.Id} → ${p.ps.Label || p.ps.Name || p.ps.Id}`;
    const closeBtn = '<div class="modal-footer"><button class="btn btn-secondary" id="modalCancel">Close</button></div>';
    const show = html => { showModal(html + closeBtn); document.getElementById('modalCancel').addEventListener('click', closeModal); };
    const settle = () => { if (btn) btn.textContent = '🔑 Assign'; if (summary) summary.textContent = ''; updateActionBar(); };

    if (summary) summary.innerHTML = sftkCatSm(`Reading the current flow access of ${n(permSets.length)} permission set(s)…`);

    // Which (flow, permission set) pairs ALREADY have a grant: those are not
    // inserted again, and the undo never removes them. 2026-11-15: asked of
    // the ORG, right here. The module's _accessMap is only as fresh as the
    // last load — after a History undo or a change in Setup it still listed a
    // grant that was gone, the pair was skipped, nothing was sent, and the
    // result said Salesforce had accepted it. A read that fails writes nothing.
    const before = new Set();
    try {
      for (const k of Object.keys(sftkFlowAccessCheck(flows, permSets, await readFlowAccessRows(flows, permSets)).present)) before.add(k);
    } catch (e) {
      settle();
      const raw = `The current flow access could not be read, so nothing was written: ${(e && e.message) || String(e)}`;
      show(`
        <div class="modal-header modal-warn">
          <span class="modal-icon">⚠️</span>
          <h2>Nothing was written</h2>
        </div>
        <div class="modal-body">
          <p style="word-break:break-word">${esc(raw)}</p>
        </div>`);
      return;
    }
    const pairs = [];
    for (const f of flows) for (const ps of permSets) {
      const key = `${f.Id}|${ps.Id}`;
      if (!before.has(key)) pairs.push({ key, flowId: f.Id, psId: ps.Id, flow: f, ps });
    }
    const pairByKey = new Map(pairs.map(p => [p.key, p]));
    const alreadyHtml = `
        <div class="modal-header" style="color:var(--active-color)">
          <span class="modal-icon">✅</span>
          <h2>Already granted — nothing to do</h2>
        </div>
        <div class="modal-body">
          <p>Every selected flow is already granted to the selected permission set${permSets.length !== 1 ? 's' : ''}. Nothing was written.</p>
        </div>`;

    // 2026-11-15: nothing to insert is said as that — no write, no History
    // entry. It used to go through sftkWriteVerified as an "accepted" write.
    if (!pairs.length) {
      await loadData();
      settle();
      show(alreadyHtml);
      return;
    }

    if (summary) summary.innerHTML = sftkCatSm(`Granting flow access to ${n(permSets.length)} permission set(s)…`);

    // History (sftk-history.js): one journal for this Assign click.
    const journal = sftkHistoryBegin({ tool: 'Flow Access', title: `🔑 Flow access: ${flows.length} flow(s) → ${permSets.length} permission set(s)`, orgUrl: _orgUrl });
    let ins = { created: [], refused: {}, duplicate: {} };
    let check = null;   // the verify's own re-read, kept for the per-pair result below
    let wr;
    try {
    // confirmed-by: onAssign's showConfirmModal (the only caller of doAssign)
    // The write discipline (sftk-write.js): the insert is the write; the
    // verify re-reads SetupEntityAccess for every pair — never the insert's
    // own answer.
    wr = await sftkWriteVerified({
      describe: `flow access for ${permSets.length} permission set(s)`,
      journal,
      write: async () => {
        ins = await insertFlowAccess(pairs);
        const refusedKeys = Object.keys(ins.refused);
        // Nothing created and something refused = a refusal, said with
        // Salesforce's reason. Not when a refusal is "duplicate value"
        // (2026-11-15): someone granted the pair since the read above, so the
        // org may already be as asked — the re-read below decides, not us.
        if (!ins.created.length && refusedKeys.length && !refusedKeys.some(k => ins.duplicate && ins.duplicate[k])) return { error: ins.refused[refusedKeys[0]] };
        return ins;
      },
      verify: async () => {
        check = sftkFlowAccessCheck(flows, permSets, await readFlowAccessRows(flows, permSets));
        // A pair Salesforce refused carries its reason; the rest of a partial insert stays visible.
        const detail = check.missing.map((m, i) => {
          const why = ins.refused[check.missingKeys[i]];
          return why ? `${m} (${why})` : m;
        });
        // History hears the true count, not "accepted" for rows that were refused.
        const text = check.ok ? null
          : `flow access: ${n(pairs.length - pairs.filter(p => !(p.key in check.present)).length)} of ${n(pairs.length)} grant(s) are in the org after re-reading — not granted: ${detail.slice(0, 5).join('; ')}${detail.length > 5 ? '…' : ''}`;
        return { ok: check.ok, detail, text };
      },
    });
    } finally {
      // Undo: delete only the rows this run CREATED — the ids Salesforce
      // returned for its inserts, not a re-read map (2026-11-14: a failed
      // re-read used to leave a stale map and no undo for real grants).
      // Each step re-reads its own row, so a row already gone is said.
      const steps = [];
      for (const c of ins.created) {
        const p = pairByKey.get(c.key);
        if (!p || before.has(c.key)) continue;
        const name = `${p.flow.MasterLabel || p.flow.DeveloperName} → ${p.ps.Label || p.ps.Name}`;
        steps.push({
          describe: `${name}: remove flow access`,
          // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
          msg: { type: 'SF_REST_DELETE', sobject: 'SetupEntityAccess', id: c.id },
          verify: { query: `SELECT Id FROM SetupEntityAccess WHERE Id = '${c.id}'`, tooling: false, count: 0,
            text: { ok: `${name}: flow access removed — verified by re-reading the org`,
                    bad: `${name}: accepted by Salesforce, but the org still shows this grant` } },
        });
      }
      await sftkHistoryEnd(journal, { undo: steps.length ? { steps } : { none: 'this run created no flow access, so there is nothing to undo' } });
    }
    await loadData();   // refresh the table; the verdict above comes from its own read, not from this one
    settle();

    // ── The result, per pair (2026-11-15) ──────────────────────
    // The insert is allOrNone:false, so some pairs can be made while others
    // are refused. The old all-or-nothing summary said "0 assigned" whenever
    // anything failed, with grants sitting in the org. A re-read that failed
    // is said as unverified (wr.text), never as "grants missing" (2026-11-14).
    const unverifiedNote = !wr.accepted
      ? null
      : !wr.verified
        ? wr.text
        : null;
    const createdKeys = new Set(ins.created.map(c => c.key));
    const made = [];          // created by this run (and seen in the org when it was re-read)
    const failed = [];        // [{ p, why }]
    let alreadyThere = 0;     // in the org, but not made by this run (granted elsewhere meanwhile)
    for (const p of pairs) {
      if (wr.verified && check) {
        if (p.key in check.present) { if (createdKeys.has(p.key)) made.push(p); else alreadyThere++; }
        else failed.push({ p, why: ins.refused[p.key] || 'Salesforce accepted it, but the org does not show this grant after re-reading' });
      } else if (createdKeys.has(p.key)) made.push(p);
      else failed.push({ p, why: ins.refused[p.key] || (wr.raw && (wr.raw.error || wr.raw.errorMessage)) || 'the flow access was not granted' });
    }
    const inPlace = before.size + alreadyThere;
    const undoLine = ins.created.length
      ? `<p style="margin-top:8px;font-size:11px">↩ Undo in History removes the ${n(ins.created.length)} grant${ins.created.length !== 1 ? 's' : ''} this run created.</p>`
      : '';

    // ✅ only when the re-read shows every pair.
    if (wr.ok && !made.length) { show(alreadyHtml); return; }   // every refusal was "already there", and the re-read agrees
    if (wr.ok) {
      show(`
        <div class="modal-header" style="color:var(--active-color)">
          <span class="modal-icon">✅</span>
          <h2>${n(flows.length)} Flow${flows.length !== 1 ? 's' : ''} Assigned</h2>
        </div>
        <div class="modal-body">
          <p style="margin-bottom:8px">
            Assigned to <strong>${n(permSets.length)} permission set${permSets.length !== 1 ? 's' : ''}</strong> —
            ${n(made.length)} grant${made.length !== 1 ? 's' : ''} made${inPlace ? `, ${n(inPlace)} already in place` : ''}.
          </p>
          <ul class="modal-list" style="font-size:11px">
            ${flows.map(f => `<li>${esc(f.MasterLabel)}</li>`).join('')}
          </ul>
        </div>`);
      return;
    }
    const SHOWN = 50;   // a 200-pair run must not grow the dialog without end
    const more = list => (list.length > SHOWN ? `<li>…and ${n(list.length - SHOWN)} more</li>` : '');
    const okHtml = made.slice(0, SHOWN).map(p => `<li>${esc(pairName(p))}</li>`).join('') + more(made);
    const errHtml = failed.slice(0, SHOWN).map(({ p, why }) => {
      const fe = sftkFriendlyError(why);
      return `<li style="word-break:break-word" title="${esc(why)}"><strong>${esc(pairName(p))}</strong>: ${esc(fe.message + (fe.hint ? ' — ' + fe.hint : ''))}</li>`;
    }).join('') + more(failed);
    const head = unverifiedNote
      ? `${n(made.length)} grant${made.length !== 1 ? 's' : ''} created — not confirmed`
      : `${n(made.length)} of ${n(pairs.length)} grant${pairs.length !== 1 ? 's' : ''} made`;
    show(`
        <div class="modal-header modal-warn">
          <span class="modal-icon">⚠️</span>
          <h2>${head}</h2>
        </div>
        <div class="modal-body">
          ${unverifiedNote ? `<p style="margin-bottom:8px;word-break:break-word">${esc(unverifiedNote)}</p>` : ''}
          ${made.length > 0
            ? `<p style="margin-bottom:4px;font-weight:700">${unverifiedNote ? 'Created (not confirmed)' : 'Assigned'}:</p>
               <ul class="modal-list" style="font-size:11px">${okHtml}</ul>`
            : ''}
          ${failed.length > 0
            ? `<p style="margin:8px 0 4px;font-weight:700;color:var(--danger)">Failed:</p>
               <ul class="modal-list" style="font-size:11px">${errHtml}</ul>`
            : ''}
          ${inPlace ? `<p style="margin-top:8px;font-size:11px">${n(inPlace)} selected grant${inPlace !== 1 ? 's were' : ' was'} already in place.</p>` : ''}
          ${undoLine}
        </div>`);
  }

  // ── UI helpers ───────────────────────────────────────────────
  function setLoading(show) {
    const loading   = document.getElementById('fpLoading');
    const content   = document.getElementById('fpContent');
    const actionBar = document.getElementById('fpActionBar');
    if (loading) loading.style.display = show ? 'flex' : 'none';
    if (show) {
      if (content)   content.style.display   = 'none';
      if (actionBar) actionBar.style.display = 'none';
    }
  }

  function showError(msg) {
    const el = document.getElementById('fpError');
    if (!el) return;
    const raw = String(msg || '');
    const fe  = sftkFriendlyError(raw);
    el.innerHTML = `❌ ${esc(fe.message)}` +
      (fe.hint ? `<div style="margin-top:3px;font-size:11px;color:var(--subtext)">${esc(fe.hint)}</div>` : '');
    el.title = raw;
    el.style.display = '';
  }

  function hideError() {
    const el = document.getElementById('fpError');
    if (el) el.style.display = 'none';
  }

  return { init, updateSession };
})();
