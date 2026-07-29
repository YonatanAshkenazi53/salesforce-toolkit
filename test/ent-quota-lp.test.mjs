// E-quota (Lightning Pages) — API cost stated before it is paid, weighed
// against the org's daily budget when the meter is readable.
//
// Two column-0 functions in lightning-pages.js carry the whole feature:
//   lpAssignmentsScanPlan — the "Who sees what?" pre-run estimate AND the
//                           post-run "used ≈N" record. It calls lpDescribePlan
//                           (the dedupe) and lpBatchChunkPlan (reads → batch
//                           calls) — the same functions the scan itself is
//                           driven by, so the quote and the cost share one
//                           source of arithmetic. Extracted TOGETHER
//                           (extractFunctions) for exactly that reason.
//   lpApiBudgetText       — the sentence. Estimate always; the daily meter
//                           only appends (helper absent → estimate alone,
//                           helper answered null → "API budget unavailable",
//                           said out loud); ⚠ only when the estimate EXCEEDS
//                           remaining. Informational — nothing blocks.
import { describe, it, expect } from 'vitest';
import { extractFunction, extractFunctions } from './extract.mjs';

const { lpAssignmentsScanPlan, lpDescribePlan, lpBatchChunkPlan } =
  extractFunctions('lightning-pages.js',
    ['lpAssignmentsScanPlan', 'lpDescribePlan', 'lpBatchChunkPlan']);
const lpApiBudgetText = extractFunction('lightning-pages.js', 'lpApiBudgetText');

// The real constants lightning-pages.js passes in.
const PAGE_CHUNK   = 10;   // LP_SCAN_PAGE_CHUNK
const DESC_CHUNK   = 5;    // LP_SCAN_DESC_CHUNK
const ENTITY_CHUNK = 200;  // LP_ENTITY_CHUNK

const CHUNKS = { pageChunk: PAGE_CHUNK, descChunk: DESC_CHUNK, entityChunk: ENTITY_CHUNK };

// Locale-proof expected number rendering — the formatter uses toLocaleString.
const fmt = n => Number(n).toLocaleString();

// ══════════════════════════════════════════════════════════════
describe('lpAssignmentsScanPlan — the "Who sees what?" estimator', () => {
  it('600 pages over 200 objects: 60 page batches + 40 describe batches + 1 profile query', () => {
    // 3 record pages per object — the dedupe is what keeps describes at 200.
    const keys = Array.from({ length: 600 }, (_, i) => `Obj${i % 200}__c`);
    const plan = lpAssignmentsScanPlan({
      pages: 600, describeKeys: keys, pendingEntityIds: 0,
      profilesLoaded: false, ...CHUNKS
    });
    expect(plan.pageCalls).toBe(60);        // ceil(600 / 10)
    expect(plan.describes).toBe(200);       // deduped, not 600
    expect(plan.saved).toBe(400);
    expect(plan.describeCalls).toBe(40);    // ceil(200 / 5)
    expect(plan.entityCalls).toBe(0);
    expect(plan.profileCalls).toBe(1);
    expect(plan.calls).toBe(101);
  });

  it('mirrors lpBatchChunkPlan exactly — same chunk math, same 25 cap', () => {
    for (const pages of [0, 1, 9, 10, 11, 26, 250, 600]) {
      const plan = lpAssignmentsScanPlan({
        pages, describeKeys: [], pendingEntityIds: 0, profilesLoaded: true, ...CHUNKS
      });
      expect(plan.pageCalls).toBe(lpBatchChunkPlan(pages, PAGE_CHUNK).length);
    }
    // A chunk size past the server's ceiling is capped at 25, same as the run.
    const capped = lpAssignmentsScanPlan({
      pages: 100, describeKeys: [], pendingEntityIds: 0,
      profilesLoaded: true, pageChunk: 9999, descChunk: DESC_CHUNK, entityChunk: ENTITY_CHUNK
    });
    expect(capped.pageCalls).toBe(4);       // ceil(100 / 25), never 1
  });

  it('mirrors lpDescribePlan exactly — nulls (no object / draft) get no describe', () => {
    const keys = ['Account', null, 'Account', '', 'Case', null];
    const plan = lpAssignmentsScanPlan({
      pages: 6, describeKeys: keys, pendingEntityIds: 0, profilesLoaded: true, ...CHUNKS
    });
    expect(plan.describes).toBe(lpDescribePlan(keys).describes);
    expect(plan.describes).toBe(2);         // Account, Case
    expect(plan.describeCalls).toBe(1);     // one batch of 5 covers both
  });

  it('counts the profile query only when profiles are not already cached', () => {
    const base = { pages: 10, describeKeys: [], pendingEntityIds: 0, ...CHUNKS };
    const cold = lpAssignmentsScanPlan({ ...base, profilesLoaded: false });
    const warm = lpAssignmentsScanPlan({ ...base, profilesLoaded: true });
    expect(cold.profileCalls).toBe(1);
    expect(warm.profileCalls).toBe(0);
    expect(cold.calls - warm.calls).toBe(1);
  });

  it('counts id→name resolution queries in ENTITY_CHUNK-sized chunks', () => {
    const at = n => lpAssignmentsScanPlan({
      pages: 0, describeKeys: [], pendingEntityIds: n, profilesLoaded: true, ...CHUNKS
    }).entityCalls;
    expect(at(0)).toBe(0);
    expect(at(1)).toBe(1);
    expect(at(200)).toBe(1);
    expect(at(201)).toBe(2);                // one id over → one more query, not zero
  });

  it('empty org costs exactly the profile query, junk input costs nothing invented', () => {
    const empty = lpAssignmentsScanPlan({
      pages: 0, describeKeys: [], pendingEntityIds: 0, profilesLoaded: false, ...CHUNKS
    });
    expect(empty.calls).toBe(1);
    const junk = lpAssignmentsScanPlan({
      pages: -5, describeKeys: null, pendingEntityIds: NaN, profilesLoaded: true
    });
    expect(junk.calls).toBe(0);             // no silent floor above zero
    expect(lpAssignmentsScanPlan(undefined).calls).toBe(1);  // only the profile query
  });
});

// ══════════════════════════════════════════════════════════════
describe('lpApiBudgetText — the sentence, with and without a budget', () => {
  it('no helper in this context (budget undefined) → the estimate stands alone', () => {
    const line = lpApiBudgetText(101, undefined, {});
    expect(line.text).toBe(`≈${fmt(101)} API calls`);
    expect(line.warn).toBe(false);
    expect(line.text).not.toContain('remaining');
    expect(line.text).not.toContain('unavailable');
  });

  it('singular call, and junk call counts clamp to 0 rather than inventing a number', () => {
    expect(lpApiBudgetText(1, undefined, {}).text).toBe('≈1 API call');
    expect(lpApiBudgetText(-3, undefined, {}).calls).toBe(0);
    expect(lpApiBudgetText('junk', undefined, {}).text).toBe('≈0 API calls');
  });

  it('mid-run-discovery costs are hedged: "≈N now, more if X" — no fake precision', () => {
    const line = lpApiBudgetText(42, undefined, { moreIf: 'page metadata names more objects' });
    expect(line.text).toBe(`≈${fmt(42)} API calls now, more if page metadata names more objects`);
  });

  it('helper answered with a meter → appends "org has R of M daily API calls remaining"', () => {
    const line = lpApiBudgetText(101, { max: 100000, remaining: 99000 }, {});
    expect(line.text).toBe(
      `≈${fmt(101)} API calls · org has ${fmt(99000)} of ${fmt(100000)} daily API calls remaining`);
    expect(line.warn).toBe(false);
  });

  it('helper answered null (or a malformed meter) → "API budget unavailable", said, not hidden', () => {
    expect(lpApiBudgetText(101, null, {}).text)
      .toBe(`≈${fmt(101)} API calls · API budget unavailable`);
    for (const bad of [{}, { max: 100 }, { remaining: 'x', max: 100 }]) {
      const line = lpApiBudgetText(101, bad, {});
      expect(line.text).toContain('API budget unavailable');
      expect(line.warn).toBe(false);        // an unreadable meter never warns
    }
  });

  it('noEstimate: only the meter clause, for callers whose text already states the count', () => {
    const line = lpApiBudgetText(300, { max: 15000, remaining: 12000 }, { noEstimate: true });
    expect(line.text).toBe(`org has ${fmt(12000)} of ${fmt(15000)} daily API calls remaining`);
    expect(lpApiBudgetText(300, undefined, { noEstimate: true }).text).toBe('');
  });
});

// ══════════════════════════════════════════════════════════════
describe('lpApiBudgetText — the ⚠ threshold', () => {
  it('estimate EXCEEDS remaining → ⚠ + "may exhaust", informational wording only', () => {
    const line = lpApiBudgetText(500, { max: 15000, remaining: 400 }, {});
    expect(line.warn).toBe(true);
    expect(line.text.startsWith('⚠')).toBe(true);
    expect(line.text).toContain("may exhaust the org's remaining daily API budget");
    // It still states both numbers — a warning is not a substitute for the facts.
    expect(line.text).toContain(`≈${fmt(500)} API calls`);
    expect(line.text).toContain(`${fmt(400)} of ${fmt(15000)}`);
  });

  it('equal is NOT over — 400 estimated against 400 remaining does not warn', () => {
    const line = lpApiBudgetText(400, { max: 15000, remaining: 400 }, {});
    expect(line.warn).toBe(false);
    expect(line.text).not.toContain('⚠');
  });

  it('one under does not warn; one over does — the boundary is exact', () => {
    expect(lpApiBudgetText(399, { max: 15000, remaining: 400 }, {}).warn).toBe(false);
    expect(lpApiBudgetText(401, { max: 15000, remaining: 400 }, {}).warn).toBe(true);
  });

  it('warns with noEstimate too — the comparison is on the numbers, not the rendering', () => {
    const line = lpApiBudgetText(500, { max: 15000, remaining: 400 }, { noEstimate: true });
    expect(line.warn).toBe(true);
    expect(line.text).toContain('may exhaust');
  });

  it('zero remaining: any nonzero estimate warns, a zero-call op does not', () => {
    expect(lpApiBudgetText(1, { max: 15000, remaining: 0 }, {}).warn).toBe(true);
    expect(lpApiBudgetText(0, { max: 15000, remaining: 0 }, {}).warn).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
describe('estimator × formatter — the pair the UI actually renders', () => {
  it('a big org against a nearly-spent budget produces the full warned sentence', () => {
    const keys = Array.from({ length: 600 }, (_, i) => `Obj${i % 200}__c`);
    const plan = lpAssignmentsScanPlan({
      pages: 600, describeKeys: keys, pendingEntityIds: 250,
      profilesLoaded: false, ...CHUNKS
    });
    expect(plan.calls).toBe(103);           // 60 + 40 + 2 + 1
    const line = lpApiBudgetText(plan.calls, { max: 15000, remaining: 100 },
      { moreIf: 'page metadata names more objects' });
    expect(line.warn).toBe(true);
    expect(line.text).toContain(`≈${fmt(103)} API calls now, more if page metadata names more objects`);
    expect(line.text).toContain(`org has ${fmt(100)} of ${fmt(15000)} daily API calls remaining`);
    expect(line.text).toContain('may exhaust');
  });
});
