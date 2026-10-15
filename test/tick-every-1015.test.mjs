// Deploy page › "✓ Tick every insert" (user 2026-10-15, on the walkthrough: "in the
// data deployment object picker just select all, why you tick each one"). One press
// ticks every record the target lacks in every object that was read, through the
// same parent rule the per-tab "All" buttons and ↻ Retry use; nothing unread, nothing
// a parent rule blocks, nothing written.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const D = extractFunctions('studio-deploy.js', ['sftkDeployEveryInsert', 'sftkDeployRetryPicks']);
const R = extractFunctions('studio-reconcile.js', ['sftkRecChildRowState']);

const scan = {
  missingInTarget: [{ sourceId: 'a1' }, { sourceId: 'a2' }],
  changed: [{ sourceId: 'a3' }],
  children: {
    '0': { missingInTarget: [{ sourceId: 'c1', parentSrcId: 'a1' }, { sourceId: 'c2', parentSrcId: 'a3' }, { sourceId: 'c3', parentSrcId: 'zz' }] },
    '1': { missingInTarget: [] },
  },
};

describe('sftkDeployEveryInsert — every missing record of every scanned object', () => {
  it('lists the root and every child that has something to insert, by path', () => {
    expect(D.sftkDeployEveryInsert(scan)).toEqual({ '': ['a1', 'a2'], '0': ['c1', 'c2', 'c3'] });
    expect(D.sftkDeployEveryInsert(null)).toEqual({});
    expect(D.sftkDeployEveryInsert({ missingInTarget: [] })).toEqual({});
  });
  it('through the retry picker, the parent rule keeps out a child whose parent is nowhere', () => {
    const picks = D.sftkDeployRetryPicks(scan, D.sftkDeployEveryInsert(scan), R.sftkRecChildRowState);
    expect(picks.picks).toEqual({ '': ['a1', 'a2'], '0': ['c1', 'c2'] });   // c3's parent zz is not in the scan: untracked, stays out
    expect(picks.found).toBe(4);
  });
});

describe('wiring', () => {
  const DV = read('studio-deploy.js');
  it('the plan card offers the button with the count, and says unread objects are not included', () => {
    expect(DV).toMatch(/const every = sftkDeployRetryPicks\(scan, sftkDeployEveryInsert\(scan\), sftkRecChildRowState\);/);
    expect(DV).toMatch(/id="dsDepTickAll"/);
    expect(DV).toMatch(/objects not read yet are not included/);
  });
  it('the press fills the same selection sets the per-tab All buttons fill, then repaints', () => {
    const w = DV.slice(DV.indexOf("eid('dsDepTickAll')?.addEventListener"), DV.indexOf("eid('dsDepTickAll')?.addEventListener") + 700);
    expect(w).toMatch(/k === '' \? _recSel\.push : _depChildSel\(k\)\.push/);
    expect(w).toMatch(/renderDeploy\(\);/);
    expect(w).not.toMatch(/runReconcile|sendBg\(|_depRun\(|executeProfileTransfer/);   // ticks, never writes
  });
  it('the walkthrough presses it instead of walking the tabs', () => {
    const S = read('scripts/dev/video/sections.mjs');
    expect(S).toMatch(/rec\.click\('#dsDepTickAll'/);
    expect(S).not.toMatch(/for \(const o of objs\)/);
  });
});
