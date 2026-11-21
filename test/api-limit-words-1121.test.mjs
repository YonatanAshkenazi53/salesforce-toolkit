// backlog 2026-11-11: "check what the tools say when the org answers REQUEST_LIMIT_EXCEEDED". Simulated across every
// tool by scripts/dev/live/limit-sim.mjs (2026-11-21); these are the three places that did not say it well.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const LIMIT = 'HTTP 403: [{"message":"TotalRequests Limit exceeded.","errorCode":"REQUEST_LIMIT_EXCEEDED"}]';
const { sftkFriendlyError: friendly } = extractFunctions('sftk-friendly-error.js', ['sftkFriendlyError']);
const { sftkOhErrorWords: ohWords } = extractFunctions('studio-orghealth.js', ['sftkOhErrorWords']);
const { sftkScanFailWords: failWords } = extractFunctions('studio-scan.js', ['sftkScanFailWords']);

describe('Org health: a failed check', () => {
  it('says the limit, a busy org, a dropped network and an expired session in words', () => {
    expect(ohWords(LIMIT, friendly)).toBe('This org has used its daily API calls — Salesforce frees calls up again over the next 24 hours — try again later. Your session is fine; reconnecting will not help.');
    expect(ohWords('Account could not be described — ' + LIMIT, friendly)).toContain('This org has used its daily API calls');
    expect(ohWords('HTTP 403: ConcurrentRequests Limit exceeded.', friendly)).toContain('Too many requests are running');
    expect(ohWords('TypeError: Failed to fetch', friendly)).toContain('No connection to Salesforce');
    expect(ohWords(LIMIT, friendly)).not.toMatch(/HTTP 403|REQUEST_LIMIT_EXCEEDED/);
  });
  it('anything else stays as Salesforce said it; no friendly function is no crash', () => {
    expect(ohWords("No such column 'Foo__c' on entity 'Account'", friendly)).toBe("No such column 'Foo__c' on entity 'Account'");
    expect(ohWords(LIMIT, null)).toBe(LIMIT); expect(ohWords(null, friendly)).toBe('');
    expect(ohWords(LIMIT, () => { throw new Error('x'); })).toBe(LIMIT);
  });
  it('the card uses it and keeps the raw answer on hover', () => {
    const OH = read('studio-orghealth.js');
    expect(OH).toContain("`Could not be checked — ${sftkOhErrorWords(res.error, typeof sftkFriendlyError === 'function' ? sftkFriendlyError : null)}`");
    expect(OH).toContain('title="${esc(String(res.error))}"');
  });
});

describe('Deploy: a read of the two orgs that did not finish', () => {
  it('the reason stays on the page, naming the org that refused', () => {
    const toast = 'Diff scan: This org has used its daily API calls — try again later.';
    expect(failWords('source query failed: ' + LIMIT, toast, 'Dev org', 'UAT org')).toBe('Dev org — This org has used its daily API calls — try again later.');
    expect(failWords('target query failed: ' + LIMIT, toast, 'Dev org', 'UAT org')).toMatch(/^UAT org — /);
    expect(failWords('describe failed', 'Diff scan: describe failed', 'Dev org', 'UAT org')).toBe('describe failed');
  });
  it('an expired session keeps its own sentence (it names its org already)', () => {
    const s = 'Your session in Dev org has expired — open it in its Chrome tab and sign in again, then 🔄 Refresh state.';
    expect(failWords('source query failed: INVALID_SESSION_ID', s, 'Dev org', 'UAT org')).toBe(s);
  });
  it('remembered on failure, forgotten on the next read that finishes, painted on the card that offers the read', () => {
    const SC = read('studio-scan.js'), DEP = read('studio-deploy.js');
    expect(SC).toContain("sftkScanFailRemember(profile.id, sftkScanFailWords(raw, msg, orgLabel(profile.sourceOrg), orgLabel(profile.targetOrg)));");
    expect(SC.indexOf('sftkScanFailRemember(profile.id, null);')).toBeGreaterThan(SC.indexOf("showToast(msg, 'error', 9000);"));
    expect(DEP).toContain('<div class="ds-rec-card-line ds-dep-readfail" id="dsDepReadFail" role="status" hidden></div>');
    expect(DEP).toContain('⚠ <b>The last read did not finish.</b> ${esc(f.words)}');
    expect(read('studio.css')).toContain('.ds-dep-readfail[hidden] { display: none; }');
  });
});

describe('Picklist Manager: the object list that could not be read', () => {
  it('says it in words, with Salesforce’s answer on hover', () => {
    const PL = read('studio-picklists.js');
    expect(PL.split("fe && fe.type !== 'generic' ? fe.message : String(res.error).slice(0, 60)").length).toBe(3);
    expect(PL).not.toContain('<option value="">${esc(res.error).slice(0, 60)}</option>');
  });
});
