// QA 1.1 finding 48 — the PII example of a Lead (and of a record with no name) showed another e-mail domain than the run writes.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const BL = read('studio-builder.js'), BG = read('background.js');
const slice = (src, name) => {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(src);
  if (!m) throw new Error('not found: ' + name);
  return src.slice(m.index, src.indexOf('\n}', m.index) + 2);
};
// the masking library, the RUN's own row masker (background.js) and the Builder's example — in one scope
const api = new Function(`${read('sftk-pii.js')}
${slice(BG, 'sftkPiiMaskRows')}
${slice(BL, 'bldPiiPersonaCols')}
${slice(BL, 'bldPiiExampleQuery')}
${slice(BL, 'bldPiiPreviewPairs')}
return { sftkPiiMaskRows, bldPiiPersonaCols, bldPiiExampleQuery, bldPiiPreviewPairs };`)();
const { bldPiiPersonaCols: cols } = extractFunctions('studio-builder.js', ['bldPiiPersonaCols']);

const SALT = 'a-salt-for-the-test';
const RULE = { strategy: 'pattern', pattern: 'email-person' };
const EMAIL = { name: 'Email', type: 'email', length: 80 };
// what the example's own query brings back of a record: only the columns it selects
const asRead = (rec, soql) => {
  const names = /^SELECT (.+?) FROM /.exec(soql)[1].split(', ');
  return Object.fromEntries(names.filter(n => n in rec).map(n => [n, rec[n]]));
};
const runWrites = async (rec, field, desc) => (await api.sftkPiiMaskRows([rec], 'X', { [field]: { rule: RULE, desc } }, SALT, new Map())).rows[0][field].value;
const exampleSays = async (rec, field, desc, fieldNames) => {
  const seen = asRead(rec, api.bldPiiExampleQuery('X', field, desc, fieldNames));
  return (await api.bldPiiPreviewPairs({ piiSalt: SALT }, 'X', field, desc, RULE, [seen], 1))[0].to;
};

describe('the columns an example reads beside the field', () => {
  it('are the ones the persona and its domain are hashed from — Company among them, never the field itself', () => {
    expect(cols(() => true, 'Email')).toEqual(['FirstName', 'LastName', 'Name', 'AccountId', 'Company']);
    expect(cols(() => true, 'Company')).toEqual(['FirstName', 'LastName', 'Name', 'AccountId']);
    expect(cols(n => n === 'Name' || n === 'AccountId', 'Phone')).toEqual(['Name', 'AccountId']);
  });
  it('a Lead’s example asks for its Company; a Contact’s query is what it was', () => {
    expect(api.bldPiiExampleQuery('Lead', 'Email', EMAIL, ['Email', 'FirstName', 'LastName', 'Name', 'Company']))
      .toBe('SELECT Email, FirstName, LastName, Name, Company FROM Lead WHERE Email != null ORDER BY LastModifiedDate DESC LIMIT 3');
    expect(api.bldPiiExampleQuery('Contact', 'Email', EMAIL, ['Email', 'FirstName', 'LastName', 'Name', 'AccountId', 'Phone']))
      .toBe('SELECT Email, FirstName, LastName, Name, AccountId FROM Contact WHERE Email != null ORDER BY LastModifiedDate DESC LIMIT 3');
  });
  it('the chooser and the Suggest sampler read the same columns', () => {
    expect(BL).toContain('const extra = bldPiiPersonaCols(n => !!(d && Array.isArray(d.fields) && d.fields.some(f => f.name === n)), field);');
    expect(BL).toContain("const personaFields = ['Id', ...bldPiiPersonaCols(() => true, '')].filter(");
    expect(BL).not.toContain("['FirstName', 'LastName', 'Name', 'AccountId'].filter(");
  });
});

describe('the example is the value the run writes', () => {
  const LEAD_FIELDS = ['Email', 'FirstName', 'LastName', 'Name', 'Company', 'Phone'];
  it('a Lead: the domain follows its Company, as in the run', async () => {
    for (const Company of ['Acme', 'Northwind Traders', 'Zenith Ltd', 'Globex', 'Initech', 'Umbrella']) {
      const lead = { Id: '00Q1', FirstName: 'Dana', LastName: 'Levi', Name: 'Dana Levi', Company, Email: 'dana@real.example', Phone: '050' };
      const run = await runWrites(lead, 'Email', EMAIL);
      expect(run).toMatch(/@/);
      expect(await exampleSays(lead, 'Email', EMAIL, LEAD_FIELDS), Company).toBe(run);
    }
  });
  it('a Contact: the domain follows its Account', async () => {
    const c = { FirstName: 'Omer', LastName: 'Paz', Name: 'Omer Paz', AccountId: '001A0000001', Email: 'omer@real.example' };
    expect(await exampleSays(c, 'Email', EMAIL, ['Email', 'FirstName', 'LastName', 'Name', 'AccountId'])).toBe(await runWrites(c, 'Email', EMAIL));
  });
  it('a record with no name and no Account: the same fallback domain as the run, whatever the value', async () => {
    const desc = { name: 'SuppliedEmail', type: 'email', length: 80 };
    for (const v of ['a@real.example', 'someone.else@other.example', 'third@x.example', 'fourth@y.example', 'fifth@z.example']) {
      const rec = { Id: '5001', SuppliedEmail: v };
      expect(await exampleSays(rec, 'SuppliedEmail', desc, ['SuppliedEmail', 'Subject']), v).toBe(await runWrites(rec, 'SuppliedEmail', desc));
    }
  });
});
