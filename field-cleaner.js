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

// ── The scope of a scan (2026-11-05, a colleague's first day: "show the
// dependencies that are required for deleting the field, and also the other
// mentions that don't, and allow to scan both of the options").
//   'both'     — everything (the default)
//   'blockers' — only what makes Salesforce REFUSE the delete: the dependency
//                index (Apex, rules, flows, templates…) plus the matching-rule
//                and workflow-field-update reads — the cheap scan
//   'mentions' — only the other mentions: the index's layouts, pages, reports,
//                plus the Lightning-page, report-type, list-view, compact-layout
//                and quick-action reads. The index answers both kinds in one
//                call, so the blockers it returns are still COUNTED for the
//                delete gate — hidden from the list, never from the decision.
// The namespace of a PACKAGED field ("dlrs__Color__c" → "dlrs"; "My_Field__c" → ""). A field's own name cannot
// hold a double underscore, so two of them before the suffix always mean a namespace prefix. A packaged field
// cannot be deleted from the org, and the package's own components are not readable — the scan must never call
// such a field "safe to delete" (user 2026-11-10: "ברחו לנו מלא מטאדאטה חבילתי … לוודא שגם האובייקטים החבילתיים נסרקים").
// What the check-only delete answered, as the box shows it (pure). r = the background's answer; listedBlockers =
// how many blockers the scan's list still shows.
//   → { kind: 'ok' | 'blocked' | 'error', head, lines: [Salesforce's own words, once each], foot }
// Does this error only say that the org has no such object, field or feature? Then the leg's answer is "none" — not
// a failed read (an org without Omni-Channel has no ServiceChannel; a setting may not be queryable). Pure.
function fcAbsentFeatureError(err) {
  return /INVALID_TYPE|sObject type '[^']*' is not supported|is not supported|INVALID_FIELD|No such column|FUNCTIONALITY_NOT_ENABLED|not enabled|NOT_FOUND|does not exist|INSUFFICIENT_ACCESS/i.test(String(err || ''))
    && !/INVALID_SESSION|REQUEST_LIMIT|timed? ?out|UNABLE_TO_LOCK|SERVER_UNAVAILABLE|HTTP 5\d\d/i.test(String(err || ''));
}
// The steps of a path that show the field among their key fields. PURE.
//   metadata: a PathAssistant's Metadata (Tooling) · same(fieldName) → is it the scanned field
// A custom metadata record holds the field's name: does that BLOCK the delete? (owner 2026-11-08: "וcmt?") Only a
// value in a metadata RELATIONSHIP column does (Field Definition / Entity Definition) — Salesforce describes such a
// column as a string with extraTypeInfo "externallookup" (read live 2026-11-16 on SFTK_Live_Cmt__mdt; a text column
// has none). A plain text value only breaks whatever reads it. PURE.
//   cols: the columns of the record that hold the name · fields: the type's describe fields, or null (not read)
//   → 'relation' (blocks) | 'text' (does not) | 'unknown' (not read, or a column the describe does not list)
function fcCmtHoldKind(cols, fields) {
  if (!Array.isArray(fields) || !Array.isArray(cols) || !cols.length) return 'unknown';
  const by = new Map(fields.map(f => [String((f && f.name) || '').toLowerCase(), f]));
  let known = 0;
  for (const c of cols) {
    const f = by.get(String(c).toLowerCase());
    if (!f) continue;
    known++;
    if (String(f.extraTypeInfo || '').toLowerCase() === 'externallookup') return 'relation';
  }
  return known === cols.length ? 'text' : 'unknown';
}
// The custom metadata TYPE of a record's full name ("Type.Record" → "Type__mdt"; a package's "ns__Type.Record" → "ns__Type__mdt"). PURE.
function fcCmtTypeApi(fullName) {
  const t = String(fullName || '').split('.')[0];
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(t) ? `${t}__mdt` : '';
}
// The Object Manager page of an object's search layouts. Read live 2026-11-17 (npc, Account and a packaged custom
// object): Object Manager's own "Search Layouts" link is …/MySearchLayouts/view; …/SearchLayouts/view draws an
// empty panel on both (owner: "When i navigated to the search layout. it opened a blank screen"). PURE.
function fcSearchLayoutsPage() { return 'MySearchLayouts'; }
// ⚡ ALL AT ONCE (owner 2026-11-17: "maybe we shouldn't do the replace and remove wizard. or at least give an option
// to do it all in one shot … what can be removed without ruining the component will be removed. what cannot be
// removed will be deleted" — and: "what if i want one component field ref removed and another component i would
// like to delete entirely"). One screen lists every open row with the way the tool picked; each row can be changed.
// What the tool picks for a row. kinds = the ways the row has right now ('replace' | 'remove' | 'delete').
//   ⇄ where a replacement is picked and the row can take it → ✂ where the component works without the field →
//   🗑 only for a row that BLOCKS the delete and is of a kind that holds no logic of its own → else it is left.
// Automation and code (a flow, Apex, a rule) are never picked for deletion: the owner picks that on the row. PURE.
function fcPlanDefault(kinds, type, sev) {
  const k = Array.isArray(kinds) ? kinds : [];
  if (k.includes('replace')) return 'replace';
  if (k.includes('remove')) return 'remove';
  const plain = ['FieldSet', 'WebLink', 'WorkflowFieldUpdate', 'WorkflowAlert', 'WorkflowOutboundMessage'];
  if (k.includes('delete') && sev === 'must' && plain.includes(String(type))) return 'delete';
  return 'leave';
}
// The plan in numbers. picks = the kind chosen per row ('leave' counts as left). PURE.
function fcPlanCounts(picks) {
  const c = { replace: 0, remove: 0, delete: 0, leave: 0 };
  for (const p of (Array.isArray(picks) ? picks : [])) c[c[p] === undefined ? 'leave' : p]++;
  c.run = c.replace + c.remove + c.delete;
  return c;
}
function fcPlanCountsText(c) {
  const bits = [];
  if (c.replace) bits.push(`${c.replace.toLocaleString('en-US')} replaced`);
  if (c.remove) bits.push(`${c.remove.toLocaleString('en-US')} removed`);
  if (c.delete) bits.push(`${c.delete.toLocaleString('en-US')} deleted`);
  if (c.leave) bits.push(`${c.leave.toLocaleString('en-US')} left for you`);
  return bits.join(' · ') || 'nothing to do';
}
// Is this confirmation one of the row the plan is working on? Only then the plan answers it. The row's dialogs name
// the component itself ("Name", or "Name v3" for a flow version); anything else — the flow's paused interviews,
// another button the user pressed meanwhile — is asked as always. PURE.
function fcPlanOwnsDialog(opts, name) {
  const items = (opts && Array.isArray(opts.items)) ? opts.items : [];
  const n = String(name == null ? '' : name);
  if (!n || !items.length) return false;
  return items.every(i => { const l = String((i && i.label) || ''); return l === n || (l.startsWith(n + ' v') && /^\d+$/.test(l.slice(n.length + 2))); });
}
// A custom setting's text value with the field's name taken out (owner 2026-11-16: "we said all items must have a
// delete/remove"). The value may be the name alone, or a list of names: only "Object.Field" and a bare "Field" go
// (whole word; a bare name written after another object's dot is that object's field and stays), and the separators
// left behind are tidied. PURE. → the new text ('' when nothing else was in it)
//   newField: ⇄ — the name is replaced, in the form it was written ("Object.Field" → "Object.New", "Field" → "New")
function fcSettingValueWithout(text, obj, field, newField) {
  const esc = x => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const o = esc(obj), f = esc(field), nf = newField ? String(newField) : '';
  let v = String(text == null ? '' : text)
    .replace(new RegExp('(^|[^A-Za-z0-9_.])' + o + '\\.' + f + '(?![A-Za-z0-9_])', 'gi'), (m, pre) => pre + (nf ? `${obj}.${nf}` : ''))
    .replace(new RegExp('(^|[^A-Za-z0-9_.])' + f + '(?![A-Za-z0-9_])', 'gi'), (m, pre) => pre + nf);
  if (nf) return v;
  v = v.replace(/[ \t]*([,;|])(?:[ \t]*[,;|])+[ \t]*/g, '$1 ').replace(/^[\s,;|]+|[\s,;|]+$/g, '');
  return v;
}
function fcPathStepsWith(metadata, same) {
  const steps = (metadata && Array.isArray(metadata.pathAssistantSteps)) ? metadata.pathAssistantSteps : [];
  return steps.filter(st => st && [].concat(st.fieldNames || []).some(f => same(String(f || ''))))
    .map(st => String(st.picklistValueName || '?'));
}
function fcAskVerdict(r, listedBlockers) {
  if (!r || r.error) return { kind: 'error', head: '⚠ Salesforce could not be asked', lines: [String((r && r.error) || 'no answer')], foot: '' };
  if (r.success) {
    return { kind: 'ok', head: '✅ Salesforce would accept the delete right now', lines: [],
      foot: listedBlockers > 0
        ? `The list still marks ${listedBlockers} item${listedBlockers === 1 ? '' : 's'} as blocking — Salesforce does not refuse over ${listedBlockers === 1 ? 'it' : 'them'}. Look at what ${listedBlockers === 1 ? 'it does' : 'they do'} before deleting.`
        : 'This answers only what blocks. What stops working without the field (👀) Salesforce does not say.' };
  }
  // Salesforce puts one sentence in front of every name ("This custom field is referenced elsewhere in salesforce.com. :
  // Workflow Rules.") — the head says it once and the lines keep the names
  const REF = /This custom field is referenced elsewhere in salesforce\.com\.\s*:?\s*/gi;   // the colon is missing after a sentence of another shape
  const seen = new Set(), lines = [];
  let ref = 0;
  for (const f of (r.failures || [])) {
    const p = String(f.problem || '').trim();
    // one problem may hold several of them back to back
    const parts = REF.test(p) ? (ref++, p.split(REF)) : [p];
    REF.lastIndex = 0;
    for (const x of parts) { const t = parts.length > 1 || ref ? x.trim().replace(/\.$/, '') : x.trim(); if (t && !seen.has(t)) { seen.add(t); lines.push(t); } }
  }
  if (!lines.length) lines.push(String(r.errorMessage || 'Salesforce refused and gave no reason'));
  return { kind: 'blocked', head: ref && ref === (r.failures || []).length ? '🔒 Salesforce refuses the delete — the field is referenced by:' : '🔒 Salesforce refuses the delete — in its own words:', lines,
    foot: listedBlockers > 0
      ? 'Salesforce names only some of what blocks. Clear the blockers listed — it is asked again when the list is clear.'
      : 'The scan did not find this — it is added to the list below as Salesforce names it.' };
}
// What a refusal names, line by line (user 2026-11-10: "If the scan continue missing it will be a problem for us").
// Salesforce's own wording, seen live on npc 2026-11-10:
//   Apex Class - SFTK_Live_Cls · Apex Trigger - SFTK_Live_Trg · Visualforce Page - SFTK_Live_VF
//   Aura Component Bundle "c:sftkLiveAura" - COMPONENT - sftkLiveAura
//   Field Updates · Workflow Rules                      (a kind only, no name)
// → [{ line, type, name, ns }] — type/name set when the line names ONE component of a kind the list can hold
//   (ns 'c' = the org's own); a line that names only a kind, or reads in words not seen yet, keeps type ''.
function fcAskNamed(lines) {
  const KINDS = [[/^Apex Class - (.+)$/i, 'ApexClass'], [/^Apex Trigger - (.+)$/i, 'ApexTrigger'],
    [/^Visualforce Page - (.+)$/i, 'ApexPage'], [/^Visualforce Component - (.+)$/i, 'ApexComponent']];
  const out = [];
  for (const raw of (lines || [])) {
    const line = String(raw || '').trim();
    if (!line) continue;
    let type = '', name = '', ns = 'c';
    const au = /^Aura Component Bundle "(?:([A-Za-z0-9_]+):)?([A-Za-z0-9_]+)"/.exec(line);
    if (au) { type = 'AuraDefinitionBundle'; ns = au[1] || 'c'; name = au[2]; }
    else for (const [re, t] of KINDS) {
      const m = re.exec(line);
      if (!m) continue;
      const full = m[1].trim(), k = full.indexOf('__');
      // a packaged component reads "ns__Name"; an org's own name never holds a double underscore
      if (/^[A-Za-z][A-Za-z0-9_]*$/.test(full)) { type = t; if (k > 0) { ns = full.slice(0, k); name = full.slice(k + 2); } else name = full; }
      break;
    }
    if (type && out.some(o => o.type === type && o.name === name && o.ns === ns)) continue;   // an Aura bundle is named once per file
    out.push({ line, type, name, ns });
  }
  return out;
}
// "Flow Version - 301bm00003G5k5w" says nothing a person can match to the list (owner 2026-11-11, five such lines over
// three flows with five version chips: "we are missing some flow versions here" — none was missing, the ids just
// could not be read). With the versions looked up, the lines become one per flow: "Flow SFTK Pkg Screen — v1 (not
// active) · v2 (Active)". A version that could not be looked up keeps Salesforce's own line. Pure.
//   byId: { <id15>: { flow, version, status } }
function fcAskFlowLines(lines, byId) {
  const out = [], at = new Map();
  for (const raw of (lines || [])) {
    const m = /^Flow Version - ([A-Za-z0-9]{15,18})$/.exec(String(raw || '').trim());
    const v = m && byId && byId[m[1].slice(0, 15)];
    if (!v) { out.push(raw); continue; }
    if (!at.has(v.flow)) { at.set(v.flow, { i: out.length, vs: [] }); out.push(''); }
    at.get(v.flow).vs.push(v);
  }
  for (const [flow, g] of at) {
    g.vs.sort((a, b) => (a.version || 0) - (b.version || 0));
    out[g.i] = `Flow ${flow} — ${g.vs.map(v => `v${v.version} (${/^active$/i.test(v.status) ? 'Active' : 'not active'})`).join(' · ')}`;
  }
  return out;
}
function fcAskFlowIds(lines) {
  return [...new Set((lines || []).map(l => (/^Flow Version - ([A-Za-z0-9]{15,18})$/.exec(String(l || '').trim()) || [])[1]).filter(Boolean))];
}
// Is a kind-only line ("Field Updates") already a group of the list ("Workflow Field Updates")?
function fcAskKindListed(line, groupLabels) {
  // word sets, order and punctuation aside: Salesforce says "Criteria-based Sharing Rules" for the list's "Sharing
  // Rules (criteria)", "Field Updates" for "Workflow Field Updates", and a whole sentence for a duplicate rule
  // ("This field is used by the following duplicate rules: X. Before you can delete…") — live 2026-11-11.
  const words = x => new Set(String(x || '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean).map(w => w.replace(/s$/, '')));
  const l = words(line);
  if (!l.size) return true;
  return (groupLabels || []).some(g => {
    const n = words(g);
    if (!n.size) return false;
    const [small, big] = n.size <= l.size ? [n, l] : [l, n];
    return [...small].every(w => big.has(w));
  });
}
function fcFieldNamespace(api) {
  const m = /^([A-Za-z](?:[A-Za-z0-9]|_(?!_))*)__[A-Za-z0-9_]+?__c$/.exec(String(api || '').trim());
  return m ? m[1] : '';
}
function fcScopeNorm(s) { return (s === 'blockers' || s === 'mentions') ? s : 'both'; }
function fcScopeKeeps(scope, sev) {
  const sc = fcScopeNorm(scope);
  if (sc === 'both') return true;
  return sc === 'blockers' ? sev === 'blocker' : sev !== 'blocker';
}
// Which legs a scan of that scope runs. The index query and the field-id
// lookup always run.
// Which legs a scan of that scope runs, for that object. The index query and
// the field-id lookup always run. Live-tested 2026-11-06 (npc, one fixture per
// reference type, each put to a destructive delete): what BLOCKS the delete
// is a Lightning page (so that leg runs in every scope), matching and
// duplicate rules (active or not), workflow rules (active or not), field
// updates, email alerts and outbound messages, approval processes (active or
// not), criteria-based sharing rules, a Lightning web component's schema
// import, a custom metadata record whose Field Definition points at the
// field, the lead field mapping (Lead and its targets) and a Lead/Case
// assignment, auto-response or escalation rule. The other mentions never do.
function fcScopeLegs(scope, objApi) {
  const sc = fcScopeNorm(scope);
  const o = String(objApi || '').toLowerCase();
  const blockers = sc !== 'mentions', mentions = sc !== 'blockers';
  return {
    flexiPages: true,
    matchingRules: blockers, workflowFieldUpdates: blockers, workflow: blockers, approvals: blockers,
    sharingRules: blockers, duplicateRules: blockers, lwc: blockers, aura: blockers, customMetadata: blockers,
    leadMapping: blockers && ['lead', 'account', 'contact', 'opportunity'].includes(o),
    objectRules: blockers && (o === 'lead' || o === 'case'),
    reportTypes: mentions, listViews: mentions, compactLayouts: mentions, quickActions: mentions, paths: mentions, validationRulesOff: mentions,
    emailTemplates: mentions,
    // 2026-11-11 (user: "תוסיף את אלו שעלולים לחסום אבל גם custom settings"): entitlement processes run on Case and
    // WorkOrder only; custom-setting RECORDS are data that can hold the field's name as text (👀)
    entitlements: blockers && (o === 'case' || o === 'workorder'),
    customSettings: mentions,
    searchLayouts: mentions,    // the object's search layouts: one metadata read of the object (2026-11-10)   // every template's text is read — Salesforce's index lists few of them (2026-11-10)
  };
}

// E3b — what a full dependency scan costs, stated honestly. The floor is the
// scan's fixed legs, counted from runScan/scanFlexiPages/scanSupplemental as
// written: field-id lookup (1) + MetadataComponentDependency query (1) +
// one list or query per leg that runs (the workflow leg lists rules, alerts
// and outbound messages: 3; the Lead/Case rules leg reads three containers:
// 3). Several legs then fan out one call PER ITEM the lists return (report
// types, approval processes, duplicate rules and custom metadata records: one
// call per 10 of them) — unknowable before the scan looks, so a count that
// hasn't been discovered yet stays a "more if", never a made-up number.
// counts: { flexiPages, listViews, quickActions, reportTypes, workflowRules,
// approvals, duplicateRules, customMetadata } — each a number when known,
// null/undefined when not. Returns { now, known, moreIf } where `now` is the
// call floor including every KNOWN leg and `moreIf` names the unknown ones.
function fcEstimateScanCalls(counts, scope, objApi) {
  const c = counts || {};
  const L = fcScopeLegs(scope, objApi);
  const known = v => (Number.isFinite(Number(v)) && Number(v) >= 0) ? Math.floor(Number(v)) : null;
  const legs = [
    L.flexiPages     && { count: known(c.flexiPages),     what: 'Lightning page in the org' },
    L.listViews      && { count: known(c.listViews),      what: 'list view on this object' },
    L.quickActions   && { count: known(c.quickActions),   what: 'create/update quick action on this object' },
    L.reportTypes    && { count: known(c.reportTypes),    what: '10 custom report types in the org' },
    L.workflow       && { count: known(c.workflowRules),  what: 'workflow rule, alert or outbound message on this object' },
    L.approvals      && { count: known(c.approvals),      what: '10 approval processes on this object' },
    L.duplicateRules && { count: known(c.duplicateRules), what: '10 duplicate rules on this object' },
    L.customMetadata && { count: known(c.customMetadata), what: '10 custom metadata records in the org (read up to 300)' },
    L.entitlements   && { count: known(c.entitlements),   what: '10 entitlement processes in the org' },
    L.customSettings && { count: known(c.customSettings), what: 'custom setting in the org (the first 30)' },
  ].filter(Boolean);
  // the fixed legs of this scope: field id + the index always; then one list or query per leg that runs
  // + the check-only delete (🩺 Ask Salesforce, every scan that looks for blockers): the deploy and its status read
  let now = 2 + (fcScopeNorm(scope) === 'mentions' ? 0 : 2) + [L.flexiPages, L.listViews, L.compactLayouts, L.quickActions, L.matchingRules, L.workflowFieldUpdates, L.reportTypes,
    L.approvals, L.sharingRules, L.duplicateRules, L.lwc, L.aura, L.customMetadata, L.leadMapping, L.paths, L.validationRulesOff, L.emailTemplates, L.searchLayouts, L.entitlements, L.customSettings].filter(Boolean).length
    + (L.workflow ? 3 : 0) + (L.objectRules ? 3 : 0);
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
  const fmt = v => Number(v).toLocaleString('en-US');
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
// 2026-11-17, read live on npc2 (3,336 objects): EntityDefinition REFUSES an OR ("HTTP 400: Disjunctions not
// supported"), so the one query that asked "name OR label" never answered and an object past the first 2,000 could
// not be picked at all. One query per column instead — `by` is 'label' for the label, anything else for the API name.
function fcObjectSearchSoql(term, limit, by) {
  const lit = fcSoqlLike(term);
  const n   = Math.max(1, Math.min(2000, Number(limit) || 200));
  return 'SELECT QualifiedApiName, Label, DurableId FROM EntityDefinition ' +
         'WHERE IsDeprecatedAndHidden = false ' +
         `AND ${by === 'label' ? 'Label' : 'QualifiedApiName'} LIKE ${lit} ` +
         `ORDER BY QualifiedApiName LIMIT ${n}`;
}
// The next page of the object list. EntityDefinition has no queryMore ("does not support queryMore(), use LIMIT to
// restrict the results to a single batch" — live 2026-11-17) and SOQL's OFFSET stops at 2,000, so the list is
// walked by its sort key: the names after the last one already held. PURE.
function fcObjectPageSoql(after, limit) {
  const n = Math.max(1, Math.min(2000, Number(limit) || 2000));
  const a = String(after == null ? '' : after).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return 'SELECT QualifiedApiName, Label, DurableId FROM EntityDefinition ' +
         'WHERE IsDeprecatedAndHidden = false ' +
         (a ? `AND QualifiedApiName > '${a}' ` : '') +
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
  let _orgGen = 0;          // bumped by init() on every org switch — an answer asked of the old org drops itself
  // Session-only: Feed/Share/History/ChangeEvent objects stay hidden until the
  // user asks for them in the picker.
  let _objShowSystem = false;
  let _groups    = {};     // type → [dep records] — kept for fixAll
  let _mcdCapped = false;  // last MCD query landed on the 2,000-row cap
  let _cmtUnread = 0;      // custom metadata records in the org when there were too many to read (0 = read)

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
  };
  // code — Apex class / trigger, Visualforce page / component, LWC and Aura bundles — is read, shown, edited and
  // renamed through the Tooling API (user 2026-11-08: "צריך להיות בכולם")
  function _inspectsByCode(type) { const s = typeof sftkMdDeleteSpec === 'function' ? sftkMdDeleteSpec(type) : null; return !!(s && (s.code || s.bundle)); }

  // ── Public API ─────────────────────────────────────────────
  function init(container, orgUrl, sid) {
    _orgUrl    = orgUrl;
    _sid       = sid;
    _container = container;
    _descCache.clear(); _replField = null; _replCompat = null;
    // 2026-11-14 (release QA): init() runs again on an org switch (popup.js resetOrgState), but it kept the previous
    // org's object list (_objectsLoaded stayed true, so the picker drew the OLD org's objects), the picked object and
    // field, the last scan, and any sweep / report scan still running — which then went on calling the NEW org with
    // the old org's ids. Every per-org piece is reset here, and _orgGen makes an answer that was asked of the old
    // org drop itself when it lands.
    _orgGen++;
    _objectsLoaded = false; _allObjects = []; _objListCount = 0; _objCapped = false; _objTopping = false;
    _objSearchInFlight = null; _objSearchErr = null; _objSearchSeq++; clearTimeout(_objSearchTimer); _objSearchTimer = null;
    _objSearchDone.clear(); _objSearchTried.clear();
    _allFields = []; _fieldsTotal = 0; _fieldsCapped = false;
    _selObj = null; _flsSeq++;
    resetFieldAndBelow();   // the field, the scan, ⇄, the copy, the sweep and the report scan (their loops stop on it)
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
        <div id="fcUndoAll"></div>
        <div id="fcResults"></div>
        <!-- 2026-11-16 (owner: "we should remove history from field cleaner page. same for the restore points. we have
             the activity tab for them"): the list of changes and the restore points are in Activity (top bar). -->

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
        const gen = _orgGen;
        drop.innerHTML = `<div class="fc-dd-loading">${sftkCatSm('Loading objects…')}</div>`;
        drop.style.display = '';
        // Phase 1 — ONE page, painted immediately. An org with fewer objects
        // than a page finishes here and is no slower than before the fix.
        const res = await bg({
          type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true,
          query: objectListSoql(FC_TOOLING_PAGE)
        });
        if (gen !== _orgGen) return;   // the org changed while the list loaded: the new org's picker loads its own
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
    const gen = _orgGen;
    // page after page by the sort key (fcObjectPageSoql): a page that is not full is the last one
    let last = (_allObjects.length && _allObjects[_allObjects.length - 1].api) || '';
    let got = _objListCount, ended = false;
    while (last && got < FC_OBJ_LIMIT) {
      const res = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true, query: fcObjectPageSoql(last, FC_TOOLING_PAGE), _suppressError: true });
      if (gen !== _orgGen) return;
      if (!res || res.error) break;                       // the list stays "incomplete" — the name search covers it
      const rows = mapEntityRows(res.records);
      _allObjects = fcMergeEntries(_allObjects, rows).list;
      got += rows.length;
      if (rows.length < FC_TOOLING_PAGE) { ended = true; break; }
      const next = rows[rows.length - 1].api;
      if (!next || next === last) break;                  // no progress: stop, never spin
      last = next;
    }
    if (gen !== _orgGen) return;
    _objTopping = false;
    _objListCount = got;
    _objCapped    = !ended;
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
    // one query per column — EntityDefinition refuses an OR (fcObjectSearchSoql)
    const both = await Promise.all(['api', 'label'].map(by => bg({
      type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true,
      query: fcObjectSearchSoql(term, FC_SEARCH_LIMIT, by)
    })));

    // A newer search superseded this one (or the picker was rebuilt): drop the
    // response. Rendering it would paint a list for a term the user replaced.
    if (seq !== _objSearchSeq) return;
    _objSearchInFlight = null;
    _objSearchTried.add(key);
    const bad = both.find(r => !r || r.error);
    if (bad) _objSearchErr = sftkFriendlyError((bad && bad.error) || 'no answer').message;
    let capped = false;
    for (const res of both) {
      if (!res || res.error) continue;
      const rows  = mapEntityRows(res.records);
      _allObjects = fcMergeEntries(_allObjects, rows).list;
      if (fcLooksCapped(rows.length, FC_SEARCH_LIMIT)) capped = true;
    }
    // Only a search where BOTH answered and neither capped out proves "everything containing this
    // term is now local" — the claim fcShouldServerSearch relies on.
    if (!bad && !capped) _objSearchDone.add(key);
    const d = eid('fcObjDrop');
    if (d && d.style.display !== 'none') renderObjDrop(eid('fcObjInput')?.value);
  }

  async function selectObject(api, label, durableId) {
    const gen = _orgGen;
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
    if (gen !== _orgGen) return;   // 2026-11-14: asked of an org the popup has since left

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
    _rptScan = null; _lastScan = null; _orgSweep = null; _rtScanned = null; _everyNote = '';
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
    // the lists under the results are about the picked field (owner 2026-11-16): they follow the pick
    try { if (typeof renderSnapshotLog === 'function') renderSnapshotLog(); } catch (_) { /* a view */ }

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
    _paintScope();

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
  // Which way the fix that is RUNNING goes: true = move the reference to the
  // replacement field, false = take it out; null = no fix is running. It is
  // chosen PER ITEM, by the button pressed — replace mode only adds the second
  // button (user 2026-10-05: "if i want to replace only one of them it will
  // replace them all. some i want to be able to delete and some to replace").
  let _fixSwap = null;
  let _flowDropOutcomes = false;   // the confirm's third way for a flow: outcomes that rest on the field go as a whole
  let _fixWay = '';   // a flow card's own decision: 'keep' (new active version) | 'off' (delete the active one too) | '' (not made: a bulk walk)
  function _swapOn() { return _fixSwap === true && _replOn(); }
  // One card per flow (the index lists a flow once per version that mentions
  // the field): [{ key, name, primaryId, active, versions: [{ id, num, status }] }]
  let _flowCards = [];
  let _curFieldId = null;
  function _flowCardsOf(items) {
    const by = new Map();
    for (const d of (items || [])) {
      const id = String(d.MetadataComponentId || '');
      const info = _flowVerInfo[id.substring(0, 15)] || {};
      const key = info.defId ? String(info.defId).substring(0, 15) : `n:${d.MetadataComponentName || id}`;
      if (!by.has(key)) by.set(key, { key, name: d.MetadataComponentName || id, versions: [] });
      by.get(key).versions.push({ id, num: info.num || 0, status: info.status || '', pb: !!info.pb });
    }
    return [...by.values()].map(c => {
      c.versions.sort((a, b) => b.num - a.num);
      c.active = c.versions.find(v => v.status === 'Active') || null;
      c.primaryId = (c.active || c.versions[0]).id;      // the card's id, and the version the fix starts from
      c.pb = c.versions.some(v => v.pb);                 // a Process Builder process: shown, counted as a blocker, never edited here
      return c;
    });
  }
  // The card line of a Process Builder process: no buttons, the way to Setup.
  function _pbNoteHtml() {
    return `<span class="fc-pb-note" title="A Process Builder process blocks the delete like a flow, but is not edited here">⚙ Process Builder — open it in Setup (Process Automation → Process Builder): take the field out of its criteria and actions, or deactivate and delete the process; then re-scan.</span>`;
  }
  // The fix buttons of ONE item. Replace mode shows two — the user chooses for
  // this item. A flow with no active version that uses the field has nothing
  // to replace: its old versions can only be deleted.
  function _fixBtnsHtml(type, id, rawName) {
    const attrs = `data-id="${esc(id)}" data-name="${esc(rawName)}" data-type="${esc(type)}"`;
    if (type === 'Flow') {
      const card = _flowCards.find(c => c.primaryId === String(id));
      // a Process Builder process is never rewritten here, but it can go as a whole (user 2026-11-07: "צריך את כולם")
      if (card && card.pb) return `<button class="btn btn-danger btn-sm fc-fix-btn fc-del-btn" ${attrs} data-swap="0" data-way="delete" title="Delete every version of this process (switched off first if it runs) — its latest version is kept as a restore point; ↩ Undo deploys it back as a new, inactive version">🗑 Delete process</button>`;
      if (card && !card.active) {
        return `<button class="btn btn-secondary btn-sm fc-fix-btn" ${attrs} data-swap="0" title="Delete the old versions that still mention the field">🗑 Delete ${card.versions.length} old version${card.versions.length === 1 ? '' : 's'}</button>`;
      }
      if (card) {
        // A flow that RUNS on the field leaves one small decision, and it is
        // made here on the card (user 2026-10-05: "remove the field, and create
        // a new active version without him. remove the field and delete
        // everything including the active versions. in a replace we will just
        // create a new active version with the new field").
        const keep = `<button class="btn btn-secondary btn-sm fc-fix-btn" ${attrs} data-swap="0" data-way="keep" title="Saves a new active version without the field, then deletes the versions that mention it. The flow keeps running.">✂ Remove · flow keeps running</button>`;
        const off = `<button class="btn btn-secondary btn-sm fc-fix-btn" ${attrs} data-swap="0" data-way="off" title="Switches the flow off and deletes every version that mentions the field, the active one too. The flow stops running.">🗑 Delete versions · flow off</button>`;
        const move = _replOn() ? `<button class="btn btn-primary btn-sm fc-fix-btn" ${attrs} data-swap="1" title="Saves a new active version that uses ${esc(_replField.api)} instead of the field. The flow keeps running.">⇄ Replace</button>` : '';
        return move + keep + off;
      }
    }
    // 🗑 Delete the whole component — every blocker kind the delete engine knows (user 2026-11-07: one click for anything that must go)
    const cfgT = TYPE_CFG[type] || TYPE_CFG_DEFAULT;
    // a blocker, or a 👀 mention the engine knows (list views, compact layouts, quick actions, inactive rules — user
    // 2026-11-08: "why here we can't do anything?")
    const knownKind = !cfgT.fixable && (cfgT.sev === 'blocker' || cfgT.sev === 'silent');
    const spec = (knownKind && typeof sftkMdDeleteSpec === 'function') ? (sftkMdDeleteSpec(type) || (type === 'LookupFilter' ? { what: 'lookup filter' } : null) || _extraDeleteSpec(type, id)) : null;
    if (spec && spec.special === 'settingValue') return (_replOn() ? `<button class="btn btn-primary btn-sm fc-fix-btn fc-del-btn" ${attrs} data-swap="1" data-way="delete" title="Write ${esc(_replField.api)} where this record’s value names the field — the value as it is now is shown first and kept; ↩ Undo writes it back">⇄ Replace</button>` : '') + `<button class="btn btn-secondary btn-sm fc-fix-btn fc-del-btn" ${attrs} data-swap="0" data-way="delete" title="Take the field’s name out of this record’s value — the value as it is now is shown first and kept; ↩ Undo writes it back">✂ Remove</button>`;
    // ✂ / ⇄ inside the component — the ways its kind has (user 2026-11-07: "remove, replace the field in the metadata
    // items without breaking them. While showing XML"). A duplicate rule too (user 2026-11-08: "למה אין החלפה פה…
    // צריך להיות בכולם"): the owner's own click, the diff confirmed, a restore point kept — nothing here ever switches
    // one off or edits one behind a deployment (the standing rule is about runs).
    const ways = (knownKind && typeof sftkMdEditWays === 'function') ? sftkMdEditWays(type) : null;
    // code: ⇄ renames the field's API name wherever the source writes it (whole word); ✎ Edit code lives in 🔍;
    // ✂ is not offered — which line of a program goes is the owner's to decide
    const codeWays = (knownKind && typeof sftkMdCodeWays === 'function') ? sftkMdCodeWays(type) : null;
    const codeEdits = codeWays && _replOn() ? `<button class="btn btn-primary btn-sm fc-fix-btn fc-edit-btn" ${attrs} data-swap="1" data-way="code" title="Rename ${esc(_selField.api)} to ${esc(_replField.api)} in every file of this ${esc(spec ? spec.what : 'component')} — whole word, the diff shown first; a restore point is kept">⇄ Replace</button>` : '';
    const edits = ways
      ? (_replOn() && ways.replace ? `<button class="btn btn-primary btn-sm fc-fix-btn fc-edit-btn" ${attrs} data-swap="1" data-way="edit" title="Point this at ${esc(_replField.api)} instead of the field — only the field’s own places in the XML change; a restore point is kept">⇄ Replace</button>` : '')
        + (ways.remove && _preWhy(id) ? `<button class="btn btn-secondary btn-sm fc-pre-no" disabled title="${esc(_preWhy(id))}">✂ Remove</button>` : '')
        + (ways.remove && !_preWhy(id) ? `<button class="btn btn-secondary btn-sm fc-fix-btn fc-edit-btn" ${attrs} data-swap="0" data-way="edit" title="Take the field out of this — only the field’s own places in the XML change (refused, with the reason, when what is left would not work); a restore point is kept">✂ Remove</button>` : '')
      : '';
    // the lead mapping's 🗑 only ever removed the field's line — ✂ Remove is that, said plainly
    const del = (spec && !spec.noDelete && !(ways && ways.remove && type === 'LeadConvertSettings')) ? `<button class="btn btn-danger btn-sm fc-fix-btn fc-del-btn" ${attrs} data-swap="0" data-way="delete" title="Delete this ${esc(spec.what)} from the org — its definition is kept as a restore point; ↩ Undo deploys it back" aria-label="Delete ${esc(spec.what)}">🗑 Delete<span class="fc-del-what"> ${esc(spec.what)}</span></button>` : '';
    if (!cfgT.fixable) return codeEdits + edits + del;
    const rm = `<button class="btn btn-secondary btn-sm fc-fix-btn" ${attrs} data-swap="0" title="Take the field’s reference out of this">✂ Remove</button>`;
    if (!_replOn()) return rm + del;
    return `<button class="btn btn-primary btn-sm fc-fix-btn" ${attrs} data-swap="1" title="Point this at ${esc(_replField.api)} instead of the field">⇄ Replace</button>${rm}${del}`;
  }
  // a group's own button: the same plan, for that group's rows (the walk through one dialog per item is gone —
  // owner 2026-11-17: "we can forget about the old wizard as we dont need it anymore")
  function _fixAllHtml(type, n, label) {
    const noun = type === 'Flow' ? `flow${n === 1 ? '' : 's'}` : esc(label);
    return `<button class="btn btn-secondary btn-sm fc-plan-btn" data-type="${esc(type)}" title="One screen with these ${n} and what will be done to each — change any row, confirm once">⚡ All ${n} ${noun} at once…</button>`;
  }
  // ⚡ All at once (planEverything, below): the one button on the list's header, and a note of the last run under it.
  let _everyRunning = false;
  let _everyNote = '';   // what the last ⚡ run did, said under the button
  // the items that have a way RIGHT NOW: a ✂ / ⇄ / keep / off button on their row (a 🗑 alone is not a fix)
  //   swap: undefined → any way; true → a ⇄ button; false → a ✂ / keep / off button
  function _openPairs(root, swap) {
    const sel = swap === true ? '.fc-fix-btn[data-swap="1"]' : swap === false ? '.fc-fix-btn[data-swap="0"]:not(.fc-del-btn)' : '.fc-fix-btn:not(.fc-del-btn)';
    return [...(root || document).querySelectorAll('.fc-fix-pair, .fc-del-pair')].filter(p => p.querySelector(sel)).length;
  }
  // on the section card's header (user 2026-11-08: "on top of the card … instead of the bar")
  function _fixEveryHtml(n) {
    if (n < 2 && !_everyNote) return '<span id="fcFixEvery" class="fc-every" hidden></span>';
    return `<span id="fcFixEvery" class="fc-every">${n >= 2 ? `<button class="btn btn-primary btn-sm fc-plan-btn" title="One screen with every item and what will be done to it — change any row, confirm once, and it all runs without asking again. Each change keeps its own restore point.">⚡ All ${n} at once…</button>` : ''}${_everyNote ? `<span class="fc-every-note">${esc(_everyNote)}</span>` : ''}</span>`;
  }
  try { chrome.storage.local.remove('sftk_fc_walk'); } catch (_) { /* what a paused walk of an older build left behind */ }
  // A section of the header that folds to one line, like the Deploy page's cards (user 2026-11-08: "we need a
  // collapsable ui there like we did for parents"). Open or folded is remembered per section; the one-line
  // summary is read off the rows inside as they fill in.
  function _foldOpen(key) { try { const v = localStorage.getItem(`sftk.fc.fold.${key}`); return v == null ? key !== 'further' : v === '1'; } catch (_) { return key !== 'further'; } }
  function _foldHtml(key, ico, title, hint, body) {
    return `<details class="fc-fold" data-fold="${esc(key)}"${_foldOpen(key) ? ' open' : ''}>
        <summary class="fc-fold-hd"><span class="fc-fold-ico">${ico}</span><span class="fc-fold-title">${esc(title)}</span><span class="fc-fold-hint">${esc(hint)}</span><span class="fc-fold-sum"></span></summary>
        <div class="fc-fold-body">${body}</div></details>`;
  }
  function _foldSummary(det) {
    const rows = [...det.querySelectorAll('.fc-fold-body .fc-fact, .fc-fold-body .fc-rpt, .fc-fold-body .fc-sweep, .fc-fold-body .fc-fls')];
    const bits = rows.map(r => {
      if (r.offsetParent === null && r.style.display === 'none') return '';
      // the row's words without its buttons ("Visible to 2 profiles" — not "…setsshow")
      const plain = r.cloneNode(true); plain.querySelectorAll('button, .btn').forEach(x => x.remove());
      const b = plain.querySelector('.fc-data-badge, b, strong');
      let t = (b ? b.textContent : plain.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || /^[\d,.]+$/.test(t)) t = (plain.textContent || '').replace(/\s+/g, ' ').trim();
      return t.length > 42 ? t.slice(0, 40) + '…' : t;
    }).filter(Boolean);
    return [...new Set(bits)].slice(0, 5).join(' · ');
  }
  function _wireFolds(root) {
    root.querySelectorAll('details.fc-fold').forEach(det => {
      const sum = det.querySelector('.fc-fold-sum');
      const paint = () => { if (sum) sum.textContent = det.open ? '' : _foldSummary(det); };
      det.addEventListener('toggle', () => { try { localStorage.setItem(`sftk.fc.fold.${det.dataset.fold}`, det.open ? '1' : '0'); } catch (_) { /* no storage */ } paint(); });
      let t = null;
      new MutationObserver(() => { clearTimeout(t); t = setTimeout(paint, 150); }).observe(det.querySelector('.fc-fold-body'), { childList: true, subtree: true, characterData: true });
      paint();
    });
  }
  function _refreshFixEvery() {
    const el = eid('fcFixEvery');
    if (el && !_everyRunning) el.outerHTML = _fixEveryHtml(_planRows().filter(r => r.opts.length).length);
  }
  // ── ⚡ All at once: one plan, one confirmation, one run ────────────────────────────────────────────────────────
  // The rows are read off the page — a row's ways are the buttons it shows right now, so the plan can never offer
  // what the row itself does not. Nothing here changes the org: each row runs through fixOne, the same engine and
  // the same restore point as its own button; the plan only answers that row's confirmation (fcPlanOwnsDialog).
  let _planRun = null;   // { stop, name } while a plan runs
  function _planRows() {
    const byId = new Map();
    document.querySelectorAll('#fcResults .fc-fix-pair, #fcResults .fc-del-pair').forEach(p => {
      const g = p.closest('.fc-group'), id = p.dataset.id;
      if (!g || !id || p.closest('.fc-item-fixed')) return;
      const type = p.dataset.type;
      let row = byId.get(id);
      if (!row) { row = { type, id, name: p.dataset.name || id, sev: g.dataset.sev === 'must' ? 'must' : 'later', kindLabel: (TYPE_CFG[type] || TYPE_CFG_DEFAULT).label || type, opts: [], why: _preWhy(id) }; byId.set(id, row); }
      p.querySelectorAll('.fc-fix-btn:not([disabled]):not(.fc-xml-fix)').forEach(b => {
        const kind = b.dataset.swap === '1' ? 'replace' : (b.classList.contains('btn-danger') || b.dataset.way === 'off') ? 'delete' : 'remove';
        if (row.opts.some(o => o.kind === kind)) return;
        row.opts.push({ kind, swap: b.dataset.swap === '1', way: b.dataset.way || '', label: (b.textContent || '').replace(/\s+/g, ' ').trim() });
      });
    });
    return [...byId.values()];
  }
  // A running flow: can a new version without the field stand? Read here, before the plan is shown, with the same
  // preview the flow's own ✂ uses — nothing is written. → the reason it cannot ('' = it can, or it could not be read)
  async function _planFlowNo(row) {
    try {
      const fp = await fixFlowPlan(row.id, row.name);
      if (!(fp.plan.mode === 'active' && fp.planDelete)) return '';
      const pv = fp.preview;
      if (!pv || !pv.removed.length) return 'nothing can be taken out of its active version automatically';
      if ((pv.emptied || []).length) return `taking the field out leaves ${pv.emptied.slice(0, 3).map(e => `${e.kind} “${e.label || e.name || '?'}”`).join(', ')} with nothing in it, and Salesforce refuses a version like that`;
      return '';
    } catch (_) { return ''; }
  }
  // would a replacement field give this row a ⇄? (code, and every kind with a replace way — never a Process Builder process)
  function _planCanSwap(type, id) {
    if (type === 'Flow') return !_flowCards.some(c => c.pb && c.primaryId === String(id));
    const w = typeof sftkMdEditWays === 'function' ? sftkMdEditWays(type) : null;
    const c = typeof sftkMdCodeWays === 'function' ? sftkMdCodeWays(type) : null;
    return !!((w && w.replace) || c || (TYPE_CFG[type] || TYPE_CFG_DEFAULT).fixable);
  }
  function _planBar(html) { const el = eid('fcFixEvery'); if (el) { el.hidden = false; el.innerHTML = html; } }
  const _PLAN_ICO = { replace: '⇄', remove: '✂', delete: '🗑', leave: '·' };
  const _PLAN_WORD = { replace: 'Replace', remove: 'Remove', delete: 'Delete', leave: 'Leave' };
  // THE PLAN SCREEN (owner 2026-11-17: "the new remove all is a lot better. we just need to improve how this screen
  // looks"): the numbers on top, one line per item, and the item's ways as buttons — the chosen one is lit, a way
  // the item does not have is not drawn. A line the tool left says why in a few words.
  function _planSeg(r, i) {
    const b = (kind, title) => `<button type="button" class="fc-plan-way${r.pick === kind ? ' on' : ''}" data-i="${i}" data-kind="${kind}" aria-pressed="${r.pick === kind}" title="${esc(title)}">${kind === 'leave' ? 'Leave' : `${_PLAN_ICO[kind]} ${_PLAN_WORD[kind]}`}</button>`;
    return `<span class="fc-plan-seg" role="group" aria-label="What to do with ${esc(r.name)}">${['replace', 'remove', 'delete'].map(k => { const o = r.opts.find(x => x.kind === k); return o ? b(k, o.label) : ''; }).join('')}${b('leave', 'Nothing is changed in this one — it stays for you')}</span>`;
  }
  function _planHtml(rows) {
    const line = (r, i) => `<div class="fc-plan-row" data-i="${i}" data-pick="${esc(r.pick)}">
        <span class="fc-plan-what"><span class="fc-plan-name" title="${esc(r.name)}">${esc(r.name)}</span><span class="fc-plan-kind">${esc(r.kindLabel)}${r.note ? ` · ${esc(r.note)}` : ''}</span></span>
        ${_planSeg(r, i)}
      </div>`;
    const sec = (sev, ico, title, sub) => {
      const list = rows.map((r, i) => [r, i]).filter(x => x[0].sev === sev);
      if (!list.length) return '';
      const canDel = sev === 'must' && list.some(x => x[0].opts.some(o => o.kind === 'delete'));
      return `<section class="fc-plan-sec" data-sev="${sev}">
        <header class="fc-plan-sec-hd"><span class="fc-plan-sec-t">${ico} ${title} <i>${list.length}</i></span><span class="fc-plan-sec-sub">${sub}</span>
          <span class="fc-plan-bulk">${canDel ? '<button type="button" class="fc-plan-link" data-bulk="delete" title="Every item of this list that is still left, and can be deleted, is set to Delete — flows, code and rules too. Look at the list before you run it.">Delete what is left</button>' : ''}<button type="button" class="fc-plan-link" data-bulk="leave" data-sev="${sev}">Leave all</button><button type="button" class="fc-plan-link" data-bulk="reset" data-sev="${sev}" title="Back to what the tool picked">Suggested</button></span>
        </header>${list.map(x => line(x[0], x[1])).join('')}</section>`;
    };
    return `<div class="fc-plan"><div class="fc-plan-sum" id="fcPlanSum"></div><div class="fc-plan-list">
      ${sec('must', '🔒', 'Block the delete', 'Salesforce refuses to delete the field while these name it')}
      ${sec('later', '👀', 'Only might break', 'the delete goes through; these lose the field afterwards')}
    </div></div>`;
  }
  function _planSumHtml(c) {
    const chip = (k, n, word) => n ? `<span class="fc-plan-chip" data-kind="${k}"><b>${n.toLocaleString('en-US')}</b> ${word}</span>` : '';
    return (chip('replace', c.replace, 'replaced') + chip('remove', c.remove, 'removed') + chip('delete', c.delete, 'deleted') + chip('leave', c.leave, 'left for you')) || '<span class="fc-plan-chip" data-kind="leave">nothing to do</span>';
  }
  // onlyType: a group's button — the same plan, for that group's rows
  async function planEverything(fieldId, onlyType) {
    if (_everyRunning || _fixSwap !== null || !_selObj || !_selField) return;
    _everyRunning = true;
    let rows = [];
    try {
      rows = _planRows().filter(r => !onlyType || r.type === onlyType);
      // running flows are read first, so the plan says what will really happen to each
      const flows = _replOn() ? [] : rows.filter(r => r.type === 'Flow' && r.opts.some(o => o.kind === 'remove' && o.way === 'keep'));
      for (let i = 0; i < flows.length; i++) {
        _planBar(`<span class="fc-plan-prog">⚡ Reading flow ${i + 1} of ${flows.length} — ${esc(flows[i].name)}</span>`);
        const no = await _planFlowNo(flows[i]);
        if (no) { flows[i].why = no; flows[i].opts = flows[i].opts.filter(o => o.kind !== 'remove'); }
      }
      rows = rows.filter(r => r.opts.length);
      for (const r of rows) {
        r.suggest = r.pick = fcPlanDefault(r.opts.map(o => o.kind), r.type, r.sev);
        // a line without ✂ says why, in a few words (the whole reason is on the item's own row)
        if (r.why) r.note = `can’t remove: ${String(r.why).split(' — ')[0].replace(/[.\s]+$/, '')}`;
        else if (r.pick === 'leave') r.note = r.sev === 'later' ? 'only Delete clears it, and it does not block' : `only Delete clears it${(!_replOn() && _planCanSwap(r.type, r.id)) ? ', or a replacement field' : ''} — your call`;
      }
    } finally { _everyRunning = false; _refreshFixEvery(); }
    if (!rows.length) return;
    const picks = () => rows.map(r => r.pick);
    const goText = () => { const c = fcPlanCounts(picks()); return c.run ? `⚡ Run ${c.run.toLocaleString('en-US')} change${c.run === 1 ? '' : 's'}` : 'Nothing is chosen'; };
    const gate = await sftkOrgWriteGate(_orgUrl);
    const sure = await sftkConfirmDestructive({
      title: `All at once — ${_selObj.api}.${_selField.api}`,
      icon: '⚡',
      items: [],
      revOverride: { html: `<strong>Runs without asking again.</strong> Every change keeps a restore point — ↩ Undo on each row afterwards, ↩ Undo all above the list. What cannot be done is left as it is and listed at the end.`, needsCheckbox: false, cls: 'sftk-rev-newver' },
      extraHtml: _planHtml(rows),
      confirmLabel: goText(),
      production: gate.production ? { label: gate.label } : null,
      onRender: () => {
        document.getElementById('modalBox')?.classList.add('fc-plan-host');
        const go = document.getElementById('sftkConfirmGo'), sum = document.getElementById('fcPlanSum');
        const sync = () => { const c = fcPlanCounts(picks()); if (sum) sum.innerHTML = _planSumHtml(c); if (go) { go.textContent = goText(); go.disabled = !c.run; } };
        const set = (i, kind) => {
          const r = rows[i]; if (!r || (kind !== 'leave' && !r.opts.some(o => o.kind === kind))) return;
          r.pick = kind;
          const el = document.querySelector(`.fc-plan-row[data-i="${i}"]`); if (!el) return;
          el.dataset.pick = kind;
          el.querySelectorAll('.fc-plan-way').forEach(b => { const on = b.dataset.kind === kind; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
        };
        document.querySelector('.fc-plan')?.addEventListener('click', ev => {
          const w = ev.target.closest?.('.fc-plan-way');
          if (w) { set(Number(w.dataset.i), w.dataset.kind); sync(); return; }
          const b = ev.target.closest?.('.fc-plan-link');
          if (!b) return;
          rows.forEach((r, i) => {
            if (b.dataset.bulk === 'delete') { if (r.sev === 'must' && r.pick === 'leave' && r.opts.some(o => o.kind === 'delete')) set(i, 'delete'); }
            else if (r.sev === b.dataset.sev) set(i, b.dataset.bulk === 'reset' ? r.suggest : 'leave');
          });
          sync();
        });
        sync();
      },
    });
    document.getElementById('modalBox')?.classList.remove('fc-plan-host');
    if (!sure) return;
    const todo = rows.filter(r => r.pick !== 'leave');
    if (!todo.length) return;
    await _planExecute(fieldId, todo, rows.length - todo.length);
  }
  // what a row says after its turn: done (with its own words), or why not
  function _planOutcome(row) {
    const item = eid(`fcItem_${row.id}`);
    if (!item) return { ok: false, text: 'the row is no longer on the page' };
    if (item.classList.contains('fc-item-fixed')) return { ok: true, text: (item.querySelector('.fc-item-ok')?.childNodes[0]?.textContent || 'Done').replace(/^✅s*/, '').trim() };
    const e = [...item.querySelectorAll('.fc-item-err')].pop() || item.querySelector('.fc-item-pre');
    if (!e) return { ok: false, text: 'nothing was changed' };
    const c = e.cloneNode(true); c.querySelectorAll('a, button').forEach(x => x.remove());
    return { ok: false, text: (c.textContent || '').replace(/^❌\s*/, '').replace(/\s+/g, ' ').trim() };
  }
  async function _planExecute(fieldId, todo, nLeft) {
    if (_everyRunning || _fixSwap !== null) return;
    const done = [], not = [];
    _everyRunning = true; _walkRunning = true; _everyNote = '';
    _planRun = { stop: false, name: '' };
    eid('fcResults')?.querySelectorAll('.fc-fix-allbox button').forEach(b => { b.disabled = true; });
    // the plan answers only the dialogs of the row it is on
    sftkConfirmPlanned(opts => (_planRun && fcPlanOwnsDialog(opts, _planRun.name)) ? true : undefined);
    // the Toolkit's own progress (the bar, the count, the cat) above the list, with the stop next to it
    // (owner 2026-11-17: "while it does its job, dont forget our awsome progress bar and kitty animation")
    let host = eid('fcPlanProg');
    const res0 = eid('fcResults');
    if (!host && res0 && res0.parentNode) { host = document.createElement('div'); host.id = 'fcPlanProg'; res0.parentNode.insertBefore(host, res0); }
    let prog = null;
    if (host) {
      host.className = 'fc-plan-run';
      host.innerHTML = '<div class="fc-plan-run-prog"></div><button class="btn btn-secondary btn-sm fc-plan-stop" title="The item in work is finished; the ones after it are left as they are">⏹ Stop after this one</button>';
      host.querySelector('.fc-plan-stop').addEventListener('click', ev => { if (_planRun) { _planRun.stop = true; ev.currentTarget.disabled = true; ev.currentTarget.textContent = 'Stopping after this one…'; } });
      if (typeof sftkProgress === 'function') prog = sftkProgress(host.querySelector('.fc-plan-run-prog'), { what: `Running ${todo.length} change${todo.length === 1 ? '' : 's'} for ${_fcSubject()}…`, key: 'fc-plan', orgUrl: _orgUrl, total: todo.length, unit: 'changes' });
      try { host.scrollIntoView({ block: 'center' }); } catch (_) { /* not laid out */ }
    }
    let at = 0;
    try {
      for (const row of todo) {
        if (_planRun.stop) break;
        at++;
        _planRun.name = row.name;
        _planBar(`<span class="fc-plan-prog">⚡ Running — ${at} of ${todo.length}</span>`);
        if (prog) prog.say(`${at} of ${todo.length} — ${_PLAN_ICO[row.pick]} ${row.name}`);
        const opt = row.opts.find(o => o.kind === row.pick);
        if (!opt) { not.push({ row, text: 'that way is no longer offered on the row' }); continue; }
        try { await fixOne(row.type, row.id, row.name, fieldId, opt.swap, opt.way); }
        catch (e) { appendInlineError(row.id, e && e.message ? e.message : String(e)); }
        const o = _planOutcome(row);
        (o.ok ? done : not).push({ row, text: o.text });
        if (prog) prog.count(at, todo.length);
      }
    } finally {
      sftkConfirmPlanned(null);
      try { if (prog) prog.done(); } catch (_) { /* gone */ }
      if (host) host.remove();
      const stoppedAt = _planRun.stop ? at : 0;
      _planRun = null; _everyRunning = false; _walkRunning = false;
      eid('fcResults')?.querySelectorAll('.fc-fix-allbox').forEach(b => {
        const open = _openPairs(b.closest('.fc-group'));
        if (open < 2) b.remove(); else { b.dataset.n = String(open); b.innerHTML = _fixAllHtml(b.dataset.type, open, b.dataset.label); }
      });
      const waiting = todo.length - done.length - not.length;
      _everyNote = `⚡ All at once: ${done.length} done${not.length ? `, ${not.length} not done — the reason is on each row` : ''}${waiting ? `, ${waiting} not reached (stopped)` : ''}${nLeft ? `, ${nLeft} left for you` : ''}.`;
      _refreshFixEvery();
      checkEnableDelete();
      try { renderUndoAll(); } catch (_) { /* the rows carry their own ↩ Undo */ }
      _planReport(done, not, waiting, nLeft, stoppedAt);
    }
  }
  function _planReport(done, not, waiting, nLeft, stoppedAt) {
    if (typeof showModal !== 'function') return;
    const li = (x, cls) => `<li class="${cls}"><b>${esc(x.row.name)}</b><small>${esc(x.row.kindLabel)}</small><span>${esc(x.text)}</span></li>`;
    showModal(`
      <div class="modal-header"><h3>⚡ All at once — ${not.length || waiting ? 'finished, with items left' : 'finished'}</h3></div>
      <div class="fc-plan-rep">
        <div class="fc-plan-rep-nums"><span class="fc-plan-ok">${done.length} done</span>${not.length ? `<span class="fc-plan-bad">${not.length} not done</span>` : ''}${waiting ? `<span>${waiting} not reached${stoppedAt ? ' — stopped' : ''}</span>` : ''}${nLeft ? `<span>${nLeft} left for you</span>` : ''}</div>
        ${not.length ? `<div class="fc-plan-rep-hd">Not done — nothing was changed in these. The reason is also on each row, with its ↗ Setup link:</div><ul class="fc-plan-rep-list">${not.map(x => li(x, 'fc-plan-li-bad')).join('')}</ul>` : ''}
        ${done.length ? `<details class="fc-plan-rep-done"${not.length ? '' : ' open'}><summary>Done · ${done.length}</summary><ul class="fc-plan-rep-list">${done.map(x => li(x, 'fc-plan-li-ok')).join('')}</ul></details>` : ''}
        <p class="fc-plan-rep-foot">Every change has ↩ Undo on its row. ↩ Undo all, above the list, takes all of them back in one go.</p>
      </div>
      <div class="modal-footer"><button class="btn btn-primary btn-sm" id="fcPlanRepClose">Close</button></div>`);
    document.getElementById('fcPlanRepClose')?.addEventListener('click', () => { try { closeModal(); } catch (_) { /* gone */ } });
  }
  // An item's buttons while its fix works (text on the one that was pressed),
  // and back to idle (text = null).
  function _rowBusy(componentId, text) {
    const pair = document.querySelector(`.fc-fix-pair[data-id="${componentId}"], .fc-del-pair[data-id="${componentId}"]`);
    if (!pair) return;
    if (text == null) { pair.innerHTML = _fixBtnsHtml(pair.dataset.type, componentId, pair.dataset.name); return; }
    pair.querySelectorAll('.fc-fix-btn').forEach(b => {
      b.disabled = true;
      if ((b.dataset.swap === '1') === (_fixSwap === true) && (!b.dataset.way || !_fixWay || b.dataset.way === _fixWay)) b.textContent = text;
    });
  }
  // In replace mode an item has two buttons, so the note says what each does.
  function _groupNote(type, cfg) { return (_replOn() && cfg.replNote) ? `⇄ Replace: ${cfg.replNote.replace('{new}', _replField.api)} ✂ Remove: ${cfg.note}` : cfg.note; }
  // The mode changed (a replacement was picked or cleared): every idle fix
  // button, bulk button and group note says what it will now do.
  function _applyReplMode() {
    const results = eid('fcResults');
    if (!results) return;
    results.querySelectorAll('.fc-fix-pair, .fc-del-pair').forEach(p => { if (!p.querySelector('.fc-fix-btn[disabled]')) p.innerHTML = _fixBtnsHtml(p.dataset.type, p.dataset.id, p.dataset.name); });
    results.querySelectorAll('.fc-fix-allbox').forEach(b => { b.innerHTML = _fixAllHtml(b.dataset.type, Number(b.dataset.n), b.dataset.label); });
    _refreshFixEvery();
    _refreshFixEvery();
    results.querySelectorAll('.fc-flow-vers').forEach(ul => { const c = _flowCards.find(x => x.primaryId === ul.dataset.id); if (c) ul.innerHTML = _flowVersHtml(c); });
    results.querySelectorAll('.fc-group-note-text').forEach(n => { const t = n.dataset.type; n.textContent = _groupNote(t, TYPE_CFG[t] || TYPE_CFG_DEFAULT); });
    const bar = eid('fcReplBar');
    if (bar) bar.outerHTML = _replBarHtml();
    if (eid('fcFlsPanel')) renderFlsPanel();
    renderCopyValues();
  }
  function _replBarHtml() {
    return _replOn()
      ? `<div id="fcReplBar" class="fc-fact fc-fact-repl"><span class="fc-fact-ico">⇄</span><span class="fc-fact-text"><b>Replace mode</b> — every item offers <b>⇄ Replace</b> (points it at <code>${esc(_selObj.api)}.${esc(_replField.api)}</code>) and <b>✂ Remove</b> (takes the reference out). You choose per item.</span></div>`
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
  // ── one scan reads everything (user 2026-11-08: "i dont think we need 3 tabs here. one tab is enough, but should be
  // filtered by must and optional"): the scope switch of 2026-11-05 is gone; the result list has a filter instead ──
  const _scope = 'both';
  function _paintScope() { /* the switch is gone; the callers stay harmless */ }
  // the list's filter: 'all' · 'must' (Salesforce refuses the delete) · 'later' (goes through, breaks afterwards)
  let _fcFilter = 'all';
  function _paintFilter() {
    const root = eid('fcResults'); if (!root) return;
    root.querySelectorAll('.fc-filter-btn').forEach(b => { const on = b.dataset.filter === _fcFilter; b.classList.toggle('active', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); });
    root.querySelectorAll('.fc-group[data-sev]').forEach(g => { g.hidden = _fcFilter !== 'all' && g.dataset.sev !== _fcFilter; });
    const sub = eid('fcFilterSub');
    if (sub) sub.textContent = _fcFilter === 'must' ? 'Salesforce refuses the delete while any of these still references the field.'
      : _fcFilter === 'later' ? 'Salesforce lets the delete through with these — then each stops working or loses the field quietly. Fix them here first.'
      : '🔒 must fix — Salesforce refuses the delete while these reference the field · 👀 might break — the delete goes through, these lose the field afterwards.';
  }

  let _fcBudgetSeq = 0;
  function updateScanCostLine() {
    const el = eid('fcApiCost');
    if (!el) return;
    // Pre-scan, the fan-out legs of this scope are undiscovered — say so.
    const est = fcEstimateScanCalls(null, _scope, _selObj?.api);
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

  // ── Scan progress (user 2026-11-08: "can we show a progress bar with estimation?") ──
  // The scan is a fixed order of legs, each gated by the scope: one segment per leg, filled when it is done, the
  // current one pulsing; under it the step, the leg, the time left — from the legs already done and a weight per leg
  // (its usual number of calls) — and the places found so far.
  let _scanProg = null;
  function _scanLegsOf(L) {
    const all = [
      ['index', 'the dependency index', 3], ['flexiPages', 'Lightning pages', 10], ['reportTypes', 'report types', 2], ['listViews', 'list views', 3],
      ['compactLayouts', 'compact layouts', 2], ['quickActions', 'quick actions', 3], ['matchingRules', 'matching rules', 1], ['workflowFieldUpdates', 'workflow field updates', 1],
      ['workflow', 'workflow rules', 2], ['approvals', 'approval processes', 2], ['sharingRules', 'sharing rules', 1], ['duplicateRules', 'duplicate rules', 1],
      ['lwc', 'Lightning web components', 2], ['customMetadata', 'custom metadata records', 2], ['leadMapping', 'lead field mappings', 1], ['objectRules', 'assignment, auto-response and escalation rules', 1],
      ['paths', 'Paths', 1], ['validationRulesOff', 'inactive validation rules', 1], ['emailTemplates', 'email templates', 2], ['searchLayouts', 'search layouts', 1],
      ['entitlements', 'entitlement processes', 1], ['customSettings', 'custom settings', 2],
    ];
    return all.filter(([k]) => k === 'index' || L[k]).map(([key, label, weight]) => ({ key, label, weight }));
  }
  function _scanProgHtml(L) {
    _scanProg = { legs: _scanLegsOf(L), idx: 0, startedAt: Date.now(), legAt: Date.now(), doneMs: 0, doneW: 0, found: 0 };
    return `<div class="fc-scan-prog" id="fcScanProg"><div class="fc-scan-steps">${_scanProg.legs.map((l, i) => `<span class="fc-scan-step${i === 0 ? ' now' : ''}" data-i="${i}" title="${esc(l.label)}"></span>`).join('')}</div><div class="fc-scan-line" id="fcScanLine"></div></div>`;
  }
  // the leg named by a scan message ("Scanning list views… 5/12") — the legs before it are done
  function _scanProgLeg(text) {
    const p = _scanProg; if (!p) return;
    const t = String(text || '').toLowerCase();
    const i = p.legs.findIndex(l => t.includes(l.label.toLowerCase()));
    if (i < 0 || i === p.idx) return;
    const now = Date.now();
    for (let k = p.idx; k < i; k++) p.doneW += p.legs[k].weight;
    p.doneMs += now - p.legAt; p.legAt = now; p.idx = i;
    _scanProgPaint();
  }
  function _scanProgPaint() {
    const p = _scanProg, box = eid('fcScanProg'); if (!p || !box) return;
    box.querySelectorAll('.fc-scan-step').forEach((el, i) => { el.classList.toggle('done', i < p.idx); el.classList.toggle('now', i === p.idx); });
    const leg = p.legs[p.idx];
    const left = p.legs.slice(p.idx).reduce((n, l) => n + l.weight, 0);
    // the time left: the legs done so far say how long a unit of weight takes; nothing is said before two legs are done
    const eta = p.doneW >= 3 && p.doneMs > 0 ? Math.max(1, Math.round((p.doneMs / p.doneW) * left / 1000 - (Date.now() - p.legAt) / 1000)) : null;
    const line = eid('fcScanLine');
    if (line) line.textContent = `Step ${p.idx + 1} of ${p.legs.length} · ${leg ? leg.label : ''}${eta != null ? ` · about ${eta < 60 ? `${eta} s` : `${Math.round(eta / 60)} min`} left` : ' · estimating…'}${p.found ? ` · ${p.found.toLocaleString('en-US')} place${p.found === 1 ? '' : 's'} so far` : ''}`;
  }
  // one message setter for every leg: the text under the cat, and the progress with it
  function _scanMsg(t) {
    const el = eid('fcResults')?.querySelector('.lp-robot-msg'); if (el) el.textContent = t;
    _scanProgLeg(t);
  }
  function _scanProgFound(n) { if (_scanProg) { _scanProg.found = n; _scanProgPaint(); } }
  // ── Scan ───────────────────────────────────────────────────
  async function runScan() {
    if (!_selObj || !_selField) return;

    const btn = eid('fcScanBtn');
    if (btn) { btn.disabled = true; btn.textContent = '🔍 Scanning…'; }

    eid('fcResults').innerHTML = sftkCat('Scanning dependencies…') + _scanProgHtml(fcScopeLegs(_scope, _selObj.api));
    // the seconds tick while a leg runs; the timer ends with the progress box
    const progTimer = setInterval(() => { if (!eid('fcScanProg')) { clearInterval(progTimer); _scanProg = null; return; } _scanProgPaint(); }, 1000);

    const gen = _orgGen;   // 2026-11-14: a scan still running when the org switches must not land in the new org's page
    // 2026-11-15 (review of f0334a0): that was checked once, before the results. init() nulls the selection on a
    // switch, so a scan in its first reads then threw on _selObj.api / _selField.api and the catch painted
    // "Unexpected error: Cannot read properties of null" into the NEW org's page; the not-found and
    // could-not-scan answers landed there too. Every answer is now checked before anything is painted, the catch
    // included, and the field lookup works on the selection it was started with.
    try {
      // ── 1. Resolve CustomField tooling ID ─────────────────
      const fieldId = await resolveCustomFieldId(_selObj, _selField);
      if (gen !== _orgGen) return;
      if (!fieldId) {
        // A field THIS Toolkit deleted is a known case, not a mystery (user
        // 2026-10-02: the re-scan after a delete said "Could not locate").
        let deleted = null;
        try {
          const d = await chrome.storage.local.get('sftk_fc_deletion_log');
          deleted = (Array.isArray(d.sftk_fc_deletion_log) ? d.sftk_fc_deletion_log : [])
            .find(e => e && e.object === _selObj?.api && e.field === _selField?.api && (!e.orgUrl || !_orgUrl || sftkOrgKey(e.orgUrl) === sftkOrgKey(_orgUrl)));
        } catch (_) { deleted = null; }
        if (gen !== _orgGen) return;
        if (deleted) {
          const until = new Date(Date.parse(deleted.at) + 15 * 24 * 3600 * 1000).toISOString().slice(0, 10);
          showScanError(
            `This field was deleted with the Toolkit on ${new Date(deleted.at).toLocaleString()}. Salesforce keeps it in Deleted Fields until about ${until}: ` +
            `Setup → Object Manager → ${_selObj?.api} → Fields & Relationships → Deleted Fields → Undelete (it comes back as ${String(_selField?.api || '').replace(/__c$/, '')}_del__c — rename it), then pick it here again.`
          );
          return;
        }
        if (_resolveErr) {
          const fe = sftkFriendlyError(_resolveErr);
          showScanError(`Salesforce did not answer the field lookup, so nothing was scanned — ${fe.message}${fe.hint ? ' — ' + fe.hint : ''}. Reload the org's tab and press Re-scan.`);
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

      if (gen !== _orgGen) return;
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
      // (incl. Dynamic Forms field sections) are never missed. Live 2026-11-06:
      // a page that holds the field (a field component or a visibility rule)
      // makes Salesforce REFUSE the delete, so this leg runs in every scope.
      _scanProgFound(deps.length);
      _scanMsg('Scanning Lightning pages…');
      const scope = _scope, L = fcScopeLegs(scope, _selObj.api);
      const scanUnread = [];   // [{ leg, why }] — what this scan could not read
      if (depRes.incomplete) scanUnread.push({ leg: 'Salesforce’s dependency index', why: `the read came back incomplete (${depRes.incomplete.got} of ${depRes.incomplete.expected})` });
      let flexiHits = [];
      try {
        if (L.flexiPages) { flexiHits = await scanFlexiPages(deps); if (flexiHits.unread) scanUnread.push(...flexiHits.unread); }
      } catch (e) {
        scanUnread.push({ leg: 'Lightning pages', why: String((e && e.message) || e).slice(0, 160) });
        if (window.SFToolkitDebug?.enabled) {
          window.SFToolkitDebug.log('fields', 'error',
            'Supplemental FlexiPage scan failed', e.message);
        }
      }

      // ── 3b. Supplemental report-type scan ─────────────────
      // Live 2026-11-04: the dependency index lists a field's layouts and
      // flows, not the custom report types whose columns carry it. A report
      // type has no Tooling read, so every custom one is read through SOAP
      // readMetadata (1 list + 1 call per 10 types) and searched for the
      // column.
      let rtHits = [];
      try {
        if (L.reportTypes) rtHits = await scanReportTypes([...deps, ...flexiHits]);
      } catch (e) {
        scanUnread.push({ leg: 'custom report types', why: String((e && e.message) || e).slice(0, 160) });
        if (window.SFToolkitDebug?.enabled) {
          window.SFToolkitDebug.log('fields', 'error',
            'Supplemental report-type scan failed', e.message);
        }
      }

      // ── 4. Supplemental scan ──────────────────────────────
      // What the dependency index does not track: the other mentions (list
      // views, compact layouts, quick actions, Paths) and the blockers outside
      // the index (matching and duplicate rules, workflow rules, field updates,
      // alerts and outbound messages, approval processes, sharing rules, LWC
      // schema imports, custom metadata records, lead mappings, Lead/Case
      // rules — each one live-tested 2026-11-06).
      let supHits = [];
      try {
        supHits = await scanSupplemental([...deps, ...flexiHits, ...rtHits], fieldId, L);
        if (supHits.unread) scanUnread.push(...supHits.unread);
      } catch (e) {
        scanUnread.push({ leg: 'the kinds outside Salesforce’s index', why: String((e && e.message) || e).slice(0, 160) });
        if (window.SFToolkitDebug?.enabled) {
          window.SFToolkitDebug.log('fields', 'error',
            'Supplemental dependency scan failed', e.message);
        }
      }

      if (gen !== _orgGen) return;
      _rptScan = null; _orgSweep = null; _rtScanned = null; _everyNote = '';
      _lastScan = { deps: [...deps, ...flexiHits, ...rtHits, ...supHits], fieldId, scope, unread: scanUnread };
      await renderResults(_lastScan.deps, fieldId);
    } catch (e) {
      if (gen !== _orgGen) return;   // the old org's scan failing on the switch says nothing about the new org
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
    if (listRes && listRes.error && !fcAbsentFeatureError(listRes.error)) throw new Error(listRes.error);
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
    // 2026-11-14 (release QA): a page whose read failed used to be dropped as if it held nothing, and an incomplete
    // page list went unnoticed — the gate then said 'The scan lists no blocker' and unlocked Delete Field. A Lightning
    // page that holds the field makes Salesforce refuse the delete, so what could not be read is SAID (hits.unread,
    // which the caller already reads) and keeps Delete locked until a re-scan reads it.
    const failed  = [];
    if (listRes.incomplete) failed.push(`the page list came back incomplete (${listRes.incomplete.got} of ${listRes.incomplete.expected})`);
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
        const page = slice[j];
        if (alreadyFound.has(String(page.Id || '').substring(0, 15))) return;
        if (r.status !== 'fulfilled' || r.value?.error || !r.value?.Metadata) {
          const why = r.status !== 'fulfilled' ? String((r.reason && r.reason.message) || r.reason || 'no answer') : (r.value?.error || 'no metadata came back');
          failed.push(`${page.MasterLabel || page.DeveloperName || page.Id}: ${String(why).slice(0, 120)}`);
          return;
        }
        // owner 2026-11-17, on a page whose only mention was its description: "So why it showed when i rescaned" — a
        // page that names the field only in free text (its description, its label, a component's title or rich
        // text) uses it nowhere: nothing to remove, nothing Salesforce refuses over. It is not listed.
        if (flexiPageReferencesField(r.value.Metadata, _selObj.api, _selField.api) && _flexiNamesBeyondText(r.value.Metadata, _selObj.api, _selField.api)) {
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
    if (failed.length) hits.unread = [{ leg: `Lightning pages (${failed.length} could not be read)`, why: failed.slice(0, 3).join('; ') + (failed.length > 3 ? `; and ${failed.length - 3} more` : '') }];
    return hits;
  }

  // ── Supplemental scans ─────────────────────────────────────────────────
  // MetadataComponentDependency doesn't track these AT ALL. Some break
  // quietly when the field goes (list views, compact layouts, quick actions,
  // Paths); the rest make Salesforce REFUSE the delete (matching and
  // duplicate rules, workflow rules, field updates, alerts and outbound
  // messages, approval processes, criteria sharing rules, LWC schema imports,
  // custom metadata records, lead mappings, Lead/Case rules) — every one of
  // them live-tested 2026-11-06 against a destructive delete. Reports and
  // report types ARE in the dependency index (they are TYPE_CFG entries).
  function _fieldTokenRe() {
    const fl = (_selField?.api || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-zA-Z0-9_])${fl}([^a-zA-Z0-9_]|$)`, 'i');
  }

  // ── Supplemental report-type scan ──────────────────────────
  // Synthetic dependency records for every custom report type with a column
  // of the selected field (sftk-mdapi.js reads the SOAP answer). The row's
  // id is the type's developer name — that is how the fix reads it back.
  async function scanReportTypes(existingDeps) {
    const hits = [];
    const msg = _scanMsg;
    msg('Scanning report types…');
    const listed = await bg({ type: 'SF_MD_LIST', orgUrl: _orgUrl, sid: _sid, mdType: 'ReportType', _suppressError: true });
    if (!listed || listed.error) throw new Error(listed?.error || 'the report types could not be listed');
    const types = sftkMdExtractListed(listed.text);
    _rtScanned = types.length;
    const known = new Set((existingDeps || [])
      .filter(d => d.MetadataComponentType === 'ReportType')
      .map(d => String(d.MetadataComponentName || '').toLowerCase()));
    const per = sftkMdReadMax();
    for (let i = 0; i < types.length; i += per) {
      const slice = types.slice(i, i + per);
      const read = await bg({ type: 'SF_MD_READ', orgUrl: _orgUrl, sid: _sid, mdType: 'ReportType',
        fullNames: slice.map(t => t.fullName), _suppressError: true });
      if (!read || read.error) throw new Error(read?.error || 'the report types could not be read');
      for (const rec of sftkMdExtractRecords(read.text).records) {
        const n = sftkRtMentions(rec.innerXml, sftkMdFamObj(_selObj.api, _selField.api), _selField.api);   // Task / Event custom field = Activity's (2026-11-15)
        if (!n) continue;
        const label = sftkMdChildText(rec.innerXml, 'label') || rec.fullName;
        if (known.has(label.toLowerCase()) || known.has(rec.fullName.toLowerCase())) continue;
        const t = slice.find(x => x.fullName === rec.fullName) || {};
        hits.push({
          MetadataComponentId: rec.fullName, MetadataComponentName: label,
          MetadataComponentType: 'ReportType',
          RefMetadataComponentId: null, RefMetadataComponentName: _selField.api,
          _supplemental: true, _fullName: rec.fullName, _columns: n,
          _managed: t.namespacePrefix || '',
        });
      }
      msg(`Scanning report types… ${Math.min(i + per, types.length)}/${types.length}`);
    }
    return hits;
  }

  async function scanSupplemental(existingDeps, fieldId, legs) {
    const L = legs || fcScopeLegs('both');
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
      if (_scanProg) _scanProgFound(_scanProg.found + 1);
    };
    const msg = _scanMsg;
    const re      = _fieldTokenRe();
    const obj     = _selObj.api;
    const fieldLc = _selField.api.toLowerCase();
    const fid15   = String(fieldId || '').substring(0, 15).toLowerCase();   // the field's Id, where a leg returns Ids instead of names
    // Shared by the legs below — Tooling where it exists; readMetadata (SOAP, last resort) for the types that have no Tooling read.
    const objLc = obj.toLowerCase();
    const sameField = v => { const f = String(v || '').toLowerCase(); return f === fieldLc || f === `${objLc}.${fieldLc}`; };
    // A LEG THAT FAILS IS SAID (QA 2026-11-11, the class of "Could not locate this field"): every leg used to swallow
    // its failure, so a refused or timed-out read left its kind out of the list and the gate said "the scan lists no
    // blocker". Now a failed leg lands in `unread` — shown in the gate, and Delete stays locked until Salesforce's own
    // check-only delete accepts. An error that only says the org has no such object or feature is an empty answer.
    const unread = [];
    const miss = (leg, e) => { if (fcAbsentFeatureError((e && e.message) || e)) return; const why = String((e && e.message) || e || 'no answer').replace(/\s+/g, ' ').slice(0, 160); if (!unread.some(u => u.leg === leg)) unread.push({ leg, why }); };
    const sfQ = async (query, tooling) => {
      const r = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: !!tooling, _suppressError: true, query });
      if (r && r.error && fcAbsentFeatureError(r.error)) return { records: [] };
      if (!r || r.error) throw new Error((r && r.error) || 'no answer');
      if (r.incomplete) throw new Error(`the read came back incomplete (${r.incomplete.got} of ${r.incomplete.expected})`);
      return r;
    };
    const mdList = async mdType => {
      const r = await bg({ type: 'SF_MD_LIST', orgUrl: _orgUrl, sid: _sid, mdType, _suppressError: true });
      if (!r || r.error) throw new Error(r?.error || `${mdType} could not be listed`);
      return sftkMdExtractListed(r.text);
    };
    const mdRead = async (mdType, fullNames, onProgress) => {
      const out = [], per = sftkMdReadMax();
      for (let i = 0; i < fullNames.length; i += per) {
        const r = await bg({ type: 'SF_MD_READ', orgUrl: _orgUrl, sid: _sid, mdType, fullNames: fullNames.slice(i, i + per), _suppressError: true });
        if (!r || r.error) throw new Error(r?.error || `${mdType} could not be read`);
        out.push(...sftkMdExtractRecords(r.text).records);
        if (onProgress) onProgress(Math.min(i + per, fullNames.length), fullNames.length);
      }
      return out;
    };
    const mentions = xml => sftkMdMentionsField(xml, obj, _selField.api);
    const offTag = xml => (sftkMdChildText(xml, 'active') || '') === 'false' ? ' (inactive)' : '';
    // One Tooling read per record (Metadata comes back only one record at a time).
    const eachMetadata = async (sobject, rows, test, type, nameOf, what) => {
      const BATCH = 5;
      for (let i = 0; i < rows.length; i += BATCH) {
        const slice = rows.slice(i, i + BATCH);
        const rs = await Promise.allSettled(slice.map(r => bg({ type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid, sobject, id: r.Id, _suppressError: true })));
        rs.forEach((r, j) => {
          if (r.status !== 'fulfilled' || !r.value || r.value.error) { miss(`${what} (some could not be opened)`, r.status === 'fulfilled' ? (r.value && r.value.error) : r.reason); return; }
          const m = r.value.Metadata || {};
          if (test(m)) add(type, slice[j].Id, nameOf(slice[j], m));
        });
        msg(`Scanning ${what}… ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
      }
    };

    // 1. List views — describe gives the view's SOQL + columns.
    if (L.listViews) try {
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
    } catch (e) { miss('list views', e); }

    // 2. Compact layouts. describe/compactLayouts lists only the ASSIGNED ones
    // (live 2026-11-06, npc: a compact layout with the field that no record
    // type used was not returned, so the scan missed it). Tooling lists every
    // compact layout of the object; readMetadata gives each one's fields.
    if (L.compactLayouts) try {
      msg('Scanning compact layouts…');
      const clRes = await sfQ(`SELECT DeveloperName FROM CompactLayout WHERE SobjectType = '${obj}'`, true);
      const names = (clRes?.records || []).map(r => r.DeveloperName).filter(Boolean);
      if (names.length) for (const rec of await mdRead('CompactLayout', names.map(n => `${obj}.${n}`), (d, t) => msg(`Scanning compact layouts… ${d}/${t}`))) {
        if (mentions(rec.innerXml)) add('CompactLayout', rec.fullName, sftkMdChildText(rec.innerXml, 'label') || rec.fullName);
      }
    } catch (e) { miss('compact layouts', e); }

    // 3. Quick actions — each action's mini-layout can place the field.
    // The /quickActions list returns EVERY action available on the object,
    // including standard global ones (LogACall, NewContact, FeedItem.*,
    // SendEmail…) whose per-action describe 404s at the object scope — that
    // was flooding the log with red 404s. Only Create/Update actions own a
    // field layout, and only object-scoped custom ones can hold THIS object's
    // custom field, so filter to those; suppress errors on the rest.
    if (L.quickActions) try {
      msg('Scanning quick actions…');
      const qaRes = await bg({ type: 'SF_REST_GET', orgUrl: _orgUrl, sid: _sid,
        path: `services/data/v62.0/sobjects/${obj}/quickActions` });
      // An object-scoped custom action is listed as "Account.My_Action" (live
      // 2026-11-06: the old "skip every name with a dot" rule skipped exactly the
      // actions that can hold this object's field); its describe takes the bare name.
      const bare = n => String(n || '').replace(new RegExp(`^${obj}\\.`, 'i'), '');
      const qas = (Array.isArray(qaRes) ? qaRes : []).filter(qa => {
        const t = (qa.type || '').toLowerCase();
        // Skip global/chatter actions (FeedItem.*, another object's) and non-layout types.
        if (bare(qa.name).includes('.')) return false;
        return t === 'create' || t === 'update';
      });
      const BATCH = 5;
      const qaHits = [];
      for (let i = 0; i < qas.length; i += BATCH) {
        const slice = qas.slice(i, i + BATCH);
        const rs = await Promise.allSettled(slice.map(qa => bg({
          // _silentError: standard actions (NewCase, NewContact…) pass the
          // type filter but 404 on object-scoped describe — expected, carries
          // no information, logged as nothing instead of 22 Retry rows.
          type: 'SF_REST_GET', orgUrl: _orgUrl, sid: _sid, _silentError: true,
          path: `services/data/v62.0/sobjects/${obj}/quickActions/${encodeURIComponent(bare(qa.name))}/describe`
        })));
        rs.forEach((r, j) => {
          if (r.status !== 'fulfilled' || r.value?.error) return;
          const d = r.value, qa = slice[j];
          // The action layout + default values serialize the field api name —
          // a token-boundary search over the JSON catches every placement.
          let blob = '';
          try { blob = JSON.stringify({ l: d.layout, dv: d.defaultValues }); } catch (_) {}
          if (blob && re.test(blob)) qaHits.push(qa);
        });
      }
      // The REST list and describe above are CACHED by Salesforce: an action deleted a minute ago is still served
      // (user 2026-11-10, screenshot: "appeared on rescan although it was removed" — then "was not found in the
      // org"). The hits are checked against the Tooling list, which is live; an unanswered check keeps them.
      if (qaHits.length) {
        const live = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true, _suppressError: true,
          query: `SELECT DeveloperName FROM QuickActionDefinition WHERE SobjectType = '${obj}'` });
        const have = live && !live.error ? new Set((live.records || []).map(r => String(r.DeveloperName || '').toLowerCase())) : null;
        for (const qa of qaHits) if (!have || have.has(bare(qa.name).toLowerCase())) add('QuickAction', qa.name, qa.label || qa.name);
      }
    } catch (e) { miss('quick actions', e); }

    // 4. Matching rules — MatchingRule/MatchingRuleItem are STANDARD data
    // objects, not Tooling (the Tooling query 400'd "sObject type
    // 'MatchingRule' is not supported"). One join query gets every rule
    // item's Field for this object; Field comes back like "Contact.Email".
    if (L.matchingRules) try {
      msg('Scanning matching rules…');
      // 2026-11-14 (release QA): read through sfQ, which THROWS on an error or an incomplete answer so miss() says the
      // leg — a bare bg() here turned a failed read into 'no matching rule' and unlocked Delete Field.
      const mriRes = await sfQ(`SELECT Id, Field, MatchingRuleId, MatchingRule.DeveloperName, MatchingRule.MasterLabel ` +
               `FROM MatchingRuleItem WHERE MatchingRule.SobjectType = '${obj}'`, false);
      {
        for (const it of (mriRes?.records || [])) {
          // a CUSTOM field comes back as the field's Id, not its name (live 2026-11-07: "00NdL00002h5fC1UAI" for an inactive rule on the field)
          const f = String(it.Field || '').toLowerCase();
          if (f === fieldLc || f.endsWith('.' + fieldLc) || (fid15 && f.startsWith(fid15))) {
            add('MatchingRule', it.MatchingRuleId,
                it.MatchingRule?.MasterLabel || it.MatchingRule?.DeveloperName || it.MatchingRuleId);
          }
        }
      }
    } catch (e) { miss('matching rules', e); }

    // 5. Workflow field updates — FieldDefinitionId carries the field's id.
    if (L.workflowFieldUpdates) try {
      msg('Scanning workflow field updates…');
      const id15 = String(fieldId || '').substring(0, 15);
      // 2026-11-14 (release QA): through sfQ for the same reason as the matching rules above.
      const wfRes = await sfQ(`SELECT Id, Name, FieldDefinitionId FROM WorkflowFieldUpdate WHERE SourceTableEnumOrId = '${obj}'`, true);
      for (const fu of (wfRes?.records || [])) {
        const fd = String(fu.FieldDefinitionId || '');
        if (id15 && fd.includes(id15)) add('WorkflowFieldUpdate', fu.Id, fu.Name);
        else if (fd.toLowerCase().endsWith('.' + fieldLc)) add('WorkflowFieldUpdate', fu.Id, fu.Name);
      }
    } catch (e) { miss('workflow field updates', e); }

    // ── The legs below were added 2026-11-06, each after a live test in npc:
    // one fixture per reference type, then a destructive delete of the field.
    // Salesforce refused every one of these; the dependency index returned
    // none of them. Tooling where it exists; readMetadata (SOAP, last resort)
    // for the types that have no Tooling read.

    // 6. Workflow rules (criteria or formula — an INACTIVE rule blocks too),
    // email alerts whose recipient is this field, outbound messages that send it.
    if (L.workflow) try {
      msg('Scanning workflow rules…');
      const rules = (await sfQ(`SELECT Id, Name FROM WorkflowRule WHERE TableEnumOrId = '${obj}'`, true))?.records || [];
      await eachMetadata('WorkflowRule', rules,
        m => (m.criteriaItems || []).some(c => sameField(c.field)) || (typeof m.formula === 'string' && re.test(m.formula)),
        'WorkflowRule', (r, m) => r.Name + (m.active === false ? ' (inactive)' : ''), 'workflow rules');
      // EntityDefinitionId is the API name for a standard object but the object's 01I… id for a custom one — a filter
      // by name found NO alert and NO outbound message on any custom or packaged object (found 2026-11-11 building the
      // packaged-object demo: "SFTK Pkg OM" was in the org and not in the list). The relationship's name works for both.
      const alerts = (await sfQ(`SELECT Id, DeveloperName FROM WorkflowAlert WHERE EntityDefinition.QualifiedApiName = '${obj}'`, true))?.records || [];
      await eachMetadata('WorkflowAlert', alerts,
        m => (m.recipients || []).some(rc => sameField(rc.field)),
        'WorkflowAlert', r => r.DeveloperName, 'email alerts');
      const oms = (await sfQ(`SELECT Id, Name FROM WorkflowOutboundMessage WHERE EntityDefinition.QualifiedApiName = '${obj}'`, true))?.records || [];
      await eachMetadata('WorkflowOutboundMessage', oms,
        m => (m.fields || []).some(sameField),
        'WorkflowOutboundMessage', r => r.Name, 'outbound messages');
    } catch (e) { miss('workflow rules', e); }

    // 7. Approval processes on this object (entry and step criteria; active
    // or not). No Tooling read exists: listMetadata, then readMetadata.
    if (L.approvals) try {
      msg('Scanning approval processes…');
      const names = (await mdList('ApprovalProcess')).map(t => t.fullName).filter(n => n.toLowerCase().startsWith(objLc + '.'));
      for (const rec of await mdRead('ApprovalProcess', names, (a, b) => msg(`Scanning approval processes… ${a}/${b}`))) {
        if (!mentions(rec.innerXml)) continue;
        // the process's own label, not its first step's (live: "Step 1")
        const top = rec.innerXml.replace(/<approvalStep>[\s\S]*?<\/approvalStep>/g, '');
        add('ApprovalProcess', rec.fullName, (sftkMdChildText(top, 'label') || rec.fullName.replace(/^[^.]+\./, '')) + offTag(top));
      }
    } catch (e) { miss('approval processes', e); }

    // 8. Criteria-based sharing rules (and guest-user rules): one read of the
    // object's SharingRules container.
    if (L.sharingRules) try {
      msg('Scanning sharing rules…');
      for (const rec of await mdRead('SharingRules', [obj])) {
        for (const tag of ['sharingCriteriaRules', 'sharingGuestRules']) {
          for (const rule of sftkMdChildren(rec.innerXml, tag)) {
            if (mentions(rule.innerXml)) add('SharingCriteriaRule', `${obj}.${rule.fullName}`, sftkMdChildText(rule.innerXml, 'label') || rule.fullName);
          }
        }
      }
    } catch (e) { miss('sharing rules', e); }

    // 9. Duplicate rules whose record filter names the field (active or not).
    // The list is plain SOQL; the filter lives in the rule's metadata.
    if (L.duplicateRules) try {
      msg('Scanning duplicate rules…');
      const rows = (await sfQ(`SELECT Id, DeveloperName, MasterLabel, IsActive FROM DuplicateRule WHERE SobjectType = '${obj}'`, false))?.records || [];
      const byName = new Map(rows.map(r => [`${objLc}.${String(r.DeveloperName || '').toLowerCase()}`, r]));
      for (const rec of await mdRead('DuplicateRule', rows.map(r => `${obj}.${r.DeveloperName}`))) {
        const filter = sftkMdFindElement(rec.innerXml, 'duplicateRuleFilter', 0);
        if (!filter) continue;
        const items = sftkMdChildren(rec.innerXml.slice(filter.bodyStart, filter.bodyEnd), 'duplicateRuleFilterItems');
        const hit = items.some(it => {
          const t = (sftkMdChildText(it.innerXml, 'table') || '').toLowerCase();
          return sameField(sftkMdChildText(it.innerXml, 'field')) && (!t || t === objLc);
        });
        if (!hit) continue;
        const r = byName.get(rec.fullName.toLowerCase());
        add('DuplicateRule', r?.Id || rec.fullName, (r?.MasterLabel || sftkMdChildText(rec.innerXml, 'masterLabel') || rec.fullName) + (r && r.IsActive === false ? ' (inactive)' : ''));
      }
    } catch (e) { miss('duplicate rules', e); }

    // 10. Lightning web components: a schema import of the field is compiled
    // into the component, so Salesforce refuses the delete. (A field named
    // only in the HTML does not block — live-tested.) One Tooling query reads
    // every JS source in the org.
    if (L.lwc) try {
      msg('Scanning Lightning web components…');
      const res = await sfQ("SELECT Id, FilePath, Source, LightningComponentBundleId, LightningComponentBundle.DeveloperName, LightningComponentBundle.MasterLabel FROM LightningComponentResource WHERE Format = 'js'", true);
      const want = new RegExp(`@salesforce/schema/${objLc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.${fieldLc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9_])`, 'i');
      const seenBundle = new Set();
      for (const r of (res?.records || [])) {
        if (!/\.js$/i.test(String(r.FilePath || ''))) continue;
        if (!want.test(String(r.Source || ''))) continue;
        const bid = r.LightningComponentBundleId || r.Id;
        if (seenBundle.has(bid)) continue;
        seenBundle.add(bid);
        add('LightningComponentBundle', bid, r.LightningComponentBundle?.MasterLabel || r.LightningComponentBundle?.DeveloperName || r.FilePath);
      }
    } catch (e) { miss('Lightning web components', e); }

    // 10b. Aura components (2026-11-10). Salesforce's index is supposed to return them and did not: live on npc it
    // returned NO row for a field that an Aura bundle's markup ({!v.account.Field__c}) and controller name, and
    // Salesforce refused the delete over both. One Tooling query reads every Aura source in the org; a source that
    // names the field as a whole word is listed. Whether that one blocks, 🩺 Ask Salesforce says with the same scan.
    if (L.aura) try {
      msg('Scanning Aura components…');
      const res = await sfQ('SELECT Id, DefType, Source, AuraDefinitionBundleId, AuraDefinitionBundle.DeveloperName, AuraDefinitionBundle.NamespacePrefix FROM AuraDefinition', true);
      const want = new RegExp(`(?<![A-Za-z0-9_])${fieldLc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'i');
      const seenBundle = new Set();
      for (const r of (res?.records || [])) {
        if (r.AuraDefinitionBundle?.NamespacePrefix) continue;          // a package's own component is not editable here
        if (!want.test(String(r.Source || ''))) continue;
        const bid = r.AuraDefinitionBundleId;
        if (!bid || seenBundle.has(bid)) continue;
        seenBundle.add(bid);
        add('AuraDefinitionBundle', bid, r.AuraDefinitionBundle?.DeveloperName || bid);
      }
    } catch (e) { miss('Aura components', e); }

    // 11. Custom metadata records whose value holds the field: a Field
    // Definition relationship makes Salesforce refuse the delete (and SOQL on
    // such a type returned nothing live, so the records are read through
    // readMetadata). Bounded: up to 300 records; more is SAID, not read.
    if (L.customMetadata) try {
      msg('Scanning custom metadata records…');
      const recs = await mdList('CustomMetadata');
      const MAX = 300;
      _cmtUnread = recs.length > MAX ? recs.length : 0;
      if (!_cmtUnread) {
        // one describe per TYPE that has a holding record: is the column a relationship (blocks) or text (does not)?
        const typeFields = new Map();
        const fieldsOf = async api => {
          if (!api) return null;
          if (typeFields.has(api)) return typeFields.get(api);
          const d = await bg({ type: 'SF_REST_GET', orgUrl: _orgUrl, sid: _sid, _suppressError: true, _silentError: true, path: `services/data/v62.0/sobjects/${encodeURIComponent(api)}/describe` });
          const fl = (d && !d.error && Array.isArray(d.fields)) ? d.fields.map(f => ({ name: f.name, extraTypeInfo: f.extraTypeInfo })) : null;
          typeFields.set(api, fl);
          return fl;
        };
        for (const rec of await mdRead('CustomMetadata', recs.map(r => r.fullName), (a, b) => msg(`Scanning custom metadata records… ${a}/${b}`))) {
          const holding = sftkMdValuesHolding(rec.innerXml, obj, _selField.api);
          if (!holding.length) continue;
          // not read, or not told = listed as a blocker, the careful side (Salesforce's own answer decides the delete)
          const kind = fcCmtHoldKind(holding, await fieldsOf(fcCmtTypeApi(rec.fullName)));
          add(kind === 'text' ? 'CustomMetadataText' : 'CustomMetadataRecord', rec.fullName, `${rec.fullName} (${holding.join(', ')})`);
        }
      }
    } catch (e) { miss('custom metadata records', e); }

    // 11b. Entitlement processes (Case / WorkOrder): entry, exit and milestone criteria. Live 2026-11-11 in npc: an
    // INACTIVE process whose milestone criteria name the field made Salesforce refuse the delete ("This custom field
    // is referenced elsewhere in salesforce.com. : Entitlement Processes.") and the index returned nothing. No
    // Tooling read: listMetadata, then readMetadata.
    if (L.entitlements) try {
      msg('Scanning entitlement processes…');
      const names = (await mdList('EntitlementProcess')).map(t => t.fullName);
      for (const rec of await mdRead('EntitlementProcess', names, (a, b) => msg(`Scanning entitlement processes… ${a}/${b}`))) {
        if (!mentions(rec.innerXml)) continue;
        if (String(sftkMdChildText(rec.innerXml, 'SObjectType') || 'Case').toLowerCase() !== objLc) continue;
        add('EntitlementProcess', rec.fullName, (sftkMdChildText(rec.innerXml, 'name') || rec.fullName) + offTag(rec.innerXml));
      }
    } catch (e) { miss('entitlement processes', e); }

    // 11b-2. Omni-Channel service channels: a picklist on the routed object can be the channel's secondary routing
    // priority field. Live 2026-11-11 in npc: Salesforce refused the delete ("This custom field is used by the service
    // channel: SFTK_Gap_Channel. : This field is used as the secondary routing priority field.") and the index
    // returned nothing. Only a picklist can be that field, so the one query is spent for picklists only.
    if (L.workflow && fid15 && /picklist/i.test(String(_selField.type || ''))) try {
      msg('Scanning service channels…');
      // readMetadata does not return the priority field (seen live); the ServiceChannel record holds the field's ID
      const chans = (await sfQ('SELECT Id, DeveloperName, MasterLabel, RelatedEntity, SecRoutingPriorityField FROM ServiceChannel', false))?.records || [];
      for (const c of chans) {
        if (String(c.SecRoutingPriorityField || '').slice(0, 15).toLowerCase() !== fid15) continue;
        add('ServiceChannel', c.DeveloperName, c.MasterLabel || c.DeveloperName);
      }
    } catch (_) {/* non-fatal — an org without Omni-Channel has no such object */}

    // 11c. Custom-setting RECORDS that hold the field's name as text (a "which field to read" setting). Data, not
    // metadata: nothing blocks, whatever reads the value breaks. One query lists the settings, one per setting reads
    // its custom fields (FIELDS(CUSTOM), 200 rows); the first 30 settings — more is SAID, not read. A protected
    // setting of a package refuses the query and is passed over.
    if (L.customSettings) try {
      msg('Scanning custom settings…');
      const sets = (await sfQ('SELECT QualifiedApiName, Label FROM EntityDefinition WHERE IsCustomSetting = true ORDER BY QualifiedApiName LIMIT 200', false))?.records || [];
      const MAXS = 30;
      let i = 0;
      for (const st of sets.slice(0, MAXS)) {
        msg(`Scanning custom settings… ${++i}/${Math.min(sets.length, MAXS)}`);
        const r = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: false, _suppressError: true, _silentError: true, query: `SELECT Id, Name, FIELDS(CUSTOM) FROM ${st.QualifiedApiName} LIMIT 200` });
        for (const row of ((r && !r.error && r.records) || [])) {
          const cols = Object.entries(row).filter(([k, v]) => k !== 'attributes' && k !== 'Id' && typeof v === 'string' && re.test(v)).map(([k]) => k);
          if (cols.length) { add('CustomSettingRecord', row.Id, `${st.Label || st.QualifiedApiName} · ${row.Name || row.Id} (${cols.join(', ')})`); _csRows.set(String(row.Id).slice(0, 15), { sobject: st.QualifiedApiName, cols }); }
        }
      }
      if (sets.length > MAXS) add('CustomSettingRecord', 'cs_unread_more', `${sets.length - MAXS} more custom settings were not read — the scan reads the first ${MAXS}`);
    } catch (e) { miss('custom settings', e); }

    // 12. Lead field mapping — a mapped Lead field AND its Account/Contact/
    // Opportunity target both refuse the delete.
    if (L.leadMapping) try {
      msg('Scanning lead field mappings…');
      for (const rec of await mdRead('LeadConvertSettings', ['LeadConvertSettings'])) {
        const maps = sftkMdLeadMappingsFor(rec.innerXml, obj, _selField.api);
        if (maps.length) add('LeadConvertSettings', 'LeadConvertSettings', maps.map(m => `${m.inputObject}.${m.inputField} → ${m.outputObject}.${m.outputField}`).join(', '));
      }
    } catch (e) { miss('lead field mappings', e); }

    // 13. Lead/Case assignment, auto-response and escalation rules (active or
    // not): one read per container.
    if (L.objectRules) try {
      msg('Scanning assignment, auto-response and escalation rules…');
      const kinds = [['AssignmentRules', 'assignmentRule', 'AssignmentRule'], ['AutoResponseRules', 'autoResponseRule', 'AutoResponseRule'], ['EscalationRules', 'escalationRule', 'EscalationRule']];
      for (const [container, child, type] of kinds) {
        for (const rec of await mdRead(container, [obj])) {
          for (const rule of sftkMdChildren(rec.innerXml, child)) {
            if (mentions(rule.innerXml)) add(type, `${obj}.${rule.fullName}`, rule.fullName + offTag(rule.innerXml));
          }
        }
      }
    } catch (e) { miss('assignment, auto-response and escalation rules', e); }

    // 14. Paths (a mention, not a blocker): live-tested, the delete goes
    // through and the Path stays ACTIVE on a field that no longer exists.
    if (L.paths) try {
      msg('Scanning Paths…');
      const rows = (await sfQ(`SELECT Id, DeveloperName, MasterLabel, IsActive, SobjectProcessField FROM PathAssistant WHERE SobjectType = '${obj}'`, true))?.records || [];
      for (const p of rows) {
        const off = p.IsActive === false ? ' (inactive)' : '';
        if (sameField(p.SobjectProcessField)) { add('PathAssistant', p.Id, (p.MasterLabel || p.DeveloperName) + off); continue; }
        // A path on ANOTHER picklist can still show the field: as a key field of a step (found 2026-11-16 building the
        // packaged-object fixture — the scan listed no path for a field that sat in a step). The steps are in the
        // path's Metadata, which Tooling returns one row at a time.
        const one = (await sfQ(`SELECT Id, Metadata FROM PathAssistant WHERE Id = '${p.Id}'`, true))?.records || [];
        const steps = fcPathStepsWith(one[0] && one[0].Metadata, sameField);
        if (steps.length) add('PathAssistant', p.Id, `${p.MasterLabel || p.DeveloperName}${off} — a key field of the step${steps.length === 1 ? '' : 's'} ${steps.join(', ')}`);
      }
    } catch (e) { miss('Paths', e); }

    // 15. Inactive validation rules (a mention: live-tested, an inactive rule
    // lets the delete through; the index returns only active ones — the demo
    // scan of 2026-11-07 listed none). One Tooling list, one read per rule.
    // Email templates — classic text and HTML, Lightning, Visualforce. Salesforce's dependency index lists few of
    // them, so the text of every template is read (one query, paged) and searched for the field tied to this object.
    // The email ALERTS that send a found template are named on its row: the alert itself holds no field. (user
    // 2026-11-10: "מה שלא ראיתי בסריקה זה email alerts, lightning email templates, classic email templates" —
    // "אנחנו צריכים לתמוך בשלושתם")
    if (L.emailTemplates) try {
      msg('Scanning email templates…');
      const q = await sfQ('SELECT Id, Name, DeveloperName, Subject, Body, HtmlValue, Markup, RelatedEntityType, UiType, TemplateType FROM EmailTemplate', false);
      const all = (q && !q.error ? (q.records || []) : []);
      // the templates Salesforce's index already listed: they get their kind and their alerts on the row too (user
      // 2026-11-10: "מה עם לייטנינג וקלאסיק אימייל טמפלייטים? אני רואה שכתוב רק אימייל טמפלייט")
      const id15 = x => String(x || '').substring(0, 15);
      const indexed = (existingDeps || []).filter(d => d.MetadataComponentType === 'EmailTemplate');
      const indexedIds = new Set(indexed.map(d => id15(d.MetadataComponentId)));
      // 2026-11-15 (close-out review round 3): a custom field picked on Task / Event is Activity's, so {!Event.X__c} is
      // this field too (sftkMdFamObj, as ✂ / ⇄ already read it). The picked object is still asked first: a bare name
      // counts by the template's own RelatedEntityType, which is Task or Event, never Activity.
      const tplFam = sftkMdFamObj(obj, _selField.api);
      const found = all.filter(t => indexedIds.has(id15(t.Id)) || sftkTplNamesField(t, obj, _selField.api) || (tplFam !== obj && sftkTplNamesField(t, tplFam, _selField.api)));
      // which email alerts send them — one Tooling query, only when a template was found
      const sentBy = {};
      let alertRows = [];
      if (found.length) {
        msg('Scanning email templates… their email alerts');
        const al = await sfQ(`SELECT Id, DeveloperName, TemplateId, EntityDefinition.QualifiedApiName FROM WorkflowAlert WHERE TemplateId IN (${found.map(t => `'${t.Id}'`).join(',')})`, true);
        alertRows = (al && !al.error && al.records) || [];
        for (const r of alertRows) (sentBy[String(r.TemplateId).substring(0, 15)] ||= []).push(`${(r.EntityDefinition && r.EntityDefinition.QualifiedApiName) || ''}${r.EntityDefinition ? '.' : ''}${r.DeveloperName}`);
      }
      for (const t of found) {
        const kind = sftkTplKind(t).replace(/ email template$/, '');
        const by = sentBy[id15(t.Id)] || [];
        const label = `${t.Name || t.DeveloperName} (${kind}${by.length ? ` · sent by email alert ${by.join(', ')}` : ''})`;
        const row = indexed.find(d => id15(d.MetadataComponentId) === id15(t.Id));
        if (row) row.MetadataComponentName = label; else add('EmailTemplate', t.Id, label);
      }
      // …and each of those alerts is a row of its own (user 2026-11-10: "וגם הemail alert"): the alert does not name
      // the field, it SENDS a template that does — so it is a mention, not a blocker, and its fix is the template's.
      const tplName = Object.fromEntries(found.map(t => [id15(t.Id), t.Name || t.DeveloperName]));
      for (const r of alertRows) {
        const owner = (r.EntityDefinition && r.EntityDefinition.QualifiedApiName) || '';
        add('EmailAlertViaTemplate', r.Id, `${owner}${owner ? '.' : ''}${r.DeveloperName} → sends “${tplName[id15(r.TemplateId)] || 'the template'}”`);
      }
    } catch (e) { miss('email templates', e); }

    // Search layouts (a mention: the delete goes through and the field drops out of the layout). They are part of
    // the object's own metadata, so the object is read once (user 2026-11-10: "also, what about search layouts?").
    if (L.searchLayouts) try {
      msg('Scanning search layouts…');
      const r = await bg({ type: 'SF_MD_READ', orgUrl: _orgUrl, sid: _sid, mdType: 'CustomObject', fullNames: [obj], _suppressError: true });
      const rec = r && !r.error ? sftkMdExtractRecords(r.text).records.find(x => x.fullName === obj) : null;
      for (const h of sftkSearchLayoutHits(rec ? rec.innerXml : '', obj, _selField.api)) add('SearchLayout', `sl_${obj}_${h.tag}`, h.label);
      // the same read holds the object's picklists: the ones this field controls (live 2026-11-10: the delete goes
      // through and they silently lose their dependency)
      for (const n of sftkDependentPicklists(rec ? rec.innerXml : '', _selField.api)) add('DependentPicklist', `dp_${obj}_${n}`, `${n} — its values depend on this field`);
    } catch (e) { miss('search layouts', e); }

    if (L.validationRulesOff) try {
      msg('Scanning inactive validation rules…');
      const rows = (await sfQ(`SELECT Id, ValidationName FROM ValidationRule WHERE EntityDefinition.QualifiedApiName = '${obj}' AND Active = false`, true))?.records || [];
      await eachMetadata('ValidationRule', rows, m => re.test(String(m.errorConditionFormula || '')) || sameField(m.errorDisplayField),
        'ValidationRuleInactive', r => `${r.ValidationName} (inactive)`, 'inactive validation rules');
    } catch (e) { miss('inactive validation rules', e); }

    // A scoping rule and a restriction rule are one kind to Salesforce (RestrictionRule) and one group here: each
    // row says which it is, and whether it is on (user 2026-11-10: "גם אני לא רואה ברשימה scoping rule" — the
    // rule was listed, as a bare name under "Scoping & Restriction Rules"). One query, only when the index has such rows.
    try {
      const rr = (existingDeps || []).filter(d => d.MetadataComponentType === 'RestrictionRule');
      if (rr.length) {
        const q = await sfQ(`SELECT Id, EnforcementType, IsActive FROM RestrictionRule WHERE Id IN (${rr.map(d => `'${String(d.MetadataComponentId).substring(0, 15)}'`).join(',')})`, true);
        const by = new Map(((q && !q.error && q.records) || []).map(r => [String(r.Id).substring(0, 15), r]));
        for (const d of rr) {
          const r = by.get(String(d.MetadataComponentId).substring(0, 15));
          if (!r || /\((scoping|restriction) rule/.test(String(d.MetadataComponentName || ''))) continue;
          d.MetadataComponentName = `${d.MetadataComponentName} (${String(r.EnforcementType || '').toLowerCase() === 'scoping' ? 'scoping rule' : 'restriction rule'}${r.IsActive === false ? ', inactive' : ''})`;
        }
      }
    } catch (_) {/* non-fatal: the rows keep their bare names */}

    // The index names a lookup filter "nf_<Object>_<field id>" — say which lookup field it is instead.
    try {
      const lf = (existingDeps || []).filter(d => d.MetadataComponentType === 'LookupFilter' && /^nf_\w+?_(00N\w{12,15})$/.test(String(d.MetadataComponentName || '')));
      if (lf.length) {
        const idOf = d => String(d.MetadataComponentName).match(/(00N\w{12,15})$/)[1].substring(0, 15);
        const ids = [...new Set(lf.map(idOf))];
        const r = await sfQ(`SELECT Id, DeveloperName, EntityDefinition.QualifiedApiName FROM CustomField WHERE Id IN (${ids.map(i => `'${i}'`).join(',')})`, true);
        const by = new Map((r?.records || []).map(f => [String(f.Id).substring(0, 15), `${f.EntityDefinition?.QualifiedApiName || '?'}.${f.DeveloperName}__c`]));
        for (const d of lf) if (by.has(idOf(d))) { d._lookupFieldId = idOf(d); d._lookupFieldName = by.get(idOf(d)); d.MetadataComponentName = `${by.get(idOf(d))} — its lookup filter`; }
      }
    } catch (_) {/* non-fatal */}

    hits.unread = unread;
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
  // The scan's tester on a Lightning page with its free text (description, label) left out: true when the page still
  // names the field somewhere a component or rule reads it (2026-11-14, see toggleXmlInspector).
  function _flexiNamesBeyondText(metadata, objApi, fieldApi) {
    if (!metadata || typeof metadata !== 'object') return false;
    // 2026-11-15 (review of f0334a0): only the page's own description and label were left out, so a Rich Text
    // component whose text says the field's name, or a component's title / label / header, kept the page "named
    // inside a longer value": never settled, nothing for ✂ to take out, Delete Field locked with no way on but
    // App Builder. A component's display-text properties are free text too — Salesforce does not hold a field on
    // them — and are left out the same way. Everything else (related-list columns, filters, criteria) still counts.
    const FREE_TEXT = /^(?:richTextValue|decorators)$|(?:title|label|header|heading)$/i;
    const strip = node => {
      if (Array.isArray(node)) return node.filter(x => !(x && typeof x === 'object' && typeof x.name === 'string' && 'value' in x && FREE_TEXT.test(x.name))).map(strip);
      if (!node || typeof node !== 'object') return node;
      const out = {};
      for (const k of Object.keys(node)) out[k] = strip(node[k]);
      return out;
    };
    const rest = strip(metadata);
    delete rest.description; delete rest.masterLabel;
    return flexiPageReferencesField(rest, objApi, fieldApi);
  }

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
  // The last error a lookup query answered with — said to the user instead of "could not locate" (owner 2026-11-11:
  // dlrs__LookupChild__c.SFTK_Pkg_Tag__c, a field that exists, answered "Could not locate this field": every query's
  // error was swallowed and the three failures read as "no such field").
  let _resolveErr = '';
  // 2026-11-14 (release QA): CustomField.DeveloperName carries no namespace, so 'Foo' matches the org's Foo__c AND a
  // package's ns__Foo__c on the same object, and records[0] (no order guaranteed) could be the other field's Id: the
  // scan then listed the wrong field's dependencies and the delete re-read the packaged field as 'can still be read
  // back'. Every lookup now reads NamespacePrefix and takes only the row whose namespace is the picked field's; a
  // lookup that finds only another namespace's field answers nothing (the next attempt, or 'could not locate').
  function _pickOwnFieldRow(records, fieldApi) {
    const base = String(fieldApi || '').replace(/__c$/i, '');
    const want = base.includes('__') ? base.slice(0, base.indexOf('__')).toLowerCase() : '';
    const row = (records || []).find(r => r && r.Id && String(r.NamespacePrefix || '').toLowerCase() === want);
    return row ? row.Id : null;
  }
  // 2026-11-15: the selection comes in as PARAMETERS (named as the module's own, which they shadow) — an org switch
  // nulls the module's _selObj / _selField while a lookup is in flight, and the next query then threw on null.
  async function resolveCustomFieldId(_selObj, _selField) {
    const devName = deriveDevName(_selField.api);
    _resolveErr = '';
    const note = r => { if (r && r.error) _resolveErr = String(r.error); };

    // Attempt 1: use EntityDefinition.DurableId as TableEnumOrId (works for both standard + custom)
    const res1 = await bg({
      type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true,
      query: `SELECT Id, NamespacePrefix FROM CustomField WHERE DeveloperName = '${devName}' ` +
             `AND TableEnumOrId = '${_selObj.durableId}'`
    });
    { const id = !res1.error ? _pickOwnFieldRow(res1.records, _selField.api) : null; if (id) return id; }
    note(res1);

    // Attempt 1b: by the object's API NAME through the relationship — no id of ours in the query, so a stale or
    // missing DurableId cannot fail it (works for standard, custom and packaged objects; proven on npc 2026-11-11).
    const res1b = await bg({
      type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true,
      query: `SELECT Id, NamespacePrefix FROM CustomField WHERE DeveloperName = '${devName.split('__').pop()}' ` +
             `AND EntityDefinition.QualifiedApiName = ${fcSoqlLit(_selObj.api)}`
    });
    { const id = !res1b.error ? _pickOwnFieldRow(res1b.records, _selField.api) : null; if (id) return id; }
    note(res1b);

    // Attempt 2: try with QualifiedApiName (fallback for standard objects)
    if (_selObj.durableId !== _selObj.api) {
      const res2 = await bg({
        type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true,
        query: `SELECT Id, NamespacePrefix FROM CustomField WHERE DeveloperName = '${devName}' ` +
               `AND TableEnumOrId = '${_selObj.api}'`
      });
      { const id = !res2.error ? _pickOwnFieldRow(res2.records, _selField.api) : null; if (id) return id; }
      note(res2);
    }

    // Attempt 3: try stripping namespace from devName (e.g. ns__My_Field → My_Field)
    if (devName.includes('__')) {
      const shortName = devName.split('__').pop();
      const res3 = await bg({
        type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true,
        query: `SELECT Id, NamespacePrefix FROM CustomField WHERE DeveloperName = '${shortName}' ` +
               `AND TableEnumOrId = '${_selObj.durableId}'`
      });
      { const id = !res3.error ? _pickOwnFieldRow(res3.records, _selField.api) : null; if (id) return id; }
      note(res3);
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
                      note: 'A flow that runs on the field has two ways: ✂ Remove · flow keeps running saves a new active version without the field; 🗑 Delete versions · flow off switches the flow off. Either way every version that still mentions the field is deleted — Salesforce keeps the dependency lock per version, so a stale version would otherwise still block the field delete.',
                      doneLabel: '✅ Activated',
                      replNote: 'The active version is saved again with every reference pointing at {new} — the flow keeps its logic — then activated and verified. Old versions that still reference the old field are deleted: Salesforce keeps the dependency lock per version.' },
    // Live 2026-11-06: a page that holds the field (a field component or a
    // visibility rule) makes Salesforce REFUSE the delete — a blocker.
    FlexiPage:      { icon: '📄', label: 'Lightning Pages',  fixable: true, sev: 'blocker',
                      note: 'Salesforce refuses the delete while a Lightning page holds the field. Field references in visibility rules and field components are removed automatically.',
                      doneLabel: '✅ Page updated',
                      replNote: 'Field components and visibility rules that use the field are pointed at {new}.' },
    Layout:         { icon: '📋', label: 'Page Layouts',     fixable: true, sev: 'silent',
                      note: 'The field will be removed from all layout sections automatically.',
                      doneLabel: '✅ Layout updated',
                      replNote: '{new} takes the field’s place on the layout.' },
    ListView:       { icon: '📊', label: 'List Views',       fixable: false, sev: 'silent',
                      note: 'The view shows or filters on the field. ✂ takes the column and the filter out (a numbered filter logic refuses), ⇄ points them at another field, ✎ edits the XML, 🗑 deletes the view — or edit it in Setup.' },
    CompactLayout:  { icon: '📇', label: 'Compact Layouts',  fixable: false, sev: 'silent',
                      note: 'The compact layout lists the field. ✂ takes it out (not the last field), ⇄ swaps it, ✎ edits the XML, 🗑 deletes the layout — or edit it in Object Manager.' },
    QuickAction:    { icon: '⚡', label: 'Quick Actions',    fixable: false, sev: 'silent',
                      note: 'The action’s layout or predefined values name the field. ✂ takes them out, ⇄ swaps them, ✎ edits the XML, 🗑 deletes the action — or edit it in Object Manager → Buttons, Links, and Actions.' },
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
                      note: 'Edit the rule’s criteria or formula in Setup, or delete the rule — an inactive rule blocks the delete too (live-tested). Found by reading every workflow rule on this object.' },
    WorkflowAlert:  { icon: '📨', label: 'Email Alerts',     fixable: false, sev: 'blocker',
                      note: 'The alert sends to this field. Change its recipient in Setup (Workflow Actions → Email Alerts) or delete the alert.' },
    EmailAlertViaTemplate: { icon: '📨', label: 'Email Alerts (send a template that uses the field)', fixable: false, sev: 'silent',
                      note: 'The alert itself does not name the field — it sends an email template that does. Deleting the field goes through; the alert keeps sending, with that merge field empty. Fix the template (under Email Templates) and the alert needs nothing; 🗑 deletes the alert itself (a restore point is kept).' },
    SearchLayout:   { icon: '🔎', label: 'Search Layouts', fixable: true, sev: 'silent',
                      note: 'The object’s search layout lists the field as a column. The delete goes through and the column goes with it; ✂ takes it out now.',
                      doneLabel: '✅ Search layout updated',
                      replNote: '{new} takes the field’s place in the layout (when it is already a column there, the old one just goes).' },
    DependentPicklist: { icon: '🔗', label: 'Dependent Picklists', fixable: false, sev: 'silent',
                      note: 'This field controls which values the picklist offers. The delete goes through (live-tested): the picklist is left with no controlling field and offers every value, with no warning. Decide what should control it first — Object Manager → Fields & Relationships → Field Dependencies.' },
    WorkflowOutboundMessage: { icon: '📡', label: 'Outbound Messages', fixable: false, sev: 'blocker',
                      note: 'The message sends this field. Take it out of the message’s fields in Setup (Workflow Actions → Outbound Messages) or delete the message.' },
    SharingCriteriaRule: { icon: '🔐', label: 'Sharing Rules (criteria)', fixable: false, sev: 'blocker',
                      note: 'The rule’s criteria name the field. Edit or delete the sharing rule in Setup → Sharing Settings. Found by reading this object’s sharing rules.' },
    DuplicateRule:  { icon: '👥', label: 'Duplicate Rules',  fixable: false, sev: 'blocker',
                      note: 'The rule’s record filter names the field — active or not, Salesforce refuses the delete. ✂ / ⇄ / ✎ edit the filter here (the diff shown first, a restore point kept), 🗑 delete the rule, or edit it in Setup → Duplicate Management. Nothing switches a duplicate rule off or edits one behind a deployment.' },
    LightningComponentBundle: { icon: '⚡', label: 'Lightning Web Components', fixable: false, sev: 'blocker',
                      note: 'The component imports the field’s schema (@salesforce/schema). Remove the import in the code and deploy. A field named only in the HTML does not block — and is not listed.' },
    AskNamed:       { icon: '🩺', label: 'Named by Salesforce', fixable: false, sev: 'blocker',
                      note: 'Salesforce refuses the delete over this, in its own words, and the scan did not find it. Clear it in Setup; Salesforce is asked again when the list is clear.' },
    AuraDefinitionBundle: { icon: '⚡', label: 'Aura Components', fixable: false, sev: 'blocker',
                      note: 'The component’s markup or JavaScript names the field. Salesforce refused a delete over an Aura expression that reads the field (live-tested); a plain text mention may not block — its own answer in the delete box says which. Found by reading every Aura source in the org, not through Salesforce’s index.' },
    EntitlementProcess: { icon: '⏱', label: 'Entitlement Processes', fixable: false, sev: 'blocker',
                      note: 'The process’s entry, exit or milestone criteria name the field — active or not, Salesforce refuses the delete (live-tested). 🗑 deletes the process (a restore point is kept), or change its criteria in Entitlement Processes.' },
    ServiceChannel: { icon: '🎧', label: 'Service Channels', fixable: false, sev: 'blocker',
                      note: 'The Omni-Channel service channel uses the field as its secondary routing priority — Salesforce refuses the delete (live-tested). 🗑 deletes the channel (a restore point is kept), or pick another priority field on the channel.' },
    CustomSettingRecord: { icon: '🧾', label: 'Custom Setting Records', fixable: false, sev: 'silent',
                      note: 'A record of a custom setting holds the field’s name as text. The delete goes through; whatever reads that value — Apex, a flow, a formula — then looks for a field that is gone. ✂ takes the field’s name out of the value (↩ Undo writes it back), or change the value in the custom setting.' },
    CustomMetadataRecord: { icon: '🗂', label: 'Custom Metadata Records', fixable: false, sev: 'blocker',
                      note: 'A record holds the field’s name in a relationship column (Field Definition) — Salesforce refuses the delete while it does. ✂ takes the value out, ⇄ points it at the replacement, or edit the record in Setup → Custom Metadata Types → Manage Records.' },
    CustomMetadataText: { icon: '🗂', label: 'Custom Metadata Records (text value)', fixable: false, sev: 'silent',
                      note: 'A record holds the field’s name as plain text. The delete goes through; whatever reads that value — Apex, a flow, a formula — then looks for a field that is gone. ✂ takes the name out, ⇄ writes the replacement.' },
    LeadConvertSettings: { icon: '🔀', label: 'Lead Field Mapping', fixable: false, sev: 'blocker',
                      note: 'The field is mapped for lead conversion — the Lead field and its target both block the delete. Remove the pair in Setup → Object Manager → Lead → Fields → Map Lead Fields.' },
    AssignmentRule: { icon: '📬', label: 'Assignment Rules', fixable: false, sev: 'blocker',
                      note: 'A rule entry’s criteria name the field — active or not. Edit the entry in Setup → Assignment Rules.' },
    AutoResponseRule: { icon: '↩️', label: 'Auto-Response Rules', fixable: false, sev: 'blocker',
                      note: 'A rule entry’s criteria name the field. Edit the entry in Setup → Auto-Response Rules.' },
    EscalationRule: { icon: '⏫', label: 'Escalation Rules', fixable: false, sev: 'blocker',
                      note: 'A rule entry’s criteria name the field — active or not. Edit the entry in Setup → Escalation Rules.' },
    ApexComponent:  { icon: '🧩', label: 'Visualforce Components', fixable: false, sev: 'blocker',
                      note: 'Update the component markup to remove the field reference.' },
    ApexPage:       { icon: '📃', label: 'Visualforce Pages', fixable: false, sev: 'blocker',
                      note: 'Update the page markup to remove the field reference.' },
    RestrictionRule: { icon: '🚧', label: 'Scoping & Restriction Rules', fixable: false, sev: 'blocker',
                      note: 'The rule’s record filter names the field — active or not. Edit the rule in Object Manager → Scoping Rules / Restriction Rules.' },
    // the index returns these four by their raw type name; the demo scan of 2026-11-07 showed them as "CustomField 2", "LookupFilter 1: nf_Contact_00N…"
    CustomField:    { icon: '🧮', label: 'Formula & Roll-up Fields', fixable: false, sev: 'blocker',
                      note: 'A formula or roll-up summary field reads this field — on this object or across a relationship. Change or delete that field in Object Manager → Fields & Relationships.' },
    WebLink:        { icon: '🔗', label: 'Custom Buttons & Links', fixable: false, sev: 'blocker',
                      note: 'The button’s URL or content merges the field. Edit it in Object Manager → Buttons, Links, and Actions.' },
    LookupFilter:   { icon: '🔎', label: 'Lookup Filters', fixable: false, sev: 'blocker',
                      note: 'A lookup field’s filter compares this field. Edit the filter on that lookup field in Object Manager → Fields & Relationships.' },
    FieldSet:       { icon: '🗃', label: 'Field Sets', fixable: false, sev: 'blocker',
                      note: 'The field set lists the field. Take it out in Object Manager → Field Sets.' },
    ValidationRuleInactive: { icon: '☑', label: 'Validation Rules (inactive)', fixable: false, sev: 'silent',
                      note: 'An inactive rule does not block the delete, but its formula breaks the day it is switched on again. ⇄ points the formula at another field, ✎ edits the XML, 🗑 deletes the rule — or fix it in Object Manager → Validation Rules.' },
    ProcessBuilder: { icon: '⚙', label: 'Process Builder',  fixable: false, sev: 'blocker',
                      note: 'Open the process in Setup (Process Automation → Process Builder), take the field out of its criteria and actions or deactivate and delete the process, then re-scan. Listed under Flows; not edited here.' },
    PathAssistant:  { icon: '🛤', label: 'Paths',            fixable: false, sev: 'silent',
                      note: 'A path that runs on the field: the delete goes through and the Path stays active on a field that no longer exists (live-tested). Delete or re-point the Path in Setup → Path Settings first (Salesforce does not let a path be deleted from outside Setup). A path that shows the field as a key field of a step is listed too: ✂ takes the field out of that step, ⇄ points it at the replacement.' },
    // Both come from Salesforce's own dependency index — the same one behind
    // "Where is this used?" — so they cost nothing extra to find (user
    // 2026-09-01: "one of the metadata items that we scan everytime").
    Report:         { icon: '📊', label: 'Reports',          fixable: true, sev: 'silent',
                      note: 'The field is removed from the report’s columns, filters and groupings (a restore point is saved first). Formulas and buckets are never auto-edited and stay listed as manual; an edit that would break the report (its only column or only grouping) is refused with the fix.',
                      doneLabel: '✅ Report updated',
                      replNote: 'Columns, filters and groupings that use the field are pointed at {new} (a restore point is saved first). Formulas and buckets are never auto-edited and stay listed as manual.' },
    // Found by READING every custom report type in the org (SOAP readMetadata:
    // 1 list + 1 call per 10 types) — live 2026-11-04 the dependency index
    // listed the fixture field's layout and flows, not its report type.
    ReportType:     { icon: '📑', label: 'Report Types',     fixable: true, sev: 'silent',
                      note: 'The field’s column is removed from the report type’s sections (a restore point is saved first); a section left with no columns goes with it. A report built on the type loses that column, so fix the reports listed above first. A managed package’s report type is listed and left to Setup.',
                      doneLabel: '✅ Report type updated',
                      replNote: 'The column is pointed at {new} in place (a restore point is saved first). When the new field is already a column of the type, the old column is removed instead — a column may appear once per report type.' },
    // Live 2026-11-06: a text, Visualforce or Lightning template with the
    // merge field does NOT stop the delete — the merge field just stops
    // working afterwards. The index returned every fixture template.
    EmailTemplate:  { icon: '✉️', label: 'Email Templates',  fixable: true, sev: 'silent',
                      note: 'The delete goes through; the merge field in the template stops working. ✂ takes every merge field that names the field out of the subject, body, HTML and Visualforce markup; ⇄ renames it inside them; ✎ edits the texts. Classic, Lightning and Visualforce templates alike. Templates are listed when Salesforce’s dependency index reports them.',
                      doneLabel: '✅ Template updated',
                      replNote: 'Every merge field that names the field now names {new}.' },
    // Live 2026-11-06: an approval process that names the field in its
    // criteria blocks the delete, ACTIVE OR NOT; the index returned none of
    // them, so the scan reads every approval process on the object.
    ApprovalProcess:{ icon: '✅', label: 'Approval Processes', fixable: false, sev: 'blocker',
                      note: 'Edit the approval process in Setup (entry criteria, step criteria), then re-scan. Active or not, Salesforce refuses the delete while the process names the field. Found by reading every approval process on this object.' },
  };
  const TYPE_CFG_DEFAULT = { icon: '🔧', label: 'Other', fixable: false, sev: 'blocker',
    note: 'Review this dependency in Setup before deleting the field.' };

  // F2: unresolved manual blockers (types the extension can't auto-fix that
  // will make Salesforce reject the delete). Read by checkEnableDelete.
  let _manualBlockers = [];

  // F8: honest disclosure of what the scan does NOT cover. Reports (live
  // 2026-10-04, trailheads5): the index, queried through the Tooling REST
  // API, returned NO Report rows at all — not for two public reports that
  // used the field, not with an explicit type filter; the Bulk API route
  // answered "sObject type not supported". Blockers (live 2026-11-06, npc,
  // 60+ fixtures put to a destructive delete): every reference type that
  // makes Salesforce refuse the delete is read by its own leg now; what is
  // left unread does not block, and is named here.
  function _unscannedNoteHtml() {
    const cmt = _cmtUnread
      ? ` <strong>Custom metadata records were not read</strong> — this org has ${_cmtUnread.toLocaleString('en-US')} and the scan reads up to 300. A record whose Field Definition points at this field makes Salesforce refuse the delete: check Setup → Custom Metadata Types before deleting.`
      : '';
    return `
      <div class="fc-unscanned-note">
        ℹ️ <strong>${(_lastScan && _lastScan.unread && _lastScan.unread.length) ? 'What blocks the delete is normally read in full — this time some kinds could not be read (see the ⚠ note above)' : 'What blocks the delete is read in full'}</strong> (each kind live-tested against a real delete):
        Apex, Visualforce, formula and roll-up fields, validation rules, flows and Process Builder, workflow rules,
        field updates, alerts and outbound messages, matching and duplicate rules, approval processes, sharing and
        scoping rules, Lightning pages, Lightning web components, custom metadata records, lead field mappings and
        Lead/Case rules.${cmt}
        <strong>Reports</strong> appear above only when Salesforce’s dependency index returns them through its API.
        In some orgs it returns none (seen live: two public reports used a field and neither was listed),
        so a report that uses this field can be missing here. Before deleting, press 📊 Scan the reports below (it reads every report itself),
        or open the field in Setup and press “Where is this used?” — that page lists reports.
        <strong>Not read, and not a blocker</strong> (the delete goes through; these break or lose the field quietly):
        a Lightning web component that names the field only in its HTML,
        related-list columns on other objects’ layouts, record-type picklist values, dependent-picklist settings,
        Experience Cloud pages, and any text that holds the field’s name (dynamic Apex, custom settings, custom
        labels). <strong>Not readable</strong>: territory assignment rules and managed-package components.
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
    const swap = _swapOn();
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

  async function renderResults(allDeps, fieldId) {
    const results = eid('fcResults');
    if (!results) return;
    // one scan, every kind (2026-11-08): the list below is the whole answer; the filter row shows a part of it
    const sevOf = t => (TYPE_CFG[t] || TYPE_CFG_DEFAULT).sev;
    const deps = (allDeps || []).slice();

    const pkgNs = fcFieldNamespace(_selField && _selField.api);
    if (!deps.length) {
      results.innerHTML = `
        <div class="fc-clean">
          ${pkgNs ? `<div class="fc-clean-icon">📦</div>
          <div class="fc-clean-title">Nothing in this org’s own metadata uses the field</div>
          <div class="fc-clean-sub"><code>${esc(_selField.api)}</code> belongs to the package <b>${esc(pkgNs)}</b>. A packaged field cannot be deleted here — it goes only with the package (or with a package upgrade). The package’s own code, flows and rules are not readable, so they were not scanned: this is not “unused”.</div>`
          : `<div class="fc-clean-icon">✅</div>
          <div class="fc-clean-title">No dependencies found</div>
          <div class="fc-clean-sub">The scan found nothing that uses this field. Salesforce is asked below whether it would accept the delete.</div>
          <div class="fc-clean-btns"><button class="btn btn-danger" id="fcDelFreeBtn">🗑 Delete Field</button></div>
          <div class="fc-ask-box" id="fcAskBox" hidden></div>`}
        </div>
        <div id="fcDataVerdict" class="fc-data-verdict fc-data-loading">${sftkCatSm('Measuring how much data is stored in this field…')}</div>
        <div id="fcCopyVals"></div>
        <div id="fcDepZone"></div>
        <div id="fcFlsPanel"></div>
        ${_unscannedNoteHtml()}
        <div id="fcRptScan"></div>
        <div id="fcOrgSweep"></div>`;
      if (eid('fcDelFreeBtn')) eid('fcDelFreeBtn').onclick = () => confirmDelete(fieldId);   // a packaged field has no delete button
      _autoAsk();
      runDataUsage();
      renderDeprecationZone(fieldId);
      renderFlsPanel();
      renderReportScan();
      renderOrgSweep();   // 2026-11-17: the box was left empty exactly when the index found nothing — the case the text scan is for
      return;
    }

    // Group
    _groups = {};
    for (const d of deps) {
      const t = d.MetadataComponentType || 'Unknown';
      if (!_groups[t]) _groups[t] = [];
      _groups[t].push(d);
    }

    // The dependency index reports a flow once per VERSION that mentions the
    // field. Read each version's number and status once, then show ONE card
    // per flow that says what happens to each of its versions.
    if (_groups.Flow) await _loadFlowVersionInfo(_groups.Flow);
    _flowCards = _groups.Flow ? _flowCardsOf(_groups.Flow) : [];
    _curFieldId = fieldId;
    // counted as the user sees them: a flow is one item, whatever its versions
    const flowExtra = (_groups.Flow ? _groups.Flow.length : 0) - _flowCards.length;
    const shownCount = deps.length - flowExtra;

    // a Process Builder process is listed under Flows but is not fixable here
    const pbCards = _flowCards.filter(c => c.pb).length;
    const autoCount   = Object.entries(_groups)
      .filter(([t]) => (TYPE_CFG[t] || TYPE_CFG_DEFAULT).fixable)
      .reduce((n, [,arr]) => n + arr.length, 0) - flowExtra - pbCards;
    // 🗑 blockers the delete engine can remove as a whole (user 2026-11-07): counted apart from the true hand jobs
    const delCount = Object.entries(_groups)
      .filter(([t]) => { const c = TYPE_CFG[t] || TYPE_CFG_DEFAULT; return c.sev === 'blocker' && !c.fixable && typeof sftkMdDeleteSpec === 'function' && !!sftkMdDeleteSpec(t); })
      .reduce((n, [,arr]) => n + arr.length, 0);
    const manualCount = shownCount - autoCount - delCount;
    // the ⚡ row counts every item with a way right now: the fixable kinds, and the blockers with ✂ / ⇄ (code: ⇄ only)
    const everyCount = autoCount + Object.entries(_groups)
      .filter(([t]) => { const c = TYPE_CFG[t] || TYPE_CFG_DEFAULT; if (c.fixable || c.sev !== 'blocker') return false; const w = typeof sftkMdEditWays === 'function' ? sftkMdEditWays(t) : null; const cd = typeof sftkMdCodeWays === 'function' ? sftkMdCodeWays(t) : null; return (w && (w.remove || _replOn())) || (cd && _replOn()); })
      .reduce((n, [, arr]) => n + arr.length, 0);

    let html = `
      <div class="fc-status" id="fcStatus">
        <div class="fc-status-hd">
          <code>${esc(_selObj.api)}.${esc(_selField.api)}</code>
          <span class="fc-status-n"><strong>${shownCount}</strong> place${shownCount === 1 ? '' : 's'} use${shownCount === 1 ? 's' : ''} it</span>
          <span class="fc-badge-row">
            ${autoCount   > 0 ? `<span class="fc-badge-auto">${autoCount} fixable here</span>`  : ''}
            ${delCount > 0 ? `<span class="fc-badge-del" title="Blockers this tool can edit (✂ / ⇄ inside them, where their kind allows) or delete as a whole — each with a restore point">${delCount} to edit or delete here</span>` : ''}
            ${manualCount > 0 ? `<span class="fc-badge-manual">${manualCount} by hand</span>` : ''}
          </span>
        </div>
        ${_foldHtml('data', '📈', 'The field’s data', 'how much is stored, who sees it, and what moves with a replace', `
        <div id="fcDataVerdict" class="fc-fact fc-data-verdict fc-data-loading"><span class="fc-fact-ico">📈</span><span class="fc-fact-text">${sftkCatSm('Measuring how much data is stored in this field…')}</span></div>
        <div id="fcCopyVals"></div>
        <div id="fcFlsPanel"></div>`)}
        ${_foldHtml('further', '🔭', 'Look further than the index', 'every report, and a full metadata text scan — on request', `
        <div id="fcRptScan"></div>
        <div id="fcOrgSweep"></div>`)}
        <div id="fcDepZone"></div>
        ${_mcdCapped ? `<div class="fc-fact fc-fact-warn"><span class="fc-fact-ico">⚠</span><span class="fc-fact-text"><strong>This list may be cut short.</strong> Salesforce stops its dependency index at 2,000 rows without saying so — treat the count as a floor: fix what is listed, scan again, repeat.</span></div>` : ''}
      </div>`;

    const groupHtml = (type, items, sev) => {
      const cfg = TYPE_CFG[type] || { ...TYPE_CFG_DEFAULT, label: type };
      const nItems = type === 'Flow' ? _flowCards.length : items.length;
      // the bulk buttons count only what they would touch — a Process Builder card is listed but never rewritten
      const nFix = type === 'Flow' ? _flowCards.filter(c => !c.pb).length : nItems;
      return `
        <div class="fc-group" id="fcGroup_${esc(type)}" data-sev="${sev}">
          <div class="fc-group-hdr">
            <span class="fc-group-icon">${cfg.icon}</span>
            <span class="fc-group-label">${esc(cfg.label)}</span>
            <span class="fc-group-sev fc-group-sev-${sev}" title="${sev === 'must' ? 'Salesforce refuses the delete while any of these still references the field' : 'Salesforce lets the delete through — these lose the field or stop working afterwards'}">${sev === 'must' ? '🔒 must fix' : '👀 might break'}</span>
            <span class="fc-group-count"${type === 'Flow' ? ` title="${items.length} version${items.length === 1 ? '' : 's'} of ${nItems === 1 ? 'this flow' : 'these flows'} mention the field"` : ''}>${nItems}</span>
            <span class="fc-group-sp"></span>
            ${type === 'Flow'
              ? xlinkHtml('flows', '↗ Flows', "Manage these flows' versions — delete stale ones, backup, restore — in the Flows tool")
              : type === 'FlexiPage'
                ? xlinkHtml('pages', '↗ Lightning Pages', 'Inspect assignments, org defaults, and profile overrides for these pages in the Lightning Pages tool')
                : ''}
            ${(cfg.fixable || (typeof sftkMdEditWays === 'function' && sftkMdEditWays(type)) || (typeof sftkMdCodeWays === 'function' && sftkMdCodeWays(type))) && nFix > 1
              ? `<span class="fc-fix-allbox" data-type="${esc(type)}" data-n="${nFix}" data-label="${esc(cfg.label)}">${_fixAllHtml(type, nFix, cfg.label)}</span>`
              : ''}
          </div>
          <div class="fc-group-items">
            ${type === 'Flow' ? _flowCards.map(renderFlowCard).join('') : items.map(d => renderItem(d, cfg.fixable, type)).join('')}
          </div>
        </div>`;
    };
    // ONE list (user 2026-11-08: "one tab is enough, but should be filtered by must and optional metadata references"):
    // the blockers first, then what breaks afterwards, each group tagged; the filter row shows all, 🔒 or 👀.
    const nOf = ([t, arr]) => t === 'Flow' ? _flowCards.length : arr.length;
    const blockerGroups = Object.entries(_groups).filter(([t]) => sevOf(t) === 'blocker');
    const mentionGroups = Object.entries(_groups).filter(([t]) => sevOf(t) !== 'blocker');
    const nB = blockerGroups.reduce((n, g) => n + nOf(g), 0), nM = mentionGroups.reduce((n, g) => n + nOf(g), 0);
    if (_fcFilter === 'must' && !nB) _fcFilter = 'all';
    if (_fcFilter === 'later' && !nM) _fcFilter = 'all';
    html += '<!--FC_GATE-->';   // the gate (the 🔒 box, the delete button) is drawn here, above the list (user 2026-11-08: "maybe it should be on top?")
    html += `
      <div class="fc-section fc-section-all" id="fcSectionAll">
        <div class="fc-section-hdr"><span class="fc-section-title">Where the field is used</span><span class="fc-section-n">${nB + nM}</span>
          <span class="fc-filter" id="fcFilter" role="radiogroup" aria-label="Show">
            <button type="button" class="fc-filter-btn" data-filter="all" role="radio">All <b>${nB + nM}</b></button>
            <button type="button" class="fc-filter-btn fc-filter-must" data-filter="must" role="radio"${nB ? '' : ' disabled'} title="Salesforce refuses the delete while any of these still references the field">🔒 Must fix <b>${nB}</b></button>
            <button type="button" class="fc-filter-btn fc-filter-later" data-filter="later" role="radio"${nM ? '' : ' disabled'} title="Salesforce lets the delete through — these lose the field or stop working afterwards">👀 Might break <b>${nM}</b></button>
          </span>${_fixEveryHtml(everyCount)}</div>
        <div class="fc-section-sub" id="fcFilterSub"></div>
        ${blockerGroups.map(([t, a]) => groupHtml(t, a, 'must')).join('')}${mentionGroups.map(([t, a]) => groupHtml(t, a, 'later')).join('')}
      </div>`;
    // ── F2: predictive blocker check ─────────────────────────────────────
    // Classify by whether Salesforce will actually REJECT the delete. Manual
    // blockers (Apex, validation/workflow/matching rules) can't be auto-fixed
    // here — Salesforce would 400 the delete — so gate the button on them up
    // front instead of letting the attempt fail server-side.
    const gateGroups = {};
    for (const d of (allDeps || [])) { const t = d.MetadataComponentType || 'Unknown'; (gateGroups[t] = gateGroups[t] || []).push(d); }
    _manualBlockers = Object.entries(gateGroups)
      .filter(([t]) => {
        const cfg = TYPE_CFG[t] || TYPE_CFG_DEFAULT;
        return cfg.sev === 'blocker' && !cfg.fixable;
      })
      .map(([t, arr]) => ({ type: t, label: (TYPE_CFG[t] || { label: t }).label, count: arr.length }));
    if (pbCards) _manualBlockers.push({ type: 'ProcessBuilder', label: `Process Builder process${pbCards === 1 ? '' : 'es'} (listed under Flows)`, count: pbCards });
    const blockerTotal = _manualBlockers.reduce((n, b) => n + b.count, 0);
    const silentManual = Object.entries(_groups)
      .filter(([t]) => { const c = TYPE_CFG[t] || TYPE_CFG_DEFAULT; return c.sev === 'silent' && !c.fixable; })
      .reduce((n, [, arr]) => n + arr.length, 0);
    const unread = (_lastScan && _lastScan.unread) || [];
    const delDisabled = autoCount > 0 || blockerTotal > 0 || unread.length > 0;   // unread: until Salesforce's own check accepts (_paintAsk)
    const unreadBlock = unread.length ? `
        <div class="fc-unread-note" id="fcUnreadNote">
          <strong>⚠ ${unread.length} kind${unread.length === 1 ? '' : 's'} of metadata could not be read in this scan</strong> — so the list below may be missing something that blocks the delete. Press 🔍 Re-scan. Delete Field stays locked until they are read, or until Salesforce itself says it would accept the delete.
          <ul>${unread.slice(0, 12).map(u => `<li><b>${esc(u.leg)}</b> — ${esc(u.why)}</li>`).join('')}${unread.length > 12 ? `<li>… and ${unread.length - 12} more</li>` : ''}</ul>
        </div>` : '';

    // one header, one chip per kind (click → its group below; the tooltip says its ways), ONE sentence about the
    // ways (user 2026-11-08: "this section needs to improve. its very hard to understand and nobody will read it")
    const blockerBlock = blockerTotal > 0 ? `
      <div class="fc-blockers">
        <div class="fc-blockers-hdr">🔒 ${blockerTotal} blocker${blockerTotal === 1 ? ' stops' : 's stop'} the delete</div>
        <div class="fc-blockers-chips">${_manualBlockers.map(b => `<button type="button" class="fc-blocker-row fc-blocker-chip" data-type="${esc(b.type)}" data-group="${esc(b.type === 'ProcessBuilder' ? 'Flow' : b.type)}" title="${esc(b.label)} — ${esc(_blockerWays(b.type))}. Click to jump to ${b.count === 1 ? 'it' : 'them'} in the list below.">${(TYPE_CFG[b.type] || {}).icon || '🔧'} <strong>${b.count}</strong> ${esc(b.label)}</button>`).join('')}</div>
        <div class="fc-blockers-foot">Clear each one in its group below — ✂ take the field out · ⇄ point it at another field · ✎ edit it · 🗑 delete it; every change keeps a restore point. Or fix it in Setup. Then re-scan.</div>
      </div>` : '';
    const silentNote = silentManual > 0 ? `
      <div class="fc-silent-note">👀 ${silentManual} more ${silentManual === 1 ? 'was' : 'were'} read too — list views, quick actions and the like. Salesforce lets the delete through with ${silentManual === 1 ? 'it' : 'them'}, then ${silentManual === 1 ? 'it loses' : 'they lose'} the field or ${silentManual === 1 ? 'stops' : 'stop'} working. Fix ${silentManual === 1 ? 'it' : 'them'} under 👀 Might break.</div>` : '';

    const gateHtml = `
      <div class="fc-delete-zone" id="fcDeleteZone">
        ${blockerBlock}
        ${unreadBlock}
        ${silentNote}
        <div class="fc-delete-note" id="fcDeleteNote">
          ${autoCount > 0
            ? `⚠ Fix the <span title="the flows, layouts, Lightning pages and reports the tool rewrites itself — the blockers above have ✂ ⇄ ✎ 🗑 of their own">${autoCount} fixable item${autoCount === 1 ? '' : 's'}</span> below first.`
            : blockerTotal > 0
              ? '🔒 Delete is blocked until the blockers below are cleared.'
              : unread.length
                ? '🔒 The scan could not read everything — see above. Asking Salesforce whether it would accept the delete…'
              : silentManual > 0
                ? '✅ The scan lists no blocker (the references below simply go with the field).'
                : '✅ The scan lists no blocker.'}
        </div>
        <button class="btn btn-danger" id="fcDelBtn" ${delDisabled ? 'disabled' : ''}>
          🗑 Delete Field
        </button>
        ${pkgNs ? '' : '<div class="fc-ask-box" id="fcAskBox" hidden></div>'}
      </div>`;
    html = html.replace('<!--FC_GATE-->', () => gateHtml);

    results.innerHTML = html;
    if (pkgNs) checkEnableDelete();   // a packaged field: the delete stays locked and the note says why
    else if (autoCount > 0 && blockerTotal === 0 && fcScopeNorm(_lastScan && _lastScan.scope) !== 'mentions') checkEnableDelete();   // only "might break" rows may be open: see _openRowSplit
    _wireFolds(results);
    _paintFilter();
    _refreshFixEvery();   // the ⚡ row's two counts come from the rows as drawn (⇄ and ✂ differ: a formula has no ✂)

    // Wire buttons. The fix buttons are re-drawn when the mode changes or a fix
    // ends, so they are handled by ONE listener on the results area (the XML
    // inspector's own button keeps its own listener).
    if (!results.dataset.fcFixWired) {
      results.dataset.fcFixWired = '1';
      results.addEventListener('click', ev => {
        const one = ev.target.closest?.('.fc-fix-btn');
        if (one) {
          if (!one.disabled && !one.classList.contains('fc-xml-fix')) fixOne(one.dataset.type, one.dataset.id, one.dataset.name, _curFieldId, one.dataset.swap === '1', one.dataset.way || '');
          return;
        }
        const pl = ev.target.closest?.('.fc-plan-btn');
        if (pl) { if (!pl.disabled) planEverything(_curFieldId, pl.dataset.type || ''); return; }
        if (ev.target.closest?.('.fc-plan-stop')) { if (_planRun) { _planRun.stop = true; const b = ev.target.closest('.fc-plan-stop'); b.disabled = true; b.textContent = 'Stopping after this one…'; } return; }
        const fb = ev.target.closest?.('.fc-filter-btn');
        if (fb) { if (!fb.disabled) { _fcFilter = fb.dataset.filter || 'all'; _paintFilter(); } return; }
        const chip = ev.target.closest?.('.fc-blocker-chip');
        if (chip) {
          if (_fcFilter === 'later') { _fcFilter = 'all'; _paintFilter(); }   // the chip's group is a 🔒 one
          const g = eid(`fcGroup_${chip.dataset.group}`);
          if (g) { g.scrollIntoView({ behavior: 'smooth', block: 'start' }); g.classList.add('fc-group-flash'); setTimeout(() => g.classList.remove('fc-group-flash'), 1800); }
          return;
        }
      });
    }
    results.querySelectorAll('.fc-setup-btn').forEach(btn => {
      btn.addEventListener('click', () => openSetup(btn.dataset.type));
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
    _autoAsk();
    _preflight();

    runDataUsage();              // F1: fill the verdict placeholder asynchronously
    renderDeprecationZone(fieldId);  // F3: stage banner / deprecate button
    renderFlsPanel();            // F5: who can see this field
    renderReportScan();          // the opt-in report sweep
    renderOrgSweep();            // 🧭 the opt-in whole-org text sweep
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
          ? `<div class="fc-fact fc-fls-copy" id="fcFlsCopy"><span class="fc-fact-ico">🔑</span><span class="fc-fact-text"><strong>${n}</strong> of the ${rows.length} below ${n === 1 ? 'does' : 'do'} not give the same access to <code>${esc(to)}</code> yet — ${n === 1 ? 'its' : 'their'} users would not see the new field.
               </span><span class="fc-fact-act"><button class="btn btn-secondary btn-sm" id="fcFlsCopyBtn">🔑 Copy access to ${esc(to)}</button></span></div>`
          : `<div class="fc-fact fc-fls-copy fc-fls-copy-ok" id="fcFlsCopy"><span class="fc-fact-ico">🔑</span><span class="fc-fact-text">Everyone who can see <code>${esc(_selField.api)}</code> already has the same access to <code>${esc(to)}</code>.</span></div>`;
      }
    }
    el.innerHTML = `${copyHtml}
      <details class="fc-fls">
        <summary class="fc-fact"><span class="fc-fact-ico">👁</span><span class="fc-fact-text">Visible to <strong>${rows.length}</strong> profile${rows.length === 1 ? '' : 's'}/permission set${rows.length === 1 ? '' : 's'}</span><span class="fc-fact-act fc-fact-more">show</span></summary>
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

  // ── 🧭 The whole-org text sweep (opt-in) ──────────────────────────────────
  // User 2026-11-08: "מורידים דרך vcs פרויקט שלם של סילספורס ואז מחפשים שם api
  // של שדה… לחלק את זה לדברים שחייב למחוק או לשנות כדי למחוק את השדה, ודברים
  // שטוב לדעת כי הם יכולים להשבר אחר כך" — "זה חייב להיות ב-1.1" — "יהיה נחמד
  // להראות את הסריקה בלייב על המסך עם progress bar וזמן משוער לסיום".
  // The scan asks Salesforce's index and reads a known set of kinds; this reads
  // the org's own metadata as a whole (Metadata API retrieve, type by type),
  // greps every text file for the field, and classifies each hit (sftk-sweep.js):
  // 🔒 Salesforce refuses the delete for it · 👀 the delete goes through and it
  // breaks later. Never part of the scan: it runs on the button, after its cost
  // is said, with a live bar, the time left and a Stop.
  const FC_SWEEP_CHUNK = 300;           // members per retrieve: small enough for the bar to move (live npc 2026-11-08: ~11 components a second)
  const FC_SWEEP_RATE = 11;             // components per second, the planning estimate; the live rate replaces it after the first retrieve
  let _orgSweep = null;   // { status, types, listed, groups, done, total, startedAt, files, result, stop, error, notes, perType }

  function _sweepScanItems() {
    const deps = (_lastScan && _lastScan.deps) || [];
    const out = [];
    for (const d of deps) {
      const t = d.MetadataComponentType === 'Flow' && d._pb ? 'Flow' : d.MetadataComponentType;
      out.push({ type: t, name: d.MetadataComponentName || d.MetadataComponentId });
      if (t === 'LookupFilter' && d._lookupFieldName) out.push({ type: 'LookupFilter', name: `${_selObj.api}.${d._lookupFieldName}` });
    }
    return out;
  }

  function renderOrgSweep() {
    const el = eid('fcOrgSweep');
    if (!el || !_selObj || !_selField) return;
    const s = _orgSweep;
    const N = x => Number(x).toLocaleString('en-US');
    if (!s) {
      el.innerHTML = `<div class="fc-fact fc-sweep-fact"><span class="fc-fact-ico">🧭</span><span class="fc-fact-text"><b>Full metadata text scan</b> — the scan above asks Salesforce’s index and reads the kinds it knows. This retrieves the org’s own metadata as a whole, like a project pulled from version control, and finds every file that names <code>${esc(_selField.api)}</code>: what must go or change before the delete (🔒), and what only breaks later (👀) — search layouts, related-list columns, record-type picklist values, Aura markup, templates, translations, permission sets and the rest. What it finds joins the list above with ✂ ⇄ ✎ 🗑 where its kind has them. <strong>Expensive and slow:</strong> one API call per metadata type to list it, then several Metadata API retrieves — hundreds of calls and many minutes on a large org. Pressing the button only counts: the exact calls and time are shown before anything is read. Nothing is written.</span>
        <span class="fc-fact-act"><button class="btn btn-secondary btn-sm" id="fcSweepPlan" data-pkg="0" title="Your org’s own components, on standard objects and on the objects your org created. Counts the cost first.">🧭 Your objects — count the cost…</button>
        <button class="btn btn-secondary btn-sm" id="fcSweepPlanPkg" data-pkg="1" title="The same, plus the objects that came with installed packages: what YOUR org added inside them — fields, validation rules, list views, buttons, field sets, workflow and sharing rules. The package’s own parts cannot name your field. Longer in an org with big packages. Counts the cost first.">🧭 Your objects + packaged objects…</button></span></div>`;
      eid('fcSweepPlan').addEventListener('click', _sweepPlan);
      eid('fcSweepPlanPkg').addEventListener('click', _sweepPlan);
      return;
    }
    if (s.status === 'planning') {
      el.innerHTML = `<div class="fc-sweep">${sftkCatSm(`Listing the org’s metadata… ${s.planNote || ''}`)}
        <div class="fc-sweep-bar"><i style="width:${s.planTotal ? Math.round(100 * (s.planDone || 0) / s.planTotal) : 0}%"></i></div>
        <div class="fc-sweep-meta"><span>${N(s.planDone || 0)} of ${N(s.planTotal || 0)} type${s.planTotal === 1 ? '' : 's'} listed</span><span>${N(s.listedCount || 0)} component${s.listedCount === 1 ? '' : 's'} so far</span>
        <button class="btn btn-secondary btn-sm" id="fcSweepStop"${s.stop ? ' disabled' : ''}>${s.stop ? 'Stopping…' : '⏹ Stop'}</button></div></div>`;
      eid('fcSweepStop')?.addEventListener('click', () => { s.stop = true; renderOrgSweep(); });
      return;
    }
    if (s.status === 'error') {
      el.innerHTML = `<div class="fc-sweep fc-sweep-bad" title="${esc(s.error)}">🧭 Full metadata text scan — the org could not be read: ${esc(_feText(s.error))} <button class="btn btn-secondary btn-sm" id="fcSweepPlan">↻ Try again</button></div>`;
      eid('fcSweepPlan').addEventListener('click', _sweepPlan);
      return;
    }
    if (s.status === 'ready') {
      const calls = s.groups.length * 2 + s.listCalls + ((s.res && s.res.length) || 0);
      const est = s.total ? Math.max(15, Math.round(s.total / FC_SWEEP_RATE) + s.groups.length * 6) * 1000 : null;
      el.innerHTML = `<div class="fc-sweep">🧭 This org has <strong>${N(s.total)}</strong> of its own component${s.total === 1 ? '' : 's'} in <strong>${N(s.types.length)}</strong> kind${s.types.length === 1 ? '' : 's'} worth reading${s.pkg ? ` — ${N(s.pkgBoxes)} of them packaged objects and their rule files, read for what your org added inside them` : ''}${s.skippedManaged ? ` (${N(s.skippedManaged)} ${s.pkg ? 'other components' : 'components'} from installed packages left out — the platform will not let you change those${s.pkg ? '' : '; what your org added inside packaged objects is read with “+ packaged objects”'})` : ''}.
        Reading them takes <strong>${N(s.groups.length)}</strong> retrieve${s.groups.length === 1 ? '' : 's'} of the Metadata API — <strong>${N(calls)} API calls</strong> in all (${N(s.listCalls)} already spent on the listing${s.res && s.res.length ? `; ${N(s.res.length)} for the text static resources, one each` : ''}) and roughly <strong>${sftkSweepFmtMs(est)}</strong>${s.total > 3000 ? ' — a large org: expect many minutes, and the bar to stand still while a big retrieve runs' : ''}. Nothing is written.
        <div class="fc-sweep-types">${esc(s.types.map(t => `${t.name} ${N((s.listed[t.name] || []).length)}`).join(' · '))}</div>
        <button class="btn btn-primary btn-sm" id="fcSweepGo">▶ Read ${N(s.total)} component${s.total === 1 ? '' : 's'}</button>
        <button class="btn btn-secondary btn-sm" id="fcSweepCancel">Cancel</button></div>`;
      eid('fcSweepGo')?.addEventListener('click', _sweepRun);
      eid('fcSweepCancel')?.addEventListener('click', () => { _orgSweep = null; renderOrgSweep(); });
      return;
    }
    if (s.status === 'running') {
      const g = s.groups[s.groupIdx] || [];
      const gN = g.reduce((k, t) => k + (t.extra ? 0 : t.members.length), 0);
      const rate = s.done && s.startedAt ? s.done / Math.max(1, (Date.now() - s.startedAt) / 1000) : FC_SWEEP_RATE;
      const expectMs = Math.max(8000, (gN / rate) * 1000 + 6000);
      const inGroup = s.groupStartedAt && !s.reading ? Math.min(0.9, (Date.now() - s.groupStartedAt) / expectMs) : (s.reading ? 0.95 : 0);
      const doneLike = s.done + gN * inGroup;
      const pct = s.total ? Math.min(99, Math.round(100 * doneLike / s.total)) : 0;
      const planMs = (s.total / FC_SWEEP_RATE + s.groups.length * 6) * 1000;
      const elapsed = Date.now() - (s.startedAt || Date.now());
      let eta;
      if (!s.done) eta = Math.max(0, planMs - elapsed);
      else {
        // each retrieve costs an overhead plus its members at the observed rate
        const OVER = 6000;
        const liveRate = Math.max(2, s.done / Math.max(1, (elapsed - s.groupIdx * OVER) / 1000));
        let left = 0;
        for (let i = s.groupIdx; i < s.groups.length; i++) { const m = s.groups[i].reduce((k, t) => k + (t.extra ? 0 : t.members.length), 0); left += OVER + (m / liveRate) * 1000; }
        left -= (s.groupStartedAt ? Date.now() - s.groupStartedAt : 0);
        eta = Math.max(0, Math.min(left, planMs * 3));
      }
      // Salesforce reports nothing about a retrieve until it lands — a big one (every CustomObject) takes minutes
      // with the bar standing still; the line says how long this one has run so it never looks stuck
      const inRet = s.current && s.groupStartedAt ? Date.now() - s.groupStartedAt : 0;
      const cur = s.current ? `retrieving ${esc(s.current)}…${inRet > 15000 ? ` ${sftkSweepFmtMs(inRet)} in this retrieve — Salesforce says nothing until it lands; a big one takes minutes` : ''}` : (s.reading ? 'reading the files…' : 'waiting for Salesforce…');
      el.innerHTML = `<div class="fc-sweep">${sftkCatSm(`Reading the org… ${cur}`)}
        <div class="fc-sweep-bar"><i style="width:${pct}%"></i></div>
        <div class="fc-sweep-meta"><span><b>${pct}%</b> · ${N(s.done)} of ${N(s.total)} components</span><span>retrieve ${N(Math.min(s.groupIdx + 1, s.groups.length))} of ${N(s.groups.length)}</span><span>${N(s.filesRead || 0)} files read</span><span><b>${sftkSweepFmtMs(eta)}</b> left${s.done ? '' : ' (estimated)'}</span>
        <button class="btn btn-secondary btn-sm" id="fcSweepStop"${s.stop ? ' disabled' : ''}>${s.stop ? 'Stopping after this retrieve…' : '⏹ Stop'}</button></div></div>`;
      eid('fcSweepStop')?.addEventListener('click', () => { s.stop = true; renderOrgSweep(); });
      clearTimeout(s._tick); s._tick = setTimeout(() => { if (_orgSweep === s && s.status === 'running') renderOrgSweep(); }, 1000);
      return;
    }
    // done / stopped
    const r = s.result || { byType: {}, hits: [], filesRead: 0, filesWithHits: 0 };
    const all = s.status === 'done';
    const types = Object.entries(r.byType);
    const lock = types.filter(([, t]) => t.sev === 'blocker'), eye = types.filter(([, t]) => t.sev !== 'blocker');
    const count = list => list.reduce((n, [, t]) => n + t.items.length, 0);
    const cmp = s.compare || { known: 0, fresh: 0 };
    const took = s.finishedAt && s.startedAt ? sftkSweepFmtMs(s.finishedAt - s.startedAt) : '';
    const shown = t => t.items.filter(it => !it.inScan && !it.joined);   // listed here: only what the list above does not carry
    const item = (type, it) => {
      const hl = t => esc(t).replace(new RegExp(`(${_selField.api.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\  // ── 📊 The report sweep (opt-in) ─────────────────────────────────────────')})`, 'gi'), '<mark>$1</mark>');
      const lines = it.lines.slice(0, 6).map(l => `<span class="ln">${l.file ? esc(l.file) + ':' : ''}${l.line}</span>${hl(l.text)}`).join('\n') + (it.lines.length > 6 ? `\n<span class="ln"></span>… ${it.lines.length - 6} more line${it.lines.length - 6 === 1 ? '' : 's'}` : '');
      return `<div class="fc-sweep-item"><div class="fc-sweep-item-hd"><code>${esc(it.component)}</code>${it.section ? `<span class="ds-subtext">${esc(it.section)}</span>` : ''}${type === 'DocText' ? `<span class="fc-sweep-inscan" title="Plain text only — Salesforce does not read it as a reference; the delete goes through with it in place">nothing to do</span>` : `<span class="fc-sweep-inscan" title="No kind in the list above fixes this one — change it in Setup or in your project, then scan again">by hand</span>`}<span class="fc-sweep-path">${esc(it.path)}</span></div><pre class="fc-sweep-lines">${lines}</pre></div>`;
    };
    const compact = new Set(['Profile', 'PermissionSet']);
    const group = (type, t) => shown(t).length ? `<div class="fc-sweep-grp"><div class="fc-sweep-grp-hd"><span>${t.sev === 'blocker' ? '🔒' : '👀'} ${esc(t.label)}</span><span class="fc-sweep-grp-n">${N(shown(t).length)}</span></div>
        ${t.why ? `<div class="fc-sweep-why">${esc(t.why)}</div>` : ''}${compact.has(type)
          ? `<div class="fc-sweep-item"><div class="fc-sweep-item-hd">${shown(t).map(it => `<code>${esc(decodeURIComponent(it.component))}</code>`).join(' ')}</div></div>`
          : shown(t).map(it => item(type, it)).join('')}</div>` : '';
    const nJoined = s.joined || 0, nHere = types.reduce((n, [, t]) => n + shown(t).length, 0);
    el.innerHTML = `<div class="fc-sweep ${all ? 'fc-sweep-ok' : 'fc-sweep-bad'}">🧭 <strong>Full metadata text scan${all ? '' : ' — STOPPED'}:</strong> ${N(r.filesRead)} file${r.filesRead === 1 ? '' : 's'} of ${N(s.done)} component${s.done === 1 ? '' : 's'} read${all ? '' : ` (of ${N(s.total)} — the rest were NOT read)`}${took ? ` in ${took}` : ''}; <strong>${N(r.filesWithHits)}</strong> name${r.filesWithHits === 1 ? 's' : ''} <code>${esc(_selObj.api)}.${esc(_selField.api)}</code>.
        <div class="fc-sweep-sum"><span class="fc-sweep-pill fc-sweep-pill-lock">🔒 ${N(count(lock))} must go or change before the delete</span><span class="fc-sweep-pill fc-sweep-pill-eye">👀 ${N(count(eye))} will break or lose the field</span><span class="ds-subtext">${cmp.known ? `${N(cmp.known)} already in the list above · ` : ''}${nJoined ? `<strong>${N(nJoined)} joined the list above</strong> with the ✂ ⇄ ✎ 🗑 of their kind · ` : ''}${nHere ? `${N(nHere)} below, by hand` : (types.length ? 'nothing left for the hand' : '')}</span><button type="button" class="btn btn-secondary btn-sm" id="fcSweepCsv" title="Every line that names the field — kind, 🔒/👀, component, path, line, text — as a CSV">⬇ Export CSV</button></div>
        ${s.notes.length ? `<div class="fc-sweep-why">${s.notes.map(n => `ℹ ${esc(n)}`).join('<br>')}</div>` : ''}
        ${lock.map(([ty, t]) => group(ty, t)).join('')}${eye.map(([ty, t]) => group(ty, t)).join('')}
        <div class="fc-repl-sub">Kinds not read: static resources, documents, content and site assets (binary or bulky), settings, certificates, and anything installed from a managed package. <button class="fc-dd-linkbtn" id="fcSweepPlan">↻ Read again</button></div></div>`;
    eid('fcSweepPlan')?.addEventListener('click', _sweepPlan);
    eid('fcSweepCsv')?.addEventListener('click', () => {
      const csv = sftkSweepCsv(r, _selObj.api, _selField.api);
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${_selObj.api}.${_selField.api}-metadata-text-scan-${r.hits.length}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    });
  }

  // The sweep's fresh hits JOIN the list (user 2026-11-08: "Can we do a remove and replace on them as well?" and
  // "this table should not list whats in the other sheet"): a hit the everyday scan did not list, of a kind the
  // list fixes by full name (or by a Tooling id a name lookup gives), becomes an ordinary row there with the ways
  // of its kind — ✂ ⇄ ✎ 🗑, a restore point, the verify. The rest stay in the sweep's box, marked "by hand".
  async function _sweepJoin(s) {
    if (!s || !s.result || !_lastScan) return 0;
    const field = `${_selObj.api}.${_selField.api}`;
    const have = new Set((_lastScan.deps || []).filter(d => d._sweep).map(d => `${d.MetadataComponentType}|${d._fullName}`));
    const rows = [];
    for (const [type, t] of Object.entries(s.result.byType)) {
      const kind = typeof sftkSweepJoinKind === 'function' ? sftkSweepJoinKind(type) : null;
      if (!kind || !TYPE_CFG[kind]) continue;
      for (const it of t.items) {
        if (it.inScan || it.joined) continue;
        if (have.has(`${kind}|${it.component}`)) { it.joined = true; continue; }
        let id = `sweep_${kind}_${String(it.component).replace(/[^A-Za-z0-9_]/g, '_')}`;
        const q = typeof sftkSweepIdQuery === 'function' ? sftkSweepIdQuery(kind, it.component) : null;
        if (q) {   // a code kind is read by its Tooling id
          const r = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true, _suppressError: true, query: q });
          const rec = r && !r.error ? (r.records || [])[0] : null;
          if (!rec || !rec.Id) continue;   // not found by name: stays in the box, by hand
          id = rec.Id;
        }
        it.joined = true;
        rows.push({ MetadataComponentId: id, MetadataComponentName: it.component, MetadataComponentType: kind,
          RefMetadataComponentId: null, RefMetadataComponentName: field, _supplemental: true, _sweep: true, _fullName: it.component, _sweepLines: it.lines });
      }
    }
    if (rows.length) _lastScan.deps = [..._lastScan.deps, ...rows];
    return rows.length;
  }

  // Step 1 — the plan: describeMetadata, then listMetadata per type (folder
  // kinds folder by folder), so the cost is exact before anything is retrieved.
  // Two scopes (user 2026-11-11: "אנחנו צריכים להציע סריקה כזו, אובייקטים רגילים או אובייקטים רגילים וחבילתיים"). A
  // packaged object used to be left out whole — with it went what the org itself had added INSIDE it (its file holds
  // the org's fields, validation rules, list views, buttons and field sets next to the package's). With the wider
  // scope the packaged objects are named in the retrieve, like the standard ones; so are their workflow and sharing
  // rule files. A package's own parts cannot name a field of the org, so a hit in such a file is the org's own.
  let _sweepPkg = false;
  const _SWEEP_PKG_BOXES = new Set(['CustomObject', 'Workflow', 'SharingRules']);
  async function _sweepPlan(ev) {
    const asked = ev && ev.currentTarget && ev.currentTarget.dataset ? ev.currentTarget.dataset.pkg : undefined;
    if (asked === '1' || asked === '0') _sweepPkg = asked === '1';
    const s = _orgSweep = { status: 'planning', planDone: 0, planTotal: 0, listedCount: 0, stop: false, notes: [], listCalls: 0, skippedManaged: 0, pkg: _sweepPkg, pkgBoxes: 0 };
    renderOrgSweep();
    const fail = why => { if (_orgSweep === s) { _orgSweep = { status: 'error', error: why }; renderOrgSweep(); } };
    const d = await bg({ type: 'SF_MD_DESCRIBE', orgUrl: _orgUrl, sid: _sid, _suppressError: true });
    if (_orgSweep !== s) return;
    if (!d || d.error) return fail((d && d.error) || 'describeMetadata gave no answer');
    s.listCalls++;
    const types = sftkSweepTypes(sftkSweepParseDescribe(d.text));
    s.planTotal = types.length;
    const listed = {};
    // standard objects are not under CustomObject's wildcard: the field's object and every customizable standard object the org describes
    let stdObjects = [_selObj.api];
    try {
      const g = await bg({ type: 'SF_REST_GET', orgUrl: _orgUrl, sid: _sid, _suppressError: true, _silentError: true, path: 'services/data/v62.0/sobjects' });
      if (g && Array.isArray(g.sobjects)) stdObjects = [...new Set([_selObj.api, ...g.sobjects.filter(o => o && !o.custom && o.layoutable && !o.customSetting && !/__(History|Share|Feed|Tag|ChangeEvent)$/.test(o.name)).map(o => o.name)])];
    } catch (_) {/* the field's object alone */}
    for (const t of types) {
      if (s.stop || _orgSweep !== s) { if (_orgSweep === s) { _orgSweep = null; renderOrgSweep(); } return; }
      s.planNote = t.name;
      renderOrgSweep();
      const members = [];
      const take = items => { for (const it of items) {
        if (!sftkSweepOwn(it)) { if (s.pkg && _SWEEP_PKG_BOXES.has(t.name)) { members.push(it.fullName); s.pkgBoxes++; } else s.skippedManaged++; continue; }
        members.push(it.fullName);
      } };
      if (t.how === 'folders') {
        const f = await bg({ type: 'SF_MD_LIST', orgUrl: _orgUrl, sid: _sid, mdType: t.folderType, _suppressError: true });
        s.listCalls++;
        if (f && !f.error) {
          const folders = sftkSweepParseList(f.text).filter(sftkSweepOwn).map(x => x.fullName);
          members.push(...folders.map(x => x));   // the folders themselves ride along (harmless, they are tiny)
          for (const folder of folders) {
            if (s.stop) break;
            const r = await bg({ type: 'SF_MD_LIST', orgUrl: _orgUrl, sid: _sid, mdType: t.name, folder, _suppressError: true });
            s.listCalls++;
            if (r && !r.error) take(sftkSweepParseList(r.text));
          }
          const r0 = await bg({ type: 'SF_MD_LIST', orgUrl: _orgUrl, sid: _sid, mdType: t.name, folder: 'unfiled$public', _suppressError: true });
          s.listCalls++;
          if (r0 && !r0.error) take(sftkSweepParseList(r0.text));
        } else s.notes.push(`${t.name}: its folders could not be listed (${_feText((f && f.error) || 'no answer')}) — not read.`);
      } else {
        const r = await bg({ type: 'SF_MD_LIST', orgUrl: _orgUrl, sid: _sid, mdType: t.name, _suppressError: true });
        s.listCalls++;
        if (r && !r.error) take(sftkSweepParseList(r.text));
        else if (r && /INVALID_TYPE|not supported|Cannot use/i.test(String(r.error))) { /* a type this org does not have: nothing to say */ }
        else s.notes.push(`${t.name}: could not be listed (${_feText((r && r.error) || 'no answer')}) — not read.`);
        if (t.name === 'CustomObject') for (const o of stdObjects) if (!members.includes(o)) members.push(o);
      }
      if (members.length) { listed[t.name] = [...new Set(members)]; s.listedCount += listed[t.name].length; }
      s.planDone++;
    }
    if (_orgSweep !== s) return;
    // the org's own TEXT static resources — the retrieve leaves the kind out (images, fonts, zips); listed here so
    // the price shown before the read counts them (one call each)
    {
      const q = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: false, _suppressError: true, _silentError: true, query: 'SELECT Id, Name, ContentType, BodyLength, NamespacePrefix FROM StaticResource WHERE NamespacePrefix = null' });
      if (_orgSweep !== s) return;
      s.listCalls++;
      if (!q || q.error) { s.res = []; s.resOwn = 0; s.notes.push(`Static resources: could not be listed (${_feText((q && q.error) || 'no answer')}) — not read.`); }
      else { s.resOwn = (q.records || []).length; s.res = (q.records || []).filter(sftkSweepTextResource).map(r => ({ Id: r.Id, Name: r.Name })); }
    }
    const groups = sftkSweepChunks(listed, FC_SWEEP_CHUNK);
    // The Metadata API writes a profile's or permission set's field lines only for objects in the SAME
    // retrieve (live 2026-11-08: 44 profiles found in one retrieve, 0 once Profile travelled alone) — so the
    // field's object rides along with them; the same file twice is read once.
    for (const g of groups) if (g.some(t => t.name === 'Profile' || t.name === 'PermissionSet') && !g.some(t => t.name === 'CustomObject' && t.members.includes(_selObj.api))) g.push({ name: 'CustomObject', members: [_selObj.api], extra: true });
    const total = Object.values(listed).reduce((n, m) => n + m.length, 0);
    Object.assign(s, { status: 'ready', types: types.filter(t => listed[t.name]), listed, groups, total, done: 0, groupIdx: 0, filesRead: 0, files: new Map() });
    renderOrgSweep();
  }

  // Step 2 — the retrieves, one group at a time: start, poll, unzip, grep.
  async function _sweepRun() {
    const s = _orgSweep;
    if (!s || s.status !== 'ready') return;
    s.status = 'running'; s.startedAt = Date.now(); s.stop = false;
    renderOrgSweep();
    const forms = sftkSweepForms(_selObj.api, _selField.api);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (s.groupIdx = 0; s.groupIdx < s.groups.length; s.groupIdx++) {
      if (s.stop || _orgSweep !== s) break;
      const g = s.groups[s.groupIdx];
      const n = g.reduce((k, t) => k + (t.extra ? 0 : t.members.length), 0);
      s.current = g.map(t => t.name).slice(0, 3).join(', ') + (g.length > 3 ? ` +${g.length - 3}` : '');
      s.groupStartedAt = Date.now();
      renderOrgSweep();
      const st = await bg({ type: 'SF_MD_RETRIEVE_START', orgUrl: _orgUrl, sid: _sid, types: g, _suppressError: true });
      if (_orgSweep !== s) return;
      if (!st || st.error || !st.id) { s.notes.push(`${s.current}: the retrieve did not start (${_feText((st && st.error) || 'no answer')}) — those ${n} were NOT read.`); continue; }
      let r = null;
      for (let i = 0; i < 600; i++) {
        await sleep(i < 5 ? 1500 : 3000);
        if (_orgSweep !== s) return;
        r = await bg({ type: 'SF_MD_RETRIEVE_STATUS', orgUrl: _orgUrl, sid: _sid, id: st.id, _suppressError: true });
        if (!r || r.error) { s.notes.push(`${s.current}: the retrieve could not be checked (${_feText((r && r.error) || 'no answer')}) — ${n} NOT read.`); r = null; break; }
        if (r.done) break;
      }
      if (!r) continue;
      if (r.status !== 'Succeeded' || !r.zipBase64) { s.notes.push(`${s.current}: the retrieve ${r.status === 'Failed' ? 'failed' : 'ended without a zip'}${r.errorMessage ? ` — ${_feText(r.errorMessage)}` : ''}; ${n} NOT read.`); continue; }
      s.reading = true; s.current = ''; renderOrgSweep();
      try {
        const files = await sftkUnzip(sftkBase64ToBytes(r.zipBase64));
        for (const [p, t] of files) s.files.set(p, t);
        s.filesRead += files.size;
      } catch (e) { s.notes.push(`${g.map(t => t.name).join(', ')}: the zip could not be read (${_feText(e && e.message || e)}) — ${n} NOT read.`); }
      s.reading = false;
      s.done += n;
      renderOrgSweep();
    }
    if (_orgSweep !== s) return;
    // the org's own TEXT static resources — the retrieve leaves the kind out (images, fonts, zips)
    if (!s.stop && s.res && s.res.length) {
      s.current = 'static resources'; renderOrgSweep();
      let read = 0, bad = 0;
      for (const r of s.res) {
        if (s.stop || _orgSweep !== s) break;
        const b = await bg({ type: 'SF_REST_GET_TEXT', orgUrl: _orgUrl, sid: _sid, _suppressError: true, _silentError: true, path: `services/data/v62.0/sobjects/StaticResource/${r.Id}/Body` });
        if (b && !b.error && typeof b.text === 'string') { s.files.set(`unpackaged/staticresources/${r.Name}.resource`, b.text); read++; } else bad++;
      }
      if (_orgSweep !== s) return;
      s.filesRead += read;
      s.notes.push(`Static resources: ${read} of ${s.resOwn} read as text${s.resOwn - s.res.length ? ` (${s.resOwn - s.res.length} left out: images, fonts, zips, or over 1 MB)` : ''}${bad ? ` — ${bad} could NOT be read` : ''}.`);
      s.current = '';
    } else if (!s.stop && s.resOwn) s.notes.push(`Static resources: none of the ${s.resOwn} is a text file (images, fonts, zips, or over 1 MB) — none read.`);
    s.result = sftkSweepRun(s.files, forms);
    s.compare = sftkSweepCompare(s.result.byType, _sweepScanItems());
    s.finishedAt = Date.now();
    s.status = (s.done === s.total && !s.stop) ? 'done' : 'stopped';
    s.files = new Map();   // the texts are in the result's lines; the whole org need not stay in memory
    renderOrgSweep();
    // the fresh hits of a fixable kind join the list above, which is drawn again (and this box with it)
    s.joined = await _sweepJoin(s);
    if (_orgSweep !== s) return;
    if (s.joined) await renderResults(_lastScan.deps, _lastScan.fieldId); else renderOrgSweep();
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
  let _rtScanned = null;  // how many custom report types the scan's own leg read (every scan reads them all)

  function renderReportScan() {
    const el = eid('fcRptScan');
    if (!el || !_selObj || !_selField) return;
    const s = _rptScan;
    const N = x => Number(x).toLocaleString('en-US');
    const link = r => `<a href="${esc(`${_orgUrl.replace(/\/$/, '')}/lightning/r/Report/${r.Id}/view`)}" target="_blank" rel="noopener">${esc(r.Name || r.Id)}</a>`;
    if (!s) {
      const listed = ((_lastScan && _lastScan.deps) || []).filter(d => d.MetadataComponentType === 'Report').length;
      el.innerHTML = `<div class="fc-fact fc-rpt"><span class="fc-fact-ico">📊</span><span class="fc-fact-text"><b>Reports</b> — ${listed
          ? `Salesforce’s index listed ${N(listed)} above; it does not list every report in every org.`
          : 'Salesforce’s index listed none; in some orgs it lists none at all.'}
        To be sure, this tool can read every report’s definition itself.${_rtScanned != null ? (() => { const rt = ((_lastScan && _lastScan.deps) || []).filter(d => d.MetadataComponentType === 'ReportType').length; return ` <b>Report types</b>: the scan itself read all ${N(_rtScanned)} custom report type${_rtScanned === 1 ? '' : 's'} of this org${rt ? ` — ${N(rt)} name${rt === 1 ? 's' : ''} the field and ${rt === 1 ? 'is' : 'are'} listed above` : ' — none names the field'}.`; })() : ''}</span>
        <span class="fc-fact-act"><button class="btn btn-secondary btn-sm" id="fcRptCount">📊 Scan the reports…</button></span></div>`;
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
      // a fixed flow card stands for every version of that flow the index listed
      for (const c of _flowCards) if (fixed.has(c.primaryId)) c.versions.forEach(v => fixed.add(v.id));
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
      el.innerHTML = `<div class="fc-fact fc-copy"><span class="fc-fact-ico">📦</span><span class="fc-fact-text"><b>Stored values</b> cannot be copied: <code>${esc(to)}</code> cannot be written (a formula or read-only field).</span></div>`;
      return;
    }
    if (_copyState && _copyState.to === to && _copyState.from === from) { _renderCopyPlan(); return; }
    _copyState = null;
    const known = _dataVerdict && !_dataVerdict.sampled && !_dataVerdict.formula;
    const filled = known ? _dataVerdict.filled : null;
    if (filled === 0) {
      el.innerHTML = `<div class="fc-fact fc-copy fc-copy-ok"><span class="fc-fact-ico">📦</span><span class="fc-fact-text"><code>${esc(from)}</code> holds no values — nothing to copy to <code>${esc(to)}</code>.</span></div>`;
      return;
    }
    const calls = filled != null ? Math.max(1, Math.ceil(filled / 2000)) : null;
    el.innerHTML = `<div class="fc-fact fc-copy"><span class="fc-fact-ico">📦</span><span class="fc-fact-text"><b>Stored values</b> — ${filled != null
        ? `<strong>${filled.toLocaleString('en-US')}</strong> record${filled === 1 ? '' : 's'} hold${filled === 1 ? 's' : ''} a value in <code>${esc(from)}</code>.`
        : `how many records hold a value in <code>${esc(from)}</code> is not measured yet.`}
      Replace moves references only: copy the values to <code>${esc(to)}</code> before the field is deleted.</span>
      <span class="fc-fact-act"><button class="btn btn-secondary btn-sm" id="fcCopyCompare">📦 Compare the two fields${calls ? ` (≈${calls.toLocaleString('en-US')} API call${calls === 1 ? '' : 's'})` : ''}</button></span></div>`;
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
      if (r.capped && r.unfiltered) throw new Error(`more than ${FC_COPY_CAP.toLocaleString('en-US')} records, and this field type cannot be filtered in a query — copy the values with Data Loader instead`);
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
    const N = x => Number(x).toLocaleString('en-US');
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
    const N = x => Number(x).toLocaleString('en-US');
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
        html: `Writes <strong>${esc(obj)}.${esc(to)}</strong> on ${N(targets.length)} record${targets.length === 1 ? '' : 's'}; <strong>${esc(from)}</strong> is not changed.` +
          '<div class="sftk-cf-plan"><ol class="sftk-cf-rows">' +
          '<li><b>Saved as</b><span>Any edit: the object’s flows, triggers, validation and duplicate rules run; last-modified changes</span></li>' +
          '<li><b>Refused</b><span>A record Salesforce refuses is reported with the reason and left as it is</span></li>' +
          '<li><b>Undo</b><span>' + (undoable ? '🧾 Activity (top bar) can take this copy back' : `Larger than ${N(FC_COPY_UNDO)} records, so Activity keeps no undo — the receipt below is the way back`) + '</span></li></ol></div>',
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
        : { none: (wr && wr.accepted && wrote.length) ? `more than ${N(FC_COPY_UNDO)} records were written — Activity keeps no undo at that size; the receipt CSV lists every record and what ${to} held before` : 'nothing was accepted by Salesforce, so there is nothing to undo' } });
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
      revOverride: { html: `Gives each of these the access to <strong>${esc(obj)}.${esc(to)}</strong> that it has to ${esc(obj)}.${esc(from)}${_replReadOnly() ? ' (read only — the new field cannot be edited)' : ''}.` +
          '<div class="sftk-cf-plan"><ol class="sftk-cf-rows">' +
          '<li><b>Not touched</b><span>Access is only added: nothing is lowered or removed</span></li>' +
          '<li><b>Undo</b><span>🧾 Activity (top bar) can take it back</span></li></ol></div>', needsCheckbox: false },
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
      // 2026-11-14 (QA): no grant at all to strip read as "0 access grant(s)
      // stripped" — say plainly that nobody had access instead.
      el.innerHTML = `
        <div class="fc-dep-banner">
          🕐 <strong>Deprecated ${days === 0 ? 'today' : days + ' day(s) ago'}</strong> —
          label renamed and ${dep.fls.length || (dep.flsFailed || []).length ? `${dep.fls.length} access grant(s) stripped` : 'no profile or permission set had access to the field, so no access grant needed stripping'}${(dep.flsFailed || []).length ? ` — ⚠ ${dep.flsFailed.length} could NOT be: ${esc(dep.flsFailed.map(x => x.who).join(', '))} (a Salesforce-managed permission set cannot be edited; the field stays visible there)` : ''}. No complaints so far?
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
        <div class="fc-fact fc-dep-offer"><span class="fc-fact-ico">🕐</span>
          <span class="fc-fact-text"><b>Not sure it's unused?</b> Deprecate renames the label to <code>zz_DEPRECATED…</code> and hides the field from everyone; delete or undo later with one click.</span>
          <span class="fc-fact-act"><button class="btn btn-secondary btn-sm" id="fcDepBtn">Deprecate first</button></span></div>`;
      eid('fcDepBtn')?.addEventListener('click', async e => {
        const btn = e.currentTarget;
        const gate = await sftkOrgWriteGate(_orgUrl);
        const sure = await sftkConfirmDestructive({
          title: 'Deprecate field',
          icon: '🕐',
          items: [{ label: `${_selObj.api}.${_selField.api}`, sub: _selField?.type }],
          revOverride: { html: 'Renames the label to <code>zz_DEPRECATED…</code> and hides the field from everyone.' +
            '<div class="sftk-cf-plan"><ol class="sftk-cf-rows">' +
            '<li><b>Then</b><span>Wait for complaints, then delete (or undo) with one click</span></li>' +
            '<li><b>Undo</b><span>Fully reversible with ↩ Undo deprecation</span></li></ol></div>', needsCheckbox: false },
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
  let _dataVerdict = null;   // { fillPct, filled, total, lastIso, formula, sampled, bool } | null
  // Audit 2026-11-07 (user: "אני לא בטוח שהוא קלט נכון כמה רשומות משתמשות בשדה"): three ways the
  // number could be wrong, each closed here —
  //   • a race: pick field A, then B before A's count is back → A's numbers under B. Every run
  //     carries a token; a count that comes back for an earlier pick is dropped.
  //   • a formula / roll-up / auto-number: describe never says "formula" in `type` (it says
  //     string/double with calculated:true), so the old test missed it and the field was counted
  //     (or sampled) as if it stored data. `calculated` and `autoNumber` are read now.
  //   • a checkbox is never null — COUNT(field) equals COUNT(Id) on every org, "100% populated" for
  //     a box nobody ticks. A checkbox is counted by how many records have it TICKED.
  let _dataRun = 0;
  async function runDataUsage() {
    _dataVerdict = null;
    const run = ++_dataRun, stale = () => run !== _dataRun;
    const el = () => eid('fcDataVerdict');
    if (!el() || !_selObj?.api || !_selField?.api) return;
    const obj = _selObj.api, fld = _selField.api, d = _selField.desc || {};

    // Formula / roll-up / auto-number fields never "store" editable data.
    if (d.calculated || d.autoNumber || /formula|roll-?up|summary|auto\s*number|calculated/i.test(_selField.type || '')) {
      _dataVerdict = { formula: true };
      _renderDataVerdict();
      return;
    }

    const isBool = (d.type || _selField.type) === 'boolean';
    const agg = isBool
      ? await (async () => {
          const t = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: false, query: `SELECT COUNT(Id) tot FROM ${obj}` });
          if (t.error) return t;
          const n = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: false, query: `SELECT COUNT(Id) filled FROM ${obj} WHERE ${fld} = true` });
          if (n.error) return n;
          return { records: [{ tot: (t.records || [])[0]?.tot, filled: (n.records || [])[0]?.filled }] };
        })()
      : await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: false,
          query: `SELECT COUNT(Id) tot, COUNT(${fld}) filled FROM ${obj}` });
    if (stale()) return;

    if (agg.error) {
      // Aggregation not supported (formula/encrypted/long-text) or timeout →
      // sample fallback: read a slice and estimate the fill rate.
      if (/aggregate|group by|not supported|COUNT|encrypted/i.test(agg.error)) {
        return _sampleDataUsage(obj, fld, run);
      }
      if (/timeout|time limit|too many/i.test(agg.error)) {
        return _sampleDataUsage(obj, fld, run);
      }
      const fe = sftkFriendlyError(agg.error, { where: 'field-cleaner' });  // FLS-aware hint (2026-11-14)
      const e = el(); if (e) { e.className = 'fc-data-verdict'; e.title = fe.raw; e.textContent = `📊 Couldn't measure field usage: ${fe.message}${fe.hint ? ' — ' + fe.hint : ''}`; }
      return;
    }

    const rec    = (agg.records || [])[0] || {};
    const total  = Number(rec.tot)    || 0;
    const filled = Number(rec.filled) || 0;
    let lastIso = null;
    if (filled > 0) {
      const mx = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: false,
        query: `SELECT MAX(LastModifiedDate) m FROM ${obj} WHERE ${fld} ${isBool ? '= true' : '!= null'}` });
      if (stale()) return;
      lastIso = (mx.records || [])[0]?.m || null;
    }
    _dataVerdict = {
      filled, total, lastIso, sampled: false, bool: isBool,
      fillPct: total > 0 ? (filled / total * 100) : 0,
    };
    _renderDataVerdict();
  }

  async function _sampleDataUsage(obj, fld, run) {
    const el = eid('fcDataVerdict');
    const q = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: false,
      query: `SELECT ${fld} FROM ${obj} LIMIT 5000` });
    if (run !== undefined && run !== _dataRun) return;   // a later pick replaced this one
    if (q.error) {
      const fe = sftkFriendlyError(q.error, { where: 'field-cleaner' });  // FLS-aware hint (2026-11-14)
      if (el) { el.className = 'fc-data-verdict'; el.title = fe.raw; el.textContent = `📊 Couldn't measure field usage: ${fe.message}${fe.hint ? ' — ' + fe.hint : ''}`; }
      return;
    }
    const rows = q.records || [];
    const filled = rows.filter(r => r[fld] != null && r[fld] !== '').length;
    // 2026-11-14 (release QA): a sample that reached the LIMIT is not the whole table — 'last value written never'
    // and SAFE were claims about every record from the first 5,000 alone. partial says so to the verdict.
    _dataVerdict = {
      filled, total: rows.length, lastIso: null, sampled: true, partial: rows.length >= 5000,
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
    // 2026-11-14 (release QA): a partial sample (the first 5,000 rows, no order) never reads SAFE or 'never' — the
    // field may hold values on the records past it. Under 5,000 rows the sample IS the table, so both still hold.
    const partial = !!(v.sampled && v.partial);
    const safe = pctFilled < 1 && !partial;   // <1% populated ⇒ effectively unused
    const ageStr = v.lastIso
      ? _relAge(v.lastIso)
      : partial ? 'unknown (only a sample was read)'
      : (v.filled === 0 ? 'never' : 'unknown');
    // QA 2026-10-06: this read "Empty on 99.9% of 8 of 10,266 records" — the
    // percentage is of ALL records, the count is how many hold a value. Two
    // facts, said as two facts.
    const scope = `${v.total.toLocaleString('en-US')} ${v.sampled ? 'sampled' : 'records'}`;
    const holders = v.bool
      ? (v.filled === 0 ? 'none is ticked' : `${v.filled.toLocaleString('en-US')} ${v.filled === 1 ? 'is' : 'are'} ticked`)
      : v.filled === 0 ? 'none holds a value'
      : `${v.sampled ? '~' : ''}${v.filled.toLocaleString('en-US')} hold${v.filled === 1 && !v.sampled ? 's' : ''} a value`;
    // Never round UP to 100% / down to 0% unless the value is truly there —
    // "100% empty" on a field that still holds 12 values would be a lie.
    const pctStr = p => (p >= 99.95 && p < 100) ? '99.9'
                      : (p > 0 && p < 0.05) ? '0.1'
                      : p.toFixed(p > 99 || p < 1 ? 1 : 0);
    el.className = `fc-fact fc-data-verdict ${safe ? 'fc-data-safe' : 'fc-data-caution'}`;
    el.innerHTML = `
      <span class="fc-fact-ico">${safe ? '✅' : '⚠'}</span>
      <span class="fc-fact-text"><span class="fc-data-badge">${safe ? 'SAFE' : partial && pctFilled < 1 ? 'SAMPLE ONLY' : 'CAUTION'}</span>
        ${safe || (partial && pctFilled < 1)
          ? `${v.bool ? 'Unticked' : 'Empty'} on <strong>${pctStr(emptyPct)}%</strong> of ${scope} · ${holders}`
          : `${v.bool ? 'Ticked' : 'Populated'} on <strong>${pctStr(pctFilled)}%</strong> of ${scope} · ${holders}`}
        · last value written <strong>${ageStr}</strong>${v.sampled ? ' <em>(sampled)</em>' : ''}${partial ? ' · the records past the sample were not read' : ''}
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
      let r = null;
      for (let t = 0; t < 2 && (!r || r.error); t++) r = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true, _suppressError: true,
        query: `SELECT Id, DefinitionId, VersionNumber, Status, ProcessType FROM Flow WHERE Id IN (${lit})` });
      // Unread → a Process Builder process would pass for a flow and ✂ would rewrite it (QA 2026-11-11). Said in the
      // gate; Delete stays locked until a re-scan reads them.
      if ((!r || r.error) && _lastScan) {
        _lastScan.unread = _lastScan.unread || [];
        if (!_lastScan.unread.some(u => u.leg === 'flow versions')) _lastScan.unread.push({ leg: 'flow versions', why: `their number, state and kind (flow or Process Builder) could not be read — ${String((r && r.error) || 'no answer').slice(0, 140)}. Do not fix a flow from this list; re-scan first.` });
      }
      for (const v of (r?.records || [])) {
        // ProcessType 'Workflow' is a Process Builder process: the index lists
        // it as a Flow and it blocks the delete like one (live 2026-11-06),
        // but the flow fix must not rewrite it — it is left to Setup. So are
        // InvocableProcess and CustomEvent (2026-11-14): the invocable and the
        // platform-event kinds of Process Builder, as sftkFlowKindOf names them.
        _flowVerInfo[String(v.Id).substring(0, 15)] = { defId: v.DefinitionId, num: Number(v.VersionNumber) || 0, status: v.Status || '', pb: v.ProcessType === 'Workflow' || v.ProcessType === 'InvocableProcess' || v.ProcessType === 'CustomEvent' };
      }
    }
  }

  // One card for ONE flow: its name, the buttons, and what happens to each of
  // its versions that mention the field (sftkFlowCardLines).
  function _flowVersHtml(c) {
    return sftkFlowCardLines(c.versions, { swapTo: _replOn() ? _replField.api : '' }).lines
      .map(l => `<li class="fc-ver" title="${esc(l.text)}"><span class="fc-ver-badge">${esc(l.vers)}</span></li>`).join('');
  }
  function renderFlowCard(c) {
    const id = c.primaryId;
    const seen = c.active ? `the active v${c.active.num}` : `v${c.versions[0].num}`;
    return `
        <div class="fc-item fc-flow-card" id="fcItem_${esc(id)}">
          <div class="fc-flow-head">
            <span class="fc-item-name">${esc(c.name)}</span>
            <span class="fc-item-btns">
              ${xlinkHtml('dependencies', '↗ Deps',
                "Map this flow's subflow call chain in the Dependencies tab before trimming it")}
              <button class="btn btn-sm fc-inspect-btn" title="View the XML of ${esc(seen)}"
                      data-id="${esc(id)}" data-type="Flow">🔍</button>
              <span class="${c.pb ? 'fc-del-pair' : 'fc-fix-pair'}" data-id="${esc(id)}" data-type="Flow" data-name="${esc(c.name)}">${_fixBtnsHtml('Flow', id, c.name)}</span>
              <button class="btn btn-sm fc-setup-btn" data-type="${c.pb ? 'ProcessBuilder' : 'Flow'}" title="Open this kind in Salesforce Setup, in a new tab">↗ Setup</button>
            </span>
          </div>
          ${c.pb ? `<div class="fc-pb-line">${_pbNoteHtml()}</div>` : ''}
          <ul class="fc-flow-vers" data-id="${esc(id)}">${_flowVersHtml(c)}</ul>
        </div><div class="fc-xml-panel" id="fcXml_${esc(id)}" style="display:none"></div>`;
  }

  function renderItem(dep, fixable, type) {
    const id      = dep.MetadataComponentId;
    const rawName = dep.MetadataComponentName || id;
    const name    = esc(rawName);
    const canInsp = Object.prototype.hasOwnProperty.call(_INSPECT_SOBJECT, type) || _inspectsByMd(type) || _inspectsByCode(type) || type === 'EmailTemplate';
    const inspBtn = canInsp
      ? `<button class="btn btn-sm fc-inspect-btn" title="View XML metadata"
                 data-id="${esc(id)}" data-type="${esc(type)}">🔍</button>`
      : '';
    const xmlPanel = canInsp
      ? `<div class="fc-xml-panel" id="fcXml_${esc(id)}" style="display:none"></div>`
      : '';

    // a blocker the delete engine knows gets its 🗑 button even when nothing else is fixable here
    const canDel = !fixable && typeof sftkMdDeleteSpec === 'function' && (!!sftkMdDeleteSpec(type) || type === 'LookupFilter' || !!_extraDeleteSpec(type, id));
    if (fixable || canDel) {
      return `
        <div class="fc-item" id="fcItem_${esc(id)}">
          <span class="fc-item-name">${name}</span>${dep._tag ? `<span class="fc-item-tag">${esc(dep._tag)}</span>` : ''}
          <span class="fc-item-btns">
            ${inspBtn}
            <span class="${canDel ? 'fc-del-pair' : 'fc-fix-pair'}" data-id="${esc(id)}" data-type="${esc(type)}" data-name="${name}">${_fixBtnsHtml(type, id, rawName)}</span>
            <button class="btn btn-sm fc-setup-btn" data-type="${esc(type)}" title="Open this kind in Salesforce Setup, in a new tab">↗ Setup</button>
          </span>
        </div>${xmlPanel}`;
    }
    return `
      <div class="fc-item" id="fcItem_${esc(id)}">
        <span class="fc-item-name">${name}</span>${dep._tag ? `<span class="fc-item-tag">${esc(dep._tag)}</span>` : ''}
        <span class="fc-item-btns">
          ${inspBtn}
          <button class="btn btn-sm fc-setup-btn" data-type="${esc(type)}" title="Open this kind in Salesforce Setup, in a new tab">↗ Setup</button>
        </span>
      </div>${xmlPanel}`;
  }

  // ── Fix individual flow ────────────────────────────────────
  // swap: the button pressed — true = ⇄ Replace (move the reference to the
  // replacement field), false / undefined = ✂ Remove. One fix at a time.
  // way: a flow card's decision for the version that runs ('keep' | 'off').
  // What ✂ / ⇄ from the row would change, read and worked out BEFORE the confirm and shown in it as a diff (user
  // 2026-11-10, on the layout's confirm: "למה לא רואים פה מה מסירים מהxml?"). The same pure transforms the fix runs,
  // on a copy; nothing is written. '' when the component cannot be read or nothing would change — the fix then says
  // why, as it always did. A flow has its own plan box.
  async function _fixPreviewHtml(type, componentId, componentName, swap) {
    try {
      const obj = _selObj.api, field = _selField.api, nf = swap ? _replField.api : '';
      const hd = what => `<div class="fc-xml-diff-hd">${what} — <span class="xd-del">− as it is</span> · <span class="xd-add">+ as it will be</span></div>`;
      if (type === 'Layout' || type === 'FlexiPage') {
        const res = await bg({ type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid, _suppressError: true, sobject: type, id: componentId });
        if (!res || res.error || !res.Metadata) return '';
        const after = JSON.parse(JSON.stringify(res.Metadata));
        let n;
        if (type === 'Layout') {
          // another object's layout: ⇄ is refused by the fix as ✂ is, so neither previews an edit (2026-11-14 review 5)
          const lyOpts = { objApi: obj, fullName: res.FullName || res.fullName, isObject: _fcIsLoadedObject };
          if (swap) { removeFieldFromLayout({}, field, lyOpts); if (lyOpts.refused) return ''; }
          if (swap) { const sw = sftkLayoutReplaceField(after, field, nf, { readOnly: _replReadOnly() }); n = sw.swapped + sw.blanked; }
          else n = removeFieldFromLayout(after, field, lyOpts);
        } else if (swap) { const sw = replaceFieldInFlexiPage(after, obj, field, nf, null, _flexiPageObjOf(res)); n = sw.swapped + sw.dropped; }
        else n = removeFieldFromFlexiPage(after, obj, field, null, _flexiPageObjOf(res));
        if (!n) return '';
        const xml = m => type === 'Layout' ? buildLayoutXml(m) : ['<FlexiPage>', ...Object.keys(m).sort().flatMap(k => _lxValueToLines(k, m[k], '    ')), '</FlexiPage>'].join('\n');
        // a visibility rule that loses a criterion loses its numbered logic with it (the numbers would point at the
        // wrong criteria): what is left is joined by AND — said before the confirm, not found out after
        const logicN = m => (JSON.stringify(m).match(/"booleanFilter":"[^"]+"/g) || []).length;
        const lost = type === 'FlexiPage' ? logicN(res.Metadata) - logicN(after) : 0;
        const warn = lost > 0 ? `<div class="fc-prev-logic">⚠ ${lost} visibility rule${lost === 1 ? ' loses' : 's lose'} ${lost === 1 ? 'its' : 'their'} filter logic (like “1 AND (2 OR 3)”) together with the field’s criterion: the criteria that are left are joined by AND. If the logic had an OR or brackets in it, the component will show in different cases than before — check it in App Builder afterwards.</div>` : '';
        return warn + hd('The XML') + _textDiffHtml(xml(res.Metadata), xml(after));
      }
      if (type === 'EmailTemplate') {
        const rec = await _tplRead(componentId);
        const famObj = sftkMdFamObj(obj, field);   // Task / Event custom field = Activity's (2026-11-15), as the fix itself
        const r = swap ? sftkTplReplace(rec, field, nf, famObj) : sftkTplRemove(rec, field, famObj);   // another object's same-named field stays (2026-11-14)
        if (!r.n) return '';
        return r.fields.map(k => hd(`<code>${esc(k)}</code>`) + _textDiffHtml(rec[k], r.rec[k])).join('');
      }
      if (type === 'Report') {
        const d = await bg({ type: 'SF_REST_GET', orgUrl: _orgUrl, sid: _sid, _suppressError: true, path: `services/data/v62.0/analytics/reports/${componentId}/describe` });
        if (!d || d.error || !d.reportMetadata) return '';
        const res = swap ? sftkRptReplaceField(d.reportMetadata, obj, field, nf, sftkRptTokenMatch, sftkRptFieldHits) : sftkRptStripField(d.reportMetadata, obj, field);
        if (!res.changed) return '';
        return hd('The report’s definition (JSON, as the Analytics API holds it)') + _textDiffHtml(JSON.stringify(d.reportMetadata, null, 2), JSON.stringify(res.meta, null, 2));
      }
      if (type === 'SearchLayout') {
        const ed = await _searchLayoutRead(componentId, nf);
        return ed && ed.n ? hd('The XML') + _xmlDiffHtml(ed.before, ed.after) : '';
      }
      if (type === 'ReportType') {
        const row = (_lastScan?.deps || []).find(d => d.MetadataComponentType === 'ReportType' && d.MetadataComponentId === componentId);
        const fullName = (row && row._fullName) || (/^070/.test(String(componentId)) ? null : componentId);
        if (!fullName || (row && row._managed)) return '';
        const before = await readReportType(fullName);
        const rtObj = sftkMdFamObj(obj, field);   // Task / Event custom field = Activity's (2026-11-15), as the scan and the fix
        const res = swap ? sftkRtReplaceField(before, rtObj, field, nf) : sftkRtRemoveField(before, rtObj, field);
        if (!res.changed || (res.viaLookup && res.viaLookup.length)) return '';   // refused by the fix (2026-11-14)
        return hd('The XML') + _xmlDiffHtml(before, res.xml);
      }
    } catch (_) { /* no preview: the confirm still states what happens, and the fix reports its own error */ }
    return '';
  }
  async function fixOne(type, componentId, componentName, fieldId, swap, way) {
    // A row that is already settled has nothing left to fix (and, for a flow,
    // its version may be gone): never run a fix on it again.
    if (eid(`fcItem_${componentId}`)?.classList.contains('fc-item-fixed')) return;
    if (_fixSwap !== null) return;
    // a new attempt starts clean: the message of the last one would read as this one's result (seen live 2026-11-10)
    eid(`fcItem_${componentId}`)?.querySelectorAll('.fc-item-err').forEach(e => e.remove());
    _fixingRow = String(componentId);
    _fixSwap = !!swap && _replOn();
    _fixWay = (way === 'keep' || way === 'off' || way === 'delete' || way === 'edit' || way === 'code') ? way : '';
    // 'cancel' = the user said no in the dialog (a bulk walk stops there)
    try { return await _fixOneRun(type, componentId, componentName, fieldId); }
    finally { _fixSwap = null; _fixWay = ''; _fixingRow = ''; }
  }
  // the row a fix is working on: every History entry begun meanwhile carries it (sftkHistoryRowFor), so the row's
  // ↩ Undo takes back exactly what that row did
  let _fixingRow = '';
  if (typeof sftkHistoryRowFor === 'function') sftkHistoryRowFor('Field Cleaner', () => _fixingRow);
  // ↩ Undo on a cleared row (owner 2026-11-16: "After deletion, we will show an undo button near the deleted/removed
  // metadata items"): the change(s) that row made are undone right here — one confirmation, each step re-read — and
  // the list is read again from the org. A row whose change is not found (made before entries carried their row,
  // or already undone) opens Activity on this tool, where every change is listed.
  async function undoRow(componentId, btn) {
    const subj = _fcSubject();
    const list = typeof sftkHistoryUndoableForRow === 'function'
      ? sftkHistoryUndoableForRow(await sftkHistoryAll(), { tool: 'Field Cleaner', orgUrl: _orgUrl, subject: subj, row: String(componentId) }) : [];
    if (!list.length) { if (typeof window.sftkToolHistoryOpen === 'function') window.sftkToolHistoryOpen('fields'); return; }
    if (list.length > 1) { undoAllForField(list, subj); return; }
    if (btn) btn.disabled = true;
    const r = await sftkHistoryUndo(list[0].id, {});
    if (btn && btn.isConnected) btn.disabled = false;
    if (!r || r.cancelled) return;
    const item = eid(`fcItem_${componentId}`);
    if (!r.ok) { appendInlineError(componentId, `The undo did not finish — ${r.text || 'no answer'}`); return; }
    if (item) { const ok = item.querySelector('.fc-item-ok'); if (ok) ok.textContent = `↩ Undone — ${r.text || 'put back, verified by re-reading the org'}`; item.querySelector('.fc-item-undo')?.remove(); }
    // what the page lists is from before the undo: scan again, so nothing shown is assumed
    const scan = eid('fcScanBtn');
    if (scan && !scan.disabled && subj === _fcSubject()) scan.click();
  }
  async function _fixOneRun(type, componentId, componentName, fieldId) {
    const cfg = TYPE_CFG[type] || TYPE_CFG_DEFAULT;
    // ✂ / ⇄ inside the component, its XML shown (its own confirm, its own restore point)
    if (_fixWay === 'edit') {
      try { const r = await fixEdit(type, componentId, componentName, _fixSwap === true); if (r === 'cancel') return 'cancel'; if (r && r.label) markFixed(componentId, r.label, '', r.detailHtml || ''); }
      catch (e) { _rowBusy(componentId, null); appendInlineError(componentId, e.message, e.setupUrl, '↗ Open in Setup'); }
      return;
    }
    // ⇄ in code: the field's API name renamed in every file (its own confirm with the diff, its own restore point)
    if (_fixWay === 'code') {
      try { const r = await fixCodeReplace(type, componentId, componentName); if (r === 'cancel') return 'cancel'; if (r && r.label) markFixed(componentId, r.label, '', r.detailHtml || ''); }
      catch (e) { _rowBusy(componentId, null); appendInlineError(componentId, e.message, e.setupUrl, '↗ Open in Setup'); }
      return;
    }
    // 🗑 the whole component goes (its own confirm, its own restore point)
    if (_fixWay === 'delete') {
      try { const label = await fixDelete(type, componentId, componentName); if (label === 'cancel') return 'cancel'; if (label) markFixed(componentId, label); }
      catch (e) { _rowBusy(componentId, null); appendInlineError(componentId, e.message, e.setupUrl, '↗ Open in Setup'); }
      return;
    }
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
      _rowBusy(componentId, '🔎 reading versions…');
      try { flowPlan = await fixFlowPlan(componentId, componentName); }
      catch (e) {
        _rowBusy(componentId, null);
        appendInlineError(componentId, e.message, e.setupUrl, '↗ Open in Flow Builder');
        return;
      }
      _rowBusy(componentId, null);
      if (flowPlan.plan.mode === 'none') {
        markFixed(componentId, '✅ No version of this flow references the field any more');
        return;
      }
    }
    // ⇄ Replace with another field: the reference MOVES instead of going. For
    // a flow that only applies to an active version (inactive ones are deleted
    // either way). Read once here — the dialog, the run and the labels agree.
    const swap = _swapOn() && (type !== 'Flow' || flowPlan.plan.mode === 'active');
    const swapTo = swap ? _replField.api : '';
    let wantBackup = !_planRun;   // a plan run downloads no zip per flow — every version is kept as a restore point
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
    // The decision is made on the flow's card: ✂ keeps the flow running on a
    // new version, 🗑 deletes the active version too, and ⇄ always keeps it
    // running on the new field (user 2026-10-05). Only a walk over many items
    // arrives without one — then the dialog asks, as it always did.
    let preset = !hasChoice ? '' : (swap || _fixWay === 'keep') ? 'replace' : _fixWay === 'off' ? 'delete' : '';
    // The third way (user 2026-11-10): an outcome that rests on the field alone can go as a whole. When the flow has
    // such outcomes the card's ✂ no longer decides by itself — the dialog shows the ways, this one among them.
    const pvO = hasChoice && !swap ? (flowPlan.previewOutcomes || null) : null;
    let dropOutcomes = false;
    const keepAsked = !!(pvO && preset === 'replace');
    if (keepAsked) preset = '';   // activeMode keeps its default: the plain way when it can take something out, else nothing chosen
    // 2026-11-14 (release QA): clearing the card's ✂ keep for the outcomes dialog skipped the up-front refusal below, so
    // the plain way — which leaves an element empty — was offered again, picked in a ✂ walk, sent, and refused by
    // Salesforce ("Required field is missing: assignmentItems"). Now the plain way is not offered then (plainOff), and
    // when the outcomes way cannot stand either (it leaves an element empty too, or nothing would be left connected),
    // the card refuses before any dialog, as it does without outcomes.
    const plainOff = keepAsked && !swap && replaceLikelyRefused;
    if (plainOff && (pvO.empty || (pvO.emptied || []).length > 0)) preset = 'replace';
    if (flowPlan) flowPlan.plainOff = plainOff;   // _flowChoiceHtml reads it from the plan it is handed
    if (preset === 'replace' && !canReplace) {
      const vN = `the active v${flowPlan.plan.active.num} of "${componentName}"`;
      const left = pv ? pv.remaining.length : 0;
      appendInlineError(componentId, swap
        ? `Nothing in ${vN} can be pointed at ${swapTo} automatically${left ? ` — the field is mentioned in ${left} place(s) where its object could not be worked out` : ''}. Nothing was changed. Change it in Flow Builder, or use one of the other buttons on this flow.`
        : `Nothing can be taken out of ${vN} automatically${left ? ` — the field is used in ${left} place(s) the fix never rewrites (a decision outcome that rests on the field alone or has a numbered logic, or a formula that is not a plain yes/no test)` : ''}. Nothing was changed. Change it in Flow Builder and press ✂ again, or press 🗑 Delete versions · flow off.`,
        flowPlan.builderUrl, '↗ Open in Flow Builder');
      return;
    }
    // QA 2026-10-06 (live): ✂ Remove · flow keeps running on a flow whose only
    // assignment line is the field was offered, confirmed, and then refused by
    // Salesforce ("Required field is missing: assignmentItems") — nothing
    // deleted, correct, but a wasted round with a confirmation in it. The
    // preview already knows which elements the fix would leave empty: say so
    // before the dialog, and name the ways that do work.
    if (preset === 'replace' && !swap && replaceLikelyRefused) {
      const names = pv.emptied.slice(0, 4).map(e => `${e.kind} “${e.label || e.name || '?'}” (${e.where})`).join(', ');
      appendInlineError(componentId,
        `✂ Remove · flow keeps running cannot work on "${componentName}": taking the field out leaves ${names} with nothing in it, and Salesforce refuses a version like that. Nothing was changed. Press 🗑 Delete versions · flow off, pick a replacement field and press ⇄ Replace, or change the flow in Flow Builder and press ✂ again.`,
        flowPlan.builderUrl, '↗ Open in Flow Builder');
      return;
    }
    if (preset) activeMode = preset;
    const asks = hasChoice && !preset;                      // the dialog shows the two ways only when the card did not
    const shownPlan = preset === 'delete' ? flowPlan.planDelete : (flowPlan ? flowPlan.plan : null);
    let previewHtml = '';
    if (type !== 'Flow') {
      _rowBusy(componentId, '🔎 reading…');
      previewHtml = await _fixPreviewHtml(type, componentId, componentName, swap);
      _rowBusy(componentId, null);
    }
    const gate = await sftkOrgWriteGate(_orgUrl);
    const sure = await sftkConfirmDestructive({
      title: `${swap ? 'Replace' : 'Remove'} field reference — ${cfg.label || type}`,
      ...(swap ? { icon: '⇄' } : {}),
      items: type === 'Flow'
        ? [...shownPlan.toDelete.map(v => ({ label: `${componentName} v${v.num}`, sub: `${v.status} — deleted (${asks && v.status === 'Active' ? 'the active version: replaced or removed, as you choose below' : v.why})` })),
           ...(shownPlan.overwrite ? [{ label: `${componentName} v${shownPlan.overwrite.num}`, sub: `${shownPlan.overwrite.status} — its content is REPLACED ${asks ? 'when the flow keeps running' : 'by the new version'} (Salesforce saves the new version over the newest draft)${asks && shownPlan.overwrite.refs ? '; deleted when you choose delete' : ''}` }] : [])]
        : [{ label: componentName, sub: type }],
      revOverride: {
        html: type === 'Flow'
          ? `⚠ <strong>Flow versions that mention the field are deleted</strong> — Salesforce locks the field per version. A restore point of each is kept first: ↩ Undo in Activity puts the version that was active back as the active version, and ↩ Restore points in Activity hold every deleted version.${_flowPlanBoxHtml(asks && !activeMode ? null : activeMode === 'delete' ? { rows: flowPlan.rowsDelete, lines: flowPlan.linesDelete } : { rows: flowPlan.rows, lines: flowPlan.lines })}`
          : `${swap ? `⇄ <strong>${esc(_selObj.api)}.${esc(_selField.api)} → ${esc(swapTo)}</strong>. ${esc(_groupNote(type, cfg))}` : `✏ ${cfg.note || 'The field reference is removed from this component.'}`} The change deploys immediately. ${type === 'SearchLayout' ? 'The layout as it is now is kept: ↩ Undo in Activity puts it back.' : ['Report', 'ReportType', 'Layout', 'FlexiPage'].includes(type)
              ? 'A <strong>restore point</strong> is saved first — ↩ Restore points, in Activity, can put the previous version back.'
              : 'There is no undo besides re-adding the field by hand.'}`,
        needsCheckbox: type === 'Flow',
      },
      extraHtml: type === 'Flow' ? `
        ${hasChoice ? _flowChoiceHtml(flowPlan, componentName, canReplace, preset) : ''}
        <label class="sftk-confirm-ack"><input type="checkbox" id="fcFlowBackup" checked> ⬇ Back up the ${shownPlan.toDelete.length + (shownPlan.overwrite ? 1 : 0)} version(s) as a zip before deleting (recommended — the Flows tool can restore from it)</label>
        ${flowPlan.interviews.length ? `<div class="sftk-confirm-undo">⏸ ${esc(sftkFlowInterviewWords(sftkFlowInterviewKinds(flowPlan.interviews)).head)} that will be deleted first: ${esc(flowPlan.interviews.slice(0, 8).map(i => i.InterviewLabel || i.Name).join(', '))}${flowPlan.interviews.length > 8 ? ` … +${flowPlan.interviews.length - 8} more` : ''}</div>` : ''}` : previewHtml,
      onRender: type === 'Flow' ? () => {
        const cb = document.getElementById('fcFlowBackup');
        cb?.addEventListener('change', () => { wantBackup = !!cb.checked; });
        if (!asks) return;   // the way was chosen on the card (or there is only one)
        // The choice drives the numbered plan and the button; nothing can be
        // confirmed until BOTH the acknowledgement is ticked and a way is chosen.
        const go = document.getElementById('sftkConfirmGo'), ack = document.getElementById('sftkConfirmAck');
        const sync = () => {
          const cur = activeMode === 'delete' ? { rows: flowPlan.rowsDelete, lines: flowPlan.linesDelete } : activeMode === 'replace' ? { rows: flowPlan.rows, lines: flowPlan.lines } : null;
          const box = document.getElementById('fcFlowPlan');
          if (box) box.outerHTML = _flowPlanBoxHtml(cur);
          if (go) {
            go.textContent = activeMode === 'delete' ? '🗑 Switch the flow off, then delete' : activeMode === 'replace' ? (swap ? '⇄ Deploy the version that uses the new field, then delete' : '✂ Deploy fixed version, then delete') : 'Choose an option first';
            go.disabled = !(ack && ack.checked && activeMode);
          }
        };
        document.querySelectorAll('input[name="fcActiveMode"]').forEach(r => r.addEventListener('change', () => { if (r.checked) { activeMode = r.value; dropOutcomes = r.dataset.outcomes === '1'; sync(); } }));
        ack?.addEventListener('change', sync);
        sync();
      } : null,
      confirmLabel: type === 'Flow'
        ? (preset === 'delete' ? '🗑 Switch the flow off, then delete'
          : flowPlan.plan.mode === 'active' ? (swap ? '⇄ Deploy the version that uses the new field, then delete' : '✂ Deploy fixed version, then delete') : '🗑 Delete referencing version(s)')
        : (swap ? '⇄ Replace reference' : '✂ Remove reference'),
      production: gate.production ? { label: gate.label } : null,
    });
    if (!sure) return 'cancel';

    _rowBusy(componentId, '⏳ working…');
    try {
      let label = cfg.doneLabel || '✅ Done';
      let doneLinks = '', doneHtml = '';
      if (type === 'Flow') {
        if (hasChoice && !activeMode) { _rowBusy(componentId, null); return; }   // the button is disabled without a choice; belt and braces
        const chosen = (hasChoice && activeMode === 'delete') ? { ...flowPlan, plan: flowPlan.planDelete, lines: flowPlan.linesDelete } : flowPlan;
        // History (sftk-history.js): one journal for this button press,
        // covering every write fixFlowExecute makes (activation/deactivation,
        // interview deletes, version deletes) — passed into the helper so
        // each write's verdict lands in the same entry.
        const moving = swap && activeMode !== 'delete';
        const j = sftkHistoryBegin({ tool: 'Field Cleaner', title: moving ? `⇄ Flow — ${componentName} (${_selObj.api}.${_selField.api} → ${swapTo})` : `✂ Flow — ${componentName} (${_selObj.api}.${_selField.api} removed)`, orgUrl: _orgUrl });
        let r;
        try {
          _flowDropOutcomes = dropOutcomes && activeMode === 'replace';
          r = await fixFlowExecute(chosen, { backup: wantBackup, journal: j });
        } finally {
          _flowDropOutcomes = false;
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
          : `⚠ the new version still mentions the field in a place the auto-fix does not touch (a decision outcome that rests on the field alone or has a numbered logic, or a formula that is not a plain yes/no test) — finish it in Flow Builder`);
        // Not finished is not done (live 2026-09-22: three versions Salesforce
        // refused were marked ✅ and the delete zone read "All dependencies
        // resolved"). A refused version keeps its ✂ button and says why.
        const stuck = (r.failed || 0) + (r.skipped || 0) + (r.interviewsFailed || 0);
        if (stuck) {
          const e = new Error(`Not finished: ${bits.join(' · ')}. The field stays locked until every version that references it is gone — clear the cause, then press ✂ Remove again (what was deleted stays deleted).`);
          if (flowPlan.builderUrl) e.setupUrl = flowPlan.builderUrl;
          throw e;
        }
        // One flow, one result: which version runs now, which were deleted.
        label = r.mode === 'active' ? `✅ Done — v${r.newVersion} is the active version now`
              : r.mode === 'active-delete' ? '✅ Done — the flow is switched off'
              : `✅ Done — ${r.deleted} old version${r.deleted === 1 ? '' : 's'} deleted`;
        doneLinks = r.mode === 'active' ? _flowDoneLinks({ stillBlocking: 0 }) : '';
        doneHtml = `<ul class="fc-flow-done">${sftkFlowDoneLines(r, chosen.plan, { swapTo, field: _selField.api })
          .map(l => `<li${l.warn ? ' class="fc-flow-warn"' : ''}><span class="fc-flow-ico">${l.icon}</span> ${esc(l.text)}</li>`).join('')}</ul>`;
      }
      if (type === 'Layout')    label = (await fixLayout(componentId, componentName)) || label;
      if (type === 'FlexiPage') label = (await fixFlexiPage(componentId, componentName)) || label;
      if (type === 'Report')    label = await fixReport(componentId, componentName);
      if (type === 'ReportType') label = (await fixReportType(componentId, componentName)) || label;
      if (type === 'SearchLayout') label = (await fixSearchLayout(componentId, componentName)) || label;
      if (type === 'EmailTemplate') label = (await fixEmailTemplate(componentId, componentName, swap)) || label;
      markFixed(componentId, label, doneLinks, doneHtml);
    } catch (e) {
      _rowBusy(componentId, null);
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

  let _walkRunning = false;   // a ⚡ run is on: the group buttons stay disabled until it ends
  // why a whole KIND has no ✂ (the plan says it on each row of the kind)
  function _noRemoveWhy(type) {
    const spec = typeof sftkMdDeleteSpec === 'function' ? sftkMdDeleteSpec(type) : null;
    const what = (spec && spec.what) || (TYPE_CFG[type] || TYPE_CFG_DEFAULT).label || type;
    const an = /^[aeiou]/i.test(what) ? 'an' : 'a';
    if (spec && (spec.code || spec.bundle)) return `which line of the code goes is yours to decide — ${an} ${what} with the field cut out would not compile; ⇄ Replace renames the field in it, ✎ edits it`;
    return `${an} ${what} cannot lose the field and keep working — ⇄ Replace points it at another field`;
  }

  // extraLinksHtml (C5a) — optional pre-escaped xlinkHtml() follow-up links
  // rendered after the done-label (e.g. "↗ Check access" after a flow fix).
  // detailHtml — optional pre-built block under the label (a flow's result,
  // one line per fact).
  // did marking this row done change the org? (a row that was only settled — "nothing uses the field here" — did not)
  function _fixedRowChanged(label) { return !/^✅ (Nothing uses the field here|No version of this flow references)/.test(String(label || '')); }
  function markFixed(componentId, label = '✅ Done', extraLinksHtml = '', detailHtml = '') {
    const item = eid(`fcItem_${componentId}`);
    if (!item) return;
    const name = item.querySelector('.fc-item-name')?.textContent || '';
    item.classList.add('fc-item-fixed');
    // ↩ Undo on the row itself (owner 2026-11-15: "we dont have undo for anything there" — the undo was only in the
    // History button of the top bar and in a folded list under the results). It opens this tool's History, where the
    // change just made is the first entry with its ↩ Undo (or the true reason it has none). Not on a row that was
    // only settled — nothing was changed there.
    const changed = _fixedRowChanged(label);
    if (changed && _lastScan) _lastScan.cleared = true;   // the next ask gives Salesforce time to catch up
    item.innerHTML = `
      <span class="fc-item-name">${esc(name)}</span>
      <span class="fc-item-ok">${esc(label)}${extraLinksHtml}</span>${changed ? '<button type="button" class="btn btn-secondary btn-sm fc-item-undo" title="Takes this change back — it asks first, each step is re-read from the org, and the list is scanned again">↩ Undo</button>' : ''}${detailHtml}`;
    item.querySelector('.fc-item-undo')?.addEventListener('click', ev => undoRow(componentId, ev.currentTarget));
    // Close any open XML inspector for this item
    const xmlPanel = eid(`fcXml_${componentId}`);
    if (xmlPanel) {
      xmlPanel.style.display = 'none';
      // The inspector's own ✂ button is a .fc-fix-btn too — left in place it
      // keeps counting as an unresolved fix and "Delete Field" never
      // re-enables (audit 2026-09-12).
      xmlPanel.querySelector('.fc-xml-fix')?.remove();
    }
    // The "… all N" buttons count what is still open: gone when one or none is left.
    const box = item.closest('.fc-group')?.querySelector('.fc-fix-allbox');
    if (box) {
      const open = _openPairs(item.closest('.fc-group'));
      if (open < 2) box.remove();
      else {
        box.dataset.n = String(open); box.innerHTML = _fixAllHtml(box.dataset.type, open, box.dataset.label);
        if (_walkRunning) box.querySelectorAll('button').forEach(b => { b.disabled = true; });
      }
    }
    _refreshFixEvery();
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

  // WHAT HOLDS THE DELETE (owner 2026-11-15: "salesforce would accept the delete but i cant click the delete button"):
  // only what BLOCKS it — the listed blockers and the open rows of a kind Salesforce refuses over (flows, Lightning
  // pages). A row that only "might break" (a layout, a list view, a report, a template) does not: Salesforce lets the
  // delete through with it, so with no blocker left Salesforce is asked, and its answer decides. Such rows are still
  // counted in the note, so they are not forgotten.
  function _openRowSplit(btns, sevOf) {
    const blk = new Set(), soft = new Set();
    for (const b of btns) ((sevOf(b.type) === 'blocker') ? blk : soft).add(String(b.id));
    for (const id of blk) soft.delete(id);
    return { blockers: blk.size, soft: soft.size };
  }
  function checkEnableDelete() {
    const remaining = document.querySelectorAll('.fc-fix-btn:not([disabled])');
    const open = _openRowSplit([...remaining].map(b => ({ id: b.dataset.id, type: b.dataset.type })), t => (TYPE_CFG[t] || TYPE_CFG_DEFAULT).sev);
    const delBtn    = eid('fcDelBtn');
    if (!delBtn) return;
    // a packaged field is never deletable from here, whatever is cleared
    const pkgNs = fcFieldNamespace(_selField && _selField.api);
    if (pkgNs) {
      delBtn.disabled = true;
      const note = eid('fcDeleteNote');
      if (note) note.textContent = `📦 ${_selField.api} belongs to the package ${pkgNs} — a packaged field cannot be deleted here. What is listed above is what THIS org built on it; the package’s own components are not readable.`;
      return;
    }
    const blockerTotal = (_manualBlockers || []).reduce((n, b) => n + b.count, 0);
    // F2: even with every auto-fix done, manual blockers still make Salesforce
    // reject the delete — keep the button locked and say why.
    if (open.blockers === 0 && blockerTotal === 0) {
      delBtn.disabled = !!(_lastScan && _lastScan.unread && _lastScan.unread.length);   // _paintAsk unlocks it when Salesforce accepts
      const note = eid('fcDeleteNote');
      const softSay = open.soft ? ` ${open.soft} item${open.soft === 1 ? '' : 's'} below still use${open.soft === 1 ? 's' : ''} the field and will lose it with the delete — fix ${open.soft === 1 ? 'it' : 'them'} first if ${open.soft === 1 ? 'it matters' : 'they matter'}.` : '';
      if (note) note.textContent = `${open.soft ? 'Nothing listed blocks the delete' : 'Everything listed is resolved'} — asking Salesforce whether anything else blocks…`;
      if (_lastScan) _lastScan.ask = null;
      askSalesforce({ settle: !!(_lastScan && _lastScan.cleared) }).then(() => { const n2 = eid('fcDeleteNote'); if (n2 && /asking Salesforce/.test(n2.textContent)) n2.textContent = (open.soft ? 'Nothing listed blocks the delete.' : 'Everything listed is resolved.') + softSay; });
    } else if (open.blockers === 0 && blockerTotal > 0) {
      delBtn.disabled = true;
      const note = eid('fcDeleteNote');
      if (note) note.textContent = `🔒 Auto-fixes done, but ${blockerTotal} manual blocker(s) remain — clear them in Setup and re-scan.`;
    } else {
      // some are fixed, some are open: the count follows without a re-scan (backlog 2026-11-02)
      const openN = new Set([...remaining].map(b => b.dataset.id)).size;
      const note = eid('fcDeleteNote');
      if (note && /^⚠ Fix the /.test(note.textContent.trim())) note.textContent = `⚠ Fix the ${openN} fixable item${openN === 1 ? '' : 's'} below first.`;
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
    // History shows these lines — a run is named by what it was, not by its id
    // (user 2026-10-07: "show better info than id that says nothing to the user").
    const runWords = it => `${/^error$/i.test(String(it.InterviewStatus || '')) ? 'failed' : 'paused'} flow run${it.InterviewLabel || it.Name ? ` “${it.InterviewLabel || it.Name}”` : ''}${it.CurrentElement ? ` (at ${it.CurrentElement})` : ''} deleted`;
    const batch = await sftkWriteVerifiedAll(list.map(it => ({
      describe: runWords(it),
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
  // labelOf: id → words for History ("SFTK FC Test Flow v17 (Active) deleted"); an id
  // with no words falls back to the id.
  async function _deleteFlowVersionIds(ids, skipIds, journal, labelOf) {
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
      describe: (labelOf && labelOf[id]) || id,
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

  // Read every version of the flow, find which mention the field, and plan.
  // Nothing is written here.
  // What the automatic fix would do INSIDE the active version, and the choice
  // it leaves the user (2026-09-21). Flow Builder cannot be driven or
  // highlighted from outside, so the manual route names every location by the
  // element's label and API name — Flow Builder's Toolbox → Manager finds them.
  // preset: the way already chosen on the flow's card ('replace' = the flow
  // keeps running, 'delete' = the active version goes too) — then the dialog
  // states it instead of asking. '' = not chosen (a bulk walk): it asks.
  function _flowChoiceHtml(fp, flowName, canReplace, preset) {
    const pv = fp.preview || { removed: [], remaining: [], emptied: [] };
    const plainOff = !!fp.plainOff;   // 2026-11-14: the card's ✂ keep would be refused — the plain way is not offered
    if (plainOff) canReplace = false;
    if (pv.swap) return _flowSwapHtml(fp, canReplace);
    const act = fp.plan.active;
    if (preset === 'delete') return `<div class="fc-prev">
      <div class="fc-prev-hd">The active v${act.num} — deleted with the rest</div>
      <div class="fc-prev-sec fc-prev-warn"><b>The flow stops running.</b> It is switched off, the org is read again to confirm that nothing is active, and then v${act.num} is deleted with every other version that mentions the field. A version that never mentioned the field is left as it is, not active.</div>
      <div class="fc-prev-sec">To keep the flow running instead, cancel and press <b>✂ Remove · flow keeps running</b> on its card.</div>
    </div>`;
    const li = (x, tail) => `<li><b>${esc(x.kind)}</b> “${esc(x.label || x.name || '?')}”${x.name ? ` <code>${esc(x.name)}</code>` : ''} — ${esc(x.where)}${tail ? `: <code>${esc(tail)}</code>` : ''}</li>`;
    const list = (arr, tailKey) => arr.length ? `<ul class="fc-prev-list">${arr.slice(0, 12).map(x => li(x, x[tailKey])).join('')}${arr.length > 12 ? `<li>… +${arr.length - 12} more</li>` : ''}</ul>` : '';
    const open = fp.builderUrl ? `<a href="${esc(fp.builderUrl)}" target="_blank" rel="noopener" class="fc-prev-open">↗ Open v${act.num} in Flow Builder</a>` : '';
    const sum = [`${pv.removed.length} come${pv.removed.length === 1 ? 's' : ''} out`, pv.remaining.length ? `${pv.remaining.length} the tool cannot take out` : '', pv.emptied.length ? `${pv.emptied.length} left with nothing in ${pv.emptied.length === 1 ? 'it' : 'them'}` : ''].filter(Boolean).join(' · ');
    return `<div class="fc-prev">
      <details class="fc-prev-more"><summary>Inside the active v${act.num} — where it uses the field: ${sum}</summary>
      ${pv.removed.length ? `<div class="fc-prev-sec fc-prev-ok"><b>✂ The tool takes these out (${pv.removed.length})</b>
        <div class="fc-prev-note">Each line is one place where the flow uses the field. The fix removes it for you.</div>${list(pv.removed, 'what')}</div>`
        : `<div class="fc-prev-sec fc-prev-bad"><b>✂ The tool cannot take anything out of this version.</b></div>`}
      ${pv.remaining.length ? `<div class="fc-prev-sec fc-prev-bad"><b>✋ The tool cannot take these out (${pv.remaining.length})</b>
        <div class="fc-prev-note">While they stay, Salesforce refuses to delete the field. This happens when a decision outcome depends on this field alone, when a decision uses numbered condition logic, or when a formula is more than a simple yes/no test. What you can do: remove the whole outcome (an option below, when it is offered), or change it yourself in Flow Builder.</div>${list(pv.remaining, 'value')}</div>` : ''}
      ${pv.emptied.length ? `<div class="fc-prev-sec fc-prev-warn"><b>⚠ Left with nothing in them after the fix (${pv.emptied.length})</b>
        <div class="fc-prev-note">Once the field is taken out, these elements have nothing left to do. Salesforce usually refuses to save a flow like that. If it refuses, nothing is changed and nothing is deleted.</div>${list(pv.emptied, '')}</div>` : ''}
      <div class="fc-prev-sec"><b>Prefer to fix it yourself in Flow Builder?</b> ${open}
        <ol class="fc-prev-steps"><li>Open <i>Toolbox → Manager</i> and search for each API name shown above (<code>like_this</code>).</li><li>Change or remove the reference, and reconnect anything you delete.</li><li>Save as a new version and activate it.</li><li>Run ✂ Remove here again: it finds the active version clean and only removes the old versions.</li></ol></div>
      </details>
      ${preset === 'replace' ? `<div class="fc-prev-sec">${pv.emptied.length ? ` <em>Salesforce is likely to refuse it: ${pv.emptied.length} element(s) would be left empty. If it does, nothing is deleted.</em>` : ''}${pv.remaining.length ? ` <em>The field stays locked until you also fix the ${pv.remaining.length} manual place(s) in the new version.</em>` : ''} To switch the flow off instead, cancel and press <b>🗑 Delete versions · flow off</b> on its card.</div>` : `<div class="fc-prev-hd">The active v${act.num} — ${!canReplace && (!fp.previewOutcomes || fp.previewOutcomes.empty) ? 'the one way to clear it' : 'choose what happens to it'}</div>
      ${(() => {
        // Every scenario answers the same three questions in the same order (owner 2026-11-11: "kind of hard to
        // understand each scenario here"): what happens · what the flow does afterwards · what it means for the field.
        const row = (k, v, cls) => `<span class="fc-opt-row${cls ? ' ' + cls : ''}"><i>${k}</i><span>${v}</span></span>`;
        const tag = (t, cls) => `<span class="fc-opt-tag fc-opt-tag-${cls}">${t}</span>`;
        const free = 'No longer used by this flow.';
        const locked = n => `<b>Still locked</b> — ${n} place${n === 1 ? '' : 's'} in the new version still use${n === 1 ? 's' : ''} it and must be changed by hand (see “Inside the active version” above).`;
        const nOut = pv.removed.length, nEmpty = pv.emptied.length, nLeft = pv.remaining.length;
        // A way that cannot be taken is not drawn as a greyed-out card (owner 2026-11-15: no point showing an option
        // that is not available). Its reason is kept, in one folded line under the ways that can be taken.
        const whyNot = [];
        if (!canReplace) whyNot.push(['Only the field comes out', plainOff ? `Taking the field out leaves ${nEmpty} element${nEmpty === 1 ? '' : 's'} with nothing in ${nEmpty === 1 ? 'it' : 'them'}, and Salesforce refuses a version like that.` : 'There is nothing the automatic fix can take out of this version.']);
        const a = !canReplace ? '' : `<label class="fc-prev-opt"><input type="radio" name="fcActiveMode" value="replace" ${pv.emptied.length ? '' : 'checked'}>
        <span class="fc-opt"><span class="fc-opt-hd"><b>Keep the flow running — only the field comes out</b>${nEmpty ? tag('⚠ likely refused', 'warn') : nLeft ? tag('🔒 field stays locked', 'warn') : tag('✓ recommended', 'ok')}</span>
        ${`
        ${row('What happens', `A new v${fp.plan.expectNew} is deployed without the ${nOut} reference${nOut === 1 ? '' : 's'} to the field, checked to be active, and then v${act.num} is deleted.`)}
        ${row('The flow', 'Keeps running, with the same logic minus the field.')}
        ${nEmpty ? row('Risk', `Salesforce will probably refuse: ${nEmpty} element${nEmpty === 1 ? '' : 's'} would be left with nothing in ${nEmpty === 1 ? 'it' : 'them'}. If it refuses, nothing is changed. Pick this only if you will fix ${nEmpty === 1 ? 'it' : 'them'} in Flow Builder.`, 'fc-opt-row-warn') : ''}
        ${row('The field', nLeft ? locked(nLeft) : free)}`}</span></label>`;
        let b = '';
        if (fp.previewOutcomes) {
          const po = fp.previewOutcomes, one = po.outcomes.length === 1;
          const outs = po.outcomes.map(o => `“${esc(o.outcomeLabel)}” of the decision “${esc(o.decisionLabel)}”${o.decisionGone ? ' (its last outcome, so the decision goes too)' : ''}`).join('; ');
          const title = `Keep the flow running — the whole outcome${one ? '' : 's'} that rest${one ? 's' : ''} on the field come${one ? 's' : ''} out`;
          if (po.empty) whyNot.push([`The whole outcome${one ? '' : 's'} come${one ? 's' : ''} out`, `${outs}: that decision is all this flow does. Without it nothing is connected to Start, and Salesforce refuses a flow like that. Change it in Flow Builder to keep the flow running.`]);
          else b = `<label class="fc-prev-opt"><input type="radio" name="fcActiveMode" value="replace" data-outcomes="1">
        <span class="fc-opt"><span class="fc-opt-hd"><b>${title}</b>${po.remaining.length ? tag('🔒 field stays locked', 'warn') : tag('changes what the flow does', 'info')}</span>
        ${row('What happens', `${outs} ${one ? 'is' : 'are'} removed. A record that took ${one ? 'that outcome' : 'one of them'} takes the default outcome instead. A new v${fp.plan.expectNew} is deployed and checked, then v${act.num} is deleted.`)}
        ${row('The flow', `Keeps running. ${po.disconnected.length ? `<b>No longer reached, so ${po.disconnected.length === 1 ? 'it stops' : 'they stop'} running:</b> ${po.disconnected.slice(0, 8).map(n => `<code>${esc(n)}</code>`).join(', ')}${po.disconnected.length > 8 ? ` … +${po.disconnected.length - 8} more` : ''}.` : 'Every other element is still reached.'}`)}
        ${row('The field', po.remaining.length ? locked(po.remaining.length) : free)}</span></label>`;
        }
        const c = `<label class="fc-prev-opt"><input type="radio" name="fcActiveMode" value="delete">
        <span class="fc-opt"><span class="fc-opt-hd"><b>Switch the flow off and delete its versions</b>${tag('flow stops', 'bad')}</span>
        ${row('What happens', `The flow is switched off, the org is read again to confirm nothing is active, and v${act.num} is deleted with every other version that mentions the field.`)}
        ${row('The flow', '<b>Stops running.</b>')}
        ${row('The field', free)}</span></label>`;
        const why = whyNot.length ? `<details class="fc-prev-more fc-opt-whynot"><summary>Why can’t the flow keep running?</summary>${whyNot.map(([k, v]) => `<div class="fc-prev-sec"><b>${k}</b> — ${v}</div>`).join('')}</details>` : '';
        return a + b + c + why;
      })()}`}
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
    const sum = [`${pv.removed.length} pointed at ${esc(pv.to)}`, undecided.length ? `${undecided.length} left alone` : '', other.length ? `${other.length} not this field` : ''].filter(Boolean).join(' · ');
    return `<div class="fc-prev">
      <details class="fc-prev-more"><summary>Inside the active v${act.num}: ${sum}</summary>
      ${pv.removed.length ? `<div class="fc-prev-sec fc-prev-ok"><b>⇄ Pointed at ${esc(pv.to)} (${pv.removed.length})</b>
        <div class="fc-prev-note">Nothing is taken out: every condition, assignment and filter stays, reading or writing the new field.</div>${list(pv.removed, x => x.what)}</div>`
        : `<div class="fc-prev-sec fc-prev-bad"><b>⇄ Nothing in this version can be moved automatically.</b></div>`}
      ${undecided.length ? `<div class="fc-prev-sec fc-prev-bad"><b>✋ Left alone (${undecided.length}) — could not tell whose field this is</b>
        <div class="fc-prev-note">A reference is moved only when it is KNOWN to be ${esc(_selObj.api)}'s field. These sit where the object cannot be worked out (the output of an action, a value typed as text…). If one of them is this field, change it in Flow Builder — until then Salesforce keeps the field locked.</div>${list(undecided, x => x.value)}</div>` : ''}
      ${other.length ? `<div class="fc-prev-sec"><b>Not this field (${other.length})</b>
        <div class="fc-prev-note">The same field name on another object — left exactly as it is.</div>${list(other, x => `${x.value} — a field of ${x.object}`)}</div>` : ''}
      <div class="fc-prev-sec"><b>Or do it yourself.</b> ${open} In Flow Builder open <i>Toolbox → Manager</i> and search each API name shown above (<code>like_this</code>); point it at the new field, then Save As a new version and Activate. Run the fix here again afterwards — it will find the active version clean and only remove the old versions.</div>
      </details>
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
    // 2026-11-15 (close-out review round 2): the same family rule as removeFieldRefs — with Task.Region__c picked an
    // Event flow's mentions were all skipped as another object's field (sftkMdFamObj: Activity owns Task and Event)
    const obj = sftkMdFamObj(_selObj.api, _selField.api), from = _selField.api, to = _replField.api;
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
      if (await _flowNamesThisField(read.Metadata)) referencing.push(v.Id);   // object-aware (2026-11-14)
    }
    const plan = sftkFlowSurgeryPlan(versions, referencing);
    const { interviews, error: interviewCheckError } = await _flowInterviewsFor(plan.toDelete.map(v => v.id));
    const kinds = sftkFlowInterviewKinds(interviews);
    // The other way to deal with an ACTIVE version (same versions go, so the
    // same interviews apply), and a preview of the automatic fix made by the
    // REAL remover on a clone — it cannot disagree with the run.
    let planDelete = null, preview = null, previewOutcomes = null;
    if (plan.mode === 'active') {
      planDelete = sftkFlowSurgeryPlan(versions, referencing, { activeMode: 'delete' });
      try {
        const before = metaById[plan.active.id].Metadata;
        const after = JSON.parse(JSON.stringify(before));
        if (_swapOn()) {
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
          // the third way: the outcomes that rest on the field alone taken out as well (offered only when there are any)
          const afterO = JSON.parse(JSON.stringify(before)), outcomes = [];
          removeFieldRefs(afterO, _selObj.api, _selField.api, { dropOutcomes: true, out: outcomes });
          if (outcomes.length) {
            const was = sftkFlowReachable(before), now = sftkFlowReachable(afterO);
            const goneNames = new Set(outcomes.filter(o => o.decisionGone).map(o => o.decision));
            previewOutcomes = { ...sftkFlowRefPreview(before, afterO, _fieldStringTester()), outcomes,
              disconnected: [...was].filter(n => !now.has(n) && !goneNames.has(n)),
              // nothing left after Start: Salesforce refuses a flow like that (live 2026-11-10) — said, not offered
              empty: was.size > 0 && now.size === 0 };
          }
        }
      } catch (_) { preview = null; }   // no preview is a missing convenience, never a wrong one
    }
    return { flowId, flowName, defId, versions, maxNum, metaById, plan, interviews, interviewCheckError,
      planDelete, preview, previewOutcomes, builderUrl: plan.active ? _flowBuilderUrl(plan.active.id) : null,
      lines: sftkFlowSurgeryLines(plan, kinds, interviewCheckError, _swapOn() ? { swapTo: _replField.api } : null),
      linesDelete: planDelete ? sftkFlowSurgeryLines(planDelete, kinds, interviewCheckError) : null,
      rows: sftkFlowPlanRows(plan, kinds, interviewCheckError, _swapOn() ? { swapTo: _replField.api } : null),
      rowsDelete: planDelete ? sftkFlowPlanRows(planDelete, kinds, interviewCheckError) : null };
  }

  // The plan in the confirmation: short labelled rows, the full sentences under a
  // fold (user 2026-10-13: "so much text here in red. very hard to read it all").
  // cur = { rows, lines } or null while a way is still to be chosen.
  function _flowPlanBoxHtml(cur) {
    const rows = (cur && cur.rows) || [], lines = (cur && cur.lines) || [];
    return `<div class="fc-planbox" id="fcFlowPlan">
      <ol id="fcFlowLines" class="fc-plan">${rows.length
        ? rows.map(r => `<li><b class="fc-plan-k">${esc(r.k)}</b><span>${esc(r.text)}</span></li>`).join('')
        : '<li><span>Choose below what happens to the active version.</span></li>'}</ol>
      ${lines.length ? `<details class="fc-plan-full"><summary>The plan in full</summary><ol>${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ol></details>` : ''}
    </div>`;
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
      const swapping = _swapOn();
      const changes = swapping
        ? (await _flowSwap(metadata)).changed.reduce((n, c) => n + c.n, 0)
        : removeFieldRefs(metadata, _selObj.api, _selField.api, _flowDropOutcomes ? { dropOutcomes: true } : null);
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
          `Couldn't auto-remove the field from the active v${plan.active.num} of "${flowName}" — ${_flowLeftWhy(removeFieldRefs.lastLeft)}. ` +
          `Nothing was deleted. Click "Open in Flow Builder" to fix it by hand, then run ✂ Remove again for the old versions.`);
        const u = _flowBuilderUrl(plan.active.id); if (u) err.setupUrl = u;
        throw err;
      }
      delete metadata.fullName;
      const deployRes = await deployFlowViaMetadataApi(apiNameOf(plan.active.id), metadata);
      if (!deployRes || !deployRes.success) {
        const e = new Error(`Salesforce refused the fixed "${flowName}"${swapping ? ` (the version that uses ${_replField.api})` : ''}: ${deployRes?.error ? String(deployRes.error).replace(/\s+/g, ' ').slice(0, 300) : 'deploy failed'}. Nothing was deleted. Press 🗑 Delete versions · flow off on this flow (in a walk over all items: “Switch the flow off and delete its versions”), or open in Flow Builder to ${swapping ? 'change' : 'remove'} the field reference by hand.`);
        const u = _flowBuilderUrl(plan.active.id); if (u) e.setupUrl = u;
        throw e;
      }
      const ver = await _verifyFlowActivation(defId, maxNum, flowName, plan.active.id, journal, fp.versions);
      out.newVersion = ver.newVersion; out.newId = ver.newId; out.overwrote = !!ver.overwrote;
      // The new version must not mention the field either — formula and
      // decision text is outside what the auto-fix touches, so say so.
      const check = await bg({ type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid, sobject: 'Flow', id: ver.newId, _suppressError: true });
      // a re-read that FAILED is not "no more mentions" (QA 2026-11-11): unread counts as still mentioning, so the row stays open
      out.stillMentions = !check || !!check.error || !check.Metadata || flowReferencesField(check.Metadata);
      // object-aware (2026-11-14): a name match that is only another object's same-named field is not "still mentions"
      if (out.stillMentions && !swapping && check && check.Metadata) out.stillMentions = await _flowNamesThisField(check.Metadata);
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
    const dv = await _deleteFlowVersionIds(plan.toDelete.map(v => v.id).filter(id => id !== out.newId), skip, journal,
      Object.fromEntries(plan.toDelete.map(v => [v.id, `${flowName} v${v.num}${v.status ? ` (${v.status})` : ''} deleted`])));
    out.deleted = dv.deleted; out.failed = dv.failed; out.skipped = dv.skipped; out.errors.push(...dv.errors);
    // Undo (user 2026-10-31: "do it"): one version back, the way the Flows page's delete undoes
    // itself — the version that WAS active is redeployed from its restore point as the active
    // version (Salesforce numbers it anew); the fixed version stays as an obsolete version; the
    // other deleted versions are restore points under the Field Cleaner's results, and the backup
    // zip, when one was ticked, is on disk. A deleted flow interview cannot be re-created. Only
    // when the fix in fact deleted or switched off something (sftkHistoryEnd says "nothing was
    // accepted" by itself when nothing was written).
    const act = plan.active && metaById[plan.active.id];
    const activeGone = !!(plan.active && (plan.toDelete.some(v => v.id === plan.active.id) || out.deactivated));
    const zipNote = opts && opts.backup ? ' A backup zip of every deleted version was downloaded before the fix.' : '';
    if (activeGone && act && act.Metadata && (out.deleted || out.deactivated)) {
      const api = apiNameOf(plan.active.id);
      const md = JSON.parse(JSON.stringify(act.Metadata)); delete md.fullName; md.status = 'Active';
      const safeApi = api.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      // the proof: an ACTIVE version that is not the fixed one. When every version went (the
      // flow-off way), Salesforce re-creates the flow from the zip as v1 — so never "a number above".
      const notFixed = out.newVersion ? ` AND VersionNumber != ${Number(out.newVersion)}` : '';
      out.undo = {
        steps: [{
          describe: `${flowName}: restore v${plan.active.num} — the version that used the field — as the active version`,
          // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
          msg: { type: 'SF_METADATA_DEPLOY', zipBase64: buildFlowZip(api, md) },
          verify: { query: `SELECT Id, Status, VersionNumber FROM Flow WHERE Definition.DeveloperName = '${safeApi}' AND Status = 'Active'${notFixed}`,
            tooling: true, count: 1, retries: 4,
            text: { ok: `${flowName}: the version that used the field is back and active — verified by re-reading the org`,
                    bad: `${flowName}: the deploy was accepted, but the org shows no new active version yet` } },
        }],
        // the undo's result prints this after "not restored:" — so it opens with what stays out
        note: `${[gone.length > 1 ? `the other ${gone.length - 1} deleted version(s), kept under ↩ Restore points in Activity` : '', out.interviewsDeleted ? `${out.interviewsDeleted} deleted flow interview(s), which cannot be re-created` : ''].filter(Boolean).join('; ') || 'nothing else — one version was deleted'}. What comes back: v${plan.active.num}, the one that was active, as the active version (Salesforce numbers it anew)${out.newVersion ? `; the fixed v${out.newVersion} stays as an obsolete version` : ''}.${zipNote}`,
      };
    } else {
      out.undo = { none: `the flow versions that used the field were deleted, and a deleted flow version cannot be re-created (Salesforce keeps no Recycle Bin for them); their metadata is kept under ↩ Restore points in Activity, from where a version can be put back as a draft.${zipNote}` };
    }
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
  // Does the flow name THIS object's field (2026-11-14, release QA)? flowReferencesField matches the name alone, so a
  // version that held only Get_Contact.SFTK_MX_Region__c counted for Account.SFTK_MX_Region__c: ✂ reported "still
  // mentions" after a complete fix, and the plan picked such a version for deletion (Salesforce then accepted the
  // field's delete with it active — proof it was not Account's). The name-only answer is refined by the ⇄ engine's
  // object-aware probe (sftkFlowReplaceField, the one _flowSwap uses, which also reads merge fields in free text):
  // false only when that probe POSITIVELY puts every mention on another object. Anything it cannot place, a mention
  // it does not see at all, or a probe that fails keeps the name-only true — the safe direction.
  async function _flowNamesThisField(metadata) {
    if (!flowReferencesField(metadata)) return false;
    try {
      // 2026-11-15 (close-out review round 2): Task / Event custom field = Activity's (sftkMdFamObj). Without it the
      // probe put an Event flow's Task.Region__c on "another object", the plan found no referencing version and the
      // row was marked fixed with the flow still holding the field.
      const obj = sftkMdFamObj(_selObj.api, _selField.api), from = _selField.api, to = 'SFTK_Owner_Probe__c';
      let r = sftkFlowReplaceField(JSON.parse(JSON.stringify(metadata)), obj, from, to);
      if (r.needs && r.needs.length) {
        const owners = new Map();
        for (const need of r.needs) owners.set(_chainKey(need.rootObj, need.rels), await _chainOwner(need.rootObj, need.rels));
        r = sftkFlowReplaceField(JSON.parse(JSON.stringify(metadata)), obj, from, to, {
          chainOwner: (root, rels) => { const v = owners.get(_chainKey(root, rels)); return v === undefined ? null : v; } });
      }
      return _flowProbeSaysThis(r);
    } catch (_) { return true; }
  }
  function _flowProbeSaysThis(r) {
    const skipped = (r && r.skipped) || [];
    const other = skipped.filter(x => x && x.why === 'other').length;
    return !r || (r.changed || []).length > 0 || skipped.length > other || other === 0;
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
      // a lookup that FAILED is not "no old versions" (QA 2026-11-11): the row was marked ✅ Done and Delete unlocked
      // while an old version still held the field. Counted as still blocking, so the row stays open.
      if (!defId) { out.stillBlocking = 1; out.unread = String((defRes && defRes.error) || 'the flow was not found'); return out; }
      // …then list every version of it.
      const verRes = await bg({
        type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true,
        query: `SELECT Id, Status, VersionNumber FROM Flow WHERE DefinitionId = '${defId}' ORDER BY VersionNumber DESC`
      });
      if (!verRes || verRes.error || verRes.incomplete) { out.stillBlocking = 1; out.unread = String((verRes && verRes.error) || 'the list of versions came back incomplete'); return out; }
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
        if (read?.error || !read?.Metadata) { out.stillBlocking++; out.unread = `v${v.VersionNumber} could not be read (${String((read && read.error) || 'no metadata')})`; continue; }
        if (!(await _flowNamesThisField(read.Metadata))) continue;   // object-aware (2026-11-14)
        stale.push(v);
        // a restore point of every version that goes — this path (the inspector's "✂ Remove selected") had none,
        // while its History note said the versions' metadata is kept under ↩ Restore points
        await _snapshotFix('Flow', v.Id, `${flowName} v${v.VersionNumber}`, read.FullName, read.Metadata);
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
            return `⏸ <strong>${w.head}</strong> sit on the old versions that still reference the field.` +
              '<div class="sftk-cf-plan"><ol class="sftk-cf-rows">' +
              '<li><b>Why first</b><span>Salesforce refuses to delete a version while they exist, so they are deleted first</span></li>' +
              (w.cost ? w.cost.split('; ').map(c => `<li><b>Cost</b><span>${c}</span></li>`).join('') : '') + '</ol></div>'; })(), needsCheckbox: true },
          confirmLabel: '🗑 Delete interviews, then the versions',
          production: gate.production ? { label: gate.label } : null,
        });
        if (!ok) { out.stillBlocking = stale.length; return out; }
        const di = await _deleteFlowInterviews(interviews, journal);
        for (const id of di.failedVersionIds) skip.add(id);
      } else if (ivErr && window.SFToolkitDebug?.enabled) {
        window.SFToolkitDebug.log('fields', 'warn', `Paused-interview check failed for "${flowName}"`, ivErr);
      }
      const dv = await _deleteFlowVersionIds(stale.map(v => v.Id), skip, journal,
        Object.fromEntries(stale.map(v => [v.Id, `${flowName} v${v.VersionNumber}${v.Status ? ` (${v.Status})` : ''} deleted`])));
      out.purged = dv.deleted; out.failed = dv.failed + dv.skipped; out.stillBlocking = dv.failed + dv.skipped;
    } catch (e) {
      if (window.SFToolkitDebug?.enabled) {
        window.SFToolkitDebug.log('fields', 'error',
          `Old-version purge for "${flowName}" failed`, e.message);
      }
    }
    return out;
  }

  // Why ✂ took nothing out of a flow, from removeFieldRefs.lastLeft — the true place, not a guess.
  function _flowLeftWhy(left) {
    const bits = [];
    for (const w of ((left && left.whole) || [])) {
      // 2026-11-14 review: the decision outcome / formula / record-variable element that was left is named too.
      if (w.why === 'outcome') { bits.push(`the field is the only condition of the outcome ${w.name} — taking it out would remove a path of the flow`); continue; }
      if (w.why === 'outcomeLogic') { bits.push(`the field is in the outcome ${w.name}, whose numbered condition logic would point at a condition that is gone`); continue; }
      if (w.why === 'formula') { bits.push(`the formula "${w.name}" names the field in an expression the auto-fix does not rewrite`); continue; }
      if (w.why === 'queried') { bits.push(`"${w.name}" still queries the field because {!${w.via}.${_selField ? _selField.api : 'the field'}} is read elsewhere in the flow (a text the auto-fix does not rewrite)`); continue; }
      if (w.why === 'input') { bits.push(`"${w.name}" works on a record variable whose object cannot be told from the flow, so it is not edited`); continue; }
      const what = w.start ? 'the trigger\'s entry condition (Start)' : `the filter of "${w.name}"`;
      bits.push(w.why === 'only'
        ? `the field is the only condition of ${what} — taking it out would make it act on every record`
        : `the field is in ${what}, whose numbered filter logic would point at a condition that is gone`);
    }
    if (left && left.other && left.other.length) bits.push(`${left.other.join(', ')} ${left.other.length === 1 ? 'is' : 'are'} another object's same-named field, left alone`);
    // each untellable mention with its own reason (2026-11-14 review 4: every one was called "a custom lookup", false for
    // a What / Who, a Parent that can be any object, or a resource the flow does not resolve)
    if (left && left.unknown && left.unknown.length) {
      const by = {};
      for (const r of left.unknown) { const k = (left.unknownKind && left.unknownKind[r]) || ''; (by[k] = by[k] || []).push(r); }
      const VIA = { custom: 'through a custom lookup', poly: 'through a What / Who or a Parent that can be any object',
        root: 'from a resource whose object the flow does not tell', '': 'through a relationship whose object the flow does not tell' };
      for (const k of Object.keys(by)) bits.push(`${by[k].join(', ')} ${by[k].length === 1 ? 'reaches' : 'reach'} the field ${VIA[k] || VIA['']} — whose field it is cannot be told from the flow, so it is not edited`);
    }
    if (!bits.length) bits.push('the reference is in a path the auto-fix can\'t safely change (a variable default, a text template, or another place it does not edit)');   // decisions / formulas are named above (2026-11-14)
    return bits.join('; ');
  }

  // Remove all direct references to objApi.fieldApi from flow metadata JSON.
  // Returns the number of references removed. Decisions and formula text are
  // intentionally skipped — changing branching logic or formulas automatically
  // is too risky; the user has to remove those by hand in Flow Builder.
  function removeFieldRefs(metadata, objApi, fieldApi, opts) {
    let changes = 0;
    const fl       = fieldApi.toLowerCase();

    // Whose field a reference names (2026-11-14): a bare <field> belongs to the element's own object, and
    // "con.Region__c" to the object of the resource "con". Without this, ✂ on Account.Region__c also stripped
    // Contact.Region__c from a Get Records on Contact — a deploy that succeeds and quietly widens another query.
    // The resolver is the one ⇄ Replace uses (sftk-fieldreplace.js, loaded before this file); when it is missing,
    // or a root cannot be resolved, the reference is matched as before.
    // 2026-11-15 (close-out review): a custom field picked on Task / Event is Activity's, and the sibling's too —
    // objL is only ever asked "is this object ours" (sftkMdIsOwnObj), and Activity owns both.
    const objL   = sftkMdFamObj(objApi, fieldApi).toLowerCase();
    const resObj = typeof sftkFlowResourceObjects === 'function' ? sftkFlowResourceObjects(metadata) : null;
    // A Record Update / Create that works on a record variable (inputReference) carries no <object>: its object is
    // the variable's (2026-11-14 review: { inputReference: 'con' } on a Contact variable passed the check and ✂
    // Account.Region__c stripped Contact's Region__c). Resolved through the flow's own resources; when it cannot be
    // resolved the element is left whole and named in the refusal ('input').
    // The WHOLE reference is followed, not only its root (2026-11-14 review 5, round 3): { inputReference:
    // '$Record.Account' } in a Contact flow writes the related ACCOUNT record, and its bare <field> entries are
    // Account's. Reading the root alone took them for Contact's, so ✂ Contact.Region__c stripped the Account's
    // Region__c (another object's field) and ✂ Account.Region__c missed it with no reason given. The hops go
    // through the ONE shared resolver (sftkRelWalk), as ⇄ follows them; a hop that cannot be told (a custom …__r,
    // What / Who) answers null, so the element is left whole and named ('input').
    const inputObj = el => {
      const segs = String(el.inputReference).toLowerCase().split('.');
      const root = segs[0];
      let base = null;
      if (resObj && resObj.get(root)) base = String(resObj.get(root)).toLowerCase();
      else {
        const v = (metadata.variables || []).find(x => x && String(x.name).toLowerCase() === root && x.objectType);
        if (v) base = String(v.objectType).toLowerCase();
        else if ((root === '$record' || root === '$record__prior') && metadata.start && metadata.start.object) base = String(metadata.start.object).toLowerCase();
      }
      if (!base) return null;
      const r = sftkRelWalk(base, segs.slice(1));
      return r.kind ? null : r.obj;
    };
    const onObj  = el => {
      if (el && !el.object && el.inputReference) {
        const o = inputObj(el);
        if (o) return sftkMdIsOwnObj(o, objL);   // a Task record holds Activity's fields (review 5, round 3)
        const named = [...(el.inputAssignments || []).map(a => a && a.field), ...(el.filters || []).map(f => f && f.field)]
          .some(f => f != null && String(f).toLowerCase() === fl);
        if (named) leftAlone.whole.push({ el, why: 'input' });
        return false;
      }
      // sftkMdIsOwnObj, not ===: a Task / Event element or trigger holds Activity's custom fields — it was skipped
      // silently while cleaning Activity.Region__c (2026-11-14 review 5, round 3)
      return !el || !el.object || sftkMdIsOwnObj(el.object, objL);
    };

    // A path longer than two segments travels through relationships ($Record.Owner.Region__c is User's field,
    // $Record.Parent.Region__c on Account is Account's): only the standard relationships whose object is fixed can be
    // followed by the ONE shared resolver (sftkRelHop / sftkRelWalk / sftkRelGlobal in sftk-relmap.js, 2026-11-14 —
    // this function kept a private copy of the map that drifted from the others); a custom lookup (Thing__r) cannot be
    // told from the metadata, so it is never edited — it stays reported. A BARE name is a field only under a key that
    // holds a field (<field>, queriedFields); as a reference (assignToReference, elementReference …) a bare name is a
    // flow resource — a variable called Region__c is not the field (2026-11-14 review: both were stripped and counted).
    const startObjL = metadata && metadata.start && metadata.start.object ? String(metadata.start.object).toLowerCase() : '';
    const leftAlone = { other: new Set(), unknown: new Map(), whole: [] };   // what ✂ will not touch, and why (unknown: ref → kind)
    let unknownKind = null;   // why the last 'unknown' answer could not be told: 'custom' | 'poly' | 'root'
    // 'this' | 'other' | 'unknown' | null (not this field's name)
    function ownerOfRef(ref, asField) {
      unknownKind = null;
      if (ref == null) return null;
      const parts = String(ref).toLowerCase().split('.');
      if (parts[parts.length - 1] !== fl) return null;
      if (parts.length === 1) return asField ? 'this' : null;
      const root = parts[0];
      let rels = parts.slice(1, -1);
      let cur = resObj && resObj.get(root) ? String(resObj.get(root)).toLowerCase()
        : ((root === '$record' || root === '$record__prior') && startObjL) ? startObjL : null;
      // a global that names its object ($User.X is User's, $Setup.Obj.X Obj's…), read as the formulas and email
      // templates read it (2026-11-14): $User.Region__c used to be taken for this object's field when the root was
      // not a flow resource. A global that names no object ($Flow, $Api…) is matched as before.
      if (!cur) {
        const gl = sftkRelGlobal(parts.slice(0, -1));
        if (gl && gl.obj) { cur = gl.obj; rels = parts.slice(gl.from, -1); }
      }
      if (!rels.length) {
        if (cur) return sftkMdIsOwnObj(cur, objL) ? 'this' : 'other';   // $Record of a Task flow: Activity's field too (round 3)
        // a two-segment path on a root the flow does not resolve to an object (an Apex-defined variable, a screen or
        // action output…) cannot be told: left alone with that reason, as ⇄ (sftkFlowReplaceField) and the Lightning
        // pages leave it. 2026-11-14 review 5: it was "matched as before", so ✂ stripped wrap.Region__c of an Apex
        // class (not a field at all) or another object's field.
        unknownKind = 'root'; return 'unknown';
      }
      if (!cur) { unknownKind = 'root'; return 'unknown'; }
      // 2026-11-14 review 4: a standard hop missing from the map (Asset, Entitlement, ServiceContract, Individual…) is a
      // lookup named for its object, as _sftkMdSwapToken / _sftkTplForeign take it. It used to answer 'unknown', so ✂
      // left $Record.Entitlement.Region__c in a Case flow while cleaning Entitlement.Region__c and called it "a custom
      // lookup", which was false. Only a custom …__r, a What / Who, or a Parent that can be any object stay untellable.
      const r = sftkRelWalk(cur, rels);
      if (r.kind) { unknownKind = r.kind; return 'unknown'; }
      return sftkMdIsOwnObj(r.obj, objL) ? 'this' : 'other';
    }
    function refMatches(ref, asField) {
      const who = ownerOfRef(ref, asField);
      if (who === 'other') leftAlone.other.add(String(ref));
      else if (who === 'unknown') leftAlone.unknown.set(String(ref), unknownKind);
      return who === 'this';
    }
    const fieldMatches = f => refMatches(f, true);

    function strip(arr, testFn) {
      if (!Array.isArray(arr)) return arr;
      const before = arr.length;
      const after  = arr.filter(item => !testFn(item));
      changes += before - after.length;
      return after;
    }

    // The <filters> of Start / Get / Update / Delete Records (2026-11-14). Mirrors the decision guard below: a
    // condition on the field goes only when others are left to stand on and the logic is a plain AND / OR. A
    // numbered logic ("1 AND (2 OR 3)") would still name a condition that is gone, and Salesforce refuses the
    // version; taking out the ONLY condition makes the element act on every record of the object (an Update or
    // Delete of every Account, a trigger on every save). Such an element is left whole, so the scan reports it.
    function stripFilters(el) {
      const fs = el && el.filters;
      if (!Array.isArray(fs)) return;
      const hit = fs.filter(f => fieldMatches(f && f.field)).length;
      if (!hit) return;
      if (hit === fs.length) { leftAlone.whole.push({ el, why: 'only' }); return; }
      if (!/^(and|or)$/i.test(String(el.filterLogic || 'and').trim())) { leftAlone.whole.push({ el, why: 'logic' }); return; }
      el.filters = fs.filter(f => !fieldMatches(f && f.field));
      changes += hit;
    }

    // ── start — record-triggered flow entry criteria + assignments ──────
    // Very common for fields used in "trigger when …" conditions. A start on another object is not ours.
    if (metadata.start && typeof metadata.start === 'object' && onObj(metadata.start)) {
      stripFilters(metadata.start);
      // Some flows have `start.schedule.filters` or `start.scheduledPaths[].filters`
      if (Array.isArray(metadata.start.scheduledPaths)) {
        for (const sp of metadata.start.scheduledPaths) {
          stripFilters(sp);
        }
      }
    }

    // ── recordLookups — filter conditions, output assignments, queried fields (only on the field's own object)
    const qDropped = [];   // [{ el, before, n }] — queriedFields taken out, checked again at the end
    for (const el of (metadata.recordLookups || [])) {
      if (!onObj(el)) continue;
      stripFilters(el);
      el.outputAssignments = strip(el.outputAssignments, a => fieldMatches(a.field));
      const qBefore = el.queriedFields;
      el.queriedFields     = strip(el.queriedFields,     f => fieldMatches(f));
      if (Array.isArray(qBefore) && qBefore.length !== el.queriedFields.length) qDropped.push({ el, before: qBefore, n: qBefore.length - el.queriedFields.length });
    }

    // ── recordCreates — field assignments
    for (const el of (metadata.recordCreates || [])) {
      if (!onObj(el)) continue;
      el.inputAssignments = strip(el.inputAssignments, a => fieldMatches(a.field));
    }

    // ── recordUpdates — filter conditions + field assignments
    for (const el of (metadata.recordUpdates || [])) {
      if (!onObj(el)) continue;
      stripFilters(el);
      el.inputAssignments = strip(el.inputAssignments, a => fieldMatches(a.field));
    }

    // ── recordDeletes — filter conditions
    for (const el of (metadata.recordDeletes || [])) {
      if (!onObj(el)) continue;
      stripFilters(el);
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

    // ── decisions — an outcome loses the conditions that test the field, when it has others to stand on
    // (user 2026-11-10: "יכול להיות בפלואו אחד עשרות פורמולות ועשרות decisions" — one decision that tests the field
    // kept the whole flow "by hand"). Left alone, and so still reported as by hand: an outcome whose ONLY
    // conditions are the field's (taking them out would delete a path of the flow), and an outcome with a
    // numbered logic ("1 AND (2 OR 3)"), where dropping a condition would renumber the rest.
    const condIsRef = c => refMatches(c && c.leftValueReference) || refMatches(c && c.rightValue && c.rightValue.elementReference);
    for (const el of (metadata.decisions || [])) {
      for (const rule of (el.rules || [])) {
        if (!Array.isArray(rule.conditions)) continue;
        const hit = rule.conditions.filter(condIsRef).length;
        // An outcome left as it is goes into leftAlone, so the refusal names it (2026-11-14 review: only the
        // foreign mentions were named, and the outcome that really kept the field in the flow was not).
        const outName = `"${rule.label || rule.name}" of the decision "${el.label || el.name}"`;
        if (!hit) continue;
        if (hit === rule.conditions.length) {
          if (!(opts && opts.dropOutcomes)) leftAlone.whole.push({ name: outName, why: 'outcome' });
          continue;
        }
        if (!/^(and|or)$/i.test(String(rule.conditionLogic || 'and').trim())) { leftAlone.whole.push({ name: outName, why: 'outcomeLogic' }); continue; }
        rule.conditions = rule.conditions.filter(c => !condIsRef(c));
        changes += hit;
      }
    }

    // ── decisions, the outcome itself — ONLY when the user chose it in the confirm (user 2026-11-10: "1." — an
    // outcome that rests on the field alone can go as a whole: what went down it goes to the default outcome, and
    // the flow keeps running on a new version). A decision left with no outcome at all goes too, and whatever
    // pointed at it points at where its default outcome led. opts.out collects what was taken out, for the dialog.
    if (opts && opts.dropOutcomes) {
      const goneDecisions = [];
      for (const el of (metadata.decisions || [])) {
        const keep = [];
        for (const rule of (el.rules || [])) {
          const cs = Array.isArray(rule.conditions) ? rule.conditions : [];
          if (cs.length && cs.every(condIsRef)) {
            changes += cs.length;
            if (opts.out) opts.out.push({ decision: el.name, decisionLabel: el.label || el.name, outcome: rule.name, outcomeLabel: rule.label || rule.name, led: (rule.connector && rule.connector.targetReference) || '', defaultLabel: el.defaultConnectorLabel || 'Default outcome' });
          } else keep.push(rule);
        }
        if (keep.length !== (el.rules || []).length) { el.rules = keep; if (!keep.length) goneDecisions.push(el); }
      }
      for (const d of goneDecisions) {
        const to = (d.defaultConnector && d.defaultConnector.targetReference) || '';
        (function walk(x) {
          if (!x || typeof x !== 'object') return;
          if (Array.isArray(x)) { x.forEach(walk); return; }
          for (const k of Object.keys(x)) {
            const v = x[k];
            if (v && typeof v === 'object' && !Array.isArray(v) && v.targetReference === d.name) { if (to) v.targetReference = to; else delete x[k]; }
            else walk(v);
          }
        })(metadata);
        if (metadata.startElementReference === d.name) { if (to) metadata.startElementReference = to; else delete metadata.startElementReference; }
        metadata.decisions = metadata.decisions.filter(x => x !== d);
        if (opts.out) opts.out.filter(o => o.decision === d.name).forEach(o => { o.decisionGone = true; });
      }
    }

    // ── formulas — a Boolean formula loses the conditions that use the field (the validation rule's engine,
    // sftkFormulaDropField), when what is left still tests something. Any other formula is left to the user.
    const fTok = new RegExp(`(^|[^A-Za-z0-9_])${fieldApi.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'i');
    // Whose field each {!merge field} names is judged as everywhere else in this function (2026-11-14 review 4): the bare
    // token test dropped {!con.Region__c} (con a Contact variable) on ✂ of Account.Region__c, and named a formula that
    // held only Contact's field as one that "names the field". A formula with no mention of THIS field is left as it
    // is; its other / untellable mentions are recorded for the refusal like any other reference.
    // \s* (not a literal s*): a resource named selectedCon lost its first letter and a {! $Record.X } with spaces was
    // not read at all (2026-11-14 review 4 round 3).
    const mergeRefs = t => [...String(t).matchAll(/{!\s*([$A-Za-z0-9_.]+)\s*}/g)].map(m => m[1]);
    for (const el of (metadata.formulas || [])) {
      if (typeof el.expression !== 'string' || !fTok.test(el.expression)) continue;
      if (!mergeRefs(el.expression).filter(r => refMatches(r, false)).length) continue;
      // A formula not rewritten is named in the refusal (2026-11-14 review), as one that names THIS field.
      const d = String(el.dataType || '') === 'Boolean' && typeof sftkFormulaDropField === 'function'
        ? sftkFormulaDropField(el.expression, objApi, fieldApi, t => mergeRefs(t).some(r => ownerOfRef(r, false) === 'this')) : { mode: 'none' };
      if (d.mode !== 'operand') { leftAlone.whole.push({ name: el.label || el.name || '', why: 'formula' }); continue; }
      el.expression = d.text;
      changes += d.n;
    }

    // Everything else that names the field in free text — a text or number formula, a text template, a
    // decision outcome that rests on the field alone — is NOT rewritten: it stays listed as by hand.

    // 2026-11-14 (release QA, SFTK_MX_Screen_Flow): ✂ took SFTK_MX_Region__c out of Get_Account's queriedFields while
    // a screen's display text still read {!Get_Account.SFTK_MX_Region__c} — free text this function never rewrites.
    // The new ACTIVE version then read a field its lookup no longer queries (a runtime 'field not queried' risk) and
    // still named the field. A queried field goes only when nothing left in the flow reads it through that lookup
    // (its name, or the variable it stores into); otherwise it is put back and the lookup is named as left.
    const escR = x => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 2026-11-15 (review of f0334a0): "the rest of the flow" was JSON.stringify of everything, documentation
    // included — a flow or element DESCRIPTION / label that said "Get_Account.Region__c" put the queried field
    // back, the refusal claimed a merge field "is read elsewhere", and ✂ could never clean the version. Only what
    // the flow reads counts: the keys the scan and the ⇄ engine skip (sftk-flowsurgery's SFTK_FLOW_TEXT_KEYS) are
    // skipped here too.
    // 2026-11-15 (close-out review round 2): an interview label is not only documentation — it takes merge fields
    // (the default is "<Flow> {!$Flow.CurrentDateTime}"), so {!Get_Account.Region__c} in it READS the field through
    // the lookup and the queried field must stay. Its plain text still does not count: only its {! … } are read.
    const DOC_KEYS = new Set(['description', 'label', 'interviewLabel', 'defaultConnectorLabel', 'fullName', 'processType', 'status']);
    const restText = skipEl => {
      const out = [];
      (function walk(v) {
        if (v == null || v === skipEl) return;
        if (typeof v === 'string') { out.push(v); return; }
        if (Array.isArray(v)) { v.forEach(walk); return; }
        if (typeof v === 'object') for (const k of Object.keys(v)) { if (!DOC_KEYS.has(k)) walk(v[k]); }
      })(metadata);
      if (typeof metadata.interviewLabel === 'string') for (const m of metadata.interviewLabel.matchAll(/{!\s*([$A-Za-z0-9_.]+)\s*}/g)) out.push(m[1]);
      return out.join('\n');
    };
    for (const q of qDropped) {
      const names = [q.el.name, q.el.outputReference].filter(Boolean).map(String);
      if (!names.length) continue;
      const rest = restText(q.el);
      const readVia = names.find(n => new RegExp(`(?<![A-Za-z0-9_$])${escR(n)}\\.${escR(fieldApi)}(?![A-Za-z0-9_])`, 'i').test(rest));
      if (!readVia) continue;
      q.el.queriedFields = q.before;
      changes -= q.n;
      leftAlone.whole.push({ name: q.el.label || q.el.name || '', via: readVia, why: 'queried' });
    }

    // What was left alone and why, for the refusal text when nothing could be taken out (2026-11-14 review: a
    // trigger's only entry condition was reported as "a decision condition, formula expression, or variable default").
    removeFieldRefs.lastLeft = {
      other: [...leftAlone.other], unknown: [...leftAlone.unknown.keys()], unknownKind: Object.fromEntries(leftAlone.unknown),
      whole: leftAlone.whole.map(w => ({ start: !!w.el && w.el === metadata.start, name: w.name || (w.el && (w.el.label || w.el.name)) || '', why: w.why, ...(w.via ? { via: w.via } : {}) })),
    };

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
  // The Flows page keeps a restore point (a deployable zip) of every version it deletes (2026-10-17).
  window.sftkBuildFlowZip = buildFlowZip;
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

  // ── Report type fix ─────────────────────────────────────────
  // No Tooling read and no REST retrieve for a report type: its XML is read
  // with SOAP readMetadata and written back with the same REST deploy the
  // layouts use. The edit is on the text (sftk-mdapi.js); a restore point
  // and the History undo both redeploy the XML exactly as it was read.
  const _rxEsc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function buildReportTypeZip(fullName, fileXml) {
    const enc = new TextEncoder();
    return window.sftkBuildStoredZip(sftkRtZipFiles(fullName, fileXml).map(f => ({ name: f.name, data: enc.encode(f.text) })));
  }
  async function readReportType(fullName) {
    const r = await bg({ type: 'SF_MD_READ', orgUrl: _orgUrl, sid: _sid, mdType: 'ReportType', fullNames: [fullName], _suppressError: true });
    if (!r || r.error) throw new Error(`Could not read report type "${fullName}": ${_feText(r?.error || 'no answer')}`);
    const rec = sftkMdExtractRecords(r.text).records.find(x => x.fullName === fullName);
    if (!rec) throw new Error(`Report type "${fullName}" was not found in the org.`);
    return rec.innerXml;
  }
  // One search layout of the selected object, read and edited (nothing written). componentId = "sl_<Object>_<tag>".
  async function _searchLayoutRead(componentId, newField) {
    const obj = _selObj.api, tag = String(componentId).slice(`sl_${obj}_`.length);
    const r = await bg({ type: 'SF_MD_READ', orgUrl: _orgUrl, sid: _sid, mdType: 'CustomObject', fullNames: [obj], _suppressError: true });
    if (!r || r.error) throw new Error(`the object could not be read (${_feText((r && r.error) || 'no answer')})`);
    const rec = sftkMdExtractRecords(r.text).records.find(x => x.fullName === obj);
    if (!rec) throw new Error(`${obj} was not found in the org`);
    return { ...sftkSearchLayoutEdit(rec.innerXml, obj, _selField.api, tag, newField || null), tag, obj, inner: rec.innerXml };
  }
  // ✂ / ⇄ on a search layout (2026-11-10): the object's file is deployed with the layout changed, re-read to verify,
  // and the layout as it was goes into History's undo.
  async function fixSearchLayout(componentId, componentName) {
    const obj = _selObj.api, field = _selField.api;
    const setupUrl = `${_orgUrl.replace(/\/$/, '')}/lightning/setup/ObjectManager/${encodeURIComponent(obj)}/${fcSearchLayoutsPage()}/view`;
    const fail = text => { const e = new Error(text); e.setupUrl = setupUrl; return e; };
    // a packaged object too (owner 2026-11-17: "i want it to work as well. i dont want the user to edit manually"): its
    // search layouts are the subscriber's to change, and Salesforce accepts the deploy (read live on npc that day)
    const swap = _swapOn(), swapTo = swap ? _replField.api : '';
    const ed = await _searchLayoutRead(componentId, swapTo);
    if (!ed.n) throw fail(`The “${componentName}” search layout of ${obj} no longer lists ${field} — re-scan.`);
    const pkg = '<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata"><types><members>' + obj + '</members><name>CustomObject</name></types><version>62.0</version></Package>';
    const zipAfter = _zipOf([{ name: 'package.xml', text: pkg }, { name: `objects/${obj}.object`, text: ed.file }]);
    const back = sftkSearchLayoutEdit(ed.inner, obj, '__sftk_none__', ed.tag, null);   // the file as it is now: nothing matches, nothing changes
    const zipBefore = _zipOf([{ name: 'package.xml', text: pkg }, { name: `objects/${obj}.object`, text: back.file }]);
    const j = sftkHistoryBegin({ tool: 'Field Cleaner', title: `🔎 Search layout — ${obj} “${componentName}” (${obj}.${field} ${swap ? `→ ${swapTo}` : 'removed'})`, orgUrl: _orgUrl });
    let wr;
    try {
      // confirmed-by: fixOne's sftkConfirmDestructive (the only caller)
      // The write discipline (sftk-write.js): the deploy is the write; the verify re-reads the object — the layout
      // must not list the field any more (and, on a swap, must list the new one).
      wr = await sftkWriteVerified({
        describe: `${obj} search layout “${componentName}”`,
        journal: j,
        write: async () => {
          const r = await bg({ type: 'SF_METADATA_DEPLOY', orgUrl: _orgUrl, sid: _sid, zipBase64: zipAfter, _suppressError: true });
          return (r && r.success) ? r : { error: (r && r.error) || 'the deploy was not accepted' };
        },
        verify: async () => {
          for (let i = 0; i < 3; i++) {
            try {
              const now = await _searchLayoutRead(componentId, null);
              const gone = !sftkSearchLayoutHits(now.inner, obj, field).some(h => h.tag === ed.tag);
              const hasNew = !swap || sftkSearchLayoutHits(now.inner, obj, swapTo).some(h => h.tag === ed.tag);
              if (gone && hasNew) return { ok: true, text: null };
            } catch (_) { /* read again */ }
            await new Promise(res => setTimeout(res, 1200));
          }
          return { ok: false, text: null };
        },
      });
      if (wr.accepted && wr.ok) return `✅ Search layout updated · ${swap ? (ed.newAlreadyThere ? `${swapTo} was already a column, so the old one was removed` : `${swapTo} now sits where ${field} was`) : 'the column is removed'} — verified by re-reading the org`;
      if (wr.accepted) throw fail(`The deploy was accepted, but on re-read the “${componentName}” search layout still lists ${field} — check it in Setup.`);
      throw fail(`Salesforce won't accept the search layout update (${_feText(String((wr.raw && wr.raw.error) || 'refused'))}). Nothing was changed — take the column out in Setup.`);
    } finally {
      await sftkHistoryEnd(j, { undo: wr && wr.accepted
        ? { steps: [{
            describe: `Put the “${componentName}” search layout of ${obj} back the way it was`,
            // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the SOAP re-read below
            msg: { type: 'SF_METADATA_DEPLOY', zipBase64: zipBefore },
            verify: { msg: { type: 'SF_MD_READ', mdType: 'CustomObject', fullNames: [obj] },
              pattern: `<${ed.tag}>(?:${_rxEsc(obj)}\\.)?${_rxEsc(field)}</${ed.tag}>`, flags: 'i', retries: 3,
              text: { ok: `The “${componentName}” search layout lists ${field} again — verified by re-reading the org`,
                      bad: `The deploy was accepted, but on re-read the search layout does not list ${field} yet` } },
          }] }
        : { none: 'nothing was accepted by Salesforce, so there is nothing to undo' } });
    }
  }
  async function fixReportType(componentId, componentName) {
    const row = (_lastScan?.deps || []).find(d => d.MetadataComponentType === 'ReportType' && d.MetadataComponentId === componentId);
    const setupUrl = `${_orgUrl.replace(/\/$/, '')}/lightning/setup/CustomReportTypes/home`;
    const fail = text => { const e = new Error(text); e.setupUrl = setupUrl; return e; };
    const fullName = (row && row._fullName) || (/^070/.test(String(componentId)) ? null : componentId);
    if (!fullName) throw fail(`"${componentName}" came from the dependency index by id, and a report type is read by its developer name — remove the column in Setup → Report Types, then re-scan.`);
    if (row && row._managed) throw fail(`"${componentName}" belongs to the managed package ${row._managed} and cannot be edited here — if the package allows it, remove the column in Setup → Report Types.`);
    const before = await readReportType(fullName);
    const obj = _selObj.api, field = _selField.api;
    const swap = _swapOn();
    const swapTo = swap ? _replField.api : '';
    // 2026-11-15 (close-out review round 3): the scan lists a type by the FAMILY object (sftkMdFamObj: a custom field
    // picked on Task / Event is Activity's, and an Activities report type keeps it under <table>Activity</table>).
    // The remover, the verify and the undo's pattern were left on the picked object, so the row the scan listed was
    // refused as "another table's field, which is not this field" — untrue. famObj edits and verifies; obj is for the texts.
    const famObj = sftkMdFamObj(obj, field);
    const res = swap ? sftkRtReplaceField(before, famObj, field, swapTo) : sftkRtRemoveField(before, famObj, field);
    // A column reaching the field through a lookup (Parent.Field) is never edited here — which
    // object it reaches cannot be told from the XML — and it keeps the type naming the field, so
    // the deploy would only half-do the job: refused whole, with the column named (2026-11-14).
    if (res.viaLookup && res.viaLookup.length) throw fail(`"${componentName}" also has ${res.viaLookup.join('; ')} — a column reached through a lookup is not edited here (it may be another object’s field of the same name). Remove or change it in Setup → Report Types, then re-scan.`);
    if (!res.changed) throw fail(`"${componentName}" has no column of ${obj}.${field}${res.skipped.length ? ` — the same field name appears under another table (${res.skipped.join('; ')}), which is not this field` : ''}. Check it in Setup → Report Types.`);
    // Restore point FIRST — the fix is only offered with a way back.
    await _snapshotFix('ReportType', componentId, componentName, fullName, { innerXml: before });
    const zipAfter  = buildReportTypeZip(fullName, sftkMdRecordFileXml('ReportType', res.xml));
    const zipBefore = buildReportTypeZip(fullName, sftkMdRecordFileXml('ReportType', before));
    // History (sftk-history.js): one journal for this button press; the undo
    // redeploys the XML as it was read.
    const j = sftkHistoryBegin({ tool: 'Field Cleaner', title: `📑 Report type — "${componentName}" (${obj}.${field} ${swap ? `→ ${swapTo}` : 'removed'})`, orgUrl: _orgUrl });
    let wr;
    try {
      // confirmed-by: fixOne's sftkConfirmDestructive (the only caller)
      // The write discipline (sftk-write.js): the deploy is the write, a SOAP
      // re-read of the type is the verify — the column must be gone (and, on
      // a swap, the new one there).
      wr = await sftkWriteVerified({
        describe: `"${componentName}" report type`,
        journal: j,
        write: async () => {
          const r = await bg({ type: 'SF_METADATA_DEPLOY', orgUrl: _orgUrl, sid: _sid, zipBase64: zipAfter, _suppressError: true });
          return (r && r.success) ? r : { error: (r && r.error) || 'the deploy was not accepted' };
        },
        verify: async () => {
          let after;
          try { after = await readReportType(fullName); } catch (_) { return { ok: false, text: null }; }
          const gone = sftkRtMentions(after, famObj, field) === 0;
          const hasNew = !swap || res.newAlreadyThere || sftkRtMentions(after, famObj, swapTo) > 0;
          return { ok: gone && hasNew, text: null };
        },
      });
      if (wr.accepted && wr.ok) {
        const bits = [];
        // a swap renames what it can and drops a column whose renamed form was already on the type (a plain one or a
        // lookup path such as Parent.X) — both counts are said (review 2, 2026-11-14: a dropped Parent column went unsaid)
        if (swap && res.swapped) bits.push(`${res.swapped} column${res.swapped === 1 ? '' : 's'} now name${res.swapped === 1 ? 's' : ''} ${swapTo}`);
        if (swap && res.dropped) bits.push(`${res.dropped === 1 ? 'an old column was' : `${res.dropped} old columns were`} removed instead — the column it would have become was already on the type (a column may appear once)`);
        if (!swap) bits.push(`${res.removed} column${res.removed === 1 ? '' : 's'} removed`);   // ✂ only: a swap returns no `removed` (review 3, 2026-11-14)
        if (res.emptied.length) bits.push(`section${res.emptied.length === 1 ? '' : 's'} ${res.emptied.map(l => `“${l}”`).join(', ')} held only that column and ${res.emptied.length === 1 ? 'was' : 'were'} removed too`);
        if (res.skipped.length) bits.push(`left alone: ${res.skipped.join('; ')} (another table’s field of the same name)`);
        return `✅ Report type updated · ${bits.join(' · ')} — verified by re-reading the org`;
      }
      if (wr.accepted) throw fail(swap
        ? `"${componentName}" was deployed, but on re-read it does not show ${swapTo} in place of the column — check it in Setup → Report Types.`
        : `"${componentName}" was deployed but still lists the column on re-read — check it in Setup → Report Types.`);
      throw fail(`Salesforce won't accept the report type update for "${componentName}" (${_feText(String((wr.raw && wr.raw.error) || 'refused'))}). Click "Open in Setup" to remove the column by hand.`);
    } finally {
      await sftkHistoryEnd(j, { undo: wr && wr.accepted
        ? { steps: [{
            describe: `Put "${componentName}" report type back the way it was before this fix`,
            // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the
            // SOAP re-read below — the column of this object's field must be back
            msg: { type: 'SF_METADATA_DEPLOY', zipBase64: zipBefore },
            verify: { msg: { type: 'SF_MD_READ', mdType: 'ReportType', fullNames: [fullName] },
              pattern: `<field>${_rxEsc(field)}</field>\\s*<table>${famObj === 'Activity' ? '(?:Activity|Task|Event)' : _rxEsc(obj)}</table>`, flags: 'i', retries: 3,
              text: { ok: `"${componentName}": the column of ${obj}.${field} is back — verified by re-reading the org`,
                      bad: `"${componentName}": the deploy was accepted, but on re-read the column is not there yet` } },
          }] }
        : { none: 'nothing was accepted by Salesforce, so there is nothing to undo' } });
    }
  }

  // ── 🗑 Delete a blocker as a whole ──────────────────────────────────────
  // User 2026-11-07: "כל מה שחייב להיות מוסר כדי להסיר שדה חייב להיות מחיק
  // בלחיצת כפתור". One engine for every kind Salesforce refuses the field
  // delete for (sftk-mdapi.js: the type table): the component's full
  // definition is read FIRST and kept as the restore point, a
  // destructiveChanges deploy removes it, a re-read proves it is gone, and
  // ↩ Undo in History (or ↩ Restore under the results) deploys the saved
  // definition back. Code (Apex, Visualforce) and bundles (LWC, Aura) are
  // kept as their sources and put back the same way. A duplicate rule is
  // never deleted here (the standing rule), a lookup filter and the lead
  // mapping are edited, not deleted.
  const _zipOf = files => { const enc = new TextEncoder(); return window.sftkBuildStoredZip(files.map(f => ({ name: f.name, data: enc.encode(f.text) }))); };
  const _AURA_FILE = { COMPONENT: n => `${n}.cmp`, APPLICATION: n => `${n}.app`, EVENT: n => `${n}.evt`, INTERFACE: n => `${n}.intf`, TOKENS: n => `${n}.tokens`,
    CONTROLLER: n => `${n}Controller.js`, HELPER: n => `${n}Helper.js`, RENDERER: n => `${n}Renderer.js`, STYLE: n => `${n}.css`, DOCUMENTATION: n => `${n}.auradoc`, DESIGN: n => `${n}.design`, SVG: n => `${n}.svg` };
  // The full name the Metadata API knows the row by: the legs that read by
  // name put it in the id; an index row carries a Tooling Id, which answers
  // with its FullName; a matching rule is a plain record with a developer name.
  // custom setting record rows of the last scan: id15 → { sobject, cols } (what ✂ Remove needs to read and write)
  const _csRows = new Map();
  // Two 👀 kinds the delete engine's table does not hold (owner 2026-11-16: "we said all items must have a
  // delete/remove"): an email alert that only SENDS a template naming the field is deleted as the email alert it is;
  // a custom setting record gets the field's name taken out of its value (a data write, undone by writing it back).
  function _extraDeleteSpec(type, id) {
    if (type === 'EmailAlertViaTemplate') { const w = typeof sftkMdDeleteSpec === 'function' ? sftkMdDeleteSpec('WorkflowAlert') : null; return w ? { ...w, asType: 'WorkflowAlert' } : null; }
    if (type === 'CustomSettingRecord' && _csRows.has(String(id || '').slice(0, 15))) return { type, mdType: 'CustomSettingRecord', what: 'custom setting value', special: 'settingValue', edit: 'settingValue' };
    return null;
  }
  async function _deleteFullName(type, componentId, spec) {
    const row = (_lastScan?.deps || []).find(d => d.MetadataComponentType === type && d.MetadataComponentId === componentId);
    if (row && row._fullName) return row._fullName;
    const id = String(componentId || '');
    const looksLikeId = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/.test(id);
    if ((type === 'MatchingRule' || type === 'DuplicateRule' || type === 'ListView') && looksLikeId) {
      const q = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: false, _suppressError: true, query: `SELECT DeveloperName, SobjectType FROM ${type} WHERE Id = '${id}'` });
      const r = q && !q.error ? (q.records || [])[0] : null;
      if (r) return `${r.SobjectType}.${r.DeveloperName}`;
    }
    if (spec.special === 'lookupFilter') return (row && row._lookupFieldName) || id;
    if (spec.tooling && looksLikeId) {
      const g = await bg({ type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid, sobject: spec.tooling, id, _suppressError: true });
      if (g && !g.error) {
        // a child type without FullName on its Tooling record (live 2026-11-07: FieldSet) is "<Object>.<DeveloperName>"
        let ent = g.EntityDefinitionId || g.TableEnumOrId || g.SobjectType || '';
        // on a CUSTOM object (an org's own or a package's) the Tooling record names its object by ID (01I…), and a
        // full name built from that was "not found in the org" (live 2026-11-10: a field set on dlrs__LookupChild__c)
        if (!g.FullName && /^01I[A-Za-z0-9]{12,15}$/.test(String(ent))) {
          const e = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: true, _suppressError: true, query: `SELECT QualifiedApiName FROM EntityDefinition WHERE DurableId = '${String(ent).slice(0, 15)}' OR DurableId = '${String(ent)}' LIMIT 1` });
          const api = e && !e.error && e.records && e.records[0] ? e.records[0].QualifiedApiName : '';
          if (api) ent = api;
        }
        const fn = g.FullName || (spec.parent && ent && g.DeveloperName ? `${ent}.${g.DeveloperName}` : (g.DeveloperName || g.Name));
        if (fn) return String(fn);
      }
    }
    return id;
  }
  // "Gone" for code and bundles: a Tooling query by name, tried a few times —
  // live 2026-11-07, the classes were deleted but a read straight after the
  // deploy still answered (the index lags a moment behind a destructive deploy).
  const _goneByQuery = async query => {
    for (let i = 0; i < 5; i++) {
      const q = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true, _suppressError: true, query });
      if (q && !q.error && !(q.records || []).length) return true;
      await new Promise(r => setTimeout(r, 1500));
    }
    return false;
  };
  // What puts the component back: the files of a redeploy, and how to check it is there again.
  async function _deleteRestorePlan(type, componentId, fullName, spec) {
    const obj = _selObj.api, field = _selField.api;
    const toolingGet = (sobject, id) => bg({ type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid, sobject, id, _suppressError: true });
    // a lookup filter: only the filter goes, the lookup field and its data stay. Live 2026-11-07: a Tooling
    // PATCH of the field is refused ("insufficient access rights on cross-reference id"); a deploy of the
    // field inside its object file WITHOUT the <lookupFilter> removes it, and the original XML puts it back.
    if (spec.special === 'settingValue') {
      const info = _csRows.get(String(componentId).slice(0, 15));
      if (!info || !/^[A-Za-z0-9_]+$/.test(info.sobject) || !info.cols.every(c => /^[A-Za-z0-9_]+$/.test(c))) throw new Error('this custom setting record is not in the last scan — re-scan');
      const q = `SELECT Id, ${info.cols.join(', ')} FROM ${info.sobject} WHERE Id = '${String(componentId).replace(/[^A-Za-z0-9]/g, '')}'`;
      const read = async () => { const a = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: false, _suppressError: true, query: q }); return (a && !a.error) ? ((a.records || [])[0] || false) : null; };
      const rec = await read();
      if (rec === null) throw new Error('the custom setting record could not be read — nothing is changed without the value to put back');
      if (!rec) throw new Error('the custom setting record is not there any more — re-scan');
      const shown = [], before = {}, after = {};
      for (const c of info.cols) {
        const was = rec[c], now = fcSettingValueWithout(was, obj, field, _swapOn() ? _replField.api : null);
        if (typeof was !== 'string' || now === was) continue;
        shown.push({ col: c, before: was, after: now }); before[c] = was; after[c] = now === '' ? null : now;
      }
      if (!shown.length) throw new Error('the value does not hold the field’s name any more — re-scan');
      const path = `services/data/v62.0/sobjects/${info.sobject}/${rec.Id}`;
      return { files: null, patch: { path, body: after }, undoPatch: { path, body: before }, shown,
        verify: { query: q, tooling: false, pick: 'records.0', field: shown[0].col, equals: shown[0].before },
        gone: async () => { const a = await read(); return !!a && shown.every(x => (a[x.col] == null ? '' : String(a[x.col])) === x.after); } };
    }
    if (spec.special === 'lookupFilter') {
      if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(fullName)) throw new Error(`the lookup field behind "${fullName}" could not be worked out — re-scan`);
      const r = await bg({ type: 'SF_MD_READ', orgUrl: _orgUrl, sid: _sid, mdType: 'CustomField', fullNames: [fullName], _suppressError: true });
      if (!r || r.error) throw new Error(`the lookup field "${fullName}" could not be read (${_feText(r?.error || 'no answer')}) — nothing is changed without a restore point`);
      const rec = sftkMdExtractRecords(r.text).records.find(x => x.fullName === fullName);
      if (!rec) throw new Error(`the lookup field "${fullName}" was not found in the org — re-scan`);
      const res = sftkMdLookupFilterRemove(rec.innerXml);
      if (!res.removed) throw new Error(`"${fullName}" has no lookup filter any more — re-scan`);
      const read = async () => { const a = await bg({ type: 'SF_MD_READ', orgUrl: _orgUrl, sid: _sid, mdType: 'CustomField', fullNames: [fullName], _suppressError: true }); if (!a || a.error) return null; return sftkMdExtractRecords(a.text).records.find(x => x.fullName === fullName) || false; };
      return { files: sftkMdPackageFiles('CustomField', fullName, rec.innerXml), deployFiles: sftkMdPackageFiles('CustomField', fullName, res.xml),
        verify: { msg: { type: 'SF_MD_READ', mdType: 'CustomField', fullNames: [fullName] }, pattern: '<lookupFilter>', flags: 'i', retries: 3 },
        gone: async () => { const a = await read(); return !!a && !sftkMdFindElement(a.innerXml, 'lookupFilter', 0); } };
    }
    // the lead field mapping: the line of this field goes, the settings and every other line stay (a deploy of the edited XML)
    if (spec.edit === 'leadMapping') {
      const r = await bg({ type: 'SF_MD_READ', orgUrl: _orgUrl, sid: _sid, mdType: spec.mdType, fullNames: [fullName], _suppressError: true });
      if (!r || r.error) throw new Error(`the lead field mapping could not be read (${_feText(r?.error || 'no answer')}) — nothing is changed without a restore point`);
      const rec = sftkMdExtractRecords(r.text).records.find(x => x.fullName === fullName);
      if (!rec) throw new Error('the lead field mapping was not found in the org — re-scan');
      const res = sftkMdLeadMappingRemove(rec.innerXml, obj, field);
      if (!res.removed) throw new Error(`no mapping of ${obj}.${field} is in the lead field mapping any more — re-scan`);
      const read = async () => { const a = await bg({ type: 'SF_MD_READ', orgUrl: _orgUrl, sid: _sid, mdType: spec.mdType, fullNames: [fullName], _suppressError: true }); if (!a || a.error) return null; return sftkMdExtractRecords(a.text).records.find(x => x.fullName === fullName) || false; };
      return { files: sftkMdPackageFiles(type, fullName, rec.innerXml), deployFiles: sftkMdPackageFiles(type, fullName, res.xml), removed: res.removed,
        verify: { msg: { type: 'SF_MD_READ', mdType: spec.mdType, fullNames: [fullName] }, pattern: `<(inputField|outputField)>${_rxEsc(field)}</(inputField|outputField)>`, flags: 'i', retries: 3 },
        gone: async () => { const a = await read(); return !!a && !sftkMdLeadMappingsFor(a.innerXml, obj, field).length; } };
    }
    // a Process Builder process: every version goes (switched off first); the latest version's XML is the restore point
    if (spec.special === 'pb') {
      const card = spec.card, defId = (_flowVerInfo[String(card.primaryId).substring(0, 15)] || {}).defId;
      if (!defId) throw new Error(`the definition of "${card.name}" could not be worked out — re-scan`);
      const dq = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true, _suppressError: true, query: `SELECT DeveloperName FROM FlowDefinition WHERE Id = '${defId}'` });
      const devName = dq && !dq.error && (dq.records || [])[0] ? dq.records[0].DeveloperName : null;
      if (!devName) throw new Error(`the API name of "${card.name}" could not be read — nothing is deleted without a restore point`);
      const r = await bg({ type: 'SF_MD_READ', orgUrl: _orgUrl, sid: _sid, mdType: 'Flow', fullNames: [devName], _suppressError: true });
      if (!r || r.error) throw new Error(`"${card.name}" could not be read (${_feText(r?.error || 'no answer')}) — nothing is deleted without a restore point`);
      const rec = sftkMdExtractRecords(r.text).records.find(x => x.fullName === devName);
      if (!rec) throw new Error(`"${card.name}" was not found in the org — re-scan`);
      return { files: sftkMdPackageFiles('ProcessBuilder', devName, rec.innerXml), pb: { defId, devName, versions: card.versions.slice(), active: !!card.active },
        verify: { query: `SELECT Id FROM Flow WHERE Definition.DeveloperName = '${devName.replace(/'/g, "\\'")}'`, tooling: true, pick: 'records', count: 1 },
        gone: () => _goneByQuery(`SELECT Id FROM Flow WHERE DefinitionId = '${defId}'`) };
    }
    // code and bundles: the same read the inspector and the code editor use (one place knows the Tooling shapes)
    if (spec.code || spec.bundle) {
      const c = await _codeRead(type, componentId, fullName, spec);
      return { files: c.files, verify: { query: c.byName, tooling: true, pick: 'records', count: 1 }, gone: () => _goneByQuery(c.byName) };
    }
    // an assignment / auto-response / escalation rule has no readMetadata of its own (live 2026-11-08): read through its container
    const rd = await _mdReadOne(type, fullName, spec.mdType);
    if (!rd || rd.error) throw new Error(`"${fullName}" could not be read (${_feText((rd && rd.error) || 'no answer')}) — nothing is deleted without a restore point`);
    const rec = rd.rec;
    if (!rec) throw new Error(`"${fullName}" was not found in the org as a ${spec.what} — re-scan, it may be gone already`);
    let innerXml = rec.innerXml;
    if (type === 'DuplicateRule') {
      // a rule put back takes the LAST sort order of its object (live 2026-11-07: the restore was refused,
      // "SortOrder must be in sequential order from 1"); the count now, with the rule still there, is that place
      const q = await bg({ type: 'SF_QUERY', orgUrl: _orgUrl, sid: _sid, tooling: false, _suppressError: true, query: `SELECT COUNT(Id) n FROM DuplicateRule WHERE SobjectType = '${fullName.split('.')[0]}'` });
      const n = (q && !q.error && Number(((q.records || [])[0] || {}).n)) || 1;
      // the rule's OWN sortOrder is the last one in the XML — the filter items carry a sortOrder of their own first
      const at = innerXml.lastIndexOf('<sortOrder>');
      const so = at >= 0 ? sftkMdFindElement(innerXml, 'sortOrder', at) : null;
      if (so) innerXml = innerXml.slice(0, so.bodyStart) + String(n) + innerXml.slice(so.bodyEnd);
    }
    const files = sftkMdPackageFiles(type, fullName, innerXml);
    const read = async () => { const a = await _mdReadOne(type, fullName, spec.mdType); if (!a || a.error) return null; return a.rec || false; };
    const inBox = !!_RULE_CONTAINERS[type];
    return { files, verify: { msg: _mdReadMsg(type, fullName, spec.mdType), pattern: `<fullName>${_rxEsc(inBox ? fullName.slice(fullName.indexOf('.') + 1) : fullName)}</fullName>`, flags: 'i', retries: 3 }, gone: async () => (await read()) === false };
  }
  async function fixDelete(type, componentId, componentName) {
    const cfg = TYPE_CFG[type] || TYPE_CFG_DEFAULT;
    const pbCard = type === 'Flow' ? _flowCards.find(c => c.primaryId === String(componentId) && c.pb) : null;
    const spec = pbCard ? { type: 'Flow', mdType: 'Flow', what: 'Process Builder process', special: 'pb', card: pbCard }
      : type === 'LookupFilter' ? { type, mdType: 'CustomField', what: 'lookup filter', special: 'lookupFilter' }
      : (sftkMdDeleteSpec(type) || _extraDeleteSpec(type, componentId));
    const engType = spec && spec.asType ? spec.asType : type;   // the kind the delete engine reads and deploys
    if (!spec || spec.noDelete) throw new Error(`A ${cfg.label || type} is not deleted from here — clear it in Setup.`);
    const obj = _selObj.api, field = _selField.api;
    const gate = await sftkOrgWriteGate(_orgUrl);
    // a custom setting value: read now, so the confirmation shows the value as it is and as it will be
    let prePlan = null;
    if (spec.special === 'settingValue') {
      try { prePlan = await _deleteRestorePlan(engType, componentId, String(componentId), spec); }
      catch (e) { appendInlineError(componentId, e.message); return; }
    }
    const special = spec.special === 'settingValue'
      ? `${_swapOn() ? `⇄ <strong>The field’s name in the value becomes ${esc(_replField.api)}</strong>` : '✂ <strong>Only the field’s name is taken out of the value</strong>'} — the record and whatever else the value holds stay. This is a write to the record’s data; the value as it is now is kept, and ↩ Undo in Activity writes it back.`
        + `<div class="sftk-cf-plan"><ol class="sftk-cf-rows">${prePlan.shown.map(x => `<li><b>${esc(x.col)}</b><span><code>${esc(x.before)}</code> → ${x.after ? `<code>${esc(x.after)}</code>` : '<i>empty</i>'}</span></li>`).join('')}</ol></div>`
      : spec.special === 'lookupFilter'
      ? `✂ <strong>Only the filter is removed from the lookup field</strong> — the field itself and its data stay. The field’s definition is read first and kept as a <strong>restore point</strong>; ↩ Undo in Activity (and ↩ Restore points, in Activity) puts the filter back.`
      : spec.edit === 'leadMapping'
        ? `✂ <strong>Only the mapping line of ${esc(obj)}.${esc(field)} is removed</strong> — the other mappings and the conversion settings stay. The settings are read first and kept as a <strong>restore point</strong>; ↩ Undo in Activity (and ↩ Restore points, in Activity) puts the line back.`
        : spec.special === 'pb'
          ? `🗑 <strong>Every version of the process is deleted</strong> — it is switched off first if it runs. Its latest version is read first and kept as a <strong>restore point</strong>; ↩ Undo in Activity (and ↩ Restore points, in Activity) deploys it back as a new, inactive version — activate it in Setup if you need it to run again.`
          : type === 'EmailAlertViaTemplate'
            ? `🗑 <strong>The email alert is deleted from the org</strong>. It does not name ${esc(obj)}.${esc(field)} itself — it sends a template that does; fixing the template (under Email Templates) keeps the alert. Salesforce refuses the delete while a workflow rule, a flow or an approval process still uses the alert. Its full definition is read first and kept as a <strong>restore point</strong>; ↩ Undo in Activity (and ↩ Restore points, in Activity) deploys it back.`
          : `🗑 <strong>The ${esc(spec.what)} is deleted from the org</strong> — not just its reference to ${esc(obj)}.${esc(field)}. Its full definition is read first and kept as a <strong>restore point</strong>; ↩ Undo in Activity (and ↩ Restore points, in Activity) deploys it back.${spec.code ? ' In a production org Salesforce may run the org’s Apex tests before it deletes code.' : ''}${type === 'MatchingRule' ? ' A matching rule a duplicate rule still uses is refused by Salesforce — delete that duplicate rule first.' : ''}${type === 'DuplicateRule' ? ' <strong>A duplicate rule guards the org’s data</strong> — nothing here switches one off or edits one behind a deployment; deleting it is yours to decide, here, with a way back.' : ''}`;
    const verb = (spec.special === 'settingValue' && _swapOn()) ? 'Replace' : (spec.special === 'lookupFilter' || spec.edit) ? 'Remove' : 'Delete';
    const vIcon = verb === 'Replace' ? '⇄' : verb === 'Remove' ? '✂' : '🗑', vDone = verb === 'Replace' ? 'replaced' : verb === 'Remove' ? 'removed' : 'deleted';
    const sure = await sftkConfirmDestructive({
      title: `${verb} ${spec.what} — ${cfg.label || type}`,
      icon: vIcon,
      items: [{ label: componentName, sub: spec.what }],
      // no "I understand this is permanent" tick (owner 2026-11-15): it is not permanent — the definition is kept as a
      // restore point and ↩ Undo deploys it back, as the text above says. The org-name gate of a production org stays.
      revOverride: { html: special, needsCheckbox: false, cls: 'sftk-rev-newver' },
      undoHint: 'Undo in Activity',
      confirmLabel: `${vIcon} ${verb} the ${spec.what}`,
      production: gate.production ? { label: gate.label } : null,
    });
    if (!sure) return 'cancel';
    _rowBusy(componentId, '⏳ reading…');
    let fullName, plan;
    try {
      fullName = prePlan ? String(componentId) : await _deleteFullName(engType, componentId, spec);
      plan = prePlan || await _deleteRestorePlan(engType, componentId, fullName, spec);
    } catch (e) { _rowBusy(componentId, null); appendInlineError(componentId, e.message); return; }
    await _snapshotFix('MdDelete', componentId, componentName, fullName, { type, mdType: spec.mdType, what: spec.what, files: plan.files || null, patch: plan.undoPatch || null, verify: plan.verify });
    _rowBusy(componentId, verb === 'Replace' ? '⏳ replacing…' : verb === 'Remove' ? '⏳ removing…' : '⏳ deleting…');
    const zipBack = plan.files ? _zipOf(plan.files) : null;
    const zipDel = plan.deployFiles ? _zipOf(plan.deployFiles) : (plan.patch || plan.pb) ? null : _zipOf(sftkMdDestructiveFiles([[spec.mdType, fullName]]));
    const j = sftkHistoryBegin({ tool: 'Field Cleaner', title: `${vIcon} ${cfg.label || type} — "${componentName}" ${vDone} (${obj}.${field})`, orgUrl: _orgUrl });
    let wr, ranTests = false;
    try {
      // confirmed-by: the sftkConfirmDestructive right above
      // The write discipline (sftk-write.js): the destructive deploy (or the
      // edit's deploy, the field's PATCH, the process's version deletes) is
      // the write, a re-read of the component is the verify — gone is done.
      wr = await sftkWriteVerified({
        describe: `"${componentName}" ${spec.what}`,
        journal: j,
        write: async () => {
          if (plan.patch) { const r = await bg({ type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid, _suppressError: true, ...plan.patch }); return (r && !r.error) ? { success: true } : { error: (r && r.error) || 'the update was not accepted' }; }
          if (plan.pb) {
            if (plan.pb.active) { const off = await bg({ type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid, _suppressError: true, path: `services/data/v62.0/tooling/sobjects/FlowDefinition/${plan.pb.defId}`, body: { Metadata: { activeVersionNumber: 0 } } }); if (off && off.error) return { error: `switching it off: ${off.error}` }; }
            for (const v of plan.pb.versions) { const d = await bg({ type: 'SF_TOOLING_DELETE', orgUrl: _orgUrl, sid: _sid, sobject: 'Flow', id: v.id, _suppressError: true }); if (d && d.error) return { error: `v${v.num}: ${d.error}` }; }
            return { success: true };
          }
          let r = await bg({ type: 'SF_METADATA_DEPLOY', orgUrl: _orgUrl, sid: _sid, zipBase64: zipDel, _suppressError: true });
          // production + Apex: Salesforce wants the org's tests run before code goes
          if (spec.code && r && !r.success && /test|coverage/i.test(String(r.error || ''))) { ranTests = true; r = await bg({ type: 'SF_METADATA_DEPLOY', orgUrl: _orgUrl, sid: _sid, zipBase64: zipDel, testLevel: 'RunLocalTests', _suppressError: true }); }
          return (r && r.success) ? r : { error: (r && r.error) || 'the deploy was not accepted' };
        },
        verify: async () => { try { return { ok: await plan.gone(), text: null }; } catch (_) { return { ok: false, text: null }; } },
      });
      if (wr.accepted && wr.ok) {
        _afterDelete(spec.special === 'pb' ? 'ProcessBuilder' : type);
        if (spec.special === 'settingValue' && verb === 'Replace') return `✅ Replaced — ${plan.shown.map(x => x.col).join(', ')} now name${plan.shown.length === 1 ? 's' : ''} ${_replField.api}; the record stays — verified by re-reading the org`;
        if (spec.special === 'settingValue') return `✅ Removed — the field’s name is out of ${plan.shown.map(x => x.col).join(', ')}; the record stays — verified by re-reading the org`;
        if (spec.special === 'lookupFilter') return `✅ Removed — the lookup filter is gone, the field stays — verified by re-reading the org`;
        if (spec.edit === 'leadMapping') return `✅ Removed — ${plan.removed} mapping line${plan.removed === 1 ? '' : 's'} of ${obj}.${field} gone, the other mappings kept — verified by re-reading the org`;
        if (spec.special === 'pb') return `✅ Deleted — all ${plan.pb.versions.length} version${plan.pb.versions.length === 1 ? '' : 's'} of the process gone${plan.pb.active ? ' (it was switched off first)' : ''} — verified by re-reading the org`;
        return `✅ Deleted — the ${spec.what} is gone${ranTests ? ' (the org’s Apex tests ran first)' : ''} — verified by re-reading the org`;
      }
      if (wr.accepted) throw new Error(`"${componentName}" — the ${verb.toLowerCase()} was accepted, but on re-read the ${spec.what} is still there. Re-scan, and check it in Setup.`);
      throw new Error(`Salesforce won't ${verb.toLowerCase()} the ${spec.what} "${componentName}" (${_feText(String((wr.raw && wr.raw.error) || 'refused'))}). Clear it in Setup, then re-scan.`);
    } finally {
      await sftkHistoryEnd(j, { undo: wr && wr.accepted
        ? { steps: [{
            describe: `Put the ${spec.what} "${componentName}" back as it was before the ${verb.toLowerCase()}`,
            // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read in `verify`
            msg: plan.undoPatch ? { type: 'SF_PATCH', ...plan.undoPatch } : { type: 'SF_METADATA_DEPLOY', zipBase64: zipBack },
            verify: { ...plan.verify, text: { ok: `"${componentName}": the ${spec.what} is back — verified by re-reading the org`, bad: `"${componentName}": the deploy was accepted, but on re-read the ${spec.what} is not there yet` } },
          }] }
        : { none: 'nothing was accepted by Salesforce, so there is nothing to undo' } });
    }
  }
  // ── ✂ Remove / ⇄ Replace INSIDE a blocker (user 2026-11-07: "we try to remove, replace the field in the
  // metadata items without breaking them. While showing XML") ─────────────────────────────────────────────
  // Read (SOAP) → the pure edit (sftkMdEditField: only the field's own places change, or a refusal with the
  // reason) → the XML before/after in the confirm → restore point → deploy of the edited record → re-read
  // (the field's places are gone / point at the new field) → History undo deploys the record as it was.
  // Assignment, auto-response and escalation rules have no readMetadata of their own (live 2026-11-08:
  // "UNKNOWN_EXCEPTION: unexpected metadata"); they are read through their object's container.
  const _RULE_CONTAINERS = { AssignmentRule: ['AssignmentRules', 'assignmentRule'], AutoResponseRule: ['AutoResponseRules', 'autoResponseRule'], EscalationRule: ['EscalationRules', 'escalationRule'] };
  function _mdReadMsg(type, fullName, mdType) {
    const rc = _RULE_CONTAINERS[type];
    const dot = String(fullName).indexOf('.');
    return rc ? { type: 'SF_MD_READ', mdType: rc[0], fullNames: [String(fullName).slice(0, dot)] } : { type: 'SF_MD_READ', mdType, fullNames: [fullName] };
  }
  async function _mdReadOne(type, fullName, mdType) {
    const msg = _mdReadMsg(type, fullName, mdType);
    const r = await bg({ ...msg, orgUrl: _orgUrl, sid: _sid, _suppressError: true });
    if (!r || r.error) return { error: (r && r.error) || 'no answer' };
    const rc = _RULE_CONTAINERS[type];
    if (!rc) return { rec: sftkMdExtractRecords(r.text).records.find(x => x.fullName === fullName) || null };
    const short = String(fullName).slice(String(fullName).indexOf('.') + 1);
    const box = sftkMdExtractRecords(r.text).records.find(x => x.fullName === msg.fullNames[0]);
    const ch = box ? sftkMdChildren(box.innerXml, rc[1]).find(c => c.fullName === short) : null;
    return { rec: ch ? { fullName, innerXml: ch.innerXml } : null };
  }
  // The before/after of an edit as a line diff; long unchanged runs fold to a count.
  function _xmlDiffHtml(beforeXml, afterXml) {
    const d = sftkMdLineDiff(sftkMdPretty(beforeXml), sftkMdPretty(afterXml));
    const keep = new Set();
    d.forEach((x, i) => { if (x.op !== ' ') for (let k = i - 2; k <= i + 2; k++) keep.add(k); });
    let out = '', skipped = 0;
    const flush = () => { if (skipped) out += `<span class="xd-line xd-fold">  … ${skipped} unchanged line${skipped === 1 ? '' : 's'}</span>`; skipped = 0; };
    d.forEach((x, i) => {
      if (x.op === ' ' && !keep.has(i)) { skipped++; return; }
      flush();
      out += `<span class="xd-line xd-${x.op === '+' ? 'add' : x.op === '-' ? 'del' : 'eq'}">${x.op === ' ' ? ' ' : x.op} ${esc(x.line)}</span>`;
    });
    flush();
    return `<pre class="fc-xml-pre fc-xml-diff">${out}</pre>`;
  }
  // Does this XML still name `f`? (the probe rename is never deployed) A refusal is "no" only when the engine KNOWS
  // the field is not there: a "cannot tell whose field" refusal (unsure — a Lookup__r. / What. / Parent. mention
  // beside a bare one) counts as still naming it. Reading it as "no" failed the verify of a correct ⇄ and reported a
  // hand edit that still held the field as done (2026-11-14 review 6).
  // Review 7 (2026-11-14): the probe renames formula text with _sftkMdSwapToken, which also counts the name inside a
  // quoted string or a comment — but ✂ (sftkFormulaDropField) rightly keeps Name = 'Region__c' and /* Region__c */, so
  // a correct ✂ stayed "still names it" on every re-read and was reported as a failure. The formula elements are read
  // here as ✂ reads them: string literals and comments blanked first (the same two patterns sftkFormulaDropField
  // strips). Only the probe's copy is masked; a real or a cannot-tell mention outside quotes still counts (review 6).
  // A WebLink <url> is left as written: text outside {! } there is not a formula, so the safe reading is kept.
  function _editStillNames(type, xml, f) {
    if (!f) return false;
    const masked = String(xml == null ? '' : xml).replace(/(<(errorConditionFormula|formula|recordFilter|userCriteria)>)([^<]*)(<\/\2>)/g,
      (m, open, tag, body, close) => open + sftkMdEscape(sftkMdUnescape(body).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""')) + close);
    const r = sftkMdEditField(type, masked, _selObj.api, f, '__SFTK_PROBE__');
    return !r.refused || !!r.unsure;
  }
  // "✎ Edit before deploying" inside a confirm (user 2026-11-08: "we can't edit here"): a folded box with the proposed
  // text; while it is open and changed, the deploy sends what the box holds. For XML the text must stay well-formed
  // and keep its <fullName>; the Go button follows. → { html, onRender(), value() (null = untouched) }
  function _cfEditBlock(id, proposed, opts) {
    const o = opts || {};
    const pretty = o.xml ? sftkMdPretty(proposed) : String(proposed == null ? '' : proposed).replace(/\r\n?/g, '\n');
    let ta = null;
    const html = `<details class="fc-cf-edit" id="${esc(id)}"${o.open ? ' open' : ''}><summary>✎ Edit ${o.what || 'the text'} before deploying</summary>
      <textarea class="fc-xml-ta fc-cf-ta" spellcheck="false" wrap="off" aria-label="${esc(o.what || 'the text')} as it will be deployed"></textarea>
      <div class="fc-cf-edit-state ds-subtext"></div></details>`;
    const onRender = () => {
      const box = document.getElementById(id); if (!box) return;
      ta = box.querySelector('.fc-cf-ta'); const state = box.querySelector('.fc-cf-edit-state'); const go = document.getElementById('sftkConfirmGo');
      ta.value = pretty; ta.rows = Math.min(22, Math.max(6, pretty.split('\n').length + 1));
      const sync = () => {
        const changed = ta.value !== pretty;
        let bad = null;
        if (changed && o.xml) { bad = sftkMdWellFormed(ta.value); if (!bad && o.name != null && sftkMdChildText(ta.value, 'fullName') !== o.name) bad = `the <fullName> must stay “${o.name}”`; }
        state.textContent = !changed ? (o.idle || 'As proposed — change anything here and the deploy sends your text instead.') : bad ? `⚠ ${bad}` : (() => { const ops = sftkMdLineDiff(pretty, ta.value); const n = Math.max(ops.filter(x => x.op === '+').length, ops.filter(x => x.op === '-').length); return `${n} line${n === 1 ? '' : 's'} differ${n === 1 ? 's' : ''} from the proposal — your text is what will be deployed.`; })();
        state.classList.toggle('fc-cf-edit-bad', !!bad);
        if (go) go.disabled = !!bad;
      };
      ta.addEventListener('input', sync);
      ta.addEventListener('keydown', ev => { if (ev.key !== 'Tab') return; ev.preventDefault(); const s = ta.selectionStart, e = ta.selectionEnd; ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(e); ta.selectionStart = ta.selectionEnd = s + 2; sync(); });
      sync();
    };
    const value = () => (ta && ta.value !== pretty) ? ta.value : null;
    return { html, onRender, value };
  }
  async function fixEdit(type, componentId, componentName, swap) {
    const cfg = TYPE_CFG[type] || TYPE_CFG_DEFAULT;
    const ways = typeof sftkMdEditWays === 'function' ? sftkMdEditWays(type) : null;
    const nf = swap && _replOn() ? _replField.api : null;
    if (!ways) throw new Error(`A ${cfg.label || type} is not edited here — 🗑 delete it, or edit it in Setup.`);
    if (!nf && !ways.remove) throw new Error(`A ${cfg.label || type} cannot lose the field and keep working — pick a replacement field above and press ⇄ Replace, or 🗑 delete it.`);
    const spec = type === 'LookupFilter' ? { type, mdType: 'CustomField', what: 'lookup filter', special: 'lookupFilter' } : sftkMdDeleteSpec(type);
    const obj = _selObj.api, field = _selField.api;
    const verb = nf ? 'Replace' : 'Remove', ico = nf ? '⇄' : '✂';
    _rowBusy(componentId, '⏳ reading…');
    let fullName, rec;
    try {
      fullName = await _deleteFullName(type, componentId, spec);
      const rd = await _mdReadOne(type, fullName, spec.mdType);
      if (rd.error) throw new Error(`"${componentName}" could not be read (${_feText(rd.error)}) — nothing is changed without a restore point`);
      if (!rd.rec) throw new Error(`"${componentName}" was not found in the org as a ${spec.what} — re-scan, it may be gone already`);
      rec = rd.rec;
    } catch (e) { _rowBusy(componentId, null); appendInlineError(componentId, e.message); return null; }
    _rowBusy(componentId, null);
    const ed = sftkMdEditField(type, rec.innerXml, obj, field, nf);
    if (ed.refused || !ed.changed) {
      appendInlineError(componentId, `${ico} ${verb} was not done on "${componentName}": ${ed.refused || 'nothing in it names the field'}. Nothing was changed.`);
      return null;
    }
    const pkgType = type === 'LookupFilter' ? 'CustomField' : type;
    const files = sftkMdPackageFiles(pkgType, fullName, rec.innerXml);
    // ✂ on a validation rule: the user chooses IN THE DIALOG (user 2026-11-10: "אנחנו צריכים לתת למשתמש גם אפשרות
    // בחלון לכבות את הולידציה. או למחוק את השורות המוצעות. או לתת למשתמש לערוך בעצמו") — ✂ take the suggested
    // conditions out (offered when the rule can work without the field), ⏻ switch the rule off, or ✎ edit it by hand.
    // The suggestion is preselected when there is one, else the switch-off; the diff and the button follow the choice.
    const vrChoice = !nf && type === 'ValidationRule';
    const vrOffXml = vrChoice ? (() => { const el = sftkMdFindElement(rec.innerXml, 'active', 0); return el ? rec.innerXml.slice(0, el.bodyStart) + 'false' + rec.innerXml.slice(el.bodyEnd) : ed.xml; })() : null;
    let vrMode = vrChoice ? (ed.suggested ? 'remove' : 'off') : '';
    const gate = await sftkOrgWriteGate(_orgUrl);
    const inBox = !!_RULE_CONTAINERS[type];
    const cfEdit = _cfEditBlock('fcCfEdit', vrChoice ? rec.innerXml : ed.xml, { xml: true, what: 'the XML', name: inBox ? fullName.slice(fullName.indexOf('.') + 1) : fullName,
      idle: vrChoice ? 'The rule as it is now — change it here. What this box holds is what is deployed.' : '' });
    const diffHd = '<div class="fc-xml-diff-hd">The XML — <span class="xd-del">− as it is</span> · <span class="xd-add">+ as it will be</span></div>';
    const vrDiff = m => diffHd + _xmlDiffHtml(rec.innerXml, m === 'off' ? vrOffXml : ed.xml);
    const vrGo = { remove: '✂ Remove the conditions', off: '⏻ Switch the rule off', edit: '⬆ Deploy my edit' };
    const vrWay = (v, title, sub, off) => `<label class="fc-vr-way${off ? ' fc-vr-way-na' : ''}"><input type="radio" name="fcVrWay" value="${v}"${off ? ' disabled' : ''}${vrMode === v ? ' checked' : ''}><span><b>${title}</b><small>${esc(sub)}</small></span></label>`;
    const vrWays = vrChoice ? `<div class="fc-vr-ways" role="radiogroup" aria-label="What to do with the rule">
      ${vrWay('remove', '✂ Remove the field’s conditions', ed.suggested ? `${ed.how[0]}. Read the formula that is left — it changes when the rule fires.` : `Not possible: ${String(ed.how[0] || '').replace(/ — so it has to be switched off$/, '')}.`, !ed.suggested)}
      ${vrWay('off', '⏻ Switch the rule off', 'The formula stays as it is. An inactive rule does not block the delete, but it cannot be switched on again until its formula is fixed.')}
      ${vrWay('edit', '✎ Edit the rule myself', 'Change the formula by hand — exactly your text is deployed.')}
    </div><div id="fcVrDiff">${vrDiff(vrMode)}</div>` : '';
    const sure = await sftkConfirmDestructive({
      title: vrChoice ? `The field in the ${spec.what} — ${cfg.label || type}` : `${verb} the field in the ${spec.what} — ${cfg.label || type}`,
      icon: ico,
      items: [{ label: componentName, sub: spec.what }],
      // an edit with a restore point is not "permanent": the badge says where the way back is
      revOverride: { html: vrChoice
        ? `${ico} <strong>Choose what happens to the rule.</strong> The rule as it is now is kept as a <strong>restore point</strong>: ↩ Undo in Activity puts it back.`
        : `${ico} <strong>${esc(ed.how.join('; '))}.</strong> Only the field’s own places change — everything else in the ${esc(spec.what)} is deployed back exactly as Salesforce returned it. The ${esc(spec.what)} as it is now is kept as a <strong>restore point</strong>: ↩ Undo in Activity (or ↩ Restore points, in Activity) deploys it back.`, needsCheckbox: false, cls: 'sftk-rev-newver' },
      undoHint: 'Undo in Activity',
      extraHtml: vrChoice ? `${vrWays}${cfEdit.html}` : `${diffHd}${_xmlDiffHtml(rec.innerXml, ed.xml)}${cfEdit.html}`,
      confirmLabel: vrChoice ? vrGo[vrMode] : `${ico} ${verb} in the ${spec.what}`,
      production: gate.production ? { label: gate.label } : null,
      onRender: () => {
        cfEdit.onRender();
        if (!vrChoice) return;
        const go = document.getElementById('sftkConfirmGo'), box = document.getElementById('fcCfEdit'), diff = document.getElementById('fcVrDiff');
        const ta = box && box.querySelector('.fc-cf-ta');
        if (!go || !box || !diff || !ta) return;
        // ✎ needs a change to deploy: an untouched box is the rule as it is
        ta.addEventListener('input', () => { if (vrMode === 'edit' && cfEdit.value() == null) go.disabled = true; });
        const sync = () => {
          const edit = vrMode === 'edit';
          box.style.display = edit ? '' : 'none'; if (edit) box.open = true;
          diff.style.display = edit ? 'none' : '';
          if (!edit) { diff.innerHTML = vrDiff(vrMode); go.disabled = false; }
          go.textContent = vrGo[vrMode];
          if (edit) { ta.dispatchEvent(new Event('input')); ta.focus(); }
        };
        document.querySelectorAll('input[name="fcVrWay"]').forEach(r => r.addEventListener('change', () => { if (r.checked) { vrMode = r.value; sync(); } }));
        sync();
      },
    });
    if (!sure) return 'cancel';
    // a hand edit in the dialog is what gets deployed (user 2026-11-08: "we can't edit here"); on a validation rule
    // only when ✎ is the way that was chosen
    const handXml = vrChoice ? (vrMode === 'edit' ? cfEdit.value() : null) : cfEdit.value();
    if (vrChoice && vrMode === 'edit' && handXml == null) return 'cancel';
    const finalXml = handXml != null ? handXml : (vrChoice && vrMode === 'off' ? vrOffXml : ed.xml);
    const handAdded = handXml != null ? sftkMdLineDiff(sftkMdPretty(rec.innerXml), sftkMdPretty(finalXml)).filter(x => x.op === '+').map(x => x.line.trim()).filter(Boolean) : null;
    // …and the lines it took out: after the deploy the org must hold no more of each than the text that was sent
    // (user 2026-11-10: "deploy my edit, צריך לבדוק שזה באמת עבד לפני שעובר לפריט הבא" — an edit that only DELETES
    // lines used to pass the re-read with nothing checked)
    const handRemoved = handXml != null ? sftkMdLineDiff(sftkMdPretty(rec.innerXml), sftkMdPretty(finalXml)).filter(x => x.op === '-').map(x => x.line.trim()).filter(Boolean) : null;
    const _lineCount = (xml, line) => sftkMdPretty(xml).split('\n').filter(l => l.trim() === line).length;
    const vrOff = vrChoice && vrMode === 'off';
    const howDone = vrOff ? ['switched off — chosen in the dialog'] : handXml != null ? ['edited by hand in the dialog'] : ed.how;
    const deployFiles = sftkMdPackageFiles(pkgType, fullName, finalXml);
    const readMsg = _mdReadMsg(type, fullName, spec.mdType);
    const backPattern = vrOff ? '<active>true</active>' : _rxEsc(field);
    await _snapshotFix('MdEdit', componentId, componentName, fullName, { type, mdType: spec.mdType, what: spec.what, swapTo: nf, how: howDone, files, verify: { msg: readMsg, pattern: backPattern, flags: 'i', retries: 3 } });
    _rowBusy(componentId, nf ? '⏳ replacing…' : '⏳ removing…');
    const zipBack = _zipOf(files), zipEdit = _zipOf(deployFiles);
    const j = sftkHistoryBegin({ tool: 'Field Cleaner', title: `${ico} ${cfg.label || type} — "${componentName}" (${obj}.${field}${nf ? ` → ${nf}` : ' removed'})`, orgUrl: _orgUrl });
    let wr, after = null;
    try {
      // confirmed-by: the sftkConfirmDestructive right above
      // The write discipline (sftk-write.js): the deploy of the edited record is
      // the write; a re-read is the verify — the field's places are gone (or
      // point at the new field), a validation rule switched off reads inactive.
      wr = await sftkWriteVerified({
        describe: `"${componentName}" ${spec.what}`,
        journal: j,
        write: async () => {
          const r = await bg({ type: 'SF_METADATA_DEPLOY', orgUrl: _orgUrl, sid: _sid, zipBase64: zipEdit, _suppressError: true });
          return (r && r.success) ? r : { error: (r && r.error) || 'the deploy was not accepted' };
        },
        verify: async () => {
          for (let i = 0; i < 3; i++) {
            const a = await _mdReadOne(type, fullName, spec.mdType);
            if (a && a.rec) {
              after = a.rec.innerXml;
              const ok = handAdded ? (() => { const now = new Set(sftkMdPretty(after).split('\n').map(l => l.trim())); return handAdded.every(l => now.has(l)) && [...new Set(handRemoved)].every(l => _lineCount(after, l) <= _lineCount(finalXml, l)); })()
                : vrOff ? /<active>false<\/active>/i.test(after)
                : !_editStillNames(type, after, field) && (!nf || _editStillNames(type, after, nf));
              if (ok) return { ok: true, text: null };
            }
            await new Promise(res => setTimeout(res, 1200));
          }
          return { ok: false, text: null };
        },
      });
      if (wr.accepted && wr.ok) {
        // A hand edit is in the org as written — but is the item DONE? Not while it still names the field (for a
        // validation rule: names it and is still active). Then the row stays open with its buttons and says so; a
        // walk goes on to the next item with this one still counted.
        const isVr = type === 'ValidationRule' || type === 'ValidationRuleInactive';
        const stillOpen = !!handAdded && _editStillNames(type, after || finalXml, field) && !(isVr && /<active>\s*false\s*<\/active>/i.test(after || finalXml));
        if (stillOpen) throw new Error(`Your edit of "${componentName}" was deployed and is in the org (verified by re-reading it), but the ${spec.what} still names ${field}${isVr ? ' and is active' : ''} — it still stops the delete. Press ✂ again to finish it, or ↩ Undo in Activity to take the edit back.`);
        _afterDelete(type);
        const label = handAdded
          ? `✅ Deployed as you edited it in the dialog — every line you changed is in the org and ${isVr && _editStillNames(type, after || finalXml, field) ? 'the rule is inactive' : `nothing in it names ${field} any more`}, verified by re-reading it`
          : vrOff
          ? `✅ Switched off — the rule is inactive, so it no longer blocks the delete (its formula still names the field) — verified by re-reading the org`
          : `✅ ${nf ? 'Replaced' : 'Removed'} — ${ed.how.join('; ')} — verified by re-reading the org`;
        return { label, detailHtml: `<details class="fc-xml-done"><summary>The XML that was deployed</summary>${_xmlDiffHtml(rec.innerXml, after || finalXml)}</details>` };
      }
      if (wr.accepted) throw new Error(handAdded
        ? `"${componentName}" — the deploy was accepted, but on re-read the ${spec.what} does not hold your edit (three reads). It is NOT counted as done. Open 🔍 to see what the org holds, then try again.`
        : `"${componentName}" — the deploy was accepted, but on re-read the ${spec.what} still names ${field}. Re-scan, and check it in Setup.`);
      throw new Error(`Salesforce refused the edited ${spec.what} "${componentName}": ${_feText(String((wr.raw && wr.raw.error) || 'refused'))}. Nothing was changed — 🗑 delete it, or edit it in Setup.`);
    } finally {
      await sftkHistoryEnd(j, { undo: wr && wr.accepted
        ? { steps: [{
            describe: `Put the ${spec.what} "${componentName}" back as it was before the ${verb.toLowerCase()}`,
            // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read in `verify`
            msg: { type: 'SF_METADATA_DEPLOY', zipBase64: zipBack },
            verify: { msg: readMsg, pattern: backPattern, flags: 'i', retries: 3, text: { ok: `"${componentName}": the ${spec.what} is back as it was — verified by re-reading the org`, bad: `"${componentName}": the deploy was accepted, but on re-read the ${spec.what} is not back yet` } },
          }] }
        : { none: 'nothing was accepted by Salesforce, so there is nothing to undo' } });
    }
  }
  // The gate's blocker row of this kind counts one less; when every row is
  // gone the note says what to do next (a re-scan, so nothing is assumed).
  function _afterDelete(type) {
    const row = document.querySelector(`.fc-blocker-row[data-type="${CSS.escape(type)}"]`);
    if (row) {
      const b = row.querySelector('strong');
      const n = Math.max(0, (Number(b?.textContent) || 1) - 1);
      if (n === 0) row.remove(); else if (b) b.textContent = String(n);
    }
    // The count the Delete button and Salesforce's answer box read follows too (owner 2026-11-15: "salesforce would
    // accept the delete but i cant click the delete button" — the chips said every blocker was cleared, while the
    // button's lock and the answer box still counted the 14 of the scan).
    _manualBlockers = _afterDeleteCount(_manualBlockers, type);
    if (_lastScan) _lastScan.cleared = true;   // the next ask gives Salesforce time to catch up
    const box = document.querySelector('.fc-delete-zone .fc-blockers');
    const left = box ? [...box.querySelectorAll('.fc-blocker-row strong')].reduce((n, b) => n + (Number(b.textContent) || 0), 0) : 0;
    const hdr = box ? box.querySelector('.fc-blockers-hdr') : null;
    if (box && !box.querySelector('.fc-blocker-row')) {
      if (hdr) hdr.textContent = '✅ Every blocker listed here was fixed or deleted.';
      box.classList.add('fc-blockers-clear');
      box.querySelector('.fc-blockers-foot')?.remove();
    } else if (hdr) hdr.textContent = `🔒 ${left} blocker${left === 1 ? ' stops' : 's stop'} the delete`;   // the header counts down with the chips (live 2026-11-08: it said 24 after a fix)
    // the note under the gate said "N manual blocker(s) remain" from the scan — it follows the deletes (live 2026-11-07)
    const note = eid('fcDeleteNote');
    if (note && box) note.textContent = left > 0
      ? `🔒 ${left} blocker${left === 1 ? '' : 's'} remain — clear ${left === 1 ? 'it' : 'them'} below (✂ ⇄ ✎ 🗑) or in Setup, then re-scan.`
      : '✅ Every blocker listed was cleared.';
    // Nothing listed is left: Salesforce itself is asked (a check-only delete) and its answer unlocks Delete Field —
    // the same path as a list that was clear from the start, so no Re-scan has to be pressed first.
    if (left === 0 && !_manualBlockers.length) {
      if (_lastScan && _lastScan.ask) _paintAsk(_lastScan.ask);   // the box drops "the list still marks N items"
      checkEnableDelete();
    }
  }
  // one blocker of this kind is cleared: the kind counts one less, and leaves the list at zero (pure)
  function _afterDeleteCount(list, type) {
    return (list || []).map(b => b.type === type ? { ...b, count: Math.max(0, (Number(b.count) || 0) - 1) } : b).filter(b => b.count > 0);
  }

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
    const swap = _swapOn();
    const swapTo = swap ? _replField.api : '';
    // review 5 (2026-11-14): ✂ AND ⇄ check the layout is the cleaned object's own — a bare name on another object's
    // layout is that object's field, and the refusal says so instead of "not found". ⇄ asks before it edits
    // (removeFieldFromLayout on {} changes nothing): it used to rename Contact.Region__c on a Contact layout while
    // replacing Account.Region__c, and report it done.
    const lyOpts = { objApi: _selObj.api, fullName: res.FullName || res.fullName, isObject: _fcIsLoadedObject };
    if (swap) removeFieldFromLayout({}, _selField.api, lyOpts);
    if (lyOpts.refused) throw new Error(`"${componentName}": ${lyOpts.refused}.`);
    const sw = swap ? sftkLayoutReplaceField(metadata, _selField.api, swapTo, { readOnly: _replReadOnly() }) : null;
    const changes = swap ? sw.swapped + sw.blanked : removeFieldFromLayout(metadata, _selField.api, lyOpts);
    if (!swap && lyOpts.refused) throw new Error(`"${componentName}": ${lyOpts.refused}.`);
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
          const vOpts = { objApi: _selObj.api, fullName: after.FullName || after.fullName || lyOpts.fullName, isObject: _fcIsLoadedObject };
          const left = removeFieldFromLayout(JSON.parse(JSON.stringify(after.Metadata)), _selField.api, vOpts);
          // a swap is only done when the old field is gone AND the new one is there
          // (the mini layout counts too: a field listed only there is renamed there by sftkLayoutReplaceField — review 6, 2026-11-14)
          // review 7 (2026-11-14): so do relatedObjects, multilineLayoutFields, the highlights panel and related content —
          // sftkLayoutReplaceField renames there too; and a refusal on the re-read (the field is still the highlights
          // panel's only item) is NOT clean: it returned 0 and read as "verified" while the layout still named the field
          const nl = swapTo.toLowerCase(), isNew = v => String(v || '').toLowerCase() === nl, md = after.Metadata;
          const hasNew = !swap || (md.layoutSections || []).some(sec => (sec.layoutColumns || []).some(col =>
            (col.layoutItems || []).some(it => it && isNew(it.field))))
            || ((md.miniLayout && md.miniLayout.fields) || []).some(isNew)
            || (md.relatedObjects || []).some(isNew) || (md.multilineLayoutFields || []).some(isNew)
            || ((md.summaryLayout && md.summaryLayout.summaryLayoutItems) || []).some(it => it && isNew(it.field))
            || ((md.relatedContent && md.relatedContent.relatedContentItems) || []).some(it => it && it.layoutItem && isNew(it.layoutItem.field));
          return { ok: left === 0 && !vOpts.refused && hasNew, text: null };
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
        ? { steps: [_layoutUndoStep(componentId, componentName, fullName, beforeMetadata, _selObj.api, _selField.api)] }
        : { none: 'nothing was accepted by Salesforce, so there is nothing to undo' } });
    }
  }

  // The History undo step of a layout fix (2026-11-14, release QA). It was a bare Tooling PATCH of the raw pre-fix
  // layout with verify: null — the same round trip the fix itself needs sanitizeLayoutMetadata, up to 14
  // strip-and-retries and a deploy fallback for (Salesforce refuses the GET's bare-string summaryLayout,
  // platformActionList… on PATCH), so the undo was refused on those layouts, and where it went through it always
  // read "0 of 1 step verified". Now: a Metadata API deploy of the layout as it was (no sanitizing needed), re-read
  // through readMetadata until the field is on it again.
  // 2026-11-15 (review of f0334a0): this said it was the path the fix falls back to and ↩ Restore points use — it
  // was not: those (deployLayoutViaMetadataApi) deploy a second time without platformActionList / quickActionList
  // when Salesforce refuses the layout on them, and the undo sent ONE deploy, so it was refused where Restore points
  // went through. The step now carries that second deploy as `retry` (sftkHistoryUndo sends it on the same errors).
  // And the re-read looked for <field> / <fields> only, while the fix also takes the field out of
  // multilineLayoutFields and relatedObjects (a restore of only those read "does not show the field yet"), and a
  // related list's <fields> column of ANOTHER object satisfied it: both lists are in the pattern now, and the
  // <relatedLists> blocks are cut out of the re-read text before it is tested.
  // Without a full name (never seen; Tooling always returns one) it stays the PATCH, re-read by its detail endpoint.
  function _layoutUndoStep(componentId, componentName, fullName, beforeMetadata, obj, field) {
    const describe = `Put "${componentName}" layout back the way it was before this fix`;
    if (fullName) {
      return {
        describe,
        // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the readMetadata re-read below
        msg: { type: 'SF_METADATA_DEPLOY', zipBase64: buildLayoutZip(fullName, beforeMetadata) },
        // verified-by: the same readMetadata re-read below — sftkHistoryUndo sends this only when the first is refused
        retry: { when: 'ActionListContext|platformActionList|quickActionList|action list|quick action', flags: 'i',
          say: 'Salesforce refused the layout on its action lists — deploying it again without them, as the fix and Restore points do',
          msg: { type: 'SF_METADATA_DEPLOY', zipBase64: buildLayoutZip(fullName, beforeMetadata, { skip: new Set(['platformActionList', 'quickActionList']) }) } },
        verify: { msg: { type: 'SF_MD_READ', mdType: 'Layout', fullNames: [fullName] },
          pattern: `<(fields?|multilineLayoutFields|relatedObjects)>(?:${_rxEsc(obj)}\\.)?${_rxEsc(field)}</\\1>`, flags: 'i', retries: 3,
          strip: '<relatedLists>[\\s\\S]*?</relatedLists>',
          text: { ok: `"${componentName}": the layout shows ${field} again — verified by re-reading the org`,
                  bad: `"${componentName}": the deploy was accepted, but on re-read the layout does not show ${field} yet` } },
      };
    }
    return {
      describe,
      // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the detail re-read below
      msg: { type: 'SF_PATCH', path: `services/data/v62.0/tooling/sobjects/Layout/${componentId}`, body: { Metadata: beforeMetadata } },
      verify: { path: `services/data/v62.0/tooling/sobjects/Layout/${componentId}`, pick: 'Metadata',
        text: { ok: `"${componentName}": layout restored — verified by re-reading the org`,
                bad: `"${componentName}": accepted by Salesforce, but the org could not confirm the restore` } },
    };
  }

  // Is api one of the org's objects in the loaded object list? removeFieldFromLayout asks it before it calls a
  // layout prefix another object's name in a refusal (2026-11-14 review 6): a prefix not found is said to be
  // unmatched, never named as an object. A missing entry (a capped list) only softens the text; it still refuses.
  function _fcIsLoadedObject(api) {
    const a = String(api || '').toLowerCase();
    return !!a && _allObjects.some(o => String(o.api).toLowerCase() === a);
  }

  // Remove the field from every layoutItem in every section/column.
  // Replaced with emptySpace so the column structure stays valid.
  // opts (optional, 2026-11-14 review 5): { objApi, fullName } — the object being cleaned and the layout's full name
  // ("Object-Layout Name"). A layout holds only its OWN object's fields, by bare name: on a layout of another object
  // a bare Region__c is THAT object's field. When both are given and the layout's object is not objApi, nothing is
  // changed and opts.refused carries the true reason. Without them the layout is taken as the field's own, as before
  // (the scan finds layouts through the field's own dependency records). The check comes before any edit, so ⇄
  // asks it with an empty metadata ({}) — one rule for ✂, ⇄, the preview and the verify (2026-11-14 review 5).
  function removeFieldFromLayout(metadata, fieldApiName, opts) {
    let changes = 0;
    const fl = fieldApiName.toLowerCase();
    // the layout's object is the part of its full name before the first '-' (an object's API name never holds one)
    const fn = opts && opts.fullName ? String(opts.fullName) : '';
    let lo = fn.indexOf('-') > 0 ? fn.slice(0, fn.indexOf('-')).trim() : '';
    // LAYOUT_PREFIX_OBJECT — Salesforce's own layout full-name prefixes that are not an object's API name but a page
    // of one, and hold that object's fields: Close Case and Case Feed (Case), the Person Account layouts (Account),
    // the User Profile Layout UserAlt (User), and the Live Agent transcript pages LiveChatTranscriptActive /
    // LiveChatTranscriptWaiting (LiveChatTranscript). Global (the global publisher layout) belongs to no object: null.
    // Review 5 (2026-11-14): only the two Case ones were mapped, so ✂ on a PersonAccount-… or UserAlt-… layout refused
    // a correct edit and called the field PersonAccount's / UserAlt's. Review 6 (2026-11-14): the LiveChatTranscript
    // pages were refused the same way. Kept inside this function because the tests lift it out alone (fcNested).
    const LAYOUT_PREFIX_OBJECT = { caseclose: 'Case', caseinteraction: 'Case', personaccount: 'Account', useralt: 'User',
      livechattranscriptactive: 'LiveChatTranscript', livechattranscriptwaiting: 'LiveChatTranscript', global: null };
    const prefix = lo;
    const mapped = Object.prototype.hasOwnProperty.call(LAYOUT_PREFIX_OBJECT, lo.toLowerCase());
    if (mapped) lo = LAYOUT_PREFIX_OBJECT[lo.toLowerCase()] || '';
    // Own-object test through sftkMdIsOwnObj (sftk-mdapi.js, a page global): a custom field on Activity IS a field of
    // every Task and Event, so a Task-… / Event-… layout holds Activity.Region__c by its bare name. A plain string
    // compare refused every Task / Event layout for ✂ and ⇄ with a false "Task's field" (2026-11-14 review 5, round 3).
    // 2026-11-15 (close-out review): a CUSTOM field picked on Task or Event is the one Activity field both hold —
    // with Task.Region__c picked an Event-… layout was refused as "Event's field, not Task's", which is untrue
    // (the same family rule as sftkMdEditField's ownApi and the sweep's actFam). Only __c: Subject is two fields.
    const _actFam = v => /^(task|event|activity)$/i.test(String(v || '').trim());
    const ownApi = (opts && /__c$/i.test(fieldApiName) && _actFam(opts.objApi)) ? 'Activity' : (opts && opts.objApi);
    if (prefix && opts.objApi && !(lo && sftkMdIsOwnObj(lo, ownApi))) {
      // review 6 (2026-11-14): the refusal names another object only when the prefix IS one — mapped above to an
      // object, or found by opts.isObject (the caller's loaded object list). A prefix that is neither (Global, or a
      // built-in page prefix not in the map) used to be called an object ("LiveChatTranscriptActive's field"): now
      // the text says the layout's object could not be matched. Still refused — the safe direction.
      const isObj = lo && (mapped || typeof opts.isObject !== 'function' || opts.isObject(lo));
      opts.refused = isObj
        ? `this is a page layout of ${lo}, so its ${fieldApiName} is ${lo}'s field, not ${opts.objApi}'s — nothing was changed`
        : `the object of this page layout could not be matched to ${opts.objApi} (its name begins "${prefix}"), so its ${fieldApiName} may be another object's field — nothing was changed`;
      return 0;
    }

    // The highlights panel (summaryLayout.summaryLayoutItems, Case Feed) names its fields one item each. An item that
    // is this field goes whole; when it is the panel's ONLY item nothing is changed and the refusal says why — a panel
    // left with no items is not something this tool deploys blind (2026-11-14 review 7). Checked before any edit.
    const sumItems = metadata.summaryLayout && Array.isArray(metadata.summaryLayout.summaryLayoutItems) ? metadata.summaryLayout.summaryLayoutItems : null;
    if (sumItems && sumItems.some(it => it && String(it.field || '').toLowerCase() === fl)
        && sumItems.every(it => it && String(it.field || '').toLowerCase() === fl)) {
      if (opts) opts.refused = `${fieldApiName} is the only field in this layout's highlights panel (summary layout), and a panel with no fields left is not deployed by this tool — remove it in the layout editor`;
      return 0;
    }
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
    // The mini layout (hover / console mini page) lists plain field names of the layout's own
    // object. Left there, the field outlived its slot and the fix's verify — this same
    // function on the re-read — still called the layout clean (2026-11-14).
    const mf = metadata.miniLayout && metadata.miniLayout.fields;
    if (Array.isArray(mf)) {
      const kept = mf.filter(x => String(x).toLowerCase() !== fl);
      changes += mf.length - kept.length;
      metadata.miniLayout.fields = kept;
    }
    // The layout's other lists of its OWN object's fields (2026-11-14 review 7): the console mini page's lookup fields
    // (relatedObjects), the fields shown multi-line (multilineLayoutFields), the highlights panel (summaryLayout, its
    // only-item case refused above) and the mini view's related content (relatedContent.relatedContentItems[].layoutItem).
    // Only layoutSections and miniLayout.fields were read, so a layout naming the field in one of these was reported
    // done — and verified, as the verify reruns this function on the re-read — while it still named it.
    // relatedLists / miniLayout.relatedLists hold the related objects' fields and are left alone.
    for (const key of ['relatedObjects', 'multilineLayoutFields']) {
      const arr = metadata[key];
      if (!Array.isArray(arr)) continue;
      const kept = arr.filter(x => String(x).toLowerCase() !== fl);
      changes += arr.length - kept.length;
      metadata[key] = kept;
    }
    if (sumItems) {
      const kept = sumItems.filter(it => !(it && String(it.field || '').toLowerCase() === fl));
      changes += sumItems.length - kept.length;
      metadata.summaryLayout.summaryLayoutItems = kept;
    }
    const rc = metadata.relatedContent && metadata.relatedContent.relatedContentItems;
    if (Array.isArray(rc)) {
      const kept = rc.filter(it => !(it && it.layoutItem && String(it.layoutItem.field || '').toLowerCase() === fl));
      changes += rc.length - kept.length;
      metadata.relatedContent.relatedContentItems = kept;
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
    const swap = _swapOn();
    const swapTo = swap ? _replField.api : '';
    // The page's object: its <sobjectType>, else the FlexiPage's EntityDefinitionId (2026-11-14 review 5 — Tooling
    // may return sobjectType null on a custom record page, as lightning-pages.js notes; ✂ then refused a correct edit
    // saying the page did not tell its object, when the record did).
    const pageHint = _flexiPageObjOf(res);
    const pageOn = String(metadata.sobjectType || pageHint || '');
    const pageName = /^01I/i.test(pageOn) ? 'another custom object' : pageOn;   // an id that is not the cleaned object's
    // ✂ and ⇄ fill the same tally: mentions of another object's / an untellable object's same-named field
    const leftRm = { other: 0, unknown: 0, unknownKinds: {}, otherPage: 0 };
    // ⇄ decides whose field each mention is exactly as ✂ does (2026-11-14 review 5: it ignored the page's object
    // and renamed Contact.Region__c on a Contact record page, while ✂ left it)
    const sw = swap ? replaceFieldInFlexiPage(metadata, _selObj.api, _selField.api, swapTo, leftRm, pageHint) : null;
    // the untellable mentions, each kind with its own true reason (2026-11-14 review 4: all were called "a custom lookup")
    const unknownBits = () => Object.entries(leftRm.unknownKinds).filter(([, n]) => n).map(([k, n]) => {
      const s = n === 1 ? '' : 's';
      if (k === 'custom') return `⚠ ${n} mention${s} through a custom lookup left alone — whose field it is cannot be told from the page; check it in App Builder`;
      if (k === 'poly') return `⚠ ${n} mention${s} through a What / Who or a Parent that can be any object left alone — whose field it is cannot be told from the page; check it in App Builder`;
      // 2026-11-14 review 5: the page's own record on a page that does not say its object (no <sobjectType>)
      if (k === 'page') return `⚠ ${n} mention${s} of the page's record left alone — the page does not say which object it is a record page for, so whose field it is cannot be told; check it in App Builder`;
      return `⚠ ${n} mention${s} from a merge field whose object the page does not tell left alone — check it in App Builder`;
    });
    // what was left alone and why — the same words for ✂ and ⇄ (review 5: ⇄ called a Parent self-lookup "a related
    // record, which is another object's field")
    const leftBits = () => {
      const bits = [];
      if (leftRm.otherPage) bits.push(`⚠ ${leftRm.otherPage} mention${leftRm.otherPage === 1 ? '' : 's'} of the page's record left alone (a ${pageName} record page: ${pageName}'s field, not ${_selObj.api}'s)`);
      if (leftRm.other) bits.push(`⚠ ${leftRm.other} mention${leftRm.other === 1 ? '' : 's'} of a related record's same-named field left alone (another object's field)`);
      if (leftRm.unknown) bits.push(...unknownBits());
      return bits;
    };
    const changes = swap ? sw.swapped + sw.dropped : removeFieldFromFlexiPage(metadata, _selObj.api, _selField.api, leftRm, pageHint);
    if (changes === 0) {
      // owner 2026-11-17 (a screenshot: ✂ on a page answered "No direct field references found … remove manually in
      // App Builder", while Salesforce no longer refused the delete over it): a page that names the field only in
      // its description or label has nothing to remove — the row is settled, as 🔍 settles it, and says why.
      if (!leftRm.other && !leftRm.unknown && !leftRm.otherPage && !_flexiNamesBeyondText(beforeMetadata, _selObj.api, _selField.api)) {
        return '✅ Nothing uses the field here — Salesforce lists it because its description or another text mentions the field’s name. Nothing to remove.';
      }
      throw new Error(
        `No direct field references found in "${componentName}". ` +
        // review 5 (2026-11-14): a record page of another object — its record's field is that object's
        (leftRm.otherPage ? `${leftRm.otherPage} mention(s) of the page's record left alone — this is a ${pageName} record page, so they are ${pageName}'s field, not ${_selObj.api}'s. ` : '') +
        (leftRm.other ? `${leftRm.other} mention(s) reach a related record's same-named field (another object's field) and are left alone. ` : '') +
        (leftRm.unknown ? `${unknownBits().map(b => b.replace(/^⚠ /, '')).join('; ')}. ` : '') +
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
            const again = replaceFieldInFlexiPage(JSON.parse(JSON.stringify(after.Metadata)), _selObj.api, _selField.api, swapTo, null, _flexiPageObjOf(after) || pageHint);
            return { ok: again.swapped + again.dropped === 0, text: null };
          }
          const left = removeFieldFromFlexiPage(JSON.parse(JSON.stringify(after.Metadata)), _selObj.api, _selField.api, null, _flexiPageObjOf(after) || pageHint);
          return { ok: left === 0, text: null };
        },
      });
      if (!wr.accepted) throw new Error(`Could not save "${componentName}": ${_feText((wr.raw && wr.raw.error) || 'refused')}`);
      if (!wr.ok) throw new Error(`"${componentName}" was saved but still references the field on re-read — check it in App Builder.`);
      if (swap) {
        const bits = [];
        if (sw.swapped) bits.push(`${sw.swapped} place${sw.swapped === 1 ? '' : 's'} now use${sw.swapped === 1 ? 's' : ''} ${swapTo}`);
        if (sw.dropped) bits.push(`${sw.dropped} component${sw.dropped === 1 ? '' : 's'} dropped — the page already showed ${swapTo}`);
        bits.push(...leftBits());
        return `✅ Page updated · ${bits.join(' · ')} — verified by re-reading the org`;
      }
      if (leftRm.other || leftRm.unknown || leftRm.otherPage) {
        const bits = [`${changes} place${changes === 1 ? '' : 's'} removed`, ...leftBits()];
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

  // The object a FlexiPage is a record page of, when its <sobjectType> is empty (2026-11-14 review 5): Tooling may
  // return Metadata.sobjectType null on a custom object's record page (lightning-pages.js reads EntityDefinitionId
  // then). EntityDefinitionId is the API name of a standard object but the 01I… id of a custom one — the cleaned
  // object's own id is answered with its API name; another id is passed on as it is (it is not the cleaned object, so
  // its record's field is not this field). '' = the page tells nothing more than its <sobjectType>.
  function _flexiPageObjOf(res) {
    if (!res || (res.Metadata && res.Metadata.sobjectType)) return '';
    const e = res.EntityDefinitionId ? String(res.EntityDefinitionId).trim() : '';
    if (!e || !/^01I/i.test(e)) return e;
    const mine = String((_selObj && _selObj.durableId) || '');
    return mine && mine.slice(0, 15).toLowerCase() === e.slice(0, 15).toLowerCase() ? _selObj.api : e;
  }

  // ⇄ on a Lightning page: sftkFlexiReplaceField (sftk-fieldreplace.js) does the rename, but whose field each mention
  // is is decided here by ✂'s own remover, so ✂ and ⇄ agree (2026-11-14 review 5). sftkFlexiReplaceField takes every
  // Record.X for the cleaned object's field and every hop for another object's: it renamed Contact.Region__c on a
  // Contact record page and left {!Record.Parent.Region__c} on an Account page, calling it another object's field.
  //   1. a mention that is NOT this field (another object's, the record of another object's page, or one whose object
  //      cannot be told) is masked, so the rename cannot touch it, and counted in out like ✂ counts it;
  //   2. sftkFlexiReplaceField renames the rest;
  //   3. a mention that IS this field and that it left (a self-lookup Parent, a hop that ends on this object, $User…)
  //      is renamed in place — its last segment only.
  // out (optional): the tally removeFieldFromFlexiPage fills. pageHint: as removeFieldFromFlexiPage's.
  // Returns { swapped, dropped, left } — left = the mentions left alone (all of them named in out).
  function replaceFieldInFlexiPage(metadata, objApi, oldApi, newApi, out, pageHint) {
    const fl = String(oldApi).toLowerCase();
    const tally = out && typeof out === 'object' ? out : {};
    tally.other = tally.other || 0; tally.unknown = tally.unknown || 0;
    const FIELD_PROPS = ['fieldApiName', 'field', 'fieldName'];
    const namesOld = v => typeof v === 'string' && v.trim().replace(/^\{!/, '').replace(/\}$/, '').trim().split('.').pop().toLowerCase() === fl;
    // whose field one mention is: ✂'s remover asked on a page holding that mention alone — null = THIS field
    const whose = v => {
      const t = {};
      const probe = { sobjectType: (metadata && metadata.sobjectType) || undefined, flexiPageRegions: [{ itemInstances: [{ fieldInstance: { fieldItem: v } }] }] };
      return removeFieldFromFlexiPage(probe, objApi, oldApi, t, pageHint) ? null : t;
    };
    // every string that names a field: field components, Dynamic Forms items, visibility criteria (a right-hand side
    // only as a merge field) — the places ✂ and sftkFlexiReplaceField read
    const slotsOf = () => {
      const slots = [];
      (function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (typeof node.fieldItem === 'string') slots.push({ o: node, k: 'fieldItem' });
        if (Array.isArray(node.componentInstanceProperties)) {
          for (const p of node.componentInstanceProperties) if (p && FIELD_PROPS.includes(p.name) && typeof p.value === 'string') slots.push({ o: p, k: 'value' });
        }
        for (const key of ['visibilityRule', 'componentVisibilityRule']) {
          for (const c of ((node[key] && node[key].criteria) || [])) {
            if (!c) continue;
            if (typeof c.leftValue === 'string') slots.push({ o: c, k: 'leftValue' });
            if (typeof c.rightValue === 'string' && c.rightValue.startsWith('{!')) slots.push({ o: c, k: 'rightValue' });
            else if (c.rightValue && typeof c.rightValue === 'object' && typeof c.rightValue.value === 'string' && c.rightValue.value.startsWith('{!')) slots.push({ o: c.rightValue, k: 'value' });
          }
        }
        for (const k of Object.keys(node)) walk(node[k]);
      })(metadata && metadata.flexiPageRegions);
      return slots;
    };
    const masks = [];
    for (const s of slotsOf()) {
      const v = s.o[s.k];
      if (!namesOld(v)) continue;
      const t = whose(v);
      if (!t) continue;
      tally.other += t.other || 0; tally.unknown += t.unknown || 0;
      if (t.otherPage) tally.otherPage = (tally.otherPage || 0) + t.otherPage;
      for (const [k, n] of Object.entries(t.unknownKinds || {})) { const u = tally.unknownKinds = tally.unknownKinds || {}; u[k] = (u[k] || 0) + n; }
      masks.push({ o: s.o, k: s.k, v });
      s.o[s.k] = `\u0000sftk-left-${masks.length}`;   // names no field: the rename passes it by
    }
    const sw = sftkFlexiReplaceField(metadata, objApi, oldApi, newApi);
    for (const m of masks) m.o[m.k] = m.v;
    let more = 0;
    const lastSeg = new RegExp(`${String(oldApi).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s*\\}?\\s*)$`, 'i');
    for (const s of slotsOf()) {
      const v = s.o[s.k];
      if (!namesOld(v) || whose(v)) continue;
      s.o[s.k] = v.replace(lastSeg, `${newApi}$1`);
      more++;
    }
    return { swapped: sw.swapped + more, dropped: sw.dropped, left: masks.length };
  }

  // Remove field references from a FlexiPage metadata object.
  // Handles two patterns:
  //   1. componentVisibilityRule criteria that test the field value
  //      → remove those criteria (if all criteria removed, delete the whole rule)
  //   2. componentInstance directly bound to the field (e.g. field-level components)
  //      → remove the entire component instance
  // out (optional): { other, unknown } — mentions left alone because they name ANOTHER object's
  // same-named field (other) or a field whose object the page does not tell (unknown: a custom lookup).
  // pageHint (optional, 2026-11-14 review 5): the page's object when its <sobjectType> is empty — the FlexiPage's
  // EntityDefinitionId (_flexiPageObjOf). <sobjectType> wins when the page has one.
  function removeFieldFromFlexiPage(metadata, objApi, fieldApiName, out, pageHint) {
    let changes = 0;
    const fl  = fieldApiName.toLowerCase();
    // 2026-11-15 (close-out review): Task / Event custom field = Activity's (see removeFieldFromFlow's objL)
    const obj = sftkMdFamObj(objApi, fieldApiName).toLowerCase();
    const tally = out && typeof out === 'object' ? out : {};
    tally.other = tally.other || 0; tally.unknown = tally.unknown || 0;
    // why each untellable mention could not be told, counted by kind in tally.unknownKinds: 'custom' | 'poly' | 'root' | 'page'
    // (2026-11-14 review 4) — added only when there is one, so a tally with none keeps its { other, unknown } shape
    let unknownKind = null;
    // The object of the page's record: the FlexiPage's <sobjectType> (2026-11-14 review 5) — '' when the page does
    // not say it (unknown kind 'page'). A mention of the page's own record on a page of ANOTHER object is that
    // object's field: tallied apart in tally.otherPage (added only when there is one), so the fix text says so
    // instead of calling it "a related record's field".
    const pageObj = metadata && metadata.sobjectType ? String(metadata.sobjectType).trim().toLowerCase()
      : pageHint ? String(pageHint).trim().toLowerCase() : '';
    let pageOther = false;
    // The hops and $ roots are resolved by the ONE shared resolver (sftkRelWalk / sftkRelGlobal in sftk-relmap.js,
    // 2026-11-14): this function kept a private copy of the map that drifted from the others. Parent / MasterRecord
    // are self-lookups — the page record's own object — except Parent on CaseComment / EmailMessage (Case) and on
    // Attachment / Note… (any object).
    // Whose field a path names: 'this' | 'other' | 'unknown' | null (not this field's name at all).
    // {!Record.Parent.Field} on Account IS Account.Field (Parent is a self-lookup); {!Record.Owner.Field}
    // and {!$User.Field} are User's — another object's field unless User is the one cleaned. Matching any
    // ".Field" ending took another object's criteria out; matching only Record.Field then missed the
    // self-lookup and $User forms that DO name this field (2026-11-14 review).
    function ownerOf(str) {
      unknownKind = null;
      if (str == null) return null;
      const segs = String(str).toLowerCase().trim()
        .replace(/^\{!/, '').replace(/\}$/, '').trim().split('.'); // strip {! ... } merge syntax
      if (segs.pop() !== fl) return null;
      let cur;
      // a $ root names its object through the shared resolver: $User.X User's, and — as the formulas read them
      // (2026-11-14) — $Profile / $UserRole / $Organization / $Setup.Obj, which this function used to tally 'unknown'
      const gl = segs.length && segs[0] !== '$record' ? sftkRelGlobal(segs) : null;
      if (gl && gl.obj) { cur = gl.obj; segs.splice(0, gl.from); }
      else {
        // a bare name and the roots Record / ObjectRecord / $Record are the page's OWN record (2026-11-14 review 5): its
        // object is the page's <sobjectType>, not the object being cleaned. The scan reads every page, so a Contact
        // record page with {!Record.Region__c} reached ✂ of Account.Region__c and lost Contact's field. A page that
        // does not say its object cannot be told — never guessed to be the one cleaned.
        const root = segs.length ? segs.shift() : 'record';
        // the object named outright ({!Account.Region__c}) is its own answer; {!Task.Region__c} is Activity's too (round 3)
        if (sftkMdIsOwnObj(root, obj)) cur = root;
        else if (root === 'record' || root === 'objectrecord' || root === '$record') {
          if (!pageObj) { unknownKind = 'page'; return 'unknown'; }
          cur = pageObj;
          // sftkMdIsOwnObj, not !==: a Task / Event record page's own record holds Activity's custom fields — it was
          // tallied otherPage and worded "Task's field, not Activity's", for ✂ and ⇄ alike (2026-11-14 review 5, round 3)
          if (!segs.length && !sftkMdIsOwnObj(cur, obj)) { pageOther = true; return 'other'; }
        }
        else { unknownKind = 'root'; return 'unknown'; }
      }
      // 2026-11-14 review 4: a standard hop missing from the map ({!Record.Asset.Region__c}, Entitlement…) is a lookup named
      // for its object, as _sftkMdSwapToken / _sftkTplForeign take it — it used to be tallied 'unknown' and reported as
      // "a custom lookup", which was false. Only a custom …__r, a What / Who, or a Parent that can be any object stay so.
      const r = sftkRelWalk(cur, segs);
      if (r.kind) { unknownKind = r.kind; return 'unknown'; }
      return sftkMdIsOwnObj(r.obj, obj) ? 'this' : 'other';
    }
    function refMatches(str) {
      pageOther = false;
      const who = ownerOf(str);
      if (who === 'other' && pageOther) tally.otherPage = (tally.otherPage || 0) + 1;
      else if (who === 'other') tally.other++;
      else if (who === 'unknown') { tally.unknown++; const k = tally.unknownKinds = tally.unknownKinds || {}; k[unknownKind] = (k[unknownKind] || 0) + 1; }
      return who === 'this';
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
      ValidationRuleInactive: `/lightning/setup/ObjectManager/${obj}/ValidationRules/view`,
      CustomField:    `/lightning/setup/ObjectManager/${obj}/FieldsAndRelationships/view`,
      LookupFilter:   `/lightning/setup/ObjectManager/${obj}/FieldsAndRelationships/view`,
      WebLink:        `/lightning/setup/ObjectManager/${obj}/ButtonsLinksActions/view`,
      FieldSet:       `/lightning/setup/ObjectManager/${obj}/FieldSets/view`,
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
      // the blocker legs added 2026-11-06
      WorkflowAlert:  '/lightning/setup/WorkflowEmails/home',
      WorkflowOutboundMessage: '/lightning/setup/WorkflowOutboundMessaging/home',
      SharingCriteriaRule: '/lightning/setup/SecuritySharing/home',
      DuplicateRule:  '/lightning/setup/DuplicateRules/home',
      LightningComponentBundle: '/lightning/setup/LightningComponentBundles/home',
      CustomMetadataRecord: '/lightning/setup/CustomMetadata/home',
      CustomMetadataText: '/lightning/setup/CustomMetadata/home',
      EntitlementProcess: '/lightning/setup/EntitlementProcesses/home',
      ServiceChannel: '/lightning/setup/ServiceChannelSettings/home',
      CustomSettingRecord: '/lightning/setup/CustomSettings/home',
      LeadConvertSettings: '/lightning/setup/ObjectManager/Lead/FieldsAndRelationships/view',
      AssignmentRule: obj === 'Case' ? '/lightning/setup/CaseRules/home' : '/lightning/setup/LeadRules/home',
      AutoResponseRule: obj === 'Case' ? '/lightning/setup/CaseResponses/home' : '/lightning/setup/LeadResponses/home',
      EscalationRule: '/lightning/setup/CaseEscRules/home',
      RestrictionRule: `/lightning/setup/ObjectManager/${obj}/RestrictionRules/view`,
      SearchLayout: `/lightning/setup/ObjectManager/${obj}/${fcSearchLayoutsPage()}/view`,
      PathAssistant:  '/lightning/setup/PathAssistantSetupHome/home',
      ApexComponent:  '/lightning/setup/ApexComponents/home',
      ApexPage:       '/lightning/setup/ApexPages/home',
      // 2026-11-17 (owner: 'we need to make sure they all have it'): every kind a row can be of
      Flow:           '/lightning/setup/Flows/home',
      ProcessBuilder: '/lightning/setup/ProcessAutomation/home',
      AuraDefinitionBundle: '/lightning/setup/LightningComponentBundles/home',
      EmailAlertViaTemplate: '/lightning/setup/WorkflowEmails/home',
      DependentPicklist: `/lightning/setup/ObjectManager/${obj}/FieldsAndRelationships/view`,
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
          💾 <strong>${_dataVerdict.filled.toLocaleString('en-US')}${_dataVerdict.sampled ? '+' : ''}</strong>
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
        btn.textContent = `✅ ${rows.length.toLocaleString('en-US')} row(s) saved${rows.length >= 50000 ? ' (capped 50k)' : ''}`;
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
    // Salesforce names the kind of reference after a colon: "This custom
    // field is referenced elsewhere in salesforce.com. : Workflow Rules." —
    // or in a sentence of its own for matching/duplicate rules, Process
    // Builder, scoping rules and custom metadata (live 2026-11-06). Say it.
    const where = s.match(/referenced elsewhere in salesforce\.com\.?\s*:\s*([^(]+?)\s*(?:\(|$)/i)
      || s.match(/used by the following ([a-z ]+?rules)\b/i)
      || s.match(/referenced by the "[^"]+" (process) version/i)
      || s.match(/used in at least one (Restriction Rule)/i);
    if (where) {
      return `Salesforce refuses the delete: the field is still used by ${where[1].trim().replace(/\.$/, '')}. ` +
        'Clear it in Setup, then re-scan and delete again — the scan reads every kind that blocks, so a re-scan lists it. ' +
        `(Salesforce said: ${s.replace(/\s+/g, ' ').slice(0, 400)})`;
    }
    if (/INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY|insufficient access rights on cross-reference/i.test(s)) {
      return 'Salesforce is still blocking this field. Usually one of: (a) a ' +
        'reference the scan could not read (see "what the scan cannot see" above), (b) the field is ' +
        'referenced by a MANAGED package component (read-only), or (c) your ' +
        'user lacks "Customize Application" / "Modify Metadata". Resolve the ' +
        'remaining reference, then retry. (Salesforce said: ' + s.replace(/\s+/g, ' ').slice(0, 400) + ')';
    }
    if (/in use|cannot delete.*because|can't delete|referenced|associated with/i.test(s)) {
      return 'The field is still referenced somewhere. Fix the listed ' +
        'dependencies above, re-scan (the scan reads every kind that blocks the delete) and delete again. ' +
        `(Raw: ${s})`;
    }
    return s;
  }

  // Delete one custom field through the Metadata API: a deploy whose
  // destructiveChanges.xml names the field and whose package.xml is empty.
  // Returns { success } or { error } — the deploy's own words on failure.
  async function _deleteFieldViaMetadata(fullName, checkOnly) {
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
    // check-only: nothing is written — Salesforce's answer comes back as it is
    if (checkOnly === true) return bg({ type: 'SF_METADATA_VALIDATE', orgUrl: _orgUrl, sid: _sid, zipBase64, _suppressError: true });
    // verified-by: doDelete (the only caller) re-reads the field after any
    // delete this function reports successful.
    const r = await bg({ type: 'SF_METADATA_DEPLOY', orgUrl: _orgUrl, sid: _sid, zipBase64, _suppressError: true });
    return r?.error ? { error: r.error } : { success: true };
  }

  // "Ask Salesforce" (user 2026-11-10: "If we can ask Salesforce directly why we didn't do it?"). A CHECK-ONLY delete
  // of the field: Salesforce validates it, deletes nothing, and names in its own words what refuses it. It answers
  // only "what BLOCKS" — what the delete would break silently (👀) Salesforce does not mention.
  // 2026-11-11 (user: "אי אפשר לעשות את זה מאחורי הקלעים?" → yes): no button. The question rides every scan; the
  // answer line says it was asked and when, and carries a small "↻ Ask again" for a fix made by hand in Setup.
  const _ASK_AGAIN = '<button type="button" class="fc-ask-again" id="fcAskBtn" title="Ask Salesforce again — a check-only delete: it answers whether it would accept the delete of this field right now. Nothing is deleted.">↻ Ask again</button>';
  // ✂ Remove, known BEFORE the click (user 2026-11-11, on a matching rule whose only item is the field: "את זה היינו
  // צריכים לגלות למשתמש כבר בהתחלה, זה הופיע רק אחרי שניסינו למחוק בפועל"). After the list is drawn, every row whose
  // kind has ✂ is read and run through the SAME pure transform the fix uses (sftkMdEditField, on a copy — nothing is
  // written). Where it refuses, the button is off from the start and the row says why, with the ways that do work.
  // Once per scan, one row after the other; a row that cannot be read stays as it was (the click still explains).
  function _preWhy(id) { return (_lastScan && _lastScan.pre && _lastScan.pre[id]) || ''; }
  function _paintPre(id) {
    const item = eid(`fcItem_${id}`);
    const why = _preWhy(id);
    if (!item || !why || item.classList.contains('fc-item-fixed')) return;   // a done row has no ✂ left to explain
    const pair = item.querySelector('.fc-fix-pair, .fc-del-pair');
    if (pair && !pair.querySelector('.fc-fix-btn[disabled]') && !pair.querySelector('.fc-pre-no')) pair.innerHTML = _fixBtnsHtml(pair.dataset.type, pair.dataset.id, pair.dataset.name);
    if (!item.querySelector('.fc-item-pre')) {
      const n = document.createElement('div');
      n.className = 'fc-item-pre';
      n.textContent = `✂ Remove is not possible here: ${why}.`;
      item.appendChild(n);
    }
    const group = item.closest('.fc-group');
    const box = group && group.querySelector('.fc-fix-allbox');
    if (box && !_walkRunning) {
      const open = _openPairs(group);
      if (open < 2) box.remove();
      else { box.dataset.n = String(open); box.innerHTML = _fixAllHtml(box.dataset.type, open, box.dataset.label); }
    }
  }
  async function _preflight() {
    const scan = _lastScan;
    if (!scan || !_selObj || !_selField) return;
    if (scan.pre) { Object.keys(scan.pre).forEach(_paintPre); _refreshFixEvery(); return; }   // a redraw of the same scan
    scan.pre = {};
    _refreshFixEvery();
    const obj = _selObj.api, field = _selField.api;
    const rows = scan.deps.filter(d => { const w = typeof sftkMdEditWays === 'function' ? sftkMdEditWays(d.MetadataComponentType) : null; return !!(w && w.remove); });
    for (const d of rows) {
      if (_lastScan !== scan) return;                                  // another field or another scan meanwhile
      const type = d.MetadataComponentType, id = d.MetadataComponentId;
      try {
        const spec = type === 'LookupFilter' ? { type, mdType: 'CustomField', what: 'lookup filter', special: 'lookupFilter' } : sftkMdDeleteSpec(type);
        if (!spec) continue;
        const fullName = await _deleteFullName(type, id, spec);
        const rd = await _mdReadOne(type, fullName, spec.mdType);
        if (!rd || rd.error || !rd.rec) continue;
        const ed = sftkMdEditField(type, rd.rec.innerXml, obj, field, null);
        if (ed && ed.refused && _lastScan === scan) { scan.pre[id] = ed.refused; _paintPre(id); _refreshFixEvery(); }
      } catch (_) { /* the row stays as it was — the click still reads and explains */ }
    }
  }
  function _wireAsk() { const b = eid('fcAskBtn'); if (b) b.onclick = () => askSalesforce(); }
  let _askBusy = false;
  async function askSalesforce(opts) {
    const box0 = eid('fcAskBox');
    if (!box0 || !_selObj || !_selField || _askBusy) return;
    const obj = _selObj.api, field = _selField.api, scan = _lastScan;
    _askBusy = true;
    box0.hidden = false; box0.className = 'fc-ask-box fc-ask-asking';
    box0.innerHTML = `<div class="fc-ask-head">⏳ Asking Salesforce whether it would accept the delete… <span class="fc-ask-at">a check only · nothing is deleted</span>${_ASK_AGAIN.replace('id="fcAskBtn"', 'id="fcAskBtn" disabled')}</div>`;
    // Asked right after a blocker was cleared, Salesforce can still name it for a few minutes (live 2026-11-15: two
    // validation rules deleted and verified gone, the check-only delete still refused over both; minutes later it
    // accepted). So after a clear a refusal is asked again, with the wait said, before it is believed — and before
    // the names it gives are added to the list as new rows.
    const waits = opts && opts.settle ? [15, 30, 45, 60, 90] : [];
    let r;
    try {
      for (let t = 0; ; t++) {
        try { r = await _deleteFieldViaMetadata(`${obj}.${field}`, true); }
        catch (e) { r = { error: String((e && e.message) || e) }; }
        if (!r || r.error || r.success || t >= waits.length) break;
        if (!_selField || _selField.api !== field || _lastScan !== scan) break;
        box0.innerHTML = `<div class="fc-ask-head">⏳ Salesforce still names something that was just cleared — it can take a few minutes to catch up. Asking again in ${waits[t]} s (${t + 2} of ${waits.length + 1})… <span class="fc-ask-at">a check only · nothing is deleted</span></div>`;
        await new Promise(res => setTimeout(res, waits[t] * 1000));
      }
    } finally { _askBusy = false; }
    if (!_selField || _selField.api !== field || _lastScan !== scan) return;   // another field or another scan meanwhile
    const ask = { r, at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), flows: {} };
    // the flow versions Salesforce names by id, read once so the box can say them by name
    try {
      const ids = (r && !r.error && !r.success) ? fcAskFlowIds(fcAskVerdict(r, 1).lines) : [];
      for (let i = 0; i < ids.length; i += 150) {
        const q = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true, _suppressError: true,
          query: `SELECT Id, MasterLabel, VersionNumber, Status FROM Flow WHERE Id IN (${ids.slice(i, i + 150).map(id => `'${id}'`).join(',')})` });
        for (const f of ((q && !q.error && q.records) || [])) ask.flows[String(f.Id).slice(0, 15)] = { flow: f.MasterLabel || f.Id, version: Number(f.VersionNumber) || 0, status: f.Status || '' };
      }
    } catch (_) { /* the box keeps Salesforce's own lines */ }
    if (!_selField || _selField.api !== field || _lastScan !== scan) return;
    if (scan) scan.ask = ask;
    // whatever Salesforce names and the list lacks becomes a row of the list
    let joined = 0;
    if (scan && r && !r.error && !r.success) {
      try { joined = await _askJoin(scan, fcAskVerdict(r, 1).lines); } catch (_) { /* the box still names them */ }
    }
    if (_lastScan !== scan) return;
    if (joined) { await renderResults(scan.deps, scan.fieldId); return; }       // draws the box again from scan.ask
    _paintAsk(ask);
  }
  async function _askJoin(scan, lines) {
    const named = fcAskNamed(lines);
    if (!named.length) return 0;
    const TAG = '🩺 named by Salesforce — its index did not return it';
    const has15 = id => scan.deps.some(d => String(d.MetadataComponentId).slice(0, 15) === String(id).slice(0, 15));
    const SPEC = { ApexClass: 'Name', ApexTrigger: 'Name', ApexPage: 'Name', ApexComponent: 'Name', AuraDefinitionBundle: 'DeveloperName' };
    let n = 0;
    const unresolved = named.filter(x => !x.type);
    for (const type of Object.keys(SPEC)) {
      const want = named.filter(x => x.type === type);
      if (!want.length) continue;
      const col = SPEC[type];
      const q = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true, _suppressError: true,
        query: `SELECT Id, ${col}, NamespacePrefix FROM ${type} WHERE ${col} IN (${[...new Set(want.map(w => `'${w.name}'`))].join(',')})` });
      for (const w of want) {
        const row = ((q && q.records) || []).find(b => b[col] === w.name && (w.ns === 'c' ? !b.NamespacePrefix : w.ns === b.NamespacePrefix));
        if (!row) { unresolved.push(w); continue; }
        if (has15(row.Id)) continue;                                  // the list has it already
        scan.deps.push({ MetadataComponentType: type, MetadataComponentId: row.Id, MetadataComponentName: (w.ns === 'c' ? '' : `${w.ns}__`) + row[col], _tag: TAG });
        n++;
      }
    }
    // A line that names a kind the list already shows is covered by that group. Anything else — words not seen
    // yet, a component that could not be found — is listed in Salesforce's own words, so the list is never short
    // of something Salesforce refuses over.
    const labels = [...new Set(scan.deps.map(d => (TYPE_CFG[d.MetadataComponentType] || TYPE_CFG_DEFAULT).label))];
    for (const u of unresolved) {
      if (!u.type && fcAskKindListed(u.line, labels)) continue;
      const id = 'ask_' + u.line.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
      if (scan.deps.some(d => d.MetadataComponentId === id)) continue;
      scan.deps.push({ MetadataComponentType: 'AskNamed', MetadataComponentId: id, MetadataComponentName: u.line });
      n++;
    }
    return n;
  }
  function _paintAsk(ask) {
    const box = eid('fcAskBox');
    if (!box || !ask) return;
    const listed = (_manualBlockers || []).reduce((n, b) => n + b.count, 0) + new Set([...document.querySelectorAll('#fcResults .fc-fix-btn:not([disabled])')].filter(b => (TYPE_CFG[b.dataset.type] || TYPE_CFG_DEFAULT).sev === 'blocker').map(b => b.dataset.id)).size;
    const view = fcAskVerdict(ask.r, listed);
    box.hidden = false;
    box.className = `fc-ask-box fc-ask-${view.kind}`;
    box.innerHTML = `<div class="fc-ask-head">${esc(view.head)} <span class="fc-ask-at">Salesforce was asked at ${esc(ask.at)} · nothing was deleted</span>${_ASK_AGAIN}</div>`
      + (view.lines.length ? `<ul class="fc-ask-list">${fcAskFlowLines(view.lines, ask.flows).map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : '')
      + (view.foot ? `<div class="fc-ask-foot">${esc(view.foot)}</div>` : '');
    _wireAsk();
    const partial = !!(_lastScan && _lastScan.unread && _lastScan.unread.length);
    if (partial) {
      const d = eid('fcDelBtn'), note = eid('fcDeleteNote');
      const open = document.querySelectorAll('#fcResults .fc-fix-btn:not([disabled])').length + (_manualBlockers || []).reduce((n, b) => n + b.count, 0);
      if (view.kind === 'ok' && open === 0) { if (d) d.disabled = false; if (note) note.textContent = '✅ The scan could not read everything, but Salesforce itself says it would accept the delete.'; }
      else if (view.kind === 'error') { if (d) d.disabled = true; if (note && open === 0) note.textContent = '🔒 The scan could not read everything and Salesforce could not be asked — press 🔍 Re-scan.'; }
    }
    // Salesforce refuses → the delete stays locked whatever the list says
    if (view.kind === 'blocked') {
      for (const id of ['fcDelBtn', 'fcDelFreeBtn']) { const d = eid(id); if (d) d.disabled = true; }
      const note = eid('fcDeleteNote');
      if (note && listed === 0) note.textContent = '🔒 Salesforce refuses the delete — see its answer below.';
    }
  }
  // With every scan (user 2026-11-10: "We need to run it every scan"): once per scan, never for a 👀-only scope or a
  // packaged field (no button there). A redraw of the same scan shows the answer it already has.
  function _autoAsk() {
    _wireAsk();
    if (!eid('fcAskBox') || !_lastScan) return;
    if (_lastScan.ask) { _paintAsk(_lastScan.ask); return; }
    if (fcScopeNorm(_lastScan.scope) === 'mentions') return;
    askSalesforce();
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
      await sftkHistoryEnd(journal, { undo: { none: 'the flow versions that used the field were deleted, and a deleted flow version cannot be re-created (Salesforce keeps no Recycle Bin for them); their metadata is kept under ↩ Restore points in Activity, from where a version can be put back as a draft' } });
    }
  }

  // 🔍 for every kind the ✂ / ⇄ engine edits: the record's XML as Salesforce returns it (SOAP read), the
  // lines that name the field marked, and under it what ✂ Remove — and ⇄ Replace, once a replacement is
  // picked — would change, as a diff (or why it is refused). Nothing is written from here.
  function _inspectsByMd(type) { return type !== 'Flow' && type !== 'Layout' && type !== 'FlexiPage' && typeof sftkMdEditWays === 'function' && !!sftkMdEditWays(type); }
  function _xmlMarkedHtml(xml, field) {
    const f = String(field || '');
    const rx = new RegExp(`(^|[^A-Za-z0-9_])(${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![A-Za-z0-9_])`, 'gi');
    let n = 0;
    const lines = sftkMdPretty(xml).split('\n').map(l => {
      const e = esc(l);
      if (!f || !rx.test(l)) return `<span class="xd-line">${e}</span>`;
      rx.lastIndex = 0; n++;
      return `<span class="xd-line xi-line-hit">${e.replace(rx, (m, pre, tok) => `${pre}<span class="xi-ref">${tok}</span>`)}</span>`;
    });
    return { html: `<pre class="fc-xml-pre fc-xml-md">${lines.join('')}</pre>`, n };
  }
  // ✎ The XML editor (user 2026-11-07: "give the user an ability to edit the XML and repush it to sf the way
  // they want. Like a vscode"): the record's XML in a box, deployed back through the same package deploy as
  // ✂ / ⇄ / 🗑 — well-formed or nothing is sent, its name cannot change, the diff is confirmed, a restore point
  // is kept, a refusal is shown in Salesforce's own words under the box, ↩ Undo in History deploys the original.
  // the extension pages enforce Trusted Types (DOMParser refuses a plain string): a pure tag-balance check
  function _xmlWellFormed(text) { return sftkMdWellFormed(text); }
  // ✓ Validate in the editors (owner 2026-11-15: after an edit, validate and then deploy): the edited text is sent as
  // a CHECK-ONLY deploy — Salesforce answers exactly as it would to the deploy and writes nothing. The verdict is
  // about the text that was sent; a later keystroke clears it.
  //   → { cls, html } for the editor's status line
  function _edValidateVerdict(r) {
    if (r && r.checkOnly === true && r.success) return { cls: 'fc-xml-ed-ok', html: '✓ Salesforce would accept this — checked against the org, nothing was written. ⬆ Deploy sends the same text.' };
    if (r && r.checkOnly === true) {
      const why = (r.failures || []).map(f => `${f.name ? `${f.name}: ` : ''}${f.problem}`).filter(Boolean);
      const words = why.length ? why.join(' · ') : (r.errorMessage || 'Salesforce gave no reason');
      return { cls: 'fc-xml-ed-err', html: `❌ Salesforce would refuse this — nothing was written. Its words: <span class="fc-xml-ed-raw">${esc(words)}</span>` };
    }
    return { cls: 'fc-xml-ed-err', html: `⚠ The check could not be run — nothing was written, and this is not a refusal of your text: <span class="fc-xml-ed-raw">${esc(String((r && (r.error || r.errorMessage)) || 'no answer from Salesforce'))}</span>` };
  }
  async function _edValidate(deployFiles, out) {
    const say = v => { out.innerHTML = `<div class="${v.cls}">${v.html}</div>`; };
    say({ cls: 'fc-xml-ed-note', html: '⏳ Asking Salesforce to check it — nothing is written…' });
    let r;
    try { r = await bg({ type: 'SF_METADATA_VALIDATE', orgUrl: _orgUrl, sid: _sid, zipBase64: _zipOf(deployFiles), _suppressError: true }); }
    catch (e) { r = { error: e.message }; }
    say(_edValidateVerdict(r));
    return !!(r && r.checkOnly === true && r.success);
  }
  // what the XML editor refuses before anything is sent: malformed XML, a changed <fullName>
  function _xmlEdPrecheck(ctx, text) {
    const bad = _xmlWellFormed(text);
    if (bad) return `the XML is not well-formed: ${esc(bad)}`;
    const wantName = _RULE_CONTAINERS[ctx.type] ? ctx.fullName.slice(ctx.fullName.indexOf('.') + 1) : ctx.fullName;
    if (sftkMdChildText(text, 'fullName') !== wantName) return `the <code>&lt;fullName&gt;</code> must stay “${esc(wantName)}” (it names the ${esc(ctx.spec.what)}; renaming is not done here)`;
    return '';
  }
  function _xmlEditorOpen(panel, ctx) {
    const box = panel.querySelector('.fc-xml-body');
    if (!box) return;
    const orig = sftkMdPretty(ctx.xml);
    box.innerHTML = `
      <div class="fc-xml-editor">
        <div class="fc-xml-ed-hint">✎ Edit the XML and deploy it back — exactly this text is sent (as the ${esc(ctx.spec.what)} “${esc(ctx.fullName)}”). The <code>&lt;fullName&gt;</code> line names it and stays as it is. A restore point is kept; ↩ Undo in Activity deploys the original back.</div>
        <textarea class="fc-xml-ta" spellcheck="false" wrap="off" aria-label="The XML of ${esc(ctx.componentName)}"></textarea>
        <div class="fc-xml-ed-bar">
          <span class="fc-xml-ed-state">No change yet</span>
          <button class="btn btn-secondary btn-sm fc-xml-ed-reset" disabled>↺ Start over</button>
          <button class="btn btn-secondary btn-sm fc-xml-ed-cancel">Cancel</button>
          <button class="btn btn-secondary btn-sm fc-xml-ed-validate" disabled title="Salesforce checks your text exactly as a deploy would — and writes nothing">✓ Validate</button>
          <button class="btn btn-primary btn-sm fc-xml-ed-deploy" disabled>⬆ Deploy to the org</button>
        </div>
        <div class="fc-xml-ed-out" role="status"></div>
      </div>`;
    const ta = box.querySelector('.fc-xml-ta'), state = box.querySelector('.fc-xml-ed-state');
    const go = box.querySelector('.fc-xml-ed-deploy'), reset = box.querySelector('.fc-xml-ed-reset'), out = box.querySelector('.fc-xml-ed-out');
    const val = box.querySelector('.fc-xml-ed-validate');
    ta.value = orig;
    ta.rows = Math.min(28, Math.max(8, orig.split('\n').length + 1));
    const sync = () => {
      const d = sftkMdLineDiff(orig, ta.value).filter(x => x.op !== ' ').length;
      const bad = ta.value !== orig ? _xmlWellFormed(ta.value) : null;
      state.textContent = ta.value === orig ? 'No change yet' : bad ? `⚠ Not well-formed XML — ${bad.slice(0, 160)}` : `${d} line${d === 1 ? '' : 's'} changed`;
      state.classList.toggle('fc-xml-ed-bad', !!bad);
      go.disabled = ta.value === orig || !!bad;
      val.disabled = go.disabled;
      reset.disabled = ta.value === orig;
    };
    val.addEventListener('click', async () => {
      const text = ta.value, pre = _xmlEdPrecheck(ctx, text);
      if (pre) { out.innerHTML = `<div class="fc-xml-ed-err">❌ Not checked — ${pre}.</div>`; return; }
      val.disabled = go.disabled = true;
      await _edValidate(sftkMdPackageFiles(ctx.type === 'LookupFilter' ? 'CustomField' : ctx.type, ctx.fullName, text), out);
      if (ta.value !== text) out.innerHTML = '';   // edited while Salesforce was checking: the verdict is of an older text
      sync();
    });
    // a new edit clears the last deploy's verdict (it spoke of the text before)
    ta.addEventListener('input', () => { out.innerHTML = ''; sync(); });
    // Tab indents like an editor instead of leaving the box
    ta.addEventListener('keydown', ev => {
      if (ev.key !== 'Tab') return;
      ev.preventDefault();
      const s = ta.selectionStart, e = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(e);
      ta.selectionStart = ta.selectionEnd = s + 2;
      sync();
    });
    reset.addEventListener('click', () => { ta.value = orig; out.innerHTML = ''; sync(); });
    box.querySelector('.fc-xml-ed-cancel').addEventListener('click', () => { _xmlInspectMd(ctx.type, ctx.componentId, ctx.componentName, panel, ctx.inspBtn); });
    go.addEventListener('click', async () => {
      go.disabled = true;
      const r = await _xmlEditorDeploy(ctx, ta.value, out);
      if (r === 'deployed') await _xmlInspectMd(ctx.type, ctx.componentId, ctx.componentName, panel, ctx.inspBtn, '✅ Deployed — every line you changed is in the org, verified by re-reading it. Below is what the org holds now; ↩ Undo in Activity puts the previous XML back.');
      else sync();
    });
    ta.focus();
  }
  async function _xmlEditorDeploy(ctx, text, out) {
    const { type, componentName, fullName, spec } = ctx;
    const say = (cls, html) => { out.innerHTML = `<div class="${cls}">${html}</div>`; };
    const bad = _xmlWellFormed(text);
    if (bad) { say('fc-xml-ed-err', `❌ Not deployed — the XML is not well-formed: ${esc(bad)}`); return 'bad'; }
    const inBox = !!_RULE_CONTAINERS[type];
    const wantName = inBox ? fullName.slice(fullName.indexOf('.') + 1) : fullName;
    const gotName = sftkMdChildText(text, 'fullName');
    if (gotName !== wantName) { say('fc-xml-ed-err', `❌ Not deployed — the <code>&lt;fullName&gt;</code> must stay “${esc(wantName)}” (it names the ${esc(spec.what)}; renaming is not done here).`); return 'bad'; }
    const pkgType = type === 'LookupFilter' ? 'CustomField' : type;
    const files = sftkMdPackageFiles(pkgType, fullName, ctx.xml), deployFiles = sftkMdPackageFiles(pkgType, fullName, text);
    const diff = sftkMdLineDiff(sftkMdPretty(ctx.xml), sftkMdPretty(text));
    const added = diff.filter(x => x.op === '+').map(x => x.line.trim()).filter(Boolean);
    const firstOld = (diff.find(x => x.op === '-') || {}).line;
    const gate = await sftkOrgWriteGate(_orgUrl);
    const sure = await sftkConfirmDestructive({
      title: `Deploy your XML — ${spec.what} “${componentName}”`,
      icon: '⬆',
      items: [{ label: componentName, sub: spec.what }],
      revOverride: { html: `⬆ <strong>Your edited XML is deployed as the ${esc(spec.what)}</strong> — ${diff.filter(x => x.op !== ' ').length} line(s) differ from what the org holds now. The ${esc(spec.what)} as it is now is kept as a <strong>restore point</strong>: ↩ Undo in Activity (or ↩ Restore points, in Activity) deploys it back.`, needsCheckbox: false, cls: 'sftk-rev-newver' },
      undoHint: 'Undo in Activity',
      extraHtml: `<div class="fc-xml-diff-hd">The XML — <span class="xd-del">− as it is</span> · <span class="xd-add">+ as you wrote it</span></div>${_xmlDiffHtml(ctx.xml, text)}`,
      confirmLabel: '⬆ Deploy',
      production: gate.production ? { label: gate.label } : null,
    });
    if (!sure) { say('fc-xml-ed-note', 'Not deployed — cancelled. Your text is still in the box.'); return 'cancel'; }
    const readMsg = _mdReadMsg(type, fullName, spec.mdType);
    const backPattern = firstOld ? _rxEsc(firstOld.trim()) : _rxEsc(wantName);
    await _snapshotFix('MdEdit', ctx.componentId, componentName, fullName, { type, mdType: spec.mdType, what: spec.what, how: ['XML edited by hand'], files, verify: { msg: readMsg, pattern: backPattern, flags: '', retries: 3 } });
    say('fc-xml-ed-note', '⏳ Deploying…');
    const zipBack = _zipOf(files), zipNew = _zipOf(deployFiles);
    const j = sftkHistoryBegin({ tool: 'Field Cleaner', title: `✎ XML edited — ${spec.what} "${componentName}"`, orgUrl: _orgUrl });
    let wr;
    try {
      // confirmed-by: the sftkConfirmDestructive right above
      // The write discipline (sftk-write.js): the deploy of the edited XML is the write; the verify re-reads the
      // record and finds every line the user added (Salesforce may reorder elements, so not byte for byte).
      wr = await sftkWriteVerified({
        describe: `"${componentName}" ${spec.what} — XML edited`,
        journal: j,
        write: async () => {
          const r = await bg({ type: 'SF_METADATA_DEPLOY', orgUrl: _orgUrl, sid: _sid, zipBase64: zipNew, _suppressError: true });
          return (r && r.success) ? r : { error: (r && r.error) || 'the deploy was not accepted' };
        },
        verify: async () => {
          for (let i = 0; i < 3; i++) {
            const a = await _mdReadOne(type, fullName, spec.mdType);
            if (a && a.rec) {
              const now = new Set(sftkMdPretty(a.rec.innerXml).split('\n').map(l => l.trim()));
              if (added.every(l => now.has(l))) return { ok: true, text: null };
            }
            await new Promise(res => setTimeout(res, 1200));
          }
          return { ok: false, text: null };
        },
      });
      if (wr.accepted && wr.ok) { say('fc-xml-ed-ok', '✅ Deployed — every line you changed is in the org, verified by re-reading it. ↩ Undo in Activity puts the previous XML back.'); return 'deployed'; }
      if (wr.accepted) { say('fc-xml-ed-err', `⚠ Salesforce accepted the deploy, but on re-read not every line you wrote is there — Salesforce may have normalised it. Open 🔍 again to see what the org holds.`); return 'odd'; }
      say('fc-xml-ed-err', `❌ Salesforce refused the deploy — nothing was changed. Its words: <span class="fc-xml-ed-raw">${esc(String((wr.raw && wr.raw.error) || 'refused'))}</span>`);
      return 'refused';
    } finally {
      await sftkHistoryEnd(j, { undo: wr && wr.accepted
        ? { steps: [{
            describe: `Put the ${spec.what} "${componentName}" back as it was before the XML edit`,
            // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read in `verify`
            msg: { type: 'SF_METADATA_DEPLOY', zipBase64: zipBack },
            verify: { msg: readMsg, pattern: backPattern, flags: '', retries: 3, text: { ok: `"${componentName}": the previous XML is back — verified by re-reading the org`, bad: `"${componentName}": the deploy was accepted, but on re-read the previous XML is not back yet` } },
          }] }
        : { none: 'nothing was accepted by Salesforce, so there is nothing to undo' } });
    }
  }
  async function _xmlInspectMd(type, componentId, componentName, panel, inspBtn, note) {
    const spec = type === 'LookupFilter' ? { type, mdType: 'CustomField', what: 'lookup filter', special: 'lookupFilter' } : sftkMdDeleteSpec(type);
    if (!spec) throw new Error('this kind has no XML read here');
    const fullName = await _deleteFullName(type, componentId, spec);
    const rd = await _mdReadOne(type, fullName, spec.mdType);
    if (rd.error) throw new Error(rd.error);
    if (!rd.rec) throw new Error(`"${componentName}" was not found in the org — re-scan`);
    const xml = rd.rec.innerXml, field = _selField.api, obj = _selObj.api;
    const marked = _xmlMarkedHtml(xml, field);
    const ways = sftkMdEditWays(type) || {};
    const prev = (nf, label) => {
      const ed = sftkMdEditField(type, xml, obj, field, nf);
      if (ed.refused) return `<div class="fc-xml-prev"><div class="fc-xml-prev-hd">${label} is refused here — <span class="fc-xml-refused">${esc(ed.refused)}</span></div></div>`;
      return `<div class="fc-xml-prev"><div class="fc-xml-prev-hd">${label} would change: ${esc(ed.how.join('; '))}</div>${_xmlDiffHtml(xml, ed.xml)}</div>`;
    };
    // a duplicate rule too (user 2026-11-08: "למה אין החלפה פה — ועריכה של xml — צריך להיות בכולם")
    const previews = (ways.remove ? prev(null, '✂ Remove') : `<div class="fc-xml-hint">✂ Remove is not offered for a ${esc(spec.what)}: ${esc(sftkMdEditField(type, xml, obj, field, null).refused || 'it cannot lose the field and keep working')}</div>`)
        + (_replOn() ? prev(_replField.api, `⇄ Replace with ${esc(_replField.api)}`) : '<div class="fc-xml-hint">⇄ Replace: pick a replacement field above to see what it would change.</div>')
        + (type === 'DuplicateRule' ? '<div class="fc-xml-hint">👥 A duplicate rule guards the org’s data: an edit here is your own click, with the diff first and a restore point — nothing switches a rule off or edits one behind a deployment.</div>' : '');
    panel.innerHTML = `
      <div class="fc-xml-hdr">
        <span class="fc-xml-hdr-name">${esc(componentName)} <small class="fc-xml-src">· ${esc(spec.mdType === 'CustomField' && type === 'LookupFilter' ? 'CustomField' : spec.mdType)} ${esc(fullName)} · Metadata API</small></span>
        <span class="fc-xml-badge ${marked.n ? 'fc-xml-badge--hit' : 'fc-xml-badge--miss'}">${marked.n ? `${marked.n} line${marked.n === 1 ? ' names' : 's name'} the field` : 'no line names the field'}</span>
        <span class="fc-xml-hdr-actions"><button class="btn btn-secondary btn-sm fc-xml-edit-btn" title="Edit this XML and deploy it back — like an editor; a restore point is kept">✎ Edit XML</button><button class="fc-xml-close" data-panelid="${esc(componentId)}">✕</button></span>
      </div>
      ${note ? `<div class="fc-xml-ed-ok fc-xml-ed-done">${esc(note)}</div>` : ''}
      <div class="fc-xml-body">${marked.html}
      ${previews}</div>`;
    panel.querySelector('.fc-xml-close')?.addEventListener('click', () => { panel.style.display = 'none'; if (inspBtn) inspBtn.classList.remove('fc-inspect-btn--open'); });
    panel.querySelector('.fc-xml-edit-btn')?.addEventListener('click', ev => { ev.currentTarget.disabled = true; _xmlEditorOpen(panel, { type, componentId, componentName, fullName, spec, xml, inspBtn }); });
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  // ── Code — Apex class / trigger, Visualforce page / component, LWC and Aura bundles (user 2026-11-08: "צריך
  // להיות בכולם") ──────────────────────────────────────────────────────────────────────────────────────────────
  // One read knows the Tooling shapes: the files as the org holds them (the restore point), a builder for an
  // edited set, and the check that one file reads as a given text — used by the 🗑 delete's restore plan, the
  // 🔍 inspector, ⇄ Replace and the ✎ code editor.
  //   → { sources: [{ path, file, source, … }], files, build(sources) → files, byName, verifyOf(path, source) }
  async function _codeRead(type, componentId, fullName, spec) {
    const q = s => String(s).replace(/'/g, "\\'");
    const g = await bg({ type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid, sobject: spec.tooling, id: componentId, _suppressError: true });
    if (!g || g.error) throw new Error(`"${fullName}" could not be read (${_feText((g && g.error) || 'no answer')}) — nothing is changed without a restore point`);
    if (spec.code) {
      if (typeof g[spec.code] !== 'string') throw new Error(`the source of "${fullName}" could not be read — nothing is changed without a restore point`);
      // only a Visualforce page or component carries a <label>; an Apex class or trigger with one is refused (live 2026-11-07: the class restore failed on it)
      const withLabel = spec.metaTag === 'ApexPage' || spec.metaTag === 'ApexComponent';
      // what the -meta.xml held goes back with it (2026-11-14): an Apex unit's Status (an Inactive trigger stays off),
      // a page's touch / CSRF boxes and a page's or component's description (left out, a deploy resets them)
      const extra = withLabel
        ? { label: g.MasterLabel || g.Label || fullName, description: g.Description || '',
          ...(spec.metaTag === 'ApexPage' ? { availableInTouch: g.IsAvailableInTouch, confirmationTokenRequired: g.IsConfirmationTokenRequired } : {}) }
        : { status: g.Status };
      const file = `${fullName}.${spec.suffix}`;
      const sources = [{ path: `${spec.folder}/${file}`, file, source: g[spec.code] }];
      const build = srcs => sftkMdCodeFiles(type, fullName, (srcs[0] || {}).source, g.ApiVersion, extra);
      return { sources, files: build(sources), build, byName: `SELECT Id FROM ${spec.tooling} WHERE Name = '${q(fullName)}'`,
        verifyOf: (path, source) => ({ query: `SELECT Id, ${spec.code} FROM ${spec.tooling} WHERE Name = '${q(fullName)}'`, tooling: true, pick: 'records', where: { field: spec.code, equals: source, loose: true } }) };
    }
    let resources = [], verifyOf;
    if (type === 'LightningComponentBundle') {
      const r = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true, _suppressError: true, query: `SELECT Id, FilePath, Source FROM LightningComponentResource WHERE LightningComponentBundleId = '${componentId}'` });
      if (!r || r.error) throw new Error(`the files of "${fullName}" could not be read (${_feText((r && r.error) || 'no answer')})`);
      resources = (r.records || []).filter(x => !/-meta\.xml$/.test(String(x.FilePath || ''))).map(x => ({ path: x.FilePath, file: String(x.FilePath || '').split('/').pop(), source: x.Source }));
      verifyOf = (path, source) => ({ query: `SELECT Id, Source FROM LightningComponentResource WHERE LightningComponentBundleId = '${componentId}' AND FilePath = '${q(path)}'`, tooling: true, pick: 'records', where: { field: 'Source', equals: source, loose: true } });
    } else {
      const r = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: true, _suppressError: true, query: `SELECT Id, DefType, Source FROM AuraDefinition WHERE AuraDefinitionBundleId = '${componentId}'` });
      if (!r || r.error) throw new Error(`the files of "${fullName}" could not be read (${_feText((r && r.error) || 'no answer')})`);
      resources = (r.records || []).map(x => { const file = (_AURA_FILE[x.DefType] || (n => `${n}.${String(x.DefType).toLowerCase()}`))(fullName); return { path: file, file, source: x.Source, defType: x.DefType }; });
      verifyOf = (path, source) => { const d = resources.find(x => x.path === path); return { query: `SELECT Id, Source FROM AuraDefinition WHERE AuraDefinitionBundleId = '${componentId}' AND DefType = '${q(d ? d.defType : 'COMPONENT')}'`, tooling: true, pick: 'records', where: { field: 'Source', equals: source, loose: true } }; };
    }
    if (!resources.length) throw new Error(`"${fullName}" came back with no files — nothing is changed without a restore point`);
    const m = g.Metadata || {};
    const meta = { apiVersion: m.apiVersion || g.ApiVersion, isExposed: m.isExposed, masterLabel: m.masterLabel || g.MasterLabel, description: m.description || g.Description,
      targets: m.targets, targetConfigs: m.targetConfigs };   // an LWC's placements go back too (2026-11-14)
    const build = srcs => sftkMdBundleFiles(type, fullName, srcs.map(s => ({ path: s.path, source: s.source })), meta);
    return { sources: resources, files: build(resources), build, byName: `SELECT Id FROM ${spec.tooling} WHERE DeveloperName = '${q(fullName)}'`, verifyOf };
  }
  // A text diff (code, not XML): the same fold as the XML diff, on the raw lines.
  function _textDiffHtml(before, after) {
    const d = sftkMdLineDiff(String(before == null ? '' : before).replace(/\r\n?/g, '\n'), String(after == null ? '' : after).replace(/\r\n?/g, '\n'));
    const keep = new Set();
    d.forEach((x, i) => { if (x.op !== ' ') for (let k = i - 2; k <= i + 2; k++) keep.add(k); });
    let out = '', skipped = 0;
    const flush = () => { if (skipped) out += `<span class="xd-line xd-fold">  … ${skipped} unchanged line${skipped === 1 ? '' : 's'}</span>`; skipped = 0; };
    d.forEach((x, i) => {
      if (x.op === ' ' && !keep.has(i)) { skipped++; return; }
      flush();
      out += `<span class="xd-line xd-${x.op === '+' ? 'add' : x.op === '-' ? 'del' : 'eq'}">${x.op === ' ' ? ' ' : x.op} ${esc(x.line)}</span>`;
    });
    flush();
    return `<pre class="fc-xml-pre fc-xml-diff">${out}</pre>`;
  }
  // The kinds' ways in a few words, for the gate's chips.
  function _blockerWays(type) {
    if (type === 'ProcessBuilder') return '🗑 delete';
    if (type === 'LookupFilter') return '✂ remove · ⇄ replace · ✎ edit XML';
    if (typeof sftkMdCodeWays === 'function' && sftkMdCodeWays(type)) return '⇄ replace · ✎ edit code · 🗑 delete';
    const w = typeof sftkMdEditWays === 'function' ? sftkMdEditWays(type) : null;
    const del = (typeof sftkMdDeleteSpec === 'function' && sftkMdDeleteSpec(type)) ? ' · 🗑 delete' : '';
    if (w) return `${w.remove ? '✂ remove · ' : ''}⇄ replace · ✎ edit XML${del}`;
    return del ? '🗑 delete' : 'in Setup only';
  }
  // One deploy for ⇄ in code and for ✎: the confirm with the diff of every changed file, the restore point, the
  // write with a re-read of each changed file as the verify, the History entry whose undo deploys the originals.
  //   ctx: { type, componentId, componentName, fullName, spec, code (a _codeRead) }; newSources: code.sources with new text
  //   → 'cancel' | { ok: true, stillNames }   (throws when Salesforce refuses or the re-read disagrees)
  async function _codeDeploy(ctx, newSources, o) {
    const { type, componentId, componentName, fullName, spec, code } = ctx;
    const orig = p => code.sources.find(x => x.path === p);
    const changed = newSources.filter(s => !sftkMdCodeSame(s.source, (orig(s.path) || {}).source));
    if (!changed.length) return 'cancel';
    const files = code.files, deployFiles = code.build(newSources);
    const apex = spec.metaTag === 'ApexClass' || spec.metaTag === 'ApexTrigger';
    const gate = await sftkOrgWriteGate(_orgUrl);
    const edits = changed.map((s, i) => _cfEditBlock(`fcCfCode${i}`, s.source, { what: s.file }));
    const diffs = changed.map((s, i) => `<div class="fc-xml-diff-hd"><code>${esc(s.file)}</code> — <span class="xd-del">− as it is</span> · <span class="xd-add">+ as it will be</span></div>${_textDiffHtml((orig(s.path) || {}).source, s.source)}${edits[i].html}`).join('');
    const sure = await sftkConfirmDestructive({
      title: o.title,
      icon: o.ico,
      items: [{ label: componentName, sub: spec.what }],
      onRender: () => edits.forEach(e => e.onRender()),
      revOverride: { html: `${o.ico} <strong>${esc(o.how)}.</strong> The ${esc(spec.what)} is deployed back with ${changed.length === 1 ? 'this file' : `these ${changed.length} files`} changed and ${code.sources.length > changed.length ? 'the rest' : 'its metadata'} exactly as the org holds ${code.sources.length > changed.length ? 'them' : 'it'}. The ${esc(spec.what)} as it is now is kept as a <strong>restore point</strong>: ↩ Undo in Activity (or ↩ Restore points, in Activity) deploys it back.${apex && gate.production ? ' <strong>In a production org Salesforce runs the org’s Apex tests before it accepts code.</strong>' : ''}`, needsCheckbox: false, cls: 'sftk-rev-newver' },
      undoHint: 'Undo in Activity',
      extraHtml: diffs,
      confirmLabel: o.confirmLabel,
      production: gate.production ? { label: gate.label } : null,
    });
    if (!sure) return 'cancel';
    // a hand edit in the dialog is what gets deployed (user 2026-11-08: "we can't edit here")
    changed.forEach((s, i) => { const v = edits[i].value(); if (v != null) { s.source = v; const t = newSources.find(x => x.path === s.path); if (t) t.source = v; } });
    const deployFiles2 = code.build(newSources);
    // the way back is checked on the first changed file: it reads as it was
    const first = changed[0];
    const verifyBack = code.verifyOf(first.path, (orig(first.path) || {}).source);
    await _snapshotFix('MdEdit', componentId, componentName, fullName, { type, mdType: type, what: spec.what, swapTo: o.swapTo || null, how: [o.how], files, verify: verifyBack });
    const zipBack = _zipOf(files), zipNew = _zipOf(deployFiles2);
    const j = sftkHistoryBegin({ tool: 'Field Cleaner', title: o.histTitle, orgUrl: _orgUrl });
    let wr, ranTests = false;
    try {
      // confirmed-by: the sftkConfirmDestructive right above
      // The write discipline (sftk-write.js): the deploy of the edited source is the write; the verify reads every
      // changed file back from the Tooling API and finds the text that was sent (line endings aside).
      wr = await sftkWriteVerified({
        describe: `"${componentName}" ${spec.what}`,
        journal: j,
        write: async () => {
          let r = await bg({ type: 'SF_METADATA_DEPLOY', orgUrl: _orgUrl, sid: _sid, zipBase64: zipNew, _suppressError: true });
          // a production org wants the org's Apex tests with code: run them, as the 🗑 delete does
          if (apex && r && !r.success && /test|coverage/i.test(String(r.error || ''))) { ranTests = true; r = await bg({ type: 'SF_METADATA_DEPLOY', orgUrl: _orgUrl, sid: _sid, zipBase64: zipNew, testLevel: 'RunLocalTests', _suppressError: true }); }
          return (r && r.success) ? r : { error: (r && r.error) || 'the deploy was not accepted' };
        },
        verify: async () => {
          for (let i = 0; i < 12; i++) {
            try {
              const again = await _codeRead(type, componentId, fullName, spec);
              if (changed.every(s => { const a = again.sources.find(x => x.path === s.path); return a && sftkMdCodeSame(a.source, s.source); })) return { ok: true, text: null };
            } catch (_) { /* read again */ }
            await new Promise(res => setTimeout(res, 1500 + i * 200));
          }
          return { ok: false, text: null };
        },
      });
      if (wr.accepted && wr.ok) {
        const stillNames = newSources.some(s => sftkMdCodeHits(s.source, _selField.api).length > 0);
        if (!stillNames) _afterDelete(type);
        return { ok: true, stillNames, diffs, ranTests };
      }
      if (wr.accepted) throw new Error(`"${componentName}" — Salesforce accepted the deploy, but half a minute later its API still hands back the previous source. The org may lag behind a code deploy: open 🔍 again in a moment (or read it in Setup) before deciding anything — ↩ Undo in Activity is there either way.`);
      throw new Error(`Salesforce refused the ${spec.what} "${componentName}": ${_feText(String((wr.raw && wr.raw.error) || 'refused'))}. Nothing was changed.`);
    } finally {
      await sftkHistoryEnd(j, { undo: wr && wr.accepted
        ? { steps: [{
            describe: `Put the ${spec.what} "${componentName}" back as it was before the ${o.ico === '⇄' ? 'replace' : 'edit'}`,
            // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the Tooling re-read in `verify`
            msg: { type: 'SF_METADATA_DEPLOY', zipBase64: zipBack },
            verify: { ...verifyBack, retries: 3, text: { ok: `"${componentName}": the ${spec.what} is back as it was — verified by re-reading the org`, bad: `"${componentName}": the deploy was accepted, but on re-read the ${spec.what} is not back yet` } },
          }] }
        : { none: 'nothing was accepted by Salesforce, so there is nothing to undo' } });
    }
  }
  // ⇄ in code: the field's API name renamed, whole word, in every file of the component.
  async function fixCodeReplace(type, componentId, componentName) {
    const cfg = TYPE_CFG[type] || TYPE_CFG_DEFAULT;
    const spec = typeof sftkMdDeleteSpec === 'function' ? sftkMdDeleteSpec(type) : null;
    if (!spec || !(spec.code || spec.bundle)) throw new Error(`A ${cfg.label || type} is not code — nothing to rename here.`);
    if (!_replOn()) throw new Error(`Pick a replacement field above — ⇄ Replace renames ${_selField.api} to it in the code. Nothing is taken out of a program here; ✎ Edit code in 🔍 is yours for that.`);
    const nf = _replField.api, field = _selField.api;
    _rowBusy(componentId, '⏳ reading…');
    let fullName, code;
    try {
      fullName = await _deleteFullName(type, componentId, spec);
      code = await _codeRead(type, componentId, fullName, spec);
    } catch (e) { _rowBusy(componentId, null); appendInlineError(componentId, e.message); return null; }
    _rowBusy(componentId, null);
    const r = sftkMdCodeReplace(code.sources, field, nf);
    if (!r.n) {
      appendInlineError(componentId, `⇄ Replace was not done on "${componentName}": no file of it writes ${field} as a word — open 🔍 to see the source. Nothing was changed.`);
      return null;
    }
    const how = `${r.n} place${r.n === 1 ? '' : 's'} in ${r.files} file${r.files === 1 ? '' : 's'} now ${nf}`;
    _rowBusy(componentId, '⏳ replacing…');
    try {
      const d = await _codeDeploy({ type, componentId, componentName, fullName, spec, code }, r.sources, {
        ico: '⇄', how, swapTo: nf,
        title: `Replace the field in the ${spec.what} — ${cfg.label || type}`,
        confirmLabel: `⇄ Replace in the ${spec.what}`,
        histTitle: `⇄ ${cfg.label || type} — "${componentName}" (${_selObj.api}.${field} → ${nf})`,
      });
      if (d === 'cancel') return 'cancel';
      return { label: `✅ Replaced — ${how}${d.ranTests ? ' (the org’s Apex tests ran first)' : ''} — verified by re-reading the org`, detailHtml: `<details class="fc-xml-done"><summary>The source that was deployed</summary>${d.diffs}</details>` };
    } finally { _rowBusy(componentId, null); }
  }
  // 🔍 on code: every file of the component with the field's lines marked; ⇄ when a replacement field is picked
  // and the source writes the field; ✎ Edit code always.
  async function _codeInspect(type, componentId, componentName, panel, inspBtn, note) {
    const spec = sftkMdDeleteSpec(type);
    if (!spec || !(spec.code || spec.bundle)) throw new Error('this kind has no source read here');
    const fullName = await _deleteFullName(type, componentId, spec);
    const code = await _codeRead(type, componentId, fullName, spec);
    const field = _selField.api;
    const apex = spec.metaTag === 'ApexClass' || spec.metaTag === 'ApexTrigger';
    let total = 0;
    const filesHtml = code.sources.map(s => {
      const n = sftkMdCodeHits(s.source, field).length; total += n;
      const h = _xiHighlightApex(s.source);
      return `<div class="fc-code-file"><div class="fc-code-file-hd"><code>${esc(s.file)}</code><span class="fc-code-file-n">${n ? `${n} line${n === 1 ? ' names' : 's name'} the field` : 'no line names the field'}</span></div><pre class="fc-xml-pre fc-xml-pre--code"><code>${h.html}</code></pre></div>`;
    }).join('');
    const rp = _replOn() ? sftkMdCodeReplace(code.sources, field, _replField.api) : null;
    const hint = `<div class="fc-xml-hint">✂ Remove is not offered for code — which line of a program goes is yours to decide, in ✎ Edit code. ⇄ Replace renames <code>${esc(field)}</code> as a whole word in every file${rp ? (rp.n ? ` — here ${rp.n} place${rp.n === 1 ? '' : 's'} in ${rp.files} file${rp.files === 1 ? '' : 's'} would become <code>${esc(_replField.api)}</code>` : ' — nothing here writes it as a word') : ' — pick a replacement field above to see what it would change'}.${apex ? ' In a production org Salesforce runs the org’s Apex tests before it accepts code.' : ''}</div>`;
    panel.innerHTML = `
      <div class="fc-xml-hdr">
        <span class="fc-xml-hdr-name">${esc(componentName)} <small class="fc-xml-src">· ${esc(spec.tooling)} ${esc(fullName)} · Tooling API${code.sources.length > 1 ? ` · ${code.sources.length} files` : ''}</small></span>
        <span class="fc-xml-badge ${total ? 'fc-xml-badge--hit' : 'fc-xml-badge--miss'}">${total ? `${total} line${total === 1 ? ' names' : 's name'} the field` : 'no line names the field'}</span>
        <span class="fc-xml-hdr-actions">${rp && rp.n ? `<button class="btn btn-primary btn-sm fc-code-repl-btn" title="Rename ${esc(field)} to ${esc(_replField.api)} in every file — the diff is shown first; a restore point is kept">⇄ Replace</button>` : ''}<button class="btn btn-secondary btn-sm fc-xml-edit-btn" title="Edit the source file by file and deploy it back — a restore point is kept">✎ Edit code</button><button class="fc-xml-close" data-panelid="${esc(componentId)}">✕</button></span>
      </div>
      ${note ? `<div class="fc-xml-ed-ok fc-xml-ed-done">${esc(note)}</div>` : ''}
      <div class="fc-xml-body">${hint}${filesHtml}</div>`;
    panel.querySelector('.fc-xml-close')?.addEventListener('click', () => { panel.style.display = 'none'; if (inspBtn) inspBtn.classList.remove('fc-inspect-btn--open'); });
    panel.querySelector('.fc-code-repl-btn')?.addEventListener('click', () => { panel.style.display = 'none'; if (inspBtn) inspBtn.classList.remove('fc-inspect-btn--open'); fixOne(type, componentId, componentName, _curFieldId, true, 'code'); });
    panel.querySelector('.fc-xml-edit-btn')?.addEventListener('click', ev => { ev.currentTarget.disabled = true; _codeEditorOpen(panel, { type, componentId, componentName, fullName, spec, code, inspBtn }); });
    _addXmlNavigation(panel);
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  // ✎ the code editor: one box per file, deployed back as a whole through _codeDeploy.
  function _codeEditorOpen(panel, ctx) {
    const box = panel.querySelector('.fc-xml-body');
    if (!box) return;
    const { code, spec } = ctx;
    box.innerHTML = `
      <div class="fc-xml-editor">
        <div class="fc-xml-ed-hint">✎ Edit the source and deploy it back — exactly this text is sent (as the ${esc(spec.what)} “${esc(ctx.fullName)}”), every file of it. A restore point is kept; ↩ Undo in Activity deploys the originals back.${spec.metaTag === 'ApexClass' || spec.metaTag === 'ApexTrigger' ? ' In a production org Salesforce runs the org’s Apex tests before it accepts code.' : ''}</div>
        ${code.sources.map((s, i) => `<div class="fc-code-ed-file"><div class="fc-code-file-hd"><code>${esc(s.file)}</code><span class="fc-code-file-n fc-code-ed-n" data-i="${i}">unchanged</span></div><textarea class="fc-xml-ta fc-code-ta" data-i="${i}" spellcheck="false" wrap="off" aria-label="The source of ${esc(s.file)}"></textarea></div>`).join('')}
        <div class="fc-xml-ed-bar">
          <span class="fc-xml-ed-state">No change yet</span>
          <button class="btn btn-secondary btn-sm fc-xml-ed-reset" disabled>↺ Start over</button>
          <button class="btn btn-secondary btn-sm fc-xml-ed-cancel">Cancel</button>
          <button class="btn btn-secondary btn-sm fc-xml-ed-validate" disabled title="Salesforce checks your text exactly as a deploy would — and writes nothing">✓ Validate</button>
          <button class="btn btn-primary btn-sm fc-xml-ed-deploy" disabled>⬆ Deploy to the org</button>
        </div>
        <div class="fc-xml-ed-out" role="status"></div>
      </div>`;
    const tas = [...box.querySelectorAll('.fc-code-ta')], state = box.querySelector('.fc-xml-ed-state');
    const go = box.querySelector('.fc-xml-ed-deploy'), reset = box.querySelector('.fc-xml-ed-reset'), out = box.querySelector('.fc-xml-ed-out');
    const origOf = i => String(code.sources[i].source == null ? '' : code.sources[i].source).replace(/\r\n?/g, '\n');
    tas.forEach((ta, i) => { ta.value = origOf(i); ta.rows = Math.min(28, Math.max(6, ta.value.split('\n').length + 1)); });
    const sync = () => {
      let lines = 0, files = 0;
      tas.forEach((ta, i) => {
        const d = ta.value === origOf(i) ? 0 : (() => { const ops = sftkMdLineDiff(origOf(i), ta.value); return Math.max(ops.filter(x => x.op === '+').length, ops.filter(x => x.op === '-').length); })();
        const n = box.querySelector(`.fc-code-ed-n[data-i="${i}"]`);
        if (n) n.textContent = d ? `${d} line${d === 1 ? '' : 's'} changed` : 'unchanged';
        if (d) { lines += d; files++; }
      });
      state.textContent = files ? `${lines} line${lines === 1 ? '' : 's'} changed in ${files} file${files === 1 ? '' : 's'}` : 'No change yet';
      go.disabled = !files; reset.disabled = !files; val.disabled = !files;
    };
    const val = box.querySelector('.fc-xml-ed-validate');
    val.addEventListener('click', async () => {
      const sent = tas.map(ta => ta.value);
      val.disabled = go.disabled = true;
      await _edValidate(code.build(code.sources.map((s, i) => ({ ...s, source: sent[i] }))), out);
      if (tas.some((ta, i) => ta.value !== sent[i])) out.innerHTML = '';   // edited meanwhile: the verdict is of an older text
      sync();
    });
    tas.forEach(ta => {
      ta.addEventListener('input', () => { out.innerHTML = ''; sync(); });
      ta.addEventListener('keydown', ev => {
        if (ev.key !== 'Tab') return;
        ev.preventDefault();
        const s = ta.selectionStart, e = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + '    ' + ta.value.slice(e);
        ta.selectionStart = ta.selectionEnd = s + 4;
        sync();
      });
    });
    reset.addEventListener('click', () => { tas.forEach((ta, i) => { ta.value = origOf(i); }); out.innerHTML = ''; sync(); });
    box.querySelector('.fc-xml-ed-cancel').addEventListener('click', () => { _codeInspect(ctx.type, ctx.componentId, ctx.componentName, panel, ctx.inspBtn); });
    go.addEventListener('click', async () => {
      go.disabled = true;
      const say = (cls, html) => { out.innerHTML = `<div class="${cls}">${html}</div>`; };
      const newSources = code.sources.map((s, i) => ({ ...s, source: tas[i].value }));
      const files = newSources.filter((s, i) => s.source !== origOf(i)).length;
      try {
        const d = await _codeDeploy(ctx, newSources, {
          ico: '⬆', how: `${files} file${files === 1 ? '' : 's'} edited by hand`,
          title: `Deploy your code — ${spec.what} “${ctx.componentName}”`,
          confirmLabel: '⬆ Deploy',
          histTitle: `✎ Code edited — ${spec.what} "${ctx.componentName}"`,
        });
        if (d === 'cancel') { say('fc-xml-ed-note', 'Not deployed — cancelled. Your text is still in the boxes.'); sync(); return; }
        await _codeInspect(ctx.type, ctx.componentId, ctx.componentName, panel, ctx.inspBtn, `✅ Deployed — every file you changed is in the org, verified by re-reading it.${d.stillNames ? '' : ` Nothing in the ${spec.what} names the field now.`} ↩ Undo in Activity puts the previous source back.`);
      } catch (e) {
        say('fc-xml-ed-err', `❌ ${esc(e.message)}`);
        sync();
      }
    });
    tas[0]?.focus();
  }
  // ── Email templates (user 2026-11-08: "i want also email alerts, lightning email templates and classic email
  // templates") — one EmailTemplate record for every kind; its four text fields are read and written through REST
  // (sftk-emailtpl.js has the pure parts). ✂ / ⇄ from the row, ✎ an editor per text field in 🔍, a restore point
  // (the fields as they were, put back by a PATCH), History undo verified by re-reading the record.
  const _TPL_PATH = id => `services/data/v62.0/sobjects/EmailTemplate/${encodeURIComponent(String(id))}`;
  async function _tplRead(componentId) {
    const r = await bg({ type: 'SF_REST_GET', orgUrl: _orgUrl, sid: _sid, _suppressError: true, path: `${_TPL_PATH(componentId)}?fields=Id,Name,DeveloperName,TemplateType,UiType,FolderName,Subject,Body,HtmlValue,Markup` });
    if (!r || r.error) throw new Error(`the template could not be read (${_feText((r && r.error) || 'no answer')}) — nothing is changed without a restore point`);
    return r;
  }
  // The write of a template's text fields: a confirm (unless the caller already asked) with the diff of every changed
  // field — editable in place — a restore point, the PATCH, a re-read of each changed field, History undo.
  //   ctx: { componentId, componentName, rec }; next: the record with the new texts; o: { confirm, ico, how, swapTo, title, confirmLabel, histTitle }
  //   → 'cancel' | { ok: true, changed: [k…] }   (throws when Salesforce refuses or the re-read disagrees)
  async function _tplDeploy(ctx, next, o) {
    const { componentId, componentName, rec } = ctx;
    const kind = sftkTplKind(rec);
    let changed = sftkTplTextFields().filter(k => !sftkMdCodeSame(next[k], rec[k]));
    if (!changed.length) return 'cancel';
    if (o.confirm) {
      const gate = await sftkOrgWriteGate(_orgUrl);
      const edits = changed.map((k, i) => _cfEditBlock(`fcCfTpl${i}`, next[k], { what: k }));
      const sure = await sftkConfirmDestructive({
        title: o.title || `${o.ico} ${kind} — ${componentName}`,
        icon: o.ico || '✉️',
        items: [{ label: componentName, sub: kind }],
        revOverride: { html: `${o.ico || '✉️'} <strong>${esc(o.how)}.</strong> The template's other fields are not touched. Its texts as they are now are kept as a <strong>restore point</strong>: ↩ Undo in Activity (or ↩ Restore points, in Activity) puts them back.`, needsCheckbox: false, cls: 'sftk-rev-newver' },
        undoHint: 'Undo in Activity',
        extraHtml: changed.map((k, i) => `<div class="fc-xml-diff-hd"><code>${esc(k)}</code> — <span class="xd-del">− as it is</span> · <span class="xd-add">+ as it will be</span></div>${_textDiffHtml(rec[k], next[k])}${edits[i].html}`).join(''),
        confirmLabel: o.confirmLabel || '⬆ Deploy',
        production: gate.production ? { label: gate.label } : null,
        onRender: () => edits.forEach(e => e.onRender()),
      });
      if (!sure) return 'cancel';
      changed.forEach((k, i) => { const v = edits[i].value(); if (v != null) next[k] = v; });
      changed = sftkTplTextFields().filter(k => !sftkMdCodeSame(next[k], rec[k]));
      if (!changed.length) return 'cancel';
    }
    const before = {}, after = {};
    for (const k of changed) { before[k] = rec[k] == null ? '' : rec[k]; after[k] = next[k] == null ? '' : next[k]; }
    const path = _TPL_PATH(componentId);
    const readMsg = { type: 'SF_REST_GET', path: `${path}?fields=${changed.join(',')}` };
    const verifyBack = { msg: readMsg, pick: '.', field: changed[0], equals: before[changed[0]], loose: true };   // '.' = the answer itself (a record, not a list)
    await _snapshotFix('MdEdit', componentId, componentName, rec.DeveloperName || componentName, { type: 'EmailTemplate', mdType: 'EmailTemplate', what: kind, swapTo: o.swapTo || null, how: [o.how], patch: { path, body: before }, verify: verifyBack });
    const j = sftkHistoryBegin({ tool: 'Field Cleaner', title: o.histTitle || `${o.ico || '✉️'} Email template — "${componentName}"`, orgUrl: _orgUrl });
    let wr;
    try {
      // confirmed-by: the sftkConfirmDestructive above, or fixOne's for ✂ / ⇄ from the row
      // The write discipline (sftk-write.js): the PATCH of the changed text fields is the write; the verify re-reads
      // them and finds the text that was sent (line endings aside).
      wr = await sftkWriteVerified({
        describe: `"${componentName}" ${kind}`,
        journal: j,
        write: async () => {
          const r = await bg({ type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid, _suppressError: true, path, body: after });
          return (r && !r.error) ? { success: true } : { error: (r && r.error) || 'the update was not accepted' };
        },
        verify: async () => {
          for (let i = 0; i < 3; i++) {
            const a = await bg({ ...readMsg, orgUrl: _orgUrl, sid: _sid, _suppressError: true });
            if (a && !a.error && changed.every(k => sftkMdCodeSame(a[k], after[k]))) return { ok: true, text: null };
            await new Promise(res => setTimeout(res, 1000));
          }
          return { ok: false, text: null };
        },
      });
      if (wr.accepted && wr.ok) return { ok: true, changed };
      if (wr.accepted) throw new Error(`"${componentName}" — the update was accepted, but on re-read the template does not hold the text that was sent. Open 🔍 to see what the org holds.`);
      throw new Error(`Salesforce refused the template update for "${componentName}": ${_feText(String((wr.raw && wr.raw.error) || 'refused'))}. Nothing was changed.`);
    } finally {
      await sftkHistoryEnd(j, { undo: wr && wr.accepted
        ? { steps: [{
            describe: `Put the ${kind} "${componentName}" back as it was before the ${o.ico === '⇄' ? 'replace' : o.ico === '✂' ? 'remove' : 'edit'}`,
            // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read in `verify`
            msg: { type: 'SF_PATCH', path, body: before },
            verify: { ...verifyBack, retries: 3, text: { ok: `"${componentName}": the template's texts are back as they were — verified by re-reading the org`, bad: `"${componentName}": the update was accepted, but on re-read the texts are not back yet` } },
          }] }
        : { none: 'nothing was accepted by Salesforce, so there is nothing to undo' } });
    }
  }
  // ✂ / ⇄ from the row (fixOne's confirm already asked): every merge field that names the field, out or renamed.
  async function fixEmailTemplate(componentId, componentName, swap) {
    const field = _selField.api;
    const nf = swap && _replOn() ? _replField.api : null;
    const rec = await _tplRead(componentId);
    // objApi: a merge field of another object's same-named field is left as it is (2026-11-14)
    // 2026-11-15 (close-out review round 2): a custom field picked on Task / Event is Activity's — sftkMdFamObj
    const famObj = sftkMdFamObj(_selObj.api, field);
    const r = nf ? sftkTplReplace(rec, field, nf, famObj) : sftkTplRemove(rec, field, famObj);
    // a Visualforce component bound to the field that ✂ cannot take out: refused with the reason, nothing written (2026-11-14)
    if (r.refused) {
      const e = new Error(`"${componentName}": ${r.refused}.`);
      e.setupUrl = `${_orgUrl.replace(/\/$/, '')}/lightning/o/EmailTemplate/home`;
      throw e;
    }
    if (!r.n) {
      const e = new Error(nf
        ? `"${componentName}" writes ${field} nowhere as a word in its subject, body, HTML or markup — the index lists it for a mention elsewhere (a description, a letterhead…). Open 🔍 to see the texts.`
        : `"${componentName}" has no merge field that names ${field} in its subject, body, HTML or markup — the index lists it for a mention elsewhere. Open 🔍 to see the texts, or ⇄ Replace it.`);
      e.setupUrl = `${_orgUrl.replace(/\/$/, '')}/lightning/o/EmailTemplate/home`;
      throw e;
    }
    const how = nf ? `${r.n} merge field${r.n === 1 ? '' : 's'} in ${r.fields.join(', ')} now name${r.n === 1 ? 's' : ''} ${nf}` : `${r.n} merge field${r.n === 1 ? '' : 's'} removed from ${r.fields.join(', ')}`;
    const d = await _tplDeploy({ componentId, componentName, rec }, { ...rec, ...r.rec }, { confirm: false, ico: nf ? '⇄' : '✂', how, swapTo: nf, histTitle: `${nf ? '⇄' : '✂'} Email template — "${componentName}" (${_selObj.api}.${field}${nf ? ` → ${nf}` : ' removed'})` });
    if (d === 'cancel') return 'cancel';
    return `✅ ${sftkTplKind(rec)} updated · ${how} — verified by re-reading the org`;
  }
  // 🔍 on a template: the kind and folder, every text field that holds something, the field's lines marked; ✎ opens the editor.
  async function _tplInspect(componentId, componentName, panel, inspBtn, note) {
    const rec = await _tplRead(componentId);
    const field = _selField.api, kind = sftkTplKind(rec);
    const hits = sftkTplHits(rec, field);
    const shown = sftkTplTextFields().filter(k => typeof rec[k] === 'string' && rec[k]);
    const body = shown.map(k => { const n = hits.filter(x => x.field === k).length; const h = _xiHighlightApex(rec[k]); return `<div class="fc-code-file"><div class="fc-code-file-hd"><code>${esc(k)}</code><span class="fc-code-file-n">${n ? `${n} line${n === 1 ? ' names' : 's name'} the field` : 'no line names the field'}</span></div><pre class="fc-xml-pre fc-xml-pre--code"><code>${h.html}</code></pre></div>`; }).join('');
    // 2026-11-15 (close-out review round 3): the hint counts with the object ✂ / ⇄ use (fixEmailTemplate's famObj) —
    // it said "none here" for {!Event.Region__c} that the fix does take out
    const famObj = sftkMdFamObj(_selObj.api, field);
    const rp = _replOn() ? sftkTplReplace(rec, field, _replField.api, famObj) : null;
    const rm = sftkTplRemove(rec, field, famObj);
    const hint = `<div class="fc-xml-hint">✂ Remove takes every merge field that names <code>${esc(field)}</code> out of the texts${rm.refused ? ` — not here: ${esc(rm.refused)}` : rm.n ? ` — here ${rm.n} in ${rm.fields.join(', ')}` : ' — none here'}. ⇄ Replace renames it inside them${rp ? (rp.n ? ` — here ${rp.n} place${rp.n === 1 ? '' : 's'} would name <code>${esc(_replField.api)}</code>` : ' — nothing here writes it as a word') : ' — pick a replacement field above to see what it would change'}. ✎ edits the texts as they are.</div>`;
    panel.innerHTML = `
      <div class="fc-xml-hdr">
        <span class="fc-xml-hdr-name">${esc(componentName)} <small class="fc-xml-src">· ${esc(kind)}${rec.FolderName ? ` · ${esc(rec.FolderName)}` : ''} · EmailTemplate ${esc(rec.DeveloperName || componentId)} · REST</small></span>
        <span class="fc-xml-badge ${hits.length ? 'fc-xml-badge--hit' : 'fc-xml-badge--miss'}">${hits.length ? `${hits.length} line${hits.length === 1 ? ' names' : 's name'} the field` : 'no line names the field'}</span>
        <span class="fc-xml-hdr-actions"><button class="btn btn-secondary btn-sm fc-xml-edit-btn" title="Edit the subject, body, HTML and markup as text and save them back — a restore point is kept">✎ Edit texts</button><button class="fc-xml-close" data-panelid="${esc(componentId)}">✕</button></span>
      </div>
      ${note ? `<div class="fc-xml-ed-ok fc-xml-ed-done">${esc(note)}</div>` : ''}
      <div class="fc-xml-body">${hint}${body || '<div class="fc-xml-hint">The template holds no text in its subject, body, HTML or markup.</div>'}</div>`;
    panel.querySelector('.fc-xml-close')?.addEventListener('click', () => { panel.style.display = 'none'; if (inspBtn) inspBtn.classList.remove('fc-inspect-btn--open'); });
    panel.querySelector('.fc-xml-edit-btn')?.addEventListener('click', ev => { ev.currentTarget.disabled = true; _tplEditorOpen(panel, { componentId, componentName, rec, inspBtn }); });
    _addXmlNavigation(panel);
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  // ✎ the template editor: one box per text field (the empty ones too, so a subject can be added), saved as a whole.
  function _tplEditorOpen(panel, ctx) {
    const box = panel.querySelector('.fc-xml-body');
    if (!box) return;
    const { rec } = ctx, kind = sftkTplKind(rec);
    // a Visualforce template has Markup, the others Subject + Body + HtmlValue; the fields the kind cannot take are left out
    const fields = String(rec.TemplateType || '').toLowerCase() === 'visualforce' ? ['Subject', 'Markup'] : ['Subject', 'Body', 'HtmlValue'];
    box.innerHTML = `
      <div class="fc-xml-editor">
        <div class="fc-xml-ed-hint">✎ Edit the texts and save them back — exactly this text is written to the ${esc(kind)} “${esc(ctx.componentName)}”. A restore point is kept; ↩ Undo in Activity puts the previous texts back.</div>
        ${fields.map((k, i) => `<div class="fc-code-ed-file"><div class="fc-code-file-hd"><code>${esc(k)}</code><span class="fc-code-file-n fc-code-ed-n" data-i="${i}">unchanged</span></div><textarea class="fc-xml-ta fc-code-ta fc-tpl-ta" data-i="${i}" data-k="${esc(k)}" spellcheck="false" wrap="${k === 'Subject' ? 'soft' : 'off'}" aria-label="${esc(k)}"></textarea></div>`).join('')}
        <div class="fc-xml-ed-bar">
          <span class="fc-xml-ed-state">No change yet</span>
          <button class="btn btn-secondary btn-sm fc-xml-ed-reset" disabled>↺ Start over</button>
          <button class="btn btn-secondary btn-sm fc-xml-ed-cancel">Cancel</button>
          <button class="btn btn-primary btn-sm fc-xml-ed-deploy" disabled>⬆ Save to the org</button>
        </div>
        <div class="fc-xml-ed-out" role="status"></div>
      </div>`;
    const tas = [...box.querySelectorAll('.fc-tpl-ta')], state = box.querySelector('.fc-xml-ed-state');
    const go = box.querySelector('.fc-xml-ed-deploy'), reset = box.querySelector('.fc-xml-ed-reset'), out = box.querySelector('.fc-xml-ed-out');
    const origOf = k => String(rec[k] == null ? '' : rec[k]).replace(/\r\n?/g, '\n');
    tas.forEach(ta => { ta.value = origOf(ta.dataset.k); ta.rows = ta.dataset.k === 'Subject' ? 2 : Math.min(24, Math.max(5, ta.value.split('\n').length + 1)); });
    const sync = () => {
      let n = 0;
      tas.forEach((ta, i) => { const d = ta.value !== origOf(ta.dataset.k); const el = box.querySelector(`.fc-code-ed-n[data-i="${i}"]`); if (el) el.textContent = d ? 'changed' : 'unchanged'; if (d) n++; });
      state.textContent = n ? `${n} field${n === 1 ? '' : 's'} changed` : 'No change yet';
      go.disabled = !n; reset.disabled = !n;
    };
    tas.forEach(ta => ta.addEventListener('input', () => { out.innerHTML = ''; sync(); }));
    reset.addEventListener('click', () => { tas.forEach(ta => { ta.value = origOf(ta.dataset.k); }); out.innerHTML = ''; sync(); });
    box.querySelector('.fc-xml-ed-cancel').addEventListener('click', () => { _tplInspect(ctx.componentId, ctx.componentName, panel, ctx.inspBtn); });
    go.addEventListener('click', async () => {
      go.disabled = true;
      const say = (cls, html) => { out.innerHTML = `<div class="${cls}">${html}</div>`; };
      const next = { ...rec }; tas.forEach(ta => { next[ta.dataset.k] = ta.value; });
      const n = tas.filter(ta => ta.value !== origOf(ta.dataset.k)).length;
      try {
        const d = await _tplDeploy({ componentId: ctx.componentId, componentName: ctx.componentName, rec }, next, { confirm: true, ico: '⬆', how: `${n} field${n === 1 ? '' : 's'} edited by hand`, title: `Save your text — ${kind} “${ctx.componentName}”`, confirmLabel: '⬆ Save', histTitle: `✎ Email template edited — "${ctx.componentName}"` });
        if (d === 'cancel') { say('fc-xml-ed-note', 'Not saved — cancelled. Your text is still in the boxes.'); sync(); return; }
        await _tplInspect(ctx.componentId, ctx.componentName, panel, ctx.inspBtn, `✅ Saved — ${d.changed.join(', ')} ${d.changed.length === 1 ? 'is' : 'are'} in the org as you wrote ${d.changed.length === 1 ? 'it' : 'them'}, verified by re-reading. ↩ Undo in Activity puts the previous texts back.`);
      } catch (e) { say('fc-xml-ed-err', `❌ ${esc(e.message)}`); sync(); }
    });
    tas[0]?.focus();
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
      if (_inspectsByMd(type)) { await _xmlInspectMd(type, componentId, componentName, panel, inspBtn); return; }
      if (_inspectsByCode(type)) { await _codeInspect(type, componentId, componentName, panel, inspBtn); return; }
      if (type === 'EmailTemplate') { await _tplInspect(componentId, componentName, panel, inspBtn); return; }
      const sobject = _INSPECT_SOBJECT[type];
      const res     = await bg({
        type: 'SF_TOOLING_GET', orgUrl: _orgUrl, sid: _sid,
        sobject, id: componentId
      });
      if (res.error) throw new Error(res.error);

      const cfg     = TYPE_CFG[type] || TYPE_CFG_DEFAULT;
      const fixable = cfg.fixable;
      let bodyHtml, refCount, delCount = 0, meta = null;

      const isDeletableFn = _XI_IS_DELETABLE[type] || null;

      if (type === 'ApexClass' || type === 'ApexTrigger') {
        // Show Apex source with field refs highlighted line-by-line
        ({ html: bodyHtml, count: refCount } = _xiHighlightApex(res.Body || ''));
        bodyHtml = `<pre class="fc-xml-pre fc-xml-pre--code"><code>${bodyHtml}</code></pre>`;
      } else {
        // Render Metadata JSON as pretty XML with deletion block markers
        meta = res.Metadata;
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
      // Salesforce's dependency index matches on TEXT: a page whose description mentions
      // the field's API name is listed, though no component or rule uses it (user 2026-10-11:
      // "no refs found, why do i see the lightning page then?"). Such an item has nothing to
      // remove and must not keep "Delete Field" locked — it is settled here, and says why.
      // 2026-11-14 (release QA): the inspector's count matches a WHOLE value only, while the scan listed a Lightning
      // page on a token buried inside a larger string too (a related list's 'NAME,Status__c', a filter's JSON). Such a
      // page was settled here as '✅ Nothing uses the field' — false, and it unlocked Delete Field. A page is settled
      // only when the scan's own tester, run without the page's description and label, no longer finds the field.
      const stillNamed = type === 'FlexiPage' && _flexiNamesBeyondText(meta, _selObj?.api, _selField?.api);
      if (!refCount && !delCount && fixable && type !== 'Flow' && type !== 'ApexClass' && type !== 'ApexTrigger') {
        if (!stillNamed) markFixed(componentId, '✅ Nothing uses the field here — Salesforce lists it because its description or another text mentions the field’s name. Nothing to remove.');
      }
      if (stillNamed && !refCount) badgeTxt = 'named inside a longer value — not settled';
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
            revOverride: { html: '⚠ Any OLD, INACTIVE versions of this flow that still reference the field are then <strong>permanently deleted</strong>.' +
              '<div class="sftk-cf-plan"><ol class="sftk-cf-rows">' +
              '<li><b>Writes</b><span>🔁 Deploys a new flow version without the selected blocks</span></li>' +
              '<li><b>Undo</b><span>The previous version remains and can be re-activated</span></li>' +
              '<li><b>Why delete</b><span>To clear the dependency lock on the field</span></li>' +
              '<li><b>Recycle Bin</b><span>None — Salesforce holds no Recycle Bin for flow versions</span></li></ol></div>', needsCheckbox: true },
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
  // metadata before modifying it. The 🧾 Cleanup history section lists them
  // with ↩ Restore, which redeploys the untouched snapshot through the same
  // deploy paths the fixes use. Doubles as an audit trail.
  const SNAP_KEY = 'fc_fix_snapshots';
  const SNAP_CAP = 20;
  // 2026-11-14 (release QA): the cap was 20 for ONE array shared by every org, so a flow with more than 20 versions
  // that name the field pushed its own first versions' restore points out DURING the fix (and any later fix, in any
  // org, pushed out the rest) — while the confirm promised "Restore points hold every deleted version", and Salesforce
  // keeps no Recycle Bin for flow versions. Now: a point younger than SNAP_RUN_MS is never pushed out (the run that
  // made it, and the day after, keep every one; unlimitedStorage is granted), and the cap counts the OLDER points per
  // org, so one org's fixes never evict another's.
  const SNAP_RUN_MS = 24 * 60 * 60 * 1000;
  function _snapTrim(list, cap, now, keepMs) {
    const out = [], olderPerOrg = new Map();
    let dropped = 0;
    for (const x of (list || [])) {
      if (!x) continue;
      if (now - (Number(x.at) || 0) < keepMs) { out.push(x); continue; }
      const k = x.orgKey || '';
      const n = olderPerOrg.get(k) || 0;
      if (n < cap) { out.push(x); olderPerOrg.set(k, n + 1); } else dropped++;
    }
    return { list: out, dropped };
  }

  // NO RESTORE POINT, NO WRITE (QA 2026-11-11). A failed save used to be logged and passed over — the fix went on
  // while its dialog said "a restore point is saved first" (and a flow fix deletes versions for good). Every caller
  // saves BEFORE it writes, so a throw here stops the fix with nothing changed. A full store is retried once with
  // half as many of the older-than-a-day points kept per org (never one of the last day's).
  async function _snapshotFix(type, id, name, fullName, metadata) {
    const entry = {
      at: Date.now(),
      orgKey: sftkOrgKey(_orgUrl), orgUrl: _orgUrl,
      type, id, name, fullName: fullName || null,
      obj: _selObj?.api, field: _selField?.api,
      metadata: JSON.parse(JSON.stringify(metadata === undefined ? null : metadata)),   // deep copy — fixers mutate in place
    };
    let lastErr = null;
    for (const cap of [SNAP_CAP, Math.max(1, Math.floor(SNAP_CAP / 2))]) {
      try {
        const store = await chrome.storage.local.get(SNAP_KEY);
        const list = [entry, ...(store[SNAP_KEY] || []).filter(x => x !== entry)];
        const kept = _snapTrim(list, cap, Date.now(), SNAP_RUN_MS);
        await chrome.storage.local.set({ [SNAP_KEY]: kept.list });
        if (kept.dropped && window.SFToolkitDebug?.enabled) window.SFToolkitDebug.log('fields', 'info', 'restore points older than a day dropped', kept.dropped);
        try { renderSnapshotLog(); } catch (_) { /* the list is a view; the restore point is saved */ }
        return;
      } catch (e) { lastErr = e; }
    }
    if (window.SFToolkitDebug?.enabled) window.SFToolkitDebug.log('fields', 'error', 'snapshot failed', lastErr && lastErr.message);
    throw new Error(`The restore point for “${name}” could not be saved (${(lastErr && lastErr.message) || 'storage error'}) — nothing was changed. Free some space (Activity → Back up · Restore · Clear) and try again.`);
  }

  // A restore point's kind in words: "🗑 validation rule", "✂ workflow rule", "Layout"…
  function _snapKind(s) {
    const what = s && s.metadata && s.metadata.what;
    if (s.type === 'MdDelete') return `🗑 ${what || 'component'}`;
    if (s.type === 'MdEdit') return `${s.metadata && s.metadata.swapTo ? '⇄' : '✂'} ${what || 'component'}`;
    return s.type;
  }
  // ── ↩ Undo all for this field (owner 2026-11-15: "we need an undo all. without going over all the components one
  // by one. and dont forget to show the progess of the undo all" · "undo all for field cleaner per a field") ──
  // A bar above the results: how many of this tool's changes for the picked field can still be undone, and one button
  // that takes them all back — one confirmation, newest first, each step re-read, the progress shown as it goes.
  function _fcSubject() { return _selObj && _selField ? `${_selObj.api}.${_selField.api}` : ''; }
  // every History entry this tool begins is stamped with the picked field (sftkHistoryBegin asks; no call site names it)
  if (typeof sftkHistorySubjectFor === 'function') sftkHistorySubjectFor('Field Cleaner', _fcSubject);
  let _undoAllBusy = false, _undoAllNote = null, _undoAllWired = false;
  function _undoAllSummary(res) {
    const bad = res.failed.length, left = res.total - res.ran;
    return (bad || res.stopped ? '⚠ ' : '✅ ') + `${res.ok} of ${res.total} change${res.total === 1 ? '' : 's'} undone and verified by re-reading the org`
      + (bad ? ` · ${bad} not undone` : '') + (res.stopped ? ` · ${left} not tried — ${res.stopped}` : '') + '.';
  }
  async function renderUndoAll(doneHtml) {
    const host = eid('fcUndoAll');
    if (!host || _undoAllBusy) return;
    // a change is in History only when its entry ends — after the row is already marked done: follow the store
    if (!_undoAllWired) {
      _undoAllWired = true;
      try { chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.sftk_history) renderUndoAll(); }); } catch (_) { /* no storage events outside the extension page */ }
    }
    const subj = _fcSubject();
    const list = subj && _orgUrl && typeof sftkHistoryUndoableFor === 'function'
      ? sftkHistoryUndoableFor(await sftkHistoryAll(), { tool: 'Field Cleaner', orgUrl: _orgUrl, subject: subj }) : [];
    if (subj !== _fcSubject() || _undoAllBusy) return;   // another field was picked while History was read
    // the summary of the last Undo all stays (through the re-scan) until the field or the list of changes moves on
    if (doneHtml !== undefined) _undoAllNote = doneHtml ? { subj, n: list.length, html: doneHtml } : null;
    else if (_undoAllNote && (_undoAllNote.subj !== subj || _undoAllNote.n !== list.length)) _undoAllNote = null;
    doneHtml = _undoAllNote ? _undoAllNote.html : '';
    if (!list.length && !doneHtml) { host.innerHTML = ''; return; }
    host.innerHTML = `<div class="fc-undoall">${list.length ? `<span class="fc-undoall-txt">↩ <b>${list.length}</b> change${list.length === 1 ? '' : 's'} made here for <code>${esc(subj)}</code> can be undone.</span>
      <button type="button" class="btn btn-secondary btn-sm" id="fcUndoAllBtn" title="Takes every one of them back, newest first — one confirmation; each step is re-read from the org">↩ Undo all ${list.length}</button>` : ''}
      ${doneHtml || ''}</div>`;
    eid('fcUndoAllBtn')?.addEventListener('click', () => undoAllForField(list, subj));
  }
  async function undoAllForField(list, subj) {
    if (_undoAllBusy || !list.length) return;
    const gate = await sftkOrgWriteGate(_orgUrl);
    const stepsOf = e => ((e.toolUndo && e.toolUndo.steps) || []).length;
    const sure = await sftkConfirmDestructive({
      title: `↩ Undo all — ${list.length} change${list.length === 1 ? '' : 's'} for ${subj}`,
      icon: '↩',
      items: list.map(e => ({ label: e.profileName, sub: `${stepsOf(e)} step${stepsOf(e) === 1 ? '' : 's'}` })),
      revOverride: {
        html: 'Writes the previous state of each of these back, <strong>newest first</strong>. An undo has no undo — to redo a change, use the tool again.'
          + '<div class="sftk-cf-plan"><ol class="sftk-cf-rows">'
          + '<li><b>Steps</b><span>One change at a time; each step is re-read from the org to confirm it</span></li>'
          + '<li><b>A failure</b><span>Does not stop the rest — it is listed at the end with Salesforce’s reason</span></li>'
          + '<li><b>Recorded</b><span>Every undo is its own entry in Activity</span></li>'
          + '<li><b>Not included</b><span>A change Activity says cannot be undone (deleted flow versions, a deleted field) stays as it is</span></li></ol></div>',
        needsCheckbox: true,
        ack: 'I understand this writes the earlier state back over whatever is there now',
      },
      revWord: 'Writes the earlier state back',
      confirmLabel: `↩ Undo all ${list.length}`,
      production: gate.production ? { label: gate.label } : null,
    });
    if (!sure) return;
    const host = eid('fcUndoAll');
    _undoAllBusy = true;
    host.innerHTML = '<div class="fc-undoall fc-undoall-run"><div class="fc-undoall-prog"></div><details class="fc-undoall-log" open><summary>What is being undone</summary><ol></ol></details></div>';
    const ol = host.querySelector('ol');
    const prog = typeof sftkProgress === 'function'
      ? sftkProgress(host.querySelector('.fc-undoall-prog'), { what: `Undoing ${list.length} change${list.length === 1 ? '' : 's'} for ${subj}…`, key: 'fc-undo-all', orgUrl: _orgUrl, total: list.length, unit: 'changes', small: true }) : null;
    let li = null, res;
    try {
      res = await sftkHistoryUndoMany(list, {
        onStart: (i, n, e) => {
          li = document.createElement('li'); li.className = 'fc-undoall-li fc-undoall-now';
          li.textContent = `⏳ ${e.profileName}`; ol.appendChild(li); li.scrollIntoView({ block: 'nearest' });
          if (prog) prog.say(`Undoing ${i + 1} of ${n} — ${e.profileName}`);
        },
        onEnd: (i, n, e, r) => {
          if (li) { li.className = `fc-undoall-li ${r && r.ok ? 'fc-undoall-ok' : 'fc-undoall-bad'}`; li.textContent = `${r && r.ok ? '✅' : '❌'} ${e.profileName} — ${(r && r.text) || 'no answer'}`; }
          if (prog) prog.count(i + 1, n);
        },
      });
    } catch (e) {
      res = { total: list.length, ran: 0, ok: 0, failed: [], stopped: String((e && e.message) || e) };
    } finally {
      if (prog) prog.done();
      _undoAllBusy = false;
    }
    const log = host.querySelector('.fc-undoall-log');
    if (log) { log.open = !!(res.failed.length || res.stopped); log.querySelector('summary').textContent = 'What was undone'; }
    const logHtml = log ? log.outerHTML : '';
    await renderUndoAll(`<div class="fc-undoall-done ${res.failed.length || res.stopped ? 'fc-undoall-warn' : ''}">${esc(_undoAllSummary(res))} The list below is read again from the org.</div>${logHtml}`);
    // what the page lists is from before the undo: scan again, so nothing shown is assumed
    const scan = eid('fcScanBtn');
    if (scan && !scan.disabled && subj === _fcSubject()) scan.click();
  }

  async function renderSnapshotLog() {
    renderUndoAll();
    // The list of changes and the restore points are not on this page any more (owner 2026-11-16: "we have the
    // activity tab for them"): Activity lists the changes; its ↩ Restore points button opens the window below,
    // which holds the #fcSnapLog this function fills.
    const el = eid('fcSnapLog');
    if (!el) return;
    const store = await chrome.storage.local.get(SNAP_KEY);
    const all = store[SNAP_KEY] || [];
    const mine = _orgUrl ? all.filter(s => s.orgKey === sftkOrgKey(_orgUrl)) : all;
    if (!mine.length) { el.innerHTML = '<div class="sftk-th-sub">No restore point is kept for this org.</div>'; return; }
    el.innerHTML = `
      <details class="fc-snaplog" open>
        <summary>↩ Restore points — ${mine.length} piece${mine.length === 1 ? '' : 's'} of metadata saved before a fix</summary>
        <div class="fc-snap-rows">
          ${mine.map(s => `
            <div class="fc-snap-row">
              <span class="fc-snap-when">${new Date(s.at).toLocaleString()}</span>
              <span class="fc-snap-what">${esc(_snapKind(s))} <strong>${esc(s.name)}</strong>
                <small>(${esc(s.obj || '?')}.${esc(s.field || '?')} ${s.type === 'MdEdit' && s.metadata && s.metadata.swapTo ? `→ ${esc(s.metadata.swapTo)}` : s.type === 'MdDelete' ? 'blocker deleted' : 'removed'})</small></span>
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

  // ↩ Restore points, opened from Activity: the metadata saved before each fix, with ↩ Restore. A flow's deleted
  // versions other than the one ↩ Undo brings back are only here.
  function openRestorePoints() {
    if (typeof showModal !== 'function') return;
    showModal(`<div class="modal-header">↩ Restore points — Field Cleaner</div>
      <div class="sftk-th-intro">${_orgUrl ? 'The metadata saved before each fix in this org. ↩ Restore deploys a piece back exactly as it was — it asks first.' : 'Open Field Cleaner on an org first: a restore point is deployed back to the org it came from.'}</div>
      <div id="fcSnapLog" class="sftk-th-modal"></div>
      <div class="modal-actions"><button class="btn btn-secondary" id="fcSnapClose">Close</button></div>`);
    const box = document.getElementById('modalBox'); if (box) box.style.width = 'min(860px, 94vw)';
    document.getElementById('fcSnapClose')?.addEventListener('click', () => closeModal());
    if (_orgUrl) renderSnapshotLog();
  }
  if (typeof window !== 'undefined') window.sftkFcRestorePoints = openRestorePoints;

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
      } else if (snap.type === 'MdDelete' || snap.type === 'MdEdit') {
        // the restore point of a 🗑 Delete: the saved files go back as a package
        if (!md || (!md.patch && (!Array.isArray(md.files) || !md.files.length))) throw new Error('Snapshot has no files — cannot deploy');
        const j = sftkHistoryBegin({ tool: 'Field Cleaner', title: `↩ Restore ${md.what || 'component'} — "${snap.name}"`, orgUrl: _orgUrl });
        try {
          // confirmed-by: the ↩ Restore sftkConfirmDestructive (the only caller)
          // The write discipline (sftk-write.js): the deploy is the write, the
          // same re-read the delete's undo uses is the verify.
          const wr = await sftkWriteVerified({
            describe: `${md.what || 'component'} restore`,
            journal: j,
            write: async () => {
              if (md.patch) { const r = await bg({ type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid, _suppressError: true, ...md.patch }); return (r && !r.error) ? { success: true } : { error: (r && r.error) || 'the update was not accepted' }; }
              const r = await bg({ type: 'SF_METADATA_DEPLOY', orgUrl: _orgUrl, sid: _sid, _suppressError: true, zipBase64: _zipOf(md.files) });
              return (r && r.success) ? r : { error: (r && r.error) || 'the deploy was not accepted' };
            },
            verify: async () => {
              const v = md.verify || {};
              let a = null;
              if (v.msg) a = await bg({ ...v.msg, orgUrl: _orgUrl, sid: _sid, _suppressError: true });
              else if (v.query) a = await bg({ type: 'SF_QUERY_ALL', orgUrl: _orgUrl, sid: _sid, tooling: !!v.tooling, _suppressError: true, query: v.query });
              const r = (typeof sftkUndoVerifyEval === 'function') ? sftkUndoVerifyEval(v, a) : { ok: !!a && !a.error };
              return { ok: !!r.ok, text: null };
            },
          });
          if (!wr.accepted) throw new Error((wr.raw && wr.raw.error) || 'refused');
          if (!wr.ok) throw new Error('restored, but the org could not be re-read to confirm it — check it in Setup');
        } finally {
          await sftkHistoryEnd(j, { undo: { none: snap.type === 'MdEdit' ? 'this is itself the undo — press ✂ / ⇄ in the tool to change it again' : 'this is itself the undo — press 🗑 Delete in the tool to delete it again' } });
        }
      } else if (snap.type === 'ReportType') {
        if (!snap.fullName || !md.innerXml) throw new Error('Snapshot has no developer name or XML — cannot deploy');
        // History (sftk-history.js): this button IS the undo of the fix that
        // took the snapshot, so it gets its own journaled entry.
        const j = sftkHistoryBegin({ tool: 'Field Cleaner', title: `↩ Restore report type — "${snap.name}"`, orgUrl: _orgUrl });
        try {
          // confirmed-by: the ↩ Restore sftkConfirmDestructive (the only caller)
          // The write discipline (sftk-write.js): the deploy is the write, a
          // SOAP re-read of the type is the verify.
          const wr = await sftkWriteVerified({
            describe: 'Report type restore',
            journal: j,
            write: async () => {
              const r = await bg({ type: 'SF_METADATA_DEPLOY', orgUrl: _orgUrl, sid: _sid, _suppressError: true,
                zipBase64: buildReportTypeZip(snap.fullName, sftkMdRecordFileXml('ReportType', md.innerXml)) });
              return (r && r.success) ? r : { error: (r && r.error) || 'the deploy was not accepted' };
            },
            verify: async () => {
              try { const after = await readReportType(snap.fullName); return { ok: sftkRtMentions(after, sftkMdFamObj(snap.obj, snap.field), snap.field) > 0, text: null }; }   // the family object, as the fix that took the snapshot (2026-11-15)
              catch (_) { return { ok: false, text: null }; }
            },
          });
          if (!wr.accepted) throw new Error((wr.raw && wr.raw.error) || 'refused');
          if (!wr.ok) throw new Error('restored, but the org could not be re-read to confirm it — check it in Setup → Report Types');
        } finally {
          await sftkHistoryEnd(j, { undo: { none: 'this is itself the undo — redo the fix from the tool to remove the column again' } });
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
