// Regressions and half-applied fixes of release QA 1.1 (f0334a0), engine area —
// 2026-11-15. Every test here RUNS the real function (sliced out of its file,
// the way release-qa-1114-engine.test.mjs does); none asserts on source text.
//  1. a Bypass run's page-side updates (overwrite, relink) carry the header
//     again — from the message, never from the worker flag
//  2. only the page that started a run can pause / cancel / "close" it
//  3. a thrown write call reaches the pages (writeError, the session hint) and
//     a definite refusal is worded "not written"
//  4. a run refused as BUSY is marked busy: no History entry, no restore point
//  5. the 📎 files-pass note never counts the records it left out
//  6. behaviour of the run guard at every entry point and of the Bulk
//     result-file re-read (were source-text assertions only)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const BG = read('background.js');
const sliceFrom = (src, name) => {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(src);
  if (!m) throw new Error('not found ' + name);
  return src.slice(m.index, src.indexOf('\n}', m.index) + 2);
};
const sliceFn = (name) => sliceFrom(BG, name);
const sliceBlock = (start, end) => {
  const i = BG.indexOf(start);
  if (i < 0) throw new Error('not found ' + start);
  return BG.slice(i, BG.indexOf(end, i) + end.length);
};

// ── the worker's run lifecycle + dispatcher, materialised in one scope ─────
// Real: the port listener, the message listener (which claims the run for its
// sender), handleMessage, dispatchMessage, _beginRun / _endRun,
// postRunProgress, sfCollectionsUpdate and the duplicate-rule headers.
// Stubbed: the engines behind the three entry points and the HTTP call.
const BUSY = /const SFTK_RUN_BUSY = ('[^']+');/.exec(BG)[1];
const makeWorker = () => new Function(`
  let _runActive = false, _runCancelled = false, _runStopWhy = '', _runStopLineLast = '', _runHeartbeat = null, _runPort = null;
  const SFTK_RUN_BUSY = ${BUSY};
  const API_VERSION = 'v62.0';
  let onConnect = null, onMessage = null;
  const chrome = {
    storage: { local: { set: () => Promise.resolve(), remove: () => Promise.resolve() } },
    runtime: { id: 'ext', getURL: p => 'chrome-extension://ext/' + p,
      onConnect: { addListener: fn => { onConnect = fn; } }, onMessage: { addListener: fn => { onMessage = fn; } } },
  };
  const _runPorts = new Set();
  let _runOwnerPort = null;
  const T = { engine: {}, fetches: [], fetchAnswer: null };
  async function executeProfileTransfer(...a) { return T.engine.transfer(...a); }
  async function executeProfileSequence(...a) { return T.engine.sequence(...a); }
  async function sftkWipeObject(...a) { return T.engine.wipe(...a); }
  async function sfQuery(...a) { return T.engine.query(...a); }
  function _runLedger() { return { idMap: {} }; }
  function sfErrorMsg(status) { return 'HTTP ' + status; }
  async function sfFetchWithProxy(orgUrl, sid, url, opts) {
    T.fetches.push({ url, method: opts.method, headers: opts.headers || {}, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, body: JSON.stringify(JSON.parse(opts.body).records.map(r => ({ id: r.Id, success: true, errors: [] }))) };
  }
  ${sliceBlock('const SFTK_RUN_MESSAGES = ', ';')}
  ${sliceFn('_runSenderKey')}
  ${sliceFn('_runClaimPort')}
  ${sliceFn('_runWatchPort')}
  ${sliceBlock('chrome.runtime.onConnect.addListener(port => {', '\n});')}
  ${sliceFn('postRunProgress')}
  ${sliceFn('_beginRun')}
  ${sliceFn('_endRun')}
  ${sliceFn('_runDupHeaders')}
  ${sliceFn('sftkDupHeadersExplicit')}
  ${sliceFn('sfCollectionsUpdate')}
  ${sliceBlock('const MESSAGE_CONTRACTS = {', '\n};')}
  ${sliceFn('dispatchMessage')}
  ${sliceFn('handleMessage')}
  ${sliceBlock('chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {', '\n});')}
  // a message as a Studio page sends it; doc = that page's documentId (null = a sender Chrome gives no id for)
  const send = (message, doc) => new Promise(resolve => {
    onMessage(message, { id: 'ext', url: 'chrome-extension://ext/studio.html', ...(doc ? { documentId: doc } : {}) }, resolve);
  });
  return {
    T, connect: p => { onConnect(p); return p; }, send, _beginRun, _endRun, sfCollectionsUpdate,
    state: () => ({ active: _runActive, cancelled: _runCancelled, why: _runStopWhy, port: _runPort }),
  };
`)();
// A progress port as the worker sees it. doc = the page's documentId.
const fakePort = (doc) => {
  const p = { name: 'sftk-run-progress', sender: doc ? { documentId: doc } : undefined, got: [], _m: [], _d: [],
    onMessage: { addListener: f => p._m.push(f) }, onDisconnect: { addListener: f => p._d.push(f) },
    postMessage: m => p.got.push(m), say: cmd => p._m.forEach(f => f({ cmd })), close: () => p._d.forEach(f => f()) };
  return p;
};
const deferred = () => { let done; const p = new Promise(r => { done = r; }); return { p, done }; };
const XFER = { type: 'SF_EXECUTE_PROFILE_TRANSFER', profile: { id: 'p' }, srcOrgUrl: 'https://s', srcSid: 'S', tgtOrgUrl: 'https://t', tgtSid: 'T' };
const SEQ = { type: 'SF_EXECUTE_SEQUENCE', profiles: [{ id: 'p' }], srcOrgUrl: 'https://s', srcSid: 'S', tgtOrgUrl: 'https://t', tgtSid: 'T' };
const WIPE = { type: 'SFTK_WIPE_OBJECT', orgUrl: 'https://t', sid: 'T', objType: 'Account', mode: 'recycle' };
afterEach(() => { delete globalThis.__sftkRunDupBypass; delete globalThis.__sftkRunDupBypassObjs; });

// ── 2 · whose run it is ──────────────────────────────────────────────────
describe('only the page that started a run can pause, cancel or close it', () => {
  it('a tab whose port connected earlier (Reconcile between its legs) cannot stop another tab\'s run', async () => {
    const W = makeWorker();
    const A = W.connect(fakePort('docA'));
    W.T.engine.transfer = async () => ({ status: 'success', summary: {} });
    await W.send(XFER, 'docA');          // A's first leg begins and ends
    // the gap between A's legs: B connects and starts its own run
    const B = W.connect(fakePort('docB'));
    const hold = deferred();
    W.T.engine.transfer = async () => { await hold.p; return { status: 'success', summary: {} }; };
    const bRun = W.send(XFER, 'docB');
    await Promise.resolve();
    expect(W.state().active).toBe(true);
    A.say('pause');
    expect(W.state()).toMatchObject({ cancelled: false, why: '' });
    A.say('cancel');
    expect(W.state().cancelled).toBe(false);
    A.close();                                                        // A's reconcile ends and disconnects
    expect(W.state()).toMatchObject({ cancelled: false, why: '' });
    expect(B.got.some(m => m.phase === 'start')).toBe(true);          // B's run streams to B
    // …and B itself still can
    B.say('pause');
    expect(W.state()).toMatchObject({ cancelled: true, why: 'pause' });
    hold.done(); await bRun;
    expect(W.state().active).toBe(false);
  });

  it('a port that connected in the gap does not take over the next leg of the tab that is running', async () => {
    const W = makeWorker();
    const A = W.connect(fakePort('docA'));
    W.T.engine.transfer = async () => ({ status: 'success', summary: {} });
    await W.send(XFER, 'docA');
    const B = W.connect(fakePort('docB'));                            // now the LAST port to connect
    const hold = deferred();
    W.T.engine.transfer = async () => { await hold.p; return { status: 'success', summary: {} }; };
    A.got.length = 0;
    const aRun = W.send(XFER, 'docA');     // A's next leg
    await Promise.resolve();
    expect(A.got.map(m => m.phase)).toContain('start');               // progress goes to the page that asked
    expect(B.got).toEqual([]);
    B.say('cancel'); B.close();
    expect(W.state()).toMatchObject({ cancelled: false, why: '' });
    A.say('cancel');
    expect(W.state()).toMatchObject({ cancelled: true, why: 'cancel' });
    hold.done(); await aRun;
  });

  it('a page that connects while a run is on is a bystander — and owns its own run afterwards', async () => {
    const W = makeWorker();
    const A = W.connect(fakePort('docA'));
    const hold = deferred();
    W.T.engine.transfer = async () => { await hold.p; return { status: 'success', summary: {} }; };
    const aRun = W.send(XFER, 'docA');
    await Promise.resolve();
    const B = W.connect(fakePort('docB'));
    expect(W.state().port).toBe(A);                                   // the log is not taken over
    B.say('cancel'); B.say('pause');
    expect(W.state().cancelled).toBe(false);
    const refused = await W.send(XFER, 'docB');
    expect(refused.busy).toBe(true);
    expect(W.state()).toMatchObject({ active: true, cancelled: false, port: A });
    hold.done(); await aRun;
    // B starts again: now it is B's run
    const hold2 = deferred();
    W.T.engine.transfer = async () => { await hold2.p; return { status: 'success', summary: {} }; };
    const bRun = W.send(XFER, 'docB');
    await Promise.resolve();
    A.say('cancel');
    expect(W.state().cancelled).toBe(false);
    B.say('cancel');
    expect(W.state()).toMatchObject({ cancelled: true, why: 'cancel' });
    hold2.done(); await bRun;
  });

  it('the owner closing its page stops the run as "closed"; nothing happens between runs', async () => {
    const W = makeWorker();
    const A = W.connect(fakePort('docA'));
    const hold = deferred();
    W.T.engine.transfer = async () => { await hold.p; return { status: 'success', summary: {} }; };
    const aRun = W.send(XFER, 'docA');
    await Promise.resolve();
    A.close();
    expect(W.state()).toMatchObject({ cancelled: true, why: 'closed', port: null });
    hold.done(); await aRun;
    const C = W.connect(fakePort('docC'));
    C.say('cancel'); C.close();                                       // no run on
    expect(W.state().active).toBe(false);
    W.T.engine.transfer = async () => ({ status: 'success', summary: {} });
    const res = await W.send(XFER, 'docD');   // a page with no port
    expect(res.status).toBe('success');
  });

  it('when the sender cannot be told apart, the last port to connect owns the run and an earlier one cannot stop it', async () => {
    const W = makeWorker();
    const A = W.connect(fakePort(null));
    const B = W.connect(fakePort(null));
    const hold = deferred();
    W.T.engine.transfer = async () => { await hold.p; return { status: 'success', summary: {} }; };
    const run = W.send(XFER, null);
    await Promise.resolve();
    A.say('cancel'); A.close();
    expect(W.state().cancelled).toBe(false);
    B.say('cancel');
    expect(W.state().cancelled).toBe(true);
    hold.done(); await run;
  });
});

// ── 4 + 6 · the run guard at every entry point ───────────────────────────
describe('every engine entry point: refuses a second run as busy, and always releases the guard', () => {
  const entries = [
    ['transfer', XFER, 'transfer'],
    ['sequence', SEQ, 'sequence'],
    ['wipe', WIPE, 'wipe'],
  ];
  for (const [label, msg, key] of entries) {
    it(`${label}: a second request while one runs is refused with busy: true and leaves the first run alone`, async () => {
      const W = makeWorker();
      const hold = deferred();
      W.T.engine[key] = async () => { await hold.p; return { status: 'success', summary: {}, deleted: 1 }; };
      const first = W.send(msg, 'docA');
      await Promise.resolve();
      for (const other of [XFER, SEQ, WIPE]) {
        const r = await W.send(other, 'docB');
        expect(r.busy).toBe(true);
        expect(r.error).toMatch(/Another Data Studio run is already in progress/);
        expect(r.error).toMatch(/Nothing was written by this request/);
      }
      expect(W.state().active).toBe(true);        // the refusals did not end the first run's guard
      hold.done(); await first;
      expect(W.state().active).toBe(false);
    });

    it(`${label}: an engine that throws still releases the guard — the next run starts`, async () => {
      const W = makeWorker();
      W.T.engine[key] = async () => { throw new Error('boom'); };
      const res = await W.send(msg, 'docA');
      expect(res.error).toBe('boom');
      expect(res.busy).toBeUndefined();
      expect(W.state().active).toBe(false);
      expect(W._beginRun('transfer')).toBe(true);
      W._endRun();
    });
  }

  it('wipe: the production-org refusal of a hard delete returns inside the guard and releases it', async () => {
    const W = makeWorker();
    let wiped = false;
    W.T.engine.wipe = async () => { wiped = true; return { deleted: 1 }; };
    W.T.engine.query = async () => ({ records: [{ IsSandbox: false, TrialExpirationDate: null }] });
    const r = await W.send({ ...WIPE, mode: 'hard' }, 'docA');
    expect(r.error).toMatch(/Hard delete is disabled against PRODUCTION/);
    expect(r.busy).toBeUndefined();
    expect(wiped).toBe(false);
    expect(W.state().active).toBe(false);
  });

  it('a run that finished normally is not marked busy', async () => {
    const W = makeWorker();
    W.T.engine.transfer = async () => ({ status: 'success', summary: { Account: { created: 1 } } });
    const r = await W.send(XFER, 'docA');
    expect(r.busy).toBeUndefined();
    expect(r.status).toBe('success');
  });
});

// the pages' side of a busy refusal — one shared function (sftk-run-progress.js)
describe('a refused-as-busy run on the pages: said, not recorded', () => {
  const P = extractFunctions('sftk-run-progress.js', ['sftkRunRefusedBusy', 'sftkRunUnconfirmedInfo']);
  it('says the engine line as a warning, drops the restore point just captured, and tells the page to stop', async () => {
    const log = [], toasts = []; let dropped = 0;
    const handled = await P.sftkRunRefusedBusy({ error: 'Another Data Studio run is already in progress. Nothing was written by this request.', busy: true, status: 'failed' },
      { log: (...a) => log.push(a), toast: (...a) => toasts.push(a), dropRestorePoint: async () => { dropped++; } });
    expect(handled).toBe(true);
    expect(dropped).toBe(1);
    expect(log).toHaveLength(1);
    expect(log[0][1]).toMatch(/Nothing was written by this request/);
    expect(log[0][2]).toBe('ds-prog-warn');
    expect(toasts[0][1]).toBe('warning');
    expect(toasts[0][0]).not.toMatch(/failed/i);
  });
  it('a restore point that cannot be dropped does not turn the refusal into a failure', async () => {
    const handled = await P.sftkRunRefusedBusy({ error: 'x', busy: true }, { log: () => {}, toast: () => {}, dropRestorePoint: async () => { throw new Error('idb'); } });
    expect(handled).toBe(true);
  });
  it('a run that really failed midway keeps its own branch (History entry with the restore point)', async () => {
    let touched = 0;
    const io = { log: () => { touched++; }, toast: () => { touched++; }, dropRestorePoint: async () => { touched++; } };
    expect(await P.sftkRunRefusedBusy({ error: 'HTTP 500', status: 'failed' }, io)).toBe(false);
    expect(await P.sftkRunRefusedBusy({ status: 'success', summary: {} }, io)).toBe(false);
    expect(await P.sftkRunRefusedBusy(null, io)).toBe(false);
    expect(touched).toBe(0);
  });

  // 3 · what the pages read from a summary whose write call threw
  it('an object whose write call threw is a failure row with a count, and keeps the session hint', () => {
    const u = P.sftkRunUnconfirmedInfo({ created: 0, failed: 0, unconfirmed: 1200, writeError: 'SESSION_EXPIRED', writeRefused: true });
    expect(u.n).toBe(1200);
    expect(u.expired).toBe(true);
    expect(u.note).toBe(', 1,200 not written (the write call was refused)');
    const t = P.sftkRunUnconfirmedInfo({ created: 3, unconfirmed: 2, writeError: 'Request timed out after 30 s' });
    expect(t).toEqual({ n: 2, note: ', 2 not confirmed written', expired: false });
    expect(P.sftkRunUnconfirmedInfo({ created: 5, failed: 0 })).toEqual({ n: 0, note: '', expired: false });
    expect(P.sftkRunUnconfirmedInfo({ error: 'INVALID_SESSION_ID: Session expired or invalid' }).expired).toBe(true);
    expect(P.sftkRunUnconfirmedInfo(undefined)).toEqual({ n: 0, note: '', expired: false });
  });
});

// ── 1 · the duplicate-rule choice on page-side updates ───────────────────
describe('SF_COLLECTIONS_UPDATE carries the run\'s duplicate-rule choice in the message', () => {
  const upd = (extra) => ({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: 'https://t', sid: 'T',
    records: [{ attributes: { type: 'Account' }, Id: '001A', Name: 'x' }], ...(extra || {}) });
  const HDR = { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' };

  it('a Bypass run\'s overwrite is sent with allowSave=true although no engine leg is on', async () => {
    const W = makeWorker();
    await W.send(upd({ dupBypass: true, dupBypassObjects: null }));
    expect(W.T.fetches).toHaveLength(1);
    expect(W.T.fetches[0].method).toBe('PATCH');
    expect(W.T.fetches[0].headers).toEqual(HDR);
  });

  it('a Respect run\'s overwrite carries no header — even while ANOTHER tab\'s Bypass run is on in the worker', async () => {
    const W = makeWorker();
    globalThis.__sftkRunDupBypass = true; globalThis.__sftkRunDupBypassObjs = null;   // the other tab's run
    await W.send(upd());
    await W.send(upd({ dupBypass: false }));
    await W.send(upd({ dupBypass: 'true' }));       // only a real true counts
    expect(W.T.fetches.map(f => f.headers)).toEqual([{}, {}, {}]);
  });

  it('the ⏸ panel\'s per-object choice narrows it: only the ticked objects are bypassed', async () => {
    const W = makeWorker();
    await W.send(upd({ dupBypass: true, dupBypassObjects: ['Contact'] }));
    await W.send(upd({ dupBypass: true, dupBypassObjects: ['Contact', 'Account'] }));
    await W.send(upd({ dupBypass: true, dupBypassObjects: [] }));
    expect(W.T.fetches.map(f => f.headers)).toEqual([{}, HDR, {}]);
  });

  it('every chunk of 200 carries it, and the records arrive unchanged', async () => {
    const W = makeWorker();
    const records = Array.from({ length: 201 }, (_, i) => ({ attributes: { type: 'Account' }, Id: '001' + i, Name: 'n' + i }));
    const out = await W.send({ type: 'SF_COLLECTIONS_UPDATE', orgUrl: 'https://t', sid: 'T', records, dupBypass: true });
    expect(W.T.fetches.map(f => f.body.records.length)).toEqual([200, 1]);
    expect(W.T.fetches.every(f => f.headers['Sforce-Duplicate-Rule-Header'] === 'allowSave=true')).toBe(true);
    expect(out).toHaveLength(201);
  });

  it('an engine-internal update inside a run still follows the run\'s own flag', async () => {
    const W = makeWorker();
    const recs = [{ attributes: { type: 'Account' }, Id: '001A' }];
    await W.sfCollectionsUpdate('https://t', 'T', recs);
    globalThis.__sftkRunDupBypass = true; globalThis.__sftkRunDupBypassObjs = null;
    await W.sfCollectionsUpdate('https://t', 'T', recs);
    expect(W.T.fetches.map(f => f.headers)).toEqual([{}, HDR]);
  });
});

describe('Reconcile hands that choice to its own overwrite of drifted records', () => {
  const R = extractFunctions('studio-reconcile.js', ['sftkRecDupFields']);
  it('sftkRecDupFields: Bypass → the fields, with the ⏸ panel\'s objects; Respect → nothing', () => {
    expect(R.sftkRecDupFields({ duplicateRules: 'bypass' }, null)).toEqual({ dupBypass: true, dupBypassObjects: null });
    expect(R.sftkRecDupFields({ duplicateRules: 'bypass' }, { objects: null, unread: 'x' })).toEqual({ dupBypass: true, dupBypassObjects: null });
    expect(R.sftkRecDupFields({ duplicateRules: 'bypass' }, { objects: ['Account'], rules: [] })).toEqual({ dupBypass: true, dupBypassObjects: ['Account'] });
    expect(R.sftkRecDupFields({ duplicateRules: 'respect' }, { objects: ['Account'] })).toEqual({});
    expect(R.sftkRecDupFields({}, { objects: ['Account'] })).toEqual({});
    expect(R.sftkRecDupFields(null, null)).toEqual({});
  });

  // reconcileOverwrite itself, with the page's message channel stubbed.
  const RC = read('studio-reconcile.js');
  const ACCOUNT_FIELDS = [
    { name: 'Id', type: 'id', updateable: false, createable: false },
    { name: 'Name', type: 'string', updateable: true, createable: true, nameField: true, length: 255 },
    { name: 'Phone', type: 'phone', updateable: true, createable: true, length: 40 },
  ];
  const runOverwrite = async (profile, dupFields) => {
    const sent = [];
    const sendBg = async (m) => {
      sent.push(m);
      if (m.type === 'SF_REST_GET') return { name: 'Account', fields: ACCOUNT_FIELDS };
      if (m.type === 'SF_QUERY_ALL') {
        if (m.orgUrl === 'https://src') return { records: [{ Id: 'S1', Name: 'Acme', Phone: '111' }] };
        return { records: [{ Id: 'T1', Name: 'Acme', Phone: '111' }] };
      }
      if (m.type === 'SF_COLLECTIONS_UPDATE') return m.records.map(r => ({ id: r.Id, success: true, errors: [] }));
      return { error: 'unexpected ' + m.type };
    };
    const fn = new Function('sendBg', `
      const sftkMergeArr = (acc, r) => [...(acc || []), ...(Array.isArray(r) ? r : [])];
      ${sliceFrom(read('sftk-write.js'), '_sftkWriteVerifiedCore')}
      ${sliceFrom(read('sftk-write.js'), 'sftkWriteVerified')}
      ${sliceFrom(read('studio-core.js'), 'soqlStrLit')}
      ${sliceFrom(read('studio-history.js'), 'sftkFieldChanges')}
      ${sliceFrom(read('studio-scan.js'), 'sftkEngineCompareSet')}
      ${sliceFrom(RC, 'sftkReconcileChunkedWrite')}
      ${sliceFrom(RC, 'reconcileOverwrite')}
      return reconcileOverwrite;
    `)(sendBg);
    const result = await fn(profile, 'Account', ['S1'], [{ matchKey: 'Acme', sourceId: 'S1', targetId: 'T1' }],
      { orgUrl: 'https://src', sid: 'S' }, { orgUrl: 'https://tgt', sid: 'T' }, dupFields);
    return { result, updates: sent.filter(m => m.type === 'SF_COLLECTIONS_UPDATE') };
  };
  const PROFILE = (extra) => ({ id: 'p', targetOrg: 'https://tgt', sourceOrg: 'https://src',
    tree: { objectType: 'Account', fieldMappings: { Name: 'Name', Phone: 'Phone' } }, ...(extra || {}) });

  it('a Bypass run: the overwrite message carries dupBypass and the per-object choice', async () => {
    const p = PROFILE({ duplicateRules: 'bypass' });
    const { result, updates } = await runOverwrite(p, R.sftkRecDupFields(p, { objects: ['Account'] }));
    expect(updates).toHaveLength(1);
    expect(updates[0].records[0]).toMatchObject({ Id: 'T1', Name: 'Acme', Phone: '111' });
    expect(updates[0].dupBypass).toBe(true);
    expect(updates[0].dupBypassObjects).toEqual(['Account']);
    expect(result.ok).toBe(1);
  });

  it('a Respect run, and the reverse-drift write into the source org, carry none', async () => {
    const respect = PROFILE();
    const a = await runOverwrite(respect, R.sftkRecDupFields(respect, null));
    expect(a.updates).toHaveLength(1);
    expect('dupBypass' in a.updates[0]).toBe(false);
    // the reverse write passes no choice at all, whatever the profile says
    const b = await runOverwrite(PROFILE({ duplicateRules: 'bypass' }), undefined);
    expect(b.updates).toHaveLength(1);
    expect('dupBypass' in b.updates[0]).toBe(false);
  });
});

// ── 3 + 5 · the engine write loop and the files pass ─────────────────────
const eng = extractFunctions('background.js', [
  'executeProfileTransfer', 'sftkUnconfirmedRows', 'sftkIsUnconfirmed', 'sftkFailureMeansInTarget', 'sftkFileKeyPairs',
  '_runDupBypassFor', 'sftkRunStopLine', '_runStopReason', '_runNoteStop', 'sftkVanillaPayloadRules', 'sftkEffectiveLookupResolutions', 'sftkLookupDefaultStrategy', 'buildCopyFields', 'sftkFieldsFromError', 'sftkOrgKey',
  'sftkTruncValue', 'sftkBuildOwnerIndex', 'sftkMatchKey', 'sftkPathValue',
  'sftkPiiHashHex', 'sftkPiiMaskable', 'sftkPiiFormat', 'sftkPiiMaskValue',
  'sftkPiiRulesForObject', 'sftkPiiMaskRows', 'sftkPiiMaskAnchorMap', 'sftkRtaImageCount',
]);
const SRC = 'https://src.my.salesforce.com', TGT = 'https://tgt.my.salesforce.com';
const f = (name, label, type, extra) => Object.assign({
  name, label, type, createable: true, updateable: true, nillable: true,
  defaultValue: null, referenceTo: [], custom: false, length: 255,
}, extra || {});
const ACCOUNT_DESC = { name: 'Account', fields: [
  f('Id', 'Account ID', 'id', { createable: false, updateable: false }),
  f('Name', 'Account Name', 'string', { nillable: false, nameField: true }),
] };
const SRC_ACCOUNTS = [{ Id: 'A1', Name: 'Acme' }, { Id: 'A2', Name: 'John Smith' }, { Id: 'A3', Name: 'Carol' }];
let TGT_ACCOUNTS = [];
let creates, filesIdMap, tgtKeyQueries;
const KEYS = ['API_VERSION', '_runCancelled', 'postRunProgress', 'sfQuery', 'sfQueryAll', 'sfRestGet',
  'sfCollectionsCreate', 'sfCollectionsUpdate', 'sfCollectionsUpsert', 'sfBulkIngest', 'sfBulkQuery', 'sftkTransferFilesForNode'];
const engineSetup = () => {
  creates = []; filesIdMap = null; TGT_ACCOUNTS = []; tgtKeyQueries = [];
  globalThis.API_VERSION = 'v62.0';
  globalThis._runCancelled = false;
  globalThis.postRunProgress = () => {};
  const answer = (orgUrl, q) => {
    let out = orgUrl === TGT ? TGT_ACCOUNTS : (/FROM Account/.test(q) ? SRC_ACCOUNTS : []);
    const idIn = /Id IN \(([^)]*)\)/.exec(q);
    if (idIn) { const ids = new Set([...idIn[1].matchAll(/'([^']+)'/g)].map(m => m[1])); out = out.filter(r => ids.has(r.Id)); }
    const nameIn = /Name IN \(([^)]*)\)/.exec(q);
    if (nameIn && orgUrl === TGT) {
      tgtKeyQueries.push(q);
      const names = new Set([...nameIn[1].matchAll(/'([^']+)'/g)].map(m => m[1]));
      out = out.filter(r => names.has(r.Name));
    }
    if (/SELECT COUNT\(\)/.test(q)) return { totalSize: out.length, records: [] };
    return { records: out, totalSize: out.length, serverTotal: out.length };
  };
  globalThis.sfQuery = async (o, s, q) => answer(o, q);
  globalThis.sfQueryAll = async (o, s, q) => answer(o, q);
  globalThis.sfRestGet = async (o, s, path) => (/Account\/describe/.test(path) ? ACCOUNT_DESC : { error: 'unexpected ' + path });
  globalThis.sfCollectionsUpdate = async (o, s, recs) => recs.map(() => ({ success: true }));
  globalThis.sfCollectionsUpsert = async () => { throw new Error('upsert not expected'); };
  globalThis.sfBulkIngest = async () => { throw new Error('bulk not expected'); };
  globalThis.sfBulkQuery = async () => { throw new Error('bulk query not expected'); };
  globalThis.sftkTransferFilesForNode = async (objType, so, ss, to, ts, idMap) => { filesIdMap = { ...idMap }; return { copied: 0 }; };
};
const PROFILE = (extra) => ({ id: 'p1', name: 'QA', batchSize: 1,
  tree: { objectType: 'Account', recordIds: ['A1', 'A2', 'A3'], children: [] }, ...(extra || {}) });

describe('a thrown write call tells the pages what happened', () => {
  beforeEach(engineSetup);
  afterEach(() => { for (const k of KEYS) delete globalThis[k]; });

  it('an expired target session: the summary carries the call\'s message, and the line says NOT written', async () => {
    globalThis.sfCollectionsCreate = async (o, s, chunk) => { creates.push(chunk.map(r => r.Name)); throw new Error('SESSION_EXPIRED'); };
    const res = await eng.executeProfileTransfer(PROFILE(), SRC, 'S', TGT, 'T');
    const s = res.summary.Account;
    expect(s.writeError).toBe('SESSION_EXPIRED');
    expect(s.writeRefused).toBe(true);
    expect(s.unconfirmed).toBe(1);
    expect(s.created).toBe(0);
    expect(creates).toEqual([['Acme']]);
    const lines = res.errors.join('\n');
    expect(lines).toMatch(/Account: 1 record\(s\) NOT written — Salesforce refused the write call \(SESSION_EXPIRED\) before saving anything/);
    expect(lines).toMatch(/2 later record\(s\) were not sent/);
    expect(lines).not.toMatch(/may or may not be in the target/);
    expect((s.failedSourceIds || []).map(x => x.id)).not.toContain('A1');   // still never retried blind
    expect(res.status).not.toBe('success');
  });

  it('an HTTP 400 on the Collections call is a refusal too', async () => {
    globalThis.sfCollectionsCreate = async () => { throw new Error('HTTP 400: Json Deserialization failed'); };
    const res = await eng.executeProfileTransfer(PROFILE(), SRC, 'S', TGT, 'T');
    expect(res.summary.Account.writeRefused).toBe(true);
    expect(res.errors.join('\n')).toMatch(/NOT written — Salesforce refused the write call \(HTTP 400/);
  });

  it('a timeout or a 5xx stays "may or may not be in the target" — Salesforce may have committed', async () => {
    for (const msg of ['Request timed out after 30 s — URL: x', 'HTTP 503: Service Unavailable']) {
      engineSetup();
      globalThis.sfCollectionsCreate = async () => { throw new Error(msg); };
      const res = await eng.executeProfileTransfer(PROFILE(), SRC, 'S', TGT, 'T');
      expect(res.summary.Account.writeError).toBe(msg);
      expect(res.summary.Account.writeRefused).toBeUndefined();
      expect(res.errors.join('\n')).toMatch(/NOT CONFIRMED written — a write call failed/);
      expect(res.errors.join('\n')).toMatch(/may or may not be in the target/);
    }
  });

  it('one refused call next to one that timed out in the same wave: nothing is called "not written"', async () => {
    globalThis.sfCollectionsCreate = async (o, s, chunk) => {
      if (chunk[0].Name === 'Acme') throw new Error('SESSION_EXPIRED');
      throw new Error('Request timed out after 30 s — URL: x');
    };
    const res = await eng.executeProfileTransfer(PROFILE({ threads: 2 }), SRC, 'S', TGT, 'T');
    expect(res.summary.Account.unconfirmed).toBe(2);
    expect(res.summary.Account.writeRefused).toBeUndefined();
    expect(res.errors.join('\n')).toMatch(/2 record\(s\) NOT CONFIRMED written/);
  });

  it('a Bulk job that throws SESSION_EXPIRED is never "not written" — the job may have written before the poll failed', async () => {
    globalThis.sfBulkIngest = async () => { throw new Error('SESSION_EXPIRED'); };
    globalThis.sfCollectionsCreate = async () => { throw new Error('collections not expected'); };
    const res = await eng.executeProfileTransfer(PROFILE({ apiMode: 'bulk' }), SRC, 'S', TGT, 'T');
    const s = res.summary.Account;
    expect(s.unconfirmed).toBe(3);
    expect(s.writeError).toBe('SESSION_EXPIRED');
    expect(s.writeRefused).toBeUndefined();
    expect(res.errors.join('\n')).toMatch(/may or may not be in the target/);
  });

  it('a run with no thrown call carries neither field', async () => {
    globalThis.sfCollectionsCreate = async (o, s, chunk) => chunk.map(() => ({ success: true, id: 'T' }));
    const res = await eng.executeProfileTransfer(PROFILE(), SRC, 'S', TGT, 'T');
    expect(res.summary.Account.created).toBe(3);
    expect('writeError' in res.summary.Account).toBe(false);
    expect('writeRefused' in res.summary.Account).toBe(false);
  });
});

describe('📎 the files-pass note counts only the records it looked up', () => {
  beforeEach(engineSetup);
  afterEach(() => { for (const k of KEYS) delete globalThis[k]; });

  it('a record left out (validation refusal) is not reported again as "with no target match"', async () => {
    TGT_ACCOUNTS = [{ Id: 'T-CA', Name: 'Carol' }];
    globalThis.sfCollectionsCreate = async (o, s, chunk) => chunk.map(r =>
      r.Name === 'John Smith' ? { success: false, errors: [{ statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Phone is required' }] }
        : r.Name === 'Carol' ? { success: false, errors: [{ statusCode: 'DUPLICATE_VALUE', message: 'duplicate value found' }] }
          : { success: true, id: 'T-AC' });
    const p = PROFILE(); p.tree.includeFiles = true;
    const res = await eng.executeProfileTransfer(p, SRC, 'S', TGT, 'T');
    const lines = [...(res.errors || []), ...(res.diagnostics || [])].join('\n');
    expect(lines).toMatch(/1 record\(s\) not written by this run were left out of the files pass/);
    expect(lines).toMatch(/1 already-in-target record\(s\) matched by Name for the files pass\./);
    expect(lines).not.toMatch(/with no target match/);
    expect(filesIdMap).toEqual({ A1: 'T-AC', A3: 'T-CA' });
    // only the leftover's key was asked of the target
    expect(tgtKeyQueries.join('\n')).toContain("'Carol'");
    expect(tgtKeyQueries.join('\n')).not.toContain('John Smith');
  });

  it('a left-out record whose Name is on several target rows is not reported as ambiguous either', async () => {
    TGT_ACCOUNTS = [{ Id: 'T-CA', Name: 'Carol' }, { Id: 'T-J1', Name: 'John Smith' }, { Id: 'T-J2', Name: 'John Smith' }];
    globalThis.sfCollectionsCreate = async (o, s, chunk) => chunk.map(r =>
      r.Name === 'John Smith' ? { success: false, errors: [{ statusCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing' }] }
        : r.Name === 'Carol' ? { success: false, errors: [{ statusCode: 'DUPLICATES_DETECTED', message: 'Use one of these records?' }] }
          : { success: true, id: 'T-AC' });
    const p = PROFILE(); p.tree.includeFiles = true;
    const res = await eng.executeProfileTransfer(p, SRC, 'S', TGT, 'T');
    const lines = [...(res.errors || []), ...(res.diagnostics || [])].join('\n');
    expect(lines).not.toMatch(/ambiguous/);
    expect(lines).not.toMatch(/with no target match/);
    expect(filesIdMap).toEqual({ A1: 'T-AC', A3: 'T-CA' });
  });

  it('a true leftover that has no target row is still counted as unmatched', async () => {
    TGT_ACCOUNTS = [];
    globalThis.sfCollectionsCreate = async (o, s, chunk) => chunk.map(r =>
      r.Name === 'Carol' ? { success: false, errors: [{ statusCode: 'DUPLICATE_VALUE', message: 'duplicate value found' }] } : { success: true, id: 'T-' + r.Name });
    const p = PROFILE(); p.tree.includeFiles = true;
    const res = await eng.executeProfileTransfer(p, SRC, 'S', TGT, 'T');
    const lines = [...(res.errors || []), ...(res.diagnostics || [])].join('\n');
    expect(lines).toMatch(/0 already-in-target record\(s\) matched by Name for the files pass · 1 with no target match/);
  });
});

// ── 6 · Bulk result files after JobComplete ──────────────────────────────
describe('sfBulkIngest reads each result file twice at most, and an unreadable one never aborts the job', () => {
  const makeBulk = (plan) => {
    const calls = [];
    const sfFetchWithProxy = async (orgUrl, sid, url, opts) => {
      const method = (opts && opts.method) || 'GET';
      calls.push({ method, url, body: opts && opts.body });
      if (method === 'POST') return { ok: true, status: 200, body: JSON.stringify({ id: '750J' }) };
      if (method === 'PUT') return { ok: true, status: 201, body: '' };
      if (method === 'PATCH') return { ok: true, status: 200, body: '{}' };
      if (/successfulResults/.test(url)) return plan.ok(calls.filter(c => /successfulResults/.test(c.url)).length);
      if (/failedResults/.test(url)) return plan.bad(calls.filter(c => /failedResults/.test(c.url)).length);
      return { ok: true, status: 200, body: JSON.stringify({ state: 'JobComplete', numberRecordsProcessed: 2, numberRecordsFailed: 0 }) };
    };
    const names = ['sfBulkIngest', 'sftkRecordsToCsv', 'sftkCsvField', 'sftkParseCsv', 'sftkBulkCompletedResults',
      'sftkCorrelateBulkResults', 'sftkBulkKeyNorm', 'sftkIsUnconfirmed', 'sftkUnconfirmedRows', 'sfErrorMsg'];
    const fns = new Function('sfFetchWithProxy', 'setTimeout', `
      const API_VERSION = 'v62.0'; let _runCancelled = false;
      ${names.map(sliceFn).join('\n')}
      return { sfBulkIngest, sftkIsUnconfirmed };
    `)(sfFetchWithProxy, (fn) => { fn(); return 0; });
    return { ...fns, calls };
  };
  const ROWS = [{ Name: 'A' }, { Name: 'B' }];
  const OK_CSV = '"sf__Id","sf__Created","Name"\n"001A","true","A"\n"001B","true","B"\n';
  const EMPTY_BAD = '"sf__Id","sf__Error","Name"\n';
  const run = (B) => B.sfBulkIngest('https://t', 'T', { objectType: 'Account', operation: 'insert', records: ROWS });
  const reads = (B, what) => B.calls.filter(c => c.method === 'GET' && c.url.includes(what)).length;
  const aborts = (B) => B.calls.filter(c => c.method === 'PATCH' && /"Aborted"/.test(c.body || '')).length;

  it('a success file that fails once and then reads: every row is written, with its id', async () => {
    const B = makeBulk({
      ok: (n) => { if (n === 1) throw new Error('Request timed out after 30 s'); return { ok: true, status: 200, body: OK_CSV }; },
      bad: () => ({ ok: true, status: 200, body: EMPTY_BAD }),
    });
    const out = await run(B);
    expect(out.map(r => [r.success, r.id])).toEqual([[true, '001A'], [true, '001B']]);
    expect(reads(B, 'successfulResults')).toBe(2);
    expect(reads(B, 'failedResults')).toBe(1);
    expect(aborts(B)).toBe(0);
  });

  it('an HTTP error answer (not a throw) is retried the same way', async () => {
    const B = makeBulk({
      ok: (n) => (n === 1 ? { ok: false, status: 500, body: 'oops' } : { ok: true, status: 200, body: OK_CSV }),
      bad: () => ({ ok: true, status: 200, body: EMPTY_BAD }),
    });
    const out = await run(B);
    expect(out.every(r => r.success)).toBe(true);
    expect(reads(B, 'successfulResults')).toBe(2);
  });

  it('a success file that fails twice: the rows are UNCONFIRMED, nothing throws, and the finished job is not aborted', async () => {
    const B = makeBulk({
      ok: () => { throw new Error('SESSION_EXPIRED'); },
      bad: () => ({ ok: true, status: 200, body: EMPTY_BAD }),
    });
    const out = await run(B);
    expect(out).toHaveLength(2);
    expect(out.every(r => r.success === false && B.sftkIsUnconfirmed(r))).toBe(true);
    expect(reads(B, 'successfulResults')).toBe(2);        // twice, not more
    expect(aborts(B)).toBe(0);
  });

  it('both files unreadable: still UNCONFIRMED rows, two reads each, no abort', async () => {
    const B = makeBulk({ ok: () => ({ ok: false, status: 503, body: '' }), bad: () => { throw new Error('net'); } });
    const out = await run(B);
    expect(out.every(r => B.sftkIsUnconfirmed(r))).toBe(true);
    expect(reads(B, 'successfulResults')).toBe(2);
    expect(reads(B, 'failedResults')).toBe(2);
    expect(aborts(B)).toBe(0);
  });

  it('a job Salesforce marks Failed does throw, and the job is aborted on the org', async () => {
    const B = makeBulk({ ok: () => ({ ok: true, status: 200, body: OK_CSV }), bad: () => ({ ok: true, status: 200, body: EMPTY_BAD }) });
    // re-plan the poll: the generic GET answers JobComplete, so drive a Failed job through a fresh harness
    const calls = B.calls;
    const failing = new Function('sfFetchWithProxy', 'setTimeout', `
      const API_VERSION = 'v62.0'; let _runCancelled = false;
      ${['sfBulkIngest', 'sftkRecordsToCsv', 'sftkCsvField', 'sfErrorMsg'].map(sliceFn).join('\n')}
      return sfBulkIngest;
    `)(async (o, s, url, opts) => {
      const method = (opts && opts.method) || 'GET';
      calls.push({ method, url, body: opts && opts.body });
      if (method === 'POST') return { ok: true, status: 200, body: JSON.stringify({ id: '750J' }) };
      if (method === 'GET') return { ok: true, status: 200, body: JSON.stringify({ state: 'Failed', errorMessage: 'InvalidBatch : Field name not found : Foo__c' }) };
      return { ok: true, status: 200, body: '{}' };
    }, (fn) => { fn(); return 0; });
    await expect(failing('https://t', 'T', { objectType: 'Account', records: ROWS })).rejects.toThrow(/Bulk job Failed: InvalidBatch/);
    expect(calls.filter(c => c.method === 'PATCH' && /"Aborted"/.test(c.body || '')).length).toBe(1);
  });
});
