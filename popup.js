// ============================================================
// State
// ============================================================
let orgUrl = null;
let sid = null;
let allFlows = [];          // flat list of all Flow records
let flowGroups = {};        // MasterLabel -> [Flow records]
let selectedIds = new Set(); // selected Flow version Ids
let orgFlowCount = 0;
let metadataScanState = 'none'; // 'none' | 'scanning' | 'done'
let toolbarEventsReady = false;  // guard against duplicate listeners
const LAZY_THRESHOLD = 50; // show progress bar during silent scan above this count

// ── Lazy-load guard ───────────────────────────────────────────
let _flowsLoaded = false;      // true after first loadFlows() call
let _activeTabUrl = null;      // URL of the tab open when the popup launched (for Record Copy)

// ── Mode state ────────────────────────────────────────────────
let currentMode = 'delete';    // 'delete' | 'backup' | 'restore'
let restoreBackupFlows = [];   // flows array loaded from backup file
let restoreSelected = new Set(); // indices of flows chosen for restore

const STATUS_MESSAGES = [
  '🗑 Deleting flows...',
  '⚡ Zapping obsolete versions...',
  '🐾 Kitty is on it...',
  '🧹 Cleaning up interviews...',
  '💨 Gone. Poof. Bye bye flows.'
];

// ============================================================
// Init
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  initDarkTheme();
  initDebugMode();
  initActivityBar();
  setupTabs();
  setupModeToggle();
  initTopbarOrgChip();
  document.getElementById('homeBtn')?.addEventListener('click', showHomePage);
  document.getElementById('dataStudioBtn')?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') });
  });

  // ── Popout — open popup.html in its own browser window ────────────
  // Chrome action popups are capped at 800px wide which crushes the Apex
  // Debugger and the new merged Data Deployment page. Opening popup.html
  // as a window unlocks full viewport sizing. We use chrome.windows.create
  // with `type:"popup"` so the user gets a chromeless window that feels
  // like a dedicated workspace, not a regular tab.
  //
  // If we're already in a popout window (URL has ?popout=1) the button is
  // hidden — popout from inside a popout would just clone the view.
  const popoutBtn = document.getElementById('popoutBtn');
  const inPopout  = new URLSearchParams(location.search).has('popout');
  if (popoutBtn) {
    if (inPopout) {
      popoutBtn.style.display = 'none';
    } else {
      popoutBtn.addEventListener('click', () => {
        if (chrome.windows?.create) {
          // Two-step open: create at the largest available screen size, then
          // immediately maximize. The two-step matters because some Chrome
          // builds ignore `state:'maximized'` if a fixed width/height is also
          // passed, and on multi-monitor setups omitting both can mis-place
          // the window. Sizing to availWidth/availHeight gives us full screen
          // on most setups; the maximize call covers the rest.
          const w = (typeof screen !== 'undefined' && screen.availWidth)  || 1600;
          const h = (typeof screen !== 'undefined' && screen.availHeight) || 1000;
          chrome.windows.create({
            url:    chrome.runtime.getURL('popup.html') + '?popout=1',
            type:   'popup',
            left:   0,
            top:    0,
            width:  w,
            height: h
          }, win => {
            if (win?.id != null) {
              try { chrome.windows.update(win.id, { state: 'maximized' }); } catch (_) {}
            }
          });
        } else {
          // Fallback for the very unlikely "no windows API" case
          chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') + '?popout=1' });
        }
      });
    }
  }

  await initSession();
  maybeRunFirstRunTour();
});

// ── First-run guided tour ─────────────────────────────────────
// Shown once, ever — highlights the core areas so new users aren't lost.
function maybeRunFirstRunTour() {
  if (!window.SFTKOnboard) return;
  window.SFTKOnboard.firstRun('toolkit', [
    {
      title: 'Welcome to Salesforce Toolkit',
      text:  'A quick 4-step tour so you know where everything is. You can skip anytime.'
    },
    {
      selector: '.app-sidebar',
      title: 'Your tools',
      text:  'Every feature lives here — clean up flows, inspect Lightning pages, find field dependencies, copy permissions, manage licenses and more.'
    },
    {
      selector: '#dataStudioBtn',
      title: 'Data Studio',
      text:  'Need to move records or compare data across orgs? Data Studio opens in its own tab.'
    },
    {
      selector: '#dbgBtn',
      title: 'Debug log',
      text:  'Toggle this to see every API call the toolkit makes — handy when something looks off.'
    },
    {
      title: "You're all set",
      text:  'Pick a tool from the left to get started. You can replay this tour anytime from the home page.'
    }
  ]);
}

// ── Dark theme — body.sftk-dark, persisted in chrome.storage.local ──
// styles.css is fully CSS-variable-driven, so the class flip restyles
// every component. Shared key with the standalone log viewer.
function initDarkTheme() {
  const KEY = 'sftk_dark';
  const btn = document.getElementById('sftkDarkToggle');
  const apply = on => {
    document.body.classList.toggle('sftk-dark', !!on);
    if (btn) {
      btn.textContent = on ? '☀️' : '🌙';
      btn.title = on ? 'Switch to light mode' : 'Switch to dark mode';
    }
  };
  chrome.storage?.local?.get(KEY).then(d => apply(d?.[KEY])).catch(() => {});
  btn?.addEventListener('click', () => {
    const on = !document.body.classList.contains('sftk-dark');
    apply(on);
    chrome.storage?.local?.set({ [KEY]: on });
  });
}

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      navigateToTab(btn.dataset.tab);

      if (btn.dataset.tab === 'flows')        loadFlowsIfNeeded();
      if (btn.dataset.tab === 'dependencies') renderDependenciesTab();
      if (btn.dataset.tab === 'debugger')     initDebuggerTab();
      if (btn.dataset.tab === 'pages')        initLightningPagesTab();
      if (btn.dataset.tab === 'copy-perms')   initUserCopyTab();
      if (btn.dataset.tab === 'licenses')     initLicenseManagerTab();
      if (btn.dataset.tab === 'flow-access')  initFlowAccessTab();
      if (btn.dataset.tab === 'fields')       initFieldCleanerTab();
    });
  });
}

// ── Feature descriptor list used by the home page ────────────
const HOME_FEATURES = [
  {
    id: 'flows',
    icon: '🗑',
    color: '#0176D3',   // brand blue
    title: 'Flows',
    desc: 'Bulk delete, backup, and restore flow versions safely',
    action() { navigateToTab('flows'); loadFlowsIfNeeded(); }
  },
  {
    id: 'dependencies',
    icon: '🗺',
    color: '#5867e8',   // indigo
    title: 'Dependencies',
    desc: 'Map subflow call chains and see which flows reference other flows',
    action() { navigateToTab('dependencies'); renderDependenciesTab(); }
  },
  {
    id: 'debugger',
    icon: '🐛',
    color: '#8B5CF6',   // violet
    title: 'Debugger',
    desc: 'Real-time automation monitor — trace flows, triggers, and detect recursion loops',
    action() { navigateToTab('debugger'); initDebuggerTab(); }
  },
  {
    id: 'pages',
    icon: '📄',
    color: '#6B57D2',   // purple
    title: 'Lightning Pages',
    desc: 'View assignments, org defaults, and profile overrides for Record Pages',
    action() { navigateToTab('pages'); initLightningPagesTab(); }
  },
  {
    id: 'fields',
    icon: '🔧',
    color: '#3BA755',   // green
    title: 'Field Cleaner',
    desc: 'Scan field dependencies, auto-remove from flows, then safely delete the field',
    action() { navigateToTab('fields'); initFieldCleanerTab(); }
  },
  {
    id: 'copy-perms',
    icon: '👥',
    color: '#0D74CE',   // teal-blue
    title: 'Copy Permissions',
    desc: 'Copy permission sets, profiles, and assignments between users',
    action() { navigateToTab('copy-perms'); initUserCopyTab(); }
  },
  {
    id: 'licenses',
    icon: '🔑',
    color: '#0D74CE',
    title: 'Licenses',
    desc: 'View and manage user license assignments across your org',
    action() { navigateToTab('licenses'); initLicenseManagerTab(); }
  },
  {
    id: 'flow-access',
    icon: '🌊',
    color: '#0D74CE',
    title: 'Flow Access',
    desc: 'Control which users and profiles can run each flow',
    action() { navigateToTab('flow-access'); initFlowAccessTab(); }
  },
];

// Feature sections — defines grouping on the home page
const HOME_SECTIONS = [
  {
    title: 'Flows & Automation',
    ids: ['flows', 'dependencies', 'debugger']
  },
  {
    title: 'Pages & Fields',
    ids: ['pages', 'fields']
  },
  {
    title: 'Users & Records',
    ids: ['copy-perms', 'licenses', 'flow-access']
  }
];

// ── Deep links from the Data Studio command palette ──────────
// A fresh popout window arrives with ?tab=<feature id>; an already-open
// one receives a TOOLKIT_NAVIGATE runtime message. Either way the target
// feature opens via its HOME_FEATURES action (which also triggers the
// tab's first data load) — deferred until a session exists, since every
// feature init needs orgUrl/sid.
let _deepLinkTab = new URLSearchParams(location.search).get('tab');

chrome.runtime?.onMessage?.addListener?.((msg) => {
  if (msg?.type === 'TOOLKIT_NAVIGATE' && msg.tab) {
    const feat = HOME_FEATURES.find(f => f.id === msg.tab);
    if (feat && sid) feat.action();
    else _deepLinkTab = msg.tab;   // run once the session lands
  }
});

// Navigate to a feature tab — hides home view, highlights sidebar item.
function navigateToTab(tabName) {
  document.getElementById('homeView').style.display = 'none';
  document.getElementById('homeBtn').style.display  = '';
  document.querySelector('.app-body')?.classList.remove('home-active');

  // Restore the topbar org chip now that we're on a feature tab
  updateTopbarOrgChip();

  // Deactivate all sidebar items and hide all tab panels
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');

  // Activate the matching sidebar button and show the panel
  const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
  const tab = document.getElementById(`tab-${tabName}`);
  if (btn) btn.classList.add('active');
  if (tab) tab.style.display = '';
}

// Show the home page — deactivates sidebar selection.
function showHomePage() {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
  document.getElementById('homeBtn').style.display = 'none';
  renderHomePage();
}

// ── Render the full home page into #homeView ──────────────────
function renderHomePage() {
  // Deep link pending? Session is ready by the time home renders — jump
  // straight to the requested feature instead of showing home.
  if (_deepLinkTab) {
    const feat = HOME_FEATURES.find(f => f.id === _deepLinkTab);
    _deepLinkTab = null;
    if (feat) { feat.action(); return; }
  }
  const homeView = document.getElementById('homeView');
  if (!homeView) return;
  homeView.style.display = '';
  document.querySelector('.app-body')?.classList.add('home-active');
  // Home has its own large org chip — hide the topbar chip to avoid duplication
  const topChip = document.getElementById('topbarOrgChip');
  if (topChip) topChip.style.display = 'none';

  // Org display strings
  const orgHost  = (() => { try { return new URL(orgUrl).hostname; } catch (_) { return orgUrl || ''; } })();
  const orgShort = orgHost
    .replace(/\.my\.salesforce\.com$/, '')
    .replace(/\.salesforce\.com$/, '')
    .replace(/\.develop\.my\.salesforce\.com$/, '') || orgHost;

  // Build section HTML
  const sectionsHTML = HOME_SECTIONS.map(section => {
    const cards = section.ids
      .map(id => HOME_FEATURES.find(f => f.id === id))
      .filter(Boolean)
      .map(f => `
        <button class="home-card" data-fid="${escHtml(f.id)}">
          <span class="home-card-icon" style="background:${f.color}14;border-color:${f.color}33;color:${f.color}">${f.icon}</span>
          <div class="home-card-body">
            <span class="home-card-title">${escHtml(f.title)}</span>
            <span class="home-card-desc">${escHtml(f.desc)}</span>
          </div>
          <span class="home-card-arrow">›</span>
        </button>`).join('');

    return `
      <div class="home-section">
        <div class="home-section-title">${escHtml(section.title)}</div>
        <div class="home-section-cards">${cards}</div>
      </div>`;
  }).join('');

  homeView.innerHTML = `
    ${orgHost ? `
      <button class="home-org-chip home-org-chip-btn" id="homeOrgSelector" title="Switch active org">
        <span class="home-org-dot"></span>
        <div class="home-org-chip-text">
          <span class="home-org-name">${escHtml(orgShort)}</span>
          <span class="home-org-host">${escHtml(orgHost)}</span>
        </div>
        <span class="home-org-chip-arrow">▾</span>
      </button>` : ''}

    <div class="home-sections">
      ${sectionsHTML}

      <div class="home-studio-row">
        <button class="home-studio-btn" id="homeStudioBtn">
          <span class="home-studio-icon">🌐</span>
          <div class="home-studio-body">
            <span class="home-studio-title">Data Studio</span>
            <span class="home-studio-desc">Multi-org data deployment, profiles &amp; transfer</span>
          </div>
          <span class="home-studio-arrow">→</span>
        </button>
      </div>
    </div>`;

  homeView.querySelectorAll('.home-card').forEach(card => {
    const feature = HOME_FEATURES.find(f => f.id === card.dataset.fid);
    if (feature) card.addEventListener('click', feature.action);
  });
  document.getElementById('homeStudioBtn')?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') });
  });

  // ── Org selector dropdown ──────────────────────────────────────
  document.getElementById('homeOrgSelector')?.addEventListener('click', e => {
    e.stopPropagation();

    // Toggle: close if already open
    const existing = document.getElementById('homeOrgDropdown');
    if (existing) { existing.remove(); return; }

    const chipBtn = document.getElementById('homeOrgSelector');
    const rect    = chipBtn.getBoundingClientRect();

    // Normalize org URL for comparison (strips trailing slash / path differences)
    const normUrl = u => { try { return new URL(u).origin.toLowerCase(); } catch(_) { return (u||'').toLowerCase(); } };

    // Create the dropdown container up front
    const dd = document.createElement('div');
    dd.id        = 'homeOrgDropdown';
    dd.className = 'home-org-dropdown';
    dd.style.cssText = `top:${rect.bottom + 4}px;left:${rect.left}px;min-width:${Math.max(rect.width, 260)}px`;

    // Close helper — defined before buildDropdown so it can reference it
    function closeDropdown() {
      const el = document.getElementById('homeOrgDropdown');
      if (el) el.remove();
      document.removeEventListener('click', onOutsideClick, true);
    }

    function onOutsideClick(ev) {
      // Let the chip button handle its own toggle — if the click is on the
      // chip (or inside it) don't interfere; the existing-dropdown check at
      // the top of the click handler will close it.
      if (dd.contains(ev.target) || chipBtn.contains(ev.target)) return;
      closeDropdown();
    }

    // Build (or rebuild on retry) the dropdown contents
    async function buildDropdown() {
      dd.innerHTML = '';

      const hdr = document.createElement('div');
      hdr.className = 'home-org-dd-header';
      hdr.textContent = 'SWITCH ACTIVE ORG';
      dd.appendChild(hdr);

      const spinner = document.createElement('div');
      spinner.className = 'home-org-dd-empty';
      spinner.textContent = 'Detecting sessions…';
      dd.appendChild(spinner);

      // Fetch both live browser-tab sessions AND stored credential orgs in parallel
      const [r, stored] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'GET_ALL_SF_SESSIONS' }),
        chrome.storage.local.get('ds_stored_orgs').then(d => d.ds_stored_orgs || []).catch(() => [])
      ]);
      const sessions = r?.sessions || [];
      spinner.remove();

      // Deduplicate: tab sessions take priority over stored orgs for the same URL
      const seen    = new Set();
      const allOrgs = [];
      for (const s of sessions) {
        const key = normUrl(s.orgUrl);
        if (!seen.has(key)) { seen.add(key); allOrgs.push({ ...s, online: true }); }
      }
      for (const o of stored) {
        if (!o.url || !o.sid) continue;
        const key = normUrl(o.url);
        if (!seen.has(key)) {
          seen.add(key);
          allOrgs.push({ orgUrl: o.url, sid: o.sid, label: o.label || o.username, online: false, stored: true });
        }
      }

      if (!allOrgs.length) {
        const empty = document.createElement('div');
        empty.className = 'home-org-dd-empty';
        empty.textContent = 'No orgs detected — open a Salesforce tab or add one in Data Studio.';
        dd.appendChild(empty);
      } else {
        allOrgs.forEach(sess => {
          const host      = (() => { try { return new URL(sess.orgUrl).hostname; } catch (_) { return sess.orgUrl || ''; } })();
          const name      = sess.label || host;
          const isCurrent = normUrl(sess.orgUrl) === normUrl(orgUrl);
          const dotColor  = sess.online ? '#4ac154' : '#9b8ec4';

          const item = document.createElement('button');
          item.className = 'home-org-dd-item' + (isCurrent ? ' home-org-dd-item-active' : '');
          item.innerHTML = `
            <span class="home-org-dd-dot" style="background:${dotColor};box-shadow:none"></span>
            <span class="home-org-dd-text">
              <span class="home-org-dd-name">${escHtml(name)}</span>
              <span class="home-org-dd-host">${escHtml(host)}</span>
            </span>
            ${sess.stored ? '<span class="t-tag t-tag-cred" style="font-size:9px;padding:1px 5px;border-radius:3px;background:#f0ebff;color:#7c5ce0;flex-shrink:0">credentials</span>' : ''}
            ${isCurrent ? '<span class="home-org-dd-check">active</span>' : ''}`;

          item.addEventListener('click', ev => {
            ev.stopPropagation();
            if (!isCurrent) {
              resetOrgState();
              propagateFreshSession(sess.orgUrl, sess.sid);
            }
            closeDropdown();
            if (!isCurrent) renderHomePage();
          });
          dd.appendChild(item);
        });
      }

      // Retry button at the bottom
      const retryRow = document.createElement('button');
      retryRow.className = 'home-org-dd-retry';
      retryRow.textContent = '🔄 Re-scan';
      retryRow.addEventListener('click', ev => { ev.stopPropagation(); buildDropdown(); });
      dd.appendChild(retryRow);
    }

    document.body.appendChild(dd);
    buildDropdown();   // kick off the async fetch
    setTimeout(() => document.addEventListener('click', onOutsideClick, true), 0);
  });

  // ── Eager background preload ────────────────────────────────────────────────
  // Start loading flows & dependency metadata immediately whenever the home page
  // renders (i.e. as soon as a session is established). This means every tab
  // (Flows, Dependencies, Flow Access…) has its data ready when the user arrives
  // — no tab-switching required.
  loadFlowsIfNeeded();

  // ── Session keepalive ───────────────────────────────────────────────────────
  // Start/restart the keepalive now that we have a live session.
  startKeepalive();
}

// Load flows only once — guard against double-firing.
function loadFlowsIfNeeded() {
  if (_flowsLoaded) return;
  _flowsLoaded = true;
  loadFlows();
}

// Timer reference for the "waiting for SF tab" polling loop.
let _sessionPollTimer = null;

// ── Session keepalive ─────────────────────────────────────────────────────────
// Salesforce expires sessions after inactivity (2 hours by default, but Dev
// Edition orgs can be configured as low as 15–30 minutes).  While the toolkit
// tab is open, the SF tab may be idle in the background — make a lightweight
// "limits" ping every 20 minutes to prevent the server from timing it out.
let _keepaliveTimer = null;

function startKeepalive() {
  stopKeepalive();
  _keepaliveTimer = setInterval(async () => {
    if (!orgUrl || !sid) return;
    try {
      // GET /limits is the lightest authenticated SF API call — no side effects.
      // _suppressError: true keeps it silent in the activity bar (no red dot).
      await bg({ type: 'SF_REST_GET', orgUrl, sid,
                  path: `services/data/v62.0/limits`,
                  _suppressError: true });
    } catch (_) {}
  }, 20 * 60 * 1000);   // every 20 minutes
}

function stopKeepalive() {
  if (_keepaliveTimer) { clearInterval(_keepaliveTimer); _keepaliveTimer = null; }
}

// ── initSession(reason) ───────────────────────────────────────────────────────
// reason = undefined  → normal startup: try whatever cookie is in the browser
// reason = 'expired'  → API returned SESSION_EXPIRED: the cookie we HAVE is dead
//                        server-side.  Do NOT reconnect with the same value —
//                        wait specifically for the cookie to CHANGE, then retry.
// reason = 'cookie_changed' → background detected a new sid cookie: try it now.
//
// The 'expired' guard is the critical fix for the infinite loop:
//   handleApiError(SESSION_EXPIRED) → initSession('expired')
//   → finds same dead cookie → getSalesforceSession() "succeeds"
//   → renderHomePage() → user clicks Flows → SESSION_EXPIRED again → loop
// With 'expired', we skip the stale cookie and wait for a genuinely new one.
async function initSession(reason) {
  clearInterval(_sessionPollTimer);
  stopKeepalive();

  // Reset to "home loading" state.
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
  document.getElementById('homeBtn').style.display = 'none';
  document.getElementById('sessionError').style.display = 'none';

  const homeView = document.getElementById('homeView');

  // ── 'cookie_changed': background saw a new sid — try it immediately ────────
  if (reason === 'cookie_changed') {
    if (homeView) {
      homeView.style.display = '';
      homeView.innerHTML = `<div class="home-loading">${sftkCat('Reconnecting…')}</div>`;
    }
    try {
      const session = await getSalesforceSession();
      if (session?.sid) {
        orgUrl = session.orgUrl;
        sid    = session.sid;
        updateTopbarOrgChip();
        renderHomePage();
        return;
      }
    } catch (_) {}
    // Cookie changed but getSalesforceSession failed — fall through to waiting state
  }

  // ── 'expired': current cookie is dead server-side — skip it ──────────────
  // ── undefined (startup): try whatever cookie exists ───────────────────────
  if (reason !== 'expired') {
    if (homeView) {
      homeView.style.display = '';
      homeView.innerHTML = `<div class="home-loading">${sftkCat('Detecting Salesforce session…')}</div>`;
    }
    try {
      const session = await getSalesforceSession();
      if (session?.sid) {
        orgUrl = session.orgUrl;
        sid    = session.sid;
        updateTopbarOrgChip();
        renderHomePage();
        return;
      }
    } catch (_) {}
  }

  // ── Waiting state ─────────────────────────────────────────────────────────
  // 'expired': session cookie is dead — show a specific message.
  // no session found: show the generic "open a SF tab" message.
  const isExpired = (reason === 'expired');
  const staleSid  = sid; // remember what value was dead, so we only reconnect on change

  if (homeView) {
    homeView.style.display = '';
    homeView.innerHTML = isExpired ? `
      <div class="home-loading">
        ${sftkCat('Session expired', true)}
        <div style="font-size:12px;color:#706E6B;margin-top:6px;margin-bottom:4px;text-align:center;line-height:1.55">
          Your Salesforce session has expired.<br>
          <strong style="color:#444">Log back into Salesforce</strong>, then return here.
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;justify-content:center">
          <button id="goToSfBtn" class="home-studio-btn"
            style="display:inline-flex;width:auto;padding:8px 16px;font-size:13px">
            🌐 Go to Salesforce
          </button>
          <button id="retryManualBtn" class="home-studio-btn"
            style="display:inline-flex;width:auto;padding:8px 16px;font-size:13px;background:#f4f6f9;color:#444;border:1px solid #ddd">
            🔄 Try again
          </button>
        </div>
        <div style="font-size:11px;color:#a0a0a0;margin-top:10px;text-align:center">
          Reconnects automatically once you log in.
        </div>
      </div>` : `
      <div class="home-loading">
        ${sftkCat('No Salesforce tab detected.', true)}
        <div style="font-size:12px;color:#706E6B;margin-top:4px;margin-bottom:10px;text-align:center">
          Open a Salesforce org in Chrome and this will connect automatically.
        </div>
        <button id="retryManualBtn" class="home-studio-btn"
          style="display:inline-flex;width:auto;padding:8px 18px;font-size:13px">
          🔄 Retry now
        </button>
      </div>`;

    // "Go to Salesforce" — focus the existing SF org tab (or open a new one if none)
    document.getElementById('goToSfBtn')?.addEventListener('click', async () => {
      try {
        const rawTabs = await new Promise(resolve =>
          chrome.tabs.query({ url: ['*://*.salesforce.com/*', '*://*.force.com/*', '*://*.salesforce-setup.com/*'] }, resolve)
        );
        const tabs = rawTabs.filter(t => isSfOrgTab(t.url));
        if (tabs.length > 0) {
          // Bring the most-recently-accessed SF org tab to the front
          const best = tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
          chrome.tabs.update(best.id, { active: true });
          chrome.windows.update(best.windowId, { focused: true });
        } else {
          // No SF tab open — open the Salesforce login page
          const loginUrl = (orgUrl && orgUrl.startsWith('https://'))
            ? orgUrl
            : 'https://login.salesforce.com';
          chrome.tabs.create({ url: loginUrl });
        }
      } catch (_) {
        // Fallback: open login
        chrome.tabs.create({ url: 'https://login.salesforce.com' });
      }
    });

    document.getElementById('retryManualBtn')?.addEventListener('click', () => initSession());
  }

  // ── Polling strategy ─────────────────────────────────────────────────────
  //
  // EXPIRED case: do NOT poll.
  //   The previous `sid !== staleSid` guard was meant to only reconnect when the
  //   cookie genuinely changed.  But with multiple orgs open, Chrome may return
  //   a different-but-equally-dead SID from a shared-domain cookie (.develop.my.
  //   salesforce.com is shared by all sandbox slugs).  The poll then alternates
  //   between two stale SIDs, reconnects on each "change", fires loadFlows() which
  //   SESSION_EXPIREs again, calls initSession('expired') again — infinite loop.
  //
  //   The reliable signal for a genuine new session is `SF_SESSION_REFRESHED`
  //   (chrome.cookies.onChanged in background.js, which only fires when Salesforce
  //   actually writes a new sid cookie, e.g. after the user logs back in or the
  //   platform rotates the session).  The "Try again" button gives a manual escape
  //   hatch.  No automatic polling needed — it only causes harm here.
  //
  // NON-EXPIRED case: poll every 2.5 s to detect when the user opens an SF tab.
  //   Accept any valid session (no stale-SID guard needed — no prior dead SID).
  if (isExpired) return;  // SF_SESSION_REFRESHED + "Try again" button handle recovery

  _sessionPollTimer = setInterval(async () => {
    try {
      const s = await getSalesforceSession();
      if (s?.sid) {
        clearInterval(_sessionPollTimer);
        orgUrl = s.orgUrl;
        sid    = s.sid;
        renderHomePage();
      }
    } catch (_) {}
  }, 2500);
}

// ── Passive session recovery ──────────────────────────────────────────────────
// background.js watches for `sid` cookie changes on SF domains and fires this
// message.  We know the cookie is fresh — attempt reconnect immediately.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SF_SESSION_REFRESHED') {
    clearInterval(_sessionPollTimer);
    _flowsLoaded = false;
    initSession('cookie_changed');
  }
});

// Non-org Salesforce domains that match *.salesforce.com but have no Tooling API.
// Kept in sync with SF_EXCLUDED_HOSTS in background.js.
const SF_NON_ORG_HOSTS = new Set([
  'trailhead.salesforce.com',
  'trailblazer.salesforce.com',
  'login.salesforce.com',
  'test.salesforce.com',
  'developer.salesforce.com',
  'help.salesforce.com',
  'appexchange.salesforce.com',
  'status.salesforce.com',
  'trust.salesforce.com',
  'partners.salesforce.com',
  'www.salesforce.com',
]);

/** Returns true if `url` is an actual Salesforce org instance (not a portal/community site). */
function isSfOrgTab(url) {
  try {
    const host = new URL(url).hostname;
    if (SF_NON_ORG_HOSTS.has(host)) return false;
    // Real org URLs always have a subdomain that ends with a known SF suffix
    return host.includes('.my.salesforce.com') ||
           host.includes('.lightning.force.com') ||
           host.includes('.salesforce-setup.com') ||
           host.includes('.force.com') ||
           host.endsWith('.salesforce.com');   // e.g. orgslug.salesforce.com (classic)
  } catch (_) { return false; }
}

async function getSalesforceSession() {
  // Because the toolkit opens as a full browser tab (not a popup), the
  // "active tab in current window" IS the toolkit tab itself — not a
  // Salesforce org tab.  So we first check if the active tab is actually
  // a Salesforce URL; if not we scan all windows for SF org tabs and use
  // the most recently focused one as the org hint.
  let activeTabUrl = null;
  try {
    const SF_GLOBS = [
      'https://*.salesforce.com/*',
      'https://*.lightning.force.com/*',
      'https://*.salesforce-setup.com/*',
      'https://*.force.com/*'
    ];
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.url && !activeTab.url.startsWith('chrome-extension://') && isSfOrgTab(activeTab.url)) {
      // Popup mode or user navigated directly — use the genuinely active tab
      activeTabUrl = activeTab.url;
    } else {
      // Full-page mode: prefer SF tabs in the SAME window (currentWindow:true is
      // the most reliable filter — avoids manual windowId comparison bugs).
      // Filter out non-org SF domains (trailhead, login, etc.) after the glob query.
      // Fall back to any SF tab across all windows sorted by lastAccessed.
      const localSfTabs = (await chrome.tabs.query({ url: SF_GLOBS, currentWindow: true }))
        .filter(t => isSfOrgTab(t.url));
      if (localSfTabs.length > 0) {
        localSfTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
        activeTabUrl = localSfTabs[0].url;
      } else {
        const allSfTabs = (await chrome.tabs.query({ url: SF_GLOBS }))
          .filter(t => isSfOrgTab(t.url));
        if (allSfTabs.length > 0) {
          allSfTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
          activeTabUrl = allSfTabs[0].url;
        }
      }
    }
  } catch (_) {}

  _activeTabUrl = activeTabUrl;   // store for RecordCopy auto-detection

  // ── Direct cookie read (popup context has chrome.cookies access) ────────
  // Reading the cookie here instead of delegating to background.js avoids a
  // stale-service-worker bug where the old bg code uses chrome.cookies.get()
  // (returns earliest-created cookie) instead of getAll() sorted by domain
  // length.  A shared-domain cookie from another org (e.g. ashkenazy6's sid
  // scoped to .develop.my.salesforce.com) would otherwise shadow the correct
  // org-specific cookie when the service worker hasn't been reloaded yet.
  if (activeTabUrl) {
    try {
      const hostname = new URL(activeTabUrl).hostname;
      // Derive my.salesforce.com API origin (where Tooling API lives)
      const myHost = hostname.includes('.lightning.force.com')
        ? hostname.replace('.lightning.force.com', '.my.salesforce.com')
        : hostname.includes('.salesforce-setup.com')
        ? hostname.replace('.salesforce-setup.com', '.salesforce.com')
        : hostname;
      const orgUrl = `https://${myHost}`;
      // Try the tab's own hostname and the my.salesforce.com sibling
      // API origin first — ensures we read the salesforce.com sid, not the
      // salesforce-setup.com sid (different cookie value, invalid for REST API).
      const cookieUrls = [...new Set([orgUrl, `https://${hostname}`])];
      for (const url of cookieUrls) {
        const cookies = await chrome.cookies.getAll({ url, name: 'sid' });
        if (cookies.length > 0) {
          // Longest domain = most specific = this org's own session cookie
          cookies.sort((a, b) => b.domain.length - a.domain.length);
          return { sid: cookies[0].value, orgUrl };
        }
      }
    } catch (_) {}
  }

  // Fallback: let background.js handle it (covers edge cases like setup domains)
  const result = await sendBg({ type: 'GET_SF_SESSION', activeTabUrl });
  if (result && result.sid) return result;
  return null;
}

// ============================================================
// Load Flows
// ============================================================
async function loadFlows() {
  // Re-show toolbar in case it was hidden by a previous session error
  document.getElementById('toolbar').style.display = '';
  document.getElementById('selectionSummary').style.display = '';
  document.getElementById('deleteArea').style.display = '';
  showLoading(true);
  document.getElementById('flowList').style.display = 'none';
  document.getElementById('emptyState').style.display = 'none';
  selectedIds.clear();
  DependencyMap.reset();
  metadataScanState = 'none';

  try {
    // Snapshot the org context — an org switch can update the module-level
    // orgUrl/sid mid-load, which would otherwise send these flow IDs to the
    // wrong org's session (HTTP 404 on the metadata fetch).
    const loadOrgUrl = orgUrl, loadSid = sid;

    const query = `SELECT Id,MasterLabel,Definition.DeveloperName,DefinitionId,VersionNumber,Status,ProcessType,Description FROM Flow ORDER BY MasterLabel ASC,VersionNumber ASC`;
    const result = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: loadOrgUrl, sid: loadSid, query, tooling: true });
    if (result.error) {
      handleApiError(result.error);
      return;
    }

    allFlows = (result.records || []).map(f => ({
      ...f,
      ApiName: f.Definition?.DeveloperName || f.MasterLabel.replace(/[^a-zA-Z0-9_]/g, '_')
      // ProcessType will be refined after metadata fetch via patchFlowTypesFromMetadata()
    }));
    orgFlowCount = allFlows.length;

    groupFlows();
    showLoading(false);
    renderFlowList();
    updateActionBar();
    updateSelectionSummary();

    // Always scan metadata eagerly in the background — pass the snapshotted
    // org context so the flow IDs and the session always belong together.
    document.getElementById('scanSubflowBtnWrap').style.display = 'none';
    fetchAllMetadataSilently(loadOrgUrl, loadSid);

    setupToolbarEvents();
  } catch (e) {
    handleApiError(e.message || String(e));
  }
}

async function fetchAllMetadataSilently(loadOrgUrl, loadSid) {
  // Fall back to the current module values if not passed (older callers).
  loadOrgUrl = loadOrgUrl || orgUrl;
  loadSid    = loadSid    || sid;
  metadataScanState = 'scanning';

  // Show scan progress bar for orgs with many flows
  const showProgress = orgFlowCount >= LAZY_THRESHOLD;
  if (showProgress) {
    showScanProgress(true, `🔍 Building dependency map… 0 / ${orgFlowCount}`);
  }

  await DependencyMap.buildDependencyMap(allFlows, loadOrgUrl, loadSid, showProgress ? (done, total) => {
    showScanProgress(true, `🔍 Building dependency map… ${done} / ${total}`);
  } : null);

  if (showProgress) showScanProgress(false);
  metadataScanState = 'done';
  patchFlowTypesFromMetadata();
  groupFlows();
  renderFlowList(); // re-render with corrected types + 🔗 icons

  // If the dependency tab is already open, refresh it now that data is ready
  if (document.getElementById('tab-dependencies').style.display !== 'none') {
    renderDependenciesTab();
  }
}

function patchFlowTypesFromMetadata() {
  const triggerMap = DependencyMap.getTriggerTypeMap();
  for (const f of allFlows) {
    const triggerType = triggerMap[f.Id];
    if (triggerType) {
      f.ProcessType = resolveFlowType(f.ProcessType, triggerType);
    }
  }
}

function groupFlows() {
  flowGroups = {};
  for (const f of allFlows) {
    const key = f.MasterLabel;
    if (!flowGroups[key]) flowGroups[key] = [];
    flowGroups[key].push(f);
  }
}

// ============================================================
// Render Flow List
// ============================================================
function renderFlowList() {
  if (currentMode === 'restore') return; // restore mode owns the content area
  const list = document.getElementById('flowList');
  const emptyState = document.getElementById('emptyState');
  const search = document.getElementById('searchInput').value.toLowerCase().trim();
  const depMap = DependencyMap.getDependencyMap();

  list.innerHTML = '';

  const sortedLabels = Object.keys(flowGroups).sort((a, b) => a.localeCompare(b));
  let visibleCount = 0;

  for (const label of sortedLabels) {
    if (search && !label.toLowerCase().includes(search)) continue;
    const versions = flowGroups[label];
    visibleCount++;

    const groupEl = buildGroupElement(label, versions, depMap);
    list.appendChild(groupEl);
  }

  list.style.display = visibleCount > 0 ? '' : 'none';
  emptyState.style.display = visibleCount === 0 && sortedLabels.length > 0 ? '' : 'none';
  if (allFlows.length === 0) {
    emptyState.style.display = '';
    emptyState.textContent = 'No flows found in this org.';
  }
}

function buildGroupElement(label, versions, depMap) {
  const group = document.createElement('div');
  group.className = 'flow-group';
  group.dataset.label = label;

  // Check if any version of this flow is used as subflow
  const apiName = versions[0]?.ApiName || '';
  const isSubflow = depMap && (depMap[apiName] || []).length > 0;
  const parentFlows = isSubflow ? (depMap[apiName] || []) : [];

  // Determine group checkbox state
  const allChecked = versions.every(v => selectedIds.has(v.Id));
  const someChecked = versions.some(v => selectedIds.has(v.Id));

  const header = document.createElement('div');
  header.className = 'flow-group-header';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'flow-group-checkbox';
  checkbox.checked = allChecked;
  checkbox.indeterminate = !allChecked && someChecked;

  checkbox.addEventListener('change', (e) => {
    e.stopPropagation();
    versions.forEach(v => {
      if (e.target.checked) selectedIds.add(v.Id);
      else selectedIds.delete(v.Id);
    });
    updateGroupCheckbox(group, versions);
    updateActionBar();
    updateSelectionSummary();
    renderVersionCheckboxes(group, versions);
  });

  const toggleArrow = document.createElement('span');
  toggleArrow.className = 'group-toggle';
  toggleArrow.textContent = '▶';

  const groupInfo = document.createElement('div');
  groupInfo.className = 'group-info';

  const groupLabel = document.createElement('span');
  groupLabel.className = 'group-label';
  groupLabel.textContent = label;

  const versionBadge = document.createElement('span');
  versionBadge.className = 'version-count-badge';
  versionBadge.textContent = `${versions.length} version${versions.length !== 1 ? 's' : ''}`;

  groupInfo.appendChild(groupLabel);
  groupInfo.appendChild(versionBadge);

  if (isSubflow) {
    const subflowIcon = document.createElement('span');
    subflowIcon.className = 'subflow-icon';
    subflowIcon.textContent = '🔗';
    const tooltip = parentFlows.map(p =>
      `${p.masterLabel} (v${p.versionNumber}, ${p.status})`
    ).join(', ');
    subflowIcon.title = `Used as subflow in: ${tooltip}`;
    groupInfo.appendChild(subflowIcon);
  }

  header.appendChild(checkbox);
  header.appendChild(toggleArrow);
  header.appendChild(groupInfo);
  group.appendChild(header);

  // Version rows (collapsed by default)
  const versionsContainer = document.createElement('div');
  versionsContainer.className = 'versions-container';
  versionsContainer.style.display = 'none';

  for (const v of versions) {
    versionsContainer.appendChild(buildVersionRow(v, versions, group, depMap));
  }

  group.appendChild(versionsContainer);

  // Toggle expand/collapse on header click (not checkbox)
  header.addEventListener('click', (e) => {
    if (e.target === checkbox) return;
    const isOpen = versionsContainer.style.display !== 'none';
    versionsContainer.style.display = isOpen ? 'none' : '';
    toggleArrow.textContent = isOpen ? '▶' : '▼';
    header.classList.toggle('expanded', !isOpen);
  });

  return group;
}

function buildVersionRow(flow, allVersions, groupEl, depMap) {
  const row = document.createElement('div');
  row.className = 'version-row';
  row.dataset.id = flow.Id;

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'version-checkbox';
  checkbox.checked = selectedIds.has(flow.Id);

  checkbox.addEventListener('change', (e) => {
    if (e.target.checked) selectedIds.add(flow.Id);
    else selectedIds.delete(flow.Id);
    updateGroupCheckbox(groupEl, allVersions);
    updateActionBar();
    updateSelectionSummary();
  });

  const vNum = document.createElement('span');
  vNum.className = 'version-number';
  vNum.textContent = `v${flow.VersionNumber}`;

  const statusBadge = document.createElement('span');
  statusBadge.className = `status-badge status-${flow.Status.toLowerCase()}`;
  const dotChar = (flow.Status === 'Active' || flow.Status === 'Draft') ? '●' : '○';
  statusBadge.textContent = `${dotChar} ${flow.Status}`;

  const processType = document.createElement('span');
  processType.className = 'process-type';
  processType.textContent = humanProcessType(flow.ProcessType);

  row.appendChild(checkbox);
  row.appendChild(vNum);
  row.appendChild(statusBadge);
  row.appendChild(processType);

  // 🔗 icon if this specific version is called as a subflow
  if (depMap && (depMap[flow.ApiName] || []).length > 0) {
    const sfIcon = document.createElement('span');
    sfIcon.className = 'subflow-icon-small';
    sfIcon.textContent = '🔗';
    const parents = depMap[flow.ApiName] || [];
    sfIcon.title = `Used as subflow in: ${parents.map(p => `${p.masterLabel} (v${p.versionNumber}, ${p.status})`).join(', ')}`;
    row.appendChild(sfIcon);
  }

  return row;
}

function renderVersionCheckboxes(groupEl, versions) {
  const rows = groupEl.querySelectorAll('.version-row');
  rows.forEach(row => {
    const cb = row.querySelector('.version-checkbox');
    const id = row.dataset.id;
    if (cb) cb.checked = selectedIds.has(id);
  });
}

function updateGroupCheckbox(groupEl, versions) {
  const cb = groupEl.querySelector('.flow-group-checkbox');
  if (!cb) return;
  const allChecked = versions.every(v => selectedIds.has(v.Id));
  const someChecked = versions.some(v => selectedIds.has(v.Id));
  cb.checked = allChecked;
  cb.indeterminate = !allChecked && someChecked;
}

// ============================================================
// Toolbar Events
// ============================================================
function setupToolbarEvents() {
  if (toolbarEventsReady) return;  // prevent duplicate listeners on refresh
  toolbarEventsReady = true;

  document.getElementById('searchInput').addEventListener('input', () => {
    renderFlowList();
  });

  document.getElementById('refreshBtn').addEventListener('click', () => {
    loadFlows();
  });

  document.getElementById('selectAllBtn').addEventListener('click', () => {
    const search = document.getElementById('searchInput').value.toLowerCase().trim();
    for (const [label, versions] of Object.entries(flowGroups)) {
      if (search && !label.toLowerCase().includes(search)) continue;
      versions.forEach(v => selectedIds.add(v.Id));
    }
    renderFlowList();
    updateActionBar();
    updateSelectionSummary();
  });

  document.getElementById('deselectAllBtn').addEventListener('click', () => {
    selectedIds.clear();
    renderFlowList();
    updateActionBar();
    updateSelectionSummary();
  });

  document.getElementById('deleteBtn').addEventListener('click', onDeleteClick);
  document.getElementById('backupBtn').addEventListener('click', onBackupClick);
  document.getElementById('restoreActionBtn').addEventListener('click', onRestoreClick);

  const scanBtn = document.getElementById('scanSubflowBtn');
  if (scanBtn) {
    scanBtn.addEventListener('click', async () => {
      scanBtn.disabled = true;
      scanBtn.textContent = '🔍 Scanning...';
      showScanProgress(true, 'Scanning subflow dependencies...');
      await DependencyMap.buildDependencyMap(allFlows, orgUrl, sid, (done, total) => {
        showScanProgress(true, `🔍 Scanning for subflow dependencies… ${done}/${total}`);
      });
      metadataScanState = 'done';
      showScanProgress(false);
      scanBtn.textContent = '✅ Scan Complete';
      renderFlowList();
    });
  }

  // Listen for "select flow for deletion" event from dependency map context menu
  document.addEventListener('selectFlowForDeletion', (e) => {
    const flow = e.detail.flow;
    const label = flow.MasterLabel || flow.masterLabel;
    const versions = flowGroups[label] || [];
    versions.forEach(v => selectedIds.add(v.Id));
    renderFlowList();
    updateActionBar();
    updateSelectionSummary();
  });
}

// ============================================================
// Delete Flow
// ============================================================
async function onDeleteClick() {
  if (selectedIds.size === 0) return;

  const selected = allFlows.filter(f => selectedIds.has(f.Id));

  // Step 1: Active flow warning
  const activeFlows = selected.filter(f => f.Status === 'Active');
  if (activeFlows.length > 0) {
    const proceed = await showActiveWarningModal(activeFlows);
    if (!proceed) return;
  }

  // Step 2: Flow interview check
  const interviewProceed = await checkAndWarnInterviews(selected);
  if (!interviewProceed) return;

  // Step 3: Subflow dependency check
  const depProceed = await checkSubflowDependencies(selected);
  if (depProceed === null) return; // cancelled

  // The depProceed can be an array of extra flows to deactivate+delete
  const extraToDelete = Array.isArray(depProceed) ? depProceed : [];

  // Final deletion set
  const toDelete = [...selected];
  for (const extra of extraToDelete) {
    if (!toDelete.find(f => f.Id === extra.Id)) {
      toDelete.push(extra);
    }
  }

  // Step 4 (C4): ONE final summary confirm that names every version going
  // away and states the true stakes — flow-version deletes are PERMANENT
  // (Tooling deletes skip the Recycle Bin), so it requires the checkbox.
  const finalOk = await sftkConfirmDestructive({
    title: `Delete ${toDelete.length} flow version${toDelete.length !== 1 ? 's' : ''}`,
    items: toDelete.map(f => ({
      label: `${f.MasterLabel} v${f.VersionNumber}`,
      sub: f.Status === 'Active' ? 'Active' : (extraToDelete.includes(f) ? 'added for dependencies' : ''),
    })),
    reversibility: 'permanent',
    confirmLabel: `🗑 Delete ${toDelete.length}`,
    undoHint: 'Only flows you backed up (⬇) can come back — via Restore mode in this tab.',
  });
  if (!finalOk) return;

  // Start deletion
  await performDeletion(toDelete, extraToDelete);
}

async function checkAndWarnInterviews(selected) {
  const ids = selected.map(f => `'${f.Id}'`).join(',');
  try {
    const result = await sendBg({
      type: 'SF_REST_QUERY',
      orgUrl,
      sid,
      query: `SELECT Id, Name FROM FlowInterview WHERE FlowVersionViewId IN (${ids})`
    });
    if (result.error) {
      // Audit C7 finding: this used to fail OPEN silently — deletion went
      // ahead with no interview warning at all. Still proceed (the check is
      // best-effort), but SAY the check couldn't run.
      const cont = confirm('Could not check for paused flow interviews (' +
        result.error + ').\n\nPaused interviews on these flows would be deleted too. Continue anyway?');
      return cont;
    }
    const interviews = result.records || [];
    if (interviews.length === 0) return true;

    return new Promise((resolve) => {
      const nameList = interviews.slice(0, 10).map(i => `<li>${escHtml(i.Name)}</li>`).join('');
      const moreNote = interviews.length > 10 ? `<li>+ ${interviews.length - 10} more</li>` : '';
      showModal(`
        <div class="modal-header modal-warn">
          <span class="modal-icon">⚠️</span>
          <h2>Paused Flow Interviews Found</h2>
        </div>
        <div class="modal-body">
          <p><strong>${interviews.length} paused/waiting flow interview${interviews.length !== 1 ? 's' : ''}</strong> will also be permanently deleted.</p>
          <ul class="modal-list">${nameList}${moreNote}</ul>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="modalCancel">Cancel</button>
          <button class="btn btn-danger" id="modalConfirm">Delete interviews + flows</button>
        </div>
      `);
      document.getElementById('modalCancel').addEventListener('click', () => { closeModal(); resolve(false); });
      document.getElementById('modalConfirm').addEventListener('click', () => { closeModal(); resolve(true); });
    });
  } catch (e) {
    return true;
  }
}

async function checkSubflowDependencies(selected) {
  // If the background scan is still running, wait for it (up to 30 s)
  if (metadataScanState === 'scanning') {
    showScanProgress(true, '⏳ Waiting for dependency scan to complete…');
    let waited = 0;
    while (metadataScanState === 'scanning' && waited < 30000) {
      await wait(500);
      waited += 500;
    }
    showScanProgress(false);
  }

  const depMap = DependencyMap.getDependencyMap();
  const deletingIds = new Set(selected.map(f => f.Id));

  // Find flows being deleted that are called by flows NOT being deleted
  const problematic = [];
  for (const f of selected) {
    const parents = depMap[f.ApiName] || [];
    const outsideParents = parents.filter(p => !deletingIds.has(p.id));
    if (outsideParents.length > 0) {
      problematic.push({ flow: f, parents: outsideParents });
    }
  }

  if (problematic.length === 0) return [];

  return new Promise((resolve) => {
    showSubflowDependencyModal(problematic, allFlows, deletingIds, resolve);
  });
}

function showSubflowDependencyModal(problematic, allFlowsList, deletingIds, resolve) {
  let selectedParentIds = new Set();

  function buildTable(items, depth, extraDeletingIds) {
    let rows = '';
    for (const { flow, parents } of items) {
      for (const parent of parents) {
        const isActive = parent.status === 'Active';
        const indent = depth > 0 ? `style="padding-left:${depth * 20}px"` : '';
        rows += `
          <tr class="dep-table-row" data-parent-id="${escHtml(parent.id)}" ${indent}>
            <td>${escHtml(flow.MasterLabel)} <span class="version-number">v${flow.VersionNumber}</span></td>
            <td>
              ${escHtml(parent.masterLabel)} <span class="version-number">v${parent.versionNumber}</span>
              ${isActive ? '<span class="badge badge-danger">⚠️ ACTIVE</span>' : `<span class="badge status-badge status-${parent.status.toLowerCase()}">● ${parent.status}</span>`}
            </td>
            <td><input type="checkbox" class="parent-del-cb" data-id="${escHtml(parent.id)}" data-label="${escHtml(parent.masterLabel)}" data-api="${escHtml(parent.apiName || '')}"></td>
          </tr>
        `;
        if (depth < 3) {
          // Check grandparents
          const depMap = DependencyMap.getDependencyMap();
          const gpParents = (depMap[parent.apiName] || []).filter(gp =>
            !deletingIds.has(gp.id) && !extraDeletingIds.has(gp.id)
          );
          if (gpParents.length > 0) {
            const gpFlow = allFlowsList.find(f => f.Id === parent.id);
            if (gpFlow) {
              rows += buildTable([{ flow: gpFlow, parents: gpParents }], depth + 1, extraDeletingIds);
            }
          }
        } else {
          rows += `<tr><td colspan="3" class="dep-deep-warning">⚠️ Dependency chain deeper than 3 levels. Manual review recommended.</td></tr>`;
        }
      }
    }
    return rows;
  }

  function refreshModal() {
    const tableBody = document.getElementById('depTableBody');
    if (tableBody) {
      tableBody.innerHTML = buildTable(problematic, 0, selectedParentIds);
      attachCbListeners();
    }
    updateDeactivateBtn();
  }

  function attachCbListeners() {
    document.querySelectorAll('.parent-del-cb').forEach(cb => {
      cb.checked = selectedParentIds.has(cb.dataset.id);
      cb.addEventListener('change', () => {
        if (cb.checked) selectedParentIds.add(cb.dataset.id);
        else selectedParentIds.delete(cb.dataset.id);
        updateDeactivateBtn();
      });
    });
  }

  function updateDeactivateBtn() {
    const btn = document.getElementById('deactivateDeleteBtn');
    if (btn) btn.disabled = selectedParentIds.size === 0;
  }

  const tableRows = buildTable(problematic, 0, new Set());

  showModal(`
    <div class="modal-header modal-warn">
      <span class="modal-icon">🔗</span>
      <h2>Subflow Dependencies Detected</h2>
    </div>
    <div class="modal-body">
      <p>Some flows you are deleting are called as subflows by other flows. Deleting them will break those parent flows.</p>
      <div class="dep-table-controls">
        <label><input type="checkbox" id="selectAllParents"> Select all parent flows</label>
      </div>
      <div class="dep-table-wrap">
        <table class="dep-table">
          <thead>
            <tr>
              <th>Flow Being Deleted</th>
              <th>Called By (Parent Flow)</th>
              <th>Also Delete</th>
            </tr>
          </thead>
          <tbody id="depTableBody">
            ${tableRows}
          </tbody>
        </table>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" id="modalCancel">Cancel</button>
      <button class="btn btn-warning" id="proceedIgnoreBtn">Proceed anyway, ignore broken parents</button>
      <button class="btn btn-danger" id="deactivateDeleteBtn" disabled>Deactivate + delete selected parents</button>
    </div>
  `);

  attachCbListeners();

  document.getElementById('selectAllParents').addEventListener('change', (e) => {
    document.querySelectorAll('.parent-del-cb').forEach(cb => {
      cb.checked = e.target.checked;
      if (e.target.checked) selectedParentIds.add(cb.dataset.id);
      else selectedParentIds.delete(cb.dataset.id);
    });
    updateDeactivateBtn();
  });

  document.getElementById('modalCancel').addEventListener('click', () => {
    closeModal();
    resolve(null);
  });

  document.getElementById('proceedIgnoreBtn').addEventListener('click', () => {
    closeModal();
    resolve([]);
  });

  document.getElementById('deactivateDeleteBtn').addEventListener('click', () => {
    closeModal();
    // Gather parent flows to deactivate + delete
    const extraFlows = allFlowsList.filter(f => selectedParentIds.has(f.Id));
    resolve(extraFlows);
  });
}

// ============================================================
// Active Flow Warning Modal (with Backup option)
// ============================================================
async function showActiveWarningModal(activeFlows) {
  return new Promise((resolve) => {
    const rows = activeFlows.map((f, i) =>
      `<li class="backup-row">
        <span>${escHtml(f.MasterLabel)} — v${f.VersionNumber}</span>
        <button class="btn btn-secondary btn-sm backup-one-btn" data-idx="${i}" title="Download backup JSON">⬇ Backup</button>
      </li>`
    ).join('');

    showModal(`
      <div class="modal-header modal-danger">
        <span class="modal-icon">⚠️</span>
        <h2>You are about to delete ACTIVE flows</h2>
      </div>
      <div class="modal-body">
        <p style="margin-bottom:8px;font-size:12px">Optionally download a backup before deleting:</p>
        <ul class="modal-list backup-list">${rows}</ul>
        <button class="btn btn-secondary btn-sm" id="backupAllBtn" style="margin:6px 0 10px">⬇ Download All Backups</button>
        <p class="modal-warning-text">Deleting active flows may break automations, processes, or user-facing screens that depend on them. This action cannot be undone.</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="modalCancel">Cancel</button>
        <button class="btn btn-danger" id="modalConfirm">I understand, delete anyway</button>
      </div>
    `);

    // Individual backup buttons
    document.querySelectorAll('.backup-one-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const f = activeFlows[parseInt(btn.dataset.idx)];
        btn.textContent = '⏳';
        btn.disabled = true;
        try {
          await downloadFlowBackup(f);
          btn.textContent = '✅';
        } catch (e) {
          btn.textContent = '❌';
          btn.title = e.message;
        }
      });
    });

    // Download all
    document.getElementById('backupAllBtn').addEventListener('click', async () => {
      const allBtn = document.getElementById('backupAllBtn');
      allBtn.textContent = '⏳ Downloading...';
      allBtn.disabled = true;
      for (const f of activeFlows) {
        try { await downloadFlowBackup(f); } catch (_) {}
      }
      allBtn.textContent = '✅ All Downloaded';
    });

    document.getElementById('modalCancel').addEventListener('click', () => { closeModal(); resolve(false); });
    document.getElementById('modalConfirm').addEventListener('click', () => { closeModal(); resolve(true); });
  });
}

// ============================================================
// Backup — download flow metadata as JSON
// ============================================================
async function downloadFlowBackup(flow) {
  const result = await sendBg({ type: 'SF_GET_METADATA', orgUrl, sid, id: flow.Id });
  if (result.error) throw new Error(result.error);

  const backup = {
    _info: 'Salesforce Toolkit flow backup — restore via the 📥 Restore button',
    backupDate: new Date().toISOString(),
    orgUrl,
    flow: {
      MasterLabel: flow.MasterLabel,
      ApiName: flow.ApiName,
      VersionNumber: flow.VersionNumber,
      Status: flow.Status,
      ProcessType: flow.ProcessType,
      FullName: result.FullName,
      Metadata: result.Metadata
    }
  };

  const json = JSON.stringify(backup, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safeName = (flow.MasterLabel || 'Flow').replace(/[^a-zA-Z0-9_-]/g, '_');
  a.download = `${safeName}_v${flow.VersionNumber}_backup.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================================
// Mode Toggle — Delete / Backup / Restore
// ============================================================
function setupModeToggle() {
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode));
  });

  // Drop-zone click → open file picker
  const dropZone = document.getElementById('restoreDropZone');
  dropZone.addEventListener('click', () => document.getElementById('restoreFileInput').click());

  // Drag & drop
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drop-hover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drop-hover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drop-hover');
    const file = e.dataTransfer.files[0];
    if (file) handleRestoreFile(file);
  });

  // File input change
  document.getElementById('restoreFileInput').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) handleRestoreFile(file);
  });
}

function switchMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));

  const isRestore = mode === 'restore';

  // Select / deselect only relevant in delete & backup modes
  document.getElementById('selectAllBtn').style.display   = isRestore ? 'none' : '';
  document.getElementById('deselectAllBtn').style.display = isRestore ? 'none' : '';

  if (isRestore) {
    // Hide the flow list; show the restore panel
    document.getElementById('flowList').style.display    = 'none';
    document.getElementById('emptyState').style.display  = 'none';
    document.getElementById('scanProgress').style.display = 'none';
    document.getElementById('restorePanel').style.display = '';
    document.getElementById('selectionSummary').textContent = 'Select flows to restore';
  } else {
    document.getElementById('restorePanel').style.display = 'none';
    renderFlowList();         // re-show the appropriate list / empty state
    updateSelectionSummary();
  }

  updateActionBar();
}

// ============================================================
// Backup — download selected versions as a bundle JSON
// ============================================================
async function onBackupClick() {
  const selected = allFlows.filter(f => selectedIds.has(f.Id));
  if (selected.length === 0) return;

  const btn = document.getElementById('backupBtn');
  btn.disabled = true;

  showScanProgress(true, `⬇ Fetching metadata… 0 / ${selected.length}`);

  const flows = [];
  let done = 0;
  for (const flow of selected) {
    showScanProgress(true, `⬇ Fetching metadata… ${done} / ${selected.length}`);
    try {
      const result = await sendBg({ type: 'SF_GET_METADATA', orgUrl, sid, id: flow.Id });
      if (!result.error && result.Metadata) {
        flows.push({
          MasterLabel:   flow.MasterLabel,
          ApiName:       flow.ApiName,
          VersionNumber: flow.VersionNumber,
          Status:        flow.Status,
          ProcessType:   flow.ProcessType,
          FullName:      result.FullName,
          Metadata:      result.Metadata
        });
      }
    } catch (_) {}
    done++;
  }

  showScanProgress(false);
  btn.disabled = false;
  updateActionBar();

  if (flows.length === 0) {
    showModal(`
      <div class="modal-header modal-danger">
        <span class="modal-icon">❌</span><h2>Backup Failed</h2>
      </div>
      <div class="modal-body"><p>Could not fetch metadata for any of the selected flows.</p></div>
      <div class="modal-footer"><button class="btn btn-secondary" id="modalCancel">Close</button></div>
    `);
    document.getElementById('modalCancel').addEventListener('click', closeModal);
    return;
  }

  const bundle = {
    _info: 'Salesforce Toolkit flow backup bundle — restore via the 📥 Restore mode',
    backupDate: new Date().toISOString(),
    orgUrl,
    version: 2,
    flows
  };

  const json  = JSON.stringify(bundle, null, 2);
  const blob  = new Blob([json], { type: 'application/json' });
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement('a');
  a.href      = url;
  const date  = new Date().toISOString().slice(0, 10);
  a.download  = `SF_Backup_${date}_${flows.length}flow${flows.length !== 1 ? 's' : ''}.json`;
  a.click();
  URL.revokeObjectURL(url);

  // Brief success toast
  const list = document.getElementById('flowList');
  const toast = document.createElement('div');
  toast.className = 'result-toast';
  toast.innerHTML = `<div class="toast-success">✅ Backed up ${flows.length} flow version${flows.length !== 1 ? 's' : ''} — file downloaded.</div>`;
  list.insertBefore(toast, list.firstChild);
  setTimeout(() => toast.remove(), 6000);
}

// ============================================================
// Restore panel — load & preview a backup file
// ============================================================
async function handleRestoreFile(file) {
  let backup;
  try {
    const text = await file.text();
    backup = JSON.parse(text);
  } catch (_) {
    showRestorePanelError('Invalid file — could not parse JSON.');
    return;
  }

  // Normalise to an array of flow objects
  let flows = [];
  if (Array.isArray(backup.flows) && backup.flows.length > 0) {
    flows = backup.flows;                       // new bundle format
  } else if (backup.flow && backup.flow.Metadata) {
    flows = [backup.flow];                      // legacy single-flow format
  } else {
    showRestorePanelError('This file does not look like a Salesforce Toolkit backup.');
    return;
  }

  restoreBackupFlows = flows;
  restoreSelected    = new Set(flows.map((_, i) => i));  // all selected by default
  renderRestorePreview(backup, flows);
}

function renderRestorePreview(backup, flows) {
  document.getElementById('restoreDropZone').style.display = 'none';

  const date   = backup.backupDate ? new Date(backup.backupDate).toLocaleDateString() : 'Unknown date';
  const isBundle = Array.isArray(backup.flows);

  let itemsHtml = '';
  for (let i = 0; i < flows.length; i++) {
    const f = flows[i];
    const statusCls = f.Status === 'Active' ? 'badge-active' : f.Status === 'Draft' ? 'badge-draft' : 'badge-obsolete';
    itemsHtml += `
      <label class="restore-flow-item">
        <input type="checkbox" class="restore-flow-cb" data-idx="${i}" checked>
        <div class="restore-flow-item-info">
          <span class="restore-flow-name">${escHtml(f.MasterLabel)}</span>
          <span class="restore-flow-meta">
            v${f.VersionNumber}
            <span class="badge ${statusCls}">${escHtml(f.Status)}</span>
            <span class="restore-api-name">${escHtml(f.ApiName || '')}</span>
          </span>
        </div>
      </label>`;
  }

  const preview = document.getElementById('restorePreview');
  preview.innerHTML = `
    <div class="restore-preview-header">
      <div class="restore-preview-title">
        ${isBundle ? '📦' : '📄'}
        <strong>${flows.length} flow${flows.length !== 1 ? 's' : ''}</strong>
        <span class="restore-preview-date">· backed up ${escHtml(date)}</span>
      </div>
      <button class="btn btn-secondary btn-sm" id="restoreClearBtn">✕ Clear</button>
    </div>
    <div class="restore-select-bar">
      <label class="restore-select-all-wrap">
        <input type="checkbox" id="restoreSelectAll" checked>
        <span>Select all</span>
      </label>
      <span class="restore-item-count">${flows.length} flow${flows.length !== 1 ? 's' : ''}</span>
    </div>
    <div class="restore-flow-items">${itemsHtml}</div>
  `;
  preview.style.display = '';

  // Wire events
  document.getElementById('restoreClearBtn').addEventListener('click', clearRestorePanel);

  const selectAllCb = document.getElementById('restoreSelectAll');
  selectAllCb.addEventListener('change', () => {
    restoreSelected.clear();
    if (selectAllCb.checked) flows.forEach((_, i) => restoreSelected.add(i));
    document.querySelectorAll('.restore-flow-cb').forEach(cb => cb.checked = selectAllCb.checked);
    updateActionBar();
  });

  document.querySelectorAll('.restore-flow-cb').forEach(cb => {
    const idx = parseInt(cb.dataset.idx);
    cb.addEventListener('change', () => {
      if (cb.checked) restoreSelected.add(idx);
      else            restoreSelected.delete(idx);
      const all = restoreSelected.size === flows.length;
      const any = restoreSelected.size > 0;
      selectAllCb.checked       = all;
      selectAllCb.indeterminate = !all && any;
      updateActionBar();
    });
  });

  updateActionBar();
}

function clearRestorePanel() {
  restoreBackupFlows = [];
  restoreSelected.clear();
  document.getElementById('restoreDropZone').style.display = '';
  const preview = document.getElementById('restorePreview');
  preview.style.display = 'none';
  preview.innerHTML     = '';
  updateActionBar();
}

function showRestorePanelError(msg) {
  const dropZone = document.getElementById('restoreDropZone');
  // Remove any previous error
  dropZone.querySelectorAll('.restore-drop-error').forEach(e => e.remove());
  const err = document.createElement('div');
  err.className = 'restore-drop-error';
  err.textContent = `❌ ${msg}`;
  dropZone.appendChild(err);
}

async function onRestoreClick() {
  const toRestore = [...restoreSelected].map(i => restoreBackupFlows[i]).filter(Boolean);
  if (toRestore.length === 0) return;

  const btn = document.getElementById('restoreActionBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Restoring…';

  const errors    = [];
  const successes = [];
  for (const f of toRestore) {
    if (!f.Metadata || !f.FullName) {
      errors.push(`${f.MasterLabel}: missing metadata in backup`);
      continue;
    }
    try {
      await performRestore({ flow: f });
      successes.push(f);
    } catch (e) {
      errors.push(`${escHtml(f.MasterLabel)}: ${escHtml(e.message || String(e))}`);
    }
  }

  updateActionBar();

  if (errors.length === 0) {
    showModal(`
      <div class="modal-header" style="color:var(--active-color)">
        <span class="modal-icon">✅</span>
        <h2>${successes.length} Flow${successes.length !== 1 ? 's' : ''} Restored</h2>
      </div>
      <div class="modal-body">
        <ul class="modal-list">
          ${successes.map(f => `<li>${escHtml(f.MasterLabel)} v${f.VersionNumber} → new Draft</li>`).join('')}
        </ul>
        <p style="margin-top:8px;font-size:11px;color:var(--subtext)">
          Open Flow Builder to review and activate the restored flows.
        </p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="modalCancel">Close</button>
      </div>
    `);
    document.getElementById('modalCancel').addEventListener('click', () => {
      closeModal();
      switchMode('delete');
      loadFlows();
    });
  } else {
    const errHtml  = errors.map(e => `<li style="word-break:break-word">${escHtml(e)}</li>`).join('');
    const okHtml   = successes.map(f => `<li>${escHtml(f.MasterLabel)} v${f.VersionNumber}</li>`).join('');
    showModal(`
      <div class="modal-header modal-warn">
        <span class="modal-icon">⚠️</span>
        <h2>${successes.length} restored, ${errors.length} failed</h2>
      </div>
      <div class="modal-body">
        ${successes.length > 0 ? `<p style="margin-bottom:4px;font-weight:700">Restored:</p><ul class="modal-list">${okHtml}</ul>` : ''}
        <p style="margin:8px 0 4px;font-weight:700;color:var(--danger)">Failed:</p>
        <ul class="modal-list">${errHtml}</ul>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="modalCancel">Close</button>
      </div>
    `);
    document.getElementById('modalCancel').addEventListener('click', () => { closeModal(); if (successes.length > 0) loadFlows(); });
  }
}

// ============================================================
// performRestore — create a new Draft from a backup flow object
// ============================================================
async function performRestore(backup) {
  const f = backup.flow;
  const fullName = f.ApiName || f.FullName.replace(/-\d+$/, '');

  // Deploy via the Metadata API (new Draft version) rather than the Tooling
  // `Flow` create. The Tooling create rejects record-triggered flows with
  // "fullName … for Flow version is not unique"; the Metadata zip-deploy adds
  // a new version for every flow type. Helper lives in field-cleaner.js (same
  // popup page) so the proven flow serializer isn't duplicated.
  if (typeof window.sftkDeployFlowMetadata !== 'function') {
    throw new Error('Flow deploy helper unavailable — reload the extension and try again.');
  }
  const result = await window.sftkDeployFlowMetadata(orgUrl, sid, fullName, f.Metadata, 'Draft');

  if (result?.error)    throw new Error(result.error);
  if (!result?.success) throw new Error('Deploy did not report success.');
  return result;
}

// ============================================================
// Deactivation
// ============================================================
async function deactivateFlow(flow) {
  const defId = flow.DefinitionId;
  if (!defId) throw new Error(`No DefinitionId on flow "${flow.MasterLabel}" — cannot deactivate`);

  // Tooling API FlowDefinition requires a Metadata wrapper — activeVersionNumber 0 = deactivate
  const patchResult = await sendBg({
    type: 'SF_PATCH',
    orgUrl,
    sid,
    path: `services/data/v62.0/tooling/sobjects/FlowDefinition/${defId}`,
    body: { Metadata: { activeVersionNumber: 0 } }
  });
  if (patchResult.error) throw new Error(`Deactivation failed for "${flow.MasterLabel}": ${patchResult.error}`);
}

async function deleteOneFlow(flow, done, total) {
  const doDelete = async () => {
    const r = await sendBg({ type: 'SF_TOOLING_DELETE', orgUrl, sid, sobject: 'Flow', id: flow.Id });
    if (r.error) throw new Error(r.error);
  };

  if (flow.Status !== 'Active') {
    await doDelete();
    return;
  }

  // Step 1: try direct delete (Tooling API sometimes allows it)
  try {
    await doDelete();
    return;
  } catch (_) {}

  // Step 2: deactivate via FlowDefinition, then retry
  updateProgressBar(done, total, `Deactivating: ${flow.MasterLabel} v${flow.VersionNumber}...`);
  await deactivateFlow(flow);
  await wait(800);

  updateProgressBar(done, total, `Deleting: ${flow.MasterLabel} v${flow.VersionNumber}...`);
  await doDelete(); // throws if still fails — caller captures error
}

// ============================================================
// Deletion
// ============================================================
async function performDeletion(toDelete, toDeactivate) {
  const total = toDelete.length;
  let deleted = 0;
  const errors = [];
  const successes = [];

  showProgressPanel(true);
  const statusMessages = [...STATUS_MESSAGES];
  let msgIdx = 0;
  const msgInterval = setInterval(() => {
    msgIdx = (msgIdx + 1) % statusMessages.length;
    const el = document.getElementById('progressStatus');
    if (el) el.textContent = statusMessages[msgIdx];
  }, 1500);

  for (const flow of toDelete) {
    updateProgressBar(deleted, total, `Deleting: ${flow.MasterLabel} v${flow.VersionNumber}...`);

    try {
      await deleteOneFlow(flow, deleted, total);
      deleted++;
      successes.push(flow);
      selectedIds.delete(flow.Id);
    } catch (e) {
      const msg = e.message || String(e);
      if (msg.includes('CANNOT_DELETE_MANAGED_COMPONENT')) {
        errors.push({ flow, msg: `"${flow.MasterLabel}" is part of a managed package and cannot be deleted.` });
      } else {
        errors.push({ flow, msg: `${flow.MasterLabel} v${flow.VersionNumber}: ${msg}` });
      }
    }
  }

  clearInterval(msgInterval);

  // Victory animation
  const robot = document.getElementById('robot');
  if (robot) robot.classList.add('robot-victory');

  const statusEl = document.getElementById('progressStatus');
  if (statusEl) statusEl.textContent = '✅ All done! Kitty needs a nap.';

  updateProgressBar(deleted, total, '');
  const fillEl = document.getElementById('progressFill');
  if (fillEl) { fillEl.style.width = '100%'; fillEl.style.background = '#2ecc71'; }

  await wait(2000);

  showProgressPanel(false);

  // Remove deleted flows from allFlows
  const deletedIds = new Set(successes.map(f => f.Id));
  allFlows = allFlows.filter(f => !deletedIds.has(f.Id));
  groupFlows();

  // Show result toast
  showResultToast(successes.length, errors);

  renderFlowList();
  updateActionBar();
  updateSelectionSummary();
}

// ============================================================
// Progress Panel
// ============================================================
function showProgressPanel(show) {
  const panel = document.getElementById('progressPanel');
  const deleteArea = document.getElementById('deleteArea');
  const selSummary = document.getElementById('selectionSummary');
  if (show) {
    panel.style.display = '';
    deleteArea.style.display = 'none';
    selSummary.style.display = 'none';
    // Reset robot
    const robot = document.getElementById('robot');
    if (robot) robot.classList.remove('robot-victory');
  } else {
    panel.style.display = 'none';
    deleteArea.style.display = '';
    selSummary.style.display = '';
  }
}

function updateProgressBar(done, total, itemLabel) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const fill = document.getElementById('progressFill');
  const text = document.getElementById('progressText');
  const current = document.getElementById('progressCurrentItem');
  if (fill) fill.style.width = pct + '%';
  if (text) text.textContent = `${done} / ${total} deleted`;
  if (current) current.textContent = itemLabel;
}

// ============================================================
// Result Toast
// ============================================================
function showResultToast(successCount, errors) {
  // Show errors in a modal so they can't be missed
  if (errors.length > 0) {
    const errorList = errors.map(e => `<li style="margin-bottom:6px">${escHtml(e.msg)}</li>`).join('');
    showModal(`
      <div class="modal-header modal-warn">
        <span class="modal-icon">⚠️</span>
        <h2>${successCount} deleted, ${errors.length} failed</h2>
      </div>
      <div class="modal-body">
        <p style="margin-bottom:8px">The following could not be deleted:</p>
        <ul class="modal-list" style="font-size:11px;word-break:break-word">${errorList}</ul>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="modalCancel">Close</button>
      </div>
    `);
    document.getElementById('modalCancel').addEventListener('click', closeModal);
    return;
  }

  // Success-only toast
  const list = document.getElementById('flowList');
  const toast = document.createElement('div');
  toast.className = 'result-toast';
  // C4: the undo path travels WITH the success message — backed-up flows can
  // come back via Restore mode; everything else is gone for good.
  toast.innerHTML = `<div class="toast-success">✅ ${successCount} flow version${successCount !== 1 ? 's' : ''} deleted successfully.
    <span class="toast-undo-hint">↩ Backed-up flows can be restored via <a href="#" id="toastRestoreLink">Restore mode</a>.</span></div>`;
  list.insertBefore(toast, list.firstChild);
  toast.querySelector('#toastRestoreLink')?.addEventListener('click', e => {
    e.preventDefault();
    if (typeof switchMode === 'function') switchMode('restore');
  });
  setTimeout(() => toast.remove(), 12000);
}

// ============================================================
// Update UI helpers
// ============================================================
function updateActionBar() {
  const count = selectedIds.size;
  const deleteBtn      = document.getElementById('deleteBtn');
  const backupBtn      = document.getElementById('backupBtn');
  const restoreActBtn  = document.getElementById('restoreActionBtn');

  deleteBtn.style.display     = currentMode === 'delete'  ? '' : 'none';
  backupBtn.style.display     = currentMode === 'backup'  ? '' : 'none';
  restoreActBtn.style.display = currentMode === 'restore' ? '' : 'none';

  if (currentMode === 'delete') {
    deleteBtn.disabled    = count === 0;
    deleteBtn.textContent = `🗑 Delete Selected (${count})`;
  } else if (currentMode === 'backup') {
    backupBtn.disabled    = count === 0;
    backupBtn.textContent = `⬇ Backup Selected (${count})`;
  } else {
    const rCount = restoreSelected.size;
    restoreActBtn.disabled    = rCount === 0;
    restoreActBtn.textContent = `📥 Restore Selected (${rCount}) as Draft`;
  }
}

function updateSelectionSummary() {
  if (currentMode === 'restore') return; // restore mode sets its own summary text
  const el = document.getElementById('selectionSummary');
  const count = selectedIds.size;
  if (count === 0) { el.textContent = 'Nothing selected'; return; }

  const selectedFlows = allFlows.filter(f => selectedIds.has(f.Id));
  const uniqueLabels = new Set(selectedFlows.map(f => f.MasterLabel));
  const activeCount = selectedFlows.filter(f => f.Status === 'Active').length;

  let text = `${count} version${count !== 1 ? 's' : ''} selected across ${uniqueLabels.size} flow${uniqueLabels.size !== 1 ? 's' : ''}`;
  if (activeCount > 0) {
    text += `  (${activeCount} active ⚠️)`;
    el.className = 'selection-summary selection-warn';
  } else {
    el.className = 'selection-summary';
  }
  el.textContent = text;
}

// ============================================================
// Lightning Pages Tab
// ============================================================
function initLightningPagesTab() {
  LightningPages.updateSession(orgUrl, sid);
  const container = document.getElementById('lpContainer');
  if (!container._lpInitialized) {
    LightningPages.init(container, orgUrl, sid);
    container._lpInitialized = true;
  }
}

// ============================================================
// Automation Debugger Tab
// ============================================================
function initDebuggerTab() {
  ApexDebugger.updateSession(orgUrl, sid);
  const container = document.getElementById('debuggerContainer');
  if (!container._adbgInitialized) {
    ApexDebugger.init(container, orgUrl, sid);
    container._adbgInitialized = true;
  }
}

// ============================================================
// Fields Tab
// ============================================================
function initFieldCleanerTab() {
  FieldCleaner.updateSession(orgUrl, sid);
  const container = document.getElementById('fieldCleanerContainer');
  if (!container._fcInitialized) {
    FieldCleaner.init(container, orgUrl, sid);
    container._fcInitialized = true;
  }
}

// ============================================================
// Records Tab (Copy Record cross-org) — REMOVED
// ============================================================
// Record Copy was migrated to Data Studio (multi-org transfer with full
// Profile Builder). The popup-side tab + init wiring left behind was
// unreachable: no #recordCopyContainer in popup.html, no sidebar button,
// and `record-copy.js` is no longer loaded in the popup. Removed to keep
// the tab-init map honest.

// Users — Copy Perms tab
// ============================================================
function initUserCopyTab() {
  UserCopy.updateSession(orgUrl, sid);
  const container = document.getElementById('userCopyContainer');
  if (!container._ucInitialized) {
    UserCopy.init(container, orgUrl, sid);
    container._ucInitialized = true;
  }
}

// Users — Licenses tab
// ============================================================
function initLicenseManagerTab() {
  LicenseManager.updateSession(orgUrl, sid);
  const container = document.getElementById('licenseManagerContainer');
  if (!container._lmInitialized) {
    LicenseManager.init(container, orgUrl, sid);
    container._lmInitialized = true;
  }
}

// Users — Flow Access tab
// ============================================================
function initFlowAccessTab() {
  FlowPermissions.updateSession(orgUrl, sid);
  const container = document.getElementById('flowPermsContainer');
  if (!container._fpInitialized) {
    FlowPermissions.init(container, orgUrl, sid);
    container._fpInitialized = true;
  }
}

// ============================================================
// Dependencies Tab
// ============================================================
function renderDependenciesTab() {
  const container = document.getElementById('depTreeContainer');
  const noBanner  = document.getElementById('depNoDataBanner');

  // Flows haven't been fetched yet — kick off the load automatically so the
  // user never has to visit the Flows tab first.
  if (!_flowsLoaded) {
    noBanner.style.display = 'none';
    container.innerHTML = sftkCat('Loading flows & dependency map…');
    loadFlowsIfNeeded();   // loadFlows() calls renderDependenciesTab() on completion
    return;
  }

  // Flows fetch in-flight (loadFlows called but not done yet)
  if (allFlows.length === 0 && metadataScanState !== 'done') {
    noBanner.style.display = 'none';
    container.innerHTML = sftkCat('Loading flows & dependency map…');
    return;
  }

  if (metadataScanState === 'scanning') {
    noBanner.style.display = '';
    noBanner.textContent = '⏳ Dependency map is building… This tab will refresh automatically when ready.';
    container.innerHTML = '';
    return;
  }

  if (!DependencyMap.isMetadataFetched()) {
    noBanner.style.display = '';
    noBanner.textContent = '⏳ Waiting for dependency metadata… This tab will refresh automatically.';
    container.innerHTML = '';
    return;
  }

  noBanner.style.display = 'none';
  DependencyMap.renderDependencyTreeTab(allFlows, container, orgUrl);
}

// ============================================================
// Modal helpers
// ============================================================
function showModal(html) {
  const overlay = document.getElementById('modalOverlay');
  const box = document.getElementById('modalBox');
  box.innerHTML = html;
  overlay.style.display = '';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  }, { once: true });
}

function closeModal() {
  const box = document.getElementById('modalBox');
  box.style.width = ''; // reset any per-modal width override (e.g. debug panel)
  box.innerHTML = '';
  document.getElementById('modalOverlay').style.display = 'none';
}

// ============================================================
// Error / loading helpers
// ============================================================
function showLoading(show) {
  document.getElementById('loadingState').style.display = show ? '' : 'none';
  if (show) {
    document.getElementById('flowList').style.display = 'none';
    document.getElementById('emptyState').style.display = 'none';
  }
}

function showScanProgress(show, text) {
  const el = document.getElementById('scanProgress');
  if (show) {
    el.style.display = '';
    const textEl = document.getElementById('scanProgressText');
    if (textEl && text) textEl.textContent = text;
  } else {
    el.style.display = 'none';
  }
}

function showSessionError(msg) {
  document.getElementById('sessionErrorMsg').textContent = msg;
  document.getElementById('sessionError').style.display = '';
  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('toolbar').style.display = 'none';
  document.getElementById('flowList').style.display = 'none';
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('selectionSummary').style.display = 'none';
  document.getElementById('deleteArea').style.display = 'none';

  document.getElementById('retryBtn').onclick = () => {
    document.getElementById('sessionError').style.display = 'none';
    _flowsLoaded = false; // allow flows to re-load if user navigates there after retry
    initSession();
  };

  document.getElementById('reloadExtBtn').onclick = () => {
    // Reload the entire extension (service worker + popup) — equivalent to
    // clicking the reload icon in chrome://extensions/ but without leaving the page.
    chrome.runtime.reload();
  };

  document.getElementById('connectOrgBtn').onclick = async () => {
    // Manual org connect — lets the user specify the org URL directly,
    // bypassing the auto-detection (tab scanning + cookie lookup) entirely.
    // Useful when the wrong org is being detected, or when the active tab is
    // on a login page instead of the org itself.
    let raw = (document.getElementById('orgUrlInput').value || '').trim();
    if (!raw) { document.getElementById('orgUrlInput').focus(); return; }

    try {
      if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
      const u = new URL(raw);
      let h = u.hostname;
      // Normalise lightning.force.com → my.salesforce.com (API origin)
      if (h.includes('.lightning.force.com')) {
        h = h.replace('.lightning.force.com', '.my.salesforce.com');
      }
      const targetOrgUrl = `https://${h}`;

      // Look for a sid cookie scoped to this org
      const cookies = await chrome.cookies.getAll({ url: targetOrgUrl, name: 'sid' });
      if (!cookies.length) {
        document.getElementById('sessionErrorMsg').textContent =
          `No active session found for ${h} — log into that org first, then click Connect.`;
        return;
      }
      // Longest domain = most specific = this org's own session (not a shared parent)
      cookies.sort((a, b) => b.domain.length - a.domain.length);

      orgUrl = targetOrgUrl;
      sid    = cookies[0].value;
      document.getElementById('sessionError').style.display = 'none';
      renderHomePage();
    } catch (_) {
      document.getElementById('sessionErrorMsg').textContent =
        'Invalid URL — paste something like https://myorg.my.salesforce.com or https://myorg.lightning.force.com';
    }
  };
}

function handleApiError(errMsg) {
  showLoading(false);
  if (errMsg === 'SESSION_EXPIRED') {
    // The Salesforce session cookie is expired server-side.
    // initSession('expired') will NOT reconnect with the same dead cookie —
    // it waits until the browser picks up a genuinely new sid (i.e. the user
    // navigates their SF tab and Salesforce issues a fresh session cookie).
    _flowsLoaded = false;
    initSession('expired');
  } else {
    showSessionError(`API Error: ${errMsg}`);
  }
}

// ============================================================
// ============================================================
// Debug Mode — initDebugMode() and openDebugModal() live in
// debug-modal.js (shared with studio.html).  Nothing to define here.

// ============================================================
// Activity Bar — live progress strip at the bottom of the popup
// ============================================================
function initActivityBar() {
  const bar      = document.getElementById('activityBar');
  const line     = document.getElementById('actProgressLine');
  const dot      = document.getElementById('actDot');
  const msgEl    = document.getElementById('actMsg');
  const countEl  = document.getElementById('actCount');
  const durEl    = document.getElementById('actDur');
  if (!bar || !window.sftkActivity) return;

  let _clearTimer = null;

  function update() {
    const act     = window.sftkActivity;
    const n       = act.inFlight;
    const last    = act.last;
    const items   = act.items;

    // ── In-flight calls active ─────────────────────────────
    if (n > 0) {
      clearTimeout(_clearTimer);

      // Show indeterminate progress line
      line.style.display = '';
      line.classList.add('act-line-active');

      // Show the most recently started call description
      const latestDesc = items[items.length - 1]?.desc || 'Working…';
      dot.className = 'act-dot act-dot-active';
      msgEl.textContent = latestDesc + '…';

      if (n > 1) {
        countEl.textContent = n + ' calls';
        countEl.style.display = '';
      } else {
        countEl.style.display = 'none';
      }
      durEl.style.display = 'none';
      return;
    }

    // ── All calls done ─────────────────────────────────────
    line.classList.remove('act-line-active');
    line.style.display = 'none';
    countEl.style.display = 'none';

    if (last) {
      if (last.isError) {
        dot.className = 'act-dot act-dot-error';
        msgEl.textContent = '❌ ' + last.desc + ' failed';
      } else {
        dot.className = 'act-dot act-dot-ok';
        msgEl.textContent = last.desc;
      }
      if (last.dur != null) {
        durEl.textContent = last.dur >= 1000
          ? (last.dur / 1000).toFixed(1) + 's'
          : last.dur + 'ms';
        durEl.style.display = '';
      }

      // Auto-clear to "Ready" after 4s
      clearTimeout(_clearTimer);
      _clearTimer = setTimeout(() => {
        dot.className  = 'act-dot act-dot-idle';
        msgEl.textContent = 'Ready';
        durEl.style.display = 'none';
      }, 4000);
    }
  }

  window._sftkActCb = update;
  update();
}

// openDebugModal is defined in debug-modal.js (loaded before popup.js).
// Nothing to declare here — window.openDebugModal is already set.
// The old implementation below is kept as a dead-code fallback only.
function _openDebugModal_legacy() {
  const D = window.SFToolkitDebug;
  if (!D) return;

  // ── Filter state ──────────────────────────────────────────
  let filterMod   = 'all';   // 'all' | any module tag
  let filterLevel = 'all';   // 'all' | 'api' | 'error' | 'warn' | 'session' | 'info'
  let filterText  = '';      // keyword search
  let autoScroll  = true;

  // ── Helpers ───────────────────────────────────────────────
  function entryClass(level) {
    switch (level) {
      case 'error':   return 'dbg-entry-error';
      case 'warn':    return 'dbg-entry-warn';
      case 'session': return 'dbg-entry-session';
      case 'api':     return 'dbg-entry-api';
      default:        return 'dbg-entry-info';
    }
  }

  function fmtDur(ms) {
    if (ms === null || ms === undefined) return '';
    const cls = ms >= 5000 ? 'dur-vslow' : ms >= 2000 ? 'dur-slow' : '';
    return `<span class="dbg-e-dur ${cls}">${ms >= 1000 ? (ms/1000).toFixed(1)+'s' : ms+'ms'}</span>`;
  }

  function filteredEntries() {
    return D.entries.filter(e => {
      if (filterMod   !== 'all' && e.mod   !== filterMod)   return false;
      if (filterLevel !== 'all' && e.level !== filterLevel)  return false;
      if (filterText) {
        const hay = (e.msg + ' ' + (e.data || '') + ' ' + e.mod).toLowerCase();
        if (!hay.includes(filterText.toLowerCase())) return false;
      }
      return true;
    });
  }

  function getModules() {
    const mods = [...new Set(D.entries.map(e => e.mod))].sort();
    return mods;
  }

  function renderFilterBar() {
    const mods   = getModules();
    const levels = ['api', 'error', 'warn', 'session', 'info'];
    const total    = D.entries.length;
    const showing  = filteredEntries().length;

    // Module pills
    const modPills = ['all', ...mods].map(m =>
      `<button class="dbg-filter-pill${filterMod === m ? ' dbg-pill-active' : ''}"
               data-modfilter="${escHtml(m)}">${m === 'all' ? 'All Mods' : escHtml(m)}</button>`
    ).join('');

    // Level pills
    const lvlPills = ['all', ...levels].map(l =>
      `<button class="dbg-filter-pill dbg-pill-${l}${filterLevel === l ? ' dbg-pill-active' : ''}"
               data-lvlfilter="${l}">${l === 'all' ? 'All' : l}</button>`
    ).join('');

    return `
      <div class="dbg-filter-bar" id="dbgFilterBar">
        <div class="dbg-filter-group">${modPills}</div>
        <div class="dbg-filter-group">${lvlPills}</div>
        <input class="dbg-search" id="dbgSearch" placeholder="🔍 Search…"
               value="${escHtml(filterText)}" autocomplete="off">
        <span class="dbg-filter-count">${showing === total ? total : `${showing} / ${total}`}</span>
      </div>`;
  }

  function renderEntries() {
    const entries = filteredEntries();
    if (!entries.length) {
      const reason = D.entries.length === 0
        ? 'No entries yet.<br><small>Click <strong>▶ Start</strong> to begin recording, then reproduce the issue.</small>'
        : 'No entries match the current filter.';
      return `<div class="dbg-no-entries">${reason}</div>`;
    }
    return entries.map(e => {
      const t    = new Date(e.t).toTimeString().substring(0, 8);
      const cls  = entryClass(e.level);
      const dur  = fmtDur(e.dur);
      const data = e.data
        ? `<span class="dbg-e-data">↳ ${escHtml(e.data)}</span>`
        : '';
      return `<div class="dbg-entry ${cls}">
        <span class="dbg-e-time">${t}</span>
        <span class="dbg-e-mod">${escHtml(e.mod)}</span>
        <span class="dbg-e-lvl">${escHtml(e.level)}</span>
        <span class="dbg-e-msg">${escHtml(e.msg)}${dur}</span>
        ${data}
      </div>`;
    }).join('');
  }

  function buildHtml() {
    const on    = D.enabled;
    const n     = D.entries.length;
    return `
      <div class="dbg-panel">

        <!-- Header -->
        <div class="dbg-modal-hdr">
          <span class="dbg-modal-title">🐛 Debug Recorder</span>
          <button id="dbgCloseBtn" class="btn btn-sm btn-secondary">✕ Close</button>
        </div>

        <!-- Controls -->
        <div class="dbg-modal-actions">
          <button id="dbgToggleBtn" class="btn btn-sm ${on ? 'btn-danger' : 'btn-success'}">
            ${on ? '⏹ Stop' : '▶ Start'}
          </button>
          <button id="dbgClearBtn" class="btn btn-sm btn-secondary" ${n ? '' : 'disabled'}>
            🗑 Clear
          </button>
          <label class="dbg-persist-label" title="Keep log across popup close/reopen">
            <input type="checkbox" id="dbgPersistCb" ${D.persisted ? 'checked' : ''}>
            Persist log
          </label>
        </div>

        <!-- Status bar -->
        <div class="dbg-status-bar ${on ? 'dbg-status-on' : 'dbg-status-off'}" id="dbgStatusBar">
          <span class="dbg-status-dot">${on ? '●' : '○'}</span>
          ${on
            ? 'Recording — use the extension, then <strong>Copy</strong> or share the log.'
            : 'Recording is stopped. Click <strong>▶ Start</strong> to capture API calls and errors.'}
          ${D.persisted ? '<span class="dbg-persist-badge">💾 persisted</span>' : ''}
        </div>

        <!-- Filter bar (re-rendered on filter change) -->
        <div id="dbgFilterOuter">${renderFilterBar()}</div>

        <!-- Entries -->
        <div class="dbg-entries-wrap" id="dbgEntriesWrap">
          ${renderEntries()}
        </div>

        <!-- Footer -->
        <div class="dbg-footer">
          <button id="dbgCopyTextBtn" class="btn btn-primary btn-sm" ${n ? '' : 'disabled'}>
            📋 Copy Text
          </button>
          <button id="dbgCopyJsonBtn" class="btn btn-secondary btn-sm" ${n ? '' : 'disabled'}>
            { } Copy JSON
          </button>
          <label class="dbg-autoscroll-label" title="Auto-scroll to newest entries">
            <input type="checkbox" id="dbgAutoScrollCb" ${autoScroll ? 'checked' : ''}> Live tail
          </label>
          <span class="dbg-entry-count" id="dbgEntryCount">${n} entr${n === 1 ? 'y' : 'ies'}</span>
        </div>

      </div>`;
  }

  // ── Render ───────────────────────────────────────────────
  showModal(buildHtml());
  const _modalBox = document.getElementById('modalBox');
  if (_modalBox) _modalBox.style.width = '460px';

  // ── Live-update helpers ───────────────────────────────────
  function refreshEntries() {
    const wrap = document.getElementById('dbgEntriesWrap');
    if (wrap) {
      wrap.innerHTML = renderEntries();
      if (autoScroll) wrap.scrollTop = wrap.scrollHeight;
    }
    refreshFilterBar();
    refreshFooter();
  }

  function refreshFilterBar() {
    const outer = document.getElementById('dbgFilterOuter');
    if (outer) {
      outer.innerHTML = renderFilterBar();
      wireFilterBar();
    }
  }

  function refreshFooter() {
    const n      = D.entries.length;
    const count  = document.getElementById('dbgEntryCount');
    const clear  = document.getElementById('dbgClearBtn');
    const copyT  = document.getElementById('dbgCopyTextBtn');
    const copyJ  = document.getElementById('dbgCopyJsonBtn');
    if (count) count.textContent = `${n} entr${n === 1 ? 'y' : 'ies'}`;
    if (clear)  clear.disabled  = n === 0;
    if (copyT)  copyT.disabled  = n === 0;
    if (copyJ)  copyJ.disabled  = n === 0;
  }

  function refreshStatus() {
    const bar = document.getElementById('dbgStatusBar');
    const tog = document.getElementById('dbgToggleBtn');
    const on  = D.enabled;
    if (bar) {
      bar.className = `dbg-status-bar ${on ? 'dbg-status-on' : 'dbg-status-off'}`;
      bar.innerHTML = `<span class="dbg-status-dot">${on ? '●' : '○'}</span>
        ${on
          ? 'Recording — use the extension, then <strong>Copy</strong> or share the log.'
          : 'Recording is stopped. Click <strong>▶ Start</strong> to capture API calls and errors.'}
        ${D.persisted ? '<span class="dbg-persist-badge">💾 persisted</span>' : ''}`;
    }
    if (tog) {
      tog.textContent = on ? '⏹ Stop' : '▶ Start';
      tog.className   = `btn btn-sm ${on ? 'btn-danger' : 'btn-success'}`;
    }
  }

  function updatePanel() {
    refreshStatus();
    refreshEntries();
  }

  // ── Wire filter bar events ────────────────────────────────
  function wireFilterBar() {
    // Module filter
    document.querySelectorAll('[data-modfilter]').forEach(btn => {
      btn.addEventListener('click', () => {
        filterMod = btn.dataset.modfilter;
        refreshEntries();
      });
    });
    // Level filter
    document.querySelectorAll('[data-lvlfilter]').forEach(btn => {
      btn.addEventListener('click', () => {
        filterLevel = btn.dataset.lvlfilter;
        refreshEntries();
      });
    });
    // Search
    const search = document.getElementById('dbgSearch');
    if (search) {
      search.addEventListener('input', () => {
        filterText = search.value;
        refreshEntries();
      });
    }
  }
  wireFilterBar();

  // ── Control buttons ───────────────────────────────────────
  document.getElementById('dbgToggleBtn').addEventListener('click', () => {
    D.toggle();
    if (D.enabled) {
      D.log('app', 'session',
        `Recording started · Org: ${orgUrl || 'unknown'} · v${(() => {
          try { return chrome.runtime.getManifest().version; } catch (_) { return '?'; }
        })()}`);
    }
    refreshStatus();
    refreshEntries();
  });

  document.getElementById('dbgClearBtn').addEventListener('click', () => {
    D.clear();
    updatePanel();
  });

  document.getElementById('dbgPersistCb').addEventListener('change', e => {
    if (e.target.checked) D.enablePersist();
    else D.disablePersist();
    refreshStatus();
  });

  document.getElementById('dbgAutoScrollCb').addEventListener('change', e => {
    autoScroll = e.target.checked;
  });

  // ── Copy helpers ─────────────────────────────────────────
  async function copyToClipboard(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    const orig = btn.textContent;
    btn.textContent = '✅ Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2200);
  }

  document.getElementById('dbgCopyTextBtn').addEventListener('click', () => {
    const btn = document.getElementById('dbgCopyTextBtn');
    copyToClipboard(D.toText(orgUrl), btn);
  });

  document.getElementById('dbgCopyJsonBtn').addEventListener('click', () => {
    const btn = document.getElementById('dbgCopyJsonBtn');
    copyToClipboard(D.toJson(orgUrl), btn);
  });

  // ── Close ────────────────────────────────────────────────
  const prevCb = D._cb;
  D._cb = () => { if (prevCb) prevCb(); updatePanel(); };

  document.getElementById('dbgCloseBtn').addEventListener('click', () => {
    D._cb = prevCb;
    if (_modalBox) _modalBox.style.width = '';
    closeModal();
  });
}

// ============================================================
// Utilities
// ============================================================

// Low-level one-shot message to the background worker
function sendBgRaw(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      resolve(resp || { error: chrome.runtime.lastError?.message || 'No response' });
    });
  });
}

// Broadcast a fresh session to every active module so they stop using stale credentials
function propagateFreshSession(newOrgUrl, newSid) {
  orgUrl = newOrgUrl;
  sid    = newSid;
  LightningPages.updateSession(orgUrl, sid);
  if (typeof ApexDebugger     !== 'undefined') ApexDebugger.updateSession(orgUrl, sid);
  if (typeof UserCopy         !== 'undefined') UserCopy.updateSession(orgUrl, sid);
  if (typeof LicenseManager   !== 'undefined') LicenseManager.updateSession(orgUrl, sid);
  if (typeof FlowPermissions  !== 'undefined') FlowPermissions.updateSession(orgUrl, sid);
  if (typeof FieldCleaner     !== 'undefined') FieldCleaner.updateSession(orgUrl, sid);
  // RecordCopy lives in Data Studio now — not loaded in the popup.
  updateTopbarOrgChip();
}

// ── Topbar org chip — persistent org switcher across all screens ──────────
function updateTopbarOrgChip() {
  const chip  = document.getElementById('topbarOrgChip');
  const label = document.getElementById('topbarOrgLabel');
  if (!chip) return;
  if (!orgUrl) { chip.style.display = 'none'; return; }

  const host  = (() => { try { return new URL(orgUrl).hostname; } catch (_) { return orgUrl; } })();
  const short = host.replace(/\.my\.salesforce\.com$/, '').replace(/\.salesforce\.com$/, '').split('.')[0];
  if (label) label.textContent = short || host;
  chip.style.display = '';
}

function openTopbarOrgDropdown() {
  const chip = document.getElementById('topbarOrgChip');
  if (!chip) return;

  // Toggle
  const existing = document.getElementById('topbarOrgDropdown');
  if (existing) { existing.remove(); chip.classList.remove('open'); return; }
  chip.classList.add('open');

  const rect = chip.getBoundingClientRect();
  const normUrl = u => { try { return new URL(u).origin.toLowerCase(); } catch (_) { return (u || '').toLowerCase(); } };

  const dd = document.createElement('div');
  dd.id        = 'topbarOrgDropdown';
  dd.className = 'home-org-dropdown topbar-org-dropdown';
  dd.style.cssText = `top:${rect.bottom + 4}px;right:${document.documentElement.clientWidth - rect.right}px;min-width:${Math.max(rect.width, 240)}px`;

  function closeDropdown() {
    const el = document.getElementById('topbarOrgDropdown');
    if (el) el.remove();
    chip.classList.remove('open');
    document.removeEventListener('click', onOutside, true);
  }
  function onOutside(ev) {
    // Let the chip button handle its own toggle — if the click is on the
    // chip (or inside it) don't interfere; the toggle check at the top of
    // openTopbarOrgDropdown will close it.
    if (dd.contains(ev.target) || chip.contains(ev.target)) return;
    closeDropdown();
  }

  async function buildDropdown() {
    dd.innerHTML = '';

    const hdr = document.createElement('div');
    hdr.className = 'home-org-dd-header';
    hdr.textContent = 'SWITCH ACTIVE ORG';
    dd.appendChild(hdr);

    const spinner = document.createElement('div');
    spinner.className = 'home-org-dd-empty';
    spinner.textContent = 'Detecting sessions…';
    dd.appendChild(spinner);

    // Fetch both live browser-tab sessions and stored credential orgs in parallel
    const [r, stored] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_ALL_SF_SESSIONS' }),
      chrome.storage.local.get('ds_stored_orgs').then(d => d.ds_stored_orgs || []).catch(() => [])
    ]);
    const sessions = r?.sessions || [];
    spinner.remove();

    // Deduplicate: tab sessions take priority over stored orgs for the same URL
    const seen = new Set();
    const allOrgs = [];
    for (const s of sessions) {
      const key = normUrl(s.orgUrl);
      if (!seen.has(key)) { seen.add(key); allOrgs.push({ ...s, online: true }); }
    }
    for (const o of stored) {
      if (!o.url || !o.sid) continue;
      const key = normUrl(o.url);
      if (!seen.has(key)) {
        seen.add(key);
        allOrgs.push({ orgUrl: o.url, sid: o.sid, label: o.label || o.username, online: false, stored: true });
      }
    }

    if (!allOrgs.length) {
      const empty = document.createElement('div');
      empty.className = 'home-org-dd-empty';
      empty.textContent = 'No orgs detected — open a Salesforce tab or add one in Data Studio.';
      dd.appendChild(empty);
    } else {
      allOrgs.forEach(sess => {
        const host      = (() => { try { return new URL(sess.orgUrl).hostname; } catch (_) { return sess.orgUrl || ''; } })();
        const name      = sess.label || host;
        const isCurrent = normUrl(sess.orgUrl) === normUrl(orgUrl);
        const dotColor  = sess.online ? '#4ac154' : '#9b8ec4';
        const item = document.createElement('button');
        item.className = 'home-org-dd-item' + (isCurrent ? ' home-org-dd-item-active' : '');
        item.innerHTML = `
          <span class="home-org-dd-dot" style="background:${dotColor};box-shadow:none"></span>
          <span class="home-org-dd-text">
            <span class="home-org-dd-name">${escHtml(name)}</span>
            <span class="home-org-dd-host">${escHtml(host)}</span>
          </span>
          ${sess.stored ? '<span class="t-tag t-tag-cred" style="font-size:9px;padding:1px 5px;border-radius:3px;background:#f0ebff;color:#7c5ce0;flex-shrink:0">credentials</span>' : ''}
          ${isCurrent ? '<span class="home-org-dd-check">active</span>' : ''}`;
        item.addEventListener('click', ev => {
          ev.stopPropagation();
          if (!isCurrent) {
            resetOrgState();
            propagateFreshSession(sess.orgUrl, sess.sid);
            // Reload the active feature tab against the new org
            const activeTab = document.querySelector('.tab-btn.active');
            if (activeTab) activeTab.click();
          }
          closeDropdown();
        });
        dd.appendChild(item);
      });
    }

    const retryRow = document.createElement('button');
    retryRow.className = 'home-org-dd-retry';
    retryRow.textContent = '🔄 Re-scan';
    retryRow.addEventListener('click', ev => { ev.stopPropagation(); buildDropdown(); });
    dd.appendChild(retryRow);
  }

  document.body.appendChild(dd);
  buildDropdown();
  setTimeout(() => document.addEventListener('click', onOutside, true), 0);
}

// Wire the chip once DOM is ready (called from DOMContentLoaded)
function initTopbarOrgChip() {
  document.getElementById('topbarOrgChip')?.addEventListener('click', e => {
    e.stopPropagation();
    openTopbarOrgDropdown();
  });
}

// Reset all per-org state so switching orgs forces a full re-load of every tab
function resetOrgState() {
  // Flow / mode state
  _flowsLoaded       = false;
  allFlows           = [];
  flowGroups         = {};
  selectedIds        = new Set();
  orgFlowCount       = 0;
  metadataScanState  = 'none';
  restoreBackupFlows = [];
  restoreSelected    = new Set();
  currentMode        = 'delete';

  // Clear module lazy-init flags so each tab re-initializes against the new org
  const flagMap = {
    lpContainer:             '_lpInitialized',
    debuggerContainer:       '_adbgInitialized',
    fieldCleanerContainer:   '_fcInitialized',
    userCopyContainer:       '_ucInitialized',
    licenseManagerContainer: '_lmInitialized',
    flowPermsContainer:      '_fpInitialized',
  };
  Object.entries(flagMap).forEach(([id, flag]) => {
    const el = document.getElementById(id);
    if (el) delete el[flag];
  });
}

// sendBg — wraps sendBgRaw with one additional popup-level recovery attempt.
// background.js already reads the freshest cookie before every API call.
// If it still gets SESSION_EXPIRED it means the cookie itself is dead.
// This wrapper does one last check: read the session cookie in the popup
// and retry ONLY if it returned a DIFFERENT sid than the one we sent.
// (Re-using the same dead sid would just produce another SESSION_EXPIRED.)
async function sendBg(msg) {
  const _t   = window.SFToolkitDebug?.enabled ? Date.now() : null;
  const resp = await sendBgRaw(msg);

  // Debug logging
  if (window.SFToolkitDebug?.enabled) {
    const dur  = _t !== null ? Date.now() - _t : null;
    const tag  = msg.query?.substring(0, 80) || msg.path || msg.sobject || '';
    const lvl  = resp?.error === 'SESSION_EXPIRED' ? 'session' : resp?.error ? 'error' : 'api';
    window.SFToolkitDebug.log('flows',
      lvl,
      `${msg.type}${tag ? '  ' + tag : ''}`,
      resp?.sfBody || resp?.error || null,
      dur);
  }

  if (resp?.error !== 'SESSION_EXPIRED') return resp;

  // Cookie is dead.  Only retry if we can find a DIFFERENT (genuinely fresh) sid
  // FOR THE SAME ORG we were querying.  If the fresh session belongs to a different
  // org (e.g. the user switched orgs and the background's tab-detection falls back
  // to the wrong tab), we must NOT silently switch back — just surface SESSION_EXPIRED
  // so the UI shows the error rather than querying and displaying the wrong org's data.
  const targetOrgUrl = msg.orgUrl || orgUrl;
  const fresh = await sendBgRaw({ type: 'GET_SF_SESSION', activeTabUrl: targetOrgUrl });

  const normApiOrigin = u => {
    try {
      const h = new URL(u).hostname
        .replace('.lightning.force.com', '.my.salesforce.com')
        .replace('.salesforce-setup.com', '.salesforce.com');
      return `https://${h}`;
    } catch(_) { return (u||'').toLowerCase(); }
  };
  const freshIsCorrectOrg = fresh?.orgUrl && normApiOrigin(fresh.orgUrl) === normApiOrigin(targetOrgUrl);
  const freshIsDifferentSid = fresh?.sid && fresh.sid !== (msg.sid || sid);

  if (freshIsCorrectOrg && freshIsDifferentSid) {
    propagateFreshSession(fresh.orgUrl, fresh.sid);
    const retryMsg = msg.sid !== undefined
      ? { ...msg, orgUrl: fresh.orgUrl, sid: fresh.sid }
      : msg;
    return sendBgRaw(retryMsg);
  }

  // Wrong org or same dead cookie — surface SESSION_EXPIRED immediately.
  return resp;
}

// Salesforce stores Record-Triggered, Scheduled, and Platform Event flows
// all as ProcessType='AutoLaunchedFlow'. TriggerType tells them apart.
function resolveFlowType(processType, triggerType) {
  if (processType === 'AutoLaunchedFlow') {
    switch (triggerType) {
      case 'RecordBeforeSave':
      case 'RecordAfterSave':
        return 'RecordTriggeredFlow';
      case 'Scheduled':
        return 'ScheduledFlow';
      case 'PlatformEvent':
        return 'PlatformEventFlow';
    }
  }
  return processType;
}

function humanProcessType(pt) {
  switch (pt) {
    case 'Flow':               return 'Screen Flow';
    case 'AutoLaunchedFlow':   return 'Auto-launched Flow';
    case 'RecordTriggeredFlow':return 'Record-Triggered Flow';
    case 'ScheduledFlow':      return 'Scheduled Flow';
    case 'PlatformEventFlow':  return 'Platform Event Flow';
    case 'Orchestrator':       return 'Orchestrator';
    default:                   return pt || '';
  }
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}
