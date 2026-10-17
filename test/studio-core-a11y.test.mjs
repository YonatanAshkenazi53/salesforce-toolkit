// core-a11y — two adjudicated findings, both in studio-core.js.
//
// (1) The Data Studio half of "no live status surface": #dsToastContainer
//     was a plain <div>; showToast appended .ds-toast nodes and removed them
//     on a timer, so every toast — including errors — was silent to
//     assistive tech. The container must be a live region BEFORE the first
//     toast lands in it (a region born in the same tick as its first content
//     is not announced by most screen readers), so the attributes are set at
//     script evaluation, not inside showToast.
//
// (2) The command palette rendered raw emoji in the Studio while the popup's
//     palette and the Studio's own sidebar paint monochrome mask icons — the
//     same feature wore a different icon per surface (Flows: nodes mask in
//     the popup, wastebasket emoji in the Studio). Both palette tables now
//     carry data-i mask names rendered through dsIcon(), and those names are
//     pinned to their counterparts: sidebar nav for views, popup.js
//     HOME_FEATURES for toolkit features.
//
// SOURCE assertions only — there is no DOM harness in npm test (same
// doctrine as test/ui-studio.test.mjs).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');

const CORE   = read('studio-core.js');
const HTML   = read('studio.html');
const POPUP  = read('popup.js');
const CSS    = read('studio.css');
const SHARED = read('styles.css');

// Bounded regions, so an assertion can never pass because of some other
// section's code.
const TOAST = CORE.slice(CORE.indexOf('// TOAST NOTIFICATIONS'),
                         CORE.indexOf('// DARK MODE'));
const PALETTE = CORE.slice(CORE.indexOf('// COMMAND PALETTE'),
                           CORE.indexOf('// SECURITY MODAL'));

describe('toasts are a live region', () => {
  it('the regions under test were actually found', () => {
    expect(TOAST).toContain('function showToast(');
    expect(PALETTE).toContain('function openCommandPalette(');
  });

  it('the static container exists and the Studio makes it the region', () => {
    expect(HTML).toContain('id="dsToastContainer"');
    expect(TOAST).toMatch(/eid\('dsToastContainer'\)/);
    expect(TOAST).toContain("setAttribute('role', 'status')");
    expect(TOAST).toContain("setAttribute('aria-live', 'polite')");
  });

  it('the region is established BEFORE showToast, not per toast', () => {
    // Attributes set inside showToast would arrive in the same tick as the
    // first toast's insertion — announced by nothing.
    const init = TOAST.indexOf("setAttribute('aria-live', 'polite')");
    const fn   = TOAST.indexOf('function showToast(');
    expect(init).toBeGreaterThan(-1);
    expect(fn).toBeGreaterThan(-1);
    expect(init).toBeLessThan(fn);
  });

  it('exactly ONE live region — no role=alert nested inside the polite container', () => {
    // An alert node inside the aria-live container is two live regions
    // announcing one insertion — double-spoken on some SR/browser pairs
    // (adversarial review of this batch). One region, one announcement.
    expect(TOAST).not.toContain("setAttribute('role', 'alert')");
  });

  it('the announced content is still the message text, not markup soup', () => {
    expect(TOAST).toContain('${esc(message)}');
  });
});

describe('the command palette paints mask icons, never raw emoji', () => {
  it('no pictographic character survives anywhere in the palette section', () => {
    expect(PALETTE).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('every row kind renders through dsIcon()', () => {
    expect(PALETTE).toContain('${dsIcon(v.i)}');
    expect(PALETTE).toContain('${dsIcon(t.i)}');
    expect(PALETTE).toContain("${dsIcon('play')}");   // Run Profile rows
    expect(PALETTE).toContain("${dsIcon('search')}"); // the search-box glyph
  });

  it('filtering still matches label/desc only — icon names are invisible to search', () => {
    expect(PALETTE).toContain('v.label.toLowerCase().includes(q) || v.desc.toLowerCase().includes(q)');
    expect(PALETTE).not.toMatch(/[vt]\.i\.toLowerCase/);
  });
});

// One feature, one icon: the palette tables must agree with the surfaces
// that already committed to a glyph.
describe('palette icon names are pinned to their counterparts', () => {
  const entryRe = kind =>
    new RegExp(`\\{ i: '([a-z-]+)',\\s*label: (?:'[^']*'|"[^"]*"),\\s*${kind}: '([a-z-]+)'`, 'g');

  const parseTable = (block, kind) => {
    const map = {};
    for (const m of block.matchAll(entryRe(kind))) map[m[2]] = m[1];
    return map;
  };

  const viewsBlock   = PALETTE.slice(PALETTE.indexOf('const CMD_VIEWS'),
                                     PALETTE.indexOf('const CMD_TOOLKIT'));
  const toolkitBlock = PALETTE.slice(PALETTE.indexOf('const CMD_TOOLKIT'),
                                     PALETTE.indexOf('async function openToolkit'));
  const cmdViews   = parseTable(viewsBlock, 'view');
  const cmdToolkit = parseTable(toolkitBlock, 'tab');

  it('both tables parsed completely', () => {
    expect(Object.keys(cmdViews).length).toBe(10);   // + Org health (campaign 3 phase 8)
    expect(Object.keys(cmdToolkit).length).toBe(7);   // Dependencies is a view of the Flows page (2026-10-17)
  });

  it('every CMD_VIEWS icon matches the same view\'s sidebar-nav icon', () => {
    const sidebar = {};
    for (const m of HTML.matchAll(/data-view="([a-z]+)"[^>]*>\s*<span class="ds-nav-icon ds-i" data-i="([a-z-]+)"/g)) {
      sidebar[m[1]] = m[2];
    }
    expect(Object.keys(sidebar).length).toBeGreaterThanOrEqual(9);
    for (const [view, name] of Object.entries(cmdViews)) {
      if (view === 'whatsnew') continue; // topbar control, checked below
      expect(name, `palette icon for view "${view}" must match its sidebar row`)
        .toBe(sidebar[view]);
    }
  });

  it('What\'s New wears the topbar megaphone', () => {
    expect(cmdViews.whatsnew).toBe('megaphone');
    expect(HTML).toMatch(/id="dsWhatsNewTop"[^>]*><span class="ds-glyph ds-i" data-i="megaphone"/);
  });

  it('every CMD_TOOLKIT icon matches the same feature in popup.js HOME_FEATURES', () => {
    const hf = POPUP.slice(POPUP.indexOf('const HOME_FEATURES'),
                           POPUP.indexOf('const HOME_SECTIONS'));
    const popupIcons = {};
    for (const m of hf.matchAll(/id: '([a-z-]+)',\s*i: '([a-z-]+)'/g)) popupIcons[m[1]] = m[2];
    expect(Object.keys(popupIcons).length).toBe(7);   // Org health left 2026-10-12; Dependencies merged into Flows 2026-10-17
    for (const [tab, name] of Object.entries(cmdToolkit)) {
      expect(name, `palette icon for toolkit tab "${tab}" must match HOME_FEATURES`)
        .toBe(popupIcons[tab]);
    }
  });

  it('every referenced mask name is defined in a glyph table', () => {
    const names = new Set([...Object.values(cmdViews), ...Object.values(cmdToolkit), 'play', 'search']);
    for (const name of names) {
      const sel = `[data-i="${name}"]`;
      expect(SHARED.includes(sel) || CSS.includes(sel),
        `no glyph-table entry for "${name}"`).toBe(true);
    }
  });
});
