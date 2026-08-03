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
    ${dsViewHeader({
      // 'shield' is this view's sidebar glyph (studio.html data-view="readiness").
      icon: 'shield',
      title: 'Deployment Readiness',
      subtitle: 'Compare schemas between orgs — find missing fields, picklist gaps, validation rules, and more before a data load fails',
    })}

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
        <label class="dr-check-label" title="Compares ORG-LEVEL configuration once per target (not per object): State &amp; Country picklists, Person Accounts, multi-currency, Advanced Currency Management."><input type="checkbox" id="drChkOrgSettings" checked> Org settings (state/country, person accounts, currency)</label>
      </div>

      <div style="display:flex;gap:8px;margin-top:14px;align-items:center;flex-wrap:wrap">
        <button class="ds-btn ds-btn-primary" id="drRunBtn">🛡 Run Readiness Check</button>
        <span id="drStatus" class="dr-status"></span>
      </div>
      <!-- E3b: what this run will spend, before it spends it. Filled by
           drUpdateApiBudget() on every setup change. -->
      <div id="drApiBudget" style="margin-top:6px;font-size:11.5px;color:var(--subtext)"></div>

      <div id="drError" class="dr-error" style="display:none"></div>
    </div>

    <div id="drResults" class="dr-results" style="display:none"></div>
  `);

  eid('drRunBtn')?.addEventListener('click', runReadinessCheck);
  // Ring mode: target checkboxes (session-scoped selection).
  document.querySelectorAll('[data-dr-tgt]').forEach(cb =>
    cb.addEventListener('change', () => {
      _drTgtSel = new Set([...document.querySelectorAll('[data-dr-tgt]:checked')].map(c => _orgKey(c.dataset.drTgt)));
      drUpdateApiBudget();   // E3b: fewer/more targets = a different spend
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
  ['drChkFields', 'drChkPicklists', 'drChkRecordTypes', 'drChkValidation', 'drChkDupRules', 'drChkOrgSettings']
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
      setChk('drChkOrgSettings', c.orgSettings);   // T11c — absent in setups saved before T11c, so the `checked` default stands
    }
    if (s?.value || _drRingCfg()) drRefreshObjectList();
  }

  // U4a: results from a previous run this session are still in memory —
  // re-show them with a "from N ago" banner instead of a blank view.
  drRestoreCachedResults();

  // E3b: the API-cost line for the setup as restored.
  drUpdateApiBudget();
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
      dupRules:    eid('drChkDupRules')?.checked ?? true,
      orgSettings: eid('drChkOrgSettings')?.checked ?? true
    }
  };
  _drSavedSetup = setup;
  try { chrome.storage.local.set({ [DR_STATE_KEY]: setup }); } catch (_) { /* storage unavailable — setup just won't persist */ }
  // E3b: every setup change funnels through here — orgs, object selection,
  // check toggles all change what a run costs, so re-quote it.
  drUpdateApiBudget();
}

// Expand/collapse wiring for every result-card header — shared by the
// fresh-run and cache-restore paths so neither can regress alone. The header
// stays a <div role="button" tabindex="0"> (a real <button> would drag in UA
// styles the .dr-obj-card-hdr rules never reset), so the button contract is
// kept by hand: Enter AND Space activate, Space without scrolling the pane,
// and aria-expanded tracks the open class — the cached innerHTML can be
// serialised in either state, so the attribute is re-synced at wire time.
function drWireObjCardHeaders(rootEl) {
  if (!rootEl) return;
  rootEl.querySelectorAll('.dr-obj-card-hdr').forEach(hdr => {
    const card = hdr.closest('.dr-obj-card');
    if (!card) return;
    const sync = () => hdr.setAttribute('aria-expanded',
      card.classList.contains('dr-obj-card-open') ? 'true' : 'false');
    const toggle = () => { card.classList.toggle('dr-obj-card-open'); sync(); };
    sync();
    hdr.addEventListener('click', toggle);
    hdr.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggle();
    });
  });
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
  drWireObjCardHeaders(resultsEl);
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
  const chkOrgSettings = eid('drChkOrgSettings')?.checked ?? true;   // T11c

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

  // T11c: the SOURCE org's configuration is probed once for the whole run —
  // it is the same org for every target. A failure here is not fatal: the
  // flags stay null and every setting renders as INCONCLUSIVE.
  let srcFlags = null;
  if (chkOrgSettings) {
    setDrStatus('⏳ Reading org settings from the source…');
    const progEl = eid('drProgressText');
    if (progEl) progEl.textContent = `${orgLabel(srcId)} — reading org settings…`;
    try {
      srcFlags = await drProbeOrgSettings(srcSess, orgLabel(srcId));
    } catch (e) {
      srcFlags = { label: orgLabel(srcId), stateCountry: null, personAccounts: null,
                   multiCurrency: null, acm: null, probeError: e.message || String(e) };
    }
  }

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

    // ── T11c: ORG SETTINGS — once per target, BEFORE the object cards ──
    // Org configuration is not a per-object property, so it gets its own
    // panel and its own badge in this target's summary. It is never folded
    // into the object counts (that would misreport how many objects ran).
    let orgSetSev = null;
    if (chkOrgSettings) {
      setDrStatus(`⏳ ${tgtLabel}: reading org settings…`);
      const progEl = eid('drProgressText');
      if (progEl) progEl.textContent = `${tgtLabel} — reading org settings…`;
      let tgtFlags;
      try {
        tgtFlags = await drProbeOrgSettings(tgtSess, tgtLabel);
      } catch (e) {
        tgtFlags = { label: tgtLabel, stateCountry: null, personAccounts: null,
                     multiCurrency: null, acm: null, probeError: e.message || String(e) };
      }
      const rows = drOrgSettingDiffs(srcFlags, tgtFlags);
      orgSetSev = drOrgSettingsSeverity(rows);
      if (cardsEl) cardsEl.insertAdjacentHTML('beforebegin', renderOrgSettingsPanel(rows, {
        srcLabel: orgLabel(srcId),
        tgtLabel,
        srcErr: srcFlags?.probeError || null,
        tgtErr: tgtFlags?.probeError || null,
        recordTypesChecked: chkRecordTypes
      }));
    }

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
       ${orgSetSev === 'critical' ? '<span class="dr-sum-badge dr-sum-crit">🔴 org settings</span>'
         : orgSetSev === 'warning' ? '<span class="dr-sum-badge dr-sum-warn">🟡 org settings</span>'
         : orgSetSev === 'ok' ? '<span class="dr-sum-badge dr-sum-ok">✅ org settings</span>' : ''}
       <span style="color:var(--subtext);font-size:11px">${total} object(s) checked${orgSetSev === null ? ' · org settings NOT checked' : ''}</span>`;
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
  drWireObjCardHeaders(resultsEl);
}

// ════════════════════════════════════════════════════════════════
// T11c — ORG-CONFIGURATION differences as first-class findings
// ════════════════════════════════════════════════════════════════
// Why this exists: a real run failed because the TARGET had State and
// Country picklists ON while the SOURCE had them OFF. Every per-object
// check passed — BillingState existed on both sides — and the load still
// died on "Please select a state from the list of valid states". Field
// parity is not org parity. These checks run ONCE per target, before the
// object cards, and compare the two orgs' CONFIGURATION.
//
// SEVERITY CALIBRATION (kept consistent on purpose):
//   🔴 critical — the difference makes the target REJECT writes the source
//                 produces, or silently reinterprets their meaning.
//   🟡 warning  — the data still lands, but something is lost, defaulted,
//                 or only breaks if a specific field is in the mapping
//                 (and that field is already listed per object as missing).
//   ❔ unknown  — the probe could not tell. Reported as INCONCLUSIVE, never
//                 folded into "ok" (silent success is the cardinal sin).

// PURE. Takes two plain flag objects (see drProbeOrgSettings for the shape)
// and returns one row per setting:
//   { key, label, src, tgt, consequence, severity, srcHow, tgtHow }
// Matching settings are returned too (severity 'ok') so the panel can show
// what was checked and found equal — a check you can't see didn't happen.
// Org display names come from srcFlags.label / tgtFlags.label; they end up
// inside `consequence`, so the RENDERER must esc() the whole string.
function drOrgSettingDiffs(srcFlags, tgtFlags) {
  const S = srcFlags || {};
  const T = tgtFlags || {};
  const srcName = S.label || 'the source';
  const tgtName = T.label || 'the target';
  const RULES = [
    {
      key: 'stateCountry',
      label: 'State & Country picklists',
      // ON in source, OFF in target
      onOff: {
        severity: 'warning',
        text: `State & Country picklists are ON in ${srcName} but OFF in ${tgtName} — the state/country TEXT values still load (${tgtName} accepts free text), but ${srcName}'s BillingStateCode / BillingCountryCode fields (and the Shipping, Mailing and Other equivalents) do not exist in ${tgtName}, so any mapping that includes them fails with INVALID_FIELD. Those fields are listed per object under "Missing fields" below.`
      },
      // OFF in source, ON in target — the failure that prompted this check
      offOn: {
        severity: 'critical',
        text: `State & Country picklists are ON in ${tgtName} but OFF in ${srcName} — state/country values written from ${srcName} will be REJECTED unless they exactly match ${tgtName}'s valid state/country labels, and a country/territory must be set on the record before a state value is accepted. Free-text values like "TX" fail with "Please select a state from the list of valid states".`
      }
    },
    {
      key: 'personAccounts',
      label: 'Person Accounts',
      onOff: {
        severity: 'critical',
        text: `Person Accounts are ON in ${srcName} but OFF in ${tgtName} — ${tgtName} has no person-account record type and no person fields (FirstName, LastName, PersonEmail, PersonMailingStreet, …), so every person-account row copied from ${srcName} will be REJECTED. Only business accounts can load into ${tgtName}.`
      },
      offOn: {
        severity: 'warning',
        text: `Person Accounts are ON in ${tgtName} but OFF in ${srcName} — business accounts still load, but ${tgtName} adds person-account record types plus IsPersonAccount and Person* fields that ${srcName} has no data for. Leaving RecordTypeId unmapped lets ${tgtName} pick its default record type, which may be the person-account one.`
      }
    },
    {
      key: 'multiCurrency',
      label: 'Multi-currency',
      onOff: {
        severity: 'critical',
        text: `Multi-currency is ON in ${srcName} but OFF in ${tgtName} — CurrencyIsoCode does not exist in ${tgtName}, so writing it is REJECTED, and every amount lands in ${tgtName}'s single corporate currency with NO conversion: an amount recorded in one currency in ${srcName} becomes the same NUMBER in a different currency in ${tgtName}.`
      },
      offOn: {
        severity: 'warning',
        text: `Multi-currency is ON in ${tgtName} but OFF in ${srcName} — inserts still succeed, but every row loaded without an explicit CurrencyIsoCode takes ${tgtName}'s corporate currency and amounts are NOT converted. Map CurrencyIsoCode explicitly if ${srcName}'s amounts are not already in that currency.`
      }
    },
    {
      key: 'acm',
      label: 'Advanced Currency Management (dated exchange rates)',
      onOff: {
        severity: 'warning',
        text: `Advanced Currency Management is ON in ${srcName} but OFF in ${tgtName} — ${tgtName} converts every amount at the current static rate instead of the rate dated to the record, so historical Opportunity converted amounts will not match ${srcName}.`
      },
      offOn: {
        severity: 'warning',
        text: `Advanced Currency Management is ON in ${tgtName} but OFF in ${srcName} — ${tgtName} converts Opportunity amounts using dated exchange rates keyed to CloseDate. Rows loaded with a CloseDate outside ${tgtName}'s dated-rate ranges fall back to the static rate, so converted amounts can differ from ${srcName}.`
      }
    }
  ];
  const show = v => (v === true ? 'On' : v === false ? 'Off' : 'Unknown');
  const out = [];
  for (const r of RULES) {
    const sv = S[r.key];
    const tv = T[r.key];
    const sKnown = sv === true || sv === false;
    const tKnown = tv === true || tv === false;
    const row = {
      key:    r.key,
      label:  r.label,
      src:    show(sv),
      tgt:    show(tv),
      srcHow: S[r.key + 'How'] || '',
      tgtHow: T[r.key + 'How'] || '',
      consequence: '',
      severity:    'ok'
    };
    if (!sKnown || !tKnown) {
      const who = (!sKnown && !tKnown) ? `${srcName} or ${tgtName}` : (!sKnown ? srcName : tgtName);
      row.severity = 'unknown';
      row.consequence = `Could NOT be determined in ${who} — this check is INCONCLUSIVE, not clean. Confirm "${r.label}" in that org's Setup yourself before loading data.`;
    } else if (sv === tv) {
      row.consequence = `Same in both orgs (${show(sv)}) — nothing to reconcile for this setting.`;
    } else if (sv === true) {
      row.severity    = r.onOff.severity;
      row.consequence = r.onOff.text;
    } else {
      row.severity    = r.offOn.severity;
      row.consequence = r.offOn.text;
    }
    out.push(row);
  }
  return out;
}

// PURE. Roll a drOrgSettingDiffs() row list up to one severity for the
// target's summary badge. 'unknown' counts as a warning — an inconclusive
// check must never read as a clean one.
function drOrgSettingsSeverity(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.some(r => r && r.severity === 'critical')) return 'critical';
  if (list.some(r => r && (r.severity === 'warning' || r.severity === 'unknown'))) return 'warning';
  return 'ok';
}

// IMPURE probe — kept deliberately separate from drOrgSettingDiffs.
// Everything is derived from the DESCRIBE API (no Tooling, no Setup pages)
// so it works with the read-only permissions this view already promises,
// and each flag carries a `<key>How` string saying exactly how it was
// decided so the UI can show its own evidence.
// Returns { label, stateCountry, personAccounts, multiCurrency, acm,
//           <key>How…, probeError } where each flag is true | false | null
// (null = could not tell → rendered as INCONCLUSIVE).
async function drProbeOrgSettings(sess, label) {
  const flags = {
    label: label || '',
    stateCountry: null,   stateCountryHow:   '',
    personAccounts: null, personAccountsHow: '',
    multiCurrency: null,  multiCurrencyHow:  '',
    acm: null,            acmHow:            '',
    probeError: null
  };
  if (!sess) { flags.probeError = 'no session for this org'; return flags; }

  // Account is the probe object: it is the one standard object that carries
  // all three signals (Billing*Code, IsPersonAccount, CurrencyIsoCode).
  // DatedConversionRate only exists when Advanced Currency Management is on,
  // so a 404 there is an expected answer, not an error → _silentError.
  const [accRes, acmRes] = await Promise.all([
    sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
             path: 'services/data/v62.0/sobjects/Account/describe' }),
    sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid, _silentError: true,
             path: 'services/data/v62.0/sobjects/DatedConversionRate/describe' })
  ]);

  if (!accRes || accRes.error) {
    if (accRes && typeof isSessionResult === 'function' && isSessionResult(accRes)
        && typeof showSessionBanner === 'function') showSessionBanner(sess.orgUrl);
    flags.probeError = (accRes && accRes.error) || 'no response';
    return flags;   // every flag stays null → every row renders as inconclusive
  }

  const byName = {};
  (accRes.fields || []).forEach(f => { byName[f.name] = f; });

  // ── State & Country picklists ───────────────────────────────
  // The *Code companion fields only exist when the picklists are enabled —
  // that is the strongest describe-level signal, so it is tried first.
  const codeField = byName.BillingStateCode || byName.BillingCountryCode;
  const billState = byName.BillingState;
  if (codeField) {
    flags.stateCountry = true;
    flags.stateCountryHow = `Account.${codeField.name} (type ${codeField.type}) is present — the Code companion fields only exist when the picklists are enabled`;
  } else if (billState && (billState.picklistValues || []).length) {
    flags.stateCountry = true;
    flags.stateCountryHow = `Account.BillingState returns ${billState.picklistValues.length} picklist value(s)`;
  } else if (billState) {
    flags.stateCountry = false;
    flags.stateCountryHow = 'Account.BillingState is free text and there is no Account.BillingStateCode / BillingCountryCode field';
  } else {
    flags.stateCountryHow = 'Account.BillingState is not in the describe for your user — could not tell';
  }

  // ── Person Accounts ─────────────────────────────────────────
  if (byName.IsPersonAccount) {
    flags.personAccounts = true;
    flags.personAccountsHow = 'Account.IsPersonAccount is present';
  } else {
    flags.personAccounts = false;
    flags.personAccountsHow = 'Account.IsPersonAccount is absent';
  }

  // ── Multi-currency ──────────────────────────────────────────
  if (byName.CurrencyIsoCode) {
    flags.multiCurrency = true;
    flags.multiCurrencyHow = 'Account.CurrencyIsoCode is present — Salesforce adds it to every object when multi-currency is enabled';
  } else {
    flags.multiCurrency = false;
    flags.multiCurrencyHow = 'Account.CurrencyIsoCode is absent';
  }

  // ── Advanced Currency Management ────────────────────────────
  if (flags.multiCurrency === false) {
    flags.acm = false;
    flags.acmHow = 'multi-currency is off, so dated exchange rates cannot be enabled';
  } else if (acmRes && !acmRes.error) {
    flags.acm = true;
    flags.acmHow = 'the DatedConversionRate object is describable in this org';
  } else if (acmRes && /not_found|404|does not exist|invalid.*sobject|no such/i.test(String(acmRes.error))) {
    flags.acm = false;
    flags.acmHow = 'the DatedConversionRate object does not exist — it is only created when Advanced Currency Management is on';
  } else {
    // A non-404 failure is NOT evidence of "off". Say so rather than guess.
    flags.acm = null;
    flags.acmHow = `the DatedConversionRate probe failed for another reason (${(acmRes && acmRes.error) || 'no response'}) — could not tell`;
  }

  return flags;
}

// Render the per-target "Org settings" panel. Sits above that target's
// object cards. ctx = { srcLabel, tgtLabel, srcErr, tgtErr, recordTypesChecked }.
function renderOrgSettingsPanel(rows, ctx) {
  const c    = ctx || {};
  const list = Array.isArray(rows) ? rows : [];
  const sev  = drOrgSettingsSeverity(list);
  const icon = sev === 'critical' ? '🔴' : sev === 'warning' ? '🟡' : '✅';
  const sevClass = sev === 'critical' ? 'dr-sev-critical' : sev === 'warning' ? 'dr-sev-warning' : 'dr-sev-ok';
  const sL = esc(c.srcLabel || 'source');
  const tL = esc(c.tgtLabel || 'target');

  let body = '';

  // Probe failures first — louder than any finding below them.
  if (c.srcErr) body += `<div class="dr-issue-row dr-issue-warn" style="display:block;padding:9px 14px;line-height:1.5">⚠ The Account describe could NOT be read from <strong>${sL}</strong> (${esc(c.srcErr)}) — every setting below is INCONCLUSIVE for that org, not clean.</div>`;
  if (c.tgtErr) body += `<div class="dr-issue-row dr-issue-warn" style="display:block;padding:9px 14px;line-height:1.5">⚠ The Account describe could NOT be read from <strong>${tL}</strong> (${esc(c.tgtErr)}) — every setting below is INCONCLUSIVE for that org, not clean.</div>`;

  const diffs = list.filter(r => r.severity === 'critical' || r.severity === 'warning');
  const unk   = list.filter(r => r.severity === 'unknown');
  const same  = list.filter(r => r.severity === 'ok');

  if (diffs.length) body += `<div class="dr-section-hdr ${sev === 'critical' ? 'dr-section-crit' : 'dr-section-warn'}">${sev === 'critical' ? '🔴' : '🟡'} Org configuration differs (${diffs.length}) — this is not a field problem, it is a SETUP problem</div>`;

  const rowHtml = r => {
    const ic  = r.severity === 'critical' ? '🔴' : r.severity === 'warning' ? '🟡' : r.severity === 'unknown' ? '❔' : '✅';
    const cls = r.severity === 'critical' ? 'dr-issue-crit' : r.severity === 'ok' ? '' : 'dr-issue-warn';
    // Target chip is coloured only when it is the side that differs / is unknown.
    const tgtStyle = r.severity === 'critical' ? 'background:#FEE2E2;color:#B91C1C'
      : r.severity === 'warning' ? 'background:#FEF3C7;color:#92400E'
      : r.severity === 'unknown' ? 'background:#F3F4F6;color:#6B7280' : '';
    const srcStyle = r.src === 'Unknown' ? 'background:#F3F4F6;color:#6B7280' : '';
    const how = (r.srcHow || r.tgtHow)
      ? `<div style="margin-top:4px;font-size:11px;color:var(--subtext);line-height:1.45">🔍 Detected from the Describe API — ${sL}: ${esc(r.srcHow || 'no detail')} · ${tL}: ${esc(r.tgtHow || 'no detail')}</div>`
      : '';
    return `<div class="dr-issue-row ${cls}" style="display:block;padding:9px 14px">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:13px">${ic}</span>
          <span class="dr-field-api">${esc(r.label)}</span>
          <span class="dr-field-type" style="${srcStyle}">${sL}: ${esc(r.src)}</span>
          <span style="color:var(--subtext);font-size:11px">vs</span>
          <span class="dr-field-type" style="${tgtStyle}">${tL}: ${esc(r.tgt)}</span>
          ${r.severity === 'critical' ? '<span class="dr-badge-crit">CAN REJECT WRITES</span>' : ''}
        </div>
        <div style="margin-top:5px;font-size:12px;line-height:1.5">${esc(r.consequence)}</div>
        ${how}
      </div>`;
  };

  body += diffs.map(rowHtml).join('');
  if (unk.length) {
    body += `<div class="dr-section-hdr dr-section-warn">❔ Could not be determined (${unk.length}) — inconclusive, not clean</div>`;
    body += unk.map(rowHtml).join('');
  }
  if (same.length) {
    body += `<div class="dr-section-hdr" style="background:var(--brand-bg);color:var(--brand-dark);border-top:1px solid var(--border)">✅ Same in both orgs (${same.length}) — checked, no action</div>`;
    body += same.map(rowHtml).join('');
  }

  // Record types are already compared per object — reference, don't duplicate.
  body += `<div class="dr-issue-row" style="display:block;padding:9px 14px;font-size:11.5px;line-height:1.5">
      📋 <strong>Record types</strong> are compared per object, not here — see each object card's “Record types in source missing from target” section below.${
        c.recordTypesChecked === false ? ` <strong style="color:#92400E">The record-type check is switched OFF for this run</strong>, so no object below reports record-type gaps.` : ''}
    </div>`;

  // Honesty footer: what this panel can get wrong, and what it does not look at.
  body += `<div class="dr-issue-row" style="display:block;padding:9px 14px;font-size:11px;color:var(--subtext);line-height:1.5">
      ℹ Detection is describe-based and reflects what <em>your</em> user can see in each org — a field hidden by field-level security or a permission set can make a setting look Off. Not checked here: Shield Platform Encryption, Territory Management, org-wide sharing defaults, Locale/currency formatting, and managed-package configuration.
    </div>`;

  const nCrit = list.filter(r => r.severity === 'critical').length;
  const nWarn = list.filter(r => r.severity === 'warning').length;
  const nUnk  = unk.length;
  const chips = [
    nCrit ? `<span class="dr-chip dr-chip-crit">${nCrit} blocking</span>` : '',
    nWarn ? `<span class="dr-chip dr-chip-warn">${nWarn} differ</span>` : '',
    nUnk  ? `<span class="dr-chip dr-chip-warn">${nUnk} unknown</span>` : ''
  ].join('');

  return `<div class="dr-obj-card ${sevClass} dr-obj-card-open" style="margin-bottom:8px">
      <div class="dr-obj-card-hdr" role="button" tabindex="0" aria-expanded="true">
        <span class="dr-obj-sev">${icon}</span>
        <span class="dr-obj-name">⚙ Org settings — ${sL} vs ${tL}</span>
        <div class="dr-obj-chips">${chips}</div>
        <span class="dr-obj-chevron">›</span>
      </div>
      <div class="dr-obj-card-body">${body}</div>
    </div>`;
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
      <div class="dr-obj-card-hdr ${sevClass}" role="button" tabindex="0" aria-expanded="${isDefaultOpen ? 'true' : 'false'}">
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

// ════════════════════════════════════════════════════════════════
// E3b — API-budget awareness for the multi-target run
// ════════════════════════════════════════════════════════════════
// The run's call profile, counted from runReadinessCheck/analyseObject as
// they actually execute (not from what the toggles *sound* like they cost):
//   per target per object — 1 source describe + 1 target describe
//                           + 1 target Tooling query  (validation rules ON)
//                           + 1 target SOQL query      (duplicate rules ON)
//   per target            — 2 target describes         (org settings ON)
//   once per run          — 2 source describes         (org settings ON)
// Fields / picklists / record types ride on the describes and cost nothing
// extra. NOT counted: the one-off object-list load and session refreshes —
// hence the '≈'. Each org spends its OWN daily pool, so the result is split:
// `source` is the source org's spend, `perTarget` is what EACH target spends.

// PURE. targets/objects are counts; checks = { validation, dupRules,
// orgSettings } booleans (absent = true, matching the UI defaults).
function drEstimateReadinessCalls(targets, objects, checks) {
  const t = Math.max(0, Math.floor(Number(targets) || 0));
  const o = Math.max(0, Math.floor(Number(objects) || 0));
  const c = checks || {};
  const val = c.validation  !== false ? 1 : 0;
  const dup = c.dupRules    !== false ? 1 : 0;
  const set = c.orgSettings !== false ? 2 : 0;
  const source    = t * o + (t > 0 ? set : 0);
  const perTarget = o * (1 + val + dup) + set;
  return { total: source + t * perTarget, source, perTarget, targets: t, objects: o };
}

// PURE. The one-line cost display. est: drEstimateReadinessCalls output.
// budgets: [{ label, budget, calls }] where budget is { max, remaining } |
// null — null means the meter could NOT be read, which is SAID ("API budget
// unavailable"), never hidden. An empty budgets array renders the bare
// estimate (the shared window.sftkApiBudget helper wasn't there / hasn't
// answered). Each entry is labeled with WHOSE pool it is — pools are never
// summed, because every org has its own daily limit. warn flips when any
// org's estimated calls EXCEED its remaining budget (equal is not over);
// this line informs, it never blocks.
function drReadinessBudgetLine(est, budgets) {
  const fmt = v => Number(v).toLocaleString();
  const e = est || {};
  const total = Number.isFinite(e.total) ? e.total : 0;
  const parts = [
    `≈${fmt(total)} API call${total === 1 ? '' : 's'} ` +
    `(${fmt(e.targets || 0)} target${e.targets === 1 ? '' : 's'} × ` +
    `${fmt(e.objects || 0)} object${e.objects === 1 ? '' : 's'})`
  ];
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

// Last-render-wins token for the async meter fetch below.
let _drBudgetToken = 0;

// Paint the cost line under the Run button. The local estimate renders
// synchronously and needs no helper; the per-org meters are appended only
// when the shared E3 reader (window.sftkApiBudget, studio-transfer.js) is
// loaded and answers — wired tolerantly so this view stands alone.
async function drUpdateApiBudget() {
  const el = eid('drApiBudget');
  if (!el) return;
  const ring   = _drRingCfg();
  const srcId  = ring ? ring.src : (eid('drSrcOrg')?.value || '');
  const tgtIds = ring
    ? ring.targets.filter(u => !_drTgtSel || _drTgtSel.has(_orgKey(u)))
    : [eid('drTgtOrg')?.value].filter(Boolean);
  // No objects loaded yet → no honest N to show (the count appears when the
  // source org's object list lands; runReadinessCheck loads it anyway).
  const objCount = (_drObjState.objects && _drObjState.srcId === srcId)
    ? _drObjState.selected.size : null;
  if (!srcId || !tgtIds.length || !objCount) { el.textContent = ''; return; }

  const est = drEstimateReadinessCalls(tgtIds.length, objCount, {
    validation:  eid('drChkValidation')?.checked ?? true,
    dupRules:    eid('drChkDupRules')?.checked ?? true,
    orgSettings: eid('drChkOrgSettings')?.checked ?? true,
  });
  el.textContent = drReadinessBudgetLine(est, []).text;   // estimate now, meters next
  el.style.color = '';
  if (typeof window.sftkApiBudget !== 'function') return;

  const tok = ++_drBudgetToken;
  // Every org in the run gets ITS OWN labeled meter: the source spends the
  // describes, each target spends its checks — different pools, never summed.
  const wanted = [
    { id: srcId, tag: 'source', calls: est.source },
    ...tgtIds.map(u => ({ id: u, tag: 'target', calls: est.perTarget })),
  ];
  const budgets = await Promise.all(wanted.map(async w => {
    let budget = null;
    try {
      const sess = await getOrgSession(w.id);
      budget = sess ? await window.sftkApiBudget(sess.orgUrl, sess.sid) : null;
    } catch (_) { budget = null; }   // unreadable meter → said as unavailable
    return { label: `${w.tag} ${orgLabel(w.id)}`, budget, calls: w.calls };
  }));
  if (tok !== _drBudgetToken) return;                     // a newer render won
  const el2 = eid('drApiBudget');
  if (!el2) return;
  const line = drReadinessBudgetLine(est, budgets);
  el2.textContent = line.text;
  el2.style.color = line.warn ? '#b45309' : '';
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

