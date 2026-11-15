// 2026-11-15 — regressions and half-applied fixes an independent review found
// in commit f0334a0 (Apex Debugger, ⚙ API versions, Org Health). Every test
// here RUNS the real function against a fake org; none reads source text.
//  1. A foreign TraceFlag taken over by Start Trace was protected only inside
//     one popup lifetime: after a reopen the next Start took the flag for the
//     Toolkit's own and Stop / undo deleted it.
//  2. ⚙ API versions: the "second line" guard compared against the SCAN's
//     latest version, so a Draft saved after the scan was still overwritten,
//     activated and queued for Undo-delete.
//  3. The failed-Stop sentence was inverted ("could not be re-read" after a
//     re-read that answered; "STILL ACTIVE" after one that did not).
//  4. The cross-log body budget was never given back by deleted / replaced logs.
//  5. Org Health: the org's own unused page X was "assigned" when an app
//     named a packaged page pkg__X.
//  6. Behaviours that were only pinned as source text are run for real.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { extractFunction, extractFunctions } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');

// ── Apex Debugger harness ───────────────────────────────────────────────
// The real apex-debugger.js + sftk-write.js in a vm. `handler(msg)` is the
// org; `store` is chrome.storage.local (hand the SAME object to two loads to
// model a popup that was closed and opened again). The few elements the
// trace / search / delete paths write to exist; every other lookup is null.
const ADBG_SRC = read('apex-debugger.js');
const EL_IDS = ['adbgStartBtn', 'adbgStopBtn', 'adbgStatusCell', 'adbgLogCount', 'adbgXSearchBtn', 'adbgDelSelBtn', 'adbgDelAllBtn'];
function loadDebugger(handler, opts = {}) {
  const sent = [];
  const history = [];
  const timers = new Set();
  const els = {};
  const el = id => (els[id] = els[id] || { id, style: {}, dataset: {}, innerHTML: '', textContent: '', title: '', disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false } });
  const storage = opts.store === null ? undefined : {
    local: {
      get: async k => ({ [k]: opts.store[k] === undefined ? undefined : JSON.parse(JSON.stringify(opts.store[k])) }),
      set: async o => { for (const k of Object.keys(o)) opts.store[k] = JSON.parse(JSON.stringify(o[k])); },
    },
  };
  const ctx = {
    console, Date, Math, JSON, Promise, Map, Set, Array, Object, String, Number, RegExp, Error,
    setInterval: (fn, ms) => { const t = { fn, ms }; timers.add(t); return t; },
    clearInterval: t => { timers.delete(t); },
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => {},
    document: { getElementById: id => (EL_IDS.includes(id) ? el(id) : null), querySelector: () => null, querySelectorAll: () => [],
      addEventListener: () => {}, createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }) },
    chrome: { runtime: { sendMessage: (msg, cb) => { sent.push(msg); Promise.resolve(handler(msg)).then(cb); }, lastError: null }, storage },
    sftkHistoryBegin: (o) => ({ title: o.title, notes: [] }),
    sftkHistoryNote: (j, r) => { j.notes.push(r); },
    sftkHistoryEnd: async (j, o) => { history.push({ title: j.title, notes: j.notes, undo: o && o.undo }); },
    sftkFriendlyError: (m) => ({ message: String(m), hint: '', raw: String(m) }),
    sftkOrgKey: (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\..*$/, '').toLowerCase(),
    sftkCatSm: t => String(t),
    sftkOrgWriteGate: async () => ({ production: false }),
    sftkConfirmDestructive: async () => true,
    alert: () => {},
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('sftk-write.js'), ctx);
  vm.runInContext(ADBG_SRC + '\n;globalThis.ApexDebugger = ApexDebugger;', ctx);
  const AD = ctx.ApexDebugger;
  AD._test.setSession(opts.orgUrl || 'https://a.my.salesforce.com', 'sid');
  return { AD, T: AD._test, sent, history, timers, el };
}

// A stateful org with one user, DebugLevels by name and TraceFlags by Id.
function fakeTraceOrg({ flags, levels }) {
  const org = { flags: { ...flags }, levels: { ...levels }, n: 0 };
  org.handler = msg => {
    const q = msg.query || '';
    if (msg.type === 'SF_QUERY' && /FROM DebugLevel WHERE DeveloperName='([^']+)'/.test(q)) {
      const dn = RegExp.$1;
      const id = Object.keys(org.levels).find(k => org.levels[k] === dn);
      return { records: id ? [{ Id: id }] : [] };
    }
    if (msg.type === 'SF_QUERY' && /SELECT DeveloperName FROM DebugLevel WHERE Id = '([^']+)'/.test(q)) {
      const id = RegExp.$1;
      return { records: org.levels[id] ? [{ DeveloperName: org.levels[id] }] : [] };
    }
    if (msg.type === 'SF_QUERY' && /FROM TraceFlag WHERE TracedEntityId=/.test(q)) {
      const id = Object.keys(org.flags)[0];
      return { records: id ? [{ Id: id, ...org.flags[id] }] : [] };
    }
    if (msg.type === 'SF_QUERY' && /FROM TraceFlag WHERE Id = '([^']+)'/.test(q)) {
      const id = RegExp.$1;
      return { records: org.flags[id] ? [{ Id: id, ...org.flags[id] }] : [] };
    }
    if (msg.type === 'SF_REST_POST' && /sobjects\/DebugLevel$/.test(msg.path)) {
      const id = `7dlNEW${++org.n}`;
      org.levels[id] = msg.body.DeveloperName;
      return { id, success: true };
    }
    if (msg.type === 'SF_REST_POST' && /sobjects\/TraceFlag$/.test(msg.path)) {
      const id = `7tfNEW${++org.n}`;
      org.flags[id] = { DebugLevelId: msg.body.DebugLevelId, StartDate: msg.body.StartDate, ExpirationDate: msg.body.ExpirationDate };
      return { id, success: true };
    }
    if (msg.type === 'SF_PATCH' && /sobjects\/TraceFlag\/(\w+)$/.test(msg.path)) {
      const id = RegExp.$1;
      if (!org.flags[id]) return { error: 'NOT_FOUND' };
      Object.assign(org.flags[id], msg.body);
      return { success: true };
    }
    if (msg.type === 'SF_TOOLING_DELETE' && msg.sobject === 'TraceFlag') {
      if (!org.flags[msg.id]) return { error: 'NOT_FOUND' };
      delete org.flags[msg.id];
      return { success: true };
    }
    return { error: `unexpected ${msg.type} ${q || msg.path || ''}` };
  };
  return org;
}

const USER = { Id: '005000000000001', Name: 'Integration User', Username: 'int@example.com' };
const FOREIGN = { DebugLevelId: '7dlFOREIGN', StartDate: '2026-11-15T08:00:00.000+0000', ExpirationDate: '2099-01-01T00:00:00.000+0000' };
const foreignOrg = () => fakeTraceOrg({ flags: { '7tfX': { ...FOREIGN } }, levels: { '7dlFOREIGN': 'Integration_Finest' } });

describe('1. a taken-over trace flag is still put back after the popup was reopened', () => {
  it('pure: the record key is per org + flag, and only a complete, unexpired record counts', () => {
    const key = extractFunction('apex-debugger.js', 'sftkDbgPriorKey');
    const live = extractFunction('apex-debugger.js', 'sftkDbgPriorLive');
    expect(key('a', '7tfX')).toBe('a|7tfX');
    expect(key('a', '7tfX')).not.toBe(key('b', '7tfX'));
    const now = Date.parse('2026-11-15T12:00:00Z');
    expect(live({ DebugLevelId: '7dl1', ExpirationDate: '2026-11-15T13:00:00.000+0000' }, now)).toBe(true);
    expect(live({ DebugLevelId: '7dl1', ExpirationDate: '2026-11-15T11:00:00.000+0000' }, now)).toBe(false);
    expect(live({ ExpirationDate: '2099-01-01T00:00:00.000+0000' }, now)).toBe(false);
    expect(live({ DebugLevelId: '7dl1', ExpirationDate: 'soon' }, now)).toBe(false);
    expect(live(null, now)).toBe(false);
  });

  it('Start on a foreign flag keeps its values, and the History undo is a PATCH back', async () => {
    const org = foreignOrg();
    const store = {};
    const { T, history } = loadDebugger(org.handler, { store });
    T.setUser(USER);
    await T.startTrace();
    expect(T.trace().Id).toBe('7tfX');
    expect(T.trace().prior).toEqual(FOREIGN);
    expect(org.flags['7tfX'].DebugLevelId).not.toBe('7dlFOREIGN');      // the flag is on the Toolkit's level now
    const step = history[0].undo.steps[0];
    expect(step.msg.type).toBe('SF_PATCH');
    expect(step.msg.body).toEqual(FOREIGN);
    expect(Object.values(store.adbg_tf_prior)).toEqual([FOREIGN]);       // survives the popup
  });

  it('the reported case: reopen, Start again, Stop — the flag is PATCHed back, never deleted', async () => {
    const org = foreignOrg();
    const store = {};
    const first = loadDebugger(org.handler, { store });
    first.T.setUser(USER);
    await first.T.startTrace();

    // The popup closed: a fresh module instance, the same chrome.storage.
    const second = loadDebugger(org.handler, { store });
    second.T.setUser(USER);
    await second.T.startTrace();
    expect(second.T.trace().prior).toEqual(FOREIGN);
    expect(second.history[0].undo.steps[0].msg.type).toBe('SF_PATCH');
    expect(second.history[0].undo.steps[0].msg.body).toEqual(FOREIGN);

    await second.T.stopTrace();
    expect(second.sent.some(m => m.type === 'SF_TOOLING_DELETE')).toBe(false);
    expect(org.flags['7tfX']).toEqual(FOREIGN);                           // the colleague's flag, as it was
    expect(second.T.trace()).toBeNull();
    expect(store.adbg_tf_prior).toEqual({});                              // the record has done its job
  });

  it('reopen and Start on another Toolkit profile level (an SFTK_ name) reads the record too', async () => {
    const org = foreignOrg();
    const store = {};
    const first = loadDebugger(org.handler, { store });
    first.T.setUser(USER);
    await first.T.startTrace();
    // the flag now sits on some OTHER Toolkit level than the one the next Start will use
    org.levels['7dlOTHER'] = 'SFTK_C_123';
    org.flags['7tfX'].DebugLevelId = '7dlOTHER';
    const second = loadDebugger(org.handler, { store });
    second.T.setUser(USER);
    await second.T.startTrace();
    expect(second.T.trace().prior).toEqual(FOREIGN);
  });

  it("the Toolkit's own flag (no record) is still deleted by Stop", async () => {
    const org = fakeTraceOrg({ flags: {}, levels: {} });
    const store = {};
    const first = loadDebugger(org.handler, { store });
    first.T.setUser(USER);
    await first.T.startTrace();                       // creates the level and the flag
    expect(first.history[0].undo.steps[0].msg.type).toBe('SF_TOOLING_DELETE');
    const second = loadDebugger(org.handler, { store });
    second.T.setUser(USER);
    await second.T.startTrace();                      // extends its own flag
    expect(second.T.trace().prior).toBeNull();
    expect(second.history[0].undo.steps[0].msg.type).toBe('SF_TOOLING_DELETE');
    await second.T.stopTrace();
    expect(Object.keys(org.flags)).toEqual([]);
  });

  it('a record whose own expiry has passed is not put back (the original flag captured nothing any more)', async () => {
    const org = fakeTraceOrg({ flags: { '7tfX': { DebugLevelId: '7dlOWN', StartDate: null, ExpirationDate: '2099-01-01T00:00:00.000+0000' } },
      levels: { '7dlOWN': 'SFTK_FlowsApex' } });
    const store = { adbg_tf_prior: { 'a|7tfX': { DebugLevelId: '7dlFOREIGN', StartDate: null, ExpirationDate: '2020-01-01T00:00:00.000+0000' } } };
    const { T } = loadDebugger(org.handler, { store });
    T.setUser(USER);
    await T.startTrace();
    expect(T.trace().prior).toBeNull();
  });

  it("another org's record for the same flag Id is not used", async () => {
    const org = fakeTraceOrg({ flags: { '7tfX': { DebugLevelId: '7dlOWN', StartDate: null, ExpirationDate: '2099-01-01T00:00:00.000+0000' } },
      levels: { '7dlOWN': 'SFTK_FlowsApex' } });
    const store = { adbg_tf_prior: { 'b|7tfX': { ...FOREIGN } } };
    const { T } = loadDebugger(org.handler, { store });   // this popup looks at org "a"
    T.setUser(USER);
    await T.startTrace();
    expect(T.trace().prior).toBeNull();
    expect(store.adbg_tf_prior['b|7tfX']).toEqual(FOREIGN);   // and it is left alone
  });

  it('with no chrome.storage at all Start and Stop still restore inside one popup lifetime', async () => {
    const org = foreignOrg();
    const { T, sent } = loadDebugger(org.handler, { store: null });
    T.setUser(USER);
    await T.startTrace();
    expect(T.trace().prior).toEqual(FOREIGN);
    await T.stopTrace();
    expect(sent.some(m => m.type === 'SF_TOOLING_DELETE')).toBe(false);
    expect(org.flags['7tfX']).toEqual(FOREIGN);
  });
});

describe('3. the failed-Stop sentence says what the re-read really showed', () => {
  const future = () => new Date(Date.now() + 30 * 60000).toISOString();
  const stop = async handler => {
    const h = loadDebugger(handler, { store: {} });
    h.T.setTrace({ Id: '7tf000000000001', ExpirationDate: future() }, { Name: 'U' });
    await h.T.stopTrace();
    return h;
  };

  it('DELETE refused, the re-read shows the flag → STILL ACTIVE (not "could not be re-read")', async () => {
    const { T, el } = await stop(msg => {
      if (msg.type === 'SF_TOOLING_DELETE') return { error: 'INSUFFICIENT_ACCESS' };
      if (msg.type === 'SF_QUERY') return { records: [{ Id: '7tf000000000001' }] };
      return { error: 'unexpected' };
    });
    const text = el('adbgStatusCell').innerHTML;
    expect(text).toContain('INSUFFICIENT_ACCESS');
    expect(text).toContain('the flag is STILL ACTIVE in the org');
    expect(text).not.toContain('could not be re-read');
    expect(T.trace()).not.toBeNull();
  });

  it('DELETE accepted, the re-read fails → "could not be re-read" (not STILL ACTIVE)', async () => {
    const { T, el, history } = await stop(msg => {
      if (msg.type === 'SF_TOOLING_DELETE') return { success: true };
      if (msg.type === 'SF_QUERY') return { error: 'HTTP 503' };
      return { error: 'unexpected' };
    });
    const text = el('adbgStatusCell').innerHTML;
    expect(text).toContain('the org could not be re-read, so the flag may still be active');
    expect(text).not.toContain('STILL ACTIVE');
    expect(text).toContain('HTTP 503');
    expect(history[0].notes[0].verified).toBe(false);      // History does not say "the org still shows the old state"
    expect(T.trace()).not.toBeNull();                        // kept, so Stop can retry
  });

  it('DELETE refused and the re-read fails too → "could not be re-read"', async () => {
    const { el } = await stop(() => ({ error: 'INVALID_SESSION_ID' }));
    const text = el('adbgStatusCell').innerHTML;
    expect(text).toContain('the org could not be re-read, so the flag may still be active');
    expect(text).not.toContain('STILL ACTIVE');
  });

  it('DELETE accepted, the re-read answers and still shows the flag → STILL ACTIVE', async () => {
    const { el } = await stop(msg => {
      if (msg.type === 'SF_TOOLING_DELETE') return { success: true };
      if (msg.type === 'SF_QUERY') return { records: [{ Id: '7tf000000000001' }] };
      return { error: 'unexpected' };
    });
    expect(el('adbgStatusCell').innerHTML).toContain('the flag is STILL ACTIVE in the org');
  });
});

describe('4. the cross-log body budget is given back', () => {
  const LOGS = () => ['07L1', '07L2', '07L3', '07L4'].map(Id => ({ Id, Operation: Id, StartTime: '2026-11-15T10:00:00.000+0000' }));
  const bodyOrg = bodies => msg => {
    if (msg.type === 'SF_REST_GET_TEXT') {
      const id = /ApexLog\/(\w+)\/Body/.exec(msg.path)[1];
      return bodies[id] == null ? { error: 'HTTP 500' } : { text: bodies[id] };
    }
    if (msg.type === 'SF_TOOLING_DELETE') return { success: true };
    if (msg.type === 'SF_QUERY_ALL') return { records: [] };
    return { error: 'unexpected' };
  };
  const BODIES = { '07L1': 'aaaa needle\nline', '07L2': 'bbbbbbbb', '07L3': 'cc needle', '07L4': 'dddddd' };
  const total = ids => ids.reduce((s, id) => s + BODIES[id].length, 0);

  it('a search caches the bodies and counts their characters', async () => {
    const { T } = loadDebugger(bodyOrg(BODIES), { store: {} });
    T.setLogs(LOGS());
    await T.search('needle');
    expect([...T.xHits().keys()].sort()).toEqual(['07L1', '07L3']);
    expect(T.xCache().ids.sort()).toEqual(['07L1', '07L2', '07L3', '07L4']);
    expect(T.xCache().chars).toBe(total(['07L1', '07L2', '07L3', '07L4']));
  });

  it('Delete (one log) releases its body and its share of the budget', async () => {
    const { T } = loadDebugger(bodyOrg(BODIES), { store: {} });
    T.setLogs(LOGS());
    await T.search('needle');
    await T.deleteLog('07L2');
    expect(T.logs().map(l => l.Id)).toEqual(['07L1', '07L3', '07L4']);
    expect(T.xCache().ids.sort()).toEqual(['07L1', '07L3', '07L4']);
    expect(T.xCache().chars).toBe(total(['07L1', '07L3', '07L4']));
  });

  it('Delete Selected releases the selected bodies', async () => {
    const { T } = loadDebugger(bodyOrg(BODIES), { store: {} });
    T.setLogs(LOGS());
    await T.search('needle');
    T.check(['07L1', '07L4']);
    await T.deleteSelected();
    expect(T.xCache().ids.sort()).toEqual(['07L2', '07L3']);
    expect(T.xCache().chars).toBe(total(['07L2', '07L3']));
  });

  it('Delete All releases everything', async () => {
    const { T } = loadDebugger(bodyOrg(BODIES), { store: {} });
    T.setLogs(LOGS());
    await T.search('needle');
    await T.deleteAll();
    expect(T.logs()).toEqual([]);
    expect(T.xCache()).toMatchObject({ ids: [], chars: 0 });
  });

  it('a log whose delete was refused keeps its body (it is still listed)', async () => {
    const org = bodyOrg(BODIES);
    const { T } = loadDebugger(msg => (msg.type === 'SF_TOOLING_DELETE' ? { error: 'INSUFFICIENT_ACCESS' } : org(msg)), { store: {} });
    T.setLogs(LOGS());
    await T.search('needle');
    T.check(['07L1']);
    await T.deleteSelected();
    expect(T.xCache().ids).toContain('07L1');
    expect(T.xCache().chars).toBe(total(['07L1', '07L2', '07L3', '07L4']));
  });

  it('a replaced list drops the bodies of logs that are no longer listed', async () => {
    const { T } = loadDebugger(bodyOrg({ ...BODIES, '07L9': 'zz needle' }), { store: {} });
    T.setLogs(LOGS());
    await T.search('needle');
    T.setLogs([{ Id: '07L3' }, { Id: '07L9' }]);     // the list was reloaded: three logs rotated out, one is new
    await T.search('needle');
    expect(T.xCache().ids.sort()).toEqual(['07L3', '07L9']);
    expect(T.xCache().chars).toBe(BODIES['07L3'].length + 'zz needle'.length);
  });

  it('a body over the per-log limit is still scanned and reported, just not kept', async () => {
    const probe = loadDebugger(() => ({ error: 'unused' }), { store: {} });
    const big = 'x'.repeat(probe.T.xCache().perLogMax) + '\nthe NEEDLE is here\n';   // one line over the limit
    const { T, el, sent } = loadDebugger(bodyOrg({ '07L1': big, '07L2': 'small needle' }), { store: {} });
    T.setLogs([{ Id: '07L1' }, { Id: '07L2' }]);
    await T.search('needle');
    expect(T.xHits().get('07L1')).toEqual([{ ln: 2, text: 'the NEEDLE is here' }]);
    expect(T.xCache().ids).toEqual(['07L2']);                    // the big one was dropped after the scan
    expect(T.xCache().chars).toBe('small needle'.length);
    expect(el('adbgLogCount').textContent).toBe('2 of 2 logs match "needle"');   // no "unreachable", nothing unscanned
    // the next search downloads the big body again (slower, never wrong) and finds it again
    await T.search('needle is');
    expect(T.xHits().has('07L1')).toBe(true);
    expect(sent.filter(m => m.type === 'SF_REST_GET_TEXT' && /07L1/.test(m.path))).toHaveLength(2);
    expect(sent.filter(m => m.type === 'SF_REST_GET_TEXT' && /07L2/.test(m.path))).toHaveLength(1);
  });

  it('a body that could not be fetched is counted as unreachable, never as "no match"', async () => {
    const { T, el } = loadDebugger(bodyOrg({ '07L1': 'needle' }), { store: {} });
    T.setLogs([{ Id: '07L1' }, { Id: '07L2' }]);
    await T.search('needle');
    expect(el('adbgLogCount').textContent).toBe('1 of 2 logs match "needle" — searched 1 of 2 logs (1 unreachable)');
    expect(T.xCache().ids).toEqual(['07L1']);
  });
});

// ── ⚙ API versions: the whole Apply, from the scan cell to the undo ─────
const AV = extractFunctions('sftk-apiver.js', [
  'sftkApiVerNum', 'sftkApiVerLag', 'sftkFlowVerRows', 'sftkFlowGoverningVer',
  'sftkFlowVerMatrix', 'sftkApiVerPlan', 'sftkFlowIsLocked', 'sftkApiVerSelectable', 'sftkApiVerApplyCheck',
]);
const DEP = read('dependency-map.js');

// A stateful org holding ONE flow definition. deploy() does what Salesforce
// does: it overwrites the latest version when that one is not active, else it
// adds a new (not active) version.
function fakeFlowOrg(versions) {
  const DEF = '300x00000000001AAA';
  const org = { versions: versions.map(v => ({ ...v })), sent: [], failVersionRead: false };
  const rows = () => org.versions.map(v => ({ Id: v.Id, VersionNumber: v.n, Status: v.Status, ApiVersion: v.api,
    DefinitionId: DEF, Definition: { DeveloperName: 'Route' }, MasterLabel: 'Route' }));
  org.rows = rows;
  org.depFlowVersions = async () => ({ records: rows() });
  org.depBg = async msg => {
    org.sent.push(msg);
    if (msg.type === 'SF_COMPOSITE_BATCH') {
      return msg.subrequests.map(s => {
        const v = org.versions.find(x => s.url.endsWith(`/${x.Id}`));
        return v ? { ok: true, status: 200, body: { Id: v.Id, FullName: 'Route', Status: v.Status, VersionNumber: v.n,
          DefinitionId: DEF, Metadata: { apiVersion: Number(v.api), label: 'Route', content: v.content || `v${v.n}` } } } : { ok: false, status: 404 };
      });
    }
    if (msg.type === 'SF_QUERY_ALL' && /FROM Flow WHERE DefinitionId IN/.test(msg.query)) {
      if (org.failVersionRead) return { error: 'HTTP 503' };
      return { records: msg.query.includes(`'${DEF}'`) ? rows() : [] };
    }
    if (msg.type === 'SF_METADATA_DEPLOY') {
      const latest = org.versions.reduce((a, b) => (b.n > a.n ? b : a));
      if (latest.Status !== 'Active') { latest.api = '62.0'; latest.content = 'OVERWRITTEN'; }
      else org.versions.push({ Id: `301v${latest.n + 1}`, n: latest.n + 1, Status: 'Draft', api: '62.0' });
      return { success: true };
    }
    if (msg.type === 'SF_PATCH' && /FlowDefinition/.test(msg.path)) {
      const n = msg.body.Metadata.activeVersionNumber;
      org.versions.forEach(v => { v.Status = v.n === n ? 'Active' : (v.Status === 'Active' ? 'Obsolete' : v.Status); });
      return { success: true };
    }
    return { error: `unexpected ${msg.type}` };
  };
  return org;
}

// The real applyApiVerChange + avVerifyAndActivate (sliced out of the IIFE)
// over the real sftk-apiver / sftk-flow-xml / sftk-write code.
function buildApply(org) {
  const start = DEP.indexOf('async function avVerifyAndActivate(');
  const body = DEP.slice(start, DEP.indexOf('function buildReportObject(', start));
  const history = [];
  const log = { innerHTML: '', scrollTop: 0, scrollHeight: 0 };
  const box = { innerHTML: '', querySelector: () => log };
  const prog = { textContent: '' };
  const ctx = {
    console, Date, Math, JSON, Promise, Map, Set, Array, Object, String, Number, RegExp, Error, TextEncoder,
    depBg: org.depBg, depFlowVersions: org.depFlowVersions,
    avOrgMax: async () => ({ version: '62.0' }),
    sftkBuildStoredZip: files => files.map(f => f.name).join(','),
    sftkHistoryBegin: o => ({ title: o.title, notes: [] }),
    sftkHistoryNote: (j, r) => { j.notes.push(r); },
    sftkHistoryEnd: async (j, o) => { history.push({ title: j.title, undo: o && o.undo }); },
    escHtml: s => String(s),
    _avState: { orgs: [{ key: 'a', label: 'A', orgUrl: 'https://a.my.salesforce.com', sid: 'sid', maxVersion: '62.0' }] },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ['sftk-apiver.js', 'sftk-flow-xml.js', 'sftk-write.js']) vm.runInContext(read(f), ctx);
  vm.runInContext(`${body}\n;globalThis.applyApiVerChange = applyApiVerChange;`, ctx);
  const out = { querySelector: sel => (sel === '#depAvApplyOut' ? box : prog) };
  return { run: (plans, target) => ctx.applyApiVerChange(out, plans, target), history, log };
}

// scan → matrix cell → plan, exactly as the tool builds it
const ORGS = [{ key: 'a', label: 'A', maxVersion: '62.0' }];
const scanPlan = org => {
  const m = AV.sftkFlowVerMatrix(ORGS, { a: AV.sftkFlowVerRows(org.rows()) });
  return [{ apiName: 'Route', plan: AV.sftkApiVerPlan('62.0', ORGS, m[0].cells) }];
};

describe('2. ⚙ API versions — a Draft saved between the scan and the Apply is never overwritten', () => {
  it('pure: the version being re-saved must still be the latest; unreadable counts as changed', () => {
    const rec = { DefinitionId: '300x00000000001AAA', VersionNumber: 3, Status: 'Active' };
    const row = (n, Status, d) => ({ DefinitionId: d || '300x00000000001AAA', VersionNumber: n, Status });
    expect(AV.sftkApiVerApplyCheck('Route', rec, [row(2, 'Obsolete'), row(3, 'Active')])).toEqual({ ok: true, prevLatest: 3, why: '' });
    const draft = AV.sftkApiVerApplyCheck('Route', rec, [row(3, 'Active'), row(4, 'Draft')]);
    expect(draft.ok).toBe(false);
    expect(draft.prevLatest).toBe(4);
    expect(draft.why).toBe('Route changed since the scan: its latest version is now v4 (Draft), not the v3 this plan would re-save — the deploy would overwrite v4');
    const act = AV.sftkApiVerApplyCheck('Route', { ...rec, Status: 'Obsolete' }, [row(3, 'Obsolete'), row(4, 'Active')]);
    expect(act.ok).toBe(false);
    expect(act.why).not.toContain('overwrite');                    // an active version is not overwritten — say only what is true
    expect(AV.sftkApiVerApplyCheck('Route', rec, []).ok).toBe(false);
    expect(AV.sftkApiVerApplyCheck('Route', rec, [row(9, 'Draft', '300y00000000002AAA')]).ok).toBe(false);   // another flow's rows
    expect(AV.sftkApiVerApplyCheck('Route', { VersionNumber: 3 }, [row(3, 'Active')]).ok).toBe(false);       // no definition id
    // a 15-character id names the same definition as its 18-character form
    expect(AV.sftkApiVerApplyCheck('Route', { ...rec, DefinitionId: '300x00000000001' }, [row(3, 'Active')]).ok).toBe(true);
  });

  it('the reported case: scan (v3 Active only) → a Draft v4 is saved → Apply refuses, deploys and activates nothing', async () => {
    const org = fakeFlowOrg([{ Id: '301v3', n: 3, Status: 'Active', api: '58.0' }]);
    const plans = scanPlan(org);
    expect(plans[0].plan.applicable).toHaveLength(1);              // at scan time the flow was fine
    org.versions.push({ Id: '301v4', n: 4, Status: 'Draft', api: '58.0', content: 'THE USER DRAFT' });

    const { run, history, log } = buildApply(org);
    await run(plans, '62.0');
    expect(org.sent.some(m => m.type === 'SF_METADATA_DEPLOY')).toBe(false);
    expect(org.sent.some(m => m.type === 'SF_PATCH')).toBe(false);
    expect(org.versions.find(v => v.n === 4)).toMatchObject({ Status: 'Draft', api: '58.0', content: 'THE USER DRAFT' });
    expect(org.versions.find(v => v.n === 3).Status).toBe('Active');
    expect(log.innerHTML).toContain('Route changed since the scan: its latest version is now v4 (Draft)');
    expect(log.innerHTML).toContain('all-or-nothing');
    expect(history[0].undo).toEqual({ none: 'nothing was changed' });   // nothing for Undo to delete
  });

  it('a draft-only flow that got a second Draft since the scan is refused too', async () => {
    const org = fakeFlowOrg([{ Id: '301v1', n: 1, Status: 'Draft', api: '58.0' }]);
    const plans = scanPlan(org);
    org.versions.push({ Id: '301v2', n: 2, Status: 'Draft', api: '58.0', content: 'NEWER DRAFT' });
    const { run, history } = buildApply(org);
    await run(plans, '62.0');
    expect(org.sent.some(m => m.type === 'SF_METADATA_DEPLOY')).toBe(false);
    expect(org.versions.find(v => v.n === 2).content).toBe('NEWER DRAFT');
    expect(history[0].undo).toEqual({ none: 'nothing was changed' });
  });

  it('versions that cannot be re-read at Apply time refuse the org (never deploy blind)', async () => {
    const org = fakeFlowOrg([{ Id: '301v3', n: 3, Status: 'Active', api: '58.0' }]);
    const plans = scanPlan(org);
    org.failVersionRead = true;
    const { run, log } = buildApply(org);
    await run(plans, '62.0');
    expect(org.sent.some(m => m.type === 'SF_METADATA_DEPLOY')).toBe(false);
    expect(log.innerHTML).toContain('could not be re-read (HTTP 503)');
    expect(log.innerHTML).toContain('nothing changed here');
  });

  it('an unchanged org still goes through: new v4 is created, activated, and Undo may delete exactly that v4', async () => {
    const org = fakeFlowOrg([{ Id: '301v2', n: 2, Status: 'Obsolete', api: '58.0' }, { Id: '301v3', n: 3, Status: 'Active', api: '58.0' }]);
    const { run, history, log } = buildApply(org);
    await run(scanPlan(org), '62.0');
    expect(org.sent.filter(m => m.type === 'SF_METADATA_DEPLOY')).toHaveLength(1);
    expect(org.versions.find(v => v.n === 4)).toMatchObject({ Status: 'Active', api: '62.0' });
    expect(log.innerHTML).toContain('Route: v4 at API 62.0 is now ACTIVE');
    const steps = history[0].undo.steps;
    expect(steps.map(s => s.msg.type)).toEqual(['SF_PATCH', 'SF_TOOLING_DELETE']);
    expect(steps[0].msg.body).toEqual({ Metadata: { activeVersionNumber: 3 } });
    expect(steps[1].msg.id).toBe('301v4');                          // the version this run made, nothing older
  });

  it('a Draft rewritten in place on purpose (draft-only flow, unchanged) is done and has no Undo delete', async () => {
    const org = fakeFlowOrg([{ Id: '301v1', n: 1, Status: 'Draft', api: '58.0' }]);
    const { run, history, log } = buildApply(org);
    await run(scanPlan(org), '62.0');
    expect(org.versions).toHaveLength(1);
    expect(org.versions[0].api).toBe('62.0');
    expect(log.innerHTML).toContain('was rewritten in place at API 62.0');
    expect(history[0].undo.none).toContain('rewritten in place');
  });
});

// ── Org Health: the cards' run() against a fake background ──────────────
function loadOrgHealth(sendBg) {
  const ctx = {
    console, Date, Math, JSON, Promise, Map, Set, Array, Object, String, Number, RegExp, Error, encodeURIComponent,
    sendBg,
    soqlStrLit: v => `'${String(v).replace(/'/g, "\\'")}'`,
    _orgKey: u => String(u || ''),
    window: {},
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('sftk-apiver.js'), ctx);
  vm.runInContext(read('studio-orghealth.js') + '\n;globalThis.OH_CARDS = OH_CARDS;', ctx);
  return id => ctx.OH_CARDS.find(c => c.id === id);
}
const SESS = { orgUrl: 'https://a.my.salesforce.com', sid: 'sid' };

// An org for the pages card: FlexiPages, Lightning apps (overrides or an
// unreadable definition), and describes with no org-default override.
function fakePagesOrg({ pages, apps }) {
  const sent = [];
  const one = url => {
    let m;
    if ((m = /sobjects\/FlexiPage\/(\w+)$/.exec(url))) {
      const p = pages.find(x => x.Id === m[1]);
      return { ok: true, body: { FullName: p.DeveloperName, Metadata: { sobjectType: p.obj || null } } };
    }
    if ((m = /sobjects\/CustomApplication\/(\w+)$/.exec(url))) {
      const a = apps.find(x => x.Id === m[1]);
      return a.unreadable ? { ok: false, error: 'HTTP 500' }
        : { ok: true, body: { Metadata: { actionOverrides: (a.content || []).map(c => ({ actionName: 'View', type: 'Flexipage', content: c })), profileActionOverrides: [] } } };
    }
    if (/\/describe\//.test(url)) return { ok: true, body: { actionOverrides: [] } };
    return { ok: false, error: 'unexpected' };
  };
  const sendBg = async msg => {
    sent.push(msg);
    if (msg.type === 'SF_QUERY_ALL' && /FROM FlexiPage/.test(msg.query)) {
      const wantsNs = /NamespacePrefix/.test(msg.query);
      return { records: pages.map(p => ({ Id: p.Id, DeveloperName: p.DeveloperName, MasterLabel: p.label || p.DeveloperName, Type: p.Type || 'RecordPage',
        EntityDefinitionId: p.obj || null, ManageableState: p.ns ? 'installed' : 'unmanaged', ...(wantsNs ? { NamespacePrefix: p.ns || null } : {}) })) };
    }
    if (msg.type === 'SF_QUERY_ALL' && /FROM CustomApplication/.test(msg.query)) {
      return { records: apps.map(a => ({ Id: a.Id, DeveloperName: a.name, Label: a.name })) };
    }
    if (msg.type === 'SF_COMPOSITE_BATCH') return msg.subrequests.map(s => one(s.url));
    if (msg.type === 'SF_REST_GET') { const r = one(msg.path); return r.ok ? r.body : { error: r.error }; }
    return { error: `unexpected ${msg.type}` };
  };
  return { sendBg, sent };
}

describe('5. Org Health — a page is named by its full name, not by a suffix', () => {
  const count = extractFunction('studio-orghealth.js', 'sftkOhAppCount');
  it('pure: the reported input — pkg__X does not assign the org\'s own X', () => {
    const idx = { names: ['pkg__account_record_page'] };
    expect(count(idx, 'Account_Record_Page')).toBe(0);
    expect(count(idx, 'Account_Record_Page', '')).toBe(0);
    expect(count(idx, 'Account_Record_Page', 'pkg')).toBe(1);
    expect(count(idx, 'Account_Record_Page', 'other')).toBe(0);
  });
  it('pure: the mirror — the org\'s own X does not assign a packaged X when the org has its own X', () => {
    const idx = { names: ['account_record_page'] };
    expect(count(idx, 'Account_Record_Page')).toBe(1);
    expect(count(idx, 'Account_Record_Page', 'pkg', true)).toBe(0);    // the org has its own page of that name
    expect(count(idx, 'Account_Record_Page', 'pkg', false)).toBe(1);   // a namespaced org writing its own page bare
    expect(count(null, 'X')).toBe(0);
    expect(count(idx, '')).toBe(0);
  });

  it('the card: the org\'s own unused page is listed "assigned to nobody" although an app names pkg__ the same name', async () => {
    const org = fakePagesOrg({
      pages: [
        { Id: '0M0000000000001', DeveloperName: 'Account_Record_Page', label: 'Account Record Page', obj: 'Account' },
        { Id: '0M0000000000002', DeveloperName: 'Account_Record_Page', label: 'Account Record Page (pkg)', obj: 'Account', ns: 'pkg' },
        { Id: '0M0000000000003', DeveloperName: 'Case_Page', label: 'Case Page', obj: 'Case' },
      ],
      apps: [{ Id: '02u000000000001', name: 'Sales', content: ['pkg__Account_Record_Page', 'Case_Page'] }],
    });
    const v = await loadOrgHealth(org.sendBg)('pages').run(SESS, {});
    expect(v.tone).toBe('warn');
    expect(v.headline).toBe('1 Lightning page(s) are assigned to nobody');
    expect(v.lines).toEqual(['Account Record Page [Account_Record_Page] (RecordPage · Account) — assigned to nobody']);
    expect(org.sent.find(m => /FROM FlexiPage/.test(m.query || '')).query).toContain('NamespacePrefix');
  });

  it('the card: with every page assigned by its own full name the card is on the good tone', async () => {
    const org = fakePagesOrg({
      pages: [
        { Id: '0M0000000000001', DeveloperName: 'Account_Record_Page', obj: 'Account' },
        { Id: '0M0000000000002', DeveloperName: 'Account_Record_Page', obj: 'Account', ns: 'pkg' },
      ],
      apps: [{ Id: '02u000000000001', name: 'Sales', content: ['pkg__Account_Record_Page'] },
             { Id: '02u000000000002', name: 'Service', content: ['Account_Record_Page'] }],
    });
    const v = await loadOrgHealth(org.sendBg)('pages').run(SESS, {});
    expect(v.tone).toBe('good');
    expect(v.headline).toBe('Every one of the 2 Lightning page(s) checked is assigned somewhere');
  });
});

describe('6. Org Health cards run for real (they were pinned as source text only)', () => {
  it('pages: an app whose definition is not returned makes its pages "could not be checked", and the app reads stay aligned', async () => {
    const org = fakePagesOrg({
      pages: [
        { Id: '0M0000000000001', DeveloperName: 'Used_Page', label: 'Used', obj: 'Account' },
        { Id: '0M0000000000002', DeveloperName: 'Lonely_Page', label: 'Lonely', obj: 'Account' },
        { Id: '0M0000000000003', DeveloperName: 'Home_Page', label: 'Home', Type: 'HomePage' },
      ],
      // the unreadable app is FIRST: a misaligned read would take the second app's overrides for it
      apps: [{ Id: '02u000000000001', name: 'Broken', unreadable: true },
             { Id: '02u000000000002', name: 'Sales', content: ['Used_Page'] }],
    });
    const v = await loadOrgHealth(org.sendBg)('pages').run(SESS, {});
    expect(v.tone).toBe('warn');
    expect(v.headline).toContain('NOT an all-clear');
    expect(v.headline).not.toContain('assigned to nobody');
    const lines = v.lines.join('|');
    expect(lines).toContain('Lonely [Lonely_Page] (RecordPage · Account) — could not be checked');
    expect(lines).toContain('1 of 2 Lightning app(s) could not be read (Broken)');
    expect(lines).not.toContain('Used');                           // read from the app that DID answer
    expect(lines).toContain('1 Home / App page(s) not judged');
    // the apps are read from the Lightning apps list, one definition each
    expect(org.sent.some(m => /FROM CustomApplication WHERE UiType = 'Lightning'/.test(m.query || ''))).toBe(true);
  });

  it('pages: an apps list that cannot be read is never an all-clear', async () => {
    const org = fakePagesOrg({ pages: [{ Id: '0M0000000000002', DeveloperName: 'Lonely_Page', label: 'Lonely', obj: 'Account' }], apps: [] });
    const sendBg = async msg => (/FROM CustomApplication/.test(msg.query || '') ? { error: 'INVALID_TYPE' } : org.sendBg(msg));
    const v = await loadOrgHealth(sendBg)('pages').run(SESS, {});
    expect(v.tone).toBe('warn');
    expect(v.lines.join('|')).toContain('the list of Lightning apps could not be read (INVALID_TYPE)');
  });

  const versions = [{ version: '64.0', label: "Summer '25", url: '/services/data/v64.0' }, { version: '66.0', label: "Spring '26", url: '/services/data/v66.0' }];
  it('apiver: the query asks for ManageableState on the flow and its definition, and the verdict comes from the rows', async () => {
    const sent = [];
    const sendBg = async msg => {
      sent.push(msg);
      if (msg.type === 'SF_REST_GET') return versions;
      if (msg.type === 'SF_QUERY_ALL') return { records: [
        { Id: '301a', ApiVersion: 50, Status: 'Active', ManageableState: 'unmanaged', Definition: { DeveloperName: 'Old_Own', NamespacePrefix: 'myns', ManageableState: 'unmanaged' } },
        { Id: '301b', ApiVersion: 50, Status: 'Active', ManageableState: 'installed', Definition: { DeveloperName: 'Old_Pkg', NamespacePrefix: 'pkg', ManageableState: 'installed' } },
        { Id: '301c', ApiVersion: 66, Status: 'Active', ManageableState: 'unmanaged', Definition: { DeveloperName: 'Fresh', NamespacePrefix: null, ManageableState: 'unmanaged' } },
      ] };
      return { error: 'unexpected' };
    };
    const v = await loadOrgHealth(sendBg)('apiver').run(SESS, {});
    const q = sent.find(m => m.type === 'SF_QUERY_ALL');
    expect(q.tooling).toBe(true);
    expect(q.query).toMatch(/\bManageableState\b.*Definition\.ManageableState.*FROM Flow WHERE Status = 'Active'/);
    expect(v.tone).toBe('warn');
    expect(v.lines[0]).toBe('Old_Own — API 50 · 16 releases behind');   // your own namespaced flow IS counted
    expect(v.lines.join('|')).not.toContain('Old_Pkg —');               // the installed one is not
  });

  it('apiver: a Tooling answer that refuses the query is an error, never the good tone', async () => {
    const sendBg = async msg => (msg.type === 'SF_REST_GET' ? versions : { error: "No such column 'ManageableState' on entity 'Flow'" });
    await expect(loadOrgHealth(sendBg)('apiver').run(SESS, {})).rejects.toThrow(/No such column/);
  });
});
