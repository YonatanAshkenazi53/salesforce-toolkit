// QA 1.1 finding 18 — an Aura bundle is a blocker of this field only when it names the object too; the name alone is listed under mentions.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const { fcAuraBundlesNaming: naming } = extractFunctions('field-cleaner.js', ['fcAuraBundlesNaming']);
const row = (bid, name, defType, source, ns) => ({ Id: `${bid}_${defType}`, DefType: defType, Source: source, AuraDefinitionBundleId: bid, AuraDefinitionBundle: { DeveloperName: name, NamespacePrefix: ns || null } });

describe('which Aura bundles name the field', () => {
  const rows = [
    row('0Ab1', 'accountCard', 'COMPONENT', '<aura:component><aura:attribute name="account" type="Account"/>{!v.account.Status__c}</aura:component>'),
    row('0Ab2', 'caseCard', 'COMPONENT', '<aura:component><aura:attribute name="case" type="Case"/>{!v.case.Status__c}</aura:component>'),
    row('0Ab3', 'splitCard', 'COMPONENT', '<aura:component><aura:attribute name="rec" type="Account"/></aura:component>'),
    row('0Ab3', 'splitCard', 'CONTROLLER', '({ init: function (c) { c.get("v.rec").Status__c = "x"; } })'),
    row('0Ab4', 'wordOnly', 'CONTROLLER', '({ go: function () { var f = "Status__c"; } })'),
    row('0Ab5', 'other', 'COMPONENT', '<aura:component>{!v.account.Old_Status__c} Account</aura:component>'),
    row('0Ab6', 'packaged', 'COMPONENT', '<aura:component><aura:attribute name="a" type="Account"/>{!v.a.Status__c}</aura:component>', 'pkg'),
  ];
  const got = naming(rows, 'Account', 'Status__c');
  const of = id => got.find(b => b.id === id);
  it('a bundle that names the field and the object is a blocker — also when they are in two of its sources', () => {
    expect(of('0Ab1')).toEqual({ id: '0Ab1', name: 'accountCard', obj: true });
    expect(of('0Ab3')).toEqual({ id: '0Ab3', name: 'splitCard', obj: true });
  });
  it('a bundle that reads another object’s same-named field, or only says the word, is told apart', () => {
    expect(of('0Ab2')).toEqual({ id: '0Ab2', name: 'caseCard', obj: false });
    expect(of('0Ab4')).toEqual({ id: '0Ab4', name: 'wordOnly', obj: false });
  });
  it('a longer name that holds the field’s name is no mention; a package’s own component is left out; one row per bundle', () => {
    expect(of('0Ab5')).toBeUndefined();
    expect(of('0Ab6')).toBeUndefined();
    expect(got.map(b => b.id)).toEqual(['0Ab1', '0Ab2', '0Ab3', '0Ab4']);
  });
  it('the object’s name is a whole word, in any case', () => {
    expect(naming([row('0Ab7', 'x', 'COMPONENT', 'type="AccountContactRelation" Status__c')], 'Account', 'Status__c')[0].obj).toBe(false);
    expect(naming([row('0Ab7', 'x', 'COMPONENT', 'sobjectType: "account", STATUS__C')], 'Account', 'Status__c')[0].obj).toBe(true);
  });
  it('a custom field of Task or Event is Activity’s: any of the three names counts as the object', () => {
    const r = [row('0Ab8', 'taskCard', 'COMPONENT', '<aura:attribute name="t" type="Task"/>{!v.t.Region__c}')];
    expect(naming(r, 'Activity', 'Region__c')[0].obj).toBe(true);
    expect(naming(r, 'Event', 'Region__c')[0].obj).toBe(true);
    expect(naming(r, 'Event', 'Subject')[0]).toBeUndefined();
  });
  it('nothing to read gives nothing', () => {
    expect(naming(null, 'Account', 'Status__c')).toEqual([]);
    expect(naming(rows, '', 'Status__c')).toEqual([]);
  });
});

describe('the scan and the list', () => {
  it('the leg lists the two kinds apart, and does not repeat as a mention what the index lists as a blocker', () => {
    expect(FC).toContain("for (const b of fcAuraBundlesNaming(res?.records, obj, _selField.api)) {");
    expect(FC).toContain("if (!b.obj && seen.has(fcDepKey('AuraDefinitionBundle', b.id))) continue;");
    expect(FC).toContain("add(b.obj ? 'AuraDefinitionBundle' : 'AuraText', b.id, b.name);");
  });
  it('the name-only kind does not lock the delete, and has its Setup link', () => {
    expect(FC).toMatch(/AuraText:\s+\{ icon: '⚡', label: 'Aura Components \(name the field, not the object\)', fixable: false, sev: 'silent',/);
    expect(FC).toContain("AuraText: '/lightning/setup/LightningComponentBundles/home',");
  });
  it('a name-only bundle that Salesforce then names in its refusal moves to the blockers', () => {
    expect(FC).toContain("const asText = type === 'AuraDefinitionBundle' ? scan.deps.find(d => d.MetadataComponentType === 'AuraText' && String(d.MetadataComponentId).slice(0, 15) === String(row.Id).slice(0, 15)) : null;");
    expect(FC).toContain('if (asText) { asText.MetadataComponentType = type; asText._tag = TAG; n++; continue; }');
  });
});
