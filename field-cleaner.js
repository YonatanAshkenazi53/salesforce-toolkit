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
  // ⇄ Replace with another field (sftk-fieldreplace.js, user 2026-10-04: "what
  // if we want to remove the old field and assign a new field instead with
  // the same type?"). While a replacement is chosen, every automatic fix
  // MOVES the reference to it instead of removing it.
  let _replField  = null;  // { api, label, type, desc } — desc is its describe entry
  let _replCompat = null;  // sftkFieldReplaceCompat's verdict for (_selField → _replField)
  let _replSeq    = 0;     // a newer field selection wins over a describe still in flight
  const _descCache = new Map();   // object api (lower) → Promise of its describe
  let _allObjects = [];
  let _allFields  = [];
  let _objectsLoaded = false;
  // Session-only: Feed/Share/History/ChangeEvent objects stay hidden until the
  // user asks for them in the picker.
  let _objShowSystem = false;
  let _groups    = {};     // type → [dep records] — kept for fixAll
  let _mcdCapped = false;  // last MCD query landed on the 2,000-row cap

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
    _descCache.clear(); _replField = null; _replCompat = null;
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

        <!-- Step 3 (optional): move the references to another field instead of removing them -->
        <div class="fc-step" id="fcReplStep" style="display:none">
          <div class="fc-step-label">3 — Replace it with another field <span class="fc-step-opt">optional</span></div>
          <div class="fc-repl-help">Leave this empty to <b>remove</b> the field's references. Pick a field of the same type to <b>move</b> them to it instead: flows keep their logic, layouts and Lightning pages keep the slot, reports keep the column.</div>
          <div class="fc-picker-wrap" id="fcReplWrap">
            <input id="fcReplInput" class="fc-input" placeholder="Loading fields of the same type…" autocomplete="off" disabled>
            <div id="fcReplDrop" class="fc-dropdown" style="display:none"></div>
          </div>
          <div id="fcReplNote" class="fc-repl-note" style="display:none"></div>
        </div>

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
      if (!e.target.closest('#fcReplWrap'))  closeDropdown('fcReplDrop');
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
    _replField = null; _replCompat = null; _replSeq++;
    _copyState = null; _copySeq++;
    _rptScan = null; _lastScan = null;
    const replStep = eid('fcReplStep');
    if (replStep) replStep.style.display = 'none';
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
    setupReplacePicker();
  }

  // ── ⇄ Replace with another field (step 3, optional) ─────────────────────
  // The describe of the selected object: precise types, lengths, lookup
  // targets and picklist values — what "the same type" is judged from. One
  // read per object per popup; a failed read is not remembered.
  function _describeObj(api) {
    const k = String(api || '').toLowerCase();
    if (!_descCache.has(k)) {
      const p = bg({ type: 'SF_REST_GET', orgUrl: _orgUrl, sid: _sid, _suppressError: true,
        path: `services/data/v62.0/sobjects/${encodeURIComponent(api)}/describe` })
        .then(d => { if (!d || d.error || !Array.isArray(d.fields)) _descCache.delete(k); return d; });
      _descCache.set(k, p);
    }
    return _descCache.get(k);
  }
  function _replOn() { return !!(_selField && _replField && _replCompat && _replCompat.ok); }
  function _replReadOnly() { const d = _replField && _replField.desc; return !!(d && (d.calculated || d.updateable === false)); }
  // What a row's fix button says. An inactive flow version is only ever
  // deleted, so its button keeps saying so.
  function _fixBtnLabel(type, componentId) {
    if (!_replOn()) return '✂ Remove';
    if (type === 'Flow') {
      const vi = _flowVerInfo[String(componentId).substring(0, 15)];
      return vi && vi.status !== 'Active' ? '✂ Remove' : '⇄ Replace';
    }
    return '⇄ Replace';
  }
  function _groupNote(type, cfg) { return (_replOn() && cfg.replNote) ? cfg.replNote.replace('{new}', _replField.api) : cfg.note; }
  // The mode changed (a replacement was picked or cleared): every idle fix
  // button, bulk button and group note says what it will now do.
  function _applyReplMode() {
    const results = eid('fcResults');
    if (!results) return;
    results.querySelectorAll('.fc-fix-btn:not(.fc-xml-fix):not([disabled])').forEach(b => { b.textContent = _fixBtnLabel(b.dataset.type, b.dataset.id); });
    results.querySelectorAll('.fc-xml-fix').forEach(b => { b.textContent = _fixBtnLabel(b.dataset.type, b.dataset.id); });
    results.querySelectorAll('.fc-fix-all').forEach(b => { b.textContent = `${_replOn() ? '⇄ Replace in' : '✂ Remove from'} all ${b.dataset.n} ${b.dataset.label}`; });
    results.querySelectorAll('.fc-group-note-text').forEach(n => { const t = n.dataset.type; n.textContent = _groupNote(t, TYPE_CFG[t] || TYPE_CFG_DEFAULT); });
    const bar = eid('fcReplBar');
    if (bar) bar.outerHTML = _replBarHtml();
    if (eid('fcFlsPanel')) renderFlsPanel();
    renderCopyValues();
  }
  function _replBarHtml() {
    return _replOn()
      ? `<div id="fcReplBar" class="fc-repl-bar">⇄ <strong>Replace mode</strong> — references move to <code>${esc(_selObj.api)}.${esc(_replField.api)}</code>. The buttons below say ⇄ Replace where a reference can be moved; everything else is unchanged.</div>`
      : '<div id="fcReplBar" style="display:none"></div>';
  }
  function _replNoteHtml() {
    if (!_replField) return '';
    const c = _replCompat || { ok: false, blockers: ['not checked'], warnings: [] };
    const head = c.ok
      ? `⇄ References to <code>${esc(_selField.api)}</code> will be moved to <code>${esc(_replField.api)}</code> <span class="fc-pill-type">${esc(_replField.type)}</span>`
      : `✋ <code>${esc(_replField.api)}</code> cannot stand in for <code>${esc(_selField.api)}</code>`;
    const list = arr => arr.length ? `<ul>${arr.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
    return `<div class="${c.ok ? 'fc-repl-ok' : 'fc-repl-bad'}">${head}
        <button type="button" class="fc-dd-linkbtn" id="fcReplClear">✕ Clear</button>
        ${list(c.blockers)}
        ${c.ok && c.warnings.length ? `<div class="fc-repl-warn">⚠ Check before you replace:${list(c.warnings)}</div>` : ''}
        ${c.ok ? '<div class="fc-repl-sub">This moves REFERENCES. The values stored in the old field are a separate step: after the scan, 📦 Stored values compares the two fields and offers to copy them.</div>' : ''}
      </div>`;
  }
  function _setReplField(entry) {
    _replField = entry || null;
    const input = eid('fcReplInput');
    const note = eid('fcReplNote');
    if (!entry) { _replCompat = null; if (input) input.value = ''; }
    if (note) {
      note.innerHTML = _replNoteHtml();
      note.style.display = entry ? '' : 'none';
      eid('fcReplClear')?.addEventListener('click', () => _setReplField(null));
    }
    _applyReplMode();
  }
  async function setupReplacePicker() {
    const seq = ++_replSeq;
    _replField = null; _replCompat = null;
    const step = eid('fcReplStep'), input = eid('fcReplInput'), drop = eid('fcReplDrop'), note = eid('fcReplNote');
    if (!step || !input || !drop || !note) return;
    step.style.display = '';
    input.value = ''; input.disabled = true; input.placeholder = 'Loading fields of the same type…';
    drop.style.display = 'none'; note.style.display = 'none'; note.innerHTML = '';
    const d = await _describeObj(_selObj.api);
    if (seq !== _replSeq) return;                       // a newer selection won
    const off = why => { input.placeholder = 'Not available for this field'; note.innerHTML = `<div class="fc-repl-bad">${why}</div>`; note.style.display = ''; };
    if (!d || d.error || !Array.isArray(d.fields)) {
      const fe = sftkFriendlyError((d && d.error) || 'no answer');
      off(`Replacing is not available: the object's fields could not be read (${esc(fe.message)}). Removing references works as before.`);
      return;
    }
    const oldDesc = d.fields.find(f => String(f.name).toLowerCase() === _selField.api.toLowerCase());
    if (!oldDesc) {
      off(`Replacing is not available: <code>${esc(_selField.api)}</code> is not in your user's view of ${esc(_selObj.api)} (no field-level security for you), so its type cannot be compared with another field. Give yourself access to it, then pick the field again.`);
      return;
    }
    const cands = d.fields
      .filter(f => sftkFieldReplaceCompat(oldDesc, f).ok)
      .map(f => ({ api: f.name, label: f.label, type: f.type, desc: f }));
    if (!cands.length) {
      off(`No other field of ${esc(_selObj.api)} has the same type (${esc(oldDesc.type)}${oldDesc.type === 'reference' ? ` → ${esc((oldDesc.referenceTo || []).join(', '))}` : ''}) — create the new field first (and give yourself access to it), then pick the field again.`);
      return;
    }
    // A fresh node each time: a new field selection must not stack listeners.
    const inp = input.cloneNode(true);
    delete inp.dataset.fcKeys;
    input.replaceWith(inp);
    inp.disabled = false;
    inp.placeholder = `Type to search ${cands.length} field${cands.length === 1 ? '' : 's'} of the same type…`;
    const pick = item => {
      const c = cands.find(x => x.api === item.dataset.api);
      if (!c) return;
      inp.value = `${c.label} (${c.api})`;
      drop.style.display = 'none';
      inp.setAttribute('aria-expanded', 'false');
      _replCompat = sftkFieldReplaceCompat(oldDesc, c.desc);
      _setReplField(c);
    };
    const render = filter => {
      const rows = fcRankEntries(cands, filter).slice(0, 80);
      const prevActive = drop.querySelector('.fc-dd-item.fc-dd-active')?.dataset.api || null;
      drop.innerHTML = rows.length
        ? rows.map(f => `<div class="fc-dd-item" data-api="${esc(f.api)}"><span class="fc-dd-main">${esc(f.label)}</span><span class="fc-dd-sub">${esc(f.api)}</span><span class="fc-dd-type">${esc(f.type)}</span></div>`).join('')
        : '<div class="fc-dd-empty">No field of the same type matches</div>';
      fcRestoreActiveRow(drop, inp, prevActive);
      drop.querySelectorAll('.fc-dd-item').forEach(item => item.addEventListener('mousedown', e => { e.preventDefault(); pick(item); }));
      fcWireDropdownKeys(inp, drop, pick);
      drop.style.display = '';
      inp.setAttribute('aria-expanded', 'true');
    };
    inp.addEventListener('input', () => { if (!inp.value.trim() && _replField) _setReplField(null); render(inp.value); });
    inp.addEventListener('focus', () => render(_replField ? '' : inp.value));
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
        // A field THIS Toolkit deleted is a known case, not a mystery (user
        // 2026-10-02: the re-scan after a delete said "Could not locate").
        let deleted = null;
        try {
          const d = await chrome.storage.local.get('sftk_fc_deletion_log');
          deleted = (Array.isArray(d.sftk_fc_deletion_log) ? d.sftk_fc_deletion_log : [])
            .find(e => e && e.object === _selObj?.api && e.field === _selField?.api && (!e.orgUrl || !_orgUrl || sftkOrgKey(e.orgUrl) === sftkOrgKey(_orgUrl)));
        } catch (_) { deleted = null; }
        if (deleted) {
          const until = new Date(Date.parse(deleted.at) + 15 * 24 * 3600 * 1000).toISOString().slice(0, 10);
          showScanError(
            `This field was deleted with the Toolkit on ${new Date(deleted.at).toLocaleString()}. Salesforce keeps it in Deleted Fields until about ${until}: ` +
            `Setup → Object Manager → ${_selObj?.api} → Fields & Relationships → Deleted Fields → Undelete (it comes back as ${String(_selField?.api || '').replace(/__c$/, '')}_del__c — rename it), then pick it here again.`
          );
          return;
        }
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
      // MetadataComponentDependency is a BETA Tooling object with a hard
      // 2,000-row server cap that stops paginating silently — a full page
      // means the list may be truncated, and "N dependencies" would read as
      // a total when it is a floor (W7 disclosure).
      _mcdCapped = fcLooksCapped(deps.length);

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

      _rptScan = null;
      _lastScan = { deps: [...deps, ...flexiHits, ...supHits], fieldId };
      await renderResults(_lastScan.deps, fieldId);
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
  // report types ARE in the dependency index (they are TYPE_CFG entries);
  // approval processes and email templates still can't be scanned
  // affordably — renderResults shows a static "check manually" note.
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
                      doneLabel: '✅ Activated',
                      replNote: 'The active version is saved again with every reference pointing at {new} — the flow keeps its logic — then activated and verified. Old versions that still reference the old field are deleted: Salesforce keeps the dependency lock per version.' },
    FlexiPage:      { icon: '📄', label: 'Lightning Pages',  fixable: true, sev: 'silent',
                      note: 'Field references in visibility rules and field components will be removed automatically.',
                      doneLabel: '✅ Page updated',
                      replNote: 'Field components and visibility rules that use the field are pointed at {new}.' },
    Layout:         { icon: '📋', label: 'Page Layouts',     fixable: true, sev: 'silent',
                      note: 'The field will be removed from all layout sections automatically.',
                      doneLabel: '✅ Layout updated',
                      replNote: '{new} takes the field’s place on the layout.' },
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
    // Both come from Salesforce's own dependency index — the same one behind
    // "Where is this used?" — so they cost nothing extra to find (user
    // 2026-09-01: "one of the metadata items that we scan everytime").
    Report:         { icon: '📊', label: 'Reports',          fixable: true, sev: 'silent',
                      note: 'The field is removed from the report’s columns, filters and groupings (a restore point is saved first). Formulas and buckets are never auto-edited and stay listed as manual; an edit that would break the report (its only column or only grouping) is refused with the fix.',
                      doneLabel: '✅ Report updated',
                      replNote: 'Columns, filters and groupings that use the field are pointed at {new} (a restore point is saved first). Formulas and buckets are never auto-edited and stay listed as manual.' },
    ReportType:     { icon: '📑', label: 'Report Types',     fixable: false, sev: 'blocker',
                      note: 'Salesforce exposes no modern API for editing report-type columns — remove the field’s column in Setup → Report Types, then re-scan.' },
    // Live 2026-09-03: the dependency index ACCEPTS these two types, but it
    // is not guaranteed to hold a row for every template or approval that
    // uses a field — so they are listed when reported, and the note below
    // still says to check them by hand.
    EmailTemplate:  { icon: '✉️', label: 'Email Templates',  fixable: false, sev: 'blocker',
                      note: 'Edit the template in Setup and remove the merge field, then re-scan. Templates are listed only when Salesforce’s dependency index reports them.' },
    ApprovalProcess:{ icon: '✅', label: 'Approval Processes', fixable: false, sev: 'blocker',
                      note: 'Edit the approval process in Setup (entry criteria, field updates, step criteria), then re-scan. Listed only when Salesforce’s dependency index reports it.' },
  };
  const TYPE_CFG_DEFAULT = { icon: '🔧', label: 'Other', fixable: false, sev: 'blocker',
    note: 'Review this dependency in Setup before deleting the field.' };

  // F2: unresolved manual blockers (types the extension can't auto-fix that
  // will make Salesforce reject the delete). Read by checkEnableDelete.
  let _manualBlockers = [];

  // F8: honest disclosure of what the scan does NOT cover — the Tooling
  // dependency index doesn't track these, so silent breakage hides here.
  // Reports (live 2026-10-04, trailheads5): the index, queried through the
  // Tooling REST API, returned NO Report rows at all — not for two public
  // reports that used the field, not with an explicit type filter; the Bulk
  // API route answered "sObject type not supported". The note used to claim
  // reports were covered; it now says what is true.
  function _unscannedNoteHtml() {
    return `
      <div class="fc-unscanned-note">
        \u2139\ufe0f <strong>Reports and report types</strong> appear above only when Salesforce\u2019s dependency
        index returns them through its API. In some orgs it returns none (seen live: two public reports
        used a field and neither was listed), so a report that uses this field can be missing here.
        Before deleting, press \ud83d\udcca Scan the reports below (it reads every report itself), or open the field
        in Setup and press \u201cWhere is this used?\u201d \u2014 that page lists reports.
        <strong>Email Templates and Approval Processes</strong> appear above only when that index reports
        them \u2014 Salesforce does not guarantee it does for every template or approval, so check them by hand.
        <strong>Not scanned at all</strong> (no API): criteria-based sharing rules \u2014 these break silently if
        the field is removed. Check them before deleting.
      </div>`;
  }

  // \U0001F4CA Report fix \u2014 rides the everyday dependency scan (user 2026-09-01:
  // "one of the metadata items that we scan everytime"). Per the user's
  // rule (latest Salesforce tech, SOAP last-resort) this is the MODERN
  // Analytics REST API end to end: describe \u2192 pure surgical strip
  // (sftk-reportclean.js) \u2192 restore point \u2192 PATCH \u2192 re-describe to verify.
  // Returns the label fixOne shows; throws with the reason when nothing
  // could be removed.
  async function fixReport(reportId, reportName) {
    const obj = _selObj.api, field = _selField.api;
    const d = await bg({ type: 'SF_REST_GET', orgUrl: _orgUrl, sid: _sid,
      path: `services/data/v62.0/analytics/reports/${reportId}/describe` });
    if (d?.error || !d?.reportMetadata) {
      const err = new Error(d?.error || 'the report could not be read');
      err.setupUrl = `${_orgUrl.replace(/\/$/, '')}/lightning/r/Report/${reportId}/view`;
      throw err;
    }
    // \u21c4 Replace with another field: columns, filters and groupings keep their
    // place and name the new field (sftk-fieldreplace.js).
    const swap = _replOn();
    const swapTo = swap ? _replField.api : '';
    const res = swap
      ? sftkRptReplaceField(d.reportMetadata, obj, field, swapTo, sftkRptTokenMatch, sftkRptFieldHits)
      : sftkRptStripField(d.reportMetadata, obj, field);
    const moved = swap ? res.swapped : res.removed;
    if (!res.changed) {
      const err = new Error(`nothing ${swap ? 'that can be moved automatically' : 'auto-removable'} \u2014 ${res.manual.join('; ') || 'no editable reference found'}`);
      err.setupUrl = `${_orgUrl.replace(/\/$/, '')}/lightning/r/Report/${reportId}/view`;
      throw err;
    }
    // Restore point FIRST \u2014 the fix is only offered with a way back.
    await _snapshotFix('Report', reportId, reportName, null, d.reportMetadata);
    // History (sftk-history.js): one journal for this button press; the
    // undo re-PATCHes the report's pre-fix metadata (the untouched copy
    // sftkRptStripField deep-copied FROM, so d.reportMetadata is still the
    // "before" state here).
    const j = sftkHistoryBegin({ tool: 'Field Cleaner', title: `\ud83d\udcca Report \u2014 "${reportName}" (${obj}.${field} ${swap ? `\u2192 ${swapTo}` : 'removed'})`, orgUrl: _orgUrl });
    let wr;
    try {
      // confirmed-by: fixOne's sftkConfirmDestructive (the only caller)
      // The write discipline (sftk-write.js): the PATCH is the write, the
      // re-describe below is the verify \u2014 never assume clean.
      wr = await sftkWriteVerified({
        describe: `"${reportName}" report`,
        journal: j,
        write: async () => {
          const patch = await bg({ type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid,
            path: `services/data/v62.0/analytics/reports/${reportId}`,
            body: { reportMetadata: res.meta } });
          return patch?.error ? { error: patch.error } : patch;
        },
        verify: async () => {
          // VERIFY \u2014 re-read and state what remains, never assume clean.
          const after = await bg({ type: 'SF_REST_GET', orgUrl: _orgUrl, sid: _sid, _suppressError: true,
            path: `services/data/v62.0/analytics/reports/${reportId}/describe` });
          if (!after || after.error || !after.reportMetadata) {
            return { ok: false, text: `"${reportName}": the report was updated, but the org could not be re-read to confirm what remains \u2014 treat this as unverified.` };
          }
          const left = sftkRptFieldHits(after.reportMetadata, obj, field);
          const parts = [];
          if (moved.columns) parts.push(`${moved.columns} column(s)`);
          if (moved.filters) parts.push(`${moved.filters} filter(s)`);
          if (moved.groupings) parts.push(`${moved.groupings} grouping(s)`);
          let label = `\u2705 Report updated \u00b7 ${swap ? `${parts.join(', ')} now use ${swapTo}` : `removed ${parts.join(', ')}`}`;
          if (res.manual.length) label += ` \u00b7 \u26a0 still manual: ${res.manual.join('; ')}`;
          else if (left && left.any) label += ' \u00b7 \u26a0 some references remain \u2014 re-scan';
          else label += ' \u00b7 verified: no references remain';
          return { ok: !res.manual.length && !(left && left.any), text: label };
        },
      });
      if (!wr.accepted) {
        const err = new Error((wr.raw && wr.raw.error) || 'refused');
        err.setupUrl = `${_orgUrl.replace(/\/$/, '')}/lightning/r/Report/${reportId}/view`;
        throw err;
      }
      return wr.text;
    } finally {
      await sftkHistoryEnd(j, { undo: wr && wr.accepted
        ? { steps: [{
            describe: `Put "${reportName}" report back the way it was before this fix`,
            // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
            msg: { type: 'SF_PATCH', path: `services/data/v62.0/analytics/reports/${reportId}`, body: { reportMetadata: d.reportMetadata } },
            // Salesforce's Analytics REST API offers no SOQL read for report
            // metadata (only this describe endpoint, which the undo runner's
            // query-only re-read cannot call) \u2014 accepted, not re-read.
            verify: null,
          }] }
        : { none: 'nothing was accepted by Salesforce, so there is nothing to undo' } });
    }
  }

  async function renderResults(deps, fieldId) {
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
        <div id="fcCopyVals"></div>
        <div id="fcDepZone"></div>
        <div id="fcFlsPanel"></div>
        ${_unscannedNoteHtml()}
        <div id="fcRptScan"></div>`;
      eid('fcDelFreeBtn').onclick = () => confirmDelete(fieldId);
      runDataUsage();
      renderDeprecationZone(fieldId);
      renderFlsPanel();
      renderReportScan();
      return;
    }

    // Group
    _groups = {};
    for (const d of deps) {
      const t = d.MetadataComponentType || 'Unknown';
      if (!_groups[t]) _groups[t] = [];
      _groups[t].push(d);
    }

    // Flow rows are per VERSION (the dependency index reports each version
    // that mentions the field). Read their number/status once so every row
    // says which version it is and what ✂ will do to it.
    if (_groups.Flow) await _loadFlowVersionInfo(_groups.Flow);

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
      ${_replBarHtml()}
      ${_mcdCapped ? `
      <div class="fc-unscanned-note">
        ⚠ <strong>This list may be truncated.</strong> Salesforce caps the dependency
        index (MetadataComponentDependency, beta) at 2,000 rows and stops silently —
        the scan landed on that boundary, so treat the count as a FLOOR, not a total.
        Fix what's listed, re-scan, and repeat until the count drops below the cap.
      </div>` : ''}
      <div id="fcDataVerdict" class="fc-data-verdict fc-data-loading">${sftkCatSm('Measuring how much data is stored in this field…')}</div>
        <div id="fcCopyVals"></div>
      <div id="fcDepZone"></div>
      <div id="fcFlsPanel"></div>
      ${_unscannedNoteHtml()}
        <div id="fcRptScan"></div>`;

    for (const [type, items] of Object.entries(_groups)) {
      const cfg = TYPE_CFG[type] || { ...TYPE_CFG_DEFAULT, label: type };
      html += `
        <div class="fc-group" id="fcGroup_${esc(type)}">
          <div class="fc-group-hdr">
            <span class="fc-group-icon">${cfg.icon}</span>
            <span class="fc-group-label">${esc(cfg.label)}</span>
            <span class="fc-group-count">${items.length}</span>
          </div>
          <div class="fc-group-note"><span class="fc-group-note-text" data-type="${esc(type)}">${esc(_groupNote(type, cfg))}</span>${
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
                        data-type="${esc(type)}" data-n="${items.length}" data-label="${esc(cfg.label)}"
                        style="margin:2px 0 8px 0">${_replOn() ? '⇄ Replace in' : '✂ Remove from'} all ${items.length} ${esc(cfg.label)}</button>`
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
    renderReportScan();          // the opt-in report sweep
  }

  // ── F5: FLS visibility panel — who can even see this field? ─────────────
  // One FieldPermissions query lists every profile / permission set granting
  // read or edit. Per-row ✂ strips that grant (PermissionsRead/Edit → false).
  async function _queryFls(fieldApi) {
    const res = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
      query: `SELECT Id, ParentId, SobjectType, Field, Parent.Label, Parent.IsOwnedByProfile, Parent.Profile.Name, ` +
             `PermissionsRead, PermissionsEdit FROM FieldPermissions ` +
             `WHERE SobjectType = '${_selObj.api}' AND Field = '${_selObj.api}.${fieldApi || _selField.api}'` });
    if (res.error) return { error: res.error };
    return { rows: res.records || [] };
  }

  let _flsSeq = 0;
  async function renderFlsPanel() {
    const el = eid('fcFlsPanel');
    if (!el || !_selObj?.api || !_selField?.api) return;
    el.innerHTML = sftkCatSm('Checking who can see this field…');
    const seq = ++_flsSeq;
    const { rows, error } = await _queryFls();
    if (seq !== _flsSeq) return;                         // a newer render won
    if (error) {
      const fe = sftkFriendlyError(error);
      el.innerHTML = `<div class="fc-unscanned-note" title="${esc(fe.raw)}">👁 FLS check unavailable: ${esc(fe.message + (fe.hint ? ' — ' + fe.hint : ''))}</div>`;
      return;
    }
    if (!rows.length) {
      el.innerHTML = `<div class="fc-fls-empty">👁 <strong>No profile or permission set grants access</strong> to this field — nobody can see it today.</div>`;
      return;
    }
    // ⇄ Replace with another field: whoever sees the old field must see the
    // new one, or the swapped flow / layout shows them nothing.
    let copyHtml = '', copyPlan = null;
    if (_replOn()) {
      const to = _replField.api;
      const nr = await _queryFls(to);
      if (seq !== _flsSeq) return;
      if (nr.error) {
        const fe = sftkFriendlyError(nr.error);
        copyHtml = `<div class="fc-unscanned-note" title="${esc(fe.raw)}">🔑 Could not read who can see ${esc(to)}: ${esc(fe.message)} — compare the two fields' access in Setup.</div>`;
      } else {
        copyPlan = sftkFlsCopyPlan(rows, nr.rows, _selObj.api, to, { readOnly: _replReadOnly() });
        const n = copyPlan.create.length + copyPlan.update.length;
        copyHtml = n
          ? `<div class="fc-fls-copy" id="fcFlsCopy">🔑 <strong>${n}</strong> of the ${rows.length} below ${n === 1 ? 'does' : 'do'} not give the same access to <code>${esc(to)}</code> yet — ${n === 1 ? 'its' : 'their'} users would not see the new field.
               <button class="btn btn-secondary btn-sm" id="fcFlsCopyBtn">🔑 Copy access to ${esc(to)}</button></div>`
          : `<div class="fc-fls-copy fc-fls-copy-ok" id="fcFlsCopy">🔑 Everyone who can see <code>${esc(_selField.api)}</code> already has the same access to <code>${esc(to)}</code>.</div>`;
      }
    }
    el.innerHTML = `${copyHtml}
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
    eid('fcFlsCopyBtn')?.addEventListener('click', e => _copyFlsAccess(copyPlan, e.currentTarget));
    el.querySelectorAll('.fc-fls-strip').forEach(btn => {
      btn.addEventListener('click', async () => {
        const row = btn.closest('.fc-fls-row');
        const who = row?.querySelector('.fc-fls-name')?.textContent || '';
        const kind = row?.querySelector('.fc-fls-kind')?.textContent || '';
        const gate = await sftkOrgWriteGate(_orgUrl);
        const sure = await sftkConfirmDestructive({
          title: 'Strip field visibility',
          icon: '👁',
          items: [{ label: who, sub: kind }],
          revOverride: { html: 'Remove this grant — the field disappears for these users. The grant can be given back any time in Setup → Field-Level Security.', needsCheckbox: false },
          confirmLabel: '✂ Strip',
          production: gate.production ? { label: gate.label } : null,
        });
        if (!sure) return;
        btn.disabled = true; btn.textContent = '⏳';
        const flsId = btn.dataset.flsId;
        const flsRow = rows.find(r => r.Id === flsId);
        // History (sftk-history.js): one journal for this button press; the
        // undo re-inserts the FieldPermissions row this strip removed.
        const j = sftkHistoryBegin({ tool: 'Field Cleaner', title: `👁 Strip FLS — ${who} (${_selObj.api}.${_selField.api})`, orgUrl: _orgUrl });
        let wr;
        try {
          // confirmed-by: the sftkConfirmDestructive right above
          // The write discipline (sftk-write.js): the update is the write, a
          // re-query of this FieldPermissions row is the verify — Salesforce's
          // own success flag on the response is not trusted alone.
          wr = await sftkWriteVerified({
            describe: 'field-level security grant',
            journal: j,
            write: () => bg({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: _orgUrl, sid: _sid,
              records: [{ attributes: { type: 'FieldPermissions' }, Id: flsId,
                          PermissionsRead: false, PermissionsEdit: false }] }),
            verify: async () => {
              const q = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, _suppressError: true,
                query: `SELECT PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE Id = '${flsId}'` });
              if (!q || q.error) return { ok: false, text: null };
              const row = (q.records || [])[0];
              return { ok: !!row && !row.PermissionsRead && !row.PermissionsEdit, text: null };
            },
          });
        } finally {
          await sftkHistoryEnd(j, { undo: (wr && wr.accepted && flsRow)
            ? { steps: [{
                describe: `Re-grant field-level security to ${who}`,
                // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
                msg: { type: 'SF_REST_POST', path: 'services/data/v62.0/sobjects/FieldPermissions',
                  body: { ParentId: flsRow.ParentId, SobjectType: flsRow.SobjectType, Field: flsRow.Field,
                          PermissionsRead: flsRow.PermissionsRead, PermissionsEdit: flsRow.PermissionsEdit } },
                verify: { query: `SELECT Id FROM FieldPermissions WHERE ParentId = '${String(flsRow.ParentId).replace(/'/g, "\\'")}' AND Field = '${String(flsRow.Field).replace(/'/g, "\\'")}'`,
                  tooling: false, pick: 'records', count: 1,
                  text: { ok: `${who}: access re-granted — verified by re-reading the org`,
                          bad: `${who}: accepted by Salesforce, but the org still shows no grant` } },
              }] }
            : { none: (wr && wr.accepted) ? 'the grant details could not be captured before the strip, so there is nothing to rebuild from' : 'nothing was accepted by Salesforce, so there is nothing to undo' } });
        }
        if (wr.ok) {
          const row = btn.closest('.fc-fls-row');
          if (row) { row.classList.add('fc-fls-stripped'); btn.replaceWith(Object.assign(document.createElement('span'), { textContent: '✅ stripped', className: 'fc-fls-done' })); }
        } else {
          btn.disabled = false; btn.textContent = '❌ retry';
        }
      });
    });
  }

  // ── 📊 The report sweep (opt-in) ─────────────────────────────────────────
  // The everyday scan takes reports from Salesforce's dependency index. Live
  // 2026-10-04 that index returned NO reports at all for two public reports
  // that used the field, so "covered by the scan" was not true. The note says
  // so; this is the other half the user asked for ("both"): on request, read
  // every report's own definition and look for the field. It is never part of
  // the scan itself (user 2026-09-01: no org-wide report read on every scan) —
  // it runs only when the button is pressed, after its cost is stated, with a
  // live count and a Stop.
  const FC_RPT_CONCURRENCY = 4;
  let _lastScan = null;   // { deps, fieldId } — what the last scan put on screen
  let _rptScan  = null;   // { status, list, done, found[], possible[], failed, whyFailed, stop }

  function renderReportScan() {
    const el = eid('fcRptScan');
    if (!el || !_selObj || !_selField) return;
    const s = _rptScan;
    const N = x => Number(x).toLocaleString();
    const link = r => `<a href="${esc(`${_orgUrl.replace(/\/$/, '')}/lightning/r/Report/${r.Id}/view`)}" target="_blank" rel="noopener">${esc(r.Name || r.Id)}</a>`;
    if (!s) {
      const listed = ((_lastScan && _lastScan.deps) || []).filter(d => d.MetadataComponentType === 'Report').length;
      el.innerHTML = `<div class="fc-rpt">📊 <strong>Reports.</strong> ${listed
          ? `Salesforce’s index listed ${N(listed)} above — it does not list every report in every org.`
          : 'Salesforce’s index listed none — in some orgs it lists none at all.'}
        To be sure, this tool can open every report’s definition and look for the field itself.
        <button class="btn btn-secondary btn-sm" id="fcRptCount">📊 Scan the reports…</button></div>`;
      eid('fcRptCount').addEventListener('click', _rptCount);
      return;
    }
    if (s.status === 'counting') { el.innerHTML = `<div class="fc-rpt">${sftkCatSm('Listing the reports you can open…')}</div>`; return; }
    if (s.status === 'error') {
      el.innerHTML = `<div class="fc-rpt fc-rpt-bad" title="${esc(s.error)}">📊 The reports could not be listed: ${esc(_feText(s.error))} <button class="btn btn-secondary btn-sm" id="fcRptCount">↻ Try again</button></div>`;
      eid('fcRptCount').addEventListener('click', _rptCount);
      return;
    }
    if (s.status === 'ready') {
      const n = s.list.length;
      el.innerHTML = n === 0
        ? `<div class="fc-rpt">📊 There are no reports you can open in this org — nothing to scan.</div>`
        : `<div class="fc-rpt">📊 This org has <strong>${N(n)}</strong> report${n === 1 ? '' : 's'} you can open. Reading each definition costs one API call: <strong>${N(n)} API call${n === 1 ? '' : 's'}</strong>, ${FC_RPT_CONCURRENCY} at a time. Reports that only other people can open (their private folders) are not read.
            <button class="btn btn-primary btn-sm" id="fcRptGo">▶ Scan ${N(n)} report${n === 1 ? '' : 's'}</button>
            <button class="btn btn-secondary btn-sm" id="fcRptCancel">Cancel</button></div>`;
      eid('fcRptGo')?.addEventListener('click', _rptRun);
      eid('fcRptCancel')?.addEventListener('click', () => { _rptScan = null; renderReportScan(); });
      return;
    }
    if (s.status === 'running') {
      el.innerHTML = `<div class="fc-rpt"><div class="fc-copy-prog">${sftkCatSm(`Reading reports… ${N(s.done)} of ${N(s.list.length)} · ${N(s.found.length)} use the field${s.failed ? ` · ${N(s.failed)} could not be read` : ''}`)}
        <button class="btn btn-secondary btn-sm" id="fcRptStop"${s.stop ? ' disabled' : ''}>${s.stop ? 'Stopping…' : '⏹ Stop'}</button></div></div>`;
      eid('fcRptStop')?.addEventListener('click', () => { s.stop = true; renderReportScan(); });
      return;
    }
    // done / stopped
    const all = s.done === s.list.length;
    const fresh = s.added || 0;
    el.innerHTML = `<div class="fc-rpt ${all ? 'fc-rpt-ok' : 'fc-rpt-bad'}">📊 <strong>Report scan${all ? '' : ' — STOPPED'}:</strong> read ${N(s.done)} of ${N(s.list.length)} report${s.list.length === 1 ? '' : 's'}${all ? '' : ` — the other ${N(s.list.length - s.done)} were NOT checked`}.
        <strong>${N(s.found.length)}</strong> use${s.found.length === 1 ? 's' : ''} <code>${esc(_selObj.api)}.${esc(_selField.api)}</code>${s.found.length ? (fresh ? ` — ${N(fresh)} added to the list above under Reports` : ' — already listed above under Reports') : ''}.
        ${s.possible.length ? `<div>⚠ ${N(s.possible.length)} mention a field with the same name without saying which object — check by hand: ${s.possible.slice(0, 8).map(link).join(', ')}${s.possible.length > 8 ? '…' : ''}</div>` : ''}
        ${s.failed ? `<div>⚠ ${N(s.failed)} could not be read (${esc(s.whyFailed || 'no reason given')}) — those were NOT checked.</div>` : ''}
        <div class="fc-repl-sub">Reports only other people can open were not read. <button class="fc-dd-linkbtn" id="fcRptCount">↻ Scan again</button></div>
      </div>`;
    eid('fcRptCount')?.addEventListener('click', _rptCount);
  }

  // Step 1: the list (one paginated query) — it is also the exact cost of step 2.
  async function _rptCount() {
    _rptScan = { status: 'counting' };
    renderReportScan();
    const q = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false, _suppressError: true,
      query: 'SELECT Id, Name, FolderName FROM Report ORDER BY Name' });
    if (!_rptScan || _rptScan.status !== 'counting') return;
    if (!q || q.error) { _rptScan = { status: 'error', error: (q && q.error) || 'no answer' }; renderReportScan(); return; }
    _rptScan = { status: 'ready', list: q.records || [], done: 0, found: [], possible: [], failed: 0, whyFailed: '', stop: false, added: 0 };
    renderReportScan();
  }

  // Step 2: every report's definition, a few at a time.
  async function _rptRun() {
    const s = _rptScan;
    if (!s || s.status !== 'ready') return;
    const obj = _selObj.api, field = _selField.api;
    s.status = 'running';
    renderReportScan();
    let next = 0, lastPaint = 0;
    const worker = async () => {
      while (!s.stop && _rptScan === s) {
        const i = next++;
        if (i >= s.list.length) return;
        const r = s.list[i];
        const d = await bg({ type: 'SF_REST_GET', orgUrl: _orgUrl, sid: _sid, _suppressError: true, _silentError: true,
          path: `services/data/v62.0/analytics/reports/${r.Id}/describe` });
        if (!d || d.error || !d.reportMetadata) {
          s.failed++;
          if (!s.whyFailed) s.whyFailed = _feText((d && d.error) || 'no definition returned').slice(0, 160);
        } else {
          const kind = sftkRptScanClass(sftkRptFieldHits(d.reportMetadata, obj, field));
          if (kind === 'definite') s.found.push(r);
          else if (kind === 'possible') s.possible.push(r);
        }
        s.done++;
        if (Date.now() - lastPaint > 250) { lastPaint = Date.now(); if (_rptScan === s) renderReportScan(); }
      }
    };
    await Promise.all(Array.from({ length: FC_RPT_CONCURRENCY }, worker));
    if (_rptScan !== s) return;                      // another field was picked meanwhile
    s.status = s.done === s.list.length ? 'done' : 'stopped';

    // The reports found join the list as ordinary Report rows (the fix button
    // works on them like on any other), unless the index had listed them.
    const have = new Set(((_lastScan && _lastScan.deps) || []).filter(d => d.MetadataComponentType === 'Report').map(d => String(d.MetadataComponentId).substring(0, 15)));
    const rows = s.found.filter(r => !have.has(String(r.Id).substring(0, 15))).map(r => ({
      MetadataComponentId: r.Id, MetadataComponentName: r.Name || r.Id, MetadataComponentType: 'Report',
      RefMetadataComponentId: null, RefMetadataComponentName: field, _supplemental: true }));
    s.added = rows.length;
    if (rows.length && _lastScan) {
      // rows already fixed in this session are not brought back as open work
      const fixed = new Set([...document.querySelectorAll('#fcResults .fc-item-fixed')].map(e => e.id.replace(/^fcItem_/, '')));
      _lastScan.deps = [..._lastScan.deps.filter(d => !fixed.has(String(d.MetadataComponentId))), ...rows];
      await renderResults(_lastScan.deps, _lastScan.fieldId);     // draws this panel again from _rptScan
    } else renderReportScan();
  }

  // ── 📦 Copy the stored values to the replacement field ──────────────────
  // Replace mode moves references; the data stays behind in the old field and
  // is lost with it. This copies it (user 2026-10-04: "yes"). Nothing is read
  // or written until the user asks: the compare is one paginated query whose
  // cost is quoted on the button; the copy states what it writes, runs through
  // sftkWriteVerified with a live count and a Stop, and is judged by reading
  // the records again. The old field is never changed.
  const FC_COPY_CAP  = 100000;   // records compared / written per run
  const FC_COPY_UNDO = 1000;     // History keeps an undo up to this many records
  let _copyState = null;         // { from, to, rows, capped, fillOnly, unfiltered, overwrite, plan, result }
  let _copyStop  = false;
  let _copySeq   = 0;

  // Both fields of every record that holds a value in the old one.
  // fillOnly: only where the new field is still empty (how a run over the cap
  // makes progress). A long-text field cannot be filtered in a query: then
  // every record is read and the empty ones are dropped here.
  async function _copyRead(fillOnly) {
    const obj = _selObj.api, from = _selField.api, to = _replField.api;
    const base = `SELECT Id, ${from}, ${to} FROM ${obj}`;
    let unfiltered = false;
    let q = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false, _suppressError: true,
      query: `${base} WHERE ${from} != null${fillOnly ? ` AND ${to} = null` : ''} ORDER BY Id LIMIT ${FC_COPY_CAP + 1}` });
    if (q && q.error && /filter/i.test(q.error)) {
      unfiltered = true;
      q = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false, _suppressError: true,
        query: `${base} ORDER BY Id LIMIT ${FC_COPY_CAP + 1}` });
    }
    if (!q || q.error) throw new Error((q && q.error) || 'no answer');
    if (q.incomplete) throw new Error(`the read came back incomplete (Salesforce says ${q.incomplete.expected} records, got ${q.incomplete.got})`);
    const all = q.records || [];
    return { rows: all.slice(0, FC_COPY_CAP), capped: all.length > FC_COPY_CAP, unfiltered };
  }

  function renderCopyValues() {
    const el = eid('fcCopyVals');
    if (!el) return;
    if (!_replOn()) { el.innerHTML = ''; _copyState = null; return; }
    const from = _selField.api, to = _replField.api;
    if (_replReadOnly()) {
      el.innerHTML = `<div class="fc-copy">📦 <strong>Stored values</strong> cannot be copied: <code>${esc(to)}</code> cannot be written (a formula or read-only field).</div>`;
      return;
    }
    if (_copyState && _copyState.to === to && _copyState.from === from) { _renderCopyPlan(); return; }
    _copyState = null;
    const known = _dataVerdict && !_dataVerdict.sampled && !_dataVerdict.formula;
    const filled = known ? _dataVerdict.filled : null;
    if (filled === 0) {
      el.innerHTML = `<div class="fc-copy fc-copy-ok">📦 <code>${esc(from)}</code> holds no values — there is nothing to copy to <code>${esc(to)}</code>.</div>`;
      return;
    }
    const calls = filled != null ? Math.max(1, Math.ceil(filled / 2000)) : null;
    el.innerHTML = `<div class="fc-copy">📦 <strong>Stored values.</strong> ${filled != null
        ? `<strong>${filled.toLocaleString()}</strong> record${filled === 1 ? '' : 's'} hold${filled === 1 ? 's' : ''} a value in <code>${esc(from)}</code>.`
        : `How many records hold a value in <code>${esc(from)}</code> is not measured yet.`}
      Replacing moves references only: to keep the data, copy it to <code>${esc(to)}</code> before you delete the field.
      <button class="btn btn-secondary btn-sm" id="fcCopyCompare">📦 Compare the two fields${calls ? ` (≈${calls.toLocaleString()} API call${calls === 1 ? '' : 's'})` : ''}</button></div>`;
    eid('fcCopyCompare').addEventListener('click', _copyCompare);
  }

  async function _copyCompare() {
    const el = eid('fcCopyVals');
    if (!el || !_replOn()) return;
    const seq = ++_copySeq;
    const from = _selField.api, to = _replField.api;
    el.innerHTML = `<div class="fc-copy">${sftkCatSm(`Reading ${from} and ${to} on every record that holds a value…`)}</div>`;
    try {
      let r = await _copyRead(false), fillOnly = false;
      if (r.capped && !r.unfiltered) { r = await _copyRead(true); fillOnly = true; }
      if (seq !== _copySeq || !_replOn() || _replField.api !== to) return;
      if (r.capped && r.unfiltered) throw new Error(`more than ${FC_COPY_CAP.toLocaleString()} records, and this field type cannot be filtered in a query — copy the values with Data Loader instead`);
      _copyState = { from, to, rows: r.rows, capped: r.capped, fillOnly, unfiltered: r.unfiltered, overwrite: false, plan: null, result: null };
      _renderCopyPlan();
    } catch (e) {
      if (seq !== _copySeq) return;
      el.innerHTML = `<div class="fc-copy fc-copy-bad" title="${esc(e.message)}">📦 The two fields could not be compared: ${esc(_feText(e.message))} <button class="btn btn-secondary btn-sm" id="fcCopyCompare">↻ Try again</button></div>`;
      eid('fcCopyCompare')?.addEventListener('click', _copyCompare);
    }
  }

  function _renderCopyPlan() {
    const el = eid('fcCopyVals'), st = _copyState;
    if (!el || !st) return;
    const from = st.from, to = st.to;
    const plan = sftkCopyValuesPlan(st.rows, from, to, { newDesc: _replField.desc });
    st.plan = plan;
    const n = plan.fill.length + (st.overwrite ? plan.over.length : 0);
    const N = x => Number(x).toLocaleString();
    const li = [];
    li.push(`<li>✅ <strong>${N(plan.same)}</strong> already hold${plan.same === 1 ? 's' : ''} the same value in <code>${esc(to)}</code></li>`);
    li.push(`<li>➕ <strong>${N(plan.fill.length)}</strong> ${plan.fill.length === 1 ? 'has' : 'have'} <code>${esc(to)}</code> empty — ${plan.fill.length === 1 ? 'it is' : 'these are'} copied</li>`);
    if (st.fillOnly) li.push(`<li>≠ records where <code>${esc(to)}</code> already holds a value were not read (too many records to compare) and are left as they are</li>`);
    else if (plan.over.length) li.push(`<li>≠ <strong>${N(plan.over.length)}</strong> hold${plan.over.length === 1 ? 's' : ''} a DIFFERENT value in <code>${esc(to)}</code> — left as ${plan.over.length === 1 ? 'it is' : 'they are'} unless you tick:
      <label class="fc-copy-over"><input type="checkbox" id="fcCopyOver"${st.overwrite ? ' checked' : ''}> overwrite ${plan.over.length === 1 ? 'it' : 'them'} with the value of <code>${esc(from)}</code></label></li>`);
    for (const b of plan.blocked) li.push(`<li>✋ <strong>${N(b.count)}</strong> cannot be copied: ${esc(b.reason)}</li>`);
    if (plan.unlisted.length) li.push(`<li>⚠ ${esc(to)} does not list ${plan.unlisted.slice(0, 6).map(u => `“${esc(u.value)}” (${N(u.count)})`).join(', ')}${plan.unlisted.length > 6 ? '…' : ''}. It is not a restricted picklist, so Salesforce accepts them — as values outside its list.</li>`);
    el.innerHTML = `<div class="fc-copy">📦 <strong>Stored values</strong> — <strong>${N(plan.total)}</strong> record${plan.total === 1 ? '' : 's'} hold${plan.total === 1 ? 's' : ''} a value in <code>${esc(from)}</code>${st.capped ? ` <em>(the first ${N(FC_COPY_CAP)} that still need one — run again for the rest)</em>` : ''}:
        <ul class="fc-copy-list">${li.join('')}</ul>
        <button class="btn btn-primary btn-sm" id="fcCopyGo"${n ? '' : ' disabled'}>📦 Copy ${N(n)} value${n === 1 ? '' : 's'} to ${esc(to)}</button>
        <button class="btn btn-secondary btn-sm" id="fcCopyAgain" title="Read both fields again">↻ Compare again</button>
        <div id="fcCopyResult">${st.result || ''}</div>
      </div>`;
    eid('fcCopyOver')?.addEventListener('change', e => { st.overwrite = !!e.target.checked; st.result = null; _renderCopyPlan(); });
    eid('fcCopyGo')?.addEventListener('click', _copyRun);
    eid('fcCopyAgain')?.addEventListener('click', () => { _copyState = null; _copyCompare(); });
  }

  async function _copyRun() {
    const st = _copyState;
    if (!st || !st.plan || !_replOn()) return;
    const obj = _selObj.api, from = st.from, to = st.to;
    const targets = [...st.plan.fill, ...(st.overwrite ? st.plan.over : [])];
    if (!targets.length) return;
    const overN = st.overwrite ? st.plan.over.length : 0;
    const N = x => Number(x).toLocaleString();
    const undoable = targets.length <= FC_COPY_UNDO;
    let wantCsv = true;
    const gate = await sftkOrgWriteGate(_orgUrl);
    const sure = await sftkConfirmDestructive({
      title: `Copy ${N(targets.length)} value${targets.length === 1 ? '' : 's'} to ${to}`,
      icon: '📦',
      items: [
        { label: `${N(st.plan.fill.length)} record${st.plan.fill.length === 1 ? '' : 's'}`, sub: `${to} is empty — gets the value of ${from}` },
        ...(overN ? [{ label: `${N(overN)} record${overN === 1 ? '' : 's'}`, sub: `${to} holds a different value — OVERWRITTEN with the value of ${from}` }] : []),
      ],
      revOverride: {
        html: `Writes <strong>${esc(obj)}.${esc(to)}</strong> on ${N(targets.length)} record${targets.length === 1 ? '' : 's'}. <strong>${esc(from)}</strong> is not changed. Each record is saved like any edit: the object’s flows, triggers, validation rules and duplicate rules run, and its last-modified date changes. A record Salesforce refuses is reported with the reason and left as it is. ` +
          (undoable ? 'Data Studio › History can take this copy back.' : `This run is larger than ${N(FC_COPY_UNDO)} records, so History keeps no undo for it — the receipt below is the way back.`),
        needsCheckbox: true,
        ack: overN ? `I understand ${N(overN)} existing value${overN === 1 ? '' : 's'} in ${to} ${overN === 1 ? 'is' : 'are'} overwritten` : `I understand ${N(targets.length)} record${targets.length === 1 ? ' is' : 's are'} updated`,
      },
      extraHtml: `<label class="sftk-confirm-ack"><input type="checkbox" id="fcCopyCsv" checked> ⬇ Save a receipt first: a CSV of every record, the value written and the value that was there</label>`,
      onRender: () => { const cb = eid('fcCopyCsv'); cb?.addEventListener('change', () => { wantCsv = !!cb.checked; }); },
      confirmLabel: `📦 Copy ${N(targets.length)} value${targets.length === 1 ? '' : 's'}`,
      production: gate.production ? { label: gate.label } : null,
    });
    if (!sure) return;

    if (wantCsv) {
      const blob = new Blob([sftkCopyValuesCsv(to, targets)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${obj}.${to}-copy-receipt-${targets.length}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    _copyStop = false;
    eid('fcCopyGo')?.setAttribute('disabled', '');
    eid('fcCopyAgain')?.setAttribute('disabled', '');
    const box = () => eid('fcCopyResult');
    const okIds = new Set(), reasons = new Map();
    let sent = 0, refused = 0, stopped = false, callErr = null;
    const paint = phase => {
      const b = box(); if (!b) return;
      b.innerHTML = `<div class="fc-copy-prog">${sftkCatSm(`${phase} ${N(sent)} of ${N(targets.length)} sent · ${N(okIds.size)} accepted${refused ? ` · ${N(refused)} refused` : ''}`)}
        <button class="btn btn-secondary btn-sm" id="fcCopyStop">⏹ Stop</button></div>`;
      eid('fcCopyStop')?.addEventListener('click', () => { _copyStop = true; const s = eid('fcCopyStop'); if (s) { s.disabled = true; s.textContent = 'Stopping after this batch…'; } });
    };
    paint('Writing…');

    // History (sftk-history.js): one journal for this copy.
    const j = sftkHistoryBegin({ tool: 'Field Cleaner', title: `📦 Values — ${obj}.${from} → ${to} (${N(targets.length)} record${targets.length === 1 ? '' : 's'})`, orgUrl: _orgUrl });
    let wr = null, check = null, after = null;
    try {
      // confirmed-by: the sftkConfirmDestructive right above
      // The write discipline (sftk-write.js): the whole batched update is ONE
      // write; the verify reads the written records again and compares each
      // with the value it was meant to get.
      wr = await sftkWriteVerified({
        describe: `${to} on ${N(targets.length)} ${obj} record${targets.length === 1 ? '' : 's'}`,
        journal: j,
        write: async () => {
          for (let i = 0; i < targets.length; i += 200) {
            if (_copyStop) { stopped = true; break; }
            const chunk = targets.slice(i, i + 200);
            // verified-by: this loop is the write arm of the sftkWriteVerified around it — the re-read below judges every record
            const res = await bg({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: _orgUrl, sid: _sid, _suppressError: true,
              records: chunk.map(t => ({ attributes: { type: obj }, Id: t.Id, [to]: t.value })) });
            if (!Array.isArray(res)) { callErr = (res && res.error) || 'no answer'; break; }
            res.forEach((r, k) => {
              if (r && r.success) { okIds.add(chunk[k].Id); return; }
              refused++;
              const e0 = (r && r.errors && r.errors[0]) || {};
              const why = `${e0.statusCode ? e0.statusCode + ': ' : ''}${String(e0.message || 'refused').replace(/\s+/g, ' ').slice(0, 160)}`;
              reasons.set(why, (reasons.get(why) || 0) + 1);
            });
            sent += chunk.length;
            paint('Writing…');
          }
          if (callErr && !okIds.size) return { error: callErr };
          return { sent, accepted: okIds.size };
        },
        verify: async () => {
          const wrote = targets.filter(t => okIds.has(t.Id));
          paint('Re-reading the records to confirm…');
          if (!st.fillOnly) {
            const r = await _copyRead(false);
            after = r.rows;
            check = sftkCopyValuesCheck(wrote, after, to);
          } else {
            // over the cap the compare read only shows records that still need a
            // value — so the written ones are read back by Id, 200 at a time
            const got = [];
            for (let i = 0; i < wrote.length; i += 200) {
              const lit = wrote.slice(i, i + 200).map(t => `'${t.Id}'`).join(',');
              const q = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false, _suppressError: true,
                query: `SELECT Id, ${to} FROM ${obj} WHERE Id IN (${lit})` });
              if (!q || q.error) throw new Error((q && q.error) || 'no answer');
              got.push(...(q.records || []));
            }
            check = sftkCopyValuesCheck(wrote, got, to);
          }
          return { ok: wrote.length > 0 && check.ok === wrote.length, detail: check,
            text: `${to}: ${N(check.ok)} of ${N(wrote.length)} written record${wrote.length === 1 ? ' holds' : 's hold'} the value of ${from} on re-read${refused ? ` · ${N(refused)} refused by Salesforce` : ''}${stopped ? ' · stopped before the end' : ''}` };
        },
      });
    } finally {
      // Undo: put back what the new field held (empty, or the overwritten
      // value) on the records that were written — up to FC_COPY_UNDO of them.
      const wrote = targets.filter(t => okIds.has(t.Id));
      const steps = [];
      if (wr && wr.accepted && wrote.length && wrote.length <= FC_COPY_UNDO) {
        for (let i = 0; i < wrote.length; i += 200) {
          const chunk = wrote.slice(i, i + 200);
          const allEmpty = chunk.every(t => t.was == null);
          steps.push({
            describe: `Put ${to} back on ${chunk.length} record${chunk.length === 1 ? '' : 's'} (${i + 1}–${i + chunk.length})`,
            // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
            msg: { type: 'SF_COLLECTIONS_UPDATE', records: chunk.map(t => ({ attributes: { type: obj }, Id: t.Id, [to]: t.was == null ? null : t.was })) },
            // Emptied again can be re-read in one query; a restored older value
            // cannot be compared by SOQL, so that step is accepted, not re-read.
            verify: (allEmpty && !st.unfiltered) ? { query: `SELECT Id FROM ${obj} WHERE Id IN (${chunk.map(t => `'${t.Id}'`).join(',')}) AND ${to} != null`,
              tooling: false, pick: 'records', absent: true,
              text: { ok: `${to} is empty again on ${chunk.length} record${chunk.length === 1 ? '' : 's'} — verified by re-reading the org`,
                      bad: `${to}: accepted by Salesforce, but some of these records still hold a value` } } : null,
          });
        }
      }
      await sftkHistoryEnd(j, { undo: steps.length ? { steps }
        : { none: (wr && wr.accepted && wrote.length) ? `more than ${N(FC_COPY_UNDO)} records were written — History keeps no undo at that size; the receipt CSV lists every record and what ${to} held before` : 'nothing was accepted by Salesforce, so there is nothing to undo' } });
    }

    // What happened, in words — then the plan again, from what the org holds now.
    const why = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w, c]) => `<li>${N(c)} × ${esc(w)}</li>`).join('');
    const wroteN = okIds.size;
    let head;
    if (!wr.accepted) head = `❌ Nothing was copied: ${esc(_feText(String((wr.raw && wr.raw.error) || wr.text || 'refused')))}`;
    else if (wr.ok) head = `✅ <strong>${N(check.ok)}</strong> value${check.ok === 1 ? '' : 's'} copied to <code>${esc(to)}</code> — verified by re-reading the records.`;
    else if (check) head = `⚠ ${N(wroteN)} record${wroteN === 1 ? ' was' : 's were'} accepted by Salesforce, and ${N(check.ok)} hold the value on re-read${check.badCount ? ` — ${N(check.badCount)} show something else (automation may have changed it), e.g. ${esc(check.bad.slice(0, 3).map(b => b.Id).join(', '))}` : ''}.`;
    else head = `⚠ ${N(wroteN)} record${wroteN === 1 ? ' was' : 's were'} accepted by Salesforce, but they could not be re-read to confirm it — treat this as unverified.`;
    st.result = `<div class="fc-copy-res ${wr.ok && !refused ? 'fc-copy-ok' : 'fc-copy-warn'}">${head}
      ${refused ? `<div>✋ <strong>${N(refused)}</strong> refused by Salesforce and left as they were:<ul class="fc-copy-list">${why}</ul></div>` : ''}
      ${stopped ? `<div>⏹ Stopped: ${N(targets.length - sent)} record${targets.length - sent === 1 ? ' was' : 's were'} not sent.</div>` : ''}
      ${callErr && okIds.size ? `<div>⚠ The run broke off: ${esc(_feText(callErr))}. ${N(targets.length - sent)} record(s) were not sent.</div>` : ''}
    </div>`;
    if (after) st.rows = after;
    else if (st.fillOnly) { try { const r = await _copyRead(true); st.rows = r.rows; st.capped = r.capped; } catch (_) { /* the result line stands; ↻ Compare again re-reads */ } }
    st.overwrite = false;
    _renderCopyPlan();
  }

  // 🔑 Copy the old field's access to the replacement field. Access is only
  // ever ADDED (sftkFlsCopyPlan never lowers a grant); each grant is re-read,
  // and History can take every one of them back.
  async function _copyFlsAccess(plan, btn) {
    if (!plan || !_replOn()) return;
    const obj = _selObj.api, from = _selField.api, to = _replField.api;
    const all = [...plan.create.map(c => ({ ...c, op: 'create', parentId: c.body.ParentId, want: c.body })),
                 ...plan.update.map(u => ({ ...u, op: 'update', want: u.after }))];
    const perm = w => (w.PermissionsEdit ? 'read + edit' : 'read');
    const gate = await sftkOrgWriteGate(_orgUrl);
    const sure = await sftkConfirmDestructive({
      title: `Copy field access to ${to}`,
      icon: '🔑',
      items: all.map(x => ({ label: x.who, sub: `${x.kind} — ${x.op === 'create' ? `gets ${perm(x.want)}` : `raised from ${perm(x.before)} to ${perm(x.want)}`}` })),
      revOverride: { html: `Gives each of these the access to <strong>${esc(obj)}.${esc(to)}</strong> that it has to ${esc(obj)}.${esc(from)}${_replReadOnly() ? ' (read only — the new field cannot be edited)' : ''}. Access is only added: nothing is lowered or removed. Data Studio › History can take it back.`, needsCheckbox: false },
      confirmLabel: '🔑 Copy access',
      production: gate.production ? { label: gate.label } : null,
    });
    if (!sure) return;
    btn.disabled = true; btn.textContent = '⏳ Copying…';
    // History (sftk-history.js): one journal for this button press; the undo
    // deletes each grant it created and puts each raised grant back.
    const j = sftkHistoryBegin({ tool: 'Field Cleaner', title: `🔑 Field access — ${obj}.${from} → ${to} (${all.length})`, orgUrl: _orgUrl });
    let res = null, after = [];
    const items = all.map(x => ({
      describe: `${x.who}: ${perm(x.want)} access to ${to}`,
      write: () => (x.op === 'create'
        ? bg({ type: 'SF_REST_POST', orgUrl: _orgUrl, sid: _sid, _suppressError: true,
            path: 'services/data/v62.0/sobjects/FieldPermissions', body: x.body })
        : bg({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: _orgUrl, sid: _sid, _suppressError: true,
            records: [{ attributes: { type: 'FieldPermissions' }, Id: x.id, ...x.after }] })),
    }));
    try {
      // confirmed-by: the sftkConfirmDestructive right above
      // The write discipline (sftk-write.js): ONE re-read of the new field's
      // grants judges every item — a grant counts only when the org shows it.
      res = await sftkWriteVerifiedAll(items, { journal: j, verifyAll: async () => {
        const q = await _queryFls(to);
        if (q.error) throw new Error(q.error);
        after = q.rows;
        return all.map(x => {
          const r = after.find(y => y.ParentId === x.parentId);
          return { ok: !!r && !!r.PermissionsRead && (!x.want.PermissionsEdit || !!r.PermissionsEdit), text: null };
        });
      } });
    } finally {
      const steps = [];
      ((res && res.results) || []).forEach((r, i) => {
        if (!r.ok) return;
        const x = all[i];
        const row = after.find(y => y.ParentId === x.parentId);
        if (x.op === 'create' && row) steps.push({
          describe: `Remove ${x.who}'s access to ${to} again`,
          // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
          msg: { type: 'SF_REST_DELETE', sobject: 'FieldPermissions', id: row.Id },
          verify: { query: `SELECT Id FROM FieldPermissions WHERE Id = '${row.Id}'`, tooling: false, pick: 'records', absent: true,
            text: { ok: `${x.who}: access to ${to} removed again — verified by re-reading the org`, bad: `${x.who}: accepted by Salesforce, but the org still shows the grant` } },
        });
        if (x.op === 'update') steps.push({
          describe: `Put ${x.who}'s access to ${to} back to ${perm(x.before)}`,
          // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
          msg: { type: 'SF_COLLECTIONS_UPDATE', records: [{ attributes: { type: 'FieldPermissions' }, Id: x.id, ...x.before }] },
          verify: { query: `SELECT PermissionsEdit FROM FieldPermissions WHERE Id = '${x.id}'`, tooling: false, pick: 'records.0', field: 'PermissionsEdit', equals: x.before.PermissionsEdit,
            text: { ok: `${x.who}: access to ${to} is ${perm(x.before)} again — verified by re-reading the org`, bad: `${x.who}: accepted by Salesforce, but the org still shows the raised grant` } },
        });
      });
      await sftkHistoryEnd(j, { undo: steps.length ? { steps } : { none: 'no grant was confirmed changed, so there is nothing to undo' } });
    }
    const box = eid('fcFlsCopy');
    if (!box) return;
    const bad = res.results.map((r, i) => (r.ok ? null : `${all[i].who}: ${r.accepted ? 'accepted, but the org does not show the grant' : _feText(String((r.raw && r.raw.error) || r.text || 'refused'))}`)).filter(Boolean);
    box.className = `fc-fls-copy${bad.length ? '' : ' fc-fls-copy-ok'}`;
    box.innerHTML = `🔑 ${res.ok} of ${all.length} now ${res.ok === 1 ? 'has' : 'have'} the same access to <code>${esc(to)}</code> — verified by re-reading the org.` +
      (bad.length ? `<ul class="fc-fls-copy-bad">${bad.map(b => `<li>⚠ ${esc(b)}</li>`).join('')}</ul>Give these access in Setup → Field-Level Security.` : '');
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
          label renamed and ${dep.fls.length} access grant(s) stripped${(dep.flsFailed || []).length ? ` — ⚠ ${dep.flsFailed.length} could NOT be: ${esc(dep.flsFailed.map(x => x.who).join(', '))} (a Salesforce-managed permission set cannot be edited; the field stays visible there)` : ''}. No complaints so far?
          It's safe to delete. Changed your mind?
          <button class="btn btn-sm" id="fcDepUndo">↩ Undo deprecation</button>
        </div>`;
      eid('fcDepUndo')?.addEventListener('click', async e => {
        const btn = e.currentTarget;
        const gate = await sftkOrgWriteGate(_orgUrl);
        const sure = await sftkConfirmDestructive({
          title: 'Undo deprecation',
          icon: '↩',
          items: [{ label: `${_selObj?.api}.${_selField?.api}` }],
          revOverride: { html: `Restores the previous label and re-grants the ${dep.fls.length} access grant(s) that were stripped.`, needsCheckbox: false },
          confirmLabel: '↩ Undo deprecation',
          production: gate.production ? { label: gate.label } : null,
        });
        if (sure) undoDeprecation(btn);
      });
    } else {
      el.innerHTML = `
        <div class="fc-dep-offer">
          🕐 Not sure it's unused? <button class="btn btn-secondary btn-sm" id="fcDepBtn">Deprecate first</button>
          <span class="fc-dep-hint">renames the label to <code>zz_DEPRECATED…</code> and hides the field from everyone —
          wait for complaints, then delete (or undo) with one click.</span>
        </div>`;
      eid('fcDepBtn')?.addEventListener('click', async e => {
        const btn = e.currentTarget;
        const gate = await sftkOrgWriteGate(_orgUrl);
        const sure = await sftkConfirmDestructive({
          title: 'Deprecate field',
          icon: '🕐',
          items: [{ label: `${_selObj.api}.${_selField.api}`, sub: _selField?.type }],
          revOverride: { html: 'Renames the label to <code>zz_DEPRECATED…</code> and hides the field from everyone — wait for complaints, then delete (or undo) with one click. Fully reversible with ↩ Undo deprecation.', needsCheckbox: false },
          confirmLabel: '🕐 Deprecate',
          production: gate.production ? { label: gate.label } : null,
        });
        if (sure) deprecateField(fieldId, btn);
      });
    }
  }

  async function deprecateField(fieldId, btn) {
    if (!fieldId) return;
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Deprecating…'; }
    // History (sftk-history.js): one journal for this button press, covering
    // both writes below (label/description PATCH + FLS strip). Undo puts the
    // previous label/description back and re-inserts whatever grants were
    // really stripped — the tool's own ↩ Undo deprecation button is unchanged.
    const j = sftkHistoryBegin({ tool: 'Field Cleaner', title: `🕐 Deprecate — ${_selObj.api}.${_selField.api}`, orgUrl: _orgUrl });
    let patchWr = null, prevMetadata = null, prevLabel = '', prevDesc = '', flsStripped = [];
    try {
      // 1. Current metadata (Tooling PATCH needs the full Metadata blob back).
      const cur = await bg({ type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid,
        sobject: 'CustomField', id: fieldId });
      if (cur.error || !cur.Metadata) throw new Error(cur.error || 'Could not read field metadata');
      prevMetadata = cur.Metadata;
      prevLabel = cur.Metadata.label;
      prevDesc  = cur.Metadata.description || '';

      // 2. Rename label + stamp description.
      const md = { ...cur.Metadata };
      if (!/^zz_DEPRECATED/i.test(md.label || '')) md.label = `zz_DEPRECATED ${md.label || _selField.api}`;
      // Already stamped (a second click after a partial run) → keep it once
      if (!/^\[DEPRECATED /.test(prevDesc)) md.description = `[DEPRECATED ${new Date().toISOString().slice(0, 10)} by Salesforce Toolkit — pending delete] ${prevDesc}`.slice(0, 1000);
      // confirmed-by: the Deprecate field sftkConfirmDestructive (the only caller)
      // The write discipline (sftk-write.js): the PATCH is the write, a
      // re-read of the field's own label is the verify.
      patchWr = await sftkWriteVerified({
        describe: `${_selObj.api}.${_selField.api}`,
        journal: j,
        write: () => bg({ type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid,
          path: `services/data/v62.0/tooling/sobjects/CustomField/${fieldId}`,
          body: { Metadata: sftkMetaForPatch(md) } }),
        verify: async () => {
          const chk = await bg({ type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid, _suppressError: true,
            sobject: 'CustomField', id: fieldId });
          if (!chk || chk.error || !chk.Metadata) return { ok: false, text: null };
          return { ok: chk.Metadata.label === md.label, text: null };
        },
      });
      if (!patchWr.accepted) throw new Error((patchWr.raw && patchWr.raw.error) || 'the label change was refused');
      if (!patchWr.ok) throw new Error(`the label was renamed but the org still shows the old label on re-read — check "${_selObj.api}.${_selField.api}" in Setup`);

      // 3. Strip FLS everywhere (snapshot first for undo).
      const { rows, error } = await _queryFls();
      if (error) throw new Error('FLS query failed: ' + error);
      const flsSnapshot = rows.map(r => ({ id: r.Id, read: !!r.PermissionsRead, edit: !!r.PermissionsEdit,
        parentId: r.ParentId, sobject: r.SobjectType, field: r.Field,
        who: r.Parent?.Label || r.Parent?.Profile?.Name || r.Id }));
      // Grants Salesforce refused to strip (live 2026-09-23: the "Slack
      // Integration User" session permission set, sfdcInternalInt — not
      // editable by anyone). The label is renamed and every other grant is
      // gone by now, so this is NOT a failure that forgets the record: it is
      // recorded, Undo exists, and the names are shown.
      const flsFailed = [];
      if (rows.length) {
        // confirmed-by: the Deprecate field sftkConfirmDestructive (the only caller)
        // The write discipline (sftk-write.js): routed through the helper,
        // but not re-read — Salesforce's Collections response is per-record
        // authoritative (each row carries its own success/errors), unlike a
        // single ambiguous "accepted" flag, so the answer below is that.
        const stripWr = await sftkWriteVerified({
          describe: `${rows.length} field-level security grant(s)`,
          journal: j,
          write: () => bg({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: _orgUrl, sid: _sid,
            records: rows.map(r => ({ attributes: { type: 'FieldPermissions' }, Id: r.Id,
                                      PermissionsRead: false, PermissionsEdit: false })) }),
          noVerify: 'the Collections response already names success/failure per grant',
        });
        const res = stripWr.raw;
        const results = Array.isArray(res) ? res : [];
        flsSnapshot.forEach((f, i) => {
          const x = results[i];
          if (x && x.success) flsStripped.push(f);
          else flsFailed.push({ who: f.who, why: ((x && x.errors) || []).map(e => e.message || e.statusCode).filter(Boolean).join('; ') });
        });
        if (!results.length) flsFailed.push(...flsSnapshot.map(f => ({ who: f.who, why: 'no answer from the org' })));
      }

      // 4. Record the stage + undo snapshot (only what was really stripped is restored by Undo).
      await chrome.storage.local.set({ [_depKey()]: {
        at: Date.now(), fieldId, prevLabel, prevDesc, fls: flsStripped, flsFailed } });
      renderDeprecationZone(fieldId);
      renderFlsPanel();
    } catch (e) {
      if (btn) {
        btn.disabled = false; btn.textContent = 'Deprecate first';
        _friendlyErrorUnder(btn, e.message || e);
      }
    } finally {
      const steps = [];
      if (patchWr && patchWr.accepted && prevMetadata) {
        steps.push({
          describe: `Put the label and description back on ${_selObj.api}.${_selField.api}`,
          // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
          msg: { type: 'SF_PATCH', path: `services/data/v62.0/tooling/sobjects/CustomField/${fieldId}`,
            body: { Metadata: sftkMetaForPatch(prevMetadata) } },
          verify: { query: `SELECT Id, Metadata FROM CustomField WHERE Id = '${fieldId}'`, tooling: true,
            pick: 'records.0.Metadata', field: 'label', equals: prevLabel,
            text: { ok: `${_selObj.api}.${_selField.api}: label restored — verified by re-reading the field`,
                    bad: `${_selObj.api}.${_selField.api}: accepted by Salesforce, but the field still shows the deprecated label` } },
        });
      }
      for (const f of flsStripped) {
        steps.push({
          describe: `Re-grant field-level security to ${f.who}`,
          // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
          msg: { type: 'SF_REST_POST', path: 'services/data/v62.0/sobjects/FieldPermissions',
            body: { ParentId: f.parentId, SobjectType: f.sobject, Field: f.field, PermissionsRead: f.read, PermissionsEdit: f.edit } },
          verify: { query: `SELECT Id FROM FieldPermissions WHERE ParentId = '${String(f.parentId).replace(/'/g, "\\'")}' AND Field = '${String(f.field).replace(/'/g, "\\'")}'`,
            tooling: false, pick: 'records', count: 1,
            text: { ok: `${f.who}: access re-granted — verified by re-reading the org`,
                    bad: `${f.who}: accepted by Salesforce, but the org still shows no grant` } },
        });
      }
      await sftkHistoryEnd(j, { undo: steps.length ? { steps } : { none: 'nothing was accepted by Salesforce, so there is nothing to undo' } });
    }
  }

  async function undoDeprecation(btn) {
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Restoring…'; }
    // History (sftk-history.js): this button IS the undo of the Deprecate
    // journal, so it gets its own entry (journaled too) whose own undo is to
    // deprecate again from the tool.
    const j = sftkHistoryBegin({ tool: 'Field Cleaner', title: `↩ Undo deprecation — ${_selObj?.api}.${_selField?.api}`, orgUrl: _orgUrl });
    try {
      const key = _depKey();
      const store = await chrome.storage.local.get(key);
      const dep = store[key];
      if (!dep) throw new Error('No deprecation record found');

      // 1. Restore label + description.
      const cur = await bg({ type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid,
        sobject: 'CustomField', id: dep.fieldId });
      if (cur.error || !cur.Metadata) throw new Error(cur.error || 'Could not read field metadata');
      // '' (not null) so the deprecation stamp is really cleared — a null key is dropped from the PATCH
      const md = { ...cur.Metadata, label: dep.prevLabel, description: dep.prevDesc || '' };
      // confirmed-by: the Undo deprecation sftkConfirmDestructive (the only caller)
      // The write discipline (sftk-write.js): the PATCH is the write, a
      // re-read of the field's own label is the verify.
      const patchWr = await sftkWriteVerified({
        describe: `${_selObj?.api}.${_selField?.api}`,
        journal: j,
        write: () => { return bg({ type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid,
          path: `services/data/v62.0/tooling/sobjects/CustomField/${dep.fieldId}`,
          body: { Metadata: sftkMetaForPatch(md) } }); },
        verify: async () => {
          const chk = await bg({ type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid, _suppressError: true,
            sobject: 'CustomField', id: dep.fieldId });
          if (!chk || chk.error || !chk.Metadata) return { ok: false, text: null };
          return { ok: chk.Metadata.label === md.label, text: null };
        },
      });
      if (!patchWr.accepted) throw new Error((patchWr.raw && patchWr.raw.error) || 'refused');
      if (!patchWr.ok) throw new Error('the label was restored but the org still shows the deprecated label on re-read — check it in Setup');

      // 2. Restore the FLS grants from the snapshot. Salesforce DELETES a
      // FieldPermissions row when both permissions are set false (live
      // 2026-09-23: the update by the old Id did nothing and the permission
      // set's grant never came back), so each grant is re-created; the update
      // by Id is the fallback for a row that still exists. Every failure is
      // named — Undo never reports a restore it did not see.
      const notBack = [];
      for (const f of (dep.fls || [])) {
        const rec = { ParentId: f.parentId, SobjectType: f.sobject || _selObj?.api, Field: f.field || `${_selObj?.api}.${_selField?.api}`,
                      PermissionsRead: f.read, PermissionsEdit: f.edit };
        let ok = false, why = '';
        // confirmed-by: the Undo deprecation sftkConfirmDestructive (the only caller)
        // The write discipline (sftk-write.js): routed through the helper,
        // but not re-read — the insert/update response already names
        // success and, on failure, the exact reason per grant.
        const restoreWr = await sftkWriteVerified({
          describe: f.who,
          journal: j,
          write: async () => {
            if (rec.ParentId) {
              const ins = await bg({ type: 'SF_REST_POST', orgUrl: _orgUrl, sid: _sid, _suppressError: true,
                path: 'services/data/v62.0/sobjects/FieldPermissions', body: rec });
              ok = !!(ins && !ins.error && ins.success !== false); if (!ok) why = String(ins?.error || '');
            }
            if (!ok && f.id) {
              const up = await bg({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: _orgUrl, sid: _sid,
                records: [{ attributes: { type: 'FieldPermissions' }, Id: f.id, PermissionsRead: f.read, PermissionsEdit: f.edit }] });
              const r0 = Array.isArray(up) ? up[0] : null;
              ok = !!(r0 && r0.success); if (!ok) why = why || ((r0 && r0.errors) || []).map(e => e.message || e.statusCode).join('; ') || (up && up.error) || 'no answer';
            }
            return { success: true };   // per-grant ok/why already resolved above; never trip the helper's own refusal path
          },
          noVerify: 'the insert/update response already names success or the reason per grant',
        });
        void restoreWr;
        if (!ok) notBack.push(`${f.who}${why ? ` (${why})` : ''}`);
      }
      await chrome.storage.local.remove(key);
      renderDeprecationZone(dep.fieldId);
      renderFlsPanel();
      if (notBack.length) {
        eid('fcDepZone')?.insertAdjacentHTML('beforeend',
          `<div class="fc-error-msg">⚠ Label and description restored, but ${notBack.length} access grant(s) could not be given back: ${esc(notBack.join(', '))}. Grant them again in Setup (Object Manager → the field → Set Field-Level Security).</div>`);
      }
    } catch (e) {
      if (btn) {
        btn.disabled = false; btn.textContent = '↩ Undo deprecation';
        _friendlyErrorUnder(btn, e.message || e);
      }
    } finally {
      await sftkHistoryEnd(j, { undo: { none: 'this is itself the undo — deprecate again from the tool' } });
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
    if (!_copyState) renderCopyValues();   // the 📦 panel quotes the measured count
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

  // version id (15-char) → { defId, num, status } for the flow rows of the
  // current scan. Filled by _loadFlowVersionInfo before rendering.
  let _flowVerInfo = {};

  async function _loadFlowVersionInfo(rows) {
    _flowVerInfo = {};
    const ids = [...new Set((rows || []).map(r => String(r.MetadataComponentId || '').substring(0, 15)).filter(Boolean))];
    for (let i = 0; i < ids.length; i += 100) {
      const lit = ids.slice(i, i + 100).map(x => `'${x}'`).join(',');
      const r = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true, _suppressError: true,
        query: `SELECT Id, DefinitionId, VersionNumber, Status FROM Flow WHERE Id IN (${lit})` });
      for (const v of (r?.records || [])) {
        _flowVerInfo[String(v.Id).substring(0, 15)] = { defId: v.DefinitionId, num: Number(v.VersionNumber) || 0, status: v.Status || '' };
      }
    }
  }

  function renderItem(dep, fixable, type) {
    const id      = dep.MetadataComponentId;
    const name    = esc(dep.MetadataComponentName || id);
    const vinfo   = type === 'Flow' ? _flowVerInfo[String(id).substring(0, 15)] : null;
    const verBadge = vinfo
      ? ` <span class="fc-ver-badge" style="margin-left:6px;font-size:10.5px;padding:0 5px;border-radius:8px;border:1px solid var(--border,#dddbda);${vinfo.status === 'Active' ? 'color:var(--active-color,#2E844A)' : 'opacity:.75'}" title="${vinfo.status === 'Active'
          ? 'The ACTIVE version references the field: the fix deploys a new version (without the reference — or, in replace mode, pointing at the replacement field), verifies the new one is active, then deletes this one.'
          : 'An inactive version references the field: ✂ deletes this version (after an optional backup) — no new version is needed for it.'}">v${vinfo.num} · ${esc(vinfo.status)}</span>`
      : '';
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
          <span class="fc-item-name">${name}${verBadge}</span>
          <span class="fc-item-btns">
            ${depsLink}
            ${inspBtn}
            <button class="btn btn-secondary btn-sm fc-fix-btn"
                    data-id="${esc(id)}" data-name="${name}" data-type="${esc(type)}">${_fixBtnLabel(type, id)}</button>
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
    // versions that still reference the field. Confirm first, stating
    // exactly what will happen; flows get the deliberate checkbox because
    // deleted flow versions cannot be restored.
    //
    // Flows (user 2026-09-13): the plan is read BEFORE the confirm — every
    // version of the flow, which of them mention the field, whether the
    // active one does (→ new version, verified active, then delete) or only
    // inactive ones do (→ delete just those), and the paused interviews that
    // must go first. The dialog states that exact plan, offers a backup zip,
    // and nothing is deleted before a new version is verified active.
    let flowPlan = null;
    if (type === 'Flow') {
      const pbtn = document.querySelector(`.fc-fix-btn[data-id="${componentId}"]`);
      if (pbtn) { pbtn.disabled = true; pbtn.textContent = '🔎 reading versions…'; }
      try { flowPlan = await fixFlowPlan(componentId, componentName); }
      catch (e) {
        if (pbtn) { pbtn.disabled = false; pbtn.textContent = _fixBtnLabel(type, componentId); }
        appendInlineError(componentId, e.message, e.setupUrl, '↗ Open in Flow Builder');
        return;
      }
      if (pbtn) { pbtn.disabled = false; pbtn.textContent = _fixBtnLabel(type, componentId); }
      if (flowPlan.plan.mode === 'none') {
        markFixed(componentId, '✅ No version of this flow references the field any more');
        _markFlowSiblings(componentId, flowPlan.defId, '✅ No version of this flow references the field any more', '');
        return;
      }
    }
    // ⇄ Replace with another field: the reference MOVES instead of going. For
    // a flow that only applies to an active version (inactive ones are deleted
    // either way). Read once here — the dialog, the run and the labels agree.
    const swap = _replOn() && (type !== 'Flow' || flowPlan.plan.mode === 'active');
    const swapTo = swap ? _replField.api : '';
    let wantBackup = true;
    // An ACTIVE version that references the field can be dealt with two ways;
    // the user chooses (2026-09-21). 'replace' is only offered when the
    // automatic fix can actually take something out.
    const hasChoice = type === 'Flow' && flowPlan.plan.mode === 'active' && !!flowPlan.planDelete;
    const pv = hasChoice ? flowPlan.preview : null;
    const canReplace = hasChoice && !!pv && pv.removed.length > 0;
    // Elements the fix leaves empty make Salesforce refuse the new version
    // (live 2026-09-22: offered and preselected, refused, nothing deleted —
    // correct, but a wasted round). Then nothing is preselected: the user picks.
    const replaceLikelyRefused = canReplace && !!pv && (pv.emptied || []).length > 0;
    let activeMode = hasChoice ? (canReplace && !replaceLikelyRefused ? 'replace' : '') : 'replace';
    const gate = await sftkOrgWriteGate(_orgUrl);
    const sure = await sftkConfirmDestructive({
      title: `${swap ? 'Replace' : 'Remove'} field reference — ${cfg.label || type}`,
      ...(swap ? { icon: '⇄' } : {}),
      items: type === 'Flow'
        ? [...flowPlan.plan.toDelete.map(v => ({ label: `${componentName} v${v.num}`, sub: `${v.status} — deleted (${hasChoice && v.status === 'Active' ? 'the active version: replaced or removed, as you choose below' : v.why})` })),
           ...(flowPlan.plan.overwrite ? [{ label: `${componentName} v${flowPlan.plan.overwrite.num}`, sub: `${flowPlan.plan.overwrite.status} — its content is REPLACED when the flow keeps running (Salesforce saves the new version over the newest draft)${flowPlan.plan.overwrite.refs ? '; deleted when you choose delete' : ''}` }] : [])]
        : [{ label: componentName, sub: type }],
      revOverride: {
        html: type === 'Flow'
          ? `⚠ <strong>${hasChoice ? 'This' : (flowPlan.plan.mode === 'active' ? 'Deploys a new flow version without the reference, verifies it is ACTIVE, and then' : 'This')} permanently deletes flow versions</strong> that still reference the field (Salesforce holds the dependency lock per version, not per active version).<ol id="fcFlowLines" style="margin:6px 0 0 18px;padding:0">${(hasChoice && !activeMode ? [] : flowPlan.lines).map(l => `<li>${esc(l)}</li>`).join('')}</ol>`
          : `${swap ? `⇄ <strong>${esc(_selObj.api)}.${esc(_selField.api)} → ${esc(swapTo)}</strong>. ${esc(_groupNote(type, cfg))}` : `✏ ${cfg.note || 'The field reference is removed from this component.'}`} The change deploys immediately. ${['Report', 'Layout', 'FlexiPage'].includes(type)
              ? 'A <strong>restore point</strong> is saved first — 🧾 Cleanup history can put the previous version back.'
              : 'There is no undo besides re-adding the field by hand.'}`,
        needsCheckbox: type === 'Flow',
      },
      extraHtml: type === 'Flow' ? `
        ${hasChoice ? _flowChoiceHtml(flowPlan, componentName, canReplace) : ''}
        <label class="sftk-confirm-ack"><input type="checkbox" id="fcFlowBackup" checked> ⬇ Back up the ${flowPlan.plan.toDelete.length + (flowPlan.plan.overwrite ? 1 : 0)} version(s) as a zip before deleting (recommended — the Flows tool can restore from it)</label>
        ${flowPlan.interviews.length ? `<div class="sftk-confirm-undo">⏸ ${esc(sftkFlowInterviewWords(sftkFlowInterviewKinds(flowPlan.interviews)).head)} that will be deleted first: ${esc(flowPlan.interviews.slice(0, 8).map(i => i.InterviewLabel || i.Name).join(', '))}${flowPlan.interviews.length > 8 ? ` … +${flowPlan.interviews.length - 8} more` : ''}</div>` : ''}` : '',
      onRender: type === 'Flow' ? () => {
        const cb = document.getElementById('fcFlowBackup');
        cb?.addEventListener('change', () => { wantBackup = !!cb.checked; });
        if (!hasChoice) return;
        // The choice drives the numbered plan and the button; nothing can be
        // confirmed until BOTH the acknowledgement is ticked and a way is chosen.
        const go = document.getElementById('sftkConfirmGo'), ack = document.getElementById('sftkConfirmAck');
        const sync = () => {
          const lines = activeMode === 'delete' ? flowPlan.linesDelete : activeMode === 'replace' ? flowPlan.lines : [];
          const ol = document.getElementById('fcFlowLines');
          if (ol) ol.innerHTML = lines.length ? lines.map(l => `<li>${esc(l)}</li>`).join('') : '<li>Choose below what happens to the active version.</li>';
          if (go) {
            go.textContent = activeMode === 'delete' ? '🗑 Switch the flow off, then delete' : activeMode === 'replace' ? (swap ? '⇄ Deploy the version that uses the new field, then delete' : '✂ Deploy fixed version, then delete') : 'Choose an option first';
            go.disabled = !(ack && ack.checked && activeMode);
          }
        };
        document.querySelectorAll('input[name="fcActiveMode"]').forEach(r => r.addEventListener('change', () => { if (r.checked) { activeMode = r.value; sync(); } }));
        ack?.addEventListener('change', sync);
        sync();
      } : null,
      confirmLabel: type === 'Flow'
        ? (flowPlan.plan.mode === 'active' ? (swap ? '⇄ Deploy the version that uses the new field, then delete' : '✂ Deploy fixed version, then delete') : '🗑 Delete referencing version(s)')
        : (swap ? '⇄ Replace reference' : '✂ Remove reference'),
      production: gate.production ? { label: gate.label } : null,
    });
    if (!sure) return;

    const btn = document.querySelector(`.fc-fix-btn[data-id="${componentId}"]`);
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    try {
      let label = cfg.doneLabel || '✅ Done';
      let doneLinks = '';
      if (type === 'Flow') {
        if (hasChoice && !activeMode) return;   // the button is disabled without a choice; belt and braces
        const chosen = (hasChoice && activeMode === 'delete') ? { ...flowPlan, plan: flowPlan.planDelete, lines: flowPlan.linesDelete } : flowPlan;
        // History (sftk-history.js): one journal for this button press,
        // covering every write fixFlowExecute makes (activation/deactivation,
        // interview deletes, version deletes) — passed into the helper so
        // each write's verdict lands in the same entry.
        const moving = swap && activeMode !== 'delete';
        const j = sftkHistoryBegin({ tool: 'Field Cleaner', title: moving ? `⇄ Flow — ${componentName} (${_selObj.api}.${_selField.api} → ${swapTo})` : `✂ Flow — ${componentName} (${_selObj.api}.${_selField.api} removed)`, orgUrl: _orgUrl });
        let r;
        try {
          r = await fixFlowExecute(chosen, { backup: wantBackup, journal: j });
        } finally {
          await sftkHistoryEnd(j, { undo: (r && r.undo) || { none: 'nothing was accepted by Salesforce, so there is nothing to undo' } });
        }
        const bits = [];
        if (r.mode === 'active') bits.push(`v${r.newVersion} deployed and ACTIVE (verified by re-reading the org)${r.swapped ? ` — ${r.swapped} reference${r.swapped === 1 ? '' : 's'} now point${r.swapped === 1 ? 's' : ''} at ${swapTo}` : ''}${r.overwrote ? ` — saved over the draft v${r.newVersion}, as Salesforce does when the newest version is a draft` : ''}`);
        if (r.mode === 'active-delete') bits.push('flow switched OFF (verified by re-reading the org) — it no longer runs');
        if (r.deleted) bits.push(`${r.deleted} version(s) deleted`);
        if (r.interviewsDeleted) bits.push(`${r.interviewsDeleted} flow interview(s) deleted`);
        if (r.interviewsFailed) bits.push(`⚠ ${r.interviewsFailed} flow interview(s) couldn't be deleted`);
        if (r.failed || r.skipped) bits.push(`⚠ ${r.failed + r.skipped} version(s) couldn't be deleted — still blocking the field delete${r.errors.length ? ` (${[...new Set(r.errors)].join('; ')})` : ''}`);
        if (r.stillMentions) bits.push(r.swapped
          ? `⚠ the new version still mentions ${_selField.api} in ${r.undecided || 'some'} place(s) whose object could not be worked out — if they are this field, change them in Flow Builder`
          : `⚠ the new version still mentions the field in text the auto-fix does not touch (a formula or decision) — finish it in Flow Builder`);
        // Not finished is not done (live 2026-09-22: three versions Salesforce
        // refused were marked ✅ and the delete zone read "All dependencies
        // resolved"). A refused version keeps its ✂ button and says why.
        const stuck = (r.failed || 0) + (r.skipped || 0) + (r.interviewsFailed || 0);
        if (stuck) {
          const e = new Error(`Not finished: ${bits.join(' · ')}. The field stays locked until every version that references it is gone — clear the cause, then press ✂ Remove again (what was deleted stays deleted).`);
          if (flowPlan.builderUrl) e.setupUrl = flowPlan.builderUrl;
          throw e;
        }
        label = `✅ ${bits.join(' · ')}`;
        doneLinks = _flowDoneLinks({ stillBlocking: r.failed + r.skipped });
        _markFlowSiblings(componentId, r.defId, label, doneLinks);
      }
      if (type === 'Layout')    label = (await fixLayout(componentId, componentName)) || label;
      if (type === 'FlexiPage') label = (await fixFlexiPage(componentId, componentName)) || label;
      if (type === 'Report')    label = await fixReport(componentId, componentName);
      markFixed(componentId, label, doneLinks);
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = _fixBtnLabel(type, componentId); }
      // Label the open-link button based on which builder we're sending them to.
      const linkLabel = type === 'Flow' ? '↗ Open in Flow Builder'
        : type === 'Report' ? '↗ Open report' : '↗ Open in Setup';
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
    if (xmlPanel) {
      xmlPanel.style.display = 'none';
      // The inspector's own ✂ button is a .fc-fix-btn too — left in place it
      // keeps counting as an unresolved fix and "Delete Field" never
      // re-enables (audit 2026-09-12).
      xmlPanel.querySelector('.fc-xml-fix')?.remove();
    }
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
  // ── Flow surgery — sftk-flowsurgery.js plans it, this executes it ──────
  // (user 2026-09-13). Salesforce holds the field lock per flow VERSION.

  const _flowBuilderUrl = flowId => (_orgUrl && flowId)
    ? `${_orgUrl.replace(/\/$/, '')}/builder_platform_interaction/flowBuilder.app?flowId=${flowId}` : null;

  // Every version of the flow a version id belongs to, newest first. A
  // partial version list is refused — deletions are never planned from it.
  async function _flowVersionsOf(anyVersionId) {
    const defRes = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true,
      query: `SELECT DefinitionId FROM Flow WHERE Id = '${anyVersionId}'` });
    if (defRes?.error) throw new Error(`Could not resolve the flow definition: ${_feText(defRes.error)}`);
    const defId = defRes?.records?.[0]?.DefinitionId;
    if (!defId) throw new Error('Could not resolve the flow definition of this version.');
    const verRes = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true,
      query: `SELECT Id, VersionNumber, Status FROM Flow WHERE DefinitionId = '${defId}' ORDER BY VersionNumber DESC` });
    if (verRes?.error) throw new Error(`Could not list the flow's versions: ${_feText(verRes.error)}`);
    if (verRes?.incomplete) throw new Error(`The flow's version list came back INCOMPLETE (Salesforce says ${verRes.incomplete.expected} version(s), got ${verRes.incomplete.got}) — refusing to plan deletions from a partial list.`);
    const versions = verRes?.records || [];
    const maxNum = versions.reduce((m, v) => Math.max(m, Number(v.VersionNumber) || 0), 0);
    return { defId, versions, maxNum };
  }

  // After a deploy the org must show a NEWER version than before, and it
  // must be ACTIVE — activated here when the org's deploy setting left it
  // inactive — and both facts are RE-READ, never assumed. Throws (with a
  // Flow Builder link) when that cannot be established; callers delete
  // nothing in that case.
  // `before` (the version list read BEFORE the deploy) covers the other thing
  // Salesforce does: it saves a deploy OVER the newest version when that
  // version is a draft — no higher number appears; the draft record is
  // replaced by a NEW record with the same number (live 2026-10-04: reported
  // "no new version appeared" while v4 had been replaced and activated). So
  // the written version is the one whose Id was not there before.
  async function _verifyFlowActivation(defId, prevMax, flowName, flowIdForLink, journal, before) {
    const read = async () => {
      const r = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true, _suppressError: true,
        query: `SELECT Id, VersionNumber, Status FROM Flow WHERE DefinitionId = '${defId}' ORDER BY VersionNumber DESC` });
      if (r?.error) throw new Error(`The deploy was accepted but the org could not be re-read to verify it (${_feText(r.error)}) — treat "${flowName}" as UNVERIFIED and check it in Flow Builder. Nothing was deleted.`);
      return r?.records || [];
    };
    const link = e => { const u = _flowBuilderUrl(flowIdForLink); if (u) e.setupUrl = u; return e; };
    let versions = await read();
    let newest = versions[0];
    let overwrote = false;
    if (!newest || (Number(newest.VersionNumber) || 0) <= prevMax) {
      // No higher number: a record that was not in the list before the deploy
      // is the version that was written (the active one first, if several).
      const had = new Set((Array.isArray(before) ? before : []).map(v => v.Id));
      const fresh = had.size ? versions.filter(v => !had.has(v.Id)) : [];
      const written = fresh.find(v => v.Status === 'Active') || fresh[0] || null;
      if (!written) throw link(new Error(`The deploy was accepted but no new version of "${flowName}" appeared (latest is still v${prevMax}). Nothing was deleted.`));
      newest = written; overwrote = true;
    }
    if (newest.Status !== 'Active') {
      const newId = newest.Id;
      // confirmed-by: fixOne's or the ✂ Remove selected dialog's
      // sftkConfirmDestructive — every caller of this function confirms first
      // The write discipline (sftk-write.js): the PATCH is the write, the
      // re-read below (the same `read()` this whole function verifies with)
      // is the verify — never trust the PATCH's own answer.
      const actWr = await sftkWriteVerified({
        describe: `"${flowName}" activation`,
        journal,   // history-by: the caller's journal (fixOne's Flow entry, or fixFlowSelective's)
        write: () => bg({ type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid, _suppressError: true,
          path: `services/data/v62.0/tooling/sobjects/FlowDefinition/${defId}`,
          body: { Metadata: { activeVersionNumber: Number(newest.VersionNumber) } } }),
        verify: async () => {
          versions = await read();
          newest = versions.find(v => v.Id === newId) || null;
          return { ok: !!newest && newest.Status === 'Active', text: null };
        },
      });
      if (!actWr.ok) {
        const act = actWr.raw;
        throw link(new Error(`v${newest ? newest.VersionNumber : '?'} of "${flowName}" was created but could NOT be activated${act?.error ? ` — ${_feText(act.error)}` : ''}. The previous version stays active and nothing was deleted. Activate the new version in Flow Builder, then run ✂ Remove again.`));
      }
    }
    return { newVersion: Number(newest.VersionNumber) || 0, newId: newest.Id, versions, overwrote };
  }

  // Paused / waiting interviews on these versions — Salesforce refuses to
  // delete a version while any exist. A failed check is reported, not hidden.
  async function _flowInterviewsFor(versionIds) {
    // FlowVersionViewId matches the 15-character id only (live 2026-09-22: the
    // 18-character form found nothing, so every version then failed with
    // DEPENDENCY_EXISTS naming the very interviews this query had missed).
    // Both forms are asked for; the results carry the 15-character one.
    const ids = [...new Set((versionIds || []).filter(Boolean).flatMap(x => { const s = String(x); return s.length === 18 ? [s, s.substring(0, 15)] : [s]; }))];
    if (!ids.length) return { interviews: [], error: null };
    const lit = ids.map(x => `'${x}'`).join(',');
    const r = await bg({ type: 'SF_REST_QUERY', orgUrl: _orgUrl, sid: _sid, _suppressError: true,
      query: `SELECT Id, Name, InterviewLabel, InterviewStatus, CurrentElement, CreatedDate, FlowVersionViewId FROM FlowInterview WHERE FlowVersionViewId IN (${lit})` });
    if (r?.error) return { interviews: [], error: _feText(r.error) };
    return { interviews: r?.records || [], error: null };
  }

  async function _deleteFlowInterviews(interviews, journal) {
    const list = interviews || [];
    const out = { deleted: 0, failed: 0, failedVersionIds: new Set(), errors: [] };
    if (!list.length) return out;
    // confirmed-by: every caller confirms first — fixOne's sftkConfirmDestructive,
    // the ✂ Remove selected dialog, or purgeOldFlowVersions's own interviews dialog
    // The write discipline (sftk-write.js): one batch, one re-read
    // (verifyAll) confirming the interviews are actually gone — never the
    // DELETE's own answer.
    const batch = await sftkWriteVerifiedAll(list.map(it => ({
      describe: it.Id,
      write: () => bg({ type: 'SF_REST_DELETE', orgUrl: _orgUrl, sid: _sid, sobject: 'FlowInterview', id: it.Id, _suppressError: true }),
    })), {
      journal,   // history-by: the caller's journal — deleted interviews cannot be re-created
      verifyAll: async results => {
        const ids = list.filter((it, i) => results[i] && results[i].accepted).map(it => it.Id);
        if (!ids.length) return [];
        const lit = ids.map(x => `'${x}'`).join(',');
        const q = await bg({ type: 'SF_REST_QUERY', orgUrl: _orgUrl, sid: _sid, _suppressError: true,
          query: `SELECT Id FROM FlowInterview WHERE Id IN (${lit})` });
        if (!q || q.error) return null;
        const stillThere = new Set((q.records || []).map(r => r.Id));
        return list.map(it => ({ ok: !stillThere.has(it.Id), text: null }));
      },
    });
    list.forEach((it, i) => {
      const r = batch.results[i];
      if (!r.ok) { out.failed++; out.failedVersionIds.add(String(it.FlowVersionViewId || '').substring(0, 15)); if (out.errors.length < 3) out.errors.push(_feText((r.raw && r.raw.error) || r.text || 'not confirmed deleted')); }
      else out.deleted++;
    });
    return out;
  }

  // Versions whose interviews could not be deleted are skipped — Salesforce
  // would refuse them anyway, and the count says so.
  async function _deleteFlowVersionIds(ids, skipIds, journal) {
    const out = { deleted: 0, failed: 0, skipped: 0, errors: [] };
    const todo = [];
    for (const id of (ids || [])) {
      if (skipIds && (skipIds.has(id) || skipIds.has(String(id).substring(0, 15)))) { out.skipped++; continue; }
      todo.push(id);
    }
    if (!todo.length) return out;
    // confirmed-by: every caller confirms first — fixOne's sftkConfirmDestructive
    // or the ✂ Remove selected dialog (via purgeOldFlowVersions)
    // The write discipline (sftk-write.js): one batch, one re-read
    // (verifyAll) confirming the versions are actually gone — never the
    // DELETE's own answer.
    const batch = await sftkWriteVerifiedAll(todo.map(id => ({
      describe: id,
      write: () => bg({ type: 'SF_TOOLING_DELETE', orgUrl: _orgUrl, sid: _sid, sobject: 'Flow', id, _suppressError: true }),
    })), {
      journal,   // history-by: the caller's journal — deleted flow versions cannot be re-created
      verifyAll: async results => {
        const okIds = todo.filter((id, i) => results[i] && results[i].accepted);
        if (!okIds.length) return [];
        const lit = okIds.map(x => `'${x}'`).join(',');
        const q = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true, _suppressError: true,
          query: `SELECT Id FROM Flow WHERE Id IN (${lit})` });
        if (!q || q.error) return null;
        const stillThere = new Set((q.records || []).map(r => r.Id));
        return todo.map(id => ({ ok: !stillThere.has(id), text: null }));
      },
    });
    todo.forEach((id, i) => {
      const r = batch.results[i];
      if (!r.ok) { out.failed++; if (out.errors.length < 3) out.errors.push(_feText((r.raw && r.raw.error) || r.text || 'not confirmed deleted')); }
      else out.deleted++;
    });
    return out;
  }

  // The other rows of the same flow (the index lists each version that
  // mentions the field) are settled by the same surgery — mark them too.
  function _markFlowSiblings(exceptId, defId, label, links) {
    if (!defId) return;
    const key = String(defId).substring(0, 15);
    for (const d of (_groups.Flow || [])) {
      const id = String(d.MetadataComponentId || '');
      if (id === String(exceptId)) continue;
      const info = _flowVerInfo[id.substring(0, 15)];
      if (info && info.defId && String(info.defId).substring(0, 15) === key) markFixed(id, label, links);
    }
  }

  // Read every version of the flow, find which mention the field, and plan.
  // Nothing is written here.
  // What the automatic fix would do INSIDE the active version, and the choice
  // it leaves the user (2026-09-21). Flow Builder cannot be driven or
  // highlighted from outside, so the manual route names every location by the
  // element's label and API name — Flow Builder's Toolbox → Manager finds them.
  function _flowChoiceHtml(fp, flowName, canReplace) {
    const pv = fp.preview || { removed: [], remaining: [], emptied: [] };
    if (pv.swap) return _flowSwapHtml(fp, canReplace);
    const act = fp.plan.active;
    const li = (x, tail) => `<li><b>${esc(x.kind)}</b> “${esc(x.label || x.name || '?')}”${x.name ? ` <code>${esc(x.name)}</code>` : ''} — ${esc(x.where)}${tail ? `: <code>${esc(tail)}</code>` : ''}</li>`;
    const list = (arr, tailKey) => arr.length ? `<ul class="fc-prev-list">${arr.slice(0, 12).map(x => li(x, x[tailKey])).join('')}${arr.length > 12 ? `<li>… +${arr.length - 12} more</li>` : ''}</ul>` : '';
    const open = fp.builderUrl ? `<a href="${esc(fp.builderUrl)}" target="_blank" rel="noopener" class="fc-prev-open">↗ Open v${act.num} in Flow Builder</a>` : '';
    return `<div class="fc-prev">
      <div class="fc-prev-hd">Inside the active v${act.num} — what an automatic fix would do</div>
      ${pv.removed.length ? `<div class="fc-prev-sec fc-prev-ok"><b>✂ Comes out automatically (${pv.removed.length})</b>${list(pv.removed, 'what')}</div>`
        : `<div class="fc-prev-sec fc-prev-bad"><b>✂ Nothing can be taken out automatically.</b></div>`}
      ${pv.remaining.length ? `<div class="fc-prev-sec fc-prev-bad"><b>✋ Cannot be removed automatically (${pv.remaining.length}) — these KEEP the field locked</b>
        <div class="fc-prev-note">Decisions and formulas decide what a flow does, so they are never rewritten for you. Until these are changed by hand, Salesforce will still refuse to delete the field.</div>${list(pv.remaining, 'value')}</div>` : ''}
      ${pv.emptied.length ? `<div class="fc-prev-sec fc-prev-warn"><b>⚠ Left empty by the fix (${pv.emptied.length}) — Salesforce is likely to refuse the new version</b>${list(pv.emptied, '')}
        <div class="fc-prev-note">An element with nothing left to do is invalid. If the deploy is refused, nothing is deleted and the message says so.</div></div>` : ''}
      <div class="fc-prev-hd">The active version — choose</div>
      <label class="fc-prev-opt${canReplace ? '' : ' fc-prev-opt-off'}"><input type="radio" name="fcActiveMode" value="replace" ${canReplace ? (pv.emptied.length ? '' : 'checked') : 'disabled'}>
        <span><b>Keep the flow running</b> — deploy a new active v${fp.plan.expectNew} without what comes out above, verify it is active, then delete v${act.num}.
        ${canReplace && pv.emptied.length ? `<em>Likely refused: ${pv.emptied.length} element(s) would be left empty. Pick this only if you will fix them in Flow Builder; otherwise choose delete.</em> ` : ''}${canReplace ? (pv.remaining.length ? `<em>The field stays locked until you also fix the ${pv.remaining.length} manual place(s) in the new version.</em>` : '') : '<em>Not available: there is nothing the automatic fix can take out of this version.</em>'}</span></label>
      <label class="fc-prev-opt"><input type="radio" name="fcActiveMode" value="delete">
        <span><b>Delete the active version too</b> — switch the flow off, verify nothing is active, then delete v${act.num} with the rest. <em>The flow stops running.</em></span></label>
      <div class="fc-prev-sec"><b>Or do it yourself.</b> ${open} In Flow Builder open <i>Toolbox → Manager</i> and search each API name shown above (<code>like_this</code>); change or remove the reference, reconnect anything you delete, then Save As a new version and Activate. Run ✂ Remove here again afterwards — it will find the active version clean and only remove the old versions.</div>
    </div>`;
  }

  // ⇄ The same dialog section when the reference MOVES (sftk-fieldreplace.js):
  // what is pointed at the new field, and what is left alone and why. Nothing
  // is taken out, so nothing can be left empty.
  function _flowSwapHtml(fp, canReplace) {
    const pv = fp.preview;
    const act = fp.plan.active;
    const li = (x, tail) => `<li><b>${esc(x.kind)}</b> “${esc(x.label || x.name || '?')}”${x.name ? ` <code>${esc(x.name)}</code>` : ''} — ${esc(x.where)}${tail ? `: <code>${esc(tail)}</code>` : ''}</li>`;
    const list = (arr, tail) => arr.length ? `<ul class="fc-prev-list">${arr.slice(0, 12).map(x => li(x, tail(x))).join('')}${arr.length > 12 ? `<li>… +${arr.length - 12} more</li>` : ''}</ul>` : '';
    const open = fp.builderUrl ? `<a href="${esc(fp.builderUrl)}" target="_blank" rel="noopener" class="fc-prev-open">↗ Open v${act.num} in Flow Builder</a>` : '';
    const other = pv.remaining.filter(x => x.why === 'other'), undecided = pv.remaining.filter(x => x.why !== 'other');
    return `<div class="fc-prev">
      <div class="fc-prev-hd">Inside the active v${act.num} — what moving to ${esc(pv.to)} changes</div>
      ${pv.removed.length ? `<div class="fc-prev-sec fc-prev-ok"><b>⇄ Pointed at ${esc(pv.to)} (${pv.removed.length})</b>
        <div class="fc-prev-note">Nothing is taken out: every condition, assignment and filter stays, reading or writing the new field.</div>${list(pv.removed, x => x.what)}</div>`
        : `<div class="fc-prev-sec fc-prev-bad"><b>⇄ Nothing in this version can be moved automatically.</b></div>`}
      ${undecided.length ? `<div class="fc-prev-sec fc-prev-bad"><b>✋ Left alone (${undecided.length}) — could not tell whose field this is</b>
        <div class="fc-prev-note">A reference is moved only when it is KNOWN to be ${esc(_selObj.api)}'s field. These sit where the object cannot be worked out (the output of an action, a value typed as text…). If one of them is this field, change it in Flow Builder — until then Salesforce keeps the field locked.</div>${list(undecided, x => x.value)}</div>` : ''}
      ${other.length ? `<div class="fc-prev-sec"><b>Not this field (${other.length})</b>
        <div class="fc-prev-note">The same field name on another object — left exactly as it is.</div>${list(other, x => `${x.value} — a field of ${x.object}`)}</div>` : ''}
      <div class="fc-prev-hd">The active version — choose</div>
      <label class="fc-prev-opt${canReplace ? '' : ' fc-prev-opt-off'}"><input type="radio" name="fcActiveMode" value="replace" ${canReplace ? 'checked' : 'disabled'}>
        <span><b>Keep the flow running on ${esc(pv.to)}</b> — deploy a new active v${fp.plan.expectNew} with the references moved, verify it is active, then delete v${act.num}.${canReplace ? '' : ' <em>Not available: no reference in this version can be moved.</em>'}</span></label>
      <label class="fc-prev-opt"><input type="radio" name="fcActiveMode" value="delete">
        <span><b>Delete the active version too</b> — switch the flow off, verify nothing is active, then delete v${act.num} with the rest. <em>The flow stops running.</em></span></label>
      <div class="fc-prev-sec"><b>Or do it yourself.</b> ${open} In Flow Builder open <i>Toolbox → Manager</i> and search each API name shown above (<code>like_this</code>); point it at the new field, then Save As a new version and Activate. Run the fix here again afterwards — it will find the active version clean and only remove the old versions.</div>
    </div>`;
  }

  // ⇄ The swap on ONE flow version's metadata, in place. A field reached
  // through a lookup ($Record.Account.Field__c) is this object's only when the
  // org's schema says the lookup points here — so each such chain is resolved
  // against the describes first; a chain that cannot be resolved (polymorphic
  // lookup, unreadable object) is left alone, never guessed.
  const _chainKey = (root, rels) => `${String(root).toLowerCase()}|${rels.map(r => String(r).toLowerCase()).join('.')}`;
  async function _chainOwner(rootObj, rels) {
    let cur = rootObj;
    for (const rel of rels) {
      const d = await _describeObj(cur);
      if (!d || d.error || !Array.isArray(d.fields)) return null;
      const f = d.fields.find(x => String(x.relationshipName || '').toLowerCase() === String(rel).toLowerCase());
      if (!f || !Array.isArray(f.referenceTo) || f.referenceTo.length !== 1) return null;
      cur = f.referenceTo[0];
    }
    return cur;
  }
  async function _flowSwap(metadata) {
    const obj = _selObj.api, from = _selField.api, to = _replField.api;
    const probe = sftkFlowReplaceField(JSON.parse(JSON.stringify(metadata)), obj, from, to);
    const owners = new Map();
    for (const need of probe.needs) owners.set(_chainKey(need.rootObj, need.rels), await _chainOwner(need.rootObj, need.rels));
    return sftkFlowReplaceField(metadata, obj, from, to, {
      chainOwner: (root, rels) => { const v = owners.get(_chainKey(root, rels)); return v === undefined ? null : v; } });
  }

  async function fixFlowPlan(flowId, flowName) {
    const { defId, versions, maxNum } = await _flowVersionsOf(flowId);
    const metaById = {}; const referencing = [];
    for (const v of versions) {
      const read = await bg({ type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid, sobject: 'Flow', id: v.Id, _suppressError: true });
      if (read?.error || !read?.Metadata) {
        throw new Error(`Could not read v${v.VersionNumber} of "${flowName}"${read?.error ? ` (${_feText(read.error)})` : ''} — refusing to plan deletions from a partial picture of the flow.`);
      }
      metaById[v.Id] = read;
      if (flowReferencesField(read.Metadata)) referencing.push(v.Id);
    }
    const plan = sftkFlowSurgeryPlan(versions, referencing);
    const { interviews, error: interviewCheckError } = await _flowInterviewsFor(plan.toDelete.map(v => v.id));
    const kinds = sftkFlowInterviewKinds(interviews);
    // The other way to deal with an ACTIVE version (same versions go, so the
    // same interviews apply), and a preview of the automatic fix made by the
    // REAL remover on a clone — it cannot disagree with the run.
    let planDelete = null, preview = null;
    if (plan.mode === 'active') {
      planDelete = sftkFlowSurgeryPlan(versions, referencing, { activeMode: 'delete' });
      try {
        const before = metaById[plan.active.id].Metadata;
        const after = JSON.parse(JSON.stringify(before));
        if (_replOn()) {
          // The REAL swap on a clone — the preview cannot disagree with the run.
          const sw = await _flowSwap(after);
          const J = x => JSON.stringify(x);
          preview = { swap: true, to: _replField.api, emptied: [],
            removed: sw.changed.map(c => ({ ...sftkFlowRefWhere(before, c.path), what: `${c.before} → ${c.after}` })),
            remaining: sftkFlowRefScan(after, _fieldStringTester()).map(h => {
              const sk = sw.skipped.find(x => J(x.path) === J(h.path));
              return { ...sftkFlowRefWhere(after, h.path), value: h.value, why: sk ? sk.why : 'unknown', object: sk ? sk.object : null };
            }) };
        } else {
          removeFieldRefs(after, _selObj.api, _selField.api);
          preview = sftkFlowRefPreview(before, after, _fieldStringTester());
        }
      } catch (_) { preview = null; }   // no preview is a missing convenience, never a wrong one
    }
    return { flowId, flowName, defId, versions, maxNum, metaById, plan, interviews, interviewCheckError,
      planDelete, preview, builderUrl: plan.active ? _flowBuilderUrl(plan.active.id) : null,
      lines: sftkFlowSurgeryLines(plan, kinds, interviewCheckError, _replOn() ? { swapTo: _replField.api } : null),
      linesDelete: planDelete ? sftkFlowSurgeryLines(planDelete, kinds, interviewCheckError) : null };
  }

  // Execute a plan: backup → (new version, VERIFIED active) → interviews →
  // versions. Every early exit leaves the org exactly as it was.
  async function fixFlowExecute(fp, opts) {
    const { plan, metaById, flowName, defId, maxNum } = fp;
    const out = { mode: plan.mode, defId, newVersion: null, newId: null, deleted: 0, failed: 0, skipped: 0,
      interviewsDeleted: 0, interviewsFailed: 0, stillMentions: false, errors: [], undo: null };
    const apiNameOf = id => String(metaById[id]?.FullName || '').replace(/-\d+$/, '');
    const journal = opts && opts.journal;

    // A draft newer than the active version is saved OVER by the deploy
    // (sftkFlowSurgeryPlan's `overwrite`): its content goes too, so it is
    // backed up and gets a restore point like the versions that are deleted.
    const gone = plan.overwrite ? [...plan.toDelete, plan.overwrite] : plan.toDelete;
    // 1. backup zip of every version that will be deleted — BEFORE any change
    if (opts && opts.backup) {
      if (typeof downloadFlowBackupZip !== 'function') {
        throw new Error('The backup download is not available on this page — nothing was changed. Untick the backup to proceed without one.');
      }
      const entries = gone.map(v => ({
        MasterLabel: flowName, ApiName: apiNameOf(v.id), VersionNumber: v.num, Status: v.status,
        ProcessType: metaById[v.id]?.ProcessType || metaById[v.id]?.Metadata?.processType || '',
        FullName: metaById[v.id]?.FullName, Metadata: metaById[v.id]?.Metadata,
      }));
      const safe = String(flowName || 'Flow').replace(/[^a-zA-Z0-9_-]/g, '_');
      downloadFlowBackupZip(entries, _orgUrl, `${safe}_field-cleanup_${gone.map(v => 'v' + v.num).join('-')}_backup.zip`);
    }
    // 🧾 Cleanup history restore points for every version that goes
    for (const v of gone) {
      await _snapshotFix('Flow', v.id, `${flowName} v${v.num}`, metaById[v.id]?.FullName, metaById[v.id]?.Metadata);
    }

    // 2. the active version → a new version without the reference, verified ACTIVE
    if (plan.mode === 'active') {
      const src = metaById[plan.active.id];
      const metadata = JSON.parse(JSON.stringify(src.Metadata));
      const swapping = _replOn();
      const changes = swapping
        ? (await _flowSwap(metadata)).changed.reduce((n, c) => n + c.n, 0)
        : removeFieldRefs(metadata, _selObj.api, _selField.api);
      if (swapping) out.swapped = changes;
      if (changes === 0 && swapping) {
        const err = new Error(
          `No reference in the active v${plan.active.num} of "${flowName}" could be moved to ${_replField.api} — each mention is ` +
          `another object's field or sits where its object cannot be worked out. Nothing was deleted. ` +
          `Click "Open in Flow Builder" to change it by hand, then run the fix again for the old versions.`);
        const u = _flowBuilderUrl(plan.active.id); if (u) err.setupUrl = u;
        throw err;
      }
      if (changes === 0) {
        const err = new Error(
          `Couldn't auto-remove the field from the active v${plan.active.num} of "${flowName}" — the reference is ` +
          `in a path the auto-fix can't safely change (decision condition, formula expression, or variable default). ` +
          `Nothing was deleted. Click "Open in Flow Builder" to fix it by hand, then run ✂ Remove again for the old versions.`);
        const u = _flowBuilderUrl(plan.active.id); if (u) err.setupUrl = u;
        throw err;
      }
      delete metadata.fullName;
      const deployRes = await deployFlowViaMetadataApi(apiNameOf(plan.active.id), metadata);
      if (!deployRes || !deployRes.success) {
        const e = new Error(`Salesforce refused the fixed "${flowName}"${swapping ? ` (the version that uses ${_replField.api})` : ''}: ${deployRes?.error ? String(deployRes.error).replace(/\s+/g, ' ').slice(0, 300) : 'deploy failed'}. Nothing was deleted. Choose “Delete the active version too”, or open in Flow Builder to ${swapping ? 'change' : 'remove'} the field reference by hand.`);
        const u = _flowBuilderUrl(plan.active.id); if (u) e.setupUrl = u;
        throw e;
      }
      const ver = await _verifyFlowActivation(defId, maxNum, flowName, plan.active.id, journal, fp.versions);
      out.newVersion = ver.newVersion; out.newId = ver.newId; out.overwrote = !!ver.overwrote;
      // The new version must not mention the field either — formula and
      // decision text is outside what the auto-fix touches, so say so.
      const check = await bg({ type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid, sobject: 'Flow', id: ver.newId, _suppressError: true });
      out.stillMentions = !!(check?.Metadata && flowReferencesField(check.Metadata));
      if (swapping && check?.Metadata) {
        // After a swap, "still mentions" means: something of THIS field is left
        // (movable, or undecided) — a same-named field of another object is not.
        const again = await _flowSwap(JSON.parse(JSON.stringify(check.Metadata)));
        out.undecided = again.skipped.filter(x => x.why !== 'other').length;
        out.stillMentions = again.changed.length > 0 || out.undecided > 0;
      }
    }

    // 2b. the OTHER way: switch the flow off, verified, before its active
    // version may be deleted (user 2026-09-21). Every exit leaves the org as it was.
    if (plan.mode === 'active-delete') {
      const link = e => { const u = _flowBuilderUrl(plan.active.id); if (u) e.setupUrl = u; return e; };
      // confirmed-by: fixOne's sftkConfirmDestructive (the only caller of fixFlowExecute)
      // The write discipline (sftk-write.js): the PATCH is the write, the
      // re-read right below is the verify.
      let off = null;
      const offWr = await sftkWriteVerified({
        describe: `"${flowName}" deactivation`,
        journal,   // history-by: fixFlowExecute's own journal (from the caller)
        write: async () => { off = await bg({ type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid, _suppressError: true,
          path: `services/data/v62.0/tooling/sobjects/FlowDefinition/${defId}`,
          body: { Metadata: { activeVersionNumber: 0 } } }); return off; },
        verify: async () => {
          const r = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true, _suppressError: true,
            query: `SELECT Id, VersionNumber, Status FROM Flow WHERE DefinitionId = '${defId}'` });
          if (r?.error) throw new Error(`"${flowName}" could not be re-read after switching it off (${_feText(r.error)}) — nothing was deleted. Check it in Flow Builder.`);
          const stillActive = (r?.records || []).find(v => v.Status === 'Active');
          return { ok: !stillActive, detail: stillActive, text: null };
        },
      });
      if (!offWr.verified) throw link(new Error(offWr.text));
      const stillActive = offWr.detail;
      if (stillActive) {
        throw link(new Error(`"${flowName}" could NOT be switched off${off?.error ? ` — ${_feText(off.error)}` : ''}: v${stillActive.VersionNumber} is still active. Nothing was deleted.`));
      }
      out.deactivated = true;
    }

    // 3. flow interviews first, then the versions
    const skip = new Set();
    if (fp.interviews.length) {
      const di = await _deleteFlowInterviews(fp.interviews, journal);
      out.interviewsDeleted = di.deleted; out.interviewsFailed = di.failed; out.errors.push(...di.errors);
      for (const id of di.failedVersionIds) skip.add(id);
    }
    // never the version that now RUNS the flow
    const dv = await _deleteFlowVersionIds(plan.toDelete.map(v => v.id).filter(id => id !== out.newId), skip, journal);
    out.deleted = dv.deleted; out.failed = dv.failed; out.skipped = dv.skipped; out.errors.push(...dv.errors);
    // Undo: whichever mode ran, the version(s) that referenced the field —
    // including the one that WAS active — are among plan.toDelete and so are
    // gone for good (Salesforce holds no Recycle Bin for flow versions), and
    // a deleted interview cannot be re-created either. There is nothing here
    // that is safe to promise back (sftkHistoryEnd overrides this to "nothing
    // was accepted" automatically when nothing here was actually written).
    out.undo = { none: 'deleted flow version(s) and/or flow interview(s) cannot be re-created — a deleted version is gone for good' };
    return out;
  }

  // Does this flow-version metadata reference the selected field ANYWHERE?
  // Broader than removeFieldRefs (which only counts auto-removable refs):
  // walks every string value and matches both exact reference forms
  // (via _xiIsRef) and embedded formula/template tokens like
  // "{!$Record.Field__c} > 5" that exact-match tests miss.
  // Does this string mention the selected field? Token-boundary regex: the
  // field api name not preceded/followed by an identifier char, so Latest__c
  // doesn't false-match test__c. One test for the detector AND the preview.
  function _fieldStringTester() {
    const fl = (_selField?.api || '').toLowerCase();
    if (!fl) return null;
    const tokenRe = new RegExp(`(^|[^a-z0-9_])${fl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_]|$)`, 'i');
    return v => _xiIsRef(v) || tokenRe.test(v);
  }
  // Labels and descriptions are skipped (sftkFlowRefScan): a field name TYPED
  // into a description is not a dependency Salesforce locks on, and counting
  // it kept a cleaned flow reading "still references the field" forever.
  function flowReferencesField(metadata) {
    const test = _fieldStringTester();
    if (!test) return false;
    return sftkFlowRefScan(metadata, test).length > 0;
  }

  // Delete old (non-Active) versions of a flow that still reference the
  // selected field. Salesforce blocks custom-field deletion while ANY flow
  // version references it — deploying a fixed Active version is not enough,
  // the stale versions keep the lock. The fresh Active version is never
  // touched. Returns { purged, failed, stillBlocking } for the done-label.
  async function purgeOldFlowVersions(anyVersionId, flowName, journal) {
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
      const stale = [];
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
        stale.push(v);
      }
      if (!stale.length) return out;
      // Paused interviews block the delete — name them and ask, then clear
      // them first (user 2026-09-13: "delete flow interview dependencies").
      const skip = new Set();
      const { interviews, error: ivErr } = await _flowInterviewsFor(stale.map(v => v.Id));
      if (interviews.length) {
        const gate = await sftkOrgWriteGate(_orgUrl);
        const ok = await sftkConfirmDestructive({
          title: `Flow interviews on ${flowName}`,
          items: interviews.slice(0, 12).map(i => ({ label: i.InterviewLabel || i.Name,
            sub: /^error$/i.test(String(i.InterviewStatus || '')) ? `failed${i.CurrentElement ? ` at ${i.CurrentElement}` : ''}` : (i.CurrentElement ? `paused at ${i.CurrentElement}` : '') })),
          revOverride: { html: (() => { const w = sftkFlowInterviewWords(sftkFlowInterviewKinds(interviews));
            return `⏸ <strong>${w.head}</strong> sit on the old versions that still reference the field. Salesforce refuses to delete a version while they exist, so they are deleted first${w.cost ? ` — ${w.cost}` : ''}.`; })(), needsCheckbox: true },
          confirmLabel: '🗑 Delete interviews, then the versions',
          production: gate.production ? { label: gate.label } : null,
        });
        if (!ok) { out.stillBlocking = stale.length; return out; }
        const di = await _deleteFlowInterviews(interviews, journal);
        for (const id of di.failedVersionIds) skip.add(id);
      } else if (ivErr && window.SFToolkitDebug?.enabled) {
        window.SFToolkitDebug.log('fields', 'warn', `Paused-interview check failed for "${flowName}"`, ivErr);
      }
      const dv = await _deleteFlowVersionIds(stale.map(v => v.Id), skip, journal);
      out.purged = dv.deleted; out.failed = dv.failed + dv.skipped; out.stillBlocking = dv.failed + dv.skipped;
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
      // verified-by: fixLayout (the only caller) re-reads the Layout after
      // whichever path here it accepts.
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
    // verified-by: fixLayout (the only caller) re-reads the Layout after
    // whichever attempt below it accepts.
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
      // verified-by: fixLayout re-reads the Layout after this attempt too.
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
    // verified-by: fixFlowExecute (the only caller) calls
    // _verifyFlowActivation right after this returns.
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
    // verified-by: performRestore (popup.js, the only caller) re-reads the
    // flow's versions after this returns.
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
    const beforeMetadata = JSON.parse(JSON.stringify(metadata));   // pre-mutation copy for the History undo step

    // ⇄ Replace with another field: the new field takes the slot (or, when it
    // is already on the layout, the old slot becomes a blank space).
    const swap = _replOn();
    const swapTo = swap ? _replField.api : '';
    const sw = swap ? sftkLayoutReplaceField(metadata, _selField.api, swapTo, { readOnly: _replReadOnly() }) : null;
    const changes = swap ? sw.swapped + sw.blanked : removeFieldFromLayout(metadata, _selField.api);
    if (changes === 0) {
      throw new Error(
        `Field not found in "${componentName}" layout sections. ` +
        `It may be in a related list or inline edit only — ${swap ? 'change it' : 'remove'} manually.`
      );
    }

    // Path 1: Tooling API PATCH with progressive retry for VALUE_STRING errors.
    // Succeeds for most layouts and is fast (~1 round-trip). Path 2 (Metadata
    // API zip-deploy) is the fallback when Salesforce rejects the PATCH.
    // The write discipline (sftk-write.js): whichever path is accepted, the
    // verify re-reads the Layout and re-runs the same remover on a clone —
    // 0 changes left to make means the field is really gone.
    const fullName = res.FullName || res.fullName;
    let patchRes = null, deployErr;
    // History (sftk-history.js): one journal for this button press; the
    // undo re-PATCHes the layout's pre-fix metadata.
    const j = sftkHistoryBegin({ tool: 'Field Cleaner', title: `📋 Layout — "${componentName}" (${_selObj.api}.${_selField.api} ${swap ? `→ ${swapTo}` : 'removed'})`, orgUrl: _orgUrl });
    let wr;
    try {
      // confirmed-by: fixOne's sftkConfirmDestructive (the only caller)
      wr = await sftkWriteVerified({
        describe: `"${componentName}" layout`,
        journal: j,
        write: async () => {
          patchRes = await patchLayoutMetadata(componentId, sanitizeLayoutMetadata(metadata));
          if (!patchRes.error) return patchRes;
          if (fullName) {
            const deployRes = await deployLayoutViaMetadataApi(fullName, metadata);
            if (deployRes && deployRes.success) return deployRes;
            deployErr = deployRes && deployRes.error;
          }
          return { error: patchRes.error };
        },
        verify: async () => {
          const after = await bg({ type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid, _suppressError: true,
            sobject: 'Layout', id: componentId });
          if (!after || after.error || !after.Metadata) return { ok: false, text: null };
          const left = removeFieldFromLayout(JSON.parse(JSON.stringify(after.Metadata)), _selField.api);
          // a swap is only done when the old field is gone AND the new one is there
          const hasNew = !swap || (after.Metadata.layoutSections || []).some(sec => (sec.layoutColumns || []).some(col =>
            (col.layoutItems || []).some(it => it && String(it.field || '').toLowerCase() === swapTo.toLowerCase())));
          return { ok: left === 0 && hasNew, text: null };
        },
      });
      if (wr.accepted && wr.ok) {
        return swap
          ? (sw.swapped ? `✅ Layout updated · ${swapTo} now sits where ${_selField.api} was — verified by re-reading the org`
                        : `✅ Layout updated · ${swapTo} was already on the layout, so the old slot is now a blank space — verified by re-reading the org`)
          : undefined;
      }
      if (wr.accepted) throw new Error(swap
        ? `"${componentName}" was saved, but on re-read it does not show ${swapTo} in place of the field — check it in Setup.`
        : `"${componentName}" was saved but still references the field on re-read — check it in Setup.`);

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
    } finally {
      await sftkHistoryEnd(j, { undo: wr && wr.accepted
        ? { steps: [{
            describe: `Put "${componentName}" layout back the way it was before this fix`,
            // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
            msg: { type: 'SF_PATCH', path: `services/data/v62.0/tooling/sobjects/Layout/${componentId}`, body: { Metadata: beforeMetadata } },
            // Layout metadata has no Tooling SOQL read (only the PATCH/GET
            // detail endpoint this tool already uses, which the undo runner's
            // query-only re-read cannot call) — accepted, not re-read.
            verify: null,
          }] }
        : { none: 'nothing was accepted by Salesforce, so there is nothing to undo' } });
    }
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
    const beforeMetadata = JSON.parse(JSON.stringify(metadata));   // pre-mutation copy for the History undo step

    // ⇄ Replace with another field: field components and visibility rules
    // are pointed at the new field (sftk-fieldreplace.js).
    const swap = _replOn();
    const swapTo = swap ? _replField.api : '';
    const sw = swap ? sftkFlexiReplaceField(metadata, _selObj.api, _selField.api, swapTo) : null;
    const changes = swap ? sw.swapped + sw.dropped : removeFieldFromFlexiPage(metadata, _selObj.api, _selField.api);
    if (changes === 0) {
      throw new Error(
        `No direct field references found in "${componentName}". ` +
        (swap && sw.left ? `${sw.left} mention(s) reach the field through a related record, which is another object's field and is left alone. ` : '') +
        `The dependency may be inside a custom component — ${swap ? 'change it' : 'remove'} manually in App Builder.`
      );
    }

    // History (sftk-history.js): one journal for this button press; the
    // undo re-PATCHes the FlexiPage's pre-fix metadata.
    const j = sftkHistoryBegin({ tool: 'Field Cleaner', title: `🧩 FlexiPage — "${componentName}" (${_selObj.api}.${_selField.api} ${swap ? `→ ${swapTo}` : 'removed'})`, orgUrl: _orgUrl });
    let wr;
    try {
      // confirmed-by: fixOne's sftkConfirmDestructive (the only caller)
      // The write discipline (sftk-write.js): the PATCH is the write; the
      // verify re-reads the FlexiPage and runs the same remover on a clone —
      // 0 changes left to make means the field is really gone.
      wr = await sftkWriteVerified({
        describe: `"${componentName}" FlexiPage`,
        journal: j,
        write: () => bg({
          type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid,
          path: `services/data/v62.0/tooling/sobjects/FlexiPage/${componentId}`,
          body: { Metadata: metadata }
        }),
        verify: async () => {
          const after = await bg({ type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid, _suppressError: true,
            sobject: 'FlexiPage', id: componentId });
          if (!after || after.error || !after.Metadata) return { ok: false, text: null };
          if (swap) {
            // nothing left to move on re-read = the swap really landed
            const again = sftkFlexiReplaceField(JSON.parse(JSON.stringify(after.Metadata)), _selObj.api, _selField.api, swapTo);
            return { ok: again.swapped + again.dropped === 0, text: null };
          }
          const left = removeFieldFromFlexiPage(JSON.parse(JSON.stringify(after.Metadata)), _selObj.api, _selField.api);
          return { ok: left === 0, text: null };
        },
      });
      if (!wr.accepted) throw new Error(`Could not save "${componentName}": ${_feText((wr.raw && wr.raw.error) || 'refused')}`);
      if (!wr.ok) throw new Error(`"${componentName}" was saved but still references the field on re-read — check it in App Builder.`);
      if (swap) {
        const bits = [];
        if (sw.swapped) bits.push(`${sw.swapped} place${sw.swapped === 1 ? '' : 's'} now use${sw.swapped === 1 ? 's' : ''} ${swapTo}`);
        if (sw.dropped) bits.push(`${sw.dropped} component${sw.dropped === 1 ? '' : 's'} dropped — the page already showed ${swapTo}`);
        if (sw.left) bits.push(`⚠ ${sw.left} mention${sw.left === 1 ? '' : 's'} through a related record left alone (another object's field)`);
        return `✅ Page updated · ${bits.join(' · ')} — verified by re-reading the org`;
      }
    } finally {
      await sftkHistoryEnd(j, { undo: wr && wr.accepted
        ? { steps: [{
            describe: `Put "${componentName}" FlexiPage back the way it was before this fix`,
            // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
            msg: { type: 'SF_PATCH', path: `services/data/v62.0/tooling/sobjects/FlexiPage/${componentId}`, body: { Metadata: beforeMetadata } },
            verify: { query: `SELECT Id, Metadata FROM FlexiPage WHERE Id = '${componentId}'`, tooling: true,
              pick: 'records.0.Metadata',
              text: { ok: `"${componentName}": FlexiPage restored — verified by re-reading the org`,
                      bad: `"${componentName}": accepted by Salesforce, but the org could not confirm the restore` } },
          }] }
        : { none: 'nothing was accepted by Salesforce, so there is nothing to undo' } });
    }
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
      // a right-hand side is a plain string in the API's JSON; it names the
      // field only when written as a merge field ({!Record.Field})
      const rightRef = c => { const v = typeof c.rightValue === 'string' ? c.rightValue : c.rightValue?.value; return typeof v === 'string' && v.startsWith('{!') && refMatches(v); };
      rule.criteria = rule.criteria.filter(c => !refMatches(c.leftValue) && !rightRef(c));
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
    // The rule lives under `visibilityRule` — what the Tooling API returns (read
    // live 2026-10-04 on a real page). This looked only at
    // `componentVisibilityRule`, a key the API never sends, so a visibility
    // rule that used the field was never cleaned and the re-read (the same
    // function) still called the page clean.
    function cleanInstanceVisibility(inst) {
      if (!inst) return;
      for (const key of ['visibilityRule', 'componentVisibilityRule']) {
        if (!inst[key]) continue;
        const cleaned = cleanVisibilityRule(inst[key]);
        if (cleaned === null) delete inst[key];
        else inst[key] = cleaned;
      }
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
      Report:         '/lightning/o/Report/home',
      ReportType:     '/lightning/setup/CustomReportTypes/home',
      EmailTemplate:  '/lightning/o/EmailTemplate/home',
      ApprovalProcess:'/lightning/setup/ApprovalProcesses/home',
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
    const gate = await sftkOrgWriteGate(_orgUrl);
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
      production: gate.production ? { label: gate.label } : null,
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
        'dependency the index did not report (an approval process, an email ' +
        'template, or a criteria-based sharing rule — see the note above), (b) the field is ' +
        'referenced by a MANAGED package component (read-only), or (c) your ' +
        'user lacks "Customize Application" / "Modify Metadata". Resolve the ' +
        'remaining reference, then retry. (Salesforce said: ' + s.replace(/\s+/g, ' ').slice(0, 400) + ')';
    }
    if (/in use|cannot delete.*because|referenced/i.test(s)) {
      return 'The field is still referenced somewhere. Fix the listed ' +
        'dependencies above (and check approval processes, email templates and ' +
        'criteria-based sharing rules, which the dependency index may not report), then re-scan and delete again. ' +
        `(Raw: ${s})`;
    }
    return s;
  }

  // Delete one custom field through the Metadata API: a deploy whose
  // destructiveChanges.xml names the field and whose package.xml is empty.
  // Returns { success } or { error } — the deploy's own words on failure.
  async function _deleteFieldViaMetadata(fullName) {
    const enc = new TextEncoder();
    const pkg = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <version>62.0</version>',
      '</Package>',
    ].join('\n');
    const del = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <types>',
      `        <members>${_lxEsc(fullName)}</members>`,
      '        <name>CustomField</name>',
      '    </types>',
      '    <version>62.0</version>',
      '</Package>',
    ].join('\n');
    if (typeof window.sftkBuildStoredZip !== 'function') return { error: 'The zip builder is not loaded on this page' };
    const zipBase64 = window.sftkBuildStoredZip([
      { name: 'package.xml',            data: enc.encode(pkg) },
      { name: 'destructiveChanges.xml', data: enc.encode(del) },
    ]);
    // verified-by: doDelete (the only caller) re-reads the field after any
    // delete this function reports successful.
    const r = await bg({ type: 'SF_METADATA_DEPLOY', orgUrl: _orgUrl, sid: _sid, zipBase64, _suppressError: true });
    return r?.error ? { error: r.error } : { success: true };
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

    // History (user 2026-10-02: "deleted a field. dont see any history and
    // rollback here") — the delete is journaled like every other tool write.
    // Undo is NOT offered: Salesforce has no API to undelete a custom field;
    // the entry says where the way back is (Setup → Deleted Fields, 15 days).
    const j = (typeof sftkHistoryBegin === 'function') ? sftkHistoryBegin({ tool: 'Field Cleaner', title: `🗑 Delete field — ${_selObj?.api}.${_selField?.api}`, orgUrl: _orgUrl }) : null;
    // verified-by: the re-read below (before "if (res.error)"), which
    // reports the delete refused if the field can still be read back.
    let res = await bg({
      type: 'SF_TOOLING_DELETE', orgUrl: _orgUrl, sid: _sid,
      sobject: 'CustomField', id: fieldId, _suppressError: true
    });
    // A Tooling DELETE of a CustomField came back INSUFFICIENT_ACCESS_ON_
    // CROSS_REFERENCE_ENTITY in every org tried (live 2026-09-22: two orgs,
    // even a brand-new text field nothing references), while the Metadata
    // API deleted the same field at once. So the Metadata API is the second
    // try for ANY refusal — and when it refuses too, its component failure
    // names the real blocker, which the Tooling text never did.
    let via = 'tooling';
    if (res?.error) {
      if (btn) btn.textContent = '⏳ Deleting (Metadata API)…';
      const md = await _deleteFieldViaMetadata(`${_selObj?.api}.${_selField?.api}`);
      if (md.error) res = { error: md.error, toolingError: res.error };
      else { res = { success: true }; via = 'metadata'; }
    }
    if (_delLogEntry) _delLogEntry.via = via;

    // The write discipline (sftk-write.js): the delete above is the write,
    // this re-read is the verify — never trust the DELETE/deploy's own
    // answer. Costs one query, only when the write claimed success.
    if (!res.error) {
      const chk = await bg({ type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid, _suppressError: true,
        sobject: 'CustomField', id: fieldId });
      // A deleted custom field is NOT gone from the Tooling API: Salesforce
      // keeps its row for the 15-day grace period under the name X_del (live
      // 2026-09-27: the delete had worked and this read judged it refused).
      // Deleted = unreadable, or readable under a _del name / another name.
      const devName = chk && !chk.error ? String(chk.DeveloperName || chk.FullName || '').replace(/^.*\./, '') : '';
      const wantName = String(_selField?.api || '').replace(/__c$/, '');
      const stillThere = !!(chk && !chk.error) && devName === wantName;
      if (stillThere) res = { error: `Salesforce (${via === 'metadata' ? 'Metadata API' : 'Tooling API'}) said the field was deleted, but it can still be read back — treat this as unverified and check it in Object Manager.` };
    }

    const _graceEndIso = new Date(Date.now() + 15 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    if (j && typeof sftkHistoryNote === 'function') {
      sftkHistoryNote(j, { ok: !res.error, accepted: !res.error, verified: !res.error, text: res.error ? String(res.error) : `deleted through the ${via === 'metadata' ? 'Metadata' : 'Tooling'} API and re-read: no longer a readable field` },
        `Delete ${_selObj?.api}.${_selField?.api} in ${String(_orgUrl || '').replace(/^https?:\/\//, '').replace(/\.my\.salesforce\.com.*$/, '')}`);
      try {
        await sftkHistoryEnd(j, { undo: { none: res.error
          ? 'nothing was accepted by Salesforce, so there is nothing to undo'
          : `Salesforce has no API to undelete a custom field. Until about ${_graceEndIso} it can be restored by hand: Setup → Object Manager → ${_selObj?.api} → Fields & Relationships → Deleted Fields → Undelete (it comes back named ${String(_selField?.api || '').replace(/__c$/, '')}_del__c — rename it). The Toolkit keeps a metadata snapshot in its deletion log.` } });
      } catch (_) { /* the journal is best-effort — the delete already happened */ }
    }
    if (res.error) {
      if (btn) { btn.disabled = false; btn.textContent = '🗑 Delete Field'; }
      const errEl = document.createElement('div');
      errEl.className = 'fc-error-msg';
      errEl.innerHTML = `❌ Delete failed: ${esc(_explainDeleteError(res.error))}`;
      if (res.toolingError) errEl.title = `Tooling API said: ${String(res.toolingError).slice(0, 300)}`;
      eid('fcResults').appendChild(errEl);
    } else {
      // The picker must forget the field (user 2026-10-02: it stayed in the
      // list and a re-scan said "Could not locate this field").
      const gone = String(_selField?.api || '');
      _allFields = (_allFields || []).filter(f => f && f.api !== gone && f.name !== gone);
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
      const objApi = _selObj.api, fldApi = _selField.api;
      // resetFieldAndBelow() empties the results area and forgets the field —
      // it used to run AFTER the card below and erased it (live 2026-09-22: a
      // blank page after a successful delete). Reset first, then the card.
      resetFieldAndBelow();
      const fi = eid('fcFieldInput'); if (fi) fi.value = '';
      eid('fcResults').innerHTML = `
        <div class="fc-success">
          <div class="fc-success-icon">✅</div>
          <div class="fc-success-title">Field deleted${via === 'metadata' ? ' (through the Metadata API — the Tooling API refused)' : ''}</div>
          <div class="fc-success-sub">
            ${esc(objApi)}.${esc(fldApi)} is deleted — and still restorable for ~15 days
            (until about ${esc(_graceEnd)}) via
            <a href="${esc(_orgUrl)}/lightning/setup/ObjectManager/${esc(objApi)}/FieldsAndRelationships/view"
               target="_blank" rel="noopener">Object Manager → Fields</a> → <strong>Deleted Fields</strong>.
            After that it's permanent. A metadata snapshot was saved to the Toolkit's deletion log.
          </div>
        </div>`;
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

    // The version picture BEFORE the deploy — the activation check needs it.
    const before = await _flowVersionsOf(flowId);
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
    // History (sftk-history.js): one journal for this button press — the
    // activation write and the stale-version/interview purge below all land
    // in the same entry. Old versions removed here are gone for good, so
    // there is no undo to offer (see the reasoning on fixFlowExecute's undo).
    const journal = sftkHistoryBegin({ tool: 'Field Cleaner', title: `✂ Flow — ${flowName} (${removed} block(s) removed)`, orgUrl: _orgUrl });
    try {
      // The new version must be ACTIVE — verified by re-reading the org
      // (activated here if the deploy left it inactive); nothing is purged
      // before that is established.
      await _verifyFlowActivation(before.defId, before.maxNum, flowName, flowId, journal, before.versions);
      // Stale versions still referencing the field keep the dependency lock —
      // purge them so the field delete isn't blocked (see purgeOldFlowVersions).
      return await purgeOldFlowVersions(flowId, flowName, journal);
    } finally {
      await sftkHistoryEnd(journal, { undo: { none: 'deleted flow version(s) and/or flow interview(s) cannot be re-created — a deleted version is gone for good' } });
    }
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
          const gate = await sftkOrgWriteGate(_orgUrl);
          const sure = await sftkConfirmDestructive({
            title: `Remove ${selSet.size} block(s) — ${componentName}`,
            icon: '✂',
            items: [{ label: componentName, sub: `${selSet.size} of ${totalDeletable} reference(s) selected` }],
            revOverride: { html: '🔁 Deploys a new flow version without the selected blocks (the previous version remains and can be re-activated). ⚠ Any OLD, INACTIVE versions of this flow that still reference the field are then <strong>permanently deleted</strong> to clear the dependency lock — Salesforce holds no Recycle Bin for flow versions.', needsCheckbox: true },
            confirmLabel: '✂ Remove selected',
            production: gate.production ? { label: gate.label } : null,
          });
          if (!sure) return;
          selBtn.disabled = true; selBtn.textContent = '⏳ Removing…';
          try {
            // confirmed-by: the sftkConfirmDestructive right above
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
              // Same rule as the one-click fix: a refused old version is not
              // done — the row keeps its button and the field stays locked.
              if (purge?.stillBlocking) throw new Error(`Not finished: ${purge.stillBlocking} old version(s) couldn't be deleted — still blocking the field delete${purge.purged ? ` (${purge.purged} purged)` : ''}. Clear the cause (paused or failed interviews, usually), then try again.`);
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
      btn.addEventListener('click', async () => {
        const snap = mine.find(s => String(s.at) === btn.dataset.snapAt);
        if (!snap) return;
        const gate = await sftkOrgWriteGate(_orgUrl);
        const sure = await sftkConfirmDestructive({
          title: `Restore ${snap.type} — ${snap.name}`,
          icon: '↩',
          items: [{ label: snap.name, sub: snap.type }],
          revOverride: { html: `Redeploys the previous ${esc(snap.type)} metadata exactly as it was before this fix — this re-introduces the removed reference(s) to the field.`, needsCheckbox: false },
          confirmLabel: '↩ Restore',
          production: gate.production ? { label: gate.label } : null,
        });
        if (sure) restoreSnapshot(snap, btn);
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
        // History (sftk-history.js): this button IS the undo of the fix that
        // took the snapshot, so it gets its own journaled entry — its own
        // undo is simply to run the fix again from the tool.
        const j = sftkHistoryBegin({ tool: 'Field Cleaner', title: `↩ Restore FlexiPage — "${snap.name}"`, orgUrl: _orgUrl });
        try {
          // confirmed-by: the ↩ Restore sftkConfirmDestructive (the only caller)
          // The write discipline (sftk-write.js): the PATCH is the write, a
          // re-read of the FlexiPage is the verify.
          const wr = await sftkWriteVerified({
            describe: 'FlexiPage restore',
            journal: j,
            write: () => bg({ type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid,
              path: `services/data/v62.0/tooling/sobjects/FlexiPage/${snap.id}`,
              body: { Metadata: md } }),
            verify: async () => {
              const chk = await bg({ type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid, _suppressError: true,
                sobject: 'FlexiPage', id: snap.id });
              return { ok: !!(chk && !chk.error && chk.Metadata), text: null };
            },
          });
          if (!wr.accepted) throw new Error((wr.raw && wr.raw.error) || 'refused');
          if (!wr.ok) throw new Error('restored, but the org could not be re-read to confirm it — check it in App Builder');
        } finally {
          await sftkHistoryEnd(j, { undo: { none: 'this is itself the undo — redo the fix from the tool to remove the field reference again' } });
        }
      } else if (snap.type === 'Report') {
        // History (sftk-history.js): this button IS the undo of the fix that
        // took the snapshot, so it gets its own journaled entry — its own
        // undo is simply to run the fix again from the tool.
        const j = sftkHistoryBegin({ tool: 'Field Cleaner', title: `↩ Restore Report — "${snap.name}"`, orgUrl: _orgUrl });
        try {
          // confirmed-by: the ↩ Restore sftkConfirmDestructive (the only caller)
          // The write discipline (sftk-write.js): the PATCH is the write, a
          // re-describe of the report is the verify.
          const wr = await sftkWriteVerified({
            describe: 'Report restore',
            journal: j,
            write: () => bg({ type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid,
              path: `services/data/v62.0/analytics/reports/${snap.id}`,
              body: { reportMetadata: md } }),
            verify: async () => {
              const chk = await bg({ type: 'SF_REST_GET', orgUrl: _orgUrl, sid: _sid, _suppressError: true,
                path: `services/data/v62.0/analytics/reports/${snap.id}/describe` });
              return { ok: !!(chk && !chk.error && chk.reportMetadata), text: null };
            },
          });
          if (!wr.accepted) throw new Error((wr.raw && wr.raw.error) || 'refused');
          if (!wr.ok) throw new Error('restored, but the org could not be re-read to confirm it — check the report in Salesforce');
        } finally {
          await sftkHistoryEnd(j, { undo: { none: 'this is itself the undo — redo the fix from the tool to remove the field reference again' } });
        }
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
