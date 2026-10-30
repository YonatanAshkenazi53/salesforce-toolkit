// 2026-10-30 — the merge dialog with MANY copies (user, twelve copies of one Account: "not a
// good experience" / "you can't know who is the owner" / "its hard to understand a bit").
// The copies are rows; each differing field shows its distinct values with the copies that
// hold each; a lookup's id is shown with the record's name; the suggested survivor is the
// fullest copy, the oldest on a tie.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const M = readFileSync(new URL('../sftk-merge.js', import.meta.url), 'utf8');
const DV = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../studio.css', import.meta.url), 'utf8');

const slice = (src, name) => { const i = src.indexOf(`function ${name}(`); const j = src.indexOf('\nfunction ', i + 10); const k = src.indexOf('\nasync function ', i + 10); const e = [j, k].filter(x => x > 0).sort((a, b) => a - b)[0]; return src.slice(i, e > 0 ? e : undefined); };
const names = ['_sftkMergeNorm', 'sftkMergeValueGroups', 'sftkMergeSuggestKeep', 'sftkMergeRefPlan'];
const F = new Function(`${names.map(n => slice(M, n)).join('\n')}\nreturn { ${names.join(', ')} };`)();

describe('sftkMergeValueGroups: twelve copies with two owners are two choices', () => {
  it('groups by value, first appearance first, every copy listed under its value', () => {
    const g = F.sftkMergeValueGroups(['a', 'b', 'a', 'a', 'b']);
    expect(g).toEqual([{ value: 'a', idx: [0, 2, 3] }, { value: 'b', idx: [1, 4] }]);
  });
  it('null and undefined are one empty value; a number and its string are one value', () => {
    expect(F.sftkMergeValueGroups([null, undefined, '']).length).toBe(1);
    expect(F.sftkMergeValueGroups([5, '5']).length).toBe(1);
  });
  it('not an array → nothing', () => { expect(F.sftkMergeValueGroups(null)).toEqual([]); });
});

describe('sftkMergeSuggestKeep: the fullest copy, the oldest on a tie', () => {
  const fields = [{ name: 'A' }, { name: 'B' }];
  it('the copy with the most fields filled', () => {
    expect(F.sftkMergeSuggestKeep([{ A: 1 }, { A: 1, B: 2 }, { B: 1 }], fields)).toBe(1);
  });
  it('a tie goes to the oldest', () => {
    expect(F.sftkMergeSuggestKeep([{ A: 1, CreatedDate: '2026-08-22' }, { A: 2, CreatedDate: '2026-06-17' }], fields)).toBe(1);
  });
  it('empty strings do not count as filled; no copies → 0', () => {
    expect(F.sftkMergeSuggestKeep([{ A: '' }, { A: 'x' }], fields)).toBe(1);
    expect(F.sftkMergeSuggestKeep([], fields)).toBe(0);
  });
});

describe('sftkMergeRefPlan: which records to read by name', () => {
  const fields = [
    { name: 'OwnerId', type: 'reference', referenceTo: ['Group', 'User'] },
    { name: 'ParentId', type: 'reference', referenceTo: ['Account'] },
    { name: 'Website', type: 'url' },
  ];
  it('a polymorphic owner is split by the id prefix; a plain lookup by its object; text fields are not read', () => {
    const diff = { differ: [
      { name: 'OwnerId', values: ['005dL00001nlcIEQA0', '005dL00001nfv0nQAA', '00GdL00000XFRw9UAH', '005dL00001nfv0nQAA'] },
      { name: 'ParentId', values: ['001dL00000AAAAAAAA', null] },
      { name: 'Website', values: ['a', 'b'] },
    ] };
    const plan = F.sftkMergeRefPlan(diff, fields);
    expect(plan).toEqual([
      { obj: 'User', ids: ['005dL00001nlcIEQA0', '005dL00001nfv0nQAA'] },
      { obj: 'Group', ids: ['00GdL00000XFRw9UAH'] },
      { obj: 'Account', ids: ['001dL00000AAAAAAAA'] },
    ]);
  });
  it('an id whose object cannot be told is left out; a non-id value is left out', () => {
    const diff = { differ: [{ name: 'OwnerId', values: ['0XXdL00001nlcIEQA0', 'not-an-id'] }] };
    expect(F.sftkMergeRefPlan(diff, fields)).toEqual([]);
  });
});

describe('the dialog: copies as rows, a field as its distinct values, the lookup as a name', () => {
  const flow = DV.slice(DV.indexOf('async function _depMergeCopies('), DV.indexOf('async function _depRescan('));
  it('reads the names behind the lookup ids before drawing, and shows the name with the id', () => {
    expect(flow).toContain('const names = await sftkMergeRefNames({ send: sendBg, orgUrl: sess.orgUrl, sid: sess.sid, plan: sftkMergeRefPlan(diff, desc.fields) });');
    expect(flow).toContain('return names[t] ? `${esc(names[t])} <span class="ds-dep-muted">${esc(t)}</span>` : esc(t);');
  });
  it('one row per copy with its radio, chips, dates, open link and "take all its values"; the suggested copy is ticked', () => {
    expect(flow).toContain('const keep0 = sftkMergeSuggestKeep(recs, okFields);');
    expect(flow).toMatch(/<div class="ds-merge-copy\$\{i === keep0 \? ' ds-merge-keep' : ''\}" data-merge-copy="\$\{i\}">/);
    expect(flow).toContain('<input type="radio" name="dsMergeKeep" value="${i}" ${i === keep0 ? \'checked\' : \'\'}> Copy ${i + 1}</label>');
    expect(flow).toContain('💡 suggested');
    expect(flow).toContain('data-merge-useall="${i}" title="In every field below, tick this copy\'s value">⬇ take all its values</button>');
  });
  it('a differing field lists its DISTINCT values, each saying which copies hold it, plus the typed one', () => {
    expect(flow).toContain('sftkMergeValueGroups(f.values).map(g => `<label class="ds-merge-opt${g.idx.includes(keep0) ? \' ds-merge-opt-keep\' : \'\'}" data-merge-idx="${g.idx.join(\',\')}">');
    expect(flow).toContain("const who = idx => idx.length === recs.length ? 'every copy' : idx.length === 1 ? `copy ${idx[0] + 1}` : `${idx.length} copies: ${idx.map(i => i + 1).join(', ')}`;");
    expect(flow).toMatch(/data-merge-custom="\$\{esc\(f\.name\)\}"/);
    expect(flow).not.toContain('ds-merge-col');   // no more one-column-per-copy table
  });
  it('the two steps are said in words; "1 field differs" is grammatical', () => {
    expect(flow).toContain('<b>1 · Which record stays?</b>');
    expect(flow).toContain('<b>2 · What it is written with.</b>');
    expect(flow).toContain("field${diff.differ.length === 1 ? ' differs' : 's differ'}");
  });
  it('choosing the record that stays, or "take all its values", ticks the option whose copies include that copy', () => {
    expect(flow).toContain("const has = (el, i) => String(el.dataset.mergeIdx || '').split(',').map(Number).includes(i);");
    expect(flow).toContain("const takeAll = i => box.querySelectorAll('.ds-merge-frow').forEach(row => {");
    expect(flow).toContain("takeAll(Number(r.value)); paint();");
    expect(flow).toContain("box.querySelectorAll('.ds-merge-frow').forEach(tr => {");
  });
  it('the stylesheet draws the rows and options and marks the survivor\'s value', () => {
    for (const cls of ['.ds-merge-copies', '.ds-merge-copy.ds-merge-keep', '.ds-merge-frow', '.ds-merge-opt-keep .ds-merge-optn::after', '.ds-amb-chip-sug']) expect(CSS).toContain(cls);
  });
});
