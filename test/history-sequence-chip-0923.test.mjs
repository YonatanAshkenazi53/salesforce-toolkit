// History — a sequence run's cards say which sequence they belong to.
//
// Live 2026-09-23: a two-step sequence wrote one History card per step, each
// named after the step ("SFTK CX — Leads"), and "↩ Roll back sequence" on the
// first card rolled back EVERY step. Nothing on the card said so. The per-step
// entries already carry sequenceName; the card now shows it, with the warning.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HIST = readFileSync(join(root, 'studio-history.js'), 'utf8');
const PROF = readFileSync(join(root, 'studio-profiles.js'), 'utf8');

describe('sequence step cards', () => {
  it('the per-step History entries carry the sequence id and name', () => {
    expect(PROF).toMatch(/_history\.push\(\{\s*id: genId\('run'\), profileId: step\.profileId, profileName: step\.profileName,\s*sequenceId: seq\.id, sequenceName: seq\.name,/);
  });
  it('the card shows a chip naming the sequence and says the rollback undoes every step', () => {
    expect(HIST).toContain('${run.sequenceName && !isRollback ? `<span class="ds-chip" title="This run was one step of the sequence “${esc(run.sequenceName)}”. ↩ Roll back sequence undoes EVERY step of that sequence run, not only this one');
    expect(HIST).toContain('🔗 step of “${esc(run.sequenceName)}”</span>');
    // the chip sits right after the run name, before the archived chip
    expect(HIST.indexOf('🔗 step of “')).toBeGreaterThan(HIST.indexOf('<span class="ds-history-profile-name">'));
    expect(HIST.indexOf('🔗 step of “')).toBeLessThan(HIST.indexOf('📦 archived</span>'));
  });
});
