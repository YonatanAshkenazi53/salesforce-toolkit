// Copy Permissions copies the ROLE too (user request 2026-09-29, built after
// campaign 3). One field on the user (UserRoleId): shown in the preview like
// the profile, named in the confirmation, written and re-read, undoable from
// History (the previous role, or none, written back and re-read).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'user-copy.js'), 'utf8');

describe('Copy Permissions — role', () => {
  it('reads the role with every user and offers it as an option next to Profile', () => {
    expect(SRC).toContain("'Profile.UserLicense.Id,Profile.UserLicense.Name,UserType,UserRoleId,UserRole.Name';");
    expect(SRC).toContain('<input type="checkbox" class="uc-opt-cb" id="ucOptRole" checked>');
    expect(SRC).toContain("role:      !!document.getElementById('ucOptRole')?.checked,");
  });
  it('the preview: same role → nothing to do; a source with no role → nothing to copy (clearing is not offered)', () => {
    expect(SRC).toContain('<input type="checkbox" id="ucRoleCb" ${sameRole || noSrcRole ? \'disabled\' : \'checked\'}>');
    expect(SRC).toContain("has no role — nothing to copy");
  });
  it('the confirmation names the role change', () => {
    expect(SRC).toContain("planned.push({ label: `Role → ${sourceUser.UserRole?.Name || sourceUser.UserRoleId || '?'}`");
    expect(SRC).toContain('A profile or role change replaces the old one');
  });
  it('the write goes through the discipline and is re-read; the undo writes the previous role back (null when there was none)', () => {
    expect(SRC).toContain("body: { UserRoleId: sourceUser.UserRoleId }");
    expect(SRC).toContain("query: `SELECT UserRoleId FROM User WHERE Id = '${targetUser.Id}'` });");
    expect(SRC).toContain('const prevRoleId = targetUser.UserRoleId || null;   // null = the target had no role');
    expect(SRC).toContain("msg: { type: 'SF_PATCH', path: `services/data/v62.0/sobjects/User/${targetUser.Id}`, body: { UserRoleId: prevRoleId } },");
    expect(SRC).toContain("pick: 'records.0', field: 'UserRoleId', equals: prevRoleId,");
    expect(SRC).toContain("if (roleOk)     parts.push('role updated');");
  });
});
