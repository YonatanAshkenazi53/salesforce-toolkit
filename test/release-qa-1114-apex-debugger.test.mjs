// Release QA 2026-11-14 — Apex Debugger: four confirmed defects.
//  1. Stop Trace on a flag that is already gone (deleted elsewhere, dead
//     session, org switch) said "STILL ACTIVE" forever and, past expiry,
//     retried a DELETE + a History entry every second.
//  2. Purge >24h of 700+ logs re-read every id in ONE Tooling GET; the URL
//     overflowed and every deleted log was reported failed.
//  3. Start Trace took over a pre-existing (someone else's) TraceFlag and its
//     Stop / undo DELETED it instead of putting it back.
//  4. Cross-log search kept every downloaded body for good.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { extractFunction } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');
const SRC = read('apex-debugger.js');

// A sandbox that runs the real apex-debugger.js + sftk-write.js, with the
// background answered by `handler(msg)` and every timer tracked.
function load(handler) {
  const sent = [];
  const history = [];
  const timers = new Set();
  const ctx = {
    console,
    Date, Math, JSON, Promise, Map, Set, Array, Object, String, Number, RegExp, Error,
    setInterval: (fn, ms) => { const t = { fn, ms }; timers.add(t); return t; },
    clearInterval: t => { timers.delete(t); },
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => {},
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      addEventListener: () => {}, createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }) },
    chrome: { runtime: { sendMessage: (msg, cb) => { sent.push(msg); Promise.resolve(handler(msg)).then(cb); }, lastError: null } },
    sftkHistoryBegin: (o) => ({ title: o.title, notes: [] }),
    sftkHistoryNote: (j, r) => { j.notes.push(r); },
    sftkHistoryEnd: async (j, o) => { history.push({ title: j.title, notes: j.notes, undo: o && o.undo }); },
    sftkFriendlyError: (m) => ({ message: String(m), hint: '', raw: String(m) }),
    sftkOrgKey: (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\..*$/, '').toLowerCase(),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('sftk-write.js'), ctx);
  vm.runInContext(SRC + '\n;globalThis.ApexDebugger = ApexDebugger;', ctx);
  const AD = ctx.ApexDebugger;
  AD._test.setSession('https://a.my.salesforce.com', 'sid');
  return { AD, T: AD._test, sent, history, timers };
}

const future = () => new Date(Date.now() + 30 * 60000).toISOString();
const past   = () => new Date(Date.now() - 60000).toISOString();

describe('1. Stop Trace when the flag is gone, the session is dead, or the org changed', () => {
  it('a flag deleted elsewhere (DELETE says NOT_FOUND, re-read shows no row) counts as stopped', async () => {
    const { T, history, timers } = load(msg => {
      if (msg.type === 'SF_TOOLING_DELETE') return { error: 'NOT_FOUND: The requested resource does not exist' };
      if (msg.type === 'SF_QUERY') return { records: [] };
      return { error: 'unexpected' };
    });
    T.setTrace({ Id: '7tf000000000001', ExpirationDate: future() }, { Name: 'U' });
    await T.stopTrace();
    expect(T.trace()).toBeNull();
    expect(timers.size).toBe(0);
    expect(history).toHaveLength(1);
    expect(history[0].notes[0].ok).toBe(true);
  });

  it('a dead session (DELETE and re-read both fail) is NOT reported as stopped before expiry', async () => {
    const { T, timers } = load(() => ({ error: 'INVALID_SESSION_ID' }));
    T.setTrace({ Id: '7tf000000000001', ExpirationDate: future() }, { Name: 'U' });
    await T.stopTrace();
    expect(T.trace()).not.toBeNull();      // kept so Stop can retry
    expect(timers.size).toBe(2);           // countdown + poll still show the truth
  });

  it('past expiry a failed stop does NOT restart the countdown — no retry every second', async () => {
    const { T, sent, history, timers } = load(() => ({ error: 'INVALID_SESSION_ID' }));
    T.setTrace({ Id: '7tf000000000001', ExpirationDate: past() }, { Name: 'U' });
    await T.stopTrace();
    expect(T.trace()).toBeNull();
    expect(timers.size).toBe(0);
    expect(history).toHaveLength(1);
    expect(sent.filter(m => m.type === 'SF_TOOLING_DELETE')).toHaveLength(1);
  });

  it('a flag the org still shows after a refused DELETE stays active (the re-read decides)', async () => {
    const { T } = load(msg => {
      if (msg.type === 'SF_TOOLING_DELETE') return { error: 'INSUFFICIENT_ACCESS' };
      if (msg.type === 'SF_QUERY') return { records: [{ Id: '7tf000000000001' }] };
      return { error: 'unexpected' };
    });
    T.setTrace({ Id: '7tf000000000001', ExpirationDate: future() }, { Name: 'U' });
    await T.stopTrace();
    expect(T.trace()).not.toBeNull();
  });

  it('an org switch resets the trace state; a fresh session for the same org does not', () => {
    const { AD, T, timers } = load(() => ({ records: [] }));
    T.setTrace({ Id: '7tf000000000001', ExpirationDate: future() }, { Name: 'U' });
    AD.updateSession('https://a.lightning.force.com', 'sid2');   // same org, other domain form
    expect(T.trace()).not.toBeNull();
    AD.updateSession('https://b.my.salesforce.com', 'sid3');     // another org
    expect(T.trace()).toBeNull();
    expect(timers.size).toBe(0);
  });
});

describe('2. Batch delete re-reads in chunks', () => {
  it('sftkDbgChunks cuts a list into runs', () => {
    const chunks = extractFunction('apex-debugger.js', 'sftkDbgChunks');
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunks([], 200)).toEqual([]);
    expect(chunks(null, 200)).toEqual([]);
    expect(chunks([1, 2], 0)).toEqual([[1], [2]]);
  });

  it('750 deleted logs are re-read in queries of at most 200 ids and all verified', async () => {
    const ids = Array.from({ length: 750 }, (_, i) => '07L' + String(i).padStart(15, '0'));
    const { T, sent } = load(msg => {
      if (msg.type === 'SF_TOOLING_DELETE') return { success: true };
      if (msg.type === 'SF_QUERY_ALL') {
        const n = (msg.query.match(/'/g) || []).length / 2;
        if (n > 200) return { error: 'HTTP 414' };
        return { records: [] };
      }
      return { error: 'unexpected' };
    });
    const res = await T.deleteLogs(ids);
    expect(res.every(r => r.ok)).toBe(true);
    expect(sent.filter(m => m.type === 'SF_QUERY_ALL')).toHaveLength(4);
  });

  it('a chunk whose re-read fails leaves only its own ids unverified', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => '07L' + String(i).padStart(15, '0'));
    let q = 0;
    const { T } = load(msg => {
      if (msg.type === 'SF_TOOLING_DELETE') return { success: true };
      if (msg.type === 'SF_QUERY_ALL') return (q++ === 0) ? { error: 'boom' } : { records: [] };
      return { error: 'unexpected' };
    });
    const res = await T.deleteLogs(ids);
    expect(res.slice(0, 200).every(r => r.accepted && !r.ok && !r.verified)).toBe(true);
    expect(res.slice(200).every(r => r.ok)).toBe(true);
  });
});

describe('3. A pre-existing trace flag is put back, not deleted', () => {
  it('sftkDbgIsToolkitLevel knows only SFTK_ levels', () => {
    const own = extractFunction('apex-debugger.js', 'sftkDbgIsToolkitLevel');
    expect(own('SFTK_FlowsApex')).toBe(true);
    expect(own('SFTK_C_123')).toBe(true);
    expect(own('Integration_Finest')).toBe(false);
    expect(own(undefined)).toBe(false);   // unreadable → foreign → restore
  });

  it('sftkDbgSoqlDateTime turns the org spelling into a SOQL literal', () => {
    const lit = extractFunction('apex-debugger.js', 'sftkDbgSoqlDateTime');
    expect(lit('2026-11-14T10:00:00.000+0000')).toBe('2026-11-14T10:00:00Z');
    expect(lit('2026-11-14T12:00:00.000+0200')).toBe('2026-11-14T10:00:00Z');
    expect(lit('')).toBe('');
  });

  it('Stop PATCHes a taken-over flag back to its own level and expiry, never DELETEs it', async () => {
    const prior = { DebugLevelId: '7dl000000000009', StartDate: null, ExpirationDate: '2026-12-01T10:00:00.000+0000' };
    const { T, sent } = load(msg => {
      if (msg.type === 'SF_PATCH') return { success: true };
      if (msg.type === 'SF_QUERY') return { records: [{ Id: '7tf000000000001', DebugLevelId: prior.DebugLevelId, ExpirationDate: prior.ExpirationDate }] };
      return { error: 'unexpected' };
    });
    T.setTrace({ Id: '7tf000000000001', ExpirationDate: future(), prior }, { Name: 'U' });
    await T.stopTrace();
    expect(sent.some(m => m.type === 'SF_TOOLING_DELETE')).toBe(false);
    const patch = sent.find(m => m.type === 'SF_PATCH');
    expect(patch.body).toEqual({ DebugLevelId: prior.DebugLevelId, StartDate: null, ExpirationDate: prior.ExpirationDate });
    expect(T.trace()).toBeNull();
  });

  it('Start Trace keeps the old values and its undo is a PATCH back for a foreign flag', () => {
    expect(SRC).toContain('SELECT Id,DebugLevelId,StartDate,ExpirationDate FROM TraceFlag ');
    expect(SRC).toContain('if (!sftkDbgIsToolkitLevel(dn)) {');
    expect(SRC).toMatch(/_traceFlag = \{ Id: existing\.records\[0\]\.Id, ExpirationDate: exp\.toISOString\(\), prior \};/);
    const fin = SRC.slice(SRC.indexOf('const tfPrior = confirmedThisCall'), SRC.indexOf('async function _stopTrace'));
    expect(fin).toMatch(/msg: \{ type: 'SF_PATCH', path: `\$\{TAPI\}\/sobjects\/TraceFlag\//);
    // the DELETE undo is only the fallback for the Toolkit's own flag
    expect(fin.indexOf("'SF_PATCH'")).toBeLessThan(fin.indexOf("'SF_TOOLING_DELETE'"));
  });
});

describe('4. Cross-log search keeps bodies inside a budget', () => {
  it('sftkDbgCacheAdmit refuses a big body and a full budget', () => {
    const admit = extractFunction('apex-debugger.js', 'sftkDbgCacheAdmit');
    const MB = 1048576;
    expect(admit(0, 1 * MB, 2 * MB, 32 * MB)).toBe(true);
    expect(admit(0, 3 * MB, 2 * MB, 32 * MB)).toBe(false);
    expect(admit(31 * MB, 2 * MB, 2 * MB, 32 * MB)).toBe(false);
    expect(admit(0, NaN, 2 * MB, 32 * MB)).toBe(false);
  });

  it('the search worker stores a body only through the budget check', () => {
    expect(SRC).toContain('sftkDbgCacheAdmit(_xRawChars, raw.length, XRAW_PER_LOG_MAX, XRAW_BUDGET)');
    expect((SRC.match(/_xRawCache\[log\.Id\] = raw;/g) || [])).toHaveLength(1);
    // the in-progress filter knows a scanned-but-dropped body was scanned
    expect(SRC).toContain('!_xScanned.has(l.Id)');
  });
});

