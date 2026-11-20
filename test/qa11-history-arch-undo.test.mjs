// QA 1.1 finding 39: an archived Data Studio tool card showed an enabled Undo that always answered "no longer in Activity".
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const SH = read('studio-history.js').replace(/\r\n/g, '\n');
const { _histArchHeld, _histArchAfterUndo } = extractFunctions('studio-history.js', ['_histArchHeld', '_histArchAfterUndo']);
const ORG = 'https://a.my.salesforce.com';
const pk = n => ({ id: `pk_${n}`, kind: 'tool', tool: 'Picklist Manager', profileName: `values ${n}`, targetOrg: ORG, startedAt: `2026-11-01T10:0${n}:00.000Z`, status: 'success',
  what: [{ describe: 'x', ok: true, accepted: true, verified: true, text: 'x' }],
  toolUndo: { steps: [{ describe: `put ${n} back`, msg: { type: 'SF_PATCH', path: 'p', body: {} }, verify: null, orgUrl: '' }], note: '' } });

describe('the entry handed to the undo', () => {
  it('a tool card of the archive view is handed in, without the view\'s own mark', () => {
    const shown = [{ ...pk(1), _archived: true }];
    const held = _histArchHeld([], shown, 'pk_1');
    expect(held).toMatchObject({ id: 'pk_1', kind: 'tool' });
    expect('_archived' in held).toBe(false);
    expect(shown[0]._archived).toBe(true);
  });
  it('nothing is handed in for an entry the hot list holds, a deployment run, or an unknown id', () => {
    expect(_histArchHeld([pk(1)], [{ ...pk(1), _archived: true }], 'pk_1')).toBeNull();
    expect(_histArchHeld([], [{ id: 'run_1', _archived: true }], 'run_1')).toBeNull();
    expect(_histArchHeld([], [], 'nope')).toBeNull();
  });
  it('afterwards the archive view\'s card carries the done mark; a copy the hot list now holds is dropped from the view', () => {
    const shown = [{ ...pk(1), _archived: true }, { ...pk(2), _archived: true }];
    const done = { ...pk(1), toolUndo: { ...pk(1).toolUndo, done: { at: 'T', ok: true, entryId: 'u' } } };
    _histArchAfterUndo([], shown, done);
    expect(shown[0]).toMatchObject({ id: 'pk_1', _archived: true, toolUndo: { done: { ok: true } } });
    _histArchAfterUndo([pk(2)], shown, pk(2));
    expect(shown.map(e => e.id)).toEqual(['pk_1']);
  });
});

describe('end to end with sftk-history.js: Data Studio undoes an archived Picklist Manager change', () => {
  it('the steps run, the archived record gets the done mark, and the hot list gains only the undo\'s own entry', async () => {
    const arch = new Map([['pk_1', pk(1)]]);
    const sent = [];
    const ctx = vm.createContext({
      console: { warn() {}, log() {} }, setTimeout,
      chrome: { storage: { local: { get: async () => ({}), set: async () => {} } } },
      _history: [],
      sftkArchPut: async l => { for (const e of l) arch.set(e.id, JSON.parse(JSON.stringify(e))); },
      sftkArchList: async () => [...arch.values()],
      sftkWriteVerified: async spec => { await spec.write(); const r = { ok: true, accepted: true, verified: true, text: spec.describe }; ctx.sftkHistoryNote(spec.journal, r, spec.describe); return r; },
    });
    ctx.storageSaveHistory = async () => {};
    vm.runInContext(read('sftk-history.js'), ctx);
    const send = async m => { sent.push(m.type); return m.type === 'GET_ALL_SF_SESSIONS' ? { sessions: [{ orgUrl: ORG, sid: 'S' }] } : {}; };
    const shown = [{ ...arch.get('pk_1'), _archived: true }];
    // without the entry: the answer the user used to get
    expect((await ctx.sftkHistoryUndo('pk_1', { send, confirm: false })).text).toBe('This entry is no longer in Activity.');
    const held = _histArchHeld(ctx._history, shown, 'pk_1');
    const r = await ctx.sftkHistoryUndo('pk_1', { send, confirm: false, entry: held });
    expect(r.ok).toBe(true);
    expect(sent).toContain('SF_PATCH');
    expect(arch.get('pk_1').toolUndo.done.ok).toBe(true);
    expect('_archived' in arch.get('pk_1')).toBe(false);
    expect(ctx._history.map(e => e.undoOf)).toEqual(['pk_1']);
    _histArchAfterUndo(ctx._history, shown, r.entry);
    expect(ctx.sftkToolUndoState(shown[0])).toMatchObject({ disabled: true, label: '↩ Undone' });
  });
});

describe('the click', () => {
  it('undoTool hands the archive view\'s entry to sftkHistoryUndo and refreshes the view\'s copy', () => {
    const body = SH.slice(SH.indexOf('window.undoTool = async function(id)'), SH.indexOf('// ── E2: audit-export UI'));
    expect(body).toContain('const held = _histArchHeld(_history, _archShown, id);');
    expect(body).toContain('await sftkHistoryUndo(id, held ? { entry: held } : {})');
    expect(body).toContain('_histArchAfterUndo(_history, _archShown, r.entry)');
  });
  it('the list draws an id once: a card the hot list holds is not drawn again from the archive view', () => {
    expect(SH).toContain('const mineArch = _archShown.filter(r => r && !hotIds.has(r.id) &&');
  });
});
