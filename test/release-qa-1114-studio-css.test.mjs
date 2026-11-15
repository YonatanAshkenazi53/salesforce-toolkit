// Release QA 2026-11-14 (QA sizes): two studio.css regressions.
//  1. The Data Studio topbar ran past the right edge at 1280 CSS px and below
//     about 950 px, cutting off Licence, Activity and the open-orgs chip.
//  2. .ds-btn-danger had no dark-mode override: light pink fill under the dark
//     theme's light red text, 2.50:1.
// SOURCE assertions on the comment-stripped sheet (no DOM harness in npm test).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(root, 'studio.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const HTML = readFileSync(join(root, 'studio.html'), 'utf8');

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Every top-level (non-media) block whose selector list contains `sel` exactly.
function blocks(sel) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(CSS))) {
    const sels = m[1].split(',').map(s => s.trim());
    if (sels.includes(sel)) out.push({ idx: m.index, body: m[2] });
  }
  return out;
}
// The value the LAST block in source order gives `prop` for `sel`.
function last(sel, prop) {
  let v;
  for (const b of blocks(sel)) {
    const d = b.body.match(new RegExp(`(?:^|;)\\s*${esc(prop)}\\s*:\\s*([^;]+)`));
    if (d) v = d[1].trim();
  }
  return v;
}
function mediaBody(maxWidth) {
  const re = new RegExp(`@media\\s*\\(max-width:\\s*${maxWidth}px\\)\\s*\\{([\\s\\S]*?\\})\\s*\\}`, 'g');
  return [...CSS.matchAll(re)].map(m => m[1]).join('\n');
}
function lum(hex) {
  const c = hex.replace('#', '').match(/../g).map(h => parseInt(h, 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

describe('Studio topbar never pushes a control off the right edge (QA sizes 2026-11-14)', () => {
  it('the centre may shrink to nothing and the trust badge shrinks with it', () => {
    expect(last('.ds-topbar-center', 'min-width')).toBe('0');
    expect(last('.ds-topbar .ds-trust-badge', 'flex-shrink')).toBe('1');
    expect(last('.ds-topbar .ds-trust-badge', 'min-width')).toBe('0');
  });
  it('the badge text ends in an ellipsis instead of holding its width', () => {
    expect(last('.ds-topbar .ds-trust-text', 'overflow')).toBe('hidden');
    expect(last('.ds-topbar .ds-trust-text', 'text-overflow')).toBe('ellipsis');
    expect(HTML).toMatch(/class="ds-trust-text"/);
  });
  it('the right-hand row and the brand do not shrink (their controls stay whole)', () => {
    expect(last('.ds-topbar-right', 'flex-shrink')).toBe('0');
    expect(last('.ds-brand', 'flex-shrink')).toBe('0');
  });
  it('the chip org names go below 1320 px, not only below 1100 px', () => {
    expect(mediaBody(1320)).toMatch(/\.ds-pair-chip-names\s*\{\s*display:\s*none/);
  });
  it('below 960 px the badge text and the Quick nav word go, Ctrl K stays', () => {
    const m = mediaBody(960);
    expect(m).toMatch(/\.ds-topbar \.ds-trust-text/);
    expect(m).toMatch(/\.ds-topbar \.ds-cmd-topbar-hint > span/);
    expect(m).toMatch(/display:\s*none/);
    expect(m).not.toMatch(/kbd/);
    expect(HTML).toMatch(/<kbd>Ctrl<\/kbd><kbd>K<\/kbd>\s*<span>Quick nav<\/span>/);
  });
  it('the Licence, Activity and open-orgs controls are never hidden by a width rule', () => {
    for (const w of [1320, 1100, 960]) {
      expect(mediaBody(w)).not.toMatch(/sftkTermsBtn|sftkFeedBtn|\.ds-pair-chip\s*[,{]/);
    }
  });
});

describe('Dark danger button is readable (QA sizes 2026-11-14)', () => {
  it('.ds-dark .ds-btn-danger has its own dark fill and light red text', () => {
    const bg = last('.ds-dark .ds-btn-danger', 'background');
    const fg = last('.ds-dark .ds-btn-danger', 'color');
    expect(bg).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(fg).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(lum(bg)).toBeLessThan(0.05);              // a dark fill, not the light pink
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5); // WCAG AA for text
  });
  it('the dark rule comes after the light one, and hover stays dark', () => {
    const light = blocks('.ds-btn-danger').map(b => b.idx);
    const dark = blocks('.ds-dark .ds-btn-danger').map(b => b.idx);
    expect(Math.min(...dark)).toBeGreaterThan(Math.max(...light));
    const hover = last('.ds-dark .ds-btn-danger:hover:not(:disabled)', 'background');
    expect(lum(hover)).toBeLessThan(0.05);
    expect(ratio(last('.ds-dark .ds-btn-danger', 'color'), hover)).toBeGreaterThanOrEqual(4.5);
  });
});
