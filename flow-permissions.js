'use strict';
/* ============================================================
   Flow Permissions — bulk-assign Screen Flows to Permission Sets
   ============================================================
   WRITE (grant): via the METADATA API. We deploy each selected
   PermissionSet with <flowAccesses><enabled>true</enabled><flow>API
   name</flow></flowAccesses>. This is the only mechanism that actually
   creates a usable grant — a REST insert into SetupEntityAccess returns
   HTTP 200 but produces NO real Flow Access (Setup shows nothing). The
   deploy is additive: only flowAccesses are declared, so existing
   object/field/Apex permissions on the set are preserved.

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
const FlowPermissions = (() => {
  let _orgUrl, _sid;
  let _container;
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
              <label class="fp-ps-filter" title="Show only permission sets that already grant access to at least one flow">
                <input type="checkbox" id="fpPsOnlyFlows"> ⚡ Only show perm sets with flows enabled
              </label>
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
      // Read SetupEntityAccess by SetupEntityId IN (our FlowDefinition Ids),
      // NOT by `WHERE SetupEntityType = 'Flow'`. The grant we create (REST
      // insert with just SetupEntityId) is stored with a type string that
      // doesn't reliably equal 'Flow', so the type filter missed it even
      // though Salesforce Setup shows the access. Matching on the flow Ids
      // we already display sidesteps the type-string entirely. Chunked to
      // keep the IN() clause within SOQL limits.
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
          if (res?.records) out.push(...res.records);
        }
        return out;
      })();
      const [psRes, accessRecords] = await Promise.all([
        sendBg({
          type: 'SF_QUERY_ALL', tooling: false, orgUrl: _orgUrl, sid: _sid,
          query: `SELECT Id, Name, Label FROM PermissionSet
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

      _permSets = psRes.records || [];

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

  // ── Metadata API: grant flow access via PermissionSet deploy ───────────
  // CRC-32 + stored-zip builder (same algorithm field-cleaner/lightning-pages
  // use; kept local so this module is self-contained).
  function _fpCrc32(bytes) {
    if (!_fpCrc32._t) {
      _fpCrc32._t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        _fpCrc32._t[i] = c;
      }
    }
    let c = 0xFFFFFFFF;
    for (const b of bytes) c = _fpCrc32._t[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function _fpBuildStoredZip(files) {
    const localBlocks = [], centralRecs = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const enc = new TextEncoder();

    for (const file of files) {
      const name = enc.encode(file.name);
      const data = file.data instanceof Uint8Array ? file.data : enc.encode(String(file.data));
      const crc  = _fpCrc32(data);
      const local = new Uint8Array(30 + name.length + data.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true); lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true); lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
      local.set(name, 30); local.set(data, 30 + name.length);

      const central = new Uint8Array(46 + name.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 0x0314, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true); cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true); cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
      central.set(name, 46);

      localBlocks.push(local); centralRecs.push(central);
      offset += local.length;
    }

    const centralSize = centralRecs.reduce((s, r) => s + r.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    const zip = new Uint8Array(offset + centralSize + eocd.length);
    let pos = 0;
    for (const b of localBlocks) { zip.set(b, pos); pos += b.length; }
    for (const r of centralRecs) { zip.set(r, pos); pos += r.length; }
    zip.set(eocd, pos);

    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < zip.length; i += CHUNK) {
      binary += String.fromCharCode(...zip.subarray(i, Math.min(i + CHUNK, zip.length)));
    }
    return btoa(binary);
  }

  // PermissionSet metadata XML carrying ONLY <flowAccesses> (+ the required
  // <label>). Additive — leaves all other permissions on the set intact.
  function buildPermSetXml(label, flowApiNames) {
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">'
    ];
    for (const fn of flowApiNames) {
      lines.push(
        '    <flowAccesses>',
        '        <enabled>true</enabled>',
        `        <flow>${esc(fn)}</flow>`,
        '    </flowAccesses>'
      );
    }
    lines.push(`    <label>${esc(label)}</label>`);
    lines.push('</PermissionSet>');
    return lines.join('\n');
  }

  function buildPermSetPackageXml(psApiNames) {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <types>',
      ...psApiNames.map(n => `        <members>${esc(n)}</members>`),
      '        <name>PermissionSet</name>',
      '    </types>',
      '    <version>62.0</version>',
      '</Package>'
    ].join('\n');
  }

  // Build a single deploy package: package.xml + one .permissionset file per
  // selected permission set, each granting all selected flows. Deploy once.
  async function deployFlowAccess(permSets, flowApiNames) {
    const enc = new TextEncoder();
    const files = [
      { name: 'package.xml', data: enc.encode(buildPermSetPackageXml(permSets.map(p => p.Name))) }
    ];
    for (const ps of permSets) {
      files.push({
        name: `permissionsets/${ps.Name}.permissionset`,
        data: enc.encode(buildPermSetXml(ps.Label, flowApiNames))
      });
    }
    return sendBg({
      type: 'SF_METADATA_DEPLOY', orgUrl: _orgUrl, sid: _sid,
      zipBase64: _fpBuildStoredZip(files)
    });
  }

  async function doAssign(flows, permSets) {
    const btn     = document.getElementById('fpAssignBtn');
    const summary = document.getElementById('fpActionSummary');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Working…'; }

    // Grant flow access via the METADATA API — deploy each selected
    // PermissionSet with <flowAccesses> members. This is the ONLY mechanism
    // that actually works. The REST SetupEntityAccess insert returns HTTP 200
    // but creates NO usable grant (Salesforce Setup → Permission Set → Flow
    // Access shows nothing afterward). Permission-set metadata deploys are
    // ADDITIVE: only the flowAccesses we declare are added; existing
    // object/field/Apex permissions on the set are left untouched.
    if (summary) summary.textContent = `Deploying flow access to ${permSets.length} permission set(s)…`;

    const flowApiNames = flows.map(f => f.DeveloperName).filter(Boolean);
    let deployErr = null;
    try {
      const res = await deployFlowAccess(permSets, flowApiNames);
      if (res?.error) deployErr = res.error;
      else if (res && res.success === false) deployErr = res.errorMessage || 'Deployment failed';
    } catch (e) {
      deployErr = e.message || String(e);
    }

    if (btn) btn.textContent = '🔑 Assign';
    if (summary) summary.textContent = '';

    // Deploy is all-or-nothing (rollbackOnError) → every flow either landed
    // on every selected PS, or none did.
    const errors    = deployErr ? [{ label: 'Deployment', msg: deployErr }] : [];
    const successes = deployErr ? [] : flows;

    // Reload so the SetupEntityAccess read (now matched by flow Id) surfaces
    // the real grants the deploy created.
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
