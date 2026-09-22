// 2026-09-22 — live run: OpportunityContactRole has no Name; the child scan sent
// `SELECT Id,Name,…` and died with HTTP 400 "No such column 'Name'". Keys can
// now be relationship paths (the parents BY NAME), the describe offers a
// fallback, and the scan says which key it used or stops with the fix.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const { sftkPathValue, sftkMatchKey, sftkMatchingFallback, sftkNormalizeValue } =
  extractFunctions('sftk-matching.js', ['sftkPathValue', 'sftkMatchKey', 'sftkMatchingFallback', 'sftkNormalizeValue', 'sftkLookupDefaultStrategy']);
const SC = readFileSync(new URL('../studio-scan.js', import.meta.url), 'utf8');
const BM = readFileSync(new URL('../studio-builder-modals.js', import.meta.url), 'utf8');
const f = (name, type, x) => ({ name, type, createable: true, nillable: true, referenceTo: [], ...x });

describe('keys can be relationship paths', () => {
  it('reads nested SOQL results, keeps flat fields as before', () => {
    const r = { Id: '1', Name: 'x', Opportunity: { Name: 'Big deal' }, Contact: null };
    expect(sftkPathValue(r, 'Name')).toBe('x');
    expect(sftkPathValue(r, 'Opportunity.Name')).toBe('Big deal');
    expect(sftkPathValue(r, 'Contact.Name')).toBe(undefined);
    expect(sftkPathValue(r, 'Nope.Name')).toBe(undefined);
    expect(sftkMatchKey(r, { strategy: 'composite', fields: ['Opportunity.Name', 'Contact.Name'] })).toBe('Big deal' + String.fromCharCode(1));
    expect(sftkMatchKey({ Opportunity: null, Contact: null }, { fields: ['Opportunity.Name', 'Contact.Name'] })).toBe('');
  });
});

describe('sftkMatchingFallback picks the key a describe offers', () => {
  const OCR = [f('Id', 'id'), f('OpportunityId', 'reference', { relationshipName: 'Opportunity', referenceTo: ['Opportunity'], nillable: false }),
    f('ContactId', 'reference', { relationshipName: 'Contact', referenceTo: ['Contact'], nillable: false }), f('Role', 'picklist'), f('IsPrimary', 'boolean')];
  it('a junction: its two parents by name', () => {
    expect(sftkMatchingFallback(OCR, {})).toMatchObject({ strategy: 'composite', fields: ['Opportunity.Name', 'Contact.Name'] });
  });
  it('a child scan puts the parent’s own key first and never repeats the link', () => {
    expect(sftkMatchingFallback(OCR, { parentField: 'OpportunityId', parentKeyPath: 'Opportunity.Name' }).fields).toEqual(['Opportunity.Name', 'Contact.Name']);
    expect(sftkMatchingFallback(OCR, { parentField: 'OpportunityId', parentKeyPath: 'Opportunity.Subject__c', lookupResolutions: { ContactId: { matchField: 'Email' } } }).fields).toEqual(['Opportunity.Subject__c', 'Contact.Email']);
  });
  it('one lookup only → add a text field; autonumber names are skipped; external id / unique / name win', () => {
    const CC = [f('ParentId', 'reference', { relationshipName: 'Parent', referenceTo: ['Case'], nillable: false }), f('CommentBody', 'textarea'), f('IsPublished', 'boolean')];
    expect(sftkMatchingFallback(CC, { parentField: 'ParentId', parentKeyPath: 'Parent.Subject' }).fields).toEqual(['Parent.Subject', 'CommentBody']);
    // Case: an autonumber name → what a person uses (Subject) next to the parent key; a lookup at a no-Name object is never a key part
    const CASE = [f('CaseNumber', 'string', { nameField: true, autoNumber: true }), f('Subject', 'string'), f('AccountId', 'reference', { relationshipName: 'Account', referenceTo: ['Account'] }),
      f('ContactId', 'reference', { relationshipName: 'Contact', referenceTo: ['Contact'] }), f('ParentId', 'reference', { relationshipName: 'Parent', referenceTo: ['Case'] })];
    const cs = sftkMatchingFallback(CASE, { parentField: 'AccountId', parentKeyPath: 'Account.Name' });
    expect(cs.fields).toEqual(['Account.Name', 'Subject', 'Contact.Name']);
    expect(cs.why).toContain('CaseNumber is an org-generated number');
    // Contract: autonumber name, no subject-like field except Description
    const CTR = [f('ContractNumber', 'string', { nameField: true, autoNumber: true }), f('AccountId', 'reference', { relationshipName: 'Account', referenceTo: ['Account'] }), f('Description', 'textarea'), f('StartDate', 'date')];
    expect(sftkMatchingFallback(CTR, { parentField: 'AccountId', parentKeyPath: 'Account.Name' }).fields).toEqual(['Account.Name', 'Description']);
    const OI = [f('OrderItemNumber', 'string', { nameField: true, autoNumber: true }), f('OrderId', 'reference', { relationshipName: 'Order', referenceTo: ['Order'], nillable: false }),
      f('PricebookEntryId', 'reference', { relationshipName: 'PricebookEntry', referenceTo: ['PricebookEntry'], nillable: false }), f('Product2Id', 'reference', { relationshipName: 'Product2', referenceTo: ['Product2'] })];
    expect(sftkMatchingFallback(OI, {}).fields).toEqual(['PricebookEntry.Name', 'Product2.Name']);   // Order has no Name to match by, so it is not a key part
    expect(sftkMatchingFallback([f('Ext__c', 'string', { externalId: true }), ...OCR], {})).toMatchObject({ strategy: 'externalId', fields: ['Ext__c'] });
    expect(sftkMatchingFallback([f('Code__c', 'string', { unique: true }), ...OCR], {})).toMatchObject({ strategy: 'field', fields: ['Code__c'] });
    expect(sftkMatchingFallback([f('Name', 'string', { nameField: true }), ...OCR], {})).toMatchObject({ strategy: 'field', fields: ['Name'] });
    expect(sftkMatchingFallback([f('Id', 'id'), f('OwnerId', 'reference', { relationshipName: 'Owner', referenceTo: ['User', 'Group'] })], {})).toBe(null);
  });
});

describe('the scan uses it, says so, and validates path keys', () => {
  it('no Name and no config → fallback with a warning; nothing usable → a plain error with the fix', () => {
    expect(SC).toContain("if (!hasMatchingCfg && srcTypes.size && !srcTypes.has(srcMatchField) && (!srcNameFld || _srcNameIsAuto)) {");
    expect(SC).toContain('the 🪪 identity field (Identity… on the Deploy page) makes it exact');
    expect(SC).toContain('has no Name field and no usable key — set a match key in ✏ Edit → Records → Matching (💡 Suggestions), then scan again');
    expect(SC).toContain("has no ${_srcNameIsAuto ? 'usable' : ''} Name field — matched by ${fb.fields.join(' + ')} for this scan (${fb.why}).");
    expect(SC).toContain('const sideHas = (types, rels, f) => String(f).includes(\'.\') ? rels.has(String(f).split(\'.\')[0]) : types.has(f);');
    expect(SC).toContain('srcKeyFields.filter(f => !sideHas(srcTypes, srcRels, f))');
  });
  it('💡 Suggestions offers it for a no-Name object and the composite select keeps a path component visible', () => {
    expect(BM).toContain("if (!nameFld && typeof sftkMatchingFallback === 'function') {");
    expect(BM).toContain("a related record's field</option>");
  });
});
