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
  // int / long moved to the whole-number block below (2026-11-15): still refused, with their own sentence
  it('refuses a decimal comma on every decimal number type', () => {
    for (const [t, s] of [['currency', '1,5'], ['double', '1.234,56'], ['percent', '12,5'], ['currency', '1.234,50'], ['double', '1,5'], ['double', '1,23,456'], ['double', ',5'], ['double', '1,2345']]) {
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
    expect(C('double', 'lots')).toEqual({ ok: false, error: 'a number' });
  });
  it('the merge dialog reports the refusal instead of writing 15', () => {
    const diff = { differ: [{ name: 'Amount', label: 'Amount', type: 'currency', values: [1, 2] }] };
    const c = sftkMergeChosen(diff, { Amount: { custom: '1,5' } }, 0);
    expect(c.body).toEqual({});
    expect(c.errors[0]).toMatchObject({ name: 'Amount' });
  });
});

// 3. (owner 2026-11-15) A whole-number field (int / long) takes an optional minus sign and digits only.
//    A decimal, a comma, grouping, a plus sign or an exponent is refused — never cut or rewritten.
describe('typed whole numbers: digits only, never truncated', () => {
  const WHOLE = 'a whole number: digits only, with - in front for a negative (1234 or -1234)';
  it('refuses a dot, a comma, grouping, a sign other than minus, an exponent and junk', () => {
    for (const t of ['int', 'long']) {
      for (const s of ['7.9', '7.0', '7.', '.5', '3,7', '12,34', '1,234', '1 234', '1 234', "1'234", '1e3', '1E3', '+5', '--5', '5-', '-', '0x10', 'Infinity', 'NaN', 'lots', '12abc']) {
        expect(C(t, s), `${t} ${JSON.stringify(s)}`).toEqual({ ok: false, error: WHOLE });
      }
    }
  });
  it('takes digits with an optional minus, trimmed; empty is null', () => {
    expect(C('int', '7')).toEqual({ ok: true, value: 7 });
    expect(C('int', '  1234 ')).toEqual({ ok: true, value: 1234 });
    expect(C('long', '-12000000')).toEqual({ ok: true, value: -12000000 });
    expect(C('int', '007')).toEqual({ ok: true, value: 7 });
    expect(C('int', '0')).toEqual({ ok: true, value: 0 });
    expect(Object.is(C('int', '-0').value, 0)).toBe(true);
    expect(C('long', '9007199254740991')).toEqual({ ok: true, value: 9007199254740991 });
    expect(C('int', '   ')).toEqual({ ok: true, value: null });
  });
  it('refuses digits a JS number cannot hold exactly instead of writing a neighbour', () => {
    expect(C('long', '9007199254740993')).toEqual({ ok: false, error: 'a whole number between -9007199254740991 and 9007199254740991' });
    expect(C('long', '-99999999999999999999').ok).toBe(false);
  });
  it('the decimal types are untouched: a decimal, grouping and an exponent still pass', () => {
    for (const t of ['double', 'currency', 'percent']) {
      expect(C(t, '7.9')).toEqual({ ok: true, value: 7.9 });
      expect(C(t, '1,234')).toEqual({ ok: true, value: 1234 });
      expect(C(t, '1e3')).toEqual({ ok: true, value: 1000 });
    }
  });
  it('the merge dialog reports the refusal and writes nothing for that field', () => {
    const diff = { differ: [{ name: 'NumberOfEmployees', label: 'Employees', type: 'int', values: [5, 9] }, { name: 'Phone', label: 'Phone', type: 'phone', values: ['1', '2'] }] };
    const c = sftkMergeChosen(diff, { NumberOfEmployees: { custom: '7.9' }, Phone: 1 }, 0);
    expect(c.errors).toEqual([{ name: 'NumberOfEmployees', label: 'Employees', error: WHOLE }]);
    expect(c.body).toEqual({ Phone: '2' });
    expect(c.changes.map(x => x.name)).toEqual(['Phone']);
  });
  it('a value PICKED from a copy is not typed text: it never goes through the check', () => {
    // a copy can hold 7.5 or '7.0' in a whole-number field (a changed field type, an external value);
    // picking that copy writes the copy's own value as it is, no refusal
    const diff = { differ: [{ name: 'N', label: 'N', type: 'int', values: [5, 7.5, '7.0'] }] };
    expect(sftkMergeChosen(diff, { N: 1 }, 0)).toMatchObject({ body: { N: 7.5 }, errors: [] });
    expect(sftkMergeChosen(diff, { N: 2 }, 0)).toMatchObject({ body: { N: '7.0' }, errors: [] });
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
