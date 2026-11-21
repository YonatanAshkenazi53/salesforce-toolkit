// backlog 2026-11-08: "✎ Edit for the Tooling Metadata JSON kinds (flows, layouts, Lightning pages)". A page layout
// and a Lightning page get ✎ Edit XML in the 🔍 (the editor every other kind has); a flow does not, on purpose.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const { sftkMdJsonKindEditSpec: spec, sftkMdEditFiles: files } = extractFunctions('sftk-mdapi.js',
  ['sftkMdJsonKindEditSpec', 'sftkMdEditFiles', 'sftkMdPackageFiles', 'sftkMdDeleteSpec', '_sftkMdDeleteTable', '_sftkPkgXml', 'sftkMdRecordFileXml', 'sftkMdFindElement', 'sftkMdEscape']);

describe('which kinds', () => {
  it('a page layout and a Lightning page; a flow is edited in Flow Builder', () => {
    expect(spec('Layout')).toEqual({ type: 'Layout', mdType: 'Layout', what: 'page layout', folder: 'layouts', suffix: 'layout' });
    expect(spec('FlexiPage').what).toBe('Lightning page');
    expect(spec('Flow')).toBe(null); expect(spec('ValidationRule')).toBe(null);
  });
});

describe('the two files of the deploy', () => {
  const inner = '<fullName>Account-My Layout</fullName><layoutSections><label>Info</label></layoutSections>';
  it('a layout: package.xml names it, the file holds the XML without its fullName line', () => {
    const f = files('Layout', 'Account-My Layout', inner);
    expect(f.map(x => x.name)).toEqual(['package.xml', 'layouts/Account-My Layout.layout']);
    expect(f[0].text).toContain('<members>Account-My Layout</members>'); expect(f[0].text).toContain('<name>Layout</name>');
    expect(f[1].text).toContain('<Layout xmlns="http://soap.sforce.com/2006/04/metadata"');
    expect(f[1].text).toContain('<layoutSections><label>Info</label></layoutSections></Layout>');
    expect(f[1].text).not.toContain('<fullName>');
  });
  it('a Lightning page', () => {
    const f = files('FlexiPage', 'My_Page', '<fullName>My_Page</fullName><masterLabel>My Page</masterLabel>');
    expect(f[1].name).toBe('flexipages/My_Page.flexipage'); expect(f[1].text).toContain('<FlexiPage xmlns=');
  });
  it('every other kind keeps the builder it had; a lookup filter is its field', () => {
    const f = files('ValidationRule', 'Account.My_Rule', '<fullName>My_Rule</fullName><active>true</active>');
    expect(f[1].name).toBe('objects/Account.object');
    expect(files('LookupFilter', 'Account.My_Lookup__c', '<fullName>My_Lookup__c</fullName>')[0].text).toContain('<name>CustomField</name>');
  });
});

describe('the 🔍 of a layout or a Lightning page', () => {
  it('has ✎ Edit XML next to ✂ Remove, only for the kinds of the spec', () => {
    expect(FC).toContain("${sftkMdJsonKindEditSpec(type) ? `<button class=\"btn btn-secondary btn-sm fc-xml-edit-btn\"");
    expect(FC).toContain('await _jsonKindEditorOpen(type, componentId, componentName, fieldId, res.FullName || res.fullName, panel, inspBtn);');
  });
  it('the editor is the one every kind has: the XML read through the Metadata API, its files from sftkMdEditFiles', () => {
    const at = FC.indexOf('async function _jsonKindEditorOpen(');
    const body = FC.slice(at, FC.indexOf('async function _xmlInspectMd(', at));
    expect(body).toContain('const rd = await _mdReadOne(type, fullName, spec.mdType);');
    expect(body).toContain('_xmlEditorOpen(panel, { type, componentId, componentName, fullName, spec, xml: rd.rec.innerXml, inspBtn, back });');
    expect(FC.split('sftkMdEditFiles(').length).toBe(4);   // ✓ Validate, the restore point's files, the deploy's files
    expect(FC).not.toContain("sftkMdPackageFiles(ctx.type === 'LookupFilter'");
  });
  it('Cancel and a finished deploy open the 🔍 again, read fresh from the org', () => {
    expect(FC).toContain("if (ctx.back) ctx.back(''); else _xmlInspectMd(ctx.type, ctx.componentId, ctx.componentName, panel, ctx.inspBtn);");
    expect(FC).toContain("if (r === 'deployed' && ctx.back) await ctx.back(doneNote);");
    expect(FC).toContain('await toggleXmlInspector(type, componentId, componentName, fieldId);');
  });
});
