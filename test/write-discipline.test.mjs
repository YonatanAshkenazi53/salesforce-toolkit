// The write discipline, enforced (campaign 3, phase 1).
//
// Every request that changes Salesforce must sit inside a sftkWriteVerified /
// sftkWriteVerifiedAll `write:` arm, or carry `// verified-by: <what re-reads
// the org>` within three lines above it. Everything else is an offender.
//
// The baseline below is the offender count per file on the day the helper
// landed (2026-09-27). It only goes DOWN: a file with more offenders than its
// baseline fails; a file with fewer fails too, with the message to lower the
// number, so the count stays exact and no migration is forgotten. A file not
// listed must have zero.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRITE_TYPES = /type:\s*'(SF_PATCH|SF_TOOLING_DELETE|SF_REST_DELETE|SF_HARD_DELETE|SF_COLLECTIONS_UPDATE|SF_COLLECTIONS_DELETE|SF_METADATA_DEPLOY|SF_CREATE_FLOW|SF_TOOLING_POST|SF_REST_POST|SF_EXECUTE_PROFILE_TRANSFER|SF_EXECUTE_SEQUENCE)'/;

// UI files only: background.js is the transport, not a caller.
const UI_FILES = readdirSync(root).filter(f => f.endsWith('.js') && !f.startsWith('_') && !f.startsWith('eslint')
  && !['background.js', 'content.js', 'trusted-types-policy.js', 'sftk-history.js'].includes(f));   // sftk-history runs undo steps THROUGH sftkWriteVerified

const BASELINE = {
  // 2026-09-27, end of phase 1: zero everywhere. The engine call sites are
  // covered by executeProfileTransfer's own post-run re-read (summary[obj].verified).
};

function offenders(file) {
  const lines = readFileSync(join(root, file), 'utf8').split('\n');
  const out = [];
  lines.forEach((line, i) => {
    if (!WRITE_TYPES.test(line)) return;
    const above = lines.slice(Math.max(0, i - 3), i).join('\n');
    if (/verified-by:/.test(above)) return;
    // inside a `write:` arm of the helper: the arm opens within the 12 lines above
    const arm = lines.slice(Math.max(0, i - 12), i + 1).join('\n');
    if (/\bwrite:\s*(async\s*)?\(|\bwrite\s*\(\)\s*\{|\bwrite:\s*\(\)\s*=>/.test(arm)) return;
    out.push(`${file}:${i + 1}  ${line.trim().slice(0, 90)}`);
  });
  return out;
}

describe('every Salesforce write goes through sftkWriteVerified (or names its re-read)', () => {
  for (const file of UI_FILES) {
    it(`${file}: ${BASELINE[file] || 0} unmigrated write(s), no more and no fewer`, () => {
      const found = offenders(file);
      const expected = BASELINE[file] || 0;
      const msg = found.length > expected
        ? `NEW unverified write(s) in ${file} — wrap them in sftkWriteVerified({ write, verify }) or add "// verified-by: <re-read>" above:\n  ${found.join('\n  ')}`
        : found.length < expected
          ? `${file} has ${found.length} unmigrated write(s) now — lower its BASELINE to ${found.length}`
          : '';
      expect(found.length, msg).toBe(expected);
    });
  }
  it('the helper itself is loaded by both pages, before the tools', () => {
    for (const page of ['popup.html', 'studio.html']) {
      const html = readFileSync(join(root, page), 'utf8');
      const i = html.indexOf('src="sftk-write.js"');
      expect(i, page).toBeGreaterThan(0);
      for (const tool of ['field-cleaner.js', 'dependency-map.js', 'user-copy.js', 'studio-picklists.js', 'studio-profiles.js']) {
        const j = html.indexOf(`src="${tool}"`);
        if (j > 0) expect(i, `${tool} before the helper in ${page}`).toBeLessThan(j);
      }
    }
  });
});
