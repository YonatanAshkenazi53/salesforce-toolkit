// E4 — Picklist Manager API-budget lines (enterprise quota awareness).
//
// The extension's moat is NO SERVER: every read spends the org's own daily
// API budget, so the Picklist view now says what a sweep / matrix load /
// bulk automation scan costs BEFORE (or, for the scan, right as) it spends.
// These tests pin the three estimators to what the code actually issues and
// the formatter to the honesty contract: local estimate always, per-org
// labeled quota only when the shared meter answered, "unavailable" said out
// loud, ⚠ informs and never blocks, pools never summed.
import { describe, it, expect } from 'vitest';
import { extractFunction } from './extract.mjs';

const pkSweepCallEstimate  = extractFunction('studio-picklists.js', 'pkSweepCallEstimate');
const pkMatrixCallEstimate = extractFunction('studio-picklists.js', 'pkMatrixCallEstimate');
const pkBulkScanCalls      = extractFunction('studio-picklists.js', 'pkBulkScanCalls');
const pkApiCostLine        = extractFunction('studio-picklists.js', 'pkApiCostLine');

// ── pkSweepCallEstimate — whole-object sweep (T9) ───────────────
describe('pkSweepCallEstimate', () => {
  it('per org: 1 describe (reused across all fields) + 1 RT list + 2 per custom field', () => {
    const e = pkSweepCallEstimate({ orgs: 1, customFields: 10 });
    expect(e.perOrg).toBe(2 + 20);
    expect(e.total).toBe(22);
  });

  it('scales linearly with orgs — the describe is per ORG, never per field', () => {
    const e = pkSweepCallEstimate({ orgs: 4, customFields: 25 });
    expect(e.perOrg).toBe(52);
    expect(e.total).toBe(208);   // 4 × (2 + 2×25), NOT 4 × 25 describes
  });

  it('standard fields cost nothing beyond the cached describe (skipUsage/skipRts)', () => {
    // Caller passes CUSTOM field count only — an all-standard object still
    // costs the describe + RT list per org.
    const e = pkSweepCallEstimate({ orgs: 3, customFields: 0 });
    expect(e.perOrg).toBe(2);
    expect(e.total).toBe(6);
  });

  it('is honest about the unknowns: known=false and record types named as the "more if"', () => {
    const e = pkSweepCallEstimate({ orgs: 2, customFields: 5 });
    expect(e.known).toBe(false);
    expect(e.moreIf).toMatch(/record types/);
    expect(e.moreIf).toMatch(/up to 8 more reads per org/);
  });

  it('zero orgs → zero calls, nothing rough about it', () => {
    expect(pkSweepCallEstimate({ orgs: 0, customFields: 25 })).toEqual({ total: 0, perOrg: 0, known: true, moreIf: '' });
  });

  it('garbage input never yields NaN', () => {
    const e = pkSweepCallEstimate({ orgs: 'x', customFields: -3 });
    expect(e.total).toBe(0);
    const e2 = pkSweepCallEstimate({ orgs: 2.9, customFields: NaN });
    expect(e2.perOrg).toBe(2);
    expect(e2.total).toBe(4);
    expect(pkSweepCallEstimate(null).total).toBe(0);
  });
});

// ── pkMatrixCallEstimate — "Load matrix" (P2) ───────────────────
describe('pkMatrixCallEstimate', () => {
  it('custom single picklist: describe + 2 Tooling reads + 1 usage + 2 RT lists = 6/org', () => {
    const e = pkMatrixCallEstimate({ orgs: 3, isCustom: true, isMulti: false, values: 12 });
    expect(e.perOrg).toBe(6);
    expect(e.total).toBe(18);
  });

  it('standard single picklist: describe + 1 usage + 1 RT list = 3/org', () => {
    const e = pkMatrixCallEstimate({ orgs: 2, isCustom: false, isMulti: false, values: 5 });
    expect(e.perOrg).toBe(3);
    expect(e.total).toBe(6);
  });

  it('multi-select counts one usage query per value', () => {
    const e = pkMatrixCallEstimate({ orgs: 1, isCustom: true, isMulti: true, values: 12 });
    expect(e.perOrg).toBe(3 + 12 + 2);
  });

  it('multi-select usage is capped at 30 — the same cap _pkLoadUsage applies', () => {
    const e = pkMatrixCallEstimate({ orgs: 2, isCustom: true, isMulti: true, values: 500 });
    expect(e.perOrg).toBe(3 + 30 + 2);
    expect(e.total).toBe(70);
  });

  it('multi-select with an unknown value count assumes at least one query', () => {
    const e = pkMatrixCallEstimate({ orgs: 1, isCustom: false, isMulti: true, values: 0 });
    expect(e.perOrg).toBe(1 + 1 + 1);
  });

  it('names the RT unknown honestly — reads are never listed twice since the matrix reuses inventory RTs', () => {
    // The estimator once said "up to 16" for custom fields because _pkLoadMatrix
    // genuinely double-loaded RecordTypes; the dedupe fix (reuse r.inv.rts)
    // halved the real cost, and the quote follows the code, not the other way.
    expect(pkMatrixCallEstimate({ orgs: 1, isCustom: true }).moreIf).toMatch(/up to 8 more reads per org/);
    expect(pkMatrixCallEstimate({ orgs: 1, isCustom: false }).moreIf).toMatch(/up to 8 more reads per org/);
    expect(pkMatrixCallEstimate({ orgs: 1, isCustom: true }).known).toBe(false);
  });

  it('zero orgs → zero', () => {
    expect(pkMatrixCallEstimate({ orgs: 0, isCustom: true, isMulti: true, values: 30 }).total).toBe(0);
    expect(pkMatrixCallEstimate(undefined).total).toBe(0);
  });
});

// ── pkBulkScanCalls — bulk wizard per-org automation scan ───────
describe('pkBulkScanCalls', () => {
  it('fixed part is 7: 4 impact queries + 1 VR scan + 2 flow enumerations', () => {
    expect(pkBulkScanCalls({ flowsScanned: 0 })).toBe(6);
  });
  it('adds one read per scanned flow', () => {
    expect(pkBulkScanCalls({ flowsScanned: 5 })).toBe(7);     // phase 6: one batch call per 25 flows
    expect(pkBulkScanCalls({ flowsScanned: 40 })).toBe(8);
    expect(pkBulkScanCalls({ flowsScanned: 147 })).toBe(12);  // no cap any more
  });
  it('missing / garbage scan stats degrade to the fixed part, never NaN', () => {
    expect(pkBulkScanCalls(null)).toBe(6);
    expect(pkBulkScanCalls({})).toBe(6);
    expect(pkBulkScanCalls({ flowsScanned: 'x' })).toBe(6);
    expect(pkBulkScanCalls({ flowsScanned: -2 })).toBe(6);
  });
});

// ── pkApiCostLine — the formatter ───────────────────────────────
describe('pkApiCostLine — local estimate (no helper needed)', () => {
  it('renders the plain estimate when budgets are absent (helper not loaded)', () => {
    const r = pkApiCostLine({ total: 66, perOrg: 22, known: true }, null);
    expect(r.text).toBe('≈66 API calls');
    expect(r.warn).toBe(false);
  });

  it('scope text lands between the count and the "more if"', () => {
    const r = pkApiCostLine({ total: 66, known: false, scope: 'across 3 orgs', moreIf: 'the object has record types (up to 8 more reads per org)' }, null);
    expect(r.text).toBe('≈66 API calls across 3 orgs, more if the object has record types (up to 8 more reads per org)');
  });

  it('rough estimate WITHOUT a named unknown still shows "+" — never fake precision', () => {
    expect(pkApiCostLine({ total: 10, known: false }, null).text).toBe('≈10+ API calls');
  });

  it('singular call', () => {
    expect(pkApiCostLine({ total: 1, known: true }, null).text).toBe('≈1 API call');
  });

  it('thousands are formatted', () => {
    expect(pkApiCostLine({ total: 1234, known: true }, null).text).toBe(`≈${(1234).toLocaleString()} API calls`);
  });

  it('no estimate at all → empty line, not "≈undefined"', () => {
    expect(pkApiCostLine(null, null)).toEqual({ text: '', warn: false });
    expect(pkApiCostLine({}, [])).toEqual({ text: '', warn: false });
  });
});

describe('pkApiCostLine — whose-quota labeling (each org has its OWN pool)', () => {
  const est = { total: 40, perOrg: 20, known: true };

  it('appends each org\'s meter labeled with THAT org, never a sum', () => {
    const r = pkApiCostLine(est, [
      { label: 'Dev',  budget: { max: 15000, remaining: 14900 }, calls: 20 },
      { label: 'Prod', budget: { max: 100000, remaining: 99000 }, calls: 20 },
    ]);
    expect(r.text).toContain(`Dev has ${(14900).toLocaleString()} of ${(15000).toLocaleString()} daily API calls remaining`);
    expect(r.text).toContain(`Prod has ${(99000).toLocaleString()} of ${(100000).toLocaleString()} daily API calls remaining`);
    // Pools are NEVER summed: no combined remaining/max anywhere in the line.
    expect(r.text).not.toContain((14900 + 99000).toLocaleString());
    expect(r.text).not.toContain((115000).toLocaleString());
    expect(r.warn).toBe(false);
  });

  it('a null meter is SAID, per org: "API budget unavailable"', () => {
    const r = pkApiCostLine(est, [
      { label: 'Dev', budget: { max: 15000, remaining: 14900 }, calls: 20 },
      { label: 'UAT', budget: null, calls: 20 },
    ]);
    expect(r.text).toContain('UAT: API budget unavailable');
    expect(r.text).toContain('Dev has');
    expect(r.warn).toBe(false);
  });

  it('a budget entry with no label still renders, as "org"', () => {
    const r = pkApiCostLine(est, [{ budget: null, calls: 20 }]);
    expect(r.text).toContain('org: API budget unavailable');
  });
});

describe('pkApiCostLine — the ⚠ exhaustion warning (informs, never blocks)', () => {
  it('warns when one org\'s estimated calls EXCEED its remaining budget, and names it', () => {
    const r = pkApiCostLine({ total: 600, perOrg: 300, known: false, moreIf: 'x' }, [
      { label: 'Dev',  budget: { max: 15000, remaining: 100 },  calls: 300 },
      { label: 'Prod', budget: { max: 100000, remaining: 99000 }, calls: 300 },
    ]);
    expect(r.warn).toBe(true);
    expect(r.text).toMatch(/^⚠ /);
    expect(r.text).toContain("may exhaust the org's remaining daily API budget");
    expect(r.text).toContain('(Dev)');
    expect(r.text).not.toContain('(Dev, Prod)');
  });

  it('equal is NOT over — spending exactly the remainder does not warn', () => {
    const r = pkApiCostLine({ total: 100, perOrg: 100, known: true }, [
      { label: 'Dev', budget: { max: 15000, remaining: 100 }, calls: 100 },
    ]);
    expect(r.warn).toBe(false);
    expect(r.text).not.toContain('⚠');
  });

  it('every over-budget org is named, pluralized', () => {
    const r = pkApiCostLine({ total: 400, perOrg: 200, known: true }, [
      { label: 'Dev', budget: { max: 15000, remaining: 10 }, calls: 200 },
      { label: 'UAT', budget: { max: 15000, remaining: 20 }, calls: 200 },
    ]);
    expect(r.warn).toBe(true);
    expect(r.text).toContain('daily API budgets (Dev, UAT)');
  });

  it('an unreadable meter can never warn — unknown is not over', () => {
    const r = pkApiCostLine({ total: 999999, perOrg: 999999, known: true }, [
      { label: 'Dev', budget: null, calls: 999999 },
    ]);
    expect(r.warn).toBe(false);
  });
});

// ── the three estimators feed the formatter — one end-to-end shape check ──
describe('estimator → formatter integration', () => {
  it('sweep estimate renders the exact entry-UI line shape', () => {
    const est = pkSweepCallEstimate({ orgs: 3, customFields: 12 });
    est.scope = 'across 3 orgs';
    const r = pkApiCostLine(est, [
      { label: 'Dev', budget: { max: 15000, remaining: 14000 }, calls: est.perOrg },
    ]);
    expect(r.text).toBe(
      `≈78 API calls across 3 orgs, more if the object has record types (up to 8 more reads per org) · Dev has ${(14000).toLocaleString()} of ${(15000).toLocaleString()} daily API calls remaining`);
    expect(r.warn).toBe(false);
  });
});
