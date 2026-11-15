// Release QA 2026-11-14 — friendly errors: Field Cleaner's no-field-access hint, and a dropped
// network / the daily API limit no longer read as a session problem in the popup.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const { sftkFriendlyError } = extractFunctions('sftk-friendly-error.js', ['sftkFriendlyError']);

describe('1. Field Cleaner: a "missing" field on a usage query means no field access, not a stale mapping', () => {
  const raw = "No such column 'Secret__c' on entity 'Account'. If you are attempting to use a custom field, be sure to append the '__c'";
  it('with where: field-cleaner the hint names field-level access and never the Data Studio screen', () => {
    const fe = sftkFriendlyError(raw, { where: 'field-cleaner' });
    expect(fe.type).toBe('no-field-access');
    expect(fe.message).toMatch(/can't read Secret__c/);
    expect(fe.message).toMatch(/unknown, not zero/);
    expect(fe.hint).toMatch(/Field-Level Security/);
    expect(`${fe.message} ${fe.hint}`).not.toMatch(/Fields & mapping|stale field mapping/);
  });
  it('Data Studio (no opts) keeps its own stale-mapping hint', () => {
    const fe = sftkFriendlyError(raw);
    expect(fe.type).toBe('missing-field');
    expect(fe.hint).toMatch(/Fields & mapping/);
  });
  it('both usage-verdict call sites in field-cleaner.js pass the Field Cleaner context', () => {
    const FC = read('field-cleaner.js');
    expect(FC).toContain("sftkFriendlyError(agg.error, { where: 'field-cleaner' })");
    expect(FC).toContain("sftkFriendlyError(q.error, { where: 'field-cleaner' })");
  });
  it('the deprecation banner says nobody had access instead of "0 access grant(s) stripped"', () => {
    const FC = read('field-cleaner.js');
    expect(FC).toMatch(/dep\.fls\.length \|\| \(dep\.flsFailed \|\| \[\]\)\.length \? `\$\{dep\.fls\.length\} access grant\(s\) stripped` : 'no profile or permission set had access to the field/);
  });
});

describe('2. network and API-limit errors get their own plain message', () => {
  it.each(['Failed to fetch', 'TypeError: Failed to fetch', 'NetworkError when attempting to fetch resource.', 'net::ERR_INTERNET_DISCONNECTED'])('%s → network', raw => {
    const fe = sftkFriendlyError(raw);
    expect(fe.type).toBe('network');
    expect(fe.message).toBe('No connection to Salesforce');
    expect(fe.hint).toMatch(/network.*Retry/);
  });
  // 2026-11-15: the bare code 'scan: account: REQUEST_LIMIT_EXCEEDED' was pinned to the daily text here; the code
  // also stands for the concurrent limits, so it now has a neutral text — test/regress-1115-mdapi.test.mjs.
  it.each(['HTTP 403: TotalRequests Limit exceeded.', 'REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.'])('%s → api-limit', raw => {
    const fe = sftkFriendlyError(raw);
    expect(fe.type).toBe('api-limit');
    expect(fe.message).toMatch(/daily API calls/);
    expect(fe.hint).toMatch(/try again later/);
  });
  it('a session error is still a session error', () => {
    expect(sftkFriendlyError('INVALID_SESSION_ID: Session expired or invalid').type).toBe('session');
  });
});

// popup.js: handleApiError + showSessionError run against a tiny DOM stub.
function popupHarness() {
  const P = read('popup.js');
  const slice = name => { const at = P.search(new RegExp(`^function ${name}\\(`, 'm')); return P.slice(at, P.indexOf('\n}', at) + 2); };
  const els = {};
  const mk = (id, extra = {}) => (els[id] = { id, style: { display: '' }, textContent: '', title: '', onclick: null, ...extra });
  const connectRow = { style: { display: '' } };
  mk('orgUrlInput', { value: '', closest: () => connectRow });
  const label = { nodeType: 3, textContent: 'Auto-detect' };
  mk('retryBtn', { childNodes: [{ nodeType: 1 }, label] });
  for (const id of ['sessionErrorMsg', 'sessionError', 'reloadExtBtn', 'connectOrgBtn', 'loadingState', 'toolbar', 'flowList', 'emptyState', 'selectionSummary', 'deleteArea']) mk(id);
  const document = { getElementById: id => els[id] || null };
  const fn = new Function('document', 'sftkFriendlyError', 'chrome',
    `let sid = 'x', _flowsLoaded = true; const showLoading = () => {}; const initSession = () => {}; const renderHomePage = () => {}; const orgUrl = '';
     ${slice('showSessionError')}\n${slice('handleApiError')}\nreturn handleApiError;`)(document, sftkFriendlyError, { runtime: { reload() {} } });
  return { handleApiError: fn, els, connectRow, label };
}

// 2026-11-15: 'Failed to fetch' was pinned here as hiding the Connect form; a dead org address fails the same way and
// the form is its way out, so a network error keeps it — test/regress-1115-mdapi.test.mjs.
describe('2. popup: an API limit offers Retry only, never the Connect form', () => {
  it.each(['HTTP 403: TotalRequests Limit exceeded.'])('%s hides Connect and Reload Extension, labels Retry', raw => {
    const h = popupHarness();
    h.handleApiError(raw);
    expect(h.els.sessionError.style.display).toBe('');
    expect(h.connectRow.style.display).toBe('none');
    expect(h.els.reloadExtBtn.style.display).toBe('none');
    expect(h.label.textContent).toBe('Retry');
    expect(h.els.sessionErrorMsg.textContent).not.toMatch(/^HTTP 403/);
    expect(h.els.sessionErrorMsg.title).toBe(raw);   // the raw text stays reachable
  });
  it('any other error brings the Connect form and Auto-detect back after an API-limit error', () => {
    const h = popupHarness();
    h.handleApiError('HTTP 403: TotalRequests Limit exceeded.');
    expect(h.connectRow.style.display).toBe('none');
    h.handleApiError('Some other failure');
    expect(h.connectRow.style.display).toBe('');
    expect(h.els.reloadExtBtn.style.display).toBe('');
    expect(h.label.textContent).toBe('Auto-detect');
  });
});
