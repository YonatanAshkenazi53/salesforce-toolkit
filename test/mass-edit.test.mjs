// W12 — MASS EDIT planner (user 2026-08-10: changing thousands of records
// "one by one manually" must become one validated, previewable, restorable
// operation). The planner is where the safety lives: a bad value fails the
// PLAN, not 3,000 rows; unchanged records are skipped so re-runs touch
// nothing; every planned update carries its BEFORE value for the CSV
// backup and the preview.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

const core = extractFunctions('studio-core.js', ['sftkMassEditPlan']);
const plan = core.sftkMassEditPlan;

const fd = (over) => Object.assign({
  name: 'Status__c', type: 'string', length: 80, updateable: true, nillable: true,
}, over || {});
const recs = [
  { Id: 'R1', Status__c: 'Old' },
  { Id: 'R2', Status__c: 'Active' },   // already the target value
  { Id: 'R3', Status__c: null },
];

describe('sftkMassEditPlan — validation fails the plan, not the rows', () => {
  it('plans updates only for records NOT already holding the value', () => {
    const p = plan(recs, fd(), 'Active', {});
    expect(p.ok).toBe(true);
    expect(p.updates.map(u => u.id)).toEqual(['R1', 'R3']);
    expect(p.unchanged).toBe(1);
    expect(p.updates[0].before).toBe('Old');   // feeds backup + preview
  });

  it('idempotent: re-running against already-set records plans nothing', () => {
    const done = recs.map(r => ({ ...r, Status__c: 'Active' }));
    const p = plan(done, fd(), 'Active', {});
    expect(p.updates).toHaveLength(0);
    expect(p.unchanged).toBe(3);
  });

  it('rejects a non-updateable field before anything runs', () => {
    const p = plan(recs, fd({ updateable: false }), 'Active', {});
    expect(p.ok).toBe(false);
    expect(p.errors.join()).toContain('not updateable');
  });

  it('length overflow is a plan error naming both numbers', () => {
    const p = plan(recs, fd({ length: 3 }), 'Active', {});
    expect(p.ok).toBe(false);
    expect(p.errors.join()).toContain('at most 3');
  });

  it('checkbox takes only true/false; numbers must parse; ints must be whole', () => {
    expect(plan(recs, fd({ type: 'boolean' }), 'yes', {}).ok).toBe(false);
    expect(plan(recs, fd({ type: 'boolean' }), 'TRUE', {}).value).toBe(true);
    expect(plan(recs, fd({ type: 'currency' }), 'abc', {}).ok).toBe(false);
    expect(plan(recs, fd({ type: 'currency' }), '19.99', {}).value).toBe(19.99);
    expect(plan(recs, fd({ type: 'int' }), '2.5', {}).ok).toBe(false);
  });

  it('restricted picklist rejects unknown values; unrestricted warns and allows', () => {
    const pick = { type: 'picklist', restrictedPicklist: true,
      picklistValues: [{ value: 'Hot', active: true }, { value: 'Cold', active: true }] };
    expect(plan(recs, fd(pick), 'Warm', {}).ok).toBe(false);
    const open = plan(recs, fd({ ...pick, restrictedPicklist: false }), 'Warm', {});
    expect(open.ok).toBe(true);
    expect(open.warnings.join()).toContain('Warm');
  });

  it('lookup values must be id-shaped and warn about org-locality', () => {
    expect(plan(recs, fd({ type: 'reference' }), 'not-an-id', {}).ok).toBe(false);
    const p = plan(recs, fd({ type: 'reference' }), 'a00aj00003EQaW7AAL', {});
    expect(p.ok).toBe(true);
    expect(p.warnings.join()).toContain('never transfer between orgs');
  });

  it('set-to-empty needs the explicit flag, and refuses on required fields', () => {
    expect(plan(recs, fd(), '', {}).ok).toBe(false);          // blank ≠ clear
    const p = plan(recs, fd(), '', { setNull: true });
    expect(p.ok).toBe(true);
    expect(p.value).toBe(null);
    expect(p.updates.map(u => u.id)).toEqual(['R1', 'R2']);   // R3 already empty
    expect(plan(recs, fd({ nillable: false }), '', { setNull: true }).ok).toBe(false);
  });

  it('date wants YYYY-MM-DD; datetime normalizes to ISO', () => {
    expect(plan(recs, fd({ type: 'date' }), '10/08/2026', {}).ok).toBe(false);
    expect(plan(recs, fd({ type: 'date' }), '2026-08-10', {}).value).toBe('2026-08-10');
    expect(plan(recs, fd({ type: 'datetime' }), '2026-08-10T12:00:00Z', {}).value).toBe('2026-08-10T12:00:00.000Z');
  });
});
