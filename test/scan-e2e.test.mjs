// runDiffScan END-TO-END — user bug 2026-08-09: "record A existing both in
// ashkenazy 6 and ashkenazy 7 with different data. the extension didn't
// catch it." The Reconcile screenshot shows A in NO bucket at all (Insert
// lists only B, Changed 0, in-sync 0) — a matched pair vanished. This
// harness drives the REAL runDiffScan against the user's exact shape.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractFunctions } from './extract.mjs';

const scan = extractFunctions('studio-scan.js', [
  'runDiffScan', 'deriveScanConfig', 'buildLookupCompareMap',
  '_lookupSelectExpr', '_lookupResolvedVal', 'sftkPhantomStateCountry',
  'sftkEngineCompareSet', 'sftkParentScopeCap', 'sftkParentScopeNote',
  'sftkOrphanLabel', 'sftkOrphanCapNote', 'sftkBucketCap', 'sftkBucketCapNote',
], { 'sftk-matching.js': [
  'sftkMatchingFromNode', 'sftkMatchingFields', 'sftkMatchingTgtFields',
  'sftkMatchKey', 'sftkNormalizeValue', 'sftkNearMissFold', 'sftkNearMissReason',
  'sftkMatchKeyLabel',
] });

const SRC_ORG = 'https://six.develop.my.salesforce.com';
const TGT_ORG = 'https://seven.develop.my.salesforce.com';

const f = (name, type, extra) => Object.assign({
  name, label: name, type, createable: true, updateable: true, nillable: true,
  length: 255, referenceTo: [],
}, extra || {});

// The user's REAL object shape (verified in-org 2026-08-09): standard Name
// plus TWO custom lookups — Step_Order_Name__c is a LOOKUP to a third
// object, NOT text. The first version of this file modeled it as a string
// field; the harness passed while the real bug (lookup-only drift filed as
// "identical" because references never entered the expanded compare set)
// shipped right past it. Model the describe the way the org actually is.
const STEP_DESC = { name: 'Step_Order__c', fields: [
  f('Id', 'id', { createable: false }),
  f('Name', 'string', { nameField: true }),
  f('Step_Order_Name__c', 'reference', { referenceTo: ['Step_Order_Name__c'], relationshipName: 'Step_Order_Name__r' }),
  f('Procedure_Definition__c', 'reference', { referenceTo: ['Procedure_Definition__c'], relationshipName: 'Procedure_Definition__r' }),
] };

const SRC_ROWS = [
  { Id: 'S_A', Name: 'A', Step_Order_Name__c: 'SN_1', Step_Order_Name__r: { Name: 'SN-001' },
    Procedure_Definition__c: 'PD1', Procedure_Definition__r: { Name: 'PD-001' } },
  { Id: 'S_B', Name: 'B', Step_Order_Name__c: 'SN_1', Step_Order_Name__r: { Name: 'SN-001' },
    Procedure_Definition__c: 'PD1', Procedure_Definition__r: { Name: 'PD-001' } },
];
// Target has A too — same Name, but its LOOKUP points at a different
// related record (the user's exact repro: a00aj00003EQaW7 ↔ a05aj00000aytJR).
const TGT_ROWS = [
  { Id: 'T_A', Name: 'A', Step_Order_Name__c: 'SN_9', Step_Order_Name__r: { Name: 'SN-777' },
    Procedure_Definition__c: 'PD1x', Procedure_Definition__r: { Name: 'PD-001' } },
];

let queries;
beforeEach(() => {
  queries = [];
  globalThis._orgKey = u => String(u || '').toLowerCase();
  globalThis.orgLabel = u => u;
  globalThis._buildAllSessions = () => ([
    { orgUrl: SRC_ORG, sid: 'SID_SRC' },
    { orgUrl: TGT_ORG, sid: 'SID_TGT' },
  ]);
  globalThis._resolveSession = (url, all) => all.find(s => s.orgUrl === url) || null;
  globalThis.describe = async () => STEP_DESC;
  globalThis.window = {};   // SFToolkitDebug / sftkBucketCapNote lookups no-op
  globalThis.sendBg = async msg => {
    const q = String(msg.query || '');
    queries.push([msg.type, msg.orgUrl, q]);
    if (msg.type === 'SF_QUERY_ALL' || msg.type === 'SF_QUERY') {
      const rows = msg.orgUrl === SRC_ORG ? SRC_ROWS : TGT_ROWS;
      // NULL-link orphan probe → none
      if (/= null/.test(q)) return { records: [], totalSize: 0, done: true };
      return { records: rows.map(r => ({ ...r })), totalSize: rows.length, done: true };
    }
    return { error: 'unexpected ' + msg.type };
  };
});
afterEach(() => {
  for (const k of ['_orgKey', 'orgLabel', '_buildAllSessions', '_resolveSession',
    'describe', 'window', 'sendBg']) delete globalThis[k];
});

const PROFILE = () => ({
  id: 'p1', name: 'Step Orders', sourceOrg: SRC_ORG, targetOrg: TGT_ORG,
  scanConfig: { matchField: 'Name', compareFields: [] },
  tree: { objectType: 'Step_Order__c', where: '', children: [] },
});

describe('a record present in BOTH orgs can never vanish from every bucket', () => {
  it("the user's exact shape: B → missing, A → changed (never nowhere)", async () => {
    const p = PROFILE();
    const res = await scan.runDiffScan(p, p.tree, null);
    expect(res.error, res.error).toBeFalsy();

    const inBucket = id => ({
      missing: (res.missingInTarget || []).some(r => r.sourceId === id),
      changed: (res.changed || []).some(r => r.sourceId === id),
      identical: (res.identical || []).some(r => r.sourceId === id),
      extra: (res.onlyInTarget || []).some(r => r.targetId === id),
    });

    // B: source only.
    expect(inBucket('S_B').missing).toBe(true);

    // A: exists on both sides; the ONLY difference is which related record
    // the Step_Order_Name__c LOOKUP points at (SN-001 vs SN-777 by name).
    // Must land in changed — filing it as identical is the user's bug
    // ("both are not showing it under the changed tab in reconcile").
    const a = inBucket('S_A');
    const somewhere = a.missing || a.changed || a.identical;
    expect(somewhere,
      `A landed in NO bucket — missing:${a.missing} changed:${a.changed} identical:${a.identical}; ` +
      `buckets: missing=${JSON.stringify(res.missingInTarget)} changed=${JSON.stringify(res.changed)} ` +
      `identical=${JSON.stringify(res.identical)} blankKeys=${JSON.stringify(res.blankKeys)} ` +
      `dupKeys=${JSON.stringify(res.dupKeys)} error=${res.error}`).toBe(true);
    expect(a.changed,
      `lookup-only drift must be CHANGED, not identical — changed=${JSON.stringify(res.changed)} ` +
      `identical=${JSON.stringify(res.identical)}`).toBe(true);

    // The changed row names the lookup as the differing field.
    const row = (res.changed || []).find(r => r.sourceId === 'S_A');
    expect((row?.fields || []).join(','), 'differing field list names the lookup')
      .toContain('Step_Order_Name__c');
  });
});
