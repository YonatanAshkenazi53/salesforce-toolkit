// v1.0.2 — the batched dependency scan and the incremental persistent cache.
//
// Two costs were attacked in this round:
//
//   A. Even a well-behaved scan cost ONE HTTP round-trip per flow VERSION.
//      1600 versions = 1600 calls. The reads now travel in composite/batch
//      chunks, so the same 1600 reads cost ceil(1600/10) = 160 calls. The
//      numbers the UI quotes had to move with them, or the estimate and the
//      work drift apart — which is the same dishonesty as a silent cap.
//
//   B. Nothing persisted. loadFlows() called reset() every open, so every popup
//      open rescanned the org from zero. The cache below diffs the (already
//      paid for) flow LIST against per-version LastModifiedDate stamps and
//      scans only the delta.
//
// What is unit-testable is every judgement in that pipeline: the chunking, the
// per-item verdicts, the coverage arithmetic, the delta, cache validity, LRU
// eviction, the byte budget, the freshness wording, and the predicate that
// decides whether an answer may back a PERMANENT delete. The chrome.storage and
// chrome.runtime wiring is not covered here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction, extractFunctions } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcOf = f => readFileSync(join(root, f), 'utf8');

// depScanPlan calls depFormatEta; depDeleteTrust and depScanFreshness call
// depCacheAge — co-dependent, so they share a scope.
const {
  depScanPlan, depFormatEta, depScanFreshness, depDeleteTrust, depCacheAge
} = extractFunctions('dependency-map.js',
  ['depScanPlan', 'depFormatEta', 'depScanFreshness', 'depDeleteTrust', 'depCacheAge']);
const { depCacheFit, depCacheEvictLru, depJsonBytes } =
  extractFunctions('dependency-map.js', ['depCacheFit', 'depCacheEvictLru', 'depJsonBytes']);

const depScanChunks      = extractFunction('dependency-map.js', 'depScanChunks');
const depBatchSubrequests = extractFunction('dependency-map.js', 'depBatchSubrequests');
const depBatchApply      = extractFunction('dependency-map.js', 'depBatchApply');
const depScanOutcome     = extractFunction('dependency-map.js', 'depScanOutcome');
const depApiVersionOf    = extractFunction('dependency-map.js', 'depApiVersionOf');
const depCacheKey        = extractFunction('dependency-map.js', 'depCacheKey');
const depCacheDelta      = extractFunction('dependency-map.js', 'depCacheDelta');
const depMapEvict        = extractFunction('dependency-map.js', 'depMapEvict');
const depMapKeepOnly     = extractFunction('dependency-map.js', 'depMapKeepOnly');
const depPickIds         = extractFunction('dependency-map.js', 'depPickIds');
const depCacheUsable     = extractFunction('dependency-map.js', 'depCacheUsable');

// The chunker background.js uses, so the two can be compared directly.
const sftkBatchChunks    = extractFunction('background.js', 'sftkBatchChunks');
const sftkBatchSubUrl    = extractFunction('background.js', 'sftkBatchSubUrl');

// Mirrors the constants DependencyMap.scanPlan() passes in.
const LIVE = { autoMax: 150, concurrency: 3, chunkSize: 10 };

const flow = (id, extra = {}) => ({
  Id: id, MasterLabel: `Flow ${id}`, ApiName: `Flow_${id}`,
  VersionNumber: 1, Status: 'Active', ProcessType: 'Flow',
  LastModifiedDate: '2026-01-01T00:00:00.000+0000', ...extra
});
const okItem   = (i, meta) => ({ index: i, method: 'GET', url: `v62.0/tooling/sobjects/Flow/${i}`, ok: true,  status: 200, body: { Metadata: meta }, error: undefined, batchError: false });
const badItem  = (i) => ({ index: i, method: 'GET', url: `v62.0/tooling/sobjects/Flow/${i}`, ok: false, status: 404, body: undefined, error: 'HTTP 404', batchError: false });
const deadItem = (i) => ({ index: i, method: 'GET', url: `v62.0/tooling/sobjects/Flow/${i}`, ok: false, status: 0,   body: undefined, error: 'call failed', batchError: true });

// ════════════════════════════════════════════════════════════════════════
// TASK A — the batched scan
// ════════════════════════════════════════════════════════════════════════

describe('depScanPlan — the quoted cost is the BATCHED cost', () => {
  it('quotes reads and round-trips as the different numbers they now are', () => {
    const p = depScanPlan(1600, LIVE);
    expect(p.versions).toBe(1600);
    expect(p.reads).toBe(1600);          // still one metadata read per version
    expect(p.calls).toBe(160);           // …but ceil(1600/10) HTTP round-trips
    expect(p.batches).toBe(160);
    expect(p.chunkSize).toBe(10);
  });

  it('rounds a partial last batch UP — 26 reads is 3 calls, never 2.6', () => {
    expect(depScanPlan(1,  LIVE).calls).toBe(1);
    expect(depScanPlan(10, LIVE).calls).toBe(1);
    expect(depScanPlan(11, LIVE).calls).toBe(2);
    expect(depScanPlan(26, LIVE).calls).toBe(3);
    expect(depScanPlan(0,  LIVE).calls).toBe(0);   // nothing to read = nothing to send
  });

  it('agrees EXACTLY with the chunker the scan loop uses', () => {
    // The whole point of one plan function: the quote and the work cannot drift.
    for (const n of [0, 1, 9, 10, 11, 150, 151, 999, 1600]) {
      const items = Array.from({ length: n }, (_, i) => i);
      expect(depScanPlan(n, LIVE).calls).toBe(depScanChunks(items, 10).length);
    }
  });

  it('agrees with background.js sftkBatchChunks, which does the real chunking', () => {
    for (const n of [0, 1, 24, 25, 26, 100, 1600]) {
      const items = Array.from({ length: n }, (_, i) => i);
      expect(depScanChunks(items, 10).length).toBe(sftkBatchChunks(items, 10).length);
      expect(depScanChunks(items, 25).length).toBe(sftkBatchChunks(items, 25).length);
    }
  });

  it('derives the ETA from ROUND-TRIPS, not from reads', () => {
    const p = depScanPlan(1600, { ...LIVE, msPerCall: 1200 });
    expect(p.estMs).toBe(Math.round((160 * 1200) / 3));   // 64_000
    expect(p.estLabel).toBe('about 1m 4s');
    // The v1.0.1 unbatched figure for the same org was 1600 × 300 / 6 = 80 s of
    // 1600 calls. Quoting that after batching would be a lie in both directions.
    expect(p.calls).not.toBe(1600);
  });

  it('says whether the ETA was measured on this org or defaulted', () => {
    expect(depScanPlan(200, LIVE).measured).toBe(false);
    expect(depScanPlan(200, LIVE).msPerCall).toBe(1200);       // documented default
    const m = depScanPlan(200, { ...LIVE, msPerCall: 2500 });
    expect(m.measured).toBe(true);
    expect(m.estMs).toBe(Math.round((20 * 2500) / 3));
  });

  it('keeps the auto-scan threshold at 150 VERSIONS TO READ', () => {
    // Batching made the work cheaper, not free. Silently raising the bar would
    // start hundreds of reads on open in orgs that used to be asked first.
    expect(depScanPlan(150, LIVE).auto).toBe(true);
    expect(depScanPlan(151, LIVE).auto).toBe(false);
    expect(depScanPlan(1600, LIVE).auto).toBe(false);
    expect(depScanPlan(0, LIVE).auto).toBe(true);
  });

  it('clamps chunkSize to the server ceiling of 25 rather than promising more', () => {
    expect(depScanPlan(100, { ...LIVE, chunkSize: 200 }).chunkSize).toBe(25);
    expect(depScanPlan(100, { ...LIVE, chunkSize: 200 }).calls).toBe(4);
    expect(depScanPlan(100, { ...LIVE, chunkSize: 0 }).chunkSize).toBe(10);
    expect(depScanPlan(100, { ...LIVE, chunkSize: -3 }).chunkSize).toBe(10);
  });

  it('survives junk version counts instead of quoting NaN', () => {
    for (const bad of [undefined, null, NaN, -5, 'lots', {}]) {
      const p = depScanPlan(bad, LIVE);
      expect(p.versions).toBe(0);
      expect(p.reads).toBe(0);
      expect(p.calls).toBe(0);
      expect(p.auto).toBe(true);
      expect(p.estLabel).toBe('under a second');
    }
  });

  it('falls back to documented defaults when opts are missing', () => {
    const p = depScanPlan(151);
    expect(p.autoMax).toBe(150);
    expect(p.concurrency).toBe(3);
    expect(p.chunkSize).toBe(10);
    expect(p.auto).toBe(false);
  });
});

describe('depScanChunks — the unit of work the pool hands out', () => {
  it('preserves input order and covers every item exactly once', () => {
    const items = Array.from({ length: 47 }, (_, i) => i);
    const chunks = depScanChunks(items, 10);
    expect(chunks).toHaveLength(5);
    expect(chunks.map(c => c.length)).toEqual([10, 10, 10, 10, 7]);
    expect(chunks.flat()).toEqual(items);
  });

  it('never exceeds the 25-subrequest server ceiling, whatever it is asked for', () => {
    const items = Array.from({ length: 60 }, (_, i) => i);
    expect(depScanChunks(items, 100).every(c => c.length <= 25)).toBe(true);
    expect(depScanChunks(items, 26).every(c => c.length <= 25)).toBe(true);
  });

  it('returns nothing for an empty or non-array queue — zero calls, not one empty call', () => {
    for (const empty of [[], null, undefined, 'nope', 7]) {
      expect(depScanChunks(empty, 10)).toEqual([]);
    }
  });
});

describe('depBatchSubrequests — the urls that go out', () => {
  it('emits a version-less tooling path that the primitive rewrites correctly', () => {
    const subs = depBatchSubrequests([flow('301a'), flow('301b')]);
    expect(subs).toEqual([
      { method: 'GET', url: 'tooling/sobjects/Flow/301a' },
      { method: 'GET', url: 'tooling/sobjects/Flow/301b' }
    ]);
    // Round-trip through the real normaliser: this is the form Salesforce takes.
    expect(sftkBatchSubUrl(subs[0].url, 'v62.0')).toBe('v62.0/tooling/sobjects/Flow/301a');
    // …and NOT the /services/data/ form, which the server rejects.
    expect(sftkBatchSubUrl(subs[0].url, 'v62.0').startsWith('services/data/')).toBe(false);
  });

  it('does not silently drop a record with no Id — that would shift every later answer', () => {
    const subs = depBatchSubrequests([flow('a'), { MasterLabel: 'broken' }, flow('c')]);
    expect(subs).toHaveLength(3);
    expect(subs[1].url).toBe('tooling/sobjects/Flow/');
  });

  it('handles an empty or non-array chunk', () => {
    expect(depBatchSubrequests([])).toEqual([]);
    expect(depBatchSubrequests(null)).toEqual([]);
  });
});

describe('depBatchApply — which failures count as COVERED', () => {
  const chunk = [flow('a'), flow('b'), flow('c')];

  it('hands back the Metadata of every 2xx item and marks it covered', () => {
    const r = depBatchApply(chunk, [
      okItem(0, { subflows: [{ flowName: 'Child' }] }),
      okItem(1, { subflows: [] }),
      okItem(2, { start: { triggerType: 'RecordAfterSave' } })
    ]);
    expect(r.covered.map(f => f.Id)).toEqual(['a', 'b', 'c']);
    expect(r.metas).toHaveLength(3);
    expect(r.unread).toEqual([]);
    expect(r.callFailed).toBe(false);
  });

  it('counts a per-item 404 as COVERED — an obsolete version fails the same way on retry', () => {
    const r = depBatchApply(chunk, [okItem(0, {}), badItem(1), okItem(2, {})]);
    expect(r.covered.map(f => f.Id)).toEqual(['a', 'b', 'c']);
    expect(r.metas.map(m => m.flow.Id)).toEqual(['a', 'c']);   // no metadata for the 404
    expect(r.unread).toEqual([]);
  });

  it('counts a batchError as UNREAD — a dead call is retryable and must not become a hole', () => {
    // This is the distinction that matters: marking these three "scanned" would
    // silently turn one transient 500 into a permanent gap in the map, and an
    // absent edge reads exactly like "nothing calls this flow".
    const r = depBatchApply(chunk, [deadItem(0), deadItem(1), deadItem(2)]);
    expect(r.covered).toEqual([]);
    expect(r.unread.map(f => f.Id)).toEqual(['a', 'b', 'c']);
    expect(r.callFailed).toBe(true);
    expect(r.metas).toEqual([]);
  });

  it('counts a never-dispatched slot as UNREAD, not as an empty answer', () => {
    // sfCompositeBatch leaves undefined behind when shouldStop cut the run short.
    const r = depBatchApply(chunk, [okItem(0, {}), undefined, undefined]);
    expect(r.covered.map(f => f.Id)).toEqual(['a']);
    expect(r.unread.map(f => f.Id)).toEqual(['b', 'c']);
    expect(r.callFailed).toBe(false);   // nothing failed; it just never went out
  });

  it('treats a missing results array (dispatcher/session failure) as the whole chunk unread', () => {
    for (const nothing of [null, undefined, 'error', { error: 'SESSION_EXPIRED' }]) {
      const r = depBatchApply(chunk, nothing);
      expect(r.covered).toEqual([]);
      expect(r.unread).toHaveLength(3);
    }
  });

  it('ignores a body with no Metadata rather than absorbing undefined', () => {
    const r = depBatchApply([flow('a')], [{ ...okItem(0, null), body: { Id: 'a' } }]);
    expect(r.covered).toHaveLength(1);
    expect(r.metas).toEqual([]);
  });
});

describe('depScanOutcome — completeness is decided by VERSION coverage', () => {
  it('is complete only when every version settled', () => {
    expect(depScanOutcome(100, 100, false).complete).toBe(true);
    expect(depScanOutcome(100, 99, false).complete).toBe(false);
    expect(depScanOutcome(100, 99, false).missing).toBe(1);
  });

  it('is NOT complete when batches all went out but some came back dead', () => {
    // 160 batches dispatched, 3 of them batchError → 30 versions unread.
    const o = depScanOutcome(1600, 1570, false);
    expect(o.complete).toBe(false);
    expect(o.done).toBe(1570);
    expect(o.missing).toBe(30);
  });

  it('still reports complete when a Stop landed after the last version settled', () => {
    // Same rule as depRunPool: calling that partial would under-report coverage
    // just as dishonestly as over-reporting it.
    const o = depScanOutcome(3, 3, true);
    expect(o.complete).toBe(true);
    expect(o.stopped).toBe(true);
  });

  it('never reports more coverage than the total, whatever it is handed', () => {
    expect(depScanOutcome(10, 999, false).done).toBe(10);
    expect(depScanOutcome(10, -5, false).done).toBe(0);
    expect(depScanOutcome('x', 'y', false)).toEqual({ total: 0, done: 0, missing: 0, stopped: false, complete: true });
  });
});

describe('depApiVersionOf — verifying the version instead of trusting a copy', () => {
  it('reads the version off the url the primitive really sent', () => {
    expect(depApiVersionOf('v62.0/tooling/sobjects/Flow/301x')).toBe('v62.0');
    expect(depApiVersionOf('/services/data/v58.0/tooling/sobjects/Flow/1')).toBe('v58.0');
    expect(depApiVersionOf('v63.0/query?q=x')).toBe('v63.0');
  });

  it('returns empty rather than guessing when there is no version', () => {
    for (const bad of ['tooling/sobjects/Flow/1', '', null, undefined, 'vX.0/x', 42]) {
      expect(depApiVersionOf(bad)).toBe('');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// TASK B — the incremental cache
// ════════════════════════════════════════════════════════════════════════

describe('depCacheKey — one key per org AND API version', () => {
  it('joins the org identity and the api version', () => {
    expect(depCacheKey('acme-dev.develop', 'v62.0')).toBe('acme-dev.develop|v62.0');
  });

  it('normalises case so the same org never gets two entries', () => {
    expect(depCacheKey('ACME-Dev', 'V62.0')).toBe('acme-dev|v62.0');
    expect(depCacheKey('  acme  ', ' v62.0 ')).toBe('acme|v62.0');
  });

  it('returns EMPTY (= do not cache) when the org or version is unknown', () => {
    // A blank key would collide every unidentifiable org into one shared entry.
    expect(depCacheKey('', 'v62.0')).toBe('');
    expect(depCacheKey('acme', '')).toBe('');
    expect(depCacheKey(null, null)).toBe('');
  });

  it('changes when the API version changes — v62 data can never answer a v63 session', () => {
    expect(depCacheKey('acme', 'v62.0')).not.toBe(depCacheKey('acme', 'v63.0'));
  });
});

describe('depCacheDelta — new / changed / deleted / unchanged', () => {
  const stamps = { a: 'T1', b: 'T1', c: 'T1' };

  it('classifies every version exactly once', () => {
    const d = depCacheDelta([
      flow('a', { LastModifiedDate: 'T1' }),   // unchanged
      flow('b', { LastModifiedDate: 'T2' }),   // changed
      flow('d', { LastModifiedDate: 'T1' })    // new  (c is gone)
    ], stamps);
    expect(d.unchanged).toEqual(['a']);
    expect(d.changed).toEqual(['b']);
    expect(d.added).toEqual(['d']);
    expect(d.deleted).toEqual(['c']);
  });

  it('scans only the delta — new + changed, never the unchanged remainder', () => {
    const flows = Array.from({ length: 1600 }, (_, i) => flow(`f${i}`, { LastModifiedDate: 'T1' }));
    const warm = {};
    for (const f of flows) warm[f.Id] = 'T1';
    flows[7].LastModifiedDate = 'T2';
    flows[900].LastModifiedDate = 'T2';
    const d = depCacheDelta(flows, warm);
    expect(d.todo).toEqual(['f7', 'f900']);
    expect(d.unchanged).toHaveLength(1598);
    // The whole point: 1600 versions, 2 reads, ONE round-trip.
    expect(depScanPlan(d.todo.length, LIVE).calls).toBe(1);
  });

  it('marks CHANGED and DELETED as stale so their cached edges are evicted', () => {
    const d = depCacheDelta([flow('a', { LastModifiedDate: 'T2' })], stamps);
    expect(d.stale.sort()).toEqual(['a', 'b', 'c']);
  });

  it('treats a MISSING stamp on either side as changed, never as unchanged', () => {
    // The one direction that costs a re-read instead of trusting an unverified
    // edge. A flow with no LastModifiedDate must never be assumed stable.
    expect(depCacheDelta([flow('a', { LastModifiedDate: null })], { a: 'T1' }).changed).toEqual(['a']);
    expect(depCacheDelta([flow('a', { LastModifiedDate: 'T1' })], { a: '' }).changed).toEqual(['a']);
    expect(depCacheDelta([flow('a', { LastModifiedDate: undefined })], { a: undefined }).changed).toEqual(['a']);
  });

  it('an empty cache makes everything new — a cold start scans the whole org', () => {
    const flows = [flow('a'), flow('b')];
    for (const empty of [{}, null, undefined, 'nope']) {
      const d = depCacheDelta(flows, empty);
      expect(d.added).toEqual(['a', 'b']);
      expect(d.unchanged).toEqual([]);
      expect(d.todo).toHaveLength(2);
    }
  });

  it('an empty org makes every stamped version deleted', () => {
    const d = depCacheDelta([], stamps);
    expect(d.deleted.sort()).toEqual(['a', 'b', 'c']);
    expect(d.todo).toEqual([]);
  });

  it('counts a duplicated row once', () => {
    const d = depCacheDelta([flow('a', { LastModifiedDate: 'T1' }), flow('a', { LastModifiedDate: 'T1' })], stamps);
    expect(d.unchanged).toEqual(['a']);
  });

  it('ignores records with no Id instead of stamping undefined', () => {
    const d = depCacheDelta([{ LastModifiedDate: 'T1' }, flow('a', { LastModifiedDate: 'T1' })], stamps);
    expect(d.unchanged).toEqual(['a']);
    expect(d.added).toEqual([]);
  });
});

describe('depMapEvict — a deleted flow leaves NO phantom dependency edge', () => {
  const map = {
    Child_A: [{ id: 'p1', masterLabel: 'P1' }, { id: 'p2', masterLabel: 'P2' }],
    Child_B: [{ id: 'p2', masterLabel: 'P2' }],
    Child_C: [{ id: 'p3', masterLabel: 'P3' }]
  };

  it('removes the evicted version from every parent list it appears in', () => {
    const out = depMapEvict(map, ['p2']);
    expect(out.Child_A.map(p => p.id)).toEqual(['p1']);
    expect(out.Child_C.map(p => p.id)).toEqual(['p3']);
  });

  it('drops a key whose last caller went away — not an empty array left behind', () => {
    const out = depMapEvict(map, ['p2']);
    expect(Object.prototype.hasOwnProperty.call(out, 'Child_B')).toBe(false);
  });

  it('never mutates the cached map it was handed', () => {
    const before = JSON.stringify(map);
    depMapEvict(map, ['p1', 'p2', 'p3']);
    expect(JSON.stringify(map)).toBe(before);
  });

  it('evicts everything when every caller is stale', () => {
    expect(depMapEvict(map, ['p1', 'p2', 'p3'])).toEqual({});
  });

  it('accepts a Set as well as an array, and tolerates junk', () => {
    expect(depMapEvict(map, new Set(['p2'])).Child_A.map(p => p.id)).toEqual(['p1']);
    expect(depMapEvict(map, null)).toEqual(map);
    expect(depMapEvict(null, ['p1'])).toEqual({});
  });
});

describe('depMapKeepOnly — a restored map keeps only what is PROVEN unchanged', () => {
  const cached = {
    Child_A: [{ id: 'p1' }, { id: 'p2' }, { id: 'ghost' }],
    Child_B: [{ id: 'ghost' }],
    Child_C: [{ id: 'p1' }]
  };

  it('drops an edge whose caller is in NO delta bucket at all', () => {
    // `ghost` is neither unchanged, changed, added nor deleted — it can only
    // come from an older entry, a half-written key, or a stamp that went
    // missing. Nothing vouches for it, so it must not survive as an edge.
    const out = depMapKeepOnly(cached, new Set(['p1', 'p2']));
    expect(out.Child_A.map(p => p.id)).toEqual(['p1', 'p2']);
    expect(out.Child_C.map(p => p.id)).toEqual(['p1']);
    expect(Object.prototype.hasOwnProperty.call(out, 'Child_B')).toBe(false);
  });

  it('is stricter than depMapEvict, which only removes a known-bad set', () => {
    // The distinction that matters for data read off disk.
    expect(depMapEvict(cached, ['p2']).Child_B).toBeTruthy();       // ghost survives
    expect(depMapKeepOnly(cached, ['p1']).Child_B).toBeUndefined(); // ghost does not
  });

  it('keeps nothing when nothing is proven', () => {
    expect(depMapKeepOnly(cached, [])).toEqual({});
    expect(depMapKeepOnly(cached, null)).toEqual({});
  });

  it('never mutates the entry it was handed', () => {
    const before = JSON.stringify(cached);
    depMapKeepOnly(cached, ['p1']);
    expect(JSON.stringify(cached)).toBe(before);
  });

  it('tolerates a junk map', () => {
    expect(depMapKeepOnly(null, ['p1'])).toEqual({});
    expect(depMapKeepOnly({ X: 'not-an-array' }, ['p1'])).toEqual({});
  });
});

describe('depPickIds — side tables follow the same eviction rule as the map', () => {
  const refs = { a: { objects: [] }, b: { objects: [] }, c: { objects: [] } };
  it('keeps only the ids that are still proven unchanged', () => {
    expect(Object.keys(depPickIds(refs, ['a', 'c'])).sort()).toEqual(['a', 'c']);
    expect(Object.keys(depPickIds(refs, new Set(['b'])))).toEqual(['b']);
  });
  it('never invents an entry for an id the source did not have', () => {
    expect(depPickIds(refs, ['zzz'])).toEqual({});
    expect(depPickIds(null, ['a'])).toEqual({});
  });
});

describe('depCacheUsable — schema and API-version invalidation', () => {
  const good = {
    schema: 1, orgKey: 'acme', apiVersion: 'v62.0', builtAt: 1000,
    stamps: { a: 'T1' }, map: {}
  };
  const now = 1000 + 60000;
  const OPTS = { schema: 1, apiVersion: 'v62.0', orgKey: 'acme', now, maxAgeMs: 30 * 86400000 };

  it('accepts a matching entry', () => {
    expect(depCacheUsable(good, OPTS).ok).toBe(true);
  });

  it('rejects a different SCHEMA version — a shape change invalidates everything', () => {
    const r = depCacheUsable({ ...good, schema: 0 }, OPTS);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/shape/);
    expect(depCacheUsable({ ...good, schema: undefined }, OPTS).ok).toBe(false);
  });

  it('rejects a different API VERSION — v62 metadata cannot answer a v63 session', () => {
    const r = depCacheUsable({ ...good, apiVersion: 'v58.0' }, OPTS);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/v58\.0/);
  });

  it('rejects an entry belonging to another org', () => {
    expect(depCacheUsable({ ...good, orgKey: 'other' }, OPTS).ok).toBe(false);
  });

  it('rejects an entry with no stamps — nothing in it could be proven current', () => {
    expect(depCacheUsable({ ...good, stamps: {} }, OPTS).ok).toBe(false);
    expect(depCacheUsable({ ...good, stamps: null }, OPTS).ok).toBe(false);
  });

  it('rejects an entry with no map', () => {
    expect(depCacheUsable({ ...good, map: null }, OPTS).ok).toBe(false);
  });

  it('rejects an entry past the age limit', () => {
    const old = { ...good, builtAt: 0 };
    const r = depCacheUsable(old, { ...OPTS, now: 40 * 86400000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/days old/);
  });

  it('always gives a reason a user could act on, never a bare false', () => {
    for (const bad of [null, undefined, {}, 'nope', { schema: 1 }]) {
      const r = depCacheUsable(bad, OPTS);
      expect(r.ok).toBe(false);
      expect(typeof r.reason).toBe('string');
      expect(r.reason.length).toBeGreaterThan(10);
    }
  });
});

describe('depJsonBytes — the budget is MEASURED, not guessed', () => {
  it('counts ASCII as one byte each', () => {
    expect(depJsonBytes('abc')).toBe(3);
    expect(depJsonBytes(JSON.stringify({ a: 1 }))).toBe(7);
  });
  it('counts multi-byte characters at their real UTF-8 width', () => {
    expect(depJsonBytes('é')).toBe(2);
    expect(depJsonBytes('→')).toBe(3);
    expect(depJsonBytes('🧨')).toBe(4);      // surrogate pair = 4 bytes, not 6
  });
  it('is zero for nothing', () => {
    expect(depJsonBytes('')).toBe(0);
    expect(depJsonBytes(null)).toBe(0);
    expect(depJsonBytes(undefined)).toBe(0);
  });
  it('matches the browser/node encoder on mixed text', () => {
    const s = 'flow → 🧨 café {"a":"b"}';
    expect(depJsonBytes(s)).toBe(new TextEncoder().encode(s).length);
  });
});

describe('depCacheFit — one org may not eat the whole budget', () => {
  const entry = (extra = {}) => ({
    schema: 1, orgKey: 'acme', apiVersion: 'v62.0', builtAt: 1, stamps: { a: 'T' },
    map: { Child: [{ id: 'p', masterLabel: 'P' }] },
    triggerTypes: { p: 'RecordAfterSave' }, triggerObjects: { p: 'Account' },
    refs: { p: { objects: ['Account'], fields: [], subflows: [], apex: [], labels: [] } },
    ...extra
  });

  it('stores an entry that fits, untouched', () => {
    const r = depCacheFit(entry(), { maxBytes: 100000 });
    expect(r.stored).toBe(true);
    expect(r.dropped).toEqual([]);
    expect(r.entry.refs).toBeTruthy();
    expect(r.bytes).toBe(depJsonBytes(JSON.stringify(r.entry)));
  });

  it('drops REFS first and says so — the map itself is what matters', () => {
    const big = entry({ refs: { p: { blob: 'x'.repeat(5000) } } });
    const r = depCacheFit(big, { maxBytes: 1200 });
    expect(r.stored).toBe(true);
    expect(r.dropped).toContain('refs');
    expect(r.entry.refs).toBeUndefined();
    expect(r.entry.droppedRefs).toBe(true);
    expect(r.entry.map).toBeTruthy();       // the edges survive
    expect(r.note).toMatch(/blast radius/);
  });

  it('drops trigger types next, still keeping the edges', () => {
    const big = entry({
      refs: { p: { blob: 'x'.repeat(5000) } },
      triggerTypes: { p: 'y'.repeat(2000) },
      triggerObjects: { p: 'z'.repeat(2000) }
    });
    const r = depCacheFit(big, { maxBytes: 700 });
    expect(r.stored).toBe(true);
    expect(r.dropped).toEqual(expect.arrayContaining(['refs', 'triggerTypes', 'triggerObjects']));
    expect(r.entry.map).toBeTruthy();
    expect(r.entry.droppedTriggers).toBe(true);
  });

  it('NEVER stores a truncated map — an absent edge reads as "nothing calls this"', () => {
    const huge = entry({ map: { Child: Array.from({ length: 500 }, (_, i) => ({ id: `p${i}`, masterLabel: 'x'.repeat(50) })) } });
    const r = depCacheFit(huge, { maxBytes: 500 });
    expect(r.stored).toBe(false);
    expect(r.entry).toBeNull();
    expect(r.note).toMatch(/NOTHING was cached/);
    expect(r.note).toMatch(/KB/);           // the measured size is quoted
  });

  it('reports the real byte size it measured, whatever the verdict', () => {
    const huge = entry({ map: { Child: Array.from({ length: 500 }, (_, i) => ({ id: `p${i}` })) } });
    const r = depCacheFit(huge, { maxBytes: 100 });
    expect(r.bytes).toBeGreaterThan(100);
  });

  it('handles nothing to store', () => {
    expect(depCacheFit(null, { maxBytes: 100 }).stored).toBe(false);
    expect(depCacheFit(undefined, {}).stored).toBe(false);
  });

  it('never mutates the entry it was handed', () => {
    const src = entry({ refs: { p: { blob: 'x'.repeat(5000) } } });
    const before = JSON.stringify(src);
    depCacheFit(src, { maxBytes: 300 });
    expect(JSON.stringify(src)).toBe(before);
  });
});

describe('depCacheEvictLru — least-recently-used orgs go first', () => {
  const org = (lastUsed, pad = 10) => ({ schema: 1, lastUsed, map: {}, stamps: {}, pad: 'x'.repeat(pad) });

  it('keeps the most recently used and evicts the rest at the org cap', () => {
    const store = { a: org(300), b: org(100), c: org(200), d: org(400) };
    const r = depCacheEvictLru(store, { maxOrgs: 2, maxBytes: 1e9 });
    expect(Object.keys(r.store).sort()).toEqual(['a', 'd']);
    expect(r.evicted.sort()).toEqual(['b', 'c']);
    expect(r.count).toBe(2);
  });

  it('never evicts the org being written, even when it is the oldest', () => {
    const store = { a: org(300), b: org(100), c: org(200) };
    const r = depCacheEvictLru(store, { maxOrgs: 1, maxBytes: 1e9, keepKey: 'b' });
    expect(Object.keys(r.store)).toEqual(['b']);
    expect(r.evicted.sort()).toEqual(['a', 'c']);
  });

  it('enforces the BYTE budget as well as the count', () => {
    const store = { a: org(300, 4000), b: org(200, 4000), c: org(100, 4000) };
    const r = depCacheEvictLru(store, { maxOrgs: 10, maxBytes: 9000 });
    expect(Object.keys(r.store).sort()).toEqual(['a', 'b']);
    expect(r.evicted).toEqual(['c']);
    expect(r.bytes).toBeLessThanOrEqual(9000);
  });

  it('evicts even the keepKey when it alone blows the whole budget', () => {
    // A huge org must never push the cache past its slice of chrome.storage.local
    // — the caller reads `evicted` and reports that nothing was stored.
    const store = { big: org(999, 50000) };
    const r = depCacheEvictLru(store, { maxOrgs: 3, maxBytes: 1000, keepKey: 'big' });
    expect(r.store).toEqual({});
    expect(r.evicted).toEqual(['big']);
  });

  it('reports the total bytes it actually kept', () => {
    const store = { a: org(2, 100), b: org(1, 100) };
    const r = depCacheEvictLru(store, { maxOrgs: 3, maxBytes: 1e9 });
    expect(r.bytes).toBe(depJsonBytes(JSON.stringify(store.a)) + depJsonBytes(JSON.stringify(store.b)));
  });

  it('is deterministic when timestamps tie', () => {
    const store = { z: org(5), a: org(5), m: org(5) };
    const r1 = depCacheEvictLru(store, { maxOrgs: 2, maxBytes: 1e9 });
    const r2 = depCacheEvictLru(store, { maxOrgs: 2, maxBytes: 1e9 });
    expect(Object.keys(r1.store)).toEqual(Object.keys(r2.store));
  });

  it('handles an empty or junk store', () => {
    for (const empty of [{}, null, undefined, 'nope']) {
      const r = depCacheEvictLru(empty, { maxOrgs: 3, maxBytes: 1000 });
      expect(r.store).toEqual({});
      expect(r.evicted).toEqual([]);
      expect(r.bytes).toBe(0);
    }
  });

  it('falls back to documented defaults with no opts', () => {
    const store = { a: org(1), b: org(2), c: org(3), d: org(4) };
    expect(Object.keys(depCacheEvictLru(store).store)).toHaveLength(3);   // DEP_CACHE_MAX_ORGS
  });
});

// ════════════════════════════════════════════════════════════════════════
// HONESTY — cached data is never presented as freshly verified
// ════════════════════════════════════════════════════════════════════════

describe('depScanFreshness — "read just now" vs "reused" vs "partial"', () => {
  const NOW = 1_000_000_000;
  const base = { total: 1600, complete: true, now: NOW };

  it('says fully-fresh only when NOTHING came from the cache', () => {
    const f = depScanFreshness({ ...base, done: 1600, fromCache: 0 });
    expect(f.level).toBe('fresh');
    expect(f.text).toMatch(/read from Salesforce just now/);
    expect(f.text).not.toMatch(/cache/i);
  });

  it('says "mostly cached, N updated" and quotes both halves', () => {
    const f = depScanFreshness({ ...base, done: 1600, fromCache: 1598, cacheBuiltAt: NOW - 7200000 });
    expect(f.level).toBe('incremental');
    expect(f.fresh).toBe(2);
    expect(f.cached).toBe(1598);
    expect(f.text).toMatch(/2 of 1600 flow versions were re-read just now/);
    expect(f.text).toMatch(/1598/);
    expect(f.text).toMatch(/2 hours ago/);
    // What is claimed for the cached half is exactly what was PROVEN.
    expect(f.text).toMatch(/LastModifiedDate/);
  });

  it('never calls a fully-cached map "verified just now"', () => {
    const f = depScanFreshness({ ...base, done: 1600, fromCache: 1600, cacheBuiltAt: NOW - 86400000 * 3 });
    expect(f.level).toBe('cached');
    expect(f.text).toMatch(/nothing was re-read/);
    expect(f.text).not.toMatch(/just now/);
  });

  it('reports a partial map as partial, naming what was never looked at', () => {
    const f = depScanFreshness({ ...base, complete: false, done: 900, fromCache: 500, cacheBuiltAt: NOW - 60000 });
    expect(f.level).toBe('partial');
    expect(f.text).toMatch(/900 of 1600/);
    expect(f.text).toMatch(/700 were never read/);
  });

  it('distinguishes "not scanned" from "no dependencies"', () => {
    const f = depScanFreshness({ ...base, complete: false, done: 0, fromCache: 0 });
    expect(f.level).toBe('none');
    expect(f.text).toMatch(/not looked at/);
  });

  it('reports a running scan with the cached head start included', () => {
    const f = depScanFreshness({ ...base, running: true, done: 1500, fromCache: 1400, cacheBuiltAt: NOW - 60000 });
    expect(f.level).toBe('running');
    expect(f.text).toMatch(/1500 of 1600/);
    expect(f.text).toMatch(/1400/);
  });

  it('never claims more cached than covered', () => {
    const f = depScanFreshness({ ...base, done: 10, fromCache: 999 });
    expect(f.cached).toBe(10);
    expect(f.fresh).toBe(0);
  });
});

describe('depCacheAge — when the cache was built', () => {
  const NOW = 1_700_000_000_000;
  it('degrades from minutes to hours to a date', () => {
    expect(depCacheAge(NOW - 10_000, NOW)).toBe('less than a minute ago');
    expect(depCacheAge(NOW - 60_000, NOW)).toBe('1 minute ago');
    expect(depCacheAge(NOW - 45 * 60_000, NOW)).toBe('45 minutes ago');
    expect(depCacheAge(NOW - 3 * 3600_000, NOW)).toBe('3 hours ago');
    expect(depCacheAge(NOW - 3 * 86400_000, NOW)).toMatch(/^3 days ago \(\d{4}-\d{2}-\d{2}\)$/);
  });
  it('says so rather than lying when the timestamp is unusable', () => {
    expect(depCacheAge(0, NOW)).toBe('at an unknown time');
    expect(depCacheAge(null, NOW)).toBe('at an unknown time');
    expect(depCacheAge(NOW + 60_000, NOW)).toMatch(/future/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// TASK C — is this answer safe to trust for a PERMANENT delete?
// ════════════════════════════════════════════════════════════════════════

describe('depDeleteTrust — the destructive path stays authoritative', () => {
  const NOW = 2_000_000_000;
  const live = { complete: true, fromCache: 0, total: 40, stampsAvailable: true, now: NOW };

  it('trusts a map that was read live in this session — with NO extra work', () => {
    const t = depDeleteTrust(live);
    expect(t.safe).toBe(true);
    expect(t.needsLiveRecheck).toBe(false);
    // This is the small-org guarantee: an org that never had a cache issues
    // exactly the requests it issued before the cache existed.
  });

  it('refuses a map that is not complete, and a recheck cannot fix that', () => {
    const t = depDeleteTrust({ ...live, complete: false });
    expect(t.safe).toBe(false);
    expect(t.needsLiveRecheck).toBe(false);
    expect(t.reason).toMatch(/incomplete/);
  });

  it('refuses cached edges that have NOT been re-checked, and asks for a recheck', () => {
    const t = depDeleteTrust({ ...live, fromCache: 1598, total: 1600 });
    expect(t.safe).toBe(false);
    expect(t.needsLiveRecheck).toBe(true);
    expect(t.reason).toMatch(/1598 of the 1600/);
  });

  it('trusts cached edges once a live re-check has confirmed them', () => {
    const t = depDeleteTrust({ ...live, fromCache: 1598, total: 1600, recheckedAt: NOW - 1000 });
    expect(t.safe).toBe(true);
    expect(t.needsLiveRecheck).toBe(false);
    expect(t.reason).toMatch(/re-checked/);
  });

  it('refuses cached edges when the list carries no freshness field to check against', () => {
    const t = depDeleteTrust({ ...live, fromCache: 5, stampsAvailable: false, recheckedAt: NOW });
    expect(t.safe).toBe(false);
    expect(t.needsLiveRecheck).toBe(true);
    expect(t.reason).toMatch(/LastModifiedDate/);
  });

  it('refuses cached edges built against a different API version', () => {
    const t = depDeleteTrust({ ...live, fromCache: 5, apiMismatch: true, recheckedAt: NOW });
    expect(t.safe).toBe(false);
    expect(t.needsLiveRecheck).toBe(true);
    expect(t.reason).toMatch(/API version/);
  });

  it('an api mismatch on a fully-live map is irrelevant — nothing cached is in play', () => {
    expect(depDeleteTrust({ ...live, apiMismatch: true }).safe).toBe(true);
  });

  it('always gives a reason, and defaults to REFUSING on junk input', () => {
    for (const bad of [undefined, null, {}, 'nope']) {
      const t = depDeleteTrust(bad);
      expect(t.safe).toBe(false);
      expect(typeof t.reason).toBe('string');
      expect(t.reason.length).toBeGreaterThan(10);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// Source-level guards — the wiring these pure functions only describe
// ════════════════════════════════════════════════════════════════════════

describe('the scan really goes through the batch primitive', () => {
  const dep = srcOf('dependency-map.js');
  const codeOnly = dep.replace(/^\s*\/\/.*$/gm, '');

  it('sends SF_COMPOSITE_BATCH and no longer fans out SF_GET_METADATA per version', () => {
    expect(codeOnly).toMatch(/type:\s*'SF_COMPOSITE_BATCH'/);
    expect(codeOnly).not.toMatch(/type:\s*'SF_GET_METADATA'/);
  });

  it('drives the batches through the SAME pool, so Stop and resume still work', () => {
    expect(codeOnly).toMatch(/depRunPool\(chunks/);
    expect(codeOnly).toMatch(/shouldStop/);
    expect(codeOnly).toMatch(/_scannedIds\.add/);
  });

  it('sizes the plan and the chunker with ONE constant', () => {
    expect(codeOnly).toMatch(/chunkSize:\s*DEP_SCAN_CHUNK/);
    expect(codeOnly).toMatch(/depScanChunks\(todo,\s*DEP_SCAN_CHUNK\)/);
  });

  it('never writes through the batch primitive — it is a READ path', () => {
    // Every subrequest this file builds is a GET; a write must keep going
    // through the audited single-request handlers.
    expect(codeOnly).not.toMatch(/method:\s*'(POST|PATCH|DELETE|PUT)'[^}]*tooling\/sobjects\/Flow/);
  });
});

describe('popup.js asks for the freshness field and survives losing it', () => {
  const pop = srcOf('popup.js');
  it('selects LastModifiedDate on the Flow list query', () => {
    expect(pop).toMatch(/SELECT \$\{FLOW_FIELDS\},LastModifiedDate FROM Flow/);
  });
  it('falls back to the field-less query rather than losing the flow list', () => {
    expect(pop).toMatch(/INVALID_FIELD/);
    expect(pop).toMatch(/stampField = false/);
  });
  it('primes from the cache before sizing the scan', () => {
    const prime = pop.indexOf('primeFromCache');
    const plan  = pop.indexOf('DependencyMap.scanPlan(DependencyMap.pendingCount(allFlows))');
    expect(prime).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(prime);
  });
  it('re-verifies before a permanent delete when cached edges are in play', () => {
    expect(pop).toMatch(/deleteTrust\(\)/);
    expect(pop).toMatch(/recheckForDelete\(orgUrl, sid/);
    expect(pop).toMatch(/askStaleBeforeDelete/);
  });
});

// ══════════════════════════════════════════════════════════════════
// QA 2026-07-29 — two delete-path holes found by the v1.1.0 release QA.
// Both let "nothing calls this flow" be answered from something that did
// not actually prove it. Deletes are irreversible; these stay pinned.
// ══════════════════════════════════════════════════════════════════
describe('depDeleteTrust — a re-check expires (QA 2026-07-29)', () => {
  const depDeleteTrust = extractFunctions('dependency-map.js', ['depCacheAge', 'depDeleteTrust']).depDeleteTrust;
  const NOW = 2_000_000_000;
  const cached = { complete: true, fromCache: 1598, total: 1600, stampsAvailable: true, now: NOW };

  it('still trusts a re-check from moments ago (deleting several in a row must not re-query each time)', () => {
    const t = depDeleteTrust({ ...cached, recheckedAt: NOW - 30_000 });
    expect(t.safe).toBe(true);
    expect(t.needsLiveRecheck).toBe(false);
  });

  it('REFUSES a re-check older than the TTL — the bug was that one re-check authorised every later delete in the session', () => {
    const t = depDeleteTrust({ ...cached, recheckedAt: NOW - 6 * 60 * 1000 });
    expect(t.safe).toBe(false);
    expect(t.needsLiveRecheck).toBe(true);
    expect(t.reason).toMatch(/too long ago/i);
  });

  it('a popup left open for hours cannot answer a delete from that morning\'s proof', () => {
    const t = depDeleteTrust({ ...cached, recheckedAt: NOW - 4 * 60 * 60 * 1000 });
    expect(t.safe).toBe(false);
  });

  it('an all-live map is unaffected by the TTL — it never needed a re-check', () => {
    const t = depDeleteTrust({ complete: true, fromCache: 0, total: 40, stampsAvailable: true, now: NOW });
    expect(t.safe).toBe(true);
    expect(t.needsLiveRecheck).toBe(false);
  });
});

describe('depBatchApply — only a success or a 404 proves anything (QA 2026-07-29)', () => {
  const depBatchApply = extractFunction('dependency-map.js', 'depBatchApply');
  const chunk = [{ Id: '301a' }, { Id: '301b' }, { Id: '301c' }];

  it('counts a 404 as covered — an obsolete version is legitimately gone', () => {
    const out = depBatchApply([{ Id: '301a' }], [{ ok: false, status: 404 }]);
    expect(out.covered).toHaveLength(1);
    expect(out.unread).toHaveLength(0);
  });

  it('does NOT count a 403 as covered — no permission means we do not know what it calls', () => {
    const out = depBatchApply([{ Id: '301a' }], [{ ok: false, status: 403 }]);
    expect(out.covered).toHaveLength(0);
    expect(out.unread).toHaveLength(1);
  });

  it('does NOT count a 500 as covered — a transient failure is not proof of "calls nothing"', () => {
    const out = depBatchApply([{ Id: '301a' }], [{ ok: false, status: 500 }]);
    expect(out.covered).toHaveLength(0);
    expect(out.unread).toHaveLength(1);
  });

  it('a mixed chunk splits correctly and only the readable one yields metadata', () => {
    const out = depBatchApply(chunk, [
      { ok: true, status: 200, body: { Metadata: { start: {} } } },
      { ok: false, status: 403 },
      { ok: false, status: 404 },
    ]);
    expect(out.covered.map(f => f.Id)).toEqual(['301a', '301c']);
    expect(out.unread.map(f => f.Id)).toEqual(['301b']);
    expect(out.metas).toHaveLength(1);
  });

  it('an unreadable version leaves the scan incomplete, which depDeleteTrust already refuses to call safe', () => {
    const out = depBatchApply(chunk, [
      { ok: true, status: 200, body: { Metadata: {} } },
      { ok: false, status: 403 },
      { ok: true, status: 200, body: { Metadata: {} } },
    ]);
    const depScanOutcome = extractFunction('dependency-map.js', 'depScanOutcome');
    const outcome = depScanOutcome(chunk.length, out.covered.length, false);
    expect(outcome.complete).toBe(false);
    expect(outcome.missing).toBe(1);
  });
});
