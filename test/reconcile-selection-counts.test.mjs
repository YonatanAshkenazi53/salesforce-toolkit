// Two findings from the user's work session (2026-09-14): Reconcile opened
// with everything selected, and a run claimed more records than were picked.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const REC = read('studio-reconcile.js');
const TR  = read('studio-transfer.js');
const { sftkChildCountWhere, sftkCountBreakdown } = extractFunctions('studio-transfer.js', ['sftkChildCountWhere', 'sftkCountBreakdown']);

describe('Reconcile selects nothing by default', () => {
  it('no seeding of push / overwrite from the buckets — and no re-arming on re-render', () => {
    const fn = REC.slice(REC.indexOf('function renderReconcile('), REC.indexOf('async function runReconcile('));
    expect(fn).not.toMatch(/missing\.forEach\(r => r\.sourceId && _recSel\.push\.add/);
    expect(fn).not.toMatch(/drift\.forEach\(r => r\.sourceId && _recSel\.overwrite\.add/);
    expect(fn).toContain('NOTHING is selected until the user selects it');
    // a whole bucket is still one click away, on purpose
    expect(REC).toContain('data-rec-all="${kind}"');
  });
});

describe('counting a tree the way the engine reads it', () => {
  const root = { objectType: 'Account', recordIds: ['001A', '001B'] };
  it('the root counts its own picks / WHERE', () => {
    expect(sftkChildCountWhere(root, null)).toEqual({ where: "Id IN ('001A','001B')", semiJoin: false, unscoped: false });
    expect(sftkChildCountWhere({ objectType: 'Account', where: 'Industry = \'X\'' }, null).where).toBe("Industry = 'X'");
    expect(sftkChildCountWhere({ objectType: 'Account' }, null).where).toBeNull();
  });
  it('a child under filtered parents is counted INSIDE that scope (semi-join)', () => {
    const r = sftkChildCountWhere({ childSObject: 'Contact', field: 'AccountId' }, { obj: 'Account', where: "Id IN ('001A','001B')", semiJoin: false });
    expect(r.where).toBe("AccountId IN (SELECT Id FROM Account WHERE Id IN ('001A','001B'))");
    expect(r.unscoped).toBe(false);
    expect(r.semiJoin).toBe(true);
  });
  it('a child with its own picks keeps them AND the parent scope', () => {
    const r = sftkChildCountWhere({ childSObject: 'Contact', field: 'AccountId', recordIds: ['003X'] }, { obj: 'Account', where: "Id IN ('001A')", semiJoin: false });
    expect(r.where).toBe("(Id IN ('003X')) AND AccountId IN (SELECT Id FROM Account WHERE Id IN ('001A'))");
  });
  it('an unfiltered parent means the whole child table IS the scope', () => {
    const r = sftkChildCountWhere({ childSObject: 'Contact', field: 'AccountId' }, { obj: 'Account', where: null, semiJoin: false });
    expect(r).toEqual({ where: null, semiJoin: false, unscoped: false });
  });
  it('a grandchild under a filtered parent cannot be scoped — flagged as an upper bound, never silently whole-table', () => {
    const r = sftkChildCountWhere({ childSObject: 'Case', field: 'ContactId' }, { obj: 'Contact', where: 'AccountId IN (SELECT Id FROM Account WHERE Id IN (\'001A\'))', semiJoin: true });
    expect(r.unscoped).toBe(true);
    expect(r.where).toBeNull();
  });
  it('a child with no link field cannot be scoped either', () => {
    expect(sftkChildCountWhere({ childSObject: 'Contact' }, { obj: 'Account', where: "Id IN ('001A')", semiJoin: false }).unscoped).toBe(true);
  });
  it('the breakdown names every object and marks bounds', () => {
    const tree = { obj: 'Account', count: 2, children: [{ obj: 'Contact', count: 16, unscoped: false, children: [{ obj: 'Case', count: 40, unscoped: true, children: [] }] }] };
    expect(sftkCountBreakdown(tree)).toBe('2 Account · 16 Contact · ≤ 40 Case');
    expect(sftkCountBreakdown({ obj: 'Account', count: null, children: [] })).toBe('? Account');
  });
  it('previewTransfer threads the parent scope into every child count, and the confirm shows the breakdown', () => {
    expect(TR).toContain("countNode(c, { obj, where: cw.where, semiJoin: cw.semiJoin })");
    expect(TR).toContain('const counts = await countNode(runProfile.tree, null);');
    expect(TR).toContain('_trLastTotalIsBound = bound;');
    expect(TR).toContain('By object: ${esc(breakdown)}');
    expect(TR).toMatch(/\$\{countsNode\.unscoped \? '≤ ' : ''\}\$\{countsNode\.count\.toLocaleString\(\)\}/);
  });
});
