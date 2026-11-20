// QA 1.1 finding 30: a lookup's relationship spelling (Field__r) and a Contact field's person-account spelling (Field__pc) are searched too.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

const S = extractFunctions('sftk-sweep.js', ['sftkSweepForms', 'sftkSweepHits', 'sftkSweepKindTable', 'sftkSweepSections', '_sftkSweepSectionAt', 'sftkSweepKind', 'sftkSweepRun']);
const NL = '\n';
const run = (forms, files) => S.sftkSweepRun(new Map(files.map(([p, ...lines]) => [p, lines.join(NL)])), forms);
const obj = (...body) => ['<?xml version="1.0" encoding="UTF-8"?>', '<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">', ...body, '</CustomObject>'];

describe('sftkSweepForms — every spelling of the field', () => {
  it('a lookup: Field__c and Field__r; a Contact field also Field__pc', () => {
    expect(S.sftkSweepForms('Contact', 'Parent_Account__c', 'Lookup(Account)').names).toEqual(['Parent_Account__c', 'Parent_Account__r', 'Parent_Account__pc']);
    expect(S.sftkSweepForms('Opportunity', 'Partner__c', 'reference').names).toEqual(['Partner__c', 'Partner__r']);
    expect(S.sftkSweepForms('Opportunity', 'Partner__c', 'Master-Detail(Account)').names).toEqual(['Partner__c', 'Partner__r']);
    expect(S.sftkSweepForms('Opportunity', 'Partner__c').names).toEqual(['Partner__c', 'Partner__r']);   // type unknown: searched
    expect(S.sftkSweepForms('Contact', 'Level__c', 'Picklist').names).toEqual(['Level__c', 'Level__pc']);
    expect(S.sftkSweepForms('Account', 'Level__c', 'Picklist').names).toEqual(['Level__c']);
    expect(S.sftkSweepForms('Account', 'Industry').names).toEqual(['Industry']);                          // a standard field has one name
    expect(S.sftkSweepForms('Contact', 'ns__Level__c', 'Text(80)').names).toEqual(['ns__Level__c', 'ns__Level__pc']);
  });
  it('each spelling is a whole word', () => {
    const F = S.sftkSweepForms('Contact', 'Parent_Account__c', 'Lookup(Account)');
    for (const s of ['Parent_Account__r.Name', '{rec.Parent_Account__r.Name}', 'Account.Parent_Account__pc', 'parent_account__R.Id']) expect(F.re.test(s), s).toBe(true);
    for (const s of ['Parent_Account__rx', 'My_Parent_Account__r', 'Parent_Account__pcx', 'Parent_Account__pr', 'Parent_Account']) expect(F.re.test(s), s).toBe(false);
    expect(F.pc.test('Parent_Account__pc')).toBe(true);
    expect(F.pc.test('Parent_Account__r')).toBe(false);
    expect(S.sftkSweepForms('Account', 'Level__c').pc).toBe(null);
  });
});

describe('sftkSweepRun — the files that only hold the other spellings are hits', () => {
  const F = S.sftkSweepForms('Contact', 'Parent_Account__c', 'Lookup(Account)');
  it('dynamic SOQL in Apex, a formula on the object, an LWC template', () => {
    const r = run(F, [
      ['unpackaged/classes/ContactQuery.cls', 'public class ContactQuery {', "  String q = 'SELECT Parent_Account__r.Name FROM Contact';", '}'],
      ['unpackaged/objects/Contact.object', ...obj('<fields>', '<fullName>Parent_Name__c</fullName>', '<formula>Parent_Account__r.Name</formula>', '</fields>')],
      ['unpackaged/lwc/contactCard/contactCard.html', '<template>', '<p>{rec.Parent_Account__r.Name}</p>', '</template>'],
      ['unpackaged/lwc/contactCard/contactCard.js', "import { LightningElement } from 'lwc';", '// shows a Contact', 'export default class ContactCard extends LightningElement {}'],
      ['unpackaged/classes/Unrelated.cls', 'public class Unrelated { String s = \'Parent_Account__rx\'; }'],
    ]);
    expect(r.filesWithHits).toBe(3);
    const by = Object.fromEntries(r.hits.map(h => [h.path.replace(/^unpackaged\//, ''), h]));
    expect(by['classes/ContactQuery.cls']).toMatchObject({ type: 'ApexClass', sev: 'blocker', line: 2 });
    expect(by['objects/Contact.object']).toMatchObject({ type: 'CustomField', component: 'Contact.Parent_Name__c' });
    expect(r.hits.some(h => h.type === 'SameNameOtherObject')).toBe(false);
    expect(r.hits.some(h => /lwc\/contactCard/.test(h.path))).toBe(true);
  });
  it('the relationship spelling on ANOTHER object is that object’s own, a path through a lookup is kept', () => {
    const r = run(F, [
      ['unpackaged/objects/Opportunity.object', ...obj('<fields>', '<fullName>A__c</fullName>', '<formula>Parent_Account__r.Name</formula>', '</fields>',
        '<fields>', '<fullName>B__c</fullName>', '<formula>Buyer__r.Parent_Account__r.Name</formula>', '</fields>')],
    ]);
    const a = r.hits.find(h => /A__c/.test(h.component)), b = r.hits.find(h => /B__c/.test(h.component));
    expect(a).toMatchObject({ type: 'SameNameOtherObject', section: 'Opportunity’s own field of this name' });
    expect(b).toMatchObject({ type: 'CustomField' });
  });
  it('the field’s own definition is still no use of it', () => {
    const r = run(F, [['unpackaged/objects/Contact.object', ...obj('<fields>', '<fullName>Parent_Account__c</fullName>', '<relationshipLabel>Parent_Account__r</relationshipLabel>', '<type>Lookup</type>', '</fields>')]]);
    expect(r.hits).toEqual([]);
  });
  it('a field that is no relationship does not pick up another field’s Field__r', () => {
    const r = run(S.sftkSweepForms('Account', 'Status__c', 'Picklist'), [['unpackaged/classes/X.cls', 'public class X { String q = \'SELECT Status__r.Name FROM Account\'; }']]);
    expect(r.hits).toEqual([]);
  });
});

describe('sftkSweepRun — the person-account spelling of a Contact field', () => {
  const F = S.sftkSweepForms('Contact', 'Level__c', 'Picklist');
  it('on Account’s own file and in code that never says Contact it keeps its kind', () => {
    const r = run(F, [
      ['unpackaged/objects/Account.object', ...obj('<validationRules>', '<fullName>Level_Needed</fullName>', '<errorConditionFormula>ISBLANK(TEXT(Level__pc))</errorConditionFormula>', '</validationRules>')],
      ['unpackaged/classes/PersonLevels.cls', 'public class PersonLevels {', '  public static String of(SObject a) { return (String) a.get(key); }', '  static void f(List<SObject> rows) { for (SObject r : rows) { Object v = r.Level__pc; } }', '}'],
    ]);
    expect(r.hits.map(h => h.type).sort()).toEqual(['ApexClass', 'ValidationRule']);
    expect(r.hits.find(h => h.type === 'ValidationRule')).toMatchObject({ sev: 'blocker', component: 'Account.Level_Needed' });
  });
  it('Account’s own Level__c beside it is still Account’s own', () => {
    const r = run(F, [['unpackaged/objects/Account.object', ...obj('<validationRules>', '<fullName>Own_Level</fullName>', '<errorConditionFormula>ISBLANK(Level__c)</errorConditionFormula>', '</validationRules>')]]);
    expect(r.hits[0]).toMatchObject({ type: 'SameNameOtherObject', section: 'Account’s own field of this name' });
  });
  it('a field of another object has no person-account spelling', () => {
    const r = run(S.sftkSweepForms('Lead', 'Level__c'), [['unpackaged/objects/Account.object', ...obj('<validationRules>', '<fullName>V</fullName>', '<errorConditionFormula>ISBLANK(Level__pc)</errorConditionFormula>', '</validationRules>')]]);
    expect(r.hits).toEqual([]);
  });
});
