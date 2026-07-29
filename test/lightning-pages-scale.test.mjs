// P2 — Lightning Pages: org-default resolution at enterprise scale.
//
// The bug class these guard against: fetchOrgDefaults() used to fire an
// un-awaited fan-out of one Tooling GET per FlexiPage plus one sequential
// describe per object, on tab open, AFTER the view had already told the user it
// was done. In a 900-page org that is hundreds of unrequested calls landing on
// a "finished" screen.
//
// The fix is sizing + honesty, and both live in top-level column-0 functions in
// lightning-pages.js so test/extract.mjs can materialize them standalone:
//   lpOrgDefaultsPlan  — what a run costs (auto below a threshold, ask above it)
//   lpFormatEta        — the hedged human ETA beside the exact call count
//   lpRunPool          — the bounded rolling pool that replaced batch-of-5 / seq
//   lpOdRowState       — per-row "resolved / not resolved" honesty
//   lpOdSummary        — the strip sentence, which must never claim coverage it
//                        did not reach and must never invent a total
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

// lpOrgDefaultsPlan calls lpFormatEta, so they must share one scope.
const {
  lpOrgDefaultsPlan, lpFormatEta, lpRunPool, lpOdRowState, lpOdSummary
} = extractFunctions('lightning-pages.js', [
  'lpOrgDefaultsPlan', 'lpFormatEta', 'lpRunPool', 'lpOdRowState', 'lpOdSummary'
]);

// The real constants lightning-pages.js passes in.
const OPTS = { autoMax: 150, concurrency: 5 };

// ══════════════════════════════════════════════════════════════
describe('lpOrgDefaultsPlan — the size decision', () => {
  it('counts one call per page + one per object + the name lookups', () => {
    const p = lpOrgDefaultsPlan(40, 12, { ...OPTS, extraCalls: 1 });
    expect(p.pages).toBe(40);
    expect(p.objects).toBe(12);
    expect(p.extraCalls).toBe(1);
    expect(p.calls).toBe(53);
  });

  it('runs AUTOMATICALLY for a small org (the pre-existing behaviour)', () => {
    // A dev org: 40 pages over 12 objects = 52 calls. Nothing changes for it.
    expect(lpOrgDefaultsPlan(40, 12, OPTS).auto).toBe(true);
  });

  it('REFUSES to auto-run for a large org', () => {
    // The reported enterprise org: ~900 FlexiPages over ~300 objects.
    const p = lpOrgDefaultsPlan(900, 300, OPTS);
    expect(p.calls).toBe(1200);
    expect(p.auto).toBe(false);
  });

  it('puts the auto/ask boundary exactly at autoMax — inclusive', () => {
    expect(lpOrgDefaultsPlan(150, 0, OPTS).auto).toBe(true);   // == autoMax
    expect(lpOrgDefaultsPlan(151, 0, OPTS).auto).toBe(false);  // one over
  });

  it('honours a caller-supplied autoMax, including 0 (never auto)', () => {
    expect(lpOrgDefaultsPlan(1, 0, { autoMax: 0 }).auto).toBe(false);
    expect(lpOrgDefaultsPlan(0, 0, { autoMax: 0 }).auto).toBe(true);  // nothing to do
    expect(lpOrgDefaultsPlan(500, 0, { autoMax: 5000 }).auto).toBe(true);
  });

  it('estimates wall clock as calls/concurrency, so widening the pool shortens it', () => {
    const slow = lpOrgDefaultsPlan(600, 0, { ...OPTS, concurrency: 1, msPerCall: 300 });
    const fast = lpOrgDefaultsPlan(600, 0, { ...OPTS, concurrency: 5, msPerCall: 300 });
    expect(slow.estMs).toBe(180000);
    expect(fast.estMs).toBe(36000);
    expect(fast.estMs * 5).toBe(slow.estMs);
  });

  it('flags whether msPerCall was MEASURED or is still the default guess', () => {
    expect(lpOrgDefaultsPlan(10, 0, OPTS).measured).toBe(false);
    expect(lpOrgDefaultsPlan(10, 0, OPTS).msPerCall).toBe(300);
    const m = lpOrgDefaultsPlan(10, 0, { ...OPTS, msPerCall: 420 });
    expect(m.measured).toBe(true);
    expect(m.msPerCall).toBe(420);
  });

  it('never returns a negative or fractional count from junk input', () => {
    const p = lpOrgDefaultsPlan(-5, 2.7, { ...OPTS, extraCalls: -3 });
    expect(p.pages).toBe(0);
    expect(p.objects).toBe(2);
    expect(p.extraCalls).toBe(0);
    expect(p.calls).toBe(2);
  });

  it('an empty org costs nothing and needs no affordance', () => {
    const p = lpOrgDefaultsPlan(0, 0, OPTS);
    expect(p.calls).toBe(0);
    expect(p.auto).toBe(true);
    expect(p.estMs).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════
describe('lpFormatEta', () => {
  it('hedges every figure — it is an estimate and says so', () => {
    expect(lpFormatEta(4000)).toBe('about 4s');
    expect(lpFormatEta(90000)).toBe('about 1m 30s');
    expect(lpFormatEta(120000)).toBe('about 2m');
  });
  it('does not print "about 0s"', () => {
    expect(lpFormatEta(0)).toBe('under a second');
    expect(lpFormatEta(-100)).toBe('under a second');
    expect(lpFormatEta(undefined)).toBe('under a second');
  });
  it('quotes the enterprise case in minutes, not a meaningless second count', () => {
    // 1200 calls at 300ms over a pool of 5.
    expect(lpFormatEta(lpOrgDefaultsPlan(900, 300, OPTS).estMs)).toBe('about 1m 12s');
  });
});

// ══════════════════════════════════════════════════════════════
describe('lpRunPool — bounded rolling concurrency', () => {
  const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

  it('keeps INPUT order even when items finish out of order', async () => {
    const items = [40, 30, 20, 10, 0];
    const run = await lpRunPool(items, async (v) => { await tick(v); return `v${v}`; },
      { concurrency: 5 });
    expect(run.results).toEqual(['v40', 'v30', 'v20', 'v10', 'v0']);
    expect(run.complete).toBe(true);
    expect(run.done).toBe(5);
  });

  it('never exceeds the concurrency limit (this IS the fan-out fix)', async () => {
    let live = 0, peak = 0;
    const items = Array.from({ length: 40 }, (_, i) => i);
    await lpRunPool(items, async () => {
      live++; peak = Math.max(peak, live);
      await tick(1);
      live--;
    }, { concurrency: 5 });
    expect(peak).toBe(5);
    expect(peak).toBeLessThanOrEqual(5);
  });

  it('actually runs in parallel — the old Pass 2 was concurrency 1', async () => {
    let peak = 0, live = 0;
    await lpRunPool([1, 2, 3, 4, 5, 6], async () => {
      live++; peak = Math.max(peak, live); await tick(5); live--;
    }, { concurrency: 3 });
    expect(peak).toBe(3);
  });

  it('clamps the limit to the item count so 2 items never spawn 5 runners', async () => {
    let peak = 0, live = 0;
    await lpRunPool(['a', 'b'], async () => {
      live++; peak = Math.max(peak, live); await tick(2); live--;
    }, { concurrency: 5 });
    expect(peak).toBe(2);
  });

  it('a throwing worker is still a DONE item — one failure cannot stall the pool', async () => {
    const run = await lpRunPool([1, 2, 3], async (v) => {
      if (v === 2) throw new Error('boom');
      return v * 10;
    }, { concurrency: 2 });
    expect(run.results).toEqual([10, undefined, 30]);
    expect(run.done).toBe(3);
    expect(run.complete).toBe(true);
  });

  it('shouldStop halts the pool and reports the REAL count, not completion', async () => {
    let seen = 0;
    const run = await lpRunPool(Array.from({ length: 100 }, (_, i) => i), async (v) => {
      seen++; await tick(1); return v;
    }, { concurrency: 2, shouldStop: () => seen >= 6 });
    expect(run.stopped).toBe(true);
    expect(run.complete).toBe(false);
    expect(run.total).toBe(100);
    expect(run.done).toBeLessThan(100);
    expect(seen).toBeLessThan(100);
  });

  it('a stop that lands AFTER the last item still counts as complete coverage', async () => {
    // Every item settled, so calling it partial would under-report coverage
    // exactly as dishonestly as over-reporting it.
    let done = 0;
    const run = await lpRunPool([1, 2, 3], async (v) => { done++; return v; },
      { concurrency: 1, shouldStop: () => done >= 3 });
    expect(run.done).toBe(3);
    expect(run.complete).toBe(true);
    expect(run.stopped).toBe(true);   // the flag is honest too
  });

  it('reports monotonic progress against the true total', async () => {
    const seq = [];
    await lpRunPool([1, 2, 3, 4], async (v) => v, {
      concurrency: 2,
      onProgress: (d, t) => seq.push([d, t])
    });
    expect(seq.map(x => x[0])).toEqual([1, 2, 3, 4]);
    expect(seq.every(x => x[1] === 4)).toBe(true);
  });

  it('an empty list completes without spawning a runner', async () => {
    let called = false;
    const run = await lpRunPool([], async () => { called = true; }, { concurrency: 5 });
    expect(called).toBe(false);
    expect(run.complete).toBe(true);
    expect(run.total).toBe(0);
  });

  it('survives a non-array input rather than throwing into the UI', async () => {
    const run = await lpRunPool(null, async () => 1, { concurrency: 5 });
    expect(run.total).toBe(0);
    expect(run.complete).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
describe('lpOdRowState — a row never implies a check that did not happen', () => {
  const std  = { Id: '0M0a', ManageableState: 'unmanaged' };                            // Home/App page
  const rec  = { Id: '0M0b', ManageableState: 'unmanaged', EntityDefinitionId: 'Account' };
  const mgdR = { Id: '0M0c', ManageableState: 'installed', EntityDefinitionId: '01I00' };
  const mgdH = { Id: '0M0d', ManageableState: 'installed' };                            // managed, no object

  it('shows the badge as soon as a page is confirmed default, whatever the status', () => {
    const r = lpOdRowState({ ...std, _isOrgDefault: true }, { status: 'skipped' });
    expect(r.state).toBe('default');
    expect(r.label).toBe('Org Default');
  });

  it('says "not resolved" — NOT blank — when the check never ran', () => {
    const r = lpOdRowState(std, { status: 'skipped' });
    expect(r.state).toBe('unknown');
    expect(r.label).toBe('?');
    expect(r.title).toMatch(/not resolved/i);
    expect(r.title).toMatch(/has not been run/i);
  });

  it('goes blank only once EVERY applicable pass has settled', () => {
    // A record page needs both passes: pass 1 finds standard org defaults,
    // pass 2 finds the custom-object ones. Either alone is inconclusive.
    expect(lpOdRowState(rec, { status: 'done', pass1Done: true,  pass2Done: false }).state).toBe('unknown');
    expect(lpOdRowState(rec, { status: 'done', pass1Done: false, pass2Done: true  }).state).toBe('unknown');
    expect(lpOdRowState(rec, { status: 'done', pass1Done: true,  pass2Done: true  }).state).toBe('none');
  });

  it('a page with no object needs only pass 1', () => {
    expect(lpOdRowState(std, { status: 'done', pass1Done: true, pass2Done: false }).state).toBe('none');
  });

  it('a MANAGED record page is covered by the describe pass alone', () => {
    // Pass 1 deliberately skips managed pages, so requiring pass1Done there
    // would leave them permanently "?" for no reason.
    expect(lpOdRowState(mgdR, { status: 'done', pass1Done: false, pass2Done: true }).state).toBe('none');
  });

  it('a managed page with NO object can never be resolved — and says exactly that', () => {
    const r = lpOdRowState(mgdH, { status: 'done', pass1Done: true, pass2Done: true });
    expect(r.state).toBe('unknown');
    expect(r.title).toMatch(/managed-package page with no object/i);
  });

  it('stays quiet while the check is RUNNING — the strip is already accounting for it', () => {
    expect(lpOdRowState(std, { status: 'running', pass1Done: false }).state).toBe('none');
    // …but the moment it stops, the unresolved row speaks up again.
    expect(lpOdRowState(std, { status: 'partial', pass1Done: false }).state).toBe('unknown');
  });

  it('distinguishes "never started" from "stopped or failed"', () => {
    expect(lpOdRowState(std, { status: 'skipped' }).title).toMatch(/has not been run/i);
    expect(lpOdRowState(std, { status: 'partial' }).title).toMatch(/stopped, or the read failed/i);
    expect(lpOdRowState(std, { status: 'done' }).title).toMatch(/stopped, or the read failed/i);
  });

  it('treats junk input as unresolved rather than silently "not default"', () => {
    expect(lpOdRowState(null, null).state).toBe('unknown');
    expect(lpOdRowState({}, {}).state).toBe('unknown');
  });
});

// ══════════════════════════════════════════════════════════════
describe('lpOdSummary — the strip never overstates coverage', () => {
  const base = {
    pagesDone: 0, pagesTotal: 0, objectsDone: 0, objectsTotal: 0,
    pagesFailed: 0, objectsFailed: 0, unresolved: 0
  };

  it('is EMPTY when the check finished and resolved everything', () => {
    // This is what preserves the small-org look: nothing new on screen.
    expect(lpOdSummary({ ...base, status: 'done', pagesDone: 40, pagesTotal: 40,
      objectsDone: 12, objectsTotal: 12 }, null)).toBe('');
  });

  it('quotes the exact cost, its breakdown and a hedged ETA before running', () => {
    const plan = lpOrgDefaultsPlan(900, 300, OPTS);
    const s = lpOdSummary({ ...base, status: 'skipped' }, plan);
    expect(s).toContain('1200 Salesforce API calls');
    expect(s).toContain('900 page reads');
    expect(s).toContain('300 object describes');
    expect(s).toContain('about 1m 12s');
    // …and it says what "?" means so a blank badge is never misread.
    expect(s).toMatch(/UNCHECKED, not "not the default"/);
  });

  it('mentions the name lookups only when there are any', () => {
    const withLookup = lpOdSummary({ ...base, status: 'skipped' },
      lpOrgDefaultsPlan(10, 4, { ...OPTS, extraCalls: 2 }));
    expect(withLookup).toContain('2 name lookups');
    const without = lpOdSummary({ ...base, status: 'skipped' }, lpOrgDefaultsPlan(10, 4, OPTS));
    expect(without).not.toContain('name lookup');
  });

  it('says nothing when there is nothing to check', () => {
    expect(lpOdSummary({ ...base, status: 'skipped' }, lpOrgDefaultsPlan(0, 0, OPTS))).toBe('');
  });

  it('attributes a run in flight with real numbers on both passes', () => {
    const s = lpOdSummary({ ...base, status: 'running', pagesDone: 120, pagesTotal: 900,
      objectsDone: 0, objectsTotal: 300 }, null);
    expect(s).toContain('120 / 900 pages');
    expect(s).toContain('0 / 300 objects');
    expect(s).toMatch(/Checking which pages are the org default/);
  });

  it('reports a STOPPED run at the point it reached and refuses to call it done', () => {
    const s = lpOdSummary({ ...base, status: 'partial', pagesDone: 310, pagesTotal: 900,
      objectsDone: 0, objectsTotal: 300, unresolved: 590 }, null);
    expect(s).toContain('310 / 900 pages');
    expect(s).toContain('590 pages still marked "?"');
    expect(s).toMatch(/UNCHECKED, not "not the org default"/);
    expect(s).not.toMatch(/finished/i);
  });

  it('names read failures instead of letting them pass as "not the default"', () => {
    const s = lpOdSummary({ ...base, status: 'done', pagesDone: 900, pagesTotal: 900,
      objectsDone: 300, objectsTotal: 300, pagesFailed: 3, objectsFailed: 1,
      unresolved: 4 }, null);
    expect(s).toContain('3 page reads failed');
    expect(s).toContain('1 object describe failed');
    expect(s).toContain('4 pages could not be resolved');
  });

  it('only ever prints totals it was handed — it invents nothing', () => {
    // Every figure in the sentence must appear in the input state/plan.
    const state = { ...base, status: 'partial', pagesDone: 7, pagesTotal: 11,
                    objectsDone: 2, objectsTotal: 3, unresolved: 5 };
    const nums = (lpOdSummary(state, null).match(/\d+/g) || []).map(Number);
    const allowed = new Set([7, 11, 2, 3, 5]);
    for (const n of nums) expect(allowed.has(n)).toBe(true);
  });

  it('gets singular/plural right so "1 pages" never ships', () => {
    const s = lpOdSummary({ ...base, status: 'partial', pagesDone: 0, pagesTotal: 1,
      objectsDone: 0, objectsTotal: 1, unresolved: 1 }, null);
    expect(s).toContain('0 / 1 page and 0 / 1 object.');
    expect(s).toContain('1 page still marked');
    expect(s).not.toMatch(/\b1 pages\b/);
    expect(s).not.toMatch(/\b1 objects\b/);

    // …and the running sentence, which is built from a different clause.
    const r = lpOdSummary({ ...base, status: 'running', pagesDone: 1, pagesTotal: 1,
      objectsDone: 0, objectsTotal: 1 }, null);
    expect(r).toContain('1 / 1 page, 0 / 1 object.');
    expect(r).not.toMatch(/\b1 pages\b/);

    // Plural side, so the singular tests above aren't passing by accident.
    const many = lpOdSummary({ ...base, status: 'partial', pagesDone: 2, pagesTotal: 4,
      objectsDone: 1, objectsTotal: 3, unresolved: 2 }, null);
    expect(many).toContain('2 / 4 pages and 1 / 3 objects.');
    expect(many).toContain('2 pages still marked');

    // "1 object describe failed" — not "describes".
    const one = lpOdSummary({ ...base, status: 'partial', objectsFailed: 1, unresolved: 1 }, null);
    expect(one).toContain('1 object describe failed');
    const two = lpOdSummary({ ...base, status: 'partial', objectsFailed: 2, unresolved: 2 }, null);
    expect(two).toContain('2 object describes failed');
  });

  it('survives a missing state without emitting a half-sentence', () => {
    expect(lpOdSummary(null, null)).toBe('');
    expect(lpOdSummary(undefined, undefined)).toBe('');
  });
});
