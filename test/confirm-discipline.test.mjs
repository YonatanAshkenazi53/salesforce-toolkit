// One confirmation, enforced (campaign 3, phase 2).
//
// Every sftkWriteVerified / sftkWriteVerifiedAll call must be preceded, within
// eight lines, by `sftkConfirmDestructive(` (the shared dialog: acknowledgement,
// optional required word, and the typed org name when the target is treated as
// production) or by `// confirmed-by: <the function that asked>`. The marker
// is for writes whose dialog lives in the caller (a wizard's Go button, the
// Deploy page, the rollback plan); a reviewer checks it names a real dialog.
//
// The baseline is the offender count per file on the day the rule landed
// (2026-09-27). Exact and only going down, like test/write-discipline.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI_FILES = readdirSync(root).filter(f => f.endsWith('.js') && !f.startsWith('_') && !f.startsWith('eslint')
  && !['background.js', 'content.js', 'trusted-types-policy.js', 'sftk-write.js', 'sftk-confirm.js', 'sftk-history.js'].includes(f));   // sftk-history asks with the dialog inside sftkHistoryUndo

const BASELINE = {
  // 2026-09-27, end of phase 2: zero everywhere. Every verified write is asked
  // by the shared dialog, names its dialog, or is marked not-destructive with a reason.
};

function offenders(file) {
  const lines = readFileSync(join(root, file), 'utf8').split('\n');
  const out = [];
  lines.forEach((line, i) => {
    if (!/\bsftkWriteVerified(All)?\(/.test(line)) return;
    const above = lines.slice(Math.max(0, i - 8), i).join('\n');
    // `// not-destructive: <why>` is the visible exception for a write that needs no
    // dialog (a debug trace that expires on its own); a reviewer reads the reason.
    if (/sftkConfirmDestructive\(|confirmed-by:|not-destructive:/.test(above)) return;
    out.push(`${file}:${i + 1}  ${line.trim().slice(0, 90)}`);
  });
  return out;
}

describe('every verified write is preceded by the shared confirmation (or names its dialog)', () => {
  for (const file of UI_FILES) {
    it(`${file}: ${BASELINE[file] || 0} unconfirmed write(s), no more and no fewer`, () => {
      const found = offenders(file);
      const expected = BASELINE[file] || 0;
      const msg = found.length > expected
        ? `NEW unconfirmed write(s) in ${file} — ask with sftkConfirmDestructive({ …, production: await sftkOrgWriteGate(orgUrl) }) first, or add "// confirmed-by: <dialog>" above:\n  ${found.join('\n  ')}`
        : found.length < expected ? `${file} has ${found.length} unconfirmed write(s) now — lower its BASELINE to ${found.length}` : '';
      expect(found.length, msg).toBe(expected);
    });
  }
  it('the shared dialog is loaded by both pages, after the org-identity helper and before the tools', () => {
    for (const page of ['popup.html', 'studio.html']) {
      const html = readFileSync(join(root, page), 'utf8');
      const c = html.indexOf('src="sftk-confirm.js"'), o = html.indexOf('src="sftk-org-identity.js"');
      expect(c, page).toBeGreaterThan(o);
      for (const tool of ['field-cleaner.js', 'user-copy.js', 'studio-picklists.js', 'studio-profiles.js']) {
        const j = html.indexOf(`src="${tool}"`);
        if (j > 0) expect(c, `${tool} before the dialog in ${page}`).toBeLessThan(j);
      }
    }
  });
});
