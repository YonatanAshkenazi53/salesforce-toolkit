// FORMAT-PRESERVING PII PATTERNS.
//
// User 2026-08-20: "some text fields in our orgs are called ssn. israeli ssn
// has a special sequence — this can be enforced using salesforce. we need to
// be able to blend phone numbers to fake numbers, fake invalid email
// addresses. we can suggest the patterns."
//
// The point these tests defend: a masked value must still be a VALID value
// of its kind, or the target org rejects the seed (Israeli ת״ז carries a
// check digit; phones and cards have shapes). And detection must read actual
// VALUES, because a field called Custom_Field_12__c can hold ת״ז numbers
// that no name heuristic would ever catch.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

const P = extractFunctions('sftk-pii.js', [
  'sftkPiiHashHex', 'sftkPiiPatternList', 'sftkPiiIlIdValid', 'sftkPiiLuhn',
  'sftkPiiDetectPattern', 'sftkPiiPatternFormat', 'sftkPiiMaskValue',
  'sftkPiiMaskable', 'sftkPiiFormat', 'sftkPiiSuggest', 'sftkPiiNameLists',
]);
const SALT = 'a3f1c9d200aa11bb22cc33dd44ee55ff';
const hexOf = v => P.sftkPiiHashHex(v, SALT);

describe('sftkPiiIlIdValid — the real ת״ז check digit', () => {
  it('accepts valid IDs, rejects a single-digit change and malformed input', () => {
    for (const good of ['039128053', '000000018', '123456782']) {
      expect(P.sftkPiiIlIdValid(good), good).toBe(true);
    }
    for (const bad of ['039128052', '12345678', '1234567890', 'abcdefghi', '', null]) {
      expect(P.sftkPiiIlIdValid(bad), String(bad)).toBe(false);
    }
  });
});

describe('sftkPiiLuhn', () => {
  it('accepts Luhn-valid numbers (spaced or dashed), rejects a digit flip', () => {
    expect(P.sftkPiiLuhn('4539578763621486')).toBe(true);
    expect(P.sftkPiiLuhn('4539 5787 6362 1486')).toBe(true);
    expect(P.sftkPiiLuhn('4539-5787-6362-1486')).toBe(true);
    expect(P.sftkPiiLuhn('4539578763621487')).toBe(false);
    expect(P.sftkPiiLuhn('123')).toBe(false);
  });
});

describe('sftkPiiPatternFormat — masked values keep a VALID shape', () => {
  it('every generated Israeli ID passes the real check digit', async () => {
    // 60 distinct sources: a wrong check digit would make the target org
    // reject that row on write, which is the whole failure this prevents.
    for (let i = 0; i < 60; i++) {
      const out = P.sftkPiiPatternFormat(await hexOf(`person-${i}`), 'il-id', { type: 'string', length: 20 });
      expect(out, out).toMatch(/^\d{9}$/);
      expect(P.sftkPiiIlIdValid(out), out).toBe(true);
    }
  });

  it('every generated credit card is Luhn-valid', async () => {
    for (let i = 0; i < 30; i++) {
      const out = P.sftkPiiPatternFormat(await hexOf(`card-${i}`), 'credit-card', { type: 'string', length: 25 });
      expect(out).toMatch(/^4\d{15}$/);
      expect(P.sftkPiiLuhn(out), out).toBe(true);
    }
  });

  it('US SSNs land in the never-issued 900-999 area', async () => {
    for (let i = 0; i < 20; i++) {
      const out = P.sftkPiiPatternFormat(await hexOf(`ssn-${i}`), 'us-ssn', { type: 'string', length: 20 });
      expect(out, out).toMatch(/^9\d{2}-\d{2}-\d{4}$/);
    }
  });

  it('Israeli phones keep real shapes, and the detector agrees with the generator', async () => {
    const m = P.sftkPiiPatternFormat(await hexOf('m1'), 'il-mobile', { type: 'phone', length: 40 });
    expect(m).toMatch(/^0(50|52|53|54|55|58)-\d{7}$/);
    const l = P.sftkPiiPatternFormat(await hexOf('l1'), 'il-phone', { type: 'phone', length: 40 });
    expect(l).toMatch(/^0[23489]-\d{7}$/);
    expect(P.sftkPiiDetectPattern([m, m, m]).pattern).toBe('il-mobile');
  });

  it('emails stay RFC-2606 undeliverable', async () => {
    const e = P.sftkPiiPatternFormat(await hexOf('jane@real.com'), 'email', { type: 'email', length: 80 });
    expect(e).toMatch(/^[a-z0-9]{10}@masked\.invalid$/);
  });

  it('digits preserves the source digit count', async () => {
    expect(P.sftkPiiPatternFormat(await hexOf('12345'), 'digits', { type: 'string', length: 20 }, '12345'))
      .toMatch(/^\d{5}$/);
    expect(P.sftkPiiPatternFormat(await hexOf('12-345-67'), 'digits', { type: 'string', length: 20 }, '12-345-67'))
      .toMatch(/^\d{7}$/);
  });

  it('deterministic per salt — the contract joins and re-seeds depend on', async () => {
    const a = P.sftkPiiPatternFormat(await hexOf('same'), 'il-id', { type: 'string', length: 20 });
    const b = P.sftkPiiPatternFormat(await hexOf('same'), 'il-id', { type: 'string', length: 20 });
    const other = P.sftkPiiPatternFormat(await P.sftkPiiHashHex('same', 'other-salt'), 'il-id', { type: 'string', length: 20 });
    expect(a).toBe(b);
    expect(a).not.toBe(other);
  });

  it('distinct sources get distinct fakes (no collapse to one value)', async () => {
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      seen.add(P.sftkPiiPatternFormat(await hexOf(`u${i}`), 'il-id', { type: 'string', length: 20 }));
    }
    expect(seen.size).toBeGreaterThan(35);
  });

  it('a field too short for the shape returns null — never a truncated ת״ז', async () => {
    expect(P.sftkPiiPatternFormat(await hexOf('x'), 'il-id', { type: 'string', length: 5 })).toBeNull();
    expect(P.sftkPiiPatternFormat(await hexOf('x'), 'unknown-pattern', { type: 'string' })).toBeNull();
  });

  it('the catalog documents every pattern it can generate, with its caveat', async () => {
    const list = P.sftkPiiPatternList();
    const ids = list.map(p => p.id);
    for (const id of ['il-id', 'il-mobile', 'il-phone', 'email', 'us-ssn', 'credit-card', 'digits']) {
      expect(ids).toContain(id);
      expect(P.sftkPiiPatternFormat(await hexOf('probe'), id, { type: 'string', length: 60 }, '123456')).toBeTruthy();
    }
    // Honesty: patterns with no reserved test range say so; the ones with a
    // guarantee state it. No entry ships without a caveat.
    for (const p of list) {
      expect(p.caveat, p.id).toBeTruthy();
      expect(p.label, p.id).toBeTruthy();
    }
    expect(list.find(p => p.id === 'il-mobile').caveat).toMatch(/no test range|real line/i);
    expect(list.find(p => p.id === 'us-ssn').caveat).toMatch(/never issues/i);
    expect(list.find(p => p.id === 'email').caveat).toMatch(/undeliverable/i);
  });
});

describe('sftkPiiDetectPattern — values beat field names', () => {
  it('detects Israeli IDs, emails, US SSNs and cards from values alone', () => {
    const d = P.sftkPiiDetectPattern(['039128053', '000000018', '123456782', '039128053']);
    expect(d.pattern).toBe('il-id');
    expect(d.rate).toBe(1);
    expect(d.sampled).toBe(4);
    expect(P.sftkPiiDetectPattern(['a@b.com', 'c@d.co.il', 'e@f.org']).pattern).toBe('email');
    expect(P.sftkPiiDetectPattern(['123-45-6789', '987-65-4321', '111-22-3333']).pattern).toBe('us-ssn');
    expect(P.sftkPiiDetectPattern(['4539578763621486', '4485275742308327', '4716108999716531']).pattern).toBe('credit-card');
  });

  it('junk, mixed bags and thin samples detect NOTHING — no false positives', () => {
    expect(P.sftkPiiDetectPattern(['hello', 'world', 'nothing here'])).toBeNull();
    expect(P.sftkPiiDetectPattern(['039128053', 'hello', 'world', 'x'])).toBeNull();
    expect(P.sftkPiiDetectPattern(['039128053', '000000018'])).toBeNull();   // fewer than 3
    expect(P.sftkPiiDetectPattern([])).toBeNull();
    expect(P.sftkPiiDetectPattern(null)).toBeNull();
  });

  it('ignores blanks when judging the hit rate', () => {
    const d = P.sftkPiiDetectPattern(['039128053', '', null, '000000018', '123456782']);
    expect(d.pattern).toBe('il-id');
    expect(d.sampled).toBe(3);
  });
});

describe('sftkPiiMaskValue — strategy "pattern"', () => {
  it('masks a ת״ז to a DIFFERENT but still-valid ת״ז', async () => {
    const r = await P.sftkPiiMaskValue('039128053', { type: 'string', length: 20 }, SALT,
      { strategy: 'pattern', pattern: 'il-id' });
    expect(r.action).toBe('hashed');
    expect(P.sftkPiiIlIdValid(r.value)).toBe(true);
    expect(r.value).not.toBe('039128053');
  });

  it('a too-short field nulls and COUNTS instead of writing a broken shape', async () => {
    expect(await P.sftkPiiMaskValue('039128053', { type: 'string', length: 4 }, SALT,
      { strategy: 'pattern', pattern: 'il-id' })).toEqual({ value: null, action: 'nulled' });
  });

  it('empty sources still pass through as kept, and hash/null/fixed are untouched', async () => {
    expect(await P.sftkPiiMaskValue('', { type: 'string' }, SALT, { strategy: 'pattern', pattern: 'il-id' }))
      .toEqual({ value: '', action: 'kept' });
    expect((await P.sftkPiiMaskValue('x', { type: 'string', length: 80 }, SALT, { strategy: 'hash' })).action)
      .toBe('hashed');
    expect(await P.sftkPiiMaskValue('x', { type: 'date' }, SALT, { strategy: 'hash' }))
      .toEqual({ value: null, action: 'nulled' });
  });
});

describe('sftkPiiSuggest — pattern-aware suggestions', () => {
  const F = (name, extra) => ({ name, label: name, type: 'string', length: 255, ...(extra || {}) });

  it('a meaningless field name holding ת״ז numbers is flagged, with the pattern attached', () => {
    const out = P.sftkPiiSuggest('Custom_Object__c',
      [F('Custom_Field_12__c'), F('Harmless__c')],
      null,
      { Custom_Field_12__c: ['039128053', '000000018', '123456782'], Harmless__c: ['a', 'b', 'c'] });
    const hit = out.find(o => o.field === 'Custom_Field_12__c');
    expect(hit).toBeTruthy();
    expect(hit.sure).toBe(true);
    expect(hit.pattern).toBe('il-id');
    expect(hit.reason).toContain('values look like il-id');
    expect(out.find(o => o.field === 'Harmless__c')).toBeUndefined();
  });

  it('address components are suggested — sure on person-shaped objects, offered on Account', () => {
    const contact = P.sftkPiiSuggest('Contact', [F('MailingStreet'), F('MailingCity')], null, null);
    expect(contact.map(o => o.field).sort()).toEqual(['MailingCity', 'MailingStreet']);
    expect(contact.every(o => o.sure)).toBe(true);
    const acct = P.sftkPiiSuggest('Account', [F('BillingStreet')], null, null);
    expect(acct[0].reason).toContain('address component');
    expect(acct[0].sure).toBe(false);
  });

  it('name/label heuristics still fire without samples (backward compatible)', () => {
    const out = P.sftkPiiSuggest('Contact', [F('SSN__c'), F('Email', { type: 'email' })], null);
    expect(out.map(o => o.field).sort()).toEqual(['Email', 'SSN__c']);
  });
});

// ── Names mask to NAMES (user 2026-08-21: "i didn't understand how name
// hashing works, it looks weird") ───────────────────────────────────────
describe('name-shaped patterns keep a sandbox readable', () => {
  it('a person name masks to a different, real-looking name', async () => {
    const out = P.sftkPiiPatternFormat(await hexOf('Dana Levi'), 'person-name', { type: 'string', length: 121 });
    expect(out).toMatch(/^[A-Z][a-zA-Z]+ [A-Z][a-zA-Z]+$/);
    expect(out).not.toBe('Dana Levi');
    const L = P.sftkPiiNameLists();
    const [f, l] = out.split(' ');
    expect(L.first).toContain(f);
    expect(L.last).toContain(l);
  });

  it('first and last name parts mask to the RIGHT kind of name', async () => {
    const L = P.sftkPiiNameLists();
    const f = P.sftkPiiPatternFormat(await hexOf('Dana'), 'first-name', { type: 'string', length: 40 });
    const l = P.sftkPiiPatternFormat(await hexOf('Levi'), 'last-name', { type: 'string', length: 40 });
    expect(L.first).toContain(f);
    expect(L.last).toContain(l);
    // masking a first name into a surname reads as broken — never happens
    expect(L.last).not.toContain(f);
  });

  it('company names mask to invented companies with a suffix', async () => {
    const out = P.sftkPiiPatternFormat(await hexOf('Acme Corp'), 'company', { type: 'string', length: 255 });
    expect(out).toMatch(/^[A-Z][A-Za-z ]+ (Ltd|Inc|LLC|Group|Holdings|Systems|Solutions|Industries)$/);
  });

  it('deterministic and spread across the lists, never collapsing to one name', async () => {
    const a = P.sftkPiiPatternFormat(await hexOf('same person'), 'person-name', { type: 'string', length: 121 });
    const b = P.sftkPiiPatternFormat(await hexOf('same person'), 'person-name', { type: 'string', length: 121 });
    expect(a).toBe(b);
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      seen.add(P.sftkPiiPatternFormat(await hexOf(`person ${i}`), 'person-name', { type: 'string', length: 121 }));
    }
    expect(seen.size).toBeGreaterThan(30);
  });

  it('a short field cannot hold a name — nulled, never a half name', async () => {
    expect(P.sftkPiiPatternFormat(await hexOf('Dana Levi'), 'person-name', { type: 'string', length: 4 })).toBeNull();
  });

  it('suggest proposes the name pattern for the field it fits', () => {
    const F = (name, extra) => ({ name, label: name, type: 'string', length: 255, ...(extra || {}) });
    const c = P.sftkPiiSuggest('Contact', [F('FirstName'), F('LastName'), F('Name', { nameField: true })], null);
    const by = Object.fromEntries(c.map(o => [o.field, o.pattern]));
    expect(by.FirstName).toBe('first-name');
    expect(by.LastName).toBe('last-name');
    expect(by.Name).toBe('person-name');
  });

  it('the catalog carries the honest collision caveat for names', () => {
    const p = P.sftkPiiPatternList().find(x => x.id === 'person-name');
    expect(p).toBeTruthy();
    expect(p.caveat).toMatch(/identify nobody|repeat/i);
  });
});
