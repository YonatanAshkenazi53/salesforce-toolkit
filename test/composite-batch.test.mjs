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
  'sftkBatchItemError', 'sftkBatchFailAll', 'sftkBatchNormalize',
  'sftkBatchUrlHost', 'sftkBatchRecordId'
]);
const {
  sftkBatchSubUrl, sftkBatchChunks, sftkBatchBody,
  sftkBatchItemError, sftkBatchFailAll, sftkBatchNormalize,
  sftkBatchUrlHost, sftkBatchRecordId
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
  'sftkBatchUrlHost', 'sftkBatchRecordId',
  'sfErrorMsg', 'sfCompositeBatch'
]);
const { sfCompositeBatch } = IO;

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
describe('sftkBatchUrlHost / sftkBatchRecordId — the identity evidence extractors', () => {
  it('extracts the lowercased host of an absolute http(s) url and nothing else', () => {
    expect(sftkBatchUrlHost('https://Acme.my.salesforce.com/services/data')).toBe('acme.my.salesforce.com');
    expect(sftkBatchUrlHost('http://a.example:8080/x')).toBe('a.example:8080');
    for (const notAbs of ['v62.0/query?q=x', '/services/data/v62.0/x', '', '   ', null, undefined, 'ftp://x/y']) {
      expect(sftkBatchUrlHost(notAbs)).toBe('');
    }
  });

  it('reads a record id only from the canonical /sobjects/<Type>/<id> shape', () => {
    expect(sftkBatchRecordId('v62.0/tooling/sobjects/Flow/301xx0000004GhTAAU')).toBe('301xx0000004GhTAAU');
    expect(sftkBatchRecordId('v62.0/sobjects/Account/001xx000003DGb2')).toBe('001xx000003DGb2');
    expect(sftkBatchRecordId('v62.0/sobjects/Account/001xx000003DGb2AAG?fields=Name')).toBe('001xx000003DGb2AAG');
    // NOT identity claims: describes, queries, short tails, 16-char lookalikes.
    expect(sftkBatchRecordId('v62.0/sobjects/Account/describe')).toBe('');
    expect(sftkBatchRecordId('v62.0/query?q=SELECT+Id')).toBe('');
    expect(sftkBatchRecordId('v62.0/tooling/sobjects/Flow/301x0')).toBe('');
    expect(sftkBatchRecordId('v62.0/sobjects/Account/001xx000003DGb2A')).toBe('');   // 16 chars
    expect(sftkBatchRecordId(null)).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('sftkBatchNormalize — identity evidence catches same-length misalignment', () => {
  const FLOW_A = '301xx0000004GhTAAU';           // case-safe prefix 301xx0000004GhT
  const FLOW_B = '301xx0000004AbCAAU';
  const req = id => ({ method: 'GET', url: `v62.0/tooling/sobjects/Flow/${id}` });
  const rec = (id, extra) => ({ statusCode: 200, result: { Id: id, ...(extra || {}) } });

  it('rejects a same-length REORDERED response — length alone is not alignment', () => {
    const out = sftkBatchNormalize([req(FLOW_A), req(FLOW_B)], {
      hasErrors: false,
      results: [rec(FLOW_B, { FullName: 'flow_b' }), rec(FLOW_A, { FullName: 'flow_a' })]
    }, 0);
    expect(out).toHaveLength(2);
    expect(out.every(r => r.ok === false && r.batchError === true)).toBe(true);
    // No slot is handed a payload that belongs to a different flow.
    expect(out.every(r => r.body === undefined)).toBe(true);
    expect(out[0].error).toContain('misaligned');
    expect(out[0].error).toContain(FLOW_B);      // names the id that proved it
  });

  it('rejects a DUPLICATED slot — one record answering two different subrequests', () => {
    const out = sftkBatchNormalize([req(FLOW_A), req(FLOW_B)], {
      hasErrors: false, results: [rec(FLOW_A), rec(FLOW_A)]
    }, 0);
    expect(out.every(r => r.ok === false && r.batchError === true)).toBe(true);
    expect(out.every(r => r.body === undefined)).toBe(true);
  });

  it('accepts the aligned case, and the 18- and 15-char forms of one id MATCH', () => {
    // The url names the 15-char form, the body answers with the 18-char form —
    // same record, case-safe prefix agrees, no false alarm.
    const out = sftkBatchNormalize([
      { method: 'GET', url: `v62.0/tooling/sobjects/Flow/${FLOW_A.slice(0, 15)}` },
      req(FLOW_B)
    ], { hasErrors: false, results: [rec(FLOW_A), rec(FLOW_B)] }, 0);
    expect(out.map(r => r.ok)).toEqual([true, true]);
    expect(out[0].body.Id).toBe(FLOW_A);
  });

  it('leaves a query-shaped subrequest without a top-level Id alone', () => {
    // Absence of evidence is not mismatch: a query result carries no top-level
    // Id to check and must not be failed for it.
    const out = sftkBatchNormalize([
      { method: 'GET', url: 'v62.0/query?q=SELECT+Id+FROM+Account' },
      req(FLOW_A)
    ], { hasErrors: false, results: [
      { statusCode: 200, result: { totalSize: 1, records: [{ Id: '001xx000003DGb2AAG' }] } },
      rec(FLOW_A)
    ] }, 0);
    expect(out.map(r => r.ok)).toEqual([true, true]);
  });

  it('exempts error slots and 204s — a failed or empty slot claims no identity', () => {
    const out = sftkBatchNormalize([req(FLOW_A), req(FLOW_B)], {
      hasErrors: true, results: [
        { statusCode: 404, result: [{ message: 'not found', errorCode: 'NOT_FOUND' }] },
        { statusCode: 204 }
      ]
    }, 0);
    expect(out[0].ok).toBe(false);
    expect(out[0].batchError).toBe(false);       // that ITEM failed, not the call
    expect(out[1].ok).toBe(true);
    expect(out[1].body).toBeUndefined();
  });

  it('end-to-end: a reordered wire response fails ITS chunk; other chunks are untouched', async () => {
    const FLOW_C = '301xx0000004XyZAAU';
    const FLOW_D = '301xx0000004QrSAAU';
    // Two chunks of 2. Chunk 1 comes back with its two records swapped; chunk 0 is honest.
    server(call => {
      const ids = call.batchRequests.map(r => r.url.split('/').pop());
      const order = call.n === 1 ? [...ids].reverse() : ids;
      return { ok: true, status: 200, body: okBody(order.map(id => rec(id))) };
    });
    const out = await sfCompositeBatch(ORG, SID,
      [FLOW_A, FLOW_B, FLOW_C, FLOW_D].map(id => req(id)), { chunkSize: 2 });
    expect(out.slice(0, 2).every(r => r.ok)).toBe(true);
    expect(out.slice(2).every(r => r.ok === false && r.batchError === true && r.body === undefined)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('sfCompositeBatch — a thrown runner aborts the run, siblings included', () => {
  it('SESSION_EXPIRED at concurrency 1 still propagates for the message-level retry', async () => {
    // The shipped callers all use concurrency 1: the abort flag must not
    // change this path at all — the throw reaches handleMessage, which
    // retries the whole message with a refreshed sid.
    server(call => {
      if (call.n === 1) throw new Error('SESSION_EXPIRED');
      return echoServer(call);
    });
    await expect(sfCompositeBatch(ORG, SID, subs(75), { concurrency: 1 }))
      .rejects.toThrow('SESSION_EXPIRED');
    expect(calls).toHaveLength(2);   // chunk 0 answered, chunk 1 threw, chunk 2 never dispatched
  });

  it('stops siblings pulling NEW chunks and silences onProgress after a throw', async () => {
    const seen = [];
    server(async (call) => {
      if (call.n === 0) {
        await new Promise(r => setTimeout(r, 5));
        throw new Error('SESSION_EXPIRED');
      }
      await new Promise(r => setTimeout(r, 30));
      return echoServer(call);
    });
    await expect(sfCompositeBatch(ORG, SID, subs(200), {
      concurrency: 2, onProgress: (d, t) => seen.push([d, t])
    })).rejects.toThrow('SESSION_EXPIRED');
    // At rejection: chunk 0 (threw) and chunk 1 (already in flight) were sent.
    expect(calls).toHaveLength(2);
    // The in-flight sibling settles late — it may finish (a fetch cannot be
    // recalled) but must dispatch nothing further and report nothing into a
    // run the caller has abandoned.
    await new Promise(r => setTimeout(r, 80));
    expect(calls).toHaveLength(2);               // chunks 2..7 never dispatched
    expect(seen).toEqual([]);                    // no progress after the abort
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('sfCompositeBatch — a cross-org url is refused, never silently re-pointed', () => {
  const FOREIGN = 'https://other.my.salesforce.com/services/data/v62.0/tooling/sobjects/Flow/301xx0000004GhTAAU';

  it('refuses a mid-chunk cross-org item; every neighbour still lands in its own slot', async () => {
    const list = subs(10);
    list.splice(4, 0, { method: 'GET', url: FOREIGN });   // 11 items, foreign at index 4
    const out = await sfCompositeBatch(ORG, SID, list);
    expect(out).toHaveLength(11);
    // The foreign item: failed per-item, both hosts named, never dispatched.
    expect(out[4].ok).toBe(false);
    expect(out[4].batchError).toBe(false);       // this ITEM was refused, not the call
    expect(out[4].error).toContain('other.my.salesforce.com');
    expect(out[4].error).toContain('acme.my.salesforce.com');
    expect(calls).toHaveLength(1);
    expect(calls[0].batchRequests).toHaveLength(10);      // 10 dispatched, not 11
    expect(calls[0].batchRequests.every(r => !r.url.includes('other.my'))).toBe(true);
    // Neighbours: each result echoes ITS OWN url, before and after the hole.
    list.forEach((s, i) => {
      if (i === 4) return;
      expect(out[i].index).toBe(i);
      expect(out[i].ok).toBe(true);
      expect(out[i].body.echo).toBe(`v62.0/${s.url}`);
    });
  });

  it('keeps alignment when refusals change the chunking arithmetic', async () => {
    // 27 caller items, 2 refused → 25 dispatchable → exactly ONE round-trip,
    // where the naive count (27) would have taken two.
    const list = subs(27);
    list[3]  = { method: 'GET', url: FOREIGN };
    list[19] = { method: 'GET', url: FOREIGN };
    const out = await sfCompositeBatch(ORG, SID, list);
    expect(calls).toHaveLength(1);
    expect(calls[0].batchRequests).toHaveLength(25);
    for (let i = 0; i < 27; i++) {
      expect(out[i].index).toBe(i);
      if (i === 3 || i === 19) {
        expect(out[i].ok).toBe(false);
        expect(out[i].batchError).toBe(false);
      } else {
        expect(out[i].body.echo).toBe(`v62.0/tooling/sobjects/Flow/301x${i}`);
      }
    }
  });

  it('still allows a SAME-host absolute url — that is mere normalisation', async () => {
    const out = await sfCompositeBatch(ORG, SID, [
      { method: 'GET', url: `${ORG}/services/data/v62.0/tooling/sobjects/Flow/301x0` }
    ]);
    expect(out[0].ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].batchRequests[0].url).toBe('v62.0/tooling/sobjects/Flow/301x0');
  });

  it('counts refused items as settled progress; an all-refused batch costs zero calls', async () => {
    const seen = [];
    const out = await sfCompositeBatch(ORG, SID,
      [{ url: FOREIGN }, { url: FOREIGN }],
      { onProgress: (d, t) => seen.push([d, t]) });
    expect(calls).toHaveLength(0);
    expect(out).toHaveLength(2);
    expect(out.every(r => r.ok === false && r.batchError === false)).toBe(true);
    expect(seen).toEqual([[2, 2]]);              // settled with a verdict, honestly
  });
});
