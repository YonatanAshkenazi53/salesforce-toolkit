// Composite batch — 25 reads per round-trip, and the alignment guarantee that
// makes that safe.
//
// The v1.0.1 work fixed silent truncation and eager fan-out. What was left is
// pure arithmetic: a Tooling read is one HTTP round-trip per item, so an org
// with 1600 flow versions pays 1600 round-trips however well the pool is tuned.
// /composite/batch takes 25 subrequests per POST with identical per-subrequest
// semantics, turning that into 64.
//
// The thing that can go catastrophically wrong here is NOT slowness. A
// composite/batch response is a bare positional array — { statusCode, result }
// with no echo of the url, id, or anything else naming the subrequest it
// answers. If the server ever returns a different NUMBER of results than we
// sent, every answer after the gap shifts one place and the response still
// parses perfectly. That would attach one flow's metadata to a different flow
// and report it as a clean success. So the ragged-response cases below are the
// centre of this file, not an edge case appendix: a length mismatch must fail
// the WHOLE chunk rather than align the ones that probably line up.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractFunction, extractFunctions } from './extract.mjs';

// Pure helpers, materialised in one scope so they can call each other.
const P = extractFunctions('background.js', [
  'sftkBatchSubUrl', 'sftkBatchChunks', 'sftkBatchBody',
  'sftkBatchItemError', 'sftkBatchFailAll', 'sftkBatchNormalize'
]);
const {
  sftkBatchSubUrl, sftkBatchChunks, sftkBatchBody,
  sftkBatchItemError, sftkBatchFailAll, sftkBatchNormalize
} = P;

const sftkIsWriteRequest = extractFunction('background.js', 'sftkIsWriteRequest');

// The two I/O functions, materialised in the SAME scope as the pure helpers so
// their internal calls resolve. Their remaining free names (sfFetchWithProxy,
// API_VERSION, sfErrorMsg) resolve against globalThis at CALL time, which is
// exactly the seam a test double needs — the real chokepoint is replaced, the
// real batching/reassembly code under test is not.
const IO = extractFunctions('background.js', [
  'sftkBatchSubUrl', 'sftkBatchChunks', 'sftkBatchBody',
  'sftkBatchItemError', 'sftkBatchFailAll', 'sftkBatchNormalize',
  'sfErrorMsg', 'sfCompositeBatch', 'sfRunBatchedReads'
]);
const { sfCompositeBatch, sfRunBatchedReads } = IO;

const ORG = 'https://acme.my.salesforce.com';
const SID = '00Dxx!fake';
const BATCH_URL = `${ORG}/services/data/v62.0/composite/batch`;

// ── Test double for the fetch chokepoint ────────────────────────────────────
// Records every batch POST and lets each test decide what comes back. `handler`
// receives the parsed call and returns a { ok, status, body } like the real
// sfFetchWithProxy, or throws to simulate SESSION_EXPIRED / network death.
let calls;
const okBody = (results, hasErrors) =>
  JSON.stringify({ hasErrors: hasErrors ?? results.some(r => r.statusCode >= 300), results });

// Default server: answers every subrequest 200 with a body that names the url,
// so a misaligned result is detectable by inspection.
const echoServer = (call) => ({
  ok: true,
  status: 200,
  body: okBody(call.batchRequests.map(r => ({ statusCode: 200, result: { echo: r.url } })))
});

function server(handler = echoServer) {
  calls = [];
  globalThis.sfFetchWithProxy = async (orgUrl, sid, url, opts) => {
    const payload = JSON.parse(opts.body);
    const call = {
      orgUrl, sid, url,
      method: opts.method,
      batchRequests: payload.batchRequests,
      n: calls.length
    };
    calls.push(call);
    return handler(call, call.n);
  };
  return calls;
}

beforeEach(() => {
  globalThis.API_VERSION = 'v62.0';
  server();
});
afterEach(() => {
  delete globalThis.sfFetchWithProxy;
  delete globalThis.API_VERSION;
});

const subs = (n, prefix = 'tooling/sobjects/Flow/301x') =>
  Array.from({ length: n }, (_, i) => ({ method: 'GET', url: `${prefix}${i}` }));

// ════════════════════════════════════════════════════════════════════════
describe('sftkBatchChunks — 25 is a server limit, not a preference', () => {
  it('makes zero chunks for zero items, so zero items costs zero HTTP calls', () => {
    expect(sftkBatchChunks([], 25)).toEqual([]);
    expect(sftkBatchChunks([])).toEqual([]);
  });

  it('handles 1, exactly 25, 26 and 100 at the documented boundaries', () => {
    expect(sftkBatchChunks(subs(1)).map(c => c.length)).toEqual([1]);
    expect(sftkBatchChunks(subs(25)).map(c => c.length)).toEqual([25]);
    expect(sftkBatchChunks(subs(26)).map(c => c.length)).toEqual([25, 1]);
    expect(sftkBatchChunks(subs(100)).map(c => c.length)).toEqual([25, 25, 25, 25]);
  });

  it('never emits a chunk above 25 however big a size is asked for', () => {
    for (const size of [26, 50, 200, Infinity]) {
      const chunks = sftkBatchChunks(subs(100), size);
      expect(Math.max(...chunks.map(c => c.length))).toBeLessThanOrEqual(25);
      expect(chunks.reduce((a, c) => a + c.length, 0)).toBe(100);
    }
  });

  it('honours a SMALLER size — large payloads (flow metadata) need it', () => {
    expect(sftkBatchChunks(subs(26), 10).map(c => c.length)).toEqual([10, 10, 6]);
    expect(sftkBatchChunks(subs(3), 1).map(c => c.length)).toEqual([1, 1, 1]);
  });

  it('falls back to 25 for junk sizes instead of 1-per-call or all-in-one', () => {
    for (const bad of [undefined, null, NaN, 0, -5, 'lots', {}, []]) {
      expect(sftkBatchChunks(subs(30), bad).map(c => c.length)).toEqual([25, 5]);
    }
  });

  it('treats a non-array as nothing to do rather than throwing at the caller', () => {
    for (const bad of [undefined, null, 'x', 7, {}]) expect(sftkBatchChunks(bad)).toEqual([]);
  });

  it('preserves order and covers every input exactly once', () => {
    const list = subs(103);
    const flat = sftkBatchChunks(list).flat();
    expect(flat).toHaveLength(103);
    expect(flat.map(s => s.url)).toEqual(list.map(s => s.url));
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('sftkBatchSubUrl — the shape composite/batch actually speaks', () => {
  // Salesforce subrequest urls start at the VERSION segment. Sending
  // "/services/data/v62.0/..." inside batchRequests comes back an error, not
  // the record, so every accepted input form has to land on the same output.
  it('strips the /services/data/ prefix in every form callers already have', () => {
    const want = 'v62.0/tooling/sobjects/Flow/301x0';
    expect(sftkBatchSubUrl('/services/data/v62.0/tooling/sobjects/Flow/301x0', 'v62.0')).toBe(want);
    expect(sftkBatchSubUrl('services/data/v62.0/tooling/sobjects/Flow/301x0', 'v62.0')).toBe(want);
    expect(sftkBatchSubUrl(`${ORG}/services/data/v62.0/tooling/sobjects/Flow/301x0`, 'v62.0')).toBe(want);
    expect(sftkBatchSubUrl('v62.0/tooling/sobjects/Flow/301x0', 'v62.0')).toBe(want);
    expect(sftkBatchSubUrl('/v62.0/tooling/sobjects/Flow/301x0', 'v62.0')).toBe(want);
    expect(sftkBatchSubUrl('tooling/sobjects/Flow/301x0', 'v62.0')).toBe(want);
    expect(sftkBatchSubUrl('/tooling/sobjects/Flow/301x0', 'v62.0')).toBe(want);
  });

  it('rewrites a stale version so one scan can never straddle two API versions', () => {
    expect(sftkBatchSubUrl('/services/data/v52.0/sobjects/Account/describe', 'v62.0'))
      .toBe('v62.0/sobjects/Account/describe');
    expect(sftkBatchSubUrl('v58.0/tooling/query?q=SELECT+Id', 'v62.0'))
      .toBe('v62.0/tooling/query?q=SELECT+Id');
  });

  it('keeps query strings intact — batched queries are a real use', () => {
    expect(sftkBatchSubUrl('/services/data/v62.0/query?q=SELECT%20Id%20FROM%20Account', 'v62.0'))
      .toBe('v62.0/query?q=SELECT%20Id%20FROM%20Account');
  });

  it('does not mistake a path segment that merely starts with v for a version', () => {
    expect(sftkBatchSubUrl('validation/rules', 'v62.0')).toBe('v62.0/validation/rules');
    expect(sftkBatchSubUrl('v62x/thing', 'v62.0')).toBe('v62.0/v62x/thing');
  });

  it('leaves the url alone when no version is supplied — never invents one', () => {
    // A hard-coded fallback version here would silently go stale against
    // API_VERSION; an unversioned url fails loudly at the server instead.
    expect(sftkBatchSubUrl('/services/data/v58.0/sobjects/Account', '')).toBe('v58.0/sobjects/Account');
    expect(sftkBatchSubUrl('sobjects/Account', '')).toBe('sobjects/Account');
    expect(sftkBatchSubUrl('sobjects/Account', null)).toBe('sobjects/Account');
  });

  it('returns empty for empty/garbage input rather than a half-formed path', () => {
    for (const bad of ['', '   ', null, undefined]) expect(sftkBatchSubUrl(bad, 'v62.0')).toBe('');
    expect(sftkBatchSubUrl('https://acme.my.salesforce.com', 'v62.0')).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('sftkBatchBody — the exact POST payload Salesforce documents', () => {
  it('wraps subrequests in batchRequests with normalised method and url', () => {
    expect(sftkBatchBody([
      { url: '/services/data/v50.0/sobjects/Account/describe' },
      { method: 'get', url: 'tooling/sobjects/Flow/301x' }
    ], 'v62.0')).toEqual({
      batchRequests: [
        { method: 'GET', url: 'v62.0/sobjects/Account/describe' },
        { method: 'GET', url: 'v62.0/tooling/sobjects/Flow/301x' }
      ]
    });
  });

  it('defaults a missing method to GET and upper-cases whatever is given', () => {
    const b = sftkBatchBody([{ url: 'a' }, { method: 'patch', url: 'b' }], 'v62.0');
    expect(b.batchRequests.map(r => r.method)).toEqual(['GET', 'PATCH']);
  });

  it('produces an empty batchRequests for an empty or junk chunk', () => {
    expect(sftkBatchBody([], 'v62.0')).toEqual({ batchRequests: [] });
    expect(sftkBatchBody(null, 'v62.0')).toEqual({ batchRequests: [] });
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('sftkBatchNormalize — per-subrequest verdicts, positionally aligned', () => {
  const sent = n => Array.from({ length: n }, (_, i) => ({ method: 'GET', url: `v62.0/x${i}` }));
  const res = (...statuses) => ({
    hasErrors: statuses.some(s => s >= 300),
    results: statuses.map((statusCode, i) => ({ statusCode, result: { slot: i } }))
  });

  it('maps a clean batch 1:1 and offsets indices into the caller array', () => {
    const out = sftkBatchNormalize(sent(3), res(200, 200, 200), 25);
    expect(out).toHaveLength(3);
    expect(out.map(r => r.index)).toEqual([25, 26, 27]);
    expect(out.map(r => r.ok)).toEqual([true, true, true]);
    expect(out.map(r => r.body.slot)).toEqual([0, 1, 2]);
    expect(out.every(r => r.error === undefined)).toBe(true);
    expect(out.every(r => r.batchError === false)).toBe(true);
  });

  it('isolates a mid-batch failure — one 404 does not disturb its neighbours', () => {
    const out = sftkBatchNormalize(sent(5), {
      hasErrors: true,
      results: [
        { statusCode: 200, result: { slot: 0 } },
        { statusCode: 200, result: { slot: 1 } },
        { statusCode: 404, result: [{ message: 'not found', errorCode: 'NOT_FOUND' }] },
        { statusCode: 200, result: { slot: 3 } },
        { statusCode: 200, result: { slot: 4 } }
      ]
    }, 0);
    expect(out.map(r => r.ok)).toEqual([true, true, false, true, true]);
    expect(out[2].error).toContain('not found');
    expect(out[2].status).toBe(404);
    // The failure is this ITEM's, not the call's — the caller must be able to
    // retry item 2 alone instead of throwing away four good reads.
    expect(out[2].batchError).toBe(false);
    expect(out[3].body.slot).toBe(3);
  });

  it('handles a mixed batch of many statuses without cross-contamination', () => {
    const out = sftkBatchNormalize(sent(6), res(200, 400, 201, 500, 204, 403), 0);
    expect(out.map(r => r.status)).toEqual([200, 400, 201, 500, 204, 403]);
    expect(out.map(r => r.ok)).toEqual([true, false, true, false, true, false]);
    out.forEach((r, i) => expect(r.body.slot).toBe(i));   // still its own payload
  });

  it('trusts per-item statusCode over the hasErrors summary flag, both ways', () => {
    // hasErrors true but every subrequest succeeded: reporting all-failed here
    // is how a good batch gets thrown away.
    const allOk = sftkBatchNormalize(sent(2), { hasErrors: true, results: [
      { statusCode: 200, result: 1 }, { statusCode: 200, result: 2 }] }, 0);
    expect(allOk.map(r => r.ok)).toEqual([true, true]);
    // hasErrors false but a subrequest 400'd: the status is the authority.
    const oneBad = sftkBatchNormalize(sent(2), { hasErrors: false, results: [
      { statusCode: 200, result: 1 }, { statusCode: 400, result: [{ message: 'bad' }] }] }, 0);
    expect(oneBad.map(r => r.ok)).toEqual([true, false]);
  });

  it('carries the request url and method onto every result', () => {
    const out = sftkBatchNormalize(sent(2), res(200, 200), 0);
    expect(out.map(r => r.url)).toEqual(['v62.0/x0', 'v62.0/x1']);
    expect(out.map(r => r.method)).toEqual(['GET', 'GET']);
  });

  it('treats a 2xx with no result payload as a success with no body (204)', () => {
    const out = sftkBatchNormalize(sent(1), { results: [{ statusCode: 204 }] }, 0);
    expect(out[0].ok).toBe(true);
    expect(out[0].body).toBeUndefined();
    expect('body' in out[0]).toBe(true);   // key always present, shape is stable
  });

  it('refuses to guess when a statusCode is missing or unreadable', () => {
    const out = sftkBatchNormalize(sent(3), { results: [
      { result: 1 }, { statusCode: 'fine', result: 2 }, null] }, 0);
    expect(out.map(r => r.ok)).toEqual([false, false, false]);
    expect(out.map(r => r.status)).toEqual([0, 0, 0]);
    expect(out.every(r => typeof r.error === 'string' && r.error.length > 0)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
// THE ONE THAT MATTERS MOST.
describe('sftkBatchNormalize — a ragged response can never misattribute data', () => {
  const sent = n => Array.from({ length: n }, (_, i) => ({ method: 'GET', url: `v62.0/flow${i}` }));

  it('fails the WHOLE chunk when the server returns fewer results than requests', () => {
    // 25 flows asked for, 24 answered. Whichever subrequest was dropped, every
    // answer after it is shifted — and nothing in the response says which. The
    // only honest verdict is that none of these 25 can be trusted.
    const out = sftkBatchNormalize(sent(25), {
      hasErrors: false,
      results: Array.from({ length: 24 }, (_, i) => ({ statusCode: 200, result: { flow: i } }))
    }, 0);
    expect(out).toHaveLength(25);
    expect(out.every(r => r.ok === false)).toBe(true);
    expect(out.every(r => r.batchError === true)).toBe(true);
    // No item is handed a payload that might belong to a different flow.
    expect(out.every(r => r.body === undefined)).toBe(true);
    expect(out[0].error).toMatch(/24 result\(s\) for 25 subrequest\(s\)/);
    expect(out[0].error).toMatch(/cannot be matched/i);
  });

  it('names the specific counts so the failure is diagnosable, not vague', () => {
    const out = sftkBatchNormalize(sent(10), { results: [{ statusCode: 200, result: 1 }] }, 0);
    expect(out[0].error).toContain('1 result(s) for 10 subrequest(s)');
  });

  it('fails the whole chunk when the server OVER-delivers too', () => {
    // An extra result is just as much a protocol break; aligning the first N
    // "because they probably line up" is the guess this function exists to
    // refuse.
    const out = sftkBatchNormalize(sent(2), {
      results: [{ statusCode: 200, result: 'a' }, { statusCode: 200, result: 'b' }, { statusCode: 200, result: 'c' }]
    }, 0);
    expect(out).toHaveLength(2);
    expect(out.every(r => r.ok === false && r.batchError === true)).toBe(true);
    expect(out.every(r => r.body === undefined)).toBe(true);
  });

  it('fails the whole chunk when there is no results array at all', () => {
    for (const junk of [{}, { results: null }, { results: 'nope' }, null, 'garbage', 42]) {
      const out = sftkBatchNormalize(sent(3), junk, 0);
      expect(out).toHaveLength(3);
      expect(out.every(r => r.ok === false && r.batchError === true)).toBe(true);
      expect(out.every(r => r.body === undefined)).toBe(true);
    }
  });

  it('keeps the caller-array indices correct even when the chunk is rejected', () => {
    // A later chunk failing must still report ITS OWN slots, or the caller
    // re-tries the wrong flows.
    const out = sftkBatchNormalize(sent(3), { results: [] }, 50);
    expect(out.map(r => r.index)).toEqual([50, 51, 52]);
    expect(out.map(r => r.url)).toEqual(['v62.0/flow0', 'v62.0/flow1', 'v62.0/flow2']);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('sftkBatchFailAll / sftkBatchItemError', () => {
  it('marks every item of a dead call with the same reason and batchError', () => {
    const out = sftkBatchFailAll([{ method: 'GET', url: 'a' }, { method: 'GET', url: 'b' }], 7, 'HTTP 503: down');
    expect(out.map(r => r.index)).toEqual([7, 8]);
    expect(out.every(r => r.ok === false && r.batchError === true && r.status === 0)).toBe(true);
    expect(out.every(r => r.error === 'HTTP 503: down')).toBe(true);
    expect(out.every(r => r.body === undefined)).toBe(true);
  });

  it('survives junk input without inventing items', () => {
    expect(sftkBatchFailAll(null, 0, 'x')).toEqual([]);
    expect(sftkBatchFailAll([{}], NaN, '')[0].index).toBe(0);
    expect(sftkBatchFailAll([{}], -3, '')[0].error).toBeTruthy();  // never blank
  });

  it('pulls the Salesforce message out of every error payload shape', () => {
    expect(sftkBatchItemError(404, [{ message: 'gone', errorCode: 'NOT_FOUND' }], 'u')).toBe('HTTP 404: gone');
    expect(sftkBatchItemError(400, [{ errorCode: 'MALFORMED_QUERY' }], 'u')).toBe('HTTP 400: MALFORMED_QUERY');
    expect(sftkBatchItemError(500, { message: 'boom' }, 'u')).toBe('HTTP 500: boom');
    expect(sftkBatchItemError(403, 'forbidden', 'u')).toBe('HTTP 403: forbidden');
    expect(sftkBatchItemError(500, null, 'v62.0/x')).toContain('500');
    expect(sftkBatchItemError(0, null, 'v62.0/x')).toContain('v62.0/x');
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('sftkIsWriteRequest — the read-only-org guard still blocks every write', () => {
  const batchBody = (...methods) => JSON.stringify({ batchRequests: methods.map(m => ({ method: m, url: 'v62.0/x' })) });

  it('is exactly "not a GET" for every caller that predates composite/batch', () => {
    expect(sftkIsWriteRequest('GET', `${ORG}/services/data/v62.0/query?q=x`)).toBe(false);
    expect(sftkIsWriteRequest('POST', `${ORG}/services/data/v62.0/sobjects/Account`, '{}')).toBe(true);
    expect(sftkIsWriteRequest('PATCH', `${ORG}/services/data/v62.0/sobjects/Account/001`, '{}')).toBe(true);
    expect(sftkIsWriteRequest('DELETE', `${ORG}/services/data/v62.0/tooling/sobjects/Flow/301`)).toBe(true);
    expect(sftkIsWriteRequest('PUT', `${ORG}/services/data/v62.0/jobs/ingest/x/batches`, 'a,b')).toBe(true);
  });

  it('clears an all-GET composite batch — a read that happens to be a POST', () => {
    expect(sftkIsWriteRequest('POST', BATCH_URL, batchBody('GET', 'GET', 'GET'))).toBe(false);
    expect(sftkIsWriteRequest('POST', BATCH_URL, batchBody('get'))).toBe(false);
  });

  it('blocks a batch the moment ONE subrequest can write', () => {
    expect(sftkIsWriteRequest('POST', BATCH_URL, batchBody('GET', 'PATCH', 'GET'))).toBe(true);
    expect(sftkIsWriteRequest('POST', BATCH_URL, batchBody('DELETE'))).toBe(true);
    expect(sftkIsWriteRequest('POST', BATCH_URL, batchBody('GET', 'POST'))).toBe(true);
  });

  it('fails CLOSED on anything it cannot read — the exemption is proved, not trusted', () => {
    expect(sftkIsWriteRequest('POST', BATCH_URL, 'not json')).toBe(true);
    expect(sftkIsWriteRequest('POST', BATCH_URL, '')).toBe(true);
    expect(sftkIsWriteRequest('POST', BATCH_URL, null)).toBe(true);
    expect(sftkIsWriteRequest('POST', BATCH_URL, '{}')).toBe(true);
    expect(sftkIsWriteRequest('POST', BATCH_URL, JSON.stringify({ batchRequests: [] }))).toBe(true);
    expect(sftkIsWriteRequest('POST', BATCH_URL, JSON.stringify({ batchRequests: 'x' }))).toBe(true);
    expect(sftkIsWriteRequest('POST', BATCH_URL, JSON.stringify({ batchRequests: [{ url: 'x' }] }))).toBe(true);
  });

  it('cannot be talked into an exemption by a lookalike url or method', () => {
    // Only a POST to the batch endpoint itself is ever considered.
    expect(sftkIsWriteRequest('PATCH', BATCH_URL, batchBody('GET'))).toBe(true);
    expect(sftkIsWriteRequest('POST', `${ORG}/services/data/v62.0/composite/sobjects`, batchBody('GET'))).toBe(true);
    expect(sftkIsWriteRequest('POST', `${ORG}/services/data/v62.0/composite`, batchBody('GET'))).toBe(true);
    expect(sftkIsWriteRequest('POST', `${ORG}/composite/batcher`, batchBody('GET'))).toBe(true);
    // …and the real endpoint is still recognised with a query string on it.
    expect(sftkIsWriteRequest('POST', `${BATCH_URL}?x=1`, batchBody('GET'))).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('sfCompositeBatch — call reduction with the order guarantee intact', () => {
  it('costs ZERO HTTP calls for zero subrequests', async () => {
    await expect(sfCompositeBatch(ORG, SID, [])).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('throws on a non-array rather than quietly answering "nothing to do"', async () => {
    for (const bad of [undefined, null, 'x', 7, { url: 'a' }]) {
      await expect(sfCompositeBatch(ORG, SID, bad)).rejects.toThrow(/must be an array/);
    }
  });

  it('POSTs the documented payload to the documented endpoint', async () => {
    await sfCompositeBatch(ORG, SID, [{ url: '/services/data/v62.0/tooling/sobjects/Flow/301x' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(BATCH_URL);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].batchRequests).toEqual([{ method: 'GET', url: 'v62.0/tooling/sobjects/Flow/301x' }]);
  });

  it('turns 1600 per-item reads into 64 round-trips — the whole point', async () => {
    const out = await sfCompositeBatch(ORG, SID, subs(1600));
    expect(calls).toHaveLength(64);
    expect(out).toHaveLength(1600);
    expect(out.every(r => r.ok)).toBe(true);
  });

  it('auto-chunks at the boundaries: 1, 25, 26, 100', async () => {
    for (const [n, expected] of [[1, 1], [25, 1], [26, 2], [100, 4]]) {
      server();
      const out = await sfCompositeBatch(ORG, SID, subs(n));
      expect(calls).toHaveLength(expected);
      expect(out).toHaveLength(n);
    }
  });

  it('keeps INPUT order across chunks, with matching indices', async () => {
    const out = await sfCompositeBatch(ORG, SID, subs(100));
    out.forEach((r, i) => {
      expect(r.index).toBe(i);
      expect(r.body.echo).toBe(`v62.0/tooling/sobjects/Flow/301x${i}`);
    });
  });

  it('keeps INPUT order when batches settle OUT of order under concurrency', async () => {
    // Batch 0 is slowest, batch 3 fastest — completion order is the reverse of
    // request order, and the output must not notice.
    server(async (call) => {
      const delay = (4 - call.n) * 12;
      await new Promise(r => setTimeout(r, delay));
      return echoServer(call);
    });
    const out = await sfCompositeBatch(ORG, SID, subs(100), { concurrency: 4 });
    expect(calls).toHaveLength(4);
    out.forEach((r, i) => expect(r.body.echo).toBe(`v62.0/tooling/sobjects/Flow/301x${i}`));
  });

  it('honours a smaller chunkSize for large payloads like flow metadata', async () => {
    await sfCompositeBatch(ORG, SID, subs(26), { chunkSize: 10 });
    expect(calls.map(c => c.batchRequests.length)).toEqual([10, 10, 6]);
  });

  it('reports progress in ITEMS, monotonically, ending at the total', async () => {
    const seen = [];
    await sfCompositeBatch(ORG, SID, subs(60), { onProgress: (d, t) => seen.push([d, t]) });
    expect(seen.map(s => s[1])).toEqual([60, 60, 60]);
    expect(seen.map(s => s[0])).toEqual([25, 50, 60]);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('sfCompositeBatch — one failure never takes the rest down', () => {
  it('isolates a failing subrequest inside an otherwise good batch', async () => {
    server(call => ({
      ok: true, status: 200,
      body: okBody(call.batchRequests.map((r, i) =>
        i === 3 ? { statusCode: 404, result: [{ message: 'deleted flow', errorCode: 'NOT_FOUND' }] }
                : { statusCode: 200, result: { echo: r.url } }))
    }));
    const out = await sfCompositeBatch(ORG, SID, subs(10));
    expect(out.filter(r => r.ok)).toHaveLength(9);
    expect(out[3].ok).toBe(false);
    expect(out[3].error).toContain('deleted flow');
    expect(out[3].batchError).toBe(false);        // "this item", not "this call"
    expect(out[4].body.echo).toBe('v62.0/tooling/sobjects/Flow/301x4');
  });

  it('confines a dead BATCH to its own 25 items and marks it batchError', async () => {
    server(call => call.n === 1
      ? { ok: false, status: 500, body: JSON.stringify([{ message: 'Server error' }]) }
      : echoServer(call));
    const out = await sfCompositeBatch(ORG, SID, subs(75));
    expect(out.slice(0, 25).every(r => r.ok)).toBe(true);
    expect(out.slice(25, 50).every(r => r.ok === false && r.batchError === true)).toBe(true);
    expect(out.slice(25, 50).every(r => r.error.includes('Server error'))).toBe(true);
    expect(out.slice(50).every(r => r.ok)).toBe(true);
    // Still one entry per input, still in order.
    expect(out).toHaveLength(75);
    out.forEach((r, i) => expect(r.index).toBe(i));
  });

  it('treats an unreadable response body as a failed CALL, not as empty data', async () => {
    server(() => ({ ok: true, status: 200, body: '<html>login page</html>' }));
    const out = await sfCompositeBatch(ORG, SID, subs(3));
    expect(out.every(r => r.ok === false && r.batchError === true)).toBe(true);
    expect(out.every(r => r.error.includes('unreadable'))).toBe(true);
    expect(out.every(r => r.body === undefined)).toBe(true);
  });

  it('never lets a short server response shift one flow onto another', async () => {
    // Batch 1 answers 24 of 25. Every item of that batch must be unreadable —
    // and crucially item 25..49 must NOT carry item 26..50's payloads.
    server(call => call.n === 1
      ? { ok: true, status: 200, body: okBody(call.batchRequests.slice(1).map(r => ({ statusCode: 200, result: { echo: r.url } }))) }
      : echoServer(call));
    const out = await sfCompositeBatch(ORG, SID, subs(50));
    expect(out.slice(0, 25).every(r => r.ok)).toBe(true);
    const bad = out.slice(25, 50);
    expect(bad.every(r => r.ok === false && r.batchError === true)).toBe(true);
    expect(bad.every(r => r.body === undefined)).toBe(true);
    // The proof: no result in the failed range echoes a url other than its own.
    bad.forEach((r, i) => expect(r.url).toBe(`v62.0/tooling/sobjects/Flow/301x${25 + i}`));
  });

  it('lets SESSION_EXPIRED propagate so the message-level retry still works', async () => {
    // Swallowing this would convert a recoverable Lightning cookie rotation
    // into 25 permanently dead items.
    server(() => { throw new Error('SESSION_EXPIRED'); });
    await expect(sfCompositeBatch(ORG, SID, subs(5))).rejects.toThrow('SESSION_EXPIRED');
  });

  it('stops dispatching on shouldStop and leaves unread slots ABSENT', async () => {
    let n = 0;
    const out = await sfCompositeBatch(ORG, SID, subs(100), { shouldStop: () => n++ >= 2 });
    expect(calls).toHaveLength(2);
    expect(out.slice(0, 50).every(r => r && r.ok)).toBe(true);
    // Not read is not the same as read-and-empty.
    expect(out.slice(50).every(r => r === undefined)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('sfRunBatchedReads — batched pool with per-item progress', () => {
  const items = n => Array.from({ length: n }, (_, i) => ({ id: `301x${i}` }));
  const build = it_ => `tooling/sobjects/Flow/${it_.id}`;

  it('answers an empty list without touching the network', async () => {
    const r = await sfRunBatchedReads(ORG, SID, [], build);
    expect(r).toMatchObject({ done: 0, total: 0, stopped: false, complete: true, batches: 0, calls: 0 });
    expect(calls).toHaveLength(0);
  });

  it('preserves item order through batching and out-of-order completion', async () => {
    server(async (call) => {
      await new Promise(r => setTimeout(r, (4 - call.n) * 10));
      return echoServer(call);
    });
    const r = await sfRunBatchedReads(ORG, SID, items(100), build, { concurrency: 4 });
    expect(r.complete).toBe(true);
    expect(r.done).toBe(100);
    expect(r.batches).toBe(4);
    expect(r.calls).toBe(4);
    r.results.forEach((res, i) => {
      expect(res.index).toBe(i);
      expect(res.body.echo).toBe(`v62.0/tooling/sobjects/Flow/301x${i}`);
    });
  });

  it('reports progress per settled ITEM so an existing "n of m" UI stays true', async () => {
    const seen = [];
    await sfRunBatchedReads(ORG, SID, items(60), build, {
      concurrency: 1, onProgress: (d, t) => seen.push([d, t])
    });
    expect(seen.map(s => s[1]).every(t => t === 60)).toBe(true);
    expect(seen.map(s => s[0])).toEqual([25, 50, 60]);        // items, not batches
    const done = seen.map(s => s[0]);
    expect([...done].sort((a, b) => a - b)).toEqual(done);     // monotonic
    expect(done[done.length - 1]).toBe(60);
  });

  it('accepts either a url string or a {method,url} from the builder', async () => {
    await sfRunBatchedReads(ORG, SID, items(2), (x, i) =>
      i === 0 ? `tooling/sobjects/Flow/${x.id}` : { method: 'GET', url: `tooling/sobjects/Flow/${x.id}` });
    expect(calls[0].batchRequests.map(r => r.method)).toEqual(['GET', 'GET']);
  });

  it('keeps the slot of an item the builder could not describe', async () => {
    // The dangerous alternative is dropping it, which shifts every later
    // answer one place left — the same misattribution the normaliser refuses.
    const r = await sfRunBatchedReads(ORG, SID, items(5), (x, i) => (i === 2 ? null : build(x)));
    expect(r.results).toHaveLength(5);
    expect(r.done).toBe(5);
    expect(r.complete).toBe(true);
    expect(r.results[2].ok).toBe(false);
    expect(r.results[2].error).toMatch(/no subrequest was built/);
    expect(r.results[2].batchError).toBe(false);
    expect(r.results[3].body.echo).toBe('v62.0/tooling/sobjects/Flow/301x3');
    expect(calls[0].batchRequests).toHaveLength(4);   // only 4 were ever asked for
  });

  it('treats a throwing builder the same way — that item, not the run', async () => {
    const r = await sfRunBatchedReads(ORG, SID, items(4), (x, i) => {
      if (i === 1) throw new Error('bad item');
      return build(x);
    });
    expect(r.results[1].ok).toBe(false);
    expect(r.results[0].ok).toBe(true);
    expect(r.results[2].ok).toBe(true);
    expect(r.done).toBe(4);
  });

  it('reports a stop honestly: stopped, not complete, unread items absent', async () => {
    let n = 0;
    const r = await sfRunBatchedReads(ORG, SID, items(100), build, {
      concurrency: 1, shouldStop: () => n++ >= 2
    });
    expect(r.stopped).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.done).toBe(50);
    expect(r.calls).toBe(2);
    expect(r.batches).toBe(4);                       // what it WOULD have cost
    expect(r.results.slice(50).every(x => x === undefined)).toBe(true);
  });

  it('does not call a completed run "stopped" just because Stop came late', async () => {
    // Same rule as depRunPool/lpRunPool: complete is decided by the count.
    const r = await sfRunBatchedReads(ORG, SID, items(10), build, { shouldStop: () => false });
    expect(r.stopped).toBe(false);
    expect(r.complete).toBe(true);
  });

  it('surfaces a failed batch per item without failing the run', async () => {
    server(call => call.n === 0
      ? { ok: false, status: 503, body: JSON.stringify([{ message: 'Service unavailable' }]) }
      : echoServer(call));
    const r = await sfRunBatchedReads(ORG, SID, items(50), build, { concurrency: 1 });
    expect(r.complete).toBe(true);                   // every item was settled…
    expect(r.results.slice(0, 25).every(x => x.ok === false && x.batchError)).toBe(true);
    expect(r.results.slice(25).every(x => x.ok)).toBe(true);   // …25 of them badly
  });

  it('quotes a call count that matches the round-trips actually made', async () => {
    const r = await sfRunBatchedReads(ORG, SID, items(1600), build, { concurrency: 5 });
    expect(r.batches).toBe(64);
    expect(r.calls).toBe(64);
    expect(calls).toHaveLength(64);
    expect(r.done).toBe(1600);
  });
});
