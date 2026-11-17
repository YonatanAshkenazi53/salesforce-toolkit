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

describe('⇄ in a custom setting value', () => {
  const r = t => fcSettingValueWithout(t, 'Account', 'Region__c', 'Area__c');
  it('the name becomes the new one, in the form it was written; the rest is untouched', () => {
    expect(r('Account.Region__c')).toBe('Account.Area__c');
    expect(r('Region__c')).toBe('Area__c');
    expect(r('Account.Name, Account.Region__c ; Type')).toBe('Account.Name, Account.Area__c ; Type');
    expect(r('Contact.Region__c, Region__c_Old')).toBe('Contact.Region__c, Region__c_Old');
  });
  it('the row offers ⇄ only while a replacement is picked, and the plan follows the button pressed', () => {
    expect(FC).toMatch(/special === 'settingValue'\) return \(_replOn\(\) \? `<button class="btn btn-primary btn-sm fc-fix-btn fc-del-btn" \$\{attrs\} data-swap="1" data-way="delete"/);
    expect(FC).toContain("fcSettingValueWithout(was, obj, field, _swapOn() ? _replField.api : null)");
  });
});

describe('a file is named with the local day', () => {
  const ctx2 = vm.createContext({ console });
  vm.runInContext(read('sftk-history.js') + '\nglobalThis.__d = { sftkLocalDay, sftkLocalStamp };', ctx2);
  it('the user\'s own clock, zero-padded', () => {
    const d = new Date(2026, 0, 5, 0, 7, 9);   // local 2026-01-05 00:07:09 — in UTC+ zones that is still the 4th
    expect(ctx2.__d.sftkLocalDay(d)).toBe('2026-01-05');
    expect(ctx2.__d.sftkLocalStamp(d)).toBe('2026-01-05-000709');
  });
  it('no export file is named from toISOString any more', () => {
    for (const f of ['popup.js', 'sftk-feed.js', 'sftk-toolhistory.js', 'studio-builder.js', 'studio-history.js', 'studio-compare.js']) {
      for (const line of read(f).split('\n')) if (/(fname|download|stamp|const date) ?[=(].*toISOString\(\)\.slice\(0, 10\)/.test(line)) throw new Error(f + ': ' + line.trim().slice(0, 120));
    }
  });
});

// "וcmt?" (owner 2026-11-08): only a relationship column blocks the delete. Read live 2026-11-16: Salesforce
// describes a Field Definition / Entity Definition column as a string with extraTypeInfo "externallookup".
// Live on npc2: SFTK_Live_Cmt.PkgRef (Field__c, relationship) → 🔒 Custom Metadata Records;
// SFTK_Txt_Cmt.TxtRef (Note__c, Text) → 👀 Custom Metadata Records (text value).
describe('a custom metadata record that holds the name: blocker or mention', () => {
  const { fcCmtHoldKind, fcCmtTypeApi } = extractFunctions('field-cleaner.js', ['fcCmtHoldKind', 'fcCmtTypeApi']);
  const fields = [{ name: 'Field__c', extraTypeInfo: 'externallookup' }, { name: 'Entity__c', extraTypeInfo: 'externallookup' }, { name: 'Note__c', extraTypeInfo: null }, { name: 'Long__c', extraTypeInfo: 'plaintextarea' }];
  it('a relationship column blocks; text columns do not', () => {
    expect(fcCmtHoldKind(['Field__c'], fields)).toBe('relation');
    expect(fcCmtHoldKind(['Note__c'], fields)).toBe('text');
    expect(fcCmtHoldKind(['note__c', 'Long__c'], fields)).toBe('text');
    expect(fcCmtHoldKind(['Note__c', 'Field__c'], fields)).toBe('relation');
  });
  it('not read, or a column the describe does not list → unknown, which is listed as a blocker (the careful side)', () => {
    expect(fcCmtHoldKind(['Note__c'], null)).toBe('unknown');
    expect(fcCmtHoldKind(['Other__c'], fields)).toBe('unknown');
    expect(fcCmtHoldKind(['Note__c', 'Other__c'], fields)).toBe('unknown');
    expect(fcCmtHoldKind([], fields)).toBe('unknown');
    expect(FC).toContain("add(kind === 'text' ? 'CustomMetadataText' : 'CustomMetadataRecord', rec.fullName,");
  });
  it('the type of a record, a package’s too', () => {
    expect(fcCmtTypeApi('SFTK_Live_Cmt.PkgRef')).toBe('SFTK_Live_Cmt__mdt');
    expect(fcCmtTypeApi('ns__Rule.Rec_1')).toBe('ns__Rule__mdt');
    expect(fcCmtTypeApi('')).toBe('');
    expect(fcCmtTypeApi("x' OR 1.r")).toBe('');
  });
  it('the text kind is a mention with the same ✂ / ⇄ / 🗑 as the blocker kind', () => {
    expect(M.sftkMdEditWays('CustomMetadataText')).toEqual(M.sftkMdEditWays('CustomMetadataRecord'));
    expect(M.sftkMdDeleteSpec('CustomMetadataText')).toMatchObject({ mdType: 'CustomMetadata', folder: 'customMetadata', suffix: 'md' });
    expect(FC).toContain("label: 'Custom Metadata Records (text value)', fixable: false, sev: 'silent',");
    const xml = '<fullName>T.R</fullName><label>R</label><values><field>Note__c</field><value xsi:type="xsd:string">Account.Region__c</value></values>';
    const a = M.sftkMdEditField('CustomMetadataText', xml, 'Account', 'Region__c', null), b = M.sftkMdEditField('CustomMetadataRecord', xml, 'Account', 'Region__c', null);
    expect(a.xml).toBe(b.xml);
    expect(a.refused || null).toBe(b.refused || null);
  });
});

describe('a path', () => {
  const path = (ent, runs, steps) => `<fullName>P</fullName><active>true</active><entityName>${ent}</entityName><fieldName>${runs}</fieldName><masterLabel>P</masterLabel>${steps.map(([v, fs]) => `<pathAssistantSteps>${fs.map(f => `<fieldNames>${f}</fieldNames>`).join('')}<info>i</info><picklistValueName>${v}</picklistValueName></pathAssistantSteps>`).join('')}<recordTypeName>__MASTER__</recordTypeName>`;
  it('is edited here, and never deleted: Salesforce refuses a path\'s delete through its APIs (live 2026-11-16)', () => {
    expect(M.sftkMdEditWays('PathAssistant')).toEqual({ remove: true, replace: true });
    expect(M.sftkMdDeleteSpec('PathAssistant')).toMatchObject({ mdType: 'PathAssistant', folder: 'pathAssistants', suffix: 'pathAssistant', what: 'path', noDelete: true });
    expect(FC).toContain('const del = (spec && !spec.noDelete &&');
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
