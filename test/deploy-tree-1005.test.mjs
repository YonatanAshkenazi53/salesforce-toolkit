// Deploy page › 📦 This deployment (user 2026-10-05, on a screenshot of the
// tree: "this part seems a bit broken. the view of the objects and their
// relation. how many each hold. etc"). The cards said "recognised by Name",
// two orange "✗" identity chips per object and "821 to act on" — no relation
// in words, no record counts, and a child that was not read said only
// "unknown — scan it".
//
// Now each card says: how the object hangs under its parent, how many records
// each org holds, what is left to do (one chip per kind, opening that tab) —
// or that it is not counted yet, with a 🔎 Count button. The identity field is
// mentioned only where an org has it.
// Live 2026-10-05 (scripts/dev/live/deploy-tree.mjs): Account 10 → 4; 🔎 Count
// on Contact → 8 → 2 with its chips; a chip opened Contact › Insert.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const DV = read('studio-deploy.js');
const CSS = read('studio.css');
const src = DV.slice(DV.indexOf('const SFTK_DEPLOY_NODE_WORK = ['), DV.indexOf('// ── page state (presentation only)'));
const F = new Function(`${src}\nreturn { sftkDeployNodeFacts, SFTK_DEPLOY_NODE_WORK };`)();
void extractFunctions;
const tree = DV.slice(DV.indexOf('async function _depPaintTree('), DV.indexOf('// ── ⛓ Start with parents first'));

const cell = (n, text) => ({ n, shown: n, capped: false, text: text || String(n) });

describe('sftkDeployNodeFacts — what one card says', () => {
  it('the root: both orgs’ counts and one entry per kind of work that has records', () => {
    const f = F.sftkDeployNodeFacts({ obj: 'Account', depth: 0, field: null }, '',
      { scanned: true, src: 10, tgt: 4, cells: { ins: cell(7), chg: cell(1), ext: cell(2), same: cell(0), amb: cell(2) } });
    expect(f.role).toBe('the root object');
    expect(f.counted).toBe(true);
    expect([f.src, f.tgt]).toEqual([10, 4]);
    expect(f.work.map(w => `${w.icon} ${w.text} ${w.words}`)).toEqual(['🔴 7 to insert', '🟡 1 changed', '🔵 2 only in the target', '⚠ 2 need a decision']);
    expect(f.total).toBe(12);
    expect(f.inSync).toBe(false);
  });
  it('a child says which object it is under and through which field', () => {
    const f = F.sftkDeployNodeFacts({ obj: 'Contact', depth: 1, field: 'AccountId' }, 'Account',
      { scanned: true, src: 8, tgt: 2, cells: { ins: cell(4), chg: cell(2), ext: cell(0), link: cell(1), same: cell(1), amb: cell(0) } });
    expect(f.role).toBe('under Account · AccountId');
    expect(f.work.map(w => w.k)).toEqual(['ins', 'chg', 'link']);
  });
  it('records that need a decision are work: such an object is never "in sync"', () => {
    const f = F.sftkDeployNodeFacts({ obj: 'Account', depth: 0 }, '', { scanned: true, src: 2, tgt: 2, cells: { ins: cell(0), chg: cell(0), ext: cell(0), same: cell(0), amb: cell(2) } });
    expect(f.inSync).toBe(false);
    expect(f.total).toBe(2);
  });
  it('nothing left to do = in sync', () => {
    const f = F.sftkDeployNodeFacts({ obj: 'Account', depth: 0 }, '', { scanned: true, src: 5, tgt: 5, cells: { ins: cell(0), chg: cell(0), ext: cell(0), same: cell(5), amb: cell(0) } });
    expect(f.inSync).toBe(true);
    expect(f.work).toEqual([]);
  });
  it('an object that was not read is NOT COUNTED — no numbers, no "in sync", total unknown', () => {
    for (const row of [null, { scanned: false, src: null, tgt: null, cells: {} }]) {
      const f = F.sftkDeployNodeFacts({ obj: 'Contact', depth: 1, field: 'AccountId' }, 'Account', row);
      expect(f.counted).toBe(false);
      expect(f.inSync).toBe(false);
      expect(f.total).toBe(null);
      expect(f.src).toBe(null);
    }
  });
  it('a truncated list keeps its honest text ("5,000+")', () => {
    const f = F.sftkDeployNodeFacts({ obj: 'Account', depth: 0 }, '', { scanned: true, src: 9000, tgt: 100, cells: { ins: cell(5000, '5,000+') } });
    expect(f.work[0].text).toBe('5,000+');
  });
});

describe('the card', () => {
  it('shows how many records each org holds, by org name; an unknown count is "?" and never 0', () => {
    expect(tree).toContain("const num = v => (v == null ? '?' : Number(v).toLocaleString());");
    expect(tree).toContain('<span><b>${num(f.src)}</b> in ${esc(srcOrgL)}</span><span class="ds-dtree-arrow">→</span><span><b>${num(f.tgt)}</b> in ${esc(tgtOrgL)}</span>');
  });
  it('one chip per kind of work, and a chip opens that tab of that object', () => {
    expect(tree).toContain('data-tree-tab="${w.k}"');
    expect(tree).toContain("go(e.target.closest?.('[data-tree-tab]')?.dataset.treeTab)");
    expect(tree).toContain("_depTab = tab || 'ins';");
  });
  it('an uncounted object says so and offers 🔎 Count — once its parent is counted', () => {
    expect(tree).toContain('not counted yet — unknown, not zero');
    expect(tree).toContain('data-tree-scan="${esc(n.pathKey)}"');
    expect(tree).toContain('const parentCounted = !parent || !!(plan.find(r => r.pathKey === parent.pathKey) || {}).scanned;');
    expect(tree).toContain('(count ${esc(parent.obj)} first)');
  });
  it('🔎 Count is the same read the plan table uses, says a failure, and does not open the object', () => {
    const i = tree.indexOf("host.querySelectorAll('[data-tree-scan]')");
    const fn = tree.slice(i, tree.indexOf("eid('dsDepIdBtn')", i));
    expect(fn).toContain('e.stopPropagation();');
    expect(fn).toContain('res = await scanReconcileChild(p, b.dataset.treeScan);');
    expect(fn).toContain('showToast(`Could not count it: ${res.error}`');
    expect(tree).toContain("if (e.target.closest?.('[data-tree-scan]')) return;");
  });
  it('the identity field is mentioned only where an org has it', () => {
    expect(tree).toContain("if (!id || (id.src !== 'yes' && id.tgt !== 'yes')) return '';");
    expect(tree).not.toContain('idPill');
    expect(DV).not.toContain('ds-dtree-id-no');
    expect(tree).toContain('Optional. Records are matched by the fields shown on each card.');
  });
  it('a parent is passed down, so a child can name it', () => {
    expect(tree).toContain('const nodeHtml = (n, parent) => {');
    expect(tree).toContain('n.children.map(ch => nodeHtml(ch, n)).join(\'\')');
    expect(tree).toContain("${root ? nodeHtml(root, null) : ''}");
  });
});

describe('the connectors meet', () => {
  it('top-aligned: every line joins at the same height', () => {
    expect(CSS).toContain('.ds-dtree li { display: flex; align-items: flex-start; position: relative; padding: 6px 0 6px 30px; }');
    expect(CSS).toContain('.ds-dtree li::before { left: 0; top: 26px; width: 30px; border-top-width: 2px; }');
    expect(CSS).toContain('.ds-dtree li:first-child::after { top: 26px; }');
    expect(CSS).toContain('.ds-dtree li:last-child::after { bottom: auto; height: 26px; }');
    expect(CSS).toContain('.ds-dtree li > ul::before { left: -30px; top: 26px; width: 30px; border-top-width: 2px; }');
  });
  it('the old chip styles are gone with the chips', () => {
    expect(CSS).not.toContain('.ds-dtree-id-no');
    expect(CSS).toContain('.ds-dtree-chip {');
    expect(CSS).toContain('.ds-dtree-counts {');
  });
});
