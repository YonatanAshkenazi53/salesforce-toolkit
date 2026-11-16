// Every listed row carries an action of its own (owner 2026-11-16: "we said all items must have a delete/remove").
// The three kinds that had only ↗ Setup:
//   Custom Setting Records                      ✂ the field's name out of the record's value (a data write, undone by writing it back)
//   Email Alerts (send a template …)            🗑 the email alert, through the WorkflowAlert engine
//   Paths                                       ✂ / ⇄ the step's key field, 🗑 the path
// Live: scripts/dev/live/fc-every-row-acts.mjs (npc2: all three cleared, verified by re-read, ↩ Undo all 3 of 3).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const FC = read('field-cleaner.js');
const { fcSettingValueWithout } = extractFunctions('field-cleaner.js', ['fcSettingValueWithout']);
const ctx = vm.createContext({ console });
vm.runInContext(read('sftk-mdapi.js') + '\nglobalThis.__m = { sftkMdEditField, sftkMdEditWays, sftkMdDeleteSpec };', ctx);
const M = ctx.__m;

describe('a custom setting value without the field', () => {
  const w = t => fcSettingValueWithout(t, 'Account', 'Region__c');
  it('the name alone leaves nothing', () => {
    expect(w('Account.Region__c')).toBe('');
    expect(w('Region__c')).toBe('');
    expect(w('  account.region__c ')).toBe('');
  });
  it('a list keeps the others, with the separators tidied', () => {
    expect(w('Account.Name, Account.Region__c, Account.Type')).toBe('Account.Name, Account.Type');
    expect(w('Region__c;Type')).toBe('Type');
    expect(w('Name|Region__c')).toBe('Name');
    expect(w('Name, Region__c')).toBe('Name');
  });
  it('another object\'s same-named field and a longer name stay', () => {
    expect(w('Contact.Region__c')).toBe('Contact.Region__c');
    expect(w('Region__c_Old, My_Region__c')).toBe('Region__c_Old, My_Region__c');
    expect(w('Account.Region__c, Contact.Region__c')).toBe('Contact.Region__c');
  });
  it('nothing to take out = the same text; no text = empty', () => {
    expect(w('Account.Name')).toBe('Account.Name');
    expect(w(null)).toBe('');
  });
});

describe('a path', () => {
  const path = (ent, runs, steps) => `<fullName>P</fullName><active>true</active><entityName>${ent}</entityName><fieldName>${runs}</fieldName><masterLabel>P</masterLabel>${steps.map(([v, fs]) => `<pathAssistantSteps>${fs.map(f => `<fieldNames>${f}</fieldNames>`).join('')}<info>i</info><picklistValueName>${v}</picklistValueName></pathAssistantSteps>`).join('')}<recordTypeName>__MASTER__</recordTypeName>`;
  it('is edited here, and never deleted: Salesforce refuses a path\'s delete through its APIs (live 2026-11-16)', () => {
    expect(M.sftkMdEditWays('PathAssistant')).toEqual({ remove: true, replace: true });
    expect(M.sftkMdDeleteSpec('PathAssistant')).toMatchObject({ mdType: 'PathAssistant', folder: 'pathAssistants', suffix: 'pathAssistant', what: 'path', noDelete: true });
    expect(FC).toContain('const del = (spec && !spec.noDelete &&');
    expect(FC).toContain('const canDel = !!dSpec && !dSpec.noDelete;');
    expect(FC).toContain('if (!spec || spec.noDelete) throw new Error(');
  });
  it('✂ takes the field out of every step and nothing else', () => {
    const before = path('Account', 'Stage__c', [['New', ['Region__c', 'Type']], ['Won', ['Region__c']]]);
    const r = M.sftkMdEditField('PathAssistant', before, 'Account', 'Region__c', null);
    expect(r.refused || null).toBeNull();
    expect(r.xml).not.toContain('Region__c');
    expect(r.xml).toContain('<fieldNames>Type</fieldNames>');
    expect(r.xml).toContain('<fieldName>Stage__c</fieldName>');
    expect(r.xml.replace(/<fieldNames>Region__c<\/fieldNames>/g, '')).toBe(r.xml);
    expect(before.replace(/<fieldNames>Region__c<\/fieldNames>/g, '')).toBe(r.xml);
  });
  it('⇄ points the steps at the new field', () => {
    const r = M.sftkMdEditField('PathAssistant', path('Account', 'Stage__c', [['New', ['Region__c']]]), 'Account', 'Region__c', 'Area__c');
    expect(r.xml).toContain('<fieldNames>Area__c</fieldNames>');
    expect(r.xml).not.toContain('Region__c');
  });
  it('a path that RUNS on the field is refused with the way out — its picklist is never cut', () => {
    for (const before of [path('Account', 'Region__c', [['New', ['Type']]]), path('Account', 'Region__c', [['New', ['Region__c', 'Type']]])]) {
      for (const nf of [null, 'Area__c']) {
        const r = M.sftkMdEditField('PathAssistant', before, 'Account', 'Region__c', nf);
        expect(String(r.refused)).toMatch(/runs on the field itself/);
        expect(r.xml).toBe(before);
        expect(r.changed).toBe(false);
      }
    }
  });
  it('another object\'s path is not this field\'s', () => {
    const r = M.sftkMdEditField('PathAssistant', path('Contact', 'Stage__c', [['New', ['Region__c']]]), 'Account', 'Region__c', null);
    expect(String(r.refused)).toMatch(/Contact’s same-named field/);
  });
});

describe('the rows', () => {
  it('a row with one of the extra kinds is drawn with its action, not with Setup alone', () => {
    expect(FC).toContain("(!!sftkMdDeleteSpec(type) || type === 'LookupFilter' || !!_extraDeleteSpec(type, id))");
    const x = FC.slice(FC.indexOf('function _extraDeleteSpec(type, id)'), FC.indexOf('async function _deleteFullName'));
    expect(x).toContain("sftkMdDeleteSpec('WorkflowAlert')");
    expect(x).toContain("asType: 'WorkflowAlert'");
    expect(x).toContain("special: 'settingValue'");
    // the "N more were not read" line is not a record: no action on it
    expect(x).toContain('_csRows.has(');
  });
  it('the custom setting write shows before → after first, keeps the old value for the undo and re-reads', () => {
    const d = FC.slice(FC.indexOf("if (spec.special === 'settingValue') {\n      const info"), FC.indexOf("if (spec.special === 'lookupFilter') {\n      if (!/^"));
    expect(d).toContain('undoPatch: { path, body: before }');
    expect(d).toContain("verify: { query: q, tooling: false, pick: 'records.0', field: shown[0].col, equals: shown[0].before }");
    expect(d).toContain('nothing is changed without the value to put back');
    // only what the scan itself read is ever written to
    expect(d).toMatch(/\/\^\[A-Za-z0-9_\]\+\$\/\.test\(info\.sobject\)/);
    expect(FC).toContain('prePlan.shown.map(x =>');
  });
});
