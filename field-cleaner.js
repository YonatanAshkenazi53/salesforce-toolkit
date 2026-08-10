// ============================================================
// Field Cleaner — scan field dependencies & safely clean them
// ============================================================

// ── Pure picker helpers (top-level on purpose) ───────────────
// These live at column 0, outside the IIFE, so
// test/field-cleaner-objects.test.mjs can materialize them standalone via
// test/extract.mjs. They must therefore stay PURE: no free variables, no DOM,
// no module state. Thresholds are inlined here for the same reason.

// SOQL string literal. Same contract as studio-core's soqlStrLit(), carried
// locally because that lib is only loaded on the Studio page, not the popup.
function fcSoqlLit(v) {
  return "'" + String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

// SOQL LIKE literal wrapped in %…%. Backslash MUST be escaped first, then the
// quote, then the LIKE wildcards % and _ — so a user typing "npsp__" searches
// for two literal underscores instead of matching every object in the org.
function fcSoqlLike(v) {
  const body = String(v == null ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
  return "'%" + body + "%'";
}

// Strip a managed-package namespace prefix: FinServ__FinancialAccount__c →
// FinancialAccount__c. A namespace only exists with three or more
// __-separated segments; Account__c is a plain custom object, not namespaced.
function fcLocalApiName(api) {
  const s = String(api == null ? '' : api);
  const parts = s.split('__');
  return parts.length >= 3 ? parts.slice(1).join('__') : s;
}

// Match rank for one picker row: 0 exact · 1 prefix · 2 prefix after the
// namespace · 3 contains · null no match. Tier 2 exists because an admin types
// "FinancialAccount", not the "FinServ__" prefix the package ships it under —
// without it every package object sinks below the .slice(0, 60) cut-off.
function fcScoreEntry(entry, term) {
  const t = String(term == null ? '' : term).trim().toLowerCase();
  const api   = String((entry && entry.api)   || '').toLowerCase();
  const label = String((entry && entry.label) || '').toLowerCase();
  if (!api && !label) return null;
  if (!t) return 0;
  if (api === t || label === t) return 0;
  if (api.startsWith(t) || label.startsWith(t)) return 1;
  const local = fcLocalApiName(api);
  if (local !== api && local.startsWith(t)) return 2;
  if (api.includes(t) || label.includes(t)) return 3;
  return null;
}

function fcCompareEntries(a, b) {
  const al = String((a && (a.label || a.api)) || '');
  const bl = String((b && (b.label || b.api)) || '');
  const c  = al.localeCompare(bl);
  return c !== 0
    ? c
    : String((a && a.api) || '').localeCompare(String((b && b.api) || ''));
}

// Filter + rank a picker pool. An empty filter returns the whole pool sorted
// by label — the server's ORDER BY can't be trusted once server-search hits
// are merged in out of band.
function fcRankEntries(pool, filter) {
  const list = Array.isArray(pool) ? pool : [];
  const t    = String(filter == null ? '' : filter).trim();
  if (!t) return list.slice().sort(fcCompareEntries);
  const scored = [];
  for (const e of list) {
    const s = fcScoreEntry(e, t);
    if (s !== null) scored.push({ e, s });
  }
  scored.sort((x, y) => (x.s - y.s) || fcCompareEntries(x.e, y.e));
  return scored.map(x => x.e);
}

// Merge server-search hits into the loaded pool without duplicating rows.
// Keyed on api name case-insensitively — Salesforce api names are
// case-insensitive and two queries can spell the same one differently.
// Returns a NEW array; the pool is never mutated.
// PURE. Is this EntityDefinition row noise for a CUSTOM-FIELD cleaner?
// (user 2026-07-30: "why do we see all the missing labels? its a noise. who
// use these objects?")
//
// Salesforce auto-creates a shadow object per feature — <X>Feed for Chatter,
// <X>Share for sharing rows, <X>History for field history, <X>ChangeEvent for
// CDC — and in most orgs ships them with an unresolved label, which surfaces
// literally as "__MISSING LABEL__ PropertyFile - val X not found in section
// StandardFeedLabel". None of them hold custom fields an admin can clean, so
// every one is a row the user must scroll past to reach a real object.
//
// They are HIDDEN, NOT DROPPED: the picker states how many it hid and can
// show them on demand — an object silently missing is the exact failure the
// pagination work existed to fix.
function fcIsSystemShadowObject(api, label) {
  const a = String(api || '');
  if (/(?:Feed|Share|History|ChangeEvent|Tag)$/.test(a)) return true;
  // A broken label is itself the signal: nothing an admin picks on purpose
  // announces itself as a missing translation key.
  if (/^__MISSING LABEL__/.test(String(label || ''))) return true;
  return false;
}

// PURE. Split a mapped entity list into what the picker shows and what it
// hides, so the count in the UI is measured rather than guessed.
function fcPartitionObjects(list, showAll) {
  const all = Array.isArray(list) ? list : [];
  if (showAll) return { shown: all, hidden: 0 };
  const shown = all.filter(e => !fcIsSystemShadowObject(e && e.api, e && e.label));
  return { shown, hidden: all.length - shown.length };
}

// ── Keyboard access for the two dropdown pickers (QA 2026-07-31) ─────
// Field Cleaner shipped with FIVE mousedown handlers, ZERO keydown handlers
// and no tabindex anywhere: both the object and the field picker were pure
// <div> lists you could only reach with a mouse, so the whole feature was
// unusable by keyboard. The a11y pass swept the debugger and the popup shell
// and missed this file entirely.
//
// Both pickers render the same `.fc-dd-item` rows into a list under a text
// input, so one combobox layer serves both: ↓/↑ move an active row, Enter
// picks it, Escape closes, Home/End jump. The ACTIVE row is a class, not
// focus — moving real focus out of the input would break typing.
function fcWireDropdownKeys(input, drop, pick) {
  if (!input || !drop || input.dataset.fcKeys === '1') return;
  input.dataset.fcKeys = '1';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');

  const items = () => [...drop.querySelectorAll('.fc-dd-item')];
  const activeIdx = list => list.findIndex(el => el.classList.contains('fc-dd-active'));
  const setActive = (list, i) => {
    list.forEach(el => { el.classList.remove('fc-dd-active'); el.removeAttribute('aria-selected'); });
    const el = list[Math.max(0, Math.min(list.length - 1, i))];
    if (!el) return;
    el.classList.add('fc-dd-active');
    el.setAttribute('aria-selected', 'true');
    if (!el.id) el.id = 'fcdd_' + Math.random().toString(36).slice(2, 9);
    input.setAttribute('aria-activedescendant', el.id);
    try { el.scrollIntoView({ block: 'nearest' }); } catch (_) {}
  };

  input.addEventListener('keydown', e => {
    const open = drop.style.display !== 'none';
    if (e.key === 'Escape') { drop.style.display = 'none'; input.setAttribute('aria-expanded', 'false'); return; }
    const list = items();
    if (!list.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      if (!open) { drop.style.display = ''; input.setAttribute('aria-expanded', 'true'); }
      const cur = activeIdx(list);
      const next = e.key === 'Home' ? 0
        : e.key === 'End' ? list.length - 1
        : e.key === 'ArrowDown' ? (cur < 0 ? 0 : cur + 1)
        : (cur < 0 ? list.length - 1 : cur - 1);
      setActive(list, next);
      return;
    }
    if (e.key === 'Enter') {
      // Only while the dropdown is VISIBLE. A closed dropdown still holds
      // its last item list (pick() hides, it doesn't clear), so Enter after
      // a mouse pick or Escape used to silently re-select the top-ranked
      // row — replacing the object/field the user had just chosen.
      if (!open) return;
      // No explicit selection yet → the top-ranked row is what the user sees
      // first and what a mouse user would click.
      const el = list[Math.max(0, activeIdx(list))];
      if (el) { e.preventDefault(); pick(el); }
    }
  });
}

// Re-point the keyboard-active row after a dropdown repaint. An async org-
// search response lands mid-arrow-navigation and innerHTML wipes the active
// row: aria-activedescendant is left announcing a removed node and Enter
// selects row 0 instead of the row the user had reached. Matches the row by
// data-api (its identity across repaints); when it is gone from the new
// list the stale descendant reference is CLEARED, never left dangling.
function fcRestoreActiveRow(drop, input, api) {
  if (!drop) return;
  const sel = api ? `.fc-dd-item[data-api="${(window.CSS && CSS.escape) ? CSS.escape(api) : api}"]` : null;
  const el = sel ? drop.querySelector(sel) : null;
  if (el) {
    el.classList.add('fc-dd-active');
    el.setAttribute('aria-selected', 'true');
    if (!el.id) el.id = 'fcdd_' + Math.random().toString(36).slice(2, 9);
    input?.setAttribute('aria-activedescendant', el.id);
  } else {
    input?.removeAttribute('aria-activedescendant');
  }
}

function fcMergeEntries(pool, incoming) {
  const list = Array.isArray(pool) ? pool.slice() : [];
  const seen = new Set(list.map(e => String((e && e.api) || '').toLowerCase()));
  let added = 0;
  for (const e of (Array.isArray(incoming) ? incoming : [])) {
    const key = String((e && e.api) || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    list.push(e);
    added++;
  }
  return { list, added };
}

// A Tooling list query that lands exactly on a page or limit boundary cannot
// be proven complete: EntityDefinition caps server-side and stops paginating
// without saying so. 2000 is the Tooling page size. A false "may be capped" is
// the acceptable error here; a false "that's everything" is the bug.
function fcLooksCapped(count, requestedLimit) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return false;
  const lim = Number(requestedLimit);
  if (Number.isFinite(lim) && lim > 0 && n >= lim) return true;
  return n % 2000 === 0;
}

// Does this typed term warrant a round-trip to the org? Only past 2 characters
// (shorter terms match half the org), and only when the local list is thin
// enough that an object could be missing rather than merely unmatched.
// `completedTerms` holds terms whose server search returned COMPLETE — any
// longer term containing one of them is already fully represented locally,
// because every string containing "Fina" also contains "Fin".
function fcShouldServerSearch(term, localMatchCount, completedTerms) {
  const t = String(term == null ? '' : term).trim().toLowerCase();
  if (t.length < 2) return false;
  for (const d of (completedTerms ? Array.from(completedTerms) : [])) {
    const s = String(d == null ? '' : d).toLowerCase();
    if (s && t.includes(s)) return false;
  }
  return (Number(localMatchCount) || 0) < 5;
}

// The dropdown's honest footer. Absence must never look like non-existence:
// a truncated render says how many it hid, and a capped fetch says the list
// itself is incomplete. Returns '' when there is genuinely nothing to declare.
function fcPickerSummary(state) {
  const s       = state || {};
  const shown   = Number(s.shown)   || 0;
  const matched = Number(s.matched) || 0;
  const total   = Number(s.total)   || 0;
  const noun    = String(s.noun || 'item');
  const parts   = [];
  if (matched > shown) {
    parts.push(`showing ${shown} of ${matched} matches — keep typing to narrow`);
  }
  if (s.capped) {
    parts.push(`${total} ${noun}${total === 1 ? '' : 's'} loaded — Salesforce ` +
               `stopped at exactly ${total}, so this list is incomplete` +
               (s.capHint ? `. ${s.capHint}` : ''));
  }
  if (s.searching) parts.push('searching the org…');
  return parts.join(' · ');
}

// E3b — what a full dependency scan costs, stated honestly. The floor is the
// scan's fixed legs, counted from runScan/scanFlexiPages/scanSupplemental as
// written: field-id lookup (1) + MetadataComponentDependency query (1) +
// Lightning-page list (1) + list-view list (1) + compact-layout describe (1)
// + quick-action list (1) + matching-rule query (1) + workflow-field-update
// query (1) = 8. Three legs then fan out one call PER ITEM the lists return —
// unknowable before the scan looks, so a count that hasn't been discovered
// yet stays a "more if", never a made-up number.
// counts: { flexiPages, listViews, quickActions } — each a number when known,
// null/undefined when not. Returns { now, known, moreIf } where `now` is the
// call floor including every KNOWN leg and `moreIf` names the unknown ones.
function fcEstimateScanCalls(counts) {
  const c = counts || {};
  const known = v => (Number.isFinite(Number(v)) && Number(v) >= 0) ? Math.floor(Number(v)) : null;
  const legs = [
    { count: known(c.flexiPages),   what: 'Lightning page in the org' },
    { count: known(c.listViews),    what: 'list view on this object' },
    { count: known(c.quickActions), what: 'create/update quick action on this object' },
  ];
  let now = 8;
  const moreIf = [];
  for (const l of legs) {
    if (l.count === null) moreIf.push(l.what);
    else now += l.count;
  }
  return { now, known: moreIf.length === 0, moreIf };
}

// E3b — the one-line cost display for the scan button. est comes from
// fcEstimateScanCalls. budgetInfo is null/undefined when the shared budget
// reader (window.sftkApiBudget — a Studio-page helper the popup may not
// load) is absent: then the line is JUST the local estimate. When the reader
// exists, budgetInfo = { label, budget } with budget { max, remaining } or
// null — null is SAID ("API budget unavailable"), never hidden. warn flips
// when the known call floor alone EXCEEDS the remaining budget (equal is not
// over) — it informs, it never blocks the scan.
function fcScanBudgetLine(est, budgetInfo) {
  const fmt = v => Number(v).toLocaleString();
  const e = est || {};
  const now = Number.isFinite(e.now) ? e.now : 0;
  const moreIf = Array.isArray(e.moreIf) ? e.moreIf : [];
  let head;
  if (moreIf.length) {
    const list = moreIf.length === 1
      ? moreIf[0]
      : moreIf.slice(0, -1).join(', ') + ', and ' + moreIf[moreIf.length - 1];
    head = `≈${fmt(now)} API calls now, plus 1 for each ${list} the scan opens`;
  } else {
    head = `≈${fmt(now)} API call${now === 1 ? '' : 's'}`;
  }
  const parts = [head];
  let warn = false;
  if (budgetInfo) {
    const label = budgetInfo.label ? String(budgetInfo.label) : 'this org';
    const b = budgetInfo.budget;
    if (b && Number.isFinite(b.remaining) && Number.isFinite(b.max)) {
      parts.push(`${label} has ${fmt(b.remaining)} of ${fmt(b.max)} daily API calls remaining`);
      if (now > b.remaining) warn = true;
    } else {
      parts.push(`${label}: API budget unavailable`);
    }
  }
  let text = parts.join(' · ');
  if (warn) text = `⚠ ${text} — this scan may exhaust the org's remaining daily API budget`;
  return { text, warn };
}

// Targeted EntityDefinition lookup for one typed term — the fallback for
// objects the capped list never contained. LIMIT is clamped to one Tooling
// page; anything past that is reported as capped rather than trusted.
function fcObjectSearchSoql(term, limit) {
  const lit = fcSoqlLike(term);
  const n   = Math.max(1, Math.min(2000, Number(limit) || 200));
  return 'SELECT QualifiedApiName, Label, DurableId FROM EntityDefinition ' +
         'WHERE IsDeprecatedAndHidden = false ' +
         `AND (QualifiedApiName LIKE ${lit} OR Label LIKE ${lit}) ` +
         `ORDER BY QualifiedApiName LIMIT ${n}`;
}

const FieldCleaner = (() => {
  'use strict';

  let _orgUrl    = null;
  let _sid       = null;
  let _container = null;

  // Selection state
  let _selObj    = null;   // { api, label, durableId }
  let _selField  = null;   // { durableId, api, label, type }
  let _allObjects = [];
  let _allFields  = [];
  let _objectsLoaded = false;
  // Session-only: Feed/Share/History/ChangeEvent objects stay hidden until the
  // user asks for them in the picker.
  let _objShowSystem = false;
  let _groups    = {};     // type → [dep records] — kept for fixAll

  // Picker completeness state. The bug this guards: EntityDefinition caps
  // server-side, so a big managed-package org silently loses objects off the
  // end of the list — and renderObjDrop filters CLIENT-SIDE, so search can
  // never reach one that never loaded. Everything below exists to make that
  // visible and recoverable instead of invisible.
  let _objCapped   = false;   // the object load itself landed on a cap boundary
  let _objListCount = 0;      // rows the LIST query returned — the number the
                              // cap message quotes. Distinct from
                              // _allObjects.length, which grows as server-search
                              // hits are merged in and would make the "stopped
                              // at exactly N" claim false.
  let _objTopping  = false;   // phase-2 pagination still running
  let _objSearchInFlight = null;  // lowercased term currently being asked of the org
  let _objSearchErr = null;   // last server-search failure, disclosed in the drop
  let _objSearchSeq = 0;      // cancel token — stale responses are dropped
  let _objSearchTimer  = null;
  const _objSearchDone = new Set();  // terms whose COMPLETE server search landed
  const _objSearchTried = new Set(); // terms already asked (incl. capped/failed)
  let _fieldsCapped = false;  // FieldDefinition load landed on a cap boundary
  let _fieldsTotal  = 0;      // raw FieldDefinition rows, before the __c filter

  // Tooling page size. EntityDefinition / FieldDefinition come back one page at
  // a time and a result landing exactly on this boundary can't be proven
  // complete — see fcLooksCapped.
  const FC_TOOLING_PAGE = 2000;
  const FC_OBJ_LIMIT    = 12000;  // paginated ceiling for the whole object list
  const FC_FIELD_LIMIT  = 4000;   // one object cannot legally hold this many
  const FC_SEARCH_LIMIT = 200;    // rows one server-side name search returns
  const FC_SEARCH_DEBOUNCE_MS = 280;

  // Dropdown footer / disclosure row. Inline so the module needs nothing new
  // from styles.css.
  const _DD_NOTE_CSS =
    'padding:6px 12px;font-size:10.5px;line-height:1.4;color:var(--subtext);' +
    'border-top:1px solid var(--border-light);';

  // Tooling API sobject names that the XML Inspector can fetch.
  // Types with `Body` at the root (Apex) are handled separately from Metadata types.
  const _INSPECT_SOBJECT = {
    Flow: 'Flow', Layout: 'Layout', FlexiPage: 'FlexiPage',
    ValidationRule: 'ValidationRule',
    ApexClass: 'ApexClass', ApexTrigger: 'ApexTrigger',
  };

  // ── Public API ─────────────────────────────────────────────
  function init(container, orgUrl, sid) {
    _orgUrl    = orgUrl;
    _sid       = sid;
    _container = container;
    renderShell();
    renderSnapshotLog();   // F6: restore points survive across sessions
    // C5a: one delegated listener for every "↗ open in X" cross-link —
    // survives all the innerHTML re-renders. init() is already one-shot
    // per container (popup.js _fcInitialized), but keep our own guard too.
    if (!container.dataset.fcXlinkWired) {
      container.addEventListener('click', ev => {
        const link = ev.target.closest?.('.fc-xlink');
        if (link?.dataset.xtab) jumpToTab(link.dataset.xtab);
      });
      container.dataset.fcXlinkWired = '1';
    }
  }

  function updateSession(orgUrl, sid) {
    _orgUrl = orgUrl;
    _sid    = sid;
  }

  // ── Background calls ───────────────────────────────────────
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
    if (window.SFToolkitDebug?.enabled) {
      const dur = _t !== null ? Date.now() - _t : null;
      const tag = msg.query?.substring(0, 80) || msg.path || msg.sobject || '';
      // Honour _suppressError: planned recovery attempts (e.g. the Layout
      // strip-and-retry loop, two-attempt Metadata deploy) are logged as
      // 'retry' — not 'error' or 'warn' — so the debug export reads as a
      // clean sequence of expected steps, not a noise of false warnings.
      // _silentError goes further: expected-failure probes (standard quick
      // actions whose describe 404s at object scope) log NOTHING on failure.
      const silent = msg._silentError && resp?.error && resp.error !== 'SESSION_EXPIRED';
      if (!silent) {
        const level = resp?.error === 'SESSION_EXPIRED' ? 'session'
                    : resp?.error ? (msg._suppressError ? 'retry' : 'error')
                    : 'api';
        window.SFToolkitDebug.log('fields', level,
          `${msg.type}${tag ? '  ' + tag : ''}`, resp?.error || null, dur);
      }
    }
    if (resp?.error !== 'SESSION_EXPIRED') return resp;
    const fresh = await bgRaw({ type: 'GET_SF_SESSION', activeTabUrl: _orgUrl });
    if (fresh?.sid && fresh?.orgUrl) {
      _orgUrl = fresh.orgUrl; _sid = fresh.sid;
      const retry = msg.sid !== undefined
        ? { ...msg, orgUrl: fresh.orgUrl, sid: fresh.sid } : msg;
      return bgRaw(retry);
    }
    return resp;
  }

  // ── Tiny helpers ───────────────────────────────────────────
  function eid(id)  { return document.getElementById(id); }
  function esc(str) {
    return String(str || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── C5a: cross-links into sibling Toolkit tabs ─────────────
  // Field Cleaner findings often continue in another tool (Flows,
  // Dependencies, Lightning Pages, Copy Permissions, Flow Access).
  // HOME_FEATURES actions (popup.js) both navigate AND kick off the target
  // tab's first data load; bare navigateToTab is the fallback. typeof-guarded
  // so the module stays inert if it ever loads outside the popup shell.
  function jumpToTab(tabId) {
    try {
      const feat = (typeof HOME_FEATURES !== 'undefined')
        ? HOME_FEATURES.find(f => f.id === tabId) : null;
      if (feat) { feat.action(); return; }
      if (typeof navigateToTab === 'function') navigateToTab(tabId);
    } catch (e) { /* a broken convenience link must never break the tab */ }
  }

  // Small link-styled "↗ open in X" button. Clicks are handled by ONE
  // delegated listener wired in init(), so links keep working across every
  // innerHTML re-render. xlinkHtml escapes everything it embeds.
  const _XLINK_CSS =
    'background:none;border:none;padding:0;margin-left:8px;' +
    'color:#0176d3;font:inherit;font-size:11px;font-weight:600;' +
    'cursor:pointer;text-decoration:underline;white-space:nowrap;';
  function xlinkHtml(tabId, label, title) {
    return `<button type="button" class="fc-xlink" data-xtab="${esc(tabId)}"` +
           ` title="${esc(title || '')}" style="${_XLINK_CSS}">${esc(label)}</button>`;
  }
  function xlinkEl(tabId, label, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fc-xlink';
    b.dataset.xtab = tabId;
    if (title) b.title = title;
    b.style.cssText = _XLINK_CSS;
    b.textContent = label;
    return b;
  }

  // ── Shell ──────────────────────────────────────────────────
  function renderShell() {
    // Invalidate any in-flight object search — the drop it would render into
    // is about to be replaced.
    _objSearchSeq++;
    _objSearchInFlight = null;
    if (_objSearchTimer) { clearTimeout(_objSearchTimer); _objSearchTimer = null; }

    _container.innerHTML = `
      <div class="fc-wrap">

        <!-- Step 1 -->
        <div class="fc-step">
          <div class="fc-step-label">1 — Choose an object</div>
          <div class="fc-picker-wrap" id="fcObjWrap">
            <input id="fcObjInput" class="fc-input" placeholder="Type to search objects…" autocomplete="off">
            <div id="fcObjDrop" class="fc-dropdown" style="display:none"></div>
          </div>
        </div>

        <!-- Step 2 (hidden until object selected) -->
        <div class="fc-step" id="fcFieldStep" style="display:none">
          <div class="fc-step-label">2 — Choose a custom field</div>
          <div class="fc-picker-wrap" id="fcFieldWrap">
            <input id="fcFieldInput" class="fc-input" placeholder="Type to search fields…" autocomplete="off">
            <div id="fcFieldDrop" class="fc-dropdown" style="display:none"></div>
          </div>
        </div>

        <!-- Selected pill -->
        <div id="fcPill" class="fc-pill-row" style="display:none"></div>

        <!-- Scan button -->
        <button id="fcScanBtn" class="btn btn-primary fc-scan-btn" style="display:none">
          🔍 Scan Dependencies
        </button>
        <!-- E3b: what the scan will spend, quoted before it runs -->
        <div id="fcApiCost" style="display:none;font-size:11px;color:var(--subtext);margin-top:4px;line-height:1.4"></div>

        <!-- Results area -->
        <div id="fcResults"></div>
        <div id="fcSnapLog"></div>

      </div>`;

    setupObjectPicker();

    // Close dropdowns on outside click
    document.addEventListener('click', e => {
      if (!e.target.closest('#fcObjWrap'))   closeDropdown('fcObjDrop');
      if (!e.target.closest('#fcFieldWrap')) closeDropdown('fcFieldDrop');
    }, true);
  }

  function closeDropdown(id) {
    const el = eid(id);
    if (el) el.style.display = 'none';
  }

  // ── Object picker ──────────────────────────────────────────
  function setupObjectPicker() {
    const input = eid('fcObjInput');
    const drop  = eid('fcObjDrop');
    if (!input || !drop) return;

    input.addEventListener('focus', async () => {
      if (!_objectsLoaded) {
        _objectsLoaded = true;
        drop.innerHTML = `<div class="fc-dd-loading">${sftkCatSm('Loading objects…')}</div>`;
        drop.style.display = '';
        // Phase 1 — ONE page, painted immediately. An org with fewer objects
        // than a page finishes here and is no slower than before the fix.
        const res = await bg({
          type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true,
          query: objectListSoql(FC_TOOLING_PAGE)
        });
        if (res.error) {
          _objectsLoaded = false;   // let a re-focus retry instead of dead-ending
          const fe = sftkFriendlyError(res.error);
          drop.innerHTML = `<div class="fc-dd-empty" title="${esc(fe.raw)}">${esc(fe.message + (fe.hint ? ' — ' + fe.hint : ''))}</div>`;
          drop.style.display = '';
          return;
        }
        _allObjects   = mapEntityRows(res.records);
        _objListCount = (res.records || []).length;
        // Exactly one full page means there is very likely more behind it.
        _objCapped    = fcLooksCapped(_objListCount, FC_TOOLING_PAGE);
        _objTopping   = _objCapped;
        renderObjDrop(input.value);
        if (_objTopping) topUpObjects();
      } else {
        renderObjDrop(input.value);
        drop.style.display = '';
      }
    });

    input.addEventListener('input', () => {
      if (_objectsLoaded) renderObjDrop(input.value);
      if (_selObj) resetFieldAndBelow();
    });
  }

  // IsCustomSetting is deliberately NOT filtered out: custom settings are real
  // sObjects with custom fields an admin may well want to clean, and hiding
  // them is the same "silently absent" failure this whole path exists to fix.
  // ORDER BY QualifiedApiName, not Label: Label is not unique, and a
  // non-unique sort key lets paging skip or repeat rows across pages. The
  // dropdown sorts by label client-side anyway (fcRankEntries).
  function objectListSoql(limit) {
    return 'SELECT QualifiedApiName, Label, DurableId FROM EntityDefinition ' +
           'WHERE IsDeprecatedAndHidden = false ' +
           `ORDER BY QualifiedApiName LIMIT ${limit}`;
  }

  function mapEntityRows(records) {
    return (records || [])
      .filter(r => r && r.QualifiedApiName)
      .map(r => ({
        api:       r.QualifiedApiName,
        label:     r.Label || r.QualifiedApiName,
        durableId: r.DurableId || r.QualifiedApiName
      }));
  }

  // Phase 2 — only runs when phase 1 came back full. SF_QUERY_ALL follows
  // nextRecordsUrl; if EntityDefinition refuses to paginate it hands back the
  // same single page, the count stays on the boundary, and _objCapped stays
  // true — which is exactly the honest answer, and why the server-side search
  // fallback below is not optional.
  async function topUpObjects() {
    const res = await bg({
      type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true,
      query: objectListSoql(FC_OBJ_LIMIT), _suppressError: true
    });
    _objTopping = false;
    if (!res.error) {
      _allObjects   = fcMergeEntries(_allObjects, mapEntityRows(res.records)).list;
      _objListCount = (res.records || []).length;
      _objCapped    = fcLooksCapped(_objListCount, FC_OBJ_LIMIT);
    }
    const drop = eid('fcObjDrop');
    if (drop && drop.style.display !== 'none') renderObjDrop(eid('fcObjInput')?.value);
  }

  function renderObjDrop(filter) {
    const drop = eid('fcObjDrop');
    if (!drop) return;
    // Hide Salesforce's shadow objects (<X>Feed / Share / History /
    // ChangeEvent, and rows whose label is an unresolved translation key)
    // unless the user asks for them — they have no cleanable custom fields
    // and used to fill the whole dropdown before a real object appeared.
    const part = fcPartitionObjects(_allObjects, _objShowSystem);
    // Ranked so exact/prefix hits float above contains-matches — otherwise
    // "Contact" is buried past position 60 by every "Account Contact Role …".
    const matches   = fcRankEntries(part.shown, filter);
    const rows      = matches.slice(0, 60);
    const searching = !!_objSearchInFlight || _objTopping;

    let html = rows.map(o =>
      `<div class="fc-dd-item"
            data-api="${esc(o.api)}"
            data-label="${esc(o.label)}"
            data-durable="${esc(o.durableId)}">
         <span class="fc-dd-main">${esc(o.label)}</span>
         <span class="fc-dd-sub">${esc(o.api)}</span>
       </div>`
    ).join('');

    if (!rows.length) {
      html = `<div class="fc-dd-empty">${searching
        ? esc('Searching the org…')
        : esc('No objects found' + (_objCapped
            ? ' — and the loaded list is incomplete, so this name may still exist'
            : ''))}</div>`;
    }

    const note = fcPickerSummary({
      shown: rows.length, matched: matches.length, total: _objListCount,
      capped: _objCapped, searching, noun: 'object',
      capHint: 'Type 2+ characters — anything missing is searched directly in the org.'
    });
    if (note) html += `<div style="${_DD_NOTE_CSS}">${esc(note)}</div>`;
    // Never hide silently: say how many and offer them.
    if (part.hidden > 0) {
      // A <button>, not an <a href="#">: the anchor only had a mousedown
      // handler, so Enter on the focused link did nothing (QA 2026-07-31).
      // A button fires click for mouse, Enter AND Space for free.
      html += `<div style="${_DD_NOTE_CSS}">${esc(`${part.hidden} system object(s) hidden — Feed, Share, History and Change Event objects have no custom fields to clean.`)}
        <button type="button" class="fc-dd-linkbtn" id="fcShowSysObjs">Show them</button></div>`;
    } else if (_objShowSystem) {
      html += `<div style="${_DD_NOTE_CSS}">Showing system objects.
        <button type="button" class="fc-dd-linkbtn" id="fcHideSysObjs">Hide them</button></div>`;
    }
    if (_objSearchErr) {
      html += `<div style="${_DD_NOTE_CSS}">⚠ ${esc('Org search unavailable: ' + _objSearchErr +
        ` — only the ${_allObjects.length} objects loaded above were checked.`)}</div>`;
    }

    const prevActive = drop.querySelector('.fc-dd-item.fc-dd-active')?.dataset.api || null;
    drop.innerHTML = html;
    fcRestoreActiveRow(drop, eid('fcObjInput'), prevActive);
    // mousedown, not click: the input's blur would close the dropdown first.
    const toggleSys = show => e => {
      e.preventDefault();
      _objShowSystem = show;
      renderObjDrop(eid('fcObjInput')?.value);
    };
    // mousedown keeps the mouse path working (the input's blur would close
    // the dropdown before a click landed); click covers Enter and Space.
    for (const [id, show] of [['#fcShowSysObjs', true], ['#fcHideSysObjs', false]]) {
      const b = drop.querySelector(id);
      if (!b) continue;
      b.addEventListener('mousedown', toggleSys(show));
      b.addEventListener('click', toggleSys(show));
    }
    const pickObj = item => {
      eid('fcObjInput').value = `${item.dataset.label} (${item.dataset.api})`;
      drop.style.display = 'none';
      eid('fcObjInput')?.setAttribute('aria-expanded', 'false');
      selectObject(item.dataset.api, item.dataset.label, item.dataset.durable);
    };
    drop.querySelectorAll('.fc-dd-item').forEach(item => {
      item.addEventListener('mousedown', e => { e.preventDefault(); pickObj(item); });
    });
    fcWireDropdownKeys(eid('fcObjInput'), drop, pickObj);
    drop.style.display = '';
    eid('fcObjInput')?.setAttribute('aria-expanded', 'true');

    maybeServerSearchObjects(filter, matches.length);
  }

  // ── Server-side object search (debounced, cancel-safe) ─────
  // The local list can be missing an object ENTIRELY, so a client-side filter
  // can never find it. Past 2 characters with a thin local result, ask the org
  // by name and merge the answer into _allObjects so selection still works.
  function maybeServerSearchObjects(filter, localMatchCount) {
    if (_objSearchTimer) { clearTimeout(_objSearchTimer); _objSearchTimer = null; }
    if (_objTopping) return;              // pagination may still close the gap
    const term = String(filter || '').trim();
    const key  = term.toLowerCase();
    if (!key || key === _objSearchInFlight || _objSearchTried.has(key)) return;
    if (!fcShouldServerSearch(term, localMatchCount, _objSearchDone)) return;
    _objSearchTimer = setTimeout(() => {
      _objSearchTimer = null;
      runObjectSearch(term);
    }, FC_SEARCH_DEBOUNCE_MS);
  }

  async function runObjectSearch(term) {
    const seq = ++_objSearchSeq;          // cancel token, taken before the await
    const key = term.toLowerCase();
    _objSearchInFlight = key;
    _objSearchErr      = null;
    const drop = eid('fcObjDrop');
    if (drop && drop.style.display !== 'none') renderObjDrop(eid('fcObjInput')?.value);

    // No _suppressError: a failure here is surfaced in the dropdown, so the
    // debug export should carry it as a real error row, not a quiet retry.
    const res = await bg({
      type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true,
      query: fcObjectSearchSoql(term, FC_SEARCH_LIMIT)
    });

    // A newer search superseded this one (or the picker was rebuilt): drop the
    // response. Rendering it would paint a list for a term the user replaced.
    if (seq !== _objSearchSeq) return;
    _objSearchInFlight = null;
    _objSearchTried.add(key);
    if (res.error) {
      _objSearchErr = sftkFriendlyError(res.error).message;
    } else {
      const rows  = mapEntityRows(res.records);
      _allObjects = fcMergeEntries(_allObjects, rows).list;
      // Only a search that did NOT cap out proves "everything containing this
      // term is now local" — the claim fcShouldServerSearch relies on.
      if (!fcLooksCapped(rows.length, FC_SEARCH_LIMIT)) _objSearchDone.add(key);
    }
    const d = eid('fcObjDrop');
    if (d && d.style.display !== 'none') renderObjDrop(eid('fcObjInput')?.value);
  }

  async function selectObject(api, label, durableId) {
    _selObj = { api, label, durableId: durableId || api };
    resetFieldAndBelow();
    // Clear the previous object's completeness state up front — a failed load
    // must not inherit the last object's "complete" claim.
    _allFields = []; _fieldsTotal = 0; _fieldsCapped = false;

    const step  = eid('fcFieldStep');
    const input = eid('fcFieldInput');
    const drop  = eid('fcFieldDrop');
    if (!step || !input || !drop) return;

    step.style.display = '';
    input.value = '';
    drop.innerHTML = `<div class="fc-dd-loading">${sftkCatSm('Loading fields…')}</div>`;
    drop.style.display = '';

    // SF_QUERY_ALL: a wide object in a package-heavy org approaches the field
    // cap, and the old single-page LIMIT 1000 dropped the tail silently.
    const res = await bg({
      type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true,
      query: `SELECT Id, QualifiedApiName, Label, DataType FROM FieldDefinition ` +
             `WHERE EntityDefinitionId = ${fcSoqlLit(api)} ORDER BY Label LIMIT ${FC_FIELD_LIMIT}`
    });

    if (res.error) {
      const fe = sftkFriendlyError(res.error);
      drop.innerHTML = `<div class="fc-dd-empty" title="${esc(fe.raw)}">Error loading fields: ${esc(fe.message + (fe.hint ? ' — ' + fe.hint : ''))}</div>`;
      return;
    }

    // Measure the cap on the RAW row count — the __c filter below is ours, not
    // Salesforce's, so filtering first would hide a real truncation. No object
    // can legally hold FC_FIELD_LIMIT fields, so with pagination this note is
    // a safety net that should never fire; if it does, it is telling the truth.
    _fieldsTotal  = (res.records || []).length;
    _fieldsCapped = fcLooksCapped(_fieldsTotal, FC_FIELD_LIMIT);

    _allFields = (res.records || [])
      // Namespaced package fields (ns__Foo__c) still end in __c — this filter
      // keeps them.
      .filter(r => r.QualifiedApiName && r.QualifiedApiName.endsWith('__c'))
      .map(r => ({
        durableId: r.Id,
        api:       r.QualifiedApiName,
        label:     r.Label,
        type:      r.DataType
      }));

    renderFieldDrop(input.value);

    // Re-wire each time (new object resets all listeners via new input ref)
    const newInput = eid('fcFieldInput');
    if (newInput) {
      newInput.addEventListener('input', () => renderFieldDrop(newInput.value));
      newInput.addEventListener('focus', () => {
        renderFieldDrop(newInput.value);
        const d = eid('fcFieldDrop');
        if (d) d.style.display = '';
      });
    }
  }

  function resetFieldAndBelow() {
    _selField = null;
    _groups   = {};
    const pill    = eid('fcPill');
    const scanBtn = eid('fcScanBtn');
    const results = eid('fcResults');
    const cost    = eid('fcApiCost');
    if (pill)    pill.style.display    = 'none';
    if (scanBtn) scanBtn.style.display = 'none';
    if (cost)    cost.style.display    = 'none';
    if (results) results.innerHTML     = '';
  }

  // ── Field picker ───────────────────────────────────────────
  function renderFieldDrop(filter) {
    const drop = eid('fcFieldDrop');
    if (!drop) return;
    const matches = fcRankEntries(_allFields, filter);
    const rows    = matches.slice(0, 80);

    let html = rows.map(f =>
      `<div class="fc-dd-item"
            data-durable="${esc(f.durableId)}"
            data-api="${esc(f.api)}"
            data-label="${esc(f.label)}"
            data-type="${esc(f.type)}">
         <span class="fc-dd-main">${esc(f.label)}</span>
         <span class="fc-dd-sub">${esc(f.api)}</span>
         <span class="fc-dd-type">${esc(f.type)}</span>
       </div>`
    ).join('');

    if (!rows.length) {
      html = `<div class="fc-dd-empty">${esc('No custom fields found' +
        (_fieldsCapped ? ' — and the field list is incomplete, see below' : ''))}</div>`;
    }

    // Cap total is the RAW FieldDefinition row count: that is the number
    // Salesforce actually stopped at, and the __c filter is ours, not its.
    const note = fcPickerSummary({
      shown: rows.length, matched: matches.length, total: _fieldsTotal,
      capped: _fieldsCapped, noun: 'field',
      capHint: 'Some custom fields on this object are not listed.'
    });
    if (note) html += `<div style="${_DD_NOTE_CSS}">${esc(note)}</div>`;

    // Assign once, THEN wire — reassigning innerHTML afterwards would discard
    // every listener attached above.
    const prevActive = drop.querySelector('.fc-dd-item.fc-dd-active')?.dataset.api || null;
    drop.innerHTML = html;
    fcRestoreActiveRow(drop, eid('fcFieldInput'), prevActive);
    const pickField = item => {
      eid('fcFieldInput').value = `${item.dataset.label} (${item.dataset.api})`;
      drop.style.display = 'none';
      eid('fcFieldInput')?.setAttribute('aria-expanded', 'false');
      selectField({
        durableId: item.dataset.durable,
        api:       item.dataset.api,
        label:     item.dataset.label,
        type:      item.dataset.type
      });
    };
    drop.querySelectorAll('.fc-dd-item').forEach(item => {
      item.addEventListener('mousedown', e => { e.preventDefault(); pickField(item); });
    });
    fcWireDropdownKeys(eid('fcFieldInput'), drop, pickField);
    drop.style.display = '';
    eid('fcFieldInput')?.setAttribute('aria-expanded', 'true');
  }

  function selectField(field) {
    _selField = field;

    const pill = eid('fcPill');
    if (pill) {
      pill.innerHTML = `
        <div class="fc-pill">
          <span class="fc-pill-obj">${esc(_selObj.api)}</span>
          <span class="fc-pill-dot">.</span>
          <span class="fc-pill-field">${esc(field.api)}</span>
          <span class="fc-pill-type">${esc(field.type)}</span>
        </div>`;
      pill.style.display = '';
    }

    const scanBtn = eid('fcScanBtn');
    if (scanBtn) {
      scanBtn.style.display = '';
      scanBtn.disabled      = false;
      scanBtn.textContent   = '🔍 Scan Dependencies';
      scanBtn.onclick       = runScan;
    }

    eid('fcResults').innerHTML = '';
    updateScanCostLine();
  }

  // E3b: quote the scan's API cost under the button, BEFORE it runs. The
  // local "≈N now, more if…" estimate needs nothing but arithmetic; the
  // org's daily-budget meter is appended only when the shared reader
  // (window.sftkApiBudget) is loaded in this page AND answers — the popup
  // does not load studio-transfer.js today, so tolerant wiring is the
  // difference between "estimate only" and a crash.
  let _fcBudgetSeq = 0;
  function updateScanCostLine() {
    const el = eid('fcApiCost');
    if (!el) return;
    // Pre-scan, all three fan-out legs are undiscovered — say so.
    const est = fcEstimateScanCalls(null);
    el.textContent   = fcScanBudgetLine(est, null).text;
    el.style.color   = '';
    el.style.display = '';
    if (typeof window.sftkApiBudget !== 'function') return;
    const seq = ++_fcBudgetSeq;
    let pending;
    try { pending = Promise.resolve(window.sftkApiBudget(_orgUrl, _sid)); }
    catch (_) { return; }                          // the meter is optional; the estimate already shows
    pending.then(budget => {
      if (seq !== _fcBudgetSeq) return;            // a newer render won
      const el2 = eid('fcApiCost');
      if (!el2) return;
      const line = fcScanBudgetLine(est, { label: 'this org', budget: budget || null });
      el2.textContent = line.text;
      el2.style.color = line.warn ? '#b45309' : '';
    }).catch(() => { /* the meter is optional; the estimate already shows */ });
  }

  // ── Scan ───────────────────────────────────────────────────
  async function runScan() {
    if (!_selObj || !_selField) return;

    const btn = eid('fcScanBtn');
    if (btn) { btn.disabled = true; btn.textContent = '🔍 Scanning…'; }

    eid('fcResults').innerHTML = sftkCat('Scanning dependencies…');

    try {
      // ── 1. Resolve CustomField tooling ID ─────────────────
      const fieldId = await resolveCustomFieldId();
      if (!fieldId) {
        showScanError(
          'Could not locate this field in the Tooling API. ' +
          'Verify the field API name and that you have Customize Application permission.'
        );
        return;
      }

      // ── 2. Query dependencies ─────────────────────────────
      const depRes = await bg({
        type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true,
        query: 'SELECT MetadataComponentId, MetadataComponentName, MetadataComponentType, ' +
               'RefMetadataComponentId, RefMetadataComponentName ' +
               `FROM MetadataComponentDependency WHERE RefMetadataComponentId = '${fieldId}'`
      });

      if (depRes.error) {
        const fe = sftkFriendlyError(depRes.error);
        showScanError(
          `Could not scan dependencies: ${fe.message}${fe.hint ? ' — ' + fe.hint : ''}. ` +
          'This requires API access and Customize Application permission.'
        );
        return;
      }

      const deps = depRes.records || [];

      // ── 3. Supplemental Lightning Page scan ───────────────
      // MetadataComponentDependency does NOT reliably return Lightning Page
      // (FlexipageFieldInstance) references — Salesforce's own "Where is this
      // used?" catches them via internal indexing the Tooling API doesn't
      // expose. Scan FlexiPages directly so fields placed on Lightning Pages
      // (incl. Dynamic Forms field sections) are never missed.
      const msgEl = eid('fcResults')?.querySelector('.lp-robot-msg');
      if (msgEl) msgEl.textContent = 'Scanning Lightning Pages…';
      let flexiHits = [];
      try {
        flexiHits = await scanFlexiPages(deps);
      } catch (e) {
        // Non-fatal — fall back to whatever MetadataComponentDependency found
        if (window.SFToolkitDebug?.enabled) {
          window.SFToolkitDebug.log('fields', 'error',
            'Supplemental FlexiPage scan failed', e.message);
        }
      }

      // ── 4. Supplemental silent-breakage scan ──────────────
      // List views, compact layouts, quick actions, matching rules, and
      // workflow field updates — none of which the dependency index tracks,
      // all of which break silently when the field disappears.
      let supHits = [];
      try {
        supHits = await scanSupplemental([...deps, ...flexiHits], fieldId);
      } catch (e) {
        if (window.SFToolkitDebug?.enabled) {
          window.SFToolkitDebug.log('fields', 'error',
            'Supplemental dependency scan failed', e.message);
        }
      }

      renderResults([...deps, ...flexiHits, ...supHits], fieldId);
    } catch (e) {
      const fe = sftkFriendlyError(e.message);
      showScanError(`Unexpected error: ${fe.message}${fe.hint ? ' — ' + fe.hint : ''}`);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔍 Re-scan'; }
    }
  }

  // ── Supplemental Lightning Page (FlexiPage) scan ───────────
  // Returns synthetic dependency records for any FlexiPage whose metadata
  // references the selected field — covering the FlexipageFieldInstance and
  // Dynamic-Forms cases that MetadataComponentDependency silently omits.
  async function scanFlexiPages(existingDeps) {
    const listRes = await bg({
      type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true,
      query: 'SELECT Id, DeveloperName, MasterLabel FROM FlexiPage'
    });
    if (listRes.error || !Array.isArray(listRes.records) || !listRes.records.length) {
      return [];
    }

    // FlexiPages MetadataComponentDependency already reported — skip re-fetching
    // and avoid duplicate rows (compare on the 15-char id prefix).
    const alreadyFound = new Set(
      (existingDeps || [])
        .filter(d => d.MetadataComponentType === 'FlexiPage')
        .map(d => String(d.MetadataComponentId || '').substring(0, 15))
    );

    const pages   = listRes.records;
    const hits    = [];
    const BATCH   = 5;
    const msgEl   = () => eid('fcResults')?.querySelector('.lp-robot-msg');

    for (let i = 0; i < pages.length; i += BATCH) {
      const slice   = pages.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        slice.map(p => bg({
          type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid,
          sobject: 'FlexiPage', id: p.Id
        }))
      );
      results.forEach((r, j) => {
        if (r.status !== 'fulfilled' || r.value?.error || !r.value?.Metadata) return;
        const page = slice[j];
        if (alreadyFound.has(String(page.Id || '').substring(0, 15))) return;
        if (flexiPageReferencesField(r.value.Metadata, _selObj.api, _selField.api)) {
          hits.push({
            MetadataComponentId:      page.Id,
            MetadataComponentName:    page.MasterLabel || page.DeveloperName,
            MetadataComponentType:    'FlexiPage',
            RefMetadataComponentId:   null,
            RefMetadataComponentName: _selField.api,
            _supplemental:            true
          });
        }
      });
      const el = msgEl();
      if (el) el.textContent =
        `Scanning Lightning Pages… ${Math.min(i + BATCH, pages.length)}/${pages.length}`;
    }
    return hits;
  }

  // ── Supplemental scans for silent-breakage types ───────────────────────
  // MetadataComponentDependency doesn't track these AT ALL, yet deleting a
  // field they use breaks them without warning: list views, compact layouts,
  // quick actions, matching rules, workflow field updates. All five are
  // cheap because they're scoped to the field's own object. Reports and
  // approval processes can't be scanned affordably — renderResults shows a
  // static "check manually" note for those.
  function _fieldTokenRe() {
    const fl = (_selField?.api || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-zA-Z0-9_])${fl}([^a-zA-Z0-9_]|$)`, 'i');
  }

  async function scanSupplemental(existingDeps, fieldId) {
    const hits = [];
    const seen = new Set((existingDeps || []).map(d =>
      `${d.MetadataComponentType}|${String(d.MetadataComponentId || '').substring(0, 15)}`));
    const add = (type, id, name) => {
      const key = `${type}|${String(id || '').substring(0, 15)}`;
      if (seen.has(key)) return;
      seen.add(key);
      hits.push({
        MetadataComponentId: id, MetadataComponentName: name,
        MetadataComponentType: type,
        RefMetadataComponentId: null, RefMetadataComponentName: _selField.api,
        _supplemental: true
      });
    };
    const msg = t => { const el = eid('fcResults')?.querySelector('.lp-robot-msg'); if (el) el.textContent = t; };
    const re      = _fieldTokenRe();
    const obj     = _selObj.api;
    const fieldLc = _selField.api.toLowerCase();

    // 1. List views — describe gives the view's SOQL + columns.
    try {
      msg('Scanning list views…');
      const lvRes = await bg({ type: 'SF_REST_GET', orgUrl: _orgUrl, sid: _sid,
        path: `services/data/v62.0/sobjects/${obj}/listviews` });
      const lvs = lvRes?.listviews || [];
      const BATCH = 5;
      for (let i = 0; i < lvs.length; i += BATCH) {
        const slice = lvs.slice(i, i + BATCH);
        const rs = await Promise.allSettled(slice.map(lv => bg({
          type: 'SF_REST_GET', orgUrl: _orgUrl, sid: _sid,
          path: `services/data/v62.0/sobjects/${obj}/listviews/${lv.id}/describe`
        })));
        rs.forEach((r, j) => {
          if (r.status !== 'fulfilled' || r.value?.error) return;
          const d = r.value, lv = slice[j];
          const inQuery = typeof d.query === 'string' && re.test(d.query);
          const inCols  = (d.columns || []).some(c =>
            String(c.fieldNameOrPath || '').toLowerCase() === fieldLc);
          if (inQuery || inCols) add('ListView', lv.id, lv.label || lv.developerName || lv.id);
        });
        msg(`Scanning list views… ${Math.min(i + BATCH, lvs.length)}/${lvs.length}`);
      }
    } catch (_) {/* non-fatal */}

    // 2. Compact layouts — field items are listed right in the describe.
    try {
      msg('Scanning compact layouts…');
      const clRes = await bg({ type: 'SF_REST_GET', orgUrl: _orgUrl, sid: _sid,
        path: `services/data/v62.0/sobjects/${obj}/describe/compactLayouts` });
      for (const cl of (clRes?.compactLayouts || [])) {
        const vals = (cl.fieldItems || []).flatMap(fi =>
          (fi.layoutComponents || []).map(c => String(c.value || '').toLowerCase()));
        if (vals.includes(fieldLc)) add('CompactLayout', cl.id || cl.name, cl.label || cl.name);
      }
    } catch (_) {/* non-fatal */}

    // 3. Quick actions — each action's mini-layout can place the field.
    // The /quickActions list returns EVERY action available on the object,
    // including standard global ones (LogACall, NewContact, FeedItem.*,
    // SendEmail…) whose per-action describe 404s at the object scope — that
    // was flooding the log with red 404s. Only Create/Update actions own a
    // field layout, and only object-scoped custom ones can hold THIS object's
    // custom field, so filter to those; suppress errors on the rest.
    try {
      msg('Scanning quick actions…');
      const qaRes = await bg({ type: 'SF_REST_GET', orgUrl: _orgUrl, sid: _sid,
        path: `services/data/v62.0/sobjects/${obj}/quickActions` });
      const qas = (Array.isArray(qaRes) ? qaRes : []).filter(qa => {
        const t = (qa.type || '').toLowerCase();
        // Skip global/chatter actions (name has a '.') and non-layout types.
        if (String(qa.name || '').includes('.')) return false;
        return t === 'create' || t === 'update';
      });
      const BATCH = 5;
      for (let i = 0; i < qas.length; i += BATCH) {
        const slice = qas.slice(i, i + BATCH);
        const rs = await Promise.allSettled(slice.map(qa => bg({
          // _silentError: standard actions (NewCase, NewContact…) pass the
          // type filter but 404 on object-scoped describe — expected, carries
          // no information, logged as nothing instead of 22 Retry rows.
          type: 'SF_REST_GET', orgUrl: _orgUrl, sid: _sid, _silentError: true,
          path: `services/data/v62.0/sobjects/${obj}/quickActions/${encodeURIComponent(qa.name)}/describe`
        })));
        rs.forEach((r, j) => {
          if (r.status !== 'fulfilled' || r.value?.error) return;
          const d = r.value, qa = slice[j];
          // The action layout + default values serialize the field api name —
          // a token-boundary search over the JSON catches every placement.
          let blob = '';
          try { blob = JSON.stringify({ l: d.layout, dv: d.defaultValues }); } catch (_) {}
          if (blob && re.test(blob)) add('QuickAction', qa.name, qa.label || qa.name);
        });
      }
    } catch (_) {/* non-fatal */}

    // 4. Matching rules — MatchingRule/MatchingRuleItem are STANDARD data
    // objects, not Tooling (the Tooling query 400'd "sObject type
    // 'MatchingRule' is not supported"). One join query gets every rule
    // item's Field for this object; Field comes back like "Contact.Email".
    try {
      msg('Scanning matching rules…');
      const mriRes = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
        query: `SELECT Id, Field, MatchingRuleId, MatchingRule.DeveloperName, MatchingRule.MasterLabel ` +
               `FROM MatchingRuleItem WHERE MatchingRule.SobjectType = '${obj}'` });
      if (!mriRes?.error) {
        for (const it of (mriRes?.records || [])) {
          const f = String(it.Field || '').toLowerCase();
          if (f === fieldLc || f.endsWith('.' + fieldLc)) {
            add('MatchingRule', it.MatchingRuleId,
                it.MatchingRule?.MasterLabel || it.MatchingRule?.DeveloperName || it.MatchingRuleId);
          }
        }
      }
    } catch (_) {/* non-fatal */}

    // 5. Workflow field updates — FieldDefinitionId carries the field's id.
    try {
      msg('Scanning workflow field updates…');
      const id15 = String(fieldId || '').substring(0, 15);
      const wfRes = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true,
        query: `SELECT Id, Name, FieldDefinitionId FROM WorkflowFieldUpdate WHERE SourceTableEnumOrId = '${obj}'` });
      for (const fu of (wfRes?.records || [])) {
        const fd = String(fu.FieldDefinitionId || '');
        if (id15 && fd.includes(id15)) add('WorkflowFieldUpdate', fu.Id, fu.Name);
        else if (fd.toLowerCase().endsWith('.' + fieldLc)) add('WorkflowFieldUpdate', fu.Id, fu.Name);
      }
    } catch (_) {/* non-fatal */}

    return hits;
  }

  // Recursively walk a FlexiPage Metadata object looking for a reference to
  // the given field. Covers every known binding pattern:
  //   • Dynamic Forms field instances        — fieldItem: "Record.My_Field__c"
  //   • classic field components             — componentInstanceProperties
  //                                             { name:'fieldApiName', value:'…' }
  //   • component visibility rule criteria    — leftValue / rightValue(.value)
  //   • component filters / list-view filters — field ref buried inside a
  //                                             property value or JSON blob
  function flexiPageReferencesField(metadata, objApi, fieldApi) {
    const fl  = String(fieldApi || '').toLowerCase();
    const obj = String(objApi  || '').toLowerCase();
    if (!fl) return false;

    // Exact-ish merge-field match (precise — safe for any field, std or custom)
    function isRef(str) {
      if (str == null) return false;
      const s = String(str).toLowerCase()
        .replace(/^\{!/, '').replace(/\}$/, '').trim();
      return (
        s === fl ||
        s === `${obj}.${fl}` ||
        s === `record.${fl}` ||
        s === `objectrecord.${fl}` ||
        s === `$record.${fl}` ||
        s.endsWith(`.${fl}`)
      );
    }

    // Deep token match — catches a field ref buried *inside* a larger string
    // (filter JSON blobs, criteria expressions, merge text…). Only enabled for
    // custom fields, whose __c / __r-style API names are distinctive enough to
    // never false-match; standard short names rely on the precise checks above.
    const deepScan = fl.includes('__');
    const flEsc    = fl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tokenRe  = new RegExp(`(^|[^a-z0-9_])${flEsc}([^a-z0-9_]|$)`, 'i');

    let found = false;
    (function walk(node) {
      if (found || node == null) return;
      if (typeof node === 'string') {
        if (deepScan && tokenRe.test(node)) found = true;
        return;
      }
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node !== 'object') return;

      // ── Precise structured checks (any field) ──
      // Dynamic Forms field instance
      if (isRef(node.fieldItem)) { found = true; return; }
      // classic field component property
      if (['fieldApiName', 'field', 'fieldName'].includes(node.name) && isRef(node.value)) {
        found = true; return;
      }
      // visibility rule / filter criteria
      if (('leftValue' in node || 'rightValue' in node) &&
          (isRef(node.leftValue) ||
           isRef(node.rightValue) ||
           isRef(node.rightValue?.value))) {
        found = true; return;
      }

      // ── Deep fallback — walk every value incl. nested strings ──
      for (const k in node) walk(node[k]);
    })(metadata);

    return found;
  }

  // Derive DeveloperName from QualifiedApiName (strips __c / __r suffix)
  function deriveDevName(qualifiedApiName) {
    return (qualifiedApiName || '').replace(/__c$/i, '').replace(/__r$/i, '');
  }

  // Look up the 15-char CustomField.Id needed for MetadataComponentDependency
  async function resolveCustomFieldId() {
    const devName = deriveDevName(_selField.api);

    // Attempt 1: use EntityDefinition.DurableId as TableEnumOrId (works for both standard + custom)
    const res1 = await bg({
      type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true,
      query: `SELECT Id FROM CustomField WHERE DeveloperName = '${devName}' ` +
             `AND TableEnumOrId = '${_selObj.durableId}'`
    });
    if (!res1.error && res1.records?.length) return res1.records[0].Id;

    // Attempt 2: try with QualifiedApiName (fallback for standard objects)
    if (_selObj.durableId !== _selObj.api) {
      const res2 = await bg({
        type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true,
        query: `SELECT Id FROM CustomField WHERE DeveloperName = '${devName}' ` +
               `AND TableEnumOrId = '${_selObj.api}'`
      });
      if (!res2.error && res2.records?.length) return res2.records[0].Id;
    }

    // Attempt 3: try stripping namespace from devName (e.g. ns__My_Field → My_Field)
    if (devName.includes('__')) {
      const shortName = devName.split('__').pop();
      const res3 = await bg({
        type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true,
        query: `SELECT Id FROM CustomField WHERE DeveloperName = '${shortName}' ` +
               `AND TableEnumOrId = '${_selObj.durableId}'`
      });
      if (!res3.error && res3.records?.length) return res3.records[0].Id;
    }

    return null;
  }

  function showScanError(msg) {
    eid('fcResults').innerHTML =
      `<div class="fc-error-msg"><span>❌</span> ${esc(msg)}</div>`;
  }

  // ── Render results ─────────────────────────────────────────
  // sev (F2 — predictive blocker check): does this dependency actually stop
  // Salesforce from deleting the field, or just break silently afterwards?
  //   'blocker' — Salesforce REJECTS the delete until this reference is gone
  //               (Apex, validation/workflow rules, matching rules, active flows)
  //   'silent'  — delete succeeds; the reference just stops working / vanishes
  //               (layouts, list views, quick actions — cosmetic breakage)
  const TYPE_CFG = {
    Flow:           { icon: '🌊', label: 'Flows',            fixable: true, sev: 'blocker',
                      note: 'A new version is saved with the field reference removed AND activated automatically. Old versions that still reference the field are deleted too — Salesforce keeps the dependency lock per version, so stale versions would otherwise still block the field delete.',
                      doneLabel: '✅ Activated' },
    FlexiPage:      { icon: '📄', label: 'Lightning Pages',  fixable: true, sev: 'silent',
                      note: 'Field references in visibility rules and field components will be removed automatically.',
                      doneLabel: '✅ Page updated' },
    Layout:         { icon: '📋', label: 'Page Layouts',     fixable: true, sev: 'silent',
                      note: 'The field will be removed from all layout sections automatically.',
                      doneLabel: '✅ Layout updated' },
    ListView:       { icon: '📊', label: 'List Views',       fixable: false, sev: 'silent',
                      note: 'Open the object\'s list view and remove the column or filter.' },
    CompactLayout:  { icon: '📇', label: 'Compact Layouts',  fixable: false, sev: 'silent',
                      note: 'Edit the compact layout in Object Manager and remove the field.' },
    QuickAction:    { icon: '⚡', label: 'Quick Actions',    fixable: false, sev: 'silent',
                      note: 'Edit the quick action\'s layout (Object Manager → Buttons, Links, and Actions) and remove the field.' },
    MatchingRule:   { icon: '🧬', label: 'Matching Rules',   fixable: false, sev: 'blocker',
                      note: 'Deactivate the matching rule, remove the field from its criteria, then reactivate (Setup → Duplicate Management → Matching Rules).' },
    WorkflowFieldUpdate: { icon: '🛠', label: 'Workflow Field Updates', fixable: false, sev: 'blocker',
                      note: 'Edit or delete the field update (Setup → Workflow Actions → Field Updates).' },
    ValidationRule: { icon: '✅', label: 'Validation Rules', fixable: false, sev: 'blocker',
                      note: 'Edit the validation rule formula in Object Manager.' },
    ApexClass:      { icon: '☕', label: 'Apex Classes',     fixable: false, sev: 'blocker',
                      note: 'Update the Apex code to remove the field reference.' },
    ApexTrigger:    { icon: '⚡', label: 'Apex Triggers',    fixable: false, sev: 'blocker',
                      note: 'Update the Apex trigger to remove the field reference.' },
    WorkflowRule:   { icon: '🔁', label: 'Workflow Rules',   fixable: false, sev: 'blocker',
                      note: 'Edit or deactivate the workflow rule in Setup.' },
  };
  const TYPE_CFG_DEFAULT = { icon: '🔧', label: 'Other', fixable: false, sev: 'blocker',
    note: 'Review this dependency in Setup before deleting the field.' };

  // F2: unresolved manual blockers (types the extension can't auto-fix that
  // will make Salesforce reject the delete). Read by checkEnableDelete.
  let _manualBlockers = [];

  // F8: honest disclosure of what the scan does NOT cover — the Tooling
  // dependency index doesn't track these, so silent breakage hides here.
  function _unscannedNoteHtml() {
    const reportsUrl = _orgUrl
      ? _orgUrl.replace(/\/$/, '') + '/lightning/o/Report/home'
      : null;
    return `
      <div class="fc-unscanned-note">
        ℹ️ <strong>Not scanned</strong> (no affordable API): Reports, Email Templates,
        approval processes, and criteria-based sharing rules — these break silently if
        the field is removed. Check them before deleting.
        ${reportsUrl ? `<a class="fc-unscanned-link" href="${esc(reportsUrl)}" target="_blank" rel="noopener">↗ Open Reports</a>` : ''}
      </div>`;
  }

  function renderResults(deps, fieldId) {
    const results = eid('fcResults');
    if (!results) return;

    if (!deps.length) {
      results.innerHTML = `
        <div class="fc-clean">
          <div class="fc-clean-icon">✅</div>
          <div class="fc-clean-title">No dependencies found</div>
          <div class="fc-clean-sub">This field can be safely deleted.</div>
          <button class="btn btn-danger" id="fcDelFreeBtn">🗑 Delete Field</button>
        </div>
        <div id="fcDataVerdict" class="fc-data-verdict fc-data-loading">${sftkCatSm('Measuring how much data is stored in this field…')}</div>
        <div id="fcDepZone"></div>
        <div id="fcFlsPanel"></div>
        ${_unscannedNoteHtml()}`;
      eid('fcDelFreeBtn').onclick = () => confirmDelete(fieldId);
      runDataUsage();
      renderDeprecationZone(fieldId);
      renderFlsPanel();
      return;
    }

    // Group
    _groups = {};
    for (const d of deps) {
      const t = d.MetadataComponentType || 'Unknown';
      if (!_groups[t]) _groups[t] = [];
      _groups[t].push(d);
    }

    const autoCount   = Object.entries(_groups)
      .filter(([t]) => (TYPE_CFG[t] || TYPE_CFG_DEFAULT).fixable)
      .reduce((n, [,arr]) => n + arr.length, 0);
    const manualCount = deps.length - autoCount;

    let html = `
      <div class="fc-results-hdr">
        <strong>${deps.length}</strong> dependenc${deps.length === 1 ? 'y' : 'ies'} on
        <code>${esc(_selObj.api)}.${esc(_selField.api)}</code>
        <span class="fc-badge-row">
          ${autoCount   > 0 ? `<span class="fc-badge-auto">${autoCount} auto-fixable</span>`  : ''}
          ${manualCount > 0 ? `<span class="fc-badge-manual">${manualCount} manual</span>` : ''}
        </span>
      </div>
      <div id="fcDataVerdict" class="fc-data-verdict fc-data-loading">${sftkCatSm('Measuring how much data is stored in this field…')}</div>
      <div id="fcDepZone"></div>
      <div id="fcFlsPanel"></div>
      ${_unscannedNoteHtml()}`;

    for (const [type, items] of Object.entries(_groups)) {
      const cfg = TYPE_CFG[type] || { ...TYPE_CFG_DEFAULT, label: type };
      html += `
        <div class="fc-group" id="fcGroup_${esc(type)}">
          <div class="fc-group-hdr">
            <span class="fc-group-icon">${cfg.icon}</span>
            <span class="fc-group-label">${esc(cfg.label)}</span>
            <span class="fc-group-count">${items.length}</span>
          </div>
          <div class="fc-group-note">${esc(cfg.note)}${
            // C5a: the toolkit's own tools manage exactly these components —
            // offer a jump instead of dead-ending into Setup.
            type === 'Flow'
              ? xlinkHtml('flows', '↗ Open in Flows',
                  "Manage these flows' versions — delete stale ones, backup, restore — in the Flows tool")
              : type === 'FlexiPage'
                ? xlinkHtml('pages', '↗ Open in Lightning Pages',
                    'Inspect assignments, org defaults, and profile overrides for these pages in the Lightning Pages tool')
                : ''}</div>
          <div class="fc-group-items">
            ${items.map(d => renderItem(d, cfg.fixable, type)).join('')}
          </div>
          ${cfg.fixable && items.length > 1
            ? `<button class="btn btn-secondary btn-sm fc-fix-all"
                        data-type="${esc(type)}"
                        style="margin:2px 0 8px 0">
                 ✂ Remove from all ${items.length} ${esc(cfg.label)}
               </button>`
            : ''}
        </div>`;
    }

    // ── F2: predictive blocker check ─────────────────────────────────────
    // Classify by whether Salesforce will actually REJECT the delete. Manual
    // blockers (Apex, validation/workflow/matching rules) can't be auto-fixed
    // here — Salesforce would 400 the delete — so gate the button on them up
    // front instead of letting the attempt fail server-side.
    _manualBlockers = Object.entries(_groups)
      .filter(([t]) => {
        const cfg = TYPE_CFG[t] || TYPE_CFG_DEFAULT;
        return cfg.sev === 'blocker' && !cfg.fixable;
      })
      .map(([t, arr]) => ({ type: t, label: (TYPE_CFG[t] || { label: t }).label, count: arr.length }));
    const blockerTotal = _manualBlockers.reduce((n, b) => n + b.count, 0);
    const silentManual = Object.entries(_groups)
      .filter(([t]) => { const c = TYPE_CFG[t] || TYPE_CFG_DEFAULT; return c.sev === 'silent' && !c.fixable; })
      .reduce((n, [, arr]) => n + arr.length, 0);
    const delDisabled = autoCount > 0 || blockerTotal > 0;

    const blockerBlock = blockerTotal > 0 ? `
      <div class="fc-blockers">
        <div class="fc-blockers-hdr">🔒 ${blockerTotal} blocker${blockerTotal === 1 ? '' : 's'} — Salesforce will refuse the delete until ${blockerTotal === 1 ? 'this is' : 'these are'} cleared:</div>
        ${_manualBlockers.map(b => `<div class="fc-blocker-row">${(TYPE_CFG[b.type] || {}).icon || '🔧'} <strong>${b.count}</strong> ${esc(b.label)} — clear in Setup, then re-scan</div>`).join('')}
      </div>` : '';
    const silentNote = silentManual > 0 ? `
      <div class="fc-silent-note">⚠ ${silentManual} cosmetic reference${silentManual === 1 ? '' : 's'} (list views, quick actions…) won't block the delete but will stop working afterwards.</div>` : '';

    html += `
      <div class="fc-delete-zone" id="fcDeleteZone">
        ${blockerBlock}
        ${silentNote}
        <div class="fc-delete-note" id="fcDeleteNote">
          ${autoCount > 0
            ? '⚠ Fix all auto-fixable dependencies above first.'
            : blockerTotal > 0
              ? '🔒 Delete is blocked until the blockers above are cleared.'
              : silentManual > 0
                ? '✅ No blockers — safe to delete (the cosmetic references above will simply vanish).'
                : '✅ Safe to delete.'}
        </div>
        <button class="btn btn-danger" id="fcDelBtn" ${delDisabled ? 'disabled' : ''}>
          🗑 Delete Field
        </button>
      </div>`;

    results.innerHTML = html;

    // Wire buttons
    results.querySelectorAll('.fc-fix-btn').forEach(btn => {
      btn.addEventListener('click', () =>
        fixOne(btn.dataset.type, btn.dataset.id, btn.dataset.name, fieldId));
    });
    results.querySelectorAll('.fc-setup-btn').forEach(btn => {
      btn.addEventListener('click', () => openSetup(btn.dataset.type));
    });
    results.querySelectorAll('.fc-fix-all').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.type;
        fixAll(t, _groups[t] || [], fieldId);
        btn.remove();
      });
    });

    // Wire XML inspect buttons
    results.querySelectorAll('.fc-inspect-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const dep  = [].concat(...Object.values(_groups))
                       .find(d => d.MetadataComponentId === btn.dataset.id);
        const name = dep?.MetadataComponentName || btn.dataset.id;
        toggleXmlInspector(btn.dataset.type, btn.dataset.id, name, fieldId);
      });
    });

    const delBtn = eid('fcDelBtn');
    if (delBtn) delBtn.onclick = () => confirmDelete(fieldId);

    runDataUsage();              // F1: fill the verdict placeholder asynchronously
    renderDeprecationZone(fieldId);  // F3: stage banner / deprecate button
    renderFlsPanel();            // F5: who can see this field
  }

  // ── F5: FLS visibility panel — who can even see this field? ─────────────
  // One FieldPermissions query lists every profile / permission set granting
  // read or edit. Per-row ✂ strips that grant (PermissionsRead/Edit → false).
  async function _queryFls() {
    const res = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
      query: `SELECT Id, Parent.Label, Parent.IsOwnedByProfile, Parent.Profile.Name, ` +
             `PermissionsRead, PermissionsEdit FROM FieldPermissions ` +
             `WHERE SobjectType = '${_selObj.api}' AND Field = '${_selObj.api}.${_selField.api}'` });
    if (res.error) return { error: res.error };
    return { rows: res.records || [] };
  }

  async function renderFlsPanel() {
    const el = eid('fcFlsPanel');
    if (!el || !_selObj?.api || !_selField?.api) return;
    el.innerHTML = sftkCatSm('Checking who can see this field…');
    const { rows, error } = await _queryFls();
    if (error) {
      const fe = sftkFriendlyError(error);
      el.innerHTML = `<div class="fc-unscanned-note" title="${esc(fe.raw)}">👁 FLS check unavailable: ${esc(fe.message + (fe.hint ? ' — ' + fe.hint : ''))}</div>`;
      return;
    }
    if (!rows.length) {
      el.innerHTML = `<div class="fc-fls-empty">👁 <strong>No profile or permission set grants access</strong> to this field — nobody can see it today.</div>`;
      return;
    }
    el.innerHTML = `
      <details class="fc-fls">
        <summary>👁 Visible to <strong>${rows.length}</strong> profile${rows.length === 1 ? '' : 's'}/permission set${rows.length === 1 ? '' : 's'}</summary>
        <div class="fc-fls-rows">
          ${rows.map(r => {
            const name = r.Parent?.IsOwnedByProfile ? (r.Parent?.Profile?.Name || r.Parent?.Label) : r.Parent?.Label;
            const kind = r.Parent?.IsOwnedByProfile ? 'Profile' : 'Perm set';
            return `<div class="fc-fls-row" data-fls-id="${esc(r.Id)}">
              <span class="fc-fls-kind">${kind}</span>
              <span class="fc-fls-name">${esc(name || r.Id)}</span>
              <span class="fc-fls-perm">${r.PermissionsEdit ? 'read + edit' : 'read'}</span>
              <button class="btn btn-sm fc-fls-strip" data-fls-id="${esc(r.Id)}" title="Remove this grant — the field disappears for these users">✂ Strip</button>
            </div>`;
          }).join('')}
        </div>
        <div class="fc-fls-foot" style="padding:4px 0 2px">
          ${xlinkHtml('copy-perms', '↗ Open in Copy Permissions',
            'Inspect or migrate these profile / permission-set assignments in the Copy Permissions tool before stripping visibility')}
        </div>
      </details>`;
    el.querySelectorAll('.fc-fls-strip').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = '⏳';
        const res = await bg({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: _orgUrl, sid: _sid,
          records: [{ attributes: { type: 'FieldPermissions' }, Id: btn.dataset.flsId,
                      PermissionsRead: false, PermissionsEdit: false }] });
        const ok = Array.isArray(res) ? res[0]?.success : !res.error;
        if (ok) {
          const row = btn.closest('.fc-fls-row');
          if (row) { row.classList.add('fc-fls-stripped'); btn.replaceWith(Object.assign(document.createElement('span'), { textContent: '✅ stripped', className: 'fc-fls-done' })); }
        } else {
          btn.disabled = false; btn.textContent = '❌ retry';
        }
      });
    });
  }

  // ── F3: staged deprecation — rename + strip FLS now, delete later ───────
  // The careful-admin dance as one button: label → "zz_DEPRECATED …" (+ a
  // description stamp), read access stripped everywhere, stage + undo
  // snapshot recorded in extension storage. LABEL only — the API name never
  // changes (renaming it breaks integrations).
  function _depKey() {
    return `fc_dep|${sftkOrgKey(_orgUrl)}|${_selObj.api}.${_selField.api}`;
  }

  async function renderDeprecationZone(fieldId) {
    const el = eid('fcDepZone');
    if (!el || !_selObj?.api || !_selField?.api) return;
    const store = await chrome.storage.local.get(_depKey());
    const dep = store[_depKey()];
    if (dep) {
      const days = Math.floor((Date.now() - dep.at) / 86400000);
      el.innerHTML = `
        <div class="fc-dep-banner">
          🕐 <strong>Deprecated ${days === 0 ? 'today' : days + ' day(s) ago'}</strong> —
          label renamed and ${dep.fls.length} access grant(s) stripped. No complaints so far?
          It's safe to delete. Changed your mind?
          <button class="btn btn-sm" id="fcDepUndo">↩ Undo deprecation</button>
        </div>`;
      eid('fcDepUndo')?.addEventListener('click', e => undoDeprecation(e.currentTarget));
    } else {
      el.innerHTML = `
        <div class="fc-dep-offer">
          🕐 Not sure it's unused? <button class="btn btn-secondary btn-sm" id="fcDepBtn">Deprecate first</button>
          <span class="fc-dep-hint">renames the label to <code>zz_DEPRECATED…</code> and hides the field from everyone —
          wait for complaints, then delete (or undo) with one click.</span>
        </div>`;
      eid('fcDepBtn')?.addEventListener('click', e => deprecateField(fieldId, e.currentTarget));
    }
  }

  async function deprecateField(fieldId, btn) {
    if (!fieldId) return;
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Deprecating…'; }
    try {
      // 1. Current metadata (Tooling PATCH needs the full Metadata blob back).
      const cur = await bg({ type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid,
        sobject: 'CustomField', id: fieldId });
      if (cur.error || !cur.Metadata) throw new Error(cur.error || 'Could not read field metadata');
      const prevLabel = cur.Metadata.label;
      const prevDesc  = cur.Metadata.description || '';

      // 2. Rename label + stamp description.
      const md = { ...cur.Metadata };
      if (!/^zz_DEPRECATED/i.test(md.label || '')) md.label = `zz_DEPRECATED ${md.label || _selField.api}`;
      md.description = `[DEPRECATED ${new Date().toISOString().slice(0, 10)} by Salesforce Toolkit — pending delete] ${prevDesc}`.slice(0, 1000);
      const patch = await bg({ type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid,
        path: `services/data/v62.0/tooling/sobjects/CustomField/${fieldId}`,
        body: { Metadata: md } });
      if (patch?.error) throw new Error(patch.error);

      // 3. Strip FLS everywhere (snapshot first for undo).
      const { rows, error } = await _queryFls();
      if (error) throw new Error('FLS query failed: ' + error);
      const flsSnapshot = rows.map(r => ({ id: r.Id, read: !!r.PermissionsRead, edit: !!r.PermissionsEdit }));
      if (rows.length) {
        const res = await bg({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: _orgUrl, sid: _sid,
          records: rows.map(r => ({ attributes: { type: 'FieldPermissions' }, Id: r.Id,
                                    PermissionsRead: false, PermissionsEdit: false })) });
        const fails = (Array.isArray(res) ? res : []).filter(x => !x.success).length;
        if (fails) throw new Error(`${fails} FLS strip(s) failed — field renamed but still partially visible`);
      }

      // 4. Record the stage + undo snapshot.
      await chrome.storage.local.set({ [_depKey()]: {
        at: Date.now(), fieldId, prevLabel, prevDesc, fls: flsSnapshot } });
      renderDeprecationZone(fieldId);
      renderFlsPanel();
    } catch (e) {
      if (btn) {
        btn.disabled = false; btn.textContent = 'Deprecate first';
        _friendlyErrorUnder(btn, e.message || e);
      }
    }
  }

  async function undoDeprecation(btn) {
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Restoring…'; }
    try {
      const key = _depKey();
      const store = await chrome.storage.local.get(key);
      const dep = store[key];
      if (!dep) throw new Error('No deprecation record found');

      // 1. Restore label + description.
      const cur = await bg({ type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid,
        sobject: 'CustomField', id: dep.fieldId });
      if (cur.error || !cur.Metadata) throw new Error(cur.error || 'Could not read field metadata');
      const md = { ...cur.Metadata, label: dep.prevLabel, description: dep.prevDesc || null };
      const patch = await bg({ type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid,
        path: `services/data/v62.0/tooling/sobjects/CustomField/${dep.fieldId}`,
        body: { Metadata: md } });
      if (patch?.error) throw new Error(patch.error);

      // 2. Restore the FLS grants from the snapshot.
      if (dep.fls.length) {
        await bg({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: _orgUrl, sid: _sid,
          records: dep.fls.map(f => ({ attributes: { type: 'FieldPermissions' }, Id: f.id,
                                       PermissionsRead: f.read, PermissionsEdit: f.edit })) });
      }
      await chrome.storage.local.remove(key);
      renderDeprecationZone(dep.fieldId);
      renderFlsPanel();
    } catch (e) {
      if (btn) {
        btn.disabled = false; btn.textContent = '↩ Undo deprecation';
        _friendlyErrorUnder(btn, e.message || e);
      }
    }
  }

  // ── F1: data-usage verdict — "is anything actually stored here?" ─────────
  // The dependency scan proves nothing REFERENCES the field; this proves
  // whether it holds data. One aggregate query gives total + non-null counts;
  // a second gives the last time a value was written. Formula/derived fields
  // (nothing stored) and aggregate-unsupported fields degrade to an honest
  // "N/A". Huge objects that time out fall back to a LIMIT sample.
  let _dataVerdict = null;   // { fillPct, filled, total, lastIso, formula, sampled } | null
  async function runDataUsage() {
    _dataVerdict = null;
    const el = () => eid('fcDataVerdict');
    if (!el() || !_selObj?.api || !_selField?.api) return;
    const obj = _selObj.api, fld = _selField.api;

    // Formula / roll-up / auto-number fields never "store" editable data.
    if (/formula|roll-?up|summary|auto\s*number/i.test(_selField.type || '')) {
      _dataVerdict = { formula: true };
      _renderDataVerdict();
      return;
    }

    const agg = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: false,
      query: `SELECT COUNT(Id) tot, COUNT(${fld}) filled FROM ${obj}` });

    if (agg.error) {
      // Aggregation not supported (formula/encrypted/long-text) or timeout →
      // sample fallback: read a slice and estimate the fill rate.
      if (/aggregate|group by|not supported|COUNT|encrypted/i.test(agg.error)) {
        return _sampleDataUsage(obj, fld);
      }
      if (/timeout|time limit|too many/i.test(agg.error)) {
        return _sampleDataUsage(obj, fld);
      }
      const fe = sftkFriendlyError(agg.error);
      const e = el(); if (e) { e.className = 'fc-data-verdict'; e.title = fe.raw; e.textContent = `📊 Couldn't measure field usage: ${fe.message}${fe.hint ? ' — ' + fe.hint : ''}`; }
      return;
    }

    const rec    = (agg.records || [])[0] || {};
    const total  = Number(rec.tot)    || 0;
    const filled = Number(rec.filled) || 0;
    let lastIso = null;
    if (filled > 0) {
      const mx = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: false,
        query: `SELECT MAX(LastModifiedDate) m FROM ${obj} WHERE ${fld} != null` });
      lastIso = (mx.records || [])[0]?.m || null;
    }
    _dataVerdict = {
      filled, total, lastIso, sampled: false,
      fillPct: total > 0 ? (filled / total * 100) : 0,
    };
    _renderDataVerdict();
  }

  async function _sampleDataUsage(obj, fld) {
    const el = eid('fcDataVerdict');
    const q = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
      query: `SELECT ${fld} FROM ${obj} LIMIT 5000` });
    if (q.error) {
      const fe = sftkFriendlyError(q.error);
      if (el) { el.className = 'fc-data-verdict'; el.title = fe.raw; el.textContent = `📊 Couldn't measure field usage: ${fe.message}${fe.hint ? ' — ' + fe.hint : ''}`; }
      return;
    }
    const rows = q.records || [];
    const filled = rows.filter(r => r[fld] != null && r[fld] !== '').length;
    _dataVerdict = {
      filled, total: rows.length, lastIso: null, sampled: true,
      fillPct: rows.length ? (filled / rows.length * 100) : 0,
    };
    _renderDataVerdict();
  }

  function _renderDataVerdict() {
    const el = eid('fcDataVerdict');
    if (!el || !_dataVerdict) return;
    const v = _dataVerdict;
    if (v.formula) {
      el.className = 'fc-data-verdict fc-data-na';
      el.innerHTML = '📊 <strong>Formula / derived field</strong> — stores no editable data of its own.';
      return;
    }
    const pctFilled = v.fillPct;
    const emptyPct  = Math.max(0, 100 - pctFilled);
    const safe = pctFilled < 1;   // <1% populated ⇒ effectively unused
    const ageStr = v.lastIso
      ? _relAge(v.lastIso)
      : (v.filled === 0 ? 'never' : 'unknown');
    const scope = v.sampled ? `~${v.filled} of ${v.total.toLocaleString()} sampled` : `${v.filled.toLocaleString()} of ${v.total.toLocaleString()} records`;
    // Never round UP to 100% / down to 0% unless the value is truly there —
    // "100% empty" on a field that still holds 12 values would be a lie.
    const pctStr = p => (p >= 99.95 && p < 100) ? '99.9'
                      : (p > 0 && p < 0.05) ? '0.1'
                      : p.toFixed(p > 99 || p < 1 ? 1 : 0);
    el.className = `fc-data-verdict ${safe ? 'fc-data-safe' : 'fc-data-caution'}`;
    el.innerHTML = `
      <span class="fc-data-badge">${safe ? '✅ SAFE' : '⚠ CAUTION'}</span>
      <span class="fc-data-text">
        ${safe
          ? `Empty on <strong>${pctStr(emptyPct)}%</strong> of ${scope}`
          : `Populated on <strong>${pctStr(pctFilled)}%</strong> of ${scope}`}
        · last value written <strong>${ageStr}</strong>${v.sampled ? ' <em>(sampled)</em>' : ''}
      </span>`;
  }

  function _relAge(iso) {
    const d = Date.parse(iso);
    if (!d) return 'unknown';
    const months = (Date.now() - d) / (1000 * 60 * 60 * 24 * 30.4);
    if (months < 1)  return 'within the last month';
    if (months < 12) return `${Math.round(months)} month(s) ago`;
    return `${(months / 12).toFixed(1)} year(s) ago`;
  }

  function renderItem(dep, fixable, type) {
    const id      = dep.MetadataComponentId;
    const name    = esc(dep.MetadataComponentName || id);
    const canInsp = Object.prototype.hasOwnProperty.call(_INSPECT_SOBJECT, type);
    const inspBtn = canInsp
      ? `<button class="btn btn-sm fc-inspect-btn" title="View XML metadata"
                 data-id="${esc(id)}" data-type="${esc(type)}">🔍</button>`
      : '';
    const xmlPanel = canInsp
      ? `<div class="fc-xml-panel" id="fcXml_${esc(id)}" style="display:none"></div>`
      : '';

    // C5a: before trimming a flow, its full subflow picture lives in the
    // Dependencies tab — a per-row jump turns a blind auto-fix into an
    // informed one (no prefill: the Dependencies tab has no handoff state).
    const depsLink = type === 'Flow'
      ? xlinkHtml('dependencies', '↗ Deps',
          "Map this flow's subflow call chain in the Dependencies tab before trimming it")
      : '';

    if (fixable) {
      return `
        <div class="fc-item" id="fcItem_${esc(id)}">
          <span class="fc-item-name">${name}</span>
          <span class="fc-item-btns">
            ${depsLink}
            ${inspBtn}
            <button class="btn btn-secondary btn-sm fc-fix-btn"
                    data-id="${esc(id)}" data-name="${name}" data-type="${esc(type)}">
              ✂ Remove
            </button>
          </span>
        </div>${xmlPanel}`;
    }
    return `
      <div class="fc-item" id="fcItem_${esc(id)}">
        <span class="fc-item-name">${name}</span>
        <span class="fc-item-btns">
          ${inspBtn}
          <button class="btn btn-sm fc-setup-btn" data-type="${esc(type)}">↗ Setup</button>
        </span>
      </div>${xmlPanel}`;
  }

  // ── Fix individual flow ────────────────────────────────────
  async function fixOne(type, componentId, componentName, fieldId) {
    const cfg = TYPE_CFG[type] || TYPE_CFG_DEFAULT;
    // W6 (user 2026-08-05: "ask before any delete operation") — ✂ Remove
    // DEPLOYS metadata on one click, and for flows also permanently DELETES
    // old versions that still reference the field. Confirm first, stating
    // exactly what will happen; flows get the deliberate checkbox because
    // deleted flow versions cannot be restored.
    const sure = await sftkConfirmDestructive({
      title: `Remove field reference — ${cfg.label || type}`,
      items: [{ label: componentName, sub: type }],
      revOverride: {
        html: type === 'Flow'
          ? '⚠ <strong>Deploys and activates a new flow version</strong> with the reference removed, and <strong>permanently deletes old versions</strong> that still reference the field (Salesforce holds the dependency lock per version). Deleted flow versions cannot be restored.'
          : `✏ ${cfg.note || 'The field reference is removed from this component.'} The change deploys immediately; there is no undo besides re-adding the field by hand.`,
        needsCheckbox: type === 'Flow',
      },
      confirmLabel: '✂ Remove reference',
    });
    if (!sure) return;

    const btn = document.querySelector(`.fc-fix-btn[data-id="${componentId}"]`);
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    try {
      let label = cfg.doneLabel || '✅ Done';
      let doneLinks = '';
      if (type === 'Flow') {
        const purge = await fixFlow(componentId, componentName);
        if (purge?.purged)        label += ` · ${purge.purged} old version(s) purged`;
        if (purge?.stillBlocking) label += ` · ⚠ ${purge.stillBlocking} old version(s) couldn't be deleted — may still block the field delete`;
        doneLinks = _flowDoneLinks(purge);
      }
      if (type === 'Layout')    await fixLayout(componentId, componentName);
      if (type === 'FlexiPage') await fixFlexiPage(componentId, componentName);
      markFixed(componentId, label, doneLinks);
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '✂ Remove'; }
      // Label the open-link button based on which builder we're sending them to.
      const linkLabel = type === 'Flow' ? '↗ Open in Flow Builder' : '↗ Open in Setup';
      // C5a: FlexiPage failures dead-end into manual App Builder work — the
      // toolkit's own Lightning Pages tool operates on these exact pages.
      const crossTab = type === 'FlexiPage'
        ? { tab: 'pages', label: '↗ Open in Lightning Pages',
            title: 'Open the Lightning Pages tool — it manages these record pages' }
        : null;
      appendInlineError(componentId, e.message, e.setupUrl, linkLabel, crossTab);
    }
  }

  // C5a: follow-up links for a completed flow fix. The fix just ACTIVATED a
  // new flow version, so verifying who can run it is a Flow Access job; if
  // the old-version purge left stragglers, deleting those is a Flows job.
  function _flowDoneLinks(purge) {
    let links = xlinkHtml('flow-access', '↗ Check access',
      'A new flow version was activated — verify who can run it in the Flow Access tool');
    if (purge?.stillBlocking) {
      links += xlinkHtml('flows', '↗ Open in Flows',
        'Finish deleting the stale flow versions in the Flows tool');
    }
    return links;
  }

  async function fixAll(type, items, fieldId) {
    for (const item of items) {
      await fixOne(type, item.MetadataComponentId,
                   item.MetadataComponentName || item.MetadataComponentId, fieldId);
    }
  }

  // extraLinksHtml (C5a) — optional pre-escaped xlinkHtml() follow-up links
  // rendered after the done-label (e.g. "↗ Check access" after a flow fix).
  function markFixed(componentId, label = '✅ Done', extraLinksHtml = '') {
    const item = eid(`fcItem_${componentId}`);
    if (!item) return;
    const name = item.querySelector('.fc-item-name')?.textContent || '';
    item.classList.add('fc-item-fixed');
    item.innerHTML = `
      <span class="fc-item-name">${esc(name)}</span>
      <span class="fc-item-ok">${esc(label)}${extraLinksHtml}</span>`;
    // Close any open XML inspector for this item
    const xmlPanel = eid(`fcXml_${componentId}`);
    if (xmlPanel) xmlPanel.style.display = 'none';
    checkEnableDelete();
  }

  function appendInlineError(componentId, msg, setupUrl, linkLabel, crossTab) {
    const item = eid(`fcItem_${componentId}`);
    if (!item) return;
    const err = document.createElement('div');
    err.className = 'fc-item-err';
    // Plain text part (no HTML — safe).
    err.textContent = `❌ ${msg}`;
    // If we have a deep link, render it as a real button next to the text.
    if (setupUrl) {
      const btn = document.createElement('a');
      btn.className   = 'fc-item-setup-link';
      btn.href        = setupUrl;
      btn.target      = '_blank';
      btn.rel         = 'noopener';
      btn.textContent = linkLabel || '↗ Open in Setup';
      btn.style.cssText =
        'display:inline-block;margin-left:8px;padding:2px 9px;border-radius:5px;' +
        'background:#0176d3;color:#fff;font-weight:600;font-size:11px;text-decoration:none;';
      err.appendChild(btn);
    }
    // C5a: optional in-toolkit follow-up ({ tab, label, title }) — jumps to
    // the sibling tool that can finish the job the auto-fix couldn't.
    if (crossTab?.tab) err.appendChild(xlinkEl(crossTab.tab, crossTab.label, crossTab.title));
    item.appendChild(err);
  }

  // Render a translated one-line error right under a button (instead of
  // cramming raw API text into the button label). Raw string stays in the
  // title attribute for copy/paste; textContent keeps it injection-safe.
  function _friendlyErrorUnder(btn, raw) {
    if (!btn) return;
    const fe = sftkFriendlyError(raw);
    btn.parentElement?.querySelectorAll('.fc-btn-err').forEach(n => n.remove());
    const err = document.createElement('div');
    err.className = 'fc-item-err fc-btn-err';
    err.title = fe.raw;
    err.textContent = `❌ ${fe.message}${fe.hint ? ' — ' + fe.hint : ''}`;
    btn.insertAdjacentElement('afterend', err);
  }

  // Translate a raw API/deploy error fragment before it is embedded inside
  // composed guidance text (fixFlow/fixLayout/fixFlexiPage messages all flow
  // into appendInlineError, which renders via textContent — plain string).
  function _feText(raw) {
    const fe = sftkFriendlyError(raw);
    return fe.message + (fe.hint ? ' — ' + fe.hint : '');
  }

  function checkEnableDelete() {
    const remaining = document.querySelectorAll('.fc-fix-btn:not([disabled])');
    const delBtn    = eid('fcDelBtn');
    if (!delBtn) return;
    const blockerTotal = (_manualBlockers || []).reduce((n, b) => n + b.count, 0);
    // F2: even with every auto-fix done, manual blockers still make Salesforce
    // reject the delete — keep the button locked and say why.
    if (remaining.length === 0 && blockerTotal === 0) {
      delBtn.disabled = false;
      const note = eid('fcDeleteNote');
      if (note) note.textContent = 'All dependencies resolved. Safe to delete.';
    } else if (remaining.length === 0 && blockerTotal > 0) {
      delBtn.disabled = true;
      const note = eid('fcDeleteNote');
      if (note) note.textContent = `🔒 Auto-fixes done, but ${blockerTotal} manual blocker(s) remain — clear them in Setup and re-scan.`;
    }
  }

  // Show a "partial fix" status on a flow item — N references removed, M
  // remain. We do NOT remove the .fc-fix-btn here, so checkEnableDelete
  // still sees an unresolved fix and keeps the Delete Field button disabled.
  function _markFlowPartial(componentId, removed, remaining) {
    const item = eid(`fcItem_${componentId}`);
    if (!item) return;
    // Drop any prior partial-status banner so we don't stack them on repeat fixes.
    item.querySelector('.fc-item-partial')?.remove();
    const banner = document.createElement('div');
    banner.className = 'fc-item-partial';
    banner.textContent =
      `⚠ Partial fix: removed ${removed} reference${removed === 1 ? '' : 's'}, ` +
      `${remaining} remain. The flow still references the field — finish the trim ` +
      `or remove the rest in Flow Builder before deleting.`;
    item.appendChild(banner);
    item.classList.add('fc-item-warn');
  }

  // Re-fetch + re-render the XML inspector panel for a dependency. Used
  // after a partial flow fix so the user sees the post-deploy state with
  // only the remaining refs still checkable.
  async function _refreshXmlInspector(type, componentId, componentName, fieldId) {
    const panel = eid(`fcXml_${componentId}`);
    if (!panel) return;
    // Trick toggleXmlInspector into treating the panel as closed so it
    // re-renders rather than just toggling it off.
    panel.style.display = 'none';
    const inspBtn = document.querySelector(`.fc-inspect-btn[data-id="${componentId}"]`);
    if (inspBtn) inspBtn.classList.remove('fc-inspect-btn--open');
    await toggleXmlInspector(type, componentId, componentName, fieldId);
  }

  // ── Flow fix logic ─────────────────────────────────────────
  async function fixFlow(flowId, flowName) {
    // Read full flow metadata
    const flowRes = await bg({
      type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid,
      sobject: 'Flow', id: flowId
    });
    if (flowRes.error) throw new Error(`Could not read "${flowName}": ${_feText(flowRes.error)}`);

    const fullName = flowRes.FullName;
    const metadata = flowRes.Metadata;
    if (!fullName || !metadata) throw new Error(`"${flowName}" returned no metadata.`);

    // F6: snapshot BEFORE the in-place mutation below — ↩ Restore redeploys it.
    await _snapshotFix('Flow', flowId, flowName, fullName, metadata);

    // Remove field references
    const changes = removeFieldRefs(metadata, _selObj.api, _selField.api);
    if (changes === 0) {
      const err = new Error(
        `Couldn't auto-remove the field from "${flowName}" — the reference is ` +
        `in a path the auto-fix can't safely change (decision condition, ` +
        `formula expression, or variable default). Click "Open in Flow Builder" ` +
        `to fix it by hand.`
      );
      if (_orgUrl) {
        err.setupUrl = `${_orgUrl.replace(/\/$/, '')}/builder_platform_interaction/flowBuilder.app?flowId=${flowId}`;
      }
      throw err;
    }

    // Deploy the fixed flow via the Metadata API. This creates a NEW version
    // and activates it in one step — and unlike the Tooling API `Flow` create,
    // it works for record-triggered flows (which reject the Tooling create
    // with "fullName ... for Flow version is not unique"). Strip Tooling-only
    // descriptors first so the XML validates.
    delete metadata.fullName;
    const flowApiName = fullName.replace(/-\d+$/, '');   // My_Flow-3 → My_Flow
    const deployRes = await deployFlowViaMetadataApi(flowApiName, metadata);
    if (!deployRes || !deployRes.success) {
      const e = new Error(
        `Couldn't deploy the fixed "${flowName}" (${deployRes?.error ? _feText(deployRes.error) : 'deploy failed'}). ` +
        `Open in Flow Builder to remove the field reference by hand.`
      );
      if (_orgUrl) e.setupUrl = `${_orgUrl.replace(/\/$/, '')}/builder_platform_interaction/flowBuilder.app?flowId=${flowId}`;
      throw e;
    }

    // Old versions of this flow can STILL reference the field and keep
    // blocking the delete — Salesforce holds the dependency lock per
    // VERSION, not per active version. Purge the stale ones.
    return purgeOldFlowVersions(flowId, flowName);
  }

  // Does this flow-version metadata reference the selected field ANYWHERE?
  // Broader than removeFieldRefs (which only counts auto-removable refs):
  // walks every string value and matches both exact reference forms
  // (via _xiIsRef) and embedded formula/template tokens like
  // "{!$Record.Field__c} > 5" that exact-match tests miss.
  function flowReferencesField(metadata) {
    const fl = (_selField?.api || '').toLowerCase();
    if (!fl) return false;
    // Token-boundary regex: field api name not preceded/followed by an
    // identifier char, so Latest__c doesn't false-match test__c.
    const tokenRe = new RegExp(`(^|[^a-z0-9_])${fl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_]|$)`, 'i');
    let found = false;
    (function walk(v) {
      if (found || v == null) return;
      if (typeof v === 'string') {
        if (_xiIsRef(v) || tokenRe.test(v)) found = true;
        return;
      }
      if (Array.isArray(v)) { for (const x of v) walk(x); return; }
      if (typeof v === 'object') { for (const k of Object.keys(v)) walk(v[k]); }
    })(metadata);
    return found;
  }

  // Delete old (non-Active) versions of a flow that still reference the
  // selected field. Salesforce blocks custom-field deletion while ANY flow
  // version references it — deploying a fixed Active version is not enough,
  // the stale versions keep the lock. The fresh Active version is never
  // touched. Returns { purged, failed, stillBlocking } for the done-label.
  async function purgeOldFlowVersions(anyVersionId, flowName) {
    const out = { purged: 0, failed: 0, stillBlocking: 0 };
    try {
      // Resolve the flow's definition from the version we were given…
      const defRes = await bg({
        type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true,
        query: `SELECT DefinitionId FROM Flow WHERE Id = '${anyVersionId}'`
      });
      const defId = defRes?.records?.[0]?.DefinitionId;
      if (!defId) return out;
      // …then list every version of it.
      const verRes = await bg({
        type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true,
        query: `SELECT Id, Status, VersionNumber FROM Flow WHERE DefinitionId = '${defId}' ORDER BY VersionNumber DESC`
      });
      const versions = verRes?.records || [];
      for (const v of versions) {
        if (v.Status === 'Active') continue;   // the fixed version we just deployed
        // Only delete versions that actually still reference the field —
        // clean old versions are harmless history and stay.
        const read = await bg({
          type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid,
          sobject: 'Flow', id: v.Id
        });
        if (read?.error || !read?.Metadata) continue;
        if (!flowReferencesField(read.Metadata)) continue;
        const del = await bg({
          type: 'SF_TOOLING_DELETE', orgUrl: _orgUrl, sid: _sid,
          sobject: 'Flow', id: v.Id, _suppressError: true
        });
        if (del?.error) { out.failed++; out.stillBlocking++; }
        else out.purged++;
      }
    } catch (e) {
      if (window.SFToolkitDebug?.enabled) {
        window.SFToolkitDebug.log('fields', 'error',
          `Old-version purge for "${flowName}" failed`, e.message);
      }
    }
    return out;
  }

  // Remove all direct references to objApi.fieldApi from flow metadata JSON.
  // Returns the number of references removed. Decisions and formula text are
  // intentionally skipped — changing branching logic or formulas automatically
  // is too risky; the user has to remove those by hand in Flow Builder.
  function removeFieldRefs(metadata, objApi, fieldApi) {
    let changes = 0;
    const fl       = fieldApi.toLowerCase();
    const full     = `${objApi}.${fieldApi}`.toLowerCase();
    const rec      = `$record.${fieldApi}`.toLowerCase();
    const recPrior = `$record__prior.${fieldApi}`.toLowerCase();

    function refMatches(ref) {
      if (ref == null) return false;
      const r = String(ref).toLowerCase();
      return r === fl || r === full || r === rec || r === recPrior || r.endsWith('.' + fl);
    }

    function strip(arr, testFn) {
      if (!Array.isArray(arr)) return arr;
      const before = arr.length;
      const after  = arr.filter(item => !testFn(item));
      changes += before - after.length;
      return after;
    }

    // ── start — record-triggered flow entry criteria + assignments ──────
    // Very common for fields used in "trigger when …" conditions.
    if (metadata.start && typeof metadata.start === 'object') {
      metadata.start.filters = strip(metadata.start.filters, f => refMatches(f.field));
      // Some flows have `start.schedule.filters` or `start.scheduledPaths[].filters`
      if (Array.isArray(metadata.start.scheduledPaths)) {
        for (const sp of metadata.start.scheduledPaths) {
          sp.filters = strip(sp.filters, f => refMatches(f.field));
        }
      }
    }

    // ── recordLookups — filter conditions, output assignments, queried fields
    for (const el of (metadata.recordLookups || [])) {
      el.filters           = strip(el.filters,           f => refMatches(f.field));
      el.outputAssignments = strip(el.outputAssignments, a => refMatches(a.field));
      el.queriedFields     = strip(el.queriedFields,     f => refMatches(f));
    }

    // ── recordCreates — field assignments
    for (const el of (metadata.recordCreates || [])) {
      el.inputAssignments = strip(el.inputAssignments, a => refMatches(a.field));
    }

    // ── recordUpdates — filter conditions + field assignments
    for (const el of (metadata.recordUpdates || [])) {
      el.filters          = strip(el.filters,          f => refMatches(f.field));
      el.inputAssignments = strip(el.inputAssignments, a => refMatches(a.field));
    }

    // ── recordDeletes — filter conditions
    for (const el of (metadata.recordDeletes || [])) {
      el.filters = strip(el.filters, f => refMatches(f.field));
    }

    // ── screens — recursively remove inputs that directly bind to this field
    function stripScreenFields(fields) {
      if (!Array.isArray(fields)) return fields;
      return fields.filter(f => {
        if (refMatches(f.objectFieldReference)) { changes++; return false; }
        if (Array.isArray(f.fields)) f.fields = stripScreenFields(f.fields);
        return true;
      });
    }
    for (const el of (metadata.screens || [])) {
      el.fields = stripScreenFields(el.fields || []);
    }

    // ── assignments — items reading from or writing to the field
    for (const el of (metadata.assignments || [])) {
      el.assignmentItems = strip(el.assignmentItems, item =>
        refMatches(item.assignToReference) ||
        refMatches(item.value?.elementReference)
      );
    }

    // ── actionCalls — input parameters that reference the field
    for (const el of (metadata.actionCalls || [])) {
      el.inputParameters = strip(el.inputParameters, p =>
        refMatches(p.value?.elementReference)
      );
    }

    // ── subflows — input assignments that pass the field
    for (const el of (metadata.subflows || [])) {
      el.inputAssignments = strip(el.inputAssignments, a =>
        refMatches(a.value?.elementReference)
      );
    }

    // ── loops — iterating directly over the field
    for (const el of (metadata.loops || [])) {
      if (refMatches(el.collectionReference)) {
        delete el.collectionReference; changes++;
      }
    }

    // Decisions, formulas, and free-text expression fields are intentionally
    // NOT modified — branching logic changes and formula edits require human
    // review. If the dep is only in those, the user must fix manually.

    return changes;
  }

  // ── Layout fix logic ───────────────────────────────────────
  // Tooling API Layout round-trip quirks. A GET on Layout.Metadata returns
  // several compound sub-fields in shapes the PATCH parser rejects with:
  //   "Cannot deserialize instance of complexvalue from VALUE_STRING value '…'"
  //
  // Originally we pre-stripped platformActionList / quickActionList entirely.
  // That worked for the deserialize error, but on layouts with activity-aware
  // quick actions (e.g. most Contact layouts: "New Task", "Log a Call"),
  // Salesforce then regenerated default platform actions — and the defaults
  // hit "Mass quick actions don't support Activity. Use a valid entity."
  //
  // Better: let the surgical retry handle them. If only one sub-property is
  // round-trip-broken (typically `actionListContext: "Record"`), we strip JUST
  // that property — preserving the rest of platformActionList so Salesforce
  // does NOT regenerate defaults. Bare-string sentinels are still stripped
  // as a fast path (the GET sometimes returns whole complex fields as bare
  // strings meaning "at default", which is uncatchable as a sub-property).
  const _LAYOUT_COMPLEX_FIELDS = [
    'summaryLayout', 'feedLayout', 'customConsoleComponents', 'relatedContent',
    'platformActionList', 'quickActionList', 'miniLayout', 'headers'
  ];

  function sanitizeLayoutMetadata(metadata) {
    const clean = { ...metadata };
    for (const k of _LAYOUT_COMPLEX_FIELDS) {
      // A bare string where an object is expected → the field is at default;
      // drop it so PATCH doesn't choke on "complexvalue from VALUE_STRING".
      if (typeof clean[k] === 'string') delete clean[k];
    }
    return clean;
  }

  // Delete the first property matching BOTH key name and value (recursively).
  // Far more precise than matching on value alone — avoids removing an
  // unrelated, legitimate field that happens to share the value.
  function stripKeyValue(node, key, val, depth) {
    if (!node || typeof node !== 'object' || (depth || 0) > 25) return false;
    if (Array.isArray(node)) {
      for (const item of node) if (stripKeyValue(item, key, val, (depth || 0) + 1)) return true;
      return false;
    }
    if (node[key] === val) { delete node[key]; return true; }
    for (const k of Object.keys(node)) {
      if (stripKeyValue(node[k], key, val, (depth || 0) + 1)) return true;
    }
    return false;
  }

  // Value-only fallback when we can't pin down the key from the column.
  function stripFirstStringValue(node, val, depth) {
    if (!node || typeof node !== 'object' || (depth || 0) > 25) return false;
    if (Array.isArray(node)) {
      for (const item of node) if (stripFirstStringValue(item, val, (depth || 0) + 1)) return true;
      return false;
    }
    for (const k of Object.keys(node)) {
      if (node[k] === val) { delete node[k]; return true; }
    }
    for (const k of Object.keys(node)) {
      if (stripFirstStringValue(node[k], val, (depth || 0) + 1)) return true;
    }
    return false;
  }

  // Given the exact JSON string we sent and the parser's reported column,
  // find the property KEY whose bare-string value the parser choked on —
  // by reading "key":"badValue" nearest that column. This lets us strip
  // precisely the offending field instead of guessing by value.
  function keyAtColumn(jsonStr, col, badValue) {
    const start  = Math.max(0, col - 160);
    const window = jsonStr.slice(start, col + 60);
    const esc    = String(badValue).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re     = new RegExp('"([A-Za-z0-9_]+)"\\s*:\\s*"' + esc + '"', 'g');
    let m, best = null, bestDist = Infinity;
    while ((m = re.exec(window))) {
      const dist = Math.abs((start + m.index) - col);
      if (dist < bestDist) { bestDist = dist; best = m[1]; }
    }
    return best;
  }

  // PATCH a Layout's Metadata, recovering from the Tooling API's recurring
  // "Cannot deserialize complexvalue from VALUE_STRING value 'X' … column:N"
  // round-trip errors. The error names both the offending value AND its column,
  // so we surgically strip exactly that property (a bare string means the field
  // is at its default — omitting it preserves that default) and retry. Loops
  // until the PATCH succeeds, hits an unrelated error, or can't strip further.
  async function patchLayoutMetadata(componentId, metadata) {
    const body = metadata;
    for (let attempt = 0; attempt < 14; attempt++) {
      const res = await bg({
        type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid,
        path: `services/data/v62.0/tooling/sobjects/Layout/${componentId}`,
        body: { Metadata: body },
        _suppressError: true   // 400s here are part of the strip-and-retry loop
      });
      if (!res.error) return res;                       // success

      // Parse out the bad value and (when present) the column.
      const vm = /VALUE_STRING value ['"]?([^'",\s]+)/i.exec(res.error);
      if (!vm) return res;                              // unrelated error — bail
      const badValue = vm[1];
      const cm = /column:\s*(\d+)/i.exec(res.error);

      let removed = false;
      if (cm) {
        // Surgical: find the exact key at the reported column and strip it.
        const sent = JSON.stringify({ Metadata: body });
        const key  = keyAtColumn(sent, parseInt(cm[1], 10), badValue);
        if (key) removed = stripKeyValue(body, key, badValue);
      }
      // Fallback: strip by value alone if the column lookup didn't pin a key.
      if (!removed) removed = stripFirstStringValue(body, badValue);
      if (!removed) return res;                         // nothing left to strip
      // else: stripped the offending field — loop and retry
    }
    return { error: 'Layout metadata could not be made PATCH-compatible after several attempts.' };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Metadata API zip-deploy fallback for Layouts
  //
  // The Tooling API `Metadata` PATCH for Layouts is genuinely fragile —
  // some layouts (notably those with activity-related quick actions) get
  // rejected by Salesforce's own validator. The Metadata API zip-deploy
  // path is what mature SF tooling (sfdx, ant, etc.) uses, and avoids the
  // Tooling API's compound-field PATCH quirks.
  //
  // We build a minimal package containing:
  //   package.xml          — declares the Layout
  //   layouts/{FullName}.layout — the layout XML, built from the modified JSON
  // and deploy via SF_METADATA_DEPLOY (the same handler lightning-pages.js uses
  // for FlexiPage modifications).
  // ─────────────────────────────────────────────────────────────────────

  // XML escape — same escapes as XSD attribute/text content.
  function _lxEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Tooling-API descriptors injected on every nested object that aren't valid
  // XSD elements — drop them recursively before XML serialization.
  const _LX_SKIP = new Set(['attributes', 'fullName']);

  // Recursive JSON → XML serializer. Layout XSD is alphabetical at every
  // nesting level, so a sorted-keys walk produces a valid document.
  // Arrays become repeated sibling elements. null/undefined/'' are skipped.
  function _lxValueToLines(key, value, indent) {
    if (_LX_SKIP.has(key)) return [];
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) {
      // Empty arrays → drop entirely (XSD rejects empty wrappers whose
      // required children fail to appear).
      if (value.length === 0) return [];
      return value.flatMap(item => _lxValueToLines(key, item, indent));
    }
    if (typeof value === 'object') {
      const keys = Object.keys(value).filter(k => !_LX_SKIP.has(k)).sort();
      const children = keys.flatMap(k => _lxValueToLines(k, value[k], indent + '    '));
      if (children.length === 0) return [];
      return [`${indent}<${key}>`, ...children, `${indent}</${key}>`];
    }
    const str = String(value);
    if (str === '') return [];
    return [`${indent}<${key}>${_lxEsc(str)}</${key}>`];
  }

  // Layout XSD top-level field order (alphabetical, per Salesforce convention).
  // Anything not in this list is silently dropped — protects us from any
  // Tooling-API-only fields that aren't valid in the Metadata XSD.
  const _LAYOUT_TOP_ORDER = [
    'customConsoleComponents', 'emailDefault', 'excludeButtons', 'feedLayout',
    'headers', 'layoutSections', 'miniLayout', 'multilineLayoutFields',
    'platformActionList', 'quickActionList', 'relatedContent', 'relatedLists',
    'relatedObjects', 'runAssignmentRulesDefault', 'showEmailCheckbox',
    'showHighlightsPanel', 'showInteractionLogPanel', 'showKnowledgeComponent',
    'showRunAssignmentRulesCheckbox', 'showSolutionSection',
    'showSubmitAndAttachButton', 'summaryLayout'
  ];

  // opts.skip: optional Set of top-level keys to omit from the XML — used by
  // the retry deploy that drops platformActionList/quickActionList when the
  // server rejects their (Salesforce-returned-but-no-longer-valid) values.
  function buildLayoutXml(metadata, opts) {
    const skip = (opts && opts.skip) || null;
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Layout xmlns="http://soap.sforce.com/2006/04/metadata">'
    ];
    for (const key of _LAYOUT_TOP_ORDER) {
      if (skip && skip.has(key)) continue;
      // Skip a top-level value that came back as a bare-string sentinel
      // (e.g. summaryLayout: "Default" meaning "at default"). Omitting it
      // preserves the default — sending the bare string fails XSD validation.
      const v = metadata[key];
      if (typeof v === 'string' && /^[A-Z][A-Za-z]+$/.test(v)) continue;
      lines.push(..._lxValueToLines(key, v, '    '));
    }
    lines.push('</Layout>');
    return lines.join('\n');
  }

  function buildLayoutPackageXml(fullName) {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <types>',
      `        <members>${_lxEsc(fullName)}</members>`,
      '        <name>Layout</name>',
      '    </types>',
      '    <version>62.0</version>',
      '</Package>'
    ].join('\n');
  }

  // Build an uncompressed (stored) ZIP and return it as a base64 string.
  // files: [{ name, data: Uint8Array }]. Delegates to the shared builder in
  // sftk-zip.js (loaded before this module in popup.html).
  function _lxBuildStoredZip(files) {
    return window.sftkBuildStoredZip(files);
  }

  function buildLayoutZip(fullName, metadata, opts) {
    const enc = new TextEncoder();
    return _lxBuildStoredZip([
      { name: 'package.xml',                       data: enc.encode(buildLayoutPackageXml(fullName)) },
      { name: `layouts/${fullName}.layout`,        data: enc.encode(buildLayoutXml(metadata, opts)) }
    ]);
  }

  // Deploy a modified Layout via Metadata API — used as a fallback when the
  // Tooling API PATCH fails (e.g. layouts with activity-aware quick actions).
  //
  // Two-attempt strategy:
  //   1. Deploy the full layout XML.
  //   2. If Salesforce rejects with "ActionListContext invalid" (or similar
  //      semantic refusal of platform / quick action config), retry with those
  //      sub-trees omitted. They're frequently rejected because the GET still
  //      returns enum values that newer API versions no longer accept.
  async function deployLayoutViaMetadataApi(fullName, metadata) {
    const first = await bg({
      type: 'SF_METADATA_DEPLOY', orgUrl: _orgUrl, sid: _sid,
      zipBase64: buildLayoutZip(fullName, metadata),
      _suppressError: true
    });
    if (first && first.success) return first;

    // Retry without action lists if the first deploy was rejected on them.
    const rejectedActions = first && first.error &&
      /ActionListContext|platformActionList|quickActionList|action list|quick action/i.test(first.error);
    if (rejectedActions) {
      const second = await bg({
        type: 'SF_METADATA_DEPLOY', orgUrl: _orgUrl, sid: _sid,
        zipBase64: buildLayoutZip(fullName, metadata, {
          skip: new Set(['platformActionList', 'quickActionList'])
        }),
        _suppressError: true
      });
      if (second && second.success) return second;
      // Surface the more informative original error if the retry also failed.
      return second && second.error ? second : first;
    }
    return first;
  }

  // ── Flow deploy via Metadata API ───────────────────────────────────────
  // The Tooling API `Flow` create won't reliably add a new version to many
  // flows (esp. record-triggered) — it rejects with "fullName ... for Flow
  // version is not unique". The Metadata API zip-deploy is the method that
  // actually works: it creates a new version and (with status=Active)
  // activates it, the same path mature tooling uses.
  function buildFlowXml(metadata) {
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">'
    ];
    // Alphabetical walk (reuses the layout serializer's array/object/skip
    // handling). apiVersion is rendered with one decimal so Salesforce
    // accepts it ("62" would be rejected where "62.0" is expected).
    const keys = Object.keys(metadata).filter(k => !_LX_SKIP.has(k)).sort();
    for (const key of keys) {
      if (key === 'apiVersion' && metadata.apiVersion != null) {
        lines.push(`    <apiVersion>${Number(metadata.apiVersion).toFixed(1)}</apiVersion>`);
        continue;
      }
      lines.push(..._lxValueToLines(key, metadata[key], '    '));
    }
    lines.push('</Flow>');
    return lines.join('\n');
  }

  function buildFlowPackageXml(fullName) {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <types>',
      `        <members>${_lxEsc(fullName)}</members>`,
      '        <name>Flow</name>',
      '    </types>',
      '    <version>62.0</version>',
      '</Package>'
    ].join('\n');
  }

  function buildFlowZip(fullName, metadata) {
    const enc = new TextEncoder();
    return _lxBuildStoredZip([
      { name: 'package.xml',              data: enc.encode(buildFlowPackageXml(fullName)) },
      { name: `flows/${fullName}.flow`,   data: enc.encode(buildFlowXml(metadata)) }
    ]);
  }

  // Deploy the modified flow. status:'Active' makes the deploy create a new
  // version AND activate it (the old version becomes Obsolete) in one step.
  async function deployFlowViaMetadataApi(fullName, metadata) {
    metadata.status = 'Active';
    return bg({
      type: 'SF_METADATA_DEPLOY', orgUrl: _orgUrl, sid: _sid,
      zipBase64: buildFlowZip(fullName, metadata)
    });
  }

  // Exposed for the popup's Flow Restore (popup.js → performRestore). Restore
  // used the Tooling `Flow` create, which rejects record-triggered flows with
  // "fullName … for Flow version is not unique". This is the same Metadata-API
  // zip-deploy fixFlow uses — it adds a new version for EVERY flow type — but
  // callable with an explicit org/sid/status instead of the module's selected
  // _orgUrl/_sid. Defaults to a Draft version so restore never auto-activates.
  window.sftkDeployFlowMetadata = function (orgUrl, sid, fullName, metadata, status) {
    const md = { ...(metadata || {}) };
    delete md.fullName;               // Tooling-only descriptor; breaks the XML
    md.status = status || 'Draft';    // restore → inactive Draft, user activates
    return bg({
      type: 'SF_METADATA_DEPLOY', orgUrl, sid,
      zipBase64: buildFlowZip(fullName, md)
    });
  };

  async function fixLayout(componentId, componentName) {
    const res = await bg({
      type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid,
      sobject: 'Layout', id: componentId
    });
    if (res.error) throw new Error(`Could not read "${componentName}": ${_feText(res.error)}`);

    const metadata = res.Metadata;
    if (!metadata) throw new Error(`"${componentName}" returned no metadata.`);

    // F6: snapshot before the in-place mutation (layout has no undo otherwise).
    await _snapshotFix('Layout', componentId, componentName, res.FullName || res.fullName, metadata);

    const changes = removeFieldFromLayout(metadata, _selField.api);
    if (changes === 0) {
      throw new Error(
        `Field not found in "${componentName}" layout sections. ` +
        'It may be in a related list or inline edit only — remove manually.'
      );
    }

    // Path 1: Tooling API PATCH with progressive retry for VALUE_STRING errors.
    // Succeeds for most layouts and is fast (~1 round-trip).
    const patchRes = await patchLayoutMetadata(componentId, sanitizeLayoutMetadata(metadata));
    if (!patchRes.error) return;

    // Path 2: Tooling API rejected this layout (typical for layouts with
    // activity-related quick actions). Fall back to Metadata API zip-deploy,
    // which is the route mature SF tooling uses and isn't subject to the
    // Tooling API's `Metadata` compound PATCH quirks.
    const fullName = res.FullName || res.fullName;
    if (fullName) {
      const deployRes = await deployLayoutViaMetadataApi(fullName, metadata);
      if (deployRes && deployRes.success) return;
      // Fall through to surface a clear error if the Metadata API also failed.
      var deployErr = deployRes && deployRes.error;
    }

    // Both paths failed — surface a clean message *with* a one-click deep link
    // to the layout in Setup, so the manual fix is 30 seconds, not a hunt.
    const toolingReason = _feText(String(patchRes.error).replace(/^HTTP\s*\d+:\s*/i, '').trim());
    const deployReason  = typeof deployErr === 'string'
                        ? _feText(String(deployErr).replace(/^HTTP\s*\d+:\s*/i, '').trim())
                        : '';
    const err = new Error(
      `Salesforce won't accept the layout update for "${componentName}" (${toolingReason}` +
      (deployReason ? `; deploy: ${deployReason}` : '') +
      `). Click "Open in Setup" to remove the field by hand — takes ~30 seconds.`
    );
    // Setup deep link: /lightning/setup/ObjectManager/{Entity}/PageLayouts/{Id}/view
    const entity = _selObj && _selObj.api ? encodeURIComponent(_selObj.api) : '';
    if (entity && _orgUrl) {
      err.setupUrl = `${_orgUrl.replace(/\/$/, '')}/lightning/setup/ObjectManager/${entity}/PageLayouts/${componentId}/view`;
    }
    throw err;
  }

  // Remove the field from every layoutItem in every section/column.
  // Replaced with emptySpace so the column structure stays valid.
  function removeFieldFromLayout(metadata, fieldApiName) {
    let changes = 0;
    const fl = fieldApiName.toLowerCase();

    for (const section of (metadata.layoutSections || [])) {
      for (const col of (section.layoutColumns || [])) {
        if (!Array.isArray(col.layoutItems)) continue;
        col.layoutItems = col.layoutItems.map(item => {
          if (item.field && item.field.toLowerCase() === fl) {
            changes++;
            return { emptySpace: true }; // preserve column structure
          }
          return item;
        });
      }
    }
    return changes;
  }

  // ── FlexiPage fix logic ────────────────────────────────────
  async function fixFlexiPage(componentId, componentName) {
    const res = await bg({
      type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid,
      sobject: 'FlexiPage', id: componentId
    });
    if (res.error) throw new Error(`Could not read "${componentName}": ${_feText(res.error)}`);

    const metadata = res.Metadata;
    if (!metadata) throw new Error(`"${componentName}" returned no metadata.`);

    // F6: snapshot before the in-place mutation.
    await _snapshotFix('FlexiPage', componentId, componentName, res.FullName || res.fullName, metadata);

    const changes = removeFieldFromFlexiPage(metadata, _selObj.api, _selField.api);
    if (changes === 0) {
      throw new Error(
        `No direct field references found in "${componentName}". ` +
        'The dependency may be inside a custom component — remove manually in App Builder.'
      );
    }

    const patchRes = await bg({
      type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid,
      path: `services/data/v62.0/tooling/sobjects/FlexiPage/${componentId}`,
      body: { Metadata: metadata }
    });
    if (patchRes.error) throw new Error(`Could not save "${componentName}": ${_feText(patchRes.error)}`);
  }

  // Remove field references from a FlexiPage metadata object.
  // Handles two patterns:
  //   1. componentVisibilityRule criteria that test the field value
  //      → remove those criteria (if all criteria removed, delete the whole rule)
  //   2. componentInstance directly bound to the field (e.g. field-level components)
  //      → remove the entire component instance
  function removeFieldFromFlexiPage(metadata, objApi, fieldApiName) {
    let changes = 0;
    const fl  = fieldApiName.toLowerCase();
    const obj = objApi.toLowerCase();

    // Patterns that indicate a reference to the field
    function refMatches(str) {
      if (str == null) return false;
      const s = String(str).toLowerCase()
        .replace(/^\{!/, '').replace(/\}$/, ''); // strip {! ... } merge syntax
      return (
        s === fl ||
        s === `${obj}.${fl}` ||
        s === `objectrecord.${fl}` ||
        s === `$record.${fl}` ||
        s.endsWith(`.${fl}`)
      );
    }

    function cleanVisibilityRule(rule) {
      if (!rule?.criteria?.length) return rule;
      const before = rule.criteria.length;
      rule.criteria = rule.criteria.filter(c =>
        !refMatches(c.leftValue) && !refMatches(c.rightValue?.value)
      );
      changes += before - rule.criteria.length;

      if (rule.criteria.length === 0) return null; // delete rule → always visible

      // We removed criteria → the saved booleanFilter's indices are now stale.
      // Drop it entirely so Salesforce falls back to its default (AND of the
      // remaining criteria). Rebuilding it as an AND chain would silently
      // change OR / mixed logic, so dropping is the safe, predictable choice.
      if (rule.criteria.length !== before && rule.booleanFilter) {
        delete rule.booleanFilter;
      }
      return rule;
    }

    // Recursively clean a container. Two FlexiPage schemas exist in the wild:
    //   • OLD:           region.componentInstances[]    (each = a component)
    //   • NEW (Dynamic Forms): region.itemInstances[]   (each = { componentInstance: … } OR
    //                                                   { fieldInstance: … })
    // Both are handled below so the auto-fix works regardless of when the page
    // was created.
    function cleanContainer(container) {
      if (!container || typeof container !== 'object') return;

      // ── OLD schema: componentInstances (direct array of components) ──
      if (Array.isArray(container.componentInstances)) {
        container.componentInstances = container.componentInstances.filter(ci => {
          if (isFieldComponentInstance(ci)) { changes++; return false; }
          cleanInstanceVisibility(ci);
          cleanContainer(ci); // recurse into nested instances / field sections
          return true;
        });
      }

      // ── NEW schema: itemInstances[] — each wraps a single componentInstance
      //    or fieldInstance (singular). Removing a field means dropping the
      //    whole itemInstances entry (not just emptying the inner field).
      if (Array.isArray(container.itemInstances)) {
        container.itemInstances = container.itemInstances.filter(item => {
          // Dynamic-Forms field item — drop if its fieldItem references the field.
          if (item.fieldInstance && refMatches(item.fieldInstance.fieldItem)) {
            changes++; return false;
          }
          // Component item (classic field bound via componentInstanceProperties).
          if (item.componentInstance) {
            if (isFieldComponentInstance(item.componentInstance)) { changes++; return false; }
            cleanInstanceVisibility(item.componentInstance);
            cleanContainer(item.componentInstance); // nested itemInstances
          }
          // Clean visibility rule on a surviving fieldInstance (filter conditions
          // that referenced the field).
          if (item.fieldInstance) {
            cleanInstanceVisibility(item.fieldInstance);
          }
          return true;
        });
      }

      // ── Legacy plural form sometimes seen: fieldInstances[] direct array ──
      if (Array.isArray(container.fieldInstances)) {
        container.fieldInstances = container.fieldInstances.filter(fi => {
          if (refMatches(fi.fieldItem)) { changes++; return false; }
          cleanInstanceVisibility(fi);
          return true;
        });
      }

      // ── nested regions ──────────────────────────────────────────
      if (Array.isArray(container.flexiPageRegions)) {
        container.flexiPageRegions.forEach(cleanContainer);
      }
    }

    // Helper: a component instance directly bound to the field via its
    // componentInstanceProperties[].fieldApiName / field / fieldName.
    function isFieldComponentInstance(ci) {
      const props = ci && ci.componentInstanceProperties;
      if (!Array.isArray(props)) return false;
      return props.some(p =>
        ['fieldApiName', 'field', 'fieldName'].includes(p.name) && refMatches(p.value)
      );
    }
    // Helper: scrub field references out of an instance's visibility rule.
    function cleanInstanceVisibility(inst) {
      if (!inst || !inst.componentVisibilityRule) return;
      const cleaned = cleanVisibilityRule(inst.componentVisibilityRule);
      if (cleaned === null) delete inst.componentVisibilityRule;
      else inst.componentVisibilityRule = cleaned;
    }

    for (const region of (metadata.flexiPageRegions || [])) {
      cleanContainer(region);
    }

    return changes;
  }

  // ── Setup links ────────────────────────────────────────────
  function openSetup(type) {
    if (!_orgUrl) return;
    const obj = encodeURIComponent(_selObj?.api || '');
    const paths = {
      FlexiPage:      '/lightning/setup/FlexiPageList/home',
      Layout:         `/lightning/setup/ObjectManager/${obj}/PageLayouts/view`,
      ListView:       `/lightning/o/${obj}/list`,
      ValidationRule: `/lightning/setup/ObjectManager/${obj}/ValidationRules/view`,
      ApexClass:      '/lightning/setup/ApexClasses/home',
      ApexTrigger:    '/lightning/setup/ApexTriggers/home',
      WorkflowRule:   '/lightning/setup/WorkflowRules/home',
      CompactLayout:  `/lightning/setup/ObjectManager/${obj}/CompactLayouts/view`,
      QuickAction:    `/lightning/setup/ObjectManager/${obj}/ButtonsLinksActions/view`,
      MatchingRule:   '/lightning/setup/MatchingRules/home',
      WorkflowFieldUpdate: '/lightning/setup/WorkflowFieldUpdates/home',
    };
    const url = _orgUrl.replace(/\/$/, '') + (paths[type] || '/lightning/setup/SetupOneHome/home');
    chrome.tabs.create({ url });
  }

  // ── Delete field ───────────────────────────────────────────
  // Uses the shared destructive-confirm (C4): names the field, states the
  // 15-day-Recycle-Bin-then-gone reality, requires the permanent checkbox,
  // and carries the F4 CSV-backup offer when data still exists.
  async function confirmDelete(fieldId) {
    if (!fieldId || !_selObj || !_selField) return;
    const hasValues = _dataVerdict && !_dataVerdict.formula && _dataVerdict.filled > 0;
    const ok = await sftkConfirmDestructive({
      title: 'Delete field',
      items: [{ label: `${_selObj.api}.${_selField.api}`, sub: _selField.type }],
      revOverride: {
        html: '⏳ <strong>15-day grace, then permanent</strong> — the field moves to Setup → Deleted Fields (data intact, restorable) and is erased forever after 15 days. Everything referencing it breaks immediately.',
        needsCheckbox: true,
      },
      confirmLabel: '🗑 Delete field',
      extraHtml: hasValues ? `
        <div class="fc-backup-offer">
          💾 <strong>${_dataVerdict.filled.toLocaleString()}${_dataVerdict.sampled ? '+' : ''}</strong>
          record(s) still hold a value. Download them first?
          <button class="btn btn-secondary btn-sm" id="fcBackupBtn" style="margin-left:6px">💾 Back up values (CSV)</button>
        </div>` : '',
      onRender: () => {
        eid('fcBackupBtn')?.addEventListener('click', e => backupFieldValues(e.currentTarget));
      },
    });
    if (ok) doDelete(fieldId);
  }

  // ── F4: CSV backup of field values before delete ────────────────────────
  // Post-delete, values survive only 15 days in the recycle bin. This exports
  // Id + Name (when present) + the field's value for every non-null record to
  // a local CSV — insurance exactly when F1's verdict says CAUTION.
  async function backupFieldValues(btn) {
    if (!_selObj?.api || !_selField?.api) return;
    const obj = _selObj.api, fld = _selField.api;
    const orig = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Exporting…'; }
    try {
      const CAP = 50000;
      // Try with Name (nice for readability); if the object has no Name field
      // Salesforce 400s → retry once with Id + field only.
      let cols = ['Id', 'Name', fld];
      let q = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
        query: `SELECT ${cols.join(',')} FROM ${obj} WHERE ${fld} != null LIMIT ${CAP}` });
      if (q.error && /No such column 'Name'|INVALID_FIELD/i.test(q.error)) {
        cols = ['Id', fld];
        q = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
          query: `SELECT ${cols.join(',')} FROM ${obj} WHERE ${fld} != null LIMIT ${CAP}` });
      }
      if (q.error) {
        if (btn) { btn.textContent = '❌ Backup failed'; _friendlyErrorUnder(btn, q.error); }
        return;
      }
      const rows = q.records || [];
      const esc2 = v => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const header = cols.join(',');
      const body = rows.map(r => cols.map(c => esc2(r[c])).join(',')).join('\r\n');
      const csv = header + '\r\n' + body;
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${obj}.${fld}-backup-${rows.length}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      if (btn) {
        btn.textContent = `✅ ${rows.length.toLocaleString()} row(s) saved${rows.length >= 50000 ? ' (capped 50k)' : ''}`;
      }
    } catch (e) {
      if (btn) { btn.textContent = '❌ Export failed'; }
      if (window.SFToolkitDebug?.enabled) window.SFToolkitDebug.log('fields', 'error', 'CSV backup failed', e.message);
    } finally {
      if (btn && /Export/.test(btn.textContent)) { btn.disabled = false; btn.textContent = orig; }
    }
  }

  // Turn Salesforce's raw delete errors into plain-English guidance.
  function _explainDeleteError(raw) {
    const s = String(raw || '');
    if (/INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY|insufficient access rights on cross-reference/i.test(s)) {
      return 'Salesforce is still blocking this field. Usually one of: (a) a ' +
        'dependency this scan can\'t see (a report, approval process, or ' +
        'sharing rule — see the "not scanned" note above), (b) the field is ' +
        'referenced by a MANAGED package component (read-only), or (c) your ' +
        'user lacks "Customize Application" / "Modify Metadata". Resolve the ' +
        'remaining reference, then retry.';
    }
    if (/in use|cannot delete.*because|referenced/i.test(s)) {
      return 'The field is still referenced somewhere. Fix the listed ' +
        'dependencies above (and check Reports / approval processes / sharing ' +
        'rules, which aren\'t scanned), then re-scan and delete again. ' +
        `(Raw: ${s})`;
    }
    return s;
  }

  async function doDelete(fieldId) {
    const btn = eid('fcDelBtn') || eid('fcDelFreeBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Deleting…'; }

    // W8 — DELETION LOG: snapshot the field's full Metadata BEFORE deleting.
    // The log is the foundation every undo path stands on — the 15-day
    // Setup grace window is only findable if we remember what was deleted
    // where and when, and a post-grace recreate needs the describe. Logging
    // starts NOW so fields deleted before the Undo panel ships are covered.
    let _delLogEntry = null;
    try {
      const cur = await bg({ type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid,
        sobject: 'CustomField', id: fieldId });
      _delLogEntry = { at: new Date().toISOString(), orgUrl: _orgUrl,
        object: _selObj?.api, field: _selField?.api,
        label: _selField?.label || cur?.Metadata?.label || _selField?.api,
        fieldId, metadata: (cur && !cur.error && cur.Metadata) ? cur.Metadata : null };
    } catch (_) {
      _delLogEntry = { at: new Date().toISOString(), orgUrl: _orgUrl,
        object: _selObj?.api, field: _selField?.api, fieldId, metadata: null };
    }

    const res = await bg({
      type: 'SF_TOOLING_DELETE', orgUrl: _orgUrl, sid: _sid,
      sobject: 'CustomField', id: fieldId
    });

    if (res.error) {
      if (btn) { btn.disabled = false; btn.textContent = '🗑 Delete Field'; }
      const errEl = document.createElement('div');
      errEl.className = 'fc-error-msg';
      errEl.innerHTML = `❌ Delete failed: ${esc(_explainDeleteError(res.error))}`;
      eid('fcResults').appendChild(errEl);
    } else {
      // Persist the log entry (success only — a refused delete removed nothing).
      try {
        const d = await chrome.storage.local.get('sftk_fc_deletion_log');
        const log = Array.isArray(d.sftk_fc_deletion_log) ? d.sftk_fc_deletion_log : [];
        log.unshift(_delLogEntry);
        await chrome.storage.local.set({ sftk_fc_deletion_log: log.slice(0, 100) });
      } catch (_) { /* log is best-effort — the delete already happened */ }
      // HONESTY FIX: "permanently deleted" was false — Salesforce keeps
      // deleted fields restorable in Setup for ~15 days. Say the truth and
      // link the way back while it exists.
      const _graceEnd = new Date(Date.now() + 15 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      eid('fcResults').innerHTML = `
        <div class="fc-success">
          <div class="fc-success-icon">✅</div>
          <div class="fc-success-title">Field deleted</div>
          <div class="fc-success-sub">
            ${esc(_selObj.api)}.${esc(_selField.api)} is deleted — and still restorable for ~15 days
            (until about ${esc(_graceEnd)}) via
            <a href="${esc(_orgUrl)}/lightning/setup/ObjectManager/${esc(_selObj.api)}/FieldsAndRelationships/view"
               target="_blank" rel="noopener">Object Manager → Fields</a> → <strong>Deleted Fields</strong>.
            After that it's permanent. A metadata snapshot was saved to the Toolkit's deletion log.
          </div>
        </div>`;
      resetFieldAndBelow();
      if (eid('fcPill'))    eid('fcPill').style.display    = 'none';
      if (eid('fcScanBtn')) eid('fcScanBtn').style.display = 'none';
    }
  }

  // ── XML Inspector ──────────────────────────────────────────

  // Type-specific hint shown between the panel header and the code block.
  const _XI_HINT = {
    Layout:
      'Remove the highlighted <code>&lt;layoutItems&gt;</code> blocks — ' +
      'they bind this field to the layout section.',
    FlexiPage:
      'Remove the highlighted <code>&lt;componentInstances&gt;</code> / ' +
      '<code>&lt;fieldInstances&gt;</code> blocks — they render or filter on this field.',
    Flow:
      'Remove highlighted elements (<code>filters</code>, <code>outputAssignments</code>, ' +
      '<code>inputAssignments</code>, <code>queriedFields</code>) that reference this field.',
    ValidationRule:
      'Rewrite the formula in Object Manager to remove the field reference — ' +
      'the logic must be updated manually.',
    ApexClass:
      'Each highlighted line references this field. Update the code to remove or replace it.',
    ApexTrigger:
      'Each highlighted line references this field. Update the trigger to remove or replace it.',
  };

  // Type-specific deletion-block matcher called as isDeletable(tag, obj, isRef).
  // Returns true → wrap the current XML block in the red "remove this" highlight.
  const _XI_IS_DELETABLE = {
    Layout: (tag, obj, isRef) =>
      tag === 'layoutItems' &&
      typeof obj === 'object' && obj !== null &&
      isRef(obj.field),

    FlexiPage: (tag, obj, isRef) => {
      if (typeof obj !== 'object' || obj === null) return false;
      // Classic field component — XSD uses 'componentInstance' singular inside
      // a region; legacy serialization sometimes uses plural 'componentInstances'.
      if ((tag === 'componentInstance' || tag === 'componentInstances') &&
          (obj.componentInstanceProperties || []).some(p =>
            ['fieldApiName', 'field', 'fieldName'].includes(p.name) && isRef(p.value)
          )) return true;
      // Dynamic Forms field instance — XSD uses 'fieldInstance' singular inside
      // itemInstances[]; legacy direct-array form uses plural 'fieldInstances'.
      if ((tag === 'fieldInstance' || tag === 'fieldInstances') && isRef(obj.fieldItem)) return true;
      return false;
    },

    Flow: (tag, obj, isRef) => {
      if (typeof obj !== 'object' || obj === null) {
        // scalar — covers individual queriedFields API-name strings
        return tag === 'queriedFields' && isRef(obj);
      }
      if (tag === 'filters')            return !!isRef(obj.field);
      if (tag === 'outputAssignments')  return !!isRef(obj.field);
      if (tag === 'inputAssignments')   return !!isRef(obj.field);
      if (tag === 'assignmentItems')
        return !!(isRef(obj.assignToReference) ||
                  isRef(obj.value?.elementReference));
      return false;
    },
  };

  // Shared field-reference test (matches _xiRenderTree's inner isRef) — used
  // by the selective-removal collector so block numbering stays aligned.
  function _xiIsRef(val) {
    const fl = (_selField?.api || '').toLowerCase();
    const objLc = (_selObj?.api || '').toLowerCase();
    if (!val || !fl) return false;
    const v = String(val).toLowerCase().replace(/^\{!/, '').replace(/\}$/, '').trim();
    return v === fl || v === `${objLc}.${fl}` || v === `$record.${fl}` ||
           v === `$record__prior.${fl}` || v.endsWith('.' + fl);
  }

  // Collect deletable blocks in the SAME post-order _xiRenderTree numbers the
  // checkboxes. Each entry records how to detach the node from its parent.
  // out[i] corresponds to checkbox data-idx="i".
  function _collectDeletableNodes(obj, tag, isDeletable, out, container) {
    if (obj === null || obj === undefined) return;
    if (typeof obj !== 'object') {
      if (isDeletable && isDeletable(tag, obj, _xiIsRef)) out.push({ container, node: obj });
      return;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) _collectDeletableNodes(item, tag, isDeletable, out, obj);
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) _collectDeletableNodes(item, k, isDeletable, out, v);
      } else {
        _collectDeletableNodes(v, k, isDeletable, out, { obj, key: k });
      }
    }
    if (isDeletable && isDeletable(tag, obj, _xiIsRef)) out.push({ container, node: obj });
  }

  // Remove only the deletable blocks whose index is in selSet. Reverse order
  // so a selected parent (higher index) is removed after its children; live
  // indexOf survives array shifts. Returns the count removed.
  function _removeSelectedFlowBlocks(metadata, selSet) {
    const out = [];
    _collectDeletableNodes(metadata, 'Flow', _XI_IS_DELETABLE.Flow, out, null);
    let removed = 0;
    for (let i = out.length - 1; i >= 0; i--) {
      if (!selSet.has(i)) continue;
      const { container, node } = out[i];
      if (Array.isArray(container)) {
        const idx = container.indexOf(node);
        if (idx >= 0) { container.splice(idx, 1); removed++; }
      } else if (container && container.obj) {
        delete container.obj[container.key]; removed++;
      }
    }
    return removed;
  }

  // Like fixFlow, but removes only the user-selected blocks (from the XML
  // inspector checkboxes) instead of every reference, then deploys.
  async function fixFlowSelective(flowId, flowName, selSet) {
    const flowRes = await bg({
      type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid, sobject: 'Flow', id: flowId
    });
    if (flowRes.error) throw new Error(`Could not read "${flowName}": ${_feText(flowRes.error)}`);
    const fullName = flowRes.FullName;
    const metadata = flowRes.Metadata;
    if (!fullName || !metadata) throw new Error(`"${flowName}" returned no metadata.`);

    const removed = _removeSelectedFlowBlocks(metadata, selSet);
    if (removed === 0) throw new Error('No blocks were selected to remove.');

    delete metadata.fullName;
    const flowApiName = fullName.replace(/-\d+$/, '');
    const deployRes = await deployFlowViaMetadataApi(flowApiName, metadata);
    if (!deployRes || !deployRes.success) {
      const e = new Error(
        `Removed ${removed} block(s) but couldn't deploy "${flowName}" ` +
        `(${deployRes?.error ? _feText(deployRes.error) : 'deploy failed'}). Open in Flow Builder to finish by hand.`
      );
      if (_orgUrl) e.setupUrl = `${_orgUrl.replace(/\/$/, '')}/builder_platform_interaction/flowBuilder.app?flowId=${flowId}`;
      throw e;
    }
    // Stale versions still referencing the field keep the dependency lock —
    // purge them so the field delete isn't blocked (see purgeOldFlowVersions).
    return purgeOldFlowVersions(flowId, flowName);
  }

  // Toggle the XML inspector panel open/closed for a dependency item.
  async function toggleXmlInspector(type, componentId, componentName, fieldId) {
    const panel    = eid(`fcXml_${componentId}`);
    const inspBtn  = document.querySelector(`.fc-inspect-btn[data-id="${componentId}"]`);
    if (!panel) return;

    // Close if already open
    if (panel.style.display !== 'none') {
      panel.style.display = 'none';
      if (inspBtn) inspBtn.classList.remove('fc-inspect-btn--open');
      return;
    }

    // Open — mark button & show loading state
    if (inspBtn) { inspBtn.classList.add('fc-inspect-btn--open'); inspBtn.disabled = true; }
    panel.style.display = 'block';
    panel.innerHTML = `<div class="fc-xml-loading">${
      window.sftkCatSm ? window.sftkCatSm('Loading metadata…') : '⏳ Loading…'
    }</div>`;

    try {
      const sobject = _INSPECT_SOBJECT[type];
      const res     = await bg({
        type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid,
        sobject, id: componentId
      });
      if (res.error) throw new Error(res.error);

      const cfg     = TYPE_CFG[type] || TYPE_CFG_DEFAULT;
      const fixable = cfg.fixable;
      let bodyHtml, refCount, delCount = 0;

      const isDeletableFn = _XI_IS_DELETABLE[type] || null;

      if (type === 'ApexClass' || type === 'ApexTrigger') {
        // Show Apex source with field refs highlighted line-by-line
        ({ html: bodyHtml, count: refCount } = _xiHighlightApex(res.Body || ''));
        bodyHtml = `<pre class="fc-xml-pre fc-xml-pre--code"><code>${bodyHtml}</code></pre>`;
      } else {
        // Render Metadata JSON as pretty XML with deletion block markers
        const meta = res.Metadata;
        if (!meta) throw new Error('No Metadata returned by the API.');
        // Flows render with per-block checkboxes so the user can trim only
        // the blocks they choose. Other types keep the all-or-nothing fix.
        const selectable = type === 'Flow';
        ({ html: bodyHtml, count: refCount, delCount } =
          _xiRenderTree(meta, type, 0, isDeletableFn, { idx: 0 }, selectable));
        bodyHtml = `<pre class="fc-xml-pre"><code>${bodyHtml}</code></pre>`;
      }

      const badgeCls = refCount ? 'fc-xml-badge--hit' : 'fc-xml-badge--miss';
      let badgeTxt = refCount
        ? `${refCount} field ref${refCount !== 1 ? 's' : ''}`
        : 'no refs found';
      if (delCount > 0) badgeTxt += ` · ${delCount} block${delCount !== 1 ? 's' : ''} to remove`;

      const hintHtml = _XI_HINT[type]
        ? `<div class="fc-xml-hint">${_XI_HINT[type]}</div>`
        : '';

      panel.innerHTML = `
        <div class="fc-xml-hdr">
          <span class="fc-xml-hdr-name">${esc(componentName)}</span>
          <span class="fc-xml-badge ${badgeCls}">${badgeTxt}</span>
          <span class="fc-xml-hdr-actions">
            ${fixable && refCount && type === 'Flow'
              ? `<button class="btn btn-secondary btn-sm fc-xml-fix-sel"
                         data-id="${esc(componentId)}" data-name="${esc(componentName)}">✂ Remove selected (${delCount})</button>`
              : fixable && refCount
                ? `<button class="btn btn-secondary btn-sm fc-fix-btn fc-xml-fix"
                           data-id="${esc(componentId)}" data-name="${esc(componentName)}"
                           data-type="${esc(type)}">✂ Remove</button>`
                : ''}
            <button class="fc-xml-close" data-panelid="${esc(componentId)}">✕</button>
          </span>
        </div>
        ${hintHtml}
        ${bodyHtml}`;

      // Wire close button
      panel.querySelector('.fc-xml-close')?.addEventListener('click', () => {
        panel.style.display = 'none';
        if (inspBtn) inspBtn.classList.remove('fc-inspect-btn--open');
      });

      // Non-flow types: "Remove" runs the all-or-nothing fix.
      panel.querySelector('.fc-xml-fix')?.addEventListener('click', () => {
        panel.style.display = 'none';
        if (inspBtn) inspBtn.classList.remove('fc-inspect-btn--open');
        fixOne(type, componentId, componentName, fieldId);
      });

      // Flows: "Remove selected" trims only the checked blocks, then deploys.
      // Keep the button label's count in sync as the user ticks/unticks.
      const selBtn = panel.querySelector('.fc-xml-fix-sel');
      if (selBtn) {
        // Snapshot how many deletable blocks the panel was rendered with —
        // we compare against the user's selection size after deploy so we
        // can distinguish a FULL fix (all refs removed) from a PARTIAL fix
        // (some refs left behind). A partial fix must NOT mark the item as
        // done, because the flow still references the field.
        const totalDeletable = delCount;
        const syncCount = () => {
          const n = panel.querySelectorAll('.xi-del-check:checked').length;
          // Make the label clearly say "partial" when the user has unticked
          // some boxes — so it's obvious that clicking won't fully resolve.
          if (n === 0) {
            selBtn.textContent = '✂ Remove selected (0)';
          } else if (n < totalDeletable) {
            selBtn.textContent = `✂ Remove ${n} of ${totalDeletable} (partial)`;
          } else {
            selBtn.textContent = `✂ Remove selected (${n})`;
          }
          selBtn.disabled = n === 0;
        };
        panel.querySelectorAll('.xi-del-check').forEach(cb =>
          cb.addEventListener('change', syncCount));
        selBtn.addEventListener('click', async () => {
          const selSet = new Set(
            [...panel.querySelectorAll('.xi-del-check:checked')]
              .map(cb => parseInt(cb.dataset.idx, 10))
          );
          if (!selSet.size) return;
          const isPartial = selSet.size < totalDeletable;
          selBtn.disabled = true; selBtn.textContent = '⏳ Removing…';
          try {
            const purge = await fixFlowSelective(componentId, componentName, selSet);
            if (isPartial) {
              // Don't mark the dependency as resolved — the flow still
              // references the field. Show an inline warning, re-render
              // the inspector against the freshly-deployed metadata so the
              // user can see what's left and trim more if desired.
              _markFlowPartial(componentId, selSet.size, totalDeletable - selSet.size);
              await _refreshXmlInspector(type, componentId, componentName, fieldId);
            } else {
              panel.style.display = 'none';
              if (inspBtn) inspBtn.classList.remove('fc-inspect-btn--open');
              let label = '✅ Done';
              if (purge?.purged)        label += ` · ${purge.purged} old version(s) purged`;
              if (purge?.stillBlocking) label += ` · ⚠ ${purge.stillBlocking} old version(s) couldn't be deleted — may still block the field delete`;
              markFixed(componentId, label, _flowDoneLinks(purge));
            }
          } catch (e) {
            selBtn.disabled = false; syncCount();
            appendInlineError(componentId, e.message, e.setupUrl, '↗ Open in Flow Builder');
          }
        });
      }

      // Add prev/next navigation for field references
      if (refCount > 0) _addXmlNavigation(panel);

      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      const fe = sftkFriendlyError(e.message);
      panel.innerHTML = `<div class="fc-xml-err" title="${esc(fe.raw)}">❌ ${esc(fe.message + (fe.hint ? ' — ' + fe.hint : ''))}</div>`;
    } finally {
      if (inspBtn) inspBtn.disabled = false;
    }
  }

  // Render a JSON metadata object as syntax-highlighted XML HTML.
  // Returns { html, count, delCount } where:
  //   count    = number of field-ref occurrences highlighted
  //   delCount = number of XML blocks marked for deletion
  // isDeletable(tag, obj, isRef) → boolean — type-specific deletion matcher
  function _xiRenderTree(obj, tag, depth, isDeletable, ctx, selectable) {
    if (depth > 28 || obj === null || obj === undefined) {
      return { html: '', count: 0, delCount: 0 };
    }
    ctx = ctx || { idx: 0 };
    // Checkbox prefix for a deletable block — lets the user pick which blocks
    // to trim. Numbered in post-order so the index matches the remover.
    const delCheck = () => selectable
      ? `<input type="checkbox" class="xi-del-check" data-idx="${ctx.idx++}" checked title="Remove this block">`
      : '';

    const pad   = '  '.repeat(depth);
    const fl    = (_selField?.api || '').toLowerCase();
    const objLc = (_selObj?.api  || '').toLowerCase();

    function isRef(val) {
      if (!val || !fl) return false;
      const v = String(val).toLowerCase()
                  .replace(/^\{!/, '').replace(/\}$/, '').trim();
      return (
        v === fl ||
        v === `${objLc}.${fl}` ||
        v === `$record.${fl}`  ||
        v === `$record__prior.${fl}` ||
        v.endsWith('.' + fl)
      );
    }

    const oT = `<span class="xi-tag">&lt;${esc(tag)}&gt;</span>`;
    const cT = `<span class="xi-tag">&lt;/${esc(tag)}&gt;</span>`;

    // ── Scalar leaf ───────────────────────────────────────────────
    if (typeof obj !== 'object') {
      const hit = isRef(obj);
      const valHtml = hit
        ? `<span class="xi-ref">${esc(String(obj))}</span>`
        : `<span class="xi-val">${esc(String(obj))}</span>`;
      const line = `${pad}${oT}${valHtml}${cT}\n`;
      // Scalar nodes (e.g. individual queriedFields strings) can also be deletable
      if (hit && isDeletable && isDeletable(tag, obj, isRef)) {
        return {
          html:     `<span class="xi-del-block">${delCheck()}${line}</span>`,
          count:    1,
          delCount: 1,
        };
      }
      return { html: line, count: hit ? 1 : 0, delCount: 0 };
    }

    // ── Array — repeat the parent tag for each element ────────────
    if (Array.isArray(obj)) {
      let html = '', count = 0, delCount = 0;
      for (const item of obj) {
        const r = _xiRenderTree(item, tag, depth, isDeletable, ctx, selectable);
        html += r.html; count += r.count; delCount += r.delCount;
      }
      return { html, count, delCount };
    }

    // ── Object — recurse into child keys ──────────────────────────
    let innerHtml = '', innerCount = 0, innerDel = 0;
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) {
          const r = _xiRenderTree(item, k, depth + 1, isDeletable, ctx, selectable);
          innerHtml += r.html; innerCount += r.count; innerDel += r.delCount;
        }
      } else {
        const r = _xiRenderTree(v, k, depth + 1, isDeletable, ctx, selectable);
        innerHtml += r.html; innerCount += r.count; innerDel += r.delCount;
      }
    }

    const blockHtml = `${pad}${oT}\n${innerHtml}${pad}${cT}\n`;
    const delThis   = isDeletable && isDeletable(tag, obj, isRef);
    if (delThis) {
      return {
        html:     `<span class="xi-del-block">${delCheck()}${blockHtml}</span>`,
        count:    innerCount,
        delCount: innerDel + 1,
      };
    }
    return { html: blockHtml, count: innerCount, delCount: innerDel };
  }

  // Highlight field API name occurrences inside Apex source code.
  // Each matching LINE is wrapped in xi-line-hit for a full-line background.
  // Returns { html: string, count: number, delCount: 0 }.
  function _xiHighlightApex(body) {
    if (!body || !_selField?.api) return { html: esc(body), count: 0, delCount: 0 };
    const fieldPat = _selField.api.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(${fieldPat})`, 'gi');
    let count = 0;
    const html = esc(body).split('\n').map(line => {
      if (!re.test(line)) { re.lastIndex = 0; return line; }
      re.lastIndex = 0;
      const highlighted = line.replace(re, m => {
        count++;
        return `<span class="xi-ref">${m}</span>`;
      });
      return `<span class="xi-line-hit">${highlighted}</span>`;
    }).join('\n');
    return { html, count, delCount: 0 };
  }

  // ── XML reference navigator ─────────────────────────────────
  // Inserts a prev/next bar above the <pre> and auto-jumps to ref #1.
  function _addXmlNavigation(panel) {
    const pre  = panel.querySelector('.fc-xml-pre');
    if (!pre) return;
    const refs = Array.from(pre.querySelectorAll('.xi-ref'));
    if (!refs.length) return;

    let cur = -1;

    const nav = document.createElement('div');
    nav.className = 'fc-xml-nav';
    nav.innerHTML =
      `<span class="fc-xml-nav-label">🔍 References</span>` +
      `<button class="fc-xml-nav-btn fc-xml-nav-prev" title="Previous reference">◀ Prev</button>` +
      `<span class="fc-xml-nav-count">— / ${refs.length}</span>` +
      `<button class="fc-xml-nav-btn fc-xml-nav-next" title="Next reference">Next ▶</button>`;
    pre.insertAdjacentElement('beforebegin', nav);

    const countEl = nav.querySelector('.fc-xml-nav-count');

    function goTo(i) {
      if (cur >= 0 && refs[cur]) refs[cur].classList.remove('xi-ref--active');
      cur = ((i % refs.length) + refs.length) % refs.length;
      refs[cur].classList.add('xi-ref--active');
      refs[cur].scrollIntoView({ behavior: 'smooth', block: 'center' });
      countEl.textContent = `${cur + 1} / ${refs.length}`;
    }

    nav.querySelector('.fc-xml-nav-prev')
       .addEventListener('click', () => goTo(cur <= 0 ? refs.length - 1 : cur - 1));
    nav.querySelector('.fc-xml-nav-next')
       .addEventListener('click', () => goTo(cur < 0 ? 0 : cur + 1));

    // Auto-jump to first reference on open
    goTo(0);
  }

  // ── F6: pre-fix metadata snapshots + one-click restore ───────────────────
  // Every auto-fix (flow / layout / Lightning page) stores the ORIGINAL
  // metadata before modifying it. The 🧾 Cleanup history section lists the
  // last 20 changes with ↩ Restore, which redeploys the untouched snapshot
  // through the same deploy paths the fixes use. Doubles as an audit trail.
  const SNAP_KEY = 'fc_fix_snapshots';
  const SNAP_CAP = 20;

  async function _snapshotFix(type, id, name, fullName, metadata) {
    try {
      const store = await chrome.storage.local.get(SNAP_KEY);
      const list = store[SNAP_KEY] || [];
      list.unshift({
        at: Date.now(),
        orgKey: sftkOrgKey(_orgUrl), orgUrl: _orgUrl,
        type, id, name, fullName: fullName || null,
        obj: _selObj?.api, field: _selField?.api,
        metadata: JSON.parse(JSON.stringify(metadata)),   // deep copy — fixers mutate in place
      });
      await chrome.storage.local.set({ [SNAP_KEY]: list.slice(0, SNAP_CAP) });
      renderSnapshotLog();
    } catch (e) {
      // Snapshot failure must never block the fix itself.
      if (window.SFToolkitDebug?.enabled) window.SFToolkitDebug.log('fields', 'error', 'snapshot failed', e.message);
    }
  }

  async function renderSnapshotLog() {
    const el = eid('fcSnapLog');
    if (!el) return;
    const store = await chrome.storage.local.get(SNAP_KEY);
    const all = store[SNAP_KEY] || [];
    const mine = _orgUrl ? all.filter(s => s.orgKey === sftkOrgKey(_orgUrl)) : all;
    if (!mine.length) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <details class="fc-snaplog">
        <summary>🧾 Cleanup history — ${mine.length} change${mine.length === 1 ? '' : 's'} with restore points</summary>
        <div class="fc-snap-rows">
          ${mine.map(s => `
            <div class="fc-snap-row">
              <span class="fc-snap-when">${new Date(s.at).toLocaleString()}</span>
              <span class="fc-snap-what">${esc(s.type)} <strong>${esc(s.name)}</strong>
                <small>(${esc(s.obj || '?')}.${esc(s.field || '?')} removed)</small></span>
              <button class="btn btn-sm fc-snap-restore" data-snap-at="${s.at}"
                title="Redeploy the metadata exactly as it was BEFORE this fix">↩ Restore</button>
            </div>`).join('')}
        </div>
      </details>`;
    el.querySelectorAll('.fc-snap-restore').forEach(btn => {
      btn.addEventListener('click', () => {
        const snap = mine.find(s => String(s.at) === btn.dataset.snapAt);
        if (snap) restoreSnapshot(snap, btn);
      });
    });
  }

  async function restoreSnapshot(snap, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Restoring…'; }
    try {
      const md = JSON.parse(JSON.stringify(snap.metadata));
      if (snap.type === 'Flow') {
        if (!snap.fullName) throw new Error('Snapshot has no FullName — cannot deploy');
        const r = await deployFlowViaMetadataApi(snap.fullName, md);
        if (!r || r.error || r.success === false) throw new Error(r?.error || 'Deploy failed');
      } else if (snap.type === 'Layout') {
        const patchRes = await patchLayoutMetadata(snap.id, sanitizeLayoutMetadata(md));
        if (patchRes.error) {
          if (!snap.fullName) throw new Error(patchRes.error);
          const r = await deployLayoutViaMetadataApi(snap.fullName, JSON.parse(JSON.stringify(snap.metadata)));
          if (!r || !r.success) throw new Error(r?.error || patchRes.error);
        }
      } else if (snap.type === 'FlexiPage') {
        const r = await bg({ type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid,
          path: `services/data/v62.0/tooling/sobjects/FlexiPage/${snap.id}`,
          body: { Metadata: md } });
        if (r?.error) throw new Error(r.error);
      } else {
        throw new Error(`Unknown snapshot type ${snap.type}`);
      }
      if (btn) { btn.textContent = '✅ Restored'; }
    } catch (e) {
      if (btn) {
        btn.disabled = false; btn.textContent = '↩ Restore';
        _friendlyErrorUnder(btn, e.message || e);
      }
    }
  }

  // Test-only surface (harness). Lets a headless test drive renderResults with
  // synthetic dependency records without the object/field picker flow.
  const _test = {
    renderResults,
    setSel: (obj, field, orgUrl) => { _selObj = obj; _selField = field; if (orgUrl) _orgUrl = orgUrl; },
    getManualBlockers: () => _manualBlockers,
    deprecateField, undoDeprecation, renderFlsPanel, renderDeprecationZone,
    snapshotFix: _snapshotFix, renderSnapshotLog, restoreSnapshot,
  };
  return { init, updateSession, _test };
})();
