// PII MASKING v1 — the pure masking library (sftk-pii.js) plus the parity
// contract behind its background.js worker copy. The batteries pin the three
// invariants every writer depends on: determinism (joins + re-seed
// idempotence), type honesty (hash on a non-maskable type → nulled and
// COUNTED, never skipped, never raw), and length safety (masked values
// always fit the field). Node 18+ ships globalThis.crypto — no polyfill.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunctions } from './extract.mjs';

// sftkPiiMaskValue → sftkPiiMaskable/HashHex/Format: one shared scope.
const NAMES = ['sftkPiiHashHex', 'sftkPiiMaskable', 'sftkPiiFormat',
               'sftkPiiMaskValue', 'sftkPiiSuggest',
               // format-preserving patterns — same byte-parity contract
               'sftkPiiPatternList', 'sftkPiiIlIdValid', 'sftkPiiLuhn',
               'sftkPiiDetectPattern', 'sftkPiiPatternFormat', 'sftkPiiNameLists'];
const pii = extractFunctions('sftk-pii.js', NAMES);

const SALT = 'a3f1c9d200aa11bb22cc33dd44ee55ff';

describe('sftkPiiHashHex — the deterministic core', () => {
  it('is SHA-256 over salt + "|" + value (independent node:crypto check)', async () => {
    const expected = createHash('sha256').update(`${SALT}|jane@real.com`).digest('hex');
    expect(await pii.sftkPiiHashHex('jane@real.com', SALT)).toBe(expected);
  });

  it('returns 64 lowercase hex chars', async () => {
    expect(await pii.sftkPiiHashHex('Jane Doe', SALT)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('same input → same output, always', async () => {
    expect(await pii.sftkPiiHashHex('555-0100', SALT))
      .toBe(await pii.sftkPiiHashHex('555-0100', SALT));
  });

  it('is salt-sensitive: a different machine-local salt changes everything', async () => {
    expect(await pii.sftkPiiHashHex('jane@real.com', SALT))
      .not.toBe(await pii.sftkPiiHashHex('jane@real.com', 'ffee00112233445566778899aabbccdd'));
  });

  it('is value-sensitive', async () => {
    expect(await pii.sftkPiiHashHex('jane@real.com', SALT))
      .not.toBe(await pii.sftkPiiHashHex('john@real.com', SALT));
  });
});

describe('sftkPiiMaskable — which types a hash can re-render', () => {
  it('accepts string, textarea, email, phone, url', () => {
    for (const type of ['string', 'textarea', 'email', 'phone', 'url']) {
      expect(pii.sftkPiiMaskable({ type })).toBe(true);
    }
  });

  it('accepts number types — a nulled Number trips target automations (2026-08-17)', () => {
    for (const type of ['int', 'double', 'currency', 'percent']) {
      expect(pii.sftkPiiMaskable({ type })).toBe(true);
    }
  });

  it('rejects every non-derivable type (those get nulled under a hash rule)', () => {
    for (const type of ['date', 'datetime',
                        'picklist', 'multipicklist', 'boolean', 'reference', 'id']) {
      expect(pii.sftkPiiMaskable({ type })).toBe(false);
    }
    expect(pii.sftkPiiMaskable(null)).toBe(false);
  });
});

describe('number masking — plausible digits, never empty, never zero', () => {
  const hexOf = v => pii.sftkPiiHashHex(v, SALT);

  it('a Number(9,0) SSN derives ≤9 digits, non-zero, no decimal point', async () => {
    const out = pii.sftkPiiFormat(await hexOf('304839624'), { type: 'double', precision: 9, scale: 0 });
    expect(out).toMatch(/^[0-9]{1,9}$/);
    expect(Number(out)).toBeGreaterThan(0);
  });

  it('deterministic, and distinct inputs derive distinct values', async () => {
    const d = { type: 'double', precision: 9, scale: 0 };
    expect(pii.sftkPiiFormat(await hexOf('304839624'), d))
      .toBe(pii.sftkPiiFormat(await hexOf('304839624'), d));
    expect(pii.sftkPiiFormat(await hexOf('304839624'), d))
      .not.toBe(pii.sftkPiiFormat(await hexOf('304839625'), d));
  });

  it('currency(16,2) fits its INTEGER portion; int fields use `digits`', async () => {
    const cur = pii.sftkPiiFormat(await hexOf('99123.45'), { type: 'currency', precision: 16, scale: 2 });
    expect(cur).toMatch(/^[0-9]{1,14}$/);
    const int8 = pii.sftkPiiFormat(await hexOf('304839624'), { type: 'int', digits: 8 });
    expect(int8).toMatch(/^[0-9]{1,8}$/);
    expect(Number(int8)).toBeGreaterThan(0);
  });

  it('maskValue hashes a Number field end to end', async () => {
    const r = await pii.sftkPiiMaskValue('304839624', { type: 'double', precision: 9, scale: 0 }, SALT, { strategy: 'hash' });
    expect(r.action).toBe('hashed');
    expect(String(r.value)).toMatch(/^[0-9]{1,9}$/);
  });

  it('a number with NO integer digits (percent(2,2)) is nulled, not rejected-row bait', async () => {
    const r = await pii.sftkPiiMaskValue('0.42', { type: 'percent', precision: 2, scale: 2 }, SALT, { strategy: 'hash' });
    expect(r).toEqual({ value: null, action: 'nulled' });
  });

  it('dates still null — a hash is never a valid date', async () => {
    const r = await pii.sftkPiiMaskValue('1988-04-12', { type: 'date' }, SALT, { strategy: 'hash' });
    expect(r).toEqual({ value: null, action: 'nulled' });
  });
});

describe('sftkPiiFormat — type-aware shapes from one hash hex', () => {
  let hex;
  const hexOf = async v => pii.sftkPiiHashHex(v, SALT);

  it('email → 10 base36 chars on the RFC-reserved masked.invalid domain', async () => {
    hex = await hexOf('jane@real.com');
    expect(pii.sftkPiiFormat(hex, { type: 'email', length: 80 }))
      .toMatch(/^[a-z0-9]{10}@masked\.invalid$/);
  });

  it('email fits a short field by shrinking the LOCAL part — domain intact', async () => {
    hex = await hexOf('jane@real.com');
    const out = pii.sftkPiiFormat(hex, { type: 'email', length: 20 });
    expect(out).toMatch(/^[a-z0-9]{5}@masked\.invalid$/);
    expect(out.length).toBe(20);
  });

  it('phone → 10 digits derived from the hex', async () => {
    hex = await hexOf('(415) 555-0100');
    expect(pii.sftkPiiFormat(hex, { type: 'phone', length: 40 })).toMatch(/^\d{10}$/);
  });

  it('url → https://masked.invalid/ + 8 chars', async () => {
    hex = await hexOf('https://janes-blog.example.com');
    expect(pii.sftkPiiFormat(hex, { type: 'url', length: 255 }))
      .toMatch(/^https:\/\/masked\.invalid\/[a-z0-9]{8}$/);
  });

  it('string → base36, default cap 255 when the describe has no length', async () => {
    hex = await hexOf('Jane Doe');
    const out = pii.sftkPiiFormat(hex, { type: 'string' });
    expect(out).toMatch(/^[a-z0-9]+$/);
    expect(out.length).toBeLessThanOrEqual(255);
  });

  it('string fits a length-5 field (truncation is a prefix, still deterministic)', async () => {
    hex = await hexOf('Jane Doe');
    const full = pii.sftkPiiFormat(hex, { type: 'string' });
    const tiny = pii.sftkPiiFormat(hex, { type: 'string', length: 5 });
    expect(tiny.length).toBe(5);
    expect(full.startsWith(tiny)).toBe(true);
  });

  it('textarea takes the string path', async () => {
    hex = await hexOf('Some notes about Jane');
    expect(pii.sftkPiiFormat(hex, { type: 'textarea', length: 32000 })).toMatch(/^[a-z0-9]+$/);
  });

  it('same hex + same describe → same output', async () => {
    hex = await hexOf('jane@real.com');
    expect(pii.sftkPiiFormat(hex, { type: 'email', length: 80 }))
      .toBe(pii.sftkPiiFormat(hex, { type: 'email', length: 80 }));
  });
});

describe('sftkPiiMaskValue — one rule applied to one value', () => {
  const email = { type: 'email', length: 80 };

  it('hash on a maskable field → { hashed } with the formatted digest', async () => {
    const res = await pii.sftkPiiMaskValue('jane@real.com', email, SALT, { strategy: 'hash' });
    expect(res.action).toBe('hashed');
    const hex = await pii.sftkPiiHashHex('jane@real.com', SALT);
    expect(res.value).toBe(pii.sftkPiiFormat(hex, email));
  });

  it('is deterministic across calls (re-seed idempotence)', async () => {
    const a = await pii.sftkPiiMaskValue('Jane Doe', { type: 'string', length: 255 }, SALT, { strategy: 'hash' });
    const b = await pii.sftkPiiMaskValue('Jane Doe', { type: 'string', length: 255 }, SALT, { strategy: 'hash' });
    expect(a).toEqual(b);
  });

  it('salt changes the masked value', async () => {
    const a = await pii.sftkPiiMaskValue('jane@real.com', email, SALT, { strategy: 'hash' });
    const b = await pii.sftkPiiMaskValue('jane@real.com', email, '00', { strategy: 'hash' });
    expect(a.value).not.toBe(b.value);
  });

  it('hash on a NON-maskable type → nulled and COUNTED as nulled, never raw', async () => {
    for (const type of ['date', 'picklist', 'reference', 'boolean']) {
      const res = await pii.sftkPiiMaskValue('1990-04-01', { type }, SALT, { strategy: 'hash' });
      expect(res).toEqual({ value: null, action: 'nulled' });
    }
  });

  it('null / undefined / empty-string sources pass through as kept', async () => {
    expect(await pii.sftkPiiMaskValue(null, email, SALT, { strategy: 'hash' }))
      .toEqual({ value: null, action: 'kept' });
    expect(await pii.sftkPiiMaskValue(undefined, email, SALT, { strategy: 'hash' }))
      .toEqual({ value: undefined, action: 'kept' });
    expect(await pii.sftkPiiMaskValue('', email, SALT, { strategy: 'null' }))
      .toEqual({ value: '', action: 'kept' });
  });

  it('strategy "null" → nulled', async () => {
    expect(await pii.sftkPiiMaskValue('jane@real.com', email, SALT, { strategy: 'null' }))
      .toEqual({ value: null, action: 'nulled' });
  });

  it('strategy "fixed" → the rule value; a fixed rule without a value nulls', async () => {
    expect(await pii.sftkPiiMaskValue('Jane', { type: 'string' }, SALT,
      { strategy: 'fixed', value: 'REDACTED' })).toEqual({ value: 'REDACTED', action: 'fixed' });
    expect(await pii.sftkPiiMaskValue('Jane', { type: 'string' }, SALT,
      { strategy: 'fixed' })).toEqual({ value: null, action: 'fixed' });
  });

  it('an unrecognized strategy NEVER writes the raw value — it nulls', async () => {
    const res = await pii.sftkPiiMaskValue('jane@real.com', email, SALT, { strategy: 'scramble' });
    expect(res).toEqual({ value: null, action: 'nulled' });
  });
});

describe('sftkPiiSuggest — masking candidates for one object', () => {
  const CAVEAT = 'free text — cannot be inspected, consider masking or null';

  it('flags email and phone typed fields as sure', () => {
    const out = pii.sftkPiiSuggest('Contact', [
      { name: 'Email', label: 'Email', type: 'email', length: 80 },
      { name: 'MobilePhone', label: 'Mobile', type: 'phone', length: 40 },
    ], {});
    expect(out).toEqual([
      { field: 'Email', reason: 'email field', sure: true },
      { field: 'MobilePhone', reason: 'phone field', sure: true },
    ]);
  });

  it('flags sensitive NAMES and LABELS (ssn, birth, licence-with-c…)', () => {
    const out = pii.sftkPiiSuggest('Contact', [
      { name: 'SSN__c', label: 'Gov Number', type: 'string', length: 20 },
      { name: 'DriversLicence__c', label: 'DL', type: 'string', length: 20 },
      { name: 'Custom1__c', label: 'Date of Birth', type: 'date' },
      { name: 'Status__c', label: 'Status', type: 'picklist' },
    ], {});
    expect(out.map(s => s.field)).toEqual(['SSN__c', 'DriversLicence__c', 'Custom1__c']);
    for (const s of out) {
      expect(s.reason).toBe('name/label suggests personal data');
      expect(s.sure).toBe(true);
    }
  });

  it('flags the record-name field ONLY on person-shaped objects', () => {
    // A record Name is a person's name on Contact/Lead/People-ish objects.
    // On a custom object it is a label like "LC-0400" — flagging it there
    // buried the real findings in noise (user 2026-08-21).
    const custom = pii.sftkPiiSuggest('Load_Child__c', [
      { name: 'Name', label: 'Name', type: 'string', length: 80, nameField: true },
    ], {});
    expect(custom).toEqual([]);
    const employee = pii.sftkPiiSuggest('Employee_Record__c', [
      { name: 'Name', label: 'Name', type: 'string', length: 80, nameField: true },
    ], {});
    expect(employee.map(o => o.field)).toEqual(['Name']);
    const out = pii.sftkPiiSuggest('Contact', [
      { name: 'Name', label: 'Full Name', type: 'string', length: 121, nameField: true },
    ], {});
    expect(out).toEqual([{ field: 'Name', reason: 'record name on a person-shaped object', sure: true, pattern: 'person-name' }]);
  });

  it('flags ComplianceGroup hits (semicolon-joined) and ignores non-matches', () => {
    const out = pii.sftkPiiSuggest('Contact', [
      { name: 'Loyalty__c', label: 'Loyalty ID', type: 'string', length: 30 },
      { name: 'Region__c', label: 'Region', type: 'string', length: 30 },
    ], { Loyalty__c: 'PII;GDPR', Region__c: 'Internal' });
    expect(out).toEqual([
      { field: 'Loyalty__c', reason: 'ComplianceGroup: PII;GDPR', sure: true },
    ]);
  });

  it('long textareas get the free-text caveat with sure:false', () => {
    const out = pii.sftkPiiSuggest('Case', [
      { name: 'Description', label: 'Description', type: 'textarea', length: 32000 },
      { name: 'Subject', label: 'Subject', type: 'string', length: 255 },
    ], {});
    expect(out).toEqual([{ field: 'Description', reason: CAVEAT, sure: false }]);
  });

  it('short textareas are NOT flagged as free text (length < 1000)', () => {
    expect(pii.sftkPiiSuggest('Case', [
      { name: 'Note__c', label: 'Note', type: 'textarea', length: 255 },
    ], {})).toEqual([]);
  });

  it('a long textarea with a sensitive name stacks reasons and stays sure', () => {
    const out = pii.sftkPiiSuggest('Contact', [
      { name: 'MedicalNotes__c', label: 'Notes', type: 'textarea', length: 5000 },
    ], {});
    expect(out).toEqual([{
      field: 'MedicalNotes__c',
      reason: 'name/label suggests personal data; ' + CAVEAT,
      sure: true,
    }]);
  });

  it('degrades to [] on empty/absent input', () => {
    expect(pii.sftkPiiSuggest('X', null, null)).toEqual([]);
    expect(pii.sftkPiiSuggest('X', [], {})).toEqual([]);
  });
});

describe('PARITY: background.js inline PII copies vs canonical sftk-pii.js', () => {
  // Same contract as the sftkOrgKey parity test, pinned harder: the worker
  // copy must match the canonical source BYTE-FOR-BYTE, so compare the
  // extracted function TEXT, not just behavior. Slicing mirrors
  // test/extract.mjs (column-0 functions close with a column-0 brace).
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const sliceSource = (file, name) => {
    const src = readFileSync(join(root, file), 'utf8');
    const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(src);
    if (!m) throw new Error(`top-level function ${name} not found in ${file}`);
    const end = src.indexOf('\n}', m.index);
    if (end === -1) throw new Error(`no column-0 closing brace after ${name} in ${file}`);
    return src.slice(m.index, end + 2);
  };

  it('every function is byte-for-byte identical in both files', () => {
    for (const name of NAMES) {
      expect(sliceSource('background.js', name)).toBe(sliceSource('sftk-pii.js', name));
    }
  });

  it('the worker copy is executable and agrees on a full mask round-trip', async () => {
    const bg = extractFunctions('background.js', NAMES);
    const desc = { type: 'email', length: 80 };
    expect(await bg.sftkPiiMaskValue('jane@real.com', desc, SALT, { strategy: 'hash' }))
      .toEqual(await pii.sftkPiiMaskValue('jane@real.com', desc, SALT, { strategy: 'hash' }));
  });
});

// ══════════════════════════════════════════════════════════════════
// Adversarial-review fixes (2026-08-04)
// ══════════════════════════════════════════════════════════════════
describe('fields too short for their masked format are nulled, never truncated', () => {
  // 'x@masked.inv' after a hard cap is a syntactically valid address on a
  // routable-looking domain — the undeliverability guarantee outranks
  // keeping a value.
  it('email shorter than 16 chars → nulled', async () => {
    const r = await pii.sftkPiiMaskValue('a@b.com', { type: 'email', length: 12 }, 'S', { strategy: 'hash' });
    expect(r).toEqual({ value: null, action: 'nulled' });
  });
  it('url shorter than 24 chars → nulled', async () => {
    const r = await pii.sftkPiiMaskValue('https://x.io', { type: 'url', length: 20 }, 'S', { strategy: 'hash' });
    expect(r).toEqual({ value: null, action: 'nulled' });
  });
  it('normal-length email and url still hash', async () => {
    const e = await pii.sftkPiiMaskValue('a@b.com', { type: 'email', length: 80 }, 'S', { strategy: 'hash' });
    expect(e.action).toBe('hashed');
    expect(e.value).toMatch(/^[a-z0-9]+@masked\.invalid$/);
    const u = await pii.sftkPiiMaskValue('https://x.io', { type: 'url', length: 255 }, 'S', { strategy: 'hash' });
    expect(u.action).toBe('hashed');
    expect(u.value.startsWith('https://masked.invalid/')).toBe(true);
  });
});

describe('suggest proposes person-name PARTS, not just the unwritable compound', () => {
  it('FirstName/LastName are suggested in their own right', () => {
    const out = pii.sftkPiiSuggest('Contact', [
      { name: 'FirstName', label: 'First Name', type: 'string', length: 40 },
      { name: 'LastName',  label: 'Last Name',  type: 'string', length: 80 },
      { name: 'Nick_Name__c', label: 'Nick Name', type: 'string', length: 40 },
      { name: 'AccountId', label: 'Account', type: 'reference' },
    ], {});
    const names = out.map(o => o.field);
    expect(names).toContain('FirstName');
    expect(names).toContain('LastName');
    expect(names).toContain('Nick_Name__c');
    expect(names).not.toContain('AccountId');
    expect(out.find(o => o.field === 'FirstName').sure).toBe(true);
    expect(out.find(o => o.field === 'FirstName').reason).toContain('person name part');
  });
});
