import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunction } from './extract.mjs';

const DM = readFileSync(new URL('../dependency-map.js', import.meta.url), 'utf8');
const PO = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const SC = readFileSync(new URL('../studio-scan.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../studio.css', import.meta.url), 'utf8');

describe('Dependencies: a managed subflow target never stays "Not found" (2026-09-18)', () => {
  it('the tree remembers it painted before the managed list landed', () => {
    expect(DM).toContain('_treePaintedBeforeManaged = (_managedFlows === null);');
    expect(DM).toContain('function treeStaleForManaged() {');
    expect(DM).toMatch(/loadManagedFlows,\s+treeStaleForManaged,/);
  });
  it('the popup repaints once the list lands, only when it changes something', () => {
    const i = PO.indexOf('DependencyMap.loadManagedFlows(loadOrgUrl, loadSid)');
    const chain = PO.slice(i, i + 700);
    expect(chain).toContain('DependencyMap.treeStaleForManaged?.()');
    expect(chain).toContain('renderDependenciesTab();');
    expect(chain).toContain('loadOrgUrl === orgUrl');
  });
});

describe('Retry failed never opens a run with an unfiltered parent (2026-09-18)', () => {
  const split = extractFunction('studio-scan.js', 'sftkRetrySplit');
  it('a failed root is safe; a failed child under an unfiltered root is not', () => {
    expect(split({ '': { recordIds: ['a'] } })).toEqual({ safe: [''], unsafe: [] });
    expect(split({ '0': { recordIds: ['c'] } })).toEqual({ safe: [], unsafe: ['0'] });
  });
  it('a child is safe only when EVERY ancestor is filtered', () => {
    expect(split({ '': {}, '0': {} })).toEqual({ safe: ['', '0'], unsafe: [] });
    expect(split({ '': {}, '0.1': {} })).toEqual({ safe: [''], unsafe: ['0.1'] });
    expect(split({ '': {}, '0': {}, '0.1': {} }).unsafe).toEqual([]);
    expect(split({})).toEqual({ safe: [], unsafe: [] });
  });
  it('child-only failures go to Transfer; mixed retries drop the unsafe nodes and say so', () => {
    const fn = SC.slice(SC.indexOf('window.retryFailedRun = function(runId)'), SC.indexOf('function sftkRetrySplit(filters)'));
    expect(fn).toContain('if (split.unsafe.length && !split.safe.length) {');
    expect(fn).toContain('window.openReconcile?.(profile.id');
    expect(fn).toContain('for (const k of split.unsafe) delete filters[k];');
    expect(fn).toContain('are NOT in this retry');
    expect(fn.indexOf('sftkRetrySplit(filters)')).toBeLessThan(fn.indexOf('_transferNodeFilters  = filters;'));
  });
});

describe('Run page footer stays inside its card (2026-09-18)', () => {
  it('wraps, and nothing in it breaks across lines', () => {
    const i = CSS.indexOf('.ds-transfer-footer {');
    expect(CSS.slice(i, i + 200)).toContain('flex-wrap: wrap;');
    expect(CSS).toContain('.ds-transfer-footer .ds-btn, .ds-transfer-footer .ds-transfer-option-label { white-space: nowrap; }');
  });
});
