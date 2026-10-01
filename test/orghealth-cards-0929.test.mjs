// Campaign 3 phase 8b — the four Org health cards added after licences / idle /
// flows-off: apiver, pages, picklists, fields.
//
// Each card's judgement is a pure function of what was read; the honest failure
// branches (a read that did not answer, an org that was not open, an empty
// object) must never come out as an all-clear. The card wiring is pinned by source.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction, extractFunctions } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = f => readFileSync(join(root, f), 'utf8');
const SRC = rd('studio-orghealth.js');
const F = 'studio-orghealth.js';

const { sftkOhApiVerVerdict: apiVerdict } = extractFunctions(F, ['sftkOhApiVerVerdict'], { 'sftk-apiver.js': ['sftkApiVerNum', 'sftkApiVerLag'] });
const objectName = extractFunction(F, 'sftkOhObjectName');
const readProblem = extractFunction(F, 'sftkOhReadProblem');
const batchItems = extractFunction(F, 'sftkOhBatchItems');
const pageDescribe = extractFunction(F, 'sftkOhPageDescribeVerdict');
const pageState = extractFunction(F, 'sftkOhPageState');
const pagesVerdict = extractFunction(F, 'sftkOhPagesVerdict');
const picklistsVerdict = extractFunction(F, 'sftkOhPicklistsVerdict');
const countable = extractFunction(F, 'sftkOhFieldCountable');
const fillQuery = extractFunction(F, 'sftkOhFillQuery');
const looksCapped = extractFunction(F, 'sftkOhLooksCapped');
const fieldsVerdict = extractFunction(F, 'sftkOhFieldsVerdict');

// ── 1. apiver ───────────────────────────────────────────────────────────
describe('apiver — flows pinned below the org’s release', () => {
  const max = { version: '66.0', num: 66, label: "Winter '26" };
  const flow = (name, api, ns) => ({ Id: '301x', ApiVersion: api, Status: 'Active', Definition: { DeveloperName: name, NamespacePrefix: ns || null } });
  it('3+ releases behind → warn, worst first, "Flow — API 49 · 17 releases behind"', () => {
    const v = apiVerdict(max, [flow('Recent', 65), flow('Old_A', 60), flow('Ancient', 49), flow('Old_B', 60), flow('Edge', 63)]);
    expect(v.tone).toBe('warn');
    expect(v.lines).toEqual(['Ancient — API 49 · 17 releases behind', 'Old_A — API 60 · 6 releases behind', 'Old_B — API 60 · 6 releases behind', 'Edge — API 63 · 3 releases behind']);
    expect(v.headline).toContain('4 active flow(s) pinned 3 or more releases below');
    expect(v.headline).toContain("Winter '26");
  });
  it('2 behind is fine → good; packaged flows are counted but never listed as findings', () => {
    const v = apiVerdict(max, [flow('Fine', 64), flow('Pkg', 30, 'acme')]);
    expect(v.tone).toBe('good');
    expect(v.headline).toContain('1 checked');
    expect(v.lines.join('|')).toContain('1 active flow(s) come from installed packages');
    expect(v.lines.join('|')).not.toContain('Pkg —');
  });
  it('a flow with no readable API version is said, not judged fine', () => {
    const v = apiVerdict(max, [flow('Odd', null), flow('Fine', 66)]);
    expect(v.tone).toBe('warn');
    expect(v.headline).toContain('NOT an all-clear');
    expect(apiVerdict(max, []).tone).toBe('good');
  });
  it('the card reads the org release and the active flows, 2 calls, opens API versions', () => {
    expect(SRC).toContain("id: 'apiver'");
    expect(SRC).toContain("path: 'services/data/'");
    expect(SRC).toContain("SELECT Id, ApiVersion, Status, Definition.DeveloperName, Definition.NamespacePrefix FROM Flow WHERE Status = 'Active'");
    expect(SRC).toContain('sftkApiVerMax(v)');
    expect(SRC).toContain("fix: { label: 'Open ⚙ API versions', popupTab: 'dependencies' }");
    expect(SRC).toMatch(/id: 'apiver'[\s\S]*?calls: \(\) => 2,/);
    expect(SRC).toContain("throw new Error('the org listed no API versions')");
  });
  it('studio.html loads sftk-apiver.js before the page that uses it, and the store pack ships every root .js', () => {
    const html = rd('studio.html');
    expect(html.indexOf('src="sftk-apiver.js"')).toBeGreaterThan(0);
    expect(html.indexOf('src="sftk-apiver.js"')).toBeLessThan(html.indexOf('src="studio-orghealth.js"'));
    expect(rd('scripts/pack_store.py')).not.toContain("'sftk-apiver.js'");   // not excluded
  });
});

// ── shared reads ────────────────────────────────────────────────────────
describe('shared read guards', () => {
  it('object names are API names only (they go into URLs and FROM clauses)', () => {
    expect(objectName(' Account ')).toBe('Account');
    expect(objectName('My_Obj__c')).toBe('My_Obj__c');
    expect(objectName('Account; DELETE')).toBe('');
    expect(objectName('a/b')).toBe('');
    expect(objectName('')).toBe('');
  });
  it('an error or an incomplete pager is a problem, a clean answer is not', () => {
    expect(readProblem({ records: [] })).toBe('');
    expect(readProblem({ error: 'boom' })).toBe('boom');
    expect(readProblem(null)).toBe('no answer');
    expect(readProblem({ records: [], incomplete: { expected: 5, got: 3 } })).toContain('5 row(s)');
  });
  it('a batch slot that was not really answered is null (re-read), never an empty result', () => {
    expect(batchItems({ error: 'x' }, 2)).toEqual([null, null]);
    expect(batchItems([{ ok: true, body: { a: 1 } }], 2)).toEqual([null, null]);
    expect(batchItems([{ ok: true, body: 1 }, { ok: false, error: 'nope' }, { batchError: true }], 3))
      .toEqual([{ ok: true, body: 1, error: undefined }, { ok: false, body: undefined, error: 'nope' }, null]);
  });
});

// ── 2. pages ────────────────────────────────────────────────────────────
describe('pages — Lightning pages assigned to nobody', () => {
  const lpFrom = extractFunction('lightning-pages.js', 'lpOrgDefaultsFromDescribe');
  const pages = [{ Id: '0M0xx0000000001AAA', DeveloperName: 'Account_Page' }, { Id: '0M0xx0000000002AAA', DeveloperName: 'Other' }];
  const payloads = [
    { actionOverrides: [{ name: 'View', pageId: '0M0xx0000000001AAA', formFactor: 'Large' }] },       // this page is the default
    { actionOverrides: [{ name: 'View', pageId: '0m0xx0000000001' }] },                              // 15-char / case variant
    { actionOverrides: [{ name: 'View', pageId: '0M0xx0000000002AAA' }] },                           // a DIFFERENT page
    { actionOverrides: [{ name: 'Edit', pageId: '0M0xx0000000001AAA' }] },                           // not the View action
    { actionOverrides: [{ name: 'View', type: 'Standard' }] },                                        // no pageId
    { actionOverrides: [] },
  ];
  it('the port decides "is the org default" exactly as lightning-pages.js does, on the same payloads', () => {
    for (const p of payloads) {
      const mine = pageDescribe(p, '0M0xx0000000001AAA', 'Account_Page', pages);
      const theirs = lpFrom(p, '0M0xx0000000001AAA', 'Account_Page', pages);
      expect(mine.isDefault, JSON.stringify(p)).toBe(theirs.defaults.length > 0);
      expect(mine.answered).toBe(true);
    }
    // devName-hyphen fallback: the describe names the page by an id the list only knows by DeveloperName
    const fb = { actionOverrides: [{ name: 'View', pageId: '0M0xx0000000002AAA' }] };
    const list = [{ Id: '0M0xx0000000002AAA', DeveloperName: 'Short_Name' }];
    expect(pageDescribe(fb, 'zzz', 'Account-Short_Name', list).isDefault).toBe(lpFrom(fb, 'zzz', 'Account-Short_Name', list).defaults.length > 0);
  });
  it('a describe that errored or carried no actionOverrides did NOT answer', () => {
    expect(pageDescribe({ error: 'HTTP 500' }, 'x', 'y', [])).toMatchObject({ answered: false, isDefault: false, error: 'HTTP 500' });
    expect(pageDescribe({ fields: [] }, 'x', 'y', []).answered).toBe(false);
    expect(pageDescribe(null, 'x', 'y', []).answered).toBe(false);
  });
  it('a page is unassigned only when EVERY read answered and found none', () => {
    const ok = { metaOk: true, assignments: 0, needsProbe: true, probe: { answered: true, isDefault: false } };
    expect(pageState(ok).state).toBe('unassigned');
    expect(pageState({ ...ok, assignments: 2 }).state).toBe('assigned');
    expect(pageState({ ...ok, probe: { answered: true, isDefault: true } }).state).toBe('assigned');
    expect(pageState({ metaOk: true, assignments: 0, needsProbe: false }).state).toBe('unassigned');   // a Home page: no object to probe
    // the honest failure branches
    expect(pageState({ metaOk: false, metaError: 'HTTP 500' }).state).toBe('unread');
    expect(pageState({ ...ok, probe: { answered: false, isDefault: false, error: 'HTTP 500' } })).toMatchObject({ state: 'unread' });
    expect(pageState({ ...ok, probe: null }).state).toBe('unread');            // object could not be named / described
    expect(pageState({ ...ok, probe: null }).why).toContain('org-default was not looked up');
    // ...but a page already assigned needs no probe to be called assigned
    expect(pageState({ metaOk: true, assignments: 1, needsProbe: true, probe: null }).state).toBe('assigned');
  });
  it('verdict: unassigned listed (warn); unread never becomes an all-clear; all assigned → good', () => {
    const rows = [
      { label: 'Zed', type: 'RecordPage', object: 'Account', state: 'unassigned' },
      { label: 'Alpha', type: 'HomePage', object: '', managed: true, state: 'unassigned' },
      { label: 'Mid', type: 'AppPage', state: 'assigned' },
      { label: 'Broken', type: 'RecordPage', object: 'Foo__c', state: 'unread', why: 'its object could not be described' },
    ];
    const v = pagesVerdict(rows, 2);
    expect(v.tone).toBe('warn');
    expect(v.headline).toBe('2 Lightning page(s) are assigned to nobody; 1 more could not be checked');
    expect(v.lines[0]).toBe('Alpha (HomePage · from a package) — assigned to nobody');
    expect(v.lines[1]).toBe('Zed (RecordPage · Account) — assigned to nobody');
    expect(v.lines[2]).toContain('could not be checked: its object could not be described — NOT known to be assigned');
    expect(v.lines[3]).toContain('2 Flow / Login page(s) not judged');
    const unreadOnly = pagesVerdict([{ label: 'B', type: 'RecordPage', state: 'unread', why: 'x' }, { label: 'A', state: 'assigned' }], 0);
    expect(unreadOnly.tone).toBe('warn');
    expect(unreadOnly.headline).toContain('NOT an all-clear');
    expect(pagesVerdict([{ label: 'A', state: 'assigned' }], 0).tone).toBe('good');
  });
  it('the card ports the tool’s reads: FlexiPage list, batched metadata, entity names, cache-busted describes', () => {
    expect(SRC).toContain("id: 'pages'");
    expect(SRC).toContain('SELECT Id,DeveloperName,MasterLabel,Type,EntityDefinitionId,ManageableState FROM FlexiPage ORDER BY MasterLabel');
    expect(SRC).toContain('services/data/v62.0/tooling/sobjects/FlexiPage/${encodeURIComponent(p.Id)}');
    expect(SRC).toContain('SELECT DurableId, QualifiedApiName FROM EntityDefinition WHERE DurableId IN');
    expect(SRC).toContain('services/data/v62.0/sobjects/${encodeURIComponent(o)}/describe/?_=${bust}');
    expect(SRC).toContain("type: 'SF_COMPOSITE_BATCH'");
    expect(SRC).toContain("p.Type !== 'UtilityBar'");
    expect(SRC).toContain("const OH_PAGES_NOT_JUDGED = new Set(['FlowPage', 'LoginPage']);");
    expect(SRC).toContain("calls: () => '1 + 1 per 10 pages + 1 per 200 custom objects + 1 per 5 objects with record pages'");
    expect(SRC).toContain("fix: { label: 'Open Lightning Pages', popupTab: 'pages' }");
  });
});

// ── 3. picklists ────────────────────────────────────────────────────────
describe('picklists — drift between the open orgs', () => {
  const v = (status, label, extra) => ({ status, label, drifting: ['missing', 'values', 'rts'].includes(status), erroredIn: [], ...extra });
  const row = (field, verdict) => ({ field, label: field, verdict });
  it('fewer than 2 ring orgs: says so, reads nothing, warn', () => {
    for (const n of [0, 1]) {
      const r = picklistsVerdict({ obj: 'Account', ringCount: n });
      expect(r.tone).toBe('warn');
      expect(r.headline).toBe('Needs 2+ open orgs');
    }
  });
  it('a ring org that is not open is NAMED and the card is warn, never "in sync"', () => {
    const r = picklistsVerdict({ obj: 'Account', ringCount: 3, usable: 2,
      skipped: [{ label: 'Prod', skip: 'not open in a Chrome tab' }],
      rows: [row('Industry', v('sync', '✓ in sync'))] });
    expect(r.tone).toBe('warn');
    expect(r.headline).toContain('NOT an all-clear');
    expect(r.lines[0]).toBe('Prod — not open in a Chrome tab — NOT part of this check');
    const few = picklistsVerdict({ obj: 'Account', ringCount: 3, usable: 1, skipped: [{ label: 'A', skip: 'x' }, { label: 'B', skip: 'y' }] });
    expect(few.tone).toBe('warn');
    expect(few.headline).toContain('Only 1 of the 3 ring orgs');
  });
  it('drifting fields listed with their status label, missing before values before record types', () => {
    const r = picklistsVerdict({ obj: 'Account', ringCount: 2, usable: 2, skipped: [],
      rows: [row('B_rts', v('rts', 'RT assignment differs')), row('A_vals', v('values', 'values differ (2)')),
             row('C_missing', v('missing', 'field missing in 1 org(s)')), row('D_ok', v('sync', '✓ in sync'))] });
    expect(r.tone).toBe('warn');
    expect(r.headline).toBe('3 picklist(s) on Account drift between the 2 ring orgs read');
    expect(r.lines).toEqual(['C_missing (C_missing) — field missing in 1 org(s)', 'A_vals (A_vals) — values differ (2)', 'B_rts (B_rts) — RT assignment differs']);
  });
  it('good only when everything was read and compared; unread fields, capped fields and RT gaps stop it', () => {
    const base = { obj: 'Account', ringCount: 2, usable: 2, skipped: [] };
    expect(picklistsVerdict({ ...base, rows: [row('A', v('sync', '✓ in sync'))] }).tone).toBe('good');
    const err = picklistsVerdict({ ...base, rows: [row('A', v('sync', '✓ in sync')), row('B', v('error', 'could not read'))] });
    expect(err.tone).toBe('warn'); expect(err.lines.join('|')).toContain('NOT known to be in sync');
    expect(picklistsVerdict({ ...base, rows: [row('A', v('sync', 's'))], cappedNames: ['X'] }).tone).toBe('warn');
    expect(picklistsVerdict({ ...base, rows: [row('A', v('sync', 's'))], rtNotes: ['Dev — record types unavailable'] }).tone).toBe('warn');
    expect(picklistsVerdict({ ...base, rows: [row('A', v('sync', 's', { erroredIn: ['x'] }))] }).tone).toBe('warn');
    expect(picklistsVerdict({ ...base, rows: [row('A', v('notcomparable', 'shared'))] }).tone).toBe('warn');   // nothing actually compared
    expect(picklistsVerdict({ ...base, rows: [] }).tone).toBe('good');                                          // no picklists at all: the describes answered
  });
  it('uses the real pkFieldVerdict output shape end to end', () => {
    const { pkFieldVerdict } = extractFunctions('studio-picklists.js', ['pkFieldVerdict', 'pkRtDrift']);
    const inv = (k, names) => ({ orgKey: k, label: k, kind: 'local', values: names.map(n => ({ name: n, label: n, active: true })) });
    const drift = pkFieldVerdict([inv('a', ['X', 'Y']), inv('b', ['X'])], [[], []], 'Stage__c');
    const r = picklistsVerdict({ obj: 'Opp', ringCount: 2, usable: 2, skipped: [], rows: [row('Stage__c', drift)] });
    expect(r.tone).toBe('warn');
    expect(r.lines[0]).toBe('Stage__c (Stage__c) — values differ (1)');
  });
  it('the card reuses the sweep’s loaders (no copy), is ring-only, and points at the Picklist Manager', () => {
    expect(SRC).toContain("id: 'picklists'");
    expect(SRC).toContain("input: { label: 'Object', placeholder: 'Account', default: 'Account' }");
    for (const fn of ['_pkSweepOpenOrgs(ringUrls, obj)', '_pkSweepPickSource(usable)', '_pkSweepFieldUnion(usable, srcOrg)', '_pkLoadRtBundle(o.sess, obj)', '_pkSweepReadField(o, obj, f.name, rtBundles[o.orgKey])', 'pkFieldVerdict(perOrg, perRts, f.name)']) {
      expect(SRC, fn).toContain(fn);
    }
    expect(SRC).toContain("fix = { label: 'Open Picklist Manager', view: 'picklists' }");
    expect(SRC).toContain("ringFix = { label: 'Open the All open orgs page', view: 'ring' }");
    expect(SRC).toContain('const FIELD_CAP = 25;');
    const PK = rd('studio-picklists.js');
    // the sweep itself now runs on the same DOM-free functions
    const sweep = PK.slice(PK.indexOf('async function _pkSweepObject()'), PK.indexOf('function _pkSweepRowShellHtml'));
    for (const fn of ['_pkSweepOpenOrgs(_pkCmpOrgs, obj)', '_pkSweepPickSource(usable)', '_pkSweepFieldUnion(usable, srcOrg)', '_pkSweepReadField(o, obj, f.name, rtBundles[o.orgKey])']) {
      expect(sweep, fn).toContain(fn);
    }
    expect(sweep).not.toContain('_pkFetchInventory(');   // moved into _pkSweepReadField
  });
});

// ── 4. fields ───────────────────────────────────────────────────────────
describe('fields — custom fields with no data and no references', () => {
  const fld = (name, state, extra) => ({ name, label: name.replace('__c', ''), type: 'string', state, filled: 0, refs: 0, why: '', ...extra });
  it('0 filled AND 0 references → listed; filled or referenced → not', () => {
    const v = fieldsVerdict({ obj: 'Account', records: 500, custom: 5, hidden: 0, fields: [
      fld('Zed__c', 'unused'), fld('Old__c', 'unused', { type: 'picklist' }), fld('Used__c', 'filled', { filled: 9 }),
      fld('Ref__c', 'empty-referenced', { refs: 2 }), fld('F__c', 'skipped', { why: 'formula' })] });
    expect(v.tone).toBe('warn');
    expect(v.headline).toContain('2 custom field(s) on Account hold no data and have no reference in the dependency index');
    expect(v.headline).toContain('open Field Cleaner before deleting');
    expect(v.lines.slice(0, 2)).toEqual(['Old__c (Old, picklist) — never filled, nothing references it', 'Zed__c (Zed, string) — never filled, nothing references it']);
    expect(v.lines.join('|')).toContain('1 more field(s) hold no data but are referenced — not listed');
    expect(v.lines.join('|')).toContain('1 field(s) not judged');
  });
  it('an EMPTY object: says so and lists nothing as unused', () => {
    const v = fieldsVerdict({ obj: 'Thing__c', records: 0, custom: 4, hidden: 0, fields: [fld('A__c', 'unread'), fld('B__c', 'unread')] });
    expect(v.tone).toBe('warn');
    expect(v.headline).toBe('Thing__c has no records — every field is 0-filled, so none is listed as unused');
    expect(v.lines.join('|')).not.toContain('never filled');
  });
  it('a field whose count or references could not be read is "NOT known to be unused" — never an all-clear', () => {
    const v = fieldsVerdict({ obj: 'Account', records: 5, custom: 2, hidden: 0, fields: [fld('A__c', 'filled', { filled: 1 }), fld('B__c', 'unread', { why: 'its references could not be read — boom' })] });
    expect(v.tone).toBe('warn');
    expect(v.headline).toContain('NOT an all-clear');
    expect(v.lines[0]).toBe('B__c — could not be checked: its references could not be read — boom — NOT known to be unused');
    const hid = fieldsVerdict({ obj: 'Account', records: 5, custom: 1, hidden: 2, fields: [fld('A__c', 'filled', { filled: 1 })] });
    expect(hid.tone).toBe('warn');
    expect(hid.lines.join('|')).toContain('2 custom field(s) exist in the org but the describe does not list them');
  });
  it('all judged fields filled or referenced → good; no custom fields → good', () => {
    const g = fieldsVerdict({ obj: 'Account', records: 5, custom: 2, hidden: 0, fields: [fld('A__c', 'filled', { filled: 1 }), fld('B__c', 'empty-referenced', { refs: 1 })] });
    expect(g.tone).toBe('good');
    expect(g.headline).toBe('Every one of the 2 custom field(s) judged on Account holds data or is referenced');
    expect(fieldsVerdict({ obj: 'Account', records: 5, custom: 0, hidden: 0, fields: [] }).tone).toBe('good');
  });
  it('which fields can be counted: formula, auto-number, checkbox, long text, non-filterable are skipped', () => {
    expect(countable({ name: 'A__c', type: 'string', filterable: true, aggregatable: true })).toBe('');
    expect(countable({ type: 'string', calculated: true })).toBe('formula');
    expect(countable({ type: 'string', autoNumber: true })).toBe('auto-number');
    expect(countable({ type: 'boolean' })).toBe('checkbox (never empty)');
    expect(countable({ type: 'textarea', filterable: false })).toBe('not filterable');
    expect(countable({ type: 'textarea', filterable: true })).toBe('textarea field');
    expect(countable({ type: 'string', aggregatable: false })).toBe('not aggregatable');
    expect(countable({ type: 'double', compoundFieldName: 'Loc__c' })).toBe('part of a compound field');
  });
  it('queries: aliased COUNT per field; the dependency index cap is 2,000 rows', () => {
    expect(fillQuery('Account', ['A__c', 'B__c'])).toBe('SELECT COUNT(A__c) c0, COUNT(B__c) c1 FROM Account');
    expect(looksCapped(2000)).toBe(true);
    expect(looksCapped(4000)).toBe(true);
    expect(looksCapped(37)).toBe(false);
    expect(looksCapped(0)).toBe(false);
  });
  it('the card reads what the brief says, in the chunk sizes it says', () => {
    expect(SRC).toContain("id: 'fields'");
    expect(SRC).toContain("calls: () => '3 + 1 per 50 custom fields + 1 per 100 empty fields'");
    expect(SRC).toContain('SELECT Id, DeveloperName, NamespacePrefix, TableEnumOrId FROM CustomField WHERE EntityDefinition.QualifiedApiName = ${soqlStrLit(obj)}');
    expect(SRC).toContain('services/data/v62.0/sobjects/${obj}/describe');
    expect(SRC).toContain('SELECT COUNT() FROM ${obj}');
    expect(SRC).toContain('i += 50) await _ohCountFilled(');
    expect(SRC).toContain('i += 100) {');
    expect(SRC).toContain('SELECT MetadataComponentName, MetadataComponentType, RefMetadataComponentId FROM MetadataComponentDependency WHERE RefMetadataComponentId IN (');
    expect(SRC).toContain("fix = { label: 'Open Field Cleaner', popupTab: 'fields' }");
    expect(SRC).toContain("input: { label: 'Object', placeholder: 'Account', default: 'Account' }");
    // an empty object returns BEFORE any fill count is paid for
    const run = SRC.slice(SRC.indexOf("id: 'fields'"));
    expect(run.indexOf('if (records === 0) return')).toBeGreaterThan(0);
    expect(run.indexOf('if (records === 0) return')).toBeLessThan(run.indexOf('_ohCountFilled(sess'));
  });
});

// ── the frame contract for all four ─────────────────────────────────────
describe('all four cards follow the card contract', () => {
  it('each is in OH_CARDS with an estimate, a fix and a throw on a failed read', () => {
    for (const id of ['apiver', 'pages', 'picklists', 'fields']) {
      const from = SRC.indexOf(`id: '${id}'`);
      expect(from, id).toBeGreaterThan(0);
      const body = SRC.slice(from, SRC.indexOf('\n  },', from));
      expect(body, id).toMatch(/calls: \(\) =>/);
      expect(body, id).toMatch(/fix(: \{|\s*=\s*\{)/);
      expect(body, id).toContain('throw new Error(');
      // reads: through sendBg in run — the picklists card through the sweep's own loaders (which use sendBg)
      expect(body, id).toContain(id === 'picklists' ? '_pkSweepOpenOrgs(' : 'sendBg(');
    }
  });
  it('the pure verdicts read nothing themselves', () => {
    for (const n of ['sftkOhApiVerVerdict', 'sftkOhPagesVerdict', 'sftkOhPicklistsVerdict', 'sftkOhFieldsVerdict', 'sftkOhPageState', 'sftkOhPageDescribeVerdict']) {
      const from = SRC.indexOf(`function ${n}(`);
      const fn = SRC.slice(from, SRC.indexOf('\n}', from));
      expect(fn, n).not.toContain('sendBg');
      expect(fn, n).not.toContain('chrome.');
    }
  });
});
