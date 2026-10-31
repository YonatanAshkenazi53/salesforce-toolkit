'use strict';
// ════════════════════════════════════════════════════════════════
// ORG COMPARE (org-wide data diff across many objects)
// ════════════════════════════════════════════════════════════════
// Pick a source + target org from open Chrome tabs, pick which objects to
// compare, then run a parallel diff across all of them. Result is a
// scorecard table sorted by worst drift first. Click a row → opens
// Transfer scoped to that object via an ephemeral profile.

// Curated standard objects worth comparing by default. Customs (suffix __c)
// are auto-added. Audit/junk objects are NOT included by default; user can
// always tick them in the picker.
const _OC_KEY_STANDARDS = [
  'Account', 'Contact', 'Lead', 'Opportunity', 'OpportunityLineItem',
  'Case', 'CaseComment', 'Campaign', 'CampaignMember',
  'Product2', 'Pricebook2', 'PricebookEntry', 'Quote', 'QuoteLineItem',
  'Order', 'OrderItem', 'Asset', 'Contract', 'ContractLineItem',
  'Task', 'Event'
];

let _orgCompareState = {
  srcOrgUrl:        '',
  tgtOrgUrl:        '',
  availableObjects: null,   // [{ name, label, custom }] from describeGlobal
  selectedObjects:  null,   // Set<string> — null = use default
  results:          null,   // [{ name, srcCount, tgtCount, matched, missing, extras, matchField, error? }]
  running:          false,
  lastRunAt:        null,
  // Match strategy — how Org Compare keys records across orgs:
  //   'auto'   = nameField → Name → Id-only (legacy default)
  //   'extid'  = externalId=true field per object (Salesforce's intended
  //              cross-org identity); fall back to 'auto' if none exists
  //   'custom' = user-supplied field name (e.g. 'External_Ref__c'); fall
  //              back to 'auto' if absent on a given object
  matchStrategy:    'auto',
  customMatchField: '',
};

async function renderOrgCompare() {
  // Default to the working pair, falling back to the current tab's org.
  if (!_orgCompareState.srcOrgUrl) _orgCompareState.srcOrgUrl = _workingPair.src || _orgUrl || '';
  if (!_orgCompareState.tgtOrgUrl && _workingPair.tgt) _orgCompareState.tgtOrgUrl = _workingPair.tgt;

  // All known orgs (remembered + live), like every other picker — a closed
  // org is pickable and produces the standard "open it in a tab" error at
  // run time instead of silently missing from the list.
  const _ocLs = _liveOrgSet();
  const orgOptions = allMapOrgs().map(o =>
    `<option value="${esc(o.url)}">${esc(orgOptionLabel(o.url, o.label, _ocLs))}</option>`
  ).join('');

  setMain(`
    ${dsViewHeader({
      // 'search' is this view's sidebar glyph (studio.html data-view="compare"),
      // so the header tile and the nav row read as the same place.
      icon: 'search',
      title: 'Org Compare',
      subtitle: 'Diff record counts across many objects between two orgs — find what changed at a glance',
    })}

    <div style="background:#E8F4FD;border:1px solid #C5DBF0;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:12px;color:#014486;max-width:920px">
      <strong>Read-only.</strong> Org Compare queries record counts and which records exist in each org.
      Pick a match strategy below — <strong>External Id</strong> is the most reliable across orgs, <strong>Name</strong> is the loose default.
      Click any row in the result table to open <strong>Transfer</strong> scoped to that object — that's where you can actually insert/update/delete.
    </div>

    <div class="ds-oc-config">
      <div class="ds-field-group">
        <label class="ds-lbl">Source org</label>
        <select id="dsOCSrc" class="ds-select">
          <option value="">— Select source —</option>${orgOptions}
        </select>
      </div>
      <span class="ds-transfer-arrow" style="margin-top:22px">→</span>
      <div class="ds-field-group">
        <label class="ds-lbl">Target org</label>
        <select id="dsOCTgt" class="ds-select">
          <option value="">— Select target —</option>${orgOptions}
        </select>
      </div>
      <button class="ds-btn ds-btn-primary ds-btn-lg" id="dsOCRun" disabled style="margin-top:18px">▶ Compare</button>
    </div>

    <!-- Match strategy — how records are keyed across orgs. -->
    <div class="ds-oc-strategy">
      <div class="ds-field-group">
        <label class="ds-lbl" title="How to decide if two records in different orgs represent the same thing">Match by</label>
        <select id="dsOCStrategy" class="ds-select">
          <option value="auto"   ${_orgCompareState.matchStrategy === 'auto'   ? 'selected' : ''}>Auto (Name / nameField) — loose</option>
          <option value="extid"  ${_orgCompareState.matchStrategy === 'extid'  ? 'selected' : ''}>External Id (auto-detect per object) — reliable</option>
          <option value="custom" ${_orgCompareState.matchStrategy === 'custom' ? 'selected' : ''}>Custom field name…</option>
        </select>
      </div>
      <div class="ds-field-group" id="dsOCCustomWrap"
        style="${_orgCompareState.matchStrategy === 'custom' ? '' : 'display:none'}">
        <label class="ds-lbl" title="Field API name tried on every selected object. Falls back to Auto if the field doesn't exist there.">Custom field API name</label>
        <input type="text" id="dsOCCustomField" class="ds-input"
          placeholder="e.g. External_Ref__c"
          value="${esc(_orgCompareState.customMatchField || '')}">
      </div>
      <div class="ds-oc-strategy-hint" id="dsOCStrategyHint"></div>
    </div>

    <details id="dsOCObjects" class="ds-oc-objects-panel" style="margin:14px 0">
      <summary class="ds-oc-objects-sum"><strong>Objects to compare</strong>
        <span class="ds-oc-sub" id="dsOCObjCount">— choose orgs first —</span>
      </summary>
      <div id="dsOCObjList" class="ds-oc-obj-list"></div>
    </details>

    <div id="dsOCResults"></div>
  `);

  // Restore prior org choices
  const srcSel = eid('dsOCSrc'), tgtSel = eid('dsOCTgt');
  if (srcSel && _orgCompareState.srcOrgUrl) srcSel.value = _orgCompareState.srcOrgUrl;
  if (tgtSel && _orgCompareState.tgtOrgUrl) tgtSel.value = _orgCompareState.tgtOrgUrl;

  function updateRunBtn() {
    const btn = eid('dsOCRun');
    if (!btn) return;
    const s = srcSel?.value, t = tgtSel?.value;
    btn.disabled = !s || !t || s === t || _orgCompareState.running;
  }
  updateRunBtn();

  srcSel?.addEventListener('change', () => {
    _orgCompareState.srcOrgUrl = srcSel.value;
    _orgCompareState.availableObjects = null;
    _orgCompareState.selectedObjects = null;
    _ocRefreshObjectList();
    updateRunBtn();
  });
  tgtSel?.addEventListener('change', () => {
    _orgCompareState.tgtOrgUrl = tgtSel.value;
    updateRunBtn();
  });

  // Match strategy + custom field input
  const stratSel  = eid('dsOCStrategy');
  const customWrp = eid('dsOCCustomWrap');
  const customInp = eid('dsOCCustomField');
  const hintEl    = eid('dsOCStrategyHint');
  function paintStrategyHint() {
    if (!hintEl) return;
    const s = _orgCompareState.matchStrategy;
    if (s === 'auto') {
      hintEl.textContent = 'Loose: two records with the same Name are treated as the same record. Works for most standard objects but can false-match common names.';
    } else if (s === 'extid') {
      hintEl.textContent = 'For each object, Org Compare picks the first field marked External Id in describe. Objects with no external Id fall back to Auto so you still get a row.';
    } else {
      hintEl.textContent = 'Tries the field name you typed (case-sensitive API name) on every selected object. Objects that don\'t have it fall back to Auto.';
    }
  }
  paintStrategyHint();
  stratSel?.addEventListener('change', () => {
    _orgCompareState.matchStrategy = stratSel.value;
    if (customWrp) customWrp.style.display = stratSel.value === 'custom' ? '' : 'none';
    paintStrategyHint();
  });
  customInp?.addEventListener('input', () => {
    _orgCompareState.customMatchField = customInp.value.trim();
  });

  eid('dsOCRun')?.addEventListener('click', runOrgCompare);

  // Load the object list if we already have a source picked.
  if (_orgCompareState.srcOrgUrl) _ocRefreshObjectList();

  // Re-render any prior results
  if (_orgCompareState.results) _ocRenderResults();
}

// Discover queryable objects on the source org (describeGlobal) and render
// the multi-select. Defaults: every __c + curated standards (_OC_KEY_STANDARDS).
async function _ocRefreshObjectList() {
  const listEl = eid('dsOCObjList');
  const countEl = eid('dsOCObjCount');
  if (!listEl) return;
  if (!_orgCompareState.srcOrgUrl) {
    listEl.innerHTML = '<div class="ds-oc-empty">Pick a source org to load its object list.</div>';
    if (countEl) countEl.textContent = '— choose orgs first —';
    return;
  }
  const sess = _buildAllSessions().find(s => s.orgUrl === _orgCompareState.srcOrgUrl);
  if (!sess?.sid) {
    listEl.innerHTML = '<div class="ds-oc-empty">Source org not active — open it in Chrome.</div>';
    return;
  }

  if (!_orgCompareState.availableObjects) {
    listEl.innerHTML = '<div class="ds-oc-empty">Loading object list…</div>';
    try {
      const res = await sendBg({
        type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
        path: `services/data/${'v62.0'}/sobjects`
      });
      const objs = (res?.sobjects || [])
        .filter(o => o.queryable && o.createable && !o.deprecatedAndHidden)
        .map(o => ({ name: o.name, label: o.label || o.name, custom: !!o.custom }))
        .sort((a, b) => a.label.localeCompare(b.label));
      _orgCompareState.availableObjects = objs;
    } catch (e) {
      const fe = sftkFriendlyError(e?.message || e);
      listEl.innerHTML = `<div class="ds-oc-empty" title="${esc(fe.raw)}">Failed to load objects: ${esc(fe.message)}${fe.hint ? ` — ${esc(fe.hint)}` : ''}</div>`;
      return;
    }
  }

  // Seed defaults on first load: every __c + curated key standards.
  if (!_orgCompareState.selectedObjects) {
    const defaults = new Set(_OC_KEY_STANDARDS);
    for (const o of _orgCompareState.availableObjects) if (o.custom) defaults.add(o.name);
    _orgCompareState.selectedObjects = defaults;
  }

  const sel = _orgCompareState.selectedObjects;
  const rows = _orgCompareState.availableObjects.map(o => `
    <label class="ds-oc-obj-row${o.custom ? ' ds-oc-obj-custom' : ''}">
      <input type="checkbox" data-oc-obj="${esc(o.name)}" ${sel.has(o.name) ? 'checked' : ''}>
      <span class="ds-oc-obj-name">${esc(o.label)}</span>
      <span class="ds-oc-obj-api">${esc(o.name)}</span>
      ${o.custom ? '<span class="ds-oc-obj-tag">custom</span>' : ''}
    </label>`).join('');

  listEl.innerHTML = `
    <div class="ds-oc-list-actions">
      <button class="ds-btn ds-btn-xs" id="dsOCSelAll">✓ All</button>
      <button class="ds-btn ds-btn-xs" id="dsOCSelNone">✗ None</button>
      <button class="ds-btn ds-btn-xs" id="dsOCSelDefault">↺ Default (customs + key standards)</button>
      <input type="text" id="dsOCFilter" class="ds-input ds-input-sm" placeholder="Filter…" style="margin-left:auto;width:180px">
    </div>
    <div class="ds-oc-rows">${rows}</div>`;

  function syncCount() {
    if (countEl) countEl.textContent = `${sel.size} of ${_orgCompareState.availableObjects.length} selected`;
  }
  syncCount();
  listEl.querySelectorAll('[data-oc-obj]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) sel.add(cb.dataset.ocObj); else sel.delete(cb.dataset.ocObj);
      syncCount();
    });
  });
  eid('dsOCSelAll')?.addEventListener('click', () => {
    _orgCompareState.availableObjects.forEach(o => sel.add(o.name));
    _ocRefreshObjectList();
  });
  eid('dsOCSelNone')?.addEventListener('click', () => {
    sel.clear(); _ocRefreshObjectList();
  });
  eid('dsOCSelDefault')?.addEventListener('click', () => {
    sel.clear();
    for (const n of _OC_KEY_STANDARDS) sel.add(n);
    for (const o of _orgCompareState.availableObjects) if (o.custom) sel.add(o.name);
    _ocRefreshObjectList();
  });
  eid('dsOCFilter')?.addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    listEl.querySelectorAll('.ds-oc-obj-row').forEach(row => {
      const text = row.textContent.toLowerCase();
      row.style.display = text.includes(q) ? '' : 'none';
    });
  });
}

async function runOrgCompare() {
  const s = _orgCompareState.srcOrgUrl, t = _orgCompareState.tgtOrgUrl;
  const allSess = _buildAllSessions();
  const src = allSess.find(x => x.orgUrl === s);
  const tgt = allSess.find(x => x.orgUrl === t);
  if (!src?.sid || !tgt?.sid) {
    showToast('Both orgs must be open in Chrome', 'error', 4000);
    return;
  }
  const toRun = [...(_orgCompareState.selectedObjects || [])];
  if (!toRun.length) {
    showToast('Pick at least one object to compare', 'error', 3500);
    return;
  }

  const startedAt = new Date().toISOString();
  _orgCompareState.running = true;
  _orgCompareState.results = toRun.map(name => ({ name, status: 'pending' }));
  _ocRenderResults();
  const btn = eid('dsOCRun');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Comparing…'; }

  // Concurrency: 4 objects at a time to keep the popup responsive while
  // moving fast. Each compare does describe (cached) + 2 SOQL queries.
  const CONC = 4;
  let cursor = 0;
  async function worker() {
    while (cursor < toRun.length) {
      const idx = cursor++;
      const objName = toRun[idx];
      try {
        const r = await _ocCompareOneObject(objName, src, tgt);
        _orgCompareState.results[idx] = { name: objName, ...r };
      } catch (e) {
        _orgCompareState.results[idx] = { name: objName, error: e?.message || String(e) };
      }
      _ocRenderResults();
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, toRun.length) }, worker));

  _orgCompareState.running = false;
  _orgCompareState.lastRunAt = new Date().toISOString();
  if (btn) { btn.disabled = false; btn.textContent = '▶ Compare'; }
  _ocRenderResults();
  showToast(`Org Compare complete — ${toRun.length} object(s)`, 'success', 3500);

  // Log the finished run to shared History so Org Compare shows up alongside
  // transfers/reconciles. kind:'compare' — read-only, no records were touched.
  // Errors count as drift too: a red row means we could NOT prove the orgs
  // match, so the run isn't a clean 'success'.
  const finished = _orgCompareState.results || [];
  const anyDrift = finished.some(r =>
    r.error || (!r.skipped && (((r.missing || 0) > 0) || ((r.extras || 0) > 0))));
  _history.push({
    id:          genId('run'),
    kind:        'compare',
    profileName: `Org Compare: ${orgLabel(s)} vs ${orgLabel(t)}`,
    // Set BOTH the *OrgUrl and sourceOrg/targetOrg keys — History and the
    // Connected-Orgs counters read sourceOrg/targetOrg, health tiles read
    // *OrgUrl (same convention as transfer + reconcile entries).
    srcOrgUrl:   s,
    tgtOrgUrl:   t,
    sourceOrg:   s,
    targetOrg:   t,
    startedAt,
    completedAt: new Date().toISOString(),
    status:      anyDrift ? 'partial' : 'success',
    summary:     {},
    // what was compared, for 🧾 Activity (2026-10-31): read-only, so no counts of writes
    compare:     { objects: finished.length, drifted: finished.filter(r => r.error || (!r.skipped && (((r.missing || 0) > 0) || ((r.extras || 0) > 0)))).length, errors: finished.filter(r => r.error).length },
    errors:      []
  });
  await storageSaveHistory();
}

// Compare ONE object: describe (to pick matchField), parallel SOQL on both
// orgs, index by matchField value, count buckets. Presence-only (no drift)
// since Org Compare has no per-object field config — drift is the
// Transfer view's job, fed by a Profile.
// PURE. The match percentage of one object: matched out of (matched + missing).
// QA 2026-10-06 (live, both orgs): Account read "100%" with 7 missing and Contact
// "100%" with 6 missing — Math.round carried 99.93 up to a number that means
// "nothing is missing". It never says 100 while something is missing (99.9 at
// most), never 0 while something matched (0.1 at least); whole numbers otherwise.
function sftkOcMatchPct(matched, missing, extras) {
  const m = Number(matched) || 0, mi = Number(missing) || 0, ex = Number(extras) || 0;
  const denom = m + mi;
  if (denom <= 0) return ex === 0 ? 100 : 0;
  if (mi === 0) return 100;
  if (m === 0) return 0;
  const raw = m / denom * 100;
  if (raw >= 99.95) return 99.9;
  if (raw <= 0.05) return 0.1;
  const rounded = Math.round(raw);
  if (rounded === 100) return 99.9;
  if (rounded === 0) return 0.1;
  return rounded;
}
if (typeof globalThis !== 'undefined') globalThis.sftkOcMatchPct = sftkOcMatchPct;

async function _ocCompareOneObject(objName, srcSess, tgtSess) {
  // Pick matchField via describe. The match strategy is read from
  // _orgCompareState — see the matchStrategy state field for the three
  // options. We also gate on the describe's own `queryable` flag —
  // describeGlobal often reports queryable=true for Share/utility objects
  // that actually 400 on SELECT, but the per-object describe is reliable.
  const strategy   = _orgCompareState.matchStrategy   || 'auto';
  const customName = (_orgCompareState.customMatchField || '').trim();
  let matchField = null;       // null → Id-only key mode
  let queryable  = true;
  try {
    const d = await sendBg({
      type: 'SF_REST_GET', orgUrl: srcSess.orgUrl, sid: srcSess.sid,
      path: `services/data/v62.0/sobjects/${objName}/describe`
    });
    if (d && d.queryable === false) queryable = false;
    const fields = d?.fields || [];

    // Strategy: External Id. Prefer the first field with externalId=true.
    // If multiple, prefer one also marked idLookup (Salesforce's "this
    // can be used as the key in upsert/cross-org match" marker).
    if (strategy === 'extid') {
      const extIds = fields.filter(f => f.externalId === true);
      const idLook = extIds.find(f => f.idLookup === true);
      if (idLook?.name) matchField = idLook.name;
      else if (extIds[0]?.name) matchField = extIds[0].name;
    }

    // Strategy: Custom field name — only honors it if the field actually
    // exists on this sObject. Otherwise fall through to Auto below.
    if (strategy === 'custom' && customName) {
      if (fields.some(f => f.name === customName)) matchField = customName;
    }

    // Auto (and fallback for any strategy that didn't pick): nameField → Name.
    if (!matchField) {
      const nf = fields.find(f => f.nameField === true);
      if (nf?.name) matchField = nf.name;
      else if (fields.some(f => f.name === 'Name')) matchField = 'Name';
    }
  } catch (_) {/* push through with matchField = null */}

  if (!queryable) {
    return { skipped: true, reason: 'Object is not queryable.' };
  }

  // Build SOQL — when matchField is null/Id, ask for Id alone (no
  // `SELECT Id, Id` which Salesforce rejects as duplicate column).
  const useIdOnly = !matchField || matchField === 'Id';
  const soql = useIdOnly
    ? `SELECT Id FROM ${objName}`
    : `SELECT Id, ${matchField} FROM ${objName}`;
  const effectiveKey = useIdOnly ? 'Id' : matchField;

  const [srcRes, tgtRes] = await Promise.all([
    sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: srcSess.orgUrl, sid: srcSess.sid, query: soql }),
    sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, query: soql })
  ]);

  // Soft-skip the canonical "this sObject doesn't accept SOQL" failure —
  // it isn't actionable for the user and would otherwise dominate the
  // results table with red rows for internal Share/Localization objects.
  const isUnqueryable = msg =>
    typeof msg === 'string' &&
    /does not support query|not supported|INVALID_TYPE/i.test(msg);
  // Soft-skip the canonical "implementation restriction" objects too —
  // ContentDocumentLink / IdeaComment / etc. force a WHERE filter on a
  // specific Id and don't allow a blanket SELECT. Org Compare can't pass
  // those filters without per-object config, so we mark them skipped
  // rather than scolding the user with a red row.
  const isFilterRequired = msg =>
    typeof msg === 'string' &&
    /Implementation restriction|requires a filter by|must filter using/i.test(msg);
  if (srcRes?.error && (isUnqueryable(srcRes.error) || isFilterRequired(srcRes.error))) {
    return { skipped: true, reason: isFilterRequired(srcRes.error)
      ? 'Requires a WHERE filter — cannot be compared org-wide.'
      : 'Not queryable in source.' };
  }
  if (tgtRes?.error && (isUnqueryable(tgtRes.error) || isFilterRequired(tgtRes.error))) {
    return { skipped: true, reason: isFilterRequired(tgtRes.error)
      ? 'Requires a WHERE filter — cannot be compared org-wide.'
      : 'Not queryable in target.' };
  }
  if (srcRes?.error) return { error: `source: ${srcRes.error}` };
  if (tgtRes?.error) return { error: `target: ${tgtRes.error}` };

  const srcByKey = new Map(), tgtByKey = new Map();
  for (const r of (srcRes.records || [])) {
    const k = r[effectiveKey]; if (k != null && k !== '') srcByKey.set(String(k), r);
  }
  for (const r of (tgtRes.records || [])) {
    const k = r[effectiveKey]; if (k != null && k !== '') tgtByKey.set(String(k), r);
  }
  let matched = 0, missing = 0, extras = 0;
  for (const k of srcByKey.keys()) (tgtByKey.has(k) ? matched++ : missing++);
  for (const k of tgtByKey.keys()) if (!srcByKey.has(k)) extras++;
  const pct = sftkOcMatchPct(matched, missing, extras);
  return {
    srcCount:   srcByKey.size,
    tgtCount:   tgtByKey.size,
    matched, missing, extras,
    matchField: effectiveKey,
    matchPct:   pct
  };
}

function _ocRenderResults() {
  const el = eid('dsOCResults');
  if (!el) return;
  const rows = _orgCompareState.results || [];
  if (!rows.length) { el.innerHTML = ''; return; }

  // Sort: errors at top, worst-match next, skipped (not-queryable internal
  // sObjects) grouped after the real results, pending at bottom.
  const done = rows.filter(r => r.status !== 'pending' && !r.error && !r.skipped)
    .sort((a, b) => (a.matchPct || 0) - (b.matchPct || 0));
  const errs = rows.filter(r => r.error);
  const skip = rows.filter(r => r.skipped);
  const pend = rows.filter(r => r.status === 'pending');
  const ordered = [...errs, ...done, ...skip, ...pend];

  const colorFor = pct => pct >= 99 ? 'ds-oc-green'
                       : pct >= 90 ? 'ds-oc-yellow'
                       : pct >= 70 ? 'ds-oc-orange'
                       :             'ds-oc-red';

  // Headline summary strip + CSV export — only once the run has finished
  // (hidden while rows are still pending so mid-run repaints don't show a
  // misleading half-count).
  let banner = '';
  if (!pend.length && !_orgCompareState.running) {
    const clean = done.filter(r => !r.missing && !r.extras).length;
    const drift = done.length - clean;
    banner = `
      <div class="ds-oc-banner">
        <strong>${rows.length} object${rows.length === 1 ? '' : 's'} compared</strong>
        <span class="ds-oc-dot">·</span>
        <span class="ds-oc-clean">✓ ${clean} clean</span>
        <span class="ds-oc-dot">·</span>
        <span class="${drift ? 'ds-oc-drift' : 'ds-oc-dot'}">△ ${drift} drifted</span>
        ${errs.length ? `<span class="ds-oc-dot">·</span>
        <span class="ds-oc-drift">⚠ ${errs.length} error${errs.length === 1 ? '' : 's'}</span>` : ''}
        <span class="ds-oc-dot">·</span>
        <span class="ds-oc-dot">${skip.length} skipped</span>
        <span class="ds-oc-dot ds-oc-right">${esc(orgLabel(_orgCompareState.srcOrgUrl))} → ${esc(orgLabel(_orgCompareState.tgtOrgUrl))}</span>
        <button class="ds-btn ds-btn-xs" id="dsOCExportCsv" title="Download these results as a CSV file">⬇ CSV</button>
      </div>`;
  }

  el.innerHTML = `${banner}
    <table class="ds-oc-table">
      <thead><tr>
        <th>Object</th>
        <th title="Source org">${esc(orgLabel(_orgCompareState.srcOrgUrl) || 'Source')}</th>
        <th title="Target org">${esc(orgLabel(_orgCompareState.tgtOrgUrl) || 'Target')}</th>
        <th>Matched</th><th>Missing in target</th><th>Only in target</th>
        <th>% match</th><th></th>
      </tr></thead>
      <tbody>${ordered.map(r => {
        if (r.status === 'pending') return `<tr><td>${esc(r.name)}</td><td colspan="7" class="ds-oc-pending">⏳ comparing…</td></tr>`;
        if (r.error) {
          // U1: translate raw API errors — friendly message + hint visible,
          // raw string preserved in the title for copy-paste/debugging.
          const fe = sftkFriendlyError(r.error);
          return `<tr><td>${esc(r.name)}</td><td colspan="7" class="ds-oc-err" title="${esc(fe.raw)}">⚠ ${esc(fe.message)}${fe.hint ? ` <span style="opacity:.75">— ${esc(fe.hint)}</span>` : ''}</td></tr>`;
        }
        if (r.skipped) return `<tr class="ds-oc-skipped"><td>${esc(r.name)}</td><td colspan="7" class="ds-oc-skip">— ${esc(r.reason || 'Skipped.')}</td></tr>`;
        return `<tr class="ds-oc-row ${colorFor(r.matchPct)}">
          <td>${esc(r.name)} <span class="ds-oc-row-mf">by ${esc(r.matchField)}</span></td>
          <td>${r.srcCount.toLocaleString()}</td>
          <td>${r.tgtCount.toLocaleString()}</td>
          <td>${r.matched.toLocaleString()}</td>
          <td>${r.missing ? `<strong>${r.missing.toLocaleString()}</strong>` : '0'}</td>
          <td>${r.extras  ? `<strong>${r.extras.toLocaleString()}</strong>`  : '0'}</td>
          <td class="ds-oc-pct"><strong>${r.matchPct}%</strong></td>
          <td style="white-space:nowrap">
            <button class="ds-btn ds-btn-xs ds-btn-primary" data-oc-reconcile="${esc(r.name)}">🚀 Deploy</button>
            <button class="ds-btn ds-btn-xs" data-oc-deploy="${esc(r.name)}" data-oc-mf="${esc(r.matchField || '')}"
              title="Create a saved deployment pre-configured for ${esc(r.name)} with this org pair and match field — nothing is written">📦 Save as deployment</button>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;

  // Wire the summary-strip CSV export.
  eid('dsOCExportCsv')?.addEventListener('click', _ocExportCsv);

  // Wire row reconcile buttons — build an ephemeral profile and open Transfer.
  el.querySelectorAll('[data-oc-reconcile]').forEach(btn => {
    btn.addEventListener('click', () => _ocOpenReconcile(btn.dataset.ocReconcile));
  });

  // Wire row deploy buttons — open the Profile Builder pre-seeded with the
  // compared object, this org pair, and the match field the compare used, so
  // a discovered gap becomes a saved deployment without rebuilding by hand.
  el.querySelectorAll('[data-oc-deploy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const objName = btn.dataset.ocDeploy;
      const mf      = btn.dataset.ocMf || 'Name';
      openProfileBuilder({
        id:        genId('prof'),
        name:      `${objName} · ${orgLabel(_orgCompareState.srcOrgUrl)} → ${orgLabel(_orgCompareState.tgtOrgUrl)}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceOrg: _orgCompareState.srcOrgUrl,
        targetOrg: _orgCompareState.tgtOrgUrl,
        scanConfig: { matchField: mf, compareFields: [] },
        tree: { objectType: objName, where: '', children: [], fieldMappings: {}, matchField: mf }
      });
    });
  });
}

// Export the current result set as a CSV file (client-side Blob download —
// no server round-trip). Columns adapt to the presence-only result shape:
// matched/missing/onlyInTarget instead of per-field "changed" (Org Compare
// doesn't diff field values — that's Transfer's job).
function _ocExportCsv() {
  const rows = (_orgCompareState.results || []).filter(r => r.status !== 'pending');
  if (!rows.length) {
    showToast('Nothing to export yet — run a compare first', 'error', 3000);
    return;
  }
  const cell = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['object', 'status', 'matchField', 'sourceCount', 'targetCount',
                  'matched', 'missingInTarget', 'onlyInTarget', 'matchPct', 'detail'];
  const body = rows.map(r => {
    const status = r.error ? 'error'
                 : r.skipped ? 'skipped'
                 : ((r.missing || r.extras) ? 'drifted' : 'clean');
    const detail = r.error ? r.error : (r.skipped ? (r.reason || 'Skipped.') : '');
    return [
      r.name, status, r.matchField || '',
      r.srcCount ?? '', r.tgtCount ?? '',
      r.matched ?? '', r.missing ?? '', r.extras ?? '', r.matchPct ?? '',
      detail
    ].map(cell).join(',');
  }).join('\r\n');
  const csv = header.join(',') + '\r\n' + body;

  const slug = lbl => String(lbl || 'org').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'org';
  const fname = `org-compare-${slug(orgLabel(_orgCompareState.srcOrgUrl))}-vs-${slug(orgLabel(_orgCompareState.tgtOrgUrl))}-${new Date().toISOString().slice(0, 10)}.csv`;

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  showToast(`CSV exported — ${rows.length} row(s)`, 'success', 3000);
}

// Open Transfer scoped to one object — build an ephemeral, unsaved profile
// so the user can act on the diff right away without going through the
// Profile Builder. Pre-runs the diff scan so the columns are populated
// the moment the view opens.
async function _ocOpenReconcile(objName) {
  const ephemeral = {
    id:         `oc_${Date.now()}_${objName}`,
    name:       `Org Compare · ${objName}`,
    sourceOrg:  _orgCompareState.srcOrgUrl,
    targetOrg:  _orgCompareState.tgtOrgUrl,
    tree:       { objectType: objName, where: '', children: [], fieldMappings: {} },
    ephemeral:  true   // marker so refreshProfileDiff skips persistence
  };
  showToast(`Loading diff for ${objName}…`, 'info', 2500);
  const res = await runDiffScan(ephemeral);
  if (res?.error) {
    const fe = sftkFriendlyError(res.error);
    showToast(`Diff scan failed: ${fe.message}${fe.hint ? ' — ' + fe.hint : ''}`, 'error', 6000);
    return;
  }
  ephemeral.lastScan = res;
  _reconcileProfile = ephemeral;
  _currentView = 'reconcile';
  document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-view="compare"]')?.classList.add('active');
  renderReconcile();
}

