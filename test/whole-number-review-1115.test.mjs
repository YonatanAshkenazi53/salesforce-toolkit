// Review of the whole-number refusal (2026-11-15) — the findings that were real, each with its proof.
//
// 1. The one-record value editor saves as you type. A refused value used to stop before the store, so the prefix
//    an earlier keystroke had saved stayed: 7.9 typed with a pause after the 7 left 7 stored, and Deploy wrote 7
//    under a box that showed 7.9 and said "not saved". A refused value now leaves no typed value for the field.
// 2. The limit sentence names the limit itself; an int field has its own 32-bit limit.
// 3. The format sentence names the minus sign.
// 4. The merge dialog's typed-value box carries the number hint the value editor gives.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const { sftkMergeCoerce: C } = extractFunctions('sftk-merge.js', ['sftkMergeCoerce']);

// the real saveRow, cut out of the dialog and run over a stand-in store and row
function editor(type, srcValue, stored) {
  const VE = read('studio-valueedit.js');
  const a = VE.indexOf('const saveRow = async tr => {'), b = VE.indexOf('\n  };', a);
  expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a);
  const store = { ...stored };
  const err = { textContent: '' };
  const inp = { value: '', dataset: { veField: 'NumberOfEmployees', veType: type, veSrc: srcValue } };
  const tr = { classList: { contains: () => false }, querySelector: sel => sel === '.ds-ve-in' ? inp : err };
  const saveRow = new Function('many', 'sftkMergeCoerce', 'sftkValOvClear', 'sftkValOvSet', 'sftkValOvGet', 'saveNode', 'eid', 'host', 'onSaved', 'node', 'p', 'ids',
    `${VE.slice(a, b + 5)}\nreturn saveRow;`)(
    false, C,
    (_n, _o, _id, field) => { delete store[field]; },
    (_n, _o, _id, field, v) => { store[field] = v; },
    () => store, async () => {}, () => null, { querySelector: () => null }, null, {}, { targetOrg: 'x' }, ['001']);
  return { store, err, type: async text => { inp.value = text; await saveRow(tr); } };
}

describe('value editor, one record: a refused value leaves no typed value behind', () => {
  it('7 → 7. → 7.9 on a whole-number field: the 7 saved on the way is dropped, and the row says what is written', async () => {
    const e = editor('int', '5', {});
    await e.type('7');
    expect(e.store).toEqual({ NumberOfEmployees: 7 });
    expect(e.err.textContent).toBe('');
    await e.type('7.');
    expect(e.store).toEqual({});
    await e.type('7.9');
    expect(e.store).toEqual({});
    expect(e.err.textContent).toBe("needs a whole number: digits only, with - in front for a negative (1234 or -1234) — not saved, the source's value is written until this fits");
  });
  it('a value typed earlier (12) edited into a refused one (12.5) is dropped too — the box no longer shows it', async () => {
    const e = editor('int', '5', { NumberOfEmployees: 12, Phone: '1' });
    await e.type('12.5');
    expect(e.store).toEqual({ Phone: '1' });
  });
  it('fixing the text stores it and clears the sentence', async () => {
    const e = editor('int', '5', {});
    await e.type('7.9'); await e.type('8');
    expect(e.store).toEqual({ NumberOfEmployees: 8 });
    expect(e.err.textContent).toBe('');
  });
  it('the source text itself, and an emptied box, behave as before', async () => {
    const e = editor('int', '5', { NumberOfEmployees: 7 });
    await e.type('5'); expect(e.store).toEqual({});
    await e.type(''); expect(e.store).toEqual({ NumberOfEmployees: null });
  });
});

describe('whole-number limits are the field type\'s own, and the sentence is true', () => {
  it('int is 32-bit: the ends pass, one past each end is refused with the limits', () => {
    const INT = 'a whole number between -2147483648 and 2147483647';
    expect(C('int', '2147483647')).toEqual({ ok: true, value: 2147483647 });
    expect(C('int', '-2147483648')).toEqual({ ok: true, value: -2147483648 });
    expect(C('int', '2147483648')).toEqual({ ok: false, error: INT });
    expect(C('int', '3000000000')).toEqual({ ok: false, error: INT });
    expect(C('int', '-2147483649')).toEqual({ ok: false, error: INT });
    expect(C('int', '99999999999999999999999')).toEqual({ ok: false, error: INT });
  });
  it('long: every digit count the sentence allows is accepted, the first number past it is refused', () => {
    const LONG = 'a whole number between -9007199254740991 and 9007199254740991';
    expect(C('long', '3000000000')).toEqual({ ok: true, value: 3000000000 });
    expect(C('long', '1234567890123456')).toEqual({ ok: true, value: 1234567890123456 });   // 16 digits, inside the limit
    expect(C('long', '9007199254740991').ok).toBe(true);
    expect(C('long', '-9007199254740991').ok).toBe(true);
    expect(C('long', '9007199254740992')).toEqual({ ok: false, error: LONG });
    expect(C('long', '-9007199254740992')).toEqual({ ok: false, error: LONG });
    expect(LONG).not.toMatch(/digits/);
  });
  it('leading zeros are a number inside the limit, whatever their count', () => {
    expect(C('int', '0000000000000000000000007')).toEqual({ ok: true, value: 7 });
  });
  it('a plus sign and a typographic minus are refused with a sentence that names the minus to use', () => {
    for (const s of ['+7', '\u22125', '\u20135']) {
      const r = C('int', s);
      expect(r.ok, s).toBe(false);
      expect(r.error).toContain('with - in front for a negative');
      expect(r.error).toContain('-1234');
    }
    expect(C('int', '-007')).toEqual({ ok: true, value: -7 });
  });
});

describe('the merge dialog says the number format before Merge is pressed', () => {
  it('its typed-value box has the whole-number and number hints of the value editor', () => {
    const D = read('studio-deploy.js');
    const m = /const hint = t => (.+?);/.exec(D.slice(D.indexOf("const hint = t => t === 'date' ? 'YYYY-MM-DD' : t === 'datetime' ? '2026-10-14T09:30:00Z'")));
    const hint = new Function(`return t => ${m[1]};`)();
    expect(hint('int')).toBe('a whole number');
    expect(hint('long')).toBe('a whole number');
    for (const t of ['double', 'currency', 'percent']) expect(hint(t)).toBe('a number');
    expect(hint('reference')).toBe('a Salesforce id');
    expect(hint('date')).toBe('YYYY-MM-DD');
    expect(hint('string')).toBe('type a value…');
    expect(D).toContain('data-merge-custom="${esc(f.name)}" placeholder="${esc(hint(f.type))}"');
  });
});
