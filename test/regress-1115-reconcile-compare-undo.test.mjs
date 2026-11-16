// Regressions and half-applied fixes of release QA 1.1 (f0334a0), the
// reconcile / compare / undo area — 2026-11-15. Every test here RUNS the real
// function (sliced out of its file into one scope, the way the neighbouring
// regress-1115 files do); none asserts on source text.
//  1. dry run / preview: a child of the SAME object as its parent, and a
//     parent whose WHERE already holds a subquery, are no longer wrapped in a
//     semi-join Salesforce refuses — they read as an upper bound
//  2. rollback: parents kept for records added under them stay 'partial', but
//     every message says what is true for them and the next plan page names
//     them instead of "Nothing to roll back"
//  3. Org Compare: blank-key records are "cannot tell" — not missing, not
//     only-in-target, not drifted, not clean
//  4. behaviour of reconcileOverwrite's chunked write and of sftkUndoExecute's
//     status bookkeeping (were source-text assertions only)
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sliceFrom = (src, name) => {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(src);
  if (!m) throw new Error('not found ' + name);
  return src.slice(m.index, src.indexOf('\n}', m.index) + 2);
};
const sliceLine = (src, start) => {
  const i = src.indexOf(start);
  if (i < 0) throw new Error('not found ' + start);
  return src.slice(i, src.indexOf('\n', i) + 1);
};

// ═══ 1. dry run / preview scope ════════════════════════════════════════════
const { sftkChildCountWhere, sftkDryRunAgainst } = extractFunctions('studio-transfer.js',
  ['sftkChildCountWhere', 'sftkDryRunAgainst'], { 'studio-core.js': ['soqlStrLit'] });

describe('sftkChildCountWhere — shapes SOQL refuses as a semi-join fall back to an upper bound', () => {
  it('a child of the same object as its parent (Account under Account via ParentId)', () => {
    const r = sftkChildCountWhere({ childSObject: 'Account', field: 'ParentId' },
      { obj: 'Account', where: "Id IN ('001A','001B')", semiJoin: false });
    expect(r).toEqual({ where: null, semiJoin: false, unscoped: true });
  });
  it('the same-object test ignores case and keeps the node\'s own filter', () => {
    const r = sftkChildCountWhere({ childSObject: 'contact', field: 'ReportsToId', where: 'Email != null' },
      { obj: 'Contact', where: "LastName = 'X'", semiJoin: false });
    expect(r).toEqual({ where: 'Email != null', semiJoin: false, unscoped: true });
  });
  it('a parent WHERE that already holds a subquery is not nested', () => {
    const r = sftkChildCountWhere({ childSObject: 'Contact', field: 'AccountId' },
      { obj: 'Account', where: 'Id IN ( select AccountId FROM Opportunity WHERE IsWon = true)', semiJoin: false });
    expect(r).toEqual({ where: null, semiJoin: false, unscoped: true });
  });
  it('everything under an upper-bound parent is an upper bound too, even with no filter', () => {
    const r = sftkChildCountWhere({ childSObject: 'Contact', field: 'AccountId' },
      { obj: 'Account', where: null, semiJoin: false, unscoped: true });
    expect(r).toEqual({ where: null, semiJoin: false, unscoped: true });
  });
  it('a different-object child under a plain filter is still scoped exactly', () => {
    const r = sftkChildCountWhere({ childSObject: 'Contact', field: 'AccountId' },
      { obj: 'Account', where: "Id IN ('001A')", semiJoin: false });
    expect(r).toEqual({ where: "AccountId IN (SELECT Id FROM Account WHERE Id IN ('001A'))", semiJoin: true, unscoped: false });
  });
});

describe('sftkDryRunAgainst — a same-object child is checked, not failed', () => {
  const SRC = { orgUrl: 'https://acme.my.salesforce.com', sid: 'S' };
  const TGT = { orgUrl: 'https://acme--qa.sandbox.my.salesforce.com', sid: 'T' };
  const fld = (name, extra) => ({ name, type: 'string', createable: true, nillable: true, defaultValue: null, length: 255, ...extra });
  const DESC = { fields: [fld('Id', { createable: false, type: 'id' }), fld('Name', { nillable: false })] };
  afterEach(() => { delete globalThis.sendBg; });

  // The stub answers like Salesforce: a semi-join on the same object, or a
  // nested one, is MALFORMED_QUERY.
  const stub = () => {
    const queries = [];
    globalThis.sendBg = async msg => {
      if (msg.type === 'SF_REST_GET') return DESC;
      const q = String(msg.query || '');
      queries.push(q);
      const outer = (/FROM (\w+)/.exec(q) || [])[1];
      const inner = [...q.matchAll(/\(\s*SELECT Id FROM (\w+)/gi)].map(m => m[1]);
      if (inner.includes(outer) || inner.length > 1 || /\(\s*SELECT[^)]*\(\s*SELECT/i.test(q)) {
        return { error: 'MALFORMED_QUERY: The inner and outer selects should not be on the same object type' };
      }
      if (/COUNT\(\)/.test(q)) return { totalSize: 2, records: [] };
      if (/FROM ValidationRule|FROM ApexTrigger|FROM DuplicateRule/.test(q)) return { records: [] };
      if (/GROUP BY RecordType/.test(q)) return { error: 'no record types' };
      return { records: [{ Id: '001', Name: 'Acme' }] };
    };
    return queries;
  };

  it('Account → child Accounts (ParentId): both nodes checked, the child said to be an upper bound', async () => {
    const queries = stub();
    const lines = [];
    const tree = { objectType: 'Account', recordIds: ['001A', '001B'],
      children: [{ childSObject: 'Account', field: 'ParentId' }] };
    const r = await sftkDryRunAgainst(tree, SRC, TGT, (i, m) => lines.push(m), null);
    expect(r.checked).toBe(2);
    expect(lines.filter(m => /source query failed/.test(m))).toEqual([]);
    expect(lines.some(m => /^Account: cannot be limited to the records under its parent/.test(m))).toBe(true);
    expect(lines.some(m => m.startsWith('Account: ≤ 2 record(s)'))).toBe(true);
    expect(queries.some(q => /ParentId IN \(SELECT Id FROM Account/.test(q))).toBe(false);
  });

  it('a root filtered by a subquery: its child is checked as an upper bound, and so is the grandchild', async () => {
    const queries = stub();
    const lines = [];
    const tree = { objectType: 'Account', where: 'Id IN (SELECT AccountId FROM Opportunity WHERE IsWon = true)',
      children: [{ childSObject: 'Contact', field: 'AccountId',
        children: [{ childSObject: 'Case', field: 'ContactId' }] }] };
    const r = await sftkDryRunAgainst(tree, SRC, TGT, (i, m) => lines.push(m), null);
    expect(r.checked).toBe(3);
    expect(lines.filter(m => /source query failed/.test(m))).toEqual([]);
    expect(lines.some(m => m.startsWith('Contact: ≤ 2 record(s)'))).toBe(true);
    expect(lines.some(m => m.startsWith('Case: ≤ 2 record(s)'))).toBe(true);
    expect(queries).toContain('SELECT COUNT() FROM Contact');
  });
});

// ═══ 2. rollback — kept parents ════════════════════════════════════════════
const UNDO_PURE = read('sftk-undo.js');
const UNDO_UI = read('studio-undo.js');
const U = extractFunctions('sftk-undo.js', ['sftkUndoPickCoverage', 'sftkUndoLeftText', 'sftkUndoKeptOnlyText', 'sftkUndoCardState', 'sftkUndoRunWrote']);

describe('sftkUndoPickCoverage / sftkUndoLeftText — the two kinds of Kept are told apart', () => {
  const item = (created, changed, keptIds, cascadeUnknown = []) =>
    ({ objType: 'Account', scoped: { created, changed: changed.map(id => ({ id })) }, keptIds, cascadeUnknown });
  it('parents kept for later-added children are left in place AND counted as keptForChildren', () => {
    const a = item(['a1'], ['c1'], ['k1', 'k2']);
    const c = U.sftkUndoPickCoverage([a], [{ item: a, created: ['a1'], changed: [{ id: 'c1' }] }]);
    expect(c).toEqual({ planned: 4, acted: 2, left: 2, kept: 2, keptForChildren: 2, complete: false });
    const t = U.sftkUndoLeftText(c);
    expect(t).toContain('2 of 4 record(s) in the plan still hold the run\'s changes');
    expect(t).toContain('2 kept because records were added under them after the run');
    expect(t).toContain('only once those records are removed');
    expect(t).not.toMatch(/not picked|delete anyway/);
  });
  it('parents kept because a child could not be read are forceable, not keptForChildren', () => {
    const a = item(['a1'], [], ['k1'], ['Case: no access']);
    const c = U.sftkUndoPickCoverage([a], [{ item: a, created: ['a1'], changed: [] }]);
    expect(c).toMatchObject({ left: 1, kept: 1, keptForChildren: 0, complete: false });
    const t = U.sftkUndoLeftText(c);
    expect(t).toContain('tick "delete anyway"');
    expect(t).not.toContain('added under them');
  });
  it('unticked records, forceable kept and kept-for-children each get their own true clause', () => {
    const a = item(['a1', 'a2', 'a3'], [], ['k1'], ['Case: no access']);
    const b = item([], ['b1'], ['k2', 'k3']);
    const c = U.sftkUndoPickCoverage([a, b], [{ item: a, created: ['a1'], changed: [] }, { item: b, created: [], changed: [{ id: 'b1' }] }]);
    expect(c).toMatchObject({ planned: 7, acted: 2, left: 5, kept: 3, keptForChildren: 2 });
    const t = U.sftkUndoLeftText(c);
    expect(t).toContain('2 not picked — ↩ Roll back stays available in History for them');
    expect(t).toContain('1 kept because what hangs under them could not be checked');
    expect(t).toContain('2 kept because records were added under them after the run');
  });
  it('nothing left → no sentence; numbers are en-US', () => {
    expect(U.sftkUndoLeftText({ planned: 3, acted: 3, left: 0, kept: 0, keptForChildren: 0 })).toBe('');
    expect(U.sftkUndoLeftText({ planned: 12000, left: 1500, kept: 0, keptForChildren: 0 })).toContain('1,500 of 12,000');
  });
});

describe('sftkUndoKeptOnlyText — a plan with only Kept parents names them', () => {
  it('names the object, the count and what hangs under them', () => {
    const t = U.sftkUndoKeptOnlyText([
      { objType: 'Account', keptIds: ['k1', 'k2'], cascadeNotes: ['3 Contact', '1 Case'] },
      { objType: 'Lead', keptIds: [] },
      { objType: 'Order', refused: 'no access', keptIds: ['x'] }]);
    expect(t).toContain('2 record(s) the run created are still in the org');
    expect(t).toContain('2 Account (under them: 3 Contact, 1 Case)');
    expect(t).toContain('Remove those records in the org and open the rollback again');
    expect(t).not.toContain('Order');
  });
  it('no kept record → empty', () => {
    expect(U.sftkUndoKeptOnlyText([{ objType: 'Account', keptIds: [] }, { objType: 'Lead' }])).toBe('');
  });
});

// The real sftkUndoExecute + _sftkUndoVerdictHtml in one scope with the real
// pure helpers of sftk-undo.js; the org (sendBg) and the page are stubbed.
function undoHarness() {
  const pure = ['sftkUndoPickCoverage', 'sftkUndoLeftText', 'sftkUndoKeptOnlyText', 'sftkUndoRowLabel', 'sftkUndoRunStatus',
    'sftkUndoResultSummary', 'sftkUndoVerifyLine', 'sftkUndoVerifyCounts', 'sftkUndoReadQuote', 'sftkUndoSnapshotSoql',
    'sftkUndoDiff', 'sftkUndoRestorePayload', 'sftkUndoCapture'].map(n => sliceFrom(UNDO_PURE, n)).join('\n');
  return new Function('env', `
    const { sendBg, showToast, _history, window } = env;
    const genId = p => p + '_test';
    const orgLabel = u => String(u).replace('https://', '');
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const _sftkUndoPersist = async list => { env.persisted.push(list); };
    const recordActivity = () => {};
    let _sftkUndoBusy = null; let _sftkUndoSeq = 0;
    ${pure}
    ${sliceFrom(UNDO_UI, '_sftkUndoVerdictHtml')}
    ${sliceFrom(UNDO_UI, 'sftkUndoExecute')}
    return { sftkUndoExecute, _sftkUndoVerdictHtml, sftkUndoCapture };
  `);
}

// An org of one object: `rows` is what the target holds; deletes and updates
// change it, the verification read returns it.
function undoScene({ created, changedIds, keptIds = [], cascadeUnknown = [], cascadeNotes = [] }) {
  const beforeRows = [{ Id: 'c1', Name: 'Old 1' }, { Id: 'c2', Name: 'Old 2' }, { Id: 'u1', Name: 'Same' }];
  const rows = new Map(beforeRows.map(r => [r.Id, { ...r }]));
  for (const id of changedIds) rows.get(id).Name = 'Overwritten';
  for (const id of [...created, ...keptIds]) rows.set(id, { Id: id, Name: 'Made by the run ' + id });
  const sent = [];
  const env = { _history: [], persisted: [], window: {}, showToast: () => {},
    sendBg: async msg => {
      sent.push(msg);
      if (msg.type === 'SF_COLLECTIONS_DELETE') return msg.ids.map(id => { rows.delete(id); return { id, success: true }; });
      if (msg.type === 'SF_COLLECTIONS_UPDATE') return msg.records.map(r => { Object.assign(rows.get(r.Id), { Name: r.Name }); return { id: r.Id, success: true }; });
      if (msg.type === 'SF_QUERY_ALL') return { records: [...rows.values()].map(r => ({ ...r })) };
      return { error: 'unexpected ' + msg.type };
    } };
  const h = undoHarness()(env);
  const leg = { orgUrl: 'https://tgt.example', sid: 'x' };
  const before = h.sftkUndoCapture(beforeRows);
  const item = { key: 'Account', objType: 'Account', leg, fields: ['Name'], before, nowCount: rows.size,
    nowById: new Map([...rows].map(([k, v]) => [k, { ...v }])),
    scoped: { created: created.slice(), changed: changedIds.map(id => ({ id, before: before.byId[id], fields: ['Name'] })) },
    keptIds, cascadeUnknown, cascadeNotes };
  const sibling = { id: 'run1', undo: { status: 'ready', objects: ['Account'] } };
  const ctx = { run: { id: 'run1', profileName: 'Accounts', summary: {} }, ev: {}, legs: [leg], plan: [item], siblings: [sibling] };
  const lines = [];
  const io = { log: (i, m) => lines.push(m) };
  return { h, env, ctx, item, sibling, rows, sent, lines, io };
}

describe('sftkUndoExecute — what the run is recorded as (run for real)', () => {
  it('everything ticked, nothing kept: success, the card closes, the org is back', async () => {
    const s = undoScene({ created: ['a1', 'a2'], changedIds: ['c1'] });
    const r = await s.h.sftkUndoExecute(s.ctx, null, s.io);
    expect(r.status).toBe('success');
    expect(r.coverage).toMatchObject({ planned: 3, acted: 3, left: 0, complete: true });
    expect(s.sibling.undo.rolledBackAt).toBeTruthy();
    expect(s.sibling.undo.rolledBackStatus).toBe('success');
    expect(s.sibling.undo.lastRollbackStatus).toBeUndefined();
    expect([...s.rows.keys()].sort()).toEqual(['c1', 'c2', 'u1']);
    expect(s.rows.get('c1').Name).toBe('Old 1');
    expect(s.env._history).toHaveLength(1);
    expect(s.env._history[0]).toMatchObject({ kind: 'rollback', status: 'success', rolledBackRunId: 'run1' });
    expect(s.env.persisted).toHaveLength(1);
    expect(U.sftkUndoCardState(s.sibling).disabled).toBe(true);
  });

  it('a verified SUBSET stays partial: rolledBackAt unset, the note says how many were left', async () => {
    const s = undoScene({ created: ['a1', 'a2'], changedIds: ['c1'] });
    const picks = { Account: { del: new Set(['a1']), res: new Set(), force: new Set() } };
    const r = await s.h.sftkUndoExecute(s.ctx, picks, s.io);
    expect(r.status).toBe('partial');
    expect(s.sibling.undo.rolledBackAt).toBeUndefined();
    expect(s.sibling.undo.lastRollbackStatus).toMatch(/^partial — 2 of 3 record\(s\) left in place$/);
    expect(s.sibling.undo.lastRollbackAt).toBeTruthy();
    expect(s.env._history[0].status).toBe('partial');
    // only the ticked record was written
    expect(s.sent.filter(m => m.type === 'SF_COLLECTIONS_DELETE').map(m => m.ids)).toEqual([['a1']]);
    expect(s.sent.some(m => m.type === 'SF_COLLECTIONS_UPDATE')).toBe(false);
    expect(s.rows.has('a2')).toBe(true);
    expect(s.rows.get('c1').Name).toBe('Overwritten');
    const last = s.lines[s.lines.length - 1];
    expect(last).toContain('2 not picked — ↩ Roll back stays available in History for them');
    const st = U.sftkUndoCardState(s.sibling);
    expect(st.disabled).toBe(false);
    expect(st.label).toBe('↩ Roll back again (last attempt: partial)');
  });

  it('everything ticked but parents KEPT for later-added children: partial, and no promise of a retry that does not exist', async () => {
    const s = undoScene({ created: ['a1'], changedIds: ['c1'], keptIds: ['k1', 'k2'], cascadeNotes: ['3 Contact'] });
    const r = await s.h.sftkUndoExecute(s.ctx, null, s.io);
    expect(r.status).toBe('partial');
    expect(r.coverage).toMatchObject({ planned: 4, acted: 2, left: 2, kept: 2, keptForChildren: 2, complete: false });
    expect(s.sibling.undo.rolledBackAt).toBeUndefined();
    expect(s.sibling.undo.lastRollbackStatus).toBe('partial — 2 of 4 record(s) left in place (2 kept, 2 of them until the records added under them are removed)');
    // the kept parents were never sent for deletion and are still in the org
    expect(s.sent.filter(m => m.type === 'SF_COLLECTIONS_DELETE').flatMap(m => m.ids)).toEqual(['a1']);
    expect(s.rows.has('k1') && s.rows.has('k2')).toBe(true);
    const last = s.lines[s.lines.length - 1];
    expect(last).toContain('2 kept because records were added under them after the run');
    expect(last).not.toMatch(/stays available/);
    // the History card's hover carries the reason
    expect(U.sftkUndoCardState(s.sibling).title).toContain('until the records added under them are removed');
  });

  it('forceable Kept parents ticked "delete anyway" complete the rollback', async () => {
    const s = undoScene({ created: ['a1'], changedIds: [], keptIds: ['k1'], cascadeUnknown: ['Case: no access'] });
    const picks = { Account: { del: new Set(['a1']), res: new Set(), force: new Set(['k1']) } };
    const r = await s.h.sftkUndoExecute(s.ctx, picks, s.io);
    expect(r.status).toBe('success');
    expect(s.sibling.undo.rolledBackAt).toBeTruthy();
    expect(s.rows.has('k1')).toBe(false);
  });

  it('a refused delete is failed, never success, and the card stays open', async () => {
    const s = undoScene({ created: ['a1'], changedIds: [] });
    const real = s.env.sendBg;
    s.env.sendBg = async msg => msg.type === 'SF_COLLECTIONS_DELETE'
      ? msg.ids.map(id => ({ id, success: false, errors: [{ message: 'associated with cases' }] })) : real(msg);
    const h = undoHarness()(s.env);
    const r = await h.sftkUndoExecute(s.ctx, null, s.io);
    expect(r.status).toBe('failed');
    expect(s.sibling.undo.rolledBackAt).toBeUndefined();
    expect(s.sibling.undo.lastRollbackStatus).toBe('failed');
    expect(r.errors.join(' ')).toContain('associated with cases');
  });
});

describe('_sftkUndoVerdictHtml — the next plan page after a kept-only rollback', () => {
  const h = undoHarness()({ _history: [], persisted: [], window: {}, showToast: () => {}, sendBg: async () => ({}) });
  const base = { objType: 'Account', scoped: { created: [], changed: [] } };
  it('names the kept parents instead of "Nothing to roll back … matches the restore point"', () => {
    const html = h._sftkUndoVerdictHtml({ anyWork: false, forceable: false,
      plan: [{ ...base, keptIds: ['k1', 'k2'], cascadeNotes: ['3 Contact'], cascadeUnknown: [] }] });
    expect(html).toContain('Nothing can be rolled back right now');
    expect(html).toContain('2 Account (under them: 3 Contact)');
    expect(html).not.toContain('matches the restore point');
  });
  it('a plan that truly has nothing still says so', () => {
    const html = h._sftkUndoVerdictHtml({ anyWork: false, forceable: false, plan: [{ ...base, keptIds: [] }] });
    expect(html).toContain('Nothing to roll back');
    expect(html).toContain('matches the restore point');
  });
  it('work to do, or a forceable Kept, shows no verdict line', () => {
    expect(h._sftkUndoVerdictHtml({ anyWork: true, forceable: false, plan: [] })).toBe('');
    expect(h._sftkUndoVerdictHtml({ anyWork: false, forceable: true, plan: [] })).toBe('');
  });
});

// ═══ 3. Org Compare — blank keys ═══════════════════════════════════════════
const CMP = read('studio-compare.js');
function compareHarness(state) {
  return new Function('env', `
    const { eid, showToast, document, Blob, URL, setTimeout } = env;
    const sftkLocalDay = () => '2026-11-16';   // sftk-history.js: the file is named with the local day
    const _orgCompareState = env.state;
    const esc = s => String(s == null ? '' : s);
    const orgLabel = u => String(u || '').replace('https://', '');
    const sftkFriendlyError = e => ({ raw: e, message: e, hint: '' });
    const openProfileBuilder = () => {}; const _ocOpenReconcile = () => {}; const genId = p => p;
    ${sliceFrom(CMP, 'sftkOcMatchPct')}
    ${sliceFrom(CMP, 'sftkOcCountByKey')}
    ${sliceFrom(CMP, 'sftkOcRowStatus')}
    ${sliceFrom(CMP, '_ocRenderResults')}
    ${sliceFrom(CMP, '_ocExportCsv')}
    return { sftkOcCountByKey, sftkOcRowStatus, _ocRenderResults, _ocExportCsv };
  `)(state);
}
const recs = (keyed, blank, key = 'Ext__c', prefix = 'K') =>
  [...Array.from({ length: keyed }, (_, i) => ({ [key]: `${prefix}${i}` })), ...Array.from({ length: blank }, () => ({ [key]: null }))];

describe('sftkOcCountByKey / sftkOcRowStatus — blank keys are "cannot tell"', () => {
  const C = compareHarness({ state: {} });
  it('two identical orgs, 10 keyed + 990 blank each: nothing missing, nothing extra, not drifted, not clean', () => {
    const r = C.sftkOcCountByKey(recs(10, 990), recs(10, 990), 'Ext__c');
    expect(r).toMatchObject({ srcCount: 1000, tgtCount: 1000, matched: 10, missing: 0, extras: 0,
      srcBlank: 990, tgtBlank: 990, unmatchable: 1980, matchPct: 100 });
    expect(r.note).toContain('1980 records have a blank Ext__c and cannot be matched');
    expect(r.note).toContain('not counted as missing or only in target');
    expect(C.sftkOcRowStatus(r)).toBe('unverified');
  });
  it('a real keyed difference next to blanks is drifted, with the blanks kept out of the numbers', () => {
    const r = C.sftkOcCountByKey([...recs(3, 2), { Ext__c: 'ONLY-S' }], [...recs(3, 1), { Ext__c: 'ONLY-T' }, { Ext__c: 'ONLY-T2' }], 'Ext__c');
    expect(r).toMatchObject({ matched: 3, missing: 1, extras: 2, srcBlank: 2, tgtBlank: 1, matchPct: 75 });
    expect(C.sftkOcRowStatus(r)).toBe('drifted');
  });
  it('no record on either side has a key: no percentage at all', () => {
    const r = C.sftkOcCountByKey(recs(0, 5), recs(0, 7), 'Ext__c');
    expect(r).toMatchObject({ matched: 0, missing: 0, extras: 0, matchPct: null, unmatchable: 12 });
    expect(C.sftkOcRowStatus(r)).toBe('unverified');
  });
  it('no blanks, no difference: clean; the other row kinds keep their names', () => {
    expect(C.sftkOcRowStatus(C.sftkOcCountByKey(recs(4, 0), recs(4, 0), 'Ext__c'))).toBe('clean');
    expect(C.sftkOcRowStatus({ error: 'x', srcBlank: 3 })).toBe('error');
    expect(C.sftkOcRowStatus({ skipped: true })).toBe('skipped');
    expect(C.sftkOcRowStatus({ status: 'pending' })).toBe('pending');
  });
});

describe('Org Compare page and CSV — a blank-key row is shown as "cannot tell"', () => {
  const scene = () => {
    const C0 = compareHarness({ state: {} });
    const results = [
      { name: 'Account', ...C0.sftkOcCountByKey(recs(10, 990), recs(10, 990), 'Ext__c') },
      { name: 'Contact', ...C0.sftkOcCountByKey(recs(4, 0), recs(4, 0), 'Ext__c') },
      { name: 'Lead', ...C0.sftkOcCountByKey(recs(4, 0), recs(2, 0), 'Ext__c') },
    ];
    const el = { innerHTML: '', querySelectorAll: () => [] };
    const blobs = [];
    const env = { state: { results, running: false, srcOrgUrl: 'https://src.example', tgtOrgUrl: 'https://tgt.example' },
      eid: id => (id === 'dsOCResults' ? el : null), showToast: () => {},
      Blob: class { constructor(parts) { blobs.push(parts.join('')); } },
      URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }, setTimeout: () => 0,
      document: { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } } };
    return { C: compareHarness(env), el, blobs };
  };

  it('the banner counts 1 clean, 1 drifted, 1 cannot tell — and the row is not green', () => {
    const { C, el } = scene();
    C._ocRenderResults();
    expect(el.innerHTML).toContain('✓ 1 clean');
    expect(el.innerHTML).toContain('△ 1 drifted');
    expect(el.innerHTML).toContain('? 1 cannot tell');
    const accountRow = el.innerHTML.split('<tr').find(t => t.includes('>Account '));
    expect(accountRow).toContain('ds-oc-yellow');
    expect(accountRow).not.toContain('ds-oc-green');
    expect(accountRow).toContain('cannot tell');
    expect(accountRow).toContain('990 source and 990 target record(s) have a blank Ext__c and were not compared');
    // Missing / Only in target read 0 for it
    expect(accountRow).toMatch(/<td>10<\/td>\s*<td>0<\/td>\s*<td>0<\/td>/);
  });

  it('the CSV says "cannot tell", 0 missing, 0 only-in-target, and carries the blank counts in their own columns', () => {
    const { C, blobs } = scene();
    C._ocExportCsv();
    const [head, ...rows] = blobs[0].split('\r\n');
    const cols = head.split(',');
    expect(cols).toEqual(['object', 'status', 'matchField', 'sourceCount', 'targetCount', 'matched',
      'missingInTarget', 'onlyInTarget', 'blankKeySource', 'blankKeyTarget', 'matchPct', 'detail']);
    const row = name => { const r = rows.find(x => x.startsWith(name + ',')).split(','); return Object.fromEntries(cols.map((c, i) => [c, r[i]])); };
    expect(row('Account')).toMatchObject({ status: 'cannot tell', matched: '10', missingInTarget: '0', onlyInTarget: '0', blankKeySource: '990', blankKeyTarget: '990', matchPct: '100' });
    expect(row('Contact')).toMatchObject({ status: 'clean', blankKeySource: '0', blankKeyTarget: '0' });
    expect(row('Lead')).toMatchObject({ status: 'drifted', missingInTarget: '2' });
  });
});

describe('sftkFeedCounts — the Activity line of a compare names what could not be told', () => {
  const { sftkFeedCounts } = extractFunctions('sftk-feed.js', ['sftkFeedCounts']);
  it('adds the cannot-tell count only when there is one', () => {
    expect(sftkFeedCounts({ kind: 'compare', compare: { objects: 3, drifted: 1, errors: 0, unverified: 1 } }))
      .toBe('3 objects compared · 1 drifted · 1 cannot tell (blank match field) — read-only');
    expect(sftkFeedCounts({ kind: 'compare', compare: { objects: 3, drifted: 1, errors: 0 } }))
      .toBe('3 objects compared · 1 drifted — read-only');
  });
});

// ═══ 4. reconcileOverwrite and the delete composition, run for real ════════
const REC = read('studio-reconcile.js');
const WRITE = read('sftk-write.js');
function reconcileHarness(env) {
  return new Function('env', `
    const { sendBg, window } = env;
    ${sliceFrom(read('studio-core.js'), 'soqlStrLit')}
    ${sliceFrom(read('studio-history.js'), 'sftkFieldChanges')}
    ${sliceFrom(WRITE, '_sftkWriteVerifiedCore')}
    ${sliceFrom(WRITE, 'sftkWriteVerified')}
    ${sliceFrom(REC, 'sftkReconcileVerifyGone')}
    ${sliceFrom(REC, 'sftkReconcileChunkedWrite')}
    ${sliceLine(REC, 'const sftkMergeArr =')}
    ${sliceFrom(REC, 'reconcileOverwrite')}
    return { reconcileOverwrite, sftkReconcileChunkedWrite, sftkWriteVerified, sftkReconcileVerifyGone, sftkMergeArr };
  `)(env);
}

describe('reconcileOverwrite — 450 records, the second batch of 200 refused (run for real)', () => {
  const SRC = { orgUrl: 'https://src.example', sid: 's' };
  const TGT = { orgUrl: 'https://tgt.example', sid: 't' };
  const N = 450;
  const sid = i => `S${String(i).padStart(4, '0')}`;
  const tid = i => `T${String(i).padStart(4, '0')}`;
  const DESC = { fields: [
    { name: 'Id', type: 'id', updateable: false },
    { name: 'Name', type: 'string', nameField: true, updateable: true },
    { name: 'Phone', type: 'phone', updateable: true }] };

  const scene = (opts = {}) => {
    const target = new Map(Array.from({ length: N }, (_, i) => [tid(i), { Id: tid(i), Phone: 'old' }]));
    const updates = [];
    const idsIn = q => [...q.matchAll(/'([ST]\d{4})'/g)].map(m => m[1]);
    const env = { window: {}, sendBg: async msg => {
      if (msg.type === 'SF_REST_GET') return DESC;
      if (msg.type === 'SF_QUERY_ALL' && msg.orgUrl === SRC.orgUrl) {
        return { records: idsIn(msg.query).map(id => ({ Id: id, Name: `Acme ${id}`, Phone: `p-${id}` })) };
      }
      if (msg.type === 'SF_QUERY_ALL') return { records: idsIn(msg.query).map(id => ({ ...target.get(id) })) };
      if (msg.type === 'SF_COLLECTIONS_UPDATE') {
        updates.push(msg.records.length);
        if (updates.length === 2) return { error: 'HTTP 503: Service Unavailable' };
        return msg.records.map(r => {
          if (opts.refuseRecord && r.Id === opts.refuseRecord) return { id: r.Id, success: false, errors: [{ message: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: no' }] };
          Object.assign(target.get(r.Id), { Phone: r.Phone });
          return { id: r.Id, success: true };
        });
      }
      return { error: 'unexpected ' + msg.type };
    } };
    const profile = { targetOrg: TGT.orgUrl, tree: { objectType: 'Account', fieldMappings: { Phone: 'Phone' } } };
    const sourceIds = Array.from({ length: N }, (_, i) => sid(i));
    const drift = sourceIds.map((s, i) => ({ sourceId: s, targetId: tid(i) }));
    return { env, target, updates, run: () => reconcileHarness(env).reconcileOverwrite(profile, 'Account', sourceIds, drift, SRC, TGT, null) };
  };

  it('ok = 200, failed = 250; the third batch is never sent; the refusal is in the errors', async () => {
    const s = scene();
    const r = await s.run();
    expect(s.updates).toEqual([200, 200]);
    expect(r.ok).toBe(200);
    expect(r.failed).toBe(250);
    expect(r.updatedRecords).toHaveLength(200);
    expect(r.updatedRecords[0]).toMatchObject({ id: tid(0), label: `Acme ${sid(0)}` });
    expect(r.updatedRecords[0].changes).toEqual({ Phone: { before: 'old', after: `p-${sid(0)}` } });
    const text = r.errors.join('\n');
    expect(text).toContain('HTTP 503: Service Unavailable');
    expect(text).toContain('250 of 450 record(s) not done');
    expect(text).toContain('the 200 before it were written');
    // the org: exactly the first batch was written
    expect([...s.target.values()].filter(x => x.Phone !== 'old')).toHaveLength(200);
    expect(s.target.get(tid(199)).Phone).toBe(`p-${sid(199)}`);
    expect(s.target.get(tid(200)).Phone).toBe('old');
  });

  it('failedRecords name the records of the refused batch, aligned with their own target ids and labels', async () => {
    const r = await scene().run();
    expect(r.failedRecords).toHaveLength(200);   // History keeps the first 200 by name
    expect(r.failedRecords[0]).toMatchObject({ id: tid(200), label: `Acme ${sid(200)}` });
    expect(r.failedRecords[199]).toMatchObject({ id: tid(399), label: `Acme ${sid(399)}` });
    expect(r.failedRecords.every(f => /not confirmed — its batch of 200 was refused/.test(f.error))).toBe(true);
    expect(r.failedRecords.some(f => Number(f.id.slice(1)) < 200)).toBe(false);
  });

  it('a record refused inside the accepted batch keeps its own error and position', async () => {
    const s = scene({ refuseRecord: tid(5) });
    const r = await s.run();
    expect(r.ok).toBe(199);
    expect(r.failed).toBe(251);
    expect(r.failedRecords[0]).toMatchObject({ id: tid(5), label: `Acme ${sid(5)}`, error: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: no' });
    expect(r.failedRecords[1].id).toBe(tid(200));
    expect(r.updatedRecords.some(u => u.id === tid(5))).toBe(false);
    expect(r.errors.join('\n')).toContain('Account: FIELD_CUSTOM_VALIDATION_EXCEPTION: no');
  });

  it('the very first batch refused: nothing counted as updated, all 450 failed', async () => {
    const s = scene();
    const real = s.env.sendBg;
    s.env.sendBg = async msg => msg.type === 'SF_COLLECTIONS_UPDATE' ? { error: 'INVALID_SESSION_ID' } : real(msg);
    const r = await s.run();
    expect(r.ok).toBe(0);
    expect(r.failed).toBe(450);
    expect(r.errors.join('\n')).toContain('Account: INVALID_SESSION_ID');
    expect(r.failedRecords).toHaveLength(200);
    expect(r.failedRecords[0].id).toBe(tid(0));
  });
});

// runReconcile's delete branches are inline in a ~1,450-line function bound to
// the page (confirm dialogs, progress DOM, profile state) and cannot be called
// on their own. What CAN be run for real is everything they call: the chunked
// write, the verified write and the "is it gone" re-read, composed exactly as
// the soft-delete branch composes them, against an org stub.
describe('the delete composition runReconcile uses — batch 2 refused', () => {
  it('200 deleted and verified gone, 250 not done; the org still holds exactly those 250', async () => {
    const org = new Set(Array.from({ length: 450 }, (_, i) => `D${String(i).padStart(4, '0')}`));
    let calls = 0;
    const sess = { orgUrl: 'https://tgt.example', sid: 't' };
    const sendBg = async msg => {
      if (msg.type === 'SF_COLLECTIONS_DELETE') {
        calls++;
        if (calls === 2) return { error: 'HTTP 502: Bad Gateway' };
        return msg.ids.map(id => { org.delete(id); return { id, success: true }; });
      }
      if (msg.type === 'SF_QUERY_ALL') return { records: [...String(msg.query).matchAll(/'(Dd{4})'/g)].map(m => m[1]).filter(id => org.has(id)).map(Id => ({ Id })) };
      return { error: 'unexpected' };
    };
    const H = reconcileHarness({ window: {}, sendBg });
    const ids = [...org];
    const dw = await H.sftkReconcileChunkedWrite(ids, (part) => H.sftkWriteVerified({
      describe: 'Contact delete',
      write: () => sendBg({ type: 'SF_COLLECTIONS_DELETE', orgUrl: sess.orgUrl, sid: sess.sid, ids: part }),
      verify: (r) => H.sftkReconcileVerifyGone(sess, 'Contact', (Array.isArray(r) ? r : []).filter(x => x.success).map(x => x.id)),
    }), H.sftkMergeArr, 'Contact record(s)');
    expect(calls).toBe(2);
    expect(dw).toMatchObject({ accepted: true, ok: false, verified: true, notDone: 250 });
    expect(dw.raw).toHaveLength(200);
    expect(dw.raw.every(x => x.success)).toBe(true);
    expect(dw.text).toContain('250 of 450 Contact record(s) not done');
    expect(dw.text).toContain('HTTP 502: Bad Gateway');
    expect(org.size).toBe(250);
    expect(org.has('D0199')).toBe(false);
    expect(org.has('D0200')).toBe(true);
  });

  it('a delete Salesforce accepted but that still shows in the org is not ok', async () => {
    const sess = { orgUrl: 'https://tgt.example', sid: 't' };
    const sendBg = async msg => msg.type === 'SF_COLLECTIONS_DELETE'
      ? msg.ids.map(id => ({ id, success: true }))
      : { records: [{ Id: 'D0001' }] };
    const H = reconcileHarness({ window: {}, sendBg });
    const dw = await H.sftkReconcileChunkedWrite(['D0000', 'D0001'], (part) => H.sftkWriteVerified({
      describe: 'Contact delete',
      write: () => sendBg({ type: 'SF_COLLECTIONS_DELETE', ids: part }),
      verify: (r) => H.sftkReconcileVerifyGone(sess, 'Contact', r.filter(x => x.success).map(x => x.id)),
    }), H.sftkMergeArr, 'Contact record(s)');
    expect(dw).toMatchObject({ accepted: true, ok: false, notDone: 0 });
    expect(dw.detail).toEqual(['D0001']);
    expect(dw.text).toContain('1 record(s) still show in the org');
  });
});
