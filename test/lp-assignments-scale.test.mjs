// L5 — "Who sees what?" / "What a user sees" at enterprise scale.
//
// The bug class these guard against: scanAllPageAssignments() ran THREE per-page
// fan-outs interleaved inside one batch-of-5 loop —
//   • one Tooling GET per FlexiPage,
//   • one sObject describe per PAGE (fetchCustomObjectOrgDefaults memoized
//     nothing, so 600 record pages over 200 objects paid 600 describes where
//     200 answer the question), at concurrency exactly 1,
//   • one EntityDefinition SOQL query per unresolved 01I… id, one id at a time.
// ~1,400 round-trips for an org the user can see in one screen.
//
// The fix is arithmetic, and the arithmetic lives in column-0 functions in
// lightning-pages.js so test/extract.mjs can materialize them standalone:
//   lpDescribePlan            — the DEDUPE: unique objects, and which page reads
//                               which describe. This is the 3× on its own.
//   lpBatchChunkPlan          — how N reads become ceil(N/chunk) batch calls
//   lpRunPool                 — the pool the chunks are driven through; results
//                               must stay in INPUT order however they settle
//   lpScanPct                 — progress counted in ITEMS, monotonic, never 100
//                               before the last item settles
//   lpOrgDefaultsFromDescribe — one describe replayed per page on that object.
//                               If this drifts from the single-page path, the
//                               dedupe starts badging the wrong page.
//   lpAppendTarget            — the viewport window for the RENDER (never for
//                               the data — see the note in openProfileMap)
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

const {
  lpBatchChunkPlan, lpDescribePlan, lpScanPct, lpAppendTarget,
  lpOrgDefaultsFromDescribe, lpRunPool
} = extractFunctions('lightning-pages.js', [
  'lpBatchChunkPlan', 'lpDescribePlan', 'lpScanPct', 'lpAppendTarget',
  'lpOrgDefaultsFromDescribe', 'lpRunPool'
]);

// The real constants lightning-pages.js passes in.
const PAGE_CHUNK = 10;   // LP_SCAN_PAGE_CHUNK — FlexiPage Metadata compounds are large
const DESC_CHUNK = 5;    // LP_SCAN_DESC_CHUNK — describes are the largest read here
const STEP       = 30;   // LP_WSW_RENDER_STEP
const LOOKAHEAD  = 600;  // LP_WSW_LOOKAHEAD_PX

const tick = ms => new Promise(r => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════
describe('lpDescribePlan — the dedupe (the whole point of L5)', () => {
  it('600 record pages spanning 200 objects cost 200 describes, not 600', () => {
    // Every page is a record page; the org has 200 objects, 3 pages each.
    const keys = Array.from({ length: 600 }, (_, i) => `Obj${i % 200}__c`);
    const plan = lpDescribePlan(keys);

    expect(plan.pages).toBe(600);
    expect(plan.applicable).toBe(600);
    expect(plan.describes).toBe(200);     // ← what the run pays for
    expect(plan.saved).toBe(400);         // ← what the dedupe removed
    expect(plan.targets.length).toBe(200);
    expect(new Set(plan.targets).size).toBe(200);
  });

  it('points every page at the ONE describe for its object', () => {
    const keys = ['Account', 'Contact', 'Account', 'Account', 'Contact'];
    const plan = lpDescribePlan(keys);
    expect(plan.targets).toEqual(['Account', 'Contact']);
    expect(plan.byIndex).toEqual([0, 1, 0, 0, 1]);
    // Every applicable page resolves to a target that exists.
    for (let i = 0; i < keys.length; i++) {
      expect(plan.targets[plan.byIndex[i]]).toBe(keys[i]);
    }
  });

  it('marks pages no describe applies to with -1 and never counts them', () => {
    // null = no object (Home / App / Utility Bar), or Draft / Obsolete — the
    // same predicate the old code used to skip the check.
    const plan = lpDescribePlan(['Account', null, 'Account', undefined, '', 'Case']);
    expect(plan.pages).toBe(6);
    expect(plan.applicable).toBe(3);
    expect(plan.describes).toBe(2);
    expect(plan.saved).toBe(1);
    expect(plan.byIndex).toEqual([0, -1, 0, -1, -1, 1]);
  });

  it('an org where every page has its own object saves nothing and says so', () => {
    const plan = lpDescribePlan(Array.from({ length: 40 }, (_, i) => `O${i}__c`));
    expect(plan.describes).toBe(40);
    expect(plan.saved).toBe(0);
  });

  it('dedupes on the RESOLVED name — id and name spellings must be merged first', () => {
    // lightning-pages.js resolves 01I… ids through _lpEntityNames BEFORE building
    // the keys. This test pins the consequence of NOT doing that: the plan is a
    // string dedupe, so two spellings of one object would cost two describes.
    const unresolved = lpDescribePlan(['01I5g000000XyzAAA', 'MyObj__c']);
    expect(unresolved.describes).toBe(2);          // the bug, if resolution is skipped
    const resolved = lpDescribePlan(['MyObj__c', 'MyObj__c']);
    expect(resolved.describes).toBe(1);            // what the caller actually sends
  });

  it('is total for junk input rather than inventing work', () => {
    expect(lpDescribePlan(null).describes).toBe(0);
    expect(lpDescribePlan([]).targets).toEqual([]);
    expect(lpDescribePlan([]).saved).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════
describe('lpBatchChunkPlan — N reads → ceil(N/chunk) round-trips', () => {
  it('cuts 600 page reads into 60 calls at the page chunk size', () => {
    const chunks = lpBatchChunkPlan(600, PAGE_CHUNK);
    expect(chunks.length).toBe(60);
    expect(chunks[0]).toEqual({ index: 0, start: 0, len: 10 });
    expect(chunks[59]).toEqual({ index: 59, start: 590, len: 10 });
  });

  it('cuts 200 deduped describes into 40 calls at the describe chunk size', () => {
    const chunks = lpBatchChunkPlan(200, DESC_CHUNK);
    expect(chunks.length).toBe(40);
    expect(chunks.reduce((n, c) => n + c.len, 0)).toBe(200);
  });

  it('the whole enterprise scan is ~100 calls where it used to be ~1,400', () => {
    const pages = 600, objects = 200;
    const calls = lpBatchChunkPlan(pages, PAGE_CHUNK).length +
                  lpBatchChunkPlan(objects, DESC_CHUNK).length +
                  1;   // one chunked EntityDefinition query for the whole org
    expect(calls).toBe(101);
    // What it replaced: one GET per page + one describe PER PAGE + one
    // EntityDefinition query per page carrying an unresolved id.
    const before = pages + pages + objects;
    expect(before).toBe(1400);
    expect(calls).toBeLessThan(before / 13);
  });

  it('covers every input position exactly once, in order', () => {
    const chunks = lpBatchChunkPlan(23, PAGE_CHUNK);
    expect(chunks.map(c => [c.start, c.len])).toEqual([[0, 10], [10, 10], [20, 3]]);
    const seen = [];
    for (const c of chunks) for (let i = 0; i < c.len; i++) seen.push(c.start + i);
    expect(seen).toEqual(Array.from({ length: 23 }, (_, i) => i));
  });

  it('clamps to the server ceiling of 25 instead of sending a 26th subrequest', () => {
    expect(lpBatchChunkPlan(100, 50)[0].len).toBe(25);
    expect(lpBatchChunkPlan(100, 25).length).toBe(4);
    expect(lpBatchChunkPlan(26, 25).map(c => c.len)).toEqual([25, 1]);
  });

  it('falls back to 25 for junk sizes rather than one call per item', () => {
    expect(lpBatchChunkPlan(50, 0)[0].len).toBe(25);
    expect(lpBatchChunkPlan(50, -3)[0].len).toBe(25);
    expect(lpBatchChunkPlan(50, NaN)[0].len).toBe(25);
    expect(lpBatchChunkPlan(50, undefined)[0].len).toBe(25);
  });

  it('zero items is zero HTTP calls', () => {
    expect(lpBatchChunkPlan(0, PAGE_CHUNK)).toEqual([]);
    expect(lpBatchChunkPlan(-5, PAGE_CHUNK)).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════
// _lpBatchRead drives lpBatchChunkPlan through lpRunPool and writes each item
// back at c.start + i — a position fixed BEFORE any request goes out. These
// tests reproduce that reassembly and prove completion order cannot reorder it.
describe('batched reads keep INPUT order however the batches settle', () => {
  async function runBatched(items, chunkSize, concurrency) {
    const out = new Array(items.length);
    const chunks = lpBatchChunkPlan(items.length, chunkSize);
    const settleOrder = [];
    let settled = 0;
    const progress = [];
    await lpRunPool(chunks, async (c) => {
      const slice = items.slice(c.start, c.start + c.len);
      // Later chunks finish FIRST — the pathological case for positional writes.
      await tick((chunks.length - c.index) * 2);
      settleOrder.push(c.index);
      for (let i = 0; i < slice.length; i++) out[c.start + i] = `R:${slice[i]}`;
      settled += c.len;
      progress.push(settled);
      return true;
    }, { concurrency });
    return { out, settleOrder, progress };
  }

  it('reassembles out-of-order batches into input order', async () => {
    const items = Array.from({ length: 23 }, (_, i) => `p${i}`);
    const { out, settleOrder } = await runBatched(items, 10, 3);
    expect(out).toEqual(items.map(p => `R:${p}`));
    // Guard the guard: the batches really did settle out of order.
    expect(settleOrder).not.toEqual([0, 1, 2]);
  });

  it('fills every slot — no page is left undefined when nothing stops the run', async () => {
    const items = Array.from({ length: 47 }, (_, i) => i);
    const { out } = await runBatched(items, DESC_CHUNK, 3);
    expect(out.filter(v => v === undefined).length).toBe(0);
    expect(out.length).toBe(47);
  });

  it('progress is monotonic and counted in ITEMS, not batches', async () => {
    const items = Array.from({ length: 47 }, (_, i) => i);
    const { progress } = await runBatched(items, DESC_CHUNK, 3);
    expect(progress.length).toBe(10);            // 10 batch calls
    expect(progress[progress.length - 1]).toBe(47);   // ...but 47 items counted
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]).toBeGreaterThan(progress[i - 1]);
    }
  });

  it('a Stop leaves undispatched slots ABSENT, never empty-but-present', async () => {
    const items = Array.from({ length: 40 }, (_, i) => i);
    const out = new Array(items.length);
    let dispatched = 0;
    const run = await lpRunPool(lpBatchChunkPlan(items.length, 10), async (c) => {
      dispatched++;
      for (let i = 0; i < c.len; i++) out[c.start + i] = `R:${items[c.start + i]}`;
      return true;
    }, { concurrency: 1, shouldStop: () => dispatched >= 2 });

    expect(run.complete).toBe(false);
    expect(run.stopped).toBe(true);
    expect(out.slice(0, 20).every(v => typeof v === 'string')).toBe(true);
    // The unread half is undefined — "we never read this", not "this is empty".
    expect(out.slice(20).every(v => v === undefined)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
describe('lpScanPct — progress per ITEM, and never backwards', () => {
  it('counts one item per page read plus one per DEDUPED describe', () => {
    const total = 600 + 200;
    expect(lpScanPct(0, total, 0)).toBe(0);
    expect(lpScanPct(400, total, 0)).toBe(50);
    expect(lpScanPct(600, total, 0)).toBe(75);   // every page read, no describe yet
    expect(lpScanPct(800, total, 0)).toBe(100);
  });

  it('never reports 100 until the last item has settled', () => {
    // 799/800 rounds to 100 — and 100 with a read still outstanding is the same
    // lie as claiming coverage a pass never reached.
    expect(lpScanPct(799, 800, 0)).toBe(99);
    expect(lpScanPct(800, 800, 0)).toBe(100);
    expect(lpScanPct(9999, 10000, 0)).toBe(99);
  });

  it('survives the denominator being revised once the real count is measured', () => {
    // Pass 1 runs against an ESTIMATED object count from the list query; the
    // real figure is only known after every page's metadata is in.
    const estimated = 600 + 260;
    const p1 = lpScanPct(600, estimated, 0);        // 69
    const measured = 600 + 200;
    const p2 = lpScanPct(600, measured, p1);        // 75 — total shrank, pct rose
    expect(p1).toBe(69);
    expect(p2).toBe(75);
    // And the reverse: a total that GREW must not drag the bar backwards.
    const grew = lpScanPct(600, 600 + 400, p2);
    expect(grew).toBe(p2);
  });

  it('is monotonic under any sequence of revisions', () => {
    let floor = 0;
    const seq = [[10, 100], [20, 300], [60, 120], [61, 400], [400, 400]];
    const seen = seq.map(([d, t]) => (floor = lpScanPct(d, t, floor)));
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[seen.length - 1]).toBe(100);
  });

  it('clamps rather than emitting a number no progress bar can show', () => {
    expect(lpScanPct(900, 800, 0)).toBe(100);
    expect(lpScanPct(-5, 800, 0)).toBe(0);
    expect(lpScanPct(0, 0, 0)).toBe(100);        // nothing to read is nothing to wait for
    expect(lpScanPct(5, 10, 999)).toBe(100);     // floor is clamped too
    expect(lpScanPct(NaN, NaN, NaN)).toBe(100);
  });
});

// ══════════════════════════════════════════════════════════════
// One describe now answers every page on that object. That is only safe if the
// per-page replay is byte-identical to what the per-page describe used to
// compute — these pin the verdicts the dedupe depends on.
describe('lpOrgDefaultsFromDescribe — one describe, many pages', () => {
  const PAGES = [
    { Id: '0M0aa000000AAAAAAA', DeveloperName: 'Account_Record_Page' },
    { Id: '0M0bb000000BBBBBBB', DeveloperName: 'Account_Alt_Page' }
  ];
  const describeFor = pageId => ({
    actionOverrides: [
      { name: 'View', type: 'Flexipage', formFactor: 'Large', pageId },
      { name: 'Edit', type: 'Standard', formFactor: 'Large', pageId: '0M0zz000000ZZZZZZZ' }
    ]
  });

  it('badges the page the describe names, and only that page', () => {
    const desc = describeFor('0M0aa000000AAAAAAA');

    const winner = lpOrgDefaultsFromDescribe(desc, PAGES[0].Id, 'Account_Record_Page', PAGES);
    expect(winner.conclusive).toBe(true);
    expect(winner.defaults).toEqual([{ formFactor: 'Large', default: true, _source: 'describe' }]);

    // Same describe, replayed for the OTHER page on the same object.
    const loser = lpOrgDefaultsFromDescribe(desc, PAGES[1].Id, 'Account_Alt_Page', PAGES);
    expect(loser.defaults).toEqual([]);
    // Conclusive: a describe naming a different page is a successful "no", so
    // the caller clears the debug log instead of crying "detection failed".
    expect(loser.conclusive).toBe(true);
  });

  it('matches 15-char against 18-char ids, in both directions and any casing', () => {
    const short = lpOrgDefaultsFromDescribe(
      describeFor('0M0aa000000AAAA'), '0M0aa000000AAAAAAA', 'Account_Record_Page', PAGES);
    expect(short.defaults.length).toBe(1);

    const cased = lpOrgDefaultsFromDescribe(
      describeFor('0m0AA000000aaaaAAA'), '0M0aa000000AAAAAAA', 'Account_Record_Page', PAGES);
    expect(cased.defaults.length).toBe(1);
  });

  it('falls back to DeveloperName when the id forms disagree', () => {
    // describe names a page id that is NOT ours, but which resolves in the page
    // list to a record whose DeveloperName is the FullName we were handed.
    const v = lpOrgDefaultsFromDescribe(
      describeFor('0M0bb000000BBBBBBB'), null, 'Account-Account_Alt_Page', PAGES);
    expect(v.defaults.length).toBe(1);          // matched via the post-hyphen short form
    expect(v.conclusive).toBe(true);
  });

  it('maps Small form factor to the mobile label and defaults the rest to Large', () => {
    const small = lpOrgDefaultsFromDescribe(
      { actionOverrides: [{ name: 'view', formFactor: 'SMALL', pageId: PAGES[0].Id }] },
      PAGES[0].Id, 'Account_Record_Page', PAGES);
    expect(small.defaults[0].formFactor).toBe('Small');

    const missing = lpOrgDefaultsFromDescribe(
      { actionOverrides: [{ name: 'View', pageId: PAGES[0].Id }] },
      PAGES[0].Id, 'Account_Record_Page', PAGES);
    expect(missing.defaults[0].formFactor).toBe('Large');
  });

  it('a FAILED describe is NOT a "not the org default" — it stays inconclusive', () => {
    const v = lpOrgDefaultsFromDescribe({ error: 'HTTP 403: insufficient access' },
      PAGES[0].Id, 'Account_Record_Page', PAGES);
    expect(v.defaults).toEqual([]);
    expect(v.conclusive).toBe(false);                       // → debug panel shows
    expect(v.log.describeError).toBe('HTTP 403: insufficient access');
  });

  it('an unread batch slot is reported as unread, not as an empty describe', () => {
    const v = lpOrgDefaultsFromDescribe(undefined, PAGES[0].Id, 'Account_Record_Page', PAGES);
    expect(v.conclusive).toBe(false);
    expect(v.log.describeError).toBe('no describe result');
  });

  it('View overrides with no pageId settle nothing', () => {
    const v = lpOrgDefaultsFromDescribe(
      { actionOverrides: [{ name: 'View', type: 'Standard', formFactor: 'Large' }] },
      PAGES[0].Id, 'Account_Record_Page', PAGES);
    expect(v.conclusive).toBe(false);
    expect(v.log.describeNoMatch).toBe(true);
    expect(v.log.describeError).toBe('ok');
  });

  it('a describe with no actionOverrides array settles nothing either', () => {
    const v = lpOrgDefaultsFromDescribe({ name: 'Account' }, PAGES[0].Id, 'X', PAGES);
    expect(v.conclusive).toBe(false);
    expect(v.log.describeError).toBe('ok');
  });

  it('never matches a non-View action', () => {
    const v = lpOrgDefaultsFromDescribe(
      { actionOverrides: [{ name: 'Edit', formFactor: 'Large', pageId: PAGES[0].Id }] },
      PAGES[0].Id, 'Account_Record_Page', PAGES);
    expect(v.defaults).toEqual([]);
    expect(v.conclusive).toBe(false);         // no VIEW override carried a pageId
  });

  it('records what it compared, so an unresolved page can be diagnosed', () => {
    const v = lpOrgDefaultsFromDescribe(
      { actionOverrides: [{ name: 'View', formFactor: 'Large' }] },
      PAGES[0].Id, 'Account_Record_Page', PAGES);
    expect(v.log.pageIdUsed).toBe(PAGES[0].Id);
    expect(v.log.devNameUsed).toBe('Account_Record_Page');
    expect(v.log.describeOverrides).toBe(1);
    expect(v.log.allViewOverrides.length).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════
describe('lpAppendTarget — the viewport window (render only, never data)', () => {
  const base = { clientHeight: 800, scrollHeight: 4000, scrollTop: 0,
                 shown: 30, total: 600, step: STEP, threshold: LOOKAHEAD };

  it('renders the first step immediately — nothing is on screen yet', () => {
    expect(lpAppendTarget({ ...base, shown: 0, scrollHeight: 0 })).toBe(30);
  });

  it('holds while the user is nowhere near the bottom', () => {
    // 4000 - 0 - 800 = 3200px of runway, far past the 600px lookahead.
    expect(lpAppendTarget(base)).toBe(30);
  });

  it('appends the next step once the bottom is within the lookahead', () => {
    // remaining = 4000 - 2700 - 800 = 500 <= 600
    expect(lpAppendTarget({ ...base, scrollTop: 2700 })).toBe(60);
  });

  it('appends exactly at the threshold, not one pixel later', () => {
    expect(lpAppendTarget({ ...base, scrollTop: 2600 })).toBe(60);   // remaining 600
    expect(lpAppendTarget({ ...base, scrollTop: 2599 })).toBe(30);   // remaining 601
  });

  it('keeps growing while the content does not fill the container', () => {
    // No scrollbar means no scroll event will ever ask for more — a short list
    // must render completely instead of stalling at the first step.
    let shown = 0;
    for (let i = 0; i < 10 && shown < 12; i++) {
      shown = lpAppendTarget({ ...base, shown, total: 12, scrollHeight: 400 });
    }
    expect(shown).toBe(12);
  });

  it('grows when the container has no measured height at all', () => {
    // Degenerate (hidden / not laid out): fall back to rendering everything
    // rather than showing a truncated list with no way to reach the rest.
    expect(lpAppendTarget({ ...base, clientHeight: 0, scrollHeight: 0 })).toBe(60);
    expect(lpAppendTarget({ ...base, clientHeight: 0, scrollHeight: 4000 })).toBe(60);
  });

  it('never overshoots the total and always terminates', () => {
    expect(lpAppendTarget({ ...base, shown: 590, scrollTop: 3200 })).toBe(600);
    expect(lpAppendTarget({ ...base, shown: 600, scrollTop: 3200 })).toBe(600);
    expect(lpAppendTarget({ ...base, shown: 900, total: 600 })).toBe(600);
  });

  it('a full 600-card org reaches the end in total/step fills', () => {
    let shown = 0, fills = 0;
    while (shown < 600 && fills < 100) {
      // Pin the scroll to the bottom so every fill is requested.
      shown = lpAppendTarget({ ...base, shown, scrollTop: 3200 });
      fills++;
    }
    expect(shown).toBe(600);
    expect(fills).toBe(20);
  });

  it('is total for junk input rather than rendering nothing', () => {
    expect(lpAppendTarget(null)).toBe(0);
    expect(lpAppendTarget({ total: 50 })).toBe(30);            // no geometry → grow
    // Junk step falls back to 30 rather than 0 (which would render nothing ever)
    // or 1 (which would repaint once per card).
    expect(lpAppendTarget({ ...base, step: 0, scrollTop: 3200 })).toBe(60);
    expect(lpAppendTarget({ ...base, step: -4, scrollTop: 3200 })).toBe(60);
    expect(lpAppendTarget({ ...base, step: NaN, scrollTop: 3200 })).toBe(60);
    // ...but geometry still decides WHETHER to grow: junk step, mid-scroll.
    expect(lpAppendTarget({ ...base, step: 0 })).toBe(30);
  });
});
