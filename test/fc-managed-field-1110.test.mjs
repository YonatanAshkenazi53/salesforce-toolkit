// A packaged field is never called "safe to delete" (user 2026-11-10: "ברחו לנו מלא מטאדאטה חבילתי … לוודא שגם
// האובייקטים החבילתיים נסרקים"). Live on npc: dlrs__LookupChild__c.dlrs__LookupParent__c read "No dependencies
// found — This field can be safely deleted" with a Delete button.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const F = extractFunctions('field-cleaner.js', ['fcFieldNamespace']);
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');

describe('fcFieldNamespace', () => {
  it('reads the namespace of a packaged field', () => {
    expect(F.fcFieldNamespace('dlrs__Color__c')).toBe('dlrs');
    expect(F.fcFieldNamespace('npsp__Primary_Contact__c')).toBe('npsp');
    expect(F.fcFieldNamespace('Novidea_HPC__Policy_Number__c')).toBe('Novidea_HPC');
  });
  it('an org-built field has none — on a packaged object too', () => {
    expect(F.fcFieldNamespace('SFTK_Pkg_Tag__c')).toBe('');
    expect(F.fcFieldNamespace('My_Field__c')).toBe('');
    expect(F.fcFieldNamespace('Name')).toBe('');
    expect(F.fcFieldNamespace('')).toBe('');
  });
});

describe('a packaged field in the results', () => {
  it('the clean state says what was not read and offers no delete', () => {
    expect(FC).toContain('Nothing in this org’s own metadata uses the field');
    expect(FC).toContain('this is not “unused”');
    const i = FC.indexOf('const pkgNs = fcFieldNamespace(_selField && _selField.api);');
    const part = FC.slice(i, FC.indexOf('fcDataVerdict', i));
    expect(part).toMatch(/pkgNs \? `[\s\S]*: `[\s\S]*id="fcDelFreeBtn"/);
  });
  it('the delete button stays locked with the reason', () => {
    expect(FC).toContain('a packaged field cannot be deleted here. What is listed above is what THIS org built on it');
  });
});
