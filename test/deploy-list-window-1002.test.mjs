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
