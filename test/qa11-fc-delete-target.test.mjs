// QA 1.1 finding C1 — Delete Field acts on the field that was confirmed, not on whatever is selected when a step runs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const { fcDeleteTarget: target, fcDeleteStillSelected: still } = extractFunctions('field-cleaner.js', ['fcDeleteTarget', 'fcDeleteStillSelected']);

const ORG = 'https://acme.my.salesforce.com';
const obj = { api: 'Account', label: 'Account' };
const A = { api: 'A__c', label: 'A', type: 'Text', durableId: 'x.1' };
const B = { api: 'B__c', label: 'B', type: 'Number', durableId: 'x.2' };

describe('the field of a delete is fixed when it is confirmed', () => {
  it('is a frozen copy: a later pick in the picker cannot change it', () => {
    const sel = { obj: { ...obj }, field: { ...A } };
    const t = target(sel.obj, sel.field, ORG);
    sel.field = B; sel.obj.api = 'Contact';                       // what selectField / selectObject do meanwhile
    expect(t).toEqual({ objApi: 'Account', fldApi: 'A__c', label: 'A', type: 'Text', orgUrl: ORG });
    expect(Object.isFrozen(t)).toBe(true);
    expect(() => { 'use strict'; t.fldApi = 'B__c'; }).toThrow();
    expect(t.fldApi).toBe('A__c');
  });
  it('there is no target without an object and a field, so nothing is asked or deleted', () => {
    expect(target(null, A, ORG)).toBe(null);
    expect(target(obj, null, ORG)).toBe(null);
    expect(target({}, A, ORG)).toBe(null);
    expect(target(obj, {}, ORG)).toBe(null);
  });
  it('knows whether the page is still on the deleted field', () => {
    const t = target(obj, A, ORG);
    expect(still(t, obj, A, ORG)).toBe(true);
    expect(still(t, obj, B, ORG)).toBe(false);                     // another field picked
    expect(still(t, { api: 'Contact' }, A, ORG)).toBe(false);      // same field name on another object
    expect(still(t, obj, null, ORG)).toBe(false);                  // another object picked: the field is forgotten
    expect(still(t, null, null, ORG)).toBe(false);
    expect(still(t, obj, A, 'https://other.my.salesforce.com')).toBe(false);
    expect(still(null, obj, A, ORG)).toBe(false);
  });
});

describe('doDelete reads the target only', () => {
  const dd = FC.slice(FC.indexOf('async function doDelete(fieldId, target) {'), FC.indexOf('// ── XML Inspector'));
  const cd = FC.slice(FC.indexOf('async function confirmDelete(fieldId) {'), FC.indexOf('function _explainDeleteError(raw)'));
  it('the target is taken before the first wait of the confirm, named in the dialog and handed on', () => {
    const at = cd.indexOf('const target = fcDeleteTarget(_selObj, _selField, _orgUrl);');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(cd.indexOf('await '));
    expect(cd).toContain('items: [{ label: `${target.objApi}.${target.fldApi}`, sub: target.type }]');
    expect(cd).toContain('if (ok) doDelete(fieldId, target);');
  });
  it('the live selection is read in one place: to decide where the outcome is shown', () => {
    expect(dd.length).toBeGreaterThan(500);
    const live = dd.split('\n').filter(l => !/^\s*\/\//.test(l) && /_selObj|_selField/.test(l));
    expect(live.length).toBe(2);
    expect(live[0]).toContain('const here = fcDeleteStillSelected(target, _selObj, _selField, _orgUrl) && gen === _orgGen;');
    expect(live[1]).toContain('const sameList = gen === _orgGen && _orgUrl === orgUrl && !!_selObj && _selObj.api === objApi;');
    // every call is sent to the org of the target
    expect(dd).not.toMatch(/orgUrl: _orgUrl/);
    expect(dd).not.toMatch(/sid: _sid/);
  });
  it('the Metadata API retry names the target and is not sent after an org switch', () => {
    expect(dd).toContain('await _deleteFieldViaMetadata(`${objApi}.${fldApi}`)');
    expect(dd).toMatch(/const md = \(gen !== _orgGen \|\| _orgUrl !== orgUrl\)\s*\? \{ error: `The org was switched while/);
    expect(dd).toContain('The field was not deleted.');
  });
  it('History, the re-read, the picker list and the card speak of the target', () => {
    expect(dd).toContain('title: `🗑 Delete field — ${objApi}.${fldApi}`, orgUrl })');
    expect(dd).toContain("const wantName = fldApi.replace(/__c$/, '');");
    expect(dd).toContain('`Delete ${objApi}.${fldApi} in ${orgHost}`');
    expect(dd).toContain('const gone = fldApi;');
    expect(dd).toContain('if (sameList) _allFields = (_allFields || []).filter(f => f && f.api !== gone && f.name !== gone);');
    expect(dd).toContain('${esc(objApi)}.${esc(fldApi)} is deleted${here ? \'\' : ` in ${esc(orgHost)}`}');
  });
  it('a view that moved on is not reset: the outcome is added to it', () => {
    const tail = dd.slice(dd.indexOf('if (here) {'));
    expect(tail.indexOf('resetFieldAndBelow();')).toBeGreaterThan(0);
    expect(tail.indexOf('resetFieldAndBelow();')).toBeLessThan(tail.indexOf('} else {'));
    expect(tail.slice(tail.indexOf('} else {'))).toContain("eid('fcResults')?.insertAdjacentHTML('afterbegin', card);");
    expect(dd).toContain('❌ Delete of ${esc(objApi)}.${esc(fldApi)}');
  });
});
