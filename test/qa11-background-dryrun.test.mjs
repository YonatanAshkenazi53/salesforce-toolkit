// QA 1.1 findings 10, 49, 50 — the dry run: an upsert that only updated is never deleted; 5 object levels per
// transaction; the duplicate-rule bypass rides per object, not on the whole request.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const BG = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const eng = extractFunctions('background.js', [
  'executeProfileTransfer', 'sftkUnconfirmedRows', 'sftkIsUnconfirmed', 'sftkFailureMeansInTarget', '_runDupBypassFor', 'sftkRunStopLine', '_runStopReason', '_runNoteStop', 'sftkVanillaPayloadRules', 'sftkEffectiveLookupResolutions', 'sftkLookupDefaultStrategy', 'buildCopyFields', 'sftkFieldsFromError', 'sftkOrgKey',
  'sftkTruncValue', 'sftkBuildOwnerIndex', 'sftkQueueOwnerMap', 'sftkOwnerFallbackFor', 'sftkMatchKey', 'sftkPathValue',
  'sftkPiiHashHex', 'sftkPiiMaskable', 'sftkPiiFormat', 'sftkPiiMaskValue',
  'sftkPiiRulesForObject', 'sftkPiiMaskRows', 'sftkPiiMaskAnchorMap', 'sftkRtaImageCount',
  'sftkProbeToken', 'sftkProbeParseToken', 'sftkProbePoison', 'sftkProbeCompositeBody', 'sftkProbeParseRound', 'sftkProbeCascade', 'sftkProbeStatus', 'sftkProbeLimits',
]);

const SRC = 'https://src.my.salesforce.com', TGT = 'https://tgt.my.salesforce.com';
const f = (name, label, type, extra) => Object.assign({ name, label, type, createable: true, updateable: true, nillable: true, defaultValue: null, referenceTo: [], custom: false, length: 255 }, extra || {});
const OBJS = ['Account', 'Contact', 'Opportunity', 'Case', 'Asset', 'Contract'];
const DESC = {
  Account: { name: 'Account', fields: [f('Id', 'Account ID', 'id', { createable: false, updateable: false }), f('Name', 'Account Name', 'string', { nillable: false, nameField: true }),
    f('Ext__c', 'Ext', 'string', { externalId: true, custom: true })] },
};
for (const o of OBJS.slice(1)) {
  DESC[o] = { name: o, fields: [f('Id', `${o} ID`, 'id', { createable: false, updateable: false }), f('Name', 'Name', 'string', { nameField: true }),
    f('AccountId', 'Account ID', 'reference', { referenceTo: ['Account'], relationshipName: 'Account' })] };
}
const SRC_ROWS = { Account: [{ Id: 'A1', Name: 'Holding', Ext__c: 'E1' }, { Id: 'A2', Name: 'Branch', Ext__c: 'E2' }] };
for (const o of OBJS.slice(1)) SRC_ROWS[o] = [{ Id: `${o}1`, Name: `${o} one`, AccountId: 'A1' }];

let composites, deleted;
const WORLD = ['API_VERSION', '_runCancelled', 'postRunProgress', 'sfQuery', 'sfQueryAll', 'sfRestGet', 'sfCollectionsCreate', 'sfCollectionsUpdate', 'sfCollectionsUpsert', 'sfCollectionsDelete', 'sfBulkIngest', 'sfBulkQuery', 'sfProbeComposite', '__sftkRunDupBypass', '__sftkRunDupBypassObjs'];
function installWorld(targetHas = []) {
  composites = []; deleted = [];
  globalThis.API_VERSION = 'v62.0'; globalThis._runCancelled = false; globalThis.postRunProgress = () => {};
  const answer = (orgUrl, q) => {
    const obj = (/FROM (\w+)/.exec(q) || [])[1];
    let out = orgUrl === SRC ? (SRC_ROWS[obj] || []) : targetHas.filter(r => r.obj === obj).map(r => ({ Id: r.Id }));
    for (const m of q.matchAll(/(\w+) IN \(([^)]*)\)/g)) {
      const set = new Set([...m[2].matchAll(/'([^']+)'/g)].map(x => x[1]));
      out = out.filter(r => set.has(r[m[1]]));
    }
    if (/SELECT COUNT\(\)/.test(q)) return { totalSize: out.length, records: [] };
    return { records: out, totalSize: out.length, serverTotal: out.length };
  };
  globalThis.sfQuery    = async (o, s, q) => answer(o, q);
  globalThis.sfQueryAll = async (o, s, q) => answer(o, q);
  globalThis.sfRestGet  = async (o, s, path) => { const m = /sobjects\/(\w+)\/describe/.exec(path); return (m && DESC[m[1]]) || { error: 'unexpected ' + path }; };
  globalThis.sfCollectionsCreate = async () => { throw new Error('a dry run must never create'); };
  globalThis.sfCollectionsUpdate = async () => { throw new Error('a dry run must never update'); };
  globalThis.sfCollectionsUpsert = async () => { throw new Error('a dry run must never upsert'); };
  globalThis.sfCollectionsDelete = async (o, s, ids) => { deleted.push(ids.slice()); return ids.map(id => ({ id, success: true })); };
  globalThis.sfBulkIngest = async () => { throw new Error('bulk not expected'); };
  globalThis.sfBulkQuery  = async () => { throw new Error('bulk query not expected'); };
  const halted = [{ errorCode: 'PROCESSING_HALTED', message: 'rolled back' }];
  globalThis.sfProbeComposite = async (o, s, body) => {
    composites.push(JSON.parse(JSON.stringify(body)));
    const out = body.compositeRequest.filter(r => r.referenceId !== 'poison').map(r => ({ referenceId: r.referenceId, httpStatusCode: 400, body: halted }));
    out.push({ referenceId: 'poison', httpStatusCode: 400, body: [{ errorCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [Name]' }] });
    return { compositeResponse: out };
  };
}
afterEach(() => { for (const k of WORLD) delete globalThis[k]; });

// ── finding 10 ───────────────────────────────────────────────────────────
describe('finding 10: an upsert row that only updated an existing record is not a dry-run record', () => {
  const upsertSub = [{ ref: 'n0', objType: 'Account', upsertField: 'Ext__c', rows: [{ srcId: 'A1' }, { srcId: 'A2' }] }];
  const accepted = { referenceId: 'poison', httpStatusCode: 201, body: { id: '001000000000009AAA', success: true, errors: [] } };

  it('created:false goes to `updated`, created:true to `persisted`; an insert node is unchanged', () => {
    const resp = { compositeResponse: [
      { referenceId: 'n0', httpStatusCode: 200, body: [{ success: true, created: false, id: '001000000000001AAA' }, { success: true, created: true, id: '001000000000002AAA' }] },
      accepted,
    ] };
    const r = eng.sftkProbeParseRound(upsertSub, resp);
    expect(r.updated).toEqual([{ objType: 'Account', id: '001000000000001AAA', srcId: 'A1' }]);
    expect(r.persisted).toEqual([
      { objType: 'Account', id: '001000000000002AAA', srcId: 'A2' },
      { objType: 'Account', id: '001000000000009AAA', srcId: null, poison: true },
    ]);
    const ins = eng.sftkProbeParseRound([{ ...upsertSub[0], upsertField: null }], resp);
    expect(ins.updated).toEqual([]);
    expect(ins.persisted.map(p => p.id)).toEqual(['001000000000001AAA', '001000000000002AAA', '001000000000009AAA']);
  });

  it('an upsert answer that does not say created:true is never handed to the delete', () => {
    const r = eng.sftkProbeParseRound(upsertSub, { compositeResponse: [
      { referenceId: 'n0', httpStatusCode: 200, body: [{ success: true, id: '001000000000001AAA' }, { success: true, id: '001000000000002AAA' }] },
    ] });
    expect(r.persisted).toEqual([]);
    expect(r.updated.map(p => p.id)).toEqual(['001000000000001AAA', '001000000000002AAA']);
  });

  it('the engine: the accepted poison is deleted, the pre-existing records are NOT, and the run says which were updated', async () => {
    installWorld([{ obj: 'Account', Id: '001000000000001AAA' }, { obj: 'Account', Id: '001000000000002AAA' }, { obj: 'Account', Id: '001000000000009AAA' }]);
    globalThis.sfProbeComposite = async (o, s, body) => {
      composites.push(body);
      return { compositeResponse: [
        { referenceId: 'n0', httpStatusCode: 200, body: [{ success: true, created: false, id: '001000000000001AAA' }, { success: true, created: false, id: '001000000000002AAA' }] },
        accepted,
      ] };
    };
    const r = await eng.executeProfileTransfer({ id: 'p', name: 'x', probe: true, upsert: { field: 'Ext__c' }, tree: { objectType: 'Account', recordIds: ['A1', 'A2'], children: [] } }, SRC, 'S', TGT, 'T');
    expect(composites[0].compositeRequest[0]).toMatchObject({ method: 'PATCH', url: '/services/data/v62.0/composite/sobjects/Account/Ext__c' });
    expect(deleted).toEqual([['001000000000009AAA']]);   // the poison only
    const line = r.errors.find(e => /already in the target were UPDATED/.test(e));
    expect(line).toBeTruthy();
    expect(line).toContain('2 record(s)');
    expect(line).toContain('001000000000001AAA, 001000000000002AAA');
    expect(line).toContain('not deleted');
    expect(r.errors.some(e => /1 record\(s\) from the dry run WERE written/.test(e))).toBe(true);
    expect(r.status).toBe('failed');
  });

  it('a round that DID roll back (the poison failed) reports no update and deletes nothing', async () => {
    installWorld([{ obj: 'Account', Id: '001000000000001AAA' }]);
    globalThis.sfProbeComposite = async () => ({ compositeResponse: [
      { referenceId: 'n0', httpStatusCode: 200, body: [{ success: true, created: false, id: '001000000000001AAA' }, { success: true, created: false, id: '001000000000002AAA' }] },
      { referenceId: 'poison', httpStatusCode: 400, body: [{ errorCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [Name]' }] },
    ] });
    const r = await eng.executeProfileTransfer({ id: 'p', name: 'x', probe: true, upsert: { field: 'Ext__c' }, tree: { objectType: 'Account', recordIds: ['A1', 'A2'], children: [] } }, SRC, 'S', TGT, 'T');
    expect(deleted).toEqual([]);
    expect(r.errors.some(e => /UPDATED/.test(e))).toBe(false);
    expect(r.status).toBe('success');
  });

  it('the verdict: an updated existing record makes the dry run failed', () => {
    expect(eng.sftkProbeStatus({ byObj: { Account: { wouldWrite: 3 } }, updatedExisting: [{ objType: 'Account', id: 'x' }] }, [])).toBe('failed');
    expect(eng.sftkProbeStatus({ byObj: { Account: { wouldWrite: 3 } }, updatedExisting: [] }, [])).toBe('success');
  });
});

// ── finding 49 ───────────────────────────────────────────────────────────
describe('finding 49: one transaction takes 5 sObject Collections subrequests', () => {
  const wide = (kids) => ({ id: 'p', name: 'wide', probe: true, tree: { objectType: 'Account', recordIds: ['A1'],
    children: kids.map(o => ({ objectType: o, field: 'AccountId', recordIds: [`${o}1`], children: [] })) } });

  it('the limit is 5', () => { expect(eng.sftkProbeLimits().maxSubs).toBe(5); });

  it('5 object levels go in one request: 5 Collections subrequests and the poison', async () => {
    installWorld();
    const r = await eng.executeProfileTransfer(wide(OBJS.slice(1, 5)), SRC, 'S', TGT, 'T');
    expect(composites).toHaveLength(1);
    expect(composites[0].compositeRequest.filter(x => /\/composite\/sobjects/.test(x.url))).toHaveLength(5);
    expect(composites[0].compositeRequest).toHaveLength(6);
    expect(r.status).toBe('success');
  });

  it('6 object levels are refused before anything is sent, with the number and what to do', async () => {
    installWorld();
    const r = await eng.executeProfileTransfer(wide(OBJS.slice(1)), SRC, 'S', TGT, 'T');
    expect(composites).toHaveLength(0);
    const line = r.errors.find(e => /object levels/.test(e));
    expect(line).toContain('writes 6 object levels');
    expect(line).toContain('Salesforce takes 5 in one rolled-back transaction');
    expect(line).toContain('nothing was checked');
    expect(line).toContain('Dry-run a smaller selection');
    expect(r.status).not.toBe('success');
  });
});

// ── finding 50 ───────────────────────────────────────────────────────────
describe('finding 50: the duplicate-rule bypass rides on each object\'s own subrequest', () => {
  const HDR = { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' };
  const subs = () => ([
    { ref: 'n0', objType: 'Account', upsertField: null, rows: [{ srcId: 'A1', payload: { Name: 'Holding' } }] },
    { ref: 'n1', objType: 'Contact', upsertField: null, rows: [{ srcId: 'C1', payload: { LastName: 'Levi' } }] },
  ]);
  it('the header is on the ticked object only, and never on the poison', () => {
    const b = eng.sftkProbeCompositeBody(subs(), 'v62.0', o => o === 'Account');
    expect(b.compositeRequest[0].httpHeaders).toEqual(HDR);
    expect(b.compositeRequest[1].httpHeaders).toBeUndefined();
    expect(b.compositeRequest[2].referenceId).toBe('poison');
    expect(b.compositeRequest[2].httpHeaders).toBeUndefined();
  });
  it('no choice given: no subrequest carries a header', () => {
    const b = eng.sftkProbeCompositeBody(subs(), 'v62.0');
    expect(b.compositeRequest.every(x => x.httpHeaders === undefined)).toBe(true);
  });

  const tree = { objectType: 'Account', recordIds: ['A1'], children: [{ objectType: 'Contact', field: 'AccountId', recordIds: ['Contact1'], children: [] }] };
  const run = async (extra) => {
    installWorld();
    await eng.executeProfileTransfer({ id: 'p', name: 'x', probe: true, tree, ...extra }, SRC, 'S', TGT, 'T');
    return composites[0].compositeRequest.map(x => [x.referenceId, x.httpHeaders]);
  };
  it('Bypass on, only Account ticked: Account bypasses, Contact meets its duplicate rules', async () => {
    expect(await run({ duplicateRules: 'bypass', dupBypassObjects: ['Account'] })).toEqual([['n0', HDR], ['n1', undefined], ['poison', undefined]]);
  });
  it('Bypass on, every object unticked: nothing bypasses', async () => {
    expect(await run({ duplicateRules: 'bypass', dupBypassObjects: [] })).toEqual([['n0', undefined], ['n1', undefined], ['poison', undefined]]);
  });
  it('Bypass on with no per-object choice: every object bypasses, as in the real run', async () => {
    expect(await run({ duplicateRules: 'bypass' })).toEqual([['n0', HDR], ['n1', HDR], ['poison', undefined]]);
  });
  it('Bypass off: nothing bypasses', async () => {
    expect(await run({})).toEqual([['n0', undefined], ['n1', undefined], ['poison', undefined]]);
  });
  it('the outer composite call sends no duplicate-rule header of its own', () => {
    const at = BG.indexOf('async function sfProbeComposite(');
    const fn = BG.slice(at, BG.indexOf('\n}', at));
    expect(fn).not.toContain('_runDupHeaders');
    expect(fn).not.toContain('Sforce-Duplicate-Rule-Header');
  });
});
