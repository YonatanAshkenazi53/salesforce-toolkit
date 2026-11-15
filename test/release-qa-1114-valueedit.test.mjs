// Release QA 2026-11-14 — ✏ Values, many records: "Save values" erased each
// record's own typed values on every field it showed as empty. A field typed
// differently per record (or on only some records) is rendered with an empty
// box, and Save cleared the field on every selected record for every empty box,
// hidden rows included. Now Save acts only on rows the user touched, a mixed row
// is said on the row and cleared only by its ✕, and the toast never claims
// "no typed value left" while untouched values are kept.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const VE = readFileSync(new URL('../studio-valueedit.js', import.meta.url), 'utf8');
const V = extractFunctions('sftk-valueedit.js', ['sftkValOvBucket', 'sftkValOvGet', 'sftkValOvSet', 'sftkValOvClear', 'sftkValOvManyAction'], { 'sftk-org-identity.js': ['sftkOrgKey'] });
const TGT = 'https://seven.develop.my.salesforce.com';

// the bulk Save loop, as studio-valueedit.js runs it, over plain row objects
function bulkSave(node, ids, rows) {
  const picks = [];
  for (const r of rows) {
    const act = V.sftkValOvManyAction(r);
    if (act === 'keep') continue;
    if (r.nullOn) { picks.push([r.field, null]); continue; }
    if (r.text === '') { picks.push([r.field, undefined]); continue; }
    picks.push([r.field, r.text]);
  }
  for (const id of ids) for (const [field, v] of picks) { if (v === undefined) V.sftkValOvClear(node, TGT, id, field); else V.sftkValOvSet(node, TGT, id, field, v); }
  return picks;
}

describe('many-record Save keeps each record\'s own typed values', () => {
  it('the reported case: Phone typed per record, Industry set for both — both Phones survive', () => {
    const node = {};
    V.sftkValOvSet(node, TGT, 'A', 'Phone', '111');
    V.sftkValOvSet(node, TGT, 'B', 'Phone', '222');
    bulkSave(node, ['A', 'B'], [
      { field: 'Phone', text: '', mixed: true },                        // rendered empty, never touched
      { field: 'Fax', text: '' },                                        // never touched
      { field: 'Industry', text: 'Banking', dirty: true },
    ]);
    expect(V.sftkValOvGet(node, TGT, 'A')).toEqual({ Phone: '111', Industry: 'Banking' });
    expect(V.sftkValOvGet(node, TGT, 'B')).toEqual({ Phone: '222', Industry: 'Banking' });
  });
  it('a field typed on only some records is left alone too', () => {
    const node = {};
    V.sftkValOvSet(node, TGT, 'A', 'Phone', '111');
    bulkSave(node, ['A', 'B'], [{ field: 'Phone', text: '', mixed: true }, { field: 'Industry', text: 'X', dirty: true }]);
    expect(V.sftkValOvGet(node, TGT, 'A').Phone).toBe('111');
    expect(V.sftkValOvGet(node, TGT, 'B').Phone).toBeUndefined();
  });
  it('a mixed row typed into and erased again goes back to "keep each"; only its ✕ clears it', () => {
    expect(V.sftkValOvManyAction({ dirty: true, mixed: true, text: '' })).toBe('keep');
    expect(V.sftkValOvManyAction({ dirty: true, mixed: true, cleared: true, text: '' })).toBe('clear');
    const node = {};
    V.sftkValOvSet(node, TGT, 'A', 'Phone', '111');
    V.sftkValOvSet(node, TGT, 'B', 'Phone', '222');
    bulkSave(node, ['A', 'B'], [{ field: 'Phone', text: '', mixed: true, dirty: true, cleared: true }]);
    expect(node.valueOverrides).toBeUndefined();
  });
  it('a touched row still sets, writes empty, or clears a shared value as before', () => {
    expect(V.sftkValOvManyAction({ dirty: true, text: '5' })).toBe('set');
    expect(V.sftkValOvManyAction({ dirty: true, nullOn: true, text: '' })).toBe('null');
    expect(V.sftkValOvManyAction({ dirty: true, text: '' })).toBe('clear');   // a shared value erased
    expect(V.sftkValOvManyAction({ text: '5' })).toBe('keep');                 // untouched: nothing to do
    expect(V.sftkValOvManyAction({ nullOn: true, text: '' })).toBe('keep');
  });
});

describe('the dialog is wired to it', () => {
  it('Save asks the helper per row, before any push', () => {
    const save = VE.slice(VE.indexOf("eid('dsVeSave')?.addEventListener"), VE.indexOf("eid('dsVeClearAll')?.addEventListener"));
    const at = save.indexOf("if (act === 'keep') return;");
    expect(save).toContain('const act = sftkValOvManyAction({ dirty: !!inp.dataset.veDirty, cleared: !!inp.dataset.veCleared, mixed: !!inp.dataset.veMixed, nullOn: tr.classList.contains(\'ds-ve-null-on\'), text });');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(save.indexOf('picks.push('));
  });
  it('typing, ∅ and ✕ mark the row as touched; ✕ marks it cleared', () => {
    expect(VE).toContain("inp.addEventListener('input', () => { inp.dataset.veDirty = '1'; });");
    expect(VE).toContain("inp.dataset.veDirty = '1'; inp.dataset.veCleared = '1';");
    const nul = VE.slice(VE.indexOf("host.querySelectorAll('[data-ve-null]')"), VE.indexOf("host.querySelectorAll('[data-ve-clear]')"));
    expect(nul).toContain("inp.dataset.veDirty = '1';");
  });
  it('a mixed row is said on the row, shown as changed, and its ✕ is offered', () => {
    expect(VE).toContain('const mixedOv = f => many && !f.reference && sameOv(f) === undefined && ids.some(id => f.name in ovOf(id));');
    expect(VE).toContain("${mixed ? ' data-ve-mixed=\"1\"' : ''}");
    expect(VE).toContain("mixed ? 'different values per record — each keeps its own unless you type one for all'");
    expect(VE).toContain('const edited = f.reference ? !!cur : (cur !== undefined || mixed);');
    expect(VE).toContain('!!(inp && inp.dataset.veMixed && !inp.dataset.veCleared)');
  });
  it('the toast does not say "no typed value left" while kept values remain', () => {
    expect(VE).toContain('const kept = ids.some(id => Object.keys(ovOf(id)).length);');
    expect(VE).toContain("'Nothing changed — each record keeps its own typed values.'");
  });
});
