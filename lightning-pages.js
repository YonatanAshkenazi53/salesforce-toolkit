// ============================================================
// Lightning Pages Manager
// List all FlexiPages, inspect per-profile assignments,
// add / remove profile assignments, show impacted users.
// ============================================================
const LightningPages = (() => {
  let _orgUrl    = null;
  let _sid       = null;
  let _container = null;

  let allPages         = [];   // FlexiPage records
  let allProfiles      = [];   // Profile records (cached after first load)
  let profileUserCache = {};   // profileId -> [User records]
  let allApps          = [];   // AppDefinition records (cached after first load)
  let recordTypeCache  = {};   // sObjectType → [RecordType records]

  // ── N3: assignment → users resolution ────────────────────
  // _wswScan   — the (expensive) full Tooling scan of every FlexiPage's
  //              assignments. Shared by "Who sees what?" and the reverse
  //              "Which pages does a user see?" lens so we scan once.
  // _lpAudience — resolved user data for the profiles named in assignments:
  //              { byProfile: {lowercased profile name → [User]},
  //                missingProfiles: [names not found in this org],
  //                totalActive: n|null, capped: bool, cap: n, error: string|null }
  let _wswScan   = null;
  let _lpAudience = null;
  const LP_USER_CAP      = 2000;  // hard cap on users pulled for profile audiences
  const LP_USER_SHOW     = 25;    // users listed inline before "and N more"
  const LP_LENS_USER_CAP = 200;   // users listed in the reverse-lens picker
  const LP_CTX_CAP       = 120;   // app × record-type × form-factor rows in the lens

  // ActionOverride is NOT a SOQL-queryable sObject in any Salesforce org —
  // querying it always returns HTTP 400. Org-default detection relies on the
  // sObject describe endpoint's `actionOverrides` array instead (Strategy in
  // fetchCustomObjectOrgDefaults + Pass 2 of fetchOrgDefaults). This flag is
  // kept permanently false so the broken SOQL query is never attempted.
  let _actionOverrideSupported = false;
  let _aoStorageKey = '';   // set in init() once orgUrl is known

  // Set to false if the Tooling AppDefinition sObject returns HTTP 400 in this org.
  // All AppDefinition strategies in ensureApps() are skipped when false.
  let _appDefinitionSupported = true;

  // ── Public API ───────────────────────────────────────────
  function init(container, orgUrl, sid) {
    _orgUrl    = orgUrl;
    _sid       = sid;
    _container = container;
    allPages                  = [];
    allProfiles               = [];
    profileUserCache          = {};
    allApps                   = [];
    recordTypeCache           = {};
    _appDefinitionSupported   = true;
    _wswScan                  = null;
    _lpAudience               = null;

    // ActionOverride SOQL is never supported — keep the flag off (see decl).
    _aoStorageKey = `sftk_ao_${orgUrl.replace(/[^a-z0-9]/gi, '_')}`;
    _actionOverrideSupported = false;
    renderShell();
    // C5c: one delegated listener for every "↗ open in X" cross-link —
    // survives all the innerHTML re-renders inside the container. Guarded so
    // repeated init() calls never stack duplicate listeners.
    if (!container.dataset.lpXlinkWired) {
      container.addEventListener('click', ev => {
        const link = ev.target.closest?.('.lp-xlink');
        if (link?.dataset.xtab) jumpToTab(link.dataset.xtab);
      });
      container.dataset.lpXlinkWired = '1';
    }
    loadPages();
  }

  function updateSession(orgUrl, sid) {
    _orgUrl = orgUrl;
    _sid    = sid;
  }

  // ── C5c: cross-links into sibling Toolkit tabs ────────────
  // Lightning Pages findings often continue in another tool (Field Cleaner,
  // Copy Permissions, Flows, Flow Access). HOME_FEATURES actions (popup.js)
  // both navigate AND kick off the target tab's first data load; bare
  // navigateToTab is the fallback. typeof-guarded so the module stays inert
  // if it ever loads outside the popup shell. No prefill — the target tabs
  // have no handoff state (same convention as field-cleaner.js C5a).
  function jumpToTab(tabId) {
    try {
      const feat = (typeof HOME_FEATURES !== 'undefined')
        ? HOME_FEATURES.find(f => f.id === tabId) : null;
      if (feat) { feat.action(); return; }
      if (typeof navigateToTab === 'function') navigateToTab(tabId);
    } catch (e) { /* a broken convenience link must never break the tab */ }
  }

  // Small link-styled "↗ open in X" button. Clicks inside the container are
  // handled by ONE delegated listener wired in init(); links rendered in a
  // modal (outside the container) are wired directly. Escapes everything.
  const _LP_XLINK_CSS =
    'background:none;border:none;padding:0;margin-left:8px;' +
    'color:#0176d3;font:inherit;font-size:11px;font-weight:600;' +
    'cursor:pointer;text-decoration:underline;white-space:nowrap;';
  function xlinkHtml(tabId, label, title) {
    return `<button type="button" class="lp-xlink" data-xtab="${esc(tabId)}"` +
           ` title="${esc(title || '')}" style="${_LP_XLINK_CSS}">${esc(label)}</button>`;
  }

  // ── Shell ────────────────────────────────────────────────
  function renderShell() {
    _container.innerHTML = `
      <div class="lp-wrap">
        <div class="lp-toolbar" style="flex-wrap:wrap">
          <input class="search-input lp-search" id="lpSearch"
            placeholder="🔍 Search pages…" autocomplete="off" style="min-width:140px">
          <button class="btn-icon" id="lpRefreshBtn" title="Reload pages">🔄</button>
          <button class="btn btn-secondary btn-sm lp-profile-map-btn" id="lpProfileMapBtn" title="Show which page each profile sees">👤 Who sees what?</button>
          <button class="btn btn-secondary btn-sm" id="lpUserLensBtn" style="white-space:nowrap" title="Pick a user → the page they get for each object, and which assignment rule won">🔎 What a user sees</button>
        </div>
        <div id="lpLoading" style="display:none">
          ${sftkCat('Loading Lightning pages…')}
        </div>
        <div id="lpContent" class="lp-content"></div>
      </div>
    `;

    document.getElementById('lpSearch').addEventListener('input', () => {
      // Only filter in list mode (detail header won't exist in list mode)
      if (!document.getElementById('lpDetailHeader')) renderPageList();
    });

    document.getElementById('lpRefreshBtn').addEventListener('click', () => {
      allPages                  = [];
      allProfiles               = [];
      profileUserCache          = {};
      allApps                   = [];
      recordTypeCache           = {};
      // ActionOverride is never SOQL-queryable (always HTTP 400) — keep the flag
      // off on refresh too, matching init(). See the flag declaration comment.
      _actionOverrideSupported  = false;
      _appDefinitionSupported   = true;
      _wswScan                  = null;
      _lpAudience               = null;
      loadPages();
    });

    document.getElementById('lpProfileMapBtn').addEventListener('click', () => openProfileMap());
    document.getElementById('lpUserLensBtn').addEventListener('click', () => openUserLens());
  }

  // ── Entity-name resolution ─────────────────────────────────
  // FlexiPage.EntityDefinitionId is an API name for STANDARD objects
  // ("Account") but the raw CustomObject id (01I…) for CUSTOM objects —
  // describing that id 404s (and custom-object record pages never got their
  // org-default detection). Resolve ids → QualifiedApiName once per load.
  const _lpEntityNames = new Map();   // '01I…' (15-char) → 'MyObj__c'
  function _lpEntityName(entity) {
    if (!entity) return entity;
    if (!/^01I/i.test(entity)) return entity;                 // already an API name
    return _lpEntityNames.get(entity.substring(0, 15)) || null;
  }
  async function _lpResolveEntityNames(entities) {
    const ids = [...new Set(entities.filter(e => e && /^01I/i.test(e)).map(e => e.substring(0, 15)))]
      .filter(id => !_lpEntityNames.has(id));
    if (!ids.length) return;
    try {
      const res = await bg({
        type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: false,
        query: `SELECT DurableId, QualifiedApiName FROM EntityDefinition WHERE DurableId IN (${ids.map(i => `'${i}'`).join(',')})`
      });
      for (const r of (res.records || [])) _lpEntityNames.set(r.DurableId, r.QualifiedApiName);
    } catch (_) { /* unresolved ids are skipped by callers */ }
  }

  // ── Load all FlexiPages ───────────────────────────────────
  async function loadPages() {
    setLoading(true);
    setContent('');

    // PublishStatus is NOT a queryable SOQL field on FlexiPage in all org types
    // (fails with HTTP 400 in Developer Edition, Scratch orgs, etc.).
    // We fetch it instead from the Tooling REST GET per-page (/sobjects/FlexiPage/{id})
    // which always returns it. This avoids a noisy error in the debug log.
    const res = await bg({
      type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true,
      query: `SELECT Id,DeveloperName,MasterLabel,Type,EntityDefinitionId,ManageableState ` +
             `FROM FlexiPage ORDER BY MasterLabel`
    });

    setLoading(false);

    if (res.error) {
      const fe = sftkFriendlyError(res.error);
      const userMsg = res.error === 'SESSION_EXPIRED'
        ? 'Session expired — log back into Salesforce, then click 🔄'
        : `Failed to load pages: ${esc(fe.message + (fe.hint ? ' — ' + fe.hint : ''))}`;
      setContent(sftkCat(userMsg, true));
      return;
    }

    allPages = res.records || [];
    renderPageList();
    // Background: determine which pages are set as org default.
    // Fetches metadata for Active pages in batches; re-renders list as results arrive.
    fetchOrgDefaults();
  }

  // Fetches pageAssignments for all Active pages in batches to determine
  // which are set as the org-wide default.  Runs in the background after
  // the initial list renders; updates allPages and re-renders incrementally.
  async function fetchOrgDefaults() {
    // ── Pass 1: pageAssignments scan ─────────────────────────────────────────
    // Standard FlexiPage org defaults store their assignment in
    // Metadata.pageAssignments. Scope to unmanaged pages (ManageableState IS
    // in the list query). The old filter used p.PublishStatus — a field the
    // list query deliberately does NOT select (it 400s in some orgs) — so it
    // was undefined on every record, targets was always [], and this entire
    // pass silently never ran: org-default badges for Home/App pages were
    // never detected.
    const targets = allPages.filter(p => (p.ManageableState || 'unmanaged') === 'unmanaged');
    const BATCH = 5;
    for (let i = 0; i < targets.length; i += BATCH) {
      const slice = targets.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        slice.map(p => bg({ type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid,
                             sobject: 'FlexiPage', id: p.Id }))
      );
      let changed = false;
      for (let j = 0; j < slice.length; j++) {
        const r = results[j];
        if (r.status !== 'fulfilled' || r.value?.error) continue;
        const assignments = r.value.Metadata?.pageAssignments || [];
        // An org-wide default has no app and no profile
        const isOrgDefault = assignments.some(a => !a.app && !a.profile);
        const idx = allPages.findIndex(p => p.Id === slice[j].Id);
        if (idx !== -1 && !!allPages[idx]._isOrgDefault !== isOrgDefault) {
          allPages[idx] = { ...allPages[idx], _isOrgDefault: isOrgDefault };
          changed = true;
        }
      }
      // Only re-render if user is still on the list view (not inside a detail panel)
      if (changed && !document.getElementById('lpDetailHeader')) renderPageList();
    }

    // ── Pass 2: sObject describe scan for custom-object record pages ────────
    // Custom-object org defaults are stored in the CustomObject actionOverrides,
    // NOT in FlexiPage.Metadata.pageAssignments. The describe endpoint returns the
    // current active pageId for each sObject action, so one call per unique
    // EntityDefinitionId tells us which page is the org default without fetching
    // full metadata for every record page.
    // This is why a page with null PublishStatus can actually be the active org default.
    const recordPageCandidates = allPages.filter(p =>
      p.EntityDefinitionId &&
      (p.PublishStatus || '').toLowerCase() !== 'draft' &&
      (p.PublishStatus || '').toLowerCase() !== 'obsolete'
    );
    const sObjectTypes = [...new Set(recordPageCandidates.map(p => p.EntityDefinitionId))];

    // Custom-object entries are 01I… ids — resolve them to API names first
    // (describing the raw id 404s).
    await _lpResolveEntityNames(sObjectTypes);

    for (const sObjectType of sObjectTypes) {
      const apiName = _lpEntityName(sObjectType);
      if (!apiName) continue;   // unresolved custom-object id — nothing to describe
      try {
        const descRes = await bg({
          type: 'SF_REST_GET', orgUrl: _orgUrl, sid: _sid,
          path: `services/data/v62.0/sobjects/${apiName}/describe/?_=${Date.now()}`
        });
        if (descRes.error || !Array.isArray(descRes.actionOverrides)) continue;

        const viewOverrides = descRes.actionOverrides.filter(o =>
          (o.name || '').toLowerCase() === 'view' && o.pageId
        );
        if (!viewOverrides.length) continue;

        // Collect unique pageIds the describe says are the org default for this object
        const defaultPageIds = [...new Set(viewOverrides.map(o => o.pageId.toLowerCase()))];

        let changed = false;
        for (const oPidLower of defaultPageIds) {
          const oPid15 = oPidLower.substring(0, 15);
          const idx = allPages.findIndex(p => {
            const pIdLower = (p.Id || '').toLowerCase();
            return pIdLower === oPidLower ||
                   pIdLower.startsWith(oPid15) ||
                   oPidLower.startsWith(pIdLower.substring(0, 15));
          });
          if (idx === -1) continue;
          // Mark as Active + org default so the green dot appears in the list
          const needsUpdate = allPages[idx].PublishStatus !== 'Active' ||
                              !allPages[idx]._isOrgDefault;
          if (needsUpdate) {
            allPages[idx] = { ...allPages[idx], PublishStatus: 'Active', _isOrgDefault: true };
            changed = true;
          }
        }
        if (changed && !document.getElementById('lpDetailHeader')) renderPageList();
      } catch (_) {
        // Ignore errors for individual sObject types — list still renders with what we have
      }
    }
  }

  // Keep allPages in sync after status-changing operations so the list
  // shows fresh dots without a full reload.
  function syncPageStatus(pageId, publishStatus) {
    const idx = allPages.findIndex(p => p.Id === pageId);
    if (idx !== -1) allPages[idx] = { ...allPages[idx], PublishStatus: publishStatus };
  }

  // ── Page list (grouped by type) ───────────────────────────
  function renderPageList() {
    const content = document.getElementById('lpContent');
    if (!content) return;

    // Switch back to list layout
    content.className = 'lp-content';

    const q = (document.getElementById('lpSearch')?.value || '').toLowerCase().trim();
    const filtered = allPages.filter(p =>
      !q ||
      (p.MasterLabel  || '').toLowerCase().includes(q) ||
      (p.DeveloperName || '').toLowerCase().includes(q)
    );

    if (allPages.length === 0) {
      content.innerHTML = `<div class="lp-empty">No Lightning pages found in this org.</div>`;
      return;
    }
    if (filtered.length === 0) {
      content.innerHTML = `<div class="lp-empty">No pages match "<strong>${esc(q)}</strong>".</div>`;
      return;
    }

    const TYPE_ORDER = ['RecordPage','AppPage','HomePage','UtilityBar','FlowPage','LoginPage'];

    // Group
    const groups = {};
    for (const p of filtered) {
      const key = TYPE_ORDER.includes(p.Type) ? p.Type : 'Other';
      if (!groups[key]) groups[key] = [];
      groups[key].push(p);
    }
    const keys = [
      ...TYPE_ORDER.filter(t => groups[t]),
      ...Object.keys(groups).filter(k => !TYPE_ORDER.includes(k) && k !== 'Other'),
      ...(groups['Other'] ? ['Other'] : [])
    ];

    let html = '';
    for (const typeKey of keys) {
      const pages = groups[typeKey];
      html += `
        <div class="lp-group">
          <div class="lp-group-hdr">
            <span class="lp-type-icon">${typeIcon(typeKey)}</span>
            <span class="lp-type-label">${esc(humanType(typeKey))}</span>
            <span class="lp-type-count">${pages.length}</span>
          </div>`;
      for (const p of pages) {
        const obj = p.EntityDefinitionId
          ? `<span class="lp-obj-tag">${esc(_lpEntityName(p.EntityDefinitionId) || p.EntityDefinitionId)}</span>` : '';
        const ps  = (p.PublishStatus || '').toLowerCase();
        const dotCls = ps === 'active'   ? 'lp-dot-active'
                     : ps === 'obsolete' ? 'lp-dot-obsolete'
                     : ps === 'draft'    ? 'lp-dot-draft'
                     : 'lp-dot-unknown'; // null/empty = scanning in background
        const dotTitle = ps === 'active' ? 'Active' : ps === 'obsolete' ? 'Obsolete'
                       : ps === 'draft'  ? 'Draft'  : 'Checking…';
        const defBadge = p._isOrgDefault
          ? '<span class="lp-badge lp-badge-default">Org Default</span>' : '';
        html += `
          <div class="lp-row" data-id="${esc(p.Id)}">
            <span class="lp-status-dot ${dotCls}" title="${esc(dotTitle)}"></span>
            <div class="lp-row-info">
              <span class="lp-row-name">${esc(p.MasterLabel)}</span>
              ${obj}
              ${defBadge}
            </div>
            <span class="lp-row-arrow">›</span>
          </div>`;
      }
      html += `</div>`;
    }

    content.innerHTML = html;
    content.querySelectorAll('.lp-row').forEach(row => {
      row.addEventListener('click', () => {
        const page = allPages.find(p => p.Id === row.dataset.id);
        if (page) openDetail(page);
      });
    });
  }

  // ── Page → Assignments map view ──────────────────────────
  // Shows every Lightning Page with its active status, org-default flag,
  // and all profile / app assignments. Replaces the old profile-centric view.
  async function openProfileMap() {
    const content = document.getElementById('lpContent');
    if (!content) return;
    content.className = 'lp-content lp-content--detail';
    content.innerHTML = `
      <div class="lp-detail-hdr" id="lpDetailHeader">
        <button class="lp-back-btn" id="lpBackBtn">‹ Back</button>
        <div class="lp-detail-title">
          <div class="lp-detail-name">Who sees what?</div>
          <div class="lp-detail-sub"><span>All pages — status, org default &amp; profile assignments</span></div>
        </div>
      </div>
      <div id="lpDetailBody" class="lp-detail-body">
        ${sftkCat('Loading pages…')}
      </div>`;
    document.getElementById('lpBackBtn').addEventListener('click', () => renderPageList());

    const body = document.getElementById('lpDetailBody');

    try {
      const pageDataArr = await scanAllPageAssignments(
        pct => { if (document.getElementById('lpDetailBody') && body) body.innerHTML = sftkCat(`Loading pages… ${pct}%`); },
        () => !!document.getElementById('lpDetailBody')
      );
      if (pageDataArr === null) return;   // navigated away mid-scan

      if (!document.getElementById('lpDetailBody')) return;

      // ── N3: resolve assignments → real users ──────────────
      if (body) body.innerHTML = sftkCat('Resolving users…');
      const audience = await ensureAudience(pageDataArr);
      // Object → every active assignment on that object (across all pages).
      // Needed for the org-default subtraction: "everyone EXCEPT the users a
      // more specific assignment already captured for this same object".
      const objIndex = lpBuildObjectIndex(pageDataArr);
      if (!document.getElementById('lpDetailBody')) return;

      // Helper: render one page card
      const renderCard = ({ page, meta, assignments, orgDefaults, orgDefaultDebug, scanError }) => {
        // Use direct PublishStatus field from SOQL list as the primary source — it's more
        // reliable than the compound Metadata field which returns null for managed pages.
        const ps     = (page.PublishStatus || meta?.Metadata?.publishStatus || '').toLowerCase();
        const dotCls = ps === 'active'   ? 'lp-dot-active'
                     : ps === 'obsolete' ? 'lp-dot-obsolete'
                     : ps === 'draft'    ? 'lp-dot-draft'
                     : 'lp-dot-unknown'; // empty string = genuinely unknown
        const isOrgDefault = orgDefaults.length > 0 ||
                             assignments.some(a => !a.profile && !a.app);
        const orgBadge = isOrgDefault
          ? '<span class="lp-badge lp-badge-default">Org Default</span>' : '';
        const objTag = page.EntityDefinitionId
          ? `<span class="lp-obj-tag">${esc(_lpEntityName(page.EntityDefinitionId) || page.EntityDefinitionId)}</span>` : '';

        // Build assignments HTML
        let assignHtml = '';

        // ── N3: resolve each assignment to the users it actually reaches ──
        // Only ACTIVE pages reach anyone; a Draft/Obsolete page is shown to
        // nobody no matter what assignments it carries, so we say that plainly
        // instead of printing a user count that would be a lie.
        const isActivePage = ps === 'active';
        const objKey  = lpObjectKeyOf({ page, meta });
        const sameObj = objIndex.get(objKey) || [];
        // Card-header badge: users this page reaches summed across its rows.
        // Org-default and profile rows never overlap (the org-default count
        // already subtracts every profile that has its own assignment on the
        // same object), so a plain sum is correct. App-scoped rows add nothing
        // to the total — we cannot confirm app visibility per profile — they
        // only flip pageCountSure so the badge is marked as a lower bound.
        let pageAudience  = 0;
        let pageCountSure = true;

        // Org-default rows
        for (const a of assignments.filter(a => !a.profile && !a.app)) {
          const ffKey = (a.formFactor || 'Large');
          const ff    = ffKey === 'Small' ? '📱 Mobile' : '🖥 Desktop';
          // Profiles captured by a MORE SPECIFIC, app-independent assignment on
          // the SAME object + form factor never reach the org default.
          // App-scoped assignments are deliberately NOT subtracted: they only
          // win inside their app, so those users still land here everywhere else.
          const overridingProfiles = [...new Set(sameObj
            .filter(x => x.assignment?.profile && !x.assignment.app
                      && (x.assignment.formFactor || 'Large') === ffKey)
            .map(x => x.assignment.profile))];
          const excl  = lpSumProfileCounts(audience, overridingProfiles);
          const total = audience.totalActive;
          const net   = (total == null || !excl.exact) ? null : Math.max(0, total - excl.count);

          let countBit;
          if (!isActivePage) {
            countBit = `<span style="font-size:11px;color:var(--subtext)">page inactive — 0 users</span>`;
          } else if (net != null) {
            countBit = `<span class="lp-pm-user-count">👥 ${net} user${net !== 1 ? 's' : ''}</span>`;
          } else {
            countBit = `<span style="font-size:11px;color:#c0392b" title="${esc(audience.countError || excl.reason || 'user count unavailable')}">👥 count unavailable</span>`;
          }
          if (isActivePage) {
            if (net != null) pageAudience += net; else pageCountSure = false;
          }

          const exclIds = overridingProfiles
            .map(n => lpProfileIdByName(n)).filter(Boolean);
          const expander = isActivePage
            ? `<details style="margin:2px 0 2px 18px" class="lp-od-users" data-ff="${esc(ffKey)}" data-excl="${esc(JSON.stringify(exclIds))}">
                 <summary style="cursor:pointer;font-size:11px;color:#0176d3">Show users</summary>
                 <div style="padding:3px 0 3px 8px;border-left:2px solid rgba(128,128,128,.35);max-height:220px;overflow:auto">
                   <span style="font-size:11px;color:var(--subtext)">Not loaded yet.</span>
                 </div>
               </details>`
            : '';
          const exclNote = overridingProfiles.length
            ? `<div style="font-size:10px;color:var(--subtext);padding-left:18px">Excludes ${overridingProfiles.length} profile${overridingProfiles.length !== 1 ? 's' : ''} with their own ${esc(objKey.startsWith('__page:') ? 'page' : objKey)} assignment: ${esc(overridingProfiles.slice(0, 6).join(', '))}${overridingProfiles.length > 6 ? `, +${overridingProfiles.length - 6} more` : ''}.</div>`
            : '';
          const appNote = sameObj.some(x => x.assignment?.app)
            ? `<div style="font-size:10px;color:var(--subtext);padding-left:18px">⚠ App-specific assignments exist for this object. Those users still see this org-default page <em>outside</em> that app, so they are counted here. App visibility per profile is not queried.</div>`
            : '';
          assignHtml += `<div class="lp-wsw-row">
            <span class="lp-wsw-who">🌐 Org Default</span>
            <span class="lp-wsw-ff">${ff}</span>
            ${countBit}
          </div>${exclNote}${appNote}${expander}`;
        }

        // Profile-specific rows (no app context)
        for (const a of assignments.filter(a => a.profile && !a.app)) {
          const ff   = (a.formFactor || 'Large') === 'Small' ? '📱' : '🖥';
          const aud  = lpProfileAudience(audience, a.profile);
          let countBit, expander;
          if (!isActivePage) {
            countBit = `<span style="font-size:11px;color:var(--subtext)">page inactive — 0 users</span>`;
            expander = '';
          } else if (!aud.resolved) {
            countBit = `<span style="font-size:11px;color:#c0392b">profile not found in this org — cannot resolve users</span>`;
            expander = '';
          } else {
            countBit = `<span class="lp-pm-user-count">👥 ${aud.count} user${aud.count !== 1 ? 's' : ''}${aud.exact ? '' : ' (approx.)'}</span>`;
            expander = lpUsersBlockHtml(aud.users, aud.count,
              audience.capped ? `Sample only — the org-wide user pull hit the ${LP_USER_CAP}-user cap.` : '');
            pageAudience += (aud.count || 0);
            if (!aud.exact) pageCountSure = false;
          }
          assignHtml += `<div class="lp-wsw-row">
            <span class="lp-wsw-who">👤 ${esc(a.profile)}</span>
            <span class="lp-wsw-ff">${ff}</span>
            ${countBit}
          </div>${expander}`;
        }

        // App-context rows
        for (const a of assignments.filter(a => a.app)) {
          const ff  = (a.formFactor || 'Large') === 'Small' ? '📱' : '🖥';
          const rt  = a.recordType ? ` · RT ${esc(a.recordType)}` : '';
          const who = a.profile ? `⚡ ${esc(a.app)} · ${esc(a.profile)}${rt}` : `⚡ ${esc(a.app)}${rt}`;
          let countBit, expander = '', note = '';
          // App-scoped rows never contribute to the header total (we cannot
          // confirm who actually has the app), so the badge becomes a floor.
          if (isActivePage) pageCountSure = false;
          if (!isActivePage) {
            countBit = `<span style="font-size:11px;color:var(--subtext)">page inactive — 0 users</span>`;
          } else if (a.profile) {
            const aud = lpProfileAudience(audience, a.profile);
            if (!aud.resolved) {
              countBit = `<span style="font-size:11px;color:#c0392b">profile not found in this org — cannot resolve users</span>`;
            } else {
              countBit = `<span class="lp-pm-user-count">👥 up to ${aud.count} user${aud.count !== 1 ? 's' : ''}</span>`;
              expander = lpUsersBlockHtml(aud.users, aud.count, '');
              note = `<div style="font-size:10px;color:var(--subtext);padding-left:18px">Only while these users are inside the <strong>${esc(a.app)}</strong> app${a.recordType ? ` viewing a <strong>${esc(a.recordType)}</strong> record` : ''}. We do <em>not</em> query app visibility per profile, so some of them may not have this app at all.</div>`;
            }
          } else {
            countBit = `<span style="font-size:11px;color:var(--subtext)">every user of this app</span>`;
            note = `<div style="font-size:10px;color:var(--subtext);padding-left:18px">App-default assignment — reaches whoever can open the <strong>${esc(a.app)}</strong> app. App visibility per profile is not queried, so this cannot be resolved to a user list.</div>`;
          }
          assignHtml += `<div class="lp-wsw-row">
            <span class="lp-wsw-who">${who}</span>
            <span class="lp-wsw-ff">${ff}</span>
            ${countBit}
          </div>${note}${expander}`;
        }

        if (!assignHtml) {
          assignHtml = `<div class="lp-wsw-none">No assignments${isActivePage ? ' — no user reaches this page through an assignment' : ''}</div>`;
        }
        if (scanError) {
          // The Tooling GET for this page failed, so its assignment list is
          // EMPTY BECAUSE WE COULD NOT READ IT — not because nobody sees it.
          assignHtml = `<div style="font-size:10px;color:#c0392b;padding:2px 0">⚠ Could not read this page's assignments (${esc(sftkFriendlyError(String(scanError)).message)}). Its audience is <strong>unknown</strong>, not zero — and any user it captures is still being counted in some other page's org-default number below.</div>` + assignHtml;
        }
        if (audience.error) {
          assignHtml = `<div style="font-size:10px;color:#c0392b;padding:2px 0">⚠ User lookup failed (${esc(sftkFriendlyError(audience.error).message)}) — counts below are incomplete.</div>` + assignHtml;
        }
        const badgeUsers = isActivePage && (pageAudience > 0 || !pageCountSure)
          ? `<span class="lp-pm-user-count" title="${pageCountSure
                ? 'Active users this page reaches (org default + profile assignments)'
                : 'Lower bound — some rows could not be resolved to users (app-scoped assignment, missing profile, or a failed count). Expand the rows for the detail.'}">👥 ${pageAudience}${pageCountSure ? '' : '+'}</span>`
          : '';

        // Show the debug panel ONLY for genuine errors — not for the normal case where
        // describe succeeded but found no View overrides (which conclusively means
        // "not org default" and is a correct, successful determination, not a failure).
        // Also suppress when ActionOverride was simply skipped because it is unsupported
        // in this org type (Dev Edition, some sandboxes) — that is expected, not an error.
        const aoSkipped      = !!orgDefaultDebug?.strategy1Skipped;
        const hasDescribeErr = !!orgDefaultDebug?.describeError && orgDefaultDebug.describeError !== 'ok';
        const hasDescribeExc = !!orgDefaultDebug?.describeException;
        const hasAoErr       = !!orgDefaultDebug?.aoError && orgDefaultDebug.aoError !== 'ok'
          && !/ActionOverride.*not supported|sObject type.*ActionOverride/i.test(orgDefaultDebug.aoError || '');
        const hasTopExc      = !!orgDefaultDebug?.exception;
        const showDebugPanel = !!orgDefaultDebug && !aoSkipped
          && (hasDescribeErr || hasDescribeExc || hasAoErr || hasTopExc);
        const debugPanel = showDebugPanel
          ? `<details style="margin-top:6px;font-size:10px;border:1px solid #e07b39;border-radius:3px;padding:2px 6px;background:#fff8f4;">
               <summary style="cursor:pointer;font-weight:600;color:#c0392b;">⚠ Org-default detection failed</summary>
               <pre style="margin:4px 0;white-space:pre-wrap;word-break:break-all;max-height:150px;overflow:auto;">${esc(JSON.stringify(orgDefaultDebug, null, 2))}</pre>
             </details>`
          : '';

        return `<div class="lp-wsw-card">
          <div class="lp-wsw-card-hdr">
            <span class="lp-status-dot ${dotCls}" title="${ps === 'active' ? 'Active' : ps === 'obsolete' ? 'Obsolete' : ps === 'draft' ? 'Draft' : 'Unknown'}"></span>
            <span class="lp-wsw-page-name">${esc(page.MasterLabel)}</span>
            ${orgBadge}${objTag}${badgeUsers}
            <span class="lp-wsw-type">${esc(humanType(page.Type))}</span>
            <button class="lp-wsw-open btn-link" data-id="${esc(page.Id)}" title="Open in Salesforce">↗</button>
          </div>
          <div class="lp-wsw-card-body">${assignHtml}${debugPanel}</div>
        </div>`;
      };

      // Separate active vs draft/inactive — prefer direct SOQL PublishStatus over Metadata compound
      const getStatus = d => (d.page.PublishStatus || d.meta?.Metadata?.publishStatus || '').toLowerCase();
      const activePages   = pageDataArr.filter(d => getStatus(d) === 'active');
      const inactivePages = pageDataArr.filter(d => getStatus(d) !== 'active');

      let html = lpAudienceCaveatHtml(audience, pageDataArr);
      if (activePages.length) {
        html += `<div class="lp-pm-section-hdr">✅ Active Pages (${activePages.length})</div>`;
        for (const d of activePages) html += renderCard(d);
      }
      if (inactivePages.length) {
        html += `<div class="lp-pm-section-hdr" style="margin-top:14px">○ Draft / Inactive Pages (${inactivePages.length})</div>`;
        for (const d of inactivePages) html += renderCard(d);
      }
      if (!activePages.length && !inactivePages.length) html += `<div class="lp-empty-sm">No Lightning Pages found.</div>`;

      if (body) body.innerHTML = html;

      // Wire: org-default "Show users" expanders — the "everyone except the
      // profiles with their own assignment" list is fetched lazily on first
      // open (one query per row) so opening the view stays cheap.
      body?.querySelectorAll('details.lp-od-users').forEach(det => {
        det.addEventListener('toggle', async () => {
          if (!det.open || det.dataset.loaded) return;
          det.dataset.loaded = '1';
          const slot = det.querySelector('div');
          if (slot) slot.innerHTML = sftkCatSm('Loading users…');
          let exclIds = [];
          try { exclIds = JSON.parse(det.dataset.excl || '[]'); } catch (_) { exclIds = []; }
          const res = await fetchOrgDefaultUsers(exclIds);
          if (!slot) return;
          if (res.error) {
            const fe = sftkFriendlyError(res.error);
            slot.innerHTML = `<span style="font-size:11px;color:#c0392b">Could not load users: ${esc(fe.message)}</span>`;
            return;
          }
          slot.innerHTML = lpUserRowsHtml(res.users, res.total,
            res.capped ? `Showing the first ${res.users.length} by name — ${res.total != null ? res.total : 'the full set'} match in total.` : '');
        });
      });

      // Wire: open-in-LAB buttons
      body?.querySelectorAll('.lp-wsw-open').forEach(btn => {
        btn.addEventListener('click', () => {
          chrome.tabs.create({
            url: `${_orgUrl}/visualEditor/appBuilder.app?id=${btn.dataset.id}`
          });
        });
      });

    } catch (e) {
      const fe = sftkFriendlyError(e.message);
      if (body) body.innerHTML = sftkCat(esc(fe.message + (fe.hint ? ' — ' + fe.hint : '')), true);
    }
  }

  // ══════════════════════════════════════════════════════════
  // N3 — assignment → users resolution
  // ══════════════════════════════════════════════════════════

  // Full Tooling scan of every FlexiPage's assignments.  Extracted from
  // openProfileMap so the reverse "What does a user see?" lens reuses the exact
  // same data (and the same cache) instead of scanning the org twice.
  //
  // onProgress(pct)   — called before each batch
  // stillAlive()      — return false to abort (view navigated away); the
  //                     function then returns null so callers can bail cleanly.
  async function scanAllPageAssignments(onProgress, stillAlive) {
    if (_wswScan) return _wswScan;

    // Ensure profiles loaded — assignments name profiles, we need Ids.
    if (!allProfiles.length) {
      const pRes = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid,
        tooling: false, query: 'SELECT Id,Name FROM Profile ORDER BY Name' });
      if (!pRes.error && pRes.records) allProfiles = pRes.records;
    }

    const BATCH = 5;
    const targets = [...allPages].sort((a, b) =>
      (a.MasterLabel || '').localeCompare(b.MasterLabel || '')
    );

    const pageDataArr = [];
    for (let i = 0; i < targets.length; i += BATCH) {
      if (stillAlive && !stillAlive()) return null;   // navigated away
      if (onProgress) onProgress(Math.round((i / Math.max(1, targets.length)) * 100));

      const slice = targets.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        slice.map(p => bg({ type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid,
                             sobject: 'FlexiPage', id: p.Id }))
      );
      for (let j = 0; j < slice.length; j++) {
        const r = results[j];
        if (r.status !== 'fulfilled' || r.value?.error) {
          pageDataArr.push({ page: slice[j], meta: null, assignments: [], orgDefaults: [],
                             scanError: r.status === 'fulfilled' ? (r.value?.error || 'unknown') : String(r.reason?.message || r.reason) });
          continue;
        }
        const meta = r.value;
        // Use sobjectType from Metadata compound field first, then fall back to
        // EntityDefinitionId from the initial SOQL list — critical for custom Record
        // Pages where Metadata.sobjectType may return null.
        const sobjectType    = meta.Metadata?.sobjectType || slice[j].EntityDefinitionId || null;
        const devName        = meta.FullName || slice[j].DeveloperName;
        const apiAssignments = meta.Metadata?.pageAssignments || [];
        // Prefer direct PublishStatus from SOQL list (more reliable than compound Metadata
        // field, which returns null for managed/system pages even when they are active).
        const pageStatus = (slice[j].PublishStatus || meta.Metadata?.publishStatus || '').toLowerCase();
        let assignments = [...apiAssignments];
        let orgDefaults = [];
        let resolvedPage = slice[j]; // may be updated if org-default detection infers Active status
        // Only SKIP the describe/ActionOverride check when the page is explicitly Draft or
        // Obsolete. Unknown/null status (managed or recently-created pages) still gets checked.
        if (sobjectType && pageStatus !== 'draft' && pageStatus !== 'obsolete') {
          orgDefaults = await fetchCustomObjectOrgDefaults(sobjectType, devName, slice[j].Id);
          for (const co of orgDefaults) {
            const already = apiAssignments.some(
              a => !a.profile && !a.app && (a.formFactor || 'Large') === co.formFactor
            );
            if (!already) assignments.push(co);
          }
          // Salesforce enforces: a page can only be an org default while Active.
          // Unconditionally set status to Active when org-default is confirmed —
          // this corrects stale Tooling API data without any extra round-trip.
          if (orgDefaults.length > 0) {
            resolvedPage = { ...slice[j], PublishStatus: 'Active' };
            syncPageStatus(slice[j].Id, 'Active');
          }
        }
        // Only attach debug data when org-default detection was actually attempted for
        // this page.  Pages without an sobjectType (Utility Bar, App Home, etc.) skip
        // the check entirely and must NOT inherit stale debug from the previous page
        // in the same batch — _orgDefaultDebug is a module-level variable.
        const ranOrgDefaultCheck = !!(sobjectType && pageStatus !== 'draft' && pageStatus !== 'obsolete');
        pageDataArr.push({ page: resolvedPage, meta, assignments, orgDefaults,
                           orgDefaultDebug: ranOrgDefaultCheck ? _orgDefaultDebug : null });
      }
    }

    _wswScan = pageDataArr;
    return pageDataArr;
  }

  // Object bucket for a scanned page. Record pages group by their object so the
  // org-default subtraction only ever compares assignments that actually compete.
  // Pages with no object (Home / App / Utility Bar) get their own private bucket.
  function lpObjectKeyOf(d) {
    const raw   = d?.meta?.Metadata?.sobjectType || d?.page?.EntityDefinitionId || null;
    const named = raw ? (_lpEntityName(raw) || raw) : null;
    return named || `__page:${d?.page?.Id || ''}`;
  }

  // object key → [{ page, assignment }] for ACTIVE pages only.
  // A Draft/Obsolete page is shown to nobody, so its assignments must not
  // subtract anyone from another page's org-default audience.
  function lpBuildObjectIndex(pageDataArr) {
    const idx = new Map();
    for (const d of (pageDataArr || [])) {
      const st = (d.page?.PublishStatus || d.meta?.Metadata?.publishStatus || '').toLowerCase();
      if (st !== 'active') continue;
      const key = lpObjectKeyOf(d);
      if (!idx.has(key)) idx.set(key, []);
      const bucket = idx.get(key);
      for (const a of (d.assignments || [])) bucket.push({ page: d.page, assignment: a });
    }
    return idx;
  }

  function lpProfileIdByName(name) {
    const n = String(name || '').toLowerCase();
    const rec = allProfiles.find(p => (p.Name || '').toLowerCase() === n);
    return rec ? rec.Id : null;
  }

  // Resolve every profile named by any assignment to its active users.
  // Two queries per 100 profiles:
  //   • GROUP BY ProfileId  → EXACT per-profile counts (never capped)
  //   • the user rows       → the sample list we can actually display (capped)
  // Plus one COUNT() for the org-wide active-user denominator.
  async function ensureAudience(pageDataArr) {
    if (_lpAudience) return _lpAudience;

    const out = {
      byProfile: {},        // lowercased profile name → [User] (null = profile not in org)
      countByProfile: {},   // lowercased profile name → exact active-user count
      missingProfiles: [],
      totalActive: null,
      capped: false,
      cap: LP_USER_CAP,
      error: null,
      countError: null,
      groupError: null
    };

    const names = new Set();
    for (const d of (pageDataArr || [])) {
      for (const a of (d.assignments || [])) {
        if (a && a.profile) names.add(String(a.profile));
      }
    }

    const idByName = new Map();
    const nameById = new Map();
    for (const n of names) {
      const id = lpProfileIdByName(n);
      if (id) {
        idByName.set(n, id);
        // Index under both the 18- and 15-char forms: the aggregate query can
        // come back with either casing/length depending on API version.
        nameById.set(id, n);
        nameById.set(String(id).substring(0, 15), n);
        out.byProfile[n.toLowerCase()] = [];
      } else {
        out.missingProfiles.push(n);
        out.byProfile[n.toLowerCase()] = null;
      }
    }

    // Org-wide denominator for the org-default rows.
    const cRes = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: false,
      query: 'SELECT COUNT() FROM User WHERE IsActive = true', _silentError: true });
    if (cRes && !cRes.error && typeof cRes.totalSize === 'number') out.totalActive = cRes.totalSize;
    else out.countError = cRes?.error || 'COUNT() returned no total';

    const ids = [...idByName.values()];
    let pulled = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const chunk   = ids.slice(i, i + 100);
      const inList  = chunk.map(x => lpSoqlLit(x)).join(',');

      // Exact counts (aggregate — unaffected by the row cap below).
      const gRes = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: false,
        query: `SELECT ProfileId, COUNT(Id) cnt FROM User ` +
               `WHERE IsActive = true AND ProfileId IN (${inList}) GROUP BY ProfileId`,
        _silentError: true });
      if (gRes?.error) {
        out.groupError = gRes.error;
      } else {
        for (const g of (gRes?.records || [])) {
          const nm = nameById.get(g.ProfileId) || nameById.get(String(g.ProfileId || '').substring(0, 15));
          if (nm) out.countByProfile[nm.toLowerCase()] = Number(g.cnt) || 0;
        }
      }

      // The displayable rows.
      const remaining = LP_USER_CAP - pulled;
      if (remaining <= 0) { out.capped = true; continue; }
      const res = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: false,
        query: `SELECT Id,Name,Username,Profile.Name FROM User ` +
               `WHERE IsActive = true AND ProfileId IN (${inList}) ` +
               `ORDER BY Name LIMIT ${remaining}` });
      if (res?.error) { out.error = res.error; break; }
      const recs = res?.records || [];
      pulled += recs.length;
      if (recs.length >= remaining) out.capped = true;
      for (const u of recs) {
        const pn = String(u.Profile?.Name || '').toLowerCase();
        if (!Array.isArray(out.byProfile[pn])) out.byProfile[pn] = [];
        out.byProfile[pn].push(u);
      }
    }

    // Seed the legacy per-profile cache only when the pull was complete —
    // caching a truncated list would make later "show users" views silently wrong.
    if (!out.capped && !out.error) {
      for (const [n, id] of idByName) {
        const lst = out.byProfile[n.toLowerCase()];
        if (Array.isArray(lst)) profileUserCache[id] = lst;
      }
    }

    _lpAudience = out;
    return out;
  }

  function lpProfileAudience(audience, profileName) {
    const key   = String(profileName || '').toLowerCase();
    const users = audience?.byProfile?.[key];
    const exact = audience?.countByProfile?.[key];
    const resolved = Array.isArray(users);
    return {
      resolved,
      users: resolved ? users : [],
      count: (typeof exact === 'number') ? exact : (resolved ? users.length : null),
      exact: typeof exact === 'number'
    };
  }

  // Sum of active users across a list of profile names.
  // exact=false when any profile could not be resolved or had no exact count —
  // the caller must then refuse to print a number rather than print a guess.
  function lpSumProfileCounts(audience, profileNames) {
    let total = 0, exact = true, reason = '';
    for (const n of (profileNames || [])) {
      const a = lpProfileAudience(audience, n);
      if (!a.resolved)   { exact = false; reason = `profile "${n}" not found in this org`; continue; }
      if (!a.exact)      { exact = false; reason = `no exact user count for profile "${n}"`; }
      total += (a.count || 0);
    }
    return { count: total, exact, reason };
  }

  // Plain user rows: name · username · profile. `total` is the true count when
  // known so the "and N more" line is honest about what is being hidden.
  function lpUserRowsHtml(users, total, note) {
    const list  = users || [];
    const shown = list.slice(0, LP_USER_SHOW);
    const real  = (typeof total === 'number') ? total : list.length;
    if (!real) return `<span style="font-size:11px;color:var(--subtext)">No active users.</span>`;
    let inner = shown.map(u =>
      `<div style="font-size:11px;padding:1px 0;display:flex;gap:6px;flex-wrap:wrap">` +
        `<span style="font-weight:600">${esc(u.Name)}</span>` +
        `<span style="color:var(--subtext)">${esc(u.Username)}</span>` +
        `<span style="color:var(--subtext)">· ${esc(u.Profile?.Name || 'unknown profile')}</span>` +
      `</div>`).join('');
    const more = real - shown.length;
    if (more > 0) {
      inner += `<div style="font-size:11px;color:var(--subtext);padding-top:3px">…and ${more} more (only the first ${shown.length} by name are listed)</div>`;
    }
    if (note) inner += `<div style="font-size:10px;color:var(--subtext);padding-top:3px">${esc(note)}</div>`;
    return inner;
  }

  function lpUsersBlockHtml(users, exactCount, note) {
    const real = (typeof exactCount === 'number') ? exactCount : (users || []).length;
    if (!real) return `<div style="font-size:11px;color:var(--subtext);padding:1px 0 1px 18px">No active users on this profile.</div>`;
    return `<details style="margin:2px 0 2px 18px">
      <summary style="cursor:pointer;font-size:11px;color:#0176d3">Show ${real} user${real !== 1 ? 's' : ''}</summary>
      <div style="padding:3px 0 3px 8px;border-left:2px solid rgba(128,128,128,.35);max-height:220px;overflow:auto">
        ${lpUserRowsHtml(users, exactCount, note)}
      </div></details>`;
  }

  // Up-front honesty panel: what these numbers do and do NOT account for.
  function lpAudienceCaveatHtml(audience, pageDataArr) {
    const bits = [];
    const failed = (pageDataArr || []).filter(d => d.scanError);
    if (failed.length) {
      bits.push(`<span style="color:#c0392b">${failed.length} page${failed.length !== 1 ? 's' : ''} could not be read from the Tooling API — their assignments are unknown, so every number below may be missing users those pages capture.</span>`);
    }
    bits.push('Counts are <strong>active users only</strong>. Inactive pages are shown to nobody, so their rows read 0.');
    bits.push('<strong>App visibility per profile is not queried</strong> — an “App + Profile” row is an upper bound (only the users who actually have that app see the page there), and an “App default” row cannot be resolved to a user list at all.');
    bits.push('Precedence used: <em>App + Record Type + Profile</em> &gt; <em>App + Profile</em> &gt; <em>App default</em> &gt; <em>Profile</em> &gt; <em>Org default</em>.');
    if (audience?.totalActive == null) {
      bits.push(`<span style="color:#c0392b">Org-wide active-user count unavailable (${esc(audience?.countError || 'unknown error')}) — org-default rows cannot show a number.</span>`);
    } else {
      bits.push(`Org has <strong>${audience.totalActive}</strong> active users.`);
    }
    if (audience?.capped) {
      bits.push(`<span style="color:#b35c00">User lists were capped at ${LP_USER_CAP} rows — per-profile <em>counts</em> stay exact (aggregate query), but the expandable lists are samples.</span>`);
    }
    if (audience?.groupError) {
      bits.push(`<span style="color:#b35c00">Exact per-profile counts unavailable (${esc(audience.groupError)}) — falling back to the length of the fetched sample, which may undercount.</span>`);
    }
    if (audience?.missingProfiles?.length) {
      bits.push(`<span style="color:#c0392b">${audience.missingProfiles.length} assigned profile${audience.missingProfiles.length !== 1 ? 's are' : ' is'} not present in this org and could not be resolved: ${esc(audience.missingProfiles.slice(0, 8).join(', '))}${audience.missingProfiles.length > 8 ? '…' : ''}.</span>`);
    }
    return `<details style="margin:0 0 8px;border:1px solid rgba(128,128,128,.35);border-radius:4px;padding:4px 8px">
      <summary style="cursor:pointer;font-size:11px;font-weight:600">ℹ️ How these user counts are worked out (and what they can't tell you)</summary>
      <ul style="margin:6px 0 2px 16px;padding:0;font-size:10px;line-height:1.5;color:var(--subtext)">
        ${bits.map(b => `<li style="margin-bottom:3px">${b}</li>`).join('')}
      </ul></details>`;
  }

  // Users who fall through to an org default: every active user EXCEPT those on
  // a profile that already has its own app-independent assignment for the same
  // object. Fetched on demand (one query per expander).
  async function fetchOrgDefaultUsers(excludeProfileIds) {
    const ids  = (excludeProfileIds || []).filter(Boolean);
    const where = ['IsActive = true'];
    if (ids.length) where.push(`ProfileId NOT IN (${ids.map(x => lpSoqlLit(x)).join(',')})`);
    const clause = where.join(' AND ');

    const cRes = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: false,
      query: `SELECT COUNT() FROM User WHERE ${clause}`, _silentError: true });
    const total = (cRes && !cRes.error && typeof cRes.totalSize === 'number') ? cRes.totalSize : null;

    const res = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: false,
      query: `SELECT Id,Name,Username,Profile.Name FROM User WHERE ${clause} ORDER BY Name LIMIT ${LP_USER_SHOW}` });
    if (res?.error) return { users: [], total, capped: false, error: res.error };
    const users = res.records || [];
    return { users, total, capped: total != null && total > users.length, error: null };
  }

  // ══════════════════════════════════════════════════════════
  // N3 — reverse lens: pick a user → which page do they get, and why
  // ══════════════════════════════════════════════════════════
  async function openUserLens() {
    const content = document.getElementById('lpContent');
    if (!content) return;
    content.className = 'lp-content lp-content--detail';
    content.innerHTML = `
      <div class="lp-detail-hdr" id="lpDetailHeader">
        <button class="lp-back-btn" id="lpBackBtn">‹ Back</button>
        <div class="lp-detail-title">
          <div class="lp-detail-name">What does a user see?</div>
          <div class="lp-detail-sub"><span>Pick a user → the page they get per object, and which assignment rule won</span></div>
        </div>
      </div>
      <div id="lpDetailBody" class="lp-detail-body">
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">
          <input class="search-input" id="lpUlSearch" placeholder="🔍 Search users by name or username…" autocomplete="off" style="flex:1">
          <button class="btn btn-secondary btn-sm" id="lpUlSearchBtn">Search</button>
        </div>
        <div id="lpUlList">${sftkCat('Loading users…')}</div>
      </div>`;
    document.getElementById('lpBackBtn').addEventListener('click', () => renderPageList());

    const run = () => loadLensUsers(document.getElementById('lpUlSearch')?.value || '');
    document.getElementById('lpUlSearchBtn').addEventListener('click', run);
    document.getElementById('lpUlSearch').addEventListener('keydown', ev => {
      if (ev.key === 'Enter') run();
    });
    loadLensUsers('');
  }

  // Searchable, click-to-select user list (same click-a-row pattern as the page list).
  async function loadLensUsers(term) {
    const listEl = document.getElementById('lpUlList');
    if (!listEl) return;
    listEl.innerHTML = sftkCat('Loading users…');

    const t = String(term || '').trim();
    const where = ['IsActive = true'];
    if (t) {
      const like = lpSoqlLike(t);
      where.push(`(Name LIKE ${like} OR Username LIKE ${like})`);
    }
    const clause = where.join(' AND ');

    const cRes = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: false,
      query: `SELECT COUNT() FROM User WHERE ${clause}`, _silentError: true });
    const total = (cRes && !cRes.error && typeof cRes.totalSize === 'number') ? cRes.totalSize : null;

    const res = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: false,
      query: `SELECT Id,Name,Username,ProfileId,Profile.Name FROM User WHERE ${clause} ` +
             `ORDER BY Name LIMIT ${LP_LENS_USER_CAP}` });
    if (!document.getElementById('lpUlList')) return;
    if (res?.error) {
      const fe = sftkFriendlyError(res.error);
      listEl.innerHTML = sftkCat(`Could not load users: ${esc(fe.message + (fe.hint ? ' — ' + fe.hint : ''))}`, true);
      return;
    }
    const users = res.records || [];
    if (!users.length) {
      listEl.innerHTML = `<div class="lp-empty-sm">No active user matches “${esc(t)}”.</div>`;
      return;
    }

    const capped = (total != null && total > users.length) || users.length >= LP_LENS_USER_CAP;
    let html = '';
    if (capped) {
      html += `<div style="font-size:10px;color:#b35c00;padding:2px 0 6px">Showing the first ${users.length}${total != null ? ` of ${total}` : ''} matching active users — narrow the search to reach the rest.</div>`;
    } else {
      html += `<div style="font-size:10px;color:var(--subtext);padding:2px 0 6px">${users.length} active user${users.length !== 1 ? 's' : ''}.</div>`;
    }
    for (const u of users) {
      html += `<div class="lp-row" data-uid="${esc(u.Id)}">
        <div class="lp-row-info">
          <span class="lp-row-name">${esc(u.Name)}</span>
          <span class="lp-obj-tag">${esc(u.Profile?.Name || 'no profile')}</span>
          <span style="font-size:10px;color:var(--subtext);margin-left:6px">${esc(u.Username)}</span>
        </div>
        <span class="lp-row-arrow">›</span>
      </div>`;
    }
    listEl.innerHTML = html;
    listEl.querySelectorAll('.lp-row').forEach(row => {
      row.addEventListener('click', () => {
        const u = users.find(x => x.Id === row.dataset.uid);
        if (u) renderUserLens(u);
      });
    });
  }

  // For one user: every object that has an active Lightning page assignment,
  // and which page wins in each app / record-type context — naming the rule.
  async function renderUserLens(user) {
    const body = document.getElementById('lpDetailBody');
    if (!body) return;
    body.innerHTML = sftkCat('Scanning page assignments…');

    const scan = await scanAllPageAssignments(
      pct => { const b = document.getElementById('lpDetailBody'); if (b) b.innerHTML = sftkCat(`Scanning page assignments… ${pct}%`); },
      () => !!document.getElementById('lpDetailBody')
    );
    if (scan === null) return;
    const bodyEl = document.getElementById('lpDetailBody');
    if (!bodyEl) return;

    const profileName = user.Profile?.Name || '';
    const objIndex    = lpBuildObjectIndex(scan);
    const pageById    = new Map();
    for (const d of scan) pageById.set(d.page.Id, d.page);

    let html = `<div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px">
      <button class="btn btn-secondary btn-sm" id="lpUlBack">‹ Pick another user</button>
      <strong>${esc(user.Name)}</strong>
      <span style="font-size:11px;color:var(--subtext)">${esc(user.Username)}</span>
      <span class="lp-obj-tag">${esc(profileName || 'no profile')}</span>
    </div>`;

    if (!profileName) {
      html += `<div style="font-size:11px;color:#c0392b;padding:4px 0">This user record has no readable Profile name, so profile-scoped assignments cannot be matched. Only org defaults below are reliable.</div>`;
    }

    html += `<div style="font-size:10px;color:var(--subtext);border:1px solid rgba(128,128,128,.35);border-radius:4px;padding:5px 8px;margin-bottom:8px;line-height:1.5">
      <strong>What this can and cannot tell you.</strong>
      Only <strong>active</strong> Lightning pages are considered — a draft page reaches nobody.
      Rows are generated for every app and record type <em>named by an assignment</em> on that object;
      we do <strong>not</strong> query which apps this user's profile can open, nor which record types they can access,
      so an “inside app X” row only applies if they actually have app X.
      Permission-set-based page overrides are not part of the FlexiPage assignment model and are not shown.
      Precedence: App + Record Type + Profile &gt; App + Profile &gt; App default &gt; Profile &gt; Org default.
    </div>`;

    const scanFailed = scan.filter(d => d.scanError);
    if (scanFailed.length) {
      html += `<div style="font-size:10px;color:#c0392b;padding:0 0 6px">⚠ ${scanFailed.length} page${scanFailed.length !== 1 ? 's' : ''} could not be read from the Tooling API (${esc(scanFailed.slice(0, 4).map(d => d.page.MasterLabel || d.page.Id).join(', '))}${scanFailed.length > 4 ? '…' : ''}). If one of them carries a more specific assignment for this user, the winner shown below is wrong.</div>`;
    }

    const keys = [...objIndex.keys()].sort((a, b) => a.localeCompare(b));
    let rendered = 0;
    let ctxBudget = LP_CTX_CAP;
    let ctxTruncated = false;

    for (const key of keys) {
      const entries     = objIndex.get(key) || [];
      const assignments = entries.map(e => ({ ...e.assignment, _pageId: e.page.Id, _pageLabel: e.page.MasterLabel || e.page.DeveloperName || e.page.Id }));
      if (!assignments.length) continue;

      // Contexts worth evaluating: every app / record type / form factor that
      // some assignment on this object actually names, plus the "none" case.
      const apps = [null, ...new Set(assignments.map(a => a.app).filter(Boolean))];
      const rts  = [null, ...new Set(assignments.map(a => a.recordType).filter(Boolean))];
      const ffs  = [...new Set(assignments.map(a => a.formFactor || 'Large'))];
      if (!ffs.length) ffs.push('Large');

      const rows = [];
      for (const ff of ffs) {
        for (const app of apps) {
          for (const rt of rts) {
            if (ctxBudget <= 0) { ctxTruncated = true; break; }
            ctxBudget--;
            const r = lpResolveWinner(assignments, { profile: profileName, app, recordType: rt, formFactor: ff });
            rows.push({ ff, app, rt, r });
          }
          if (ctxBudget <= 0) break;
        }
        if (ctxBudget <= 0) break;
      }

      if (!rows.length) continue;   // budget ran out before this object

      const objLabel = key.startsWith('__page:')
        ? (pageById.get(key.slice(7))?.MasterLabel || 'Page with no object')
        : key;

      // Collapse identical outcomes — most contexts resolve to the same page
      // for the same reason, and one line per combination is unreadable noise.
      const groups = new Map();
      for (const row of rows) {
        const winKey = row.r.winner ? (row.r.winner._pageId || row.r.winner._pageLabel || '') : '(none)';
        const k = `${winKey}|${row.r.scope}|${row.r.reason}`;
        if (!groups.has(k)) groups.set(k, { r: row.r, contexts: [] });
        groups.get(k).contexts.push(row);
      }

      let rowsHtml = '';
      for (const g of groups.values()) {
        const r = g.r;
        const ctxLabels = g.contexts.map(({ ff, app, rt }) => [
          ff === 'Small' ? '📱 Mobile' : '🖥 Desktop',
          app ? `⚡ ${esc(app)}` : 'any app',
          rt ? `RT ${esc(rt)}` : 'any record type'
        ].join(' · '));
        const ctxTxt = ctxLabels.slice(0, 6).join('<br>') +
          (ctxLabels.length > 6 ? `<br>+${ctxLabels.length - 6} more combination${ctxLabels.length - 6 !== 1 ? 's' : ''}` : '');
        const winTxt = r.winner
          ? `<strong>${esc(r.winner._pageLabel || '')}</strong> <span class="lp-obj-tag">${esc(r.scope)}</span>`
          : `<span style="color:var(--subtext)">Salesforce standard page (no assignment matches)</span>`;
        rowsHtml += `<div style="padding:4px 0;border-top:1px solid rgba(128,128,128,.2)">
          <div style="font-size:11px">${winTxt}</div>
          <div style="font-size:10px;color:var(--subtext);padding-top:2px">${ctxTxt}</div>
          <div style="font-size:10px;color:var(--subtext);padding-top:2px"><strong>Why:</strong> ${esc(r.reason)}</div>`;
        if (r.beaten.length) {
          rowsHtml += `<div style="font-size:10px;color:var(--subtext);padding-top:2px">Beat: ${
            r.beaten.slice(0, 4).map(b => `${esc(b.assignment._pageLabel || '')} <em>(${esc(b.scope)}, specificity ${b.rank})</em>`).join('; ')
          }${r.beaten.length > 4 ? `; +${r.beaten.length - 4} more` : ''}.</div>`;
        }
        rowsHtml += `</div>`;
      }

      html += `<div class="lp-wsw-card">
        <div class="lp-wsw-card-hdr">
          <span class="lp-wsw-page-name">${esc(objLabel)}</span>
          <span class="lp-wsw-type">${groups.size} outcome${groups.size !== 1 ? 's' : ''} across ${rows.length} combination${rows.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="lp-wsw-card-body">${rowsHtml}</div>
      </div>`;
      rendered++;
    }

    if (!rendered && !ctxTruncated) {
      html += `<div class="lp-empty-sm">No active Lightning page carries any assignment in this org — every object falls back to the Salesforce standard page.</div>`;
    }
    if (ctxTruncated) {
      html += `<div style="font-size:10px;color:#b35c00;padding:6px 0">⚠ Stopped after ${LP_CTX_CAP} app × record-type × form-factor combinations — later objects are incomplete. Use “Who sees what?” for the full assignment inventory.</div>`;
    }

    bodyEl.innerHTML = html;
    document.getElementById('lpUlBack')?.addEventListener('click', () => openUserLens());
  }

  // ── Load Lightning apps with sequential fallback strategies ─
  // Each strategy is tried in turn; we stop as soon as one returns usable data.
  //
  // Strategy order:
  //   1. REST AppMenuItem WHERE Type='App'  — most universally supported, no Tooling needed
  //   2. REST AppMenuItem (no type filter)  — broader net for orgs where Type='App' is empty
  //   3. Tooling AppDefinition with Label   — Tooling fallback (skipped if unsupported)
  //   4. Tooling AppDefinition with MasterLabel — older API version variant
  //   5. Tooling AppDefinition minimal      — last resort (DeveloperName only)
  //
  // Failure modes addressed:
  //   • AppDefinition not supported in all orgs (HTTP 400) → _appDefinitionSupported flag
  //   • AppDefinition.MasterLabel may not exist in all API versions → try Label first
  //   • AppMenuItem.Name is often null → accept records with just Label
  //   • Type='App' filter may exclude some Lightning apps → also try without filter
  async function ensureApps() {
    if (allApps.length > 0) return;

    // Helper: normalise a raw records array into allApps format and sort
    function appsFromRecords(records, nameField, labelField) {
      const hits = records.filter(r => r[labelField]);
      return hits.map(r => ({
        DeveloperName: r[nameField] || r[labelField],
        MasterLabel:   r[labelField]
      })).sort((a, b) => (a.MasterLabel || '').localeCompare(b.MasterLabel || ''));
    }

    // Strategy 1 — REST: AppMenuItem WHERE Type='App' (most compatible, no Tooling needed)
    const r1 = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
                          query: "SELECT Name,Label FROM AppMenuItem WHERE Type='App' ORDER BY Label" });
    if (!r1.error && r1.records?.length) {
      const apps = appsFromRecords(r1.records, 'Name', 'Label');
      if (apps.length) { allApps = apps; return; }
    }

    // Strategy 2 — REST: AppMenuItem with no Type filter (catches all app-type items)
    const r2 = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
                          query: "SELECT Name,Label,Type FROM AppMenuItem ORDER BY Label" });
    if (!r2.error && r2.records?.length) {
      // Keep records whose Type looks like an application (App / Application / AppPage)
      const appTypes = new Set(['App', 'Application', 'AppPage']);
      const filtered = r2.records.filter(r => r.Label && (!r.Type || appTypes.has(r.Type)));
      if (filtered.length) {
        allApps = appsFromRecords(filtered, 'Name', 'Label');
        return;
      }
      // If the type filter removed everything, fall back to all records with a Label
      const apps = appsFromRecords(r2.records, 'Name', 'Label');
      if (apps.length) { allApps = apps; return; }
    }

    // Strategies 3-5 — Tooling: AppDefinition (skipped entirely if unsupported in this org)
    if (!_appDefinitionSupported) return;

    // Strategy 3 — Tooling: AppDefinition with Label (most compatible field)
    const r3 = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true,
                          query: 'SELECT DeveloperName,Label FROM AppDefinition ORDER BY Label' });
    if (r3.error && /not supported|sObject type/i.test(r3.error)) {
      _appDefinitionSupported = false; return;
    }
    if (!r3.error && r3.records?.length) {
      const apps = appsFromRecords(r3.records, 'DeveloperName', 'Label');
      if (apps.length) { allApps = apps; return; }
    }

    // Strategy 4 — Tooling: AppDefinition with MasterLabel (older API versions)
    const r4 = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true,
                          query: 'SELECT DeveloperName,MasterLabel FROM AppDefinition' });
    if (r4.error && /not supported|sObject type/i.test(r4.error)) {
      _appDefinitionSupported = false; return;
    }
    if (!r4.error && r4.records?.length) {
      const apps = appsFromRecords(r4.records, 'DeveloperName', 'MasterLabel');
      if (apps.length) { allApps = apps; return; }
    }

    // Strategy 5 — Tooling: AppDefinition minimal (DeveloperName only, describe-safe)
    const r5 = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true,
                          query: 'SELECT DeveloperName FROM AppDefinition' });
    if (r5.error && /not supported|sObject type/i.test(r5.error)) {
      _appDefinitionSupported = false; return;
    }
    if (!r5.error && r5.records?.length) {
      allApps = r5.records
        .filter(r => r.DeveloperName)
        .map(r => ({ DeveloperName: r.DeveloperName, MasterLabel: r.DeveloperName }))
        .sort((a, b) => a.DeveloperName.localeCompare(b.DeveloperName));
    }
  }

  // ── Org-default assignment detection ─────────────────────
  // Org-default FlexiPage assignments are stored as ActionOverride records (one per
  // formFactor) and in CustomObject.actionOverrides — NOT in FlexiPage.pageAssignments.
  // The Tooling API's pageAssignments field aggregates only assignments made through
  // the FlexiPage path; CustomObject-based org defaults (our activation mechanism)
  // are invisible to it.
  //
  // Strategy:
  //   1. Query Tooling API ActionOverride — direct, single query, works for any object.
  //   2. Fallback: read CustomObject Metadata compound (works for custom objects,
  //      may not work for standard objects like Contact).
  //
  // Returns an array of synthetic assignment objects {formFactor, default:true} or [].
  // Debug log — surfaced in UI when page shows Draft but strategies all fail
  let _orgDefaultDebug = null;

  // pageId: FlexiPage record Id (15 or 18 char) — used to match describe actionOverrides
  //         and ActionOverride.Content (which can be either devName or pageId depending on org)
  async function fetchCustomObjectOrgDefaults(sObjectType, devName, pageId = null) {
    if (!sObjectType || !devName) return [];
    _orgDefaultDebug = null;
    const log = {};
    // devName from FullName may be 'ObjectName-DevName'; keep both the full and
    // short (post-hyphen) lowercase forms. Function-scoped so every matching
    // strategy below (perm-set, ActionOverride) can use them — a later strategy
    // referenced these out of an earlier block's scope (caught by no-undef).
    const devNameLower = devName.toLowerCase();
    const devNameShort = devNameLower.includes('-')
      ? devNameLower.split('-').slice(1).join('-')
      : devNameLower;

    try {
      // ── Strategy 0: sObject describe — most reliable (direct live read) ───────
      // GET /services/data/v62.0/sobjects/{SObjectType}/describe/ returns
      // actionOverrides[{name, type, formFactor, pageId}] showing the CURRENT
      // active FlexiPage for each action + formFactor.
      try {
        // Resolve a 01I… custom-object id to its API name before describing.
        await _lpResolveEntityNames([sObjectType]);
        const descApiName = _lpEntityName(sObjectType) || sObjectType;
        const descRes = await bg({
          type: 'SF_REST_GET', orgUrl: _orgUrl, sid: _sid,
          path: `services/data/v62.0/sobjects/${descApiName}/describe/?_=${Date.now()}`
        });
        log.describeError = descRes.error || 'ok';
        if (!descRes.error && Array.isArray(descRes.actionOverrides)) {
          log.describeOverrides = descRes.actionOverrides.length;
          log.allViewOverrides  = descRes.actionOverrides
            .filter(o => (o.name || '').toLowerCase() === 'view')
            .map(o => ({ name: o.name, type: o.type, formFactor: o.formFactor, pageId: o.pageId }));
          log.pageIdUsed   = pageId;
          log.devNameUsed  = devName;
          // Normalise IDs to lowercase for case-insensitive comparison —
          // the describe endpoint and Tooling SOQL can return different casing
          // for the same Salesforce ID, causing === to fail silently.
          const pageIdLower = (pageId || '').toLowerCase();
          // devNameLower / devNameShort are function-scoped (defined at the top).

          const matches = descRes.actionOverrides.filter(o => {
            // name must be 'View' (case-insensitive)
            if ((o.name || '').toLowerCase() !== 'view') return false;
            // Must have a non-empty pageId — we rely on ID/devName matching below
            // to ensure we only match FlexiPage records (no prefix or type guard needed)
            if (!o.pageId) return false;
            const oPidLower = o.pageId.toLowerCase();
            const oPid15    = oPidLower.substring(0, 15);
            // Primary: match by pageId — all comparisons are case-insensitive
            // and handle 15/18-char Salesforce ID variants
            if (pageIdLower && (
              oPidLower === pageIdLower ||
              oPidLower === pageIdLower.substring(0, 15) ||
              pageIdLower.startsWith(oPid15)
            )) return true;
            // Fallback: look up page in allPages by the describe's pageId,
            // then confirm by comparing DeveloperName — this handles cases where
            // the describe endpoint and the Tooling API return different ID formats
            const matchedPage = allPages.find(p => {
              const pIdLower = (p.Id || '').toLowerCase();
              return pIdLower === oPidLower ||
                     pIdLower.startsWith(oPid15) ||
                     oPidLower.startsWith(pIdLower.substring(0, 15));
            });
            if (!matchedPage) return false;
            const mpDev = (matchedPage.DeveloperName || '').toLowerCase();
            return mpDev === devNameLower || mpDev === devNameShort;
          });
          log.describeMatches = matches.length;
          if (matches.length > 0) {
            return matches.map(o => ({
              formFactor: (o.formFactor || 'LARGE').toUpperCase() === 'SMALL' ? 'Small' : 'Large',
              default:    true,
              _source:    'describe'
            }));
          }
          // Describe succeeded and found View overrides, but none belong to this page.
          // The describe API is authoritative: a different page is the org default.
          // This is a conclusive, successful determination — not an error or warning.
          // Clear _orgDefaultDebug so no warning is surfaced for this normal case.
          // Skip Strategy 1 — running ActionOverride SOQL would be redundant and may
          // generate a noisy 400 error in orgs where ActionOverride isn't queryable.
          const overridesWithPageId = (log.allViewOverrides || []).filter(o => o.pageId);
          if (overridesWithPageId.length > 0) {
            _orgDefaultDebug = null;
            return [];
          }
          // Describe found NO View overrides with page IDs — not conclusive.
          // Fall through to Strategy 1 to try the ActionOverride SOQL approach.
          log.describeNoMatch = true;
        }
      } catch (descErr) {
        log.describeException = descErr.message;
        // Describe failed entirely — fall through to SOQL strategy
      }

      // ── Strategy 1: Standard REST SOQL ActionOverride ───────────────────
      // ActionOverride is a standard (non-Tooling) SOQL object — querying it
      // via the standard REST endpoint avoids the Tooling API cache entirely.
      // ContentName stores the FlexiPage DeveloperName OR record ID, depending
      // on org / API version — we try both in a single pass.
      // Skipped when _actionOverrideSupported is false (first 400 sets it permanently).
      if (!_actionOverrideSupported) {
        log.strategy1Skipped = 'ActionOverride not supported in this org';
        _orgDefaultDebug = log;
        return [];
      }
      try {
        const aoRes = await bg({
          type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: false,
          _suppressError: true,  // HTTP 400 is expected in Dev Edition orgs — don't flash red
          query: `SELECT Id,Name,SObjectType,ContentName,FormFactor,Type ` +
                 `FROM ActionOverride ` +
                 `WHERE Name = 'View' AND SObjectType = '${sObjectType}'`
        });
        log.aoError = aoRes.error || 'ok';
        // Self-healing: if the org doesn't support ActionOverride, disable all future attempts
        // and persist so the next popup open skips it immediately (no more 400 on every init).
        if (aoRes.error && /ActionOverride.*not supported|sObject type.*ActionOverride/i.test(aoRes.error)) {
          _actionOverrideSupported = false;
          try { sessionStorage.setItem(_aoStorageKey, 'false'); } catch (_) {}
        }
        if (!aoRes.error && Array.isArray(aoRes.records)) {
          log.aoRecords = aoRes.records.map(r => ({
            ContentName: r.ContentName, FormFactor: r.FormFactor, Type: r.Type
          }));
          const pageIdLower   = (pageId || '').toLowerCase();
          const pageIdLower15 = pageIdLower.substring(0, 15);
          const aoMatches = aoRes.records.filter(r => {
            const t  = (r.Type || '').toLowerCase();
            // Only consider flexipage-type overrides (ignore VF, Aura, standard, etc.)
            if (t && t !== 'flexipage' && t !== 'default') return false;
            const cn = (r.ContentName || '').toLowerCase();
            // Match by DeveloperName (most common) or by pageId (some orgs store the ID)
            if (cn === devNameLower || cn === devNameShort) return true;
            if (pageIdLower && (
              cn === pageIdLower ||
              cn === pageIdLower15 ||
              cn.startsWith(pageIdLower15) ||
              pageIdLower15.startsWith(cn.substring(0, 15))
            )) return true;
            return false;
          });
          log.aoMatches = aoMatches.length;
          if (aoMatches.length > 0) {
            return aoMatches.map(r => ({
              formFactor: (r.FormFactor || 'LARGE').toUpperCase() === 'SMALL' ? 'Small' : 'Large',
              default:    true,
              _source:    'actionOverride'
            }));
          }
        }
      } catch (aoErr) {
        log.aoException = aoErr.message;
      }

      // All strategies exhausted with no match → page is genuinely not the org default.
      _orgDefaultDebug = log;
      return [];
    } catch (e) {
      _orgDefaultDebug = { ...log, exception: e.message };
      return [];
    }
  }

  // ── Page detail ───────────────────────────────────────────
  // errorMsg:              shows an error banner at the top of the detail (post-deploy errors).
  // publishStatusOverride: overrides the API-returned publishStatus (handles Tooling API lag).
  // assignmentsOverride:   overrides the API-returned assignments (used immediately after save
  //                        so the user sees the correct state before the API catches up).
  async function openDetail(page, errorMsg = null, publishStatusOverride = null, assignmentsOverride = null) {
    const content = document.getElementById('lpContent');
    if (!content) return;

    // Switch to detail layout (pinned header + scrollable body)
    content.className = 'lp-content lp-content--detail';
    content.innerHTML = `
      <div class="lp-detail-hdr" id="lpDetailHeader">
        <button class="lp-back-btn" id="lpBackBtn">‹ Back</button>
        <div class="lp-detail-title">
          <div class="lp-detail-name">${esc(page.MasterLabel)}</div>
          <div class="lp-detail-sub">
            <span>${esc(humanType(page.Type))}</span>
            ${page.EntityDefinitionId
              ? `<span class="lp-obj-tag">${esc(_lpEntityName(page.EntityDefinitionId) || page.EntityDefinitionId)}</span>` +
                xlinkHtml('fields', '↗ Field Cleaner',
                  'Open Field Cleaner to scan and clean fields on this same object')
              : ''}
          </div>
        </div>
        <div class="lp-hdr-actions">
          <button class="lp-clone-btn" id="lpCloneBtn" title="Clone this page" disabled>📋 Clone</button>
          <button class="lp-open-sf-btn" id="lpOpenSfBtn" title="Open in Salesforce">↗ Open in Salesforce</button>
        </div>
      </div>
      <div id="lpDetailBody" class="lp-detail-body">
        ${sftkCat('Loading assignments…')}
      </div>
    `;

    document.getElementById('lpBackBtn').addEventListener('click', () => renderPageList());
    document.getElementById('lpOpenSfBtn').addEventListener('click', () => {
      chrome.tabs.create({ url: `${_orgUrl}/visualEditor/appBuilder.app?id=${page.Id}` });
    });

    // Load apps first (sequential fallback — only runs once, then cached)
    await ensureApps();

    // Fetch page metadata, profiles, and record types in parallel.
    const sObjectType = page.EntityDefinitionId || null;
    const [metaRes, profileRes, rtRes] = await Promise.all([
      bg({ type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid,
           sobject: 'FlexiPage', id: page.Id }),
      allProfiles.length > 0
        ? Promise.resolve({ records: allProfiles, error: null })
        : bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
               query: `SELECT Id,Name FROM Profile ORDER BY Name` }),
      sObjectType && !recordTypeCache[sObjectType]
        ? bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
               query: `SELECT DeveloperName,Name FROM RecordType WHERE SObjectType='${sObjectType}' AND IsActive=true ORDER BY Name` })
        : Promise.resolve({ records: recordTypeCache[sObjectType] || [], error: null }),
    ]);

    // Sync PublishStatus from the Tooling GET response.
    // Three sources, tried in order of reliability:
    //
    //   1. metaRes.PublishStatus       — top-level sObject field returned by the bare
    //                                    REST GET (/tooling/sobjects/FlexiPage/{id}).
    //                                    This IS present even in Developer Edition orgs
    //                                    where the SOQL PublishStatus field 400s.
    //
    //   2. metaRes.Metadata.publishStatus — nested inside the compound Metadata field.
    //                                    Works in most org types but null in Dev Edition.
    //
    //   3. Tooling SOQL SELECT Metadata FROM FlexiPage — second-to-last resort;
    //                                    also tends to return null in Dev Edition.
    if (!page.PublishStatus && !publishStatusOverride) {
      const raw = metaRes?.PublishStatus               // ← top-level sObject field (NEW)
               || metaRes?.Metadata?.publishStatus     // ← compound Metadata field
               || null;
      if (raw) {
        // Normalize to Title Case to match the SOQL convention (Active / Draft / Obsolete).
        const normalized = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
        page = { ...page, PublishStatus: normalized };
        syncPageStatus(page.Id, normalized);
      }
    }

    // Tooling SOQL fallback — last-resort for orgs where both REST GET fields are null.
    // A Tooling SOQL query against FlexiPage.Metadata retrieves the compound field via
    // a different code path and may return publishStatus when the REST GET doesn't.
    if (!page.PublishStatus && !publishStatusOverride) {
      try {
        const fqRes = await bg({
          type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true,
          query: `SELECT Metadata FROM FlexiPage WHERE Id = '${page.Id}'`
        });
        const fqStatus = fqRes?.records?.[0]?.Metadata?.publishStatus;
        if (fqStatus) {
          const normalized = fqStatus.charAt(0).toUpperCase() + fqStatus.slice(1).toLowerCase();
          page = { ...page, PublishStatus: normalized };
          // Also patch metaRes so the downstream rawStatus computation picks it up
          if (metaRes.Metadata) metaRes.Metadata.publishStatus = normalized;
          syncPageStatus(page.Id, normalized);
        }
      } catch (_) { /* non-fatal — fall through to Unknown */ }
    }

    if (!allProfiles.length && profileRes.records) allProfiles = profileRes.records;
    if (sObjectType && !recordTypeCache[sObjectType] && !rtRes.error && rtRes.records) {
      recordTypeCache[sObjectType] = rtRes.records;
    }
    const recordTypes = sObjectType ? (recordTypeCache[sObjectType] || []) : [];

    const body = document.getElementById('lpDetailBody');
    if (!body) return;

    if (metaRes.error) {
      const fe = sftkFriendlyError(metaRes.error);
      body.innerHTML = sftkCat(`Could not load page: ${esc(fe.message + (fe.hint ? ' — ' + fe.hint : ''))}`, true) +
        `<details style="margin:8px 0;font-size:10px;color:var(--subtext)">
           <summary style="cursor:pointer">Raw error (for copy/paste)</summary>
           <pre style="margin:4px 0;white-space:pre-wrap;word-break:break-all;max-height:150px;overflow:auto;">${esc(metaRes.error)}</pre>
         </details>`;
      return;
    }

    // Build the final assignment list used for rendering.
    // Two sources are merged:
    //   1. FlexiPage.Metadata.pageAssignments (App Default / Profile assignments from Tooling API)
    //   2. CustomObject.actionOverrides       (Org Default assignments — NOT in pageAssignments)
    //
    // If the caller already knows the correct state (e.g. right after a save), use that
    // directly to avoid waiting for the Tooling API to catch up.
    let assignments;
    if (assignmentsOverride !== null) {
      assignments = assignmentsOverride;
    } else {
      const apiAssignments = metaRes.Metadata?.pageAssignments || [];
      // For Record Pages, also check the sObject describe / ActionOverride / CustomObject
      // metadata to find any org-default assignment set via Lightning App Builder.
      const devName = metaRes.FullName || page.DeveloperName;
      // Use sobjectType from metadata (most authoritative) with fallback to EntityDefinitionId
      const coSObjectType = metaRes.Metadata?.sobjectType || sObjectType || null;
      // Only SKIP the describe endpoint when the page is explicitly Draft or Obsolete.
      // Unknown/null publishStatus (managed/system pages) still gets checked.
      // Use direct PublishStatus SOQL field as primary (more reliable than Metadata compound).
      const toolingStatus = (page.PublishStatus || metaRes.Metadata?.publishStatus || metaRes?.PublishStatus || '').toLowerCase();
      const coOrgDefaults = (coSObjectType && toolingStatus !== 'draft' && toolingStatus !== 'obsolete')
        ? await fetchCustomObjectOrgDefaults(coSObjectType, devName, page.Id)
        : [];
      // Merge: add CustomObject entries that aren't already in pageAssignments
      assignments = [...apiAssignments];
      for (const co of coOrgDefaults) {
        const alreadyPresent = apiAssignments.some(
          a => !a.profile && !a.app && (a.formFactor || 'Large') === co.formFactor
        );
        if (!alreadyPresent) assignments.push(co);
      }

      // Salesforce enforces: a page can only be an org default while it is Active.
      // If any strategy (describe or ActionOverride SOQL) confirmed org-default,
      // resolve the status to Active unconditionally — even if the Tooling API
      // returned a stale 'Draft' value due to caching lag.
      if (coOrgDefaults.length > 0) {
        page = { ...page, PublishStatus: 'Active' };
        syncPageStatus(page.Id, 'Active');
      }
    }

    // Explicit caller override always wins (used immediately after activation to avoid
    // waiting for the Tooling API to catch up to a Metadata Deploy).
    if (publishStatusOverride) {
      page = { ...page, PublishStatus: publishStatusOverride };
      if (metaRes.Metadata) metaRes.Metadata.publishStatus = publishStatusOverride;
    }

    renderDetail(page, metaRes, assignments, body, recordTypes);

    // Enable Clone button — data is now fully loaded
    const cloneBtn = document.getElementById('lpCloneBtn');
    if (cloneBtn) {
      cloneBtn.disabled = false;
      cloneBtn.addEventListener('click', () => openCloneDialog(page, metaRes, assignments));
    }

    // Surface org-default debug info in the UI — but ONLY when describe itself
    // failed or returned no View overrides.  If describe succeeded and found
    // overrides (just pointing to a different page), that is a successful
    // determination that THIS page is not the org default — no panel needed.
    if (_orgDefaultDebug && assignmentsOverride === null) {
      const debugData = _orgDefaultDebug;
      // Determine whether the failure is because ActionOverride simply isn't supported
      // in this org (Dev Edition, some sandboxes).  That's not a bug — suppress noise.
      const aoUnsupported = !_actionOverrideSupported
        || (debugData.aoError && /ActionOverride.*not supported|sObject type.*ActionOverride/i.test(debugData.aoError))
        || debugData.strategy1Skipped;

      if (!aoUnsupported) {
        console.warn('[SF Toolkit] fetchCustomObjectOrgDefaults: no match found', debugData);
      }
      const describeOk   = debugData.describeError === 'ok';
      const hasOverrides = Array.isArray(debugData.allViewOverrides) && debugData.allViewOverrides.length > 0;
      // Only show the panel when we genuinely could not determine org-default status
      // AND the failure isn't simply due to ActionOverride being unsupported.
      if (!aoUnsupported && (!describeOk || !hasOverrides)) {
        const freshBody = document.getElementById('lpDetailBody');
        if (freshBody) {
          const dbg = document.createElement('details');
          dbg.style.cssText = 'margin:8px 0;font-size:11px;border:1px solid #e07b39;border-radius:4px;padding:4px 8px;background:#fff8f4;color:#444;';
          const summary = document.createElement('summary');
          summary.style.cssText = 'cursor:pointer;font-weight:600;color:#c0392b;';
          summary.textContent = '⚠ Org-default detection failed — click for debug info';
          const pre = document.createElement('pre');
          pre.style.cssText = 'margin:6px 0 2px;font-size:10px;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;';
          pre.textContent = JSON.stringify(debugData, null, 2);
          dbg.appendChild(summary);
          dbg.appendChild(pre);
          freshBody.prepend(dbg);
        }
      }
    }

    // Inject error banner at top of body when called after a failed deploy
    if (errorMsg) {
      const freshBody = document.getElementById('lpDetailBody');
      if (freshBody) {
        const isAccessDenied = /INSUFFICIENT_ACCESS|cannot.*modify|managed.*component/i.test(errorMsg);
        const hint = isAccessDenied
          ? '<br><small style="opacity:0.8">💡 Use <strong>Setup → Lightning App Builder → Activation</strong> to manage assignments for this page.</small>'
          : '';
        // Module-specific access-denied explainer wins; everything else gets the
        // shared friendly translation (raw string kept in the title for copy/paste).
        let shownMsg = errorMsg;
        if (!isAccessDenied) {
          const fe = sftkFriendlyError(errorMsg);
          shownMsg = fe.message + (fe.hint ? ' — ' + fe.hint : '');
        }
        const errDiv = document.createElement('div');
        errDiv.className = 'error-banner';
        errDiv.style.marginBottom = '12px';
        errDiv.title = errorMsg;
        errDiv.innerHTML = `❌ ${esc(shownMsg)}${hint}`;
        freshBody.insertBefore(errDiv, freshBody.firstChild);
      }
    }
  }

  // ── C5c: embedded-flow extraction ─────────────────────────
  // Flow components (flowruntime:interview / the App Builder "Flow"
  // component) store the flow they launch as a componentInstanceProperty
  // named 'flowName'. Walk the whole Metadata tree — component instances can
  // nest inside flexiPageRegions → itemInstances → componentInstance.
  function extractEmbeddedFlowNames(meta) {
    const names = new Set();
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (Array.isArray(node.componentInstanceProperties)) {
        for (const p of node.componentInstanceProperties) {
          if (p && typeof p.value === 'string' && p.value &&
              /^flow(Api)?Name$/i.test(p.name || '')) {
            names.add(p.value);
          }
        }
      }
      for (const v of Object.values(node)) walk(v);
    })(meta);
    return [...names];
  }

  // ── Detail body ───────────────────────────────────────────
  function renderDetail(page, metaRes, assignments, bodyEl, recordTypes = []) {
    // Pages with ManageableState !== 'unmanaged' are standard or managed-package pages.
    // Salesforce's Metadata API rejects ANY modification to them — show a clear notice
    // instead of a form that will always fail.
    const canEdit  = !page.ManageableState || page.ManageableState === 'unmanaged';
    // Use direct PublishStatus SOQL field first — more reliable than compound Metadata
    // field which may return null for managed/system pages.
    // If both sources are null after all fallbacks (Tooling GET + Tooling SOQL), show
    // 'Unknown' rather than guessing 'Draft' — we could otherwise mask Active pages
    // in Dev Edition orgs where the Metadata API responses are non-standard.
    const rawStatus   = page.PublishStatus || metaRes.Metadata?.publishStatus || metaRes?.PublishStatus || null;
    const normStatus  = rawStatus ? rawStatus.toLowerCase() : null; // null = unknown
    const isActive    = normStatus === 'active';
    const statusKnown = normStatus !== null;

    // Profiles already assigned (profile-specific only; org-default has no profile name)
    const assignedProfileNames = new Set(
      assignments.filter(a => a.profile).map(a => a.profile.toLowerCase())
    );
    const available = allProfiles.filter(p =>
      !assignedProfileNames.has(p.Name.toLowerCase())
    );

    // ── Activation status bar ─────────────────────────────
    let html = '<div class="lp-status-bar">';
    if (!statusKnown) {
      html += '<span class="lp-status-dot lp-dot-unknown" title="Status could not be determined"></span>';
      html += '<span class="lp-status-text lp-status-unknown">Unknown</span>';
      // For unmanaged pages where status couldn't be determined, still show Activate
      // so the user isn't blocked — they may need to activate a page we can't read.
      if (canEdit) {
        html += '<button class="btn btn-sm btn-primary" id="lpActivateBtn">▶ Activate</button>';
      }
    } else {
      const statusLabel = normStatus === 'active' ? 'Active'
                        : normStatus === 'obsolete' ? 'Obsolete' : 'Draft';
      const dotCls = normStatus === 'active' ? 'lp-dot-active'
                   : normStatus === 'obsolete' ? 'lp-dot-obsolete' : 'lp-dot-draft';
      html += '<span class="lp-status-dot ' + dotCls + '" title="' + statusLabel + '"></span>';
      html += '<span class="lp-status-text">' + statusLabel + '</span>';
      if (canEdit && normStatus !== 'obsolete') {
        const btnCls = isActive ? 'btn-secondary' : 'btn-primary';
        const btnTxt = isActive ? '⏸ Deactivate' : '▶ Activate';
        html += '<button class="btn btn-sm ' + btnCls + '" id="lpActivateBtn">' + btnTxt + '</button>';
      }
    }
    html += '</div>';

    // ── C5c: embedded-flow cross-links ────────────────────
    // The page's Metadata already names the flow(s) it launches — surface
    // them with jumps to the Flows tab (version management) and Flow Access
    // (who can run it). No prefill — those tabs have no handoff state.
    const embeddedFlows = extractEmbeddedFlowNames(metaRes.Metadata);
    if (embeddedFlows.length > 0) {
      html += '<div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin:2px 0 6px;font-size:11px">';
      html += '<span style="color:var(--subtext)">⚡ Embedded flow' + (embeddedFlows.length !== 1 ? 's' : '') + ':</span>';
      for (const fn of embeddedFlows) {
        html += '<span class="lp-rt-tag" title="Flow API name">' + esc(fn) + '</span>';
      }
      html += xlinkHtml('flows', '↗ Flows',
        'Open the Flows tab to manage versions of this flow');
      html += xlinkHtml('flow-access', '↗ Flow Access',
        'Open Flow Access to control which users and profiles can run this flow');
      html += '</div>';
    }

    // ── Current Assignments section ──────────────────────
    html += '<div class="lp-section-hdr">';
    html += '<span>Profile Assignments</span>';
    html += '<span class="lp-badge">' + assignments.length + '</span>';
    html += '</div>';

    if (assignments.length === 0) {
      const emptyMsg = !statusKnown
        ? '⚠️ Could not determine assignments — status unknown for this page type.'
        : isActive
          ? 'No profile assignments — all users see the org-default page.'
          : 'No profile assignments — this page is inactive and not shown to any users.';
      html += '<div class="lp-empty-sm">' + emptyMsg + '</div>';
    } else {
      for (let i = 0; i < assignments.length; i++) {
        const a          = assignments[i];
        const isOrgDef   = !a.profile;
        const profileLabel = isOrgDef ? 'Org Default' : esc(a.profile);
        const icon         = isOrgDef ? '🌐' : '👤';
        const pRec = isOrgDef ? null : allProfiles.find(p =>
          p.Name.toLowerCase() === (a.profile || '').toLowerCase()
        );
        const defTag = a.default
          ? '<span class="lp-def-tag">Default</span>' : '';
        const rtTag  = a.recordType
          ? '<span class="lp-rt-tag">RT: ' + esc(a.recordType) + '</span>' : '';
        const appTag = a.app
          ? '<span class="lp-rt-tag">App: ' + esc(a.app) + '</span>' : '';
        const ffLabel = a.formFactor === 'Large' ? '🖥 Desktop'
                      : a.formFactor === 'Small'  ? '📱 Mobile' : '';
        const ffTag   = ffLabel
          ? '<span class="lp-rt-tag">' + ffLabel + '</span>' : '';

        html += '<div class="lp-asgn-row" id="lpAsgn' + i + '">';
        html += '<div class="lp-asgn-info">';
        html += '<div class="lp-asgn-profile">';
        html += '<span class="lp-profile-icon">' + icon + '</span>';
        html += '<strong>' + profileLabel + '</strong>';
        html += defTag + ffTag + appTag + rtTag;
        html += '</div>';
        html += '<div class="lp-asgn-users" id="lpUsers' + i + '">';
        if (isOrgDef) {
          html += '<span class="lp-users-na">Applies to all users in the org</span>';
        } else if (pRec) {
          html += '<button class="lp-users-btn" data-pid="' + esc(pRec.Id) + '" data-slot="' + i + '" data-name="' + esc(a.profile) + '">👥 Show affected users</button>';
        } else {
          html += '<span class="lp-users-na">Profile not found in org</span>';
        }
        html += '</div></div>';
        if (canEdit) {
          html += '<button class="lp-rm-btn" data-idx="' + i + '" title="Remove this assignment">✕</button>';
        }
        html += '</div>';
      }
    }

    // ── Add Profile / Activation section ──────────────────
    html += '<div class="lp-section-hdr" style="margin-top:16px"><span>Add Assignment</span></div>';

    if (!canEdit) {
      html += '<div class="lp-managed-notice">';
      html += '🔒 This is a <strong>standard or managed</strong> Lightning page. ';
      html += 'Salesforce does not allow modifying it via the Metadata API.<br>';
      html += 'Use <strong>Setup → Lightning App Builder → Activation</strong> to manage assignments.';
      html += '</div>';
    } else {
      // ── 3-tab assignment form matching Lightning App Builder ──
      // Inform the user that adding assignments to a Draft page will also activate it
      let addHtml = '';
      if (statusKnown && !isActive) {
        addHtml += '<div class="lp-draft-hint">ℹ️ Adding any assignment will also <strong>activate</strong> this page — matching how Lightning App Builder works.</div>';
      }
      addHtml += '<div class="lp-assign-tabs">';
      addHtml += '<button class="lp-atab lp-atab-active" data-tab="orgdefault">🌐 Org Default</button>';
      addHtml += '<button class="lp-atab" data-tab="appdefault">⚡ App Default</button>';
      addHtml += '<button class="lp-atab" data-tab="artp">📋 App, Record Type &amp; Profile</button>';
      addHtml += '</div>';

      // ─ Tab 1: Org Default ─
      // Determine which form factors are ALREADY assigned as org default for this page
      const alreadyDesktop = assignments.some(a => !a.profile && !a.app && (a.formFactor || 'Large') === 'Large');
      const alreadyMobile  = assignments.some(a => !a.profile && !a.app && a.formFactor === 'Small');
      const dskAlready = alreadyDesktop ? ' <strong class="lp-already">already</strong>' : '';
      const mobAlready = alreadyMobile  ? ' <strong class="lp-already">already</strong>' : '';
      addHtml += '<div class="lp-atab-pane lp-atab-pane-active" id="lpTabOrgDefault">';
      addHtml += '<p class="lp-tab-desc">Displays for all users in the org unless a more specific assignment overrides it.</p>';
      addHtml += '<div class="lp-ff-group" style="margin-bottom:10px">';
      addHtml += `<label class="lp-ff-lbl"><input type="checkbox" id="lpOrgDefDesktop"${alreadyDesktop ? ' checked disabled' : ' checked'}> 🖥 Desktop${dskAlready}</label>`;
      addHtml += `<label class="lp-ff-lbl"><input type="checkbox" id="lpOrgDefMobile"${alreadyMobile  ? ' checked disabled' : ''}> 📱 Mobile${mobAlready}</label>`;
      addHtml += '</div>';
      addHtml += '<div class="lp-add-action">';
      addHtml += '<button class="btn btn-primary btn-sm" id="lpAddBtnOrgDef">Set as Org Default</button>';
      addHtml += '<span id="lpAddErrOrgDef" class="lp-add-err" style="display:none"></span>';
      addHtml += '</div></div>';

      // ─ Tab 2: App Default ─
      addHtml += '<div class="lp-atab-pane" id="lpTabAppDefault" style="display:none">';
      addHtml += '<p class="lp-tab-desc">Overrides the org default for users within the selected app(s). Choose form factor per app.</p>';
      if (allApps.length === 0) {
        addHtml += '<div class="lp-empty-hint">No Lightning apps found in this org.</div>';
      } else {
        addHtml += '<div class="lp-multi-list" id="lpAppDefList">';
        for (const a of allApps) {
          const devName = esc(a.DeveloperName);
          const label   = esc(a.MasterLabel);
          addHtml += `<div class="lp-app-item">`;
          addHtml += `<label class="lp-app-item-lbl"><input type="checkbox" class="lp-appdef-cb" value="${devName}"> ${label}</label>`;
          addHtml += `<select class="lp-app-ff-sel" data-app="${devName}" disabled>`;
          addHtml += `<option value="Large">🖥 Desktop</option>`;
          addHtml += `<option value="Small">📱 Mobile</option>`;
          addHtml += `</select></div>`;
        }
        addHtml += '</div>';
      }
      addHtml += '<div class="lp-add-action">';
      addHtml += '<button class="btn btn-primary btn-sm" id="lpAddBtnAppDef" disabled>⚡ Assign App Default</button>';
      addHtml += '<span id="lpAddErrAppDef" class="lp-add-err" style="display:none"></span>';
      addHtml += '</div></div>';

      // ─ Tab 3: App + Record Type + Profile ─
      addHtml += '<div class="lp-atab-pane" id="lpTabARTP" style="display:none">';
      addHtml += '<p class="lp-tab-desc">Most specific level. Overrides org and app defaults. Creates one assignment per combination selected.</p>';
      addHtml += '<div class="lp-artp-grid">';

      // Apps column (with per-app FF dropdown)
      addHtml += '<div class="lp-artp-col">';
      addHtml += '<div class="lp-artp-col-hdr">Apps</div>';
      addHtml += '<div class="lp-multi-list" id="lpARTPAppList">';
      addHtml += '<div class="lp-app-item">';
      addHtml += '<label class="lp-app-item-lbl"><input type="checkbox" class="lp-artp-app-cb" value=""> All Apps</label>';
      addHtml += '<select class="lp-app-ff-sel" data-app="" disabled><option value="Large">🖥 Desktop</option><option value="Small">📱 Mobile</option></select>';
      addHtml += '</div>';
      for (const a of allApps) {
        const devName = esc(a.DeveloperName);
        const label   = esc(a.MasterLabel);
        addHtml += `<div class="lp-app-item">`;
        addHtml += `<label class="lp-app-item-lbl"><input type="checkbox" class="lp-artp-app-cb" value="${devName}"> ${label}</label>`;
        addHtml += `<select class="lp-app-ff-sel" data-app="${devName}" disabled>`;
        addHtml += `<option value="Large">🖥 Desktop</option>`;
        addHtml += `<option value="Small">📱 Mobile</option>`;
        addHtml += `</select></div>`;
      }
      addHtml += '</div></div>';

      // Record Types column (only if applicable)
      if (recordTypes.length > 0) {
        addHtml += '<div class="lp-artp-col">';
        addHtml += '<div class="lp-artp-col-hdr">Record Types</div>';
        addHtml += '<div class="lp-multi-list" id="lpARTPRTList">';
        addHtml += '<div class="lp-multi-item"><label><input type="checkbox" class="lp-artp-rt-cb" value=""> All Record Types</label></div>';
        for (const rt of recordTypes) {
          addHtml += `<div class="lp-multi-item"><label><input type="checkbox" class="lp-artp-rt-cb" value="${esc(rt.DeveloperName)}"> ${esc(rt.Name)}</label></div>`;
        }
        addHtml += '</div></div>';
      }

      // Profiles column
      addHtml += '<div class="lp-artp-col">';
      addHtml += '<div class="lp-artp-col-hdr">Profiles</div>';
      addHtml += '<div class="lp-multi-list" id="lpARTPProfileList">';
      for (const p of available) {
        addHtml += `<div class="lp-multi-item"><label><input type="checkbox" class="lp-artp-profile-cb" value="${esc(p.Name)}"> ${esc(p.Name)}</label></div>`;
      }
      addHtml += '</div></div>';

      addHtml += '</div>'; // close lp-artp-grid
      addHtml += '<label class="lp-def-lbl" style="margin-top:8px;display:inline-flex"><input type="checkbox" id="lpARTPDefault" checked style="margin-right:5px"> Mark as Default</label>';
      addHtml += '<div class="lp-add-action">';
      addHtml += '<button class="btn btn-primary btn-sm" id="lpAddBtnARTP" disabled>+ Add Assignments</button>';
      addHtml += '<span id="lpAddErrARTP" class="lp-add-err" style="display:none"></span>';
      addHtml += '</div></div>';

      html += addHtml;
    }

    bodyEl.innerHTML = html;

    // ── Wire: activate / deactivate ──────────────────────
    const activateBtn = document.getElementById('lpActivateBtn');
    if (activateBtn) {
      activateBtn.addEventListener('click', () =>
        doActivate(page, metaRes, assignments, !isActive)
      );
    }

    // ── Wire: remove buttons ─────────────────────────────
    bodyEl.querySelectorAll('.lp-rm-btn').forEach(btn => {
      btn.addEventListener('click', () =>
        confirmRemove(page, metaRes, assignments, parseInt(btn.dataset.idx))
      );
    });

    // ── Wire: show-users buttons ─────────────────────────
    bodyEl.querySelectorAll('.lp-users-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { pid, slot, name } = btn.dataset;
        const slotEl = document.getElementById(`lpUsers${slot}`);
        if (slotEl) slotEl.innerHTML = sftkCatSm('Loading users…');
        const users = await fetchUsers(pid);
        renderUserBadges(slot, users, name);
      });
    });

    // ── Wire: assignment tab switching ────────────────────
    // NOTE: use explicit 'block'/'none' via inline style — NOT style.display = ''
    // because the base class .lp-atab-pane has display:none in CSS, so clearing
    // the inline style would just re-hide the pane instead of showing it.
    bodyEl.querySelectorAll('.lp-atab').forEach(tab => {
      tab.addEventListener('click', () => {
        bodyEl.querySelectorAll('.lp-atab').forEach(t => t.classList.remove('lp-atab-active'));
        bodyEl.querySelectorAll('.lp-atab-pane').forEach(p => { p.style.display = 'none'; });
        tab.classList.add('lp-atab-active');
        const paneMap = { orgdefault: 'lpTabOrgDefault', appdefault: 'lpTabAppDefault', artp: 'lpTabARTP' };
        const pane = document.getElementById(paneMap[tab.dataset.tab]);
        if (pane) pane.style.display = 'block';  // explicit — not '' (CSS class hides it)
      });
    });

    // ── Wire: App Default tab — checkbox enables FF select ─
    function updateAppDefBtn() {
      const checked = bodyEl.querySelectorAll('#lpAppDefList .lp-appdef-cb:checked');
      const btn = document.getElementById('lpAddBtnAppDef');
      if (!btn) return;
      btn.disabled = checked.length === 0;
      btn.textContent = checked.length === 0
        ? '⚡ Assign App Default'
        : `⚡ Assign ${checked.length} App Default${checked.length !== 1 ? 's' : ''}`;
    }
    bodyEl.querySelectorAll('.lp-appdef-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const row = cb.closest('.lp-app-item');
        const sel = row?.querySelector('.lp-app-ff-sel');
        if (sel) sel.disabled = !cb.checked;
        updateAppDefBtn();
      });
    });
    document.getElementById('lpAddBtnAppDef')?.addEventListener('click', () =>
      doAdd(page, metaRes, assignments, 'appdefault')
    );

    // ── Wire: Org Default tab button ──────────────────────
    document.getElementById('lpAddBtnOrgDef')?.addEventListener('click', () =>
      doAdd(page, metaRes, assignments, 'orgdefault')
    );

    // ── Wire: ARTP tab — selection count → button label ───
    function updateARTPBtn() {
      const appCount     = bodyEl.querySelectorAll('#lpARTPAppList .lp-artp-app-cb:checked').length;
      const profileCount = bodyEl.querySelectorAll('#lpARTPProfileList .lp-artp-profile-cb:checked').length;
      const rtCount      = recordTypes.length > 0
        ? bodyEl.querySelectorAll('#lpARTPRTList .lp-artp-rt-cb:checked').length
        : 1; // no RT column = multiply by 1
      const btn = document.getElementById('lpAddBtnARTP');
      if (!btn) return;
      const total = appCount * profileCount * (rtCount || 1);
      btn.disabled = appCount === 0 || profileCount === 0 || (recordTypes.length > 0 && rtCount === 0);
      btn.textContent = (appCount === 0 || profileCount === 0)
        ? '+ Add Assignments'
        : `+ Add ${total} Assignment${total !== 1 ? 's' : ''}`;
    }
    bodyEl.querySelectorAll('.lp-artp-app-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const row = cb.closest('.lp-app-item');
        const sel = row?.querySelector('.lp-app-ff-sel');
        if (sel) sel.disabled = !cb.checked;
        updateARTPBtn();
      });
    });
    bodyEl.querySelectorAll('.lp-artp-rt-cb, .lp-artp-profile-cb').forEach(cb =>
      cb.addEventListener('change', updateARTPBtn)
    );
    document.getElementById('lpAddBtnARTP')?.addEventListener('click', () =>
      doAdd(page, metaRes, assignments, 'artp')
    );
  }

  // ── Render user chips for an assignment row ───────────────
  function renderUserBadges(slot, users, profileName) {
    const el = document.getElementById(`lpUsers${slot}`);
    if (!el) return;

    if (users.length === 0) {
      el.innerHTML = `<span class="lp-users-na">No active users on this profile</span>`;
      return;
    }

    const chips = users.slice(0, 4)
      .map(u => `<span class="lp-user-chip">${esc(u.Name)}</span>`).join('');
    const moreCount = users.length - 4;
    const moreBtn   = moreCount > 0
      ? `<button class="lp-chip-more-btn">+${moreCount} more</button>` : '';
    // C5c: these chips name concrete users — one click to Copy Permissions
    // when the fix is "give this user the same access as that one".
    const copyLink = xlinkHtml('copy-perms', '↗ Copy Permissions',
      'Open Copy Permissions to copy permission sets and profiles between these users');

    el.innerHTML = `<div class="lp-chip-row">${chips}${moreBtn}${copyLink}</div>`;

    if (moreCount > 0) {
      el.querySelector('.lp-chip-more-btn').addEventListener('click', () =>
        showUsersModal(users, profileName)
      );
    }
  }

  // ── Modal: full user list ─────────────────────────────────
  function showUsersModal(users, profileName) {
    if (typeof showModal !== 'function') return;

    const rows = users.map(u => `
      <div class="lp-modal-row">
        <span class="lp-modal-name">${esc(u.Name)}</span>
        <span class="lp-modal-uname">${esc(u.Username)}</span>
      </div>`).join('');

    showModal(`
      <div class="modal-header" style="color:var(--draft-color)">
        <span class="modal-icon">👥</span>
        <h2>${esc(profileName)}</h2>
      </div>
      <div class="modal-body">
        <p style="margin-bottom:8px;font-size:11px;color:var(--subtext)">
          ${users.length} active user${users.length !== 1 ? 's' : ''} assigned to this profile:
        </p>
        <div class="lp-modal-list">${rows}</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="lpUsersCopyPerms"
          title="Open Copy Permissions to copy permission sets and profiles between these users">👥 Copy Permissions</button>
        <button class="btn btn-secondary" id="modalCancel">Close</button>
      </div>
    `);
    document.getElementById('modalCancel').addEventListener('click', () => {
      if (typeof closeModal === 'function') closeModal();
    });
    // C5c: the modal renders outside _container, so the delegated cross-link
    // listener never sees this click — wire it directly. Close first so the
    // overlay isn't left covering the Copy Permissions tab.
    document.getElementById('lpUsersCopyPerms')?.addEventListener('click', () => {
      if (typeof closeModal === 'function') closeModal();
      jumpToTab('copy-perms');
    });
  }

  // ── Add assignment — 3 modes ─────────────────────────────
  // mode: 'orgdefault' | 'appdefault' | 'artp'
  //
  // Lightning page assignments are NOT stored in FlexiPage metadata.
  // They live in two places:
  //   • Org Default / Profile-only  → Tooling API ActionOverride sObject
  //   • App Default / App+Profile   → Tooling API CustomApplication.profileActionOverrides
  async function doAdd(page, metaRes, currentAssignments, mode) {
    // N3: any write invalidates the cached org-wide assignment scan, otherwise
    // "Who sees what?" would keep showing pre-change user counts.
    _wswScan = null;
    const sobjectType = metaRes.Metadata?.sobjectType || page.EntityDefinitionId || null;
    const devName     = metaRes.FullName;
    const isActive    = (page.PublishStatus || metaRes.Metadata?.publishStatus || '').toLowerCase() === 'active';

    const btnId = mode === 'orgdefault' ? 'lpAddBtnOrgDef'
                : mode === 'appdefault' ? 'lpAddBtnAppDef'
                : 'lpAddBtnARTP';
    const errId = mode === 'orgdefault' ? 'lpAddErrOrgDef'
                : mode === 'appdefault' ? 'lpAddErrAppDef'
                : 'lpAddErrARTP';
    const origLabel = mode === 'orgdefault' ? 'Set as Org Default'
                    : mode === 'appdefault' ? '⚡ Assign App Default'
                    : '+ Add Assignments';

    const addBtn = document.getElementById(btnId);
    const errEl  = document.getElementById(errId);
    if (errEl) errEl.style.display = 'none';
    if (addBtn) { addBtn.disabled = true; addBtn.textContent = '⏳ Saving…'; }

    // Progress counter in the tab pane — doAdd can run many sequential Metadata
    // Deploys (ARTP mode is apps × profiles × record types), each several seconds.
    let progEl = null;
    if (addBtn) {
      progEl = document.createElement('div');
      progEl.className = 'lp-add-progress';
      addBtn.insertAdjacentElement('afterend', progEl);
    }
    const showDeployProgress = (done, total) => {
      if (progEl) progEl.innerHTML = sftkCatSm(`Deploying ${done}/${total}…`);
    };

    try {
      // For orgdefault mode: DO NOT pre-activate separately.
      // The saveActionOverride call IS the activation — deploying CustomObject.actionOverrides
      // with type='Flexipage' is both the activation and the org-default assignment in one step.
      // Pre-activating would deploy the exact same CustomObject twice (wasteful, and the second
      // deploy can race with the first).
      //
      // For appdefault / artp: still pre-activate for Draft pages so the page becomes visible
      // before we add the more-specific app/profile assignment.
      if (!isActive && sobjectType && mode !== 'orgdefault') await activatePage(page, metaRes);

      if (mode === 'orgdefault') {
        if (!sobjectType) throw new Error('Org Default can only be set for Record Pages (pages with an associated object).');
        const desktop = document.getElementById('lpOrgDefDesktop')?.checked !== false;
        const mobile  = document.getElementById('lpOrgDefMobile')?.checked  === true;
        const ffs = [];
        if (desktop || (!desktop && !mobile)) ffs.push('Large');
        if (mobile) ffs.push('Small');
        if (ffs.length === 0) throw new Error('Select at least one form factor.');
        for (let fi = 0; fi < ffs.length; fi++) {
          showDeployProgress(fi + 1, ffs.length);
          await saveActionOverride(sobjectType, devName, ffs[fi], null);
        }
        // After saving, synthesize the assignments so the UI is immediately correct
        // (the Tooling API pageAssignments field lags behind Metadata Deploy by seconds).
        const synthAssignments = [
          ...currentAssignments.filter(a => a.profile || a.app),  // keep non-org-default entries
          ...ffs.map(ff => ({ formFactor: ff, default: true }))    // add freshly-set org-defaults
        ];
        await openDetail(page, null, 'Active', synthAssignments);
        syncPageStatus(page.Id, 'Active');
        return;
      }

      if (mode === 'appdefault') {
        const checked = [...document.querySelectorAll('#lpAppDefList .lp-appdef-cb:checked')];
        if (checked.length === 0) throw new Error('No apps selected.');
        // Sequential to avoid PATCH conflicts on the same CustomApplication
        for (let ci = 0; ci < checked.length; ci++) {
          const cb  = checked[ci];
          showDeployProgress(ci + 1, checked.length);
          const row = cb.closest('.lp-app-item');
          const ff  = row?.querySelector('.lp-app-ff-sel')?.value || 'Large';
          await saveAppAssignment(cb.value, devName, ff, sobjectType, null, null);
        }
      }

      if (mode === 'artp') {
        const appPairs = [];
        document.querySelectorAll('#lpARTPAppList .lp-artp-app-cb:checked').forEach(cb => {
          const row = cb.closest('.lp-app-item');
          const ff  = row?.querySelector('.lp-app-ff-sel')?.value || 'Large';
          appPairs.push({ app: cb.value || null, ff });
        });

        const profiles = [];
        document.querySelectorAll('#lpARTPProfileList .lp-artp-profile-cb:checked').forEach(cb =>
          profiles.push(cb.value)
        );

        const rts = [];
        const rtCbs = document.querySelectorAll('#lpARTPRTList .lp-artp-rt-cb:checked');
        if (rtCbs.length > 0) {
          rtCbs.forEach(cb => rts.push(cb.value || null)); // empty value = "All"
        } else {
          rts.push(null);
        }

        if (appPairs.length === 0 || profiles.length === 0) {
          throw new Error('Select at least one app and one profile.');
        }

        // Sequential writes — multiple requests to the same CustomApplication must not race
        const totalDeploys = appPairs.length * profiles.length * rts.length;
        let deploysDone = 0;
        for (const pair of appPairs) {
          for (const profile of profiles) {
            for (const rt of rts) {
              showDeployProgress(++deploysDone, totalDeploys);
              if (pair.app) {
                // Specific app → CustomApplication.profileActionOverrides
                await saveAppAssignment(pair.app, devName, pair.ff, sobjectType, profile, rt || null);
              } else {
                // "All Apps" selected → profile-level ActionOverride (no app context)
                const prof = allProfiles.find(p =>
                  p.Name.toLowerCase() === profile.toLowerCase()
                );
                if (!prof) throw new Error(`Profile "${profile}" not found.`);
                await saveActionOverride(sobjectType, devName, pair.ff, prof.Id);
              }
            }
          }
        }
      }

      // appdefault / artp: reload detail with publishStatus override if we just activated
      if (!isActive && sobjectType) syncPageStatus(page.Id, 'Active');
      await openDetail(page, null, !isActive && sobjectType ? 'Active' : null);
    } catch (e) {
      if (progEl) progEl.remove();
      if (addBtn) { addBtn.disabled = false; addBtn.textContent = origLabel; }
      if (errEl) {
        const isAccessDenied = /INSUFFICIENT_ACCESS|cannot.*modify|managed.*component/i.test(e.message);
        const hint = isAccessDenied
          ? '<br><span class="lp-err-hint">💡 This is a managed or standard page. ' +
            'Use <strong>Setup → Lightning App Builder → Activation</strong> instead.</span>'
          : '';
        // Module-specific access-denied explainer wins; everything else gets the
        // shared friendly translation (raw string kept in the title for copy/paste).
        let shownMsg = e.message;
        if (!isAccessDenied) {
          const fe = sftkFriendlyError(e.message);
          shownMsg = fe.message + (fe.hint ? ' — ' + fe.hint : '');
        }
        errEl.title = e.message;
        errEl.innerHTML = `❌ ${esc(shownMsg)}${hint}`;
        errEl.style.display = '';
      }
    }
  }

  // ── Remove profile assignment (Metadata Deploy) ───────────
  function confirmRemove(page, metaRes, assignments, idx) {
    if (typeof showModal !== 'function') return;
    const a          = assignments[idx];
    const isOrgDef   = !a.profile;
    const label      = isOrgDef ? 'Org Default' : a.profile;
    const pRec       = isOrgDef ? null : allProfiles.find(p =>
      p.Name.toLowerCase() === (a.profile || '').toLowerCase()
    );
    const cached     = pRec ? profileUserCache[pRec.Id] : null;
    const impactNote = isOrgDef
      ? 'All users will fall back to the Salesforce default page for this object.'
      : cached
        ? `👥 <strong>${cached.length}</strong> user${cached.length !== 1 ? 's' : ''} on this profile will fall back to the org-default page.`
        : 'Users on this profile will fall back to the org-default page.';

    showModal(`
      <div class="modal-header modal-warn">
        <span class="modal-icon">⚠️</span>
        <h2>Remove Assignment?</h2>
      </div>
      <div class="modal-body">
        <p>Remove <strong>${esc(label)}</strong> from
           <strong>${esc(page.MasterLabel)}</strong>?</p>
        <p style="margin-top:8px;font-size:11px;color:var(--subtext)">${impactNote}</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="modalCancel">Cancel</button>
        <button class="btn btn-danger"    id="modalConfirm">Remove</button>
      </div>
    `);
    document.getElementById('modalCancel').addEventListener('click', () => {
      if (typeof closeModal === 'function') closeModal();
    });
    document.getElementById('modalConfirm').addEventListener('click', async () => {
      if (typeof closeModal === 'function') closeModal();
      await doRemove(page, metaRes, assignments, idx);
    });
  }

  async function doRemove(page, metaRes, assignments, idx) {
    // N3: see doAdd — drop the cached scan so user counts are recomputed.
    _wswScan = null;
    const bodyEl = document.getElementById('lpDetailBody');
    if (bodyEl) bodyEl.innerHTML = sftkCat('Removing assignment…');

    const a           = assignments[idx];
    const sobjectType = metaRes.Metadata?.sobjectType || page.EntityDefinitionId || null;
    const devName     = metaRes.FullName;

    try {
      if (a.app) {
        // App-based assignment → remove from CustomApplication.profileActionOverrides
        await deleteAppAssignment(
          a.app, devName,
          a.formFactor || 'Large', sobjectType,
          a.profile    || null,
          a.recordType || null
        );
      } else {
        // Org-level (or profile-only) assignment → deploy type=Default to reset the override
        await deleteActionOverride(sobjectType, devName, a.formFactor || 'Large', a.profile || null);
      }
      // Show the expected post-removal state immediately.
      // The Salesforce API (Tooling publishStatus + describe actionOverrides) can take
      // several seconds to reflect a Metadata Deploy, so we synthesise the correct UI
      // state rather than re-fetching stale data.
      const remaining = assignments.filter((_, i) => i !== idx);
      const stillHasOrgDefault = remaining.some(r => !r.profile && !r.app);
      const newStatus = stillHasOrgDefault ? 'Active' : 'Draft';
      await openDetail(page, null, newStatus, remaining);
      syncPageStatus(page.Id, newStatus);
    } catch (e) {
      console.error('[SF Toolkit] doRemove failed:', e);
      await openDetail(page, e.message);
    }
  }

  // ── Clone page ────────────────────────────────────────────

  // Convert a human label to a valid Salesforce API name:
  // strip non-alphanumeric chars, replace spaces with underscores, ensure starts with letter.
  function labelToApiName(label) {
    return (label || '')
      .trim()
      .replace(/[^A-Za-z0-9 _]/g, '')   // strip anything that isn't a letter, digit, space, or _
      .replace(/\s+/g, '_')             // spaces → underscores
      .replace(/_{2,}/g, '_')           // collapse repeated underscores
      .replace(/^[^A-Za-z]+/, '')       // must start with a letter
      .substring(0, 80)                 // max 80 characters
      || 'New_Page';                    // final fallback
  }

  // Show a modal dialog letting the user configure the clone (label, API name, copy assignments).
  function openCloneDialog(page, metaRes, assignments) {
    if (typeof showModal !== 'function') return;

    const origLabel      = page.MasterLabel || page.DeveloperName || 'Page';
    const defaultLabel   = origLabel + ' Copy';
    const defaultApiName = labelToApiName(defaultLabel);

    // Build assignment preview list
    let assignHtml = '';
    if (assignments.length > 0) {
      const rows = assignments.map(a => {
        const who = !a.profile && !a.app
          ? '🌐 Org Default'
          : a.app
            ? `⚡ ${esc(a.app)}${a.profile ? ' · ' + esc(a.profile) : ''}`
            : `👤 ${esc(a.profile)}`;
        const ff = (a.formFactor || 'Large') === 'Small' ? '📱' : '🖥';
        return `<div class="lp-clone-asgn-row">${who} <span class="lp-rt-tag">${ff}</span></div>`;
      }).join('');
      assignHtml = `<div class="lp-clone-asgn-list">${rows}</div>`;
    } else {
      assignHtml = '<div class="lp-empty-hint" style="margin-top:4px">No assignments on original page.</div>';
    }

    showModal(`
      <div class="modal-header">
        <span class="modal-icon">📋</span>
        <h2>Clone Page</h2>
      </div>
      <div class="modal-body">
        <p style="margin-bottom:12px;font-size:11px;color:var(--subtext)">
          Creates a copy of <strong>${esc(origLabel)}</strong> with the same layout and components.
        </p>

        <label class="lp-clone-field-lbl">New Label</label>
        <input type="text" id="cloneLabel" class="lp-clone-input"
               value="${esc(defaultLabel)}" placeholder="Enter page label…" autocomplete="off">

        <label class="lp-clone-field-lbl" style="margin-top:10px">API Name</label>
        <input type="text" id="cloneApiName" class="lp-clone-input"
               value="${esc(defaultApiName)}" placeholder="New_Page_Name" autocomplete="off">
        <div class="lp-clone-hint">Letters, numbers, underscores only — must start with a letter.</div>

        <label class="lp-clone-field-lbl" style="margin-top:12px;display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="cloneCopyAssignments" ${assignments.length > 0 ? 'checked' : ''}>
          Copy assignments (${assignments.length})
        </label>
        <div id="cloneAssignPreview"${assignments.length === 0 ? ' style="display:none"' : ''}>${assignHtml}</div>

        <div id="cloneError" class="lp-add-err" style="display:none;margin-top:8px"></div>
        <div id="cloneStatus" style="margin-top:8px"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="modalCancel">Cancel</button>
        <button class="btn btn-primary"   id="cloneConfirmBtn">📋 Clone Page</button>
      </div>
    `);

    // Label → auto-update API name (until user manually edits the API name field)
    const labelInput   = document.getElementById('cloneLabel');
    const apiInput     = document.getElementById('cloneApiName');
    const copyAssignCb = document.getElementById('cloneCopyAssignments');
    const preview      = document.getElementById('cloneAssignPreview');
    let apiEdited = false;

    labelInput.addEventListener('input', () => {
      if (!apiEdited) apiInput.value = labelToApiName(labelInput.value);
    });
    apiInput.addEventListener('input', () => { apiEdited = true; });

    copyAssignCb.addEventListener('change', () => {
      preview.style.display = copyAssignCb.checked ? '' : 'none';
    });

    document.getElementById('modalCancel').addEventListener('click', () => {
      if (typeof closeModal === 'function') closeModal();
    });

    document.getElementById('cloneConfirmBtn').addEventListener('click', async () => {
      const label   = document.getElementById('cloneLabel').value.trim();
      const apiName = document.getElementById('cloneApiName').value.trim();
      const copyA   = document.getElementById('cloneCopyAssignments').checked;
      const errEl   = document.getElementById('cloneError');

      errEl.style.display = 'none';
      if (!label)   { errEl.textContent = 'Label is required.'; errEl.style.display = ''; return; }
      if (!apiName) { errEl.textContent = 'API Name is required.'; errEl.style.display = ''; return; }
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(apiName)) {
        errEl.textContent = 'API Name must start with a letter and contain only letters, numbers, and underscores.';
        errEl.style.display = '';
        return;
      }

      const btn      = document.getElementById('cloneConfirmBtn');
      const statusEl = document.getElementById('cloneStatus');
      btn.disabled    = true;
      btn.textContent = '⏳ Cloning…';
      if (statusEl) statusEl.innerHTML = sftkCatSm('Cloning page…');

      try {
        await doClone(page, metaRes, assignments, label, apiName, copyA);
        if (typeof closeModal === 'function') closeModal();
      } catch (e) {
        btn.disabled    = false;
        btn.textContent = '📋 Clone Page';
        if (statusEl) statusEl.innerHTML = '';
        // Translate common clone failures (name collision, invalid name);
        // sftkFriendlyError covers the rest. Raw error kept in title for copy/paste.
        const raw = e.message || String(e);
        let shownMsg;
        if (/DUPLICATE_DEVELOPER_NAME|duplicate.*developer.?name/i.test(raw)) {
          shownMsg = `A page with the API name "${apiName}" already exists — choose a different API name.`;
        } else if (/invalid.*(?:character|name)|INVALID_NAME/i.test(raw)) {
          shownMsg = 'The API name is not valid — use letters, numbers, and underscores, starting with a letter.';
        } else {
          const fe = sftkFriendlyError(raw);
          shownMsg = fe.message + (fe.hint ? ' — ' + fe.hint : '');
        }
        errEl.title = raw;
        errEl.textContent = '❌ ' + shownMsg;
        errEl.style.display = '';
      }
    });
  }

  // Deploy a cloned FlexiPage and optionally recreate all assignments on it.
  async function doClone(page, metaRes, assignments, newLabel, newApiName, copyAssignments) {
    // Step progress in the clone modal (#cloneStatus exists while the modal is open)
    const cloneStep = msg => {
      const el = document.getElementById('cloneStatus');
      if (el) el.innerHTML = sftkCatSm(msg);
    };

    // ── 1. Build the clone metadata ──────────────────────────
    // Deep-copy metadata, update masterLabel, strip read-only / assignment fields.
    const cloneMeta = JSON.parse(JSON.stringify(metaRes.Metadata || {}));
    cloneMeta.masterLabel = newLabel;
    delete cloneMeta.pageAssignments;  // not a writable XSD field; assignments are recreated below
    delete cloneMeta.publishStatus;    // computed by SF automatically from assignments

    // Create a fake metaRes-shape so buildFlexiPageZip uses the new developer name
    const cloneMetaRes = { FullName: newApiName, Metadata: cloneMeta };
    const zipBase64    = buildFlexiPageZip(cloneMetaRes);

    // ── 2. Deploy via Metadata Deploy ───────────────────────
    cloneStep('Deploying cloned page…');
    const deployRes = await bg({ type: 'SF_METADATA_DEPLOY', orgUrl: _orgUrl, sid: _sid, zipBase64 });
    if (deployRes.error) throw new Error('Deploy failed: ' + deployRes.error);

    // ── 3. Find the new page record ─────────────────────────
    cloneStep('Locating new page…');
    const findRes = await bg({
      type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true,
      query: `SELECT Id,DeveloperName,MasterLabel,Type,EntityDefinitionId,ManageableState ` +
             `FROM FlexiPage WHERE DeveloperName='${newApiName}'`
    });
    if (findRes.error) throw new Error('Could not locate cloned page: ' + findRes.error);
    const newPage = findRes.records?.[0];
    if (!newPage) throw new Error(`Cloned page "${newApiName}" not found after deploy — it may have been created under a different namespace.`);

    // Add to the in-memory list so it appears without a full reload
    allPages.push({ ...newPage, PublishStatus: 'Draft', _isOrgDefault: false });

    // ── 4. Recreate assignments ──────────────────────────────
    if (copyAssignments && assignments.length > 0) {
      cloneStep('Copying assignments…');
      const sobjectType = metaRes.Metadata?.sobjectType || page.EntityDefinitionId || null;
      const errors      = [];

      for (const a of assignments) {
        try {
          if (a.app) {
            // App-based assignment → CustomApplication.profileActionOverrides
            await saveAppAssignment(
              a.app, newApiName, a.formFactor || 'Large',
              sobjectType, a.profile || null, a.recordType || null
            );
          } else {
            // Org default (no profile) or profile-only assignment → ActionOverride
            let profileId = null;
            if (a.profile) {
              const profRec = allProfiles.find(p =>
                p.Name.toLowerCase() === (a.profile || '').toLowerCase()
              );
              if (!profRec) {
                errors.push(`Profile "${a.profile}" not found — skipped.`);
                continue;
              }
              profileId = profRec.Id;
            }
            await saveActionOverride(sobjectType, newApiName, a.formFactor || 'Large', profileId);
          }
        } catch (e) {
          const label = a.app
            ? `App "${a.app}"${a.profile ? ' / ' + a.profile : ''}`
            : a.profile ? `Profile "${a.profile}"` : 'Org Default';
          errors.push(`${label}: ${e.message}`);
        }
      }

      if (errors.length > 0) {
        // Partial success — open with a warning banner.
        // If at least one assignment was saved the page is now Active; otherwise Draft.
        const partialStatus = errors.length < assignments.length ? 'Active' : 'Draft';
        syncPageStatus(newPage.Id, partialStatus);
        await openDetail(newPage, 'Some assignments could not be copied:\n• ' + errors.join('\n• '), partialStatus);
        return;
      }
    }

    // ── 5. Open the new page's detail view ──────────────────
    // Pass the known publishStatus so openDetail never attempts a PublishStatus SOQL
    // query (which fails in orgs where the field isn't available on FlexiPage).
    const finalStatus = (copyAssignments && assignments.length > 0) ? 'Active' : 'Draft';
    syncPageStatus(newPage.Id, finalStatus);
    await openDetail(newPage, null, finalStatus);
  }

  // ── Activate / Deactivate ────────────────────────────────
  // Purely changes publishStatus. Org-default assignment is managed via the
  // "🌐 Org Default" tab in the Add Assignment form — no longer mixed into
  // this modal (which caused confusion when page was already active).
  function doActivate(page, metaRes, assignments, activate) {
    if (typeof showModal !== 'function') return;
    // N3: activation flips whether this page reaches anyone at all, so the
    // cached scan (which keys audiences off PublishStatus) must be rebuilt.
    _wswScan = null;

    if (!activate) {
      // Deactivate confirmation
      showModal(`
        <div class="modal-header modal-warn">
          <span class="modal-icon">⚠️</span>
          <h2>Deactivate Page?</h2>
        </div>
        <div class="modal-body">
          <p>Deactivating <strong>${esc(page.MasterLabel)}</strong> will set it back to Draft.
             Users will no longer see this page.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="modalCancel">Cancel</button>
          <button class="btn btn-danger"    id="modalConfirm">Deactivate</button>
        </div>
      `);
      document.getElementById('modalCancel').addEventListener('click', () => {
        if (typeof closeModal === 'function') closeModal();
      });
      document.getElementById('modalConfirm').addEventListener('click', async () => {
        if (typeof closeModal === 'function') closeModal();
        await runDeploy(page, metaRes, assignments, 'Draft');
      });
      return;
    }

    // Activate confirmation — org default is handled by the "🌐 Org Default" tab
    showModal(`
      <div class="modal-header">
        <span class="modal-icon">▶</span>
        <h2>Activate Page</h2>
      </div>
      <div class="modal-body">
        <p>Activate <strong>${esc(page.MasterLabel)}</strong>?</p>
        <p style="margin-top:10px;font-size:11px;color:var(--subtext);line-height:1.5">
          To assign this page as org default, use the
          <strong>🌐 Org Default</strong> tab in the assignment form after activating.
        </p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="modalCancel">Cancel</button>
        <button class="btn btn-primary"   id="modalConfirm">Activate</button>
      </div>
    `);
    document.getElementById('modalCancel').addEventListener('click', () => {
      if (typeof closeModal === 'function') closeModal();
    });
    document.getElementById('modalConfirm').addEventListener('click', async () => {
      if (typeof closeModal === 'function') closeModal();
      await runDeploy(page, metaRes, assignments, 'Active');
    });
  }

  // Activates or deactivates the page by updating publishStatus via Tooling API PATCH.
  // pageAssignments is intentionally excluded — it is NONCREATABLE/NONUPDATABLE on
  // FlexiPage (assignments live in ActionOverride / CustomApplication, not FlexiPage).
  async function runDeploy(page, metaRes, currentAssignments, publishStatus) {
    const bodyEl = document.getElementById('lpDetailBody');
    const label  = publishStatus === 'Active' ? 'Activating' : 'Deactivating';
    if (bodyEl) bodyEl.innerHTML = sftkCat(`${label} page…`);

    try {
      await activatePage(page, metaRes, publishStatus);
      // Pass publishStatus as an override — Salesforce's Tooling API publishStatus
      // field can lag a few seconds behind a Metadata Deploy, so we display the
      // known-correct state immediately instead of relying on the re-fetched value.
      await openDetail(page, null, publishStatus);
      syncPageStatus(page.Id, publishStatus);
    } catch (e) {
      await openDetail(page, e.message);
    }
  }

  // ── Silent activate/deactivate helper (no UI) ────────────────
  // Called by doAdd (Draft page gets first assignment) and runDeploy.
  // Only PATCHes publishStatus — leaves all other metadata untouched.
  async function activatePage(page, metaRes, publishStatus = 'Active') {
    // Salesforce computes publishStatus automatically from page assignments — it
    // cannot be written via any API (Tooling PATCH, Metadata Deploy, or sObject update
    // all fail with various "field not writable" or XSD errors).
    //
    // Instead we drive activation through assignments, exactly as Lightning App Builder does:
    //   Activate   → create / update the org-wide Desktop (Large) ActionOverride
    //   Deactivate → delete  the org-wide Desktop ActionOverride for this page
    //
    // For non-Record Pages (no sobjectType) the caller must use the assignment form.

    const sobjectType = metaRes?.Metadata?.sobjectType;
    const devName     = metaRes?.FullName || page.DeveloperName;

    if (!sobjectType) {
      throw new Error(
        publishStatus === 'Active'
          ? 'Quick Activate is only supported for Record Pages (pages linked to an sObject). ' +
            'Use the "Add Assignment" form below to assign this page.'
          : 'Quick Deactivate is only supported for Record Pages. ' +
            'Remove existing assignments using the ✕ buttons in the Assignments section.'
      );
    }

    if (publishStatus === 'Active') {
      // Creates or updates the org-wide Desktop default for this object type.
      // Salesforce will automatically flip publishStatus → Active once the record exists.
      await saveActionOverride(sobjectType, devName, 'Large', null);
    } else {
      // Removes the org-wide Desktop override that points to this page.
      // When no assignments remain, Salesforce flips publishStatus → Obsolete.
      await deleteActionOverride(sobjectType, devName, 'Large', null);
    }
  }

  // ── Fetch users for a profile (cached) ───────────────────
  async function fetchUsers(profileId) {
    if (profileUserCache[profileId]) return profileUserCache[profileId];

    const res = await bg({
      type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
      query: `SELECT Id,Name,Username FROM User ` +
             `WHERE ProfileId='${profileId}' AND IsActive=true ORDER BY Name`
    });

    const users = res.error ? [] : (res.records || []);
    profileUserCache[profileId] = users;
    return users;
  }

  // ── Assignment write/delete helpers ─────────────────────────
  //
  // Lightning page assignments are NOT stored in FlexiPage metadata.
  // • Org Default / Profile-only → Standard REST API  ActionOverride sObject
  //                                (NOT Tooling API — ActionOverride is a standard sObject)
  // • App Default / App+Profile  → Tooling API  CustomApplication.profileActionOverrides
  //
  // The pageAssignments array on a FlexiPage Tooling GET is aggregated read-only data.

  // Build and deploy a CustomObject metadata ZIP containing a single actionOverrides
  // entry.  Salesforce merges actionOverrides on deploy (keyed on actionName +
  // formFactor + profile), so we only need to include the entry we're changing.
  //
  // type = 'Flexipage'  → set the FlexiPage as the override
  // type = 'Default'    → reset to the standard Salesforce view (removes the override)
  async function deployCustomObjectActionOverride(sobjectType, devName, formFactor, profileName, type) {
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <actionOverrides>',
      '        <actionName>View</actionName>',
    ];
    // Include <content> only for Flexipage type (names the page to set).
    // Default type must NOT include content — it is the "reset to standard view" marker
    // and Salesforce ignores/corrupts the entry if content is present with type=Default.
    if (type === 'Flexipage' && devName) {
      lines.push(`        <content>${escXml(devName)}</content>`);
    }
    lines.push(`        <formFactor>${escXml(formFactor)}</formFactor>`);
    if (profileName) lines.push(`        <profile>${escXml(profileName)}</profile>`);
    lines.push(
      '        <skipRecordTypeSelect>false</skipRecordTypeSelect>',
      `        <type>${escXml(type)}</type>`,
      '    </actionOverrides>',
      '</CustomObject>'
    );

    const pkgLines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <types>',
      `        <members>${escXml(sobjectType)}</members>`,
      '        <name>CustomObject</name>',
      '    </types>',
      '    <version>62.0</version>',
      '</Package>',
    ];

    const enc = new TextEncoder();
    const zipBase64 = buildStoredZip([
      { name: 'package.xml',                          data: enc.encode(pkgLines.join('\n')) },
      { name: `objects/${sobjectType}.object`,         data: enc.encode(lines.join('\n'))   },
    ]);

    const r = await bg({ type: 'SF_METADATA_DEPLOY', orgUrl: _orgUrl, sid: _sid, zipBase64 });
    if (r.error) throw new Error(r.error);
  }

  // Set a FlexiPage as the View override for an sObject type.
  // profileId=null → org-wide default (all profiles).
  async function saveActionOverride(sobjectType, devName, formFactor, profileId) {
    if (!sobjectType) {
      throw new Error('Org Default can only be set for Record Pages (pages associated with an object).');
    }
    // Resolve profileId → name (the Metadata API uses names, not IDs).
    let profileName = null;
    if (profileId) {
      const profRes = await bg({
        type: 'SF_QUERY_ALL', tooling: false, orgUrl: _orgUrl, sid: _sid,
        query: `SELECT Name FROM Profile WHERE Id = '${profileId}'`
      });
      if (profRes.error) throw new Error(profRes.error);
      profileName = profRes.records?.[0]?.Name;
      if (!profileName) throw new Error(`Profile ${profileId} not found.`);
    }
    await deployCustomObjectActionOverride(sobjectType, devName, formFactor, profileName, 'Flexipage');
  }

  // Remove the FlexiPage View override for an sObject type by resetting it to Default.
  // devName is passed through so Salesforce can identify WHICH override to reset.
  async function deleteActionOverride(sobjectType, devName, formFactor, profileName) {
    if (!sobjectType) return;
    await deployCustomObjectActionOverride(sobjectType, devName, formFactor, profileName, 'Default');
  }

  // Add or replace a profileActionOverride entry on a CustomApplication.
  // Fetches the current Metadata compound, merges the new entry, and PATCHes back.
  async function saveAppAssignment(appDevName, devName, formFactor, sobjectType, profileName, recordTypeName) {
    const { appId, appMeta } = await getCustomApp(appDevName);

    // Build the new entry (only include optional fields when non-empty)
    const newEntry = { actionName: 'View', content: devName, formFactor, type: 'Flexipage' };
    if (sobjectType)    newEntry.pageOrSobjectType = sobjectType;
    if (profileName)    newEntry.profile            = profileName;
    if (recordTypeName) newEntry.recordType         = recordTypeName;

    // Merge: drop any existing entry that matches the same slot, add the new one
    const existing = (appMeta.Metadata.profileActionOverrides || []).filter(o => {
      if ((o.actionName || 'View') !== 'View') return true;  // unrelated action — keep
      const sameFF  = (o.formFactor         || 'Large') === (formFactor     || 'Large');
      const samePro = (o.profile            || '')       === (profileName    || '');
      const sameSob = (o.pageOrSobjectType  || '')       === (sobjectType    || '');
      const sameRT  = (o.recordType         || '')       === (recordTypeName || '');
      return !(sameFF && samePro && sameSob && sameRT);  // false = remove this conflict
    });

    await patchCustomApp(appId, appMeta, [...existing, newEntry]);
  }

  // Remove a profileActionOverride entry from a CustomApplication.
  async function deleteAppAssignment(appDevName, devName, formFactor, sobjectType, profileName, recordTypeName) {
    let appId, appMeta;
    try { ({ appId, appMeta } = await getCustomApp(appDevName)); }
    catch (e) {
      // If the app simply doesn't exist, there's nothing to delete — that's fine.
      // Re-throw anything else (network errors, permission errors, etc.).
      if (/not found|no.*record/i.test(e.message)) return;
      throw e;
    }

    const before = appMeta.Metadata.profileActionOverrides || [];
    const after  = before.filter(o => {
      if ((o.actionName || 'View') !== 'View') return true;
      if ((o.content || '').toLowerCase() !== devName.toLowerCase()) return true;
      const sameFF  = (o.formFactor         || 'Large') === (formFactor     || 'Large');
      const samePro = (o.profile            || '')       === (profileName    || '');
      const sameSob = (o.pageOrSobjectType  || '')       === (sobjectType    || '');
      const sameRT  = (o.recordType         || '')       === (recordTypeName || '');
      return !(sameFF && samePro && sameSob && sameRT);  // false = remove this entry
    });

    if (after.length === before.length) return;  // entry not found — nothing to do
    await patchCustomApp(appId, appMeta, after);
  }

  // ── CustomApplication Tooling API helpers ────────────────────

  // Fetch a CustomApplication by DeveloperName and return its Id + full metadata.
  async function getCustomApp(appDevName) {
    const qRes = await bg({
      type: 'SF_QUERY_ALL', tooling: true, orgUrl: _orgUrl, sid: _sid,
      query: `SELECT Id FROM CustomApplication WHERE DeveloperName='${appDevName}'`
    });
    if (qRes.error) throw new Error(qRes.error);
    if (!qRes.records?.length) throw new Error(`App "${appDevName}" not found in this org.`);
    const appId   = qRes.records[0].Id;
    const appMeta = await bg({
      type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid,
      sobject: 'CustomApplication', id: appId
    });
    if (appMeta.error) throw new Error(appMeta.error);
    if (!appMeta.Metadata) {
      throw new Error(
        `The Tooling API did not return Metadata for app "${appDevName}". ` +
        `Please use Setup → Lightning App Builder → Activation to manage app assignments.`
      );
    }
    return { appId, appMeta };
  }

  // PATCH a CustomApplication with an updated profileActionOverrides array.
  async function patchCustomApp(appId, appMeta, updatedOverrides) {
    const cleanMeta = prepareCustomAppMetadata({
      ...appMeta.Metadata,
      profileActionOverrides: updatedOverrides
    });
    const r = await bg({
      type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid,
      path: `services/data/v62.0/tooling/sobjects/CustomApplication/${appId}`,
      body: { Metadata: cleanMeta }
    });
    if (r.error) throw new Error(r.error);
  }

  // Prepare a CustomApplication Metadata object for Tooling API PATCH.
  // Strips Tooling-internal fields and sorts keys alphabetically
  // (CustomApplication XSD field ordering is largely alphabetical).
  function prepareCustomAppMetadata(meta) {
    const stripped = stripToolingFields(meta);
    if (!stripped || typeof stripped !== 'object' || Array.isArray(stripped)) return stripped;
    const result = {};
    for (const k of Object.keys(stripped).sort()) {
      if (k === 'profileActionOverrides' && Array.isArray(stripped[k])) {
        // Sort each entry's keys alphabetically (actionName, content, formFactor,
        // pageOrSobjectType, profile, recordType, type — already alphabetical)
        result[k] = stripped[k].map(o => {
          if (o && typeof o === 'object' && !Array.isArray(o)) {
            const so = {};
            for (const ok of Object.keys(o).filter(x => !TOOLING_INTERNAL_KEYS.has(x)).sort()) {
              so[ok] = o[ok];
            }
            return so;
          }
          return o;
        });
      } else {
        result[k] = stripped[k];
      }
    }
    return result;
  }

  // ── Metadata Deploy helpers ──────────────────────────────

  // Escape XML special characters in text content
  function escXml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Keys that must be stripped from the Metadata Deploy XML payload.
  // 'attributes' is a Tooling API sObject descriptor injected on every nested object
  // and is never a valid XSD element — always skip it.
  // NOTE: 'identifier' is intentionally NOT skipped here.  It is a valid FlexiPage
  // XSD field (unique per componentInstance) and is REQUIRED by certain components
  // such as 'flowruntime:interview'.  Stripping it causes a deploy error:
  //   "The '...' component instance doesn't have an identifier specified."
  // 'identifier' IS stripped for Tooling API PATCH payloads via TOOLING_INTERNAL_KEYS.
  const XML_SKIP_KEYS = new Set(['attributes']);

  // XSD-defined child-element orderings for FlexiPage nested types.
  // Key = the XML element name whose children follow this specific order.
  // ONLY needed where the XSD order differs from alphabetical — most nested types
  // (FlexiPageRegion, FlexiPageComponentProperty, UiFormulaCriterion, etc.) happen
  // to be alphabetical. The critical exception is FlexiPageComponentInstance where
  // 'componentName' (the identifier) must come BEFORE 'componentInstanceProperties'
  // even though 'componentI' < 'componentN' alphabetically.
  const ELEMENT_CHILD_ORDERS = {
    // FlexiPageComponentInstance — componentName is the XSD identifier and MUST come
    // before componentInstanceProperties even though alphabetically 'componentI' < 'componentN'.
    // Two keys are needed:
    //   'componentInstance'  — the singular element inside itemInstances arrays
    //   'componentInstances' — the top-level FlexiPage array element (same XSD type)
    componentInstance: [
      'componentName',
      'componentInstanceProperties',
      'identifier',        // valid XSD field — required by some components (e.g. flowruntime:interview)
      'visibilityRule',
    ],
    componentInstances: [
      'componentName',
      'componentInstanceProperties',
      'identifier',        // same as above — both key names map to the same XSD type
      'visibilityRule',
    ],
    // FlexiPageEventHandler (each pageAssignment item) — alphabetical = correct
    pageAssignments: [
      'app', 'default', 'formFactor', 'profile', 'recordType',
    ],
  };

  // Recursively converts a JSON value to XML lines for the given element name.
  // Arrays → repeated sibling elements; objects → nested children; primitives → text nodes.
  // Null / undefined / empty-string values are skipped.
  // Tooling-internal keys (XML_SKIP_KEYS) are skipped at every level.
  // Nested object keys are ordered by ELEMENT_CHILD_ORDERS when a known ordering exists,
  // otherwise sorted alphabetically.
  function valueToXmlLines(key, value, indent) {
    if (XML_SKIP_KEYS.has(key)) return [];
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) {
      return value.flatMap(item => valueToXmlLines(key, item, indent));
    }
    if (typeof value === 'object') {
      const knownOrder = ELEMENT_CHILD_ORDERS[key];
      const rawKeys    = Object.keys(value).filter(k => !XML_SKIP_KEYS.has(k));
      const orderedKeys = knownOrder
        ? [
            ...knownOrder.filter(k => rawKeys.includes(k)),
            ...rawKeys.filter(k => !knownOrder.includes(k)).sort(),
          ]
        : rawKeys.sort();
      const children = orderedKeys.flatMap(k => valueToXmlLines(k, value[k], indent + '    '));
      if (children.length === 0) return [];
      return [`${indent}<${key}>`, ...children, `${indent}</${key}>`];
    }
    const str = String(value);
    if (str === '') return [];
    return [`${indent}<${key}>${escXml(str)}</${key}>`];
  }

  // The complete set of valid top-level FlexiPage fields in the Metadata XSD,
  // in the exact schema-defined order (mostly alphabetical, with pageAssignments last
  // because it was added to the schema later and lives after 'template').
  //
  // The Tooling API GET response injects extra fields (e.g. 'type', 'namespace',
  // 'manageableState', internal IDs, etc.) that the Metadata XSD rejects.
  // Using an explicit ordered list means we never accidentally include them,
  // regardless of what the Tooling API decides to return in the future.
  const FLEXIPAGE_FIELD_ORDER = [
    'actionOverrides',
    'availableQuickActions',
    'component',
    'componentInstances',
    'componentName',
    'description',
    'events',              // API v53.0+ — dynamic interactions / LWC event broadcasting
    'flexiPageRegions',
    'isTemplate',
    'masterLabel',
    'parentFlexiPage',
    'platformActionlist',
    // publishStatus is intentionally omitted — it is NOT in the writable FlexiPage XSD.
    // Salesforce manages it automatically: Draft → Active when the first assignment is
    // created, Active → Obsolete when all assignments are removed.  Attempting to write
    // it via Metadata Deploy or Tooling API Metadata compound causes an XSD cascade
    // error ("publishStatus invalid at this location").  Use a direct Tooling API
    // sObject PATCH { PublishStatus: 'Active' } instead (see activatePage()).
    'quickActionList',
    'sobjectType',
    'summaryLayout',
    'template',
    'type',                // RecordPage | AppPage | HomePage | UtilityBar | etc.
    // pageAssignments is intentionally omitted — not a valid FlexiPage XSD write target.
    // Assignments live in ActionOverride (org default) and CustomApplication (app default).
  ];

  // Build FlexiPage XML from the Tooling API Metadata object.
  // Only fields listed in FLEXIPAGE_FIELD_ORDER are emitted (whitelist approach) to
  // prevent Tooling-API-internal fields from breaking XSD sequence validation.
  //
  // NOTE: pageAssignments is intentionally NOT included here.
  // Page assignments are stored in CustomObject.actionOverrides (Org Default) and
  // CustomApplication.profileActionOverrides (App Default / Profile), NOT in the
  // FlexiPage metadata XML.  Including pageAssignments causes XSD validation to fail
  // because it is not a valid element in the FlexiPage XSD schema.
  function buildFlexiPageXml(metadata) {
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">'
    ];

    for (const key of FLEXIPAGE_FIELD_ORDER) {
      if (key in metadata && metadata[key] != null) {
        lines.push(...valueToXmlLines(key, metadata[key], '    '));
      }
    }

    lines.push('</FlexiPage>');
    return lines.join('\n');
  }

  function buildPackageXml(developerName) {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <types>',
      `        <members>${escXml(developerName)}</members>`,
      '        <name>FlexiPage</name>',
      '    </types>',
      '    <version>62.0</version>',
      '</Package>'
    ].join('\n');
  }

  // Fields the Tooling API injects into its JSON responses that do NOT exist in the
  // Metadata XSD schema. Sending these back in a PATCH causes the server-side XSD
  // validator to go out of sequence, which manifests as a cascade of misleading
  // "X invalid at this location" errors on the NEXT valid field it encounters.
  // Known offenders:
  //   'attributes'  — sObject descriptor { type, url } on every nested object
  //   'identifier'  — internal UUID on componentInstances entries
  const TOOLING_INTERNAL_KEYS = new Set(['attributes', 'identifier']);

  // Recursively remove all Tooling-API-internal keys from a metadata object so the
  // payload is clean for a PATCH write (Tooling API validates Metadata compound
  // against the same XSD schema as Metadata Deploy).
  function stripToolingFields(obj) {
    if (Array.isArray(obj)) return obj.map(stripToolingFields);
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (TOOLING_INTERNAL_KEYS.has(k)) continue;         // drop Tooling-internal keys
        if (v === null || v === undefined) continue;         // drop null/undefined — non-nillable XSD fields reject them
        if (Array.isArray(v) && v.length === 0) continue;   // drop empty arrays at ALL levels — Tooling API serialises
                                                             // them as empty XML elements whose required children then
                                                             // fail XSD validation, cascading as a misleading error on
                                                             // the next valid field (publishStatus, etc.)
        out[k] = stripToolingFields(v);
      }
      return out;
    }
    return obj;
  }

  // Prepare a FlexiPage Metadata object for a Tooling API PATCH.
  //
  // The Tooling API validates the Metadata compound field against the FlexiPage XSD.
  // Two problems if we just forward the raw GET response:
  //   1. The GET injects extra fields (type, namespace, manageableState, sobjectType as
  //      an ID, etc.) that are NOT in the XSD.  They trigger cascade "X invalid at this
  //      location" errors on the NEXT valid field the validator sees.
  //   2. pageAssignments is NONCREATABLE/NONUPDATABLE on FlexiPage — it must be omitted.
  //
  // Solution: use FLEXIPAGE_FIELD_ORDER as both a whitelist and an ordering guide,
  // exactly like buildFlexiPageXml does.  Only known-valid fields are emitted, in
  // XSD-defined order, with Tooling-internal keys stripped from nested objects.
  function prepareMetadata(meta) {
    const stripped = stripToolingFields(meta);
    if (!stripped || typeof stripped !== 'object' || Array.isArray(stripped)) return stripped;

    // Emit only the fields listed in FLEXIPAGE_FIELD_ORDER, in schema order.
    // Any field the Tooling API injected that isn't in this list is silently dropped.
    const result = {};
    for (const k of FLEXIPAGE_FIELD_ORDER) {
      const v = stripped[k];
      if (v == null) continue;                             // skip null/undefined
      if (Array.isArray(v) && v.length === 0) continue;   // skip empty arrays — XSD rejects them
      result[k] = v;
    }
    return result;
  }

  // Build an uncompressed (stored) ZIP and return it as a base64 string.
  // files: [{ name: string, data: Uint8Array }]. Delegates to the shared
  // builder in sftk-zip.js (loaded before this module in popup.html).
  function buildStoredZip(files) {
    return window.sftkBuildStoredZip(files);
  }

  // Build a ready-to-deploy base64 ZIP for a FlexiPage Metadata Deploy.
  // Used for any future FlexiPage-level metadata changes (not page assignments —
  // those are managed via ActionOverride / CustomApplication separately).
  // Pass publishStatusOverride to force a specific activation state in the XML.
  function buildFlexiPageZip(metaRes, publishStatusOverride) {
    const developerName = metaRes.FullName;
    const metadata      = publishStatusOverride
      ? { ...metaRes.Metadata, publishStatus: publishStatusOverride }
      : metaRes.Metadata;
    const enc = new TextEncoder();
    return buildStoredZip([
      { name: 'package.xml',
        data: enc.encode(buildPackageXml(developerName)) },
      { name: `flexipages/${developerName}.flexipage`,
        data: enc.encode(buildFlexiPageXml(metadata)) }
    ]);
  }

  // ── Helpers ──────────────────────────────────────────────

  function humanType(type) {
    const map = {
      RecordPage: 'Record Page', AppPage:    'App Page',
      HomePage:   'Home Page',   UtilityBar: 'Utility Bar',
      FlowPage:   'Flow Page',   LoginPage:  'Login Page',
      Other:      'Other'
    };
    return map[type] || type || 'Other';
  }

  function typeIcon(type) {
    const map = {
      RecordPage: '📋', AppPage:    '🖥',
      HomePage:   '🏠', UtilityBar: '🔧',
      FlowPage:   '⚡', LoginPage:  '🔐',
      Other:      '📄'
    };
    return map[type] || '📄';
  }

  function setLoading(show) {
    const el = document.getElementById('lpLoading');
    if (el) el.style.display = show ? '' : 'none';
  }

  function setContent(html) {
    const el = document.getElementById('lpContent');
    if (el) el.innerHTML = html;
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

  // bg — sends a message to the background worker.
  // background.js already retries once on SESSION_EXPIRED with a fresh cookie read.
  // If that retry also fails, this function reads the session itself, updates
  // the module's own _orgUrl/_sid, and retries once more — no user action needed
  // as long as the Salesforce org tab is still open.
  async function bg(msg) {
    const _t   = window.SFToolkitDebug?.enabled ? Date.now() : null;
    const resp = await bgRaw(msg);
    // ── Debug logging ────────────────────────────────────────
    if (window.SFToolkitDebug?.enabled) {
      const dur = _t !== null ? Date.now() - _t : null;
      const tag = msg.query?.substring(0, 80) || msg.path || msg.sobject || '';
      window.SFToolkitDebug.log('pages',
        resp?.error === 'SESSION_EXPIRED' ? 'session'
          : resp?.error ? (msg._suppressError ? 'warn' : 'error')
          : 'api',
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

// ============================================================
// N3 — Lightning page assignment precedence (PURE, unit-tested)
//
// These live at column 0 (outside the IIFE) on purpose: test/extract.mjs can
// only materialize top-level `function NAME(` declarations, and the whole
// point of N3 is that the precedence rule is testable rather than buried in a
// render function. They reference no file-level state — everything they need
// arrives as arguments. Function declarations hoist, so the IIFE above can
// call them even though it is evaluated first.
//
// Salesforce resolves competing FlexiPage assignments by SPECIFICITY: the
// assignment naming the most dimensions wins. We score the three dimensions
// independently so the documented chain falls out of the arithmetic:
//
//   app(4) + profile(2) + recordType(1)
//
//     App + Record Type + Profile   7   ← most specific
//     App + Profile                 6
//     App + Record Type             5
//     App default                   4
//     Record Type + Profile         3
//     Profile                       2
//     Record Type                   1
//     Org default                   0   ← least specific
//
// This satisfies the required chain
//   record-type + app + profile > app + profile > app default > org default
// and gives the in-between combinations a defensible, deterministic slot
// instead of an arbitrary one.
// ============================================================

// Specificity score for a single page assignment. -1 for a non-object input so
// a malformed assignment can never outrank a real one.
function lpAssignmentRank(a) {
  if (!a || typeof a !== 'object') return -1;
  const has = v => !!(v !== null && v !== undefined && String(v).trim() !== '');
  return (has(a.app) ? 4 : 0) + (has(a.profile) ? 2 : 0) + (has(a.recordType) ? 1 : 0);
}

// Human name for the rule tier an assignment sits in — used verbatim in the UI
// so the reason string names the rule the user would recognise in App Builder.
function lpScopeLabel(a) {
  const has = v => !!(v !== null && v !== undefined && String(v).trim() !== '');
  const hasApp = has(a && a.app), hasProfile = has(a && a.profile), hasRt = has(a && a.recordType);
  if (!hasApp && !hasProfile && !hasRt) return 'Org default';
  if (hasApp && !hasProfile && !hasRt) return 'App default';
  const bits = [];
  if (hasApp) bits.push('App');
  if (hasRt) bits.push('Record Type');
  if (hasProfile) bits.push('Profile');
  return bits.join(' + ');
}

// Does this assignment apply to a user in this context?
// An assignment constrains only the dimensions it names: an assignment with no
// app applies in every app, one with no record type applies to every record
// type. A dimension the assignment DOES name must match the context exactly.
// A context dimension left null/'' means "not in that app / no record type",
// so an assignment that names one does not apply.
function lpMatchesUser(a, ctx) {
  if (!a || typeof a !== 'object' || !ctx || typeof ctx !== 'object') return false;
  const norm = v => (v === null || v === undefined) ? '' : String(v).trim().toLowerCase();
  const aApp = norm(a.app), aProf = norm(a.profile), aRt = norm(a.recordType), aFf = norm(a.formFactor);
  const cApp = norm(ctx.app), cProf = norm(ctx.profile), cRt = norm(ctx.recordType), cFf = norm(ctx.formFactor);
  if (aProf && aProf !== cProf) return false;
  if (aApp  && aApp  !== cApp)  return false;
  if (aRt   && aRt   !== cRt)   return false;
  // Form factor: only compared when BOTH sides state one. Salesforce defaults a
  // missing formFactor to Large, but an unstated context means "either", and we
  // would rather over-report a row than silently hide a page a user can see.
  if (aFf && cFf && aFf !== cFf) return false;
  return true;
}

// Pick the winning assignment for a user context.
//
// Returns { winner, rank, scope, reason, matched, beaten }:
//   winner  — the assignment object that wins, or null if none matches
//   rank    — its specificity score (-1 when nothing matched)
//   scope   — lpScopeLabel of the winner ('None' when nothing matched)
//   reason  — plain-English sentence naming the rule that won and what it beat
//   matched — every applicable assignment, already sorted winner-first
//   beaten  — matched.slice(1)
//
// Ties (two assignments at the same specificity) are broken deterministically:
//   1. an assignment explicitly flagged `default: true` wins
//   2. then alphabetically on app / record type / profile / page label
//   3. then original array order
// Salesforce does not document its own tie-break, so `reason` says so out loud
// rather than implying we know which one the org will really render.
function lpResolveWinner(assignments, userContext) {
  const ctx  = userContext || {};
  const list = Array.isArray(assignments) ? assignments : [];
  const matched = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!lpMatchesUser(a, ctx)) continue;
    const label = (a._pageLabel || a.pageLabel || a._pageId || a.pageId || '');
    matched.push({
      assignment: a,
      index: i,
      rank:  lpAssignmentRank(a),
      scope: lpScopeLabel(a),
      tieKey: [a.app, a.recordType, a.profile, label]
        .map(v => String(v === null || v === undefined ? '' : v).toLowerCase())
        .join(' ')
    });
  }
  matched.sort((x, y) => {
    if (y.rank !== x.rank) return y.rank - x.rank;
    const xd = x.assignment.default ? 0 : 1;
    const yd = y.assignment.default ? 0 : 1;
    if (xd !== yd) return xd - yd;
    if (x.tieKey !== y.tieKey) return x.tieKey < y.tieKey ? -1 : 1;
    return x.index - y.index;
  });

  const top    = matched.length ? matched[0] : null;
  const beaten = matched.slice(1);
  let reason;
  if (!top) {
    reason = 'No assignment matches this user here — Salesforce falls back to the standard page for this object.';
  } else if (!beaten.length) {
    reason = 'Only matching assignment: ' + top.scope + ' (specificity ' + top.rank + ').';
  } else if (beaten[0].rank < top.rank) {
    reason = top.scope + ' (specificity ' + top.rank + ') beats ' + beaten[0].scope +
             ' (specificity ' + beaten[0].rank + ') — the more specific assignment wins.';
  } else {
    const tied = matched.filter(m => m.rank === top.rank).length;
    reason = tied + ' assignments tie at ' + top.scope + ' (specificity ' + top.rank +
             '). Broken deterministically: "Default"-flagged first, then app / record type / profile / page name alphabetically. ' +
             'Salesforce does not document its tie-break, so confirm this one in Lightning App Builder.';
  }

  return {
    winner: top ? top.assignment : null,
    rank:   top ? top.rank : -1,
    scope:  top ? top.scope : 'None',
    reason,
    matched,
    beaten
  };
}

// SOQL string literal. Backslash first, then the single quote — reversing the
// order would double-escape the backslash we just inserted.
function lpSoqlLit(v) {
  return "'" + String(v === null || v === undefined ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'") + "'";
}

// SOQL LIKE literal with %…% wrapping. Escapes the LIKE wildcards too, so a
// user searching for "50%" does not accidentally match everything.
function lpSoqlLike(v) {
  const body = String(v === null || v === undefined ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
  return "'%" + body + "%'";
}
