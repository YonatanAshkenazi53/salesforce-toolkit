// ============================================================
// User Copy Module — copy profile, permission sets,
// public groups & user settings between Salesforce users
// ============================================================
const UserCopy = (() => {
  let _orgUrl = null;
  let _sid    = null;

  // Selected users
  let sourceUser = null;
  let targetUser = null;

  // Fetched data
  let allUsers       = [];       // pre-loaded on init
  let usersLoadState = 'idle';   // 'idle' | 'loading' | 'done' | 'error'
  let sourcePermSets   = [];
  let targetPermSetIds = new Set();
  let sourceGroups     = [];
  let targetGroupIds   = new Set();
  let sourceUserFields = {};
  let targetUserFields = {};

  // User-record permission booleans (Marketing User, Flow User, Service Cloud
  // User, etc. — the checkboxes on the User detail page). Populated once via
  // describe so we only query fields that actually exist in this org.
  // Shape: [{ name: 'UserPermissionsMarketingUser', label: 'Marketing User' }]
  let userPermFields  = [];
  let sourceUserPerms = {};
  let targetUserPerms = {};

  // ── Public API ───────────────────────────────────────────
  function init(container, orgUrl, sid) {
    _orgUrl = orgUrl;
    _sid    = sid;
    sourceUser = null;
    targetUser = null;
    allUsers   = [];
    usersLoadState = 'idle';
    renderTab(container);
    loadAllUsers();          // pre-load the user list immediately
    loadUserPermFields();    // discover available UserPermissions* fields
  }

  // Discover which UserPermissions* boolean fields are present in this org.
  // Fields are gated by feature licenses + enabled features, so the set
  // varies org-to-org — describe is the only reliable source of truth.
  async function loadUserPermFields() {
    const res = await bg({
      type: 'SF_REST_GET', orgUrl: _orgUrl, sid: _sid,
      path: 'services/data/v62.0/sobjects/User/describe'
    });
    if (res.error || !Array.isArray(res.fields)) return;
    userPermFields = res.fields
      .filter(f =>
        typeof f.name === 'string' &&
        f.name.startsWith('UserPermissions') &&
        f.type === 'boolean' &&
        f.updateable !== false
      )
      .map(f => ({ name: f.name, label: f.label || f.name }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  function updateSession(orgUrl, sid) {
    _orgUrl = orgUrl;
    _sid    = sid;
  }

  // ── Pre-load all active users ────────────────────────────
  async function loadAllUsers() {
    usersLoadState = 'loading';
    setPickerPlaceholder('⏳ Loading users…');

    const soql = `SELECT Id,Name,Username,Profile.Name,Profile.Id,` +
      `Profile.UserLicense.Id,Profile.UserLicense.Name,UserType ` +
      `FROM User WHERE IsActive=true ORDER BY Name`;

    const res = await bg({
      type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid,
      query: soql, tooling: false
    });

    if (res.error) {
      usersLoadState = 'error';
      const ph = res.error === 'SESSION_EXPIRED' ? '❌ Session expired — log back in' : '❌ Failed to load users';
      setPickerPlaceholder(ph);
      return;
    }

    allUsers = res.records || [];
    usersLoadState = 'done';
    setPickerPlaceholder(`🔍 Type to filter ${allUsers.length} users…`);

    // If a dropdown is already OPEN (the input was focused while we were
    // still loading — typical in the popout, which autofocuses), its content
    // is stuck on the stale "⏳ Loading users…" row. Re-render it now that
    // the data is here; re-focusing wouldn't help since the input never
    // lost focus (no new focus event fires).
    [['ucSourceInput', 'ucSourceDrop', 'source'], ['ucTargetInput', 'ucTargetDrop', 'target']]
      .forEach(([inputId, dropId, role]) => {
        const input = document.getElementById(inputId);
        const drop  = document.getElementById(dropId);
        if (input && drop && drop.style.display !== 'none') {
          showFilteredDrop(input, drop, role);
        }
      });
  }

  function setPickerPlaceholder(text) {
    ['ucSourceInput', 'ucTargetInput'].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.style.display !== 'none') el.placeholder = text;
    });
  }

  // ── Tab HTML ─────────────────────────────────────────────
  function renderTab(container) {
    container.innerHTML = `
      <div class="uc-wrap">

        <!-- Source picker -->
        <div class="uc-picker-block">
          <div class="uc-picker-label">📤 Copy FROM</div>
          <div class="uc-picker" id="ucSourcePicker">
            <input class="search-input uc-search" id="ucSourceInput"
              placeholder="⏳ Loading users…" autocomplete="off">
            <div class="uc-dropdown" id="ucSourceDrop" style="display:none"></div>
            <div class="uc-chip-wrap" id="ucSourceChip" style="display:none"></div>
          </div>
        </div>

        <div class="uc-arrow">↓</div>

        <!-- Target picker -->
        <div class="uc-picker-block">
          <div class="uc-picker-label">📥 Copy TO</div>
          <div class="uc-picker" id="ucTargetPicker">
            <input class="search-input uc-search" id="ucTargetInput"
              placeholder="⏳ Loading users…" autocomplete="off">
            <div class="uc-dropdown" id="ucTargetDrop" style="display:none"></div>
            <div class="uc-chip-wrap" id="ucTargetChip" style="display:none"></div>
          </div>
        </div>

        <!-- What to copy options -->
        <div class="uc-options">
          <div class="uc-options-header">
            <span class="uc-options-title">📋 What to copy</span>
            <label class="uc-opt-all-label">
              <input type="checkbox" id="ucOptAll" checked> All
            </label>
          </div>
          <div class="uc-options-grid">
            <label class="uc-opt-label">
              <input type="checkbox" class="uc-opt-cb" id="ucOptProfile" checked>
              👤 Profile
            </label>
            <label class="uc-opt-label">
              <input type="checkbox" class="uc-opt-cb" id="ucOptPermSets" checked>
              🔑 Permission Sets
            </label>
            <label class="uc-opt-label">
              <input type="checkbox" class="uc-opt-cb" id="ucOptGroups" checked>
              👥 Public Groups
            </label>
            <label class="uc-opt-label">
              <input type="checkbox" class="uc-opt-cb" id="ucOptUserPerms" checked>
              🛡️ User Permissions
            </label>
            <label class="uc-opt-label">
              <input type="checkbox" class="uc-opt-cb" id="ucOptSettings" checked>
              ⚙️ Locale &amp; Timezone
            </label>
          </div>
        </div>

        <!-- Loading -->
        <div id="ucLoading" class="uc-loading" style="display:none">
          ${sftkCatSm('Loading permissions…')}
        </div>

        <!-- Preview area -->
        <div id="ucPreview" style="display:none">
          <div id="ucPreviewInner"></div>
          <div class="uc-copy-btn-wrap">
            <button class="btn btn-primary btn-delete" id="ucCopyBtn">
              📋 Copy Selected
            </button>
          </div>
        </div>

        <!-- Result -->
        <div id="ucResult" style="display:none"></div>
      </div>
    `;

    setupPicker('ucSourceInput', 'ucSourceDrop', 'ucSourceChip', 'source');
    setupPicker('ucTargetInput', 'ucTargetDrop', 'ucTargetChip', 'target');
    setupOptions();
  }

  // ── Copy options (what to copy) ──────────────────────────
  function setupOptions() {
    const allCb = document.getElementById('ucOptAll');
    const cbs   = () => [...document.querySelectorAll('.uc-opt-cb')];

    allCb.addEventListener('change', () => {
      cbs().forEach(cb => cb.checked = allCb.checked);
      allCb.indeterminate = false;
      refreshPreviewSections();
    });

    document.querySelectorAll('.uc-opt-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const all  = cbs();
        const nAll = all.every(c => c.checked);
        const nAny = all.some(c => c.checked);
        allCb.checked       = nAll;
        allCb.indeterminate = !nAll && nAny;
        refreshPreviewSections();
      });
    });
  }

  function getOptions() {
    return {
      profile:   !!document.getElementById('ucOptProfile')?.checked,
      permSets:  !!document.getElementById('ucOptPermSets')?.checked,
      groups:    !!document.getElementById('ucOptGroups')?.checked,
      userPerms: !!document.getElementById('ucOptUserPerms')?.checked,
      settings:  !!document.getElementById('ucOptSettings')?.checked,
    };
  }

  function refreshPreviewSections() {
    // Only re-render if the preview is already visible
    if (document.getElementById('ucPreview')?.style.display === 'none') return;
    renderPreview();
  }

  // ── User picker (filters allUsers client-side) ───────────
  // Show full list on focus; filter as user types. The list always
  // renders whenever the input is focused — empty query shows everyone.
  function setupPicker(inputId, dropId, chipId, role) {
    const input = document.getElementById(inputId);
    const drop  = document.getElementById(dropId);

    input.addEventListener('input', () => showFilteredDrop(input, drop, role));
    input.addEventListener('focus', () => showFilteredDrop(input, drop, role));
    // Click too — if the input is ALREADY focused (autofocus, or the user
    // clicked back in after Esc) no focus event fires, and the list looked
    // permanently empty.
    input.addEventListener('click', () => showFilteredDrop(input, drop, role));
    input.addEventListener('blur',  () => {
      setTimeout(() => { drop.style.display = 'none'; }, 200);
    });
  }

  function showFilteredDrop(input, drop, role) {
    const q = input.value.trim();

    if (usersLoadState === 'loading') {
      drop.innerHTML = '<div class="uc-drop-item uc-drop-loading">⏳ Loading users…</div>';
      drop.style.display = '';
      return;
    }

    if (usersLoadState === 'error') {
      drop.innerHTML = '<div class="uc-drop-item uc-drop-empty">Failed to load users</div>';
      drop.style.display = '';
      return;
    }

    const lower     = q.toLowerCase();
    const otherUser = role === 'source' ? targetUser : sourceUser;

    // Filter out the already-chosen "other side" user, then match query.
    // Empty query → show everyone (capped to 50 for perf; scroll for the rest).
    let candidates = allUsers.filter(u => u.Id !== otherUser?.Id);
    if (lower) {
      candidates = candidates.filter(u =>
        u.Name.toLowerCase().includes(lower) ||
        u.Username.toLowerCase().includes(lower) ||
        (u.Profile?.Name || '').toLowerCase().includes(lower)
      );
    }
    const matches = candidates.slice(0, 50);

    drop.innerHTML = '';

    if (matches.length === 0) {
      drop.innerHTML = '<div class="uc-drop-item uc-drop-empty">No users found</div>';
      drop.style.display = '';
      return;
    }

    for (const u of matches) {
      const item = document.createElement('div');
      item.className = 'uc-drop-item';
      item.innerHTML = `
        <div class="uc-drop-name">${esc(u.Name)}</div>
        <div class="uc-drop-meta">${esc(u.Username)} · ${esc(u.Profile?.Name || '')}</div>
      `;
      item.addEventListener('mousedown', () => selectUser(role, u));
      drop.appendChild(item);
    }

    // Footer when the list was capped
    if (candidates.length > matches.length) {
      const foot = document.createElement('div');
      foot.className = 'uc-drop-item uc-drop-empty';
      foot.textContent = `Showing ${matches.length} of ${candidates.length} — keep typing to narrow…`;
      drop.appendChild(foot);
    }
    drop.style.display = '';
  }

  async function selectUser(role, user) {
    const inputId = role === 'source' ? 'ucSourceInput' : 'ucTargetInput';
    const dropId  = role === 'source' ? 'ucSourceDrop'  : 'ucTargetDrop';
    const chipId  = role === 'source' ? 'ucSourceChip'  : 'ucTargetChip';

    document.getElementById(inputId).style.display = 'none';
    document.getElementById(dropId).style.display  = 'none';

    const chip = document.getElementById(chipId);
    chip.style.display = '';
    chip.innerHTML = `
      <div class="uc-chip">
        <div class="uc-chip-info">
          <span class="uc-chip-name">${esc(user.Name)}</span>
          <span class="uc-chip-meta"> · ${esc(user.Username)}</span>
        </div>
        <span class="uc-chip-license">${esc(user.Profile?.UserLicense?.Name || user.UserType || '')}</span>
        <div class="uc-chip-actions">
          <button class="uc-chip-change" title="Select a different user">✎ Change</button>
          <button class="uc-chip-clear" title="Clear selection">✕</button>
        </div>
      </div>
    `;
    chip.querySelector('.uc-chip-change').addEventListener('click', () => clearUser(role, true));
    chip.querySelector('.uc-chip-clear').addEventListener('click', () => clearUser(role));

    if (role === 'source') sourceUser = user;
    else targetUser = user;

    document.getElementById('ucPreview').style.display = 'none';
    document.getElementById('ucResult').style.display  = 'none';

    if (sourceUser && targetUser) await loadAndPreview();
  }

  function clearUser(role, focus = false) {
    const inputId = role === 'source' ? 'ucSourceInput' : 'ucTargetInput';
    const chipId  = role === 'source' ? 'ucSourceChip'  : 'ucTargetChip';
    const input   = document.getElementById(inputId);
    input.value         = '';
    input.style.display = '';
    // Restore placeholder to match the current loading state
    if (usersLoadState === 'done') {
      input.placeholder = `🔍 Type to filter ${allUsers.length} users…`;
    } else if (usersLoadState === 'loading') {
      input.placeholder = '⏳ Loading users…';
    } else if (usersLoadState === 'error') {
      input.placeholder = '❌ Failed to load users';
    }
    document.getElementById(chipId).style.display = 'none';
    if (role === 'source') sourceUser = null;
    else targetUser = null;
    document.getElementById('ucPreview').style.display = 'none';
    document.getElementById('ucResult').style.display  = 'none';
    if (focus) input.focus();
  }

  // ── Load permissions & render preview ────────────────────
  async function loadAndPreview() {
    document.getElementById('ucLoading').style.display = '';
    document.getElementById('ucPreview').style.display = 'none';
    document.getElementById('ucResult').style.display  = 'none';

    try {
      // Permission sets on source
      const spsR = await bg({
        type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
        query: `SELECT PermissionSetId,PermissionSet.Label,PermissionSet.Name,` +
          `PermissionSet.LicenseId,PermissionSet.License.Name,PermissionSet.IsCustom ` +
          `FROM PermissionSetAssignment WHERE AssigneeId='${sourceUser.Id}' ` +
          `AND PermissionSet.IsOwnedByProfile=false ORDER BY PermissionSet.Label`
      });
      sourcePermSets = spsR.records || [];

      // Permission sets already on target
      const tpsR = await bg({
        type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
        query: `SELECT PermissionSetId FROM PermissionSetAssignment ` +
          `WHERE AssigneeId='${targetUser.Id}' AND PermissionSet.IsOwnedByProfile=false`
      });
      targetPermSetIds = new Set((tpsR.records || []).map(r => r.PermissionSetId));

      // Source user locale/tz fields
      const sfR = await bg({
        type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
        query: `SELECT LocaleSidKey,LanguageLocaleKey,TimeZoneSidKey,EmailEncodingKey ` +
          `FROM User WHERE Id='${sourceUser.Id}'`
      });
      sourceUserFields = sfR.records?.[0] || {};

      // Target user locale/tz fields
      const tfR = await bg({
        type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
        query: `SELECT LocaleSidKey,LanguageLocaleKey,TimeZoneSidKey,EmailEncodingKey ` +
          `FROM User WHERE Id='${targetUser.Id}'`
      });
      targetUserFields = tfR.records?.[0] || {};

      // Source public groups
      const sgR = await bg({
        type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
        query: `SELECT GroupId,Group.Name FROM GroupMember ` +
          `WHERE UserOrGroupId='${sourceUser.Id}' AND Group.Type='Regular'`
      });
      sourceGroups = sgR.records || [];

      // Target public groups
      const tgR = await bg({
        type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
        query: `SELECT GroupId FROM GroupMember ` +
          `WHERE UserOrGroupId='${targetUser.Id}' AND Group.Type='Regular'`
      });
      targetGroupIds = new Set((tgR.records || []).map(r => r.GroupId));

      // User-record permission booleans (Marketing User, Flow User, etc.)
      sourceUserPerms = {};
      targetUserPerms = {};
      if (userPermFields.length > 0) {
        const fieldList = userPermFields.map(f => f.name).join(',');
        const spR = await bg({
          type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
          query: `SELECT ${fieldList} FROM User WHERE Id='${sourceUser.Id}'`
        });
        sourceUserPerms = spR.records?.[0] || {};
        const tpR = await bg({
          type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
          query: `SELECT ${fieldList} FROM User WHERE Id='${targetUser.Id}'`
        });
        targetUserPerms = tpR.records?.[0] || {};
      }

    } catch (e) {
      document.getElementById('ucLoading').style.display = 'none';
      showResult(`Failed to load permissions: ${esc(e.message || String(e))}`, true);
      return;
    }

    document.getElementById('ucLoading').style.display = 'none';
    renderPreview();
    document.getElementById('ucPreview').style.display = '';
    document.getElementById('ucCopyBtn').onclick = executeCopy;
  }

  // ── Render preview ───────────────────────────────────────
  function renderPreview() {
    const opts             = getOptions();
    const targetLicenseId  = targetUser?.Profile?.UserLicense?.Id;
    const targetLicenseName = targetUser?.Profile?.UserLicense?.Name || 'Unknown';

    let html = '';

    // ── Profile section ──────────────────────────────────
    if (opts.profile) {
      const srcProfile  = sourceUser?.Profile?.Name || '—';
      const tgtProfile  = targetUser?.Profile?.Name || '—';
      const sameProfile = sourceUser?.Profile?.Id === targetUser?.Profile?.Id;

      html += `<div class="uc-section-title">👤 Profile</div>`;
      html += `
        <label class="uc-row uc-row-check ${sameProfile ? 'uc-row-muted' : ''}">
          <input type="checkbox" id="ucProfileCb" ${sameProfile ? '' : 'checked'}
            ${sameProfile ? 'disabled' : ''}>
          <span class="uc-row-name">
            Change profile to <strong>${esc(srcProfile)}</strong>
          </span>
          ${sameProfile
            ? '<span class="uc-row-badge uc-badge-same">same</span>'
            : `<span class="uc-field-val">currently: ${esc(tgtProfile)}</span>`}
        </label>`;

      if (!sameProfile) {
        const srcLic = sourceUser?.Profile?.UserLicense?.Name || '';
        if (srcLic && srcLic !== targetLicenseName) {
          html += `<div class="uc-license-note">
            ⚠️ This also changes the license from
            <strong>${esc(targetLicenseName)}</strong> →
            <strong>${esc(srcLic)}</strong>.
            Make sure a license slot is available.
          </div>`;
        }
      }
    }

    // ── Permission Sets section ──────────────────────────
    if (opts.permSets) {
      html += `<div class="uc-section-title" style="margin-top:10px">🔑 Permission Sets</div>`;

      const assignable   = [];
      const alreadyHas   = [];
      const incompatible = [];

      for (const psa of sourcePermSets) {
        const ps = psa.PermissionSet;
        if (targetPermSetIds.has(psa.PermissionSetId)) {
          alreadyHas.push(psa);
        } else if (ps?.LicenseId && targetLicenseId && ps.LicenseId !== targetLicenseId) {
          incompatible.push(psa);
        } else {
          assignable.push(psa);
        }
      }

      if (sourcePermSets.length === 0)
        html += `<div class="uc-empty-msg">Source user has no permission sets.</div>`;

      if (assignable.length > 0) {
        html += `<div class="uc-group-label">Can be copied <span class="uc-count">${assignable.length}</span></div>`;
        for (const psa of assignable) {
          const label = esc(psa.PermissionSet?.Label || psa.PermissionSet?.Name || psa.PermissionSetId);
          html += `
            <label class="uc-row uc-row-check">
              <input type="checkbox" class="uc-ps-cb" data-psid="${esc(psa.PermissionSetId)}" checked>
              <span class="uc-row-name">${label}</span>
            </label>`;
        }
      }

      if (alreadyHas.length > 0) {
        html += `<div class="uc-group-label uc-muted-label">Already assigned <span class="uc-count">${alreadyHas.length}</span></div>`;
        for (const psa of alreadyHas) {
          html += `
            <div class="uc-row uc-row-muted">
              <span class="uc-row-icon">✓</span>
              <span class="uc-row-name">${esc(psa.PermissionSet?.Label || psa.PermissionSet?.Name)}</span>
            </div>`;
        }
      }

      if (incompatible.length > 0) {
        html += `<div class="uc-group-label uc-danger-label">Incompatible license <span class="uc-count">${incompatible.length}</span></div>`;
        html += `<div class="uc-license-note">⚠️ Target has license <strong>${esc(targetLicenseName)}</strong>. These require a different license:</div>`;
        for (const psa of incompatible) {
          const ps = psa.PermissionSet;
          html += `
            <div class="uc-row uc-row-danger">
              <span class="uc-row-icon">✗</span>
              <span class="uc-row-name">${esc(ps?.Label || ps?.Name)}</span>
              <span class="uc-row-badge">${esc(ps?.License?.Name || 'Other license')}</span>
            </div>`;
        }
      }
    }

    // ── Public Groups section ────────────────────────────
    if (opts.groups) {
      html += `<div class="uc-section-title" style="margin-top:10px">👥 Public Groups</div>`;

      if (sourceGroups.length === 0) {
        html += `<div class="uc-empty-msg">Source user is not in any public groups.</div>`;
      } else {
        const assignableGroups = sourceGroups.filter(gm => !targetGroupIds.has(gm.GroupId));
        const alreadyInGroups  = sourceGroups.filter(gm =>  targetGroupIds.has(gm.GroupId));

        if (assignableGroups.length > 0) {
          html += `<div class="uc-group-label">Can be added <span class="uc-count">${assignableGroups.length}</span></div>`;
          for (const gm of assignableGroups) {
            html += `
              <label class="uc-row uc-row-check">
                <input type="checkbox" class="uc-grp-cb" data-groupid="${esc(gm.GroupId)}" checked>
                <span class="uc-row-name">${esc(gm.Group?.Name || gm.GroupId)}</span>
              </label>`;
          }
        }

        if (alreadyInGroups.length > 0) {
          html += `<div class="uc-group-label uc-muted-label">Already a member <span class="uc-count">${alreadyInGroups.length}</span></div>`;
          for (const gm of alreadyInGroups) {
            html += `
              <div class="uc-row uc-row-muted">
                <span class="uc-row-icon">✓</span>
                <span class="uc-row-name">${esc(gm.Group?.Name || gm.GroupId)}</span>
              </div>`;
          }
        }
      }
    }

    // ── User Permissions section ─────────────────────────
    // These are the boolean checkboxes on the User detail page
    // (Marketing User, Flow User, Service Cloud User, Knowledge User, etc.)
    if (opts.userPerms) {
      html += `<div class="uc-section-title" style="margin-top:10px">🛡️ User Permissions</div>`;

      if (userPermFields.length === 0) {
        html += `<div class="uc-empty-msg">No user permission fields detected in this org.</div>`;
      } else {
        const toEnable  = []; // src=true, tgt=false
        const toDisable = []; // src=false, tgt=true
        const sameOn    = []; // both true
        // (we ignore "both false" entirely — not informative)

        for (const f of userPermFields) {
          const s = !!sourceUserPerms[f.name];
          const t = !!targetUserPerms[f.name];
          if (s && !t)      toEnable.push(f);
          else if (!s && t) toDisable.push(f);
          else if (s && t)  sameOn.push(f);
        }

        if (toEnable.length > 0) {
          html += `<div class="uc-group-label">Can be enabled <span class="uc-count">${toEnable.length}</span></div>`;
          for (const f of toEnable) {
            html += `
              <label class="uc-row uc-row-check">
                <input type="checkbox" class="uc-userperm-cb" data-field="${esc(f.name)}" data-target="true" checked>
                <span class="uc-row-name">${esc(f.label)}</span>
              </label>`;
          }
        }

        if (toDisable.length > 0) {
          html += `<div class="uc-group-label uc-danger-label">Can be disabled <span class="uc-count">${toDisable.length}</span></div>`;
          for (const f of toDisable) {
            html += `
              <label class="uc-row uc-row-check">
                <input type="checkbox" class="uc-userperm-cb" data-field="${esc(f.name)}" data-target="false">
                <span class="uc-row-name">${esc(f.label)}</span>
                <span class="uc-field-val">currently on for target</span>
              </label>`;
          }
        }

        if (sameOn.length > 0) {
          html += `<div class="uc-group-label uc-muted-label">Already enabled <span class="uc-count">${sameOn.length}</span></div>`;
          for (const f of sameOn) {
            html += `
              <div class="uc-row uc-row-muted">
                <span class="uc-row-icon">✓</span>
                <span class="uc-row-name">${esc(f.label)}</span>
              </div>`;
          }
        }

        if (toEnable.length === 0 && toDisable.length === 0 && sameOn.length === 0) {
          html += `<div class="uc-empty-msg">Source user has no user permissions enabled.</div>`;
        }
      }
    }

    // ── Locale & Timezone section ────────────────────────
    if (opts.settings) {
      html += `<div class="uc-section-title" style="margin-top:10px">⚙️ Locale &amp; Timezone</div>`;

      const FIELDS = [
        { key: 'LocaleSidKey',      label: 'Locale' },
        { key: 'LanguageLocaleKey', label: 'Language' },
        { key: 'TimeZoneSidKey',    label: 'Timezone' },
        { key: 'EmailEncodingKey',  label: 'Email Encoding' }
      ];

      for (const { key, label } of FIELDS) {
        const srcVal = sourceUserFields[key] || '—';
        const tgtVal = targetUserFields[key] || '—';
        const same   = srcVal === tgtVal;
        html += `
          <label class="uc-row uc-row-check ${same ? 'uc-row-muted' : ''}">
            <input type="checkbox" class="uc-field-cb" data-field="${key}" ${same ? '' : 'checked'}>
            <span class="uc-row-name">${label}</span>
            <span class="uc-field-val">${esc(srcVal)}</span>
            ${same ? '<span class="uc-row-badge uc-badge-same">same</span>' : ''}
          </label>`;
      }
    }

    if (!opts.profile && !opts.permSets && !opts.groups && !opts.userPerms && !opts.settings) {
      html = `<div class="uc-empty-msg" style="padding:12px 6px">Select at least one category above to see the preview.</div>`;
    }

    document.getElementById('ucPreviewInner').innerHTML = html;
  }

  // ── Execute copy ─────────────────────────────────────────
  async function executeCopy() {
    const opts = getOptions();
    const btn  = document.getElementById('ucCopyBtn');
    btn.disabled    = true;
    btn.textContent = '⏳ Copying…';

    const errors = [];
    let profileOk = false, psOk = 0, grpOk = 0, fieldsOk = false, permsOk = 0;

    // 1. Profile
    if (opts.profile && document.getElementById('ucProfileCb')?.checked) {
      const r = await bg({
        type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid,
        path: `services/data/v62.0/sobjects/User/${targetUser.Id}`,
        body: { ProfileId: sourceUser.Profile.Id }
      });
      if (r.error) errors.push(`Profile: ${r.error}`);
      else profileOk = true;
    }

    // 2. Permission Sets
    if (opts.permSets) {
      const psIds = [...document.querySelectorAll('.uc-ps-cb:checked')].map(cb => cb.dataset.psid);
      for (const psId of psIds) {
        const r = await bg({
          type: 'SF_REST_POST', orgUrl: _orgUrl, sid: _sid,
          path: 'services/data/v62.0/sobjects/PermissionSetAssignment',
          body: { AssigneeId: targetUser.Id, PermissionSetId: psId }
        });
        if (r.error) {
          const name = sourcePermSets.find(p => p.PermissionSetId === psId)?.PermissionSet?.Label || psId;
          errors.push(`Permission set "${name}": ${r.error}`);
        } else psOk++;
      }
    }

    // 3. Public Groups
    if (opts.groups) {
      const groupIds = [...document.querySelectorAll('.uc-grp-cb:checked')].map(cb => cb.dataset.groupid);
      for (const groupId of groupIds) {
        const r = await bg({
          type: 'SF_REST_POST', orgUrl: _orgUrl, sid: _sid,
          path: 'services/data/v62.0/sobjects/GroupMember',
          body: { GroupId: groupId, UserOrGroupId: targetUser.Id }
        });
        if (r.error) {
          const name = sourceGroups.find(g => g.GroupId === groupId)?.Group?.Name || groupId;
          errors.push(`Group "${name}": ${r.error}`);
        } else grpOk++;
      }
    }

    // 4. User Permissions + Locale & Timezone — batched into one User PATCH
    // when both run, to halve the API calls.
    const userPatch = {};

    if (opts.userPerms) {
      document.querySelectorAll('.uc-userperm-cb:checked').forEach(cb => {
        // data-target is the literal "true" / "false" we'd be setting on the
        // target user (= what the source has). Coerce back to boolean.
        userPatch[cb.dataset.field] = cb.dataset.target === 'true';
      });
    }

    if (opts.settings) {
      document.querySelectorAll('.uc-field-cb:checked').forEach(cb => {
        userPatch[cb.dataset.field] = sourceUserFields[cb.dataset.field];
      });
    }

    if (Object.keys(userPatch).length > 0) {
      const r = await bg({
        type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid,
        path: `services/data/v62.0/sobjects/User/${targetUser.Id}`,
        body: userPatch
      });
      if (r.error) {
        errors.push(`User update: ${r.error}`);
      } else {
        // Count which categories landed for the result message.
        const permCount = Object.keys(userPatch).filter(k => k.startsWith('UserPermissions')).length;
        const settingCount = Object.keys(userPatch).length - permCount;
        permsOk  = permCount;
        fieldsOk = settingCount > 0;
      }
    }

    btn.disabled    = false;
    btn.textContent = '📋 Copy Selected';

    const nothingDone = !profileOk && psOk === 0 && grpOk === 0 && permsOk === 0 && !fieldsOk && errors.length === 0;
    if (nothingDone) {
      showResult('Nothing was selected to copy.', false);
      return;
    }

    // Build result message before refreshing (loadAndPreview hides ucResult)
    let resultMsg = '';
    let isErr = false;
    if (errors.length === 0) {
      const parts = [];
      if (profileOk)  parts.push('profile updated');
      if (psOk > 0)   parts.push(`${psOk} permission set${psOk > 1 ? 's' : ''} assigned`);
      if (grpOk > 0)  parts.push(`added to ${grpOk} group${grpOk > 1 ? 's' : ''}`);
      if (permsOk > 0)parts.push(`${permsOk} user permission${permsOk > 1 ? 's' : ''} updated`);
      if (fieldsOk)   parts.push('locale & timezone updated');
      resultMsg = `✅ Done! ${parts.join(' · ')}.`;
    } else {
      const errHtml = errors.map(e => `<li>${esc(e)}</li>`).join('');
      resultMsg =
        `⚠️ Completed with ${errors.length} error${errors.length > 1 ? 's' : ''}:` +
        `<ul style="margin-top:6px;padding-left:14px">${errHtml}</ul>`;
      isErr = true;
    }

    // Refresh preview so newly-assigned items move to "already assigned",
    // then show the result message so it isn't wiped by the refresh
    await loadAndPreview();
    showResult(resultMsg, isErr);
  }

  // ── Helpers ──────────────────────────────────────────────
  function showResult(html, isError) {
    const el = document.getElementById('ucResult');
    el.className    = isError ? 'error-banner' : 'result-toast';
    el.innerHTML    = isError ? html : `<div class="toast-success">${html}</div>`;
    el.style.display = '';
    if (!isError) setTimeout(() => { el.style.display = 'none'; }, 6000);
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
      window.SFToolkitDebug.log('users',
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
