'use strict';
// ════════════════════════════════════════════════════════════════
// DEPLOY READINESS — pre-transfer target-org checks
// ════════════════════════════════════════════════════════════════
async function renderReadiness() {
  // U4a: restore the persisted lightweight setup (orgs, object selection,
  // check toggles) once per session. Results never go to storage.
  if (!_drSetupLoaded) {
    try {
      const d = await chrome.storage.local.get(DR_STATE_KEY);
      _drSavedSetup = d[DR_STATE_KEY] || null;
    } catch (_) { _drSavedSetup = null; }
    _drSetupLoaded = true;
  }

  const orgs = allMapOrgs();
  const orgOptions = orgs.map(o =>
    `<option value="${esc(o.url)}">${esc(orgOptionLabel(o.url, o.label))}</option>`
  ).join('');

  setMain(`
    <div class="ds-view-header">
      <div class="ds-view-title-wrap">
        <h2 class="ds-view-title">🛡 Deployment Readiness</h2>
        <div class="ds-view-subtitle">Compare schemas between orgs — find missing fields, picklist gaps, validation rules, and more before a data load fails</div>
      </div>
    </div>

    <div class="ds-op-banner ds-op-banner-read">
      <span class="ds-op-banner-icon">📖</span>
      <div class="ds-op-banner-body">
        <div class="ds-op-banner-title">Read-only — this never modifies any data</div>
        <div class="ds-op-banner-desc">Only reads object schemas using the Salesforce Describe API. Nothing is inserted, updated, or deleted in any org.</div>
      </div>
    </div>

    <div class="dr-config">
      ${(() => {
        // Ring mode (graduation, 2026-07-20): source = the 👑 source of
        // truth, targets = EVERY ring target, each checked separately. The
        // classic pair selects only exist when no ring is configured.
        const ring = _drRingCfg();
        if (!ring) return `
      <div class="dr-orgs-row">
        <div class="ds-field-group" style="flex:1">
          <label class="ds-lbl">Source Org <span class="ds-lbl-hint">(where data comes from)</span></label>
          <select id="drSrcOrg" class="ds-select">
            <option value="">— Select source org —</option>
            ${orgOptions}
          </select>
        </div>
        <div class="dr-arrow">→</div>
        <div class="ds-field-group" style="flex:1">
          <label class="ds-lbl">Target Org <span class="ds-lbl-hint">(where data will be loaded)</span></label>
          <select id="drTgtOrg" class="ds-select">
            <option value="">— Select target org —</option>
            ${orgOptions}
          </select>
        </div>
      </div>`;
        const ls = _liveOrgSet();
        return `
      <div class="ds-pk-sot-line" title="Every target below is checked against this org's schema. Change it in 🔄 Sync Ring or the topbar chip.">
        👑 Source of truth: <strong>${esc(orgOptionLabel(ring.src, orgLabel(ring.src), ls))}</strong>
        ${!ls.has(_orgKey(ring.src)) ? '<span style="color:#92400e">— open it in a Chrome tab, schemas are read from it</span>' : ''}
      </div>
      <div class="ds-pk-cmp-lbl" style="margin-top:6px">Check readiness of</div>
      <div class="ds-pk-orgchk-list">
        ${ring.targets.map(u => `<label class="ds-pk-orgchk">
          <input type="checkbox" data-dr-tgt="${esc(u)}" ${!_drTgtSel || _drTgtSel.has(_orgKey(u)) ? 'checked' : ''}>
          ${esc(orgOptionLabel(u, orgLabel(u), ls))}</label>`).join('')}
      </div>`;
      })()}

      <details id="drObjectsPanel" class="ds-oc-objects-panel" style="margin-top:12px">
        <summary class="ds-oc-objects-sum"><strong>Objects to check</strong>
          <span class="ds-oc-sub" id="drObjCount">— select a source org first —</span>
        </summary>
        <div id="drObjList" class="ds-oc-obj-list"></div>
      </details>

      <div class="dr-checks-row">
        <label class="dr-check-label"><input type="checkbox" id="drChkFields" checked> Missing &amp; required fields</label>
        <label class="dr-check-label"><input type="checkbox" id="drChkPicklists" checked> Picklist value mismatches</label>
        <label class="dr-check-label"><input type="checkbox" id="drChkRecordTypes" checked> Record type gaps</label>
        <label class="dr-check-label"><input type="checkbox" id="drChkValidation" checked> Validation rules (target)</label>
        <label class="dr-check-label"><input type="checkbox" id="drChkDupRules" checked> Duplication rules (target)</label>
      </div>

      <div style="display:flex;gap:8px;margin-top:14px;align-items:center;flex-wrap:wrap">
        <button class="ds-btn ds-btn-primary" id="drRunBtn">🛡 Run Readiness Check</button>
        <span id="drStatus" class="dr-status"></span>
      </div>

      <div id="drError" class="dr-error" style="display:none"></div>
    </div>

    <div id="drResults" class="dr-results" style="display:none"></div>
  `);

  eid('drRunBtn')?.addEventListener('click', runReadinessCheck);
  // Ring mode: target checkboxes (session-scoped selection).
  document.querySelectorAll('[data-dr-tgt]').forEach(cb =>
    cb.addEventListener('change', () => {
      _drTgtSel = new Set([...document.querySelectorAll('[data-dr-tgt]:checked')].map(c => _orgKey(c.dataset.drTgt)));
    }));
  // Source org drives the object list — load it when picked (or re-picked),
  // and lazily when the panel is first opened.
  eid('drSrcOrg')?.addEventListener('change', () => {
    _drObjState = { srcId: null, objects: null, selected: new Set() };
    drSaveSetup();
    drRefreshObjectList();
  });
  eid('drTgtOrg')?.addEventListener('change', drSaveSetup);
  eid('drObjectsPanel')?.addEventListener('toggle', e => {
    if (e.target.open) drRefreshObjectList();
  });
  ['drChkFields', 'drChkPicklists', 'drChkRecordTypes', 'drChkValidation', 'drChkDupRules']
    .forEach(id => eid(id)?.addEventListener('change', drSaveSetup));

  // Default both selects: persisted setup first, then the working pair
  // (option values are org URLs; assigning an unknown URL leaves '' so the
  // fallback still applies).
  {
    const s = eid('drSrcOrg'), t = eid('drTgtOrg');
    if (s && !s.value && _drSavedSetup?.src) s.value = _drSavedSetup.src;
    if (s && !s.value && _workingPair.src)   s.value = _workingPair.src;
    if (t && !t.value && _drSavedSetup?.tgt) t.value = _drSavedSetup.tgt;
    if (t && !t.value && _workingPair.tgt)   t.value = _workingPair.tgt;
    if (_drSavedSetup?.checks) {
      const c = _drSavedSetup.checks;
      const setChk = (id, v) => { const el = eid(id); if (el && typeof v === 'boolean') el.checked = v; };
      setChk('drChkFields',      c.fields);
      setChk('drChkPicklists',   c.picklists);
      setChk('drChkRecordTypes', c.recordTypes);
      setChk('drChkValidation',  c.validation);
      setChk('drChkDupRules',    c.dupRules);
    }
    if (s?.value || _drRingCfg()) drRefreshObjectList();
  }

  // U4a: results from a previous run this session are still in memory —
  // re-show them with a "from N ago" banner instead of a blank view.
  drRestoreCachedResults();
}

// ── Deploy Readiness object multi-select ───────────────────────
// Checkbox panel (same pattern + CSS as Org Compare's picker). Defaults
// pre-check all CUSTOM objects — matching the old "blank = auto-detect
// customs" behaviour, but now visible and editable instead of implicit.
let _drObjState = { srcId: null, objects: null, selected: new Set() };

// ── U4a: view-state persistence ────────────────────────────────
// Only the lightweight SETUP (orgs, object selection, check toggles) is
// persisted to chrome.storage.local. RESULTS stay in module memory so a
// view switch this session re-shows them, but a reload starts clean.
const DR_STATE_KEY  = 'ds_readiness_state';
let _drSavedSetup   = null;   // last persisted setup (restored on first render)
let _drSetupLoaded  = false;  // storage read once per session
let _drResultsCache = null;   // { ts, html, srcKey, tgtKeys } — in-memory results from last run
let _drTgtSel       = null;   // ring mode: Set of checked target orgKeys (null = all)

// Ring config for this view: { src, targets[] } when a Sync Ring with a
// source of truth exists, else null (→ classic pair selects).
function _drRingCfg() {
  if (typeof _ring !== 'object' || !_ring?.sourceUrl || (_ring.orgs || []).length < 2) return null;
  const src = _ring.sourceUrl;
  const targets = (_ring.orgs || []).filter(u => _orgKey(u) !== _orgKey(src));
  return targets.length ? { src, targets } : null;
}

function drSaveSetup() {
  const setup = {
    src:      eid('drSrcOrg')?.value || '',
    tgt:      eid('drTgtOrg')?.value || '',
    // Keep the previously saved selection when the object list isn't loaded
    // (e.g. only the orgs or check toggles changed this render).
    srcId:    _drObjState.objects ? _drObjState.srcId : (_drSavedSetup?.srcId ?? null),
    selected: _drObjState.objects ? [..._drObjState.selected] : (_drSavedSetup?.selected ?? null),
    checks: {
      fields:      eid('drChkFields')?.checked ?? true,
      picklists:   eid('drChkPicklists')?.checked ?? true,
      recordTypes: eid('drChkRecordTypes')?.checked ?? true,
      validation:  eid('drChkValidation')?.checked ?? true,
      dupRules:    eid('drChkDupRules')?.checked ?? true
    }
  };
  _drSavedSetup = setup;
  try { chrome.storage.local.set({ [DR_STATE_KEY]: setup }); } catch (_) { /* storage unavailable — setup just won't persist */ }
}

function drRestoreCachedResults() {
  if (!_drResultsCache) return;
  const resultsEl = eid('drResults');
  if (!resultsEl) return;
  // Never re-show results under a different configuration than produced them
  // (audit fix — misattribution). The cached html names its own orgs, but the
  // stamp check guarantees it can't outlive a source-of-truth/target change.
  const ring = _drRingCfg();
  const curSrc = _orgKey(ring ? ring.src : (eid('drSrcOrg')?.value || ''));
  if (_drResultsCache.srcKey && _drResultsCache.srcKey !== curSrc) { _drResultsCache = null; return; }
  resultsEl.style.display = '';
  resultsEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:#E8F4FD;border:1px solid #C5DBF0;border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:12px;color:#014486">
      <span>🕒 Results from <strong>${esc(timeAgo(_drResultsCache.ts))}</strong></span>
      <button class="ds-btn ds-btn-xs" id="drRerunBtn">↻ Re-run</button>
    </div>
    ${_drResultsCache.html}`;
  eid('drRerunBtn')?.addEventListener('click', runReadinessCheck);
  // Re-wire expand/collapse on the restored cards (innerHTML drops listeners)
  resultsEl.querySelectorAll('.dr-obj-card-hdr').forEach(hdr => {
    hdr.addEventListener('click', () => {
      hdr.closest('.dr-obj-card')?.classList.toggle('dr-obj-card-open');
    });
  });
}

async function drRefreshObjectList() {
  const listEl  = eid('drObjList');
  const countEl = eid('drObjCount');
  if (!listEl) return;
  const srcId = eid('drSrcOrg')?.value || _drRingCfg()?.src;
  if (!srcId) {
    listEl.innerHTML = '<div class="ds-oc-empty">Pick a source org to load its object list.</div>';
    if (countEl) countEl.textContent = '— select a source org first —';
    return;
  }

  if (_drObjState.srcId !== srcId || !_drObjState.objects) {
    listEl.innerHTML = '<div class="ds-oc-empty">Loading object list…</div>';
    const srcSess = await getOrgSession(srcId);
    if (!srcSess) {
      listEl.innerHTML = '<div class="ds-oc-empty">Cannot connect to the source org — open it in Chrome.</div>';
      return;
    }
    const res = await sendBg({ type: 'SF_REST_GET', orgUrl: srcSess.orgUrl, sid: srcSess.sid,
      path: 'services/data/v62.0/sobjects' });
    if (res.error) {
      listEl.innerHTML = `<div class="ds-oc-empty">Failed to load objects: ${esc(res.error)}</div>`;
      return;
    }
    const objs = (res.sobjects || [])
      .filter(o => o.queryable && o.createable && !o.deprecatedAndHidden)
      .map(o => ({ name: o.name, label: o.label || o.name, custom: !!o.custom }))
      .sort((a, b) => a.label.localeCompare(b.label));
    // U4a: restore the persisted selection when it belongs to this same
    // source org — otherwise default = all custom objects (the old
    // auto-detect behaviour). Names no longer in the org are dropped; if
    // that empties a non-empty saved selection, fall back to the default.
    let selected = null;
    if (_drSavedSetup && _drSavedSetup.srcId === srcId && Array.isArray(_drSavedSetup.selected)) {
      const names    = new Set(objs.map(o => o.name));
      const restored = new Set(_drSavedSetup.selected.filter(n => names.has(n)));
      if (restored.size || !_drSavedSetup.selected.length) selected = restored;
    }
    if (!selected) {
      selected = new Set(objs.filter(o => o.custom).map(o => o.name));
      // + the objects your deployments actually move — they are the ones a
      // failed load hurts (collectTreeObjects lives in studio-builder.js).
      try {
        (_profiles || []).forEach(p => {
          if (!p.tree || typeof collectTreeObjects !== 'function') return;
          collectTreeObjects(p.tree).forEach(n => { if (objs.some(o => o.name === n)) selected.add(n); });
        });
      } catch (_) { /* defaults only */ }
    }
    _drObjState = { srcId, objects: objs, selected };
  }

  const sel  = _drObjState.selected;
  const rows = _drObjState.objects.map(o => `
    <label class="ds-oc-obj-row${o.custom ? ' ds-oc-obj-custom' : ''}">
      <input type="checkbox" data-dr-obj="${esc(o.name)}" ${sel.has(o.name) ? 'checked' : ''}>
      <span class="ds-oc-obj-name">${esc(o.label)}</span>
      <span class="ds-oc-obj-api">${esc(o.name)}</span>
      ${o.custom ? '<span class="ds-oc-obj-tag">custom</span>' : ''}
    </label>`).join('');

  listEl.innerHTML = `
    <div class="ds-oc-list-actions">
      <button class="ds-btn ds-btn-xs" id="drObjSelCustom">✓ All custom</button>
      <button class="ds-btn ds-btn-xs" id="drObjSelAll">✓ All</button>
      <button class="ds-btn ds-btn-xs" id="drObjSelNone">✗ None</button>
      <input type="text" id="drObjFilter" class="ds-input ds-input-sm" placeholder="Filter…" style="margin-left:auto;width:180px">
    </div>
    <div class="ds-oc-rows">${rows}</div>`;

  function syncCount() {
    if (countEl) countEl.textContent = `${sel.size} of ${_drObjState.objects.length} selected`;
    // U4a: every path that changes the selection (checkbox, All/None/Custom
    // buttons, fresh load) lands here — persist the setup in one place.
    drSaveSetup();
  }
  syncCount();
  listEl.querySelectorAll('[data-dr-obj]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) sel.add(cb.dataset.drObj); else sel.delete(cb.dataset.drObj);
      syncCount();
    });
  });
  eid('drObjSelCustom')?.addEventListener('click', () => {
    sel.clear();
    _drObjState.objects.forEach(o => { if (o.custom) sel.add(o.name); });
    drRefreshObjectList();
  });
  eid('drObjSelAll')?.addEventListener('click', () => {
    _drObjState.objects.forEach(o => sel.add(o.name));
    drRefreshObjectList();
  });
  eid('drObjSelNone')?.addEventListener('click', () => {
    sel.clear(); drRefreshObjectList();
  });
  eid('drObjFilter')?.addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    listEl.querySelectorAll('.ds-oc-obj-row').forEach(row => {
      row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
}

// ── Main readiness check runner ────────────────────────────────
async function runReadinessCheck() {
  hideDrError();
  const ring = _drRingCfg();
  const srcId = ring ? ring.src : eid('drSrcOrg')?.value;
  const tgtIds = ring
    ? ring.targets.filter(u => !_drTgtSel || _drTgtSel.has(_orgKey(u)))
    : [eid('drTgtOrg')?.value].filter(Boolean);
  if (!srcId || !tgtIds.length) { showDrError(ring ? 'Tick at least one target to check.' : 'Select both source and target orgs.'); return; }
  if (!ring && srcId === tgtIds[0]) { showDrError('Source and target org must be different.'); return; }

  const chkFields      = eid('drChkFields')?.checked ?? true;
  const chkPicklists   = eid('drChkPicklists')?.checked ?? true;
  const chkRecordTypes = eid('drChkRecordTypes')?.checked ?? true;
  const chkValidation  = eid('drChkValidation')?.checked ?? true;
  const chkDupRules    = eid('drChkDupRules')?.checked ?? true;

  // Resolve the source session (targets resolve one by one in the loop —
  // a closed target is a visible skip, never a dead stop).
  setDrStatus('⏳ Connecting to orgs…');
  const srcSess = await getOrgSession(srcId);
  if (!srcSess) { showDrError(`Cannot connect to ${orgLabel(srcId)} (the source) — open it in a Chrome tab first.`); return; }

  // Object list — from the multi-select panel. If the user never opened the
  // panel, load it now so the defaults (customs + deployment objects) apply.
  if (_drObjState.srcId !== srcId || !_drObjState.objects) {
    setDrStatus('⏳ Loading object list from source…');
    await drRefreshObjectList();
  }
  const objects = [...(_drObjState.selected || [])];
  if (!objects.length) {
    showDrError(_drObjState.objects?.length
      ? 'No objects selected — open "Objects to check" above and tick at least one object.'
      : 'No objects available to check — the source org returned no queryable objects.');
    setDrStatus('');
    return;
  }

  // U4a: persist the exact setup this run uses
  drSaveSetup();

  // Results container — the header names the exact orgs this run describes
  // (audit fix: results were previously unattributed).
  const resultsEl = eid('drResults');
  if (resultsEl) {
    resultsEl.style.display = '';
    resultsEl.innerHTML = `
      <div class="dr-run-attrib" style="font-size:12.5px;margin-bottom:8px">
        ${ring ? '👑 ' : ''}<strong>${esc(orgLabel(srcId))}</strong> → ${tgtIds.map(u => esc(orgLabel(u))).join(' · ')}
        <span style="color:var(--subtext)"> · ${objects.length} object(s) · ${esc(new Date().toLocaleString())}</span>
      </div>
      <div class="dr-progress">
        ${window.sftkCatSm ? sftkCatSm('Analysing…') : 'Analysing…'}
        <div id="drProgressText" class="dr-progress-text"></div>
      </div>
      <div id="drTargetSecs"></div>`;
  }
  const secsEl = eid('drTargetSecs');

  for (const tgtId of tgtIds) {
    const tgtLabel = orgLabel(tgtId);
    const tgtSess = await getOrgSession(tgtId);
    if (!tgtSess) {
      if (secsEl) secsEl.insertAdjacentHTML('beforeend',
        `<div class="dr-target-sec"><div class="dr-target-hdr" style="font-weight:700;margin:10px 0 4px">→ ${esc(tgtLabel)} — ⏭ not open in a Chrome tab, skipped</div></div>`);
      continue;
    }
    const secId = `drSec_${_orgKey(tgtId).replace(/[^a-z0-9]/gi, '')}`;
    if (secsEl) secsEl.insertAdjacentHTML('beforeend',
      `<div class="dr-target-sec">
         <div class="dr-target-hdr" style="font-weight:700;margin:10px 0 4px">→ ${esc(tgtLabel)} ${prodBadge(tgtId)} <span class="dr-target-sum" data-sum="${secId}"></span></div>
         <div class="dr-object-cards" id="${secId}"></div>
       </div>`);
    const cardsEl = eid(secId);
    let total = 0, critCount = 0, warnCount = 0, okCount = 0;

    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i];
      setDrStatus(`⏳ ${tgtLabel}: ${i + 1} / ${objects.length}: ${obj}`);
      const progEl = eid('drProgressText');
      if (progEl) progEl.textContent = `${tgtLabel} — ${i + 1} / ${objects.length}: ${obj}`;
      try {
        const card = await analyseObject(obj, srcSess, tgtSess, { chkFields, chkPicklists, chkRecordTypes, chkValidation, chkDupRules });
        total++;
        if (card.severity === 'critical') critCount++;
        else if (card.severity === 'warning') warnCount++;
        else okCount++;
        if (cardsEl) cardsEl.insertAdjacentHTML('beforeend', renderObjectCard(card));
      } catch (e) {
        total++; critCount++;
        if (cardsEl) cardsEl.insertAdjacentHTML('beforeend', renderObjectCard({
          obj, severity: 'error',
          error: e.message || String(e),
          missingFields: [], requiredFields: [], picklistMismatches: [],
          recordTypeGaps: [], validationRules: [], duplicationRules: []
        }));
      }
    }
    const sumEl = document.querySelector(`[data-sum="${secId}"]`);
    if (sumEl) sumEl.innerHTML =
      `${critCount ? `<span class="dr-sum-badge dr-sum-crit">🔴 ${critCount}</span>` : ''}
       ${warnCount ? `<span class="dr-sum-badge dr-sum-warn">🟡 ${warnCount}</span>` : ''}
       ${okCount ? `<span class="dr-sum-badge dr-sum-ok">✅ ${okCount} ok</span>` : ''}
       <span style="color:var(--subtext);font-size:11px">${total} checked</span>`;
  }

  // Remove spinner
  const progRow = resultsEl?.querySelector('.dr-progress');
  if (progRow) progRow.remove();

  setDrStatus(`✅ Done — ${tgtIds.length} target(s) checked`);

  // Cached results are STAMPED with the orgs they describe — restore only
  // ever re-shows them for the same configuration (audit fix: the old cache
  // re-rendered under whatever the selects happened to say).
  if (resultsEl) _drResultsCache = {
    ts: new Date().toISOString(), html: resultsEl.innerHTML,
    srcKey: _orgKey(srcId), tgtKeys: tgtIds.map(u => _orgKey(u)).sort().join('|'),
  };

  // Wire expand/collapse
  document.querySelectorAll('.dr-obj-card-hdr').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const card = hdr.closest('.dr-obj-card');
      card?.classList.toggle('dr-obj-card-open');
    });
  });
}

// ── Analyse a single object ────────────────────────────────────
async function analyseObject(obj, srcSess, tgtSess, opts) {
  const SYSTEM_FIELDS = new Set([
    'Id','IsDeleted','CreatedDate','CreatedById','LastModifiedDate','LastModifiedById',
    'SystemModstamp','LastActivityDate','LastViewedDate','LastReferencedDate',
    'OwnerId','MasterRecordId','RecordTypeId'
  ]);

  // Parallel: describe on both orgs + tooling queries on target
  const [srcDescRes, tgtDescRes, valRulesRes, dupRulesRes] = await Promise.all([
    sendBg({ type: 'SF_REST_GET', orgUrl: srcSess.orgUrl, sid: srcSess.sid,
             path: `services/data/v62.0/sobjects/${obj}/describe` }),
    sendBg({ type: 'SF_REST_GET', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
             path: `services/data/v62.0/sobjects/${obj}/describe` }),
    opts.chkValidation ? sendBg({ type: 'SF_QUERY', tooling: true, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
      query: `SELECT Id, ValidationName, Active, Description FROM ValidationRule WHERE EntityDefinitionId = ${soqlStrLit(obj)} AND Active = true` }) : Promise.resolve(null),
    opts.chkDupRules ? sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
      query: `SELECT Id, DeveloperName FROM DuplicateRule WHERE SobjectType = ${soqlStrLit(obj)} AND IsActive = true` }) : Promise.resolve(null),
  ]);

  if (srcDescRes.error) {
    if (isSessionResult(srcDescRes)) showSessionBanner(srcSess.orgUrl);
    throw new Error(`Cannot describe ${obj} on source: ${srcDescRes.error}`);
  }
  if (tgtDescRes.error) {
    if (isSessionResult(tgtDescRes)) showSessionBanner(tgtSess.orgUrl);
    throw new Error(`Cannot describe ${obj} on target: ${tgtDescRes.error}`);
  }

  const srcFields = srcDescRes.fields || [];
  const tgtFields = tgtDescRes.fields || [];

  const srcFieldMap = {};
  const tgtFieldMap = {};
  srcFields.forEach(f => { srcFieldMap[f.name] = f; });
  tgtFields.forEach(f => { tgtFieldMap[f.name] = f; });

  const result = {
    obj,
    missingFields:      [],
    requiredFields:     [],
    typeMismatches:     [],   // Feature 11: blocking type mismatches
    picklistMismatches: [],
    recordTypeGaps:     [],
    validationRules:    [],
    duplicationRules:   [],
    severity:           'ok',
    error:              null
  };

  // ── Missing fields ────────────────────────────────────────────
  if (opts.chkFields) {
    for (const f of srcFields) {
      if (SYSTEM_FIELDS.has(f.name)) continue;
      if (!f.createable) continue;
      if (!tgtFieldMap[f.name]) {
        result.missingFields.push({
          api:      f.name,
          label:    f.label,
          type:     f.type,
          required: !f.nillable && f.createable && f.defaultValue === null
        });
      }
    }
    // Required in target but missing/nullable in source
    for (const f of tgtFields) {
      if (SYSTEM_FIELDS.has(f.name)) continue;
      if (!f.createable || f.nillable || f.defaultValue !== null) continue;
      if (srcFieldMap[f.name]) continue; // exists in source, ok
      result.requiredFields.push({ api: f.name, label: f.label, type: f.type });
    }
  }

  // ── Feature 11: Type mismatches (blocking) ───────────────────
  if (opts.chkFields) {
    // Fields that exist in both orgs but have incompatible types
    const COMPATIBLE_PAIRS = new Set([
      'string:textarea', 'textarea:string',
      'picklist:string', 'string:picklist',
      'phone:string',   'string:phone',
      'email:string',   'string:email',
      'url:string',     'string:url',
    ]);
    for (const f of srcFields) {
      if (SYSTEM_FIELDS.has(f.name) || !f.createable) continue;
      const tgtF = tgtFieldMap[f.name];
      if (!tgtF) continue; // already captured as missing
      const typeKey = `${f.type}:${tgtF.type}`;
      if (f.type !== tgtF.type && !COMPATIBLE_PAIRS.has(typeKey)) {
        result.typeMismatches.push({
          api:     f.name,
          label:   f.label,
          srcType: f.type,
          tgtType: tgtF.type,
          blocking: true
        });
      }
    }
  }

  // ── Picklist mismatches ───────────────────────────────────────
  if (opts.chkPicklists) {
    for (const f of srcFields) {
      if (f.type !== 'picklist' && f.type !== 'multipicklist') continue;
      const tgtF = tgtFieldMap[f.name];
      if (!tgtF) continue; // already captured as missing
      const srcVals = new Set((f.picklistValues || []).filter(v => v.active).map(v => v.value));
      const tgtVals = new Set((tgtF.picklistValues || []).filter(v => v.active).map(v => v.value));
      const orphans = [...srcVals].filter(v => !tgtVals.has(v));
      if (orphans.length) {
        result.picklistMismatches.push({ api: f.name, label: f.label, missingValues: orphans });
      }
    }
  }

  // ── Record type gaps ─────────────────────────────────────────
  if (opts.chkRecordTypes) {
    const srcRTs = (srcDescRes.recordTypeInfos || []).filter(rt => !rt.master && rt.active);
    const tgtRTs = new Set((tgtDescRes.recordTypeInfos || []).filter(rt => !rt.master && rt.active).map(rt => rt.developerName));
    for (const rt of srcRTs) {
      if (!tgtRTs.has(rt.developerName)) {
        result.recordTypeGaps.push({ developerName: rt.developerName, name: rt.name });
      }
    }
  }

  // ── Validation rules ─────────────────────────────────────────
  // A FAILED rule query is reported, never swallowed (audit fix: it used to
  // render as "no rules" — a clean bill of health the check never earned).
  result.checkNotes = [];
  if (opts.chkValidation && valRulesRes) {
    if (valRulesRes.error) result.checkNotes.push(`Validation rules could NOT be read on the target (${valRulesRes.error}) — this check is inconclusive, not clean.`);
    else result.validationRules = (valRulesRes.records || []).map(r => ({
      name: r.ValidationName, desc: r.Description || ''
    }));
  }

  // ── Duplication rules ─────────────────────────────────────────
  if (opts.chkDupRules && dupRulesRes) {
    if (dupRulesRes.error) result.checkNotes.push(`Duplicate rules could NOT be read on the target (${dupRulesRes.error}) — this check is inconclusive, not clean.`);
    else result.duplicationRules = (dupRulesRes.records || []).map(r => ({ name: r.DeveloperName }));
  }

  // ── Severity ─────────────────────────────────────────────────
  const hasCritical = result.missingFields.some(f => f.required)
    || result.requiredFields.length > 0
    || result.typeMismatches.length > 0          // Feature 11
    || result.picklistMismatches.length > 0
    || result.recordTypeGaps.length > 0;

  const hasWarning = result.missingFields.some(f => !f.required)
    || result.validationRules.length > 0
    || result.duplicationRules.length > 0
    || result.checkNotes.length > 0;

  result.severity = hasCritical ? 'critical' : hasWarning ? 'warning' : 'ok';
  return result;
}

// ── Render a single object card ────────────────────────────────
function renderObjectCard(card) {
  const { obj, severity, error } = card;

  const sevIcon  = severity === 'critical' ? '🔴' : severity === 'warning' ? '🟡' : severity === 'error' ? '❌' : '✅';
  const sevClass = `dr-sev-${severity}`;

  let bodyHtml = '';

  if (error) {
    bodyHtml = `<div class="dr-issue-row dr-issue-error">❌ Error: ${esc(error)}</div>`;
  } else {
    // Inconclusive checks first — louder than any finding below.
    if (card.checkNotes?.length) {
      bodyHtml += card.checkNotes.map(n =>
        `<div class="dr-issue-row dr-issue-warn">⚠ ${esc(n)}</div>`).join('');
    }
    // Missing fields (critical = required ones first)
    if (card.missingFields.length) {
      const critFields = card.missingFields.filter(f => f.required);
      const optFields  = card.missingFields.filter(f => !f.required);
      if (critFields.length) {
        bodyHtml += `<div class="dr-section-hdr dr-section-crit">🔴 Missing required fields in target (${critFields.length})</div>`;
        bodyHtml += critFields.map(f =>
          `<div class="dr-issue-row dr-issue-crit">
             <span class="dr-field-api">${esc(f.api)}</span>
             <span class="dr-field-label">${esc(f.label)}</span>
             <span class="dr-field-type">${esc(f.type)}</span>
             <span class="dr-badge-crit">required</span>
           </div>`
        ).join('');
      }
      if (optFields.length) {
        bodyHtml += `<div class="dr-section-hdr dr-section-warn">🟡 Missing optional fields in target (${optFields.length})</div>`;
        bodyHtml += optFields.slice(0, 20).map(f =>
          `<div class="dr-issue-row dr-issue-warn">
             <span class="dr-field-api">${esc(f.api)}</span>
             <span class="dr-field-label">${esc(f.label)}</span>
             <span class="dr-field-type">${esc(f.type)}</span>
           </div>`
        ).join('');
        if (optFields.length > 20) bodyHtml += `<div class="dr-more">…and ${optFields.length - 20} more</div>`;
      }
    }

    // Feature 11: Type mismatches (blocking — will cause data import errors)
    if (card.typeMismatches?.length) {
      bodyHtml += `<div class="dr-section-hdr dr-section-crit">🔴 Field type mismatch — source type differs from target (${card.typeMismatches.length})</div>`;
      bodyHtml += card.typeMismatches.map(tm =>
        `<div class="dr-issue-row dr-issue-crit">
           <span class="dr-field-api">${esc(tm.api)}</span>
           <span class="dr-field-label">${esc(tm.label)}</span>
           <span class="dr-type-mismatch-badges">
             <span class="dr-field-type" style="background:#FEF2F2;color:#B91C1C;border-color:#FCA5A5">${esc(tm.srcType)}</span>
             <span style="color:var(--subtext);font-size:10px;padding:0 2px">→</span>
             <span class="dr-field-type" style="background:#FFF7ED;color:#C2410C;border-color:#FED7AA">${esc(tm.tgtType)}</span>
           </span>
           <span class="dr-badge-crit">BLOCKING</span>
         </div>`
      ).join('');
    }

    // Required in target but not in source
    if (card.requiredFields.length) {
      bodyHtml += `<div class="dr-section-hdr dr-section-crit">🔴 Required in target, may be empty in source data (${card.requiredFields.length})</div>`;
      bodyHtml += card.requiredFields.map(f =>
        `<div class="dr-issue-row dr-issue-crit">
           <span class="dr-field-api">${esc(f.api)}</span>
           <span class="dr-field-label">${esc(f.label)}</span>
           <span class="dr-field-type">${esc(f.type)}</span>
         </div>`
      ).join('');
    }

    // Picklist mismatches
    if (card.picklistMismatches.length) {
      bodyHtml += `<div class="dr-section-hdr dr-section-crit">🔴 Picklist values in source not in target (${card.picklistMismatches.length} field${card.picklistMismatches.length !== 1 ? 's' : ''})</div>`;
      bodyHtml += card.picklistMismatches.map(pm =>
        `<div class="dr-issue-row dr-issue-crit">
           <span class="dr-field-api">${esc(pm.api)}</span>
           <span class="dr-field-label">${esc(pm.label)}</span>
           <span class="dr-picklist-vals">${pm.missingValues.slice(0, 10).map(v => `<span class="dr-pv">${esc(v)}</span>`).join('')}${pm.missingValues.length > 10 ? `<span class="dr-more-inline">+${pm.missingValues.length - 10} more</span>` : ''}</span>
         </div>`
      ).join('');
    }

    // Record type gaps
    if (card.recordTypeGaps.length) {
      bodyHtml += `<div class="dr-section-hdr dr-section-crit">🔴 Record types in source missing from target (${card.recordTypeGaps.length})</div>`;
      bodyHtml += card.recordTypeGaps.map(rt =>
        `<div class="dr-issue-row dr-issue-crit">
           <span class="dr-field-api">${esc(rt.developerName)}</span>
           <span class="dr-field-label">${esc(rt.name)}</span>
         </div>`
      ).join('');
    }

    // Validation rules
    if (card.validationRules.length) {
      bodyHtml += `<div class="dr-section-hdr dr-section-warn">⚠ Active validation rules on target — may block import (${card.validationRules.length})</div>`;
      bodyHtml += card.validationRules.map(vr =>
        `<div class="dr-issue-row dr-issue-warn">
           <span class="dr-field-api">${esc(vr.name)}</span>
           ${vr.desc ? `<span class="dr-field-label" style="color:var(--subtext)">${esc(vr.desc.substring(0,80))}${vr.desc.length > 80 ? '…' : ''}</span>` : ''}
         </div>`
      ).join('');
    }

    // Duplication rules
    if (card.duplicationRules.length) {
      bodyHtml += `<div class="dr-section-hdr dr-section-warn">⚠ Active duplication rules on target — may block import (${card.duplicationRules.length})</div>`;
      bodyHtml += card.duplicationRules.map(dr =>
        `<div class="dr-issue-row dr-issue-warn"><span class="dr-field-api">${esc(dr.name)}</span></div>`
      ).join('');
    }

    if (!bodyHtml) {
      bodyHtml = `<div class="dr-issue-ok">✅ No issues found — object looks ready for data transfer</div>`;
    }
  }

  // Issue summary chips
  const chips = [];
  if (card.missingFields?.filter(f => f.required).length)  chips.push(`<span class="dr-chip dr-chip-crit">${card.missingFields.filter(f=>f.required).length} missing-req</span>`);
  if (card.missingFields?.filter(f => !f.required).length) chips.push(`<span class="dr-chip dr-chip-warn">${card.missingFields.filter(f=>!f.required).length} missing-opt</span>`);
  if (card.typeMismatches?.length)     chips.push(`<span class="dr-chip dr-chip-crit">${card.typeMismatches.length} type-mismatch</span>`);  // Feature 11
  if (card.requiredFields?.length)     chips.push(`<span class="dr-chip dr-chip-crit">${card.requiredFields.length} req-empty</span>`);
  if (card.picklistMismatches?.length) chips.push(`<span class="dr-chip dr-chip-crit">${card.picklistMismatches.length} picklist</span>`);
  if (card.recordTypeGaps?.length)     chips.push(`<span class="dr-chip dr-chip-crit">${card.recordTypeGaps.length} rec-type</span>`);
  if (card.validationRules?.length)    chips.push(`<span class="dr-chip dr-chip-warn">${card.validationRules.length} validation</span>`);
  if (card.duplicationRules?.length)   chips.push(`<span class="dr-chip dr-chip-warn">${card.duplicationRules.length} dup-rule</span>`);

  const isDefaultOpen = severity === 'critical' || severity === 'error';

  return `
    <div class="dr-obj-card ${isDefaultOpen ? 'dr-obj-card-open' : ''}">
      <div class="dr-obj-card-hdr ${sevClass}">
        <span class="dr-obj-sev">${sevIcon}</span>
        <span class="dr-obj-name">${esc(obj)}</span>
        <div class="dr-obj-chips">${chips.join('')}</div>
        <span class="dr-obj-chevron">›</span>
      </div>
      <div class="dr-obj-card-body">
        ${bodyHtml}
      </div>
    </div>`;
}

// ── Status / error helpers ─────────────────────────────────────
function setDrStatus(msg) {
  const el = eid('drStatus');
  if (el) el.textContent = msg;
}

function showDrError(msg) {
  const el = eid('drError');
  if (el) { el.textContent = '❌ ' + msg; el.style.display = ''; }
  setDrStatus('');
}

function hideDrError() {
  const el = eid('drError');
  if (el) el.style.display = 'none';
}

