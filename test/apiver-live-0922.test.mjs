// ⚙ API versions — two live findings (2026-09-22, trailheads2, fixture flows
// docs/fixtures/apiver-fixture: A 60 Active, B 62 Active, C 58 Draft → 67.0).
//
// 1. The Draft flow was rewritten IN PLACE by the deploy (v1 read API 67
//    afterwards, no v2) and was reported "no new version appeared … nothing
//    changed for this flow" — false. The org's re-read is the proof: same
//    version number, not active before, now at the target → verified.
// 2. The summary read "2 flow(s) changed across 0 org(s); 1 org(s)
//    unchanged" after two flows had verifiably changed — an org whose package
//    was accepted counted as unchanged because one verdict was a warning.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'dependency-map.js'), 'utf8');
const between = (a, b) => { const i = SRC.indexOf(a); expect(i, a).toBeGreaterThan(0); return SRC.slice(i, SRC.indexOf(b, i)); };

describe('avVerifyAndActivate — a version that is not active is rewritten in place', () => {
  const fn = between('async function avVerifyAndActivate(', 'async function applyApiVerChange(');
  it('counts the same version number at the target API as verified when the flow was not active', () => {
    const i = fn.indexOf('if (newest && !c.wasActive && newest.versionNumber === c.prevVersion && newest.num === want) {');
    expect(i).toBeGreaterThan(0);
    expect(fn.slice(i, i + 500)).toMatch(/ok: true, text: `\$\{c\.apiName\}: v\$\{newest\.versionNumber\} \(\$\{newest\.status \|\| 'not active'\}\) was rewritten in place at API \$\{target\}/);
    expect(fn.slice(i, i + 500)).toMatch(/verified by re-reading the org/);
    // the in-place check comes BEFORE the "no new version" verdict
    expect(i).toBeLessThan(fn.indexOf('no new version appeared after the deploy'));
  });
  it('an ACTIVE flow with no new version is still a failure, now naming the API it reads', () => {
    expect(fn).toMatch(/no new version appeared after the deploy \(latest is still v\$\{c\.prevVersion\}\$\{newest \? ` at API \$\{newest\.apiVersion \|\| '\?'\}` : ''\}\)/);
  });
});

describe('applyApiVerChange — the summary counts what happened', () => {
  const fn = between('async function applyApiVerChange(', 'function buildReportObject(');
  it('an accepted package counts its org as changed; warnings are counted per flow, not per org', () => {
    expect(fn).toContain('let orgsOk = 0, orgsFailed = 0, flowsOk = 0, flowsWarn = 0;');
    const i = fn.indexOf('const verdicts = await avVerifyAndActivate(org, changed, target, say, journal);');
    const after = fn.slice(i, i + 1000);
    expect(after).toMatch(/orgsOk\+\+;/);
    expect(after).not.toMatch(/if \(okAll\) orgsOk\+\+; else orgsFailed\+\+;/);
    expect(after).toMatch(/flowsOk \+= okN; flowsWarn \+= verdicts\.length - okN;/);
  });
  it('the last line says verified / with a warning / refused, never "changed across 0 org(s)"', () => {
    expect(fn).toMatch(/\$\{flowsOk\} flow\(s\) changed and verified\$\{flowsWarn \? `, \$\{flowsWarn\} with a warning above` : ''\}, across \$\{orgsOk\} org\(s\); \$\{orgsFailed\} org\(s\) refused the package \(unchanged\)\./);
    expect(fn).not.toContain('org(s) unchanged. The table');
  });
  it('the package line says "written", because a Draft is overwritten, not added', () => {
    expect(fn).toContain('flow version(s) written at API ${target}. Verifying what is actually running now…');
    expect(fn).not.toContain('new flow version(s) created at API');
  });
});
