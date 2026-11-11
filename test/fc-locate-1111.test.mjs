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

// 2026-11-11 (owner: "we are missing some flow versions here") — Salesforce names flow versions by id; the box says them by name
import { extractFunctions } from './extract.mjs';
describe('Field Cleaner — the flow versions Salesforce names', () => {
  const A = extractFunctions('field-cleaner.js', ['fcAskFlowLines', 'fcAskFlowIds']);
  const lines = ['Flow Version - 301bm00003G5k5w', 'Flow Version - 301bm00003G5k5x', 'Workflow Rules', 'Flow Version - 301bm00003GAZD6', 'Flow Version - 301bm00003ZZZZZ'];
  it('reads the ids', () => { expect(A.fcAskFlowIds(lines)).toHaveLength(4); });
  it('one line per flow with its versions; an unread version keeps its own line', () => {
    const by = { '301bm00003G5k5w': { flow: 'SFTK Pkg Screen', version: 1, status: 'Obsolete' }, '301bm00003GAZD6': { flow: 'SFTK Pkg Screen', version: 2, status: 'Active' }, '301bm00003G5k5x': { flow: 'SFTK Pkg Sub', version: 1, status: 'Active' } };
    expect(A.fcAskFlowLines(lines, by)).toEqual(['Flow SFTK Pkg Screen — v1 (not active) · v2 (Active)', 'Flow SFTK Pkg Sub — v1 (Active)', 'Workflow Rules', 'Flow Version - 301bm00003ZZZZZ']);
    expect(A.fcAskFlowLines(lines, {})).toEqual(lines);
  });
});
