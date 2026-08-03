// Popup a11y wiring — the three state surfaces a screen reader could not
// perceive: the activity bar (status text rewritten and auto-cleared with no
// live region), the sidebar (eight identical buttons with no aria-current),
// and the org chips (aria-haspopup with no aria-expanded).
//
// These are SOURCE assertions, not rendering assertions: the extension has no
// build step and `npm test` has no DOM harness. They pin the attributes and
// the JS paths that maintain them, so a refactor that drops one side of a
// pair (visual state without ARIA state, or an open path without its close
// path) fails here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');

const HTML = read('popup.html');
const JS   = read('popup.js');

// Bounded slices, anchors verified before use — a silently-empty slice would
// let every assertion below pass for the wrong reason.
function slice(src, from, to, what) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  expect(a, `${what}: start anchor "${from}" not found`).toBeGreaterThan(-1);
  expect(b, `${what}: end anchor "${to}" not found`).toBeGreaterThan(a);
  return src.slice(a, b);
}

const ACT_BAR   = slice(HTML, '<div id="activityBar"', '<div id="modalOverlay"', 'activity bar');
const NAV       = slice(HTML, '<nav class="app-sidebar">', '</nav>', 'sidebar nav');
const NAV_FN    = slice(JS, 'function navigateToTab(', 'function showHomePage', 'navigateToTab');
const HOME_FN   = slice(JS, 'function showHomePage', '// ── Render the full home page', 'showHomePage');
const HOME_CHIP = slice(JS, '<button class="home-org-chip-btn" id="homeOrgSelector"', '</button>', 'home org chip template');
const HOME_DD   = slice(JS, "getElementById('homeOrgSelector')?.addEventListener", '// ── Eager background preload', 'home org dropdown handler');
const TOPBAR_DD = slice(JS, 'function openTopbarOrgDropdown', 'function initTopbarOrgChip', 'topbar org dropdown');

const count = (src, needle) => src.split(needle).length - 1;

describe('activity bar is a live region', () => {
  it('.act-body announces politely, atomically, as a status role', () => {
    expect(ACT_BAR).toMatch(
      /<div class="act-body" role="status" aria-live="polite" aria-atomic="true">/);
  });

  it('#actMsg (the text popup.js rewrites) sits inside the live element', () => {
    expect(ACT_BAR.indexOf('role="status"')).toBeGreaterThan(-1);
    expect(ACT_BAR.indexOf('id="actMsg"')).toBeGreaterThan(ACT_BAR.indexOf('role="status"'));
  });

  it('the colour-only state dot is hidden from assistive tech', () => {
    expect(ACT_BAR).toMatch(/<span id="actDot"[^>]*aria-hidden="true"/);
  });
});

describe('sidebar active tab carries aria-current', () => {
  it('popup.html ships no static aria-current — launch state is home, no tab active', () => {
    expect(NAV).not.toContain('aria-current');
  });

  it('navigateToTab sets aria-current="page" on the same button it marks .active', () => {
    expect(NAV_FN).toMatch(
      /btn\.classList\.add\('active'\); btn\.setAttribute\('aria-current', 'page'\)/);
  });

  it('navigateToTab clears aria-current from every button before activating one', () => {
    expect(NAV_FN).toContain("b.classList.remove('active')");
    expect(NAV_FN).toContain("b.removeAttribute('aria-current')");
  });

  it('showHomePage clears aria-current along with the .active class', () => {
    expect(HOME_FN).toContain("b.classList.remove('active')");
    expect(HOME_FN).toContain("b.removeAttribute('aria-current')");
  });
});

describe('org chips expose dropdown open state', () => {
  it('every aria-haspopup button in popup.html and popup.js also ships aria-expanded', () => {
    for (const src of [HTML, JS]) {
      const tags = src.match(/<button[^>]*aria-haspopup[^>]*>/g) || [];
      expect(tags.length, 'expected at least one aria-haspopup button').toBeGreaterThan(0);
      for (const tag of tags) expect(tag).toContain('aria-expanded="false"');
    }
  });

  it('the topbar chip pairs aria-haspopup with a closed initial aria-expanded', () => {
    const tag = HTML.match(/<button id="topbarOrgChip"[^>]*>/)?.[0] || '';
    expect(tag).toContain('aria-haspopup="true"');
    expect(tag).toContain('aria-expanded="false"');
  });

  it('the home org chip template pairs aria-haspopup with a closed initial aria-expanded', () => {
    expect(HOME_CHIP).toContain('aria-haspopup="true"');
    expect(HOME_CHIP).toContain('aria-expanded="false"');
  });

  it('the home dropdown handler opens once and closes in both close paths', () => {
    expect(count(HOME_DD, "setAttribute('aria-expanded', 'true')")).toBe(1);
    // Toggle-close on re-click plus closeDropdown (item pick / outside click).
    expect(count(HOME_DD, "setAttribute('aria-expanded', 'false')")).toBeGreaterThanOrEqual(2);
  });

  it('the topbar dropdown handler opens once and closes in both close paths', () => {
    expect(count(TOPBAR_DD, "setAttribute('aria-expanded', 'true')")).toBe(1);
    expect(count(TOPBAR_DD, "setAttribute('aria-expanded', 'false')")).toBeGreaterThanOrEqual(2);
  });

  it('aria-expanded state rides the same paths as the visual .open class on the topbar chip', () => {
    expect(count(TOPBAR_DD, "chip.classList.add('open')"))
      .toBe(count(TOPBAR_DD, "setAttribute('aria-expanded', 'true')"));
    expect(count(TOPBAR_DD, "chip.classList.remove('open')"))
      .toBe(count(TOPBAR_DD, "setAttribute('aria-expanded', 'false')"));
  });
});
