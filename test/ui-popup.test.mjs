// Toolkit popup — visual-system regression guards for the home grid and the
// shared shell (top bar, sidebar, org chip, section headers).
//
// The audit measured this screen at: 15 distinct emoji standing in for icons,
// six different icon-chip tints authored inline by popup.js, 11 distinct font
// sizes, five button radii, two topbar control heights — and 772px of home
// content in a 621px box, which sliced the Data Studio call-to-action in half.
//
// These are SOURCE assertions, not rendering assertions: the extension has no
// build step and `npm test` has no DOM harness. They pin the invariants that
// made the screen incoherent, so a future edit that reintroduces an
// emoji-as-icon, an inline colour or a single-column list fails here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunctions } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');

const HTML = read('popup.html');
const JS   = read('popup.js');
const CSS  = read('styles.css');

// ── Slices ───────────────────────────────────────────────────────────────
// popup.html and popup.js also carry seven other tools' markup, so every
// assertion below is bounded to the shell/home slice it is about. Each pair
// of anchors is checked before use: a silently-empty slice would let every
// assertion pass for the wrong reason.
function slice(src, from, to, what) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  expect(a, `${what}: start anchor "${from}" not found`).toBeGreaterThan(-1);
  expect(b, `${what}: end anchor "${to}" not found`).toBeGreaterThan(a);
  return src.slice(a, b);
}

// Top bar + sidebar: everything in popup.html that is chrome rather than a
// tool's own body.
const SHELL_HTML = slice(HTML, '<div class="app-topbar">', '</nav>', 'shell html');
// The feature table and the function that renders the home grid.
const FEATURES   = slice(JS, 'const HOME_FEATURES = [', '// Feature sections', 'HOME_FEATURES');
const RENDER     = slice(JS, 'function renderHomePage() {', '// ── Org selector dropdown', 'renderHomePage');
// The popup's own CSS, bounded at both ends on the section banners so the
// debugger's layer and the other tools' rules can neither satisfy nor break
// anything here.
const ICONS      = slice(CSS, 'POPUP SHELL ICON LAYER', 'HOME PAGE', 'icon layer');
const HOME_CSS   = slice(CSS, 'HOME PAGE', '   Toolbar', 'home css');
const TOPBAR_CSS = slice(CSS, 'POPUP TOP BAR — one control height', 'Topbar Org Chip', 'topbar css');

// Emoji plus the dingbats/arrows/geometrics that were doing icon duty here
// (▾ › → ↗ are not pictographic but were all standing in for icons).
const ICONISH = /\p{Extended_Pictographic}|[←-⇿⌀-⏿■-◿⬀-⯿✀-➿]/gu;

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

describe('icons are masks, not emoji', () => {
  it('no emoji-as-icon survives in the popup shell markup', () => {
    expect(stripComments(SHELL_HTML).match(ICONISH) || []).toEqual([]);
  });

  it('no emoji-as-icon survives in the home feature table or its renderer', () => {
    expect(stripComments(FEATURES).match(ICONISH) || []).toEqual([]);
    expect(stripComments(RENDER).match(ICONISH) || []).toEqual([]);
  });

  it('the icon system paints with currentColor, so it inherits the theme', () => {
    expect(ICONS).toContain('background-color: currentColor');
    expect(ICONS).toMatch(/-webkit-mask-image: var\(--adbg-icon\)/);
    expect(ICONS).toMatch(/mask-image: var\(--adbg-icon\)/);
  });

  it('reuses the debugger mask table rather than starting a second dialect', () => {
    // Names the popup consumes that the Apex Debugger layer already defines.
    // If this ever fails it means the shared table moved, not that the popup
    // needs its own copy.
    const DEBUGGER_LAYER = CSS.slice(CSS.indexOf('APEX DEBUGGER — DESIGN REFRESH LAYER'));
    for (const name of ['popout', 'chevron', 'refresh', 'gear']) {
      expect(DEBUGGER_LAYER, `[data-i="${name}"] should come from the shared table`)
        .toContain(`[data-i="${name}"]`);
      expect(ICONS, `${name} must not be redefined in the popup layer`)
        .not.toContain(`[data-i="${name}"]`);
    }
  });

  it('every icon name the popup asks for has a mask defined somewhere in the table', () => {
    const used = new Set();
    for (const m of HTML.matchAll(/data-i="([a-z-]+)"/g)) used.add(m[1]);
    for (const m of JS.matchAll(/data-i="\$\{escHtml\(([\w.]+)\)\}"/g)) void m; // dynamic, covered below
    for (const m of JS.matchAll(/\bi: '([a-z-]+)'/g)) used.add(m[1]);
    for (const m of JS.matchAll(/dataset\.i = on \? '([a-z-]+)' : '([a-z-]+)'/g)) { used.add(m[1]); used.add(m[2]); }
    for (const m of JS.matchAll(/data-i="([a-z-]+)"/g)) used.add(m[1]);

    expect(used.size).toBeGreaterThan(15);          // the table is actually in use
    const missing = [...used].filter(n => !CSS.includes(`[data-i="${n}"]`));
    expect(missing).toEqual([]);
  });

  it('the one button whose label JS rewrites carries its glyph on the button', () => {
    // debug-modal.js does `btn.textContent = 'Debug' | '5' | '5 ⚠'`, which
    // would delete a child <span> icon on every refresh.
    const DBG = read('debug-modal.js');
    expect(DBG).not.toMatch(/textContent = `?'?🐛/u);
    expect(CSS).toContain('#dbgBtn::before');
    expect(CSS).toMatch(/#dbgBtn \{ --adbg-icon:/);
  });
});

describe('the home grid fits — the Data Studio banner is no longer cut in half', () => {
  it('tool cards are laid out as a multi-column grid, not one long column', () => {
    const cards = HOME_CSS.slice(HOME_CSS.indexOf('.home-section-cards {'));
    expect(cards.slice(0, 260)).toContain('display: grid');
    expect(cards.slice(0, 260)).toMatch(/grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  });

  it('the narrow popup gets a density step, not a different layout', () => {
    // Chrome caps the action popup at 800x600; body min-width is 780px.
    expect(HOME_CSS).toMatch(/@media \(max-width: 1023px\)/);
    const compact = HOME_CSS.slice(HOME_CSS.indexOf('@media (max-width: 1023px)'));
    expect(compact).toContain('--home-gutter');
    // Same three columns at both sizes — the media query must not re-stack.
    expect(compact).not.toContain('grid-template-columns');
  });

  it('the header card and the card grid share one gutter, so their edges line up', () => {
    expect(HOME_CSS).toContain('max-width: calc(var(--home-w) - var(--home-gutter) * 2)');
    expect(HOME_CSS).toMatch(/\.home-sections \{[^}]*padding: var\(--home-gutter\)/s);
  });
});

describe('one icon treatment, no inline colour', () => {
  it('the feature table carries an icon NAME, not an emoji and a hex', () => {
    expect(FEATURES).not.toMatch(/\bicon:/);
    expect(FEATURES).not.toMatch(/\bcolor:/);
    expect((FEATURES.match(/\bi: '[a-z-]+'/g) || []).length).toBe(8);
  });

  it('the home renderer emits no inline style attributes at all', () => {
    expect(RENDER).not.toMatch(/style="/);
  });

  it('all eight tools share one icon chip treatment', () => {
    const chip = HOME_CSS.slice(HOME_CSS.indexOf('.home-card-icon {'),
                                HOME_CSS.indexOf('.home-card-body'));
    expect(chip).toContain('background: var(--c-surface-sunk)');
    expect(chip).toContain('color: var(--c-text-muted)');
    // No !important anywhere: the old inline tints are gone from the source,
    // so nothing has to be fought.
    expect(chip).not.toContain('!important');
  });

  it('the tool grid is entirely neutral — the CTA is the only brand fill in it', () => {
    // Everything from the section header down to the last card. If a tool
    // card ever fills itself with brand, eight of them will and the page
    // stops having a primary action.
    const grid = HOME_CSS.slice(HOME_CSS.indexOf('.home-section-title {'),
                                HOME_CSS.indexOf('/* ── Data Studio CTA'));
    expect(grid).not.toMatch(/background: var\(--c-brand\)\s*;/);
    expect(HOME_CSS.slice(HOME_CSS.indexOf('.home-studio-btn {'), HOME_CSS.indexOf('.home-studio-btn:hover')))
      .toContain('background: var(--c-brand)');
  });
});

describe('the top bar pins one control height', () => {
  it('every topbar control is 28px on one radius', () => {
    expect(TOPBAR_CSS).toMatch(/height: 28px/);
    expect(TOPBAR_CSS).toContain('border-radius: var(--r-sm)');
    expect(TOPBAR_CSS).toContain('white-space: nowrap');
  });

  it('icon-only topbar controls are squares, not stubby pills', () => {
    expect(TOPBAR_CSS).toMatch(/#sftkDarkToggle \{ width: 28px; padding: 0; \}/);
  });

  it('is scoped, so the Data Studio top bar that shares .dbg-btn is untouched', () => {
    // studio.html reuses .dbg-btn and #dbgBtn. Every rule in this block has
    // to be qualified by .app-topbar or it would restyle a screen this pass
    // does not own.
    const rules = TOPBAR_CSS.match(/^[.#][^{]*\{/gm) || [];
    const unscoped = rules
      .map(r => r.trim())
      .filter(r => !r.startsWith('.app-topbar') && !r.startsWith('.topbar-sep'));
    expect(unscoped).toEqual([]);
  });
});

describe('accessible names — an icon-only control must still announce itself', () => {
  it('every icon-only button in the shell has an aria-label', () => {
    const iconOnly = [...SHELL_HTML.matchAll(/<button\b[\s\S]*?<\/button>/g)]
      .map(m => m[0])
      .filter(b => {
        const inner = b.slice(b.indexOf('>') + 1, b.lastIndexOf('</button>'));
        // Strip icon spans and the What's New badge slot; what's left is the
        // visible label, if any.
        return inner
          .replace(/<span[^>]*data-i="[a-z-]+"[^>]*><\/span>/g, '')
          .replace(/<span id="dsWhatsNewBadge"><\/span>/g, '')
          .trim() === '';
      });
    expect(iconOnly.length).toBeGreaterThan(1);
    expect(iconOnly.filter(b => !/aria-label=/.test(b))).toEqual([]);
  });

  it('decorative icons are hidden from assistive tech', () => {
    const spans = [...HTML.matchAll(/<span[^>]*\sdata-i="[a-z-]+"[^>]*>/g)].map(m => m[0]);
    expect(spans.length).toBeGreaterThan(10);
    expect(spans.filter(s => !s.includes('aria-hidden="true"'))).toEqual([]);
    const jsSpans = [...RENDER.matchAll(/<span[^>]*data-i=[^>]*>/g)].map(m => m[0]);
    expect(jsSpans.length).toBeGreaterThan(2);
    expect(jsSpans.filter(s => !s.includes('aria-hidden="true"'))).toEqual([]);
  });

  it('the org header names the org and the action, not just a glyph', () => {
    expect(RENDER).toContain('aria-label="${escHtml(orgLabel)}"');
    expect(RENDER).toMatch(/Connected org \$\{orgShort\}, \$\{orgHost\}\. Session active\. Switch org/);
    expect(RENDER).toContain('aria-haspopup="true"');
  });

  it('the dark-mode toggle keeps a name when its glyph changes', () => {
    const init = slice(JS, 'function initDarkTheme()', 'function setupTabs()', 'initDarkTheme');
    // The glyph is an attribute swap on a child span. It used to be
    // `btn.textContent = '🌙'`, which made the button's whole accessible
    // name "crescent moon".
    expect(init).not.toMatch(/btn\.textContent/);
    expect(init).toContain("icon.dataset.i = on ? 'sun' : 'moon'");
    expect(init).toContain("btn.setAttribute('aria-label', label)");
  });
});

describe('the status the org card asserts is carried by words, not colour', () => {
  it('the connected-org badge is labelled, not a bare green dot', () => {
    expect(RENDER).toContain('>Session active<');
    const badge = HOME_CSS.slice(HOME_CSS.indexOf('.home-org-status {'),
                                 HOME_CSS.indexOf('.home-org-chip-arrow {'));
    expect(badge).toContain('var(--c-good-fg)');
    expect(badge).toContain('var(--c-good-bg)');
  });

  it('the org list still distinguishes a live session from stored credentials', () => {
    // The dot used to be two raw hexes set inline; the two states have to
    // survive the move to classes or the list would lose information.
    expect(JS).toContain('home-org-dd-dot-live');
    expect(JS).toContain('home-org-dd-dot-stored');
    expect(CSS).toContain('.home-org-dd-dot-live   { background: var(--c-good-fg); }');
    expect(CSS).toContain('.home-org-dd-dot-stored { background: var(--c-text-faint); }');
  });
});

describe('the popup layer speaks the token vocabulary', () => {
  // The mask SVGs are black-on-transparent markup, not design values, so
  // they are stripped before either check below.
  const noMasks = stripComments(ICONS + HOME_CSS + TOPBAR_CSS)
    .replace(/url\("data:image\/svg\+xml,[^"]*"\)/g, '');

  it('declares no new base tokens — only consumes the existing families', () => {
    // A `--foo: <literal>` inside these blocks would be a new base value.
    // The layer may declare --adbg-icon (a mask URL) and the two layout
    // knobs the home page reads back from itself.
    const declared = [...noMasks.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map(m => m[1]);
    expect(declared.length).toBeGreaterThan(15);
    expect(new Set(declared)).toEqual(new Set(['--adbg-icon', '--home-gutter', '--home-gap']));
  });

  it('no raw hex colours', () => {
    expect(noMasks.match(/#[0-9A-Fa-f]{3,8}\b/g) || []).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
// Field Cleaner object picker — Salesforce's shadow objects are noise
// (user 2026-07-30: "why do we see all the missing labels? its a noise.
// who use these objects? do we need to show them?"). Salesforce creates
// <X>Feed / <X>Share / <X>History / <X>ChangeEvent per feature and ships
// them with unresolved labels, which render literally as
// "__MISSING LABEL__ PropertyFile - val X not found in section …".
// None hold cleanable custom fields, and they filled the dropdown before
// a single real object appeared.
// ══════════════════════════════════════════════════════════════════
describe('fcIsSystemShadowObject / fcPartitionObjects', () => {
  const { fcIsSystemShadowObject, fcPartitionObjects } =
    extractFunctions('field-cleaner.js', ['fcIsSystemShadowObject', 'fcPartitionObjects']);

  it('flags every shadow-object suffix', () => {
    for (const api of ['ActivityFeed', 'AccountShare', 'OpportunityFieldHistory',
                       'AccountHistory', 'AccountChangeEvent', 'ContactTag']) {
      expect(fcIsSystemShadowObject(api, 'whatever'), api).toBe(true);
    }
  });

  it('flags a broken label even when the API name looks ordinary', () => {
    expect(fcIsSystemShadowObject('SomeThing__c',
      '__MISSING LABEL__ PropertyFile - val Activity not found in section StandardFeedLabel')).toBe(true);
  });

  it('does NOT flag the real objects an admin cleans', () => {
    for (const api of ['Account', 'Contact', 'Opportunity', 'My_Object__c',
                       'FinServ__FinancialAccount__c', 'Order']) {
      expect(fcIsSystemShadowObject(api, 'Label'), api).toBe(false);
    }
  });

  it('does not over-match names that merely CONTAIN a suffix word', () => {
    // "…Feed" only at the END; a Feedback object is a real custom object.
    expect(fcIsSystemShadowObject('Feedback__c', 'Feedback')).toBe(false);
    expect(fcIsSystemShadowObject('ShareholderReport__c', 'Shareholder Report')).toBe(false);
    expect(fcIsSystemShadowObject('HistoryLog__c', 'History Log')).toBe(false);
  });

  it('partition hides them by default and counts what it hid', () => {
    const list = [
      { api: 'Account', label: 'Account' },
      { api: 'ActivityFeed', label: '__MISSING LABEL__ PropertyFile - val Activity not found' },
      { api: 'AccountShare', label: 'Account Share' },
      { api: 'My_Object__c', label: 'My Object' },
    ];
    const hidden = fcPartitionObjects(list, false);
    expect(hidden.shown.map(o => o.api)).toEqual(['Account', 'My_Object__c']);
    expect(hidden.hidden).toBe(2);
  });

  it('showAll returns everything and reports nothing hidden', () => {
    const list = [{ api: 'Account', label: 'A' }, { api: 'ActivityFeed', label: 'F' }];
    const all = fcPartitionObjects(list, true);
    expect(all.shown).toHaveLength(2);
    expect(all.hidden).toBe(0);
  });

  it('survives junk input', () => {
    expect(fcPartitionObjects(null, false)).toEqual({ shown: [], hidden: 0 });
    expect(fcIsSystemShadowObject(null, null)).toBe(false);
  });
});

// The Popout button is gone (user 2026-07-30: "i dont want the popout feature
// on the toolkit. its anoying and doesn't work good"). Clicking the extension
// icon already opens the Toolkit as a full tab, so a button that conjured a
// second chromeless window was a redundant path — and Data Studio's back
// button used the same mechanism, so it opens a plain tab now too.
describe('the popout feature is removed, not just hidden', () => {
  const HTML_ = readFileSync(join(root, 'popup.html'), 'utf8');
  const JS_   = readFileSync(join(root, 'popup.js'), 'utf8');
  const CORE_ = readFileSync(join(root, 'studio-core.js'), 'utf8');

  it('no button, no handler, no dead listener left behind', () => {
    expect(HTML_).not.toContain('popoutBtn');
    expect(JS_).not.toContain('popoutBtn');
    expect(JS_).not.toContain('?popout=1');
  });

  it('Data Studio opens the Toolkit as a TAB, never a chromeless window', () => {
    expect(CORE_).toMatch(/async function openToolkit\(/);
    expect(CORE_).not.toMatch(/openToolkitPopout/);
    // The whole point: no windows.create at all. (Matching on `type:'popup'`
    // caught the COMMENT that explains the removal — assert on the API call,
    // which prose cannot accidentally satisfy.)
    expect(CORE_).not.toMatch(/chrome\.windows\.create/);
    expect(CORE_).toMatch(/chrome\.tabs\.create\(\{ url: `\$\{base\}/);
  });

  it('deep-linking to a feature still works (?tab= survives)', () => {
    expect(CORE_).toMatch(/\?tab=\$\{encodeURIComponent\(tab\)\}/);
    expect(JS_).toMatch(/TOOLKIT_NAVIGATE|[?&]tab=/);
  });
});

// ══════════════════════════════════════════════════════════════════
// QA 2026-07-31 accessibility fixes. Field Cleaner shipped with FIVE
// mousedown handlers, ZERO keydown handlers and no tabindex — the whole
// feature was mouse-only, and the a11y sweep had missed the file. The
// popup modal, which confirms FLOW DELETION, had no dialog semantics,
// no Escape and no focus trap.
// ══════════════════════════════════════════════════════════════════
describe('Field Cleaner is keyboard-operable', () => {
  const FC = readFileSync(join(root, 'field-cleaner.js'), 'utf8');

  it('ships a keyboard layer for the dropdown pickers', () => {
    expect(FC).toMatch(/function fcWireDropdownKeys\(/);
    expect(FC).toMatch(/addEventListener\('keydown'/);
  });

  it('handles the full combobox key set', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Escape']) {
      expect(FC, `${key} must be handled`).toContain(`'${key}'`);
    }
  });

  it('both pickers are wired, not just one', () => {
    expect(FC).toMatch(/fcWireDropdownKeys\(eid\('fcObjInput'\)/);
    expect(FC).toMatch(/fcWireDropdownKeys\(eid\('fcFieldInput'\)/);
  });

  it('announces itself as a combobox with an active option', () => {
    expect(FC).toMatch(/setAttribute\('role', 'combobox'\)/);
    expect(FC).toMatch(/aria-activedescendant/);
    expect(FC).toMatch(/aria-expanded/);
  });

  it('the system-object toggle is a real button, reachable by Enter', () => {
    // It was an <a href="#"> wired to mousedown only, so Enter did nothing.
    expect(FC).not.toMatch(/<a href="#" id="fcShowSysObjs"/);
    expect(FC).toMatch(/<button type="button" class="fc-dd-linkbtn" id="fcShowSysObjs"/);
    expect(FC).toMatch(/addEventListener\('click', toggleSys\(show\)\)/);
  });
});

describe('the popup modal is a real dialog', () => {
  const JS = readFileSync(join(root, 'popup.js'), 'utf8');

  it('declares dialog semantics and names itself from its heading', () => {
    expect(JS).toMatch(/setAttribute\('role', 'dialog'\)/);
    expect(JS).toMatch(/setAttribute\('aria-modal', 'true'\)/);
    expect(JS).toMatch(/aria-labelledby/);
  });

  it('Escape closes it and Tab is trapped inside', () => {
    expect(JS).toMatch(/e\.key === 'Escape'/);
    expect(JS).toMatch(/e\.key !== 'Tab'/);
    expect(JS).toMatch(/shiftKey/);
  });

  it('focus moves in on open and returns on close', () => {
    expect(JS).toMatch(/_modalRestoreFocus = document\.activeElement/);
    expect(JS).toMatch(/_modalRestoreFocus\?\.focus\?\.\(\)/);
  });

  it('initial focus avoids the destructive control', () => {
    // Enter must never land on Delete just because it was rendered first.
    expect(JS).toMatch(/delete\|remove\|destructive\|danger/);
  });

  it('the keydown listener is removed on close (no leak across modals)', () => {
    expect(JS).toMatch(/removeEventListener\('keydown', _modalKeyHandler, true\)/);
  });
});
