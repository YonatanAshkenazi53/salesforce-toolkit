// Picklist Manager — contrast regression guards (v2 backlog: picklists-contrast).
//
// The Studio's dark card surface is near-black, and the Picklist Manager's
// JS-built HTML painted its safety-critical strings — the deactivate-path
// "UNTICKED" verdicts, the automation-scan warnings, the API-budget line —
// in Tailwind-era light-theme literals that measured 1.87–3.09:1 there,
// below AA. The fix routes every meaning-bearing colour through the semantic
// token layer (--danger / --warning / --success / --subtext / --c-warn-bg),
// which BOTH dark scopes (body.sftk-dark and .ds-dark) restate.
//
// SOURCE assertions, like test/ui-studio.test.mjs: the extension has no
// build step and `npm test` has no DOM harness. These pin two invariants:
// (1) no raw colour literal can reappear in studio-picklists.js, and
// (2) the specific safety surfaces stay on the tokens that match their
// meaning, in a token layer that still exists in both stylesheets.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');

const PICKLISTS = read('studio-picklists.js');
const SHARED    = read('styles.css');
const CSS       = read('studio.css');

describe('studio-picklists.js carries no hardcoded colour literals', () => {
  it('the audited literals are gone — every one failed AA on the dark surface', () => {
    // Amber/red/green/grey hexes the QA pass measured; kept here (not in
    // prose) so the ban list is executable, not narrative.
    for (const hex of ['#92400e', '#991b1b', '#166534', '#6b7280',
                       '#b45309', '#f59e0b', '#fffbeb']) {
      expect(PICKLISTS.toLowerCase()).not.toContain(hex);
    }
  });

  it('no 6-digit hex literal exists anywhere in the file', () => {
    expect(PICKLISTS).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });

  it('no inline style or style map sets a colour from a hex of any length', () => {
    expect(PICKLISTS).not.toMatch(/color:\s*#/i);
    expect(PICKLISTS).not.toMatch(/style\.(color|background|outline)\s*=\s*[^;\n]*#[0-9a-fA-F]/);
  });
});

describe('the safety surfaces use the token that matches their meaning', () => {
  it('the blocked-deactivate verdict is --danger, its notes are --warning', () => {
    expect(PICKLISTS).toContain('style="color:var(--danger)">⛔ UNTICKED');
    expect(PICKLISTS).toContain('<span style="color:var(--warning)"> · ⚠ ');
  });

  it('the clean verdict is --success, the records-still-hold-it caveat --warning', () => {
    // the verdict text depends on whether the scan was partial (live 2026-09-23); the token does not
    expect(PICKLISTS).toContain(`style="color:var(--success)">✓ \${partial ? 'nothing that was scanned in' : 'no flow or validation rule in'}`);
    expect(PICKLISTS).toContain('style="color:var(--warning)"> · still unticked:');
  });

  it('the API-budget cost line warns in --warning, not a literal', () => {
    expect(PICKLISTS).toContain("line.warn ? 'var(--warning)' : ''");
  });

  it('the sweep verdict map is fully tokenised per status meaning', () => {
    expect(PICKLISTS).toMatch(/sync:\s*'color:var\(--success\)'/);
    expect(PICKLISTS).toMatch(/values:\s*'color:var\(--danger\);font-weight:600'/);
    expect(PICKLISTS).toMatch(/missing:\s*'color:var\(--danger\);font-weight:600'/);
    expect(PICKLISTS).toMatch(/rts:\s*'color:var\(--warning\);font-weight:600'/);
    expect(PICKLISTS).toMatch(/error:\s*'color:var\(--danger\)'/);
  });

  it('the locate-value flash highlights with warn tokens so dark mode keeps the row readable', () => {
    expect(PICKLISTS).toContain("'2px solid var(--warning)'");
    expect(PICKLISTS).toContain("'var(--c-warn-bg)'");
  });

  it('failed-scan org rows and cap/abort summaries warn in --warning', () => {
    expect(PICKLISTS).toContain("row.style.color = 'var(--warning)'");
    expect(PICKLISTS).toMatch(/color:var\(--warning\)">[^<]*NOT checked \(\$\{CAP\}-scan cap\)/);
  });
});

describe('every token the file now leans on is defined in both stylesheets', () => {
  // studio.html loads styles.css then studio.css; the popup loads styles.css
  // alone. A rename that orphans one of these var() references must fail
  // here, not render as inherited text colour.
  for (const token of ['--warning', '--danger', '--success', '--subtext', '--c-warn-bg']) {
    it(`${token} is declared in styles.css and restated for the Studio dark scope`, () => {
      const decl = new RegExp(`${token}\\s*:`);
      expect(SHARED).toMatch(decl);
      expect(CSS).toMatch(decl);
    });
  }
});
