// The records list on the Deploy page: "Showing 300 of 5,000 — … Filter to
// find a record" told the user to go look elsewhere (2026-10-02: "dont think
// its a good user exp. we need to give the info somehow"). The window now
// grows: Show N more / Show all, per list, in place, scroll kept.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const DV = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');

describe('records list window', () => {
  it('the window is per list (object × tab × filter) and resets when the list changes', () => {
    expect(DV).toContain("let _depWindow = SFTK_DEPLOY_WINDOW, _depWindowKey = '';");
    expect(DV).toContain('const wkey = `${cur.pathKey}|${tabDef.k}|${q}`;');
    expect(DV).toContain('if (wkey !== _depWindowKey) { _depWindowKey = wkey; _depWindow = SFTK_DEPLOY_WINDOW; }');
    expect(DV).toContain('const shown = rows.slice(0, _depWindow);');
  });
  it('offers Show N more and Show all instead of telling the user to filter', () => {
    expect(DV).not.toContain('the count is the truth, the list is a window. Filter to find a record.');
    expect(DV).toContain('data-dep-more="step">Show ${Math.min(SFTK_DEPLOY_WINDOW, rows.length - shown.length).toLocaleString()} more</button>');
    expect(DV).toContain('data-dep-more="all">Show all ${rows.length.toLocaleString()}</button>');
  });
  it('the buttons grow the window and repaint in place, keeping the scroll position', () => {
    const i = DV.indexOf("host.querySelectorAll('[data-dep-more]')");
    const block = DV.slice(i, i + 600);
    expect(block).toContain("_depWindow = b.dataset.depMore === 'all' ? rows.length : _depWindow + SFTK_DEPLOY_WINDOW;");
    expect(block).toContain('_depPaintList(p, scan, cur, s, tabDef, opts);');
    expect(block).toContain('again.scrollTop = top');
  });
  it('✓ All says it includes the rows not shown yet', () => {
    expect(DV).toContain('including the ${(rows.length - shown.length).toLocaleString()} not shown yet (Show all lists them)');
  });
  it('card icons say what the card is: 🏢 orgs, 📦 the deployment (user 2026-10-02)', () => {
    expect(DV).toContain('<span class="ds-rec-card-ico">🏢</span><span class="ds-rec-card-title">Between which orgs</span>');
    expect(DV).toContain('<span class="ds-rec-card-ico">📦</span><span class="ds-rec-card-title">This deployment</span>');
  });
});

// 2026-10-03 — "SYNCED 5,000 of 9,899" read as "4,899 are not synced"
// (user: "where do i see those who are not synced?"). The cell and the tab
// show the TRUE total; the list line says how many it lists.
import { extractFunction } from './extract.mjs';
describe('count cells show the true total', () => {
  const label = extractFunction('studio-deploy.js', 'sftkDeployCountLabel');
  it('a truncated list with a known total reads as the total, never "X of Y"', () => {
    expect(label(5000, 9899, true, false)).toBe('9,899');
    expect(label(5000, 9899, true, true)).toBe('9,899+');
  });
  it('a truncated list with no measured total reads as a floor', () => {
    expect(label(5000, null, true, false)).toBe('5,000+');
    expect(label(5000, 5000, true, false)).toBe('5,000+');
  });
  it('a complete list reads as its count; zero stays zero', () => {
    expect(label(12, 12, false, false)).toBe('12');
    expect(label(0, 0, false, false)).toBe('0');
    expect(label(401, null, false, false)).toBe('401');
  });
  it('the plan table and the tabs use it; the list line says how many are listed', () => {
    expect((DV.match(/sftkDeployPlanRows\(p\.tree, scan, sftkScanBucketInfo, sftkDeployCountLabel\)/g) || []).length).toBe(2);
    expect(DV).toContain('are listed here');
    expect(DV).toContain('in total — the list shows the first');
  });
});
