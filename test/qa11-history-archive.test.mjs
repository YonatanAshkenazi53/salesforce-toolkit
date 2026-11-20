// QA 1.1 finding 5: a Toolkit change pushed past the 100-entry cap could not be seen, undone, backed up or cleared.
// The cap is shared by deployments, every tool and every undo; what falls off goes to the on-PC archive. A Toolkit
// tool's archived entries are now part of what sftkHistoryAll answers, Clear and delete reach the archive, and an
// archived change that is undone is marked where it is.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const ORG = 'https://a.my.salesforce.com';

// The whole file in one context, with a stand-in for sftk-archive.js (a Map keyed by id, like the object store).
function load(o) {
  const opt = o || {};
  const store = { sftk_history: opt.hot || [] };
  const arch = new Map((opt.archived || []).map(e => [e.id, JSON.parse(JSON.stringify(e))]));
  const ctx = vm.createContext({
    console: { warn() {}, log() {} }, setTimeout,
    chrome: { storage: { local: {
      get: async k => ({ [k]: store[k] }),
      set: async v => { Object.assign(store, JSON.parse(JSON.stringify(v))); },
    } } },
    sftkHistorySplit: (list, cap) => (list.length <= cap ? { keep: list, overflow: [] } : { keep: list.slice(-cap), overflow: list.slice(0, list.length - cap) }),
    sftkArchPut: async l => { for (const e of l) arch.set(e.id, JSON.parse(JSON.stringify(e))); return l.length; },
    sftkArchList: async () => { if (opt.archBroken) throw new Error('no IndexedDB'); return [...arch.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))); },
    _sftkArchTx: async (mode, fn) => { fn({ delete: id => arch.delete(id) }); },
    // the write discipline, reduced to: send the step, call it verified, tell the journal
    sftkWriteVerified: async spec => { await spec.write(); const r = { ok: true, accepted: true, verified: true, text: spec.describe }; ctx.sftkHistoryNote(spec.journal, r, spec.describe); return r; },
  });
  if (opt.studio) {
    ctx._history = opt.hot || [];
    ctx.storageSaveHistory = async () => { store.sftk_history = JSON.parse(JSON.stringify(ctx._history)); };
  }
  vm.runInContext(read('sftk-history.js'), ctx);
  return { H: ctx, store, arch, ctx };
}
const at = n => `2026-11-${String(1 + Math.floor(n / 60)).padStart(2, '0')}T10:${String(n % 60).padStart(2, '0')}:00.000Z`;
const fc = (n, subject) => ({ id: `fc_${n}`, kind: 'tool', tool: 'Field Cleaner', profileName: `change ${n}`, subject: subject || 'Account.A__c', row: `row_${n}`,
  targetOrg: ORG, startedAt: at(n), status: 'success', what: [{ describe: 'x', ok: true, accepted: true, verified: true, text: 'x' }],
  toolUndo: { steps: [{ describe: `put ${n} back`, msg: { type: 'SF_PATCH', path: 'p', body: {} }, verify: null, orgUrl: '' }], note: '' } });
const flow = n => ({ id: `fl_${n}`, kind: 'tool', tool: 'Flow delete', profileName: 'flows', targetOrg: ORG, startedAt: at(n), status: 'success', toolUndo: { none: 'deleted' } });
const run = n => ({ id: `run_${n}`, profileName: 'Accounts', targetOrg: ORG, startedAt: at(n), status: 'success', summary: {} });
const ids = l => Array.from(l, e => e.id);

describe('what a tool lists', () => {
  it('the archived Toolkit entries come first (they are older); an archived deployment is not one of them', async () => {
    const { H } = load({ hot: [run(50), fc(51), fc(52)], archived: [fc(2), run(3), fc(1), flow(4)] });
    expect(ids(await H.sftkHistoryAll())).toEqual(['fc_1', 'fc_2', 'fl_4', 'run_50', 'fc_51', 'fc_52']);
  });
  it('an entry held in both places is listed once, as the list at hand has it', async () => {
    const hot = { ...fc(7), profileName: 'the hot copy' };
    const { H } = load({ hot: [hot], archived: [fc(7), fc(6)] });
    const all = await H.sftkHistoryAll();
    expect(ids(all)).toEqual(['fc_6', 'fc_7']);
    expect(all[1].profileName).toBe('the hot copy');
  });
  it('with nothing archived, or an archive that cannot be read, the answer is the list at hand', async () => {
    expect(ids(await load({ hot: [fc(1)] }).H.sftkHistoryAll())).toEqual(['fc_1']);
    expect(ids(await load({ hot: [fc(1)], archived: [fc(0)], archBroken: true }).H.sftkHistoryAll())).toEqual(['fc_1']);
  });
  it('in Data Studio the archived entries are never pushed into its own list', async () => {
    const { H, ctx } = load({ studio: true, hot: [run(50), fc(51)], archived: [fc(1)] });
    const all = await H.sftkHistoryAll();
    expect(ids(all)).toEqual(['fc_1', 'run_50', 'fc_51']);
    expect(ids(ctx._history)).toEqual(['run_50', 'fc_51']);
    expect(all).not.toBe(ctx._history);
  });
  it('two runs of 60 on two fields: Undo all for the first field still finds all 60, and so does each row', async () => {
    // field A's 60 changes, then field B's 60: the list keeps the newest 100, so A's first 20 are in the archive
    const everything = [...Array.from({ length: 60 }, (_, i) => fc(i, 'Account.A__c')), ...Array.from({ length: 60 }, (_, i) => fc(60 + i, 'Account.B__c'))];
    const { H } = load({ hot: everything.slice(-100), archived: everything.slice(0, 20) });
    const all = await H.sftkHistoryAll();
    const a = H.sftkHistoryUndoableFor(all, { tool: 'Field Cleaner', orgUrl: ORG, subject: 'Account.A__c' });
    expect(a).toHaveLength(60);
    expect(a[a.length - 1].id).toBe('fc_0');   // newest first: the oldest, archived change is undone last
    expect(ids(H.sftkHistoryUndoableForRow(all, { tool: 'Field Cleaner', orgUrl: ORG, subject: 'Account.A__c', row: 'row_3' }))).toEqual(['fc_3']);
    expect(H.sftkHistoryBackupOf(all, 'fields', 'now').count).toBe(120);   // ⬇ Back up reads the same list
  });
});

describe('an archived change is undone like any other', () => {
  const send = async m => (m.type === 'GET_ALL_SF_SESSIONS' ? { sessions: [{ orgUrl: ORG, sid: 's', label: 'A' }] } : {});
  it('found by its id alone; the done mark is written to the archive and the entry does not move into the list', async () => {
    const { H, store, arch } = load({ hot: [fc(50), fc(51)], archived: [fc(1)] });
    const r = await H.sftkHistoryUndo('fc_1', { confirm: false, send });
    expect(r.ok).toBe(true);
    expect(arch.get('fc_1').toolUndo.done).toMatchObject({ ok: true, entryId: r.undoEntry.id });
    expect(ids(store.sftk_history)).toEqual(['fc_50', 'fc_51', r.undoEntry.id]);
    // …so it is no longer offered: the next read shows it undone
    expect(H.sftkHistoryUndoableFor(await H.sftkHistoryAll(), { tool: 'Field Cleaner', orgUrl: ORG, subject: 'Account.A__c' }).map(e => e.id)).toEqual(['fc_51', 'fc_50']);
  });
  it('an entry in the list at hand is still marked in the list', async () => {
    const { H, store, arch } = load({ hot: [fc(50)], archived: [fc(1)] });
    const r = await H.sftkHistoryUndo('fc_50', { confirm: false, send });
    expect(r.ok).toBe(true);
    expect(store.sftk_history[0].toolUndo.done.ok).toBe(true);
    expect(arch.has('fc_50')).toBe(false);
  });
  it('the undo itself pushes its target out of a full list: the target is marked in the archive, once', async () => {
    const hot = Array.from({ length: 100 }, (_, i) => fc(i));
    const { H, store, arch } = load({ hot });
    const r = await H.sftkHistoryUndo('fc_0', { confirm: false, send });
    expect(r.ok).toBe(true);
    expect(store.sftk_history).toHaveLength(100);
    expect(store.sftk_history.some(e => e.id === 'fc_0')).toBe(false);
    expect(arch.get('fc_0').toolUndo.done.ok).toBe(true);
  });
});

describe('clear and delete reach the archive', () => {
  it('Clear removes the tool’s archived entries too and counts them; other tools and deployments stay in both places', async () => {
    const { H, store, arch } = load({ hot: [run(50), fc(51), flow(52)], archived: [fc(1), fc(2), flow(3), run(4)] });
    expect(await H.sftkHistoryClearTab('fields')).toBe(3);
    expect(ids(store.sftk_history)).toEqual(['run_50', 'fl_52']);
    expect([...arch.keys()].sort()).toEqual(['fl_3', 'run_4']);
  });
  it('Clear of every tool leaves only deployments in the archive', async () => {
    const { H, store, arch } = load({ hot: [run(50), fc(51)], archived: [fc(1), flow(3), run(4)] });
    expect(await H.sftkHistoryClearTab('*')).toBe(3);
    expect(ids(store.sftk_history)).toEqual(['run_50']);
    expect([...arch.keys()]).toEqual(['run_4']);
  });
  it('in Data Studio too', async () => {
    const { H, ctx, arch } = load({ studio: true, hot: [run(50), fc(51)], archived: [fc(1), run(4)] });
    expect(await H.sftkHistoryClearTab('fields')).toBe(2);
    expect(ids(ctx._history)).toEqual(['run_50']);
    expect([...arch.keys()]).toEqual(['run_4']);
  });
  it('one archived entry deleted: it is gone from the archive and the answer is true; an unknown id is false', async () => {
    const { H, store, arch } = load({ hot: [fc(51)], archived: [fc(1), fc(2)] });
    expect(await H.sftkHistoryRemove('fc_1')).toBe(true);
    expect([...arch.keys()]).toEqual(['fc_2']);
    expect(ids(store.sftk_history)).toEqual(['fc_51']);
    expect(await H.sftkHistoryRemove('nope')).toBe(false);
    expect(await H.sftkHistoryRemove('fc_51')).toBe(true);
    expect(store.sftk_history).toEqual([]);
  });
  it('a page without the archive clears and deletes as before', async () => {
    const store = { sftk_history: [fc(1), run(2)] };
    const ctx = vm.createContext({ console, chrome: { storage: { local: { get: async k => ({ [k]: store[k] }), set: async v => { Object.assign(store, v); } } } } });
    vm.runInContext(read('sftk-history.js'), ctx);
    expect(await ctx.sftkHistoryClearTab('fields')).toBe(1);
    expect(await ctx.sftkHistoryRemove('run_2')).toBe(true);
    expect(await ctx.sftkHistoryRemove('run_2')).toBe(false);
  });
});
