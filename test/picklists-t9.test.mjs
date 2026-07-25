// T9 (whole-object sweep) + T8 (actionable automation hits) pure functions.
//
// pkFieldVerdict is the ONLY thing standing between "sweep 25 fields × 4 orgs"
// and a wrong green tick, so it gets the coverage: value drift, label drift,
// active-flag drift, default drift, missing fields, shared value sets, record-
// type drift, and the honesty cases (org unreadable, RTs unreadable).
import { describe, it, expect } from 'vitest';
import { extractFunction, extractFunctions } from './extract.mjs';

// pkFieldVerdict calls pkRtDrift — materialize both in ONE scope.
const { pkFieldVerdict } = extractFunctions('studio-picklists.js', ['pkRtDrift', 'pkFieldVerdict']);
const pkAutomationUrl = extractFunction('studio-picklists.js', 'pkAutomationUrl');

// ── helpers ─────────────────────────────────────────────────────
const V = (name, opts = {}) => ({
  name,
  label: opts.label === undefined ? name : opts.label,
  active: opts.active === undefined ? true : opts.active,
  isDefault: !!opts.isDefault,
});
const localOrg = (orgKey, values) => ({ orgKey, label: orgKey, kind: 'local', values });
const rt = (devName, values) => ({ id: 'rt-' + devName, name: devName, devName, values: new Set(values) });

describe('pkFieldVerdict — one verdict per field across orgs (T9)', () => {
  it('identical value sets in every org = in sync', () => {
    const v = pkFieldVerdict([
      localOrg('a', [V('Hot'), V('Cold')]),
      localOrg('b', [V('Hot'), V('Cold')]),
    ], [null, null], 'Rating__c');
    expect(v.status).toBe('sync');
    expect(v.drifting).toBe(false);
    expect(v.label).toBe('✓ in sync');
    expect(v.diffCount).toBe(0);
    expect(v.valueCount).toBe(2);
  });

  it('value order does NOT count as drift', () => {
    const v = pkFieldVerdict([
      localOrg('a', [V('Hot'), V('Cold')]),
      localOrg('b', [V('Cold'), V('Hot')]),
    ], [null, null], 'Rating__c');
    expect(v.status).toBe('sync');
  });

  it('a value present in only one org counts as drift', () => {
    const v = pkFieldVerdict([
      localOrg('a', [V('Hot'), V('Cold'), V('Lukewarm')]),
      localOrg('b', [V('Hot'), V('Cold')]),
    ], [null, null], 'Rating__c');
    expect(v.status).toBe('values');
    expect(v.diffCount).toBe(1);
    expect(v.differing).toEqual(['Lukewarm']);
    expect(v.label).toBe('values differ (1)');
    expect(v.drifting).toBe(true);
  });

  it('same value name but a different LABEL is drift', () => {
    const v = pkFieldVerdict([
      localOrg('a', [V('Hot', { label: 'Hot' })]),
      localOrg('b', [V('Hot', { label: 'Scorching' })]),
    ], [null, null], 'Rating__c');
    expect(v.status).toBe('values');
    expect(v.differing).toEqual(['Hot']);
  });

  it('a missing label falls back to the API name, so it is NOT phantom drift', () => {
    const v = pkFieldVerdict([
      localOrg('a', [{ name: 'Hot', active: true }]),
      localOrg('b', [{ name: 'Hot', label: 'Hot', active: true }]),
    ], [null, null], 'Rating__c');
    expect(v.status).toBe('sync');
  });

  it('active in one org, inactive in another is drift', () => {
    const v = pkFieldVerdict([
      localOrg('a', [V('Hot', { active: true })]),
      localOrg('b', [V('Hot', { active: false })]),
    ], [null, null], 'Rating__c');
    expect(v.status).toBe('values');
    expect(v.differing).toEqual(['Hot']);
  });

  it('a different DEFAULT value drifts even when the value list matches', () => {
    const v = pkFieldVerdict([
      localOrg('a', [V('Hot', { isDefault: true }), V('Cold')]),
      localOrg('b', [V('Hot'), V('Cold', { isDefault: true })]),
    ], [null, null], 'Rating__c');
    expect(v.status).toBe('values');
    expect(v.diffCount).toBe(0);
    expect(v.defaultDiffers).toBe(true);
    expect(v.label).toBe('default value differs');
  });

  it('field missing in one org outranks value drift in the headline', () => {
    const v = pkFieldVerdict([
      localOrg('a', [V('Hot'), V('Extra')]),
      localOrg('b', [V('Hot')]),
      { orgKey: 'c', label: 'c', kind: 'missing' },
    ], [null, null, null], 'Rating__c');
    expect(v.status).toBe('missing');
    expect(v.missingIn).toEqual(['c']);
    expect(v.label).toContain('field missing in 1 org(s)');
    expect(v.label).toContain('values differ (1)');   // still reported, not hidden
    expect(v.drifting).toBe(true);
  });

  it('field missing everywhere = missing, with no bogus value verdict', () => {
    const v = pkFieldVerdict([
      { orgKey: 'a', kind: 'missing' },
      { orgKey: 'b', kind: 'missing' },
    ], [null, null], 'Gone__c');
    expect(v.status).toBe('missing');
    expect(v.comparable).toBe(0);
    expect(v.diffCount).toBe(0);
  });

  it('every org unreadable = error, never a green tick', () => {
    const v = pkFieldVerdict([
      { orgKey: 'a', kind: 'error', error: 'no Tooling access' },
      { orgKey: 'b', kind: 'error', error: 'no Tooling access' },
    ], [null, null], 'Rating__c');
    expect(v.status).toBe('error');
    expect(v.label).toBe('could not read');
    expect(v.erroredIn).toEqual(['a', 'b']);
    expect(v.drifting).toBe(false);
  });

  it('an unreadable org is EXCLUDED from the verdict and said so in the detail', () => {
    const v = pkFieldVerdict([
      localOrg('a', [V('Hot')]),
      localOrg('b', [V('Hot')]),
      { orgKey: 'c', kind: 'error', error: 'boom' },
    ], [null, null, null], 'Rating__c');
    expect(v.status).toBe('sync');
    expect(v.erroredIn).toEqual(['c']);
    expect(v.detail).toContain('Could NOT be read in: c');
  });

  it('a single readable org is "insufficient", not "in sync"', () => {
    const v = pkFieldVerdict([
      localOrg('a', [V('Hot')]),
      { orgKey: 'b', kind: 'error' },
    ], [null, null], 'Rating__c');
    expect(v.status).toBe('insufficient');
    expect(v.drifting).toBe(false);
  });
});

describe('pkFieldVerdict — shared (global / standard) value sets', () => {
  it('a global value set is NOT comparable and names the set', () => {
    const v = pkFieldVerdict([
      { orgKey: 'a', kind: 'global', valueSetName: 'Industry_GVS' },
      { orgKey: 'b', kind: 'global', valueSetName: 'Industry_GVS' },
    ], [null, null], 'Industry__c');
    expect(v.status).toBe('notcomparable');
    expect(v.drifting).toBe(false);
    expect(v.label).toBe('not comparable — global value set (Industry_GVS)');
    expect(v.shared.kind).toBe('global');
    expect(v.shared.names).toEqual(['Industry_GVS']);
    expect(v.shared.mixed).toBe(false);
  });

  it('two fields on the same global value set produce the SAME dedupe key', () => {
    const mk = field => pkFieldVerdict([
      { orgKey: 'a', kind: 'global', valueSetName: 'Industry_GVS' },
      { orgKey: 'b', kind: 'global', valueSetName: 'Industry_GVS' },
    ], [null, null], field);
    expect(mk('Industry__c').shared.key).toBe(mk('Sector__c').shared.key);
  });

  it('a standard picklist says Salesforce owns the values', () => {
    const v = pkFieldVerdict([
      { orgKey: 'a', kind: 'standard', valueSetName: 'LeadSource' },
      { orgKey: 'b', kind: 'standard', valueSetName: 'LeadSource' },
    ], [null, null], 'LeadSource');
    expect(v.status).toBe('notcomparable');
    expect(v.shared.kind).toBe('standard');
    expect(v.detail).toContain('standard picklist');
  });

  it('global in one org but LOCAL in another is flagged as mixed, not silently equal', () => {
    const v = pkFieldVerdict([
      { orgKey: 'a', kind: 'global', valueSetName: 'Industry_GVS' },
      localOrg('b', [V('Hot')]),
    ], [null, null], 'Industry__c');
    expect(v.status).toBe('notcomparable');
    expect(v.shared.mixed).toBe(true);
    expect(v.detail).toContain('NOT identical across the loaded orgs');
  });

  it('different global value set NAMES per org are flagged as mixed', () => {
    const v = pkFieldVerdict([
      { orgKey: 'a', kind: 'global', valueSetName: 'Industry_GVS' },
      { orgKey: 'b', kind: 'global', valueSetName: 'Industry_V2' },
    ], [null, null], 'Industry__c');
    expect(v.shared.mixed).toBe(true);
    expect(v.shared.names).toEqual(['Industry_GVS', 'Industry_V2']);
  });
});

describe('pkFieldVerdict — record types folded in via pkRtDrift', () => {
  it('same-name record types disagreeing on a value = RT assignment differs', () => {
    const v = pkFieldVerdict([
      localOrg('a', [V('Hot'), V('Cold')]),
      localOrg('b', [V('Hot'), V('Cold')]),
    ], [
      [rt('Partner', ['Hot', 'Cold'])],
      [rt('Partner', ['Hot'])],
    ], 'Rating__c');
    expect(v.status).toBe('rts');
    expect(v.rtDrift).toBe(true);
    expect(v.rtDriftValues).toEqual(['Cold']);
    expect(v.label).toBe('RT assignment differs');
    expect(v.drifting).toBe(true);
  });

  it('matching record-type assignments stay in sync', () => {
    const v = pkFieldVerdict([
      localOrg('a', [V('Hot'), V('Cold')]),
      localOrg('b', [V('Hot'), V('Cold')]),
    ], [
      [rt('Partner', ['Hot'])],
      [rt('Partner', ['Hot'])],
    ], 'Rating__c');
    expect(v.status).toBe('sync');
    expect(v.rtDrift).toBe(false);
    expect(v.detail).toContain('record-type assignments');
  });

  it('value drift AND RT drift are both reported in one label', () => {
    const v = pkFieldVerdict([
      localOrg('a', [V('Hot'), V('Cold'), V('Warm')]),
      localOrg('b', [V('Hot'), V('Cold')]),
    ], [
      [rt('Partner', ['Hot', 'Cold'])],
      [rt('Partner', ['Hot'])],
    ], 'Rating__c');
    expect(v.status).toBe('values');
    expect(v.label).toBe('values differ (1) · RT assignment differs');
    expect(v.rtDrift).toBe(true);
  });

  it('record types readable in only ONE org: no RT verdict, and it says so', () => {
    const v = pkFieldVerdict([
      localOrg('a', [V('Hot')]),
      localOrg('b', [V('Hot')]),
    ], [[rt('Partner', ['Hot'])], null], 'Rating__c');
    expect(v.rtDrift).toBe(false);
    expect(v.rtComparable).toBe(1);
    expect(v.detail).toContain('RT drift was NOT checked');
  });

  it('a record type that exists in only one org is not treated as assignment drift', () => {
    const v = pkFieldVerdict([
      localOrg('a', [V('Hot')]),
      localOrg('b', [V('Hot')]),
    ], [
      [rt('Partner', ['Hot']), rt('OnlyHere', [])],
      [rt('Partner', ['Hot'])],
    ], 'Rating__c');
    expect(v.status).toBe('sync');
  });

  it('rt indices stay aligned with perOrgInv when a middle org is missing the field', () => {
    const v = pkFieldVerdict([
      localOrg('a', [V('Hot')]),
      { orgKey: 'b', kind: 'missing' },
      localOrg('c', [V('Hot')]),
    ], [
      [rt('Partner', ['Hot'])],
      null,
      [rt('Partner', [])],
    ], 'Rating__c');
    expect(v.rtComparable).toBe(2);
    expect(v.rtDrift).toBe(true);
    expect(v.missingIn).toEqual(['b']);
  });
});

describe('pkFieldVerdict — defensive input handling', () => {
  it('empty / null input never throws and never claims sync', () => {
    expect(pkFieldVerdict(null, null, 'X__c').status).toBe('missing');
    expect(pkFieldVerdict([], [], 'X__c').status).toBe('missing');
  });

  it('null entries in the org array are ignored', () => {
    const v = pkFieldVerdict([null, localOrg('a', [V('Hot')]), localOrg('b', [V('Hot')])], [null, null, null], 'R__c');
    expect(v.status).toBe('sync');
    expect(v.comparable).toBe(2);
  });
});

describe('pkAutomationUrl — deep links that make an automation hit actionable (T8)', () => {
  const org = 'https://acme.my.salesforce.com';

  it('builds a Flow Builder link from the flow VERSION id', () => {
    expect(pkAutomationUrl(org, 'Account', 'flow', '301XX0000004Cabc'))
      .toBe('https://acme.my.salesforce.com/builder_platform_interaction/flowBuilder.app?flowId=301XX0000004Cabc');
  });

  it('builds an Object Manager link for a validation rule', () => {
    expect(pkAutomationUrl(org, 'Account', 'vr', '03dXX0000008Yabc'))
      .toBe('https://acme.my.salesforce.com/lightning/setup/ObjectManager/Account/ValidationRules/03dXX0000008Yabc/view');
  });

  it('strips trailing slashes off the org URL', () => {
    expect(pkAutomationUrl(org + '///', 'Account', 'vr', 'X'))
      .toBe('https://acme.my.salesforce.com/lightning/setup/ObjectManager/Account/ValidationRules/X/view');
  });

  it('URL-encodes the object name', () => {
    expect(pkAutomationUrl(org, 'My Object__c', 'vr', 'X')).toContain('/ObjectManager/My%20Object__c/');
  });

  it('returns empty string (never a dead link) when the id or org is missing', () => {
    expect(pkAutomationUrl(org, 'Account', 'flow', '')).toBe('');
    expect(pkAutomationUrl('', 'Account', 'flow', 'X')).toBe('');
    expect(pkAutomationUrl(null, 'Account', 'vr', null)).toBe('');
  });
});
