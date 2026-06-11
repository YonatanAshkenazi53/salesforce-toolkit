'use strict';
// ============================================================
// Salesforce Data Studio
// Full-page multi-org data management tool.
//
// Views:
//   Org Map   — all detected orgs, sync status, drift badges
//   Profiles  — saved deployment profiles (object tree configs)
//   Transfer  — run a profile transfer with live progress
//   Schedule  — automate profile runs on a cron interval
//   History   — log of past transfer runs
//
// The profile data model (stored in chrome.storage.local):
//   Profile {
//     id, name, createdAt, updatedAt,
//     tree: TreeNode               ← root node
//   }
//
//   TreeNode {
//     objectType,                  ← API name (root) or childSObject (children)
//     where?,                      ← SOQL WHERE clause fragment
//     children: ChildNode[]
//   }
//
//   ChildNode extends TreeNode {
//     relationshipName,            ← e.g. "Contacts"
//     field,                       ← lookup field on child, e.g. "AccountId"
//   }
//
// Tree runtime state (_meta fields — never stored):
//   _count, _expanded, _loading, _relsLoaded, _availableRels[]
// ============================================================

// ── State ─────────────────────────────────────────────────────
let _orgUrl      = null;
let _sid         = null;
let _allSessions = [];
let _currentView = 'orgs';
let _profiles    = [];
let _history     = [];
let _orgs        = {};

// Feature 15 — Dark mode
let _darkMode    = false;

// Feature 14 — Activity log { viewKey: ISO timestamp }
let _activityLog = {};

// Profile builder state
let _editingProfile  = null;  // Profile being built / edited (in-memory)
let _describeCache   = {};    // objectType → describe result
let _refFieldCache   = {};    // Lookup resolution: refObjectType → [{ name, label }] | 'loading' | null

// Transfer state
let _transferProfile      = null;
let _transferSrc          = null;
let _transferTgt          = null;
let _transferDryRun       = false;   // Feature 5 — dry run
// Write mode — 'insert' (always create) or 'upsert' (match on an external-Id
// field, update existing target records instead of duplicating). Upsert
// applies to the ROOT object of the profile (v1).
let _transferWriteMode    = 'insert';
let _transferUpsertField  = '';
// Per-run record filter overrides — pathKey → { where, recordIds }.
// These override the saved profile for a single run without mutating it.
// Cleared whenever the selected profile changes.
let _transferNodeFilters  = {};
// Per-run ORG overrides — let the user switch source/target on the Run
// Transfer page (or via the org card's Transfer button) without editing
// the saved profile. null = use the profile's org. Cleared on profile change.
let _transferOrgOverride  = { src: null, tgt: null };

// Phase 3A — Reconcile view. The profile currently being reconciled (root
// object only in v1). Selection state lives in the render closure.
let _reconcileProfile = null;

// ── DOM helpers ───────────────────────────────────────────────
const esc = s => String(s ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const eid = id => document.getElementById(id);
const setMain = html => { const m = eid('dsMain'); if (m) m.innerHTML = html; };

// ── Background bridge ─────────────────────────────────────────
function sendBg(msg) {
  return new Promise(r =>
    chrome.runtime.sendMessage(msg, res =>
      r(res || { error: chrome.runtime.lastError?.message || 'No response' })
    )
  );
}

// Field types that count as "string-displayable" — used by the Pick Records
// modal + Transfer record-filter modal to pick which fields to show.
// Hoisted to module scope so the same set is shared instead of duplicated.
const STRING_TYPES = new Set([
  'string', 'email', 'phone', 'url', 'textarea', 'picklist', 'id', 'reference', 'autonumber'
]);

// SOQL string-literal — wraps the value in single quotes and escapes
// embedded backslashes + single quotes so values like O'Brien or paths
// don't break the query. Use whenever a Salesforce-record value flows
// into a SOQL `WHERE field = '…'` or `IN ('…')` clause.
function soqlStrLit(v) {
  return "'" + String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

// ── Session error detection & recovery ────────────────────────
// Match any string that Salesforce or the background script uses for a stale SID.
function isSessionError(errStr) {
  if (!errStr) return false;
  const s = String(errStr).toLowerCase();
  return s.includes('session_expired')           // background: data = "SESSION_EXPIRED"
    || s.includes('session expired')             // background: result = "Session expired"
    || s.includes('invalid_session_id')          // Salesforce API errorCode
    || s.includes('invalid session')
    || s.includes('session invalid')
    || s.includes('expired session')
    || s.includes('"errorcode":"invalid_session')
    || s === '401'
    || s.includes('http 401')
    || s.includes('unauthorized');
}

// Check the *full* response object — background may put the code in .data, .result,
// or .error depending on which path produced the response.
function isSessionResult(res) {
  if (!res) return false;
  return isSessionError(res.error)
    || isSessionError(res.data)
    || isSessionError(res.result)
    || isSessionError(res.status);
}

// Show a sticky recovery banner at the top of ds-main.
// Replaces any existing banner.  Calling reconnectSession() refreshes
// all open-tab sessions; caller can pass onReconnect to re-run their action.
function showSessionBanner(orgUrl, onReconnect = null) {
  eid('dsSessionBanner')?.remove();

  const label = orgLabel(orgUrl || _orgUrl || '');
  const banner = document.createElement('div');
  banner.id = 'dsSessionBanner';
  banner.className = 'ds-session-banner';
  banner.innerHTML = `
    <span class="ds-session-banner-icon">🔑</span>
    <div class="ds-session-banner-body">
      <strong>Salesforce session expired — ${esc(label)}</strong>
      <span>Open that org in any Chrome tab (even just the home page), then click Reconnect.</span>
    </div>
    <button class="ds-btn ds-btn-primary ds-btn-sm" id="dsSessionReconnect">🔄 Reconnect</button>
    <button class="ds-btn ds-btn-sm ds-btn-xs" id="dsSessionDismiss">✕</button>`;

  const main = eid('dsMain');
  if (main) main.insertAdjacentElement('afterbegin', banner);

  eid('dsSessionDismiss')?.addEventListener('click', () => banner.remove());

  eid('dsSessionReconnect')?.addEventListener('click', async () => {
    const reconnBtn = eid('dsSessionReconnect');
    if (reconnBtn) { reconnBtn.disabled = true; reconnBtn.textContent = '🔄 Reconnecting…'; }

    // Re-detect all open SF sessions
    const allRes = await sendBg({ type: 'GET_ALL_SF_SESSIONS' });
    _allSessions = allRes?.sessions || [];
    _allSessions.forEach(s => upsertOrg(s.orgUrl, s.label));

    const session = await sendBg({ type: 'GET_SF_SESSION' });
    if (session?.orgUrl && session?.sid) {
      _orgUrl = session.orgUrl;
      _sid    = session.sid;
    }

    banner.remove();
    showToast('Session refreshed — retrying…', 'success', 3000);

    if (onReconnect) {
      await onReconnect();
    } else {
      renderView(_currentView);
    }
  });
}

// Convenience: detect session error in a result and show banner if so.
// Returns true if it was a session error (caller should abort).
function handleSessionError(result, orgUrl, onReconnect = null) {
  if (!isSessionResult(result)) return false;
  showSessionBanner(orgUrl, onReconnect);
  showToast('Session expired — see the banner above', 'error', 5000);
  return true;
}

// ── Storage helpers ───────────────────────────────────────────
async function storageLoad() {
  const d = await chrome.storage.local.get([
    'sftk_profiles','sftk_history','sftk_orgs',
    'ds_dark_mode','ds_activity_log'
  ]);
  _profiles     = d.sftk_profiles   || [];
  _history      = d.sftk_history    || [];
  _orgs         = d.sftk_orgs       || {};
  _darkMode     = d.ds_dark_mode    || false;
  _activityLog  = d.ds_activity_log || {};

  // One-time purge of storage keys orphaned by the feature trim
  // (credential vault, schedule, scan map, snapshots, manual connections).
  // Harmless if absent; fire-and-forget so it doesn't slow first paint.
  chrome.storage.local.remove([
    'ds_stored_orgs', 'ds_connections', 'ds_scans', 'ds_scan_results',
    'org_snapshots',  'sftk_debug_enabled_legacy'
  ]).catch(() => {});
}


async function storageSaveProfiles() {
  await chrome.storage.local.set({ sftk_profiles: _profiles });
}

async function storageSaveHistory() {
  if (_history.length > 100) _history = _history.slice(-100);
  await chrome.storage.local.set({ sftk_history: _history });
}

async function storageSaveOrgs() {
  await chrome.storage.local.set({ sftk_orgs: _orgs });
}

// ── Modal helpers ─────────────────────────────────────────────
function showModal(html) {
  const overlay = eid('dsModal');
  const box     = eid('dsModalBox');
  if (!overlay || !box) return;
  box.innerHTML = html;
  overlay.style.display = 'flex';
}

function closeModal() {
  const overlay = eid('dsModal');
  if (overlay) overlay.style.display = 'none';
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    openCommandPalette();
  }
});

// ── Utility ───────────────────────────────────────────────────
function orgLabel(orgUrl) {
  if (!orgUrl) return 'Unknown';
  const stored = _orgs[orgUrl]?.label;
  if (stored) return stored;
  try { return new URL(orgUrl).hostname.replace('.my.salesforce.com','').replace('.salesforce.com',''); }
  catch { return orgUrl; }
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h/24)}d ago`;
}

function genId(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`; }

// ── Describe (cached) ─────────────────────────────────────────
// Default org/sid: if a profile is currently being edited, use its sourceOrg
// (so the builder describes against the org the profile actually targets).
// Otherwise fall back to the initially-detected page session.
async function describe(objectType, orgUrl = null, sid = null) {
  if (!orgUrl || !sid) {
    const sess = (typeof _builderSession === 'function') ? _builderSession() : null;
    orgUrl = orgUrl || sess?.orgUrl || _orgUrl;
    sid    = sid    || sess?.sid    || _sid;
  }
  const key = `${orgUrl}:${objectType}`;
  if (_describeCache[key]) return _describeCache[key];
  const res = await sendBg({
    type: 'SF_REST_GET',
    orgUrl,
    sid,
    path:  `services/data/v62.0/sobjects/${objectType}/describe`
  });
  if (res.error) return null;
  _describeCache[key] = res;
  return res;
}

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // ── Debug recorder (shared debug-modal.js) ────────────────
  // initDebugMode looks for #dbgBtn (added to studio.html top bar).
  // debug-modal.js reads window._orgUrl for the org label in exports.
  if (typeof initDebugMode === 'function') initDebugMode();

  await storageLoad();

  // Detect current session
  const session = await sendBg({ type: 'GET_SF_SESSION' });
  if (session?.orgUrl && session?.sid) {
    _orgUrl = session.orgUrl;
    _sid    = session.sid;
    upsertOrg(_orgUrl);
  }

  // All open org sessions
  const allRes = await sendBg({ type: 'GET_ALL_SF_SESSIONS' });
  _allSessions = (allRes?.sessions || []);
  _allSessions.forEach(s => upsertOrg(s.orgUrl, s.label));
  await storageSaveOrgs();

  // Org chip removed 2026-05-16 — the chip had no meaningful effect anymore.
  // Every Data Studio view that does work now reads its orgs from the
  // selected profile: Data Deployment / Run Transfer / Schedule / Field
  // Mapping all use `profile.sourceOrg` + `profile.targetOrg`. The Profile
  // Builder still needs *an* org to describe against, but it now uses
  // `_editingProfile.sourceOrg` directly. `_orgUrl`/`_sid` are kept in
  // memory for places that haven't fully migrated yet, but they're set
  // once from the initial session detection and never user-switchable.

  // Wire nav
  document.querySelectorAll('.ds-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _currentView = btn.dataset.view;
      renderView(_currentView);
    });
  });

  // ── Global action delegate — replaces all inline onclick= (blocked by CSP) ──
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-dsaction]');
    if (!el) return;
    e.preventDefault();
    const action = el.dataset.dsaction;
    const arg    = el.dataset.arg  || '';
    switch (action) {
      case 'closeModal':            closeModal(); break;
      case 'editOrgLabel':          window.editOrgLabel?.(arg); break;
      case 'startTransferFrom':     window.startTransferFrom?.(arg); break;
      case 'removeOrg':             window.removeOrg?.(arg); break;
      case 'runProfile':            window.runProfile?.(arg); break;
      case 'editProfile':           window.editProfile?.(arg); break;
      case 'cloneProfile':          window.cloneProfile?.(arg); break;
      case 'deleteProfile':         window.deleteProfile?.(arg); break;
      case 'refreshState':          window.refreshProfileState?.(arg); break;
      case 'openReconcile':         window.openReconcile?.(arg); break;
      case 'retryFailed':           window.retryFailedRun?.(arg); break;
      case 'showSecurity':          showSecurityModal(); break;
      case 'switchView': {
        // Navigate to another view (e.g. the "Go to Org Map" link)
        const navBtn = document.querySelector(`.ds-nav-btn[data-view="${arg}"]`);
        if (navBtn) { navBtn.click(); }
        else if (arg) {
          document.querySelectorAll('.ds-nav-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.view === arg));
          _currentView = arg;
          renderView(arg);
        }
        break;
      }
    }
  });

  // Apply persisted dark mode immediately
  applyDarkMode(_darkMode);

  // Wire dark mode toggle
  eid('dsDarkToggle')?.addEventListener('click', () => applyDarkMode(!_darkMode));

  // Wire command palette button
  eid('dsCmdPaletteBtn')?.addEventListener('click', () => openCommandPalette());

  // Wire security badge
  eid('dsSecurityBtn')?.addEventListener('click', showSecurityModal);

  // ── Back to Toolkit button ────────────────────────────────────
  // The Data Studio runs in its own tab. Closing this tab returns the user
  // to wherever they were before — typically the Toolkit popup or the SF tab.
  eid('dsBackToToolkit')?.addEventListener('click', () => {
    // Close this Studio tab; falls back to window.close() for edge cases
    if (typeof chrome !== 'undefined' && chrome.tabs?.getCurrent) {
      chrome.tabs.getCurrent(tab => {
        if (tab?.id) chrome.tabs.remove(tab.id);
        else window.close();
      });
    } else {
      window.close();
    }
  });

  // Brand name = home button → Connected Orgs (the landing view).
  document.querySelector('.ds-brand')?.addEventListener('click', () => {
    document.querySelectorAll('.ds-nav-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.view === 'orgs'));
    _currentView = 'orgs';
    renderView('orgs');
  });

  // First-run: if no orgs known, show welcome instead of an empty list.
  const isFirstRun = !_orgUrl && !_allSessions.length
    && !Object.keys(_orgs).length;
  if (isFirstRun) {
    renderWelcome();
  } else {
    renderView('orgs');
  }

  // First-run guided tour — shown once, ever
  maybeRunStudioTour();
});

// ── First-run guided tour (Data Studio) ───────────────────────
function maybeRunStudioTour() {
  if (!window.SFTKOnboard) return;
  window.SFTKOnboard.firstRun('studio', [
    {
      title: 'Welcome to Data Studio',
      text:  'A quick tour of how to move and compare data across your Salesforce orgs.'
    },
    {
      selector: '.ds-nav',
      title: 'Navigate',
      text:  'Org Map, Connected Orgs, Data Deployment, Schedule, History, scans and schema views — all from here.'
    },
    {
      selector: '#dsCmdPaletteBtn',
      title: 'Command palette',
      text:  'Press Ctrl+K to jump to any view or action instantly — no clicking around.'
    },
    {
      title: "You're ready",
      text:  'Connect an org or open the Org Map to begin. Everything stays local to your browser.'
    }
  ]);
}

function upsertOrg(orgUrl, label = null) {
  if (!orgUrl) return;
  if (!_orgs[orgUrl]) _orgs[orgUrl] = { label: label || orgLabel(orgUrl), firstSeen: new Date().toISOString() };
  _orgs[orgUrl].lastSeen = new Date().toISOString();
  if (label) _orgs[orgUrl].label = label;
}

// ════════════════════════════════════════════════════════════════
// TOAST NOTIFICATIONS
// ════════════════════════════════════════════════════════════════
function showToast(message, type = 'info', durationMs = 3500) {
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const container = eid('dsToastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `ds-toast ds-toast-${type}`;
  toast.innerHTML = `<span class="ds-toast-icon">${icons[type] || 'ℹ️'}</span><span>${esc(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('ds-toast-out');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, durationMs);
}

// ════════════════════════════════════════════════════════════════
// DARK MODE — Feature 15
// ════════════════════════════════════════════════════════════════
function applyDarkMode(on) {
  _darkMode = on;
  document.documentElement.classList.toggle('ds-dark', on);
  const btn = eid('dsDarkToggle');
  if (btn) {
    btn.textContent = on ? '☀️' : '🌙';
    btn.title = on ? 'Switch to light mode' : 'Switch to dark mode';
  }
  chrome.storage.local.set({ ds_dark_mode: on });
}

// ════════════════════════════════════════════════════════════════
// ACTIVITY LOG — Feature 14
// ════════════════════════════════════════════════════════════════
function recordActivity(view) {
  _activityLog[view] = new Date().toISOString();
  chrome.storage.local.set({ ds_activity_log: _activityLog });
}

// ════════════════════════════════════════════════════════════════
// COMMAND PALETTE — Feature 16
// ════════════════════════════════════════════════════════════════
const CMD_VIEWS = [
  { icon: '🌐', label: 'Org Map',           view: 'map',       desc: 'Visual org overview' },
  { icon: '🔌', label: 'Connected Orgs',    view: 'orgs',      desc: 'Manage connections' },
  { icon: '📦', label: 'Data Deployment',   view: 'profiles',  desc: 'Profiles + run transfer' },
  { icon: '📅', label: 'Schedule',          view: 'schedule',  desc: 'Automate transfers' },
  { icon: '📜', label: 'History',           view: 'history',   desc: 'Past transfer runs' },
  { icon: '🔍', label: 'Scan Map',          view: 'scans',     desc: 'Compare record counts' },
  { icon: '🛡',  label: 'Deploy Readiness', view: 'readiness', desc: 'Schema compatibility' },
  { icon: '🕸',  label: 'Schema View',      view: 'schema',    desc: 'Flow & object graph' },
];

function openCommandPalette() {
  // Remove any existing palette
  eid('dsCmdOverlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'dsCmdOverlay';
  overlay.className = 'ds-cmd-overlay';

  let activeIdx = 0;

  function buildItems(filter) {
    const q = filter.toLowerCase().trim();
    const navItems = CMD_VIEWS.filter(v =>
      !q || v.label.toLowerCase().includes(q) || v.desc.toLowerCase().includes(q)
    );
    const profileItems = q
      ? _profiles.filter(p => p.name.toLowerCase().includes(q))
      : [];
    return { navItems, profileItems };
  }

  function render(filter = '') {
    const { navItems, profileItems } = buildItems(filter);
    const total = navItems.length + profileItems.length;
    if (activeIdx >= total) activeIdx = Math.max(0, total - 1);

    let html = '';

    if (navItems.length) {
      html += `<div class="ds-cmd-section-hdr">Navigate</div>`;
      navItems.forEach((v, i) => {
        const cls = i === activeIdx ? ' ds-cmd-active' : '';
        html += `<div class="ds-cmd-item${cls}" data-cmd-view="${esc(v.view)}">
          <span class="ds-cmd-item-icon">${v.icon}</span>
          <span class="ds-cmd-item-label">${esc(v.label)}</span>
          <span class="ds-cmd-item-desc">${esc(v.desc)}</span>
        </div>`;
      });
    }

    if (profileItems.length) {
      html += `<div class="ds-cmd-section-hdr">Run Profile</div>`;
      profileItems.forEach((p, i) => {
        const idx = navItems.length + i;
        const cls = idx === activeIdx ? ' ds-cmd-active' : '';
        html += `<div class="ds-cmd-item${cls}" data-cmd-profile="${esc(p.id)}">
          <span class="ds-cmd-item-icon">▶️</span>
          <span class="ds-cmd-item-label">${esc(p.name)}</span>
          <span class="ds-cmd-item-badge">Run</span>
        </div>`;
      });
    }

    if (!html) {
      html = `<div class="ds-cmd-empty">No results for "<strong>${esc(filter)}</strong>"</div>`;
    }

    list.innerHTML = html;

    // Re-wire click handlers
    list.querySelectorAll('[data-cmd-view]').forEach(el => {
      el.addEventListener('click', () => navigateTo(el.dataset.cmdView));
    });
    list.querySelectorAll('[data-cmd-profile]').forEach(el => {
      el.addEventListener('click', () => {
        closePalette();
        window.runProfile?.(el.dataset.cmdProfile);
      });
    });
  }

  function navigateTo(view) {
    closePalette();
    document.querySelectorAll('.ds-nav-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.view === view));
    _currentView = view;
    renderView(view);
  }

  function closePalette() {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
    const { navItems, profileItems } = buildItems(input.value);
    const total = navItems.length + profileItems.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = (activeIdx + 1) % Math.max(1, total);
      render(input.value);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = (activeIdx - 1 + Math.max(1, total)) % Math.max(1, total);
      render(input.value);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx < navItems.length) {
        navigateTo(navItems[activeIdx].view);
      } else {
        const p = profileItems[activeIdx - navItems.length];
        if (p) { closePalette(); window.runProfile?.(p.id); }
      }
    }
  }

  overlay.innerHTML = `
    <div class="ds-cmd-box">
      <div class="ds-cmd-search-row">
        <span class="ds-cmd-search-icon">🔍</span>
        <input id="dsCmdInput" class="ds-cmd-input" placeholder="Go to view or run profile…" autocomplete="off" spellcheck="false">
        <span class="ds-cmd-shortcut-hint">ESC to close</span>
      </div>
      <div class="ds-cmd-list" id="dsCmdList"></div>
      <div class="ds-cmd-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
        <span><kbd>Enter</kbd> Select</span>
        <span><kbd>Esc</kbd> Close</span>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const input = eid('dsCmdInput');
  const list  = eid('dsCmdList');

  render('');
  input.focus();

  input.addEventListener('input', () => {
    activeIdx = 0;
    render(input.value);
  });

  document.addEventListener('keydown', onKey, true);

  // Click outside to close
  overlay.addEventListener('mousedown', e => {
    if (e.target === overlay) closePalette();
  });
}

// ════════════════════════════════════════════════════════════════
// SECURITY MODAL
// ════════════════════════════════════════════════════════════════
function showSecurityModal() {
  showModal(`
    <div class="sec-hero">
      <span class="sec-hero-icon">🔒</span>
      <div class="sec-hero-title">Your data never leaves your browser</div>
      <div class="sec-hero-sub">Salesforce Data Studio is a read-first, locally-executed tool.<br>Here's exactly what it does — and what it never does.</div>
    </div>

    <div class="sec-body">

      <div class="sec-section-title">✅ What it DOES</div>
      <div class="sec-yes-list">
        <div class="sec-yes-row">
          <span class="sec-yes-icon">🔑</span>
          <span class="sec-yes-text">Uses your <strong>existing Salesforce browser session</strong> — the same cookie your browser already has. No username or password is ever typed into this tool.</span>
        </div>
        <div class="sec-yes-row">
          <span class="sec-yes-icon">📖</span>
          <span class="sec-yes-text">Calls <strong>Salesforce REST &amp; Tooling APIs</strong> on your behalf — purely to read schema, record counts, and flow metadata for the features you activate.</span>
        </div>
        <div class="sec-yes-row">
          <span class="sec-yes-icon">💾</span>
          <span class="sec-yes-text">Saves <strong>only to Chrome's local storage</strong> on this machine: org labels you set, transfer profiles you create, and run history. Nothing is ever uploaded.</span>
        </div>
        <div class="sec-yes-row">
          <span class="sec-yes-icon">✍️</span>
          <span class="sec-yes-text">Writes records to Salesforce <strong>only when you explicitly start a Transfer</strong> — and only to the target org you select, using the profile you reviewed.</span>
        </div>
      </div>

      <div class="sec-section-title">🚫 What it NEVER does</div>
      <div class="sec-never-list">
        <div class="sec-never-row">
          <span class="sec-never-icon">✗</span>
          <span class="sec-never-text"><strong>Send any data to external servers</strong> — there are no analytics, no telemetry, no backend. Zero third-party requests.</span>
        </div>
        <div class="sec-never-row">
          <span class="sec-never-icon">✗</span>
          <span class="sec-never-text"><strong>Store passwords anywhere</strong> — there's no credential login at all. The tool relies entirely on your existing Chrome Salesforce session.</span>
        </div>
        <div class="sec-never-row">
          <span class="sec-never-icon">✗</span>
          <span class="sec-never-text"><strong>Execute any write operation without your confirmation</strong> — every DML action requires you to pick source, target, and run explicitly.</span>
        </div>
        <div class="sec-never-row">
          <span class="sec-never-icon">✗</span>
          <span class="sec-never-text"><strong>Share data between orgs silently</strong> — Schema View and Deploy Readiness are 100% read-only.</span>
        </div>
        <div class="sec-never-row">
          <span class="sec-never-icon">✗</span>
          <span class="sec-never-text"><strong>Access orgs you haven't opened</strong> — it can only reach orgs that have an active session in your Chrome tabs.</span>
        </div>
      </div>

      <div class="sec-storage-note">
        <strong>🔍 Fully inspectable:</strong> This is a Chrome extension — you can review every line of code at
        <code>chrome://extensions</code> → Details → Inspect views. All network requests appear in the DevTools Network tab.
        There is no minified or obfuscated code.
      </div>

    </div>

    <div class="ds-modal-footer">
      <button class="ds-btn ds-btn-primary" data-dsaction="closeModal">Got it — I trust this tool</button>
    </div>`);
}

// ════════════════════════════════════════════════════════════════
// CREDENTIAL VAULT — UI
// ════════════════════════════════════════════════════════════════
function renderWelcome() {
  // Helper: activity footer for a card
  function activityBadge(view) {
    const ts = _activityLog[view];
    const dotCls = ts ? '' : ' ds-act-never';
    const label  = ts ? `Last used ${timeAgo(ts)}` : 'Not used yet';
    return `<div class="ds-welcome-card-activity">
      <span class="ds-welcome-card-activity-dot${dotCls}"></span>
      <span>${label}</span>
    </div>`;
  }

  setMain(`
    <div class="ds-welcome-wrap">
      <div class="ds-welcome-hero">
        <div class="ds-welcome-hero-icon">🐱</div>
        <div class="ds-welcome-hero-text">
          <div class="ds-welcome-hero-title">Welcome to Salesforce Data Studio</div>
          <div class="ds-welcome-hero-sub">
            A privacy-first toolkit for comparing, transferring, and visualizing data across your Salesforce orgs.
            Open any Salesforce org in Chrome to get started.
          </div>
        </div>
      </div>

      <div class="ds-welcome-grid">
        <div class="ds-welcome-card" data-gotoview="orgs">
          <div class="ds-welcome-card-icon">🔌</div>
          <div class="ds-welcome-card-title">Connected Orgs</div>
          <div class="ds-welcome-card-desc">See every Salesforce org you have open in Chrome. The starting point for transfers and reconcile.</div>
          <span class="ds-welcome-card-badge ds-badge-read">Read-only</span>
          ${activityBadge('orgs')}
        </div>
        <div class="ds-welcome-card" data-gotoview="profiles">
          <div class="ds-welcome-card-icon">📦</div>
          <div class="ds-welcome-card-title">Data Deployment</div>
          <div class="ds-welcome-card-desc">Define deployment profiles (objects, orgs, mappings) and run transfers or reconcile between orgs.</div>
          <span class="ds-welcome-card-badge ds-badge-write">Writes records</span>
          ${activityBadge('transfer')}
        </div>
        <div class="ds-welcome-card" data-gotoview="readiness">
          <div class="ds-welcome-card-icon">🛡</div>
          <div class="ds-welcome-card-title">Deploy Readiness</div>
          <div class="ds-welcome-card-desc">Compare schemas between orgs — spot missing fields, picklist gaps, and validation rules before a load fails.</div>
          <span class="ds-welcome-card-badge ds-badge-read">Read-only</span>
          ${activityBadge('readiness')}
        </div>
        <div class="ds-welcome-card" data-gotoview="schema">
          <div class="ds-welcome-card-icon">🕸</div>
          <div class="ds-welcome-card-title">Schema View</div>
          <div class="ds-welcome-card-desc">Visualize how objects relate to each other and which flows run on them.</div>
          <span class="ds-welcome-card-badge ds-badge-read">Read-only</span>
          ${activityBadge('schema')}
        </div>
      </div>

      <div class="ds-welcome-trust">
        <span class="ds-welcome-trust-icon">🔒</span>
        <span>All operations run <strong>locally in your browser</strong>. No data is ever sent to external servers. Schema View and Deploy Readiness are completely read-only.</span>
        <span class="ds-welcome-trust-link" id="dsWelcomeSecBtn">Security details →</span>
      </div>
    </div>
  `);

  // Wire card navigation
  document.querySelectorAll('[data-gotoview]').forEach(card => {
    card.addEventListener('click', () => {
      const view = card.dataset.gotoview;
      document.querySelectorAll('.ds-nav-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.view === view);
      });
      _currentView = view;
      renderView(view);
    });
  });

  eid('dsWelcomeSecBtn')?.addEventListener('click', showSecurityModal);
}

function renderView(view) {
  _describeCache = {};   // clear per-view to stay fresh
  _refFieldCache = {};   // clear lookup field cache on view switch (may have stale org data)

  // Sidebar is always visible now (the full-width Org Map home was removed).
  document.querySelector('.ds-body')?.classList.remove('ds-home');

  // Record activity for the welcome screen tiles
  recordActivity(view);

  switch (view) {
    case 'orgs':     renderOrgsPanel();  break;
    case 'profiles': renderProfiles();   break;
    case 'transfer': renderTransfer();   break;
    case 'history':  renderHistory();    break;
    case 'readiness': renderReadiness();   break;
    case 'schema':    renderSchemaView();  break;
    case 'reconcile': renderReconcile();   break;
    case 'compare':   renderOrgCompare(); break;
  }
}

// ════════════════════════════════════════════════════════════════
// CONNECTED ORGS PANEL (Gearset / SF CLI style)
// ════════════════════════════════════════════════════════════════
function renderOrgsPanel() {
  // Orgs are detected purely from open Salesforce browser tabs now —
  // credential-based stored orgs were removed. We still remember orgs seen
  // before (in _orgs) so they show as "not open" with their last-seen time.
  const allOrgUrls = [
    ...new Set([
      ..._allSessions.map(s => s.orgUrl),
      ...(_orgUrl ? [_orgUrl] : []),
      ...Object.keys(_orgs)
    ])
  ].filter(Boolean);

  const rowsHtml = allOrgUrls.map(url => {
    const isOnline   = _allSessions.some(s => s.orgUrl === url) || url === _orgUrl;
    const isCurrent  = url === _orgUrl;
    const orgData    = _orgs[url] || {};
    const label      = orgLabel(url);
    const host       = (() => { try { return new URL(url).hostname; } catch { return url; } })();
    const lastSeen   = timeAgo(orgData.lastSeen);
    const syncCount  = _history.filter(h => h.sourceOrg === url || h.targetOrg === url).length;

    return `
      <div class="ds-org-row ${isCurrent ? 'ds-org-row--active' : ''}">
        <div class="ds-org-row-icon">${isOnline ? '🟢' : '⚫'}</div>
        <div class="ds-org-row-info">
          <div class="ds-org-row-label">
            ${esc(label)}
            ${isCurrent ? '<span class="ds-org-badge-current" style="margin-left:6px">current tab</span>' : ''}
          </div>
          <div class="ds-org-row-url">${esc(host)}</div>
          <div class="ds-org-row-meta">
            Last seen ${lastSeen} · ${syncCount} transfer${syncCount !== 1 ? 's' : ''} logged
          </div>
        </div>
        <div class="ds-org-row-status ${isOnline ? 'ds-org-row-status--online' : 'ds-org-row-status--offline'}">
          ${isOnline ? '● Connected' : '○ Not open'}
        </div>
        <div class="ds-org-row-actions">
          <button class="ds-btn ds-btn-sm" data-dsaction="editOrgLabel" data-arg="${esc(url)}">✏ Rename</button>
          ${isOnline
            ? `<button class="ds-btn ds-btn-sm ds-btn-primary" data-dsaction="startTransferFrom" data-arg="${esc(url)}" title="Copy data INTO this org — opens Run Transfer with this org as the target">🚀 Transfer into</button>`
            : `<button class="ds-btn ds-btn-sm ds-btn-danger" data-dsaction="removeOrg" data-arg="${esc(url)}">✕</button>`}
        </div>
      </div>`;
  }).join('');

  setMain(`
    <div class="ds-view-header">
      <div class="ds-view-title-wrap">
        <h2 class="ds-view-title">🔌 Connected Orgs</h2>
        <div class="ds-view-subtitle">${allOrgUrls.length} org${allOrgUrls.length !== 1 ? 's' : ''} known · ${_allSessions.length} currently open in Chrome</div>
      </div>
      <button class="ds-btn ds-btn-primary" id="dsRefreshOrgsBtn">🔄 Refresh from open tabs</button>
    </div>

    <div style="background:#E8F4FD;border:1px solid #C5DBF0;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:12px;color:#014486;max-width:820px">
      <strong>💡 How it works:</strong> The Studio auto-detects any Salesforce org you have open in a Chrome tab.
      Open an org in Chrome, then click <em>Refresh from open tabs</em> to add it. No Connected App or passwords —
      your existing browser session is used securely. Transfers and reconcile run against orgs that are open in a tab.
    </div>

    ${!allOrgUrls.length ? `
      <div class="ds-empty-page">
        <div class="ds-empty-icon">🔌</div>
        <div class="ds-empty-title">No orgs detected yet</div>
        <div class="ds-empty-sub">Open a Salesforce org in any Chrome tab, then click <strong>Refresh from open tabs</strong>.</div>
      </div>` : `
      <div class="ds-orgs-grid">
        ${rowsHtml}
      </div>`}
  `);

  eid('dsRefreshOrgsBtn')?.addEventListener('click', async () => {
    const btn = eid('dsRefreshOrgsBtn');
    if (btn) { btn.disabled = true; btn.textContent = '🔄 Refreshing…'; }
    const allRes = await sendBg({ type: 'GET_ALL_SF_SESSIONS' });
    _allSessions = allRes?.sessions || [];
    _allSessions.forEach(s => upsertOrg(s.orgUrl, s.label));
    await storageSaveOrgs();
    renderOrgsPanel();
  });
}

window.editOrgLabel = function(orgUrl) {
  const current = _orgs[orgUrl]?.label || orgLabel(orgUrl);
  showModal(`
    <div class="ds-modal-header">✏ Rename Org</div>
    <div class="ds-modal-body">
      <div class="ds-org-edit-row">
        <label class="ds-lbl">Friendly label</label>
        <input id="dsOrgLabelInput" class="ds-input" value="${esc(current)}" placeholder="e.g. Production, QA Sandbox">
      </div>
      <div style="font-size:11px;color:var(--subtext)">${esc(orgUrl)}</div>
    </div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn ds-btn-primary" id="dsOrgLabelSave">Save</button>
    </div>`);
  setTimeout(() => {
    eid('dsOrgLabelInput')?.focus();
    eid('dsOrgLabelSave')?.addEventListener('click', async () => {
      const newLabel = eid('dsOrgLabelInput')?.value.trim();
      if (!newLabel) return;
      if (!_orgs[orgUrl]) _orgs[orgUrl] = {};
      _orgs[orgUrl].label = newLabel;
      await storageSaveOrgs();
      closeModal();
      renderOrgsPanel();
    });
  }, 50);
};

window.removeOrg = function(orgUrl) {
  showModal(`
    <div class="ds-modal-header">Remove Org</div>
    <div class="ds-modal-body">Remove <strong>${esc(orgLabel(orgUrl))}</strong> from the org list? This only removes it from the Studio's memory — it won't affect your Salesforce account.</div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn ds-btn-danger" id="dsOrgRemoveConfirm">Remove</button>
    </div>`);
  eid('dsOrgRemoveConfirm')?.addEventListener('click', async () => {
    delete _orgs[orgUrl];
    await storageSaveOrgs();
    closeModal();
    renderOrgsPanel();
  });
};

// ════════════════════════════════════════════════════════════════
// ORG MAP — SVG visual flowchart with draggable nodes + connections
// ════════════════════════════════════════════════════════════════

// Build a list of all known orgs from browser sessions + remembered orgs.
// (Credential-based stored orgs were removed.) Used by the profile builder,
// transfer/reconcile, Deploy Readiness, and Schema View to populate org
// dropdowns. Each entry: { id, url, label }.
function allMapOrgs() {
  // Key the map by URL — the only truly unique key. The previous id-based
  // keying used btoa(url).slice(0,12), which encodes only the URL's first
  // 9 BYTES ("https://a…") — every pair of orgs sharing that prefix (e.g.
  // ashkenazy6-… and ashkenazy7-…) collided and one silently vanished from
  // every org dropdown. id stays for consumers but is now the full base64.
  const map = new Map();
  const autoId = url => 'auto_' + btoa(url).replace(/[^a-z0-9]/gi,'');

  // Remembered orgs (sftk_orgs) — everything seen in Chrome before.
  for (const [url, data] of Object.entries(_orgs)) {
    if (!map.has(url)) map.set(url, { id: autoId(url), url, label: data.label || orgLabel(url) });
  }
  // Current browser sessions — anything open right now, even if never seen.
  const liveUrls = [...(_orgUrl ? [_orgUrl] : []), ..._allSessions.map(s => s.orgUrl)];
  for (const url of liveUrls) {
    if (!url || map.has(url)) continue;
    map.set(url, { id: autoId(url), url, label: orgLabel(url) });
  }
  return [...map.values()];
}

// ── Org-status option labels ─────────────────────────────────────────
// Native <select> options can't render HTML, so emoji is the one styling
// channel available: 🟢 = org open in Chrome with a live session, ⚪ = known
// but not currently open. Used by every org picklist (Profile Builder,
// Run Transfer, Readiness, Schema View, Field Mapping, Org Compare).
function _liveOrgSet() {
  return new Set(_buildAllSessions().filter(s => s.sid).map(s => s.orgUrl));
}
function orgOptionLabel(url, label, liveSet) {
  const on = (liveSet || _liveOrgSet()).has(url);
  return `${on ? '🟢' : '⚪'} ${label || orgLabel(url)}${on ? '' : ' (not open)'}`;
}

// Resolve an allMapOrgs() id (the value used by the Deploy Readiness and
// Schema View org <select>s) to a live session { orgUrl, sid } — or null
// when that org isn't open in any Chrome tab. This helper was lost in the
// credentials trim while its four call sites survived, which made both
// views throw ReferenceError as soon as a check ran.
async function getOrgSession(orgId) {
  const org = allMapOrgs().find(o => o.id === orgId);
  if (!org) return null;
  // Refresh open-tab sessions so we hand back the freshest SID available.
  const freshRes = await sendBg({ type: 'GET_ALL_SF_SESSIONS' });
  if (freshRes?.sessions?.length) _allSessions = freshRes.sessions;
  const sess = _resolveSession(org.url, _buildAllSessions());
  return (sess && sess.sid) ? sess : null;
}

// Called from org card button — "Transfer" on an org means "copy data INTO
// this org" (user-confirmed intent): seed it as the run-time TARGET override
// so it survives renderTransfer's profile-org resolution. The user can still
// switch or swap orgs on the Run Transfer page.
window.startTransferFrom = function(targetOrg) {
  _transferOrgOverride = { src: null, tgt: targetOrg };
  // Transfer is now reachable as a sub-page of Data Deployment, not as
  // its own sidebar item. Highlight Data Deployment so the nav stays
  // consistent with where the user is.
  document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-view="profiles"]')?.classList.add('active');
  _currentView = 'profiles';
  renderTransfer();
};

// ════════════════════════════════════════════════════════════════
// PROFILES LIST
// ════════════════════════════════════════════════════════════════
// Feature 1: Quick-start templates
const PROFILE_TEMPLATES = [
  {
    id: 'tpl_account_contacts',
    icon: '🏢',
    label: 'Account + Contacts',
    desc: 'Copy accounts with all related contacts',
    tree: {
      objectType: 'Account', where: '', children: [
        { childSObject: 'Contact', relationshipName: 'Contacts', field: 'AccountId', where: '', children: [] }
      ]
    }
  },
  {
    id: 'tpl_opp_lineitems',
    icon: '💰',
    label: 'Opportunity + Line Items',
    desc: 'Copy opportunities with product line items',
    tree: {
      objectType: 'Opportunity', where: '', children: [
        { childSObject: 'OpportunityLineItem', relationshipName: 'OpportunityLineItems', field: 'OpportunityId', where: '', children: [] }
      ]
    }
  },
  {
    id: 'tpl_case_comments',
    icon: '🎫',
    label: 'Case + Comments',
    desc: 'Copy cases with all case comments',
    tree: {
      objectType: 'Case', where: '', children: [
        { childSObject: 'CaseComment', relationshipName: 'CaseComments', field: 'ParentId', where: '', children: [] }
      ]
    }
  },
  {
    id: 'tpl_contact',
    icon: '👤',
    label: 'Contacts only',
    desc: 'Copy contacts as a flat list (no parents)',
    tree: { objectType: 'Contact', where: '', children: [] }
  },
];

function renderProfiles() {
  const hasProfiles = _profiles.length > 0;
  setMain(`
    <div class="ds-view-header">
      <div class="ds-view-title-wrap">
        <h2 class="ds-view-title">📦 Data Deployment</h2>
        <div class="ds-view-subtitle">Define a profile (objects + orgs), then click ▶ Run</div>
      </div>
      <button class="ds-btn ds-btn-primary" id="dsNewProfile">+ New Profile</button>
    </div>

    <div class="ds-template-bar">
      <span class="ds-template-bar-label">Quick start:</span>
      ${PROFILE_TEMPLATES.map(t => `
        <button class="ds-btn ds-btn-xs ds-template-btn" data-tpl="${esc(t.id)}" title="${esc(t.desc)}">
          ${t.icon} ${esc(t.label)}
        </button>`).join('')}
    </div>

    ${!hasProfiles ? `
      <div class="ds-empty-page">
        <div class="ds-empty-icon">📦</div>
        <div class="ds-empty-title">No deployments yet</div>
        <div class="ds-empty-sub">A deployment profile defines which records to copy, which orgs to copy between, and how deep to follow relationships. Create one using a template above, or start from scratch.</div>
      </div>` : `
      <div class="ds-profile-list">
        ${_profiles.map(p => profileCard(p)).join('')}
      </div>`}
  `);

  eid('dsNewProfile')?.addEventListener('click', () => openProfileBuilder(null));

  // Wire template buttons
  document.querySelectorAll('[data-tpl]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tpl = PROFILE_TEMPLATES.find(t => t.id === btn.dataset.tpl);
      if (!tpl) return;
      const newProfile = {
        id:        genId('prof'),
        name:      tpl.label,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tree:      JSON.parse(JSON.stringify(tpl.tree)),
      };
      openProfileBuilder(newProfile);
    });
  });
}

function profileCard(p) {
  const nodeCount   = countTreeNodes(p.tree);
  const isScheduled = p.schedule?.enabled;
  const lastRun     = _history.filter(h => h.profileId === p.id).sort((a,b) => b.startedAt.localeCompare(a.startedAt))[0];

  const hasOrgs = !!(p.sourceOrg && p.targetOrg);
  const orgRow  = hasOrgs
    ? `<div class="ds-profile-card-orgs">
         <span class="ds-profile-card-org">${esc(orgLabel(p.sourceOrg))}</span>
         <span class="ds-profile-card-org-arrow">→</span>
         <span class="ds-profile-card-org">${esc(orgLabel(p.targetOrg))}</span>
       </div>`
    : `<div class="ds-profile-card-orgs ds-profile-card-orgs-missing">
         ⚠ Source and target orgs not set — click ✏ Edit to configure
       </div>`;

  // Live diff summary — the user's "what's actually in each org?" answer.
  // Pulls from profile.lastScan (set by `runDiffScan`). Shows counts of
  // missing/drift/in-sync along with how stale the scan is. If no scan
  // has been run yet, shows a CTA encouraging the user to run one.
  // Treats the scan as stale (and hides the chips) if the user changed
  // the source or target org since the scan ran — wouldn't be honest
  // to show "5 missing" counts that were calculated against different orgs.
  const diff   = p.lastScan;
  const diffFresh = !!(
    diff && diff.status === 'success' &&
    (!diff.sourceOrg || diff.sourceOrg === p.sourceOrg) &&
    (!diff.targetOrg || diff.targetOrg === p.targetOrg)
  );
  const diffRow = !hasOrgs ? '' : diffFresh
    ? `<div class="ds-profile-card-diff">
         <span class="ds-diff-chip ds-diff-missing" title="Records present in source but not in target — candidates to deploy">${diff.missingInTarget?.length || 0} missing</span>
         <span class="ds-diff-chip ds-diff-drift"   title="Records present in both orgs but with different values on tracked compare fields">${diff.changed?.length || 0} drift</span>
         <span class="ds-diff-chip ds-diff-sync"    title="Records that match between source and target on the configured match field + compare fields">${diff.identical?.length || 0} in sync</span>
         <span class="ds-diff-chip ds-diff-extra"   title="Records present in target but not in source — orphan records in target">${diff.onlyInTarget?.length || 0} extras</span>
         <span class="ds-diff-stale" title="${esc(diff.runAt)}">scanned ${timeAgo(diff.runAt)}</span>
       </div>`
    : `<div class="ds-profile-card-diff ds-profile-card-diff-empty">
         <span class="ds-diff-empty-hint">${diff ? 'State is stale (orgs changed) — click 🔄 Refresh state' : 'No state captured yet — click 🔄 Refresh state to compare orgs'}</span>
       </div>`;

  return `
    <div class="ds-profile-card">
      <div class="ds-profile-card-header">
        <div class="ds-profile-card-name">${esc(p.name)}</div>
        <div class="ds-profile-card-chips">
          ${isScheduled ? `<span class="ds-chip ds-chip-sched">📅 scheduled</span>` : ''}
          <span class="ds-chip">${nodeCount} object${nodeCount!==1?'s':''}</span>
        </div>
      </div>
      ${orgRow}
      ${diffRow}
      <div class="ds-profile-card-tree">${treePreviewText(p.tree, 0)}</div>
      ${lastRun ? `<div class="ds-profile-card-meta">Last run: ${timeAgo(lastRun.startedAt)} · <span class="ds-run-status-${lastRun.status}">${lastRun.status}</span></div>` : ''}
      <div class="ds-profile-card-actions">
        <button class="ds-btn ds-btn-sm ds-btn-primary" data-dsaction="runProfile" data-arg="${p.id}"
          ${hasOrgs ? '' : 'disabled title="Set source and target orgs in Edit first"'}>▶ Run</button>
        <button class="ds-btn ds-btn-sm" data-dsaction="refreshState" data-arg="${p.id}"
          ${hasOrgs ? '' : 'disabled title="Set source and target orgs first"'}
          title="Query both orgs to refresh what's missing / changed / in sync, AND capture fingerprints of every object in the tree (drives the Org Map drift overlay). Replaces the old Refresh diff + Snapshot buttons.">🔄 Refresh state</button>
        <button class="ds-btn ds-btn-sm" data-dsaction="openReconcile" data-arg="${p.id}"
          ${hasOrgs ? '' : 'disabled title="Set source and target orgs first"'}
          title="Open the Reconcile view — review what's missing / drifted / extra across both orgs and push or delete in one screen.">⚖ Reconcile</button>
        <button class="ds-btn ds-btn-sm" data-dsaction="editProfile" data-arg="${p.id}">✏ Edit</button>
        <button class="ds-btn ds-btn-sm" data-dsaction="cloneProfile" data-arg="${p.id}">⧉ Clone</button>
        <button class="ds-btn ds-btn-sm ds-btn-danger" data-dsaction="deleteProfile" data-arg="${p.id}">🗑</button>
      </div>
    </div>`;
}

function treePreviewText(node, depth) {
  if (!node) return '';
  const pad   = '&nbsp;'.repeat(depth * 4);
  const icon  = depth === 0 ? '📂' : '↳';
  const name  = node.objectType || node.childSObject || '?';
  const where = node.recordIds?.length
    ? `<span class="ds-tree-preview-where">🎯 ${node.recordIds.length} records</span>`
    : node.where ? `<span class="ds-tree-preview-where">WHERE ${esc(node.where)}</span>` : '';
  const fields = node.fields?.length
    ? `<span class="ds-tree-preview-where">🔲 ${node.fields.length} fields</span>` : '';
  const children = (node.children || []).map(c => treePreviewText(c, depth + 1)).join('');
  return `<div class="ds-tree-preview-row">${pad}${icon} <strong>${esc(name)}</strong> ${where}${fields}</div>${children}`;
}

function countTreeNodes(node) {
  if (!node) return 0;
  return 1 + (node.children || []).reduce((n, c) => n + countTreeNodes(c), 0);
}

window.runProfile = function(profileId) {
  _transferProfile = _profiles.find(p => p.id === profileId) || null;
  _transferOrgOverride = { src: null, tgt: null };   // fresh launch → profile's own orgs
  // Stay on the "Data Deployment" nav item — the Run view is conceptually a
  // sub-page of the deployment page, not a separate top-level destination.
  document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-view="profiles"]')?.classList.add('active');
  _currentView = 'profiles';
  renderTransfer();
};

window.editProfile = function(profileId) {
  openProfileBuilder(_profiles.find(p => p.id === profileId) || null);
};

window.cloneProfile = function(profileId) {
  const src = _profiles.find(p => p.id === profileId);
  if (!src) return;
  const clone = JSON.parse(JSON.stringify(src));
  clone.id   = genId('prof');
  clone.name = `Copy of ${clone.name}`;
  clone.createdAt = clone.updatedAt = new Date().toISOString();
  delete clone.schedule;
  // Drop the live-diff scan result — a clone hasn't been compared against
  // anything yet. If the source profile's lastScan came over, the new
  // profile would display stale counts as if it had been scanned.
  delete clone.lastScan;
  _profiles.push(clone);
  storageSaveProfiles().then(() => renderProfiles());
};

window.deleteProfile = function(profileId) {
  showModal(`
    <div class="ds-modal-header">Delete Profile</div>
    <div class="ds-modal-body">This will permanently delete this profile and its schedule (if any). Transfer history is kept.</div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn ds-btn-danger" id="dsConfirmDelete">Delete</button>
    </div>`);
  eid('dsConfirmDelete')?.addEventListener('click', async () => {
    closeModal();
    _profiles = _profiles.filter(p => p.id !== profileId);
    await storageSaveProfiles();
    renderProfiles();
  });
};

// ════════════════════════════════════════════════════════════════
// PROFILE BUILDER — Object Tree Editor
// ════════════════════════════════════════════════════════════════
function openProfileBuilder(existingProfile) {
  _editingProfile = existingProfile
    ? JSON.parse(JSON.stringify(existingProfile))
    : {
        id: genId('prof'),
        name: 'New Profile',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceOrg: '',
        targetOrg: '',
        // Diff configuration — drives the "is record X already in target?"
        // signal in the Pick Records modal + the "drift" summary on cards.
        // matchField is the field used as cross-org record identity (since
        // Salesforce Ids differ between orgs). compareFields, if any, drive
        // the "changed" bucket — records present in both orgs but with
        // different values on these fields.
        scanConfig: { matchField: 'Name', compareFields: [] },
        // Populated by `runDiffScan` — kept on the profile so the badges
        // survive page reloads. Shape: see runDiffScan return value.
        lastScan:   null,
        tree: null
      };

  // Backfill defaults for older profiles that pre-date the org-on-profile move.
  // We try to pick something sensible: if the profile already has a schedule,
  // reuse its orgs; otherwise leave blank so the builder shows "— Select org —".
  if (_editingProfile.sourceOrg === undefined) {
    _editingProfile.sourceOrg = _editingProfile.schedule?.sourceOrg || '';
  }
  if (_editingProfile.targetOrg === undefined) {
    _editingProfile.targetOrg = _editingProfile.schedule?.targetOrg || '';
  }
  // Backfill scanConfig for legacy profiles
  if (!_editingProfile.scanConfig) {
    _editingProfile.scanConfig = { matchField: 'Name', compareFields: [] };
  }

  // Attach _meta to each node
  attachMeta(_editingProfile.tree);

  renderBuilder();
}

function attachMeta(node) {
  if (!node) return;
  node._meta = node._meta || {
    count: null, expanded: true, loading: false,
    relsLoaded: false, availableRels: [],
    fieldsLoaded: false, availableFields: []
  };
  (node.children || []).forEach(attachMeta);
}

function renderBuilder() {
  const p = _editingProfile;
  setMain(`
    <div class="ds-view-header">
      <h2 class="ds-view-title">📦 Profile Builder</h2>
      <div class="ds-builder-hdr-btns">
        ${p.tree ? `<button class="ds-btn" id="dsPreviewAllBtn" title="Count records for every node in parallel">👁 Preview All</button>` : ''}
        <button class="ds-btn" id="dsBuilderCancel">Cancel</button>
        <button class="ds-btn" id="dsBuilderSave">💾 Save</button>
        ${p.tree ? `<button class="ds-btn ds-btn-primary" id="dsBuilderSaveRun"
          title="Save the profile and immediately jump to the Run screen">💾 Save &amp; Run ▶</button>` : ''}
      </div>
    </div>

    <div class="ds-builder-wrap">
      <div class="ds-builder-name-row">
        <label class="ds-lbl">Profile Name</label>
        <input id="dsProfileName" class="ds-input ds-input-lg" value="${esc(p.name)}" placeholder="e.g. Account + Contacts">
      </div>

      <div class="ds-builder-orgs-row">
        <div class="ds-builder-org-col">
          <label class="ds-lbl">Source Org <span class="ds-builder-org-hint">(where records come FROM)</span></label>
          <select id="dsProfileSrcOrg" class="ds-input">
            <option value="">— Select source org —</option>
            ${(() => { const ls = _liveOrgSet(); return allMapOrgs().map(o =>
              `<option value="${esc(o.url)}" ${p.sourceOrg === o.url ? 'selected' : ''}>${esc(orgOptionLabel(o.url, o.label, ls))}</option>`
            ).join(''); })()}
          </select>
        </div>
        <span class="ds-builder-orgs-arrow">→</span>
        <div class="ds-builder-org-col">
          <label class="ds-lbl">Target Org <span class="ds-builder-org-hint">(where records get inserted)</span></label>
          <select id="dsProfileTgtOrg" class="ds-input">
            <option value="">— Select target org —</option>
            ${(() => { const ls = _liveOrgSet(); return allMapOrgs().map(o =>
              `<option value="${esc(o.url)}" ${p.targetOrg === o.url ? 'selected' : ''}>${esc(orgOptionLabel(o.url, o.label, ls))}</option>`
            ).join(''); })()}
          </select>
        </div>
      </div>

      <!-- Diff config is now DERIVED, not configured here.
           Match field defaults to Name and auto-falls-back to the object's
           describe-flagged nameField (e.g. ReturnOrderNumber, CaseNumber)
           when Name doesn't exist. Compare fields are taken from the root
           node's Field Mapping — the user already declared which fields
           matter when they mapped them, no need to ask again. -->

      <div class="ds-section-title">Object Tree</div>

      ${!p.tree ? `
        <div class="ds-builder-root-picker">
          <label class="ds-lbl">Root Object Type</label>
          <div class="ds-builder-root-row">
            <input id="dsRootObj" class="ds-input" placeholder="Account, Contact, Case__c…">
            <button class="ds-btn ds-btn-primary" id="dsSetRoot">Set Root</button>
          </div>
        </div>` : `
        <div id="dsTreeArea" class="ds-tree-area">
          ${renderTreeNode(p.tree, [], true)}
        </div>
        <div id="dsPreviewBanner" class="ds-preview-banner" style="display:none"></div>
        <div id="dsSOQLPane" class="ds-soql-pane"></div>`}
    </div>
  `);

  eid('dsBuilderCancel')?.addEventListener('click', () => renderProfiles());
  eid('dsBuilderSave')?.addEventListener('click', () => saveProfile());
  eid('dsSetRoot')?.addEventListener('click', () => setRootObject());
  eid('dsPreviewAllBtn')?.addEventListener('click', () => previewAll());

  // Save & Run — commit the profile, then jump straight to the Run page.
  // Saves two clicks for the most common path (you just configured it; you
  // want to run it).
  eid('dsBuilderSaveRun')?.addEventListener('click', async () => {
    const profileId = _editingProfile?.id;
    // Block if orgs aren't set — the Run page would refuse anyway
    if (!_editingProfile?.sourceOrg || !_editingProfile?.targetOrg) {
      showToast('Set source and target orgs before running.', 'error', 4000);
      return;
    }
    await commitEditingProfile();
    window.runProfile?.(profileId);
  });

  // Profile-level org selectors. These are the source of truth for which orgs
  // a transfer (or schedule) runs between — the old Transfer page used to ask
  // separately at run time, which both duplicated state and gave the user
  // accidental "wrong org" exposure.
  eid('dsProfileSrcOrg')?.addEventListener('change', e => { _editingProfile.sourceOrg = e.target.value || ''; });
  eid('dsProfileTgtOrg')?.addEventListener('change', e => { _editingProfile.targetOrg = e.target.value || ''; });

  // Diff config is no longer exposed as inputs — see deriveScanConfig() below.
  // The user configures field interest exactly once, via the Field Mapping
  // modal on the root node. Match field is auto-derived (defaults to Name
  // with describe-based fallback).

  if (p.tree) {
    wireTreeEvents();
    refreshSOQLPreview();
    if (p.tree._meta.relsLoaded) { /* already loaded */ }
    else loadNodeRels(p.tree, []);
  }
}

function setRootObject() {
  const objType = (eid('dsRootObj')?.value || '').trim();
  if (!objType) return;
  _editingProfile.tree = {
    objectType: objType,
    where: '',
    children: [],
    _meta: { count: null, expanded: true, loading: false, relsLoaded: false, availableRels: [] }
  };
  renderBuilder();
}

// Feature 4 — Field dependency warning helpers
// System lookup objects that are always "safe" (present in every org)
const SYSTEM_LOOKUP_OBJS = new Set([
  'User','Group','RecordType','Profile','Organization',
  'BusinessHours','UserRole','Territory2','Territory2Type',
]);

// Collect all objectType/childSObject values in a tree
function collectTreeObjects(node, set = new Set()) {
  if (!node) return set;
  const name = node.objectType || node.childSObject;
  if (name) set.add(name);
  (node.children || []).forEach(c => collectTreeObjects(c, set));
  return set;
}

// Compute lookup-dependency warnings for a node
// Returns array of { fieldName, fieldLabel, referenceTo[] }
function fieldDependencyWarnings(node) {
  if (!node.fields?.length || !node._meta?.availableFields?.length) return [];
  if (!_editingProfile?.tree) return [];
  const treeObjs   = collectTreeObjects(_editingProfile.tree);
  const warnings   = [];
  for (const fieldName of node.fields) {
    const meta = node._meta.availableFields.find(f => f.name === fieldName);
    if (!meta || meta.type !== 'reference') continue;
    // Skip system fields
    if (meta.referenceTo.every(r => SYSTEM_LOOKUP_OBJS.has(r))) continue;
    // Warn if none of the referenced objects are in the tree
    const covered = meta.referenceTo.some(r => treeObjs.has(r));
    if (!covered) warnings.push({ fieldName, fieldLabel: meta.label, referenceTo: meta.referenceTo });
  }
  return warnings;
}

// ════════════════════════════════════════════════════════════════
// LOOKUP RESOLUTION — returns reference fields that need explicit
// cross-org mapping (not system fields, not covered by the tree).
// ════════════════════════════════════════════════════════════════
function getResolvableReferenceFields(node) {
  if (!node._meta?.availableFields?.length) return [];

  // Objects already in the tree → auto-remapped via idMap in background.js
  const treeObjs = _editingProfile?.tree ? collectTreeObjects(_editingProfile.tree) : new Set();

  // When node.fields is set, only show selected reference fields;
  // otherwise all createable reference fields need potential resolution.
  const hasExplicitFields = Array.isArray(node.fields) && node.fields.length > 0;
  const selectedSet = hasExplicitFields ? new Set(node.fields) : null;

  return node._meta.availableFields.filter(f => {
    if (f.type !== 'reference') return false;
    if (!f.referenceTo?.length) return false;
    if (selectedSet && !selectedSet.has(f.name)) return false;
    // Skip fields whose ONLY references are system objects (auto-skipped in BG)
    if (f.referenceTo.every(r => SYSTEM_LOOKUP_OBJS.has(r))) return false;
    // Skip fields where ANY reference is already in the tree (auto-remapped)
    if (f.referenceTo.some(r => treeObjs.has(r))) return false;
    return true;
  });
}

// Returns the org/sid the Profile Builder should describe + query against.
// Prefers the profile's own sourceOrg (user explicitly set it on this
// profile, so its schema is what they're modelling). Falls back to the
// initially-detected page session — covers the case where a brand-new
// profile hasn't had a sourceOrg picked yet, or the user is operating
// outside the builder context.
function _builderSession() {
  if (_editingProfile?.sourceOrg) {
    try {
      const sess = _resolveSession(_editingProfile.sourceOrg, _buildAllSessions());
      if (sess?.sid) return { orgUrl: sess.orgUrl, sid: sess.sid };
    } catch (_) { /* _buildAllSessions/_resolveSession may not be loaded yet */ }
  }
  return { orgUrl: _orgUrl, sid: _sid };
}

// Asynchronously load anchor fields for a referenced object, then re-render.
async function loadRefObjectFields(objType) {
  if (!objType) return;
  // Already loading or loaded
  if (_refFieldCache[objType] && _refFieldCache[objType] !== 'error') return;
  const sess = _builderSession();
  if (!sess.orgUrl || !sess.sid) { _refFieldCache[objType] = null; return; }

  _refFieldCache[objType] = 'loading';

  try {
    const desc = await sendBg({
      type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
      path: `services/data/v62.0/sobjects/${objType}/describe`
    });
    if (desc.error) { _refFieldCache[objType] = null; return; }

    // Keep only filterable, meaningful fields that make good anchor values
    const ANCHOR_TYPES = new Set([
      'string', 'email', 'phone', 'url', 'double', 'integer',
      'picklist', 'id', 'textarea', 'reference'
    ]);
    const SKIP_FIELDS = new Set([
      'Id', 'IsDeleted', 'CreatedDate', 'LastModifiedDate',
      'SystemModstamp', 'CreatedById', 'LastModifiedById'
    ]);
    _refFieldCache[objType] = (desc.fields || [])
      .filter(f => f.filterable && ANCHOR_TYPES.has(f.type) && !SKIP_FIELDS.has(f.name))
      .map(f => ({ name: f.name, label: f.label || f.name, type: f.type }))
      .sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name));
  } catch (_) {
    _refFieldCache[objType] = null;
  }

  refreshTree();  // Re-render with the loaded field list
}

// Render the match-field select (or text input fallback) for a reference field
function renderMatchFieldSelect(refObj, currentMatchField, fieldName, pathKey) {
  const cached = _refFieldCache[refObj];
  const dataAttrs = `data-lkp-match="${esc(pathKey)}" data-lkp-field="${esc(fieldName)}" data-lkp-ref-obj="${esc(refObj)}"`;

  if (!cached || cached === 'loading') {
    // Show a single-option select while loading — renders fast, replaced on next refreshTree()
    return `<select class="ds-select-sm ds-lkp-match-select" ${dataAttrs} disabled>
      <option value="${esc(currentMatchField || 'Name')}">${cached === 'loading' ? '⟳ Loading…' : esc(currentMatchField || 'Name')}</option>
    </select>`;
  }
  if (!Array.isArray(cached) || !cached.length) {
    // Describe failed — fall back to plain text input
    return `<input type="text" class="ds-input ds-input-sm ds-lkp-match-select" ${dataAttrs}
      value="${esc(currentMatchField || 'Name')}" placeholder="API field name, e.g. Name">`;
  }
  const options = cached.map(cf =>
    `<option value="${esc(cf.name)}" ${(currentMatchField || 'Name') === cf.name ? 'selected' : ''}>${esc(cf.label)} <span style="opacity:.55">(${esc(cf.name)})</span></option>`
  ).join('');
  return `<select class="ds-select-sm ds-lkp-match-select" ${dataAttrs}>${options}</select>`;
}

// Render the full Lookup Resolution section for a tree node
function renderLookupSection(node, pathKey) {
  const resolvable = getResolvableReferenceFields(node);
  if (!resolvable.length) return '';

  const rows = resolvable.map(f => {
    const res = (node.lookupResolutions || {})[f.name] || { strategy: 'skip' };
    const strategy = res.strategy || 'skip';
    const matchField = res.matchField || 'Name';
    // Primary non-system referenced object
    const refObj = f.referenceTo.find(r => !SYSTEM_LOOKUP_OBJS.has(r)) || f.referenceTo[0] || '?';

    const matchSelHtml = strategy === 'match'
      ? `<span class="ds-lkp-by">by</span>${renderMatchFieldSelect(refObj, matchField, f.name, pathKey)}`
      : '';

    // Treat any legacy 'passthrough' saved in a profile as 'skip'
    const effectiveStrategy = strategy === 'passthrough' ? 'skip' : strategy;

    const hintHtml =
      effectiveStrategy === 'skip'
        ? `<span class="ds-lkp-hint">field will be null in target — safe default</span>`
      : effectiveStrategy === 'match'
        ? `<span class="ds-lkp-hint">tip: pick an External ID field for reliable cross-org matching</span>`
      : '';

    return `<div class="ds-lkp-row">
      <span class="ds-lkp-field-pill" title="${esc(f.name)}">${esc(f.label || f.name)}</span>
      <span class="ds-lkp-arrow">→</span>
      <span class="ds-lkp-ref-pill">${esc(refObj)}</span>
      <select class="ds-select-sm ds-lkp-strategy-sel"
          data-lkp-path="${esc(pathKey)}"
          data-lkp-field="${esc(f.name)}"
          data-lkp-ref-obj="${esc(refObj)}">
        <option value="skip"  ${effectiveStrategy === 'skip'  ? 'selected' : ''}>🚫 Set null</option>
        <option value="match" ${effectiveStrategy === 'match' ? 'selected' : ''}>🔍 Match by field</option>
      </select>
      ${effectiveStrategy === 'match' ? matchSelHtml : ''}${hintHtml}
    </div>`;
  });

  return `<div class="ds-lkp-section">
    <div class="ds-lkp-hdr">
      <span class="ds-lkp-hdr-icon">🔗</span>
      <span class="ds-lkp-hdr-label">Lookup Resolution</span>
      <span class="ds-lkp-hdr-hint">How to resolve foreign-key IDs when they differ between orgs</span>
    </div>
    <div class="ds-lkp-rows">${rows.join('')}</div>
  </div>`;
}

// ── Render one tree node (recursive) ─────────────────────────
const OBJ_ICONS = {
  Account:'🏢', Contact:'👤', Lead:'🎯', Opportunity:'💼',
  Case:'🎫', Task:'✅', Event:'📆', Campaign:'📣',
  Product2:'📦', Order:'🛒', Quote:'📝', Contract:'📋',
  User:'👤', Asset:'⚙️'
};

function renderTreeNode(node, path, isRoot, depth = 0) {
  const objName   = node.objectType || node.childSObject || '?';
  const pathKey   = path.join('.');
  const meta      = node._meta || {};
  const icon      = OBJ_ICONS[objName] || '🔷';
  const depthClass = isRoot ? 'ds-tree-node--root'
    : depth === 1 ? 'ds-tree-node--child-1'
    : depth === 2 ? 'ds-tree-node--child-2'
    : 'ds-tree-node--child-3';

  const countBadge   = meta.count !== null
    ? `<span class="ds-tree-count">${meta.count} records</span>` : '';
  const loadingBadge = meta.loading
    ? `<span class="ds-tree-loading"><span class="ds-spinner-xs"></span></span>` : '';

  const relBadge = !isRoot
    ? `<span class="ds-tree-rel-badge">${esc(node.relationshipName || '')}</span>
       <span class="ds-tree-via">via ${esc(node.field || '')}</span>`
    : '';

  const childrenHtml = (meta.expanded && (node.children || []).length > 0)
    ? `<div class="ds-tree-children">
        ${(node.children || []).map((c, i) =>
          renderTreeNode(c, [...path, i], false, depth + 1)
        ).join('')}
       </div>` : '';

  const addChildSection = meta.expanded ? `
    <div class="ds-tree-add-child" data-path="${esc(pathKey)}">
      ${meta.loading ? '<span class="ds-tree-rels-loading">Loading relationships…</span>' :
        !meta.relsLoaded ? '' :
        meta.availableRels.length === 0 ? '<span class="ds-tree-no-rels">No child relationships found</span>' :
        (() => {
          const candidates = meta.availableRels.filter(r =>
            !(node.children || []).some(c => c.relationshipName === r.relationshipName));
          return `<details class="ds-tree-rels-details">
            <summary class="ds-tree-rels-summary">+ Add child relationship <span class="ds-tree-rels-count">${candidates.length} available</span></summary>
            <div class="ds-tree-rels-list">
              ${candidates.map(r => `
                  <div class="ds-tree-rel-row"
                       data-add-child="${esc(pathKey)}"
                       data-rel-name="${esc(r.relationshipName)}"
                       data-rel-obj="${esc(r.childSObject)}"
                       data-rel-field="${esc(r.field)}"
                       title="Click to add ${esc(r.childSObject)} as a child">
                    <button class="ds-btn ds-btn-xs ds-btn-primary ds-tree-rel-add-btn"
                            tabindex="-1" aria-label="Add ${esc(r.childSObject)}">+</button>
                    <span class="ds-rel-obj-name">${esc(r.childSObject)}</span>
                    <span class="ds-rel-rel-name">${esc(r.relationshipName)}</span>
                    <span class="ds-rel-field-name">via ${esc(r.field)}</span>
                  </div>`).join('')}
            </div>
          </details>`;
        })()}
    </div>` : '';

  return `
    <div class="ds-tree-node ${depthClass}">
      <div class="ds-tree-node-card">
        <div class="ds-tree-node-header" data-path="${esc(pathKey)}">
          <button class="ds-tree-toggle" data-path="${esc(pathKey)}">${meta.expanded ? '▼' : '▶'}</button>
          <span class="ds-tree-node-icon">${icon}</span>
          <span class="ds-tree-obj-name">${esc(objName)}</span>
          ${relBadge}
          ${countBadge}${loadingBadge}
          <div class="ds-tree-node-actions">
            <button class="ds-btn ds-btn-xs" data-preview="${esc(pathKey)}" title="Count records">👁 Preview</button>
            ${!isRoot ? `<button class="ds-btn ds-btn-xs ds-btn-danger" data-remove="${esc(pathKey)}" title="Remove">✕</button>` : ''}
          </div>
        </div>
        <div class="ds-tree-where-row" data-path="${esc(pathKey)}" ${meta.expanded ? '' : 'style="display:none"'}>
          <span class="ds-tree-where-lbl">WHERE</span>
          <input class="ds-input ds-tree-where-input" data-where="${esc(pathKey)}"
                 value="${esc(node.where || '')}" placeholder="optional SOQL filter…">
        </div>
        ${meta.expanded ? (() => {
          const depWarnings = fieldDependencyWarnings(node);
          const warnHtml = depWarnings.length
            ? `<div class="ds-tree-dep-warning">
                <span class="ds-tree-dep-icon">⚠️</span>
                <span>Lookup field${depWarnings.length > 1 ? 's' : ''}
                  <strong>${depWarnings.map(w => w.fieldLabel).join(', ')}</strong>
                  reference${depWarnings.length === 1 ? 's' : ''}
                  <strong>${depWarnings.flatMap(w => w.referenceTo).join(', ')}</strong>
                  which is not in this profile — IDs may not resolve in target org.
                </span>
               </div>`
            : '';
          return `
        <div class="ds-tree-config-row">
          <button class="ds-btn ds-btn-xs ds-btn-config" data-records-btn="${esc(pathKey)}" title="Pick specific records to copy">
            🎯 Records${node.recordIds?.length ? ` <span class="ds-config-badge">${node.recordIds.length}</span>` : ''}
          </button>
          <button class="ds-btn ds-btn-xs ds-btn-config" data-map-btn="${esc(pathKey)}" title="Choose which fields to copy and how to map names between source and target">
            🔀 Fields &amp; mapping${Object.keys(node.fieldMappings || {}).length ? ` <span class="ds-config-badge ds-badge-map">${Object.keys(node.fieldMappings).length}</span>` : ''}
          </button>
        </div>${warnHtml}${renderLookupSection(node, pathKey)}`;
        })() : ''}
        ${childrenHtml}
        ${addChildSection}
      </div>
    </div>`;
}

// ── SOQL Preview ──────────────────────────────────────────────
function buildNestedSOQL(node, depth = 0) {
  if (!node) return '';
  const objName = node.objectType || node.childSObject || '?';

  // Effective WHERE: recordIds override takes priority
  const effectiveWhere = node.recordIds?.length
    ? `Id IN (${node.recordIds.slice(0,5).map(id => `'${id}'`).join(', ')}${node.recordIds.length > 5 ? `, …+${node.recordIds.length - 5}` : ''})`
    : (node.where || '').trim();

  // Build direct-child subqueries (Salesforce supports 1 level of relationship query)
  const directChildren = (node.children || []).filter(c => c.childSObject || c.objectType);
  const subqueries = directChildren.map(c => {
    const childWhere = c.recordIds?.length
      ? `Id IN (${c.recordIds.slice(0,3).map(id => `'${id}'`).join(', ')}${c.recordIds.length > 3 ? ',…' : ''})`
      : (c.where || '').trim();
    const childRel   = c.relationshipName || (c.childSObject || '') + 's';
    const childFlds  = c.fields?.length ? esc(c.fields.join(', ')) : 'Id';
    return `<span class="ds-soql-sub">(</span><span class="ds-soql-kw">SELECT</span> <span class="ds-soql-fld">${childFlds}</span> <span class="ds-soql-kw">FROM</span> <span class="ds-soql-obj">${esc(childRel)}</span>${childWhere ? ` <span class="ds-soql-kw">WHERE</span> <span class="ds-soql-val">${esc(childWhere)}</span>` : ''}<span class="ds-soql-sub">)</span>`;
  }).join(',\n    ');

  // Root SELECT fields
  const rootFields = node.fields?.length ? esc(node.fields.join(', ')) : 'Id';
  const selectFields = subqueries ? `${rootFields},\n    ${subqueries}` : rootFields;

  const rootSOQL = `<span class="ds-soql-kw">SELECT</span> <span class="ds-soql-fld">${selectFields}</span>\n<span class="ds-soql-kw">FROM</span> <span class="ds-soql-obj">${esc(objName)}</span>${effectiveWhere ? `\n<span class="ds-soql-kw">WHERE</span> <span class="ds-soql-val">${esc(effectiveWhere)}</span>` : ''}`;

  // Deeper levels shown as separate annotated queries
  const deeperBlocks = (node.children || []).flatMap(c =>
    (c.children || []).length > 0
      ? [`<div class="ds-soql-sep">— separate query for ${esc(c.childSObject || c.objectType || '?')} children —</div>` + buildNestedSOQL(c, depth + 1)]
      : []
  ).join('\n');

  return `<pre class="ds-soql-code">${rootSOQL}</pre>${deeperBlocks ? `<div class="ds-soql-deeper">${deeperBlocks}</div>` : ''}`;
}

function refreshSOQLPreview() {
  const pane = eid('dsSOQLPane');
  if (!pane || !_editingProfile?.tree) return;
  pane.innerHTML = `
    <div class="ds-soql-pane-header">
      <span class="ds-soql-pane-title">📋 SOQL Preview</span>
      <span class="ds-soql-pane-note">Shows how records will be fetched</span>
    </div>
    <div class="ds-soql-pane-body">
      ${buildNestedSOQL(_editingProfile.tree)}
    </div>`;
}

// ── Wire all tree events ──────────────────────────────────────
function wireTreeEvents() {
  const area = eid('dsTreeArea');
  if (!area) return;

  // Toggle expand/collapse
  area.querySelectorAll('.ds-tree-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const node = getNodeByPath(_editingProfile.tree, btn.dataset.path);
      if (node) { node._meta.expanded = !node._meta.expanded; refreshTree(); }
    });
  });

  // WHERE input change (live, debounced)
  area.querySelectorAll('.ds-tree-where-input').forEach(input => {
    input.addEventListener('change', () => {
      const node = getNodeByPath(_editingProfile.tree, input.dataset.where);
      if (node) { node.where = input.value.trim() || null; }
    });
  });

  // Preview count
  area.querySelectorAll('[data-preview]').forEach(btn => {
    btn.addEventListener('click', () => previewNode(btn.dataset.preview));
  });

  // Remove child
  area.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => removeNode(btn.dataset.remove));
  });

  // Add child relationship
  area.querySelectorAll('[data-add-child]').forEach(btn => {
    btn.addEventListener('click', () => addChild(
      btn.dataset.addChild,
      btn.dataset.relName,
      btn.dataset.relObj,
      btn.dataset.relField
    ));
  });

  // Field picker removed — was redundant with the Field Mapping modal
  // (which already lets users include/exclude fields via the ✕ button).
  // Also `node.fields` was never read by the executor — the field set is
  // determined entirely by the source describe at runtime — so this picker
  // had no behavioural effect; it was UI noise. Legacy `node.fields` data
  // still loads from storage but isn't surfaced.

  // Record picker
  area.querySelectorAll('[data-records-btn]').forEach(btn => {
    btn.addEventListener('click', () => openRecordPickerModal(btn.dataset.recordsBtn));
  });

  // Field mapping
  area.querySelectorAll('[data-map-btn]').forEach(btn => {
    btn.addEventListener('click', () => openFieldMappingModal(btn.dataset.mapBtn));
  });

  // ── Lookup Resolution ─────────────────────────────────────────
  // Strategy dropdown (skip / match)
  area.querySelectorAll('.ds-lkp-strategy-sel').forEach(sel => {
    sel.addEventListener('change', () => {
      const node = getNodeByPath(_editingProfile.tree, sel.dataset.lkpPath);
      if (!node) return;
      if (!node.lookupResolutions) node.lookupResolutions = {};
      const fn  = sel.dataset.lkpField;
      const ref = sel.dataset.lkpRefObj;
      const existing = node.lookupResolutions[fn] || {};
      node.lookupResolutions[fn] = {
        ...existing,
        strategy:    sel.value,
        matchObject: ref,
        matchField:  existing.matchField || 'Name'
      };
      // Start loading anchor fields when the user switches to 'match'
      if (sel.value === 'match') loadRefObjectFields(ref);
      refreshTree();
    });
  });

  // Match-field select (or text input fallback) — update without full re-render
  area.querySelectorAll('.ds-lkp-match-select').forEach(el => {
    el.addEventListener('change', () => {
      const node = getNodeByPath(_editingProfile.tree, el.dataset.lkpMatch);
      if (!node) return;
      if (!node.lookupResolutions) node.lookupResolutions = {};
      const fn  = el.dataset.lkpField;
      const ref = el.dataset.lkpRefObj;
      if (!node.lookupResolutions[fn]) {
        node.lookupResolutions[fn] = { strategy: 'match', matchObject: ref };
      }
      node.lookupResolutions[fn].matchField = el.value;
      // Don't refreshTree() — just store; avoids losing focus mid-selection
    });
    // Same for text inputs (fallback)
    el.addEventListener('blur', () => {
      const node = getNodeByPath(_editingProfile.tree, el.dataset.lkpMatch);
      if (!node || el.tagName !== 'INPUT') return;
      if (!node.lookupResolutions) node.lookupResolutions = {};
      const fn  = el.dataset.lkpField;
      const ref = el.dataset.lkpRefObj;
      if (!node.lookupResolutions[fn]) {
        node.lookupResolutions[fn] = { strategy: 'match', matchObject: ref };
      }
      node.lookupResolutions[fn].matchField = el.value.trim() || 'Name';
    });
  });

  // Kick off describe loads for any referenced objects not yet cached
  const neededRefObjs = new Set();
  area.querySelectorAll('[data-lkp-ref-obj]').forEach(el => {
    const obj = el.dataset.lkpRefObj;
    if (obj && !_refFieldCache[obj]) neededRefObjs.add(obj);
  });
  neededRefObjs.forEach(obj => loadRefObjectFields(obj));
}

// ── Path navigation in tree ───────────────────────────────────
// path = '' → root; '0' → first child; '0.1' → first child's second child
function getNodeByPath(root, pathStr) {
  if (!root) return null;
  if (!pathStr || pathStr === '') return root;
  const parts = pathStr.split('.').map(Number);
  let node = root;
  for (const i of parts) {
    if (!node.children || !node.children[i]) return null;
    node = node.children[i];
  }
  return node;
}

function getParentByPath(root, pathStr) {
  if (!pathStr) return null;            // the root itself has no parent
  const parts = pathStr.split('.');
  // A one-segment path ("0") is a FIRST-LEVEL child — its parent is the
  // root. The old `parts.length <= 1 → null` made removeNode silently
  // no-op for every direct child (the ✕ button "did nothing"); only
  // grandchildren could be removed.
  if (parts.length === 1) return root;
  return getNodeByPath(root, parts.slice(0, -1).join('.'));
}

function getChildIndex(pathStr) {
  return parseInt(pathStr.split('.').pop(), 10);
}

// ── Tree operations ───────────────────────────────────────────
function removeNode(pathStr) {
  const parent = getParentByPath(_editingProfile.tree, pathStr);
  const idx    = getChildIndex(pathStr);
  if (parent && Array.isArray(parent.children)) {
    parent.children.splice(idx, 1);
    refreshTree();
  }
}

function addChild(parentPath, relName, childSObject, field) {
  const parent = getNodeByPath(_editingProfile.tree, parentPath);
  if (!parent) return;
  const newChild = {
    relationshipName: relName,
    childSObject, field,
    where: null,
    children: [],
    _meta: { count: null, expanded: true, loading: false, relsLoaded: false, availableRels: [] }
  };
  if (!parent.children) parent.children = [];
  parent.children.push(newChild);
  refreshTree();
  // Load rels for the new child node
  const newPath = parentPath === '' ? `${parent.children.length - 1}` : `${parentPath}.${parent.children.length - 1}`;
  loadNodeRels(newChild, newPath.split('.').map(Number));
}

function refreshTree() {
  const area = eid('dsTreeArea');
  if (area && _editingProfile?.tree) {
    area.innerHTML = renderTreeNode(_editingProfile.tree, [], true);
    wireTreeEvents();
  }
  refreshSOQLPreview();
}

// ── Load child relationships for a node ───────────────────────
async function loadNodeRels(node, _path) {
  const objType = node.objectType || node.childSObject;
  if (!objType || node._meta?.relsLoaded) return;
  if (node._meta) node._meta.loading = true;
  refreshTree();

  const desc = await describe(objType);
  if (!desc) {
    if (node._meta) { node._meta.loading = false; node._meta.relsLoaded = true; }
    refreshTree();
    return;
  }

  const SKIP = new Set([
    'ActivityHistories','OpenActivities','NoteAndAttachments','Attachments',
    'FeedSubscriptionsForEntity','RecordAssociatedGroups','ContentDocumentLinks',
    'ContentVersions','Histories','Shares','ProcessInstances','ProcessSteps',
    'Tags','UserRecordAccess','FlowRecordRelations','EmailMessageRelations',
    'ListEmailIndividualRecipients','TopicAssignments','Votes','EntitySubscriptions'
  ]);

  const rels = (desc.childRelationships || [])
    .filter(r => r.relationshipName && !r.deprecatedAndHidden && !SKIP.has(r.relationshipName))
    .map(r => ({ relationshipName: r.relationshipName, childSObject: r.childSObject, field: r.field }))
    .sort((a, b) => a.childSObject.localeCompare(b.childSObject));

  // Also cache available fields for the field picker (createable + Id/Name)
  const ALWAYS_INCLUDE = new Set(['Id', 'Name']);
  const fields = (desc.fields || [])
    .filter(f => f.createable || ALWAYS_INCLUDE.has(f.name))
    .map(f => ({
      name:       f.name,
      label:      f.label || f.name,
      type:       f.type,
      required:   !f.nillable && f.createable && f.defaultValue === null,
      custom:     f.name.endsWith('__c'),
      referenceTo: f.referenceTo || []
    }))
    .sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name));

  if (node._meta) {
    node._meta.availableRels    = rels;
    node._meta.relsLoaded       = true;
    node._meta.loading          = false;
    node._meta.availableFields  = fields;
    node._meta.fieldsLoaded     = true;
  }
  refreshTree();
}

// ── Preview count ─────────────────────────────────────────────
async function previewNode(pathStr) {
  const node = getNodeByPath(_editingProfile.tree, pathStr);
  if (!node) return;
  const sess = _builderSession();
  if (!sess.orgUrl || !sess.sid) {
    showToast('Set a source org on this profile to preview record counts.', 'warning', 4000);
    return;
  }

  const objType = node.objectType || node.childSObject;
  node._meta.loading = true;
  refreshTree();

  const effectiveWhere = node.recordIds?.length
    ? `Id IN (${node.recordIds.map(id => `'${id}'`).join(',')})`
    : (node.where || '');
  const res = await sendBg({
    type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid,
    query: `SELECT COUNT() FROM ${objType}${effectiveWhere ? ' WHERE ' + effectiveWhere : ''}`
  });

  node._meta.loading = false;
  node._meta.count   = res.error ? null : (res.totalSize ?? 0);
  refreshTree();
}

// ── Preview All — counts every node in the tree simultaneously ─
// Uses SF_RELATIONSHIP_QUERY for the root + its direct children (1 round trip),
// then fires individual COUNT() queries for any deeper grandchild nodes.
async function previewAll() {
  const tree = _editingProfile?.tree;
  if (!tree) return;
  const sess = _builderSession();
  if (!sess.orgUrl || !sess.sid) {
    showToast('Set a source org on this profile to preview record counts.', 'warning', 4000);
    return;
  }

  const btn = eid('dsPreviewAllBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Counting…'; }

  try {
    // ── 1. Root + direct children via relationship query ────────
    const rootObj    = tree.objectType || tree.childSObject || '';
    const directRels = (tree.children || [])
      .map(c => ({ relationshipName: c.relationshipName, where: c.where || null }))
      .filter(r => r.relationshipName);

    if (directRels.length > 0) {
      // One call covers root count AND all direct-child counts
      const relRes = await sendBg({
        type:         'SF_RELATIONSHIP_QUERY',
        orgUrl:       sess.orgUrl,
        sid:          sess.sid,
        rootObject:   rootObj,
        rootWhere:    tree.where || null,
        childRels:    directRels,
        limit:        500
      });

      if (!relRes.error) {
        // Patch root count
        if (tree._meta) tree._meta.count = relRes.parentCount;

        // Patch each direct child's count from childCounts map
        for (const child of (tree.children || [])) {
          if (!child.relationshipName || !child._meta) continue;
          const c = relRes.childCounts?.[child.relationshipName];
          child._meta.count = c !== undefined ? c : null;
        }
      }
    } else {
      // No children — just count the root
      const rootRes = await sendBg({
        type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid,
        query: `SELECT COUNT() FROM ${rootObj}${tree.where ? ' WHERE ' + tree.where : ''}`
      });
      if (tree._meta) tree._meta.count = rootRes.error ? null : (rootRes.totalSize ?? 0);
    }

    // ── 2. Grandchildren and deeper — individual COUNT() in parallel ─
    const deepQueries = [];
    for (const child of (tree.children || [])) {
      for (const grand of (child.children || [])) {
        const objType = grand.objectType || grand.childSObject;
        if (!objType || !grand._meta) continue;
        deepQueries.push(
          sendBg({
            type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid,
            query: `SELECT COUNT() FROM ${objType}${grand.where ? ' WHERE ' + grand.where : ''}`
          }).then(res => {
            grand._meta.count = res.error ? null : (res.totalSize ?? 0);
          })
        );
      }
    }
    if (deepQueries.length) await Promise.all(deepQueries);

  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '👁 Preview All'; }
    refreshTree();
  }
}

// ════════════════════════════════════════════════════════════════
// FIELD PICKER MODAL — REMOVED 2026-05-16
// ════════════════════════════════════════════════════════════════
// The dedicated "Select Fields" picker was redundant with the Field Mapping
// modal (which already lets users include/exclude fields via the ✕ button)
// and — more critically — `node.fields` was never consulted by the executor
// in background.js. So the picker had no functional effect; it was UI noise.
//
// All field inclusion/exclusion now flows through the Field Mapping modal.
// Legacy `node.fields` data in saved profiles is loaded but no longer
// surfaced or honored at runtime.

// ════════════════════════════════════════════════════════════════
// FIELD MAPPING MODAL  — map source field names → target field names
// ════════════════════════════════════════════════════════════════
async function openFieldMappingModal(pathStr) {
  const node = getNodeByPath(_editingProfile.tree, pathStr);
  if (!node) return;
  const objType = node.objectType || node.childSObject || '';

  if (!node.fieldMappings) node.fieldMappings = {};
  const mappings = node.fieldMappings; // live reference — { srcApiName: tgtApiName }
  // Id can never transfer (Salesforce assigns it on insert) — purge any
  // legacy mapping entry so it can't pollute SOQL/compareFields, and the
  // row filter below keeps it out of the UI even when the profile carries
  // a stale cached field list (node._meta.availableFields) from before
  // the Id exclusion existed.
  delete mappings.Id;

  // Diagnostic — log what the modal is loading so we can tell the difference
  // between "save didn't persist" and "load didn't restore". The previous bug
  // (strip identity → invisible save) is fixed; if a future report comes in
  // claiming the mapping was lost, this line plus the Apply-time round-trip
  // log together pinpoint exactly which step failed.
  const existingCount = Object.keys(mappings).length;
  window.SFToolkitDebug?.log('transfer', 'info',
    `Field mapping modal OPEN: node "${objType}" already has ${existingCount} saved entries ` +
    `(srcOrg=${node.fieldMappingOrgs?.src || '—'}, tgtOrg=${node.fieldMappingOrgs?.tgt || '—'})`);

  // ── Org list (all orgs detected from open browser tabs) ──────────────────
  function allOrgs() {
    const orgs = [];
    const seen = new Set();
    for (const s of _allSessions) {
      if (!seen.has(s.orgUrl)) {
        seen.add(s.orgUrl);
        orgs.push({ url: s.orgUrl, sid: s.sid, label: s.label || s.orgUrl });
      }
    }
    return orgs;
  }

  // ── Per-org describe (reuses global cache) ────────────────────────────────
  async function loadFields(orgUrl, orgSid) {
    const desc = await describe(objType, orgUrl, orgSid);
    if (!desc) return null;
    // Id is never createable and never copyable — Salesforce assigns it on
    // insert. Don't list it in the Field Mapping modal at all; if it's in
    // fieldMappings it pollutes compareFields and breaks SOQL SELECT clauses
    // ("duplicate field selected: Id"). Name kept in ALWAYS so it still
    // appears on objects where the primary name field isn't strictly
    // createable (e.g. Case → CaseNumber would otherwise hide).
    const ALWAYS = new Set(['Name']);
    return (desc.fields || [])
      .filter(f => f.name !== 'Id' && (f.createable || ALWAYS.has(f.name)))
      .map(f => ({ name: f.name, label: f.label || f.name, type: f.type }))
      .sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name));
  }

  // ── State — restore saved org pair if present ─────────────────────────────
  // Priority for default org URLs:
  //   1. Node-level field-mapping-specific override (legacy)
  //   2. Profile-level sourceOrg/targetOrg (the new source of truth)
  //   3. Current popup org (last-ditch fallback for source)
  let srcFields = node._meta?.availableFields || [];
  let tgtFields = [];
  let srcUrl    = node.fieldMappingOrgs?.src || _editingProfile?.sourceOrg || _orgUrl || '';
  let tgtUrl    = node.fieldMappingOrgs?.tgt || _editingProfile?.targetOrg || '';
  let srcLoaded = node._meta?.fieldsLoaded || false;
  let tgtLoaded = false;

  // ── Auto-map: match by API name first, then by normalised label ───────────
  function normalise(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  function runAutoMap() {
    if (!srcFields.length || !tgtFields.length) return;
    const byApi   = new Map(tgtFields.map(f => [f.name.toLowerCase(), f.name]));
    const byLabel = new Map(tgtFields.map(f => [normalise(f.label), f.name]));
    srcFields.forEach(sf => {
      const exactTgt = byApi.get(sf.name.toLowerCase());
      if (exactTgt) { mappings[sf.name] = exactTgt; return; }
      const labelTgt = byLabel.get(normalise(sf.label));
      if (labelTgt) { mappings[sf.name] = labelTgt; }
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function datalistHtml() {
    if (!tgtLoaded || !tgtFields.length) return '';
    return `<datalist id="dsFmTgtList">${tgtFields.map(f =>
      `<option value="${esc(f.name)}">${esc(f.label)} (${esc(f.name)})</option>`
    ).join('')}</datalist>`;
  }

  function mappingCount() {
    return Object.entries(mappings).filter(([k, v]) => v !== null && v && v.trim() && v.trim() !== k).length;
  }

  function skipCount() {
    return Object.values(mappings).filter(v => v === null).length;
  }

  function countLabel() {
    const diff  = mappingCount();
    const skips = skipCount();
    const parts = [];
    if (diff)  parts.push(`${diff} field${diff !== 1 ? 's' : ''} remapped`);
    if (skips) parts.push(`${skips} excluded`);
    if (!parts.length) return tgtLoaded ? 'All fields map identically' : 'No mappings set';
    return parts.join(' · ');
  }

  function rowClass(sf) {
    const v = mappings[sf.name];
    if (v === null) return ' ds-fm-row-skip';
    if (!v || !v.trim()) return '';
    if (v.trim() === sf.name) return ' ds-fm-row-same';
    return ' ds-fm-row-diff';
  }

  // Human-readable type labels
  const TYPE_LABEL = {
    string: 'Text', textarea: 'Text area', boolean: 'Checkbox',
    double: 'Number', integer: 'Integer', currency: 'Currency',
    percent: 'Percent', date: 'Date', datetime: 'Date/Time',
    time: 'Time', email: 'Email', phone: 'Phone', url: 'URL',
    picklist: 'Picklist', multipicklist: 'Multi-select', reference: 'Lookup',
    id: 'ID', base64: 'Base64', encryptedstring: 'Encrypted',
    address: 'Address', location: 'Location', combobox: 'Combobox',
  };
  function typeLbl(t) { return TYPE_LABEL[t] || t || ''; }

  function renderRows(filter = '') {
    const lc       = filter.toLowerCase();
    const tgtByApi = new Map(tgtFields.map(f => [f.name, f]));
    const pool = srcFields.filter(f => {
      // Id is never transferable — hide it even when a stale cached field
      // list (saved before the loadFields Id-exclusion) still contains it.
      if (f.name === 'Id') return false;
      // Keep explicitly excluded fields visible so users can restore them
      if (node.fields && !node.fields.includes(f.name) && !(f.name in mappings)) return false;
      if (filter && !f.label.toLowerCase().includes(lc) && !f.name.toLowerCase().includes(lc)) return false;
      return true;
    });
    if (!pool.length) return '<div class="ds-picker-empty">No fields to map.</div>';
    return pool.map(f => {
      const isSkip = mappings[f.name] === null;
      const val    = isSkip ? '' : (mappings[f.name] || '');
      const isDiff = !isSkip && val && val !== f.name;
      const isRef  = f.type === 'reference';
      const srcType = typeLbl(f.type);
      const tgtF    = !isSkip && tgtLoaded ? tgtByApi.get(val || f.name) : null;
      const tgtType = tgtF ? typeLbl(tgtF.type) : null;
      const mismatch = tgtType && tgtType !== srcType;

      const srcTypeBadge = `<span class="ds-fm-type-badge ds-fm-type-${esc(f.type)}" title="Source type: ${esc(f.type)}">${esc(srcType)}</span>`;
      const tgtTypeBadge = tgtType
        ? `<span class="ds-fm-type-badge ${mismatch ? 'ds-fm-type-mismatch' : 'ds-fm-type-ok'}"
             title="${mismatch ? `⚠ Type mismatch: source is ${esc(srcType)}, target is ${esc(tgtType)}` : `Target type: ${esc(tgtType)}`}"
           >${esc(tgtType)}${mismatch ? ' ⚠' : ''}</span>`
        : '';

      return `<div class="ds-fm-row${rowClass(f)}">
        <div class="ds-fm-src-cell">
          <span class="ds-fm-src-name" title="${esc(f.name)}">${esc(f.label)}</span>
          <span class="ds-fm-src-meta">
            <span class="ds-fm-src-api">${esc(f.name)}</span>
            ${srcTypeBadge}${isRef ? '<span class="ds-fm-ref-badge">🔗</span>' : ''}
          </span>
        </div>
        <span class="ds-fm-arrow">${isSkip ? '—' : '→'}</span>
        <div class="ds-fm-tgt-wrap">
          <input class="ds-input ds-input-sm ds-fm-tgt-input${isDiff ? ' ds-fm-tgt-diff' : ''}" type="text"
                 list="dsFmTgtList"
                 data-src="${esc(f.name)}"
                 placeholder="${isSkip ? '— not transferred —' : esc(f.name)}"
                 value="${esc(val)}"
                 autocomplete="off"
                 ${isSkip ? 'disabled' : ''}
                 title="${isSkip ? 'Field excluded from transfer' : 'Leave blank or enter same name to copy unchanged'}">
          ${!isSkip ? tgtTypeBadge : ''}
          ${isDiff ? `<button class="ds-fm-reset-btn" data-reset="${esc(f.name)}" title="Reset to source name">↺</button>` : ''}
        </div>
        <button class="ds-fm-skip-btn" data-skip="${esc(f.name)}"
                title="${isSkip ? 'Re-include this field' : 'Exclude field from transfer'}">${isSkip ? '↩' : '✕'}</button>
      </div>`;
    }).join('');
  }

  // ── Org selector options ──────────────────────────────────────────────────
  function orgOptions(selectedUrl, placeholder) {
    const orgs = allOrgs();
    if (!orgs.length) return `<span class="ds-fm-no-orgs">No connected orgs</span>`;
    return `<select class="ds-input ds-input-sm ds-fm-org-sel">
      <option value="">${esc(placeholder)}</option>
      ${orgs.map(o => `<option value="${esc(o.url)}" ${o.url === selectedUrl ? 'selected' : ''}>${esc(orgOptionLabel(o.url, o.label))}</option>`).join('')}
    </select>`;
  }

  function srcStatusHtml() {
    if (!srcUrl) return '';
    if (!srcLoaded) return `<span class="ds-fm-loading-sm">Loading…</span>`;
    return `<span class="ds-fm-ok">✓ ${srcFields.length} fields</span>`;
  }
  function tgtStatusHtml() {
    if (!tgtUrl) return '';
    if (!tgtLoaded) return `<span class="ds-fm-loading-sm">Loading…</span>`;
    return `<span class="ds-fm-ok">✓ ${tgtFields.length} fields</span>`;
  }

  // ── Full modal HTML ───────────────────────────────────────────────────────
  function renderModal(filter = '') {
    const canAutoMap = srcLoaded && tgtLoaded;
    return `
      <div class="ds-modal-header">🔀 Field Mapping — <strong>${esc(objType)}</strong></div>
      <div class="ds-modal-body ds-fm-body">
        <div class="ds-fm-orgs-row">
          <div class="ds-fm-org-col">
            <span class="ds-fm-org-pill ds-fm-org-pill-src">Source</span>
            ${orgOptions(srcUrl, '— select source org —')}
            <span class="ds-fm-org-status" id="dsFmSrcStatus">${srcStatusHtml()}</span>
          </div>
          <span class="ds-fm-orgs-arrow">→</span>
          <div class="ds-fm-org-col">
            <span class="ds-fm-org-pill ds-fm-org-pill-tgt">Target</span>
            ${orgOptions(tgtUrl, '— select target org —')}
            <span class="ds-fm-org-status" id="dsFmTgtStatus">${tgtStatusHtml()}</span>
          </div>
        </div>
        <div class="ds-fm-toolbar">
          <input id="dsFmSearch" class="ds-input ds-input-sm" placeholder="Search fields…" value="${esc(filter)}" autocomplete="off">
          <button class="ds-btn ds-btn-xs ds-btn-brand" id="dsFmAutoMap"
                  ${canAutoMap ? '' : 'disabled'}
                  title="Auto-match fields by API name, then by label">
            🔀 Auto Map
          </button>
          <button class="ds-btn ds-btn-xs ds-btn-danger" id="dsFmClear" title="Clear all mappings">✕ Clear</button>
        </div>
        <div class="ds-fm-legend">
          <span class="ds-fm-leg ds-fm-leg-diff">■</span> Remapped &nbsp;
          <span class="ds-fm-leg ds-fm-leg-same">■</span> Auto-matched (same name) &nbsp;
          <span class="ds-fm-leg ds-fm-leg-none">■</span> Unchanged
        </div>
        <div class="ds-fm-cols-hdr">
          <span>Source field &amp; type</span>
          <span></span>
          <span>Target field name${tgtLoaded ? ' &amp; type' : ''}</span>
        </div>
        ${datalistHtml()}
        <div class="ds-fm-list" id="dsFmList">${renderRows(filter)}</div>
      </div>
      <div class="ds-modal-footer">
        <span class="ds-fm-count" id="dsFmCount">${countLabel()}</span>
        <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
        <button class="ds-btn ds-btn-primary" id="dsFmSave">✓ Apply</button>
      </div>`;
  }

  // ── Org load handler ──────────────────────────────────────────────────────
  async function handleOrgChange(isSource, url) {
    if (!url) return;
    const org = allOrgs().find(o => o.url === url);
    if (!org) return;
    if (isSource) {
      srcUrl = url; srcLoaded = false;
      const statusEl = eid('dsFmSrcStatus');
      if (statusEl) statusEl.innerHTML = '<span class="ds-fm-loading-sm">Loading…</span>';
      const fields = await loadFields(org.url, org.sid);
      if (fields) {
        srcFields = fields; srcLoaded = true;
        node._meta.availableFields = fields; node._meta.fieldsLoaded = true;
      }
      const el = eid('dsFmSrcStatus'); if (el) el.innerHTML = srcStatusHtml();
    } else {
      tgtUrl = url; tgtLoaded = false;
      const statusEl = eid('dsFmTgtStatus');
      if (statusEl) statusEl.innerHTML = '<span class="ds-fm-loading-sm">Loading…</span>';
      const fields = await loadFields(org.url, org.sid);
      if (fields) { tgtFields = fields; tgtLoaded = true; }
      const el = eid('dsFmTgtStatus'); if (el) el.innerHTML = tgtStatusHtml();
    }
    const autoBtn = eid('dsFmAutoMap');
    if (autoBtn) autoBtn.disabled = !(srcLoaded && tgtLoaded);
    // Refresh datalist
    const existing = document.getElementById('dsFmTgtList');
    if (existing) existing.remove();
    if (tgtLoaded) {
      const dl = document.createElement('div');
      dl.innerHTML = datalistHtml();
      if (dl.firstElementChild) eid('dsModalBox')?.appendChild(dl.firstElementChild);
    }
    const filter = eid('dsFmSearch')?.value || '';
    const list = eid('dsFmList');
    if (list) list.innerHTML = renderRows(filter);
    wireInputs();
  }

  // ── Wire ─────────────────────────────────────────────────────────────────
  function rerender(filter = '') {
    const box = eid('dsModalBox');
    if (box) { box.innerHTML = renderModal(filter); wireModal(filter); }
  }

  function wireModal(filter = '') {
    const [srcSel, tgtSel] = Array.from(eid('dsModalBox')?.querySelectorAll('.ds-fm-org-sel') || []);
    srcSel?.addEventListener('change', e => handleOrgChange(true,  e.target.value));
    tgtSel?.addEventListener('change', e => handleOrgChange(false, e.target.value));

    eid('dsFmSearch')?.addEventListener('input', e => {
      const val = e.target.value;
      const list = eid('dsFmList');
      if (list) list.innerHTML = renderRows(val);
      wireInputs();
      const inp = eid('dsFmSearch');
      if (inp) { inp.focus(); inp.setSelectionRange(val.length, val.length); }
    });

    eid('dsFmAutoMap')?.addEventListener('click', () => {
      const before = Object.keys(mappings).length;
      runAutoMap();
      const filter = eid('dsFmSearch')?.value || '';
      const list = eid('dsFmList');
      if (list) list.innerHTML = renderRows(filter);
      wireInputs();
      updateCount();
      const added = Object.keys(mappings).length - before;
      showToast(`Auto-mapped ${Object.keys(mappings).filter(k => mappings[k] !== null).length} field(s) — click Apply to save`, 'info', 3500);
    });

    eid('dsFmClear')?.addEventListener('click', () => {
      Object.keys(mappings).forEach(k => delete mappings[k]);
      rerender(filter);
    });

    wireInputs();

    eid('dsFmSave')?.addEventListener('click', async () => {
      Object.keys(mappings).forEach(k => {
        if (mappings[k] === null) return; // keep explicit exclusions
        const v = (mappings[k] || '').trim();
        // Only strip TRULY empty values. Keep identity mappings (v === k) so
        // that re-opening the modal shows the user their config — otherwise it
        // looks like nothing saved (the previous strip-on-identity behaviour
        // caused exactly the "i saved it but it didn't remember" report).
        if (!v) delete mappings[k];
        else    mappings[k] = v;  // normalize whitespace
      });
      node.fieldMappings    = mappings;
      // Persist the org pair so the next modal open pre-loads both fields lists
      node.fieldMappingOrgs = { src: srcUrl, tgt: tgtUrl };

      const totalMappings = Object.keys(mappings).length;
      window.SFToolkitDebug?.log('transfer', 'info',
        `Field mapping Apply: ${totalMappings} entries on node "${objType}" (profile id=${_editingProfile?.id})`);

      closeModal();
      refreshTree();
      // Auto-persist so users don't have to remember to click the builder's
      // "Save" button afterwards. The Apply button now actually applies.
      try {
        await commitEditingProfile();

        // Verify the round-trip by reading back from chrome.storage.local.
        // If this disagrees with what we just put on the node, we'll know
        // the persistence path is the culprit (vs. the load-on-reopen path).
        let savedCount = -1;
        try {
          const d = await chrome.storage.local.get('sftk_profiles');
          const saved = (d.sftk_profiles || []).find(p => p.id === _editingProfile?.id);
          const savedNode = saved && findNodeMatching(saved.tree, node);
          savedCount = savedNode ? Object.keys(savedNode.fieldMappings || {}).length : -1;
        } catch (_) {}
        window.SFToolkitDebug?.log('transfer', 'info',
          `Field mapping persisted: chrome.storage round-trip shows ${savedCount} entries (expected ${totalMappings})`);

        const remapped = Object.entries(mappings).filter(([k, v]) => v !== null && v && v.trim() && v.trim() !== k).length;
        const excluded = Object.values(mappings).filter(v => v === null).length;
        const identity = totalMappings - remapped - excluded;
        const bits = [];
        if (remapped) bits.push(`${remapped} remapped`);
        if (identity) bits.push(`${identity} identity`);
        if (excluded) bits.push(`${excluded} excluded`);
        showToast(`✓ Field mapping saved${bits.length ? ' (' + bits.join(', ') + ')' : ''}`, 'success', 3500);
      } catch (e) {
        window.SFToolkitDebug?.log('transfer', 'error',
          `Field mapping persist FAILED: ${e?.message || e}`);
        showToast('Field mapping applied but failed to persist: ' + (e?.message || e), 'error', 6000);
      }
    });
  }

  // Walk `tree` looking for a node that points at the same object as `target`.
  // Used by the Apply-handler verification to confirm the storage round-trip
  // actually preserved fieldMappings on the right node. Matches by objectType +
  // child path (best-effort — handles single root + same-type nested cases).
  function findNodeMatching(tree, target) {
    if (!tree || !target) return null;
    const targetType = target.objectType || target.childSObject;
    function walk(n) {
      if (!n) return null;
      if ((n.objectType || n.childSObject) === targetType) return n;
      for (const c of (n.children || [])) {
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    }
    return walk(tree);
  }

  function updateCount() {
    const el = eid('dsFmCount');
    if (el) el.textContent = countLabel();
  }

  function wireInputs() {
    const list = eid('dsFmList');
    if (!list) return;
    list.querySelectorAll('.ds-fm-tgt-input').forEach(inp => {
      inp.addEventListener('input', () => {
        const src = inp.dataset.src;
        const val = inp.value.trim();
        if (val) mappings[src] = val; else delete mappings[src];
        inp.classList.toggle('ds-fm-tgt-diff', !!(val && val !== src));
        const wrap  = inp.closest('.ds-fm-tgt-wrap');
        const reset = wrap?.querySelector('.ds-fm-reset-btn');
        if (val && val !== src) {
          if (!reset) {
            const btn = document.createElement('button');
            btn.className = 'ds-fm-reset-btn';
            btn.dataset.reset = src;
            btn.title = 'Reset to source name';
            btn.textContent = '↺';
            btn.addEventListener('click', () => {
              delete mappings[src];
              inp.value = '';
              inp.classList.remove('ds-fm-tgt-diff');
              btn.remove();
              updateCount();
            });
            wrap?.appendChild(btn);
          }
        } else {
          reset?.remove();
        }
        updateCount();
      });
    });
    list.querySelectorAll('.ds-fm-reset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const src = btn.dataset.reset;
        delete mappings[src];
        const inp = list.querySelector(`.ds-fm-tgt-input[data-src="${CSS.escape(src)}"]`);
        if (inp) { inp.value = ''; inp.classList.remove('ds-fm-tgt-diff'); }
        btn.remove();
        updateCount();
      });
    });

    // Skip / re-include toggle
    list.querySelectorAll('.ds-fm-skip-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const src = btn.dataset.skip;
        if (mappings[src] === null) {
          delete mappings[src]; // re-include
        } else {
          mappings[src] = null; // exclude
        }
        const filter = eid('dsFmSearch')?.value || '';
        const listEl = eid('dsFmList');
        if (listEl) listEl.innerHTML = renderRows(filter);
        wireInputs();
        updateCount();
      });
    });
  }

  // ── Initial load ──────────────────────────────────────────────────────────
  showModal(`<div class="ds-modal-header">🔀 Field Mapping — ${esc(objType)}</div>
    <div class="ds-modal-body" style="text-align:center;padding:40px;color:var(--subtext)">
      ${window.sftkCatSm ? sftkCatSm('Loading fields…') : 'Loading…'}
    </div>`);

  // Load source org fields
  if (!srcLoaded) {
    const srcOrg = allOrgs().find(o => o.url === srcUrl) ||
                   (srcUrl === _orgUrl && _sid ? { url: _orgUrl, sid: _sid } : null);
    if (srcOrg) {
      const fields = await loadFields(srcOrg.url, srcOrg.sid);
      if (fields) {
        srcFields = fields; srcLoaded = true;
        node._meta.availableFields = fields; node._meta.fieldsLoaded = true;
      }
    }
  }

  // Auto-load target org fields if a target was previously saved
  if (tgtUrl && !tgtLoaded) {
    const tgtOrg = allOrgs().find(o => o.url === tgtUrl);
    if (tgtOrg) {
      const fields = await loadFields(tgtOrg.url, tgtOrg.sid);
      if (fields) { tgtFields = fields; tgtLoaded = true; }
      else tgtUrl = ''; // org no longer reachable — clear stored selection
    } else {
      tgtUrl = ''; // org not connected anymore
    }
  }

  showModal(renderModal());
  wireModal();
}

// ════════════════════════════════════════════════════════════════
// RECORD PICKER MODAL
// ════════════════════════════════════════════════════════════════
async function openRecordPickerModal(pathStr) {
  const node = getNodeByPath(_editingProfile.tree, pathStr);
  if (!node) return;
  const objType = node.objectType || node.childSObject || '';

  // Record picking queries source — uses the profile's sourceOrg, falling
  // back to the initial page session for legacy profiles without orgs set.
  const sess = _builderSession();
  if (!sess.orgUrl || !sess.sid) {
    showModal(`<div class="ds-modal-header">🎯 Pick Records — ${esc(objType)}</div>
      <div class="ds-modal-body" style="padding:24px;color:var(--warning)">
        Set a <strong>Source Org</strong> on this profile first — record picking needs to query the source.
      </div>
      <div class="ds-modal-footer"><button class="ds-btn" data-dsaction="closeModal">Close</button></div>`);
    return;
  }

  // ── Step 1: load describe to get candidate display fields ──────
  showModal(`<div class="ds-modal-header">🎯 Pick Records — ${esc(objType)}</div>
    <div class="ds-modal-body" style="text-align:center;padding:40px;color:var(--subtext)">Loading…</div>`);

  const desc = await describe(objType).catch(() => null);

  // Candidate "display" fields: string/text fields that are readable
  // Prefer Name, then common key fields, then any string field
  const candidateFields = (desc?.fields || [])
    .filter(f => STRING_TYPES.has(f.type) && !f.deprecatedAndHidden && f.name !== 'Id')
    .map(f => ({ name: f.name, label: f.label || f.name }))
    .sort((a, b) => {
      // Preferred fields float to top
      const PREF = ['Name','CaseNumber','Subject','OrderNumber','ContractNumber','Title','AssetName','ProductCode','EventSubtype'];
      const ai = PREF.indexOf(a.name), bi = PREF.indexOf(b.name);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return  1;
      return (a.label).localeCompare(b.label);
    });

  // ── Step 2: pick initial display field ────────────────────────
  // Priority: persisted node.matchField (cross-org identity, lives forever) >
  // transient session pick (_meta._recDisplayField) > best-guess (first
  // candidate, usually Name).
  const defaultField = candidateFields[0]?.name || null;
  let displayField   = node.matchField || node._meta._recDisplayField || defaultField;

  // ── Step 2b: load TARGET describe so the "Match on target" dropdown can
  // be populated. Best effort — if the target session is unavailable, we
  // fall back to a free-text input so the user can still declare the
  // target-side field name manually.
  const allSess  = _buildAllSessions();
  const tgtSess  = _editingProfile?.targetOrg ? _resolveSession(_editingProfile.targetOrg, allSess) : null;
  let tgtCandidates = null;   // null = unavailable (target session missing)
  if (tgtSess?.sid) {
    try {
      const tgtDesc = await describe(objType, tgtSess.orgUrl, tgtSess.sid);
      if (tgtDesc?.fields?.length) {
        tgtCandidates = (tgtDesc.fields || [])
          .filter(f => STRING_TYPES.has(f.type) && !f.deprecatedAndHidden && f.name !== 'Id')
          .map(f => ({ name: f.name, label: f.label || f.name }))
          .sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name));
      }
    } catch (_) { /* target describe failed — leave tgtCandidates null */ }
  }

  // Target match field — priority: persisted > field mapping for current
  // displayField > same name as source (auto-corrected at runtime).
  function deriveTgtMatchDefault(srcField) {
    if (node.matchFieldTgt)                                                                return node.matchFieldTgt;
    if (node.fieldMappings?.[srcField] && node.fieldMappings[srcField] !== null)           return node.fieldMappings[srcField];
    return srcField;
  }
  let tgtMatchField = deriveTgtMatchDefault(displayField);

  // ── Step 3: query helper — fetches records using current displayField ─
  let records = [];
  let queryError = null;
  let selected   = new Set(node.recordIds || []);

  // Source IDs partitioned by their live state in target. Drawn from
  // `profile.lastScan` (set by runDiffScan), which queries both orgs
  // and is the source of truth for "what's actually there". Falls back
  // to the older history-derived `deployedIds` (cumulative successful
  // run history) for profiles that haven't been scanned yet.
  // A scan is "fresh" only when the profile's CURRENT object + org pair
  // matches what the scan was run against — protects against showing
  // stale state after the user changes orgs in the builder.
  const liveScan = _editingProfile?.lastScan;
  const scanFresh = !!(
    liveScan &&
    liveScan.status     === 'success' &&
    liveScan.objectType === objType &&
    (!liveScan.sourceOrg || liveScan.sourceOrg === _editingProfile?.sourceOrg) &&
    (!liveScan.targetOrg || liveScan.targetOrg === _editingProfile?.targetOrg)
  );
  const idsMissingInTarget = new Set();  // source-only — need to deploy
  const idsInSync          = new Set();  // present in both, no drift
  const idsDrift           = new Set();  // present in both, fields differ
  // Drift→target-Id map so the click-to-expand can fetch from BOTH orgs.
  // Source Id alone (idsDrift) isn't enough — we need the matching target Id
  // to query the target record's compareField values.
  const driftTargetId      = new Map();  // sourceId → { targetId, matchKey }
  if (scanFresh) {
    for (const r of (liveScan.missingInTarget || [])) if (r.sourceId) idsMissingInTarget.add(r.sourceId);
    for (const r of (liveScan.identical       || [])) if (r.sourceId) idsInSync.add(r.sourceId);
    for (const r of (liveScan.changed         || [])) {
      if (r.sourceId) {
        idsDrift.add(r.sourceId);
        if (r.targetId) driftTargetId.set(r.sourceId, { targetId: r.targetId, matchKey: r.matchKey, fields: r.fields || [] });
      }
    }
  }
  // Legacy history-derived "deployed" set — only used when no live scan
  // exists yet. Once the user clicks 🔍 Refresh diff, this is superseded.
  const deployedIds = new Set();
  if (!scanFresh && _editingProfile?.id) {
    for (const h of _history) {
      if (h.profileId !== _editingProfile.id) continue;
      if (h.tgtOrgUrl && _editingProfile.targetOrg && h.tgtOrgUrl !== _editingProfile.targetOrg) continue;
      const s = h.summary?.[objType];
      if (s && Array.isArray(s.transferredSourceIds)) {
        for (const id of s.transferredSourceIds) deployedIds.add(id);
      }
    }
  }
  let hideDeployed   = false;   // user-toggleable filter — hides in-sync rows
  let showOnlyTodo   = false;   // user-toggleable filter — shows ONLY missing+drift rows (Phase 2.5)

  async function fetchRecords() {
    const fld  = displayField && displayField !== 'Id' ? displayField : null;
    const soql = `SELECT Id${fld ? `,${fld}` : ''} FROM ${objType}${node.where ? ' WHERE ' + node.where : ''} ORDER BY ${fld || 'Id'} LIMIT 200`;
    const res  = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid, query: soql });
    queryError = res.error || null;
    records    = res.error ? [] : (res.records || []);
  }

  await fetchRecords();

  // ── Render helpers ────────────────────────────────────────────
  function noteHtml() {
    return selected.size > 0
      ? `<strong>${selected.size}</strong> record${selected.size !== 1 ? 's' : ''} selected — only these will be transferred`
      : 'No records selected — WHERE filter (or all records) will be used';
  }

  function fieldOptions() {
    return candidateFields.map(f =>
      `<option value="${esc(f.name)}" ${displayField === f.name ? 'selected' : ''}>${esc(f.label)} (${esc(f.name)})</option>`
    ).join('');
  }

  function renderModal(filter = '') {
    const lc   = filter.toLowerCase();
    let list = records;
    if (filter) {
      list = list.filter(r => {
        const val = (r[displayField] || r.Id || '').toLowerCase();
        return val.includes(lc) || r.Id.toLowerCase().includes(lc);
      });
    }
    // "Hide in-sync" filter — when a live diff exists, hide records that
    // match between source and target. Falls back to legacy history-derived
    // "deployed" filter for unscanned profiles.
    const hideSet = scanFresh ? idsInSync : deployedIds;
    if (hideDeployed && hideSet.size) {
      list = list.filter(r => !hideSet.has(r.Id));
    }
    // "Show only needs-deploy" filter — inverse of Hide in-sync. Shows ONLY
    // records badged missing-in-target or drift. Only meaningful with a fresh
    // live diff; without one, falls back to "anything not previously deployed".
    if (showOnlyTodo) {
      if (scanFresh) {
        list = list.filter(r => idsMissingInTarget.has(r.Id) || idsDrift.has(r.Id));
      } else {
        list = list.filter(r => !deployedIds.has(r.Id));
      }
    }

    return `
      <div class="ds-modal-header">🎯 Pick Records — <strong>${esc(objType)}</strong></div>
      <div class="ds-modal-body ds-picker-body">

        <!-- Match field selectors — drive what's displayed AND how records
             match across orgs (Salesforce IDs differ between orgs, so a
             non-Id field needs to be the cross-org identity). Per-org because
             a field called "Name" on source might be "Full_Name__c" on target. -->
        <div class="ds-rec-display-row">
          <div class="ds-rec-mf-col">
            <span class="ds-rec-display-lbl">Match on source:</span>
            ${candidateFields.length
              ? `<select id="dsRecDisplayField" class="ds-select ds-select-sm">
                  <option value="Id">Id (always unique)</option>
                  ${fieldOptions()}
                 </select>`
              : `<span class="ds-subtext">No string fields found — showing Id only</span>`}
          </div>
          <span class="ds-rec-mf-arrow">↔</span>
          <div class="ds-rec-mf-col">
            <span class="ds-rec-display-lbl">Match on target:</span>
            ${tgtCandidates && tgtCandidates.length
              ? `<select id="dsRecTgtMatchField" class="ds-select ds-select-sm" title="The field on the TARGET org whose value identifies the same logical record as the source-side field. Leave matching source if names are the same on both orgs.">
                  <option value="Id" ${tgtMatchField === 'Id' ? 'selected' : ''}>Id (always unique)</option>
                  ${tgtCandidates.map(f => `<option value="${esc(f.name)}" ${tgtMatchField === f.name ? 'selected' : ''}>${esc(f.label)} (${esc(f.name)})</option>`).join('')}
                 </select>`
              : `<input id="dsRecTgtMatchField" class="ds-input ds-input-sm" value="${esc(tgtMatchField)}" placeholder="${esc(displayField)}" title="Target session unavailable — type the target-side field API name manually. Open the target org in a Chrome tab to get a dropdown.">`}
          </div>
        </div>

        ${queryError ? `<div class="ds-error-banner" style="margin-bottom:8px">${esc(queryError)}</div>` : ''}

        <!-- Search + bulk actions -->
        <div class="ds-picker-toolbar">
          <input id="dsRecSearch" class="ds-input ds-input-sm" placeholder="Search…" value="${esc(filter)}" autocomplete="off">
          <button class="ds-btn ds-btn-xs" id="dsRecAll">All</button>
          <button class="ds-btn ds-btn-xs" id="dsRecNone">None</button>
          ${(scanFresh ? idsInSync.size : deployedIds.size) ? `
            <label class="ds-pick-toggle" title="${scanFresh ? 'Hide records that already match between source and target according to the latest diff scan' : 'Hide records that were already successfully transferred to this target'}">
              <input type="checkbox" id="dsRecHideDeployed" ${hideDeployed ? 'checked' : ''}>
              <span>${scanFresh ? 'Hide in-sync' : 'Hide already deployed'}</span>
              <span class="ds-pick-deployed-count">${scanFresh ? idsInSync.size : deployedIds.size}</span>
            </label>` : ''}
          ${scanFresh && (idsMissingInTarget.size || idsDrift.size) ? `
            <label class="ds-pick-toggle" title="Show only records that need to be deployed — missing in target OR present-but-drifted. Hides everything that's already in sync.">
              <input type="checkbox" id="dsRecShowOnlyTodo" ${showOnlyTodo ? 'checked' : ''}>
              <span>Only needs-deploy</span>
              <span class="ds-pick-deployed-count ds-pick-todo-count">${idsMissingInTarget.size + idsDrift.size}</span>
            </label>` : ''}
        </div>

        <div class="ds-picker-note" id="dsRecNote">${noteHtml()}</div>
        ${scanFresh ? `
          <div class="ds-pick-diff-legend">
            Live diff (${esc(timeAgo(liveScan.runAt))}):
            <span class="ds-pick-leg ds-diff-missing">🔴 Missing in target</span>
            <span class="ds-pick-leg ds-diff-drift">🟡 Drift</span>
            <span class="ds-pick-leg ds-diff-sync">🟢 In sync</span>
          </div>` : ''}

        <div class="ds-picker-list" id="dsRecList">
          ${!records.length
            ? `<div class="ds-picker-empty">${queryError ? 'Query failed.' : 'No records found.'}</div>`
            : list.map(r => {
                const label = (displayField && r[displayField]) ? r[displayField] : r.Id;
                const sub   = displayField && r[displayField] ? r.Id : '';
                // Live-scan state takes priority over history when available
                let rowCls = '', badgeHtml = '';
                const isDrift = scanFresh && idsDrift.has(r.Id);
                if (scanFresh) {
                  if (idsMissingInTarget.has(r.Id)) {
                    rowCls = ' ds-pick-row-missing';
                    badgeHtml = '<span class="ds-pick-state-badge ds-diff-missing" title="Not present in the target org — will be inserted if you transfer this record">🔴 missing in target</span>';
                  } else if (isDrift) {
                    rowCls = ' ds-pick-row-drift';
                    // Drift badge is clickable — opens inline compare table below.
                    // Tooltip names the differing fields from the scan so "why
                    // is this drift?" is answerable without the live fetch.
                    const dFields = driftTargetId.get(r.Id)?.fields || [];
                    const dTip = dFields.length
                      ? `Differs at last scan: ${dFields.join(', ')} — click for field-by-field comparison`
                      : 'Click to see field-by-field comparison';
                    badgeHtml = `<span class="ds-pick-state-badge ds-diff-drift ds-pick-drift-clickable" data-drift-id="${esc(r.Id)}" title="${esc(dTip)}">🟡 drift ▸</span>`;
                  } else if (idsInSync.has(r.Id)) {
                    rowCls = ' ds-pick-row-deployed';
                    badgeHtml = '<span class="ds-pick-state-badge ds-diff-sync" title="Present in target and all compare fields match — no action needed">🟢 in sync</span>';
                  }
                } else if (deployedIds.has(r.Id)) {
                  rowCls = ' ds-pick-row-deployed';
                  badgeHtml = '<span class="ds-pick-deployed-badge" title="This record was successfully transferred to the target org in a previous run">✓ deployed</span>';
                }
                return `<div class="ds-pick-row-container">
                  <label class="ds-pick-row${rowCls}">
                    <input type="checkbox" value="${esc(r.Id)}" ${selected.has(r.Id) ? 'checked' : ''}>
                    <span class="ds-pick-label">${esc(label)}</span>
                    ${badgeHtml}
                    ${sub ? `<span class="ds-pick-api ds-pick-id">${esc(sub)}</span>` : ''}
                  </label>
                  ${isDrift ? `<div class="ds-pick-row-expand" data-expand-for="${esc(r.Id)}" style="display:none"></div>` : ''}
                </div>`;
              }).join('')}
        </div>
        ${records.length >= 200 ? `<div class="ds-picker-limit">Showing first 200 — use WHERE filter to narrow results.</div>` : ''}
      </div>
      <div class="ds-modal-footer">
        <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
        <button class="ds-btn ds-btn-primary" id="dsRecSave">✓ Apply</button>
      </div>`;
  }

  function wireModal(filter = '') {
    const note = () => { const el = eid('dsRecNote'); if (el) el.innerHTML = noteHtml(); };

    // Source-side match field change → persist as node.matchField, re-query, re-render.
    // Also auto-update tgtMatchField if the user hasn't explicitly set one yet,
    // since the most common case is "same name on both sides".
    eid('dsRecDisplayField')?.addEventListener('change', async e => {
      displayField = e.target.value;
      node._meta._recDisplayField = displayField;
      node.matchField             = displayField;  // persisted: cross-org identity (src side)
      // If the user hasn't explicitly picked a target match field, follow the source choice
      if (!node.matchFieldTgt || node.matchFieldTgt === '') {
        tgtMatchField = deriveTgtMatchDefault(displayField);
      }
      const box = eid('dsModalBox');
      if (box) box.innerHTML = `<div class="ds-modal-body" style="text-align:center;padding:40px;color:var(--subtext)">Loading…</div>`;
      await fetchRecords();
      if (box) { box.innerHTML = renderModal(''); wireModal(''); }
    });

    // Target-side match field change → persist as node.matchFieldTgt.
    // Both dropdown (with session) and free-text input (without) share this handler.
    const tgtMfEl = eid('dsRecTgtMatchField');
    tgtMfEl?.addEventListener('change', e => {
      const v = (e.target.value || '').trim();
      tgtMatchField        = v || displayField;       // empty → mirror source
      node.matchFieldTgt   = v || null;               // null = "use source-side name on target too"
    });

    eid('dsRecSearch')?.addEventListener('input', e => {
      const val = e.target.value;
      const box = eid('dsModalBox');
      if (box) {
        box.innerHTML = renderModal(val);
        wireModal(val);
        const inp = eid('dsRecSearch');
        if (inp) { inp.focus(); inp.setSelectionRange(val.length, val.length); }
      }
    });

    eid('dsRecAll')?.addEventListener('click', () => {
      selected = new Set(records.map(r => r.Id));
      const box = eid('dsModalBox');
      if (box) { box.innerHTML = renderModal(filter); wireModal(filter); }
    });

    eid('dsRecNone')?.addEventListener('click', () => {
      selected = new Set();
      const box = eid('dsModalBox');
      if (box) { box.innerHTML = renderModal(filter); wireModal(filter); }
    });

    // Hide already-deployed records filter — re-renders the list with deployed
    // rows removed so the user only sees "still to transfer".
    eid('dsRecHideDeployed')?.addEventListener('change', e => {
      hideDeployed = e.target.checked;
      // Mutually exclusive with "Only needs-deploy" — they conflict
      if (hideDeployed && showOnlyTodo) showOnlyTodo = false;
      const box = eid('dsModalBox');
      if (box) { box.innerHTML = renderModal(filter); wireModal(filter); }
    });
    // Show only records that need to be deployed (missing or drift). Inverse
    // of Hide in-sync — picks them by inclusion instead of exclusion. Useful
    // for "select what to transfer" in one click.
    eid('dsRecShowOnlyTodo')?.addEventListener('change', e => {
      showOnlyTodo = e.target.checked;
      if (showOnlyTodo && hideDeployed) hideDeployed = false;
      const box = eid('dsModalBox');
      if (box) { box.innerHTML = renderModal(filter); wireModal(filter); }
    });

    eid('dsRecList')?.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(cb.value); else selected.delete(cb.value);
        note();
      });
    });

    // Drift-badge click → fetch the specific record from both orgs and show
    // a field-by-field compare table inline below the row. Click again to
    // collapse. Stops the click from propagating up to the <label> so the
    // checkbox doesn't toggle just because the user wanted to see what's
    // drifting.
    eid('dsRecList')?.querySelectorAll('.ds-pick-drift-clickable').forEach(badge => {
      badge.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const recId = badge.dataset.driftId;
        if (!recId) return;
        const driftInfo = driftTargetId.get(recId);
        if (!driftInfo?.targetId) {
          showToast('No target Id recorded for this drift entry — run 🔄 Refresh state to repopulate', 'error', 4500);
          return;
        }
        const expand = document.querySelector(`.ds-pick-row-expand[data-expand-for="${recId}"]`);
        if (!expand) return;
        // Toggle if already loaded
        if (expand.dataset.loaded === '1') {
          expand.style.display = expand.style.display === 'none' ? 'block' : 'none';
          return;
        }
        expand.style.display = 'block';
        expand.innerHTML = `<div class="ds-drift-compare-loading">Loading field values…</div>`;
        const srcFields = (liveScan?.compareFields    || []);
        const tgtFields = (liveScan?.compareFieldsTgt || liveScan?.compareFields || []);
        const result = await fetchDriftRowDetail(
          _editingProfile, objType, recId, driftInfo.targetId, srcFields, tgtFields);
        if (result.error) {
          // Live fetch unavailable — fall back to the scan-time answer so
          // "why is this drift?" still gets answered.
          const fieldsNote = (driftInfo.fields || []).length
            ? `<div class="ds-drift-compare-fallback">At the last scan these field(s) differed:
                 <strong>${esc(driftInfo.fields.join(', '))}</strong></div>`
            : '';
          expand.innerHTML = `${fieldsNote}<div class="ds-drift-compare-err">⚠ ${esc(result.error)}</div>`;
          return;
        }
        expand.innerHTML = renderDriftCompareTable(
          result.srcRec, result.tgtRec, srcFields, tgtFields);
        expand.dataset.loaded = '1';
      });
    });

    eid('dsRecSave')?.addEventListener('click', () => {
      node.recordIds = selected.size > 0 ? [...selected] : null;
      closeModal();
      refreshTree();
    });
  }

  showModal(renderModal());
  wireModal();
}

// ════════════════════════════════════════════════════════════════
// TRANSFER RECORD FILTER MODAL
// Opens from the Transfer screen's plan rows. Saves run-time overrides
// to _transferNodeFilters[pathKey] without touching the saved profile.
// ════════════════════════════════════════════════════════════════
async function openTransferRecordFilterModal(pathKey, objType) {
  if (!_transferSrc?.orgUrl || !_transferSrc?.sid) {
    showModal(`
      <div class="ds-modal-header">🎯 Filter Records — ${esc(objType)}</div>
      <div class="ds-modal-body" style="padding:24px;color:var(--warning)">
        Select a Source Org first.
      </div>
      <div class="ds-modal-footer"><button class="ds-btn" data-dsaction="closeModal">Close</button></div>`);
    return;
  }

  // Profile-saved defaults for this node (read-only reference)
  const profileNode    = _transferProfile ? getNodeByPath(_transferProfile.tree, pathKey) : null;
  const profileWhere   = profileNode?.where     || null;
  const profileRecIds  = profileNode?.recordIds || null;

  // Current run-time override (undefined = not set, use profile defaults)
  const hasOverride  = pathKey in _transferNodeFilters;
  const curOverride  = _transferNodeFilters[pathKey] || {};

  let whereClause = hasOverride ? (curOverride.where || '') : (profileWhere || '');
  let selected    = new Set(hasOverride ? (curOverride.recordIds || []) : (profileRecIds || []));

  // Load describe to get candidate display fields from source org
  showModal(`
    <div class="ds-modal-header">🎯 Filter Records — ${esc(objType)}</div>
    <div class="ds-modal-body" style="text-align:center;padding:40px;color:var(--subtext)">
      Loading fields from ${esc(orgLabel(_transferSrc.orgUrl))}…
    </div>`);

  const desc = await sendBg({
    type: 'SF_REST_GET',
    orgUrl: _transferSrc.orgUrl, sid: _transferSrc.sid,
    path: `services/data/v62.0/sobjects/${objType}/describe`
  });

  const candidateFields = (desc.error ? [] : (desc.fields || []))
    .filter(f => STRING_TYPES.has(f.type) && !f.deprecatedAndHidden && f.name !== 'Id')
    .map(f => ({ name: f.name, label: f.label || f.name }))
    .sort((a, b) => {
      const PREF = ['Name','CaseNumber','Subject','OrderNumber','ContractNumber','Title','AssetName'];
      const ai = PREF.indexOf(a.name), bi = PREF.indexOf(b.name);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1; if (bi !== -1) return 1;
      return a.label.localeCompare(b.label);
    });

  let displayField  = candidateFields[0]?.name || null;
  let records       = [];
  let queryError    = null;
  let recordsLoaded = false;

  async function fetchRecords() {
    const fld  = displayField && displayField !== 'Id' ? displayField : null;
    const w    = whereClause.trim();
    const soql = `SELECT Id${fld ? `,${fld}` : ''} FROM ${objType}${w ? ' WHERE ' + w : ''} ORDER BY ${fld || 'Id'} LIMIT 200`;
    const res  = await sendBg({ type: 'SF_QUERY', tooling: false,
      orgUrl: _transferSrc.orgUrl, sid: _transferSrc.sid, query: soql });
    queryError    = res.error || null;
    records       = res.error ? [] : (res.records || []);
    recordsLoaded = true;
  }

  await fetchRecords();

  function noteHtml() {
    if (selected.size > 0)
      return `<strong>${selected.size}</strong> record${selected.size !== 1 ? 's' : ''} selected — only these will be transferred`;
    if (whereClause.trim())
      return `WHERE filter active — all matching records will be transferred`;
    return `No filter — all records will be transferred`;
  }

  function fieldOptions() {
    return candidateFields.map(f =>
      `<option value="${esc(f.name)}" ${displayField === f.name ? 'selected' : ''}>${esc(f.label)} (${esc(f.name)})</option>`
    ).join('');
  }

  function renderModal(filter = '') {
    const lc   = filter.toLowerCase();
    const list = filter
      ? records.filter(r => {
          const v = (r[displayField] || r.Id || '').toLowerCase();
          return v.includes(lc) || r.Id.toLowerCase().includes(lc);
        })
      : records;

    const profileHint = profileRecIds?.length
      ? `Profile default: ${profileRecIds.length} saved IDs`
      : profileWhere
        ? `Profile default: WHERE ${esc(profileWhere)}`
        : `Profile default: no filter`;

    return `
      <div class="ds-modal-header">🎯 Filter Records — <strong>${esc(objType)}</strong></div>
      <div class="ds-modal-body ds-picker-body">

        ${hasOverride ? `<div style="font-size:11px;background:#EEF2FF;border:1px solid #C7D2FE;border-radius:4px;padding:6px 10px;margin-bottom:10px">
          ⚙️ <strong>Run-time override active</strong> — saved profile is unchanged.
          <button class="ds-btn ds-btn-xs" id="dsTrFltReset" style="margin-left:8px">↺ Reset to profile default</button>
        </div>` : `<div style="font-size:11px;color:var(--subtext);margin-bottom:10px">
          ${profileHint} · Changes here apply to this run only.
        </div>`}

        <!-- WHERE clause -->
        <div style="margin-bottom:10px">
          <label class="ds-lbl" style="font-size:12px;margin-bottom:4px">
            WHERE clause <span style="font-weight:400;color:var(--subtext)">(optional SOQL filter)</span>
          </label>
          <div style="display:flex;gap:8px;align-items:center">
            <input id="dsTrFltWhere" class="ds-input" style="flex:1"
              placeholder="e.g. IsActive = true AND CreatedDate = LAST_N_DAYS:30"
              value="${esc(whereClause)}" autocomplete="off">
            <button class="ds-btn ds-btn-sm" id="dsTrFltReload">🔄 Load Records</button>
          </div>
        </div>

        <!-- Display field selector -->
        <div class="ds-rec-display-row">
          <span class="ds-rec-display-lbl">Show field:</span>
          ${candidateFields.length
            ? `<select id="dsTrFltDisplayField" class="ds-select ds-select-sm">
                <option value="Id">Id (always unique)</option>
                ${fieldOptions()}
               </select>`
            : `<span class="ds-subtext">No label fields — showing Id only</span>`}
        </div>

        ${queryError ? `<div class="ds-error-banner" style="margin:8px 0">${esc(queryError)}</div>` : ''}

        <!-- Search + bulk actions -->
        <div class="ds-picker-toolbar" style="margin-top:8px">
          <input id="dsTrFltSearch" class="ds-input ds-input-sm" placeholder="Search…"
                 value="${esc(filter)}" autocomplete="off">
          <button class="ds-btn ds-btn-xs" id="dsTrFltAll">All</button>
          <button class="ds-btn ds-btn-xs" id="dsTrFltNone">None</button>
        </div>

        <div class="ds-picker-note" id="dsTrFltNote">${noteHtml()}</div>

        <div class="ds-picker-list" id="dsTrFltList">
          ${!recordsLoaded
            ? `<div class="ds-picker-empty">Loading…</div>`
            : !records.length
              ? `<div class="ds-picker-empty">${queryError ? 'Query failed — check WHERE clause.' : 'No records found.'}</div>`
              : list.map(r => {
                  const lbl = (displayField && r[displayField]) ? r[displayField] : r.Id;
                  const sub = displayField && r[displayField] ? r.Id : '';
                  return `<label class="ds-pick-row">
                    <input type="checkbox" value="${esc(r.Id)}" ${selected.has(r.Id) ? 'checked' : ''}>
                    <span class="ds-pick-label">${esc(lbl)}</span>
                    ${sub ? `<span class="ds-pick-api ds-pick-id">${esc(sub)}</span>` : ''}
                  </label>`;
                }).join('')}
        </div>
        ${records.length >= 200 ? `<div class="ds-picker-limit">Showing first 200 — use WHERE clause to narrow.</div>` : ''}
      </div>
      <div class="ds-modal-footer">
        <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
        <button class="ds-btn ds-btn-primary" id="dsTrFltSave">✓ Apply</button>
      </div>`;
  }

  function wireModal(filter = '') {
    const note = () => { const el = eid('dsTrFltNote'); if (el) el.innerHTML = noteHtml(); };

    // WHERE input — track value without re-querying (press Load to reload)
    eid('dsTrFltWhere')?.addEventListener('input', e => { whereClause = e.target.value; note(); });

    // Load Records — re-query with updated WHERE
    eid('dsTrFltReload')?.addEventListener('click', async () => {
      whereClause = eid('dsTrFltWhere')?.value || '';
      const box = eid('dsModalBox');
      if (box) box.innerHTML = `<div class="ds-modal-body" style="text-align:center;padding:40px;color:var(--subtext)">Loading…</div>`;
      await fetchRecords();
      if (box) { box.innerHTML = renderModal(''); wireModal(''); }
    });

    // Display field → re-query
    eid('dsTrFltDisplayField')?.addEventListener('change', async e => {
      displayField = e.target.value;
      whereClause  = eid('dsTrFltWhere')?.value || whereClause;
      const box = eid('dsModalBox');
      if (box) box.innerHTML = `<div class="ds-modal-body" style="text-align:center;padding:40px;color:var(--subtext)">Loading…</div>`;
      await fetchRecords();
      if (box) { box.innerHTML = renderModal(''); wireModal(''); }
    });

    // Search with focus restore
    eid('dsTrFltSearch')?.addEventListener('input', e => {
      const val = e.target.value;
      const box = eid('dsModalBox');
      if (box) {
        box.innerHTML = renderModal(val);
        wireModal(val);
        const inp = eid('dsTrFltSearch');
        if (inp) { inp.focus(); inp.setSelectionRange(val.length, val.length); }
      }
    });

    // All / None
    eid('dsTrFltAll')?.addEventListener('click', () => {
      selected = new Set(records.map(r => r.Id));
      const box = eid('dsModalBox');
      if (box) { box.innerHTML = renderModal(filter); wireModal(filter); }
    });
    eid('dsTrFltNone')?.addEventListener('click', () => {
      selected = new Set();
      const box = eid('dsModalBox');
      if (box) { box.innerHTML = renderModal(filter); wireModal(filter); }
    });

    // Checkboxes
    eid('dsTrFltList')?.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(cb.value); else selected.delete(cb.value);
        note();
      });
    });

    // Reset to profile default — remove the override
    eid('dsTrFltReset')?.addEventListener('click', () => {
      delete _transferNodeFilters[pathKey];
      closeModal();
      updateTransferPreview();
    });

    // Apply — save override and refresh plan
    eid('dsTrFltSave')?.addEventListener('click', () => {
      const w    = whereClause.trim() || null;
      const rIds = selected.size > 0 ? [...selected] : null;
      _transferNodeFilters[pathKey] = { where: w, recordIds: rIds };
      closeModal();
      updateTransferPreview();
    });
  }

  showModal(renderModal());
  wireModal();
}

// ── Save profile ──────────────────────────────────────────────
// Write the in-memory _editingProfile to _profiles + chrome.storage, without
// navigating away from the builder. Used by Apply handlers (field mapping,
// lookup resolution) so partial edits stick to disk immediately — otherwise
// users hit "Apply" and assume it saved, then close the builder and lose it.
async function commitEditingProfile() {
  if (!_editingProfile) return;
  const nameEl = eid('dsProfileName');
  if (nameEl) _editingProfile.name = nameEl.value.trim() || _editingProfile.name || 'Unnamed';
  _editingProfile.updatedAt = new Date().toISOString();

  function stripMeta(node) {
    if (!node) return node;
    const { _meta, ...clean } = node;
    clean.children = (node.children || []).map(stripMeta);
    return clean;
  }
  const toSave = { ..._editingProfile, tree: stripMeta(_editingProfile.tree) };

  const idx = _profiles.findIndex(p => p.id === toSave.id);
  if (idx !== -1) _profiles[idx] = toSave;
  else _profiles.push(toSave);

  // Keep the active transfer profile reference in sync so the Run button
  // picks up the change without the user re-selecting the profile.
  if (_transferProfile && _transferProfile.id === toSave.id) {
    _transferProfile = _profiles[idx !== -1 ? idx : _profiles.length - 1];
  }

  await storageSaveProfiles();
}

async function saveProfile() {
  await commitEditingProfile();
  renderProfiles();
}

// ════════════════════════════════════════════════════════════════
// SCAN CONFIG DERIVATION
// ════════════════════════════════════════════════════════════════
// Profiles used to have explicit matchField + compareFields inputs in
// the Profile Builder. That was redundant — users already declare which
// fields matter when they configure the Field Mapping modal on the root
// node. This helper derives scanConfig at runtime so callers don't need
// to read profile.scanConfig directly.
//
//   matchField     ← profile.scanConfig.matchField (legacy backwards-compat)
//                    or 'Name' (with describe-based fallback at use time)
//   compareFields  ← keys of node.fieldMappings that map to a non-null target
//                    or profile.scanConfig.compareFields (legacy backwards-compat)
//                    or []  (presence-only diff)
//
// Backward compat: if a profile has the old scanConfig values set explicitly,
// they still take effect — we don't want to silently change behavior for
// existing profiles that had custom config.
function deriveScanConfig(profile, node) {
  const legacyMatch   = profile?.scanConfig?.matchField;
  const legacyCompare = (profile?.scanConfig?.compareFields || []).filter(Boolean);

  const mappings = node?.fieldMappings || {};
  // Strip system identity fields from compareFields. Id, CreatedDate, etc.
  // aren't copyable — if they leak into fieldMappings (from legacy profiles
  // or aggressive Auto-Map), they break SOQL with "duplicate field selected"
  // and pollute drift comparison since Ids ALWAYS differ across orgs.
  const SYSTEM_NEVER_COMPARE = new Set([
    'Id', 'CreatedDate', 'CreatedById', 'LastModifiedDate', 'LastModifiedById',
    'SystemModstamp', 'LastActivityDate', 'LastViewedDate', 'LastReferencedDate',
    'IsDeleted', 'MasterRecordId', 'IsArchived'
  ]);
  const fromMappings = Object.keys(mappings).filter(k =>
    mappings[k] !== null && mappings[k] !== '' && !SYSTEM_NEVER_COMPARE.has(k)
  );

  // Source-side matchField — picked via "Match on source" in Pick Records,
  // persisted as node.matchField. Falls back to legacy profile.scanConfig
  // (no Pick Records visit yet) then 'Name' (auto-corrected at use time).
  const matchField = node?.matchField || legacyMatch || 'Name';

  // Target-side matchField — picked via "Match on target" in Pick Records,
  // persisted as node.matchFieldTgt. Defaults to the field mapping for the
  // source matchField (so a Name→Full_Name__c mapping auto-pairs identity
  // without a second config step). If neither, mirrors the source field
  // name and lets runtime auto-correct via target's describe.
  const matchFieldTgt = node?.matchFieldTgt
    || (mappings[matchField] && mappings[matchField] !== null ? mappings[matchField] : matchField);

  return {
    matchField,
    matchFieldTgt,
    compareFields: fromMappings.length ? fromMappings : legacyCompare
  };
}

// ════════════════════════════════════════════════════════════════
// LIVE DIFF SCAN — the source of truth for "what's in each org"
// ════════════════════════════════════════════════════════════════
// Queries source AND target for the profile's root object, indexes both
// sides by the configured matchField, and computes four buckets:
//
//   missingInTarget — in source but not in target (candidate for deploy)
//   onlyInTarget    — in target but not in source (extras, optional delete)
//   changed         — in both, but a compareField differs (drift)
//   identical       — in both, all compareFields match (in sync)
//
// The result is stored on profile.lastScan so the picker + cards can show
// live state without re-querying every time the user opens a modal.
async function runDiffScan(profile) {
  if (!profile)                  return { error: 'no profile' };
  if (!profile.sourceOrg)        return { error: 'profile has no source org set' };
  if (!profile.targetOrg)        return { error: 'profile has no target org set' };
  const objType = profile.tree?.objectType || profile.tree?.childSObject;
  if (!objType)                  return { error: 'profile has no root object' };

  const derived = deriveScanConfig(profile, profile.tree);
  let srcMatchField  = derived.matchField;
  let tgtMatchField  = derived.matchFieldTgt;
  let srcCompare     = derived.compareFields;
  let tgtCompare     = derived.compareFields.map(f => {
    // Per-side compareField names: a source field with a mapping uses the
    // mapped target name; unmapped fields assume same name on target.
    const fm = profile.tree?.fieldMappings || {};
    return (fm[f] && fm[f] !== null) ? fm[f] : f;
  });
  const where       = (profile.tree?.where || '').trim();

  // Resolve sessions for both orgs. They must be reachable (open in Chrome
  // OR stored as credentialed orgs) — otherwise the scan can't query target.
  const allSess = _buildAllSessions();
  const srcSess = _resolveSession(profile.sourceOrg, allSess);
  const tgtSess = _resolveSession(profile.targetOrg, allSess);
  if (!srcSess?.sid) return { error: `source org session not active — open ${orgLabel(profile.sourceOrg)} in a tab` };
  if (!tgtSess?.sid) return { error: `target org session not active — open ${orgLabel(profile.targetOrg)} in a tab` };

  // Validate matchField + compareFields against EACH side's describe.
  // matchField corrects per side (Name might exist on source while the
  // target object uses ReturnOrderNumber). compareFields are validated as
  // PAIRS — (srcCompare[i], tgtCompare[i]) refer to the same logical field,
  // so a pair survives only when BOTH sides have the field. (The old code
  // filtered each side independently, which shifted the index pairing
  // whenever a field existed on only one side — comparing field A on
  // source to field B on target.)
  //
  // Pairs are ALSO dropped when either side's field is a lookup
  // (type 'reference'). Lookup fields hold org-local record Ids that can
  // NEVER match across orgs — after an insert-based transfer the target's
  // AccountId is a different Id (or null via Set-null resolution), so
  // counting them as drift flags every transferred record as "changed"
  // forever. Upsert/lookup-bridge runs resolve lookups at write time; the
  // drift scan compares real data fields only.
  async function describeFieldTypes(sess) {
    try {
      const d = await describe(objType, sess.orgUrl, sess.sid);
      const types = new Map((d?.fields || []).map(f => [f.name, f.type]));
      const nameFld = (d?.fields || []).find(f => f.nameField === true)?.name || null;
      return { types, nameFld };
    } catch (_) { return { types: new Map(), nameFld: null }; }
  }
  const [srcDesc, tgtDesc] = await Promise.all([describeFieldTypes(srcSess), describeFieldTypes(tgtSess)]);
  if (srcDesc.types.size && !srcDesc.types.has(srcMatchField) && srcDesc.nameFld) srcMatchField = srcDesc.nameFld;
  if (tgtDesc.types.size && !tgtDesc.types.has(tgtMatchField) && tgtDesc.nameFld) tgtMatchField = tgtDesc.nameFld;
  if (srcDesc.types.size && tgtDesc.types.size) {
    const keptSrc = [], keptTgt = [];
    for (let i = 0; i < Math.min(srcCompare.length, tgtCompare.length); i++) {
      const s = srcCompare[i], t = tgtCompare[i];
      if (!srcDesc.types.has(s) || !tgtDesc.types.has(t)) continue;        // missing on a side
      if (srcDesc.types.get(s) === 'reference' || tgtDesc.types.get(t) === 'reference') continue; // lookups never match cross-org
      keptSrc.push(s); keptTgt.push(t);
    }
    srcCompare = keptSrc;
    tgtCompare = keptTgt;
  }

  // Per-org SOQL — different field name on each side is the whole point.
  const srcFieldList = [...new Set(['Id', srcMatchField, ...srcCompare])].filter(Boolean).join(',');
  const tgtFieldList = [...new Set(['Id', tgtMatchField, ...tgtCompare])].filter(Boolean).join(',');
  const srcSoql = `SELECT ${srcFieldList} FROM ${objType}${where ? ' WHERE ' + where : ''}`;
  const tgtSoql = `SELECT ${tgtFieldList} FROM ${objType}${where ? ' WHERE ' + where : ''}`;

  let srcRes, tgtRes;
  try {
    [srcRes, tgtRes] = await Promise.all([
      sendBg({ type: 'SF_QUERY_ALL', orgUrl: srcSess.orgUrl, sid: srcSess.sid, tooling: false, query: srcSoql }),
      sendBg({ type: 'SF_QUERY_ALL', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, tooling: false, query: tgtSoql })
    ]);
  } catch (e) {
    return { error: `scan failed: ${e?.message || e}` };
  }
  if (srcRes?.error) return { error: `source query failed: ${srcRes.error}` };
  if (tgtRes?.error) return { error: `target query failed: ${tgtRes.error}` };

  // Index each side by its own matchField — KEYS are the values themselves,
  // which match across orgs even when the field names that hold them differ
  // (Name="Andy Young" on source, Full_Name__c="Andy Young" on target both
  // key to "Andy Young"). Coerce to string so "123" (number) and "123"
  // (text) cross-org don't accidentally land in different buckets.
  const srcByKey = new Map();
  for (const r of (srcRes.records || [])) {
    const k = r[srcMatchField];
    if (k != null && k !== '') srcByKey.set(String(k), r);
  }
  const tgtByKey = new Map();
  for (const r of (tgtRes.records || [])) {
    const k = r[tgtMatchField];
    if (k != null && k !== '') tgtByKey.set(String(k), r);
  }

  const missingInTarget = []; // present in source, absent in target → "deploy"
  const onlyInTarget    = []; // present in target, absent in source → "extras"
  const changed         = []; // present in both, compareFields differ → "drift"
  const identical       = []; // present in both, all compareFields match → "in sync"

  // Pair-aligned compare: srcCompare and tgtCompare are same-length lists
  // where index i on each side refers to the same logical field. Filter
  // both side-by-side so a field dropped on one side is dropped on both.
  const pairLength = Math.min(srcCompare.length, tgtCompare.length);
  for (const [k, sr] of srcByKey) {
    const tr = tgtByKey.get(k);
    if (!tr) {
      missingInTarget.push({ matchKey: k, sourceId: sr.Id });
    } else {
      // Record WHICH fields differ (capped) — this is what lets the UI
      // answer "why is this drift?" without a live re-fetch, including
      // when one org isn't open in a tab.
      const diffFields = [];
      for (let i = 0; i < pairLength; i++) {
        if (String(sr[srcCompare[i]] ?? '') !== String(tr[tgtCompare[i]] ?? '')) {
          if (diffFields.length < 10) diffFields.push(srcCompare[i]);
          else break;
        }
      }
      if (diffFields.length) changed.push({ matchKey: k, sourceId: sr.Id, targetId: tr.Id, fields: diffFields });
      else                   identical.push({ matchKey: k, sourceId: sr.Id, targetId: tr.Id });
    }
  }
  for (const [k, tr] of tgtByKey) {
    if (!srcByKey.has(k)) onlyInTarget.push({ matchKey: k, targetId: tr.Id });
  }

  return {
    runAt:         new Date().toISOString(),
    status:        'success',
    objectType:    objType,
    // Stamp the org pair into the scan result so the picker can detect
    // when the user has changed orgs since the scan ran. If the profile's
    // current sourceOrg/targetOrg don't match these, the scan is stale.
    sourceOrg:     profile.sourceOrg,
    targetOrg:     profile.targetOrg,
    matchField:    srcMatchField,
    matchFieldTgt: tgtMatchField,
    compareFields: srcCompare,
    compareFieldsTgt: tgtCompare,
    sourceCount:   srcByKey.size,
    targetCount:   tgtByKey.size,
    // Caps to keep chrome.storage payload reasonable on big orgs. The
    // picker only needs source IDs to badge rows, and "extras in target"
    // is just informational for now.
    missingInTarget: missingInTarget.slice(0, 5000),
    onlyInTarget:    onlyInTarget.slice(0, 5000),
    changed:         changed.slice(0, 5000),
    identical:       identical.slice(0, 5000),
    truncated: (
      missingInTarget.length > 5000 ||
      onlyInTarget.length    > 5000 ||
      changed.length         > 5000 ||
      identical.length       > 5000
    )
  };
}

// Run the diff scan for the given profileId, write the result back to the
// profile, persist, refresh whatever UI is open. Returns the result object
// so the caller can show a toast / error / counts inline.
async function refreshProfileDiff(profileId) {
  // Ephemeral profiles (from Org Compare → Reconcile) aren't in _profiles —
  // fall back to the in-memory _reconcileProfile so the refresh button inside
  // Reconcile still works on them. ephemeral profiles skip the storage save.
  let profile = _profiles.find(p => p.id === profileId);
  if (!profile && _reconcileProfile && _reconcileProfile.id === profileId) {
    profile = _reconcileProfile;
  }
  if (!profile) return null;
  const res = await runDiffScan(profile);
  if (res?.error) {
    showToast(`Diff scan: ${res.error}`, 'error', 6000);
    return res;
  }
  profile.lastScan  = res;
  profile.updatedAt = new Date().toISOString();
  if (!profile.ephemeral) await storageSaveProfiles();

  // Keep the in-memory transfer profile aligned, mirroring commitEditingProfile.
  if (_transferProfile && _transferProfile.id === profile.id) _transferProfile = profile;

  showToast(
    `Diff refreshed — ${res.missingInTarget.length} missing, ${res.changed.length} drift, ${res.identical.length} in sync`,
    'success', 4000);
  // Re-render whichever view is open
  if (_currentView === 'profiles') renderProfiles();
  return res;
}
window.refreshProfileDiff = refreshProfileDiff;

// "Refresh state" — now just the diff scan (drives Pick Records badges +
// profile card chips + Reconcile columns). The snapshot capture that this
// used to bundle was removed along with the Org Map drift overlay (its only
// consumer). Kept as a thin alias so the profile-card button and the
// post-transfer auto-refresh keep working without changes.
window.refreshProfileState = async function(profileId) {
  return refreshProfileDiff(profileId);
};

// Open the Run Transfer page pre-filtered to ONLY the failed source IDs
// from a previous run. Walks the run's summary, builds per-node recordIds
// overrides via _transferNodeFilters, sets _transferProfile, then renders
// the transfer view. The user just clicks ▶ Run to retry.
window.retryFailedRun = function(runId) {
  const run = _history.find(h => h.id === runId);
  if (!run) return showToast('Run not found', 'error', 3000);
  const profile = _profiles.find(p => p.id === run.profileId);
  if (!profile) return showToast('Profile no longer exists — cannot retry', 'error', 4000);

  // Build a map of objectType → [failedIds]
  const failedByObj = {};
  for (const [obj, s] of Object.entries(run.summary || {})) {
    const ids = (s.failedSourceIds || []).map(f => typeof f === 'string' ? f : f.id).filter(Boolean);
    if (ids.length) failedByObj[obj] = ids;
  }
  if (!Object.keys(failedByObj).length) {
    return showToast('No failed records recorded for this run — nothing to retry', 'info', 4000);
  }

  // Walk the tree, find each node whose objectType has failures, and seed
  // a transferNodeFilter with the failed IDs for that exact tree path.
  const filters = {};
  function walk(node, path) {
    if (!node) return;
    const t = node.objectType || node.childSObject;
    const pathKey = path.join('.');
    if (t && failedByObj[t]) {
      filters[pathKey] = { recordIds: failedByObj[t] };
    }
    (node.children || []).forEach((c, i) => walk(c, [...path, i]));
  }
  walk(profile.tree, []);

  // Seed the transfer page state, then navigate.
  _transferProfile      = profile;
  _transferNodeFilters  = filters;
  document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-view="profiles"]')?.classList.add('active');
  _currentView = 'profiles';
  renderTransfer();
  showToast(`Retry queued — ${Object.values(failedByObj).reduce((n,a)=>n+a.length,0)} record(s) across ${Object.keys(failedByObj).length} object(s). Click ▶ Run to retry.`, 'info', 5000);
};

// ════════════════════════════════════════════════════════════════
// DRIFT FIELD COMPARE — used by the Pick Records picker + Reconcile view
// ════════════════════════════════════════════════════════════════
// Fetches one record from each org on demand and renders a side-by-side
// field compare. No snapshot cache — queries live.
async function fetchDriftRowDetail(profile, objectType, srcId, tgtId, srcFields, tgtFields) {
  const allSess = _buildAllSessions();
  const srcUrl  = profile.schedule?.sourceOrg || profile.sourceOrg;
  const tgtUrl  = profile.schedule?.targetOrg || profile.targetOrg;
  const srcSess = _resolveSession(srcUrl, allSess);
  const tgtSess = _resolveSession(tgtUrl, allSess);
  if (!srcSess?.sid || !tgtSess?.sid) {
    // Name the org(s) that are actually missing — "open both orgs" sent
    // users hunting when only one tab was needed.
    const offline = [
      !srcSess?.sid ? orgLabel(srcUrl || '') : null,
      !tgtSess?.sid ? orgLabel(tgtUrl || '') : null
    ].filter(Boolean).join(' and ');
    return { error: `Open ${offline} in a Chrome tab to fetch live field values for the diff.` };
  }
  // Dedupe — if Id is already in compareFields the SOQL would 400 with
  // "duplicate field selected: Id". Same pattern runDiffScan uses.
  const srcSelect = [...new Set(['Id', ...srcFields])].filter(Boolean).join(',') || 'Id';
  const tgtSelect = [...new Set(['Id', ...tgtFields])].filter(Boolean).join(',') || 'Id';
  try {
    const [s, t] = await Promise.all([
      sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: srcSess.orgUrl, sid: srcSess.sid,
        query: `SELECT ${srcSelect} FROM ${objectType} WHERE Id = '${srcId}'` }),
      sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
        query: `SELECT ${tgtSelect} FROM ${objectType} WHERE Id = '${tgtId}'` })
    ]);
    if (s?.error) return { error: `Source query failed: ${s.error}` };
    if (t?.error) return { error: `Target query failed: ${t.error}` };
    return { srcRec: s.records?.[0] || null, tgtRec: t.records?.[0] || null };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

// Side-by-side compareField table — highlights rows whose values differ.
// srcFields[i] pairs with tgtFields[i] (pair-aligned, same as snapshot
// captureOrgSnapshot writes them).
function renderDriftCompareTable(srcRec, tgtRec, srcFields, tgtFields) {
  if (!srcRec || !tgtRec) {
    return `<div class="ds-drift-compare-err">⚠ Record not found on one or both orgs — may have been deleted since the snapshot was captured. Click 🔄 Refresh state to update.</div>`;
  }
  const pairs = [];
  const len = Math.min(srcFields.length, tgtFields.length);
  for (let i = 0; i < len; i++) {
    const sf = srcFields[i], tf = tgtFields[i];
    const sv = srcRec[sf], tv = tgtRec[tf];
    const sStr = (sv == null || sv === '') ? '∅' : String(sv);
    const tStr = (tv == null || tv === '') ? '∅' : String(tv);
    pairs.push({ srcField: sf, tgtField: tf, srcVal: sStr, tgtVal: tStr, differs: sStr !== tStr });
  }
  const diffCount = pairs.filter(p => p.differs).length;
  if (!pairs.length) {
    return `<div class="ds-drift-compare-empty">No compareFields configured for this profile — can't show field-by-field diff. Add fields to the Field Mapping on the root node to enable.</div>`;
  }
  return `
    <div class="ds-drift-compare">
      <div class="ds-drift-compare-hdr">${diffCount} of ${pairs.length} field${pairs.length !== 1 ? 's' : ''} differ${diffCount === 1 ? 's' : ''}</div>
      <div class="ds-drift-compare-table">
        <div class="ds-drift-compare-row ds-drift-compare-row-hdr">
          <span class="ds-drift-compare-field">Field</span>
          <span class="ds-drift-compare-val">Source</span>
          <span class="ds-drift-compare-val">Target</span>
        </div>
        ${pairs.map(p => `
          <div class="ds-drift-compare-row${p.differs ? ' ds-drift-compare-row-diff' : ''}">
            <span class="ds-drift-compare-field" title="${p.srcField !== p.tgtField ? esc(p.srcField + ' → ' + p.tgtField) : esc(p.srcField)}">
              ${esc(p.srcField)}${p.srcField !== p.tgtField ? `<span class="ds-drift-compare-rename"> → ${esc(p.tgtField)}</span>` : ''}
            </span>
            <span class="ds-drift-compare-val">${esc(p.srcVal)}</span>
            <span class="ds-drift-compare-val">${esc(p.tgtVal)}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// Manual "📸 Snapshot" for a single PROFILE — captures snapshots for every
// objectType in the profile's tree, on both sourceOrg and targetOrg. Uses
// profile.scanConfig for the root object, defaults to Name for children.
function _buildAllSessions() {
  const sessMap = new Map();
  if (_orgUrl) sessMap.set(_orgUrl, { orgUrl: _orgUrl, sid: _sid, label: orgLabel(_orgUrl) });
  for (const s of _allSessions) {
    if (!sessMap.has(s.orgUrl)) sessMap.set(s.orgUrl, { orgUrl: s.orgUrl, sid: s.sid, label: orgLabel(s.orgUrl) });
  }
  return [...sessMap.values()];
}

// Resolve a profile's org URL (a plain string) to a usable session object.
// Returns null if we have no session/credentials for that URL — caller is
// expected to show a "open this org in a tab or add credentials" warning.
function _resolveSession(orgUrl, allSess) {
  if (!orgUrl) return null;
  return allSess.find(s => s.orgUrl === orgUrl) || null;
}

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
    const srcUrl = _transferOrgOverride.src || _transferProfile?.sourceOrg || '';
    const tgtUrl = _transferOrgOverride.tgt || _transferProfile?.targetOrg || '';
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
          <input id="dsTrUpsertField" class="ds-input ds-input-sm"
            style="width:200px;${_transferWriteMode === 'upsert' ? '' : 'display:none'}"
            placeholder="External ID field (e.g. External_Id__c)"
            title="The external-Id field on the ROOT object used to match existing target records. Insert if no match, update if matched."
            value="${esc(_transferUpsertField)}">
        </div>
      </div>

      <div class="ds-transfer-footer">
        <button class="ds-btn" id="dsTrPreviewBtn">👁 Preview Counts</button>
        <button class="ds-btn ds-btn-primary ds-btn-lg" id="dsTrRunBtn" disabled>▶ Run Transfer</button>
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
    const editBtn = eid('dsTrEditProfile');
    if (editBtn) editBtn.disabled = !_transferProfile;
  });
  eid('dsTrEditProfile')?.addEventListener('click', () => {
    if (_transferProfile?.id) window.editProfile?.(_transferProfile.id);
  });
  eid('dsTrPreviewBtn')?.addEventListener('click', previewTransfer);
  eid('dsTrRunBtn')?.addEventListener('click', runTransfer);
  eid('dsTrDryRun')?.addEventListener('change', e => {
    _transferDryRun = e.target.checked;
    const btn = eid('dsTrRunBtn');
    if (btn && _transferDryRun) {
      btn.textContent = '🧪 Dry Run';
      btn.className = btn.className.replace('ds-btn-primary','') + ' ds-btn-primary-outline';
    } else if (btn) {
      btn.textContent = '▶ Run Transfer';
      btn.className = btn.className.replace('ds-btn-primary-outline','') + ' ds-btn-primary';
    }
  });
  eid('dsTrWriteMode')?.addEventListener('change', e => {
    _transferWriteMode = e.target.value;
    const fld = eid('dsTrUpsertField');
    if (fld) fld.style.display = _transferWriteMode === 'upsert' ? '' : 'none';
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

  if (_transferDryRun) {
    const btn = eid('dsTrRunBtn');
    if (btn) {
      btn.textContent = '🧪 Dry Run';
      btn.className = btn.className.replace('ds-btn-primary', '').trim() + ' ds-btn-primary-outline';
    }
  }
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
  const srcUrl  = _transferOrgOverride.src || p.sourceOrg || '';
  const tgtUrl  = _transferOrgOverride.tgt || p.targetOrg || '';
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
    const liveSet   = new Set(allSess.filter(s => s.sid).map(s => s.orgUrl));
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

      // ── Step 1: count records in source ──────────────────────────
      const countRes = await sendBg({
        type: 'SF_QUERY', tooling: false,
        orgUrl: _transferSrc.orgUrl, sid: _transferSrc.sid,
        query: `SELECT COUNT() FROM ${obj}${node.where ? ' WHERE ' + node.where : ''}`
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
        for (const f of srcFields) {
          if (!f.createable) continue;
          if (fm[f.name] === null) continue;                       // user-excluded
          const tgtField = (f.name in fm && fm[f.name]) ? fm[f.name] : f.name;
          // First source field "wins" the target slot (matches executor behaviour)
          if (!(tgtField in sourceForTarget)) sourceForTarget[tgtField] = f.name;
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
            query: `SELECT ${selectFields} FROM ${obj}${node.where ? ' WHERE ' + node.where : ''} LIMIT 200`
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
            query: `SELECT ${fieldName} FROM ${obj}${node.where ? ' WHERE ' + node.where : ''} LIMIT 50`
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
        const rtWhere = node.where
          ? `WHERE (${node.where}) AND RecordTypeId != null`
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

    await dryRunNode(buildTransferProfile().tree);

    if (dryRunIssues > 0) {
      logRow('❌', `Dry run found ${dryRunIssues} issue(s) — fix these before running the real transfer.`, 'ds-prog-err');
      showToast(`Dry run found ${dryRunIssues} issue(s) — see details`, 'warning', 6000);
    } else {
      logRow('✅', 'Dry run passed — no issues found. Safe to run the real transfer.');
      showToast('Dry run passed ✓ — no field issues found', 'success', 4000);
    }
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

  const modeLabel = _transferWriteMode === 'upsert' ? `upsert on ${_transferUpsertField}` : 'insert';
  logRow('📤', `Starting transfer of profile "${_transferProfile.name}" (${modeLabel})…`);

  const result = await sendBg({
    type:             'SF_EXECUTE_PROFILE_TRANSFER',
    profile:          buildTransferProfile(),   // patched clone — incl. upsert config if set
    srcOrgUrl:        _transferSrc.orgUrl,
    srcSid:           _transferSrc.sid,
    tgtOrgUrl:        _transferTgt.orgUrl,
    tgtSid:           _transferTgt.sid
  });

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
    const icon = s.error ? '❌' : (s.failed > 0 ? '⚠' : '✅');
    const msg  = s.error
      ? (isExpired
          ? `${obj}: Session expired — the Salesforce session ended during the transfer`
          : `${obj}: ${s.error}`)
      : `${obj}: ${s.created} created${s.failed > 0 ? `, ${s.failed} failed` : ''}`;
    logRow(icon, msg, s.error || s.failed ? 'ds-prog-err' : '');
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
      window.refreshProfileState?.(_transferProfile.id);
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
// RECONCILE (Phase 3A) — one screen to review + fix sync state
// ════════════════════════════════════════════════════════════════
// Three columns from profile.lastScan:
//   missing in target → push (insert)
//   drift             → push source values (overwrite) or skip
//   only in target    → delete from target
// Root object only in v1. Bulk actions execute in one Run with a
// confirmation modal before any destructive delete.

window.openReconcile = function(profileId) {
  _reconcileProfile = _profiles.find(p => p.id === profileId) || null;
  document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-view="profiles"]')?.classList.add('active');
  _currentView = 'reconcile';
  renderReconcile();
};

// Module-scope selection sets so re-renders (after an action) preserve picks
// where it makes sense. Reset when the profile changes.
// Reconcile selection state. Buckets:
//   push      — sourceIds, insert into target ("in source only")
//   overwrite — sourceIds, update TARGET with source values ("drift" →)
//   updSrc    — sourceIds, update SOURCE with target values ("drift" ←, 3B v2)
//   pull      — targetIds, insert into source ("in target only", Phase 3B)
//   del       — targetIds, delete from target ("in target only")
// Mutually exclusive pairs (picking one auto-clears the other):
//   overwrite/updSrc per drift row, pull/del per target-only row.
let _recSel = { push: new Set(), overwrite: new Set(), updSrc: new Set(), del: new Set(), pull: new Set() };
let _recLastProfileId = null;
// Delete mode for the reconcile "In target only" column.
//   'recycle' — DELETE → Recycle Bin (recoverable 15 days)
//   'hard'    — DELETE then SOAP emptyRecycleBin (permanent)
let _recDeleteMode = 'recycle';

async function renderReconcile() {
  const p = _reconcileProfile;
  if (!p) { renderProfiles(); return; }

  // Reset selection when switching to a different profile.
  if (_recLastProfileId !== p.id) {
    _recSel = { push: new Set(), overwrite: new Set(), updSrc: new Set(), del: new Set(), pull: new Set() };
    _recLastProfileId = p.id;
  }

  const objType = p.tree?.objectType || p.tree?.childSObject || '?';
  const scan    = p.lastScan;
  const scanFresh = !!(
    scan && scan.status === 'success' &&
    (!scan.sourceOrg || scan.sourceOrg === p.sourceOrg) &&
    (!scan.targetOrg || scan.targetOrg === p.targetOrg)
  );

  // Header with back link + refresh.
  const headerHtml = `
    <div class="ds-view-header">
      <div class="ds-view-title-wrap">
        <button class="ds-back-link" id="dsRecBackBtn" title="Back to Data Deployment">‹ Back to deployments</button>
        <h2 class="ds-view-title">⚖ Reconcile — <span style="color:var(--brand)">${esc(objType)}</span></h2>
        <div class="ds-view-subtitle">${esc(orgLabel(p.sourceOrg || ''))} → ${esc(orgLabel(p.targetOrg || ''))}${scanFresh ? ` · scanned ${esc(timeAgo(scan.runAt))}` : ''}</div>
      </div>
      <button class="ds-btn ds-btn-sm" id="dsRecRefreshBtn">🔄 Refresh state</button>
    </div>`;

  if (!p.sourceOrg || !p.targetOrg) {
    setMain(`${headerHtml}
      <div class="ds-empty-page">
        <div class="ds-empty-icon">⚖</div>
        <div class="ds-empty-title">Set source and target orgs first</div>
        <div class="ds-empty-sub">Reconcile needs both orgs configured. Open the profile in <strong>✏ Edit</strong> to set them.</div>
      </div>`);
    eid('dsRecBackBtn')?.addEventListener('click', renderProfiles);
    return;
  }

  if (!scanFresh) {
    setMain(`${headerHtml}
      <div class="ds-empty-page">
        <div class="ds-empty-icon">🔄</div>
        <div class="ds-empty-title">${scan ? 'State is stale (orgs changed since last scan)' : 'No state captured yet'}</div>
        <div class="ds-empty-sub">Click <strong>🔄 Refresh state</strong> to compare the two orgs, then reconcile.</div>
        <div class="ds-empty-actions"><button class="ds-btn ds-btn-primary" id="dsRecRefreshBtn2">🔄 Refresh state</button></div>
      </div>`);
    eid('dsRecBackBtn')?.addEventListener('click', renderProfiles);
    const doRefresh = async () => { await window.refreshProfileState(p.id); const _fp = _profiles.find(x => x.id === p.id); if (_fp) _reconcileProfile = _fp; renderReconcile(); };
    eid('dsRecRefreshBtn')?.addEventListener('click', doRefresh);
    eid('dsRecRefreshBtn2')?.addEventListener('click', doRefresh);
    return;
  }

  const missing = scan.missingInTarget || [];   // {matchKey, sourceId}
  const drift   = scan.changed || [];           // {matchKey, sourceId, targetId}
  const extras  = scan.onlyInTarget || [];      // {matchKey, targetId}
  const inSync  = scan.identical || [];

  // Default-select all missing + all drift for push (the common intent:
  // bring target up to match source). Extras default UNCHECKED — deletion
  // is destructive, opt-in only. Only seed defaults on first load.
  if (!_recSel.push.size && !_recSel.overwrite.size && !_recSel.updSrc.size && !_recSel.del.size && !_recSel.pull.size) {
    missing.forEach(r => r.sourceId && _recSel.push.add(r.sourceId));
    drift.forEach(r => r.sourceId && _recSel.overwrite.add(r.sourceId));
    // updSrc + Pull + Delete left empty — writing into SOURCE (or deleting)
    // is opt-in only; the default direction matches "bring target up to source".
  }

  // dml = the plain Salesforce operation this column performs (Insert/Update/
  // Delete). subtitle = the diff state that put records here. Leading with the
  // DML verb so it's obvious what ▶ Run reconcile will actually do.
  function colHtml(dml, subtitle, badgeClass, icon, items, kind) {
    const rows = items.length ? items.map(r => {
      const id = kind === 'del' ? r.targetId : r.sourceId;
      const sel = _recSel[kind].has(id);
      return `<label class="ds-rec-col-row">
        <input type="checkbox" data-rec-kind="${kind}" data-rec-id="${esc(id)}" ${sel ? 'checked' : ''}>
        <span class="ds-rec-col-key">${esc(r.matchKey)}</span>
        ${kind === 'overwrite' ? `<span class="ds-rec-drift-link" data-rec-drift="${esc(r.sourceId)}|${esc(r.targetId)}" title="See which fields differ">▸ fields</span>` : ''}
      </label>
      ${kind === 'overwrite' ? `<div class="ds-rec-drift-expand" data-drift-expand="${esc(r.sourceId)}" style="display:none"></div>` : ''}`;
    }).join('') : `<div class="ds-rec-col-empty">none</div>`;
    return `
      <div class="ds-rec-col">
        <div class="ds-rec-col-hdr ${badgeClass}">
          ${icon} <strong>${dml} ${items.length}</strong>
          <span class="ds-rec-col-sub">${subtitle}</span>
        </div>
        <div class="ds-rec-col-actions">
          <button class="ds-btn ds-btn-xs" data-rec-all="${kind}">✓ All</button>
          <button class="ds-btn ds-btn-xs" data-rec-none="${kind}">✗ None</button>
        </div>
        <div class="ds-rec-col-list">${rows}</div>
      </div>`;
  }

  // Drift column gets a per-row DIRECTION picker (Phase 3B v2): → Update
  // target with source values, or ← Update source with target values
  // (mutually exclusive; click the active one to skip the row). The "▸
  // fields" expander stays so the user can see the differing values before
  // picking a winner.
  function driftColHtml(items) {
    const empty = !items.length;
    const rows = empty ? `<div class="ds-rec-col-empty">none</div>` : items.map(r => {
      const sid = r.sourceId;
      const isPush = _recSel.overwrite.has(sid);
      const isPull = _recSel.updSrc.has(sid);
      return `<div class="ds-rec-col-row ds-rec-row-drift">
        <span class="ds-rec-extra-actions">
          <button class="ds-rec-extra-btn ${isPush ? 'ds-rec-extra-on-push' : ''}"
                  data-rec-driftdir="overwrite" data-rec-id="${esc(sid)}"
                  title="Update the TARGET record with the source's values">→</button>
          <button class="ds-rec-extra-btn ${isPull ? 'ds-rec-extra-on-pull' : ''}"
                  data-rec-driftdir="updSrc" data-rec-id="${esc(sid)}"
                  title="Update the SOURCE record with the target's values">←</button>
        </span>
        <span class="ds-rec-col-key">${esc(r.matchKey)}</span>
        <span class="ds-rec-drift-link" data-rec-drift="${esc(r.sourceId)}|${esc(r.targetId)}" title="See which fields differ">▸ fields</span>
      </div>
      <div class="ds-rec-drift-expand" data-drift-expand="${esc(r.sourceId)}" style="display:none"></div>`;
    }).join('');
    const pushCount = items.filter(r => _recSel.overwrite.has(r.sourceId)).length;
    const pullCount = items.filter(r => _recSel.updSrc.has(r.sourceId)).length;
    return `
      <div class="ds-rec-col">
        <div class="ds-rec-col-hdr ds-diff-drift">
          🟡 <strong>Drifted ${items.length}</strong>
          <span class="ds-rec-col-sub">values differ — pick a winner per row</span>
        </div>
        <div class="ds-rec-col-actions ds-rec-col-actions-extra">
          <button class="ds-btn ds-btn-xs" data-rec-driftdir-all="overwrite" title="Source wins everywhere — update all target records">→ all</button>
          <button class="ds-btn ds-btn-xs" data-rec-driftdir-all="updSrc" title="Target wins everywhere — update all source records">← all</button>
          <button class="ds-btn ds-btn-xs" data-rec-driftdir-clear="1">✗ None</button>
        </div>
        ${empty ? '' : `<div class="ds-rec-extra-subcounts ds-rec-drift-subcounts">
          <span class="ds-rec-drift-sub-push">→ ${pushCount} to target</span>
          <span class="ds-rec-extra-sub-pull">← ${pullCount} to source</span>
          <span class="ds-rec-extra-sub-skip">${items.length - pushCount - pullCount} skipped</span>
        </div>`}
        <div class="ds-rec-col-list">${rows}</div>
      </div>`;
  }

  // "In target only" column gets per-row action picker: Skip / ← Pull /
  // 🗑 Delete (mutually exclusive). Phase 3B — bidirectional reconcile.
  // The whole column header doesn't say "Delete" anymore because rows can
  // go either way, so we split the count by what's currently selected.
  function extrasColHtml(items) {
    const empty = !items.length;
    const rows = empty ? `<div class="ds-rec-col-empty">none</div>` : items.map(r => {
      const tgtId = r.targetId;
      const isPull = _recSel.pull.has(tgtId);
      const isDel  = _recSel.del.has(tgtId);
      return `<div class="ds-rec-col-row ds-rec-row-extra">
        <span class="ds-rec-extra-actions">
          <button class="ds-rec-extra-btn ${isPull ? 'ds-rec-extra-on-pull' : ''}"
                  data-rec-extra="pull" data-rec-id="${esc(tgtId)}"
                  title="Pull this record into the source org">← Pull</button>
          <button class="ds-rec-extra-btn ${isDel ? 'ds-rec-extra-on-del' : ''}"
                  data-rec-extra="del" data-rec-id="${esc(tgtId)}"
                  title="Delete this record from the target org">🗑 Delete</button>
        </span>
        <span class="ds-rec-col-key">${esc(r.matchKey)}</span>
      </div>`;
    }).join('');
    const pullCount = items.filter(r => _recSel.pull.has(r.targetId)).length;
    const delCount  = items.filter(r => _recSel.del.has(r.targetId)).length;
    return `
      <div class="ds-rec-col">
        <div class="ds-rec-col-hdr ds-diff-extra">
          🔵 <strong>In target only ${items.length}</strong>
          <span class="ds-rec-col-sub">pick an action per row</span>
        </div>
        <div class="ds-rec-col-actions ds-rec-col-actions-extra">
          <button class="ds-btn ds-btn-xs" data-rec-extra-all="pull" title="Pull all">← Pull all</button>
          <button class="ds-btn ds-btn-xs" data-rec-extra-all="del"  title="Delete all">🗑 Delete all</button>
          <button class="ds-btn ds-btn-xs" data-rec-extra-clear="1">✗ None</button>
        </div>
        ${empty ? '' : `<div class="ds-rec-extra-subcounts">
          <span class="ds-rec-extra-sub-pull">← ${pullCount} to pull</span>
          <span class="ds-rec-extra-sub-del">🗑 ${delCount} to delete</span>
          <span class="ds-rec-extra-sub-skip">${items.length - pullCount - delCount} skipped</span>
        </div>`}
        <div class="ds-rec-col-list">${rows}</div>
      </div>`;
  }

  setMain(`${headerHtml}
    <div class="ds-op-banner ds-op-banner-write">
      <span class="ds-op-banner-icon">⚖</span>
      <div class="ds-op-banner-body">
        <div class="ds-op-banner-title">Reconcile is bidirectional</div>
        <div class="ds-op-banner-desc">→ actions write to <strong>${esc(orgLabel(p.targetOrg))}</strong> (target); ← actions write to <strong>${esc(orgLabel(p.sourceOrg))}</strong> (source). On drifted records, pick a winner per row: <strong>→</strong> source values overwrite target, <strong>←</strong> target values overwrite source. Delete permanently removes records from target. Review your selections before running.</div>
      </div>
    </div>

    <div class="ds-rec-cols">
      ${colHtml('Insert', 'in source only', 'ds-diff-missing', '🔴', missing, 'push')}
      ${driftColHtml(drift)}
      ${extrasColHtml(extras)}
    </div>

    <div class="ds-rec-insync-note">🟢 ${inSync.length} record(s) already in sync — no action needed.</div>

    <div class="ds-rec-action-bar">
      <div class="ds-rec-action-summary" id="dsRecSummary"></div>
      <label class="ds-rec-delmode" title="Recycle Bin: deleted records recoverable for 15 days. Hard delete: permanently purged, not recoverable.">
        <span>Delete mode:</span>
        <select id="dsRecDeleteMode" class="ds-select ds-select-sm">
          <option value="recycle" ${_recDeleteMode === 'recycle' ? 'selected' : ''}>🗑 Recycle Bin (recoverable)</option>
          <option value="hard" ${_recDeleteMode === 'hard' ? 'selected' : ''}>🔥 Hard delete (permanent)</option>
        </select>
      </label>
      <div class="ds-rec-action-btns">
        <button class="ds-btn" id="dsRecCancelBtn">Cancel</button>
        <button class="ds-btn ds-btn-primary ds-btn-lg" id="dsRecRunBtn">▶ Run reconcile</button>
      </div>
    </div>

    <div id="dsRecProgress"></div>
  `);

  function updateSummary() {
    const el = eid('dsRecSummary');
    if (!el) return;
    const parts = [];
    if (_recSel.push.size)      parts.push(`<span class="ds-diff-chip ds-diff-missing">Insert ${_recSel.push.size}</span>`);
    if (_recSel.overwrite.size) parts.push(`<span class="ds-diff-chip ds-diff-drift">→ Update target ${_recSel.overwrite.size}</span>`);
    if (_recSel.updSrc.size)    parts.push(`<span class="ds-diff-chip ds-diff-pull">← Update source ${_recSel.updSrc.size}</span>`);
    if (_recSel.pull.size)      parts.push(`<span class="ds-diff-chip ds-diff-pull">← Pull ${_recSel.pull.size}</span>`);
    if (_recSel.del.size)       parts.push(`<span class="ds-diff-chip ds-diff-extra">Delete ${_recSel.del.size}</span>`);
    el.innerHTML = parts.length ? `Actions: ${parts.join(' ')}` : '<span style="color:var(--subtext)">Nothing selected</span>';
    const runBtn = eid('dsRecRunBtn');
    if (runBtn) runBtn.disabled = !parts.length;
    // Refresh the extras column subcounts as the user toggles per-row picks.
    const sub = document.querySelector('.ds-rec-extra-subcounts:not(.ds-rec-drift-subcounts)');
    if (sub) {
      const totalExtras = extras.length;
      const pullN = _recSel.pull.size;
      const delN  = _recSel.del.size;
      sub.innerHTML = `
        <span class="ds-rec-extra-sub-pull">← ${pullN} to pull</span>
        <span class="ds-rec-extra-sub-del">🗑 ${delN} to delete</span>
        <span class="ds-rec-extra-sub-skip">${totalExtras - pullN - delN} skipped</span>`;
    }
    // Drift column subcounts likewise.
    const dsub = document.querySelector('.ds-rec-drift-subcounts');
    if (dsub) {
      const pushN = _recSel.overwrite.size;
      const usN   = _recSel.updSrc.size;
      dsub.innerHTML = `
        <span class="ds-rec-drift-sub-push">→ ${pushN} to target</span>
        <span class="ds-rec-extra-sub-pull">← ${usN} to source</span>
        <span class="ds-rec-extra-sub-skip">${drift.length - pushN - usN} skipped</span>`;
    }
  }
  updateSummary();

  // Wire checkboxes for the source-driven columns (push, overwrite)
  document.querySelectorAll('[data-rec-kind]').forEach(cb => {
    cb.addEventListener('change', () => {
      const kind = cb.dataset.recKind, id = cb.dataset.recId;
      if (cb.checked) _recSel[kind].add(id); else _recSel[kind].delete(id);
      updateSummary();
    });
  });
  // All / None per column (push + overwrite only — extras has its own handlers)
  document.querySelectorAll('[data-rec-all]').forEach(btn => btn.addEventListener('click', () => {
    const kind = btn.dataset.recAll;
    document.querySelectorAll(`[data-rec-kind="${kind}"]`).forEach(cb => { cb.checked = true; _recSel[kind].add(cb.dataset.recId); });
    updateSummary();
  }));
  document.querySelectorAll('[data-rec-none]').forEach(btn => btn.addEventListener('click', () => {
    const kind = btn.dataset.recNone;
    document.querySelectorAll(`[data-rec-kind="${kind}"]`).forEach(cb => { cb.checked = false; _recSel[kind].delete(cb.dataset.recId); });
    updateSummary();
  }));

  // Phase 3B — extras column per-row Pull/Delete buttons (mutually exclusive).
  // Click an already-selected action to deselect it (= Skip).
  function paintExtraRow(rowEl, tgtId) {
    const pullBtn = rowEl.querySelector('[data-rec-extra="pull"]');
    const delBtn  = rowEl.querySelector('[data-rec-extra="del"]');
    if (pullBtn) pullBtn.classList.toggle('ds-rec-extra-on-pull', _recSel.pull.has(tgtId));
    if (delBtn)  delBtn.classList.toggle('ds-rec-extra-on-del',   _recSel.del.has(tgtId));
  }
  document.querySelectorAll('[data-rec-extra]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      const action = btn.dataset.recExtra;            // 'pull' or 'del'
      const tgtId  = btn.dataset.recId;
      const other  = action === 'pull' ? 'del' : 'pull';
      if (_recSel[action].has(tgtId)) {
        _recSel[action].delete(tgtId);                // toggle off → Skip
      } else {
        _recSel[action].add(tgtId);
        _recSel[other].delete(tgtId);                 // mutually exclusive
      }
      paintExtraRow(btn.closest('.ds-rec-row-extra'), tgtId);
      updateSummary();
    });
  });
  // Bulk: Pull all / Delete all / None for the extras column.
  document.querySelectorAll('[data-rec-extra-all]').forEach(btn => btn.addEventListener('click', () => {
    const action = btn.dataset.recExtraAll;           // 'pull' or 'del'
    const other  = action === 'pull' ? 'del' : 'pull';
    extras.forEach(r => {
      _recSel[action].add(r.targetId);
      _recSel[other].delete(r.targetId);
    });
    document.querySelectorAll('.ds-rec-row-extra').forEach(row => {
      const id = row.querySelector('[data-rec-id]')?.dataset.recId;
      if (id) paintExtraRow(row, id);
    });
    updateSummary();
  }));
  document.querySelector('[data-rec-extra-clear]')?.addEventListener('click', () => {
    extras.forEach(r => { _recSel.pull.delete(r.targetId); _recSel.del.delete(r.targetId); });
    document.querySelectorAll('.ds-rec-row-extra').forEach(row => {
      const id = row.querySelector('[data-rec-id]')?.dataset.recId;
      if (id) paintExtraRow(row, id);
    });
    updateSummary();
  });

  // Phase 3B v2 — drift column per-row direction buttons (→ target wins /
  // ← source wins, mutually exclusive; click the active one to skip).
  function paintDriftRow(rowEl, sid) {
    const pushBtn = rowEl.querySelector('[data-rec-driftdir="overwrite"]');
    const pullBtn = rowEl.querySelector('[data-rec-driftdir="updSrc"]');
    if (pushBtn) pushBtn.classList.toggle('ds-rec-extra-on-push', _recSel.overwrite.has(sid));
    if (pullBtn) pullBtn.classList.toggle('ds-rec-extra-on-pull', _recSel.updSrc.has(sid));
  }
  document.querySelectorAll('[data-rec-driftdir]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      const action = btn.dataset.recDriftdir;          // 'overwrite' | 'updSrc'
      const sid    = btn.dataset.recId;
      const other  = action === 'overwrite' ? 'updSrc' : 'overwrite';
      if (_recSel[action].has(sid)) {
        _recSel[action].delete(sid);                   // toggle off → Skip
      } else {
        _recSel[action].add(sid);
        _recSel[other].delete(sid);                    // mutually exclusive
      }
      paintDriftRow(btn.closest('.ds-rec-row-drift'), sid);
      updateSummary();
    });
  });
  document.querySelectorAll('[data-rec-driftdir-all]').forEach(btn => btn.addEventListener('click', () => {
    const action = btn.dataset.recDriftdirAll;
    const other  = action === 'overwrite' ? 'updSrc' : 'overwrite';
    drift.forEach(r => {
      _recSel[action].add(r.sourceId);
      _recSel[other].delete(r.sourceId);
    });
    document.querySelectorAll('.ds-rec-row-drift').forEach(row => {
      const id = row.querySelector('[data-rec-id]')?.dataset.recId;
      if (id) paintDriftRow(row, id);
    });
    updateSummary();
  }));
  document.querySelector('[data-rec-driftdir-clear]')?.addEventListener('click', () => {
    drift.forEach(r => { _recSel.overwrite.delete(r.sourceId); _recSel.updSrc.delete(r.sourceId); });
    document.querySelectorAll('.ds-rec-row-drift').forEach(row => {
      const id = row.querySelector('[data-rec-id]')?.dataset.recId;
      if (id) paintDriftRow(row, id);
    });
    updateSummary();
  });
  // Drift "fields" expander — reuse fetchDriftRowDetail + renderDriftCompareTable
  document.querySelectorAll('[data-rec-drift]').forEach(link => {
    link.addEventListener('click', async (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const [srcId, tgtId] = (link.dataset.recDrift || '').split('|');
      const expand = document.querySelector(`.ds-rec-drift-expand[data-drift-expand="${srcId}"]`);
      if (!expand) return;
      if (expand.dataset.loaded === '1') {
        expand.style.display = expand.style.display === 'none' ? 'block' : 'none';
        return;
      }
      expand.style.display = 'block';
      expand.innerHTML = `<div class="ds-drift-compare-loading">Loading…</div>`;
      const srcFields = scan.compareFields || [];
      const tgtFields = scan.compareFieldsTgt || scan.compareFields || [];
      const res = await fetchDriftRowDetail(p, objType, srcId, tgtId, srcFields, tgtFields);
      if (res.error) {
        // Fall back to the scan-time answer when the live fetch can't run.
        const row = drift.find(r => r.sourceId === srcId);
        const fieldsNote = (row?.fields || []).length
          ? `<div class="ds-drift-compare-fallback">At the last scan these field(s) differed:
               <strong>${esc(row.fields.join(', '))}</strong></div>`
          : '';
        expand.innerHTML = `${fieldsNote}<div class="ds-drift-compare-err">⚠ ${esc(res.error)}</div>`;
      } else {
        expand.innerHTML = renderDriftCompareTable(res.srcRec, res.tgtRec, srcFields, tgtFields);
      }
      expand.dataset.loaded = '1';
    });
  });

  eid('dsRecBackBtn')?.addEventListener('click', renderProfiles);
  eid('dsRecCancelBtn')?.addEventListener('click', renderProfiles);
  eid('dsRecRefreshBtn')?.addEventListener('click', async () => {
    await window.refreshProfileState(p.id);
    { const _fp = _profiles.find(x => x.id === p.id); if (_fp) _reconcileProfile = _fp; }
    _recSel = { push: new Set(), overwrite: new Set(), updSrc: new Set(), del: new Set(), pull: new Set() };
    renderReconcile();
  });
  eid('dsRecDeleteMode')?.addEventListener('change', e => { _recDeleteMode = e.target.value; });
  eid('dsRecRunBtn')?.addEventListener('click', () => runReconcile(p, objType, { missing, drift, extras }));
}

// Execute the selected reconcile actions. Deletes require a confirmation
// modal (destructive). Push reuses the transfer engine (root-only profile
// clone). Overwrite uses SF_COLLECTIONS_UPDATE.
async function runReconcile(profile, objType, buckets) {
  const pushIds   = [..._recSel.push];
  const ovwIds    = [..._recSel.overwrite];
  const updSrcIds = [..._recSel.updSrc];
  const delIds    = [..._recSel.del];
  const pullIds   = [..._recSel.pull];
  if (!pushIds.length && !ovwIds.length && !updSrcIds.length && !delIds.length && !pullIds.length) return;

  // ── Confirmation step ────────────────────────────────────────────────
  // If anything destructive (delete) or anything that writes to the SOURCE
  // org (pull insert / ← update) is selected, surface a single combined
  // confirm modal so the user sees the full impact before any writes happen.
  const isHard = _recDeleteMode === 'hard';
  if (delIds.length || pullIds.length || updSrcIds.length) {
    const ok = await new Promise(resolve => {
      const delBlock = delIds.length ? (isHard
        ? `<div style="margin-top:10px;padding:10px 12px;background:#fef2f2;border-left:3px solid #dc2626;border-radius:4px;font-size:12px;color:#991b1b">
             🔥 <strong>Hard-delete ${delIds.length} ${esc(objType)} record(s)</strong> from
             <strong>${esc(orgLabel(profile.targetOrg))}</strong> — purged from the Recycle Bin and
             <strong>cannot be recovered</strong>.</div>`
        : `<div style="margin-top:10px;padding:10px 12px;background:#fffbeb;border-left:3px solid #f59e0b;border-radius:4px;font-size:12px;color:#92400e">
             🗑 <strong>Delete ${delIds.length} ${esc(objType)} record(s)</strong> from
             <strong>${esc(orgLabel(profile.targetOrg))}</strong> — recoverable from the Recycle Bin for 15 days.</div>`) : '';
      const pullBlock = pullIds.length
        ? `<div style="margin-top:10px;padding:10px 12px;background:#eff6ff;border-left:3px solid #2563eb;border-radius:4px;font-size:12px;color:#1e3a8a">
             ← <strong>Pull ${pullIds.length} ${esc(objType)} record(s)</strong> into
             <strong>${esc(orgLabel(profile.sourceOrg))}</strong> (source). New rows will be inserted there.</div>`
        : '';
      const updSrcBlock = updSrcIds.length
        ? `<div style="margin-top:10px;padding:10px 12px;background:#eff6ff;border-left:3px solid #2563eb;border-radius:4px;font-size:12px;color:#1e3a8a">
             ← <strong>Update ${updSrcIds.length} ${esc(objType)} record(s)</strong> in
             <strong>${esc(orgLabel(profile.sourceOrg))}</strong> (source) with the target's values — the target wins those rows.</div>`
        : '';
      const title = delIds.length
        ? (isHard ? '🔥 Confirm HARD delete' : '⚠ Confirm reconcile actions')
        : '← Confirm writes into source';
      showModal(`
        <div class="ds-modal-header">${title}</div>
        <div class="ds-modal-body">
          Review the changes before continuing:
          ${pullBlock}
          ${updSrcBlock}
          ${delBlock}
        </div>
        <div class="ds-modal-footer">
          <button class="ds-btn" id="dsRecDelCancel">Cancel</button>
          <button class="ds-btn ${delIds.length ? 'ds-btn-danger' : 'ds-btn-primary'}" id="dsRecDelOk">Proceed</button>
        </div>`);
      eid('dsRecDelCancel')?.addEventListener('click', () => { closeModal(); resolve(false); });
      eid('dsRecDelOk')?.addEventListener('click', () => { closeModal(); resolve(true); });
    });
    if (!ok) return;
  }

  const prog = eid('dsRecProgress');
  const log = (icon, msg, cls = '') => {
    if (!prog) return;
    const row = document.createElement('div');
    row.className = `ds-prog-row ${cls}`;
    row.textContent = `${icon} ${msg}`;
    prog.appendChild(row);
  };
  if (prog) prog.innerHTML = '<div class="ds-prog-hdr">Reconcile progress</div>';
  const runBtn = eid('dsRecRunBtn'); if (runBtn) runBtn.disabled = true;

  const allSess = _buildAllSessions();
  const srcSess = _resolveSession(profile.sourceOrg, allSess);
  const tgtSess = _resolveSession(profile.targetOrg, allSess);
  if (!srcSess?.sid || !tgtSess?.sid) {
    log('❌', 'Source or target org session not active — open both in Chrome tabs.', 'ds-prog-err');
    if (runBtn) runBtn.disabled = false;
    return;
  }

  // Per-action counters — captured into a History entry at the end so the
  // History view can show what was actually inserted/updated/deleted, not
  // just "errors". Hard-delete tracks the bin-purge count separately.
  const startedAt = new Date().toISOString();
  const counts = { inserted: 0, updated: 0, deleted: 0, purged: 0, pulled: 0, updatedSource: 0,
                   insertedFailed: 0, updatedFailed: 0, deletedFailed: 0, pulledFailed: 0, updatedSourceFailed: 0 };
  const allErrors = [];

  // ── 1. Delete extras (regular → Recycle Bin, or hard → purge) ────────
  if (delIds.length) {
    if (isHard) {
      log('🔥', `Hard-deleting ${delIds.length} record(s) from target…`);
      try {
        const res = await sendBg({ type: 'SF_HARD_DELETE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, ids: delIds });
        const delOk   = (res.deleteResults || []).filter(r => r.success).length;
        const delFail = (res.deleteResults || []).length - delOk;
        counts.deleted += delOk; counts.deletedFailed += delFail; counts.purged += (res.purgedOk || 0);
        log(delFail ? '⚠' : '✅', `Deleted ${delOk}${delFail ? `, ${delFail} failed` : ''} → purged ${res.purgedOk || 0} from Recycle Bin`, delFail ? 'ds-prog-err' : '');
        (res.purgeErrors || []).slice(0, 3).forEach(e => { allErrors.push(`purge: ${e}`); log('  ⚠', `purge: ${e}`, 'ds-prog-warn'); });
        (res.deleteResults || []).filter(r => !r.success).slice(0, 5).forEach(r => {
          const m = (r.errors || []).map(x => x.message).join('; ');
          if (m) allErrors.push(`delete ${r.id || ''}: ${m}`);
        });
      } catch (e) { allErrors.push(`Hard delete failed: ${e?.message || e}`); log('❌', `Hard delete failed: ${e?.message || e}`, 'ds-prog-err'); }
    } else {
      log('🗑', `Deleting ${delIds.length} record(s) from target (→ Recycle Bin)…`);
      try {
        const res = await sendBg({ type: 'SF_COLLECTIONS_DELETE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, ids: delIds });
        const ok = (res || []).filter(r => r.success).length;
        const fail = (res || []).length - ok;
        counts.deleted += ok; counts.deletedFailed += fail;
        log(fail ? '⚠' : '✅', `Deleted ${ok}${fail ? `, ${fail} failed` : ''}`, fail ? 'ds-prog-err' : '');
        (res || []).filter(r => !r.success).slice(0, 5).forEach(r => {
          const m = (r.errors || []).map(x => x.message).join('; ');
          if (m) allErrors.push(`delete ${r.id || ''}: ${m}`);
        });
      } catch (e) { allErrors.push(`Delete failed: ${e?.message || e}`); log('❌', `Delete failed: ${e?.message || e}`, 'ds-prog-err'); }
    }
  }

  // ── 2. Pull target-only rows into source (Phase 3B) ──────────────────
  // Same transfer engine, but src/tgt swapped. Field mappings are inverted
  // so { srcFld → tgtFld } applied during push becomes { tgtFld → srcFld }
  // during pull. Only the root object — children stay in their own org.
  if (pullIds.length) {
    log('←', `Pulling ${pullIds.length} record(s) from target into source…`);
    try {
      const pullProfile = JSON.parse(JSON.stringify(profile));
      const fm = pullProfile.tree?.fieldMappings || {};
      const inverseFm = {};
      for (const [s, t] of Object.entries(fm)) { if (t) inverseFm[t] = s; }
      pullProfile.tree.fieldMappings = inverseFm;
      pullProfile.tree.recordIds = pullIds;
      pullProfile.tree.children  = [];
      // Swap the profile's orgs so anything downstream that inspects them
      // (logging, lookup-bridge resolution, error messages) sees the
      // reverse direction consistently.
      pullProfile.sourceOrg = profile.targetOrg;
      pullProfile.targetOrg = profile.sourceOrg;
      const res = await sendBg({
        type: 'SF_EXECUTE_PROFILE_TRANSFER',
        profile: pullProfile,
        srcOrgUrl: tgtSess.orgUrl, srcSid: tgtSess.sid,   // read from TARGET
        tgtOrgUrl: srcSess.orgUrl, tgtSid: srcSess.sid    // write to SOURCE
      });
      const s = res.summary?.[objType] || {};
      counts.pulled       += (s.created || 0);
      counts.pulledFailed += (s.failed  || 0);
      log(s.failed ? '⚠' : '✅', `Pulled ${s.created || 0}${s.failed ? `, ${s.failed} failed` : ''} into source`, s.failed ? 'ds-prog-err' : '');
      (res.errors || []).forEach(e => allErrors.push(`pull: ${e}`));
      (res.errors || []).slice(0, 5).forEach(e => log('  ❌', e, 'ds-prog-err'));
    } catch (e) { allErrors.push(`Pull failed: ${e?.message || e}`); log('❌', `Pull failed: ${e?.message || e}`, 'ds-prog-err'); }
  }

  // ── 3. Push missing (insert) — reuse the transfer engine, root only ──
  if (pushIds.length) {
    log('⬆', `Pushing ${pushIds.length} missing record(s) to target…`);
    try {
      const pushProfile = JSON.parse(JSON.stringify(profile));
      pushProfile.tree.recordIds = pushIds;
      pushProfile.tree.children  = [];   // root only in v1
      const res = await sendBg({
        type: 'SF_EXECUTE_PROFILE_TRANSFER',
        profile: pushProfile,
        srcOrgUrl: srcSess.orgUrl, srcSid: srcSess.sid,
        tgtOrgUrl: tgtSess.orgUrl, tgtSid: tgtSess.sid
      });
      const s = res.summary?.[objType] || {};
      counts.inserted += (s.created || 0); counts.insertedFailed += (s.failed || 0);
      log(s.failed ? '⚠' : '✅', `Inserted ${s.created || 0}${s.failed ? `, ${s.failed} failed` : ''}`, s.failed ? 'ds-prog-err' : '');
      (res.errors || []).forEach(e => allErrors.push(`insert: ${e}`));
      (res.errors || []).slice(0, 5).forEach(e => log('  ❌', e, 'ds-prog-err'));
    } catch (e) { allErrors.push(`Push failed: ${e?.message || e}`); log('❌', `Push failed: ${e?.message || e}`, 'ds-prog-err'); }
  }

  // ── 4. Overwrite drift (update target with source values) ────────────
  if (ovwIds.length) {
    log('✏', `Updating ${ovwIds.length} drifted record(s) in target…`);
    try {
      const result = await reconcileOverwrite(profile, objType, ovwIds, buckets.drift, srcSess, tgtSess);
      counts.updated += (result.ok || 0); counts.updatedFailed += (result.failed || 0);
      log(result.failed ? '⚠' : '✅', `Updated ${result.ok}${result.failed ? `, ${result.failed} failed` : ''}`, result.failed ? 'ds-prog-err' : '');
      (result.errors || []).forEach(e => allErrors.push(`update: ${e}`));
      (result.errors || []).slice(0, 5).forEach(e => log('  ❌', e, 'ds-prog-err'));
    } catch (e) { allErrors.push(`Overwrite failed: ${e?.message || e}`); log('❌', `Overwrite failed: ${e?.message || e}`, 'ds-prog-err'); }
  }

  // ── 4b. Reverse drift (update SOURCE with target values, 3B v2) ───────
  // Same engine as step 4 with everything mirrored: profile clone gets
  // inverted fieldMappings + swapped orgs, the drift bucket swaps
  // sourceId/targetId per row, and the sessions swap roles — so
  // reconcileOverwrite "reads from source, patches target" becomes
  // "reads from target, patches source" without touching its internals.
  if (updSrcIds.length) {
    log('←', `Updating ${updSrcIds.length} drifted record(s) in source with target values…`);
    try {
      const invProfile = JSON.parse(JSON.stringify(profile));
      const fm = invProfile.tree?.fieldMappings || {};
      const invFm = {};
      for (const [s, t] of Object.entries(fm)) { if (t) invFm[t] = s; }
      invProfile.tree.fieldMappings = invFm;
      invProfile.sourceOrg = profile.targetOrg;
      invProfile.targetOrg = profile.sourceOrg;
      const sel = new Set(updSrcIds);
      const swappedBucket = (buckets.drift || [])
        .filter(r => sel.has(r.sourceId))
        .map(r => ({ matchKey: r.matchKey, sourceId: r.targetId, targetId: r.sourceId }));
      const readIds = swappedBucket.map(r => r.sourceId);   // = original targetIds
      const result = await reconcileOverwrite(invProfile, objType, readIds, swappedBucket, tgtSess, srcSess);
      counts.updatedSource += (result.ok || 0); counts.updatedSourceFailed += (result.failed || 0);
      log(result.failed ? '⚠' : '✅', `Updated ${result.ok} in source${result.failed ? `, ${result.failed} failed` : ''}`, result.failed ? 'ds-prog-err' : '');
      (result.errors || []).forEach(e => allErrors.push(`update-source: ${e}`));
      (result.errors || []).slice(0, 5).forEach(e => log('  ❌', e, 'ds-prog-err'));
    } catch (e) { allErrors.push(`Source update failed: ${e?.message || e}`); log('❌', `Source update failed: ${e?.message || e}`, 'ds-prog-err'); }
  }

  // ── 5. Save to History so the run is visible later ───────────────────
  const totalOk   = counts.inserted + counts.updated + counts.deleted + counts.pulled + counts.updatedSource;
  const totalFail = counts.insertedFailed + counts.updatedFailed + counts.deletedFailed + counts.pulledFailed + counts.updatedSourceFailed;
  const status   = totalFail === 0 ? 'success' : (totalOk > 0 ? 'partial' : 'failed');
  _history.push({
    id:           genId('run'),
    kind:         'reconcile',
    profileId:    profile.id,
    profileName:  profile.name,
    sourceOrg:    profile.sourceOrg,
    targetOrg:    profile.targetOrg,
    srcOrgUrl:    profile.sourceOrg,
    tgtOrgUrl:    profile.targetOrg,
    startedAt,
    completedAt:  new Date().toISOString(),
    status,
    summary: {
      [objType]: {
        inserted: counts.inserted, insertedFailed: counts.insertedFailed,
        updated:  counts.updated,  updatedFailed:  counts.updatedFailed,
        deleted:  counts.deleted,  deletedFailed:  counts.deletedFailed,
        pulled:   counts.pulled,   pulledFailed:   counts.pulledFailed,
        updatedSource: counts.updatedSource, updatedSourceFailed: counts.updatedSourceFailed,
        purged:   counts.purged,
        deleteMode: _recDeleteMode
      }
    },
    errors: allErrors.slice(0, 50)
  });
  await storageSaveHistory();

  log('✅', `Reconcile complete — refreshing state…`);
  // Refresh diff + snapshots so the columns reflect the new reality.
  await window.refreshProfileState(profile.id);
  // Keep the ephemeral Org Compare profile (not in _profiles) — refreshProfileDiff
  // already updated its lastScan in place. Only re-point at a saved profile.
  { const _fp = _profiles.find(x => x.id === profile.id); if (_fp) _reconcileProfile = _fp; }
  _recSel = { push: new Set(), overwrite: new Set(), updSrc: new Set(), del: new Set(), pull: new Set() };
  const toastParts = [];
  if (counts.inserted)      toastParts.push(`${counts.inserted} inserted`);
  if (counts.updated)       toastParts.push(`${counts.updated} updated`);
  if (counts.updatedSource) toastParts.push(`← ${counts.updatedSource} updated in source`);
  if (counts.pulled)        toastParts.push(`${counts.pulled} pulled`);
  if (counts.deleted)       toastParts.push(`${counts.deleted} deleted`);
  const toastMsg = `Reconcile: ${toastParts.join(' · ') || 'no actions'}` +
    (totalFail ? ` · ${totalFail} failed` : '');
  showToast(toastMsg, totalFail ? 'warning' : 'success', 4500);
  renderReconcile();
}

// Overwrite drifted target records with source values. Fetches the source
// records' mapped fields, builds PATCH payloads keyed by the TARGET Id, and
// sends via SF_COLLECTIONS_UPDATE. Honors fieldMappings (src→tgt rename) and
// skips system/non-writable fields. Returns { ok, failed, errors }.
async function reconcileOverwrite(profile, objType, sourceIds, driftBucket, srcSess, tgtSess) {
  // Map sourceId → targetId from the drift bucket.
  const srcToTgt = new Map();
  for (const r of driftBucket) { if (r.sourceId && r.targetId) srcToTgt.set(r.sourceId, r.targetId); }

  const node = profile.tree;
  const fm   = node.fieldMappings || {};
  // Source fields to read = the mapped source field names (those that map to
  // a non-null target). Drop system fields.
  const SYS = new Set(['Id','CreatedDate','CreatedById','LastModifiedDate','LastModifiedById','SystemModstamp','IsDeleted']);
  let srcFields = Object.keys(fm).filter(k => fm[k] !== null && fm[k] !== '' && !SYS.has(k));

  // Drop LOOKUP fields (type 'reference') — their values are org-local
  // record Ids; PATCHing the source org's Id into the target would be
  // garbage (or an "invalid cross reference id" failure). RecordTypeId is
  // the one exception: it stays because it gets remapped by DeveloperName
  // below. Lookup re-pointing belongs to the transfer engine's resolution
  // strategies, not the reconcile overwrite.
  try {
    const d = await sendBg({
      type: 'SF_REST_GET', orgUrl: srcSess.orgUrl, sid: srcSess.sid,
      path: `services/data/v62.0/sobjects/${objType}/describe`
    });
    if (d && !d.error && Array.isArray(d.fields)) {
      const refs = new Set(d.fields.filter(f => f.type === 'reference' && f.name !== 'RecordTypeId').map(f => f.name));
      srcFields = srcFields.filter(k => !refs.has(k));
    }
  } catch (_) { /* best effort — proceed with the unfiltered list */ }

  if (!srcFields.length) {
    return { ok: 0, failed: sourceIds.length, errors: ['No mapped fields to overwrite — configure Field Mapping on the root node.'] };
  }

  // Fetch source records in chunks.
  const idList = sourceIds.filter(id => srcToTgt.has(id));
  const srcRecs = [];
  for (let i = 0; i < idList.length; i += 200) {
    const chunk = idList.slice(i, i + 200);
    const soql = `SELECT ${[...new Set(['Id', ...srcFields])].join(',')} FROM ${objType} WHERE Id IN (${chunk.map(id => `'${id}'`).join(',')})`;
    const res  = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: srcSess.orgUrl, sid: srcSess.sid, query: soql });
    if (res?.error) return { ok: 0, failed: idList.length, errors: [`Source read failed: ${res.error}`] };
    srcRecs.push(...(res.records || []));
  }

  // Match RecordTypes by DeveloperName when RecordTypeId is being written.
  // The raw source RecordTypeId is invalid in the target org, so we resolve
  // srcRtId → tgtRtId by API name; unmatched RTs are skipped (the target
  // record keeps its existing RT) rather than pushing a garbage Id.
  const ovwErrors = [];
  let rtRemap = null;   // { srcRtId: tgtRtId|null }
  if (srcFields.includes('RecordTypeId')) {
    const srcRtIds = [...new Set(srcRecs.map(r => r.RecordTypeId).filter(Boolean))];
    if (srcRtIds.length) {
      const [srcRtRes, tgtRtRes] = await Promise.all([
        sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: srcSess.orgUrl, sid: srcSess.sid,
                 query: `SELECT Id, DeveloperName FROM RecordType WHERE Id IN (${srcRtIds.map(id => `'${id}'`).join(',')})` }),
        sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
                 query: `SELECT Id, DeveloperName FROM RecordType WHERE SObjectType = '${objType}'` })
      ]);
      const tgtByName = {};
      for (const r of (tgtRtRes.records || [])) tgtByName[r.DeveloperName] = r.Id;
      rtRemap = {};
      const unmatched = [];
      for (const r of (srcRtRes.records || [])) {
        rtRemap[r.Id] = tgtByName[r.DeveloperName] || null;
        if (!rtRemap[r.Id]) unmatched.push(r.DeveloperName);
      }
      if (unmatched.length) ovwErrors.push(`record type(s) ${unmatched.join(', ')} not in target — left unchanged on those records`);
    }
  }

  // Build PATCH payloads keyed by target Id.
  const payloads = srcRecs.map(sr => {
    const tgtId = srcToTgt.get(sr.Id);
    const p = { attributes: { type: objType }, Id: tgtId };
    for (const sf of srcFields) {
      const tf = fm[sf];
      let v    = sr[sf];
      if (v == null) continue;
      // Remap RecordTypeId by DeveloperName; drop it if there's no target
      // match so we don't PATCH an invalid Id (which would fail the row).
      if (sf === 'RecordTypeId' && rtRemap) {
        const mapped = rtRemap[v];
        if (!mapped) continue;
        v = mapped;
      }
      p[tf] = v;
    }
    return p;
  }).filter(p => p.Id);

  const res = await sendBg({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, records: payloads });
  const arr = Array.isArray(res) ? res : [];
  const ok = arr.filter(r => r.success).length;
  const errors = [...ovwErrors];
  for (const r of arr) {
    if (!r.success) errors.push(`${objType}: ${(r.errors || []).map(e => e.message).join('; ')}`);
  }
  return { ok, failed: arr.length - ok, errors };
}

// ════════════════════════════════════════════════════════════════
// ORG COMPARE (org-wide data diff across many objects)
// ════════════════════════════════════════════════════════════════
// Pick a source + target org from open Chrome tabs, pick which objects to
// compare, then run a parallel diff across all of them. Result is a
// scorecard table sorted by worst drift first. Click a row → opens
// Reconcile scoped to that object via an ephemeral profile.

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
  const allSess = _buildAllSessions();
  if (!_orgCompareState.srcOrgUrl && _orgUrl) _orgCompareState.srcOrgUrl = _orgUrl;

  const orgOptions = allSess.map(s =>
    `<option value="${esc(s.orgUrl)}">${esc(orgOptionLabel(s.orgUrl, s.label))}</option>`
  ).join('');

  setMain(`
    <div class="ds-view-header">
      <div class="ds-view-title-wrap">
        <h2 class="ds-view-title">🔍 Org Compare</h2>
        <div class="ds-view-subtitle">Diff record counts across many objects between two orgs — find drift at a glance</div>
      </div>
    </div>

    <div style="background:#E8F4FD;border:1px solid #C5DBF0;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:12px;color:#014486;max-width:920px">
      <strong>Read-only.</strong> Org Compare queries record counts and which records exist in each org.
      Pick a match strategy below — <strong>External Id</strong> is the most reliable across orgs, <strong>Name</strong> is the loose default.
      Click any row in the result table to open <strong>Reconcile</strong> scoped to that object — that's where you can actually insert/update/delete.
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
      listEl.innerHTML = `<div class="ds-oc-empty">Failed to load objects: ${esc(e?.message || e)}</div>`;
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
}

// Compare ONE object: describe (to pick matchField), parallel SOQL on both
// orgs, index by matchField value, count buckets. Presence-only (no drift)
// since Org Compare has no per-object field config — drift is the
// Reconcile view's job, fed by a Profile.
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
  const denom = matched + missing;
  const pct = denom > 0 ? Math.round(matched / denom * 100) : (extras === 0 ? 100 : 0);
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

  el.innerHTML = `
    <table class="ds-oc-table">
      <thead><tr>
        <th>Object</th><th>Source</th><th>Target</th>
        <th>Matched</th><th>Missing in target</th><th>Only in target</th>
        <th>% match</th><th></th>
      </tr></thead>
      <tbody>${ordered.map(r => {
        if (r.status === 'pending') return `<tr><td>${esc(r.name)}</td><td colspan="7" class="ds-oc-pending">⏳ comparing…</td></tr>`;
        if (r.error)   return `<tr><td>${esc(r.name)}</td><td colspan="7" class="ds-oc-err">⚠ ${esc(r.error)}</td></tr>`;
        if (r.skipped) return `<tr class="ds-oc-skipped"><td>${esc(r.name)}</td><td colspan="7" class="ds-oc-skip">— ${esc(r.reason || 'Skipped.')}</td></tr>`;
        return `<tr class="ds-oc-row ${colorFor(r.matchPct)}">
          <td>${esc(r.name)} <span class="ds-oc-row-mf">by ${esc(r.matchField)}</span></td>
          <td>${r.srcCount.toLocaleString()}</td>
          <td>${r.tgtCount.toLocaleString()}</td>
          <td>${r.matched.toLocaleString()}</td>
          <td>${r.missing ? `<strong>${r.missing.toLocaleString()}</strong>` : '0'}</td>
          <td>${r.extras  ? `<strong>${r.extras.toLocaleString()}</strong>`  : '0'}</td>
          <td class="ds-oc-pct"><strong>${r.matchPct}%</strong></td>
          <td><button class="ds-btn ds-btn-xs ds-btn-primary" data-oc-reconcile="${esc(r.name)}">⚖ Reconcile</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;

  // Wire row reconcile buttons — build an ephemeral profile and open Reconcile.
  el.querySelectorAll('[data-oc-reconcile]').forEach(btn => {
    btn.addEventListener('click', () => _ocOpenReconcile(btn.dataset.ocReconcile));
  });
}

// Open Reconcile scoped to one object — build an ephemeral, unsaved profile
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
    showToast(`Diff scan failed: ${res.error}`, 'error', 5000);
    return;
  }
  ephemeral.lastScan = res;
  _reconcileProfile = ephemeral;
  _currentView = 'reconcile';
  document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-view="compare"]')?.classList.add('active');
  renderReconcile();
}

// ════════════════════════════════════════════════════════════════
// SCHEDULE
// ════════════════════════════════════════════════════════════════
function renderHistory() {
  if (!_history.length) {
    setMain(`
      <div class="ds-view-header"><h2 class="ds-view-title">📜 History</h2></div>
      <div class="ds-empty-page">
        <div class="ds-empty-icon">📜</div>
        <div class="ds-empty-title">No transfers yet</div>
        <div class="ds-empty-sub">Run a transfer and the results will appear here.</div>
      </div>`);
    return;
  }

  const sorted = [..._history].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));

  setMain(`
    <div class="ds-view-header">
      <h2 class="ds-view-title">📜 History</h2>
      <button class="ds-btn ds-btn-danger ds-btn-sm" id="dsClearHistory">🗑 Clear All</button>
    </div>
    <div class="ds-history-list">
      ${sorted.map(run => {
        // Aggregate failed source IDs across all objects in this run.
        // The retry button only appears when we actually have IDs to retry.
        const failedByObj = {};
        let totalFailed = 0;
        for (const [obj, s] of Object.entries(run.summary || {})) {
          const failedIds = (s.failedSourceIds || []).map(f => typeof f === 'string' ? f : f.id).filter(Boolean);
          if (failedIds.length) {
            failedByObj[obj] = failedIds;
            totalFailed += failedIds.length;
          }
        }
        const retryable = totalFailed > 0 && run.profileId && _profiles.some(p => p.id === run.profileId);
        return `
        <div class="ds-history-card">
          <div class="ds-history-card-header">
            <span class="ds-run-status-badge ds-run-status-${run.status}">
              ${run.status === 'success' ? '✅' : run.status === 'partial' ? '⚠' : '❌'} ${run.status}
            </span>
            <span class="ds-history-profile-name">${esc(run.profileName || 'Unknown profile')}</span>
            ${run.scheduledRun ? '<span class="ds-chip">📅 scheduled</span>' : ''}
            <span class="ds-history-time">${timeAgo(run.startedAt)}</span>
            ${retryable ? `<button class="ds-btn ds-btn-xs ds-btn-primary" data-dsaction="retryFailed" data-arg="${esc(run.id)}"
              title="Re-run this profile transferring ONLY the ${totalFailed} record(s) that failed before. Skips records that already succeeded so you don't double-create.">↻ Retry failed (${totalFailed})</button>` : ''}
          </div>
          <div class="ds-history-orgs">
            ${esc(orgLabel(run.sourceOrg || ''))} → ${esc(orgLabel(run.targetOrg || ''))}
            ${run.kind === 'reconcile' ? '<span class="ds-chip" style="margin-left:6px">⚖ reconcile</span>' : ''}
          </div>
          <div class="ds-history-summary">
            ${Object.entries(run.summary || {}).map(([obj, s]) => {
              // Reconcile runs carry explicit per-DML counts (inserted/updated/
              // deleted). Transfer runs carry the legacy created/failed pair.
              // Show whichever set is populated so success detail is visible.
              const isRec = run.kind === 'reconcile' ||
                            s.inserted != null || s.updated != null || s.deleted != null || s.pulled != null;
              if (isRec) {
                const parts = [];
                if (s.inserted)      parts.push(`<span class="ds-rec-tag ds-rec-tag-ins">${s.inserted} inserted</span>`);
                if (s.updated)       parts.push(`<span class="ds-rec-tag ds-rec-tag-upd">${s.updated} updated</span>`);
                if (s.updatedSource) parts.push(`<span class="ds-rec-tag ds-rec-tag-pull">← ${s.updatedSource} updated in source</span>`);
                if (s.pulled)        parts.push(`<span class="ds-rec-tag ds-rec-tag-pull">← ${s.pulled} pulled</span>`);
                if (s.deleted)       parts.push(`<span class="ds-rec-tag ds-rec-tag-del">${s.deleted} deleted${s.deleteMode === 'hard' ? ' (hard)' : ''}</span>`);
                const failTot = (s.insertedFailed || 0) + (s.updatedFailed || 0) + (s.deletedFailed || 0) + (s.pulledFailed || 0) + (s.updatedSourceFailed || 0);
                if (failTot)    parts.push(`<span class="ds-rec-tag ds-rec-tag-fail">${failTot} failed</span>`);
                if (!parts.length) parts.push('<span class="ds-rec-tag">no changes</span>');
                return `<span class="ds-summary-chip"><strong>${esc(obj)}</strong> · ${parts.join(' ')}</span>`;
              }
              return `<span class="ds-summary-chip">${esc(obj)}: ${s.created || 0}↑${s.failed ? ' '+s.failed+'✗' : ''}</span>`;
            }).join('')}
          </div>
          ${(run.errors || []).length ? `
            <details class="ds-history-errors">
              <summary>${run.errors.length} error${run.errors.length!==1?'s':''}</summary>
              ${run.errors.map(e => `<div class="ds-history-err-row">❌ ${esc(e)}</div>`).join('')}
            </details>` : ''}
        </div>`;
      }).join('')}
    </div>
  `);

  eid('dsClearHistory')?.addEventListener('click', () => {
    showModal(`
      <div class="ds-modal-header">Clear History</div>
      <div class="ds-modal-body">Delete all transfer history records?</div>
      <div class="ds-modal-footer">
        <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
        <button class="ds-btn ds-btn-danger" id="dsConfirmClearHistory">Clear All</button>
      </div>`);
    eid('dsConfirmClearHistory')?.addEventListener('click', async () => {
      closeModal();
      _history = [];
      await storageSaveHistory();
      renderHistory();
    });
  });
}

// ════════════════════════════════════════════════════════════════
// ADD ORG MODAL — SOAP login (Jetstream / Gearset style)
// ════════════════════════════════════════════════════════════════
function renderReadiness() {
  const orgs = allMapOrgs();
  const orgOptions = orgs.map(o =>
    `<option value="${o.id}">${esc(orgOptionLabel(o.url, o.label))}</option>`
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
      </div>

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
  // Source org drives the object list — load it when picked (or re-picked),
  // and lazily when the panel is first opened.
  eid('drSrcOrg')?.addEventListener('change', () => {
    _drObjState = { srcId: null, objects: null, selected: new Set() };
    drRefreshObjectList();
  });
  eid('drObjectsPanel')?.addEventListener('toggle', e => {
    if (e.target.open) drRefreshObjectList();
  });
}

// ── Deploy Readiness object multi-select ───────────────────────
// Checkbox panel (same pattern + CSS as Org Compare's picker). Defaults
// pre-check all CUSTOM objects — matching the old "blank = auto-detect
// customs" behaviour, but now visible and editable instead of implicit.
let _drObjState = { srcId: null, objects: null, selected: new Set() };

async function drRefreshObjectList() {
  const listEl  = eid('drObjList');
  const countEl = eid('drObjCount');
  if (!listEl) return;
  const srcId = eid('drSrcOrg')?.value;
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
    _drObjState = {
      srcId,
      objects: objs,
      // Default = all custom objects (the old auto-detect behaviour).
      selected: new Set(objs.filter(o => o.custom).map(o => o.name))
    };
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
  const srcId = eid('drSrcOrg')?.value;
  const tgtId = eid('drTgtOrg')?.value;
  if (!srcId || !tgtId) { showDrError('Select both source and target orgs.'); return; }
  if (srcId === tgtId)  { showDrError('Source and target org must be different.'); return; }

  const chkFields      = eid('drChkFields')?.checked ?? true;
  const chkPicklists   = eid('drChkPicklists')?.checked ?? true;
  const chkRecordTypes = eid('drChkRecordTypes')?.checked ?? true;
  const chkValidation  = eid('drChkValidation')?.checked ?? true;
  const chkDupRules    = eid('drChkDupRules')?.checked ?? true;

  // Resolve sessions
  setDrStatus('⏳ Connecting to orgs…');
  const [srcSess, tgtSess] = await Promise.all([getOrgSession(srcId), getOrgSession(tgtId)]);
  if (!srcSess) { showDrError('Cannot connect to source org. Open it in Chrome or add credentials.'); return; }
  if (!tgtSess) { showDrError('Cannot connect to target org. Open it in Chrome or add credentials.'); return; }

  // Object list — from the multi-select panel. If the user never opened the
  // panel, load it now so the default (all custom objects) applies.
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

  // Results container
  const resultsEl = eid('drResults');
  if (resultsEl) {
    resultsEl.style.display = '';
    resultsEl.innerHTML = `
      <div class="dr-progress">
        ${window.sftkCatSm
          ? sftkCatSm(`Analysing ${objects.length} object${objects.length !== 1 ? 's' : ''}…`)
          : `Analysing ${objects.length} object${objects.length !== 1 ? 's' : ''}…`}
      </div>
      <div id="drObjectCards" class="dr-object-cards"></div>`;
  }

  const cardsEl = eid('drObjectCards');
  let total = 0, critCount = 0, warnCount = 0, okCount = 0;

  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i];
    setDrStatus(`⏳ ${i + 1} / ${objects.length}: ${obj}`);
    const progEl = eid('drProgressText');
    if (progEl) progEl.textContent = `${i + 1} / ${objects.length}: ${obj}`;

    try {
      const card = await analyseObject(obj, srcSess, tgtSess, { chkFields, chkPicklists, chkRecordTypes, chkValidation, chkDupRules });
      total++;
      if (card.severity === 'critical') critCount++;
      else if (card.severity === 'warning') warnCount++;
      else okCount++;
      if (cardsEl) cardsEl.insertAdjacentHTML('beforeend', renderObjectCard(card));
    } catch (e) {
      total++;
      if (cardsEl) cardsEl.insertAdjacentHTML('beforeend', renderObjectCard({
        obj, severity: 'error',
        error: e.message || String(e),
        missingFields: [], requiredFields: [], picklistMismatches: [],
        recordTypeGaps: [], validationRules: [], duplicationRules: []
      }));
    }
  }

  // Remove spinner
  const progRow = resultsEl?.querySelector('.dr-progress');
  if (progRow) progRow.remove();

  // Summary banner at top of cards
  if (cardsEl) {
    const summary = `
      <div class="dr-summary-banner">
        <span class="dr-sum-total">📊 ${total} object${total !== 1 ? 's' : ''} scanned</span>
        ${critCount ? `<span class="dr-sum-badge dr-sum-crit">🔴 ${critCount} critical</span>` : ''}
        ${warnCount ? `<span class="dr-sum-badge dr-sum-warn">🟡 ${warnCount} warnings</span>` : ''}
        ${okCount   ? `<span class="dr-sum-badge dr-sum-ok">✅ ${okCount} ok</span>` : ''}
      </div>`;
    cardsEl.insertAdjacentHTML('afterbegin', summary);
  }

  setDrStatus(`✅ Done — ${total} objects checked`);

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
      query: `SELECT Id, ValidationName, Active, Description FROM ValidationRule WHERE EntityDefinitionId = '${obj}' AND Active = true` }) : Promise.resolve(null),
    opts.chkDupRules ? sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
      query: `SELECT Id, DeveloperName FROM DuplicateRule WHERE SObjectApiName = '${obj}' AND IsActive = true` }) : Promise.resolve(null),
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
  if (opts.chkValidation && valRulesRes && !valRulesRes.error) {
    result.validationRules = (valRulesRes.records || []).map(r => ({
      name: r.ValidationName, desc: r.Description || ''
    }));
  }

  // ── Duplication rules ─────────────────────────────────────────
  if (opts.chkDupRules && dupRulesRes && !dupRulesRes.error) {
    result.duplicationRules = (dupRulesRes.records || []).map(r => ({ name: r.DeveloperName }));
  }

  // ── Severity ─────────────────────────────────────────────────
  const hasCritical = result.missingFields.some(f => f.required)
    || result.requiredFields.length > 0
    || result.typeMismatches.length > 0          // Feature 11
    || result.picklistMismatches.length > 0
    || result.recordTypeGaps.length > 0;

  const hasWarning = result.missingFields.some(f => !f.required)
    || result.validationRules.length > 0
    || result.duplicationRules.length > 0;

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

// ════════════════════════════════════════════════════════════════
// SCHEMA VIEW — Object relationships + flow automation graph
// ════════════════════════════════════════════════════════════════

// Schema view state
let _svNodes    = [];   // { id, label, type, fields, childRels, flows, x, y }
let _svEdges    = [];   // { from, to, label, edgeType }
let _svFlows    = [];   // all fetched FlowVersion records
let _svSelected = null; // currently selected node id
let _svPan      = { x: 0, y: 0 };
let _svPanning  = false;
let _svPanStart = null;
let _svDragNode = null;

// ── Render config form ────────────────────────────────────────
function renderSchemaView() {
  const orgs = allMapOrgs();
  const orgOptions = orgs.map(o =>
    `<option value="${o.id}">${esc(orgOptionLabel(o.url, o.label))}</option>`
  ).join('');

  setMain(`
    <div class="ds-view-header">
      <div class="ds-view-title-wrap">
        <h2 class="ds-view-title">🕸 Schema View</h2>
        <div class="ds-view-subtitle">Visualize object relationships and flow automations — see how changes on one object ripple across your org</div>
      </div>
    </div>

    <div class="ds-op-banner ds-op-banner-read">
      <span class="ds-op-banner-icon">📖</span>
      <div class="ds-op-banner-body">
        <div class="ds-op-banner-title">Read-only — this never modifies any data</div>
        <div class="ds-op-banner-desc">Reads object schemas and flow metadata from the Salesforce REST and Tooling APIs. Nothing is inserted, updated, or deleted.</div>
      </div>
    </div>

    <div class="sv-config">
      <div class="sv-config-row">
        <div class="ds-field-group" style="flex:1">
          <label class="ds-lbl">Org to analyze</label>
          <select id="svOrg" class="ds-select">
            <option value="">— Select org —</option>
            ${orgOptions}
          </select>
        </div>
        <div class="ds-autocomplete-wrap" style="flex:2">
          <label class="ds-lbl">Objects <span class="ds-lbl-hint">(comma-separated API names — blank = auto-load all custom)</span></label>
          <input id="svObjects" class="ds-input" placeholder="Account, Contact, MyObj__c … or leave blank for all custom" autocomplete="off">
          <div id="svObjectsAC" class="ds-autocomplete-list" style="display:none"></div>
        </div>
      </div>

      <div class="sv-config-checks">
        <label class="dr-check-label"><input type="checkbox" id="svChkRels" checked> Lookup &amp; master-detail relationships</label>
        <label class="dr-check-label"><input type="checkbox" id="svChkFlows" checked> Flow automations</label>
        <label class="dr-check-label"><input type="checkbox" id="svChkFlowActions" checked> Cross-object flow actions (deep scan)</label>
        <label class="dr-check-label"><input type="checkbox" id="svChkStd"> Include standard objects in graph</label>
      </div>

      <div style="display:flex;gap:8px;margin-top:14px;align-items:center;flex-wrap:wrap">
        <button class="ds-btn ds-btn-primary" id="svLoadBtn">🕸 Load Schema</button>
        <span id="svStatus" class="dr-status"></span>
      </div>
      <div id="svError" class="dr-error" style="display:none"></div>
    </div>

    <div id="svCanvas" class="sv-canvas" style="display:none">
      <div class="sv-toolbar">
        <button class="ds-btn ds-btn-sm" id="svFitBtn">⊞ Fit to screen</button>
        <button class="ds-btn ds-btn-sm" id="svResetBtn">↺ Reset pan</button>
        <div class="sv-legend">
          <span class="sv-leg-item"><span class="sv-leg-dot sv-leg-custom"></span>Custom obj</span>
          <span class="sv-leg-item"><span class="sv-leg-dot sv-leg-std"></span>Standard obj</span>
          <span class="sv-leg-item"><span class="sv-leg-line sv-leg-lookup"></span>Lookup</span>
          <span class="sv-leg-item"><span class="sv-leg-line sv-leg-md"></span>Master-Detail</span>
          <span class="sv-leg-item"><span class="sv-leg-line sv-leg-flow-edge"></span>Flow action</span>
          <span class="sv-leg-item"><span class="sv-leg-badge"></span>Flow count</span>
        </div>
        <span id="svGraphMeta" class="sv-graph-meta"></span>
      </div>
      <div class="sv-graph-wrap">
        <svg id="svSvg" class="sv-svg"></svg>
        <div id="svDetail" class="sv-detail" style="display:none"></div>
      </div>
    </div>
  `);

  eid('svLoadBtn')?.addEventListener('click', svLoad);
  eid('svFitBtn')?.addEventListener('click', svFitGraph);
  eid('svResetBtn')?.addEventListener('click', () => { _svPan = { x: 0, y: 0 }; svRenderGraph(); });

  // ── Object autocomplete ───────────────────────────────────────
  // When the user types in the Objects field, fetch all sObjects from the
  // selected org and filter them to show matching suggestions.
  let _svObjCache = null;  // { orgId → [{ name, label }] }
  let _svAcTimer  = null;
  const svObjInp  = eid('svObjects');
  const svAcList  = eid('svObjectsAC');

  async function svFetchObjList() {
    const orgId = eid('svOrg')?.value;
    if (!orgId) return [];
    if (_svObjCache?.[orgId]) return _svObjCache[orgId];
    const sess = await getOrgSession(orgId);
    if (!sess?.sid) return [];
    const res = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
      path: 'services/data/v62.0/sobjects' });
    if (res.error || !Array.isArray(res.sobjects)) return [];
    const list = res.sobjects
      .filter(o => o.queryable && o.name)
      .map(o => ({ name: o.name, label: o.label || o.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    _svObjCache = _svObjCache || {};
    _svObjCache[orgId] = list;
    return list;
  }

  function svAcClose() { if (svAcList) svAcList.style.display = 'none'; }

  function svAcShow(items, term) {
    if (!svAcList || !items.length) { svAcClose(); return; }
    svAcList.innerHTML = items.slice(0, 12).map((o, i) =>
      `<div class="ds-autocomplete-item" data-name="${esc(o.name)}" tabindex="-1">
        <span class="ds-autocomplete-item-api">${esc(o.name)}</span>
        <span class="ds-autocomplete-item-label">${esc(o.label)}</span>
      </div>`
    ).join('');
    svAcList.style.display = '';
    svAcList.querySelectorAll('.ds-autocomplete-item').forEach(item => {
      item.addEventListener('mousedown', e => {
        e.preventDefault();  // don't blur input
        const chosen = item.dataset.name;
        // Replace the last token in the comma-separated list
        const parts = (svObjInp.value || '').split(',').map(p => p.trim());
        parts[parts.length - 1] = chosen;
        svObjInp.value = parts.join(', ') + ', ';
        svAcClose();
        svObjInp.focus();
      });
    });
  }

  if (svObjInp) {
    svObjInp.addEventListener('input', () => {
      clearTimeout(_svAcTimer);
      _svAcTimer = setTimeout(async () => {
        const raw   = svObjInp.value || '';
        // Autocomplete the last token after the final comma
        const term  = raw.split(',').pop().trim().toLowerCase();
        if (!term) { svAcClose(); return; }
        const list  = await svFetchObjList();
        const hits  = list.filter(o =>
          o.name.toLowerCase().startsWith(term) ||
          o.label.toLowerCase().startsWith(term)
        );
        svAcShow(hits, term);
      }, 280);
    });

    // Close when input loses focus (allow mousedown handler to fire first)
    svObjInp.addEventListener('blur', () => setTimeout(svAcClose, 150));

    // Also clear suggestions on Enter / Escape
    svObjInp.addEventListener('keydown', e => {
      if (e.key === 'Escape' || e.key === 'Enter') svAcClose();
    });

    // Refresh suggestions if org changes
    eid('svOrg')?.addEventListener('change', () => { svAcClose(); _svAcTimer = null; });
  }
}

// ── Load schema data ──────────────────────────────────────────
async function svLoad() {
  const orgId = eid('svOrg')?.value;
  if (!orgId) { svShowError('Select an org to analyze.'); return; }

  const sess = await getOrgSession(orgId);
  if (!sess) { svShowError('Cannot connect to org. Open it in Chrome or add credentials.'); return; }

  svHideError();
  svSetStatus('⏳ Connecting…');

  // Quick connectivity check — catch stale SID before batching 60 describe calls
  // Use /limits which is always available and tiny
  const pingRes = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
    path: 'services/data/v62.0/limits' });
  if (isSessionResult(pingRes)) {
    svSetStatus('');
    showSessionBanner(sess.orgUrl, () => svLoad());
    return;
  }

  const inclRels        = eid('svChkRels')?.checked ?? true;
  const inclFlows       = eid('svChkFlows')?.checked ?? true;
  const inclFlowActions = eid('svChkFlowActions')?.checked ?? true;
  const inclStd         = eid('svChkStd')?.checked ?? false;

  // Step 1 — Get object list
  let objectsRaw = (eid('svObjects')?.value || '').trim();
  let objects = [];

  // Standard objects to show when org has no custom objects (Dev Edition etc.)
  const STD_FALLBACK = [
    'Account','Contact','Opportunity','Lead','Case','User',
    'Task','Event','Product2','Campaign','CampaignMember',
    'Contract','Order','Quote','Asset','Pricebook2'
  ];

  if (!objectsRaw) {
    svSetStatus('⏳ Loading object list…');
    const listRes = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
      path: 'services/data/v62.0/sobjects' });
    if (listRes.error || isSessionResult(listRes)) {
      if (isSessionResult(listRes)) {
        svSetStatus('');
        showSessionBanner(sess.orgUrl, () => svLoad());
        return;
      }
      svShowError('Failed to load object list: ' + listRes.error);
      return;
    }

    const allSobjects = listRes.sobjects || [];

    if (inclStd) {
      // User explicitly wants standard — show queryable + layoutable, cap 60
      objects = allSobjects
        .filter(o => o.queryable && o.layoutable && !o.deprecatedAndHidden)
        .map(o => o.name).sort();
      if (objects.length > 60) objects = objects.slice(0, 60);
    } else {
      // Default: custom objects only
      objects = allSobjects
        .filter(o => o.custom && !o.deprecatedAndHidden && o.queryable)
        .map(o => o.name).sort();
      if (objects.length > 60) objects = objects.slice(0, 60);

      // Fallback: no custom objects (fresh / Dev Edition org) → use standard set
      if (!objects.length) {
        const available = new Set(allSobjects.map(o => o.name));
        objects = STD_FALLBACK.filter(n => available.has(n));
        svSetStatus('ℹ️ No custom objects found — showing core standard objects');
        // pre-fill the input so the user sees what was chosen
        const inp = eid('svObjects');
        if (inp && !inp.value.trim()) inp.value = objects.join(', ');
      }
    }
  } else {
    objects = objectsRaw.split(',').map(s => s.trim()).filter(Boolean);
  }

  if (!objects.length) {
    svShowError('No objects to analyze. Enter object API names in the field above, or check "Include standard objects".');
    return;
  }
  svSetStatus(`⏳ Describing ${objects.length} objects…`);

  // Step 2 — Describe each object (batched parallel)
  const descMap = {};
  const BATCH = 6;
  let sessionExpiredDuringDescribe = false;
  for (let i = 0; i < objects.length; i += BATCH) {
    if (sessionExpiredDuringDescribe) break;
    const batch = objects.slice(i, i + BATCH);
    svSetStatus(`⏳ Describing ${i + 1}–${Math.min(i + BATCH, objects.length)} / ${objects.length}…`);
    const results = await Promise.all(batch.map(obj =>
      sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
               path: `services/data/v62.0/sobjects/${obj}/describe` })
    ));
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      if (isSessionResult(r)) {
        sessionExpiredDuringDescribe = true;
        break;
      }
      if (!r.error) descMap[batch[j]] = r;
    }
  }
  if (sessionExpiredDuringDescribe) {
    svSetStatus('');
    showSessionBanner(sess.orgUrl, () => svLoad());
    return;
  }

  // Step 3 — Fetch flows
  let flows = [];
  if (inclFlows) {
    svSetStatus('⏳ Fetching flow automations…');
    flows = await svFetchFlows(sess);
    _svFlows = flows;
  }

  // Step 4 — Fetch cross-object flow actions (deep scan)
  let flowActions = []; // [{ fromObj, toObj, flowName, action }]
  if (inclFlows && inclFlowActions && flows.length) {
    svSetStatus('⏳ Scanning cross-object flow actions…');
    flowActions = await svFetchFlowActions(sess, flows, objects);
  }

  // Step 5 — Build and render graph
  svSetStatus('⏳ Building graph…');
  svBuildGraph(objects, descMap, flows, flowActions, inclRels);
  svSetStatus('');
}

// ── Fetch active flows from Tooling API ───────────────────────
async function svFetchFlows(sess) {
  // Query FlowVersion (specific flow versions, not FlowDefinition)
  const res = await sendBg({
    type: 'SF_QUERY', tooling: true,
    orgUrl: sess.orgUrl, sid: sess.sid,
    query: `SELECT Id, ApiName, Label, ProcessType, TriggerType,
              TriggerObjectOrEvent.QualifiedApiName, LastModifiedDate
            FROM FlowVersion
            WHERE Status = 'Active'
            LIMIT 500`
  });
  if (res.error) {
    // Fallback: try FlowDefinition (older API versions)
    const res2 = await sendBg({
      type: 'SF_QUERY', tooling: true,
      orgUrl: sess.orgUrl, sid: sess.sid,
      query: `SELECT Id, ApiName, Label, ActiveVersionId FROM FlowDefinition WHERE ActiveVersionId != null LIMIT 500`
    });
    return res2.records || [];
  }
  return res.records || [];
}

// ── Deep scan: cross-object flow actions ─────────────────────
// Queries the Metadata field on FlowVersion for a sample of record-triggered flows
// and parses recordCreates / recordUpdates pointing at other objects.
async function svFetchFlowActions(sess, flows, objects) {
  const objectSet = new Set(objects.map(o => o.toLowerCase()));
  const actions = [];

  // Only look at record-triggered flows that have a trigger object in our set
  const triggered = flows.filter(f => {
    const trigObj = (f.TriggerObjectOrEvent?.QualifiedApiName || '').toLowerCase();
    return trigObj && objectSet.has(trigObj) &&
      (f.ProcessType === 'AutoLaunchedFlow' || f.ProcessType === 'RecordTriggeredFlow' ||
       f.TriggerType?.includes('Record'));
  }).slice(0, 20); // cap at 20 flows for perf

  if (!triggered.length) return actions;

  // Fetch flow metadata in small batches
  const BATCH = 3;
  for (let i = 0; i < triggered.length; i += BATCH) {
    const batch = triggered.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(f =>
      sendBg({
        type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid,
        path: `services/data/v62.0/tooling/sobjects/FlowVersion/${f.Id}`
      })
    ));

    batch.forEach((flow, idx) => {
      const meta = results[idx]?.Metadata;
      if (!meta) return;

      const fromObj = flow.TriggerObjectOrEvent?.QualifiedApiName;
      if (!fromObj) return;

      // Parse recordCreates
      const creates = Array.isArray(meta.recordCreates) ? meta.recordCreates
        : meta.recordCreates ? [meta.recordCreates] : [];
      for (const rc of creates) {
        const toObj = rc.object;
        if (toObj && toObj !== fromObj && objectSet.has(toObj.toLowerCase())) {
          actions.push({ fromObj, toObj, flowName: flow.Label || flow.ApiName, action: 'creates' });
        }
      }

      // Parse recordUpdates
      const updates = Array.isArray(meta.recordUpdates) ? meta.recordUpdates
        : meta.recordUpdates ? [meta.recordUpdates] : [];
      for (const ru of updates) {
        const toObj = ru.object;
        if (toObj && toObj !== fromObj && objectSet.has(toObj.toLowerCase())) {
          actions.push({ fromObj, toObj, flowName: flow.Label || flow.ApiName, action: 'updates' });
        }
      }

      // Parse subflows (flow calls another flow — show as connection)
      const subflows = Array.isArray(meta.subflows) ? meta.subflows
        : meta.subflows ? [meta.subflows] : [];
      for (const sf of subflows) {
        if (sf.flowName) {
          // find target flow's trigger object
          const target = triggered.find(f2 => f2.ApiName === sf.flowName);
          const toObj = target?.TriggerObjectOrEvent?.QualifiedApiName;
          if (toObj && toObj !== fromObj && objectSet.has(toObj.toLowerCase())) {
            actions.push({ fromObj, toObj, flowName: flow.Label || flow.ApiName, action: 'calls subflow' });
          }
        }
      }
    });
  }

  return actions;
}

// ── Build graph data + render ─────────────────────────────────
function svBuildGraph(objects, descMap, flows, flowActions, inclRels) {
  const objectSet = new Set(objects);

  // Lay out nodes in a grid
  const COLS   = Math.ceil(Math.sqrt(objects.length * 1.4));
  const NODE_W = 170, NODE_H = 62, H_GAP = 90, V_GAP = 70;

  const nodes = objects.map((obj, i) => {
    const col  = i % COLS;
    const row  = Math.floor(i / COLS);
    const desc = descMap[obj] || {};

    // Flows where trigger object = this object
    const objFlows = flows.filter(f => {
      const trig = f.TriggerObjectOrEvent?.QualifiedApiName || '';
      return trig === obj;
    });

    return {
      id:         obj,
      label:      desc.label || obj,
      type:       obj.endsWith('__c') ? 'custom' : 'standard',
      flowCount:  objFlows.length,
      flows:      objFlows,
      fields:     desc.fields || [],
      childRels:  desc.childRelationships || [],
      x:          30 + col * (NODE_W + H_GAP),
      y:          30 + row * (NODE_H + V_GAP),
    };
  });

  const nodeMap = {};
  nodes.forEach(n => { nodeMap[n.id] = n; });

  // Edges — from childRelationships (object A is parent of object B)
  const edges = [];
  const edgeKeys = new Set();

  if (inclRels) {
    for (const node of nodes) {
      for (const rel of node.childRels) {
        const childObj = rel.childSObject;
        if (!objectSet.has(childObj)) continue;
        const key = `${childObj}→${node.id}`;
        if (edgeKeys.has(key)) continue;
        edgeKeys.add(key);
        edges.push({
          from:     childObj,
          to:       node.id,
          label:    rel.relationshipName || '',
          edgeType: rel.cascadeDelete ? 'master-detail' : 'lookup',
        });
      }
    }
  }

  // Edges — from cross-object flow actions
  for (const fa of flowActions) {
    if (!objectSet.has(fa.fromObj) || !objectSet.has(fa.toObj)) continue;
    const key = `flow:${fa.fromObj}→${fa.toObj}:${fa.flowName}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({
      from:     fa.fromObj,
      to:       fa.toObj,
      label:    fa.flowName,
      edgeType: 'flow-action',
      action:   fa.action,
    });
  }

  _svNodes    = nodes;
  _svEdges    = edges;
  _svPan      = { x: 0, y: 0 };
  _svSelected = null;

  const canvas = eid('svCanvas');
  if (canvas) canvas.style.display = '';

  const metaEl = eid('svGraphMeta');
  if (metaEl) metaEl.textContent =
    `${nodes.length} objects · ${edges.filter(e => e.edgeType !== 'flow-action').length} relationships · ` +
    `${edges.filter(e => e.edgeType === 'flow-action').length} flow actions · ${flows.length} total flows`;

  svRenderGraph();
}

// ── Render the SVG graph ──────────────────────────────────────
function svRenderGraph() {
  const oldSvg = eid('svSvg');
  if (!oldSvg) return;

  // Replace the SVG element with a fresh clone to clear ALL accumulated
  // event listeners (mousedown, mousemove, etc.) from previous renders.
  // Without this, each render stacks new listeners on the same element →
  // exponential handler pile-up → browser freeze on any interaction.
  const svg = oldSvg.cloneNode(false);
  oldSvg.parentNode?.replaceChild(svg, oldSvg);

  const nodes = _svNodes;
  const edges = _svEdges;
  const NODE_W = 170, NODE_H = 62;

  // Size SVG to fill wrapper
  const wrap = svg.parentElement;
  const W = wrap ? (wrap.clientWidth  || 900) : 900;
  const H = wrap ? (wrap.clientHeight || 540) : 540;
  svg.setAttribute('width',  W);
  svg.setAttribute('height', H);

  const tx = _svPan.x;
  const ty = _svPan.y;

  const defs = `<defs>
    <marker id="sva-lookup" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
      <polygon points="0 0,9 3.5,0 7" fill="#94A3B8"/>
    </marker>
    <marker id="sva-md" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
      <polygon points="0 0,9 3.5,0 7" fill="#0369A1"/>
    </marker>
    <marker id="sva-flow" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
      <polygon points="0 0,9 3.5,0 7" fill="#7C3AED"/>
    </marker>
    <filter id="sv-shadow">
      <feDropShadow dx="0" dy="1" stdDeviation="2.5" flood-color="rgba(0,0,0,0.13)"/>
    </filter>
  </defs>`;

  // ── Draw edges ──
  let edgesHtml = '';
  for (const e of edges) {
    const fn = nodes.find(n => n.id === e.from);
    const tn = nodes.find(n => n.id === e.to);
    if (!fn || !tn) continue;

    const isFlow = e.edgeType === 'flow-action';
    const isMD   = e.edgeType === 'master-detail';

    const cx1 = fn.x + NODE_W / 2 + tx;
    const cy1 = fn.y + NODE_H / 2 + ty;
    const cx2 = tn.x + NODE_W / 2 + tx;
    const cy2 = tn.y + NODE_H / 2 + ty;

    const dx = cx2 - cx1, dy = cy2 - cy1;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;

    // Clip to node rectangle edge
    const hx = NODE_W / 2, hy = NODE_H / 2;
    const tEdge = Math.min(hx / Math.abs(dx || 1), hy / Math.abs(dy || 1));
    const ex1 = cx1 + dx * tEdge;
    const ey1 = cy1 + dy * tEdge;
    const ex2 = cx2 - dx * (tEdge + 10 / len);
    const ey2 = cy2 - dy * (tEdge + 10 / len);

    // Slight curve for parallel edges
    const midX = (ex1 + ex2) / 2 + (isFlow ? -dy * 0.15 : dy * 0.08);
    const midY = (ey1 + ey2) / 2 + (isFlow ?  dx * 0.15 : -dx * 0.08);

    const color  = isFlow ? '#7C3AED' : isMD ? '#0369A1' : '#94A3B8';
    const marker = isFlow ? 'sva-flow' : isMD ? 'sva-md' : 'sva-lookup';
    const dash   = isFlow ? '6,3' : isMD ? '' : '4,3';
    const width  = isFlow ? 1.8 : isMD ? 2 : 1.5;

    const labelText = e.label.length > 22 ? e.label.substring(0, 20) + '…' : e.label;

    edgesHtml += `<g class="sv-edge">
      <path d="M${ex1},${ey1} Q${midX},${midY} ${ex2},${ey2}"
            fill="none" stroke="${color}" stroke-width="${width}"
            ${dash ? `stroke-dasharray="${dash}"` : ''}
            marker-end="url(#${marker})"/>
      ${labelText ? `<text font-size="9" fill="${color}" font-family="sans-serif" opacity="0.85">
        <textPath href="#svEdgePath_tmp" startOffset="50%" text-anchor="middle"></textPath>
      </text>` : ''}
      ${e.label ? `<text x="${midX}" y="${midY - 4}" font-size="9" fill="${color}"
            font-family="sans-serif" text-anchor="middle" opacity="0.85">${esc(labelText)}</text>` : ''}
    </g>`;
  }

  // ── Draw nodes ──
  let nodesHtml = '';
  for (const node of nodes) {
    const nx = node.x + tx;
    const ny = node.y + ty;
    const isSelected = _svSelected === node.id;
    const isCustom   = node.type === 'custom';

    const fill   = isSelected ? (isCustom ? '#DBEAFE' : '#F1F5F9')
                               : (isCustom ? '#EFF6FF' : '#FAFAFA');
    const stroke = isSelected ? '#1D4ED8' : (isCustom ? '#3B82F6' : '#CBD5E1');
    const sw     = isSelected ? 2.5 : 1.5;

    const labelTxt = node.label.length > 21 ? node.label.substring(0, 19) + '…' : node.label;
    const apiTxt   = node.id.length   > 23 ? node.id.substring(0, 21)   + '…' : node.id;

    // Incoming/outgoing edge counts
    const outRel = edges.filter(e => e.from === node.id && e.edgeType !== 'flow-action').length;
    const inRel  = edges.filter(e => e.to   === node.id && e.edgeType !== 'flow-action').length;
    const metaTxt = `${inRel} in · ${outRel} out`;

    // Flow badge (purple circle top-right)
    const flowBadge = node.flowCount > 0 ? `
      <circle cx="${nx + NODE_W - 5}" cy="${ny + 5}" r="10" fill="#7C3AED"/>
      <text x="${nx + NODE_W - 5}" y="${ny + 9}" text-anchor="middle"
            font-size="9" font-weight="700" fill="white" font-family="sans-serif">${node.flowCount > 9 ? '9+' : node.flowCount}</text>` : '';

    nodesHtml += `<g class="sv-node" data-id="${esc(node.id)}" style="cursor:pointer">
      <rect x="${nx}" y="${ny}" width="${NODE_W}" height="${NODE_H}" rx="8"
            fill="${fill}" stroke="${stroke}" stroke-width="${sw}"
            filter="url(#sv-shadow)"/>
      <text x="${nx + 10}" y="${ny + 21}" font-size="12" font-weight="600"
            fill="#1E293B" font-family="sans-serif">${esc(labelTxt)}</text>
      <text x="${nx + 10}" y="${ny + 36}" font-size="10" fill="#3B82F6"
            font-family="monospace">${esc(apiTxt)}</text>
      <text x="${nx + 10}" y="${ny + 52}" font-size="9" fill="#94A3B8"
            font-family="sans-serif">${esc(metaTxt)} · ${node.fields.length} fields</text>
      ${flowBadge}
    </g>`;
  }

  svg.innerHTML = `${defs}
    <g id="svEdgeGroup">${edgesHtml}</g>
    <g id="svNodeGroup">${nodesHtml}</g>`;

  // Empty state
  if (!nodes.length) {
    svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" font-size="14"
      fill="#94A3B8" font-family="sans-serif">No objects to display</text>`;
  }

  // ── Wire SVG interactions ──
  svg.querySelectorAll('.sv-node').forEach(el => {
    // Click to select / deselect
    el.addEventListener('click', ev => {
      ev.stopPropagation();
      const id = el.dataset.id;
      _svSelected = (_svSelected === id) ? null : id;
      svRenderGraph();
      if (_svSelected) svShowDetail(_svSelected);
      else { const d = eid('svDetail'); if (d) d.style.display = 'none'; }
    });

    // Drag node
    el.addEventListener('mousedown', ev => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      ev.preventDefault();
      const nodeId = el.dataset.id;
      const node = _svNodes.find(n => n.id === nodeId);
      if (!node) return;
      _svDragNode = { node, sx: ev.clientX, sy: ev.clientY, ox: node.x, oy: node.y };

      const onMove = mv => {
        if (!_svDragNode) return;
        _svDragNode.node.x = _svDragNode.ox + mv.clientX - _svDragNode.sx;
        _svDragNode.node.y = _svDragNode.oy + mv.clientY - _svDragNode.sy;
        svRenderGraph();
      };
      const onUp = () => {
        _svDragNode = null;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });

  // Background click = deselect
  svg.addEventListener('click', ev => {
    if (!ev.target.closest('.sv-node')) {
      _svSelected = null;
      const d = eid('svDetail');
      if (d) d.style.display = 'none';
      svRenderGraph();
    }
  });

  // Pan on background drag
  svg.addEventListener('mousedown', ev => {
    if (ev.target.closest('.sv-node')) return;
    if (ev.button !== 0) return;
    _svPanning  = true;
    _svPanStart = { mx: ev.clientX, my: ev.clientY, tx: _svPan.x, ty: _svPan.y };
    ev.preventDefault();
  });
  svg.addEventListener('mousemove', ev => {
    if (!_svPanning || !_svPanStart) return;
    _svPan.x = _svPanStart.tx + ev.clientX - _svPanStart.mx;
    _svPan.y = _svPanStart.ty + ev.clientY - _svPanStart.my;
    svRenderGraph();
  });
  svg.addEventListener('mouseup',    () => { _svPanning = false; _svPanStart = null; });
  svg.addEventListener('mouseleave', () => { _svPanning = false; _svPanStart = null; });

  // Scroll-to-zoom
  svg.addEventListener('wheel', ev => {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.1 : 0.91;
    for (const n of _svNodes) {
      n.x = (n.x - _svPan.x) * factor + _svPan.x;
      n.y = (n.y - _svPan.y) * factor + _svPan.y;
    }
    for (const n of _svNodes) {
      // also scale positions relative to canvas center
    }
    svRenderGraph();
  }, { passive: false });
}

// ── Detail panel ──────────────────────────────────────────────
function svShowDetail(nodeId) {
  const node = _svNodes.find(n => n.id === nodeId);
  if (!node) return;
  const detail = eid('svDetail');
  if (!detail) return;

  // Flows section
  const flowRows = node.flows.length
    ? node.flows.map(f => {
        const procType = f.ProcessType || '';
        const trigType = f.TriggerType || '';
        const icon = trigType.includes('Before') ? '⚡ Before-save'
          : trigType.includes('After')            ? '🔄 After-save'
          : procType === 'Schedule'               ? '📅 Scheduled'
          : procType === 'AutoLaunchedFlow'       ? '▶ Auto-launched'
          : '▶ Flow';
        return `<div class="sv-detail-flow">
          <div class="sv-detail-flow-type">${esc(icon)}</div>
          <div class="sv-detail-flow-info">
            <div class="sv-detail-flow-name">${esc(f.Label || f.ApiName)}</div>
            <div class="sv-detail-flow-meta">${esc(f.ApiName)}</div>
          </div>
        </div>`;
      }).join('')
    : '<div class="sv-detail-empty">No active flows on this object</div>';

  // Cross-object flow action edges involving this node
  const outActions = _svEdges.filter(e => e.from === nodeId && e.edgeType === 'flow-action');
  const inActions  = _svEdges.filter(e => e.to   === nodeId && e.edgeType === 'flow-action');

  const actionSection = (outActions.length || inActions.length) ? `
    <div class="sv-detail-section">
      <div class="sv-detail-section-title">🕸 Cross-Object Flow Actions</div>
      ${outActions.map(e => `<div class="sv-detail-action sv-detail-action-out">
        <span class="sv-action-dir">→ ${esc(e.to)}</span>
        <span class="sv-action-name">${esc(e.label)} <em>(${esc(e.action || '')})</em></span>
      </div>`).join('')}
      ${inActions.map(e => `<div class="sv-detail-action sv-detail-action-in">
        <span class="sv-action-dir">← ${esc(e.from)}</span>
        <span class="sv-action-name">${esc(e.label)} <em>(${esc(e.action || '')})</em></span>
      </div>`).join('')}
    </div>` : '';

  // Reference fields (lookup/MD fields)
  const lookupFields = (node.fields || [])
    .filter(f => f.type === 'reference' && (f.referenceTo || []).length > 0)
    .slice(0, 20);
  const lookupSection = lookupFields.length ? `
    <div class="sv-detail-section">
      <div class="sv-detail-section-title">🔗 Reference Fields (${lookupFields.length})</div>
      ${lookupFields.map(f => `<div class="sv-detail-field">
        <span class="sv-detail-field-name">${esc(f.name)}</span>
        <span class="sv-detail-field-ref">→ ${esc((f.referenceTo || []).slice(0,3).join(', '))}${(f.referenceTo||[]).length > 3 ? '…' : ''}</span>
      </div>`).join('')}
    </div>` : '';

  // Child relationships
  const childRels = (node.childRels || []).slice(0, 20);
  const childSection = childRels.length ? `
    <div class="sv-detail-section">
      <div class="sv-detail-section-title">👇 Child Relationships (${childRels.length})</div>
      ${childRels.map(r => `<div class="sv-detail-field">
        <span class="sv-detail-field-name">${esc(r.relationshipName || r.childSObject)}</span>
        <span class="sv-detail-field-ref">${esc(r.childSObject)}</span>
      </div>`).join('')}
    </div>` : '';

  detail.style.display = '';
  detail.innerHTML = `
    <div class="sv-detail-hdr">
      <div>
        <strong class="sv-detail-title">${esc(node.label)}</strong>
        <div class="sv-detail-api">${esc(node.id)}</div>
      </div>
      <button class="sv-detail-close" id="svDetailClose">✕</button>
    </div>
    <div class="sv-detail-body">
      <div class="sv-detail-meta-row">
        <span>${node.fields.length} fields</span>
        <span>${node.childRels.length} child rels</span>
        <span>${node.flowCount} flows</span>
        <span class="sv-type-badge ${node.type === 'custom' ? 'sv-type-custom' : 'sv-type-std'}">${node.type}</span>
      </div>
      <div class="sv-detail-section">
        <div class="sv-detail-section-title">🔄 Active Flows (${node.flows.length})</div>
        ${flowRows}
      </div>
      ${actionSection}
      ${lookupSection}
      ${childSection}
    </div>`;

  eid('svDetailClose')?.addEventListener('click', () => {
    _svSelected = null;
    detail.style.display = 'none';
    svRenderGraph();
  });
}

// ── Fit graph to canvas ───────────────────────────────────────
function svFitGraph() {
  if (!_svNodes.length) return;
  const svg  = eid('svSvg');
  if (!svg) return;
  const W = parseInt(svg.getAttribute('width'))  || 900;
  const H = parseInt(svg.getAttribute('height')) || 540;
  const NODE_W = 170, NODE_H = 62;

  const minX = Math.min(..._svNodes.map(n => n.x));
  const minY = Math.min(..._svNodes.map(n => n.y));
  const maxX = Math.max(..._svNodes.map(n => n.x + NODE_W));
  const maxY = Math.max(..._svNodes.map(n => n.y + NODE_H));

  const scale = Math.min((W - 60) / (maxX - minX || 1), (H - 60) / (maxY - minY || 1), 1.5);

  for (const n of _svNodes) {
    n.x = (n.x - minX) * scale + 30;
    n.y = (n.y - minY) * scale + 30;
  }
  _svPan = { x: 0, y: 0 };
  svRenderGraph();
}

// ── Status / error helpers ────────────────────────────────────
function svSetStatus(msg) {
  const el = eid('svStatus');
  if (el) el.textContent = msg;
}

function svShowError(msg) {
  const el = eid('svError');
  if (el) { el.textContent = '❌ ' + msg; el.style.display = ''; }
  svSetStatus('');
}

function svHideError() {
  const el = eid('svError');
  if (el) el.style.display = 'none';
}
