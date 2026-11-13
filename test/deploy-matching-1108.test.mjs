// The Deploy page's Matching kit and scan-everything (user 2026-11-07): "matching of parents selection should have
// all of the features from the pic above" / "כולל ההמלצות", "here we should also allow to change matching for
// child's" / "matching by field", "i want to scan all the childrens and parents when i open the deployment, in case a
// diff matching field is selected, rescan the object and its childs", "i want a rescan all button here", "also the
// refresh state button should do what i just said". Live 2026-11-08 on the Accounts tree, npc → npc2
// (scripts/dev/live/matching-kit.mjs, scripts/dev/live/deploy-scanall.mjs).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const DV = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const F = extractFunctions('studio-deploy.js', ['sftkDeployRescanKeys', 'sftkDeployObjects', 'sftkDeployChildOrder']);
const tree = { objectType: 'Account', children: [
  { childSObject: 'Contact', field: 'AccountId', children: [] },
  { childSObject: 'Opportunity', field: 'AccountId', children: [{ childSObject: 'OpportunityLineItem', field: 'OpportunityId', children: [] }, { childSObject: 'OpportunityContactRole', field: 'OpportunityId', children: [] }] },
  { childSObject: 'Case', field: 'AccountId', children: [{ childSObject: 'CaseComment', field: 'ParentId', children: [] }] },
] };

describe('what a re-read covers', () => {
  it('every child of the deployment, read before or not, parents first', () => {
    expect(F.sftkDeployRescanKeys(tree)).toEqual(['0', '1', '2', '1.0', '1.1', '2.0']);
  });
  it('a changed key: that object and its own children only', () => {
    expect(F.sftkDeployRescanKeys(tree, ['1'])).toEqual(['1', '1.0', '1.1']);
    expect(F.sftkDeployRescanKeys(tree, ['0'])).toEqual(['0']);
    expect(F.sftkDeployRescanKeys(tree, ['0', '2'])).toEqual(['0', '2', '2.0']);
    expect(F.sftkDeployRescanKeys(tree, [''])).toEqual([]);   // the root: its own re-read, no child dragged along
  });
  it('the root is read only when it is in the set (or no set is given)', () => {
    expect(DV).toContain("if (!Array.isArray(o.from) || o.from.includes('')) await window.refreshProfileState?.(p.id);");
  });
});

describe('scan everything', () => {
  it('opening a deployment reads every object, no button pressed — once per opening; a deployment read before reads what is unread', () => {
    expect(DV).toContain('if (opening && !offline.length && _depAutoScanFor !== p.id) { _depAutoScanFor = p.id; setTimeout(() => _depRescan(p), 0); }');
    expect(DV).toContain('const unread = sftkDeployRescanKeys(p.tree).filter(k => !sftkDeployChildFresh(scan, k, _depObjName(p, k)));');
  });
  it('🔄 Rescan all on "What the two orgs hold", and 🔄 Refresh state, read every object', () => {
    expect(DV).toContain('id="dsDepRescanAll"');
    // 2026-11-13: the one button reads every object, or only the ones ticked in the table
    expect(DV).toContain("_depRescan(p, from.length ? { from } : undefined);");
    expect(DV).toContain('class="ds-dep-rescan-cb" data-path="${esc(r.pathKey)}"');
    expect(DV).toContain("return k ? `🔄 Rescan the ${k} selected` : `🔄 Rescan all ${total}`;");
    expect(DV).not.toContain("'🔎 Rescan'");
    expect(DV).toContain("eid('dsDepRefresh')?.addEventListener('click', () => _depRescan(p));");
  });
  it('a changed key re-reads its object and that object\'s children; a parent\'s key, the objects that look it up', () => {
    expect(DV).toContain('await _depRescan(p, { from: [pathKey] });');
    expect(DV).toContain('const from = sftkDeployObjects(p.tree).filter(o => step.neededBy.some(nb => nb.obj === o.obj)).map(o => o.pathKey);');
  });
});

describe('the Matching kit', () => {
  it('a parent outside the deployment: Single field / External ID, 💡 Suggestions graded live, 🧪 Test this key, source ↔ target; composite said, not hidden', () => {
    expect(DV).toContain('id="dsPmTest"');
    expect(DV).toContain('id="dsPmSug"');
    expect(DV).toContain("const res = await sftkAnalyzeMatchKey(step.refObj, clone, [field], [field], {}, 'field', false);");
    expect(DV).toContain("sftkMatchSuggestionsOfDepth(desc.fields, 1, {})");
    expect(DV).toContain("${radio('composite', 'Composite', true, 'Several fields for a parent OUTSIDE the deployment is not supported yet: the lookup bridge finds a parent by one field.");
    expect(DV).toContain('if (c && !c.inTgt) return showToast(');
  });
  it('a tree card says its key before it is read, and ✏ matching opens the object\'s own kit (the builder\'s Pick Records window)', () => {
    expect(DV).toContain('data-tree-match="${esc(n.pathKey)}"');
    expect(DV).toContain("const m = e.target.closest?.('[data-tree-match]'); if (m) { e.stopPropagation(); _depOpenMatching(p, m.dataset.treeMatch); return; }");
    expect(DV).toContain("if (typeof attachMeta === 'function') attachMeta(p.tree);");
    expect(DV).toContain('try { await openRecordPickerModal(pathKey); }');
  });
  it('the builder\'s Save stores a copy: the page puts its own object back so scan, cards and the saved deployment agree (live 2026-11-08)', () => {
    expect(DV).toContain('if (idx >= 0 && _profiles[idx] !== p) { p.updatedAt = _profiles[idx].updatedAt || p.updatedAt; _profiles[idx] = p; }');
    expect(DV).toContain("if (!ov || ov.style.display === 'none' || !document.querySelector('#dsModalBox #dsRecSave'))");
  });
});
