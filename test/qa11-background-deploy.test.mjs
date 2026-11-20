// QA 1.1 findings 56, 65 — a metadata deploy: a failed Apex test or low coverage is named; a deploy that runs
// tests is followed longer, and one whose end was not seen is marked submitted, not refused.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { extractFunctions } from './extract.mjs';

const E = extractFunctions('background.js', ['sfMetadataDeploy', 'sftkDeployFailureText', 'sftkDeployPollPlan', 'sftkDeploySubmittedError']);

// ── finding 56 ───────────────────────────────────────────────────────────
describe('finding 56: why a deploy failed', () => {
  it('a failing Apex test is named with its class, method and message', () => {
    const t = E.sftkDeployFailureText({ success: false, details: { componentFailures: [], runTestResult: { numFailures: 1,
      failures: [{ name: 'AccountServiceTest', methodName: 'savesOwner', message: 'System.AssertException: Assertion Failed' }] } } });
    expect(t).toBe('Apex test AccountServiceTest.savesOwner failed: System.AssertException: Assertion Failed');
  });
  it('a coverage warning is named; a single object instead of a list is read too', () => {
    const t = E.sftkDeployFailureText({ details: { runTestResult: {
      codeCoverageWarnings: { name: 'BillingBatch', message: 'Test coverage of selected Apex Class is 40%, at least 75% test coverage is required' } } } });
    expect(t).toBe('code coverage — BillingBatch: Test coverage of selected Apex Class is 40%, at least 75% test coverage is required');
    expect(E.sftkDeployFailureText({ details: { runTestResult: { codeCoverageWarnings: [{ message: 'Average test coverage across all Apex Classes and Triggers is 61%, at least 75% test coverage is required.' }] } } }))
      .toBe('code coverage: Average test coverage across all Apex Classes and Triggers is 61%, at least 75% test coverage is required.');
  });
  it('component problems come first and everything is joined', () => {
    const t = E.sftkDeployFailureText({ errorMessage: 'ignored when there are details', details: {
      componentFailures: [{ problem: 'Variable does not exist: Old__c' }],
      runTestResult: { failures: [{ name: 'T', message: 'boom' }], codeCoverageWarnings: [{ name: 'C', message: 'low' }] } } });
    expect(t).toBe('Variable does not exist: Old__c; Apex test T failed: boom; code coverage — C: low');
  });
  it('without details: Salesforce\'s errorMessage, then the plain fallback', () => {
    expect(E.sftkDeployFailureText({ errorMessage: 'UNKNOWN_EXCEPTION: try later' })).toBe('UNKNOWN_EXCEPTION: try later');
    expect(E.sftkDeployFailureText({})).toBe('Deployment failed');
    expect(E.sftkDeployFailureText(null)).toBe('Deployment failed');
  });
  it('a long list is cut at 8 and says where the rest is', () => {
    const t = E.sftkDeployFailureText({ details: { runTestResult: { failures: Array.from({ length: 11 }, (_, i) => ({ name: `T${i}`, message: 'x' })) } } });
    expect(t.split('; ').filter(p => p.startsWith('Apex test'))).toHaveLength(8);
    expect(t).toContain('and 3 more — see Setup → Deployment Status');
  });
});

// ── the deploy itself, with Salesforce stubbed ───────────────────────────
const WORLD = ['API_VERSION', 'assertOrgWritable', 'sfFetch', 'sfFetchWithProxy', 'sfErrorText', 'sfErrorMsg'];
function world(statusFor) {
  const seen = { polls: 0, options: null };
  globalThis.API_VERSION = 'v62.0';
  globalThis.assertOrgWritable = async () => {};
  globalThis.sfErrorText = async () => 'refused';
  globalThis.sfErrorMsg = (s) => `HTTP ${s}`;
  globalThis.sfFetch = async (url, init) => {
    const text = new TextDecoder().decode(init.body);
    seen.options = JSON.parse(/\r\n\r\n(\{.*?\})\r\n--/s.exec(text)[1]);
    return { ok: true, status: 201, json: async () => ({ id: '0Af000000000001' }) };
  };
  globalThis.sfFetchWithProxy = async () => { seen.polls++; return { ok: true, status: 200, body: JSON.stringify({ deployResult: statusFor(seen.polls) }) }; };
  return seen;
}
afterEach(() => { vi.useRealTimers(); for (const k of WORLD) delete globalThis[k]; });
const settle = async (p) => { const done = p.then(v => ({ v }), e => ({ e })); await vi.runAllTimersAsync(); return done; };

describe('finding 56: the deploy throws the named reason', () => {
  it('a finished deploy that failed on a test says which test', async () => {
    vi.useFakeTimers();
    world(() => ({ done: true, success: false, details: { runTestResult: { failures: [{ name: 'LeadTest', methodName: 'converts', message: 'Assertion Failed' }] } } }));
    const { e } = await settle(E.sfMetadataDeploy('https://x.my.salesforce.com', 'S', btoa('zip'), 'RunLocalTests'));
    expect(e.message).toBe('Apex test LeadTest.converts failed: Assertion Failed');
    expect(e.sftkSubmitted).toBeUndefined();   // Salesforce answered: this IS a refusal
  });
});

// ── finding 65 ───────────────────────────────────────────────────────────
describe('finding 65: a deploy that runs tests is followed longer, and an unseen end is not a refusal', () => {
  it('the plan: 100 seconds without tests, 4 minutes with them — under the 5 minutes one worker request may take', () => {
    expect(E.sftkDeployPollPlan()).toEqual({ polls: 40, waited: '100 seconds' });
    expect(E.sftkDeployPollPlan('NoTestRun')).toEqual({ polls: 40, waited: '100 seconds' });
    expect(E.sftkDeployPollPlan('RunLocalTests')).toEqual({ polls: 96, waited: '4 minutes' });
    expect(E.sftkDeployPollPlan('RunAllTestsInOrg')).toEqual({ polls: 96, waited: '4 minutes' });
    expect(E.sftkDeployPollPlan('RunLocalTests').polls * 2.5).toBeLessThan(300);
  });
  it('a test run that finishes after 3 minutes is seen to its end', async () => {
    vi.useFakeTimers();
    const seen = world(n => (n < 72 ? { done: false } : { done: true, success: true }));
    const { v } = await settle(E.sfMetadataDeploy('https://x.my.salesforce.com', 'S', btoa('zip'), 'RunLocalTests'));
    expect(v).toEqual({ success: true });
    expect(seen.polls).toBe(72);
    expect(seen.options.deployOptions.testLevel).toBe('RunLocalTests');
  });
  it('without tests the deploy is followed for 40 polls, and the error is marked submitted with the job id', async () => {
    vi.useFakeTimers();
    const seen = world(() => ({ done: false }));
    const { e } = await settle(E.sfMetadataDeploy('https://x.my.salesforce.com', 'S', btoa('zip')));
    expect(seen.polls).toBe(40);
    expect(e.message).toContain('Deployment 0Af000000000001 was submitted');
    expect(e.message).toContain('after 100 seconds');
    expect(e.sftkSubmitted).toBe(true);
    expect(e.jobId).toBe('0Af000000000001');
  });
  it('a test run still going after 4 minutes says so, and is marked submitted', async () => {
    vi.useFakeTimers();
    const seen = world(() => ({ done: false }));
    const { e } = await settle(E.sfMetadataDeploy('https://x.my.salesforce.com', 'S', btoa('zip'), 'RunLocalTests'));
    expect(seen.polls).toBe(96);
    expect(e.message).toContain('after 4 minutes');
    expect(e.message).toContain('MAY STILL FINISH');
    expect(e.sftkSubmitted).toBe(true);
  });
  it('a check that could not be followed is not marked: a check writes nothing', async () => {
    vi.useFakeTimers();
    world(() => ({ done: false }));
    const { e } = await settle(E.sfMetadataDeploy('https://x.my.salesforce.com', 'S', btoa('zip'), undefined, true));
    expect(e.message).toContain('nothing is changed by a check');
    expect(e.sftkSubmitted).toBeUndefined();
  });
  it('the message handler passes the mark on to the page', async () => {
    const { readFileSync } = await import('node:fs');
    const BG = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
    const at = BG.indexOf('chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {');
    const fn = BG.slice(at, BG.indexOf('\n});', at));
    expect(fn).toContain('if (err.sftkSubmitted === true) { resp.submitted = true; if (err.jobId) resp.jobId = err.jobId; }');
  });
});
