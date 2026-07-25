// ============================================================
// User Copy Module — copy profile, permission sets,
// permission set groups, public groups & user settings
// between Salesforce users
// ============================================================

// ── Pure picker helpers (top-level on purpose) ───────────────
// These live at column 0, outside the IIFE, so test/copyperms-n2.test.mjs can
// materialize them standalone via test/extract.mjs. They must therefore stay
// PURE: no free variables, no DOM, no module state.

// Does `user` match the free-text `query`?
// Matches across every field the picker actually SHOWS — Name, Username,
// Email, Alias and Profile name — so "what you can see is what you can
// search". Case-insensitive substring match. An empty/whitespace-only query
// matches everything (the picker's default state is "show me everyone").
function cpUserMatches(user, query) {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q) return true;
  if (!user) return false;
  const profileName = user.Profile ? user.Profile.Name : '';
  const haystack = [user.Name, user.Username, user.Email, user.Alias, profileName];
  for (let i = 0; i < haystack.length; i++) {
    const v = haystack[i];
    if (v == null) continue;
    if (String(v).toLowerCase().indexOf(q) !== -1) return true;
  }
  return false;
}

// Filter a user array with cpUserMatches. Returns a NEW array (never the
// input) so callers can slice/sort it without mutating the cached list.
// A non-array input yields [] rather than throwing — the picker calls this
// while the list is still loading.
function cpFilterUsers(users, query) {
  if (!Array.isArray(users)) return [];
  const q = String(query == null ? '' : query).trim();
  if (!q) return users.slice();
  const out = [];
  for (let i = 0; i < users.length; i++) {
    if (cpUserMatches(users[i], q)) out.push(users[i]);
  }
  return out;
}

const UserCopy = (() => {
  let _orgUrl = null;
  let _sid    = null;

  // How many active users the up-front picker list loads in ONE query.
  // Deliberately a hard cap (not SF_QUERY_ALL paging) so the picker paints
  // fast in orgs with thousands of users. When the cap bites we SAY SO and
  // offer an explicit org-wide search — see searchOrgUsers().
  const USER_LIST_LIMIT = 200;

  // Everything the picker rows display, plus the fields the copy itself
  // needs (Profile.Id for the profile PATCH, Profile.UserLicense.* for the
  // permission-set license-compatibility check, UserType for the chip).
  const USER_FIELDS =
    'Id,Name,Username,Email,Alias,IsActive,Profile.Name,Profile.Id,' +
    'Profile.UserLicense.Id,Profile.UserLicense.Name,UserType';

  // Selected users
  let sourceUser = null;
  let targetUser = null;

  // Fetched data
  let allUsers       = [];       // pre-loaded on init
  let usersCapped    = false;    // true when the org has MORE than USER_LIST_LIMIT active users
  let usersLoadState = 'idle';   // 'idle' | 'loading' | 'done' | 'error'
  let usersLoadError = '';       // raw error text when usersLoadState === 'error'
  // Extra users pulled in by an explicit org-wide search, keyed by role so the
  // two pickers don't fight over each other's results.
  let orgSearch = { source: null, target: null };  // null | {query, state, records, error}
  let sourcePermSets   = [];
  let targetPermSetIds = new Set();
  let sourceGroups     = [];
  let targetGroupIds   = new Set();
  let sourceUserFields = {};
  let targetUserFields = {};

  // Permission Set Groups (PSGs). Probed separately from permission sets and
  // allowed to fail on their own — an org that can't query PermissionSetGroup
  // must not take the whole preview down with it.
  let sourcePermSetGroups = [];
  let targetPermSetGroupIds = new Set();
  let psgProbeError = '';        // '' when the probe worked

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
    usersCapped    = false;
    usersLoadState = 'idle';
    usersLoadError = '';
    orgSearch = { source: null, target: null };
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

  // ── Pre-load the active-user list ────────────────────────
  // ONE query, hard-capped. The list is rendered up front and picked by
  // CLICK — nobody should have to already know a name to type it.
  async function loadAllUsers() {
    usersLoadState = 'loading';
    usersLoadError = '';
    setPickerPlaceholder('⏳ Loading users…');
    renderBothLists();

    const soql = `SELECT ${USER_FIELDS} FROM User WHERE IsActive=true ` +
      `ORDER BY Name LIMIT ${USER_LIST_LIMIT}`;

    const res = await bg({
      type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid,
      query: soql, tooling: false
    });

    if (res.error) {
      usersLoadState = 'error';
      usersLoadError = String(res.error);
      setPickerPlaceholder(res.error === 'SESSION_EXPIRED'
        ? '❌ Session expired — log back in'
        : '❌ Failed to load users');
      renderBothLists();
      return;
    }

    allUsers = res.records || [];
    // We asked for exactly USER_LIST_LIMIT rows. Getting that many back means
    // the org almost certainly has more. We can't know HOW many more without a
    // second count query, so the UI says "this org has more" and never invents
    // a total.
    usersCapped    = allUsers.length >= USER_LIST_LIMIT;
    usersLoadState = 'done';
    setPickerPlaceholder(`🔍 Filter ${allUsers.length} users by name, username, email, alias or profile…`);
    renderBothLists();
  }

  // Explicit, user-initiated org-wide search. Only offered when the up-front
  // list was capped — otherwise the cached list already IS every active user.
  // This is the escape hatch that keeps user #201 reachable.
  async function searchOrgUsers(role) {
    const input = document.getElementById(pickerIds(role).input);
    const q = (input?.value || '').trim();
    if (q.length < 2) return;

    orgSearch[role] = { query: q, state: 'loading', records: [], error: '' };
    renderList(role);

    // Same five fields cpUserMatches() searches locally, so the org-wide
    // search finds exactly what the in-list filter would have found.
    const like = soqlLike(q);
    const soql = `SELECT ${USER_FIELDS} FROM User WHERE IsActive=true AND (` +
      `Name LIKE ${like} OR Username LIKE ${like} OR Email LIKE ${like} ` +
      `OR Alias LIKE ${like} OR Profile.Name LIKE ${like}) ` +
      `ORDER BY Name LIMIT ${USER_LIST_LIMIT}`;

    const res = await bg({
      type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid,
      query: soql, tooling: false
    });

    // The picker may have been reset (or the user picked someone) while the
    // search was in flight — don't clobber newer state.
    if (orgSearch[role]?.query !== q) return;

    if (res.error) {
      orgSearch[role] = { query: q, state: 'error', records: [], error: String(res.error) };
    } else {
      orgSearch[role] = { query: q, state: 'done', records: res.records || [], error: '' };
    }
    renderList(role);
  }

  function setPickerPlaceholder(text) {
    ['ucSourceInput', 'ucTargetInput'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.placeholder = text;
    });
  }

  function renderBothLists() {
    renderList('source');
    renderList('target');
  }

  // ── Tab HTML ─────────────────────────────────────────────
  function renderTab(container) {
    container.innerHTML = `
      <div class="uc-wrap">

        <!-- Source picker -->
        <div class="uc-picker-block">
          <div class="uc-picker-label">📤 Copy FROM</div>
          <div class="uc-picker" id="ucSourcePicker">
            ${pickerBodyHtml('source')}
            <div class="uc-chip-wrap" id="ucSourceChip" style="display:none"></div>
          </div>
        </div>

        <div class="uc-arrow">↓</div>

        <!-- Target picker -->
        <div class="uc-picker-block">
          <div class="uc-picker-label">📥 Copy TO</div>
          <div class="uc-picker" id="ucTargetPicker">
            ${pickerBodyHtml('target')}
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
              <input type="checkbox" class="uc-opt-cb" id="ucOptPermSetGroups" checked>
              🧩 Permission Set Groups
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

    setupPicker('source');
    setupPicker('target');
    setupOptions();
    renderBothLists();
  }

  // The filter box + the always-visible, click-to-select user list.
  // Rendered as a string by renderTab, then wired up by setupPicker.
  function pickerBodyHtml(role) {
    const p = role === 'source' ? 'ucSource' : 'ucTarget';
    return `
      <div id="${p}Pick">
        <input class="search-input uc-search" id="${p}Input"
          placeholder="⏳ Loading users…" autocomplete="off">
        <div id="${p}List"
          style="margin-top:6px;max-height:190px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;background:var(--card)"></div>
      </div>`;
  }

  // Element ids for one picker, in one place — nothing else should be
  // string-concatenating 'ucSource'/'ucTarget'.
  function pickerIds(role) {
    const p = role === 'source' ? 'ucSource' : 'ucTarget';
    return { pick: `${p}Pick`, input: `${p}Input`, list: `${p}List`, chip: `${p}Chip` };
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
      permSetGroups: !!document.getElementById('ucOptPermSetGroups')?.checked,
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

  // ── User picker ──────────────────────────────────────────
  // The list is ALWAYS on screen and picked by CLICK. The filter box only
  // narrows what is already listed — you never have to know a name to find
  // a person. Matching is delegated to the pure cpFilterUsers().
  function setupPicker(role) {
    const ids   = pickerIds(role);
    const input = document.getElementById(ids.input);
    if (!input) return;
    input.addEventListener('input', () => renderList(role));
    // Enter must NOT select anything — selection is click-only, deliberately,
    // so a typo can never silently pick the wrong person.
    input.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
  }

  // Render one picker's list from the current state. Rebuilds the whole
  // container each time — 200 rows is cheap and it keeps state in ONE place.
  function renderList(role) {
    const ids  = pickerIds(role);
    const list = document.getElementById(ids.list);
    if (!list) return;

    list.innerHTML = '';

    // 'idle' is the sliver between renderTab() and loadAllUsers()'s first
    // state change — show the spinner, never a misleading "0 users".
    if (usersLoadState === 'loading' || usersLoadState === 'idle') {
      list.innerHTML = `<div class="uc-drop-item uc-drop-loading">${sftkCatSm('Loading users…')}</div>`;
      return;
    }

    if (usersLoadState === 'error') {
      const fe = sftkFriendlyError(usersLoadError);
      const row = document.createElement('div');
      row.className = 'uc-drop-item uc-drop-empty';
      row.innerHTML =
        `<div title="${esc(fe.raw)}">❌ Could not load the user list: ${esc(fe.message)}</div>` +
        (fe.hint ? `<div style="margin-top:3px;opacity:.8">${esc(fe.hint)}</div>` : '');
      list.appendChild(row);
      const retry = document.createElement('button');
      retry.className = 'uc-chip-change';
      retry.textContent = '↻ Retry';
      retry.style.cssText = 'margin:8px 12px 10px';
      retry.addEventListener('click', () => loadAllUsers());
      list.appendChild(retry);
      return;
    }

    const input     = document.getElementById(ids.input);
    const q         = (input?.value || '').trim();
    const otherUser = role === 'source' ? targetUser : sourceUser;
    const search    = orgSearch[role];
    // An org-wide search result REPLACES the cached list, but only while its
    // query still matches what's in the box — otherwise it's stale.
    const usingSearch = !!(search && search.query === q && search.state === 'done');
    const pool        = usingSearch ? search.records : allUsers;

    const matches = cpFilterUsers(pool, q).filter(u => u.Id !== otherUser?.Id);

    // Honest header: where these rows came from and what is NOT in them.
    const head = document.createElement('div');
    head.style.cssText =
      'padding:6px 10px;font-size:10.5px;color:var(--subtext);background:var(--bg);' +
      'border-bottom:1px solid var(--border-light);position:sticky;top:0;z-index:1';
    let headText;
    if (usingSearch) {
      headText = `${matches.length} match${matches.length === 1 ? '' : 'es'} from an org-wide search` +
        (search.records.length >= USER_LIST_LIMIT
          ? ` — capped at ${USER_LIST_LIMIT}, narrow the filter if the person isn't here`
          : '');
    } else if (q) {
      headText = `${matches.length} of ${pool.length} loaded user${pool.length === 1 ? '' : 's'} match “${q}”`;
    } else {
      headText = `${matches.length} active user${matches.length === 1 ? '' : 's'} — click one to select`;
    }
    if (!usingSearch && usersCapped) {
      headText += ` · list capped at the first ${USER_LIST_LIMIT} by name; this org has more`;
    }
    head.textContent = headText;
    list.appendChild(head);

    const searching = !!(search && search.query === q && search.state === 'loading');

    if (searching) {
      const l = document.createElement('div');
      l.className = 'uc-drop-item uc-drop-loading';
      l.innerHTML = sftkCatSm('Searching all users…');
      list.appendChild(l);
    } else if (search && search.query === q && search.state === 'error') {
      const fe = sftkFriendlyError(search.error);
      const e = document.createElement('div');
      e.className = 'uc-drop-item uc-drop-empty';
      e.innerHTML = `<span title="${esc(fe.raw)}">❌ Org-wide search failed: ${esc(fe.message)}</span>`;
      list.appendChild(e);
    }

    if (matches.length === 0 && !searching) {
      const empty = document.createElement('div');
      empty.className = 'uc-drop-item uc-drop-empty';
      empty.textContent = usingSearch
        ? 'The org-wide search found no active user matching that text.'
        : q ? 'No matching users in the loaded list.'
            : 'No active users found.';
      list.appendChild(empty);
    }

    for (const u of matches) list.appendChild(userRow(role, u));

    // Escape hatch: the cached list is capped, so the person you want may
    // simply not be loaded. Never let that be a silent dead end.
    if (usersCapped && q.length >= 2 && !usingSearch && !searching) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'padding:8px 10px;border-top:1px solid var(--border-light);background:var(--bg)';
      const note = document.createElement('div');
      note.style.cssText = 'font-size:10.5px;color:var(--subtext);margin-bottom:5px';
      note.textContent = `Only the first ${USER_LIST_LIMIT} users are loaded. Search the whole org for this text:`;
      const btn = document.createElement('button');
      btn.className = 'uc-chip-change';
      btn.textContent = `🔎 Search all users for “${q}”`;
      btn.addEventListener('click', () => searchOrgUsers(role));
      wrap.appendChild(note);
      wrap.appendChild(btn);
      list.appendChild(wrap);
    }
  }

  // One clickable user row: Name · Username · Email · Alias · Profile,
  // plus an active/inactive badge.
  function userRow(role, u) {
    const item = document.createElement('div');
    item.className = 'uc-drop-item';
    item.title = 'Click to select this user';

    const active   = u.IsActive !== false;
    const badge    = active
      ? '<span style="font-size:9.5px;font-weight:700;color:#04844B;background:#EBF7F1;border:1px solid #B8E6CE;border-radius:9px;padding:1px 6px;white-space:nowrap">Active</span>'
      : '<span style="font-size:9.5px;font-weight:700;color:#8A8886;background:#F3F2F2;border:1px solid #DDDBDA;border-radius:9px;padding:1px 6px;white-space:nowrap">Inactive</span>';

    // Only render the separators for parts that actually exist — an empty
    // Alias must not leave a dangling "·".
    const parts = [u.Username, u.Email, u.Alias, u.Profile?.Name]
      .filter(v => v != null && String(v).trim() !== '')
      .map(v => esc(v));

    item.innerHTML =
      `<div style="display:flex;align-items:center;gap:6px">` +
        `<span class="uc-drop-name" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(u.Name)}</span>` +
        badge +
      `</div>` +
      `<div class="uc-drop-meta" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">` +
        (parts.length ? parts.join(' · ') : '<em>no username / email / alias / profile on record</em>') +
      `</div>`;

    item.addEventListener('click', () => selectUser(role, u));
    return item;
  }

  async function selectUser(role, user) {
    const ids = pickerIds(role);

    // Hide the filter + list; the chip takes their place.
    const pick = document.getElementById(ids.pick);
    if (pick) pick.style.display = 'none';

    const chip = document.getElementById(ids.chip);
    chip.style.display = '';
    const meta = [user.Username, user.Email, user.Alias, user.Profile?.Name]
      .filter(v => v != null && String(v).trim() !== '')
      .map(v => esc(v))
      .join(' · ');
    chip.innerHTML = `
      <div class="uc-chip">
        <div class="uc-chip-info">
          <span class="uc-chip-name">${esc(user.Name)}</span>
          <span class="uc-chip-meta"
            style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${meta}</span>
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

    // The OTHER picker must drop this person from its list now.
    renderList(role === 'source' ? 'target' : 'source');

    document.getElementById('ucPreview').style.display = 'none';
    document.getElementById('ucResult').style.display  = 'none';

    if (sourceUser && targetUser) await loadAndPreview();
  }

  function clearUser(role, focus = false) {
    const ids   = pickerIds(role);
    const input = document.getElementById(ids.input);
    const pick  = document.getElementById(ids.pick);
    if (input) input.value = '';
    if (pick) pick.style.display = '';
    orgSearch[role] = null;

    document.getElementById(ids.chip).style.display = 'none';
    if (role === 'source') sourceUser = null;
    else targetUser = null;

    renderBothLists();   // the other side gets this person back

    document.getElementById('ucPreview').style.display = 'none';
    document.getElementById('ucResult').style.display  = 'none';
    if (focus && input) input.focus();
  }

  // ── Permission Set Groups ────────────────────────────────
  // Probed on its own and allowed to fail on its own: PermissionSetGroup is
  // not queryable in every org/edition, and a 400 here must not blank out the
  // profile / permission-set / locale preview. On failure we record WHY and
  // renderPreview() prints it instead of quietly showing an empty section.
  async function loadPermSetGroups() {
    sourcePermSetGroups   = [];
    targetPermSetGroupIds = new Set();
    psgProbeError         = '';

    const sR = await bg({
      type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
      _silentError: true,
      query: `SELECT PermissionSetGroupId,PermissionSetGroup.MasterLabel,` +
        `PermissionSetGroup.DeveloperName,PermissionSetGroup.Status ` +
        `FROM PermissionSetAssignment ` +
        `WHERE AssigneeId=${soqlLit(sourceUser.Id)} AND PermissionSetGroupId != null ` +
        `ORDER BY PermissionSetGroup.MasterLabel`
    });
    if (sR.error) { psgProbeError = String(sR.error); return; }
    sourcePermSetGroups = sR.records || [];

    const tR = await bg({
      type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
      _silentError: true,
      query: `SELECT PermissionSetGroupId FROM PermissionSetAssignment ` +
        `WHERE AssigneeId=${soqlLit(targetUser.Id)} AND PermissionSetGroupId != null`
    });
    if (tR.error) {
      // We know the source's groups but not the target's. Assigning blind
      // would produce DUPLICATE_VALUE errors we'd have to explain away — so
      // we treat the whole category as unavailable and say so.
      sourcePermSetGroups = [];
      psgProbeError = String(tR.error);
      return;
    }
    targetPermSetGroupIds = new Set((tR.records || []).map(r => r.PermissionSetGroupId));
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
          `FROM PermissionSetAssignment WHERE AssigneeId=${soqlLit(sourceUser.Id)} ` +
          `AND PermissionSet.IsOwnedByProfile=false ORDER BY PermissionSet.Label`
      });
      sourcePermSets = spsR.records || [];

      // Permission sets already on target
      const tpsR = await bg({
        type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
        query: `SELECT PermissionSetId FROM PermissionSetAssignment ` +
          `WHERE AssigneeId=${soqlLit(targetUser.Id)} AND PermissionSet.IsOwnedByProfile=false`
      });
      targetPermSetIds = new Set((tpsR.records || []).map(r => r.PermissionSetId));

      await loadPermSetGroups();

      // Source user locale/tz fields
      const sfR = await bg({
        type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
        query: `SELECT LocaleSidKey,LanguageLocaleKey,TimeZoneSidKey,EmailEncodingKey ` +
          `FROM User WHERE Id=${soqlLit(sourceUser.Id)}`
      });
      sourceUserFields = sfR.records?.[0] || {};

      // Target user locale/tz fields
      const tfR = await bg({
        type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
        query: `SELECT LocaleSidKey,LanguageLocaleKey,TimeZoneSidKey,EmailEncodingKey ` +
          `FROM User WHERE Id=${soqlLit(targetUser.Id)}`
      });
      targetUserFields = tfR.records?.[0] || {};

      // Source public groups
      const sgR = await bg({
        type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
        query: `SELECT GroupId,Group.Name FROM GroupMember ` +
          `WHERE UserOrGroupId=${soqlLit(sourceUser.Id)} AND Group.Type='Regular'`
      });
      sourceGroups = sgR.records || [];

      // Target public groups
      const tgR = await bg({
        type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
        query: `SELECT GroupId FROM GroupMember ` +
          `WHERE UserOrGroupId=${soqlLit(targetUser.Id)} AND Group.Type='Regular'`
      });
      targetGroupIds = new Set((tgR.records || []).map(r => r.GroupId));

      // User-record permission booleans (Marketing User, Flow User, etc.)
      sourceUserPerms = {};
      targetUserPerms = {};
      if (userPermFields.length > 0) {
        const fieldList = userPermFields.map(f => f.name).join(',');
        const spR = await bg({
          type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
          query: `SELECT ${fieldList} FROM User WHERE Id=${soqlLit(sourceUser.Id)}`
        });
        sourceUserPerms = spR.records?.[0] || {};
        const tpR = await bg({
          type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
          query: `SELECT ${fieldList} FROM User WHERE Id=${soqlLit(targetUser.Id)}`
        });
        targetUserPerms = tpR.records?.[0] || {};
      }

    } catch (e) {
      document.getElementById('ucLoading').style.display = 'none';
      const fe = sftkFriendlyError(e.message || String(e));
      showResult(
        `<span title="${esc(fe.raw)}">Failed to load permissions: ${esc(fe.message)}</span>` +
        (fe.hint ? `<div style="margin-top:4px;font-size:11px;opacity:.8">${esc(fe.hint)}</div>` : ''),
        true
      );
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

    // ── Permission Set Groups section ────────────────────
    if (opts.permSetGroups) {
      html += `<div class="uc-section-title" style="margin-top:10px">🧩 Permission Set Groups</div>`;

      if (psgProbeError) {
        // Honest degradation: the rest of the preview is still valid, but we
        // could NOT check groups — say exactly that instead of showing "none".
        const fe = sftkFriendlyError(psgProbeError);
        html += `<div class="uc-license-note" title="${esc(fe.raw)}">
          ⚠️ Could not read Permission Set Group assignments: ${esc(fe.message)}
          ${fe.hint ? `<div style="margin-top:3px;opacity:.85">${esc(fe.hint)}</div>` : ''}
          <div style="margin-top:3px">Nothing in this category will be copied. Everything else above/below was checked normally.</div>
        </div>`;
      } else if (sourcePermSetGroups.length === 0) {
        html += `<div class="uc-empty-msg">Source user has no permission set groups.</div>`;
      } else {
        const psgAssignable = [];
        const psgAlready    = [];
        const psgBroken     = [];   // group record unreadable — cannot be assigned

        for (const psa of sourcePermSetGroups) {
          if (!psa.PermissionSetGroupId || !psa.PermissionSetGroup) psgBroken.push(psa);
          else if (targetPermSetGroupIds.has(psa.PermissionSetGroupId)) psgAlready.push(psa);
          else psgAssignable.push(psa);
        }

        if (psgAssignable.length > 0) {
          html += `<div class="uc-group-label">Can be copied <span class="uc-count">${psgAssignable.length}</span></div>`;
          for (const psa of psgAssignable) {
            const g = psa.PermissionSetGroup;
            const label = esc(g?.MasterLabel || g?.DeveloperName || psa.PermissionSetGroupId);
            // Status is informational only — Salesforce still accepts the
            // assignment while a group is recalculating, so we don't block it.
            const status = g?.Status && g.Status !== 'Updated'
              ? `<span class="uc-row-badge">${esc(g.Status)}</span>` : '';
            html += `
              <label class="uc-row uc-row-check">
                <input type="checkbox" class="uc-psg-cb" data-psgid="${esc(psa.PermissionSetGroupId)}"
                  data-psglabel="${esc(g?.MasterLabel || g?.DeveloperName || psa.PermissionSetGroupId)}" checked>
                <span class="uc-row-name">${label}</span>
                ${status}
              </label>`;
          }
        }

        if (psgAlready.length > 0) {
          html += `<div class="uc-group-label uc-muted-label">Already assigned <span class="uc-count">${psgAlready.length}</span></div>`;
          for (const psa of psgAlready) {
            const g = psa.PermissionSetGroup;
            html += `
              <div class="uc-row uc-row-muted">
                <span class="uc-row-icon">✓</span>
                <span class="uc-row-name">${esc(g?.MasterLabel || g?.DeveloperName || psa.PermissionSetGroupId)}</span>
              </div>`;
          }
        }

        if (psgBroken.length > 0) {
          html += `<div class="uc-group-label uc-danger-label">Cannot be assigned <span class="uc-count">${psgBroken.length}</span></div>`;
          html += `<div class="uc-license-note">⚠️ Salesforce cannot assign a Permission Set Group that does not exist —
            these assignments point at a PermissionSetGroup this session cannot read (deleted, or not visible to you),
            so they are skipped.</div>`;
          for (const psa of psgBroken) {
            html += `
              <div class="uc-row uc-row-danger">
                <span class="uc-row-icon">✗</span>
                <span class="uc-row-name">${esc(psa.PermissionSetGroupId || 'Unknown group')}</span>
              </div>`;
          }
        }

        html += `<div class="uc-empty-msg" style="margin-top:4px">
          Copying a group assigns the GROUP itself — the permission sets inside it are not assigned individually.
        </div>`;
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

    if (!opts.profile && !opts.permSets && !opts.permSetGroups && !opts.groups &&
        !opts.userPerms && !opts.settings) {
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

    // Collect every selected operation up-front so the progress counter
    // knows the real total before the first API call fires.
    const doProfile = opts.profile && !!document.getElementById('ucProfileCb')?.checked;
    const psIds = opts.permSets
      ? [...document.querySelectorAll('.uc-ps-cb:checked')].map(cb => cb.dataset.psid)
      : [];
    // Carry the label along — after the copy the preview is re-rendered and
    // the checkbox (and its label) is gone, so we cannot look it up later.
    const psgPicks = opts.permSetGroups
      ? [...document.querySelectorAll('.uc-psg-cb:checked')]
          .map(cb => ({ id: cb.dataset.psgid, label: cb.dataset.psglabel || cb.dataset.psgid }))
      : [];
    const groupIds = opts.groups
      ? [...document.querySelectorAll('.uc-grp-cb:checked')].map(cb => cb.dataset.groupid)
      : [];

    // User Permissions + Locale & Timezone — batched into one User PATCH
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

    // Running progress in the shared loading block — one tick per API call
    // (profile PATCH + each perm-set POST + each perm-set-GROUP POST + each
    // public-group POST + the combined User PATCH), so long copies don't
    // look hung.
    const total = (doProfile ? 1 : 0) + psIds.length + psgPicks.length + groupIds.length +
      (Object.keys(userPatch).length > 0 ? 1 : 0);
    let done = 0;
    const loadingEl = document.getElementById('ucLoading');
    const tickProgress = () => {
      loadingEl.innerHTML = sftkCatSm(`Copying… ${done}/${total}`);
      loadingEl.style.display = '';
    };
    if (total > 0) tickProgress();

    const errors = [];
    // Permission Set Groups get a PER-GROUP verdict in the result block, so
    // their failures live here rather than in the flat `errors` list (which
    // would duplicate them). They still count toward the error total.
    const psgResults = [];   // [{ label, ok, msg }]
    let profileOk = false, psOk = 0, grpOk = 0, fieldsOk = false, permsOk = 0;

    // 1. Profile
    if (doProfile) {
      const r = await bg({
        type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid,
        path: `services/data/v62.0/sobjects/User/${targetUser.Id}`,
        body: { ProfileId: sourceUser.Profile.Id }
      });
      if (r.error) errors.push(`Profile: ${friendlyMsg(r.error)}`);
      else profileOk = true;
      done++; tickProgress();
    }

    // 2. Permission Sets
    for (const psId of psIds) {
      const r = await bg({
        type: 'SF_REST_POST', orgUrl: _orgUrl, sid: _sid,
        path: 'services/data/v62.0/sobjects/PermissionSetAssignment',
        body: { AssigneeId: targetUser.Id, PermissionSetId: psId }
      });
      if (r.error) {
        const name = sourcePermSets.find(p => p.PermissionSetId === psId)?.PermissionSet?.Label || psId;
        errors.push(`Permission set "${name}": ${friendlyMsg(r.error)}`);
      } else psOk++;
      done++; tickProgress();
    }

    // 3. Permission Set Groups — one PermissionSetAssignment per group.
    // Assigning the GROUP is not the same as assigning its member permission
    // sets: Salesforce keeps the group link, so later changes to the group
    // follow through to the user.
    for (const g of psgPicks) {
      const r = await bg({
        type: 'SF_REST_POST', orgUrl: _orgUrl, sid: _sid,
        path: 'services/data/v62.0/sobjects/PermissionSetAssignment',
        body: { AssigneeId: targetUser.Id, PermissionSetGroupId: g.id }
      });
      if (r.error) psgResults.push({ label: g.label, ok: false, msg: friendlyMsg(r.error) });
      else psgResults.push({ label: g.label, ok: true, msg: '' });
      done++; tickProgress();
    }

    // 4. Public Groups
    for (const groupId of groupIds) {
      const r = await bg({
        type: 'SF_REST_POST', orgUrl: _orgUrl, sid: _sid,
        path: 'services/data/v62.0/sobjects/GroupMember',
        body: { GroupId: groupId, UserOrGroupId: targetUser.Id }
      });
      if (r.error) {
        const name = sourceGroups.find(g => g.GroupId === groupId)?.Group?.Name || groupId;
        errors.push(`Group "${name}": ${friendlyMsg(r.error)}`);
      } else grpOk++;
      done++; tickProgress();
    }

    // 5. Combined User PATCH (user permissions + locale & timezone)
    if (Object.keys(userPatch).length > 0) {
      const r = await bg({
        type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid,
        path: `services/data/v62.0/sobjects/User/${targetUser.Id}`,
        body: userPatch
      });
      if (r.error) {
        // One PATCH bundles both categories — name which one(s) were in it
        // so the failure isn't cryptic.
        const permCount = Object.keys(userPatch).filter(k => k.startsWith('UserPermissions')).length;
        const cats = [];
        if (permCount > 0) cats.push('user permissions');
        if (permCount < Object.keys(userPatch).length) cats.push('locale & timezone');
        errors.push(`User update (${cats.join(' + ')}): ${friendlyMsg(r.error)}`);
      } else {
        // Count which categories landed for the result message.
        const permCount = Object.keys(userPatch).filter(k => k.startsWith('UserPermissions')).length;
        const settingCount = Object.keys(userPatch).length - permCount;
        permsOk  = permCount;
        fieldsOk = settingCount > 0;
      }
      done++; tickProgress();
    }

    // Hide the progress block and restore its default content for the
    // next preview load (loadAndPreview only toggles display).
    loadingEl.style.display = 'none';
    loadingEl.innerHTML = sftkCatSm('Loading permissions…');

    btn.disabled    = false;
    btn.textContent = '📋 Copy Selected';

    const psgOk   = psgResults.filter(r => r.ok).length;
    const psgFail = psgResults.length - psgOk;
    const errCount = errors.length + psgFail;

    const nothingDone = !profileOk && psOk === 0 && psgResults.length === 0 && grpOk === 0 &&
      permsOk === 0 && !fieldsOk && errors.length === 0;
    if (nothingDone) {
      showResult('Nothing was selected to copy.', false);
      return;
    }

    // Per-group verdict block — every group we attempted, ✅ or ❌ with the
    // translated reason. Rendered whether or not anything else failed.
    let psgBlock = '';
    if (psgResults.length > 0) {
      const rows = psgResults.map(r => r.ok
        ? `<li>✅ ${esc(r.label)}</li>`
        : `<li>❌ ${esc(r.label)} — ${esc(r.msg)}</li>`).join('');
      psgBlock =
        `<div style="margin-top:8px;font-size:11.5px">` +
        `<strong>Permission Set Groups (${psgOk}/${psgResults.length} assigned)</strong>` +
        `<ul style="margin-top:4px;padding-left:14px">${rows}</ul></div>`;
    }

    // Build result message before refreshing (loadAndPreview hides ucResult)
    let resultMsg = '';
    let isErr = false;
    if (errCount === 0) {
      const parts = [];
      if (profileOk)  parts.push('profile updated');
      if (psOk > 0)   parts.push(`${psOk} permission set${psOk > 1 ? 's' : ''} assigned`);
      if (psgOk > 0)  parts.push(`${psgOk} permission set group${psgOk > 1 ? 's' : ''} assigned`);
      if (grpOk > 0)  parts.push(`added to ${grpOk} group${grpOk > 1 ? 's' : ''}`);
      if (permsOk > 0)parts.push(`${permsOk} user permission${permsOk > 1 ? 's' : ''} updated`);
      if (fieldsOk)   parts.push('locale & timezone updated');
      resultMsg = `✅ Done! ${parts.join(' · ')}.` + psgBlock;
    } else {
      const errHtml = errors.map(e => `<li>${esc(e)}</li>`).join('');
      resultMsg =
        `⚠️ Completed with ${errCount} error${errCount > 1 ? 's' : ''}:` +
        (errors.length > 0 ? `<ul style="margin-top:6px;padding-left:14px">${errHtml}</ul>` : '') +
        psgBlock;
      isErr = true;
    }

    // Refresh preview so newly-assigned items move to "already assigned",
    // then show the result message so it isn't wiped by the refresh
    await loadAndPreview();
    showResult(resultMsg, isErr);
  }

  // ── Helpers ──────────────────────────────────────────────
  // Translate a raw API error into a plain-language one-liner. Returned text
  // is UNescaped — callers escape once at render (the error <ul> uses esc()).
  function friendlyMsg(raw) {
    const fe = sftkFriendlyError(raw);
    return fe.message + (fe.hint ? ' — ' + fe.hint : '');
  }

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

  // SOQL string literal. Same contract as studio-core's soqlStrLit(), carried
  // locally because that lib is only loaded on the Studio page, not the popup.
  function soqlLit(v) {
    return "'" + String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  }

  // SOQL LIKE literal wrapped in %…%. Also neutralises the LIKE wildcards
  // % and _ so a user typing "a_b" searches for a literal underscore.
  function soqlLike(v) {
    const body = String(v == null ? '' : v)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
    return "'%" + body + "%'";
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
      // _silentError marks a probe that may LEGITIMATELY fail (e.g. an org
      // that can't query PermissionSetGroup). Log it, but not as a red error —
      // the UI reports it inline where the user can act on it.
      const silent = msg._silentError && resp?.error && resp.error !== 'SESSION_EXPIRED';
      window.SFToolkitDebug.log('users',
        resp?.error === 'SESSION_EXPIRED' ? 'session' : (resp?.error && !silent) ? 'error' : 'api',
        `${msg.type}${tag ? '  ' + tag : ''}`, silent ? null : (resp?.error || null), dur);
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
