// Dependency Map module — builds and renders the subflow dependency map

const DependencyMap = (() => {
  let dependencyMap = {}; // subflowApiName -> [{ id, masterLabel, versionNumber, status, processType }]
  let flowsByApiName = {}; // apiName -> [flow records]
  let triggerTypeMap = {};   // flowId -> triggerType string from Metadata.start.triggerType
  let triggerObjectMap = {}; // flowId -> SObject API name from Metadata.start.object
  let metadataFetched = false;
  let fetchInProgress = false;
  let _runToken = 0;   // bumped on every reset() — invalidates in-flight scans

  function reset() {
    _runToken++;       // any in-flight buildDependencyMap is now superseded
    dependencyMap = {};
    flowsByApiName = {};
    triggerTypeMap = {};
    triggerObjectMap = {};
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
    contextMenu.innerHTML = `<div class="dep-context-item" id="depCtxSelect">Select this flow for deletion</div>`;
    document.body.appendChild(contextMenu);

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

  return {
    reset,
    buildDependencyMap,
    getDependencyMap,
    getTriggerTypeMap,
    getTriggerObjectMap,
    isMetadataFetched,
    getParentsForApiName,
    getFlowsByApiName,
    renderDependencyTreeTab
  };
})();
