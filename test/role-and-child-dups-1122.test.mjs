// 2026-11-22, the owner on the Needs-a-decision tab:
//   "here we show the org names. but we dont say who is the source and who is the target which is an important info"
//   "we dont see it in the needs a decision for the contact object."
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { extractFunction } from './extract.mjs';

const dep = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const rec = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../studio.css', import.meta.url), 'utf8');
const SRC = '<span class="ds-role ds-role-src">source</span> SRC', TGT = '<span class="ds-role ds-role-tgt">target</span> TGT';

beforeAll(() => {
  globalThis.esc = s => String(s ?? ''); globalThis.orgLabel = u => String(u); globalThis.sftkMatchKeyLabel = k => String(k);
  globalThis.SFTK_AMB_RADIO_MAX = 6;
});

describe('every org this tab names says which side it is', () => {
  const p = { sourceOrg: 'SRC', targetOrg: 'TGT' };
  it('the intro', () => {
    const html = extractFunction('studio-deploy.js', '_depAmbIntro')(p, true, {});
    expect(html).toContain('which record in ' + SRC + ' is which in ' + TGT + '.');
  });
  it('a group: the header, the two columns, the merge button, the question and its answers', () => {
    const rows = [{ sourceId: 'a1', matchKey: 'Dup', candidates: ['t1'], twins: ['a2'], tell: [] }, { sourceId: 'a2', matchKey: 'Dup', candidates: ['t1'], twins: ['a1'], tell: [] }];
    const html = extractFunction('studio-deploy.js', '_depAmbGroupsHtml')(p, rows, {}, () => '', r => r.matchKey, () => '');
    expect(html).toContain('2 in ' + SRC + ' · 1 in ' + TGT);
    expect(html).toContain('<b>' + SRC + '</b> <span class="ds-dep-muted">2 records of this name</span>');
    expect(html).toContain('<b>' + TGT + '</b> <span class="ds-dep-muted">1 record of this name</span>');
    expect(html).toContain('🔀 Merge the 2 copies in ' + SRC + '</button>');
    expect(html).toContain('Say which record in ' + TGT + ' each record in ' + SRC + ' is');
    expect(html).toContain('the same record as #1 in the target TGT');
    expect(html).toContain('a new record — not in the target TGT yet, create it there');
    // an attribute carries words, never the chip's markup
    expect(html).toContain('title="Open this record in the source SRC"');
    expect(html).not.toMatch(/(title|aria-label)="[^"]*<span/);
  });
  it('the chip has its two colours', () => {
    expect(css).toContain('.ds-role-src { color: var(--c-warn-fg); }');
    expect(css).toContain('.ds-role-tgt { color: var(--brand); }');
  });
  it('the duplicate-name card says the side beside each org', () => {
    const card = extractFunction('studio-reconcile.js', 'sftkRecDupsHtml');
    const html = card({ dupKeys: { rows: 2, keys: ['Dup'], examples: [{ key: 'Dup', src: ['a1', 'a2'], tgt: [] }] } }, p, 'Contact', 'Contacts');
    expect(html).toContain('2× in ' + SRC + ': ');
  });
});

describe('a child object: its names held more than once by one org are on its own tab, with the merge', () => {
  it('the one-sided list is built for the tab of any object, not of the first one only', () => {
    expect(dep).toContain("const oneSidedAll = tabDef.k === 'amb' ? sftkDepOneSidedDups(s, key)");
    expect(dep).not.toContain('const oneSidedAll = ambRoot ?');
  });
  it('a tab with no question but with copies to merge does not open on "0 need a decision"', () => {
    expect(dep).toContain("tabDef.k === 'amb' && !all.length && oneSidedAll.length ? `No ${esc(cur.obj)} waits for a decision · ");
  });
  it('the merge reads and merges the child object, not the first object of the deployment', () => {
    expect(dep).toContain("_depMergeCopies(p, g.side, g.name, g.ids, isRoot ? {} : { obj: cur.obj })");
    expect(dep).toContain("const obj = opts.obj || (p.tree && p.tree.objectType) || '';");
  });
  it("the child's card opens the child's tab; the root's card still opens the root's", () => {
    const card = extractFunction('studio-reconcile.js', 'sftkRecDupsHtml');
    const scan = { dupKeys: { rows: 2, keys: ['Dup'], examples: [{ key: 'Dup', src: ['a1', 'a2'], tgt: [] }] } };
    const child = card(scan, { sourceOrg: 'SRC', targetOrg: 'TGT' }, 'Contact', 'Contacts');
    expect(child).toContain('data-dep-tab-go="amb" data-dep-tab-obj="Contacts"');
    expect(child).not.toContain('Merge them in Salesforce');
    const root = card(scan, { sourceOrg: 'SRC', targetOrg: 'TGT' });
    expect(root).toContain('data-dep-tab-go="amb" title=');
    expect(root).not.toContain('data-dep-tab-obj');
    // a page that passes no path (the classic one) keeps the sentence without a button
    expect(card(scan, { sourceOrg: 'SRC', targetOrg: 'TGT' }, 'Contact')).toContain('Merge them in Salesforce');
    expect(dep).toContain("_depObjPath = b.dataset.depTabObj || ''; _depTab = b.dataset.depTabGo;");
    expect(rec).toContain('function sftkRecDupsHtml(scan, p, objLabel, childPath) {');
  });
  it('a child scan lists such a name, grouped, from its Insert rows', () => {
    const f = extractFunction('studio-deploy.js', 'sftkDepOneSidedDups');
    const g = f({ missingInTarget: [{ sourceId: 'c1', matchKey: 'Dana Levi', dupKey: true }, { sourceId: 'c2', matchKey: 'Dana Levi', dupKey: true }, { sourceId: 'c3', matchKey: 'Solo' }] }, r => r.matchKey);
    expect(g).toEqual([{ name: 'Dana Levi', side: 'src', ids: ['c1', 'c2'] }]);
  });
});
