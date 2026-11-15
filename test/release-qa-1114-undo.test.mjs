// Release QA 2026-11-14 — ↩ Rollback. A rollback of a SUBSET of the plan
// (records, a whole object or the Kept parents unticked) used to mark the run
// "Rolled back and verified" and disable its only rollback button, while the
// unpicked records still held the run's inserts and overwrites. Verified is
// scoped to what was acted on; the run closes only when the plan was covered.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const F = extractFunctions('sftk-undo.js', ['sftkUndoPickCoverage', 'sftkUndoCardState', 'sftkUndoRunWrote']);
const UN = readFileSync(new URL('../studio-undo.js', import.meta.url), 'utf8');
const RB = readFileSync(new URL('../studio-rollback.js', import.meta.url), 'utf8');

const ids = (p, n) => Array.from({ length: n }, (_, i) => `${p}${i}`);
const item = (created, changed, keptIds = [], refused = null) =>
  ({ refused, scoped: { created, changed: changed.map(id => ({ id })) }, keptIds });
// Mirrors sftkUndoExecute's `work` mapping for a pick.
const act = (it, del, res, force = []) => ({ item: it,
  created: it.scoped.created.filter(id => del.includes(id)).concat((it.keptIds || []).filter(id => force.includes(id))),
  changed: it.scoped.changed.filter(c => res.includes(c.id)) });

describe('sftkUndoPickCoverage — measured against the plan, not the picks', () => {
  it('3 of 200 created records picked is NOT complete: 197 left in place', () => {
    const a = item(ids('a', 200), []);
    const c = F.sftkUndoPickCoverage([a], [act(a, ['a0', 'a1', 'a2'], [])]);
    expect(c).toMatchObject({ planned: 200, acted: 3, left: 197, complete: false });
  });

  it('a whole object unticked is NOT complete', () => {
    const a = item(['a1'], ['a2']); const b = item(['b1'], []);
    const c = F.sftkUndoPickCoverage([a, b], [act(a, ['a1'], ['a2']), act(b, [], [])]);
    expect(c.left).toBe(1); expect(c.complete).toBe(false);
  });

  it('every planned record acted on IS complete', () => {
    const a = item(['a1', 'a3'], ['a2']); const b = item([], ['b1']);
    const c = F.sftkUndoPickCoverage([a, b], [act(a, ['a1', 'a3'], ['a2']), act(b, [], ['b1'])]);
    expect(c).toMatchObject({ planned: 4, acted: 4, left: 0, complete: true });
  });

  it('Kept parents count as left in place unless "delete anyway" picked them', () => {
    const a = item(['a1'], [], ['k1', 'k2']);
    const kept = F.sftkUndoPickCoverage([a], [act(a, ['a1'], [])]);
    expect(kept).toMatchObject({ left: 2, kept: 2, complete: false });
    const forced = F.sftkUndoPickCoverage([a], [act(a, ['a1'], [], ['k1', 'k2'])]);
    expect(forced).toMatchObject({ left: 0, kept: 0, complete: true });
  });

  it('a refused item is not counted here (the refusal already keeps the status below success)', () => {
    const a = item(['a1'], []); const r = item(['r1'], [], [], 'no access');
    expect(F.sftkUndoPickCoverage([a, r], [act(a, ['a1'], []), { item: r, created: [], changed: [] }]).complete).toBe(true);
  });
});

describe('sftkUndoExecute — a partial pick never closes the run', () => {
  const exec = UN.slice(UN.indexOf('async function sftkUndoExecute('), UN.indexOf('\nwindow.rollbackRun'));
  it('measures coverage against the plan before writing anything', () => {
    expect(exec).toContain('const coverage = sftkUndoPickCoverage(plan, work);');
    expect(exec.indexOf('sftkUndoPickCoverage(plan, work)')).toBeLessThan(exec.indexOf("'SF_COLLECTIONS_DELETE'"));
  });
  it('a verified subset is recorded as partial, so rolledBackAt is not set', () => {
    expect(exec).toContain("const status = verified === 'success' && !coverage.complete ? 'partial' : verified;");
    expect(exec).toMatch(/if \(status === 'success'\) \{ h\.undo\.rolledBackAt = now/);
    expect(exec).toContain('h.undo.lastRollbackStatus = status + leftNote;');
    expect(exec).toContain('record(s) left in place');
  });
  it('the result card says how many were left in place', () => {
    expect(RB).toContain('res.coverage && res.coverage.left');
  });
});

describe('sftkUndoCardState — the History card after a partial pick', () => {
  const run = { undo: { status: 'ready', objects: ['Account'], lastRollbackStatus: 'partial — 197 of 200 record(s) left in place', lastRollbackAt: '2026-11-14T10:00:00Z' } };
  it('stays enabled, keeps the label short, and the title says how many were left in place', () => {
    const st = F.sftkUndoCardState(run);
    expect(st.disabled).toBe(false);
    expect(st.label).toBe('↩ Roll back again (last attempt: partial)');
    expect(st.title).toContain('197 of 200 record(s) left in place');
    expect(st.title).toContain('2026-11-14T10:00:00Z');
  });
  it('a complete rollback still closes the card', () => {
    expect(F.sftkUndoCardState({ undo: { status: 'ready', rolledBackAt: '2026-11-14' } }).disabled).toBe(true);
  });
});
