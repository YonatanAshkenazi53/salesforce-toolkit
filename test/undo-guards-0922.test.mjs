// 2026-09-22 — the rollback honoured the write lock only at the background
// chokepoint (first delete, half-way through the dialog) and never said why it
// wanted the org name instead of ROLLBACK.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const U = readFileSync(new URL('../studio-undo.js', import.meta.url), 'utf8');

describe('rollback and the org guards', () => {
  it('refuses a locked org before the re-read, and says so', () => {
    const i = U.indexOf('const lockedLeg = legs.find(l => typeof window.sftkOrgLocked === ');
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(U.indexOf('const t = await ensureOrgType(leg.orgUrl);'));
    expect(U).toContain('a rollback writes there, so nothing was read or written.');
  });
  it('the typed word is the org name for production AND guarded orgs, and the dialog says why', () => {
    expect(U).toContain("else if (t !== 'sandbox' && t !== 'dev') { prod = true; prodUnknown.push(leg.orgUrl); }");
    expect(U).toContain("const typedWord = prod ? orgLabel(prodLeg.orgUrl) : 'ROLLBACK';");
    expect(U).toContain('is production, or guarded as production, so the word to type is its name.');
  });
});
