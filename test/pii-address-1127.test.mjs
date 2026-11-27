// 2026-11-27, the owner on the PII suggestions of an Account's billing address:
//   "why billing address pii suggestions looks wierd to me?"  — BillingCity "Austin" was shown becoming a
//   30-character code and BillingPostalCode "27215" a 20-character one: a city and a postal code had no pattern
//   of their own, so a ticked one fell to the pseudonym.
//   "also you dont explain what pseudonym works … on hover" / "same explanation with example should be for
//   every possible option"
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';
import { readFileSync } from 'node:fs';
const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const NAMES = ['sftkPiiHashHex', 'sftkPiiMaskable', 'sftkPiiFormat', 'sftkPiiMaskValue', 'sftkPiiSuggest',
  'sftkPiiPatternList', 'sftkPiiIlIdValid', 'sftkPiiLuhn', 'sftkPiiDetectPattern', 'sftkPiiPatternFormat', 'sftkPiiNameLists',
  'sftkPiiHasHebrew', 'sftkPiiNameListsHe', 'sftkPiiStreetLists', 'sftkPiiPersona', 'sftkPiiPersonaSeed', 'sftkPiiDomainSeed',
  'sftkPiiLuhnComplete', 'sftkPiiIbanValid', 'sftkPiiIbanMake', 'sftkPiiPhoneKeepShape', 'sftkPiiRefillDigits', 'sftkPiiDateShift',
  'sftkPiiFindSpans', 'sftkPiiPatternListV2', 'sftkPiiPatternFormatV2', 'sftkPiiScrubText', 'sftkPiiAudit'];
const pii = extractFunctions('sftk-pii.js', NAMES);
const SALT = 'a3f1c9d200aa11bb22cc33dd44ee55ff';
const fmt = async (v, pat, len) => pii.sftkPiiPatternFormatV2(await pii.sftkPiiHashHex(v, SALT), pat, len ? { type: 'string', length: len } : null, v, null, null);

describe('a city', () => {
  it('becomes another city name, the same one every time, never itself', async () => {
    const C = pii.sftkPiiStreetLists().city;
    const a = await fmt('Austin', 'city', 40);
    expect(C).toContain(a); expect(a).toBe(await fmt('Austin', 'city', 40));
    for (const c of C) expect(await fmt(c, 'city', 40)).not.toBe(c);
  });
  it('a Hebrew city stays Hebrew', async () => {
    expect(pii.sftkPiiStreetLists().cityHe).toContain(await fmt('חיפה', 'city', 40));
  });
});

describe('a postal code', () => {
  it('keeps its length and its shape: digits stay digits, letters stay letters in their case, separators stay', async () => {
    expect(await fmt('27215', 'postal', 20)).toMatch(/^\d{5}$/);
    expect(await fmt('78767-1234', 'postal', 20)).toMatch(/^\d{5}-\d{4}$/);
    expect(await fmt('SW1A 1AA', 'postal', 20)).toMatch(/^[A-Z]{2}\d[A-Z] \d[A-Z]{2}$/);
    expect(await fmt('k1a 0b1', 'postal', 20)).toMatch(/^[a-z]\d[a-z] \d[a-z]\d$/);
    expect(await fmt('27215', 'postal', 20)).toBe(await fmt('27215', 'postal', 20));
  });
  it('no letter stays the letter it was', async () => {
    const out = await fmt('ABCDEFGH', 'postal', 20);
    [...out].forEach((ch, i) => expect(ch).not.toBe('ABCDEFGH'[i]));
  });
});

describe('what is proposed for an address', () => {
  const sug = pii.sftkPiiSuggest('Account', [
    { name: 'BillingStreet', type: 'textarea', length: 255 }, { name: 'BillingCity', type: 'string', length: 40 },
    { name: 'BillingPostalCode', type: 'string', length: 20 }, { name: 'ZipCode__c', type: 'string', length: 10 }, { name: 'Home_City__c', type: 'string', length: 40 },
    { name: 'Velocity__c', type: 'string', length: 40 },
  ]);
  const of = f => (sug.find(s => s.field === f) || {}).pattern;
  it('the street, the city and the postal code each get their own pattern; none is pre-ticked on a company', () => {
    expect([of('BillingStreet'), of('BillingCity'), of('BillingPostalCode'), of('ZipCode__c'), of('Home_City__c')]).toEqual(['street', 'city', 'postal', 'postal', 'city']);
    expect(sug.filter(s => /Billing|Zip/.test(s.field)).every(s => !s.sure)).toBe(true);
  });
  it('a field that only ends like "city" inside another word is not a city', () => {
    expect(of('Velocity__c')).not.toBe('city');
  });
});

describe('the list of treatments', () => {
  const B = read('studio-builder.js');
  const api = new Function(`${read('sftk-pii.js')}\n${B.slice(B.indexOf('function bldPiiTreatmentOptions'), B.indexOf('// A rule from a treatment value, and back.'))}\nreturn { bldPiiTreatmentOptions };`)();
  it('every option of every field type says what it does and shows an example', () => {
    for (const t of ['string', 'textarea', 'email', 'phone', 'date', 'datetime', 'url', 'double']) {
      for (const o of api.bldPiiTreatmentOptions(t)) expect(o.title, t + ' · ' + o.value).toMatch(/\S.{30,} Example: \S/);
    }
  });
  it('a text field offers the city and the postal code', () => {
    expect(api.bldPiiTreatmentOptions('string').map(o => o.value)).toEqual(expect.arrayContaining(['street', 'city', 'postal', 'hash', 'null']));
  });
  it('the closed list carries the explanation of the treatment it shows, and follows a change', () => {
    expect(B).toContain(`title="\${esc((options.find(o => o.value === current) || {}).title || 'What this field is written as')}">`);
    expect(B).toContain("sel.title = (sel.selectedOptions[0] && sel.selectedOptions[0].title) || 'What this field is written as';");
  });
  it('the hover of an option shows the example from the field itself', () => {
    const f = new Function(`${B.slice(B.indexOf('function bldPiiOptionTitle'), B.indexOf('// Every option of one treatment list'))}\nreturn bldPiiOptionTitle;`)();
    expect(f('Another city name. Example: Austin → Lakewood', { from: 'Burlington', to: 'Salem' })).toBe('Another city name. On this field: Burlington → Salem');
    expect(f('Another city name. On this field: A → B', { from: 'C', to: 'D' })).toBe('Another city name. On this field: C → D');
    expect(f('Another city name. Example: Austin → Lakewood', null)).toBe('Another city name. Example: Austin → Lakewood');   // no value read: the general example stays
    expect(B).toContain("opt.title = bldPiiOptionTitle(opt.title, pairs[0]);");
    expect(B).toContain("bldPiiFillOptionExamples(p, objectApi, field, desc, eid('dsPiiFieldTreat'), records);");
  });
  it('background.js carries the same patterns', () => {
    const G = read('background.js');
    for (const s of ["} else if (patternId === 'city') {", "} else if (patternId === 'postal') {", "? 'city'", "? 'postal'"]) expect(G).toContain(s);
  });
});
