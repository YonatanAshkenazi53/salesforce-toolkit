// Lightning Pages — a record page's assignments, on the model Salesforce
// really uses. Hand-level QA 2026-10-04 (the tool had never had it): asking
// for an App Default on an unassigned page (1) made that page the org-wide
// Desktop default — silently, replacing another page — and (2) then failed,
// because the tool wrote app-level assignments in a shape Salesforce refuses.
// Proved by CLI on trailheads5 the same day:
//   • App Default       = an entry of CustomApplication.actionOverrides
//   • App + RT + Profile = an entry of .profileActionOverrides, profile by its
//     METADATA name ("Admin", "Standard"), record type as Object.DeveloperName
//   • a PATCH MERGES those two lists (an entry is removed with type "Default")
//     and REPLACES every other field of the app
//   • FlexiPage.Metadata has no pageAssignments and no publishStatus
//   • ⏸ Deactivate deployed a blind "Default" → reset ANOTHER page's org default
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const LP = read('lightning-pages.js');
// the pure helpers sit at column 0, after the module
const PURE = LP.slice(LP.indexOf('// ══ A record page\'s assignments — the real model (pure)'));
const P = new Function(`${PURE}\nreturn { lpSameSlot, lpAppAssignments, lpAppSlotHolder, lpAppHas, lpAppDelta, lpOrgSlotHolder, lpPageStatus, lpAssignmentWords, lpWhy };`)();
const between = (a, b) => { const i = LP.indexOf(a); expect(i, a).toBeGreaterThan(0); const j = LP.indexOf(b, i + a.length); expect(j, b).toBeGreaterThan(i); return LP.slice(i, j); };

const APP = { id: '02uA', name: 'SFTK_LP_Test_App', label: 'SFTK LP Test App' };
const META = () => ({
  label: 'SFTK LP Test App', tabs: ['standard-Account'],
  actionOverrides: [
    { actionName: 'View', comment: null, content: 'Page_A', formFactor: 'Large', pageOrSobjectType: 'Account', skipRecordTypeSelect: false, type: 'Flexipage' },
    { actionName: 'View', content: 'Other_Page', formFactor: 'Small', pageOrSobjectType: 'Account', type: 'Flexipage' },
    { actionName: 'View', content: 'Page_A', formFactor: 'Large', pageOrSobjectType: 'Contact', type: 'Flexipage' },
  ],
  profileActionOverrides: [
    { actionName: 'View', content: 'Page_A', formFactor: 'Large', pageOrSobjectType: 'Account', profile: 'Admin', recordType: 'Account.Household', type: 'Flexipage' },
    { actionName: 'View', content: 'Other_Page', formFactor: 'Large', pageOrSobjectType: 'Account', profile: 'Standard', recordType: null, type: 'Flexipage' },
  ],
});

describe('reading — what one app holds for a page', () => {
  it('an app default comes from actionOverrides, app + record type + profile from profileActionOverrides', () => {
    const rows = P.lpAppAssignments(APP, META(), 'page_a', 'Account');
    expect(rows.map(r => r.kind)).toEqual(['app', 'app', 'artp']);
    expect(rows[0]).toMatchObject({ app: 'SFTK_LP_Test_App', appId: '02uA', appLabel: 'SFTK LP Test App', formFactor: 'Large', sobject: 'Account' });
    expect(rows[2]).toMatchObject({ profileFull: 'Admin', recordTypeFull: 'Account.Household', recordType: 'Household' });
  });
  it('another page\'s entries are not this page\'s', () => {
    expect(P.lpAppAssignments(APP, META(), 'Other_Page', 'Account').map(r => [r.kind, r.formFactor])).toEqual([['app', 'Small'], ['artp', 'Large']]);
    expect(P.lpAppAssignments(APP, META(), 'Nobody', 'Account')).toEqual([]);
    expect(P.lpAppAssignments(APP, null, 'Page_A', 'Account')).toEqual([]);
  });
  it('who holds a slot, and whether it is this page', () => {
    const m = META();
    const appSlot = { kind: 'app', formFactor: 'Small', sobject: 'Account' };
    expect(P.lpAppSlotHolder(m, appSlot)).toBe('Other_Page');
    expect(P.lpAppHas(m, appSlot, 'Page_A')).toBe(false);
    expect(P.lpAppHas(m, { kind: 'app', formFactor: 'Large', sobject: 'account' }, 'PAGE_A')).toBe(true);
    const prof = { kind: 'artp', formFactor: 'Large', sobject: 'Account', profileFull: 'Admin', recordTypeFull: 'Account.Household' };
    expect(P.lpAppHas(m, prof, 'Page_A')).toBe(true);
    expect(P.lpAppSlotHolder(m, { ...prof, recordTypeFull: 'Account.Business' })).toBeNull();   // another record type is another slot
    expect(P.lpAppSlotHolder(m, { ...prof, profileFull: 'Standard', recordTypeFull: null })).toBe('Other_Page');
  });
});

describe('writing — only the changed entry travels, in the shape Salesforce accepts', () => {
  it('an app default goes to actionOverrides (never to profileActionOverrides without a profile)', () => {
    const d = P.lpAppDelta({ kind: 'app', formFactor: 'Small', sobject: 'Account' }, 'Page_A', false);
    expect(d).toEqual({ actionOverrides: [{ actionName: 'View', formFactor: 'Small', pageOrSobjectType: 'Account', type: 'Flexipage', content: 'Page_A', skipRecordTypeSelect: false }], profileActionOverrides: [] });
  });
  it('app + record type + profile carries the profile\'s METADATA name and Object.RecordType', () => {
    const d = P.lpAppDelta({ kind: 'artp', formFactor: 'Large', sobject: 'Account', profileFull: 'Admin', recordTypeFull: 'Account.Household' }, 'Page_A', false);
    expect(d.actionOverrides).toEqual([]);
    expect(d.profileActionOverrides).toEqual([{ actionName: 'View', formFactor: 'Large', pageOrSobjectType: 'Account', type: 'Flexipage', content: 'Page_A', profile: 'Admin', recordType: 'Account.Household' }]);
    // an object without record types: no recordType key at all
    expect('recordType' in P.lpAppDelta({ kind: 'artp', formFactor: 'Large', sobject: 'X__c', profileFull: 'Admin', recordTypeFull: null }, 'P', false).profileActionOverrides[0]).toBe(false);
  });
  it('removing = the "Default" entry for the slot, without a page (a list without the entry removes nothing)', () => {
    const d = P.lpAppDelta({ kind: 'artp', formFactor: 'Large', sobject: 'Account', profileFull: 'Admin', recordTypeFull: 'Account.Household' }, 'Page_A', true);
    expect(d.profileActionOverrides[0]).toEqual({ actionName: 'View', formFactor: 'Large', pageOrSobjectType: 'Account', type: 'Default', profile: 'Admin', recordType: 'Account.Household' });
    expect(P.lpAppDelta({ kind: 'app', formFactor: 'Large', sobject: 'Account' }, 'Page_A', true).actionOverrides[0]).toMatchObject({ type: 'Default' });
    expect('content' in P.lpAppDelta({ kind: 'app', formFactor: 'Large', sobject: 'Account' }, 'Page_A', true).actionOverrides[0]).toBe(false);
  });
  it('the PATCH carries the app\'s whole current definition (every other field is replaced by a PATCH) plus the delta', () => {
    const fn = between('async function writeAppAssignment(a, devName, remove, journal) {', '\n  }\n');
    expect(fn).toContain('const before = await refreshApp(a.appId);');
    expect(fn).toContain('const body = { Metadata: { ...sftkMetaForPatch(before), ...lpAppDelta(a, devName, remove) } };');
    // the verdict is the app, read again
    expect(fn).toContain('const now = await refreshApp(a.appId);');
    expect(fn).toContain('return { ok: lpAppHas(now, a, devName) === !remove, text: null };');
  });
  it('a profile is written by its metadata name, read one profile at a time', () => {
    expect(LP).toContain("query: `SELECT Id, FullName FROM Profile WHERE Id = '${profileId}'` });");
    expect(LP).toContain("if (a.kind === 'artp' && !a.profileFull) a.profileFull = await profileFullName(a.profileId);");
  });
});

describe('the org default — read from the describe, written with a re-read, never reset blind', () => {
  const D = { actionOverrides: [
    { name: 'View', formFactor: 'LARGE', pageId: '0M0LARGE00000001AAA' },
    { name: 'view', formFactor: 'SMALL', pageId: '0M0SMALL00000001AAA' },
    { name: 'Edit', formFactor: 'LARGE', pageId: '0M0EDIT' },
    { name: 'View', formFactor: 'LARGE', pageId: null },
  ] };
  it('the holder of a slot is the View override of that form factor that names a page', () => {
    expect(P.lpOrgSlotHolder(D, 'Large')).toBe('0M0LARGE00000001AAA');
    expect(P.lpOrgSlotHolder(D, 'Small')).toBe('0M0SMALL00000001AAA');
    expect(P.lpOrgSlotHolder({ actionOverrides: [] }, 'Large')).toBeNull();
  });
  const fn = between('async function writeOrgDefault(sobject, formFactor, target, journal, say, holder) {', '\n  }\n');
  it('clearing happens only while THIS page still holds the slot (⏸ Deactivate used to reset another page\'s org default)', () => {
    expect(fn).toContain('const now = lpOrgSlotHolder(await readDescribe(sobject), formFactor);');
    expect(fn).toContain('if (!now || id15(now) !== id15(holder.id)) {');
    expect(fn).toContain('skipped: true');
  });
  it('the write is judged by re-reading the describe, with a shown, bounded wait — no more "not re-read"', () => {
    expect(fn).toContain('for (let n = 1; n <= 8; n++) {');
    expect(fn).toContain('re-reading the org to confirm it (${n} of 8)…');
    expect(fn).not.toContain('noVerify');
    expect(LP).not.toContain("noVerify: 'no queryable sObject for a CustomObject actionOverride");
  });
  it('History can put the previous page back, and the undo is re-read through the describe', () => {
    const u = between('function orgUndoStep(sobject, formFactor, prevPage, prevId) {', '\n  }\n');
    expect(u).toContain('if (prevId && !prevPage) return null;');
    expect(u).toContain("verify: { path: `services/data/v62.0/sobjects/${sobject}/describe/`, pick: 'actionOverrides',");
    expect(u).toContain('retries: 8,');
  });
});

describe('nothing is written that was not asked for', () => {
  const add = between('async function doAdd(page, metaRes, currentAssignments, mode, want, ctx) {', '\n  // What holds each wanted slot right now');
  it('an app or profile assignment no longer makes the page the org default first', () => {
    expect(LP).not.toContain('activatePage(');
    expect(LP).not.toContain('the Draft page will also be activated');
    expect(add).not.toContain("'Large', null");
  });
  it('the confirmation names every assignment and the page each one REPLACES, read fresh', () => {
    expect(add).toContain('try { holders = await currentHolders(want, sobject); }');
    expect(add).toContain('`REPLACES “${pageName(h)}” there`');
    expect(add).toContain('needsCheckbox: replaced > 0,');
  });
  it('there is no Activate button and no "All Apps" / "Mark as Default": Salesforce has no such things', () => {
    expect(LP).not.toContain('id="lpActivateBtn"');
    expect(LP).not.toContain('All Apps');
    expect(LP).not.toContain('lpARTPDefault');
  });
  it('Deactivate = remove every assignment the page has, each named, each checked again', () => {
    expect(LP).toContain("document.getElementById('lpDeactivateBtn')?.addEventListener('click', () => confirmRemove(page, metaRes, assignments, assignments.map((_, i) => i), ctx));");
    expect(LP).toContain('Deactivating a page means removing every assignment it has');
    expect(LP).toContain('if (remove && !lpAppHas(before, a, devName)) {');
  });
  it('cloning creates an UNASSIGNED copy; moving the assignments is a separate, confirmed choice', () => {
    const dlg = between('function openCloneDialog(page, metaRes, assignments, ctx) {', '  // Deploy a cloned FlexiPage');
    expect(dlg).toContain('<input type="checkbox" id="cloneCopyAssignments">');          // not ticked
    expect(dlg).toContain('The copy TAKES OVER these');
    expect(dlg).toContain("confirmLabel: '📋 Clone and move',");
    expect(dlg).toContain('production: gate.production ? { label: gate.label } : null,');
  });
});

describe('what is on screen is what the org answers', () => {
  it('the detail is never drawn from what a write was supposed to have done', () => {
    expect(LP).toContain('async function openDetail(page, errorMsg = null, note = null) {');
    expect(LP).not.toContain('assignmentsOverride');
    expect(LP).not.toContain('synthAssignments');
    expect(LP).not.toContain('publishStatusOverride');
  });
  it('a record page\'s status is its assignments; a failed read is unknown; other page types are not claimed', () => {
    expect(P.lpPageStatus([{ kind: 'app' }], false)).toBe('Active');
    expect(P.lpPageStatus([], false)).toBe('Unassigned');
    expect(P.lpPageStatus([], true)).toBeNull();
    expect(LP).toContain("const isRecordPage = page.Type === 'RecordPage' && !!sobject;");
    expect(LP).toContain('Activation not read here');
  });
  it('an app default is called an app default (it used to read "Org Default — applies to all users in the org")', () => {
    expect(P.lpAssignmentWords({ kind: 'app' })).toMatchObject({ title: 'App default' });
    expect(P.lpAssignmentWords({ kind: 'org' }).title).toBe('Org default');
    expect(P.lpAssignmentWords({ kind: 'artp', profile: 'Sales' }).title).toBe('Sales');
  });
  it('a failed user query is an error with a retry, never "No active users"', () => {
    const f = between('async function fetchUsers(profileId) {', '\n  }\n');
    expect(f).toContain("if (!res || res.error) return { users: [], error: (res && res.error) || 'no answer' };");
    expect(f.indexOf('profileUserCache[profileId] = res.records || [];')).toBeGreaterThan(f.indexOf('if (!res || res.error) return'));
    expect(LP).toContain('Could not load users: ${esc(lpWhy(res.error))}');
  });
  it('the list and the audit read app-level assignments from the apps, not from a field that does not exist', () => {
    expect(LP).not.toContain('meta.Metadata?.pageAssignments');        // the audit
    expect(LP).not.toContain('metaRes.Metadata?.pageAssignments');     // the detail
    expect(LP).toContain("const targets = allPages.filter(p => p.Type === 'RecordPage').sort((a, b) =>");
    expect(LP).toContain('This audit covers record pages.');
  });
  it('Salesforce\'s refusal is shown in its own words — not with the data-deployment hint', () => {
    expect(P.lpWhy('HTTP 400: Required field profile is empty')).toBe('Required field profile is empty');
    expect(P.lpWhy(null)).toBe('no reason given');
  });
});

// Security review 2026-10-06 (low): the progress line of a write is HTML, and an
// app's label is whatever an admin typed — it is escaped in every call.
describe('the progress line escapes the app label', () => {
  it('every say() that names an app goes through esc()', () => {
    const LP = readFileSync(new URL('../lightning-pages.js', import.meta.url), 'utf8');
    expect(LP).toContain('say(`${tag} · ${esc(a.appLabel)}…`);');
    expect(LP).toContain('say(`${tag}${esc(a.appLabel || a.app)}…`);');
    expect(LP).toContain('say(`${tag} · ${esc(a.appLabel || a.app)}…`);');
    expect(LP).not.toMatch(/say\(`[^`]*\$\{a\.appLabel/);
  });
});
