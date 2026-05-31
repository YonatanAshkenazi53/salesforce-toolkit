'use strict';
/* ============================================================
   Flow Permissions — bulk-assign Screen Flows to Permission Sets
   ============================================================
   Grants "Flow Access" (the permission to run a flow) by creating
   SetupEntityAccess records:
     SetupEntityType = 'Flow'
     SetupEntityId   = FlowDefinition.Id
     ParentId        = PermissionSet.Id

   We resolve each assignable flow (from FlowDefinitionView) to its real
   FlowDefinition.Id via a DeveloperName join; flows with no FlowDefinition
   row (managed-package / read-only) are skipped — they can't be granted.

   NOTE: we do NOT modify runInMode. That's a Flow-builder setting (how a
   flow runs — system vs user context), not an access grant, and it isn't a
   valid property of FlowDefinition.Metadata in the Tooling API.

   Compatible flow types: Screen Flows only (ProcessType = 'Flow').
   ============================================================ */
const FlowPermissions = (() => {
  let _orgUrl, _sid;
  let _container;
  let _flows     = [];   // FlowDefinitionView records
  let _permSets  = [];   // PermissionSet records
  let _accessMap = {};   // flowDefId -> [{ permSetId, label, accessId }]
  let _selFlows  = new Set();
  let _selPS     = new Set();

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
              <div id="fpPsList" class="fp-list"></div>
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
    setLoading(true);
    hideError();
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

      const BLOCKED_TRIGGERS = new Set([
        'RecordBeforeSave', 'RecordAfterSave', 'Scheduled', 'PlatformEvent', 'DataCloudDataChange'
      ]);
      const assignable = (fdvRes.records || []).filter(r =>
        r.ProcessType === 'Flow' ||
        (r.ProcessType === 'AutoLaunchedFlow' && !BLOCKED_TRIGGERS.has(r.TriggerType || ''))
      );

      // ── Step 2: FlowDefinition (Tooling) — Id ────────────────────────────
      // Id is the only thing we need from FlowDefinition: it's the
      // SetupEntityAccess.SetupEntityId used to grant the flow to a
      // permission set.
      //
      // Query EVERY FlowDefinition (no ActiveVersionId filter — we still want
      // permission management on inactive ones) so the client-side join by
      // DeveloperName resolves as many flows as possible.
      const fdRes = await sendBg({
        type: 'SF_QUERY_ALL', tooling: true, orgUrl: _orgUrl, sid: _sid,
        query: `SELECT Id, DeveloperName FROM FlowDefinition`
      });
      // Build a lookup: DeveloperName → FlowDefinition.Id
      const fdIdByName = {};
      if (!fdRes.error && fdRes.records) {
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
      const [psRes, accessRes] = await Promise.all([
        sendBg({
          type: 'SF_QUERY_ALL', tooling: false, orgUrl: _orgUrl, sid: _sid,
          query: `SELECT Id, Name, Label FROM PermissionSet
                  WHERE IsOwnedByProfile = false ORDER BY Label ASC`
        }),
        sendBg({
          type: 'SF_QUERY_ALL', tooling: false, orgUrl: _orgUrl, sid: _sid,
          query: `SELECT Id, ParentId, Parent.Label, SetupEntityId
                  FROM SetupEntityAccess WHERE SetupEntityType = 'Flow'`
        })
      ]);
      if (psRes.error) throw new Error(psRes.error);

      _permSets = psRes.records || [];

      _accessMap = {};
      for (const r of (accessRes?.records || [])) {
        if (!_accessMap[r.SetupEntityId]) _accessMap[r.SetupEntityId] = [];
        _accessMap[r.SetupEntityId].push({
          permSetId: r.ParentId,
          label:     r.Parent?.Label || r.ParentId,
          accessId:  r.Id
        });
      }

      setLoading(false);
      renderContent();
    } catch (e) {
      setLoading(false);
      const raw = e.message || String(e);
      showError(raw === 'SESSION_EXPIRED' ? 'Session expired — log back into Salesforce and retry' : raw);
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

  function renderFlows() {
    const list    = document.getElementById('fpFlowList');
    const countEl = document.getElementById('fpFlowCount');
    if (!list) return;

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

  function renderPermSets() {
    const list    = document.getElementById('fpPsList');
    const countEl = document.getElementById('fpPsCount');
    if (!list) return;

    const search   = (document.getElementById('fpPsSearch')?.value || '').toLowerCase().trim();
    const filtered = search
      ? _permSets.filter(p => (p.Label || p.Name || '').toLowerCase().includes(search))
      : _permSets;

    const selCount = filtered.filter(p => _selPS.has(p.Id)).length;
    if (countEl) countEl.textContent = selCount > 0
      ? `${selCount} / ${filtered.length}`
      : filtered.length;

    if (filtered.length === 0) {
      list.innerHTML = `<div class="fp-empty">${search ? 'No permission sets match' : 'No custom permission sets found'}</div>`;
      return;
    }

    list.innerHTML = filtered.map(ps => {
      const sel = _selPS.has(ps.Id);
      return `
        <label class="fp-item${sel ? ' fp-item-sel' : ''}" title="${esc(ps.Name)}">
          <input type="checkbox" class="fp-cb fp-ps-cb" data-id="${esc(ps.Id)}"${sel ? ' checked' : ''}>
          <span class="fp-item-name">${esc(ps.Label)}</span>
          <span class="fp-item-api">${esc(ps.Name)}</span>
        </label>`;
    }).join('');

    list.querySelectorAll('.fp-ps-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) _selPS.add(cb.dataset.id);
        else            _selPS.delete(cb.dataset.id);
        cb.closest('.fp-item').classList.toggle('fp-item-sel', cb.checked);
        // update count badge
        const el = document.getElementById('fpPsCount');
        const q  = (document.getElementById('fpPsSearch')?.value || '').toLowerCase().trim();
        const vis = q ? _permSets.filter(p => (p.Label || p.Name || '').toLowerCase().includes(q)) : _permSets;
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
    const permSets = _permSets.filter(p => _selPS.has(p.Id));
    if (!flows.length || !permSets.length) return;

    const confirmed = await showConfirmModal(flows, permSets);
    if (!confirmed) return;

    await doAssign(flows, permSets);
  }

  function showConfirmModal(flows, permSets) {
    return new Promise(resolve => {
      const flowList = flows.map(f => `<li>${esc(f.MasterLabel)}</li>`).join('');
      const psList   = permSets.map(p => `<li>${esc(p.Label)}</li>`).join('');

      showModal(`
        <div class="modal-header" style="color:var(--draft-color)">
          <span class="modal-icon">🔑</span>
          <h2>Confirm Assignment</h2>
        </div>
        <div class="modal-body">
          <p style="margin:0 0 8px;font-size:12px">Grant <strong>Flow Access</strong> (permission to run these flows) to the selected permission sets:</p>
          <p style="margin:8px 0 3px;font-weight:700;font-size:12px">Flows (${flows.length}):</p>
          <ul class="modal-list" style="max-height:90px;overflow-y:auto;font-size:11px">${flowList}</ul>
          <p style="margin:8px 0 3px;font-weight:700;font-size:12px">Permission sets (${permSets.length}):</p>
          <ul class="modal-list" style="max-height:70px;overflow-y:auto;font-size:11px">${psList}</ul>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="modalCancel">Cancel</button>
          <button class="btn btn-primary" id="modalConfirm">🔑 Assign</button>
        </div>
      `);
      document.getElementById('modalCancel').addEventListener('click', () => { closeModal(); resolve(false); });
      document.getElementById('modalConfirm').addEventListener('click', () => { closeModal(); resolve(true); });
    });
  }

  async function doAssign(flows, permSets) {
    const btn     = document.getElementById('fpAssignBtn');
    const summary = document.getElementById('fpActionSummary');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Working…'; }

    const errors    = [];
    const successes = [];

    // Salesforce record Ids are 15 or 18 char base-62 strings. Anything else
    // in the URL path gets reinterpreted as an external-Id field lookup, which
    // produces a 404 with the cryptic message "Provided external ID field
    // does not exist or is not accessible: <value>". Catch bad Ids up front
    // so the failure is obvious in the UI instead.
    const SF_ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

    for (let i = 0; i < flows.length; i++) {
      const f = flows[i];
      if (summary) summary.textContent = `[${i + 1}/${flows.length}] ${f.MasterLabel}…`;

      try {
        if (!f.Id || !SF_ID_RE.test(f.Id)) {
          throw new Error(
            `Can't assign permissions — no FlowDefinition record found for "${f.DeveloperName}". ` +
            `This usually means the flow is from a managed package and is read-only.`);
        }

        // Grant the flow to each permission set via SetupEntityAccess —
        // that IS the "Flow Access" permission (who can run the flow).
        // NOTE: we deliberately do NOT touch runInMode here. runInMode is
        // a Flow-builder setting (how the flow runs — system vs user
        // context), not an access grant, and it isn't even a valid
        // property of FlowDefinition.Metadata in the Tooling API — PATCHing
        // it returns HTTP 400 "Cannot deserialize complexvalue from
        // VALUE_STRING". It also blocked the real grant below from running.
        const existingPS = new Set((_accessMap[f.Id] || []).map(a => a.permSetId));
        for (const ps of permSets) {
          if (existingPS.has(ps.Id)) continue;  // already assigned
          // IMPORTANT: SetupEntityAccess must be created via the TOOLING API.
          // The standard Data API (/sobjects/SetupEntityAccess) rejects
          // SetupEntityType as not-createable → HTTP 400 "Unable to
          // create/update fields: SetupEntityType". The Tooling endpoint
          // allows writing both SetupEntityType and SetupEntityId.
          const r = await sendBg({
            type: 'SF_REST_POST',
            orgUrl: _orgUrl, sid: _sid,
            path: `services/data/v62.0/tooling/sobjects/SetupEntityAccess`,
            body: { SetupEntityType: 'Flow', SetupEntityId: f.Id, ParentId: ps.Id }
          });
          if (r.error) throw new Error(r.error);
        }

        successes.push(f);
      } catch (e) {
        errors.push({ label: f.MasterLabel, msg: e.message || String(e) });
      }
    }

    if (btn) btn.textContent = '🔑 Assign';

    // Reload data to reflect updated PS-assignment counts
    await loadData();

    // Show result
    if (errors.length === 0) {
      showModal(`
        <div class="modal-header" style="color:var(--active-color)">
          <span class="modal-icon">✅</span>
          <h2>${successes.length} Flow${successes.length !== 1 ? 's' : ''} Assigned</h2>
        </div>
        <div class="modal-body">
          <p style="margin-bottom:8px">
            Assigned to <strong>${permSets.length} permission set${permSets.length !== 1 ? 's' : ''}</strong>.
          </p>
          <ul class="modal-list" style="font-size:11px">
            ${successes.map(f => `<li>${esc(f.MasterLabel)}</li>`).join('')}
          </ul>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="modalCancel">Close</button>
        </div>
      `);
      document.getElementById('modalCancel').addEventListener('click', closeModal);
    } else {
      const errHtml = errors.map(e =>
        `<li style="word-break:break-word"><strong>${esc(e.label)}</strong>: ${esc(e.msg)}</li>`
      ).join('');
      const okHtml = successes.map(f => `<li>${esc(f.MasterLabel)}</li>`).join('');
      showModal(`
        <div class="modal-header modal-warn">
          <span class="modal-icon">⚠️</span>
          <h2>${successes.length} assigned, ${errors.length} failed</h2>
        </div>
        <div class="modal-body">
          ${successes.length > 0
            ? `<p style="margin-bottom:4px;font-weight:700">Assigned:</p>
               <ul class="modal-list" style="font-size:11px">${okHtml}</ul>`
            : ''}
          <p style="margin:8px 0 4px;font-weight:700;color:var(--danger)">Failed:</p>
          <ul class="modal-list" style="font-size:11px">${errHtml}</ul>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="modalCancel">Close</button>
        </div>
      `);
      document.getElementById('modalCancel').addEventListener('click', closeModal);
    }
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
    if (el) { el.innerHTML = `❌ ${esc(msg)}`; el.style.display = ''; }
  }

  function hideError() {
    const el = document.getElementById('fpError');
    if (el) el.style.display = 'none';
  }

  return { init, updateSession };
})();
