// W2-UI — per-record lookup overrides: the pure read/write helpers behind
// the Reconcile 🔗 panel. The ENGINE side (background.js reads
// node.lookupOverrides[orgKey][srcId][field] as Priority 0 in the payload
// builder) is covered by engine-childfirst.test.mjs; these prove the UI
// writes keys that reader accepts, never forks an org's bucket, and prunes
// cleanly on clear.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

const lkp = extractFunctions('studio-reconcile.js', [
  'sftkLkpOvBucket', 'sftkLkpOvGet', 'sftkLkpOvSet', 'sftkLkpOvClear',
  'sftkLkpRefFields', 'sftkLkpSoqlLike',
], { 'sftk-org-identity.js': ['sftkOrgKey'] });

const TGT = 'https://seven.develop.my.salesforce.com';

describe('sftkLkpOvSet / Get — org-identity keyed storage', () => {
  it('roundtrips a pick under the canonical org key', () => {
    const node = {};
    lkp.sftkLkpOvSet(node, TGT, 'S1', 'Procedure_Definition__c', 'a01T1');
    expect(lkp.sftkLkpOvGet(node, TGT, 'S1')).toEqual({ Procedure_Definition__c: 'a01T1' });
    // Engine-reader parity: the stored key resolves to the org identity.
    expect(lkp.sftkLkpOvBucket(node, TGT)).toBeTruthy();
  });

  it('reads across DOMAIN FORMS of the same org (my.salesforce ↔ lightning.force)', () => {
    const node = {};
    lkp.sftkLkpOvSet(node, 'https://seven.develop.my.salesforce.com', 'S1', 'F__c', 'X');
    expect(lkp.sftkLkpOvGet(node, 'https://seven.develop.lightning.force.com', 'S1'))
      .toEqual({ F__c: 'X' });
  });

  it('never forks a second bucket for one org — reuses the existing key', () => {
    const node = { lookupOverrides: { 'https://seven.develop.lightning.force.com': { S1: { F__c: 'X' } } } };
    lkp.sftkLkpOvSet(node, TGT, 'S2', 'G__c', 'Y');
    expect(Object.keys(node.lookupOverrides)).toHaveLength(1);
    expect(lkp.sftkLkpOvGet(node, TGT, 'S1')).toEqual({ F__c: 'X' });
    expect(lkp.sftkLkpOvGet(node, TGT, 'S2')).toEqual({ G__c: 'Y' });
  });

  it('keeps DIFFERENT orgs isolated — multi-target picks coexist', () => {
    const node = {};
    lkp.sftkLkpOvSet(node, 'https://seven.develop.my.salesforce.com', 'S1', 'F__c', 'SEVEN_ID');
    lkp.sftkLkpOvSet(node, 'https://eight.develop.my.salesforce.com', 'S1', 'F__c', 'EIGHT_ID');
    expect(lkp.sftkLkpOvGet(node, 'https://seven.develop.my.salesforce.com', 'S1')).toEqual({ F__c: 'SEVEN_ID' });
    expect(lkp.sftkLkpOvGet(node, 'https://eight.develop.my.salesforce.com', 'S1')).toEqual({ F__c: 'EIGHT_ID' });
  });

  it('a missing pick reads as an empty object, never null/undefined', () => {
    expect(lkp.sftkLkpOvGet({}, TGT, 'S1')).toEqual({});
    expect(lkp.sftkLkpOvGet({ lookupOverrides: 'garbage' }, TGT, 'S1')).toEqual({});
  });
});

describe('sftkLkpOvClear — pruning', () => {
  it('clearing the last pick removes lookupOverrides entirely', () => {
    const node = {};
    lkp.sftkLkpOvSet(node, TGT, 'S1', 'F__c', 'X');
    lkp.sftkLkpOvClear(node, TGT, 'S1', 'F__c');
    expect(node.lookupOverrides).toBeUndefined();
  });

  it('clearing one field keeps the record\'s other picks', () => {
    const node = {};
    lkp.sftkLkpOvSet(node, TGT, 'S1', 'F__c', 'X');
    lkp.sftkLkpOvSet(node, TGT, 'S1', 'G__c', 'Y');
    lkp.sftkLkpOvClear(node, TGT, 'S1', 'F__c');
    expect(lkp.sftkLkpOvGet(node, TGT, 'S1')).toEqual({ G__c: 'Y' });
  });

  it('clearing via a different domain form of the same org still lands', () => {
    const node = {};
    lkp.sftkLkpOvSet(node, 'https://seven.develop.my.salesforce.com', 'S1', 'F__c', 'X');
    lkp.sftkLkpOvClear(node, 'https://seven.develop.lightning.force.com', 'S1', 'F__c');
    expect(node.lookupOverrides).toBeUndefined();
  });

  it('never touches OTHER orgs\' buckets', () => {
    const node = {};
    lkp.sftkLkpOvSet(node, 'https://seven.develop.my.salesforce.com', 'S1', 'F__c', 'X');
    lkp.sftkLkpOvSet(node, 'https://eight.develop.my.salesforce.com', 'S1', 'F__c', 'Y');
    lkp.sftkLkpOvClear(node, 'https://seven.develop.my.salesforce.com', 'S1', 'F__c');
    expect(lkp.sftkLkpOvGet(node, 'https://eight.develop.my.salesforce.com', 'S1')).toEqual({ F__c: 'Y' });
  });
});

describe('sftkLkpRefFields — only lookups the engine will honor', () => {
  const f = (name, over) => Object.assign(
    { name, type: 'reference', createable: true, referenceTo: ['Account'] }, over || {});

  it('keeps custom + standard steerable lookups, drops engine-owned ones', () => {
    const fields = [
      f('Procedure_Definition__c', { referenceTo: ['Procedure_Definition__c'] }),
      f('AccountId'),
      f('OwnerId', { referenceTo: ['User'] }),           // owner matching owns it
      f('RecordTypeId', { referenceTo: ['RecordType'] }), // RT map owns it
      f('CreatedById', { referenceTo: ['User'], createable: false }),
      f('Name', { type: 'string', referenceTo: [] }),     // not a reference
      f('Ghost__c', { referenceTo: [] }),                 // ref with no target
      f('ReadOnly__c', { createable: false }),
    ];
    expect(lkp.sftkLkpRefFields(fields).map(x => x.name))
      .toEqual(['Procedure_Definition__c', 'AccountId']);
  });

  it('keeps polymorphic lookups (multiple referenceTo)', () => {
    const poly = f('What__c', { referenceTo: ['Account', 'Contact'] });
    expect(lkp.sftkLkpRefFields([poly])).toHaveLength(1);
  });

  it('tolerates null/empty describe input', () => {
    expect(lkp.sftkLkpRefFields(null)).toEqual([]);
    expect(lkp.sftkLkpRefFields([])).toEqual([]);
  });
});

describe('sftkLkpSoqlLike — LIKE-literal escaping', () => {
  it('escapes quote, backslash and both LIKE wildcards', () => {
    expect(lkp.sftkLkpSoqlLike("a'b%c_d\\e")).toBe("a\\'b\\%c\\_d\\\\e");
  });
  it('passes plain terms through and nullish to empty', () => {
    expect(lkp.sftkLkpSoqlLike('SO-0042')).toBe('SO-0042');
    expect(lkp.sftkLkpSoqlLike(null)).toBe('');
  });
});

// ══════════════════════════════════════════════════════════════════
// W7 finding #1 (2026-08-09): reconcileOverwrite predates W2 and only
// resolved lookups BY KEY (refPairs) — a hand-pick made on the very row
// being overwritten silently lost to name-matching. Source-anchored
// checks (same style as the PII fail-closed suite) that the fix is
// present AND ordered so picks win.
// ══════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const RECONCILE = readFileSync(join(root, 'studio-reconcile.js'), 'utf8');
const ovwStart = RECONCILE.indexOf('async function reconcileOverwrite(');
const ovwSrc = RECONCILE.slice(ovwStart, RECONCILE.indexOf('\n}', ovwStart));

describe('reconcileOverwrite honors 🔗 hand-picks (engine Priority-0 parity)', () => {
  it('reads the org bucket through the SAME helper the panel writes with', () => {
    expect(ovwSrc).toContain('sftkLkpOvBucket(node, profile.targetOrg)');
  });

  it('applies picks AFTER the by-key refPairs loop — a pick must win', () => {
    const refPairsWrite = ovwSrc.indexOf('p[rp.tf] = pid;');
    const pickWrite     = ovwSrc.indexOf('p[tf] = pickId;');
    expect(refPairsWrite).toBeGreaterThan(-1);
    expect(pickWrite).toBeGreaterThan(refPairsWrite);
  });

  it('gates picks on the target describe — never PATCH a missing/read-only field', () => {
    expect(ovwSrc).toContain("tgtUpdMap.get(tf) !== true) continue;");
  });

  it('excludes engine-owned refs from pick application', () => {
    expect(ovwSrc).toMatch(/\['OwnerId', 'RecordTypeId', 'CreatedById', 'LastModifiedById'\]\.includes\(f\.name\)/);
  });

  it('discloses the applied-pick count in the summary', () => {
    expect(ovwSrc).toContain('lookup value(s) written from hand-picked targets');
  });
});
