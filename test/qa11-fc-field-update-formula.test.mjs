// QA 1.1 finding 22: a workflow field update whose FORMULA reads the field (it writes another field) was never listed.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const { fcFieldUpdateReadsField: reads } = extractFunctions('field-cleaner.js', ['fcFieldUpdateReadsField']);
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');

describe('a field update that reads the field in its formula', () => {
  it('is found by the field’s name as a whole word, in any case', () => {
    expect(reads({ operation: 'Formula', field: 'Other__c', formula: "Region__c & '-X'" }, 'Region__c')).toBe(true);
    expect(reads({ formula: 'IF(ISBLANK(region__c), 0, 1)' }, 'Region__c')).toBe(true);
    expect(reads({ formula: 'Account.Region__c' }, 'Region__c')).toBe(true);
  });
  it('is not found over a longer name, a constant, or an update with no formula', () => {
    expect(reads({ formula: 'Sales_Region__c & My_Region__c2' }, 'Region__c')).toBe(false);
    expect(reads({ formula: '"X"' }, 'Region__c')).toBe(false);
    expect(reads({ operation: 'Literal', literalValue: 'Region__c' }, 'Region__c')).toBe(false);
    expect(reads({ formula: null }, 'Region__c')).toBe(false);
    expect(reads(null, 'Region__c')).toBe(false);
    expect(reads({ formula: 'Region__c' }, '')).toBe(false);
  });
});

describe('the scan leg', () => {
  const leg = FC.slice(FC.indexOf('// 5. Workflow field updates'), FC.indexOf('// 6. Workflow rules'));
  it('opens every update that does not WRITE the field and tests its formula', () => {
    expect(leg).toContain('else others.push(fu);');
    expect(leg).toMatch(/await eachMetadata\('WorkflowFieldUpdate', others,\s*m => fcFieldUpdateReadsField\(m, _selField\.api\),\s*'WorkflowFieldUpdate'/);
  });
  it('an update that could not be opened is reported, through the shared reader', () => {
    expect(leg).toContain("'workflow field updates');");
    expect(FC).toContain('miss(`${what} (some could not be opened)`');
  });
});

describe('the cost line names the extra reads', () => {
  const E = extractFunctions('field-cleaner.js', ['fcEstimateScanCalls', 'fcScopeLegs', 'fcScopeNorm']);
  it('one call for each field update on the object, in the scopes that look for blockers', () => {
    expect(E.fcEstimateScanCalls(null, 'blockers', 'Account').moreIf).toContain('workflow field update on this object');
    expect(E.fcEstimateScanCalls(null, 'mentions', 'Account').moreIf).not.toContain('workflow field update on this object');
  });
});
