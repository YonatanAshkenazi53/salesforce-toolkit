// 2026-09-22 — user: "i dont have production org". The typed gates fire on
// orgType, and a trial org is 'dev', so they could never be seen. 🛑 Guard as
// production makes the Toolkit treat an org like production everywhere.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const SC = readFileSync(new URL('../studio-scan.js', import.meta.url), 'utf8');
const CO = readFileSync(new URL('../studio-core.js', import.meta.url), 'utf8');
const { sftkOrgGuardedAsProd: guarded } = extractFunctions('studio-scan.js', ['sftkOrgGuardedAsProd'], { 'studio-core.js': ['_orgKey'], 'sftk-org-identity.js': ['sftkOrgKey'] });

describe('🛑 Guard as production', () => {
  it('matches by org identity and needs an explicit true', () => {
    const orgs = { 'https://a.my.salesforce.com/': { guardAsProd: true }, 'https://b.my.salesforce.com': { guardAsProd: 'yes' } };
    expect(guarded(orgs, 'https://A.my.salesforce.com')).toBe(true);
    expect(guarded(orgs, 'https://b.my.salesforce.com')).toBe(false);
    expect(guarded(orgs, '')).toBe(false);
    expect(guarded(null, 'https://a.my.salesforce.com')).toBe(false);
  });
  it('wins before any cache or query, for both the async and the cached read', () => {
    const ens = SC.slice(SC.indexOf('async function ensureOrgType(orgUrl) {'), SC.indexOf('function cachedOrgType(orgUrl) {'));
    expect(ens.indexOf("if (sftkOrgGuardedAsProd(_orgs, orgUrl)) return 'production';")).toBeLessThan(ens.indexOf('const key = _orgKey(orgUrl);'));
    expect(ens.indexOf("if (sftkOrgGuardedAsProd(_orgs, orgUrl)) return 'production';")).toBeLessThan(ens.indexOf("type: 'SF_QUERY'"));
    const cached = SC.slice(SC.indexOf('function cachedOrgType(orgUrl) {'), SC.indexOf('function prodBadge(orgUrl) {'));
    expect(cached).toContain("if (sftkOrgGuardedAsProd(_orgs, orgUrl)) return 'production';");
  });
  it('the badge says it is a choice, not a detection', () => {
    expect(SC).toContain('>guarded</span>');
  });
  it('one toggle on the org card, saved with the org', () => {
    expect(CO).toContain('data-dsaction="toggleGuardProd"');
    expect(CO).toContain("case 'toggleGuardProd':       window.toggleOrgGuardProd?.(arg); break;");
    const fn = CO.slice(CO.indexOf('window.toggleOrgGuardProd = async function(orgUrl) {'), CO.indexOf('window.removeOrg = function(orgUrl) {'));
    expect(fn).toContain('_orgs[orgUrl].guardAsProd = on;');
    expect(fn).toContain('await storageSaveOrgs();');
  });
});
