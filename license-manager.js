// ============================================================
// License Manager Module — deactivate users & change licenses
// ============================================================
const LicenseManager = (() => {
  let _orgUrl = null;
  let _sid = null;
  let users = [];
  let selectedUserIds = new Set();
  let allProfiles = [];
  let currentFilter = 'active';

  // ── Public API ───────────────────────────────────────────
  function init(container, orgUrl, sid) {
    _orgUrl = orgUrl;
    _sid = sid;
    users = [];
    selectedUserIds.clear();
    allProfiles = [];
    renderTab(container);
  }

  function updateSession(orgUrl, sid) {
    _orgUrl = orgUrl;
    _sid = sid;
  }

  // ── Render ───────────────────────────────────────────────
  function renderTab(container) {
    container.innerHTML = `
      <div class="lm-wrap">

        <!-- License Overview panel -->
        <div class="lm-overview-panel" id="lmOverviewPanel">
          <div class="lm-overview-header" id="lmOverviewToggle">
            <span class="lm-overview-title">📊 License Overview</span>
            <div class="lm-overview-header-right">
              <span id="lmOverviewMeta" class="lm-overview-meta"></span>
              <span class="lm-overview-chevron" id="lmOverviewChevron">▼</span>
            </div>
          </div>
          <div id="lmOverviewBody">
            <div id="lmOverviewLoading" class="uc-loading" style="padding:8px 0">
              ${sftkCatSm('Loading licenses…')}
            </div>
            <div id="lmOverviewContent" style="display:none"></div>
          </div>
        </div>

        <!-- Search & filter toolbar -->
        <div class="lm-toolbar">
          <input class="search-input lm-search" id="lmSearch"
            placeholder="🔍 Search by name or email…" autocomplete="off">
          <div class="lm-filter-btns">
            <button class="lm-filter-btn active" data-filter="active">Active</button>
            <button class="lm-filter-btn" data-filter="inactive">Inactive</button>
            <button class="lm-filter-btn" data-filter="all">All</button>
          </div>
          <button class="btn btn-secondary btn-sm" id="lmSearchBtn">Search</button>
        </div>

        <!-- Loading -->
        <div id="lmLoading" class="uc-loading" style="display:none">
          ${sftkCatSm('Loading users…')}
        </div>

        <!-- Search hint (shown before any search) -->
        <div id="lmHint" class="lm-hint">
          🔍 Search by name or email, then click <strong>Search</strong> to browse users.<br>
          Leave the search box empty to list all users (up to 100).
        </div>

        <!-- Empty -->
        <div id="lmEmpty" class="uc-empty-msg" style="display:none">No users found.</div>

        <!-- Results -->
        <div id="lmResults" style="display:none">
          <div class="lm-results-header">
            <label class="lm-select-all-wrap">
              <input type="checkbox" id="lmSelectAll"> <span id="lmResultCount"></span>
            </label>
          </div>
          <div class="lm-user-list" id="lmUserList"></div>
        </div>

        <!-- Bulk action bar -->
        <div id="lmActions" class="lm-actions" style="display:none">
          <span id="lmSelCount" class="lm-sel-count">0 selected</span>
          <button class="btn btn-warning btn-sm" id="lmDeactivateBtn">⛔ Deactivate</button>
          <button class="btn btn-primary btn-sm" id="lmReactivateBtn">✅ Reactivate</button>
          <button class="btn btn-secondary btn-sm" id="lmChangeLicenseBtn">🔑 Change License</button>
        </div>

        <!-- Result message -->
        <div id="lmResult" style="display:none"></div>
      </div>
    `;

    // Search
    document.getElementById('lmSearch').addEventListener('keydown', e => {
      if (e.key === 'Enter') doSearch();
    });
    document.getElementById('lmSearchBtn').addEventListener('click', doSearch);

    // Filters
    document.querySelectorAll('.lm-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.lm-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
      });
    });

    // Select-all
    document.getElementById('lmSelectAll').addEventListener('change', e => {
      selectedUserIds.clear();
      if (e.target.checked) users.forEach(u => selectedUserIds.add(u.Id));
      renderUserList();
      updateActions();
    });

    // Bulk actions
    document.getElementById('lmDeactivateBtn').addEventListener('click', () => onBulkAction('deactivate'));
    document.getElementById('lmReactivateBtn').addEventListener('click', () => onBulkAction('reactivate'));
    document.getElementById('lmChangeLicenseBtn').addEventListener('click', onChangeLicense);

    // Collapsible overview
    document.getElementById('lmOverviewToggle').addEventListener('click', () => {
      const body    = document.getElementById('lmOverviewBody');
      const chevron = document.getElementById('lmOverviewChevron');
      const collapsed = body.style.display === 'none';
      body.style.display    = collapsed ? '' : 'none';
      chevron.textContent   = collapsed ? '▼' : '▶';
    });

    // Auto-load overview
    loadLicenseOverview();
  }

  // ── License Overview ─────────────────────────────────────
  async function loadLicenseOverview() {
    const loadingEl = document.getElementById('lmOverviewLoading');
    const contentEl = document.getElementById('lmOverviewContent');
    const metaEl    = document.getElementById('lmOverviewMeta');

    loadingEl.style.display = '';
    contentEl.style.display = 'none';

    const r = await bg({
      type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid,
      query: `SELECT Id,Name,TotalLicenses,UsedLicenses FROM UserLicense ORDER BY Name`,
      tooling: false
    });

    loadingEl.style.display = 'none';

    if (r.error) {
      contentEl.innerHTML = `<div class="lm-overview-error">Could not load licenses: ${esc(r.error)}</div>`;
      contentEl.style.display = '';
      return;
    }

    const licenses = (r.records || []).filter(l => l.TotalLicenses > 0);
    renderLicenseOverview(licenses);

    // Summary in header
    const totalFree = licenses.reduce((s, l) => s + Math.max(0, l.TotalLicenses - l.UsedLicenses), 0);
    const totalAll  = licenses.reduce((s, l) => s + l.TotalLicenses, 0);
    metaEl.textContent = `${totalFree} free of ${totalAll}`;
  }

  function renderLicenseOverview(licenses) {
    const contentEl = document.getElementById('lmOverviewContent');

    if (licenses.length === 0) {
      contentEl.innerHTML = `<div class="uc-empty-msg">No license data found.</div>`;
      contentEl.style.display = '';
      return;
    }

    // Sort: critical (0 free) → low (≤20% free) → normal
    licenses.sort((a, b) => {
      const freeA = a.TotalLicenses - a.UsedLicenses;
      const freeB = b.TotalLicenses - b.UsedLicenses;
      const pctA  = freeA / a.TotalLicenses;
      const pctB  = freeB / b.TotalLicenses;
      return pctA - pctB; // most-used first
    });

    let html = '';
    for (const lic of licenses) {
      const used  = lic.UsedLicenses;
      const total = lic.TotalLicenses;
      const free  = Math.max(0, total - used);
      const pct   = total > 0 ? Math.round((used / total) * 100) : 0;

      let barClass = 'lm-bar-normal';
      let freeClass = '';
      if (free === 0)          { barClass = 'lm-bar-full';   freeClass = 'lm-free-danger'; }
      else if (pct >= 80)      { barClass = 'lm-bar-warn';   freeClass = 'lm-free-warn'; }

      html += `
        <div class="lm-lic-row">
          <div class="lm-lic-name" title="${esc(lic.Name)}">${esc(lic.Name)}</div>
          <div class="lm-lic-bar-wrap">
            <div class="lm-lic-bar">
              <div class="lm-lic-fill ${barClass}" style="width:${pct}%"></div>
            </div>
          </div>
          <div class="lm-lic-counts">
            <span class="lm-lic-used">${used}/${total}</span>
            <span class="lm-lic-free ${freeClass}">${free} free</span>
          </div>
        </div>`;
    }

    contentEl.innerHTML = html;
    contentEl.style.display = '';
  }

  // ── Search ───────────────────────────────────────────────
  async function doSearch() {
    const q = (document.getElementById('lmSearch').value || '').trim();

    document.getElementById('lmHint').style.display    = 'none';
    document.getElementById('lmLoading').style.display = '';
    document.getElementById('lmResults').style.display = 'none';
    document.getElementById('lmEmpty').style.display   = 'none';
    document.getElementById('lmActions').style.display = 'none';
    document.getElementById('lmResult').style.display  = 'none';
    selectedUserIds.clear();

    const safe = q.replace(/'/g, "\\'");
    const filters = [];
    if (currentFilter === 'active')   filters.push('IsActive=true');
    if (currentFilter === 'inactive') filters.push('IsActive=false');
    if (q.length >= 2) filters.push(`(Name LIKE '%${safe}%' OR Username LIKE '%${safe}%' OR Email LIKE '%${safe}%')`);

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const soql = `SELECT Id,Name,Username,IsActive,Profile.Name,Profile.Id,` +
      `Profile.UserLicense.Name,Profile.UserLicense.Id ` +
      `FROM User ${where} ORDER BY Name LIMIT 100`;

    const res = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, query: soql, tooling: false });
    document.getElementById('lmLoading').style.display = 'none';

    if (res.error) {
      const eMsg = res.error === 'SESSION_EXPIRED' ? 'Session expired — log back into Salesforce and retry' : `Error: ${esc(res.error)}`;
      showLmResult(eMsg, true); return;
    }

    users = res.records || [];

    if (users.length === 0) {
      document.getElementById('lmEmpty').style.display = '';
      return;
    }

    renderUserList();
    document.getElementById('lmResults').style.display = '';
    document.getElementById('lmResultCount').textContent =
      `${users.length} user${users.length !== 1 ? 's' : ''}`;
    updateActions();
  }

  // ── Render user list ─────────────────────────────────────
  function renderUserList() {
    const list = document.getElementById('lmUserList');
    list.innerHTML = '';

    for (const u of users) {
      const row = document.createElement('div');
      row.className = `lm-user-row${u.IsActive ? '' : ' lm-user-inactive'}`;
      row.innerHTML = `
        <input type="checkbox" class="lm-user-cb version-checkbox" data-id="${esc(u.Id)}"
          ${selectedUserIds.has(u.Id) ? 'checked' : ''}>
        <div class="lm-user-info">
          <div class="lm-user-name">${esc(u.Name)}</div>
          <div class="lm-user-meta">${esc(u.Username)}</div>
        </div>
        <div class="lm-user-right">
          <div class="lm-profile-name">${esc(u.Profile?.Name || '—')}</div>
          <div class="lm-license-pill">${esc(u.Profile?.UserLicense?.Name || '—')}</div>
        </div>
        <span class="lm-status-dot ${u.IsActive ? 'lm-dot-active' : 'lm-dot-inactive'}"
          title="${u.IsActive ? 'Active' : 'Inactive'}"></span>
      `;
      row.querySelector('.lm-user-cb').addEventListener('change', e => {
        if (e.target.checked) selectedUserIds.add(u.Id);
        else selectedUserIds.delete(u.Id);
        updateSelectAll();
        updateActions();
      });
      list.appendChild(row);
    }

    updateSelectAll();
  }

  function updateSelectAll() {
    const cb = document.getElementById('lmSelectAll');
    if (!cb) return;
    const total = users.length;
    const sel   = selectedUserIds.size;
    cb.checked       = sel === total && total > 0;
    cb.indeterminate = sel > 0 && sel < total;
  }

  function updateActions() {
    const count = selectedUserIds.size;
    const bar = document.getElementById('lmActions');
    if (count === 0) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    document.getElementById('lmSelCount').textContent = `${count} selected`;
  }

  // ── Deactivate / Reactivate ──────────────────────────────
  async function onBulkAction(action) {
    const selected = users.filter(u => selectedUserIds.has(u.Id));
    if (selected.length === 0) return;

    const isDeactivate = action === 'deactivate';
    const icon  = isDeactivate ? '⛔' : '✅';
    const verb  = isDeactivate ? 'Deactivate' : 'Reactivate';
    const cls   = isDeactivate ? 'btn-warning' : 'btn-primary';
    const nameList = selected.map(u =>
      `<li>${esc(u.Name)} <span class="lm-license-pill">${esc(u.Profile?.UserLicense?.Name || '')}</span></li>`
    ).join('');

    const ok = await confirmModal(icon,
      `${verb} ${selected.length} user${selected.length > 1 ? 's' : ''}?`,
      `<ul class="modal-list">${nameList}</ul>`,
      verb, cls);
    if (!ok) return;

    const errors = [];
    let doneCount = 0;
    for (const u of selected) {
      const r = await bg({
        type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid,
        path: `services/data/v62.0/sobjects/User/${u.Id}`,
        body: { IsActive: !isDeactivate }
      });
      if (r.error) errors.push(`${u.Name}: ${r.error}`);
      else doneCount++;
    }

    // Build result first — doSearch() hides #lmResult at its start,
    // so we refresh the list first then display the outcome
    let resultMsg = '';
    let isErr = false;
    if (errors.length === 0) {
      resultMsg = `✅ ${doneCount} user${doneCount > 1 ? 's' : ''} ${isDeactivate ? 'deactivated' : 'reactivated'}.`;
    } else {
      const errHtml = errors.map(e => `<li>${esc(e)}</li>`).join('');
      resultMsg = `⚠️ ${doneCount} succeeded, ${errors.length} failed:<ul style="margin-top:4px;padding-left:14px">${errHtml}</ul>`;
      isErr = true;
    }
    await doSearch();
    showLmResult(resultMsg, isErr);
  }

  // ── Change License ────────────────────────────────────────
  async function onChangeLicense() {
    const selected = users.filter(u => selectedUserIds.has(u.Id));
    if (selected.length === 0) return;

    // Load profiles on first use
    if (allProfiles.length === 0) {
      const btn = document.getElementById('lmChangeLicenseBtn');
      btn.textContent = '⏳ Loading…';
      btn.disabled = true;
      const r = await bg({
        type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid,
        query: `SELECT Id,Name,UserLicenseId,UserLicense.Name FROM Profile ` +
               `WHERE UserType='Standard' ORDER BY UserLicense.Name,Name`,
        tooling: false
      });
      btn.textContent = '🔑 Change License';
      btn.disabled = false;
      if (r.error) { showLmResult(`Error loading profiles: ${esc(r.error)}`, true); return; }
      allProfiles = r.records || [];
    }

    showChangeLicenseModal(selected);
  }

  function showChangeLicenseModal(selected) {
    // Group profiles by license name
    const byLicense = {};
    for (const p of allProfiles) {
      const lic = p.UserLicense?.Name || 'Unknown';
      if (!byLicense[lic]) byLicense[lic] = [];
      byLicense[lic].push(p);
    }

    // Build a flat list of {id, name, license} for the custom picker
    const profileOptions = [];
    for (const [lic, profiles] of Object.entries(byLicense)) {
      for (const p of profiles) {
        profileOptions.push({ id: p.Id, name: p.Name, license: lic });
      }
    }

    const nameList = selected.map(u =>
      `<li>${esc(u.Name)} <span class="lm-license-pill">${esc(u.Profile?.UserLicense?.Name || '—')}</span></li>`
    ).join('');

    showLmModal(`
      <div class="modal-header" style="color:var(--draft-color)">
        <span class="modal-icon">🔑</span>
        <h2>Change License / Profile</h2>
      </div>
      <div class="modal-body">
        <p style="margin-bottom:8px;font-size:12px">
          Select the new <strong>Profile</strong> (the license follows the profile). Applies to:
        </p>
        <ul class="modal-list" style="margin-bottom:12px">${nameList}</ul>
        <label class="uc-picker-label" style="margin-bottom:4px">Target Profile</label>

        <!-- Custom searchable profile picker -->
        <div class="lm-pp-wrap" id="lmProfilePicker">
          <div class="lm-pp-search-row">
            <span class="lm-pp-search-icon">🔍</span>
            <input class="lm-pp-search" id="lmProfileSearch" type="text"
                   placeholder="Search profiles or licenses…" autocomplete="off" spellcheck="false">
          </div>
          <div class="lm-pp-list" id="lmProfileList"></div>
        </div>
        <!-- Hidden input carries the selected profile id -->
        <input type="hidden" id="lmProfileSelect" value="">

        <div id="lmLicensePreview" class="lm-license-preview" style="display:none"></div>
        <div class="lm-change-warn">
          ⚠️ Make sure sufficient licenses are available. Users may lose access to features tied to their current license.
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="lmModalCancel">Cancel</button>
        <button class="btn btn-primary" id="lmModalConfirm" disabled>Apply</button>
      </div>
    `);

    // ── Picker logic ──────────────────────────────────────────
    let selectedProfileId  = '';
    let selectedLicenseName = '';

    function renderProfileList(filter) {
      const q = (filter || '').toLowerCase().trim();
      const list = document.getElementById('lmProfileList');
      if (!list) return;

      // Group by license, filtering by name or license
      let html = '';
      let anyVisible = false;
      for (const [lic, profiles] of Object.entries(byLicense)) {
        const visible = profiles.filter(p =>
          !q ||
          p.Name.toLowerCase().includes(q) ||
          lic.toLowerCase().includes(q)
        );
        if (!visible.length) continue;
        anyVisible = true;
        html += `<div class="lm-pp-group-hdr">${esc(lic)}</div>`;
        for (const p of visible) {
          const isSel = p.Id === selectedProfileId;
          html += `
            <div class="lm-pp-option${isSel ? ' lm-pp-option--selected' : ''}"
                 data-id="${esc(p.Id)}" data-license="${esc(lic)}">
              <div class="lm-pp-opt-name">${esc(p.Name)}</div>
              <span class="lm-pp-lic-badge">${esc(lic)}</span>
            </div>`;
        }
      }
      if (!anyVisible) html = `<div class="lm-pp-empty">No profiles match "${esc(q)}"</div>`;
      list.innerHTML = html;

      // Wire click handlers
      list.querySelectorAll('.lm-pp-option').forEach(row => {
        row.addEventListener('click', () => {
          selectedProfileId   = row.dataset.id;
          selectedLicenseName = row.dataset.license;
          document.getElementById('lmProfileSelect').value = selectedProfileId;
          // Update preview + button
          const preview = document.getElementById('lmLicensePreview');
          const btn     = document.getElementById('lmModalConfirm');
          if (preview) { preview.textContent = `New license: ${selectedLicenseName}`; preview.style.display = ''; }
          if (btn)     btn.disabled = false;
          // Re-render to highlight selection
          renderProfileList(document.getElementById('lmProfileSearch')?.value || '');
        });
      });
    }

    renderProfileList('');

    document.getElementById('lmProfileSearch').addEventListener('input', e => {
      renderProfileList(e.target.value);
    });

    document.getElementById('lmModalCancel').addEventListener('click', closeLmModal);

    document.getElementById('lmModalConfirm').addEventListener('click', async () => {
      const profileId = document.getElementById('lmProfileSelect').value;
      if (!profileId) return;
      const btn = document.getElementById('lmModalConfirm');
      btn.disabled = true;
      btn.textContent = '⏳ Applying…';

      const errors = [];
      let doneCount = 0;
      for (const u of selected) {
        const r = await bg({
          type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid,
          path: `services/data/v62.0/sobjects/User/${u.Id}`,
          body: { ProfileId: profileId }
        });
        if (r.error) errors.push(`${u.Name}: ${r.error}`);
        else doneCount++;
      }

      closeLmModal();

      // Build result first — doSearch() hides #lmResult, so refresh then show
      let resultMsg = '';
      let isErr = false;
      if (errors.length === 0) {
        resultMsg = `✅ License/Profile updated for ${doneCount} user${doneCount > 1 ? 's' : ''}.`;
      } else {
        const errHtml = errors.map(e => `<li>${esc(e)}</li>`).join('');
        resultMsg = `⚠️ ${doneCount} succeeded, ${errors.length} failed:<ul style="margin-top:4px;padding-left:14px">${errHtml}</ul>`;
        isErr = true;
      }
      await doSearch();
      showLmResult(resultMsg, isErr);
    });
  }

  // ── Modal helpers ────────────────────────────────────────
  function confirmModal(icon, title, bodyHtml, confirmText, confirmClass) {
    return new Promise(resolve => {
      showLmModal(`
        <div class="modal-header modal-warn">
          <span class="modal-icon">${icon}</span>
          <h2>${title}</h2>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="lmModalCancel">Cancel</button>
          <button class="btn ${confirmClass}" id="lmModalConfirm">${confirmText}</button>
        </div>
      `);
      document.getElementById('lmModalCancel').addEventListener('click', () => { closeLmModal(); resolve(false); });
      document.getElementById('lmModalConfirm').addEventListener('click', () => { closeLmModal(); resolve(true); });
    });
  }

  function showLmModal(html) {
    const overlay = document.getElementById('modalOverlay');
    document.getElementById('modalBox').innerHTML = html;
    overlay.style.display = '';
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeLmModal();
    }, { once: true });
  }

  function closeLmModal() {
    document.getElementById('modalOverlay').style.display = 'none';
    document.getElementById('modalBox').innerHTML = '';
  }

  function showLmResult(html, isError) {
    const el = document.getElementById('lmResult');
    el.className = isError ? 'error-banner' : 'result-toast';
    el.innerHTML  = isError ? html : `<div class="toast-success">${html}</div>`;
    el.style.display = '';
    if (!isError) setTimeout(() => { el.style.display = 'none'; }, 6000);
  }

  function esc(str) {
    return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function bgRaw(msg) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(msg, resp => {
        resolve(resp || { error: chrome.runtime.lastError?.message || 'No response' });
      });
    });
  }

  async function bg(msg) {
    const _t   = window.SFToolkitDebug?.enabled ? Date.now() : null;
    const resp = await bgRaw(msg);
    // ── Debug logging ────────────────────────────────────────
    if (window.SFToolkitDebug?.enabled) {
      const dur = _t !== null ? Date.now() - _t : null;
      const tag = msg.query?.substring(0, 80) || msg.path || msg.sobject || '';
      window.SFToolkitDebug.log('licenses',
        resp?.error === 'SESSION_EXPIRED' ? 'session' : resp?.error ? 'error' : 'api',
        `${msg.type}${tag ? '  ' + tag : ''}`, resp?.error || null, dur);
    }
    if (resp?.error !== 'SESSION_EXPIRED') return resp;
    const fresh = await bgRaw({ type: 'GET_SF_SESSION', activeTabUrl: _orgUrl });
    if (fresh?.sid && fresh?.orgUrl) {
      _orgUrl = fresh.orgUrl;
      _sid    = fresh.sid;
      const retry = msg.sid !== undefined
        ? { ...msg, orgUrl: fresh.orgUrl, sid: fresh.sid }
        : msg;
      return bgRaw(retry);
    }
    return resp;
  }

  return { init, updateSession };
})();
