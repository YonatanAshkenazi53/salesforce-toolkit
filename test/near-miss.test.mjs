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

// ══════════════════════════════════════════════════════════════════
// W4 — the scan compares (and Overwrite writes) what the RUN writes
// (user 2026-08-05: "items that were need to be updated in real time
// where not captured by the engine"). fieldMappings is an EXCLUDE/
// RENAME overlay; the engine copies every createable field — but the
// scan compared only the mapping's keys and Overwrite wrote only them.
// ══════════════════════════════════════════════════════════════════
describe('sftkEngineCompareSet mirrors the engine copy set', () => {
  const { sftkEngineCompareSet } = extractFunctions('studio-scan.js', ['sftkEngineCompareSet']);
  const F = (name, type, extra) => Object.assign({ name, type, createable: true }, extra);
  const DESC = [
    F('Id', 'id', { createable: false }),
    F('Name', 'string'),
    F('Industry', 'string'),
    F('Legacy__c', 'string'),
    F('AccountId', 'reference'),
    F('Body', 'base64'),
    F('BillingAddress', 'address'),
    F('Formula__c', 'string', { createable: false }),
    F('OwnerId', 'reference'),
    F('CreatedDate', 'datetime', { createable: false }),
  ];

  it('unmapped createable data fields ARE compared (the reported gap)', () => {
    const out = sftkEngineCompareSet(DESC, {});
    expect(out.map(p => p.srcField)).toEqual(['Name', 'Industry', 'Legacy__c']);
    expect(out.every(p => p.srcField === p.tgtField)).toBe(true);
  });

  it("'' and identity mappings mean copy-same-name; null excludes; renames map", () => {
    const out = sftkEngineCompareSet(DESC, { Name: '', Industry: 'Sector__c', Legacy__c: null });
    expect(out).toEqual([
      { srcField: 'Name', tgtField: 'Name' },
      { srcField: 'Industry', tgtField: 'Sector__c' },
    ]);
  });

  it('references, blobs, compound shapes, formulas and system fields never enter', () => {
    const names = sftkEngineCompareSet(DESC, {}).map(p => p.srcField);
    for (const bad of ['AccountId', 'Body', 'BillingAddress', 'Formula__c', 'OwnerId', 'CreatedDate', 'Id']) {
      expect(names).not.toContain(bad);
    }
  });
});

describe('the scan and Overwrite consume the engine set', () => {
  const SCAN = readFileSync(join(root, 'studio-scan.js'), 'utf8');
  const REC  = readFileSync(join(root, 'studio-reconcile.js'), 'utf8');

  it('runDiffScan expands compare fields from the source describe and discloses it', () => {
    expect(SCAN).toMatch(/enginePairs = sftkEngineCompareSet\(srcDescFull\.fields, node\?\.fieldMappings\)/);
    expect(SCAN).toMatch(/compareExpanded: true/);
    // a legacy explicit compareFields config (no mappings) keeps its choice
    expect(SCAN).toMatch(/hasLegacyOnlyCompare/);
  });

  it('reconcileOverwrite writes the engine set, unmapped fields under their own name', () => {
    expect(REC).toMatch(/for \(const p of sftkEngineCompareSet\(d\.fields, fm\)\) keep\.add\(p\.srcField\)/);
    expect(REC).toMatch(/const tf = \(fm\[sf\] && fm\[sf\] !== null\) \? fm\[sf\] : sf;/);
  });
});
