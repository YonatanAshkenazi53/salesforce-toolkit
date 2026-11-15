// Release QA 2026-11-14 — studio-core.js / studio.css.
// 1. Data Studio kept a stale copy of a tool entry the popup had undone and
//    wrote it back on its next save, so the popup offered Undo a second time.
// 2. Connected Orgs: the action buttons never wrapped and squeezed the org
//    name into a ~120 px column.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunctions } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcOf = f => readFileSync(join(root, f), 'utf8');

describe('_historyAdoptToolUpdates — the popup\'s done mark is never lost', () => {
  const { _historyAdoptToolUpdates } = extractFunctions('studio-core.js', ['_historyAdoptToolUpdates']);
  const tool = (id, done) => ({ id, kind: 'tool', toolUndo: done ? { steps: [], done: { at: 'x', ok: true, entryId: 'u1' } } : { steps: [] } });

  it('an existing entry that came back with toolUndo.done replaces the stale copy', () => {
    const local = [tool('a', false)];
    expect(_historyAdoptToolUpdates(local, [tool('a', true)], true)).toBe(true);
    expect(local[0].toolUndo.done.entryId).toBe('u1');
  });

  it('a copy without done never overwrites one that has it', () => {
    const local = [tool('a', true)];
    expect(_historyAdoptToolUpdates(local, [tool('a', false)], true)).toBe(false);
    expect(local[0].toolUndo.done).toBeTruthy();
  });

  it('new tool ids are added on a storage event, not on the save-time re-read', () => {
    const live = [];
    expect(_historyAdoptToolUpdates(live, [tool('n', false)], true)).toBe(true);
    expect(live.map(h => h.id)).toEqual(['n']);
    const save = [];
    expect(_historyAdoptToolUpdates(save, [tool('n', false)], false)).toBe(false);
    expect(save).toEqual([]);
  });

  it('non-tool entries and junk are ignored', () => {
    const local = [{ id: 'r', kind: 'transfer' }];
    expect(_historyAdoptToolUpdates(local, [{ id: 'r', kind: 'transfer', toolUndo: { done: {} } }, null, {}], true)).toBe(false);
    expect(_historyAdoptToolUpdates(local, null, true)).toBe(false);
    expect(_historyAdoptToolUpdates(null, [], true)).toBe(false);
  });

  it('the listener and storageSaveHistory both go through it', () => {
    const src = srcOf('studio-core.js');
    expect(src).toContain("_historyAdoptToolUpdates(_history, changes.sftk_history.newValue || [], true)");
    const save = src.slice(src.indexOf('async function storageSaveHistory('));
    const reread = save.indexOf('_historyAdoptToolUpdates(_history, cur, false)');
    expect(reread).toBeGreaterThan(-1);
    expect(reread).toBeLessThan(save.indexOf('chrome.storage.local.set({ sftk_history'));
  });
});

describe('Connected Orgs card wraps its actions instead of squeezing the name', () => {
  const css = srcOf('studio.css');
  it('row and action group wrap; the name keeps a minimum width', () => {
    expect(css).toMatch(/\.ds-org-row \{ flex-wrap: wrap; \}/);
    expect(css).toMatch(/\.ds-org-row-info \{[^}]*min-width: min\(260px, 100%\)/);
    expect(css).toMatch(/\.ds-org-row-actions \{[^}]*flex-wrap: wrap/);
  });
});
