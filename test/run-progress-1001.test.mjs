// Live run view (sftk-run-progress.js) — campaign 4 phase 1.
// User 2026-10-01: "see them run live like in inspector" / "add a percentage
// bar" / "with time estimation?". The reducer and the formatter are pure, so
// they are driven here with a scripted event sequence and a fake clock; the
// wiring test checks every page that runs the engine uses the shared handler.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const SRC = read('sftk-run-progress.js');
const api = new Function(`${SRC}\nreturn { sftkRunProgressNewState, sftkRunProgressReduce, sftkRunProgressCardText, sftkRunFmtDur };`)();

const T0 = 1_000_000;
const drive = (events) => {
  const st = api.sftkRunProgressNewState(T0);
  const out = [];
  for (const [dt, evt] of events) out.push(api.sftkRunProgressReduce(st, evt, T0 + dt));
  return { st, out };
};

describe('Collections run: a card with a percentage bar, rate and time left', () => {
  const { st, out } = drive([
    [0,      { phase: 'start' }],
    [100,    { phase: 'node', obj: 'Account' }],
    [2_000,  { phase: 'fetched', obj: 'Account', count: 5000 }],
    [12_000, { phase: 'batch', obj: 'Account', done: 1000, total: 5000, created: 980, failed: 20 }],
  ]);
  const card = st.cards.get('0_Account');
  it('one card per object, batch size learned from the first batch', () => {
    expect(st.cards.size).toBe(1);
    expect(card.batchSize).toBe(1000);
    expect(out[3].card).toBe(card);
  });
  it('percentage, failure segment, created/failed, batch n of N', () => {
    const t = api.sftkRunProgressCardText(card, T0 + 12_000);
    expect(t.pct).toBe(20);
    expect(t.failPct).toBe(0);        // 20 of 5,000 rounds to 0 % — never wider than pct
    expect(t.numsText).toBe('1,000 / 5,000 written · 980 created · 20 failed');
    expect(t.stateText).toBe('writing · batch 1 of 5');
  });
  it('elapsed from the first write, records per second, and an estimate of what is left', () => {
    const t = api.sftkRunProgressCardText(card, T0 + 12_000);
    // 1,000 records in 10 s = 100/s → 4,000 left ≈ 40 s
    expect(t.timeText).toBe('0:10 · 100/s · ~0:40 left');
  });
  it('the clock keeps moving between events, the estimate shrinks', () => {
    const t = api.sftkRunProgressCardText(card, T0 + 22_000);
    expect(t.timeText.startsWith('0:20 · 50/s')).toBe(true);
  });
  it('finishes when done reaches total — green, no estimate, failures said', () => {
    api.sftkRunProgressReduce(st, { phase: 'batch', obj: 'Account', done: 5000, total: 5000, created: 4950, failed: 50 }, T0 + 52_000);
    const t = api.sftkRunProgressCardText(card, T0 + 60_000);
    expect(card.finished).toBe(true);
    expect(t.icon).toBe('⚠');
    expect(t.stateText).toBe('written, 50 failed');
    expect(t.pct).toBe(100);
    expect(t.timeText).toBe('0:50 · 100/s');
    expect(t.alive).toBe(false);
  });
});

describe('Bulk API 2.0 job: state, progress from the poll, and a liveness clock', () => {
  const { st } = drive([
    [0,      { phase: 'fetched', obj: 'Account', count: 5000 }],
    [3_000,  { phase: 'bulk', obj: 'Account', objType: 'Account', state: 'InProgress', processed: 0, failed: 0, total: 5000 }],
    [33_000, { phase: 'bulk', obj: 'Account', objType: 'Account', state: 'InProgress', processed: 2000, failed: 10, total: 5000 }],
  ]);
  const card = st.cards.get('0_Account');
  it('the bulk poll lands on the SAME card the fetched event opened', () => {
    expect(st.cards.size).toBe(1);
    expect(card.mode).toBe('bulk');
    expect(card.done).toBe(2000);
  });
  it('says how long since Salesforce last answered, so coarse progress reads alive', () => {
    expect(api.sftkRunProgressCardText(card, T0 + 33_500).stateText).toBe('Bulk write job: InProgress · Salesforce last answered just now');
    expect(api.sftkRunProgressCardText(card, T0 + 41_000).stateText).toBe('Bulk write job: InProgress · Salesforce last answered 8s ago');
  });
  it('percentage and estimate from the processed count', () => {
    const t = api.sftkRunProgressCardText(card, T0 + 33_000);
    expect(t.pct).toBe(40);
    expect(t.numsText).toBe('2,000 / 5,000 written · 1,990 created · 10 failed');
    expect(t.timeText).toMatch(/^0:33 · \d+(\.\d)?\/s · ~\d+:\d\d left$/);
  });
  it('JobComplete closes the card', () => {
    api.sftkRunProgressReduce(st, { phase: 'bulk', obj: 'Account', state: 'JobComplete', processed: 5000, failed: 10, total: 5000 }, T0 + 80_000);
    const t = api.sftkRunProgressCardText(card, T0 + 90_000);
    expect(card.finished).toBe(true);
    expect(t.stateText).toBe('Bulk write job complete');
    expect(t.icon).toBe('⚠');
  });
});

describe('the rest of the engine events', () => {
  it('errs: failures red, engine notes grey (the ℹ contract)', () => {
    const { out } = drive([[0, { phase: 'errs', obj: 'Account', lines: ['Account: DUPLICATES_DETECTED (×3)', 'ℹ Account: 10 Person Account(s) — only the name parts were sent'], more: 2 }]]);
    expect(out[0].errs.map(e => e.note)).toEqual([false, true]);
    expect(out[0].more).toBe(2);
  });
  it('step opens a step row and later cards key on the step', () => {
    const { st, out } = drive([[0, { phase: 'step', index: 1, total: 3, name: 'Leads' }], [10, { phase: 'node', obj: 'Lead' }]]);
    expect(out[0].step).toEqual({ index: 1, total: 3, name: 'Leads' });
    expect([...st.cards.keys()]).toEqual(['2_Lead']);
  });
  it('end freezes every card; hb and start change nothing', () => {
    const { st, out } = drive([[0, { phase: 'node', obj: 'Account' }], [5, { phase: 'hb' }], [9, { phase: 'end' }]]);
    expect(out[1]).toBeNull();
    expect(out[2]).toEqual({ ended: true });
    expect(st.cards.get('0_Account').finished).toBe(true);
  });
  it('a 🧹 rollback object (fetched + batch) renders like any write', () => {
    const { st } = drive([[0, { phase: 'fetched', obj: '🧹 Account', count: 6 }], [500, { phase: 'batch', obj: '🧹 Account', done: 6, total: 6, created: 6, failed: 0 }]]);
    const c = [...st.cards.values()][0];
    expect(c.finished).toBe(true);
    expect(api.sftkRunProgressCardText(c, T0 + 1000).numsText).toBe('6 / 6 written · 6 created');
  });
  it('durations read as m:ss and h:mm:ss', () => {
    expect(api.sftkRunFmtDur(42_000)).toBe('0:42');
    expect(api.sftkRunFmtDur(4_205_000)).toBe('1:10:05');
  });
});

describe('a repaint mid-run does not freeze the view (user 2026-10-01: a tab switch stopped the counter)', () => {
  it('runReconcile flags itself active and remembers its log node; the Deploy page puts that node back', () => {
    const RC = read('studio-reconcile.js'), DV = read('studio-deploy.js');
    expect(RC).toContain('window._sftkRunActive = true;');
    expect(RC).toContain('window._sftkRunLogNode = prog;');
    expect((RC.match(/window\._sftkRunActive = false;/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(DV).toContain("const liveLog = window._sftkRunActive ? (window._sftkRunLogNode || eid('dsRecProgress')) : null;");
    expect(DV).toContain("if (liveLog) { const slot = eid('dsRecProgress'); if (slot && slot !== liveLog) slot.replaceWith(liveLog); }");
  });
  it('the handler keeps folding events while its node is detached and repaints on reconnect', () => {
    expect(SRC).toContain("if (!logEl.isConnected) { pendingRepaint = true; start(); return; }");
    expect(SRC).toContain("if (!logEl.isConnected) { pendingRepaint = true; return; }");
    expect(SRC).not.toContain("if (!evt || !logEl || !logEl.isConnected) return;");
  });
  it('no records-per-second before two seconds have passed', () => {
    const { st } = drive([[0, { phase: 'fetched', obj: 'Account', count: 5000 }], [10, { phase: 'batch', obj: 'Account', done: 2071, total: 5000, created: 2071, failed: 0 }]]);
    const t = api.sftkRunProgressCardText(st.cards.get('0_Account'), T0 + 10);
    expect(t.timeText).toBe('0:00');
  });
});

describe('wiring: every page that runs the engine uses the shared live view', () => {
  it('studio.html loads the module before the pages', () => {
    const html = read('studio.html');
    const at = f => html.indexOf(`<script src="${f}"></script>`);
    expect(at('sftk-run-progress.js')).toBeGreaterThan(0);
    expect(at('sftk-run-progress.js')).toBeLessThan(at('studio-core.js'));
  });
  it('Deploy, Transfer, Sequences and the Seeder wire sftkRunProgressHandler; the private handlers are gone', () => {
    expect(read('studio-reconcile.js')).toContain('_openRunPort(sftkRunProgressHandler(prog))');
    expect(read('studio-transfer.js')).toContain("_openRunPort(sftkRunProgressHandler(eid('dsTrProgLog')))");
    expect(read('studio-profiles.js')).toContain("_openRunPort(sftkRunProgressHandler(eid('dsSeqRunLog')))");
    expect(read('studio-seed.js')).toContain('_openRunPort(sftkRunProgressHandler(liveEl))');
    expect(read('studio-transfer.js')).not.toContain('function _trRenderBulkRow(');
    expect(read('studio-transfer.js')).not.toContain('function _trProgressHandler(');
    expect(read('studio-scan.js')).not.toContain('function _runProgressHandler(');
  });
  it('the painter keeps the dsRunLive_<step>_<obj> id scheme the Deploy page relies on for "Last run on this page"', () => {
    expect(SRC).toContain('const id = `dsRunLive_${c.key}`;');
    expect(SRC).toContain('class="ds-prog-bar" role="progressbar"');
  });
});
