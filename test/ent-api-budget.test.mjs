// E3 — API-budget awareness on the WRITE paths.
//
// Big orgs meter API calls; the daily pool is shared with every other
// integration. These tests pin the pure layer in studio-transfer.js:
//  - sftkEstimateRunCalls: call estimate derived from what
//    executeProfileTransfer (background.js) actually does — 2 describes per
//    node, COUNT() routing, 2000-row REST pages vs the Bulk-query 4-call
//    floor, 200-record Collections batches vs the Bulk-ingest 7-call floor,
//    200-parent-id child query chunks, child-first connect updates, and the
//    once-per-run owner-index query when owner matching is on.
//  - sftkPlanFromCounts / sftkPlanFromRunSummary: plan builders (pre-run
//    preview counts / post-run actuals). Unknown stays null — never zero.
//  - sftkBudgetCacheFresh: the 5-minute /limits cache decision (the meter
//    read itself costs a call — that's why it's cached).
//  - sftkExtractDailyApi: DailyApiRequests {Max, Remaining} → {max,
//    remaining} | null.
//  - sftkApiBudgetLine: the "≈N API calls · org has R of M daily calls
//    remaining" line; warn only when estimate EXCEEDS remaining; a missing
//    meter is SAID ("API budget unavailable"), never hidden; the estimate
//    always renders. Informational only — nothing here blocks a run.
//  - sftkEstimateSyncPlanCalls: the ring Sync Plan variant (push jobs route
//    through sftkEstimateRunCalls; overwrites add describe + 200-chunk
//    read/update floors).
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

const {
  sftkEstimateRunCalls, sftkPlanFromCounts, sftkPlanFromRunSummary,
  sftkApiBudgetLine, sftkEstimateSyncPlanCalls,
} = extractFunctions('studio-transfer.js', [
  'sftkEstimateRunCalls', 'sftkPlanFromCounts', 'sftkPlanFromRunSummary',
  'sftkApiBudgetLine', 'sftkEstimateSyncPlanCalls',
]);
// The /limits cache + parser were hoisted to the shared file both apps load
// (sftk-api-budget.js) so the popup gets the meter too — extract from there.
const { sftkBudgetCacheFresh, sftkExtractDailyApi } = extractFunctions('sftk-api-budget.js', [
  'sftkBudgetCacheFresh', 'sftkExtractDailyApi',
]);

const fmt = n => Number(n).toLocaleString();

// ════════════════════════════════════════════════════════════════
// sftkEstimateRunCalls — REST vs Bulk vs children vs owner matching
// ════════════════════════════════════════════════════════════════
describe('sftkEstimateRunCalls', () => {
  it('REST root: 2 describes + COUNT + 1 read page + ceil(n/200) writes', () => {
    const est = sftkEstimateRunCalls({ nodes: [{ records: 400, isRoot: true }] });
    expect(est.source).toBe(3);   // describe + COUNT + 1 page (400 < 2000)
    expect(est.target).toBe(3);   // describe + 2 collections batches
    expect(est.total).toBe(6);
    expect(est.known).toBe(true);
  });

  it('zero records: describes + COUNT + one read page are still paid, no write', () => {
    const est = sftkEstimateRunCalls({ nodes: [{ records: 0, isRoot: true }] });
    expect(est.source).toBe(3);   // describe + COUNT + the (empty) read
    expect(est.target).toBe(1);   // describe only — nothing to write
    expect(est.known).toBe(true);
  });

  it('records AT the threshold route to Bulk on both sides (>= not >)', () => {
    const est = sftkEstimateRunCalls({ nodes: [{ records: 2000, isRoot: true }] });
    expect(est.source).toBe(6);   // describe + COUNT + 4-call bulk-query floor
    expect(est.target).toBe(8);   // describe + 7-call bulk-ingest floor
  });

  it('one record below the threshold stays on REST/Collections', () => {
    const est = sftkEstimateRunCalls({ nodes: [{ records: 1999, isRoot: true }] });
    expect(est.source).toBe(3);   // describe + COUNT + 1 REST page (1999 < 2000)
    expect(est.target).toBe(11);  // describe + ceil(1999/200)=10 batches
  });

  it('profile.bulkThreshold overrides the 2000 default', () => {
    const bulk = sftkEstimateRunCalls({ bulkThreshold: 500, nodes: [{ records: 600, isRoot: true }] });
    expect(bulk.source).toBe(6);
    expect(bulk.target).toBe(8);
    const rest = sftkEstimateRunCalls({ bulkThreshold: 500, nodes: [{ records: 499, isRoot: true }] });
    expect(rest.source).toBe(3);
    expect(rest.target).toBe(4);  // describe + ceil(499/200)=3
  });

  it('child node: reads chunk by 200 parent ids, writes by 200 records', () => {
    const est = sftkEstimateRunCalls({ nodes: [
      { records: 100, isRoot: true },
      { records: 250, isRoot: false, parentRecords: 100 },
    ] });
    // root: (1 describe + COUNT + 1 page) src, (1 describe + 1 batch) tgt
    // child: 1 describe + max(ceil(100/200)=1, ceil(250/2000)=1) src,
    //        1 describe + ceil(250/200)=2 batches tgt
    expect(est.source).toBe(5);
    expect(est.target).toBe(5);
    expect(est.known).toBe(true);
  });

  it('a child whose parent scope is empty is skipped after its describes', () => {
    const est = sftkEstimateRunCalls({ nodes: [
      { records: 0, isRoot: true },
      { records: 50, isRoot: false, parentRecords: 0 },
    ] });
    expect(est.source).toBe(4);   // root 3 + child describe only
    expect(est.target).toBe(2);   // two describes, no writes
  });

  it('child-first adds the connect-step updates (ceil(n/200) more calls)', () => {
    const plain = sftkEstimateRunCalls({ nodes: [
      { records: 10, isRoot: true },
      { records: 300, isRoot: false, parentRecords: 10 },
    ] });
    const cf = sftkEstimateRunCalls({ nodes: [
      { records: 10, isRoot: true },
      { records: 300, isRoot: false, parentRecords: 10, childFirst: true },
    ] });
    expect(cf.target - plain.target).toBe(2);   // ceil(300/200) connect updates
    expect(cf.source).toBe(plain.source);
  });

  it('unknown record count → known:false, floors still counted', () => {
    const est = sftkEstimateRunCalls({ nodes: [{ records: null, isRoot: true }] });
    expect(est.known).toBe(false);
    expect(est.source).toBe(3);   // describe + COUNT + at-least-one page
    expect(est.target).toBe(2);   // describe + at-least-one write attempt
  });

  it('unknown parentRecords → known:false, one read floor', () => {
    const est = sftkEstimateRunCalls({ nodes: [
      { records: 100, isRoot: true },
      { records: 40, isRoot: false, parentRecords: null },
    ] });
    expect(est.known).toBe(false);
  });

  it('bulkWrite from run actuals pins the write path over the threshold', () => {
    // 100 records but the engine SAID it used Bulk (e.g. threshold was lower
    // at run time) — post-run must reflect what actually happened.
    const viaBulk = sftkEstimateRunCalls({ nodes: [{ records: 100, isRoot: true, bulkWrite: true }] });
    expect(viaBulk.target).toBe(8);   // describe + 7-call bulk floor
    // 5000 records but Collections was used (bulkWrite:false beats >= thr).
    const viaRest = sftkEstimateRunCalls({ nodes: [{ records: 5000, isRoot: true, bulkWrite: false }] });
    expect(viaRest.target).toBe(26);  // describe + ceil(5000/200)=25
  });

  it('owner matching on adds exactly one target call (the owner index)', () => {
    const base = { nodes: [{ records: 400, isRoot: true }] };
    const off = sftkEstimateRunCalls({ ...base, ownerMatch: false });
    const on  = sftkEstimateRunCalls({ ...base, ownerMatch: true });
    expect(on.target - off.target).toBe(1);
    expect(on.source).toBe(off.source);
  });

  it('owner matching costs nothing when no node has records', () => {
    const est = sftkEstimateRunCalls({ ownerMatch: true, nodes: [{ records: 0, isRoot: true }] });
    expect(est.target).toBe(1);   // describe only — engine never reaches owners
  });

  it('owner matching IS counted when counts are unknown (they might have records)', () => {
    const off = sftkEstimateRunCalls({ ownerMatch: false, nodes: [{ records: null, isRoot: true }] });
    const on  = sftkEstimateRunCalls({ ownerMatch: true,  nodes: [{ records: null, isRoot: true }] });
    expect(on.target - off.target).toBe(1);
  });

  it('empty / malformed plans return zeros, never throw', () => {
    expect(sftkEstimateRunCalls(null)).toEqual({ total: 0, source: 0, target: 0, known: true });
    expect(sftkEstimateRunCalls({})).toEqual({ total: 0, source: 0, target: 0, known: true });
  });
});

// ════════════════════════════════════════════════════════════════
// Plan builders — preview counts (pre-run) and run summary (post-run)
// ════════════════════════════════════════════════════════════════
describe('sftkPlanFromCounts', () => {
  it('flattens the counts tree in parallel with the profile tree', () => {
    const counts = { count: 10, children: [{ count: null }] };
    const tree = { objectType: 'Account', children: [{ childSObject: 'Contact', insertOrder: 'childFirst' }] };
    const plan = sftkPlanFromCounts(counts, tree, 500, true);
    expect(plan.bulkThreshold).toBe(500);
    expect(plan.ownerMatch).toBe(true);
    expect(plan.nodes).toHaveLength(2);
    expect(plan.nodes[0]).toMatchObject({ records: 10, isRoot: true, parentRecords: null, childFirst: false });
    // a failed COUNT() stays null — the estimator reports known:false
    // instead of inventing a number
    expect(plan.nodes[1]).toMatchObject({ records: null, isRoot: false, parentRecords: 10, childFirst: true });
  });

  it('ownerMatch defaults to false when omitted', () => {
    const plan = sftkPlanFromCounts({ count: 1 }, { objectType: 'Account' }, undefined);
    expect(plan.ownerMatch).toBe(false);
  });
});

describe('sftkPlanFromRunSummary', () => {
  const tree = { objectType: 'Account', children: [{ childSObject: 'Contact' }] };

  it('records = created + failed + notProcessed; viaBulk pins the write path', () => {
    const plan = sftkPlanFromRunSummary(tree,
      { Account: { created: 5, failed: 1, notProcessed: 2, viaBulk: true } }, 2000, false);
    expect(plan.nodes[0]).toMatchObject({ records: 8, bulkWrite: true, isRoot: true });
  });

  it('an object absent from the summary is UNKNOWN, never zero', () => {
    const plan = sftkPlanFromRunSummary(tree, { Account: { created: 3, failed: 0 } }, 2000, false);
    expect(plan.nodes[1].records).toBe(null);
    expect(plan.nodes[1].bulkWrite).toBe(null);
    expect(sftkEstimateRunCalls(plan).known).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// Cache decision — the /limits read costs a call, hence the 5-min TTL
// ════════════════════════════════════════════════════════════════
describe('sftkBudgetCacheFresh', () => {
  const NOW = 1_800_000_000_000;
  const TTL = 5 * 60 * 1000;

  it('missing / malformed entries are stale', () => {
    expect(sftkBudgetCacheFresh(null, NOW)).toBe(false);
    expect(sftkBudgetCacheFresh({}, NOW)).toBe(false);
    expect(sftkBudgetCacheFresh({ fetchedAt: 'yesterday' }, NOW)).toBe(false);
  });

  it('fresh within 5 minutes, stale at exactly 5', () => {
    expect(sftkBudgetCacheFresh({ fetchedAt: NOW }, NOW)).toBe(true);
    expect(sftkBudgetCacheFresh({ fetchedAt: NOW - TTL + 1 }, NOW)).toBe(true);
    expect(sftkBudgetCacheFresh({ fetchedAt: NOW - TTL }, NOW)).toBe(false);
  });

  it('a clock that moved backwards counts as stale (re-read, do not trust)', () => {
    expect(sftkBudgetCacheFresh({ fetchedAt: NOW + 1000 }, NOW)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// /limits payload extraction
// ════════════════════════════════════════════════════════════════
describe('sftkExtractDailyApi', () => {
  it('pulls DailyApiRequests {Max, Remaining}', () => {
    expect(sftkExtractDailyApi({ DailyApiRequests: { Max: 100000, Remaining: 97321 } }))
      .toEqual({ max: 100000, remaining: 97321 });
  });

  it('null on missing key, null payload, or non-numeric values', () => {
    expect(sftkExtractDailyApi({})).toBe(null);
    expect(sftkExtractDailyApi(null)).toBe(null);
    expect(sftkExtractDailyApi({ DailyApiRequests: { Max: 'lots', Remaining: 5 } })).toBe(null);
    expect(sftkExtractDailyApi({ DailyApiRequests: { Max: 100 } })).toBe(null);
  });
});

// ════════════════════════════════════════════════════════════════
// The budget line — formatting with and without a readable meter
// ════════════════════════════════════════════════════════════════
describe('sftkApiBudgetLine', () => {
  it('estimate only (meters not fetched yet): "≈N API calls"', () => {
    const line = sftkApiBudgetLine({ total: 1234, known: true }, []);
    expect(line.text).toBe(`≈${fmt(1234)} API calls`);
    expect(line.warn).toBe(false);
  });

  it('singular for exactly one call', () => {
    expect(sftkApiBudgetLine({ total: 1, known: true }, []).text).toBe('≈1 API call');
  });

  it('unknown counts add "+" — the estimate is a floor, and says so', () => {
    expect(sftkApiBudgetLine({ total: 42, known: false }, []).text).toBe('≈42+ API calls');
  });

  it('renders each org meter: "org has R of M daily API calls remaining"', () => {
    const line = sftkApiBudgetLine({ total: 500, known: true },
      [{ label: 'Dev', budget: { max: 100000, remaining: 97000 }, calls: 500 }]);
    expect(line.text).toBe(`≈500 API calls · Dev has ${fmt(97000)} of ${fmt(100000)} daily API calls remaining`);
    expect(line.warn).toBe(false);
  });

  it('warns when the estimate EXCEEDS an org\'s remaining budget — informs, never blocks', () => {
    const line = sftkApiBudgetLine({ total: 98000, known: true },
      [{ label: 'Dev', budget: { max: 100000, remaining: 97000 }, calls: 98000 }]);
    expect(line.warn).toBe(true);
    expect(line.text).toMatch(/^⚠ /);
    expect(line.text).toContain("may exhaust the org's remaining daily API budget");
    expect(line.text).toContain('(Dev)');
  });

  it('estimate equal to remaining is NOT over', () => {
    const line = sftkApiBudgetLine({ total: 97000, known: true },
      [{ label: 'Dev', budget: { max: 100000, remaining: 97000 }, calls: 97000 }]);
    expect(line.warn).toBe(false);
  });

  it('an unreadable meter is SAID, and the estimate still renders', () => {
    const line = sftkApiBudgetLine({ total: 12, known: true },
      [{ label: 'UAT', budget: null, calls: 12 }]);
    expect(line.text).toBe('≈12 API calls · UAT: API budget unavailable');
    expect(line.warn).toBe(false);
  });

  it('multiple orgs: per-org meters, warn names every org that is over', () => {
    const line = sftkApiBudgetLine({ total: 600, known: true }, [
      { label: 'Source', budget: { max: 100000, remaining: 50 }, calls: 300 },
      { label: 'Target', budget: { max: 15000, remaining: 100 }, calls: 300 },
    ]);
    expect(line.warn).toBe(true);
    expect(line.text).toContain('budgets (Source, Target)');
  });
});

// ════════════════════════════════════════════════════════════════
// Ring Sync Plan estimator — pushes via sftkEstimateRunCalls, overwrite floors
// ════════════════════════════════════════════════════════════════
describe('sftkEstimateSyncPlanCalls', () => {
  const flat = { objectType: 'Account' };

  it('push-only job routes through the transfer estimator', () => {
    const est = sftkEstimateSyncPlanCalls([{ label: 'UAT', push: 250, ovw: 0 }], { tree: flat });
    expect(est.source).toBe(3);           // describe + COUNT + 1 page
    expect(est.perOrg).toEqual([{ label: 'UAT', calls: 3 }]);  // describe + 2 batches
    expect(est.total).toBe(6);
    expect(est.known).toBe(true);
  });

  it('push at the bulk threshold pays the bulk floors', () => {
    const est = sftkEstimateSyncPlanCalls([{ label: 'UAT', push: 2000, ovw: 0 }], { tree: flat });
    expect(est.source).toBe(6);
    expect(est.perOrg[0].calls).toBe(8);
  });

  it('overwrite-only job: describe + 200-chunked reads and updates per side', () => {
    const est = sftkEstimateSyncPlanCalls([{ label: 'UAT', push: 0, ovw: 250 }], { tree: flat });
    expect(est.source).toBe(3);           // describe + 2 id-chunk reads
    expect(est.perOrg[0].calls).toBe(3);  // describe + 2 update batches
    expect(est.known).toBe(true);
  });

  it('push + overwrite on the same org add up', () => {
    const est = sftkEstimateSyncPlanCalls([{ label: 'UAT', push: 250, ovw: 250 }], { tree: flat });
    expect(est.source).toBe(6);
    expect(est.perOrg[0].calls).toBe(6);
    expect(est.total).toBe(12);
  });

  it('multiple target orgs: perOrg aligns with sel by index, source aggregates', () => {
    const est = sftkEstimateSyncPlanCalls(
      [{ label: 'UAT', push: 250, ovw: 0 }, { label: 'QA', push: 0, ovw: 100 }], { tree: flat });
    expect(est.source).toBe(5);           // 3 (push reads) + 2 (ovw describe+read)
    expect(est.perOrg).toEqual([{ label: 'UAT', calls: 3 }, { label: 'QA', calls: 2 }]);
    expect(est.total).toBe(10);
  });

  it('a tree with children makes a push estimate a FLOOR (known:false) — child counts ride along unknowably', () => {
    const tree = { objectType: 'Account', children: [{ childSObject: 'Contact' }] };
    const est = sftkEstimateSyncPlanCalls([{ label: 'UAT', push: 250, ovw: 0 }], { tree });
    expect(est.known).toBe(false);
    // root: src 3 / tgt 3; child: src 1 + ceil(250/200)=2 → 3, tgt 1 + 1 floor = 2
    expect(est.source).toBe(6);
    expect(est.perOrg[0].calls).toBe(5);
  });

  it('owner matching and bulkThreshold pass through to the push estimator', () => {
    const off = sftkEstimateSyncPlanCalls([{ label: 'UAT', push: 250, ovw: 0 }], { tree: flat });
    const on  = sftkEstimateSyncPlanCalls([{ label: 'UAT', push: 250, ovw: 0 }], { tree: flat, ownerMatch: true });
    expect(on.perOrg[0].calls - off.perOrg[0].calls).toBe(1);
    const thr = sftkEstimateSyncPlanCalls([{ label: 'UAT', push: 600, ovw: 0 }], { tree: flat, bulkThreshold: 500 });
    expect(thr.perOrg[0].calls).toBe(8);  // bulk-ingest floor
  });

  it('nothing selected → zeros, never throws', () => {
    expect(sftkEstimateSyncPlanCalls([], { tree: flat }))
      .toEqual({ total: 0, source: 0, known: true, perOrg: [] });
    expect(sftkEstimateSyncPlanCalls([{ label: 'UAT', push: 0, ovw: 0 }], { tree: flat }).total).toBe(0);
    expect(sftkEstimateSyncPlanCalls(null, {}).total).toBe(0);
  });
});
