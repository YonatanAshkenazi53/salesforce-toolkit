// A tool's History can be cleared, backed up to a file WITH its undo, and restored from that file
// (owner 2026-11-16: "we should add a button that clears the history" · "and a way for users to backup their
// activity" · "along with undo").
//   Clear     removes one tool's entries only; another tool's and every deployment stay.
//   Back up   the entries as stored — toolUndo included — so a restored entry is undone like any other.
//   Restore   takes only this tool's entries from a file the Toolkit wrote; what is already listed is not touched.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const TH = read('sftk-toolhistory.js');

function load(initial) {
  const store = { sftk_history: initial };
  const archived = [];
  const ctx = vm.createContext({
    console, setTimeout,
    chrome: { storage: { local: {
      get: async k => ({ [k]: store[k] }),
      set: async o => { Object.assign(store, JSON.parse(JSON.stringify(o))); },
    } } },
    sftkHistorySplit: (list, cap) => (list.length <= cap ? { keep: list, overflow: [] } : { keep: list.slice(-cap), overflow: list.slice(0, list.length - cap) }),
    sftkArchPut: async l => { archived.push(...l); },
  });
  vm.runInContext(read('sftk-history.js') + '\nglobalThis.__x = { sftkHistoryWithoutTab, sftkHistoryClearTab, sftkHistoryBackupOf, sftkHistoryBackupRead, sftkHistoryMergeBackup, sftkHistoryRestoreBackup, sftkToolUndoState, sftkHistoryForSubject, SFTK_HISTORY_CAP };', ctx);
  return { H: ctx.__x, store, archived };
}
const fc = (n, extra) => ({ id: `fc_${n}`, kind: 'tool', tool: 'Field Cleaner', profileName: `change ${n}`, subject: 'Account.F__c', targetOrg: 'https://a.my.salesforce.com',
  startedAt: `2026-11-${String(10 + (n % 15)).padStart(2, '0')}T10:${String(n % 60).padStart(2, '0')}:00.000Z`, status: 'success',
  toolUndo: { steps: [{ label: `put ${n} back`, body: { before: `<xml>${n}</xml>` } }] }, ...extra });
const other = n => ({ id: `fl_${n}`, kind: 'tool', tool: 'Flow delete', profileName: 'flows', targetOrg: 'https://a.my.salesforce.com', startedAt: '2026-11-12T09:00:00.000Z', status: 'success' });
const run = n => ({ id: `run_${n}`, profileName: 'Accounts', targetOrg: 'https://a.my.salesforce.com', startedAt: '2026-11-12T08:00:00.000Z', status: 'success', summary: {} });

describe('clear one tool', () => {
  it('removes that tool only and says how many', async () => {
    const { H, store } = load([fc(1), other(1), run(1), fc(2)]);
    expect(await H.sftkHistoryClearTab('fields')).toBe(2);
    expect(store.sftk_history.map(e => e.id)).toEqual(['fl_1', 'run_1']);
  });
  it('an unknown tab clears nothing', async () => {
    const { H, store } = load([fc(1), run(1)]);
    expect(await H.sftkHistoryClearTab('nope')).toBe(0);
    expect(await H.sftkHistoryClearTab('')).toBe(0);
    expect(store.sftk_history.length).toBe(2);
  });
  it('a deployment is never a tool entry', () => {
    const { H } = load([]);
    expect(H.sftkHistoryWithoutTab([run(1), fc(1)], 'fields').map(e => e.id)).toEqual(['run_1']);
  });
});

describe('backup → clear → restore keeps the undo', () => {
  it('the round trip gives back the same entries, undo data untouched and still offered', async () => {
    const before = [fc(1), fc(2), other(1), run(1)];
    const { H, store } = load(JSON.parse(JSON.stringify(before)));
    const file = JSON.stringify(H.sftkHistoryBackupOf(store.sftk_history, 'fields', '2026-11-16T12:00:00.000Z'));
    expect(JSON.parse(file).count).toBe(2);
    await H.sftkHistoryClearTab('fields');
    const r = H.sftkHistoryBackupRead(file, 'fields');
    expect(r.ok).toBe(true);
    const res = await H.sftkHistoryRestoreBackup(r.entries, '2026-11-16T12:05:00.000Z');
    expect(res).toMatchObject({ added: 2, skipped: 0, archived: 0 });
    const back = store.sftk_history.filter(e => e.tool === 'Field Cleaner');
    for (const e of back) {
      const was = before.find(b => b.id === e.id);
      expect(e.toolUndo).toEqual(was.toolUndo);
      expect(e.subject).toBe('Account.F__c');
      expect(e.restoredFromBackup).toBe('2026-11-16T12:05:00.000Z');
      expect(H.sftkToolUndoState(e).disabled).toBe(H.sftkToolUndoState(was).disabled);
    }
    expect(store.sftk_history.filter(e => e.tool !== 'Field Cleaner').map(e => e.id).sort()).toEqual(['fl_1', 'run_1']);
  });
  it('restoring twice adds nothing the second time', async () => {
    const { H, store } = load([fc(1)]);
    const file = JSON.stringify(H.sftkHistoryBackupOf(store.sftk_history, 'fields', 'x'));
    const res = await H.sftkHistoryRestoreBackup(H.sftkHistoryBackupRead(file, 'fields').entries, 'y');
    expect(res).toMatchObject({ added: 0, skipped: 1 });
    expect(store.sftk_history.length).toBe(1);
    expect(store.sftk_history[0].restoredFromBackup).toBeUndefined();
  });
  it('an entry undone after the backup is not overwritten by the older copy', () => {
    const { H } = load([]);
    const now = fc(1, { toolUndo: { steps: [], done: { ok: true } } });
    const m = H.sftkHistoryMergeBackup([now], [fc(1), fc(2)], 'z');
    expect(m.added).toBe(1);
    expect(m.list.find(e => e.id === 'fc_1').toolUndo.done.ok).toBe(true);
  });
  it('past the cap the oldest go to the archive and the count is told', async () => {
    const { H, store, archived } = load([]);
    const many = Array.from({ length: H.SFTK_HISTORY_CAP + 7 }, (_, i) => fc(i, { startedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
    const res = await H.sftkHistoryRestoreBackup(many, 'n');
    expect(res.added).toBe(H.SFTK_HISTORY_CAP + 7);
    expect(res.archived).toBe(7);
    expect(store.sftk_history.length).toBe(H.SFTK_HISTORY_CAP);
    expect(archived.map(e => e.id)).toEqual(many.slice(0, 7).map(e => e.id));
  });
});

describe('what a file may bring in', () => {
  const { H } = load([]);
  const wrap = (entries, o) => JSON.stringify({ format: 'sftk-history-backup', version: 1, tab: 'fields', entries, ...o });
  it('refuses what is not a backup, with a reason', () => {
    for (const t of ['', 'not json', '[]', '{"entries":[]}', JSON.stringify({ format: 'other', entries: [fc(1)] })]) {
      const r = H.sftkHistoryBackupRead(t, 'fields');
      expect(r.ok).toBe(false); expect(r.why).toBeTruthy(); expect(r.entries).toEqual([]);
    }
  });
  it('refuses another tool\'s backup and a newer format', () => {
    expect(H.sftkHistoryBackupRead(wrap([fc(1)], { tab: 'flows' }), 'fields').why).toMatch(/restore it from Activity/);
    expect(H.sftkHistoryBackupRead(wrap([fc(1)], { version: 2 }), 'fields').why).toMatch(/newer version/);
  });
  it('takes only this tool\'s well-formed entries: no deployment, no other tool, no junk', () => {
    const r = H.sftkHistoryBackupRead(wrap([fc(1), other(1), run(1), null, 'x', { id: 5, kind: 'tool', tool: 'Field Cleaner' }, { ...fc(2), targetOrg: undefined }]), 'fields');
    expect(r.ok).toBe(true);
    expect(r.entries.map(e => e.id)).toEqual(['fc_1']);
    expect(r.dropped).toBe(6);
  });
  it('a file with none of this tool\'s changes is refused', () => {
    expect(H.sftkHistoryBackupRead(wrap([other(1), run(1)]), 'fields').ok).toBe(false);
  });
});

describe('everything at once (Activity) and one field at a time (inside the tool)', () => {
  it("'*' is every Toolkit tool and never a deployment", async () => {
    const { H, store } = load([fc(1), other(1), run(1)]);
    const file = H.sftkHistoryBackupOf(store.sftk_history, '*', 'n');
    expect(file.entries.map(e => e.id).sort()).toEqual(['fc_1', 'fl_1']);
    expect(await H.sftkHistoryClearTab('*')).toBe(2);
    expect(store.sftk_history.map(e => e.id)).toEqual(['run_1']);
    const r = H.sftkHistoryBackupRead(JSON.stringify(file), '*');
    expect(r.ok).toBe(true);
    expect((await H.sftkHistoryRestoreBackup(r.entries, 'n')).added).toBe(2);
  });
  it('one tool takes only its own from a backup of everything; Activity takes a single tool\'s backup', () => {
    const { H } = load([]);
    const everything = JSON.stringify(H.sftkHistoryBackupOf([fc(1), other(1)], '*', 'n'));
    expect(H.sftkHistoryBackupRead(everything, 'fields').entries.map(e => e.id)).toEqual(['fc_1']);
    const one = JSON.stringify(H.sftkHistoryBackupOf([fc(1), other(1)], 'fields', 'n'));
    expect(H.sftkHistoryBackupRead(one, '*').entries.map(e => e.id)).toEqual(['fc_1']);
  });
  it('the list inside the tool is one subject\'s: its own entries, a legacy title by whole word, nothing for no subject', () => {
    const { H } = load([]);
    const list = [fc(1), fc(2, { subject: 'Account.Other__c' }), fc(3, { subject: '', profileName: '"VR" deleted (Account.F__c' }), fc(4, { subject: '', profileName: 'x (Account.F__c_Old' })];
    expect(H.sftkHistoryForSubject(list, 'Account.F__c').map(e => e.id)).toEqual(['fc_1', 'fc_3']);
    expect(H.sftkHistoryForSubject(list, 'Account.Other__c').map(e => e.id)).toEqual(['fc_2']);
    expect(H.sftkHistoryForSubject(list, '')).toEqual([]);
  });
});

describe('the buttons', () => {
  it('the window carries Back up, Restore and Clear; the list inside a tool does not (it is about one field)', () => {
    for (const a of ['sftkThBackup', 'sftkThRestore', 'sftkThClear']) expect(TH).toContain(a);
    const inl = TH.slice(TH.indexOf('async function inline(host, tab, opts)'), TH.indexOf('// ── the top bar ──'));
    for (const a of ['data-th-backup', 'data-th-restore', 'data-th-clear']) expect(inl).not.toContain(a);
    expect(inl).toContain('data-th-activity');
  });
  it('Clear asks first, ticks a box only when an undo is lost, and never touches an org', () => {
    const body = TH.slice(TH.indexOf('async function clear(tab, after)'), TH.indexOf('// ── inside a tool ──'));
    expect(body).toContain('sftkConfirmDestructive');
    expect(body).toContain('needsCheckbox: undoable > 0');
    expect(body).toContain('Nothing in Salesforce is changed');
    expect(body).not.toMatch(/SF_[A-Z_]+|sendMessage/);
    expect(body.indexOf('if (!sure)')).toBeLessThan(body.indexOf('sftkHistoryClearTab(tab)'));
  });
  it('the window offers Restore even when nothing is listed', () => {
    expect(TH).toMatch(/id="sftkThRestore" title=/);
    expect(TH).not.toMatch(/id="sftkThRestore" style="display:none"/);
  });
});
