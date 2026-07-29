// E4 — Professional mode + accessibility (studio-core.js / studio.css /
// studio.html).
//
// Three contracts under test:
//   1. sftkGlyphFor — the pure glyph swapper behind window.sftkGlyph:
//      emoji in normal mode, plain-text label (or nothing) in pro mode.
//   2. sftkSettingsShape — the persisted ds_settings blob is normalized with
//      defaults, proMode coerced to a real boolean, and unknown keys
//      preserved (other agents' settings must survive a round-trip).
//   3. WCAG AA contrast — --subtext against its REAL backgrounds (--bg,
//      --surface, --surface2) in BOTH themes, measured from the shipped hex
//      values in studio.css with a pure WCAG 2.x contrast-ratio helper.
//      Plus: the body.ds-pro accent-muting block must not touch the text
//      color variables the contrast checks depend on.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css  = readFileSync(join(root, 'studio.css'), 'utf8');
const core = readFileSync(join(root, 'studio-core.js'), 'utf8');
const html = readFileSync(join(root, 'studio.html'), 'utf8');

const sftkGlyphFor      = extractFunction('studio-core.js', 'sftkGlyphFor');
const sftkSettingsShape = extractFunction('studio-core.js', 'sftkSettingsShape');

// ── Pure WCAG 2.x contrast helpers (test-local, no deps) ────────
function srgbChannel(c8) {
  const c = c8 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function relLuminance(hex) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map(ch => ch + ch).join('') : h;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}
function contrastRatio(a, b) {
  const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ── CSS extraction (shipped values, not fixtures) ───────────────
// Grabs the body of the FIRST `selector {` block. Good enough for the flat
// variable blocks under test (:root, .ds-dark, body.ds-pro).
function cssBlock(selector) {
  const i = css.indexOf(`${selector} {`);
  if (i === -1) throw new Error(`selector "${selector}" not found in studio.css`);
  const open = css.indexOf('{', i);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}
function cssVar(block, name) {
  const m = new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{3,8})\\s*;`).exec(block);
  if (!m) throw new Error(`variable ${name} not found in block`);
  return m[1];
}

describe('E4 sftkGlyphFor — emoji vs plain-text label', () => {
  it('returns the emoji when pro mode is off', () => {
    expect(sftkGlyphFor(false, '🔌 ', '')).toBe('🔌 ');
    expect(sftkGlyphFor(false, ' 👑', ' — source')).toBe(' 👑');
  });

  it('returns the label when pro mode is on', () => {
    expect(sftkGlyphFor(true, ' 👑', ' — source')).toBe(' — source');
    expect(sftkGlyphFor(true, '🌙', 'Dark')).toBe('Dark');
  });

  it('drops the emoji entirely in pro mode when the label is empty', () => {
    expect(sftkGlyphFor(true, '🔌 ', '')).toBe('');
  });

  it('never returns null/undefined — nullish args become empty strings', () => {
    expect(sftkGlyphFor(true, '🔌 ', null)).toBe('');
    expect(sftkGlyphFor(true, '🔌 ', undefined)).toBe('');
    expect(sftkGlyphFor(false, null, 'x')).toBe('');
    expect(sftkGlyphFor(false, undefined, undefined)).toBe('');
  });

  it('always returns a string (numbers coerced, not leaked)', () => {
    expect(sftkGlyphFor(true, '✅', 0)).toBe('0');
    expect(typeof sftkGlyphFor(false, 7, 'x')).toBe('string');
  });
});

describe('E4 sftkSettingsShape — ds_settings persistence shape', () => {
  it('fills defaults for a missing/empty blob (proMode default OFF)', () => {
    for (const raw of [undefined, null, {}]) {
      const s = sftkSettingsShape(raw);
      expect(s).toEqual({ historyDays: 30, countsOnly: false, proMode: false });
    }
  });

  it('keeps explicit values', () => {
    const s = sftkSettingsShape({ historyDays: 0, countsOnly: true, proMode: true });
    expect(s).toEqual({ historyDays: 0, countsOnly: true, proMode: true });
  });

  it('coerces proMode to a real boolean', () => {
    expect(sftkSettingsShape({ proMode: 1 }).proMode).toBe(true);
    expect(sftkSettingsShape({ proMode: 0 }).proMode).toBe(false);
    expect(sftkSettingsShape({ proMode: undefined }).proMode).toBe(false);
  });

  it('preserves unknown keys — other features\' settings survive a round-trip', () => {
    const s = sftkSettingsShape({ getStartedDone: true, someFutureKey: 'x' });
    expect(s.getStartedDone).toBe(true);
    expect(s.someFutureKey).toBe('x');
    expect(s.proMode).toBe(false);
  });

  it('does not mutate the raw input blob', () => {
    const raw = { proMode: 1 };
    sftkSettingsShape(raw);
    expect(raw.proMode).toBe(1);
  });

  it('round-trips its own output unchanged (idempotent)', () => {
    const once  = sftkSettingsShape({ proMode: true, historyDays: 7, custom: 1 });
    const twice = sftkSettingsShape(once);
    expect(twice).toEqual(once);
  });
});

describe('E4 storage wiring — pro mode rides the early ds_settings read', () => {
  it('storageLoad normalizes ds_settings through sftkSettingsShape', () => {
    expect(core).toMatch(/_settings\s*=\s*sftkSettingsShape\(d\.ds_settings\)/);
  });

  it('storageLoad applies body.ds-pro before the first view render', () => {
    // applyProMode must be called inside storageLoad (the same early storage
    // read dark mode uses), not only from the toggle — that ordering is what
    // prevents an emoji flash for pro-mode users.
    const loadFn = core.slice(core.indexOf('async function storageLoad()'),
                              core.indexOf('\n}', core.indexOf('async function storageLoad()')));
    expect(loadFn).toMatch(/applyProMode\(_settings\.proMode\)/);
  });

  it('storageSaveSettings persists the whole _settings blob under ds_settings', () => {
    expect(core).toMatch(/ds_settings:\s*_settings/);
  });
});

describe('E4 contrast — --subtext vs its real backgrounds (WCAG AA ≥ 4.5)', () => {
  it('contrast helper sanity: black/white = 21, same color = 1', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#706E6B', '#706E6B')).toBeCloseTo(1, 5);
    // symmetric
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
  });

  const lightBlock = cssBlock(':root');
  const darkBlock  = cssBlock('.ds-dark');

  for (const [themeName, block] of [['light', lightBlock], ['dark', darkBlock]]) {
    const subtext = cssVar(block, '--subtext');
    for (const bgVar of ['--bg', '--surface', '--surface2']) {
      const bg = cssVar(block, bgVar);
      it(`${themeName}: --subtext ${subtext} on ${bgVar} ${bg}`, () => {
        expect(contrastRatio(subtext, bg)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('body.ds-pro mutes accents only — never the text/background vars the AA checks cover', () => {
    const proBlock = cssBlock('body.ds-pro');
    for (const v of ['--subtext:', '--subtext-lt:', '--text:', '--bg:', '--surface:', '--surface2:']) {
      expect(proBlock).not.toContain(v);
    }
    // and it IS the accent-muting + density block it claims to be
    expect(proBlock).toContain('--brand-light:');
    expect(proBlock).toContain('--main-pad-y:');
  });
});

describe('E4 a11y + pro-mode CSS/HTML contract', () => {
  it('studio.css ships the glyph pattern classes', () => {
    expect(css).toMatch(/\.ds-pro \.ds-glyph\s*{\s*display:\s*none/);
    expect(css).toMatch(/\.ds-pro \.ds-pro-only\s*{\s*display:\s*inline/);
  });

  it('studio.css ships :focus-visible outlines and a reduced-motion kill switch', () => {
    expect(css).toContain(':focus-visible');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('nav is a labeled landmark and the default view carries aria-current', () => {
    expect(html).toMatch(/<nav[^>]*aria-label=/);
    expect(html).toMatch(/aria-current="page"/);
    // JS keeps it in sync on every view switch
    expect(core).toMatch(/setAttribute\('aria-current',\s*'page'\)/);
  });

  it('the topbar Pro toggle exists and applyProMode drives its pressed state', () => {
    expect(html).toContain('id="dsProToggle"');
    expect(core).toMatch(/aria-pressed/);
  });
});
