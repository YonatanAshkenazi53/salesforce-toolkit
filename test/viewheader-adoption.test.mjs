// View-header adoption sweep — the SLDS page-header shape everywhere.
//
// ui-studio.test.mjs pins the five views converted in the original pass;
// this file pins the seven remaining SHIPPED view files (eight call sites —
// History renders the header twice: empty state + main list). Labs views
// (studio-schema.js, studio-fields.js, studio-tools.js) are NOT in the store
// package and are intentionally not asserted here.
//
// Like the other UI guards these are SOURCE assertions: the extension has no
// build step and no DOM harness in `npm test`, so the invariant is pinned in
// the markup each render function emits.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');

// file → what the conversion had to preserve (title wording, action ids /
// action hooks, back affordance). `titleSrc` is the exact source text of the
// title argument (dynamic titles are backtick template strings, so only
// their literal prefix is pinned). Icons are checked against the mask tables.
const SWEEP = {
  'studio-compare.js':   { calls: 1, icon: 'search',    titleSrc: "title: 'Org Compare'" },
  'studio-history.js':   { calls: 2, icon: 'scroll',    titleSrc: "title: 'History'",
                           ids: ['dsRetentionDays', 'dsCountsOnly', 'dsHistExportAll', 'dsClearCached', 'dsClearHistory'] },
  'studio-readiness.js': { calls: 1, icon: 'shield',    titleSrc: "title: 'Deployment Readiness'" },
  'studio-reconcile.js': { calls: 1, icon: 'swap',      titleSrc: 'title: `Reconcile — ',
                           ids: ['dsRecBackBtn', 'dsRecRefreshBtn'], hooks: ['data-dsaction="saveEphemeralProfile"'], back: true },
  'studio-transfer.js':  { calls: 1, icon: 'play',      titleSrc: "title: 'Run Transfer'",
                           ids: ['dsTrBackBtn'], back: true },
  'studio-whatsnew.js':  { calls: 1, icon: 'megaphone', titleSrc: "title: `What's New`" },
};

const SRC = Object.fromEntries(Object.keys(SWEEP).map(f => [f, read(f)]));

// Every declared mask glyph, from BOTH sheets (studio.html loads styles.css
// then studio.css; the table is one custom property across the two).
const MASK_NAMES = new Set(
  [...(read('styles.css') + read('studio.css')).matchAll(/\[data-i="([a-z0-9-]+)"\]/g)]
    .map(m => m[1])
);

// The icon names actually passed to dsViewHeader in one file — read from a
// window after each call site so an unrelated `icon:` field can never match.
const headerIcons = src =>
  [...src.matchAll(/dsViewHeader\(\{/g)].map(m => {
    const win = src.slice(m.index, m.index + 500);
    const icon = win.match(/icon: '([a-z0-9-]+)'/);
    return icon ? icon[1] : null;
  });

describe('every shipped view goes through dsViewHeader', () => {
  for (const [file, want] of Object.entries(SWEEP)) {
    it(`${file} calls the shared builder at every header site`, () => {
      const calls = (SRC[file].match(/dsViewHeader\(\{/g) || []).length;
      expect(calls, `${file} dsViewHeader call sites`).toBe(want.calls);
    });
  }

  for (const [file, want] of Object.entries(SWEEP)) {
    it(`${file} passes a real mask glyph (${want.icon}) — never a dangling name`, () => {
      const icons = headerIcons(SRC[file]);
      expect(icons.length).toBe(want.calls);
      for (const name of icons) {
        expect(name, `${file} header icon`).toBe(want.icon);
        expect(MASK_NAMES.has(name), `[data-i="${name}"] declared in a stylesheet`).toBe(true);
      }
    });
  }
});

describe('no hand-rolled header markup remains in the swept files', () => {
  for (const file of Object.keys(SWEEP)) {
    it(`${file} emits no bare header, wrap div, or hand-rolled <h2>`, () => {
      const src = SRC[file];
      expect(src).not.toContain('<div class="ds-view-header">');
      expect(src).not.toContain('ds-view-title-wrap');
      expect(src).not.toContain('<h2 class="ds-view-title">');
    });
  }
});

describe('the conversion preserved each view\'s behaviour surface', () => {
  for (const [file, want] of Object.entries(SWEEP)) {
    it(`${file} keeps its title wording, action ids and back affordance`, () => {
      const src = SRC[file];
      expect(src, `${file} title`).toContain(want.titleSrc);
      for (const id of want.ids || []) {
        expect(src, `${file} #${id}`).toContain(`id="${id}"`);
      }
      for (const hook of want.hooks || []) {
        expect(src, `${file} ${hook}`).toContain(hook);
      }
      if (want.back) {
        // The back link rides the builder's dedicated slot, above the title.
        expect(src, `${file} back slot`).toMatch(/back: `<button class="ds-back-link"/);
      }
    });
  }

  it('History\'s header count is computed from the arrays the list renders', () => {
    // Two-tier history (📦 archive): the header states the hot count and,
    // when archived runs are loaded into the view, the archived count — the
    // list renders exactly _history + _archShown, so the numbers agree.
    expect(SRC['studio-history.js']).toMatch(/count: `\$\{_history\.length\} run/);
    expect(SRC['studio-history.js']).toMatch(/\$\{_archShown\.length\} archived shown/);
    expect(SRC['studio-history.js']).toMatch(/\[\.\.\._history, \.\.\._archShown\]\.sort/);
  });

  it('the empty-state History header exists alongside the main one', () => {
    // Two renders, one shape: the no-runs branch must not regress to a bare <h2>.
    expect(SRC['studio-history.js']).toMatch(/dsViewHeader\(\{ icon: 'scroll', title: 'History' \}\)/);
  });
});
