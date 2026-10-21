// ⚠ Needs a decision (was "⚠ Ambiguous") — the tab explains itself AND makes
// each group decidable. User 2026-10-01: "what these means? insert as new,
// pair, etc. the user will have no idea what it means" → "we need a better
// help text"; 2026-10-03: "we need to make the ambigious page more
// understandble". Words alone were not enough: 350 rows of "Same as #1 ·
// Same as #2 · Same as #3" over records that look identical. Now the scan
// says which compared field tells the copies apart and suggests the pairs it
// can prove; the page groups by name and asks ONE question per record.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunction } from './extract.mjs';
const DV = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const SC = readFileSync(new URL('../studio-scan.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../studio.css', import.meta.url), 'utf8');
const insight = extractFunction('sftk-matching.js', 'sftkAmbiguousInsight');

describe('what tells the copies apart (pure)', () => {
  const fields = ['Phone', 'PersonBirthdate', 'BillingCity'];
  const g = (src, tgt) => [{ key: 'Michael Smith', src, tgt }];
  it('a field with one distinct value per copy on each side proves the pairs and is shown first', () => {
    const r = insight(g(
      [{ id: 's1', vals: ['555', '1990-03-12', 'Boston'] }, { id: 's2', vals: ['555', '1984-11-02', 'Austin'] }],
      [{ id: 't1', vals: ['555', '1984-11-02', 'Austin'] }, { id: 't2', vals: ['555', '1990-03-12', 'Boston'] }]), fields);
    expect(r.rows.get('s1')).toEqual({ tell: [['PersonBirthdate', '1990-03-12'], ['BillingCity', 'Boston']], suggest: 't2', by: 'PersonBirthdate' });
    expect(r.rows.get('s2').suggest).toBe('t1');
    expect(r.cands.get('t1')).toEqual([['PersonBirthdate', '1984-11-02'], ['BillingCity', 'Austin']]);
    expect(r.settled).toBe(2);
    expect(r.advice[0]).toEqual({ field: 'PersonBirthdate', groups: 1, records: 2 });
  });
  it('a field that is the same on every copy tells nothing and is not shown', () => {
    const r = insight(g([{ id: 's1', vals: ['555', '', ''] }, { id: 's2', vals: ['555', '', ''] }], [{ id: 't1', vals: ['555', '', ''] }]), fields);
    expect(r.rows.get('s1')).toEqual({ tell: [], suggest: undefined, by: undefined });
    expect(r.advice).toEqual([]);
  });
  it('a value that two copies share on one side proves nothing — no suggestion from that field', () => {
    const r = insight(g(
      [{ id: 's1', vals: ['1', 'A', ''] }, { id: 's2', vals: ['1', 'A', ''] }],
      [{ id: 't1', vals: ['1', 'A', ''] }, { id: 't2', vals: ['2', 'B', ''] }]), fields);
    expect(r.rows.get('s1').suggest).toBeUndefined();
    expect(r.rows.get('s2').suggest).toBeUndefined();
  });
  it('never suggests "new": a source copy with no matching value stays undecided, the proven one is suggested', () => {
    const r = insight(g(
      [{ id: 's1', vals: ['1', '', ''] }, { id: 's2', vals: ['9', '', ''] }],
      [{ id: 't1', vals: ['1', '', ''] }]), fields);
    expect(r.rows.get('s1').suggest).toBe('t1');
    expect(r.rows.get('s2').suggest).toBeUndefined();
    expect(r.advice[0]).toEqual({ field: 'Phone', groups: 0, records: 1 });   // not the whole group
  });
  it('an empty value never proves anything', () => {
    const r = insight(g([{ id: 's1', vals: ['', '', ''] }, { id: 's2', vals: ['7', '', ''] }], [{ id: 't1', vals: ['', '', ''] }, { id: 't2', vals: ['7', '', ''] }]), fields);
    expect(r.rows.get('s2').suggest).toBeUndefined();
  });
});

describe('the scan carries it', () => {
  it('rows get tell / suggest / suggestBy, candidates their telling values, the scan its advice — advisory, never failing a scan', () => {
    expect(SC).toContain('const ins = sftkAmbiguousInsight(groups, plan.map(p => p.srcField));');
    expect(SC).toContain('if (x.suggest) { row.suggest = x.suggest; row.suggestBy = x.by; }');
    expect(SC).toContain("...(Object.keys(ambiguousCand).length ? { ambiguousCand } : {}),");
    expect(SC).toContain("...(ambiguousAdvice.length ? { ambiguousAdvice } : {}),");
    expect(SC).toContain('} catch (_) { ambiguousAdvice = []; }');
  });
});

describe('the page', () => {
  it('is named for what the user must do, in the tab, the table and the advisor note', () => {
    expect(DV).toContain("label: '⚠ Needs a decision'");
    expect(DV).toContain('⚠ Needs a decision</th>');
    expect(DV).toContain('open <b>⚠ Needs a decision</b> below');
    expect(DV).not.toContain("label: '⚠ Ambiguous'");
  });
  it('an intro above the list: why, what to do, and how many are already filled in', () => {
    expect(DV).toContain("${tabDef.k === 'amb' && rows.length ? _depAmbIntro(p, isRoot, s) : ''}");
    const i = DV.indexOf('function _depAmbIntro(');
    const fn = DV.slice(i, DV.indexOf('\n}\n', i));
    expect(fn).toContain('Why these records are here.');
    expect(fn).toContain('Nothing here is deployed until it is settled.');
    expect(fn).toContain('Copies of the same record? Merge them.');          // 2026-10-21: merge first
    expect(fn).toContain('Different records that share a name? Say which is which.');
    expect(fn).toContain('are already filled in.');
    expect(fn).toContain('to how records are recognised (✏ Edit → Records → Matching)');
    // a child object cannot be chosen by hand — the intro says what to do instead
    expect(fn).toContain('give it a second match field (✏ Edit → Records → Matching)');
  });
  it('groups by the shared name: numbered target records with their telling values, one question per source record', () => {
    const i = DV.indexOf('function _depAmbGroupsHtml(');
    const fn = DV.slice(i, DV.indexOf('\n}\n', i));
    expect(fn).toContain('const k = keyOf(r); if (!groups.has(k)) groups.set(k, []);');
    expect(fn).toContain('<span class="ds-amb-n">#${i + 1}</span>${chips(candTell[t])}');
    expect(fn).toContain('data-dep-amb-sel="${esc(r.sourceId)}"');
    // 2026-10-05: the answers are sentences that carry the candidate's values (test/needs-decision-1005)
    expect(fn).toContain('Same record as #${i + 1} in ${orgLabel(p.targetOrg)}');
    expect(fn).toContain("— suggested: same ${r.suggestBy || 'value'}");
    expect(fn).toContain('yet — create it there as a new record');
    expect(fn).toContain('no compared field differs between the copies — they look like the same record; open them to be sure');
    expect(DV).toContain('(ambRoot ? _depAmbGroupsHtml(p, shown, s, ambPick, key, ambMem) : shown.map(rowHtml).join(\'\'))');
  });
  it('a remembered answer, else a suggestion, is the default pick; nothing is remembered until an Apply; one target record cannot be two source records', () => {
    expect(DV).toContain("const ambPick = r => _depAmbPick.has(r.sourceId) ? _depAmbPick.get(r.sourceId) : (ambMem(r) || r.suggest || '');");
    expect(DV).toContain('_depAmbPick.set(el.dataset.depAmbSel, el.value);');
    expect(DV).toContain('id="dsDepAmbApply"');
    expect(DV).toContain('one record there can be only one record here. Change one of them.');
    expect(DV).toContain('const sId = sftkAmbTwice(recs.map(r => [r.sourceId, ambPick(r)]));');
    // the picks belong to one scan of one pair
    expect(DV).toContain("if (ak !== _depAmbPickKey) { _depAmbPickKey = ak; _depAmbPick = new Map(); }");
  });
  it('the old row of pin links is gone', () => {
    expect(DV).not.toContain('data-dep-amb-pin=');
    expect(DV).not.toContain('data-dep-amb-new=');
    expect(DV).not.toContain('📌 Same as #');
  });
  it('styles exist', () => {
    expect(CSS).toContain('.ds-amb-group {');
    expect(CSS).toContain('.ds-amb-chip {');
  });
});
