import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const SRC = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const pick = (name) => {
  const start = SRC.indexOf(`function ${name}(`);
  const end = SRC.indexOf('\n}\n', start) + 3;
  return SRC.slice(start, end);
};
const F = new Function(pick('sftkFlowRestoreMaxVersion') + pick('sftkFlowRestoreVerify') + ' return { sftkFlowRestoreMaxVersion, sftkFlowRestoreVerify };')();

// QA 2026-10-06 (live on trailheads5): Restore of a backed-up Draft reported
// "0 restored, 1 failed — accepted by Salesforce, but the new Draft version could not
// be found on re-read" while the CLI showed the new Draft. The verify filtered Tooling
// `Flow` on FullName, which Tooling SOQL refuses — every successful restore failed its
// own verify.
describe('Flows › Restore verifies by the definition name and a newer Draft', () => {
  it('no longer filters Flow on FullName', () => {
    expect(SRC).not.toContain("SELECT Id FROM Flow WHERE FullName = '");
    expect(SRC).toContain("const versionsQ = `SELECT Id, VersionNumber, Status FROM Flow WHERE Definition.DeveloperName = '${safeName}'`;");
    expect(SRC).toContain('const beforeMax = sftkFlowRestoreMaxVersion(beforeQ);');
    expect(SRC).toContain('const found = sftkFlowRestoreVerify(q, beforeMax);');
  });
  it('max version: 0 for a flow the org does not hold or a failed read', () => {
    expect(F.sftkFlowRestoreMaxVersion(null)).toBe(0);
    expect(F.sftkFlowRestoreMaxVersion({ error: 'x' })).toBe(0);
    expect(F.sftkFlowRestoreMaxVersion({ records: [] })).toBe(0);
    expect(F.sftkFlowRestoreMaxVersion({ records: [{ VersionNumber: 3 }, { VersionNumber: 7 }] })).toBe(7);
  });
  it('verify: a Draft newer than before is the proof; the deleted-last-version case (nothing before) accepts v1', () => {
    expect(F.sftkFlowRestoreVerify({ records: [{ VersionNumber: 8, Status: 'Draft' }, { VersionNumber: 7, Status: 'Active' }] }, 7)).toEqual({ ok: true, version: 8 });
    expect(F.sftkFlowRestoreVerify({ records: [{ VersionNumber: 1, Status: 'Draft' }] }, 0)).toEqual({ ok: true, version: 1 });
  });
  it('verify: says what it saw when the proof is missing', () => {
    expect(F.sftkFlowRestoreVerify({ error: 'boom' }, 3).text).toContain('could not be re-read to confirm it (boom)');
    expect(F.sftkFlowRestoreVerify({ records: [{ VersionNumber: 3, Status: 'Draft' }] }, 3).text).toContain('the only Draft the org shows (v3) is not newer than what it held before (v3)');
    expect(F.sftkFlowRestoreVerify({ records: [{ VersionNumber: 4, Status: 'Active' }] }, 3).text).toContain('shows no Draft version of this flow on re-read');
  });
});
