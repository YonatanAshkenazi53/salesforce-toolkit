// Campaign 3 phase 4 — the whole tree in one pass (studio-reconcile.js).
//
// sftkRecOnePassPlan decides, for every ticked record, which ancestors must
// come along and which engine call it rides; sftkRecPruneTree builds that
// call's tree with only the records that ride it, at any depth.
import { describe, it, expect } from 'vitest';
import { extractFunction, extractFunctions } from './extract.mjs';

const { sftkRecOnePassPlan, sftkRecPruneTree } = extractFunctions('studio-reconcile.js', ['sftkRecOnePassPlan', 'sftkRecPruneTree']);
const rowState = extractFunction('studio-reconcile.js', 'sftkRecChildRowState');

// Account (root) → '0' Opportunity → '0.0' OpportunityLineItem ; '1' Contact
// Target has account A2 and opportunity O3 (under A2); everything else is missing.
const rootMissing = new Set(['A1']);
const nodes = {
  '0':   { missing: new Map([['O1', 'A1'], ['O2', 'A2']]), parentMissing: new Set(['A1']), parentExists: new Set(['A2']) },
  '0.0': { missing: new Map([['L1', 'O1'], ['L2', 'O2'], ['L3', 'O3'], ['L9', 'OX']]), parentMissing: new Set(['O1', 'O2']), parentExists: new Set(['O3']) },
  '1':   { missing: new Map([['C1', 'A1']]), parentMissing: new Set(['A1']), parentExists: new Set(['A2']) },
};

describe('sftkRecOnePassPlan', () => {
  it('a grandchild ticked alone pulls its parent and grandparent into ONE root call', () => {
    const p = sftkRecOnePassPlan({ rootSel: [], rootMissing, nodes, sel: { '0.0': new Set(['L1']) } });
    expect([...p.ins['']]).toEqual(['A1']);
    expect([...p.ins['0']]).toEqual(['O1']);
    expect(p.auto).toMatchObject({ '': 1, '0': 1, '0.0': 0 });
    expect(p.root).toEqual({ recordIds: ['A1'], rides: { '0': ['O1'], '0.0': ['L1'] } });
    expect(p.b).toEqual({});
  });
  it('under an EXISTING grandparent the call is rooted at the child level, and the grandchild rides it', () => {
    const p = sftkRecOnePassPlan({ rootSel: [], rootMissing, nodes, sel: { '0.0': new Set(['L2']) } });
    expect(p.root.recordIds).toEqual([]);
    expect(p.b).toEqual({ '0': { recordIds: ['O2'], rides: { '0.0': ['L2'] } } });
    expect(p.auto['0']).toBe(1);
  });
  it('a grandchild whose parent already exists is rooted at its own level (no ancestor inserted)', () => {
    const p = sftkRecOnePassPlan({ rootSel: [], rootMissing, nodes, sel: { '0.0': new Set(['L3']) } });
    expect(p.b).toEqual({ '0.0': { recordIds: ['L3'], rides: {} } });
    expect(p.auto).toMatchObject({ '': 0, '0': 0 });
  });
  it('a record whose parent is neither in the target nor insertable is dropped, never sent without it', () => {
    const p = sftkRecOnePassPlan({ rootSel: [], rootMissing, nodes, sel: { '0.0': new Set(['L9']) } });
    expect(p.dropped['0.0']).toBe(1);
    expect(p.root.rides).toEqual({});
    expect(p.b).toEqual({});
  });
  it('mixed picks: ticked parents are not counted as auto, siblings share calls, other branches ride the same root call', () => {
    const p = sftkRecOnePassPlan({ rootSel: ['A1'], rootMissing, nodes,
      sel: { '0': new Set(['O1']), '0.0': new Set(['L1', 'L2', 'L3']), '1': new Set(['C1']) } });
    expect(p.auto).toMatchObject({ '': 0, '0': 1 });   // O2 came along for L2; A1 and O1 were ticked
    expect(p.root).toEqual({ recordIds: ['A1'], rides: { '0': ['O1'], '0.0': ['L1'], '1': ['C1'] } });
    expect(p.b).toEqual({ '0': { recordIds: ['O2'], rides: { '0.0': ['L2'] } }, '0.0': { recordIds: ['L3'], rides: {} } });
  });
  it('a ticked id that is not missing in the target (already there / not in the scan) is ignored', () => {
    const p = sftkRecOnePassPlan({ rootSel: [], rootMissing, nodes, sel: { '0': new Set(['NOPE']) } });
    expect(p.ins['0'].size).toBe(0);
  });
});

describe('sftkRecPruneTree', () => {
  const tree = [
    { objectType: 'Opportunity', field: 'AccountId', insertOrder: 'childFirst', children: [
      { objectType: 'OpportunityLineItem', field: 'OpportunityId', children: [] },
      { objectType: 'OpportunityContactRole', field: 'OpportunityId', children: [] }] },
    { objectType: 'Contact', field: 'AccountId', children: [] },
  ];
  it('keeps only the nodes that ride this call, with exactly their records, at every depth', () => {
    const out = sftkRecPruneTree(tree, '', { '0': ['O1'], '0.0': ['L1'] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ objectType: 'Opportunity', recordIds: ['O1'] });
    expect(out[0].children).toEqual([{ objectType: 'OpportunityLineItem', field: 'OpportunityId', children: [], recordIds: ['L1'] }]);
  });
  it('rooted below the root: paths continue from the base path; decorate sees each copy and path', () => {
    const seen = [];
    const out = sftkRecPruneTree(tree[0].children, '0', { '0.1': ['R1'] }, (cc, p) => seen.push([cc.objectType, p]));
    expect(out.map(n => n.objectType)).toEqual(['OpportunityContactRole']);
    expect(seen).toEqual([['OpportunityContactRole', '0.1']]);
    expect(tree[0].children[1].recordIds).toBeUndefined();   // the profile itself is never mutated
  });
});

describe('sftkRecChildRowState — a missing parent no longer blocks a grandchild', () => {
  it('missing at depth 1 and 2 alike; untracked stays unselectable', () => {
    const miss = new Set(['P']), ex = new Set(['E']);
    expect(rowState({ parentSrcId: 'P' }, 1, miss, ex)).toBe('missing');
    expect(rowState({ parentSrcId: 'P' }, 2, miss, ex)).toBe('missing');
    expect(rowState({ parentSrcId: 'E' }, 2, miss, ex)).toBe('exists');
    expect(rowState({ parentSrcId: 'Z' }, 2, miss, ex)).toBe('untracked');
  });
});
