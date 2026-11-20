// QA 1.1 finding 38: Restore a backup counted entries the archive never took, and a second restore added the archived ones again.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
function load(o) {
  const opt = o || {};
  const store = { sftk_history: opt.hot || [] };
  const arch = new Map((opt.archived || []).map(e => [e.id, e]));
  const ctx = vm.createContext({
    console: { warn() {}, log() {} }, setTimeout,
    chrome: { storage: { local: { get: async k => ({ [k]: store[k] }), set: async v => { Object.assign(store, JSON.parse(JSON.stringify(v))); } } } },
    sftkHistorySplit: (list, cap) => (list.length <= cap ? { keep: list, overflow: [] } : { keep: list.slice(-cap), overflow: list.slice(0, list.length - cap) }),
    sftkArchPut: async l => { if (opt.archBroken) throw new Error('no IndexedDB'); for (const e of l) arch.set(e.id, JSON.parse(JSON.stringify(e))); return l.length; },
    sftkArchList: async () => { if (opt.archBroken) throw new Error('no IndexedDB'); return [...arch.values()]; },
  });
  if (opt.studio) {
    ctx._history = opt.hot || [];
    ctx.saves = 0;
    ctx.storageSaveHistory = async () => { ctx.saves++; store.sftk_history = JSON.parse(JSON.stringify(ctx._history)); };
  }
  vm.runInContext(read('sftk-history.js'), ctx);
  return { H: ctx, store, arch };
}
const at = n => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
const fc = n => ({ id: `fc_${n}`, kind: 'tool', tool: 'Field Cleaner', profileName: `change ${n}`, targetOrg: 'https://a.my.salesforce.com', startedAt: at(n), toolUndo: { steps: [{}] } });
const run = n => ({ id: `run_${n}`, profileName: 'Accounts', startedAt: at(1000 + n), summary: {} });
const plain = v => JSON.parse(JSON.stringify(v));

describe('Restore a backup past the cap', () => {
  it('the archive takes the oldest; every restored entry is listed with its Undo; a second restore adds nothing', async () => {
    const { H, store, arch } = load({ hot: Array.from({ length: 60 }, (_, i) => run(i)) });
    const file = Array.from({ length: 100 }, (_, i) => fc(i));
    const res = await H.sftkHistoryRestoreBackup(file, 'n');
    expect(plain(res)).toEqual({ added: 100, skipped: 0, archived: 60, notKept: 0 });
    expect(store.sftk_history).toHaveLength(100);   // SFTK_HISTORY_CAP
    expect(arch.size).toBe(60);
    // all 100 are in what the Toolkit lists (list + archive), each still undoable
    const all = await H.sftkHistoryAll();
    expect(all.filter(e => e.tool === 'Field Cleaner' && !H.sftkToolUndoState(e).disabled)).toHaveLength(100);
    const second = await H.sftkHistoryRestoreBackup(file, 'n2');
    expect(plain(second)).toEqual({ added: 0, skipped: 100, archived: 0, notKept: 0 });
    expect(arch.size).toBe(60);
  });
  it('an archive that cannot be written: nothing listed is dropped, only what fits is restored, and the rest is counted as not kept', async () => {
    const hot = Array.from({ length: 60 }, (_, i) => run(i));
    const { H, store, arch } = load({ hot, archBroken: true });
    const file = Array.from({ length: 100 }, (_, i) => fc(i));
    const res = await H.sftkHistoryRestoreBackup(file, 'n');
    expect(plain(res)).toEqual({ added: 40, skipped: 0, archived: 0, notKept: 60 });
    expect(arch.size).toBe(0);
    expect(store.sftk_history).toHaveLength(100);
    expect(store.sftk_history.filter(e => e.id.startsWith('run_'))).toHaveLength(60);   // every entry that was here is still here
    // the newest 40 of the file are the ones that came back
    expect(store.sftk_history.filter(e => e.id.startsWith('fc_')).map(e => e.id)).toEqual(file.slice(60).map(e => e.id));
  });
  it('a full list and no archive: nothing is restored and nothing is written', async () => {
    const hot = Array.from({ length: 100 }, (_, i) => run(i));
    const { H, store } = load({ hot, archBroken: true });
    const before = JSON.stringify(store.sftk_history);
    expect(plain(await H.sftkHistoryRestoreBackup([fc(1), fc(2)], 'n'))).toEqual({ added: 0, skipped: 0, archived: 0, notKept: 2 });
    expect(JSON.stringify(store.sftk_history)).toBe(before);
  });
  it('Data Studio: the same count, and the overflow is in the archive before the list is saved', async () => {
    const { H, arch } = load({ studio: true, hot: Array.from({ length: 90 }, (_, i) => run(i)) });
    const res = await H.sftkHistoryRestoreBackup(Array.from({ length: 25 }, (_, i) => fc(i)), 'n');
    expect(plain(res)).toEqual({ added: 25, skipped: 0, archived: 15, notKept: 0 });
    expect(H._history).toHaveLength(100);
    expect(arch.size).toBe(15);
    expect(H.saves).toBe(1);
  });
  it('the merge skips an id the archive already holds', () => {
    const { H } = load();
    const m = H.sftkHistoryMergeBackup([fc(3)], [fc(1), fc(2), fc(3)], 'z', new Set(['fc_1']));
    expect(m).toMatchObject({ added: 1, skipped: 2 });
    expect(Array.from(m.addedIds)).toEqual(['fc_2']);
  });
});
