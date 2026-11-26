// 2026-11-26, the owner after a dry run listed 204 Contacts under Insert that the deployment had itself written
// three days before (with data blending, so no name matched):
//   "Remember which source record became pair. Maybe we should with remembering + offering to stamp using the
//    external id field functionality we have"
// Three gaps closed: the pairs of a run were remembered for the ROOT object only; a Deploy run never wrote the
// identity stamp; and no scan ever read it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { extractFunction, extractFunctions } from './extract.mjs';
const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SC = read('studio-scan.js'), BG = read('background.js'), RC = read('studio-reconcile.js'), TR = read('studio-transfer.js'), SD = read('studio-seed.js');
const pre = extractFunction('sftk-matching.js', 'sftkIdentityPrepass');
const take = extractFunction('sftk-matching.js', 'sftkTakeIdPairs');
const { sftkIdStampTree } = extractFunctions('sftk-identity.js', ['sftkIdFieldName', 'sftkIdStampTree']);
const S = id => '003SRC0000000' + id + 'AAA';   // 18 characters
const NEW = '__insert_as_new__';

describe('who is paired before any key is looked at', () => {
  const src = [{ Id: S('01') }, { Id: S('02') }, { Id: S('03') }, { Id: S('04') }];
  it('the stamp: a target record holding a source record\'s Id is its pair, whatever its name is', () => {
    const tgt = [{ Id: 'T1', SFTK_ID__c: S('02') }, { Id: 'T2', SFTK_ID__c: null }, { Id: 'T3', SFTK_ID__c: S('99') }];
    const r = pre(src, tgt, {}, 'SFTK_ID__c', NEW);
    expect(r.pairs.map(p => [p.sr.Id, p.tr.Id, p.via])).toEqual([[S('02'), 'T1', 'stamp']]);
    expect([r.stamp, r.memory]).toEqual([1, 0]);
    expect([...r.srcIds]).toEqual([S('02')]); expect([...r.tgtIds]).toEqual(['T1']);
  });
  it('a 15-character stamp is the same record', () => {
    expect(pre(src, [{ Id: 'T1', SFTK_ID__c: S('03').slice(0, 15) }], {}, 'SFTK_ID__c', NEW).pairs.map(p => p.sr.Id)).toEqual([S('03')]);
  });
  it('a stamp two target records hold is nobody\'s pair', () => {
    const r = pre(src, [{ Id: 'T1', SFTK_ID__c: S('01') }, { Id: 'T2', SFTK_ID__c: S('01') }], {}, 'SFTK_ID__c', NEW);
    expect(r.pairs).toEqual([]);
  });
  it('the memory pairs what the stamp did not; the stamp wins where both speak', () => {
    const tgt = [{ Id: 'T1', SFTK_ID__c: S('01') }, { Id: 'T2' }, { Id: 'T3' }];
    const r = pre(src, tgt, { [S('01')]: 'T3', [S('02')]: 'T2', [S('03')]: 'T1', [S('04')]: 'TGONE' }, 'SFTK_ID__c', NEW);
    expect(r.pairs.map(p => [p.sr.Id, p.tr.Id, p.via])).toEqual([[S('01'), 'T1', 'stamp'], [S('02'), 'T2', 'memory']]);
    expect([r.stamp, r.memory]).toEqual([1, 1]);   // S03's remembered target is taken, S04's is gone: both go to key matching
    expect(r.srcIds.has(S('03'))).toBe(false); expect(r.srcIds.has(S('04'))).toBe(false);
  });
  it('"insert as new" leaves key matching and is listed as an insert', () => {
    const r = pre(src, [{ Id: 'T1' }], { [S('01')]: NEW }, null, NEW);
    expect(r.forcedNew.map(x => x.Id)).toEqual([S('01')]); expect(r.srcIds.has(S('01'))).toBe(true); expect(r.pairs).toEqual([]);
  });
  it('no field and no memory: nothing is paired here', () => {
    expect(pre(src, [{ Id: 'T1', SFTK_ID__c: S('01') }], null, null, NEW).pairs).toEqual([]);
  });
});

describe('the scan', () => {
  it('runs the pre-pass on EVERY scan, a child\'s too, and reads the stamp with the target rows', () => {
    expect(SC).toContain('const pre = sftkIdentityPrepass(srcRes.records || [], tgtRes.records || [], mem, _stampF, SFTK_MEM_NEW);');
    const at = SC.indexOf('const pre = sftkIdentityPrepass(');
    expect(SC.slice(at - 700, at)).not.toContain('if (isRootScan) {');
    expect(SC).toContain("const _stampF = (typeof sftkIdFieldName === 'function' && tgtTypes.has(sftkIdFieldName())) ? sftkIdFieldName() : null;");
    expect(SC).toContain("...(side === 'tgt' && _stampF ? [_stampF] : [])");
  });
  it('a pre-paired child is checked for its parent like any other pair', () => {
    const loop = SC.slice(SC.indexOf('for (const { sr, tr, via } of memRows) {'), SC.indexOf('// Pair-aligned compare driven by comparePlan'));
    expect(loop).toContain('linkMismatch.push({ matchKey: mk0, sourceId: sr.Id, targetId: tr.Id, parentKeySrc: pkS, parentKeyTgt: pkT, ...how });');
    expect(loop).toContain('else if (!linkDiff)    identical.push(');
    expect(loop).toContain("const how = via === 'stamp' ? { viaStamp: true } : { viaMemory: true };");
  });
  it('the identity field is never a compared value, and an update never rewrites it', () => {
    expect(SC).toContain("'Id', 'SFTK_ID__c',   // 🪪");
    expect(SC).toContain("const SKIP = new Set(['Id', 'SFTK_ID__c',");
    expect(RC).toContain("const SYS = new Set(['Id','SFTK_ID__c',");
  });
  it('says how many it recognised that way', () => {
    expect(SC).toContain('...(stampMatched ? { stampMatched } : {}),');
    expect(SC).toContain('sourceCount:   srcByKey.size + memoryMatched + stampMatched +');
    expect(read('studio-deploy.js')).toContain('by the identity field');
  });
});

describe('the engine', () => {
  it('reports the pairs of every node, never in a dry run', () => {
    expect(BG).toContain('if (!PROBE && idPairs.length < 20000) idPairs.push([recs[i + j].Id, result.id]);');
    expect(BG).not.toContain('isRootNode');
  });
  it('stamps what a Deploy run creates only where the target has the field', () => {
    expect(BG).toContain(': (node.stampIfPresent && tgtCreatable.has(node.stampIfPresent) ? node.stampIfPresent : null);');
    const t = sftkIdStampTree({ objectType: 'Account', children: [{ childSObject: 'Contact', children: [{ childSObject: 'Case' }] }, { childSObject: 'Opportunity', stampField: 'Ext__c' }] });
    expect(t.stampIfPresent).toBe('SFTK_ID__c');
    expect(t.children[0].stampIfPresent).toBe('SFTK_ID__c'); expect(t.children[0].children[0].stampIfPresent).toBe('SFTK_ID__c');
    expect(t.children[1].stampIfPresent).toBeUndefined();   // it names its own
  });
});

describe('every caller takes the pairs out of the answer', () => {
  it('all objects, valid pairs only, and the summary keeps none', () => {
    const sum = { Account: { created: 1, idPairs: [['a', 'b']] }, Contact: { idPairs: [['c', 'd'], ['', 'x'], 'no', ['e']] }, Case: { created: 0 } };
    expect(take(sum)).toEqual([['a', 'b'], ['c', 'd']]);
    expect(sum).toEqual({ Account: { created: 1 }, Contact: {}, Case: { created: 0 } });
    expect(take(null)).toEqual([]);
  });
  it('the Deploy run (both insert legs learn, the pull only strips), Run Transfer and the Seeder', () => {
    expect(RC.split('await noteIdentity(res);').length).toBe(3);
    expect(RC).toContain('await noteIdentity(res, false);');
    expect(RC.split('sftkIdStampTree(').length).toBe(3);
    expect(RC).not.toContain('s.idPairs?.length');
    expect(TR).toContain('await window.sftkLearnFromSummary?.(_transferProfile, result.summary, _transferSrc.orgUrl, _transferTgt.orgUrl);');
    expect(SD).toContain('sftkTakeIdPairs(result.summary);');
    expect(SC).toContain("if (_orgKey(srcOrgUrl || '') !== _orgKey(profile.sourceOrg || '')) return 0;");
  });
});
