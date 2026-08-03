// Data Studio dark theme + icon-table regression guards (studio.css).
//
// Three invariants, all rooted in the same architectural fact: studio.html
// loads styles.css AND studio.css, in that order, so the two sheets are one
// cascade — a value studio.css forgets falls back to the popup's, and a value
// studio.css re-declares silently wins on the Studio page only.
//
//  1. `.ds-dark` must restate every literal-valued :root token it depends on
//     (--cat-* mascot palette, --shadow/--shadow-md). A literal declared only
//     at :root inherits into the dark subtree unchanged, so a missing
//     restatement paints the LIGHT value on the dark surface.
//  2. Pro mode hides emoji slots only. The nav icons and the trust lock are
//     monochrome mask glyphs now — hiding them strips exactly the
//     presentation Pro mode exists to show.
//  3. The mask table is ONE table: no glyph name may be defined in both
//     stylesheets, or the same name renders two different drawings.
//
// SOURCE assertions (no DOM harness in `npm test`), like ui-studio.test.mjs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');

const STUDIO_CSS = read('studio.css');
const SHARED_CSS = read('styles.css');
const HTML       = read('studio.html');
const CORE       = read('studio-core.js');

// Comments may legitimately QUOTE selectors and declarations (the icon-table
// banner shows an example rule), so every structural assertion below runs on
// comment-stripped source. House style bans `*` + `/` inside comment text,
// which is what makes this strip reliable.
const strip = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const STUDIO = strip(STUDIO_CSS);
const SHARED = strip(SHARED_CSS);

// First declaration block for a selector. All blocks used here are flat
// declaration lists, so the first close-brace ends them.
const block = (src, selector) => {
  const i = src.indexOf(selector);
  expect(i, `selector present: ${selector}`).toBeGreaterThan(-1);
  return src.slice(i, src.indexOf('}', i) + 1);
};
const decl = (blk, prop) => {
  const m = blk.match(new RegExp(`${prop}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
};

const DS_DARK   = block(STUDIO, '.ds-dark {');
const SFTK_DARK = block(SHARED, 'body.sftk-dark {');

const CAT_TOKENS = [
  '--cat-fur', '--cat-fur-dark', '--cat-belly', '--cat-inner',
  '--cat-eye', '--cat-nose', '--cat-stripe',
];

describe('.ds-dark restates the literal-valued :root tokens', () => {
  it('declares all seven --cat-* mascot tokens', () => {
    for (const t of CAT_TOKENS) {
      expect(decl(DS_DARK, t), t).not.toBeNull();
    }
  });

  it('the cat palette matches body.sftk-dark exactly — one night kitty in both apps', () => {
    for (const t of CAT_TOKENS) {
      expect(decl(DS_DARK, t), t).toBe(decl(SFTK_DARK, t));
    }
  });

  it('restates --shadow and --shadow-md with the popup dark values', () => {
    for (const t of ['--shadow', '--shadow-md']) {
      expect(decl(DS_DARK, t), t).not.toBeNull();
      expect(decl(DS_DARK, t), t).toBe(decl(SFTK_DARK, t));
    }
  });
});

describe('pro mode hides emoji slots, not mask icons', () => {
  it('no .ds-pro rule targets the mask-icon slots', () => {
    expect(STUDIO).not.toContain('.ds-pro .ds-nav-icon');
    expect(STUDIO).not.toContain('.ds-pro .ds-trust-lock');
  });

  it('every emoji slot stays hidden', () => {
    const rule = block(STUDIO, '.ds-pro .ds-logo');
    for (const sel of [
      '.ds-pro .ds-logo',
      '.ds-pro .ds-welcome-hero-icon',
      '.ds-pro .ds-welcome-card-icon',
      '.ds-pro .ds-welcome-trust-icon',
      '.ds-pro .sec-hero-icon',
      '.ds-pro .sec-yes-icon',
    ]) expect(rule, sel).toContain(sel);
    expect(rule).toMatch(/display:\s*none/);
    // The command palette icons became dsIcon() MASK glyphs in this same
    // batch — Pro mode keeps mask icons, so they must NOT be in the list.
    expect(rule).not.toContain('.ds-pro .ds-cmd-item-icon');
    expect(rule).not.toContain('.ds-pro .ds-cmd-search-icon');
  });

  it('the spared slots really are mask glyphs in the markup', () => {
    expect(HTML).toMatch(/class="ds-trust-lock ds-i" data-i="lock"/);
    expect(HTML).toMatch(/class="ds-nav-icon ds-i" data-i="/);
  });
});

describe('one mask table across the two stylesheets', () => {
  // A definition is `[data-i="name"]…{ --adbg-icon`. Selector lists like the
  // shared sheet's `[data-i="x"], [data-adbg-icon="x"] {` still match.
  const defNames = src => {
    const names = [];
    for (const m of src.matchAll(/\[data-i="([a-z-]+)"\][^\n{]*\{\s*--adbg-icon/g)) {
      names.push(m[1]);
    }
    return names;
  };

  it('studio.html loads styles.css before studio.css — the fall-through this design relies on', () => {
    const shared = HTML.indexOf('href="styles.css"');
    const studio = HTML.indexOf('href="studio.css"');
    expect(shared).toBeGreaterThan(-1);
    expect(studio).toBeGreaterThan(shared);
  });

  it('the five formerly-duplicated names live only in styles.css', () => {
    const studioNames = defNames(STUDIO);
    const sharedNames = defNames(SHARED);
    for (const name of ['sliders', 'shield', 'arrow-right', 'moon', 'sun']) {
      expect(studioNames, name).not.toContain(name);
      expect(sharedNames.filter(n => n === name), name).toHaveLength(1);
    }
  });

  it('NO glyph name is defined in both stylesheets', () => {
    const sharedNames = new Set(defNames(SHARED));
    const overlap = defNames(STUDIO).filter(n => sharedNames.has(n));
    expect(overlap).toEqual([]);
  });

  it('the dark toggle keeps its data-i attribute so the shared moon/sun shapes apply', () => {
    expect(HTML).toMatch(/class="ds-dark-toggle"[^>]*data-i="moon"/);
    expect(CORE).toMatch(/setAttribute\('data-i',\s*on \? 'sun' : 'moon'\)/);
  });
});
