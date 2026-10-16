import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// 2026-09-18 — parity inventory finding: the Transfer delete guards checked
// `=== 'production'` only, so an org whose type could not be read allowed hard
// deletes and skipped the typed confirmation. Law: fail closed on ambiguity.
const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const run = RC.slice(RC.indexOf('async function runReconcile('), RC.indexOf('async function reconcileStampPairs'));

describe('Transfer deletes fail closed on an unknown org type', () => {
  it('only a confirmed sandbox or dev org escapes the guards', () => {
    expect(run).toContain("const tgtGuarded = tgtOrgType !== 'sandbox' && tgtOrgType !== 'dev';");
  });
  it('hard delete is refused for production AND for an unconfirmed org, and says which', () => {
    expect(run).toContain('if (tgtGuarded && isHard && (delIds.length || childDelTotal)) {');
    expect(run).toContain('could not be confirmed as a sandbox or dev org, so it is treated like production');
  });
  it('the typed confirmation covers the same set', () => {
    expect(run).toContain('if (guardedWrites.tgt && tgtGuarded) {');
    expect(run).not.toMatch(/childDelTotal\) && tgtOrgType === 'production'/);
  });
});
