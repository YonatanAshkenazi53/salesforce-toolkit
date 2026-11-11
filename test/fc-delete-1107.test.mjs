// 🗑 Delete a blocker as a whole (user 2026-11-07: "כל מה שחייב להיות מוסר כדי
// להסיר שדה חייב להיות מחיק בלחיצת כפתור"). The pure half: the type table,
// the destructive package, and the files that put a record, a piece of code
// or a bundle back. The wired half: the button, the dispatch, the restore.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const MD = readFileSync(new URL('../sftk-mdapi.js', import.meta.url), 'utf8');
const BG = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const M = extractFunctions('sftk-mdapi.js', ['sftkMdDeleteSpec', 'sftkMdDestructiveFiles', 'sftkMdPackageFiles', 'sftkMdCodeFiles', 'sftkMdBundleFiles', '_sftkPkgXml', 'sftkMdEscape', 'sftkMdFindElement', 'sftkMdRecordFileXml', '_sftkMdDeleteTable', '_sftkApiVer']);

describe('the type table', () => {
  it('every blocker kind the scan can list has a delete spec, except the ones kept by hand on purpose', () => {
    const sevBlocker = [...FC.matchAll(/^\s*([A-Za-z]+):\s*\{[^\n]*?sev: 'blocker'/gm)].map(m => m[1]);
    const byHand = new Set(['LookupFilter', 'Flow', 'Layout', 'AskNamed']);   // AskNamed (2026-11-10): Salesforce's own words for something the scan could not resolve — nothing to delete by name;   // 2026-11-07: a duplicate rule, the lead mapping and a Process Builder process joined the table; a lookup filter has a path of its own
    for (const t of sevBlocker) {
      if (byHand.has(t)) expect(M.sftkMdDeleteSpec(t), t).toBeNull();
      else expect(M.sftkMdDeleteSpec(t), t).not.toBeNull();
    }
  });
  it('a child type knows its parent file; a top-level type its own; code and bundles their sources', () => {
    expect(M.sftkMdDeleteSpec('ValidationRule')).toMatchObject({ mdType: 'ValidationRule', parent: 'CustomObject', tag: 'validationRules', folder: 'objects', suffix: 'object', tooling: 'ValidationRule' });
    expect(M.sftkMdDeleteSpec('WorkflowAlert')).toMatchObject({ parent: 'Workflow', tag: 'alerts', folder: 'workflows', suffix: 'workflow' });
    expect(M.sftkMdDeleteSpec('CustomMetadataRecord')).toMatchObject({ mdType: 'CustomMetadata', folder: 'customMetadata', suffix: 'md' });
    expect(M.sftkMdDeleteSpec('ApexClass')).toMatchObject({ code: 'Body', folder: 'classes', suffix: 'cls', metaTag: 'ApexClass' });
    expect(M.sftkMdDeleteSpec('LightningComponentBundle')).toMatchObject({ bundle: 'lwc' });
    expect(M.sftkMdDeleteSpec('DuplicateRule')).toMatchObject({ folder: 'duplicateRules' });   // joined 2026-11-07 ("צריך את כולם")
    expect(M.sftkMdDeleteSpec('Nope')).toBeNull();
  });
});

describe('the packages', () => {
  it('a delete is an empty package plus a destructiveChangesPost list', () => {
    const f = M.sftkMdDestructiveFiles([['ValidationRule', 'Account.SFTK_Live_VR'], ['ApexClass', 'SFTK_Live_Class']]);
    expect(f.map(x => x.name)).toEqual(['package.xml', 'destructiveChangesPost.xml']);
    expect(f[0].text).toContain('<version>62.0</version>');
    expect(f[0].text).not.toContain('<types>');
    expect(f[1].text).toContain('<members>Account.SFTK_Live_VR</members>');
    expect(f[1].text).toContain('<name>ValidationRule</name>');
    expect(f[1].text).toContain('<members>SFTK_Live_Class</members>');
    expect(f[1].text).toContain('<name>ApexClass</name>');
  });
  it('a child record goes back inside its parent file, under its SHORT name', () => {
    const inner = '<fullName>Account.SFTK_Live_VR</fullName><active>true</active><errorConditionFormula>ISBLANK(X__c) &amp;&amp; FALSE</errorConditionFormula><errorMessage>x</errorMessage>';
    const f = M.sftkMdPackageFiles('ValidationRule', 'Account.SFTK_Live_VR', inner);
    expect(f.map(x => x.name)).toEqual(['package.xml', 'objects/Account.object']);
    expect(f[0].text).toContain('<members>Account.SFTK_Live_VR</members>');
    expect(f[1].text).toContain('<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><validationRules><fullName>SFTK_Live_VR</fullName><active>true</active>');
    expect(f[1].text).not.toContain('Account.SFTK_Live_VR</fullName>');
    expect(f[1].text).toContain('</validationRules></CustomObject>');
    const w = M.sftkMdPackageFiles('WorkflowOutboundMessage', 'Account.SFTK_Live_OM', '<fullName>Account.SFTK_Live_OM</fullName><fields>Id</fields>');
    expect(w[1].name).toBe('workflows/Account.workflow');
    expect(w[1].text).toContain('<Workflow xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><outboundMessages><fullName>SFTK_Live_OM</fullName><fields>Id</fields></outboundMessages></Workflow>');
  });
  it('a top-level record gets its own file; a custom metadata record is deployed as CustomMetadata', () => {
    const f = M.sftkMdPackageFiles('CustomMetadataRecord', 'SFTK_Live_Cmt.Ref', '<fullName>SFTK_Live_Cmt.Ref</fullName><label>Ref</label>');
    expect(f.map(x => x.name)).toEqual(['package.xml', 'customMetadata/SFTK_Live_Cmt.Ref.md']);
    expect(f[0].text).toContain('<name>CustomMetadata</name>');
    expect(f[1].text).toContain('<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><label>Ref</label></CustomMetadata>');
    expect(M.sftkMdPackageFiles('ApexClass', 'X', '')).toBeNull();
    expect(M.sftkMdPackageFiles('Flow', 'X', '')).toBeNull();
  });
  it('code goes back as its source and a -meta.xml; a bundle as its files and the bundle meta', () => {
    const c = M.sftkMdCodeFiles('ApexClass', 'SFTK_Live_Class', 'public class SFTK_Live_Class {}', 62.0);
    expect(c.map(x => x.name)).toEqual(['package.xml', 'classes/SFTK_Live_Class.cls', 'classes/SFTK_Live_Class.cls-meta.xml']);
    expect(c[2].text).toContain('<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><status>Active</status></ApexClass>');
    const p = M.sftkMdCodeFiles('ApexPage', 'SFTK_Live_VF', '<apex:page/>', '62.0', { label: 'SFTK Live VF' });
    expect(p[2].text).toContain('<label>SFTK Live VF</label>');
    expect(p[2].text).not.toContain('<status>');
    const b = M.sftkMdBundleFiles('LightningComponentBundle', 'sftkLiveBlk', [{ path: 'lwc/sftkLiveBlk/sftkLiveBlk.js', source: 'x' }, { path: 'lwc/sftkLiveBlk/sftkLiveBlk.html', source: '<template></template>' }], { apiVersion: '62.0', isExposed: false });
    expect(b.map(x => x.name)).toEqual(['package.xml', 'lwc/sftkLiveBlk/sftkLiveBlk.js', 'lwc/sftkLiveBlk/sftkLiveBlk.html', 'lwc/sftkLiveBlk/sftkLiveBlk.js-meta.xml']);
    expect(b[3].text).toContain('<isExposed>false</isExposed>');
    const a = M.sftkMdBundleFiles('AuraDefinitionBundle', 'sftkLiveAura', [{ path: 'sftkLiveAura.cmp', source: '<aura:component/>' }], { apiVersion: 62 });
    expect(a[1].name).toBe('aura/sftkLiveAura/sftkLiveAura.cmp');
    expect(a[2].name).toBe('aura/sftkLiveAura/sftkLiveAura.cmp-meta.xml');
  });
});

describe('the wiring', () => {
  it('every blocker kind with a spec gets a 🗑 button, with or without Remove/Replace; the button is a third way of a fix', () => {
    expect(FC).toContain("const spec = (knownKind && typeof sftkMdDeleteSpec === 'function') ? (sftkMdDeleteSpec(type) || (type === 'LookupFilter' ? { what: 'lookup filter' } : null)) : null;");   // the 👀 mention kinds too (2026-11-08)
    expect(FC).toContain('data-way="delete" title="Delete this ${esc(spec.what)} from the org');
    expect(FC).toContain('if (!cfgT.fixable) return codeEdits + edits + del;');   // ✂/⇄ inside the blocker come first; code's ⇄ before them (2026-11-08)
    expect(FC).toContain("const canDel = !fixable && typeof sftkMdDeleteSpec === 'function' && (!!sftkMdDeleteSpec(type) || type === 'LookupFilter');");   // the 👀 mention kinds the engine knows get 🗑 too (2026-11-08)
    expect(FC).toContain("_fixWay = (way === 'keep' || way === 'off' || way === 'delete' || way === 'edit' || way === 'code' || way === 'askdelete') ? way : '';");
    expect(FC).toContain("if (_fixWay === 'delete') {");
  });
  it('the delete reads the full definition first (no restore point, no delete), deletes with destructiveChanges, verifies gone, and the undo deploys the saved files', () => {
    expect(FC).toContain("await _snapshotFix('MdDelete', componentId, componentName, fullName, { type, mdType: spec.mdType, what: spec.what, files: plan.files || null, patch: plan.undoPatch || null, verify: plan.verify });");
    expect(FC).toContain("const zipDel = plan.deployFiles ? _zipOf(plan.deployFiles) : (plan.patch || plan.pb) ? null : _zipOf(sftkMdDestructiveFiles([[spec.mdType, fullName]]));");
    expect(FC).toContain("nothing is deleted without a restore point");
    expect(FC).toContain("verify: async () => { try { return { ok: await plan.gone(), text: null }; } catch (_) { return { ok: false, text: null }; } },");
    expect(FC).toContain("msg: plan.undoPatch ? { type: 'SF_PATCH', ...plan.undoPatch } : { type: 'SF_METADATA_DEPLOY', zipBase64: zipBack },");
    expect(FC).toContain("testLevel: 'RunLocalTests'");
    expect(BG).toContain('async function sfMetadataDeploy(orgUrl, sid, zipBase64, testLevel, checkOnly) {');
    expect(BG).toContain("(testLevel === 'RunLocalTests' || testLevel === 'RunAllTestsInOrg') ? testLevel : 'NoTestRun'");
  });
  it('a row from the index resolves its full name through the Tooling record; a matching rule through its developer name; the legs put the name in the id', () => {
    expect(FC).toContain("const fn = g.FullName || (spec.parent && ent && g.DeveloperName ? `${ent}.${g.DeveloperName}` : (g.DeveloperName || g.Name));");   // live 2026-11-07: a FieldSet's Tooling record has no FullName
    expect(FC).toContain("gone: () => _goneByQuery(c.byName) };");   // code and bundles read through _codeRead (2026-11-08)
    expect(FC).toContain("SELECT DeveloperName, SobjectType FROM ${type} WHERE Id = '${id}'");
    expect(FC).toContain("return id;\n  }\n  // \"Gone\" for code and bundles");
  });
  it('the gate row says the delete is here, and counts down as deletes land', () => {
    // one chip per kind, one sentence about the ways (user 2026-11-08: "nobody will read it")
    expect(FC).toContain('class="fc-blocker-row fc-blocker-chip" data-type="${esc(b.type)}"');
    expect(FC).toContain('Clear each one in its group below — ✂ take the field out · ⇄ point it at another field · ✎ edit it · 🗑 delete it; every change keeps a restore point. Or fix it in Setup. Then re-scan.');
    // the gate sits ABOVE the lists (user 2026-11-08: "maybe it should be on top?")
    expect(FC).toContain("html += '<!--FC_GATE-->';");
    expect(FC).toContain("html = html.replace('<!--FC_GATE-->', () => gateHtml);");
    expect(FC).toContain("hdr.textContent = '✅ Every blocker listed here was fixed or deleted — press Re-scan, then delete the field.';");
  });
  it('the restore point of a delete deploys the saved files back', () => {
    expect(FC).toContain("} else if (snap.type === 'MdDelete' || snap.type === 'MdEdit') {");
    expect(FC).toContain("zipBase64: _zipOf(md.files)");
  });
});
