// Search layouts are scanned (user 2026-11-10: "also, what about search layouts?"), and a scoping rule says it is
// one ("גם אני לא רואה ברשימה scoping rule").
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const M = extractFunctions('sftk-mdapi.js', ['sftkSearchLayoutHits', 'sftkSearchLayoutEdit', 'sftkDependentPicklists', 'sftkMdChildren', 'sftkMdChildText', 'sftkMdFindElement', 'sftkMdUnescape', 'sftkMdEscape', '_sftkMdFieldIs', '_sftkMdWalk']);
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
// as Salesforce returned Account on npc
const XML = `<fullName>Account</fullName><searchLayouts>
        <customTabListAdditionalFields>ACCOUNT.NAME</customTabListAdditionalFields>
        <lookupDialogsAdditionalFields>ACCOUNT.NAME</lookupDialogsAdditionalFields>
        <lookupDialogsAdditionalFields>F__c</lookupDialogsAdditionalFields>
        <searchResultsAdditionalFields>ACCOUNT.NAME</searchResultsAdditionalFields>
        <searchResultsAdditionalFields>F__c</searchResultsAdditionalFields>
        <searchResultsAdditionalFields>Other_F__c</searchResultsAdditionalFields>
    </searchLayouts>`;

describe('sftkSearchLayoutHits', () => {
  it('one hit per layout that lists the field, in Setup words', () => {
    expect(M.sftkSearchLayoutHits(XML, 'Account', 'F__c')).toEqual([
      { tag: 'lookupDialogsAdditionalFields', label: 'Lookup dialog' },
      { tag: 'searchResultsAdditionalFields', label: 'Search results' }]);
  });
  it('a standard field is written OBJECT.FIELD; a longer name is another field; no layouts, no hits', () => {
    expect(M.sftkSearchLayoutHits(XML, 'Account', 'Name').map(h => h.tag)).toEqual(['customTabListAdditionalFields', 'lookupDialogsAdditionalFields', 'searchResultsAdditionalFields']);
    expect(M.sftkSearchLayoutHits(XML, 'Account', 'Other_F__c')).toHaveLength(1);
    expect(M.sftkSearchLayoutHits('<searchLayouts></searchLayouts>', 'Account', 'F__c')).toEqual([]);
    expect(M.sftkSearchLayoutHits('', 'Account', 'F__c')).toEqual([]);
  });
});

describe('the scan', () => {
  it('reads the object once for its search layouts, as a mention', () => {
    expect(FC).toContain("searchLayouts: mentions,");
    expect(FC).toContain("add('SearchLayout', `sl_${obj}_${h.tag}`, h.label);");
    expect(FC).toMatch(/SearchLayout:\s+\{[^}]*fixable: true, sev: 'silent'/);
  });
  it('the note no longer lists search layouts as unread', () => {
    const i = FC.indexOf('Not read, and not a blocker');
    expect(FC.slice(i, i + 700)).not.toContain('search layouts');
  });
  it('a scoping or restriction rule row says which it is and whether it is on', () => {
    expect(FC).toContain("=== 'scoping' ? 'scoping rule' : 'restriction rule'}${r.IsActive === false ? ', inactive' : ''})");
  });
});

describe('sftkSearchLayoutEdit — ✂ / ⇄ on one layout', () => {
  const E = (tag, nf) => M.sftkSearchLayoutEdit(XML, 'Account', 'F__c', tag, nf);
  it('✂ takes the field out of that layout only; a standard object deploys its search layouts alone', () => {
    const r = E('searchResultsAdditionalFields', null);
    expect(r.n).toBe(1);
    expect(r.after).not.toMatch(/<searchResultsAdditionalFields>F__c</);
    expect(r.after).toContain('<lookupDialogsAdditionalFields>F__c</lookupDialogsAdditionalFields>');
    expect(r.after).toContain('<searchResultsAdditionalFields>Other_F__c</searchResultsAdditionalFields>');
    expect(r.file).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">' + r.after + '</CustomObject>');
  });
  it('⇄ renames the entry; when the new field is already listed there the old entry just goes', () => {
    expect(E('lookupDialogsAdditionalFields', 'New__c').after).toContain('<lookupDialogsAdditionalFields>New__c</lookupDialogsAdditionalFields>');
    const r = E('searchResultsAdditionalFields', 'Other_F__c');
    expect(r.newAlreadyThere).toBe(true);
    expect((r.after.match(/Other_F__c/g) || []).length).toBe(1);
    expect(r.after).not.toMatch(/<searchResultsAdditionalFields>F__c</);
  });
  it('a layout that does not list the field changes nothing', () => {
    expect(E('customTabListAdditionalFields', null).n).toBe(0);
  });
  it('a custom object deploys with its own top-level properties and without its child components', () => {
    const obj = '<fullName>Thing__c</fullName><deploymentStatus>Deployed</deploymentStatus><fields><fullName>F__c</fullName><type>Text</type></fields><label>Thing</label><listViews><fullName>All</fullName></listViews><nameField><label>Name</label><type>Text</type></nameField><pluralLabel>Things</pluralLabel><searchLayouts><searchResultsAdditionalFields>F__c</searchResultsAdditionalFields></searchLayouts><sharingModel>ReadWrite</sharingModel><validationRules><fullName>V</fullName></validationRules>';
    const r = M.sftkSearchLayoutEdit(obj, 'Thing__c', 'F__c', 'searchResultsAdditionalFields', null);
    expect(r.n).toBe(1);
    for (const keep of ['<label>Thing</label>', '<pluralLabel>Things</pluralLabel>', '<sharingModel>ReadWrite</sharingModel>', '<deploymentStatus>Deployed</deploymentStatus>', '<nameField>']) expect(r.file).toContain(keep);
    for (const gone of ['<fields>', '<listViews>', '<validationRules>', '<fullName>']) expect(r.file).not.toContain(gone);
    expect(r.file).toContain('<searchLayouts></searchLayouts>');
  });
});

describe('the fix and the stale quick action', () => {
  it('a search layout has ✂ / ⇄, re-read to verify, undo in History; a packaged object is left to Setup', () => {
    expect(FC).toContain("if (type === 'SearchLayout') label = (await fixSearchLayout(componentId, componentName)) || label;");
    expect(FC).toContain('if (fcFieldNamespace(obj)) throw fail(`${obj} belongs to a package');
    expect(FC).toContain("const gone = !sftkSearchLayoutHits(now.inner, obj, field).some(h => h.tag === ed.tag);");
  });
  it('a quick action Salesforce still serves from its cache after a delete is not listed', () => {
    expect(FC).toContain("query: `SELECT DeveloperName FROM QuickActionDefinition WHERE SobjectType = '${obj}'`");
    expect(FC).toContain("for (const qa of qaHits) if (!have || have.has(bare(qa.name).toLowerCase())) add('QuickAction', qa.name, qa.label || qa.name);");
  });
});

describe('dependent picklists (live 2026-11-10: the delete goes through and the dependency is lost silently)', () => {
  const OBJ = '<fullName>Account</fullName><fields><fullName>Ctl__c</fullName><type>Picklist</type></fields>'
    + '<fields><fullName>Dep__c</fullName><type>Picklist</type><valueSet><controllingField>Ctl__c</controllingField><valueSettings><controllingFieldValue>A</controllingFieldValue><valueName>X</valueName></valueSettings></valueSet></fields>'
    + '<fields><fullName>Other__c</fullName><valueSet><controllingField>Else__c</controllingField></valueSet></fields>';
  it('lists the picklists the field controls, and only those', () => {
    expect(M.sftkDependentPicklists(OBJ, 'Ctl__c')).toEqual(['Dep__c']);
    expect(M.sftkDependentPicklists(OBJ, 'ctl__c')).toEqual(['Dep__c']);
    expect(M.sftkDependentPicklists(OBJ, 'Dep__c')).toEqual([]);
    expect(M.sftkDependentPicklists('', 'Ctl__c')).toEqual([]);
  });
  it('rides the object read the search layouts already make — a mention, no extra call', () => {
    expect(FC).toContain("for (const n of sftkDependentPicklists(rec ? rec.innerXml : '', _selField.api)) add('DependentPicklist',");
    expect(FC).toMatch(/DependentPicklist: \{[^}]*fixable: false, sev: 'silent'/);
  });
});
