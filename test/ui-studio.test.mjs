// Data Studio — visual-system regression guards.
//
// The SLDS audit's headline finding for this app was structural, not
// cosmetic: "no icon container, no record count, no header card — the single
// most recognizable Lightning shape is absent from all 13 views." Every view
// hand-rolled its own <h2>. On top of that the flagship screen (the Picklist
// Manager's multi-org matrix) carried meaning in colour alone, and the
// builder's source/targets row — the origin of two user bug reports — had no
// visual statement that records flow one way.
//
// Like test/ui-debugger.test.mjs these are SOURCE assertions, not rendering
// assertions: the extension has no build step and no DOM harness in
// `npm test`. They pin the invariants, so an edit that reintroduces a second
// icon dialect, a colour-only state, or a hand-rolled view header fails here
// rather than in a store review.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');

const CSS       = read('studio.css');
const HTML      = read('studio.html');
const CORE      = read('studio-core.js');
const BUILDER   = read('studio-builder.js');
const PICKLISTS = read('studio-picklists.js');
const PROFILES  = read('studio-profiles.js');
const RING      = read('studio-ring.js');
const SHARED    = read('styles.css');

// The Studio's own slice of studio.css, bounded at the section banner so an
// assertion can never pass because of some other block's rule.
const LAYER = CSS.slice(CSS.indexOf('DATA STUDIO — DESIGN REFRESH LAYER'));

describe('the shared view header exists and is actually shared', () => {
  it('studio-core ships ONE header builder, not a per-view copy', () => {
    expect(CORE).toMatch(/function dsViewHeader\(/);
    expect(CORE).toMatch(/const dsIcon = /);
  });

  it('the header renders the SLDS page-header parts: icon tile, title, count, actions', () => {
    const fn = CORE.slice(CORE.indexOf('function dsViewHeader('),
                          CORE.indexOf('// ── E4: Professional mode'));
    expect(fn).toContain('ds-vh-icon');
    expect(fn).toContain('ds-view-title');
    expect(fn).toContain('ds-vh-count');
    expect(fn).toContain('ds-vh-actions');
  });

  it('studio.css styles the header as a card with an icon container', () => {
    expect(LAYER).toMatch(/\.ds-view-header\.ds-vh\s*{/);
    expect(LAYER).toMatch(/\.ds-vh-icon\s*{[^}]*background:\s*var\(--c-brand\)/);
  });

  it('every view this pass owns goes through the builder — none hand-rolls a title', () => {
    // dsViewHeader itself emits the <h2>, so studio-core is measured with
    // the builder cut out — everything left is view code.
    const coreViews = CORE.slice(0, CORE.indexOf('function dsViewHeader('))
      + CORE.slice(CORE.indexOf('// ── E4: Professional mode'));
    for (const [name, src] of [['studio-core.js', coreViews], ['studio-builder.js', BUILDER],
                               ['studio-picklists.js', PICKLISTS], ['studio-profiles.js', PROFILES],
                               ['studio-ring.js', RING]]) {
      expect(src, `${name} should call dsViewHeader`).toMatch(/dsViewHeader\(\{/);
      expect(src, `${name} should not hand-roll <h2 class="ds-view-title">`)
        .not.toMatch(/<h2 class="ds-view-title">/);
    }
  });

  it('adoption stays opt-in — .ds-view-header alone keeps the old layout', () => {
    // The un-suffixed rule must still exist, otherwise the seven views this
    // pass did NOT touch would silently change shape.
    expect(CSS).toMatch(/\.ds-view-header\s*{/);
  });
});

describe('one icon dialect, shared with the Apex Debugger', () => {
  it('.ds-i consumes the debugger\'s --adbg-icon custom property', () => {
    const box = LAYER.slice(LAYER.indexOf('.ds-i {'), LAYER.indexOf('[data-i="plug"]'));
    expect(box).toContain('mask-image: var(--adbg-icon)');
    expect(box).toContain('background-color: currentColor');
  });

  it('the Studio adds glyphs to that ONE table rather than starting a second', () => {
    // Studio-only glyphs are declared against the same custom property...
    expect(LAYER).toMatch(/\[data-i="plug"\]\s*{\s*--adbg-icon:/);
    // ...and the debugger's table is what supplies the shared ones.
    expect(SHARED).toMatch(/\[data-i="check"\],\s*\[data-adbg-icon="check"\]/);
    // No second variable name anywhere in the Studio layer.
    expect(LAYER).not.toMatch(/--ds-icon\s*:/);
  });

  it('the sidebar nav paints masks, not emoji', () => {
    const nav = HTML.slice(HTML.indexOf('<nav class="ds-nav"'), HTML.indexOf('</nav>'));
    expect(nav).not.toMatch(/\p{Extended_Pictographic}/u);
    expect((nav.match(/class="ds-nav-icon ds-i" data-i="/g) || []).length).toBe(9);
  });

  it('the dark toggle carries its glyph as an ATTRIBUTE — its label is rewritten by JS', () => {
    // applyDarkMode does `btn.textContent = …`, which destroys a child span.
    expect(HTML).toMatch(/id="dsDarkToggle"[^>]*data-i="moon"/);
    expect(CORE).toMatch(/setAttribute\('data-i', on \? 'sun' : 'moon'\)/);
    expect(LAYER).toMatch(/\.ds-topbar \.ds-dark-toggle::before/);
  });
});

describe('the picklist matrix is a real table', () => {
  const render = PICKLISTS.slice(PICKLISTS.indexOf('function _pkRenderMatrix('),
                                 PICKLISTS.indexOf('function _pkMxSelectedValues('));

  it('the region under test was actually found', () => {
    expect(render).toContain('ds-pk-matrix');
  });

  it('the header row is a header: sunk surface, own border, title case', () => {
    const head = LAYER.slice(LAYER.indexOf('.ds-pk-mx-head {'), LAYER.indexOf('.ds-pk-mx-head .ds-pk-mx-val'));
    expect(head).toContain('background: var(--c-surface-sunk)');
    expect(head).toContain('border-bottom: 1px solid var(--c-border)');
    // Org names are proper nouns — uppercasing mangled "QA Sandbox".
    expect(head).toContain('text-transform: none');
  });

  it('rows hover, and the header does not', () => {
    expect(LAYER).toMatch(/\.ds-pk-mx-row:not\(\.ds-pk-mx-head\):hover/);
  });

  it('counts are right-aligned tabular figures in their own grid track', () => {
    const cnt = LAYER.slice(LAYER.indexOf('.ds-pk-mx-cnt {'), LAYER.indexOf('.ds-pk-mx-active'));
    expect(cnt).toContain('font-variant-numeric: tabular-nums');
    expect(cnt).toContain('text-align: right');
    expect(LAYER).toMatch(/\.ds-pk-mx-cell\s*{[^}]*grid-template-columns:\s*14px minmax\(0, 1fr\) auto/);
  });

  it('--pk-cols is still set inline by the renderer (the grid bug fix stays fixed)', () => {
    expect(render).toContain('style="--pk-cols:${cols.length}"');
    // …and no rule in this layer may re-declare the grid template for the
    // row/head, which is what --pk-cols parameterises.
    expect(LAYER).not.toMatch(/\.ds-pk-mx-(head|row)[^{]*{[^}]*grid-template-columns/);
  });

  it('EVERY cell state is distinguishable without colour', () => {
    // not loaded · / missing — / active ✓ / inactive ▮▮ — a shape each, plus
    // a spoken name for assistive tech.
    expect(render).toContain('<span class="ds-pk-mx-state" aria-hidden="true">·</span>');
    expect(render).toContain('<span class="ds-pk-mx-state" aria-hidden="true">—</span>');
    expect(render).toContain("dsIcon(cell.active ? 'check' : 'pause')");
    expect(render).toMatch(/class="ds-sr">\$\{cell\.active \? 'active' : 'inactive'\}/);
  });

  it('record-type DRIFT is an icon as well as a red chip', () => {
    expect(render).toMatch(/\$\{rtDrift \? dsIcon\('warn'\) : ''\}/);
  });

  it('the counts themselves are untouched — the numbers still mean what they meant', () => {
    // toLocaleString for real counts, ? for "unknown", '' for "not counted".
    expect(render).toContain("cell.count == null ? '' : cell.count === -1 ? '?' : cell.count.toLocaleString()");
    expect(render).toContain('${rti.inCount}/${rti.total} RT');
  });

  it('every icon-only control in the matrix has an accessible name', () => {
    expect(render).toContain('id="dsPkMxAll" aria-label="Select all values"');
    expect(render).toMatch(/class="ds-pk-mx-valchk"[^>]*aria-label="Select value/);
  });

  it('red stays reserved for the destructive action', () => {
    expect(render).toMatch(/ds-btn-danger" id="dsPkBulkDel"/);
    // Deactivate is reversible; it must not be red.
    expect(render).not.toMatch(/ds-btn-danger" id="dsPkBulkDeact"/);
  });
});

describe('the builder source → targets row states the direction', () => {
  const row = BUILDER.slice(BUILDER.indexOf('<div class="ds-builder-orgs-row">'),
                            BUILDER.indexOf('<div class="ds-builder-owner-row">'));

  it('the region under test was actually found', () => {
    expect(row).toContain('ds-builder-org-col');
  });

  it('the connector slot is ALWAYS filled — swap button when unlocked, arrow when locked', () => {
    expect(row).toContain('ds-builder-orgs-flow');
    expect(row).toContain("dsIcon('arrow-right')");
    expect(row).toMatch(/id="dsProfileSwapOrgs"/);
    // and the swap control kept its accessible name now that it is icon-only
    expect(row).toMatch(/id="dsProfileSwapOrgs" aria-label="Swap source and target orgs"/);
  });

  it('the two columns share one header treatment', () => {
    expect((row.match(/class="ds-lbl ds-bld-col-hd"/g) || []).length).toBe(2);
    expect(LAYER).toMatch(/\.ds-bld-col-hd\s*{/);
  });

  it('the LOCKED source row is legible, not 55%-opacity invisible', () => {
    expect(row).toContain('ds-pk-orgchk-locked');
    expect(row).toContain('ds-pk-lock-pill');
    const locked = LAYER.slice(LAYER.indexOf('.ds-pk-orgchk-locked,'));
    expect(locked.slice(0, 300)).toContain('opacity: 1');
  });

  it('the row is a grid with a real middle track, not two floating columns', () => {
    expect(LAYER).toMatch(/\.ds-builder-orgs-row\s*{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto minmax\(0, 1fr\)/);
  });

  it('one control height across the builder form', () => {
    expect(LAYER).toMatch(/\.ds-builder-wrap \.ds-input,\s*\n\.ds-builder-wrap \.ds-select,[\s\S]*?height:\s*34px/);
  });

  it('the header count is derived from the tree that is on screen', () => {
    expect(BUILDER).toMatch(/function bldTreeNodeCount\(node\)/);
    expect(BUILDER).toContain('bldTreeNodeCount(p.tree)');
  });
});

describe('accessibility invariants', () => {
  it('the two selects that had no label now have one', () => {
    expect(BUILDER).toMatch(/id="dsProfileOwnerMode"[^>]*aria-label=/);
    expect(BUILDER).toMatch(/id="dsProfileOwnerFallback"[^>]*aria-label=/);
  });

  it('icon-only topbar controls carry an accessible name', () => {
    expect(HTML).toMatch(/id="dsWhatsNewTop"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="dsSecurityBtn"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="dsDarkToggle"[^>]*aria-label=/);
    // and the dark toggle's name is kept in step with its state
    expect(CORE).toContain("btn.setAttribute('aria-label', btn.title)");
  });

  it('decorative glyphs are hidden from assistive tech', () => {
    const nav = HTML.slice(HTML.indexOf('<nav class="ds-nav"'), HTML.indexOf('</nav>'));
    const icons = nav.match(/class="ds-nav-icon ds-i"[^>]*>/g) || [];
    expect(icons.length).toBeGreaterThan(0);
    for (const i of icons) expect(i).toContain('aria-hidden="true"');
  });

  it('a hover-revealed control also reveals on keyboard focus', () => {
    // opacity:0 keeps an element in the tab order — focus must paint it.
    expect(LAYER).toMatch(/\.ds-fm-skip-btn:focus-visible/);
  });

  it('the builder\'s follow-mode target list is hidden from AT too, not just visually', () => {
    expect(BUILDER).toMatch(/id="dsBldTgtList" \$\{followMode \? 'hidden' : ''\}/);
    // …and the attribute has to beat the list's own display:grid.
    expect(LAYER).toMatch(/\.ds-pk-orgchk-list\[hidden\]\s*{\s*display:\s*none/);
  });
});

describe('the layer speaks the token vocabulary and adds nothing to it', () => {
  it('no new custom property is invented in the Studio layer', () => {
    const declared = [...LAYER.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map(m => m[1]);
    const allowed = new Set(['--adbg-icon']);   // the shared glyph table
    expect([...new Set(declared)].filter(d => !allowed.has(d))).toEqual([]);
  });

  it('spacing, type and radius come from tokens, not magic numbers', () => {
    expect(LAYER).toContain('var(--sp-');
    expect(LAYER).toContain('var(--fs-');
    expect(LAYER).toContain('var(--r-');
  });
});
