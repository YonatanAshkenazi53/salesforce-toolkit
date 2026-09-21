// CONFIGURATION AS METADATA — Custom Metadata records, Custom Labels and
// their translations (user 2026-08-22: "Seeder should also support custom
// metadata types, and custom settings… Because they may be essential for
// seeding operation" · "Also custom labels" · "Custom labels also has
// translations"). These are the pure builders: the exact package a seed
// would deploy, asserted without touching an org.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const CMDT = readFileSync(new URL('../sftk-cmdt.js', import.meta.url), 'utf8');
const SEED = readFileSync(new URL('../studio-seed.js', import.meta.url), 'utf8');

const F = extractFunctions('sftk-cmdt.js', [
  'sftkCmdtEsc', 'sftkCmdtTypeName', 'sftkCmdtFullName', 'sftkCmdtXsiType',
  'sftkCmdtFieldPlan', 'sftkCmdtReadValue', 'sftkCmdtValueXml',
  'sftkCmdtRecordXml', 'sftkCmdtPackageXml', 'sftkCmdtSoql', 'sftkCmdtBuildFiles',
  'sftkLabelSoql', 'sftkLabelDeployable', 'sftkLabelXml', 'sftkLabelsFileXml',
  'sftkMetaPackageXml', 'sftkLabelTransSoql', 'sftkLabelTransGroup',
  'sftkLabelTransFileXml',
]);

describe('Custom Metadata — naming', () => {
  it('strips __mdt for the type half of a fullName, case-insensitively', () => {
    expect(F.sftkCmdtTypeName('Country_Setting__mdt')).toBe('Country_Setting');
    expect(F.sftkCmdtTypeName('Thing__MDT')).toBe('Thing');
    expect(F.sftkCmdtTypeName('NoSuffix')).toBe('NoSuffix');
  });

  it('joins type and DeveloperName the way package.xml members are written', () => {
    expect(F.sftkCmdtFullName('Country_Setting__mdt', 'Israel')).toBe('Country_Setting.Israel');
  });

  it('escapes XML in values — a stray & or < must not break the package', () => {
    expect(F.sftkCmdtEsc('a & b < c > d "e" \'f\''))
      .toBe('a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;');
    expect(F.sftkCmdtEsc(null)).toBe('');
  });
});

describe('Custom Metadata — field plan', () => {
  it('maps Salesforce types onto the xsi types the deploy demands', () => {
    expect(F.sftkCmdtXsiType('boolean')).toBe('xsd:boolean');
    expect(F.sftkCmdtXsiType('int')).toBe('xsd:int');
    expect(F.sftkCmdtXsiType('currency')).toBe('xsd:double');
    expect(F.sftkCmdtXsiType('percent')).toBe('xsd:double');
    expect(F.sftkCmdtXsiType('date')).toBe('xsd:date');
    expect(F.sftkCmdtXsiType('datetime')).toBe('xsd:dateTime');
    // Unknown types still deploy as strings — Salesforce coerces, and
    // carrying the value beats dropping the field.
    expect(F.sftkCmdtXsiType('somethingNew')).toBe('xsd:string');
  });

  it('skips identity and bookkeeping fields — they are carried as fullName/label', () => {
    const plan = F.sftkCmdtFieldPlan({ fields: [
      { name: 'Id', type: 'id' },
      { name: 'DeveloperName', type: 'string' },
      { name: 'MasterLabel', type: 'string' },
      { name: 'NamespacePrefix', type: 'string' },
      { name: 'QualifiedApiName', type: 'string' },
      { name: 'Rate__c', type: 'double' },
    ] });
    expect(plan.fields.map(f => f.name)).toEqual(['Rate__c']);
  });

  it('traverses relationship fields by NAME — an Id means nothing in another org', () => {
    const plan = F.sftkCmdtFieldPlan({ fields: [
      { name: 'Object__c', type: 'reference', relationshipName: 'Object__r', referenceTo: ['EntityDefinition'] },
      { name: 'Field__c', type: 'reference', relationshipName: 'Field__r', referenceTo: ['FieldDefinition'] },
      { name: 'Parent__c', type: 'reference', relationshipName: 'Parent__r', referenceTo: ['Country_Setting__mdt'] },
    ] });
    expect(plan.fields.map(f => f.soql)).toEqual([
      'Object__r.QualifiedApiName', 'Field__r.QualifiedApiName', 'Parent__r.DeveloperName',
    ]);
    expect(plan.unsupported).toEqual([]);
  });

  it('names what it cannot carry instead of dropping it silently', () => {
    const plan = F.sftkCmdtFieldPlan({ fields: [
      { name: 'Owner__c', type: 'reference', relationshipName: 'Owner__r', referenceTo: ['User'] },
      { name: 'Total__c', type: 'double', calculated: true },
      { name: 'Odd__c', type: 'reference', referenceTo: ['EntityDefinition'] },
    ] });
    expect(plan.fields).toEqual([]);
    expect(plan.unsupported.map(u => u.name).sort()).toEqual(['Odd__c', 'Owner__c', 'Total__c']);
    expect(plan.unsupported.find(u => u.name === 'Owner__c').why).toMatch(/User/);
    expect(plan.unsupported.find(u => u.name === 'Total__c').why).toMatch(/formula/i);
  });

  it('reads traversed values out of the nested SOQL row, not the flat name', () => {
    const row = { Rate__c: 5, Object__r: { QualifiedApiName: 'Account' } };
    expect(F.sftkCmdtReadValue(row, { soql: 'Rate__c' })).toBe(5);
    expect(F.sftkCmdtReadValue(row, { soql: 'Object__r.QualifiedApiName' })).toBe('Account');
    // A null relationship is null, never the string "undefined".
    expect(F.sftkCmdtReadValue({ Object__r: null }, { soql: 'Object__r.QualifiedApiName' })).toBe(null);
    expect(F.sftkCmdtReadValue({}, { soql: 'Missing__c' })).toBe(null);
  });

  it('always reads the identity columns, and never asks for a column twice', () => {
    const plan = { fields: [{ soql: 'Rate__c' }, { soql: 'DeveloperName' }] };
    const q = F.sftkCmdtSoql('Country_Setting__mdt', plan);
    expect(q).toBe('SELECT Id, DeveloperName, MasterLabel, Rate__c FROM Country_Setting__mdt');
  });
});

describe('Custom Metadata — the package', () => {
  it('writes an explicit nil for a blank value so a re-seed is idempotent', () => {
    // Omitting the block would leave whatever the target already had —
    // the record would then differ from the source and stay differing.
    expect(F.sftkCmdtValueXml('Rate__c', null, 'xsd:double')).toContain('<value xsi:nil="true"/>');
    expect(F.sftkCmdtValueXml('Rate__c', '', 'xsd:double')).toContain('<value xsi:nil="true"/>');
    expect(F.sftkCmdtValueXml('Rate__c', 0, 'xsd:double'))
      .toContain('<value xsi:type="xsd:double">0</value>');
  });

  it('builds a record file carrying label, values and the xsi namespaces', () => {
    const plan = F.sftkCmdtFieldPlan({ fields: [{ name: 'Rate__c', type: 'double' }] });
    const xml = F.sftkCmdtRecordXml('Country_Setting__mdt', { DeveloperName: 'Israel', MasterLabel: 'Israel', Rate__c: 17 }, plan);
    expect(xml).toContain('<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata"');
    expect(xml).toContain('xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"');
    expect(xml).toContain('<label>Israel</label>');
    expect(xml).toContain('<field>Rate__c</field>');
    expect(xml).toContain('<value xsi:type="xsd:double">17</value>');
  });

  it('names each file after the record fullName and lists it as a member', () => {
    const plan = { fields: [] };
    const built = F.sftkCmdtBuildFiles('Country_Setting__mdt',
      [{ DeveloperName: 'Israel' }, { DeveloperName: 'Spain' }, { /* no name */ }], plan);
    expect(built.members).toEqual(['Country_Setting.Israel', 'Country_Setting.Spain']);
    expect(built.files.map(f => f.name)).toEqual([
      'customMetadata/Country_Setting.Israel.md',
      'customMetadata/Country_Setting.Spain.md',
    ]);
  });

  it('package.xml dedupes and sorts members under one CustomMetadata type', () => {
    const xml = F.sftkCmdtPackageXml(['B.two', 'A.one', 'B.two', null], '62.0');
    expect(xml.indexOf('A.one')).toBeLessThan(xml.indexOf('B.two'));
    expect(xml.match(/<members>B\.two<\/members>/g)).toHaveLength(1);
    expect(xml).toContain('<name>CustomMetadata</name>');
    expect(xml).toContain('<version>62.0</version>');
  });
});

describe('Custom Labels', () => {
  it('reads them from the Tooling object that actually holds them', () => {
    // Custom Labels have no REST sObject — ExternalString IS the label.
    expect(F.sftkLabelSoql()).toMatch(/FROM ExternalString$/);
    expect(F.sftkLabelSoql()).toContain('NamespacePrefix');
  });

  it('refuses managed-package labels by NAME rather than failing the deploy', () => {
    const split = F.sftkLabelDeployable([
      { Name: 'Mine', NamespacePrefix: null },
      { Name: 'Theirs', NamespacePrefix: 'acme' },
      { /* no name */ },
    ]);
    expect(split.deployable.map(r => r.Name)).toEqual(['Mine']);
    expect(split.skipped).toEqual([{ name: 'Theirs', why: 'belongs to managed package acme' }]);
  });

  it('writes every required label element, and omits categories when blank', () => {
    const withCat = F.sftkLabelXml({ Name: 'Greeting', MasterLabel: 'Greeting', Value: 'Hi', Language: 'en_US', Category: 'ui', IsProtected: false });
    expect(withCat).toContain('<fullName>Greeting</fullName>');
    expect(withCat).toContain('<categories>ui</categories>');
    expect(withCat).toContain('<shortDescription>Greeting</shortDescription>');
    expect(withCat).toContain('<value>Hi</value>');
    expect(withCat).toContain('<protected>false</protected>');
    const noCat = F.sftkLabelXml({ Name: 'X', Value: 'v', Category: '   ' });
    expect(noCat).not.toContain('<categories>');
    // No language on the row still produces a valid file.
    expect(noCat).toContain('<language>en_US</language>');
  });

  it('puts every label in ONE CustomLabels file — the Metadata API shape', () => {
    const file = F.sftkLabelsFileXml([{ Name: 'A', Value: '1' }, { Name: 'B', Value: '2' }]);
    expect(file.match(/<labels>/g)).toHaveLength(2);
    expect(file).toContain('<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">');
  });

  it('escapes a label value that contains markup', () => {
    expect(F.sftkLabelXml({ Name: 'X', Value: '<b>bold</b> & more' }))
      .toContain('<value>&lt;b&gt;bold&lt;/b&gt; &amp; more</value>');
  });
});

describe('Custom Label translations', () => {
  it('reads the Tooling object that holds translated values', () => {
    expect(F.sftkLabelTransSoql()).toMatch(/FROM ExternalStringLocalization$/);
    expect(F.sftkLabelTransSoql()).toContain('ExternalStringId');
  });

  it('groups by language and resolves each row back to its label NAME', () => {
    const g = F.sftkLabelTransGroup([
      { ExternalStringId: '1', Language: 'he', Value: 'שלום' },
      { ExternalStringId: '2', Language: 'he', Value: 'ביי' },
      { ExternalStringId: '1', Language: 'fr', Value: 'Bonjour' },
    ], { 1: 'Hello', 2: 'Bye' });
    expect(Object.keys(g.byLang).sort()).toEqual(['fr', 'he']);
    // Sorted by label name so the file is byte-stable across runs.
    expect(g.byLang.he.map(e => e.name)).toEqual(['Bye', 'Hello']);
    expect(g.orphaned).toBe(0);
  });

  it('drops translations whose label is not in the deploy — and counts them', () => {
    // A Translations file naming a label the package does not carry is
    // rejected by the deploy, taking every other label down with it.
    const g = F.sftkLabelTransGroup([
      { ExternalStringId: '1', Language: 'he', Value: 'a' },
      { ExternalStringId: '99', Language: 'he', Value: 'b' },
    ], { 1: 'Hello' });
    expect(g.byLang.he).toHaveLength(1);
    expect(g.orphaned).toBe(1);
  });

  it('writes only the customLabels section of a Translations file', () => {
    // A Translations file that also claimed field or picklist sections
    // would overwrite the target's with nothing.
    const file = F.sftkLabelTransFileXml([{ name: 'Hello', value: 'שלום' }]);
    expect(file).toContain('<Translations xmlns="http://soap.sforce.com/2006/04/metadata">');
    expect(file).toContain('<name>Hello</name>');
    expect(file).toContain('<label>שלום</label>');
    expect(file).not.toContain('<fields>');
    expect(file).not.toContain('<customTabs>');
  });
});

describe('mixed-type package.xml', () => {
  it('emits one types block per non-empty type and omits the empty ones', () => {
    const xml = F.sftkMetaPackageXml({
      CustomLabel: ['Hello'], Translations: ['he'], CustomMetadata: [],
    }, '62.0');
    expect(xml).toContain('<name>CustomLabel</name>');
    expect(xml).toContain('<name>Translations</name>');
    expect(xml).not.toContain('<name>CustomMetadata</name>');
  });

  it('is a valid package even with nothing in it', () => {
    const xml = F.sftkMetaPackageXml({}, '62.0');
    expect(xml).toContain('<Package xmlns="http://soap.sforce.com/2006/04/metadata">');
    expect(xml).toContain('<version>62.0</version>');
  });
});

// ── How the Seeder USES all of the above ───────────────────────────────
describe('the Seeder wires configuration honestly', () => {
  it('deploys labels and their translations in the SAME package', () => {
    // Two deploys would leave a window where the labels exist untranslated,
    // and a failed second deploy would leave it that way for good.
    expect(SEED).toContain('translations/${l}.translation');
    expect(SEED).toMatch(/CustomLabel: split\.deployable\.map\(r => r\.Name\)/);
    expect(SEED).toMatch(/\.\.\.\(langs\.length \? \{ Translations: langs \} : \{\}\)/);
  });

  it('still deploys the labels when translations cannot be read, and says so', () => {
    expect(SEED).toMatch(/translations not read/);
    expect(SEED).toContain('labels deploy WITHOUT translated values');
  });

  it('runs configuration BEFORE any wipe or seed', () => {
    const body = SEED.slice(SEED.indexOf('_seedPort = (typeof _openRunPort'));
    expect(body.indexOf('what.config && _seedCfgSel.size')).toBeGreaterThan(-1);
    expect(body.indexOf('what.config && _seedCfgSel.size'))
      .toBeLessThan(body.indexOf('if (what.wipe) {'));
  });

  it('gates the Custom Setting REPLACE — it deletes the target\'s rows', () => {
    expect(SEED).toContain('function sftkSeedCfgReplaceGate');
    expect(SEED).toContain('Custom Settings will be REPLACED');
    // Metadata needs no gate: deploying is upsert-by-name and destroys nothing.
    expect(SEED).toMatch(/const settings = \[\.\.\._seedCfgSel\]\.filter\(n => n !== '__labels__' && !\/__mdt\$\/i\.test\(n\)\)/);
  });

  it('never coerces an unknown target count to 0 in the replace gate', () => {
    const gate = SEED.slice(SEED.indexOf('function sftkSeedCfgReplaceGate'));
    expect(gate.slice(0, 2000)).toContain('an unknown number of');
  });

  it('replaces settings in the safe order — delete, then insert', () => {
    const fn = SEED.slice(SEED.indexOf('async function sftkSeedCfgSyncSetting'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    // A hierarchy setting rejects a second row for an owner that already
    // has one, so the target's rows must go first.
    expect(body.indexOf('SF_COLLECTIONS_DELETE')).toBeLessThan(body.indexOf('SF_COLLECTIONS_CREATE'));
  });

  it('reads CMDT with SF_QUERY_ALL — a paged type must not silently truncate', () => {
    const fn = SEED.slice(SEED.indexOf('async function sftkSeedCfgDeployMdt'));
    expect(fn.slice(0, 2000)).toContain("type: 'SF_QUERY_ALL'");
  });

  it('the library is loaded before the view that uses it', () => {
    const html = readFileSync(new URL('../studio.html', import.meta.url), 'utf8');
    expect(html.indexOf('sftk-cmdt.js')).toBeGreaterThan(-1);
    expect(html.indexOf('sftk-cmdt.js')).toBeLessThan(html.indexOf('studio-seed.js'));
    expect(html.indexOf('sftk-zip.js')).toBeLessThan(html.indexOf('studio-seed.js'));
  });

  it('exports on globalThis like the rest of the shared libraries', () => {
    expect(CMDT).toContain('globalThis.sftkCmdtBuildFiles');
    expect(CMDT).toContain('globalThis.sftkLabelTransFileXml');
    expect(CMDT).not.toContain('module.exports');
  });
});
