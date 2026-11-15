// Release QA 2026-11-14 (QA sizes): two styles.css regressions in the Toolkit popup.
//  1. The Data Studio card on the home page: .home-studio-desc was
//     rgba(255,255,255,.80) on the brand blue — 3.5:1 light, 2.5:1 dark — and
//     even solid white is only 3.1:1 on the dark theme's #1B96FF.
//  2. The topbar brand name wrapped to three lines at 853 CSS px (1280x720 at 150%).
// SOURCE assertions on the comment-stripped sheet (no DOM harness in npm test).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(root, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function blocks(sel) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(CSS))) {
    const sels = m[1].split(',').map(s => s.trim());
    if (sels.includes(sel)) out.push(m[2]);
  }
  return out;
}
function last(sel, prop) {
  let v;
  for (const body of blocks(sel)) {
    const d = body.match(new RegExp(`(?:^|;)\\s*${esc(prop)}\\s*:\\s*([^;]+)`));
    if (d) v = d[1].trim();
  }
  return v;
}
function token(name, scope) {
  // scope: ':root' (light) or 'body.sftk-dark'
  const v = last(scope, name);
  return v;
}
function hex(c) {
  const m = /^#([0-9a-f]{6})$/i.exec(c || '');
  if (!m) throw new Error('not a solid hex colour: ' + c);
  return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
}
function lum([r, g, b]) {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const [x, y] = [lum(hex(a)), lum(hex(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
// Follows var() chains: a dark-theme lookup falls back to :root, as the cascade does.
const resolve = (v, scope) => {
  for (let i = 0; i < 5; i++) {
    const m = /^var\((--[\w-]+)\)$/.exec(v || '');
    if (!m) return v;
    v = token(m[1], scope) || token(m[1], ':root');
  }
  return v;
};

describe('Data Studio card on the Toolkit home: text contrast (QA 2026-11-14)', () => {
  it('the description is solid white, not a translucent white', () => {
    const c = resolve(last('.home-studio-desc', 'color'), ':root');
    expect(c.toUpperCase()).toBe('#FFFFFF');
  });

  it('light theme: white text on the card background is at least 4.5:1', () => {
    const bg = resolve(last('.home-studio-btn', 'background'), ':root');
    expect(contrast('#FFFFFF', bg)).toBeGreaterThanOrEqual(4.5);
    const hover = resolve(last('.home-studio-btn:hover', 'background'), ':root');
    expect(contrast('#FFFFFF', hover)).toBeGreaterThanOrEqual(4.5);
  });

  it('dark theme: the card takes a darker blue so white text is at least 4.5:1', () => {
    const bg = resolve(last('body.sftk-dark .home-studio-btn', 'background'), 'body.sftk-dark');
    expect(contrast('#FFFFFF', bg)).toBeGreaterThanOrEqual(4.5);
    const hover = resolve(last('body.sftk-dark .home-studio-btn:hover', 'background'), 'body.sftk-dark');
    expect(contrast('#FFFFFF', hover)).toBeGreaterThanOrEqual(4.5);
    // The guard is real: the dark brand token alone would fail.
    expect(contrast('#FFFFFF', token('--c-brand', 'body.sftk-dark'))).toBeLessThan(4.5);
  });
});

describe('Toolkit topbar brand stays on one line at narrow widths (QA 2026-11-14)', () => {
  it('the brand name does not wrap and truncates with an ellipsis', () => {
    expect(last('.app-brand-name', 'white-space')).toBe('nowrap');
    expect(last('.app-brand-name', 'overflow')).toBe('hidden');
    expect(last('.app-brand-name', 'text-overflow')).toBe('ellipsis');
    expect(last('.app-brand-name', 'min-width')).toBe('0');
  });
  it('the brand container may shrink below its content width', () => {
    expect(last('.app-brand', 'min-width')).toBe('0');
  });
});
