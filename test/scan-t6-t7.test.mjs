// T7 (phantom State/Country drift) + T6 (picklist readiness) pure functions.
// Both live at column 0 in studio-scan.js and reference no file-level consts,
// so extract.mjs can materialize and eval them standalone.
import { describe, it, expect } from 'vitest';
import { extractFunction } from './extract.mjs';

const sftkPhantomStateCountry = extractFunction('studio-scan.js', 'sftkPhantomStateCountry');
const sftkPicklistGaps        = extractFunction('studio-scan.js', 'sftkPicklistGaps');

// ─────────────────────────────────────────────────────────────────────────
// T7 — sftkPhantomStateCountry
// ─────────────────────────────────────────────────────────────────────────
describe('sftkPhantomStateCountry — equal codes = phantom', () => {
  it('flags the real bug: source "TX", target "Texas", same BillingStateCode', () => {
    const src = { BillingState: 'TX',    BillingStateCode: 'TX' };
    const tgt = { BillingState: 'Texas', BillingStateCode: 'TX' };
    expect(sftkPhantomStateCountry('BillingState', src, tgt)).toBe(true);
  });

  it('flags ShippingCountry the same way', () => {
    const src = { ShippingCountry: 'US',            ShippingCountryCode: 'US' };
    const tgt = { ShippingCountry: 'United States', ShippingCountryCode: 'US' };
    expect(sftkPhantomStateCountry('ShippingCountry', src, tgt)).toBe(true);
  });

  it('flags the bare "State" and "Country" field names', () => {
    expect(sftkPhantomStateCountry('State',
      { State: 'TX', StateCode: 'TX' }, { State: 'Texas', StateCode: 'TX' })).toBe(true);
    expect(sftkPhantomStateCountry('Country',
      { Country: 'US', CountryCode: 'US' }, { Country: 'United States', CountryCode: 'US' })).toBe(true);
  });

  it('flags identical labels too when the codes agree (harmless, still phantom)', () => {
    const src = { MailingState: 'Texas', MailingStateCode: 'TX' };
    const tgt = { MailingState: 'Texas', MailingStateCode: 'TX' };
    expect(sftkPhantomStateCountry('MailingState', src, tgt)).toBe(true);
  });

  it('coerces codes to strings before comparing', () => {
    const src = { OtherState: 'a', OtherStateCode: 5 };
    const tgt = { OtherState: 'b', OtherStateCode: '5' };
    expect(sftkPhantomStateCountry('OtherState', src, tgt)).toBe(true);
  });
});

describe('sftkPhantomStateCountry — differing codes are REAL drift', () => {
  it('does not flag when the codes differ', () => {
    const src = { BillingState: 'Texas',      BillingStateCode: 'TX' };
    const tgt = { BillingState: 'California', BillingStateCode: 'CA' };
    expect(sftkPhantomStateCountry('BillingState', src, tgt)).toBe(false);
  });

  it('does not flag on a case-only code difference (codes are canonical)', () => {
    const src = { BillingState: 'TX',    BillingStateCode: 'tx' };
    const tgt = { BillingState: 'Texas', BillingStateCode: 'TX' };
    expect(sftkPhantomStateCountry('BillingState', src, tgt)).toBe(false);
  });
});

describe('sftkPhantomStateCountry — missing code sibling never guesses', () => {
  it('returns false when neither record carries the code', () => {
    expect(sftkPhantomStateCountry('BillingState',
      { BillingState: 'TX' }, { BillingState: 'Texas' })).toBe(false);
  });

  it('returns false when only the SOURCE carries the code', () => {
    expect(sftkPhantomStateCountry('BillingState',
      { BillingState: 'TX', BillingStateCode: 'TX' }, { BillingState: 'Texas' })).toBe(false);
  });

  it('returns false when only the TARGET carries the code', () => {
    expect(sftkPhantomStateCountry('BillingState',
      { BillingState: 'TX' }, { BillingState: 'Texas', BillingStateCode: 'TX' })).toBe(false);
  });

  it('treats an empty-string or null code as absent', () => {
    expect(sftkPhantomStateCountry('BillingState',
      { BillingState: 'TX', BillingStateCode: '' },
      { BillingState: 'Texas', BillingStateCode: 'TX' })).toBe(false);
    expect(sftkPhantomStateCountry('BillingState',
      { BillingState: 'TX', BillingStateCode: 'TX' },
      { BillingState: 'Texas', BillingStateCode: null })).toBe(false);
    expect(sftkPhantomStateCountry('BillingState',
      { BillingState: 'TX', BillingStateCode: null },
      { BillingState: 'Texas', BillingStateCode: null })).toBe(false);
  });
});

describe('sftkPhantomStateCountry — non State/Country fields', () => {
  it.each([
    'Industry', 'Name', 'Type', 'BillingCity', 'BillingStreet', 'AnnualRevenue',
    'Country__c', 'State_Province__c', 'Statement', 'Countryside', 'Estates'
  ])('does not flag %s', (f) => {
    const src = {}; const tgt = {};
    src[f] = 'a'; src[f + 'Code'] = 'X';
    tgt[f] = 'b'; tgt[f + 'Code'] = 'X';
    expect(sftkPhantomStateCountry(f, src, tgt)).toBe(false);
  });

  it('does not flag the Code field itself', () => {
    const src = { BillingStateCode: 'TX', BillingStateCodeCode: 'TX' };
    const tgt = { BillingStateCode: 'CA', BillingStateCodeCode: 'TX' };
    expect(sftkPhantomStateCountry('BillingStateCode', src, tgt)).toBe(false);
  });
});

describe('sftkPhantomStateCountry — bad input and mapped target field', () => {
  it('returns false for missing field name or records', () => {
    expect(sftkPhantomStateCountry('', {}, {})).toBe(false);
    expect(sftkPhantomStateCountry('BillingState', null, {})).toBe(false);
    expect(sftkPhantomStateCountry('BillingState', {}, null)).toBe(false);
    expect(sftkPhantomStateCountry('BillingState', 'nope', {})).toBe(false);
    expect(sftkPhantomStateCountry(null, {}, {})).toBe(false);
  });

  it('reads the code from the MAPPED target field when one is given', () => {
    const src = { BillingState: 'TX',    BillingStateCode: 'TX' };
    const tgt = { ShippingState: 'Texas', ShippingStateCode: 'TX' };
    expect(sftkPhantomStateCountry('BillingState', src, tgt, 'ShippingState')).toBe(true);
    // Without the mapping the target code sibling isn't found → no guess.
    expect(sftkPhantomStateCountry('BillingState', src, tgt)).toBe(false);
  });

  it('still reports real drift across a mapped field', () => {
    const src = { BillingState: 'TX',         BillingStateCode: 'TX' };
    const tgt = { ShippingState: 'California', ShippingStateCode: 'CA' };
    expect(sftkPhantomStateCountry('BillingState', src, tgt, 'ShippingState')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T6 — sftkPicklistGaps
// ─────────────────────────────────────────────────────────────────────────
const pl = (...values) => ({ type: 'picklist', picklistValues: values.map(v => ({ value: v, active: true })) });
const mpl = (...values) => ({ type: 'multipicklist', picklistValues: values.map(v => ({ value: v, active: true })) });

describe('sftkPicklistGaps — basic gap detection', () => {
  it('reports values the target picklist does not have, with an affected count', () => {
    const recs = [
      { Id: '1', Industry: 'Biotechnology' },
      { Id: '2', Industry: 'Banking' },
      { Id: '3', Industry: 'Biotechnology' },
      { Id: '4', Industry: 'Agriculture' }
    ];
    const out = sftkPicklistGaps(recs, ['Industry'], { Industry: pl('Banking', 'Agriculture') });
    expect(out.gaps).toHaveLength(1);
    expect(out.gaps[0].field).toBe('Industry');
    expect(out.gaps[0].tgtField).toBe('Industry');
    expect(out.gaps[0].missing).toEqual(['Biotechnology']);
    expect(out.gaps[0].missingTotal).toBe(1);
    expect(out.gaps[0].affected).toBe(2);
    expect(out.gaps[0].multi).toBe(false);
  });

  it('returns no gaps when every value exists', () => {
    const out = sftkPicklistGaps(
      [{ Id: '1', Industry: 'Banking' }], ['Industry'], { Industry: pl('Banking', 'Retail') });
    expect(out.gaps).toEqual([]);
  });

  it('matches case-insensitively (Salesforce normalizes picklist writes)', () => {
    const out = sftkPicklistGaps(
      [{ Id: '1', Industry: 'banking' }], ['Industry'], { Industry: pl('Banking') });
    expect(out.gaps).toEqual([]);
  });

  it('trims surrounding whitespace on both sides', () => {
    const out = sftkPicklistGaps(
      [{ Id: '1', Industry: ' Banking ' }], ['Industry'],
      { Industry: { type: 'picklist', picklistValues: [{ value: 'Banking ', active: true }] } });
    expect(out.gaps).toEqual([]);
  });

  it('ignores null, undefined and empty values', () => {
    const recs = [{ Id: '1', Industry: null }, { Id: '2', Industry: '' }, { Id: '3' }, { Id: '4', Industry: '   ' }];
    const out = sftkPicklistGaps(recs, ['Industry'], { Industry: pl('Banking') });
    expect(out.gaps).toEqual([]);
  });

  it('dedupes repeated missing values but counts every affected record', () => {
    const recs = [
      { Id: '1', Industry: 'Nope' }, { Id: '2', Industry: 'Nope' }, { Id: '3', Industry: 'nope' }
    ];
    const out = sftkPicklistGaps(recs, ['Industry'], { Industry: pl('Banking') });
    expect(out.gaps[0].missing).toEqual(['Nope']);
    expect(out.gaps[0].affected).toBe(3);
  });

  it('counts records without an Id individually', () => {
    const recs = [{ Industry: 'Nope' }, { Industry: 'Nope' }];
    const out = sftkPicklistGaps(recs, ['Industry'], { Industry: pl('Banking') });
    expect(out.gaps[0].affected).toBe(2);
  });
});

describe('sftkPicklistGaps — multipicklist', () => {
  it("splits ';'-separated values and checks each part", () => {
    const recs = [{ Id: '1', Langs__c: 'English;Klingon' }, { Id: '2', Langs__c: 'English' }];
    const out = sftkPicklistGaps(recs, ['Langs__c'], { Langs__c: mpl('English', 'French') });
    expect(out.gaps).toHaveLength(1);
    expect(out.gaps[0].missing).toEqual(['Klingon']);
    expect(out.gaps[0].affected).toBe(1);
    expect(out.gaps[0].multi).toBe(true);
  });

  it('trims each part and skips empty segments', () => {
    const recs = [{ Id: '1', Langs__c: ' English ; ; French ' }];
    const out = sftkPicklistGaps(recs, ['Langs__c'], { Langs__c: mpl('English', 'French') });
    expect(out.gaps).toEqual([]);
  });

  it('does NOT split a single-select picklist on semicolons', () => {
    const recs = [{ Id: '1', Industry: 'A;B' }];
    const out = sftkPicklistGaps(recs, ['Industry'], { Industry: pl('A', 'B') });
    expect(out.gaps[0].missing).toEqual(['A;B']);
  });
});

describe('sftkPicklistGaps — never claims a gap it cannot prove', () => {
  it('skips fields absent from the target describe', () => {
    const out = sftkPicklistGaps([{ Id: '1', Ghost__c: 'X' }], ['Ghost__c'], { Industry: pl('A') });
    expect(out.gaps).toEqual([]);
    expect(out.fieldsTotal).toBe(0);
  });

  it('skips non-picklist target fields', () => {
    const out = sftkPicklistGaps(
      [{ Id: '1', Name: 'X' }], ['Name'], { Name: { type: 'string', picklistValues: [] } });
    expect(out.gaps).toEqual([]);
  });

  it('skips a picklist whose describe carries no values (dependent / unreadable)', () => {
    const out = sftkPicklistGaps(
      [{ Id: '1', Industry: 'X' }], ['Industry'], { Industry: { type: 'picklist', picklistValues: [] } });
    expect(out.gaps).toEqual([]);
    expect(out.fieldsTotal).toBe(0);
  });

  it('treats INACTIVE target values as not available', () => {
    const desc = { Industry: { type: 'picklist', picklistValues: [
      { value: 'Banking', active: true }, { value: 'Retired', active: false }] } };
    const out = sftkPicklistGaps([{ Id: '1', Industry: 'Retired' }], ['Industry'], desc);
    expect(out.gaps[0].missing).toEqual(['Retired']);
  });

  it('handles a null/absent describe map and a non-array plan or records', () => {
    expect(sftkPicklistGaps([{ Id: '1', Industry: 'X' }], ['Industry'], null).gaps).toEqual([]);
    expect(sftkPicklistGaps(null, ['Industry'], { Industry: pl('A') }).gaps).toEqual([]);
    expect(sftkPicklistGaps([{ Id: '1' }], null, { Industry: pl('A') }).gaps).toEqual([]);
    expect(sftkPicklistGaps([null, undefined, 'x'], ['Industry'], { Industry: pl('A') }).gaps).toEqual([]);
  });
});

describe('sftkPicklistGaps — plan shapes and describe map shapes', () => {
  it('accepts compare-plan entries with a renamed target field', () => {
    const plan = [{ srcField: 'Industry', tgtField: 'Sector__c' }];
    const out = sftkPicklistGaps([{ Id: '1', Industry: 'Nope' }], plan, { Sector__c: pl('Banking') });
    expect(out.gaps[0].field).toBe('Industry');
    expect(out.gaps[0].tgtField).toBe('Sector__c');
  });

  it('falls back to srcField when a plan entry has no tgtField', () => {
    const out = sftkPicklistGaps(
      [{ Id: '1', Industry: 'Nope' }], [{ srcField: 'Industry' }], { Industry: pl('Banking') });
    expect(out.gaps[0].tgtField).toBe('Industry');
  });

  it('ignores plan entries with no source field', () => {
    const out = sftkPicklistGaps([{ Id: '1' }], [null, {}, '', { tgtField: 'X' }], { X: pl('A') });
    expect(out.gaps).toEqual([]);
  });

  it('accepts a Map as the target describe field map', () => {
    const m = new Map([['Industry', pl('Banking')]]);
    const out = sftkPicklistGaps([{ Id: '1', Industry: 'Nope' }], ['Industry'], m);
    expect(out.gaps[0].missing).toEqual(['Nope']);
  });

  it('de-duplicates a field that appears twice in the plan', () => {
    const out = sftkPicklistGaps(
      [{ Id: '1', Industry: 'Nope' }], ['Industry', 'Industry'], { Industry: pl('Banking') });
    expect(out.gaps).toHaveLength(1);
    expect(out.fieldsTotal).toBe(1);
  });

  it('propagates the restrictedPicklist flag', () => {
    const strict = { Industry: { type: 'picklist', restrictedPicklist: true,
      picklistValues: [{ value: 'Banking', active: true }] } };
    const loose  = { Industry: pl('Banking') };
    expect(sftkPicklistGaps([{ Id: '1', Industry: 'X' }], ['Industry'], strict).gaps[0].restricted).toBe(true);
    expect(sftkPicklistGaps([{ Id: '1', Industry: 'X' }], ['Industry'], loose).gaps[0].restricted).toBe(false);
  });
});

describe('sftkPicklistGaps — caps are enforced AND reported', () => {
  it('caps the number of fields examined and says so', () => {
    const desc = {}; const rec = { Id: '1' }; const plan = [];
    for (let i = 0; i < 40; i++) { desc['F' + i] = pl('ok'); rec['F' + i] = 'bad'; plan.push('F' + i); }
    const out = sftkPicklistGaps([rec], plan, desc, { maxFields: 5 });
    expect(out.gaps).toHaveLength(5);
    expect(out.fieldsExamined).toBe(5);
    expect(out.fieldsTotal).toBe(40);
    expect(out.fieldsCapped).toBe(true);
  });

  it('reports fieldsCapped=false when nothing was cut', () => {
    const out = sftkPicklistGaps([{ Id: '1', Industry: 'X' }], ['Industry'], { Industry: pl('A') });
    expect(out.fieldsCapped).toBe(false);
    expect(out.recordsCapped).toBe(false);
  });

  it('caps the number of records scanned and says so', () => {
    const recs = [];
    for (let i = 0; i < 20; i++) recs.push({ Id: 'r' + i, Industry: 'Bad' + i });
    const out = sftkPicklistGaps(recs, ['Industry'], { Industry: pl('A') }, { maxRecords: 4 });
    expect(out.recordsExamined).toBe(4);
    expect(out.recordsTotal).toBe(20);
    expect(out.recordsCapped).toBe(true);
    expect(out.gaps[0].missingTotal).toBe(4);
  });

  it('caps how many missing values are listed but keeps the true total', () => {
    const recs = [];
    for (let i = 0; i < 30; i++) recs.push({ Id: 'r' + i, Industry: 'Bad' + i });
    const out = sftkPicklistGaps(recs, ['Industry'], { Industry: pl('A') }, { maxReport: 3 });
    expect(out.gaps[0].missing).toHaveLength(3);
    expect(out.gaps[0].missingTotal).toBe(30);
    expect(out.gaps[0].valuesTruncated).toBe(true);
    expect(out.reportCap).toBe(3);
  });

  it('caps distinct values examined per field and flags it', () => {
    const recs = [];
    for (let i = 0; i < 10; i++) recs.push({ Id: 'r' + i, Industry: 'Bad' + i });
    const out = sftkPicklistGaps(recs, ['Industry'], { Industry: pl('A') }, { maxDistinct: 3 });
    expect(out.gaps[0].missingTotal).toBe(3);
    expect(out.gaps[0].distinctCapped).toBe(3);
    expect(out.valueCap).toBe(3);
  });

  it('omits the truncation flags when no cap fired', () => {
    const out = sftkPicklistGaps([{ Id: '1', Industry: 'X' }], ['Industry'], { Industry: pl('A') });
    expect(out.gaps[0].valuesTruncated).toBeUndefined();
    expect(out.gaps[0].distinctCapped).toBeUndefined();
  });
});

describe('sftkPicklistGaps — only fields WITH gaps are returned', () => {
  it('drops clean fields from the result', () => {
    const recs = [{ Id: '1', Industry: 'Banking', Rating: 'Molten' }];
    const desc = { Industry: pl('Banking'), Rating: pl('Hot', 'Warm', 'Cold') };
    const out = sftkPicklistGaps(recs, ['Industry', 'Rating'], desc);
    expect(out.gaps.map(g => g.field)).toEqual(['Rating']);
    expect(out.fieldsTotal).toBe(2);
    expect(out.fieldsExamined).toBe(2);
  });
});
