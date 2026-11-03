// 🧪 DRY RUN (1.1, 2026-11-04) — what the pages show for it.
//
// The live run view's card walks built → checking (round n) → the verdict;
// the Deploy page offers the button next to ▶ Deploy and runs runReconcile in
// probe mode (no flow / rule pause); History gives the entry its own card with
// no Retry, no Continue and no Roll back — it wrote nothing.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const SRC = read('sftk-run-progress.js');
const api = new Function(`${SRC}\nreturn { sftkRunProgressNewState, sftkRunProgressReduce, sftkRunProgressCardText };`)();

const T0 = 1_000_000;
const drive = (events) => {
  const st = api.sftkRunProgressNewState(T0);
  const out = [];
  for (const [dt, evt] of events) out.push(api.sftkRunProgressReduce(st, evt, T0 + dt));
  return { st, out };
};

describe('the live card of a dry run', () => {
  it('built, not written: the card stays open after the last batch and says what it is doing', () => {
    const { st } = drive([
      [0,     { phase: 'start' }],
      [100,   { phase: 'node', obj: 'Account' }],
      [2_000, { phase: 'fetched', obj: 'Account', count: 200, probe: true, sampledOf: 1250 }],
      [3_000, { phase: 'batch', obj: 'Account', done: 200, total: 200, created: 200, failed: 0, probe: true }],
    ]);
    const c = st.cards.get('0_Account');
    expect(c.probe).toBe(true);
    expect(c.finished).toBe(false);
    const t = api.sftkRunProgressCardText(c, T0 + 4_000);
    expect(t.icon).toBe('🧪');
    expect(t.stateText).toBe('built — waiting for the transaction');
    expect(t.numsText).toBe('200 / 200 built · a sample of 1,250');
    expect(t.alive).toBe(true);
  });
  it('a round: every object in the transaction says Salesforce is checking', () => {
    const { st, out } = drive([
      [0,     { phase: 'fetched', obj: 'Account', count: 3, probe: true }],
      [10,    { phase: 'batch', obj: 'Account', done: 3, total: 3, created: 3, failed: 0, probe: true }],
      [20,    { phase: 'fetched', obj: 'Contact', count: 5, probe: true }],
      [30,    { phase: 'batch', obj: 'Contact', done: 5, total: 5, created: 5, failed: 0, probe: true }],
      [1_000, { phase: 'probe', round: 2, subs: [{ obj: 'Account', n: 3 }, { obj: 'Contact', n: 4 }] }],
    ]);
    expect(out[4].cards.map(c => c.obj)).toEqual(['Account', 'Contact']);
    const t = api.sftkRunProgressCardText(st.cards.get('0_Contact'), T0 + 2_000);
    expect(t.stateText).toBe('dry run · round 2: Salesforce is checking…');
    expect(t.numsText).toBe('5 record(s) in the transaction');
  });
  it('the verdict closes the card: green when every record would be written', () => {
    const { st } = drive([
      [0,   { phase: 'fetched', obj: 'Account', count: 3, probe: true }],
      [10,  { phase: 'batch', obj: 'Account', done: 3, total: 3, created: 3, failed: 0, probe: true }],
      [500, { phase: 'probeDone', obj: 'Account', probed: 3, wouldWrite: 3, refused: 0, cascade: 0, unreached: 0, sampledOf: 0 }],
    ]);
    const c = st.cards.get('0_Account');
    expect(c.finished).toBe(true);
    const t = api.sftkRunProgressCardText(c, T0 + 600);
    expect(t.icon).toBe('✅');
    expect(t.stateText).toBe('dry run: every record would be written');
    expect(t.numsText).toBe('3 checked · 3 would be written');
    expect(t.pct).toBe(100); expect(t.failPct).toBe(0); expect(t.alive).toBe(false);
  });
  it('the verdict with refusals and a cascade: the failure segment is the part that would not be written', () => {
    const { st } = drive([
      [0,   { phase: 'fetched', obj: 'Contact', count: 10, probe: true }],
      [500, { phase: 'probeDone', obj: 'Contact', probed: 10, wouldWrite: 6, refused: 3, cascade: 1, unreached: 0, sampledOf: 0 }],
    ]);
    const t = api.sftkRunProgressCardText(st.cards.get('0_Contact'), T0 + 600);
    expect(t.icon).toBe('⚠');
    expect(t.stateText).toBe('dry run: 3 would be refused');
    expect(t.numsText).toBe('10 checked · 6 would be written · 3 refused · 1 not checked (parent refused)');
    expect(t.failPct).toBe(40);
  });
  it('a real run is untouched: the batch event without the probe flag still closes the card', () => {
    const { st } = drive([
      [0,  { phase: 'fetched', obj: 'Account', count: 3 }],
      [10, { phase: 'batch', obj: 'Account', done: 3, total: 3, created: 3, failed: 0 }],
    ]);
    const c = st.cards.get('0_Account');
    expect(c.probe).toBeUndefined();
    expect(c.finished).toBe(true);
    expect(api.sftkRunProgressCardText(c, T0 + 20).stateText).toBe('written');
  });
});

describe('the pages', () => {
  const DEPLOY = read('studio-deploy.js'), REC = read('studio-reconcile.js'), HIST = read('studio-history.js'), ENG = read('background.js');
  it('the Deploy page offers 🧪 Dry run next to ▶ Deploy, enabled with it, and runs runReconcile in probe mode without the pause wrappers', () => {
    expect(DEPLOY).toMatch(/id="dsRecProbeBtn" disabled title="A real write that Salesforce rolls back/);
    expect(DEPLOY).toContain(`eid('dsRecProbeBtn')?.addEventListener('click', () => runReconcile(p, objType,`);
    expect(DEPLOY).toContain("{ probe: true }));");
    expect(DEPLOY).toContain("const probe = eid('dsRecProbeBtn'); if (probe) probe.disabled = !s.total;");
  });
  it('runReconcile in probe mode: its own dialog, no restore point, no delete / overwrite / relink / pull, inserts flagged for the engine, no rescan', () => {
    expect(REC).toContain("const PROBE = !!(opts && opts.probe === true);");
    expect(REC).toContain("title: '🧪 Dry run — a real write that Salesforce rolls back',");
    expect(REC).toContain("const undoStub = PROBE ? { objects: [] } : await sftkUndoCaptureForRun(");
    expect(REC).toContain("for (const a of (PROBE ? [] : childActs)) {\n    if (!a.delIds.length) continue;");
    expect(REC).toContain("if (!PROBE && delIds.length) {");
    expect(REC).toContain("if (!PROBE && pullIds.length) {");
    expect(REC).toContain("for (const a of (PROBE ? [] : childActs)) {\n    if (!a.sel.relink.size) continue;");
    expect(REC).toContain("for (const a of (PROBE ? [] : childActs)) {\n    if (!a.ovwIds.length) continue;");
    expect(REC).toContain("if (!PROBE && ovwIds.length) {");
    expect(REC).toContain("if (!PROBE && updSrcIds.length) {");
    expect(REC).toContain("if (PROBE) pushProfile.probe = true;");
    expect(REC).toContain("if (PROBE) bProfile.probe = true;");
    expect(REC).toContain("kind:         PROBE ? 'dryrun' : 'reconcile',");
    expect(REC).toContain("...(PROBE ? {} : { undo: { ...undoStub, ...runEnd, runEndByOrg } }),");
    // the selections stay and nothing is re-scanned: the dry run returns before the refresh
    expect(REC).toMatch(/if \(PROBE\) \{[\s\S]*?renderReconcile\(\);\n    return;\n  \}\n  log\(stoppedWhy \? '⏸' : '✅'/);
  });
  it('History: a dry run entry has its chip and sentence, and offers neither Retry nor Continue nor Roll back', () => {
    expect(HIST).toContain("🧪 dry run — nothing written");
    expect(HIST).toContain("return `Dry run into ${tgt}: ${did}. Nothing was written.`;");
    expect(HIST).toContain("const retryable  = totalFailed > 0 && profExists && !isProbe;");
    expect(HIST).toContain("run.stopped && run.selected && profExists && !isProbe ?");
    expect(HIST).toContain("const isRecRun   = run.kind === 'reconcile' || isProbe;");
    // the undo state function hides the button for a run without a stub whose kind is not 'reconcile'
    const UNDO = read('sftk-undo.js');
    expect(UNDO).toContain("&& (run.kind === undefined || run.kind === 'reconcile'));");
  });
  it('the engine: a dry run never calls a write helper and never pauses on the write chokepoint it bypassed', () => {
    expect(ENG).toContain("const PROBE = !!(profile && profile.probe === true);");
    expect(ENG).toContain("const API_MODE   = (profile && profile.probe === true) ? 'sync' :");
    expect(ENG).toContain("if (!PROBE && node.includeFiles === true && recs.length) {");
    expect(ENG).toContain("if (lateItems.length && !_runCancelled && !PROBE) {");
    expect(ENG).toContain("if (!PROBE) try {");
    // the poison is an Account with no Name: a valid body that always fails
    expect(ENG).toMatch(/url: `\/services\/data\/\$\{apiVersion\}\/sobjects\/Account`, referenceId: 'poison', body: sftkProbePoison\(\)/);
  });
});
