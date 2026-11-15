// 2026-11-15 — CLOSE-OUT REVIEW, round 1, of the uncommitted regress-1115 fixes: six findings, each reproduced by a
// second reader before it was fixed. Every case here RUNS the real function; where the behaviour lives inside a
// page-bound function (runReconcile, the engine's write loop) the pure helper it calls is run and the wiring is
// pinned as text next to it, as the other regress-1115 files do.
//   A. sweep: "/*" inside a string literal ('*/*') is no comment — the code that names the object is not cut out
//   B. sweep: a path the shared resolver can tell ($User.X, Owner.X, $Setup.Conf__c.X) is not kept as a blocker
//   C. Task / Event / Activity: one custom field — the sweep and every remover give the same answer
//   D. Lightning Pages: an app names a page by its FULL name (the Org Health card's rule)
//   E. live run card: records whose write call threw are never "written" with a green check
//   F. Deploy page: a stop holds for the whole run — no later leg or page-side write starts after Pause
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const NL = String.fromCharCode(10);

const S = extractFunctions('sftk-sweep.js', ['sftkSweepForms', 'sftkSweepHits', 'sftkSweepKindTable', 'sftkSweepSections', '_sftkSweepSectionAt',
  'sftkSweepKind', 'sftkSweepRun', 'sftkSweepJoinKind']);
const sweepHits = (obj, field, files) => S.sftkSweepRun(new Map(files.map(([p, ...lines]) => [p, lines.join(NL)])), S.sftkSweepForms(obj, field))
  .hits.map(h => ({ component: h.component, text: h.text, type: h.type, sev: h.sev, join: S.sftkSweepJoinKind(h.type), section: h.section }));
const one = (obj, field, file) => { const h = sweepHits(obj, field, [file]); expect(h.length).toBe(1); return h[0]; };
const vr = (name, formula) => ['<validationRules>', `<fullName>${name}</fullName>`, '<active>true</active>', `<errorConditionFormula>${formula}</errorConditionFormula>`, '</validationRules>'];
const objFile = (obj, ...body) => [`unpackaged/objects/${obj}.object`, '<CustomObject>', ...body, '</CustomObject>'];
const DEMOTED = { type: 'SameNameOtherObject', sev: 'mention', join: null };

// ── A ────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('A. sweep: a "/*" inside a string literal does not start a comment', () => {
  const cls = (...lines) => ['unpackaged/classes/Sync.cls', 'public class Sync {', ...lines, '}'];
  it('the reported case: an Accept header \'*/*\' before the code that names Account, a doc comment after it', () => {
    const h = one('Account', 'Region__c', cls(
      "  void call() { HttpRequest r = new HttpRequest(); r.setHeader('Accept', '*/*'); }",
      "  void run() { for (Account a : [SELECT Id FROM Account]) { a.Region__c = 'x'; } }",
      '  /** done */'));
    expect(h).toMatchObject({ type: 'ApexClass', sev: 'blocker', join: 'ApexClass' });
  });
  it('the object named on ANOTHER line after the literal still counts (the file-level test)', () => {
    const h = one('Account', 'Region__c', cls(
      "  void call() { r.setHeader('Accept', '*/*'); }",
      '  List<Account> rows;',
      "  void run(SObject a) { a.Region__c = 'x'; }",
      '  /* end */'));
    expect(h.type).toBe('ApexClass');
  });
  it('a double-quoted literal and a "//" inside a string are no comment either', () => {
    const h = one('Account', 'Region__c', ['unpackaged/lwc/c/c.js',
      'const all = "*/*"; const sep = \'//\'; import ACCOUNT from "@salesforce/schema/Account";',
      'export const f = r => r.Region__c;',
      '/* end */']);
    expect(h.type).not.toBe('SameNameOtherObject');
  });
  it('the hit line itself naming the object is never "the code never names Account"', () => {
    // the only mention of Account sits on the hit line; an unclosed quote earlier must not hide it
    const h = one('Account', 'Region__c', cls(
      "  // it's a note with one apostrophe",
      "  void run() { for (Account a : rows) { a.Region__c = 'x'; } }"));
    expect(h.type).toBe('ApexClass');
  });
  it('a comment that names the object still does not count: block, line and doc comments', () => {
    const h = one('Account', 'Region__c', cls(
      '  // Account is not used here',
      '  /* Account */',
      '  /** @see Account */',
      "  void run(Contact a) { a.Region__c = 'x'; }"));
    expect(h).toMatchObject(DEMOTED);
    expect(h.section).toBe('the code never names Account');
  });
  it('a string that names the object does count (dynamic SOQL), a URL is not a comment', () => {
    const h = one('Account', 'Region__c', cls(
      "  String q = 'SELECT Id FROM Account'; String u = 'https://x.example/a';",
      "  void run(SObject a) { a.Region__c = 'x'; }"));
    expect(h.type).toBe('ApexClass');
  });
});

// ── B ────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B. sweep: a path the shared resolver can tell is another object’s field, not a blocker of ours', () => {
  const inContact = formula => one('Account', 'Region__c', objFile('Contact', ...vr('V', `${formula} = "x"`)));
  it.each(['$User.Region__c', 'Owner.Region__c', '$Setup.Conf__c.Region__c', '$Profile.Region__c', 'ReportsTo.Region__c', 'CreatedBy.Manager.Region__c'])(
    'the reported case: a Contact rule reading %s is demoted and does not join', path => {
      const h = inContact(path);
      expect(h).toMatchObject(DEMOTED);
      // the reason is true: not "Contact's own field" — the path leads to a third object
      expect(h.section).toBe('a field of this name on another object, not Account’s (the path leads elsewhere)');
    });
  it('a lookup filter’s <valueField>$User.Region__c</valueField> and a workflow rule formula are demoted the same way', () => {
    expect(one('Account', 'Region__c', objFile('Contact', '<fields>', '<fullName>Acc__c</fullName>', '<lookupFilter>', '<filterItems>', '<field>Account.Name</field>',
      '<valueField>$User.Region__c</valueField>', '</filterItems>', '</lookupFilter>', '</fields>'))).toMatchObject(DEMOTED);
    expect(one('Account', 'Region__c', ['unpackaged/workflows/Contact.workflow', '<Workflow>', '<rules>', '<fullName>R</fullName>', '<active>true</active>',
      '<formula>$User.Region__c = "x"</formula>', '</rules>', '</Workflow>'])).toMatchObject(DEMOTED);
  });
  it.each(['Account.Region__c', 'Account.Parent.Region__c', 'ReportsTo.Account.Region__c'])('a path that ENDS on our object keeps its kind and joins: %s', path => {
    expect(inContact(path)).toMatchObject({ type: 'ValidationRule', sev: 'blocker', join: 'ValidationRule' });
  });
  it.each(['Partner__r.Region__c', 'What.Region__c', '$Label.Region__c', 'Account.Partner__r.Region__c'])('a path that cannot be told is kept — the safe direction: %s', path => {
    expect(inContact(path).type).toBe('ValidationRule');
  });
  it('the same paths ARE ours when that object is the one picked', () => {
    expect(one('User', 'Region__c', objFile('Contact', ...vr('V', '$User.Region__c = "x"'))).type).toBe('ValidationRule');
    expect(one('User', 'Region__c', objFile('Contact', ...vr('V', 'Owner.Region__c = "x"'))).type).toBe('ValidationRule');
    expect(one('Conf__c', 'Region__c', objFile('Contact', ...vr('V', '$Setup.Conf__c.Region__c = "x"'))).type).toBe('ValidationRule');
  });
  it('the bare name keeps its own true reason', () => {
    const h = inContact('Region__c');
    expect(h).toMatchObject(DEMOTED);
    expect(h.section).toBe('Contact’s own field of this name');
  });
});

// ── C ────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('C. a custom field picked on Task is the one Activity field: the sweep and the removers agree', () => {
  const M = new Function(`${read('sftk-mdapi.js')}\nreturn { sftkMdEditField };`)();
  const rule = host => `<fullName>${host}.VR</fullName><active>true</active><errorConditionFormula>ISBLANK(Region__c) || ISBLANK(Subject)</errorConditionFormula><errorMessage>m</errorMessage>`;
  it.each(['Event', 'Activity', 'Task'])('the reported fixture: a %s rule is a blocker in the sweep AND is edited by ⇄ and ✂', host => {
    const h = one('Task', 'Region__c', objFile(host, ...vr('VR', 'ISBLANK(Region__c) || ISBLANK(Subject)')));
    expect(h).toMatchObject({ type: 'ValidationRule', sev: 'blocker', join: 'ValidationRule' });
    const rp = M.sftkMdEditField('ValidationRule', rule(host), 'Task', 'Region__c', 'Area__c');
    expect(rp.refused).toBeNull(); expect(rp.changed).toBe(true);
    expect(rp.xml).toContain('ISBLANK(Area__c) || ISBLANK(Subject)');
    const rm = M.sftkMdEditField('ValidationRule', rule(host), 'Task', 'Region__c', null);
    expect(String(rm.refused || '')).not.toMatch(/same-named field|nothing of this field to edit/);
    expect(rm.changed).toBe(true);
    expect(rm.xml).not.toContain('Region__c');
  });
  it('the error location and an approval process’s page field of the sibling follow', () => {
    const ed = '<fullName>Event.VR</fullName><active>true</active><errorConditionFormula>ISBLANK(Subject)</errorConditionFormula><errorDisplayField>Region__c</errorDisplayField><errorMessage>m</errorMessage>';
    const r = M.sftkMdEditField('ValidationRule', ed, 'Task', 'Region__c', 'Area__c');
    expect(r.refused).toBeNull();
    expect(r.xml).toContain('<errorDisplayField>Area__c</errorDisplayField>');
  });
  it('still one way for a STANDARD field, and never another object’s rule', () => {
    const std = '<fullName>Event.VR</fullName><active>true</active><errorConditionFormula>ISBLANK(Subject)</errorConditionFormula><errorMessage>m</errorMessage>';
    const r = M.sftkMdEditField('ValidationRule', std, 'Task', 'Subject', 'Topic');
    expect(r.changed).toBe(false); expect(r.xml).toBe(std);
    expect(r.refused).toMatch(/Event’s same-named field, not this one/);
    const c = M.sftkMdEditField('ValidationRule', rule('Contact'), 'Task', 'Region__c', 'Area__c');
    expect(c.changed).toBe(false); expect(c.xml).toBe(rule('Contact'));
    expect(c.refused).toMatch(/Contact’s same-named field, not this one/);
    // the sweep says the same of the Contact rule
    expect(one('Task', 'Region__c', objFile('Contact', ...vr('VR', 'ISBLANK(Region__c)')))).toMatchObject(DEMOTED);
  });
  it('what was right before stays: Activity picked edits a Task rule; Account picked refuses it', () => {
    expect(M.sftkMdEditField('ValidationRule', rule('Task'), 'Activity', 'Region__c', 'Area__c').changed).toBe(true);
    expect(M.sftkMdEditField('ValidationRule', rule('Task'), 'Account', 'Region__c', 'Area__c').changed).toBe(false);
  });

  // the page layout remover (field-cleaner.js), sliced out as fc-matrix-regressions-1114 does
  const FCJ = read('field-cleaner.js');
  const fcNested = name => { const at = FCJ.indexOf(`\n  function ${name}(`); if (at < 0) throw new Error(name); return FCJ.slice(at + 1, FCJ.indexOf('\n  }\n', at + 1) + 4); };
  const LY = new Function(`${fcNested('removeFieldFromLayout')}\nreturn { removeFieldFromLayout };`)();
  const lay = () => ({ layoutSections: [{ layoutColumns: [{ layoutItems: [{ field: 'Subject' }, { field: 'Region__c' }] }] }] });
  it('an Event-… layout is edited for Task.Region__c, not refused as "Event\'s field, not Task\'s"', () => {
    const md = lay(), opts = { objApi: 'Task', fullName: 'Event-Event Layout' };
    expect(LY.removeFieldFromLayout(md, 'Region__c', opts)).toBe(1);
    expect(opts.refused).toBeUndefined();
    const std = lay(), o2 = { objApi: 'Task', fullName: 'Event-Event Layout' };
    expect(LY.removeFieldFromLayout(std, 'Subject', o2)).toBe(0);
    expect(o2.refused).toMatch(/is Event's field, not Task's/);
    // no opts at all (the callers that pass none) still works
    expect(LY.removeFieldFromLayout(lay(), 'Region__c')).toBe(1);
  });
});

// ── D ────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('D. Lightning Pages: an app assignment names a page by its full name', () => {
  const { lpAppNamesPage } = extractFunctions('lightning-pages.js', ['lpPageIsPackaged', 'lpAppNamesPage']);
  const own = { Id: '1', DeveloperName: 'Account_Record_Page', Type: 'RecordPage', NamespacePrefix: null, ManageableState: 'unmanaged' };
  const pkg = { Id: '2', DeveloperName: 'Account_Record_Page', Type: 'RecordPage', NamespacePrefix: 'pkg', ManageableState: 'installed' };
  it('the reported case: the org’s own X is not assigned because an app names pkg__X', () => {
    expect(lpAppNamesPage(new Set(['pkg__account_record_page']), own, [own])).toBe(false);
    expect(lpAppNamesPage(new Set(['pkg__account_record_page']), own, [own, pkg])).toBe(false);
  });
  it('the mirror: an installed pkg page does not borrow the assignment of the org’s own X', () => {
    expect(lpAppNamesPage(new Set(['account_record_page']), pkg, [own, pkg])).toBe(false);
    expect(lpAppNamesPage(new Set(['account_record_page']), own, [own, pkg])).toBe(true);
  });
  it('each page by its own full name; a packaged page with no own twin also by the bare name', () => {
    expect(lpAppNamesPage(new Set(['pkg__account_record_page']), pkg, [own, pkg])).toBe(true);
    expect(lpAppNamesPage(new Set(['account_record_page']), pkg, [pkg])).toBe(true);
    expect(lpAppNamesPage(new Set(['other__account_record_page']), pkg, [pkg])).toBe(false);
  });
  it('a namespaced dev org: its own myns page is named myns__X or bare X; an installed twin does not block it', () => {
    const mine = { Id: '3', DeveloperName: 'Account_Record_Page', NamespacePrefix: 'myns', ManageableState: 'unmanaged' };
    expect(lpAppNamesPage(new Set(['myns__account_record_page']), mine, [mine, pkg])).toBe(true);
    expect(lpAppNamesPage(new Set(['account_record_page']), mine, [mine, pkg])).toBe(true);
    // …and the installed page does not take the bare name while the org has its own page of it
    expect(lpAppNamesPage(new Set(['account_record_page']), pkg, [mine, pkg])).toBe(false);
  });
  it('nothing named, no name: false', () => {
    expect(lpAppNamesPage(new Set(), own, [own])).toBe(false);
    expect(lpAppNamesPage(new Set(['x']), { DeveloperName: '' }, [])).toBe(false);
    expect(lpAppNamesPage(null, own, [own])).toBe(false);
  });
  it('pass 3 asks it with the page and every loaded page — the loose match is gone', () => {
    const LP = read('lightning-pages.js');
    expect(LP).toContain("if (lpAppNamesPage(viaApp, pg, allPages)) syncPageStatus(pg.Id, 'Active');");
    expect(LP).not.toContain("c.endsWith('__' + d)");
  });
});

// ── E ────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('E. live run card: records whose write call threw are not "written"', () => {
  const api = new Function('document', `${read('sftk-friendly-error.js')}\n${read('sftk-run-progress.js')}
return { sftkRunProgressNewState, sftkRunProgressReduce, sftkRunProgressCardText };`)(null);
  const run = events => {
    const st = api.sftkRunProgressNewState(1000);
    let t = 1000;
    for (const e of events) api.sftkRunProgressReduce(st, e, (t += 500));
    return [...st.cards.values()].map(c => api.sftkRunProgressCardText(c, t + 500));
  };
  const seq = batch => [{ phase: 'start' }, { phase: 'node', obj: 'Contact' }, { phase: 'fetched', obj: 'Contact', count: 150 }, { phase: 'batch', obj: 'Contact', ...batch }, { phase: 'end' }];
  it('the reported case: the object’s only call was refused (expired session) — no green check, no "written"', () => {
    const [c] = run(seq({ done: 150, total: 150, created: 0, failed: 0, unconfirmed: 150, refused: true }));
    expect(c.icon).toBe('⚠');
    expect(c.stateText).toBe('150 not written (the write call was refused)');
    expect(c.numsText).toBe('150 / 150 sent · 0 created · 150 not written (the write call was refused)');
    expect(`${c.stateText} ${c.numsText}`).not.toMatch(/\bwritten\b(?! \(the write call was refused\))/);
    expect(c.failPct).toBe(100);
    expect(c.alive).toBe(false);
  });
  it('a timeout / 5xx: not confirmed written', () => {
    const [c] = run(seq({ done: 150, total: 150, created: 0, failed: 0, unconfirmed: 150 }));
    expect(c.icon).toBe('⚠');
    expect(c.stateText).toBe('150 not confirmed written');
    expect(c.numsText).toBe('150 / 150 sent · 0 created · 150 not confirmed written');
  });
  it('the last chunk of several threw: what was created is said, with the rest and the failures', () => {
    const [c] = run(seq({ done: 1200, total: 1200, created: 990, failed: 10, unconfirmed: 200 }));
    expect(c.icon).toBe('⚠');
    expect(c.stateText).toBe('200 not confirmed written, 10 failed');
    expect(c.numsText).toBe('1,200 / 1,200 sent · 990 created · 10 failed · 200 not confirmed written');
    expect(c.failPct).toBe(18);
  });
  it('an answered object is as it was: written, green', () => {
    const [c] = run(seq({ done: 150, total: 150, created: 150, failed: 0 }));
    expect(c).toMatchObject({ icon: '✅', stateText: 'written', numsText: '150 / 150 written · 150 created', failPct: 0 });
  });
  it('the same object in a later engine call starts clean', () => {
    const [c] = run([...seq({ done: 150, total: 150, created: 0, failed: 0, unconfirmed: 150, refused: true }).slice(0, 4),
      { phase: 'node', obj: 'Contact' }, { phase: 'fetched', obj: 'Contact', count: 150 }, { phase: 'batch', obj: 'Contact', done: 150, total: 150, created: 150, failed: 0 }, { phase: 'end' }]);
    expect(c).toMatchObject({ icon: '✅', stateText: 'written' });
  });
  it('the engine sends the count with every batch event, and "refused" only when every one was refused', () => {
    const BG = read('background.js');
    expect(BG).toContain('...(unconfirmed ? { unconfirmed, refused: !!refusedN && refusedN === unconfirmed } : {}) });');
  });
});

// ── F ────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('F. Deploy page: a stop holds for the whole run', () => {
  const R = extractFunctions('studio-reconcile.js', ['sftkRecStopGate', 'sftkRecNotStartedLine', 'sftkRecMergeSelected', 'sftkRunEndLine']);
  const REC = read('studio-reconcile.js');
  const RUN = REC.slice(REC.indexOf('async function runReconcile('));
  it('the gate: the engine’s word for an earlier leg, else the page’s own Pause press, else go on', () => {
    expect(R.sftkRecStopGate('', false)).toBe('');
    expect(R.sftkRecStopGate('pause', false)).toBe('pause');
    expect(R.sftkRecStopGate('cancel', true)).toBe('cancel');
    expect(R.sftkRecStopGate('closed', false)).toBe('closed');
    // ⏸ pressed while no engine leg ran (the worker drops that message): the page holds it
    expect(R.sftkRecStopGate('', true)).toBe('pause');
  });
  // the gating as runReconcile wires it, driven over the reported run: 400 new Accounts, 50 Contacts under existing
  // parents, 30 drifted Accounts — Pause during the Account insert
  const drive = (steps, stopAfter, press) => {
    let stoppedWhy = '', pausePressed = false;
    const notStarted = [], ran = [];
    const halted = (what, insert) => { const w = R.sftkRecStopGate(stoppedWhy, pausePressed); if (!w) return false; stoppedWhy = w; notStarted.push({ what, insert: !!insert }); return true; };
    for (const s of steps) {
      if (halted(s.what, s.insert)) continue;
      ran.push(s.what);
      if (s.what === stopAfter) stoppedWhy = 'pause';       // the engine leg answered stopped: 'pause'
      if (s.what === press) pausePressed = true;            // ⏸ during a page-side step
    }
    return { ran, stoppedWhy, line: R.sftkRecNotStartedLine(stoppedWhy, notStarted) };
  };
  const STEPS = [{ what: 'the insert of 400 Account', insert: true }, { what: 'the insert of 50 Contact under existing parents', insert: true },
    { what: 'the relink of 5 Contact' }, { what: 'the update of 30 drifted Account in the target' }, { what: 'the update of 2 drifted Account in the source' }];
  it('the reported case: Pause during the root insert — nothing after it starts, and the line names every step', () => {
    const r = drive(STEPS, 'the insert of 400 Account');
    expect(r.ran).toEqual(['the insert of 400 Account']);
    expect(r.line).toBe('Not started — the run was paused before: the insert of 50 Contact under existing parents · the relink of 5 Contact · the update of 30 drifted Account in the target · the update of 2 drifted Account in the source. '
      + 'Nothing of these steps was written. ▶ Continue from History re-ticks the inserts only — tick the other steps again on the Deploy page.');
  });
  it('⏸ pressed during a page-side step (no engine leg to hear it) stops before the next step', () => {
    const r = drive(STEPS, null, 'the relink of 5 Contact');
    expect(r.ran).toEqual(STEPS.slice(0, 3).map(s => s.what));
    expect(r.stoppedWhy).toBe('pause');
    expect(R.sftkRunEndLine({ status: 'partial', stoppedWhy: r.stoppedWhy }).text).toMatch(/^Paused/);
  });
  it('no stop: every step runs and there is no line; a Pause after the last step skips nothing', () => {
    expect(drive(STEPS, null)).toEqual({ ran: STEPS.map(s => s.what), stoppedWhy: '', line: '' });
    expect(drive(STEPS, null, 'the update of 2 drifted Account in the source')).toMatchObject({ stoppedWhy: '', line: '' });
  });
  it('the line says only what History really offers', () => {
    expect(R.sftkRecNotStartedLine('pause', [{ what: 'the insert of 50 Contact under existing parents', insert: true }]))
      .toBe('Not started — the run was paused before: the insert of 50 Contact under existing parents. Nothing of these steps was written. ▶ Continue from History re-ticks them.');
    expect(R.sftkRecNotStartedLine('cancel', [{ what: 'the relink of 5 Contact' }])).toBe('Not started — the run was cancelled before: the relink of 5 Contact. Nothing of these steps was written.');
    expect(R.sftkRecNotStartedLine('pause', [])).toBe('');
  });
  it('the inserts under existing parents that never started are kept for ▶ Continue, once each', () => {
    expect(R.sftkRecMergeSelected({ '': ['a1'], 0: ['c1', 'c2'] }, { 0: ['c2', 'c3'], 1: ['d1'], 2: [] }))
      .toEqual({ '': ['a1'], 0: ['c1', 'c2', 'c3'], 1: ['d1'] });
    expect(R.sftkRecMergeSelected({ '': ['a1'] }, {})).toEqual({ '': ['a1'] });
  });
  it('runReconcile asks the gate before EVERY write step that has work, and the Pause click sets the page flag', () => {
    expect(RUN).toContain("pausePressed = true;   // holds between engine legs and during the page's own write steps");
    expect(RUN).toContain('const w = sftkRecStopGate(stoppedWhy, pausePressed);');
    const gates = [
      /if \(!a\.delIds\.length\) continue;\n    const obj = [^\n]+\n    if \(halted\(/,                       // 0 child deletes
      /stepDel: if \(!PROBE && delIds\.length\) \{\n    if \(halted\([^\n]+\) break stepDel;/,                  // 1 delete
      /stepPull: if \(!PROBE && pullIds\.length\) \{\n    if \(halted\([^\n]+\) break stepPull;/,               // 2 pull
      /stepPush: if \(!busyLine && \(treePushIds\.length \|\| groupATotal\)\) \{\n    if \(halted\([^\n]+, true\)\) break stepPush;/,   // 3 push
      /if \(!a\.groupB\.length\) continue;\n    const obj = [^\n]+\n[^\n]*\n    if \(halted\([^\n]+, true\)\) \{ skippedSel\[a\.pathKey\] = \[\.\.\.a\.groupB\]; continue; \}/,   // 3b
      /if \(!a\.sel\.relink\.size\) continue;\n[^\n]+\n    const obj\s+= [^\n]+\n    if \(halted\(/,              // 3c relink
      /if \(!a\.ovwIds\.length\) continue;\n[^\n]+\n    const obj = [^\n]+\n    if \(halted\(/,                  // 3d child overwrite
      /stepOvw: if \(!PROBE && ovwIds\.length\) \{\n    if \(!busyLine && halted\([^\n]+\) break stepOvw;/,     // 4 overwrite
      /stepSrc: if \(!PROBE && updSrcIds\.length\) \{\n    if \(!busyLine && halted\([^\n]+\) break stepSrc;/,  // 4b source update
    ];
    for (const g of gates) expect(RUN).toMatch(g);
    // every engine leg and page-side write of the run sits behind one of them: 9 gates, no more write steps than that
    expect((RUN.match(/halted\(`/g) || []).length).toBe(9);
    expect((RUN.match(/type: 'SF_EXECUTE_PROFILE_TRANSFER'/g) || []).length).toBe(3);
    // the line is logged and kept as a note (ℹ), and the skipped inserts reach History's `selected`
    expect(RUN).toContain('const nsLine = sftkRecNotStartedLine(stoppedWhy, notStarted, _canContinue);');   // round 2: the line knows whether History offers Continue
    expect(RUN).toContain('allErrors.push(`ℹ ${nsLine}`);');
    expect(RUN).toContain('_he.selected = sftkRecMergeSelected(_he.selected, skippedSel);');
  });
});
