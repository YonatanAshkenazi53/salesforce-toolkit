// QA 1.1 finding 41: "Export all (incl. archive)" wrote the stale archived copy of an entry the hot list also holds.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const SH = readFileSync(new URL('../studio-history.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const { _histExportAllEntries } = extractFunctions('studio-history.js', ['_histExportAllEntries']);
const at = n => `2026-11-${String(n).padStart(2, '0')}T10:00:00.000Z`;

describe('the entries of the full export', () => {
  it('an id in both tiers is written once, from the hot list — the copy that carries the undo', () => {
    const stale = { id: 'fc_1', kind: 'tool', tool: 'Field Cleaner', startedAt: at(1), toolUndo: { steps: [{}] } };
    const live = { ...stale, toolUndo: { steps: [{}], done: { at: at(9), ok: true, entryId: 'u1' } } };
    const undo = { id: 'u1', kind: 'tool', tool: 'Field Cleaner', startedAt: at(9), undoOf: 'fc_1' };
    const out = _histExportAllEntries([stale, { id: 'run_2', startedAt: at(2) }], [{ id: 'run_8', startedAt: at(8) }, undo, live]);
    expect(out.map(e => e.id)).toEqual(['u1', 'run_8', 'run_2', 'fc_1']);   // newest first
    expect(out.find(e => e.id === 'fc_1')).toBe(live);
    expect(out.find(e => e.id === 'fc_1').toolUndo.done.entryId).toBe('u1');
  });
  it('archived-only and hot-only entries are all there; empty tiers are fine', () => {
    expect(_histExportAllEntries([{ id: 'a', startedAt: at(1) }], [{ id: 'b', startedAt: at(2) }, null]).map(e => e.id)).toEqual(['b', 'a']);
    expect(_histExportAllEntries(null, null)).toEqual([]);
  });
  it('the export button uses it', () => {
    const btn = SH.slice(SH.indexOf("eid('dsArchExport')?.addEventListener"));
    expect(btn).toContain('const entries = _histExportAllEntries(arch, _history);');
    expect(btn).not.toContain('archIds');
  });
});
