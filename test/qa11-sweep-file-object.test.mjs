// QA 1.1 finding 31: another object's flow, Lightning page, layout, report or permission line with a same-named field is not this field's.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

const S = extractFunctions('sftk-sweep.js', ['sftkSweepForms', 'sftkSweepHits', 'sftkSweepKindTable', 'sftkSweepSections', '_sftkSweepSectionAt', 'sftkSweepKind', 'sftkSweepRun', 'sftkSweepJoinKind']);
const NL = '\n';
const run = (forms, files) => S.sftkSweepRun(new Map(files.map(([p, ...lines]) => [p, lines.join(NL)])), forms);
const F = S.sftkSweepForms('Account', 'Status__c', 'Picklist');
const X = '<?xml version="1.0" encoding="UTF-8"?>';
const flow = (startObj, ...body) => [X, '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">', ...body,
  '<start>', '<locationX>50</locationX>', ...(startObj ? [`<object>${startObj}</object>`] : []), '<recordTriggerType>Update</recordTriggerType>', '</start>', '</Flow>'];
const page = (sobj, ...body) => [X, '<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">', ...body, ...(sobj ? [`<sobjectType>${sobj}</sobjectType>`] : []), '<type>RecordPage</type>', '</FlexiPage>'];
const one = (forms, file) => run(forms, [file]).hits.map(h => ({ type: h.type, sev: h.sev, section: h.section }));
const CONTACTS = { type: 'SameNameOtherObject', sev: 'mention', section: 'Contact’s own field of this name' };

describe('the scenario of the finding: Account.Status__c, and Contact has a Status__c too', () => {
  it('a Contact flow, page, layout, report column and permission line are Contact’s own field', () => {
    const r = run(F, [
      ['unpackaged/flows/Contact_Stamp.flow', ...flow('Contact', '<decisions>', '<leftValueReference>$Record.Status__c</leftValueReference>', '</decisions>')],
      ['unpackaged/flexipages/Contact_Record_Page.flexipage', ...page('Contact', '<fieldItem>Record.Status__c</fieldItem>')],
      ['unpackaged/layouts/Contact-Contact Layout.layout', X, '<Layout xmlns="http://soap.sforce.com/2006/04/metadata">', '<layoutSections>', '<field>Status__c</field>', '</layoutSections>', '</Layout>'],
      ['unpackaged/reports/Sales/Contacts_By_Status.report', X, '<Report xmlns="http://soap.sforce.com/2006/04/metadata">', '<columns>', '<field>Contact.Status__c</field>', '</columns>', '</Report>'],
      ['unpackaged/permissionsets/Sales.permissionset', X, '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">', '<fieldPermissions>', '<field>Contact.Status__c</field>', '</fieldPermissions>', '</PermissionSet>'],
      ['unpackaged/profiles/Admin.profile', X, '<Profile xmlns="http://soap.sforce.com/2006/04/metadata">', '<fieldPermissions>', '<field>Contact.Status__c</field>', '</fieldPermissions>', '</Profile>'],
    ]);
    expect(r.hits).toHaveLength(6);
    for (const h of r.hits) expect({ type: h.type, sev: h.sev, section: h.section }, h.path).toEqual(CONTACTS);
    expect(r.hits.some(h => h.sev === 'blocker')).toBe(false);
    expect(S.sftkSweepJoinKind('SameNameOtherObject')).toBeNull();
    expect(S.sftkSweepKindTable().SameNameOtherObject.why).toContain('under that object’s own name');
  });
});

describe('what is ours, or may be, keeps its kind', () => {
  it('a flow: our own object, a Get Records on our object inside another object’s flow, a path, no start object', () => {
    expect(one(F, ['unpackaged/flows/A.flow', ...flow('Account', '<leftValueReference>$Record.Status__c</leftValueReference>')])).toEqual([{ type: 'Flow', sev: 'blocker', section: null }]);
    // written bare beside <object>Account</object>: Account's field, read from a Contact-triggered flow
    expect(one(F, ['unpackaged/flows/B.flow', ...flow('Contact', '<recordLookups>', '<filters>', '<field>Status__c</field>', '</filters>', '<object>Account</object>', '</recordLookups>')]))
      .toEqual([{ type: 'Flow', sev: 'blocker', section: null }]);
    expect(one(F, ['unpackaged/flows/C.flow', ...flow('Contact', '<leftValueReference>$Record.Account.Status__c</leftValueReference>')])).toEqual([{ type: 'Flow', sev: 'blocker', section: null }]);
    expect(one(F, ['unpackaged/flows/D.flow', ...flow('Contact', '<stringValue>{!$Record.Status__c} and {!Get_Account.Status__c}</stringValue>')])).toEqual([{ type: 'Flow', sev: 'blocker', section: null }]);
    expect(one(F, ['unpackaged/flows/E.flow', ...flow('', '<leftValueReference>$Record.Status__c</leftValueReference>')])).toEqual([{ type: 'Flow', sev: 'blocker', section: null }]);
    expect(one(F, ['unpackaged/flows/G.flow', ...flow('Contact', '<leftValueReference>$Record__Prior.Status__c</leftValueReference>')])).toEqual([CONTACTS]);
    // the object named only by a Get Records element is not the flow's start object
    expect(one(F, ['unpackaged/flows/H.flow', X, '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">', '<recordLookups>', '<object>Contact</object>', '</recordLookups>',
      '<leftValueReference>$Record.Status__c</leftValueReference>', '<start>', '<object>Account</object>', '</start>', '</Flow>'])).toEqual([{ type: 'Flow', sev: 'blocker', section: null }]);
  });
  it('a Lightning page: our object’s page, a page with no object, a path through a relationship', () => {
    expect(one(F, ['unpackaged/flexipages/A.flexipage', ...page('Account', '<fieldItem>Record.Status__c</fieldItem>')])).toEqual([{ type: 'FlexiPage', sev: 'blocker', section: null }]);
    expect(one(F, ['unpackaged/flexipages/B.flexipage', ...page('', '<value>Record.Status__c</value>')])).toEqual([{ type: 'FlexiPage', sev: 'blocker', section: null }]);
    expect(one(F, ['unpackaged/flexipages/C.flexipage', ...page('Contact', '<leftValue>{!Record.Account.Status__c}</leftValue>')])).toEqual([{ type: 'FlexiPage', sev: 'blocker', section: null }]);
    expect(one(F, ['unpackaged/flexipages/D.flexipage', ...page('Contact', '<leftValue>{!Record.Status__c}</leftValue>')])).toEqual([CONTACTS]);
  });
  it('a layout: our own, a person-account one, and a related-list column on another object’s layout', () => {
    const lay = (...b) => [X, '<Layout xmlns="http://soap.sforce.com/2006/04/metadata">', ...b, '</Layout>'];
    expect(one(F, ['unpackaged/layouts/Account-Account Layout.layout', ...lay('<layoutSections>', '<field>Status__c</field>', '</layoutSections>')])[0].type).toBe('Layout');
    expect(one(F, ['unpackaged/layouts/PersonAccount-Person Account Layout.layout', ...lay('<layoutSections>', '<field>Status__c</field>', '</layoutSections>')])[0].type).toBe('Layout');
    expect(one(F, ['unpackaged/layouts/Contact-Contact Layout.layout', ...lay('<relatedLists>', '<fields>Status__c</fields>', '<relatedList>RelatedAccountList</relatedList>', '</relatedLists>')])[0].type).toBe('LayoutRelatedList');
    // Case's close layout holds Case's fields
    const C = S.sftkSweepForms('Case', 'Status__c', 'Picklist');
    expect(one(C, ['unpackaged/layouts/CaseClose-Close Case Layout.layout', ...lay('<layoutSections>', '<field>Status__c</field>', '</layoutSections>')])[0].type).toBe('Layout');
  });
  it('a report, a permission set: our object’s line, a line that holds both, a relationship, a custom report type column', () => {
    const rep = (...b) => ['unpackaged/reports/R/One.report', X, '<Report xmlns="http://soap.sforce.com/2006/04/metadata">', ...b, '</Report>'];
    expect(one(F, rep('<field>Account.Status__c</field>'))[0].type).toBe('Report');
    expect(one(F, rep('<field>Account.Status__c</field><field>Contact.Status__c</field>'))[0].type).toBe('Report');
    expect(one(F, rep('<field>Parent__r.Status__c</field>'))[0].type).toBe('Report');
    expect(one(F, rep('<field>Account$Status__c</field>'))[0].type).toBe('Report');
    expect(one(F, rep('<field>Status__c</field>'))[0].type).toBe('Report');
    expect(one(F, rep('<field>FK_$Contact.Status__c</field>'))).toEqual([CONTACTS]);
    expect(one(F, ['unpackaged/permissionsets/P.permissionset', X, '<PermissionSet>', '<field>Account.Status__c</field>', '</PermissionSet>'])[0].type).toBe('PermissionSet');
    expect(one(F, ['unpackaged/permissionsets/P.permissionset', X, '<PermissionSet>', '<field>PersonAccount.Status__c</field>', '</PermissionSet>'])[0].type).toBe('PermissionSet');
  });
  it('a Contact field’s person-account spelling on an Account page is ours', () => {
    const P = S.sftkSweepForms('Contact', 'Level__c', 'Picklist');
    expect(one(P, ['unpackaged/flexipages/A.flexipage', ...page('Account', '<fieldItem>Record.Level__pc</fieldItem>')])).toEqual([{ type: 'FlexiPage', sev: 'blocker', section: null }]);
    expect(one(P, ['unpackaged/flexipages/A.flexipage', ...page('Account', '<fieldItem>Record.Level__c</fieldItem>')])).toEqual([{ type: 'SameNameOtherObject', sev: 'mention', section: 'Account’s own field of this name' }]);
  });
});
