import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// 2026-09-18 — user: "read only is not a viable feature" → after the
// assessment: "keep it". The lock stays, presented as a write lock, and
// Reconcile refuses by org and direction before anything runs.
const CO = readFileSync(new URL('../studio-core.js', import.meta.url), 'utf8');
const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const BG = readFileSync(new URL('../background.js', import.meta.url), 'utf8');

describe('the org write lock', () => {
  it('is still enforced at the service-worker chokepoint', () => {
    expect(BG).toContain('Org is marked read-only');
  });
  it('is labelled as a lock, not a mode', () => {
    expect(CO).toContain("}Lock writes`}</button>");
    expect(CO).toContain("}Unlock writes`");
    expect(CO).not.toContain("}Read-only`}</button>");
    expect(CO).toContain('A safety lock, not a mode');
  });
  it('is looked up by org identity', () => {
    const fn = CO.slice(CO.indexOf('window.sftkOrgLocked = function(orgUrl)'), CO.indexOf('window.toggleOrgReadOnly = async function'));
    expect(fn).toContain('_orgKey(u) === want');
  });
  it('a locked source switches every ← control off in Reconcile', () => {
    expect(RC.split("${srcLocked ? 'disabled' : ''}").length - 1).toBe(4);
  });
  it('▶ Run refuses by org and direction before any write', () => {
    const run = RC.slice(RC.indexOf('async function runReconcile('), RC.indexOf('async function reconcileStampPairs'));
    const i = run.indexOf('locked(profile.targetOrg) && (pushIds.length || ovwIds.length || delIds.length || childWrites)');
    const j = run.indexOf('locked(profile.sourceOrg) && (updSrcIds.length || pullIds.length)');
    expect(i).toBeGreaterThan(0); expect(j).toBeGreaterThan(i);
    expect(j).toBeLessThan(run.indexOf('sftkUndoCaptureForRun'));
  });
});
