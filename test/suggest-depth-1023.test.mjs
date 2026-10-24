import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';
import { readFileSync } from 'node:fs';

// User 2026-10-23: "we should suggest keys like this when selecting composite and also ask how many
// levels from 1 to 4 the user would like the suggestion to be. when its only 1 field we just show
// how many records have value for the one matching field in both orgs".
const { sftkMatchSuggestionsOfDepth, sftkTierCoverage, sftkTieredPreview } =
  extractFunctions('sftk-matching.js', ['sftkMatchSuggestionsOfDepth', 'sftkTierCoverage', 'sftkTieredPreview', 'sftkMatchParts', 'sftkTieredPairs', 'sftkTieredScore', 'sftkNormalizeValue', 'sftkPathValue']);

const f = (name, type, extra) => Object.assign({ name, label: name, type, createable: true, nillable: true, length: 80, referenceTo: [] }, extra || {});
const FIELDS = [
  f('Id', 'id'), f('Name', 'string', { nameField: true }), f('Email', 'email'), f('Phone', 'phone'),
  f('Id_Number__c', 'string'), f('BillingCity', 'string'), f('Description', 'textarea', { length: 32000 }),
  f('Ext__c', 'string', { externalId: true }), f('OwnerId', 'reference', { referenceTo: ['User'], relationshipName: 'Owner' }),
  f('ParentId', 'reference', { referenceTo: ['Account'], relationshipName: 'Parent' }),
];

describe('suggestions of a depth', () => {
  it('depth 1: one field each — external ID, the name, e-mail, phone, numbers and codes', () => {
    const s = sftkMatchSuggestionsOfDepth(FIELDS, 1);
    expect(s.map(x => x.fields.join())).toEqual(['Ext__c', 'Name', 'Email', 'Phone', 'Id_Number__c', 'BillingCity']);
    expect(s[0].strategy).toBe('externalId'); expect(s[1].strategy).toBe('field');
    expect(s.every(x => !x.tiered)).toBe(true);
  });
  it('depth 3: the name first, the best two others, then variants swapping the last — all most specific first', () => {
    const s = sftkMatchSuggestionsOfDepth(FIELDS, 3);
    expect(s[0].fields).toEqual(['Name', 'Ext__c', 'Email']);
    expect(s[0].strategy).toBe('composite'); expect(s[0].tiered).toBe(true);
    expect(s[0].normalize).toMatchObject({ caseFold: true, trim: true, emailLower: true });
    expect(s[1].fields).toEqual(['Name', 'Ext__c', 'Phone']);
    expect(s.every(x => x.fields.length === 3 && x.fields[0] === 'Name' && x.tiered)).toBe(true);
    expect(s.length).toBeLessThanOrEqual(6);
  });
  it('person-account fields rank last at every depth (they exist only on person accounts, often not in the other org)', () => {
    const withPerson = [...FIELDS, f('PersonEmail', 'email'), f('PersonMobilePhone', 'phone')];
    const one = sftkMatchSuggestionsOfDepth(withPerson, 1).map(x => x.fields[0]);
    expect(one.indexOf('Email')).toBeLessThan(one.indexOf('PersonEmail'));
    expect(one.indexOf('Phone')).toBeLessThan(one.indexOf('PersonEmail'));
    const three = sftkMatchSuggestionsOfDepth(withPerson, 3);
    expect(three[0].fields).toEqual(['Name', 'Ext__c', 'Email']);
    expect(three.slice(0, 3).some(x => x.fields.some(n => /^Person/.test(n)))).toBe(false);
  });
  it('a key with a field nobody fills is named and costs points', () => {
    const M2 = readFileSync(new URL('../studio-builder-modals.js', import.meta.url), 'utf8');
    expect(M2).toContain('if (weak.length && typeof s.score === \'number\') s.score = Math.max(0, s.score - 30 * weak.length);');
    expect(M2).toContain('adds almost nothing to the key');
  });
  it('depth 2 with a phone component normalizes digits; a depth above 4 is clamped', () => {
    const s = sftkMatchSuggestionsOfDepth([f('Name', 'string', { nameField: true }), f('Phone', 'phone')], 2);
    expect(s[0].fields).toEqual(['Name', 'Phone']); expect(s[0].normalize.phoneDigits).toBe(true);
    expect(sftkMatchSuggestionsOfDepth(FIELDS, 9)[0].fields.length).toBe(4);
  });
  it('no anchor and nothing to add: no composite suggestion', () => {
    expect(sftkMatchSuggestionsOfDepth([f('Id', 'id')], 2)).toEqual([]);
    expect(sftkMatchSuggestionsOfDepth([f('Name', 'string', { nameField: true })], 2)).toEqual([]);
  });
});

describe('what the grades say', () => {
  it('coverage up to each field', () => {
    const recs = [{ Name: 'a', Id_Number__c: '1', Email: 'e' }, { Name: 'b', Id_Number__c: '2', Email: '' }, { Name: 'c', Id_Number__c: '', Email: 'x' }, { Name: '', Id_Number__c: '9', Email: 'y' }];
    const cov = sftkTierCoverage(recs, { fields: ['Name', 'Id_Number__c', 'Email'], normalize: {} });
    expect(cov.total).toBe(4);
    expect(cov.levels.map(l => `${l.field}:${l.populated}`)).toEqual(['Name:3', 'Id_Number__c:2', 'Email:1']);
  });
  it('the tiered cross-org preview counts the pairing the scan would make', () => {
    const src = [['acme', '1'], ['beta', ''], ['gamma', '3'], ['', '4'], ['dup', ''], ['dup', '']];
    const tgt = [['acme', '1'], ['beta', '2'], ['gamma', '9'], ['dup', '1']];
    const p = sftkTieredPreview(src, tgt);
    expect(p).toEqual({ sourceTotal: 6, matchedUnique: 2, ambiguous: 2, unmatched: 2 });   // acme + beta pair; gamma differs, the blank one; dup twice → a decision
  });
});

describe('the panel', () => {
  const M = readFileSync(new URL('../studio-builder-modals.js', import.meta.url), 'utf8');
  it('asks how many fields, rebuilds the list on the answer, and Use carries the tiers', () => {
    expect(M).toContain("let matchSuggestDepth = matchStrategy === 'composite' ? Math.min(4, Math.max(1, matchFields.length)) : 1;");
    expect(M).toContain('<span class="ds-rec-display-lbl">How many fields in the key?</span>');
    expect(M).toContain('data-match-depth="${n}"');
    expect(M).toContain('suggestions = _suggestionsAt(matchSuggestDepth);');
    expect(M).toContain('matchTiered    = s.tiered === true;');
    expect(M).toContain("one field: how many records hold a value for it, in both orgs");
  });
  it('the grades say how many records hold the key, up to each field, and preview a tiered key as the scan pairs', () => {
    expect(M).toContain('async function sftkAnalyzeMatchKey(objType, profile, srcFields, tgtFields, normalize, strategy, tiered)');
    expect(M).toContain("if (flds.length > 1 && typeof sftkTierCoverage === 'function') counts.tiers = sftkTierCoverage(");
    expect(M).toContain("? { ...sftkTieredPreview(out.src.parts, out.tgt.parts), tiered: true }");
    expect(M).toContain("['hold a value', (st, k) => `<strong>${n(st.populated)}</strong> of ${n(st.total)}");
    expect(M).toContain("rows.push(['up to each field', (st, k) => k.tiers ? k.tiers.levels.map(");
    expect(M).toContain("s.normalize || {}, s.strategy, s.tiered === true);");
    expect(M).toContain("m.normalize, m.strategy, m.tiered === true);");
  });
});

// 2026-10-24: "why is the expect mismatches? if we do email + id + phone number it should be even more
// unique" — the verdict judges the key on each side, never how many source records the target holds.
describe('the verdict judges the key, not the target\'s size', () => {
  const { _matchKeyVerdict, _matchWouldHtml } = extractFunctions('studio-builder-modals.js', ['_matchKeyVerdict', '_matchWouldHtml'], { 'sftk-matching.js': ['sftkKeyStats'] });
  const counts = (total, blank, dupPairs) => { const keyCounts = new Map(); let i = 0; for (; i < dupPairs; i++) keyCounts.set('d' + i, 2); for (let u = 0; u < total - blank - dupPairs * 2; u++) keyCounts.set('u' + u, 1); return { keyCounts, total, blank }; };
  it('2,000 source records, 22 in the target, both fully populated and unique: a strong key', () => {
    const v = _matchKeyVerdict([{ label: 'Source', counts: counts(2000, 0, 29) }, { label: 'Target', counts: counts(22, 0, 0) }]);
    expect(v.label).toBe('Strong key'); expect(v.score).toBe(97); expect(v.why).toBe('58 share a key in Source');
  });
  it('a side with many blanks makes the key weak, and says which side', () => {
    const v = _matchKeyVerdict([{ label: 'Source', counts: counts(100, 0, 0) }, { label: 'Target', counts: counts(100, 60, 0) }]);
    expect(v.label).toBe('Weak key'); expect(v.why).toBe('60 blank in Target');
  });
  it('a side that did not answer is left out; none graded → null', () => {
    expect(_matchKeyVerdict([{ label: 'Source', counts: counts(10, 0, 0) }, { label: 'Target', err: 'closed' }]).label).toBe('Strong key');
    expect(_matchKeyVerdict([{ label: 'Source', err: 'x' }])).toBeNull();
  });
  it('the cross-org line counts pairs, inserts and decisions — no verdict in it', () => {
    globalThis.esc = x => x;
    const h = _matchWouldHtml({ cross: { sourceTotal: 2000, matchedUnique: 2, unmatched: 1998, ambiguous: 0, tiered: true } });
    delete globalThis.esc;
    expect(h).toContain('would pair <strong>2</strong> of 2,000 source records');
    expect(h).toContain('<strong>1,998</strong> new in the target');
    expect(h).not.toMatch(/mismatch|weak/i);
  });
});

describe('a new depth while the first grades still run (found 2026-10-24)', () => {
  const M3 = readFileSync(new URL('../studio-builder-modals.js', import.meta.url), 'utf8');
  it('the running loop stops at the old list and the new list is graded once more', () => {
    expect(M3).toContain("if (_autoGradeActive) { _autoGradeAgain = true; return; }");
    expect(M3).toContain("if (!matchSuggestOpen || suggestions !== mine) break;");
    expect(M3).toContain("if (_autoGradeAgain) { _autoGradeAgain = false; _autoGradeTop(); }");
  });
});
