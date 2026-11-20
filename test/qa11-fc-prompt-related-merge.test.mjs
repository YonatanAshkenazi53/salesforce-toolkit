// QA 1.1 finding 23: a prompt template that merges the field through a related record was missed; another input's same-named field was listed.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';
const { fcPromptNamesField: p } = extractFunctions('field-cleaner.js', ['fcPromptNamesField']);
const input = (name, obj) => `<inputs><apiName>${name}</apiName><definition>SOBJECT://${obj}</definition><referenceName>Input:${name}</referenceName></inputs>`;
const tpl = (inputs, text) => `<developerName>P</developerName><masterLabel>P</masterLabel><templateVersions><content>${text}</content>${inputs.map(([n, o]) => input(n, o)).join('')}</templateVersions>`;

describe('a merge through a related record', () => {
  it('is found although the template has no input of the field’s object', () => {
    expect(p(tpl([['Kind', 'Contact']], 'Region: {!$Input:Kind.Account.Region__c}'), 'Account', 'Region__c')).toBe(true);
    expect(p(tpl([['Contact', 'Contact']], '{!$Input:Contact.Account.Parent.Region__c}'), 'Account', 'Region__c')).toBe(true);
    expect(p(tpl([['Kind', 'Child__c']], '{! $Input:Kind.Acct__r.Region__c }'), 'Account', 'Region__c')).toBe(true);
  });
  it('is not found over a longer field name, or the field’s name as plain text', () => {
    expect(p(tpl([['Kind', 'Contact']], '{!$Input:Kind.Account.Sales_Region__c}'), 'Account', 'Region__c')).toBe(false);
    expect(p(tpl([['Kind', 'Contact']], '{!$Input:Kind.Account.Region__c2}'), 'Account', 'Region__c')).toBe(false);
    expect(p(tpl([['Kind', 'Contact']], 'Write about Region__c. {!$Input:Kind.Name}'), 'Account', 'Region__c')).toBe(false);
  });
});

describe('a direct merge', () => {
  it('of an input of the object is found, as before', () => {
    expect(p(tpl([['Kind', 'Account']], 'Region: {!$Input:Kind.Region__c}'), 'Account', 'Region__c')).toBe(true);
    expect(p(tpl([['Kind', 'Account']], 'Mention Region__c in the answer.'), 'Account', 'Region__c')).toBe(true);
  });
  it('of ANOTHER input’s same-named field is not this object’s field', () => {
    const two = [['Acct', 'Account'], ['Person', 'Contact']];
    expect(p(tpl(two, '{!$Input:Acct.Name} and {!$Input:Person.Region__c}'), 'Account', 'Region__c')).toBe(false);
    expect(p(tpl(two, '{!$Input:Acct.Name} and {!$Input:Person.Region__c}'), 'Contact', 'Region__c')).toBe(true);
    expect(p(tpl(two, '{!$Input:Person.Region__c} then {!$Input:Acct.Region__c}'), 'Account', 'Region__c')).toBe(true);
  });
  it('two inputs of the same name spelling, one of the object: the merge counts', () => {
    expect(p(tpl([['Rec', 'Account'], ['Other', 'Account']], '{!$Input:Other.Region__c}'), 'Account', 'Region__c')).toBe(true);
  });
  it('a template of other objects only, with no related-record merge, is not listed', () => {
    expect(p(tpl([['Kind', 'Contact']], '{!$Input:Kind.Region__c}'), 'Account', 'Region__c')).toBe(false);
    expect(p('', 'Account', 'Region__c')).toBe(false);
  });
});
