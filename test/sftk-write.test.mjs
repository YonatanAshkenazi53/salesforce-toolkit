// sftkWriteVerified — the one write discipline (campaign 3, phase 1).
//
// ok is never true without a re-read that saw the intended state. A refusal,
// a missing verify, a verify that throws or answers nothing, and a verify that
// sees the old state each produce a distinct, honest sentence.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

const { sftkWriteVerified, sftkWriteVerifiedAll } = extractFunctions('sftk-write.js', ['sftkWriteVerified', 'sftkWriteVerifiedAll']);

describe('sftkWriteVerified', () => {
  it('ok only when the write was accepted AND the re-read saw the intended state', async () => {
    const r = await sftkWriteVerified({ describe: 'Flow X switched off', write: async () => ({ success: true }), verify: async () => ({ ok: true }) });
    expect(r).toMatchObject({ ok: true, accepted: true, verified: true, text: 'Flow X switched off — verified by re-reading the org' });
  });
  it('a refusal ({ error }) is not accepted, not verified, and quotes the refusal', async () => {
    const r = await sftkWriteVerified({ describe: 'Delete v1', write: async () => ({ error: 'DEPENDENCY_EXISTS: referenced by a subflow' }), verify: async () => ({ ok: true }) });
    expect(r).toMatchObject({ ok: false, accepted: false, verified: false });
    expect(r.text).toBe('Delete v1: refused — DEPENDENCY_EXISTS: referenced by a subflow');
  });
  it('a thrown write is a refusal too; success:false with an errorMessage as well', async () => {
    const a = await sftkWriteVerified({ describe: 'W', write: async () => { throw new Error('HTTP 400'); } });
    expect(a.accepted).toBe(false); expect(a.text).toBe('W: refused — HTTP 400');
    const b = await sftkWriteVerified({ describe: 'W', write: async () => ({ success: false, errorMessage: 'Deployment failed' }) });
    expect(b.accepted).toBe(false); expect(b.text).toBe('W: refused — Deployment failed');
  });
  it('accepted but the org still shows the old state → ok false, verified true, says so', async () => {
    const r = await sftkWriteVerified({ describe: 'Value “Closed” deleted', write: async () => ({}), verify: async () => ({ ok: false, text: 'Salesforce kept “Closed” as INACTIVE' }) });
    expect(r).toMatchObject({ ok: false, accepted: true, verified: true, text: 'Salesforce kept “Closed” as INACTIVE' });
  });
  it('no verify function → accepted, never ok, and the sentence says it was not re-read (with the reason)', async () => {
    const r = await sftkWriteVerified({ describe: 'Log deleted', write: async () => ({}), noVerify: 'Salesforce offers no read for a deleted log' });
    expect(r).toMatchObject({ ok: false, accepted: true, verified: false });
    expect(r.text).toBe('Log deleted: accepted by Salesforce — not re-read (Salesforce offers no read for a deleted log)');
  });
  it('a verify that throws or answers nothing leaves the write unverified and says so', async () => {
    const a = await sftkWriteVerified({ describe: 'W', write: async () => ({}), verify: async () => { throw new Error('Session expired'); } });
    expect(a).toMatchObject({ ok: false, accepted: true, verified: false });
    expect(a.text).toContain('could not be re-read to confirm it (Session expired)');
    const b = await sftkWriteVerified({ describe: 'W', write: async () => ({}), verify: async () => null });
    expect(b.verified).toBe(false); expect(b.text).toContain('the check gave no answer');
  });
  it('no write function → nothing written, says so', async () => {
    const r = await sftkWriteVerified({ describe: 'W' });
    expect(r.accepted).toBe(false); expect(r.text).toBe('W: nothing was written — no write function was given');
  });
  it('the verify receives the write result, and detail is carried through', async () => {
    let seen = null;
    const r = await sftkWriteVerified({ describe: 'W', write: async () => ({ id: '001' }), verify: async res => { seen = res; return { ok: true, detail: { n: 1 } }; } });
    expect(seen).toEqual({ id: '001' }); expect(r.detail).toEqual({ n: 1 });
  });
});

describe('sftkWriteVerifiedAll', () => {
  it('per-item verify: counts verified / not confirmed / refused in one sentence', async () => {
    const r = await sftkWriteVerifiedAll([
      { describe: 'A', write: async () => ({}), verify: async () => ({ ok: true }) },
      { describe: 'B', write: async () => ({ error: 'no' }) },
      { describe: 'C', write: async () => ({}), verify: async () => { throw new Error('x'); } },
      { describe: 'D', write: async () => ({}), verify: async () => ({ ok: false }) },
    ]);
    expect(r).toMatchObject({ ok: 1, accepted: 3, verified: 2, failed: 1 });
    expect(r.text).toBe('1 verified · 1 accepted but not confirmed · 1 accepted but the org shows otherwise · 1 refused of 4');
  });
  it('verifyAll: one re-read for the whole batch, aligned by index; refused items are not asked about', async () => {
    let asked = 0;
    const r = await sftkWriteVerifiedAll([
      { describe: 'A', write: async () => ({}) },
      { describe: 'B', write: async () => ({ error: 'no' }) },
      { describe: 'C', write: async () => ({}) },
    ], { verifyAll: async results => { asked++; return results.map((x, i) => i === 2 ? { ok: false } : { ok: true }); } });
    expect(asked).toBe(1);
    expect(r.results.map(x => [x.accepted, x.verified, x.ok])).toEqual([[true, true, true], [false, false, false], [true, true, false]]);
    expect(r.text).toBe('1 verified · 1 accepted but the org shows otherwise · 1 refused of 3');
  });
  it('verifyAll that throws leaves every accepted item unverified with the reason', async () => {
    const r = await sftkWriteVerifiedAll([{ describe: 'A', write: async () => ({}) }], { verifyAll: async () => { throw new Error('boom'); } });
    expect(r.results[0]).toMatchObject({ accepted: true, verified: false, ok: false });
    expect(r.results[0].text).toContain('(boom)');
  });
  it('stopOnRefusal stops after the first refusal', async () => {
    let n = 0;
    const r = await sftkWriteVerifiedAll([
      { describe: 'A', write: async () => { n++; return { error: 'no' }; } },
      { describe: 'B', write: async () => { n++; return {}; }, verify: async () => ({ ok: true }) },
    ], { stopOnRefusal: true });
    expect(n).toBe(1); expect(r.results.length).toBe(1);
  });
});
