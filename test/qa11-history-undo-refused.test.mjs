// QA 1.1 finding 37: an undo in which Salesforce accepted no step closed the entry's Undo for good, and a dropped connection during Undo all burned every remaining change.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const ORG = 'https://a.my.salesforce.com';

// The whole file in one context. `answer(step)` is what the org says to a step's write: {} = accepted, { error } = refused.
function load(hot, answer) {
  const store = { sftk_history: hot };
  const ctx = vm.createContext({
    console: { warn() {}, log() {} }, setTimeout,
    chrome: { storage: { local: {
      get: async k => ({ [k]: store[k] }),
      set: async v => { Object.assign(store, JSON.parse(JSON.stringify(v))); },
    } } },
    // the write discipline, reduced to: send the step, read the refusal, tell the journal
    sftkWriteVerified: async spec => {
      const a = await spec.write();
      const r = a && a.error ? { ok: false, accepted: false, verified: false, text: `${spec.describe}: refused — ${a.error}` }
        : { ok: true, accepted: true, verified: true, text: `${spec.describe} — verified by re-reading the org` };
      ctx.sftkHistoryNote(spec.journal, r, spec.describe);
      return r;
    },
  });
  vm.runInContext(read('sftk-history.js'), ctx);
  const send = async m => (m.type === 'GET_ALL_SF_SESSIONS' ? { sessions: [{ orgUrl: ORG, sid: 'S', label: 'A' }] } : answer(m));
  return { H: ctx, store, send };
}
const fc = n => ({ id: `fc_${n}`, kind: 'tool', tool: 'Field Cleaner', profileName: `change ${n}`, subject: 'Account.A__c', targetOrg: ORG,
  startedAt: `2026-11-10T10:${String(n).padStart(2, '0')}:00.000Z`, status: 'success', what: [{ describe: 'x', ok: true, accepted: true, verified: true, text: 'x' }],
  toolUndo: { steps: [{ describe: `put ${n} back`, msg: { type: 'SF_PATCH', path: `p${n}`, body: {} }, verify: null, orgUrl: '' }], note: '' } });

describe('an undo Salesforce refused outright', () => {
  it('leaves the entry undoable, says nothing was undone, and still records the attempt', async () => {
    let down = true;
    const { H, store, send } = load([fc(1)], () => (down ? { error: 'REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded' } : {}));
    const r = await H.sftkHistoryUndo('fc_1', { send, confirm: false });
    expect(r.ok).toBe(false);
    expect(r.written).toBe(false);
    expect(r.text).toMatch(/^Nothing was undone: Salesforce accepted none of the 1 step, so the org is as it was\./);
    expect(r.text).toMatch(/can still be undone/);
    const orig = store.sftk_history.find(e => e.id === 'fc_1');
    expect(orig.toolUndo.done).toBeUndefined();
    expect(H.sftkToolUndoState(orig).disabled).toBe(false);
    expect(store.sftk_history.filter(e => e.undoOf === 'fc_1')).toHaveLength(1);   // the attempt has its own entry
    // the same Undo runs again once the org answers
    down = false;
    const again = await H.sftkHistoryUndo('fc_1', { send, confirm: false });
    expect(again).toMatchObject({ ok: true, written: true });
    expect(store.sftk_history.find(e => e.id === 'fc_1').toolUndo.done.ok).toBe(true);
  });
  it('an undo with one step accepted is still closed: the org was changed', async () => {
    const e = fc(2);
    e.toolUndo.steps.push({ describe: 'second', msg: { type: 'SF_PATCH', path: 'second', body: {} }, verify: null, orgUrl: '' });
    const { H, store, send } = load([e], m => (m.path === 'second' ? { error: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' } : {}));
    const r = await H.sftkHistoryUndo('fc_2', { send, confirm: false });
    expect(r).toMatchObject({ ok: false, written: true });
    expect(r.text).toBe('Undo ran: 1 of 2 steps verified — see the undo\'s entry in Activity');
    expect(store.sftk_history.find(x => x.id === 'fc_2').toolUndo.done).toMatchObject({ ok: false });
  });
});

describe('Undo all when the org stops answering', () => {
  it('stops at the first entry refused for the connection; the rest are not tried and every one stays undoable', async () => {
    let calls = 0;
    const list = [fc(5), fc(4), fc(3), fc(2), fc(1)];
    const { H, store, send } = load(list.slice().reverse(), () => (++calls > 2 ? { error: 'Failed to fetch' } : {}));
    const res = await H.sftkHistoryUndoMany(list, { send });
    expect(res.ok).toBe(2);
    expect(res.ran).toBe(3);
    expect(res.failed.map(f => f.entry.id)).toEqual(['fc_3']);
    expect(res.stopped).toMatch(/^Salesforce could not be reached \(put 3 back: refused — Failed to fetch\)\. Nothing was written/);
    expect(calls).toBe(3);   // fc_2 and fc_1 were never sent
    const left = H.sftkHistoryUndoableFor(store.sftk_history, { tool: 'Field Cleaner', orgUrl: ORG, subject: 'Account.A__c' });
    expect(left.map(e => e.id)).toEqual(['fc_3', 'fc_2', 'fc_1']);
  });
  it('a refusal about the component itself does not stop the rest', async () => {
    const list = [fc(3), fc(2), fc(1)];
    const { H, send } = load(list.slice().reverse(), m => (m.path === 'p3' ? { error: 'FIELD_INTEGRITY_EXCEPTION: bad value' } : {}));
    const res = await H.sftkHistoryUndoMany(list, { send });
    expect(res).toMatchObject({ ran: 3, ok: 2, stopped: '' });
  });
  it('what counts as unreachable', () => {
    const { H } = load([], () => ({}));
    const w = (text, accepted) => ({ ok: false, accepted: !!accepted, text });
    expect(H.sftkHistoryUndoUnreachable([w('a: refused — INVALID_SESSION_ID: Session expired or invalid')])).toMatch(/INVALID_SESSION_ID/);
    expect(H.sftkHistoryUndoUnreachable([w('a: refused — No response')])).toBe('a: refused — No response');
    expect(H.sftkHistoryUndoUnreachable([w('a: refused — duplicate value found')])).toBe('');
    // one accepted step: the org answered
    expect(H.sftkHistoryUndoUnreachable([w('a ok', true), w('b: refused — Failed to fetch')])).toBe('');
    expect(H.sftkHistoryUndoUnreachable([{ info: true, text: 'Not restored — Failed to fetch' }])).toBe('');
    expect(H.sftkHistoryUndoWrote([{ info: true, accepted: true }, w('x')])).toBe(false);
    expect(H.sftkHistoryUndoWrote([w('x'), w('y', true)])).toBe(true);
  });
});
