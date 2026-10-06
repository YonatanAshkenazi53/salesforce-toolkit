import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const ID = readFileSync(new URL('../sftk-identity.js', import.meta.url), 'utf8');
const REC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const F = new Function(ID + ' return { sftkIdDefinitionQuery, sftkIdFieldName };')();

// QA 2026-10-06 (live, both orgs): "Create the field" deployed SFTK_ID__c and the
// permission set, and then said "accepted by Salesforce, but could not be re-read on
// Account, Contact" — the re-read was a data query the user cannot run until the set is
// assigned. The verify now reads the field's definition; visibility is probed after.
describe('identity field: the deploy is verified by the field definition, not by FLS', () => {
  it('the definition query', () => {
    expect(F.sftkIdDefinitionQuery('Account')).toBe("SELECT Id FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = 'Account' AND QualifiedApiName = 'SFTK_ID__c'");
    expect(() => F.sftkIdDefinitionQuery("Account' OR 1=1")).toThrow(/not an object API name/);
  });
  it('sftkIdDeployTo verifies with it (tooling) and probes visibility only after the assignment', () => {
    const i = REC.indexOf('function sftkIdDeployTo(');
    const body = REC.slice(i, REC.indexOf('\nasync function sftkOpenIdentityModal', i));
    expect(body).toContain('query: sftkIdDefinitionQuery(o) });');
    expect(body).toContain("tooling: true, _suppressError: true,\n              query: sftkIdDefinitionQuery(o)");
    expect(body).toContain('but the org shows no such field on ${missing.join(\', \')} on re-read');
    const verifyAt = body.indexOf('sftkIdDefinitionQuery(o)');
    const assignAt = body.indexOf("path: 'services/data/v62.0/sobjects/PermissionSetAssignment'");
    const probeAt = body.indexOf('const invisible = [];');
    expect(verifyAt).toBeGreaterThan(0);
    expect(assignAt).toBeGreaterThan(verifyAt);
    expect(probeAt).toBeGreaterThan(assignAt);
    expect(body).toContain('is still refused — field-level security can take a moment');
  });
});
