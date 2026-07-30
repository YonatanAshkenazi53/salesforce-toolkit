// Apex Debugger — visual-system regression guards.
//
// The debugger screen was the worst offender in the UI audit: 40 distinct
// emoji glyphs used as icons, a toolbar of six buttons at five different
// heights, four of six primary actions coloured as destructive, and a
// flagship data table with no header, no hover and left-aligned numbers.
//
// These are SOURCE assertions, not rendering assertions — the extension has
// no build step and no DOM harness in `npm test`. They pin the invariants
// that made the screen incoherent, so a future edit that reintroduces an
// emoji-as-icon or a second brand-filled primary fails here instead of in a
// store review.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');

const DEBUGGER = read('apex-debugger.js');
const VIEWER   = read('apex-log-viewer.js');
const VIEWER_H = read('apex-log-viewer.html');
const CSS      = read('styles.css');

// The debugger's own slice of styles.css — bounded at BOTH ends on the
// section banners, so assertions below cannot accidentally pass (or fail)
// because of some other tool's rules.
const REFRESH = CSS.slice(
  CSS.indexOf('APEX DEBUGGER — DESIGN REFRESH LAYER'),
  CSS.indexOf('Flow Permissions module', CSS.indexOf('APEX DEBUGGER — DESIGN REFRESH LAYER')),
);

// Emoji + the dingbat/arrow/geometric glyphs that were being used as icons.
// Deliberately NOT a bare \p{Extended_Pictographic}: ✕ ▾ ↕ ⛶ are not
// pictographic but were doing icon duty all the same.
const ICONISH = /\p{Extended_Pictographic}|[←-⇿⌀-⏿■-◿⬀-⯿✀-➿]/gu;

// Strip // and /* */ comments so prose about the old glyphs (and the ── box
// rules this codebase draws its section banners with) is not scanned.
// The `(^|\s)//` anchor is deliberate: it catches trailing comments
// (`let x = {};   // logId → parsed result`) without eating the `//` inside
// a `https://` literal, where the slashes follow a colon.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

describe('icons are masks, not emoji', () => {
  it('no emoji-as-icon survives in the debugger UI code', () => {
    const found = stripComments(DEBUGGER).match(ICONISH) || [];
    expect(found).toEqual([]);
  });

  it('no emoji-as-icon survives in the standalone log viewer', () => {
    expect(stripComments(VIEWER).match(ICONISH) || []).toEqual([]);
    expect(stripComments(VIEWER_H).match(ICONISH) || []).toEqual([]);
  });

  it('the icon system paints with currentColor, so it inherits the theme', () => {
    expect(REFRESH).toContain('background-color: currentColor');
    expect(REFRESH).toMatch(/-webkit-mask-image: var\(--adbg-icon\)/);
    expect(REFRESH).toMatch(/mask-image: var\(--adbg-icon\)/);
  });

  it('every data-i / data-adbg-icon name used by the JS has a mask defined', () => {
    const used = new Set();
    for (const m of DEBUGGER.matchAll(/data-i="([a-z-]+)"/g))          used.add(m[1]);
    for (const m of DEBUGGER.matchAll(/data-adbg-icon="([a-z-]+)"/g))  used.add(m[1]);
    for (const m of DEBUGGER.matchAll(/_ICON\('([a-z-]+)'\)/g))        used.add(m[1]);
    for (const m of DEBUGGER.matchAll(/adbgIcon = '([a-z-]+)'/g))      used.add(m[1]);
    for (const m of VIEWER.matchAll(/adbgIcon = '([a-z-]+)'/g))        used.add(m[1]);
    for (const m of VIEWER_H.matchAll(/data-i="([a-z-]+)"/g))          used.add(m[1]);
    for (const m of VIEWER_H.matchAll(/data-adbg-icon="([a-z-]+)"/g))  used.add(m[1]);

    expect(used.size).toBeGreaterThan(20);   // the table is actually in use
    const missing = [...used].filter(n => !REFRESH.includes(`[data-i="${n}"]`));
    expect(missing).toEqual([]);
  });

  it('buttons whose label JS rewrites carry the glyph as an ATTRIBUTE', () => {
    // A child <span> icon would be destroyed by `btn.textContent = '…'`.
    // Every id below is written by a textContent assignment somewhere.
    for (const id of ['adbgStartBtn', 'adbgStopBtn', 'adbgXSearchBtn',
                      'adbgPurgeOldBtn', 'adbgDelAllBtn', 'adbgDelSelBtn',
                      'adbgCopyReportBtn']) {
      const tag = DEBUGGER.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
      expect(tag, `${id} button tag not found`).toBeTruthy();
      expect(tag[0], `${id} must use data-adbg-icon`).toContain('data-adbg-icon=');
      expect(tag[0], `${id} must not carry a child-span icon`).not.toContain('class="adbg-i"');
    }
  });
});

describe('button hierarchy — one height, one primary, red means destructive', () => {
  it('the debugger pins a single control height', () => {
    const rule = REFRESH.slice(REFRESH.indexOf('.adbg-wrap .btn,'));
    expect(rule.slice(0, 400)).toMatch(/height: 28px/);
    expect(rule.slice(0, 400)).toMatch(/white-space: nowrap/);   // no 2-line labels
  });

  it('exactly one brand-filled primary in the log toolbar and one in the detail panel', () => {
    const shell = DEBUGGER.slice(DEBUGGER.indexOf('function _renderShell'),
                                 DEBUGGER.indexOf('function _wireEvents'));
    expect((shell.match(/btn-primary/g) || [])).toHaveLength(0);   // toolbar primary is #adbgStartBtn, styled by id
    expect(REFRESH).toContain('.adbg-wrap #adbgStartBtn');

    const actions = DEBUGGER.slice(DEBUGGER.indexOf('<div class="adbg-det-actions">'),
                                   DEBUGGER.indexOf('</div>', DEBUGGER.indexOf('adbgNewTabBtn')));
    expect((actions.match(/btn-primary/g) || [])).toHaveLength(1);
  });

  it('only the two data-destroying buttons are red', () => {
    const bar = DEBUGGER.slice(DEBUGGER.indexOf('<div class="adbg-log-bar">'),
                               DEBUGGER.indexOf('<div class="adbg-split">'));
    const danger = [...bar.matchAll(/<button[^>]*btn-danger[^>]*id="(\w+)"|<button[^>]*id="(\w+)"[^>]*btn-danger/g)]
      .map(m => m[1] || m[2]);
    expect(new Set(danger)).toEqual(new Set(['adbgDelSelBtn', 'adbgDelAllBtn']));
    // Search and the >24h purge are explicitly NOT destructive-coloured.
    expect(bar).toMatch(/id="adbgXSearchBtn"[^>]*btn-secondary|btn-secondary[^>]*id="adbgXSearchBtn"/);
    expect(bar).toMatch(/id="adbgPurgeOldBtn"[^>]*btn-secondary|btn-secondary[^>]*id="adbgPurgeOldBtn"/);
  });
});

describe('the log list is a table', () => {
  it('renders a real header row above the rows', () => {
    expect(DEBUGGER).toContain('class="adbg-list-hdr"');
    expect(DEBUGGER).toContain('listEl.innerHTML = listHdr +');
    expect(DEBUGGER).toContain('>Operation<');
    expect(DEBUGGER).toContain('>Size<');
    expect(DEBUGGER).toContain('>Duration<');
  });

  it('numeric columns are right-aligned with tabular figures', () => {
    const numeric = REFRESH.slice(REFRESH.indexOf('.adbg-row-size,'),
                                  REFRESH.indexOf('.adbg-row-op {'));
    expect(numeric).toContain('font-variant-numeric: tabular-nums');
    expect(numeric).toContain('text-align: right');
    expect(REFRESH).toMatch(/\.adbg-list-hdr-num \{ text-align: right; \}/);
  });

  it('rows have a hover state (the audit found the flagship table had none)', () => {
    expect(REFRESH).toMatch(/\.adbg-log-row:hover \{ background: var\(--c-surface-sunk\); \}/);
  });

  it('header and row share one column geometry, so the labels sit over the data', () => {
    const hdrCols = REFRESH.match(/grid-template-columns: 16px 1fr (\d+)px (\d+)px 24px/);
    expect(hdrCols).toBeTruthy();
    expect(REFRESH).toContain(`.adbg-row-size { margin-left: auto; width: ${hdrCols[1]}px; }`);
    expect(REFRESH).toContain(`.adbg-row-dur  { width: ${hdrCols[2]}px; }`);
  });
});

describe('accessible names — an icon-only control must still announce itself', () => {
  it('every icon-only button in the debugger has an aria-label', () => {
    // Buttons whose markup has no text between > and </button> other than
    // icon spans / nothing at all.
    const iconOnly = [...DEBUGGER.matchAll(/<button\b[\s\S]*?<\/button>/g)]
      .map(m => m[0])
      .filter(b => {
        const inner = b.slice(b.indexOf('>') + 1, b.lastIndexOf('</button>'));
        return inner.replace(/<span[^>]*class="adbg-i"[^>]*><\/span>/g, '').trim() === '';
      });
    expect(iconOnly.length).toBeGreaterThan(4);
    const unnamed = iconOnly.filter(b => !/aria-label=/.test(b));
    expect(unnamed).toEqual([]);
  });

  it('decorative icons are hidden from assistive tech', () => {
    const spans = DEBUGGER.match(/<span class="adbg-i"[^>]*>/g) || [];
    expect(spans.length).toBeGreaterThan(10);
    expect(spans.filter(s => !s.includes('aria-hidden="true"'))).toEqual([]);
  });

  it('_ICON emits an aria-hidden span', () => {
    const helper = DEBUGGER.slice(DEBUGGER.indexOf('function _ICON('));
    expect(helper.slice(0, 220)).toContain('aria-hidden="true"');
  });

  it('the log-search modifiers stay in the tab order', () => {
    // They used to be `display: none`, which removes them from the a11y tree
    // and the tab order entirely — the toggles were mouse-only.
    const opt = REFRESH.slice(REFRESH.indexOf('.adbg-log-search-opt input {'));
    expect(opt.slice(0, 300)).not.toMatch(/display: none/);
    expect(opt.slice(0, 300)).toContain('clip-path: inset(50%)');
  });
});

describe('the visual layer speaks the token vocabulary', () => {
  it('introduces no new base tokens — only consumes the existing families', () => {
    // Any `--foo: <literal>` declaration inside the refresh layer would be a
    // new base value. The only custom property it may DECLARE is --adbg-icon
    // (a mask URL, which is markup, not a design value).
    const declared = [...REFRESH.matchAll(/^\s*(--[a-z0-9-]+):/gmi)].map(m => m[1]);
    expect(new Set(declared)).toEqual(new Set(['--adbg-icon']));
  });

  it('no raw hex colours in the refresh layer', () => {
    // Comments stripped first: several of them QUOTE the hexes this layer
    // replaced, which is the point of the comment.
    const decls = REFRESH.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(decls.match(/#[0-9a-f]{3,8}\b/gi) || []).toEqual([]);
  });
});
