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
  it('a button says what it will do: an inactive flow version is only ever removed', () => {
    expect(FC).toContain("return vi && vi.status !== 'Active' ? '✂ Remove' : '⇄ Replace';");
    expect(FC).not.toContain("textContent = '✂ Remove'; }");            // no path puts the old word back blindly
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

