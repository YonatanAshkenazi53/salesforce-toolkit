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

describe('_seqConfirmRun — what it says and gates', () => {
  const fn = between('function _seqConfirmRun(seq, profiles, tgtSess) {', 'async function runSequence(seqId) {');
  it('lists every step with object, child count and insert / upsert, and names the target', () => {
    expect(fn).toMatch(/profiles\.map\(p => `<li><strong>\$\{esc\(p\.name\)\}<\/strong>/);
    expect(fn).toMatch(/p\.upsert\?\.field \? `upsert on \$\{esc\(p\.upsert\.field\)\}` : 'insert'/);
    expect(fn).toContain('A sequence takes <strong>no per-record selection</strong>');
    expect(fn).toContain('↩ Roll back in History removes what this run inserted.');
  });
  it('▶ Run sequence is disabled until the acknowledgement is ticked; Cancel resolves false', () => {
    expect(fn).toContain('<button class="ds-btn ds-btn-primary" id="dsSeqGo" disabled>▶ Run sequence</button>');
    expect(fn).toMatch(/ack\?\.addEventListener\('change', \(\) => \{ if \(go\) go\.disabled = !ack\.checked; \}\);/);
    expect(fn).toMatch(/eid\('dsSeqNo'\)\?\.addEventListener\('click', \(\) => \{ closeModal\(\); resolve\(false\); \}\);/);
  });
  it('a production target asks for its typed name after the acknowledgement', () => {
    expect(fn).toMatch(/if \(typeof cachedOrgType === 'function' && cachedOrgType\(seq\.targetOrg\) === 'production'\) \{\s*const okProd = await confirmTypedProd\(tgtLabel, `run the sequence “\$\{seq\.name\}” — \$\{profiles\.length\} deployment\(s\) — into PRODUCTION`\);\s*if \(!okProd\) return resolve\(false\);/);
  });
});
