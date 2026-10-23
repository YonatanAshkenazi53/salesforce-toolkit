import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';
import { readFileSync } from 'node:fs';

// User 2026-10-23: "if we have 100 pct population of the field name but only 90 on the second field …
// pick the most specific by both fields and then fall back to only matching by name for those who
// don't hold the value of the second field" — "all the levels should support this feature".
const { sftkMatchParts, sftkTieredScore, sftkTieredPick, sftkTieredPairs, sftkMatchingFromNode, sftkMatchingReadsAs } =
  extractFunctions('sftk-matching.js', ['sftkMatchParts', 'sftkTieredScore', 'sftkTieredPick', 'sftkTieredPairs', 'sftkMatchingFromNode', 'sftkMatchingReadsAs', 'sftkNormalizeValue', 'sftkPathValue']);

const M = { fields: ['Name', 'Id_Number__c', 'Email'], normalize: { caseFold: true, trim: true } };
const rec = (Id, Name, Id_Number__c, Email) => ({ Id, Name, Id_Number__c, Email });

describe('the components as evidence', () => {
  it('parts: normalized, empty as ""', () => {
    expect(sftkMatchParts(rec('a', ' Acme ', null, 'X@Y.com'), M)).toEqual(['acme', '', 'x@y.com']);
  });
  it('score: anchor must agree; a component both hold must agree; an empty one says nothing', () => {
    expect(sftkTieredScore(['acme', '1', 'e'], ['acme', '1', 'e'])).toBe(3);
    expect(sftkTieredScore(['acme', '1', ''], ['acme', '1', 'e'])).toBe(2);
    expect(sftkTieredScore(['acme', '', ''], ['acme', '1', 'e'])).toBe(1);
    expect(sftkTieredScore(['acme', '2', ''], ['acme', '1', 'e'])).toBe(-1);   // both hold it, different
    expect(sftkTieredScore(['', '1', 'e'], ['', '1', 'e'])).toBe(-1);          // no anchor
    expect(sftkTieredScore(['acme'], ['beta'])).toBe(-1);
  });
  it('pick: the best agreeing candidate, never a tie', () => {
    const cands = [['acme', '', ''], ['acme', '1', ''], ['acme', '2', '']];
    expect(sftkTieredPick(['acme', '1', 'e'], cands)).toBe(1);
    expect(sftkTieredPick(['acme', '', ''], cands)).toBe(-1);                  // three agree equally
    expect(sftkTieredPick(['acme', '3', ''], cands)).toBe(0);                  // only the blank-id one is compatible
    expect(sftkTieredPick(['zeta', '1', ''], cands)).toBe(-1);
  });
});

describe('the pairing: most specific first, fall back to the fields a record has', () => {
  it("100% names, 90% id numbers: records with the id match on both, the others on the name alone", () => {
    const src = [rec('s1', 'Acme', '1', ''), rec('s2', 'Acme', '2', ''), rec('s3', 'Beta', '', ''), rec('s4', 'Gamma', '7', '')];
    const tgt = [rec('t1', 'Acme', '1', ''), rec('t2', 'Acme', '2', ''), rec('t3', 'Beta', '9', ''), rec('t4', 'Delta', '', '')];
    const r = sftkTieredPairs(src, tgt, M, M);
    const pairs = r.pairs.map(([, s, t]) => `${s.Id}→${t.Id}`).sort();
    expect(pairs).toEqual(['s1→t1', 's2→t2', 's3→t3']);   // Beta: the source has no id, the target's id says nothing against it
    expect(r.inserts.map(([, s]) => s.Id)).toEqual(['s4']);
    expect(r.extras.map(([, t]) => t.Id)).toEqual(['t4']);
    expect(r.groups.size).toBe(0);
  });
  it('a value that differs on both sides rules the pair out: it is an insert, the target an extra', () => {
    const r = sftkTieredPairs([rec('s1', 'Acme', '1', '')], [rec('t1', 'Acme', '2', '')], M, M);
    expect(r.pairs).toEqual([]);
    expect(r.inserts.map(([, s]) => s.Id)).toEqual(['s1']);
    expect(r.extras.map(([, t]) => t.Id)).toEqual(['t1']);
  });
  it('the more specific claim wins the target; the vaguer source becomes an insert', () => {
    const r = sftkTieredPairs([rec('s1', 'Acme', '', ''), rec('s2', 'Acme', '1', '')], [rec('t1', 'Acme', '1', '')], M, M);
    expect(r.pairs.map(([, s, t]) => `${s.Id}→${t.Id}`)).toEqual(['s2→t1']);
    expect(r.inserts.map(([, s]) => s.Id)).toEqual(['s1']);
    expect(r.groups.size).toBe(0);
  });
  it('two sources that want the same target equally are not guessed: one ⚠ group per anchor', () => {
    const r = sftkTieredPairs([rec('s1', 'Acme', '', ''), rec('s2', 'Acme', '', '')], [rec('t1', 'Acme', '1', '')], M, M);
    expect(r.pairs).toEqual([]);
    const g = r.groups.get('acme');
    expect(g.srcs.map(x => x.Id)).toEqual(['s1', 's2']);
    expect(g.tgts.map(x => x.Id)).toEqual(['t1']);
  });
  it('two targets that agree equally well with one source: the group holds both candidates', () => {
    const r = sftkTieredPairs([rec('s1', 'Acme', '', 'a@x.com')], [rec('t1', 'Acme', '1', ''), rec('t2', 'Acme', '2', '')], M, M);
    expect(r.pairs).toEqual([]);
    expect(r.groups.get('acme').tgts.map(x => x.Id)).toEqual(['t1', 't2']);
  });
  it('settling the best claim frees the rest: a full match first, then the next best', () => {
    const src = [rec('s1', 'Acme', '1', 'a@x.com'), rec('s2', 'Acme', '1', '')];
    const tgt = [rec('t1', 'Acme', '1', ''), rec('t2', 'Acme', '1', 'a@x.com')];
    const r = sftkTieredPairs(src, tgt, M, M);
    expect(r.pairs.map(([, s, t]) => `${s.Id}→${t.Id}`).sort()).toEqual(['s1→t2', 's2→t1']);
  });
  it('an empty anchor is a blank key, counted, never matched', () => {
    const r = sftkTieredPairs([rec('s1', '', '1', '')], [rec('t1', '', '1', '')], M, M);
    expect(r.blankSrc).toBe(1); expect(r.blankTgt).toBe(1); expect(r.pairs).toEqual([]);
  });
  it('the pair key is the source record\'s own full key', () => {
    const r = sftkTieredPairs([rec('s1', 'Acme', '1', '')], [rec('t1', 'Acme', '', '')], M, M);
    expect(r.pairs[0][0]).toBe(['acme', '1', ''].join(String.fromCharCode(1)));
  });
});

describe('the flag travels with the node and the scan', () => {
  it('sftkMatchingFromNode: tiered only for a composite key that says so', () => {
    expect(sftkMatchingFromNode({ matching: { strategy: 'composite', fields: ['Name', 'Email'], tiered: true } }).tiered).toBe(true);
    expect(sftkMatchingFromNode({ matching: { strategy: 'composite', fields: ['Name', 'Email'] } }).tiered).toBe(false);
    expect(sftkMatchingFromNode({ matching: { strategy: 'field', fields: ['Name'], tiered: true } }).tiered).toBe(false);
  });
  it('the scan branches on it, keeps the blank counts, and stores it with the matching it used', () => {
    const SC = readFileSync(new URL('../studio-scan.js', import.meta.url), 'utf8');
    expect(SC).toContain("if (srcMatching.tiered && typeof sftkTieredPairs === 'function') {");
    expect(SC).toContain('for (const [anchor, g] of tp.groups) { _ambKeys.push(anchor); _sGrp.set(anchor, g.srcs); _tGrp.set(anchor, g.tgts); }');
    expect(SC).toContain('...(srcMatching.tiered ? { tiered: true } : {})');
    expect(SC).toContain('tiered: nodeMatching.tiered === true && srcKeyFields.length > 1');
  });
  it('a relink picks the parent the same way: best agreeing candidate, never a tie', () => {
    const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
    expect(RC).toContain('const pmTiered = pm?.tiered === true && pmSrcFields.length > 1;');
    expect(RC).toContain('const at = sftkTieredPick(want, cands.map(x => x.parts));');
    expect(RC).toContain('pid = at >= 0 ? cands[at].id : null;');
  });
});

describe('what the key reads like', () => {
  it('labels joined, and the fallback in words when tiered', () => {
    const r = sftkMatchingReadsAs(['Account Name', 'ID Number', 'Email'], true);
    expect(r.key).toBe('Account Name + ID Number + Email');
    expect(r.how).toContain('a record with all 3 values is matched on all 3');
    expect(r.how).toContain('one without Email on Account Name + ID Number');
    expect(r.how).toContain('one with only Account Name is matched on Account Name alone');
    expect(sftkMatchingReadsAs(['Account Name', 'Email'], false).how).toBe('Two records are the same only when all 2 values are present and equal.');
    expect(sftkMatchingReadsAs(['Account Name'], true).how).toBe('Two records are the same when their Account Name is equal.');
  });
});

// Through the real scan: a composite key Name + Id_Number__c, most specific first.
describe('runDiffScan with a tiered key', () => {
  const scan = extractFunctions('studio-scan.js', [
    'runDiffScan', 'deriveScanConfig', 'buildLookupCompareMap', '_lookupSelectExpr', '_lookupResolvedVal', 'sftkPhantomStateCountry',
    'sftkEngineCompareSet', 'sftkParentScopeCap', 'sftkParentScopeNote', 'sftkOrphanLabel', 'sftkOrphanCapNote', 'sftkBucketCap', 'sftkBucketCapNote',
    'sftkScanBucketInfo', 'sftkBucketCapShipped', 'sftkBucketCountLabel', 'sftkMultiSelNorm',
  ], { 'sftk-matching.js': [
    'sftkMatchingFromNode', 'sftkMatchingFields', 'sftkMatchingTgtFields', 'sftkMatchKey', 'sftkPathValue', 'sftkNormalizeValue',
    'sftkNearMissFold', 'sftkNearMissReason', 'sftkMatchKeyLabel', 'sftkScanKeyClasses', 'sftkMatchParts', 'sftkTieredScore', 'sftkTieredPairs',
  ] });
  const SRC_ORG = 'https://six.develop.my.salesforce.com', TGT_ORG = 'https://seven.develop.my.salesforce.com';
  const f = (name, type, extra) => Object.assign({ name, label: name, type, createable: true, updateable: true, nillable: true, length: 255, referenceTo: [] }, extra || {});
  const DESC = { name: 'Account', fields: [f('Id', 'id', { createable: false }), f('Name', 'string', { nameField: true }), f('Id_Number__c', 'string'), f('City__c', 'string')] };
  const run = async (src, tgt, tiered) => {
    globalThis._orgKey = u => String(u || '').toLowerCase(); globalThis.orgLabel = u => u;
    globalThis._buildAllSessions = () => ([{ orgUrl: SRC_ORG, sid: 'S' }, { orgUrl: TGT_ORG, sid: 'T' }]);
    globalThis._resolveSession = (url, all) => all.find(s => s.orgUrl === url) || null;
    globalThis.describe = async () => DESC; globalThis.window = {};
    globalThis.sendBg = async msg => { const q = String(msg.query || ''); if (/= null/.test(q)) return { records: [], totalSize: 0, done: true }; const rows = msg.orgUrl === SRC_ORG ? src : tgt; return { records: rows.map(r => ({ ...r })), totalSize: rows.length, done: true }; };
    try {
      const p = { id: 'pt', name: 't', sourceOrg: SRC_ORG, targetOrg: TGT_ORG, scanConfig: { matchField: 'Name', compareFields: ['City__c'] },
        tree: { objectType: 'Account', where: '', children: [], matching: { strategy: 'composite', fields: ['Name', 'Id_Number__c'], normalize: {}, tiered } } };
      const res = await scan.runDiffScan(p, p.tree, null);
      expect(res.error, res.error).toBeFalsy();
      const where = id => ['missingInTarget', 'changed', 'identical', 'onlyInTarget', 'ambiguous'].filter(b => (res[b] || []).some(r => r.sourceId === id || (b === 'onlyInTarget' && r.targetId === id)));
      return { res, where };
    } finally { for (const k of ['_orgKey', 'orgLabel', '_buildAllSessions', '_resolveSession', 'describe', 'window', 'sendBg']) delete globalThis[k]; }
  };
  const SRC = [{ Id: 'S1', Name: 'Acme', Id_Number__c: '1', City__c: 'Haifa' }, { Id: 'S2', Name: 'Beta', Id_Number__c: '', City__c: 'Eilat' }, { Id: 'S3', Name: 'Gamma', Id_Number__c: '3', City__c: 'X' }];
  const TGT = [{ Id: 'T1', Name: 'Acme', Id_Number__c: '1', City__c: 'Haifa' }, { Id: 'T2', Name: 'Beta', Id_Number__c: '2', City__c: 'Eilat' }, { Id: 'T3', Name: 'Gamma', Id_Number__c: '9', City__c: 'X' }];
  it('tiered: Acme pairs on both fields, Beta on the name alone (the source has no number), Gamma is a different record', async () => {
    const { res, where } = await run(SRC, TGT, true);
    expect(where('S1')).toEqual(['identical']);
    expect(where('S2')).toEqual(['identical']);
    expect(where('S3')).toEqual(['missingInTarget']);
    expect(where('T3')).toEqual(['onlyInTarget']);
    expect(res.matching.tiered).toBe(true);
  });
  it('not tiered: the same data makes Beta an insert and its target an extra', async () => {
    const { where, res } = await run(SRC, TGT, false);
    expect(where('S2')).toEqual(['missingInTarget']);
    expect(where('T2')).toEqual(['onlyInTarget']);
    expect(res.matching.tiered).toBeUndefined();
  });
  it('tiered, two sources with the same name and no number against one target: ⚠ Needs a decision, grouped by the name', async () => {
    const { res, where } = await run([{ Id: 'S1', Name: 'Acme', Id_Number__c: '', City__c: 'A' }, { Id: 'S2', Name: 'Acme', Id_Number__c: '', City__c: 'B' }], [{ Id: 'T1', Name: 'Acme', Id_Number__c: '1', City__c: 'A' }], true);
    expect(where('S1')).toEqual(['ambiguous']); expect(where('S2')).toEqual(['ambiguous']);
    expect(res.ambiguous.find(r => r.sourceId === 'S1')).toMatchObject({ candidates: ['T1'], twins: ['S2'] });
    expect(res.ambiguous[0].matchKey).toBe('Acme');
  });
});
