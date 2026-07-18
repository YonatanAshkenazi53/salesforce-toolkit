'use strict';
async function renderTransfer() {
  setMain(`<div class="ds-init-loading">${window.sftkCat ? sftkCat('Refreshing sessions…') : 'Refreshing sessions…'}</div>`);

  // Refresh open-tab sessions so we use the freshest SIDs.
  const freshRes = await sendBg({ type: 'GET_ALL_SF_SESSIONS' });
  if (freshRes?.sessions?.length) {
    _allSessions = freshRes.sessions;
    _allSessions.forEach(s => upsertOrg(s.orgUrl, s.label));
  }

  const allSess = _buildAllSessions();
  window._dsTrSessions = allSess;

  // ── Source/target: profile defaults + per-run override. ──────────────────
  // The profile defines the default org pair, but the user can switch either
  // side (or swap) for THIS run via the dropdowns on the org pair — stored in
  // _transferOrgOverride, never written back to the profile. The org card's
  // Transfer button also seeds the source override.
  function refreshTransferOrgsFromProfile() {
    if (!_transferProfile && !_transferOrgOverride.src && !_transferOrgOverride.tgt) {
      _transferSrc = null; _transferTgt = null; return;
    }
    // Precedence: run-time override > the profile's own orgs > working pair.
    const srcUrl = _transferOrgOverride.src || _transferProfile?.sourceOrg || _workingPair.src || '';
    const tgtUrl = _transferOrgOverride.tgt || _transferProfile?.targetOrg || _workingPair.tgt || '';
    _transferSrc = srcUrl ? _resolveSession(srcUrl, allSess) || { orgUrl: srcUrl, sid: null } : null;
    _transferTgt = tgtUrl ? _resolveSession(tgtUrl, allSess) || { orgUrl: tgtUrl, sid: null } : null;
  }
  window._dsTrRefreshOrgs = refreshTransferOrgsFromProfile;   // used by the org-pair dropdowns
  refreshTransferOrgsFromProfile();

  const profileOptions = _profiles.map((p, i) =>
    `<option value="${i}" ${_transferProfile?.id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`
  ).join('');

  setMain(`
    <div class="ds-view-header">
      <div class="ds-view-title-wrap">
        <button class="ds-back-link" id="dsTrBackBtn" title="Back to Data Deployment">‹ Back to deployments</button>
        <h2 class="ds-view-title">🚀 Run Transfer</h2>
        <div class="ds-view-subtitle">Copy records using a saved profile</div>
      </div>
    </div>

    <div class="ds-op-banner ds-op-banner-write">
      <span class="ds-op-banner-icon">✍️</span>
      <div class="ds-op-banner-body">
        <div class="ds-op-banner-title">Write operation — this inserts records into the target org</div>
        <div class="ds-op-banner-desc">Records will be <strong>inserted</strong> (not updated) in the target org.
          The source org is never modified. You can always undo by deleting the inserted records in the target.
        </div>
      </div>
    </div>

    ${!_profiles.length ? `
      <div class="ds-empty-page">
        <div class="ds-empty-icon">📦</div>
        <div class="ds-empty-title">No deployment profiles yet</div>
        <div class="ds-empty-sub">A profile defines which records to copy and which orgs are source/target. Create one in <strong>Data Deployment</strong> first.</div>
        <div class="ds-empty-actions">
          <button class="ds-btn ds-btn-primary" id="dsGoToProfiles">📦 Go to Data Deployment</button>
        </div>
      </div>` : `
    <div class="ds-transfer-config">
      <div class="ds-transfer-row">
        <div class="ds-field-group">
          <label class="ds-lbl">Profile <span style="font-size:11px;font-weight:400;color:var(--subtext)">(defines records + orgs)</span></label>
          <div class="ds-tr-profile-row">
            <select id="dsTrProfile" class="ds-select">
              <option value="">— Select a profile —</option>
              ${profileOptions}
            </select>
            <button class="ds-btn ds-btn-sm" id="dsTrEditProfile"
              title="Open this profile in the builder to edit objects, orgs, filters, and field mappings"
              ${_transferProfile ? '' : 'disabled'}>
              ✏ Edit profile
            </button>
          </div>
        </div>
      </div>

      <!-- Read-only org pair (defined by the profile) -->
      <div id="dsTrOrgPair"></div>

      <div id="dsTrPreviewArea"></div>

      <div id="dsTrSessionWarn" style="display:none;margin:8px 0 0;padding:8px 12px;background:#fff8f0;border:1px solid #e07b39;border-radius:6px;font-size:12px;color:#7a3a00;"></div>

      <div class="ds-transfer-options">
        <div class="ds-transfer-option">
          <label class="ds-transfer-option-label">
            <input type="checkbox" id="dsTrDryRun" ${_transferDryRun ? 'checked' : ''}>
            <span>🧪 Dry Run <span class="ds-option-hint">Simulate without writing records</span></span>
          </label>
        </div>
        <div class="ds-transfer-option">
          <label class="ds-transfer-option-label" for="dsTrWriteMode">Write mode:</label>
          <select id="dsTrWriteMode" class="ds-select ds-select-sm" style="width:auto">
            <option value="insert" ${_transferWriteMode === 'insert' ? 'selected' : ''}>Insert (always create)</option>
            <option value="upsert" ${_transferWriteMode === 'upsert' ? 'selected' : ''}>Upsert (update if exists)</option>
          </select>
          <select id="dsTrUpsertSelect" class="ds-select ds-select-sm"
            style="width:220px;display:none"
            title="External ID fields found on the root object in the TARGET org. Records matching on this field are updated instead of duplicated."></select>
          <input id="dsTrUpsertField" class="ds-input ds-input-sm"
            style="width:200px;${_transferWriteMode === 'upsert' ? '' : 'display:none'}"
            placeholder="External ID field (e.g. External_Id__c)"
            title="The external-Id field on the ROOT object used to match existing target records. Insert if no match, update if matched."
            value="${esc(_transferUpsertField)}">
        </div>
      </div>

      <div class="ds-transfer-footer">
        <button class="ds-btn" id="dsTrPreviewBtn" title="Re-count the records in scope">👁 Refresh counts</button>
        <span id="dsTrValidHint" class="ds-tr-valid-hint"></span>
        <button class="ds-btn ds-btn-lg" id="dsTrValidateBtn" disabled
          title="Run every safety check — required fields, lookups, record types, child-first feasibility — without writing anything.">🧪 Validate (dry run)</button>
        <button class="ds-btn ds-btn-lg" id="dsTrRunBtn" disabled>▶ Run Transfer</button>
      </div>
    </div>`}

    <div id="dsTrProgressArea"></div>
  `);

  renderTrOrgPair();   // initial paint of the read-only org pair

  eid('dsTrBackBtn')?.addEventListener('click', () => {
    renderProfiles();
  });

  eid('dsTrProfile')?.addEventListener('change', e => {
    _transferProfile = _profiles[parseInt(e.target.value, 10)] || null;
    _transferNodeFilters = {};
    _transferOrgOverride = { src: null, tgt: null };   // new profile → its own org pair
    refreshTransferOrgsFromProfile();
    renderTrOrgPair();
    updateTransferPreview();
    updateTransferBtn();
    _trLastTotal = null;      // stale count belongs to the previous profile
    _syncRunButtons();
    _maybeAutoCount();
    if (_transferWriteMode === 'upsert') _loadUpsertFieldOptions();
    const editBtn = eid('dsTrEditProfile');
    if (editBtn) editBtn.disabled = !_transferProfile;
  });
  eid('dsTrEditProfile')?.addEventListener('click', () => {
    if (_transferProfile?.id) window.editProfile?.(_transferProfile.id);
  });
  eid('dsTrPreviewBtn')?.addEventListener('click', previewTransfer);
  eid('dsTrRunBtn')?.addEventListener('click', runTransfer);
  // Validate = a one-off dry run, without touching the persistent checkbox.
  eid('dsTrValidateBtn')?.addEventListener('click', async () => {
    const chk = eid('dsTrDryRun');
    const prev = _transferDryRun;
    _transferDryRun = true;
    try { await runTransfer(); }
    finally { _transferDryRun = chk ? chk.checked : prev; _syncRunButtons(); }
  });
  eid('dsTrDryRun')?.addEventListener('change', e => {
    _transferDryRun = e.target.checked;
    _syncRunButtons();
  });
  eid('dsTrWriteMode')?.addEventListener('change', e => {
    _transferWriteMode = e.target.value;
    const fld = eid('dsTrUpsertField');
    if (fld) fld.style.display = _transferWriteMode === 'upsert' ? '' : 'none';
    if (_transferWriteMode === 'upsert') _loadUpsertFieldOptions();
    else { const sel = eid('dsTrUpsertSelect'); if (sel) sel.style.display = 'none'; }
  });
  eid('dsTrUpsertField')?.addEventListener('input', e => { _transferUpsertField = e.target.value.trim(); });
  eid('dsGoToProfiles')?.addEventListener('click', () => {
    document.querySelectorAll('.ds-nav-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.view === 'profiles'));
    _currentView = 'profiles';
    renderView('profiles');
  });

  if (_transferProfile) updateTransferPreview();
  updateTransferBtn();
  _syncRunButtons();
  if (_transferWriteMode === 'upsert') _loadUpsertFieldOptions();
  // Auto-count once per profile+pair+filters so the Run button shows the
  // magnitude without requiring the manual Preview click.
  _maybeAutoCount();
}

// Which footer button is the primary CTA? Until this profile+org-pair has a
// passing dry run this session, Validate leads; afterwards Run leads (with a
// "dry run passed" hint). The dry-run checkbox turns the Run button into the
// dry-run trigger, preserving the old behavior for users who prefer it.
function _valKey() {
  return `${_transferProfile?.id}|${_transferSrc?.orgUrl || ''}|${_transferTgt?.orgUrl || ''}`;
}
function _syncRunButtons() {
  const run  = eid('dsTrRunBtn');
  const val  = eid('dsTrValidateBtn');
  const hint = eid('dsTrValidHint');
  if (!run) return;
  const validated = _validatedRuns.has(_valKey());
  if (_transferDryRun) {
    run.textContent = '🧪 Dry Run';
    run.classList.remove('ds-btn-primary');
    run.classList.add('ds-btn-primary-outline');
  } else {
    run.textContent = `▶ Run Transfer${_trLastTotal != null ? ` (${_trLastTotal.toLocaleString()} records)` : ''}`;
    run.classList.remove('ds-btn-primary-outline');
    run.classList.toggle('ds-btn-primary', validated);
  }
  if (val) val.classList.toggle('ds-btn-primary', !validated && !_transferDryRun);
  if (hint) hint.innerHTML = validated ? '<span class="ds-tr-validated">✓ dry run passed</span>' : '';
}

// Debounced-by-key auto count: runs the existing previewTransfer pass when
// the profile / org pair / run-time filters change, at most once per setup.
function _maybeAutoCount() {
  if (!_transferProfile || !_transferSrc?.sid) return;
  const key = `${_transferProfile.id}|${_transferSrc.orgUrl}|${JSON.stringify(_transferNodeFilters)}`;
  if (_trAutoCountKey === key) return;
  _trAutoCountKey = key;
  previewTransfer();
}

// Populate the upsert External-ID picker from the TARGET org's describe of
// the root object. Fields flagged externalId are the only ones Salesforce
// accepts for upsert — a select prevents the typo-fails-at-runtime path. The
// free-text input stays for the "Other…" escape hatch and when the describe
// finds nothing.
async function _loadUpsertFieldOptions() {
  const sel = eid('dsTrUpsertSelect');
  const inp = eid('dsTrUpsertField');
  if (!sel || !inp || !_transferTgt?.sid || !_transferProfile?.tree) return;
  const obj = _transferProfile.tree.objectType || _transferProfile.tree.childSObject;
  if (!obj) return;
  const desc = await sendBg({
    type: 'SF_REST_GET', orgUrl: _transferTgt.orgUrl, sid: _transferTgt.sid,
    path: `services/data/v62.0/sobjects/${obj}/describe`
  });
  if (_transferWriteMode !== 'upsert') return;   // user switched away mid-fetch
  const ext = (!desc?.error && Array.isArray(desc.fields))
    ? desc.fields.filter(f => f.externalId === true)
    : [];
  if (!ext.length) {   // no External-ID fields → keep the free-text input
    sel.style.display = '';
    sel.innerHTML = `<option value="">⚠ No External ID fields on ${esc(obj)} in target</option>`;
    sel.disabled = true;
    inp.style.display = '';
    return;
  }
  sel.disabled = false;
  const known = ext.some(f => f.name === _transferUpsertField);
  sel.innerHTML = `
    <option value="">— pick External ID field —</option>
    ${ext.map(f => `<option value="${esc(f.name)}" ${f.name === _transferUpsertField ? 'selected' : ''}>${esc(f.label)} (${esc(f.name)})</option>`).join('')}
    <option value="__other__">✏ Other…</option>`;
  sel.style.display = '';
  inp.style.display = (known || !_transferUpsertField) ? 'none' : '';
  sel.onchange = () => {
    if (sel.value === '__other__') { inp.style.display = ''; inp.focus(); return; }
    _transferUpsertField = sel.value;
    inp.value = sel.value;
    inp.style.display = 'none';
  };
}

// Render the read-only "Source → Target" panel (replaces the old dropdowns).
// Shows the URLs the active profile points at + whether we can actually
// reach them right now. If a profile has no orgs set OR the orgs aren't
// reachable, this is where the user finds out (with a "✏ Edit profile" link).
function renderTrOrgPair() {
  const wrap = eid('dsTrOrgPair');
  if (!wrap) return;

  if (!_transferProfile) {
    wrap.innerHTML = '';
    return;
  }

  const p       = _transferProfile;
  const allSess = _buildAllSessions();
  const srcUrl  = _transferOrgOverride.src || p.sourceOrg || _workingPair.src || '';
  const tgtUrl  = _transferOrgOverride.tgt || p.targetOrg || _workingPair.tgt || '';
  const overridden = !!(_transferOrgOverride.src || _transferOrgOverride.tgt);

  // All orgs the studio knows about (remembered + currently open), so the
  // user can pick any of them — reachability is shown per selection.
  const knownOrgs = allMapOrgs();
  for (const url of [srcUrl, tgtUrl]) {   // ensure current picks are listed
    if (url && !knownOrgs.some(o => o.url === url)) knownOrgs.push({ url, label: orgLabel(url) });
  }

  function chip(url, role) {
    const sess      = url ? _resolveSession(url, allSess) : null;
    const reachable = !!(sess && sess.sid);
    const liveSet   = new Set(allSess.filter(s => s.sid).map(s => _orgKey(s.orgUrl)));
    const options = knownOrgs.map(o =>
      `<option value="${esc(o.url)}" ${o.url === url ? 'selected' : ''}>${esc(orgOptionLabel(o.url, o.label, liveSet))}</option>`
    ).join('');
    return `<div class="ds-tr-org-chip ${url && !reachable ? 'ds-tr-org-chip-unreachable' : ''}">
      <div class="ds-tr-org-chip-role">${role}</div>
      <select class="ds-select ds-select-sm ds-tr-org-select" data-tr-org-role="${role.toLowerCase()}">
        ${url ? '' : '<option value="" selected>— pick an org —</option>'}
        ${options}
      </select>
      <div class="ds-tr-org-chip-status">
        ${!url
          ? '<span style="color:#EA001E">●</span> Not set'
          : reachable
            ? '<span style="color:#2E844A">●</span> Session ready'
            : '<span style="color:#EA001E">●</span> Not open in Chrome — open it in a tab'}
      </div>
    </div>`;
  }

  wrap.innerHTML = `
    <div class="ds-tr-org-pair">
      ${chip(srcUrl, 'Source')}
      <button class="ds-btn ds-btn-xs ds-tr-org-swap" id="dsTrOrgSwap"
        title="Swap source and target for this run">⇄</button>
      ${chip(tgtUrl, 'Target')}
    </div>
    ${overridden ? `
      <div class="ds-tr-org-override-note">
        ⚙ Org pair changed for this run only — the saved profile still has
        <strong>${esc(orgLabel(p.sourceOrg || ''))} → ${esc(orgLabel(p.targetOrg || ''))}</strong>.
        <button class="ds-btn ds-btn-xs" id="dsTrOrgReset">↺ Reset to profile</button>
      </div>` : ''}`;

  // Wire: select change → set override (null when it matches the profile,
  // so the override note disappears when the user dials it back manually).
  wrap.querySelectorAll('.ds-tr-org-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const role = sel.dataset.trOrgRole;            // 'source' | 'target'
      const url  = sel.value || null;
      if (role === 'source') _transferOrgOverride.src = (url === p.sourceOrg) ? null : url;
      else                   _transferOrgOverride.tgt = (url === p.targetOrg) ? null : url;
      window._dsTrRefreshOrgs?.();
      renderTrOrgPair();
      updateTransferPreview();
      updateTransferBtn();
    });
  });
  eid('dsTrOrgSwap')?.addEventListener('click', () => {
    const curSrc = _transferOrgOverride.src || p.sourceOrg || '';
    const curTgt = _transferOrgOverride.tgt || p.targetOrg || '';
    _transferOrgOverride.src = (curTgt === p.sourceOrg) ? null : curTgt;
    _transferOrgOverride.tgt = (curSrc === p.targetOrg) ? null : curSrc;
    window._dsTrRefreshOrgs?.();
    renderTrOrgPair();
    updateTransferPreview();
    updateTransferBtn();
  });
  eid('dsTrOrgReset')?.addEventListener('click', () => {
    _transferOrgOverride = { src: null, tgt: null };
    window._dsTrRefreshOrgs?.();
    renderTrOrgPair();
    updateTransferPreview();
    updateTransferBtn();
  });
}

function updateTransferBtn() {
  const btn  = eid('dsTrRunBtn');
  const warn = eid('dsTrSessionWarn');
  if (!btn) return;

  // SIDs must be non-null — a session detected without a valid cookie would
  // appear in the dropdown but fail silently during the actual transfer.
  const srcOk = _transferSrc && !!_transferSrc.sid;
  const tgtOk = _transferTgt && !!_transferTgt.sid;
  const ready = !!_transferProfile && srcOk && tgtOk
    && _transferSrc.orgUrl !== _transferTgt.orgUrl;

  btn.disabled = !ready;
  const valBtn = eid('dsTrValidateBtn');
  if (valBtn) valBtn.disabled = !ready;

  // Surface a clear message instead of a silent failure when a session is expired
  if (warn) {
    const srcBad = _transferSrc && !_transferSrc.sid;
    const tgtBad = _transferTgt && !_transferTgt.sid;
    if (srcBad || tgtBad) {
      warn.style.display = '';
      warn.textContent = srcBad
        ? '⚠️ Source org session expired — open it in a browser tab and come back.'
        : '⚠️ Target org session expired — open it in a browser tab and come back.';
    } else {
      warn.style.display = 'none';
    }
  }
}

// ── Transfer filter helpers ───────────────────────────────────────
// Returns the effective { where, recordIds } for a node during a transfer run:
// run-time override from _transferNodeFilters takes priority over the saved profile.
function effectiveFilter(node, pathKey) {
  if (pathKey in _transferNodeFilters) return _transferNodeFilters[pathKey];
  return { where: node.where || null, recordIds: node.recordIds || null };
}

// Deep-clones the selected profile and patches each node's where/recordIds with
// any run-time overrides before sending to background.js or using in dry run.
function buildTransferProfile() {
  const clone = JSON.parse(JSON.stringify(_transferProfile));
  function patch(node, path) {
    const pathKey = path.join('.');
    if (pathKey in _transferNodeFilters) {
      const ov = _transferNodeFilters[pathKey];
      node.where     = ov.where     ?? null;
      node.recordIds = ov.recordIds ?? null;
    }
    (node.children || []).forEach((c, i) => patch(c, [...path, i]));
  }
  patch(clone.tree, []);
  // Upsert config (root object only, v1) — attach when the user picked
  // Upsert mode and gave an external-Id field. executeProfileTransfer reads
  // profile.upsert.field and uses the Collections upsert endpoint for root.
  if (_transferWriteMode === 'upsert' && _transferUpsertField) {
    clone.upsert = { field: _transferUpsertField };
  }
  // Keep the clone's org fields in step with the run-time override so
  // anything downstream that inspects profile.sourceOrg/targetOrg (logging,
  // error messages) reflects the orgs actually used this run.
  if (_transferOrgOverride.src) clone.sourceOrg = _transferOrgOverride.src;
  if (_transferOrgOverride.tgt) clone.targetOrg = _transferOrgOverride.tgt;
  return clone;
}

function updateTransferPreview(counts = null) {
  const area = eid('dsTrPreviewArea');
  if (!area || !_transferProfile?.tree) return;

  function renderNode(node, depth, path, countsNode) {
    const pathKey  = path.join('.');
    const name     = node.objectType || node.childSObject;
    const pad      = depth * 20;
    const ef       = effectiveFilter(node, pathKey);
    const isOverride = pathKey in _transferNodeFilters;

    // Build filter badge
    const filterBadge = ef.recordIds?.length
      ? `<span class="ds-tr-filter-badge ds-tr-filter-badge--ids">🎯 ${ef.recordIds.length} selected</span>`
      : ef.where
        ? `<span class="ds-tr-filter-badge">WHERE ${esc(ef.where)}</span>`
        : '';

    // Count badge (populated after Preview Counts)
    const countBadge = countsNode
      ? countsNode.count !== null
        ? `<span class="ds-tr-plan-count">${countsNode.count.toLocaleString()}</span>`
        : `<span class="ds-tr-plan-err">count failed</span>`
      : '';

    // Override indicator
    const overrideDot = isOverride
      ? `<span class="ds-tr-override-dot" title="Run-time filter override (profile not changed)">⚙</span>`
      : '';

    const canFilter = !!_transferSrc;
    const hasFilter = isOverride || ef.recordIds?.length || ef.where;
    // Label carries the object name so it's unambiguous WHICH object each
    // button filters — the buttons right-align per row and were reading as
    // one ambiguous pair. "Edit" vs "Filter" reflects whether this object
    // already has a record filter / WHERE set.
    const filterBtn = canFilter
      ? `<button class="ds-btn ds-btn-xs ds-tr-filter-btn" data-tr-filter-path="${esc(pathKey)}" data-tr-filter-obj="${esc(name)}"
           title="${hasFilter ? `Edit which ${esc(name)} records transfer` : `Choose which ${esc(name)} records transfer (pick records or set a WHERE clause)`}">
           ${hasFilter ? `🎯 Edit filter: ${esc(name)}` : `🎯 Filter ${esc(name)}`}
         </button>`
      : '';

    const children = (node.children || []).map((c, i) =>
      renderNode(c, depth + 1, [...path, i], countsNode?.children?.[i])
    ).join('');

    return `
      <div class="ds-tr-plan-row" style="padding-left:${pad}px">
        <span class="ds-tr-plan-icon">${depth === 0 ? '📂' : '↳'}</span>
        <span class="ds-tr-plan-obj">${esc(name)}</span>
        ${overrideDot}${filterBadge}${countBadge}
        <span class="ds-tr-plan-row-actions">${filterBtn}</span>
      </div>
      ${children}`;
  }

  area.innerHTML = `
    <div class="ds-tr-tree-preview">
      <div class="ds-section-title" style="margin-bottom:8px;display:flex;align-items:center;gap:8px">
        Transfer Plan
        ${Object.keys(_transferNodeFilters).length
          ? `<span style="font-size:11px;font-weight:400;color:#5a3dbd">⚙ ${Object.keys(_transferNodeFilters).length} run-time filter${Object.keys(_transferNodeFilters).length !== 1 ? 's' : ''} active</span>`
          : ''}
      </div>
      ${renderNode(_transferProfile.tree, 0, [], counts)}
    </div>`;

  // Wire filter buttons
  area.querySelectorAll('.ds-tr-filter-btn').forEach(btn => {
    btn.addEventListener('click', () =>
      openTransferRecordFilterModal(btn.dataset.trFilterPath, btn.dataset.trFilterObj)
    );
  });
}

async function previewTransfer() {
  if (!_transferProfile || !_transferSrc) return;
  const area = eid('dsTrPreviewArea');

  // Show plan with a "counting…" skeleton first so filter buttons stay visible
  updateTransferPreview();
  if (area) {
    const title = area.querySelector('.ds-section-title');
    if (title) title.innerHTML = `Transfer Plan — <span style="color:var(--subtext);font-weight:400">counting in ${esc(orgLabel(_transferSrc.orgUrl))}…</span>`;
  }

  // Use the patched clone so overrides from _transferNodeFilters are applied
  const runProfile = buildTransferProfile();

  async function countNode(node) {
    const obj = node.objectType || node.childSObject;
    const ef  = node; // already patched by buildTransferProfile
    const where = ef.recordIds?.length
      ? `Id IN (${ef.recordIds.map(id => `'${id}'`).join(',')})`
      : (ef.where || null);
    const res = await sendBg({
      type: 'SF_QUERY', tooling: false,
      orgUrl: _transferSrc.orgUrl, sid: _transferSrc.sid,
      query: `SELECT COUNT() FROM ${obj}${where ? ' WHERE ' + where : ''}`
    });
    const count    = res.error ? null : (res.totalSize ?? 0);
    const children = await Promise.all((node.children || []).map(c => countNode(c)));
    return { obj, count, children };
  }

  const counts = await countNode(runProfile.tree);

  // Total across the tree — feeds the Run button label + the big-run gate.
  let total = null;
  (function sum(n) {
    if (!n) return;
    if (n.count != null) total = (total ?? 0) + n.count;
    (n.children || []).forEach(sum);
  })(counts);
  _trLastTotal = total;
  _syncRunButtons();

  // Re-render plan with count badges inline — filter buttons stay wired
  updateTransferPreview(counts);
  const area2 = eid('dsTrPreviewArea');
  if (area2) {
    const title = area2.querySelector('.ds-section-title');
    if (title) {
      const overrideNote = title.querySelector('span');
      title.innerHTML = `Transfer Plan — <span style="color:var(--subtext);font-weight:400">counts from ${esc(orgLabel(_transferSrc.orgUrl))}</span>`;
      if (overrideNote) title.appendChild(overrideNote);
    }
  }
}

async function runTransfer() {
  if (!_transferProfile || !_transferSrc || !_transferTgt) return;
  if (_transferSrc.orgUrl === _transferTgt.orgUrl) return;

  const btn = eid('dsTrRunBtn');
  if (btn) btn.disabled = true;

  const progArea = eid('dsTrProgressArea');
  if (progArea) progArea.innerHTML = `
    <div class="ds-progress-wrap">
      <div class="ds-progress-title">
        Transferring from ${esc(orgLabel(_transferSrc.orgUrl))} → ${esc(orgLabel(_transferTgt.orgUrl))}…
      </div>
      <div id="dsTrProgLog" class="ds-progress-log"></div>
    </div>`;

  function logRow(icon, msg, cls = '') {
    const log = eid('dsTrProgLog');
    if (!log) return;
    const row = document.createElement('div');
    row.className = `ds-prog-row ${cls}`;
    row.innerHTML = `<span class="ds-prog-icon">${icon}</span><span>${esc(msg)}</span>`;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  // Feature 5: Dry run mode — validate fields + count, no writes
  if (_transferDryRun) {
    logRow('🧪', `DRY RUN — validating "${_transferProfile.name}" (nothing will be written)…`);
    let dryRunIssues = 0;

    async function dryRunNode(node) {
      const obj = node.objectType || node.childSObject;

      // Match the REAL executor's record scoping: picked recordIds take
      // priority over the WHERE clause (background.js does the same). The
      // dry run previously used only node.where, so a "🎯 N selected"
      // profile was validated against the ENTIRE table — wrong counts,
      // null-sampling false alarms from unselected rows, missed issues.
      const dryWhere = (Array.isArray(node.recordIds) && node.recordIds.length)
        ? `Id IN (${node.recordIds.filter(Boolean).map(id => `'${id}'`).join(',')})`
        : (node.where || '');

      // ── Step 1: count records in source ──────────────────────────
      const countRes = await sendBg({
        type: 'SF_QUERY', tooling: false,
        orgUrl: _transferSrc.orgUrl, sid: _transferSrc.sid,
        query: `SELECT COUNT() FROM ${obj}${dryWhere ? ' WHERE ' + dryWhere : ''}`
      });
      if (countRes.error) {
        logRow('❌', `${obj}: source query failed — ${countRes.error}`, 'ds-prog-err');
        dryRunIssues++;
        return;
      }
      const srcCount = countRes.totalSize ?? 0;

      // ── Step 2: get required fields from TARGET org describe ──────
      const tgtDesc = await sendBg({
        type: 'SF_REST_GET',
        orgUrl: _transferTgt.orgUrl, sid: _transferTgt.sid,
        path: `services/data/v62.0/sobjects/${obj}/describe`
      });
      const SYSTEM_SKIP = new Set(['Id','IsDeleted','CreatedDate','CreatedById',
        'LastModifiedDate','LastModifiedById','SystemModstamp','OwnerId']);
      const requiredInTarget = tgtDesc.error ? [] :
        (tgtDesc.fields || [])
          .filter(f => f.createable && !f.nillable && f.defaultValue === null && !SYSTEM_SKIP.has(f.name))
          .map(f => f.name);

      // ── Child-first feasibility ───────────────────────────────────────────
      // A child-first node inserts BEFORE its parent (parent-link field left
      // empty) and gets linked by an UPDATE afterwards. That's only possible
      // when the link field is optional at insert AND updateable in the
      // target. The generic required-field check below can't catch this (the
      // source rows DO have parent values — they're just deliberately not
      // sent), so a real run would fail 100% while dry run passed.
      if (node.insertOrder === 'childFirst' && node.field && !tgtDesc.error) {
        // Resolve the link field the way the executor does — through the
        // node's field mapping. null = user excluded the link (records will
        // never be wired); a rename means the TARGET name must be checked.
        const fmLink = node.fieldMappings ? node.fieldMappings[node.field] : undefined;
        if (fmLink === null) {
          logRow('⚠️', `${obj}: child-first — the parent link field ${node.field} is excluded by the field mapping ("Set null"), so these records will be created but never linked to their parent.`, 'ds-prog-warn');
        } else {
          const linkName = fmLink || node.field;
          const mapped   = linkName !== node.field ? ` (mapped from ${node.field})` : '';
          const pf = (tgtDesc.fields || []).find(f => f.name === linkName);
          if (!pf) {
            logRow('❌', `${obj}: child-first — parent link field ${linkName}${mapped} doesn't exist in the target org`, 'ds-prog-err');
            dryRunIssues++;
          } else {
            if (pf.nillable === false) {
              logRow('❌', `${obj}: child-first won't work — ${linkName}${mapped} is REQUIRED in the target (master-detail or required lookup), so these records can't be created before their parent. Switch the node back to default order.`, 'ds-prog-err');
              dryRunIssues++;
            }
            if (pf.updateable === false) {
              logRow('❌', `${obj}: child-first won't work — ${linkName}${mapped} is not updateable in the target, so these records can't be linked to their parent after creation.`, 'ds-prog-err');
              dryRunIssues++;
            }
            if (pf.nillable !== false && pf.updateable !== false) {
              logRow('✅', `${obj}: child-first OK — ${linkName}${mapped} is optional and updateable in the target ✓`);
            }
          }
        }
      }

      // ── Step 3: cross-check which required-target fields exist in source ──
      // CRITICAL: this must apply the same field-mapping logic the real transfer
      // uses, otherwise a profile that maps `LastName → null` (or maps it to a
      // different target field) passes dry run but fails the real INSERT with
      // "Required fields are missing: [LastName]".
      let fieldIssues = [];
      if (requiredInTarget.length && srcCount > 0) {
        // Get source describe to know which fields actually exist there
        const srcDesc = await sendBg({
          type: 'SF_REST_GET',
          orgUrl: _transferSrc.orgUrl, sid: _transferSrc.sid,
          path: `services/data/v62.0/sobjects/${obj}/describe`
        });
        const srcFields = srcDesc.error ? [] : (srcDesc.fields || []);
        const srcFieldNames = new Set(srcFields.map(f => f.name));

        // Build the "what source field will populate each target field" map by
        // simulating the executor's payload-building loop.
        //   - fm[srcField] === null   → source field is dropped entirely
        //   - fm[srcField] === 'X'    → source field is renamed to target.X
        //   - srcField not in fm      → identity passthrough (source.X → target.X)
        const fm = node.fieldMappings || {};
        const sourceForTarget = {};  // tgtField → srcField that will populate it
        const dupTargets = [];       // mapping collisions — two sources, one target
        for (const f of srcFields) {
          if (!f.createable) continue;
          if (fm[f.name] === null) continue;                       // user-excluded
          const tgtField = (f.name in fm && fm[f.name]) ? fm[f.name] : f.name;
          // First source field "wins" the target slot (matches executor behaviour)
          if (!(tgtField in sourceForTarget)) sourceForTarget[tgtField] = f.name;
          else dupTargets.push(`${tgtField} ← ${sourceForTarget[tgtField]} AND ${f.name}`);
        }
        // Two source fields writing the same target silently means "one value
        // wins" — almost always a corrupted or experimental mapping. Warn.
        if (dupTargets.length) {
          logRow('⚠', `${obj}: ${dupTargets.length} field-mapping collision(s) — two source fields write the same target field (${dupTargets.slice(0, 5).join('; ')}) — only one value can win. Fix in ✏ Edit → Fields & mapping.`, 'ds-prog-warn');
        }

        // Bucket each required-in-target field by how it will (or won't) be populated
        const droppedByMapping = [];   // required field is in source but mapped to null
        const missingInSrc     = [];   // required field has no source field producing it
        const nullCheckPairs   = [];   // [{ tgtField, srcField }] — needs row-level null check

        for (const reqTgt of requiredInTarget) {
          const srcFieldForReq = sourceForTarget[reqTgt];
          if (srcFieldForReq) {
            nullCheckPairs.push({ tgtField: reqTgt, srcField: srcFieldForReq });
          } else if (fm[reqTgt] === null && srcFieldNames.has(reqTgt)) {
            droppedByMapping.push(reqTgt);
          } else {
            missingInSrc.push(reqTgt);
          }
        }

        droppedByMapping.forEach(f => fieldIssues.push({ fieldName: f, droppedByMapping: true }));
        missingInSrc.forEach(f    => fieldIssues.push({ fieldName: f, missingFromSource: true }));

        // Row-level null check — sample real data on the source side of the mapping
        if (nullCheckPairs.length) {
          const selectFields = ['Id', ...new Set(nullCheckPairs.map(p => p.srcField))].join(', ');
          const sampleRes = await sendBg({
            type: 'SF_QUERY', tooling: false,
            orgUrl: _transferSrc.orgUrl, sid: _transferSrc.sid,
            query: `SELECT ${selectFields} FROM ${obj}${dryWhere ? ' WHERE ' + dryWhere : ''} LIMIT 200`
          });
          if (!sampleRes.error) {
            for (const { tgtField, srcField } of nullCheckPairs) {
              const nullCount = (sampleRes.records || [])
                .filter(r => r[srcField] === null || r[srcField] === undefined || r[srcField] === '').length;
              if (nullCount > 0) {
                fieldIssues.push({
                  fieldName: tgtField, srcField,
                  nullCount, total: sampleRes.records.length
                });
              }
            }
          }
        }
      }

      // ── Step 4: log required-field results ───────────────────────
      if (fieldIssues.length) {
        dryRunIssues += fieldIssues.length;
        logRow('⚠️', `${obj}: ${srcCount} record(s) found — ${fieldIssues.length} required field issue(s):`, 'ds-prog-warn');
        for (const issue of fieldIssues) {
          if (issue.droppedByMapping) {
            logRow('❌',
              `  ${issue.fieldName}: required in target but excluded by your field mapping — ` +
              `target inserts will fail. Open "Edit profile" and map this field back.`,
              'ds-prog-err');
          } else if (issue.missingFromSource) {
            logRow('❌',
              `  ${issue.fieldName}: required in target, but no source field is mapped to it`,
              'ds-prog-err');
          } else {
            const via = issue.srcField && issue.srcField !== issue.fieldName
              ? ` (via source field ${issue.srcField})` : '';
            logRow('❌',
              `  ${issue.fieldName}: ${issue.nullCount} of ${issue.total} sampled records have no value (required in target)${via}`,
              'ds-prog-err');
          }
        }
      } else {
        logRow('✅', `${obj}: ${srcCount} record(s) — all required fields present`);
      }

      // ── Step 4b: source fields the target org can't accept ───────
      // Mirrors the real transfer, which skips fields that aren't createable
      // in the target. Without this, a dry run could pass while the real run
      // dropped fields — the "dry run passes, real fails" gap.
      if (srcCount > 0 && !tgtDesc.error) {
        const tgtCreatable = new Set(
          (tgtDesc.fields || []).filter(f => f.createable).map(f => f.name)
        );
        const srcDescFull = await sendBg({
          type: 'SF_REST_GET',
          orgUrl: _transferSrc.orgUrl, sid: _transferSrc.sid,
          path: `services/data/v62.0/sobjects/${obj}/describe`
        });
        if (!srcDescFull.error) {
          const fm = node.fieldMappings || {};
          const wontTransfer = [];
          for (const f of (srcDescFull.fields || [])) {
            if (!f.createable || SYSTEM_SKIP.has(f.name) || f.name === 'RecordTypeId') continue;
            if (fm[f.name] === null) continue;  // user-excluded — intentional
            const tgtField = (f.name in fm && fm[f.name]) ? fm[f.name] : f.name;
            if (!tgtCreatable.has(tgtField)) wontTransfer.push(tgtField);
          }
          if (wontTransfer.length) {
            logRow('⚠️',
              `${obj}: ${wontTransfer.length} field(s) won't transfer — not writable in target ` +
              `(${wontTransfer.slice(0, 8).join(', ')}${wontTransfer.length > 8 ? '…' : ''})`,
              'ds-prog-warn');
          }
        }
      }

      // ── Step 5: validate lookup resolution bridges ────────────────
      // For each 'match' resolution, probe a sample to see how many IDs resolve.
      if (node.lookupResolutions && srcCount > 0 && _transferTgt) {
        for (const [fieldName, res] of Object.entries(node.lookupResolutions)) {
          if (res.strategy !== 'match' || !res.matchField || !res.matchObject) continue;

          // Grab a 50-record sample from source and check how many AccountId values
          // we can bridge via the chosen anchor field
          const sampleRes = await sendBg({
            type: 'SF_QUERY', tooling: false,
            orgUrl: _transferSrc.orgUrl, sid: _transferSrc.sid,
            query: `SELECT ${fieldName} FROM ${obj}${dryWhere ? ' WHERE ' + dryWhere : ''} LIMIT 50`
          });
          if (sampleRes.error) continue;

          const sampleIds = [...new Set(
            (sampleRes.records || []).map(r => r[fieldName]).filter(Boolean)
          )];
          if (!sampleIds.length) continue;

          // Lookup anchor values from source
          const idList = sampleIds.map(id => `'${id}'`).join(',');
          const srcLookup = await sendBg({
            type: 'SF_QUERY', tooling: false,
            orgUrl: _transferSrc.orgUrl, sid: _transferSrc.sid,
            query: `SELECT Id, ${res.matchField} FROM ${res.matchObject} WHERE Id IN (${idList})`
          });
          if (srcLookup.error) continue;

          const anchorValues = [...new Set(
            (srcLookup.records || []).map(r => r[res.matchField]).filter(Boolean)
          )];
          if (!anchorValues.length) continue;

          // Match against target
          // Use soqlStrLit so values like O'Brien (or anything containing
          // a backslash) are safely escaped — the old inline escape only
          // handled single quotes, leaving backslashes to corrupt the query.
          const valList = anchorValues.map(soqlStrLit).join(',');
          const tgtLookup = await sendBg({
            type: 'SF_QUERY', tooling: false,
            orgUrl: _transferTgt.orgUrl, sid: _transferTgt.sid,
            query: `SELECT Id, ${res.matchField} FROM ${res.matchObject} WHERE ${res.matchField} IN (${valList})`
          });
          if (tgtLookup.error) {
            logRow('⚠️', `  ${fieldName}: lookup probe failed — ${tgtLookup.error}`, 'ds-prog-warn');
            dryRunIssues++;
            continue;
          }

          const matched = (tgtLookup.records || []).length;
          const total   = anchorValues.length;
          if (matched === 0) {
            logRow('❌', `  ${fieldName} → ${res.matchObject}.${res.matchField}: no matches found in target — all will be null`, 'ds-prog-err');
            dryRunIssues++;
          } else if (matched < total) {
            logRow('⚠️', `  ${fieldName} → ${res.matchObject}.${res.matchField}: ${matched}/${total} sampled values found in target — some will be null`, 'ds-prog-warn');
          } else {
            logRow('✅', `  ${fieldName} → ${res.matchObject}.${res.matchField}: all ${total} sampled values resolve in target ✓`);
          }
        }
      }

      // ── Step 6: Record-type matching preview ──────────────────────
      // The transfer matches source → target RecordTypes by DeveloperName
      // (API name). Show, before running, which record types used by the
      // source records have an equivalent in the target — unmatched ones
      // mean those records will land with the target's DEFAULT record type.
      if (srcCount > 0) {
        const rtWhere = dryWhere
          ? `WHERE (${dryWhere}) AND RecordTypeId != null`
          : `WHERE RecordTypeId != null`;
        const srcRtRes = await sendBg({
          type: 'SF_QUERY', tooling: false,
          orgUrl: _transferSrc.orgUrl, sid: _transferSrc.sid,
          // GROUP BY → distinct record-type names cheaply (no row payload).
          query: `SELECT RecordType.DeveloperName FROM ${obj} ${rtWhere} GROUP BY RecordType.DeveloperName`
        });
        // Some objects have no RecordTypeId field → the query errors; that
        // just means "no record types here", which is fine, so ignore it.
        if (!srcRtRes.error) {
          const usedNames = [...new Set(
            (srcRtRes.records || []).map(r => r.RecordType?.DeveloperName).filter(Boolean)
          )];
          if (usedNames.length) {
            const tgtRtRes = await sendBg({
              type: 'SF_QUERY', tooling: false,
              orgUrl: _transferTgt.orgUrl, sid: _transferTgt.sid,
              query: `SELECT DeveloperName FROM RecordType WHERE SObjectType = '${obj}'`
            });
            const tgtNames = new Set((tgtRtRes.records || []).map(r => r.DeveloperName));
            const matchedRt   = usedNames.filter(n => tgtNames.has(n));
            const unmatchedRt = usedNames.filter(n => !tgtNames.has(n));
            if (unmatchedRt.length) {
              logRow('⚠️',
                `${obj}: record type(s) ${unmatchedRt.join(', ')} have no match in target — those records will use the target's default record type` +
                (matchedRt.length ? ` (${matchedRt.length} other type(s) match ✓)` : ''),
                'ds-prog-warn');
            } else {
              logRow('✅', `${obj}: all ${matchedRt.length} record type(s) match in target by API name ✓`);
            }
          }
        }
      }

      for (const c of (node.children || [])) await dryRunNode(c);
    }

    // Owner-mapping sanity: matching without a fallback is allowed but easy
    // to pick by accident — say what will happen to unmatched owners.
    if (_transferProfile?.ownerMapping?.mode === 'match' && !_transferProfile.ownerMapping.fallbackUserId) {
      logRow('⚠', 'Owner matching is ON but no fallback user is picked — owners with no name match get the target default on inserts, and keep their current owner on updates.', 'ds-prog-warn');
    }

    await dryRunNode(buildTransferProfile().tree);

    if (dryRunIssues > 0) {
      logRow('❌', `Dry run found ${dryRunIssues} issue(s) — fix these before running the real transfer.`, 'ds-prog-err');
      showToast(`Dry run found ${dryRunIssues} issue(s) — see details`, 'warning', 6000);
      _validatedRuns.delete(_valKey());
    } else {
      logRow('✅', 'Dry run passed — no issues found. Safe to run the real transfer.');
      showToast('Dry run passed ✓ — no field issues found', 'success', 4000);
      // Flip the footer: Run Transfer becomes the primary CTA for this
      // profile+org pair now that it's validated.
      _validatedRuns.add(_valKey());
    }
    _syncRunButtons();
    if (btn) btn.disabled = false;
    return;
  }

  // Guard: Upsert mode needs an external-Id field to match on.
  if (_transferWriteMode === 'upsert' && !_transferUpsertField) {
    logRow('❌', 'Upsert mode is selected but no External ID field was entered. Enter the field name or switch to Insert.', 'ds-prog-err');
    showToast('Enter an External ID field for Upsert mode', 'error', 5000);
    if (btn) btn.disabled = false;
    return;
  }

  // Magnitude / production gate — a large write, or ANY write into a
  // production org, should never start on a single click. Uses the
  // auto-counted total when available; the prod check is authoritative
  // (detected + cached via the Organization object).
  const tgtProd = (await ensureOrgType(_transferTgt.orgUrl)) === 'production';
  if ((tgtProd || (_trLastTotal != null && _trLastTotal > 2000)) && !_trBigRunConfirmed) {
    const nTxt = _trLastTotal != null ? `${_trLastTotal.toLocaleString()} records` : 'records';
    showModal(`
      <div class="ds-modal-header">${tgtProd ? '🛑 Writing into PRODUCTION' : '⚠ Large transfer'}</div>
      <div class="ds-modal-body">
        ${tgtProd ? `<div style="margin-bottom:8px;padding:8px 12px;background:#fef2f2;border-left:3px solid #dc2626;border-radius:4px;font-size:12px;color:#991b1b">
          🛑 <strong>${esc(orgLabel(_transferTgt.orgUrl))} looks like a PRODUCTION org.</strong> Writes here affect real users.</div>` : ''}
        You're about to write <strong>${nTxt}</strong>
        into <strong>${esc(orgLabel(_transferTgt.orgUrl))}</strong>
        (${_transferWriteMode === 'upsert' ? `upsert on ${esc(_transferUpsertField)}` : 'insert — always creates new records'}).
      </div>
      <div class="ds-modal-footer">
        <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
        <button class="ds-btn ${tgtProd ? 'ds-btn-danger' : 'ds-btn-primary'}" id="dsTrBigRunGo">Proceed${_trLastTotal != null ? ` with ${_trLastTotal.toLocaleString()} records` : ''}</button>
      </div>`);
    eid('dsTrBigRunGo')?.addEventListener('click', () => {
      _trBigRunConfirmed = true;
      closeModal();
      runTransfer();
    });
    if (btn) btn.disabled = false;
    return;
  }
  _trBigRunConfirmed = false;   // consumed — next gated run asks again

  const modeLabel = _transferWriteMode === 'upsert' ? `upsert on ${_transferUpsertField}` : 'insert';
  logRow('📤', `Starting transfer of profile "${_transferProfile.name}" (${modeLabel})…`);

  // Live progress + Cancel: the Port streams per-batch counts into the log
  // (keeping the worker alive) and carries the cancel command back.
  const titleEl = document.querySelector('#dsTrProgressArea .ds-progress-title');
  if (titleEl && !eid('dsTrCancelBtn')) {
    const cbtn = document.createElement('button');
    cbtn.id = 'dsTrCancelBtn';
    cbtn.className = 'ds-btn ds-btn-xs ds-btn-danger';
    cbtn.style.marginLeft = 'auto';
    cbtn.textContent = '✋ Cancel';
    cbtn.title = 'Stop after the current batch — records already written stay written.';
    titleEl.appendChild(cbtn);
  }
  const runPort = _openRunPort(_runProgressHandler(eid('dsTrProgLog')));
  eid('dsTrCancelBtn')?.addEventListener('click', () => {
    try { runPort?.postMessage({ cmd: 'cancel' }); } catch (_) {}
    const cb = eid('dsTrCancelBtn');
    if (cb) { cb.disabled = true; cb.textContent = '⏳ cancelling…'; }
  });

  const result = await sendBg({
    type:             'SF_EXECUTE_PROFILE_TRANSFER',
    profile:          buildTransferProfile(),   // patched clone — incl. upsert config if set
    srcOrgUrl:        _transferSrc.orgUrl,
    srcSid:           _transferSrc.sid,
    tgtOrgUrl:        _transferTgt.orgUrl,
    tgtSid:           _transferTgt.sid
  });

  try { runPort?.disconnect(); } catch (_) {}
  eid('dsTrCancelBtn')?.remove();
  if (result?.cancelled) {
    logRow('✋', 'Run cancelled — everything written before the cancel stays in the target; the partial result is recorded in History.', 'ds-prog-warn');
    showToast('Transfer cancelled — partial results recorded', 'warning', 5000);
  }

  if (result.error) {
    logRow('❌', result.error, 'ds-prog-err');
    showToast('Transfer failed: ' + result.error, 'error', 6000);
    if (btn) btn.disabled = false;
    return;
  }

  // Log per-object results
  let anySessionExpired = false;
  for (const [obj, s] of Object.entries(result.summary || {})) {
    const isExpired = /SESSION_EXPIRED|session.*expired|INVALID_SESSION/i.test(s.error || '');
    if (isExpired) anySessionExpired = true;
    const icon = s.error ? '❌' : ((s.failed > 0 || s.connectFailed || s.connectOrphaned) ? '⚠' : '✅');
    // Child-first link outcomes (only present on child-first nodes)
    const linkInfo =
      `${s.connected ? `, ${s.connected} linked to parent` : ''}` +
      `${s.connectFailed ? `, ${s.connectFailed} link failed` : ''}` +
      `${s.connectOrphaned ? `, ${s.connectOrphaned} unlinked (parent failed)` : ''}`;
    const msg  = s.error
      ? (isExpired
          ? `${obj}: Session expired — the Salesforce session ended during the transfer`
          : `${obj}: ${s.error}`)
      : `${obj}: ${s.created} created${s.failed > 0 ? `, ${s.failed} failed` : ''}${linkInfo}`;
    logRow(icon, msg, s.error || s.failed || s.connectFailed ? 'ds-prog-err' : '');
    // Fields skipped because the target org can't accept them (non-fatal).
    if (s.skippedFields && s.skippedFields.length) {
      logRow('ℹ️',
        `  ${obj}: ${s.skippedFields.length} field(s) skipped — not writable in the target org ` +
        `(${s.skippedFields.slice(0, 8).join(', ')}${s.skippedFields.length > 8 ? '…' : ''})`,
        'ds-prog-warn');
    }
  }

  (result.errors || []).forEach(e => logRow('❌', e, 'ds-prog-err'));

  const total = Object.values(result.summary || {}).reduce((n,s)=>n+(s.created||0),0);
  logRow(result.status === 'success' ? '✅' : '⚠',
    `Done — ${total} records transferred · Status: ${result.status}`);

  // Session-expired hint — guide the user to reopen their org tab
  if (anySessionExpired) {
    const log = eid('dsTrProgLog');
    if (log) {
      const hint = document.createElement('div');
      hint.style.cssText = 'margin:10px 0 4px;padding:10px 12px;background:#fff8f0;border:1px solid #e07b39;border-radius:6px;font-size:12px;color:#7a3a00;';
      hint.innerHTML = `⚠️ <strong>Session expired</strong> — open the affected org in a browser tab to refresh your Salesforce login, then run the transfer again. The Transfer view will re-detect the fresh session automatically.`;
      log.appendChild(hint);
    }
  }
  showToast(
    result.status === 'success'
      ? `✅ ${total} records transferred successfully`
      : `⚠️ Transfer finished with warnings — ${total} records`,
    result.status === 'success' ? 'success' : 'warning',
    5000
  );

  // M3c — MATCH MEMORY: remember the root object's srcId→tgtId pairs from
  // this run's successful creates/upserts, so future scans match these
  // records by identity (rename-proof). M-followup guard: only when this
  // run's SOURCE equals the profile's own source — pairs learned under a
  // run-time src override must never enter the profile's memory. The pairs
  // are then stripped from the result so History stays lean (they live in
  // profile.matchMemory). Any failure here degrades silently — the transfer
  // result is already complete.
  try {
    const mmRootObj = _transferProfile?.tree?.objectType || _transferProfile?.tree?.childSObject;
    const mmPairs = mmRootObj ? (result.summary?.[mmRootObj]?.idPairs || []) : [];
    if (mmPairs.length) {
      if (_transferProfile?.id
          && _orgKey(_transferSrc.orgUrl) === _orgKey(_transferProfile.sourceOrg || '')) {
        await window.sftkLearnPairs?.(_transferProfile.id, _transferTgt.orgUrl, mmPairs);
      }
      delete result.summary[mmRootObj].idPairs;
    }
  } catch (_) { /* memory is an optimization — never fail the run for it */ }

  // Record activity & save to history (Feature 12: include org URLs for health tiles)
  recordActivity('transfer');
  _history.push({
    id:        genId('run'),
    profileId: _transferProfile?.id,
    profileName: _transferProfile?.name,
    // Set BOTH the *OrgUrl and sourceOrg/targetOrg keys: History (renderHistory)
    // and the Connected-Orgs "N transfers logged" counter read sourceOrg/
    // targetOrg, while health tiles read *OrgUrl. Reconcile entries set all
    // four — transfers must too, or they render "Unknown → Unknown".
    srcOrgUrl: _transferSrc?.orgUrl,
    tgtOrgUrl: _transferTgt?.orgUrl,
    sourceOrg: _transferSrc?.orgUrl,
    targetOrg: _transferTgt?.orgUrl,
    startedAt: new Date().toISOString(),
    ...result
  });
  await storageSaveHistory();

  // After ANY transfer that wrote records, both the profile diff AND the
  // org snapshots are stale. Re-refresh both in the background so the next
  // picker open / profile card render / Org Map view reflects the new state.
  // Fire-and-forget — failures surface as toasts. Only triggers when at
  // least one record was created (skip on pure-failed runs).
  if (_transferProfile?.id && !_transferDryRun) {
    const totalCreated = Object.values(result.summary || {}).reduce((n, s) => n + (s.created || 0), 0);
    if (totalCreated > 0) {
      // Only auto-refresh the diff when the run used the profile's OWN org
      // pair — refreshProfileState scans profile.sourceOrg/targetOrg, so
      // after an org-override run it would compare the wrong pair and mark
      // the just-transferred records as still "missing".
      if (_transferOrgOverride.src || _transferOrgOverride.tgt) {
        showToast('Diff not auto-refreshed — this run used a different org pair than the saved profile.', 'info', 4500);
      } else {
        window.refreshProfileState?.(_transferProfile.id);
      }
    }
  }

  // Show history link
  const log = eid('dsTrProgLog');
  if (log) {
    const done = document.createElement('div');
    done.className = 'ds-done-row';
    done.innerHTML = `<button class="ds-btn" id="dsViewHistory">📜 View History</button>`;
    log.appendChild(done);

    // After the run finishes, scroll the panel back to the TOP so the
    // diagnostic rows are visible — they're far more actionable than the
    // 20-deep "Required fields are missing" tail. Then bring the panel
    // itself into view in case the page has been scrolled past it.
    log.scrollTop = 0;
    log.scrollIntoView({ behavior: 'smooth', block: 'start' });
    eid('dsViewHistory')?.addEventListener('click', () => {
      document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('[data-view="history"]')?.classList.add('active');
      _currentView = 'history';
      renderHistory();
    });
  }

  if (btn) btn.disabled = false;
}


// ════════════════════════════════════════════════════════════════
// M1 — FAN-OUT RUNNER: one deployment against N target orgs
// ════════════════════════════════════════════════════════════════
// The engine already takes any (profile, src, tgt) — fan-out is a sequential
// loop with per-org sessions, per-org history entries and a result log
// (the picklist P2 bulk-apply pattern). Fresh idMap per target by design:
// targets share nothing. No dry-run here — validate the profile on one pair
// first (the modal says so).
window.openFanOut = async function (profileId, opts = {}) {
  const p = _profiles.find(x => x.id === profileId);
  if (!p || !p.tree) { showToast('Deployment not found', 'error'); return; }
  // opts.src: flow override — the Sync Ring passes its source of truth so a
  // deployment born on a different pair still pushes golden-org → targets
  // (same rule as ring scans, user bug report). opts.preselect: target urls
  // to pre-check (the ring passes its targets).
  // Source resolution: explicit override (the ring's 🌐 push) → the ring's
  // source of truth when a ring is configured (user directive 2026-07-17:
  // multi-org surfaces always flow FROM the source of truth, not from a
  // deployment's birth pair) → the deployment's own source.
  const ringSrc = (typeof _ring === 'object' && _ring?.sourceUrl && (_ring.orgs || []).length >= 2)
    ? _ring.sourceUrl : '';
  const srcUrl = opts.src || ringSrc || p.sourceOrg || _workingPair.src;
  if (!srcUrl) { showToast('Set a source org on the deployment first', 'error'); return; }
  const fromRing = !!ringSrc && _orgKey(srcUrl) === _orgKey(ringSrc);
  const preKeys = (opts.preselect || []).map(u => _orgKey(u));

  const candidates = allMapOrgs().filter(o => _orgKey(o.url) !== _orgKey(srcUrl));
  if (!candidates.length) { showToast('No other orgs known — open them in Chrome tabs first', 'warning', 5000); return; }

  const rows = candidates.map(o => `
    <label class="ds-fanout-org">
      <input type="checkbox" class="ds-fanout-cb" value="${esc(o.url)}"
             ${(preKeys.length ? preKeys.includes(_orgKey(o.url)) : _orgKey(o.url) === _orgKey(p.targetOrg || '')) ? 'checked' : ''}>
      <span>${esc(orgOptionLabel(o.url, o.label))}</span>
      ${prodBadge(o.url)}
    </label>`).join('');

  showModal(`
    <div class="ds-modal-header">🌐 Run “${esc(p.name)}” against multiple orgs</div>
    <div class="ds-modal-body">
      <p style="font-size:12.5px">Source: <strong>${esc(orgLabel(srcUrl))}</strong>${fromRing ? ` <span title="Your Sync Ring's source of truth — every multi-org run flows FROM it. The source org itself is never listed as a target. Change it in 🔄 Sync Ring or the topbar chip.">👑 source of truth</span>` : ''} → pick the targets.
      Runs are sequential; each org gets its own History entry. Orgs without an open tab are skipped.</p>
      <div class="ds-fanout-list">${rows}</div>
      <div class="ds-pk-hint" style="margin-top:8px">💡 Validate the deployment with a 🧪 dry run on one pair before fanning out —
      fan-out runs are real writes. Production targets will ask for their typed confirmation.</div>
    </div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn ds-btn-primary" id="dsFanoutGo">🌐 Run fan-out</button>
    </div>`);

  eid('dsFanoutGo')?.addEventListener('click', async () => {
    const targets = [...document.querySelectorAll('.ds-fanout-cb:checked')].map(c => c.value);
    if (!targets.length) { showToast('Pick at least one target org', 'warning'); return; }
    closeModal();

    // One typed confirm covering every production target up front.
    for (const t of targets) {
      if (cachedOrgType(t) === 'production') {
        const ok = await confirmTypedProd(orgLabel(t), `fan-out deploy "${p.name}" into PRODUCTION`);
        if (!ok) { showToast('Fan-out cancelled', 'info'); return; }
      }
    }
    await runFanOut(p, srcUrl, targets);
  });
};

async function runFanOut(p, srcUrl, targets) {
  // Result surface: a modal-free inline panel at the top of the current view.
  const host = eid('dsMain');
  const panel = document.createElement('div');
  panel.className = 'ds-fanout-panel';
  panel.innerHTML = `<div class="ds-pk-res-title">🌐 Fan-out: ${esc(p.name)} — ${targets.length} target(s)</div>
    <div id="dsFanoutLog"></div>`;
  host?.prepend(panel);
  const log = (org, icon, msg) => {
    const el = panel.querySelector('#dsFanoutLog');
    if (!el) return;
    const row = document.createElement('div');
    row.className = 'ds-pk-res-row';
    row.innerHTML = org
      ? `<span>${icon} <strong>${esc(orgLabel(org))}</strong></span><span>${esc(msg)}</span>`
      : `<span>${icon}</span><span><strong>${esc(msg)}</strong></span>`;
    el.appendChild(row);
  };

  const srcSess = await getOrgSession(srcUrl);
  if (!srcSess) { log(srcUrl, '❌', 'Source org has no open tab — aborted'); return; }

  let okOrgs = 0, failOrgs = 0, skipOrgs = 0;
  for (const tgtUrl of targets) {
    const tgtSess = await getOrgSession(tgtUrl);
    if (!tgtSess) { skipOrgs++; log(tgtUrl, '⏭', 'skipped — org not open in a tab'); continue; }
    log(tgtUrl, '⏳', 'running…');
    try {
      const result = await sendBg({
        type: 'SF_EXECUTE_PROFILE_TRANSFER',
        profile: p,
        srcOrgUrl: srcSess.orgUrl, srcSid: srcSess.sid,
        tgtOrgUrl: tgtSess.orgUrl, tgtSid: tgtSess.sid,
      });
      if (result?.error) throw new Error(result.error);
      // M3c — match memory per target org. Same M-followup guard as
      // runTransfer: a ring push passes opts.src (the ring's source of
      // truth), so only learn when that source IS the profile's own source.
      // Strip the pairs before the history push below keeps them on disk.
      try {
        const mmRootObj = p.tree?.objectType || p.tree?.childSObject;
        const mmPairs = mmRootObj ? (result.summary?.[mmRootObj]?.idPairs || []) : [];
        if (mmPairs.length) {
          if (_orgKey(srcSess.orgUrl) === _orgKey(p.sourceOrg || '')) {
            await window.sftkLearnPairs?.(p.id, tgtSess.orgUrl, mmPairs);
          }
          delete result.summary[mmRootObj].idPairs;
        }
      } catch (_) { /* memory is an optimization — never fail the run for it */ }
      _history.push({
        id: genId('run'), profileId: p.id,
        srcOrgUrl: srcSess.orgUrl, tgtOrgUrl: tgtSess.orgUrl,
        sourceOrg: srcSess.orgUrl, targetOrg: tgtSess.orgUrl,
        startedAt: new Date().toISOString(),
        ...result,
        // AFTER the spread — the engine result carries its own profileName
        // and would clobber the tag otherwise.
        profileName: `${p.name} (fan-out)`,
      });
      const created = Object.values(result.summary || {}).reduce((n, s) => n + (s.created || 0), 0);
      const failed  = Object.values(result.summary || {}).reduce((n, s) => n + (s.failed || 0), 0);
      if (result.status === 'success') { okOrgs++; log(tgtUrl, '✅', `${created} record(s) written`); }
      else { failOrgs++; log(tgtUrl, '⚠', `${created} written, ${failed} failed — see History`); }
    } catch (e) {
      failOrgs++;
      const fe = (typeof sftkFriendlyError === 'function') ? sftkFriendlyError(e.message) : { message: e.message };
      log(tgtUrl, '❌', fe.message);
    }
  }
  await storageSaveHistory();
  log('', '🏁', `done — ${okOrgs} ok · ${failOrgs} with failures · ${skipOrgs} skipped`);
  showToast(`Fan-out complete: ${okOrgs}/${targets.length} orgs clean`, failOrgs ? 'warning' : 'success', 6000);
}
