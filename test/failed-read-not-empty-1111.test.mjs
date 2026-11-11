// Audit 2026-11-11 (owner: "we need to check this issue doesn't affect other things like data deployment"): a query
// that FAILED must never be read as "nothing there". Three places in Data Deployment did.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const REC = read('studio-reconcile.js'), FP = read('sftk-flowpause.js');

describe('a failed read is not an empty answer', () => {
  it('the identity stamp stops before writing when the current values cannot be read', () => {
    expect(REC).toContain("🪪 Nothing was stamped: the current ${idField} values of ${objType} could not be read");
    expect(REC).not.toContain("if (!oq?.error) for (const r of (oq.records || [])) oldValById.set(");
  });
  it('record types that could not be read are not called "not in target"', () => {
    expect(REC).toContain('the record types could not be read (${rtErr}) — RecordTypeId left unchanged on every record of this write');
    expect(REC).toContain("else if (unmatched.length) ovwErrors.push(`record type(s)");
  });
  it('switching flows back on: after a failed lookup the flow is never called "not found" and forgotten', () => {
    const i = FP.indexOf('still OFF and still remembered'), j = FP.indexOf('not found in the org any more');
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(j);
    expect(FP).toContain('return { done: r.done, failed: [...r.failed, ...lost, ...unread] };');
  });
});

// QA 2026-11-11: Field Cleaner's scan — a leg that fails is recorded and locks the delete
import { extractFunctions } from './extract.mjs';
describe('Field Cleaner — a scan leg that fails is said', () => {
  const FC = read('field-cleaner.js');
  const A = extractFunctions('field-cleaner.js', ['fcAbsentFeatureError']);
  it('an error that only says "no such object or feature" is an empty answer; a real failure is not', () => {
    expect(A.fcAbsentFeatureError("INVALID_TYPE: sObject type 'ServiceChannel' is not supported")).toBe(true);
    expect(A.fcAbsentFeatureError('INVALID_FIELD: No such column SecRoutingPriorityField')).toBe(true);
    expect(A.fcAbsentFeatureError('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded')).toBe(false);
    expect(A.fcAbsentFeatureError('INVALID_SESSION_ID: Session expired or invalid')).toBe(false);
    expect(A.fcAbsentFeatureError('Request timed out after 30 seconds')).toBe(false);
    expect(A.fcAbsentFeatureError('')).toBe(false);
  });
  it('no leg of the supplemental scan passes over its failure in silence', () => {
    const i = FC.indexOf('async function scanSupplemental('), j = FC.indexOf('hits.unread = unread;', i);
    const body = FC.slice(i, j);
    expect(j).toBeGreaterThan(i);
    expect((body.match(/catch \(e\) \{ miss\('/g) || []).length).toBeGreaterThanOrEqual(20);
    expect((body.match(/catch \(_\) \{\/\* non-fatal \*\/\}/g) || []).length).toBeLessThanOrEqual(1);   // the lookup-filter naming only
    expect(body).toContain("if (r.incomplete) throw new Error(`the read came back incomplete");
  });
  it('an unread kind locks Delete Field until Salesforce itself accepts', () => {
    expect(FC).toContain('const delDisabled = autoCount > 0 || blockerTotal > 0 || unread.length > 0;');
    expect(FC).toContain("if (view.kind === 'ok' && open === 0) { if (d) d.disabled = false;");
    expect(FC).toContain('could not be read in this scan');
  });
});
