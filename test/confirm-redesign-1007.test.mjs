import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const SRC = readFileSync(new URL('../sftk-confirm.js', import.meta.url), 'utf8');
const CSS1 = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const CSS2 = readFileSync(new URL('../studio.css', import.meta.url), 'utf8');

// User 2026-10-07 (the API-versions confirmation): "these type of screens all over should be
// better. the ui is not good there." One shape for every write, on both pages.
describe('the shared confirmation dialog: head, band, body, pinned foot', () => {
  it('renders the sentence with facts chips, the severity class, and the pinned foot with the gates', () => {
    expect(SRC).toContain('<div class="sftk-cf sftk-cf-sev-${sev}">');
    expect(SRC).toContain('<h2 class="sftk-cf-title">${esc(title)}</h2>');
    expect(SRC).toContain('<div class="sftk-cf-facts">${facts.map(f => `<span class="sftk-cf-fact">${esc(f)}</span>`).join(\'\')}</div>');
    expect(SRC).toContain("const sev = rev.needsCheckbox ? 'red' : (!opts.revOverride && (reversibility === 'recycle' || reversibility === 'new-version')) ? 'blue' : 'amber';");
    expect(SRC).toContain('<div class="sftk-cf-foot">');
    expect(SRC.indexOf('<div class="sftk-cf-foot">')).toBeGreaterThan(SRC.indexOf('<div class="sftk-cf-body">'));
  });
  it('the items are a real list: every one rendered (capped at 500, said), a filter above 8', () => {
    expect(SRC).toContain('const MAX_SHOWN = 500;');
    expect(SRC).toContain("${items.length > 8 ? `<input class=\"${C.input} sftk-cf-filter\" id=\"sftkConfirmFilter\"");
    expect(SRC).toContain('the list is capped; every one of them is included');
    expect(SRC).toContain("document.getElementById('sftkConfirmFilter')?.addEventListener('input'");
  });
  it('production is a band in the same dialog; the ids and the two-step flow are unchanged', () => {
    expect(SRC).toContain('<div class="sftk-cf-band sftk-confirm-prodnote">🛑 <strong>${esc(prod.label)}</strong> is treated as a PRODUCTION org — one more step asks for its name.</div>');
    for (const id of ['sftkConfirmGo', 'sftkConfirmCancel', 'sftkConfirmAck', 'sftkConfirmWord', 'sftkConfirmProd', 'sftkConfirmProdGo', 'sftkConfirmProdCancel']) expect(SRC).toContain(`id="${id}"`);
    expect(SRC).toContain("hostBox()?.classList.add('sftk-cf-host');");
    expect(SRC).toContain("hostBox()?.classList.remove('sftk-cf-host');");
  });
  it('Enter in the typed field presses Go only when Go is enabled', () => {
    expect(SRC).toContain("if (e.key === 'Enter' && go && !go.disabled) go.click();");
  });
  it('both stylesheets carry the dialog, 720px wide, coloured by severity, body scrolls, foot pinned', () => {
    for (const css of [CSS1, CSS2]) {
      expect(css).toContain('.sftk-cf-host { width: min(720px, 94vw) !important;');
      expect(css).toContain('.sftk-cf-sev-red  { --cf: var(--danger);');
      expect(css).toContain('.sftk-cf-body { padding: 14px 20px; overflow: auto; flex: 1 1 auto; min-height: 0;');
      expect(css).toContain('.sftk-cf-foot { display: flex; align-items: center; justify-content: space-between;');
    }
  });
});
