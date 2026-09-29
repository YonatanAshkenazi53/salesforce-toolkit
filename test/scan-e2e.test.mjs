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
  'sftkScanBucketInfo', 'sftkBucketCapShipped', 'sftkBucketCountLabel',
  'sftkMultiSelNorm',
], { 'sftk-matching.js': [
  'sftkMatchingFromNode', 'sftkMatchingFields', 'sftkMatchingTgtFields',
  'sftkMatchKey', 'sftkPathValue', 'sftkNormalizeValue', 'sftkNearMissFold', 'sftkNearMissReason',
  'sftkMatchKeyLabel', 'sftkScanKeyClasses',
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

    // HEADER COUNTS (user screenshot 2026-08-09: "Insert 0" over 401 rows,
    // "Changed 0" over a visible row) — run the exact label pipeline the
    // Reconcile headers use against this scan result.
    const lbl = k => {
      const i = scan.sftkScanBucketInfo(res, k);
      return scan.sftkBucketCountLabel(i.shown, i.total, i.capped, i.totalIsFloor);
    };
    expect(lbl('missingInTarget'), 'Insert header count').toBe('1');
    expect(lbl('changed'),         'Changed header count').toBe('1');
    expect(lbl('identical'),       'in-sync count').toBe('0');
    expect(lbl('onlyInTarget'),    'target-only count').toBe('0');
  });
});

// ══════════════════════════════════════════════════════════════════
// W7 pattern audit — two more silent-wrongness classes, same disease as
// the lookup bug: RECORD TYPE drift was invisible (engine-owned for
// writes, but the scan must SEE it — compared by DeveloperName now),
// and multi-select picklists false-drifted on selection ORDER.
// ══════════════════════════════════════════════════════════════════
describe('RecordType drift is visible', () => {
  it('same Name, different RecordType.DeveloperName → changed names RecordTypeId', async () => {
    const RT_DESC = { name: 'Step_Order__c', fields: [
      ...STEP_DESC.fields,
      f('RecordTypeId', 'reference', { referenceTo: ['RecordType'], relationshipName: 'RecordType' }),
    ] };
    globalThis.describe = async () => RT_DESC;
    const srcRows = [{ Id: 'S_A', Name: 'A', RecordTypeId: 'RT1', RecordType: { DeveloperName: 'Standard' },
      Step_Order_Name__c: 'SN_1', Step_Order_Name__r: { Name: 'SN-001' },
      Procedure_Definition__c: 'PD1', Procedure_Definition__r: { Name: 'PD-001' } }];
    const tgtRows = [{ Id: 'T_A', Name: 'A', RecordTypeId: 'RT9x', RecordType: { DeveloperName: 'Special' },
      Step_Order_Name__c: 'SN_1x', Step_Order_Name__r: { Name: 'SN-001' },
      Procedure_Definition__c: 'PD1x', Procedure_Definition__r: { Name: 'PD-001' } }];
    globalThis.sendBg = async msg => {
      if (msg.type === 'SF_QUERY_ALL' || msg.type === 'SF_QUERY') {
        if (/= null/.test(String(msg.query || ''))) return { records: [], totalSize: 0, done: true };
        const rows = msg.orgUrl === SRC_ORG ? srcRows : tgtRows;
        return { records: rows.map(r => ({ ...r })), totalSize: rows.length, done: true };
      }
      return { error: 'unexpected ' + msg.type };
    };
    const p = PROFILE();
    const res = await scan.runDiffScan(p, p.tree, null);
    expect(res.error, res.error).toBeFalsy();
    const row = (res.changed || []).find(r => r.sourceId === 'S_A');
    expect(row, `RT-only drift must be CHANGED — changed=${JSON.stringify(res.changed)} identical=${JSON.stringify(res.identical)}`).toBeTruthy();
    expect((row.fields || []).join(',')).toContain('RecordTypeId');
  });
});

describe('sftkMultiSelNorm — selection order is not drift', () => {
  it('sorts parts so A;B equals B;A, trims, drops empties', () => {
    expect(scan.sftkMultiSelNorm('B;A')).toBe('A;B');
    expect(scan.sftkMultiSelNorm('A; B ;')).toBe('A;B');
    expect(scan.sftkMultiSelNorm('A;B')).toBe(scan.sftkMultiSelNorm('B;A'));
  });
  it('leaves null/empty untouched and differing selections differing', () => {
    expect(scan.sftkMultiSelNorm(null)).toBe(null);
    expect(scan.sftkMultiSelNorm('')).toBe('');
    expect(scan.sftkMultiSelNorm('A;C')).not.toBe(scan.sftkMultiSelNorm('A;B'));
  });
});

describe('owner drift — visible ONLY when the deployment matches owners', () => {
  const OWNER_DESC = { name: 'Step_Order__c', fields: [
    ...STEP_DESC.fields,
    f('OwnerId', 'reference', { referenceTo: ['User', 'Group'], relationshipName: 'Owner', polymorphicForeignKey: true }),
  ] };
  const srcRows = [{ Id: 'S_A', Name: 'A', OwnerId: 'U1', Owner: { Name: 'Ann Admin' },
    Step_Order_Name__c: 'SN_1', Step_Order_Name__r: { Name: 'SN-001' },
    Procedure_Definition__c: 'PD1', Procedure_Definition__r: { Name: 'PD-001' } }];
  const tgtRows = [{ Id: 'T_A', Name: 'A', OwnerId: 'U9x', Owner: { Name: 'Bob Builder' },
    Step_Order_Name__c: 'SN_1x', Step_Order_Name__r: { Name: 'SN-001' },
    Procedure_Definition__c: 'PD1x', Procedure_Definition__r: { Name: 'PD-001' } }];
  const install = () => {
    globalThis.describe = async () => OWNER_DESC;
    globalThis.sendBg = async msg => {
      if (msg.type === 'SF_QUERY_ALL' || msg.type === 'SF_QUERY') {
        if (/= null/.test(String(msg.query || ''))) return { records: [], totalSize: 0, done: true };
        const rows = msg.orgUrl === SRC_ORG ? srcRows : tgtRows;
        return { records: rows.map(r => ({ ...r })), totalSize: rows.length, done: true };
      }
      return { error: 'unexpected ' + msg.type };
    };
  };

  it("ownerMapping 'match' → different Owner.Name lands in changed as OwnerId", async () => {
    install();
    const p = { ...PROFILE(), ownerMapping: { mode: 'match' } };
    const res = await scan.runDiffScan(p, p.tree, null);
    expect(res.error, res.error).toBeFalsy();
    const row = (res.changed || []).find(r => r.sourceId === 'S_A');
    expect(row, `owner drift must be CHANGED — ${JSON.stringify(res.changed)}`).toBeTruthy();
    expect((row.fields || []).join(',')).toContain('OwnerId');
  });

  it("no ownerMapping → owner difference is EXPECTED, record stays identical", async () => {
    install();
    const p = PROFILE();
    const res = await scan.runDiffScan(p, p.tree, null);
    expect(res.error, res.error).toBeFalsy();
    expect((res.identical || []).some(r => r.sourceId === 'S_A'),
      `must be identical — changed=${JSON.stringify(res.changed)}`).toBe(true);
  });
});

// Campaign 3 phase 5 — ambiguous keys as a bucket, through the real runDiffScan.
describe('duplicate keys: listed, never guessed (⚠ Ambiguous)', () => {
  const DUP_DESC = { name: 'Account', fields: [f('Id', 'id', { createable: false }), f('Name', 'string', { nameField: true }), f('City__c', 'string')] };
  const run = async (src, tgt, memory) => {
    globalThis.describe = async () => DUP_DESC;
    globalThis.SFTK_MEM_NEW = '__insert_as_new__';
    globalThis.sendBg = async msg => {
      const q = String(msg.query || '');
      if (/= null/.test(q)) return { records: [], totalSize: 0, done: true };
      const rows = msg.orgUrl === SRC_ORG ? src : tgt;
      return { records: rows.map(r => ({ ...r })), totalSize: rows.length, done: true };
    };
    const p = { id: 'pd', name: 'dups', sourceOrg: SRC_ORG, targetOrg: TGT_ORG,
      scanConfig: { matchField: 'Name', compareFields: ['City__c'] },
      tree: { objectType: 'Account', where: '', children: [] },
      ...(memory ? { matchMemory: { [TGT_ORG.toLowerCase()]: memory } } : {}) };
    const res = await scan.runDiffScan(p, p.tree, null);
    delete globalThis.SFTK_MEM_NEW;
    expect(res.error, res.error).toBeFalsy();
    const where = id => ['missingInTarget', 'changed', 'identical', 'onlyInTarget', 'ambiguous']
      .filter(b => (res[b] || []).some(r => r.sourceId === id || (b === 'onlyInTarget' && r.targetId === id)));
    return { res, where };
  };
  const SRC = [{ Id: 'S_D1', Name: 'SFTK CX Duplicate Name', City__c: 'Haifa' }, { Id: 'S_D2', Name: 'SFTK CX Duplicate Name', City__c: 'Eilat' },
               { Id: 'S_U', Name: 'Unique', City__c: 'X' }];
  const TGT = [{ Id: 'T_D', Name: 'SFTK CX Duplicate Name', City__c: 'Target twin' }, { Id: 'T_U', Name: 'Unique', City__c: 'X' }];

  it('two source copies and one target: both copies under ⚠ Ambiguous with the candidate — in no other bucket, the target not "only in target"', async () => {
    const { res, where } = await run(SRC, TGT);
    expect(where('S_D1')).toEqual(['ambiguous']);
    expect(where('S_D2')).toEqual(['ambiguous']);
    expect(where('T_D')).toEqual([]);
    expect(res.ambiguous.find(r => r.sourceId === 'S_D1')).toMatchObject({ candidates: ['T_D'], twins: ['S_D2'] });
    expect(where('S_U')).toEqual(['identical']);
    expect(res.sourceCount).toBe(3);
    expect(res.targetCount).toBe(2);
  });
  it('copies with NO counterpart are ordinary records: every source copy is an insert, every target copy is "only in target"', async () => {
    const { res, where } = await run(
      [{ Id: 'S_X1', Name: 'Twin', City__c: 'a' }, { Id: 'S_X2', Name: 'Twin', City__c: 'b' }],
      [{ Id: 'T_Y1', Name: 'Other', City__c: 'a' }, { Id: 'T_Y2', Name: 'Other', City__c: 'b' }]);
    expect(where('S_X1')).toEqual(['missingInTarget']);
    expect(where('S_X2')).toEqual(['missingInTarget']);
    expect(where('T_Y1')).toEqual(['onlyInTarget']);
    expect(where('T_Y2')).toEqual(['onlyInTarget']);
    expect(res.ambiguous).toEqual([]);
  });
  it('📌 pairing one copy (match memory) settles the key: that copy is compared with its target, the other becomes an insert', async () => {
    const { where } = await run(SRC, TGT, { S_D1: 'T_D' });
    expect(where('S_D1')).toEqual(['changed']);
    expect(where('S_D2')).toEqual(['missingInTarget']);
  });
  it('➕ insert as new (memory value SFTK_MEM_NEW): that copy is an insert, the other pairs with the one target', async () => {
    const { res, where } = await run(SRC, TGT, { S_D2: '__insert_as_new__' });
    expect(where('S_D2')).toEqual(['missingInTarget']);
    expect(res.missingInTarget.find(r => r.sourceId === 'S_D2').forcedNew).toBe(true);
    expect(where('S_D1')).toEqual(['changed']);
    expect(res.ambiguous).toEqual([]);
  });
});
