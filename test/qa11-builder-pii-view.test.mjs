// QA 1.1 finding 8: 🎭 Suggest PII from a child record's editor must work on the saved deployment, never on the child-rooted view.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const VE = readFileSync(new URL('../studio-valueedit.js', import.meta.url), 'utf8');
const { sftkVeSavedProfile: saved } = extractFunctions('studio-valueedit.js', ['sftkVeSavedProfile']);

describe('the deployment a record editor saves to', () => {
  const contact = { objectType: 'Contact' };
  const dep = { id: 'd1', tree: { objectType: 'Account', children: [contact] }, lastScan: { root: true } };
  const other = { id: 'd2', tree: { objectType: 'Lead' } };
  const profiles = [other, dep];

  it('a child-rooted view resolves to the stored deployment, whose tree still starts at the root object', () => {
    const view = { ...dep, tree: contact, lastScan: { child: true } };
    const got = saved(view, profiles);
    expect(got).toBe(dep);
    expect(got.tree.objectType).toBe('Account');
    expect(got.lastScan).toEqual({ root: true });
  });
  it('the root editor, which already holds the stored deployment, gets the same object back', () => {
    expect(saved(dep, profiles)).toBe(dep);
  });
  it('a deployment that is not stored, or no list at all, falls back to what the editor was given', () => {
    const loose = { id: 'x9', tree: contact };
    expect(saved(loose, profiles)).toBe(loose);
    expect(saved(loose, null)).toBe(loose);
    expect(saved(null, profiles)).toBe(null);
  });
  it('a policy written through the editor lands on the stored deployment, and the stored tree is untouched', () => {
    const view = { ...dep, tree: contact };
    const target = saved(view, profiles);
    target.piiPolicy = { Contact: { Email: { kind: 'hash' } } };
    expect(profiles[1].piiPolicy).toEqual({ Contact: { Email: { kind: 'hash' } } });
    expect(profiles[1].tree.children[0]).toBe(contact);
  });
  it('the button hands the suggestions the resolved deployment', () => {
    expect(VE).toContain('window._depPiiSuggest(sftkVeSavedProfile(p, typeof _profiles !== \'undefined\' ? _profiles : null), { [obj]: [ids[0]] }');
    expect(VE).not.toContain('window._depPiiSuggest(p, ');
  });
});
