'use strict';
// ════════════════════════════════════════════════════════════════
// SCHEMA VIEW — Object relationships + flow automation graph
// ════════════════════════════════════════════════════════════════

// Schema view state
let _svNodes    = [];   // { id, label, type, fields, childRels, flows, x, y }
let _svEdges    = [];   // { from, to, label, edgeType }
let _svFlows    = [];   // all fetched FlowVersion records
let _svSelected = null; // currently selected node id
let _svPan      = { x: 0, y: 0 };
let _svPanning  = false;
let _svPanStart = null;
let _svDragNode = null;

// ── Render config form ────────────────────────────────────────
function renderSchemaView() {
  const orgs = allMapOrgs();
  const orgOptions = orgs.map(o =>
    `<option value="${esc(o.url)}">${esc(orgOptionLabel(o.url, o.label))}</option>`
  ).join('');

  setMain(`
    <div class="ds-view-header">
      <div class="ds-view-title-wrap">
        <h2 class="ds-view-title">🕸 Schema View</h2>
        <div class="ds-view-subtitle">Visualize object relationships and flow automations — see how changes on one object ripple across your org</div>
      </div>
    </div>

    <div class="ds-op-banner ds-op-banner-read">
      <span class="ds-op-banner-icon">📖</span>
      <div class="ds-op-banner-body">
        <div class="ds-op-banner-title">Read-only — this never modifies any data</div>
        <div class="ds-op-banner-desc">Reads object schemas and flow metadata from the Salesforce REST and Tooling APIs. Nothing is inserted, updated, or deleted.</div>
      </div>
    </div>

    <div class="sv-config">
      <div class="sv-config-row">
        <div class="ds-field-group" style="flex:1">
          <label class="ds-lbl">Org to analyze</label>
          <select id="svOrg" class="ds-select">
            <option value="">— Select org —</option>
            ${orgOptions}
          </select>
        </div>
        <div class="ds-autocomplete-wrap" style="flex:2">
          <label class="ds-lbl">Objects <span class="ds-lbl-hint">(comma-separated API names — blank = auto-load all custom)</span></label>
          <input id="svObjects" class="ds-input" placeholder="Account, Contact, MyObj__c … or leave blank for all custom" autocomplete="off">
          <div id="svObjectsAC" class="ds-autocomplete-list" style="display:none"></div>
        </div>
      </div>

      <div class="sv-config-checks">
        <label class="dr-check-label"><input type="checkbox" id="svChkRels" checked> Lookup &amp; master-detail relationships</label>
        <label class="dr-check-label"><input type="checkbox" id="svChkFlows" checked> Flow automations</label>
        <label class="dr-check-label"><input type="checkbox" id="svChkFlowActions" checked> Cross-object flow actions (deep scan)</label>
        <label class="dr-check-label"><input type="checkbox" id="svChkStd"> Include standard objects in graph</label>
      </div>

      <div style="display:flex;gap:8px;margin-top:14px;align-items:center;flex-wrap:wrap">
        <button class="ds-btn ds-btn-primary" id="svLoadBtn">🕸 Load Schema</button>
        <span id="svStatus" class="dr-status"></span>
      </div>
      <div id="svError" class="dr-error" style="display:none"></div>
    </div>

    <div id="svCanvas" class="sv-canvas" style="display:none">
      <div class="sv-toolbar">
        <button class="ds-btn ds-btn-sm" id="svFitBtn">⊞ Fit to screen</button>
        <button class="ds-btn ds-btn-sm" id="svResetBtn">↺ Reset pan</button>
        <div class="sv-legend">
          <span class="sv-leg-item"><span class="sv-leg-dot sv-leg-custom"></span>Custom obj</span>
          <span class="sv-leg-item"><span class="sv-leg-dot sv-leg-std"></span>Standard obj</span>
          <span class="sv-leg-item"><span class="sv-leg-line sv-leg-lookup"></span>Lookup</span>
          <span class="sv-leg-item"><span class="sv-leg-line sv-leg-md"></span>Master-Detail</span>
          <span class="sv-leg-item"><span class="sv-leg-line sv-leg-flow-edge"></span>Flow action</span>
          <span class="sv-leg-item"><span class="sv-leg-badge"></span>Flow count</span>
        </div>
        <span id="svGraphMeta" class="sv-graph-meta"></span>
      </div>
      <div class="sv-graph-wrap">
        <svg id="svSvg" class="sv-svg"></svg>
        <div id="svDetail" class="sv-detail" style="display:none"></div>
      </div>
    </div>
  `);

  eid('svLoadBtn')?.addEventListener('click', svLoad);
  eid('svFitBtn')?.addEventListener('click', svFitGraph);
  eid('svResetBtn')?.addEventListener('click', () => { _svPan = { x: 0, y: 0 }; svRenderGraph(); });

  // ── Object autocomplete ───────────────────────────────────────
  // When the user types in the Objects field, fetch all sObjects from the
  // selected org and filter them to show matching suggestions.
  let _svObjCache = null;  // { orgId → [{ name, label }] }
  let _svAcTimer  = null;
  const svObjInp  = eid('svObjects');
  const svAcList  = eid('svObjectsAC');

  async function svFetchObjList() {
    const orgId = eid('svOrg')?.value;
    if (!orgId) return [];
    if (_svObjCache?.[orgId]) return _svObjCache[orgId];
    const sess = await getOrgSession(orgId);
    if (!sess?.sid) return [];
    const res = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
      path: 'services/data/v62.0/sobjects' });
    if (res.error || !Array.isArray(res.sobjects)) return [];
    const list = res.sobjects
      .filter(o => o.queryable && o.name)
      .map(o => ({ name: o.name, label: o.label || o.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    _svObjCache = _svObjCache || {};
    _svObjCache[orgId] = list;
    return list;
  }

  function svAcClose() { if (svAcList) svAcList.style.display = 'none'; }

  function svAcShow(items, term) {
    if (!svAcList || !items.length) { svAcClose(); return; }
    svAcList.innerHTML = items.slice(0, 12).map((o, i) =>
      `<div class="ds-autocomplete-item" data-name="${esc(o.name)}" tabindex="-1">
        <span class="ds-autocomplete-item-api">${esc(o.name)}</span>
        <span class="ds-autocomplete-item-label">${esc(o.label)}</span>
      </div>`
    ).join('');
    svAcList.style.display = '';
    svAcList.querySelectorAll('.ds-autocomplete-item').forEach(item => {
      item.addEventListener('mousedown', e => {
        e.preventDefault();  // don't blur input
        const chosen = item.dataset.name;
        // Replace the last token in the comma-separated list
        const parts = (svObjInp.value || '').split(',').map(p => p.trim());
        parts[parts.length - 1] = chosen;
        svObjInp.value = parts.join(', ') + ', ';
        svAcClose();
        svObjInp.focus();
      });
    });
  }

  if (svObjInp) {
    svObjInp.addEventListener('input', () => {
      clearTimeout(_svAcTimer);
      _svAcTimer = setTimeout(async () => {
        const raw   = svObjInp.value || '';
        // Autocomplete the last token after the final comma
        const term  = raw.split(',').pop().trim().toLowerCase();
        if (!term) { svAcClose(); return; }
        const list  = await svFetchObjList();
        const hits  = list.filter(o =>
          o.name.toLowerCase().startsWith(term) ||
          o.label.toLowerCase().startsWith(term)
        );
        svAcShow(hits, term);
      }, 280);
    });

    // Close when input loses focus (allow mousedown handler to fire first)
    svObjInp.addEventListener('blur', () => setTimeout(svAcClose, 150));

    // Also clear suggestions on Enter / Escape
    svObjInp.addEventListener('keydown', e => {
      if (e.key === 'Escape' || e.key === 'Enter') svAcClose();
    });

    // Refresh suggestions if org changes
    eid('svOrg')?.addEventListener('change', () => { svAcClose(); _svAcTimer = null; });
    // Default the org to the working pair's SOURCE (option values are URLs).
    {
      const s = eid('svOrg');
      if (s && !s.value && _workingPair.src) s.value = _workingPair.src;
    }
  }
}

// ── Load schema data ──────────────────────────────────────────
async function svLoad() {
  const orgId = eid('svOrg')?.value;
  if (!orgId) { svShowError('Select an org to analyze.'); return; }

  const sess = await getOrgSession(orgId);
  if (!sess) { svShowError('Cannot connect to the org — open it in a Chrome tab first.'); return; }

  svHideError();
  svSetStatus('⏳ Connecting…');

  // Quick connectivity check — catch stale SID before batching 60 describe calls
  // Use /limits which is always available and tiny
  const pingRes = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
    path: 'services/data/v62.0/limits' });
  if (isSessionResult(pingRes)) {
    svSetStatus('');
    showSessionBanner(sess.orgUrl, () => svLoad());
    return;
  }

  const inclRels        = eid('svChkRels')?.checked ?? true;
  const inclFlows       = eid('svChkFlows')?.checked ?? true;
  const inclFlowActions = eid('svChkFlowActions')?.checked ?? true;
  const inclStd         = eid('svChkStd')?.checked ?? false;

  // Step 1 — Get object list
  let objectsRaw = (eid('svObjects')?.value || '').trim();
  let objects = [];

  // Standard objects to show when org has no custom objects (Dev Edition etc.)
  const STD_FALLBACK = [
    'Account','Contact','Opportunity','Lead','Case','User',
    'Task','Event','Product2','Campaign','CampaignMember',
    'Contract','Order','Quote','Asset','Pricebook2'
  ];

  if (!objectsRaw) {
    svSetStatus('⏳ Loading object list…');
    const listRes = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
      path: 'services/data/v62.0/sobjects' });
    if (listRes.error || isSessionResult(listRes)) {
      if (isSessionResult(listRes)) {
        svSetStatus('');
        showSessionBanner(sess.orgUrl, () => svLoad());
        return;
      }
      svShowError('Failed to load object list: ' + listRes.error);
      return;
    }

    const allSobjects = listRes.sobjects || [];

    if (inclStd) {
      // User explicitly wants standard — show queryable + layoutable, cap 60
      objects = allSobjects
        .filter(o => o.queryable && o.layoutable && !o.deprecatedAndHidden)
        .map(o => o.name).sort();
      if (objects.length > 60) objects = objects.slice(0, 60);
    } else {
      // Default: custom objects only
      objects = allSobjects
        .filter(o => o.custom && !o.deprecatedAndHidden && o.queryable)
        .map(o => o.name).sort();
      if (objects.length > 60) objects = objects.slice(0, 60);

      // Fallback: no custom objects (fresh / Dev Edition org) → use standard set
      if (!objects.length) {
        const available = new Set(allSobjects.map(o => o.name));
        objects = STD_FALLBACK.filter(n => available.has(n));
        svSetStatus('ℹ️ No custom objects found — showing core standard objects');
        // pre-fill the input so the user sees what was chosen
        const inp = eid('svObjects');
        if (inp && !inp.value.trim()) inp.value = objects.join(', ');
      }
    }
  } else {
    objects = objectsRaw.split(',').map(s => s.trim()).filter(Boolean);
  }

  if (!objects.length) {
    svShowError('No objects to analyze. Enter object API names in the field above, or check "Include standard objects".');
    return;
  }
  svSetStatus(`⏳ Describing ${objects.length} objects…`);

  // Step 2 — Describe each object (batched parallel)
  const descMap = {};
  const BATCH = 6;
  let sessionExpiredDuringDescribe = false;
  for (let i = 0; i < objects.length; i += BATCH) {
    if (sessionExpiredDuringDescribe) break;
    const batch = objects.slice(i, i + BATCH);
    svSetStatus(`⏳ Describing ${i + 1}–${Math.min(i + BATCH, objects.length)} / ${objects.length}…`);
    const results = await Promise.all(batch.map(obj =>
      sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
               path: `services/data/v62.0/sobjects/${obj}/describe` })
    ));
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      if (isSessionResult(r)) {
        sessionExpiredDuringDescribe = true;
        break;
      }
      if (!r.error) descMap[batch[j]] = r;
    }
  }
  if (sessionExpiredDuringDescribe) {
    svSetStatus('');
    showSessionBanner(sess.orgUrl, () => svLoad());
    return;
  }

  // Step 3 — Fetch flows
  let flows = [];
  if (inclFlows) {
    svSetStatus('⏳ Fetching flow automations…');
    flows = await svFetchFlows(sess);
    _svFlows = flows;
  }

  // Step 4 — Fetch cross-object flow actions (deep scan)
  let flowActions = []; // [{ fromObj, toObj, flowName, action }]
  if (inclFlows && inclFlowActions && flows.length) {
    svSetStatus('⏳ Scanning cross-object flow actions…');
    flowActions = await svFetchFlowActions(sess, flows, objects);
  }

  // Step 5 — Build and render graph
  svSetStatus('⏳ Building graph…');
  svBuildGraph(objects, descMap, flows, flowActions, inclRels);
  svSetStatus('');
}

// ── Fetch active flows ────────────────────────────────────────
// FlowDefinitionView on the STANDARD REST API (tooling:false) — this is
// the object that actually carries ApiName/Label/ProcessType/TriggerType/
// TriggerObjectOrEvent. The previous query hit a Tooling "FlowVersion"
// object that doesn't exist (and a FlowDefinition fallback selecting
// fields FlowDefinition doesn't have), so BOTH legs errored and the
// Schema View flow layer was silently empty since the day it shipped.
// ActiveVersionId is selected for the deep scan's Tooling metadata fetch.
async function svFetchFlows(sess) {
  const res = await sendBg({
    type: 'SF_QUERY', tooling: false,
    orgUrl: sess.orgUrl, sid: sess.sid,
    query: `SELECT DurableId, ApiName, Label, ProcessType, TriggerType,
              TriggerObjectOrEvent.QualifiedApiName, ActiveVersionId, LastModifiedDate
            FROM FlowDefinitionView
            WHERE IsActive = true
            LIMIT 500`
  });
  if (res.error) {
    if (window.SFToolkitDebug?.enabled) {
      window.SFToolkitDebug.log('schema', 'error', 'FlowDefinitionView query failed', res.error);
    }
    return [];
  }
  return res.records || [];
}

// ── Deep scan: cross-object flow actions ─────────────────────
// Queries the Metadata field on FlowVersion for a sample of record-triggered flows
// and parses recordCreates / recordUpdates pointing at other objects.
async function svFetchFlowActions(sess, flows, objects) {
  const objectSet = new Set(objects.map(o => o.toLowerCase()));
  const actions = [];

  // Only look at record-triggered flows that have a trigger object in our set
  const triggered = flows.filter(f => {
    const trigObj = (f.TriggerObjectOrEvent?.QualifiedApiName || '').toLowerCase();
    return trigObj && objectSet.has(trigObj) && f.ActiveVersionId &&
      (f.ProcessType === 'AutoLaunchedFlow' || f.ProcessType === 'RecordTriggeredFlow' ||
       f.TriggerType?.includes('Record'));
  }).slice(0, 20); // cap at 20 flows for perf

  if (!triggered.length) return actions;

  // Fetch the ACTIVE VERSION's metadata via the Tooling Flow object —
  // FlowDefinitionView.ActiveVersionId is a Flow (version) record Id.
  const BATCH = 3;
  for (let i = 0; i < triggered.length; i += BATCH) {
    const batch = triggered.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(f =>
      sendBg({
        type: 'SF_TOOLING_GET', orgUrl: sess.orgUrl, sid: sess.sid,
        sobject: 'Flow', id: f.ActiveVersionId
      })
    ));

    batch.forEach((flow, idx) => {
      const meta = results[idx]?.Metadata;
      if (!meta) return;

      const fromObj = flow.TriggerObjectOrEvent?.QualifiedApiName;
      if (!fromObj) return;

      // Parse recordCreates
      const creates = Array.isArray(meta.recordCreates) ? meta.recordCreates
        : meta.recordCreates ? [meta.recordCreates] : [];
      for (const rc of creates) {
        const toObj = rc.object;
        if (toObj && toObj !== fromObj && objectSet.has(toObj.toLowerCase())) {
          actions.push({ fromObj, toObj, flowName: flow.Label || flow.ApiName, action: 'creates' });
        }
      }

      // Parse recordUpdates
      const updates = Array.isArray(meta.recordUpdates) ? meta.recordUpdates
        : meta.recordUpdates ? [meta.recordUpdates] : [];
      for (const ru of updates) {
        const toObj = ru.object;
        if (toObj && toObj !== fromObj && objectSet.has(toObj.toLowerCase())) {
          actions.push({ fromObj, toObj, flowName: flow.Label || flow.ApiName, action: 'updates' });
        }
      }

      // Parse subflows (flow calls another flow — show as connection)
      const subflows = Array.isArray(meta.subflows) ? meta.subflows
        : meta.subflows ? [meta.subflows] : [];
      for (const sf of subflows) {
        if (sf.flowName) {
          // find target flow's trigger object
          const target = triggered.find(f2 => f2.ApiName === sf.flowName);
          const toObj = target?.TriggerObjectOrEvent?.QualifiedApiName;
          if (toObj && toObj !== fromObj && objectSet.has(toObj.toLowerCase())) {
            actions.push({ fromObj, toObj, flowName: flow.Label || flow.ApiName, action: 'calls subflow' });
          }
        }
      }
    });
  }

  return actions;
}

// ── Build graph data + render ─────────────────────────────────
function svBuildGraph(objects, descMap, flows, flowActions, inclRels) {
  const objectSet = new Set(objects);

  // Lay out nodes in a grid
  const COLS   = Math.ceil(Math.sqrt(objects.length * 1.4));
  const NODE_W = 170, NODE_H = 62, H_GAP = 90, V_GAP = 70;

  const nodes = objects.map((obj, i) => {
    const col  = i % COLS;
    const row  = Math.floor(i / COLS);
    const desc = descMap[obj] || {};

    // Flows where trigger object = this object
    const objFlows = flows.filter(f => {
      const trig = f.TriggerObjectOrEvent?.QualifiedApiName || '';
      return trig === obj;
    });

    return {
      id:         obj,
      label:      desc.label || obj,
      type:       obj.endsWith('__c') ? 'custom' : 'standard',
      flowCount:  objFlows.length,
      flows:      objFlows,
      fields:     desc.fields || [],
      childRels:  desc.childRelationships || [],
      x:          30 + col * (NODE_W + H_GAP),
      y:          30 + row * (NODE_H + V_GAP),
    };
  });

  const nodeMap = {};
  nodes.forEach(n => { nodeMap[n.id] = n; });

  // Edges — from childRelationships (object A is parent of object B)
  const edges = [];
  const edgeKeys = new Set();

  if (inclRels) {
    for (const node of nodes) {
      for (const rel of node.childRels) {
        const childObj = rel.childSObject;
        if (!objectSet.has(childObj)) continue;
        const key = `${childObj}→${node.id}`;
        if (edgeKeys.has(key)) continue;
        edgeKeys.add(key);
        edges.push({
          from:     childObj,
          to:       node.id,
          label:    rel.relationshipName || '',
          edgeType: rel.cascadeDelete ? 'master-detail' : 'lookup',
        });
      }
    }
  }

  // Edges — from cross-object flow actions
  for (const fa of flowActions) {
    if (!objectSet.has(fa.fromObj) || !objectSet.has(fa.toObj)) continue;
    const key = `flow:${fa.fromObj}→${fa.toObj}:${fa.flowName}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({
      from:     fa.fromObj,
      to:       fa.toObj,
      label:    fa.flowName,
      edgeType: 'flow-action',
      action:   fa.action,
    });
  }

  _svNodes    = nodes;
  _svEdges    = edges;
  _svPan      = { x: 0, y: 0 };
  _svSelected = null;

  const canvas = eid('svCanvas');
  if (canvas) canvas.style.display = '';

  const metaEl = eid('svGraphMeta');
  if (metaEl) metaEl.textContent =
    `${nodes.length} objects · ${edges.filter(e => e.edgeType !== 'flow-action').length} relationships · ` +
    `${edges.filter(e => e.edgeType === 'flow-action').length} flow actions · ${flows.length} total flows`;

  svRenderGraph();
}

// ── Render the SVG graph ──────────────────────────────────────
function svRenderGraph() {
  const oldSvg = eid('svSvg');
  if (!oldSvg) return;

  // Replace the SVG element with a fresh clone to clear ALL accumulated
  // event listeners (mousedown, mousemove, etc.) from previous renders.
  // Without this, each render stacks new listeners on the same element →
  // exponential handler pile-up → browser freeze on any interaction.
  const svg = oldSvg.cloneNode(false);
  oldSvg.parentNode?.replaceChild(svg, oldSvg);

  const nodes = _svNodes;
  const edges = _svEdges;
  const NODE_W = 170, NODE_H = 62;

  // Size SVG to fill wrapper
  const wrap = svg.parentElement;
  const W = wrap ? (wrap.clientWidth  || 900) : 900;
  const H = wrap ? (wrap.clientHeight || 540) : 540;
  svg.setAttribute('width',  W);
  svg.setAttribute('height', H);

  const tx = _svPan.x;
  const ty = _svPan.y;

  const defs = `<defs>
    <marker id="sva-lookup" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
      <polygon points="0 0,9 3.5,0 7" fill="#94A3B8"/>
    </marker>
    <marker id="sva-md" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
      <polygon points="0 0,9 3.5,0 7" fill="#0369A1"/>
    </marker>
    <marker id="sva-flow" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
      <polygon points="0 0,9 3.5,0 7" fill="#7C3AED"/>
    </marker>
    <filter id="sv-shadow">
      <feDropShadow dx="0" dy="1" stdDeviation="2.5" flood-color="rgba(0,0,0,0.13)"/>
    </filter>
  </defs>`;

  // ── Draw edges ──
  let edgesHtml = '';
  for (const e of edges) {
    const fn = nodes.find(n => n.id === e.from);
    const tn = nodes.find(n => n.id === e.to);
    if (!fn || !tn) continue;

    const isFlow = e.edgeType === 'flow-action';
    const isMD   = e.edgeType === 'master-detail';

    const cx1 = fn.x + NODE_W / 2 + tx;
    const cy1 = fn.y + NODE_H / 2 + ty;
    const cx2 = tn.x + NODE_W / 2 + tx;
    const cy2 = tn.y + NODE_H / 2 + ty;

    const dx = cx2 - cx1, dy = cy2 - cy1;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;

    // Clip to node rectangle edge
    const hx = NODE_W / 2, hy = NODE_H / 2;
    const tEdge = Math.min(hx / Math.abs(dx || 1), hy / Math.abs(dy || 1));
    const ex1 = cx1 + dx * tEdge;
    const ey1 = cy1 + dy * tEdge;
    const ex2 = cx2 - dx * (tEdge + 10 / len);
    const ey2 = cy2 - dy * (tEdge + 10 / len);

    // Slight curve for parallel edges
    const midX = (ex1 + ex2) / 2 + (isFlow ? -dy * 0.15 : dy * 0.08);
    const midY = (ey1 + ey2) / 2 + (isFlow ?  dx * 0.15 : -dx * 0.08);

    const color  = isFlow ? '#7C3AED' : isMD ? '#0369A1' : '#94A3B8';
    const marker = isFlow ? 'sva-flow' : isMD ? 'sva-md' : 'sva-lookup';
    const dash   = isFlow ? '6,3' : isMD ? '' : '4,3';
    const width  = isFlow ? 1.8 : isMD ? 2 : 1.5;

    const labelText = e.label.length > 22 ? e.label.substring(0, 20) + '…' : e.label;

    edgesHtml += `<g class="sv-edge">
      <path d="M${ex1},${ey1} Q${midX},${midY} ${ex2},${ey2}"
            fill="none" stroke="${color}" stroke-width="${width}"
            ${dash ? `stroke-dasharray="${dash}"` : ''}
            marker-end="url(#${marker})"/>
      ${labelText ? `<text font-size="9" fill="${color}" font-family="sans-serif" opacity="0.85">
        <textPath href="#svEdgePath_tmp" startOffset="50%" text-anchor="middle"></textPath>
      </text>` : ''}
      ${e.label ? `<text x="${midX}" y="${midY - 4}" font-size="9" fill="${color}"
            font-family="sans-serif" text-anchor="middle" opacity="0.85">${esc(labelText)}</text>` : ''}
    </g>`;
  }

  // ── Draw nodes ──
  let nodesHtml = '';
  for (const node of nodes) {
    const nx = node.x + tx;
    const ny = node.y + ty;
    const isSelected = _svSelected === node.id;
    const isCustom   = node.type === 'custom';

    const fill   = isSelected ? (isCustom ? '#DBEAFE' : '#F1F5F9')
                               : (isCustom ? '#EFF6FF' : '#FAFAFA');
    const stroke = isSelected ? '#1D4ED8' : (isCustom ? '#3B82F6' : '#CBD5E1');
    const sw     = isSelected ? 2.5 : 1.5;

    const labelTxt = node.label.length > 21 ? node.label.substring(0, 19) + '…' : node.label;
    const apiTxt   = node.id.length   > 23 ? node.id.substring(0, 21)   + '…' : node.id;

    // Incoming/outgoing edge counts
    const outRel = edges.filter(e => e.from === node.id && e.edgeType !== 'flow-action').length;
    const inRel  = edges.filter(e => e.to   === node.id && e.edgeType !== 'flow-action').length;
    const metaTxt = `${inRel} in · ${outRel} out`;

    // Flow badge (purple circle top-right)
    const flowBadge = node.flowCount > 0 ? `
      <circle cx="${nx + NODE_W - 5}" cy="${ny + 5}" r="10" fill="#7C3AED"/>
      <text x="${nx + NODE_W - 5}" y="${ny + 9}" text-anchor="middle"
            font-size="9" font-weight="700" fill="white" font-family="sans-serif">${node.flowCount > 9 ? '9+' : node.flowCount}</text>` : '';

    nodesHtml += `<g class="sv-node" data-id="${esc(node.id)}" style="cursor:pointer">
      <rect x="${nx}" y="${ny}" width="${NODE_W}" height="${NODE_H}" rx="8"
            fill="${fill}" stroke="${stroke}" stroke-width="${sw}"
            filter="url(#sv-shadow)"/>
      <text x="${nx + 10}" y="${ny + 21}" font-size="12" font-weight="600"
            fill="#1E293B" font-family="sans-serif">${esc(labelTxt)}</text>
      <text x="${nx + 10}" y="${ny + 36}" font-size="10" fill="#3B82F6"
            font-family="monospace">${esc(apiTxt)}</text>
      <text x="${nx + 10}" y="${ny + 52}" font-size="9" fill="#94A3B8"
            font-family="sans-serif">${esc(metaTxt)} · ${node.fields.length} fields</text>
      ${flowBadge}
    </g>`;
  }

  svg.innerHTML = `${defs}
    <g id="svEdgeGroup">${edgesHtml}</g>
    <g id="svNodeGroup">${nodesHtml}</g>`;

  // Empty state
  if (!nodes.length) {
    svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" font-size="14"
      fill="#94A3B8" font-family="sans-serif">No objects to display</text>`;
  }

  // ── Wire SVG interactions ──
  svg.querySelectorAll('.sv-node').forEach(el => {
    // Click to select / deselect
    el.addEventListener('click', ev => {
      ev.stopPropagation();
      const id = el.dataset.id;
      _svSelected = (_svSelected === id) ? null : id;
      svRenderGraph();
      if (_svSelected) svShowDetail(_svSelected);
      else { const d = eid('svDetail'); if (d) d.style.display = 'none'; }
    });

    // Drag node
    el.addEventListener('mousedown', ev => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      ev.preventDefault();
      const nodeId = el.dataset.id;
      const node = _svNodes.find(n => n.id === nodeId);
      if (!node) return;
      _svDragNode = { node, sx: ev.clientX, sy: ev.clientY, ox: node.x, oy: node.y };

      const onMove = mv => {
        if (!_svDragNode) return;
        _svDragNode.node.x = _svDragNode.ox + mv.clientX - _svDragNode.sx;
        _svDragNode.node.y = _svDragNode.oy + mv.clientY - _svDragNode.sy;
        svRenderGraph();
      };
      const onUp = () => {
        _svDragNode = null;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });

  // Background click = deselect
  svg.addEventListener('click', ev => {
    if (!ev.target.closest('.sv-node')) {
      _svSelected = null;
      const d = eid('svDetail');
      if (d) d.style.display = 'none';
      svRenderGraph();
    }
  });

  // Pan on background drag
  svg.addEventListener('mousedown', ev => {
    if (ev.target.closest('.sv-node')) return;
    if (ev.button !== 0) return;
    _svPanning  = true;
    _svPanStart = { mx: ev.clientX, my: ev.clientY, tx: _svPan.x, ty: _svPan.y };
    ev.preventDefault();
  });
  svg.addEventListener('mousemove', ev => {
    if (!_svPanning || !_svPanStart) return;
    _svPan.x = _svPanStart.tx + ev.clientX - _svPanStart.mx;
    _svPan.y = _svPanStart.ty + ev.clientY - _svPanStart.my;
    svRenderGraph();
  });
  svg.addEventListener('mouseup',    () => { _svPanning = false; _svPanStart = null; });
  svg.addEventListener('mouseleave', () => { _svPanning = false; _svPanStart = null; });

  // Scroll-to-zoom
  svg.addEventListener('wheel', ev => {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.1 : 0.91;
    for (const n of _svNodes) {
      n.x = (n.x - _svPan.x) * factor + _svPan.x;
      n.y = (n.y - _svPan.y) * factor + _svPan.y;
    }
    for (const n of _svNodes) {
      // also scale positions relative to canvas center
    }
    svRenderGraph();
  }, { passive: false });
}

// ── Detail panel ──────────────────────────────────────────────
function svShowDetail(nodeId) {
  const node = _svNodes.find(n => n.id === nodeId);
  if (!node) return;
  const detail = eid('svDetail');
  if (!detail) return;

  // Flows section
  const flowRows = node.flows.length
    ? node.flows.map(f => {
        const procType = f.ProcessType || '';
        const trigType = f.TriggerType || '';
        const icon = trigType.includes('Before') ? '⚡ Before-save'
          : trigType.includes('After')            ? '🔄 After-save'
          : procType === 'Schedule'               ? '📅 Scheduled'
          : procType === 'AutoLaunchedFlow'       ? '▶ Auto-launched'
          : '▶ Flow';
        return `<div class="sv-detail-flow">
          <div class="sv-detail-flow-type">${esc(icon)}</div>
          <div class="sv-detail-flow-info">
            <div class="sv-detail-flow-name">${esc(f.Label || f.ApiName)}</div>
            <div class="sv-detail-flow-meta">${esc(f.ApiName)}</div>
          </div>
        </div>`;
      }).join('')
    : '<div class="sv-detail-empty">No active flows on this object</div>';

  // Cross-object flow action edges involving this node
  const outActions = _svEdges.filter(e => e.from === nodeId && e.edgeType === 'flow-action');
  const inActions  = _svEdges.filter(e => e.to   === nodeId && e.edgeType === 'flow-action');

  const actionSection = (outActions.length || inActions.length) ? `
    <div class="sv-detail-section">
      <div class="sv-detail-section-title">🕸 Cross-Object Flow Actions</div>
      ${outActions.map(e => `<div class="sv-detail-action sv-detail-action-out">
        <span class="sv-action-dir">→ ${esc(e.to)}</span>
        <span class="sv-action-name">${esc(e.label)} <em>(${esc(e.action || '')})</em></span>
      </div>`).join('')}
      ${inActions.map(e => `<div class="sv-detail-action sv-detail-action-in">
        <span class="sv-action-dir">← ${esc(e.from)}</span>
        <span class="sv-action-name">${esc(e.label)} <em>(${esc(e.action || '')})</em></span>
      </div>`).join('')}
    </div>` : '';

  // Reference fields (lookup/MD fields)
  const lookupFields = (node.fields || [])
    .filter(f => f.type === 'reference' && (f.referenceTo || []).length > 0)
    .slice(0, 20);
  const lookupSection = lookupFields.length ? `
    <div class="sv-detail-section">
      <div class="sv-detail-section-title">🔗 Reference Fields (${lookupFields.length})</div>
      ${lookupFields.map(f => `<div class="sv-detail-field">
        <span class="sv-detail-field-name">${esc(f.name)}</span>
        <span class="sv-detail-field-ref">→ ${esc((f.referenceTo || []).slice(0,3).join(', '))}${(f.referenceTo||[]).length > 3 ? '…' : ''}</span>
      </div>`).join('')}
    </div>` : '';

  // Child relationships
  const childRels = (node.childRels || []).slice(0, 20);
  const childSection = childRels.length ? `
    <div class="sv-detail-section">
      <div class="sv-detail-section-title">👇 Child Relationships (${childRels.length})</div>
      ${childRels.map(r => `<div class="sv-detail-field">
        <span class="sv-detail-field-name">${esc(r.relationshipName || r.childSObject)}</span>
        <span class="sv-detail-field-ref">${esc(r.childSObject)}</span>
      </div>`).join('')}
    </div>` : '';

  detail.style.display = '';
  detail.innerHTML = `
    <div class="sv-detail-hdr">
      <div>
        <strong class="sv-detail-title">${esc(node.label)}</strong>
        <div class="sv-detail-api">${esc(node.id)}</div>
      </div>
      <button class="sv-detail-close" id="svDetailClose">✕</button>
    </div>
    <div class="sv-detail-body">
      <div class="sv-detail-meta-row">
        <span>${node.fields.length} fields</span>
        <span>${node.childRels.length} child rels</span>
        <span>${node.flowCount} flows</span>
        <span class="sv-type-badge ${node.type === 'custom' ? 'sv-type-custom' : 'sv-type-std'}">${node.type}</span>
      </div>
      <div class="sv-detail-section">
        <div class="sv-detail-section-title">🔄 Active Flows (${node.flows.length})</div>
        ${flowRows}
      </div>
      ${actionSection}
      ${lookupSection}
      ${childSection}
    </div>`;

  eid('svDetailClose')?.addEventListener('click', () => {
    _svSelected = null;
    detail.style.display = 'none';
    svRenderGraph();
  });
}

// ── Fit graph to canvas ───────────────────────────────────────
function svFitGraph() {
  if (!_svNodes.length) return;
  const svg  = eid('svSvg');
  if (!svg) return;
  const W = parseInt(svg.getAttribute('width'))  || 900;
  const H = parseInt(svg.getAttribute('height')) || 540;
  const NODE_W = 170, NODE_H = 62;

  const minX = Math.min(..._svNodes.map(n => n.x));
  const minY = Math.min(..._svNodes.map(n => n.y));
  const maxX = Math.max(..._svNodes.map(n => n.x + NODE_W));
  const maxY = Math.max(..._svNodes.map(n => n.y + NODE_H));

  const scale = Math.min((W - 60) / (maxX - minX || 1), (H - 60) / (maxY - minY || 1), 1.5);

  for (const n of _svNodes) {
    n.x = (n.x - minX) * scale + 30;
    n.y = (n.y - minY) * scale + 30;
  }
  _svPan = { x: 0, y: 0 };
  svRenderGraph();
}

// ── Status / error helpers ────────────────────────────────────
function svSetStatus(msg) {
  const el = eid('svStatus');
  if (el) el.textContent = msg;
}

function svShowError(msg) {
  const el = eid('svError');
  if (el) { el.textContent = '❌ ' + msg; el.style.display = ''; }
  svSetStatus('');
}

function svHideError() {
  const el = eid('svError');
  if (el) el.style.display = 'none';
}
