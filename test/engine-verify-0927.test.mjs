// Engine — post-run verification (campaign 3, phase 1).
//
// executeProfileTransfer reported every count from the Collections
// SaveResults and never re-read the org (found by the write-discipline sweep,
// 2026-09-27). Now, after the writes and the late-link pass, it re-queries
// the written ids per object and carries summary[obj].verified; a shortfall
// is an ℹ note, the counts stay Salesforce's answer.
import { describe, it, expect, afterEach } from 'vitest';
import { extractFunctions } from './extract.mjs';

// the same world the other engine tests use (test/engine-latelinks-0922)
const eng = extractFunctions('background.js', [
  'executeProfileTransfer', 'sftkVanillaPayloadRules', 'sftkEffectiveLookupResolutions', 'sftkLookupDefaultStrategy', 'buildCopyFields', 'sftkFieldsFromError', 'sftkOrgKey',
  'sftkTruncValue', 'sftkBuildOwnerIndex', 'sftkMatchKey', 'sftkPathValue',
  'sftkPiiHashHex', 'sftkPiiMaskable', 'sftkPiiFormat', 'sftkPiiMaskValue',
  'sftkPiiRulesForObject', 'sftkPiiMaskRows', 'sftkPiiMaskAnchorMap', 'sftkRtaImageCount',
]);

const SRC = 'https://src.my.salesforce.com', TGT = 'https://tgt.my.salesforce.com';
const f = (name, label, type, extra) => Object.assign({ name, label, type, createable: true, updateable: true, nillable: true, defaultValue: null, referenceTo: [], custom: false, length: 255 }, extra || {});
const ACCOUNT_DESC = { name: 'Account', fields: [
  f('Id', 'Account ID', 'id', { createable: false, updateable: false }),
  f('Name', 'Account Name', 'string', { nillable: false, nameField: true }),
  f('ParentId', 'Parent Account', 'reference', { referenceTo: ['Account'], relationshipName: 'Parent' }),
] };
const SRC_ACCOUNTS = [
  { Id: 'A1', Name: 'One',   ParentId: null },
  { Id: 'A2', Name: 'Two',   ParentId: null },
  { Id: 'A3', Name: 'Three', ParentId: null },
];

let calls = [];
// serveCreated: whether the target answers the post-run re-read with the ids it created
function installWorld({ serveCreated }) {
  calls = [];
  const created = [];
  globalThis.API_VERSION = 'v62.0'; globalThis._runCancelled = false; globalThis.postRunProgress = () => {};
  const answer = (orgUrl, q) => {
    let out = orgUrl === SRC ? SRC_ACCOUNTS : (serveCreated ? created : []);
    const idIn = /Id IN \(([^)]*)\)/.exec(q);
    if (idIn) { const ids = new Set([...idIn[1].matchAll(/'([^']+)'/g)].map(m => m[1])); out = out.filter(r => ids.has(r.Id)); }
    if (/SELECT COUNT\(\)/.test(q)) return { totalSize: out.length, records: [] };
    return { records: out, totalSize: out.length, serverTotal: out.length };
  };
  globalThis.sfQuery    = async (o, s, q) => { calls.push(['query', o, q]); return answer(o, q); };
  globalThis.sfQueryAll = async (o, s, q) => { calls.push(['queryAll', o, q]); return answer(o, q); };
  globalThis.sfRestGet  = async (o, s, path) => (/sobjects\/Account\/describe/.test(path) ? ACCOUNT_DESC : { error: 'unexpected ' + path });
  let seq = 0;
  globalThis.sfCollectionsCreate = async (o, s, chunk) => chunk.map(r => { const id = 'N' + (++seq); created.push({ Id: id, Name: r.Name }); return { success: true, id }; });
  globalThis.sfCollectionsUpdate = async (o, s, recs) => recs.map(() => ({ success: true }));
  globalThis.sfCollectionsUpsert = async () => { throw new Error('upsert not expected'); };
  globalThis.sfBulkIngest = async () => { throw new Error('bulk not expected'); };
  globalThis.sfBulkQuery  = async () => { throw new Error('bulk query not expected'); };
}
afterEach(() => { for (const k of ['API_VERSION', '_runCancelled', 'postRunProgress', 'sfQuery', 'sfQueryAll', 'sfRestGet', 'sfCollectionsCreate', 'sfCollectionsUpdate', 'sfCollectionsUpsert', 'sfBulkIngest', 'sfBulkQuery']) delete globalThis[k]; });

const profile = { id: 'p1', name: 'accounts', tree: { objectType: 'Account', recordIds: ['A1', 'A2', 'A3'], children: [] } };

describe('post-run verification', () => {
  it('re-queries the written ids in the target after the run and records checked / found', async () => {
    installWorld({ serveCreated: true });
    const r = await eng.executeProfileTransfer(profile, SRC, 'SID_S', TGT, 'SID_T');
    expect(r.summary.Account.created).toBe(3);
    expect(r.summary.Account.verified).toEqual({ checked: 3, found: 3, sampled: false });
    const reread = calls.filter(c => c[1] === TGT && /SELECT Id FROM Account WHERE Id IN \('N1','N2','N3'\)/.test(c[2]));
    expect(reread.length).toBe(1);
    expect(r.errors.filter(e => /re-read/.test(e))).toEqual([]);
    expect(r.status).toBe('success');
  });
  it('a shortfall keeps the counts and adds an ℹ note saying what the org shows now', async () => {
    installWorld({ serveCreated: false });
    const r = await eng.executeProfileTransfer(profile, SRC, 'SID_S', TGT, 'SID_T');
    expect(r.summary.Account.created).toBe(3);
    expect(r.summary.Account.verified).toEqual({ checked: 3, found: 0, sampled: false });
    expect(r.errors).toContain('ℹ Account: re-read after the run found 0 of 3 written record(s) in the target — 3 not there now (deleted by automation, or the write did not persist)');
  });
  it('a failing re-read is a note, never a lost run', async () => {
    installWorld({ serveCreated: true });
    const q = globalThis.sfQueryAll;
    globalThis.sfQueryAll = async (o, s, qq) => (o === TGT && /WHERE Id IN/.test(qq) && /^SELECT Id FROM/.test(qq)) ? { error: 'Session expired' } : q(o, s, qq);
    const r = await eng.executeProfileTransfer(profile, SRC, 'SID_S', TGT, 'SID_T');
    expect(r.summary.Account.created).toBe(3);
    expect(r.summary.Account.verified).toBeUndefined();
    expect(r.errors.some(e => e.startsWith('ℹ post-run re-read could not finish (Account: Session expired)'))).toBe(true);
    expect(r.status).toBe('success');
  });
});

describe('History shows the re-read', () => {
  it('the per-object chip carries ✓ when found = checked, ⚠ found/checked otherwise, and the title says so', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../studio-history.js', import.meta.url), 'utf8');
    expect(src).toContain("const verifiedMark = s.verified ? (s.verified.found === s.verified.checked ? ' ✓' : ` ⚠${s.verified.found}/${s.verified.checked}`) : '';");
    expect(src).toContain('re-read in the target after the run');
    expect(src).toContain("not re-read after the run — counts are Salesforce's answers to the writes");
    expect(src).toContain('${headCounts}${verifiedMark}');
  });
});
