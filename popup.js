// ============================================================
// State
// ============================================================
let orgUrl = null;
let sid = null;
let allFlows = [];          // flat list of all Flow records
let flowGroups = {};        // MasterLabel -> [Flow records]
let selectedIds = new Set(); // selected Flow version Ids
let orgFlowCount = 0;
// 'skipped' = org too large to scan on open (P1); 'partial' = the user stopped
// it. Neither may be treated as 'done' — see renderDependenciesTab.
let metadataScanState = 'none'; // 'none' | 'scanning' | 'skipped' | 'partial' | 'done'
let toolbarEventsReady = false;  // guard against duplicate listeners
// v1.1.0 — did the Flow list really return LastModifiedDate for every version?
// Without it nothing can be proven unchanged, so the incremental dependency
// cache is disabled for this org rather than trusted blind.
let flowStampsAvailable = false;
// Result of the last live re-verification run before a delete (TASK C), so the
// final confirm can say what was re-checked instead of implying it was all live.
let _lastDeleteRecheck = null;

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
// Set only once the licence gate has been passed. Every listener that can
// boot the page later (a cookie refresh, a deep link) checks it — the gate
// is the only door in (audit 2026-09-12).
let _termsOk = false;

document.addEventListener('DOMContentLoaded', async () => {
  initDarkTheme();
  // The licence gate runs BEFORE any org session is touched: declining must
  // mean nothing happens, not "nothing happens after we already looked"
  // (user 2026-08-26). initDarkTheme stays above it only so the dialog is
  // not painted onto a half-themed page.
  if (typeof sftkTermsGate === 'function' && !(await sftkTermsGate())) return;
  _termsOk = true;
  initDebugMode();
  initActivityBar();
  setupTabs();
  setupModeToggle();
  initTopbarOrgChip();
  document.getElementById('homeBtn')?.addEventListener('click', showHomePage);
  document.getElementById('dataStudioBtn')?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') });
  });

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

// ── Theme — light → dark → OLED black, persisted in chrome.storage.local ──
// styles.css is fully CSS-variable-driven, so the class flips restyle every
// component. sftk_dark is shared with the standalone log viewer; sftk_oled is
// THE SAME preference Data Studio's ⚫ toggle writes (one OLED setting for the
// whole toolkit — user 2026-08-10: "no OLED mode for toolkit?").
function initDarkTheme() {
  const KEY = 'sftk_dark', OLED = 'sftk_oled';
  const btn = document.getElementById('sftkDarkToggle');
  const apply = (on, oled) => {
    document.body.classList.toggle('sftk-dark', !!on);
    document.body.classList.toggle('sftk-oled', !!on && !!oled);
    if (btn) {
      // The glyph is a masked icon on a child span, swapped by name. It used
      // to be the button's own textContent, which is why the control had no
      // accessible name beyond "crescent moon".
      const icon = document.getElementById('sftkDarkIcon');
      if (icon) icon.dataset.i = (on && oled) ? 'sun' : 'moon';
      const label = !on ? 'Switch to dark mode'
        : (!oled ? 'Switch to OLED black — pure-black dark for OLED screens'
                 : 'Switch to light mode');
      btn.title = label;
      btn.setAttribute('aria-label', label);
    }
  };
  chrome.storage?.local?.get([KEY, OLED]).then(d => apply(d?.[KEY], d?.[OLED])).catch(() => {});
  // Live-sync with the Studio's toggles: popup.html can live for hours as a
  // popped-out tab, and cycling from a stale snapshot would silently clobber
  // a newer preference the Studio wrote (QA sweep 2026-08-10).
  try {
    chrome.storage?.onChanged?.addListener((ch, area) => {
      if (area !== 'local' || (!(KEY in ch) && !(OLED in ch))) return;
      const dark = KEY in ch ? ch[KEY].newValue : document.body.classList.contains('sftk-dark');
      const oled = OLED in ch ? ch[OLED].newValue : document.body.classList.contains('sftk-oled');
      apply(dark, oled);
    });
  } catch (_) {}
  btn?.addEventListener('click', () => {
    const dark = document.body.classList.contains('sftk-dark');
    const oled = document.body.classList.contains('sftk-oled');
    const next = !dark ? [true, false] : (!oled ? [true, true] : [false, false]);
    apply(next[0], next[1]);
    chrome.storage?.local?.set({ [KEY]: next[0], [OLED]: next[1] });
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
// `i` is a name in the shared icon mask table (styles.css) — the same
// dialect the Apex Debugger uses: a monochrome glyph painted with
// currentColor. It replaced an `icon` emoji plus a `color` hex that
// popup.js wrote into the markup as an inline style, which is where the
// home grid's six different icon-chip tints came from.
const HOME_FEATURES = [
  {
    id: 'flows',
    i: 'nodes',
    title: 'Flows',
    desc: 'Bulk delete, backup, and restore flow versions safely',
    action() { navigateToTab('flows'); loadFlowsIfNeeded(); }
  },
  {
    id: 'dependencies',
    i: 'share',
    title: 'Dependencies',
    desc: 'Map subflow call chains and see which flows reference other flows',
    action() { navigateToTab('dependencies'); renderDependenciesTab(); }
  },
  {
    id: 'debugger',
    i: 'bug',
    title: 'Debugger',
    desc: 'Real-time automation monitor — trace flows, triggers, and detect recursion loops',
    action() { navigateToTab('debugger'); initDebuggerTab(); }
  },
  {
    id: 'pages',
    i: 'layout',
    title: 'Lightning Pages',
    desc: 'View assignments, org defaults, and profile overrides for Record Pages',
    action() { navigateToTab('pages'); initLightningPagesTab(); }
  },
  {
    id: 'fields',
    i: 'sliders',
    title: 'Field Cleaner',
    desc: 'Scan field dependencies, auto-remove from flows, then safely delete the field',
    action() { navigateToTab('fields'); initFieldCleanerTab(); }
  },
  {
    id: 'copy-perms',
    i: 'users',
    title: 'Copy Permissions',
    desc: 'Copy permission sets, profiles, and assignments between users',
    action() { navigateToTab('copy-perms'); initUserCopyTab(); }
  },
  {
    id: 'licenses',
    i: 'key',
    title: 'Licenses',
    desc: 'View and manage user license assignments across your org',
    action() { navigateToTab('licenses'); initLicenseManagerTab(); }
  },
  {
    id: 'flow-access',
    i: 'shield',
    title: 'Flow Access',
    desc: 'Control which users and profiles can run each flow',
    action() { navigateToTab('flow-access'); initFlowAccessTab(); }
  },
  {
    id: 'health',
    i: 'chart',
    title: 'Org health',
    desc: 'Licences at the cap, idle users, flows left off — in Data Studio',
    action() { chrome.tabs.create({ url: chrome.runtime.getURL('studio.html#/orghealth') }); }
  }
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
    ids: ['copy-perms', 'licenses', 'flow-access', 'health']
  },
];

// ── Deep links from the Data Studio command palette ──────────
// A fresh popout window arrives with ?tab=<feature id>; an already-open
// one receives a TOOLKIT_NAVIGATE runtime message. Either way the target
// feature opens via its HOME_FEATURES action (which also triggers the
// tab's first data load) — deferred until a session exists, since every
// feature init needs orgUrl/sid.
let _deepLinkTab = new URLSearchParams(location.search).get('tab');

chrome.runtime?.onMessage?.addListener?.((msg, _sender, sendResponse) => {
  if (msg?.type === 'TOOLKIT_NAVIGATE' && msg.tab) {
    const feat = HOME_FEATURES.find(f => f.id === msg.tab);
    if (feat && sid) feat.action();
    else _deepLinkTab = msg.tab;   // run once the session lands
  }
  // "Anyone home?" — Data Studio's ‹ Toolkit button (and the toolbar-icon
  // handler) ping instead of tabs.query({url}), which silently stopped
  // matching when the "tabs" permission was dropped. We answer with our tab
  // id so the caller can FOCUS this view instead of opening a new one.
  // tabs.getCurrent needs no permission and works in tabs + popout windows.
  if (msg?.type === 'TOOLKIT_PING') {
    chrome.tabs.getCurrent(tab => {
      sendResponse(tab ? { tabId: tab.id, windowId: tab.windowId } : {});
    });
    return true;   // async sendResponse
  }
});

// Navigate to a feature tab — hides home view, highlights sidebar item.
function navigateToTab(tabName) {
  document.getElementById('homeView').style.display = 'none';
  document.getElementById('homeBtn').style.display  = '';
  document.querySelector('.app-body')?.classList.remove('home-active');

  // Restore the topbar org chip now that we're on a feature tab
  updateTopbarOrgChip();

  // Deactivate all sidebar items and hide all tab panels.
  // a11y: aria-current mirrors the visual .active state — the eight sidebar
  // buttons are otherwise identical to a screen reader (same contract the
  // Studio keeps in _applyView).
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.remove('active');
    b.removeAttribute('aria-current');
  });
  document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');

  // Activate the matching sidebar button and show the panel
  const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
  const tab = document.getElementById(`tab-${tabName}`);
  if (btn) { btn.classList.add('active'); btn.setAttribute('aria-current', 'page'); }
  if (tab) tab.style.display = '';
}

// Show the home page — deactivates sidebar selection.
function showHomePage() {
  // Home is not a sidebar tab, so no button may claim aria-current here.
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.remove('active');
    b.removeAttribute('aria-current');
  });
  document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
  document.getElementById('homeBtn').style.display = 'none';
  renderHomePage();
}

// ── Render the full home page into #homeView ──────────────────
// ── Ctrl+K command palette (C6) — Studio has one; the popup, with MORE
// tools, only had a tab strip. Same interaction: type to filter, ↑↓ + Enter,
// Esc closes. Items = every HOME_FEATURE + two shell actions.
function openToolkitPalette() {
  document.getElementById('tkCmdOverlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'tkCmdOverlay';
  overlay.className = 'tk-cmd-overlay';
  let activeIdx = 0;

  const ITEMS = [
    ...HOME_FEATURES.map(f => ({ i: f.i, label: f.title, desc: f.desc, run: () => f.action() })),
    { i: 'home',  label: 'Home', desc: 'Back to the tool overview', run: () => renderHomePage() },
    { i: 'globe', label: 'Open Data Studio', desc: 'Cross-org data compare, transfer & reconcile', run: () => document.getElementById('dataStudioBtn')?.click() },
  ];

  function itemsFor(q) {
    const ql = q.toLowerCase().trim();
    return ITEMS.filter(i => !ql || i.label.toLowerCase().includes(ql) || i.desc.toLowerCase().includes(ql));
  }
  function paint(q) {
    const list = itemsFor(q);
    activeIdx = Math.min(activeIdx, Math.max(0, list.length - 1));
    overlay.querySelector('.tk-cmd-list').innerHTML = list.length ? list.map((i, k) => `
      <div class="tk-cmd-item${k === activeIdx ? ' tk-cmd-active' : ''}" data-k="${k}">
        <span class="tk-cmd-icon" data-i="${escHtml(i.i)}" aria-hidden="true"></span>
        <span class="tk-cmd-label">${escHtml(i.label)}</span>
        <span class="tk-cmd-desc">${escHtml(i.desc)}</span>
      </div>`).join('') : '<div class="tk-cmd-empty">No matches</div>';
    overlay.querySelectorAll('.tk-cmd-item').forEach(el =>
      el.addEventListener('click', () => { const it = list[+el.dataset.k]; close(); it?.run(); }));
    return list;
  }
  function close() { overlay.remove(); }

  overlay.innerHTML = `
    <div class="tk-cmd-box">
      <input type="text" class="tk-cmd-input" placeholder="Jump to a tool… (↑↓ + Enter)" autocomplete="off">
      <div class="tk-cmd-list"></div>
    </div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);

  const input = overlay.querySelector('.tk-cmd-input');
  let current = paint('');
  input.addEventListener('input', () => { activeIdx = 0; current = paint(input.value); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, current.length - 1); current = paint(input.value); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); current = paint(input.value); }
    if (e.key === 'Enter')     { e.preventDefault(); const it = current[activeIdx]; close(); it?.run(); }
  });
  input.focus();
}

if (!window._tkPaletteBound) {
  window._tkPaletteBound = true;
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openToolkitPalette();
    }
  });
}

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
          <span class="home-card-icon" data-i="${escHtml(f.i)}" aria-hidden="true"></span>
          <span class="home-card-body">
            <span class="home-card-title">${escHtml(f.title)}</span>
            <span class="home-card-desc">${escHtml(f.desc)}</span>
          </span>
        </button>`).join('');

    return `
      <div class="home-section">
        <div class="home-section-title">${escHtml(section.title)}</div>
        <div class="home-section-cards">${cards}</div>
      </div>`;
  }).join('');

  // The org header card. `aria-label` spells out what the visual pieces say
  // — the button is the org switcher, and "Session active" is the same claim
  // the green dot used to make with colour alone.
  const orgLabel = `Connected org ${orgShort}, ${orgHost}. Session active. Switch org`;

  homeView.innerHTML = `
    ${orgHost ? `
      <div class="home-org-chip">
        <button class="home-org-chip-btn" id="homeOrgSelector" title="Switch active org"
                aria-haspopup="true" aria-expanded="false" aria-label="${escHtml(orgLabel)}">
          <span class="home-org-icon" data-i="cloud" aria-hidden="true"></span>
          <span class="home-org-chip-text">
            <span class="home-org-eyebrow">Connected org</span>
            <span class="home-org-name">${escHtml(orgShort)}</span>
            <span class="home-org-host">${escHtml(orgHost)}</span>
          </span>
          <span class="home-org-status" aria-hidden="true">Session active</span>
          <span class="home-org-chip-arrow" aria-hidden="true">Switch org</span>
        </button>
      </div>` : ''}

    <div class="home-sections">
      ${sectionsHTML}

      <button class="home-studio-btn" id="homeStudioBtn">
        <span class="home-studio-icon" data-i="globe" aria-hidden="true"></span>
        <span class="home-studio-body">
          <span class="home-studio-title">Data Studio</span>
          <span class="home-studio-desc">Multi-org data deployment, profiles &amp; transfer</span>
        </span>
        <span class="home-studio-arrow" data-i="chevron" aria-hidden="true"></span>
      </button>
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
    if (existing) { existing.remove(); e.currentTarget.setAttribute('aria-expanded', 'false'); return; }

    const chipBtn = document.getElementById('homeOrgSelector');
    // a11y: the chip advertises aria-haspopup, so aria-expanded must track
    // the dropdown through every open/close path — this one, closeDropdown,
    // and the toggle-close above.
    chipBtn.setAttribute('aria-expanded', 'true');
    const rect    = chipBtn.getBoundingClientRect();

    // Normalize org URL for comparison (strips trailing slash / path differences)
    const normUrl = u => { try { return new URL(u).origin.toLowerCase(); } catch(_) { return (u||'').toLowerCase(); } };

    // Create the dropdown container up front
    const dd = document.createElement('div');
    dd.id        = 'homeOrgDropdown';
    dd.className = 'home-org-dropdown';
    // Anchored to the header card's left edge. Width is its own now: the
    // card grew into a full-width page header, and inheriting its width made
    // the org list a 992px-wide strip holding three short rows.
    dd.style.cssText = `top:${rect.bottom + 4}px;left:${rect.left}px`;

    // Close helper — defined before buildDropdown so it can reference it
    function closeDropdown() {
      const el = document.getElementById('homeOrgDropdown');
      if (el) el.remove();
      chipBtn.setAttribute('aria-expanded', 'false');
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
      spinner.innerHTML = sftkCatSm('Detecting sessions…');
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

          const item = document.createElement('button');
          item.className = 'home-org-dd-item' + (isCurrent ? ' home-org-dd-item-active' : '');
          // The dot still distinguishes a live browser session from a stored
          // credential — the two states just come from classes now instead of
          // two raw hexes that never re-pointed in dark mode.
          item.innerHTML = `
            <span class="home-org-dd-dot ${sess.online ? 'home-org-dd-dot-live' : 'home-org-dd-dot-stored'}"></span>
            <span class="home-org-dd-text">
              <span class="home-org-dd-name">${escHtml(name)}</span>
              <span class="home-org-dd-host">${escHtml(host)}</span>
            </span>
            ${sess.stored ? '<span class="home-org-dd-tag">credentials</span>' : ''}
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
      retryRow.innerHTML = '<span data-i="refresh" aria-hidden="true"></span>Re-scan';
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
      // (was `bg(...)` — undefined in popup.js; the keepalive silently never
      // ran, swallowed by the catch below. Caught by no-undef, A4.)
      await sendBg({ type: 'SF_REST_GET', orgUrl, sid,
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

  // Reset to "home loading" state. aria-current rides with .active in every
  // strip site — this is the third one (navigateToTab/showHomePage are the
  // others); leaving it here kept announcing a tab that was no longer active.
  document.querySelectorAll('.tab-btn').forEach(b => { b.classList.remove('active'); b.removeAttribute('aria-current'); });
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
    // These two states used to reuse .home-studio-btn — the full-width brand
    // banner — and then undo it with five inline style declarations per
    // button, including three hard-coded greys that ignored dark mode.
    homeView.innerHTML = isExpired ? `
      <div class="home-loading">
        ${sftkCat('Session expired', true)}
        <div class="home-loading-text">
          Your Salesforce session has expired.<br>
          <strong>Log back into Salesforce</strong>, then return here.
        </div>
        <div class="home-loading-actions">
          <button id="goToSfBtn" class="home-btn">
            <span data-i="globe" aria-hidden="true"></span>Go to Salesforce
          </button>
          <button id="retryManualBtn" class="home-btn home-btn-secondary">
            <span data-i="refresh" aria-hidden="true"></span>Try again
          </button>
        </div>
        <div class="home-loading-hint">
          Reconnects automatically once you log in.
        </div>
      </div>` : `
      <div class="home-loading">
        ${sftkCat('No Salesforce tab detected.', true)}
        <div class="home-loading-text">
          Open a Salesforce org in Chrome and this will connect automatically.
        </div>
        <button id="retryManualBtn" class="home-btn">
          <span data-i="refresh" aria-hidden="true"></span>Retry now
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
    // A cookie refresh must not boot a page whose licence gate was declined
    // (or is still open).
    if (!_termsOk) return;
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
  // length.  A shared-domain cookie from another org (a sid scoped to
  // .develop.my.salesforce.com) would otherwise shadow the correct
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
  // No session yet (no SF tab open) — a sidebar click can land here before any
  // connect. Show the normal "connect to Salesforce" state instead of firing a
  // doomed query whose contract error would render as a scary banner.
  if (!orgUrl || !sid) {
    _flowsLoaded = false;   // let the next real session load flows
    initSession();
    return;
  }
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
  // Belongs to the org being replaced — a stale `true` here would let the next
  // org's cache note claim a freshness field this org may not have.
  flowStampsAvailable = false;
  _lastDeleteRecheck = null;

  try {
    // Snapshot the org context — an org switch can update the module-level
    // orgUrl/sid mid-load, which would otherwise send these flow IDs to the
    // wrong org's session (HTTP 404 on the metadata fetch).
    const loadOrgUrl = orgUrl, loadSid = sid;

    // LastModifiedDate is the freshness field the incremental dependency cache
    // is built on (the Tooling Flow object is version-grained and carries the
    // standard audit fields). It rides along on a query the popup already pays
    // for, so it costs nothing — but it must NEVER cost the flow list itself:
    // if this org/API version rejects the field, retry once without it and let
    // DependencyMap disable caching rather than leave the user with no flows.
    // ApiVersion / CreatedDate ride along for the Dependencies rows (user
    // 2026-09-13: "version number, api version, status … last modified date
    // and created date") — both are plain Tooling Flow fields.
    const FLOW_FIELDS = 'Id,MasterLabel,Definition.DeveloperName,DefinitionId,VersionNumber,Status,ProcessType,Description,ApiVersion,CreatedDate';
    const order = ' ORDER BY MasterLabel ASC,VersionNumber ASC';
    let result = await sendBg({
      type: 'SF_QUERY_ALL', orgUrl: loadOrgUrl, sid: loadSid, tooling: true,
      query: `SELECT ${FLOW_FIELDS},LastModifiedDate FROM Flow${order}`,
      _suppressError: true
    });
    let stampField = true;
    if (result && result.error && /INVALID_FIELD|No such column|LastModifiedDate/i.test(String(result.error))) {
      stampField = false;
      result = await sendBg({
        type: 'SF_QUERY_ALL', orgUrl: loadOrgUrl, sid: loadSid, tooling: true,
        query: `SELECT ${FLOW_FIELDS} FROM Flow${order}`
      });
    }
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
    flowStampsAvailable = stampField && allFlows.length > 0 && allFlows.every(f => f.LastModifiedDate);

    groupFlows();
    showLoading(false);
    renderFlowList();
    updateActionBar();
    updateSelectionSummary();

    // 🔒 Managed-package flows are invisible to the Tooling query above; list
    // them from the REST views so the Dependencies tab can show them (with
    // their contents marked hidden). Fire-and-forget — the section paints
    // itself when the read lands; a failure is disclosed on the section.
    if (typeof DependencyMap.loadManagedFlows === 'function') {
      // The same read carries FlowDefinitionView.TriggerType for EVERY flow —
      // the scan-independent way to tell a record-triggered flow from a plain
      // autolaunched one (user 2026-09-14, from Setup's own list).
      DependencyMap.loadManagedFlows(loadOrgUrl, loadSid)
        .then(() => {
          patchFlowTypesFromDefinitions(loadOrgUrl);
          // The cached map paints before this list lands, so a managed
          // subflow target read "Not found" until something else repainted.
          if (loadOrgUrl === orgUrl && DependencyMap.treeStaleForManaged?.()
              && document.getElementById('tab-dependencies')?.style.display !== 'none') renderDependenciesTab();
        })
        .catch(() => {});
    }

    // Scan metadata in the background if the org is small enough to make that
    // free (see fetchAllMetadataSilently) — pass the snapshotted org context so
    // the flow IDs and the session always belong together.
    hideScanOfferBar();
    verifyFlowListCoverage(loadOrgUrl, loadSid, allFlows.length);
    fetchAllMetadataSilently(loadOrgUrl, loadSid);

    setupToolbarEvents();
  } catch (e) {
    handleApiError(e.message || String(e));
  }
}

// ↻ Rescan (user 2026-09-13: "we need to offer rescan button"). The popup can
// live for hours as a popped-out tab; a flow edited in Flow Builder meanwhile
// keeps its old, now wrong, "calls no subflows" until something re-reads it.
// This drops the org's stored dependency data, re-reads the flow list and
// every version's metadata. The click is the consent for a large org — the
// button's own title quotes the cost.
window.sftkRescanDependencies = async function () {
  if (!orgUrl || !sid) return;
  try { await DependencyMap.clearCache(); } catch (_) { /* a missing entry is fine */ }
  _flowsLoaded = false;
  await loadFlows();   // resets the module, re-queries the list, decides on the auto-scan
  // The auto-scan decision lands after one storage read — wait for it briefly.
  for (let i = 0; i < 50 && metadataScanState === 'none'; i++) await wait(100);
  if (metadataScanState === 'skipped') {
    hideScanOfferBar();
    await runDependencyScan(orgUrl, sid);
  }
  if (document.getElementById('tab-dependencies')?.style.display !== 'none') renderDependenciesTab();
};

// P1 — the dependency scan costs ONE metadata GET per flow VERSION. In a small
// org that is a couple of seconds and worth paying on open (🔗 icons and refined
// flow types appear with no user action). In a large enterprise org it is
// hundreds of calls and minutes of waiting before the user has asked for
// anything, so above the threshold we do not scan — we say what it would cost.
async function fetchAllMetadataSilently(loadOrgUrl, loadSid) {
  // Fall back to the current module values if not passed (older callers).
  loadOrgUrl = loadOrgUrl || orgUrl;
  loadSid    = loadSid    || sid;

  // v1.1.0 — reuse whatever this org's stored map still proves. Zero HTTP
  // round-trips: it diffs chrome.storage.local against the flow list that was
  // just fetched. On a cold cache (every first run, every new org) it finds
  // nothing and the scan below is byte-for-byte the one v1.0.1 ran.
  await DependencyMap.primeFromCache(allFlows, loadOrgUrl);
  // An org switch during the storage read means these flows are the wrong org's.
  if (orgUrl !== loadOrgUrl) return;

  // Size the decision on what still has to be READ, not on the org's size — a
  // 1600-version org with a warm cache and three edited drafts must scan those
  // three on open, not be told it is too large to look at.
  const plan = DependencyMap.scanPlan(DependencyMap.pendingCount(allFlows));
  if (!plan.auto) {
    metadataScanState = 'skipped';
    // Also clears a progress bar left standing by a scan the previous org
    // abandoned when this load reset the module.
    showScanProgress(false);
    showScanOfferBar(loadOrgUrl, loadSid);
    if (document.getElementById('tab-dependencies').style.display !== 'none') {
      renderDependenciesTab();
    }
    return;
  }
  await runDependencyScan(loadOrgUrl, loadSid);
}

// The one place a scan is started. Cancellable, resumable, and it never claims
// completion it didn't reach — metadataScanState ends 'done' only if the pool
// actually drained.
async function runDependencyScan(loadOrgUrl, loadSid) {
  loadOrgUrl = loadOrgUrl || orgUrl;
  loadSid    = loadSid    || sid;
  if (DependencyMap.getScanStatus().running) return;

  hideScanOfferBar();
  metadataScanState = 'scanning';
  const stop = () => DependencyMap.cancelScan();
  const total0 = allFlows.length;
  const st0 = DependencyMap.getScanStatus();

  // Show scan progress for every org size — without it the post-scan repaint
  // (🔗 icons appearing, process types changing) looks unexplained in small orgs.
  // The starting count is whatever is already covered: with a warm cache that is
  // not zero, and starting the bar at 0 would imply work that is not happening.
  showScanProgress(true, `🔍 Building dependency map… ${st0.done} / ${total0}`, stop);
  if (document.getElementById('tab-dependencies').style.display !== 'none') {
    renderDependenciesTab();
  }

  await DependencyMap.buildDependencyMap(allFlows, loadOrgUrl, loadSid, (done, total) => {
    showScanProgress(true, `🔍 Building dependency map… ${done} / ${total}`, stop);
    const live = document.getElementById('depScanLive');
    if (live) live.textContent = `Dependency map is building… ${done} / ${total} flow versions. This tab will refresh automatically when ready.`;
  });

  const st = DependencyMap.getScanStatus();
  // Superseded: an org switch mid-flight resets the module and re-enters
  // loadFlows, so allFlows and every count below now describe a DIFFERENT org.
  // Whichever load owns the new org owns the UI too.
  if (st.running || orgUrl !== loadOrgUrl) return;

  showScanProgress(false);
  metadataScanState = st.complete ? 'done' : 'partial';
  // Self-hiding — renders the resume offer, the flow-list coverage warning,
  // both, or nothing at all.
  showScanOfferBar(loadOrgUrl, loadSid);

  patchFlowTypesFromMetadata();
  groupFlows();
  renderFlowList(); // re-render with corrected types + 🔗 icons

  // If the dependency tab is already open, refresh it now that data is ready
  if (document.getElementById('tab-dependencies').style.display !== 'none') {
    renderDependenciesTab();
  }
}

// The honest affordance that replaces the eager scan in a large org, and the
// "you stopped it here" bar after a cancel. Lives in the flow toolbar so it is
// visible from the Flows tab, where the missing 🔗 markers are. Also carries the
// flow-list coverage warning, which applies whether or not a scan is offered.
function showScanOfferBar(loadOrgUrl, loadSid) {
  const wrap = document.getElementById('scanSubflowBtnWrap');
  if (!wrap) return;
  const st   = DependencyMap.getScanStatus();
  // What is LEFT TO READ — with a cache that is not "org size minus done", it is
  // the delta the module is actually holding. Both numbers below come from the
  // same place the pool does, so the quote cannot drift from the work.
  const left = DependencyMap.scanPlan(DependencyMap.pendingCount(allFlows));
  const offerScan = !st.complete;
  const coverage  = flowCoverageNote();
  const cacheNote = scanCacheNote(st);
  if (!offerScan && !coverage && !cacheNote) { hideScanOfferBar(); return; }

  wrap.style.display = '';
  wrap.style.flexBasis = '100%';   // its own row — the note is a sentence, not a label
  wrap.innerHTML = '';

  if (coverage) {
    const warn = document.createElement('span');
    warn.style.cssText = 'font-size:11px;color:var(--warning,#DD7A01);display:block;margin-bottom:4px';
    warn.textContent = coverage;
    wrap.appendChild(warn);
  }
  if (cacheNote) {
    const cn = document.createElement('span');
    cn.style.cssText = 'font-size:11px;color:var(--subtext,#706E6B);display:block;margin-bottom:4px';
    cn.textContent = cacheNote;
    wrap.appendChild(cn);
  }
  if (!offerScan) return;

  const note = document.createElement('span');
  note.className = 'scan-offer-note';
  note.style.cssText = 'font-size:11px;color:var(--subtext,#706E6B);display:block;margin-bottom:4px';
  note.textContent = st.done > 0
    ? `Dependency scan covers ${st.done} of ${allFlows.length} flow versions. 🔗 subflow markers, flow types and the Dependencies tab cover only those — ${left.reads} version(s) left to read, ${left.calls} batched call(s) (${left.estLabel}).`
    : `${allFlows.length} flow versions loaded. The dependency scan reads ${left.reads} of them in ${left.calls} batched API call(s) (${left.estLabel}) and has not been run, so 🔗 subflow markers, refined flow types and the Dependencies tab have no data yet.`;

  const btn = document.createElement('button');
  btn.id = 'scanSubflowBtn';
  btn.className = 'btn btn-secondary btn-sm';
  btn.textContent = st.done > 0 ? '🔗 Resume dependency scan' : '🔗 Scan dependencies';
  btn.addEventListener('click', () => runDependencyScan(loadOrgUrl, loadSid));

  wrap.appendChild(note);
  wrap.appendChild(btn);
}

function hideScanOfferBar() {
  const wrap = document.getElementById('scanSubflowBtnWrap');
  if (wrap) wrap.style.display = 'none';
}

// v1.1.0 — the one line that says how much of this map was READ and how much was
// REUSED, plus anything the cache had to give up. Empty when the whole map was
// read live in this session (the pre-cache behaviour), so a small org that never
// had a cache sees exactly what it saw before.
function scanCacheNote(st) {
  const s = st || DependencyMap.getScanStatus();
  const bits = [];
  if (s.fromCache) {
    bits.push(DependencyMap.freshness().text);
    // QA 2026-07-29 (F5): the PRIMED path carries its own note too — e.g. the
    // 🧨 blast-radius reference detail was dropped from the stored entry for
    // size. This line used to surface cacheNote only when the cache was
    // 'disabled', so the primed path silently lost the one sentence that
    // explains why reference detail is missing.
    if (s.cacheNote) bits.push(s.cacheNote.charAt(0).toUpperCase() + s.cacheNote.slice(1) + '.');
  }
  else if (!flowStampsAvailable && allFlows.length) {
    bits.push('This org\'s Flow list does not carry a usable LastModifiedDate, so no dependency data is kept between opens — every scan reads the org live.');
  } else if (s.cacheState === 'disabled' && s.cacheNote) {
    bits.push(`No dependency cache is kept for this org: ${s.cacheNote}.`);
  }
  if (s.unread) bits.push(`${s.unread} version(s) were not read because their batched call failed — they are retried by resuming, not left as "no dependencies".`);
  if (s.cacheSaveNote) bits.push(s.cacheSaveNote.charAt(0).toUpperCase() + s.cacheSaveNote.slice(1) + '.');
  if (s.apiMismatch) bits.push('⚠️ The Salesforce API version used for the metadata reads is not the one this build caches against, so nothing was cached.');
  return bits.join(' ');
}

// ── Flow-list coverage ────────────────────────────────────────────────────────
// A Tooling query can cap server-side even when pagination is followed to
// exhaustion, and sfQueryAll reports records.length back as totalSize — so a
// truncated list is indistinguishable from a complete one. Every count this
// page quotes (and the dependency map itself) is derived from that list, so
// one COUNT() call is worth it to know whether we are quoting the whole org.
let flowListShortfall = null;   // rows the server has that we don't; null = unchecked

function flowCoverageNote() {
  if (!flowListShortfall) return '';
  return `⚠️ This org has ${allFlows.length + flowListShortfall} flow versions but the query returned only ${allFlows.length} — Salesforce capped the result. Every count and dependency below covers the ${allFlows.length} loaded versions only.`;
}

async function verifyFlowListCoverage(loadOrgUrl, loadSid, got) {
  flowListShortfall = null;
  try {
    const r = await sendBg({
      type: 'SF_QUERY', orgUrl: loadOrgUrl, sid: loadSid,
      query: 'SELECT COUNT() FROM Flow', tooling: true, _suppressError: true
    });
    // COUNT() is not supported on every Tooling object / API version. An
    // unusable answer means "not checked" — never "the list is complete".
    if (!r || r.error || typeof r.totalSize !== 'number') return;
    if (orgUrl !== loadOrgUrl) return;         // org switched while we asked
    if (r.totalSize <= got) return;
    flowListShortfall = r.totalSize - got;
    showScanOfferBar(loadOrgUrl, loadSid);     // surface the warning now
    if (document.getElementById('tab-dependencies').style.display !== 'none') {
      renderDependenciesTab();
    }
  } catch (_) { /* best-effort — a failed check must never break the load */ }
}

// Refine ProcessType from FlowDefinitionView.TriggerType (read on every load,
// no metadata scan needed), then repaint what is showing.
function patchFlowTypesFromDefinitions(loadOrgUrl) {
  if (loadOrgUrl && orgUrl !== loadOrgUrl) return;       // org switched meanwhile
  const map = (typeof DependencyMap.getDefinitionTriggerMap === 'function') ? DependencyMap.getDefinitionTriggerMap() : {};
  let changed = 0;
  for (const f of allFlows) {
    const t = map[f.ApiName];
    if (!t) continue;
    const refined = resolveFlowType(f.ProcessType, t);
    if (refined !== f.ProcessType) { f.ProcessType = refined; changed++; }
  }
  if (!changed) return;
  groupFlows();
  renderFlowList();
  if (document.getElementById('tab-dependencies')?.style.display !== 'none') renderDependenciesTab();
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
  // ↘ what this flow CALLS (user 2026-09-14: "this feature should also show
  // dependencies"). Honest about coverage: a flow the scan has not read says
  // "calls unknown", never "calls nothing".
  const callsChip = buildCallsChip(apiName, depMap);
  if (callsChip) groupInfo.appendChild(callsChip);

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

// ↘ calls N — the subflows this flow's scanned versions call (direct), with
// the whole tree in the tooltip; or "calls ?" when the scan has not read it.
function buildCallsChip(apiName, depMap) {
  if (!apiName || !depMap) return null;
  const st = (typeof DependencyMap.flowScanState === 'function') ? DependencyMap.flowScanState(apiName) : { state: 'unscanned' };
  const chip = document.createElement('span');
  chip.className = 'subflow-icon';
  chip.style.fontSize = '11px';
  if (st.state !== 'scanned') {
    chip.textContent = '↘ calls ?';
    chip.title = st.state === 'partial'
      ? `${st.scanned} of ${st.total} version(s) read by the dependency scan — what the others call is unknown. Use 🔗 Resume dependency scan.`
      : 'The dependency scan has not read this flow, so what it calls is UNKNOWN (not none). Use 🔗 Scan dependencies.';
    return chip;
  }
  const direct = [];
  for (const [called, callers] of Object.entries(depMap)) {
    if ((callers || []).some(c => c && c.apiName === apiName)) direct.push(called);
  }
  if (!direct.length) return null;
  const tree = (typeof DependencyMap.subflowClosure === 'function') ? DependencyMap.subflowClosure([apiName]) : { names: direct, truncated: false };
  chip.textContent = `↘ calls ${direct.length}`;
  chip.title = `Calls ${direct.length} subflow(s) directly: ${direct.sort().join(', ')}`
    + (tree.names.length > direct.length ? `\nWhole tree (${tree.names.length}): ${tree.names.join(', ')}${tree.truncated ? ' …' : ''}` : '');
  return chip;
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

  // #scanSubflowBtn is owned by showScanOfferBar() since P1 — it rebuilds the
  // wrap (note + button) on every state change, so binding it here would either
  // double-fire or bind a node that is about to be replaced.

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

  let selected = allFlows.filter(f => selectedIds.has(f.Id));

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

  // The check's live re-verification (TASK C) can discover that some selected
  // versions were deleted in the org by someone else; it drops them from
  // selectedIds, so the deletion set is recomputed here rather than kept from
  // before the check.
  selected = allFlows.filter(f => selectedIds.has(f.Id));
  if (!selected.length) return;

  // The depProceed can be an array of extra flows to deactivate+delete
  const extraToDelete = Array.isArray(depProceed) ? depProceed : [];

  // Final deletion set — the PARENTS first (live 2026-09-23: Salesforce
  // refuses to delete a flow while another flow's subflow element still
  // references it, so the child went first and failed while its four
  // parents were deleted after it). performDeletion also retries such
  // refusals once the parents are gone, whatever the order.
  const selectedIdSet = new Set(selected.map(f => f.Id));
  const toDelete = [...extraToDelete.filter(f => !selectedIdSet.has(f.Id))];
  for (const f of selected) {
    if (!toDelete.find(x => x.Id === f.Id)) toDelete.push(f);
  }

  // Step 4 (C4): ONE final summary confirm that names every version going
  // away and states the true stakes — flow-version deletes are PERMANENT
  // (Tooling deletes skip the Recycle Bin), so it requires the checkbox.
  const gate = await sftkOrgWriteGate(orgUrl);
  const finalOk = await sftkConfirmDestructive({
    title: `Delete ${toDelete.length} flow version${toDelete.length !== 1 ? 's' : ''}`,
    items: toDelete.map(f => ({
      label: `${f.MasterLabel} v${f.VersionNumber}`,
      sub: f.Status === 'Active' ? 'Active' : (extraToDelete.includes(f) ? 'added for dependencies' : ''),
    })),
    reversibility: 'permanent',
    confirmLabel: `🗑 Delete ${toDelete.length}`,
    // The subflow check above may have run against a map that was never fully
    // built, or against one whose edges came from the stored cache — say which
    // here rather than let the summary imply an all-clear it did not earn.
    undoHint: deleteCheckProvenance()
      + 'Only flows you backed up (⬇) can come back — via Restore mode in this tab.',
    production: gate.production ? { label: gate.label } : null,
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

  // P1 — "nothing depends on these flows" is only true if the map is complete.
  // Reading that verdict off a map that was never built (large org, no auto
  // scan) or was stopped part-way is a false all-clear on a PERMANENT delete,
  // so the user decides explicitly instead.
  if (!DependencyMap.isMetadataFetched()) {
    const choice = await askScanBeforeDelete();
    if (choice !== 'skip') {
      if (choice !== 'scan') return null;
      await runDependencyScan(orgUrl, sid);
      // Stopped again — re-affirm rather than assume consent carries over.
      if (!DependencyMap.isMetadataFetched() && await askScanBeforeDelete() !== 'skip') return null;
    }
  }

  // ── TASK C — the destructive path stays authoritative ────────────────────
  // "Nothing calls this flow" is a claim about every OTHER flow's metadata, so
  // one cached edge anywhere makes the whole verdict only as current as the
  // cache. Re-reading just the flows being deleted would prove nothing. What
  // does prove it is ONE live LastModifiedDate query over the whole Flow list,
  // followed by a batched re-read of whatever moved.
  //
  // deleteTrust() returns safe:true with zero extra work when the map was read
  // live in this session — so an org that never had a cache issues exactly the
  // requests it issued before this feature existed.
  _lastDeleteRecheck = null;
  let trust = DependencyMap.deleteTrust();
  if (!trust.safe && trust.needsLiveRecheck) {
    showScanProgress(true, '🔄 Re-checking cached dependency data against the org…');
    const rc = await DependencyMap.recheckForDelete(orgUrl, sid, (done, total) =>
      showScanProgress(true, `🔄 Re-reading changed flow versions… ${done} / ${total}`));
    showScanProgress(false);
    _lastDeleteRecheck = rc;
    trust = DependencyMap.deleteTrust();
    // The re-check can leave the map INCOMPLETE (a changed version that would
    // not re-read). The tab state has to follow, or the Dependencies tab keeps
    // rendering a tree it now knows is partial as if it were whole.
    metadataScanState = DependencyMap.isMetadataFetched() ? 'done' : 'partial';
    showScanOfferBar(orgUrl, sid);
    if (!rc.ok || !trust.safe) {
      const proceed = await askStaleBeforeDelete(rc.reason || trust.reason);
      if (proceed !== 'skip') return null;
    } else if (rc.added || rc.changed || rc.deleted) {
      // The org moved between opening the popup and pressing delete. The map is
      // current again, but the LIST on screen is not — say so before the
      // permanent step rather than after it.
      const cont = confirm(
        `The org changed since this list was loaded: ${rc.added} new, ${rc.changed} edited and ${rc.deleted} deleted flow version(s).\n\n` +
        'The dependency check below has been re-run against the current org, but the list on screen is out of date. ' +
        'Reload the flow list before deleting, or continue if you are sure of the versions you selected.');
      if (!cont) return null;
    }
    // Deleted-elsewhere versions must not be "deleted" again by us.
    if (rc.ok && Array.isArray(rc.flows)) {
      const liveIds = new Set(rc.flows.map(f => f.Id));
      const gone = selected.filter(f => !liveIds.has(f.Id));
      if (gone.length) {
        alert(`${gone.length} of the selected flow version(s) no longer exist in this org — they were removed from the deletion set.`);
        for (const g of gone) selectedIds.delete(g.Id);
        selected = selected.filter(f => liveIds.has(f.Id));
        if (!selected.length) return null;
      }
      // QA 2026-07-29 (F4): versions the re-check DISCOVERED (created since
      // this popup opened) are already in the dependency map — they can show
      // up as PARENTS in the modal below — but that modal resolves its
      // "Deactivate + delete selected parents" checkboxes against allFlows,
      // and walks grandparents through allFlows too. An unmerged parent would
      // let the user tick its box and then silently delete nothing, and its
      // own callers were never walked. Merge the discovered versions in and
      // regroup so both paths really see them.
      const knownIds = new Set(allFlows.map(f => f.Id));
      const discovered = rc.flows.filter(f => !knownIds.has(f.Id));
      if (discovered.length) {
        allFlows = allFlows.concat(discovered);
        orgFlowCount = allFlows.length;
        groupFlows();
        renderFlowList();
        updateSelectionSummary();
      }
    }
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

// Gate shown when a delete is about to be checked against an incomplete
// dependency map. Returns 'scan' | 'skip' | 'cancel'.
async function askScanBeforeDelete() {
  const st   = DependencyMap.getScanStatus();
  const left = DependencyMap.scanPlan(DependencyMap.pendingCount(allFlows));
  // QA 2026-07-29 (F6): st.done counts cache-RESTORED versions as covered.
  // Calling those "scanned" here erased the live-vs-restored distinction the
  // rest of this feature is built on — say which half is which.
  const cachedN = Math.min(Number(st.fromCache) || 0, st.done);
  const liveN   = Math.max(0, st.done - cachedN);
  const coverage = st.done > 0
    ? (cachedN > 0
      ? `Only ${st.done} of ${allFlows.length} flow versions are covered — ${liveN} scanned live this session, ${cachedN} restored from the stored cache.`
      : `Only ${st.done} of ${allFlows.length} flow versions have been scanned.`)
    : `None of the ${allFlows.length} flow versions in this org have been scanned.`;

  return new Promise((resolve) => {
    showModal(`
      <div class="modal-header modal-danger">
        <span class="modal-icon">⚠️</span>
        <h2>The subflow check has no data</h2>
      </div>
      <div class="modal-body">
        <p>${escHtml(coverage)} Without that map the toolkit cannot tell whether another flow calls the versions you are about to delete — and this delete is permanent.</p>
        <p class="modal-warning-text">Finishing the scan reads ${left.reads} flow version(s) in ${left.calls} batched API call(s) (${escHtml(left.estLabel)}). You can stop it at any point.</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="modalCancel">Cancel delete</button>
        <button class="btn btn-danger" id="modalSkip">Delete without checking</button>
        <button class="btn btn-primary" id="modalScan">Scan now (${left.calls} call${left.calls === 1 ? '' : 's'})</button>
      </div>
    `);
    document.getElementById('modalCancel').addEventListener('click', () => { closeModal(); resolve('cancel'); });
    document.getElementById('modalSkip').addEventListener('click',   () => { closeModal(); resolve('skip'); });
    document.getElementById('modalScan').addEventListener('click',   () => { closeModal(); resolve('scan'); });
  });
}

// TASK C gate. The map LOOKS complete but part of it came from the stored cache
// and the live re-check that would prove it current did not succeed. The map is
// not shown as trustworthy and it is not silently used — the user is told
// exactly what could not be proven and chooses. Returns 'skip' | 'cancel'.
async function askStaleBeforeDelete(reason) {
  return new Promise((resolve) => {
    showModal(`
      <div class="modal-header modal-danger">
        <span class="modal-icon">⚠️</span>
        <h2>The subflow check could not be re-verified</h2>
      </div>
      <div class="modal-body">
        <p>Part of this org's dependency map was reused from the stored cache, and ${escHtml(String(reason || 'it could not be re-checked against the org'))}.</p>
        <p class="modal-warning-text">That means “nothing calls these flows” has <b>not</b> been confirmed against the org as it is right now, and this delete is permanent. Reopening the popup (or resuming the scan) re-reads the org from scratch.</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="modalCancel">Cancel delete</button>
        <button class="btn btn-danger" id="modalSkip">Delete without a verified check</button>
      </div>
    `);
    document.getElementById('modalCancel').addEventListener('click', () => { closeModal(); resolve('cancel'); });
    document.getElementById('modalSkip').addEventListener('click',   () => { closeModal(); resolve('skip'); });
  });
}

// The provenance sentence on the final permanent-delete confirm. Says which of
// the three things actually happened — incomplete map, cache re-verified live,
// or cache NOT re-verified — instead of one caveat that covers all three badly.
function deleteCheckProvenance() {
  if (!DependencyMap.isMetadataFetched()) {
    return '⚠️ The subflow dependency check ran against an INCOMPLETE map — other flows may still call these versions. ';
  }
  const trust = DependencyMap.deleteTrust();
  const rc = _lastDeleteRecheck;
  if (!trust.safe) {
    return `⚠️ The subflow dependency check was NOT verified against the org (${trust.reason}) — other flows may still call these versions. `;
  }
  if (rc && rc.ok) {
    return `✔ The subflow check was re-verified against the org just now (${rc.rescanned || 0} changed version(s) re-read). `;
  }
  return '';
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
      <p>Some flows you are deleting are called as subflows by other flows. Deleting them will break those parent flows — and Salesforce refuses to delete a flow while another flow's subflow element still calls it, so "Proceed anyway" only works once those parents no longer call it. Ticking a parent deletes the parents first, then the flow.</p>
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
        <button class="btn btn-secondary btn-sm backup-one-btn" data-idx="${i}" title="Download a Metadata-XML backup zip — deployable as-is with the Salesforce CLI">⬇ Backup</button>
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
          const fe = sftkFriendlyError(e.message || String(e));
          btn.title = fe.message;
          // Tooltip-only errors are easy to miss during a pre-delete backup —
          // surface a visible one-line error under the row too.
          let errEl = btn.parentElement.querySelector('.backup-row-error');
          if (!errEl) {
            errEl = document.createElement('div');
            errEl.className = 'backup-row-error';
            errEl.style.cssText = 'flex-basis:100%;width:100%;font-size:11px;color:var(--danger)';
            btn.parentElement.style.flexWrap = 'wrap';
            btn.parentElement.appendChild(errEl);
          }
          errEl.textContent = `Backup failed: ${fe.message}${fe.hint ? ' — ' + fe.hint : ''}`;
          // Keep the raw API error reachable for copy-paste / support
          errEl.title = e.message || String(e);
        }
      });
    });

    // Download all
    document.getElementById('backupAllBtn').addEventListener('click', async () => {
      const allBtn = document.getElementById('backupAllBtn');
      allBtn.disabled = true;
      for (let i = 0; i < activeFlows.length; i++) {
        allBtn.textContent = `⏳ ${i + 1} / ${activeFlows.length}`;
        try { await downloadFlowBackup(activeFlows[i]); } catch (_) {}
      }
      allBtn.textContent = '✅ All Downloaded';
    });

    document.getElementById('modalCancel').addEventListener('click', () => { closeModal(); resolve(false); });
    document.getElementById('modalConfirm').addEventListener('click', () => { closeModal(); resolve(true); });
  });
}

// ============================================================
// Backup — download flow metadata as a Metadata-API XML zip (N1)
// ============================================================
// The zip is a real mdapi artifact: package.xml + flows/<ApiName>.flow —
// deployable as-is via Workbench or `sf project deploy start --metadata-dir`.
// backup.json (the full Tooling bundle) rides along inside the zip so the
// 📥 Restore mode keeps its exact pre-XML fidelity.
function downloadFlowBackupZip(flowEntries, orgUrlForBundle, zipName) {
  const bundle = {
    _info: 'Salesforce Toolkit flow backup bundle — restore via the 📥 Restore mode',
    backupDate: new Date().toISOString(),
    orgUrl: orgUrlForBundle,
    version: 2,
    flows: flowEntries,
  };
  const files = [
    { name: 'package.xml', data: sftkFlowPackageXml(flowEntries.map(f => f.ApiName)) },
    ...flowEntries.map(f => ({
      name: `flows/${String(f.ApiName || 'Flow').replace(/[^a-zA-Z0-9_]/g, '_')}.flow`,
      data: sftkFlowToXml(f.Metadata),
    })),
    { name: 'backup.json', data: JSON.stringify(bundle, null, 2) },
  ];
  const b64 = sftkBuildStoredZip(files);
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = zipName;
  a.click();
  URL.revokeObjectURL(url);
}

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

  const safeName = (flow.MasterLabel || 'Flow').replace(/[^a-zA-Z0-9_-]/g, '_');
  downloadFlowBackupZip([backup.flow], orgUrl, `${safeName}_v${flow.VersionNumber}_backup.zip`);
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
// The whole-tree backup (user 2026-09-14: "back up a full tree of flows and
// its subflows"). Returns the extra versions to add, the exclusions to
// disclose, or { blocked } when the scan has not read enough to KNOW the
// tree — a backup that claims "whole tree" over an unread flow would be a
// silent gap, so it refuses rather than guesses.
function planTreeBackup(selected) {
  const roots = [...new Set(selected.map(f => f.ApiName).filter(Boolean))];
  const unscanned = roots.filter(a => (DependencyMap.flowScanState(a) || {}).state !== 'scanned');
  if (unscanned.length) return { blocked: unscanned };
  const { names, truncated } = DependencyMap.subflowClosure(roots);
  const unread = names.filter(a => (DependencyMap.flowScanState(a) || {}).state !== 'scanned' && (allFlows.some(f => f.ApiName === a)));
  if (unread.length) return { blocked: unread };
  const managed = new Set((DependencyMap.getManagedFlows() || []).map(m => m.apiName));
  const selectedSet = new Set(selected.map(f => f.Id));
  const add = [], excluded = [];
  for (const a of names) {
    const versions = allFlows.filter(f => f.ApiName === a);
    if (!versions.length) {
      excluded.push({ apiName: a, why: managed.has(a) ? 'managed package — contents hidden by Salesforce, cannot be backed up' : 'not in this org' });
      continue;
    }
    const pick = versions.find(v => v.Status === 'Active')
      || versions.slice().sort((x, y) => (Number(y.VersionNumber) || 0) - (Number(x.VersionNumber) || 0))[0];
    if (!selectedSet.has(pick.Id)) add.push(pick);
  }
  return { add, excluded, truncated };
}

function confirmTreeBackup(selected, plan) {
  return new Promise(resolve => {
    const li = (t) => `<li>${escHtml(t)}</li>`;
    showModal(`
      <div class="modal-header">
        <span class="modal-icon">🌳</span>
        <h2>Back up ${selected.length} flow(s) with their subflow tree</h2>
      </div>
      <div class="modal-body">
        <p><strong>${plan.add.length}</strong> subflow version(s) will be added — the active version of each, or the newest when none is active:</p>
        <ul class="modal-list">${plan.add.map(f => li(`${f.MasterLabel} v${f.VersionNumber} (${f.Status})`)).join('') || li('none — the selected flows call no subflows that are not already selected')}</ul>
        ${plan.excluded.length ? `<p><strong>Not included</strong> (said, not skipped silently):</p><ul class="modal-list">${plan.excluded.map(x => li(`${x.apiName} — ${x.why}`)).join('')}</ul>` : ''}
        ${plan.truncated ? '<p class="modal-warning-text">⚠ The tree walk hit its size cap — deeper subflows are NOT included.</p>' : ''}
        <p style="font-size:12px;opacity:.8">One zip: every flow as .flow XML plus package.xml and backup.json — restorable in 📥 Restore mode.</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="modalCancel">Cancel</button>
        <button class="btn btn-primary" id="modalConfirm">⬇ Download ${selected.length + plan.add.length} flow(s)</button>
      </div>`);
    document.getElementById('modalCancel').addEventListener('click', () => { closeModal(); resolve(false); });
    document.getElementById('modalConfirm').addEventListener('click', () => { closeModal(); resolve(true); });
  });
}

async function onBackupClick() {
  let selected = allFlows.filter(f => selectedIds.has(f.Id));
  if (selected.length === 0) return;

  const btn = document.getElementById('backupBtn');
  let treeMode = false;
  if (document.getElementById('backupWithSubflows')?.checked) {
    const plan = planTreeBackup(selected);
    if (plan.blocked) {
      showModal(`
        <div class="modal-header modal-warn"><span class="modal-icon">🔗</span><h2>The tree is not known yet</h2></div>
        <div class="modal-body">
          <p>The dependency scan has not read ${plan.blocked.length} flow(s) in this tree, so what they call is UNKNOWN — a "whole tree" backup would silently miss subflows.</p>
          <ul class="modal-list">${plan.blocked.slice(0, 12).map(a => `<li>${escHtml(a)}</li>`).join('')}${plan.blocked.length > 12 ? `<li>… +${plan.blocked.length - 12} more</li>` : ''}</ul>
          <p>Run 🔗 Scan dependencies (or Resume) above, then back up again. Untick the tree option to back up only the selected versions.</p>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" id="modalCancel">Close</button></div>`);
      document.getElementById('modalCancel').addEventListener('click', closeModal);
      return;
    }
    if (!(await confirmTreeBackup(selected, plan))) return;
    selected = selected.concat(plan.add);
    treeMode = true;
  }
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

  if (flows.length < selected.length) {
    // Same inline notice style as the success toast below — a shortfall in a
    // backup must be visible where the user is looking, not only in a log.
    const warn = document.createElement('div');
    warn.className = 'result-toast';
    warn.innerHTML = `<div class="toast-error">⚠ ${selected.length - flows.length} of ${selected.length} flow(s) could not be read and are NOT in the zip.</div>`;
    const host = document.getElementById('flowList');
    if (host) host.insertBefore(warn, host.firstChild);
    setTimeout(() => warn.remove(), 9000);
  }
  const date = new Date().toISOString().slice(0, 10);
  downloadFlowBackupZip(flows, orgUrl,
    `SF_Backup_${date}${treeMode ? '_tree' : ''}_${flows.length}flow${flows.length !== 1 ? 's' : ''}.zip`);

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
    if (/\.zip$/i.test(file.name || '')) {
      // N1 XML backup zip — the full-fidelity bundle rides inside as backup.json.
      const entries = sftkReadStoredZip(new Uint8Array(await file.arrayBuffer()));
      if (!entries['backup.json']) throw new Error('backup.json missing from zip');
      backup = JSON.parse(new TextDecoder().decode(entries['backup.json']));
    } else {
      backup = JSON.parse(await file.text());   // legacy .json backups keep working
    }
  } catch (_) {
    showRestorePanelError('Invalid file — expected a Toolkit backup .zip (or a legacy .json backup).');
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
  let done = 0;
  showScanProgress(true, `📥 Restoring… ${done} / ${toRestore.length}`);
  for (const f of toRestore) {
    showScanProgress(true, `📥 Restoring… ${done} / ${toRestore.length}`);
    if (!f.Metadata || !f.FullName) {
      errors.push(`${f.MasterLabel}: missing metadata in backup`);
      done++;
      continue;
    }
    try {
      await performRestore({ flow: f });
      successes.push(f);
    } catch (e) {
      // Translate the raw deploy error; escaping happens ONCE at render time below.
      const fe = sftkFriendlyError(e.message || String(e));
      errors.push(`${f.MasterLabel}: ${fe.message}${fe.hint ? ' — ' + fe.hint : ''}`);
    }
    done++;
  }
  showScanProgress(false);

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

  // The write discipline (sftk-write.js): the deploy above is the write —
  // this re-read is the verify. A Draft restore adds a new version, so a
  // freshly-created Draft with a higher number than any this session saw
  // before is the confirmation (cheap: one Tooling query).
  const q = await sendBg({ type: 'SF_QUERY', orgUrl, sid, tooling: true, _suppressError: true,
    query: `SELECT Id FROM Flow WHERE FullName = '${String(fullName).replace(/'/g, "\\'")}' AND Status = 'Draft'` });
  if (!q || q.error || !(q.records && q.records.length)) {
    throw new Error('The restore was accepted by Salesforce, but the new Draft version could not be found on re-read — check Flow Builder before relying on it.');
  }
  return result;
}

// ============================================================
// Deactivation
// ============================================================
async function deactivateFlow(flow, journal, track) {
  const defId = flow.DefinitionId;
  if (!defId) throw new Error(`No DefinitionId on flow "${flow.MasterLabel}" — cannot deactivate`);

  // confirmed-by: onDeleteClick's sftkConfirmDestructive (the only path that
  // reaches deactivateFlow — via deleteOneFlow, via performDeletion)
  // Tooling API FlowDefinition requires a Metadata wrapper — activeVersionNumber 0 = deactivate.
  // The write discipline (sftk-write.js): the PATCH is the write, a re-read
  // of the flow's versions is the verify.
  const wr = await sftkWriteVerified({
    describe: `${flow.MasterLabel} deactivation`,
    journal,
    write: () => sendBg({
      type: 'SF_PATCH',
      orgUrl,
      sid,
      path: `services/data/v62.0/tooling/sobjects/FlowDefinition/${defId}`,
      body: { Metadata: { activeVersionNumber: 0 } }
    }),
    verify: async () => {
      const q = await sendBg({ type: 'SF_QUERY', orgUrl, sid, tooling: true, _suppressError: true,
        query: `SELECT Id FROM Flow WHERE DefinitionId = '${defId}' AND Status = 'Active'` });
      if (!q || q.error) return { ok: false, text: null };
      return { ok: !(q.records && q.records.length), text: null };
    },
  });
  if (!wr.accepted) throw new Error(`Deactivation failed for "${flow.MasterLabel}": ${(wr.raw && wr.raw.error) || 'refused'}`);
  if (!wr.ok) throw new Error(`Deactivation failed for "${flow.MasterLabel}": accepted but the org still shows an active version on re-read`);
  // History: this flow is now OFF where it was ON — track it so
  // performDeletion's undo can reactivate it if it never ends up deleted
  // and is never switched back on below.
  if (track) track.deactivated.set(flow.Id, flow);
}

async function deleteOneFlow(flow, done, total, journal, track) {
  const doDelete = async () => {
    // confirmed-by: onDeleteClick's sftkConfirmDestructive (the only caller
    // of deleteOneFlow, via performDeletion)
    // The write discipline (sftk-write.js): the DELETE is the write, a
    // Tooling re-query of the version id is the verify — gone = ok.
    const wr = await sftkWriteVerified({
      describe: `${flow.MasterLabel} v${flow.VersionNumber}`,
      journal,
      write: () => sendBg({ type: 'SF_TOOLING_DELETE', orgUrl, sid, sobject: 'Flow', id: flow.Id }),
      verify: async () => {
        const q = await sendBg({ type: 'SF_QUERY', orgUrl, sid, tooling: true, _suppressError: true,
          query: `SELECT Id FROM Flow WHERE Id = '${flow.Id}'` });
        if (!q || q.error) return { ok: false, text: null };
        return { ok: !(q.records && q.records.length), text: null };
      },
    });
    if (!wr.accepted) throw new Error((wr.raw && wr.raw.error) || 'refused');
    if (!wr.ok) throw new Error('deleted, but the org still shows this flow version on re-read');
    // History: a deleted flow version is gone for good — no undo can bring
    // it back. Tracked so the journal's undo can say which are permanent.
    if (track) track.deleted.add(flow.Id);
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
  await deactivateFlow(flow, journal, track);
  await wait(800);

  updateProgressBar(done, total, `Deleting: ${flow.MasterLabel} v${flow.VersionNumber}...`);
  try {
    await doDelete();
  } catch (e) {
    // The delete was refused AFTER the flow was switched off (live
    // 2026-09-23: "0 deleted, 1 failed" while the flow was now OFF). Put it
    // back the way it was and say what happened either way.
    let back = '';
    try {
      // confirmed-by: onDeleteClick's sftkConfirmDestructive (the only path
      // that reaches this retry — via deleteOneFlow, via performDeletion)
      // The write discipline (sftk-write.js): the PATCH is the write, a
      // re-query of this exact version's Status is the verify.
      const wr = await sftkWriteVerified({
        describe: `${flow.MasterLabel} reactivation`,
        journal,
        write: () => sendBg({ type: 'SF_PATCH', orgUrl, sid,
          path: `services/data/v62.0/tooling/sobjects/FlowDefinition/${flow.DefinitionId}`,
          body: { Metadata: { activeVersionNumber: flow.VersionNumber } } }),
        verify: async () => {
          const q = await sendBg({ type: 'SF_QUERY', orgUrl, sid, tooling: true, _suppressError: true,
            query: `SELECT Id FROM Flow WHERE DefinitionId = '${flow.DefinitionId}' AND VersionNumber = ${Number(flow.VersionNumber) || 0} AND Status = 'Active'` });
          if (!q || q.error) return { ok: false, text: null };
          return { ok: !!(q.records && q.records.length), text: null };
        },
      });
      if (!wr.accepted) back = ` It was switched OFF for the attempt and could NOT be switched back on (${(wr.raw && wr.raw.error) || 'refused'}) — switch it on in ⏻ Flow switches.`;
      else if (!wr.ok) back = ` It was switched OFF for the attempt and could NOT be switched back on (accepted, but not confirmed active on re-read) — switch it on in ⏻ Flow switches.`;
      else { back = ' It was switched OFF for the attempt and is switched back ON.'; if (track) track.reactivated.add(flow.Id); }
    } catch (e2) {
      back = ` It was switched OFF for the attempt and could NOT be switched back on (${e2.message || e2}) — switch it on in ⏻ Flow switches.`;
    }
    throw new Error(`${e.message || e}${back}`);
  }
}

// ============================================================
// Deletion
// ============================================================
async function performDeletion(toDelete, toDeactivate) {
  const total = toDelete.length;
  let deleted = 0;
  const errors = [];
  const successes = [];

  // History (sftk-history.js): one journal for this whole Delete button
  // press. deleteOneFlow / deactivateFlow write into it as they go; the
  // undo (built in the finally below) reactivates any flow left switched
  // off when it was never actually deleted — a deleted version itself has
  // no undo (Tooling deletes skip the Recycle Bin).
  const journal = sftkHistoryBegin({ tool: 'Flow delete', title: `🗑 ${total} flow version${total === 1 ? '' : 's'}`, orgUrl });
  const track = { deleted: new Set(), deactivated: new Map(), reactivated: new Set() };

  showProgressPanel(true);
  const statusMessages = [...STATUS_MESSAGES];
  let msgIdx = 0;
  const msgInterval = setInterval(() => {
    msgIdx = (msgIdx + 1) % statusMessages.length;
    const el = document.getElementById('progressStatus');
    if (el) el.textContent = statusMessages[msgIdx];
  }, 1500);

  try {
  for (const flow of toDelete) {
    updateProgressBar(deleted, total, `Deleting: ${flow.MasterLabel} v${flow.VersionNumber}...`);

    try {
      await deleteOneFlow(flow, deleted, total, journal, track);
      deleted++;
      successes.push(flow);
      selectedIds.delete(flow.Id);
    } catch (e) {
      const msg = e.message || String(e);
      if (msg.includes('CANNOT_DELETE_MANAGED_COMPONENT')) {
        errors.push({ flow, msg: `"${flow.MasterLabel}" is part of a managed package and cannot be deleted.` });
      } else {
        const fe = sftkFriendlyError(msg);
        errors.push({ flow, msg: `${flow.MasterLabel} v${flow.VersionNumber}: ${fe.message}${fe.hint ? ' — ' + fe.hint : ''}` });
      }
    }
  }

  // Retry what Salesforce refused for a subflow reference, now that the
  // flows deleted above (its callers) are gone — as many passes as make
  // progress, so a chain of any depth ends up deleted whatever the order.
  for (let pass = 0; pass < 6; pass++) {
    const again = errors.filter(e => /DEPENDENCY_EXISTS|subflow element/i.test(e.msg));
    if (!again.length || !successes.length) break;
    let progressed = false;
    for (const e of again) {
      updateProgressBar(deleted, total, `Retrying: ${e.flow.MasterLabel} v${e.flow.VersionNumber} (its callers are gone now)...`);
      try {
        await deleteOneFlow(e.flow, deleted, total, journal, track);
        deleted++; successes.push(e.flow); selectedIds.delete(e.flow.Id);
        errors.splice(errors.indexOf(e), 1); progressed = true;
      } catch (e2) {
        const fe = sftkFriendlyError(e2.message || String(e2));
        e.msg = `${e.flow.MasterLabel} v${e.flow.VersionNumber}: ${fe.message}${fe.hint ? ' — ' + fe.hint : ''}`;
      }
    }
    if (!progressed) break;
  }
  } finally {
    // Undo: only a flow left DEACTIVATED (never deleted, never switched
    // back on by the reactivation rescue above) has a previous state worth
    // restoring — reactivate it. A deleted flow version is gone for good.
    const stillOff = [...track.deactivated.values()].filter(f => !track.deleted.has(f.Id) && !track.reactivated.has(f.Id));
    const steps = stillOff.map(f => ({
      describe: `${f.MasterLabel} v${f.VersionNumber}: switch back ON`,
      // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
      msg: { type: 'SF_PATCH', path: `services/data/v62.0/tooling/sobjects/FlowDefinition/${f.DefinitionId}`,
        body: { Metadata: { activeVersionNumber: f.VersionNumber } } },
      verify: { query: `SELECT Id FROM Flow WHERE DefinitionId = '${f.DefinitionId}' AND VersionNumber = ${Number(f.VersionNumber) || 0} AND Status = 'Active'`,
        tooling: true, count: 1,
        text: { ok: `${f.MasterLabel} v${f.VersionNumber}: active again — verified by re-reading the org`,
                bad: `${f.MasterLabel} v${f.VersionNumber}: accepted by Salesforce, but the org still does not show it active` } },
    }));
    await sftkHistoryEnd(journal, {
      undo: steps.length
        ? { steps, note: track.deleted.size ? `${track.deleted.size} flow version(s) were deleted permanently and cannot be restored` : '' }
        : { none: 'deleted flow versions cannot be re-created' },
    });
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

  // Re-render the list FIRST, then the result toast: showResultToast puts
  // the toast inside #flowList, and renderFlowList() rebuilt that list right
  // after it — the "✅ N flow versions deleted" message was erased before
  // anyone could see it (live 2026-09-27: every delete run ended on the
  // progress panel with no result; the org was fine).
  renderFlowList();
  updateActionBar();
  updateSelectionSummary();
  showResultToast(successes.length, errors);
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
  const treeOpt = document.getElementById('backupTreeOpt');
  if (treeOpt) treeOpt.style.display = currentMode === 'backup' ? '' : 'none';
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

// A sidebar click can land on a tool tab before any Salesforce session exists
// (no SF tab open yet, or the session is still resolving). Every tool needs
// orgUrl + sid: show the normal connect state, exactly as loadFlows() does,
// instead of initialising a tool with nulls (user 2026-09-18: "Cannot read
// properties of null (reading 'replace')" at lightning-pages.js init).
function toolTabHasSession() {
  if (orgUrl && sid) return true;
  initSession();
  return false;
}

// ============================================================
// Lightning Pages Tab
// ============================================================
function initLightningPagesTab() {
  if (!toolTabHasSession()) return;
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
  if (!toolTabHasSession()) return;
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
  if (!toolTabHasSession()) return;
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
  if (!toolTabHasSession()) return;
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
  if (!toolTabHasSession()) return;
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
  if (!toolTabHasSession()) return;
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
    const st = DependencyMap.getScanStatus();
    noBanner.style.display = 'none';
    container.innerHTML = sftkCat(`Dependency map is building… ${st.done} / ${st.total} flow versions. This tab will refresh automatically when ready.`);
    // #scanProgress (with its Stop) lives in the Flows tab, so the scan would be
    // unstoppable from here without a second one.
    const msg = container.querySelector('.lp-robot-msg');
    if (msg) msg.id = 'depScanLive';
    const stopBtn = document.createElement('button');
    stopBtn.className = 'btn btn-secondary btn-sm';
    stopBtn.style.cssText = 'display:block;margin:10px auto 0';
    stopBtn.textContent = '✕ Stop scan';
    stopBtn.addEventListener('click', () => {
      DependencyMap.cancelScan();
      stopBtn.disabled = true;
      stopBtn.textContent = 'Stopping…';
    });
    container.appendChild(stopBtn);
    return;
  }

  // P1 — never rendered from a map that was never built. An empty tree here
  // would read as "this org has no subflow dependencies", which is a lie.
  // v1.1.0: 'skipped' no longer implies "no data" — a warm cache can have
  // covered most of the org while the remaining delta is still too large to
  // scan on open. When that is the case fall through to the partial branch
  // below, which shows what IS known WITH its coverage stated, rather than
  // hiding real data behind the offer.
  if (metadataScanState === 'skipped' && DependencyMap.getScanStatus().done === 0) {
    noBanner.style.display = 'none';
    container.innerHTML = '';
    container.appendChild(buildDepScanOffer());
    return;
  }

  if (!DependencyMap.isMetadataFetched()) {
    // Stopped part-way (or never started from this tab's point of view). Show
    // what IS known, with the coverage stated — the tree's own renderers add
    // their per-panel caveats on top.
    const st = DependencyMap.getScanStatus();
    noBanner.style.display = '';
    noBanner.textContent = (st.done > 0
      ? `⚠️ Partial data: ${st.done} of ${st.total} flow versions covered. Anything below is only what those versions reference — use “🔗 ${metadataScanState === 'skipped' ? 'Scan dependencies' : 'Resume dependency scan'}” in the Flows tab for the rest.`
      : '⚠️ No dependency data has been collected for this org yet — use “🔗 Scan dependencies” in the Flows tab.')
      + (scanCacheNote(st) ? ` ${scanCacheNote(st)}` : '')
      + (flowCoverageNote() ? ` ${flowCoverageNote()}` : '');
    if (st.done === 0) {
      container.innerHTML = '';
      container.appendChild(buildDepScanOffer());
      return;
    }
    DependencyMap.renderDependencyTreeTab(allFlows, container, orgUrl, sid);
    return;
  }

  // Scan complete — but "complete" only ever means every version the flow-list
  // query returned, which the server may have capped, AND it may mean "reused
  // from a cache whose stamps still match" rather than "read just now". Both
  // qualifications are printed; neither is implied away.
  const coverage = flowCoverageNote();
  const freshLine = scanCacheNote(DependencyMap.getScanStatus());
  const banner = [coverage, freshLine].filter(Boolean).join(' ');
  noBanner.style.display = banner ? '' : 'none';
  if (banner) noBanner.textContent = banner;
  DependencyMap.renderDependencyTreeTab(allFlows, container, orgUrl, sid);
}

// The Dependencies-tab twin of showScanOfferBar: same numbers, same honesty,
// with the button where the user is actually looking for the data.
function buildDepScanOffer() {
  const plan = DependencyMap.scanPlan(DependencyMap.pendingCount(allFlows));
  const st   = DependencyMap.getScanStatus();
  const box = document.createElement('div');
  box.className = 'info-banner';
  box.style.lineHeight = '1.6';

  const coverage = flowCoverageNote();
  if (coverage) {
    const warn = document.createElement('div');
    warn.style.cssText = 'color:var(--warning,#DD7A01);margin-bottom:6px';
    warn.textContent = coverage;
    box.appendChild(warn);
  }
  const cacheNote = scanCacheNote(st);
  if (cacheNote) {
    const cn = document.createElement('div');
    cn.style.cssText = 'color:var(--subtext,#706E6B);margin-bottom:6px';
    cn.textContent = cacheNote;
    box.appendChild(cn);
  }

  const p = document.createElement('div');
  // reads vs calls are different numbers since v1.1.0 — both are stated, because
  // "160 API calls" and "1600 flow versions" answer different questions and
  // quoting only one of them has been wrong in both directions.
  p.textContent = `${allFlows.length} flow versions loaded. Building the dependency map still needs to read ${plan.reads} of them, which costs ${plan.calls} batched API call(s) at ${plan.chunkSize} reads each (${plan.estLabel}, ${plan.measured ? 'measured on this org' : 'estimated'})`
    + (plan.auto
      ? '. It has not run — nothing on this tab has data until it does.'
      : `, so it is not started automatically above ${plan.autoMax} versions to read. Nothing on this tab has data until you start it.`);
  box.appendChild(p);

  // E3b — the quota half of the cost line. The estimate above renders without
  // it; the meter fills in async when the shared helper (sftk-api-budget.js)
  // resolves. Stale fill-ins are dropped once the box leaves the DOM.
  const meter = document.createElement('div');
  meter.style.cssText = 'color:var(--subtext,#706E6B);margin-top:4px;font-size:12px';
  box.appendChild(meter);
  (async () => {
    const b = await (typeof window.sftkApiBudget === 'function'
      ? window.sftkApiBudget(orgUrl, sid) : null);
    if (!meter.isConnected) return;
    if (!b) {
      if (typeof window.sftkApiBudget === 'function') meter.textContent = 'API budget unavailable for this org.';
      return;
    }
    const over = plan.calls > b.remaining;
    meter.textContent = `Org API budget: ${b.remaining.toLocaleString()} of ${b.max.toLocaleString()} daily calls remaining`
      + (over ? ` — ⚠ this scan's ${plan.calls.toLocaleString()} call(s) may exhaust it.` : '.');
  })();

  const btn = document.createElement('button');
  btn.className = 'btn btn-primary btn-sm';
  btn.style.marginTop = '8px';
  btn.textContent = `🔗 Scan dependencies (${plan.calls} call${plan.calls === 1 ? '' : 's'})`;
  btn.addEventListener('click', () => runDependencyScan(orgUrl, sid));
  box.appendChild(btn);
  return box;
}

// ============================================================
// Modal helpers
// ============================================================
// QA 2026-07-31: this modal had no dialog semantics, no Escape, no focus
// management and no focus trap — and it is what confirms FLOW DELETION. A
// keyboard user landed behind the overlay, tabbing through the page under it
// with no way out but the mouse. Screen readers never announced a dialog had
// opened at all.
let _modalRestoreFocus = null;
let _modalKeyHandler   = null;

function _modalFocusable(box) {
  return [...box.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.disabled && el.offsetParent !== null);
}

function showModal(html) {
  const overlay = document.getElementById('modalOverlay');
  const box = document.getElementById('modalBox');
  box.innerHTML = html;
  overlay.style.display = '';

  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  // Name the dialog from its own heading when it has one.
  const hdr = box.querySelector('.modal-header, h2, h3');
  if (hdr) {
    if (!hdr.id) hdr.id = 'sftkModalTitle';
    overlay.setAttribute('aria-labelledby', hdr.id);
  } else {
    overlay.removeAttribute('aria-labelledby');
  }

  _modalRestoreFocus = document.activeElement;
  const focusables = _modalFocusable(box);
  // Prefer the first non-destructive control so Enter never lands on Delete.
  (focusables.find(el => !/delete|remove|destructive|danger/i.test(el.className + ' ' + el.id))
    || focusables[0] || box).focus?.();

  _modalKeyHandler = e => {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
    if (e.key !== 'Tab') return;
    const list = _modalFocusable(box);
    if (!list.length) return;
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', _modalKeyHandler, true);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  }, { once: true });
}

function closeModal() {
  const box = document.getElementById('modalBox');
  box.style.width = ''; // reset any per-modal width override (e.g. debug panel)
  box.innerHTML = '';
  const overlay = document.getElementById('modalOverlay');
  overlay.style.display = 'none';
  overlay.removeAttribute('role');
  overlay.removeAttribute('aria-modal');
  overlay.removeAttribute('aria-labelledby');
  if (_modalKeyHandler) {
    document.removeEventListener('keydown', _modalKeyHandler, true);
    _modalKeyHandler = null;
  }
  // Send focus back where it came from, or the page loses it entirely.
  try { _modalRestoreFocus?.focus?.(); } catch (_) {}
  _modalRestoreFocus = null;
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

// onCancel is optional: only the dependency scan runs long enough to need a
// Stop button, so the button is injected here rather than sitting in popup.html
// for every other caller (backup, restore, delete) that passes no handler.
function showScanProgress(show, text, onCancel) {
  const el = document.getElementById('scanProgress');
  const btn = document.getElementById('scanCancelBtn');
  if (show) {
    el.style.display = '';
    const textEl = document.getElementById('scanProgressText');
    if (textEl && text) textEl.textContent = text;
    if (onCancel) {
      const b = btn || el.appendChild(Object.assign(document.createElement('button'), {
        id: 'scanCancelBtn', className: 'btn btn-secondary btn-sm', textContent: '✕ Stop'
      }));
      b.style.cssText = 'margin-left:auto;flex-shrink:0';
      b.onclick = onCancel;
    } else if (btn) {
      btn.style.display = 'none';
      btn.onclick = null;
    }
  } else {
    el.style.display = 'none';
    if (btn) { btn.style.display = 'none'; btn.onclick = null; }
  }
}

function showSessionError(msg, rawDetail) {
  const msgEl = document.getElementById('sessionErrorMsg');
  msgEl.textContent = msg;
  // Keep the raw API error reachable for copy-paste / support without surfacing it
  msgEl.title = (rawDetail && rawDetail !== msg) ? rawDetail : '';
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
  } else if (!sid && /Not connected to a Salesforce org/.test(String(errMsg))) {
    // A feature fired before any session existed (no SF tab open). The waiting
    // state polls and auto-connects — better than a static error banner.
    _flowsLoaded = false;
    initSession();
  } else {
    const fe = sftkFriendlyError(errMsg);
    showSessionError(fe.message + (fe.hint ? ' — ' + fe.hint : ''), String(errMsg));
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

  // Toggle. a11y: aria-expanded rides along with the .open class in every
  // path — the chip declares aria-haspopup, so AT needs the open/closed state.
  const existing = document.getElementById('topbarOrgDropdown');
  if (existing) { existing.remove(); chip.classList.remove('open'); chip.setAttribute('aria-expanded', 'false'); return; }
  chip.classList.add('open');
  chip.setAttribute('aria-expanded', 'true');

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
    chip.setAttribute('aria-expanded', 'false');
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
    spinner.innerHTML = sftkCatSm('Detecting sessions…');
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
        const item = document.createElement('button');
        item.className = 'home-org-dd-item' + (isCurrent ? ' home-org-dd-item-active' : '');
        // Same rows as the home org switcher — same classes, so the two
        // lists cannot drift apart again.
        item.innerHTML = `
          <span class="home-org-dd-dot ${sess.online ? 'home-org-dd-dot-live' : 'home-org-dd-dot-stored'}"></span>
          <span class="home-org-dd-text">
            <span class="home-org-dd-name">${escHtml(name)}</span>
            <span class="home-org-dd-host">${escHtml(host)}</span>
          </span>
          ${sess.stored ? '<span class="home-org-dd-tag">credentials</span>' : ''}
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
  flowListShortfall  = null;
  hideScanOfferBar();   // its numbers describe the OLD org

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
    // Any Record… trigger (before save, after save, before delete, and
    // whatever Salesforce adds next) is a record-triggered flow.
    if (/^Record/i.test(String(triggerType || ''))) return 'RecordTriggeredFlow';
    switch (triggerType) {
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
    // 'Flow' IS the API name for screen flows — showing it raw reads like
    // "untyped" (user report 2026-08-04: "It won't recognize screen flow").
    case 'Flow':               return 'Screen Flow';
    case 'AutoLaunchedFlow':   return 'Auto-launched Flow';
    case 'RecordTriggeredFlow':return 'Record-Triggered Flow';
    case 'ScheduledFlow':      return 'Scheduled Flow';
    case 'PlatformEventFlow':  return 'Platform Event Flow';
    case 'Orchestrator':       return 'Orchestrator';
    // Legacy automations whose API names don't say what they are.
    case 'Workflow':           return 'Process Builder';
    case 'CustomEvent':        return 'Platform Event Process';
    case 'InvocableProcess':   return 'Invocable Process';
    // Everything else (PromptFlow, RoutingFlow, TransactionSecurityFlow,
    // CheckoutFlow, …): split the camel-case so new types Salesforce adds
    // read as words without needing a case here.
    default:                   return String(pt || '').replace(/([a-z])([A-Z])/g, '$1 $2');
  }
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}
