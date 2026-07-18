// Dependency Map module — builds and renders the subflow dependency map

// Extract every external reference from ONE flow's Metadata (N4a — blast
// radius). Walks the element types that name objects/fields explicitly, then
// sweeps the raw metadata text for $Record.Field / $Label.Name references
// (formulas, templates). Pure — unit-testable (top-level for extract.mjs).
function sftkFlowRefs(meta) {
  const objects = new Map();   // object → Set(ops)
  const fields = new Set(), subflows = new Set(), apex = new Set(), labels = new Set();
  if (!meta || typeof meta !== 'object') {
    return { objects: [], fields: [], subflows: [], apex: [], labels: [] };
  }
  const arr = x => Array.isArray(x) ? x : [];
  const addObj = (o, op) => { if (!o) return; if (!objects.has(o)) objects.set(o, new Set()); objects.get(o).add(op); };
  const addField = (obj, f) => { if (f) fields.add(obj ? `${obj}.${f}` : String(f)); };

  const st = meta.start || {};
  if (st.object) { addObj(st.object, 'trigger'); arr(st.filters).forEach(f => addField(st.object, f.field)); }
  for (const rl of arr(meta.recordLookups)) {
    addObj(rl.object, 'read');
    arr(rl.filters).forEach(f => addField(rl.object, f.field));
    arr(rl.queriedFields).forEach(f => addField(rl.object, f));
    arr(rl.outputAssignments).forEach(a => addField(rl.object, a.field));
  }
  for (const rc of arr(meta.recordCreates)) { addObj(rc.object, 'create'); arr(rc.inputAssignments).forEach(a => addField(rc.object, a.field)); }
  for (const ru of arr(meta.recordUpdates)) { addObj(ru.object, 'update'); arr(ru.filters).forEach(f => addField(ru.object, f.field)); arr(ru.inputAssignments).forEach(a => addField(ru.object, a.field)); }
  for (const rd of arr(meta.recordDeletes)) { addObj(rd.object, 'delete'); arr(rd.filters).forEach(f => addField(rd.object, f.field)); }
  for (const v of arr(meta.variables)) if (v.objectType) addObj(v.objectType, 'variable');
  for (const d of arr(meta.dynamicChoiceSets)) {
    if (d.object) { addObj(d.object, 'choice'); addField(d.object, d.displayField); addField(d.object, d.valueField); }
    if (d.picklistObject) { addObj(d.picklistObject, 'choice'); addField(d.picklistObject, d.picklistField); }
  }
  for (const sf of arr(meta.subflows)) if (sf.flowName) subflows.add(sf.flowName);
  for (const ac of arr(meta.actionCalls)) if (ac.actionName && /apex/i.test(ac.actionType || '')) apex.add(ac.actionName);
  for (const ap of arr(meta.apexPluginCalls)) if (ap.apexClass) apex.add(ap.apexClass);

  const txt = JSON.stringify(meta);
  let m;
  const recRe = /\$Record\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?)/g;
  while ((m = recRe.exec(txt))) addField(st.object || '$Record', m[1]);
  const labRe = /\$Label\.([A-Za-z0-9_]+)/g;
  while ((m = labRe.exec(txt))) labels.add(m[1]);

  return {
    objects: [...objects.entries()].map(([name, ops]) => ({ name, ops: [...ops].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    fields: [...fields].sort(),
    subflows: [...subflows].sort(),
    apex: [...apex].sort(),
    labels: [...labels].sort(),
  };
}

const DependencyMap = (() => {
  let dependencyMap = {}; // subflowApiName -> [{ id, masterLabel, versionNumber, status, processType }]
  let flowsByApiName = {}; // apiName -> [flow records]
  let triggerTypeMap = {};   // flowId -> triggerType string from Metadata.start.triggerType
  let triggerObjectMap = {}; // flowId -> SObject API name from Metadata.start.object
  // N4 — the metadata is already downloaded per flow; keep what it references
  // instead of throwing it away. refsByFlowId powers 🧨 blast radius,
  // metaTextByFlowId powers the "what uses…" reverse lookup.
  let refsByFlowId = {};     // flowId -> sftkFlowRefs(meta)
  let metaTextByFlowId = {}; // flowId -> JSON.stringify(meta)
  let metadataFetched = false;
  let fetchInProgress = false;
  let _runToken = 0;   // bumped on every reset() — invalidates in-flight scans

  function reset() {
    _runToken++;       // any in-flight buildDependencyMap is now superseded
    dependencyMap = {};
    flowsByApiName = {};
    triggerTypeMap = {};
    triggerObjectMap = {};
    refsByFlowId = {};
    metaTextByFlowId = {};
    metadataFetched = false;
    fetchInProgress = false;
  }

  async function buildDependencyMap(flows, orgUrl, sid, progressCallback) {
    if (metadataFetched) return dependencyMap;
    if (fetchInProgress) return dependencyMap;
    fetchInProgress = true;
    // Claim this run. If reset() is called again (e.g. loadFlows re-runs on an
    // org switch), _runToken changes and this scan stops — so a stale scan
    // never fires metadata GETs with the wrong org's flow IDs.
    const myToken = _runToken;

    dependencyMap = {};
    flowsByApiName = {};

    // Index flows by API name
    for (const f of flows) {
      if (!flowsByApiName[f.ApiName]) flowsByApiName[f.ApiName] = [];
      flowsByApiName[f.ApiName].push(f);
    }

    const total = flows.length;
    let done = 0;

    // No caller-supplied progress UI (popup.js passes null below the lazy
    // threshold) — fall back to the shared compact loading cat in the
    // Dependencies tab container so the scan is never completely invisible.
    // Any later render of that tab repaints the container, so this cleans
    // itself up.
    let fallbackMsgEl = null;
    if (!progressCallback) {
      const depContainer = document.getElementById('depTreeContainer');
      if (depContainer) {
        depContainer.innerHTML = sftkCatSm(`Scanning flow metadata… 0 / ${total}`);
        fallbackMsgEl = depContainer.querySelector('.lp-robot-msg');
      }
    }

    // Fetch metadata in batches of 10
    const BATCH = 10;
    for (let i = 0; i < flows.length; i += BATCH) {
      // Superseded by a newer reset()/scan — stop firing GETs and bail out.
      // Leave fetchInProgress alone; the newer scan owns the module state.
      if (myToken !== _runToken) return dependencyMap;
      const batch = flows.slice(i, i + BATCH);
      await Promise.all(batch.map(async (flow) => {
        try {
          const result = await chrome.runtime.sendMessage({
            type: 'SF_GET_METADATA',
            orgUrl,
            sid,
            id: flow.Id,
            // A metadata GET can legitimately 404 for a deleted / obsolete flow
            // version — buildDependencyMap skips those silently, so don't flag
            // them as hard errors in the debug log.
            _suppressError: true
          });
          if (result && !result.error && result.Metadata) {
            const meta = result.Metadata;
            const triggerType = meta.start?.triggerType || meta.triggerType || null;
            const triggerObj  = meta.start?.object || null;
            if (triggerType) triggerTypeMap[flow.Id]   = triggerType;
            if (triggerObj)  triggerObjectMap[flow.Id] = triggerObj;
            try {
              refsByFlowId[flow.Id] = sftkFlowRefs(meta);
              metaTextByFlowId[flow.Id] = JSON.stringify(meta);
            } catch (_) { /* refs are additive — never fail the map build */ }

            const subflows = meta.subflows || [];
            for (const sf of subflows) {
              const calledApiName = sf.flowName;
              if (!calledApiName) continue; // skip null/undefined/empty flowName refs
              if (!dependencyMap[calledApiName]) dependencyMap[calledApiName] = [];
              dependencyMap[calledApiName].push({
                id: flow.Id,
                masterLabel: flow.MasterLabel,
                apiName: flow.ApiName,
                versionNumber: flow.VersionNumber,
                status: flow.Status,
                processType: flow.ProcessType
              });
            }
          }
        } catch (e) {
          // Silently skip metadata fetch errors
        }
        done++;
        if (progressCallback) progressCallback(done, total);
        else if (fallbackMsgEl) fallbackMsgEl.textContent = `Scanning flow metadata… ${done} / ${total}`;
      }));
    }

    // Only commit completion state if this scan is still the current one.
    if (myToken === _runToken) {
      metadataFetched = true;
      fetchInProgress = false;
    }
    return dependencyMap;
  }

  function getDependencyMap() { return dependencyMap; }
  function isMetadataFetched() { return metadataFetched; }
  function getTriggerObjectMap() { return triggerObjectMap; }

  function getParentsForApiName(apiName) {
    return dependencyMap[apiName] || [];
  }

  function getFlowsByApiName() { return flowsByApiName; }

  // Render the dependency tree tab content
  function renderDependencyTreeTab(allFlows, container, orgUrl) {
    container.innerHTML = '';

    const filterBar = document.createElement('div');
    filterBar.className = 'dep-filter-bar';
    filterBar.innerHTML = `
      <div class="dep-filter-buttons">
        <button class="dep-filter-btn active" data-type="all">All</button>
        <button class="dep-filter-btn" data-type="RecordTriggeredFlow">⚡ Record-Triggered</button>
        <button class="dep-filter-btn" data-type="Flow">🖥 Screen</button>
        <button class="dep-filter-btn" data-type="AutoLaunchedFlow">🔄 Auto-launched</button>
        <button class="dep-filter-btn" data-type="ScheduledFlow">📅 Scheduled</button>
      </div>
      <div class="dep-expand-btns">
        <button class="btn-small" id="expandAll">Expand All</button>
        <button class="btn-small" id="collapseAll">Collapse All</button>
      </div>
    `;
    container.appendChild(filterBar);

    // N4b — reverse lookup: field / object / label / any literal (e.g. a
    // picklist value) → every flow whose metadata mentions it.
    const refSearchRow = document.createElement('div');
    refSearchRow.className = 'dep-ref-search-row';
    refSearchRow.innerHTML = `
      <input type="text" id="depRefSearch" class="dep-ref-search"
        placeholder="🔎 What uses… a field API name, object, or value (e.g. SLA__c, Account, Gold)" autocomplete="off">
      <button class="btn-small" id="depRefGo">Search</button>`;
    container.appendChild(refSearchRow);
    const refResults = document.createElement('div');
    refResults.id = 'depRefResults';
    container.appendChild(refResults);

    const runRefSearch = () => {
      const term = (document.getElementById('depRefSearch')?.value || '').trim();
      if (!term) { refResults.innerHTML = ''; return; }
      const hits = searchReferences(term);
      const byId = {};
      for (const f of allFlows) byId[f.Id] = f;
      refResults.innerHTML = hits.length
        ? `<div class="dep-ref-hdr">${hits.length} flow(s) mention “${escHtml(term)}” <span class="dep-ref-note">(literal, case-insensitive match in the flow's metadata)</span></div>`
          + hits.map(h => {
            const f = byId[h.flowId];
            if (!f) return '';
            return `<div class="dep-ref-hit" data-id="${escHtml(f.Id)}" title="Open in Flow Builder">
              <span class="dep-node-name">${escHtml(f.MasterLabel)}</span>
              <span class="badge dep-type-badge">${escHtml(f.ProcessType || '')}</span>
              <span class="badge ${f.Status === 'Active' ? 'badge-active' : 'badge-draft'}">${escHtml(f.Status || '')}</span>
              <span class="dep-ref-count">×${h.count}</span>
            </div>`;
          }).join('')
        : `<div class="dep-ref-hdr">No flow mentions “${escHtml(term)}”${isMetadataFetched() ? '' : ' — metadata scan still running, try again in a moment'}.</div>`;
      refResults.querySelectorAll('.dep-ref-hit').forEach(row =>
        row.addEventListener('click', () =>
          chrome.tabs.create({ url: `${orgUrl}/builder_platform_interaction/flowBuilder.app?flowId=${row.dataset.id}` })));
    };
    document.getElementById('depRefGo')?.addEventListener('click', runRefSearch);
    document.getElementById('depRefSearch')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') runRefSearch();
      if (e.key === 'Escape') { e.target.value = ''; refResults.innerHTML = ''; }
    });

    // Build parent->children map using dependency map
    const childrenMap = {}; // parentApiName -> [child apiNames]
    const parentSet = new Set(); // apiNames that are parents
    const childSet = new Set(); // apiNames that are children (called as subflows)

    for (const [calledApiName, parents] of Object.entries(dependencyMap)) {
      childSet.add(calledApiName);
      for (const parent of parents) {
        parentSet.add(parent.apiName);
        if (!childrenMap[parent.apiName]) childrenMap[parent.apiName] = new Set();
        childrenMap[parent.apiName].add(calledApiName);
      }
    }

    // Group flows by MasterLabel for latest version display
    const flowsByLabel = {};
    for (const f of allFlows) {
      if (!flowsByLabel[f.MasterLabel]) flowsByLabel[f.MasterLabel] = [];
      flowsByLabel[f.MasterLabel].push(f);
    }

    // Get latest active version or highest version per label
    const representativeFlows = {};
    for (const [label, versions] of Object.entries(flowsByLabel)) {
      const active = versions.find(v => v.Status === 'Active');
      representativeFlows[label] = active || versions[versions.length - 1];
    }

    // Top-level flows = have children but are not children themselves (or are standalone)
    const rootFlows = Object.values(representativeFlows).filter(f => {
      const isParent = parentSet.has(f.ApiName);
      const isChild = childSet.has(f.ApiName);
      return isParent && !isChild;
    });

    const standaloneFlows = Object.values(representativeFlows).filter(f => {
      const isParent = parentSet.has(f.ApiName);
      const isChild = childSet.has(f.ApiName);
      return !isParent && !isChild;
    });

    const treeContainer = document.createElement('div');
    treeContainer.className = 'dep-tree-container';
    container.appendChild(treeContainer);

    let activeFilter = 'all';
    const allNodes = [];

    function getFlowIcon(processType) {
      switch (processType) {
        case 'RecordTriggeredFlow': return '⚡';
        case 'Flow': return '🖥';
        case 'AutoLaunchedFlow': return '🔄';
        case 'ScheduledFlow': return '📅';
        case 'PlatformEventFlow': return '🔁';
        default: return '🔄';
      }
    }

    function getStatusBadgeClass(status) {
      switch (status) {
        case 'Active': return 'badge-active';
        case 'Draft': return 'badge-draft';
        case 'Obsolete': return 'badge-obsolete';
        default: return 'badge-obsolete';
      }
    }

    function renderFlowNode(flow, depth, visited) {
      const node = document.createElement('div');
      node.className = 'dep-node';
      node.dataset.processType = flow.ProcessType || '';
      node.dataset.apiName = flow.ApiName;
      node.style.paddingLeft = `${depth * 20 + 8}px`;

      const icon = getFlowIcon(flow.ProcessType);
      const statusClass = getStatusBadgeClass(flow.Status);
      const hasChildren = childrenMap[flow.ApiName] && childrenMap[flow.ApiName].size > 0;

      node.innerHTML = `
        <span class="dep-node-toggle">${hasChildren ? '▼' : '&nbsp;&nbsp;'}</span>
        <span class="dep-node-icon">${icon}</span>
        <span class="dep-node-name" title="Open in Salesforce">${escHtml(flow.MasterLabel)}</span>
        <span class="badge dep-type-badge">${escHtml(flow.ProcessType || '')}</span>
        <span class="badge ${statusClass}">${flow.Status}</span>
      `;

      node.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showDepContextMenu(e, flow);
      });

      node.querySelector('.dep-node-name').addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.tabs.create({ url: `${orgUrl}/builder_platform_interaction/flowBuilder.app?flowId=${flow.Id}` });
      });

      allNodes.push(node);

      const childContainer = document.createElement('div');
      childContainer.className = 'dep-children';

      if (hasChildren && !visited.has(flow.ApiName)) {
        visited.add(flow.ApiName);

        if (depth >= 3) {
          const warn = document.createElement('div');
          warn.className = 'dep-deep-warning';
          warn.style.paddingLeft = `${(depth + 1) * 20 + 8}px`;
          warn.textContent = '⚠️ Dependency chain is deeper than 3 levels. Manual review recommended.';
          childContainer.appendChild(warn);
        } else {
          for (const childApiName of childrenMap[flow.ApiName]) {
            const childFlow = Object.values(representativeFlows).find(f => f.ApiName === childApiName);
            if (childFlow) {
              const childResult = renderFlowNode(childFlow, depth + 1, new Set(visited));
              childContainer.appendChild(childResult.node);
              if (childResult.children.children.length > 0 || childResult.children.childElementCount > 0) {
                childContainer.appendChild(childResult.children);
              }
            } else {
              const missingNode = document.createElement('div');
              missingNode.className = 'dep-node dep-missing';
              missingNode.style.paddingLeft = `${(depth + 1) * 20 + 8}px`;
              missingNode.innerHTML = `<span class="dep-node-icon">❓</span> <span class="dep-node-name">${escHtml(childApiName)}</span> <span class="badge badge-obsolete">Not found</span>`;
              childContainer.appendChild(missingNode);
            }
          }
        }

        const toggle = node.querySelector('.dep-node-toggle');
        toggle.style.cursor = 'pointer';
        toggle.addEventListener('click', (e) => {
          e.stopPropagation();
          const isOpen = childContainer.style.display !== 'none';
          childContainer.style.display = isOpen ? 'none' : '';
          toggle.textContent = isOpen ? '▶' : '▼';
        });
        node.addEventListener('click', () => {
          const isOpen = childContainer.style.display !== 'none';
          childContainer.style.display = isOpen ? 'none' : '';
          toggle.textContent = isOpen ? '▶' : '▼';
          highlightBranch(node, childContainer, !isOpen);
        });
      }

      return { node, children: childContainer };
    }

    function highlightBranch(node, children, on) {
      node.classList.toggle('dep-highlighted', on);
      children.querySelectorAll('.dep-node').forEach(n => n.classList.toggle('dep-highlighted', on));
    }

    // Render root flows
    if (rootFlows.length > 0) {
      const section = document.createElement('div');
      section.className = 'dep-section';
      section.innerHTML = '<div class="dep-section-header">Flow Hierarchies</div>';
      treeContainer.appendChild(section);

      for (const flow of rootFlows) {
        const { node, children } = renderFlowNode(flow, 0, new Set());
        section.appendChild(node);
        section.appendChild(children);
      }
    }

    // Standalone flows
    if (standaloneFlows.length > 0) {
      const standalone = document.createElement('div');
      standalone.className = 'dep-section dep-standalone';
      standalone.innerHTML = `<div class="dep-section-header dep-standalone-header">🏝 Standalone Flows (${standaloneFlows.length})</div>`;
      const standaloneList = document.createElement('div');
      standaloneList.className = 'dep-children';
      standaloneList.style.display = 'none';
      standalone.appendChild(standaloneList);

      standalone.querySelector('.dep-standalone-header').addEventListener('click', () => {
        const isOpen = standaloneList.style.display !== 'none';
        standaloneList.style.display = isOpen ? 'none' : '';
      });

      for (const flow of standaloneFlows) {
        const { node } = renderFlowNode(flow, 0, new Set());
        standaloneList.appendChild(node);
      }

      treeContainer.appendChild(standalone);
    }

    if (rootFlows.length === 0 && standaloneFlows.length === 0) {
      treeContainer.innerHTML = '<div class="empty-state">No subflow relationships found — all flows appear to be standalone.</div>';
    }

    // Filter functionality
    filterBar.querySelectorAll('.dep-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        filterBar.querySelectorAll('.dep-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeFilter = btn.dataset.type;
        allNodes.forEach(node => {
          const pt = node.dataset.processType;
          const match = activeFilter === 'all' || pt === activeFilter;
          node.classList.toggle('dep-dimmed', !match);
        });
      });
    });

    document.getElementById('expandAll').addEventListener('click', () => {
      treeContainer.querySelectorAll('.dep-children').forEach(c => c.style.display = '');
      treeContainer.querySelectorAll('.dep-node-toggle').forEach(t => {
        if (t.textContent.trim() === '▶') t.textContent = '▼';
      });
    });

    document.getElementById('collapseAll').addEventListener('click', () => {
      treeContainer.querySelectorAll('.dep-children').forEach(c => c.style.display = 'none');
      treeContainer.querySelectorAll('.dep-node-toggle').forEach(t => {
        if (t.textContent.trim() === '▼') t.textContent = '▶';
      });
    });
  }

  let contextMenu = null;
  function showDepContextMenu(e, flow) {
    if (contextMenu) contextMenu.remove();
    contextMenu = document.createElement('div');
    contextMenu.className = 'dep-context-menu';
    contextMenu.style.left = e.clientX + 'px';
    contextMenu.style.top = e.clientY + 'px';
    contextMenu.innerHTML = `
      <div class="dep-context-item" id="depCtxBlast">🧨 Blast radius — what this flow touches</div>
      <div class="dep-context-item" id="depCtxSelect">Select this flow for deletion</div>`;
    document.body.appendChild(contextMenu);

    document.getElementById('depCtxBlast').addEventListener('click', () => {
      contextMenu.remove();
      contextMenu = null;
      showBlastRadius(flow);
    });
    document.getElementById('depCtxSelect').addEventListener('click', () => {
      contextMenu.remove();
      contextMenu = null;
      // Switch to main tab and check this flow
      const event = new CustomEvent('selectFlowForDeletion', { detail: { flow } });
      document.dispatchEvent(event);
      document.querySelector('.tab-btn[data-tab="flows"]')?.click();
    });

    document.addEventListener('click', () => {
      if (contextMenu) { contextMenu.remove(); contextMenu = null; }
    }, { once: true });
  }

  function escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function getTriggerTypeMap() { return triggerTypeMap; }

  // ── N4 API ────────────────────────────────────────────────────────────
  function getRefsFor(flowId) { return refsByFlowId[flowId] || null; }

  // Reverse lookup: which flows literally mention this term (field API name,
  // object, label, or any value like "Gold") anywhere in their metadata?
  function searchReferences(term) {
    const t = String(term || '').trim();
    if (!t) return [];
    const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const out = [];
    for (const [flowId, txt] of Object.entries(metaTextByFlowId)) {
      const n = (txt.match(re) || []).length;
      if (n) out.push({ flowId, count: n });
    }
    return out.sort((a, b) => b.count - a.count);
  }

  // 🧨 Blast radius panel — everything one flow touches + who calls IT,
  // ending in a plain-language delete/deactivate risk verdict.
  function showBlastRadius(flow) {
    document.querySelector('.dep-blast-panel')?.remove();
    const refs = refsByFlowId[flow.Id];
    const callers = getParentsForApiName(flow.ApiName);
    const verdict = callers.length
      ? `⚠ ${callers.length} flow(s) call this as a subflow — deleting or deactivating it can break them.`
      : (flow.Status === 'Active'
        ? '🟡 No flow calls this one. Still active though — check buttons/pages that may launch it before deleting.'
        : '🟢 No flow calls this one and it is not active — low-risk to delete.');
    const section = (title, items, fmt) => items && items.length
      ? `<div class="dep-blast-sec"><div class="dep-blast-sec-hdr">${title} (${items.length})</div>
          ${items.map(fmt || (x => `<div class="dep-blast-item">${escHtml(x)}</div>`)).join('')}</div>` : '';
    const panel = document.createElement('div');
    panel.className = 'dep-blast-panel';
    panel.innerHTML = `
      <div class="dep-blast-hdr">
        🧨 ${escHtml(flow.MasterLabel)}
        <span class="badge ${flow.Status === 'Active' ? 'badge-active' : 'badge-draft'}">${escHtml(flow.Status || '')}</span>
        <button class="btn-small dep-blast-close" title="Close">✖</button>
      </div>
      <div class="dep-blast-verdict">${verdict}</div>
      ${section('⬆ Called by', callers, c => `<div class="dep-blast-item">${escHtml(c.masterLabel)} <span class="badge ${c.status === 'Active' ? 'badge-active' : 'badge-draft'}">${escHtml(c.status || '')}</span></div>`)}
      ${refs ? `
        ${section('🗃 Objects', refs.objects, o => `<div class="dep-blast-item">${escHtml(o.name)} <span class="dep-blast-ops">${escHtml(o.ops.join(' · '))}</span></div>`)}
        ${section('🏷 Fields', refs.fields)}
        ${section('🔀 Calls subflows', refs.subflows)}
        ${section('⚙ Apex actions', refs.apex)}
        ${section('💬 Custom labels', refs.labels)}
        ${!refs.objects.length && !refs.fields.length && !refs.subflows.length && !refs.apex.length && !refs.labels.length
          ? '<div class="dep-blast-sec">No object/field/subflow/apex/label references found in this version\'s metadata.</div>' : ''}`
        : `<div class="dep-blast-sec">Reference details unavailable for this flow (its metadata didn't load${isMetadataFetched() ? '' : ' yet — scan still running'}).</div>`}`;
    document.body.appendChild(panel);
    panel.querySelector('.dep-blast-close').addEventListener('click', () => panel.remove());
  }

  return {
    reset,
    buildDependencyMap,
    getDependencyMap,
    getTriggerTypeMap,
    getTriggerObjectMap,
    isMetadataFetched,
    getParentsForApiName,
    getFlowsByApiName,
    renderDependencyTreeTab,
    getRefsFor,
    searchReferences
  };
})();
