// 2026-09-22 — live run 11: OrderItem "Required fields are missing: [OrderId]".
// A child inserted under an EXISTING parent was attached by re-matching the
// parent's key with one exact value; Order's key is a composite, so nothing
// matched. The parent scan already paired every existing parent (srcId →
// tgtId): attach by that, exactly, and keep the key bridge as the fallback.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const { sftkRecParentOverrides: att } = extractFunctions('studio-reconcile.js', ['sftkRecParentOverrides'], { 'sftk-org-identity.js': ['sftkOrgKey'] });
const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const TGT = 'https://t4.my.salesforce.com';

describe('group-B children attach by the scan’s own parent pairing', () => {
  const rows = [{ sourceId: 'C1', parentSrcId: 'P1' }, { sourceId: 'C2', parentSrcId: 'P2' }, { sourceId: 'C3', parentSrcId: 'P9' }, { sourceId: 'C4', parentSrcId: null }];
  const pairs = new Map([['P1', 'T1'], ['P2', 'T2']]);
  it('writes one override per child under the target org, counts what it could not pair', () => {
    const r = att(['C1', 'C2', 'C3', 'C4'], rows, pairs, 'OrderId', {}, TGT);
    expect(r.overrides).toEqual({ [TGT]: { C1: { OrderId: 'T1' }, C2: { OrderId: 'T2' } } });
    expect(r.exact).toBe(2);
    expect(r.missing).toBe(1);        // C3's parent pair is unknown → the key bridge; C4 has no parent at all
  });
  it('a hand-pick already on the row wins, and an existing bucket for the same org (other URL form) is reused', () => {
    const existing = { 'https://T4.my.salesforce.com/': { C1: { OrderId: 'HAND', Other__c: 'x' } } };
    const r = att(['C1', 'C2'], rows, pairs, 'OrderId', existing, TGT);
    expect(r.overrides['https://T4.my.salesforce.com/'].C1).toEqual({ OrderId: 'HAND', Other__c: 'x' });
    expect(r.overrides['https://T4.my.salesforce.com/'].C2).toEqual({ OrderId: 'T2' });
    expect(Object.keys(r.overrides)).toEqual(['https://T4.my.salesforce.com/']);
    expect(existing['https://T4.my.salesforce.com/'].C2).toBeUndefined();   // never mutates the node's own picks
  });
  it('runReconcile uses it for every group-B push and only warns about the key bridge for rows it could not pair', () => {
    expect(RC).toContain("const _att = sftkRecParentOverrides(a.groupB, a.cs.missingInTarget || [], _pairs, a.node.field, a.node.lookupOverrides || {}, profile.targetOrg);");
    expect(RC).toContain('lookupOverrides: _att.overrides,');
    expect(RC).toContain('if (_att.missing && pScanM && ((pScanM.fields || []).length > 1');
  });
});
