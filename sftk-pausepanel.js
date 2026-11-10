'use strict';
// ═════════════════════════════════════════════════════════════════════════
// sftk-pausepanel.js — what a deployment switches off in the target, per
// object, and the user's choice about each item.
// ═════════════════════════════════════════════════════════════════════════
// User 2026-11-08: "בדאטה דיפלוי, צריך להציג למשתמש את מה שמכבים כשעושים
// דיפלוי עם אפשרות לבחור לפי האובייקטים שאנחנו מעבירים אליהם" — "גם פלואים,
// גם דופליקישן רולס, וגם ולידציות".
//
// Three kinds ride a run: record-triggered flows (sftk-flowpause.js, switched
// off and back on), validation rules (sftk-vrpause.js, the same), duplicate
// rules (NEVER switched: a bypass header on the writes, per object — a rule
// set to Block still blocks). The panel lists them under the objects the
// deployment writes to; every item has a tick, and an unticked item stays as
// it is in the target. Keys: 'flow:<apiName>', 'rule:<id>', 'dupe:<object>'.
// Everything here is pure — arrays in, arrays out — except the one reader.

function sftkPauseKey(kind, item) {
  if (kind === 'flow') return `flow:${item.apiName}`;
  if (kind === 'rule') return `rule:${item.id}`;
  return `dupe:${item.object}`;
}

// Active duplicate rules from the REST DuplicateRule rows → one per rule.
function sftkDupeRuleSelect(rows) {
  const out = [];
  for (const r of (rows || [])) {
    if (!r || !r.Id || !r.SobjectType) continue;
    out.push({ id: r.Id, name: r.DeveloperName || r.MasterLabel || r.Id, label: r.MasterLabel || r.DeveloperName || r.Id, object: r.SobjectType });
  }
  return out.sort((a, b) => a.object.localeCompare(b.object) || a.label.localeCompare(b.label));
}

// The active duplicate rules on `objects` in the org of `sess` — read only.
// → { rules: [{ id, name, label, object }], calls } or throws.
async function sftkDupeRuleList(sess, objects, send) {
  const bg = typeof send === 'function' ? send : sendBg;
  const objs = [...new Set((objects || []).filter(Boolean))];
  if (!objs.length) return { rules: [], calls: 0 };
  const lit = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const q = await bg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false, _silentError: true,
    query: `SELECT Id, DeveloperName, MasterLabel, SobjectType FROM DuplicateRule WHERE IsActive = true AND SobjectType IN (${objs.map(lit).join(',')})` });
  if (!q || q.error) throw new Error(`the org's duplicate rules could not be listed (${(q && q.error) || 'no answer'})`);
  return { rules: sftkDupeRuleSelect(q.records || []), calls: 1 };
}

// One row per deployment object, with every item the three options would
// touch and whether it is ticked. `lists`: { flows: [...]|null, rules:
// [...]|null, dupes: [...]|null } — null = that option is off (the kind is
// left out of the row). `skip`: Set of keys the user unticked. `written`:
// Set of objects this run writes (null = unknown, treat all as written).
function sftkPauseRows(objects, lists, skip, written) {
  const sk = skip || new Set();
  const l = lists || {};
  const rows = [];
  for (const obj of [...new Set((objects || []).filter(Boolean))]) {
    const pick = (kind, items) => (items || []).filter(x => x && x.object === obj)
      .map(x => ({ ...x, key: sftkPauseKey(kind, x), on: !sk.has(sftkPauseKey(kind, x)) }));
    const row = {
      object: obj,
      written: written ? written.has(obj) : true,
      flows: l.flows ? pick('flow', l.flows) : null,
      rules: l.rules ? pick('rule', l.rules) : null,
      dupes: l.dupes ? pick('dupe', l.dupes) : null,
    };
    row.total = (row.flows || []).length + (row.rules || []).length + (row.dupes || []).length;
    rows.push(row);
  }
  return rows;
}

// The items of one kind that the run acts on: on the objects it writes, and
// not unticked. `kept` is what the user left alone, named for the confirmation.
function sftkPauseKeep(kind, items, skip, written) {
  const sk = skip || new Set();
  const act = [], kept = [];
  for (const x of (items || [])) {
    if (!x) continue;
    if (written && !written.has(x.object)) continue;          // not written: the caller already says so
    (sk.has(sftkPauseKey(kind, x)) ? kept : act).push(x);
  }
  return { act, kept };
}

// The objects whose duplicate rules the run bypasses: every written object
// with an active rule that is still ticked. The header is per write, so the
// choice is per object.
function sftkPauseDupeObjects(dupes, skip, written) {
  const { act } = sftkPauseKeep('dupe', dupes, skip, written);
  return [...new Set(act.map(x => x.object))].sort();
}

// The name of one item for a sentence.
function sftkPauseItemName(kind, x) {
  if (kind === 'flow') return `${x.label || x.apiName}${x.version ? ` v${x.version}` : ''}${x.scheduled ? ' · ⏰ scheduled' : ''}`;
  if (kind === 'rule') return x.name;
  return x.label || x.name;
}

// The summary line under the panel — what goes off, per object, in words.
//   "Account: 2 flows, 1 validation rule, duplicate rules bypassed · Contact: 1 flow · Opportunity: nothing"
function sftkPauseSummary(rows) {
  const parts = [], none = [];
  for (const r of (rows || [])) {
    if (!r.total) { none.push(r.object); continue; }
    const bits = [];
    const nf = (r.flows || []).filter(x => x.on).length, nr = (r.rules || []).filter(x => x.on).length, nd = (r.dupes || []).filter(x => x.on).length;
    if (nf) bits.push(`${nf} flow${nf === 1 ? '' : 's'}`);
    if (nr) bits.push(`${nr} validation rule${nr === 1 ? '' : 's'}`);
    if (nd) bits.push('duplicate rules bypassed');
    parts.push(`${r.object}: ${bits.length ? bits.join(', ') : 'nothing — every item unticked'}${r.written ? '' : ' (nothing selected to write — stays on)'}`);
  }
  if (none.length) parts.push(`nothing active to switch on ${none.join(', ')}`);
  return parts.join(' · ');
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkPauseKey = sftkPauseKey;
  globalThis.sftkDupeRuleSelect = sftkDupeRuleSelect;
  globalThis.sftkDupeRuleList = sftkDupeRuleList;
  globalThis.sftkPauseRows = sftkPauseRows;
  globalThis.sftkPauseKeep = sftkPauseKeep;
  globalThis.sftkPauseDupeObjects = sftkPauseDupeObjects;
  globalThis.sftkPauseItemName = sftkPauseItemName;
  globalThis.sftkPauseSummary = sftkPauseSummary;
}
