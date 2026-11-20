// QA 1.1 finding 40: "Show older" took its bound from the hot list, so archived runs newer than an old entry put back there were never loaded.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const SH = readFileSync(new URL('../studio-history.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const { _histArchTake } = extractFunctions('studio-history.js', ['_histArchTake']);
const at = n => `2026-11-${String(n).padStart(2, '0')}T10:00:00.000Z`;
const run = n => ({ id: `run_${n}`, profileName: 'Accounts', startedAt: at(n) });
// sftk-archive.js's sftkArchList: newest first, strictly older than the bound
const archList = (rows, before, limit) => rows.filter(r => !before || r.startedAt < before).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);

describe('paging the archive', () => {
  it('runs archived after an old entry went back into the hot list are loaded, newest first', () => {
    // E (day 1) was undone and re-appended to the hot list; days 2-6 were evicted after it; E's stale copy is archived too
    const E = { ...run(1), kind: 'tool', tool: 'Field Cleaner', toolUndo: { done: { ok: true } } };
    const hot = [run(7), run(8), E];
    const archive = [run(2), run(3), run(4), run(5), run(6), { ...run(1), kind: 'tool', tool: 'Field Cleaner' }];
    const shown = [];
    let bound = null, dup = 0;
    const click = size => { const t = _histArchTake(hot, shown, archList(archive, bound, size), bound); shown.push(...t.add); dup += t.dup; bound = t.bound; return t; };
    click(3);
    expect(shown.map(e => e.id)).toEqual(['run_6', 'run_5', 'run_4']);
    expect(shown.every(e => e._archived)).toBe(true);
    expect(bound).toBe(at(4));
    click(3);
    expect(shown.map(e => e.id)).toEqual(['run_6', 'run_5', 'run_4', 'run_3', 'run_2']);
    // E's archived copy is counted, not shown: the hot list holds the current one
    expect(dup).toBe(1);
    expect(archive.length - shown.length - dup).toBe(0);   // nothing left to offer
    expect(click(3)).toMatchObject({ add: [], dup: 0, bound: at(1) });
  });
  it('a row already in the view is not added twice, and the bound never moves up', () => {
    const t = _histArchTake([], [{ ...run(5), _archived: true }], [run(5), run(4)], at(3));
    expect(t.add.map(e => e.id)).toEqual(['run_4']);
    expect(t.dup).toBe(1);
    expect(t.bound).toBe(at(3));
  });
});

describe('the Show older button', () => {
  const bar = SH.slice(SH.indexOf('async function _histFillArchBar()'), SH.indexOf("eid('dsArchExport')?.addEventListener"));
  it('asks the archive from its own bound, never from the hot list\'s oldest date', () => {
    expect(bar).toContain('const page = await sftkArchList(_archBound, 50);');
    expect(bar).toContain('const t = _histArchTake(_history, _archShown, page, _archBound);');
    expect(bar).not.toMatch(/\[\.\.\._history, \.\.\._archShown\]/);
  });
  it('the count it offers leaves out rows the hot list already holds', () => {
    expect(bar).toContain('const remaining = Math.max(0, total - _archShown.length - _archDup);');
  });
  it('emptying the view resets the paging with it', () => {
    expect(SH).toContain('function _histArchReset() { _archShown = []; _archBound = null; _archDup = 0; }');
    expect(SH.match(/^\s+_archShown = \[\];/gm)).toBeNull();
    expect(SH.match(/_histArchReset\(\);/g)).toHaveLength(2);
  });
});
