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
import { extractFunction, extractFunctions } from './extract.mjs';

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

// ══════════════════════════════════════════════════════════════════
// The "no source of truth" state must never look like a chosen org
// (user 2026-07-30: "source of truth is not pre select but it is select
// in the top bar" + "same in the picklist manager").
//
// A <select> with no `selected` option silently DISPLAYS ITS FIRST ONE,
// so the topbar chip asserted an org was the source while the Sync Ring
// correctly said none was set. The picklist config had the mirror-image
// bug: it rendered the source line as an empty string, dropping the
// concept from the screen entirely.
// ══════════════════════════════════════════════════════════════════
describe('unset source of truth is stated, not implied', () => {
  const core = CORE, pk = PICKLISTS;

  it('the topbar select carries a selected placeholder when no source is set', () => {
    // Must be BOTH selected (so it wins over the browser's first-option
    // fallback) and disabled (so it can never be chosen as a real value).
    expect(core).toMatch(/const placeholder = srcUrl \? '' :/);
    expect(core).toMatch(/<option value=""\s+selected\s+disabled>/);
  });

  it('the placeholder is emitted BEFORE the org options, or it cannot win', () => {
    const m = /\$\{placeholder\}\$\{opts\}/.exec(core);
    expect(m, 'placeholder must precede opts in the select markup').toBeTruthy();
  });

  it('the topbar chip is visually marked as unset, not styled like a real choice', () => {
    expect(core).toMatch(/ds-pair-sel-unset/);
  });

  it('the picklist source line renders an explanation instead of an empty string', () => {
    expect(pk).toMatch(/ds-pk-sot-unset/);
    expect(pk).toMatch(/No source of truth set/);
    // Scoped to the sotLine assignment itself: a broad "no `: ''` anywhere"
    // regex matched unrelated conditional renders in this 2,500-line file.
    const decl = /const sotLine = sotOrg([\s\S]{0,900}?)\n\s*const chks/.exec(pk);
    expect(decl, 'sotLine declaration must be findable').toBeTruthy();
    expect(decl[1], 'the else branch must render something, not \'\'')
      .not.toMatch(/:\s*''\s*;/);
  });

  it('and offers the one click that fixes it', () => {
    expect(pk).toMatch(/id="dsPkGoRing"/);
    expect(pk).toMatch(/navigateToView\('ring'\)/);
  });
});

// A new deployment must open with the SAME source the topbar shows
// (user 2026-07-30: "source is already selected on the top bar. you need
// to preselect it as source and give the others as target"). The topbar
// resolved `_ring.sourceUrl || _workingPair.src` while the builder used
// `_workingPair.src` alone, so a new profile could open sourceless — and
// with the source unset, every org including the topbar's source was
// offered as a write target.
describe('new deployments inherit the topbar source', () => {
  const core = CORE, bld = BUILDER, prof = PROFILES;
  const currentSourceOrg = extractFunction('studio-core.js', 'currentSourceOrg');

  it('the helper prefers the ring source, then the working pair, then empty', () => {
    globalThis._ring = { sourceUrl: 'https://ring.my.salesforce.com' };
    globalThis._workingPair = { src: 'https://wp.my.salesforce.com' };
    expect(currentSourceOrg()).toBe('https://ring.my.salesforce.com');
    globalThis._ring = { sourceUrl: '' };
    expect(currentSourceOrg()).toBe('https://wp.my.salesforce.com');
    globalThis._workingPair = { src: '' };
    expect(currentSourceOrg()).toBe('');
    globalThis._ring = null; globalThis._workingPair = null;
    expect(currentSourceOrg()).toBe('');
  });

  it('the topbar chip resolves through the helper, not its own expression', () => {
    expect(core).toMatch(/const srcUrl = currentSourceOrg\(\);/);
  });

  it('both new-record paths seed their source from the helper', () => {
    expect(bld).toMatch(/sourceOrg: \(typeof currentSourceOrg === 'function' \? currentSourceOrg\(\)/);
    expect(prof).toMatch(/sourceOrg: \(typeof currentSourceOrg === 'function' \? currentSourceOrg\(\)/);
  });
});

// ══════════════════════════════════════════════════════════════════
// Two user reports, 2026-07-31.
// (1) "orgfarm is open but doesn't show as open in the data studio" —
//     sandboxes SHARE the .develop.my.salesforce.com cookie domain, so
//     one org's tab could resolve to another org's session; the dedup
//     then dropped the tab that was actually open.
// (2) "if ashkenazy6 is the source it shouldn't be available in the ring
//     sync picklist... maybe it should be preselected and locked" —
//     unticking the source silently handed the crown to whichever org
//     sorted first.
// ══════════════════════════════════════════════════════════════════
describe('multi-org session enumeration attributes sessions to the right org', () => {
  const BG = read('background.js');
  const fn = BG.slice(BG.indexOf('async function getAllSfSessions('),
                      BG.indexOf('async function getSfSession('));

  it('the region under test was found', () => {
    expect(fn).toContain('orgTabs');
  });

  it('resolves each tab against its OWN host before falling back', () => {
    expect(fn).toMatch(/sftkCookieSessFor\(tab\.url\)/);
    expect(fn).toMatch(/await getSfSession\(tab\.url\)/);
  });

  it('refuses to report a tab using another org\'s session', () => {
    expect(fn).toMatch(/sftkOrgKey\(orgUrl\) !== sftkOrgKey\(tabUrl\)/);
  });

  it('dedupes on org identity, not the raw URL string', () => {
    // my.salesforce.com and lightning.force.com are ONE org.
    expect(fn).toMatch(/const key = sftkOrgKey\(orgUrl\)/);
    expect(fn).toMatch(/seenOrgs\.has\(key\)/);
    expect(fn).not.toMatch(/seenOrgs\.has\(orgUrl\)/);
  });
});

describe('the ring source of truth is preselected and locked', () => {
  it('the source row is checked and disabled, never unticked by accident', () => {
    expect(RING).toMatch(/\$\{isSrc \|\| inRing \? 'checked' : ''\}/);
    expect(RING).toMatch(/\$\{isSrc \? 'disabled' : ''\}/);
  });

  it('the lock is explained, not silent', () => {
    expect(RING).toMatch(/ds-ring-src-lock/);
    expect(RING).toMatch(/source — always in the ring/);
    expect(RING).toMatch(/Pick a different ⦿ source to move it/);
  });

  it('studio.css styles the locked row', () => {
    expect(CSS).toMatch(/\.ds-ring-org-locked\s*\{/);
    expect(CSS).toMatch(/\.ds-ring-src-lock\s*\{/);
  });
});

// ══════════════════════════════════════════════════════════════════
// Liveness doctrine (Fable recheck, sessions-ring audit): an EMPTY live
// set means "sessions aren't enumerated yet" — unknown, NOT closed. The
// fan-out advice column applied this (e9d8f0f) while the org label on the
// SAME row printed "(not open)", and every ring surface still treated the
// empty set as all-closed (Sync Plan refused to run, matrix cells went ⚫
// with 🔎 disabled). One rule everywhere now.
// ══════════════════════════════════════════════════════════════════
describe('empty live set = unknown, not closed', () => {
  const { orgOptionLabel } = extractFunctions('studio-core.js', ['orgOptionLabel']);
  const URL_A = 'https://acme.my.salesforce.com';

  const withStubs = fn => {
    globalThis._orgKey = u => String(u || '').toLowerCase();
    globalThis.window = { sftkGlyph: (emoji) => emoji };
    try { return fn(); } finally { delete globalThis._orgKey; delete globalThis.window; }
  };

  it('orgOptionLabel with an EMPTY set paints no status at all', () => withStubs(() => {
    const s = orgOptionLabel(URL_A, 'Acme', new Set());
    expect(s).not.toContain('(not open)');
    expect(s).not.toContain('🟢');
    expect(s).not.toContain('⚪');
    expect(s).toContain('Acme');
  }));

  it('a populated set still marks open and closed orgs', () => withStubs(() => {
    const live = new Set([URL_A]);
    expect(orgOptionLabel(URL_A, 'Acme', live)).toContain('🟢');
    const off = orgOptionLabel('https://bravo.my.salesforce.com', 'Bravo', live);
    expect(off).toContain('⚪');
    expect(off).toContain('(not open)');
  }));

  it('Sync Plan attempts all targets when liveness is unknown instead of refusing', () => {
    const src = RING.slice(RING.indexOf('async function _ringOpenPlan('),
                           RING.indexOf('\n}', RING.indexOf('async function _ringOpenPlan(')));
    expect(src).toMatch(/lsKnown = \(typeof _liveKnown === 'function'\) \? _liveKnown\(\)/);
    expect(src).toMatch(/lsKnown \? targets\.filter[\s\S]*?: targets\.slice\(\)/);
  });

  it('Scan-all skips only KNOWN-closed orgs', () => {
    const src = RING.slice(RING.indexOf('async function _ringScanAll('),
                           RING.indexOf('\n}', RING.indexOf('async function _ringScanAll(')));
    expect(src).toMatch(/lsKnown && !\[\.\.\.ls\]\.some/);
  });

  it('matrix cells only badge ⚫ / disable 🔎 when liveness is known', () => {
    expect(RING).toMatch(/const live = !lsKnown \|\| \[\.\.\.ls\]\.some/);
  });

  // Knowledge is a completed enumeration, never set SIZE: the active-tab
  // session alone makes size 1 while GET_ALL_SF_SESSIONS may have failed —
  // size>0 re-disabled every open target in exactly that state.
  it('every liveness consumer branches on _liveKnown(), not set size', () => {
    const TRANSFER = read('studio-transfer.js');
    expect(TRANSFER).toMatch(/liveKnown = \(typeof _liveKnown === 'function'\) \? _liveKnown\(\)/);
    expect(RING.match(/typeof _liveKnown === 'function'/g)?.length).toBe(3);
    expect(CORE).toMatch(/function _liveKnown\(\) \{ return _allSessionsOk; \}/);
  });

  it('_allSessionsOk is set at every enumeration site and never inferred', () => {
    const PROFILES2 = read('studio-profiles.js');
    const TRANSFER = read('studio-transfer.js');
    // one flag write per GET_ALL_SF_SESSIONS response adoption
    expect(CORE.match(/_allSessionsOk = _allSessionsOk \|\| Array\.isArray\(allRes\?\.sessions\)/g)?.length).toBe(3);
    expect(CORE).toMatch(/if \(Array\.isArray\(freshRes\?\.sessions\)\) _allSessionsOk = true/);
    expect(TRANSFER).toMatch(/if \(Array\.isArray\(freshRes\?\.sessions\)\) _allSessionsOk = true/);
    expect(PROFILES2).toMatch(/if \(Array\.isArray\(freshRes\?\.sessions\)\) _allSessionsOk = true/);
  });
});

// ══════════════════════════════════════════════════════════════════
// Fable recheck — behaviour/functional confirmed fixes
// ══════════════════════════════════════════════════════════════════
describe('the builder header count can never disagree with the tree', () => {
  it('refreshTree repaints the .ds-vh-count chip — add/remove funnel through it', () => {
    const src = BUILDER.slice(BUILDER.indexOf('function refreshTree('),
                              BUILDER.indexOf('\n}', BUILDER.indexOf('function refreshTree(')));
    expect(src).toMatch(/querySelector\('\.ds-vh-count'\)/);
    expect(src).toMatch(/bldTreeNodeCount\(_editingProfile\.tree\)/);
    expect(src).toMatch(/object\$\{n !== 1 \? 's' : ''\} in the tree/);
  });
});

describe('a phantom source org is named, never silently kept', () => {
  it('removeOrg drops the org from the ring and clears a matching sourceUrl', () => {
    const src = CORE.slice(CORE.indexOf('window.removeOrg ='));
    expect(src).toMatch(/_ring\.orgs = \(_ring\.orgs \|\| \[\]\)\.filter/);
    expect(src).toMatch(/_orgKey\(_ring\.sourceUrl\) === _orgKey\(orgUrl\)\) _ring\.sourceUrl = ''/);
    expect(src).toMatch(/ds_ring: _ring/);
  });

  it('the builder source select names a sourceOrg that is no longer in the org list', () => {
    expect(BUILDER).toMatch(/no longer in your org list/);
    expect(BUILDER).toMatch(/!allMapOrgs\(\)\.some\(o => _orgKey\(o\.url\) === _orgKey\(p\.sourceOrg\)\)/);
  });
});

describe('destructive/warning colours are theme tokens, not light literals', () => {
  // The light-pink literal shipped into dark mode as the ONE bright panel on
  // the screen (Delete Selected, Flows tab), and #8A4700 measured 1.96:1 on
  // the dark warning bg.
  it('.btn-danger / delete-mode chip / error banner / cs pills use the critical tokens', () => {
    expect(SHARED).toMatch(/\.btn-danger \{[^}]*var\(--c-critical-bg\)/s);
    expect(SHARED).toMatch(/\.mode-btn\[data-mode="delete"\]\.active\s+\{ background: var\(--c-critical-bg\)/);
    expect(SHARED).toMatch(/\.error-banner \{\s*[^}]*var\(--c-critical-bg\)/s);
    expect(SHARED).toMatch(/\.cs-pill-critical \{ background: var\(--c-critical-bg\)/);
  });

  it('.btn-warning and .cs-pill-warning read var(--warning), never #8A4700', () => {
    expect(SHARED).not.toContain('#8A4700');
    expect(SHARED).toMatch(/\.btn-warning \{[^}]*color: var\(--warning\)/s);
    expect(SHARED).toMatch(/\.cs-pill-warning\s+\{[^}]*color: var\(--warning\)/s);
  });

  it('the danger hover has a dark override', () => {
    expect(SHARED).toMatch(/body\.sftk-dark \.btn-danger:hover/);
  });
});

// ══════════════════════════════════════════════════════════════════
// Session attribution: the direct cookie path only trusts HOST-SPECIFIC
// cookies. getAll({url}) also returns parent-domain cookies (the shared
// .develop.my.salesforce.com sid) — after a logout that parent sid can be
// the only one left, and returning it presents a logged-out org as open
// with a SIBLING org's session. The wrong-org guard can't catch it (both
// keys are the tab's own host by construction).
// ══════════════════════════════════════════════════════════════════
describe('sftkCookieSessFor refuses foreign parent-domain cookies', () => {
  const { sftkCookieSessFor } = extractFunctions('background.js', ['sftkCookieSessFor']);
  const HOST = 'acme.develop.my.salesforce.com';

  const withCookies = async (cookies, fn) => {
    globalThis.chrome = { cookies: { getAll: async () => cookies } };
    try { return await fn(); } finally { delete globalThis.chrome; }
  };

  it('a host-specific cookie wins, even next to a parent-domain one', () =>
    withCookies([
      { domain: '.develop.my.salesforce.com', value: 'SID_FOREIGN' },
      { domain: HOST, value: 'SID_OWN' },
    ], async () => {
      const s = await sftkCookieSessFor(`https://${HOST}/lightning`);
      expect(s).toEqual({ orgUrl: `https://${HOST}`, sid: 'SID_OWN' });
    }));

  it('ONLY a parent-domain cookie → null, never a sibling org presented as this org', () =>
    withCookies([
      { domain: '.develop.my.salesforce.com', value: 'SID_FOREIGN' },
    ], async () => {
      expect(await sftkCookieSessFor(`https://${HOST}/`)).toBeNull();
    }));

  it('the dotted form of the org\'s own host still counts as host-specific', () =>
    withCookies([
      { domain: `.${HOST}`, value: 'SID_OWN' },
    ], async () => {
      expect((await sftkCookieSessFor(`https://${HOST}/`))?.sid).toBe('SID_OWN');
    }));

  it('lightning.force.com urls resolve against the my.salesforce.com host', () =>
    withCookies([
      { domain: 'acme.my.salesforce.com', value: 'SID_OWN' },
    ], async () => {
      const s = await sftkCookieSessFor('https://acme.lightning.force.com/x');
      expect(s?.orgUrl).toBe('https://acme.my.salesforce.com');
    }));

  it('the wrong-org guard comment no longer overclaims — scope is stated', () => {
    const BG = read('background.js');
    expect(BG).toContain('It CANNOT catch wrong-COOKIE resolution');
    expect(BG).toContain('only trusts host-specific cookies');
  });

  it('a getSfSession fallback claim is re-verified against the claimed org\'s own host cookies', () => {
    const BG = read('background.js');
    const fn = BG.slice(BG.indexOf('async function getAllSfSessions('),
                        BG.indexOf('async function getSfSession('));
    expect(fn).toMatch(/const v = await sftkCookieSessFor\(s\.orgUrl\)/);
    expect(fn).toMatch(/if \(!v \|\| v\.sid !== s\.sid\) s = null/);
  });
});

// ══════════════════════════════════════════════════════════════════
// Child-node feature discoverability (user report 2026-08-04:
// "couldn't locate the child records picker … also the deploy before
// parent"). Both existed and worked — they were just invisible in two
// states: a COLLAPSED tree node hides its whole config row, and the Run
// page's per-node 🎯 Filter button silently vanished without a source
// session.
// ══════════════════════════════════════════════════════════════════
describe('picked records and child-first are never invisible', () => {
  it('a collapsed node shows state chips that expand on click', () => {
    expect(BUILDER).toMatch(/data-expand-chip="\$\{esc\(pathKey\)\}"/);
    expect(BUILDER).toMatch(/bits\.push\(`🎯 \$\{node\.recordIds\.length\}`\)/);
    expect(BUILDER).toMatch(/bits\.push\('⤴ child-first'\)/);
    expect(BUILDER).toMatch(/\[data-expand-chip\]/);   // wiring exists
    expect(CSS).toMatch(/\.ds-tree-collapsed-chips\s*\{/);
  });

  it('the Run page renders a DISABLED filter button with the unlock hint instead of nothing', () => {
    const TRANSFER = read('studio-transfer.js');
    expect(TRANSFER).toMatch(/Record filtering needs the source org/);
    expect(TRANSFER).not.toMatch(/const filterBtn = canFilter\s*\?[\s\S]{0,400}?:\s*'';/);
  });
});
