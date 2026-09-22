// Picklist Manager — live findings (2026-09-23, trailheads2, fixture picklist
// Account.SFTK_FC_Test_Status__c with 5 Accounts on Closed, 3 on Reviewed, 0 on New).
//
// 1. The value nobody holds ("New") read "—" — the same mark as "not counted"
//    and next to "?" for a failed count — although the GROUP BY had answered
//    and the count was simply zero. A counted zero is 0.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'studio-picklists.js'), 'utf8');
const between = (a, b) => { const i = SRC.indexOf(a); expect(i, a).toBeGreaterThan(0); return SRC.slice(i, SRC.indexOf(b, i)); };

// 2. "🗑 Delete value" reported "Value deleted from the value set" while the CLI
//    showed Salesforce had KEPT the value as inactive — the API cannot delete
//    a picklist value, only Setup can. The tool re-reads the field and says which.
describe('_pkApplyMetadataCore — a removal is verified by re-reading the field', () => {
  const fn = between('async function _pkApplyMetadataCore(', 'async function _pkApplyMetadata(');
  it('re-reads the CustomField after a remove and reports removed / keptInactive', () => {
    expect(fn).toMatch(/if \(!op\.remove\) return \{ ok: true \};/);
    expect(fn).toMatch(/sobject: 'CustomField', id: inv\.fieldId, _suppressError: true/);
    expect(fn).toMatch(/return \{ ok: true, verified: true, name, removed: !kept, keptInactive: !!kept && kept\.isActive === false \};/);
    expect(fn).toMatch(/return \{ ok: true, verified: false, name \};/);
  });
});
describe('_pkApplyMetadata — the toast tells the truth about a delete', () => {
  const fn = between('async function _pkApplyMetadata(', '// P2 — MULTI-ORG MATRIX');
  it('says kept INACTIVE with the Setup path, or verified deleted, or could not re-read', () => {
    expect(fn).toMatch(/Salesforce kept “\$\{r\.name\}” as INACTIVE — its API cannot delete a picklist value\. To delete it for good: Setup → Object Manager → \$\{inv\.obj\} → Fields & Relationships → \$\{inv\.field\} → Values → Del\./);
    expect(fn).toContain("'🗑 Value deleted from the value set (verified by re-reading the field)'");
    expect(fn).toMatch(/could not be re-read to confirm what Salesforce kept/);
    expect(fn).not.toContain("op.remove ? '🗑 Value deleted from the value set'\n");
  });
});
describe('the delete wizards and the bulk summary say what the API can do', () => {
  it('both wizards carry an honest warning (the field wizard re-reads; the standard/global one says to check Setup)', () => {
    expect(SRC).toContain("⛔ Salesforce's API cannot delete a picklist value: this removes it from the value set and Salesforce keeps it as <strong>inactive</strong>");
    expect(SRC).toContain("⛔ Salesforce's API may keep a removed value as <strong>inactive</strong> rather than delete it");
    expect(SRC).not.toContain('⛔ Deleting removes the value from the value set permanently');
    expect(SRC).not.toContain('⛔ Deleting removes the value permanently.');
  });
  it('the bulk apply counts values Salesforce kept and says so', () => {
    const fn = between('async function _pkApplyBulk(', 'function _pkRenderValueSet(');
    expect(fn).toMatch(/metaOk = 0, metaFail = 0, metaKept = 0/);
    expect(fn).toMatch(/const keptByOrg = mode === 'delete' && r && r\.verified && !r\.removed;/);
    expect(fn).toMatch(/kept INACTIVE by Salesforce \(its API cannot delete a picklist value; Setup can\)/);
  });
});

describe('_pkLoadUsage — a value no record holds is a counted zero', () => {
  const fn = between('async function _pkLoadUsage(', 'async function _pkLoadRecordTypes(');
  it('fills 0 for every value absent from a successful, complete GROUP BY answer', () => {
    expect(fn).toMatch(/if \(!agg\.error && \(agg\.records \|\| \[\]\)\.length < 2000\) \{/);
    expect(fn).toMatch(/for \(const v of \(rawValues \|\| \[\]\)\) \{ const name = pkValueName\(v\); if \(!usage\.has\(name\)\) usage\.set\(name, 0\); \}/);
  });
  it('leaves values uncounted when the query failed or the answer was capped', () => {
    // the zero fill is guarded by both conditions; a failed query keeps usage empty (→ "—")
    const i = fn.indexOf('if (!agg.error && (agg.records || []).length < 2000) {');
    expect(fn.slice(0, i)).toMatch(/if \(agg\.error\) \{ usageNote = `Usage counts unavailable: \$\{agg\.error\}`; \}/);
  });
});
