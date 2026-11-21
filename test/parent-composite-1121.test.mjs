// backlog 2026-11-08: "A composite key for a parent OUTSIDE the deployment" — the engine's lookup bridge and the
// parents' check matched on ONE field. A lookup resolution may now carry matchFields (several); every path that finds
// a parent reads them all and compares them together.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const BG = read('background.js'), REC = read('studio-reconcile.js'), SC = read('studio-scan.js'), DV = read('studio-deploy.js');
const { sftkDeployParentMatchFields: fieldsOf, sftkDeploySetParentMatchField: setKey } =
  extractFunctions('studio-deploy.js', ['sftkDeployParentMatchFields', 'sftkDeploySetParentMatchField']);
const { buildLookupCompareMap: cmpMap, _lookupSelectExpr: selExpr, _lookupResolvedVal: resolved, _lookupMatchFields: mfsOf, _lookupByWords: byWords } =
  extractFunctions('studio-scan.js', ['buildLookupCompareMap', '_lookupSelectExpr', '_lookupResolvedVal', '_lookupMatchFields', '_lookupByWords']);

const tree = () => ({ objectType: 'Account', lookupResolutions: {}, children: [
  { childSObject: 'Contact', lookupResolutions: { IndividualId: { strategy: 'match', matchObject: 'Individual', matchField: 'Name' } }, children: [] },
  { childSObject: 'Lead', lookupResolutions: {}, children: [] }] });
const step = { refObj: 'Individual', neededBy: [{ obj: 'Contact', field: 'IndividualId' }, { obj: 'Lead', field: 'IndividualId' }] };

describe('the key written on every lookup that points at the parent', () => {
  it('several fields: matchFields holds them, matchField is the first; reads back as one entry "A + B"', () => {
    const t = tree();
    expect(setKey(t, step, ['LastName', 'FirstName'])).toBe(2);
    expect(t.children[0].lookupResolutions.IndividualId).toEqual({ strategy: 'match', matchObject: 'Individual', matchField: 'LastName', matchFields: ['LastName', 'FirstName'] });
    expect(fieldsOf(t, step)).toEqual(['LastName + FirstName']);
    expect(setKey(t, step, ['LastName', 'FirstName'])).toBe(0);            // already so
    expect(setKey(t, step, ['FirstName', 'LastName'])).toBe(2);            // the order is part of the key
  });
  it('back to one field: matchFields goes', () => {
    const t = tree();
    setKey(t, step, ['LastName', 'FirstName']);
    expect(setKey(t, step, 'LastName')).toBe(2);
    expect('matchFields' in t.children[0].lookupResolutions.IndividualId).toBe(false);
    expect(fieldsOf(t, step)).toEqual(['LastName']);
    expect(setKey(t, step, ['Name', 'Name', ''])).toBe(2);                 // one distinct field is a single key
    expect('matchFields' in t.children[1].lookupResolutions.IndividualId).toBe(false);
  });
});

describe('the scan compares and shows a lookup by all the fields of its key', () => {
  const desc = { fields: [{ name: 'IndividualId', type: 'reference', relationshipName: 'Individual', referenceTo: ['Individual'] }, { name: 'AccountId', type: 'reference', relationshipName: 'Account', referenceTo: ['Account'] }] };
  const map = cmpMap(desc, { IndividualId: { strategy: 'match', matchObject: 'Individual', matchField: 'LastName', matchFields: ['LastName', 'FirstName'] } });
  it('the SELECT reads every field through the relationship; one field is as before', () => {
    expect(selExpr('IndividualId', map.IndividualId)).toBe('Individual.LastName,Individual.FirstName');
    expect(selExpr('AccountId', map.AccountId)).toBe('Account.Name');
    expect(mfsOf(map.IndividualId)).toEqual(['LastName', 'FirstName']); expect(byWords(map.AccountId)).toBe('Name');
  });
  it('the value is "A + B"; no parent, or a parent with every field empty, is empty', () => {
    expect(resolved({ Individual: { LastName: 'Levi', FirstName: 'Dana' } }, map.IndividualId)).toBe('Levi + Dana');
    expect(resolved({ Individual: { LastName: 'Levi', FirstName: null } }, map.IndividualId)).toBe('Levi + ');
    expect(resolved({ Individual: { LastName: null, FirstName: null } }, map.IndividualId)).toBe('');
    expect(resolved({ Individual: null }, map.IndividualId)).toBe('');
    expect(resolved({ Account: { Name: 'Acme' } }, map.AccountId)).toBe('Acme');
  });
});

describe('the paths that find the parent', () => {
  it('the engine bridge: every field read in both orgs, the target asked by the first, the key compared whole; a PII-covered field skips the bridge', () => {
    expect(BG).toContain("const mFields = (Array.isArray(res.matchFields) && res.matchFields.filter(Boolean).length > 1) ? res.matchFields.filter(Boolean) : [res.matchField];");
    expect(BG).toContain("`SELECT Id, ${mFields.join(', ')} FROM ${res.matchObject} WHERE Id IN (${idList})`");
    expect(BG).toContain("`SELECT Id, ${mFields.join(', ')} FROM ${res.matchObject} WHERE ${mFields[0]} IN (${valList})`");
    expect(BG).toContain("for (const f of mFields) { const v = r[f]; if (v == null || v === '') return null; parts.push(String(v)); }");
    expect(BG).toContain('a key of several fields cannot be compared disguised; the bridge was skipped');
    expect(BG).not.toMatch(/[\x00-\x08\x0e-\x1f]/);          // the separator is written as an escape, never as a raw control character
  });
  it('the update path: the same key, the same ambiguity rule', () => {
    expect(REC).toContain("...refPairs.flatMap(rp => rp.matchFields.map(mf => `${rp.relName}.${mf}`)),");
    expect(REC).toContain("query: `SELECT Id, ${rp.matchFields.join(', ')} FROM ${rp.parentObj} WHERE ${rp.matchFields[0]} IN (${lit})` });");
    expect(REC).toContain('const key = sr[rp.relName] ? lkKey(sr[rp.relName], rp.matchFields) : null;');
    expect(REC).not.toMatch(/[\x00-\x08\x0e-\x1f]/);
  });
  it('the per-field push: every field in the WHERE; an incomplete key is said, not guessed', () => {
    expect(SC).toContain("for (const mf of _lookupMatchFields(info)) sel.add(`${info.relName}.${mf}`);");
    expect(SC).toContain('is not complete for this record (one of the fields is empty)');
  });
  it('the parents check aligns by the same fields', () => {
    expect(REC).toContain("const byFields = String(by).split(' + ').map(x => x.trim()).filter(Boolean);");
    expect(REC).toContain("...(byFields.length > 1 ? { matching: { strategy: 'composite', fields: byFields, normalize: {} } } : {})");
  });
  it('the dialog offers Composite with a second and third field, and refuses one field under it', () => {
    expect(DV).toContain("${radio('composite', 'Composite', false,");
    expect(DV).toContain('data-pm-more="${i}"');
    expect(DV).toContain("if (strategy === 'composite' && key.length < 2) return showToast('A composite key needs a second field");
  });
});
