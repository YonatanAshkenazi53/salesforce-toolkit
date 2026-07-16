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
function sftkMatchKey(record, matching) {
  const m = matching || {};
  const fields = Array.isArray(m.fields) ? m.fields.filter(Boolean) : [];
  if (!record || !fields.length) return '';
  const norm = m.normalize || {};
  const parts = fields.map(f => sftkNormalizeValue(record[f], norm));
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
      normalize: { ...(m.normalize || {}) }
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
  globalThis.sftkMemoryMerge         = sftkMemoryMerge;
  globalThis.sftkPairSimilarity      = sftkPairSimilarity;
}
