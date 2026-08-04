// NEAR-MISS detection — user bug 2026-08-04 (enterprise-org test): a custom
// child object matched by external Id showed ONE record as "missing in
// target" whose twin sat in "only in target" — the two external-Id values
// differed by an invisible whitespace character, and the exact-match keys
// (all normalization defaults OFF) kept them apart. "That one child record
// ruined my comparison. … so its weird it didn't work."
//
// The fix is three-layered and these tests pin each layer:
//   1. PURE detection: sftkNearMissReason / sftkNearMissFold (sftk-matching).
//   2. The scan pass: missing↔extra pairs get row.nearMiss + scan.nearMisses.
//   3. Surfacing: reconcile rows/notes, the picker badge, and honest
//      External-ID strategy defaults (trim + caseFold) in the picker.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunctions } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');

const { sftkNearMissReason, sftkNearMissFold } =
  extractFunctions('sftk-matching.js', ['sftkNearMissReason', 'sftkNearMissFold']);

const SEP = String.fromCharCode(1);

describe('sftkNearMissReason — names the invisible difference', () => {
  it('trailing whitespace → "whitespace" (the reported bug)', () => {
    expect(sftkNearMissReason('ACC-001 ', 'ACC-001')).toBe('whitespace');
    expect(sftkNearMissReason('ACC-001', ' ACC-001')).toBe('whitespace');
    expect(sftkNearMissReason('ACC  001', 'ACC 001')).toBe('whitespace');
  });

  it('case difference → "case"', () => {
    expect(sftkNearMissReason('acc-001', 'ACC-001')).toBe('case');
  });

  it('both → "case + whitespace"', () => {
    expect(sftkNearMissReason(' acc-001', 'ACC-001')).toBe('case + whitespace');
  });

  it('a real value difference is NOT a near miss', () => {
    expect(sftkNearMissReason('ACC-001', 'ACC-002')).toBeNull();
    expect(sftkNearMissReason('ACC-001', 'ACC-0010')).toBeNull();
  });

  it('composite keys report per component', () => {
    expect(sftkNearMissReason('ann@x.com' + SEP + 'Lee ', 'ann@x.com' + SEP + 'Lee')).toBe('whitespace');
    expect(sftkNearMissReason('a' + SEP + 'b', 'a' + SEP + 'c')).toBeNull();
    expect(sftkNearMissReason('a' + SEP + 'b', 'a')).toBeNull();   // arity mismatch
  });

  it('identical keys are not a near miss (they would have matched)', () => {
    expect(sftkNearMissReason('ACC-001', 'ACC-001')).toBeNull();
  });
});

describe('sftkNearMissFold — the index accepts exactly what Reason can name', () => {
  it('folds whitespace and case, per component', () => {
    expect(sftkNearMissFold(' ACC-001 ')).toBe('acc-001');
    expect(sftkNearMissFold('A  B' + SEP + 'C ')).toBe('a b' + SEP + 'c');
  });
  it('agreement: fold-equal keys always produce a non-null reason (unless identical)', () => {
    const pairs = [['x ', 'x'], ['X', 'x'], [' A' + SEP + 'b ', 'a' + SEP + 'B']];
    for (const [a, b] of pairs) {
      expect(sftkNearMissFold(a)).toBe(sftkNearMissFold(b));
      expect(sftkNearMissReason(a, b)).not.toBeNull();
    }
  });
});

describe('the scan pass and its surfacing', () => {
  const SCAN = read('studio-scan.js');
  const REC  = read('studio-reconcile.js');
  const MOD  = read('studio-builder-modals.js');

  it('runDiffScan pairs missing↔extra by fold, tags BOTH rows, reports the count', () => {
    expect(SCAN).toMatch(/sftkNearMissFold\(row\.matchKey\)/);
    expect(SCAN).toMatch(/row\.nearMiss\s+=\s+\{ targetId: twin\.targetId, reason \}/);
    expect(SCAN).toMatch(/twin\.nearMiss = \{ sourceId: row\.sourceId, reason \}/);
    expect(SCAN).toMatch(/nearMissCount \? \{ nearMisses: nearMissCount \}/);
    // orphans and blank keys never enter the fold index
    expect(SCAN).toMatch(/row\.orphan \|\| !row\.matchKey/);
  });

  it('reconcile marks the rows and explains the fix at root AND child level', () => {
    expect(REC).toMatch(/nearChip = nm =>/);
    expect(REC.match(/\$\{nearChip\(r\.nearMiss\)\}/g)?.length).toBe(2);   // root col + child rows
    expect(REC).toContain('almost matched — their keys differ only by whitespace/case');
    expect(REC).toMatch(/\$\{scopeNote\}\$\{capNote\}\$\{collisionNote\}\$\{nearNote\}/);
  });

  it('the record picker shows ≈ instead of a false 🔴 missing', () => {
    expect(MOD).toMatch(/nearMissById\.get\(r\.Id\)/);
    expect(MOD).toContain('so transferring would DUPLICATE it');
  });

  it('External-ID strategy defaults to trim + case-insensitive ONLY when nothing is configured', () => {
    expect(MOD).toMatch(/matchStrategy === 'externalId' && !Object\.values\(matchNormalize\)\.some\(Boolean\)/);
    expect(MOD).toMatch(/matchNormalize\.trim = true;\s+matchNormalize\.caseFold = true;/);
  });
});
