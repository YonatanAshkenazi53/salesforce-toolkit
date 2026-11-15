// Release QA 2026-11-14 — sftk-merge.js sftkMergeCoerce (typed values of the merge
// dialog and of the Data Studio value editor, both written to the org).
//
// 1. A comma is a thousands separator only where it groups thousands; a decimal
//    comma (1,5 / 12,5 / 1.234,56) is refused, never rescaled 10x-100x.
// 2. A datetime must be ISO with its zone: no US M/D guessing, no silent local
//    time, no junk read as a 2001 date, no rolled-over day.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

const { sftkMergeCoerce: C, sftkMergeChosen } = extractFunctions('sftk-merge.js', ['sftkMergeCoerce', 'sftkMergeChosen', '_sftkMergeNorm']);

describe('typed numbers: a decimal comma is refused, not rescaled', () => {
  it('refuses a decimal comma on every number type', () => {
    for (const [t, s] of [['currency', '1,5'], ['double', '1.234,56'], ['percent', '12,5'], ['currency', '1.234,50'], ['double', '1,5'], ['int', '3,7'], ['long', '12,34'], ['double', '1,23,456'], ['double', ',5'], ['double', '1,2345']]) {
      const r = C(t, s);
      expect(r.ok, `${t} ${s}`).toBe(false);
      expect(r.error).toMatch(/dot for decimals/);
    }
  });
  it('still takes thousands grouping and plain numbers', () => {
    expect(C('currency', '1,234.56')).toEqual({ ok: true, value: 1234.56 });
    expect(C('currency', '2,500')).toEqual({ ok: true, value: 2500 });
    expect(C('double', '-12,000,000')).toEqual({ ok: true, value: -12000000 });
    expect(C('double', '1.5')).toEqual({ ok: true, value: 1.5 });
    expect(C('double', '1e+21')).toEqual({ ok: true, value: 1e21 });
    expect(C('int', '7.9')).toEqual({ ok: true, value: 7 });   // truncation stays as designed (merge-1012)
    expect(C('double', 'lots')).toEqual({ ok: false, error: 'a number' });
  });
  it('the merge dialog reports the refusal instead of writing 15', () => {
    const diff = { differ: [{ name: 'Amount', label: 'Amount', type: 'currency', values: [1, 2] }] };
    const c = sftkMergeChosen(diff, { Amount: { custom: '1,5' } }, 0);
    expect(c.body).toEqual({});
    expect(c.errors[0]).toMatchObject({ name: 'Amount' });
  });
});

describe('typed datetimes: ISO with a zone only', () => {
  it('refuses US/local order, unzoned text, junk and rolled-over days', () => {
    for (const s of ['10/11/2026 09:30', '1', 'Q 3', '2026-10-14T09:30:00', '2026-10-14', '2026-02-30T09:30:00Z', '2026-10-14T25:30:00Z', '2026-13-01T09:30:00Z', 'Oct 14 2026 09:30 GMT']) {
      expect(C('datetime', s).ok, s).toBe(false);
    }
  });
  it('takes Z, an offset, and Salesforce\'s own +0000 form', () => {
    expect(C('datetime', '2026-10-14T09:30:00Z')).toEqual({ ok: true, value: '2026-10-14T09:30:00.000Z' });
    expect(C('datetime', '2026-10-14T09:30:00+02:00')).toEqual({ ok: true, value: '2026-10-14T07:30:00.000Z' });
    expect(C('datetime', '2026-10-14T09:30:00.000+0000')).toEqual({ ok: true, value: '2026-10-14T09:30:00.000Z' });
    expect(C('datetime', '2026-10-14 09:30Z')).toEqual({ ok: true, value: '2026-10-14T09:30:00.000Z' });
    expect(C('datetime', '2028-02-29T00:00:00Z').ok).toBe(true);
    // a value already stored by the editor (toISOString) is taken back unchanged
    expect(C('datetime', '2026-10-14T09:30:00.123Z')).toEqual({ ok: true, value: '2026-10-14T09:30:00.123Z' });
  });
});
