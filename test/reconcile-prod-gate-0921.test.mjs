// 2026-09-21 — release readiness for the Deploy view: the typed production
// confirmation in runReconcile covered deletes only. A plain insert or overwrite
// into a production target ran on one click. Law: typed confirmation for
// destructive OR production writes; ambiguity fails closed.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunction } from './extract.mjs';

const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const run = RC.slice(RC.indexOf('async function runReconcile('));
const words = extractFunction('studio-reconcile.js', 'sftkRecGuardedWrites');

describe('typed confirmation covers every write, not only deletes', () => {
  it('names every kind of target write', () => {
    const w = words({ ins: 3, ovw: 2, childIns: 5, childOvw: 1, relink: 4, del: 1, childDel: 2 }, 'Account');
    expect(w.tgt).toBe('insert 3 Account + overwrite 2 Account + insert 5 child + overwrite 1 child + re-link 4 child + delete 1 Account + delete 2 child record(s)');
    expect(w.src).toBe('');
  });
  it('a pure insert is a write', () => {
    expect(words({ ins: 10 }, 'Contact').tgt).toBe('insert 10 Contact record(s)');
  });
  it('writes back into the source are named separately', () => {
    const w = words({ pull: 2, updSrc: 1 }, 'Account');
    expect(w.src).toBe('insert 2 Account + update 1 Account record(s)');
    expect(w.tgt).toBe('');
  });
  it('nothing selected means no gate text', () => {
    expect(words({}, 'Account')).toEqual({ tgt: '', src: '' });
  });
  it('the gate sits before the first write and fails closed for both orgs', () => {
    const gate = run.indexOf('if (guardedWrites.tgt && tgtGuarded) {');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(run.indexOf("const prog = eid('dsRecProgress');"));
    expect(run).toContain("if (srcOrgType !== 'sandbox' && srcOrgType !== 'dev') {");
    // phase 4: the root inserts are the one-pass plan's root set — the ticked roots plus every parent pulled in for a deeper pick
    expect(run).toContain("ins: onePass.ins[''].size,");
    expect(run).toContain('const onePass = sftkRecOnePassPlan({ rootSel: pushIds, rootMissing: rootMissingSrc, nodes: _opNodes,');
  });
  it('the Deploy view runs through the same function, so it inherits the gate', () => {
    const DV = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
    expect(DV).toContain('runReconcile(');
    expect(DV).not.toContain('confirmTypedProd(');
  });
});
