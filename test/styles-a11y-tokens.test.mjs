// styles.css — keyboard-focus baseline + dark elevation/focus tokens.
//
// Two adjudicated findings:
//  1. styles.css:5504-class — .lm-pp-search and .tk-cmd-input suppressed the
//     focus outline with no replacement, and the popup (unlike the Data
//     Studio, studio.css §E4) had no global :focus-visible rule to catch
//     them: Tab into the Change-License profile search or the Ctrl+K palette
//     and nothing on screen moved.
//  2. styles.css:61 — the foundation tokens --sh-xs/--sh-sm/--sh-md and
//     --focus-ring were :root literals never restated in body.sftk-dark, so
//     dark mode kept light-tuned black shadows (invisible on #16181D) and a
//     dimmed .35-alpha focus ring.
//
// SOURCE assertions — no build step, no DOM harness in npm test.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(root, 'styles.css'), 'utf8');

// Anchored slice: a missing anchor fails loudly instead of returning an empty
// string that would let every assertion inside it pass vacuously.
function slice(src, from, to, what) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  expect(a, `${what}: start anchor "${from}" not found`).toBeGreaterThan(-1);
  expect(b, `${what}: end anchor not found after "${from}"`).toBeGreaterThan(a);
  return src.slice(a, b);
}

// First simple declaration block for a bare selector (`.cls {` — does not
// match `.cls:pseudo {` or `.cls::part {`).
function block(selector) {
  const m = CSS.match(new RegExp(`(?:^|\\n)${selector.replace(/[.[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  expect(m, `rule block for "${selector}" not found`).not.toBeNull();
  return m[1];
}

// Declarations only end at column-0 `}` inside these top-level blocks, so the
// first `\n}` is the block boundary.
const ROOT = slice(CSS, ':root {', '\n}', ':root token block');
const DARK = slice(CSS, 'body.sftk-dark {', '\n}', 'dark token block');

const tokenValue = (blockSrc, name, where) => {
  const m = blockSrc.match(new RegExp(`${name}:\\s*([^;]+);`));
  expect(m, `${name} not declared in ${where}`).not.toBeNull();
  return m[1].trim();
};

describe('global keyboard-focus baseline', () => {
  it('ships the blanket :focus-visible rule mirroring studio.css §E4', () => {
    const m = CSS.match(
      /:where\(button, select, input, textarea, a, summary, \[tabindex\]\):focus-visible\s*\{([^}]*)\}/
    );
    expect(m, 'blanket :focus-visible rule missing').not.toBeNull();
    expect(m[1]).toMatch(/outline:\s*2px solid var\(--c-brand\)/);
    expect(m[1]).toMatch(/outline-offset:\s*2px/);
  });

  it('keeps baseline specificity at a bare pseudo-class via :where()', () => {
    // :is() would put the baseline at (0,2,0) and let it out-cascade the 13+
    // per-component :focus/:focus-visible treatments that provide their own
    // ring; :where() contributes zero, so those keep winning.
    expect(CSS).not.toMatch(
      /:is\(button, select, input, textarea, a, summary, \[tabindex\]\):focus-visible/
    );
  });

  it('.lm-pp-search no longer suppresses the outline', () => {
    expect(block('.lm-pp-search')).not.toMatch(/outline\s*:\s*none/);
  });

  it('.tk-cmd-input no longer suppresses the outline', () => {
    expect(block('.tk-cmd-input')).not.toMatch(/outline\s*:\s*none/);
  });

  it('draws the ring inward on the two inputs whose containers clip overflow', () => {
    // .lm-pp-wrap and .tk-cmd-box are overflow:hidden; an outward ring on an
    // edge-flush input would be clipped invisible on up to three sides.
    expect(CSS).toMatch(
      /\.lm-pp-search:focus-visible,\s*\.tk-cmd-input:focus-visible\s*\{[^}]*outline-offset:\s*-2px/
    );
  });
});

describe('dark theme restates the §A6 elevation/focus tokens', () => {
  for (const name of ['--sh-xs', '--sh-sm', '--sh-md', '--focus-ring']) {
    it(`${name} is re-pointed in body.sftk-dark with a value distinct from :root`, () => {
      const light = tokenValue(ROOT, name, ':root');
      const dark = tokenValue(DARK, name, 'body.sftk-dark');
      // Restating the identical literal would keep dark mode light-tuned.
      expect(dark).not.toBe(light);
    });
  }

  it('dark --focus-ring is built on the dark brand, not the light one', () => {
    // body.sftk-dark --c-brand is #1B96FF = rgb(27,150,255); the :root ring
    // is rgba(1,118,211,…) which sinks toward invisibility on #16181D.
    const dark = tokenValue(DARK, '--focus-ring', 'body.sftk-dark');
    expect(dark).toContain('27,150,255');
    expect(dark).not.toContain('1,118,211');
  });

  it('dark shadows swap the dark hairline for a light one', () => {
    // 0 0 0 1px rings drawn in black alpha vanish on a #16181D page — the
    // dark restatements must carry a white-alpha hairline instead, matching
    // the legacy --shadow treatment two lines below them.
    expect(tokenValue(DARK, '--sh-xs', 'body.sftk-dark')).toContain('rgba(255,255,255,');
    expect(tokenValue(DARK, '--sh-sm', 'body.sftk-dark')).toContain('rgba(255,255,255,');
  });
});
