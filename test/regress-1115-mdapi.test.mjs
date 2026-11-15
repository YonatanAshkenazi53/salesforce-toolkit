// REGRESSION REVIEW 2026-11-15 of the release-QA commit (f0334a0) — the Metadata API editor's host guard and the
// friendly-error rules. Every case here runs the real function: sftkMdEditField from sftk-mdapi.js (the shared
// relationship resolver comes from test/setup-relmap.mjs, as on the page), sftkFriendlyError, and popup.js's
// handleApiError + showSessionError against a small DOM stub.
//
// What the review found, each proven by old-vs-new runs of the same call:
//  1. a PersonAccount.* compact layout / field set was refused for an Account field ("PersonAccount's same-named field");
//  2. a Contact field set's spanning entry Account.F was refused as "cannot tell" where it used to be edited;
//  3. with Task (or Event) picked, the sibling's view of the same custom Activity field was refused;
//  4. the bare REQUEST_LIMIT_EXCEEDED code and the concurrent limits read as the daily API allowance (24 hours);
//  5. a failed fetch hid the popup's Connect form, the only way out when the org address itself is dead.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const M = new Function(`${read('sftk-mdapi.js')}\nreturn { sftkMdEditField, sftkMdIsOwnObj };`)();
const { sftkFriendlyError } = extractFunctions('sftk-friendly-error.js', ['sftkFriendlyError']);

const F = 'Region__c', N = 'Zone__c';
const rm = (t, x, o = 'Account', f = F) => M.sftkMdEditField(t, x, o, f, null);
const rp = (t, x, o = 'Account', f = F) => M.sftkMdEditField(t, x, o, f, N);
const untouched = (r, x, why) => { expect(r.refused).toMatch(why); expect(r.xml).toBe(x); expect(r.changed).toBe(false); expect(r.how).toEqual([]); };
const edited = r => { expect(r.refused).toBeNull(); expect(r.changed).toBe(true); expect(r.unsure).toBeFalsy(); };

const cl = (obj, f = F) => `<fullName>${obj}.CL</fullName><fields>Name</fields><fields>${f}</fields><label>CL</label>`;
const row = (f, tag = 'displayedFields') => `<${tag}><field>${f}</field><isFieldManaged>false</isFieldManaged><isRequired>false</isRequired></${tag}>`;
const fs = (obj, rows) => `<fullName>${obj}.FS</fullName><description>d</description>${rows.join('')}<label>FS</label>`;
const lv = (obj, f = F) => `<fullName>${obj}.V</fullName><columns>NAME</columns><columns>${f}</columns><filterScope>Everything</filterScope><label>V</label>`;

describe('1. a Person Account component holds Account’s fields', () => {
  it('the own-object rule: PersonAccount is Account’s, one way only', () => {
    expect(M.sftkMdIsOwnObj('PersonAccount', 'Account')).toBe(true);
    expect(M.sftkMdIsOwnObj('Account', 'PersonAccount')).toBe(false);
    expect(M.sftkMdIsOwnObj('PersonAccount', 'Contact')).toBe(false);
    // what it knew before stays
    expect(M.sftkMdIsOwnObj('Task', 'Activity')).toBe(true);
    expect(M.sftkMdIsOwnObj('Activity', 'Task')).toBe(false);
  });
  it('✂ and ⇄ of Account.F edit a PersonAccount compact layout', () => {
    const r = rm('CompactLayout', cl('PersonAccount'));
    edited(r);
    expect(r.xml).toBe('<fullName>PersonAccount.CL</fullName><fields>Name</fields><label>CL</label>');
    const p = rp('CompactLayout', cl('PersonAccount'));
    edited(p);
    expect(p.xml).toContain(`<fields>${N}</fields>`);
  });
  it('✂ and ⇄ of Account.F edit a PersonAccount field set and list view', () => {
    const x = fs('PersonAccount', [row('Name'), row(F)]);
    const r = rm('FieldSet', x);
    edited(r);
    expect(r.xml).not.toContain(F);
    expect(rp('FieldSet', x).xml).toContain(`<field>${N}</field>`);
    const v = rm('ListView', lv('PersonAccount'));
    edited(v);
    expect(v.xml).not.toContain(F);
  });
  it('with Contact picked, the PersonAccount component is still another object’s: refused, nothing changed', () => {
    const c = cl('PersonAccount'), s = fs('PersonAccount', [row('Name'), row(F)]);
    untouched(rm('CompactLayout', c, 'Contact'), c, /a PersonAccount compact layout holds PersonAccount’s fields, not this one/);
    untouched(rp('FieldSet', s, 'Contact'), s, /a PersonAccount field set holds PersonAccount’s fields, not this one/);
  });
});

describe('2. a field set of another object: the spanning entry is resolved, the bare one is left', () => {
  it('⇄ rewrites Account.F in a Contact field set, keeping the spelling', () => {
    const x = fs('Contact', [row(`Account.${F}`), row('Name')]);
    const r = rp('FieldSet', x);
    edited(r);
    expect(r.xml).toBe(fs('Contact', [row(`Account.${N}`), row('Name')]));
  });
  it('✂ takes only the Account.F entry out', () => {
    const r = rm('FieldSet', fs('Contact', [row(`Account.${F}`), row('Name')]));
    edited(r);
    expect(r.xml).toBe(fs('Contact', [row('Name')]));
  });
  it('a Contact field set holding both: Contact’s own bare F stays, only Account.F is edited, and the result says so', () => {
    const x = fs('Contact', [row(F), row(`Account.${F}`), row(F, 'availableFields')]);
    const r = rp('FieldSet', x);
    edited(r);
    expect(r.xml).toBe(fs('Contact', [row(F), row(`Account.${N}`), row(F, 'availableFields')]));
    expect(r.how.join(' ')).toMatch(/Contact’s own Region__c is left as it is/);
  });
  it('a hop that leads to another object is not this field (Owner.F is User’s) — and is User’s when User is picked', () => {
    const x = fs('Contact', [row(`Owner.${F}`), row('Name')]);
    untouched(rm('FieldSet', x), x, /does not list the field/);
    const r = rp('FieldSet', x, 'User');
    edited(r);
    expect(r.xml).toContain(`<field>Owner.${N}</field>`);
  });
  it('a two-hop path is walked to its end (Account.Owner.F is User’s, not Account’s)', () => {
    const x = fs('Contact', [row(`Account.Owner.${F}`), row('Name')]);
    untouched(rm('FieldSet', x), x, /does not list the field/);
    expect(rm('FieldSet', x, 'User').xml).toBe(fs('Contact', [row('Name')]));
  });
  it('a custom lookup or What / Who hop cannot be told: unsure, nothing changed — even next to an entry that can', () => {
    const a = fs('Contact', [row(`Partner__r.${F}`), row(`Account.${F}`)]);
    const r = rp('FieldSet', a);
    untouched(r, a, /through a custom lookup \(Lookup__r\.Field__c\), and which object that lookup reaches cannot be told here/);
    expect(r.unsure).toBe(true);
    const b = fs('Task', [row(`What.${F}`), row('Subject')]);
    const q = rm('FieldSet', b);
    untouched(q, b, /a lookup that can reach any object, and whose field that is cannot be told here/);
    expect(q.unsure).toBe(true);
  });
  it('only bare entries in another object’s field set: the old refusal, not unsure', () => {
    const x = fs('Contact', [row('Name'), row(F)]);
    const r = rm('FieldSet', x);
    untouched(r, x, /a Contact field set holds Contact’s fields, not this one/);
    expect(r.unsure).toBeUndefined();
  });
  it('the own object’s field set and one whose object is not known are edited as before', () => {
    expect(rm('FieldSet', fs('Account', [row('Name'), row(F)])).xml).toBe(fs('Account', [row('Name')]));
    const x = fs('Contact', [row('Name'), row(F)]).replace('Contact.FS', 'FS');
    expect(rm('FieldSet', x).refused).toBeNull();
  });
  it('a list view keeps the cannot-tell refusal for a dotted column: its column names are not relationship paths', () => {
    const x = lv('Contact', `Account.${F}`);
    const r = rp('ListView', x);
    untouched(r, x, /cannot be told/);
    expect(r.unsure).toBe(true);
  });
});

describe('3. a custom Activity field picked on Task or Event', () => {
  it.each([['Task', 'Event'], ['Event', 'Task'], ['Task', 'Activity'], ['Activity', 'Event']])('picked on %s, the %s list view / field set / compact layout is edited', (pick, host) => {
    const v = rm('ListView', lv(host), pick);
    edited(v);
    expect(v.xml).not.toContain(F);
    const s = rp('FieldSet', fs(host, [row('Subject'), row(F)]), pick);
    edited(s);
    expect(s.xml).toContain(`<field>${N}</field>`);
    const c = rm('CompactLayout', cl(host), pick);
    edited(c);
    expect(c.xml).not.toContain(F);
  });
  it('a STANDARD field is not shared: Task.Subject picked, an Event view’s Subject is Event’s', () => {
    const x = lv('Event', 'Subject');
    untouched(rm('ListView', x, 'Task', 'Subject'), x, /a Event list view holds Event’s fields, not this one/);
    const c = cl('Task', 'Subject');
    untouched(rm('CompactLayout', c, 'Event', 'Subject'), c, /a Task compact layout holds Task’s fields/);
  });
  it('the family is Task / Event / Activity only: Task picked, a Contact view is still Contact’s', () => {
    const x = lv('Contact');
    untouched(rm('ListView', x, 'Task'), x, /a Contact list view holds Contact’s fields/);
  });
  // 2026-11-15 (close-out review): this test pinned "only the list types — an Event validation rule is refused for a
  // Task pick". The review confirmed that as a defect: the sweep lists the Event rule as a blocker of the one
  // Activity field, so the remover must edit it. A Contact rule is still Contact's.
  it('not only the list types: an Event validation rule is rewritten for a Task pick; a Contact rule is not', () => {
    const vr = h => `<fullName>${h}.VR</fullName><active>true</active><errorConditionFormula>ISBLANK(${F})</errorConditionFormula><errorDisplayField>${F}</errorDisplayField><errorMessage>m</errorMessage>`;
    const r = rp('ValidationRule', vr('Event'), 'Task');
    expect(r.refused).toBeNull(); expect(r.changed).toBe(true);
    expect(r.xml).not.toContain(F);
    const c = rp('ValidationRule', vr('Contact'), 'Task');
    expect(c.changed).toBe(false); expect(c.xml).toBe(vr('Contact')); expect(c.refused).toBeTruthy();
  });
});

describe('4. REQUEST_LIMIT_EXCEEDED is one code for several limits', () => {
  it.each([
    'REQUEST_LIMIT_EXCEEDED: ConcurrentRequests (Concurrent API Requests) Limit exceeded.',
    'HTTP 403: [{"message":"ConcurrentPerOrgLongTxn Limit exceeded.","errorCode":"REQUEST_LIMIT_EXCEEDED"}]',
  ])('%s → transient, no 24-hour claim', raw => {
    const fe = sftkFriendlyError(raw);
    expect(fe.type).toBe('api-busy');
    expect(fe.message).toBe('Too many requests are running in this org at once');
    expect(fe.hint).toMatch(/try again shortly/);
    expect(`${fe.message} ${fe.hint}`).not.toMatch(/daily|24 hours/);
    expect(fe.raw === undefined || fe.raw === raw).toBe(true);
  });
  it.each(['scan: account: REQUEST_LIMIT_EXCEEDED', 'REQUEST_LIMIT_EXCEEDED'])('the bare code %s names no limit, so the text claims none', raw => {
    const fe = sftkFriendlyError(raw);
    expect(fe.type).toBe('api-limit');
    expect(fe.message).toBe('An API limit of this org was hit');
    expect(`${fe.message} ${fe.hint}`).not.toMatch(/daily|24 hours/);
  });
  it.each(['HTTP 403: TotalRequests Limit exceeded.', 'REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.'])('%s is still the daily allowance', raw => {
    const fe = sftkFriendlyError(raw);
    expect(fe.type).toBe('api-limit');
    expect(fe.message).toBe('This org has used its daily API calls');
    expect(fe.hint).toMatch(/24 hours/);
  });
});

// popup.js: handleApiError + showSessionError against a tiny DOM stub (the harness of release-qa-1114-friendly-error).
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

describe('5. popup: a failed fetch may be a dead org address, so the Connect form stays', () => {
  it.each(['Failed to fetch', 'TypeError: Failed to fetch (net::ERR_NAME_NOT_RESOLVED)', 'net::ERR_INTERNET_DISCONNECTED'])('%s keeps Connect and Reload Extension, labels the button Retry', raw => {
    const h = popupHarness();
    h.handleApiError(raw);
    expect(h.els.sessionError.style.display).toBe('');
    expect(h.connectRow.style.display).toBe('');
    expect(h.els.reloadExtBtn.style.display).toBe('');
    expect(h.label.textContent).toBe('Retry');
    expect(h.els.sessionErrorMsg.textContent).toMatch(/network/);
    expect(h.els.sessionErrorMsg.textContent).toMatch(/org address/);
    expect(h.els.sessionErrorMsg.title).toBe(raw);
  });
  it('the hint names both causes', () => {
    const fe = sftkFriendlyError('TypeError: Failed to fetch (net::ERR_NAME_NOT_RESOLVED)');
    expect(fe.type).toBe('network');
    expect(fe.hint).toMatch(/network.*org address.*renamed or deleted.*Retry/);
  });
  it.each([
    'HTTP 403: TotalRequests Limit exceeded.',
    'scan: account: REQUEST_LIMIT_EXCEEDED',
    'REQUEST_LIMIT_EXCEEDED: ConcurrentRequests (Concurrent API Requests) Limit exceeded.',
  ])('%s still offers Retry only — reconnecting cannot help a limit', raw => {
    const h = popupHarness();
    h.handleApiError(raw);
    expect(h.connectRow.style.display).toBe('none');
    expect(h.els.reloadExtBtn.style.display).toBe('none');
    expect(h.label.textContent).toBe('Retry');
  });
  it('after a network error, an API limit hides the form and any other error brings Auto-detect back', () => {
    const h = popupHarness();
    h.handleApiError('Failed to fetch');
    h.handleApiError('HTTP 403: TotalRequests Limit exceeded.');
    expect(h.connectRow.style.display).toBe('none');
    h.handleApiError('Some other failure');
    expect(h.connectRow.style.display).toBe('');
    expect(h.els.reloadExtBtn.style.display).toBe('');
    expect(h.label.textContent).toBe('Auto-detect');
  });
});
