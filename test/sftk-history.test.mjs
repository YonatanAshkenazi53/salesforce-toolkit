// History with undo for every write (campaign 3, phase 3) — sftk-history.js.
//
// A journal collects each write's verdict; End records the undo statement
// (steps as data, or a reason there is none) and persists the entry through
// the page's own path. The undo runs the steps through sftkWriteVerified
// again, so "undone" is said only after a re-read.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunctions } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(root, 'sftk-history.js'), 'utf8');
const { sftkWriteVerified, sftkWriteVerifiedAll } = extractFunctions('sftk-write.js', ['sftkWriteVerified', '_sftkWriteVerifiedCore', 'sftkWriteVerifiedAll']);

// The whole file in one scope, with the page's collaborators injected.
function load(env) {
  const names = ['sftkHistoryBegin', 'sftkHistoryNote', 'sftkHistoryEnd', 'sftkHistoryAppend', 'sftkHistoryAll', 'sftkToolUndoState', 'sftkUndoVerifyEval', 'sftkHistorySessionFor', 'sftkHistoryUndo'];
  const fn = new Function('chrome', '_history', 'storageSaveHistory', 'sftkWriteVerified', 'sftkConfirmDestructive', 'sftkOrgWriteGate', 'sftkHistorySplit', 'sftkArchPut', 'console',
    `${SRC}\nreturn { ${names.join(', ')} };`);
  const api = fn(env.chrome, env._history, env.storageSaveHistory, env.sftkWriteVerified || sftkWriteVerified, env.sftkConfirmDestructive, env.sftkOrgWriteGate, env.sftkHistorySplit, env.sftkArchPut, { warn: () => {} });
  // sftkWriteVerified (from sftk-write.js) calls sftkHistoryNote through the global.
  globalThis.sftkHistoryNote = api.sftkHistoryNote;
  return api;
}

function fakeStorage(initial) {
  const store = { sftk_history: initial || [] };
  return {
    store,
    chrome: { storage: { local: {
      get: async k => ({ [k]: store[k] }),
      set: async v => { Object.assign(store, JSON.parse(JSON.stringify(v))); },
    } }, runtime: { sendMessage: (m, cb) => cb({}) } },
  };
}

describe('journal → entry', () => {
  it('Begin gives a kind:tool entry; each verified write appends a line; End derives the status and stores the undo', async () => {
    const fs = fakeStorage();
    const H = load({ chrome: fs.chrome });
    const j = H.sftkHistoryBegin({ tool: 'Flow switches', title: '⏻ 2 flows OFF', orgUrl: 'https://a.my.salesforce.com' });
    expect(j).toMatchObject({ kind: 'tool', tool: 'Flow switches', profileName: '⏻ 2 flows OFF', targetOrg: 'https://a.my.salesforce.com', status: 'running', what: [] });
    await sftkWriteVerified({ describe: 'Flow A off', write: async () => ({}), verify: async () => ({ ok: true }), journal: j });
    await sftkWriteVerified({ describe: 'Flow B off', write: async () => ({ error: 'nope' }), journal: j });
    expect(j.what.map(w => [w.describe, w.ok, w.accepted])).toEqual([['Flow A off', true, true], ['Flow B off', false, false]]);
    const e = await H.sftkHistoryEnd(j, { undo: { steps: [{ describe: 'Flow A back on', msg: { type: 'SF_PATCH', path: 'p', body: {} }, verify: { query: 'q' } }] } });
    expect(e.status).toBe('partial');
    expect(e.completedAt).toBeTruthy();
    expect(e.toolUndo.steps).toHaveLength(1);
    expect(e.errors).toEqual(['Flow B off: refused — nope']);
    // persisted through the popup path (no _history in scope)
    expect(fs.store.sftk_history.map(x => x.id)).toEqual([j.id]);
  });
  it('an action that found nothing to write is a success that says so (nothingToDo), with no undo', async () => {
    const H = load(fakeStorage());
    const j = H.sftkHistoryBegin({ tool: 'Picklist Manager', title: 'sync' });
    const e = await H.sftkHistoryEnd(j, { nothingToDo: 'already in sync — nothing needed writing', undo: { none: 'x' } });
    expect(e.status).toBe('success');
    expect(e.what).toEqual([{ describe: 'nothing to write', ok: true, accepted: true, verified: true, text: 'already in sync — nothing needed writing' }]);
    expect(e.toolUndo).toEqual({ none: 'nothing was written' });
    // with writes present, the sentence is ignored — the writes speak
    const k = H.sftkHistoryBegin({ tool: 't' }); H.sftkHistoryNote(k, { ok: false, accepted: false, verified: false, text: 'refused' }, 'w');
    expect((await H.sftkHistoryEnd(k, { nothingToDo: 'no', undo: { none: 'x' } })).status).toBe('failed');
  });
  it('status: all ok → success; none accepted → failed; nothing written → failed', async () => {
    const H = load(fakeStorage());
    const a = H.sftkHistoryBegin({ tool: 't' }); H.sftkHistoryNote(a, { ok: true, accepted: true, verified: true, text: 'x' }, 'x');
    expect((await H.sftkHistoryEnd(a, { undo: { none: 'r' } })).status).toBe('success');
    const b = H.sftkHistoryBegin({ tool: 't' }); H.sftkHistoryNote(b, { ok: false, accepted: false, verified: false, text: 'x' }, 'x');
    expect((await H.sftkHistoryEnd(b, { undo: { none: 'r' } })).status).toBe('failed');
    const c = H.sftkHistoryBegin({ tool: 't' });
    expect((await H.sftkHistoryEnd(c, { undo: { none: 'r' } })).status).toBe('failed');
  });
  it('the undo statement: steps are kept only when something was accepted; a missing statement is recorded as a bug, not hidden', async () => {
    const H = load(fakeStorage());
    const steps = [{ describe: 's', msg: { type: 'SF_PATCH' } }];
    const a = H.sftkHistoryBegin({ tool: 't' }); H.sftkHistoryNote(a, { ok: false, accepted: false, verified: false, text: 'refused' }, 's');
    expect((await H.sftkHistoryEnd(a, { undo: { steps } })).toolUndo).toEqual({ none: 'nothing was accepted by Salesforce, so there is nothing to undo' });
    const b = H.sftkHistoryBegin({ tool: 't' }); H.sftkHistoryNote(b, { ok: true, accepted: true, verified: true, text: 'ok' }, 's');
    expect((await H.sftkHistoryEnd(b, { undo: { steps, note: 'n' } })).toolUndo).toEqual({ steps: [{ describe: 's', msg: { type: 'SF_PATCH' }, verify: null, orgUrl: '' }], note: 'n' });
    const c = H.sftkHistoryBegin({ tool: 't' }); H.sftkHistoryNote(c, { ok: true, accepted: true, verified: true, text: 'ok' }, 's');
    expect((await H.sftkHistoryEnd(c, {})).toolUndo.none).toMatch(/did not say whether the change can be undone — a bug/);
    const d = H.sftkHistoryBegin({ tool: 't' }); H.sftkHistoryNote(d, { ok: true, accepted: true, verified: true, text: 'ok' }, 's');
    expect((await H.sftkHistoryEnd(d, { undo: { steps: [{ describe: 'no msg' }] } })).toolUndo.none).toMatch(/undo steps were empty/);
  });
  it('a batched sftkWriteVerifiedAll hears the journal once per item, after the batch verdict', async () => {
    const H = load(fakeStorage());
    const j = H.sftkHistoryBegin({ tool: 't' });
    const r = await sftkWriteVerifiedAll([{ describe: 'A', write: async () => ({}) }, { describe: 'B', write: async () => ({}) }],
      { journal: j, verifyAll: async () => [{ ok: true }, { ok: false }] });
    expect(r.ok).toBe(1);
    expect(j.what.map(w => [w.describe, w.ok, w.verified])).toEqual([['A', true, true], ['B', false, true]]);
  });
});

describe('persistence — both pages', () => {
  it('Data Studio: pushes into _history and calls storageSaveHistory; a re-append replaces by id', async () => {
    const _history = [{ id: 'old' }]; let saved = 0;
    const H = load({ chrome: fakeStorage().chrome, _history, storageSaveHistory: async () => { saved++; } });
    const j = H.sftkHistoryBegin({ tool: 't' });
    await H.sftkHistoryEnd(j, { undo: { none: 'r' } });
    expect(_history.map(h => h.id)).toEqual(['old', j.id]); expect(saved).toBe(1);
    j.toolUndo.done = { at: 'now', ok: true };
    await H.sftkHistoryAppend(j);
    expect(_history).toHaveLength(2); expect(_history[1].toolUndo.done.ok).toBe(true); expect(saved).toBe(2);
  });
  it('popup: read → append → cap 100 with the overflow archived when the archive module is loaded', async () => {
    const initial = Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, startedAt: `2026-01-${String(i % 28 + 1).padStart(2, '0')}` }));
    const fs = fakeStorage(initial); const archived = [];
    const H = load({ chrome: fs.chrome, sftkHistorySplit: (list, cap) => ({ keep: list.slice(-cap), overflow: list.slice(0, list.length - cap) }), sftkArchPut: async rows => { archived.push(...rows); } });
    const j = H.sftkHistoryBegin({ tool: 't' });
    await H.sftkHistoryEnd(j, { undo: { none: 'r' } });
    expect(fs.store.sftk_history).toHaveLength(100);
    expect(fs.store.sftk_history[99].id).toBe(j.id);
    expect(archived.map(a => a.id)).toEqual(['r0']);
  });
});

describe('sftkToolUndoState — what the card offers, and why not', () => {
  const H = load(fakeStorage());
  it('steps → enabled with the count; none → disabled with the reason; done → disabled, verified or not', () => {
    expect(H.sftkToolUndoState({ kind: 'tool', toolUndo: { steps: [{}, {}] } })).toMatchObject({ show: true, disabled: false, label: '↩ Undo (2 steps)' });
    expect(H.sftkToolUndoState({ kind: 'tool', toolUndo: { none: 'a rewritten Draft cannot be restored' } })).toMatchObject({ show: true, disabled: true, label: '↩ no undo', title: 'Cannot be undone from here — a rewritten Draft cannot be restored' });
    expect(H.sftkToolUndoState({ kind: 'tool', toolUndo: { steps: [{}], done: { at: 'T', ok: true } } })).toMatchObject({ disabled: true, label: '↩ Undone' });
    expect(H.sftkToolUndoState({ kind: 'tool', toolUndo: { steps: [{}], done: { at: 'T', ok: false } } })).toMatchObject({ disabled: true, label: '↩ Undo attempted' });
    expect(H.sftkToolUndoState({ kind: 'reconcile' })).toEqual({ show: false });
  });
});

describe('sftkUndoVerifyEval — the re-read judged from data', () => {
  const H = load(fakeStorage());
  const ev = H.sftkUndoVerifyEval;
  it('field / notNull / equals on a picked record', () => {
    const ans = { records: [{ ApiName: 'F', ActiveVersionId: '301x' }] };
    expect(ev({ pick: 'records.0', field: 'ActiveVersionId', notNull: true }, ans).ok).toBe(true);
    expect(ev({ pick: 'records.0', field: 'ActiveVersionId', equals: null }, ans).ok).toBe(false);
    expect(ev({ pick: 'records.0', field: 'ActiveVersionId', equals: null }, { records: [{ ActiveVersionId: null }] }).ok).toBe(true);
  });
  it('where picks the element; count and absent judge a list', () => {
    const ans = { records: [{ Name: 'a', IsActive: true }, { Name: 'b', IsActive: false }] };
    expect(ev({ where: { field: 'Name', equals: 'b' }, field: 'IsActive', equals: false }, ans).ok).toBe(true);
    expect(ev({ where: { field: 'Name', equals: 'zz' }, field: 'IsActive', equals: false }, ans).ok).toBe(false);
    expect(ev({ count: 2 }, ans).ok).toBe(true);
    expect(ev({ absent: true }, { records: [] }).ok).toBe(true);
    expect(ev({ absent: true }, ans).ok).toBe(false);
  });
  it('a nested Metadata path (Tooling): the value in a picklist value set', () => {
    const ans = { records: [{ Metadata: { valueSet: { valueSetDefinition: { value: [{ fullName: 'New', isActive: true }, { fullName: 'Old', isActive: false }] } } } }] };
    expect(ev({ pick: 'records.0.Metadata.valueSet.valueSetDefinition.value', where: { field: 'fullName', equals: 'Old' }, field: 'isActive', equals: true }, ans).ok).toBe(false);
    expect(ev({ pick: 'records.0.Metadata.valueSet.valueSetDefinition.value', where: { field: 'fullName', equals: 'New' }, field: 'isActive', equals: true }, ans).ok).toBe(true);
  });
  it('an error answer is unverified, with the sentences from the spec when given', () => {
    expect(ev({ field: 'x' }, { error: 'boom' })).toEqual({ ok: false, text: 'could not re-read the org (boom) — treat this as unverified' });
    expect(ev({ pick: 'records.0', field: 'A', equals: 1, text: { ok: 'back', bad: 'still' } }, { records: [{ A: 1 }] })).toEqual({ ok: true, text: 'back' });
    expect(ev({ pick: 'records.0', field: 'A', equals: 1, text: { ok: 'back', bad: 'still' } }, { records: [{ A: 2 }] })).toEqual({ ok: false, text: 'still' });
  });
});

describe('sftkHistoryUndo — the steps run through the write discipline', () => {
  let sent, org, sessions, gate, confirmed, storage, H;
  beforeEach(() => {
    sent = []; org = { records: [{ ActiveVersionId: null }] };
    sessions = [{ orgUrl: 'https://a.my.salesforce.com', sid: 'S1', label: 'A' }];
    gate = { production: false, label: 'A' }; confirmed = true;
    storage = fakeStorage([{ id: 'e1', kind: 'tool', tool: 'Flow switches', profileName: '⏻ 1 flow OFF', targetOrg: 'https://a.lightning.force.com', status: 'success', what: [{ ok: true, accepted: true, verified: true, text: 'off' }],
      toolUndo: { steps: [{ describe: 'F back on (v3)', msg: { type: 'SF_PATCH', path: 'p', body: { Metadata: { activeVersionNumber: 3 } } }, verify: { query: 'SELECT ActiveVersionId FROM FlowDefinitionView WHERE ApiName = \'F\'', pick: 'records.0', field: 'ActiveVersionId', notNull: true } }] } }]);
    H = load({ chrome: storage.chrome, sftkConfirmDestructive: async o => { confirmed && sent.push({ dialog: o }); return confirmed; }, sftkOrgWriteGate: async () => gate });
  });
  const send = async m => {
    sent.push(m);
    if (m.type === 'GET_ALL_SF_SESSIONS') return { sessions };
    if (m.type === 'SF_PATCH') { org = { records: [{ ActiveVersionId: '301' }] }; return {}; }
    if (m.type === 'SF_QUERY') return org;
    return {};
  };
  it('confirms with the shared dialog (word UNDO, production from the gate), writes with the org session, re-reads, records the undo, marks the original', async () => {
    gate = { production: true, label: 'A' };
    const log = [];
    const r = await H.sftkHistoryUndo('e1', { send, onLog: l => log.push(l) });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('Undone — 1 step verified by re-reading the org');
    const dialog = sent.find(x => x.dialog).dialog;
    expect(dialog).toMatchObject({ typedWord: 'UNDO', confirmLabel: '↩ Undo', items: [{ label: 'F back on (v3)' }], production: { label: 'A' } });
    expect(dialog.revOverride.needsCheckbox).toBe(true);
    expect(dialog.revOverride.ack).toBe('I understand this writes the earlier state back over whatever is there now');
    const patch = sent.find(x => x.type === 'SF_PATCH');
    expect(patch).toMatchObject({ orgUrl: 'https://a.my.salesforce.com', sid: 'S1', path: 'p', _suppressError: true });
    expect(sent.find(x => x.type === 'SF_QUERY')).toMatchObject({ tooling: false, sid: 'S1' });
    expect(log).toEqual(['✅ F back on (v3) — verified by re-reading the org']);
    const list = storage.store.sftk_history;
    expect(list).toHaveLength(2);
    expect(list[0].toolUndo.done).toMatchObject({ ok: true, entryId: list[1].id });
    expect(list[1]).toMatchObject({ kind: 'tool', tool: 'Flow switches', profileName: '↩ Undo — ⏻ 1 flow OFF', undoOf: 'e1', status: 'success', toolUndo: { none: 'this entry is itself an undo — redo the change from the tool' } });
  });
  it('a cancelled dialog writes nothing; no session for the org says to log in first; a done entry is refused', async () => {
    confirmed = false;
    expect(await H.sftkHistoryUndo('e1', { send })).toMatchObject({ ok: false, cancelled: true });
    expect(sent.some(x => x.type === 'SF_PATCH')).toBe(false);
    confirmed = true; sessions = [];
    expect((await H.sftkHistoryUndo('e1', { send })).text).toBe('Log in to a in a Salesforce tab first — the undo writes there.');
    sessions = [{ orgUrl: 'https://a.my.salesforce.com', sid: 'S1', label: 'A' }];
    storage.store.sftk_history[0].toolUndo.done = { at: 'T', ok: true };
    expect((await H.sftkHistoryUndo('e1', { send })).ok).toBe(false);
    expect(sent.some(x => x.type === 'SF_PATCH')).toBe(false);
  });
  it('a step whose re-read still shows the old state is NOT undone, and the sentence says so', async () => {
    const send2 = async m => { sent.push(m); if (m.type === 'GET_ALL_SF_SESSIONS') return { sessions }; if (m.type === 'SF_QUERY') return { records: [{ ActiveVersionId: null }] }; return {}; };
    const r = await H.sftkHistoryUndo('e1', { send: send2 });
    expect(r.ok).toBe(false);
    expect(r.text).toBe('Undo ran: 0 of 1 step verified — see the undo\'s entry in History');
    expect(storage.store.sftk_history[0].toolUndo.done.ok).toBe(false);
    expect(storage.store.sftk_history[1].status).toBe('partial');
  });
});
