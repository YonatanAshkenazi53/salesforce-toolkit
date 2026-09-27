// ⏻ Flow switches — live finding (2026-09-22, trailheads2, fixture flows
// docs/fixtures/flowswitch-fixture, three record-triggered flows).
//
// The switch reported "✅ 3 switched OFF" straight from the PATCH result —
// nothing re-read the org. The law of this project: never claim more than
// verified. Now one FlowDefinitionView query after the PATCHes decides: a
// flow the org confirms is ✅ (and remembered for ▶ Activate); a flow the org
// still reads the other way, or an org that cannot be re-read, is ❌ and not
// remembered.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'dependency-map.js'), 'utf8');
const between = (a, b) => { const i = SRC.indexOf(a); expect(i, a).toBeGreaterThan(0); return SRC.slice(i, SRC.indexOf(b, i)); };

describe('applyFlowBulk — verified by re-reading the org', () => {
  const fn = between('async function applyFlowBulk(', '// ── API VERSIONS, ACROSS ORGS');
  it('re-reads FlowDefinitionView for the switched flows before reporting', () => {
    expect(fn).toMatch(/SELECT ApiName, ActiveVersionId, IsActive FROM FlowDefinitionView WHERE ApiName IN \(/);
    expect(fn).toMatch(/tooling: false/);
    // the re-read sits between the PATCH loop and the remember step
    const i = fn.indexOf('FROM FlowDefinitionView WHERE ApiName IN');
    expect(i).toBeLessThan(fn.indexOf('_fbRememberSave(org.key'));
    expect(i).toBeGreaterThan(fn.indexOf("body: { Metadata: { activeVersionNumber: j.version } }"));
  });
  it('runs through sftkWriteVerifiedAll with one batched re-read; done = ok only, everything else named in failed', () => {
    // campaign 3, phase 1: the write discipline helper replaces the hand-written re-read
    expect(fn).toMatch(/const batch = await sftkWriteVerifiedAll\(plan\.jobs\.map\(j => \(\{/);
    expect(fn).toMatch(/verifyAll: async results => \{/);
    expect(fn).toMatch(/return \{ ok: isOn === wantOn, text: /);
    expect(fn).toMatch(/the switch was accepted but the org still reads it/);
    expect(fn).toMatch(/const done = plan\.jobs\.filter\(\(j, k\) => batch\.results\[k\] && batch\.results\[k\]\.ok\);/);
    expect(fn).toMatch(/const failed = batch\.results\.filter\(r => !r\.ok\)\.map\(r => r\.text\);/);
    // an unreadable org: the helper marks every accepted item unverified (its own sentence); none is "done"
    expect(fn).toMatch(/if \(!q \|\| q\.error\) throw new Error\(\(q && q\.error\) \|\| 'no answer'\);/);
  });
  it('the ✅ line says it was verified', () => {
    expect(fn).toContain("switched ${mode === 'deactivate' ? 'OFF' : 'ON'} — verified by re-reading the org (");
  });
});
