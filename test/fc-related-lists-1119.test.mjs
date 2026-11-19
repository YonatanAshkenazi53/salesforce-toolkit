// owner 2026-11-18/19 ("Go" · "Continue please"), the last two parts of the regular scan's "breaks later" pass:
//   · a column of this object's related list on a PARENT's page layout   → 👀 Related-list columns, ✂ / ⇄
//   · a list view of a CHILD object that shows this field through its lookup → 👀 List Views, ✂ / ⇄ / 🗑
// Live on npc2 (docs/fixtures/gap-kinds-fixture/kinds-app: Account layout "SFTK Kind RL Layout", object
// SFTK_Kind_Child__c with the view SFTK_Kind_Child_LV; OBJ=SFTK_Kind__c FIELD=Tag__c RUN=2 scripts/dev/live/fc-plan.mjs):
// both listed, both removed and verified by re-read, ↩ Undo all 2 of 2.
// Read live the same day: such a view DEPLOYS with <columns>SFTK_Kind__c.Tag__c</columns> (Kind__r.Tag__c and
// Kind__c.Tag__c are refused), comes BACK as <columns>01Ibm00000EVKon.Tag__c</columns> (the parent's id), and that id
// form is REFUSED on a deploy — so a view is turned back to names when it is read.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const F = extractFunctions('field-cleaner.js', ['fcRelatedListIsOf', 'fcRelatedListEdit', 'fcListViewNamesQualified', 'fcChildHasListViews']);

describe('a related list of this object on a parent’s layout', () => {
  it('is told by its name: a custom child is "Child__c.Lookup__c", a standard child "Related<Object>List"', () => {
    expect(F.fcRelatedListIsOf('SFTK_Kind__c.Acct__c', 'SFTK_Kind__c')).toBe(true);
    expect(F.fcRelatedListIsOf('RelatedContactList', 'Contact')).toBe(true);
    expect(F.fcRelatedListIsOf('SFTK_Kind_Child__c.Kind__c', 'SFTK_Kind__c')).toBe(false);
    expect(F.fcRelatedListIsOf('RelatedOpportunityList', 'Contact')).toBe(false);
    expect(F.fcRelatedListIsOf('', 'Contact')).toBe(false);
  });
  const layout = () => ({ relatedLists: [
    { relatedList: 'SFTK_Kind__c.Acct__c', fields: ['NAME', 'Tag__c', 'Pick__c'], sortField: 'Tag__c', sortOrder: 'Asc' },
    { relatedList: 'RelatedContactList', fields: ['FULL_NAME', 'Tag__c'] },
  ] });
  it('✂ takes the column out of this object’s lists only, and the sort on it with it', () => {
    const m = layout();
    expect(F.fcRelatedListEdit(m, 'SFTK_Kind__c', 'Tag__c', null)).toBe(1);
    expect(m.relatedLists[0]).toEqual({ relatedList: 'SFTK_Kind__c.Acct__c', fields: ['NAME', 'Pick__c'] });
    expect(m.relatedLists[1].fields).toEqual(['FULL_NAME', 'Tag__c']);      // Contact's same-named field stays
    expect(F.fcRelatedListEdit(m, 'SFTK_Kind__c', 'Tag__c', null)).toBe(0);  // nothing left: the verify's own check
  });
  it('⇄ puts the new field in the column’s place — or just drops the old one when the list shows the new already', () => {
    const a = layout();
    expect(F.fcRelatedListEdit(a, 'SFTK_Kind__c', 'Tag__c', 'Tag2__c')).toBe(1);
    expect(a.relatedLists[0]).toEqual({ relatedList: 'SFTK_Kind__c.Acct__c', fields: ['NAME', 'Tag2__c', 'Pick__c'], sortField: 'Tag2__c', sortOrder: 'Asc' });
    const b = layout();
    expect(F.fcRelatedListEdit(b, 'SFTK_Kind__c', 'Tag__c', 'Pick__c')).toBe(1);
    expect(b.relatedLists[0].fields).toEqual(['NAME', 'Pick__c']);
  });
  it('a layout without the column, or without related lists, is not touched', () => {
    expect(F.fcRelatedListEdit({ relatedLists: [{ relatedList: 'SFTK_Kind__c.Acct__c', fields: ['NAME'] }] }, 'SFTK_Kind__c', 'Tag__c', null)).toBe(0);
    expect(F.fcRelatedListEdit({}, 'SFTK_Kind__c', 'Tag__c', null)).toBe(0);
    expect(F.fcRelatedListEdit(null, 'SFTK_Kind__c', 'Tag__c', null)).toBe(0);
  });
  it('the fix writes the layout the way a layout fix does, re-reads it, and its undo looks inside the related list', () => {
    const f = FC.slice(FC.indexOf('async function fixLayoutRelatedList('), FC.indexOf('  async function fixLayout(componentId, componentName) {'));
    expect(f).toContain("await _snapshotFix('Layout', componentId, componentName, fullName, metadata);");
    expect(f).toContain('patchRes = await patchLayoutMetadata(componentId, sanitizeLayoutMetadata(metadata));');
    expect(f).toContain('const left = fcRelatedListEdit(JSON.parse(JSON.stringify(after.Metadata)), obj, field, null);');
    expect(f).toContain('delete st.verify.strip;');
  });
});

describe('a list view of a child object that shows this field', () => {
  it('is found by "Object.Field" — and by the parent’s id, the form Salesforce hands back', () => {
    const lv = c => `<fullName>V</fullName><columns>NAME</columns><columns>${c}</columns><label>V</label>`;
    expect(F.fcListViewNamesQualified(lv('SFTK_Kind__c.Tag__c'), 'SFTK_Kind__c', 'Tag__c')).toBe(true);
    expect(F.fcListViewNamesQualified(lv('01Ibm00000EVKon.Tag__c'), 'SFTK_Kind__c', 'Tag__c', '01Ibm00000EVKon')).toBe(true);
    expect(F.fcListViewNamesQualified(lv('01Ibm00000EVKon.Tag__c'), 'SFTK_Kind__c', 'Tag__c', '01Ibm00000EVKonAAH')).toBe(true);
    expect(F.fcListViewNamesQualified('<filters><field>SFTK_Kind__c.Tag__c</field><operation>equals</operation></filters>', 'SFTK_Kind__c', 'Tag__c')).toBe(true);
  });
  it('not by a bare name (the child’s own field), another parent, or another id', () => {
    const lv = c => `<columns>${c}</columns>`;
    expect(F.fcListViewNamesQualified(lv('Tag__c'), 'SFTK_Kind__c', 'Tag__c', '01Ibm00000EVKon')).toBe(false);
    expect(F.fcListViewNamesQualified(lv('Other__c.Tag__c'), 'SFTK_Kind__c', 'Tag__c')).toBe(false);
    expect(F.fcListViewNamesQualified(lv('01Ibm00000ZZZZZ.Tag__c'), 'SFTK_Kind__c', 'Tag__c', '01Ibm00000EVKon')).toBe(false);
    expect(F.fcListViewNamesQualified(lv('SFTK_Kind__c.Tag__c'), 'SFTK_Kind__c', '')).toBe(false);
  });
  it('the platform’s own children (feeds, shares, history, attachments, approvals) are not read', () => {
    for (const k of ['SFTK_Kind_Child__c', 'Contact', 'Opportunity', 'Case']) expect(F.fcChildHasListViews(k), k).toBe(true);
    for (const k of ['SFTK_Kind__Share', 'SFTK_Kind__Feed', 'SFTK_Kind__History', 'ContentDocumentLink', 'ProcessInstance', 'TopicAssignment', 'AttachedContentDocument', 'EntitySubscription', 'Note', '']) expect(F.fcChildHasListViews(k), k).toBe(false);
  });
  it('a view read for an edit, a restore point or an undo has the ids turned back to names — Salesforce refuses the id on a deploy', () => {
    expect(FC).toContain("if (type === 'ListView' && got && got.rec && got.rec.innerXml) got.rec = { ...got.rec, innerXml: await _lvNamesForIds(got.rec.innerXml) };");
    expect(FC).toContain('query: `SELECT DurableId, QualifiedApiName FROM EntityDefinition WHERE DurableId IN (${need.map(i => `\'${i}\'`).join(\',\')})` });');
  });
});

describe('the engine and a list view of another object', () => {
  // the whole engine file, as test/regress-1115-mdapi does
  const M = new Function(`${readFileSync(new URL('../sftk-mdapi.js', import.meta.url), 'utf8')}\nreturn { sftkMdEditField, sftkMdKnowObjId };`)();
  it('a custom parent handed back by its id ("01I….Field") is this field too, once the page told the engine the id', () => {
    M.sftkMdKnowObjId('SFTK_Kind__c', '01Ibm00000EVKonAAH');
    const r = M.sftkMdEditField('ListView', '<fullName>SFTK_Kind_Child__c.V</fullName><columns>NAME</columns><columns>01Ibm00000EVKon.Tag__c</columns><label>V</label>', 'SFTK_Kind__c', 'Tag__c', null);
    expect(r.refused).toBeFalsy();
    expect(r.xml).not.toContain('Tag__c</columns>');
  });
  const view = cols => `<fullName>SFTK_Kind_Child__c.V</fullName>${cols.map(c => `<columns>${c}</columns>`).join('')}<filterScope>Everything</filterScope><label>V</label>`;
  it('✂ takes out "Object.Field" and leaves the child’s own same-named column', () => {
    const r = M.sftkMdEditField('ListView', view(['NAME', 'Tag__c', 'SFTK_Kind__c.Tag__c']), 'SFTK_Kind__c', 'Tag__c', null);
    expect(r.refused).toBeFalsy();
    expect(r.xml).toContain('<columns>Tag__c</columns>');
    expect(r.xml).not.toContain('SFTK_Kind__c.Tag__c');
  });
  it('a view that only has the child’s own same-named column is refused, with the reason', () => {
    const r = M.sftkMdEditField('ListView', view(['NAME', 'Tag__c']), 'SFTK_Kind__c', 'Tag__c', null);
    expect(r.refused).toMatch(/SFTK_Kind_Child__c’s same-named field/);
    expect(r.xml).toContain('<columns>Tag__c</columns>');
  });
  it('⇄ keeps the "Object." in front of the new field', () => {
    const r = M.sftkMdEditField('ListView', view(['NAME', 'SFTK_Kind__c.Tag__c']), 'SFTK_Kind__c', 'Tag__c', 'Tag2__c');
    expect(r.refused).toBeFalsy();
    expect(r.xml).toContain('<columns>SFTK_Kind__c.Tag2__c</columns>');
  });
});
