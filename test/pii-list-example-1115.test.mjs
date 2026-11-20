// 2026-11-15 (owner): "we need to show an example for every field marked for pii" — the Masked fields window of an
// object shows, under each field, one real value of the source and what Deploy writes instead.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const SRC = readFileSync(new URL('../studio-builder.js', import.meta.url), 'utf8');
const { bldPiiExampleQuery, bldPiiExampleWhy } = extractFunctions('studio-builder.js', ['bldPiiExampleQuery', 'bldPiiExampleWhy', 'bldPiiPersonaCols']);   // the query's persona columns come from bldPiiPersonaCols (QA 1.1, finding 48)

describe('the example of a masked field', () => {
  it('reads the newest record that holds a value, with the fields a fabricated person is seeded from', () => {
    expect(bldPiiExampleQuery('Contact', 'Email', { type: 'email' }, ['Email', 'FirstName', 'LastName', 'Name', 'AccountId', 'Phone']))
      .toBe('SELECT Email, FirstName, LastName, Name, AccountId FROM Contact WHERE Email != null ORDER BY LastModifiedDate DESC LIMIT 3');
    // the field itself is not selected twice, and a field the object lacks is not asked for
    expect(bldPiiExampleQuery('Account', 'Name', { type: 'string' }, ['Name', 'Phone']))
      .toBe('SELECT Name FROM Account WHERE Name != null ORDER BY LastModifiedDate DESC LIMIT 3');
  });
  it('a field Salesforce cannot filter on (long text) is read without the filter', () => {
    expect(bldPiiExampleQuery('Case', 'Description', { type: 'textarea', filterable: false }, ['Description']))
      .toBe('SELECT Description FROM Case ORDER BY LastModifiedDate DESC LIMIT 50');
  });
  it('says why there is no example instead of leaving the row blank', () => {
    expect(bldPiiExampleWhy({ noSession: true })).toContain('not open in a Chrome tab');
    expect(bldPiiExampleWhy({ error: 'The session expired' })).toBe('no example — the source could not be read: The session expired');
    expect(bldPiiExampleWhy({})).toContain('no record of the source holds a value');
  });
  it('every row of the window carries an example cell, filled after the window opens', () => {
    const i = SRC.indexOf('function bldOpenPiiListModal('), body = SRC.slice(i, i + 3500);
    expect(body).toContain('data-pii-ex="${esc(r.key)}"');
    expect(body).toContain('bldPiiFillListExamples(p, objectApi, rules);');
  });
});
