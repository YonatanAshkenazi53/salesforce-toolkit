// "Replace with another field" (Field Cleaner, user 2026-10-04: "what if we
// want to remove the old field and assign a new field instead with the same
// type?" … "i want to add the replace field feature"). The engine is
// sftk-fieldreplace.js — pure. The rule under test everywhere: a reference is
// swapped only when it is KNOWN to be this object's field.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const SRC = read('sftk-fieldreplace.js');
const R = new Function(`${SRC}\nreturn { sftkFieldReplaceCompat, sftkFlowResourceObjects, sftkFlowReplaceField, sftkLayoutReplaceField, sftkFlexiReplaceField, sftkRptReplaceField, sftkFlsCopyPlan };`)();
const S = extractFunctions('sftk-flowsurgery.js', ['sftkFlowRefScan']);
const RC = extractFunctions('sftk-reportclean.js', ['sftkRptTokenMatch', 'sftkRptFieldHits']);

const OLD = 'SFTK_FC_Test_Status__c', NEW = 'SFTK_FC_Test_Status2__c';
// the scanner's own test (field-cleaner.js _fieldStringTester), for "what still mentions it"
const tester = api => { const re = new RegExp(`(^|[^a-z0-9_])${api.toLowerCase()}([^a-z0-9_]|$)`, 'i'); return v => re.test(v); };
const clone = x => JSON.parse(JSON.stringify(x));

// The fixture flow (docs/fixtures/field-cleaner-fixture, v4 shape): a record
// variable, a decision, an assignment, a formula and a record create.
const FLOW = () => ({
  description: `Every version references Account.${OLD}.`,
  label: 'SFTK FC Test Flow',
  processType: 'AutoLaunchedFlow',
  status: 'Active',
  variables: [
    { name: 'acct', dataType: 'SObject', objectType: 'Account', isCollection: false },
    { name: 'con', dataType: 'SObject', objectType: 'Contact', isCollection: false },
    { name: 'remembered', dataType: 'String' },
  ],
  formulas: [{ name: 'StatusText', dataType: 'String', expression: `TEXT({!acct.${OLD}}) & " / " & TEXT({!con.${OLD}})` }],
  decisions: [{ name: 'Check_Status', label: 'Check Status', rules: [
    { name: 'Is_New', label: 'Is New', conditions: [{ leftValueReference: `acct.${OLD}`, operator: 'EqualTo', rightValue: { stringValue: 'New' } }] },
    { name: 'Is_Closed', label: 'Is Closed', conditions: [{ leftValueReference: `acct.${OLD}`, operator: 'EqualTo', rightValue: { stringValue: 'Closed' } }] },
  ] }],
  assignments: [{ name: 'Remember_Status', label: 'Remember Status', assignmentItems: [
    { assignToReference: 'remembered', operator: 'Assign', value: { elementReference: `acct.${OLD}` } },
  ] }],
  recordCreates: [
    { name: 'Create_Account', label: 'Create', object: 'Account', inputAssignments: [{ field: OLD, value: { stringValue: 'New' } }] },
    { name: 'Create_Contact', label: 'Create', object: 'Contact', inputAssignments: [{ field: OLD, value: { stringValue: 'New' } }] },
  ],
  recordLookups: [{ name: 'Find_Account', label: 'Find', object: 'Account', filters: [{ field: 'Name', operator: 'StartsWith', value: { stringValue: 'x' } }, { field: OLD, operator: 'EqualTo', value: { stringValue: 'New' } }], queriedFields: ['Id', OLD] }],
});

describe('flows — every known reference moves, the logic stays', () => {
  it('swaps the record variable, the formula token, the bare field of a Create and of a Get, and a queried field', () => {
    const md = FLOW();
    const r = R.sftkFlowReplaceField(md, 'Account', OLD, NEW);
    expect(md.decisions[0].rules[0].conditions[0].leftValueReference).toBe(`acct.${NEW}`);
    expect(md.decisions[0].rules[1].conditions[0].leftValueReference).toBe(`acct.${NEW}`);
    expect(md.assignments[0].assignmentItems[0].value.elementReference).toBe(`acct.${NEW}`);
    expect(md.recordCreates[0].inputAssignments[0].field).toBe(NEW);
    expect(md.recordLookups[0].filters[1].field).toBe(NEW);
    expect(md.recordLookups[0].queriedFields).toEqual(['Id', NEW]);
    // nothing is REMOVED: the same number of conditions, lines and assignments as before
    expect(md.decisions[0].rules.map(x => x.conditions.length)).toEqual([1, 1]);
    expect(md.assignments[0].assignmentItems.length).toBe(1);
    expect(r.changed.length).toBe(7);
  });

  it('a same-named field on ANOTHER object is left alone and named', () => {
    const md = FLOW();
    const r = R.sftkFlowReplaceField(md, 'Account', OLD, NEW);
    expect(md.recordCreates[1].inputAssignments[0].field).toBe(OLD);            // the Contact create
    expect(md.formulas[0].expression).toBe(`TEXT({!acct.${NEW}}) & " / " & TEXT({!con.${OLD}})`);
    const other = r.skipped.filter(s => s.why === 'other');
    expect(other.map(s => s.object)).toEqual(['Contact', 'Contact']);
    // and the scanner still reports exactly those two places — never "clean" when it is not
    expect(S.sftkFlowRefScan(md, tester(OLD)).length).toBe(2);
  });

  it('labels and descriptions are not references and are not rewritten', () => {
    const md = FLOW();
    R.sftkFlowReplaceField(md, 'Account', OLD, NEW);
    expect(md.description).toContain(OLD);
  });

  it('the triggering record: $Record and $Record__Prior belong to the start object', () => {
    const md = { start: { object: 'Account', filters: [{ field: OLD, operator: 'IsChanged', value: { booleanValue: true } }] },
      decisions: [{ name: 'D', rules: [{ name: 'R', conditions: [{ leftValueReference: `$Record.${OLD}`, operator: 'NotEqualTo', rightValue: { elementReference: `$Record__Prior.${OLD}` } }] }] }] };
    const r = R.sftkFlowReplaceField(md, 'Account', OLD, NEW);
    expect(md.start.filters[0].field).toBe(NEW);
    expect(md.decisions[0].rules[0].conditions[0].leftValueReference).toBe(`$Record.${NEW}`);
    expect(md.decisions[0].rules[0].conditions[0].rightValue.elementReference).toBe(`$Record__Prior.${NEW}`);
    expect(r.skipped).toEqual([]);
    // a flow triggered by ANOTHER object: its $Record.<same name> is not ours
    const md2 = { start: { object: 'Contact' }, formulas: [{ name: 'F', expression: `{!$Record.${OLD}}` }] };
    const r2 = R.sftkFlowReplaceField(md2, 'Account', OLD, NEW);
    expect(md2.formulas[0].expression).toBe(`{!$Record.${OLD}}`);
    expect(r2.skipped[0]).toMatchObject({ why: 'other', object: 'Contact' });
  });

  it('a Get Records element, a loop over it and an update through a record variable', () => {
    const md = { recordLookups: [{ name: 'Get_Accounts', object: 'Account' }],
      loops: [{ name: 'Each', collectionReference: 'Get_Accounts' }],
      assignments: [{ name: 'A', assignmentItems: [{ assignToReference: `Each.${OLD}`, operator: 'Assign', value: { elementReference: `Get_Accounts.${OLD}` } }] }],
      recordUpdates: [{ name: 'U', inputReference: '$Record', inputAssignments: [{ field: OLD, value: { stringValue: 'x' } }] }],
      start: { object: 'Account' } };
    R.sftkFlowReplaceField(md, 'Account', OLD, NEW);
    expect(md.assignments[0].assignmentItems[0]).toMatchObject({ assignToReference: `Each.${NEW}`, value: { elementReference: `Get_Accounts.${NEW}` } });
    expect(md.recordUpdates[0].inputAssignments[0].field).toBe(NEW);
  });

  it('a reference THROUGH a relationship is asked about, then swapped only when the schema says it is this object', () => {
    const base = () => ({ start: { object: 'Contact' }, formulas: [{ name: 'F', expression: `{!$Record.Account.${OLD}} & {!$Record.Owner.${OLD}}` }] });
    const md = base();
    const first = R.sftkFlowReplaceField(md, 'Account', OLD, NEW);
    expect(first.changed).toEqual([]);                                       // nothing guessed
    expect(first.needs).toEqual([{ rootObj: 'Contact', rels: ['Account'] }, { rootObj: 'Contact', rels: ['Owner'] }]);
    const md2 = base();
    const second = R.sftkFlowReplaceField(md2, 'Account', OLD, NEW, { chainOwner: (root, rels) => (rels[0] === 'Account' ? 'Account' : null) });
    expect(md2.formulas[0].expression).toBe(`{!$Record.Account.${NEW}} & {!$Record.Owner.${OLD}}`);
    expect(second.needs).toEqual([]);
    expect(second.skipped).toEqual([{ path: ['formulas', 0, 'expression'], value: base().formulas[0].expression, why: 'unknown', object: null }]);
  });

  it('a mention whose object cannot be worked out is never touched', () => {
    const md = { actionCalls: [{ name: 'Apex', inputParameters: [{ name: 'fieldName', value: { stringValue: OLD } }, { name: 'rec', value: { elementReference: `Some_Action.out.${OLD}` } }] }] };
    const r = R.sftkFlowReplaceField(md, 'Account', OLD, NEW);
    expect(r.changed).toEqual([]);
    expect(r.skipped.map(s => s.why)).toEqual(['unknown', 'unknown']);
    expect(JSON.stringify(md)).not.toContain(NEW);
  });

  it('a longer field name that merely CONTAINS the old one is not a match', () => {
    const md = { start: { object: 'Account' }, formulas: [{ name: 'F', expression: `{!$Record.Old_${OLD}} {!$Record.${OLD}_x}` }] };
    const r = R.sftkFlowReplaceField(md, 'Account', OLD, NEW);
    expect(r.changed).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it('the swapped flow no longer mentions the old field anywhere the scanner looks', () => {
    const md = FLOW();
    md.recordCreates.pop(); md.variables.splice(1, 1); md.formulas[0].expression = `TEXT({!acct.${OLD}})`;
    R.sftkFlowReplaceField(md, 'Account', OLD, NEW);
    expect(S.sftkFlowRefScan(md, tester(OLD))).toEqual([]);
    expect(S.sftkFlowRefScan(md, tester(NEW)).length).toBe(7);
  });
});

describe('may the new field stand in? — the type check', () => {
  const pk = (name, vals, extra) => ({ name, type: 'picklist', picklistValues: vals.map(v => ({ value: v, active: true })), ...extra });
  it('a different type or a different lookup target is a blocker', () => {
    expect(R.sftkFieldReplaceCompat({ name: 'A__c', type: 'picklist' }, { name: 'B__c', type: 'string' })).toMatchObject({ ok: false });
    const c = R.sftkFieldReplaceCompat({ name: 'A__c', type: 'reference', referenceTo: ['Account'] }, { name: 'B__c', type: 'reference', referenceTo: ['Contact'] });
    expect(c.ok).toBe(false);
    expect(c.blockers[0]).toContain('look up different objects');
  });
  it('a field the describe does not list cannot be checked — refused, with the reason', () => {
    const c = R.sftkFieldReplaceCompat({ name: 'A__c', type: 'string' }, null);
    expect(c.ok).toBe(false);
    expect(c.blockers[0]).toContain('field-level security');
  });
  it('missing picklist values, a shorter text and a formula are warnings, not blockers', () => {
    const c = R.sftkFieldReplaceCompat(pk('A__c', ['New', 'Reviewed', 'Closed']), pk('B__c', ['New', 'Reviewed'], { restrictedPicklist: true }));
    expect(c.ok).toBe(true);
    expect(c.warnings[0]).toContain('“Closed”');
    expect(c.warnings[0]).toContain('restricted picklist');
    expect(R.sftkFieldReplaceCompat({ name: 'A__c', type: 'string', length: 255 }, { name: 'B__c', type: 'string', length: 80 }).warnings[0]).toContain('shorter');
    expect(R.sftkFieldReplaceCompat({ name: 'A__c', type: 'string', length: 80 }, { name: 'B__c', type: 'string', length: 80, calculated: true }).warnings[0]).toContain('cannot be written');
    expect(R.sftkFieldReplaceCompat({ name: 'A__c', type: 'string', length: 80 }, { name: 'B__c', type: 'string', length: 255 })).toEqual({ ok: true, blockers: [], warnings: [] });
  });
});

describe('page layouts — the new field takes the slot', () => {
  const L = items => ({ layoutSections: [{ layoutColumns: [{ layoutItems: items }] }] });
  it('swaps in place and keeps the behaviour', () => {
    const md = L([{ field: 'Name', behavior: 'Required' }, { field: OLD, behavior: 'Edit' }]);
    expect(R.sftkLayoutReplaceField(md, OLD, NEW)).toEqual({ swapped: 1, blanked: 0 });
    expect(md.layoutSections[0].layoutColumns[0].layoutItems[1]).toEqual({ field: NEW, behavior: 'Edit' });
  });
  it('the new field is already on the layout → the old slot becomes a blank space (never twice)', () => {
    const md = L([{ field: NEW, behavior: 'Edit' }, { field: OLD, behavior: 'Edit' }]);
    expect(R.sftkLayoutReplaceField(md, OLD, NEW)).toEqual({ swapped: 0, blanked: 1 });
    expect(md.layoutSections[0].layoutColumns[0].layoutItems[1]).toEqual({ emptySpace: true });
  });
  it('a field that cannot be edited lands as Readonly', () => {
    const md = L([{ field: OLD, behavior: 'Edit' }]);
    R.sftkLayoutReplaceField(md, OLD, NEW, { readOnly: true });
    expect(md.layoutSections[0].layoutColumns[0].layoutItems[0].behavior).toBe('Readonly');
  });
});

describe('Lightning pages — field components and visibility conditions', () => {
  const page = items => ({ flexiPageRegions: [{ name: 'Facet-1', itemInstances: items }] });
  it('a Dynamic Forms field and a visibility condition move to the new field', () => {
    const md = page([
      { fieldInstance: { fieldItem: `Record.${OLD}`, identifier: 'RecordStatusField' } },
      { componentInstance: { componentName: 'flexipage:richText', visibilityRule: { criteria: [{ leftValue: `{!Record.${OLD}}`, operator: 'EQUAL', rightValue: 'New' }] } } },
    ]);
    expect(R.sftkFlexiReplaceField(md, 'Account', OLD, NEW)).toEqual({ swapped: 2, dropped: 0, left: 0 });
    expect(md.flexiPageRegions[0].itemInstances[0].fieldInstance.fieldItem).toBe(`Record.${NEW}`);
    expect(md.flexiPageRegions[0].itemInstances[1].componentInstance.visibilityRule.criteria[0].leftValue).toBe(`{!Record.${NEW}}`);
  });
  it('the page already shows the new field → the old component is dropped, not shown twice', () => {
    const md = page([{ fieldInstance: { fieldItem: `Record.${NEW}` } }, { fieldInstance: { fieldItem: `Record.${OLD}` } }]);
    expect(R.sftkFlexiReplaceField(md, 'Account', OLD, NEW)).toMatchObject({ swapped: 0, dropped: 1 });
    expect(md.flexiPageRegions[0].itemInstances.length).toBe(1);
  });
  it('a field of a RELATED record is another object — left alone and counted', () => {
    const md = page([{ componentInstance: { componentName: 'x', visibilityRule: { criteria: [{ leftValue: `{!Record.Parent.${OLD}}`, operator: 'EQUAL', rightValue: 'New' }] } } }]);
    expect(R.sftkFlexiReplaceField(md, 'Account', OLD, NEW)).toEqual({ swapped: 0, dropped: 0, left: 1 });
    expect(JSON.stringify(md)).not.toContain(NEW);
  });
});

describe('Lightning pages — the key the API really sends (live 2026-10-04)', () => {
  it('the rule is `visibilityRule` with a plain-string right-hand side; a literal that equals the field name is not a reference', () => {
    const md = { flexiPageRegions: [{ itemInstances: [{ componentInstance: { componentName: 'x', visibilityRule: { criteria: [
      { leftValue: `{!Record.${OLD}}`, operator: 'EQUAL', rightValue: OLD },
      { leftValue: '{!Record.Name}', operator: 'EQUAL', rightValue: `{!Record.${OLD}}` },
    ] } } }] }] };
    expect(R.sftkFlexiReplaceField(md, 'Account', OLD, NEW)).toMatchObject({ swapped: 2 });
    const c = md.flexiPageRegions[0].itemInstances[0].componentInstance.visibilityRule.criteria;
    expect(c[0]).toMatchObject({ leftValue: `{!Record.${NEW}}`, rightValue: OLD });   // the literal text stays
    expect(c[1].rightValue).toBe(`{!Record.${NEW}}`);
  });
  it('the remover cleans that key too — it looked only at a key the API never sends', () => {
    const FC = read('field-cleaner.js');
    expect(FC).toContain("for (const key of ['visibilityRule', 'componentVisibilityRule']) {");
    expect(FC).not.toContain('if (!inst || !inst.componentVisibilityRule) return;');
  });
});

describe('reports — the column, filter and grouping keep their place', () => {
  const tm = RC.sftkRptTokenMatch, fh = RC.sftkRptFieldHits;
  it('swaps definite tokens in their own spelling; an existing column is not added twice', () => {
    const meta = { reportFormat: 'SUMMARY', detailColumns: ['ACCOUNT.NAME', `Account.${OLD}`, `Account.${NEW}`],
      reportFilters: [{ column: `Account.${OLD}`, operator: 'equals', value: 'New' }],
      groupingsDown: [{ name: `Account.${OLD}`, sortOrder: 'Asc' }] };
    const r = R.sftkRptReplaceField(meta, 'Account', OLD, NEW, tm, fh);
    expect(r.meta.detailColumns).toEqual(['ACCOUNT.NAME', `Account.${NEW}`]);
    expect(r.meta.reportFilters[0].column).toBe(`Account.${NEW}`);
    expect(r.meta.groupingsDown[0].name).toBe(`Account.${NEW}`);
    expect(r.swapped).toEqual({ columns: 1, filters: 1, groupings: 1 });
    expect(r.changed).toBe(true);
    expect(meta.detailColumns.length).toBe(3);                               // the input is not mutated
  });
  it('a custom-report-type token (Object$Field) keeps its separator; a formula stays manual', () => {
    const meta = { detailColumns: [`Account$${OLD}`], aggregates: [`s!Account.${OLD}`] };
    const r = R.sftkRptReplaceField(meta, 'Account', OLD, NEW, tm, fh);
    expect(r.meta.detailColumns).toEqual([`Account$${NEW}`]);
    expect(r.manual.join(' ')).toContain('never auto-edited');
  });
});

describe('field access — whoever saw the old field sees the new one, and nothing is ever lowered', () => {
  const row = (id, parent, read, edit, label, isProfile) => ({ Id: id, ParentId: parent, PermissionsRead: read, PermissionsEdit: edit, Parent: { Label: label, IsOwnedByProfile: !!isProfile, Profile: isProfile ? { Name: label } : null } });
  it('creates what is missing, raises what is lower, leaves what is already enough', () => {
    const oldRows = [row('o1', 'P1', true, true, 'Sales'), row('o2', 'P2', true, false, 'Readers'), row('o3', 'P3', true, true, 'Admin', true)];
    const newRows = [row('n2', 'P2', true, true, 'Readers'), row('n3', 'P3', true, false, 'Admin', true)];
    const p = R.sftkFlsCopyPlan(oldRows, newRows, 'Account', NEW);
    expect(p.create).toEqual([{ who: 'Sales', kind: 'Permission set', body: { ParentId: 'P1', SobjectType: 'Account', Field: `Account.${NEW}`, PermissionsRead: true, PermissionsEdit: true } }]);
    expect(p.update).toEqual([{ who: 'Admin', kind: 'Profile', id: 'n3', parentId: 'P3', before: { PermissionsRead: true, PermissionsEdit: false }, after: { PermissionsRead: true, PermissionsEdit: true } }]);
    expect(p.same).toBe(1);                                                  // Readers already has MORE on the new field — untouched
  });
  it('a field that cannot be edited receives read access only', () => {
    const p = R.sftkFlsCopyPlan([row('o1', 'P1', true, true, 'Sales')], [], 'Account', NEW, { readOnly: true });
    expect(p.create[0].body).toMatchObject({ PermissionsRead: true, PermissionsEdit: false });
  });
});

// ── the wiring in field-cleaner.js (source pins) ─────────────────────────
describe('Field Cleaner — step 3 and what it changes', () => {
  const FC = read('field-cleaner.js');
  it('popup.html loads the engine before field-cleaner.js', () => {
    const H = read('popup.html');
    const at = f => H.indexOf(`<script src="${f}"></script>`);
    expect(at('sftk-fieldreplace.js')).toBeGreaterThan(at('sftk-flowsurgery.js'));
    expect(at('sftk-flowsurgery.js')).toBeGreaterThan(-1);
    expect(at('sftk-fieldreplace.js')).toBeLessThan(at('field-cleaner.js'));
  });
  it('the picker offers ONLY fields the type check accepts, judged from the object describe', () => {
    expect(FC).toContain('.filter(f => sftkFieldReplaceCompat(oldDesc, f).ok)');
    expect(FC).toContain("is not in your user's view of");            // a field the user cannot see: said, not guessed
    expect(FC).toContain('if (seq !== _replSeq) return;');             // a newer selection wins over a describe in flight
  });
  it('replace mode is on only with a chosen field that passed the check; picking a new field to clean resets it', () => {
    expect(FC).toContain('function _replOn() { return !!(_selField && _replField && _replCompat && _replCompat.ok); }');
    expect(FC).toContain('_replField = null; _replCompat = null; _replSeq++;');
  });
  it('says plainly that moving references does not move the data, and where the data is copied', () => {
    expect(FC).toContain('This moves REFERENCES. The values stored in the old field are a separate step: after the scan, 📦 Stored values compares the two fields and offers to copy them.');
  });
  it('replace mode ADDS a button: every item offers ⇄ Replace and ✂ Remove, and the click decides (see the last block)', () => {
    expect(FC).toContain('data-swap="1" title="Point this at ${esc(_replField.api)} instead of the field">⇄ Replace</button>${rm}`;');
    expect(FC).toContain('if (!_replOn()) return rm;');
  });
  it('flows: the preview is made by the REAL swap on a clone, and the run uses the same swap', () => {
    expect(FC).toContain('const sw = await _flowSwap(after);');
    expect(FC).toContain('? (await _flowSwap(metadata)).changed.reduce((n, c) => n + c.n, 0)');
    expect(FC).toContain('if (pv.swap) return _flowSwapHtml(fp, canReplace);');
  });
  it('a field reached through a lookup is swapped only when the schema resolves it; polymorphic or unreadable → left alone', () => {
    expect(FC).toContain('if (!f || !Array.isArray(f.referenceTo) || f.referenceTo.length !== 1) return null;');
    expect(FC).toContain('return v === undefined ? null : v;');
  });
  it('after a swap "still mentions" ignores a same-named field of another object', () => {
    expect(FC).toContain("out.undecided = again.skipped.filter(x => x.why !== 'other').length;");
    expect(FC).toContain('out.stillMentions = again.changed.length > 0 || out.undecided > 0;');
  });
  it('layout / page / report: the swap goes through the same verified write, and the re-read judges it', () => {
    expect(FC).toContain('const sw = swap ? sftkLayoutReplaceField(metadata, _selField.api, swapTo, { readOnly: _replReadOnly() }) : null;');
    expect(FC).toContain('return { ok: left === 0 && hasNew, text: null };');
    expect(FC).toContain('return { ok: again.swapped + again.dropped === 0, text: null };');
    expect(FC).toContain('? sftkRptReplaceField(d.reportMetadata, obj, field, swapTo, sftkRptTokenMatch, sftkRptFieldHits)');
  });
  it('field access is only ADDED, re-read in one query, journaled, and every grant has an undo step', () => {
    expect(FC).toContain('copyPlan = sftkFlsCopyPlan(rows, nr.rows, _selObj.api, to, { readOnly: _replReadOnly() });');
    expect(FC).toContain('res = await sftkWriteVerifiedAll(items, { journal: j, verifyAll: async () => {');
    expect(FC).toContain("msg: { type: 'SF_REST_DELETE', sobject: 'FieldPermissions', id: row.Id },");
    expect(FC).toContain("await sftkHistoryEnd(j, { undo: steps.length ? { steps } : { none: 'no grant was confirmed changed, so there is nothing to undo' } });");
  });
});

// Found on the way (live 2026-10-04): the dependency index returned no reports
// for two public reports that used the field. The scan note claimed coverage.
describe('Field Cleaner — the note about reports says what is true', () => {
  const FC = read('field-cleaner.js');
  it('no longer says reports are covered; points at Setup\'s own list', () => {
    expect(FC).not.toContain('are covered by the scan above');
    expect(FC).toContain('appear above only when Salesforce\\u2019s dependency');
    expect(FC).toContain('a report that uses this field can be missing here');
  });
});

// ── 📦 Copy the stored values (user 2026-10-04: "should Replace Field offer to
// copy the old field's data into the new one before the delete? yes") ───────
describe('stored values — the plan of a copy', () => {
  const C = new Function(`${SRC}\nreturn { sftkCopySameValue, sftkCopyValuesPlan, sftkCopyValuesCheck, sftkCopyValuesCsv };`)();
  const row = (id, a, b) => ({ Id: id, [OLD]: a, [NEW]: b });
  const pk = (vals, restricted) => ({ type: 'picklist', length: 255, restrictedPicklist: restricted, picklistValues: vals.map(v => ({ value: v, active: true })) });

  it('only records that hold a value take part; same / fill / differ are told apart', () => {
    const p = C.sftkCopyValuesPlan([row('1', 'New', null), row('2', 'New', 'New'), row('3', 'Reviewed', 'New'), row('4', null, 'New'), row('5', '', null)], OLD, NEW, { newDesc: pk(['New', 'Reviewed'], true) });
    expect(p.total).toBe(3);
    expect(p.same).toBe(1);
    expect(p.fill).toEqual([{ Id: '1', value: 'New', was: null }]);
    expect(p.over).toEqual([{ Id: '3', value: 'Reviewed', was: 'New' }]);      // written only when the user ticks overwrite
    expect(p.blocked).toEqual([]);
  });
  it('a value a RESTRICTED picklist would refuse is never sent — it is counted with the reason', () => {
    const p = C.sftkCopyValuesPlan([row('1', 'Closed', null), row('2', 'Closed', null), row('3', 'New', null)], OLD, NEW, { newDesc: pk(['New', 'Reviewed'], true) });
    expect(p.fill.map(x => x.Id)).toEqual(['3']);
    expect(p.blocked).toEqual([{ reason: `the value “Closed” is not one of ${NEW}’s values (a restricted picklist refuses it)`, count: 2, ids: ['1', '2'] }]);
  });
  it('an UNRESTRICTED picklist accepts it: copied, and named as a value outside the list', () => {
    const p = C.sftkCopyValuesPlan([row('1', 'Closed', null)], OLD, NEW, { newDesc: pk(['New'], false) });
    expect(p.fill.length).toBe(1);
    expect(p.unlisted).toEqual([{ value: 'Closed', count: 1 }]);
  });
  it('a multi-select value is checked token by token; a text that does not fit is blocked', () => {
    const mp = { type: 'multipicklist', restrictedPicklist: true, picklistValues: [{ value: 'A', active: true }, { value: 'B', active: true }] };
    const p = C.sftkCopyValuesPlan([row('1', 'A;B', null), row('2', 'A;Z', null)], OLD, NEW, { newDesc: mp });
    expect(p.fill.map(x => x.Id)).toEqual(['1']);
    expect(p.blocked[0].reason).toContain('“Z”');
    const q = C.sftkCopyValuesPlan([row('1', 'abcdef', null), row('2', 'abc', null)], OLD, NEW, { newDesc: { type: 'string', length: 3 } });
    expect(q.fill.map(x => x.Id)).toEqual(['2']);
    expect(q.blocked[0]).toMatchObject({ count: 1, reason: `the value is longer than ${NEW} allows (3 characters)` });
  });
  it('numbers, checkboxes and empties compare by meaning', () => {
    expect(C.sftkCopySameValue(5, '5')).toBe(true);
    expect(C.sftkCopySameValue(5.0, 5)).toBe(true);
    expect(C.sftkCopySameValue(null, '')).toBe(true);
    expect(C.sftkCopySameValue(false, null)).toBe(false);          // an unticked checkbox is a value
    expect(C.sftkCopySameValue('a', 'A')).toBe(false);
    const p = C.sftkCopyValuesPlan([row('1', true, false), row('2', false, false)], OLD, NEW, { newDesc: { type: 'boolean' } });
    expect(p.same).toBe(1);
    expect(p.over).toEqual([{ Id: '1', value: true, was: false }]);  // a checkbox is never "empty": changing it is an overwrite
  });
  it('the verdict after the run is per record: what was meant, what the org holds now', () => {
    const c = C.sftkCopyValuesCheck([{ Id: '001000000000001AAA', value: 'New' }, { Id: '001000000000002AAA', value: 'New' }, { Id: '001000000000003AAA', value: 'New' }],
      [{ Id: '001000000000001AAA', [NEW]: 'New' }, { Id: '001000000000002', [NEW]: 'Reviewed' }], NEW);
    expect(c).toEqual({ ok: 1, bad: [{ Id: '001000000000002AAA', want: 'New', got: 'Reviewed' }], badCount: 1, missing: 1 });
  });
  it('the receipt lists every record, the value written and the value that was there', () => {
    expect(C.sftkCopyValuesCsv(NEW, [{ Id: '1', value: 'a,b', was: null }, { Id: '2', value: 'x', was: 'say "hi"' }]))
      .toBe(`Id,${NEW} (written),${NEW} (before)\r\n1,"a,b",\r\n2,x,"say ""hi"""`);
  });
});

describe('stored values — the wiring keeps the laws', () => {
  const FC = read('field-cleaner.js');
  const run = FC.slice(FC.indexOf('async function _copyRun() {'), FC.indexOf("// 🔑 Copy the old field's access to the replacement field."));
  it('nothing is read until the user asks, and the cost is on the button', () => {
    expect(FC).toContain("eid('fcCopyCompare').addEventListener('click', _copyCompare);");
    expect(FC).toContain('📦 Compare the two fields${calls ? ` (≈${calls.toLocaleString()} API call${calls === 1 ? \'\' : \'s\'})` : \'\'}');
  });
  it('overwriting an existing value is never the default', () => {
    expect(FC).toContain('overwrite: false, plan: null, result: null };');
    expect(run).toContain('const targets = [...st.plan.fill, ...(st.overwrite ? st.plan.over : [])];');
    expect(run).toContain('st.overwrite = false;');                       // and it does not stick for the next run
  });
  it('one confirmation says what is written, that automation runs, and offers the receipt (ticked)', () => {
    expect(run).toContain('the object’s flows, triggers, validation rules and duplicate rules run');
    expect(run).toContain('<input type="checkbox" id="fcCopyCsv" checked>');
    expect(run).toContain('needsCheckbox: true,');
    expect(run).toContain('production: gate.production ? { label: gate.label } : null,');
  });
  it('the old field is never written', () => {
    expect(run).toContain('records: chunk.map(t => ({ attributes: { type: obj }, Id: t.Id, [to]: t.value })) });');
    expect(run).not.toContain('[from]:');
  });
  it('the run can be stopped between batches, and is judged by reading the records again', () => {
    expect(run).toContain('if (_copyStop) { stopped = true; break; }');
    expect(run).toContain('check = sftkCopyValuesCheck(wrote, after, to);');
    expect(run).toContain('return { ok: wrote.length > 0 && check.ok === wrote.length, detail: check,');
  });
  it('a refused record is counted with Salesforce\'s reason, never hidden', () => {
    expect(run).toContain('reasons.set(why, (reasons.get(why) || 0) + 1);');
    expect(run).toContain('refused by Salesforce and left as they were');
  });
  it('History can take a copy back up to the undo cap; beyond it the entry says why and points at the receipt', () => {
    expect(FC).toContain('const FC_COPY_UNDO = 1000;');
    expect(run).toContain('if (wr && wr.accepted && wrote.length && wrote.length <= FC_COPY_UNDO) {');
    expect(run).toContain('[to]: t.was == null ? null : t.was');
    expect(run).toContain('History keeps no undo at that size; the receipt CSV lists every record');
  });
});

// ── One card per flow, a choice per item (user 2026-10-05) ───────────────────
// Screenshot: "Replace in all 5 Flows" fixed the flow, then ran the fix again
// for each of its other version rows — all deleted by then — and printed "Could
// not resolve the flow definition of this version" beside rows that read done.
// And: "its very confusing. i dont know what was deleted, what was changed to
// a new active flow version. also if i want to replace only one of them it
// will replace them all. some i want to be able to delete and some to replace".
describe('a flow is ONE item — before the fix it says what happens to each version', () => {
  const F = extractFunctions('sftk-flowsurgery.js', ['sftkFlowCardLines', 'sftkFlowDoneLines']);
  const V = (num, status) => ({ num, status });
  it('the active version, a newer draft and the old versions each get their own sentence', () => {
    const c = F.sftkFlowCardLines([V(11, 'Active'), V(12, 'Draft'), V(10, 'Obsolete'), V(9, 'Obsolete')], { swapTo: 'New__c' });
    expect(c.hasActive).toBe(true);
    expect(c.lines.map(l => l.vers)).toEqual(['v11 · Active', 'v12 · Draft', 'v10, v9 · not active']);
    expect(c.lines[0].text).toContain('⇄ Replace saves a new active version that uses New__c; the flow keeps running.');
    expect(c.lines[0].text).toContain('✂ Remove · flow keeps running saves a new active version without the field.');
    expect(c.lines[0].text).toContain('🗑 Delete versions · flow off switches the flow off instead.');
    expect(c.lines[0].text).not.toContain('you choose in the dialog');
    expect(c.lines[0].text).toContain('Either way v11 itself is deleted afterwards.');
    expect(c.lines[1].text).toContain('saves the new version OVER this draft');
    expect(c.lines[2].text).toContain('deleted.');
  });
  it('without a replacement field the two ways to remove are described, and no ⇄', () => {
    const c = F.sftkFlowCardLines([V(3, 'Active')], {});
    expect(c.lines[0].text).not.toContain('⇄');
    expect(c.lines[0].text).toContain('✂ Remove · flow keeps running saves a new active version without the field.');
    expect(c.lines[0].text).toContain('🗑 Delete versions · flow off');
  });
  it('a draft OLDER than the active version is just an old version', () => {
    expect(F.sftkFlowCardLines([V(3, 'Active'), V(2, 'Draft')], {}).lines.map(l => l.vers)).toEqual(['v3 · Active', 'v2 · not active']);
  });
  it('no active version uses the field → nothing to replace, the old versions are deleted', () => {
    const c = F.sftkFlowCardLines([V(2, 'Obsolete'), V(1, 'Obsolete')], { swapTo: 'New__c' });
    expect(c.hasActive).toBe(false);
    expect(c.lines).toEqual([{ vers: 'v2, v1 · not active', text: 'deleted. No version that runs uses the field, so nothing is replaced and no new version is made.' }]);
  });
});

describe('a flow is ONE item — after the fix it says what happened, one fact per line', () => {
  const F = extractFunctions('sftk-flowsurgery.js', ['sftkFlowCardLines', 'sftkFlowDoneLines']);
  const plan = { toDelete: [{ id: 'a', num: 9, status: 'Obsolete' }, { id: 'b', num: 11, status: 'Active' }, { id: 'n', num: 12, status: 'Draft' }], cleanInactive: 1 };
  it('which version runs now, that a draft was saved over, which versions are gone — the running one is never listed as deleted', () => {
    const lines = F.sftkFlowDoneLines({ mode: 'active', newVersion: 12, newId: 'n', overwrote: true, swapped: 4, interviewsDeleted: 5 }, plan, { swapTo: 'New__c', field: 'Old__c' });
    expect(lines.map(l => l.text)).toEqual([
      'v12 is the ACTIVE version now — 4 references in it point at New__c. Verified by re-reading the org.',
      'v12 was a draft before: Salesforce saved the new version over it, so the draft’s own content is gone.',
      'Deleted: v9, v11 (was the active version).',
      '5 flow interviews on those versions deleted.',
      '1 other version never mentioned the field and was left alone.',
    ]);
  });
  it('a removal says "saved without the field reference"; switching off says the flow no longer runs', () => {
    expect(F.sftkFlowDoneLines({ mode: 'active', newVersion: 4, newId: 'x' }, { toDelete: [{ id: 'o', num: 3, status: 'Active' }] }, {})[0].text)
      .toBe('v4 is the ACTIVE version now — saved without the field reference. Verified by re-reading the org.');
    expect(F.sftkFlowDoneLines({ mode: 'active-delete' }, { toDelete: [{ id: 'o', num: 3, status: 'Active' }] }, {}).map(l => l.text))
      .toEqual(['The flow is switched OFF: no version is active, so it no longer runs. Verified by re-reading the org.', 'Deleted: v3 (was the active version).']);
  });
  it('a leftover mention is a warning line, never hidden', () => {
    const l = F.sftkFlowDoneLines({ mode: 'active', newVersion: 2, newId: 'x', stillMentions: true }, { toDelete: [] }, {});
    expect(l[l.length - 1]).toMatchObject({ warn: true });
  });
});

describe('Field Cleaner — the choice is made per item, by the button pressed', () => {
  const FC = read('field-cleaner.js');
  it('the run follows the button, not the mode: replace mode alone moves nothing', () => {
    expect(FC).toContain('function _swapOn() { return _fixSwap === true && _replOn(); }');
    expect(FC).toContain('_fixSwap = !!swap && _replOn();');
    expect(FC).toContain("finally { _fixSwap = null; _fixWay = ''; }");
    // every fix path asks _swapOn(), none asks the mode
    expect((FC.match(/const swap = _swapOn\(\);/g) || []).length).toBe(3);                 // layout, Lightning page, report
    expect(FC).toContain("const swap = _swapOn() && (type !== 'Flow' || flowPlan.plan.mode === 'active');");
    expect(FC).toContain('const swapping = _swapOn();');
    expect(FC).not.toMatch(/const swap(ping)? = _replOn\(\)/);
  });
  it('the click carries the choice; one listener serves buttons that are re-drawn', () => {
    expect(FC).toContain("fixOne(one.dataset.type, one.dataset.id, one.dataset.name, _curFieldId, one.dataset.swap === '1', one.dataset.way || '');");
    expect(FC).toContain("if (!results.dataset.fcFixWired) {");
    expect(FC).toContain("if (_fixSwap !== null) return;");                                  // one fix at a time
  });
  it('a flow with no active version that uses the field offers only "delete the old versions"', () => {
    expect(FC).toContain('if (card && !card.active) {');
    expect(FC).toContain('🗑 Delete ${card.versions.length} old version${card.versions.length === 1 ? \'\' : \'s\'}</button>`;');
  });
  it('the list shows one card per flow, and counts flows — not versions', () => {
    expect(FC).toContain("${type === 'Flow' ? _flowCards.map(renderFlowCard).join('') : items.map(d => renderItem(d, cfg.fixable, type)).join('')}");
    expect(FC).toContain("const nItems = type === 'Flow' ? _flowCards.length : items.length;");
    expect(FC).toContain('const shownCount = deps.length - flowExtra;');
    expect(FC).toContain("const noun = type === 'Flow' ? `flow${n === 1 ? '' : 's'}` : esc(label);");
  });
  it('"… all N" goes item by item in the way its button says, and a flow is asked about once', () => {
    const all = FC.slice(FC.indexOf('async function fixAll(type, fieldId, swap) {'), FC.indexOf('// extraLinksHtml (C5a)'));
    expect(all).toContain('? _flowCards.map(c => ({ id: c.primaryId, name: c.name }))');
    expect(all).toContain("if (eid(`fcItem_${it.id}`)?.classList.contains('fc-item-fixed')) continue;");
    expect(all).toContain("if ((await fixOne(type, it.id, it.name, fieldId, swap)) === 'cancel') return 'cancel';");
  });
  it('a settled item cannot be fixed again from anywhere', () => {
    expect(FC).toContain("if (eid(`fcItem_${componentId}`)?.classList.contains('fc-item-fixed')) return;");
  });
  it('the result of a flow is one statement with its facts listed — not the same sentence on every version row', () => {
    expect(FC).toContain("label = r.mode === 'active' ? `✅ Done — v${r.newVersion} is the active version now`");
    expect(FC).toContain('doneHtml = `<ul class="fc-flow-done">${sftkFlowDoneLines(r, chosen.plan, { swapTo, field: _selField.api })');
    expect(FC).toContain('markFixed(componentId, label, doneLinks, doneHtml);');
  });
});

describe('Field Cleaner — small truths of the two-button list', () => {
  const FC = read('field-cleaner.js');
  it('the "… all N" buttons count what is still open and go away when one or none is left', () => {
    expect(FC).toContain("const open = item.closest('.fc-group').querySelectorAll('.fc-fix-pair').length;");
    expect(FC).toContain('if (open < 2) box.remove();');
  });
  it('in replace mode the group note says what each of the two buttons does', () => {
    expect(FC).toContain("`⇄ Replace: ${cfg.replNote.replace('{new}', _replField.api)} ✂ Remove: ${cfg.note}`");
  });
});

// User 2026-10-05: "only one thing is missing now, remove all and replace all".
describe('Field Cleaner — everything at once', () => {
  const FC = read('field-cleaner.js');
  it('one button per way for every fixable item, whatever its kind; Replace all only in replace mode', () => {
    expect(FC).toContain('data-swap="1" title="${tip}">⇄ Replace all ${n}</button>` : \'\'}');
    expect(FC).toContain('data-swap="0" title="${tip}">✂ Remove all ${n}</button>');
    expect(FC).toContain("if (n < 2) return '<div id=\"fcFixEvery\" style=\"display:none\"></div>';");
  });
  it('it walks group by group through the same per-item fix — every item still confirms', () => {
    const fn = FC.slice(FC.indexOf('async function fixEverything(fieldId, swap) {'), FC.indexOf("// An item's buttons while its fix works"));
    expect(fn).toContain('for (const type of Object.keys(_groups)) {');
    expect(fn).toContain('if (!(TYPE_CFG[type] || TYPE_CFG_DEFAULT).fixable) continue;');
    expect(fn).toContain("if ((await fixAll(type, fieldId, swap)) === 'cancel') break;");
    expect(fn).not.toContain('sftkWriteVerified');           // it writes nothing itself
  });
  it('Cancel in any dialog stops the walk instead of asking again for every item', () => {
    expect(FC).toContain("if (!sure) return 'cancel';");
    expect(FC).toContain("if ((await fixOne(type, it.id, it.name, fieldId, swap)) === 'cancel') return 'cancel';");
  });
  it('the count is what is still open, and follows every fix and every mode change', () => {
    expect(FC).toContain("el.outerHTML = _fixEveryHtml(document.querySelectorAll('#fcResults .fc-fix-pair').length);");
    expect((FC.match(/_refreshFixEvery\(\);/g) || []).length).toBeGreaterThanOrEqual(3);
  });
});

// User 2026-10-05, on the flow cards: "in the flows, the user should also have a
// small decision to make. remove the field, and create a new active version
// without him. remove the field and delete everything including the active
// versions. in a replace we will just create a new active version with the new
// field". The decision used to be two radio buttons inside the confirmation.
describe('a flow that runs on the field — the decision is made on its card', () => {
  const FC = read('field-cleaner.js');
  const btns = FC.slice(FC.indexOf('function _fixBtnsHtml('), FC.indexOf('function _fixAllHtml('));
  it('two ways to remove, one button each; ⇄ Replace joins them when a replacement is picked', () => {
    expect(btns).toContain('data-swap="0" data-way="keep"');
    expect(btns).toContain('✂ Remove · flow keeps running</button>');
    expect(btns).toContain('data-swap="0" data-way="off"');
    expect(btns).toContain('🗑 Delete versions · flow off</button>');
    expect(btns).toContain('return move + keep + off;');
    expect(btns).toContain("const move = _replOn() ? `<button class=\"btn btn-primary btn-sm fc-fix-btn\" ${attrs} data-swap=\"1\"");
  });
  it('the button pressed is the way: nothing is asked again in the dialog', () => {
    expect(FC).toContain("_fixWay = (way === 'keep' || way === 'off') ? way : '';");
    expect(FC).toContain("const preset = !hasChoice ? '' : (swap || _fixWay === 'keep') ? 'replace' : _fixWay === 'off' ? 'delete' : '';");
    expect(FC).toContain('if (preset) activeMode = preset;');
    expect(FC).toContain('const asks = hasChoice && !preset;');
    expect(FC).toContain('if (!asks) return;');
    expect(FC).toContain('_flowChoiceHtml(flowPlan, componentName, canReplace, preset)');
  });
  it('a replace has nothing to choose: its dialog section carries no radio at all', () => {
    const sw = FC.slice(FC.indexOf('function _flowSwapHtml('), FC.indexOf('const _chainKey ='));
    expect(sw).not.toContain('fcActiveMode');
    expect(sw).toContain('A replace has nothing else to choose.');
  });
  it('🗑 shows the delete plan: its own version list, its own lines, its own button text', () => {
    expect(FC).toContain("const shownPlan = preset === 'delete' ? flowPlan.planDelete : (flowPlan ? flowPlan.plan : null);");
    expect(FC).toContain("(asks && !activeMode ? [] : activeMode === 'delete' ? flowPlan.linesDelete : flowPlan.lines)");
    expect(FC).toContain("preset === 'delete' ? '🗑 Switch the flow off, then delete'");
    expect(FC).toContain('<b>The flow stops running.</b> It is switched off, the org is read again to confirm that nothing is active');
  });
  it('a way that cannot work is refused BEFORE the dialog, with nothing changed', () => {
    const i = FC.indexOf("if (preset === 'replace' && !canReplace) {");
    expect(i).toBeGreaterThan(0);
    const win = FC.slice(i, FC.indexOf('if (preset) activeMode = preset;', i));
    expect(win).toContain('appendInlineError(componentId, swap');
    // three refusals since QA 2026-10-06: nothing to take out (remove / swap), and an element left empty
    expect((win.match(/Nothing was changed\./g) || []).length).toBe(3);
    expect(win).toContain('return;');
    expect(i).toBeLessThan(FC.indexOf('const sure = await sftkConfirmDestructive({', i));
  });
  it('a walk over many items made no decision, so its dialog still asks (the two radios stay)', () => {
    const ch = FC.slice(FC.indexOf('function _flowChoiceHtml('), FC.indexOf('function _flowSwapHtml('));
    expect(ch).toContain('name="fcActiveMode" value="replace"');
    expect(ch).toContain('name="fcActiveMode" value="delete"');
    expect(ch).toContain("${preset === 'replace' ? `<div class=\"fc-prev-hd\">The active version — the flow keeps running</div>");
  });
  it('the busy text lands on the button that was pressed, not on its neighbour', () => {
    expect(FC).toContain("(!b.dataset.way || !_fixWay || b.dataset.way === _fixWay)) b.textContent = text;");
  });
});
