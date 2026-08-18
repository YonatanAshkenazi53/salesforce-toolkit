// Unit tests for the T11b / B2 / B3 pure helpers in background.js.
//
// T11b — sftkFieldsFromError + sftkTruncValue: turn a Salesforce save error
//        into the API names of the fields it blames, so History can show the
//        VALUE that was pushed instead of just the message.
// B2   — sftkBulkRowsToRecords: reshape Bulk-query CSV rows (all strings,
//        '' for blanks, dotted parent columns) into REST-shaped records.
// B3   — sftkCorrelateBulkResults' cancelled-job override: rows an aborted
//        job never reached must not read as rejections.
import { describe, it, expect } from 'vitest';
import { extractFunction } from './extract.mjs';

describe('sftkFieldsFromError (background.js) — which field did Salesforce blame?', () => {
  const sftkFieldsFromError = extractFunction('background.js', 'sftkFieldsFromError');

  // Mirrors what the engine builds from the TARGET describe: API name → API
  // name AND label → API name.
  const MAP = {
    BillingState: 'BillingState',
    'Billing State/Province': 'BillingState',
    BillingCountry: 'BillingCountry',
    'Billing Country': 'BillingCountry',
    Rating: 'Rating',
    LastName: 'LastName',
    'Last Name': 'LastName',
    Email: 'Email',
    'Email Address': 'Email',
  };

  it('resolves a trailing LABEL segment (the real State/Country failure)', () => {
    const msg = "There's a problem with this state, even though it may appear correct. "
              + 'Please select a state from the list of valid states.: Billing State/Province';
    expect(sftkFieldsFromError(msg, MAP)).toEqual(['BillingState']);
  });

  it('splits several labels in the trailing segment', () => {
    const msg = 'bad address: Billing State/Province, Billing Country';
    expect(sftkFieldsFromError(msg, MAP)).toEqual(['BillingState', 'BillingCountry']);
  });

  it('reads bracketed API names — "Required fields are missing: [LastName, Email]"', () => {
    expect(sftkFieldsFromError('Required fields are missing: [LastName, Email]', MAP))
      .toEqual(['LastName', 'Email']);
  });

  it('bracketed names work even with NO describe (API-name shape is trusted there)', () => {
    expect(sftkFieldsFromError('Required fields are missing: [Custom_Thing__c]', {}))
      .toEqual(['Custom_Thing__c']);
  });

  it("reads No such column 'X'", () => {
    expect(sftkFieldsFromError("No such column 'Legacy_Id__c' on entity 'Account'", {}))
      .toEqual(['Legacy_Id__c']);
  });

  it('reads a leading "Field: message" prefix', () => {
    expect(sftkFieldsFromError('Email: invalid email address: b.levy@x.net', MAP))
      .toEqual(['Email']);
  });

  it('restricted-picklist errors name the field in the trailing segment', () => {
    expect(sftkFieldsFromError('bad value for restricted picklist field: Warmish: Rating', MAP))
      .toEqual(['Rating']);
  });

  it('does NOT invent fields out of ordinary prose it cannot resolve', () => {
    // Prose positions require a describe hit — otherwise every English word
    // after the last colon would be reported as a field.
    expect(sftkFieldsFromError('Something went wrong: please try again later', MAP)).toEqual([]);
    expect(sftkFieldsFromError('UNABLE_TO_LOCK_ROW: unable to obtain exclusive access', MAP)).toEqual([]);
  });

  it('is case-insensitive on labels and API names, and dedupes', () => {
    expect(sftkFieldsFromError('bad: billing state/province', MAP)).toEqual(['BillingState']);
    expect(sftkFieldsFromError('Required fields are missing: [LastName, lastname]', MAP))
      .toEqual(['LastName']);
  });

  it('accepts a Map as well as a plain object', () => {
    const m = new Map([['Billing State/Province', 'BillingState']]);
    expect(sftkFieldsFromError('nope: Billing State/Province', m)).toEqual(['BillingState']);
  });

  it('caps the result (default 5, overridable) and handles empty input', () => {
    const msg = 'Required fields are missing: [A__c, B__c, C__c, D__c, E__c, F__c, G__c]';
    expect(sftkFieldsFromError(msg, {}).length).toBe(5);
    expect(sftkFieldsFromError(msg, {}, 2)).toEqual(['A__c', 'B__c']);
    expect(sftkFieldsFromError('', MAP)).toEqual([]);
    expect(sftkFieldsFromError(null, MAP)).toEqual([]);
    expect(sftkFieldsFromError('anything', null)).toEqual([]);
  });
});

describe('sftkTruncValue (background.js) — the pushed value, honestly shortened', () => {
  const sftkTruncValue = extractFunction('background.js', 'sftkTruncValue');

  it('passes short values through', () => {
    expect(sftkTruncValue('TX', 120)).toBe('TX');
    expect(sftkTruncValue(42, 120)).toBe('42');
    expect(sftkTruncValue(false, 120)).toBe('false');
  });

  it('collapses whitespace so a textarea cannot blow up a History row', () => {
    expect(sftkTruncValue('line1\n  line2\tend', 120)).toBe('line1 line2 end');
  });

  it('states how much was cut instead of trailing off silently', () => {
    const out = sftkTruncValue('x'.repeat(200), 120);
    expect(out.startsWith('x'.repeat(120))).toBe(true);
    expect(out).toContain('(+80 chars)');
  });

  it('distinguishes null, undefined and an empty string', () => {
    expect(sftkTruncValue(null, 120)).toBe('null');
    expect(sftkTruncValue(undefined, 120)).toBe(null);
    expect(sftkTruncValue('   ', 120)).toBe('(empty string)');
  });
});

describe('sftkBulkRowsToRecords (background.js) — Bulk-query CSV → REST-shaped records', () => {
  const sftkBulkRowsToRecords = extractFunction('background.js', 'sftkBulkRowsToRecords');
  const TYPES = { Name: 'string', IsActive__c: 'boolean', Amount__c: 'currency', Count__c: 'int' };

  it("turns '' into null — the payload builder skips null, but would SEND ''", () => {
    const [rec] = sftkBulkRowsToRecords([{ Name: 'Acme', Phone: '' }], TYPES);
    expect(rec.Name).toBe('Acme');
    expect(rec.Phone).toBe(null);
  });

  it('nests dotted parent columns so Owner.Name keeps working', () => {
    const [rec] = sftkBulkRowsToRecords([{ Id: '001', 'Owner.Name': 'Ada L' }], TYPES);
    expect(rec.Owner.Name).toBe('Ada L');
    expect(rec['Owner.Name']).toBe(undefined);
  });

  it('coerces booleans and numbers using the describe types', () => {
    const [rec] = sftkBulkRowsToRecords(
      [{ IsActive__c: 'true', Amount__c: '12.50', Count__c: '7' }], TYPES);
    expect(rec.IsActive__c).toBe(true);
    expect(rec.Amount__c).toBe(12.5);
    expect(rec.Count__c).toBe(7);
  });

  it('leaves unknown fields as strings rather than guessing', () => {
    const [rec] = sftkBulkRowsToRecords([{ Mystery__c: '007' }], TYPES);
    expect(rec.Mystery__c).toBe('007');
  });

  it('works with no type map at all, and on empty input', () => {
    const [rec] = sftkBulkRowsToRecords([{ A: '1', B: '' }]);
    expect(rec).toEqual({ A: '1', B: null });
    expect(sftkBulkRowsToRecords([], TYPES)).toEqual([]);
    expect(sftkBulkRowsToRecords(null, TYPES)).toEqual([]);
  });
});

describe('sftkCorrelateBulkResults (background.js) — cancelled rows are not rejections', () => {
  const sftkCorrelateBulkResults = extractFunction('background.js', 'sftkCorrelateBulkResults');

  it('default missing-result text is unchanged', () => {
    const res = sftkCorrelateBulkResults([{ Name: 'Z' }], ['Name'], [], []);
    expect(res[0].errors[0].statusCode).toBe('BULK_NO_RESULT');
  });

  it('an aborted job flags unreached rows BULK_CANCELLED, keeping written rows successful', () => {
    const upload = [{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }];
    const res = sftkCorrelateBulkResults(upload, ['Name'],
      [{ sf__Id: '001', Name: 'A' }], [],
      'Not processed — the run was cancelled', 'BULK_CANCELLED');
    expect(res[0]).toMatchObject({ id: '001', success: true });
    expect(res[1].errors[0].statusCode).toBe('BULK_CANCELLED');
    expect(res[2].errors[0].message).toBe('Not processed — the run was cancelled');
  });
});

// ── Upsert arms (load test 2026-08-18: an 1,850-row pure-update upsert
// read "1850 inserted") — sf__Created is Salesforce's own per-row verdict
// and must survive correlation so summaries can split created/updated.
describe('sftkCorrelateBulkResults carries the sf__Created verdict', () => {
  const sftkCorrelateBulkResults = extractFunction('background.js', 'sftkCorrelateBulkResults');
  const cols = ['Ext_Id__c', 'Name'];
  const up = [{ Ext_Id__c: 'A', Name: 'a' }, { Ext_Id__c: 'B', Name: 'b' }, { Ext_Id__c: 'C', Name: 'c' }];

  it('true → created:true, false → created:false, absent → no created key', () => {
    const out = sftkCorrelateBulkResults(up, cols,
      [{ Ext_Id__c: 'A', Name: 'a', 'sf__Id': '1', 'sf__Created': 'true' },
       { Ext_Id__c: 'B', Name: 'b', 'sf__Id': '2', 'sf__Created': 'false' },
       { Ext_Id__c: 'C', Name: 'c', 'sf__Id': '3' }], []);
    expect(out[0].created).toBe(true);
    expect(out[1].created).toBe(false);
    expect('created' in out[2]).toBe(false);
  });

  it('the engine counts the arms and the summary carries the split', async () => {
    const { readFileSync } = await import('node:fs');
    const BG = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
    expect(BG).toContain('if (result.created === true) upsCreated++;');
    expect(BG).toContain('else if (result.created === false) upsUpdated++;');
    expect(BG).toMatch(/useUpsert && \(upsCreated \|\| upsUpdated\)\s*\n?\s*\? \{ upsertCreated: upsCreated, upsertUpdated: upsUpdated \}/);
    // reconcile splits the same way, and History renders both arms
    const REC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
    expect(REC).toContain('counts.updated  += (s.upsertUpdated || 0);');
    const HIST = readFileSync(new URL('../studio-history.js', import.meta.url), 'utf8');
    expect(HIST).toContain('upsert: ${s.upsertCreated || 0} created · ${s.upsertUpdated || 0} updated');
  });
});
