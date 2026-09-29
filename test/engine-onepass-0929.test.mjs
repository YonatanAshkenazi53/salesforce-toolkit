// Campaign 3 phase 4 — the whole tree in one pass, engine side.
//
// A three-level tree (Account → Contact → Case) with nothing in the target
// deploys in ONE engine call: parents first, each child linked at insert to
// the id its parent got earlier in the same run. When every parent of a
// picked level fails, its children are not inserted — and the run says so,
// naming them (before 2026-09-29 they were silently absent).
import { describe, it, expect, afterEach } from 'vitest';
import { extractFunctions } from './extract.mjs';

const eng = extractFunctions('background.js', [
  'executeProfileTransfer', 'sftkVanillaPayloadRules', 'sftkEffectiveLookupResolutions', 'sftkLookupDefaultStrategy', 'buildCopyFields', 'sftkFieldsFromError', 'sftkOrgKey',
  'sftkTruncValue', 'sftkBuildOwnerIndex', 'sftkMatchKey', 'sftkPathValue',
  'sftkPiiHashHex', 'sftkPiiMaskable', 'sftkPiiFormat', 'sftkPiiMaskValue',
  'sftkPiiRulesForObject', 'sftkPiiMaskRows', 'sftkPiiMaskAnchorMap', 'sftkRtaImageCount',
]);
const SRC = 'https://src.my.salesforce.com', TGT = 'https://tgt.my.salesforce.com';
const f = (name, label, type, extra) => Object.assign({ name, label, type, createable: true, updateable: true, nillable: true, defaultValue: null, referenceTo: [], custom: false, length: 255 }, extra || {});
const DESC = {
  Account: { name: 'Account', fields: [f('Id', 'Account ID', 'id', { createable: false, updateable: false }), f('Name', 'Account Name', 'string', { nillable: false, nameField: true })] },
  Contact: { name: 'Contact', fields: [f('Id', 'Contact ID', 'id', { createable: false, updateable: false }), f('LastName', 'Last Name', 'string', { nillable: false, nameField: true }),
    f('AccountId', 'Account ID', 'reference', { referenceTo: ['Account'], relationshipName: 'Account' })] },
  Case: { name: 'Case', fields: [f('Id', 'Case ID', 'id', { createable: false, updateable: false }), f('Subject', 'Subject', 'string', { nameField: true }),
    f('ContactId', 'Contact ID', 'reference', { referenceTo: ['Contact'], relationshipName: 'Contact' })] },
};
const SRC_ROWS = {
  Account: [{ Id: 'A1', Name: 'Holding' }],
  Contact: [{ Id: 'C1', LastName: 'Levi', AccountId: 'A1' }, { Id: 'C2', LastName: 'Cohen', AccountId: 'A1' }],
  Case:    [{ Id: 'K1', Subject: 'Broken', ContactId: 'C1' }, { Id: 'K2', Subject: 'Late', ContactId: 'C2' }],
};
let calls;
function installWorld({ failObj, failIf } = {}) {
  calls = [];
  globalThis.API_VERSION = 'v62.0'; globalThis._runCancelled = false; globalThis.postRunProgress = () => {};
  const answer = (orgUrl, q) => {
    const obj = (/FROM (\w+)/.exec(q) || [])[1];
    let out = orgUrl === SRC ? (SRC_ROWS[obj] || []) : [];
    for (const m of q.matchAll(/(\w+) IN \(([^)]*)\)/g)) {
      const set = new Set([...m[2].matchAll(/'([^']+)'/g)].map(x => x[1]));
      out = out.filter(r => set.has(r[m[1]]));
    }
    if (/SELECT COUNT\(\)/.test(q)) return { totalSize: out.length, records: [] };
    return { records: out, totalSize: out.length, serverTotal: out.length };
  };
  globalThis.sfQuery    = async (o, s, q) => { calls.push(['query', o, q]); return answer(o, q); };
  globalThis.sfQueryAll = async (o, s, q) => { calls.push(['queryAll', o, q]); return answer(o, q); };
  globalThis.sfRestGet  = async (o, s, path) => { const m = /sobjects\/(\w+)\/describe/.exec(path); return (m && DESC[m[1]]) || { error: 'unexpected ' + path }; };
  let seq = 0;
  globalThis.sfCollectionsCreate = async (o, s, chunk) => {
    const obj = chunk[0] && chunk[0].attributes && chunk[0].attributes.type;
    calls.push(['create', obj, chunk.map(r => ({ ...r }))]);
    const bad = r => obj === failObj || (failIf && failIf(obj, r));
    return chunk.map(r => bad(r) ? ({ success: false, errors: [{ statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'a Lab lead needs a Phone', fields: [] }] }) : ({ success: true, id: 'N' + (++seq) }));
  };
  globalThis.sfCollectionsUpdate = async (o, s, recs) => { calls.push(['update', recs.map(r => ({ ...r }))]); return recs.map(() => ({ success: true })); };
  globalThis.sfCollectionsUpsert = async () => { throw new Error('upsert not expected'); };
  globalThis.sfBulkIngest = async () => { throw new Error('bulk not expected'); };
  globalThis.sfBulkQuery  = async () => { throw new Error('bulk query not expected'); };
}
afterEach(() => { for (const k of ['API_VERSION', '_runCancelled', 'postRunProgress', 'sfQuery', 'sfQueryAll', 'sfRestGet', 'sfCollectionsCreate', 'sfCollectionsUpdate', 'sfCollectionsUpsert', 'sfBulkIngest', 'sfBulkQuery']) delete globalThis[k]; });

// The shape the Deploy page sends after sftkRecOnePassPlan + sftkRecPruneTree:
// only the picked records, at every level.
const tree = (picks) => ({ id: 'p1', name: 'one pass', tree: { objectType: 'Account', recordIds: picks.Account, children: [
  { objectType: 'Contact', field: 'AccountId', recordIds: picks.Contact, children: [
    { objectType: 'Case', field: 'ContactId', recordIds: picks.Case, children: [] }] }] } });

describe('one engine call writes the whole tree, parents first, each child linked at insert', () => {
  it('Account → Contact → Case, nothing in the target: three creates in order, every link the NEW parent id', async () => {
    installWorld();
    const r = await eng.executeProfileTransfer(tree({ Account: ['A1'], Contact: ['C1'], Case: ['K1'] }), SRC, 'SID_S', TGT, 'SID_T');
    const creates = calls.filter(c => c[0] === 'create');
    expect(creates.map(c => c[1])).toEqual(['Account', 'Contact', 'Case']);
    const acc = creates[0][2][0], con = creates[1][2][0], cas = creates[2][2][0];
    expect(acc.Name).toBe('Holding');
    expect(con).toMatchObject({ LastName: 'Levi', AccountId: 'N1' });
    expect(cas).toMatchObject({ Subject: 'Broken', ContactId: 'N2' });
    expect(r.summary).toMatchObject({ Account: { created: 1 }, Contact: { created: 1 }, Case: { created: 1 } });
    // only the picked child records were read — never "every Contact of the account"
    expect(creates[1][2]).toHaveLength(1);
    expect(r.errors.some(e => /^⚠/.test(e))).toBe(false);
  });
  it('when every parent of a level fails, its children are NOT inserted without them — and the run names them', async () => {
    installWorld({ failObj: 'Contact' });
    const r = await eng.executeProfileTransfer(tree({ Account: ['A1'], Contact: ['C1', 'C2'], Case: ['K1', 'K2'] }), SRC, 'SID_S', TGT, 'SID_T');
    const creates = calls.filter(c => c[0] === 'create');
    expect(creates.map(c => c[1])).toEqual(['Account', 'Contact']);   // no Case create at all
    expect(r.summary.Contact.failed).toBe(2);
    expect(r.summary.Case).toMatchObject({ created: 0, skipped: true });
    expect(r.errors).toContain('⚠ Case: 2 selected record(s) not inserted — none of their Contact parent(s) made it into the target in this run (see Contact above); nothing was inserted without its parent. Not inserted: K1, K2');
  });
  it('when SOME parents fail, their children are named as a warning (the parent failed in this run), the rest go in', async () => {
    installWorld({ failIf: (obj, r) => obj === 'Contact' && r.LastName === 'Levi' });
    const r = await eng.executeProfileTransfer(tree({ Account: ['A1'], Contact: ['C1', 'C2'], Case: ['K1', 'K2'] }), SRC, 'SID_S', TGT, 'SID_T');
    const cases = calls.filter(c => c[0] === 'create' && c[1] === 'Case').flatMap(c => c[2]);
    expect(cases.map(x => x.Subject)).toEqual(['Late']);          // K2 under Cohen went in, linked to her new id
    expect(cases[0].ContactId).toMatch(/^N\d+$/);
    expect(r.errors).toContain("⚠ Case: 1 of 2 selected record(s) not inserted — their Contact parent failed to insert in this run (see Contact above), or is outside the run's scope; nothing was inserted without its parent. Not inserted: K1");
    expect(r.errors.some(e => /hand-picked record\(s\) are NOT in this run/.test(e))).toBe(false);
  });
});
