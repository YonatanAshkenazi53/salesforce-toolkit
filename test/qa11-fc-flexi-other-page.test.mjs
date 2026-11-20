// QA 1.1 finding 17 — a record page of another object that holds its OWN same-named field is not listed for this field.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const FC = read('field-cleaner.js'), MD = read('sftk-mdapi.js');
const nested = name => {
  const at = FC.indexOf(`\n  function ${name}(`);
  if (at < 0) throw new Error(`not found in field-cleaner.js: ${name}`);
  return FC.slice(at + 1, FC.indexOf('\n  }\n', at + 1) + 4);
};
const top = name => {
  const at = MD.indexOf(`\nfunction ${name}(`);
  if (at < 0) throw new Error(`not found in sftk-mdapi.js: ${name}`);
  return MD.slice(at + 1, MD.indexOf('\n}', at + 1) + 2);
};
const F = new Function(`${['sftkMdIsOwnObj', 'sftkMdFamObj'].map(top).join('\n')}
${['_flexiOnlyOtherPagesRecord', '_flexiNamesBeyondText', 'flexiPageReferencesField'].map(nested).join('\n')}
return { only: _flexiOnlyOtherPagesRecord, names: flexiPageReferencesField, beyond: _flexiNamesBeyondText };`)();

const fieldItem = v => ({ fieldInstance: { fieldItem: v, identifier: 'f1' } });
const page = (sobjectType, items) => ({ sobjectType, masterLabel: 'A page', flexiPageRegions: [{ name: 'main', type: 'Region', itemInstances: items }] });
const listed = (md, hint) => F.names(md, 'Account', 'Region__c') && F.beyond(md, 'Account', 'Region__c') && !F.only(md, 'Account', 'Region__c', hint);

describe('scanning Account.Region__c', () => {
  it('a Contact record page with Contact’s own Region__c (a Dynamic Forms item, a visibility rule) is not listed', () => {
    expect(listed(page('Contact', [fieldItem('Record.Region__c')]))).toBe(false);
    expect(listed(page('Contact', [{ componentInstance: { componentName: 'flexipage:richText', identifier: 'r1', visibilityRule: { criteria: [{ leftValue: '{!Record.Region__c}', operator: 'EQUAL', rightValue: 'East' }] } } }]))).toBe(false);
    expect(listed(page('Contact', [{ componentInstance: { componentName: 'force:field', identifier: 'c1', componentInstanceProperties: [{ name: 'fieldApiName', value: 'Region__c' }] } }]))).toBe(false);
  });
  it('an Account record page with the same content is listed', () => {
    expect(listed(page('Account', [fieldItem('Record.Region__c')]))).toBe(true);
    expect(listed(page('PersonAccount', [fieldItem('Record.Region__c')]))).toBe(true);
  });
  it('a page that does not say its object stays listed; its EntityDefinitionId tells it when the caller passes it', () => {
    expect(listed(page(null, [fieldItem('Record.Region__c')]))).toBe(true);
    expect(listed(page(null, [fieldItem('Record.Region__c')]), 'Contact')).toBe(false);
    expect(listed(page(null, [fieldItem('Record.Region__c')]), 'Account')).toBe(true);
  });
  it('a Contact page that also names the field somewhere it could be Account’s stays listed', () => {
    // a hop to the parent Account
    expect(listed(page('Contact', [fieldItem('Record.Region__c'), fieldItem('Record.Account.Region__c')]))).toBe(true);
    // the object named outright
    expect(listed(page('Contact', [fieldItem('Record.Region__c'), { componentInstance: { componentName: 'x', identifier: 'c2', visibilityRule: { criteria: [{ leftValue: '{!Account.Region__c}', operator: 'EQUAL', rightValue: 'East' }] } } }]))).toBe(true);
    // a related-list column list, a filter: a longer value that holds the name
    expect(listed(page('Contact', [fieldItem('Record.Region__c'), { componentInstance: { componentName: 'force:relatedListSingleContainer', identifier: 'c3', componentInstanceProperties: [{ name: 'relatedListFieldAliases', value: 'Name,Region__c' }] } }]))).toBe(true);
  });
  it('a custom field of Task is Activity’s: a Task record page is its own page, an Account page is not', () => {
    const md = page('Task', [fieldItem('Record.Region__c')]);
    expect(F.only(md, 'Activity', 'Region__c')).toBe(false);
    expect(F.only(md, 'Event', 'Region__c')).toBe(false);
    expect(F.only(page('Account', [fieldItem('Record.Region__c')]), 'Task', 'Region__c')).toBe(true);
  });
  it('the page handed in is not changed', () => {
    const md = page('Contact', [fieldItem('Record.Region__c')]), before = JSON.stringify(md);
    F.only(md, 'Account', 'Region__c');
    expect(JSON.stringify(md)).toBe(before);
  });
});

describe('the scan asks it before listing a page', () => {
  const scan = FC.slice(FC.indexOf('  async function scanFlexiPages('), FC.indexOf('  function _fieldTokenRe('));
  it('and does not take an unresolved 01I id for another object when the scanned object’s own id is not known', () => {
    expect(scan).toContain('&& !_flexiOnlyOtherPagesRecord(r.value.Metadata, _selObj.api, _selField.api, pageObjHint(r.value))) {');
    expect(scan).toContain("return (/^01I/i.test(h) && /__[a-z]+$/i.test(String(_selObj.api || '')) && !_selObj.durableId) ? '' : h;");
  });
});
