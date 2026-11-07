// 🗑 Delete, the four the user asked for by name (2026-11-07: "לכל הסוגים שיש?"
// → "צריך את כולם. תריץ בדיקות. תעשה איטרציות"): a duplicate rule, the lead
// field mapping (its line goes, the settings stay), a Process Builder process
// (every version, switched off first), a lookup filter (the filter goes, the
// field stays).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const M = extractFunctions('sftk-mdapi.js', ['sftkMdDeleteSpec', '_sftkMdDeleteTable', 'sftkMdLeadMappingRemove', 'sftkMdLeadMappingsFor', 'sftkMdChildren', 'sftkMdChildText', 'sftkMdFindElement', 'sftkMdUnescape']);

describe('the table', () => {
  it('a duplicate rule, the lead mapping and a Process Builder process are in it; a Flow is not; a lookup filter is a path of its own', () => {
    expect(M.sftkMdDeleteSpec('DuplicateRule')).toMatchObject({ folder: 'duplicateRules', suffix: 'duplicateRule' });
    expect(M.sftkMdDeleteSpec('LeadConvertSettings')).toMatchObject({ folder: 'LeadConvertSettings', suffix: 'LeadConvertSetting', edit: 'leadMapping' });
    expect(M.sftkMdDeleteSpec('ProcessBuilder')).toMatchObject({ mdType: 'Flow', folder: 'flows', suffix: 'flow' });
    expect(M.sftkMdDeleteSpec('Flow')).toBeNull();
    expect(FC).toContain("type === 'LookupFilter' ? { type, mdType: 'CustomField', what: 'lookup filter', special: 'lookupFilter' }");
    expect(FC).toContain("if (spec.special === 'lookupFilter') return (row && row._lookupFieldName) || id;");
    expect(FC).toContain("(type === 'MatchingRule' || type === 'DuplicateRule') && looksLikeId");
  });
});

describe('the lead mapping remover', () => {
  const lcs = '<fullName>LeadConvertSettings</fullName><allowOwnerChange>true</allowOwnerChange><objectMapping><inputObject>Lead</inputObject><mappingFields><inputField>Region__c</inputField><outputField>Area__c</outputField></mappingFields><mappingFields><inputField>Other__c</inputField><outputField>Other__c</outputField></mappingFields><outputObject>Account</outputObject></objectMapping><objectMapping><inputObject>Lead</inputObject><mappingFields><inputField>Region__c</inputField><outputField>Region__c</outputField></mappingFields><outputObject>Contact</outputObject></objectMapping>';
  it('takes out only the lines of this field, from either side, and keeps an emptied objectMapping (that is how Salesforce clears it)', () => {
    const r = M.sftkMdLeadMappingRemove(lcs, 'Lead', 'Region__c');
    expect(r.removed).toBe(2);
    expect(r.xml).toContain('<objectMapping><inputObject>Lead</inputObject><mappingFields><inputField>Other__c</inputField><outputField>Other__c</outputField></mappingFields><outputObject>Account</outputObject></objectMapping>');
    expect(r.xml).toContain('<objectMapping><inputObject>Lead</inputObject><outputObject>Contact</outputObject></objectMapping>');
    expect(M.sftkMdLeadMappingsFor(r.xml, 'Lead', 'Region__c')).toEqual([]);
    const t = M.sftkMdLeadMappingRemove(lcs, 'Account', 'Area__c');
    expect(t.removed).toBe(1);
    expect(t.xml).toContain('<inputField>Region__c</inputField><outputField>Region__c</outputField>');
    expect(M.sftkMdLeadMappingRemove(lcs, 'Account', 'Nope__c')).toMatchObject({ removed: 0, xml: lcs });
  });
});

describe('the wiring', () => {
  it('a process loses every version after being switched off; the lead mapping and the lookup filter are "removed", not "deleted"', () => {
    expect(FC).toContain('🗑 Delete process</button>');
    expect(FC).toContain("const verb = (spec.special === 'lookupFilter' || spec.edit) ? 'Remove' : 'Delete';");
    expect(FC).toContain("if (plan.pb.active) { const off = await bg({ type: 'SF_PATCH'");
    expect(FC).toContain("for (const v of plan.pb.versions) { const d = await bg({ type: 'SF_TOOLING_DELETE', orgUrl: _orgUrl, sid: _sid, sobject: 'Flow', id: v.id, _suppressError: true });");
    expect(FC).toContain("_afterDelete(spec.special === 'pb' ? 'ProcessBuilder' : type);");
  });
  it('a restore point may be a PATCH (the lookup field) or files (everything else), and both ways back honour it', () => {
    expect(FC).toContain("msg: plan.undoPatch ? { type: 'SF_PATCH', ...plan.undoPatch } : { type: 'SF_METADATA_DEPLOY', zipBase64: zipBack },");
    expect(FC).toContain("if (md.patch) { const r = await bg({ type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid, _suppressError: true, ...md.patch });");
    expect(FC).toContain("if (!md || (!md.patch && (!Array.isArray(md.files) || !md.files.length))) throw new Error('Snapshot has no files — cannot deploy');");
  });
});

// live 2026-11-07: a duplicate rule read back carries <alertText xsi:nil="true"/> — the prefix is declared on the SOAP
// envelope, not in the record, so the package file must declare it or Salesforce refuses the restore on bad XML
describe('a restored record declares the xsi prefix its nil elements use', () => {
  const M2 = extractFunctions('sftk-mdapi.js', ['sftkMdPackageFiles', 'sftkMdDeleteSpec', '_sftkMdDeleteTable', 'sftkMdRecordFileXml', 'sftkMdFindElement', 'sftkMdEscape', '_sftkPkgXml']);
  it('on a top-level record and inside a parent file', () => {
    const top = M2.sftkMdPackageFiles('DuplicateRule', 'Account.X', '<fullName>Account.X</fullName><alertText xsi:nil="true"/><sortOrder>2</sortOrder>');
    expect(top[1].text).toContain('<DuplicateRule xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><alertText xsi:nil="true"/>');
    const child = M2.sftkMdPackageFiles('ValidationRule', 'Account.X', '<fullName>Account.X</fullName><active>true</active>');
    expect(child[1].text).toContain('<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><validationRules>');
  });
});
