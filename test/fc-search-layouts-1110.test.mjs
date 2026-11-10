// Search layouts are scanned (user 2026-11-10: "also, what about search layouts?"), and a scoping rule says it is
// one ("גם אני לא רואה ברשימה scoping rule").
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const M = extractFunctions('sftk-mdapi.js', ['sftkSearchLayoutHits', 'sftkMdFindElement', 'sftkMdUnescape', '_sftkMdFieldIs']);
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
    expect(FC).toMatch(/SearchLayout:\s+\{[^}]*fixable: false, sev: 'silent'/);
  });
  it('the note no longer lists search layouts as unread', () => {
    const i = FC.indexOf('Not read, and not a blocker');
    expect(FC.slice(i, i + 700)).not.toContain('search layouts');
  });
  it('a scoping or restriction rule row says which it is and whether it is on', () => {
    expect(FC).toContain("=== 'scoping' ? 'scoping rule' : 'restriction rule'}${r.IsActive === false ? ', inactive' : ''})");
  });
});
