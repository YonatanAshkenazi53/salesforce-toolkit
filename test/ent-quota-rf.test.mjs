// E3b — API-budget awareness on Deploy Readiness, Field Cleaner and Schema
// View's deep scan.
//
// The contract these tests pin down (HONESTY, reference user-copy.js):
//   • the local "≈N API calls" estimate renders from arithmetic alone — it
//     never needs the shared window.sftkApiBudget reader;
//   • the daily-budget meter is appended only when the reader answered, an
//     unreadable meter is SAID ("API budget unavailable"), never hidden;
//   • every meter is labeled with WHOSE pool it is — orgs' pools are never
//     summed, because each org has its own daily limit;
//   • a cost that depends on mid-scan discoveries is quoted as
//     "≈N now, plus 1 for each …" — no invented totals;
//   • estimate > remaining warns ("may exhaust"), estimate == remaining does
//     not, and nothing here ever blocks a run.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

const { drEstimateReadinessCalls, drReadinessBudgetLine } =
  extractFunctions('studio-readiness.js', ['drEstimateReadinessCalls', 'drReadinessBudgetLine']);
const { fcEstimateScanCalls, fcScanBudgetLine } =
  extractFunctions('field-cleaner.js', ['fcEstimateScanCalls', 'fcScanBudgetLine']);
const { svDeepScanCallEstimate, svDeepScanBudgetLine } =
  extractFunctions('studio-schema.js', ['svDeepScanCallEstimate', 'svDeepScanBudgetLine']);

// toLocaleString is locale-dependent — build expectations with the same
// formatter the code uses so the assertions hold on any machine.
const fmt = v => Number(v).toLocaleString();

// ════════════════════════════════════════════════════════════════
// Deploy Readiness — drEstimateReadinessCalls
// ════════════════════════════════════════════════════════════════
describe('drEstimateReadinessCalls (studio-readiness.js)', () => {
  // The call profile counted from runReadinessCheck/analyseObject:
  // per target per object: 1 source describe + 1 target describe
  //   + 1 validation query + 1 dup-rule query (both target-side, toggleable);
  // org settings: 2 source describes once + 2 target describes per target.
  it('all checks on: 2 targets × 7 objects', () => {
    const e = drEstimateReadinessCalls(2, 7, { validation: true, dupRules: true, orgSettings: true });
    expect(e.source).toBe(2 * 7 + 2);          // 16 — source describes + settings probe
    expect(e.perTarget).toBe(7 * 3 + 2);       // 23 — describe+val+dup per object + settings probe
    expect(e.total).toBe(16 + 2 * 23);         // 62
    expect(e.targets).toBe(2);
    expect(e.objects).toBe(7);
  });

  it('validation and duplicate-rule queries are the toggleable target-side legs', () => {
    const e = drEstimateReadinessCalls(2, 7, { validation: false, dupRules: false, orgSettings: true });
    expect(e.perTarget).toBe(7 + 2);           // describes only + settings probe
    expect(e.source).toBe(16);                 // source side unchanged
    expect(e.total).toBe(16 + 2 * 9);
  });

  it('org settings off removes 2 calls per org (source and each target)', () => {
    const e = drEstimateReadinessCalls(2, 7, { validation: true, dupRules: true, orgSettings: false });
    expect(e.source).toBe(14);
    expect(e.perTarget).toBe(21);
    expect(e.total).toBe(14 + 42);
  });

  it('absent checks default to ON — the same default the UI checkboxes carry', () => {
    expect(drEstimateReadinessCalls(2, 7, {}).total)
      .toBe(drEstimateReadinessCalls(2, 7, { validation: true, dupRules: true, orgSettings: true }).total);
    expect(drEstimateReadinessCalls(2, 7, undefined).total).toBe(62);
  });

  it('zero targets is a zero-call run, and junk counts clamp to 0', () => {
    expect(drEstimateReadinessCalls(0, 7, {}).total).toBe(0);
    expect(drEstimateReadinessCalls(-3, 'x', {}).total).toBe(0);
    expect(drEstimateReadinessCalls(NaN, 5, {}).total).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════
// Deploy Readiness — drReadinessBudgetLine (per-org labeling)
// ════════════════════════════════════════════════════════════════
describe('drReadinessBudgetLine (studio-readiness.js)', () => {
  const est = drEstimateReadinessCalls(2, 7, {});   // total 62, source 16, perTarget 23

  it('renders the bare estimate with the targets × objects breakdown when no meters exist', () => {
    const line = drReadinessBudgetLine(est, []);
    expect(line.text).toBe('≈62 API calls (2 targets × 7 objects)');
    expect(line.warn).toBe(false);
  });

  it('singular forms: 1 target × 1 object', () => {
    const e1 = drEstimateReadinessCalls(1, 1, {});   // 3 + 5 = 8
    expect(drReadinessBudgetLine(e1, []).text).toBe('≈8 API calls (1 target × 1 object)');
  });

  it('labels every meter with WHOSE pool it is — pools are never summed', () => {
    const line = drReadinessBudgetLine(est, [
      { label: 'source Dev Sandbox', budget: { max: 900, remaining: 800 }, calls: est.source },
      { label: 'target Production',  budget: { max: 500, remaining: 400 }, calls: est.perTarget },
    ]);
    expect(line.text).toContain('source Dev Sandbox has 800 of 900 daily API calls remaining');
    expect(line.text).toContain('target Production has 400 of 500 daily API calls remaining');
    // No combined figure anywhere — 800+400 or 900+500 appearing would mean
    // two orgs' independent pools were added together.
    expect(line.text).not.toContain(fmt(1200));
    expect(line.text).not.toContain(fmt(1400));
    expect(line.warn).toBe(false);
  });

  it('an unreadable meter is SAID, not hidden', () => {
    const line = drReadinessBudgetLine(est, [
      { label: 'target Production', budget: null, calls: est.perTarget },
    ]);
    expect(line.text).toContain('target Production: API budget unavailable');
    expect(line.warn).toBe(false);   // no meter → no claim either way
  });

  it('warns when one org\'s estimated calls exceed ITS remaining budget', () => {
    const line = drReadinessBudgetLine(est, [
      { label: 'source Dev', budget: { max: 900, remaining: 800 }, calls: est.source },
      { label: 'target Prod', budget: { max: 500, remaining: 20 }, calls: est.perTarget },  // 23 > 20
    ]);
    expect(line.warn).toBe(true);
    expect(line.text.startsWith('⚠')).toBe(true);
    expect(line.text).toMatch(/may exhaust the org's remaining daily API budget/);
    expect(line.text).toContain('(target Prod)');
    expect(line.text).not.toContain('source Dev)');   // the org that is fine is not accused
  });

  it('estimate EQUAL to remaining is not over — inform, never cry wolf', () => {
    const line = drReadinessBudgetLine(est, [
      { label: 'target Prod', budget: { max: 500, remaining: 23 }, calls: 23 },
    ]);
    expect(line.warn).toBe(false);
  });

  it('two exhausted pools are both named, plural budgets', () => {
    const line = drReadinessBudgetLine(est, [
      { label: 'target A', budget: { max: 100, remaining: 1 }, calls: 23 },
      { label: 'target B', budget: { max: 100, remaining: 2 }, calls: 23 },
    ]);
    expect(line.warn).toBe(true);
    expect(line.text).toMatch(/budgets \(target A, target B\)/);
  });

  it('large numbers format through the same locale the display uses', () => {
    const line = drReadinessBudgetLine(est, [
      { label: 'target Prod', budget: { max: 15000, remaining: 14000 }, calls: est.perTarget },
    ]);
    expect(line.text).toContain(`target Prod has ${fmt(14000)} of ${fmt(15000)} daily API calls remaining`);
  });
});

// ════════════════════════════════════════════════════════════════
// Field Cleaner — fcEstimateScanCalls (mid-scan discoveries)
// ════════════════════════════════════════════════════════════════
describe('fcEstimateScanCalls (field-cleaner.js)', () => {
  // The 8-call floor: field-id lookup, dependency query, Lightning-page
  // list, list-view list, compact-layout describe, quick-action list,
  // matching-rule query, workflow-field-update query.
  it('pre-scan (nothing discovered yet): the 8-call floor plus three unknown legs', () => {
    const e = fcEstimateScanCalls(null);
    expect(e.now).toBe(8);
    expect(e.known).toBe(false);
    expect(e.moreIf).toHaveLength(3);
    expect(e.moreIf).toContain('Lightning page in the org');
    expect(e.moreIf).toContain('list view on this object');
    expect(e.moreIf).toContain('create/update quick action on this object');
  });

  it('every discovered leg moves from "more if" into the floor at 1 call per item', () => {
    const e = fcEstimateScanCalls({ flexiPages: 40, listViews: 6, quickActions: 3 });
    expect(e.now).toBe(8 + 40 + 6 + 3);
    expect(e.known).toBe(true);
    expect(e.moreIf).toEqual([]);
  });

  it('a partially known scan counts what it knows and names what it does not', () => {
    const e = fcEstimateScanCalls({ flexiPages: 40 });
    expect(e.now).toBe(48);
    expect(e.known).toBe(false);
    expect(e.moreIf).toHaveLength(2);
    expect(e.moreIf).not.toContain('Lightning page in the org');
  });

  it('junk counts are unknown, not zero — absence of an answer is not an answer', () => {
    const e = fcEstimateScanCalls({ flexiPages: 'many', listViews: -2, quickActions: NaN });
    expect(e.now).toBe(8);
    expect(e.known).toBe(false);
    expect(e.moreIf).toHaveLength(3);
  });
});

// ════════════════════════════════════════════════════════════════
// Field Cleaner — fcScanBudgetLine (conditional-cost phrasing)
// ════════════════════════════════════════════════════════════════
describe('fcScanBudgetLine (field-cleaner.js)', () => {
  const preScan = fcEstimateScanCalls(null);   // now 8, three unknown legs

  it('quotes "≈N now, plus 1 for each …" — never a fake total — before discovery', () => {
    const line = fcScanBudgetLine(preScan, null);
    expect(line.text).toMatch(/^≈8 API calls now, plus 1 for each /);
    expect(line.text).toContain('Lightning page in the org');
    expect(line.text).toContain('list view on this object');
    expect(line.text).toContain('create/update quick action on this object');
    expect(line.warn).toBe(false);
  });

  it('a fully known cost drops the conditional clause', () => {
    const line = fcScanBudgetLine(fcEstimateScanCalls({ flexiPages: 40, listViews: 6, quickActions: 3 }), null);
    expect(line.text).toBe('≈57 API calls');
  });

  it('no budget reader → just the estimate, no meter and no "unavailable" noise', () => {
    const line = fcScanBudgetLine(preScan, null);
    expect(line.text).not.toMatch(/daily API calls remaining|API budget unavailable/);
  });

  it('reader answered null → the meter is declared unavailable, out loud', () => {
    const line = fcScanBudgetLine(preScan, { label: 'this org', budget: null });
    expect(line.text).toContain('this org: API budget unavailable');
    expect(line.warn).toBe(false);
  });

  it('reader answered → the meter rides beside the estimate, labeled', () => {
    const line = fcScanBudgetLine(preScan, { label: 'this org', budget: { max: 100, remaining: 90 } });
    expect(line.text).toContain('≈8 API calls now');
    expect(line.text).toContain('this org has 90 of 100 daily API calls remaining');
    expect(line.warn).toBe(false);
  });

  it('warns when the KNOWN floor alone exceeds the remaining budget', () => {
    const est = fcEstimateScanCalls({ flexiPages: 200, listViews: 0, quickActions: 0 });  // 208
    const line = fcScanBudgetLine(est, { label: 'this org', budget: { max: 500, remaining: 100 } });
    expect(line.warn).toBe(true);
    expect(line.text.startsWith('⚠')).toBe(true);
    expect(line.text).toMatch(/may exhaust the org's remaining daily API budget/);
  });

  it('floor equal to remaining does not warn', () => {
    const line = fcScanBudgetLine(preScan, { label: 'this org', budget: { max: 100, remaining: 8 } });
    expect(line.warn).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// Schema View — svDeepScanCallEstimate
// ════════════════════════════════════════════════════════════════
describe('svDeepScanCallEstimate (studio-schema.js)', () => {
  // Cap and chunk are the scan's own constants, passed in at the call site
  // (SV_FLOW_META_CAP = 100, SV_FLOW_META_CHUNK = 10).
  it('an exact-cap run: 100 eligible flows, chunked by 10, is 10 batched calls', () => {
    const e = svDeepScanCallEstimate(100, 100, 10);
    expect(e).toEqual({ eligible: 100, opened: 100, capped: false, calls: 10, chunk: 10 });
  });

  it('past the cap: only the cap is opened, and the cut is on the record', () => {
    const e = svDeepScanCallEstimate(137, 100, 10);
    expect(e.opened).toBe(100);
    expect(e.calls).toBe(10);
    expect(e.capped).toBe(true);
    expect(e.eligible).toBe(137);
  });

  it('a partial last chunk still costs a whole call', () => {
    expect(svDeepScanCallEstimate(11, 100, 10).calls).toBe(2);
    expect(svDeepScanCallEstimate(5, 100, 10).calls).toBe(1);
  });

  it('nothing eligible, nothing spent', () => {
    const e = svDeepScanCallEstimate(0, 100, 10);
    expect(e.calls).toBe(0);
    expect(e.opened).toBe(0);
    expect(e.capped).toBe(false);
  });

  it('junk input clamps instead of inventing calls', () => {
    expect(svDeepScanCallEstimate('lots', 100, 10).calls).toBe(0);
    expect(svDeepScanCallEstimate(-4, 100, 10).calls).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════
// Schema View — svDeepScanBudgetLine (the quota half)
// ════════════════════════════════════════════════════════════════
describe('svDeepScanBudgetLine (studio-schema.js)', () => {
  it('the batched call count stands alone when the reader is absent', () => {
    const line = svDeepScanBudgetLine(svDeepScanCallEstimate(100, 100, 10), null);
    expect(line.text).toBe('≈10 batched Tooling calls to open 100 flows');
    expect(line.warn).toBe(false);
  });

  it('a capped scan says what it was capped from', () => {
    const line = svDeepScanBudgetLine(svDeepScanCallEstimate(137, 100, 10), null);
    expect(line.text).toContain('(capped from 137)');
  });

  it('singular forms: 1 call, 1 flow', () => {
    const line = svDeepScanBudgetLine(svDeepScanCallEstimate(1, 100, 10), null);
    expect(line.text).toBe('≈1 batched Tooling call to open 1 flow');
  });

  it('the quota half rides beside the count, labeled with whose pool it is', () => {
    const line = svDeepScanBudgetLine(svDeepScanCallEstimate(100, 100, 10),
      { label: 'Production', budget: { max: 900, remaining: 850 } });
    expect(line.text).toContain('≈10 batched Tooling calls to open 100 flows');
    expect(line.text).toContain('Production has 850 of 900 daily API calls remaining');
    expect(line.warn).toBe(false);
  });

  it('an unreadable meter is said, never silently dropped', () => {
    const line = svDeepScanBudgetLine(svDeepScanCallEstimate(100, 100, 10),
      { label: 'Production', budget: null });
    expect(line.text).toContain('Production: API budget unavailable');
    expect(line.warn).toBe(false);
  });

  it('warns when the batched calls exceed the remaining budget — equal does not', () => {
    const est = svDeepScanCallEstimate(100, 100, 10);   // 10 calls
    const over = svDeepScanBudgetLine(est, { label: 'Prod', budget: { max: 900, remaining: 4 } });
    expect(over.warn).toBe(true);
    expect(over.text.startsWith('⚠')).toBe(true);
    expect(over.text).toMatch(/this deep scan may exhaust the org's remaining daily API budget/);
    const equal = svDeepScanBudgetLine(est, { label: 'Prod', budget: { max: 900, remaining: 10 } });
    expect(equal.warn).toBe(false);
  });
});
