'use strict';
// ═════════════════════════════════════════════════════════════════════════
// sftk-matching.js — shared match-key engine (Phase M3a)
// ═════════════════════════════════════════════════════════════════════════
// THE INVARIANT (R1's hard lesson): the diff scan and EVERY writer that
// re-resolves records server-side must build match keys IDENTICALLY —
// normalization is part of the key. This file is the ONE key builder;
// runDiffScan, the reconcile relink pass, and the group-B insert bridge all
// go through it. Never re-implement key building anywhere else.
//
// Classic script (loaded before studio-core.js). Top-level column-0 pure
// functions so test/extract.mjs can unit-test them without a DOM.
//
// node.matching shape (persisted on profile tree nodes):
//   { strategy: 'field' | 'composite' | 'externalId',
//     fields:   ['Name', 'Email__c', ...],      // ordered, max 4
//     normalize:{ caseFold, trim, collapseWs, emailLower, phoneDigits } }
// Back-compat: nodes without .matching fall back to the legacy single
// node.matchField (default 'Name') via sftkMatchingFromNode — EVERY consumer
// resolves through that function so old profiles keep working unchanged.

// The component separator — U+0001, a control character Salesforce strips
// from text data, so composite keys can never collide with a single-field
// value that happens to contain the separator text. Built via fromCharCode
// so the source file carries no raw control bytes.
// Key separator: U+0001 — can't appear in org data. Inlined as
// String.fromCharCode(1) INSIDE each consumer so test/extract.mjs can
// materialize the functions self-contained (project extraction constraint).

// Apply the normalization toggles to one field value. null/undefined → ''.
// Order is fixed (trim → collapseWs → emailLower → phoneDigits → caseFold)
// so the same toggles always produce the same key on both sides.
function sftkNormalizeValue(v, normalize) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  const n = normalize || {};
  if (n.trim)       s = s.trim();
  if (n.collapseWs) s = s.replace(/\s+/g, ' ');
  // emailLower: lowercase only email-shaped values (contains @, no spaces) —
  // leaves non-email text alone so the toggle is safe on mixed fields.
  if (n.emailLower && s.indexOf('@') !== -1 && !/\s/.test(s.trim())) {
    s = s.toLowerCase();
  }
  // phoneDigits: reduce phone-shaped values ("(415) 555-1234 x89") to their
  // digits. Only applies when the text looks like a phone number (digits +
  // separators, 7+ digits) — never mangles ordinary text.
  if (n.phoneDigits) {
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 7 && /^[\d\s()+\-./x#*]*$/i.test(s)) s = digits;
  }
  if (n.caseFold)   s = s.toLowerCase();
  return s;
}

// Build the match key for one record. Components are joined with U+0001
// (a control char that can't appear in Salesforce text data, so composite
// keys can never collide with a single-field value that contains the
// separator text). A record whose components are ALL blank returns '' —
// callers must treat '' as UNMATCHABLE (excluded from key indexes), never
// as a valid key.
// The engine's default for an UNCONFIGURED lookup at an object outside the
// deployment: match by Name, unless that object has nothing to match by. The
// worker keeps its own copy of this list (background.js) — keep them equal.
function sftkLookupDefaultStrategy(refObj) {
  const NO_NAME = new Set(['Case', 'Order', 'Contract', 'Task', 'Event', 'CaseComment', 'OrderItem', 'OpportunityContactRole',
    'CampaignMember', 'ContentDocumentLink', 'Attachment', 'EmailMessage', 'FeedItem', 'Note', 'ContentDocument', 'ContentVersion', 'Quote', 'ReturnOrder', 'WorkOrder',
    'OpportunityHistory', 'ActivityHistory', 'OpportunityFieldHistory', 'AccountHistory', 'ContactHistory', 'CaseHistory']);
  return NO_NAME.has(String(refObj || '')) ? 'skip' : 'match';
}

// A key component may be a relationship path ('Opportunity.Name'): SOQL
// returns it nested ({ Opportunity: { Name } }). Lookups hold org-local Ids
// and can never match across orgs — the related record's NAME can (live run
// 2026-09-22: OpportunityContactRole has no Name at all).
function sftkPathValue(record, path) {
  if (!record || !path) return undefined;
  const p = String(path);
  if (p in record) return record[p];
  if (!p.includes('.')) return undefined;
  let cur = record;
  for (const seg of p.split('.')) { if (cur === null || cur === undefined || typeof cur !== 'object') return undefined; cur = cur[seg]; }
  return cur;
}

// PURE. The best key a describe offers when the node has none configured and
// the object has no usable Name: external ID → unique field → non-autonumber
// name field → the records it points at, BY NAME (a junction's two parents),
// with a text field added when that is still a single component. `opts`:
// lookupResolutions (per-lookup match field), parentField (a child scan's
// link — its parent's KEY comes first as parentKeyPath). null = no key.
function sftkMatchingFallback(fields, opts) {
  const o = opts || {};
  const fs = Array.isArray(fields) ? fields.filter(Boolean) : [];
  const SYS = new Set(['OwnerId', 'CreatedById', 'LastModifiedById', 'RecordTypeId', 'MasterRecordId']);
  const ext = fs.find(f => f.externalId === true && f.name !== 'Id');
  if (ext) return { strategy: 'externalId', fields: [ext.name], normalize: {}, why: 'external ID' };
  const uniq = fs.find(f => f.unique === true && f.type !== 'id' && f.name !== 'Id');
  if (uniq) return { strategy: 'field', fields: [uniq.name], normalize: {}, why: 'unique field' };
  const nameF = fs.find(f => f.nameField === true && !f.autoNumber);
  if (nameF) return { strategy: 'field', fields: [nameF.name], normalize: {}, why: 'name field' };
  const lr = o.lookupResolutions || {};
  const canName = obj => (typeof sftkLookupDefaultStrategy === 'function') ? sftkLookupDefaultStrategy(obj) === 'match' : true;
  const refs = fs.filter(f => f.type === 'reference' && f.relationshipName && !SYS.has(f.name) && f.name !== o.parentField
    && !(f.polymorphicForeignKey || (f.referenceTo || []).length > 1) && f.createable !== false
    && ((lr[f.name] && lr[f.name].matchField) || canName((f.referenceTo || [])[0])));   // a parent with no Name cannot be a key part
  const ordered = [...refs.filter(f => f.nillable === false), ...refs.filter(f => f.nillable !== false)];
  const comps = [];
  if (o.parentField && o.parentKeyPath) comps.push(o.parentKeyPath);
  // A subject-like text field first (Subject, Title, Description…): it is what
  // a human calls the record — Case, Contract and Order have an autonumber
  // name and are told apart by it.
  const textish = f => ['string', 'textarea', 'email', 'phone'].includes(f.type) && f.createable !== false && !f.autoNumber && !SYS.has(f.name) && !f.calculated;
  const subject = fs.find(f => textish(f) && /^(Subject|Title|Description|Name)$/.test(f.name)) || null;
  if (subject) comps.push(subject.name);
  for (const f of ordered) { if (comps.length >= 3) break; comps.push(`${f.relationshipName}.${(lr[f.name] && lr[f.name].matchField) || 'Name'}`); }
  if (comps.length < 2) {
    const txt = fs.find(f => textish(f) && !comps.includes(f.name));
    if (txt) comps.push(txt.name);
  }
  if (!comps.length) return null;
  const auto = fs.find(f => f.nameField === true && f.autoNumber);
  return { strategy: comps.length > 1 ? 'composite' : 'field', fields: comps.slice(0, 4), normalize: { trim: true, collapseWs: true },
    why: auto ? `${auto.name} is an org-generated number, so the record is told apart by what a person would use` : 'the records it points at, by name — this object has no Name field' };
}

function sftkMatchKey(record, matching) {
  const m = matching || {};
  const fields = Array.isArray(m.fields) ? m.fields.filter(Boolean) : [];
  if (!record || !fields.length) return '';
  const norm = m.normalize || {};
  const parts = fields.map(f => sftkNormalizeValue(sftkPathValue(record, f), norm));
  if (!parts.some(p => p !== '')) return '';
  return parts.join(String.fromCharCode(1));
}

// Back-compat resolver — THE single entry point for reading a node's
// matching config. Returns node.matching when present (sanitized), else the
// legacy single-field fallback built from node.matchField (default 'Name').
function sftkMatchingFromNode(node) {
  const m = node ? node.matching : null;
  if (m && Array.isArray(m.fields) && m.fields.filter(Boolean).length) {
    const strategy = (m.strategy === 'composite' || m.strategy === 'externalId')
      ? m.strategy : 'field';
    return {
      strategy,
      fields: m.fields.filter(Boolean).slice(0, 4),
      normalize: { ...(m.normalize || {}) },
      // most specific first (user 2026-10-23): a composite key where a record that leaves a later
      // component empty is matched by the components it has — see sftkTieredPairs
      tiered: strategy === 'composite' && m.tiered === true
    };
  }
  return {
    strategy: 'field',
    fields: [(node && node.matchField) || 'Name'],
    normalize: {}
  };
}

// The source-side field list a scan/writer must SELECT to build keys.
function sftkMatchingFields(matching) {
  const f = matching && Array.isArray(matching.fields)
    ? matching.fields.filter(Boolean) : [];
  return f.length ? f.slice(0, 4) : ['Name'];
}

// TARGET-side field names for the same key components. Each source field
// maps through node.fieldMappings (a non-null mapping wins, else the same
// name is assumed on target). The FIRST component additionally honors the
// legacy explicit node.matchFieldTgt pick from Pick Records.
function sftkMatchingTgtFields(node, matching) {
  const m = matching || sftkMatchingFromNode(node);
  const fm = (node && node.fieldMappings) || {};
  return sftkMatchingFields(m).map((f, i) => {
    if (i === 0 && node && node.matchFieldTgt) return node.matchFieldTgt;
    const t = fm[f];
    return (t !== null && t !== undefined && t !== '') ? t : f;
  });
}

// Human-readable form of a (possibly composite) match key — the U+0001
// separator renders as ' · ' so composite keys read naturally in the UI.
// NEVER use the label form for matching — only for display.
function sftkMatchKeyLabel(key) {
  return String(key === null || key === undefined ? '' : key).split(String.fromCharCode(1)).join(' · ');
}

// NEAR-MISS detection (user bug 2026-08-04: one child record "not found" —
// its external-Id value differed from the target's only by whitespace, and
// the two values LOOK identical on screen). Given a source key and a target
// key that failed to match, name the invisible difference — or null when
// they are genuinely different values. Component-wise (keys are
// U+0001-joined) so one whitespace component and one case component still
// report both. PURE.
function sftkNearMissReason(srcKey, tgtKey) {
  const SEP = String.fromCharCode(1);
  const a = String(srcKey ?? '').split(SEP);
  const b = String(tgtKey ?? '').split(SEP);
  if (a.length !== b.length) return null;
  let ws = false, cs = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const wsFold = s => s.trim().replace(/\s+/g, ' ');
    if (wsFold(a[i]) === wsFold(b[i])) { ws = true; continue; }
    if (a[i].toLowerCase() === b[i].toLowerCase()) { cs = true; continue; }
    if (wsFold(a[i]).toLowerCase() === wsFold(b[i]).toLowerCase()) { ws = true; cs = true; continue; }
    return null;   // a real difference — not a near miss
  }
  if (!ws && !cs) return null;   // identical keys never reach here, but be safe
  return ws && cs ? 'case + whitespace' : ws ? 'whitespace' : 'case';
}

// The fold used to INDEX target keys for near-miss lookup — must accept
// exactly the differences sftkNearMissReason can name. PURE.
function sftkNearMissFold(key) {
  const SEP = String.fromCharCode(1);
  return String(key ?? '').split(SEP)
    .map(s => s.trim().replace(/\s+/g, ' ').toLowerCase())
    .join(SEP);
}

// ── Key-quality math (M3b) — pure so the analyzer is unit-testable ────────

// Fold SOQL GROUP BY aggregate rows [{ value, count }] into a normalized
// key-count map. Values are normalized CLIENT-side (SOQL grouping is
// case-insensitive for text but knows nothing about our other toggles), so
// two raw groups can merge into one normalized key.
function sftkKeyCountsFromGroups(rows, normalize) {
  const keyCounts = new Map();
  let total = 0, blank = 0;
  for (const r of (rows || [])) {
    const c = Number(r && r.count) || 0;
    total += c;
    const k = sftkNormalizeValue(r ? r.value : null, normalize || {});
    if (k === '') { blank += c; continue; }
    keyCounts.set(k, (keyCounts.get(k) || 0) + c);
  }
  return { keyCounts, total, blank };
}

// Fold sampled records into a key-count map using the full key builder —
// the composite path of the analyzer.
function sftkKeyCountsFromRecords(records, matching) {
  const keyCounts = new Map();
  let total = 0, blank = 0;
  for (const rec of (records || [])) {
    total++;
    const k = sftkMatchKey(rec, matching);
    if (k === '') { blank++; continue; }
    keyCounts.set(k, (keyCounts.get(k) || 0) + 1);
  }
  return { keyCounts, total, blank };
}

// Per-org quality stats from a key-count map:
//   populatedPct — % of records with a non-blank key
//   uniquePct    — % of POPULATED records whose key appears exactly once
function sftkKeyStats(counts) {
  const total = counts ? counts.total : 0;
  const blank = counts ? counts.blank : 0;
  const populated = total - blank;
  let uniqueRecords = 0;
  if (counts && counts.keyCounts) {
    for (const c of counts.keyCounts.values()) if (c === 1) uniqueRecords++;
  }
  const pct = (a, b) => b > 0 ? Math.round((a / b) * 100) : 0;
  return {
    total,
    populated,
    blank,
    uniqueRecords,
    dupRecords: populated - uniqueRecords,
    populatedPct: pct(populated, total),
    uniquePct: pct(uniqueRecords, populated)
  };
}

// Cross-org preview from two key-count maps (source vs target):
//   matchedUnique — source records whose key exists exactly once on BOTH sides
//   ambiguous     — source records whose key exists on both sides but is
//                   duplicated on either (matching would be a coin toss)
//   unmatched     — source records whose key is absent from target, plus
//                   blank-key source records (unmatchable by definition)
function sftkCrossOrgPreview(srcCounts, tgtCounts) {
  const src = srcCounts || { keyCounts: new Map(), total: 0, blank: 0 };
  const tgt = tgtCounts || { keyCounts: new Map(), total: 0, blank: 0 };
  let matchedUnique = 0, ambiguous = 0, unmatched = src.blank || 0;
  for (const [k, sc] of (src.keyCounts || new Map())) {
    const tc = tgt.keyCounts ? (tgt.keyCounts.get(k) || 0) : 0;
    if (!tc)                      unmatched     += sc;
    else if (sc === 1 && tc === 1) matchedUnique += 1;
    else                           ambiguous     += sc;
  }
  return { sourceTotal: src.total, matchedUnique, ambiguous, unmatched };
}

// Composite 0-100 quality score for a graded key — the ranking behind the
// ★ best key badge in 💡 Suggestions. A key must be good in EVERY reachable
// org, so the score is the MINIMUM per-org score, where each org scores
// populatedPct × uniquePct / 100 — both must be high (100% populated but
// 50% unique is a coin flip, not a key). `extraCounts` carries additional
// target orgs' key-count maps (multi-target profiles — user 2026-08-11:
// "the highest matching keys per source and targets and their data"), so a
// key clean in one target and half-blank in another can't wear the ★.
// Returns null when no org produced counts (nothing graded ≠ scored zero).
function sftkMatchKeyScore(res, extraCounts) {
  const sides = [res && res.src, res && res.tgt]
    .concat(Array.isArray(extraCounts) ? extraCounts : [])
    .filter(Boolean);
  if (!sides.length) return null;
  let min = 100;
  for (const counts of sides) {
    const st = sftkKeyStats(counts);
    min = Math.min(min, Math.round(st.populatedPct * st.uniquePct / 100));
  }
  return min;
}

// ── Match memory (M3c) — pure so extract tests can cover them ─────────────

// Merge learned [srcId, tgtId] pairs into an existing memory map (plain
// object { srcId: tgtId }), returning a NEW object. Re-learning a srcId
// refreshes it (delete + re-insert moves it to the end of the insertion
// order). When the merged map exceeds `cap` (default 5000), the OLDEST
// entries are evicted — "oldest" = earliest in the object's insertion order,
// which is approximate LRU (arbitrary-oldest eviction is acceptable: memory
// is an optimization layer; evicted pairs simply fall back to key matching).
function sftkMemoryMerge(mem, pairs, cap) {
  const limit = (typeof cap === 'number' && cap > 0) ? Math.floor(cap) : 5000;
  const out = {};
  const src = (mem && typeof mem === 'object') ? mem : {};
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (k && typeof v === 'string' && v) out[k] = v;
  }
  for (const p of (Array.isArray(pairs) ? pairs : [])) {
    if (!Array.isArray(p)) continue;
    const s = p[0], t = p[1];
    if (typeof s !== 'string' || !s || typeof t !== 'string' || !t) continue;
    if (Object.prototype.hasOwnProperty.call(out, s)) delete out[s]; // refresh recency
    out[s] = t;
  }
  const keys = Object.keys(out);
  for (let i = 0; i < keys.length - limit; i++) delete out[keys[i]];
  return out;
}

// Match memory without the given source ids — a decision taken back on the
// ⚠ Needs a decision tab. PURE; returns a NEW object.
function sftkMemoryForget(mem, srcIds) {
  const drop = new Set((Array.isArray(srcIds) ? srcIds : []).map(String));
  const out = {};
  const src = (mem && typeof mem === 'object') ? mem : {};
  for (const k of Object.keys(src)) if (!drop.has(k) && typeof src[k] === 'string' && src[k]) out[k] = src[k];
  return out;
}

// One target record can be the same as only ONE source record. PURE.
// answers: [[srcId, answer]] — a target id, '__new__' or '' (not decided).
// Returns the srcId of the first record that claims a target already claimed
// by an earlier one, or ''.
function sftkAmbTwice(answers) {
  const used = new Set();
  for (const a of (Array.isArray(answers) ? answers : [])) {
    if (!Array.isArray(a)) continue;
    const t = a[1];
    if (!t || t === '__new__') continue;
    if (used.has(t)) return String(a[0] || '');
    used.add(t);
  }
  return '';
}

// 0..1 similarity of two ALREADY-NORMALIZED match-key strings. Component-
// aware: keys split on the U+0001 separator (String.fromCharCode(1), inlined
// for self-contained extraction) and the score is the MEAN of per-component
// scores — 1 for equal components, else prefix-ratio partial credit
// (shared-prefix length / longer component length).
//
// FOR RANKING MATCH-REVIEW CANDIDATES ONLY. Never use this for automatic
// matching — pairing is a human decision (M3c invariant).
function sftkPairSimilarity(keyA, keyB) {
  const a = String(keyA === null || keyA === undefined ? '' : keyA).split(String.fromCharCode(1));
  const b = String(keyB === null || keyB === undefined ? '' : keyB).split(String.fromCharCode(1));
  const n = Math.max(a.length, b.length);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] || '', y = b[i] || '';
    if (x === y) { sum += 1; continue; }        // equal (both-blank counts as equal)
    const longer = Math.max(x.length, y.length);
    if (!longer) { sum += 1; continue; }
    const shorter = Math.min(x.length, y.length);
    let p = 0;
    while (p < shorter && x[p] === y[p]) p++;
    sum += p / longer;
  }
  return sum / n;
}

// ── Scan accuracy (2026-07-17, user: "say how accurate it is") ────────────
// Grade how trustworthy a FINISHED scan's matching was, from what the scan
// itself recorded. Unlike the M3b pre-flight analyzer (which samples live
// orgs before scanning), this reflects the exact rows behind the buckets.
// Row universe: a matched pair counts 2 rows (one per side); missing /
// target-only / blank-key / collision-excluded rows count 1 each.
// Uncertain rows — the ones that cap confidence:
//   • blank keys (every component empty) — unmatchable
//   • duplicated keys — ambiguous: child scans EXCLUDED them (keyCollisions),
//     root scans paired them arbitrarily (dupKeys) — untrustworthy either way
// Memory-matched pairs (M3c) are Id-exact; they always count as confident.
// Returns null when there is nothing to grade (error scan / both sides empty).
// Campaign 3 phase 5 — the match-memory value that means "this source record
// has NO counterpart in the target: list it under Insert" (⚠ Ambiguous →
// ➕ insert as new). Stored in profile.matchMemory like a pair, so it is kept,
// exported and cleared with the pairs; a later deploy of the record learns
// its real target id over it. Never a valid Salesforce Id.
const SFTK_MEM_NEW = '__insert_as_new__';

// PURE. Campaign 3 phase 5 — what one match key means once the memory pairs
// are out, given how many rows hold it on each side (Maps key → count):
//   'pair'      one source and at most one target, or no source and one target
//               — matched / missing / only-in-target exactly as before
//   'insertAll' two or more source copies and NO target row: distinct records
//               the target simply lacks → every copy is an insert
//   'extraAll'  two or more target copies and NO source row → every copy is
//               "in target only"
//   'ambiguous' the key is on both sides and duplicated on at least one: the
//               scan cannot tell which copy is which → the ⚠ Ambiguous bucket,
//               never guessed (before: last copy won, the other vanished)
function sftkScanKeyClasses(srcCounts, tgtCounts) {
  const out = new Map();
  const keys = [...(srcCounts ? srcCounts.keys() : []), ...(tgtCounts ? tgtCounts.keys() : [])];
  for (const k of keys) {
    if (out.has(k)) continue;
    const sN = (srcCounts && srcCounts.get(k)) || 0, tN = (tgtCounts && tgtCounts.get(k)) || 0;
    out.set(k, sN <= 1 && tN <= 1 ? 'pair'
      : tN === 0 ? 'insertAll'
      : sN === 0 ? 'extraAll'
      : 'ambiguous');
  }
  return out;
}

// PURE. Campaign 4 (user 2026-10-03: "we need to make the ambigious page more
// understandble") — what the page needs to make a ⚠ group DECIDABLE instead of
// "Same as #1 · Same as #2 · Same as #3" over records that look identical:
// which compared field tells the copies apart, and which pairs that field
// PROVES (the same value on exactly one copy on each side).
//   groups: [{ key, src: [{ id, vals }], tgt: [{ id, vals }] }] — vals[i] is the
//           record's value of fields[i], as a string ('' when empty)
//   fields: [name]
// → { rows:  Map(srcId → { tell: [[field, value]], suggest: tgtId|undefined, by: field|undefined }),
//     cands: Map(tgtId → [[field, value]]),
//     advice: [{ field, groups, records }]  (best first — groups a field settles
//             completely, records it pairs), settled: number of suggested pairs }
// A suggestion is only ever a PAIR. "No copy on the other side has this value"
// proves nothing (the field itself may have changed), so it suggests nothing.
function sftkAmbiguousInsight(groups, fields) {
  const rows = new Map(), cands = new Map();
  const perField = (fields || []).map(() => ({ groups: 0, records: 0 }));
  let settled = 0;
  const uniqNonEmpty = vals => vals.every(v => v !== '') && new Set(vals).size === vals.length;
  for (const g of (groups || [])) {
    const src = g.src || [], tgt = g.tgt || [];
    let best = null;   // { i, pairs: Map(srcId → tgtId) }
    const distinct = [];
    for (let i = 0; i < (fields || []).length; i++) {
      const sv = src.map(r => String((r.vals || [])[i] ?? '')), tv = tgt.map(r => String((r.vals || [])[i] ?? ''));
      distinct.push(new Set([...sv, ...tv].filter(v => v !== '')).size);
      if (!uniqNonEmpty(sv) || !uniqNonEmpty(tv)) continue;
      const tIdx = new Map(tv.map((v, k) => [v, k]));
      const pairs = new Map();
      sv.forEach((v, k) => { if (tIdx.has(v)) pairs.set(src[k].id, tgt[tIdx.get(v)].id); });
      if (!pairs.size) continue;
      if (pairs.size === src.length) { perField[i].groups++; }
      perField[i].records += pairs.size;
      if (!best || pairs.size > best.pairs.size) best = { i, pairs };
    }
    // what to SHOW next to each copy: the proving field first, then the fields
    // with the most different values in this group (at most three)
    const order = distinct.map((d, i) => ({ d, i })).filter(x => x.d > 1).sort((a, b) => b.d - a.d || a.i - b.i).map(x => x.i);
    const show = [...new Set([...(best ? [best.i] : []), ...order])].slice(0, 3);
    const tellOf = r => show.map(i => [fields[i], String((r.vals || [])[i] ?? '')]);
    for (const r of src) {
      const t = best ? best.pairs.get(r.id) : undefined;
      rows.set(r.id, { tell: tellOf(r), suggest: t, by: t ? fields[best.i] : undefined });
      if (t) settled++;
    }
    for (const r of tgt) cands.set(r.id, tellOf(r));
  }
  const advice = perField.map((x, i) => ({ field: fields[i], groups: x.groups, records: x.records }))
    .filter(a => a.records > 0).sort((a, b) => b.records - a.records || b.groups - a.groups).slice(0, 3);
  return { rows, cands, advice, settled };
}

function sftkScanAccuracy(scan) {
  if (!scan || scan.error) return null;
  const matched  = (scan.identical || []).length + (scan.changed || []).length;
  const missing  = (scan.missingInTarget || []).length;
  const extra    = (scan.onlyInTarget || []).length;
  const blank    = (scan.blankKeys && scan.blankKeys.rows) || 0;
  // Phase 5 scans carry the ⚠ Ambiguous bucket: its source copies AND their
  // candidate targets are in no other bucket — they extend the total and are
  // the uncertain part. Older stored scans keep the old reading below.
  const amb      = Array.isArray(scan.ambiguous) ? scan.ambiguous : null;
  const ambRows  = amb ? amb.length + new Set(amb.flatMap(r => (r && r.candidates) || [])).size : 0;
  const excluded = amb ? ambRows : ((scan.keyCollisions && scan.keyCollisions.rows) || 0); // child: rows NOT in buckets
  const dupRoot  = amb ? 0 : ((scan.dupKeys && scan.dupKeys.rows) || 0);                  // root (old scans): rows still in buckets
  const total    = matched * 2 + missing + extra + blank + excluded;
  if (!total) return null;
  const uncertain = Math.min(total, blank + excluded + dupRoot);
  const pct   = Math.round(((total - uncertain) / total) * 100);
  const grade = pct >= 95 ? 'high' : pct >= 80 ? 'ok' : 'low';
  const m = scan.matching || {};
  const fields = (Array.isArray(m.fields) && m.fields.filter(Boolean).length)
    ? m.fields.filter(Boolean).slice(0, 4)
    : [scan.matchField || 'Name'];
  return { pct, grade, fields, strategy: m.strategy || 'field',
           total, blank, dup: excluded + dupRoot, memory: scan.memoryMatched || 0 };
}

// ── Most specific first (user 2026-10-23: "if we have 100 pct population of the field name but
// only 90 on the second field … pick the most specific by both fields and then fall back to only
// matching by name for those who don't hold the value of the second field") ─────────────────
//
// A tiered composite key reads its components as EVIDENCE, not as one string: the first component
// is the anchor and must be present and equal on both sides; every later component counts when
// BOTH records hold a value — equal values add to the match, different values rule the pair out,
// an empty value on either side says nothing. The candidate that agrees on the most components
// wins; two candidates that agree equally well, or two source records that want the same target
// equally, are not guessed — they go to ⚠ Needs a decision. All PURE.

// The normalized components of a record's key ('' for an empty one).
function sftkMatchParts(record, matching) {
  const m = matching || {};
  const fields = Array.isArray(m.fields) ? m.fields.filter(Boolean) : [];
  if (!record || !fields.length) return [];
  const norm = m.normalize || {};
  return fields.map(f => sftkNormalizeValue(sftkPathValue(record, f), norm));
}

// How well two part lists agree: -1 when they cannot be the same record (an empty anchor on
// either side, different anchors, or a component both hold with different values); otherwise
// the number of components both hold with equal values (the anchor counts).
function sftkTieredScore(a, b) {
  if (!a || !b || !a.length || !b.length) return -1;
  if (a[0] === '' || b[0] === '' || a[0] !== b[0]) return -1;
  let n = 1;
  const len = Math.min(a.length, b.length);
  for (let i = 1; i < len; i++) {
    if (a[i] === '' || b[i] === '') continue;
    if (a[i] !== b[i]) return -1;
    n++;
  }
  return n;
}

// Among candidate part lists, the one that agrees best with `want`: its index, or -1 when none
// agrees or two agree equally well (a relink never guesses a parent).
function sftkTieredPick(want, candidates) {
  let best = -1, bestScore = 0, tie = false;
  (candidates || []).forEach((c, i) => {
    const s = sftkTieredScore(want, c);
    if (s < 0) return;
    if (s > bestScore) { best = i; bestScore = s; tie = false; }
    else if (s === bestScore) tie = true;
  });
  return tie ? -1 : best;
}

// The scan's pairing for a tiered key. srcRecs / tgtRecs: records (with Id); srcMatching /
// tgtMatching: { fields, normalize } per side. Returns
//   { pairs: [[key, sr, tr]], inserts: [[key, sr, dupKey]], extras: [[key, tr, dupKey]],
//     groups: Map(anchor → { srcs: [sr], tgts: [tr] })   // ⚠ Needs a decision, one group per anchor
//     blankSrc, blankTgt }
// Within one anchor the best unique claims are settled first (highest agreement, one claimant),
// each settled pair freeing the rest; what is left with a candidate is one group for the user.
function sftkTieredPairs(srcRecs, tgtRecs, srcMatching, tgtMatching) {
  const SEP = String.fromCharCode(1);
  const keyOf = parts => parts.join(SEP);
  const byAnchor = new Map();
  let blankSrc = 0, blankTgt = 0;
  const add = (side, r, parts) => {
    if (!parts.length || parts[0] === '') { if (side === 's') blankSrc++; else blankTgt++; return; }
    if (!byAnchor.has(parts[0])) byAnchor.set(parts[0], { srcs: [], tgts: [] });
    byAnchor.get(parts[0])[side === 's' ? 'srcs' : 'tgts'].push({ r, parts, key: keyOf(parts) });
  };
  for (const r of (srcRecs || [])) add('s', r, sftkMatchParts(r, srcMatching));
  for (const r of (tgtRecs || [])) add('t', r, sftkMatchParts(r, tgtMatching));
  const pairs = [], inserts = [], extras = [], groups = new Map();
  for (const [anchor, g] of byAnchor) {
    let srcs = g.srcs.slice(), tgts = g.tgts.slice();
    // scores[i][j] for the records still open
    for (;;) {
      if (!srcs.length || !tgts.length) break;
      const best = srcs.map(s => {
        let top = 0, at = [];
        tgts.forEach((t, j) => { const sc = sftkTieredScore(s.parts, t.parts); if (sc < 0) return; if (sc > top) { top = sc; at = [j]; } else if (sc === top) at.push(j); });
        return { top, at };
      });
      // a settled claim: one best target for this source, and this source the only one that
      // wants that target this well or better
      let settled = null;
      for (let i = 0; i < srcs.length && !settled; i++) {
        const b = best[i];
        if (!b.top || b.at.length !== 1) continue;
        const j = b.at[0];
        const rival = srcs.some((s2, i2) => i2 !== i && best[i2].top >= b.top && best[i2].at.includes(j));
        if (!rival) settled = [i, j];
      }
      if (!settled) break;
      const [i, j] = settled;
      pairs.push([srcs[i].key, srcs[i].r, tgts[j].r]);
      srcs.splice(i, 1); tgts.splice(j, 1);
    }
    // what is left: records with no candidate are ordinary inserts / extras; the rest is one group
    const openS = srcs.filter(s => tgts.some(t => sftkTieredScore(s.parts, t.parts) >= 0));
    const openT = tgts.filter(t => srcs.some(s => sftkTieredScore(s.parts, t.parts) >= 0));
    for (const s of srcs) if (!openS.includes(s)) inserts.push([s.key, s.r, srcs.filter(x => x !== s && x.key === s.key).length > 0]);
    for (const t of tgts) if (!openT.includes(t)) extras.push([t.key, t.r, tgts.filter(x => x !== t && x.key === t.key).length > 0]);
    if (openS.length) groups.set(anchor, { srcs: openS.map(s => s.r), tgts: openT.map(t => t.r) });
  }
  return { pairs, inserts, extras, groups, blankSrc, blankTgt };
}

// What a key reads like, for the person configuring it (labels, not API names):
//   "Account Name + ID Number + Email" and, when tiered, how a record with fewer values is matched.
function sftkMatchingReadsAs(labels, tiered) {
  const L = (labels || []).filter(Boolean);
  if (!L.length) return { key: '', how: '' };
  const key = L.join(' + ');
  if (!tiered || L.length < 2) return { key, how: L.length < 2 ? `Two records are the same when their ${L[0]} is equal.` : `Two records are the same only when all ${L.length} values are present and equal.` };
  const steps = [];
  for (let n = L.length; n >= 1; n--) steps.push(n === L.length ? `a record with all ${n} values is matched on all ${n}` : n === 1 ? `one with only ${L[0]} is matched on ${L[0]} alone` : `one without ${L.slice(n).join(' or ')} on ${L.slice(0, n).join(' + ')}`);
  return { key, how: `Most specific first: ${steps.join('; ')}. A value that differs on both sides rules the pair out; a pair that is not the single best match is listed under ⚠ Needs a decision.` };
}

// ── Global attach (classic-script export) ─────────────────────────────────
if (typeof globalThis !== 'undefined') {
  globalThis.sftkNormalizeValue      = sftkNormalizeValue;
  globalThis.sftkMatchKey            = sftkMatchKey;
  globalThis.sftkMatchingFromNode    = sftkMatchingFromNode;
  globalThis.sftkMatchingFields      = sftkMatchingFields;
  globalThis.sftkMatchingTgtFields   = sftkMatchingTgtFields;
  globalThis.sftkMatchKeyLabel       = sftkMatchKeyLabel;
  globalThis.sftkKeyCountsFromGroups = sftkKeyCountsFromGroups;
  globalThis.sftkKeyCountsFromRecords = sftkKeyCountsFromRecords;
  globalThis.sftkKeyStats            = sftkKeyStats;
  globalThis.sftkCrossOrgPreview     = sftkCrossOrgPreview;
  globalThis.sftkMatchKeyScore       = sftkMatchKeyScore;
  globalThis.sftkMemoryMerge         = sftkMemoryMerge;
  globalThis.sftkPairSimilarity      = sftkPairSimilarity;
  globalThis.sftkScanAccuracy        = sftkScanAccuracy;
  globalThis.sftkScanKeyClasses      = sftkScanKeyClasses;
  globalThis.SFTK_MEM_NEW            = SFTK_MEM_NEW;
  globalThis.sftkMemoryForget        = sftkMemoryForget;
  globalThis.sftkAmbTwice            = sftkAmbTwice;
  globalThis.sftkMatchParts          = sftkMatchParts;
  globalThis.sftkTieredScore         = sftkTieredScore;
  globalThis.sftkTieredPick          = sftkTieredPick;
  globalThis.sftkTieredPairs         = sftkTieredPairs;
  globalThis.sftkMatchingReadsAs     = sftkMatchingReadsAs;
}
