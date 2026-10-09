// 2026-09-22 — FIRST LIVE RUN of a 3-level Account hierarchy (trailheads2 →
// trailheads4): level 2 arrived flat. Account.ParentId points at the object
// itself; the builder hides such lookups and the engine only remapped them
// through idMap when the parent was inserted EARLIER in the run — a parent
// inserted in the same batch, or later, was dropped silently.
// The engine now defers every lookup that points INTO the deployment and
// connects it at the end of the run.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const eng = extractFunctions('background.js', [
  'executeProfileTransfer', 'sftkRunStopLine', '_runStopReason', '_runNoteStop', 'sftkVanillaPayloadRules', 'sftkEffectiveLookupResolutions', 'sftkLookupDefaultStrategy', 'buildCopyFields', 'sftkFieldsFromError', 'sftkOrgKey',
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
// Holding ← Europe ← Berlin: three levels, all missing from the target
const SRC_ACCOUNTS = [
  { Id: 'A1', Name: 'Holding', ParentId: null },
  { Id: 'A2', Name: 'Europe',  ParentId: 'A1' },
  { Id: 'A3', Name: 'Berlin',  ParentId: 'A2' },
];
let calls;
function installWorld(tgtRows = []) {
  calls = [];
  globalThis.API_VERSION = 'v62.0'; globalThis._runCancelled = false; globalThis.postRunProgress = () => {};
  const answer = (orgUrl, q) => {
    let out = orgUrl === SRC ? SRC_ACCOUNTS : tgtRows;
    const idIn = /Id IN \(([^)]*)\)/.exec(q);
    if (idIn) { const ids = new Set([...idIn[1].matchAll(/'([^']+)'/g)].map(m => m[1])); out = out.filter(r => ids.has(r.Id)); }
    const nameIn = /Name IN \(([^)]*)\)/.exec(q);
    if (nameIn) { const ns = new Set([...nameIn[1].matchAll(/'([^']+)'/g)].map(m => m[1])); out = out.filter(r => ns.has(r.Name)); }
    if (/SELECT COUNT\(\)/.test(q)) return { totalSize: out.length, records: [] };
    return { records: out, totalSize: out.length, serverTotal: out.length };
  };
  globalThis.sfQuery    = async (o, s, q) => { calls.push(['query', o, q]); return answer(o, q); };
  globalThis.sfQueryAll = async (o, s, q) => { calls.push(['queryAll', o, q]); return answer(o, q); };
  globalThis.sfRestGet  = async (o, s, path) => (/sobjects\/Account\/describe/.test(path) ? ACCOUNT_DESC : { error: 'unexpected ' + path });
  let seq = 0;
  globalThis.sfCollectionsCreate = async (o, s, chunk) => { calls.push(['create', chunk.map(r => ({ ...r }))]); return chunk.map(() => ({ success: true, id: 'N' + (++seq) })); };
  globalThis.sfCollectionsUpdate = async (o, s, recs) => { calls.push(['update', recs.map(r => ({ ...r }))]); return recs.map(() => ({ success: true })); };
  globalThis.sfCollectionsUpsert = async () => { throw new Error('upsert not expected'); };
  globalThis.sfBulkIngest = async () => { throw new Error('bulk not expected'); };
  globalThis.sfBulkQuery  = async () => { throw new Error('bulk query not expected'); };
}
afterEach(() => { for (const k of ['API_VERSION', '_runCancelled', 'postRunProgress', 'sfQuery', 'sfQueryAll', 'sfRestGet', 'sfCollectionsCreate', 'sfCollectionsUpdate', 'sfCollectionsUpsert', 'sfBulkIngest', 'sfBulkQuery']) delete globalThis[k]; });

describe('self-lookups are connected after insert', () => {
  it('a 3-level hierarchy: inserted flat, then every ParentId patched to the NEW target ids — no configuration needed', async () => {
    installWorld();
    const p = { id: 'p1', name: 'hier', tree: { objectType: 'Account', recordIds: ['A1', 'A2', 'A3'], children: [] } };
    const r = await eng.executeProfileTransfer(p, SRC, 'SID_S', TGT, 'SID_T');
    const creates = calls.filter(c => c[0] === 'create').flatMap(c => c[1]);
    expect(creates.map(x => x.Name).sort()).toEqual(['Berlin', 'Europe', 'Holding']);
    expect(creates.every(x => !('ParentId' in x))).toBe(true);           // nothing wrong was sent
    const updates = calls.filter(c => c[0] === 'update').flatMap(c => c[1]);
    const idOf = n => creates.indexOf(creates.find(x => x.Name === n));    // create order = N1..N3
    const byId = Object.fromEntries(updates.map(u => [u.Id, u.ParentId]));
    expect(byId['N' + (idOf('Europe') + 1)]).toBe('N' + (idOf('Holding') + 1));
    expect(byId['N' + (idOf('Berlin') + 1)]).toBe('N' + (idOf('Europe') + 1));
    expect(updates.length).toBe(2);
    expect(r.summary.Account.lateLinked).toBe(2);
    expect(r.errors.some(e => /ℹ Account: 🔗 2 record\(s\) connected after insert \(ParentId ×2\)/.test(e))).toBe(true);
    expect(r.errors.some(e => /will have null/.test(e))).toBe(false);
  });
  it('a parent this run does not create is said, with what to do — never guessed', async () => {
    installWorld();
    const p = { id: 'p2', name: 'partial', tree: { objectType: 'Account', recordIds: ['A1', 'A3'], children: [] } };   // Berlin's parent Europe is not in the run
    const r = await eng.executeProfileTransfer(p, SRC, 'SID_S', TGT, 'SID_T');
    expect(calls.filter(c => c[0] === 'update').length).toBe(0);
    expect(r.errors.some(e => /⚠ Account: 1 lookup value\(s\) left empty \(ParentId ×1\) — the Account record they point at is neither in the target nor created by this run/.test(e))).toBe(true);
  });
  it('a parent already in the target is matched by the bridge; the rest is a note that promises the late pass', async () => {
    installWorld([{ Id: 'T1', Name: 'Holding', ParentId: null }]);
    const p = { id: 'p3', name: 'bridge', tree: { objectType: 'Account', recordIds: ['A2', 'A3'], children: [],
      lookupResolutions: { ParentId: { strategy: 'match', matchField: 'Name', matchObject: 'Account' } } } };
    const r = await eng.executeProfileTransfer(p, SRC, 'SID_S', TGT, 'SID_T');
    const creates = calls.filter(c => c[0] === 'create').flatMap(c => c[1]);
    expect(creates.find(x => x.Name === 'Europe').ParentId).toBe('T1');   // bridge hit at insert
    expect('ParentId' in creates.find(x => x.Name === 'Berlin')).toBe(false);
    const updates = calls.filter(c => c[0] === 'update').flatMap(c => c[1]);
    expect(updates.length).toBe(1);
    expect(r.errors.some(e => /ℹ Account.ParentId: 1\/2 lookups resolved via Account.Name in the target — the other 1 are inserted with an empty ParentId and connected after insert/.test(e))).toBe(true);
    expect(r.errors.some(e => /^Account.ParentId: .*will have null/.test(e))).toBe(false);
  });
});

describe('child scans say who the duplicate-name copies are', () => {
  const SC = readFileSync(new URL('../studio-scan.js', import.meta.url), 'utf8');
  const DV = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
  it('the child result carries dupKeys and a warning naming the keys', () => {
    expect(SC).toContain('...(_keyCollisions ? { dupKeys: _keyCollisions } : {}),');
    expect(SC).not.toContain("...((!scope && _keyCollisions) ? { dupKeys: _keyCollisions } : {}),");
    expect(SC).toContain('where both orgs hold the key, the scan cannot tell the copies apart, so they are under ⚠ Ambiguous and are never deployed from here.');
  });
  it('the Deploy page shows a card per child with duplicates, and the child warnings on its list', () => {
    expect(DV).toContain('for (const [pk, cs] of Object.entries(scan.children || {})) {');
    expect(DV).toContain('class="ds-dep-childdup"');
    expect(DV).toContain("${!isRoot ? (s.warnings || []).map(w => `<div class=\"ds-dep-note\">⚠ ${esc(String(w).replace(/^[⚠\\s]+/, ''))}</div>`).join('') : ''}");
  });
});
