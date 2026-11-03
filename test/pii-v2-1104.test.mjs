// PII v2 — FABRICATION (1.1, 2026-11-04). v1 hashed; a seeded sandbox full of
// "k3f9x2q1a7@masked.invalid" was safe and useless ("not good enough",
// 2026-10-31). v2 fabricates values that look real, pass validation and stay
// coherent inside a record, on v1's contract: SHA-256(salt | value), never
// the original, "fabricated" never "anonymous".
import { describe, it, expect, afterEach } from 'vitest';
import { extractFunctions } from './extract.mjs';
import { readFileSync } from 'node:fs';

const NAMES = ['sftkPiiHashHex', 'sftkPiiMaskable', 'sftkPiiFormat', 'sftkPiiMaskValue', 'sftkPiiSuggest',
  'sftkPiiPatternList', 'sftkPiiIlIdValid', 'sftkPiiLuhn', 'sftkPiiDetectPattern', 'sftkPiiPatternFormat', 'sftkPiiNameLists',
  'sftkPiiHasHebrew', 'sftkPiiNameListsHe', 'sftkPiiStreetLists', 'sftkPiiPersona', 'sftkPiiPersonaSeed', 'sftkPiiDomainSeed',
  'sftkPiiLuhnComplete', 'sftkPiiIbanValid', 'sftkPiiIbanMake', 'sftkPiiPhoneKeepShape', 'sftkPiiRefillDigits', 'sftkPiiDateShift',
  'sftkPiiFindSpans', 'sftkPiiPatternListV2', 'sftkPiiPatternFormatV2', 'sftkPiiScrubText', 'sftkPiiAudit'];
const pii = extractFunctions('sftk-pii.js', NAMES);
const SALT = 'a3f1c9d200aa11bb22cc33dd44ee55ff';
const hex = v => pii.sftkPiiHashHex(v, SALT);

describe('the persona of a record', () => {
  it('is deterministic, and its parts agree: the e-mail is made from the same names', async () => {
    const h = await hex('persona|Dana|Levi');
    const p1 = pii.sftkPiiPersona(h, false), p2 = pii.sftkPiiPersona(h, false);
    expect(p1).toEqual(p2);
    expect(p1.first).toBeTruthy(); expect(p1.last).toBeTruthy();
    expect(p1.domain).toMatch(/^[a-z0-9]+\.invalid$/);
    const email = pii.sftkPiiPatternFormatV2(h, 'email-person', { type: 'email', length: 80 }, 'dana@real.com', p1, null);
    expect(email).toBe(`${p1.firstLatin}.${p1.lastLatin}@${p1.domain}`.toLowerCase());
    expect(email.endsWith('.invalid')).toBe(true);   // undeliverable by design
  });
  it('a Hebrew source name stays Hebrew; its e-mail is still ASCII', async () => {
    const h = await hex('persona|דנה|לוי');
    const p = pii.sftkPiiPersona(h, true);
    expect(p.first).toMatch(/[א-ת]/); expect(p.last).toMatch(/[א-ת]/);
    expect(pii.sftkPiiPatternFormatV2(h, 'person-name', null, 'דנה לוי', null, null)).toMatch(/^[א-ת ]+$/);
    expect(pii.sftkPiiPatternFormatV2(h, 'email-person', null, 'x@y.co.il', p, null)).toMatch(/^[a-z0-9.]+@[a-z0-9]+\.invalid$/);
  });
  it('the seed: name parts when the record has them, else the value itself; the domain follows the Account', () => {
    expect(pii.sftkPiiPersonaSeed({ FirstName: 'Dana', LastName: 'Levi' }, 'dana@real.com')).toBe('persona|Dana|Levi');
    expect(pii.sftkPiiPersonaSeed({ Name: 'Dana Levi' }, 'x')).toBe('persona|Dana Levi');
    expect(pii.sftkPiiPersonaSeed({}, 'dana@real.com')).toBe('value|dana@real.com');
    expect(pii.sftkPiiDomainSeed({ AccountId: '001A' })).toBe('domain|001A');
    expect(pii.sftkPiiDomainSeed({ Account: { Name: 'Acme' } })).toBe('domain|Acme');
    expect(pii.sftkPiiDomainSeed({})).toBeNull();
  });
});

describe('fabricated identifiers that pass the target\'s checks', () => {
  it('card, last 4 kept: Luhn-valid, same brand digit, same length, the tail of the source', async () => {
    const src = '4539 5787 6362 1486';
    const out = pii.sftkPiiPatternFormatV2(await hex(src), 'card-last4', { type: 'string', length: 40 }, src, null, null);
    const digits = out.replace(/\D/g, '');
    expect(digits).toHaveLength(16);
    expect(digits[0]).toBe('4');
    expect(digits.slice(-4)).toBe('1486');
    expect(pii.sftkPiiLuhn(digits)).toBe(true);
    expect(digits).not.toBe('4539578763621486');
    expect(out).toMatch(/^\d{4} \d{4} \d{4} \d{4}$/);   // the source's grouping kept
  });
  it('IBAN: same country and length, check digits recomputed, never the source', async () => {
    const src = 'DE89370400440532013000';
    const out = pii.sftkPiiPatternFormatV2(await hex(src), 'iban', null, src, null, null);
    expect(out).toHaveLength(22);
    expect(out.slice(0, 2)).toBe('DE');
    expect(pii.sftkPiiIbanValid(out)).toBe(true);
    expect(out).not.toBe(src);
    expect(pii.sftkPiiIbanValid('DE89370400440532013000')).toBe(true);
    expect(pii.sftkPiiIbanValid('DE00370400440532013000')).toBe(false);
  });
  it('phone, same shape: US lands on 555-01xx with its area kept; IL keeps the 05X prefix; +country keeps the code; separators survive', async () => {
    const us = pii.sftkPiiPatternFormatV2(await hex('(415) 867-5309'), 'phone-keep', null, '(415) 867-5309', null, null);
    expect(us).toMatch(/^\(415\) 555-01\d{2}$/);
    const il = pii.sftkPiiPatternFormatV2(await hex('052-8461930'), 'phone-keep', null, '052-8461930', null, null);
    expect(il).toMatch(/^052-\d{7}$/); expect(il).not.toBe('052-8461930');
    const intl = pii.sftkPiiPatternFormatV2(await hex('+972 52-846-1930'), 'phone-keep', null, '+972 52-846-1930', null, null);
    expect(intl).toMatch(/^\+972 \d{2}-\d{3}-\d{4}$/);
    const uk = pii.sftkPiiPatternFormatV2(await hex('07911 123456'), 'phone-keep', null, '07911 123456', null, null);
    expect(uk).toMatch(/^07700 900\d{3}$/);
    expect(pii.sftkPiiPatternFormatV2(await hex('123'), 'phone-keep', null, '123', null, null)).toBeNull();   // not a phone
  });
  it('a date moves 1–180 days either way and keeps its shape; the age bracket survives', async () => {
    const d = pii.sftkPiiPatternFormatV2(await hex('1984-03-21'), 'date-shift', { type: 'date' }, '1984-03-21', null, null);
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d).not.toBe('1984-03-21');
    const diff = Math.abs((Date.parse(d) - Date.parse('1984-03-21')) / 86400000);
    expect(diff).toBeGreaterThanOrEqual(1); expect(diff).toBeLessThanOrEqual(180);
    const dt = pii.sftkPiiPatternFormatV2(await hex('1984-03-21T10:00:00.000+0000'), 'date-shift', { type: 'datetime' }, '1984-03-21T10:00:00.000+0000', null, null);
    expect(dt).toMatch(/^\d{4}-\d{2}-\d{2}T10:00:00\.000\+0000$/);
    expect(pii.sftkPiiPatternFormatV2(await hex('yesterday'), 'date-shift', null, 'yesterday', null, null)).toBeNull();
  });
  it('a street: number + name + kind; Hebrew in, Hebrew out', async () => {
    expect(pii.sftkPiiPatternFormatV2(await hex('12 Main St'), 'street', null, '12 Main St', null, null)).toMatch(/^\d{1,3} [A-Z][a-z]+ (St|Ave|Rd|Blvd|Ln|Dr|Way|Ct)$/);
    expect(pii.sftkPiiPatternFormatV2(await hex('הרצל 12'), 'street', null, 'הרצל 12', null, null)).toMatch(/^[א-ת ׳]+ \d{1,3}$/);
  });
  it('v1 ids still go through v1 (il-id with its check digit, us-ssn in the never-issued area)', async () => {
    const id = pii.sftkPiiPatternFormatV2(await hex('039128053'), 'il-id', null, '039128053', null, null);
    expect(pii.sftkPiiIlIdValid(id)).toBe(true);
    expect(pii.sftkPiiPatternFormatV2(await hex('123-45-6789'), 'us-ssn', null, '123-45-6789', null, null)).toMatch(/^9\d{2}-\d{2}-\d{4}$/);
  });
  it('a shape the field cannot hold comes back null — never truncated', async () => {
    expect(pii.sftkPiiPatternFormatV2(await hex('x'), 'email-person', { type: 'email', length: 8 }, 'x@y.com', null, null)).toBeNull();
  });
});

describe('free text: what looks like PII is found and replaced, the rest stays', () => {
  it('finds e-mails, phones, cards, IBANs, SSNs and Israeli IDs, longest match first, no overlaps', () => {
    const t = 'Call Dana at 052-8461930 or dana@real.com; card 4539 5787 6362 1486, ID 039128053, SSN 123-45-6789, IBAN DE89 3704 0044 0532 0130 00.';
    const spans = pii.sftkPiiFindSpans(t).map(s => `${s.pattern}:${s.text}`);
    expect(spans).toEqual([
      'il-mobile:052-8461930', 'email:dana@real.com', 'credit-card:4539 5787 6362 1486', 'il-id:039128053', 'us-ssn:123-45-6789', 'iban:DE89 3704 0044 0532 0130 00',
    ]);
  });
  it('a 9-digit number that fails the ID check digit, or a 16-digit one that fails Luhn, is not PII', () => {
    expect(pii.sftkPiiFindSpans('order 123456789 and 1234 5678 9012 3456')).toEqual([]);
  });
  it('scrub keeps the prose, replaces each span with a fake of its kind, deterministically, inside the field length', async () => {
    const t = 'Call Dana at 052-8461930 or dana@real.com before 5pm.';
    const a = await pii.sftkPiiScrubText(t, SALT, { type: 'textarea', length: 500 });
    const b = await pii.sftkPiiScrubText(t, SALT, { type: 'textarea', length: 500 });
    expect(a).toEqual(b);
    expect(a.replaced).toBe(2);
    expect(a.text).toMatch(/^Call Dana at 05\d-\d{7} or [a-z0-9.]+@[a-z0-9]+\.invalid before 5pm\.$/);
    expect(a.text).not.toContain('052-8461930'); expect(a.text).not.toContain('dana@real.com');
    expect(await pii.sftkPiiScrubText('nothing here', SALT, null)).toEqual({ text: 'nothing here', replaced: 0 });
  });
  it('the audit counts what still looks like PII in sampled values, per pattern and field', () => {
    // our own fabrication (an e-mail on .invalid) is never a finding; a field the policy fabricates is reported apart
    const r = pii.sftkPiiAudit({ Email: ['a.b@northwind.invalid', 'real@gmail.com'], Phone: ['052-8461930', null], Description: ['fine', 'card 4539578763621486'] }, ['Phone']);
    expect(r.sampled).toBe(5); expect(r.fields).toBe(3);
    expect(r.hits).toEqual({ email: { n: 1, fields: ['Email'] }, 'credit-card': { n: 1, fields: ['Description'] } });
    expect(r.expected).toEqual({ 'il-mobile': { n: 1, fields: ['Phone'] } });
  });
});

describe('sftkPiiMaskValue with a pattern rule (both files, byte for byte)', () => {
  it('scrub → the scrubbed text, counted as hashed only when something was replaced', async () => {
    const r = await pii.sftkPiiMaskValue('mail dana@real.com', { type: 'textarea', length: 200 }, SALT, { strategy: 'pattern', pattern: 'scrub' });
    expect(r.action).toBe('hashed'); expect(r.replaced).toBe(1); expect(r.value).not.toContain('dana@real.com');
    const k = await pii.sftkPiiMaskValue('plain', { type: 'textarea', length: 200 }, SALT, { strategy: 'pattern', pattern: 'scrub' });
    expect(k).toEqual({ value: 'plain', action: 'kept', replaced: 0 });
  });
  it('email-person takes the record\'s persona and domain from ctx; without ctx it still derives from the value', async () => {
    const h = await hex('persona|Dana|Levi');
    const persona = pii.sftkPiiPersona(h, false);
    const a = await pii.sftkPiiMaskValue('dana@real.com', { type: 'email', length: 80 }, SALT, { strategy: 'pattern', pattern: 'email-person' }, { persona, domain: 'acme.invalid' });
    expect(a.value).toBe(`${persona.firstLatin}.${persona.lastLatin}@acme.invalid`.toLowerCase());
    const b = await pii.sftkPiiMaskValue('dana@real.com', { type: 'email', length: 80 }, SALT, { strategy: 'pattern', pattern: 'email-person' });
    expect(b.action).toBe('hashed'); expect(b.value).toMatch(/^[a-z0-9.]+@[a-z0-9]+\.invalid$/);
  });
  it('the worker copies are byte-for-byte the canonical ones (v2 joins the parity contract)', () => {
    const slice = (file, name) => {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(src);
      if (!m) throw new Error(`${name} not in ${file}`);
      return src.slice(m.index, src.indexOf('\n}', m.index) + 2);
    };
    for (const n of NAMES) expect(slice('background.js', n), n).toBe(slice('sftk-pii.js', n));
  });
});

describe('the engine masks rows with a persona per record', () => {
  const eng = extractFunctions('background.js', [...NAMES, 'sftkPiiRulesForObject', 'sftkPiiMaskRows']);
  afterEach(() => {});
  const desc = [{ name: 'FirstName', type: 'string', length: 40 }, { name: 'LastName', type: 'string', length: 80 }, { name: 'Email', type: 'email', length: 80 }, { name: 'Phone', type: 'phone', length: 40 }];
  const rules = eng.sftkPiiRulesForObject({ 'Contact.FirstName': { strategy: 'pattern', pattern: 'first-name' }, 'Contact.LastName': { strategy: 'pattern', pattern: 'last-name' },
    'Contact.Email': { strategy: 'pattern', pattern: 'email-person' }, 'Contact.Phone': { strategy: 'pattern', pattern: 'phone-keep' } }, 'Contact', desc);
  it('FirstName, LastName and Email agree; two Contacts of one Account share a domain; the same person is the same everywhere', async () => {
    const recs = [
      { Id: 'C1', FirstName: 'Dana', LastName: 'Levi', Email: 'dana@real.com', Phone: '052-8461930', AccountId: '001A' },
      { Id: 'C2', FirstName: 'Noa', LastName: 'Cohen', Email: 'noa@real.com', Phone: '03-7241905', AccountId: '001A' },
      { Id: 'C3', FirstName: 'Dana', LastName: 'Levi', Email: 'dana.levi@other.com', Phone: '054-1111111', AccountId: '001B' },
    ];
    const out = await eng.sftkPiiMaskRows(recs, 'Contact', rules, SALT, new Map());
    const r = out.rows;
    const email1 = r[0].Email.value, first1 = r[0].FirstName.value, last1 = r[0].LastName.value;
    expect(email1).toBe(`${first1}.${last1}`.toLowerCase().replace(/[^a-z0-9.]+/g, '') + '@' + email1.split('@')[1]);
    expect(r[0].Email.value.split('@')[1]).toBe(r[1].Email.value.split('@')[1]);          // one Account, one domain
    expect(r[2].Email.value.split('@')[1]).not.toBe(r[0].Email.value.split('@')[1]);      // another Account, another domain
    expect([r[2].FirstName.value, r[2].LastName.value]).toEqual([first1, last1]);          // the same person, the same name
    expect(r[0].Phone.value).toMatch(/^052-\d{7}$/); expect(r[1].Phone.value).toMatch(/^03-\d{7}$/);
    expect(out.counts).toEqual({ hashed: 12, nulled: 0, fixed: 0 });
    for (const row of r) for (const f of ['FirstName', 'LastName', 'Email', 'Phone']) expect(row[f].value).not.toBe(recs[r.indexOf(row)][f]);
  });
  it('a record without name parts: a lone e-mail still derives from its own value (v1 contract), and the cache keys tell the two apart', async () => {
    const recs = [{ Id: 'L1', Email: 'x@real.com' }, { Id: 'L2', Email: 'x@real.com' }];
    const lr = eng.sftkPiiRulesForObject({ 'Lead.Email': { strategy: 'pattern', pattern: 'email-person' } }, 'Lead', [{ name: 'Email', type: 'email', length: 80 }]);
    const out = await eng.sftkPiiMaskRows(recs, 'Lead', lr, SALT, new Map());
    expect(out.rows[0].Email.value).toBe(out.rows[1].Email.value);
    expect(out.rows[0].Email.value).toMatch(/\.invalid$/);
  });
});
