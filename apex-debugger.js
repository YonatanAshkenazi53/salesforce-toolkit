// ============================================================
// Automation Debugger
// Real-time monitor for Salesforce automations:
//   • Flows, Apex Triggers, Process Builder, Workflow Rules
//   • Recursion / loop detection across one transaction
//   • Trace flag management (create / extend / stop)
//   • ApexLog list with auto-poll, bulk delete, raw download
//
// Uses Tooling API: TraceFlag, DebugLevel, ApexLog
// ============================================================
const ApexDebugger = (() => {
  'use strict';

  // ── Constants ─────────────────────────────────────────────
  const TAPI         = `services/data/v62.0/tooling`;
  const POLL_MS      = 4000;    // poll interval while trace is active
  const TRACE_HOURS  = 1;       // default trace expiry (hours)
  const MAX_LOGS     = 200;     // max ApexLog records to fetch

  // ── Debug log categories ──────────────────────────────────
  // Each Salesforce debug-log category supports only a specific subset of
  // levels — used by the custom debug-level builder to constrain choices.
  const LOG_LEVELS_ALL = ['NONE','ERROR','WARN','INFO','DEBUG','FINE','FINER','FINEST'];

  // Per-level help text shown inline next to each <select> so users know what
  // they're picking without consulting Salesforce docs. Sourced from the
  // official Salesforce documentation on debug log levels (Apex Developer
  // Guide → Debug Log Levels).
  const LOG_LEVEL_HELP = {
    NONE:   'Off — this category is not captured in the log.',
    ERROR:  'Only error-level events: Apex unhandled exceptions and similar critical issues.',
    WARN:   'Warnings + errors. Catches non-fatal issues that could indicate a problem.',
    INFO:   'Basic events — DML/SOQL counts, methods entered, validation results, flow entry/exit.',
    DEBUG:  'Developer detail — System.debug() output, variable values, decision branches.',
    FINE:   'More detail — query row counts, callout payloads, governor limit accumulators.',
    FINER:  'Even more detail — variable initialisation, internal branch decisions.',
    FINEST: 'Maximum detail — every internal statement. Very large logs; use sparingly.',
  };
  const LOG_CATEGORIES = [
    { key:'ApexCode',      label:'Apex Code',       hint:'Apex execution, methods & variables',
      levels:['NONE','ERROR','WARN','INFO','DEBUG','FINE','FINER','FINEST'] },
    { key:'Database',      label:'Database',        hint:'SOQL, SOSL & DML statements',
      levels:['NONE','INFO','FINEST'] },
    { key:'Workflow',      label:'Workflow & Flow', hint:'Flows, Process Builder & workflow rules',
      levels:['NONE','ERROR','WARN','INFO','FINE','FINER','FINEST'] },
    { key:'Validation',    label:'Validation',      hint:'Validation rules',
      levels:['NONE','INFO','FINEST'] },
    { key:'Callout',       label:'Callouts',        hint:'HTTP & web-service callouts',
      levels:['NONE','ERROR','INFO','FINEST'] },
    { key:'ApexProfiling', label:'Apex Profiling',  hint:'Governor limits & cumulative profiling',
      levels:['NONE','INFO','FINE','FINEST'] },
    { key:'Visualforce',   label:'Visualforce',     hint:'Visualforce page lifecycle & view state',
      levels:['NONE','INFO','FINE','FINEST'] },
    { key:'System',        label:'System',          hint:'System-namespace method calls',
      levels:['NONE','INFO','DEBUG','FINE','FINEST'] },
  ];
  // Snap a desired level down to the nearest valid level for a category.
  function _validLevel(catKey, wanted) {
    const cat = LOG_CATEGORIES.find(c => c.key === catKey);
    if (!cat) return wanted || 'NONE';
    if (cat.levels.includes(wanted)) return wanted;
    // Walk down the global order until we hit one the category supports.
    let idx = LOG_LEVELS_ALL.indexOf(wanted);
    if (idx < 0) return cat.levels[0];
    for (; idx >= 0; idx--) {
      if (cat.levels.includes(LOG_LEVELS_ALL[idx])) return LOG_LEVELS_ALL[idx];
    }
    return 'NONE';
  }

  // ── Debug profile presets ─────────────────────────────────
  // Each preset maps to a named DebugLevel in the org. Levels chosen to be
  // valid for their category (see LOG_CATEGORIES above).
  const PROFILES = {
    flows: {
      label: '🌊 Flows Only',
      desc:  'Flows, Process Builder & workflow rules. Skips Apex — smallest logs.',
      devName: 'SFTK_FlowsOnly',
      levels: { Workflow:'FINEST', ApexCode:'NONE', Database:'NONE',
                System:'NONE', Callout:'NONE', Validation:'INFO',
                Visualforce:'NONE', ApexProfiling:'NONE' }
    },
    apex: {
      label: '⚡ Flows + Apex',
      desc:  'Flows AND Apex triggers/classes. Best all-rounder.',
      devName: 'SFTK_FlowsApex',
      levels: { Workflow:'FINEST', ApexCode:'FINEST', Database:'INFO',
                System:'DEBUG', Callout:'INFO', Validation:'INFO',
                Visualforce:'NONE', ApexProfiling:'NONE' }
    },
    callouts: {
      label: '🔌 Integrations & Callouts',
      desc:  'HTTP callouts & web-service calls — for debugging integrations.',
      devName: 'SFTK_Callouts',
      levels: { Workflow:'INFO', ApexCode:'FINE', Database:'INFO',
                System:'FINE', Callout:'FINEST', Validation:'INFO',
                Visualforce:'NONE', ApexProfiling:'INFO' }
    },
    performance: {
      label: '⏱️ Performance & Limits',
      desc:  'Governor limits, slow SOQL & CPU — for hunting performance issues.',
      devName: 'SFTK_Performance',
      levels: { Workflow:'INFO', ApexCode:'FINE', Database:'FINEST',
                System:'FINE', Callout:'INFO', Validation:'NONE',
                Visualforce:'NONE', ApexProfiling:'FINEST' }
    },
    database: {
      label: '🗄️ Database & SOQL',
      desc:  'Every SOQL, SOSL & DML statement — for query / DML debugging.',
      devName: 'SFTK_Database',
      levels: { Workflow:'INFO', ApexCode:'INFO', Database:'FINEST',
                System:'INFO', Callout:'NONE', Validation:'INFO',
                Visualforce:'NONE', ApexProfiling:'FINE' }
    },
    validation: {
      label: '✅ Validation & Errors',
      desc:  'Validation rules & exceptions — for "why did my save fail?" issues.',
      devName: 'SFTK_Validation',
      levels: { Workflow:'INFO', ApexCode:'ERROR', Database:'INFO',
                System:'NONE', Callout:'NONE', Validation:'FINEST',
                Visualforce:'NONE', ApexProfiling:'NONE' }
    },
    vf: {
      label: '🖥️ Visualforce',
      desc:  'Visualforce page lifecycle, controllers & view state.',
      devName: 'SFTK_Visualforce',
      levels: { Workflow:'INFO', ApexCode:'FINE', Database:'INFO',
                System:'FINE', Callout:'INFO', Validation:'INFO',
                Visualforce:'FINEST', ApexProfiling:'NONE' }
    },
    full: {
      label: '🔍 Full Debug',
      desc:  'Everything at FINEST. Large logs — use for short bursts only.',
      devName: 'SFTK_FullDebug',
      levels: { Workflow:'FINEST', ApexCode:'FINEST', Database:'FINEST',
                System:'FINEST', Callout:'FINEST', Validation:'FINEST',
                Visualforce:'FINEST', ApexProfiling:'FINEST' }
    },
    minimal: {
      label: '🪶 Errors Only',
      desc:  'Just exceptions & errors — tiny logs, lowest overhead.',
      devName: 'SFTK_ErrorsOnly',
      levels: { Workflow:'ERROR', ApexCode:'ERROR', Database:'NONE',
                System:'NONE', Callout:'ERROR', Validation:'NONE',
                Visualforce:'NONE', ApexProfiling:'NONE' }
    },
  };

  // ── Module state ──────────────────────────────────────────
  let _orgUrl = null;
  let _sid    = null;
  let _container = null;

  let _selUser    = null;   // { Id, Name, Username } — user to trace
  let _selProfile = 'apex'; // active profile key

  let _traceFlag   = null;  // { Id, ExpirationDate } or null
  let _traceUser   = null;  // user for whom the active trace was started
  let _debugLevels = {};    // profileKey → DebugLevel Id (cached)
  let _customProfiles = []; // user-created profiles [{key,label,desc,devName,levels,custom:true}]

  // ── Profile registry helpers ──────────────────────────────
  // Built-in PROFILES + user custom profiles, looked up by the same key space.
  function _getProfile(key) {
    if (PROFILES[key]) return PROFILES[key];
    return _customProfiles.find(p => p.key === key) || null;
  }
  async function _loadCustomProfiles() {
    try {
      const d = await chrome.storage.local.get('adbg_custom_profiles');
      _customProfiles = Array.isArray(d.adbg_custom_profiles) ? d.adbg_custom_profiles : [];
    } catch (_) { _customProfiles = []; }
  }
  async function _saveCustomProfiles() {
    try { await chrome.storage.local.set({ adbg_custom_profiles: _customProfiles }); } catch (_) {}
  }

  // Build <option> markup for the profile <select>: built-ins, custom levels,
  // then a "create new" sentinel.
  function _profileSelectHtml() {
    // title= shows the scenario's description as a hover tooltip per option
    // (the only help-text channel a native <select> offers) — the inline
    // description row still updates after selection.
    const opt = (k, label, tip) =>
      `<option value="${k}" ${k === _selProfile ? 'selected' : ''}${tip ? ` title="${_esc(tip)}"` : ''}>${label}</option>`;
    let html = '<optgroup label="Built-in scenarios">';
    html += Object.entries(PROFILES).map(([k, p]) => opt(k, p.label, p.desc)).join('');
    html += '</optgroup>';
    if (_customProfiles.length) {
      html += '<optgroup label="My custom levels">';
      html += _customProfiles.map(p => opt(p.key, '✏️ ' + _esc(p.label), p.desc)).join('');
      html += '</optgroup>';
    }
    html += '<optgroup label="Manage">';
    html += '<option value="__new__" title="Build your own debug-level combination per log category">➕ Create custom level…</option>';
    html += '</optgroup>';
    return html;
  }

  // Re-render the profile <select> in place (after load / create / edit / delete).
  function _refreshProfileSelect() {
    const sel = document.getElementById('adbgProfile');
    if (!sel) return;
    if (!_getProfile(_selProfile)) _selProfile = 'apex'; // selected one was deleted
    sel.innerHTML = _profileSelectHtml();
    sel.value = _selProfile;
    const desc = document.getElementById('adbgProfileDesc');
    const prof = _getProfile(_selProfile);
    if (desc) desc.textContent = prof ? prof.desc : '';
    _syncProfileEditBtn();
  }

  function _syncProfileEditBtn() {
    const btn = document.getElementById('adbgProfileEdit');
    if (!btn) return;
    const prof = _getProfile(_selProfile);
    const isCustom = prof && prof.custom;
    btn.textContent = isCustom ? '✏️' : '➕';
    btn.title = isCustom ? 'Edit this custom debug level'
                         : 'Create a new custom debug level';
  }

  // ── Custom debug-level builder modal ──────────────────────
  function _showLevelBuilder(editKey) {
    const editing = editKey ? _getProfile(editKey) : null;
    // Seed from the profile being edited, or the current selection as a template.
    const tmpl = editing || _getProfile(_selProfile) || PROFILES.apex;
    const cur  = { ...(tmpl.levels || {}) };

    document.getElementById('adbgLevelModal')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'adbgLevelModal';
    overlay.className = 'adbg-modal-overlay';

    const catRows = LOG_CATEGORIES.map(c => {
      const selLvl = _validLevel(c.key, cur[c.key] || 'NONE');
      // Per-option title attribute → native browser tooltip on hover. Some
      // browsers (Chrome, Firefox) honour it for <option>; even where they
      // don't, the live description below picks up the slack.
      const opts = c.levels.map(lv =>
        `<option value="${lv}" ${lv === selLvl ? 'selected' : ''}
          title="${_esc(LOG_LEVEL_HELP[lv] || '')}">${lv}</option>`
      ).join('');
      return `<div class="adbg-lvl-row">
        <div class="adbg-lvl-info">
          <span class="adbg-lvl-name">${c.label}</span>
          <span class="adbg-lvl-hint">${c.hint}</span>
        </div>
        <div class="adbg-lvl-pick">
          <select class="adbg-lvl-sel" data-cat="${c.key}">
            ${opts}
          </select>
          <div class="adbg-lvl-help" data-help-for="${c.key}">${_esc(LOG_LEVEL_HELP[selLvl] || '')}</div>
        </div>
      </div>`;
    }).join('');

    overlay.innerHTML = `
      <div class="adbg-modal">
        <div class="adbg-modal-hdr">
          <span>${editing ? '✏️ Edit Custom Debug Level' : '➕ New Custom Debug Level'}</span>
          <button class="adbg-modal-x" id="adbgLvlClose" title="Close">✕</button>
        </div>
        <div class="adbg-modal-body">
          <label class="adbg-lvl-field">
            <span>Name</span>
            <input type="text" id="adbgLvlName" maxlength="40"
                   placeholder="e.g. My Integration Debug"
                   value="${editing ? _esc(editing.label) : ''}">
          </label>
          <label class="adbg-lvl-field">
            <span>Description <em>(optional)</em></span>
            <input type="text" id="adbgLvlDesc" maxlength="120"
                   placeholder="What is this level for?"
                   value="${editing ? _esc(editing.desc || '') : ''}">
          </label>
          <div class="adbg-lvl-grid-hdr">Category levels</div>
          <div class="adbg-lvl-grid">${catRows}</div>
          <div class="adbg-lvl-tip">
            💡 Each category only allows the levels Salesforce supports for it.
            Higher levels (FINE → FINEST) capture more detail but produce bigger
            logs — keep categories you don't need at <strong>NONE</strong>.
          </div>
          <div id="adbgLvlErr" class="adbg-lvl-err" style="display:none"></div>
        </div>
        <div class="adbg-modal-ftr">
          ${editing
            ? '<button class="btn btn-danger btn-sm" id="adbgLvlDelete">🗑 Delete</button>'
            : '<span></span>'}
          <div class="adbg-modal-ftr-right">
            <button class="btn btn-secondary btn-sm" id="adbgLvlCancel">Cancel</button>
            <button class="btn btn-success btn-sm" id="adbgLvlSave">${editing ? 'Save Changes' : 'Create Level'}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.getElementById('adbgLvlClose').addEventListener('click', close);
    document.getElementById('adbgLvlCancel').addEventListener('click', close);

    // Live help text — when the user changes a level dropdown, swap the help
    // line below it with the description of the newly-picked level. Lets a
    // user evaluate "what would FINEST actually do here?" without leaving the
    // form.
    overlay.querySelectorAll('.adbg-lvl-sel').forEach(sel => {
      sel.addEventListener('change', () => {
        const help = overlay.querySelector(`.adbg-lvl-help[data-help-for="${sel.dataset.cat}"]`);
        if (help) help.textContent = LOG_LEVEL_HELP[sel.value] || '';
      });
    });

    document.getElementById('adbgLvlSave').addEventListener('click', async () => {
      const errEl = document.getElementById('adbgLvlErr');
      const name  = document.getElementById('adbgLvlName').value.trim();
      const desc  = document.getElementById('adbgLvlDesc').value.trim();
      if (!name) {
        errEl.textContent = 'Please enter a name for this debug level.';
        errEl.style.display = '';
        return;
      }
      const levels = {};
      overlay.querySelectorAll('.adbg-lvl-sel').forEach(s => {
        levels[s.dataset.cat] = _validLevel(s.dataset.cat, s.value);
      });
      if (Object.values(levels).every(v => v === 'NONE')) {
        errEl.textContent = 'Set at least one category above NONE.';
        errEl.style.display = '';
        return;
      }

      if (editing) {
        editing.label  = name;
        editing.desc   = desc || 'Custom debug level.';
        editing.levels = levels;
        delete _debugLevels[editing.key]; // force re-apply on next trace
      } else {
        const stamp   = Date.now().toString(36);
        _customProfiles.push({
          key:     'custom_' + stamp,
          devName: 'SFTK_C_' + stamp,
          label:   name,
          desc:    desc || 'Custom debug level.',
          levels,
          custom:  true,
        });
        _selProfile = 'custom_' + stamp;
      }
      await _saveCustomProfiles();
      _refreshProfileSelect();
      close();
    });

    const delBtn = document.getElementById('adbgLvlDelete');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!delBtn.dataset.armed) {
          delBtn.dataset.armed = '1';
          delBtn.textContent   = '⚠ Confirm Delete';
          setTimeout(() => {
            if (delBtn.dataset.armed) {
              delete delBtn.dataset.armed;
              delBtn.textContent = '🗑 Delete';
            }
          }, 3000);
          return;
        }
        _customProfiles = _customProfiles.filter(p => p.key !== editKey);
        delete _debugLevels[editKey];
        if (_selProfile === editKey) _selProfile = 'apex';
        await _saveCustomProfiles();
        _refreshProfileSelect();
        close();
      });
    }
  }

  let _logs        = [];    // current ApexLog record list
  let _selLogId    = null;  // log whose detail is open
  let _checked     = new Set(); // log Ids selected for bulk ops
  let _bodyCache   = {};    // logId → parsed result
  let _newIds      = new Set(); // Ids that arrived since last render
  // D1: peak governor-limit % per already-analysed log → badges its list row.
  const _logPeak   = {};        // logId → peak limit percent (0–100)
  const _logCompare = new Set(); // D7: log Ids picked for side-by-side compare

  // Cross-log search — populated by _searchAcrossLogs. Each value is the
  // first few matching lines so we can show a snippet under the row.
  let _xSearchQuery   = '';
  let _xSearchHits    = new Map();  // logId → [{ ln, text }]
  let _xSearchRunning = false;
  let _xSearchCancel  = false;
  let _xRawCache      = {};         // logId → raw body string (caches HTTP fetch)

  let _pollTimer   = null;
  let _cdTimer     = null;  // countdown timer
  let _lastPoll    = null;  // ISO timestamp of last poll

  // ── Public API ────────────────────────────────────────────
  function init(container, orgUrl, sid) {
    _orgUrl    = orgUrl;
    _sid       = sid;
    _container = container;
    _reset();
    _renderShell();
    _wireEvents();
    // Load user custom profiles, then refresh the profile dropdown
    _loadCustomProfiles().then(() => _refreshProfileSelect());
    _loadLogs();
  }

  function updateSession(orgUrl, sid) {
    _orgUrl = orgUrl;
    _sid    = sid;
  }

  // ── Reset ─────────────────────────────────────────────────
  function _reset() {
    _stopPolling();
    _stopCountdown();
    _selUser   = null;
    _traceFlag = null;
    _traceUser = null;
    _logs      = [];
    _selLogId  = null;
    _checked.clear();
    _bodyCache = {};
    _newIds.clear();
    _lastPoll  = null;
    // QA 2026-07-26: DebugLevel record Ids are ORG-SPECIFIC. Without this,
    // an org switch reused the previous org's cached Id and every Start
    // Trace failed with a cross-reference error until full popup reload.
    _debugLevels = {};
  }

  // ── C5b: cross-links into sibling Toolkit tabs ────────────
  // A log already names the exact user/flow the next investigative step
  // needs (who can run this flow? what re-triggers it? what can this user
  // see?), so analysis rows and the detail header offer one-click jumps.
  // HOME_FEATURES actions (popup.js) both navigate AND kick off the target
  // tab's first data load; bare navigateToTab is the fallback. typeof-guarded
  // so the module stays inert if it ever loads outside the popup shell.
  function _jumpToTab(tabId, prefill) {
    try {
      const feat = (typeof HOME_FEATURES !== 'undefined')
        ? HOME_FEATURES.find(f => f.id === tabId) : null;
      if (feat) feat.action();
      else if (typeof navigateToTab === 'function') navigateToTab(tabId);
      else return;
      if (prefill) _xlinkPrefill(tabId, prefill);
    } catch (e) { /* a broken convenience link must never break the tab */ }
  }

  // Best-effort prefill of the target tab's own search/picker inputs — all
  // existing sibling-module DOM, no cross-module state. Every target render
  // reads its input live, so setting the value even BEFORE the tab's async
  // data arrives still filters its first paint. Silently a no-op if the
  // input isn't there (markup changed / module missing).
  function _xlinkPrefill(tabId, q) {
    const fill = el => {
      if (!el) return;
      el.value = q;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    if (tabId === 'flow-access') {
      fill(document.getElementById('fpFlowSearch'));           // flow-permissions.js
    } else if (tabId === 'flows') {
      fill(document.getElementById('searchInput'));            // popup.js flow list
    } else if (tabId === 'copy-perms') {
      // Source-user picker (user-copy.js). Don't clobber an already-picked
      // source user — when one is chosen the input is hidden behind a chip.
      const inp = document.getElementById('ucSourceInput');
      if (inp && inp.style.display !== 'none') {
        fill(inp);
        inp.focus();   // focus opens the filtered dropdown for one-click pick
      }
    }
    // 'dependencies' has no handoff state (same as Field Cleaner's C5a) —
    // plain navigation only.
  }

  // Small link-styled "↗ open in X" button (same visual as Field Cleaner's
  // C5a links). Clicks are handled by ONE delegated listener wired in
  // _wireEvents(), so links keep working across every innerHTML re-render.
  const _XLINK_CSS =
    'background:none;border:none;padding:0;margin-left:8px;' +
    'color:#0176d3;font:inherit;font-size:11px;font-weight:600;' +
    'cursor:pointer;text-decoration:underline;white-space:nowrap;';
  function _xlink(tabId, label, title, prefill) {
    return `<button type="button" class="adbg-xlink" data-xtab="${_esc(tabId)}"` +
           (prefill ? ` data-xq="${_esc(prefill)}"` : '') +
           ` title="${_esc(title || '')}" style="${_XLINK_CSS}">${_esc(label)}</button>`;
  }

  // ── Shell HTML ────────────────────────────────────────────
  function _renderShell() {
    _container.innerHTML = `
      <div class="adbg-wrap">

        <!-- ── Toolbar ─────────────────────────────────── -->
        <div class="adbg-toolbar">
          <div class="adbg-toolbar-row">

            <!-- User picker -->
            <div class="adbg-cell adbg-user-cell">
              <span class="adbg-lbl">User</span>
              <div class="adbg-user-wrap" id="adbgUserWrap">
                <div class="adbg-user-inp-row">
                  <input id="adbgUserInput" class="adbg-user-input"
                         placeholder="Search active user…" autocomplete="off">
                  <button id="adbgUserClear" class="adbg-clear-x" title="Clear" style="display:none">✕</button>
                </div>
                <div id="adbgUserDrop" class="adbg-user-drop" style="display:none"></div>
              </div>
            </div>

            <!-- Profile picker -->
            <div class="adbg-cell">
              <span class="adbg-lbl">Profile</span>
              <div class="adbg-profile-row">
                <select id="adbgProfile" class="adbg-profile-sel">
                  ${_profileSelectHtml()}
                </select>
                <button id="adbgProfileEdit" class="adbg-profile-edit"
                        title="Create or edit a custom debug level">✏️</button>
              </div>
            </div>

            <!-- Trace controls -->
            <div class="adbg-cell adbg-trace-cell">
              <button id="adbgStartBtn" class="btn btn-success btn-sm" disabled>▶ Start Trace</button>
              <button id="adbgStopBtn"  class="btn btn-danger  btn-sm" style="display:none">⏹ Stop</button>
            </div>

            <!-- Live status -->
            <div class="adbg-cell adbg-status-cell" id="adbgStatusCell"></div>

          </div>
          <div class="adbg-profile-desc" id="adbgProfileDesc">${(_getProfile(_selProfile) || {}).desc || ''}</div>
        </div>

        <!-- ── Log list bar ──────────────────────────── -->
        <div class="adbg-log-bar">
          <label class="adbg-sel-all-lbl" title="Select all">
            <input type="checkbox" id="adbgSelAll">
          </label>
          <span class="adbg-log-count" id="adbgLogCount"></span>
          <span class="adbg-live-dot" id="adbgLiveDot" title="Live — polling for new logs" style="display:none"></span>
          <div style="flex:1"></div>
          <div class="adbg-xsearch-wrap" title="Search across every log body — marks logs that contain the keyword">
            <input type="text" id="adbgXSearch" class="adbg-xsearch-input"
              placeholder="🔍 Search across all logs…" autocomplete="off">
            <button id="adbgXSearchClear" class="adbg-xsearch-clear" title="Clear search" style="display:none">✕</button>
          </div>
          <button id="adbgXSearchBtn" class="btn btn-secondary btn-sm" title="Search every log body for this keyword">🔍 Search</button>
          <button id="adbgRefreshBtn" class="btn btn-secondary btn-sm" title="Refresh log list">🔄</button>
          <button id="adbgCompareBtn" class="btn btn-secondary btn-sm" style="display:none"
            title="Compare the two checked logs side by side — before vs after your fix">⚖ Compare 2</button>
          <button id="adbgDelSelBtn"  class="btn btn-danger btn-sm" disabled>Delete Selected</button>
          <button id="adbgPurgeOldBtn" class="btn btn-danger btn-sm" title="Delete logs older than 24 hours">🧹 &gt;24h</button>
          <button id="adbgDelAllBtn"  class="btn btn-danger btn-sm">🗑 Delete All</button>
        </div>

        <!-- ── Split: list | detail ───────────────── -->
        <div class="adbg-split">
          <div class="adbg-log-list" id="adbgLogList">
            <div class="adbg-list-ph">${sftkCatSm('Loading logs…')}</div>
          </div>
          <div class="adbg-detail" id="adbgDetail">
            <div class="adbg-detail-empty">
              <div class="adbg-detail-icon">🔍</div>
              <div>Select a log to inspect automations</div>
              <div class="adbg-detail-hint">Flows, Apex Triggers, Process Builder, and<br>recursion loops are all detected automatically.</div>
            </div>
          </div>
        </div>

      </div>`;
  }

  // ── Wire events ───────────────────────────────────────────
  function _wireEvents() {
    // ── User search ──
    const inp   = () => document.getElementById('adbgUserInput');
    const drop  = () => document.getElementById('adbgUserDrop');
    const clearX = () => document.getElementById('adbgUserClear');

    let _searchT = null;
    document.getElementById('adbgUserInput').addEventListener('input', () => {
      const q = inp().value.trim();
      clearX().style.display = q ? '' : 'none';
      clearTimeout(_searchT);
      if (q.length < 2) { drop().style.display = 'none'; return; }
      _searchT = setTimeout(() => _searchUsers(q), 280);
    });
    document.getElementById('adbgUserInput').addEventListener('focus', () => {
      const q = inp().value.trim();
      if (q.length >= 2) { drop().style.display = ''; return; }
      // Empty box → suggest straight away instead of demanding 2 characters.
      if (!q) _searchUsers('');
    });
    document.addEventListener('click', e => {
      if (!document.getElementById('adbgUserWrap')?.contains(e.target))
        drop().style.display = 'none';
    });
    document.getElementById('adbgUserClear').addEventListener('click', () => {
      _selUser = null;
      inp().value = '';
      clearX().style.display = 'none';
      drop().style.display   = 'none';
      document.getElementById('adbgStartBtn').disabled = true;
      _loadLogs(); // reload without user filter
    });

    // ── Profile ──
    document.getElementById('adbgProfile').addEventListener('change', e => {
      if (e.target.value === '__new__') {
        // "Create custom level…" sentinel — open the builder, revert select
        e.target.value = _selProfile;
        _showLevelBuilder(null);
        return;
      }
      _selProfile = e.target.value;
      const prof = _getProfile(_selProfile);
      document.getElementById('adbgProfileDesc').textContent = prof ? prof.desc : '';
      _syncProfileEditBtn();
    });

    // ── Custom level builder (✏️ button) ──
    document.getElementById('adbgProfileEdit').addEventListener('click', () => {
      const prof = _getProfile(_selProfile);
      // Edit the current profile if it's custom; otherwise start a new one
      _showLevelBuilder(prof && prof.custom ? _selProfile : null);
    });

    // ── Trace ──
    document.getElementById('adbgStartBtn').addEventListener('click', _startTrace);
    document.getElementById('adbgStopBtn').addEventListener('click',  _stopTrace);

    // ── Log bar ──
    document.getElementById('adbgRefreshBtn').addEventListener('click', _loadLogs);
    document.getElementById('adbgSelAll').addEventListener('change', e => {
      _checked.clear();
      if (e.target.checked) _logs.forEach(l => _checked.add(l.Id));
      _renderLogList();
      _updateDelBtn();
    });
    document.getElementById('adbgDelSelBtn').addEventListener('click', _deleteSelected);
    document.getElementById('adbgDelAllBtn').addEventListener('click', _deleteAll);
    document.getElementById('adbgPurgeOldBtn').addEventListener('click', _purgeOld);   // D8
    document.getElementById('adbgCompareBtn').addEventListener('click', _compareLogs); // D7

    // ── Cross-log search ──
    const xInp = document.getElementById('adbgXSearch');
    const xBtn = document.getElementById('adbgXSearchBtn');
    const xClr = document.getElementById('adbgXSearchClear');
    xInp?.addEventListener('input', () => {
      xClr.style.display = xInp.value ? '' : 'none';
    });
    xInp?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); _searchAcrossLogs(xInp.value.trim()); }
      else if (e.key === 'Escape') { _clearXSearch(); }
    });
    xBtn?.addEventListener('click', () => _searchAcrossLogs(xInp.value.trim()));
    xClr?.addEventListener('click', _clearXSearch);

    // ── C5b: cross-links (↗ Deps / Access / Flows / Permissions) ──
    // One delegated listener on the persistent container so links keep
    // working across every detail/list re-render. dataset-guarded: an
    // org-switch re-init calls _wireEvents() again on the same container.
    if (!_container.dataset.adbgXlinkWired) {
      _container.addEventListener('click', e => {
        const link = e.target.closest?.('.adbg-xlink');
        if (link?.dataset.xtab) {
          e.stopPropagation();   // some links live inside clickable rows
          _jumpToTab(link.dataset.xtab, link.dataset.xq || '');
        }
      });
      _container.dataset.adbgXlinkWired = '1';
    }
  }

  // ── User search dropdown ──────────────────────────────────
  // q = '' → the default suggestion list (recently-active users first), shown
  // the moment the box is clicked (user 2026-07-22: "when i click on the box
  // i want the search box to already suggest users"). Typing filters it.
  async function _searchUsers(q) {
    const d = document.getElementById('adbgUserDrop');
    const isSuggest = !q;
    d.innerHTML = '<div class="adbg-drop-msg">' + sftkCatSm(isSuggest ? 'Loading users…' : 'Searching users…') + '</div>';
    d.style.display = '';
    const res = await _bg({
      type: 'SF_QUERY', tooling: false,
      query: (() => {
        // Backslashes FIRST, then quotes — quote-only escaping is defeated by
        // a term ending in '\' (audit S2).
        const safe = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        if (isSuggest) {
          // No term yet — the most useful default is who has been active
          // lately (that is whose debug logs you are about to collect).
          return `SELECT Id,Name,Username FROM User WHERE IsActive=true ` +
                 `ORDER BY LastLoginDate DESC NULLS LAST LIMIT 10`;
        }
        return `SELECT Id,Name,Username FROM User WHERE IsActive=true AND ` +
               `(Name LIKE '%${safe(q)}%' OR Username LIKE '%${safe(q.toLowerCase())}%') ` +
               `ORDER BY Name LIMIT 10`;
      })()
    });
    if (res.error || !res.records?.length) {
      if (res.error) {
        const fe = sftkFriendlyError(res.error);
        d.innerHTML = `<div class="adbg-drop-msg" title="${_esc(fe.raw)}">⚠ ${_esc(fe.message)}${fe.hint ? `<br><small>${_esc(fe.hint)}</small>` : ''}</div>`;
      } else {
        d.innerHTML = '<div class="adbg-drop-msg">' + (isSuggest ? 'No active users in this org' : 'No active user matches that search') + '</div>';
      }
      return;
    }
    d.innerHTML = res.records.map(u =>
      `<div class="adbg-uopt" data-id="${u.Id}" data-name="${_esc(u.Name)}" data-uname="${_esc(u.Username)}">
         <div class="adbg-uopt-name">${_esc(u.Name)}</div>
         <div class="adbg-uopt-uname">${_esc(u.Username)}</div>
       </div>`
    ).join('');
    d.querySelectorAll('.adbg-uopt').forEach(el => {
      el.addEventListener('click', () => {
        _selUser = { Id: el.dataset.id, Name: el.dataset.name, Username: el.dataset.uname };
        document.getElementById('adbgUserInput').value  = _selUser.Name;
        document.getElementById('adbgUserClear').style.display = '';
        d.style.display = 'none';
        document.getElementById('adbgStartBtn').disabled = false;
        _loadLogs();
      });
    });
  }

  // ── Trace management ──────────────────────────────────────
  async function _ensureDebugLevel() {
    if (_debugLevels[_selProfile]) return _debugLevels[_selProfile];

    const prof = _getProfile(_selProfile);
    if (!prof) throw new Error('Unknown debug profile: ' + _selProfile);
    const devName = prof.devName;
    const lvls    = prof.levels;

    // Category values — snapped to levels Salesforce accepts for each category.
    const catBody = {
      Workflow:      _validLevel('Workflow',      lvls.Workflow)      || 'NONE',
      ApexCode:      _validLevel('ApexCode',      lvls.ApexCode)      || 'NONE',
      Database:      _validLevel('Database',      lvls.Database)      || 'NONE',
      System:        _validLevel('System',        lvls.System)        || 'NONE',
      Callout:       _validLevel('Callout',       lvls.Callout)       || 'NONE',
      Validation:    _validLevel('Validation',    lvls.Validation)    || 'NONE',
      Visualforce:   _validLevel('Visualforce',   lvls.Visualforce)   || 'NONE',
      ApexProfiling: _validLevel('ApexProfiling', lvls.ApexProfiling) || 'NONE',
      Wave: 'NONE', Nba: 'NONE'
    };

    // Check if a DebugLevel with this DeveloperName already exists.
    const qRes = await _bg({
      type: 'SF_QUERY', tooling: true,
      query: `SELECT Id FROM DebugLevel WHERE DeveloperName='${devName}' LIMIT 1`
    });
    if (!qRes.error && qRes.records?.length) {
      const id = qRes.records[0].Id;
      // Custom levels can be edited — re-apply current levels so edits take effect.
      if (prof.custom) {
        await _bg({
          type: 'SF_PATCH',
          path: `${TAPI}/sobjects/DebugLevel/${id}`,
          body: catBody
        });
      }
      _debugLevels[_selProfile] = id;
      return id;
    }

    // Create it.
    const cRes = await _bg({
      type: 'SF_REST_POST',
      path: `${TAPI}/sobjects/DebugLevel`,
      body: {
        MasterLabel:   `SF Toolkit — ${(prof.label || 'Custom').replace(/[^\w\s-]/g, '').trim() || 'Custom'}`,
        DeveloperName: devName,
        ...catBody
      }
    });
    if (cRes.error) throw new Error('Could not create DebugLevel: ' + cRes.error);
    _debugLevels[_selProfile] = cRes.id || cRes.Id;
    return _debugLevels[_selProfile];
  }

  async function _startTrace() {
    if (!_selUser) return;
    const startBtn = document.getElementById('adbgStartBtn');
    const stopBtn  = document.getElementById('adbgStopBtn');
    startBtn.disabled = true;
    startBtn.textContent = 'Starting…';
    // Up to 4 sequential API calls follow — show a busy cat in the status cell
    // instead of leaving only the button text as feedback.
    const statusCell = document.getElementById('adbgStatusCell');
    if (statusCell) statusCell.innerHTML = sftkCatSm('Starting trace…');

    try {
      const debugLevelId = await _ensureDebugLevel();
      const now = new Date();
      const exp = new Date(now.getTime() + TRACE_HOURS * 3600_000);

      // Check for existing TraceFlag on this user
      const existing = await _bg({
        type: 'SF_QUERY', tooling: true,
        query: `SELECT Id,ExpirationDate FROM TraceFlag ` +
               `WHERE TracedEntityId='${_selUser.Id}' AND LogType='USER_DEBUG' LIMIT 1`
      });

      if (!existing.error && existing.records?.length) {
        // Extend existing flag. QA 2026-07-26: the result MUST be checked —
        // an ignored PATCH failure (expired session, bad DebugLevelId) used
        // to fake a live 60-minute countdown while the org captured nothing.
        const pRes = await _bg({
          type: 'SF_PATCH',
          path: `${TAPI}/sobjects/TraceFlag/${existing.records[0].Id}`,
          body: { DebugLevelId: debugLevelId,
                  StartDate: now.toISOString(),
                  ExpirationDate: exp.toISOString() }
        });
        if (pRes?.error) throw new Error(pRes.error);
        _traceFlag = { Id: existing.records[0].Id, ExpirationDate: exp.toISOString() };
      } else {
        // Create new
        const cRes = await _bg({
          type: 'SF_REST_POST',
          path: `${TAPI}/sobjects/TraceFlag`,
          body: {
            TracedEntityId: _selUser.Id,
            LogType:        'USER_DEBUG',
            DebugLevelId:   debugLevelId,
            StartDate:      now.toISOString(),
            ExpirationDate: exp.toISOString()
          }
        });
        if (cRes.error) throw new Error(cRes.error);
        _traceFlag = { Id: cRes.id || cRes.Id, ExpirationDate: exp.toISOString() };
      }

      _traceUser = _selUser;
      startBtn.style.display = 'none';
      stopBtn.style.display  = '';
      _renderStatus();
      _startCountdown();
      _startPolling();

    } catch (err) {
      const fe = sftkFriendlyError(err.message || String(err));
      _renderStatus('Error: ' + fe.message + (fe.hint ? ' — ' + fe.hint : ''), 'error');
      const cell = document.getElementById('adbgStatusCell');
      if (cell) cell.title = fe.raw;   // raw error kept for copy/paste
      startBtn.disabled    = false;
      startBtn.textContent = '▶ Start Trace';
    }
  }

  async function _stopTrace() {
    _stopPolling();
    _stopCountdown();
    if (_traceFlag?.Id) {
      // Visual state while the TraceFlag delete is in flight.
      const stopping = document.getElementById('adbgStopBtn');
      if (stopping) { stopping.disabled = true; stopping.textContent = 'Stopping…'; }
      // QA 2026-07-26: _bg never rejects — errors come back as {error}. A
      // swallowed delete failure left the TraceFlag ACTIVE in the org (still
      // generating FINEST logs) while the UI claimed the trace was stopped,
      // and nulling _traceFlag threw away the only handle for a retry.
      const dRes = await _bg({ type: 'SF_TOOLING_DELETE', sobject: 'TraceFlag', id: _traceFlag.Id });
      if (stopping) { stopping.disabled = false; stopping.textContent = '⏹ Stop'; }
      if (dRes?.error) {
        const fe = sftkFriendlyError(dRes.error);
        _renderStatus(`Couldn't stop the trace: ${fe.message} — the flag is STILL ACTIVE in the org${_traceFlag?.ExpirationDate ? ` until ${new Date(_traceFlag.ExpirationDate).toLocaleTimeString()}` : ''}. Fix the session (open the org tab) and click ⏹ Stop again.`, 'error');
        _startCountdown();   // keep showing the truth: it IS still running
        _startPolling();
        return;              // keep _traceFlag so Stop can retry
      }
    }
    _traceFlag = null;
    _traceUser = null;

    const startBtn = document.getElementById('adbgStartBtn');
    const stopBtn  = document.getElementById('adbgStopBtn');
    if (startBtn) { startBtn.style.display = ''; startBtn.disabled = !_selUser; startBtn.textContent = '▶ Start Trace'; }
    if (stopBtn)  stopBtn.style.display = 'none';
    const dot = document.getElementById('adbgLiveDot');
    if (dot) dot.style.display = 'none';
    _renderStatus();
  }

  function _renderStatus(msg, type) {
    const cell = document.getElementById('adbgStatusCell');
    if (!cell) return;
    if (!msg && _traceFlag) {
      const rem  = Math.max(0, new Date(_traceFlag.ExpirationDate) - Date.now());
      const mins = Math.floor(rem / 60000);
      const secs = Math.floor((rem % 60000) / 1000);
      msg  = `⏱ ${_traceUser?.Name || '?'} — ${mins}m ${String(secs).padStart(2,'0')}s left`;
      type = 'active';
    }
    cell.innerHTML = msg
      ? `<span class="adbg-status-pill adbg-spill-${type || 'info'}">${_esc(msg)}</span>`
      : '';
  }

  function _startCountdown() {
    _stopCountdown();
    _cdTimer = setInterval(() => {
      if (!_traceFlag) { _stopCountdown(); return; }
      _renderStatus();
      if (new Date(_traceFlag.ExpirationDate) <= Date.now()) _stopTrace();
    }, 1000);
  }
  function _stopCountdown() { clearInterval(_cdTimer); _cdTimer = null; }

  // ── Polling ───────────────────────────────────────────────
  function _startPolling() {
    _stopPolling();
    const dot = document.getElementById('adbgLiveDot');
    if (dot) dot.style.display = '';
    _pollTimer = setInterval(_pollForNew, POLL_MS);
  }
  function _stopPolling() {
    clearInterval(_pollTimer); _pollTimer = null;
    const dot = document.getElementById('adbgLiveDot');
    if (dot) dot.style.display = 'none';
  }

  async function _pollForNew() {
    if (!_lastPoll) { _loadLogs(); return; }
    // QA 2026-07-26: ApexLog rows only APPEAR at transaction END but carry
    // the transaction START time — so `StartTime > lastPoll` permanently
    // missed any transaction longer than one poll interval (exactly the
    // slow batches/flows being debugged). Query with a 15-minute LOOKBACK;
    // the Id-dedup below makes the overlap free.
    const ts = new Date(Date.parse(_lastPoll) - 15 * 60 * 1000)
      .toISOString().replace(/\.\d+Z$/, 'Z');
    // Show ALL new logs in the org (no user filter on the list view; the
    // user picker is for setting trace flags, not for filtering the list).
    // StartTime is ApexLog's canonical creation timestamp — the Tooling
    // endpoint rejects CreatedDate filters on ApexLog with HTTP 400.
    const where = `WHERE StartTime > ${ts}`;
    const res = await _bg({
      type: 'SF_QUERY', tooling: true,
      query: _logQuery(where) + ' LIMIT 50'
    });
    // SOQL DateTime literals reject the millisecond suffix (.NNNZ) — Salesforce
    // returns HTTP 400 if we pass it. Drop the fraction before storing.
    _lastPoll = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    if (res.error || !res.records?.length) return;
    const existing = new Set(_logs.map(l => l.Id));
    res.records.forEach(l => {
      if (!existing.has(l.Id)) {
        _logs.unshift(l);
        _newIds.add(l.Id);
      }
    });
    _renderLogList();
    const cnt = document.getElementById('adbgLogCount');
    if (cnt) cnt.textContent = `${_logs.length} log${_logs.length !== 1 ? 's' : ''}`;
  }

  // ── Load logs ─────────────────────────────────────────────
  async function _loadLogs() {
    const listEl = document.getElementById('adbgLogList');
    if (!listEl) return;
    listEl.innerHTML = '<div class="adbg-list-ph">' + sftkCatSm('Loading…') + '</div>';

    // List view shows ALL logs in the org. The user picker drives trace-flag
    // management (Start Trace), not log filtering.
    const where = '';
    const res = await _bg({
      type: 'SF_QUERY', tooling: true,
      query: _logQuery(where) + ` LIMIT ${MAX_LOGS}`
    });
    // Strip the .NNN fraction — SOQL DateTime literals reject milliseconds.
    _lastPoll = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

    if (res.error) {
      const fe = sftkFriendlyError(res.error);
      listEl.innerHTML = `<div class="adbg-list-ph adbg-list-err" title="${_esc(fe.raw)}">⚠ ${_esc(fe.message)}${fe.hint ? `<br><small>${_esc(fe.hint)}</small>` : ''}</div>`;
      const cnt = document.getElementById('adbgLogCount');
      if (cnt) cnt.textContent = 'Error';
      return;
    }
    _logs = res.records || [];
    // QA 2026-07-26: checked ids can outlive their rows (deleted elsewhere,
    // fallen past the cap) — prune so the Delete button can't claim
    // selections that no longer exist in the list.
    {
      const live = new Set(_logs.map(l => l.Id));
      for (const id of [..._checked]) if (!live.has(id)) _checked.delete(id);
      _updateDelBtn();
    }
    _renderLogList();
    // D8: org log-storage meter. Tooling SOQL has no aggregates, so sum the
    // fetched rows — exact when under the cap, a labelled floor when at it.
    const bytes = _logs.reduce((s, l) => s + (l.LogLength || 0), 0);
    const mb    = (bytes / 1048576).toFixed(bytes > 10485760 ? 0 : 1);
    const capped = _logs.length >= MAX_LOGS;
    const cnt = document.getElementById('adbgLogCount');
    if (cnt) cnt.textContent =
      `${_logs.length}${capped ? '+' : ''} log${_logs.length !== 1 ? 's' : ''} · ${capped ? '≥' : ''}${mb} MB`;
  }

  function _logQuery(where) {
    return `SELECT Id,Application,DurationMilliseconds,Location,LogLength,` +
           `LogUser.Name,LogUser.Username,Operation,Request,StartTime,Status ` +
           `FROM ApexLog ${where} ORDER BY StartTime DESC`;
  }

  // ── Render log list ───────────────────────────────────────
  function _renderLogList() {
    const listEl = document.getElementById('adbgLogList');
    if (!listEl) return;
    if (!_logs.length) {
      listEl.innerHTML = `<div class="adbg-list-ph">
        No logs${_traceUser ? ' yet — trigger an action in Salesforce.' : '.'}<br>
        <small>All logs in the org are shown${_selUser ? ` — the user picker only controls whose trace flag ▶ Start Trace creates (currently ${_esc(_selUser.Name)})` : '. Select a user and start a trace to capture new logs'}.</small>
      </div>`;
      return;
    }
    // If a cross-log search is active, filter to matching logs first so
    // non-matches drop out of the list entirely (clearer than "everything
    // is grey except matches"). Logs that haven't been scanned yet still
    // appear during the in-progress phase.
    const xActive  = !!_xSearchQuery;
    const visible = xActive
      ? _logs.filter(l => _xSearchHits.has(l.Id) || (_xSearchRunning && !(l.Id in _xRawCache) && !_bodyCache[l.Id]))
      : _logs;

    listEl.innerHTML = visible.map(log => {
      const isNew  = _newIds.has(log.Id);
      const isSel  = log.Id === _selLogId;
      const isCk   = _checked.has(log.Id);
      const dt     = new Date(log.StartTime);
      const time   = dt.toTimeString().substring(0, 8);
      const kb     = log.LogLength ? (log.LogLength / 1024).toFixed(1) + ' KB' : '—';
      const durMs  = log.DurationMilliseconds;
      const dur    = durMs != null ? (durMs >= 1000 ? (durMs/1000).toFixed(1)+'s' : durMs+'ms') : '';
      const op     = (log.Operation || log.Request || log.Application || '').substring(0, 48);
      const user   = log.LogUser?.Name || '';
      const cached = _bodyCache[log.Id];
      const hasLoop = cached?.recursions?.length > 0;
      const hasFault = Object.values(cached?.flows || {}).some(f => f.faulted);
      const xHits = _xSearchHits.get(log.Id);
      // D1: badge logs already analysed this session whose transaction ran a
      // governor limit high. Only appears once a log has been opened (parsing
      // every log on list-load would mean a fetch per row).
      const peak = _logPeak[log.Id] || 0;

      // First matching line snippet — shown under the op when cross-log
      // search is active. We highlight the matched keyword inside the line.
      let xSnippet = '';
      if (xHits?.length) {
        const re = new RegExp(_xSearchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
        const h = xHits[0];
        const safe = _esc(h.text).replace(re, m => `<mark class="adbg-row-hit-mark">${_esc(m)}</mark>`);
        xSnippet = `<div class="adbg-row-hit" title="${_esc(h.text)}">
          <span class="adbg-row-hit-ln">L${h.ln}</span>
          <span class="adbg-row-hit-txt">${safe}</span>
          ${xHits.length > 1 ? `<span class="adbg-row-hit-more">+${xHits.length - 1}</span>` : ''}
        </div>`;
      }

      return `<div class="adbg-log-row${isSel ? ' adbg-row-sel' : ''}${isNew ? ' adbg-row-new' : ''}${xHits ? ' adbg-row-xhit' : ''}" data-id="${log.Id}">
        <label class="adbg-row-ck">
          <input type="checkbox" class="adbg-cb" data-id="${log.Id}" ${isCk ? 'checked' : ''}>
        </label>
        <div class="adbg-row-body">
          <div class="adbg-row-top">
            <span class="adbg-row-time">${time}</span>
            ${isNew     ? '<span class="adbg-badge-new">NEW</span>'  : ''}
            ${xHits     ? `<span class="adbg-badge-xhit" title="${xHits.length} matching line${xHits.length === 1 ? '' : 's'}">🔍 ${xHits.length}</span>` : ''}
            ${hasLoop   ? '<span class="adbg-badge-loop">🔄 LOOP</span>' : ''}
            ${hasFault  ? '<span class="adbg-badge-fault">⚠ FAULT</span>' : ''}
            ${peak >= 80 ? `<span class="adbg-badge-limit${peak >= 95 ? ' adbg-badge-limit-crit' : ''}" title="Governor limit peaked at ${peak}% in this transaction">${peak >= 95 ? '🛑' : '⚠️'} ${peak}%</span>` : ''}
            <span class="adbg-row-size">${kb}</span>
            ${dur ? `<span class="adbg-row-dur">${dur}</span>` : ''}
          </div>
          <div class="adbg-row-op" title="${_esc(op)}">${_esc(op) || '<i>Unknown</i>'}</div>
          ${user ? `<div class="adbg-row-user">${_esc(user)}</div>` : ''}
          ${log.Status && log.Status !== 'Success'
              ? `<div class="adbg-row-fail">${_esc(log.Status)}</div>` : ''}
          ${xSnippet}
        </div>
        <button class="adbg-row-del" data-id="${log.Id}" title="Delete this log">🗑</button>
      </div>`;
    }).join('');

    // Cross-log-search empty state — show only when search finished with 0 hits
    if (xActive && !_xSearchRunning && !_xSearchHits.size) {
      listEl.innerHTML = `<div class="adbg-list-ph">
        No logs match <strong>"${_esc(_xSearchQuery)}"</strong>.<br>
        <small>Clear the search or try a different keyword.</small>
      </div>`;
    }

    // Row → open detail
    listEl.querySelectorAll('.adbg-log-row').forEach(row => {
      row.addEventListener('click', e => {
        if (e.target.closest('.adbg-row-ck') || e.target.closest('.adbg-row-del')) return;
        _newIds.delete(row.dataset.id);
        _openLog(row.dataset.id);
      });
    });
    // Checkboxes
    listEl.querySelectorAll('.adbg-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        cb.checked ? _checked.add(cb.dataset.id) : _checked.delete(cb.dataset.id);
        _updateDelBtn();
      });
    });
    // Per-row delete
    listEl.querySelectorAll('.adbg-row-del').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); _deleteLog(btn.dataset.id); });
    });
  }

  function _updateDelBtn() {
    const btn = document.getElementById('adbgDelSelBtn');
    if (!btn) return;
    btn.disabled    = _checked.size === 0;
    btn.textContent = _checked.size > 0 ? `Delete (${_checked.size})` : 'Delete Selected';
    _syncCompareBtn();   // D7: ⚖ Compare appears when exactly two logs are checked
  }

  // ── Cross-log search ──────────────────────────────────────
  // Fetches every log body (with concurrency) and marks rows whose body
  // contains the keyword. Hits are kept in _xSearchHits → the list
  // renderer adds a "🔍 N" badge and a snippet of the first matching line.
  // Subsequent searches reuse _xRawCache so we don't re-download bodies.
  async function _searchAcrossLogs(query) {
    query = (query || '').trim();
    if (!query) { _clearXSearch(); return; }
    if (_xSearchRunning) { _xSearchCancel = true; return; }
    if (!_logs.length)   { return; }

    _xSearchQuery   = query;
    _xSearchHits    = new Map();
    _xSearchCancel  = false;
    _xSearchRunning = true;

    const btn = document.getElementById('adbgXSearchBtn');
    const cnt = document.getElementById('adbgLogCount');
    if (btn) { btn.textContent = '✕ Cancel'; btn.classList.add('adbg-xsearch-busy'); }

    _renderLogList(); // clear previous marks immediately

    const total = _logs.length;
    const ql    = query.toLowerCase();
    let done = 0, idx = 0;
    const CONC = 4;

    const updateProgress = () => {
      if (cnt) cnt.textContent = `Searching ${done}/${total} — ${_xSearchHits.size} match${_xSearchHits.size === 1 ? '' : 'es'}`;
    };
    updateProgress();

    async function worker() {
      while (!_xSearchCancel && idx < total) {
        const my = idx++;
        const log = _logs[my];
        if (!log) break;
        let raw = _xRawCache[log.Id] ?? _bodyCache[log.Id]?.raw;
        if (raw == null) {
          const res = await _bg({
            type: 'SF_REST_GET_TEXT',
            path: `${TAPI}/sobjects/ApexLog/${log.Id}/Body`
          });
          if (!res.error && typeof res.text === 'string') {
            raw = res.text;
          }
        }
        // Always record completion in _xRawCache so the visibility filter
        // can tell "scanned (and didn't match)" apart from "not scanned yet".
        // An empty string is a fine sentinel for "no body / fetch failed".
        if (!(log.Id in _xRawCache)) _xRawCache[log.Id] = raw || '';
        if (raw && !_xSearchCancel) {
          const lines = raw.split('\n');
          const hits = [];
          for (let i = 0; i < lines.length && hits.length < 5; i++) {
            if (lines[i].toLowerCase().includes(ql)) {
              hits.push({ ln: i + 1, text: lines[i].length > 240 ? lines[i].slice(0, 240) + '…' : lines[i] });
            }
          }
          if (hits.length) _xSearchHits.set(log.Id, hits);
        }
        done++;
        // Re-render every few completions so the user sees marks appear live
        if (done % 3 === 0 || done === total) {
          updateProgress();
          _renderLogList();
        }
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));

    _xSearchRunning = false;
    if (btn) { btn.textContent = '🔍 Search'; btn.classList.remove('adbg-xsearch-busy'); }
    // If the user cleared the search mid-run, _clearXSearch already restored
    // the count message — don't overwrite it.
    if (_xSearchQuery !== query) return;
    _renderLogList();
    if (cnt) {
      if (_xSearchCancel) {
        cnt.textContent = `Cancelled — ${_xSearchHits.size} match${_xSearchHits.size === 1 ? '' : 'es'} (${done}/${total} scanned)`;
      } else {
        cnt.textContent = `${_xSearchHits.size} of ${total} log${total === 1 ? '' : 's'} match "${query}"`;
      }
    }
  }

  function _clearXSearch() {
    _xSearchQuery = '';
    _xSearchHits  = new Map();
    _xSearchCancel = _xSearchRunning;  // signal in-flight workers to stop
    const inp = document.getElementById('adbgXSearch');
    const clr = document.getElementById('adbgXSearchClear');
    if (inp) inp.value = '';
    if (clr) clr.style.display = 'none';
    _renderLogList();
    _updateCount();
  }

  // ── Open log → parse + render detail ─────────────────────
  async function _openLog(id) {
    _selLogId = id;
    _renderLogList(); // refresh active highlight

    const detail = document.getElementById('adbgDetail');
    if (!detail) return;

    if (_bodyCache[id]) { _renderDetail(_bodyCache[id]); return; }

    detail.innerHTML = `<div class="adbg-detail-loading">${sftkCat('Parsing log…')}</div>`;

    const res = await _bg({
      type: 'SF_REST_GET_TEXT',
      path: `${TAPI}/sobjects/ApexLog/${id}/Body`
    });
    if (res.error) {
      const fe = sftkFriendlyError(res.error);
      detail.innerHTML = `<div class="adbg-detail-err" title="${_esc(fe.raw)}">Failed to load log: ${_esc(fe.message)}<br><small>${_esc(fe.hint || 'The log may have been deleted — refresh the list (🔄).')}</small></div>`;
      return;
    }

    const parsed = _parseLog(res.text || '');
    parsed.id   = id;
    parsed.raw  = res.text || '';   // keep the full text for the inline viewer
    parsed.meta = _logs.find(l => l.Id === id) || {};
    _bodyCache[id] = parsed;

    // D1: record this log's peak governor-limit % so its list row gets a badge.
    _logPeak[id] = Math.max(0, ...Object.values(parsed.limits || {})
      .map(l => l.max > 0 ? Math.round(l.used / l.max * 100) : 0));

    // Re-render list to show LOOP / FAULT / limit badges
    if (parsed.recursions.length || Object.values(parsed.flows).some(f => f.faulted) || _logPeak[id] >= 80) {
      _renderLogList();
    }
    _renderDetail(parsed);
  }

  // ── Inline log viewer ────────────────────────────────────
  // Classify a raw log line by its event type → CSS colour class.
  function _logLineClass(line) {
    const i = line.indexOf('|');
    if (i === -1) return 'adbg-ll-dim';
    const rest = line.slice(i + 1);
    const j    = rest.indexOf('|');
    const ev   = j === -1 ? rest : rest.slice(0, j);
    if (/EXCEPTION|FATAL_ERROR|_FAULT|_ERROR\b/.test(ev))                       return 'adbg-ll-err';
    if (/^FLOW_|^PROCESS_|^WF_/.test(ev))                                       return 'adbg-ll-flow';
    if (/^SOQL_|^SOSL_|^DML_/.test(ev))                                         return 'adbg-ll-data';
    if (/^CODE_UNIT_|^METHOD_|^CONSTRUCTOR_|^SYSTEM_METHOD/.test(ev))            return 'adbg-ll-code';
    if (ev === 'USER_DEBUG')                                                    return 'adbg-ll-debug';
    if (/LIMIT_USAGE|CUMULATIVE_|HEAP_|STATEMENT_EXECUTE|VARIABLE_|SYSTEM_/.test(ev)) return 'adbg-ll-dim';
    return '';
  }

  // ── Chunked log viewer ───────────────────────────────────
  // Multi-MB "Full Debug" logs can be hundreds of thousands of lines — far too
  // many to put in the DOM at once. We keep the full line array in memory and
  // render it in chunks: an initial window, then more as the user scrolls.
  const LOG_CHUNK = 700;          // lines rendered per chunk
  const FILTER_CAP = 4000;        // max matches shown when filtering
  let _logViewState = null;       // { lines:[], shown:0, filter:'' }

  // HTML for a single log line — line-number gutter + colour-coded text.
  // `i` is the 0-based line index; the gutter shows the 1-based number.
  function _oneLogLine(ln, i) {
    const cls = _logLineClass(ln);
    return `<div class="adbg-log-line${cls ? ' ' + cls : ''}" data-ln="${i}">` +
           `<span class="adbg-ln-num">${i + 1}</span>` +
           `<span class="adbg-ln-txt">${_esc(ln) || '&nbsp;'}</span></div>`;
  }

  // Build the HTML for a slice of lines [from, to).
  function _logLinesHtml(lines, from, to) {
    let html = '';
    const end = Math.min(to, lines.length);
    for (let i = from; i < end; i++) html += _oneLogLine(lines[i], i);
    return html;
  }

  function _logMoreBar(shown, total) {
    return `<div class="adbg-log-more" id="adbgLogMore">` +
           `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} lines — scroll to load more` +
           `</div>`;
  }

  // ── Log font-size ─────────────────────────────────────────
  const LOG_FONT_MIN = 9, LOG_FONT_MAX = 26, LOG_FONT_DEFAULT = 12;
  const LOG_FONT_KEY = 'adbg_log_font_px';
  function _getLogFontSize() {
    const v = parseInt(localStorage.getItem(LOG_FONT_KEY), 10);
    return (v >= LOG_FONT_MIN && v <= LOG_FONT_MAX) ? v : LOG_FONT_DEFAULT;
  }
  // Apply the stored (or given) size to the log view. Line height tracks the
  // font so big text stays readable. Returns the size applied.
  function _applyLogFontSize(px) {
    const size = px != null ? px : _getLogFontSize();
    const view = document.getElementById('adbgLogView');
    if (view) {
      view.style.fontSize   = size + 'px';
      view.style.lineHeight = (size + 6) + 'px';
    }
    return size;
  }
  // delta: -1 smaller, +1 larger, 0 reset to default. Persists + applies.
  function _bumpLogFont(delta) {
    const next = delta === 0
      ? LOG_FONT_DEFAULT
      : Math.max(LOG_FONT_MIN, Math.min(LOG_FONT_MAX, _getLogFontSize() + delta));
    localStorage.setItem(LOG_FONT_KEY, String(next));
    _applyLogFontSize(next);
  }

  // Initial render — sets up state and returns the first chunk only.
  function _renderLogLines(raw) {
    if (!raw) { _logViewState = null; return '<div class="adbg-detail-none">Log body is empty.</div>'; }
    const lines = raw.split('\n');
    const shown = Math.min(LOG_CHUNK, lines.length);
    _logViewState = { lines, shown, filter: '', cat: '' };
    let html = _logLinesHtml(lines, 0, shown);
    if (lines.length > shown) html += _logMoreBar(shown, lines.length);
    return html;
  }

  // D4: category predicates over the Apex log's event grammar. A log line is
  // `timestamp|EVENT|…`; we test the EVENT token. 'nonoise' hides the
  // high-volume low-signal events that bury the interesting ones.
  const _LOG_NOISE = /\|(HEAP_ALLOCATE|STATEMENT_EXECUTE|SYSTEM_METHOD_ENTRY|SYSTEM_METHOD_EXIT|SYSTEM_CONSTRUCTOR_ENTRY|SYSTEM_CONSTRUCTOR_EXIT|VARIABLE_SCOPE_BEGIN|VARIABLE_ASSIGNMENT)\|/;
  function _logMatchesCat(line, cat) {
    switch (cat) {
      case 'debug':   return line.includes('|USER_DEBUG|');
      case 'soqldml': return /\|(SOQL_EXECUTE_BEGIN|SOQL_EXECUTE_END|DML_BEGIN|DML_END)\|/.test(line);
      case 'errors':  return /\|(FATAL_ERROR|EXCEPTION_THROWN|FLOW_ELEMENT_FAULT|VALIDATION_FAIL)\|/.test(line);
      case 'nonoise': return !_LOG_NOISE.test(line);
      default:        return true;
    }
  }

  // Append the next chunk — called when the user scrolls near the bottom.
  function _logViewAppendChunk() {
    const st   = _logViewState;
    const view = document.getElementById('adbgLogView');
    // QA 2026-07-26: st.cat (the D4 category chip) is a filtered view too —
    // without it, scrolling/search-stepping appended raw unfiltered lines
    // into a category-filtered log (duplicates + wrong-category rows).
    if (!st || !view || st.filter || st.cat) return;  // filtered view: no chunking
    if (st.shown >= st.lines.length) return;
    const next   = Math.min(st.shown + LOG_CHUNK, st.lines.length);
    const moreEl = document.getElementById('adbgLogMore');
    const html   = _logLinesHtml(st.lines, st.shown, next);
    if (moreEl) moreEl.insertAdjacentHTML('beforebegin', html);
    else        view.insertAdjacentHTML('beforeend', html);
    st.shown = next;
    if (moreEl) {
      if (st.shown >= st.lines.length) moreEl.remove();
      else moreEl.textContent =
        `Showing ${st.shown.toLocaleString()} of ${st.lines.length.toLocaleString()} lines — scroll to load more`;
    }
  }

  // Filter — scans ALL lines (not just rendered ones), renders matches (capped).
  // Combines the text query (st.filter) with the D4 category predicate (st.cat).
  function _logViewFilter(q) {
    const st = _logViewState;
    if (st) st.filter = q;
    _logViewApply();
  }

  // D4: set the active category chip and re-render with both filters applied.
  function _logViewSetCat(cat) {
    const st = _logViewState;
    if (st) st.cat = cat || '';
    _logViewApply();
  }

  function _logViewApply() {
    const st   = _logViewState;
    const view = document.getElementById('adbgLogView');
    if (!st || !view) return;
    view.scrollTop = 0;
    const q   = st.filter || '';
    const cat = st.cat || '';

    // No active filter of either kind → restore the chunked (lazy) view.
    if (!q && !cat) {
      st.shown = Math.min(LOG_CHUNK, st.lines.length);
      let html = _logLinesHtml(st.lines, 0, st.shown);
      if (st.lines.length > st.shown) html += _logMoreBar(st.shown, st.lines.length);
      view.innerHTML = html;
      return;
    }

    const ql = q.toLowerCase();
    let html = '', matches = 0;
    for (let i = 0; i < st.lines.length && matches < FILTER_CAP; i++) {
      const line = st.lines[i];
      if (cat && !_logMatchesCat(line, cat)) continue;
      if (ql && !line.toLowerCase().includes(ql)) continue;
      html += _oneLogLine(line, i);   // keeps original line numbers
      matches++;
    }
    if (!html) {
      view.innerHTML = '<div class="adbg-log-empty-filter">No lines match the current filter.</div>';
      return;
    }
    if (matches >= FILTER_CAP) {
      html += `<div class="adbg-log-more">First ${FILTER_CAP.toLocaleString()} matches shown — narrow your filter.</div>`;
    }
    view.innerHTML = html;
  }

  // Jump the viewer to a specific 1-based line number — rendering more chunks
  // first if the target hasn't been loaded yet, then scrolling + highlighting.
  function _logViewGoto(lineNum) {
    const st   = _logViewState;
    const view = document.getElementById('adbgLogView');
    if (!st || !view) return;
    const idx = Math.max(0, Math.min(st.lines.length - 1, (parseInt(lineNum, 10) || 1) - 1));

    // A goto on a filtered view doesn't make sense — restore the full chunked
    // view first (clear BOTH the text filter and the D4 category chip).
    if (st.filter || st.cat) {
      const fi = document.getElementById('adbgLogFilter');
      if (fi) fi.value = '';
      st.filter = ''; st.cat = '';
      document.querySelectorAll('#adbgLogCats .adbg-log-cat').forEach(b =>
        b.classList.toggle('adbg-log-cat-on', b.dataset.cat === ''));
      _logViewApply();
    }
    // Render chunks until the target line is in the DOM.
    let guard = 0;
    while (st.shown <= idx && st.shown < st.lines.length && guard++ < 10000) {
      _logViewAppendChunk();
    }
    const el = view.querySelector(`.adbg-log-line[data-ln="${idx}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('adbg-log-line-hl');
      setTimeout(() => el.classList.remove('adbg-log-line-hl'), 1800);
    }
  }

  // ── Detail panel ─────────────────────────────────────────
  function _renderDetail(p) {
    const detail = document.getElementById('adbgDetail');
    if (!detail) return;
    const log      = p.meta || {};
    const flows    = Object.entries(p.flows    || {});
    const triggers = Object.entries(p.triggers || {});
    const procs    = Object.entries(p.processes|| {});
    const wfRules  = Object.entries(p.wfRules  || {});
    const hasLoop  = p.recursions.length > 0;
    const hasErr   = p.errors.length  > 0;
    const hasAny   = flows.length || triggers.length || procs.length || wfRules.length;

    const timeStr = log.StartTime ? new Date(log.StartTime).toLocaleTimeString() : '';
    const kb      = log.LogLength  ? (log.LogLength/1024).toFixed(1)+' KB' : '—';
    const dur     = log.DurationMilliseconds != null
      ? (log.DurationMilliseconds >= 1000
          ? (log.DurationMilliseconds/1000).toFixed(1)+'s'
          : log.DurationMilliseconds+'ms') : '';

    // ── Transaction summary — always rendered, even for "empty" logs ──
    const st = p.stats || { soql: 0, dml: 0, codeUnits: 0 };
    const statCells = [
      { v: st.soql,        l: 'SOQL queries'   },
      { v: st.dml,         l: 'DML statements' },
      { v: flows.length,   l: 'Flows'          },
      { v: triggers.length,l: 'Apex triggers'  },
      { v: st.codeUnits,   l: 'Code units'     },
      { v: p.errors.length,l: 'Exceptions', err: p.errors.length > 0 },
    ];
    const statGrid = `<div class="adbg-stat-grid">${statCells.map(c =>
      `<div class="adbg-stat${c.err ? ' adbg-stat-err' : ''}">
         <span class="adbg-stat-val">${c.v}</span>
         <span class="adbg-stat-lbl">${c.l}</span>
       </div>`).join('')}</div>`;

    // Governor-limit usage bars (only the meaningful limits, if captured)
    const LIMIT_KEYS = [
      ['Number of SOQL queries',   'SOQL queries'],
      ['Number of query rows',     'Query rows'],
      ['Number of DML statements', 'DML statements'],
      ['Number of DML rows',       'DML rows'],
      ['Maximum CPU time',         'CPU time'],
      ['Number of callouts',       'Callouts'],
    ];
    const limitRows = LIMIT_KEYS
      .filter(([k]) => p.limits && p.limits[k])
      .map(([k, lbl]) => {
        const lim = p.limits[k];
        const pct = lim.max > 0 ? Math.min(100, Math.round(lim.used / lim.max * 100)) : 0;
        const cls = pct >= 80 ? ' adbg-limit-danger' : (pct >= 50 ? ' adbg-limit-warn' : '');
        return `<div class="adbg-limit-row">
          <span class="adbg-limit-lbl">${lbl}</span>
          <span class="adbg-limit-bar"><span class="adbg-limit-fill${cls}" style="width:${pct}%"></span></span>
          <span class="adbg-limit-val">${lim.used.toLocaleString()} / ${lim.max.toLocaleString()}</span>
        </div>`;
      }).join('');
    const limitsBlock = limitRows ? `<div class="adbg-limits">${limitRows}</div>` : '';

    // ── D1: governor-limit proximity alerts ──────────────────────────────
    // The limit block is already parsed into p.limits (used/max). Surface the
    // dangerous ones loudly instead of leaving them as a passive bar: an admin
    // scanning ANALYSIS should SEE "97 of 100 SOQL — one more kills it".
    const limitAlerts = Object.entries(p.limits || {})
      .map(([name, l]) => ({ name, used: l.used, max: l.max,
        pct: l.max > 0 ? Math.round(l.used / l.max * 100) : 0 }))
      .filter(a => a.pct >= 80)
      .sort((a, b) => b.pct - a.pct);
    const peakPct = limitAlerts.length ? limitAlerts[0].pct : 0;
    if (p.id) _logPeak[p.id] = peakPct;   // D1: badge this log's list row
    const limitAlertBlock = limitAlerts.length ? `
      <div class="adbg-limit-alert${peakPct >= 95 ? ' adbg-limit-alert-crit' : ''}">
        <span class="adbg-limit-alert-icon">${peakPct >= 95 ? '🛑' : '⚠️'}</span>
        <div class="adbg-limit-alert-body">
          <strong>${peakPct >= 95 ? 'Governor limit almost hit' : 'Governor limit running high'}</strong>
          ${limitAlerts.map(a => `<div class="adbg-limit-alert-row">
            <code>${_esc(a.name)}</code> — <b>${a.used.toLocaleString()} of ${a.max.toLocaleString()}</b>
            <span class="adbg-limit-alert-pct">${a.pct}%</span>
          </div>`).join('')}
          <div class="adbg-limit-alert-hint">${peakPct >= 95
            ? 'This transaction is one iteration away from failing — look for a query or DML inside a loop.'
            : 'Headroom is thin; a larger data volume could push this over the limit.'}</div>
        </div>
      </div>` : '';

    // Compact stat chips shown in the collapsed Analysis summary row.
    const chip = (v, l, danger) =>
      `<span class="adbg-chip${danger ? ' adbg-chip-err' : ''}"><b>${v}</b> ${l}</span>`;
    const analysisChips =
      chip(st.soql, 'SOQL') +
      chip(st.dml, 'DML') +
      chip(flows.length, 'Flows') +
      chip(triggers.length, 'Triggers') +
      chip(st.codeUnits, 'Code units') +
      chip(p.errors.length, 'Exceptions', hasErr) +
      (hasLoop ? '<span class="adbg-chip adbg-chip-loop">🔄 Recursion</span>' : '');

    detail.innerHTML = `
      <div class="adbg-detail-inner">

        <!-- Compact header — click the title bar to minimize/expand.
             The bar is the single source of op-name + time/size/duration/
             status so it never duplicates the body. The body holds only the
             things the bar doesn't: user, entry point, and the action row. -->
        <div class="adbg-det-hdr" id="adbgDetHdr">
          <div class="adbg-det-hdr-bar" id="adbgDetHdrToggle"
            title="Click to minimize / expand the header">
            <span class="adbg-det-hdr-caret">▾</span>
            <span class="adbg-det-hdr-bar-title">${_esc(log.Operation || log.Request || log.Application || 'Unknown operation')}</span>
            ${timeStr   ? `<span class="adbg-det-hdr-bar-meta">${timeStr}</span>` : ''}
            ${kb !== '—'? `<span class="adbg-det-hdr-bar-meta">${kb}</span>` : ''}
            ${dur       ? `<span class="adbg-det-hdr-bar-meta">${dur}</span>` : ''}
            ${log.Status && log.Status !== 'Success'
                ? `<span class="adbg-pill-fail">${_esc(log.Status)}</span>` : ''}
          </div>
          <div class="adbg-det-hdr-body">
            ${log.LogUser?.Name
                ? `<div class="adbg-det-user">👤 ${_esc(log.LogUser.Name)}${
                    // C5b: "automation behaves differently for THIS user"
                    // debugging usually ends in a permissions diff — jump to
                    // Copy Permissions with this user prefilled as the source.
                    _xlink('copy-perms', '↗ Permissions',
                      `Inspect or compare ${log.LogUser.Name}'s profile, permission sets & groups in the Copy Permissions tool`,
                      log.LogUser.Name)}</div>` : ''}
            ${p.entryPoint ? `<div class="adbg-det-entry">▶ Entry point: <code>${_esc(p.entryPoint)}</code></div>` : ''}
            <div class="adbg-det-actions">
              <button class="btn btn-primary btn-sm"   id="adbgCopyReportBtn">📋 Copy Report</button>
              <button class="btn btn-secondary btn-sm" id="adbgDlReportBtn">📄 Download Report</button>
              <button class="btn btn-secondary btn-sm" id="adbgDlBtn">⬇ Raw Log</button>
              <button class="btn btn-secondary btn-sm" id="adbgCollapseAllBtn"
                title="Collapse all expandable sections in this view">↕ Collapse all</button>
              <button class="btn btn-secondary btn-sm" id="adbgFullLogBtn"
                title="Hide the trace summary panel — give the log viewer the entire screen">⛶ Fullscreen log</button>
              <button class="btn btn-secondary btn-sm" id="adbgNewTabBtn"
                title="Open this log in a new browser tab with all search/filter/goto controls">⤢ Open in new tab</button>
            </div>
          </div>
        </div>

        <!-- Embedded analysis — collapsible; collapsed by default so the log
             gets the screen. Collapsed state still shows the compact chips. -->
        <details class="adbg-analysis">
          <summary class="adbg-analysis-sum">
            <span class="adbg-analysis-title">📊 Analysis</span>
            <span class="adbg-analysis-chips">${analysisChips}</span>
          </summary>
          <div class="adbg-analysis-body">

        <!-- D1: governor-limit proximity alert (loud, above everything) -->
        ${limitAlertBlock}

        <!-- Transaction summary -->
        <div class="adbg-section">
          ${statGrid}
          ${limitsBlock}
        </div>

        <!-- D3: execution timeline — where the wall time went -->
        ${(p.timeline || []).length ? (() => {
          const top = p.timeline.slice(0, 5);
          const maxMs = top[0].ms || 1;
          const fmt = ms => ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : Math.round(ms) + 'ms';
          const icon = t => t === 'flow' ? '🌊' : t === 'method' ? '⚙' : '⚡';
          return `
          <div class="adbg-section">
            <div class="adbg-sec-hdr">⏱ Where the time went
              <span class="adbg-cnt-badge">top ${top.length}</span>
            </div>
            ${top.map(u => `
              <div class="adbg-time-row" title="${_esc(u.label)} — ${fmt(u.ms)} total across ${u.count} execution(s)">
                <span class="adbg-time-lbl">${icon(u.type)} ${_esc(u.label.length > 58 ? u.label.slice(0, 58) + '…' : u.label)}</span>
                <span class="adbg-time-bar"><span class="adbg-time-fill" style="width:${Math.max(2, Math.round(u.ms / maxMs * 100))}%"></span></span>
                <span class="adbg-time-val">${fmt(u.ms)}${u.count > 1 ? ` <em>×${u.count}</em>` : ''}</span>
              </div>`).join('')}
            ${p.timeline.length > 5 ? `
              <details class="adbg-time-more"><summary>…${p.timeline.length - 5} more timed units</summary>
                ${p.timeline.slice(5).map(u => `
                  <div class="adbg-time-row">
                    <span class="adbg-time-lbl">${icon(u.type)} ${_esc(u.label.length > 58 ? u.label.slice(0, 58) + '…' : u.label)}</span>
                    <span class="adbg-time-val">${fmt(u.ms)}${u.count > 1 ? ` <em>×${u.count}</em>` : ''}</span>
                  </div>`).join('')}
              </details>` : ''}
          </div>`;
        })() : ''}

        <!-- D2: repeated-query (N+1) detector -->
        ${(() => {
          const repeats = Object.entries(p.soqlShapes || {})
            .filter(([, s]) => s.count >= 5)
            .sort((a, b) => b[1].count - a[1].count);
          if (!repeats.length) return '';
          return `
          <div class="adbg-section">
            <div class="adbg-sec-hdr">🔁 Repeated queries
              <span class="adbg-cnt-badge adbg-cnt-err">${repeats.length}</span>
            </div>
            <div class="adbg-nplus-hint">The same query shape ran many times in one transaction — the classic
              query-inside-a-loop pattern that burns the SOQL governor limit. Bulkify: query once before the loop.</div>
            ${repeats.map(([shape, s]) => `
              <div class="adbg-nplus-row adbg-err-jump" data-err-line="${s.firstLine}" title="Jump to the first execution (line ${s.firstLine})">
                <span class="adbg-nplus-count">×${s.count}</span>
                <code class="adbg-nplus-q">${_esc(s.sample.length > 90 ? s.sample.slice(0, 90) + '…' : s.sample)}</code>
                <span class="adbg-nplus-rows">${s.rows} row${s.rows === 1 ? '' : 's'} total${s.count ? ` (~${(s.rows / s.count).toFixed(1)}/query)` : ''}</span>
              </div>`).join('')}
          </div>`;
        })()}

        <!-- Recursion / loop banner -->
        ${hasLoop ? `
          <div class="adbg-loop-banner">
            <span class="adbg-loop-icon">🔄</span>
            <div>
              <strong>Recursion / Loop Detected</strong>
              <div class="adbg-loop-items">
                ${p.recursions.map(r => `
                  <div class="adbg-loop-item">
                    ${r.type === 'flow' ? '🌊' : '⚡'}
                    <strong>${_esc(r.name)}</strong>
                    — ran <strong>${r.count}×</strong>
                    ${r.depth > 0
                        ? `and triggered <em>itself</em> while already running (nesting depth: ${r.depth})`
                        : `in a single transaction — possible cascade loop`}
                    ${r.type === 'flow'
                        // C5b: "flow A updates X which re-triggers flow B" is
                        // exactly the what-references-what question the
                        // Dependencies tab answers.
                        ? _xlink('dependencies', '↗ Deps',
                            'Map which flows call or re-trigger this one in the Dependencies tab')
                        : ''}
                  </div>`).join('')}
              </div>
            </div>
          </div>` : ''}

        <!-- Flows -->
        ${flows.length ? `
          <div class="adbg-section">
            <div class="adbg-sec-hdr">🌊 Flows <span class="adbg-cnt-badge">${flows.length}</span></div>
            ${flows.map(([name, info]) => `
              <div class="adbg-auto-row${info.recursed ? ' adbg-auto-loop' : ''}">
                <span class="adbg-auto-name">${_esc(name)}</span>
                ${info.recordTriggered ? '<span class="adbg-tag-rt">RECORD-TRIGGERED</span>' : ''}
                ${info.parents?.length ? `<span class="adbg-tag-sub" title="Sub-flow called by ${_esc(info.parents.join(', '))}">SUB-FLOW</span>` : ''}
                <span class="adbg-auto-count">${info.count}×</span>
                ${info.faulted   ? '<span class="adbg-tag-fault">⚠ Fault</span>'  : ''}
                ${info.recursed  ? '<span class="adbg-tag-loop">LOOP</span>'       : ''}
                ${
                  // C5b: jump links. Deps for every flow (call-chain map);
                  // Flow Access only for flows that could be screen flows —
                  // that tab manages Screen Flows only, so a RECORD-TRIGGERED
                  // flow would just dead-end into an empty filter; Flows
                  // (version cleaner) for faulted flows, where remediation
                  // (inspect versions / deactivate a bad one) lives.
                  _xlink('dependencies', '↗ Deps',
                    "Map this flow's subflow call chain — and what re-triggers it — in the Dependencies tab")}
                ${!info.recordTriggered
                  ? _xlink('flow-access', '↗ Access',
                      'See who can run this flow in the Flow Access tool (screen flows only) — list prefiltered to this name', name)
                  : ''}
                ${info.faulted
                  ? _xlink('flows', '↗ Flows',
                      'This flow faulted — inspect, back up, or clean its versions in the Flows tool (list prefiltered to this name)', name)
                  : ''}
              </div>
              ${(info.triggeringObjects?.length || info.parents?.length) ? `
                <div class="adbg-auto-sub">
                  ${info.triggeringObjects?.length ? `Triggered by: ${_esc(info.triggeringObjects.join(', '))}` : ''}
                  ${info.parents?.length ? `${info.triggeringObjects?.length ? ' · ' : ''}Called by: ${_esc(info.parents.join(', '))}` : ''}
                </div>` : ''}
              ${(info.path || []).length ? `
                <details class="adbg-flow-path">
                  <summary>🧭 path taken — ${info.path.length} step${info.path.length === 1 ? '' : 's'}${info.path.truncated ? ' (first 80)' : ''}</summary>
                  <div class="adbg-flow-path-crumbs">
                    ${info.path.map(s => `<span class="adbg-fp-step${/decision/i.test(s.t) ? ' adbg-fp-decision' : ''}${/loop/i.test(s.t) ? ' adbg-fp-loop' : ''}" title="${_esc(s.t)}">${_esc(s.n)}${s.c > 1 ? `<b>×${s.c}</b>` : ''}</span>`).join('<span class="adbg-fp-arrow">→</span>')}
                  </div>
                  <div class="adbg-fp-hint">Decisions are highlighted; ×N = loop iterations. Needs the Workflow category at FINER+ (🌊 Flows Only / ⚡ Flows + Apex profiles).</div>
                </details>` : ''}`).join('')}
          </div>` : ''}

        <!-- Apex Triggers -->
        ${triggers.length ? `
          <div class="adbg-section">
            <div class="adbg-sec-hdr">⚡ Apex Triggers <span class="adbg-cnt-badge">${triggers.length}</span></div>
            ${triggers.map(([name, info]) => `
              <div class="adbg-auto-row${info.count > 1 ? ' adbg-auto-loop' : ''}">
                <span class="adbg-auto-name">${_esc(name)}</span>
                ${info.operations?.length ? `<span class="adbg-tag-op">${_esc(info.operations.join(', '))}</span>` : ''}
                <span class="adbg-auto-count">${info.count}×</span>
                ${info.count > 1 ? '<span class="adbg-tag-loop">MULTI</span>' : ''}
              </div>`).join('')}
          </div>` : ''}

        <!-- Process Builder -->
        ${procs.length ? `
          <div class="adbg-section">
            <div class="adbg-sec-hdr">📋 Process Builder <span class="adbg-cnt-badge">${procs.length}</span></div>
            ${procs.map(([name, info]) => `
              <div class="adbg-auto-row">
                <span class="adbg-auto-name">${_esc(name)}</span>
                <span class="adbg-auto-count">${info.count}×</span>
              </div>`).join('')}
          </div>` : ''}

        <!-- Workflow Rules -->
        ${wfRules.length ? `
          <div class="adbg-section">
            <div class="adbg-sec-hdr">⚙️ Workflow Rules <span class="adbg-cnt-badge">${wfRules.length}</span></div>
            ${wfRules.map(([name, info]) => `
              <div class="adbg-auto-row">
                <span class="adbg-auto-name">${_esc(name)}</span>
                <span class="adbg-auto-count">${info.count}×</span>
              </div>`).join('')}
          </div>` : ''}

        <!-- Nothing found -->
        ${!hasAny ? `
          <div class="adbg-section">
            <div class="adbg-detail-none">
              No Flows, Apex Triggers, Process Builder or Workflow Rules ran in this transaction.<br>
              <small>${st.soql || st.dml || st.codeUnits
                ? 'The transaction did run database operations / Apex (see summary above).'
                : 'This looks like a lightweight request (e.g. a page or component load).'}
              For more detail, capture with the <strong>Full Debug</strong> profile.</small>
            </div>
          </div>` : ''}

        <!-- Exceptions — D5: each row jumps the viewer to its log line -->
        ${hasErr ? `
          <div class="adbg-section">
            <div class="adbg-sec-hdr">🚨 Exceptions
              <span class="adbg-cnt-badge adbg-cnt-err">${p.errors.length}</span>
            </div>
            ${p.errors.slice(0, 8).map(e =>
              `<div class="adbg-err-row${e.fatal ? ' adbg-err-row-fatal' : ''} adbg-err-jump"
                    data-err-line="${e.line || ''}"
                    title="${e.line ? 'Jump to line ' + e.line + ' in the log' : ''}">
                ${e.fatal ? '<span class="adbg-err-tag">FATAL</span>' : ''}
                ${_esc(e.msg)}
                ${e.line ? `<span class="adbg-err-goto">line ${e.line} ↵</span>` : ''}
              </div>`
            ).join('')}
            ${p.errors.length > 8
                ? `<div class="adbg-err-more">…and ${p.errors.length - 8} more</div>` : ''}
          </div>` : ''}

          </div><!-- /adbg-analysis-body -->
        </details>

        <!-- Log content — fills the whole remaining right side. Collapsible
             via the title bar so the user can minimize it (and expand the
             analysis) when they want. -->
        <div class="adbg-logsec" id="adbgLogsec">
          <div class="adbg-log-title-bar" id="adbgLogToggle" title="Click to minimize / expand the log">
            <span class="adbg-log-caret">▾</span>
            📜 Log Content
            <span class="adbg-cnt-badge">${(p.stats?.lines || 0).toLocaleString()} lines</span>
            <!-- Font-size controls. NO inline onclick here — MV3 extension
                 pages block inline handlers (CSP), so it silently never ran
                 and every A± click also collapsed the log via bubbling. The
                 addEventListener wiring stops propagation instead. -->
            <span class="adbg-log-fontctl">
              <button class="adbg-log-font-btn" id="adbgLogFontDown" title="Smaller text">A−</button>
              <button class="adbg-log-font-btn" id="adbgLogFontReset" title="Reset text size">A</button>
              <button class="adbg-log-font-btn" id="adbgLogFontUp" title="Larger text">A+</button>
            </span>
          </div>
          <div class="adbg-sec-hdr adbg-log-hdr">
            <input type="number" id="adbgLogGoto" class="adbg-log-goto" placeholder="Go to line #" min="1">

            <!-- Notepad++-style search row: query + options + match nav -->
            <div class="adbg-log-search-row">
              <input type="text" id="adbgLogSearch" class="adbg-log-search"
                placeholder="Find in log (Ctrl+F)… use ⏎ next, ⇧⏎ prev"
                autocomplete="off">
              <label class="adbg-log-search-opt" title="Match case — e.g. searching 'Account' finds Account but NOT ACCOUNT_TRIGGER; off, 'soql' also finds SOQL_EXECUTE_BEGIN">
                <input type="checkbox" id="adbgLogCase"> Aa
              </label>
              <label class="adbg-log-search-opt" title="Regex search — e.g. 'SOQL|DML' finds lines with either word; 'LIMIT.*100' finds LIMIT followed by 100 on the same line; off, text matches literally">
                <input type="checkbox" id="adbgLogRegex"> .*
              </label>
              <label class="adbg-log-search-opt" title="Whole word — e.g. 'Case' finds the Case object but NOT CaseNumber or uppercase(); off, it matches inside words too">
                <input type="checkbox" id="adbgLogWord"> W
              </label>
              <span class="adbg-log-search-count" id="adbgLogSearchCount" title="Match navigation">—</span>
              <button class="adbg-log-search-btn" id="adbgLogSearchPrev" title="Previous match (Shift+Enter)">↑</button>
              <button class="adbg-log-search-btn" id="adbgLogSearchNext" title="Next match (Enter)">↓</button>
            </div>

            <input type="text" id="adbgLogFilter" class="adbg-log-filter" placeholder="Filter to matching lines only…">

            <!-- D4: one-click category filters (composable with the text filter) -->
            <div class="adbg-log-cats" id="adbgLogCats">
              ${[['', 'All'], ['debug', '🗣 Debug'], ['soqldml', '🗄 SOQL/DML'],
                 ['errors', '🚨 Errors'], ['nonoise', '🔇 Hide noise']].map(([c, lbl], i) =>
                `<button class="adbg-log-cat${i === 0 ? ' adbg-log-cat-on' : ''}" data-cat="${c}">${lbl}</button>`).join('')}
            </div>
          </div>
          <div class="adbg-log-view" id="adbgLogView">${_renderLogLines(p.raw || '')}</div>
        </div>

      </div>`;

    document.getElementById('adbgDlBtn')?.addEventListener('click', () => _downloadRaw(p.id));
    document.getElementById('adbgCopyReportBtn')?.addEventListener('click', e => _copyReport(p, e.currentTarget));
    document.getElementById('adbgDlReportBtn')?.addEventListener('click', () => _downloadReport(p));
    document.getElementById('adbgNewTabBtn')?.addEventListener('click', e => _openLogInNewTab(p, e.currentTarget));

    // If a cross-log search is active, pre-fill the in-log search box and run
    // it so the user can immediately step through the matches in this log.
    if (_xSearchQuery) {
      const inp = document.getElementById('adbgLogSearch');
      if (inp) {
        inp.value = _xSearchQuery;
        // Defer to after our event wiring at the bottom of _renderDetail
        // hooks the input → that wiring uses 140ms debounce, so just dispatch.
        setTimeout(() => inp.dispatchEvent(new Event('input', { bubbles: true })), 0);
      }
    }

    // Collapse / Expand all <details> sections in the trace detail panel.
    // Useful when ANALYSIS is open with lots of children and you just want to
    // skim the log content. Toggles between "all open" and "all closed".
    document.getElementById('adbgCollapseAllBtn')?.addEventListener('click', e => {
      const detail = document.getElementById('adbgDetail');
      if (!detail) return;
      const allDetails = [...detail.querySelectorAll('details')];
      if (!allDetails.length) return;
      const anyOpen = allDetails.some(d => d.open);
      // If anything is open → close everything. If nothing is open → expand everything.
      allDetails.forEach(d => { d.open = !anyOpen; });
      e.currentTarget.textContent = anyOpen ? '↕ Expand all' : '↕ Collapse all';
    });

    // Fullscreen log — hide everything in .adbg-detail-inner EXCEPT the
    // log content section, giving the log viewer the entire panel height.
    // Toggles back when clicked again. We move the action toolbar (with this
    // button) above the log section using a CSS body-class so the user can
    // always click "Exit fullscreen".
    document.getElementById('adbgFullLogBtn')?.addEventListener('click', e => {
      const detail = document.getElementById('adbgDetail');
      if (!detail) return;
      const isFull = detail.classList.toggle('adbg-detail-fulllog');
      e.currentTarget.textContent = isFull ? '⛶ Exit fullscreen (Esc)' : '⛶ Fullscreen log';
      e.currentTarget.title = isFull
        ? 'Restore the trace summary panel — or press Esc'
        : 'Hide the trace summary panel — give the log viewer the entire screen';
      // In fullscreen, the log view should never be collapsed, and the
      // search box gets focus so the user can start typing immediately.
      if (isFull) {
        document.getElementById('adbgLogsec')?.classList.remove('adbg-logsec-collapsed');
        setTimeout(() => document.getElementById('adbgLogSearch')?.focus(), 0);
      }
    });

    // Esc exits fullscreen-log mode (comfortable code search: enter
    // fullscreen, search/scroll, hit Esc to return). Registered once per
    // detail render; harmless if fullscreen isn't active.
    if (!window._adbgEscBound) {
      window._adbgEscBound = true;
      document.addEventListener('keydown', ev => {
        if (ev.key !== 'Escape') return;
        const d = document.getElementById('adbgDetail');
        if (d?.classList.contains('adbg-detail-fulllog')) {
          d.classList.remove('adbg-detail-fulllog');
          const btn = document.getElementById('adbgFullLogBtn');
          if (btn) { btn.textContent = '⛶ Fullscreen log'; btn.title = 'Hide the trace summary panel — give the log viewer the entire screen'; }
        }
      });
    }

    // Log section minimize / expand — click the title bar to collapse the
    // search + log view down to just the bar, freeing space for Analysis.
    document.getElementById('adbgLogToggle')?.addEventListener('click', (e) => {
      // Ignore clicks born inside the font controls (incl. their gaps) —
      // adjusting text size must never collapse the log.
      if (e.target.closest('.adbg-log-fontctl')) return;
      const sec = document.getElementById('adbgLogsec');
      if (!sec) return;
      const collapsed = sec.classList.toggle('adbg-logsec-collapsed');
      const caret = sec.querySelector('.adbg-log-caret');
      if (caret) caret.textContent = collapsed ? '▸' : '▾';
    });

    // ── Log font-size controls ──────────────────────────────
    // Lets the user scale the log text (esp. handy in fullscreen). The
    // chosen size persists across logs + sessions via localStorage.
    _applyLogFontSize();   // apply the stored size to the freshly-rendered view
    document.getElementById('adbgLogFontDown') ?.addEventListener('click', (e) => { e.stopPropagation(); _bumpLogFont(-1); });
    document.getElementById('adbgLogFontUp')   ?.addEventListener('click', (e) => { e.stopPropagation(); _bumpLogFont(+1); });
    document.getElementById('adbgLogFontReset')?.addEventListener('click', (e) => { e.stopPropagation(); _bumpLogFont(0); });

    // Detail header minimize / expand — click the title bar to collapse the
    // entire upper section (meta + op + user + entry-point + buttons AND
    // the Analysis section), leaving just the title bar + the log content.
    // The bar still shows op + time + duration + status so you keep the key
    // context at a glance. Re-click to restore everything.
    document.getElementById('adbgDetHdrToggle')?.addEventListener('click', () => {
      const hdr = document.getElementById('adbgDetHdr');
      const inner = hdr?.closest('.adbg-detail-inner');
      if (!hdr) return;
      const collapsed = hdr.classList.toggle('adbg-det-hdr-collapsed');
      // Mirror the state on the inner wrapper so we can also hide the
      // analysis section (which is a sibling of the header, not a child).
      inner?.classList.toggle('adbg-detail-min', collapsed);
      // Close the <details class="adbg-analysis"> if it's currently open
      // (so re-expanding doesn't reveal a half-open state).
      const analysis = inner?.querySelector('.adbg-analysis');
      if (analysis && collapsed) analysis.open = false;
      const caret = hdr.querySelector('.adbg-det-hdr-caret');
      if (caret) caret.textContent = collapsed ? '▸' : '▾';
    });

    // ── Log viewer: chunked scroll-load + filter + goto ──
    const logView   = document.getElementById('adbgLogView');
    const logFilter = document.getElementById('adbgLogFilter');
    const logGoto   = document.getElementById('adbgLogGoto');
    if (logView) {
      // Load the next chunk when the user scrolls near the bottom.
      logView.addEventListener('scroll', () => {
        if (logView.scrollTop + logView.clientHeight >= logView.scrollHeight - 240) {
          _logViewAppendChunk();
        }
      });
    }
    if (logFilter) {
      let _ft = null;
      logFilter.addEventListener('input', () => {
        clearTimeout(_ft);
        _ft = setTimeout(() => _logViewFilter(logFilter.value.trim()), 160);
      });
    }

    // ── D4: category filter chips ───────────────────────────────────
    document.getElementById('adbgLogCats')?.addEventListener('click', e => {
      const btn = e.target.closest('.adbg-log-cat');
      if (!btn) return;
      document.querySelectorAll('#adbgLogCats .adbg-log-cat')
        .forEach(b => b.classList.toggle('adbg-log-cat-on', b === btn));
      _logViewSetCat(btn.dataset.cat);
    });

    // ── D5: exception jump-list — click a row → jump the viewer to its line ──
    document.getElementById('adbgDetail')?.querySelectorAll('.adbg-err-jump').forEach(row => {
      const line = parseInt(row.dataset.errLine, 10);
      if (!line) return;
      row.addEventListener('click', () => {
        document.getElementById('adbgLogsec')?.classList.remove('adbg-logsec-collapsed');
        _logViewGoto(line);
      });
    });

    // ── D5: opening a log with a FATAL error auto-scrolls to the first one ──
    const firstFatal = (_bodyCache[p.id]?.errors || p.errors || []).find(e => e.fatal && e.line);
    if (firstFatal) setTimeout(() => _logViewGoto(firstFatal.line), 300);
    if (logGoto) {
      const go = () => {
        const v = parseInt(logGoto.value, 10);
        if (v >= 1) _logViewGoto(v);
      };
      logGoto.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      logGoto.addEventListener('change', go);
    }

    // ── Notepad++-style search ──────────────────────────────────────
    // Highlights all matches across the whole log (not just rendered chunks),
    // shows "N of M" counter, and lets the user step through matches with
    // ↑/↓ buttons or Enter / Shift+Enter. Ctrl+F focuses the search box.
    const sInp   = document.getElementById('adbgLogSearch');
    const sCase  = document.getElementById('adbgLogCase');
    const sRegex = document.getElementById('adbgLogRegex');
    const sWord  = document.getElementById('adbgLogWord');
    const sCnt   = document.getElementById('adbgLogSearchCount');
    const sPrev  = document.getElementById('adbgLogSearchPrev');
    const sNext  = document.getElementById('adbgLogSearchNext');
    if (sInp) {
      const run = () => {
        clearTimeout(_searchTmr);
        _searchTmr = setTimeout(() => _runLogSearch({
          query:        sInp.value,
          caseSensitive: !!sCase?.checked,
          regex:         !!sRegex?.checked,
          wholeWord:     !!sWord?.checked,
        }), 140);
      };
      sInp.addEventListener('input', run);
      [sCase, sRegex, sWord].forEach(el => el?.addEventListener('change', run));
      sInp.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          _stepLogSearchMatch(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
          sInp.value = '';
          _runLogSearch({ query: '' });
        }
      });
      sPrev?.addEventListener('click', () => _stepLogSearchMatch(-1));
      sNext?.addEventListener('click', () => _stepLogSearchMatch(1));
    }
    // Global Ctrl+F → focus the search input (browser's own find dialog is
    // less useful here because matches in unrendered chunks would be invisible).
    if (!_ctrlFHooked) {
      _ctrlFHooked = true;
      document.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
          const inp = document.getElementById('adbgLogSearch');
          if (inp) { e.preventDefault(); inp.focus(); inp.select(); }
        }
      });
    }
  }

  // ── Search state + implementation ──────────────────────────────────
  let _searchTmr     = null;
  let _ctrlFHooked   = false;
  let _searchState   = null; // { regex, matches:[{ln,start,end}], idx, query }

  function _runLogSearch(opts) {
    const st   = _logViewState;
    const view = document.getElementById('adbgLogView');
    const cntE = document.getElementById('adbgLogSearchCount');
    if (!st || !view) return;
    // Clear any previous highlights
    view.querySelectorAll('.adbg-log-search-hit').forEach(el => {
      const t = document.createTextNode(el.textContent);
      el.parentNode?.replaceChild(t, el);
    });
    view.querySelectorAll('.adbg-log-line-search-cur').forEach(el =>
      el.classList.remove('adbg-log-line-search-cur'));

    if (!opts.query) {
      _searchState = null;
      if (cntE) cntE.textContent = '—';
      return;
    }

    // Build the regex used for matching
    let re;
    try {
      let pat = opts.query;
      if (!opts.regex) {
        pat = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      if (opts.wholeWord) pat = `\\b(?:${pat})\\b`;
      re = new RegExp(pat, opts.caseSensitive ? 'g' : 'gi');
    } catch (err) {
      if (cntE) { cntE.textContent = 'regex err'; cntE.title = err.message; }
      return;
    }

    // Scan ALL lines (not just rendered ones) and collect match positions.
    const cap = 5000; // upper bound to keep things responsive on giant logs
    const matches = [];
    for (let i = 0; i < st.lines.length && matches.length < cap; i++) {
      const line = st.lines[i];
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        matches.push({ ln: i, start: m.index, end: m.index + m[0].length });
        if (m[0].length === 0) re.lastIndex++; // avoid zero-width infinite loop
        if (matches.length >= cap) break;
      }
    }

    _searchState = { matches, idx: 0, query: opts.query, opts };
    if (cntE) cntE.textContent = matches.length ? `1 / ${matches.length}` : '0 matches';

    // Render highlights inside whatever's currently in the DOM, then jump to first match.
    _paintSearchHighlights();
    if (matches.length) _stepLogSearchMatch(0);
  }

  // Paint search hits into the currently-rendered log lines. Matches in
  // not-yet-loaded chunks become visible only when those chunks are scrolled
  // into view — same trade-off as the existing filter.
  function _paintSearchHighlights() {
    const view = document.getElementById('adbgLogView');
    const st   = _searchState;
    if (!view || !st || !st.matches.length) return;
    // Group matches by line for O(matches) work instead of O(lines × matches)
    const byLine = new Map();
    for (const m of st.matches) {
      if (!byLine.has(m.ln)) byLine.set(m.ln, []);
      byLine.get(m.ln).push(m);
    }
    for (const [ln, ms] of byLine) {
      const lineEl = view.querySelector(`.adbg-log-line[data-ln="${ln}"] .adbg-ln-txt`);
      if (!lineEl) continue; // line not rendered yet
      const text = lineEl.textContent;
      // Build a fragment with <span> highlights at each match span
      const frag = document.createDocumentFragment();
      let cursor = 0;
      const sorted = [...ms].sort((a, b) => a.start - b.start);
      for (const m of sorted) {
        if (m.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, m.start)));
        const span = document.createElement('span');
        span.className = 'adbg-log-search-hit';
        span.textContent = text.slice(m.start, m.end);
        frag.appendChild(span);
        cursor = m.end;
      }
      if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
      lineEl.innerHTML = '';
      lineEl.appendChild(frag);
    }
  }

  // Move to match `idx + delta`, wrapping around. Ensures the target line is
  // rendered (forces chunk-loading), scrolls to it, and updates the counter.
  function _stepLogSearchMatch(delta) {
    const view = document.getElementById('adbgLogView');
    const st   = _searchState;
    const cntE = document.getElementById('adbgLogSearchCount');
    if (!view || !st || !st.matches.length) return;
    st.idx = ((st.idx + delta) % st.matches.length + st.matches.length) % st.matches.length;
    const m = st.matches[st.idx];

    // Render chunks until the target line is in the DOM
    const ls = _logViewState;
    let guard = 0;
    while (ls && ls.shown <= m.ln && ls.shown < ls.lines.length && guard++ < 10000) {
      _logViewAppendChunk();
    }
    // Re-paint highlights now that more lines may be present
    _paintSearchHighlights();

    view.querySelectorAll('.adbg-log-line-search-cur').forEach(el =>
      el.classList.remove('adbg-log-line-search-cur'));
    const lineEl = view.querySelector(`.adbg-log-line[data-ln="${m.ln}"]`);
    if (lineEl) {
      lineEl.classList.add('adbg-log-line-search-cur');
      lineEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    if (cntE) cntE.textContent = `${st.idx + 1} / ${st.matches.length}`;
  }

  // ── Human-readable report builder ─────────────────────────
  // Produces a clean Markdown summary of the transaction — safe to paste into
  // a ticket, PR description, commit message, or Slack. Explains what each
  // automation did, surfaces every exception, and spells out recursion.
  function _buildReport(p) {
    const log   = p.meta || {};
    const L     = [];
    const dur   = log.DurationMilliseconds;
    const durS  = dur != null
      ? (dur >= 1000 ? (dur / 1000).toFixed(2) + 's' : dur + 'ms') : '—';
    const time  = log.StartTime ? new Date(log.StartTime).toLocaleString() : 'Unknown time';

    L.push('# Salesforce Automation Debug Report');
    L.push('');
    L.push(`- **Operation:** ${log.Operation || log.Request || log.Application || 'Unknown'}`);
    if (p.entryPoint)       L.push(`- **Entry point:** ${p.entryPoint}`);
    L.push(`- **Time:** ${time}`);
    if (log.LogUser?.Name)  L.push(`- **User:** ${log.LogUser.Name}`);
    L.push(`- **Duration:** ${durS}`);
    if (log.LogLength)      L.push(`- **Log size:** ${(log.LogLength / 1024).toFixed(1)} KB`);
    L.push(`- **Status:** ${log.Status || 'Unknown'}`);
    L.push('');

    const hasLoop = p.recursions.length > 0;
    const hasErr  = p.errors.length > 0;

    // ── Verdict ──
    if (hasLoop || hasErr) {
      L.push('## ⚠️ Issues Found');
      if (hasLoop) L.push(`- Recursion / loop detected in ${p.recursions.length} automation(s).`);
      if (hasErr)  L.push(`- ${p.errors.length} exception(s) thrown during this transaction.`);
    } else {
      L.push('## ✅ No recursion or exceptions detected');
    }
    L.push('');

    // ── Transaction summary ──
    const st = p.stats || {};
    L.push('## 📊 Transaction Summary');
    L.push(`- SOQL queries: ${st.soql || 0}${st.soqlRows ? ` (${st.soqlRows} rows)` : ''}`);
    L.push(`- DML statements: ${st.dml || 0}${st.dmlRows ? ` (${st.dmlRows} rows)` : ''}`);
    L.push(`- Code units: ${st.codeUnits || 0}`);
    if (st.callouts)        L.push(`- Callouts: ${st.callouts}`);
    if (st.validationFails) L.push(`- Validation rule failures: ${st.validationFails}`);
    if (p.limits && Object.keys(p.limits).length) {
      Object.entries(p.limits).forEach(([k, v]) => {
        if (v.used > 0) L.push(`- ${k}: ${v.used} / ${v.max}`);
      });
    }
    L.push('');

    // ── Database operations ──
    if (p.dmlOps.length) {
      const grouped = {};
      p.dmlOps.forEach(d => {
        const k = `${d.op || 'DML'} ${d.type || ''}`.trim();
        grouped[k] = (grouped[k] || 0) + 1;
      });
      L.push('## Database Operations');
      Object.entries(grouped).forEach(([k, n]) => L.push(`- ${k} ×${n}`));
      L.push('');
    }

    // ── Recursion ──
    if (hasLoop) {
      L.push('## 🔄 Recursion / Loop Detection');
      p.recursions.forEach(r => {
        const kind = r.type === 'flow' ? 'Flow' : 'Apex Trigger';
        if (r.depth > 0) {
          L.push(`- **${r.name}** (${kind}) — ran ${r.count}× and re-entered itself while still running (nesting depth ${r.depth}). True recursion: add a recursion guard or a "run once" static flag.`);
        } else {
          L.push(`- **${r.name}** (${kind}) — ran ${r.count}× in one transaction. Likely a cascade: one automation's update re-triggers another. Review entry criteria / conditions.`);
        }
      });
      L.push('');
    }

    // ── Flows ──
    const flows = Object.entries(p.flows);
    if (flows.length) {
      L.push('## 🌊 Flows');
      flows.forEach(([name, info]) => {
        const tags = [];
        if (info.recordTriggered) tags.push('record-triggered');
        if (info.parents?.length) tags.push(`sub-flow of ${info.parents.join(', ')}`);
        if (info.recursed)        tags.push('RECURSED');
        if (info.faulted)         tags.push('FAULTED');
        L.push(`- **${name}** — ran ${info.count}×${tags.length ? ` _(${tags.join('; ')})_` : ''}`);
        if (info.triggeringObjects?.length)
          L.push(`  - Triggered by: ${info.triggeringObjects.join(', ')}`);
        if (info.faulted)
          L.push(`  - ⚠️ A flow element hit a fault path — check the flow's fault connectors.`);
      });
      L.push('');
    }

    // ── Apex Triggers ──
    const triggers = Object.entries(p.triggers);
    if (triggers.length) {
      L.push('## ⚡ Apex Triggers');
      triggers.forEach(([name, info]) => {
        const ops = info.operations?.length ? ` _(${info.operations.join(', ')})_` : '';
        L.push(`- **${name}** — fired ${info.count}×${ops}${info.count > 1 ? ' — fired more than once; verify this is intended bulk behaviour and not a re-entry.' : ''}`);
      });
      L.push('');
    }

    // ── Process Builder ──
    const procs = Object.entries(p.processes);
    if (procs.length) {
      L.push('## 📋 Process Builder');
      procs.forEach(([name, info]) => L.push(`- **${name}** — ran ${info.count}×`));
      L.push('');
    }

    // ── Workflow Rules ──
    const wfRules = Object.entries(p.wfRules);
    if (wfRules.length) {
      L.push('## ⚙️ Workflow Rules');
      wfRules.forEach(([name, info]) => L.push(`- **${name}** — evaluated ${info.count}×`));
      L.push('');
    }

    if (!flows.length && !triggers.length && !procs.length && !wfRules.length) {
      L.push('_No automations detected in this log. Try the "Flows + Apex" or "Full Debug" profile to capture more detail._');
      L.push('');
    }

    // ── Exceptions ──
    if (hasErr) {
      L.push('## 🚨 Exceptions');
      p.errors.forEach((e, i) => L.push(`${i + 1}. ${e.msg}`));
      L.push('');
    }

    L.push('---');
    L.push('_Generated by Salesforce Toolkit — Automation Debugger_');
    return L.join('\n');
  }

  async function _copyReport(p, btn) {
    const report = _buildReport(p);
    try {
      await navigator.clipboard.writeText(report);
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = '✓ Copied';
        btn.disabled = true;
        setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
      }
    } catch (_) {
      // Clipboard API blocked — fall back to a download
      _downloadReport(p);
    }
  }

  function _downloadReport(p) {
    const report = _buildReport(p);
    const blob   = new Blob([report], { type: 'text/markdown' });
    const url    = URL.createObjectURL(blob);
    const id     = (p.id || 'log').slice(0, 8);
    const a      = Object.assign(document.createElement('a'), {
      href: url, download: `automation-report-${id}.md`
    });
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Log parser ────────────────────────────────────────────
  // Parses a raw Salesforce debug log and extracts:
  //   • flows      — {name → {count, maxDepth, faulted, recursed,
  //                           recordTriggered, parents:[], triggeringObjects:[]}}
  //   • triggers   — {name → {count, operations:[]}}
  //   • processes  — {name → {count}} (Process Builder)
  //   • wfRules    — {name → {count}} (Workflow Rules)
  //   • errors     — [{msg}]
  //   • recursions — [{type, name, count, depth}]
  //   • dmlOps     — [{op, type, rows}]  (database operations in this transaction)
  //   • entryPoint — first CODE_UNIT_STARTED label (what kicked off the txn)
  //
  // Format: "HH:MM:SS.N (ns)|EVENT_TYPE|[line]|data..."
  function _parseLog(text) {
    const result = {
      flows:      {},
      triggers:   {},
      processes:  {},
      wfRules:    {},
      errors:     [],
      recursions: [],
      dmlOps:     [],
      entryPoint: null,
      codeUnits:  [],   // [{label, count}] — every CODE_UNIT_STARTED
      limits:     {},   // limitName → {used, max} — governor-limit summary
      soqlShapes: {},   // D2: normalizedQuery → {count, rows, firstLine, sample}
      timeline:   [],   // D3: [{label, type, ms, count}] slowest units (filled at end)
      stats: {          // raw transaction counters (always populated)
        lines: 0, soql: 0, soqlRows: 0, dml: 0, dmlRows: 0,
        callouts: 0, codeUnits: 0, validationFails: 0
      },
    };

    const flowStack = []; // stack of currently-executing flow names
    const dmlStack  = []; // stack of active DML contexts {op, type}
    let   inLimits  = false; // inside a LIMIT_USAGE_FOR_NS summary block
    // D2: the query shape currently between BEGIN/END (to attach its row count).
    let   pendingSoql = null;
    // D3: unit-duration tracking. Each log line carries an elapsed-nanoseconds
    // value in parens ("10:00:00.1 (1234)|…"); pairing START/FINISH events by
    // that value gives exact durations. Aggregated by label so an N+1 method
    // shows its TOTAL cost. Unbalanced pairs (truncated logs) are ignored.
    const unitStack = [];              // [{label, type, startNs}]
    const durByLabel = new Map();      // label → {type, totalNs, count}
    const addDur = (label, type, ns) => {
      if (!label || !(ns >= 0)) return;
      const e = durByLabel.get(label) || { type, totalNs: 0, count: 0 };
      e.totalNs += ns; e.count++; durByLabel.set(label, e);
    };
    const _normSoql = q => String(q)
      .replace(/'[^']*'/g, '?')            // string literals
      .replace(/\b\d{4}-\d\d-\d\d[^\s,)]*/g, '?')  // date/datetime literals
      .replace(/\b\d+\b/g, '?')            // numbers / ids-in-bind
      .replace(/\bIN\s*\([^)]*\)/gi, 'IN (?)')     // IN lists
      .replace(/\s+/g, ' ').trim().slice(0, 300);

    for (const line of text.split('\n')) {
      result.stats.lines++;

      // ── Governor-limit summary block — these lines have no '|' delimiter ──
      if (inLimits) {
        if (line.includes('|')) {
          inLimits = false; // hit a real event line — fall through to parse it
        } else {
          const lm = line.match(/^\s+(.+?):\s*([\d,]+)\s+out of\s+([\d,]+)/);
          if (lm) {
            result.limits[lm[1].trim()] = {
              used: parseInt(lm[2].replace(/,/g, ''), 10) || 0,
              max:  parseInt(lm[3].replace(/,/g, ''), 10) || 0,
            };
          }
          continue;
        }
      }

      if (!line.includes('|')) continue;
      // Skip the timestamp prefix — find first '|'
      const p1    = line.indexOf('|');
      if (p1 === -1) continue;
      const rest  = line.slice(p1 + 1);
      const p2    = rest.indexOf('|');
      const event = p2 === -1 ? rest : rest.slice(0, p2);
      const data  = p2 === -1 ? '' : rest.slice(p2 + 1);

      // D3: elapsed nanoseconds from the timestamp prefix "HH:MM:SS.m (12345)".
      const nsM = line.slice(0, p1).match(/\((\d+)\)/);
      const ns  = nsM ? parseInt(nsM[1], 10) : NaN;

      // D3: pair *_STARTED/_FINISHED (code units) and METHOD_ENTRY/EXIT into
      // durations. Matching is LIFO by label when possible, else top-of-stack —
      // truncated logs with unbalanced pairs simply drop the orphan.
      if (Number.isFinite(ns)) {
        if (event === 'CODE_UNIT_STARTED' || event === 'METHOD_ENTRY' || event === 'FLOW_START_INTERVIEW_BEGIN') {
          const type  = event === 'CODE_UNIT_STARTED' ? 'unit' : event === 'METHOD_ENTRY' ? 'method' : 'flow';
          const label = event === 'FLOW_START_INTERVIEW_BEGIN'
            ? 'Flow: ' + (data.split('|')[1] || 'Unknown')
            : (data.split('|').pop() || '').trim();
          unitStack.push({ label, type, startNs: ns });
        } else if (event === 'CODE_UNIT_FINISHED' || event === 'METHOD_EXIT' || event === 'FLOW_START_INTERVIEW_END') {
          const closeLabel = event === 'FLOW_START_INTERVIEW_END'
            ? 'Flow: ' + (data.split('|')[1] || 'Unknown')
            : (data.split('|').pop() || '').trim();
          let idx = -1;
          for (let i = unitStack.length - 1; i >= 0; i--) {
            if (unitStack[i].label === closeLabel) { idx = i; break; }
          }
          if (idx === -1 && unitStack.length) idx = unitStack.length - 1;
          if (idx !== -1) {
            const open = unitStack.splice(idx, 1)[0];
            addDur(open.label, open.type, ns - open.startNs);
          }
        }
      }

      switch (event) {

        case 'LIMIT_USAGE_FOR_NS': {
          // data: (default)|   OR  (namespace)|  — only capture the default ns
          const ns = (data.split('|')[0] || '').trim();
          inLimits = (ns === '(default)' || ns === '');
          break;
        }
        case 'CUMULATIVE_LIMIT_USAGE_END':
          inLimits = false;
          break;

        case 'SOQL_EXECUTE_BEGIN': {
          result.stats.soql++;
          // D2: group queries by SHAPE (bind values stripped) so the same
          // query running 47× in a loop shows up as one row with a count.
          const qm = data.match(/\|(SELECT[\s\S]*)$/i);
          if (qm) {
            const shape = _normSoql(qm[1]);
            if (!result.soqlShapes[shape]) {
              result.soqlShapes[shape] = { count: 0, rows: 0, firstLine: result.stats.lines, sample: qm[1].slice(0, 200) };
            }
            const sh = result.soqlShapes[shape];
            sh.count++;
            pendingSoql = sh;
          } else {
            pendingSoql = null;
          }
          break;
        }
        case 'SOQL_EXECUTE_END': {
          const rm = data.match(/Rows:(\d+)/);
          const rows = rm ? (parseInt(rm[1], 10) || 0) : 0;
          if (rm) result.stats.soqlRows += rows;
          if (pendingSoql) { pendingSoql.rows += rows; pendingSoql = null; }
          break;
        }
        case 'CALLOUT_REQUEST':
          result.stats.callouts++;
          break;
        case 'VALIDATION_FAIL':
          result.stats.validationFails++;
          break;

        case 'DML_BEGIN': {
          // data: [line]|Op:Insert|Type:Account|Rows:1
          const op   = (data.match(/Op:(\w+)/)      || [])[1] || '';
          const type = ((data.match(/Type:([^|]+)/) || [])[1] || '').trim();
          const rows = (data.match(/Rows:(\d+)/)     || [])[1] || '';
          const ctx  = { op, type, rows };
          dmlStack.push(ctx);
          result.dmlOps.push(ctx);
          result.stats.dml++;
          result.stats.dmlRows += parseInt(rows, 10) || 0;
          break;
        }

        case 'DML_END': {
          dmlStack.pop();
          break;
        }

        case 'FLOW_START_INTERVIEW_BEGIN': {
          // data: [lineNum]|FlowApiName|InterviewId|...
          const parts = data.split('|');
          const name  = parts[1] || 'Unknown Flow';
          const depth = flowStack.filter(n => n === name).length;
          if (!result.flows[name]) result.flows[name] = {
            count: 0, maxDepth: 0, faulted: false, recursed: false,
            recordTriggered: false, parents: [], triggeringObjects: []
          };
          const f = result.flows[name];
          f.count++;
          f.maxDepth = Math.max(f.maxDepth, depth);

          // Sub-flow? Record the parent flow it was launched from.
          if (flowStack.length) {
            const parent = flowStack[flowStack.length - 1];
            if (parent && !f.parents.includes(parent)) f.parents.push(parent);
          } else if (dmlStack.length) {
            // Top-level flow running inside a DML save → record-triggered.
            f.recordTriggered = true;
            const dc  = dmlStack[dmlStack.length - 1];
            const tag = `${dc.op || 'DML'} ${dc.type || ''}`.trim();
            if (tag && !f.triggeringObjects.includes(tag)) f.triggeringObjects.push(tag);
          }

          if (depth > 0) {
            f.recursed = true;
            const existing = result.recursions.find(r => r.type === 'flow' && r.name === name);
            if (existing) { existing.count = f.count; existing.depth = Math.max(existing.depth, depth); }
            else result.recursions.push({ type: 'flow', name, count: f.count, depth });
          }
          flowStack.push(name);
          break;
        }

        case 'FLOW_START_INTERVIEW_END': {
          const name = data.split('|')[1] || '';
          const idx  = flowStack.lastIndexOf(name);
          if (idx !== -1) flowStack.splice(idx, 1);
          break;
        }

        case 'FLOW_ELEMENT_BEGIN': {
          // D6: record the path the interview actually took. data:
          // [interviewId]|ElementType|ElementName — attach to the innermost
          // running flow; consecutive repeats collapse into ×N (loop turns).
          const top = flowStack[flowStack.length - 1];
          const f   = top ? result.flows[top] : null;
          if (f) {
            const parts = data.split('|');
            const etype = (parts[1] || '').trim();
            const ename = (parts[2] || parts[1] || '').trim();
            if (ename) {
              if (!f.path) f.path = [];
              const last = f.path[f.path.length - 1];
              if (last && last.n === ename && last.t === etype) last.c++;
              else if (f.path.length < 80) f.path.push({ n: ename, t: etype, c: 1 });
              else f.path.truncated = true;
            }
          }
          break;
        }

        case 'FLOW_ELEMENT_FAULT':
        case 'FLOW_INTERVIEW_FINISHED_NOT_RESUMED': {
          const top = flowStack[flowStack.length - 1];
          if (top && result.flows[top]) result.flows[top].faulted = true;
          break;
        }

        case 'CODE_UNIT_STARTED': {
          // data: [EXTERNAL]|id|Trigger:Name on Object trigger event AfterUpdate
          //   OR  [EXTERNAL]|id|Class:Name  OR  [EXTERNAL]|id|VF:...  etc.
          result.stats.codeUnits++;
          const label = (data.split('|').pop() || '').trim();
          if (label) {
            if (!result.entryPoint) result.entryPoint = label;
            const cu = result.codeUnits.find(c => c.label === label);
            if (cu) cu.count++;
            else if (result.codeUnits.length < 50) result.codeUnits.push({ label, count: 1 });
          }
          const m = data.match(/Trigger:(\w+)/);
          if (m) {
            const name = m[1];
            if (!result.triggers[name]) result.triggers[name] = { count: 0, operations: [] };
            result.triggers[name].count++;
            // Capture the DML event (BeforeInsert / AfterUpdate / …)
            const opM = data.match(/\b(Before|After)\s?(Insert|Update|Delete|Undelete)/i);
            if (opM) {
              const opLabel = `${opM[1]} ${opM[2]}`;
              if (!result.triggers[name].operations.includes(opLabel)) {
                result.triggers[name].operations.push(opLabel);
              }
            }
          }
          break;
        }

        case 'PROCESS_STARTED':
        case 'PROCESS_CONTINUE': {
          const parts = data.split('|');
          const name  = (parts[1] || parts[0] || 'Unknown Process').trim();
          if (name) {
            if (!result.processes[name]) result.processes[name] = { count: 0 };
            result.processes[name].count++;
          }
          break;
        }

        case 'WF_RULE_EVAL_VALUE': {
          // data: [line]|RuleName|...  (varies by org version)
          const parts = data.split('|');
          const name  = (parts[1] || parts[0] || '').trim();
          if (name) {
            if (!result.wfRules[name]) result.wfRules[name] = { count: 0 };
            result.wfRules[name].count++;
          }
          break;
        }

        case 'EXCEPTION_THROWN':
        case 'FATAL_ERROR': {
          if (result.errors.length < 25) {
            // result.stats.lines is the current 1-based line number (D5:
            // click an exception → jump the viewer to it).
            result.errors.push({
              msg: data.substring(0, 360),
              line: result.stats.lines,
              fatal: event === 'FATAL_ERROR'
            });
          }
          break;
        }
      }
    }

    // Triggers that fired multiple times suggest cascading behavior
    for (const [name, info] of Object.entries(result.triggers)) {
      if (info.count > 1 && !result.recursions.find(r => r.type === 'trigger' && r.name === name)) {
        result.recursions.push({ type: 'trigger', name, count: info.count, depth: 0 });
      }
    }

    // D3: finalize the timeline — top units by total wall time. Methods under
    // 1ms total are noise; drop them. ms = ns / 1e6.
    result.timeline = [...durByLabel.entries()]
      .map(([label, e]) => ({ label, type: e.type, ms: e.totalNs / 1e6, count: e.count }))
      .filter(u => u.ms >= 1)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 25);

    return result;
  }

  // ── D8: purge logs older than 24h ─────────────────────────
  async function _purgeOld() {
    const btn = document.getElementById('adbgPurgeOldBtn');
    if (!btn) return;
    if (!btn.dataset.armed) {   // two-click confirm, same pattern as Delete All
      btn.dataset.armed = '1';
      btn.textContent   = '⚠ Confirm >24h';
      btn.classList.add('adbg-btn-armed');
      setTimeout(() => {
        if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = '🧹 >24h'; btn.classList.remove('adbg-btn-armed'); }
      }, 3500);
      return;
    }
    delete btn.dataset.armed;
    btn.classList.remove('adbg-btn-armed');
    btn.disabled = true; btn.textContent = 'Purging…';
    const cutoff = new Date(Date.now() - 86400000).toISOString().replace(/\.\d+Z$/, 'Z');
    const res = await _bg({ type: 'SF_QUERY_ALL', tooling: true,
      query: `SELECT Id FROM ApexLog WHERE StartTime < ${cutoff}` });
    const ids = (res.records || []).map(r => r.Id);
    // Deletes run one-by-one and can far exceed the 200 listed — show a busy
    // cat in the list plus a live n/N counter so it never looks frozen.
    const listEl = document.getElementById('adbgLogList');
    if (listEl) listEl.innerHTML = '<div class="adbg-list-ph">' + sftkCatSm('Purging old logs…') + '</div>';
    const cnt = document.getElementById('adbgLogCount');
    let done = 0;
    for (const id of ids) {
      await _bg({ type: 'SF_TOOLING_DELETE', sobject: 'ApexLog', id }).catch(() => {});
      done++;
      if (cnt) cnt.textContent = `Deleting ${done}/${ids.length}`;
    }
    btn.disabled = false; btn.textContent = '🧹 >24h';
    _loadLogs();
  }

  // ── D7: compare two logs side by side ─────────────────────
  function _syncCompareBtn() {
    const btn = document.getElementById('adbgCompareBtn');
    if (btn) btn.style.display = _checked.size === 2 ? '' : 'none';
  }

  async function _ensureParsed(id) {
    if (_bodyCache[id]) return _bodyCache[id];
    const res = await _bg({ type: 'SF_REST_GET_TEXT', path: `${TAPI}/sobjects/ApexLog/${id}/Body` });
    if (res.error) return null;
    const parsed = _parseLog(res.text || '');
    parsed.id = id; parsed.raw = res.text || '';
    parsed.meta = _logs.find(l => l.Id === id) || {};
    _bodyCache[id] = parsed;
    return parsed;
  }

  async function _compareLogs() {
    const [aId, bId] = [..._checked];
    const detail = document.getElementById('adbgDetail');
    if (!detail || !aId || !bId) return;
    detail.innerHTML = `<div class="adbg-detail-loading">${sftkCat('Comparing logs…')}</div>`;
    const [A, B] = await Promise.all([_ensureParsed(aId), _ensureParsed(bId)]);
    if (!A || !B) { detail.innerHTML = '<div class="adbg-detail-err">Could not load one of the logs.</div>'; return; }

    // Older log on the left = "before". StartTime from meta.
    const [L, R] = (Date.parse(A.meta.StartTime || 0) <= Date.parse(B.meta.StartTime || 0)) ? [A, B] : [B, A];
    const peak = p => Math.max(0, ...Object.values(p.limits || {}).map(l => l.max > 0 ? Math.round(l.used / l.max * 100) : 0));
    const topMs = p => (p.timeline && p.timeline[0]) ? p.timeline[0].ms : 0;
    const rows = [
      ['Duration',        p => p.meta.DurationMilliseconds ?? '—', v => typeof v === 'number' ? (v >= 1000 ? (v/1000).toFixed(1)+'s' : v+'ms') : v, true],
      ['Log lines',       p => p.stats.lines,      v => v.toLocaleString(), true],
      ['SOQL queries',    p => p.stats.soql,       v => v, true],
      ['Query rows',      p => p.stats.soqlRows,   v => v.toLocaleString(), true],
      ['DML statements',  p => p.stats.dml,        v => v, true],
      ['Exceptions',      p => p.errors.length,    v => v, true],
      ['Peak limit %',    p => peak(p),            v => v + '%', true],
      ['Slowest unit',    p => topMs(p),           v => v >= 1000 ? (v/1000).toFixed(2)+'s' : Math.round(v)+'ms', true],
    ];
    const fmtDelta = (a, b) => {
      if (typeof a !== 'number' || typeof b !== 'number') return '';
      const d = b - a;
      if (d === 0) return '<span class="adbg-cmp-same">=</span>';
      const better = d < 0;   // lower is better for every metric here
      return `<span class="${better ? 'adbg-cmp-better' : 'adbg-cmp-worse'}">${better ? '▼' : '▲'} ${Math.abs(Math.round(d * 10) / 10).toLocaleString()}</span>`;
    };
    const name = p => `${_esc((p.meta.Operation || 'log').slice(0, 34))}<br><small>${p.meta.StartTime ? new Date(p.meta.StartTime).toLocaleTimeString() : ''}</small>`;
    detail.innerHTML = `
      <div class="adbg-detail-inner">
        <div class="adbg-cmp">
          <div class="adbg-cmp-hdr">⚖ Before / after comparison
            <button class="btn btn-secondary btn-sm" id="adbgCmpClose">✕ Close</button>
          </div>
          <table class="adbg-cmp-table">
            <tr><th></th><th>${name(L)}</th><th>${name(R)}</th><th>Δ</th></tr>
            ${rows.map(([lbl, get, fmt]) => {
              const a = get(L), b = get(R);
              return `<tr><td>${lbl}</td><td>${fmt(a)}</td><td>${fmt(b)}</td><td>${fmtDelta(a, b)}</td></tr>`;
            }).join('')}
          </table>
          <div class="adbg-cmp-hint">Older log on the left. ▼ = improved (lower), ▲ = regressed. Click a log row to leave compare view.</div>
        </div>
      </div>`;
    document.getElementById('adbgCmpClose')?.addEventListener('click', () => {
      detail.innerHTML = '<div class="adbg-detail-empty"><div class="adbg-detail-icon">🔍</div><div>Select a log to inspect automations</div></div>';
    });
  }

  // ── Delete operations ─────────────────────────────────────
  async function _deleteLog(id) {
    const row = document.querySelector(`.adbg-log-row[data-id="${id}"]`);
    if (row) row.style.opacity = '0.35';
    await _bg({ type: 'SF_TOOLING_DELETE', sobject: 'ApexLog', id }).catch(() => {});
    _logs = _logs.filter(l => l.Id !== id);
    _checked.delete(id);
    _newIds.delete(id);
    delete _bodyCache[id];
    if (_selLogId === id) {
      _selLogId = null;
      const d = document.getElementById('adbgDetail');
      if (d) d.innerHTML = '<div class="adbg-detail-empty"><div class="adbg-detail-icon">🗑</div><div>Log deleted</div></div>';
    }
    _renderLogList();
    _updateCount();
    _updateDelBtn();
  }

  async function _deleteSelected() {
    const ids = [..._checked];
    if (!ids.length) return;
    const btn = document.getElementById('adbgDelSelBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
    // Live n/N progress in the count span — deletes run sequentially.
    const cnt = document.getElementById('adbgLogCount');
    let done = 0;
    for (const id of ids) {
      await _bg({ type: 'SF_TOOLING_DELETE', sobject: 'ApexLog', id }).catch(() => {});
      _logs = _logs.filter(l => l.Id !== id);
      _checked.delete(id);
      _newIds.delete(id);
      delete _bodyCache[id];
      done++;
      if (cnt) cnt.textContent = `Deleting ${done}/${ids.length}`;
    }
    if (ids.includes(_selLogId)) {
      _selLogId = null;
      const d = document.getElementById('adbgDetail');
      if (d) d.innerHTML = '<div class="adbg-detail-empty"><div class="adbg-detail-icon">🗑</div><div>Logs deleted</div></div>';
    }
    _renderLogList();
    _updateCount();
    _updateDelBtn();
  }

  async function _deleteAll() {
    if (!_logs.length) return;
    const btn = document.getElementById('adbgDelAllBtn');
    if (!btn) return;

    // Two-click confirm: first click arms the button; second click executes
    if (!btn.dataset.armed) {
      btn.dataset.armed    = '1';
      btn.textContent      = '⚠ Confirm Delete All';
      btn.classList.add('adbg-btn-armed');
      setTimeout(() => {
        if (btn.dataset.armed) {
          delete btn.dataset.armed;
          btn.textContent = '🗑 Delete All';
          btn.classList.remove('adbg-btn-armed');
        }
      }, 3500);
      return;
    }

    // Execute
    delete btn.dataset.armed;
    btn.classList.remove('adbg-btn-armed');
    btn.disabled    = true;
    btn.textContent = 'Deleting…';

    const ids = _logs.map(l => l.Id);
    // Up to 200 sequential deletes (30+ seconds) — busy cat in the list body
    // plus a live n/N counter in the count span.
    const listEl = document.getElementById('adbgLogList');
    if (listEl) listEl.innerHTML = '<div class="adbg-list-ph">' + sftkCatSm('Deleting logs…') + '</div>';
    const cnt = document.getElementById('adbgLogCount');
    let done = 0;
    for (const id of ids) {
      await _bg({ type: 'SF_TOOLING_DELETE', sobject: 'ApexLog', id }).catch(() => {});
      done++;
      if (cnt) cnt.textContent = `Deleting ${done}/${ids.length}`;
    }
    _logs      = [];
    _bodyCache = {};
    _checked.clear();
    _newIds.clear();
    _selLogId  = null;

    const d = document.getElementById('adbgDetail');
    if (d) d.innerHTML = '<div class="adbg-detail-empty"><div class="adbg-detail-icon">🗑</div><div>All logs deleted</div></div>';

    _renderLogList();
    _updateCount();
    _updateDelBtn();
    btn.disabled    = false;
    btn.textContent = '🗑 Delete All';
  }

  // ── Download raw log ──────────────────────────────────────
  async function _downloadRaw(id) {
    const res = await _bg({ type: 'SF_REST_GET_TEXT', path: `${TAPI}/sobjects/ApexLog/${id}/Body` });
    if (res.error) { _showErrorModal('Download failed', res.error); return; }
    const blob = new Blob([res.text], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
      href: url, download: `apex-${id.slice(0, 8)}.log`
    });
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Open this log in a standalone new-tab viewer ──────────
  // Stashes the parsed log payload in chrome.storage.local under a one-shot
  // key, then opens apex-log-viewer.html?key=… in a new tab. The standalone
  // page reads + deletes the key on load, giving the user a real fullscreen
  // log experience (whole viewport, no popup chrome) with the same search /
  // filter / goto controls as the inline panel.
  async function _openLogInNewTab(p, btn) {
    const orig = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = '… opening'; }
    // May refetch a multi-MB log body and write it to chrome.storage — show a
    // busy cat in the detail header while it works.
    const hdr = document.getElementById('adbgDetHdr');
    let busy = null;
    if (hdr) {
      busy = document.createElement('div');
      busy.innerHTML = sftkCatSm('Preparing log viewer…');
      hdr.prepend(busy);
    }
    try {
      let raw = p.raw;
      // p.raw is set by _renderDetail but defensive: refetch if missing.
      if (!raw) {
        const res = await _bg({ type: 'SF_REST_GET_TEXT', path: `${TAPI}/sobjects/ApexLog/${p.id}/Body` });
        if (res.error) throw new Error(res.error);
        raw = res.text || '';
      }
      const key = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const storeKey = 'apex_log_viewer_' + key;
      const payload = {
        raw,
        report:   _buildReport(p),
        fileName: `apex-${(p.id || 'log').slice(0, 8)}`,
        meta: p.meta || {},
      };
      await chrome.storage.local.set({ [storeKey]: payload });
      const url = chrome.runtime.getURL(`apex-log-viewer.html?key=${encodeURIComponent(key)}`);
      await chrome.tabs.create({ url });
    } catch (err) {
      const raw = err.message || String(err);
      // Huge logs can blow the chrome.storage quota — give a specific hint.
      const quotaHint = /quota/i.test(raw)
        ? 'This log is too large for the new-tab viewer — use ⬇ Raw Log to download it instead.'
        : null;
      _showErrorModal('Could not open log in new tab', raw, quotaHint);
    } finally {
      busy?.remove();
      if (btn) { btn.disabled = false; btn.textContent = orig || '⤢ Open in new tab'; }
    }
  }

  // ── Helpers ───────────────────────────────────────────────
  function _updateCount() {
    const cnt = document.getElementById('adbgLogCount');
    if (cnt) cnt.textContent = `${_logs.length} log${_logs.length !== 1 ? 's' : ''}`;
  }

  // Friendly-error modal — replaces native alert(). Raw error kept in the
  // title attribute for copy/paste; hintOverride wins over the generic hint.
  function _showErrorModal(title, rawError, hintOverride) {
    const fe   = sftkFriendlyError(rawError);
    const hint = hintOverride || fe.hint;
    if (typeof showModal !== 'function') {   // defensive — popup.js provides it
      alert(title + ': ' + fe.message + (hint ? ' — ' + hint : ''));
      return;
    }
    showModal(`
      <div class="modal-header modal-warn">
        <span class="modal-icon">⚠️</span>
        <h2>${_esc(title)}</h2>
      </div>
      <div class="modal-body">
        <p title="${_esc(fe.raw)}">${_esc(fe.message)}${hint ? ` — ${_esc(hint)}` : ''}</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="modalCancel">Close</button>
      </div>
    `);
    document.getElementById('modalCancel')?.addEventListener('click', () => closeModal());
  }

  function _esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _bg(msg) {
    return new Promise(resolve =>
      chrome.runtime.sendMessage({ orgUrl: _orgUrl, sid: _sid, ...msg }, r =>
        resolve(r || { error: chrome.runtime.lastError?.message || 'No response' })
      )
    );
  }

  // ── Export ────────────────────────────────────────────────
  // Test-only surface (harness/unit tests). Harmless in production — just refs.
  const _test = { parseLog: _parseLog, matchesCat: _logMatchesCat, renderDetail: _renderDetail,
    setLogs: (l) => { _logs = l; }, peak: _logPeak };
  return { init, updateSession, _test };
})();
