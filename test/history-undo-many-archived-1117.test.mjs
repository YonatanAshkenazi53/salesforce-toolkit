// owner 2026-11-17, a screenshot of ↩ Undo all: "37 of 39 changes undone … 2 not undone" — the two oldest (two flows)
// answered "This entry is no longer in Activity". Activity keeps 100 entries at hand; every undo adds one, so the run
// pushed its own oldest targets into the archive before it reached them. The run now hands each entry to the undo.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const H = readFileSync(new URL('../sftk-history.js', import.meta.url), 'utf8');
const { sftkHistoryUndoMany } = extractFunctions('sftk-history.js', ['sftkHistoryUndoMany']);

describe('↩ Undo all and an entry that left the list while it ran', () => {
  it('every undo of the run is handed the entry itself', async () => {
    const seen = [];
    const list = [{ id: 'a', kind: 'tool' }, { id: 'b', kind: 'tool' }];
    const res = await sftkHistoryUndoMany(list, { undo: async (id, o) => { seen.push([id, o.entry, o.confirm]); return { ok: true, text: 'ok' }; } });
    expect(res.ok).toBe(2);
    expect(seen).toEqual([['a', list[0], false], ['b', list[1], false]]);
  });
  it('the undo uses the entry it was handed when the list no longer has it — and only when the id is the same', () => {
    expect(H).toContain("|| ((o.entry && o.entry.id === entryId && o.entry.kind === 'tool') ? o.entry : null);");
    expect(H.indexOf('|| ((o.entry && o.entry.id === entryId')).toBeLessThan(H.indexOf("if (!entry) return { ok: false, text: 'This entry is no longer in Activity.' };"));
  });
});
