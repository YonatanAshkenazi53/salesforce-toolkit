// Sequences — ▶ Run asks before it writes (live 2026-09-23).
//
// A sequence runs whole deployments in order through the classic engine:
// every record each deployment matches is written, no per-record selection.
// ▶ Run used to start writing on the click: no summary of the steps, no
// acknowledgement, and no typed org name for a production target — the one
// write path in Data Studio without a gate.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'studio-profiles.js'), 'utf8');
const between = (a, b) => { const i = SRC.indexOf(a); expect(i, a).toBeGreaterThan(0); return SRC.slice(i, SRC.indexOf(b, i)); };

describe('runSequence — the confirmation comes before the run', () => {
  const run = between('async function runSequence(seqId) {', "type:      'SF_EXECUTE_SEQUENCE'");
  it('asks _seqConfirmRun after the sessions are known and returns when refused', () => {
    expect(run).toMatch(/const sure = await _seqConfirmRun\(seq, profiles, tgtSess\);\s*if \(!sure\) return;/);
    expect(run.indexOf('_seqConfirmRun(')).toBeGreaterThan(run.indexOf('a live session is required to run the sequence'));
    expect(run.indexOf('_seqConfirmRun(')).toBeLessThan(run.indexOf('🔗 Running “${esc(seq.name)}”'));
  });
});

// Campaign 3, phase 2: the sequence's own dialog became the shared one
// (sftkConfirmDestructive) — acknowledgement box, and the typed org name when
// sftkOrgWriteGate says the target is production or guarded as production.
describe('_seqConfirmRun — the shared confirmation', () => {
  const fn = between('function _seqConfirmRun(seq, profiles, tgtSess) {', 'async function runSequence(seqId) {');
  it('lists every step with object, child count and insert / upsert, and names the target', () => {
    expect(fn).toMatch(/items: profiles\.map\(p => \(\{ label: p\.name, sub: `\$\{p\.tree\?\.objectType \|\| '\?'\}/);
    expect(fn).toMatch(/p\.upsert\?\.field \? `upsert on \$\{p\.upsert\.field\}` : 'insert'/);
    expect(fn).toContain('A sequence takes <strong>no per-record selection</strong>');
    expect(fn).toContain('↩ Roll back in History removes what this run inserted.');
    expect(fn).toMatch(/title: `▶ Run “\$\{seq\.name\}” — \$\{profiles\.length\} step\(s\) into \$\{tgtLabel\}`/);
  });
  it('needs the acknowledgement (needsCheckbox) and asks the org gate for the typed step', () => {
    expect(fn).toMatch(/needsCheckbox: true/);
    expect(fn).toMatch(/const gate = await sftkOrgWriteGate\(seq\.targetOrg, _orgs\);/);
    expect(fn).toMatch(/production: gate\.production \? \{ label: gate\.label \|\| tgtLabel \} : null,/);
    expect(fn).toMatch(/confirmLabel: '▶ Run sequence'/);
    expect(fn).not.toContain('dsSeqGo');
  });
});
