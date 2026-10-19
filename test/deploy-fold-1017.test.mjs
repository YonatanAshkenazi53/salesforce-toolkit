import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const DV = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../studio.css', import.meta.url), 'utf8');
const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');

// User 2026-10-17: "can we do the whole sections collapsable? the deployment tree, deploy parents,
// worth reading" — the three cards are <details>, open by default, and what is folded is remembered.
describe('Deploy page: the tree, parents-first and notes cards fold', () => {
  it('one level of folding: two sections fold, the cards inside them do not (user 2026-10-18)', () => {
    expect((DV.match(/<details\$\{_depFoldOpen\(/g) || []).length).toBe(2);
    expect(DV).toContain('<details${_depFoldOpen(\'info\')} class="ds-rec-card ds-dep-fold ds-dep-info" data-fold="info">');
    expect(DV).toContain('<details${_depFoldOpen(\'plan\')} class="ds-rec-card ds-dep-fold" data-fold="plan">');
    expect(DV).toContain('<div class="ds-rec-card-hd"><span class="ds-rec-card-ico">📦</span><span class="ds-rec-card-title">This deployment</span>');
    expect(DV).toContain("const SFTK_DEP_FOLDS = ['info', 'plan'];");
    // About holds the parents, the notes and the tree
    const info = DV.indexOf('data-fold="info"'), tree = DV.indexOf('<div id="dsDepTree"></div>'), order = DV.indexOf('<div id="dsDepOrder"></div>');
    expect(info).toBeGreaterThan(0); expect(order).toBeGreaterThan(info); expect(tree).toBeGreaterThan(order);
    expect(DV).toContain('<span class="ds-rec-card-title">Parents synced ✓</span>');
    expect(CSS).toContain('.ds-dep-parents-synced .ds-rec-card-title, .ds-dep-parents-synced .ds-rec-card-ico { color: var(--c-good-fg, var(--success)); }');   // green (user 2026-10-19)
    expect(DV).toContain('⛓ Parents are checked as soon as both orgs are open');
    // the orgs section: the picker, the plan table, the records — one fold
    expect(DV).toContain('planHtml.slice(0, s) + _depOrgPickerHtml(p) + planHtml.slice(s, i) + recordsHtml');
  });
  it('open by default; a fold remembered as false stays folded; a toggle is saved to the settings', () => {
    const i = DV.indexOf('function _depFoldOpen(');
    const fn = new Function('_settings', DV.slice(i, DV.indexOf('\n}\n', i) + 3) + ' return _depFoldOpen;');
    expect(fn(undefined)('info')).toBe(' open');
    expect(fn({ deployFolds: { info: false } })('info')).toBe('');
    expect(fn({ deployFolds: { info: false } })('plan')).toBe(' open');
    expect(DV).toContain("_settings.deployFolds = { ...(_settings.deployFolds || {}), [el.dataset.fold]: !!el.open };");
    expect(DV).toContain('_depWireFolds(document);');
    expect(DV).toContain('_depWireFolds(host);');
    expect(DV).toContain('_depWireFolds(h);');
  });
  it('the plan table and the records are one section; the table row picks the object (2026-10-18)', () => {
    expect(DV).not.toContain('    ${planHtml}\n    ${recordsHtml}');
    expect(DV).toContain('<div class="ds-dep-objsw"><span class="ds-dep-lbl">Object</span>');   // the objects stay, inside the one section
    expect(DV).toContain(' class="ds-dep-cur" aria-current="true"');
  });
  it('the tree lives inside About this deployment (user 2026-10-18: "this is all one collapsable section")', () => {
    const a = DV.indexOf('data-fold="info">'), tr = DV.indexOf('<div id="dsDepTree"></div>'), end = DV.indexOf('</details>', a);
    expect(tr).toBeGreaterThan(a); expect(tr).toBeLessThan(end);
  });
  it('a folded section shows a one-line summary of what it holds (2026-10-18)', () => {
    expect((DV.match(/class="ds-dep-foldsum"/g) || []).length).toBeGreaterThanOrEqual(3);
    // user 2026-10-18: the parents' verdict sits in the About header, always shown; an org closed or a failed read says so
    expect(DV).toContain('<span class="ds-rec-card-title">About this deployment</span><span id="dsDepParentsChip"');
    expect(DV).toContain("ch.textContent = 'parents: not checked — an org is closed'");
    expect(DV).toContain("ch.textContent = '⚠ parents could not be checked'");
    expect(CSS).toContain('.ds-dep-fold:not([open]) > summary .ds-dep-foldsum { display: inline; }');
  });
  it('fold all / unfold all set every section and remember it', () => {
    expect(DV).toContain('id="dsDepFoldAll"'); expect(DV).toContain('id="dsDepUnfoldAll"');
    expect(DV).toContain("eid('dsDepFoldAll')?.addEventListener('click', () => _depFoldEvery(false));");
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
