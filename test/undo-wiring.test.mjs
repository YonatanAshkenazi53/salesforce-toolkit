// ↩ ROLLBACK WIRING (user 2026-08-26: "rollback feature for data deployment
// … might help us with production issues"). The pure core is tested in
// undo-rollback.test.mjs; this file pins the WIRING laws: the restore point
// is read BEFORE the first write on every write path, the History card says
// exactly what it can roll back, and the rollback itself never hard-deletes
// and never claims success without a verification read.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src  = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const code = s => s.replace(/^\s*\/\/.*$/gm, '');
const TR = code(src('studio-transfer.js'));
const RC = code(src('studio-reconcile.js'));
const PR = code(src('studio-profiles.js') + '\n' + src('studio-sequences.js'));   // Sequences live in studio-sequences.js since 2026-10-03 (cut from the public build)
const UN = src('studio-undo.js');
const HI = code(src('studio-history.js'));
const CO = code(src('studio-core.js'));
const HTML = src('studio.html');

// a appears, b appears, and a comes FIRST.
const before = (s, a, b) => {
  const i = s.indexOf(a), j = s.indexOf(b);
  expect(i, `missing: ${a}`).toBeGreaterThan(-1);
  expect(j, `missing: ${b}`).toBeGreaterThan(-1);
  expect(i, `${a} must come before ${b}`).toBeLessThan(j);
};

describe('scripts load in an order the calls can survive', () => {
  it('sftk-undo.js (pure) before studio-core.js; studio-undo.js after studio-history.js', () => {
    before(HTML, '<script src="sftk-undo.js">', '<script src="studio-core.js">');
    before(HTML, '<script src="studio-history.js">', '<script src="studio-undo.js">');
  });
});

describe('the restore point is read BEFORE the first write, on every path', () => {
  it('Run Transfer — after the gates, before the engine call, keyed to the History entry', () => {
    const fn = TR.slice(TR.indexOf('async function runTransfer()'), TR.indexOf('function sftkFanoutTargetAdvice'));
    before(fn, '_trBigRunConfirmed = false;', 'sftkUndoCaptureForRun(');
    before(fn, 'sftkUndoCaptureForRun(', "type:             'SF_EXECUTE_PROFILE_TRANSFER'");
    expect(fn).toContain('id:        runId,');
    expect(fn).toMatch(/undo: \{ \.\.\.undoStub, \.\.\.runEnd \}/);
    // the end-of-run boundary comes from Salesforce's clock, not the PC's
    expect(fn).toMatch(/const runEnd = await sftkUndoRunEnd\(_transferTgt\.orgUrl, _transferTgt\.sid, undoStub\.objects\)/);
    // a run that died with {error} is still recorded with its restore point
    const errBranch = fn.slice(fn.indexOf('if (result.error) {'), fn.indexOf('// Log per-object results'));
    expect(errBranch).toMatch(/status: 'failed', summary: \{\}, errors: \[String\(result\.error\)\]/);
    expect(errBranch).toMatch(/undo: \{ \.\.\.undoStub, \.\.\.runEnd \}/);
  });

  it('Transfer — after every confirmation, before phase 0; the source too when the run writes there', () => {
    const fn = RC.slice(RC.indexOf('async function runReconcile('), RC.indexOf('async function reconcileStampPairs'));
    // Campaign 3 phase 2: the Proceed dialog + the production typed-name step
    // both moved onto sftkConfirmDestructive (sftk-confirm.js) — still before the capture.
    before(fn, 'sftkConfirmDestructive(', 'sftkUndoCaptureForRun(');
    before(fn, 'sftkUndoCaptureForRun(', "'SF_HARD_DELETE'");
    expect(fn).toMatch(/if \(pullIds\.length \|\| updSrcIds\.length\) undoLegs\.push/);
    expect(fn).toContain("sftkUndoTreeObjects(profile.tree, 'reconcile')");
    expect(fn).toContain('id:           runId,');
    // the reconcile entry also carries one boundary PER ORG (target + source)
    expect(fn).toMatch(/undo: \{ \.\.\.undoStub, \.\.\.runEnd, runEndByOrg \}/);
  });

  it('sequences — one image for the whole chain, stamped on every step entry', () => {
    const fn = PR.slice(PR.indexOf('async function runSequence('));   // runSequence is the last function of studio-sequences.js
    before(fn, 'sftkUndoCaptureForRun(', "type:      'SF_EXECUTE_SEQUENCE'");
    expect(fn).toContain("scope: 'sequence'");
    expect(fn).toContain('sftkUndoMergeObjects(');
    expect(fn).toMatch(/undo: \{ \.\.\.seqUndoStub, \.\.\.seqEnd \}/);
    // ✋ a cancel during the restore point stops the sequence before the engine starts
    before(fn, 'let seqCancelled = false;', 'sftkUndoCaptureForRun(');
    before(fn, 'sftkUndoCaptureForRun(', 'if (seqCancelled) {');
    before(fn, 'if (seqCancelled) {', "type:      'SF_EXECUTE_SEQUENCE'");
    expect(fn).toContain('Cancelled before any write');
  });

  it('the toggle is a setting — default ON — with a visible switch and an honest off-state', () => {
    expect(CO).toContain('undoCapture: true');
    expect(TR).toContain('id="dsTrUndoCapture"');
    expect(TR).toContain('can NOT be rolled back');
    expect(UN).toContain('_settings?.undoCapture === false');
    expect(UN).toContain('switched off');
  });
});

describe('the capture never lies about coverage', () => {
  it('refuses an incomplete read and an over-cap object PER OBJECT, and says so in the run log', () => {
    expect(UN).toContain('res?.incomplete');
    expect(UN).toContain('above the');
    expect(UN).toMatch(/will NOT be rollback-able/);
  });

  it('quotes each read before it starts', () => {
    expect(UN).toMatch(/Restore point: reading .*API call\(s\)/);
  });

  it('keeps the evidence in IndexedDB, never in chrome.storage', () => {
    expect(UN).toContain("indexedDB.open('sftk_undo'");
    expect(UN).not.toMatch(/chrome\.storage\.local\.set\(\{\s*sftk_undo/);
  });

  it('prunes to the newest runs and marks the dropped ones EXPIRED on their cards', () => {
    expect(UN).toContain('sftkUndoPrune(meta, sftkUndoMaxRuns())');
    expect(UN).toMatch(/h\.undo\.status = 'expired'/);
  });
});

describe('the rollback keeps the laws', () => {
  // Campaign 4 phase 7: the modal flow became two DOM-free functions the
  // ↩ Roll back page drives — the planner and the executor (studio-undo.js).
  const fn = UN.slice(UN.indexOf('async function sftkUndoBuildPlan('));

  it('never hard-deletes — Recycle Bin only', () => {
    expect(fn).toContain("'SF_COLLECTIONS_DELETE'");
    expect(UN).not.toContain('SF_HARD_DELETE');
  });

  it('shows the plan, the automation that can reject it, and the limits BEFORE the typed confirmation', () => {
    // the automation is checked in the planner, before the executor can write anything
    before(fn, 'sftkUndoAutomationSummary(', 'async function sftkUndoExecute(');
    expect(UN).toContain('sftkUndoLimits()');
    expect(UN).toContain('Could not check');
    expect(fn).not.toContain("'ROLLBACK'");  // owner 2026-10-13: no typed word outside production
    expect(fn).toMatch(/prod \? orgLabel\(/);
  });

  it('a refused re-read blocks that object — never acted on a partial picture', () => {
    expect(fn).toContain('refused');
    expect(fn).toMatch(/res\?\.incomplete/);
  });

  it('leaves later work by others alone, with the counts shown', () => {
    expect(fn).toContain('sftkUndoScopeByTime(');
    expect(fn).toMatch(/left alone/);
  });

  it('a clean automation ✅ is only printed when EVERY category was checked', () => {
    expect(UN).toContain('(every category was checked)');
    expect(UN).toMatch(/a\.unknown\.length\s*\?\s*`<div>❔ Nothing blocking was found in the categories that COULD be checked/);
  });

  it('refused reads never read as "matches the restore point"', () => {
    expect(UN).toContain('Nothing could be rolled back');
    expect(UN).toMatch(/if \(refused\.length\) \{/);   // the verdict helper: refused → 'Nothing could be rolled back', never 'matches'
    expect(UN).toContain('every object that was read matches the restore point');
  });

  it('a count failure refuses the object — same rule as the capture side', () => {
    expect(fn).toMatch(/if \(n === null\) \{[\s\S]*?refused: `count failed/);
  });

  it('an org whose type cannot be confirmed gets the production-grade word', () => {
    expect(fn).toMatch(/else if \(t !== 'sandbox' && t !== 'dev'\) \{ prod = true; prodUnknown\.push/);
  });

  it('looks under the records it would delete and KEEPS parents of later children', () => {
    before(fn, 'sftkUndoCascadeChildren(', 'async function sftkUndoExecute(');
    expect(fn).toMatch(/if \(item\.cascadeUnknown\.length\) \{ for \(const id of createdSet\) kept\.add\(id\); \}/);
    expect(fn).toMatch(/scoped\.created = scoped\.created\.filter\(id => !kept\.has\(id\)\)/);
  });

  it('matches flows by object LABEL and the verify pass judges the acted-on records by identity', () => {
    expect(fn).toContain('sftkUndoAutomationSummary(results, objs, labels)');
    expect(fn).toMatch(/const acted = new Set\(\[\.\.\.w\.created, \.\.\.w\.changed\.map\(c => c\.id\)\]\)/);   // exactly what THIS execution acted on
    expect(fn).toContain('sftkUndoVerifyCounts(d2, acted)');
    expect(fn).toMatch(/Verifying \$\{item\.objType\}: re-reading/);
  });

  it('a second click while one is in flight is refused; archived cards are persisted back to the archive', () => {
    expect(UN).toContain('let _sftkUndoBusy = null;');
    expect(fn).toMatch(/if \(_sftkUndoBusy\) \{ showToast/);
    expect(UN).toMatch(/function _sftkUndoAllEntries\(\)/);
    expect(UN).toMatch(/sftkArchPut\(arch\)/);
  });

  it('the guard is a token held only while writes are in flight; the planner stops at any point the page no longer wants it', () => {
    // token: an abandoned flow that wakes up later cannot release a newer flow's guard
    expect(fn).toMatch(/const token = \+\+_sftkUndoSeq;\s*_sftkUndoBusy = token;/);
    expect(fn).toMatch(/finally \{\s*window\._sftkModalLock = false;\s*if \(_sftkUndoBusy === token\) _sftkUndoBusy = null;/);
    // the planner (reads only) checks io.alive() between every org round-trip and returns null — nothing is written
    expect((fn.match(/if \(!alive\(\)\) return null;/g) || []).length).toBeGreaterThanOrEqual(4);
    // during execution the modal lock is on (the shared dialog cannot be closed over a running rollback)
    expect(fn).toContain('window._sftkModalLock = true;');
    expect(CO).toMatch(/function closeModal\(\) \{[\s\S]{0,200}if \(window\._sftkModalLock\) return;/);
  });

  it('the end-of-run boundary is PER ORG \u2014 a leg never borrows another org\u2019s', () => {
    const RC2 = code(src('studio-reconcile.js'));
    expect(RC2).toMatch(/runEndByOrg\[srcSess\.orgUrl\] = await sftkUndoRunEnd\(srcSess\.orgUrl, srcSess\.sid, \[objType\]\)/);
    expect(RC2).toMatch(/undo: \{ \.\.\.undoStub, \.\.\.runEnd, runEndByOrg \}/);
    expect(fn).toMatch(/const endFor = \(evOrgUrl\) => \{/);
    expect(fn).toMatch(/return \{ at: null, source: null \};/);
    expect(fn).toContain('sftkUndoScopeByTime(diff, nowRows, legEnd)');
    expect(UN).toContain('No end-of-run time is recorded for this org');
  });

  it('a failed describe fails CLOSED on the cascade check \u2014 every created parent is kept', () => {
    expect(fn).toMatch(/const cascadeKnown = !!\(desc && Array\.isArray\(desc\.childRelationships\)\)/);
    expect(fn).toMatch(/if \(scoped\.created\.length && !cascadeKnown\) \{[\s\S]{0,300}item\.kept = scoped\.created\.length;\s*item\.keptIds = scoped\.created\.slice\(\);\s*scoped\.created = \[\];/);
    expect(fn).toContain('could not be described in');
    // and the plan says the real reason, not "children were added"
    expect(UN).toContain('item.cascadeUnknown.push(`${o.objType} could not be described`)');   // the page says 'kept — could not check what hangs under it (…)' from this
    // (old plan-dialog pin retired: the reason now rides the kept record's row on the rollback page)
    void (0 && /if \(it\.cascadeUnknown && it\.cascadeUnknown\.length\) \{\s*bits\.push\(`<span style="color:#92400e"><strong>\$\{it\.kept\.toLocaleString\(\)\}<\/strong> kept \u2014 could not check/);
  });

  it('writes go in 200-record slices, each contained; a slice with no answer is UNCONFIRMED, not refused', () => {
    expect(fn).toContain('const SLICE = 200;');
    expect(fn).toMatch(/for \(let i = 0; i < w\.created\.length; i \+= SLICE\)/);
    expect(fn).toMatch(/for \(let i = 0; i < payload\.length; i \+= SLICE\)/);
    expect(fn).toMatch(/r\.deleteFailed \+= slice\.length; r\.unconfirmed \+= slice\.length;/);
    expect(fn).toContain('outcome unconfirmed');
    expect(fn).not.toMatch(/ids: item\.scoped\.created \}/);
  });

  it('records the RUN\u2019s deletions as still gone and never folds them into "verified"', () => {
    expect(fn).toMatch(/r\.stillGone = \(d2\.deleted \|\| \[\]\)\.length;/);
    expect(fn).toContain('sftkUndoVerifyLine(item.objType, r.remaining, r.leftAlone, r.stillGone, r.goneHard)');
    expect(fn).toContain('everything it acted on is verified');
    expect(HI).toContain('still gone');
  });

  it('a failure half-way still gets a History entry', () => {
    expect(fn).toMatch(/catch \(e\) \{[\s\S]{0,400}record\(results, errors, 'failed', startedAt\)/);
  });

  it('refused deletes are tagged as deletes for the card and the audit CSV', () => {
    expect(fn).toContain("op: 'delete'");
    expect(fn).toContain("op: 'restore'");
    expect(HI).toContain("fr && fr.op ? `failed-${fr.op}` : 'failed-update'");
  });

  it('keeps one result object per leg AND object — a refused second leg can never vanish into success', () => {
    // Transfer pull / ← update captures the same root object in the target AND the source.
    expect(fn).toMatch(/it\.key = multiLeg \? `\$\{it\.objType\} @ \$\{orgLabel\(it\.leg\.orgUrl\)\}` : it\.objType/);
    expect(fn).toContain('const key = item.key;');
    expect(fn).toMatch(/const r = results\[key\] \|\| \(results\[key\] = \{/);
    expect(fn).not.toMatch(/results\[item\.objType\] = results\[item\.objType\] \|\| r/);
  });

  it('deletes children before parents', () => {
    expect(fn).toMatch(/sort\(\(a, b\) => \(b\.depth \|\| 0\) - \(a\.depth \|\| 0\)\)/);
  });

  it('re-reads to VERIFY, records its own History entry, and only a verified success closes the card', () => {
    before(fn, "'SF_COLLECTIONS_UPDATE'", 'sftkUndoVerifyLine(');
    expect(fn).toContain("kind: 'rollback'");
    expect(fn).toContain('sftkUndoRunStatus(results)');
    expect(fn).toMatch(/if \(status === 'success'\) \{ h\.undo\.rolledBackAt = now/);
    expect(fn).toMatch(/else \{ h\.undo\.lastRollbackStatus = status/);
  });
});

describe('History shows it', () => {
  it('the card renders the button from ONE state function and routes through dsaction', () => {
    expect(HI).toContain('sftkUndoCardState(run)');
    expect(HI).toContain('data-dsaction="rollbackRun"');
    expect(CO).toMatch(/case 'rollbackRun':\s*window\.rollbackRun\?\.\(arg\)/);
  });

  it('a rollback entry is chipped, says "restored" not "updated", and shows its verification state', () => {
    expect(HI).toContain('↩ rollback');
    expect(HI).toContain("isRollback ? 'restored' : 'updated'");
    expect(HI).toContain('still differ');
    expect(HI).toContain('unverified');
  });

  it('a rollback entry never offers ↻ Run again', () => {
    expect(HI).toMatch(/profExists && !isRecRun && !isRollback \?/);
  });

  it('clearing cached data, clearing history and retention all remove restore points', () => {
    expect((HI.match(/sftkUndoStoreClear\(\)/g) || []).length).toBe(2);
    expect(CO).toMatch(/sftkUndoStoreDeleteOlderThan\(new Date\(cutoff\)\.toISOString\(\)\)/);
  });
});
