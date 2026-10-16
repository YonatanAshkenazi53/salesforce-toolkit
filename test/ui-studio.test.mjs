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
const PROFILES  = read('studio-profiles.js') + '\n' + read('studio-sequences.js');   // Sequences live in studio-sequences.js since 2026-10-03 (cut from the public build)
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
    expect((nav.match(/class="ds-nav-icon ds-i" data-i="/g) || []).length).toBe(11);   // + Org health (campaign 3 phase 8)
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

  it('the connector slot is always the swap button (no lock, no ring: the source is a plain select)', () => {
    expect(row).toContain('ds-builder-orgs-flow');
    expect(row).not.toContain("dsIcon('arrow-right')");
    expect(row).toMatch(/id="dsProfileSwapOrgs"/);
    // and the swap control kept its accessible name now that it is icon-only
    expect(row).toMatch(/id="dsProfileSwapOrgs" aria-label="Swap source and target orgs"/);
  });

  it('the two columns share one header treatment', () => {
    expect((row.match(/class="ds-lbl ds-bld-col-hd"/g) || []).length).toBe(2);
    expect(LAYER).toMatch(/\.ds-bld-col-hd\s*{/);
  });

  it('source and target are two plain selects; the target list excludes the source (campaign 4 phase 2)', () => {
    expect(row).toMatch(/<select id="dsProfileSrcOrg"/);
    expect(row).toMatch(/<select id="dsProfileTgtOrg"/);
    expect(row).toMatch(/orgOpts\(p\.targetOrg, p\.sourceOrg\)/);
    expect(row).not.toContain('data-bld-tgt');
    expect(row).not.toContain('dsBldTgtMode');
    expect(row).not.toContain('ds-pk-orgchk-locked');
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

  it('both builder org selects carry an accessible name', () => {
    expect(BUILDER).toMatch(/id="dsProfileSrcOrg"[^>]*aria-label=/);
    expect(BUILDER).toMatch(/id="dsProfileTgtOrg"[^>]*aria-label=/);
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

  it('the topbar chip is read-only: it lists the open orgs and opens the All open orgs page', () => {
    expect(core).toMatch(/id="dsOpenOrgsChip"/);
    expect(core).toMatch(/navigateToView\('ring'\)/);
    expect(core).not.toMatch(/id="dsSotSel"/);
  });

  it('the picklist source line renders an explanation instead of an empty string', () => {
    expect(pk).toMatch(/ds-pk-sot-unset/);
    expect(pk).toMatch(/No source picked/);
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

  it('the helper is the preferred source (the org picked last), else empty — no ring involved', () => {
    globalThis._ring = { sourceUrl: 'https://ring.my.salesforce.com' };
    globalThis._workingPair = { src: 'https://wp.my.salesforce.com' };
    expect(currentSourceOrg()).toBe('https://wp.my.salesforce.com');
    globalThis._workingPair = { src: '' };
    expect(currentSourceOrg()).toBe('');
    globalThis._ring = null; globalThis._workingPair = null;
    expect(currentSourceOrg()).toBe('');
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

describe('the All open orgs page picks its source from the open orgs', () => {
  it('a plain source select over sftkOpenOrgs; nothing is pre-selected when the preferred source is not open', () => {
    expect(RING).toMatch(/<select id="dsRingSrc"/);
    expect(RING).toMatch(/sftkOpenOrgs\(\)/);
    expect(RING).toContain(`\${src ? '' : '<option value="" selected disabled>— pick the source —</option>'}`);
    expect(RING).toMatch(/Open at least two orgs in Chrome/);
  });

  it('the membership panel and the lock are gone', () => {
    expect(RING).not.toMatch(/ds-ring-cb|ds-ring-cfg|ds-ring-src-lock|dsRingRestoreCrown|dsRingAdoptWp/);
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

  it('the page scan skips only a KNOWN-closed org', () => {
    const src = RING.slice(RING.indexOf('async function _ringScanAll('), RING.indexOf('// Per-cell repair'));
    expect(src).toMatch(/filter\(t => !lsKnown \|\| \[\.\.\.ls\]\.some/);
  });

  // User 2026-10-05 ("why do i have a scan button in the source?") and 2026-10-08
  // ("why do we need two scan buttons? we need scan, and if there's more than two
  // targets scan both"): ONE Scan button for the page, above the matrix, that
  // compares every deployment with every open target; cells keep only ⚖.
  it('scanning is ONE button for the whole page; cells and columns carry no scan button', () => {
    expect(RING).toContain('data-ring-scanall');
    expect(RING).not.toContain('data-ring-scantgt');
    expect(RING).not.toContain('data-ring-scan1');
    expect(RING).not.toContain('ds-ring-row-acts');
    expect(RING).toContain("body.querySelector('[data-ring-scanall]')?.addEventListener('click', () => _ringScanAll());");
    const all = RING.slice(RING.indexOf('async function _ringScanAll('), RING.indexOf('// Per-cell repair'));
    expect(all).toContain('for (const t of targets) for (const p of rows) { paint(); await _ringScanOne(p.id, t, null); done++; }');
    expect(all).toContain('_ringScanAllBusy = false;');
    expect(RING).toContain('data-ring-rec="${esc(p.id)}|${esc(tUrl)}"');
  });

  it('matrix cells only badge ⚫ / disable 🔎 when liveness is known', () => {
    expect(RING).toMatch(/const live = !lsKnown \|\| \[\.\.\.ls\]\.some/);
  });

  // Knowledge is a completed enumeration, never set SIZE: the active-tab
  // session alone makes size 1 while GET_ALL_SF_SESSIONS may have failed —
  // size>0 re-disabled every open target in exactly that state.
  it('every liveness consumer branches on _liveKnown(), not set size', () => {
    // (the fan-out dialog and the Sync Plan — two consumers — were retired 2026-09-14)
    expect(RING.match(/typeof _liveKnown === 'function'/g)?.length).toBe(2);   // the matrix, a cell scan, the page scan (2026-10-08)
    expect(CORE).toMatch(/function _liveKnown\(\) \{ return _allSessionsOk; \}/);
  });

  it('_allSessionsOk is set at every enumeration site and never inferred', () => {
    const PROFILES2 = read('studio-profiles.js') + '\n' + read('studio-sequences.js');
    const TRANSFER = read('studio-transfer.js');
    // one flag write per GET_ALL_SF_SESSIONS response adoption
    expect(CORE.match(/_allSessionsOk = _allSessionsOk \|\| Array\.isArray\(allRes\?\.sessions\)/g)?.length).toBe(3);
    expect(CORE).toMatch(/if \(Array\.isArray\(freshRes\?\.sessions\)\) _allSessionsOk = true/);
    expect(TRANSFER).toMatch(/if \(Array\.isArray\(freshRes\?\.sessions\)\) _allSessionsOk = true/);
    expect(PROFILES2).toMatch(/if \(Array\.isArray\(freshRes\?\.sessions\)\) _allSessionsOk = true/);
  });
});

// ── QA sweep round 2 (2026-08-11) — five crown/pin/preview fixes ──────────
describe('crown & pin persistence — sweep round 2 fixes', () => {
  const MODALS = read('studio-builder-modals.js');
  const RECONCILE = read('studio-reconcile.js');

  it('the builder has no promote / crown-moved handlers and writes none of the retired ring fields', () => {
    expect(BUILDER).not.toMatch(/dsBldPromoteSrc|dsBldSrcMovedAck|dsBldSrcUnlock|_bldSrcOverride/);
    expect(BUILDER).not.toMatch(/\.(sourcePinned|targetOrgs|_srcCrownMoved)\s*=/);
  });

  // (the target chooser is gone — campaign 4 phase 2: a deployment has one pair, picked on the Deploy page)

  it('picker toolbar counts match what their toggles actually do', () => {
    // "Hide in-sync" must count hideSet (in-sync MINUS file-drifted), not
    // the raw in-sync set — file-drifted records survive that hide.
    expect(MODALS).toMatch(/\$\{scanFresh \? hideSet\.size : deployedIds\.size\}/);
    // "Only needs-deploy" must render (and count) file-only drift too —
    // otherwise the toggle vanishes exactly when fields are synced but
    // files aren't, the scenario the 📎 comparison exists for.
    expect(MODALS).toMatch(/idsMissingInTarget\.size \|\| idsDrift\.size \|\| idsFileMiss\.size/);
    expect(MODALS).toMatch(/new Set\(\[\.\.\.idsMissingInTarget, \.\.\.idsDrift, \.\.\.idsFileMiss\]\)\.size/);
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
  it('removeOrg clears a matching preferred source / target and persists it', () => {
    const src = CORE.slice(CORE.indexOf('window.removeOrg ='));
    expect(src).toMatch(/_workingPair\.src = ''; wpDirty = true;/);
    expect(src).toMatch(/storageSaveWorkingPair\(\)/);
    expect(src).not.toMatch(/ds_ring/);
  });

  it('the builder source select names a sourceOrg that is no longer in the org list', () => {
    expect(BUILDER).toMatch(/no longer in your org list/);
    expect(BUILDER).toMatch(/!allMapOrgs\(\)\.some\(o => _orgKey\(o\.url\) === _orgKey\(u\)\)/);
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

// ══════════════════════════════════════════════════════════════════
// Child record picker vs the target org (user report 2026-08-04:
// "doesn't pick child records correctly when compared to another org").
// Transfer v2 stores per-node scans at lastScan.children[pathKey]; the
// picker's freshness gate compared the ROOT scan's objectType against
// the child's — never equal — so child pickers silently dropped every
// 🔴/🟡/🟢 badge and fell back to stale history.
// ══════════════════════════════════════════════════════════════════
describe('the child record picker reads its OWN scan bucket', () => {
  const MODALS = read('studio-builder-modals.js');

  it('liveScan resolves per node: root scan for the root, children[pathKey] for a child', () => {
    expect(MODALS).toMatch(/isRootPick = !String\(pathStr \|\| ''\)\.length/);
    expect(MODALS).toMatch(/isRootPick \? rootScan : \(rootScan\?\.children \|\| \{\}\)\[pathStr\]/);
  });

  it('a child bucket is fresh only while it matches the CURRENT root scan', () => {
    expect(MODALS).toMatch(/isRootPick \|\| liveScan\.rootRunAt === rootScan\?\.runAt/);
  });

  it('an uncompared child says so and offers the scoped compare — never a silent nothing', () => {
    expect(MODALS).toContain('No source ↔ target comparison for these');
    expect(MODALS).toContain('id="dsRecChildScan"');
    expect(MODALS).toContain('run 🔄 Refresh state on the root object first');
    expect(MODALS).toMatch(/scanReconcileChild\(_editingProfile, pathStr\)/);
  });
});

// ══════════════════════════════════════════════════════════════════
// Hover help (user request 2026-08-04: "we should add help text on
// hoover" after the scan/reconcile/tree-diff trio confused them). The
// SFTKOnboard (?) bubble existed but was adopted NOWHERE — dsViewHeader
// now carries it and the three compare surfaces explain themselves AND
// name their siblings.
// ══════════════════════════════════════════════════════════════════
describe('the compare trio explains itself on hover', () => {
  it('dsViewHeader renders a help badge and setMain/showModal wire it', () => {
    expect(CORE).toMatch(/dsViewHeader\(\{ icon, title, subtitle, count, actions, back, cls, help \}/);
    expect(CORE).toMatch(/SFTKOnboard\.help\(help\)/);
    expect(CORE.match(/SFTKOnboard\?\.wireHelp\?\./g)?.length).toBe(2);
  });

  it('each surface names its role AND its siblings', () => {
    const RECONCILE = read('studio-reconcile.js');
    // Transfer = fix one pair, points at the All open orgs matrix (Tree diff was
    // retired 2026-09-14 — one target at a time is the whole model now)
    expect(RECONCILE).toMatch(/help: 'The repair shop of the compare trio/);
    expect(RECONCILE).toMatch(/help: '[^']*All open orgs/);
    // All open orgs = one picked source + reading-not-live-state honesty
    expect(RING).toMatch(/help: '[^']*a reading, not live state/);
  });

  it('the deployment-card buttons carry the measure/fix/overview story', () => {
    expect(PROFILES).toContain('MEASURE this pair');
    expect(PROFILES).toContain('Nothing writes until you select it.');   // 1.5.0: ▶ Run + ⚖ Transfer became 🚀 Deploy
  });
});

// ══════════════════════════════════════════════════════════════════
// Root-object combobox (user 2026-08-05: "you can't really type in the
// box … best experience is to type and get suggestions"). The old flow
// HID the text input behind a 1000-option native <select> once the
// object list loaded.
// ══════════════════════════════════════════════════════════════════
describe('the root-object picker is a real combobox', () => {
  const { bldRankObjects } = extractFunctions('studio-builder.js', ['bldRankObjects']);
  const L = [
    { name: 'Account', label: 'Account' },
    { name: 'Case__c', label: 'Custom Case' },
    { name: 'Contact', label: 'Contact' },
    { name: 'Asset_Case__c', label: 'Asset Case' },
  ];

  it('API-name prefix beats label prefix beats contains; ties alphabetical', () => {
    expect(bldRankObjects(L, 'case').map(o => o.name)).toEqual(['Case__c', 'Asset_Case__c']);
    // tier 0 (API-name prefix) sorts by LABEL: 'Contact' < 'Custom Case'
    expect(bldRankObjects(L, 'c').map(o => o.name)).toEqual(['Contact', 'Case__c', 'Account', 'Asset_Case__c']);
  });

  it('empty term returns the whole list; no match returns empty', () => {
    expect(bldRankObjects(L, '').length).toBe(4);
    expect(bldRankObjects(L, 'zzz')).toEqual([]);
    expect(bldRankObjects(null, 'x')).toEqual([]);
  });

  it('the <select> is gone and the input is never hidden', () => {
    expect(BUILDER).not.toContain('dsRootObjSel');
    expect(BUILDER).toMatch(/id="dsRootObj"[^>]*role="combobox"/);
    expect(BUILDER).toContain('id="dsRootObjAC"');
    // the loader must never hide the input again (the upsert picker
    // elsewhere in this file legitimately swaps its own controls)
    const loader = BUILDER.slice(BUILDER.indexOf('async function _bldLoadRootObjects('),
                                 BUILDER.indexOf('function bldRankObjects('));
    expect(loader).not.toContain(".style.display = 'none'");
  });

  it('keyboard support and the raw-API-name escape hatch are wired', () => {
    const combo = BUILDER.slice(BUILDER.indexOf('function _bldWireRootCombo('),
                                BUILDER.indexOf('\n}', BUILDER.indexOf('function _bldWireRootCombo(')));
    expect(combo).toContain("e.key === 'ArrowDown'");
    expect(combo).toContain("e.key === 'Escape'");
    expect(combo).toMatch(/mousedown/);
    expect(combo).toContain('if (inp.value.trim()) setRootObject()');
    expect(BUILDER).toContain('Set Root still accepts a raw API name');
  });
});

// ══════════════════════════════════════════════════════════════════
// Long names stay pickable (user 2026-08-05: "we can't see long text
// fields and long records names which makes them impossible to pick").
// ══════════════════════════════════════════════════════════════════
describe('reconcile/picker rows never hide a long name irretrievably', () => {
  it('every reconcile key span carries the FULL value as a tooltip', () => {
    const REC = read('studio-reconcile.js');
    const plain = REC.match(/<span class="ds-rec-col-key">(?!.*title=)/g) || [];
    expect(plain).toEqual([]);
    expect(REC.match(/ds-rec-col-key" title="\$\{keyLbl\(r\.matchKey\)\}"/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('picker labels carry tooltips too', () => {
    const MOD = read('studio-builder-modals.js');
    expect(MOD).toMatch(/ds-pick-label" title="\$\{esc\(label\)\}/);
    expect(MOD).toMatch(/ds-pick-label" title="\$\{esc\(lbl\)\}/);
  });

  it('keys clamp to two lines instead of one blind ellipsis', () => {
    expect(CSS).toMatch(/\.ds-rec-col-key \{[^}]*-webkit-line-clamp: 2/s);
    expect(CSS).toMatch(/\.ds-pick-label \{[^}]*-webkit-line-clamp: 2/s);
    expect(CSS).toMatch(/\.ds-rec-col-key \{[^}]*word-break: break-word/s);
  });
});

// ══════════════════════════════════════════════════════════════════
// W3 — child picker scopes to the parent's picks and groups by parent
// (user 2026-08-05: "when we pick sub records we need to be able to
// pick them like you pick lookup field records").
// ══════════════════════════════════════════════════════════════════
describe('the child record picker is parent-aware', () => {
  const MOD = read('studio-builder-modals.js');

  it('a child picker with parent picks scopes its fetch exactly like the run', () => {
    expect(MOD).toMatch(/pickerParentPicks \? `\$\{node\.field\} IN \(/);
    expect(MOD).toContain('the run fetches exactly this scope');
  });

  it('rows group under parent headers with a per-parent select-all', () => {
    expect(MOD).toContain('ds-pick-group-hdr');
    expect(MOD).toMatch(/data-group-parent/);
    expect(MOD).toMatch(/parentLabelById\.get\(pid\)/);
    expect(CSS).toMatch(/\.ds-pick-group-hdr \{/);
  });

  it('no parent picks → the flat whole-table list is unchanged', () => {
    expect(MOD).toMatch(/if \(!pickerParentPicks\) return list\.map\(rowHtml\)\.join\(''\)/);
  });
});

// ══════════════════════════════════════════════════════════════════
// W5 — Records preview: a per-record table of what THIS run will do
// (user 2026-08-04), honest about point-in-time, duplicates and scope.
// ══════════════════════════════════════════════════════════════════
describe('the Run page records preview', () => {
  const TRANSFER = read('studio-transfer.js');
  const { sftkRunOpFor } = extractFunctions('studio-transfer.js', ['sftkRunOpFor']);

  it('derives the honest operation per record state', () => {
    expect(sftkRunOpFor('missing', false).op).toBe('➕ Insert');
    expect(sftkRunOpFor('missing', true).op).toBe('➕ Insert');
    expect(sftkRunOpFor('changed', true).op).toBe('✏ Update');
    expect(sftkRunOpFor('insync', true).op).toContain('no changes');
    // insert mode on an existing record is named for what it is
    expect(sftkRunOpFor('changed', false).op).toContain('DUPLICATE');
    expect(sftkRunOpFor('insync', false).op).toContain('DUPLICATE');
  });

  it('the modal is honest: point-in-time note, extras omitted, caps and scope named', () => {
    expect(TRANSFER).toContain('a point-in-time reading, not live state');
    expect(TRANSFER).toContain("never touched by a run and aren't listed");
    expect(TRANSFER).toContain('more record(s) not listed — the run includes them all');
    expect(TRANSFER).toContain('no fresh child scan');
    expect(TRANSFER).toMatch(/Run <strong>🔄 Refresh state<\/strong>/);
  });
});

// ── QA sweep 2026-08-16 — confirmed-finding guards ──────────────────────
describe('sweep 2026-08-16: stale state can never drive a write or wear a verdict', () => {
  const REC    = read('studio-reconcile.js');
  const SCAN   = read('studio-scan.js');
  const MODALS = read('studio-builder-modals.js');

  it('the Transfer reset block clears the file selection too', () => {
    // `sourceId|checksum` keys carry no target — pairs sharing a source org
    // produce identical keys, so a survivor would arm 📎 Move against a
    // DIFFERENT target with pre-checked rows.
    const i = REC.indexOf('function sftkRecResetSelectionFor(p) {');   // 2026-09-19: the block became a function shared with the Deploy view
    expect(i).toBeGreaterThan(-1);
    expect(REC.slice(i, i + 500)).toContain('_recFileSel = new Set();');
  });

  // (the target chooser is gone — campaign 4 phase 2: a deployment has one pair, picked on the Deploy page)

  it('a failed file check renders as UNKNOWN on chooser and ring cell, never ✓ in sync', () => {
    const RINGSRC = read('studio-ring.js');
    expect(REC).toContain('📎 file check failed');
    expect(RINGSRC).toContain('file check FAILED');
    // every ring-summary write site stamps fileErr beside fileMiss
    expect((RINGSRC.match(/fileErr: true/g) || []).length).toBeGreaterThanOrEqual(2);   // Sync Plan's sites retired 2026-09-14, the re-baseline sweep 2026-10-01
    expect(SCAN).toContain('fileErr: true');
  });

  it('runDiffScan refuses source === target', () => {
    expect(SCAN).toContain("return { error: 'source and target are the same org' };");
  });

  it('nothing rescans when the source changes: the re-baseline sweep is gone', () => {
    const RINGSRC = read('studio-ring.js');
    expect(RINGSRC).not.toContain('sftkRingRebaseline');
    expect(CORE).not.toContain('sftkRingRebaseline');
  });

  it('Builder Save carries forward machine-written scan state from the saved copy', () => {
    const i = SCAN.indexOf('async function commitEditingProfile');
    const fn = SCAN.slice(i, i + 2200);
    expect(fn).toMatch(/toSave\.ringScans = \{ \.\.\.\(toSave\.ringScans \|\| \{\}\), \.\.\.\(prev\.ringScans \|\| \{\}\) \}/);
    expect(fn).toContain('if (prev.matchMemory) toSave.matchMemory = prev.matchMemory;');
    expect(fn).toMatch(/prev\.lastScan\?\.runAt \|\| 0.*>.*toSave\.lastScan\?\.runAt \|\| 0/s);
  });

  it('fileDrift persists the FULL drifted-id list and the picker reads it', () => {
    expect(SCAN).toMatch(/driftIds: cmp\.rows\.map\(r => r\.sourceId\)/);
    expect(MODALS).toMatch(/liveScan\.fileDrift\.driftIds\s*\n?\s*\|\| \(liveScan\.fileDrift\.rows \|\| \[\]\)\.map\(r => r\.sourceId\)/);
    // and the capped file check is disclosed in the diff legend
    expect(MODALS).toContain('does NOT verify their files');
  });

  it('picker pagination is deterministic and dedup-safe', () => {
    // ,Id tiebreaker in BOTH ORDER BY variants; OFFSET advances by rows
    // FETCHED; appended pages dedup by Id.
    expect(MODALS).toMatch(/ORDER BY \$\{pickerParentPicks \? node\.field \+ ',' : ''\}\$\{fld \? `\$\{fld\},Id` : 'Id'\}/);
    expect(MODALS).toContain('const offset = append ? fetchedOffset : 0;');
    expect(MODALS).toMatch(/records\.concat\(page\.filter\(r => !seen\.has\(r\.Id\)\)\)/);
    // a failed Load-more keeps pagination state (retry, not "All N loaded")
    expect(MODALS).toContain('if (res.error && append) {');
  });
});

// ── One preferred source (campaign 4 phase 2, user 2026-10-01: "no more source
// of truth"). dsSetPreferredSource is the only writer; it re-points nothing. ──
describe('one preferred source: dsSetPreferredSource', () => {
  it('the setter only records the pick: no followers, no rescans, no membership', () => {
    const i = CORE.indexOf('async function dsSetPreferredSource');
    expect(i).toBeGreaterThan(-1);
    const fn = CORE.slice(i, CORE.indexOf('\n}', i) + 2);
    expect(CORE).toContain('window.dsSetPreferredSource = dsSetPreferredSource;');
    expect(fn).toContain('_workingPair.src = url;');
    expect(fn).toContain('_ring = sftkRingView();');
    expect(fn).not.toMatch(/syncRingFollowers|sftkRingRebaseline|_ring\.orgs\.push/);
    // The ALWAYS-VISIBLE topbar must not blow away an open Builder
    // session — repaint the editor in place instead of renderView.
    expect(fn).toMatch(/if \(eid\('dsProfileName'\) && typeof renderBuilder === 'function'\) renderBuilder\(\);/);
  });

  it('teardown clears the mirror, and no surface points at a removed crown control', () => {
    const rm = CORE.slice(CORE.indexOf("eid('dsOrgRemoveConfirm')"), CORE.indexOf("eid('dsOrgRemoveConfirm')") + 1800);
    expect(rm).toMatch(/_workingPair\.src = ''; wpDirty = true;/);
    expect(rm).toContain('renderWorkingPair();');
    for (const [name, src] of [['studio-builder.js', BUILDER], ['studio-ring.js', RING],
                               ['studio-core.js', CORE], ['studio-picklists.js', PICKLISTS],
                               ['studio-readiness.js', read('studio-readiness.js')]]) {
      expect(src, `${name} still points at the removed ring crown control`)
        .not.toMatch(/Sync Ring or the topbar|mark one ⦿|pick one here or in the Sync Ring/);
    }
  });

  it('the All open orgs source select routes through the setter; nothing assigns _ring.sourceUrl', () => {
    expect(RING).toMatch(/dsRingSrc'\)\?\.addEventListener\('change'[^]{0,200}?dsSetPreferredSource\(url\)/);
    expect(RING).not.toMatch(/_ring\.sourceUrl = /);
    expect(BUILDER).not.toMatch(/_ring\.sourceUrl = /);
    expect((CORE.match(/_ring\.sourceUrl = [^'']/g) || []).length).toBe(0);
  });

  it('the topbar chip lists the orgs open in Chrome and nothing else', () => {
    const i = CORE.indexOf('function renderWorkingPair()');
    const fn = CORE.slice(i, CORE.indexOf('\n}', i) + 2);
    expect(fn).toContain('sftkOpenOrgs()');
    expect(fn).not.toMatch(/<select|inRing|not in the ring yet/);
  });
});

// ── Engine controls reach Transfer (user 2026-08-17: per-target deploys
// need bulk/batch control on the Transfer page) ─────────────────────────
describe('Transfer carries the engine controls with profile persistence', () => {
  const REC = read('studio-reconcile.js');

  it('the action bar renders apiMode + batchSize with the shared contract', () => {
    expect(REC).toContain('id="dsRecApiMode"');
    expect(REC).toContain('id="dsRecBatchSize"');
    // same delete-on-default persistence as the Run page / fan-out
    expect(REC).toMatch(/if \(v === 'sync' \|\| v === 'bulk'\) p\.apiMode = v; else delete p\.apiMode;/);
    expect(REC).toMatch(/if \(n === 200\) delete p\.batchSize; else p\.batchSize = n;/);
  });

  it('an ephemeral chooser pair mirrors the choice onto the REAL profile', () => {
    // The clone evaporates with the session — without the _ringOf mirror the
    // user's engine choice would silently vanish on the next open.
    const i = REC.indexOf('async function sftkRecEnginePersist(p) {');   // 2026-09-21: the save became a function shared with the Deploy view
    expect(i).toBeGreaterThan(-1);
    const fn = REC.slice(i, i + 700);
    expect(fn).toMatch(/p\._ringOf\?\.profileId \? _profiles\.find\(x => x\.id === p\._ringOf\.profileId\)/);
    expect(fn).toMatch(/if \(p\.apiMode\) realP\.apiMode = p\.apiMode; else delete realP\.apiMode;/);
  });
});

// ── Children gate the sync verdict (user 2026-08-18: "when childs are not
// deployed, it must not show as synced") — the strip read ROOT buckets only,
// so 1,850 missing children hid behind a silent-clean state; ring cells and
// chooser tiles are root-only scans and must SAY so. ─────────────────────
describe('a clean root never claims full sync over unverified or missing children', () => {
  const REC = read('studio-reconcile.js');
  const RINGSRC = read('studio-ring.js');

  it('fresh child scans with work feed the needs-list; unscanned sections block silent-clean', () => {
    expect(REC).toContain('const _kids = [];');
    expect(REC).toMatch(/cs\.rootRunAt === scan\.runAt && cs\.objectType === obj/);
    // needs-banner carries per-child line items
    expect(REC).toContain('(child section below)');
    // silent-clean requires: root clean AND no child work…
    expect(REC).toMatch(/const _syncStrip = \(_rootClean && !_kids\.length\)/);
    // …and an unscanned child section forces the UNVERIFIED banner instead
    expect(REC).toContain('Root object in sync — children unverified');
    expect(REC).toMatch(/_health\.length \|\| _fdRecs \|\| _kidsUnscanned/);
  });

  it('ring cells qualify the checkmark when the deployment has child objects', () => {
    expect(RINGSRC).toMatch(/\(p\.tree\?\.children \|\| \[\]\)\.length/);
    expect(RINGSRC).toContain('>✓ root</span>');
    expect(RINGSRC).toContain("Ring scans do NOT check this deployment's");
  });

  // (the target chooser is gone — campaign 4 phase 2: a deployment has one pair, picked on the Deploy page)
});

// ── The landing-page sync tiles obey every verdict law (user 2026-08-18,
// live: a tile said "✓ in sync" over 463 wrong child links) ──────────────
describe('sync-status tiles: root-only scans can never overclaim', () => {
  const fn = CORE.slice(CORE.indexOf('function _syncStatusStripHtml'),
                        CORE.indexOf('function renderOrgsPanel'));

  it('children gate the tile — fresh child work counts, unscanned = unverified', () => {
    expect(fn).toMatch(/cs\.rootRunAt === s\.runAt && cs\.objectType === obj/);
    expect(fn).toContain('kidNeed += (cs.missingInTarget || []).length');
    expect(fn).toContain('✓ root · children unverified');
    expect(fn).toMatch(/const clean = !t\.stale && t\.drift === 0 && !t\.kidNeed && !t\.fMiss;/);
  });

  it('files and file-check failures gate it too', () => {
    expect(fn).toMatch(/fMiss = \(s\.fileDrift && !s\.fileDrift\.error && s\.fileDrift\.records\) \|\| 0/);
    expect(fn).toContain('📎 file check failed');
    expect(fn).toContain('📎 ${t.fMiss} missing files');
  });

  it('a lastScan stamped for a different pair renders as stale, never as counts', () => {
    expect(fn).toMatch(/sftkOrgKey\(s\.sourceOrg\) !== sftkOrgKey\(p\.sourceOrg \|\| ''\)/);
    expect(fn).toContain('scan is for a different org pair — rescan');
  });
});

// ── Batch size is a SYNC-engine knob (user 2026-08-18: "in case i use
// async, i shouldn't be able to select batch size") ──────────────────────
describe('the batch-size input goes inert in Async mode, on every surface', () => {
  const REC = read('studio-reconcile.js');
  const TRANSFER = read('studio-transfer.js');

  it('renders disabled when the profile is already on bulk', () => {
    for (const [name, src, id] of [['reconcile', REC, 'dsRecBatchSize'],
                                   ['run page', TRANSFER, 'dsTrBatchSize']]) {
      const i = src.indexOf(`id="${id}"`);
      expect(i, `${name} input exists`).toBeGreaterThan(-1);
      expect(src.slice(i, i + 450), `${name} disables on bulk`)
        .toMatch(/apiMode === 'bulk' \? 'disabled' : ''/);
    }
  });

  it('the apiMode change handlers toggle it live', () => {
    expect(REC).toMatch(/bi\.disabled = v === 'bulk'/);
    expect((TRANSFER.match(/\.disabled = v === 'bulk'/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('the input is labeled — never a bare number', () => {
    expect(REC).toContain('<span>batch size</span>');
    expect(REC).toContain('<span>per call</span>');
  });

  it('threads (parallel batches) exists on all three surfaces, sync-only like batch size', () => {
    // Engine gate: parallel waves only when the profile asks and the run is
    // synchronous — Bulk is one job.
    const BG = read('background.js');
    expect(BG).toMatch(/const THREADS = \(!useBulk && Number\(profile\.threads\) >= 2\)/);
    expect(BG).toMatch(/Math\.min\(6, Math\.floor\(Number\(profile\.threads\)\)\)/);
    expect(BG).toContain('starts.map(s => sendChunk(s))');
    for (const [name, src, id] of [['reconcile', REC, 'dsRecThreads'],
                                   ['run page', TRANSFER, 'dsTrThreads']]) {
      const i = src.indexOf(`id="${id}"`);
      expect(i, `${name} threads input exists`).toBeGreaterThan(-1);
      expect(src.slice(i, i + 450), `${name} disables on bulk`)
        .toMatch(/apiMode === 'bulk' \? 'disabled' : ''/);
    }
  });

  it('children get a 🟢 Synced fold with pair rows, not just a header count', () => {
    expect(REC).toContain('ds-rec-child-syncfold');
    expect(REC).toMatch(/Synced \$\{csLbl\(cs, 'identical'\)\}/);
  });
});

// ── Professional surface: user-visible text never names other products
// (user 2026-08-19, pre-public-release: "don't mention inspector and other
// things… needs to look professional"). Code comments are exempt — they
// ship to no one. ─────────────────────────────────────────────────────────
describe('no competitor names in user-visible strings', () => {
  const SHIPPED = ['popup.js', 'studio-core.js', 'studio-transfer.js',
    'studio-reconcile.js', 'studio-builder.js', 'studio-builder-modals.js',
    'studio-ring.js', 'studio-scan.js', 'studio-history.js', 'studio-profiles.js', 'studio-sequences.js',
    'lightning-pages.js', 'field-cleaner.js', 'CHANGELOG.md', 'studio.html', 'popup.html'];
  const NAMES = /(Inspector|Gearset|Workbench|SFDMU)/i;

  it('no title/tooltip attribute carries a product name', () => {
    for (const f of SHIPPED) {
      const src = read(f);
      for (const m of src.matchAll(/title="([^"]{0,400})"/g)) {
        expect(m[1], `${f}: tooltip mentions a product: "${m[1].slice(0, 80)}…"`)
          .not.toMatch(NAMES);
      }
    }
  });

  it('the shipped changelog carries none either', () => {
    expect(read('CHANGELOG.md')).not.toMatch(/Inspector-style|like Inspector|Gearset|SFDMU/);
  });
});
