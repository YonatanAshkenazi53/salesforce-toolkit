// A run the network stops — 2026-11-15.
//
// Live check (scripts/dev/live/dryrun-netdrop.mjs): a Data Deployment dry run with the network dropped ~10 s. The
// History entry told the truth ("0 of 13 would be written, 13 not reached"); the page did not:
//   (a) the chip next to ▶ Deploy read "🧪 dry run: 0 would be refused"
//   (b) "Account: 0 of 5 would be written, 5 not reached" and "Case: 0 of 0 would be written" wore a green check
//   (c) the reason was the browser's raw "Failed to fetch"
//   (d) two object cards stayed on "reading records… 0:00" after the run was over
// and the same for a real deploy: "Transfer complete" in green, a half-written card that read "written".
// Every test here RUNS the real function; none asserts on source text.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
// the friendly classifier and the live view in ONE scope, the way studio.html loads them
const view = new Function('document', `${read('sftk-friendly-error.js')}\n${read('sftk-run-progress.js')}
return { sftkFriendlyError, sftkNetworkWords, sftkIsNetworkError, sftkRunProgressNewState, sftkRunProgressReduce, sftkRunProgressCardText, sftkRunProgressHandler, sftkRunProgressClose };`);
const api = view(null);
const { sftkProbeLine, sftkProbeVerdict, sftkRunEndLine } = extractFunctions('studio-reconcile.js', ['sftkProbeLine', 'sftkProbeVerdict', 'sftkRunEndLine']);
const { sftkProbeHint } = extractFunctions('studio-deploy.js', ['sftkProbeHint']);

const T0 = 1_000_000;
const drive = (events) => {
  const st = api.sftkRunProgressNewState(T0);
  for (const [dt, evt] of events) api.sftkRunProgressReduce(st, evt, T0 + dt);
  return st;
};
const text = (st, key, dt) => api.sftkRunProgressCardText(st.cards.get(key), T0 + dt);

// ═══ (a) the chip next to ▶ Deploy ═════════════════════════════════════════
describe('(a) the action-bar chip after a dry run', () => {
  const stopped = { status: 'failed', incomplete: true, net: true, totals: { probed: 13, would: 0, refused: 0, cascade: 0, unreached: 13 } };
  it('a dry run the network stopped says it stopped and how many records were not reached', () => {
    const h = sftkProbeHint(stopped);
    expect(h.text).toBe('🧪 dry run stopped before it finished — 13 records not reached');
    expect(h.text).not.toMatch(/0 would be refused/);
    expect(h.cls).toBe('ds-rec-tag-fail');
    expect(h.title).toMatch(/connection to Salesforce dropped/);
    expect(h.title).toMatch(/Nothing was written/);
  });
  it('records not reached make it "stopped" even without the flag (the rounds ran out), and refusals ride along', () => {
    const h = sftkProbeHint({ status: 'partial', totals: { probed: 2400, would: 1000, refused: 2, cascade: 0, unreached: 1398 } });
    expect(h.text).toBe('🧪 dry run stopped before it finished — 1,398 records not reached, 2 would be refused');
    expect(h.title).not.toMatch(/connection/);
  });
  it('a call that threw before any record was checked: "no record was checked", never a count of refusals', () => {
    expect(sftkProbeHint({ status: 'failed', incomplete: true, totals: { probed: 0, would: 0, refused: 0, cascade: 0, unreached: 0 } }).text)
      .toBe('🧪 dry run stopped before it finished — no record was checked');
    expect(sftkProbeHint({ status: 'failed', totals: { probed: 0, would: 0, refused: 0, cascade: 0, unreached: 0 } }).text)
      .toBe('🧪 dry run: no record was checked');
    expect(sftkProbeHint({ status: 'partial', incomplete: true, totals: { probed: 5, would: 5, refused: 0, cascade: 0, unreached: 0 } }).text)
      .toBe('🧪 dry run stopped before it finished — not every record was checked');
  });
  it('a stopped dry run is never "passed", whatever its status says', () => {
    expect(sftkProbeHint({ status: 'success', incomplete: true, totals: { probed: 3, would: 3 } }).text).toMatch(/stopped before it finished/);
  });
  it('the finished verdicts read as before: passed, and refused with the count', () => {
    expect(sftkProbeHint({ status: 'success', totals: { probed: 3, would: 3, refused: 0, cascade: 0, unreached: 0 } }))
      .toMatchObject({ cls: 'ds-rec-tag-ins', text: '🧪 dry run passed — every record would be written' });
    expect(sftkProbeHint({ status: 'partial', totals: { probed: 9, would: 4, refused: 2, cascade: 3, unreached: 0 } }).text)
      .toBe('🧪 dry run: 2 would be refused, 3 not checked');
    expect(sftkProbeHint(null)).toBe(null);
  });
});

// ═══ (b) the run-log lines ═════════════════════════════════════════════════
describe('(b) a 🧪 result line is green only when every record would be written', () => {
  it('records not reached: a warning, not a green check', () => {
    const l = sftkProbeLine('Account', { probed: 5, wouldWrite: 0, refused: 0, cascade: 0, unreached: 5 }, 5);
    expect(l).toEqual({ icon: '⚠', cls: 'ds-prog-warn', text: 'Account: 0 of 5 would be written, 5 not reached' });
  });
  it('"0 of 0" for an object that had records selected: none was checked — said so, as a warning', () => {
    expect(sftkProbeLine('Case', {}, undefined)).toEqual({ icon: '⚠', cls: 'ds-prog-warn', text: 'Case: no record was checked' });
    expect(sftkProbeLine('Case', { probed: 0, wouldWrite: 0 }, 4)).toEqual({ icon: '⚠', cls: 'ds-prog-warn', text: 'Case: no record was checked' });
    expect(sftkProbeLine('Case', undefined, 4).icon).toBe('⚠');
  });
  it('"0 of 0" for an object with NO insert selected is a plain note — neither green nor a warning', () => {
    expect(sftkProbeLine('Account', { probed: 0 }, 0)).toEqual({ icon: 'ℹ', cls: 'ds-prog-note', text: 'Account: no insert selected — nothing to check' });
  });
  it('refused is an error line; not-checked (parent refused / an earlier step) is a warning', () => {
    expect(sftkProbeLine('Contact', { probed: 4, wouldWrite: 2, refused: 2 })).toMatchObject({ icon: '⚠', cls: 'ds-prog-err', text: 'Contact: 2 of 4 would be written, 2 refused' });
    expect(sftkProbeLine('Contact', { probed: 4, wouldWrite: 1, cascade: 3 })).toMatchObject({ icon: '⚠', cls: 'ds-prog-warn' });
    expect(sftkProbeLine('Contact', { probed: 4, wouldWrite: 3, earlier: 1 })).toMatchObject({ icon: '⚠', cls: 'ds-prog-warn' });
  });
  it('every record would be written: the green check, with en-US numbers and the sample', () => {
    expect(sftkProbeLine('Account', { probed: 1200, wouldWrite: 1200, sampledOf: 5000 }, 5000))
      .toEqual({ icon: '✅', cls: '', text: 'Account: 1,200 of 1,200 would be written — a sample: the first 1,200 of 5,000' });
  });
});

describe('(a/b) the verdict of the whole dry run', () => {
  const pt = { probed: 13, would: 0, refused: 0, cascade: 0, unreached: 13 };
  it('the live case: stopped, 13 not reached, and the connection named', () => {
    const v = sftkProbeVerdict(pt, { incomplete: true, net: true });
    expect(v.incomplete).toBe(true);
    expect(v.head).toBe('Dry run stopped before it finished');
    expect(v.verdict).toBe('0 of 13 would be written — 13 not reached');
    expect(v.why).toMatch(/connection to Salesforce dropped/);
  });
  it('records not reached alone make it "stopped" — never "Dry run complete"', () => {
    expect(sftkProbeVerdict(pt, {}).head).toBe('Dry run stopped before it finished');
  });
  it('a broken dry run that checked nothing does not say "no insert is selected"', () => {
    const v = sftkProbeVerdict({ probed: 0, would: 0, refused: 0, cascade: 0, unreached: 0 }, { incomplete: true });
    expect(v.verdict).toBe('no record was checked');
    expect(v.why).toMatch(/run it again/);
  });
  it('a broken dry run whose checked records all passed does not say "every one … would be written"', () => {
    const v = sftkProbeVerdict({ probed: 5, would: 5, refused: 0, cascade: 0, unreached: 0 }, { incomplete: true });
    expect(v.verdict).toBe('5 of the 5 record(s) checked would be written — the rest was not checked');
  });
  it('the finished verdicts are unchanged', () => {
    expect(sftkProbeVerdict({ probed: 1300, would: 1300, refused: 0, cascade: 0, unreached: 0 }, {}))
      .toEqual({ incomplete: false, head: 'Dry run complete', verdict: 'every one of the 1,300 record(s) would be written', why: '' });
    expect(sftkProbeVerdict({ probed: 9, would: 4, refused: 2, cascade: 3, unreached: 0 }, {}).verdict)
      .toBe('4 of 9 would be written — 2 refused, 3 not checked (their parent would be refused)');
    expect(sftkProbeVerdict({ probed: 0, would: 0 }, {}).verdict).toBe('nothing was checked — no insert is selected');
  });
});

// ═══ (c) the words for a dropped connection ════════════════════════════════
describe('(c) "Failed to fetch" is said in words, in the line\'s own context', () => {
  it('the engine\'s stop line keeps its context and loses the raw token', () => {
    expect(api.sftkNetworkWords('🧪 dry run stopped: Failed to fetch')).toBe('🧪 dry run stopped: the connection to Salesforce dropped');
    expect(api.sftkNetworkWords('Push failed: TypeError: Failed to fetch')).toBe('Push failed: the connection to Salesforce dropped');
    expect(api.sftkNetworkWords('Case: Failed to fetch')).toBe('Case: the connection to Salesforce dropped');
  });
  it('the other browsers\' wordings and Chrome\'s net:: codes', () => {
    expect(api.sftkNetworkWords('Account: NetworkError when attempting to fetch resource.')).toBe('Account: the connection to Salesforce dropped');
    expect(api.sftkNetworkWords('Account: net::ERR_INTERNET_DISCONNECTED')).toBe('Account: the connection to Salesforce dropped');
  });
  it('a note keeps its sentence: only the token changes', () => {
    expect(api.sftkNetworkWords('ℹ OpportunityLineItem.Product2Id: could not read Product2.Name in the source: Failed to fetch — those lookups are left empty.'))
      .toBe('ℹ OpportunityLineItem.Product2Id: could not read Product2.Name in the source: the connection to Salesforce dropped — those lookups are left empty.');
  });
  it('a line that is not a network failure comes back untouched', () => {
    const l = 'Account: Required fields are missing: [Name]';
    expect(api.sftkNetworkWords(l)).toBe(l);
    expect(api.sftkNetworkWords('')).toBe('');
    expect(api.sftkNetworkWords(null)).toBe('');
    expect(api.sftkIsNetworkError('insert: 🧪 dry run stopped: Failed to fetch')).toBe(true);
    expect(api.sftkIsNetworkError(l)).toBe(false);
  });
  it('it is the SAME reading as sftkFriendlyError\'s network mapping', () => {
    for (const l of ['Failed to fetch', 'x: net::ERR_NAME_NOT_RESOLVED', 'TotalRequests Limit exceeded', 'SESSION_EXPIRED']) {
      expect(api.sftkIsNetworkError(l)).toBe(api.sftkFriendlyError(l).type === 'network');
    }
  });
});

// ═══ (d) no card stays reading / running once the run is over ══════════════
describe('(d) the live cards when a run ends', () => {
  // the live shape: three objects built, two whose read threw when the network went, then the engine's end
  const netdrop = [
    [0,      { phase: 'start' }],
    [100,    { phase: 'node', obj: 'Account' }],
    [900,    { phase: 'fetched', obj: 'Account', count: 5, probe: true }],
    [1_000,  { phase: 'batch', obj: 'Account', done: 5, total: 5, created: 5, failed: 0, probe: true }],
    [3_000,  { phase: 'node', obj: 'Case' }],
    [3_010,  { phase: 'nodeError', obj: 'Case', message: 'Failed to fetch' }],
    [3_020,  { phase: 'node', obj: 'Asset' }],
    [13_000, { phase: 'probe', round: 1, subs: [{ obj: 'Account', n: 5 }] }],
    [13_100, { phase: 'probeDone', obj: 'Account', probed: 5, wouldWrite: 0, refused: 0, cascade: 0, unreached: 5, sampledOf: 0 }],
    [13_200, { phase: 'end' }],
  ];
  it('the object whose read threw says why, in words, and is closed', () => {
    const st = drive(netdrop);
    const t = text(st, '0_Case', 60_000);
    expect(t.icon).toBe('❌');
    expect(t.stateText).toBe('stopped: the connection to Salesforce dropped');
    expect(t.alive).toBe(false);
    expect(st.cards.get('0_Case').finished).toBe(true);
  });
  it('an object still reading when the run ends is closed, says no records were read, and its clock stops', () => {
    const st = drive(netdrop);
    const t1 = text(st, '0_Asset', 20_000), t2 = text(st, '0_Asset', 500_000);
    expect(t1.stateText).toBe('the run ended — no records were read');
    expect(t1.stateText).not.toMatch(/reading/);
    expect(t1.alive).toBe(false);
    expect(t2.timeText).toBe(t1.timeText);
    expect(t1.timeText).toBe('0:10');
  });
  it('after the end NO card is alive or reads "reading" / "checking" / "writing"', () => {
    const st = drive(netdrop);
    for (const c of st.cards.values()) {
      const t = api.sftkRunProgressCardText(c, T0 + 99_000);
      expect(c.finished).toBe(true);
      expect(t.alive).toBe(false);
      expect(t.stateText).not.toMatch(/reading records|is checking|writing|waiting for the transaction/);
    }
  });
  it('the object the dry run did not reach: a warning that names the count — not "5 checked · 5 not reached"', () => {
    const t = text(drive(netdrop), '0_Account', 20_000);
    expect(t.icon).toBe('⚠');
    expect(t.stateText).toBe('dry run stopped — 5 not reached');
    expect(t.numsText).toBe('5 in the dry run · 0 would be written · 5 not reached');
  });
  it('a dry-run card that never got its verdict (the engine ended first) is closed as stopped', () => {
    const st = drive([
      [0,     { phase: 'fetched', obj: 'Contact', count: 3, probe: true }],
      [10,    { phase: 'batch', obj: 'Contact', done: 3, total: 3, created: 3, failed: 0, probe: true }],
      [1_000, { phase: 'probe', round: 1, subs: [{ obj: 'Contact', n: 3 }] }],
      [5_000, { phase: 'end' }],
    ]);
    const t = text(st, '0_Contact', 9_000);
    expect(t).toMatchObject({ icon: '⚠', stateText: 'dry run stopped — not checked', numsText: '3 record(s) not reached', alive: false });
  });
  it('a REAL deploy: a card the run ends on part-way is never "written"', () => {
    const st = drive([
      [0,     { phase: 'node', obj: 'Account' }],
      [500,   { phase: 'fetched', obj: 'Account', count: 600 }],
      [2_000, { phase: 'batch', obj: 'Account', done: 200, total: 600, created: 200, failed: 0 }],
      [9_000, { phase: 'end' }],
    ]);
    const t = text(st, '0_Account', 30_000);
    expect(t.icon).toBe('⚠');
    expect(t.stateText).toBe('stopped before every record was written');
    expect(t.numsText).toBe('200 / 600 written · 200 created');
    expect(t.alive).toBe(false);
    expect(t.timeText).not.toMatch(/left/);
  });
  it('a REAL deploy: the write that threw says so; a card that finished its write stays "written"', () => {
    const st = drive([
      [0,     { phase: 'fetched', obj: 'Account', count: 2 }],
      [100,   { phase: 'batch', obj: 'Account', done: 2, total: 2, created: 2, failed: 0 }],
      [200,   { phase: 'fetched', obj: 'Contact', count: 400 }],
      [300,   { phase: 'nodeError', obj: 'Contact', message: 'TypeError: Failed to fetch' }],
      [400,   { phase: 'end' }],
    ]);
    expect(text(st, '0_Account', 900)).toMatchObject({ icon: '✅', stateText: 'written' });
    expect(text(st, '0_Contact', 900)).toMatchObject({ icon: '❌', stateText: 'stopped: the connection to Salesforce dropped', alive: false });
  });
  it('fetched with nothing written yet, then the end: "stopped — nothing was written", not "fetched — writing…"', () => {
    const st = drive([[0, { phase: 'fetched', obj: 'Account', count: 40 }], [100, { phase: 'end' }]]);
    expect(text(st, '0_Account', 900)).toMatchObject({ icon: '⚠', stateText: 'stopped — nothing was written', alive: false });
  });
  it('a Bulk job still running when the run ends reports its last state as not confirmed', () => {
    const st = drive([
      [0,     { phase: 'bulk', obj: 'Account', state: 'InProgress', processed: 1000, total: 5000, failed: 0 }],
      [9_000, { phase: 'end' }],
    ]);
    const t = text(st, '0_Account', 90_000);
    expect(t.icon).toBe('⚠');
    expect(t.stateText).toBe('Bulk write job: InProgress when the run ended — not confirmed complete');
    expect(t.stateText).not.toMatch(/last answered/);
  });
  it('a run that completes is untouched: written, verdict, and nothing-to-write stay as they were', () => {
    const st = drive([
      [0,   { phase: 'fetched', obj: 'Account', count: 2 }],
      [100, { phase: 'batch', obj: 'Account', done: 2, total: 2, created: 2, failed: 0 }],
      [200, { phase: 'fetched', obj: 'Contact', count: 0 }],
      [300, { phase: 'end' }],
    ]);
    expect(text(st, '0_Account', 900)).toMatchObject({ icon: '✅', stateText: 'written' });
    expect(text(st, '0_Contact', 900)).toMatchObject({ icon: '✅', stateText: 'nothing to write' });
    expect(st.cards.get('0_Account').endedOpen).toBeFalsy();
  });
  it('one page run, several engine calls: the next call\'s start reopens the view and an object read again is open again', () => {
    const st = drive([
      [0,     { phase: 'start' }],
      [100,   { phase: 'node', obj: 'Contact' }],
      [200,   { phase: 'end' }],
      [300,   { phase: 'start' }],
      [400,   { phase: 'node', obj: 'Contact' }],
    ]);
    expect(st.ended).toBe(false);
    const c = st.cards.get('0_Contact');
    expect(c.finished).toBe(false);
    expect(api.sftkRunProgressCardText(c, T0 + 2_400)).toMatchObject({ stateText: 'reading records…', timeText: '0:02', alive: true });
  });
});

// the painter, on a stand-in for the log node: the page's own "the run is over" closes what is on screen
describe('(d) the page closes the live view itself — the engine\'s end may never arrive', () => {
  const fakeEl = () => {
    const el = { id: '', className: '', textContent: '', style: {}, children: [], _q: {}, isConnected: true, scrollTop: 0, scrollHeight: 0,
      classList: { toggle() {} }, setAttribute() {},
      appendChild(ch) { el.children.push(ch); return ch; },
      querySelector(sel) { return sel[0] === '#' ? (el.children.find(ch => ch.id === sel.slice(1)) || null) : (el._q[sel] || null); },
      set innerHTML(v) { for (const m of String(v).matchAll(/class="([\w-]+)"/g)) el._q[`.${m[1]}`] = fakeEl(); },
    };
    return el;
  };
  const rowText = (log, id) => { const r = log.children.find(ch => ch.id === id); return { state: r._q['.ds-prog-card-state'].textContent, icon: r._q['.ds-prog-card-icon'].textContent }; };
  it('cards on "reading records…" and "writing" are repainted as stopped when the page ends the run', () => {
    const papi = view({ createElement: fakeEl });
    const log = fakeEl();
    const h = papi.sftkRunProgressHandler(log);
    const realSetInterval = globalThis.setInterval, realClear = globalThis.clearInterval;
    globalThis.setInterval = () => 1; globalThis.clearInterval = () => {};
    try {
      h({ phase: 'start' });
      h({ phase: 'node', obj: 'Case' });
      h({ phase: 'node', obj: 'Asset' });
      h({ phase: 'fetched', obj: 'Asset', count: 30 });
      expect(rowText(log, 'dsRunLive_0_Case').state).toBe('reading records…');
      expect(rowText(log, 'dsRunLive_0_Asset').state).toBe('fetched — writing…');
      // no 'end' from the engine (the worker died) — the page says the run is over
      papi.sftkRunProgressClose(log);
      expect(rowText(log, 'dsRunLive_0_Case')).toEqual({ state: 'the run ended — no records were read', icon: '➖' });
      expect(rowText(log, 'dsRunLive_0_Asset')).toEqual({ state: 'stopped — nothing was written', icon: '⚠' });
      // closing twice, or a node that never had a view, is harmless
      papi.sftkRunProgressClose(log);
      papi.sftkRunProgressClose(fakeEl());
      papi.sftkRunProgressClose(null);
      expect(rowText(log, 'dsRunLive_0_Case').state).toBe('the run ended — no records were read');
    } finally { globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClear; }
  });
});

// ═══ a real DEPLOY the network stops ═══════════════════════════════════════
describe('the last line of a real run', () => {
  it('a run the network stopped never says "Transfer complete", and points at History, Roll back and Continue', () => {
    const l = sftkRunEndLine({ status: 'partial', stoppedWhy: 'network', net: true, ok: 1200, fail: 0, unconfirmed: 200, canUndo: true, canContinue: true });
    expect(l.icon).toBe('⚠');
    expect(l.cls).toBe('ds-prog-warn');
    expect(l.text).toBe('Stopped — the connection to Salesforce dropped: 1,200 record(s) written, 200 not confirmed written (they may or may not be in the target). '
      + 'History has this run with its restore point — ↩ Roll back there takes back what it wrote. '
      + 'Once the connection is back, ▶ Continue from History re-ticks the records this run did not reach.');
    expect(l.text).not.toMatch(/Transfer complete/);
  });
  it('nothing written: an error line that says so; Roll back is offered only when the restore point is usable', () => {
    const l = sftkRunEndLine({ status: 'failed', stoppedWhy: 'network', net: true, ok: 0, fail: 0, unconfirmed: 0, canUndo: false, canContinue: false });
    expect(l.icon).toBe('❌');
    expect(l.cls).toBe('ds-prog-err');
    expect(l.text).toBe('Stopped — the connection to Salesforce dropped: nothing was confirmed written. History has this run. '
      + 'Once the connection is back, scan again — records that were not written stay listed to deploy.');
    expect(l.text).not.toMatch(/Roll back|Continue/);
  });
  it('records written without a usable restore point: no Roll back promise — check the target', () => {
    const l = sftkRunEndLine({ status: 'partial', net: true, ok: 5, fail: 0, unconfirmed: 0, canUndo: false, canContinue: true });
    expect(l.text).toMatch(/it has no usable restore point, so check the target org for what was written/);
    expect(l.text).not.toMatch(/↩ Roll back/);
  });
  it('a run that failed without the network: not "complete", no connection claim, no Continue claim', () => {
    const l = sftkRunEndLine({ status: 'failed', ok: 0, fail: 3, unconfirmed: 0, canUndo: true, canContinue: true });
    expect(l.text).toBe('The run did not complete: nothing was confirmed written, 3 failed. History has this run with its restore point — ↩ Roll back there takes back what it wrote.');
    expect(sftkRunEndLine({ status: 'partial', ok: 7, fail: 1, canUndo: true }).text).toMatch(/^Finished with errors: 7 record\(s\) written, 1 failed\./);
  });
  it('the endings that were true stay word for word', () => {
    expect(sftkRunEndLine({ status: 'success', ok: 9 })).toEqual({ icon: '✅', cls: '', text: 'Transfer complete — refreshing state…' });
    expect(sftkRunEndLine({ status: 'partial', stoppedWhy: 'pause' }).text).toBe('Paused — the records not reached are still to deploy; ▶ Continue from History.');
    expect(sftkRunEndLine({ status: 'partial', stoppedWhy: 'closed' }).text).toBe('Stopped — the page was closed mid-run; ▶ Continue from History.');
    expect(sftkRunEndLine({ status: 'partial', stoppedWhy: 'cancel' })).toEqual({ icon: '⏸', cls: '', text: 'Cancelled — refreshing state…' });
  });
});
