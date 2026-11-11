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
    expect(fn).toContain('for (let i = 0; i < 12; i++) {');   // the Tooling API lags behind a code deploy (live 2026-11-08) — ~30 s of re-reads
    expect(fn).toContain('await new Promise(res => setTimeout(res, 1500 + i * 200));');
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
    expect(FC).not.toContain("_foldHtml('act'");   // the fold is gone (user 2026-11-08: "i dont think we need the act on everything"); Deprecate is a plain row
    expect(FC).toContain("localStorage.getItem(`sftk.fc.fold.${key}`)");
    expect(FC).toContain('_wireFolds(results);');
    expect(CSS).toContain('.fc-fold-sum:empty { display: none; }');
  });
  it('the ⚡ walk and the group buttons cover every kind with a way; a Remove walk names what it left out', () => {
    expect(FC).toContain('function _openPairs(root, swap) {');
    expect(FC).toContain("return [...(root || document).querySelectorAll('.fc-fix-pair, .fc-del-pair')].filter(p => p.querySelector(sel)).length;");
    expect(FC).toContain("el.outerHTML = _fixEveryHtml(Math.max(_openPairs(root), _walkPairs(root)), _openPairs(root, true), _walkPairs(root));");   // ⇄ and ✂ counted apart
    expect(FC).toContain("if (swap) way = c ? 'code' : 'edit';");
    // 2026-11-11: one take — a kind with no ✂ is no longer left out, the walk asks to delete each as a whole
    expect(FC).toContain("else if (typeof sftkMdDeleteSpec === 'function' && sftkMdDeleteSpec(type)) way = 'askdelete';");
    expect(FC).toContain("if (r && r.refusedWhy) return _walkDeleteInstead(type, componentId, componentName, r.refusedWhy);");
    expect(FC).toContain("if (!sure) return (why && !_walkStop) ? 'skip' : 'cancel';");
    // the confirm's XML (and a code file's text) can be edited before the deploy (user 2026-11-08: "we can't edit here")
    expect(FC).toContain('function _cfEditBlock(id, proposed, opts) {');
    expect(FC).toContain("const cfEdit = _cfEditBlock('fcCfEdit', vrChoice ? rec.innerXml : ed.xml, { xml: true, what: 'the XML', name: inBox ? fullName.slice(fullName.indexOf('.') + 1) : fullName,");
    expect(FC).toContain("const finalXml = handXml != null ? handXml : (vrChoice && vrMode === 'off' ? vrOffXml : ed.xml);");
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

describe('the scan’s progress (user 2026-11-08: "can we show a progress bar with estimation?")', () => {
  it('one segment per leg of the scope, the step and the time left under the cat, the places found so far', () => {
    expect(FC).toContain("eid('fcResults').innerHTML = sftkCat('Scanning dependencies…') + _scanProgHtml(fcScopeLegs(_scope, _selObj.api));");
    expect(FC).toContain("return all.filter(([k]) => k === 'index' || L[k]).map(([key, label, weight]) => ({ key, label, weight }));");
    expect(FC).toContain('const eta = p.doneW >= 3 && p.doneMs > 0 ? Math.max(1, Math.round((p.doneMs / p.doneW) * left / 1000 - (Date.now() - p.legAt) / 1000)) : null;');
    expect(FC).toContain('const msg = _scanMsg;');
    expect(FC).not.toContain("const msg = t => { const el = eid('fcResults')?.querySelector('.lp-robot-msg'); if (el) el.textContent = t; };");
    expect(FC).toContain('if (_scanProg) _scanProgFound(_scanProg.found + 1);');
    expect(CSS).toContain('.fc-scan-step.now { background: var(--brand); animation: fcScanPulse 1s ease-in-out infinite alternate; }');
  });
});

describe('⏻ Flow switches: the whole chain', () => {
  it('a second chip names every flow down (or up) the chain when it goes deeper than one level, and ticks them all', () => {
    expect(DEP).toContain('const chainOf = (start, map) => {');
    expect(DEP).toContain("if (all.length <= (direct || []).filter(Boolean).length) return '';");
    expect(DEP).toContain("chainChip(f.apiName, calls, calls[f.apiName], '\\u21ca', 'whole chain down')");
    expect(DEP).toContain("chainChip(f.apiName, calledBy, calledBy[f.apiName], '\\u21c8', 'every caller up')");
    expect(DEP).toContain('class="dep-fb-sub dep-fb-chain"');   // the same click handler ticks its names
    // a subflow reads as one (user 2026-11-08: "they look like a normal flow")
    expect(DEP).toContain("!inTree && (calledBy[f.apiName] || []).length ? ' dep-list-row-sub' : ''");
    // the hierarchy (user 2026-11-08: "we need to show it as hierarchy on load … both on switchers and api versions")
    expect(DEP).toContain('const order = sftkFlowTreeOrder(st.matrix, calls, r => (r.triggered ? 0 : 1));');
    expect(DEP).toContain('const key = sftkFlowBulkGroupKey(byApi.get(e.rootApi) || e.row);');
    expect(DEP).toContain("${sftkFlowTreeBlocks(sftkFlowTreeOrder([...matrix].sort((a, b) =>");
    expect((DEP.match(/class="dep-fb-twig" aria-hidden="true"/g) || []).length).toBe(2);
    // a tree is a card with its own tick-all, in both panels (user 2026-11-08: "לא רואים שזה עץ. פשוט צריך לעשות tick all ואפשרות לבחור")
    expect(DEP).toContain('<div class="dep-fb-treebox" data-tree="${escHtml(bk.rootApi)}">');
    expect(DEP).toContain('class="dep-fb-tree-all" data-tree="${escHtml(bk.rootApi)}"> tick the whole tree</label>');
    expect(DEP).toContain('class="dep-av-tree-all" data-tree="${escHtml(bk.rootApi)}"> tick the whole tree</label>');
    expect(DEP).toContain("t.indeterminate = on > 0 && on < mine.length;");
    expect(CSS).toContain('.dep-fb-treebox { margin: 6px 8px; border: 1px solid var(--brand);');
    const B = extractFunctions('sftk-flowbulk.js', ['sftkFlowTreeBlocks']);
    const blocks = B.sftkFlowTreeBlocks([{ row: { apiName: 'A' }, depth: 0, rootApi: 'A' }, { row: { apiName: 'B' }, depth: 1, rootApi: 'A' }, { row: { apiName: 'C' }, depth: 0, rootApi: 'C' }]);
    expect(blocks.map(b => `${b.rootApi}:${b.rows.length}:${[...b.names].join('+')}`)).toEqual(['A:2:A+B', 'C:1:C']);
    const T = extractFunctions('sftk-flowbulk.js', ['sftkFlowTreeOrder', 'sftkFlowCallsOf']);
    const rows = [{ apiName: 'Trig' }, { apiName: 'L1' }, { apiName: 'L2' }, { apiName: 'Alone' }, { apiName: 'Shared' }, { apiName: 'Trig2' }];
    const calls = T.sftkFlowCallsOf({ L1: [{ apiName: 'Trig' }], L2: [{ apiName: 'L1' }], Shared: [{ apiName: 'Trig' }, { apiName: 'Trig2' }] });
    expect(calls).toEqual({ Trig: ['L1', 'Shared'], L1: ['L2'], Trig2: ['Shared'] });
    const o = T.sftkFlowTreeOrder(rows, calls).map(e => `${e.row.apiName}:${e.depth}:${e.rootApi}`);
    expect(o).toEqual(['Trig:0:Trig', 'L1:1:Trig', 'L2:2:Trig', 'Shared:1:Trig', 'Alone:0:Alone', 'Trig2:0:Trig2']);   // Shared placed once, under its first caller
    // a root rank: the triggered caller leads, so the shared subflow nests under it
    const rows2 = [{ apiName: 'Auto' }, { apiName: 'Trig', triggered: true }, { apiName: 'Sub' }];
    const o2 = T.sftkFlowTreeOrder(rows2, { Auto: ['Sub'], Trig: ['Sub'] }, r => (r.triggered ? 0 : 1)).map(e => `${e.row.apiName}:${e.depth}:${e.rootApi}`);
    expect(o2).toEqual(['Trig:0:Trig', 'Sub:1:Trig', 'Auto:0:Auto']);
    // a cycle ends where a flow is already placed
    expect(T.sftkFlowTreeOrder([{ apiName: 'A' }, { apiName: 'B' }], { A: ['B'], B: ['A'] }).map(e => e.row.apiName + e.depth)).toEqual(['A0', 'B1']);
    expect(DEP).toContain('<span class="dep-fb-subtag"');
    expect(DEP).toContain('<span class="dep-fb-subgrp">');
    expect(CSS).toContain('.dep-list-row-sub { box-shadow: inset 3px 0 0 var(--brand); }');
    expect(CSS).toContain('.dep-fb-chain { border-style: dashed; }');
  });
});
