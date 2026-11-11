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
