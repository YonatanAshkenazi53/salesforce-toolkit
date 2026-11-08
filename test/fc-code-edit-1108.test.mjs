// Code in Field Cleaner (user 2026-11-08: "צריך להיות בכולם"): Apex class / trigger, Visualforce page / component,
// LWC and Aura bundles get 🔍 with every file, ⇄ Replace as a whole-word rename, ✎ an editor per file; a duplicate
// rule gets ✂ / ⇄ / ✎ like every other declarative kind; the gate box is chips and one sentence; the ⚡ walk and the
// group "… all N" cover every kind with a way. Pure helpers tested on text; the wiring pinned.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const DEP = readFileSync(new URL('../dependency-map.js', import.meta.url), 'utf8');
const M = extractFunctions('sftk-mdapi.js', ['sftkMdCodeReplace', 'sftkMdCodeHits', 'sftkMdCodeWays', 'sftkMdCodeSame', 'sftkMdDeleteSpec', '_sftkMdDeleteTable']);
const H = extractFunctions('sftk-history.js', ['sftkUndoVerifyEval', '_sftkHistPick']);

const APEX = `public with sharing class SftkLive {
  public static String tag(Account a) {
    return a.SFTK_Live_Blk__c + ' / ' + a.sftk_live_blk__c;   // both spellings
  }
  // SFTK_Live_Blk__cX is another field; Account.SFTK_Live_Blk__c is this one
  static final String F = 'Account.SFTK_Live_Blk__c';
}`;

describe('⇄ in code: a whole-word rename', () => {
  it('renames every spelling of the field, "Object.Field" and bare, and leaves a longer name alone', () => {
    const r = M.sftkMdCodeReplace([{ path: 'classes/SftkLive.cls', source: APEX }], 'SFTK_Live_Blk__c', 'SFTK_Live_Blk2__c');
    expect(r.n).toBe(4);
    expect(r.files).toBe(1);
    expect(r.sources[0].source).toContain("a.SFTK_Live_Blk2__c + ' / ' + a.SFTK_Live_Blk2__c");   // the new name as the owner spelled it
    expect(r.sources[0].source).toContain('SFTK_Live_Blk__cX is another field');              // not a whole word: untouched
    expect(r.sources[0].source).toContain("'Account.SFTK_Live_Blk2__c'");
    expect(r.sources[0].n).toBe(4);
  });
  it('a bundle: only the files that name the field change, the others come back byte for byte', () => {
    const r = M.sftkMdCodeReplace([
      { path: 'lwc/x/x.js', source: "import F from '@salesforce/schema/Account.SFTK_Live_Blk__c';" },
      { path: 'lwc/x/x.html', source: '<template>{v}</template>' },
    ], 'SFTK_Live_Blk__c', 'SFTK_Live_Blk2__c');
    expect(r.n).toBe(1); expect(r.files).toBe(1);
    expect(r.sources[1].source).toBe('<template>{v}</template>');
    expect(r.sources[1].n).toBe(0);
  });
  it('no field or no new name → nothing changes', () => {
    expect(M.sftkMdCodeReplace([{ path: 'a', source: 'SFTK_Live_Blk__c' }], 'SFTK_Live_Blk__c', '').n).toBe(0);
    expect(M.sftkMdCodeReplace([{ path: 'a', source: 'x' }], '', 'y').n).toBe(0);
  });
  it('the lines that name the field, 1-based, whole word, any case', () => {
    const hits = M.sftkMdCodeHits(APEX, 'SFTK_Live_Blk__c');
    expect(hits.map(h => h.line)).toEqual([3, 5, 6]);
    expect(M.sftkMdCodeHits('a\r\nSFTK_Live_Blk__c\r\nb', 'SFTK_Live_Blk__c')).toEqual([{ line: 2, text: 'SFTK_Live_Blk__c' }]);
  });
  it('the ways of code: ⇄ and ✎, never ✂; a declarative kind is not code', () => {
    for (const t of ['ApexClass', 'ApexTrigger', 'ApexPage', 'ApexComponent', 'LightningComponentBundle', 'AuraDefinitionBundle']) expect(M.sftkMdCodeWays(t)).toEqual({ replace: true, edit: true, remove: false });
    expect(M.sftkMdCodeWays('ValidationRule')).toBeNull();
    expect(M.sftkMdCodeWays('DuplicateRule')).toBeNull();
  });
  it('two sources read as the same when only line endings and trailing blanks differ', () => {
    expect(M.sftkMdCodeSame('a\r\nb  \r\n', 'a\nb\n')).toBe(true);
    expect(M.sftkMdCodeSame('a\nb', 'a\nc')).toBe(false);
  });
});

describe('the undo of a code edit is verified loosely (Salesforce may hand back LF for CRLF)', () => {
  it('where … loose compares the stored source with line endings and trailing blanks ignored', () => {
    const spec = { pick: 'records', where: { field: 'Body', equals: 'class A {\r\n}  \r\n', loose: true } };
    expect(H.sftkUndoVerifyEval(spec, { records: [{ Id: '1', Body: 'class A {\n}' }] }).ok).toBe(true);
    expect(H.sftkUndoVerifyEval(spec, { records: [{ Id: '1', Body: 'class B {\n}' }] }).ok).toBe(false);
    expect(H.sftkUndoVerifyEval({ pick: 'records', where: { field: 'Body', equals: 'x\n' } }, { records: [{ Body: 'x' }] }).ok).toBe(false);   // strict without loose
  });
});

describe('the wiring in Field Cleaner', () => {
  it('code is inspected and edited through one read (_codeRead): 🔍, ⇄ (data-way="code"), ✎, and the 🗑 restore plan', () => {
    expect(FC).toContain("function _inspectsByCode(type) { const s = typeof sftkMdDeleteSpec === 'function' ? sftkMdDeleteSpec(type) : null; return !!(s && (s.code || s.bundle)); }");
    expect(FC).toContain("const canInsp = Object.prototype.hasOwnProperty.call(_INSPECT_SOBJECT, type) || _inspectsByMd(type) || _inspectsByCode(type) || type === 'EmailTemplate';");
    expect(FC).not.toContain("ApexClass: 'ApexClass', ApexTrigger: 'ApexTrigger',");   // Apex goes through the code inspector now
    expect(FC).toContain('if (_inspectsByCode(type)) { await _codeInspect(type, componentId, componentName, panel, inspBtn); return; }');
    expect(FC).toContain('data-swap="1" data-way="code" title="Rename ${esc(_selField.api)} to ${esc(_replField.api)} in every file of this');
    expect(FC).toContain("if (_fixWay === 'code') {");
    expect(FC).toContain('const r = await fixCodeReplace(type, componentId, componentName);');
    expect(FC).toContain('const c = await _codeRead(type, componentId, fullName, spec);');
    expect(FC).toContain("return { files: c.files, verify: { query: c.byName, tooling: true, pick: 'records', count: 1 }, gone: () => _goneByQuery(c.byName) };");
  });
  it('the code deploy: the diff of every changed file confirmed, a restore point, the write, a re-read of each changed file, History undo with a loose verify; Apex tests when a production org asks', () => {
    const fn = FC.slice(FC.indexOf('async function _codeDeploy(ctx, newSources, o) {'), FC.indexOf('async function fixCodeReplace('));
    expect(fn).toContain('const changed = newSources.filter(s => !sftkMdCodeSame(s.source, (orig(s.path) || {}).source));');
    expect(fn).toContain("await _snapshotFix('MdEdit', componentId, componentName, fullName, { type, mdType: type, what: spec.what, swapTo: o.swapTo || null, how: [o.how], files, verify: verifyBack });");
    expect(fn).toContain('// confirmed-by: the sftkConfirmDestructive right above');
    expect(fn).toContain('wr = await sftkWriteVerified({');
    expect(fn).toContain("if (apex && r && !r.success && /test|coverage/i.test(String(r.error || ''))) { ranTests = true;");
    expect(fn).toContain('return a && sftkMdCodeSame(a.source, s.source); })) return { ok: true, text: null };');
    expect(fn).toContain("msg: { type: 'SF_METADATA_DEPLOY', zipBase64: zipBack },");
    expect(fn).toContain('if (!stillNames) _afterDelete(type);');
    expect(FC).toContain("where: { field: spec.code, equals: source, loose: true }");
    expect(FC).toContain("where: { field: 'Source', equals: source, loose: true }");
  });
  it('✎ the code editor: one box per file, Deploy off until a file changed, Cancel back to 🔍; ✂ is said not to be offered', () => {
    expect(FC).toContain('<textarea class="fc-xml-ta fc-code-ta" data-i="${i}" spellcheck="false" wrap="off"');
    expect(FC).toContain('go.disabled = !files; reset.disabled = !files;');
    expect(FC).toContain('✂ Remove is not offered for code — which line of a program goes is yours to decide, in ✎ Edit code.');
    expect(CSS).toContain('.fc-code-ta');
    expect(CSS).toContain('.fc-code-file-hd');
  });
  it('the gate box: chips that jump to their group, one sentence about the ways; the chips count down after a fix', () => {
    expect(FC).toContain('🔒 ${blockerTotal} blocker${blockerTotal === 1 ? \' stops\' : \'s stop\'} the delete');
    expect(FC).toContain('class="fc-blocker-row fc-blocker-chip" data-type="${esc(b.type)}" data-group="${esc(b.type === \'ProcessBuilder\' ? \'Flow\' : b.type)}"');
    expect(FC).toContain("const chip = ev.target.closest?.('.fc-blocker-chip');");
    expect(FC).toContain("g.classList.add('fc-group-flash');");
    expect(FC).toContain("function _blockerWays(type) {");
    expect(FC).toContain("const row = document.querySelector(`.fc-blocker-row[data-type=\"${CSS.escape(type)}\"]`);");   // _afterDelete still finds the chip
    expect(CSS).toContain('.fc-blocker-chip');
    expect(CSS).toContain('.fc-blockers-foot');
  });
  it('the header folds: three sections, remembered, with a one-line summary when folded', () => {
    expect(FC).toContain("_foldHtml('data', '📈', 'The field’s data'");
    expect(FC).toContain("_foldHtml('further', '🔭', 'Look further than the index'");
    expect(FC).toContain("_foldHtml('act', '⚡', 'Act on everything', 'replace mode, deprecate first'");
    expect(FC).toContain("localStorage.getItem(`sftk.fc.fold.${key}`)");
    expect(FC).toContain('_wireFolds(results);');
    expect(CSS).toContain('.fc-fold-sum:empty { display: none; }');
  });
  it('the ⚡ walk and the group buttons cover every kind with a way; a Remove walk names what it left out', () => {
    expect(FC).toContain('function _openPairs(root, swap) {');
    expect(FC).toContain("return [...(root || document).querySelectorAll('.fc-fix-pair, .fc-del-pair')].filter(p => p.querySelector(sel)).length;");
    expect(FC).toContain("el.outerHTML = _fixEveryHtml(_openPairs(root), _openPairs(root, true), _openPairs(root, false));");   // ⇄ and ✂ counted apart
    expect(FC).toContain("if (swap) way = c ? 'code' : 'edit';");
    expect(FC).toContain('✂ Remove all left out what can only be replaced — ${skipped.join(\', \')}');
    // the confirm's XML (and a code file's text) can be edited before the deploy (user 2026-11-08: "we can't edit here")
    expect(FC).toContain('function _cfEditBlock(id, proposed, opts) {');
    expect(FC).toContain("const cfEdit = _cfEditBlock('fcCfEdit', ed.xml, { xml: true, what: 'the XML', name: inBox ? fullName.slice(fullName.indexOf('.') + 1) : fullName });");
    expect(FC).toContain('const finalXml = handXml != null ? handXml : ed.xml;');
    expect(FC).toContain('const deployFiles = sftkMdPackageFiles(pkgType, fullName, finalXml);');
    expect(FC).toContain('const edits = changed.map((s, i) => _cfEditBlock(`fcCfCode${i}`, s.source, { what: s.file }));');
    expect(FC).toContain('const zipBack = _zipOf(files), zipNew = _zipOf(deployFiles2);');
    expect(FC).toContain('data-swap="1" data-way="${c ? \'code\' : \'edit\'}" title="Each one is confirmed on its own, with its diff; a refusal is said and the walk goes on">⇄ Replace in all ${n} ${noun}</button>');
    expect(FC).toContain('data-swap="0" data-way="edit" title="Each one is confirmed on its own, with its diff; one that would stop working without the field is refused, with the reason, and the walk goes on">✂ Remove from all ${n} ${noun}</button>');
  });
  it('the Reports row says the scan itself read every custom report type', () => {
    expect(FC).toContain('_rtScanned = types.length;');
    expect(FC).toContain('<b>Report types</b>: the scan itself read all ${N(_rtScanned)} custom report type');
  });
});

describe('⏻ Flow switches: the whole chain', () => {
  it('a second chip names every flow down (or up) the chain when it goes deeper than one level, and ticks them all', () => {
    expect(DEP).toContain('const chainOf = (start, map) => {');
    expect(DEP).toContain("if (all.length <= (direct || []).filter(Boolean).length) return '';");
    expect(DEP).toContain("chainChip(f.apiName, calls, calls[f.apiName], '\\u21ca', 'whole chain down')");
    expect(DEP).toContain("chainChip(f.apiName, calledBy, calledBy[f.apiName], '\\u21c8', 'every caller up')");
    expect(DEP).toContain('class="dep-fb-sub dep-fb-chain"');   // the same click handler ticks its names
    expect(CSS).toContain('.dep-fb-chain { border-style: dashed; }');
  });
});
