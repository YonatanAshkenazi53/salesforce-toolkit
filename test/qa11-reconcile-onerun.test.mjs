// QA 1.1 finding 42: a second run or a dry run cannot start while a run is on this page.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const { sftkRecRunBusyLine: busy, _recRunBtnsLock: lock, runReconcile } = extractFunctions('studio-reconcile.js', ['sftkRecRunBusyLine', '_recRunBtnsLock', 'runReconcile']);

describe('one run per page', () => {
  afterEach(() => { for (const k of ['window', 'showToast', 'eid']) delete globalThis[k]; });

  it('no run on → nothing to say', () => {
    expect(busy(false, false)).toBe('');
    expect(busy(undefined, true)).toBe('');
  });
  it('a run is on → the new one is named, with what happened and what to do next', () => {
    expect(busy(true, false)).toBe('A run is already in progress on this page — this run was not started and nothing was switched or written. Wait for the run to finish, or press ⏸ Pause and wait for it to stop, then try again.');
    expect(busy(true, true)).toContain('the dry run was not started');
  });
  it('runReconcile refuses at once: no pause step, no confirmation, the live run keeps its flag, its log and its ⏸ bar', async () => {
    const toasts = [], touched = [];
    globalThis.window = { _sftkRunActive: true, _sftkProbePaused: 'the live run’s' };
    globalThis.showToast = (t, kind) => toasts.push([t, kind]);
    globalThis.eid = id => { touched.push(id); return null; };
    let paused = 0;
    for (const probe of [false, true]) {
      const r = await runReconcile({ id: 'p' }, 'Account', {}, { probe, rulePause: { rules: [{ id: '03d' }] }, beforeWrites: async () => { paused++; return true; }, afterWrites: async () => { paused++; } });
      expect(r).toBeUndefined();
    }
    expect(paused).toBe(0);                       // the rules and flows of the live run are not switched
    expect(touched).toEqual([]);                  // #dsRecProgress and #dsRunPauseBar are not looked up, so not wiped or removed
    expect(globalThis.window._sftkRunActive).toBe(true);
    expect(globalThis.window._sftkProbePaused).toBe('the live run’s');
    expect(toasts.map(t => t[1])).toEqual(['warning', 'warning']);
    expect(toasts[1][0]).toContain('the dry run was not started');
  });
  it('the check is the first statement of the run, and is made again right before the log is taken over', () => {
    const fn = RC.slice(RC.indexOf('async function runReconcile('), RC.indexOf('\n}', RC.indexOf('async function runReconcile(')));
    const first = fn.indexOf('sftkRecRunBusyLine(window._sftkRunActive');
    const second = fn.indexOf('sftkRecRunBusyLine(window._sftkRunActive, PROBE)');
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(fn.indexOf('const _fp ='));
    expect(second).toBeGreaterThan(first);
    const between = fn.slice(second, fn.indexOf('window._sftkRunActive = true;'));
    expect(between).not.toMatch(/\bawait\b/);     // nothing waits between the check and the flag
    expect(between.indexOf('prog.innerHTML')).toBeGreaterThan(0);
    expect(fn.indexOf('go = await opts.beforeWrites(')).toBeGreaterThan(second);
  });
  it('both ▶ and 🧪 are locked for the run and released by a fresh lookup — a repaint replaces the nodes', () => {
    const nodes = { dsRecRunBtn: { disabled: false }, dsRecProbeBtn: { disabled: false } };
    globalThis.eid = id => nodes[id] || null;
    lock(true);
    expect([nodes.dsRecRunBtn.disabled, nodes.dsRecProbeBtn.disabled]).toEqual([true, true]);
    nodes.dsRecRunBtn = { disabled: true };       // the page repainted during the run
    lock(false);
    expect([nodes.dsRecRunBtn.disabled, nodes.dsRecProbeBtn.disabled]).toEqual([false, false]);
    delete nodes.dsRecProbeBtn;                   // a page without the dry run button
    expect(() => lock(true)).not.toThrow();
    const fn = RC.slice(RC.indexOf('async function runReconcile('), RC.indexOf('\n}', RC.indexOf('async function runReconcile(')));
    expect(fn).not.toMatch(/\brunBtn\b/);         // no captured button node is left in the run
    expect((fn.match(/_recRunBtnsLock\(false\);/g) || []).length).toBe(3);
    expect(fn).toContain('_recRunBtnsLock(true);');
  });
});
