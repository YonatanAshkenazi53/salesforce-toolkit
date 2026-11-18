// owner 2026-11-18: "what four types ?" → "and add all the 4" — data integration rules, Embedded Service
// configuration, home page components and s-controls were left out of the full metadata text scan; each can hold a
// field's name. Live on npc2 the same day (docs/fixtures/gap-kinds-fixture/kinds-app, home page component
// SFTK_Kind_Home): 1,098 components read, the component listed under its own group; Salesforce accepts the delete.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';
const S = extractFunctions('sftk-sweep.js', [
  'sftkSweepForms', 'sftkSweepHits', 'sftkSweepSections', '_sftkSweepSectionAt', 'sftkSweepKind', 'sftkSweepRun',
  'sftkSweepKindTable', '_sftkSweepSkip', '_sftkSweepBinary', 'sftkSweepIsText',
]);

describe('the four kinds', () => {
  it('are asked for by the retrieve', () => {
    const skip = S._sftkSweepSkip();
    for (const t of ['CleanDataService', 'EmbeddedServiceConfig', 'HomePageComponent', 'Scontrol']) expect(skip.has(t), t).toBe(false);
    // what stays out is binary, settings or holds no field
    for (const t of ['Certificate', 'InstalledPackage', 'Settings', 'Document']) expect(skip.has(t), t).toBe(true);
  });
  it('each has its own group, as something that breaks later', () => {
    const k = S.sftkSweepKindTable();
    for (const t of ['CleanDataService', 'EmbeddedServiceConfig', 'HomePageComponent', 'Scontrol']) { expect(k[t].sev, t).toBe('mention'); expect(k[t].label, t).toBeTruthy(); }
  });
  it('a home page component whose HTML names the field is listed under Home page components', () => {
    const F = S.sftkSweepForms('SFTK_Kind__c', 'Tag__c');
    const xml = '<?xml version="1.0"?>\n<HomePageComponent><body>&lt;p&gt;names SFTK_Kind__c.Tag__c as text&lt;/p&gt;</body><pageComponentType>htmlArea</pageComponentType></HomePageComponent>';
    const r = S.sftkSweepRun(new Map([['unpackaged/homePageComponents/SFTK_Kind_Home.homePageComponent', xml]]), F);
    expect(Object.keys(r.byType)).toEqual(['HomePageComponent']);
    expect(r.byType.HomePageComponent.items[0].component).toBe('SFTK_Kind_Home');
  });
  it('an s-control and a data integration rule land in their groups by their folders', () => {
    const F = S.sftkSweepForms('SFTK_Kind__c', 'Tag__c');
    const r = S.sftkSweepRun(new Map([
      ['unpackaged/scontrols/Old.scf', 'var x = "{!SFTK_Kind__c.Tag__c}";'],
      ['unpackaged/cleanDataServices/Rule.cleanDataService', '<CleanDataService><cleanRules><fieldMappings><SObjectType>SFTK_Kind__c</SObjectType><fieldMappingRows><fieldName>Tag__c</fieldName></fieldMappingRows></fieldMappings></cleanRules></CleanDataService>'],
    ]), F);
    expect(Object.keys(r.byType).sort()).toEqual(['CleanDataService', 'Scontrol']);
  });
});
