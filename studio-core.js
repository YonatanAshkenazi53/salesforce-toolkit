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
// Sequences — ordered chains of saved profiles run as one pipeline against a
// single org pair, sharing one idMap so a later profile's lookups to records
// created by an earlier profile remap automatically (e.g. CPQ price rules →
// lookup queries). Each: { id, name, sourceOrg, targetOrg, steps:[profileId…],
// createdAt, updatedAt }.
let _sequences   = [];
// Working org pair (topbar) — the pair every view defaults to: Org Compare,
// Deploy Readiness, Schema View (source), new deployment profiles, new
// sequences, and Run Transfer when the profile has no orgs. Views can still
// override locally; this is the default, not a lock.
let _workingPair = { src: '', tgt: '' };

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
// Dry-run-first guidance: profile|src|tgt keys that passed a dry run this
// session — flips which footer button is the primary CTA.
let _validatedRuns        = new Set();
// Auto-count state: last counted setup key + the total it produced (drives
// the Run button label and the big-run confirmation threshold).
let _trAutoCountKey       = null;
let _trLastTotal          = null;
let _trBigRunConfirmed    = false;
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

// Data-retention settings (Security S5). historyDays: purge run history older
// than N days on load (0 = keep forever). countsOnly: strip per-record
// ids/labels from history when saving (disables History record links).
let _settings = { historyDays: 30, countsOnly: false };

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
    window._sftkOrgUrl = _orgUrl;   // debug-modal reads this for exports
      window._sftkOrgUrl = _orgUrl;   // debug-modal reads this for exports
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

// Storage schema version. Bump when a stored shape changes and add a
// migration to SFTK_MIGRATIONS below. Each migration receives the raw
// chrome.storage.local snapshot and returns an object of keys to write
// (or null for no-op). Migrations run in order, exactly once, before the
// first storageLoad() consumer sees the data.
const SFTK_SCHEMA_VERSION = 1;
const SFTK_MIGRATIONS = [
  // v0 → v1: baseline — nothing to transform, just stamps the version.
  // Example of a future entry:
  // async (snap) => ({ sftk_profiles: (snap.sftk_profiles || []).map(fixShape) }),
  async () => null
];

async function runStorageMigrations() {
  const { sftk_schema_version } = await chrome.storage.local.get('sftk_schema_version');
  let from = Number.isInteger(sftk_schema_version) ? sftk_schema_version : 0;
  if (from >= SFTK_SCHEMA_VERSION) return;

  const snap = await chrome.storage.local.get(null);
  for (let v = from; v < SFTK_SCHEMA_VERSION; v++) {
    try {
      const writes = await SFTK_MIGRATIONS[v]?.(snap);
      if (writes && typeof writes === 'object') {
        await chrome.storage.local.set(writes);
        Object.assign(snap, writes);
      }
    } catch (e) {
      console.warn(`[SFTK] storage migration v${v}→v${v + 1} failed:`, e);
      break; // don't stamp past a failed step — retry next load
    }
    await chrome.storage.local.set({ sftk_schema_version: v + 1 });
  }
}

async function storageLoad() {
  await runStorageMigrations();
  const d = await chrome.storage.local.get([
    'sftk_profiles','sftk_history','sftk_orgs',
    'ds_dark_mode','sftk_dark','ds_activity_log','sftk_sequences','sftk_active_run',
    'ds_working_pair','ds_settings'
  ]);
  _profiles     = d.sftk_profiles   || [];
  _history      = d.sftk_history    || [];
  _orgs         = d.sftk_orgs       || {};
  // X5: one shared dark-mode preference across both apps. Read the canonical
  // key (sftk_dark, also used by the popup + log viewer), falling back to the
  // legacy studio-only key for users who set it before unification.
  _darkMode     = (d.sftk_dark ?? d.ds_dark_mode) || false;
  _activityLog  = d.ds_activity_log || {};
  _sequences    = d.sftk_sequences  || [];
  _workingPair  = d.ds_working_pair || { src: '', tgt: '' };
  _settings     = { historyDays: 30, countsOnly: false, ...(d.ds_settings || {}) };

  // Retention (S5): purge history entries older than the configured window.
  if (_settings.historyDays > 0 && _history.length) {
    const cutoff = Date.now() - _settings.historyDays * 86400000;
    const kept = _history.filter(h => {
      const t = new Date(h.startedAt || h.finishedAt || 0).getTime();
      return !Number.isFinite(t) || t === 0 || t >= cutoff;   // keep undated entries
    });
    if (kept.length !== _history.length) {
      _history = kept;
      storageSaveHistory().catch(() => {});
    }
  }

  // Retention (S5): drop stale apex-log-viewer handoff payloads (raw log
  // bodies parked in storage for the viewer tab). Keys embed Date.now() in
  // base36 (first 8 chars until 2059); older than 7 days → gone. Unparseable
  // keys are treated as ancient and removed too.
  chrome.storage.local.get(null).then(all => {
    const stale = Object.keys(all).filter(k => {
      if (!k.startsWith('apex_log_viewer_')) return false;
      const ts = parseInt(k.slice('apex_log_viewer_'.length, -6), 36);
      return !Number.isFinite(ts) || ts < Date.now() - 7 * 86400000;
    });
    if (stale.length) chrome.storage.local.remove(stale).catch(() => {});
  }).catch(() => {});

  // A leftover active-run marker means a previous run was interrupted
  // (studio tab closed / worker killed mid-run) — say so instead of silence.
  if (d.sftk_active_run) {
    const ar = d.sftk_active_run;
    setTimeout(() => showToast(
      `⚠ A previous ${ar.kind || 'run'} looks interrupted (started ${timeAgo(ar.startedAt)}). Check History and re-scan before re-running.`,
      'warning', 8000), 1200);
    chrome.storage.local.remove('sftk_active_run').catch(() => {});
  }

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

async function storageSaveSequences() {
  await chrome.storage.local.set({ sftk_sequences: _sequences });
}

async function storageSaveWorkingPair() {
  await chrome.storage.local.set({ ds_working_pair: _workingPair });
}

async function storageSaveHistory() {
  if (_history.length > 100) _history = _history.slice(-100);
  // Counts-only mode (S5): strip per-record ids/labels before anything hits
  // disk. Counts, errors, and org URLs stay; record links disappear.
  if (_settings.countsOnly) {
    for (const h of _history) {
      delete h.failedSourceIds;
      if (h.summary) for (const obj of Object.values(h.summary)) {
        if (obj && typeof obj === 'object') {
          delete obj.targetRecords; delete obj.failedRecords; delete obj.failedSourceIds;
        }
      }
    }
  }
  await chrome.storage.local.set({ sftk_history: _history });
}

async function storageSaveSettings() {
  await chrome.storage.local.set({ ds_settings: _settings });
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
// Stable per-org identity key, shared across every domain form Salesforce
// hands out for the SAME org: my.salesforce.com (API origin), lightning.force.com
// (UI), salesforce-setup.com (Setup), and trailing-slash / scheme variants all
// collapse to the org's myDomain prefix, e.g.:
//   https://ashkenazy7-dev-ed.develop.my.salesforce.com  →  ashkenazy7-dev-ed.develop
//   https://ashkenazy7-dev-ed.develop.lightning.force.com → ashkenazy7-dev-ed.develop
// Live sessions are always reported as the my.salesforce.com form, but stored
// profile URLs may have been captured in any form — so equality on the raw
// string falsely reports an open org as "offline". Match on this key instead.
function _orgKey(orgUrl) {
  return sftkOrgKey(orgUrl);   // canonical implementation: sftk-org-identity.js
}

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

  // Wire nav — routes through the hash (U6) so Back/Forward/refresh work and
  // views are linkable. Clicking a tab just sets location.hash; the single
  // hashchange handler below does the actual render.
  document.querySelectorAll('.ds-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => navigateToView(btn.dataset.view));
  });

  // U6: hash routing. #/<view> is the single source of truth for which top-
  // level view is showing. Sub-views opened via functions (openReconcile,
  // openProfileBuilder…) don't participate — they're transient and set their
  // own _currentView; the hash still reflects the last real nav so Back
  // returns somewhere sane.
  window.addEventListener('hashchange', () => {
    const v = _viewFromHash();
    if (v && v !== _currentView) _applyView(v);
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
      case 'openFanOut':            window.openFanOut?.(arg); break;
      case 'editProfile':           window.editProfile?.(arg); break;
      case 'cloneProfile':          window.cloneProfile?.(arg); break;
      case 'deleteProfile':         window.deleteProfile?.(arg); break;
      case 'refreshState':          window.refreshProfileState?.(arg); break;
      case 'openReconcile':         window.openReconcile?.(arg); break;
      case 'retryFailed':           window.retryFailedRun?.(arg); break;
      case 'runAgain':              window.runAgain?.(arg); break;
      case 'openOrgTab':            chrome.tabs.create({ url: arg }); break;
      case 'compareOrgFrom':        window.compareOrgFrom?.(arg); break;
      case 'toggleReadOnly':        window.toggleOrgReadOnly?.(arg); break;
      case 'saveEphemeralProfile':  window.saveEphemeralProfile?.(); break;
      case 'showSecurity':          showSecurityModal(); break;
      case 'switchView': {
        // Generic data-dsaction view switcher — routes through the hash (U6).
        if (arg) navigateToView(arg);
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
  // "‹ Toolkit" — actually take the user to the Toolkit. The old behaviour
  // just closed this tab, which only "went back" if the popup happened to
  // still be open underneath (it never is — popups close on focus loss).
  // Chrome can't reliably reopen the toolbar popup from a page, but the
  // Toolkit has a popout mode (popup.html?popout=1): focus it if one is
  // already open, otherwise open it as a popup window.
  eid('dsBackToToolkit')?.addEventListener('click', () => openToolkitPopout(null));

  // Brand name = home button → Connected Orgs (the landing view).
  document.querySelector('.ds-brand')?.addEventListener('click', () => navigateToView('orgs'));

  // First-run: if no orgs known, show welcome instead of an empty list.
  const isFirstRun = !_orgUrl && !_allSessions.length
    && !Object.keys(_orgs).length;
  if (isFirstRun) {
    renderWelcome();
  } else {
    // U6: honor a deep-link hash (#/compare etc.) on load; else land on orgs.
    const hashView = _viewFromHash();
    const initView = hashView || 'orgs';
    _applyView(initView);
    // Stamp the hash so refresh/Back are stable — replaceState doesn't fire
    // hashchange, so no double render.
    if (location.hash !== `#/${initView}`) {
      try { history.replaceState(null, '', `#/${initView}`); } catch (_) { location.hash = `#/${initView}`; }
    }
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
      text:  'Connected Orgs, Data Deployment, History, Org Compare, Deploy Readiness and Schema View — all from here.'
    },
    {
      selector: '#dsCmdPaletteBtn',
      title: 'Command palette',
      text:  'Press Ctrl+K to jump to any view or action instantly — no clicking around.'
    },
    {
      title: "You're ready",
      text:  'Open a Salesforce org in a Chrome tab to begin. Everything stays local to your browser.'
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
  // X5: write the canonical shared key (sftk_dark) so the popup + log viewer
  // pick up the same choice; keep ds_dark_mode in sync for back-compat.
  chrome.storage.local.set({ sftk_dark: on, ds_dark_mode: on });
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
// Mirrors the CURRENT sidebar — Org Map / Schedule / Scan Map were removed
// in the feature trim; their palette entries were dead links to blank views.
const CMD_VIEWS = [
  { icon: '🔌', label: 'Connected Orgs',    view: 'orgs',      desc: 'Manage connections' },
  { icon: '📦', label: 'Data Deployment',   view: 'profiles',  desc: 'Profiles + run transfer' },
  { icon: '🎚', label: 'Picklists',         view: 'picklists', desc: 'Values, usage & data fixes' },
  { icon: '📜', label: 'History',           view: 'history',   desc: 'Past transfer runs' },
  { icon: '🔍', label: 'Org Compare',       view: 'compare',   desc: 'Diff data across many objects' },
  { icon: '🛡',  label: 'Deploy Readiness', view: 'readiness', desc: 'Schema compatibility' },
  { icon: '🕸',  label: 'Schema View',      view: 'schema',    desc: 'Flow & object graph' },
  { icon: '🐛', label: 'Apex Debugger',     view: 'debugger',  desc: 'Trace flows, triggers & limits' },
];

// Toolkit (popup) features — selecting one opens/focuses the Toolkit popout
// window deep-linked to that tab. Ids match popup.js HOME_FEATURES.
const CMD_TOOLKIT = [
  { icon: '🗑', label: 'Flows',             tab: 'flows',        desc: 'Bulk delete, backup & restore' },
  { icon: '🗺', label: 'Dependencies',      tab: 'dependencies', desc: 'Subflow call chains' },
  { icon: '🐛', label: 'Apex Debugger',     tab: 'debugger',     desc: 'Trace flows, triggers, recursion' },
  { icon: '📄', label: 'Lightning Pages',   tab: 'pages',        desc: 'Assignments & org defaults' },
  { icon: '🔧', label: 'Field Cleaner',     tab: 'fields',       desc: 'Scan deps, fix flows, delete fields' },
  { icon: '👥', label: 'Copy Permissions',  tab: 'copy-perms',   desc: 'Copy perms between users' },
  { icon: '🔑', label: 'Licenses',          tab: 'licenses',     desc: 'Manage license assignments' },
  { icon: '🌊', label: 'Flow Access',       tab: 'flow-access',  desc: 'Grant flows to permission sets' },
];

// Open (or focus) the Toolkit popout window; when `tab` is given, deep-link
// to that feature — a fresh window gets it via the ?tab= URL param, an
// already-open one via a TOOLKIT_NAVIGATE runtime message.
async function openToolkitPopout(tab) {
  const base = chrome.runtime.getURL('popup.html');

  // Find an already-open Toolkit by ASKING it (TOOLKIT_PING) instead of
  // tabs.query({url}) — URL-filtered queries silently stopped matching when
  // the "tabs" permission was dropped (security S9), which made this button
  // open a NEW full-screen popout every time instead of focusing the one you
  // came from. Pinging needs no permission: the page answers with its tab id
  // (tabs.getCurrent) and focusing by id is always allowed.
  const existing = await new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    try {
      chrome.runtime.sendMessage({ type: 'TOOLKIT_PING' }, resp => {
        void chrome.runtime.lastError;   // "no receiver" — that's an answer too
        done(resp && resp.tabId != null ? resp : null);
      });
    } catch (_) { done(null); }
    setTimeout(() => done(null), 400);   // no listener responded in time
  });

  try {
    if (existing) {
      await chrome.windows.update(existing.windowId, { focused: true });
      await chrome.tabs.update(existing.tabId, { active: true });
      if (tab) chrome.runtime.sendMessage({ type: 'TOOLKIT_NAVIGATE', tab }, () => chrome.runtime.lastError);
      return;
    }
    const w = (typeof screen !== 'undefined' && screen.availWidth)  || 1600;
    const h = (typeof screen !== 'undefined' && screen.availHeight) || 1000;
    const win = await chrome.windows.create({
      url: `${base}?popout=1${tab ? `&tab=${encodeURIComponent(tab)}` : ''}`,
      type: 'popup', left: 0, top: 0, width: w, height: h
    });
    if (win?.id) chrome.windows.update(win.id, { state: 'maximized' });
  } catch (_) {
    try { chrome.tabs.create({ url: `${base}?popout=1${tab ? `&tab=${encodeURIComponent(tab)}` : ''}` }); } catch (__) {}
  }
}

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
    const toolkitItems = CMD_TOOLKIT.filter(t =>
      !q || t.label.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q)
    );
    const profileItems = q
      ? _profiles.filter(p => p.name.toLowerCase().includes(q))
      : [];
    return { navItems, toolkitItems, profileItems };
  }

  function render(filter = '') {
    const { navItems, toolkitItems, profileItems } = buildItems(filter);
    const total = navItems.length + toolkitItems.length + profileItems.length;
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

    if (toolkitItems.length) {
      html += `<div class="ds-cmd-section-hdr">Toolkit</div>`;
      toolkitItems.forEach((t, i) => {
        const idx = navItems.length + i;
        const cls = idx === activeIdx ? ' ds-cmd-active' : '';
        html += `<div class="ds-cmd-item${cls}" data-cmd-toolkit="${esc(t.tab)}">
          <span class="ds-cmd-item-icon">${t.icon}</span>
          <span class="ds-cmd-item-label">${esc(t.label)}</span>
          <span class="ds-cmd-item-desc">${esc(t.desc)}</span>
        </div>`;
      });
    }

    if (profileItems.length) {
      html += `<div class="ds-cmd-section-hdr">Run Profile</div>`;
      profileItems.forEach((p, i) => {
        const idx = navItems.length + toolkitItems.length + i;
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
    list.querySelectorAll('[data-cmd-toolkit]').forEach(el => {
      el.addEventListener('click', () => {
        closePalette();
        openToolkitPopout(el.dataset.cmdToolkit);
      });
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
    navigateToView(view);   // U6: through the hash so Back/Forward work
  }

  function closePalette() {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
    const { navItems, toolkitItems, profileItems } = buildItems(input.value);
    const total = navItems.length + toolkitItems.length + profileItems.length;
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
      } else if (activeIdx < navItems.length + toolkitItems.length) {
        const t = toolkitItems[activeIdx - navItems.length];
        if (t) { closePalette(); openToolkitPopout(t.tab); }
      } else {
        const p = profileItems[activeIdx - navItems.length - toolkitItems.length];
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

      ${_getStartedHtml()}

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

  // Wire card navigation (U6: through the hash)
  document.querySelectorAll('[data-gotoview]').forEach(card => {
    card.addEventListener('click', () => navigateToView(card.dataset.gotoview));
  });

  eid('dsWelcomeSecBtn')?.addEventListener('click', showSecurityModal);

  // U3: get-started checklist — each step deep-links; dismiss hides it forever.
  eid('dsGsDismiss')?.addEventListener('click', async () => {
    _settings.getStartedDone = true;
    try { await storageSaveSettings(); } catch (_) {}
    eid('dsGetStarted')?.remove();
  });
  document.querySelectorAll('[data-gs-view]').forEach(el =>
    el.addEventListener('click', () => navigateToView(el.dataset.gsView)));
}

// U3: compute the onboarding checklist from REAL state — each step checks
// itself off as the user does the underlying thing. Hidden once every step is
// done or the user dismisses it (persisted in _settings.getStartedDone).
function _getStartedHtml() {
  if (_settings.getStartedDone) return '';
  const orgCount   = allMapOrgs().length;
  const hasProfile = _profiles.length > 0;
  const hasScan    = _profiles.some(p => p.lastScan && (p.lastScan.buckets || p.lastScan.runAt));
  const hasRun     = _history.length > 0;
  const hasCompare = _history.some(h => h.kind === 'compare');

  const steps = [
    { done: orgCount >= 2, view: 'orgs',      label: 'Connect two orgs',       hint: orgCount ? `${orgCount} open` : 'Open two Salesforce tabs' },
    { done: hasCompare,    view: 'compare',   label: 'Compare them',           hint: 'See what differs across objects' },
    { done: hasProfile,    view: 'profiles',  label: 'Create a deployment',    hint: 'Pick objects, orgs & field mapping' },
    { done: hasRun,        view: 'profiles',  label: 'Dry-run, then run it',   hint: 'Validate before writing anything' },
  ];
  const doneN = steps.filter(s => s.done).length;
  if (doneN === steps.length) return '';   // fully onboarded — retire the card

  return `
    <div class="ds-get-started" id="dsGetStarted">
      <div class="ds-gs-head">
        <span class="ds-gs-title">🚀 Get started <span class="ds-gs-progress">${doneN} of ${steps.length}</span></span>
        <button class="ds-gs-dismiss" id="dsGsDismiss" title="Hide this checklist">✕</button>
      </div>
      <div class="ds-gs-steps">
        ${steps.map((s, i) => `
          <div class="ds-gs-step${s.done ? ' ds-gs-done' : ''}" data-gs-view="${s.view}" title="Go to ${esc(s.label)}">
            <span class="ds-gs-check">${s.done ? '✅' : (i + 1)}</span>
            <span class="ds-gs-step-body">
              <span class="ds-gs-step-label">${esc(s.label)}</span>
              <span class="ds-gs-step-hint">${esc(s.hint)}</span>
            </span>
          </div>`).join('')}
      </div>
    </div>`;
}

// ── U6: hash routing helpers ────────────────────────────────────
// The set of top-level views that own a sidebar tab (transient sub-views like
// reconcile/builder are NOT hash-routed).
const DS_HASH_VIEWS = new Set([
  'orgs', 'profiles', 'picklists', 'history', 'compare', 'readiness', 'schema', 'fields', 'transfer', 'debugger',
]);

function _viewFromHash() {
  const m = /^#\/([a-z-]+)/.exec(location.hash || '');
  return m && DS_HASH_VIEWS.has(m[1]) ? m[1] : null;
}

// Apply a view without touching the hash (used by the hashchange handler and
// initial load). Highlights the tab and renders.
function _applyView(view) {
  document.querySelectorAll('.ds-nav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));
  _currentView = view;
  renderView(view);
}

// Nav entry point: set the hash (which fires hashchange → _applyView). If the
// hash is already this view (e.g. re-click), render directly so it still works.
function navigateToView(view) {
  if (!view) return;
  const target = `#/${view}`;
  if (location.hash === target) _applyView(view);
  else location.hash = target;   // hashchange handler renders
}

function renderView(view) {
  _describeCache = {};   // clear per-view to stay fresh
  _refFieldCache = {};   // clear lookup field cache on view switch (may have stale org data)
  renderWorkingPair();   // topbar pair options track newly-detected orgs

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
    case 'fields':    renderFieldAudit();  break;
    case 'reconcile': renderReconcile();   break;
    case 'compare':   renderOrgCompare(); break;
    case 'picklists': renderPicklists();  break;
    case 'debugger':  renderDebuggerTool(); break;   // Phase X — mounted popup tool
  }
}

// U5: sync-status strip — answers "is anything out of sync?" right on the
// landing page, aggregating deployments that already have a fresh scan. Zero
// new API calls: reads profile.lastScan buckets. Each tile → Reconcile.
function _syncStatusStripHtml() {
  const tiles = [];
  for (const p of _profiles) {
    const s = p.lastScan;
    if (!s || !s.runAt) continue;
    const missing = (s.missingInTarget || []).length;
    const changed = (s.changed || []).length;
    const extra   = (s.onlyInTarget || []).length;
    const drift   = missing + changed + extra;
    tiles.push({ id: p.id, name: p.name, missing, changed, extra, drift,
      src: p.sourceOrg, tgt: p.targetOrg, at: s.runAt });
  }
  if (!tiles.length) return '';
  tiles.sort((a, b) => b.drift - a.drift);
  return `
    <div class="ds-sync-strip">
      <div class="ds-sync-strip-title">Sync status <span class="ds-sync-strip-sub">from your last scans</span></div>
      <div class="ds-sync-tiles">
        ${tiles.slice(0, 6).map(t => `
          <div class="ds-sync-tile${t.drift === 0 ? ' ds-sync-ok' : ''}" data-sync-profile="${esc(t.id)}"
               title="Open Reconcile for ${esc(t.name)}">
            <div class="ds-sync-tile-name">${esc(t.name)}</div>
            <div class="ds-sync-tile-pair">${esc(orgLabel(t.src))} → ${esc(orgLabel(t.tgt))}</div>
            <div class="ds-sync-tile-stats">
              ${t.drift === 0 ? '<span class="ds-sync-clean">✓ in sync</span>'
                : `${t.missing ? `<span class="ds-sync-m">${t.missing} missing</span>` : ''}
                   ${t.changed ? `<span class="ds-sync-c">${t.changed} changed</span>` : ''}
                   ${t.extra ? `<span class="ds-sync-e">${t.extra} only in target</span>` : ''}`}
            </div>
            <div class="ds-sync-tile-age">${t.at ? esc(timeAgo(t.at)) : ''}</div>
          </div>`).join('')}
      </div>
    </div>`;
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
    const urlKey     = _orgKey(url);
    const isOnline   = _allSessions.some(s => _orgKey(s.orgUrl) === urlKey) || _orgKey(_orgUrl) === urlKey;
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
            ${prodBadge(url)}
            ${orgData.readOnly ? '<span class="ds-org-badge-current" style="margin-left:6px;background:#FDF0E4;color:#B54708" title="All writes to this org are blocked">🔒 read-only</span>' : ''}
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
          ${!isOnline ? `<button class="ds-btn ds-btn-sm" data-dsaction="openOrgTab" data-arg="${esc(url)}" title="Open this org in a new Chrome tab — refreshes its session so the Studio can reach it">↗ Open</button>` : ''}
          <button class="ds-btn ds-btn-sm" data-dsaction="compareOrgFrom" data-arg="${esc(url)}" title="Compare this org's data against another org (opens Org Compare with this org as the source)">🔍 Compare with…</button>
          <button class="ds-btn ds-btn-sm" data-dsaction="editOrgLabel" data-arg="${esc(url)}">✏ Rename</button>
          <button class="ds-btn ds-btn-sm" data-dsaction="toggleReadOnly" data-arg="${esc(url)}" title="${orgData.readOnly ? 'Allow writes to this org again' : 'Block ALL writes to this org (inserts, updates, deletes, deploys)'}">${orgData.readOnly ? '🔓 Unlock' : '🔒 Read-only'}</button>
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

    ${_syncStatusStripHtml()}

    ${!allOrgUrls.length ? `
      <div class="ds-empty-page">
        <div class="ds-empty-icon">${window.sftkCatSvg('sleep', 72)}</div>
        <div class="ds-empty-title">No orgs detected yet</div>
        <div class="ds-empty-sub">Open a Salesforce org in any Chrome tab, then click <strong>Refresh from open tabs</strong>.</div>
      </div>` : `
      <div class="ds-orgs-grid">
        ${rowsHtml}
      </div>`}
  `);

  // U5: sync tiles deep-link into Reconcile for that profile.
  eid('dsMain')?.querySelectorAll('[data-sync-profile]').forEach(t =>
    t.addEventListener('click', () => window.openReconcile?.(t.dataset.syncProfile)));

  eid('dsRefreshOrgsBtn')?.addEventListener('click', async () => {
    const btn = eid('dsRefreshOrgsBtn');
    if (btn) { btn.disabled = true; btn.textContent = '🔄 Refreshing…'; }
    const allRes = await sendBg({ type: 'GET_ALL_SF_SESSIONS' });
    _allSessions = allRes?.sessions || [];
    _allSessions.forEach(s => upsertOrg(s.orgUrl, s.label));
    await storageSaveOrgs();
    renderOrgsPanel();
  });

  // Detect org types (prod / sandbox / dev) for online orgs that don't have
  // a cached answer yet. Fire-and-forget; re-renders once when something new
  // comes back. ensureOrgType caches results, so this settles quickly and
  // can't loop (offline orgs stay 'unknown' and are simply skipped).
  (async () => {
    let changed = false;
    for (const url of allOrgUrls) {
      if (cachedOrgType(url) !== 'unknown') continue;
      const live = _allSessions.some(s => _orgKey(s.orgUrl) === _orgKey(url));
      if (!live) continue;
      const t = await ensureOrgType(url);
      if (t !== 'unknown') changed = true;
    }
    if (changed && _currentView === 'orgs') renderOrgsPanel();
  })();
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

// Per-org read-only lock (Security S4). The flag lives on _orgs[url].readOnly;
// enforcement is in the service worker at the fetch chokepoint (any non-GET
// to a locked org throws), so every write path — transfers, reconcile,
// deletes, metadata deploys, popup tools — is covered by one gate.
window.toggleOrgReadOnly = async function(orgUrl) {
  if (!_orgs[orgUrl]) _orgs[orgUrl] = {};
  const on = !_orgs[orgUrl].readOnly;
  _orgs[orgUrl].readOnly = on;
  await storageSaveOrgs();
  showToast(on
    ? `🔒 ${orgLabel(orgUrl)} is now read-only — all writes are blocked`
    : `🔓 ${orgLabel(orgUrl)} is writable again`, on ? 'warning' : 'success');
  renderOrgsPanel();
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
// (Credential-based stored orgs were removed.) Used by EVERY org dropdown
// (profile builder, transfer/reconcile, Deploy Readiness, Schema View,
// Org Compare, sequences). Each entry: { url, label }.
// The URL is the org's ONE identity everywhere — the old base64 `id`
// indirection (only Readiness/Schema used it) is gone.
function allMapOrgs() {
  const map = new Map();   // keyed by URL — the only truly unique key
  // Remembered orgs (sftk_orgs) — everything seen in Chrome before.
  for (const [url, data] of Object.entries(_orgs)) {
    if (!map.has(url)) map.set(url, { url, label: data.label || orgLabel(url) });
  }
  // Current browser sessions — anything open right now, even if never seen.
  const liveUrls = [...(_orgUrl ? [_orgUrl] : []), ..._allSessions.map(s => s.orgUrl)];
  for (const url of liveUrls) {
    if (!url || map.has(url)) continue;
    map.set(url, { url, label: orgLabel(url) });
  }
  return [...map.values()];
}

// ── Org-status option labels ─────────────────────────────────────────
// Native <select> options can't render HTML, so emoji is the one styling
// channel available: 🟢 = org open in Chrome with a live session, ⚪ = known
// but not currently open. Used by every org picklist (Profile Builder,
// Run Transfer, Readiness, Schema View, Field Mapping, Org Compare).
// Set of org-identity keys (not raw URLs) for every org open in a tab, so an
// org counts as "online" no matter which domain form its dropdown value was
// stored in. Matches the same key logic _resolveSession uses.
function _liveOrgSet() {
  return new Set(_buildAllSessions().filter(s => s.sid).map(s => _orgKey(s.orgUrl)));
}
function orgOptionLabel(url, label, liveSet) {
  const on = (liveSet || _liveOrgSet()).has(_orgKey(url));
  return `${on ? '🟢' : '⚪'} ${label || orgLabel(url)}${on ? '' : ' (not open)'}`;
}

// ── Working org pair (topbar control) ─────────────────────────────
// Lives in the static topbar (outside #dsMain) so it survives every view
// re-render; renderView() repaints it so the options track newly-detected
// orgs. Changing the pair persists it and re-renders the current view —
// views are stateless full re-renders, so that's the whole propagation.
function renderWorkingPair() {
  const el = eid('dsWorkingPair');
  if (!el) return;
  const orgs = allMapOrgs();
  if (orgs.length < 2) { el.innerHTML = ''; return; }   // pointless with 0-1 orgs
  const ls = _liveOrgSet();
  const opts = sel => ['<option value="">—</option>',
    ...orgs.map(o => `<option value="${esc(o.url)}" ${o.url === sel ? 'selected' : ''}>${esc(orgOptionLabel(o.url, o.label, ls))}</option>`)
  ].join('');
  el.innerHTML = `
    <span class="ds-pair-lbl" title="Working pair — Org Compare, Deploy Readiness, Schema View, and new deployments all start with these orgs. Each view can still pick different ones.">Pair</span>
    <select id="dsWpSrc" class="ds-pair-sel" title="Working SOURCE org (data comes from here)">${opts(_workingPair.src)}</select>
    <button id="dsWpSwap" class="ds-pair-swap" title="Swap source and target">⇄</button>
    <select id="dsWpTgt" class="ds-pair-sel" title="Working TARGET org (data goes here)">${opts(_workingPair.tgt)}</select>`;
  const persist = () => { storageSaveWorkingPair(); renderView(_currentView); };
  eid('dsWpSrc')?.addEventListener('change', e => { _workingPair.src = e.target.value; persist(); });
  eid('dsWpTgt')?.addEventListener('change', e => { _workingPair.tgt = e.target.value; persist(); });
  eid('dsWpSwap')?.addEventListener('click', () => {
    const t = _workingPair.src; _workingPair.src = _workingPair.tgt; _workingPair.tgt = t;
    persist();   // renderView repaints this control too
  });
}

// Resolve an org URL (the value of every org <select>) to a live session
// { orgUrl, sid } — or null when that org isn't open in any Chrome tab.
// Used by Deploy Readiness + Schema View before each check/load.
async function getOrgSession(orgUrl) {
  if (!orgUrl) return null;
  // Refresh open-tab sessions so we hand back the freshest SID available.
  const freshRes = await sendBg({ type: 'GET_ALL_SF_SESSIONS' });
  if (freshRes?.sessions?.length) _allSessions = freshRes.sessions;
  const sess = _resolveSession(orgUrl, _buildAllSessions());
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

