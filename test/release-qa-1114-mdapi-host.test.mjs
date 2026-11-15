// RELEASE QA 2026-11-14 — sftkMdEditField and a component of ANOTHER object (its <fullName>'s host is not objApi).
// Live QA: ✂ of Account.SFTK_MX_Region__c stripped Contact's own same-named field from a Contact list view and a
// Contact field set (Salesforce accepted it), and ⇄ rewrote them to a field Contact does not have. A list view, a
// field set and a compact layout list fields of their OWN object, so a bare name there is that object's field.
// A validation rule of another object naming the bare token is refused with a text that says so (it used to say the
// formula did not name the field at all).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const M = new Function(`${read('sftk-mdapi.js')}\nreturn { sftkMdEditField };`)();
const F = 'SFTK_MX_Region__c', N = 'SFTK_MX_Area__c';
const rm = (t, x, o = 'Account') => M.sftkMdEditField(t, x, o, F, null);
const rp = (t, x, o = 'Account') => M.sftkMdEditField(t, x, o, F, N);
const untouched = (r, x, why) => { expect(r.refused).toMatch(why); expect(r.xml).toBe(x); expect(r.changed).toBe(false); expect(r.how).toEqual([]); };

describe('ListView of another object', () => {
  const lv = obj => `<fullName>${obj}.SFTK_MX_Contact_View</fullName><columns>FULL_NAME</columns><columns>${F}</columns><filterScope>Everything</filterScope><filters><field>${F}</field><operation>equals</operation><value>x</value></filters><label>V</label>`;
  it('✂ and ⇄ of Account.F leave a Contact view’s Contact.F alone, refused with the true reason', () => {
    const x = lv('Contact');
    for (const r of [rm('ListView', x), rp('ListView', x)]) {
      untouched(r, x, /a Contact list view holds Contact’s fields, not this one/);
      expect(r.unsure).toBeUndefined();
    }
  });
  it('the own object’s view is still edited', () => {
    const r = rm('ListView', lv('Account'));
    expect(r.refused).toBeNull();
    expect(r.xml).not.toContain(F);
    expect(rp('ListView', lv('Account')).xml).toContain(`<columns>${N}</columns>`);
  });
  it('a view whose object is not known (no dot in fullName) behaves as before', () => {
    const x = lv('Contact').replace('Contact.SFTK_MX_Contact_View', 'SFTK_MX_Contact_View');
    expect(rm('ListView', x).refused).toBeNull();
  });
  it('a path Account.F from a Contact view: cannot tell, unsure, nothing changed', () => {
    const x = lv('Contact').replace(`<columns>${F}</columns>`, `<columns>Account.${F}</columns>`);
    const r = rp('ListView', x);
    untouched(r, x, /cannot be told/);
    expect(r.unsure).toBe(true);
  });
});

describe('FieldSet of another object', () => {
  const row = (f, tag = 'displayedFields') => `<${tag}><field>${f}</field><isFieldManaged>false</isFieldManaged><isRequired>false</isRequired></${tag}>`;
  const fs = obj => `<fullName>${obj}.SFTK_MX_Contact_FS</fullName><description>d</description>${row('Name')}${row(F)}${row(F, 'availableFields')}<label>FS</label>`;
  it('✂ and ⇄ of Account.F leave a Contact field set alone', () => {
    const x = fs('Contact');
    untouched(rm('FieldSet', x), x, /a Contact field set holds Contact’s fields, not this one/);
    untouched(rp('FieldSet', x), x, /a Contact field set holds Contact’s fields/);
  });
  it('the own object’s field set is still edited', () => {
    const r = rp('FieldSet', fs('Account'));
    expect(r.refused).toBeNull();
    expect(r.xml).toContain(`<field>${N}</field>`);
  });
  it('a Task field set is Activity’s own (Activity.F cleaned)', () => {
    const r = rm('FieldSet', fs('Task'), 'Activity');
    expect(r.refused).toBeNull();
    expect(r.xml).not.toContain(F);
  });
});

describe('CompactLayout of another object', () => {
  const cl = obj => `<fullName>${obj}.SFTK_CL</fullName><fields>Name</fields><fields>${F}</fields><label>CL</label>`;
  it('✂ and ⇄ of Account.F leave a Contact compact layout alone', () => {
    const x = cl('Contact');
    untouched(rm('CompactLayout', x), x, /a Contact compact layout holds Contact’s fields/);
    untouched(rp('CompactLayout', x), x, /a Contact compact layout holds Contact’s fields/);
  });
  it('the own object’s compact layout is still edited', () => {
    expect(rm('CompactLayout', cl('Account')).xml).toBe('<fullName>Account.SFTK_CL</fullName><fields>Name</fields><label>CL</label>');
  });
});

describe('ValidationRule of another object naming the bare token', () => {
  const vr = `<fullName>Contact.SFTK_MX_VR_Contact</fullName><active>true</active><errorConditionFormula>ISBLANK(${F})</errorConditionFormula><errorMessage>m</errorMessage>`;
  it('refused, nothing changed, and the text says it is the rule’s own object’s same-named field', () => {
    untouched(rm('ValidationRule', vr), vr, /names SFTK_MX_Region__c as a field of the rule’s own object \(Contact\) — Contact’s same-named field, not this one/);
    untouched(rp('ValidationRule', vr), vr, /Contact’s same-named field/);
  });
  it('a rule that does not name the token keeps the old text', () => {
    const x = vr.replace(`ISBLANK(${F})`, 'ISBLANK(Other__c)');
    untouched(rm('ValidationRule', x), x, /does not name the field as a whole token/);
  });
});
