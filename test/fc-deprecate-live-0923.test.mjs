// Field Cleaner — 🕐 Deprecate first, pinned from a live run (2026-09-23,
// trailheads2, Account.SFTK_FC_Test_Status__c).
//
// What happened: the label was renamed and the fixture permission set's
// grant stripped, then ONE grant refused — the "Slack Integration User"
// session permission set (sfdcInternalInt), which nobody can edit. The tool
// threw "1 FLS strip(s) failed", recorded NOTHING, and offered "Deprecate
// first" again: a renamed, half-hidden field with no Undo. A second click
// stamped the description a second time.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'field-cleaner.js'), 'utf8');
const between = (a, b) => { const i = SRC.indexOf(a); expect(i, a).toBeGreaterThan(0); return SRC.slice(i, SRC.indexOf(b, i)); };

describe('deprecateField — a grant Salesforce refuses to strip is recorded, not fatal', () => {
  const fn = between('async function deprecateField(', 'async function undoDeprecation(');
  it('splits the collection results into stripped / failed by position and records both', () => {
    expect(fn).toMatch(/const flsFailed = \[\];\s*const flsStripped = \[\];/);
    expect(fn).toMatch(/flsSnapshot\.forEach\(\(f, i\) => \{\s*const x = results\[i\];\s*if \(x && x\.success\) flsStripped\.push\(f\);/);
    expect(fn).toMatch(/at: Date\.now\(\), fieldId, prevLabel, prevDesc, fls: flsStripped, flsFailed \}/);
    expect(fn).not.toContain('FLS strip(s) failed — field renamed but still partially visible');
  });
  it('names who holds the grant (permission set label or profile name)', () => {
    expect(fn).toContain("who: r.Parent?.Label || r.Parent?.Profile?.Name || r.Id");
  });
  it('does not stamp the description twice', () => {
    expect(fn).toMatch(/if \(!\/\^\\\[DEPRECATED \/\.test\(prevDesc\)\) md\.description = /);
  });
});

describe('the deprecation banner says what could not be hidden', () => {
  it('lists the refusing permission sets and says the field stays visible there', () => {
    expect(SRC).toContain("⚠ ${dep.flsFailed.length} could NOT be: ${esc(dep.flsFailed.map(x => x.who).join(', '))} (a Salesforce-managed permission set cannot be edited; the field stays visible there)");
  });
});

// Salesforce DELETES a FieldPermissions row once both permissions are false
// (live 2026-09-23: Undo updated the old Id, nothing came back, the permission
// set's grant stayed missing). Undo re-creates each grant and names failures.
describe('undoDeprecation re-creates the stripped grants', () => {
  const fn = between('async function undoDeprecation(', '// ── F1: data-usage verdict');
  it('the FLS query and the snapshot carry ParentId / SobjectType / Field for the insert', () => {
    expect(SRC).toContain('query: `SELECT Id, ParentId, SobjectType, Field, Parent.Label, Parent.IsOwnedByProfile, Parent.Profile.Name, `');
    expect(SRC).toContain('parentId: r.ParentId, sobject: r.SobjectType, field: r.Field,');
  });
  it('inserts a FieldPermissions row per stripped grant, falls back to an update by the old Id, names what did not come back', () => {
    expect(fn).toMatch(/path: 'services\/data\/v62\.0\/sobjects\/FieldPermissions', body: rec/);
    expect(fn).toMatch(/const rec = \{ ParentId: f\.parentId, SobjectType: f\.sobject \|\| _selObj\?\.api, Field: f\.field \|\| /);
    expect(fn).toMatch(/if \(!ok && f\.id\) \{/);
    expect(fn).toMatch(/if \(!ok\) notBack\.push\(`\$\{f\.who\}\$\{why \? ` \(\$\{why\}\)` : ''\}`\);/);
    expect(fn).toContain("access grant(s) could not be given back: ${esc(notBack.join(', '))}. Grant them again in Setup");
    expect(fn).toContain('body: { Metadata: sftkMetaForPatch(md) } });');
  });
});
