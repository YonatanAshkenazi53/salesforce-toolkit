// 2026-11-13 (owner, on a dry run): "why we dont say its a validation rule?" · "there can be many different scenarios
// of failure" · "we need to show the error from salesforce somehow"
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const { sftkRefusalSource: S } = extractFunctions('studio-reconcile.js', ['sftkRefusalSource']);
const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const BG = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const RULES = [{ name: 'SFTK_Pkg_Red_Needs_Tag', message: 'No red Lookup Child may be created in this org (the target is stricter).' }];

describe('what refused a record', () => {
  it('a validation rule is named when its message is the one Salesforce gave', () => {
    expect(S('FIELD_CUSTOM_VALIDATION_EXCEPTION', 'No red Lookup Child may be created in this org (the target is stricter).', RULES)).toEqual({ what: 'a validation rule', by: 'SFTK_Pkg_Red_Needs_Tag' });
  });
  it('a custom message no rule has is a flow or a trigger — said, not guessed', () => {
    expect(S('FIELD_CUSTOM_VALIDATION_EXCEPTION', 'SFTK demo: this flow refuses the child named X.', RULES).what).toMatch(/custom error of a flow or an Apex trigger/);
    expect(S('FIELD_CUSTOM_VALIDATION_EXCEPTION', 'anything', undefined).what).toBe('a validation rule, or a custom error of a flow or an Apex trigger');
  });
  it('the other scenarios, from the code or the words', () => {
    expect(S('DUPLICATES_DETECTED', 'Use one of these records?').what).toBe('a duplicate rule');
    expect(S('CANNOT_EXECUTE_FLOW_TRIGGER', 'We can\'t save this record because the “My Flow” process failed.')).toEqual({ what: 'a record-triggered flow that failed', by: 'My Flow' });
    expect(S('CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY', 'AccTrg: execution of BeforeInsert caused by: System.NullPointerException')).toEqual({ what: 'an Apex trigger that failed', by: 'AccTrg' });
    expect(S('REQUIRED_FIELD_MISSING', 'Required fields are missing: [LastName]')).toEqual({ what: 'a required field that is empty', by: 'LastName' });
    expect(S('INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST', 'Rating: bad value for restricted picklist field: Hot2').what).toMatch(/restricted picklist/);
    expect(S('FIELD_FILTER_VALIDATION_EXCEPTION', 'Value does not exist or does not match filter criteria.').what).toBe('a lookup filter');
    expect(S('STRING_TOO_LONG', 'Name: data value too large').what).toMatch(/longer than the field allows/);
    expect(S('DUPLICATE_VALUE', 'duplicate value found: Ext__c duplicates value on record with id: 001')).toEqual({ what: 'a unique field that already has this value', by: 'Ext__c' });
    expect(S('UNABLE_TO_LOCK_ROW', 'unable to obtain exclusive access').what).toMatch(/record lock/);
    expect(S('SOMETHING_NEW', 'words').what).toBe('Salesforce');
  });
  it('the page says what refused, Salesforce\'s own code and words, and the records', () => {
    expect(RC).toContain("`Salesforce says${g.code ? ` (${g.code})` : ''}: “${why}”`");
    expect((RC.match(/await _recLogRefused\(log, res\.summary, PROBE, tgtSess\);/g) || []).length).toBe(2);
    expect((BG.match(/statusCode \? \{ code: String\(/g) || []).length).toBe(2);
  });
});

// 2026-11-13 (owner: ticked "pause validation rules", the dry run still said the rule blocked the records)
describe('a dry run says which refusals the ⏸ pauses would remove', () => {
  const { sftkProbePauseNote: N } = extractFunctions('studio-reconcile.js', ['sftkProbePauseNote']);
  const rule = { what: 'a validation rule', by: 'SFTK_Pkg_Red_Needs_Tag' };
  it('the rule is ticked → a real run would not be refused', () => {
    expect(N(rule, 'dlrs__LookupChild__c', { rules: [{ name: 'SFTK_Pkg_Red_Needs_Tag', object: 'dlrs__LookupChild__c' }], flows: [], rulesOn: true })).toMatch(/would NOT be refused by it\. A dry run switches nothing off/);
  });
  it('the option is on but this rule is not paused → refused the same way', () => {
    expect(N(rule, 'X', { rules: [], flows: [], rulesOn: true })).toMatch(/would be refused the same way/);
  });
  it('the option is off → how to pause it', () => {
    expect(N(rule, 'X', { rules: [], flows: [], rulesOn: false })).toMatch(/^Tick ⏸ “pause validation rules”/);
  });
  it('a flow error with flows paused on the object → may not happen, said as that', () => {
    expect(N({ what: 'a custom error of a flow or an Apex trigger (no active validation rule here has this message)', by: '' }, 'O', { rules: [], flows: [{ label: 'F1', object: 'O' }], flowsOn: true })).toMatch(/If this error comes from it, the real run would not meet it/);
  });
  it('nothing to say for other causes, or outside a dry run', () => {
    expect(N({ what: 'a duplicate rule', by: '' }, 'O', { rules: [], flows: [] })).toBe('');
    expect(N(rule, 'O', null)).toBe('');
  });
  it('the dry run button passes what would be paused', () => {
    expect(readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8')).toContain('{ probe: true, probePaused: _depProbePaused(p) }');
  });
});
