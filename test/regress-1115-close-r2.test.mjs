// 2026-11-15 — CLOSE-OUT REVIEW, round 2: four findings, each reproduced by a second reader before it was fixed.
// Every case RUNS the real function (sliced out of the source the way the other regress-1115 files do).
//   A. Task / Event family: the flow probe and the ⇄ swap follow the rule the removers already had
//   B. sweep: a path is demoted only when the hop it ENDS on is positively known (Case.Product is Product2)
//   C. removeFieldRefs: an interview label's {!merge field} READS the queried field — it is put back
//   D. Deploy page: a stopped run promises ▶ Continue only when History will show the button
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const FC = read('field-cleaner.js');
const NL = String.fromCharCode(10);
// an inner function of the FieldCleaner module (two-space indent, closes with "\n  }")
const nested = name => {
  const at = FC.indexOf(`\n  function ${name}(`) >= 0 ? FC.indexOf(`\n  function ${name}(`) : FC.indexOf(`\n  async function ${name}(`);
  if (at < 0) throw new Error(`not found in field-cleaner.js: ${name}`);
  return FC.slice(at + 1, FC.indexOf('\n  }\n', at + 1) + 4);
};

const M = extractFunctions('sftk-mdapi.js', ['sftkFormulaDropField', '_sftkMdSwapToken', 'sftkMdIsOwnObj', 'sftkMdFamObj']);
const R = new Function('sftkMdIsOwnObj', `${read('sftk-fieldreplace.js')}\nreturn { sftkFlowReplaceField, sftkFlowResourceObjects };`)(M.sftkMdIsOwnObj);
const FS = extractFunctions('sftk-flowsurgery.js', ['sftkFlowRefScan']);

// ── A ────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('A. a custom field picked on Task / Event: the flow probe and the ⇄ swap see the sibling’s flow', () => {
  const eventFlow = () => ({
    start: { object: 'Event', triggerType: 'RecordAfterSave' },
    decisions: [{ name: 'D', rules: [{ name: 'R', conditions: [{ leftValueReference: '$Record.Region__c', operator: 'EqualTo', rightValue: { stringValue: 'x' } }] }] }],
    recordUpdates: [{ name: 'U', inputReference: '$Record', inputAssignments: [{ field: 'Region__c', value: { stringValue: 'y' } }] }],
  });
  // the page's own functions, with the picked field and the replacement as the module holds them
  const make = (picked, field) => new Function('sftkFlowRefScan', 'sftkFlowReplaceField', 'sftkMdFamObj', `
    const _selObj = { api: '${picked}' }, _selField = { api: '${field || 'Region__c'}' }, _replField = { api: 'Area__c' };
    const _xiIsRef = () => false;
    const _chainKey = (root, rels) => String(root).toLowerCase() + '|' + rels.map(r => String(r).toLowerCase()).join('.');
    const _chainOwner = async () => null;
    ${nested('_fieldStringTester')}
    ${nested('flowReferencesField')}
    ${nested('_flowNamesThisField')}
    ${nested('_flowProbeSaysThis')}
    ${nested('_flowSwap')}
    return { _flowNamesThisField, _flowSwap };`)(FS.sftkFlowRefScan, R.sftkFlowReplaceField, M.sftkMdFamObj);

  it.each(['Task', 'Event', 'Activity'])('the reported case: %s.Region__c picked, an Event record-triggered flow → the flow DOES name this field', async picked => {
    expect(await make(picked)._flowNamesThisField(eventFlow())).toBe(true);
  });
  it.each(['Task', 'Event', 'Activity'])('⇄ with %s picked moves both mentions of the Event flow', async picked => {
    const md = eventFlow();
    const r = await make(picked)._flowSwap(md);
    expect(r.changed.length).toBe(2);
    expect(r.skipped).toEqual([]);
    expect(md.decisions[0].rules[0].conditions[0].leftValueReference).toBe('$Record.Area__c');
    expect(md.recordUpdates[0].inputAssignments[0].field).toBe('Area__c');
  });
  it('✂ agrees with the probe: removeFieldRefs takes the same flow’s assignment out for Task picked', () => {
    const F = new Function('sftkFlowResourceObjects', 'sftkFormulaDropField', `${nested('removeFieldRefs')}\nreturn removeFieldRefs;`)(R.sftkFlowResourceObjects, M.sftkFormulaDropField);
    const md = eventFlow();
    expect(F(md, 'Task', 'Region__c', null)).toBeGreaterThan(0);
    expect(md.recordUpdates[0].inputAssignments || []).toEqual([]);
  });
  it('still another object’s flow is not this field, and a STANDARD field stays one way', async () => {
    const contact = eventFlow(); contact.start.object = 'Contact';
    expect(await make('Task')._flowNamesThisField(contact)).toBe(false);
    const std = { start: { object: 'Event' }, recordUpdates: [{ name: 'U', inputReference: '$Record', inputAssignments: [{ field: 'Subject', value: { stringValue: 'y' } }] }] };
    expect(await make('Task', 'Subject')._flowNamesThisField(std)).toBe(false);
  });
  it('sftkMdFamObj: only a custom field of Task / Event is asked of Activity', () => {
    expect(M.sftkMdFamObj('Task', 'Region__c')).toBe('Activity');
    expect(M.sftkMdFamObj('event', 'Region__c')).toBe('Activity');
    expect(M.sftkMdFamObj('Task', 'Subject')).toBe('Task');
    expect(M.sftkMdFamObj('Account', 'Region__c')).toBe('Account');
    expect(M.sftkMdFamObj('Activity', 'Region__c')).toBe('Activity');
  });
  it('the report-type scan and the email-template remover take the same family object', () => {
    const T = new Function('sftkMdIsOwnObj', `${read('sftk-emailtpl.js')}\nreturn { sftkTplRemove };`)(M.sftkMdIsOwnObj);
    const rec = { Subject: 'x', Body: 'Region: {!Event.Region__c}', HtmlValue: '' };
    // the object as the page now passes it (Task picked → Activity): the Event merge field is this field
    const fam = T.sftkTplRemove(rec, 'Region__c', M.sftkMdFamObj('Task', 'Region__c'));
    expect(fam.n).toBe(1);
    // what the page passed before: left alone as another object's field
    expect(T.sftkTplRemove(rec, 'Region__c', 'Task').n).toBe(0);
    expect(FC).toContain('sftkRtMentions(rec.innerXml, sftkMdFamObj(_selObj.api, _selField.api), _selField.api)');
  });
});

// ── B ────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B. sweep: a standard relationship that is not named for its object is not proof of another object', () => {
  const S = extractFunctions('sftk-sweep.js', ['sftkSweepForms', 'sftkSweepHits', 'sftkSweepKindTable', 'sftkSweepSections', '_sftkSweepSectionAt',
    'sftkSweepKind', 'sftkSweepRun', 'sftkSweepJoinKind']);
  const vr = (name, formula) => ['<validationRules>', `<fullName>${name}</fullName>`, '<active>true</active>', `<errorConditionFormula>${formula}</errorConditionFormula>`, '</validationRules>'];
  const one = (obj, host, path) => {
    const files = [[`unpackaged/objects/${host}.object`, '<CustomObject>', ...vr('V', `${path}.Region__c = "x"`), '</CustomObject>']];
    const hits = S.sftkSweepRun(new Map(files.map(([p, ...lines]) => [p, lines.join(NL)])), S.sftkSweepForms(obj, 'Region__c')).hits;
    expect(hits.length).toBe(1);
    return { type: hits[0].type, sev: hits[0].sev, join: S.sftkSweepJoinKind(hits[0].type), section: hits[0].section };
  };
  const BLOCKER = { type: 'ValidationRule', sev: 'blocker', join: 'ValidationRule' };
  const DEMOTED = { type: 'SameNameOtherObject', sev: 'mention', join: null };

  it.each([
    ['Product2', 'Case', 'Product'], ['Account', 'Asset', 'AssetProvidedBy'], ['Account', 'Asset', 'AssetServicedBy'],
    ['User', 'Order', 'CompanyAuthorizedBy'], ['Contact', 'Order', 'CustomerAuthorizedBy'], ['Quote', 'Opportunity', 'SyncedQuote'],
    ['User', 'CampaignMember', 'LeadOrContactOwner'],
  ])('the reported cases: %s picked, a %s rule reading %s.Region__c stays a blocker that joins', (obj, host, path) => {
    expect(one(obj, host, path)).toMatchObject(BLOCKER);
  });
  it('a hop nobody listed is kept whatever is picked — never "the path leads elsewhere" on a guess', () => {
    expect(one('Account', 'Contact', 'SomeStandardRel')).toMatchObject(BLOCKER);
    expect(one('Account', 'CampaignMember', 'LeadOrContactOwner')).toMatchObject(BLOCKER);
    // Parent standing on an object that was itself only guessed is not known either
    expect(one('Account', 'Contact', 'SomeStandardRel.Parent')).toMatchObject(BLOCKER);
  });
  it('a path that ENDS on a known hop is still demoted, also behind an unlisted one', () => {
    for (const p of ['Owner', '$User', 'ReportsTo', 'CreatedBy.Manager', 'SomeStandardRel.Owner', 'Account.Parent']) {
      const h = one('Product2', 'Contact', p);
      expect(h).toMatchObject(DEMOTED);
      expect(h.section).toBe('a field of this name on another object, not Product2’s (the path leads elsewhere)');
    }
    // the newly listed relationships are known both ways: Case.Product is Product2's, so not Account's
    expect(one('Account', 'Case', 'Product')).toMatchObject(DEMOTED);
    expect(one('Account', 'Opportunity', 'SyncedQuote')).toMatchObject(DEMOTED);
  });
  it('sftkRelHop / sftkRelHopKnown: the listed aliases, and what "known" means', () => {
    const { sftkRelHop: hop, sftkRelHopKnown: known } = globalThis;
    expect(hop('case', 'Product')).toEqual({ obj: 'product2' });
    expect(hop('asset', 'AssetProvidedBy')).toEqual({ obj: 'account' });
    expect(hop('order', 'CompanyAuthorizedBy')).toEqual({ obj: 'user' });
    expect(hop('order', 'CustomerAuthorizedBy')).toEqual({ obj: 'contact' });
    expect(hop('opportunity', 'SyncedQuote')).toEqual({ obj: 'quote' });
    expect(known('case', 'Product')).toBe(true);
    expect(known('contact', 'Owner:User')).toBe(true);
    expect(known('account', 'Parent')).toBe(true);
    expect(known('account', 'Parent', false)).toBe(false);
    expect(known(null, 'Parent')).toBe(false);
    expect(known('attachment', 'Parent')).toBe(false);
    expect(known('campaignmember', 'LeadOrContactOwner')).toBe(false);
    expect(known('contact', 'Entitlement')).toBe(false);
  });
  it('the removers follow: a Case rule’s Product.Region__c is edited for Product2, a Case field set lists it', () => {
    const MD = new Function(`${read('sftk-mdapi.js')}\nreturn { sftkMdEditField };`)();
    const rule = '<fullName>Case.VR</fullName><active>true</active><errorConditionFormula>Product.Region__c = "x"</errorConditionFormula><errorMessage>m</errorMessage>';
    const r = MD.sftkMdEditField('ValidationRule', rule, 'Product2', 'Region__c', 'Area__c');
    expect(r.refused).toBeNull();
    expect(r.xml).toContain('Product.Area__c = "x"');
    // and it is still not Account's
    const a = MD.sftkMdEditField('ValidationRule', rule, 'Account', 'Region__c', 'Area__c');
    expect(a.changed).toBe(false); expect(a.xml).toBe(rule);
  });
});

// ── C ────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('C. removeFieldRefs: an interview label that reads the field through the lookup keeps it queried', () => {
  const F = new Function('sftkFlowResourceObjects', 'sftkFormulaDropField', `${nested('removeFieldRefs')}\nreturn removeFieldRefs;`)(R.sftkFlowResourceObjects, M.sftkFormulaDropField);
  const lookup = extra => ({ name: 'Get_Account', label: 'Get Account', object: 'Account', filters: [], queriedFields: ['Id', 'Region__c'], ...(extra || {}) });
  it('the reported case: {!Get_Account.Region__c} in the interview label → the field is put back and the lookup is named', () => {
    const md = { interviewLabel: 'Acct {!Get_Account.Region__c} {!$Flow.CurrentDateTime}', recordLookups: [lookup()] };
    expect(F(md, 'Account', 'Region__c', null)).toBe(0);
    expect(md.recordLookups[0].queriedFields).toEqual(['Id', 'Region__c']);
    expect(F.lastLeft.whole).toContainEqual(expect.objectContaining({ why: 'queried', via: 'Get_Account' }));
  });
  it('spaces inside the braces and the variable the lookup stores into count too', () => {
    const md = { interviewLabel: '{! Get_Account.Region__c }', recordLookups: [lookup()] };
    expect(F(md, 'Account', 'Region__c', null)).toBe(0);
    const md2 = { interviewLabel: 'x {!acc.Region__c}', recordLookups: [lookup({ outputReference: 'acc' })],
      variables: [{ name: 'acc', dataType: 'SObject', objectType: 'Account' }] };
    expect(F(md2, 'Account', 'Region__c', null)).toBe(0);
    expect(md2.recordLookups[0].queriedFields).toEqual(['Id', 'Region__c']);
  });
  it('plain text in the interview label, and a merge field of ANOTHER lookup or field, still do not count', () => {
    for (const label of ['Get_Account.Region__c {!$Flow.CurrentDateTime}', 'x {!Get_Contact.Region__c}', 'x {!Get_Account.Region__c_Old}', 'x {!Get_Account.Name}']) {
      const md = { interviewLabel: label, recordLookups: [lookup()] };
      expect(F(md, 'Account', 'Region__c', null)).toBe(1);
      expect(md.recordLookups[0].queriedFields).toEqual(['Id']);
      expect(F.lastLeft.whole).toEqual([]);
    }
  });
  it('a description with the same merge field is documentation: the field goes', () => {
    const md = { description: 'see {!Get_Account.Region__c}', recordLookups: [lookup()] };
    expect(F(md, 'Account', 'Region__c', null)).toBe(1);
  });
});

// ── D ────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('D. a stopped run promises ▶ Continue only when History will show it', () => {
  const RC = extractFunctions('studio-reconcile.js', ['sftkRecNotStartedLine', 'sftkRunEndLine', 'sftkRecCanContinue']);
  const ins = [{ what: 'the insert of 3 Contact under existing parents', insert: true }];
  const mixed = [...ins, { what: 'the relink of 5 Contact' }];

  it('the reported case: no button → the not-started line says scan and tick again, never "Continue … re-ticks"', () => {
    for (const why of ['pause', 'closed']) for (const steps of [ins, mixed]) {
      const line = RC.sftkRecNotStartedLine(why, steps, false);
      expect(line).not.toMatch(/re-ticks/);
      expect(line).toMatch(/Nothing of these steps was written\. Scan again and tick them again on the Deploy page — History has no ▶ Continue for this run\.$/);
    }
  });
  it('with the button the line is what it was (and the two-argument call still is)', () => {
    expect(RC.sftkRecNotStartedLine('pause', ins, true)).toMatch(/▶ Continue from History re-ticks them\.$/);
    expect(RC.sftkRecNotStartedLine('pause', ins)).toBe(RC.sftkRecNotStartedLine('pause', ins, true));
    expect(RC.sftkRecNotStartedLine('pause', mixed, true)).toMatch(/re-ticks the inserts only — tick the other steps again on the Deploy page\.$/);
    expect(RC.sftkRecNotStartedLine('cancel', ins, false)).toBe('Not started — the run was cancelled before: the insert of 3 Contact under existing parents. Nothing of these steps was written.');
  });
  it('the end line of a paused / closed run follows the same flag', () => {
    const p = RC.sftkRunEndLine({ status: 'success', stoppedWhy: 'pause', canContinue: false }).text;
    expect(p).toBe('Paused — the records not reached are still to deploy; scan again and tick them again on the Deploy page.');
    const c = RC.sftkRunEndLine({ status: 'partial', stoppedWhy: 'closed', canContinue: false }).text;
    expect(c).toBe('Stopped — the page was closed mid-run; the records not reached are still to deploy: scan again and tick them again on the Deploy page.');
    expect(p + c).not.toMatch(/Continue/);
    expect(RC.sftkRunEndLine({ status: 'partial', stoppedWhy: 'pause', canContinue: true }).text).toBe('Paused — the records not reached are still to deploy; ▶ Continue from History.');
    expect(RC.sftkRunEndLine({ status: 'partial', stoppedWhy: 'closed', canContinue: true }).text).toBe('Stopped — the page was closed mid-run; ▶ Continue from History.');
  });
  it('sftkRecCanContinue: a saved deployment, not counts-only, not an Org Compare one', () => {
    const list = [{ id: 'p1' }, { id: 'p2' }];
    expect(RC.sftkRecCanContinue({ id: 'p1' }, list, { countsOnly: false })).toBe(true);
    expect(RC.sftkRecCanContinue({ id: 'p1' }, list, null)).toBe(true);
    expect(RC.sftkRecCanContinue({ id: 'p1' }, list, { countsOnly: true })).toBe(false);   // History keeps no ticked ids
    expect(RC.sftkRecCanContinue({ id: 'p1', ephemeral: true }, list, {})).toBe(false);
    expect(RC.sftkRecCanContinue({ id: 'gone' }, list, {})).toBe(false);
    expect(RC.sftkRecCanContinue(null, list, {})).toBe(false);
  });
  it('counts-only really leaves History without the button’s input: the strip removes `selected`', () => {
    const strip = new Function('_settings', `${extractSrc('studio-core.js', '_historyStripCountsOnly')}\nreturn _historyStripCountsOnly;`)({ countsOnly: true });
    const h = [{ id: 'r1', stopped: true, selected: { root: ['001A'] } }];
    strip(h);
    expect(h[0].selected).toBeUndefined();
  });
  it('wiring: runReconcile asks once and gives both lines the same answer', () => {
    const REC = read('studio-reconcile.js');
    expect(REC).toContain("const _canContinue = sftkRecCanContinue(profile, _profiles, typeof _settings !== 'undefined' ? _settings : null);");
    expect(REC).toContain('sftkRecNotStartedLine(stoppedWhy, notStarted, _canContinue)');
    expect(REC).toContain('canContinue: _canContinue });');
  });
});

function extractSrc(file, name) {
  const src = read(file);
  const at = src.search(new RegExp(`^function ${name}\\(`, 'm'));
  if (at < 0) throw new Error(`${name} not found in ${file}`);
  return src.slice(at, src.indexOf('\n}', at) + 2);
}
