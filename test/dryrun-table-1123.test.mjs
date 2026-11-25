// 2026-11-23, the owner on the Deploy page's dry run log (Account 113, Contact 201 + 4; 4 refused, 6 not checked):
//   "dry run is unreadable and hard to understand" / "why they are not part of the dry run?"
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { extractFunction } from './extract.mjs';
const rd = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const RC = rd('studio-reconcile.js'), BG = rd('background.js'), CSS = rd('studio.css');
const table = extractFunction('studio-reconcile.js', 'sftkProbeTable');
const skipped = extractFunction('studio-reconcile.js', 'sftkProbeSkippedLine');
const grab = name => { const a = RC.indexOf('function ' + name + '('); return RC.slice(a, RC.indexOf('\n}\n', a) + 3); };
const notes = new Function(grab('sftkProbeSkippedLine') + grab('sftkProbeTableNotes') + 'return sftkProbeTableNotes;')();

describe('the dry run as one table', () => {
  // the owner's run: the Contact counts of two steps (200 of a sample of 201, then 4 under existing parents) added up
  const byObj = {
    Account: { probed: 113, wouldWrite: 109, refused: 4, cascade: 0, unreached: 0, earlier: 0, sampledOf: 0 },
    Contact: { probed: 204, wouldWrite: 198, refused: 0, cascade: 6, unreached: 0, earlier: 0, sampledOf: 201 },
  };
  const t = table(byObj, { Account: 113, Contact: 205 });
  it('a row per object whose numbers add up, and a total that is the headline', () => {
    expect(t.rows).toEqual([
      { obj: 'Account', op: 'Insert', inRun: 113, would: 109, refused: 4, notChecked: 0, why: [], leftOut: 0 },
      { obj: 'Contact', op: 'Insert', inRun: 204, would: 198, refused: 0, notChecked: 6, why: ['6: the parent would be refused'], leftOut: 1 },
    ]);
    for (const r of t.rows) expect(r.would + r.refused + r.notChecked).toBe(r.inRun);
    expect(t.total).toEqual({ inRun: 317, would: 307, refused: 4, notChecked: 6 });   // "307 of 317 would be written — 4 refused, 6 not checked"
  });
  it('what was selected and is not in the run is said under the table, with the reason', () => {
    expect(t.leftOut).toEqual([{ obj: 'Contact', n: 1 }]);
    expect(notes(t, 200, ['2 relink(s)'])).toEqual([
      '1 more Contact selected and not checked: a dry run takes the first 200 records of an object in each step. The real run writes them all.',
      'Not checked by a dry run, and still selected for the real run: 2 relink(s).',
      'The real run can refuse more: a record that duplicates another record of this same run passes here, and a duplicate rule refuses it once the other one is written.',
    ]);
    expect(notes(table({ Account: { probed: 2, wouldWrite: 2 } }, { Account: 2 }), 200, [])).toEqual(['The real run can refuse more: a record that duplicates another record of this same run passes here, and a duplicate rule refuses it once the other one is written.']);
    expect(notes(table(null, null), 200, [])).toEqual([]);
  });
  it('a stopped run: what was never built counts as in the run and not checked', () => {
    const s = table({ Account: { probed: 0, wouldWrite: 0, unbuilt: 5 }, Case: { probed: 4, wouldWrite: 1, unbuilt: 3, earlier: 0 } }, { Account: 5, Case: 7 });
    expect(s.rows[0]).toMatchObject({ inRun: 5, would: 0, notChecked: 5, why: ['5: the dry run stopped before them'], leftOut: 0 });
    expect(s.rows[1]).toMatchObject({ inRun: 7, would: 1, notChecked: 3, leftOut: 0 });
    expect(s.total.inRun).toBe(12);
  });
  it('an object with nothing selected and nothing checked has no row; no objects, no table', () => {
    expect(table({ Task: { probed: 0 } }, { Task: 0 }).rows).toEqual([]);
    expect(table(null, null)).toEqual({ rows: [], total: { inRun: 0, would: 0, refused: 0, notChecked: 0 }, leftOut: [] });
  });
  it('the line about what a dry run leaves out says why', () => {
    expect(skipped(['2 delete(s)', '', '15 update(s)'])).toBe('Not checked by a dry run, and still selected for the real run: 2 delete(s) · 15 update(s).');
    expect(skipped([])).toBe('');
  });
});

describe('the page', () => {
  it('a dry run puts the table and the notes on top, folds the steps, and keeps an error line in sight', () => {
    expect(RC).toContain('{ table: ptab, notes: sftkProbeTableNotes(ptab, 200, probeSkipped), fold: true }');
    expect(RC).toContain("d.className = 'ds-prog-steps';");
    expect(RC).toContain("e.className = 'ds-prog-verdict-err';");
    expect(RC).toContain("if (!o.fold) { const more = document.createElement('div');");
    for (const c of ['.ds-probe-table {', '.ds-prog-steps {', '.ds-prog-verdict-err {', '.ds-prog-verdict-note {']) expect(CSS).toContain(c);
  });
  it('the engine notes are in plain words', () => {
    expect(RC).not.toContain('🔒 PII:');
    for (const old of ['PII masking applied', 'value(s) hashed', 'salt re-seeds', 'Collections call(s) instead of', 'lookups matched by Name in the target']) expect(BG).not.toContain(old);
    expect(BG).toContain('🎭 data blending: ');
    expect(BG).toContain('if (!useBulk && BATCH_SIZE !== 200 && !PROBE) {');
    expect(BG).toContain('these lookups are filled by finding the record with the same Name in the target: ');
  });
});
