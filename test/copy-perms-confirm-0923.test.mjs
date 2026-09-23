// Copy Permissions — 📋 Copy asks before it writes (live 2026-09-23).
//
// The button ran executeCopy on the click: profile change, permission-set and
// group memberships and user fields were written with no summary and no
// acknowledgement. Access changes are the kind users notice late.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'user-copy.js'), 'utf8');
const between = (a, b) => { const i = SRC.indexOf(a); expect(i, a).toBeGreaterThan(0); return SRC.slice(i, SRC.indexOf(b, i)); };

describe('executeCopy — the confirmation comes first', () => {
  const fn = between('async function executeCopy() {', "btn.textContent = '⏳ Copying…';");
  it('names source and target, lists every planned operation, needs the acknowledgement, returns when refused', () => {
    expect(fn).toMatch(/title: `Copy access from \$\{sourceUser\.Name\} to \$\{targetUser\.Name\}`/);
    expect(fn).toMatch(/document\.querySelectorAll\('\.uc-ps-cb:checked'\)\.forEach\(cb => planned\.push\(\{ label: labelOf\(cb, cb\.dataset\.psid\), sub: 'permission set' \}\)\);/);
    expect(fn).toMatch(/\.uc-psg-cb:checked/);
    expect(fn).toMatch(/\.uc-grp-cb:checked/);
    expect(fn).toContain("permission sets and groups are ADDED (nothing is removed from ${esc(targetUser.Name)}). Undo by hand in Setup → Users.");
    expect(fn).toMatch(/needsCheckbox: true/);
    expect(fn).toMatch(/confirmLabel: '📋 Copy access'/);
    expect(fn).toMatch(/if \(!sure\) return;/);
  });
  it('the button is only disabled after the confirmation (a refusal leaves it usable)', () => {
    expect(fn.indexOf('if (!sure) return;')).toBeLessThan(fn.indexOf('btn.disabled    = true;'));
  });
});
