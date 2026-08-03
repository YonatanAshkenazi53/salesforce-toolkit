// Modal / toast / empty-state normalization guards (styles.css + studio.css).
//
// studio.html loads styles.css AND studio.css in that order, so both apps
// draw from one token scale (--r-*, --sp-* declared in styles.css :root).
// Before normalization the two apps shipped three modal radii (4/10/12px,
// two of them off the radius scale) plus 14px on the Studio command palette.
//
// Invariants:
//  1. Every overlay-dialog container — popup modal, debug-level builder
//     modal, both Ctrl+K command palettes, Studio modal — rounds with the
//     SAME scale token, var(--r-lg), and --r-lg stays 8px so the value is
//     on-scale.
//  2. Interior surfaces that must coincide with the container's corner clip
//     (adbg modal footer, security-modal hero) reference the same token —
//     a hardcoded pixel value there drifts silently when the container moves.
//  3. Toast and empty-state paddings/radii sit on the --sp-*/--r-* scale in
//     both apps.
//
// SOURCE assertions (no DOM harness in `npm test`), like studio-dark-css.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');

// Comments may quote selectors/declarations, so structural assertions run on
// comment-stripped source. House style bans `*` + `/` inside comment text,
// which is what makes this strip reliable.
const strip = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const SHARED = strip(read('styles.css'));
const STUDIO = strip(read('studio.css'));

// First declaration block for a selector (all blocks used here are flat
// declaration lists, so the first close-brace ends them). Selectors are
// passed WITH the trailing " {" so ".adbg-modal" cannot match
// ".adbg-modal-overlay".
const block = (src, selector) => {
  const i = src.indexOf(selector);
  expect(i, `selector present: ${selector}`).toBeGreaterThan(-1);
  return src.slice(i, src.indexOf('}', i) + 1);
};
const decl = (blk, prop) => {
  const m = blk.match(new RegExp(`${prop}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
};

describe('one modal radius across both apps', () => {
  const containers = [
    [SHARED, '.modal-box {'],
    [SHARED, '.adbg-modal {'],
    [SHARED, '.tk-cmd-box {'],
    [STUDIO, '.ds-modal-box {'],
    [STUDIO, '.ds-cmd-box {'],
  ];
  for (const [src, sel] of containers) {
    it(`${sel.replace(' {', '')} rounds with var(--r-lg)`, () => {
      expect(decl(block(src, sel), 'border-radius')).toBe('var(--r-lg)');
    });
  }

  it('--r-lg is still the 8px scale stop the containers rely on', () => {
    expect(SHARED).toMatch(/--r-lg:\s*8px/);
  });

  it('no selector list downgrades the adbg modal container to a smaller radius', () => {
    // The old override enumerated the container alongside its inner controls;
    // the container must not reappear in any multi-selector radius rule.
    expect(SHARED).not.toMatch(/\.adbg-modal\s*,[^{]*\{[^}]*border-radius:\s*var\(--r-sm\)/);
  });
});

describe('interior surfaces track the container clip', () => {
  it('adbg modal footer bottom corners use the container token', () => {
    expect(SHARED).toMatch(
      /\.adbg-modal-ftr\s*\{\s*border-radius:\s*0 0 var\(--r-lg\) var\(--r-lg\);\s*\}/
    );
  });

  it('security-modal hero top corners use the container token', () => {
    expect(decl(block(STUDIO, '.sec-hero {'), 'border-radius'))
      .toBe('var(--r-lg) var(--r-lg) 0 0');
  });
});

describe('toasts are token-valued in both apps', () => {
  it('.result-toast (popup) radius and padding sit on the scale', () => {
    const b = block(SHARED, '.result-toast {');
    expect(decl(b, 'border-radius')).toBe('var(--r-lg)');
    expect(decl(b, 'padding')).toBe('var(--sp-4) var(--sp-5)');
  });

  it('.ds-toast (Studio) radius and padding sit on the scale', () => {
    const b = block(STUDIO, '.ds-toast {');
    expect(decl(b, 'border-radius')).toBe('var(--r-lg)');
    expect(decl(b, 'padding')).toBe('var(--sp-5) var(--sp-6)');
  });
});

describe('empty states are token-valued in both apps', () => {
  it('.empty-state (popup) padding sits on the scale', () => {
    expect(decl(block(SHARED, '.empty-state {'), 'padding'))
      .toBe('var(--sp-8) var(--sp-7)');
  });

  it('.ds-empty-page (Studio) horizontal padding and gap sit on the scale', () => {
    const b = block(STUDIO, '.ds-empty-page {');
    expect(decl(b, 'padding')).toBe('64px var(--sp-7)');
    expect(decl(b, 'gap')).toBe('var(--sp-5)');
  });
});
