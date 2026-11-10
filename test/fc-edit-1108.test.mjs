// ✂ Remove / ⇄ Replace INSIDE a blocker, its XML kept whole (user 2026-11-07: "Remember that we try to
// remove, replace the field in the metadata items without breaking them. While showing XML").
// One pure test per kind, on the XML the demo org returned (test/fixtures/md-edit, read live 2026-11-08
// through the extension's own SF_MD_READ), plus the wiring pins.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const M = extractFunctions('sftk-mdapi.js', ['sftkMdEditField', 'sftkFormulaDropField', 'sftkMdEditWays', 'sftkMdPretty', 'sftkMdLineDiff', '_sftkMdFieldIs', '_sftkMdRenameVal', '_sftkMdWalk',
  '_sftkMdSwapToken', '_sftkMdHasLogic', 'sftkMdFindElement', 'sftkMdUnescape', 'sftkMdEscape', 'sftkMdChildText', 'sftkMdLeadMappingRemove', 'sftkMdMentionsField', 'sftkMdPackageFiles',
  'sftkMdDeleteSpec', '_sftkMdDeleteTable', '_sftkPkgXml', 'sftkMdRecordFileXml']);
const X = n => readFileSync(new URL(`./fixtures/md-edit/${n}.xml`, import.meta.url), 'utf8');
const O = 'Account', F = 'SFTK_Live_Blk__c', N = 'SFTK_Live_Blk2__c';
const rm = (t, x) => M.sftkMdEditField(t, x, O, F, null);
const rp = (t, x) => M.sftkMdEditField(t, x, O, F, N);
// after a Replace nothing names the old field and the new one is there; everything else is byte for byte
const swapped = (before, after) => {
  expect(after).not.toMatch(/SFTK_Live_Blk__c/);
  expect(after.replace(/SFTK_Live_Blk2__c/g, F)).toBe(before);
};

describe('every kind of the demo field, ✂ and ⇄', () => {
  it('validation rule: ✂ suggests the formula without the condition that uses the field (switch-off only when nothing is left), ⇄ swaps the token — on the object and across a relationship', () => {
    const vr = X('ValidationRule.Account.SFTK_Live_VR');
    const r = rm('ValidationRule', vr);
    expect(r.refused).toBeNull();
    // ISBLANK(field) && FALSE → FALSE; the rule stays active
    expect(r.xml).toBe(vr.replace('ISBLANK(SFTK_Live_Blk__c) &amp;&amp; FALSE', 'FALSE'));
    expect(r.suggested).toBe(true); expect(r.off).toBe(false);
    expect(r.how[0]).toMatch(/^suggested: 1 condition that uses the field taken out/);
    // the field in every condition: the suggestion is to switch the rule off, the formula untouched
    const only = vr.replace('ISBLANK(SFTK_Live_Blk__c) &amp;&amp; FALSE', 'ISBLANK(SFTK_Live_Blk__c)');
    const o = rm('ValidationRule', only);
    expect(o.xml).toBe(only.replace('<active>true</active>', '<active>false</active>'));
    expect(o.off).toBe(true); expect(o.how[0]).toMatch(/^suggested: switch the rule off/);
    swapped(vr, rp('ValidationRule', vr).xml);
    const x = X('ValidationRule.Contact.SFTK_Live_XVR');
    expect(rp('ValidationRule', x).xml).toContain('Account.SFTK_Live_Blk2__c = &apos;never@sftk.invalid&apos;');
    expect(rm('ValidationRule', vr.replace('<active>true</active>', '<active>false</active>')).refused).toMatch(/already inactive/);
  });
  it('formula field: ⇄ only; ✂ is refused with the way that works', () => {
    const f = X('CustomField.Account.SFTK_Live_Formula__c');
    expect(rm('CustomField', f).refused).toMatch(/formula cannot lose a reference — ⇄ Replace/);
    swapped(f, rp('CustomField', f).xml);
    const xf = X('CustomField.Contact.SFTK_Live_XFormula__c');
    expect(rp('CustomField', xf).xml).toContain('<formula>Account.SFTK_Live_Blk2__c</formula>');
  });
  it('lookup filter: its only condition gone → the whole filter goes, the field stays; ⇄ renames the condition', () => {
    const lk = X('CustomField.Contact.SFTK_Live_Lk__c');
    const r = rm('LookupFilter', lk);
    expect(r.xml).not.toContain('<lookupFilter>');
    expect(r.xml).toContain('<referenceTo>Account</referenceTo>');
    swapped(lk, rp('LookupFilter', lk).xml);
    // a second condition stays, a numbered logic refuses ✂
    const two = lk.replace('</filterItems>', '</filterItems><filterItems><field>Account.Name</field><operation>notEqual</operation><value>x</value></filterItems>');
    expect(rm('LookupFilter', two).xml).toContain('<lookupFilter><active>true</active><errorMessage>SFTK live demo</errorMessage><filterItems><field>Account.Name</field>');
    expect(rm('LookupFilter', two.replace('<errorMessage>', '<booleanFilter>1 OR 2</booleanFilter><errorMessage>')).refused).toMatch(/logic numbers/);
  });
  it('button and scoping rule: ⇄ only — the URL merge field and the record filter swap their token', () => {
    const b = X('WebLink.Account.SFTK_Live_Btn');
    expect(rm('WebLink', b).refused).toMatch(/URL cannot lose a merge field/);
    expect(rp('WebLink', b).xml).toContain('<url>https://example.invalid/?x={!Account.SFTK_Live_Blk2__c}</url>');
    const sc = X('RestrictionRule.SFTK_Live_Scope');
    expect(rm('RestrictionRule', sc).refused).toMatch(/record filter/);
    swapped(sc, rp('RestrictionRule', sc).xml);
  });
  it('field update: it WRITES to the field — ✂ refused, ⇄ points it at the new field', () => {
    const fu = X('WorkflowFieldUpdate.Account.SFTK_Live_FU');
    expect(rm('WorkflowFieldUpdate', fu).refused).toMatch(/WRITES to this field/);
    swapped(fu, rp('WorkflowFieldUpdate', fu).xml);
  });
  it('workflow rule, sharing rule, matching rule, email alert, approval process: the field is the only criterion → ✂ refused (it would match everything), ⇄ works', () => {
    for (const [t, n, why] of [['WorkflowRule', 'WorkflowRule.Account.SFTK_Live_WR', /fire on every record/], ['SharingCriteriaRule', 'SharingCriteriaRule.Account.SFTK_Live_SR', /share every record/],
      ['MatchingRule', 'MatchingRule.Account.SFTK_Live_MR2', /needs at least one/], ['WorkflowAlert', 'WorkflowAlert.Account.SFTK_Live_Alert', /only recipient/],
      ['ApprovalProcess', 'ApprovalProcess.Account.SFTK_Live_AP', /EVERY record could enter/]]) {
      const x = X(n);
      expect(rm(t, x)).toMatchObject({ changed: false, xml: x });
      expect(rm(t, x).refused).toMatch(why);
      swapped(x, rp(t, x).xml);
    }
  });
  it('with a second criterion the field’s line goes and the rest stays; filter logic refuses ✂', () => {
    const wr = X('WorkflowRule.Account.SFTK_Live_WR').replace('</criteriaItems>', '</criteriaItems><criteriaItems><field>Account.Name</field><operation>equals</operation><value>x</value></criteriaItems>');
    const r = rm('WorkflowRule', wr);
    expect(r.refused).toBeNull();
    expect(r.xml).toContain('<active>false</active><criteriaItems><field>Account.Name</field>');
    expect(M.sftkMdMentionsField(r.xml, O, F)).toBe(false);
    expect(rm('WorkflowRule', wr.replace('<description>', '<booleanFilter>1 AND 2</booleanFilter><description>')).refused).toMatch(/logic numbers/);
    const al = X('WorkflowAlert.Account.SFTK_Live_Alert').replace('</recipients>', '</recipients><recipients><type>owner</type></recipients>');
    expect(rm('WorkflowAlert', al).xml).toContain('<recipients><type>owner</type></recipients>');
  });
  it('outbound message and field set: ✂ takes the member out, ⇄ renames it', () => {
    const om = X('WorkflowOutboundMessage.Account.SFTK_Live_OM');
    expect(rm('WorkflowOutboundMessage', om).xml).toBe(om.replace('<fields>SFTK_Live_Blk__c</fields>', ''));
    swapped(om, rp('WorkflowOutboundMessage', om).xml);
    expect(rm('WorkflowOutboundMessage', om.replace('<fields>Id</fields>', '')).refused).toMatch(/only one the message sends/);
    const fs = X('FieldSet.Account.SFTK_Live_FS');
    expect(rm('FieldSet', fs).xml).not.toContain('<displayedFields>');
    swapped(fs, rp('FieldSet', fs).xml);
  });
  it('custom metadata record: ✂ empties the value (nil), ⇄ writes the new name in the same spelling', () => {
    const c = X('CustomMetadata.SFTK_Live_Cmt.Ref');
    expect(rm('CustomMetadataRecord', c).xml).toContain('<values><field>Field__c</field><value xsi:nil="true"/></values>');
    expect(rp('CustomMetadataRecord', c).xml).toContain('<value xsi:type="xsd:string">SFTK_Live_Blk2__c</value>');
    expect(rp('CustomMetadataRecord', c).xml).toContain('<value xsi:type="xsd:string">Account</value>');
  });
  it('duplicate rule: ✂ / ⇄ / ✎ like every other kind (user 2026-11-08: "צריך להיות בכולם") — the run-time rule stays in the words', () => {
    const d = X('DuplicateRule.Account.SFTK_Live_DR');
    swapped(d, rp('DuplicateRule', d).xml);
    expect(FC).toContain("const ways = (knownKind && typeof sftkMdEditWays === 'function') ? sftkMdEditWays(type) : null;");   // blockers and the 👀 mention kinds the engine knows (2026-11-08)
    expect(FC).not.toContain("type !== 'DuplicateRule'");
    expect(FC).toContain("if (!ways) throw new Error(");
    expect(FC).not.toContain("const dupe = type === 'DuplicateRule';");
    expect(FC).toContain('nothing switches a rule off or edits one behind a deployment');
  });
  it('lead mapping and assignment-style rules: an entry that loses its only criterion is dropped, the last entry refuses', () => {
    const lcs = '<fullName>LeadConvertSettings</fullName><objectMapping><inputObject>Lead</inputObject><mappingFields><inputField>SFTK_Live_Blk__c</inputField><outputField>SFTK_Live_Blk__c</outputField></mappingFields><outputObject>Account</outputObject></objectMapping>';
    expect(rp('LeadConvertSettings', lcs).xml).toContain('<inputField>SFTK_Live_Blk__c</inputField><outputField>SFTK_Live_Blk2__c</outputField>');
    expect(M.sftkMdEditField('LeadConvertSettings', lcs, 'Lead', F, 'L2__c').xml).toContain('<inputField>L2__c</inputField><outputField>SFTK_Live_Blk__c</outputField>');
    const ar = '<fullName>SFTK_Live_AR</fullName><active>false</active><ruleEntry><assignedTo>u</assignedTo><criteriaItems><field>Lead.SFTK_Live_Blk__c</field><operation>equals</operation><value>x</value></criteriaItems></ruleEntry>';
    expect(M.sftkMdEditField('AssignmentRule', ar, 'Lead', F, null).refused).toMatch(/every entry of the rule hangs on this field/);
    const two = ar + '<ruleEntry><assignedTo>v</assignedTo><criteriaItems><field>Lead.Status</field><operation>equals</operation><value>y</value></criteriaItems></ruleEntry>';
    const r = M.sftkMdEditField('AssignmentRule', two, 'Lead', F, null);
    expect(r.xml).toBe('<fullName>SFTK_Live_AR</fullName><active>false</active><ruleEntry><assignedTo>v</assignedTo><criteriaItems><field>Lead.Status</field><operation>equals</operation><value>y</value></criteriaItems></ruleEntry>');
    expect(r.how[0]).toMatch(/1 entry whose only criterion it was dropped, 1 entry kept/);
    expect(M.sftkMdEditField('EscalationRule', ar.replace(/AR/g, 'ER'), 'Lead', F, 'L2__c').xml).toContain('<field>Lead.L2__c</field>');
  });
  it('a token swap never touches a longer name or another object’s same-named field path', () => {
    const t = M._sftkMdSwapToken('A__c + AA__c + X.A__c + Account.A__c + A__cx', 'Account', 'A__c', 'B__c');
    expect(t).toEqual({ text: 'B__c + AA__c + X.A__c + Account.B__c + A__cx', n: 2 });
  });
  it('the ways per kind; code and pages have none (🗑 or Setup)', () => {
    expect(M.sftkMdEditWays('WorkflowRule')).toEqual({ remove: true, replace: true });
    expect(M.sftkMdEditWays('WebLink')).toEqual({ remove: false, replace: true });
    for (const t of ['ApexClass', 'ApexPage', 'LightningComponentBundle', 'FlexiPage', 'Flow']) expect(M.sftkMdEditWays(t)).toBeNull();
  });
  it('the edited record deploys as its package file (a child inside its parent, short name)', () => {
    const f = M.sftkMdPackageFiles('WorkflowRule', 'Account.SFTK_Live_WR', rp('WorkflowRule', X('WorkflowRule.Account.SFTK_Live_WR')).xml);
    expect(f[1].name).toBe('workflows/Account.workflow');
    expect(f[1].text).toContain('<rules><fullName>SFTK_Live_WR</fullName><active>false</active><criteriaItems><field>Account.SFTK_Live_Blk2__c</field>');
  });
});

describe('the XML shown: pretty lines and the diff', () => {
  it('one element per line, a leaf with its text on one line', () => {
    expect(M.sftkMdPretty('<a>1</a><b><c>2</c><d/></b>')).toBe('<a>1</a>\n<b>\n  <c>2</c>\n  <d/>\n</b>');
  });
  it('the diff marks only the changed lines', () => {
    expect(M.sftkMdLineDiff('a\nb\nc', 'a\nB\nc')).toEqual([{ op: ' ', line: 'a' }, { op: '-', line: 'b' }, { op: '+', line: 'B' }, { op: ' ', line: 'c' }]);
  });
});

describe('the wiring', () => {
  it('✂/⇄ buttons are on the row (data-way="edit"), never in the walks; the press goes to fixEdit', () => {
    expect(FC).toContain('fc-fix-btn fc-edit-btn" ${attrs} data-swap="1" data-way="edit"');
    expect(FC).toContain('fc-fix-btn fc-edit-btn" ${attrs} data-swap="0" data-way="edit"');
    expect(FC).toContain("if (!cfgT.fixable) return codeEdits + edits + del;");
    expect(FC).toContain("const r = await fixEdit(type, componentId, componentName, _fixSwap === true);");
    expect(FC).toContain("results.querySelectorAll('.fc-fix-pair, .fc-del-pair').forEach(p =>");
  });
  it('fixEdit: refusal before any dialog, the diff in the dialog, restore point, deploy, re-read, History undo', () => {
    expect(FC).toContain('if (ed.refused || !ed.changed) {');
    expect(FC).toContain('extraHtml: `<div class="fc-xml-diff-hd">The XML');
    expect(FC).toContain("await _snapshotFix('MdEdit', componentId, componentName, fullName,");
    expect(FC).toContain(": !_editStillNames(type, after, field) && (!nf || _editStillNames(type, after, nf));");
    expect(FC).toContain("msg: { type: 'SF_METADATA_DEPLOY', zipBase64: zipBack },");
    expect(FC).toContain("} else if (snap.type === 'MdDelete' || snap.type === 'MdEdit') {");
  });
  it('assignment, auto-response and escalation rules are read through their container (no readMetadata of their own) — for 🗑 too', () => {
    expect(FC).toContain("const _RULE_CONTAINERS = { AssignmentRule: ['AssignmentRules', 'assignmentRule'], AutoResponseRule: ['AutoResponseRules', 'autoResponseRule'], EscalationRule: ['EscalationRules', 'escalationRule'] };");
    expect(FC).toContain('const rd = await _mdReadOne(type, fullName, spec.mdType);\n    if (!rd || rd.error) throw new Error(');
  });
  it('🔍 for every kind the engine edits: the XML from the Metadata API, the field’s lines marked, the ✂ and ⇄ previews', () => {
    expect(FC).toContain("const canInsp = Object.prototype.hasOwnProperty.call(_INSPECT_SOBJECT, type) || _inspectsByMd(type) || _inspectsByCode(type) || type === 'EmailTemplate';");
    expect(FC).toContain('if (_inspectsByMd(type)) { await _xmlInspectMd(type, componentId, componentName, panel, inspBtn); return; }');
    expect(CSS).toContain('body.sftk-dark { --code-bg: #1A1D24; }');
  });
});

describe('custom metadata records: a bare field name belongs to the object the record names (QA 2026-11-08)', () => {
  const V = extractFunctions('sftk-mdapi.js', ['sftkMdValuesHolding', 'sftkMdChildren', 'sftkMdChildText', 'sftkMdFindElement', 'sftkMdUnescape']);
  const cmt = readFileSync(new URL('./fixtures/md-edit/CustomMetadata.SFTK_Live_Cmt.Ref.xml', import.meta.url), 'utf8');
  it('Entity__c = Account + Field__c = SFTK_Live_Blk__c is Account\'s field — not Lead\'s, not Case\'s', () => {
    expect(V.sftkMdValuesHolding(cmt, 'Account', 'SFTK_Live_Blk__c')).toEqual(['Field__c']);
    expect(V.sftkMdValuesHolding(cmt, 'Lead', 'SFTK_Live_Blk__c')).toEqual([]);
    expect(V.sftkMdValuesHolding(cmt, 'Case', 'SFTK_Live_Blk__c')).toEqual([]);
  });
  it('a record with no object named keeps the bare match (it could be any object\'s); "Obj.Field" always matches its object', () => {
    expect(V.sftkMdValuesHolding('<values><field>F__c</field><value>X__c</value></values>', 'Lead', 'X__c')).toEqual(['F__c']);
    expect(V.sftkMdValuesHolding('<values><field>E__c</field><value>Account</value></values><values><field>F__c</field><value>Lead.X__c</value></values>', 'Lead', 'X__c')).toEqual(['F__c']);
  });
});
