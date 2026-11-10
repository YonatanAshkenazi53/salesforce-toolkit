// Copy Permissions hid every licence-based permission set (found 2026-11-10 while checking packaged components, live on
// npc): "ORDER BY PermissionSet.Label" made Salesforce return 5 of the source user's 10 permission sets — Data Cloud
// Architect, Service Cloud User and the other standard ones were dropped with no error. And a permission set LICENCE
// was compared with the target's USER licence, so such a set could only ever read "incompatible".
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const F = extractFunctions('user-copy.js', ['ucSortByLabel', 'ucIsSeatLicense', 'ucNeedsOtherUserLicense']);
const UC = readFileSync(new URL('../user-copy.js', import.meta.url), 'utf8');

describe('no query in the extension sorts by a parent field', () => {
  it('user-copy.js has no ORDER BY <relationship>.<field>', () => {
    expect(UC).not.toContain('ORDER BY PermissionSet.Label`');
    expect(UC).not.toContain('ORDER BY PermissionSetGroup.MasterLabel`');
    expect(UC).toContain('sourcePermSets = ucSortByLabel(spsR.records || [],');
  });
  it('the rows are sorted in the page', () => {
    const rows = [{ PermissionSet: { Label: 'b' } }, { PermissionSet: { Label: 'A' } }, { PermissionSet: {} }];
    expect(F.ucSortByLabel(rows, r => r.PermissionSet.Label).map(r => r.PermissionSet.Label)).toEqual([undefined, 'A', 'b']);
    expect(rows[0].PermissionSet.Label).toBe('b');   // the input is left alone
    expect(F.ucSortByLabel(null, () => '')).toEqual([]);
  });
});

describe('a permission set licence is a seat, not another user licence', () => {
  it('0PL… is a seat licence and never makes a set incompatible', () => {
    expect(F.ucIsSeatLicense('0PLdL00000Dky09WAB')).toBe(true);
    expect(F.ucIsSeatLicense('100dL000000abcd')).toBe(false);
    expect(F.ucNeedsOtherUserLicense('0PLdL00000Dky09WAB', '100dL000000abcdAAA')).toBe(false);
  });
  it('another USER licence still does; the same one, or none, does not', () => {
    expect(F.ucNeedsOtherUserLicense('100dL000000zzzzAAA', '100dL000000abcdAAA')).toBe(true);
    expect(F.ucNeedsOtherUserLicense('100dL000000abcdAAA', '100dL000000abcd')).toBe(false);
    expect(F.ucNeedsOtherUserLicense(null, '100dL000000abcd')).toBe(false);
  });
});
