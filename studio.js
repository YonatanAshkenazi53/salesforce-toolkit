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
let _currentView = 'map';
let _profiles    = [];
let _history     = [];
let _orgs        = {};

// Feature 15 — Dark mode
let _darkMode    = false;

// Feature 14 — Activity log { viewKey: ISO timestamp }
let _activityLog = {};

// Org Map / Scan Map state (new)
let _storedOrgs   = [];   // orgs added via SOAP login (persistent)
let _connections  = [];   // directional links between orgs on the map
let _scans        = [];   // scan configurations
let _scanResults  = [];   // scan run history

// SVG map interaction state
// Note: pre-2026-05-15 this had a `connectMode`/`connectSrc` pair that drove a
// free-form "draw an arrow between orgs" UI. Those connections had no functional
// consequence — they were purely decorative. Architecture A replaced them with
// schedule-derived edges (drawn automatically from `profile.schedule.enabled`),
// so the state shrinks to drag/pan/selection only.
let _mapState = {
  dragging:      null,   // { orgId, ox, oy, startX, startY }
  panning:       false,  // background pan
  panStart:      null,   // { mx, my, tx, ty }
  translate:     { x: 0, y: 0 },
  selectedNode:  null,   // orgId of selected node
};

// Profile builder state
let _editingProfile  = null;  // Profile being built / edited (in-memory)
let _describeCache   = {};    // objectType → describe result
let _refFieldCache   = {};    // Lookup resolution: refObjectType → [{ name, label }] | 'loading' | null

// Transfer state
let _transferProfile      = null;
let _transferSrc          = null;
let _transferTgt          = null;
let _transferDryRun       = false;   // Feature 5 — dry run
let _transferConflict     = 'skip';  // Feature 6 — conflict resolution: 'skip' | 'overwrite'
// Per-run record filter overrides — pathKey → { where, recordIds }.
// These override the saved profile for a single run without mutating it.
// Cleared whenever the selected profile changes.
let _transferNodeFilters  = {};

// Phase 2 — Org Map drift overlay
// Cached on view enter so drawMapEdges/drawMapNodes can stay synchronous.
// Refresh via refreshSnapshotsCache() before any draw that depends on snapshots.
let _snapshotsCache = {};

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

    // Also refresh stored-org SIDs via SOAP re-login if credentials present
    for (const stored of _storedOrgs) {
      if (stored.url === orgUrl && stored.username && stored.password) {
        const loginUrl = (stored.type === 'sandbox' || stored.loginUrl?.includes('test.'))
          ? 'https://test.salesforce.com/services/Soap/u/62.0'
          : 'https://login.salesforce.com/services/Soap/u/62.0';
        const res = await sendBg({ type: 'DS_SOAP_LOGIN', loginUrl,
          username: stored.username, password: stored.password });
        if (!res.error) { stored.sid = res.sid; await saveStoredOrgs(); }
      }
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
    'ds_stored_orgs','ds_connections','ds_scans','ds_scan_results',
    'ds_dark_mode','ds_activity_log'
  ]);
  _profiles     = d.sftk_profiles   || [];
  _history      = d.sftk_history    || [];
  _orgs         = d.sftk_orgs       || {};
  _storedOrgs   = d.ds_stored_orgs  || [];
  _connections  = d.ds_connections  || [];
  _scans        = d.ds_scans        || [];
  _scanResults  = d.ds_scan_results || [];
  _darkMode     = d.ds_dark_mode    || false;
  _activityLog  = d.ds_activity_log || {};

  // Load credential-vault metadata. If a vault exists, stored org passwords
  // are held as `password_enc` blobs and stay encrypted until the user
  // unlocks (handled after first render in DOMContentLoaded).
  if (window.SFTKVault) { try { await SFTKVault.init(); } catch (_) {} }

  expireIdleCredentials();
}

// ── Credential vault — encrypt/decrypt at the storage boundary ───
// When a vault is set up + unlocked, org passwords live encrypted on disk
// (`password_enc`) and as plaintext `password` only in memory for the session.

// Decrypt every `password_enc` in _storedOrgs into plaintext `password`
// (in-memory only). Called once after the vault is unlocked.
async function decryptStoredOrgs() {
  if (!window.SFTKVault || !SFTKVault.isUnlocked()) return;
  for (const o of _storedOrgs) {
    if (o && o.password_enc && !o.password) {
      try {
        o.password = await SFTKVault.decrypt(o.password_enc);
      } catch (_) { /* leave encrypted — wrong key / corrupt blob */ }
    }
  }
}

// Build a storage-safe copy of _storedOrgs: when the vault is unlocked, any
// plaintext `password` is replaced with an encrypted `password_enc` blob.
async function _storedOrgsForSave() {
  if (!window.SFTKVault || !SFTKVault.isEnabled() || !SFTKVault.isUnlocked()) {
    return _storedOrgs; // vault off or locked — save as-is (no plaintext leak: locked entries already have password_enc)
  }
  const out = [];
  for (const o of _storedOrgs) {
    const c = { ...o };
    if (c.password) {
      try {
        c.password_enc = await SFTKVault.encrypt(c.password);
        delete c.password; // never persist plaintext when the vault is on
      } catch (_) { /* encryption failed — fall through, keep as-is */ }
    }
    out.push(c);
  }
  return out;
}

// ── Auto-expire idle stored credentials ───────────────────────
// Credentials that haven't been used in CRED_TTL_DAYS have their secrets
// (password + cached session id) wiped from storage. The org entry itself
// is kept — the user just has to reconnect, which re-enters the password.
// Shrinks the window in which a stored secret is exposed on disk.
const CRED_TTL_DAYS = 30;
function expireIdleCredentials() {
  const cutoff = Date.now() - CRED_TTL_DAYS * 86400000;
  let changed = false;
  for (const o of _storedOrgs) {
    if (!o || (!o.password && !o.password_enc && !o.sid)) continue;
    const stamp = Date.parse(o.lastConnected || o.lastUsed || o.addedAt || '') || 0;
    if (stamp && stamp < cutoff) {
      delete o.password;
      delete o.password_enc; // also clear the encrypted secret
      delete o.sid;
      o.expired = true; // UI can show "reconnect required"
      changed = true;
    }
  }
  if (changed) {
    try { chrome.storage.local.set({ ds_stored_orgs: _storedOrgs }); } catch (_) {}
  }
}

async function saveStoredOrgs()  {
  await chrome.storage.local.set({ ds_stored_orgs: await _storedOrgsForSave() });
}
async function saveConnections() { await chrome.storage.local.set({ ds_connections:   _connections }); }
async function saveScans()       { await chrome.storage.local.set({ ds_scans:         _scans       }); }
async function saveScanResults() {
  const r = _scanResults.slice(-50);
  await chrome.storage.local.set({ ds_scan_results: r });
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
      case 'closeMapDetail':        { const d = eid('dsMapDetail'); if (d) d.style.display = 'none'; break; }
      case 'closeScanResult':       { const d = eid('dsScanResultDetail'); if (d) d.style.display = 'none'; break; }
      case 'showAddOrgHelp':        showAddOrgHelp(); break;
      case 'editOrgLabel':          window.editOrgLabel?.(arg); break;
      case 'startTransferFrom':     window.startTransferFrom?.(arg); break;
      case 'reconnectOrgFromPanel': window.reconnectOrgFromPanel?.(arg); break;
      case 'removeOrg':             window.removeOrg?.(arg); break;
      case 'editStoredOrg':         window.editStoredOrg?.(arg); break;
      case 'startTransferFromOrg':  window.startTransferFromOrg?.(arg); break;
      case 'reconnectOrg':          window.reconnectOrg?.(arg); break;
      case 'removeStoredOrg':       window.removeStoredOrg?.(arg); break;
      case 'snapshotNow':           window.snapshotOrgNow?.(arg); break;
      // deleteConnection removed in Architecture A (manual connections no longer rendered)
      case 'scheduleFromOrg': {
        // Open the schedule wizard with this org pre-selected as source
        const detailPanel = eid('dsMapDetail');
        if (detailPanel) detailPanel.style.display = 'none';
        openScheduleTransferModal({ sourceOrgId: arg });
        break;
      }
      case 'runProfile':            window.runProfile?.(arg); break;
      case 'editProfile':           window.editProfile?.(arg); break;
      case 'cloneProfile':          window.cloneProfile?.(arg); break;
      case 'deleteProfile':         window.deleteProfile?.(arg); break;
      case 'refreshDiff':           window.refreshProfileDiff?.(arg); break;
      case 'snapshotProfile':       window.snapshotProfileNow?.(arg); break;
      case 'showDriftRecords': {
        const [pid, t] = (arg || '').split('|');
        const p = _profiles.find(x => x.id === pid);
        if (p && t) showDriftRecordsModal(p, t);
        break;
      }
      case 'disableSchedule':       window.disableSchedule?.(arg); break;
      case 'runScanNow':            window.runScanNow?.(arg); break;
      case 'viewScanResult':        window.viewScanResult?.(arg); break;
      case 'editScan':              window.editScan?.(arg); break;
      case 'deleteScan':            window.deleteScan?.(arg); break;
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

  // Home starts without sidebar — apply class before first render
  document.querySelector('.ds-body')?.classList.add('ds-home');

  // Brand name = home button (collapse sidebar, go back to org map)
  document.querySelector('.ds-brand')?.addEventListener('click', () => {
    document.querySelectorAll('.ds-nav-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.view === 'map'));
    _currentView = 'map';
    renderView('map');
  });

  // First-run: if no orgs known, show welcome instead of empty map
  const isFirstRun = !_orgUrl && !_allSessions.length && !_storedOrgs.length
    && !Object.keys(_orgs).length;
  if (isFirstRun) {
    renderWelcome();
  } else {
    renderView('map');
  }

  // Feature 8: Show drift badge on initial load if persisted scan results have drift
  // Must run after first render so the nav DOM exists
  updateScanDriftBadge();

  // If the credential vault is locked, offer to unlock it now so stored
  // org passwords are available this session.
  maybeUnlockVault();

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
          <span class="sec-yes-text">Uses your <strong>existing Salesforce browser session</strong> — the same cookie your browser already has. No username or password is ever typed into this tool unless you explicitly choose "Connect with Credentials."</span>
        </div>
        <div class="sec-yes-row">
          <span class="sec-yes-icon">📖</span>
          <span class="sec-yes-text">Calls <strong>Salesforce REST &amp; Tooling APIs</strong> on your behalf — purely to read schema, record counts, and flow metadata for the features you activate.</span>
        </div>
        <div class="sec-yes-row">
          <span class="sec-yes-icon">💾</span>
          <span class="sec-yes-text">Saves <strong>only to Chrome's local storage</strong> on this machine: org labels you set, transfer profiles you create, scan history, and — if you added them — connection credentials. Credentials never leave this device and idle ones are auto-cleared after 30 days.</span>
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
          <span class="sec-never-text"><strong>Store credentials in the cloud</strong> — if you use "Connect with Credentials," the password is held only in Chrome's local storage on this machine, and idle credentials are auto-cleared after 30 days.</span>
        </div>
        <div class="sec-never-row">
          <span class="sec-never-icon">✗</span>
          <span class="sec-never-text"><strong>Execute any write operation without your confirmation</strong> — every DML action requires you to pick source, target, and run explicitly.</span>
        </div>
        <div class="sec-never-row">
          <span class="sec-never-icon">✗</span>
          <span class="sec-never-text"><strong>Share data between orgs silently</strong> — the Scan, Schema View, and Deploy Readiness features are 100% read-only.</span>
        </div>
        <div class="sec-never-row">
          <span class="sec-never-icon">✗</span>
          <span class="sec-never-text"><strong>Access orgs you haven't opened</strong> — it can only reach orgs that have an active session in your Chrome tabs or that you've explicitly authenticated.</span>
        </div>
      </div>

      <div class="sec-section-title">🔐 Credential Vault</div>
      <div class="sec-vault" id="dsVaultSection">${vaultSectionHtml()}</div>

      <div class="sec-storage-note">
        <strong>🔍 Fully inspectable:</strong> This is a Chrome extension — you can review every line of code at
        <code>chrome://extensions</code> → Details → Inspect views. All network requests appear in the DevTools Network tab.
        There is no minified or obfuscated code.
      </div>

    </div>

    <div class="ds-modal-footer">
      <button class="ds-btn ds-btn-primary" data-dsaction="closeModal">Got it — I trust this tool</button>
    </div>`);

  setTimeout(wireVaultSection, 0);
}

// ════════════════════════════════════════════════════════════════
// CREDENTIAL VAULT — UI
// ════════════════════════════════════════════════════════════════
function vaultSectionHtml() {
  const has      = !!(window.SFTKVault && SFTKVault.isEnabled());
  const unlocked = has && SFTKVault.isUnlocked();
  if (!has) {
    return `<div class="sec-vault-desc">Encrypt your stored connection passwords at rest with
      <strong>AES-256-GCM</strong>, using a passphrase only you know. The passphrase is never saved —
      you enter it once per browser session to unlock.</div>
      <button class="ds-btn ds-btn-primary ds-btn-sm" id="dsVaultEnable">🔐 Enable vault</button>`;
  }
  if (!unlocked) {
    return `<div class="sec-vault-desc">🔒 Vault is <strong>locked</strong>. Stored passwords are
      encrypted on disk and unavailable until you unlock.</div>
      <button class="ds-btn ds-btn-primary ds-btn-sm" id="dsVaultUnlock">🔓 Unlock vault</button>`;
  }
  return `<div class="sec-vault-desc">🔓 Vault is <strong>unlocked</strong>. Stored passwords are
    encrypted on disk (AES-256-GCM) and held in memory only for this session.</div>
    <div class="sec-vault-actions">
      <button class="ds-btn ds-btn-sm" id="dsVaultLock">🔒 Lock now</button>
      <button class="ds-btn ds-btn-sm" id="dsVaultChange">Change passphrase</button>
      <button class="ds-btn ds-btn-danger ds-btn-sm" id="dsVaultDisable">Disable vault</button>
    </div>`;
}

function wireVaultSection() {
  eid('dsVaultEnable') ?.addEventListener('click', enableVault);
  eid('dsVaultUnlock') ?.addEventListener('click', () => promptVaultUnlock());
  eid('dsVaultLock')   ?.addEventListener('click', lockVault);
  eid('dsVaultChange') ?.addEventListener('click', changeVaultPassphrase);
  eid('dsVaultDisable')?.addEventListener('click', disableVault);
}

function refreshVaultSection() {
  const el = eid('dsVaultSection');
  if (el) { el.innerHTML = vaultSectionHtml(); wireVaultSection(); }
}

// Show the unlock modal if a vault exists, is locked, and there are encrypted
// credentials to decrypt. Returns a promise<boolean> — true if unlocked.
function maybeUnlockVault() {
  if (!window.SFTKVault || !SFTKVault.isEnabled() || SFTKVault.isUnlocked()) {
    return Promise.resolve(SFTKVault ? SFTKVault.isUnlocked() : false);
  }
  const hasEncrypted = _storedOrgs.some(o => o && o.password_enc);
  if (!hasEncrypted) return Promise.resolve(false);
  return promptVaultUnlock();
}

function promptVaultUnlock() {
  return new Promise(resolve => {
    showModal(`
      <div class="ds-modal-header">🔓 Unlock Credential Vault</div>
      <div class="ds-modal-body">
        <p class="ds-modal-text">Enter your vault passphrase to decrypt your stored connection
          passwords for this session.</p>
        <input type="password" id="dsVaultPass" class="ds-input" placeholder="Vault passphrase" autocomplete="off">
        <div id="dsVaultErr" class="ds-vault-err" style="display:none"></div>
      </div>
      <div class="ds-modal-footer">
        <button class="ds-btn" id="dsVaultCancel">Skip for now</button>
        <button class="ds-btn ds-btn-primary" id="dsVaultGo">🔓 Unlock</button>
      </div>`);
    let done = false;
    const finish = (ok) => { if (done) return; done = true; closeModal(); resolve(ok); };
    setTimeout(() => {
      const inp = eid('dsVaultPass'), err = eid('dsVaultErr');
      inp?.focus();
      const go = async () => {
        const pass = inp?.value || '';
        if (!pass) return;
        try {
          await SFTKVault.unlock(pass);
          await decryptStoredOrgs();
          showToast('Vault unlocked', 'success', 2500);
          finish(true);
        } catch (e) {
          if (err) { err.textContent = e.message || 'Could not unlock.'; err.style.display = ''; }
        }
      };
      eid('dsVaultGo')?.addEventListener('click', go);
      eid('dsVaultCancel')?.addEventListener('click', () => finish(false));
      inp?.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    }, 0);
  });
}

function enableVault() {
  showModal(`
    <div class="ds-modal-header">🔐 Enable Credential Vault</div>
    <div class="ds-modal-body">
      <p class="ds-modal-text">Choose a passphrase to encrypt your stored connection passwords.
        <strong>It is never saved</strong> — if you forget it you'll have to re-enter your org
        passwords. You'll enter it once per browser session.</p>
      <input type="password" id="dsVaultP1" class="ds-input" placeholder="New passphrase (min 6 characters)" autocomplete="off">
      <input type="password" id="dsVaultP2" class="ds-input" placeholder="Confirm passphrase" autocomplete="off" style="margin-top:8px">
      <div id="dsVaultErr" class="ds-vault-err" style="display:none"></div>
    </div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn ds-btn-primary" id="dsVaultGo">🔐 Enable</button>
    </div>`);
  setTimeout(() => {
    const p1 = eid('dsVaultP1'), p2 = eid('dsVaultP2'), err = eid('dsVaultErr');
    p1?.focus();
    const fail = (m) => { if (err) { err.textContent = m; err.style.display = ''; } };
    const go = async () => {
      const a = p1?.value || '', b = p2?.value || '';
      if (a.length < 6) return fail('Passphrase must be at least 6 characters.');
      if (a !== b)      return fail('Passphrases do not match.');
      try {
        await SFTKVault.setup(a);
        await saveStoredOrgs();        // re-saves, now encrypting every password
        showToast('Credential vault enabled — passwords are now encrypted', 'success', 4000);
        closeModal();
        showSecurityModal();
      } catch (e) { fail(e.message || 'Could not enable the vault.'); }
    };
    eid('dsVaultGo')?.addEventListener('click', go);
    p2?.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  }, 0);
}

function lockVault() {
  if (!window.SFTKVault) return;
  SFTKVault.lock();
  // Drop plaintext passwords from memory — keep the encrypted blob for re-save.
  for (const o of _storedOrgs) {
    if (o && o.password_enc) delete o.password;
  }
  showToast('Vault locked — stored passwords cleared from memory', 'info', 3000);
  refreshVaultSection();
}

function disableVault() {
  showModal(`
    <div class="ds-modal-header">Disable Credential Vault</div>
    <div class="ds-modal-body">
      <p class="ds-modal-text">Enter your passphrase to confirm. Your stored passwords will be
        decrypted and saved <strong>unencrypted</strong> in local storage.</p>
      <input type="password" id="dsVaultPass" class="ds-input" placeholder="Vault passphrase" autocomplete="off">
      <div id="dsVaultErr" class="ds-vault-err" style="display:none"></div>
    </div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn ds-btn-danger" id="dsVaultGo">Disable vault</button>
    </div>`);
  setTimeout(() => {
    const inp = eid('dsVaultPass'), err = eid('dsVaultErr');
    inp?.focus();
    const go = async () => {
      const pass = inp?.value || '';
      try {
        // Ensure in-memory orgs hold plaintext passwords before we lose the key.
        if (!SFTKVault.isUnlocked()) await SFTKVault.unlock(pass);
        await decryptStoredOrgs();
        await SFTKVault.disable(pass);            // verifies passphrase, removes meta
        for (const o of _storedOrgs) delete o.password_enc;
        await saveStoredOrgs();                   // vault now off → saves plaintext
        showToast('Credential vault disabled', 'info', 3000);
        closeModal();
        showSecurityModal();
      } catch (e) {
        if (err) { err.textContent = e.message || 'Could not disable the vault.'; err.style.display = ''; }
      }
    };
    eid('dsVaultGo')?.addEventListener('click', go);
    inp?.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  }, 0);
}

function changeVaultPassphrase() {
  showModal(`
    <div class="ds-modal-header">Change Vault Passphrase</div>
    <div class="ds-modal-body">
      <input type="password" id="dsVaultOld" class="ds-input" placeholder="Current passphrase" autocomplete="off">
      <input type="password" id="dsVaultN1" class="ds-input" placeholder="New passphrase (min 6 characters)" autocomplete="off" style="margin-top:8px">
      <input type="password" id="dsVaultN2" class="ds-input" placeholder="Confirm new passphrase" autocomplete="off" style="margin-top:8px">
      <div id="dsVaultErr" class="ds-vault-err" style="display:none"></div>
    </div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn ds-btn-primary" id="dsVaultGo">Change passphrase</button>
    </div>`);
  setTimeout(() => {
    const oldI = eid('dsVaultOld'), n1 = eid('dsVaultN1'), n2 = eid('dsVaultN2'), err = eid('dsVaultErr');
    oldI?.focus();
    const fail = (m) => { if (err) { err.textContent = m; err.style.display = ''; } };
    const go = async () => {
      if ((n1?.value || '').length < 6) return fail('New passphrase must be at least 6 characters.');
      if (n1?.value !== n2?.value)      return fail('New passphrases do not match.');
      try {
        // Ensure plaintext passwords are in memory before re-keying.
        if (!SFTKVault.isUnlocked()) await SFTKVault.unlock(oldI?.value || '');
        await decryptStoredOrgs();
        await SFTKVault.changePassphrase(oldI?.value || '', n1?.value || '');
        await saveStoredOrgs();                   // re-encrypts everything with the new key
        showToast('Vault passphrase changed', 'success', 3000);
        closeModal();
        showSecurityModal();
      } catch (e) { fail(e.message || 'Could not change the passphrase.'); }
    };
    eid('dsVaultGo')?.addEventListener('click', go);
    n2?.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  }, 0);
}

// ════════════════════════════════════════════════════════════════
// WELCOME SCREEN  (first run — no orgs detected yet)
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
        <div class="ds-welcome-card" data-gotoview="map">
          <div class="ds-welcome-card-icon">🌐</div>
          <div class="ds-welcome-card-title">Org Map</div>
          <div class="ds-welcome-card-desc">See all your connected Salesforce orgs in one visual view. Drag and link them.</div>
          <span class="ds-welcome-card-badge ds-badge-read">Read-only</span>
          ${activityBadge('map')}
        </div>
        <div class="ds-welcome-card" data-gotoview="schema">
          <div class="ds-welcome-card-icon">🕸</div>
          <div class="ds-welcome-card-title">Schema View</div>
          <div class="ds-welcome-card-desc">Visualize how objects relate to each other and which flows run on them.</div>
          <span class="ds-welcome-card-badge ds-badge-read">Read-only</span>
          ${activityBadge('schema')}
        </div>
        <div class="ds-welcome-card" data-gotoview="readiness">
          <div class="ds-welcome-card-icon">🛡</div>
          <div class="ds-welcome-card-title">Deploy Readiness</div>
          <div class="ds-welcome-card-desc">Compare schemas between orgs — spot missing fields, picklist gaps, and validation rules before a load fails.</div>
          <span class="ds-welcome-card-badge ds-badge-read">Read-only</span>
          ${activityBadge('readiness')}
        </div>
        <div class="ds-welcome-card" data-gotoview="scans">
          <div class="ds-welcome-card-icon">🔍</div>
          <div class="ds-welcome-card-title">Scan Map</div>
          <div class="ds-welcome-card-desc">Schedule record count comparisons across orgs and get alerted on drift.</div>
          <span class="ds-welcome-card-badge ds-badge-read">Read-only</span>
          ${activityBadge('scans')}
        </div>
        <div class="ds-welcome-card" data-gotoview="profiles">
          <div class="ds-welcome-card-icon">📦</div>
          <div class="ds-welcome-card-title">Data Deployment</div>
          <div class="ds-welcome-card-desc">Define deployment profiles (objects, orgs, mappings) and run transfers between orgs.</div>
          <span class="ds-welcome-card-badge ds-badge-write">Writes records</span>
          ${activityBadge('transfer')}
        </div>
      </div>

      <div class="ds-welcome-trust">
        <span class="ds-welcome-trust-icon">🔒</span>
        <span>All operations run <strong>locally in your browser</strong>. No data is ever sent to external servers. Scan, Schema View, and Deploy Readiness are completely read-only.</span>
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
  // Reset map interaction state when leaving the map
  if (_currentView === 'map' && view !== 'map') {
    _mapState.selectedNode = null;
  }

  // Home (map) = full-width, no sidebar.
  // Every other view = sidebar visible.
  const body = document.querySelector('.ds-body');
  if (body) body.classList.toggle('ds-home', view === 'map');

  // Record activity for the welcome screen tiles
  recordActivity(view);

  switch (view) {
    case 'map':      renderOrgMap();     break;
    case 'orgs':     renderOrgsPanel();  break;
    case 'profiles': renderProfiles();   break;
    case 'transfer': renderTransfer();   break;
    case 'schedule': renderSchedule();   break;
    case 'history':  renderHistory();    break;
    case 'scans':     renderScanMap();      break;
    case 'readiness': renderReadiness();   break;
    case 'schema':    renderSchemaView();  break;
  }
}

// ════════════════════════════════════════════════════════════════
// CONNECTED ORGS PANEL (Gearset / SF CLI style)
// ════════════════════════════════════════════════════════════════
function renderOrgsPanel() {
  // Include stored SOAP orgs so they always show even when not open in a tab
  const storedUrls = _storedOrgs.map(o => o.url).filter(Boolean);
  const allOrgUrls = [
    ...new Set([
      ..._allSessions.map(s => s.orgUrl),
      ...(_orgUrl ? [_orgUrl] : []),
      ...Object.keys(_orgs),
      ...storedUrls
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
    const storedOrg  = _storedOrgs.find(o => o.url === url);
    const hasCreds   = !!(storedOrg?.username);

    return `
      <div class="ds-org-row ${isCurrent ? 'ds-org-row--active' : ''}">
        <div class="ds-org-row-icon">${isOnline ? '🟢' : '⚫'}</div>
        <div class="ds-org-row-info">
          <div class="ds-org-row-label">
            ${esc(label)}
            ${isCurrent ? '<span class="ds-org-badge-current" style="margin-left:6px">current tab</span>' : ''}
            ${hasCreds ? `<span style="margin-left:6px;font-size:10px;background:#F0F9FF;border:1px solid #BAE6FD;
              border-radius:4px;padding:1px 5px;color:#0369A1">🔐 credentials</span>` : ''}
          </div>
          <div class="ds-org-row-url">${esc(host)}</div>
          <div class="ds-org-row-meta">
            ${hasCreds ? `${esc(storedOrg.username)} · ` : ''}Last seen ${lastSeen}
            · ${syncCount} transfer${syncCount !== 1 ? 's' : ''} logged
          </div>
        </div>
        <div class="ds-org-row-status ${isOnline ? 'ds-org-row-status--online' : 'ds-org-row-status--offline'}">
          ${isOnline ? '● Connected' : '○ Not open'}
        </div>
        <div class="ds-org-row-actions">
          <button class="ds-btn ds-btn-sm" data-dsaction="editOrgLabel" data-arg="${esc(url)}">✏ Rename</button>
          ${isOnline
            ? `<button class="ds-btn ds-btn-sm ds-btn-primary" data-dsaction="startTransferFrom" data-arg="${esc(url)}">🚀 Transfer</button>`
            : hasCreds
              ? `<button class="ds-btn ds-btn-sm" data-dsaction="reconnectOrgFromPanel" data-arg="${esc(storedOrg.id)}">🔄 Reconnect</button>
                 <button class="ds-btn ds-btn-sm ds-btn-danger" data-dsaction="removeOrg" data-arg="${esc(url)}">✕</button>`
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
      <button class="ds-btn ds-btn-primary" id="dsAddOrgBtn">+ Add Org</button>
    </div>

    <div style="background:#E8F4FD;border:1px solid #C5DBF0;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:12px;color:#014486;max-width:820px">
      <strong>💡 How it works:</strong> The Studio auto-detects any Salesforce org you have open in a Chrome tab.
      Open an org in Chrome, then click <em>Refresh</em> below to add it. No Connected App or passwords required —
      your existing browser session is used securely.
    </div>

    <div style="display:flex;gap:8px;margin-bottom:16px;max-width:820px;flex-wrap:wrap">
      <button class="ds-btn ds-btn-primary" id="dsRefreshOrgsBtn">🔄 Refresh from open tabs</button>
      <button class="ds-btn ds-btn-primary" id="dsConnectCredsBtn">🔐 Connect with Credentials</button>
      <button class="ds-btn" data-dsaction="showAddOrgHelp">📖 Help</button>
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

  eid('dsAddOrgBtn')?.addEventListener('click', showAddOrgHelp);
  eid('dsConnectCredsBtn')?.addEventListener('click', showAddOrgModal);
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

function showAddOrgHelp() {
  showModal(`
    <div class="ds-modal-header">🔌 Add a Salesforce Org</div>
    <div class="ds-modal-body">
      <div class="ds-add-org-steps">
        <div class="ds-add-org-step">
          <div class="ds-step-num">1</div>
          <div class="ds-step-body">
            <div class="ds-step-title">Open the org in Chrome</div>
            <div class="ds-step-desc">Navigate to your Salesforce org (e.g. <code>https://myorg.my.salesforce.com</code>) in any Chrome tab and log in.</div>
          </div>
        </div>
        <div class="ds-add-org-step">
          <div class="ds-step-num">2</div>
          <div class="ds-step-body">
            <div class="ds-step-title">Click "Refresh from open tabs"</div>
            <div class="ds-step-desc">The Studio scans all open Chrome tabs for Salesforce sessions and adds any new orgs automatically.</div>
          </div>
        </div>
        <div class="ds-add-org-step">
          <div class="ds-step-num">3</div>
          <div class="ds-step-body">
            <div class="ds-step-title">Give it a nickname (optional)</div>
            <div class="ds-step-desc">Click <strong>Rename</strong> on the org card to give it a friendly label like "Production" or "QA Sandbox".</div>
          </div>
        </div>
      </div>
      <div style="margin-top:14px;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:12px">
        <strong>🔐 Security note:</strong> This extension only uses your existing browser session cookie — the same
        one Salesforce itself uses. No credentials are stored or transmitted to any external service.
        Sessions expire naturally when you log out of Salesforce.
      </div>
    </div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Got it</button>
    </div>`);
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

const NODE_W = 190, NODE_H = 74;
const ORG_TYPE_COLORS = {
  production: '#0176D3',
  sandbox:    '#2E844A',
  dev:        '#DD7A01',
  scratch:    '#706E6B',
};
const ORG_TYPE_LABELS = {
  production: 'PROD',
  sandbox:    'SBX',
  dev:        'DEV',
  scratch:    'SCR',
};
const ORG_TYPE_OPTIONS = [
  { value: 'production', label: 'Production' },
  { value: 'sandbox',    label: 'Sandbox' },
  { value: 'dev',        label: 'Developer Sandbox' },
  { value: 'scratch',    label: 'Scratch Org' },
];

// Build a unified list of all known orgs (stored + browser-detected)
function allMapOrgs() {
  const map = new Map();

  // Helper: stable ID for a URL-based auto-org
  function autoId(url) {
    return 'auto_' + btoa(url).replace(/[^a-z0-9]/gi,'').slice(0,12);
  }

  // 1. Stored orgs (SOAP-authenticated, have position + type data)
  for (const o of _storedOrgs) map.set(o.id, o);

  // 2. All known orgs from the sftk_orgs dict (same source as Connected Orgs panel)
  //    This includes every org the user has ever opened in Chrome, persisted across sessions.
  for (const [url, data] of Object.entries(_orgs)) {
    const existing = [...map.values()].find(o => o.url === url);
    if (!existing) {
      const id = autoId(url);
      if (!map.has(id)) {
        map.set(id, {
          id, url, label: data.label || orgLabel(url),
          type: 'production', position: null, auto: true
        });
      }
    }
  }

  // 3. Current browser sessions — ensure anything open right now is included
  //    even if it hasn't been seen before (e.g. freshly logged-in org)
  const liveUrls = [
    ...(_orgUrl ? [_orgUrl] : []),
    ..._allSessions.map(s => s.orgUrl)
  ];
  for (const url of liveUrls) {
    const existing = [...map.values()].find(o => o.url === url);
    if (!existing) {
      const id = autoId(url);
      if (!map.has(id)) {
        map.set(id, {
          id, url, label: orgLabel(url),
          type: 'production', position: null, auto: true
        });
      }
    }
  }

  return [...map.values()];
}

function orgIsOnline(org) {
  if (org.url === _orgUrl) return true;
  return _allSessions.some(s => s.orgUrl === org.url);
}

// Auto-arrange orgs into a neat grid if they have no saved positions.
// Orgs that already have a saved position keep it; new ones fill in the
// next available grid slot — skipping cells already occupied.
function ensurePositions(orgs) {
  const cols   = Math.max(1, Math.ceil(Math.sqrt(orgs.length)));
  const gapX   = 80, gapY = 60, startX = 80, startY = 80;
  const stepX  = NODE_W + gapX;
  const stepY  = NODE_H + gapY;

  // Build set of occupied slots (from already-positioned orgs)
  const occupied = new Set();
  for (const o of orgs) {
    if (o.position) {
      // Snap to nearest grid cell to find its slot
      const col = Math.round((o.position.x - startX) / stepX);
      const row = Math.round((o.position.y - startY) / stepY);
      occupied.add(`${col},${row}`);
    }
  }

  // Assign unpositioned orgs to the next free slot
  let slot = 0;
  for (const o of orgs) {
    if (!o.position) {
      // Find next unoccupied slot
      while (true) {
        const col = slot % cols;
        const row = Math.floor(slot / cols);
        slot++;
        if (!occupied.has(`${col},${row}`)) {
          occupied.add(`${col},${row}`);
          o.position = { x: startX + col * stepX, y: startY + row * stepY };
          break;
        }
      }
    }
  }
}

async function renderOrgMap() {
  const orgs = allMapOrgs();
  ensurePositions(orgs);
  // Pull the freshest snapshots into _snapshotsCache so the drift overlay
  // on schedule edges can render synchronously below.
  await refreshSnapshotsCache();

  const main = eid('dsMain');
  if (!main) return;
  main.style.padding = '0';
  main.style.overflow = 'hidden';

  main.innerHTML = `
    <div class="ds-map-wrap">
      <div class="ds-map-toolbar">
        <span class="ds-map-toolbar-title">🌐 Org Map</span>
        <span class="ds-map-toolbar-hint" id="dsMapHint">Drag nodes to reposition · click to select</span>
        <button class="ds-btn ds-btn-sm" id="dsMapScheduleBtn"
          title="Connections on this map represent real scheduled transfers — add one here">📅 Schedule Transfer</button>
        <button class="ds-btn ds-btn-sm" id="dsMapLayoutBtn">⊞ Auto Layout</button>
        <button class="ds-btn ds-btn-sm ds-btn-primary" id="dsMapAddOrgBtn">+ Add Org</button>
      </div>

      <!-- Quick-launch tiles — visible only on home (no sidebar) -->
      <div class="ds-home-tiles-bar">
        <div class="ds-home-section-title">Data</div>
        <div class="ds-home-grid">
          <div class="ds-home-tile" data-goto="profiles"><span class="ds-home-tile-icon">📦</span><span class="ds-home-tile-name">Data Deployment</span><span class="ds-home-tile-desc">Profiles + run transfer</span></div>
          <div class="ds-home-tile" data-goto="schedule"><span class="ds-home-tile-icon">📅</span><span class="ds-home-tile-name">Schedule</span><span class="ds-home-tile-desc">Automate transfers</span></div>
          <div class="ds-home-tile" data-goto="history"><span class="ds-home-tile-icon">📜</span><span class="ds-home-tile-name">History</span><span class="ds-home-tile-desc">Past transfer runs</span></div>
        </div>
        <div class="ds-home-section-title">Inspect</div>
        <div class="ds-home-grid">
          <div class="ds-home-tile" data-goto="scans"><span class="ds-home-tile-icon">🔍</span><span class="ds-home-tile-name">Scan Map</span><span class="ds-home-tile-desc">Compare record counts</span></div>
          <div class="ds-home-tile" data-goto="readiness"><span class="ds-home-tile-icon">🛡</span><span class="ds-home-tile-name">Deploy Readiness</span><span class="ds-home-tile-desc">Schema compatibility</span></div>
          <div class="ds-home-tile" data-goto="schema"><span class="ds-home-tile-icon">🕸</span><span class="ds-home-tile-name">Schema View</span><span class="ds-home-tile-desc">Flow &amp; object graph</span></div>
          <div class="ds-home-tile" data-goto="orgs"><span class="ds-home-tile-icon">🔌</span><span class="ds-home-tile-name">Connected Orgs</span><span class="ds-home-tile-desc">Manage connections</span></div>
        </div>
      </div>

      <div class="ds-map-canvas-wrap" id="dsMapCanvas">
        <svg id="dsMapSvg" class="ds-map-svg"
          xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
          <defs>
            <marker id="arrowPush" markerWidth="9" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0,9 3,0 6" fill="#0176D3"/>
            </marker>
            <marker id="arrowScan" markerWidth="9" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0,9 3,0 6" fill="#DD7A01"/>
            </marker>
            <!-- Reverse markers for bidirectional connections (auto-start-reverse flips at path start) -->
            <marker id="arrowPushRev" markerWidth="9" markerHeight="6" refX="8" refY="3" orient="auto-start-reverse">
              <polygon points="0 0,9 3,0 6" fill="#0176D3"/>
            </marker>
            <marker id="arrowScanRev" markerWidth="9" markerHeight="6" refX="8" refY="3" orient="auto-start-reverse">
              <polygon points="0 0,9 3,0 6" fill="#DD7A01"/>
            </marker>
            <!-- Schedule transfer edges -->
            <marker id="arrowSched" markerWidth="9" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0,9 3,0 6" fill="#7c5ce0"/>
            </marker>
          </defs>
          <g id="dsMapRoot" transform="translate(0,0)">
            <g id="dsLaneLayer"></g>
            <g id="dsEdgeLayer"></g>
            <g id="dsNodeLayer"></g>
          </g>
        </svg>

        ${orgs.length === 0 ? `
          <div class="ds-map-empty-canvas">
            <div class="ds-map-empty-icon">🌐</div>
            <div class="ds-map-empty-title">No orgs on the map yet</div>
            <div class="ds-map-empty-sub">Click <strong>+ Add Org</strong> to connect your first org</div>
          </div>` : ''}

        <div id="dsMapDetail" style="display:none" class="ds-map-detail"></div>
      </div>
    </div>`;

  drawMapNodes(orgs);
  drawMapEdges(orgs);
  initMapInteractions(orgs);

  // Wire home tile navigation
  document.querySelectorAll('.ds-home-tile[data-goto]').forEach(tile => {
    tile.addEventListener('click', () => {
      const view = tile.dataset.goto;
      document.querySelectorAll('.ds-nav-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.view === view));
      _currentView = view;
      renderView(view);
    });
  });

  eid('dsMapAddOrgBtn')?.addEventListener('click', showAddOrgModal);
  eid('dsMapLayoutBtn')?.addEventListener('click', () => {
    const os = allMapOrgs();
    os.forEach(o => { o.position = null; });
    ensurePositions(os);
    // Persist updated positions for stored orgs
    _storedOrgs = _storedOrgs.map(so => {
      const found = os.find(o => o.id === so.id);
      return found ? { ...so, position: found.position } : so;
    });
    saveStoredOrgs();
    drawMapLanes(os);   // Feature 13
    drawMapNodes(os);
    drawMapEdges(os);
    initMapInteractions(os);
  });
  eid('dsMapScheduleBtn')?.addEventListener('click', () => openScheduleTransferModal());
}

// Feature 12: Compute transfer health stats for an org URL
function orgHealthStats(orgUrl) {
  if (!orgUrl) return null;
  const runs = _history.filter(h => h.srcOrgUrl === orgUrl || h.tgtOrgUrl === orgUrl);
  if (!runs.length) return null;
  const latest = [...runs].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))[0];
  return { count: runs.length, lastAt: latest.startedAt, lastStatus: latest.status };
}

// Feature 13: Environment grouping lanes — colored SVG rect backgrounds per org type
const LANE_COLORS = {
  production: { fill: '#EFF6FF', stroke: '#BFDBFE', label: 'Production' },
  sandbox:    { fill: '#F0FDF4', stroke: '#BBF7D0', label: 'Sandbox' },
  devhub:     { fill: '#FDF4FF', stroke: '#E9D5FF', label: 'Developer Hub' },
  scratch:    { fill: '#FFFBEB', stroke: '#FDE68A', label: 'Scratch' },
  developer:  { fill: '#FEF9C3', stroke: '#FDE047', label: 'Developer' },
};
const LANE_PAD = 20;

function drawMapLanes(orgs) {
  const layer = eid('dsLaneLayer');
  if (!layer) return;

  if (!orgs.length) { layer.innerHTML = ''; return; }

  // Group orgs by type
  const byType = {};
  for (const org of orgs) {
    const t = org.type || 'production';
    if (!byType[t]) byType[t] = [];
    byType[t].push(org);
  }

  let html = '';
  for (const [type, group] of Object.entries(byType)) {
    // Only draw lane if 2+ orgs of same type OR if at least one org is offline (to help differentiate)
    if (group.length < 1) continue;
    const theme = LANE_COLORS[type] || LANE_COLORS.production;

    // Compute bounding box of this group
    const xs = group.map(o => o.position?.x ?? 80);
    const ys = group.map(o => o.position?.y ?? 80);
    const minX = Math.min(...xs) - LANE_PAD;
    const minY = Math.min(...ys) - LANE_PAD;
    const maxX = Math.max(...xs) + NODE_W + LANE_PAD;
    const maxY = Math.max(...ys) + NODE_H + LANE_PAD + 14; // +14 for health row
    const w = maxX - minX;
    const h = maxY - minY;

    html += `
      <rect x="${minX}" y="${minY}" width="${w}" height="${h}" rx="14"
            fill="${theme.fill}" stroke="${theme.stroke}" stroke-width="1.5"
            opacity="0.65"/>
      <text x="${minX + 10}" y="${minY + 16}" font-size="10" font-weight="700"
            fill="${theme.stroke.replace('F','')}88" font-family="system-ui,sans-serif"
            opacity="0.75">${esc(theme.label)}</text>`;
  }
  layer.innerHTML = html;
}

function drawMapNodes(orgs) {
  const layer = eid('dsNodeLayer');
  if (!layer) return;

  layer.innerHTML = orgs.map(org => {
    const { x, y } = org.position || { x: 80, y: 80 };
    const online  = orgIsOnline(org);
    const color     = ORG_TYPE_COLORS[org.type || 'production'] || '#0176D3';
    const dotFill   = online ? '#2E844A' : '#AEAEAC';
    const typeLabel = ORG_TYPE_LABELS[org.type] || 'PROD';
    const label   = esc((org.label || '').substring(0, 22));
    const urlText = esc((org.url || '').replace('https://','').replace('.my.salesforce.com','').substring(0, 28));
    const isSel   = _mapState.selectedNode === org.id;
    const stroke  = isSel ? '#0176D3' : '#DDDBDA';
    const sw      = isSel ? 2.5 : 1.5;

    // Feature 12: health stats
    const health   = orgHealthStats(org.url);
    const healthH  = health ? 14 : 0;   // extra height for health row
    const nodeH    = NODE_H + healthH;
    const healthHtml = health ? `
      <line x1="6" y1="${NODE_H}" x2="${NODE_W}" y2="${NODE_H}" stroke="#E5E4E2" stroke-width="1"/>
      <text x="12" y="${NODE_H + 10}" font-size="9" fill="#2E844A" font-family="system-ui,sans-serif">
        ✓ ${health.count} transfer${health.count !== 1 ? 's' : ''} · ${timeAgo(health.lastAt)}
      </text>` : '';

    return `<g class="ds-map-node${isSel?' ds-node-selected':''}" data-id="${org.id}"
               transform="translate(${x},${y})" style="cursor:grab">
      <rect class="ds-node-rect" width="${NODE_W}" height="${nodeH}" rx="10"
            stroke="${stroke}" stroke-width="${sw}"
            filter="url(#ds_shadow_${org.id})"/>
      <defs>
        <filter id="ds_shadow_${org.id}" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="${isSel?4:2}" stdDeviation="${isSel?8:3}"
            flood-opacity="${isSel?0.22:0.10}"/>
        </filter>
      </defs>
      <rect width="6" height="${nodeH}" rx="3" fill="${color}"/>
      <circle cx="22" cy="22" r="5" fill="${dotFill}"/>
      <text x="34" y="26" font-size="13" font-weight="700" class="ds-node-label-text"
            font-family="system-ui,sans-serif">${label}</text>
      <text x="22" y="46" font-size="10" class="ds-node-url-text"
            font-family="system-ui,sans-serif">${urlText}</text>
      ${healthHtml}
      <!-- Clickable type badge -->
      <g class="ds-node-type-badge" data-type-btn="${org.id}" style="cursor:pointer">
        <rect x="${NODE_W-46}" y="${NODE_H-20}" width="40" height="15" rx="4"
              fill="${color}22" stroke="${color}55" stroke-width="1"/>
        <text x="${NODE_W-26}" y="${NODE_H-9}" font-size="9" fill="${color}" font-weight="700"
              text-anchor="middle" font-family="system-ui,sans-serif">${typeLabel}</text>
        <!-- Invisible larger hit area -->
        <rect x="${NODE_W-50}" y="${NODE_H-24}" width="48" height="22" rx="4"
              fill="transparent"/>
      </g>
    </g>`;
  }).join('');

  // Wire type badge click handlers directly (SVG delegation is unreliable)
  layer.querySelectorAll('[data-type-btn]').forEach(badge => {
    // Stop pointerdown from bubbling to the node <g> handler, which calls
    // selectNode() → drawMapNodes() → replaces innerHTML → kills the click listener
    // before it ever fires.
    badge.addEventListener('pointerdown', e => {
      e.stopPropagation();
    });
    badge.addEventListener('click', e => {
      e.stopPropagation();
      showOrgTypeDropdown(badge.dataset.typeBtn, badge, allMapOrgs());
    });
  });
}

function showOrgTypeDropdown(orgId, badgeEl, orgs) {
  // Close any existing type dropdown
  document.getElementById('dsTypeDropdown')?.remove();

  const org = orgs.find(o => o.id === orgId);
  if (!org) return;

  const rect = badgeEl.getBoundingClientRect();
  const dd   = document.createElement('div');
  dd.id        = 'dsTypeDropdown';
  dd.className = 'ds-type-dropdown';
  dd.style.cssText = `top:${rect.bottom + 4}px;left:${rect.left - 40}px`;

  const hdr = document.createElement('div');
  hdr.className = 'ds-type-dd-hdr';
  hdr.textContent = 'ORG TYPE';
  dd.appendChild(hdr);

  ORG_TYPE_OPTIONS.forEach(opt => {
    const isCurrent = (org.type || 'production') === opt.value;
    const item = document.createElement('button');
    item.className = 'ds-type-dd-item' + (isCurrent ? ' ds-type-dd-item-active' : '');
    const dot = document.createElement('span');
    dot.className = 'ds-type-dd-dot';
    dot.style.background = ORG_TYPE_COLORS[opt.value];
    item.appendChild(dot);
    item.appendChild(document.createTextNode(opt.label));
    if (isCurrent) {
      const chk = document.createElement('span');
      chk.className = 'ds-type-dd-check';
      chk.textContent = '✓';
      item.appendChild(chk);
    }

    item.addEventListener('click', async ev => {
      ev.stopPropagation();
      dd.remove();

      // Update stored org if it exists; otherwise pin the auto-detected org
      const stored = _storedOrgs.find(o => o.id === orgId);
      if (stored) {
        stored.type = opt.value;
      } else {
        // Promote auto-detected org to stored with the new type (no credentials)
        _storedOrgs.push({ ...org, type: opt.value, auto: false });
      }
      await saveStoredOrgs();
      renderOrgMap();
    });
    dd.appendChild(item);
  });

  document.body.appendChild(dd);

  function closeTypeDropdown(ev) {
    if (!dd.contains(ev.target)) {
      dd.remove();
      document.removeEventListener('click', closeTypeDropdown, true);
    }
  }
  setTimeout(() => document.addEventListener('click', closeTypeDropdown, true), 0);
}

function drawMapEdges(orgs) {
  const layer = eid('dsEdgeLayer');
  if (!layer) return;
  const posMap  = {};
  const orgByUrl = {};
  for (const o of orgs) { posMap[o.id] = o.position || { x: 80, y: 80 }; orgByUrl[o.url] = o; }

  // ── Helper: compute a curved path between two org positions ──
  function edgePath(sId, tId, yOff = 0) {
    const sp = posMap[sId], tp = posMap[tId];
    if (!sp || !tp) return null;
    const sx = sp.x + NODE_W, sy = sp.y + NODE_H / 2 + yOff;
    const tx = tp.x,          ty = tp.y + NODE_H / 2 + yOff;
    const cx1 = sx + (tx - sx) * 0.55, cy1 = sy;
    const cx2 = sx + (tx - sx) * 0.45, cy2 = ty;
    const midX = (sx + tx) / 2, midY = (sy + ty) / 2;
    return { sx, sy, tx, ty, cx1, cy1, cx2, cy2, midX, midY,
             d: `M ${sx} ${sy} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${tx} ${ty}` };
  }

  // ── Schedule-derived edges (from profiles with schedule.enabled) ──
  // These are the ONLY edges on the map now. (Manual `_connections[]` are
  // retained in storage for backward compat but no longer rendered — they
  // had no functional consequence and just confused users.)
  const schedEdges = _profiles
    .filter(p => p.schedule?.enabled)
    .map(p => {
      const srcOrg = orgByUrl[p.schedule.sourceOrg];
      const tgtOrg = orgByUrl[p.schedule.targetOrg];
      if (!srcOrg || !tgtOrg) return null;
      const lastRun = _history
        .filter(h => h.profileId === p.id && h.scheduledRun)
        .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))[0];
      return { profile: p, srcOrg, tgtOrg, lastRun };
    })
    .filter(Boolean);

  // Drift palette — matches snapshotDriftColor labels.
  const DRIFT_FILLS = { green: '#16a34a', yellow: '#ca8a04', orange: '#ea580c', red: '#dc2626' };

  const schedHtml = schedEdges.map(({ profile, srcOrg, tgtOrg, lastRun }, i) => {
    // Center the edge — manual connections were removed in Architecture A,
    // so there's nothing on the same lane to dodge.
    const e = edgePath(srcOrg.id, tgtOrg.id, 0);
    if (!e) return '';

    const iv    = profile.schedule.intervalMinutes;
    const ivLbl = iv >= 1440 ? 'daily' : iv >= 60 ? `${iv/60}h` : `${iv}m`;
    const lastRunText  = lastRun ? timeAgo(lastRun.startedAt) : 'never run';
    const lastRunColor = lastRun?.status === 'success' ? '#2E844A' : lastRun ? '#EA001E' : '#AEAEAC';
    const mid = e.midY - 18;

    // ── Phase 2: drift chip ───────────────────────────────────────────
    // Aggregate match ratio across every objectType in the profile tree
    // where both orgs have a snapshot. matchRatio===null → no data yet.
    const drift = aggregateProfileDrift(profile);
    let chipFill, chipText, chipTitle;
    if (drift.matchRatio == null) {
      chipFill  = '#6b7280';
      chipText  = '📸 no snapshot yet';
      chipTitle = drift.totalObjects
        ? `${drift.totalObjects} object(s) in profile · run a transfer or click 📸 Snapshot now on either org to build the diff`
        : 'profile has no objects to snapshot';
    } else if (drift.schemaMismatch) {
      chipFill  = DRIFT_FILLS.orange;
      chipText  = '⚠ schema drift';
      chipTitle = 'compareFields differ between the two snapshots — re-capture both with the same scanConfig';
    } else {
      const pct  = Math.round(drift.matchRatio * 100);
      const band = snapshotDriftColor(drift.matchRatio);
      chipFill  = DRIFT_FILLS[band.color];
      chipText  = `${band.color === 'green' ? '🟢' : band.color === 'yellow' ? '🟡' : band.color === 'orange' ? '🟠' : '🔴'} ${pct}% match`;
      chipTitle = `${drift.identical} identical · ${drift.drift} drift · ${drift.missingInB} missing in target · across ${drift.objectsCovered}/${drift.totalObjects} object(s)`;
    }
    // Chip width: ~7px per char + padding. Centered around midX. Sits BELOW the last-run line.
    const chipWidth  = Math.max(70, chipText.length * 6.6 + 16);
    const chipX      = e.midX - chipWidth / 2;
    const chipY      = mid + 30;

    return `<g class="ds-map-edge ds-sched-edge" data-sched-id="${profile.id}">
      <!-- Animated dashed path -->
      <path class="ds-sched-edge-path"
        d="${e.d}" fill="none" stroke="#7c5ce0" stroke-width="2.5"
        marker-end="url(#arrowSched)" opacity="0.9"/>
      <!-- Labels -->
      <text x="${e.midX}" y="${mid}" font-size="10" fill="#7c5ce0" text-anchor="middle"
        font-family="system-ui,sans-serif" font-weight="600" pointer-events="none">📅 ${esc(profile.name)}</text>
      <text x="${e.midX}" y="${mid+12}" font-size="9" fill="#7c5ce0" text-anchor="middle"
        font-family="system-ui,sans-serif" pointer-events="none" opacity="0.75">every ${esc(ivLbl)}</text>
      <text x="${e.midX}" y="${mid+23}" font-size="9" fill="${lastRunColor}" text-anchor="middle"
        font-family="system-ui,sans-serif" pointer-events="none" opacity="0.85">${esc(lastRunText)}</text>
      <!-- Drift chip -->
      <g class="ds-drift-chip" pointer-events="none">
        <title>${esc(chipTitle)}</title>
        <rect x="${chipX}" y="${chipY}" width="${chipWidth}" height="16" rx="8" ry="8"
          fill="${chipFill}" opacity="0.95"/>
        <text x="${e.midX}" y="${chipY + 11}" font-size="9.5" fill="#ffffff" text-anchor="middle"
          font-family="system-ui,sans-serif" font-weight="600">${esc(chipText)}</text>
      </g>
      <!-- Transparent wide hit path for easy clicking -->
      <path d="${e.d}" fill="none" stroke="transparent" stroke-width="20"
        style="cursor:pointer" data-sched-click="${profile.id}"/>
    </g>`;
  }).join('');

  layer.innerHTML = schedHtml;

  // Wire schedule edge click → show schedule detail panel
  layer.querySelectorAll('[data-sched-click]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      showScheduleEdgeDetail(el.dataset.schedClick, orgs);
    });
  });
}

// Show a detail panel for a scheduled transfer edge when clicked on the map.
function showScheduleEdgeDetail(profileId, orgs) {
  const profile = _profiles.find(p => p.id === profileId);
  if (!profile?.schedule) return;

  const iv       = profile.schedule.intervalMinutes;
  const ivLbl    = iv >= 1440 ? 'every day' : iv >= 60 ? `every ${iv/60}h` : `every ${iv}m`;
  const srcLabel = orgLabel(profile.schedule.sourceOrg);
  const tgtLabel = orgLabel(profile.schedule.targetOrg);
  const lastRuns = _history
    .filter(h => h.profileId === profileId && h.scheduledRun)
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
    .slice(0, 3);

  const detail = eid('dsMapDetail');
  if (!detail) return;
  detail.style.display = '';

  // Per-object drift table — pulls from _snapshotsCache, no I/O.
  const treeTypes = [...collectTreeObjects(profile.tree)];
  const srcSnaps  = _snapshotsCache[profile.schedule.sourceOrg] || {};
  const tgtSnaps  = _snapshotsCache[profile.schedule.targetOrg] || {};
  const driftRows = treeTypes.map(t => {
    const a = srcSnaps[t], b = tgtSnaps[t];
    if (!a || !b) {
      return `<div class="ds-drift-row ds-drift-row-empty">
        <span class="ds-drift-row-obj">${esc(t)}</span>
        <span class="ds-drift-row-state">📸 no snapshot</span>
      </div>`;
    }
    const d = diffSnapshots(a, b);
    if (d.error || !d.fieldsMatch) {
      return `<div class="ds-drift-row ds-drift-row-warn">
        <span class="ds-drift-row-obj">${esc(t)}</span>
        <span class="ds-drift-row-state">⚠ ${esc(d.error || 'schema drift')}</span>
      </div>`;
    }
    const total = d.identical + d.drift + d.missingInB;
    const pct   = total > 0 ? Math.round(d.identical / total * 100) : 100;
    const band  = snapshotDriftColor(total > 0 ? d.identical / total : 1);
    const hasNonIdentical = (d.drift + d.missingInB + d.onlyInB) > 0;
    return `<div class="ds-drift-row ds-drift-row-${band.color} ${hasNonIdentical ? 'ds-drift-row-clickable' : ''}"
        ${hasNonIdentical ? `data-dsaction="showDriftRecords" data-arg="${esc(profileId)}|${esc(t)}" title="Click to see specific drifting records"` : ''}>
      <span class="ds-drift-row-obj">${esc(t)}</span>
      <span class="ds-drift-row-pct">${pct}%</span>
      <span class="ds-drift-row-meta">${d.identical} ✓ · ${d.drift} drift · ${d.missingInB} missing${d.onlyInB ? ` · ${d.onlyInB} extra` : ''}</span>
    </div>`;
  }).join('');

  detail.innerHTML = `
    <div class="ds-map-detail-hdr">
      <span>📅</span>
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#7c5ce0;font-weight:700">${esc(profile.name)}</span>
      <button class="ds-btn ds-btn-xs" data-dsaction="closeMapDetail">✕</button>
    </div>
    <div class="ds-map-detail-body">
      <div style="font-size:11px;margin-bottom:6px">
        <strong>${esc(srcLabel)}</strong> → <strong>${esc(tgtLabel)}</strong>
      </div>
      <div style="font-size:11px;color:var(--subtext)">Runs ${esc(ivLbl)} · <span style="color:#27ae60">● active</span>${profile.schedule.refreshSnapshotAfter ? ' · 📸 snapshot after each run' : ''}</div>

      <div class="ds-drift-table-hdr">Drift by object</div>
      <div class="ds-drift-table">${driftRows || '<div style="font-size:11px;color:var(--subtext)">No objects in profile tree</div>'}</div>

      ${lastRuns.length ? `
        <div style="margin-top:8px;font-size:11px;font-weight:600;color:var(--subtext)">Recent runs</div>
        ${lastRuns.map(h => {
          const ok = h.status === 'success';
          return `<div style="font-size:10px;display:flex;gap:6px;margin-top:3px">
            <span>${ok ? '✅' : '❌'}</span>
            <span style="color:var(--subtext)">${timeAgo(h.startedAt)}</span>
            ${h.recordsInserted != null ? `<span>${h.recordsInserted} records</span>` : ''}
          </div>`;
        }).join('')}` : `<div style="font-size:11px;color:var(--subtext);margin-top:6px">No runs yet</div>`}
    </div>
    <div class="ds-map-detail-actions">
      <button class="ds-btn ds-btn-xs ds-btn-danger" id="dsMapSchedDisable">⏹ Disable</button>
      <button class="ds-btn ds-btn-xs" id="dsMapSchedSnap" title="Capture fresh snapshots on both orgs for every object in this profile tree, then redraw">📸 Refresh snapshots</button>
      <button class="ds-btn ds-btn-xs ds-btn-primary" id="dsMapSchedGo">📅 Schedule tab</button>
    </div>`;

  eid('dsMapSchedSnap')?.addEventListener('click', async () => {
    const orgsNow = allMapOrgs();
    const srcOrg  = orgsNow.find(o => o.url === profile.schedule.sourceOrg);
    const tgtOrg  = orgsNow.find(o => o.url === profile.schedule.targetOrg);
    if (srcOrg) await window.snapshotOrgNow(srcOrg.id);
    if (tgtOrg) await window.snapshotOrgNow(tgtOrg.id);
    // Re-render the detail panel with fresh data
    showScheduleEdgeDetail(profileId, orgsNow);
  });

  eid('dsMapSchedDisable')?.addEventListener('click', async () => {
    window.disableSchedule?.(profileId);
    detail.style.display = 'none';
    drawMapEdges(orgs);
  });
  eid('dsMapSchedGo')?.addEventListener('click', () => {
    document.querySelectorAll('.ds-nav-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.view === 'schedule'));
    _currentView = 'schedule';
    renderView('schedule');
  });
}

function initMapInteractions(orgs) {
  const canvas = eid('dsMapCanvas');
  const svg    = eid('dsMapSvg');
  const root   = eid('dsMapRoot');
  if (!canvas || !svg || !root) return;

  const posMap = {};
  for (const o of orgs) posMap[o.id] = o.position || { x: 80, y: 80 };

  let dragOrg = null, dragOffX = 0, dragOffY = 0;
  let panStart = null;

  function svgPoint(e) {
    const rect = svg.getBoundingClientRect();
    return { x: e.clientX - rect.left - _mapState.translate.x,
             y: e.clientY - rect.top  - _mapState.translate.y };
  }

  // ── Node pointer events ────────────────────────────────────
  eid('dsNodeLayer')?.querySelectorAll('.ds-map-node').forEach(g => {
    const orgId = g.dataset.id;

    g.addEventListener('pointerdown', e => {
      e.stopPropagation();
      g.setPointerCapture(e.pointerId);
      const pt = svgPoint(e);
      const pos = posMap[orgId] || { x: 0, y: 0 };
      dragOrg  = orgId;
      dragOffX = pt.x - pos.x;
      dragOffY = pt.y - pos.y;
      selectNode(orgId, orgs);
    });

    g.addEventListener('pointermove', e => {
      if (dragOrg !== orgId) return;
      const pt = svgPoint(e);
      const nx = Math.max(0, pt.x - dragOffX);
      const ny = Math.max(0, pt.y - dragOffY);
      posMap[orgId] = { x: nx, y: ny };
      g.setAttribute('transform', `translate(${nx},${ny})`);
      drawMapEdges(orgs.map(o => o.id === orgId ? { ...o, position: posMap[o.id] } : { ...o, position: posMap[o.id] }));
    });

    g.addEventListener('pointerup', () => {
      if (dragOrg !== orgId) return;
      dragOrg = null;
      // Persist position
      const stored = _storedOrgs.find(o => o.id === orgId);
      if (stored) { stored.position = posMap[orgId]; saveStoredOrgs(); }
      // For auto-detected orgs, update our transient posMap
      const ao = orgs.find(o => o.id === orgId);
      if (ao) ao.position = posMap[orgId];
    });
  });

  // ── Background pan + zoom — attach ONCE per canvas instance ──
  // selectNode() → initMapInteractions() is called on every node click.
  // Guarding with a flag prevents canvas-level listeners from accumulating
  // (same root cause as the svRenderGraph exponential-listener freeze).
  if (!canvas._dsMapInteractionsInit) {
    canvas._dsMapInteractionsInit = true;

    canvas.addEventListener('pointerdown', e => {
      if (e.target !== canvas && e.target !== svg && e.target !== root) return;
      panStart = { mx: e.clientX, my: e.clientY, tx: _mapState.translate.x, ty: _mapState.translate.y };
      canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener('pointermove', e => {
      if (!panStart) return;
      const dx = e.clientX - panStart.mx;
      const dy = e.clientY - panStart.my;
      _mapState.translate = { x: panStart.tx + dx, y: panStart.ty + dy };
      root.setAttribute('transform', `translate(${_mapState.translate.x},${_mapState.translate.y})`);
    });

    canvas.addEventListener('pointerup', () => { panStart = null; });

    // ── Scroll to zoom (simple scale via viewBox) ──────────────
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      _mapState.translate.x -= e.deltaX * 0.5;
      _mapState.translate.y -= e.deltaY * 0.5;
      root.setAttribute('transform', `translate(${_mapState.translate.x},${_mapState.translate.y})`);
    }, { passive: false });
  }

  // Apply current translation
  root.setAttribute('transform', `translate(${_mapState.translate.x},${_mapState.translate.y})`);
}

function selectNode(orgId, orgs) {
  _mapState.selectedNode = orgId;
  const org = orgs.find(o => o.id === orgId);
  if (!org) return;

  // Re-render nodes to update selection styling
  drawMapNodes(orgs);
  initMapInteractions(orgs);

  // Show detail panel
  const online = orgIsOnline(org);
  const detail = eid('dsMapDetail');
  if (!detail) return;
  detail.style.display = '';
  // Find scheduled transfers involving this org
  const schedOut = _profiles.filter(p => p.schedule?.enabled && p.schedule.sourceOrg === org.url);
  const schedIn  = _profiles.filter(p => p.schedule?.enabled && p.schedule.targetOrg === org.url);
  const schedAll = [...schedOut, ...schedIn];

  const schedHtml = schedAll.length ? `
    <div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">
      <div style="font-size:10px;font-weight:700;color:#7c5ce0;letter-spacing:.4px;text-transform:uppercase;margin-bottom:4px">📅 Scheduled Transfers</div>
      ${schedOut.map(p => {
        const iv = p.schedule.intervalMinutes;
        const ivLbl = iv >= 1440 ? 'daily' : iv >= 60 ? `${iv/60}h` : `${iv}m`;
        return `<div style="font-size:10px;display:flex;align-items:center;gap:4px;margin-bottom:2px">
          <span style="color:#7c5ce0">→</span>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${esc(orgLabel(p.schedule.targetOrg))}</span>
          <span style="color:var(--subtext);white-space:nowrap">${esc(ivLbl)}</span>
        </div>`;
      }).join('')}
      ${schedIn.map(p => {
        const iv = p.schedule.intervalMinutes;
        const ivLbl = iv >= 1440 ? 'daily' : iv >= 60 ? `${iv/60}h` : `${iv}m`;
        return `<div style="font-size:10px;display:flex;align-items:center;gap:4px;margin-bottom:2px">
          <span style="color:#7c5ce0">←</span>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${esc(orgLabel(p.schedule.sourceOrg))}</span>
          <span style="color:var(--subtext);white-space:nowrap">${esc(ivLbl)}</span>
        </div>`;
      }).join('')}
    </div>` : '';

  detail.innerHTML = `
    <div class="ds-map-detail-hdr">
      <span style="color:${online?'#2E844A':'#AEAEAC'}">${online?'●':'○'}</span>
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(org.label || orgLabel(org.url))}</span>
      <button class="ds-btn ds-btn-xs" data-dsaction="closeMapDetail">✕</button>
    </div>
    <div class="ds-map-detail-body">
      <div class="ds-map-detail-url">${esc((org.url||'').replace('https://',''))}</div>
      <div><strong>Type:</strong> ${esc(org.type || 'production')}</div>
      ${org.username ? `<div><strong>User:</strong> ${esc(org.username)}</div>` : ''}
      ${online ? '<div style="color:#2E844A">● Session active</div>' : '<div style="color:#AEAEAC">○ Not open in Chrome</div>'}
      ${schedHtml}
    </div>
    <div class="ds-map-detail-actions">
      ${org.auto ? '' : `<button class="ds-btn ds-btn-xs" data-dsaction="editStoredOrg" data-arg="${orgId}">✏ Edit</button>`}
      <button class="ds-btn ds-btn-xs ds-btn-primary"
        data-dsaction="startTransferFromOrg" data-arg="${orgId}">🚀 Transfer</button>
      <button class="ds-btn ds-btn-xs" data-dsaction="scheduleFromOrg" data-arg="${orgId}">📅 Schedule</button>
      <button class="ds-btn ds-btn-xs" data-dsaction="snapshotNow" data-arg="${orgId}"
        title="Capture a fingerprint of every record (per object) on this org. Used by the drift overlay to compare against other orgs without re-querying live.">📸 Snapshot now</button>
      ${!online && !org.auto ? `<button class="ds-btn ds-btn-xs" data-dsaction="reconnectOrg" data-arg="${orgId}">🔄 Reconnect</button>` : ''}
      ${!org.auto ? `<button class="ds-btn ds-btn-xs ds-btn-danger" data-dsaction="removeStoredOrg" data-arg="${orgId}">🗑</button>` : ''}
    </div>`;
}

// ── Schedule Transfer modal (Architecture A) ────────────────────────────
//
// Replaces the old "draw an arrow between two orgs" connect-mode UI. A
// connection on the Org Map now MEANS something: it represents a real
// scheduled transfer (`profile.schedule.enabled`) with an interval. The
// modal is intentionally focused — pick profile + source + target + interval,
// nothing else. No "label" field, no "type" picker (we removed scan/bidir),
// no "I want a decorative arrow with no behavior" option.
//
// Optional `presets` lets a caller pre-fill the source org (used by the
// per-org-detail-panel's "📅 Schedule" button).
function openScheduleTransferModal(presets = {}) {
  const orgs = allMapOrgs();

  // Only orgs with stored credentials can be the source/target of a SCHEDULED
  // transfer — scheduled runs happen in the background service worker without
  // a live browser tab, so they need to re-authenticate via SOAP each time.
  const credOrgs = orgs.filter(o => {
    const stored = _storedOrgs.find(s => s.id === o.id);
    return !!(stored?.username && stored?.password);
  });

  if (!_profiles.length) {
    showModal(`
      <div class="ds-modal-header">📅 Schedule Transfer</div>
      <div class="ds-modal-body" style="text-align:center;padding:24px">
        <div style="font-size:40px;margin-bottom:8px">📦</div>
        <div style="font-size:14px;font-weight:600;margin-bottom:4px">No deployment profiles yet</div>
        <div style="font-size:12px;color:var(--subtext);max-width:380px;margin:0 auto">
          A schedule needs a deployment profile to know what to copy.
          Create one in <strong>Data Deployment</strong> first.
        </div>
      </div>
      <div class="ds-modal-footer">
        <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
        <button class="ds-btn ds-btn-primary" id="dsSchedGoProfiles">📦 Go to Data Deployment</button>
      </div>`);
    eid('dsSchedGoProfiles')?.addEventListener('click', () => {
      closeModal();
      document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'profiles'));
      _currentView = 'profiles';
      renderView('profiles');
    });
    return;
  }

  if (credOrgs.length < 2) {
    showModal(`
      <div class="ds-modal-header">📅 Schedule Transfer</div>
      <div class="ds-modal-body" style="padding:18px">
        <div style="font-size:13px;margin-bottom:8px">
          Scheduled transfers run in the background and need stored credentials so they can re-authenticate.
        </div>
        <div style="font-size:12px;color:var(--subtext)">
          You currently have <strong>${credOrgs.length}</strong> org${credOrgs.length === 1 ? '' : 's'} with stored credentials. Add credentials for at least <strong>two</strong> orgs in <strong>Connected Orgs</strong>, then come back.
        </div>
      </div>
      <div class="ds-modal-footer">
        <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
        <button class="ds-btn ds-btn-primary" id="dsSchedGoOrgs">🔌 Open Connected Orgs</button>
      </div>`);
    eid('dsSchedGoOrgs')?.addEventListener('click', () => {
      closeModal();
      document.querySelectorAll('.ds-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'orgs'));
      _currentView = 'orgs';
      renderView('orgs');
    });
    return;
  }

  const INTERVALS = [
    { label: 'Every 15 minutes', value: 15 },
    { label: 'Every 30 minutes', value: 30 },
    { label: 'Every hour',       value: 60 },
    { label: 'Every 6 hours',    value: 360 },
    { label: 'Every 12 hours',   value: 720 },
    { label: 'Every 24 hours',   value: 1440 }
  ];

  const orgOption = (o, selected) =>
    `<option value="${esc(o.id)}" ${selected ? 'selected' : ''}>${esc(o.label || orgLabel(o.url))}</option>`;

  const profileOpts = _profiles.map(p =>
    `<option value="${esc(p.id)}">${esc(p.name)}${p.schedule?.enabled ? ' · already scheduled' : ''}</option>`
  ).join('');

  showModal(`
    <div class="ds-modal-header">📅 Schedule Transfer</div>
    <div class="ds-modal-body">
      <div style="font-size:11px;color:var(--subtext);margin:-2px 0 14px;padding:8px 10px;background:#f5f4ff;border-left:3px solid #7c5ce0;border-radius:3px">
        Each scheduled transfer becomes a labelled edge on the Org Map. Edges are derived from this state — there's no separate "connections" concept.
      </div>

      <div class="ds-org-edit-row">
        <label class="ds-lbl">Profile <span style="font-size:11px;font-weight:400;color:var(--subtext)">(selecting one auto-fills the orgs below)</span></label>
        <select id="dsSchedProfile" class="ds-input">
          <option value="">— Select profile —</option>
          ${profileOpts}
        </select>
      </div>
      <div class="ds-org-edit-row" style="display:flex;gap:10px">
        <div style="flex:1">
          <label class="ds-lbl">Source Org</label>
          <select id="dsSchedSrc" class="ds-input">
            <option value="">— Select source —</option>
            ${credOrgs.map(o => orgOption(o, presets.sourceOrgId === o.id)).join('')}
          </select>
        </div>
        <div style="flex:1">
          <label class="ds-lbl">Target Org</label>
          <select id="dsSchedTgt" class="ds-input">
            <option value="">— Select target —</option>
            ${credOrgs.map(o => orgOption(o, false)).join('')}
          </select>
        </div>
      </div>
      <div class="ds-org-edit-row">
        <label class="ds-lbl">Interval</label>
        <select id="dsSchedInterval" class="ds-input">
          ${INTERVALS.map(iv => `<option value="${iv.value}" ${iv.value === 60 ? 'selected' : ''}>${iv.label}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn ds-btn-primary" id="dsSchedSave">📅 Enable Schedule</button>
    </div>`);

  // Auto-fill org pickers when the user picks a profile that already has orgs
  // configured. Saves them from re-picking the same orgs that are already on
  // the profile. They can still override if they want (e.g., for a one-off
  // schedule against a different target).
  eid('dsSchedProfile')?.addEventListener('change', e => {
    const profile = _profiles.find(p => p.id === e.target.value);
    if (!profile) return;
    const srcSel = eid('dsSchedSrc');
    const tgtSel = eid('dsSchedTgt');
    if (srcSel && profile.sourceOrg) {
      const srcOrg = credOrgs.find(o => o.url === profile.sourceOrg);
      if (srcOrg) srcSel.value = srcOrg.id;
    }
    if (tgtSel && profile.targetOrg) {
      const tgtOrg = credOrgs.find(o => o.url === profile.targetOrg);
      if (tgtOrg) tgtSel.value = tgtOrg.id;
    }
  });

  eid('dsSchedSave')?.addEventListener('click', async () => {
    const profileId = eid('dsSchedProfile')?.value;
    const srcId     = eid('dsSchedSrc')?.value;
    const tgtId     = eid('dsSchedTgt')?.value;
    const interval  = parseInt(eid('dsSchedInterval')?.value || '60', 10);

    if (!profileId) return showToast('Pick a profile to schedule.', 'error', 3500);
    if (!srcId || !tgtId) return showToast('Pick both a source and a target org.', 'error', 3500);
    if (srcId === tgtId)  return showToast('Source and target must be different orgs.', 'error', 3500);

    const profile     = _profiles.find(p => p.id === profileId);
    const srcStored   = _storedOrgs.find(o => o.id === srcId);
    const tgtStored   = _storedOrgs.find(o => o.id === tgtId);
    if (!profile || !srcStored || !tgtStored) {
      return showToast('Could not resolve profile or org credentials.', 'error', 4000);
    }

    profile.schedule = {
      enabled:         true,
      sourceOrg:       srcStored.url,
      targetOrg:       tgtStored.url,
      intervalMinutes: interval
    };
    profile.updatedAt = new Date().toISOString();
    await storageSaveProfiles();
    await sendBg({ type: 'DS_SCHEDULE_SET', profileId: profile.id, schedule: profile.schedule });

    const ivLbl = interval >= 1440 ? 'daily' : interval >= 60 ? `every ${interval/60}h` : `every ${interval}m`;
    showToast(`✓ "${profile.name}" scheduled — ${ivLbl}`, 'success', 3500);
    closeModal();
    renderOrgMap();
  });
}

// orgLabel2 + window.deleteConnection removed in Architecture A — the free-form
// connection UI is gone, so its helpers no longer have callers. Existing
// `_connections[]` data is left in chrome.storage to avoid a destructive
// migration, but nothing renders it.

window.startTransferFromOrg = function(orgId) {
  const orgs = allMapOrgs();
  const org = orgs.find(o => o.id === orgId);
  if (!org) return;
  const session = _allSessions.find(s => s.orgUrl === org.url)
    || (org.url === _orgUrl ? { orgUrl: _orgUrl, sid: _sid } : null);
  if (session) startTransferFrom(session.orgUrl);
  else showToast('Org not currently open in Chrome — reconnect first');
};

// Called from the Connected Orgs panel — same logic as map reconnect but refreshes panel
window.reconnectOrgFromPanel = async function(orgId) {
  const org = _storedOrgs.find(o => o.id === orgId);
  if (!org || !org.username || !org.password) {
    showToast('No stored credentials — re-add the org using "Connect with Credentials"');
    return;
  }
  try {
    const res = await sendBg({ type: 'DS_SOAP_LOGIN', loginUrl: org.loginUrl, username: org.username, password: org.password });
    if (res.error) { showToast('Reconnect failed: ' + res.error, 'error'); return; }
    org.sid = res.sid; org.lastConnected = new Date().toISOString();
    await saveStoredOrgs();
    showToast('Reconnected ✓', 'success');
    renderOrgsPanel();
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
};

window.reconnectOrg = async function(orgId) {
  const org = _storedOrgs.find(o => o.id === orgId);
  if (!org || !org.username || !org.password) {
    showToast('No stored credentials — re-add the org with SOAP login');
    return;
  }
  try {
    const loginUrl = (org.type === 'sandbox' || org.loginUrl?.includes('test.'))
      ? 'https://test.salesforce.com/services/Soap/u/62.0'
      : 'https://login.salesforce.com/services/Soap/u/62.0';
    const res = await sendBg({ type: 'DS_SOAP_LOGIN', loginUrl, username: org.username, password: org.password });
    if (res.error) { showToast('Login failed: ' + res.error); return; }
    org.sid = res.sid; org.orgUrl = res.orgUrl; org.lastConnected = new Date().toISOString();
    await saveStoredOrgs();
    showToast('Reconnected ✓');
    renderOrgMap();
  } catch(e) { showToast('Error: ' + e.message); }
};

window.removeStoredOrg = async function(orgId) {
  showModal(`
    <div class="ds-modal-header">Remove Org</div>
    <div class="ds-modal-body">Remove this org and all its connections from the map?</div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn ds-btn-danger" id="dsRemoveOrgConfirm">Remove</button>
    </div>`);
  eid('dsRemoveOrgConfirm')?.addEventListener('click', async () => {
    _storedOrgs  = _storedOrgs.filter(o => o.id !== orgId);
    _connections = _connections.filter(c => c.sourceOrgId !== orgId && c.targetOrgId !== orgId);
    await saveStoredOrgs(); await saveConnections();
    closeModal();
    if (_mapState.selectedNode === orgId) { _mapState.selectedNode = null; const d = eid('dsMapDetail'); if(d) d.style.display='none'; }
    renderOrgMap();
  });
};

window.editStoredOrg = function(orgId) {
  const org = _storedOrgs.find(o => o.id === orgId);
  if (!org) return;
  showModal(`
    <div class="ds-modal-header">✏ Edit Org</div>
    <div class="ds-modal-body">
      <div class="ds-org-edit-row">
        <label class="ds-lbl">Label</label>
        <input id="dsEOLabel" class="ds-input" value="${esc(org.label||'')}">
      </div>
      <div class="ds-org-edit-row">
        <label class="ds-lbl">Type</label>
        <select id="dsEOType" class="ds-input">
          ${['production','sandbox','dev','scratch'].map(t =>
            `<option value="${t}" ${org.type===t?'selected':''}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`
          ).join('')}
        </select>
      </div>
    </div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn ds-btn-primary" id="dsEOSave">Save</button>
    </div>`);
  eid('dsEOSave')?.addEventListener('click', async () => {
    org.label = eid('dsEOLabel')?.value.trim() || org.label;
    org.type  = eid('dsEOType')?.value || org.type;
    await saveStoredOrgs();
    closeModal(); renderOrgMap();
  });
};

// Called from org card button
window.startTransferFrom = function(sourceOrg) {
  _transferSrc = _allSessions.find(s => s.orgUrl === sourceOrg) ||
    (sourceOrg === _orgUrl ? { orgUrl: _orgUrl, sid: _sid } : null);
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
         <span class="ds-diff-empty-hint">${diff ? 'Diff is stale (orgs changed) — click 🔍 Refresh diff' : 'No diff run yet — click 🔍 Refresh diff to compare orgs'}</span>
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
        <button class="ds-btn ds-btn-sm" data-dsaction="refreshDiff" data-arg="${p.id}"
          ${hasOrgs ? '' : 'disabled title="Set source and target orgs first"'}
          title="Query both orgs and compute what's missing / changed / in sync — gives you live state instead of relying on past run history">🔍 Refresh diff</button>
        <button class="ds-btn ds-btn-sm" data-dsaction="snapshotProfile" data-arg="${p.id}"
          ${hasOrgs ? '' : 'disabled title="Set source and target orgs first"'}
          title="Capture fingerprints of every record in every object of this profile tree, on both source and target orgs. Powers the Org Map drift overlay without re-querying live.">📸 Snapshot</button>
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
    await sendBg({ type: 'DS_SCHEDULE_CLEAR', profileId });
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
            ${allMapOrgs().map(o =>
              `<option value="${esc(o.url)}" ${p.sourceOrg === o.url ? 'selected' : ''}>${esc(o.label || orgLabel(o.url))}</option>`
            ).join('')}
          </select>
        </div>
        <span class="ds-builder-orgs-arrow">→</span>
        <div class="ds-builder-org-col">
          <label class="ds-lbl">Target Org <span class="ds-builder-org-hint">(where records get inserted)</span></label>
          <select id="dsProfileTgtOrg" class="ds-input">
            <option value="">— Select target org —</option>
            ${allMapOrgs().map(o =>
              `<option value="${esc(o.url)}" ${p.targetOrg === o.url ? 'selected' : ''}>${esc(o.label || orgLabel(o.url))}</option>`
            ).join('')}
          </select>
        </div>
      </div>

      <!-- Diff config — drives the "what's already in target?" signal.
           The match field is the cross-org record identity (since Salesforce
           Ids don't match across orgs). Compare fields, if any, are checked
           for value equality to detect drift between source and target. -->
      <div class="ds-builder-diff-row">
        <div class="ds-builder-diff-col">
          <label class="ds-lbl">Match field <span class="ds-builder-org-hint">— used to identify the SAME record across orgs</span></label>
          <input id="dsProfileMatchField" class="ds-input" placeholder="Name"
            value="${esc(p.scanConfig?.matchField || 'Name')}">
        </div>
        <div class="ds-builder-diff-col">
          <label class="ds-lbl">Compare fields <span class="ds-builder-org-hint">— comma-separated; differences mark a record as "drift"</span></label>
          <input id="dsProfileCompareFields" class="ds-input" placeholder="e.g. Email, Phone, Title"
            value="${esc((p.scanConfig?.compareFields || []).join(', '))}">
        </div>
      </div>

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

  // Diff-config inputs — match field + comma-separated compare fields.
  // Updates the in-memory profile; commit happens on builder Save.
  eid('dsProfileMatchField')?.addEventListener('change', e => {
    if (!_editingProfile.scanConfig) _editingProfile.scanConfig = {};
    _editingProfile.scanConfig.matchField = e.target.value.trim() || 'Name';
  });
  eid('dsProfileCompareFields')?.addEventListener('change', e => {
    if (!_editingProfile.scanConfig) _editingProfile.scanConfig = {};
    _editingProfile.scanConfig.compareFields = e.target.value
      .split(',').map(s => s.trim()).filter(Boolean);
  });

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
  const parts = pathStr.split('.');
  if (parts.length <= 1) return null;
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

  // Diagnostic — log what the modal is loading so we can tell the difference
  // between "save didn't persist" and "load didn't restore". The previous bug
  // (strip identity → invisible save) is fixed; if a future report comes in
  // claiming the mapping was lost, this line plus the Apply-time round-trip
  // log together pinpoint exactly which step failed.
  const existingCount = Object.keys(mappings).length;
  window.SFToolkitDebug?.log('transfer', 'info',
    `Field mapping modal OPEN: node "${objType}" already has ${existingCount} saved entries ` +
    `(srcOrg=${node.fieldMappingOrgs?.src || '—'}, tgtOrg=${node.fieldMappingOrgs?.tgt || '—'})`);

  // ── Org list (all known orgs — sessions + stored credentials) ────────────
  function allOrgs() {
    const orgs = [];
    const seen = new Set();
    for (const o of _storedOrgs) {
      if (o.url && o.sid && !seen.has(o.url)) {
        seen.add(o.url);
        orgs.push({ url: o.url, sid: o.sid, label: o.label || o.url });
      }
    }
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
    const ALWAYS = new Set(['Id', 'Name']);
    return (desc.fields || [])
      .filter(f => f.createable || ALWAYS.has(f.name))
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
      ${orgs.map(o => `<option value="${esc(o.url)}" ${o.url === selectedUrl ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
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
  const STRING_TYPES = new Set(['string', 'email', 'phone', 'url', 'textarea', 'picklist', 'id', 'reference', 'autonumber']);
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
  // Use the last field the user chose for this object (stored in _meta), or best guess
  const defaultField = candidateFields[0]?.name || null;
  let displayField   = node._meta._recDisplayField || defaultField;

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
  if (scanFresh) {
    for (const r of (liveScan.missingInTarget || [])) if (r.sourceId) idsMissingInTarget.add(r.sourceId);
    for (const r of (liveScan.identical       || [])) if (r.sourceId) idsInSync.add(r.sourceId);
    for (const r of (liveScan.changed         || [])) if (r.sourceId) idsDrift.add(r.sourceId);
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
  let hideDeployed = false;   // user-toggleable filter — hides in-sync rows

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

    return `
      <div class="ds-modal-header">🎯 Pick Records — <strong>${esc(objType)}</strong></div>
      <div class="ds-modal-body ds-picker-body">

        <!-- Display field selector -->
        <div class="ds-rec-display-row">
          <span class="ds-rec-display-lbl">Show field:</span>
          ${candidateFields.length
            ? `<select id="dsRecDisplayField" class="ds-select ds-select-sm">
                <option value="Id">Id (always unique)</option>
                ${fieldOptions()}
               </select>`
            : `<span class="ds-subtext">No string fields found — showing Id only</span>`}
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
                if (scanFresh) {
                  if (idsMissingInTarget.has(r.Id)) {
                    rowCls = ' ds-pick-row-missing';
                    badgeHtml = '<span class="ds-pick-state-badge ds-diff-missing" title="Not present in the target org — will be inserted if you transfer this record">🔴 missing in target</span>';
                  } else if (idsDrift.has(r.Id)) {
                    rowCls = ' ds-pick-row-drift';
                    badgeHtml = '<span class="ds-pick-state-badge ds-diff-drift" title="Present in target but at least one compare field differs from source">🟡 drift</span>';
                  } else if (idsInSync.has(r.Id)) {
                    rowCls = ' ds-pick-row-deployed';
                    badgeHtml = '<span class="ds-pick-state-badge ds-diff-sync" title="Present in target and all compare fields match — no action needed">🟢 in sync</span>';
                  }
                } else if (deployedIds.has(r.Id)) {
                  rowCls = ' ds-pick-row-deployed';
                  badgeHtml = '<span class="ds-pick-deployed-badge" title="This record was successfully transferred to the target org in a previous run">✓ deployed</span>';
                }
                return `<label class="ds-pick-row${rowCls}">
                  <input type="checkbox" value="${esc(r.Id)}" ${selected.has(r.Id) ? 'checked' : ''}>
                  <span class="ds-pick-label">${esc(label)}</span>
                  ${badgeHtml}
                  ${sub ? `<span class="ds-pick-api ds-pick-id">${esc(sub)}</span>` : ''}
                </label>`;
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

    // Display field change → re-query and re-render
    eid('dsRecDisplayField')?.addEventListener('change', async e => {
      displayField = e.target.value;
      node._meta._recDisplayField = displayField;
      const box = eid('dsModalBox');
      if (box) box.innerHTML = `<div class="ds-modal-body" style="text-align:center;padding:40px;color:var(--subtext)">Loading…</div>`;
      await fetchRecords();
      if (box) { box.innerHTML = renderModal(''); wireModal(''); }
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
      const box = eid('dsModalBox');
      if (box) { box.innerHTML = renderModal(filter); wireModal(filter); }
    });

    eid('dsRecList')?.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(cb.value); else selected.delete(cb.value);
        note();
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

  const STRING_TYPES = new Set(['string','email','phone','url','textarea','picklist','id','reference','autonumber']);
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

  const matchField    = profile.scanConfig?.matchField || 'Name';
  const compareFields = (profile.scanConfig?.compareFields || []).filter(Boolean);
  const where         = (profile.tree?.where || '').trim();

  // Resolve sessions for both orgs. They must be reachable (open in Chrome
  // OR stored as credentialed orgs) — otherwise the scan can't query target.
  const allSess = _buildAllSessions();
  const srcSess = _resolveSession(profile.sourceOrg, allSess);
  const tgtSess = _resolveSession(profile.targetOrg, allSess);
  if (!srcSess?.sid) return { error: `source org session not active — open ${orgLabel(profile.sourceOrg)} in a tab` };
  if (!tgtSess?.sid) return { error: `target org session not active — open ${orgLabel(profile.targetOrg)} in a tab` };

  // SOQL — Id + matchField + each compareField. Dedup to avoid `SELECT
  // Id, Id, Name, Name` when matchField is also a compareField.
  const fieldList = [...new Set(['Id', matchField, ...compareFields])].filter(Boolean).join(',');
  const soql = `SELECT ${fieldList} FROM ${objType}${where ? ' WHERE ' + where : ''}`;

  let srcRes, tgtRes;
  try {
    [srcRes, tgtRes] = await Promise.all([
      sendBg({ type: 'SF_QUERY_ALL', orgUrl: srcSess.orgUrl, sid: srcSess.sid, tooling: false, query: soql }),
      sendBg({ type: 'SF_QUERY_ALL', orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, tooling: false, query: soql })
    ]);
  } catch (e) {
    return { error: `scan failed: ${e?.message || e}` };
  }
  if (srcRes?.error) return { error: `source query failed: ${srcRes.error}` };
  if (tgtRes?.error) return { error: `target query failed: ${tgtRes.error}` };

  // Index by matchField. Coerce to string so "123" (number) and "123"
  // (text) cross-org don't accidentally land in different buckets.
  const srcByKey = new Map();
  for (const r of (srcRes.records || [])) {
    const k = r[matchField];
    if (k != null && k !== '') srcByKey.set(String(k), r);
  }
  const tgtByKey = new Map();
  for (const r of (tgtRes.records || [])) {
    const k = r[matchField];
    if (k != null && k !== '') tgtByKey.set(String(k), r);
  }

  const missingInTarget = []; // present in source, absent in target → "deploy"
  const onlyInTarget    = []; // present in target, absent in source → "extras"
  const changed         = []; // present in both, compareFields differ → "drift"
  const identical       = []; // present in both, all compareFields match → "in sync"

  for (const [k, sr] of srcByKey) {
    const tr = tgtByKey.get(k);
    if (!tr) {
      missingInTarget.push({ matchKey: k, sourceId: sr.Id });
    } else {
      // If no compareFields configured, presence alone means identical.
      let differs = false;
      for (const f of compareFields) {
        if (String(sr[f] ?? '') !== String(tr[f] ?? '')) { differs = true; break; }
      }
      if (differs) changed.push({ matchKey: k, sourceId: sr.Id, targetId: tr.Id });
      else         identical.push({ matchKey: k, sourceId: sr.Id, targetId: tr.Id });
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
    matchField,
    compareFields,
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
  const profile = _profiles.find(p => p.id === profileId);
  if (!profile) return null;
  const res = await runDiffScan(profile);
  if (res?.error) {
    showToast(`Diff scan: ${res.error}`, 'error', 6000);
    return res;
  }
  profile.lastScan  = res;
  profile.updatedAt = new Date().toISOString();
  await storageSaveProfiles();

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

// ════════════════════════════════════════════════════════════════
// SNAPSHOT LAYER (Phase 2) — org_snapshots[orgUrl][objectType]
// ════════════════════════════════════════════════════════════════
// captureOrgSnapshot delegates to the service worker (which hashes via
// crypto.subtle). loadSnapshots reads chrome.storage.local.
// diffSnapshots is a pure compare that powers the Org Map drift overlay
// without any network calls — snapshots are the cached truth.

// Drift overlay color thresholds — ≥99% green / 90–99% yellow / 70–89% orange / <70% red.
const SNAPSHOT_DRIFT_THRESHOLDS = [
  { min: 0.99, color: 'green',  label: 'in sync'    },
  { min: 0.90, color: 'yellow', label: 'minor drift'},
  { min: 0.70, color: 'orange', label: 'major drift'},
  { min: 0,    color: 'red',    label: 'severe drift'}
];

function snapshotDriftColor(matchRatio) {
  for (const t of SNAPSHOT_DRIFT_THRESHOLDS) {
    if (matchRatio >= t.min) return t;
  }
  return SNAPSHOT_DRIFT_THRESHOLDS[SNAPSHOT_DRIFT_THRESHOLDS.length - 1];
}

async function loadSnapshots() {
  const data = await chrome.storage.local.get('org_snapshots');
  return data.org_snapshots || {};
}

async function getSnapshot(orgUrl, objectType) {
  const all = await loadSnapshots();
  return all[orgUrl]?.[objectType] || null;
}

async function captureOrgSnapshot(orgUrl, sid, objectType, matchField, compareFields) {
  return sendBg({
    type:          'SF_CAPTURE_SNAPSHOT',
    orgUrl, sid,
    objectType,
    matchField:    matchField    || 'Name',
    compareFields: compareFields || []
  });
}

async function refreshSnapshotsCache() {
  _snapshotsCache = await loadSnapshots();
  return _snapshotsCache;
}

// Aggregate drift for a scheduled profile — walks every object in the profile
// tree, looks up snapshots on src + tgt from cache, returns a combined ratio.
// Returns matchRatio: null if no objects have both-side snapshots yet.
function aggregateProfileDrift(profile) {
  if (!profile?.schedule) return { matchRatio: null, objectsCovered: 0, totalObjects: 0 };
  const types     = [...collectTreeObjects(profile.tree)];
  const srcSnaps  = _snapshotsCache[profile.schedule.sourceOrg] || {};
  const tgtSnaps  = _snapshotsCache[profile.schedule.targetOrg] || {};
  let identical = 0, drift = 0, missingInB = 0;
  let objectsCovered = 0;
  let schemaMismatch = false;

  for (const t of types) {
    const a = srcSnaps[t], b = tgtSnaps[t];
    if (!a || !b) continue;
    const d = diffSnapshots(a, b);
    if (d.error) continue;
    if (!d.fieldsMatch) schemaMismatch = true;
    objectsCovered++;
    identical  += d.identical;
    drift      += d.drift;
    missingInB += d.missingInB;
  }
  const denom = identical + drift + missingInB;
  return {
    matchRatio: denom > 0 ? identical / denom : null,
    objectsCovered,
    totalObjects: types.length,
    schemaMismatch,
    identical, drift, missingInB
  };
}

// Drill-down: show the actual drifting matchKeys for one object in a profile.
// Reads from _snapshotsCache only — no network, no extra query. Caps the
// rendered list to keep huge drift sets snappy.
function showDriftRecordsModal(profile, objectType) {
  if (!profile?.schedule) return;
  const a = _snapshotsCache[profile.schedule.sourceOrg]?.[objectType];
  const b = _snapshotsCache[profile.schedule.targetOrg]?.[objectType];
  if (!a || !b) {
    return showToast(`Need snapshots on both orgs first for ${objectType}. Click 📸 Refresh snapshots.`, 'error', 5000);
  }
  const aRec = a.records || {};
  const bRec = b.records || {};

  // Build the three buckets — pure cached work, no I/O.
  const drift      = [];  // in both, hash differs
  const missingInB = [];  // in src not tgt
  const onlyInB    = [];  // in tgt not src
  for (const [k, av] of Object.entries(aRec)) {
    if (!(k in bRec)) missingInB.push({ matchKey: k, srcId: av.id });
    else if (av.hash !== bRec[k].hash) {
      drift.push({ matchKey: k, srcId: av.id, tgtId: bRec[k].id, srcHash: av.hash, tgtHash: bRec[k].hash });
    }
  }
  for (const [k, bv] of Object.entries(bRec)) {
    if (!(k in aRec)) onlyInB.push({ matchKey: k, tgtId: bv.id });
  }

  const CAP    = 100;
  const srcUrl = profile.schedule.sourceOrg;
  const tgtUrl = profile.schedule.targetOrg;
  // Build links that open the record directly in the right org's Lightning UI.
  const recLink = (orgUrl, id) => `${orgUrl.replace(/\/$/, '')}/lightning/r/${objectType}/${id}/view`;

  const driftHtml = drift.length ? `
    <div class="ds-drift-modal-section-hdr">⚠ Drift — same record, different field values (${drift.length}${drift.length > CAP ? ` · showing ${CAP}` : ''})</div>
    <div class="ds-drift-modal-list">
      ${drift.slice(0, CAP).map(r => `
        <div class="ds-drift-modal-row">
          <span class="ds-drift-modal-key">${esc(r.matchKey)}</span>
          <a href="${esc(recLink(srcUrl, r.srcId))}" target="_blank" rel="noopener" class="ds-drift-modal-link" title="Open in source org">${esc(r.srcId)} ↗</a>
          <span class="ds-drift-modal-hash" title="Source hash">${esc(r.srcHash)}</span>
          <span class="ds-drift-modal-vs">≠</span>
          <span class="ds-drift-modal-hash" title="Target hash">${esc(r.tgtHash)}</span>
          <a href="${esc(recLink(tgtUrl, r.tgtId))}" target="_blank" rel="noopener" class="ds-drift-modal-link" title="Open in target org">${esc(r.tgtId)} ↗</a>
        </div>`).join('')}
    </div>` : '';

  const missingHtml = missingInB.length ? `
    <div class="ds-drift-modal-section-hdr">📤 Missing in target — present in source only (${missingInB.length}${missingInB.length > CAP ? ` · showing ${CAP}` : ''})</div>
    <div class="ds-drift-modal-list">
      ${missingInB.slice(0, CAP).map(r => `
        <div class="ds-drift-modal-row">
          <span class="ds-drift-modal-key">${esc(r.matchKey)}</span>
          <a href="${esc(recLink(srcUrl, r.srcId))}" target="_blank" rel="noopener" class="ds-drift-modal-link">${esc(r.srcId)} ↗</a>
        </div>`).join('')}
    </div>` : '';

  const extrasHtml = onlyInB.length ? `
    <div class="ds-drift-modal-section-hdr">📥 Only in target — present in target only (${onlyInB.length}${onlyInB.length > CAP ? ` · showing ${CAP}` : ''})</div>
    <div class="ds-drift-modal-list">
      ${onlyInB.slice(0, CAP).map(r => `
        <div class="ds-drift-modal-row">
          <span class="ds-drift-modal-key">${esc(r.matchKey)}</span>
          <a href="${esc(recLink(tgtUrl, r.tgtId))}" target="_blank" rel="noopener" class="ds-drift-modal-link">${esc(r.tgtId)} ↗</a>
        </div>`).join('')}
    </div>` : '';

  const emptyHtml = (!drift.length && !missingInB.length && !onlyInB.length) ? `
    <div class="ds-drift-modal-empty">
      <div style="font-size:32px;margin-bottom:8px">✅</div>
      <div style="font-weight:600">Fully in sync for ${esc(objectType)}</div>
      <div style="font-size:11px;color:var(--subtext);margin-top:6px">${a.recordCount} records match across source and target.</div>
    </div>` : '';

  showModal(`
    <div class="ds-modal-header">
      🔍 Drift detail — <strong>${esc(objectType)}</strong>
      <button class="ds-btn ds-btn-xs" data-dsaction="closeModal" style="margin-left:auto">✕</button>
    </div>
    <div class="ds-modal-body ds-drift-modal-body">
      <div class="ds-drift-modal-orgs">
        <strong>${esc(orgLabel(srcUrl))}</strong>
        <span style="color:var(--subtext)">vs</span>
        <strong>${esc(orgLabel(tgtUrl))}</strong>
        <span style="margin-left:auto;font-size:11px;color:var(--subtext)">matchField: <code>${esc(a.matchField)}</code> · compareFields: <code>${esc((a.compareFields||[]).join(', ') || '(none)')}</code></span>
      </div>
      ${emptyHtml}
      ${driftHtml}
      ${missingHtml}
      ${extrasHtml}
      ${(drift.length > CAP || missingInB.length > CAP || onlyInB.length > CAP) ? `
        <div class="ds-drift-modal-truncated">Some lists capped at ${CAP} rows. Snapshot was ${a.truncated || b.truncated ? 'itself truncated at 50k records — ' : ''}use a tighter WHERE filter on the profile to narrow the comparison.</div>` : ''}
    </div>
  `);
}

// Manual "📸 Snapshot" for a single PROFILE — captures snapshots for every
// objectType in the profile's tree, on both sourceOrg and targetOrg. Uses
// profile.scanConfig for the root object, defaults to Name for children.
window.snapshotProfileNow = async function(profileId) {
  const p = _profiles.find(x => x.id === profileId);
  if (!p)              return showToast('Profile not found', 'error', 3000);
  if (!p.sourceOrg || !p.targetOrg) {
    return showToast('Profile has no source/target orgs — set them in Edit first', 'error', 4000);
  }
  const allSess = _buildAllSessions();
  const srcSess = _resolveSession(p.sourceOrg, allSess);
  const tgtSess = _resolveSession(p.targetOrg, allSess);
  if (!srcSess?.sid) return showToast(`No active session for source org (${orgLabel(p.sourceOrg)}) — open it in Chrome first`, 'error', 5000);
  if (!tgtSess?.sid) return showToast(`No active session for target org (${orgLabel(p.targetOrg)}) — open it in Chrome first`, 'error', 5000);

  const types    = [...collectTreeObjects(p.tree)];
  const rootType = p.tree?.objectType || p.tree?.childSObject;
  if (!types.length) return showToast('Profile has no objects', 'error', 3000);

  showToast(`📸 Capturing ${types.length} object(s) × 2 orgs…`, 'info', 2500);
  let ok = 0;
  const failures   = [];   // [{ objectType, side, error }]
  const adjusted   = [];   // [{ objectType, side, fellBack, dropped }]
  for (const t of types) {
    const mf  = (t === rootType) ? (p.scanConfig?.matchField    || 'Name') : 'Name';
    const cmp = (t === rootType) ? (p.scanConfig?.compareFields || [])     : [];
    for (const [side, sess] of [['source', srcSess], ['target', tgtSess]]) {
      try {
        const r = await captureOrgSnapshot(sess.orgUrl, sess.sid, t, mf, cmp);
        if (r?.error) {
          failures.push({ objectType: t, side, error: r.error });
        } else {
          ok++;
          if (r?.matchFieldFellBack || (r?.droppedCompareFields || []).length) {
            adjusted.push({ objectType: t, side, fellBack: r.matchFieldFellBack, dropped: r.droppedCompareFields || [] });
          }
        }
      } catch (e) {
        failures.push({ objectType: t, side, error: e?.message || String(e) });
      }
    }
  }
  await refreshSnapshotsCache();
  if (_currentView === 'map')      drawMapEdges(allMapOrgs());
  if (_currentView === 'profiles') renderProfiles();
  reportSnapshotResult(ok, failures, adjusted);
};

// Build a clear, actionable toast from snapshot batch results. Used by both
// snapshotProfileNow and snapshotOrgNow so the warning surface is consistent.
function reportSnapshotResult(ok, failures, adjusted) {
  if (failures.length === 0 && adjusted.length === 0) {
    showToast(`📸 Snapshots captured — ${ok} ok`, 'success', 3500);
    return;
  }
  const lines = [`📸 Snapshots — ${ok} ok, ${failures.length} failed`];
  if (failures.length) {
    const sample = failures.slice(0, 3).map(f => `${f.objectType} (${f.side}): ${(f.error || '').replace(/^Snapshot \S+: /, '').slice(0, 80)}`);
    lines.push(...sample);
    if (failures.length > 3) lines.push(`…and ${failures.length - 3} more`);
  }
  if (adjusted.length) {
    const fellBackList = [...new Set(adjusted.filter(a => a.fellBack).map(a => a.objectType))];
    const droppedSet   = new Set();
    for (const a of adjusted) (a.dropped || []).forEach(d => droppedSet.add(d));
    if (fellBackList.length) lines.push(`ℹ matchField auto-corrected for: ${fellBackList.slice(0, 4).join(', ')}${fellBackList.length > 4 ? `, +${fellBackList.length - 4}` : ''}`);
    if (droppedSet.size)     lines.push(`ℹ dropped fields not present on target: ${[...droppedSet].slice(0, 4).join(', ')}${droppedSet.size > 4 ? `, +${droppedSet.size - 4}` : ''}`);
  }
  showToast(lines.join('\n'), failures.length ? 'error' : 'info', 8000);
}

// Manual "📸 Snapshot now" for a single org — captures snapshots for every
// object in every profile that touches this org (as src OR tgt). Uses each
// profile's scanConfig for the root object, defaults to Name for children.
window.snapshotOrgNow = async function(orgId) {
  const orgs = allMapOrgs();
  const org  = orgs.find(o => o.id === orgId);
  if (!org) return;
  const sess = _allSessions.find(s => s.orgUrl === org.url)
            || (org.url === _orgUrl ? { orgUrl: _orgUrl, sid: _sid } : null)
            || (_storedOrgs.find(s => s.url === org.url && s.sid) ? { orgUrl: org.url, sid: _storedOrgs.find(s => s.url === org.url).sid } : null);
  if (!sess?.sid) {
    showToast(`Open ${orgLabel(org.url)} in Chrome first (no active session)`, 'error', 4000);
    return;
  }

  // Find every object type involved in any profile that touches this org.
  // Match the per-object matchField/compareFields used when the same object
  // appears as a profile root — so this snapshot stays comparable.
  const objectSpecs = new Map();  // objType → { matchField, compareFields }
  for (const p of _profiles) {
    if (p.schedule?.sourceOrg !== org.url && p.schedule?.targetOrg !== org.url
        && p.sourceOrg !== org.url && p.targetOrg !== org.url) continue;
    const rootType = p.tree?.objectType || p.tree?.childSObject;
    const types = [...collectTreeObjects(p.tree)];
    for (const t of types) {
      if (objectSpecs.has(t)) continue;
      if (t === rootType) {
        objectSpecs.set(t, {
          matchField:    p.scanConfig?.matchField    || 'Name',
          compareFields: p.scanConfig?.compareFields || []
        });
      } else {
        objectSpecs.set(t, { matchField: 'Name', compareFields: [] });
      }
    }
  }
  if (!objectSpecs.size) {
    showToast(`No profiles touch ${orgLabel(org.url)} — create one first to define objects to snapshot`, 'info', 5000);
    return;
  }

  showToast(`📸 Capturing ${objectSpecs.size} object snapshot(s) on ${orgLabel(org.url)}…`, 'info', 2500);
  let ok = 0;
  const failures = [];
  const adjusted = [];
  for (const [t, spec] of objectSpecs) {
    try {
      const r = await captureOrgSnapshot(sess.orgUrl, sess.sid, t, spec.matchField, spec.compareFields);
      if (r?.error) {
        failures.push({ objectType: t, side: 'this org', error: r.error });
      } else {
        ok++;
        if (r?.matchFieldFellBack || (r?.droppedCompareFields || []).length) {
          adjusted.push({ objectType: t, side: 'this org', fellBack: r.matchFieldFellBack, dropped: r.droppedCompareFields || [] });
        }
      }
    } catch (e) {
      failures.push({ objectType: t, side: 'this org', error: e?.message || String(e) });
    }
  }
  await refreshSnapshotsCache();
  if (_currentView === 'map') drawMapEdges(allMapOrgs());
  reportSnapshotResult(ok, failures, adjusted);
};

// Diff two snapshots of the same object captured on different orgs.
// Returns counts + a matchRatio used by the drift overlay color picker.
// Pure function — no I/O, no storage reads.
function diffSnapshots(snapA, snapB) {
  if (!snapA || !snapB) {
    return { error: 'snapshot missing for one or both orgs' };
  }
  // If compareFields differ between the two sides we can detect presence
  // but not drift — hashes won't be comparable. Callers should re-capture.
  const fieldsMatch =
    JSON.stringify(snapA.compareFields || []) ===
    JSON.stringify(snapB.compareFields || []);

  const a = snapA.records || {};
  const b = snapB.records || {};
  let identical = 0, drift = 0, missingInB = 0, onlyInB = 0;

  for (const k of Object.keys(a)) {
    if (!(k in b)) { missingInB++; continue; }
    if (fieldsMatch && a[k].hash === b[k].hash) identical++;
    else drift++;
  }
  for (const k of Object.keys(b)) {
    if (!(k in a)) onlyInB++;
  }

  const overlap = identical + drift;
  const total   = overlap + missingInB;  // denominator = A's universe
  const matchRatio = total > 0 ? identical / total : 1;

  return { identical, drift, missingInB, onlyInB, matchRatio, fieldsMatch };
}

// ════════════════════════════════════════════════════════════════
// TRANSFER
// ════════════════════════════════════════════════════════════════
// Build a flat list of every session/credentialed org we can talk to right now.
// Used to resolve profile.sourceOrg/targetOrg (URL strings) → live session
// objects with a usable SID.
function _buildAllSessions() {
  const sessMap = new Map();
  if (_orgUrl) sessMap.set(_orgUrl, { orgUrl: _orgUrl, sid: _sid, label: orgLabel(_orgUrl) });
  for (const s of _allSessions) {
    if (!sessMap.has(s.orgUrl)) sessMap.set(s.orgUrl, { orgUrl: s.orgUrl, sid: s.sid, label: orgLabel(s.orgUrl) });
  }
  for (const o of _storedOrgs) {
    if (o.url && o.sid && !sessMap.has(o.url)) {
      sessMap.set(o.url, { orgUrl: o.url, sid: o.sid, label: o.label || orgLabel(o.url), stored: true });
    }
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

  // ── Source/target derived from the active profile, not from user input. ──
  // Earlier UX let the user re-pick orgs at the Transfer page; that duplicated
  // state, made "wrong org" mistakes easy, and meant a profile + an org pair
  // were two separate concepts in the user's head. They're one thing now.
  function refreshTransferOrgsFromProfile() {
    if (!_transferProfile) { _transferSrc = null; _transferTgt = null; return; }
    _transferSrc = _resolveSession(_transferProfile.sourceOrg, allSess);
    _transferTgt = _resolveSession(_transferProfile.targetOrg, allSess);
  }
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
          <label class="ds-transfer-option-label" for="dsTrConflict">On existing record:</label>
          <select id="dsTrConflict" class="ds-select ds-select-sm" style="width:auto">
            <option value="skip" ${_transferConflict === 'skip' ? 'selected' : ''}>Skip</option>
            <option value="overwrite" ${_transferConflict === 'overwrite' ? 'selected' : ''}>Overwrite</option>
          </select>
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
  eid('dsTrConflict')?.addEventListener('change', e => { _transferConflict = e.target.value; });
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

  const p   = _transferProfile;
  const src = p.sourceOrg ? _resolveSession(p.sourceOrg, _buildAllSessions()) : null;
  const tgt = p.targetOrg ? _resolveSession(p.targetOrg, _buildAllSessions()) : null;

  function chip(url, sess, role) {
    if (!url) {
      return `<div class="ds-tr-org-chip ds-tr-org-chip-missing">
        <div class="ds-tr-org-chip-role">${role}</div>
        <div class="ds-tr-org-chip-warn">⚠ Not set — open Edit profile</div>
      </div>`;
    }
    const reachable = !!sess;
    return `<div class="ds-tr-org-chip ${reachable ? '' : 'ds-tr-org-chip-unreachable'}">
      <div class="ds-tr-org-chip-role">${role}</div>
      <div class="ds-tr-org-chip-label">${esc(orgLabel(url))}</div>
      <div class="ds-tr-org-chip-status">
        ${reachable
          ? `<span style="color:#2E844A">●</span> Session ready${sess.stored ? ' 🔐' : ''}`
          : '<span style="color:#EA001E">●</span> Not open in Chrome — open it or add credentials'}
      </div>
    </div>`;
  }

  wrap.innerHTML = `
    <div class="ds-tr-org-pair">
      ${chip(p.sourceOrg, src, 'Source')}
      <span class="ds-tr-org-arrow">→</span>
      ${chip(p.targetOrg, tgt, 'Target')}
    </div>`;
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
    const filterBtn = canFilter
      ? `<button class="ds-btn ds-btn-xs ds-tr-filter-btn" data-tr-filter-path="${esc(pathKey)}" data-tr-filter-obj="${esc(name)}"
           title="${isOverride ? 'Edit run-time filter' : 'Filter records for this run'}">
           ${isOverride || ef.recordIds?.length || ef.where ? '🎯 Edit Filter' : '🎯 Filter'}
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
          const valList = anchorValues.map(v => `'${String(v).replace(/'/g, "\\'")}'`).join(',');
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

  logRow('📤', `Starting transfer of profile "${_transferProfile.name}"…`);

  const result = await sendBg({
    type:             'SF_EXECUTE_PROFILE_TRANSFER',
    profile:          buildTransferProfile(),   // patched clone with run-time filter overrides
    srcOrgUrl:        _transferSrc.orgUrl,
    srcSid:           _transferSrc.sid,
    tgtOrgUrl:        _transferTgt.orgUrl,
    tgtSid:           _transferTgt.sid,
    conflictStrategy: _transferConflict   // Feature 6
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
    srcOrgUrl: _transferSrc?.orgUrl,
    tgtOrgUrl: _transferTgt?.orgUrl,
    startedAt: new Date().toISOString(),
    ...result
  });
  await storageSaveHistory();

  // After ANY transfer that wrote records, the diff is stale. Re-scan in
  // the background so the next picker open (or card render) reflects the
  // new target state. Fire-and-forget — failures are non-fatal and surface
  // as toasts. Only triggers when at least one record was created (not on
  // pure-failed runs where we already know nothing changed in target).
  if (_transferProfile?.id && !_transferDryRun) {
    const totalCreated = Object.values(result.summary || {}).reduce((n, s) => n + (s.created || 0), 0);
    if (totalCreated > 0) {
      refreshProfileDiff(_transferProfile.id).catch(() => { /* surfaced via toast */ });
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
// SCHEDULE
// ════════════════════════════════════════════════════════════════
function renderSchedule() {
  // Scheduled transfers run in the background service worker — the browser
  // session (cookie-based SID) will be gone when the alarm fires.
  // Only orgs connected with a username + password can be re-authenticated
  // automatically.  Tab-only sessions must NOT appear in the schedule form.
  const credOrgs = _storedOrgs.filter(o => o.username && o.password);

  if (!_profiles.length) {
    setMain(`
      <div class="ds-view-header"><h2 class="ds-view-title">📅 Schedule</h2></div>
      <div class="ds-empty-page">
        <div class="ds-empty-icon">📅</div>
        <div class="ds-empty-title">No profiles yet</div>
        <div class="ds-empty-sub">Create a profile first, then schedule it to run automatically.</div>
      </div>`);
    return;
  }

  const INTERVALS = [
    { label: 'Every 15 minutes', value: 15 },
    { label: 'Every 30 minutes', value: 30 },
    { label: 'Every hour',       value: 60 },
    { label: 'Every 6 hours',    value: 360 },
    { label: 'Every 12 hours',   value: 720 },
    { label: 'Every 24 hours',   value: 1440 }
  ];

  const scheduledProfiles = _profiles.filter(p => p.schedule?.enabled);
  const unscheduled       = _profiles.filter(p => !p.schedule?.enabled);

  // Flag existing schedules whose orgs no longer have stored credentials.
  function schedMissingCreds(p) {
    return !credOrgs.some(o => o.url === p.schedule?.sourceOrg)
        || !credOrgs.some(o => o.url === p.schedule?.targetOrg);
  }

  // Hard gate shown when not enough credential-backed orgs are available.
  const credsGateHtml = `
    <div class="ds-empty-page" style="margin-top:32px">
      <div class="ds-empty-icon">🔐</div>
      <div class="ds-empty-title">Stored credentials required</div>
      <div class="ds-empty-sub">
        Scheduled transfers run in the background — your browser session won't be
        available when the timer fires.<br><br>
        You need <strong>at least 2 orgs</strong> connected with a username &amp; password
        to create a schedule.
        ${credOrgs.length === 1
          ? `<br><span style="color:#27ae60;margin-top:8px;display:inline-block">✅ 1 org ready — add credentials for at least one more.</span>`
          : `<br><span style="color:#e07b39;margin-top:8px;display:inline-block">⚠️ No orgs with stored credentials found.</span>`}
      </div>
      <button class="ds-btn ds-btn-primary" id="dsSchedGoToOrgs" style="margin-top:20px">🔌 Go to Connected Orgs</button>
    </div>`;

  setMain(`
    <div class="ds-view-header">
      <h2 class="ds-view-title">📅 Schedule</h2>
    </div>

    ${scheduledProfiles.length ? `
    <div class="ds-section-title">Active Schedules</div>
    <div class="ds-sched-list">
      ${scheduledProfiles.map(p => {
        const missingCreds = schedMissingCreds(p);
        return `
        <div class="ds-sched-card">
          <div class="ds-sched-card-header">
            <span class="ds-sched-card-name">${esc(p.name)}</span>
            <span class="ds-chip ds-chip-active">● active</span>
            ${missingCreds ? `<span class="ds-chip" style="background:#FFF3CD;color:#856404;border:1px solid #FFC107;margin-left:6px">⚠ credentials missing</span>` : ''}
          </div>
          <div class="ds-sched-card-meta">
            ${esc(orgLabel(p.schedule.sourceOrg))} → ${esc(orgLabel(p.schedule.targetOrg))}
            · every ${p.schedule.intervalMinutes} min
          </div>
          ${missingCreds ? `<div style="font-size:11px;color:#856404;padding:4px 0">One or more orgs no longer have stored credentials — this schedule will fail when the session expires. Re-add credentials in <strong>Connected Orgs</strong> or disable this schedule.</div>` : ''}
          <div class="ds-sched-card-actions">
            <button class="ds-btn ds-btn-sm ds-btn-danger" data-dsaction="disableSchedule" data-arg="${p.id}">⏹ Disable</button>
          </div>
        </div>`;
      }).join('')}
    </div>` : ''}

    ${credOrgs.length < 2 ? credsGateHtml : unscheduled.length ? `
    <div class="ds-section-title" style="margin-top:${scheduledProfiles.length?'24px':'0'}">Schedule a Profile</div>
    <div class="ds-sched-new-form">
      <div class="ds-field-group">
        <label class="ds-lbl">Profile</label>
        <select id="dsSchedProfile" class="ds-select">
          <option value="">— Select a profile —</option>
          ${unscheduled.map((p,i) => `<option value="${i}">${esc(p.name)}</option>`).join('')}
        </select>
      </div>
      <div class="ds-sched-new-row">
        <div class="ds-field-group">
          <label class="ds-lbl">Source Org</label>
          <select id="dsSchedSrc" class="ds-select">
            <option value="">— Select source —</option>
            ${credOrgs.map((o,i) => `<option value="${i}">${esc(orgLabel(o.url))} · ${esc(o.username)}</option>`).join('')}
          </select>
        </div>
        <span class="ds-transfer-arrow" style="margin-top:20px">→</span>
        <div class="ds-field-group">
          <label class="ds-lbl">Target Org</label>
          <select id="dsSchedTgt" class="ds-select">
            <option value="">— Select target —</option>
            ${credOrgs.map((o,i) => `<option value="${i}">${esc(orgLabel(o.url))} · ${esc(o.username)}</option>`).join('')}
          </select>
        </div>
        <div class="ds-field-group">
          <label class="ds-lbl">Interval</label>
          <select id="dsSchedInterval" class="ds-select">
            ${INTERVALS.map(iv => `<option value="${iv.value}">${iv.label}</option>`).join('')}
          </select>
        </div>
      </div>
      <label class="ds-sched-snapshot-opt" title="After each scheduled run, fingerprint both orgs so the Org Map drift overlay reflects real state without re-querying live">
        <input type="checkbox" id="dsSchedSnapshot" checked>
        <span>📸 Refresh org snapshots after each run — powers the drift overlay on the Org Map</span>
      </label>
      <button class="ds-btn ds-btn-primary" id="dsSchedSaveBtn">📅 Enable Schedule</button>
    </div>
    <div id="dsSchedMsg"></div>` : ''}
  `);

  window._dsSchedCredOrgs = credOrgs;

  // Navigate to Connected Orgs — wired for the gate block button.
  function goToOrgs() {
    document.querySelectorAll('.ds-nav-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.view === 'orgs'));
    _currentView = 'orgs';
    renderView('orgs');
  }
  eid('dsSchedGoToOrgs')?.addEventListener('click', goToOrgs);

  eid('dsSchedSaveBtn')?.addEventListener('click', async () => {
    const profileEl  = eid('dsSchedProfile');
    const srcEl      = eid('dsSchedSrc');
    const tgtEl      = eid('dsSchedTgt');
    const intervalEl = eid('dsSchedInterval');
    if (!profileEl?.value || !srcEl?.value || !tgtEl?.value) return;

    const profile  = unscheduled[parseInt(profileEl.value, 10)];
    const srcOrg   = credOrgs[parseInt(srcEl.value, 10)];
    const tgtOrg   = credOrgs[parseInt(tgtEl.value, 10)];
    const interval = parseInt(intervalEl?.value || '60', 10);

    if (!profile || !srcOrg || !tgtOrg) return;
    if (srcOrg.url === tgtOrg.url) {
      const msgEl = eid('dsSchedMsg');
      if (msgEl) msgEl.innerHTML = `<div class="ds-error-inline">Source and target org must be different.</div>`;
      return;
    }

    const snapshotOpt = eid('dsSchedSnapshot')?.checked ?? true;

    profile.schedule = {
      enabled:               true,
      sourceOrg:             srcOrg.url,
      targetOrg:             tgtOrg.url,
      intervalMinutes:       interval,
      refreshSnapshotAfter:  snapshotOpt
    };
    profile.updatedAt = new Date().toISOString();

    const idx = _profiles.findIndex(p => p.id === profile.id);
    if (idx !== -1) _profiles[idx] = profile;

    await storageSaveProfiles();
    await sendBg({ type: 'DS_SCHEDULE_SET', profileId: profile.id, schedule: profile.schedule });
    renderSchedule();
  });
}

window.disableSchedule = async function(profileId) {
  const profile = _profiles.find(p => p.id === profileId);
  if (profile) {
    delete profile.schedule;
    profile.updatedAt = new Date().toISOString();
    await storageSaveProfiles();
    await sendBg({ type: 'DS_SCHEDULE_CLEAR', profileId });
    renderSchedule();
  }
};

// ════════════════════════════════════════════════════════════════
// HISTORY
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
      ${sorted.map(run => `
        <div class="ds-history-card">
          <div class="ds-history-card-header">
            <span class="ds-run-status-badge ds-run-status-${run.status}">
              ${run.status === 'success' ? '✅' : run.status === 'partial' ? '⚠' : '❌'} ${run.status}
            </span>
            <span class="ds-history-profile-name">${esc(run.profileName || 'Unknown profile')}</span>
            ${run.scheduledRun ? '<span class="ds-chip">📅 scheduled</span>' : ''}
            <span class="ds-history-time">${timeAgo(run.startedAt)}</span>
          </div>
          <div class="ds-history-orgs">
            ${esc(orgLabel(run.sourceOrg || ''))} → ${esc(orgLabel(run.targetOrg || ''))}
          </div>
          <div class="ds-history-summary">
            ${Object.entries(run.summary || {}).map(([obj, s]) =>
              `<span class="ds-summary-chip">${esc(obj)}: ${s.created || 0}↑${s.failed ? ' '+s.failed+'✗' : ''}</span>`
            ).join('')}
          </div>
          ${(run.errors || []).length ? `
            <details class="ds-history-errors">
              <summary>${run.errors.length} error${run.errors.length!==1?'s':''}</summary>
              ${run.errors.map(e => `<div class="ds-history-err-row">❌ ${esc(e)}</div>`).join('')}
            </details>` : ''}
        </div>`).join('')}
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
function showAddOrgModal() {
  // If the credential vault is on but locked, unlock first — otherwise the new
  // password would be written to disk as plaintext (the vault can't encrypt
  // without the in-memory key).
  if (window.SFTKVault && SFTKVault.isEnabled() && !SFTKVault.isUnlocked()) {
    promptVaultUnlock().then(ok => { if (ok) showAddOrgModal(); });
    return;
  }
  showModal(`
    <div class="ds-modal-header">🔐 Add Org with Credentials</div>
    <div class="ds-modal-body">
      <div style="font-size:11.5px;color:var(--subtext);margin:-2px 0 14px;padding:8px 10px;background:#eef5fb;border-left:3px solid var(--brand,#0176D3);border-radius:3px">
        <strong>Credentials are only needed for scheduled transfers</strong> — background runs that fire without a Chrome tab open.
        For one-off transfers, you can use the org as long as it's open in another tab and skip this dialog.
      </div>
      <div class="ds-org-edit-row">
        <label class="ds-lbl">Org Type</label>
        <select id="dsAOType" class="ds-input">
          <option value="production">Production / Developer Edition</option>
          <option value="sandbox">Sandbox (test.salesforce.com)</option>
          <option value="custom">Custom Domain / My Domain</option>
        </select>
      </div>
      <!-- Custom domain row — shown only when type = custom -->
      <div class="ds-org-edit-row" id="dsAOCustomRow" style="display:none">
        <label class="ds-lbl">Login URL</label>
        <input id="dsAOCustomUrl" class="ds-input" type="text"
               placeholder="https://myorg.my.salesforce.com"
               autocomplete="off">
        <div style="font-size:11px;color:var(--subtext);margin-top:4px">
          Enter your org's My Domain URL. The SOAP endpoint will be appended automatically.
        </div>
      </div>
      <div class="ds-org-edit-row">
        <label class="ds-lbl">Username</label>
        <input id="dsAOUsername" class="ds-input" type="text" placeholder="user@example.com" autocomplete="username">
      </div>
      <div class="ds-org-edit-row">
        <label class="ds-lbl">Password + Security Token</label>
        <input id="dsAOPassword" class="ds-input" type="password" placeholder="passwordSECURITYTOKEN" autocomplete="current-password">
        <div style="font-size:11px;color:var(--subtext);margin-top:4px">
          Append your security token directly to your password (e.g. <code>MyPass1234TOKEN</code>)
          unless you're logging in from a trusted IP range.
        </div>
      </div>
      <div class="ds-org-edit-row">
        <label class="ds-lbl">Nickname <span style="font-weight:400;color:var(--subtext)">(optional)</span></label>
        <input id="dsAONickname" class="ds-input" type="text" placeholder="e.g. Production, QA Sandbox">
      </div>
      <div id="dsAOError" style="display:none;background:#FEE2E2;border:1px solid #FCA5A5;border-radius:6px;padding:8px 12px;font-size:12px;color:#B91C1C;margin-top:8px"></div>
    </div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn ds-btn-primary" id="dsAOConnect">🔐 Connect</button>
    </div>`);

  setTimeout(() => {
    eid('dsAOUsername')?.focus();

    // Show/hide custom domain row based on org type
    eid('dsAOType')?.addEventListener('change', () => {
      const isCustom = eid('dsAOType')?.value === 'custom';
      const row = eid('dsAOCustomRow');
      if (row) row.style.display = isCustom ? '' : 'none';
    });

    function tryConnect() { eid('dsAOConnect')?.click(); }
    [eid('dsAOUsername'), eid('dsAOPassword'), eid('dsAONickname'), eid('dsAOCustomUrl')].forEach(el => {
      el?.addEventListener('keydown', e => { if (e.key === 'Enter') tryConnect(); });
    });

    eid('dsAOConnect')?.addEventListener('click', async () => {
      const type     = eid('dsAOType')?.value || 'production';
      const username = eid('dsAOUsername')?.value.trim();
      const password = eid('dsAOPassword')?.value;
      const nickname = eid('dsAONickname')?.value.trim();
      const errEl    = eid('dsAOError');

      if (!username || !password) {
        if (errEl) { errEl.textContent = 'Username and password are required.'; errEl.style.display = ''; }
        return;
      }

      // Build login URL based on org type
      let loginUrl;
      if (type === 'sandbox') {
        loginUrl = 'https://test.salesforce.com/services/Soap/u/62.0';
      } else if (type === 'custom') {
        let customBase = (eid('dsAOCustomUrl')?.value || '').trim().replace(/\/$/, '');
        if (!customBase) {
          if (errEl) { errEl.textContent = 'Please enter a custom login URL.'; errEl.style.display = ''; }
          return;
        }
        // Accept both bare domain and full URL
        if (!customBase.startsWith('http')) customBase = 'https://' + customBase;
        loginUrl = customBase + '/services/Soap/u/62.0';
      } else {
        loginUrl = 'https://login.salesforce.com/services/Soap/u/62.0';
      }

      const btn = eid('dsAOConnect');
      if (btn) { btn.disabled = true; btn.textContent = '⏳ Connecting…'; }
      if (errEl) errEl.style.display = 'none';

      const res = await sendBg({ type: 'DS_SOAP_LOGIN', loginUrl, username, password });

      if (res.error) {
        if (errEl) {
          // Detect the "SOAP API login disabled" platform error — this is the
          // most common failure for newer Dev/Scratch orgs and the raw text
          // gives users nothing actionable. Replace it with concrete steps.
          const isSoapDisabled = /SOAP API login\(\)/i.test(res.error) ||
                                 /INVALID_OPERATION/i.test(res.error);
          if (isSoapDisabled) {
            // Try to derive the base URL for a Setup deep-link
            let setupBase = '';
            try {
              const u = new URL(loginUrl);
              setupBase = u.protocol + '//' + u.hostname;
              // If they used login.salesforce.com (production default) we can't
              // link to setup — that endpoint doesn't host a real org UI. In that
              // case fall back to the org URL the user typed (if custom).
              if (u.hostname === 'login.salesforce.com' || u.hostname === 'test.salesforce.com') {
                const typedBase = (eid('dsAOCustomUrl')?.value || '').trim();
                if (typedBase) setupBase = typedBase.replace(/\/$/, '').replace(/^([^/]+)\/services\/.+$/, '$1');
              }
            } catch (_) {}
            const setupHref = setupBase
              ? `${setupBase}/lightning/setup/SessionSettings/home`
              : '';
            errEl.innerHTML =
              `<strong>SOAP API login is disabled in this org.</strong><br>` +
              `Newer Developer / Scratch orgs ship with this off by default. You have two options:` +
              `<ul style="margin:8px 0 4px;padding-left:18px;line-height:1.55">` +
              `  <li><strong>Skip this dialog.</strong> If you only need <em>one-off</em> transfers, just keep the org open in another Chrome tab — the Data Deployment page will use that session automatically. Credentials are only required for <em>scheduled</em> background runs.</li>` +
              `  <li><strong>Enable SOAP API login in Salesforce</strong>${setupHref ? ` (<a href="${esc(setupHref)}" target="_blank" rel="noopener" style="color:#B91C1C;text-decoration:underline">open Session Settings ↗</a>)` : ''}:<br>` +
              `    &nbsp;&nbsp;1. Setup → Identity → <em>Session Settings</em><br>` +
              `    &nbsp;&nbsp;2. Find <em>"Enable user switching"</em> isn't the right one — scroll to <em>"API"</em> section and uncheck <em>"Require HttpOnly attribute"</em> if blocking, or<br>` +
              `    &nbsp;&nbsp;3. Setup → Users → Profiles → System Administrator → System Permissions → check <em>"API Enabled"</em><br>` +
              `    &nbsp;&nbsp;4. (For scratch orgs) Add <code>SoapApiUserPerm</code> to the scratch-org definition file.</li>` +
              `</ul>`;
          } else {
            // Generic case — keep the raw message
            errEl.textContent = res.error;
          }
          errEl.style.display = '';
        }
        if (btn) { btn.disabled = false; btn.textContent = '🔐 Connect'; }
        return;
      }

      // Register org in map
      const id    = genId('org');
      const label = nickname || username.split('@')[0];
      _storedOrgs.push({
        id, url: res.orgUrl, orgId: res.orgId, userId: res.userId,
        username, password,
        label, type,
        sid: res.sid,
        loginUrl,
        lastConnected: new Date().toISOString(),
        position: null
      });
      await saveStoredOrgs();

      // Also register in _orgs for orgLabel() lookups
      upsertOrg(res.orgUrl, label);
      await storageSaveOrgs();

      closeModal();
      showToast(`Connected: ${label} ✓`, 'success');
      renderOrgMap();
    });
  }, 50);
}

// ════════════════════════════════════════════════════════════════
// SCAN MAP
// ════════════════════════════════════════════════════════════════
// Feature 8: Drift alert badge on Scan Map nav button
function updateScanDriftBadge() {
  const navBtn = document.querySelector('.ds-nav-btn[data-view="scans"]');
  if (!navBtn) return;

  // Check if any scan has drift in its latest result
  const hasDrift = _scans.some(scan => {
    const last = [..._scanResults]
      .filter(r => r.scanId === scan.id)
      .sort((a, b) => (b.ranAt || '').localeCompare(a.ranAt || ''))[0];
    return last && (last.changedCount > 0 || last.missingInTargetCount > 0 || last.onlyInTargetCount > 0);
  });

  // Remove existing badge
  navBtn.querySelector('.ds-drift-badge')?.remove();

  if (hasDrift) {
    const badge = document.createElement('span');
    badge.className = 'ds-drift-badge';
    badge.textContent = '●';
    badge.title = 'Drift detected in one or more scans';
    navBtn.querySelector('.ds-nav-label')?.appendChild(badge);
  }
}

function renderScanMap() {
  const orgs = allMapOrgs();

  const scanCards = _scans.map(scan => {
    const srcOrg  = orgs.find(o => o.id === scan.sourceOrgId);
    const tgtOrg  = orgs.find(o => o.id === scan.targetOrgId);
    const srcLbl  = srcOrg ? (srcOrg.label || orgLabel(srcOrg.url)) : '(unknown org)';
    const tgtLbl  = tgtOrg ? (tgtOrg.label || orgLabel(tgtOrg.url)) : '(unknown org)';
    const profile  = scan.profileId ? _profiles.find(p => p.id === scan.profileId) : null;
    const conn     = scan.connectionId ? _connections.find(c => c.id === scan.connectionId) : null;

    const lastResult = [..._scanResults]
      .filter(r => r.scanId === scan.id)
      .sort((a, b) => (b.ranAt || '').localeCompare(a.ranAt || ''))[0];

    const schedText = scan.schedule?.enabled
      ? `📅 Every ${scan.schedule.intervalMinutes} min`
      : '⏸ Manual only';

    const statsHtml = lastResult ? `
      <div class="ds-scan-result-summary">
        <div class="ds-scan-stat ds-scan-stat-match">
          <div class="ds-scan-stat-num">${lastResult.matchCount || 0}</div>
          <div class="ds-scan-stat-lbl">Identical</div>
        </div>
        <div class="ds-scan-stat ds-scan-stat-changed">
          <div class="ds-scan-stat-num">${lastResult.changedCount || 0}</div>
          <div class="ds-scan-stat-lbl">Changed</div>
        </div>
        <div class="ds-scan-stat ds-scan-stat-missing">
          <div class="ds-scan-stat-num">${lastResult.missingInTargetCount || 0}</div>
          <div class="ds-scan-stat-lbl">Missing in target</div>
        </div>
        <div class="ds-scan-stat ds-scan-stat-extra">
          <div class="ds-scan-stat-num">${lastResult.onlyInTargetCount || 0}</div>
          <div class="ds-scan-stat-lbl">Only in target</div>
        </div>
      </div>
      <div style="font-size:11px;color:var(--subtext);margin-top:4px">Last run: ${timeAgo(lastResult.ranAt)}</div>` : '';

    return `
      <div class="ds-scan-card" data-scan-id="${scan.id}">
        <div class="ds-scan-card-header">
          <div class="ds-scan-card-title">${esc(scan.name)}</div>
          <div class="ds-scan-card-chips">
            <span class="ds-chip">${esc(scan.objectType)}</span>
            ${profile ? `<span class="ds-chip">📦 ${esc(profile.name)}</span>` : ''}
            ${conn?.label ? `<span class="ds-chip">🔗 ${esc(conn.label)}</span>` : ''}
            ${scan.schedule?.enabled ? `<span class="ds-chip ds-chip-sched">📅 scheduled</span>` : ''}
          </div>
        </div>
        <div class="ds-scan-card-orgs">
          <span class="ds-scan-org">${esc(srcLbl)}</span>
          <span style="color:var(--subtext);margin:0 8px">⟷</span>
          <span class="ds-scan-org">${esc(tgtLbl)}</span>
        </div>
        <div class="ds-scan-card-meta">
          ${schedText}
          ${scan.where ? ` · WHERE ${esc(scan.where.substring(0, 60))}${scan.where.length > 60 ? '…' : ''}` : ''}
        </div>
        ${statsHtml}
        <div class="ds-scan-card-actions">
          <button class="ds-btn ds-btn-sm ds-btn-primary" data-dsaction="runScanNow" data-arg="${scan.id}">▶ Run Now</button>
          ${lastResult ? `<button class="ds-btn ds-btn-sm" data-dsaction="viewScanResult" data-arg="${lastResult.id}">📊 Results</button>` : ''}
          <button class="ds-btn ds-btn-sm" data-dsaction="editScan" data-arg="${scan.id}">✏ Edit</button>
          <button class="ds-btn ds-btn-sm ds-btn-danger" data-dsaction="deleteScan" data-arg="${scan.id}">🗑</button>
        </div>
      </div>`;
  }).join('');

  const orgOptions = orgs.map(o =>
    `<option value="${o.id}">${esc(o.label || orgLabel(o.url))}</option>`
  ).join('');

  setMain(`
    <div class="ds-view-header">
      <div class="ds-view-title-wrap">
        <h2 class="ds-view-title">🔍 Scan Map</h2>
        <div class="ds-view-subtitle">Compare records between orgs — find what's missing, changed, or extra</div>
      </div>
      <button class="ds-btn ds-btn-primary" id="dsNewScanBtn">+ New Scan</button>
    </div>

    <!-- Content area: empty state OR scan list (hidden when form is open) -->
    <div id="dsScanContent">
      ${!_scans.length ? `
        <div class="ds-empty-page">
          <div class="ds-empty-icon">🔍</div>
          <div class="ds-empty-title">No scans configured yet</div>
          <div class="ds-empty-sub">Click <strong>+ New Scan</strong> to set up a comparison between two orgs.</div>
        </div>` : `
        <div class="ds-scan-list">
          ${scanCards}
        </div>`}
    </div>

    <div id="dsScanResultDetail" style="display:none"></div>

    <!-- New / edit scan form — replaces content area when open -->
    <div id="dsScanNewForm" class="ds-scan-new-form" style="display:none">

      <!-- ── Profile ────────────────────────────────────────── -->
      <!-- Picking a profile auto-fills source + target orgs (the profile
           carries them now) and provides the object type + WHERE clause. -->
      ${_profiles.length ? `
      <div class="ds-field-group">
        <label class="ds-lbl">Profile
          <span style="font-weight:400;color:var(--subtext)">— provides object, orgs &amp; filter</span>
        </label>
        <select id="dsSFProfilePick" class="ds-select" style="max-width:500px">
          <option value="">— Pick a profile —</option>
          ${_profiles.map(p => `<option value="${p.id}" data-src="${esc(p.sourceOrg || '')}" data-tgt="${esc(p.targetOrg || '')}">${esc(p.name)}${p.sourceOrg && p.targetOrg ? '' : ' ⚠ no orgs set'}</option>`).join('')}
        </select>
      </div>` : `
      <div class="ds-scan-no-connections">
        No deployment profiles yet. <a class="ds-link" data-dsaction="switchView" data-arg="profiles">Go to Data Deployment</a> to create one.
      </div>`}

      <!-- ── Source + Target orgs (overridable from the profile defaults) ── -->
      <div class="ds-field-group" id="dsSFOrgsRow" style="display:flex;gap:12px;max-width:680px">
        <div style="flex:1">
          <label class="ds-lbl">Source Org</label>
          <select id="dsSFSrcPicker" class="ds-select">
            <option value="">— Select —</option>
            ${allMapOrgs().map(o => `<option value="${esc(o.url)}">${esc(o.label || orgLabel(o.url))}</option>`).join('')}
          </select>
        </div>
        <div style="flex:1">
          <label class="ds-lbl">Target Org</label>
          <select id="dsSFTgtPicker" class="ds-select">
            <option value="">— Select —</option>
            ${allMapOrgs().map(o => `<option value="${esc(o.url)}">${esc(o.label || orgLabel(o.url))}</option>`).join('')}
          </select>
        </div>
      </div>

      <!-- ── Scan Name ──────────────────────────────────────── -->
      <div class="ds-field-group" style="max-width:380px">
        <label class="ds-lbl">Scan Name</label>
        <input id="dsSFName" class="ds-input" placeholder="e.g. Contacts check">
      </div>

      <!-- ── Schedule ────────────────────────────────────────── -->
      <div class="ds-scan-schedule-row">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
          <input type="checkbox" id="dsSFSchedEnable">
          Schedule automatic scans
        </label>
        <div id="dsSFSchedOptions" style="display:none;margin-top:10px">
          <select id="dsSFSchedInterval" class="ds-select" style="width:220px">
            <option value="15">Every 15 minutes</option>
            <option value="30">Every 30 minutes</option>
            <option value="60" selected>Every hour</option>
            <option value="360">Every 6 hours</option>
            <option value="720">Every 12 hours</option>
            <option value="1440">Every 24 hours</option>
          </select>
        </div>
      </div>

      <!-- hidden inputs carry src/tgt/obj/where resolved at save time from connection+profile -->
      <input type="hidden" id="dsSFSrcOrg">
      <input type="hidden" id="dsSFTgtOrg">
      <input type="hidden" id="dsSFObj">
      <input type="hidden" id="dsSFWhere">
      <input type="hidden" id="dsSFMatchField" value="Name">
      <input type="hidden" id="dsSFCompareFields" value="">

      <div id="dsSFError"
           style="display:none;background:#FEE2E2;border:1px solid #FCA5A5;border-radius:6px;
                  padding:8px 12px;font-size:12px;color:#B91C1C;margin-top:4px"></div>

      <div style="display:flex;gap:8px">
        <button class="ds-btn" id="dsSFCancel">Cancel</button>
        <button class="ds-btn ds-btn-primary" id="dsSFSave">💾 Save Scan</button>
      </div>
    </div>
  `);

  // ── Normalize SF API name casing: "contact" → "Contact" ────────
  function normalizeApiName(raw) {
    if (!raw) return '';
    return raw.split('__').map(seg => seg.charAt(0).toUpperCase() + seg.slice(1)).join('__');
  }

  // ── Profile picker: auto-fill source + target orgs from the profile ─
  // Profiles now carry their own sourceOrg + targetOrg URLs (since the
  // _connections concept was removed). Picking a profile pre-fills the two
  // org dropdowns so a typical scan is one click.
  eid('dsSFProfilePick')?.addEventListener('change', () => {
    const sel = eid('dsSFProfilePick');
    const opt = sel?.options[sel.selectedIndex];
    if (!opt || !opt.value) return;
    const srcSel = eid('dsSFSrcPicker');
    const tgtSel = eid('dsSFTgtPicker');
    if (srcSel && opt.dataset.src) srcSel.value = opt.dataset.src;
    if (tgtSel && opt.dataset.tgt) tgtSel.value = opt.dataset.tgt;
    // Auto-fill scan name if blank
    const nameIn = eid('dsSFName');
    if (nameIn && !nameIn.value.trim()) {
      const profile = _profiles.find(p => p.id === opt.value);
      nameIn.value = profile ? profile.name : opt.text;
    }
  });

  // ── Form open / close ───────────────────────────────────────────
  function openScanForm() {
    eid('dsScanContent').style.display = 'none';
    eid('dsScanNewForm').style.display = '';
    eid('dsNewScanBtn').style.display  = 'none';
    eid('dsSFName')?.focus();
  }

  function closeScanForm() {
    eid('dsScanNewForm').style.display  = 'none';
    eid('dsScanContent').style.display  = '';
    eid('dsNewScanBtn').style.display   = '';
  }

  eid('dsNewScanBtn')?.addEventListener('click', openScanForm);
  eid('dsSFCancel')?.addEventListener('click', closeScanForm);
  eid('dsSFSchedEnable')?.addEventListener('change', e => {
    eid('dsSFSchedOptions').style.display = e.target.checked ? '' : 'none';
  });
  eid('dsSFSave')?.addEventListener('click', () => saveScanConfig(null));

  // Feature 8: Update drift badge after rendering
  updateScanDriftBadge();
}

// ── Save / update a scan configuration ────────────────────────
async function saveScanConfig(existingId) {
  const errEl = eid('dsSFError');
  if (errEl) errEl.style.display = 'none';

  const name = eid('dsSFName')?.value.trim();

  // ── Resolve source + target org from the two pickers ──────────
  // Pickers carry the org URL directly (no more _connections layer).
  const srcUrl  = eid('dsSFSrcPicker')?.value || '';
  const tgtUrl  = eid('dsSFTgtPicker')?.value || '';
  // Map URLs back to stable org IDs so the scan persists across renames.
  const allOrgsList = allMapOrgs();
  const srcId   = allOrgsList.find(o => o.url === srcUrl)?.id || '';
  const tgtId   = allOrgsList.find(o => o.url === tgtUrl)?.id || '';

  // ── Resolve object type + WHERE from profile ──────────────────
  const profileId = eid('dsSFProfilePick')?.value || '';
  const profile   = profileId ? _profiles.find(p => p.id === profileId) : null;

  function normalizeApiName(raw) {
    if (!raw) return '';
    return raw.split('__').map(seg => seg.charAt(0).toUpperCase() + seg.slice(1)).join('__');
  }

  const obj      = normalizeApiName(profile?.tree?.objectType || '');
  const whereRaw = profile?.tree?.where || '';

  const schedEnabled  = eid('dsSFSchedEnable')?.checked || false;
  const schedInterval = parseInt(eid('dsSFSchedInterval')?.value || '60', 10);

  // ── Validation ────────────────────────────────────────────────
  if (!name) {
    if (errEl) { errEl.textContent = 'Please enter a Scan Name.'; errEl.style.display = ''; }
    return;
  }
  if (!profileId || !obj) {
    if (errEl) { errEl.textContent = 'Please select a Profile — it defines what object to compare.'; errEl.style.display = ''; }
    return;
  }
  if (!srcId || !tgtId) {
    if (errEl) { errEl.textContent = 'Please select both a Source and a Target org.'; errEl.style.display = ''; }
    return;
  }
  if (srcId === tgtId) {
    if (errEl) { errEl.textContent = 'Source and target org must be different.'; errEl.style.display = ''; }
    return;
  }

  if (existingId) {
    const scan = _scans.find(s => s.id === existingId);
    if (scan) {
      Object.assign(scan, {
        name, objectType: obj, sourceOrgId: srcId, targetOrgId: tgtId,
        profileId: profileId || null, connectionId: conn?.id || null,
        matchField: 'Name', compareFields: [], where: whereRaw,
        schedule: schedEnabled ? { enabled: true, intervalMinutes: schedInterval } : { enabled: false }
      });
      await saveScans();
      if (schedEnabled) await sendBg({ type: 'DS_SCAN_ALARM_SET', scanId: scan.id, intervalMinutes: schedInterval });
      else              await sendBg({ type: 'DS_SCAN_ALARM_CLEAR', scanId: scan.id });
    }
  } else {
    const scan = {
      id: genId('scan'),
      name, objectType: obj, sourceOrgId: srcId, targetOrgId: tgtId,
      profileId: profileId || null, connectionId: conn?.id || null,
      matchField: 'Name', compareFields: [], where: whereRaw,
      schedule: schedEnabled ? { enabled: true, intervalMinutes: schedInterval } : { enabled: false },
      createdAt: new Date().toISOString()
    };
    _scans.push(scan);
    await saveScans();
    if (schedEnabled) await sendBg({ type: 'DS_SCAN_ALARM_SET', scanId: scan.id, intervalMinutes: schedInterval });
    showToast(`Scan "${name}" created ✓`, 'success');
  }

  renderScanMap();
}

// ── Edit scan (pre-fill form) ──────────────────────────────────
window.editScan = function(scanId) {
  const scan = _scans.find(s => s.id === scanId);
  if (!scan) return;

  const formEl = eid('dsScanNewForm');
  if (!formEl) return;

  // Show form, hide content area + New Scan button
  eid('dsScanContent').style.display = 'none';
  formEl.style.display = '';
  eid('dsNewScanBtn').style.display  = 'none';

  // Restore connection and profile selections
  if (eid('dsSFConn') && scan.connectionId)     eid('dsSFConn').value         = scan.connectionId;
  if (eid('dsSFProfilePick') && scan.profileId) eid('dsSFProfilePick').value  = scan.profileId;
  if (eid('dsSFName'))                          eid('dsSFName').value          = scan.name;

  const schedEnabled = scan.schedule?.enabled || false;
  if (eid('dsSFSchedEnable'))  eid('dsSFSchedEnable').checked = schedEnabled;
  if (eid('dsSFSchedOptions')) eid('dsSFSchedOptions').style.display = schedEnabled ? '' : 'none';
  if (eid('dsSFSchedInterval') && scan.schedule?.intervalMinutes) {
    eid('dsSFSchedInterval').value = String(scan.schedule.intervalMinutes);
  }

  // Rewire save button for this specific scan
  const saveBtn = eid('dsSFSave');
  if (saveBtn) {
    const newBtn = saveBtn.cloneNode(true);
    saveBtn.replaceWith(newBtn);
    newBtn.addEventListener('click', () => saveScanConfig(scanId));
  }

  formEl.scrollIntoView({ behavior: 'smooth' });
};

// ── Delete scan ────────────────────────────────────────────────
window.deleteScan = async function(scanId) {
  showModal(`
    <div class="ds-modal-header">🗑 Delete Scan</div>
    <div class="ds-modal-body">Delete this scan configuration and all its result history? This cannot be undone.</div>
    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="closeModal">Cancel</button>
      <button class="ds-btn ds-btn-danger" id="dsDelScanConfirm">Delete</button>
    </div>`);
  eid('dsDelScanConfirm')?.addEventListener('click', async () => {
    await sendBg({ type: 'DS_SCAN_ALARM_CLEAR', scanId });
    _scans       = _scans.filter(s => s.id !== scanId);
    _scanResults = _scanResults.filter(r => r.scanId !== scanId);
    await saveScans();
    await saveScanResults();
    closeModal();
    renderScanMap();
  });
};

// ════════════════════════════════════════════════════════════════
// SCAN ENGINE — get session, query, compare
// ════════════════════════════════════════════════════════════════

// Resolve a live (orgUrl, sid) pair for a stored or auto-detected org.
// Tries: stored sid → browser session → SOAP re-login with stored creds.
async function getOrgSession(orgId) {
  const orgs = allMapOrgs();
  const org  = orgs.find(o => o.id === orgId);
  if (!org) return null;

  // 1. Stored org with a valid SID (set at SOAP login or on last reconnect)
  const stored = _storedOrgs.find(o => o.id === orgId);
  if (stored?.sid) return { orgUrl: stored.url, sid: stored.sid };

  // 2. Auto-detected browser session
  const browser = _allSessions.find(s => s.orgUrl === org.url)
    || (org.url === _orgUrl ? { orgUrl: _orgUrl, sid: _sid } : null);
  if (browser) return { orgUrl: browser.orgUrl, sid: browser.sid };

  // 3. Re-login via SOAP if we have stored credentials
  if (stored?.username && stored?.password) {
    const loginUrl = (stored.type === 'sandbox' || stored.loginUrl?.includes('test.'))
      ? 'https://test.salesforce.com/services/Soap/u/62.0'
      : 'https://login.salesforce.com/services/Soap/u/62.0';
    const res = await sendBg({ type: 'DS_SOAP_LOGIN', loginUrl, username: stored.username, password: stored.password });
    if (!res.error) {
      stored.sid = res.sid;
      stored.lastConnected = new Date().toISOString();
      await saveStoredOrgs();
      return { orgUrl: stored.url, sid: stored.sid };
    }
  }

  return null;
}

window.runScanNow = async function(scanId) {
  const scan = _scans.find(s => s.id === scanId);
  if (!scan) return;

  // Update button state
  const card  = document.querySelector(`[data-scan-id="${scanId}"]`);
  const runBtn = card?.querySelector('.ds-btn-primary');
  if (runBtn) { runBtn.disabled = true; runBtn.textContent = '⏳ Running…'; }

  try {
    const result = await runScan(scan);
    _scanResults.push(result);
    await saveScanResults();
    recordActivity('scans');
    renderScanMap();
    // Feature 8: update drift badge after new result
    updateScanDriftBadge();
    // Auto-show result
    setTimeout(() => viewScanResult(result.id), 100);
    showToast(`Scan complete — ${result.changedCount} changed, ${result.missingInTargetCount} missing in target`, 'success');
  } catch (e) {
    showToast('Scan failed: ' + e.message, 'error');
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = '▶ Run Now'; }
  }
};

async function runScan(scan) {
  const srcSess = await getOrgSession(scan.sourceOrgId);
  const tgtSess = await getOrgSession(scan.targetOrgId);

  if (!srcSess) throw new Error('Cannot get session for source org — open it in Chrome or add it with credentials');
  if (!tgtSess) throw new Error('Cannot get session for target org — open it in Chrome or add it with credentials');

  const obj   = scan.objectType;
  const match = scan.matchField || 'Name';
  const where = scan.where ? ` WHERE ${scan.where}` : '';

  // Build SELECT list
  const explicitFields = (scan.compareFields || []).filter(f => f && f !== 'Id' && f !== match);
  const selectParts    = ['Id', match, ...explicitFields];
  const selectStr      = [...new Set(selectParts)].join(', ');

  // Query source org
  const srcRes = await sendBg({
    type: 'SF_QUERY_ALL', tooling: false,
    orgUrl: srcSess.orgUrl, sid: srcSess.sid,
    query: `SELECT ${selectStr} FROM ${obj}${where}`
  });
  if (srcRes.error) throw new Error(`Source query failed: ${srcRes.error}`);

  // Query target org — same query
  const tgtRes = await sendBg({
    type: 'SF_QUERY_ALL', tooling: false,
    orgUrl: tgtSess.orgUrl, sid: tgtSess.sid,
    query: `SELECT ${selectStr} FROM ${obj}${where}`
  });
  if (tgtRes.error) throw new Error(`Target query failed: ${tgtRes.error}`);

  const srcRecs = srcRes.records || [];
  const tgtRecs = tgtRes.records || [];

  // Index by match field
  const tgtByKey = {};
  for (const r of tgtRecs) {
    const k = String(r[match] ?? '');
    tgtByKey[k] = r;
  }
  const srcByKey = {};
  for (const r of srcRecs) {
    const k = String(r[match] ?? '');
    srcByKey[k] = r;
  }

  // Determine which fields to compare (exclude system + match key)
  const SKIP_FIELDS = new Set(['Id', 'attributes', 'SystemModstamp', 'LastModifiedDate',
    'LastModifiedById', 'LastReferencedDate', 'LastViewedDate', 'CreatedDate', 'CreatedById']);
  let compareFields;
  if (scan.compareFields?.length) {
    compareFields = scan.compareFields.filter(f => !SKIP_FIELDS.has(f) && f !== match);
  } else {
    // Derive from actual records
    const allFields = new Set([
      ...Object.keys(srcRecs[0] || {}),
      ...Object.keys(tgtRecs[0] || {})
    ]);
    SKIP_FIELDS.forEach(f => allFields.delete(f));
    allFields.delete(match);
    compareFields = [...allFields];
  }

  const identical       = [];
  const changed         = [];
  const missingInTarget = [];
  const onlyInTarget    = [];

  // Compare source → target
  for (const [key, srcRec] of Object.entries(srcByKey)) {
    const tgtRec = tgtByKey[key];
    if (!tgtRec) {
      missingInTarget.push({ matchValue: key, srcId: srcRec.Id });
    } else {
      const diffs = [];
      for (const f of compareFields) {
        const sv    = srcRec[f];
        const tv    = tgtRec[f];
        const svStr = (sv === null || sv === undefined) ? '' : String(sv);
        const tvStr = (tv === null || tv === undefined) ? '' : String(tv);
        if (svStr !== tvStr) diffs.push({ field: f, source: sv, target: tv });
      }
      if (diffs.length === 0) {
        identical.push({ matchValue: key, srcId: srcRec.Id, tgtId: tgtRec.Id });
      } else {
        changed.push({ matchValue: key, srcId: srcRec.Id, tgtId: tgtRec.Id, diffs });
      }
    }
  }

  // Records only in target
  for (const [key, tgtRec] of Object.entries(tgtByKey)) {
    if (!srcByKey[key]) {
      onlyInTarget.push({ matchValue: key, tgtId: tgtRec.Id });
    }
  }

  return {
    id:                  genId('result'),
    scanId:              scan.id,
    scanName:            scan.name,
    objectType:          obj,
    matchField:          match,
    ranAt:               new Date().toISOString(),
    srcRecordCount:      srcRecs.length,
    tgtRecordCount:      tgtRecs.length,
    matchCount:          identical.length,
    changedCount:        changed.length,
    missingInTargetCount: missingInTarget.length,
    onlyInTargetCount:   onlyInTarget.length,
    identical,
    changed,
    missingInTarget,
    onlyInTarget
  };
}

// ── Scan result detail view ────────────────────────────────────
window.viewScanResult = function(resultId) {
  const result = _scanResults.find(r => r.id === resultId);
  if (!result) return;

  const detailEl = eid('dsScanResultDetail');
  if (!detailEl) return;

  // Changed records table
  // Feature 10: Side-by-side diff with color coding
  const changedHtml = result.changed?.length ? `
    <div class="ds-section-title" style="margin-top:20px">
      Changed Records (${result.changed.length})
    </div>
    <div style="overflow-x:auto">
      <table class="ds-diff-table ds-diff-colored">
        <thead>
          <tr>
            <th class="ds-diff-th-match">${esc(result.matchField || 'Match Value')}</th>
            <th>Field</th>
            <th class="ds-diff-th-src">◀ Source</th>
            <th class="ds-diff-th-tgt">Target ▶</th>
          </tr>
        </thead>
        <tbody>
          ${result.changed.map(rec =>
            rec.diffs.map((d, di) => `
              <tr class="ds-diff-row">
                ${di === 0
                  ? `<td rowspan="${rec.diffs.length}" class="ds-diff-match-val">${esc(String(rec.matchValue))}</td>`
                  : ''}
                <td class="ds-diff-field">${esc(d.field)}</td>
                <td class="ds-diff-src ds-diff-src-colored">${esc(d.source === null || d.source === undefined ? '(null)' : String(d.source))}</td>
                <td class="ds-diff-tgt ds-diff-tgt-colored">${esc(d.target === null || d.target === undefined ? '(null)' : String(d.target))}</td>
              </tr>`).join('')
          ).join('')}
        </tbody>
      </table>
    </div>` : '';

  const missingHtml = result.missingInTarget?.length ? `
    <div class="ds-section-title" style="margin-top:20px">Missing in Target (${result.missingInTarget.length})</div>
    <div class="ds-scan-id-list">
      ${result.missingInTarget.slice(0, 200).map(r =>
        `<span class="ds-scan-id-chip">${esc(String(r.matchValue))}</span>`
      ).join(' ')}
      ${result.missingInTarget.length > 200
        ? `<span style="color:var(--subtext);font-size:12px"> …and ${result.missingInTarget.length - 200} more</span>` : ''}
    </div>` : '';

  const onlyInTgtHtml = result.onlyInTarget?.length ? `
    <div class="ds-section-title" style="margin-top:20px">Only in Target (${result.onlyInTarget.length})</div>
    <div class="ds-scan-id-list">
      ${result.onlyInTarget.slice(0, 200).map(r =>
        `<span class="ds-scan-id-chip">${esc(String(r.matchValue))}</span>`
      ).join(' ')}
      ${result.onlyInTarget.length > 200
        ? `<span style="color:var(--subtext);font-size:12px"> …and ${result.onlyInTarget.length - 200} more</span>` : ''}
    </div>` : '';

  // Feature 9: CSV export helper
  function buildCSV() {
    const rows = [['Match Value', 'Field', 'Source', 'Target']];
    (result.changed || []).forEach(rec => {
      rec.diffs.forEach(d => {
        rows.push([
          String(rec.matchValue ?? ''),
          d.field,
          String(d.source === null || d.source === undefined ? '' : d.source),
          String(d.target === null || d.target === undefined ? '' : d.target)
        ]);
      });
    });
    (result.missingInTarget || []).forEach(r => rows.push([String(r.matchValue ?? ''), 'MISSING_IN_TARGET', '', '']));
    (result.onlyInTarget || []).forEach(r => rows.push([String(r.matchValue ?? ''), 'ONLY_IN_TARGET', '', '']));
    return rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  }

  detailEl.style.display = '';
  detailEl.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;
                padding:20px;margin-top:24px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
        <div>
          <div style="font-size:15px;font-weight:700">${esc(result.scanName)} — ${esc(result.objectType)}</div>
          <div style="font-size:12px;color:var(--subtext)">
            Run ${timeAgo(result.ranAt)} · ${result.srcRecordCount} source records · ${result.tgtRecordCount} target records
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="ds-btn ds-btn-sm" id="dsScanExportCSV">⬇ Export CSV</button>
          <button class="ds-btn ds-btn-sm" data-dsaction="closeScanResult">✕ Close</button>
        </div>
      </div>

      <div class="ds-scan-result-summary">
        <div class="ds-scan-stat ds-scan-stat-match">
          <div class="ds-scan-stat-num">${result.matchCount}</div>
          <div class="ds-scan-stat-lbl">Identical</div>
        </div>
        <div class="ds-scan-stat ds-scan-stat-changed">
          <div class="ds-scan-stat-num">${result.changedCount}</div>
          <div class="ds-scan-stat-lbl">Changed</div>
        </div>
        <div class="ds-scan-stat ds-scan-stat-missing">
          <div class="ds-scan-stat-num">${result.missingInTargetCount}</div>
          <div class="ds-scan-stat-lbl">Missing in target</div>
        </div>
        <div class="ds-scan-stat ds-scan-stat-extra">
          <div class="ds-scan-stat-num">${result.onlyInTargetCount}</div>
          <div class="ds-scan-stat-lbl">Only in target</div>
        </div>
      </div>

      ${changedHtml}
      ${missingHtml}
      ${onlyInTgtHtml}

      ${!result.changedCount && !result.missingInTargetCount && !result.onlyInTargetCount
        ? `<div style="text-align:center;padding:28px;color:#2E844A;font-size:14px;font-weight:600">
             ✅ All records are identical across both orgs
           </div>`
        : ''}
    </div>`;

  detailEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Feature 9: Wire CSV export button
  eid('dsScanExportCSV')?.addEventListener('click', () => {
    const csv  = buildCSV();
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `scan-${result.scanName.replace(/\s+/g,'_')}-${result.ranAt.slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });
};


// ════════════════════════════════════════════════════════════════
// DEPLOYMENT READINESS
// Schema-level comparison: find fields, picklists, record types,
// validation rules, and duplication rules that could cause a
// data transfer to fail.
// ════════════════════════════════════════════════════════════════

function renderReadiness() {
  const orgs = allMapOrgs();
  const orgOptions = orgs.map(o =>
    `<option value="${o.id}">${esc(o.label || orgLabel(o.url))}</option>`
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

      <div class="ds-field-group" style="margin-top:12px">
        <label class="ds-lbl">Objects to check
          <span class="ds-lbl-hint">(comma-separated API names — leave blank to auto-detect all custom objects)</span>
        </label>
        <input id="drObjects" class="ds-input"
               placeholder="Account, Contact, MyObject__c … or leave blank">
      </div>

      <div class="dr-checks-row">
        <label class="dr-check-label"><input type="checkbox" id="drChkFields" checked> Missing &amp; required fields</label>
        <label class="dr-check-label"><input type="checkbox" id="drChkPicklists" checked> Picklist value mismatches</label>
        <label class="dr-check-label"><input type="checkbox" id="drChkRecordTypes" checked> Record type gaps</label>
        <label class="dr-check-label"><input type="checkbox" id="drChkValidation" checked> Validation rules (target)</label>
        <label class="dr-check-label"><input type="checkbox" id="drChkDupRules" checked> Duplication rules (target)</label>
      </div>

      <div style="display:flex;gap:8px;margin-top:14px;align-items:center;flex-wrap:wrap">
        <button class="ds-btn ds-btn-primary" id="drRunBtn">🛡 Run Readiness Check</button>
        <button class="ds-btn" id="drScanAllBtn" title="Fetch and scan all custom objects in source org">📋 Load All Custom Objects</button>
        <span id="drStatus" class="dr-status"></span>
      </div>

      <div id="drError" class="dr-error" style="display:none"></div>
    </div>

    <div id="drResults" class="dr-results" style="display:none"></div>
  `);

  eid('drRunBtn')?.addEventListener('click', runReadinessCheck);
  eid('drScanAllBtn')?.addEventListener('click', loadAllCustomObjects);
}

// ── Load all custom objects from source org ────────────────────
async function loadAllCustomObjects() {
  const srcId = eid('drSrcOrg')?.value;
  if (!srcId) { showDrError('Select a source org first.'); return; }

  const srcSess = await getOrgSession(srcId);
  if (!srcSess) { showDrError('Cannot connect to source org. Open it in Chrome or add credentials.'); return; }

  setDrStatus('⏳ Fetching object list…');
  const res = await sendBg({ type: 'SF_REST_GET', orgUrl: srcSess.orgUrl, sid: srcSess.sid,
    path: 'services/data/v62.0/sobjects' });
  if (res.error) { showDrError(`Failed to load object list: ${res.error}`); return; }

  const customs = (res.sobjects || [])
    .filter(o => o.custom && o.queryable && o.createable && !o.deprecatedAndHidden)
    .map(o => o.name)
    .sort();

  if (!customs.length) { setDrStatus('No custom objects found in source org.'); return; }

  const input = eid('drObjects');
  if (input) input.value = customs.join(', ');
  setDrStatus(`✅ Loaded ${customs.length} custom objects`);
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

  // Object list
  let objectsRaw = (eid('drObjects')?.value || '').trim();
  let objects;
  if (!objectsRaw) {
    setDrStatus('⏳ Loading custom objects from source…');
    const listRes = await sendBg({ type: 'SF_REST_GET', orgUrl: srcSess.orgUrl, sid: srcSess.sid,
      path: 'services/data/v62.0/sobjects' });
    if (listRes.error) { showDrError(`Could not load object list: ${listRes.error}`); return; }
    objects = (listRes.sobjects || [])
      .filter(o => o.custom && o.queryable && o.createable && !o.deprecatedAndHidden)
      .map(o => o.name).sort();
    if (!objects.length) { showDrError('No custom objects found in source org.'); return; }
  } else {
    objects = objectsRaw.split(',').map(s => s.trim()).filter(Boolean);
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
    `<option value="${o.id}">${esc(o.label || orgLabel(o.url))}</option>`
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
