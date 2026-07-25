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
let _svLoadedAt     = null;  // ISO timestamp of the last successful graph build (this session)
let _svGraphMetaTxt = '';    // toolbar meta line, cached so a restored graph can repaint it
let _svSavedState   = null;  // persisted setup (org / objects / toggles) — see _SV_STATE_KEY

// ── N5b: attribution, honesty notes, org-diff overlay ─────────
// _svOrgUrl is the org the graph in memory ACTUALLY came from. Every result
// surface is stamped with it, and a cached graph is DROPPED (never repainted)
// when the current selection no longer matches — an org-mislabelled graph is
// worse than no graph.
let _svOrgUrl           = '';    // org URL that produced _svNodes/_svEdges
let _svFlowsLoaded      = false; // did the loaded graph include a WORKING flow layer?
let _svFlowsQueryOk     = false; // did the FlowDefinitionView query itself succeed?
let _svFlowActionsScanned = false; // did it include the deep cross-object scan?
// Inline "could NOT be checked" notes for the CURRENT graph. Every probe that
// can fail pushes one instead of degrading to a silent clean result.
let _svNotes            = [];    // [{ what, why, hint, raw }]
// Object-list cache is module-level (was a per-render closure, so it was
// thrown away on every view switch) — keyed by org URL.
let _svObjListCache     = {};    // orgUrl → [{ name, label, custom }]
// Org-diff overlay (lazy, read-only). null until the user runs a compare.
let _svDiff             = null;  // { orgUrl, at, result, objectsCompared, ghostCap, notes }
let _svDiffNodeStatus   = null;  // Map lowercase objId → node diff entry
let _svDiffEdgeStatus   = null;  // Map edge key → edge diff entry
let _svDiffRunning      = false;

// ── Ring-aware org resolution (N5b) ───────────────────────────
// The Sync Ring's sourceUrl is the 👑 source of truth; _workingPair.src only
// MIRRORS it. The old code seeded the picker once from _workingPair.src and
// then never noticed the ring moving, so Schema View could quietly keep
// analysing yesterday's source org. Read the ring LIVE on every render.
function svRingSource() {
  if (typeof _ring === 'object' && _ring?.sourceUrl && (_ring.orgs || []).length >= 2) return _ring.sourceUrl;
  if (typeof _ring === 'object' && _ring?.sourceUrl) return _ring.sourceUrl;
  return (typeof _workingPair === 'object' && _workingPair?.src) || '';
}

function svRingTargets() {
  if (typeof _ring !== 'object' || !_ring?.sourceUrl || (_ring.orgs || []).length < 2) return [];
  return (_ring.orgs || []).filter(u => _orgKey(u) !== _orgKey(_ring.sourceUrl));
}

// Which org should the picker show? Follow-the-ring semantics, same shape as
// profileFollowsRing(): a saved org that WAS the ring source when it was saved
// was a default, not a decision — so it tracks the ring. A saved org that was
// something else is a deliberate pin and is left alone.
function svEffectiveOrg(saved) {
  const ringSrc  = svRingSource();
  const savedOrg = saved?.org || '';
  if (!savedOrg) return ringSrc;
  if (saved?.ringSrc && _orgKey(savedOrg) === _orgKey(saved.ringSrc)) return ringSrc || savedOrg;
  return savedOrg;
}

// ── Honesty notes ─────────────────────────────────────────────
// Never fail a whole load because one probe failed — but never pretend it
// succeeded either. Each note names WHAT could not be checked and WHY.
function svNote(what, why, raw) {
  const fe = (raw && typeof sftkFriendlyError === 'function') ? sftkFriendlyError(raw) : null;
  _svNotes.push({
    what,
    why:  why || fe?.message || 'no reason reported by the API',
    hint: fe?.hint || '',
    raw:  raw ? String(raw) : '',
  });
  svRenderNotes();
}

function svRenderNotes() {
  const el = eid('svNotes');
  if (!el) return;
  if (!_svNotes.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  el.innerHTML = `
    <div style="border:1px solid #F0C36D;background:#FFF8E6;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#5C4405">
      <div style="font-weight:700;margin-bottom:6px">⚠ ${_svNotes.length} thing${_svNotes.length === 1 ? '' : 's'} in this graph could NOT be checked</div>
      ${_svNotes.map(n => `<div style="margin:4px 0;line-height:1.5">
        <strong>${esc(n.what)}</strong> — ${esc(n.why)}
        ${n.hint ? `<div style="opacity:.8;margin-left:10px">💡 ${esc(n.hint)}</div>` : ''}
        ${n.raw && n.raw !== n.why ? `<div style="opacity:.6;font-family:monospace;font-size:10.5px;margin-left:10px;word-break:break-all">${esc(n.raw.slice(0, 260))}</div>` : ''}
      </div>`).join('')}
      <div style="margin-top:6px;opacity:.85">Anything listed here is <em>missing</em> from the graph above — it is not proof that nothing exists.</div>
    </div>`;
}

// ── Result attribution stamp (N5b) ────────────────────────────
// Every rendered result says which org it came from and when.
function svRenderStamp() {
  const el = eid('svStamp');
  if (!el) return;
  if (!_svNodes.length || !_svOrgUrl) { el.style.display = 'none'; el.innerHTML = ''; return; }
  const ls = (typeof _liveOrgSet === 'function') ? _liveOrgSet() : null;
  el.style.display = '';
  el.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px;background:var(--panel,#F6F7F9);border:1px solid var(--border,#D8DDE6);border-radius:8px;padding:7px 11px;margin-bottom:10px">
      <span>🏢 Graph of <strong>${esc(orgOptionLabel(_svOrgUrl, null, ls))}</strong></span>
      <span style="opacity:.7">· loaded ${esc(timeAgo(_svLoadedAt))}</span>
      ${_svDiff ? `<span style="opacity:.85">· ⇄ diffed against <strong>${esc(orgLabel(_svDiff.orgUrl))}</strong> ${esc(timeAgo(_svDiff.at))}</span>` : ''}
    </div>`;
}

// Wipe the in-memory graph (and anything derived from it). Used when the
// selected org no longer matches the graph's org — see renderSchemaView.
function svResetGraph() {
  _svNodes = []; _svEdges = []; _svFlows = [];
  _svSelected = null; _svLoadedAt = null; _svGraphMetaTxt = '';
  _svOrgUrl = ''; _svFlowsLoaded = false; _svFlowsQueryOk = false; _svFlowActionsScanned = false;
  _svNotes = [];
  svClearDiffState();
}

function svClearDiffState() {
  _svDiff = null; _svDiffNodeStatus = null; _svDiffEdgeStatus = null;
}

// ── Persist view setup (U4b) ──────────────────────────────────
// Mirrors the Readiness pattern: only the lightweight config (chosen org,
// objects text, checkbox toggles) goes to storage — never graph data.
const _SV_STATE_KEY = 'ds_schema_state';

async function svRestoreSavedState() {
  if (_svSavedState) return _svSavedState;
  try {
    const d = await chrome.storage.local.get(_SV_STATE_KEY);
    _svSavedState = d[_SV_STATE_KEY] || null;
  } catch (_) { _svSavedState = null; }
  return _svSavedState;
}

function svPersistState() {
  _svSavedState = {
    org:         eid('svOrg')?.value || '',
    // N5b: remember which org was the ring's 👑 source when this was saved, so
    // svEffectiveOrg() can tell "the default happened to be that org" apart
    // from "the user pinned that org".
    ringSrc:     svRingSource(),
    diffOrg:     eid('svDiffOrg')?.value || '',
    objects:     eid('svObjects')?.value || '',
    rels:        eid('svChkRels')?.checked ?? true,
    flows:       eid('svChkFlows')?.checked ?? true,
    flowActions: eid('svChkFlowActions')?.checked ?? true,
    std:         eid('svChkStd')?.checked ?? false,
  };
  try { chrome.storage.local.set({ [_SV_STATE_KEY]: _svSavedState }); } catch (_) {}
}

// ── Render config form ────────────────────────────────────────
async function renderSchemaView() {
  const saved = await svRestoreSavedState();
  const orgs = allMapOrgs();
  // N5b: one liveSet for the whole picker, and orgOptionLabel() so the ring's
  // source of truth carries its 👑 here exactly like every other org dropdown.
  const ls = (typeof _liveOrgSet === 'function') ? _liveOrgSet() : null;
  const ringSrc  = svRingSource();
  const wantOrg  = svEffectiveOrg(saved);
  const orgOptions = orgs.map(o =>
    `<option value="${esc(o.url)}" ${_orgKey(o.url) === _orgKey(wantOrg || '') ? 'selected' : ''}>${esc(orgOptionLabel(o.url, o.label, ls))}</option>`
  ).join('');
  // Compare-org picker for the org-diff overlay — ring targets float to the top.
  const tgtKeys = new Set(svRingTargets().map(u => _orgKey(u)));
  const diffOptions = orgs
    .filter(o => _orgKey(o.url) !== _orgKey(wantOrg || ''))
    .sort((a, b) => (tgtKeys.has(_orgKey(b.url)) ? 1 : 0) - (tgtKeys.has(_orgKey(a.url)) ? 1 : 0))
    .map(o => `<option value="${esc(o.url)}">${esc(orgOptionLabel(o.url, o.label, ls))}</option>`)
    .join('');
  // Did the ring's source move since the saved setup was captured? Say so —
  // silently re-pointing the view at a different org would be the same class
  // of bug as the stale seed it replaces.
  const ringMoved = !!(saved?.org && saved?.ringSrc && ringSrc &&
    _orgKey(saved.ringSrc) !== _orgKey(ringSrc) &&
    _orgKey(saved.org) === _orgKey(saved.ringSrc));

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
          <label class="ds-lbl">Objects <span class="ds-lbl-hint">(blank = auto-load all custom)</span>
            <button class="ds-btn ds-btn-xs" id="svPickObjs" style="margin-left:6px" title="Pick objects from the org's list instead of typing API names">▦ Pick from list</button>
          </label>
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
      ${ringMoved ? `<div style="margin-top:10px;font-size:12px;border:1px solid #C5DBF0;background:#E8F4FD;color:#014486;border-radius:8px;padding:8px 11px">
        👑 The Sync Ring's source of truth moved to <strong>${esc(orgLabel(ringSrc))}</strong>
        (was <strong>${esc(orgLabel(saved.ringSrc))}</strong>) — Schema View followed it.
        Pick a different org above to pin this view to one instead.</div>` : ''}
    </div>

    <div id="svCacheBanner" style="display:none"></div>
    <div id="svStamp" style="display:none"></div>
    <div id="svNotes" style="display:none"></div>

    <div id="svCanvas" class="sv-canvas" style="display:none">
      <div class="sv-toolbar">
        <button class="ds-btn ds-btn-sm" id="svFitBtn">⊞ Fit to screen</button>
        <button class="ds-btn ds-btn-sm" id="svResetBtn">↺ Reset pan</button>
        <span style="display:inline-flex;gap:5px;align-items:center;font-size:11.5px">
          <span title="Org-diff overlay: mark every object, relationship and flow count as present in both orgs, only here, or only there. Read-only and loaded on demand.">⇄ Diff vs</span>
          <select id="svDiffOrg" class="ds-select" style="max-width:190px;font-size:11.5px;padding:2px 6px">
            <option value="">— pick an org —</option>
            ${diffOptions}
          </select>
          <button class="ds-btn ds-btn-sm" id="svDiffBtn">Compare</button>
          <button class="ds-btn ds-btn-sm" id="svDiffClearBtn" style="display:none">✕ Clear diff</button>
        </span>
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
      <div id="svDiffLegend" style="display:none"></div>
      <div class="sv-graph-wrap">
        <svg id="svSvg" class="sv-svg"></svg>
        <div id="svDetail" class="sv-detail" style="display:none"></div>
      </div>
    </div>
  `);

  eid('svLoadBtn')?.addEventListener('click', svLoad);
  eid('svFitBtn')?.addEventListener('click', svFitGraph);
  eid('svResetBtn')?.addEventListener('click', () => { _svPan = { x: 0, y: 0 }; svRenderGraph(); });
  eid('svDiffBtn')?.addEventListener('click', svLoadDiff);
  eid('svDiffClearBtn')?.addEventListener('click', svClearDiff);

  // ── Restore persisted setup + re-save on any change (U4b) ────
  if (saved) {
    // N5b: the org is NOT restored blindly any more — svEffectiveOrg() already
    // decided (follow the ring, or honour a deliberate pin) and the <option>
    // markup carries the `selected` flag. Only fall back if that org is gone.
    const orgSel = eid('svOrg');
    if (orgSel && !orgSel.value && saved.org) {
      orgSel.value = saved.org;
      if (orgSel.value !== saved.org) orgSel.value = '';   // org no longer known
    }
    const diffSel = eid('svDiffOrg');
    if (diffSel && saved.diffOrg) {
      diffSel.value = saved.diffOrg;
      if (diffSel.value !== saved.diffOrg) diffSel.value = '';
    }
    const objInp0 = eid('svObjects');
    if (objInp0 && saved.objects) objInp0.value = saved.objects;
    const restoreChk = (id, val) => {
      const el = eid(id);
      if (el && typeof val === 'boolean') el.checked = val;
    };
    restoreChk('svChkRels',        saved.rels);
    restoreChk('svChkFlows',       saved.flows);
    restoreChk('svChkFlowActions', saved.flowActions);
    restoreChk('svChkStd',         saved.std);
  }
  ['svOrg', 'svObjects', 'svChkRels', 'svChkFlows', 'svChkFlowActions', 'svChkStd', 'svDiffOrg']
    .forEach(id => eid(id)?.addEventListener('change', svPersistState));

  // ── Object autocomplete ───────────────────────────────────────
  // When the user types in the Objects field, fetch all sObjects from the
  // selected org and filter them to show matching suggestions.
  // (svFetchObjList moved to module scope in N5b: it now REPORTS its failures
  // instead of returning an empty list that reads as "this org has no
  // objects", and its cache survives view switches.)
  let _svAcTimer  = null;
  const svObjInp  = eid('svObjects');
  const svAcList  = eid('svObjectsAC');

  function svAcClose() { if (svAcList) svAcList.style.display = 'none'; }

  // Show WHY the suggestion list is empty rather than just closing silently.
  function svAcError(msg) {
    if (!svAcList) return;
    svAcList.innerHTML = `<div style="padding:8px;font-size:12px;color:#8A6100">⚠ Object list unavailable — ${esc(msg)}</div>`;
    svAcList.style.display = '';
  }

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
        const got   = await svFetchObjList(eid('svOrg')?.value || '');
        if (got.error) { svAcError(got.error); return; }
        const hits  = got.list.filter(o =>
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

    // ▦ Object PICKLIST (user 2026-07-17: "object selecting … should be in a
    // form of picklist") — same svFetchObjList data, rendered as a checkbox
    // list that writes the comma string back into the input.
    eid('svPickObjs')?.addEventListener('click', async e => {
      e.preventDefault();
      if (!eid('svOrg')?.value) { showToast('Pick the org to analyze first', 'warning'); return; }
      svAcList.innerHTML = `<div style="padding:8px;font-size:12px">Loading object list…</div>`;
      svAcList.style.display = '';
      const got = await svFetchObjList(eid('svOrg')?.value || '');
      // Say WHY, don't guess: the old copy always blamed a closed tab even when
      // the API had returned a real error.
      if (got.error) { svAcError(got.error); return; }
      const list = got.list;
      if (!list.length) { svAcError('the org returned no queryable objects'); return; }
      const chosen = new Set((svObjInp.value || '').split(',').map(s => s.trim()).filter(Boolean));
      svAcList.innerHTML = `
        <div style="max-height:260px;overflow:auto;padding:4px 8px">
          ${list.map(o => `<label style="display:flex;gap:6px;align-items:center;font-size:12px;padding:1px 0">
            <input type="checkbox" class="sv-pick-obj" value="${esc(o.name)}" ${chosen.has(o.name) ? 'checked' : ''}>
            <span>${esc(o.label)} <span style="opacity:.65">(${esc(o.name)})</span></span></label>`).join('')}
        </div>
        <div style="display:flex;gap:6px;padding:6px 8px;border-top:1px solid rgba(128,128,128,.25)">
          <button class="ds-btn ds-btn-xs ds-btn-primary" id="svPickApply">✓ Use selected</button>
          <button class="ds-btn ds-btn-xs" id="svPickClose">Close</button>
        </div>`;
      eid('svPickClose')?.addEventListener('click', ev => { ev.preventDefault(); svAcClose(); });
      eid('svPickApply')?.addEventListener('click', ev => {
        ev.preventDefault();
        svObjInp.value = [...svAcList.querySelectorAll('.sv-pick-obj:checked')].map(c => c.value).join(', ');
        svObjInp.dispatchEvent(new Event('change'));   // persist via svPersistState
        svAcClose();
      });
    });
    // Last-resort default when nothing above selected an org: the ring's 👑
    // source of truth, re-read LIVE (N5b — the old code cached _workingPair.src
    // and never noticed the source moving).
    {
      const s = eid('svOrg');
      if (s && !s.value && ringSrc) s.value = ringSrc;
    }
  }

  // Changing the org invalidates everything downstream — the object-name
  // autocomplete AND any graph already on screen.
  eid('svOrg')?.addEventListener('change', () => {
    const cur = eid('svOrg')?.value || '';
    if (_svNodes.length && _orgKey(cur) !== _orgKey(_svOrgUrl || '')) {
      const was = _svOrgUrl;
      svResetGraph();
      const canvas = eid('svCanvas');
      if (canvas) canvas.style.display = 'none';
      svHideCacheBanner();
      svRenderStamp();
      svNote('The graph on screen was cleared',
        `it was built from ${orgLabel(was)} and you switched to ${orgLabel(cur) || 'another org'}. ` +
        'A graph is never re-shown under a different org name — click 🕸 Load Schema to rebuild it here.');
    }
  });

  // The "the ring moved" banner is a one-time heads-up: re-persist now so the
  // saved setup matches what is on screen and the notice does not repeat.
  if (ringMoved) svPersistState();

  // ── Re-show an already-loaded graph (U4b) ─────────────────────
  // If graph data is still in memory from earlier this session, render it
  // again with a "from N min ago" banner instead of resetting the user to
  // the empty config form.
  if (_svNodes.length) {
    // N5b attribution guard: the cached graph belongs to ONE org. If the
    // picker now points somewhere else (ring source moved, user pinned a
    // different org), DROP it — repainting it under the new org's name is the
    // misattribution bug this item exists to kill.
    const cur = eid('svOrg')?.value || '';
    if (!cur || _orgKey(cur) !== _orgKey(_svOrgUrl || '')) {
      const was = _svOrgUrl;
      svResetGraph();
      svNote('Cached graph discarded',
        `it was loaded from ${orgLabel(was)} but this view is now pointed at ` +
        `${cur ? orgLabel(cur) : 'no org'} — results are never re-shown under a different org. ` +
        'Click 🕸 Load Schema to build the graph for the current org.');
    } else {
      const canvas = eid('svCanvas');
      if (canvas) canvas.style.display = '';
      const metaEl = eid('svGraphMeta');
      if (metaEl) metaEl.textContent = _svGraphMetaTxt;
      svShowCacheBanner();
      svRenderStamp();
      svRenderNotes();
      svRenderDiffLegend();
      if (_svDiff) {
        eid('svDiffClearBtn')?.style.removeProperty('display');
        const ds = eid('svDiffOrg');
        if (ds) { ds.value = _svDiff.orgUrl; }
      }
      svRenderGraph();
      if (_svSelected) svShowDetail(_svSelected);
    }
  }
}

// ── Object list for an org (module-level, error-reporting) ────
// Returns { list, error } — NEVER a bare [] that a caller can mistake for
// "this org genuinely has no objects" (N5b audit: svFetchObjList swallowed
// both the no-session case and every API error).
async function svFetchObjList(orgUrl) {
  if (!orgUrl) return { list: [], error: 'no org selected' };
  if (_svObjListCache[orgUrl]) return { list: _svObjListCache[orgUrl], error: '' };
  const sess = await getOrgSession(orgUrl);
  if (!sess?.sid) {
    return { list: [], error: `${orgLabel(orgUrl)} is not open in a Chrome tab, so its object list could not be read` };
  }
  const res = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
    path: 'services/data/v62.0/sobjects' });
  if (res.error || !Array.isArray(res.sobjects)) {
    const raw = res.error || 'the API response had no sobjects array';
    const fe  = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(raw) : { message: String(raw) };
    return { list: [], error: fe.message || String(raw) };
  }
  const list = res.sobjects
    .filter(o => o.queryable && o.name)
    .map(o => ({ name: o.name, label: o.label || o.name, custom: !!o.custom }))
    .sort((a, b) => a.name.localeCompare(b.name));
  _svObjListCache[orgUrl] = list;
  return { list, error: '' };
}

// ── Cached-graph banner (U4b) ─────────────────────────────────
function svShowCacheBanner() {
  const el = eid('svCacheBanner');
  if (!el) return;
  el.style.display = '';
  el.innerHTML = `
    <div class="ds-op-banner ds-op-banner-info" style="margin-bottom:14px;align-items:center">
      <span class="ds-op-banner-icon">🕸</span>
      <div class="ds-op-banner-body">
        <div class="ds-op-banner-title">Showing graph from ${esc(timeAgo(_svLoadedAt))}</div>
        <div class="ds-op-banner-desc">Loaded earlier this session — org data may have changed since.</div>
      </div>
      <button class="ds-btn ds-btn-sm" id="svReloadBtn" style="flex-shrink:0">↻ Re-load</button>
    </div>`;
  eid('svReloadBtn')?.addEventListener('click', () => { svHideCacheBanner(); svLoad(); });
}

function svHideCacheBanner() {
  const el = eid('svCacheBanner');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
}

// ── Load schema data ──────────────────────────────────────────
async function svLoad() {
  svPersistState();  // capture the exact setup being run (U4b)
  const orgId = eid('svOrg')?.value;
  if (!orgId) { svShowError('Select an org to analyze.'); return; }

  const sess = await getOrgSession(orgId);
  if (!sess) { svShowError('Cannot connect to the org — open it in a Chrome tab first.'); return; }

  svHideError();
  svHideCacheBanner();  // a fresh load supersedes the cached-graph banner
  // A fresh load also invalidates the previous run's honesty notes and any
  // org-diff overlay computed against the OLD graph.
  _svNotes = [];
  svClearDiffState();
  svRenderNotes();
  svRenderDiffLegend();
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
        if (inp && !inp.value.trim()) { inp.value = objects.join(', '); svPersistState(); }
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
  const descFailed = [];   // [{ obj, error }] — N5b: failures are REPORTED now
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
      else descFailed.push({ obj: batch[j], error: r.error });
    }
  }
  if (sessionExpiredDuringDescribe) {
    svSetStatus('');
    showSessionBanner(sess.orgUrl, () => svLoad());
    return;
  }
  // A failed describe used to produce a node that looked perfectly healthy —
  // 0 fields, 0 child relationships, no edges. Name every one of them.
  if (descFailed.length) {
    const firstRaw = descFailed[0].error;
    svNote(
      `${descFailed.length} of ${objects.length} object${descFailed.length === 1 ? '' : 's'} could not be described`,
      `${descFailed.slice(0, 8).map(d => d.obj).join(', ')}${descFailed.length > 8 ? `, +${descFailed.length - 8} more` : ''} — ` +
      'their fields, child relationships and lookup edges are MISSING from the graph (drawn dashed and marked "not described")',
      firstRaw);
  }

  // Step 3 — Fetch flows
  let flows = [];
  _svFlowsQueryOk = false;
  if (inclFlows) {
    svSetStatus('⏳ Fetching flow automations…');
    flows = await svFetchFlows(sess);
    _svFlows = flows;
  }
  // "Loaded" means the query actually answered. A failed query leaves every
  // badge at 0, which must never be compared or reported as a real count.
  _svFlowsLoaded = !!inclFlows && _svFlowsQueryOk;

  // Step 4 — Fetch cross-object flow actions (deep scan)
  let flowActions = []; // [{ fromObj, toObj, flowName, action }]
  let deepScanRan = false;
  if (inclFlows && inclFlowActions && flows.length) {
    svSetStatus('⏳ Scanning cross-object flow actions…');
    flowActions = await svFetchFlowActions(sess, flows, objects);
    deepScanRan = true;
  } else if (inclFlows && inclFlowActions && !flows.length) {
    svNote('Cross-object flow actions were not scanned',
      'no active flows were returned for this org, so there was nothing to deep-scan. ' +
      'If the flow list itself failed (see above), cross-object flow edges are unknown, not absent.');
  }
  _svFlowActionsScanned = deepScanRan;

  // Step 5 — Build and render graph
  svSetStatus('⏳ Building graph…');
  _svOrgUrl = orgId;
  svBuildGraph(objects, descMap, flows, flowActions, inclRels, descFailed.map(d => d.obj));
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
    // N5b: an empty flow layer that means "the query failed" must never look
    // like "this org has no automation". Debug-log only was not enough.
    svNote('Flow automations could not be listed',
      'the FlowDefinitionView query failed, so every flow badge on this graph reads 0 and no flow-action edges exist — ' +
      'that is missing data, not an automation-free org',
      res.error);
    return [];
  }
  _svFlowsQueryOk = true;
  const recs = res.records || [];
  if (recs.length >= 500) {
    svNote('Flow list capped at 500 active flows',
      'the org returned the maximum this query asks for — flows beyond the first 500 are not counted on any node');
  }
  return recs;
}

// ── Deep scan: cross-object flow actions ─────────────────────
// Queries the Metadata field on FlowVersion for a sample of record-triggered flows
// and parses recordCreates / recordUpdates pointing at other objects.
async function svFetchFlowActions(sess, flows, objects) {
  const objectSet = new Set(objects.map(o => o.toLowerCase()));
  const actions = [];

  // Only look at record-triggered flows that have a trigger object in our set
  const eligible = flows.filter(f => {
    const trigObj = (f.TriggerObjectOrEvent?.QualifiedApiName || '').toLowerCase();
    return trigObj && objectSet.has(trigObj) && f.ActiveVersionId &&
      (f.ProcessType === 'AutoLaunchedFlow' || f.ProcessType === 'RecordTriggeredFlow' ||
       f.TriggerType?.includes('Record'));
  });
  const triggered = eligible.slice(0, 20); // cap at 20 flows for perf
  // Honesty over cleverness: the cap is real, so say it out loud.
  if (eligible.length > triggered.length) {
    svNote('Deep scan capped at 20 flows',
      `${eligible.length} record-triggered flows target the graphed objects but only the first ${triggered.length} were opened — ` +
      'cross-object actions inside the remaining ' + (eligible.length - triggered.length) + ' flows are NOT on this graph');
  }

  if (!triggered.length) return actions;
  const metaFailed = [];   // flows whose Tooling metadata could not be read

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
      const r    = results[idx];
      const meta = r?.Metadata;
      if (!meta) {
        // Was it an API failure or a genuinely empty flow body? Only the first
        // is a hole in the data — record it either way, we cannot tell the
        // difference from an absent Metadata key without the error string.
        metaFailed.push({ name: flow.Label || flow.ApiName, error: r?.error || 'the Tooling API returned no Metadata for this flow version' });
        return;
      }

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

  if (metaFailed.length) {
    svNote(
      `${metaFailed.length} of ${triggered.length} deep-scanned flow${metaFailed.length === 1 ? '' : 's'} could not be read`,
      `${metaFailed.slice(0, 6).map(m => m.name).join(', ')}${metaFailed.length > 6 ? `, +${metaFailed.length - 6} more` : ''} — ` +
      'any records those flows create or update on OTHER objects are missing from the flow-action edges',
      metaFailed[0].error);
  }

  return actions;
}

// ── Pure edge builders (shared by the graph and the org diff) ─
// Both sides of an org diff MUST be built by the same code or the diff is
// meaningless, so relationship + flow-action edge construction lives here as
// pure functions instead of inline in svBuildGraph.
function svRelEdges(objects, descMap) {
  const objectSet = new Set(objects || []);
  const edges = [];
  const keys  = new Set();
  for (const obj of (objects || [])) {
    const rels = ((descMap || {})[obj] || {}).childRelationships || [];
    for (const rel of rels) {
      const childObj = rel && rel.childSObject;
      if (!childObj || !objectSet.has(childObj)) continue;
      const key = `${childObj}→${obj}`;
      if (keys.has(key)) continue;
      keys.add(key);
      edges.push({
        from:     childObj,
        to:       obj,
        label:    (rel && rel.relationshipName) || '',
        edgeType: (rel && rel.cascadeDelete) ? 'master-detail' : 'lookup',
      });
    }
  }
  return edges;
}

function svFlowActionEdges(flowActions, objects) {
  const objectSet = new Set(objects || []);
  const edges = [];
  const keys  = new Set();
  for (const fa of (flowActions || [])) {
    if (!fa || !objectSet.has(fa.fromObj) || !objectSet.has(fa.toObj)) continue;
    const key = `flow:${fa.fromObj}→${fa.toObj}:${fa.flowName}`;
    if (keys.has(key)) continue;
    keys.add(key);
    edges.push({
      from:     fa.fromObj,
      to:       fa.toObj,
      label:    fa.flowName,
      edgeType: 'flow-action',
      action:   fa.action,
    });
  }
  return edges;
}

// ── Build graph data + render ─────────────────────────────────
function svBuildGraph(objects, descMap, flows, flowActions, inclRels, failedObjects) {
  const failedSet = new Set(failedObjects || []);

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
      // N5b: a node whose describe FAILED is not a healthy empty object. Carry
      // the fact onto the node so the renderer can mark it and the detail panel
      // can refuse to claim "0 fields".
      described:  !failedSet.has(obj),
      x:          30 + col * (NODE_W + H_GAP),
      y:          30 + row * (NODE_H + V_GAP),
    };
  });

  // Edges — same pure builders the org diff uses, so both sides agree.
  const edges = (inclRels ? svRelEdges(objects, descMap) : [])
    .concat(svFlowActionEdges(flowActions, objects));

  _svNodes    = nodes;
  _svEdges    = edges;
  _svPan      = { x: 0, y: 0 };
  _svSelected = null;
  _svLoadedAt = new Date().toISOString();  // for the "from N min ago" banner (U4b)
  svClearDiffState();   // a rebuilt graph invalidates any overlay on the old one

  const canvas = eid('svCanvas');
  if (canvas) canvas.style.display = '';

  const nDescribed = nodes.filter(n => n.described).length;
  _svGraphMetaTxt =
    `${nodes.length} objects · ${edges.filter(e => e.edgeType !== 'flow-action').length} relationships · ` +
    `${edges.filter(e => e.edgeType === 'flow-action').length} flow actions · ${flows.length} total flows` +
    (nDescribed < nodes.length ? ` · ⚠ ${nodes.length - nDescribed} not described` : '');
  const metaEl = eid('svGraphMeta');
  if (metaEl) metaEl.textContent = _svGraphMetaTxt;

  svRenderStamp();
  svRenderNotes();
  svRenderDiffLegend();
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
    <marker id="sva-onlyhere" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
      <polygon points="0 0,9 3.5,0 7" fill="#C2410C"/>
    </marker>
    <marker id="sva-onlythere" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
      <polygon points="0 0,9 3.5,0 7" fill="#0F766E"/>
    </marker>
    <marker id="sva-unknown" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
      <polygon points="0 0,9 3.5,0 7" fill="#94A3B8"/>
    </marker>
    <filter id="sv-shadow">
      <feDropShadow dx="0" dy="1" stdDeviation="2.5" flood-color="rgba(0,0,0,0.13)"/>
    </filter>
  </defs>`;

  // ── Org-diff overlay lookups (null unless a compare has been run) ──
  const dNode = k => (_svDiffNodeStatus ? _svDiffNodeStatus.get(String(k || '').toLowerCase()) : null);
  const dEdge = e => {
    if (!_svDiffEdgeStatus) return null;
    const lc = v => String(v == null ? '' : v).toLowerCase();
    const key = (e && e.edgeType === 'flow-action')
      ? `flow|${lc(e.from)}→${lc(e.to)}|${lc(e.label)}`
      : `rel|${lc(e.from)}→${lc(e.to)}`;
    return _svDiffEdgeStatus.get(key) || null;
  };
  const DIFF_COLOR = { 'only-a': '#C2410C', 'only-b': '#0F766E', 'unknown': '#94A3B8' };
  const DIFF_MARK  = { 'only-a': 'sva-onlyhere', 'only-b': 'sva-onlythere', 'unknown': 'sva-unknown' };

  // ── Draw edges ──
  let edgesHtml = '';
  for (const e of edges) {
    const fn = nodes.find(n => n.id === e.from);
    const tn = nodes.find(n => n.id === e.to);
    if (!fn || !tn) continue;

    const isFlow = e.edgeType === 'flow-action';
    const isMD   = e.edgeType === 'master-detail';
    const de     = dEdge(e);

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

    let color  = isFlow ? '#7C3AED' : isMD ? '#0369A1' : '#94A3B8';
    let marker = isFlow ? 'sva-flow' : isMD ? 'sva-md' : 'sva-lookup';
    let dash   = isFlow ? '6,3' : isMD ? '' : '4,3';
    let width  = isFlow ? 1.8 : isMD ? 2 : 1.5;
    let opacity = 1;
    let diffTag = '';

    // Diff repaint: "both" fades into the background so the DIFFERENCES pop.
    if (de) {
      if (de.status === 'both') {
        opacity = (de.typeDiff || de.labelDiff) ? 1 : 0.28;
        if (de.typeDiff || de.labelDiff) { color = '#B45309'; width = 2.2; dash = ''; diffTag = ' ✎ changed'; }
      } else {
        color   = DIFF_COLOR[de.status] || color;
        marker  = DIFF_MARK[de.status]  || marker;
        width   = 2.2;
        dash    = de.status === 'unknown' ? '2,4' : (de.status === 'only-b' ? '7,4' : '');
        diffTag = de.status === 'only-a' ? ' ◄ only here'
                : de.status === 'only-b' ? ' ► only there'
                : ' ? unknown';
      }
    }

    const rawLabel  = (e.label || '') + diffTag;
    const labelText = rawLabel.length > 26 ? rawLabel.substring(0, 24) + '…' : rawLabel;
    const titleTxt  = de
      ? `${e.from} → ${e.to} (${e.edgeType})\n${de.status === 'both' ? ((de.typeDiff || de.labelDiff) ? 'in both orgs, but changed' : 'in both orgs') : de.status === 'only-a' ? 'only in this org' : de.status === 'only-b' ? 'only in the compare org' : 'NOT comparable — ' + (de.reason || 'insufficient data')}`
      : `${e.from} → ${e.to} (${e.edgeType})`;

    edgesHtml += `<g class="sv-edge" opacity="${opacity}">
      <title>${esc(titleTxt)}</title>
      <path d="M${ex1},${ey1} Q${midX},${midY} ${ex2},${ey2}"
            fill="none" stroke="${color}" stroke-width="${width}"
            ${dash ? `stroke-dasharray="${dash}"` : ''}
            marker-end="url(#${marker})"/>
      ${labelText ? `<text x="${midX}" y="${midY - 4}" font-size="9" fill="${color}"
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

    let fill   = isSelected ? (isCustom ? '#DBEAFE' : '#F1F5F9')
                            : (isCustom ? '#EFF6FF' : '#FAFAFA');
    let stroke = isSelected ? '#1D4ED8' : (isCustom ? '#3B82F6' : '#CBD5E1');
    let sw     = isSelected ? 2.5 : 1.5;
    let nodeDash = '';
    const dn   = dNode(node.id);

    // Diff repaint (see the ⇄ legend under the toolbar).
    if (dn) {
      if (dn.status === 'only-a')      { stroke = '#C2410C'; fill = '#FFF1E7'; sw = 2.4; }
      else if (dn.status === 'only-b') { stroke = '#0F766E'; fill = '#ECFDF5'; sw = 2.4; nodeDash = '6,4'; }
      else if (!dn.comparable)         { stroke = '#94A3B8'; fill = '#F4F4F5'; sw = 2;   nodeDash = '2,4'; }
      else                             { stroke = '#94A3B8'; sw = 1.3; }
    }
    // A node whose describe FAILED must never look like a healthy empty object.
    if (node.described === false) { stroke = '#B45309'; nodeDash = '3,3'; sw = 2; }

    const labelTxt = node.label.length > 21 ? node.label.substring(0, 19) + '…' : node.label;
    const apiTxt   = node.id.length   > 23 ? node.id.substring(0, 21)   + '…' : node.id;

    // Incoming/outgoing edge counts
    const outRel = edges.filter(e => e.from === node.id && e.edgeType !== 'flow-action').length;
    const inRel  = edges.filter(e => e.to   === node.id && e.edgeType !== 'flow-action').length;
    const metaTxt = node.described === false
      ? '⚠ not described — data missing'
      : `${inRel} in · ${outRel} out · ${node.fields.length} fields`;

    // Flow badge (purple circle top-right). Under a diff it shows BOTH counts
    // when they disagree, and a "?" when the flow layer wasn't comparable.
    let badgeTxt = node.flowCount > 9 ? '9+' : String(node.flowCount);
    let badgeCol = '#7C3AED';
    let badgeR   = 10, badgeShow = node.flowCount > 0;
    if (dn && dn.status === 'both') {
      if (dn.flowStatus === 'differs') {
        badgeTxt = `${dn.flowsA}/${dn.flowsB}`; badgeCol = '#B45309'; badgeR = 13; badgeShow = true;
      } else if (dn.flowStatus === 'unknown') {
        badgeTxt = '?'; badgeCol = '#94A3B8'; badgeShow = true;
      }
    }
    const flowBadge = badgeShow ? `
      <circle cx="${nx + NODE_W - 5}" cy="${ny + 5}" r="${badgeR}" fill="${badgeCol}"/>
      <text x="${nx + NODE_W - 5}" y="${ny + 9}" text-anchor="middle"
            font-size="9" font-weight="700" fill="white" font-family="sans-serif">${esc(badgeTxt)}</text>` : '';

    const diffTip = dn
      ? (dn.status === 'only-a' ? '\nORG DIFF: only in this org'
        : dn.status === 'only-b' ? '\nORG DIFF: only in the compare org'
        : !dn.comparable ? '\nORG DIFF: present in both, but NOT comparable (describe failed on one side)'
        : '\nORG DIFF: in both orgs' +
          (dn.flowStatus === 'differs' ? ` · flows ${dn.flowsA} here / ${dn.flowsB} there`
           : dn.flowStatus === 'unknown' ? ' · flow counts NOT compared' : ' · same flow count'))
      : '';

    nodesHtml += `<g class="sv-node" data-id="${esc(node.id)}" style="cursor:pointer">
      <title>${esc(node.id + (node.described === false ? '\nDescribe FAILED — fields, child relationships and edges are missing' : '') + diffTip)}</title>
      <rect x="${nx}" y="${ny}" width="${NODE_W}" height="${NODE_H}" rx="8"
            fill="${fill}" stroke="${stroke}" stroke-width="${sw}"
            ${nodeDash ? `stroke-dasharray="${nodeDash}"` : ''}
            filter="url(#sv-shadow)"/>
      <text x="${nx + 10}" y="${ny + 21}" font-size="12" font-weight="600"
            fill="#1E293B" font-family="sans-serif">${esc(labelTxt)}</text>
      <text x="${nx + 10}" y="${ny + 36}" font-size="10" fill="#3B82F6"
            font-family="monospace">${esc(apiTxt)}</text>
      <text x="${nx + 10}" y="${ny + 52}" font-size="9"
            fill="${node.described === false ? '#B45309' : '#94A3B8'}"
            font-family="sans-serif">${esc(metaTxt)}</text>
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
    : (_svFlowsLoaded
        ? '<div class="sv-detail-empty">No active flows on this object</div>'
        : '<div class="sv-detail-empty">⚠ Flows were not loaded for this graph — unknown, not zero</div>');

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

  // N5b — attribution + honesty in the detail panel.
  const ls = (typeof _liveOrgSet === 'function') ? _liveOrgSet() : null;
  const notDescribed = node.described === false && !node.ghost;
  const failBanner = notDescribed ? `
    <div style="border:1px solid #F0C36D;background:#FFF8E6;color:#5C4405;border-radius:6px;padding:7px 9px;margin-bottom:8px;font-size:11.5px">
      ⚠ The describe call for this object FAILED. The counts below are what we
      could read (nothing), not what the org contains.
    </div>` : '';
  const ghostBanner = node.ghost ? `
    <div style="border:1px solid #99F6E4;background:#ECFDF5;color:#0F766E;border-radius:6px;padding:7px 9px;margin-bottom:8px;font-size:11.5px">
      ► This object exists only in <strong>${esc(orgLabel(_svDiff?.orgUrl || ''))}</strong>.
      It was not described — only its existence was checked.
    </div>` : '';
  const dn = _svDiffNodeStatus ? _svDiffNodeStatus.get(String(node.id).toLowerCase()) : null;
  const diffSection = dn ? `
    <div class="sv-detail-section">
      <div class="sv-detail-section-title">⇄ Org diff vs ${esc(orgLabel(_svDiff?.orgUrl || ''))}</div>
      <div class="sv-detail-field"><span class="sv-detail-field-name">Object</span>
        <span class="sv-detail-field-ref">${esc(dn.status === 'both' ? 'in both orgs' : dn.status === 'only-a' ? 'ONLY in this org' : 'ONLY in the compare org')}</span></div>
      <div class="sv-detail-field"><span class="sv-detail-field-name">Comparable</span>
        <span class="sv-detail-field-ref">${dn.status === 'both' ? (dn.comparable ? 'yes — described in both' : 'NO — describe failed on one side, so its relationships were not compared') : 'n/a'}</span></div>
      <div class="sv-detail-field"><span class="sv-detail-field-name">Active flows</span>
        <span class="sv-detail-field-ref">${dn.flowStatus === 'unknown' ? 'NOT compared'
          : `${dn.flowsA} here · ${dn.flowsB} there${dn.flowStatus === 'differs' ? ' ⚠ differs' : ''}`}</span></div>
    </div>` : '';

  detail.style.display = '';
  detail.innerHTML = `
    <div class="sv-detail-hdr">
      <div>
        <strong class="sv-detail-title">${esc(node.label)}</strong>
        <div class="sv-detail-api">${esc(node.id)}</div>
        <div class="sv-detail-api" style="opacity:.75">🏢 ${esc(orgOptionLabel(_svOrgUrl, null, ls))} · ${esc(timeAgo(_svLoadedAt))}</div>
      </div>
      <button class="sv-detail-close" id="svDetailClose">✕</button>
    </div>
    <div class="sv-detail-body">
      ${failBanner}${ghostBanner}
      <div class="sv-detail-meta-row">
        <span>${notDescribed || node.ghost ? '? ' : ''}${node.fields.length} fields</span>
        <span>${notDescribed || node.ghost ? '? ' : ''}${node.childRels.length} child rels</span>
        <span>${node.flowCount} flows</span>
        <span class="sv-type-badge ${node.type === 'custom' ? 'sv-type-custom' : 'sv-type-std'}">${node.type}</span>
      </div>
      ${diffSection}
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

// ════════════════════════════════════════════════════════════════
// ORG-DIFF OVERLAY (N5b capability jump)
// ════════════════════════════════════════════════════════════════
// "Is this relationship in the other org too?" Pick a second org and every
// node, edge and flow count is marked present in BOTH / only HERE / only
// THERE. Read-only, loaded on demand, and explicit about anything it could
// not compare — an unknown is never painted as a match.

// PURE — the whole comparison. Both sides are
//   { objects: [{ id, described, flowCount }], edges: [{ from, to, edgeType, label }],
//     flowsLoaded: bool, flowActionsScanned: bool }
// Anything the inputs say was not loaded comes back as status 'unknown' with a
// reason, never as a difference.
function svDiffGraphs(a, b) {
  const A = a || {}, B = b || {};
  const lc = v => String(v == null ? '' : v).toLowerCase();
  const aObjs  = Array.isArray(A.objects) ? A.objects : [];
  const bObjs  = Array.isArray(B.objects) ? B.objects : [];
  const aEdges = Array.isArray(A.edges)   ? A.edges   : [];
  const bEdges = Array.isArray(B.edges)   ? B.edges   : [];
  // Relationship edges are keyed child→parent only: the graph builder already
  // collapses multiple relationships between the same pair, so a differing
  // edgeType or relationshipName is a CHANGE, not a separate edge. Flow-action
  // edges keep the flow name in the key — a different flow is a different edge.
  const ekey = e => (e && e.edgeType === 'flow-action')
    ? `flow|${lc(e && e.from)}→${lc(e && e.to)}|${lc(e && e.label)}`
    : `rel|${lc(e && e.from)}→${lc(e && e.to)}`;

  const aMap = new Map(), bMap = new Map();
  for (const o of aObjs) if (o && o.id) aMap.set(lc(o.id), o);
  for (const o of bObjs) if (o && o.id) bMap.set(lc(o.id), o);

  const order = [], seen = new Set();
  for (const o of aObjs.concat(bObjs)) {
    const k = lc(o && o.id);
    if (k && !seen.has(k)) { seen.add(k); order.push(k); }
  }

  const uncomparable = [];
  const nodes = order.map(k => {
    const x = aMap.get(k) || null, y = bMap.get(k) || null;
    const id = (x && x.id) || (y && y.id) || k;
    const status = (x && y) ? 'both' : (x ? 'only-a' : 'only-b');
    const describedA = !!(x && x.described);
    const describedB = !!(y && y.described);
    const comparable = status === 'both' && describedA && describedB;
    if (status === 'both' && !comparable) {
      uncomparable.push(`${id} — describe failed in ${(!describedA && !describedB) ? 'BOTH orgs' : (!describedA ? 'this org' : 'the compare org')}; its fields and relationships were NOT compared`);
    }
    const flowsA = (x && typeof x.flowCount === 'number') ? x.flowCount : null;
    const flowsB = (y && typeof y.flowCount === 'number') ? y.flowCount : null;
    let flowStatus = 'unknown';
    if (status === 'both') {
      if (A.flowsLoaded && B.flowsLoaded && flowsA !== null && flowsB !== null) {
        flowStatus = (flowsA === flowsB) ? 'same' : 'differs';
      }
    }
    return { id, key: k, status, describedA, describedB, comparable, flowsA, flowsB, flowStatus };
  });
  if (!A.flowsLoaded || !B.flowsLoaded) {
    uncomparable.push('Flow counts were NOT compared — flows were ' +
      ((!A.flowsLoaded && !B.flowsLoaded) ? 'not loaded for either org'
        : (!A.flowsLoaded ? 'not loaded for this org' : 'not loaded for the compare org')));
  }
  if (!A.flowActionsScanned || !B.flowActionsScanned) {
    uncomparable.push('Cross-object flow-action edges were NOT compared — the deep scan did not run for ' +
      ((!A.flowActionsScanned && !B.flowActionsScanned) ? 'either org'
        : (!A.flowActionsScanned ? 'this org' : 'the compare org')));
  }

  const nodeByKey = new Map(nodes.map(n => [n.key, n]));
  // An edge is only "missing" from a side when BOTH its endpoints were
  // successfully described there (or genuinely absent there). Otherwise we
  // simply do not know, and say so.
  const judgeable = (edge, side) => {
    const f = nodeByKey.get(lc(edge && edge.from));
    const t = nodeByKey.get(lc(edge && edge.to));
    if (!f || !t) return false;
    if (f.status !== 'both' || t.status !== 'both') return true;
    return side === 'b' ? (f.describedB && t.describedB) : (f.describedA && t.describedA);
  };

  const aeMap = new Map(), beMap = new Map();
  for (const e of aEdges) if (e) aeMap.set(ekey(e), e);
  for (const e of bEdges) if (e) beMap.set(ekey(e), e);
  const eOrder = [], eSeen = new Set();
  for (const e of aEdges.concat(bEdges)) {
    if (!e) continue;
    const k = ekey(e);
    if (!eSeen.has(k)) { eSeen.add(k); eOrder.push(k); }
  }

  const edges = eOrder.map(k => {
    const x = aeMap.get(k) || null, y = beMap.get(k) || null;
    const src = x || y || {};
    const isFlow = src.edgeType === 'flow-action';
    let status = (x && y) ? 'both' : (x ? 'only-a' : 'only-b');
    let reason = '';
    if (isFlow && (!A.flowActionsScanned || !B.flowActionsScanned)) {
      status = 'unknown';
      reason = 'cross-object flow actions were not deep-scanned in both orgs';
    } else if (status === 'only-a' && !judgeable(x, 'b')) {
      status = 'unknown';
      reason = 'the compare org could not be described for one of the two objects';
    } else if (status === 'only-b' && !judgeable(y, 'a')) {
      status = 'unknown';
      reason = 'this org could not be described for one of the two objects';
    }
    const typeDiff  = !!(x && y && (x.edgeType || '') !== (y.edgeType || ''));
    const labelDiff = !!(x && y && String(x.label || '') !== String(y.label || ''));
    return {
      key: k, from: src.from || '', to: src.to || '',
      edgeType: src.edgeType || '', kind: isFlow ? 'flow-action' : 'relationship',
      label: src.label || '',
      typeA: x ? (x.edgeType || '') : null, typeB: y ? (y.edgeType || '') : null,
      labelA: x ? (x.label || '') : null,   labelB: y ? (y.label || '') : null,
      status, typeDiff, labelDiff, reason,
    };
  });

  const cnt = (arr, f) => arr.filter(f).length;
  const counts = {
    nodesBoth:         cnt(nodes, n => n.status === 'both'),
    nodesOnlyA:        cnt(nodes, n => n.status === 'only-a'),
    nodesOnlyB:        cnt(nodes, n => n.status === 'only-b'),
    nodesUncomparable: cnt(nodes, n => n.status === 'both' && !n.comparable),
    edgesBoth:         cnt(edges, e => e.status === 'both'),
    edgesOnlyA:        cnt(edges, e => e.status === 'only-a'),
    edgesOnlyB:        cnt(edges, e => e.status === 'only-b'),
    edgesUnknown:      cnt(edges, e => e.status === 'unknown'),
    edgesChanged:      cnt(edges, e => e.status === 'both' && (e.typeDiff || e.labelDiff)),
    flowsDiffer:       cnt(nodes, n => n.flowStatus === 'differs'),
    flowsUnknown:      cnt(nodes, n => n.status === 'both' && n.flowStatus === 'unknown'),
  };
  return { nodes, edges, counts, uncomparable };
}

// Run the compare. Lazy (nothing happens until the button is pressed) and
// read-only (describes + one SOQL for flows; no writes anywhere).
async function svLoadDiff() {
  if (_svDiffRunning) return;
  if (!_svNodes.length) { showToast('Load a schema graph first, then compare it against another org', 'warning'); return; }
  const tgtUrl = eid('svDiffOrg')?.value || '';
  if (!tgtUrl) { showToast('Pick an org to compare against', 'warning'); return; }
  if (_orgKey(tgtUrl) === _orgKey(_svOrgUrl || '')) { showToast('That is the same org the graph came from', 'warning'); return; }

  _svDiffRunning = true;
  const btn = eid('svDiffBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Comparing…'; }
  const done = () => {
    _svDiffRunning = false;
    const b = eid('svDiffBtn');
    if (b) { b.disabled = false; b.textContent = 'Compare'; }
  };

  const diffNotes = [];
  const objects   = _svNodes.filter(n => !n.ghost).map(n => n.id);
  // Only ever compare the graph that is on screen — and say so.
  diffNotes.push(`Only the ${objects.length} object${objects.length === 1 ? '' : 's'} currently in this graph were compared; anything outside the graph was not looked at.`);
  diffNotes.push('Object existence is judged from each org\'s QUERYABLE sObject list — an object that exists but is not queryable for this user would be reported as missing.');
  diffNotes.push('Fields are not compared here; this overlay covers objects, lookup/master-detail relationships and active-flow counts only.');

  const sess = await getOrgSession(tgtUrl);
  if (!sess) {
    done();
    svShowError(`Cannot compare against ${orgLabel(tgtUrl)} — it is not open in a Chrome tab. Open it and press Compare again.`);
    return;
  }
  svHideError();
  svSetStatus(`⏳ Reading ${orgLabel(tgtUrl)}…`);

  // 1) Object existence in the compare org (one cheap call, also gives ghosts).
  const tgtList = await svFetchObjList(tgtUrl);
  if (tgtList.error) {
    done(); svSetStatus('');
    svShowError(`Compare aborted — the object list of ${orgLabel(tgtUrl)} could not be read: ${tgtList.error}`);
    return;
  }
  const tgtByLower = new Map(tgtList.list.map(o => [o.name.toLowerCase(), o]));
  const srcList = await svFetchObjList(_svOrgUrl);
  if (srcList.error) {
    diffNotes.push(`Objects that exist ONLY in ${orgLabel(tgtUrl)} could not be listed — this org's object list failed to load (${srcList.error}). "Only there" objects are missing from this overlay.`);
  }
  const srcLower = new Set(srcList.list.map(o => o.name.toLowerCase()));

  // 2) Describe the shared objects in the compare org (same batching as svLoad).
  const tgtDesc = {}, tgtFailed = [];
  const shared  = objects.filter(o => tgtByLower.has(o.toLowerCase()));
  const BATCH = 6;
  for (let i = 0; i < shared.length; i += BATCH) {
    const batch = shared.slice(i, i + BATCH);
    svSetStatus(`⏳ Describing ${Math.min(i + BATCH, shared.length)} / ${shared.length} in ${orgLabel(tgtUrl)}…`);
    const results = await Promise.all(batch.map(obj =>
      sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
               path: `services/data/v62.0/sobjects/${obj}/describe` })));
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      if (isSessionResult(r)) {
        done(); svSetStatus('');
        showSessionBanner(sess.orgUrl, () => svLoadDiff());
        return;
      }
      if (!r.error) tgtDesc[batch[j]] = r;
      else tgtFailed.push({ obj: batch[j], error: r.error });
    }
  }
  if (tgtFailed.length) {
    const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(tgtFailed[0].error) : { message: String(tgtFailed[0].error) };
    diffNotes.push(`${tgtFailed.length} object${tgtFailed.length === 1 ? '' : 's'} could not be described in ${orgLabel(tgtUrl)} (${tgtFailed.slice(0, 5).map(t => t.obj).join(', ')}${tgtFailed.length > 5 ? ', …' : ''}) — first error: ${fe.message}. Those objects and their relationships are marked "not comparable", not "missing".`);
  }

  // 3) Flows in the compare org — only if this graph HAS a flow layer to compare.
  let tgtFlows = [], tgtFlowsOk = false;
  if (_svFlowsLoaded) {
    svSetStatus(`⏳ Fetching flows in ${orgLabel(tgtUrl)}…`);
    const fres = await sendBg({
      type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid,
      query: `SELECT DurableId, ApiName, Label, ProcessType, TriggerType,
                TriggerObjectOrEvent.QualifiedApiName, ActiveVersionId
              FROM FlowDefinitionView WHERE IsActive = true LIMIT 500`,
    });
    if (fres.error) {
      const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(fres.error) : { message: String(fres.error) };
      diffNotes.push(`Flow counts were NOT compared — the flow query failed in ${orgLabel(tgtUrl)}: ${fe.message}`);
    } else { tgtFlows = fres.records || []; tgtFlowsOk = true; }
  } else {
    diffNotes.push('Flow counts were NOT compared — this graph was built without the flow layer.');
  }
  // The deep cross-object scan is deliberately NOT re-run for the compare org
  // (up to 20 extra Tooling metadata GETs). Flow-action edges therefore come
  // back "unknown", which is the honest answer.
  diffNotes.push('Cross-object flow-action edges are shown as "not compared" — the deep flow scan is not re-run against the compare org (it costs up to 20 extra Tooling calls).');

  // 4) Build the compare side with the SAME pure builders as the live graph.
  const tgtObjects = shared.map(id => ({
    id,
    described: !!tgtDesc[id],
    flowCount: tgtFlowsOk
      ? tgtFlows.filter(f => (f.TriggerObjectOrEvent?.QualifiedApiName || '') === id).length
      : null,
  }));
  // Ghosts: objects the compare org has that this org does not (capped).
  const GHOST_CAP = 12;
  let ghostAll = [];
  if (!srcList.error) {
    ghostAll = tgtList.list
      .filter(o => o.custom && !srcLower.has(o.name.toLowerCase()))
      .map(o => o.name);
  }
  const ghosts = ghostAll.slice(0, GHOST_CAP);
  if (ghostAll.length > ghosts.length) {
    diffNotes.push(`${ghostAll.length} custom objects exist only in ${orgLabel(tgtUrl)}; only the first ${GHOST_CAP} are drawn.`);
  }
  for (const g of ghosts) {
    tgtObjects.push({ id: g, described: false, flowCount: tgtFlowsOk
      ? tgtFlows.filter(f => (f.TriggerObjectOrEvent?.QualifiedApiName || '') === g).length : null });
  }

  const inclRels = eid('svChkRels')?.checked ?? true;
  const bSide = {
    objects: tgtObjects,
    edges: inclRels ? svRelEdges(shared, tgtDesc) : [],
    flowsLoaded: tgtFlowsOk,
    flowActionsScanned: false,
  };
  const aSide = {
    objects: _svNodes.filter(n => !n.ghost).map(n => ({
      id: n.id, described: n.described !== false, flowCount: n.flowCount,
    })),
    edges: _svEdges.filter(e => !e._diffOnly),
    flowsLoaded: _svFlowsLoaded,
    flowActionsScanned: _svFlowActionsScanned,
  };

  const result = svDiffGraphs(aSide, bSide);

  // 5) Ghost nodes + only-there edges join the drawing (flagged so ✕ Clear diff
  //    can take them straight back out).
  svRemoveDiffOnlyItems();
  const NODE_W = 170, NODE_H = 62;
  const baseX = Math.max(0, ..._svNodes.map(n => n.x)) + NODE_W + 110;
  ghosts.forEach((g, i) => {
    _svNodes.push({
      id: g, label: g, type: g.endsWith('__c') ? 'custom' : 'standard',
      flowCount: 0, flows: [], fields: [], childRels: [],
      described: false, ghost: true, _diffOnly: true,
      x: baseX, y: 30 + i * (NODE_H + 24),
    });
  });
  const liveKeys = new Set(_svEdges.map(e =>
    (e.edgeType === 'flow-action'
      ? `flow|${String(e.from).toLowerCase()}→${String(e.to).toLowerCase()}|${String(e.label || '').toLowerCase()}`
      : `rel|${String(e.from).toLowerCase()}→${String(e.to).toLowerCase()}`)));
  const nodeIds = new Set(_svNodes.map(n => n.id));
  for (const de of result.edges) {
    if (de.status !== 'only-b' || liveKeys.has(de.key)) continue;
    if (!nodeIds.has(de.from) || !nodeIds.has(de.to)) continue;
    _svEdges.push({ from: de.from, to: de.to, label: de.label, edgeType: de.edgeType || 'lookup', _diffOnly: true });
  }

  _svDiff = { orgUrl: tgtUrl, at: new Date().toISOString(), result, objectsCompared: objects.length, notes: diffNotes };
  _svDiffNodeStatus = new Map(result.nodes.map(n => [n.key, n]));
  _svDiffEdgeStatus = new Map(result.edges.map(e => [e.key, e]));

  svSetStatus('');
  done();
  eid('svDiffClearBtn')?.style.removeProperty('display');
  svRenderStamp();
  svRenderDiffLegend();
  svRenderGraph();
  if (_svSelected) svShowDetail(_svSelected);
}

// Strip everything the overlay added to the graph arrays.
function svRemoveDiffOnlyItems() {
  _svNodes = _svNodes.filter(n => !n._diffOnly);
  _svEdges = _svEdges.filter(e => !e._diffOnly);
}

function svClearDiff() {
  svRemoveDiffOnlyItems();
  svClearDiffState();
  eid('svDiffClearBtn')?.style.setProperty('display', 'none');
  svRenderStamp();
  svRenderDiffLegend();
  svRenderGraph();
  if (_svSelected) svShowDetail(_svSelected);
}

function svRenderDiffLegend() {
  const el = eid('svDiffLegend');
  if (!el) return;
  if (!_svDiff) { el.style.display = 'none'; el.innerHTML = ''; return; }
  const c   = _svDiff.result.counts;
  const unc = _svDiff.result.uncomparable || [];
  const chip = (bg, bd, txt) =>
    `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px">
       <span style="width:13px;height:13px;border-radius:3px;background:${bg};border:2px solid ${bd};display:inline-block"></span>${esc(txt)}</span>`;
  el.style.display = '';
  el.innerHTML = `
    <div style="border:1px solid var(--border,#D8DDE6);border-radius:8px;padding:9px 12px;margin:0 0 8px;font-size:12px;background:var(--panel,#F8FAFC)">
      <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center">
        <strong>⇄ Org diff vs ${esc(orgLabel(_svDiff.orgUrl))}</strong>
        ${chip('#FFFFFF', '#94A3B8', `in both (${c.nodesBoth} objects · ${c.edgesBoth} edges)`)}
        ${chip('#FFF1E7', '#C2410C', `only here (${c.nodesOnlyA} objects · ${c.edgesOnlyA} edges)`)}
        ${chip('#ECFDF5', '#0F766E', `only there (${c.nodesOnlyB} objects · ${c.edgesOnlyB} edges)`)}
        ${chip('#FFFFFF', '#B45309', `changed (${c.edgesChanged} edges · ${c.flowsDiffer} flow counts)`)}
        ${chip('#F4F4F5', '#94A3B8', `not comparable (${c.nodesUncomparable} objects · ${c.edgesUnknown} edges)`)}
      </div>
      <div style="margin-top:6px;opacity:.85">
        Objects compared: <strong>${_svDiff.objectsCompared}</strong> ·
        flow counts differing: <strong>${c.flowsDiffer}</strong> ·
        flow counts not compared: <strong>${c.flowsUnknown}</strong>.
        Dashed grey = we could not tell; it is <em>not</em> a match.
      </div>
      ${(unc.length || (_svDiff.notes || []).length) ? `
        <details style="margin-top:6px">
          <summary style="cursor:pointer;color:#8A6100">⚠ ${unc.length + (_svDiff.notes || []).length} thing(s) this diff could NOT compare</summary>
          <ul style="margin:6px 0 0 18px;padding:0;line-height:1.55">
            ${(_svDiff.notes || []).map(n => `<li>${esc(n)}</li>`).join('')}
            ${unc.slice(0, 25).map(n => `<li>${esc(n)}</li>`).join('')}
            ${unc.length > 25 ? `<li>…and ${unc.length - 25} more</li>` : ''}
          </ul>
        </details>` : ''}
    </div>`;
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
