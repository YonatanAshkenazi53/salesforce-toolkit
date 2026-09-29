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
// TRUE once a GET_ALL_SF_SESSIONS round-trip actually completed (even with
// zero sessions). Liveness consumers read _liveKnown(), never `set.size > 0`:
// the active-tab session alone puts one entry in the live set while
// enumeration may have FAILED — inferring knowledge from size re-disables
// every genuinely-open target (the pre-e9d8f0f symptom, reintroduced for
// the partial-knowledge state). Never reset — stale knowledge is still
// knowledge; a failed refresh keeps the last good answer.
let _allSessionsOk = false;
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
let _oledMode    = false;   // absolute-black variant, only active with dark

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

// M2 — Sync Ring: the org group being kept in sync + which org is the source
// of truth. Replaces the old two-org "working pair" as the global context
// (user decision 2026-07-14: "a global two-org context is the wrong shape for
// a 5-org ring"). _workingPair.src stays mirrored to ring.sourceUrl so every
// existing default-seeding path keeps working unchanged.
let _ring = null;   // { orgs: [urls], sourceUrl } | null (not configured)

// ── DOM helpers ───────────────────────────────────────────────
const esc = s => String(s ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const eid = id => document.getElementById(id);
const setMain = html => {
  const m = eid('dsMain');
  if (!m) return;
  m.innerHTML = html;
  // (?) help badges render inert HTML — the bubble behavior wires here, the
  // one chokepoint every view paints through. Idempotent (data-wired guard).
  try { window.SFTKOnboard?.wireHelp?.(m); } catch (_) {}
};

// ── THE SHARED VIEW HEADER ────────────────────────────────────
// The SLDS audit's headline finding was that every one of the 13 views
// hand-rolls its own title markup, so none of them has the page-header shape
// a Salesforce admin recognises: an icon container, a title, a record count,
// and right-aligned actions. This builds that shape ONCE.
//
//   dsIcon('sliders')                 → a decorative mask icon (aria-hidden)
//   dsViewHeader({ icon, title, … })  → the whole header
//
// Icons are the debugger's mask table (styles.css declares `[data-i="…"]`
// unscoped, studio.css adds the Studio-only glyphs to the same custom
// property) so an icon is always currentColor and always inverts in dark
// mode. See "DATA STUDIO — DESIGN REFRESH LAYER" in studio.css.
//
// HONESTY: `count` is printed verbatim. Pass a string you have actually
// computed from the data on screen — never an estimate, never a rounded
// "~N". If you don't have a real number, omit it.
//
// title/subtitle/count/actions are raw HTML (callers already interpolate
// esc()'d values and inline <strong>), so escape at the call site as before.
// Adoption is opt-in: the header only changes shape once .ds-vh is on it, so
// views that still emit a bare .ds-view-header are untouched.
const dsIcon = (name, cls) =>
  `<span class="ds-i${cls ? ' ' + cls : ''}" data-i="${esc(name)}" aria-hidden="true"></span>`;

function dsViewHeader({ icon, title, subtitle, count, actions, back, cls, help } = {}) {
  const sub = [subtitle || '', count ? `<span class="ds-vh-count">${count}</span>` : '']
    .filter(Boolean).join('');
  // `help` — plain text behind a hoverable/focusable (?) badge next to the
  // title (the shared SFTKOnboard bubble; falls back to a title attr if the
  // onboarding script ever fails to load). Use it to say what a SURFACE is
  // and how it relates to its siblings — the scan/reconcile/tree-diff trio
  // confused a real user precisely because each screen only described
  // itself (2026-08-04).
  const helpHtml = help
    ? (typeof SFTKOnboard !== 'undefined' && SFTKOnboard.help
        ? SFTKOnboard.help(help)
        : `<span class="sftk-help" title="${esc(help)}" tabindex="0">?</span>`)
    : '';
  return `<div class="ds-view-header ds-vh${cls ? ' ' + cls : ''}">
      <div class="ds-vh-lead">
        ${icon ? `<span class="ds-vh-icon">${dsIcon(icon)}</span>` : ''}
        <div class="ds-vh-titles">
          ${back || ''}
          <h2 class="ds-view-title">${title || ''}${helpHtml}</h2>
          ${sub ? `<div class="ds-view-subtitle">${sub}</div>` : ''}
        </div>
      </div>
      ${actions ? `<div class="ds-vh-actions">${actions}</div>` : ''}
    </div>`;
}

// ── E4: Professional mode ─────────────────────────────────────
// Emoji-dense chrome reads as hobbyist in procurement screenshot reviews.
// Professional mode (default OFF — existing users keep today's look) swaps
// decorative emoji for plain-text labels (or nothing), tightens density and
// mutes accents. Mechanism: body.ds-pro + the CSS variables in studio.css.
//
// THE PATTERN — adopt this in any render function you touch:
//   · JS-built HTML:   ${window.sftkGlyph('🔌 ', '')} before a text label
//                      (drops the emoji in pro mode), or
//                      ${window.sftkGlyph(' 👑', ' — source')} when a plain-
//                      text stand-in must replace it.
//   · static HTML (studio.html): give the emoji span class="ds-glyph"
//     (hidden by .ds-pro), plus an optional sibling
//     <span class="ds-pro-only">Label</span> (shown only under .ds-pro).
//   · purely decorative icon slots with their own class (nav icons, welcome
//     card icons…) are hidden wholesale in the .ds-pro CSS block.
// Views are stateless full re-renders, so toggling re-renders and every
// baked-in glyph updates.
//
// CONVERTED so far (highest-visibility chrome): studio.html topbar (logo,
// trust lock, What's New) + sidebar nav icons, and in this file: welcome
// hero/cards/get-started, security modal, Connected Orgs panel, toasts,
// session banner, dark toggle, org <option> labels (🟢/⚪/👑 — the 👑 source
// chip becomes " — source").
// REMAINING EMOJI SITES for a later sweep (do NOT sweep other agents' files
// in this task): studio-profiles.js (card chips ⚠/✏/📌/🔄, sequence rows),
// studio-builder.js + studio-builder-modals.js, studio-transfer.js (progress
// rows, run buttons), studio-history.js, studio-reconcile.js,
// studio-scan.js, studio-compare.js, studio-readiness.js, studio-schema.js,
// studio-fields.js, studio-picklists.js, studio-ring.js,
// studio-whatsnew.js (🎉 view header), sftk-confirm.js, debug-modal.js
// (#dbgBtn 🐛 label — it rewrites the button text itself), and the popup app
// (separate shell, out of studio scope). Intentionally KEPT in both modes:
// the cat SVG empty states (brand illustration, not emoji) and plain text
// symbols (‹ › ⦿ ⚙ ● ○ ✕ →).
function sftkGlyphFor(pro, emoji, label) {
  return pro ? String(label ?? '') : String(emoji ?? '');
}
window.sftkGlyph = (emoji, label) => sftkGlyphFor(!!_settings.proMode, emoji, label);

// Normalize the persisted ds_settings blob: defaults for missing keys,
// unknown keys preserved (forward/backward compat across agents' features),
// proMode coerced to a real boolean.
// ═══ W12 — MASS EDIT: the PURE planner ═══════════════════════════════════
// Validates + coerces ONE new value against the field's describe, then
// plans per-record updates: records already holding the value are SKIPPED
// (idempotent by construction — a re-run touches nothing), everything else
// gets { id, before } so the CSV backup and the before→after preview both
// come straight from the plan. A bad value fails HERE, not 3,000 rows deep.
//   records:   [{ Id, <field>: currentValue, ... }]
//   fieldDesc: the describe entry for the field being set
//   rawValue:  what the user typed ('' + setNull:true → explicit null)
//   opts:      { setNull }
// Returns { ok, value, updates: [{id, before}], unchanged, errors, warnings }
function sftkMassEditPlan(records, fieldDesc, rawValue, opts) {
  const out = { ok: false, value: null, updates: [], unchanged: 0, errors: [], warnings: [] };
  if (!fieldDesc || !fieldDesc.name) { out.errors.push('no field selected'); return out; }
  if (fieldDesc.updateable === false) {
    out.errors.push(`${fieldDesc.name} is not updateable — Salesforce will reject every row`);
    return out;
  }
  const t = fieldDesc.type;
  let value = null;
  if (opts?.setNull) {
    if (fieldDesc.nillable === false) {
      out.errors.push(`${fieldDesc.name} is REQUIRED — it cannot be set to empty`);
      return out;
    }
    value = null;
  } else {
    const s = String(rawValue ?? '').trim();
    if (s === '') { out.errors.push('no value entered — use "set to empty" to clear the field deliberately'); return out; }
    if (t === 'boolean') {
      if (!/^(true|false)$/i.test(s)) { out.errors.push(`${fieldDesc.name} is a checkbox — the value must be true or false`); return out; }
      value = /^true$/i.test(s);
    } else if (['double', 'currency', 'percent', 'int', 'integer'].includes(t)) {
      const n = Number(s);
      if (!Number.isFinite(n)) { out.errors.push(`"${s}" is not a number (${fieldDesc.name} is ${t})`); return out; }
      if ((t === 'int' || t === 'integer') && !Number.isInteger(n)) { out.errors.push(`${fieldDesc.name} takes whole numbers only`); return out; }
      value = n;
    } else if (t === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) { out.errors.push(`${fieldDesc.name} is a date — use YYYY-MM-DD`); return out; }
      value = s;
    } else if (t === 'datetime') {
      if (Number.isNaN(Date.parse(s))) { out.errors.push(`"${s}" is not a valid date/time (${fieldDesc.name})`); return out; }
      value = new Date(s).toISOString();
    } else if (t === 'reference') {
      if (!/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(s)) { out.errors.push(`${fieldDesc.name} is a lookup — the value must be a 15/18-character record Id FROM THIS ORG`); return out; }
      value = s;
      out.warnings.push(`${fieldDesc.name} is a lookup — make sure ${s} is an Id in the org being edited (Ids never transfer between orgs)`);
    } else if (t === 'picklist' || t === 'multipicklist') {
      const allowed = (fieldDesc.picklistValues || []).filter(v => v.active !== false).map(v => v.value);
      const parts = t === 'multipicklist' ? s.split(';').map(x => x.trim()).filter(Boolean) : [s];
      const bad = allowed.length ? parts.filter(pv => !allowed.includes(pv)) : [];
      if (bad.length && fieldDesc.restrictedPicklist) {
        out.errors.push(`"${bad.join('", "')}" is not an active value of ${fieldDesc.name} (restricted picklist) — every row would fail`);
        return out;
      }
      if (bad.length) out.warnings.push(`"${bad.join('", "')}" is not currently a value of ${fieldDesc.name} — Salesforce will accept it (unrestricted) but filters and reports won't know it`);
      value = t === 'multipicklist' ? parts.join(';') : s;
    } else {
      if (fieldDesc.length && s.length > fieldDesc.length) {
        out.errors.push(`the value is ${s.length} characters but ${fieldDesc.name} holds at most ${fieldDesc.length}`);
        return out;
      }
      value = s;
    }
  }
  const norm = v => (v == null || v === '') ? '' : String(v);
  for (const r of (records || [])) {
    if (!r || !r.Id) continue;
    if (norm(r[fieldDesc.name]) === norm(value)) { out.unchanged++; continue; }
    out.updates.push({ id: r.Id, before: r[fieldDesc.name] ?? null });
  }
  out.ok = true;
  out.value = value;
  return out;
}

function sftkSettingsShape(raw) {
  // undoCapture: read a restore point before every data deployment (↩ Roll
  // back in History). Default ON — a production mistake is the case it exists for.
  const s = { historyDays: 30, countsOnly: false, proMode: false, undoCapture: true, ...(raw || {}) };
  s.proMode = !!s.proMode;
  return s;
}

// Apply (not persist) professional mode. Persisting is the caller's job —
// storageLoad calls this with the stored value; the toggle saves explicitly.
function applyProMode(on) {
  _settings.proMode = !!on;
  document.body.classList.toggle('ds-pro', _settings.proMode);
  const btn = eid('dsProToggle');
  if (btn) {
    btn.classList.toggle('ds-pro-toggle--on', _settings.proMode);
    btn.setAttribute('aria-pressed', _settings.proMode ? 'true' : 'false');
    btn.title = _settings.proMode
      ? 'Professional mode is on — plain-text labels, tighter density. Click to switch back.'
      : 'Professional mode — replaces emoji with plain text and tightens density (presentation-friendly)';
  }
  // The dark toggle's label is emoji written from JS (not CSS-hideable) —
  // refresh it here so flipping pro mode doesn't leave a stale 🌙/☀️ behind.
  const dk = eid('dsDarkToggle');
  if (dk) dk.textContent = window.sftkGlyph('', _darkMode ? 'Light' : 'Dark');
}

// Kick off the ds_settings read IMMEDIATELY at script evaluation — the same
// fire-and-forget early read the dark-mode class uses in the popup shell
// (popup.js initDarkTheme). Scripts sit at the end of <body>, so
// document.body already exists here, and this single get() resolves before
// storageLoad()'s migration-check round-trips do — the earliest an MV3 page
// (no inline scripts) can get body.ds-pro on, so pro users don't see the
// emoji chrome flash. storageLoad() re-applies from the same key right after.
chrome.storage?.local?.get('ds_settings')
  .then(d => { if (sftkSettingsShape(d?.ds_settings).proMode) applyProMode(true); })
  .catch(() => {});

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
    <span class="ds-session-banner-icon">${window.sftkGlyph('🔑', '')}</span>
    <div class="ds-session-banner-body">
      <strong>Salesforce session expired — ${esc(label)}</strong>
      <span>Open that org in any Chrome tab (even just the home page), then click Reconnect.</span>
    </div>
    <button class="ds-btn ds-btn-primary ds-btn-sm" id="dsSessionReconnect">${window.sftkGlyph('🔄 ', '')}Reconnect</button>
    <button class="ds-btn ds-btn-sm ds-btn-xs" id="dsSessionDismiss">✕</button>`;

  const main = eid('dsMain');
  if (main) main.insertAdjacentElement('afterbegin', banner);

  eid('dsSessionDismiss')?.addEventListener('click', () => banner.remove());

  eid('dsSessionReconnect')?.addEventListener('click', async () => {
    const reconnBtn = eid('dsSessionReconnect');
    if (reconnBtn) { reconnBtn.disabled = true; reconnBtn.textContent = `${window.sftkGlyph('🔄 ', '')}Reconnecting…`; }

    // Re-detect all open SF sessions
    const allRes = await sendBg({ type: 'GET_ALL_SF_SESSIONS' });
    _allSessions = allRes?.sessions || [];
    _allSessionsOk = _allSessionsOk || Array.isArray(allRes?.sessions);
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
    'ds_dark_mode','sftk_dark','sftk_oled','ds_activity_log','sftk_sequences','sftk_active_run',
    'ds_working_pair','ds_settings','ds_ring'
  ]);
  _profiles     = d.sftk_profiles   || [];
  _history      = d.sftk_history    || [];
  _orgs         = d.sftk_orgs       || {};
  // X5: one shared dark-mode preference across both apps. Read the canonical
  // key (sftk_dark, also used by the popup + log viewer), falling back to the
  // legacy studio-only key for users who set it before unification.
  _darkMode     = (d.sftk_dark ?? d.ds_dark_mode) || false;
  _oledMode     = d.sftk_oled || false;
  _activityLog  = d.ds_activity_log || {};
  _sequences    = d.sftk_sequences  || [];
  _workingPair  = d.ds_working_pair || { src: '', tgt: '' };
  _settings     = sftkSettingsShape(d.ds_settings);
  // E4: professional mode rides the SAME early storage read dark mode uses
  // (this get() call) — body.ds-pro lands here, before the first view render,
  // so no rendered content ever flashes emoji at a pro-mode user. The static
  // topbar/nav glyphs are CSS-hidden the moment the class lands.
  applyProMode(_settings.proMode);

  // M2: ring config — migrate the legacy working pair into a 2-org ring the
  // first time (its source becomes the source of truth).
  _ring = d.ds_ring || null;
  if (!_ring && _workingPair.src) {
    _ring = { orgs: [_workingPair.src, _workingPair.tgt].filter(Boolean), sourceUrl: _workingPair.src };
    chrome.storage.local.set({ ds_ring: _ring }).catch(() => {});
  }
  if (_ring?.sourceUrl) _workingPair.src = _ring.sourceUrl;   // keep default-seeding paths alive

  // 2026-07-20 migration: earlier builds SNAPSHOTTED targetOrgs on every
  // builder open. A pinned set identical to the current ring targets carries
  // no information — convert it to follow-mode (null) so those deployments
  // track the ring, which is what the default should have been.
  if (typeof _ring === 'object' && _ring?.sourceUrl) {
    const ringKeys = new Set((_ring.orgs || [])
      .filter(u => _orgKey(u) !== _orgKey(_ring.sourceUrl)).map(u => _orgKey(u)));
    for (const p of _profiles) {
      if (!Array.isArray(p.targetOrgs)) continue;
      const keys = p.targetOrgs.map(u => _orgKey(u));
      if (keys.length === ringKeys.size && keys.every(k => ringKeys.has(k))) p.targetOrgs = null;
    }
  }
  syncRingFollowers();

  // Retention (S5): purge history entries older than the configured window.
  // "Delete after N days" means DELETE — the on-PC archive purges too, not
  // just the hot tier (the archive must never become a hidden copy).
  if (_settings.historyDays > 0) {
    const cutoff = Date.now() - _settings.historyDays * 86400000;
    if (_history.length) {
      const kept = _history.filter(h => {
        const t = new Date(h.startedAt || h.finishedAt || 0).getTime();
        return !Number.isFinite(t) || t === 0 || t >= cutoff;   // keep undated entries
      });
      if (kept.length !== _history.length) {
        _history = kept;
        storageSaveHistory().catch(() => {});
      }
    }
    if (typeof sftkArchDeleteOlderThan === 'function') {
      sftkArchDeleteOlderThan(new Date(cutoff).toISOString()).catch(() => {});
    }
    // ↩ restore points hold record data about the orgs — same retention.
    if (typeof sftkUndoStoreDeleteOlderThan === 'function') {
      sftkUndoStoreDeleteOlderThan(new Date(cutoff).toISOString()).catch(() => {});
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
      `${window.sftkGlyph('⚠ ', '')}A previous ${ar.kind || 'run'} looks interrupted (started ${timeAgo(ar.startedAt)}). Check History and re-scan before re-running.`,
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

// Counts-only mode (S5): strip per-record ids/labels before anything hits
// disk. Counts, errors, and org URLs stay; record links disappear. Applied
// to BOTH tiers — the archive stores exactly what the hot tier would.
function _historyStripCountsOnly(entries) {
  if (!_settings.countsOnly) return;
  for (const h of (entries || [])) {
    delete h.failedSourceIds;
    if (h.summary) for (const obj of Object.values(h.summary)) {
      if (obj && typeof obj === 'object') {
        delete obj.targetRecords; delete obj.failedRecords; delete obj.failedSourceIds;
      }
    }
  }
}

// Phase 3 — the popup's tools write History entries (kind 'tool') straight
// to chrome.storage while this page may hold its own copy in memory. Merge
// what arrives from elsewhere so the next storageSaveHistory keeps it and
// the History view shows it without a reload.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.sftk_history) return;
    const incoming = (changes.sftk_history.newValue || []).filter(e => e && e.kind === 'tool' && !_history.some(h => h && h.id === e.id));
    if (!incoming.length) return;
    _history.push(...incoming);
    if (_currentView === 'history' && typeof renderHistory === 'function') renderHistory();
  });
} catch (_) { /* no storage events outside the extension page */ }

async function storageSaveHistory() {
  // Two tiers (user 2026-08-11: "we can hit limits there very fast") — the
  // hot tier stays the newest 100 in chrome.storage; overflow runs are
  // ARCHIVED to IndexedDB (on-PC, GB-scale) instead of deleted forever.
  const split = (typeof sftkHistorySplit === 'function')
    ? sftkHistorySplit(_history, 100)
    : { keep: _history.slice(-100), overflow: [] };
  _history = split.keep;
  _historyStripCountsOnly(_history);
  if (split.overflow.length && typeof sftkArchPut === 'function') {
    _historyStripCountsOnly(split.overflow);
    sftkArchPut(split.overflow).catch(() => { /* archive is best-effort */ });
  }
  try {
    await chrome.storage.local.set({ sftk_history: _history });
  } catch (e) {
    // QUOTA path: spill the older half of the hot tier to the archive and
    // retry ONCE — losing the newest runs silently is the one outcome this
    // feature exists to prevent.
    const spill = _history.slice(0, Math.ceil(_history.length / 2));
    _history = _history.slice(spill.length);
    if (typeof sftkArchPut === 'function') { try { await sftkArchPut(spill); } catch (_) {} }
    try {
      await chrome.storage.local.set({ sftk_history: _history });
      showToast?.('Storage quota hit — older runs were moved to the on-PC archive (History page → 📦).', 'warning', 6000);
    } catch (e2) {
      showToast?.(`History could not be saved (${e2?.message || 'storage quota'}) — export it from the History page before it is lost.`, 'error', 8000);
    }
  }
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
  // Same (?) help wiring as setMain — modals are the other paint chokepoint.
  try { window.SFTKOnboard?.wireHelp?.(box); } catch (_) {}
}

function closeModal() {
  // ↩ A rollback (or any flow that sets the lock) is writing: Escape and
  // stray close calls must not hide a destructive operation in flight.
  if (window._sftkModalLock) return;
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
//   https://acme-dev.develop.my.salesforce.com  →  acme-dev.develop
//   https://acme-dev.develop.lightning.force.com → acme-dev.develop
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
  // Licence gate first — before storage, before any org session, before a
  // single API call. Declining leaves the page blocked and the orgs
  // untouched (user 2026-08-26).
  if (typeof sftkTermsGate === 'function' && !(await sftkTermsGate())) return;

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
  _allSessionsOk = _allSessionsOk || Array.isArray(allRes?.sessions);
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
      case 'editProfile':           window.editProfile?.(arg); break;
      case 'cloneProfile':          window.cloneProfile?.(arg); break;
      case 'deleteProfile':         window.deleteProfile?.(arg); break;
      case 'refreshState':          window.refreshProfileState?.(arg); break;
      case 'openReconcile':         window.openReconcile?.(arg); break;
      case 'retryFailed':           window.retryFailedRun?.(arg); break;
      case 'runAgain':              window.runAgain?.(arg); break;
      case 'rollbackRun':           window.rollbackRun?.(arg); break;
      case 'undoTool':              window.undoTool?.(arg); break;
      case 'openOrgTab':            chrome.tabs.create({ url: arg }); break;
      case 'compareOrgFrom':        window.compareOrgFrom?.(arg); break;
      case 'toggleReadOnly':        window.toggleOrgReadOnly?.(arg); break;
      case 'toggleGuardProd':       window.toggleOrgGuardProd?.(arg); break;
      case 'saveEphemeralProfile':  window.saveEphemeralProfile?.(); break;
      case 'openDeployView':        window.sftkOpenDeployView?.(); break;
      case 'deployToClassic':       window.sftkDeployToClassic?.(); break;
      case 'showSecurity':          showSecurityModal(); break;
      case 'showTerms':             if (typeof sftkTermsShow === 'function') sftkTermsShow(); break;
      case 'switchView': {
        // Generic data-dsaction view switcher — routes through the hash (U6).
        if (arg) navigateToView(arg);
        break;
      }
    }
  });

  // Apply persisted dark mode immediately (OLED variant rides on it)
  applyDarkMode(_darkMode);
  applyOledMode(_oledMode);

  // Wire dark mode + OLED toggles
  eid('dsDarkToggle')?.addEventListener('click', () => applyDarkMode(!_darkMode));
  eid('dsOledToggle')?.addEventListener('click', () => applyOledMode(!_oledMode));

  // E4: professional-mode toggle — persists in ds_settings, then re-renders
  // the current view so JS-baked glyphs update (views are stateless full
  // re-renders; static chrome is handled purely by the body.ds-pro CSS).
  eid('dsProToggle')?.addEventListener('click', async () => {
    applyProMode(!_settings.proMode);
    try { await storageSaveSettings(); } catch (_) {}
    // The Profile Builder holds unsaved in-memory edits — don't blow it away.
    // Its baked-in glyphs update on its next render.
    if (document.querySelector('.ds-builder-wrap')) return;
    if (document.querySelector('.ds-welcome-wrap')) { renderWelcome(); return; }
    renderView(_currentView);
  });

  // Wire command palette button
  eid('dsCmdPaletteBtn')?.addEventListener('click', () => openCommandPalette());

  // Wire security badge
  eid('dsSecurityBtn')?.addEventListener('click', showSecurityModal);

  // ── Back to Toolkit button ────────────────────────────────────
  // "‹ Toolkit" — actually take the user to the Toolkit. The old behaviour
  // just closed this tab, which only "went back" if the popup happened to
  // still be open underneath (it never is — popups close on focus loss).
  // Chrome can't reliably reopen the toolbar popup from a page, but the
  // Focus an already-open Toolkit tab if there is one, else open one.
  // already open, otherwise open it as a popup window.
  eid('dsBackToToolkit')?.addEventListener('click', () => openToolkit(null));

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
// a11y: toasts are the Studio's only transient status surface. The live-region
// attributes must be on the container BEFORE any toast is appended — a region
// born in the same tick as its first content is not announced by most screen
// readers. The container is static markup (studio.html) and scripts load at
// the end of <body>, so it is already in the DOM at script evaluation.
{
  const tc = eid('dsToastContainer');
  if (tc) {
    tc.setAttribute('role', 'status');
    tc.setAttribute('aria-live', 'polite');
  }
}

function showToast(message, type = 'info', durationMs = 3500) {
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  // E4: plain-text stand-ins in professional mode — the icon carries state
  // (success/error), so it's swapped rather than dropped.
  const plain = { success: '✓', error: '✕', warning: '!', info: 'i' };
  const container = eid('dsToastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `ds-toast ds-toast-${type}`;
  // NO role=alert on the toast node: an alert nested inside the polite
  // live-region container above is TWO live regions announcing one
  // insertion — double-spoken on some screen reader/browser pairs. One
  // region, one announcement; errors are announced politely like the rest,
  // which still beats the silence they had before.
  toast.innerHTML = `<span class="ds-toast-icon">${window.sftkGlyph(icons[type] || 'ℹ️', plain[type] || 'i')}</span><span>${esc(message)}</span>`;
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
  // OLED rides on dark: the class pair is only ever applied together, and
  // the OLED pill only shows while dark is on (it's a no-op in light mode).
  document.documentElement.classList.toggle('ds-oled', on && _oledMode);
  const oledBtn = eid('dsOledToggle');
  if (oledBtn) oledBtn.style.display = on ? '' : 'none';
  const btn = eid('dsDarkToggle');
  if (btn) {
    // E4: plain-text label in professional mode (window.sftkGlyph).
    // The glyph is a masked ::before driven by data-i (see the topbar block
    // in studio.css) — an ATTRIBUTE, because this very assignment destroys
    // any child node an icon <span> would live in. Same mechanism the Apex
    // Debugger uses for its ten relabelled buttons. Pro mode still swaps in
    // the plain-text label; the ::before is hidden there by .ds-pro.
    btn.setAttribute('data-i', on ? 'sun' : 'moon');
    btn.textContent = window.sftkGlyph('', on ? 'Light' : 'Dark');
    btn.title = on ? 'Switch to light mode' : 'Switch to dark mode';
    // a11y: outside pro mode the label IS an emoji, which no AT announces as
    // an action. title= alone is not exposed as a name by every AT, so the
    // accessible name is set here and kept in step with the state.
    btn.setAttribute('aria-label', btn.title);
  }
  // X5: write the canonical shared key (sftk_dark) so the popup + log viewer
  // pick up the same choice; keep ds_dark_mode in sync for back-compat.
  chrome.storage.local.set({ sftk_dark: on, ds_dark_mode: on });
}

// OLED — absolute black riding on dark mode (user 2026-08-09: "dark for
// oled screens"). Pure-black token overrides live in .ds-dark.ds-oled; the
// class pair is only applied together, so light mode never carries it.
function applyOledMode(on) {
  _oledMode = on;
  document.documentElement.classList.toggle('ds-oled', _darkMode && on);
  const ob = eid('dsOledToggle');
  if (ob) {
    ob.classList.toggle('ds-oled-on', on);
    ob.setAttribute('aria-pressed', on ? 'true' : 'false');
    ob.title = on
      ? 'OLED black is on — switch back to standard dark surfaces'
      : 'Absolute black for OLED screens — pure-black surfaces (rides on dark mode)';
  }
  chrome.storage.local.set({ sftk_oled: on });
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
// `i` is a data-i mask name from the shared glyph table (styles.css declares
// it unscoped, studio.css §1 appends the Studio glyphs) and must be the SAME
// name the view's sidebar-nav button carries in studio.html (What's New: the
// topbar megaphone) — a palette row and its nav row are one feature and must
// wear one icon.
const CMD_VIEWS = [
  { i: 'plug',      label: 'Connected Orgs',   view: 'orgs',      desc: 'Manage connections' },
  { i: 'box',       label: 'Data Deployment',  view: 'profiles',  desc: 'Profiles + run transfer' },
  { i: 'repeat',    label: 'Sync Ring',        view: 'ring',      desc: 'All orgs vs the source of truth' },
  { i: 'sliders',   label: 'Picklist Manager', view: 'picklists', desc: 'Values & record types across orgs' },
  { i: 'scroll',    label: 'History',          view: 'history',   desc: 'Past transfer runs' },
  { i: 'search',    label: 'Org Compare',      view: 'compare',   desc: 'Diff data across many objects' },
  { i: 'shield',    label: 'Deploy Readiness', view: 'readiness', desc: 'Schema compatibility' },
  { i: 'chart',     label: 'Org health',       view: 'orghealth', desc: 'What needs attention in one org' },
  { i: 'flow',      label: 'Schema View',      view: 'schema',    desc: 'Flow & object graph' },
  { i: 'megaphone', label: "What's New",       view: 'whatsnew',  desc: 'Changelog — what shipped, per version' },
];

// Toolkit (popup) features — selecting one opens/focuses the Toolkit
// window deep-linked to that tab. Ids match popup.js HOME_FEATURES, and so
// must the `i` mask names — the popup's own palette renders these features
// from HOME_FEATURES, so a name drift here shows the same feature with two
// different icons depending on which app's palette is open.
const CMD_TOOLKIT = [
  { i: 'nodes',   label: 'Flows',            tab: 'flows',        desc: 'Bulk delete, backup & restore' },
  { i: 'share',   label: 'Dependencies',     tab: 'dependencies', desc: 'Subflow call chains' },
  { i: 'bug',     label: 'Apex Debugger',    tab: 'debugger',     desc: 'Trace flows, triggers, recursion' },
  { i: 'layout',  label: 'Lightning Pages',  tab: 'pages',        desc: 'Assignments & org defaults' },
  { i: 'sliders', label: 'Field Cleaner',    tab: 'fields',       desc: 'Scan deps, fix flows, delete fields' },
  { i: 'users',   label: 'Copy Permissions', tab: 'copy-perms',   desc: 'Copy perms between users' },
  { i: 'key',     label: 'Licenses',         tab: 'licenses',     desc: 'Manage license assignments' },
  { i: 'shield',  label: 'Flow Access',      tab: 'flow-access',  desc: 'Grant flows to permission sets' },
];

// Open (or focus) the Toolkit; when `tab` is given, deep-link to that feature
// — a fresh tab gets it via the ?tab= URL param, an already-open one via a
// TOOLKIT_NAVIGATE runtime message.
//
// This used to spawn a chromeless `type:'popup'` WINDOW (the "popout"
// feature). The user removed the Toolkit's own Popout button as "annoying and
// doesn't work good" (2026-07-30), and a back-button that conjures a second
// chromeless window is the same feature wearing a different hat — so this
// opens an ordinary tab now, matching what clicking the extension icon does.
async function openToolkit(tab) {
  const base = chrome.runtime.getURL('popup.html');

  // Find an already-open Toolkit by ASKING it (TOOLKIT_PING) instead of
  // tabs.query({url}) — URL-filtered queries silently stopped matching when
  // the "tabs" permission was dropped (security S9), which made this button
  // open a NEW Toolkit every time instead of focusing the one you came from.
  // Pinging needs no permission: the page answers with its tab id
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
    await chrome.tabs.create({ url: `${base}${tab ? `?tab=${encodeURIComponent(tab)}` : ''}` });
  } catch (_) { /* the tab could not be opened; nothing else to fall back to */ }
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
    const navItems = CMD_VIEWS.filter(v => _viewAvailable(v.view)).filter(v =>
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
          <span class="ds-cmd-item-icon">${dsIcon(v.i)}</span>
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
          <span class="ds-cmd-item-icon">${dsIcon(t.i)}</span>
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
          <span class="ds-cmd-item-icon">${dsIcon('play')}</span>
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
        openToolkit(el.dataset.cmdToolkit);
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
        if (t) { closePalette(); openToolkit(t.tab); }
      } else {
        const p = profileItems[activeIdx - navItems.length - toolkitItems.length];
        if (p) { closePalette(); window.runProfile?.(p.id); }
      }
    }
  }

  overlay.innerHTML = `
    <div class="ds-cmd-box">
      <div class="ds-cmd-search-row">
        <span class="ds-cmd-search-icon">${dsIcon('search')}</span>
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

      <div class="sec-section-title">${window.sftkGlyph('✅ ', '')}What it DOES</div>
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

      <div class="sec-section-title">${window.sftkGlyph('🚫 ', '')}What it NEVER does</div>
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
        <strong>${window.sftkGlyph('🔍 ', '')}Fully inspectable:</strong> This is a Chrome extension — you can review every line of code at
        <code>chrome://extensions</code> → Details → Inspect views. All network requests appear in the DevTools Network tab.
        There is no minified or obfuscated code.
      </div>

    </div>

    <div class="ds-modal-footer">
      <button class="ds-btn" data-dsaction="showTerms" title="Read the licence agreement and privacy notes you accepted">📜 Licence &amp; privacy</button>
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
        ${_viewAvailable('schema') ? `<div class="ds-welcome-card" data-gotoview="schema">
          <div class="ds-welcome-card-icon">🕸</div>
          <div class="ds-welcome-card-title">Schema View</div>
          <div class="ds-welcome-card-desc">Visualize how objects relate to each other and which flows run on them.</div>
          <span class="ds-welcome-card-badge ds-badge-read">Read-only</span>
          ${activityBadge('schema')}
        </div>` : ''}
      </div>

      <div class="ds-welcome-trust">
        <span class="ds-welcome-trust-icon">🔒</span>
        <span>All operations run <strong>locally in your browser</strong>. No data is ever sent to external servers. ${_viewAvailable('schema') ? 'Schema View and Deploy Readiness are' : 'Deploy Readiness is'} completely read-only.</span>
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
        <span class="ds-gs-title">${window.sftkGlyph('🚀 ', '')}Get started <span class="ds-gs-progress">${doneN} of ${steps.length}</span></span>
        <button class="ds-gs-dismiss" id="dsGsDismiss" title="Hide this checklist">✕</button>
      </div>
      <div class="ds-gs-steps">
        ${steps.map((s, i) => `
          <div class="ds-gs-step${s.done ? ' ds-gs-done' : ''}" data-gs-view="${s.view}" title="Go to ${esc(s.label)}">
            <span class="ds-gs-check">${s.done ? window.sftkGlyph('✅', '✓') : (i + 1)}</span>
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
  'orgs', 'profiles', 'ring', 'picklists', 'history', 'compare', 'readiness', 'schema', 'fields', 'transfer',
  'whatsnew', 'orghealth',
]);

function _viewFromHash() {
  const m = /^#\/([a-z-]+)/.exec(location.hash || '');
  return m && DS_HASH_VIEWS.has(m[1]) && _viewAvailable(m[1]) ? m[1] : null;
}

// Apply a view without touching the hash (used by the hashchange handler and
// initial load). Highlights the tab and renders.
function _applyView(view) {
  document.querySelectorAll('.ds-nav-btn').forEach(b => {
    const on = b.dataset.view === view;
    b.classList.toggle('active', on);
    // E4 a11y: aria-current mirrors the visual active state for screen readers.
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
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

// Store builds ship WITHOUT the Labs files — a view whose render function
// isn't loaded falls back to home.
// Palette/hash entries for absent views are filtered by this same check.
function _viewAvailable(view) {
  const need = { readiness: 'renderReadiness', schema: 'renderSchemaView', fields: 'renderFieldAudit',
                 whatsnew: 'renderWhatsNew', orghealth: 'renderOrgHealth' };
  return !need[view] || typeof window[need[view]] === 'function';
}

// ── Deployment targets: FOLLOW THE RING unless pinned ─────────────────────
// (user decision 2026-07-20). p.targetOrgs === null/undefined means the
// deployment follows the ring — its target set is resolved LIVE here, so
// growing the ring grows every following deployment. An array means the
// user pinned a specific set in the builder. p.targetOrg (the schema
// reference every engine path reads) is kept in sync by syncRingFollowers().
function profileFollowsRing(p) { return !!p && !Array.isArray(p.targetOrgs); }
function profileTargets(p) {
  if (!p) return [];
  // An org is NEVER a target of itself — every record would match itself and
  // a "sync" would write the source onto the source. The builder locks the
  // source out of the picker, but this is the chokepoint every run, scan and
  // fan-out resolves through, so a profile saved before that lock (or edited
  // by hand / imported from a file) is corrected here too. (2026-07-30)
  const notSelf = u => _orgKey(u) !== _orgKey(p.sourceOrg || '');
  if (Array.isArray(p.targetOrgs)) return p.targetOrgs.filter(notSelf);
  if (typeof _ring === 'object' && _ring?.sourceUrl && (_ring.orgs || []).length >= 2) {
    return (_ring.orgs || []).filter(u => _orgKey(u) !== _orgKey(_ring.sourceUrl) && notSelf(u));
  }
  return (p.targetOrg && notSelf(p.targetOrg)) ? [p.targetOrg] : [];
}
// ── Per-target field-mapping overrides (user 2026-07-20) ──────────────────
// node.fieldMappingOverrides = { [orgKey]: { srcField: tgtName|null } } — a
// SPARSE overlay on the base node.fieldMappings for targets whose schema
// genuinely differs (renamed fields). null = exclude for that org only.
// Resolution happens at scan/run launch (treeForTarget) — the engine and
// every downstream consumer keep seeing one plain fieldMappings map.
function sftkResolveMappings(base, overrides, orgKey) {
  const out = { ...(base || {}) };
  const ov = (overrides || {})[orgKey];
  if (ov) for (const k of Object.keys(ov)) out[k] = ov[k];
  return out;
}
function treeForTarget(tree, tgtUrl) {
  if (!tree || !tgtUrl) return tree;
  const key = _orgKey(tgtUrl);
  const hasOv = n => n && n.fieldMappingOverrides && n.fieldMappingOverrides[key];
  const anyOv = (function scan(n) { return !!n && (hasOv(n) || (n.children || []).some(scan)); })(tree);
  if (!anyOv) return tree;   // fast path — nothing to resolve
  const walk = n => ({
    ...n,
    fieldMappings: sftkResolveMappings(n.fieldMappings, n.fieldMappingOverrides, key),
    children: (n.children || []).map(walk),
  });
  return walk(tree);
}

function syncRingFollowers() {
  let changed = false;
  let srcMoved = 0;
  const crown = (typeof _ring === 'object' && _ring?.sourceUrl && (_ring.orgs || []).length >= 2)
    ? _ring.sourceUrl : '';
  for (const p of (_profiles || [])) {
    if (!p || p.ephemeral) continue;
    // SOURCE follows the crown DYNAMICALLY (user 2026-08-11: "if the source
    // is changed in the toolkit, it needs to be changed here as well…
    // handle it all dynamically") — unless the user PINNED a custom source
    // in the Builder (p.sourcePinned). Every move is stamped so the Builder
    // can warn that compares made before it measured FROM the old source;
    // the Reconcile stale-guard and the crown-change re-baseline handle the
    // scans themselves.
    if (crown && !p.sourcePinned && p.sourceOrg && _orgKey(p.sourceOrg) !== _orgKey(crown)) {
      p._srcCrownMoved = { from: p.sourceOrg, to: crown, at: new Date().toISOString() };
      p.sourceOrg = crown;
      srcMoved++; changed = true;
    }
    if (!profileFollowsRing(p)) continue;
    const first = profileTargets(p)[0];
    if (first && _orgKey(first) !== _orgKey(p.targetOrg || '')) { p.targetOrg = first; changed = true; }
  }
  if (changed) { try { storageSaveProfiles().catch(() => {}); } catch (_) {} }
  return { srcMoved };
}

function renderView(view) {
  if (!_viewAvailable(view)) view = 'orgs';
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
    case 'deploy':    renderReconcile();   break;   // the seam in renderReconcile routes to renderDeploy
    case 'compare':   renderOrgCompare(); break;
    case 'picklists': renderPicklists();  break;
    case 'ring':      renderRing();       break;
    // The Org Seeder ships only in the dev build while it is hardened
    // (user 2026-08-31: "I dont want the org seeder to be available now.
    // we need to test it more") — the packer strips its file and nav. A
    // remembered last-view of 'seed' must land somewhere real, not on a
    // blank page.
    case 'seed':
      if (typeof window.renderSeed === 'function') window.renderSeed();
      else { _currentView = 'profiles'; renderProfiles(); }
      break;
    case 'whatsnew':  renderWhatsNew();     break;   // T10 — studio-whatsnew.js
    case 'orghealth': renderOrgHealth();    break;   // campaign 3 phase 8 — studio-orghealth.js
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
    // A lastScan stamped for a DIFFERENT pair describes an older
    // configuration — its counts must never render under the current
    // pair's label (same stamp law as the ring matrix and the chooser).
    const stale = !!((s.sourceOrg && sftkOrgKey(s.sourceOrg) !== sftkOrgKey(p.sourceOrg || ''))
      || (s.targetOrg && sftkOrgKey(s.targetOrg) !== sftkOrgKey(p.targetOrg || '')));
    const missing = (s.missingInTarget || []).length;
    const changed = (s.changed || []).length;
    const extra   = (s.onlyInTarget || []).length;
    const drift   = missing + changed + extra;
    // CHILDREN gate this tile too (user 2026-08-18, live: the tile said
    // "✓ in sync" over 463 wrong child links — it read ROOT buckets only).
    // Fresh child scans with work count against sync; child sections with
    // no fresh scan make the pair UNVERIFIED, never silently clean.
    let kidNeed = 0, kidUnscanned = 0;
    const walkKid = (node, pathKey) => {
      const obj = node.objectType || node.childSObject || '?';
      const cs = s.children?.[pathKey];
      const fresh = !!(cs && cs.status === 'success' && cs.rootRunAt === s.runAt && cs.objectType === obj);
      if (!fresh) kidUnscanned++;
      else kidNeed += (cs.missingInTarget || []).length + (cs.changed || []).length
        + (cs.linkMismatch || []).length + (cs.onlyInTarget || []).length;
      (node.children || []).forEach((g, j) => walkKid(g, `${pathKey}.${j}`));
    };
    (p.tree?.children || []).forEach((c, i) => walkKid(c, String(i)));
    // 📎 Files gate the verdict everywhere — this tile included.
    const fMiss = (s.fileDrift && !s.fileDrift.error && s.fileDrift.records) || 0;
    const fErr  = !!s.fileDrift?.error;
    tiles.push({ id: p.id, name: p.name, missing, changed, extra, drift,
      kidNeed, kidUnscanned, fMiss, fErr, stale,
      src: p.sourceOrg, tgt: p.targetOrg, at: s.runAt });
  }
  if (!tiles.length) return '';
  tiles.sort((a, b) => (b.drift + b.kidNeed + b.fMiss) - (a.drift + a.kidNeed + a.fMiss));
  return `
    <div class="ds-sync-strip">
      <div class="ds-sync-strip-title">Sync status <span class="ds-sync-strip-sub">from your last scans</span></div>
      <div class="ds-sync-tiles">
        ${tiles.slice(0, 6).map(t => {
          const clean = !t.stale && t.drift === 0 && !t.kidNeed && !t.fMiss;
          let stats;
          if (t.stale) {
            stats = '<span class="ds-sync-c">scan is for a different org pair — rescan</span>';
          } else if (clean) {
            stats = t.fErr ? '<span class="ds-sync-c">✓ fields · 📎 file check failed</span>'
              : t.kidUnscanned
                ? `<span class="ds-sync-clean" title="Root object in sync — ${t.kidUnscanned} child section(s) have no fresh scan, so child records are UNVERIFIED. Open Reconcile and scan them.">✓ root · children unverified</span>`
                : '<span class="ds-sync-clean">✓ in sync</span>';
          } else {
            stats = `${t.missing ? `<span class="ds-sync-m">${t.missing} missing</span>` : ''}
                   ${t.changed ? `<span class="ds-sync-c">${t.changed} changed</span>` : ''}
                   ${t.extra ? `<span class="ds-sync-e">${t.extra} only in target</span>` : ''}
                   ${t.kidNeed ? `<span class="ds-sync-c">${t.kidNeed} child record(s)</span>` : ''}
                   ${t.fMiss ? `<span class="ds-sync-c">📎 ${t.fMiss} missing files</span>` : ''}`;
          }
          return `
          <div class="ds-sync-tile${clean && !t.kidUnscanned && !t.fErr ? ' ds-sync-ok' : ''}" data-sync-profile="${esc(t.id)}"
               title="Open Reconcile for ${esc(t.name)}">
            <div class="ds-sync-tile-name">${esc(t.name)}</div>
            <div class="ds-sync-tile-pair">${esc(orgLabel(t.src))} → ${esc(orgLabel(t.tgt))}</div>
            <div class="ds-sync-tile-stats">${stats}</div>
            <div class="ds-sync-tile-age">${t.at ? esc(timeAgo(t.at)) : ''}</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

// ════════════════════════════════════════════════════════════════
// CONNECTED ORGS PANEL
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
        <div class="ds-org-row-icon">${window.sftkGlyph(isOnline ? '🟢' : '⚫', '')}</div>
        <div class="ds-org-row-info">
          <div class="ds-org-row-label">
            ${esc(label)}
            ${prodBadge(url)}
            ${orgData.readOnly ? `<span class="ds-org-badge-current ds-badge-warn" title="Writes are locked: no tool in this extension can insert, update, delete or deploy into this org until you unlock it">${dsIcon('lock')}writes locked</span>` : ''}
            ${isCurrent ? '<span class="ds-org-badge-current">current tab</span>' : ''}
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
          <button class="ds-btn ds-btn-sm" data-dsaction="compareOrgFrom" data-arg="${esc(url)}" title="Compare this org's data against another org (opens Org Compare with this org as the source)">${window.sftkGlyph('🔍 ', '')}Compare with…</button>
          <button class="ds-btn ds-btn-sm" data-dsaction="editOrgLabel" data-arg="${esc(url)}">${window.sftkGlyph('✏ ', '')}Rename</button>
          <button class="ds-btn ds-btn-sm${orgData.guardAsProd ? ' ds-btn-config--active' : ''}" data-dsaction="toggleGuardProd" data-arg="${esc(url)}" title="${orgData.guardAsProd ? 'Stop treating this org like production (its real type is used again)' : 'Treat this org like PRODUCTION everywhere: every write asks you to type the org name, hard delete is refused, the badge shows. For a full-copy or UAT sandbox — or to see the production gates before you have a production org.'}">${orgData.guardAsProd ? '🛑 Guarded as production' : '🛑 Guard as production'}</button>
          <button class="ds-btn ds-btn-sm" data-dsaction="toggleReadOnly" data-arg="${esc(url)}" title="${orgData.readOnly ? 'Allow writes to this org again' : 'A safety lock, not a mode: while it is on, NOTHING in this extension can write to this org — not a deployment, not ← “target wins” into a source, not a delete, not a picklist or metadata deploy. Use it on production and on any org you only ever read from.'}">${orgData.readOnly ? `${window.sftkGlyph('🔓 ', '')}Unlock writes` : `${window.sftkGlyph('🔒 ', '')}Lock writes`}</button>
          ${!isOnline
            ? `<button class="ds-btn ds-btn-sm ds-btn-danger" data-dsaction="removeOrg" data-arg="${esc(url)}">✕</button>` : ''}
        </div>
      </div>`;
  }).join('');

  setMain(`
    ${dsViewHeader({
      icon: 'plug',
      title: 'Connected Orgs',
      // Same two numbers as before, in the same order, from the same arrays —
      // the count moves into the header's count slot, its meaning unchanged.
      subtitle: `${allOrgUrls.length} org${allOrgUrls.length !== 1 ? 's' : ''} known`,
      count: `${_allSessions.length} currently open in Chrome`,
      actions: `<button class="ds-btn ds-btn-primary" id="dsRefreshOrgsBtn">${dsIcon('refresh')}Refresh from open tabs</button>`,
    })}

    <!-- Was five hardcoded hex values in an inline style, so this panel stayed
         a light-blue card with #014486 text in DARK mode — the one element on
         this screen that never flipped. It is a class on the brand tokens now,
         which re-point per theme. -->
    <div class="ds-callout">
      <strong>${dsIcon('bulb')}How it works:</strong> The Studio auto-detects any Salesforce org you have open in a Chrome tab.
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
    if (btn) { btn.disabled = true; btn.textContent = `${window.sftkGlyph('🔄 ', '')}Refreshing…`; }
    const allRes = await sendBg({ type: 'GET_ALL_SF_SESSIONS' });
    _allSessions = allRes?.sessions || [];
    _allSessionsOk = _allSessionsOk || Array.isArray(allRes?.sessions);
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
    <div class="ds-modal-header">${window.sftkGlyph('✏ ', '')}Rename Org</div>
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
// Is this org write-locked? Matched by org IDENTITY (a profile may store the
// URL in another domain form than Connected Orgs does). Pages use it to say so
// up front; the service-worker chokepoint stays the enforcement.
window.sftkOrgLocked = function(orgUrl) {
  const want = _orgKey(orgUrl);
  if (!want) return false;
  return Object.entries(_orgs || {}).some(([u, o]) => o && o.readOnly && _orgKey(u) === want);
};

window.toggleOrgReadOnly = async function(orgUrl) {
  if (!_orgs[orgUrl]) _orgs[orgUrl] = {};
  const on = !_orgs[orgUrl].readOnly;
  _orgs[orgUrl].readOnly = on;
  await storageSaveOrgs();
  showToast(on
    ? `${window.sftkGlyph('🔒 ', '')}Writes to ${orgLabel(orgUrl)} are locked — nothing in this extension can change it until you unlock`
    : `${window.sftkGlyph('🔓 ', '')}${orgLabel(orgUrl)} is writable again`, on ? 'warning' : 'success');
  renderOrgsPanel();
};

window.toggleOrgGuardProd = async function(orgUrl) {
  if (!_orgs[orgUrl]) _orgs[orgUrl] = {};
  const on = !_orgs[orgUrl].guardAsProd;
  _orgs[orgUrl].guardAsProd = on;
  await storageSaveOrgs();
  showToast(on
    ? `🛑 ${orgLabel(orgUrl)} is now treated like PRODUCTION — every write will ask you to type its name`
    : `${orgLabel(orgUrl)} is back to its real org type`, on ? 'warning' : 'success');
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
    // The ring must not keep pointing at an org the map no longer knows —
    // a removed source used to survive as _ring.sourceUrl, so new
    // deployments silently seeded sourceOrg with an org whose select showed
    // "— Select source org —" (Fable recheck, behaviour audit).
    if (_ring) {
      _ring.orgs = (_ring.orgs || []).filter(u => _orgKey(u) !== _orgKey(orgUrl));
      if (_ring.sourceUrl && _orgKey(_ring.sourceUrl) === _orgKey(orgUrl)) _ring.sourceUrl = '';
      try { await chrome.storage.local.set({ ds_ring: _ring }); } catch (_) {}
    }
    // The topbar mirror must fall with the crown (review w703wnvrm): a
    // surviving _workingPair.src keeps currentSourceOrg() returning the
    // removed org — the closed <select> then displays whichever candidate
    // sorts first (impersonation), and new deployments seed from a ghost.
    if (typeof _workingPair === 'object' && _workingPair) {
      let wpDirty = false;
      if (_workingPair.src && _orgKey(_workingPair.src) === _orgKey(orgUrl)) { _workingPair.src = ''; wpDirty = true; }
      if (_workingPair.tgt && _orgKey(_workingPair.tgt) === _orgKey(orgUrl)) { _workingPair.tgt = ''; wpDirty = true; }
      if (wpDirty) { try { await storageSaveWorkingPair(); } catch (_) {} }
    }
    await storageSaveOrgs();
    closeModal();
    renderOrgsPanel();
    renderWorkingPair();
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
// Whether the live set is KNOWLEDGE or a partial guess — true only after a
// GET_ALL_SF_SESSIONS round-trip completed. Consumers must branch on this,
// not on set size (the active-tab session alone makes size 1 while
// enumeration may have failed, silently disabling every open target).
function _liveKnown() { return _allSessionsOk; }
function orgOptionLabel(url, label, liveSet) {
  const live = liveSet || _liveOrgSet();
  // Liveness markers only when the live set is KNOWLEDGE (enumeration
  // completed), not a partial guess. Painting '⚪ … (not open)' on unknown
  // data contradicted the fan-out advice on the very same row, which
  // correctly lets unknown targets through. Unknown → no marker at all.
  // (typeof guard: tests extract this function standalone.)
  const known = (typeof _liveKnown === 'function') ? _liveKnown() : live.size > 0;
  const on = known && live.has(_orgKey(url));
  // 👑 marks the Sync Ring's source of truth in EVERY org dropdown and
  // checkbox list app-wide (user directive 2026-07-17: the source org must be
  // recognizable in every feature, not just the ring view).
  const sot = !!(typeof _ring === 'object' && _ring?.sourceUrl &&
    (_ring.orgs || []).length >= 2 && _orgKey(url) === _orgKey(_ring.sourceUrl));
  // E4 pro mode: status dots drop (the "(not open)" suffix already carries
  // the offline state) and the 👑 source-of-truth chip becomes " — source".
  return `${known ? window.sftkGlyph(on ? '🟢 ' : '⚪ ', '') : ''}${label || orgLabel(url)}${sot ? window.sftkGlyph(' 👑', ' — source') : ''}${known && !on ? ' (not open)' : ''}`;
}

// ── Working org pair (topbar control) ─────────────────────────────
// Lives in the static topbar (outside #dsMain) so it survives every view
// re-render; renderView() repaints it so the options track newly-detected
// orgs. Changing the pair persists it and re-renders the current view —
// views are stateless full re-renders, so that's the whole propagation.
// M2: the topbar control is now a single SOURCE-OF-TRUTH chip (the old
// two-org PAIR was the wrong shape for a multi-org ring — user decision).
// It shows the ring's golden org; clicking picks a different source; the
// gear opens the Sync Ring view. _workingPair.src mirrors the choice so all
// existing default-seeding paths keep working; _workingPair.tgt is retired.
// THE one answer to "which org is the source right now" — the ring's source of
// truth, else the working pair. Everything that needs a default source must
// call this: the topbar chip resolved it one way and the Profile Builder
// another (_workingPair.src alone), so a new deployment could open with an
// empty source while the topbar plainly showed one (user 2026-07-30).
function currentSourceOrg() {
  return (typeof _ring === 'object' && _ring?.sourceUrl)
    || (typeof _workingPair === 'object' && _workingPair?.src)
    || '';
}

// ── THE crown setter — every source-of-truth change flows through here ──
// (user 2026-08-13: "I want to be able to change source org only in the
// upper menu. everything should calculate by it.") Before this, FIVE paths
// wrote _ring.sourceUrl with different subsets of the contract — the topbar
// (the control the user actually wants) was the weakest: no crown history,
// no re-baseline, no re-point disclosure. One writer, whole contract:
// history stamp → membership → follower re-point → persist → repaint →
// re-baseline. Returns { changed, moved }.
// opts.rerender=false lets the Builder keep its own repaint (renderView has
// no 'builder' case — a full view render would navigate away mid-edit).
async function dsSetSourceOfTruth(url, reason, opts = {}) {
  if (!url) return { changed: false };
  if (!_ring) _ring = { orgs: [], sourceUrl: '' };
  if (_ring.sourceUrl && _orgKey(_ring.sourceUrl) === _orgKey(url)) return { changed: false };
  const hadCrown = !!_ring.sourceUrl;
  // Crown history (user 2026-08-11: "it forgot that my original source of
  // truth was ashkenazy6") — the ring config offers ↩ restore.
  if (hadCrown) {
    _ring.prevSourceUrl = _ring.sourceUrl;
    _ring.prevSourceAt  = new Date().toISOString();
  }
  _ring.sourceUrl = url;
  if (!_ring.orgs.some(u => _orgKey(u) === _orgKey(url))) _ring.orgs.push(url);
  _workingPair.src = url;   // the topbar chip IS the crown — always in step
  try { await chrome.storage.local.set({ ds_ring: _ring }); } catch (_) {}
  try { storageSaveWorkingPair(); } catch (_) {}
  const moved = (typeof syncRingFollowers === 'function') ? syncRingFollowers() : null;
  showToast(`👑 ${orgLabel(url)} is now the source of truth — every ring surface follows it${moved?.srcMoved ? ` · ${moved.srcMoved} deployment(s) re-pointed (their earlier compares are marked stale)` : ''}`, 'success', 5500);
  renderWorkingPair();
  if (opts.rerender !== false) {
    // A crown change from the ALWAYS-VISIBLE topbar must not blow away an
    // open Builder session — renderView has no 'builder' case, so a full
    // view render would replace the editor with the profiles list and
    // discard unsaved edits (review w703wnvrm). The Builder's name input
    // exists only while the editor is on screen; repaint it in place so
    // the source column re-locks onto the new crown instead.
    if (eid('dsProfileName') && typeof renderBuilder === 'function') renderBuilder();
    else renderView(_currentView);
  }
  // Skip the re-baseline ONLY for a pristine first crown — the ring being
  // born, nothing measured yet. hadCrown alone was the wrong gate (review
  // w703wnvrm): removing the crown org clears sourceUrl while every
  // profile's ringScans baselines survive, and a FIRST crown can still
  // re-point existing deployments (srcMoved) whose scans were measured
  // FROM their old sources — both states must rescan like any crown move.
  const hadBaselines = hadCrown || moved?.srcMoved
    || (_profiles || []).some(p => p && !p.ephemeral && p.ringScans && Object.keys(p.ringScans).length);
  if (hadBaselines && typeof sftkRingRebaseline === 'function') {
    sftkRingRebaseline(reason || 'the source of truth changed');
  }
  return { changed: true, moved };
}
window.dsSetSourceOfTruth = dsSetSourceOfTruth;

function renderWorkingPair() {
  const el = eid('dsWorkingPair');
  if (!el) return;
  const orgs = allMapOrgs();
  if (!orgs.length) { el.innerHTML = ''; return; }
  const ls = _liveOrgSet();
  const srcUrl = currentSourceOrg();
  // EVERY known org, ring members first — not just _ring.orgs. The dropdown
  // is THE control now, so it must be able to crown an org that isn't a
  // ring member yet (user repro 2026-08-13: topbar showed ONLY orgfarm
  // while the ring config listed all 3 known orgs — a brand-new org had no
  // path to become source here). Crowning a non-member adds it to the ring.
  const inRing = u => (_ring?.orgs || []).some(x => _orgKey(x) === _orgKey(u));
  const candidates = [...orgs.map(o => o.url)]
    .sort((a, b) => (inRing(b) - inRing(a)));
  const ringExists = (_ring?.orgs?.length || 0) > 0;
  const opts = candidates.map(u => {
    const o = orgs.find(x => _orgKey(x.url) === _orgKey(u));
    const outside = ringExists && !inRing(u);
    return `<option value="${esc(u)}" ${_orgKey(u) === _orgKey(srcUrl) ? 'selected' : ''}>${esc(orgOptionLabel(u, o?.label, ls))}${outside ? ' — not in the ring yet' : ''}</option>`;
  }).join('');
  // With no source set, NOTHING carries `selected` and a <select> silently
  // falls back to displaying its FIRST option — so this chip asserted an org
  // was the source of truth while none was (user 2026-07-30: "source of truth
  // is not pre select but it is select in the top bar", with the Sync Ring
  // correctly saying "No source of truth yet" right below it). A placeholder
  // makes the unset state say so instead of impersonating whichever org
  // happens to sort first.
  const placeholder = srcUrl ? '' :
    `<option value="" selected disabled>— none set —</option>`;
  el.innerHTML = `
    <span class="ds-pair-lbl" title="Source of truth — new deployments, compares and picklist loads all start from this org. Configure the full ring with the gear.">Source</span>
    <select id="dsSotSel" class="ds-pair-sel${srcUrl ? '' : ' ds-pair-sel-unset'}" aria-label="Source of truth — the org data flows FROM" title="${srcUrl ? 'The golden org data flows FROM' : 'No source of truth is set yet — pick one here'}">${placeholder}${opts}</select>
    <button id="dsSotRingBtn" class="ds-pair-swap" aria-label="Configure the Sync Ring" title="Configure the Sync Ring (which orgs stay in sync)">${dsIcon('gear')}</button>`;
  eid('dsSotSel')?.addEventListener('change', async e => {
    // THE control — full crown contract (history, membership, followers,
    // re-baseline) via the one shared setter.
    await dsSetSourceOfTruth(e.target.value, 'the source of truth changed');
  });
  eid('dsSotRingBtn')?.addEventListener('click', () => navigateToView('ring'));
}

// Resolve an org URL (the value of every org <select>) to a live session
// { orgUrl, sid } — or null when that org isn't open in any Chrome tab.
// Used by Deploy Readiness + Schema View before each check/load.
async function getOrgSession(orgUrl) {
  if (!orgUrl) return null;
  // Refresh open-tab sessions so we hand back the freshest SID available.
  const freshRes = await sendBg({ type: 'GET_ALL_SF_SESSIONS' });
  if (Array.isArray(freshRes?.sessions)) _allSessionsOk = true;
  if (freshRes?.sessions?.length) _allSessions = freshRes.sessions;
  const sess = _resolveSession(orgUrl, _buildAllSessions());
  return (sess && sess.sid) ? sess : null;
}

// Called from org card button — "Transfer" on an org means "copy data INTO
// this org" (user-confirmed intent): seed it as the run-time TARGET override
// so it survives renderTransfer's profile-org resolution. The user can still
// switch or swap orgs on the Run Transfer page.
window.startTransferFrom = function(targetOrg) {
  if (typeof sftkDeployViewOn === 'function' && sftkDeployViewOn()) {
    _currentView = 'profiles'; renderProfiles();
    return showToast(`Pick a deployment and press 🚀 Deploy — ${orgLabel(targetOrg)} can be chosen as its target there.`, 'info', 7000);
  }
  _transferOrgOverride = { src: null, tgt: targetOrg };
  // Transfer is now reachable as a sub-page of Data Deployment, not as
  // its own sidebar item. Highlight Data Deployment so the nav stays
  // consistent with where the user is.
  document.querySelectorAll('.ds-nav-btn').forEach(b => { b.classList.remove('active'); b.removeAttribute('aria-current'); });
  const profBtn = document.querySelector('[data-view="profiles"]');
  if (profBtn) { profBtn.classList.add('active'); profBtn.setAttribute('aria-current', 'page'); }
  _currentView = 'profiles';
  renderTransfer();
};

