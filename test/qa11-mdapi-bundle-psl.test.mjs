// QA 1.1 findings 3 and 4: an Aura bundle's meta file is named after its main resource, and a search-layout edit on a
// custom object keeps the columns of a profile-specific search layout.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../sftk-mdapi.js', import.meta.url), 'utf8');
const M = new Function(`${src}\nreturn { sftkMdBundleFiles, sftkSearchLayoutEdit, sftkSearchLayoutHits };`)();

describe('finding 3 — the meta file of an Aura bundle', () => {
  const names = (name, paths) => M.sftkMdBundleFiles('AuraDefinitionBundle', name, paths.map(path => ({ path, source: '<x/>' })), { apiVersion: 60, description: 'd' }).map(f => f.name);
  it('an application bundle gets MyApp.app-meta.xml, and no .cmp-meta.xml', () => {
    const n = names('MyApp', ['MyApp.app', 'MyAppController.js']);
    expect(n).toEqual(['package.xml', 'aura/MyApp/MyApp.app', 'aura/MyApp/MyAppController.js', 'aura/MyApp/MyApp.app-meta.xml']);
  });
  it('an event, an interface and a tokens bundle are named the same way', () => {
    expect(names('MyEvt', ['MyEvt.evt']).pop()).toBe('aura/MyEvt/MyEvt.evt-meta.xml');
    expect(names('MyIntf', ['MyIntf.intf']).pop()).toBe('aura/MyIntf/MyIntf.intf-meta.xml');
    expect(names('MyTok', ['MyTok.tokens']).pop()).toBe('aura/MyTok/MyTok.tokens-meta.xml');
  });
  it('a resource given by its full path is read the same way', () => {
    expect(names('MyApp', ['aura/MyApp/MyApp.app']).pop()).toBe('aura/MyApp/MyApp.app-meta.xml');
  });
  it('a component bundle, and a bundle whose main resource is not among the files, keep .cmp-meta.xml', () => {
    expect(names('Cmp', ['Cmp.cmp', 'CmpController.js']).pop()).toBe('aura/Cmp/Cmp.cmp-meta.xml');
    expect(names('Cmp', ['CmpController.js']).pop()).toBe('aura/Cmp/Cmp.cmp-meta.xml');
  });
  it('the meta file carries the api version and the description', () => {
    const f = M.sftkMdBundleFiles('AuraDefinitionBundle', 'MyApp', [{ path: 'MyApp.app', source: '' }], { apiVersion: 60, description: 'd' }).pop();
    expect(f.text).toContain('<AuraDefinitionBundle');
    expect(f.text).toContain('<apiVersion>60.0</apiVersion>');
    expect(f.text).toContain('<description>d</description>');
  });
  it('an LWC bundle is untouched', () => {
    const n = M.sftkMdBundleFiles('LightningComponentBundle', 'x', [{ path: 'lwc/x/x.js', source: '' }], {}).map(f => f.name);
    expect(n).toEqual(['package.xml', 'lwc/x/x.js', 'lwc/x/x.js-meta.xml']);
  });
});

describe('finding 4 — a custom object’s profile search layout keeps its columns', () => {
  const PSL = '<profileSearchLayouts><fields>A__c</fields><fields>B__c</fields><profileName>Admin</profileName></profileSearchLayouts>';
  const OBJ = '<fullName>Thing__c</fullName>'
    + '<fields><fullName>A__c</fullName><label>A</label><type>Text</type></fields>'
    + '<fields><fullName>B__c</fullName><label>B</label><type>Text</type></fields>'
    + '<label>Thing</label>'
    + '<listViews><fullName>All</fullName><columns>NAME</columns></listViews>'
    + '<nameField><label>Thing Name</label><type>Text</type></nameField>'
    + '<pluralLabel>Things</pluralLabel>'
    + PSL
    + '<searchLayouts><searchResultsAdditionalFields>A__c</searchResultsAdditionalFields><searchResultsAdditionalFields>B__c</searchResultsAdditionalFields></searchLayouts>'
    + '<sharingModel>ReadWrite</sharingModel>'
    + '<validationRules><fullName>R</fullName><active>true</active></validationRules>';
  it('removing a column from one search layout leaves <profileSearchLayouts> byte for byte', () => {
    const r = M.sftkSearchLayoutEdit(OBJ, 'Thing__c', 'A__c', 'searchResultsAdditionalFields', null);
    expect(r.n).toBe(1);
    expect(r.file).toContain(PSL);
    expect(r.file).toContain('<searchLayouts><searchResultsAdditionalFields>B__c</searchResultsAdditionalFields></searchLayouts>');
  });
  it('the object’s own child components still stay out of the file', () => {
    const r = M.sftkSearchLayoutEdit(OBJ, 'Thing__c', 'A__c', 'searchResultsAdditionalFields', null);
    expect(r.file).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">'
      + '<label>Thing</label><nameField><label>Thing Name</label><type>Text</type></nameField><pluralLabel>Things</pluralLabel>'
      + PSL
      + '<searchLayouts><searchResultsAdditionalFields>B__c</searchResultsAdditionalFields></searchLayouts>'
      + '<sharingModel>ReadWrite</sharingModel></CustomObject>');
  });
  it('the undo file (a field name that matches nothing) carries the profile columns too', () => {
    const r = M.sftkSearchLayoutEdit(OBJ, 'Thing__c', '__sftk_none__', 'searchResultsAdditionalFields', null);
    expect(r.n).toBe(0);
    expect(r.file).toContain(PSL);
    expect(r.file).not.toContain('<validationRules>');
    expect(r.file).not.toContain('<fullName>');
  });
  it('a swap keeps them as well, and whitespace between the elements is kept', () => {
    const spaced = OBJ.replace(/></g, '>\n    <');
    const r = M.sftkSearchLayoutEdit(spaced, 'Thing__c', 'A__c', 'searchResultsAdditionalFields', 'C__c');
    expect(r.swapped).toBe(true);
    expect(r.file).toContain('<profileName>Admin</profileName>');
    expect(r.file.match(/<fields>/g).length).toBe(2);   // the two columns of the profile layout, nothing else
    expect(r.file).toContain('<searchResultsAdditionalFields>C__c</searchResultsAdditionalFields>');
    expect(r.file).not.toContain('<listViews>');
  });
  it('a standard object still deploys its search layouts alone', () => {
    const r = M.sftkSearchLayoutEdit(OBJ, 'Account', 'A__c', 'searchResultsAdditionalFields', null);
    expect(r.file).not.toContain('profileSearchLayouts');
    expect(r.file).not.toContain('<label>');
  });
});
