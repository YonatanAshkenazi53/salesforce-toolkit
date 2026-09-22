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

// 3. Compare mode said "trailheads4 skipped: SFTK_FC_Test_Status__c not found on
//    Account" for a field that existed there — the running user had no
//    field-level security on it yet, so the describe did not list it.
describe('_pkFetchInventory — a field the describe does not list may be hidden by FLS', () => {
  it('says so', () => {
    expect(SRC).toContain("throw new Error(`${field} not found on ${obj} — or hidden from your user by field-level security (the org's describe does not list it)`);");
  });
});

// 4. The sync plan's automation verdict read "✓ no flow or validation rule in
//    trailheads4 names this value" right next to "scanned 40 of 147 active
//    flows — the other 107 were NOT checked". A partial scan vouches only for
//    what it scanned.
describe('sync plan — the automation verdict does not outrun the scan', () => {
  it('says "nothing that was scanned" when the scan carries notes (cap / not enumerated)', () => {
    const i = SRC.indexOf("const partial = (lit.notes || []).length > 0;");
    expect(i).toBeGreaterThan(0);
    expect(SRC.slice(i, i + 400)).toMatch(/\$\{partial \? 'nothing that was scanned in' : 'no flow or validation rule in'\} \$\{esc\(tgt\.label\)\} names this value/);
  });
});

// 5. The bulk wizard's Apply was clickable while "scanned 0 of 2 org(s)…" was
//    still on screen; the sync plan's Run waits for its check. Same rule now.
describe('bulk wizard — Apply waits for the automation check', () => {
  const fn = between('async function _pkOpenBulkWizard(', 'async function _pkApplyBulk(');
  it('renders Apply disabled with "checking automation" and enables it only after every org answered', () => {
    expect(fn).toContain('id="dsPkBulkGo" disabled title="Enabled once the automation check has run in every org">⏳ checking automation…</button>');
    const i = fn.indexOf("const go = eid('dsPkBulkGo');");
    expect(i).toBeGreaterThan(fn.indexOf('for (const o of orgs) {'));
    expect(fn.slice(i, i + 300)).toMatch(/go\.disabled = false; go\.textContent = mode === 'delete' \? '🗑 Apply to all orgs' : '⏸ Apply to all orgs';/);
    expect(fn.slice(i - 120, i)).toMatch(/if \(pkScanSuperseded\(scanToken, _pkBulkScanToken\)\) return;/);
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
