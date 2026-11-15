// Release QA 2026-11-14 — studio-builder.js.
//
// 1. 🔍 compare parents: unresolved AMBIGUOUS keys are not "aligned". Those
//    rows sit in no other bucket, are never deployed until resolved, and
//    child lookups onto them are refused — the modal used to say "safe to
//    deploy" from missing=0 / changed=0 alone, and the sync map lost the
//    ambiguous count.
// 2. Swap orgs / a target change clears the owner fallback user: it is a User
//    Id read from the OLD target and would be written as OwnerId into the new
//    one for every unmatched owner.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const { sftkParentScanVerdict, sftkParentVerdictInSync, sftkOwnerFallbackForTarget } =
  extractFunctions('studio-builder.js', ['sftkParentScanVerdict', 'sftkParentVerdictInSync', 'sftkOwnerFallbackForTarget']);
const SRC = readFileSync(new URL('../studio-builder.js', import.meta.url), 'utf8');
const REC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');

describe('parent alignment counts ambiguous keys (2026-11-14)', () => {
  it('two "Acme" Accounts in the target and nothing else drifted is NOT aligned', () => {
    const v = sftkParentScanVerdict({ missingInTarget: [], changed: [], onlyInTarget: [], identical: [{}, {}],
      ambiguous: [{ key: 'acme', candidates: ['001A', '001B'] }] });
    expect(v).toEqual({ missing: 0, changed: 0, extra: 0, same: 2, ambiguous: 1, aligned: false });
  });
  it('no missing, no changed, no ambiguous is aligned (extra in target does not block)', () => {
    expect(sftkParentScanVerdict({ identical: [{}], onlyInTarget: [{}] }).aligned).toBe(true);
  });
  it('missing or changed still blocks', () => {
    expect(sftkParentScanVerdict({ missingInTarget: [{}] }).aligned).toBe(false);
    expect(sftkParentScanVerdict({ changed: [{}] }).aligned).toBe(false);
  });
  it('a stored verdict with ambiguous rows is not "in sync"; an older verdict without the field still reads', () => {
    expect(sftkParentVerdictInSync({ missing: 0, changed: 0, ambiguous: 3 })).toBe(false);
    expect(sftkParentVerdictInSync({ missing: 0, changed: 0 })).toBe(true);
    expect(sftkParentVerdictInSync(null)).toBe(false);
  });
  it('the modal uses the verdict and deposits ambiguous to the sync map; the chip and journey banner read it', () => {
    const fn = SRC.slice(SRC.indexOf('async function bldCompareParent('), SRC.indexOf('\n}\n', SRC.indexOf('async function bldCompareParent(')));
    expect(fn).toContain('sftkParentScanVerdict(res)');
    expect(fn).toMatch(/sftkParentSyncPut\([^)]*ambiguous: nAmb/s);
    expect(fn).not.toMatch(/const aligned = !nMiss && !nChg;/);
    expect(SRC).toContain('const inSync = sftkParentVerdictInSync(vd);');
    expect(REC).toMatch(/!\(scan\.changed \|\| \[\]\)\.length &&\s*!\(scan\.ambiguous \|\| \[\]\)\.length;/);
  });
});

describe('owner fallback user follows the target org (2026-11-14)', () => {
  const prof = (tgt) => ({ sourceOrg: 'a', targetOrg: tgt,
    ownerMapping: { mode: 'match', fallbackUserId: '005000000000001AAA', fallbackUserName: 'Old Target User' } });

  it('a swap (target changes) clears the fallback Id and name', () => {
    const p = prof('b');
    expect(sftkOwnerFallbackForTarget(p, 'c')).toBe(true);
    expect(p.ownerMapping).toEqual({ mode: 'match', fallbackUserId: null, fallbackUserName: null });
  });
  it('the same target keeps it', () => {
    const p = prof('b');
    expect(sftkOwnerFallbackForTarget(p, 'b')).toBe(false);
    expect(p.ownerMapping.fallbackUserId).toBe('005000000000001AAA');
  });
  it('no owner mapping or no fallback is a no-op', () => {
    expect(sftkOwnerFallbackForTarget({ targetOrg: 'b' }, 'c')).toBe(false);
    expect(sftkOwnerFallbackForTarget({ targetOrg: 'b', ownerMapping: { mode: 'match' } }, 'c')).toBe(false);
  });
  it('the swap and the target select both call it and reload the user list', () => {
    expect(SRC).toMatch(/const prevTgt = prof\.targetOrg;\s*\[prof\.sourceOrg, prof\.targetOrg\]/);
    expect(SRC).toContain('const clearedFallback = sftkOwnerFallbackForTarget(prof, prevTgt);');
    expect(SRC).toMatch(/dsProfileTgtOrg'\)\?\.addEventListener\('change'[\s\S]{0,400}sftkOwnerFallbackForTarget\(_editingProfile, prevTgt\)[\s\S]{0,400}loadOwnerFallbackUsers\(\)/);
  });
});
