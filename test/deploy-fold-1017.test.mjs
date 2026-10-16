import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const DV = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../studio.css', import.meta.url), 'utf8');
const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');

// User 2026-10-17: "can we do the whole sections collapsable? the deployment tree, deploy parents,
// worth reading" — the three cards are <details>, open by default, and what is folded is remembered.
describe('Deploy page: the tree, parents-first and notes cards fold', () => {
  it('each card is a <details> with a data-fold key and a summary header', () => {
    expect(DV).toContain('<details${_depFoldOpen(\'tree\')} class="ds-rec-card ds-dep-fold" data-fold="tree">');
    expect(DV).toContain('<details${_depFoldOpen(\'order\')} class="ds-rec-card ds-dep-fold ${anyDoomed ? \'ds-rec-card-bad\' : anyEmpty ? \'ds-rec-card-warn\' : allDone ? \'ds-rec-card-good\' : \'\'}" data-fold="order">');
    expect(DV).toContain('<details${_depFoldOpen(\'notes\')} class="ds-rec-card ds-rec-card-warn ds-dep-fold" data-fold="notes"><summary class="ds-rec-card-hd">');
    expect(DV).toContain('<summary class="ds-rec-card-hd"><span class="ds-rec-card-ico">📦</span><span class="ds-rec-card-title">This deployment</span>');
    expect(DV).toContain('<summary class="ds-rec-card-hd"><span class="ds-rec-card-ico">⛓</span>');
  });
  it('open by default; a fold remembered as false stays folded; a toggle is saved to the settings', () => {
    const i = DV.indexOf('function _depFoldOpen(');
    const fn = new Function('_settings', DV.slice(i, DV.indexOf('\n}\n', i) + 3) + ' return _depFoldOpen;');
    expect(fn(undefined)('tree')).toBe(' open');
    expect(fn({ deployFolds: { tree: false } })('tree')).toBe('');
    expect(fn({ deployFolds: { tree: false } })('order')).toBe(' open');
    expect(DV).toContain("_settings.deployFolds = { ...(_settings.deployFolds || {}), [el.dataset.fold]: !!el.open };");
    expect(DV).toContain('_depWireFolds(document);');
    expect(DV).toContain('_depWireFolds(host);');
    expect(DV).toContain('_depWireFolds(h);');
  });
  it('the stylesheet draws the chevron and hides the hint of a folded card', () => {
    expect(CSS).toContain(".ds-dep-fold:not([open]) > summary::before { content: '▸'; }");
    expect(CSS).toContain('.ds-dep-fold:not([open]) > summary .ds-rec-card-hint { display: none; }');
  });
});

// User 2026-10-17: "lets change the reconcile page name to transfer. it makes more sense than reconcile"
describe('the word users read is Transfer, not Reconcile', () => {
  it('the progress header and the run toast say Transfer', () => {
    expect(RC).toContain("'<div class=\"ds-prog-hdr\">Transfer progress</div>'");
    expect(RC).toContain('const toastMsg = `Transfer: ${toastParts.join');
    expect(RC).not.toContain('Reconcile progress');
  });
  it('no page text says Reconcile any more (identifiers may)', () => {
    for (const f of ['studio-deploy.js', 'studio-reconcile.js', 'studio-core.js', 'studio-compare.js', 'studio-history.js', 'studio-seed.js', 'studio-builder.js', 'background.js', 'sftk-terms.js', 'sftk-friendly-error.js']) {
      const s = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
      expect(/\bReconcile\b/.test(s), `${f} still says Reconcile`).toBe(false);
    }
  });
});
