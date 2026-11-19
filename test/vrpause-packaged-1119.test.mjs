// owner 2026-11-18/19, asked four times: "can we disable package validation rules and flows?" · "in data deployment?"
// · "And what about managed package validation rule bypass, etc" · "What about the package validations, etc. when
// doing data deployment" · "all".
// Read live 2026-11-19 on npc (the DLRS rule Not_42 on dlrs__LookupParent__c) — NOTHING WAS WRITTEN there:
//   · the rule's Edit page locks every input except Active;
//   · Tooling GET of its id answers NOT_FOUND, so the org's own way (Tooling Metadata PATCH) cannot reach it;
//   · the Metadata API reads it whole, and a CHECK-ONLY deploy of it with <active>false</active> is accepted ("Changed").
// So a namespaced rule is listed with the rest, read through readMetadata and switched by a deploy of itself.
// The real switch has not been run live by me: the write was refused by the session's permission check.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractFunctions } from './extract.mjs';
const VP = extractFunctions('sftk-vrpause.js', ['_sftkVpLit', 'sftkVrPauseSelect', 'sftkVrPauseList', 'sftkVrPauseHydrate', '_sftkVpReadPkg', 'sftkVrPausePkgInner', 'sftkVrPausePkgFiles', '_sftkVpWriteMsg', '_sftkVpBody']);

const FULL = 'dlrs__LookupParent__c.dlrs__Not_42';
const INNER = `<fullName>${FULL}</fullName><active>true</active><errorConditionFormula>dlrs__Total__c !=42</errorConditionFormula><errorDisplayField>dlrs__Total__c</errorDisplayField><errorMessage>The answer is not 42!</errorMessage>`;
const SOAP = `<soapenv:Envelope><soapenv:Body><readMetadataResponse><result><records xsi:type="ValidationRule">${INNER}</records></result></readMetadataResponse></soapenv:Body></soapenv:Envelope>`;
const ROWS = [
  { Id: '03dO', ValidationName: 'Own_Rule', NamespacePrefix: null, ManageableState: 'unmanaged', EntityDefinition: { QualifiedApiName: 'Account' } },
  { Id: '03dP', ValidationName: 'Not_42', NamespacePrefix: 'dlrs', ManageableState: 'installed', EntityDefinition: { QualifiedApiName: 'dlrs__LookupParent__c' } },
];

describe('a rule from an installed package', () => {
  it('is listed with the org’s own rules, under its full name, marked with its package', () => {
    const r = VP.sftkVrPauseSelect(ROWS);
    expect(r.managed).toEqual([]);
    expect(r.own).toEqual([
      { id: '03dO', name: 'Own_Rule', object: 'Account' },
      { id: '03dP', name: 'dlrs__Not_42', object: 'dlrs__LookupParent__c', pkg: 'dlrs', fullName: FULL },
    ]);
  });
  it('its definition is taken from the readMetadata answer — and only its own', () => {
    expect(VP.sftkVrPausePkgInner(SOAP, FULL)).toBe(INNER);
    expect(VP.sftkVrPausePkgInner(SOAP, 'dlrs__LookupParent__c.dlrs__Other')).toBe('');
    expect(VP.sftkVrPausePkgInner('<records xsi:nil="true"/>', FULL)).toBe('');
    expect(VP.sftkVrPausePkgInner('', FULL)).toBe('');
  });
  it('is deployed as it was read, with only <active> changed and its short name inside the object’s file', () => {
    const off = VP.sftkVrPausePkgFiles({ fullName: FULL, xml: INNER }, false);
    expect(off.map(f => f.name)).toEqual(['package.xml', 'objects/dlrs__LookupParent__c.object']);
    expect(off[0].text).toContain(`<types><members>${FULL}</members><name>ValidationRule</name></types>`);
    expect(off[1].text).toContain('<validationRules><fullName>dlrs__Not_42</fullName><active>false</active><errorConditionFormula>dlrs__Total__c !=42</errorConditionFormula>');
    expect(off[1].text).toContain('<errorMessage>The answer is not 42!</errorMessage></validationRules></CustomObject>');
    const on = VP.sftkVrPausePkgFiles({ fullName: FULL, xml: INNER.replace('<active>true</active>', '<active>false</active>') }, true);
    expect(on[1].text).toContain('<active>true</active>');
    expect(on[1].text).not.toContain('<active>false</active>');
  });
});

describe('the switch', () => {
  beforeEach(() => {
    globalThis.sftkBuildStoredZip = files => 'ZIP:' + files.map(f => f.name + '=' + new TextDecoder().decode(f.data)).join('|');
    globalThis.sftkMetaForPatch = md => ({ ...md });
  });
  afterEach(() => { delete globalThis.sftkBuildStoredZip; delete globalThis.sftkMetaForPatch; });
  it('a packaged rule goes through a metadata deploy; the org’s own rule through its Tooling record', () => {
    const p = VP._sftkVpWriteMsg({ id: '03dP', pkg: 'dlrs', fullName: FULL, xml: INNER }, false);
    expect(p.type).toBe('SF_METADATA_DEPLOY');
    expect(p.zipBase64).toContain('<active>false</active>');
    const o = VP._sftkVpWriteMsg({ id: '03dO', metadata: { active: true, errorConditionFormula: 'X' } }, false);
    expect(o).toEqual({ type: 'SF_PATCH', path: 'services/data/v62.0/tooling/sobjects/ValidationRule/03dO', body: { Metadata: { active: false, errorConditionFormula: 'X' } } });
  });
  it('the list reads a packaged rule through the Metadata API, never through its Tooling id; unreadable → the run is told', async () => {
    const calls = [];
    const send = async m => {
      calls.push(m.type + (m.mdType ? ':' + m.mdType : ''));
      if (/FROM ValidationRule WHERE Active = true/.test(String(m.query || ''))) return { records: ROWS };
      if (m.type === 'SF_TOOLING_GET') return m.id === '03dO' ? { Metadata: { active: true } } : { error: 'NOT_FOUND' };
      if (m.type === 'SF_MD_READ') return { text: SOAP };
      return { error: 'unexpected' };
    };
    const l = await VP.sftkVrPauseList({ orgUrl: 'https://t.my.salesforce.com', sid: 'S' }, ['Account', 'dlrs__LookupParent__c'], send);
    expect(l.rules.map(r => [r.name, !!r.metadata, !!r.xml])).toEqual([['Own_Rule', true, false], ['dlrs__Not_42', false, true]]);
    expect(calls).toEqual(['SF_QUERY_ALL', 'SF_TOOLING_GET', 'SF_MD_READ:ValidationRule']);
    const bad = async m => (m.type === 'SF_MD_READ' ? { error: 'INSUFFICIENT_ACCESS' } : send(m));
    await expect(VP.sftkVrPauseList({ orgUrl: 'https://t.my.salesforce.com', sid: 'S' }, ['dlrs__LookupParent__c'], bad)).rejects.toThrow(/dlrs__Not_42 .* could not be read through the Metadata API \(INSUFFICIENT_ACCESS\)/);
  });
});
