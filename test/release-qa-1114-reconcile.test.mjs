// Release QA 2026-11-14 — Data Studio reconcile (studio-reconcile.js):
//  1. the identity stamp reads each target's CURRENT SFTK_ID__c before writing
//     (the read used `pr.targetId`, which sftkIdBackfillPairs never sets), so
//     History's undo writes the real previous value back — never blank over an
//     identity that was already there — and a failed read stops the stamp
//  2. overwrite / delete of more than 200 records: a refused later batch keeps
//     what the earlier batches wrote (counted, listed, purged) and the refused
//     ones are counted as failed — never a green "Updated 0" or "Delete failed, 0 deleted"
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SR = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const ID = readFileSync(new URL('../sftk-identity.js', import.meta.url), 'utf8');
const WR = readFileSync(new URL('../sftk-write.js', import.meta.url), 'utf8');
const CORE = readFileSync(new URL('../studio-core.js', import.meta.url), 'utf8');
const sliceFn = (src, name) => {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(src);
  if (!m) throw new Error('not found ' + name);
  return src.slice(m.index, src.indexOf('\n}', m.index) + 2);
};
const sliceConst = (src, name) => {
  const m = new RegExp(`^const ${name} = [\\s\\S]*?;\\n(?=\\S|$)`, 'm').exec(src);
  if (!m) throw new Error('not found const ' + name);
  return m[0];
};

// ── 1 · identity stamp before-values ─────────────────────────────────────
describe('identity stamp: undo restores the identity that was already there', () => {
  const make = (env) => new Function('env', `
    const { sendBg, toasts, histEnd } = env;
    const showToast = (m, kind) => toasts.push({ m, kind });
    const _buildAllSessions = () => ({});
    const _resolveSession = () => ({ orgUrl: 'https://t.example', sid: 'x' });
    const orgLabel = (o) => String(o);
    const esc = (s) => String(s);
    const eid = () => null;
    const _orgs = [];
    const ensureOrgType = async () => 'dev';
    const sftkOrgWriteGate = async () => null;
    const sftkConfirmDestructive = async () => true;
    const sftkHistoryBegin = () => ({ id: 'j1' });
    const sftkHistoryEnd = async (j, x) => { histEnd.push(x); };
    const sftkHistoryNote = () => {};
    const sftkIdHowToCreate = () => '';
    const sftkOpenIdentityModal = () => {};
    ${sliceFn(CORE, 'soqlStrLit')}
    ${sliceFn(ID, 'sftkIdFieldName')}
    ${sliceFn(ID, 'sftkIdBackfillPairs')}
    ${sliceFn(ID, 'sftkIdStampPayload')}
    ${sliceFn(WR, '_sftkWriteVerifiedCore')}
    ${sliceFn(WR, 'sftkWriteVerified')}
    ${sliceFn(SR, 'reconcileStampPairs')}
    return reconcileStampPairs;
  `)(env);

  const scan = { identical: [{ sourceId: '001S00000000001AAA', targetId: '001T00000000001AAA' }],
                 changed:   [{ sourceId: '001S00000000002AAA', targetId: '001T00000000002AAA' }] };
  const p = { tree: { objectType: 'Account' }, targetOrg: 'https://t.example' };

  it('reads the current values of the targets and the undo writes THEM back, not blank', async () => {
    const sent = [];
    const sendBg = async (m) => {
      sent.push(m);
      if (m.type === 'SF_QUERY') return { records: [] };
      if (m.type === 'SF_QUERY_ALL' && /WHERE Id IN/.test(m.query) && !sent.some(x => x.type === 'SF_COLLECTIONS_UPDATE')) {
        // before-read: record 1 already carries an identity (created by this tool), record 2 is blank
        return { records: [{ Id: '001T00000000001AAA', SFTK_ID__c: '001OLD0000000001AA' }, { Id: '001T00000000002AAA', SFTK_ID__c: null }] };
      }
      if (m.type === 'SF_COLLECTIONS_UPDATE') return m.records.map(r => ({ id: r.Id, success: true }));
      if (m.type === 'SF_QUERY_ALL') {
        // verify re-read: the stamp landed
        return { records: [{ Id: '001T00000000001AAA', SFTK_ID__c: '001S00000000001AAA' }, { Id: '001T00000000002AAA', SFTK_ID__c: '001S00000000002AAA' }] };
      }
      return {};
    };
    const env = { sendBg, toasts: [], histEnd: [] };
    await make(env)(p, scan);
    const before = sent.find(m => m.type === 'SF_QUERY_ALL');
    expect(before && before.query).toMatch(/'001T00000000001AAA'.*'001T00000000002AAA'/);
    const steps = env.histEnd[0].undo.steps;
    const restore = new Map(steps.flatMap(s => s.msg.records.map(r => [r.Id, r.SFTK_ID__c])));
    expect(restore.get('001T00000000001AAA')).toBe('001OLD0000000001AA');   // the identity it had — never null
    expect(restore.get('001T00000000002AAA')).toBe(null);                   // it really was blank
  });

  it('a failed before-read stamps nothing (the fail-closed guard can fire now)', async () => {
    const sent = [];
    const sendBg = async (m) => {
      sent.push(m);
      if (m.type === 'SF_QUERY') return { records: [] };
      if (m.type === 'SF_QUERY_ALL') return { error: 'Session expired or invalid' };
      if (m.type === 'SF_COLLECTIONS_UPDATE') return m.records.map(r => ({ id: r.Id, success: true }));
      return {};
    };
    const env = { sendBg, toasts: [], histEnd: [] };
    await make(env)(p, scan);
    expect(sent.some(m => m.type === 'SF_COLLECTIONS_UPDATE')).toBe(false);
    expect(env.toasts.some(t => t.kind === 'error' && /Nothing was stamped/.test(t.m))).toBe(true);
  });
});

// ── 2 · chunked overwrite / delete ───────────────────────────────────────
describe('overwrite / delete of more than 200: a refused later batch keeps the earlier ones', () => {
  const H = new Function(`
    ${sliceFn(WR, '_sftkWriteVerifiedCore')}
    ${sliceFn(WR, 'sftkWriteVerified')}
    ${sliceFn(SR, 'sftkReconcileChunkedWrite')}
    ${sliceConst(SR, 'sftkMergeArr')}
    ${sliceConst(SR, 'sftkMergeHard')}
    return { sftkWriteVerified, sftkReconcileChunkedWrite, sftkMergeArr, sftkMergeHard };
  `)();
  const ids = Array.from({ length: 450 }, (_, i) => `001T${String(i).padStart(14, '0')}`);

  it('450 deletes, batch 3 refused: 400 counted as written, 50 not done, never ok', async () => {
    const calls = [];
    const dw = await H.sftkReconcileChunkedWrite(ids, (chunk) => H.sftkWriteVerified({
      describe: 'Account delete',
      write: async () => { calls.push(chunk.length); if (calls.length === 3) throw new Error('HTTP 503'); return chunk.map(id => ({ id, success: true })); },
      verify: async () => ({ ok: true, detail: [] }),
    }), H.sftkMergeArr);
    expect(calls).toEqual([200, 200, 50]);
    expect(dw.accepted).toBe(true);
    expect(dw.ok).toBe(false);
    expect(dw.raw.filter(r => r.success)).toHaveLength(400);
    expect(dw.notDone).toBe(50);
    expect(dw.text).toMatch(/50 of 450/);
    expect(dw.text).toMatch(/HTTP 503/);
  });

  it('a refused batch stops the run: nothing after it is sent', async () => {
    const calls = [];
    const dw = await H.sftkReconcileChunkedWrite(ids, (chunk) => H.sftkWriteVerified({
      describe: 'x', write: async () => { calls.push(chunk.length); if (calls.length === 2) return { error: 'REQUEST_LIMIT_EXCEEDED' }; return chunk.map(id => ({ id, success: true })); },
      verify: async () => ({ ok: true, detail: [] }),
    }), H.sftkMergeArr);
    expect(calls).toEqual([200, 200]);
    expect(dw.notDone).toBe(250);
    expect(dw.ok).toBe(false);
  });

  it('the first batch refused: not accepted, with the refusal (the old failure path)', async () => {
    const dw = await H.sftkReconcileChunkedWrite(ids, () => H.sftkWriteVerified({
      describe: 'x', write: async () => ({ error: 'INVALID_SESSION_ID' }), verify: async () => ({ ok: true }),
    }), H.sftkMergeArr);
    expect(dw.accepted).toBe(false);
    expect(dw.ok).toBe(false);
    expect(dw.raw.error).toBe('INVALID_SESSION_ID');
    expect(dw.notDone).toBe(450);
  });

  it('hard delete: the purge results of the accepted batches are merged', async () => {
    let n = 0;
    const dw = await H.sftkReconcileChunkedWrite(ids, (chunk) => H.sftkWriteVerified({
      describe: 'x',
      write: async () => { n++; if (n === 3) throw new Error('timeout'); return { deleteResults: chunk.map(id => ({ id, success: true })), purgedOk: chunk.length, purgeErrors: [] }; },
      verify: async () => ({ ok: true, detail: [] }),
    }), H.sftkMergeHard);
    expect(dw.raw.deleteResults).toHaveLength(400);
    expect(dw.raw.purgedOk).toBe(400);
    expect(dw.notDone).toBe(50);
  });

  it('all batches fine: ok, verified, nothing not done; stale detail merged across batches', async () => {
    let n = 0;
    const dw = await H.sftkReconcileChunkedWrite(ids, (chunk) => H.sftkWriteVerified({
      describe: 'x', write: async () => chunk.map(id => ({ id, success: true })),
      verify: async () => (++n === 2 ? { ok: false, detail: [chunk[0]], text: 'stale one' } : { ok: true, detail: [] }),
    }), H.sftkMergeArr);
    expect(dw.raw).toHaveLength(450);
    expect(dw.notDone).toBe(0);
    expect(dw.ok).toBe(false);
    expect(dw.detail).toEqual([ids[200]]);
    expect(dw.text).toBe('stale one');
  });

  it('every overwrite / delete path in runReconcile goes through the chunked writer, one batch per call', () => {
    const run = sliceFn(SR, 'runReconcile');
    for (const t of ['SF_HARD_DELETE', 'SF_COLLECTIONS_DELETE']) {
      const lines = run.split('\n').filter(l => l.includes(`type: '${t}'`));
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const l of lines) expect(l).toMatch(/ids \}\)/);              // the chunk, never the whole delIds list
    }
    expect((run.match(/sftkReconcileChunkedWrite\(/g) || []).length).toBe(4);
    const ovw = sliceFn(SR, 'reconcileOverwrite');
    expect(ovw).toMatch(/sftkReconcileChunkedWrite\(payloads,/);
    expect(ovw).toMatch(/records: part \}/);
    // refused / unsent records are counted as failed, never as nothing
    expect(ovw).toMatch(/failed: payloads\.length - ok/);
  });
});
