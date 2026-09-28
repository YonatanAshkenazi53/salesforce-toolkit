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
    const permSets = _permSets.filter(p => _selPS.has(p.Id));
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
        html: `Grant <strong>Flow Access</strong> (permission to run these flows) to the selected permission sets — ${flows.length} flow(s) → ${permSets.length} permission set(s). Additive: existing object/field/Apex permissions on the sets are left untouched, and the grant can be revoked again any time.`,
        needsCheckbox: false,
      },
      confirmLabel: '🔑 Assign',
      production: gate.production ? { label: gate.label } : null,
    });
  }

  // ── Metadata API: grant flow access via PermissionSet deploy ───────────
  // Stored-zip building delegates to the shared builder in sftk-zip.js
  // (loaded before this module in popup.html).
  function _fpBuildStoredZip(files) {
    return window.sftkBuildStoredZip(files);
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
    // verified-by: doAssign's sftkWriteVerified — its verify re-reads SetupEntityAccess for every (flow, permission set) pair
    return sendBg({
      type: 'SF_METADATA_DEPLOY', orgUrl: _orgUrl, sid: _sid,
      zipBase64: _fpBuildStoredZip(files)
    });
  }

  async function doAssign(flows, permSets) {
    const btn     = document.getElementById('fpAssignBtn');
    const summary = document.getElementById('fpActionSummary');
    if (btn) btn.disabled = true;

    // Grant flow access via the METADATA API — deploy each selected
    // PermissionSet with <flowAccesses> members. This is the ONLY mechanism
    // that actually works. The REST SetupEntityAccess insert returns HTTP 200
    // but creates NO usable grant (Salesforce Setup → Permission Set → Flow
    // Access shows nothing afterward). Permission-set metadata deploys are
    // ADDITIVE: only the flowAccesses we declare are added; existing
    // object/field/Apex permissions on the set are left untouched.
    if (summary) summary.innerHTML = sftkCatSm(`Deploying flow access to ${permSets.length} permission set(s)…`);

    const flowApiNames = flows.map(f => f.DeveloperName).filter(Boolean);
    // History (sftk-history.js): one journal for this Assign click. Snapshot
    // which (flow, permission set) pairs ALREADY had a grant before the
    // deploy — the deploy is additive, so re-running it over an existing
    // grant must not make the undo delete something this run didn't create.
    const journal = sftkHistoryBegin({ tool: 'Flow Access', title: `🔑 Flow access: ${flows.length} flow(s) → ${permSets.length} permission set(s)`, orgUrl: _orgUrl });
    const before = new Set();
    for (const f of flows) for (const g of (_accessMap[f.Id] || [])) if (permSets.some(ps => ps.Id === g.permSetId)) before.add(`${f.Id}|${g.permSetId}`);
    let wr;
    try {
    // confirmed-by: onAssign's showConfirmModal (the only caller of doAssign)
    // The write discipline (sftk-write.js): the deploy is the write; the
    // verify is the same SetupEntityAccess read loadData() already performs
    // — never the deploy's own answer (a REST insert here used to return
    // HTTP 200 with NO usable grant, which is exactly what this checks for).
    wr = await sftkWriteVerified({
      describe: `flow access for ${permSets.length} permission set(s)`,
      journal,
      write: () => deployFlowAccess(permSets, flowApiNames),
      verify: async () => {
        // Reload so the SetupEntityAccess read (now matched by flow Id)
        // surfaces the real grants the deploy created.
        await loadData();
        const missing = [];
        for (const f of flows) for (const ps of permSets) {
          if (!(_accessMap[f.Id] || []).some(g => g.permSetId === ps.Id)) missing.push(`${f.MasterLabel} → ${ps.Label}`);
        }
        return { ok: missing.length === 0, detail: missing, text: null };
      },
    });
    if (!wr.accepted) await loadData();   // verify never ran — refresh the table anyway
    } finally {
      // Undo: delete only the SetupEntityAccess rows this run CREATED (not
      // in `before`) and that the re-read now confirms exist.
      const steps = [];
      for (const f of flows) for (const g of (_accessMap[f.Id] || [])) {
        if (!permSets.some(ps => ps.Id === g.permSetId)) continue;
        if (before.has(`${f.Id}|${g.permSetId}`)) continue;
        if (!g.accessId) continue;
        steps.push({
          describe: `${f.MasterLabel} → ${g.label}: remove flow access`,
          // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
          msg: { type: 'SF_REST_DELETE', sobject: 'SetupEntityAccess', id: g.accessId },
          verify: { query: `SELECT Id FROM SetupEntityAccess WHERE Id = '${g.accessId}'`, tooling: false, count: 0,
            text: { ok: `${f.MasterLabel} → ${g.label}: flow access removed — verified by re-reading the org`,
                    bad: `${f.MasterLabel} → ${g.label}: accepted by Salesforce, but the org still shows this grant` } },
        });
      }
      await sftkHistoryEnd(journal, { undo: steps.length ? { steps } : { none: 'nothing was confirmed granted, so there is nothing to undo' } });
    }

    if (btn) btn.textContent = '🔑 Assign';
    if (summary) summary.textContent = '';

    // Deploy is all-or-nothing (rollbackOnError) → every flow either landed
    // on every selected PS, or none did.
    const deployErr = !wr.accepted
      ? ((wr.raw && (wr.raw.error || wr.raw.errorMessage)) || 'Deployment failed')
      : (!wr.ok
          ? `accepted, but the org does not yet show ${wr.detail.length} expected grant(s) after re-reading: ${wr.detail.slice(0, 5).join('; ')}${wr.detail.length > 5 ? '…' : ''}`
          : null);
    const errors    = deployErr
      ? [{ label: 'Deployment', fe: sftkFriendlyError(deployErr), raw: deployErr }]
      : [];
    const successes = deployErr ? [] : flows;

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
        `<li style="word-break:break-word" title="${esc(e.raw)}"><strong>${esc(e.label)}</strong>: ${esc(e.fe.message + (e.fe.hint ? ' — ' + e.fe.hint : ''))}</li>`
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
