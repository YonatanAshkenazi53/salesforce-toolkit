// P1 — the pure half of the large-org preload fix.
//
// The bug: renderHomePage() eagerly built the dependency map on every popup
// open, and that map costs ONE Tooling metadata GET per flow VERSION. A real
// enterprise org (hundreds of definitions × versions) paid minutes of API calls
// before the user asked for anything.
//
// What is unit-testable is the sizing decision (scan eagerly or offer), the
// cost/ETA the UI quotes, and the pool that replaced the batch-of-10 barrier.
// The wiring in popup.js is DOM/chrome.runtime-bound and is not covered here.
import { describe, it, expect } from 'vitest';
import { extractFunction, extractFunctions } from './extract.mjs';

// depScanPlan calls depFormatEta — same scope required.
const { depScanPlan, depFormatEta } = extractFunctions('dependency-map.js', ['depScanPlan', 'depFormatEta']);
const depRunPool = extractFunction('dependency-map.js', 'depRunPool');

// Mirrors the constants the IIFE passes in via DependencyMap.scanPlan().
const LIVE = { autoMax: 150, concurrency: 6 };

describe('depScanPlan — eager scan vs. ask first', () => {
  it('scans eagerly at and below the threshold', () => {
    expect(depScanPlan(0, LIVE).auto).toBe(true);
    expect(depScanPlan(1, LIVE).auto).toBe(true);
    expect(depScanPlan(149, LIVE).auto).toBe(true);
    expect(depScanPlan(150, LIVE).auto).toBe(true);
  });

  it('refuses to scan eagerly one version past the threshold', () => {
    expect(depScanPlan(151, LIVE).auto).toBe(false);
    expect(depScanPlan(1600, LIVE).auto).toBe(false);
  });

  it('quotes ONE metadata call per flow version — never a capped or rounded number', () => {
    // The honesty requirement: the number the UI shows is the number of calls
    // the pool will actually make.
    for (const n of [0, 7, 150, 151, 1600, 12345]) {
      expect(depScanPlan(n, LIVE).calls).toBe(n);
      expect(depScanPlan(n, LIVE).versions).toBe(n);
    }
  });

  it('divides the ETA by the real pool width', () => {
    const p = depScanPlan(1200, { ...LIVE, msPerCall: 300 });
    expect(p.estMs).toBe(Math.round((1200 * 300) / 6));   // 60_000
    expect(p.estLabel).toBe('about 1m');
    expect(p.concurrency).toBe(6);
  });

  it('flags whether the ETA came from a measured scan or the default', () => {
    expect(depScanPlan(200, LIVE).measured).toBe(false);
    expect(depScanPlan(200, LIVE).msPerCall).toBe(300);          // documented default
    const m = depScanPlan(200, { ...LIVE, msPerCall: 900 });
    expect(m.measured).toBe(true);
    expect(m.msPerCall).toBe(900);
    expect(m.estMs).toBe(30000);
  });

  it('survives junk version counts instead of quoting NaN', () => {
    for (const bad of [undefined, null, NaN, -5, 'lots', {}]) {
      const p = depScanPlan(bad, LIVE);
      expect(p.versions).toBe(0);
      expect(p.calls).toBe(0);
      expect(p.auto).toBe(true);          // nothing to scan is not a "large org"
      expect(p.estLabel).toBe('under a second');
    }
  });

  it('falls back to sane defaults when opts are missing or nonsense', () => {
    const p = depScanPlan(151);
    expect(p.autoMax).toBe(150);
    expect(p.concurrency).toBe(6);
    expect(p.auto).toBe(false);
    expect(depScanPlan(10, { concurrency: 0, msPerCall: -1 }).concurrency).toBe(6);
  });

  it('allows autoMax 0 — every org then asks first', () => {
    expect(depScanPlan(1, { autoMax: 0 }).auto).toBe(false);
    expect(depScanPlan(0, { autoMax: 0 }).auto).toBe(true);
  });
});

describe('depFormatEta — the number next to the call count', () => {
  it('formats sub-minute waits in seconds', () => {
    expect(depFormatEta(0)).toBe('under a second');
    expect(depFormatEta(400)).toBe('under a second');
    expect(depFormatEta(1000)).toBe('about 1s');
    expect(depFormatEta(7500)).toBe('about 8s');
    expect(depFormatEta(59000)).toBe('about 59s');
  });

  it('formats longer waits in minutes and seconds', () => {
    expect(depFormatEta(60000)).toBe('about 1m');
    expect(depFormatEta(90000)).toBe('about 1m 30s');
    expect(depFormatEta(150000)).toBe('about 2m 30s');
    expect(depFormatEta(180000)).toBe('about 3m');
  });

  it('never renders a negative or NaN duration', () => {
    expect(depFormatEta(-1000)).toBe('under a second');
    expect(depFormatEta(NaN)).toBe('under a second');
    expect(depFormatEta(undefined)).toBe('under a second');
  });
});

// Deterministic async worker: resolves after `ticks` microtask turns so several
// items can genuinely overlap without leaning on timers.
const defer = (ticks) => {
  let p = Promise.resolve();
  for (let i = 0; i < ticks; i++) p = p.then(() => {});
  return p;
};

describe('depRunPool — rolling pool replacing the batch-of-10 barrier', () => {
  it('keeps results in INPUT order however they complete', async () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7];
    const run = await depRunPool(items, async (n) => {
      await defer(items.length - n);   // later items finish first
      return n * 10;
    }, { concurrency: 4 });
    expect(run.results).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
    expect(run.complete).toBe(true);
  });

  it('never exceeds the concurrency limit and never idles below it while work remains', async () => {
    let inFlight = 0, peak = 0;
    const items = Array.from({ length: 40 }, (_, i) => i);
    await depRunPool(items, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await defer(3);
      inFlight--;
    }, { concurrency: 6 });
    expect(peak).toBe(6);
    expect(inFlight).toBe(0);
  });

  it('reports progress once per item, monotonically, ending at the total', async () => {
    const seen = [];
    const items = Array.from({ length: 25 }, (_, i) => i);
    const run = await depRunPool(items, async (n) => defer(n % 4), {
      concurrency: 5,
      onProgress: (done, total) => seen.push([done, total])
    });
    expect(seen).toHaveLength(25);
    expect(seen.map(s => s[0])).toEqual(items.map(i => i + 1));   // 1..25, no gaps
    expect(seen.every(s => s[1] === 25)).toBe(true);
    expect(run.done).toBe(25);
    expect(run.total).toBe(25);
  });

  it('counts a THROWN item as done rather than stalling the pool', async () => {
    const items = [1, 2, 3, 4, 5];
    const run = await depRunPool(items, async (n) => {
      if (n % 2 === 0) throw new Error('metadata 404');
      return n;
    }, { concurrency: 2 });
    expect(run.done).toBe(5);
    expect(run.complete).toBe(true);
    expect(run.results).toEqual([1, undefined, 3, undefined, 5]);
  });

  it('stops on shouldStop and reports stopped — never a false "complete"', async () => {
    let started = 0;
    const items = Array.from({ length: 100 }, (_, i) => i);
    const run = await depRunPool(items, async () => { started++; await defer(2); }, {
      concurrency: 4,
      shouldStop: () => started >= 12
    });
    expect(run.stopped).toBe(true);
    expect(run.complete).toBe(false);
    expect(run.done).toBeLessThan(100);
    // Bounded overrun: at most one extra item per worker already past the check.
    expect(started).toBeLessThanOrEqual(12 + 4);
  });

  it('still reports complete when the stop lands after the last item settled', async () => {
    // Otherwise a Stop pressed in the final moments would show a "Resume" bar
    // with 0 calls left on a scan that actually covered every version.
    let settled = 0;
    const run = await depRunPool([1, 2, 3], async () => { settled++; }, {
      concurrency: 1,
      shouldStop: () => settled >= 3
    });
    expect(run.done).toBe(3);
    expect(run.stopped).toBe(true);
    expect(run.complete).toBe(true);
  });

  it('does not start a single call when shouldStop is true up front', async () => {
    let started = 0;
    const run = await depRunPool([1, 2, 3], async () => { started++; }, {
      concurrency: 3,
      shouldStop: () => true
    });
    expect(started).toBe(0);
    expect(run.done).toBe(0);
    expect(run.stopped).toBe(true);
    expect(run.complete).toBe(false);
  });

  it('treats an empty or non-array queue as complete, not stopped', async () => {
    for (const empty of [[], null, undefined, 'nope']) {
      const run = await depRunPool(empty, async () => 1, { concurrency: 6 });
      expect(run.total).toBe(0);
      expect(run.done).toBe(0);
      expect(run.stopped).toBe(false);
      expect(run.complete).toBe(true);
    }
  });

  it('runs serially when concurrency is missing or invalid rather than unbounded', async () => {
    let peak = 0, inFlight = 0;
    await depRunPool([1, 2, 3, 4], async () => {
      inFlight++; peak = Math.max(peak, inFlight); await defer(2); inFlight--;
    }, { concurrency: 0 });
    expect(peak).toBe(4);   // falls back to the documented default of 6, capped by queue length
  });
});

describe('resume accounting — a stopped scan must not re-pay for what it covered', () => {
  // buildDependencyMap filters the queue by _scannedIds and offsets progress by
  // the count already covered. That arithmetic is what the offer bar quotes.
  it('quotes only the remaining calls after a partial scan', () => {
    const total = depScanPlan(1600, LIVE);
    const doneSoFar = 640;
    const left = depScanPlan(total.calls - doneSoFar, LIVE);
    expect(left.calls).toBe(960);
    expect(left.estMs).toBe(Math.round((960 * 300) / 6));
    expect(left.estLabel).toBe('about 48s');
  });

  it('quotes zero remaining when a stop landed on the last item', () => {
    const left = depScanPlan(0, LIVE);
    expect(left.calls).toBe(0);
    expect(left.estLabel).toBe('under a second');
  });
});
