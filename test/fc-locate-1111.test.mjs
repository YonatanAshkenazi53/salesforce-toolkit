// 2026-11-11 (owner, on dlrs__LookupChild__c.SFTK_Pkg_Tag__c — a field that exists): "Could not locate this field in
// the Tooling API". Every lookup query's error was swallowed, so three failures read as "no such field".
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');

describe('Field Cleaner — the field lookup', () => {
  it('also asks by the object API name, with no id of ours in the query', () => {
    expect(FC).toContain("`AND EntityDefinition.QualifiedApiName = ${fcSoqlLit(_selObj.api)}`");
  });
  it('an error from Salesforce is said as an error, never as "could not locate"', () => {
    expect(FC).toContain("const note = r => { if (r && r.error) _resolveErr = String(r.error); };");
    expect(FC.match(/note\(res/g).length).toBe(4);
    const i = FC.indexOf('if (_resolveErr) {'), j = FC.indexOf("'Could not locate this field in the Tooling API. '");
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(j);
    expect(FC).toContain('Salesforce did not answer the field lookup, so nothing was scanned');
  });
});
