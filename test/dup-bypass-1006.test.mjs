import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const BG = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const FE = readFileSync(new URL('../sftk-friendly-error.js', import.meta.url), 'utf8');

// QA 2026-10-06 (live, trailheads4 with a duplicate rule set to BLOCK): Duplicate rules =
// Bypass sent the header, the run said "records a rule would have flagged were written",
// and the rule blocked the records all the same — Salesforce's bypass header passes a rule
// set to Alert, never one set to Block. And the rule's own alert text hid that it was a
// duplicate rule at all.
describe('duplicate rules: what Bypass can and cannot do is said as it is', () => {
  it('the run diagnostic names the limit', () => {
    expect(BG).toContain("diagnostics.push('Duplicate rules set to Alert were bypassed for this run (engine setting): records such a rule would have flagged were written. A rule set to Block still blocks — no API can pass it; relax that rule in the target for the migration.');");
    expect(BG).not.toContain('records a rule would have flagged were written.\');');
  });
  it('a per-record refusal keeps the DUPLICATES_DETECTED status code whatever the rule says', () => {
    expect(BG).toContain("const msg = (result.errors || []).map(e => (e.statusCode === 'DUPLICATES_DETECTED' && !/DUPLICATES_DETECTED/.test(e.message || '')) ? `${e.message} [DUPLICATES_DETECTED]` : e.message).join('; ');");
    // the friendly reading keys on the code, so a custom alert text is still recognised
    const i = FE.indexOf('function sftkFriendlyError(');
    const fn = new Function(FE.slice(i, FE.indexOf('\n}\n', i) + 3) + ' return sftkFriendlyError;')();
    const r = fn('Account: SFTK QA: a record like this already exists. [DUPLICATES_DETECTED]');
    expect(r.type).toBe('duplicate');
    expect(r.hint).toContain('a rule set to Block cannot be passed by any API');
  });
});
