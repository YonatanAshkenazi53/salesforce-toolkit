// 2026-11-15 — the SECOND review of the uncommitted regress-1115 fixes: what it found, each proven by RUNNING the
// real function (sliced out of its file the way the other regress-1115 files do). Where a behaviour lives inside
// runReconcile (a ~1,500-line function bound to the page) the pure helper it now calls is run, and the wiring is
// pinned as text next to it.
//   A. sweep: a create quick action's <targetObject>, a cross-object field update, code paths that are no
//      relationship, $Source, and the Task / Event / Activity family for a custom field
//   B. sftkMdEditField FieldSet: the object's own field set goes through the shared resolver (Parent.X)
//   C. sftkNetworkWords: the browser's two-token error is said once
//   D. Apex Debugger: a level name that cannot be read never overwrites the stored taken-over record
//   E. API versions: a short (incomplete) re-read at Apply time refuses the org
//   F. Org Health: "the org's own page" in a namespaced org
//   G. Deploy page: a BUSY refusal, an engine leg with no answer, the dry-run verdict, the network stop, the
//      parents-first row
//   H. worker: a page-side create states its own duplicate-rule choice; a call that was sent twice is never
//      reported as "refused before saving anything"
//   I. sequences: a fallback owner of another org is not sent to the sequence's target
//   J. Toolkit topbar: with a tool open the action row fits the window at every width from 780 px
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const NL = String.fromCharCode(10);

// ── A · sweep ────────────────────────────────────────────────────────────────────────────────────────────────
const S = extractFunctions('sftk-sweep.js', ['sftkSweepForms', 'sftkSweepHits', 'sftkSweepKindTable', 'sftkSweepSections', '_sftkSweepSectionAt',
  'sftkSweepKind', 'sftkSweepRun', 'sftkSweepJoinKind']);
const sweepHits = (obj, field, files) => S.sftkSweepRun(new Map(files.map(([p, ...lines]) => [p, lines.join(NL)])), S.sftkSweepForms(obj, field))
  .hits.map(h => ({ component: h.component, line: h.line, type: h.type, sev: h.sev, join: S.sftkSweepJoinKind(h.type), section: h.section }));
const one = (obj, field, file) => { const h = sweepHits(obj, field, [file]); expect(h.length).toBe(1); return h[0]; };
const vr = (name, formula) => ['<validationRules>', `<fullName>${name}</fullName>`, '<active>true</active>', `<errorConditionFormula>${formula}</errorConditionFormula>`, '</validationRules>'];
const DEMOTED = { type: 'SameNameOtherObject', sev: 'mention', join: null };

describe('A1. sweep: a create quick action names the fields of its <targetObject>', () => {
  const qa = (name, target) => [`unpackaged/quickActions/${name}.quickAction`, '<QuickAction>', '<fieldOverrides>', '<field>Status__c</field>', '<literalValue>New</literalValue>', '</fieldOverrides>',
    ...(target ? [`<targetObject>${target}</targetObject>`] : []), '<type>Create</type>', '</QuickAction>'];
  it('the reported case: Contact.New_Account with targetObject Account is Account’s, and joins', () => {
    expect(one('Account', 'Status__c', qa('Contact.New_Account', 'Account'))).toMatchObject({ type: 'QuickAction', join: 'QuickAction' });
  });
  it('the mirror: Account.New_Contact with targetObject Contact holds Contact’s field — not Account’s', () => {
    const h = one('Account', 'Status__c', qa('Account.New_Contact', 'Contact'));
    expect(h).toMatchObject(DEMOTED);
    expect(h.section).toBe('Contact’s own field of this name');
  });
  it('no targetObject: the name prefix still decides (an update action on its own object)', () => {
    expect(one('Account', 'Status__c', qa('Contact.Edit_It', null))).toMatchObject(DEMOTED);
    expect(one('Account', 'Status__c', qa('Account.Edit_It', null)).type).toBe('QuickAction');
  });
});

describe('A2. sweep: a cross-object field update writes the parent’s field by its bare name', () => {
  const wf = (obj, target) => [`unpackaged/workflows/${obj}.workflow`, '<Workflow>', '<fieldUpdates>', '<fullName>Set_Parent</fullName>', '<field>Status__c</field>', '<literalValue>x</literalValue>',
    ...(target ? [`<targetObject>${target}</targetObject>`] : []), '</fieldUpdates>', '</Workflow>'];
  it('the reported case: Contact’s update with targetObject AccountId is a blocker of Account.Status__c that joins', () => {
    expect(one('Account', 'Status__c', wf('Contact', 'AccountId'))).toMatchObject({ type: 'WorkflowFieldUpdate', sev: 'blocker', join: 'WorkflowFieldUpdate' });
  });
  it('a custom master-detail (Parent__c) cannot be told here: kept, never demoted as Contact’s own', () => {
    expect(one('Account', 'Status__c', wf('Contact', 'Parent__c')).type).toBe('WorkflowFieldUpdate');
  });
  it('a target that leads to ANOTHER object (OwnerId → User), or no target at all, is still not Account’s', () => {
    expect(one('Account', 'Status__c', wf('Contact', 'OwnerId'))).toMatchObject(DEMOTED);
    expect(one('Account', 'Status__c', wf('Contact', null))).toMatchObject(DEMOTED);
    expect(one('User', 'Status__c', wf('Contact', 'OwnerId')).type).toBe('WorkflowFieldUpdate');
  });
});

describe('A3. sweep: a variable, `this`, `.fields.` and $Source are no relationship to our object', () => {
  it('this.con.Status__c in Contact-only Apex is demoted again', () => {
    expect(one('Account', 'Status__c', ['unpackaged/classes/C1.cls', "public class C1 { Contact con; void f(){ this.con.Status__c = 'a'; } }"])).toMatchObject(DEMOTED);
  });
  it('the LWC wire shape this.rec.fields.Status__c.value beside a Contact schema import: both lines demoted', () => {
    const h = sweepHits('Account', 'Status__c', [['unpackaged/lwc/c/c.js', "import S from '@salesforce/schema/Contact.Status__c';", 'export default class C { get v(){ return this.rec.fields.Status__c.value; } }']]);
    expect(h.map(x => x.type)).toEqual(['SameNameOtherObject', 'SameNameOtherObject']);
  });
  it('a Contact lookup filter’s $Source.Status__c is Contact’s own field', () => {
    const f = ['unpackaged/objects/Contact.object', '<CustomObject>', '<fields>', '<fullName>L__c</fullName>', '<lookupFilter>', '<filterItems>', '<field>Contact.Type__c</field>', '<operation>equals</operation>',
      '<valueField>$Source.Status__c</valueField>', '</filterItems>', '</lookupFilter>', '</fields>', '</CustomObject>'];
    expect(one('Account', 'Status__c', f)).toMatchObject(DEMOTED);
  });
  it('what the first fix was for still holds: a __r path, a capitalised hop after the variable, a dynamic name', () => {
    const code = (n, body) => [`unpackaged/classes/${n}.cls`, `public class ${n} { void f(Contact c, SObject s){ ${body} } }`];
    expect(one('Account', 'Status__c', code('P', 'String x = c.Parent_Link__r.Owner_Link__r.Status__c;')).type).toBe('ApexClass');
    expect(one('Account', 'Status__c', code('Q', 'String x = this.c.Parent_Link__r.Status__c;')).type).toBe('ApexClass');
    expect(one('User', 'Status__c', code('O', 'String x = c.Owner.Status__c;')).type).toBe('ApexClass');
    expect(one('Account', 'Status__c', code('H', "s.put('Status__c', 1);")).type).toBe('ApexClass');
    // …and a relationship path in another object's formula is still kept
    expect(one('Account', 'Status__c', ['unpackaged/objects/Contact.object', '<CustomObject>', ...vr('R', 'ISBLANK($Source.Parent_Account__r.Status__c)'), '</CustomObject>']).type).toBe('ValidationRule');
  });
});

describe('A4. sweep: a custom field picked on Task, Event or Activity is one field of the family', () => {
  const files = [
    ['unpackaged/objects/Event.object', '<CustomObject>', ...vr('Need_Region', 'ISBLANK(Region__c)'), '</CustomObject>'],
    ['unpackaged/objects/Activity.object', '<CustomObject>', '<fields>', '<fullName>Calc__c</fullName>', '<formula>Region__c &amp; "x"</formula>', '</fields>', '</CustomObject>'],
    ['unpackaged/classes/E.cls', "public class E { void f(Event e){ e.Region__c='a'; } }"],
  ];
  it('the reported case: Task picked — the Event rule, the Activity formula and Event code keep their kind', () => {
    const by = Object.fromEntries(sweepHits('Task', 'Region__c', files).map(h => [h.component, h]));
    expect(by['Event.Need_Region']).toMatchObject({ type: 'ValidationRule', sev: 'blocker' });
    expect(by['Activity.Calc__c'].type).toBe('CustomField');
    expect(by.E).toMatchObject({ type: 'ApexClass', sev: 'blocker' });
  });
  it('Event picked reads the same; a STANDARD field (Task.Subject and Event.Subject are two fields) does not', () => {
    expect(sweepHits('Event', 'Region__c', [files[2]])[0].type).toBe('ApexClass');
    const std = sweepHits('Task', 'Subject', [['unpackaged/objects/Event.object', '<CustomObject>', ...vr('Need_Subject', 'ISBLANK(Subject)'), '</CustomObject>']]);
    expect(std[0]).toMatchObject(DEMOTED);
  });
  it('another object’s same-named field is still demoted with Task picked', () => {
    expect(one('Task', 'Region__c', ['unpackaged/objects/Contact.object', '<CustomObject>', ...vr('C_Region', 'ISBLANK(Region__c)'), '</CustomObject>'])).toMatchObject(DEMOTED);
  });
});

// ── B · the object's own field set ───────────────────────────────────────────────────────────────────────────
const M = extractFunctions('sftk-mdapi.js', ['sftkMdEditField', 'sftkFormulaDropField', 'sftkMdEditWays', '_sftkMdFieldIs', '_sftkMdRenameVal', '_sftkMdWalk',
  '_sftkMdSwapToken', '_sftkMdHasLogic', 'sftkMdFindElement', 'sftkMdUnescape', 'sftkMdEscape', 'sftkMdChildText', 'sftkMdChildren', 'sftkMdLeadMappingRemove',
  'sftkMdLeadMappingsFor', 'sftkMdValuesHolding', 'sftkMdMentionsField']);
describe('B. FieldSet of the picked object itself: a self-lookup entry is this field too', () => {
  const row = (f, tag = 'displayedFields') => `<${tag}><field>${f}</field><isFieldManaged>false</isFieldManaged><isRequired>false</isRequired></${tag}>`;
  const fs = (...rows) => `<fullName>Account.FS</fullName><description>d</description>${rows.join('')}<label>FS</label>`;
  it('the reported case: ✂ takes Parent.Region__c out with the bare entry — nothing of the field is left behind', () => {
    const r = M.sftkMdEditField('FieldSet', fs(row('Parent.Region__c'), row('Region__c'), row('Name')), 'Account', 'Region__c', null);
    expect(r.refused).toBeNull();
    expect(r.changed).toBe(true);
    expect(r.xml).not.toMatch(/Region__c/);
    expect(r.xml).toContain('<field>Name</field>');
  });
  it('⇄ renames it in its own spelling', () => {
    const r = M.sftkMdEditField('FieldSet', fs(row('Parent.Region__c'), row('Region__c')), 'Account', 'Region__c', 'Area__c');
    expect(r.xml).toContain('<field>Parent.Area__c</field>');
    expect(r.xml).toContain('<field>Area__c</field>');
    expect(r.xml).not.toMatch(/Region__c/);
  });
  it('a path to ANOTHER object (Owner.) stays; a custom lookup cannot be told and refuses the edit as unsure', () => {
    const keep = M.sftkMdEditField('FieldSet', fs(row('Owner.Region__c'), row('Region__c')), 'Account', 'Region__c', null);
    expect(keep.xml).toContain('<field>Owner.Region__c</field>');
    expect(keep.xml).not.toContain('<field>Region__c</field>');
    const before = fs(row('Other__r.Region__c'), row('Region__c'));
    const unsure = M.sftkMdEditField('FieldSet', before, 'Account', 'Region__c', null);
    expect(unsure.refused).toMatch(/custom lookup/);
    expect(unsure.changed).toBeFalsy();
  });
});

// ── C · the dropped connection is said once ──────────────────────────────────────────────────────────────────
describe('C. sftkNetworkWords', () => {
  const { sftkNetworkWords } = new Function(`${read('sftk-friendly-error.js')}\nreturn { sftkNetworkWords };`)();
  const W = 'the connection to Salesforce dropped';
  it('the reported case: "TypeError: Failed to fetch (net::ERR_NAME_NOT_RESOLVED)" reads the sentence once', () => {
    expect(sftkNetworkWords('TypeError: Failed to fetch (net::ERR_NAME_NOT_RESOLVED)')).toBe(W);
    expect(sftkNetworkWords('Account: Failed to fetch (net::ERR_INTERNET_DISCONNECTED)')).toBe(`Account: ${W}`);
  });
  it('one token, and two separate errors on one line, are unchanged', () => {
    expect(sftkNetworkWords('net::ERR_CONNECTION_RESET')).toBe(W);
    expect(sftkNetworkWords('A: Failed to fetch; B: Failed to fetch')).toBe(`A: ${W}; B: ${W}`);
    expect(sftkNetworkWords('HTTP 400: bad field')).toBe('HTTP 400: bad field');
  });
});

// ── D · Apex Debugger ────────────────────────────────────────────────────────────────────────────────────────
// The harness of test/regress-1115-flows-debug-health.test.mjs: the real apex-debugger.js + sftk-write.js in a vm.
const EL_IDS = ['adbgStartBtn', 'adbgStopBtn', 'adbgStatusCell', 'adbgLogCount'];
function loadDebugger(handler, store) {
  const sent = [], history = [], els = {};
  const el = id => (els[id] = els[id] || { id, style: {}, dataset: {}, innerHTML: '', textContent: '', title: '', disabled: false, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } });
  const ctx = {
    console, Date, Math, JSON, Promise, Map, Set, Array, Object, String, Number, RegExp, Error,
    setInterval: () => ({}), clearInterval: () => {}, setTimeout: fn => { fn(); return 0; }, clearTimeout: () => {},
    document: { getElementById: id => (EL_IDS.includes(id) ? el(id) : null), querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {},
      createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }) },
    chrome: { runtime: { sendMessage: (msg, cb) => { sent.push(msg); Promise.resolve(handler(msg)).then(cb); }, lastError: null },
      storage: { local: { get: async k => ({ [k]: store[k] === undefined ? undefined : JSON.parse(JSON.stringify(store[k])) }),
        set: async o => { for (const k of Object.keys(o)) store[k] = JSON.parse(JSON.stringify(o[k])); } } } },
    sftkHistoryBegin: o => ({ title: o.title, notes: [] }), sftkHistoryNote: (j, r) => { j.notes.push(r); },
    sftkHistoryEnd: async (j, o) => { history.push({ title: j.title, undo: o && o.undo }); },
    sftkFriendlyError: m => ({ message: String(m), hint: '', raw: String(m) }),
    sftkOrgKey: u => String(u || '').replace(/^https?:\/\//, '').replace(/\..*$/, '').toLowerCase(),
    sftkCatSm: t => String(t), sftkOrgWriteGate: async () => ({ production: false }), sftkConfirmDestructive: async () => true, alert: () => {},
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('sftk-write.js'), ctx);
  vm.runInContext(read('apex-debugger.js') + '\n;globalThis.ApexDebugger = ApexDebugger;', ctx);
  const T = ctx.ApexDebugger._test;
  T.setSession('https://a.my.salesforce.com', 'sid');
  T.setUser({ Id: '005000000000001', Name: 'Integration User', Username: 'int@example.com' });
  return { T, sent, history };
}
function fakeTraceOrg() {
  const org = { flags: { '7tfX': { DebugLevelId: '7dlFOREIGN', StartDate: '2026-11-15T08:00:00.000+0000', ExpirationDate: '2099-01-01T00:00:00.000+0000' } },
    levels: { '7dlFOREIGN': 'Integration_Finest' }, n: 0, levelNameFails: 0, levelNameEmpty: 0 };
  org.handler = msg => {
    const q = msg.query || '';
    let m;
    if (msg.type === 'SF_QUERY' && (m = /FROM DebugLevel WHERE DeveloperName='([^']+)'/.exec(q))) {
      const id = Object.keys(org.levels).find(k => org.levels[k] === m[1]);
      return { records: id ? [{ Id: id }] : [] };
    }
    if (msg.type === 'SF_QUERY' && (m = /SELECT DeveloperName FROM DebugLevel WHERE Id = '([^']+)'/.exec(q))) {
      if (org.levelNameFails > 0) { org.levelNameFails--; return { error: 'HTTP 503' }; }
      if (org.levelNameEmpty > 0) { org.levelNameEmpty--; return { records: [] }; }
      return { records: org.levels[m[1]] ? [{ DeveloperName: org.levels[m[1]] }] : [] };
    }
    if (msg.type === 'SF_QUERY' && /FROM TraceFlag WHERE TracedEntityId=/.test(q)) { const id = Object.keys(org.flags)[0]; return { records: id ? [{ Id: id, ...org.flags[id] }] : [] }; }
    if (msg.type === 'SF_QUERY' && (m = /FROM TraceFlag WHERE Id = '([^']+)'/.exec(q))) return { records: org.flags[m[1]] ? [{ Id: m[1], ...org.flags[m[1]] }] : [] };
    if (msg.type === 'SF_REST_POST' && /sobjects\/DebugLevel$/.test(msg.path)) { const id = `7dlNEW${++org.n}`; org.levels[id] = msg.body.DeveloperName; return { id, success: true }; }
    if (msg.type === 'SF_PATCH' && (m = /sobjects\/TraceFlag\/(\w+)$/.exec(msg.path))) { if (!org.flags[m[1]]) return { error: 'NOT_FOUND' }; Object.assign(org.flags[m[1]], msg.body); return { success: true }; }
    if (msg.type === 'SF_TOOLING_DELETE' && msg.sobject === 'TraceFlag') { delete org.flags[msg.id]; return { success: true }; }
    return { error: `unexpected ${msg.type} ${q || msg.path || ''}` };
  };
  return org;
}
describe('D. a level name that cannot be read never replaces the stored taken-over record', () => {
  const FOREIGN = { DebugLevelId: '7dlFOREIGN', StartDate: '2026-11-15T08:00:00.000+0000', ExpirationDate: '2099-01-01T00:00:00.000+0000' };
  const secondStart = async (prepare) => {
    const org = fakeTraceOrg(), store = {};
    const first = loadDebugger(org.handler, store);
    await first.T.startTrace();
    expect(Object.values(store.adbg_tf_prior)).toEqual([FOREIGN]);
    // the popup was reopened; the flag now sits on ANOTHER Toolkit level than the one this Start uses
    org.levels['7dlOTHER'] = 'SFTK_C_123';
    org.flags['7tfX'].DebugLevelId = '7dlOTHER';
    prepare(org);
    const second = loadDebugger(org.handler, store);
    await second.T.startTrace();
    return { org, store, second };
  };
  it('the reported case: Start, reopen, the level read errors, Start, Stop — the flag is back on the colleague’s level', async () => {
    const { org, store, second } = await secondStart(o => { o.levelNameFails = 1; });
    expect(second.T.trace().prior).toEqual(FOREIGN);
    expect(Object.values(store.adbg_tf_prior)).toEqual([FOREIGN]);                 // not overwritten with the Toolkit's values
    expect(second.history[0].undo.steps[0].msg.body).toEqual(FOREIGN);
    await second.T.stopTrace();
    expect(second.sent.some(m => m.type === 'SF_TOOLING_DELETE')).toBe(false);
    expect(org.flags['7tfX']).toEqual(FOREIGN);
  });
  it('a level read that answers no row is the same: the stored record wins', async () => {
    const { second, store } = await secondStart(o => { o.levelNameEmpty = 1; });
    expect(second.T.trace().prior).toEqual(FOREIGN);
    expect(Object.values(store.adbg_tf_prior)).toEqual([FOREIGN]);
  });
  it('a level that IS read and is not a Toolkit level replaces the record (the colleague changed the flag since)', async () => {
    const { second } = await secondStart(o => { o.levels['7dlNEWFOREIGN'] = 'Their_New_Level'; o.flags['7tfX'].DebugLevelId = '7dlNEWFOREIGN'; });
    expect(second.T.trace().prior.DebugLevelId).toBe('7dlNEWFOREIGN');
  });
  it('with no stored record an unreadable level still counts as foreign (restoring is the safe direction)', async () => {
    const org = fakeTraceOrg(), store = {};
    org.levelNameFails = 1;
    const d = loadDebugger(org.handler, store);
    await d.T.startTrace();
    expect(d.T.trace().prior).toEqual(FOREIGN);
  });
});

// ── E · API versions: the Apply-time re-read ─────────────────────────────────────────────────────────────────
const AV = extractFunctions('sftk-apiver.js', ['sftkApiVerNum', 'sftkApiVerLag', 'sftkFlowVerRows', 'sftkFlowGoverningVer', 'sftkFlowVerMatrix', 'sftkApiVerPlan', 'sftkFlowIsLocked', 'sftkApiVerSelectable', 'sftkApiVerApplyCheck']);
describe('E. a short re-read of the flows’ versions refuses the org', () => {
  const DEF = '300x00000000001AAA';
  const run = async (answer) => {
    const versions = [{ Id: '301v3', n: 3, Status: 'Active', api: '58.0' }];
    const sent = [];
    const rows = () => versions.map(v => ({ Id: v.Id, VersionNumber: v.n, Status: v.Status, ApiVersion: v.api, DefinitionId: DEF, Definition: { DeveloperName: 'Route' }, MasterLabel: 'Route' }));
    const depBg = async msg => {
      sent.push(msg);
      if (msg.type === 'SF_COMPOSITE_BATCH') return msg.subrequests.map(() => ({ ok: true, status: 200, body: { Id: '301v3', FullName: 'Route', Status: 'Active', VersionNumber: 3, DefinitionId: DEF, Metadata: { apiVersion: 58, label: 'Route' } } }));
      if (msg.type === 'SF_QUERY_ALL' && /FROM Flow WHERE DefinitionId IN/.test(msg.query)) return answer(rows());
      if (msg.type === 'SF_METADATA_DEPLOY') return { success: true };
      return { error: `unexpected ${msg.type}` };
    };
    const DEP = read('dependency-map.js');
    const start = DEP.indexOf('async function avVerifyAndActivate(');
    const body = DEP.slice(start, DEP.indexOf('function buildReportObject(', start));
    const log = { innerHTML: '', scrollTop: 0, scrollHeight: 0 };
    const ctx = { console, Date, Math, JSON, Promise, Map, Set, Array, Object, String, Number, RegExp, Error, TextEncoder,
      depBg, depFlowVersions: async () => ({ records: rows() }), avOrgMax: async () => ({ version: '62.0' }),
      sftkBuildStoredZip: files => files.map(f => f.name).join(','),
      sftkHistoryBegin: o => ({ title: o.title, notes: [] }), sftkHistoryNote: () => {}, sftkHistoryEnd: async () => {}, escHtml: s => String(s),
      _avState: { orgs: [{ key: 'a', label: 'A', orgUrl: 'https://a.my.salesforce.com', sid: 'sid', maxVersion: '62.0' }] } };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of ['sftk-apiver.js', 'sftk-flow-xml.js', 'sftk-write.js']) vm.runInContext(read(f), ctx);
    vm.runInContext(`${body}\n;globalThis.applyApiVerChange = applyApiVerChange;`, ctx);
    const ORGS = [{ key: 'a', label: 'A', maxVersion: '62.0' }];
    const m = AV.sftkFlowVerMatrix(ORGS, { a: AV.sftkFlowVerRows(rows()) });
    const plans = [{ apiName: 'Route', plan: AV.sftkApiVerPlan('62.0', ORGS, m[0].cells) }];
    await ctx.applyApiVerChange({ querySelector: sel => (sel === '#depAvApplyOut' ? { innerHTML: '', querySelector: () => log } : { textContent: '' }) }, plans, '62.0');
    return { sent, log: log.innerHTML };
  };
  it('the reported case: the Draft’s row was lost on the way (incomplete 1 of 2) — nothing is deployed', async () => {
    const r = await run(rows => ({ records: rows, incomplete: { expected: 2, got: 1 } }));
    expect(r.sent.some(m => m.type === 'SF_METADATA_DEPLOY')).toBe(false);
    expect(r.log).toMatch(/could not be re-read \(the read came back incomplete \(1 of 2 rows\)\)/);
    expect(r.log).toMatch(/nothing changed here/);
  });
  it('a complete read of an unchanged org still deploys', async () => {
    const r = await run(rows => ({ records: rows }));
    expect(r.sent.some(m => m.type === 'SF_METADATA_DEPLOY')).toBe(true);
  });
});

// ── F · Org Health ───────────────────────────────────────────────────────────────────────────────────────────
describe('F. Org Health: the org’s own page of the same name, in a namespaced org', () => {
  const OH = extractFunctions('studio-orghealth.js', ['sftkOhAppCount', 'sftkOhPageIsPackaged', 'sftkOhLocalSameName']);
  const own = { DeveloperName: 'X', NamespacePrefix: 'myns', ManageableState: 'unmanaged' };
  const pkg = { DeveloperName: 'X', NamespacePrefix: 'pkg', ManageableState: 'installed' };
  const count = (pages, page, names) => OH.sftkOhAppCount({ names }, page.DeveloperName, page.NamespacePrefix, OH.sftkOhLocalSameName(pages, page));
  it('the reported case: an app names the own page bare ("x") — the packaged pkg__X does not borrow it', () => {
    expect(OH.sftkOhLocalSameName([own, pkg], pkg)).toBe(true);
    expect(count([own, pkg], pkg, ['x'])).toBe(0);
    expect(count([own, pkg], own, ['x'])).toBe(1);                 // the own page, written without its prefix
    expect(count([own, pkg], pkg, ['pkg__x'])).toBe(1);            // by its full name it is assigned
  });
  it('a page is packaged only with a prefix AND an installed state (the Lightning Pages rule)', () => {
    expect(OH.sftkOhPageIsPackaged(pkg)).toBe(true);
    expect(OH.sftkOhPageIsPackaged({ ...pkg, ManageableState: 'installedEditable' })).toBe(true);
    expect(OH.sftkOhPageIsPackaged(own)).toBe(false);
    expect(OH.sftkOhPageIsPackaged({ DeveloperName: 'X', NamespacePrefix: null, ManageableState: 'unmanaged' })).toBe(false);
  });
  it('with no own page of that name the packaged page may still be named bare; an org without a namespace is unchanged', () => {
    expect(count([pkg], pkg, ['x'])).toBe(1);
    const plain = { DeveloperName: 'X', NamespacePrefix: null, ManageableState: 'unmanaged' };
    expect(OH.sftkOhLocalSameName([plain, pkg], pkg)).toBe(true);
    expect(count([plain, pkg], plain, ['pkg__x'])).toBe(0);
    expect(count([plain, pkg], plain, ['x'])).toBe(1);
  });
  it('the card asks the same question of every page it read', () => {
    const src = read('studio-orghealth.js');
    expect(src).toContain('x.page.NamespacePrefix, sftkOhLocalSameName(allPages, x.page))');
    expect(src).not.toContain('ownNames');
  });
});

// ── G · the Deploy page ──────────────────────────────────────────────────────────────────────────────────────
new Function(`${read('sftk-friendly-error.js')}`)();   // sftkFriendlyError / sftkIsNetworkError on globalThis, as the page has them
const R = extractFunctions('studio-reconcile.js', ['sftkRecLegAnswer', 'sftkRecRunTouched', 'sftkRecNetLegs', 'sftkProbeCallBroke', 'sftkRunEndLine', 'sftkProbeVerdict',
  'sftkParentStepState', 'sftkRunLineIsError']);
const REC = read('studio-reconcile.js');
const RUN = REC.slice(REC.indexOf('async function runReconcile('), REC.indexOf('\n}\n', REC.indexOf('// ── 5. Save to History so the run is visible later')));
const BUSY_ANSWER = { error: 'Another Data Studio run is already in progress.', busy: true, status: 'failed', summary: {}, errors: ['Another Data Studio run is already in progress.'] };

describe('G1. an engine leg refused BUSY is not a run that inserted 0', () => {
  it('the engine’s refusal (summary {}) is "busy"; no answer at all is "none"; a run that answered is "ok"', () => {
    expect(R.sftkRecLegAnswer(BUSY_ANSWER)).toBe('busy');
    expect(R.sftkRecLegAnswer({ error: 'No response' })).toBe('none');
    expect(R.sftkRecLegAnswer(undefined)).toBe('none');
    expect(R.sftkRecLegAnswer({ status: 'failed', error: 'x', summary: { Account: { failed: 2 } }, errors: [] })).toBe('ok');
    expect(R.sftkRecLegAnswer({ status: 'success', summary: {} })).toBe('ok');
  });
  it('a run that did nothing before the refused leg leaves no History entry; one that already wrote keeps it', () => {
    const zero = { inserted: 0, updated: 0, deleted: 0, purged: 0, pulled: 0, updatedSource: 0, insertedFailed: 0, deletedFailed: 0 };
    expect(R.sftkRecRunTouched(zero, {}, [], R.sftkRunLineIsError)).toBe(false);
    expect(R.sftkRecRunTouched(zero, {}, ['⚠ Contact: child-first ignored — the link is a master-detail relationship'], R.sftkRunLineIsError)).toBe(false);
    expect(R.sftkRecRunTouched({ ...zero, deleted: 3 }, {}, [], R.sftkRunLineIsError)).toBe(true);
    expect(R.sftkRecRunTouched({ ...zero, pulled: 1 }, {}, [], R.sftkRunLineIsError)).toBe(true);
    expect(R.sftkRecRunTouched(zero, { Contact: { created: 0, deleted: 2 } }, [], R.sftkRunLineIsError)).toBe(true);
    expect(R.sftkRecRunTouched(zero, {}, ['Delete failed: HTTP 500'], R.sftkRunLineIsError)).toBe(true);   // may have deleted
  });
  it('runReconcile: all three engine legs go through legCheck, and no leg tests "error && !summary" on its own any more', () => {
    const legs = RUN.split("type: 'SF_EXECUTE_PROFILE_TRANSFER'").slice(1);
    expect(legs.length).toBe(3);
    for (const leg of legs) expect(leg.slice(0, leg.indexOf('const s')).includes('legCheck(res);')).toBe(true);
    expect(RUN).not.toContain('res.error && !res.summary');
    expect(RUN).toMatch(/if \(a === 'busy'\) \{ busyLine = [^\n]+ throw Object\.assign\(new Error\(busyLine\), \{ sftkBusy: true \}\); \}/);
  });
  it('runReconcile: after a BUSY leg no later step starts, and the ending is decided before the History entry', () => {
    expect(RUN).toContain('if (!busyLine && (treePushIds.length || groupATotal)) {');
    expect(RUN).toContain('if (busyLine) break;   // another tab\'s run is on: nothing more of this run starts\n    if (!a.groupB.length) continue;');
    expect(RUN).toContain('if (!a.sel.relink.size) continue;\n    if (busyLine) break;');
    expect(RUN).toContain('if (!a.ovwIds.length) continue;\n    if (busyLine) break;');
    expect(RUN).toMatch(/if \(!PROBE && ovwIds\.length\) \{\n[^\n]*\n    if \(!busyLine\) log\([^\n]*\n    if \(!busyLine\) try \{/);
    expect(RUN).toMatch(/if \(!PROBE && updSrcIds\.length\) \{\n[^\n]*\n    if \(!busyLine\) log\([^\n]*\n    if \(!busyLine\) try \{/);
    const busyAt = RUN.indexOf('if (!sftkRecRunTouched(counts, childCounts, allErrors, sftkRunLineIsError)) {');
    expect(busyAt).toBeGreaterThan(RUN.indexOf('opts.afterWrites(log)'));            // paused automation is back on first
    const block = RUN.slice(busyAt, RUN.indexOf('// ── 5. Save to History'));
    expect(block).toContain('await sftkRunRefusedBusy({ busy: true, error: busyLine }');
    expect(block).toContain('sftkUndoStoreDelete(runId)');
    expect(block).toContain('window._sftkRunActive = false;');
    expect(block).toMatch(/if \(runBtn\) runBtn\.disabled = false;\n\s+return;/);
    expect(block).not.toContain('_history.push');
  });
  it('the refusal itself is said as a warning and drops the restore point (the shared ending of the Transfer page)', async () => {
    const P = extractFunctions('sftk-run-progress.js', ['sftkRunRefusedBusy']);
    const log = [], toasts = []; let dropped = 0;
    const took = await P.sftkRunRefusedBusy({ busy: true, error: BUSY_ANSWER.error }, { log: (i, m, c) => log.push([i, m, c]), toast: (m, k) => toasts.push([m, k]), dropRestorePoint: () => { dropped++; } });
    expect(took).toBe(true);
    expect(log).toEqual([['⏳', BUSY_ANSWER.error, 'ds-prog-warn']]);
    expect(toasts[0][1]).toBe('warning');
    expect(dropped).toBe(1);
  });
});

describe('G2. the pull leg: no answer is a failed pull, and unconfirmed pulls are counted', () => {
  it('the pull leg checks the answer before it reads a summary, and adds its unconfirmed records', () => {
    const pull = RUN.slice(RUN.indexOf('// ── 2. Pull target-only rows into source'), RUN.indexOf('// ── 3. Push missing (insert)'));
    expect(pull.indexOf('legCheck(res);')).toBeGreaterThan(0);
    expect(pull.indexOf('legCheck(res);')).toBeLessThan(pull.indexOf('const s = res.summary?.[objType] || {};'));
    expect(pull).toContain('unconfirmedN += pUnc.n;');
    expect(pull).toContain("allErrors.push(`Pull failed: ${e?.message || e}`)");
  });
  it('"Pull failed: No response" is a hard error, so a pull-only run is not a success', () => {
    expect(R.sftkRecLegAnswer({ error: 'No response' })).toBe('none');
    expect(R.sftkRunLineIsError('Pull failed: No response')).toBe(true);
  });
});

describe('G3. a dry run whose engine call failed without a verdict is not "complete"', () => {
  it('a failed call with no probe counts (the source session expired) broke; one whose records were refused did not', () => {
    expect(R.sftkProbeCallBroke({ status: 'failed', summary: { Account: { error: 'SESSION_EXPIRED' } }, errors: ['Account: SESSION_EXPIRED'] })).toBe(true);
    expect(R.sftkProbeCallBroke(BUSY_ANSWER)).toBe(true);
    expect(R.sftkProbeCallBroke(undefined)).toBe(true);
    expect(R.sftkProbeCallBroke({ status: 'failed', summary: { Account: { probe: { probed: 5, wouldWrite: 0, refused: 5 } } } })).toBe(false);
    expect(R.sftkProbeCallBroke({ status: 'failed', summary: { Account: {}, Contact: { probe: { probed: 2, refused: 2 } } } })).toBe(false);
    expect(R.sftkProbeCallBroke({ status: 'success', summary: { Account: { probe: { probed: 0 } } } })).toBe(false);
  });
  it('the reported verdict: inserts ticked, none checked — never "no insert is selected"', () => {
    const none = { probed: 0, would: 0, refused: 0, cascade: 0, unreached: 0 };
    const broke = R.sftkProbeVerdict(none, { incomplete: true, net: false, selected: 5 });
    expect(broke.head).toBe('Dry run stopped before it finished');
    expect(broke.verdict).toBe('no record was checked');
    expect(R.sftkProbeVerdict(none, { incomplete: false, selected: 5 }).verdict).toBe('no record was checked');
    // nothing ticked: the old sentence is still the true one
    expect(R.sftkProbeVerdict(none, { incomplete: false, selected: 0 }).verdict).toBe('nothing was checked — no insert is selected');
    expect(R.sftkProbeVerdict(none, { incomplete: false }).verdict).toBe('nothing was checked — no insert is selected');
  });
  it('runReconcile marks such a call and hands the ticked count to the verdict', () => {
    expect((RUN.match(/if \(PROBE && sftkProbeCallBroke\(res\)\) probeBroke = true;/g) || []).length).toBe(2);
    expect(REC).toContain('sftkProbeVerdict(pt, { incomplete: probeIncomplete, net: netStop, selected: treePushIds.length + groupATotal + childActs.reduce((t, a) => t + a.groupB.length, 0) })');
  });
});

describe('G4. "stopped: network" only when an insert leg lost the connection', () => {
  const legs = errs => R.sftkRecNetLegs(errs, R.sftkRunLineIsError, e => globalThis.sftkIsNetworkError(e));
  it('the reported case: the pull lost the connection, the push wrote all 50 — not stopped, the pull is named', () => {
    const r = legs(['pull: Account: Failed to fetch']);
    expect(r).toEqual({ stopped: false, legs: ['the pull into the source'] });
    const line = R.sftkRunEndLine({ status: 'partial', stoppedWhy: '', net: false, netLegs: r.legs, ok: 50, fail: 0, canUndo: true, canContinue: true });
    expect(line.text).toMatch(/^Finished with errors: 50 record\(s\) written/);
    expect(line.text).toContain('The connection to Salesforce dropped during the pull into the source; the other steps ran');
    expect(line.text).not.toMatch(/Stopped|▶ Continue/);
  });
  it('a push or a group-B insert that lost it is a stop (those are the records ▶ Continue re-ticks)', () => {
    expect(legs(['insert: Account: Failed to fetch']).stopped).toBe(true);
    expect(legs(['Push failed: TypeError: Failed to fetch']).stopped).toBe(true);
    expect(legs(['Insert Contact failed: net::ERR_INTERNET_DISCONNECTED']).stopped).toBe(true);
    expect(legs(['insert Contact: Contact: Failed to fetch']).stopped).toBe(true);
    const line = R.sftkRunEndLine({ status: 'partial', stoppedWhy: 'network', net: true, netLegs: [], ok: 10, canUndo: true, canContinue: true });
    expect(line.text).toMatch(/^Stopped — the connection to Salesforce dropped: 10 record\(s\) written/);
    expect(line.text).toContain('▶ Continue from History re-ticks the records this run did not reach');
  });
  it('other steps and other errors: named or ignored, never a stop', () => {
    expect(legs(['Delete failed: Failed to fetch', 'Overwrite failed: Failed to fetch'])).toEqual({ stopped: false, legs: ['the delete', 'an update step'] });
    expect(legs(['insert: Account: REQUIRED_FIELD_MISSING', 'insert: ℹ Account: Failed to fetch'])).toEqual({ stopped: false, legs: [] });
  });
  it('runReconcile marks History and words the end line from that', () => {
    expect(REC).toContain("if (!PROBE && !stoppedWhy && netStopRun && runStatus !== 'success') stoppedWhy = 'network';");
    expect(REC).toContain("net: netStopRun && runStatus !== 'success', netLegs: netStopRun ? [] : netLegs.legs,");
    expect(REC).not.toContain("if (!PROBE && !stoppedWhy && netStop && runStatus !== 'success') stoppedWhy = 'network';");
  });
});

describe('G5. the Transfer page’s parents-first row says why an ambiguous-only parent is behind', () => {
  const { sftkDeployBehindText } = extractFunctions('studio-deploy.js', ['sftkDeployBehindText']);
  it('the reported input is "behind", and its row names the ambiguous keys', () => {
    const vd = { missing: 0, changed: 0, extra: 0, ambiguous: 3 };
    expect(R.sftkParentStepState({ refObj: 'Account', srcCount: 10, empty: false }, vd)).toBe('behind');
    expect(sftkDeployBehindText(vd)).toBe('🔴 0 missing · 🟡 0 changed · ⚠ 3 ambiguous — lookups to them are refused until resolved');
  });
  it('the advisor builds its behind row from that text, and "in sync" no longer claims only two things', () => {
    const adv = REC.slice(REC.indexOf('const stepHtml = (s, i) => {'), REC.indexOf('ds-ordstep-num'));
    expect(adv).toContain('<span class="ds-psync ds-psync-bad">${esc(sftkDeployBehindText(s.vd))} · ${esc(timeAgo(s.vd.at))}</span>');
    expect(adv).not.toContain('${s.vd.missing} missing');
    expect(adv).toContain('found nothing missing, nothing changed and no ambiguous key.');
  });
});

// ── H · the worker ───────────────────────────────────────────────────────────────────────────────────────────
const BG = read('background.js');
const sliceFn = name => {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(BG);
  if (!m) throw new Error('not found ' + name);
  return BG.slice(m.index, BG.indexOf('\n}', m.index) + 2);
};
const sliceBlock = (start, end) => { const i = BG.indexOf(start); if (i < 0) throw new Error('not found ' + start); return BG.slice(i, BG.indexOf(end, i) + end.length); };

describe('H1. a page-side create states its own duplicate-rule choice', () => {
  // the real message listener, handleMessage, dispatchMessage and sfCollectionsCreate; the HTTP call is recorded
  const makeWorker = () => new Function(`
    let _runActive = false, _runCancelled = false, _runStopWhy = '', _runStopLineLast = '', _runHeartbeat = null, _runPort = null;
    const SFTK_RUN_BUSY = 'busy'; const API_VERSION = 'v62.0';
    let onMessage = null;
    const chrome = { storage: { local: { set: () => Promise.resolve(), remove: () => Promise.resolve() } },
      runtime: { id: 'ext', getURL: p => 'chrome-extension://ext/' + p, onConnect: { addListener: () => {} }, onMessage: { addListener: fn => { onMessage = fn; } } } };
    const _runPorts = new Set(); let _runOwnerPort = null;
    const fetches = [];
    function sfErrorMsg(status) { return 'HTTP ' + status; }
    async function sfFetchWithProxy(orgUrl, sid, url, opts) {
      fetches.push({ url, headers: opts.headers || {} });
      return { ok: true, status: 200, body: JSON.stringify(JSON.parse(opts.body).records.map(() => ({ id: '001', success: true, errors: [] }))) };
    }
    ${sliceBlock('const SFTK_RUN_MESSAGES = ', ';')}
    ${['_runSenderKey', '_runClaimPort', 'postRunProgress', '_beginRun', '_endRun', '_runDupHeaders', 'sftkDupHeadersExplicit', 'sfCollectionsCreate', 'sftkResentError', 'sfCollectionsUpdate'].map(sliceFn).join('\n')}
    ${sliceBlock('const MESSAGE_CONTRACTS = {', '\n};')}
    ${sliceFn('dispatchMessage')}
    ${sliceFn('handleMessage')}
    ${sliceBlock('chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {', '\n});')}
    const send = message => new Promise(resolve => { onMessage(message, { id: 'ext', url: 'chrome-extension://ext/studio.html', documentId: 'docB' }, resolve); });
    return { send, fetches, sfCollectionsCreate };
  `)();
  const CREATE = { type: 'SF_COLLECTIONS_CREATE', orgUrl: 'https://t.my.salesforce.com', sid: 'T', records: [{ attributes: { type: 'Account' }, Name: 'x' }] };
  const HDR = 'Sforce-Duplicate-Rule-Header';
  afterEach(() => { delete globalThis.__sftkRunDupBypass; delete globalThis.__sftkRunDupBypassObjs; });

  it('the reported case: while ANOTHER tab’s Bypass run is on, a page-side create goes out with no bypass header', async () => {
    const W = makeWorker();
    globalThis.__sftkRunDupBypass = true; globalThis.__sftkRunDupBypassObjs = null;   // tab A's leg is running
    const res = await W.send(CREATE);
    expect(Array.isArray(res)).toBe(true);
    expect(W.fetches.length).toBe(1);
    expect(HDR in W.fetches[0].headers).toBe(false);
  });
  it('a create that states the choice itself carries it — for the objects it names', async () => {
    const W = makeWorker();
    await W.send({ ...CREATE, dupBypass: true });
    await W.send({ ...CREATE, dupBypass: true, dupBypassObjects: ['Contact'] });
    await W.send({ ...CREATE, dupBypass: true, dupBypassObjects: ['Account'] });
    expect(W.fetches.map(f => f.headers[HDR])).toEqual(['allowSave=true', undefined, 'allowSave=true']);
  });
  it('the engine’s own call inside its run still reads the run flag', async () => {
    const W = makeWorker();
    globalThis.__sftkRunDupBypass = true;
    await W.sfCollectionsCreate('https://t.my.salesforce.com', 'T', CREATE.records);
    delete globalThis.__sftkRunDupBypass;
    await W.sfCollectionsCreate('https://t.my.salesforce.com', 'T', CREATE.records);
    expect(W.fetches.map(f => f.headers[HDR])).toEqual(['allowSave=true', undefined]);
  });
});

describe('H2. a write call that went out twice is never "refused before saving anything"', () => {
  // the real sfFetch → sfFetchWithProxy → sfProxyFetch → sfCollectionsCreate chain over a scripted network
  const chain = ({ bearer, tabs }) => {
    const answers = [...bearer], tabAnswers = [...(tabs || [])];
    const resp = a => ({ status: a.status, ok: a.status >= 200 && a.status < 300, headers: { forEach() {} }, text: async () => a.body || '' });
    const fetch = async () => resp(answers.shift());
    const chrome = { tabs: { query: async () => tabAnswers.map((_, i) => ({ id: i + 1, url: 'https://t.my.salesforce.com/x', lastAccessed: 100 - i })) },
      scripting: { executeScript: async () => [{ result: tabAnswers.shift() }] } };
    return new Function('fetch', 'chrome', 'setTimeout', 'AbortSignal', `
      const API_VERSION = 'v62.0';
      const isSalesforceUrl = () => true;
      const sftkIsWriteRequest = () => false;
      const assertOrgWritable = async () => {};
      const getSfSession = async () => null;
      ${['sfFetch', 'authHeaders', 'sfProxyFetch', 'sfFetchWithProxy', 'sfErrorMsg', '_runDupHeaders', 'sftkDupHeadersExplicit', 'sfCollectionsCreate', 'sftkResentError'].map(sliceFn).join('\n')}
      return { sfCollectionsCreate };
    `)(fetch, chrome, fn => { fn(); return 0; }, { timeout: () => undefined });
  };
  const RECS = [{ attributes: { type: 'Account' }, Name: 'x' }];
  const LIMIT = '[{"message":"TotalRequests Limit exceeded.","errorCode":"REQUEST_LIMIT_EXCEEDED"}]';
  const thrown = async (net) => { try { await chain(net).sfCollectionsCreate('https://t.my.salesforce.com', 'T', RECS); } catch (e) { return e; } throw new Error('did not throw'); };

  it('the reported case: 503, then the re-send answered 403 — the error is marked as sent twice', async () => {
    const e = await thrown({ bearer: [{ status: 503 }, { status: 403, body: LIMIT }] });
    expect(e.message).toBe('HTTP 403: TotalRequests Limit exceeded.');
    expect(e.sftkResent).toBe(true);
  });
  it('a 403 on the first and only send is a clean refusal (unmarked)', async () => {
    const e = await thrown({ bearer: [{ status: 403, body: LIMIT }] });
    expect(e.message).toBe('HTTP 403: TotalRequests Limit exceeded.');
    expect(e.sftkResent).toBeUndefined();
  });
  it('401, then a tab attempt that errored mid-way, then 401: SESSION_EXPIRED is marked; 401 from every tab is not', async () => {
    const unsure = await thrown({ bearer: [{ status: 401 }], tabs: [{ error: 'Failed to fetch' }, { status: 401, ok: false, body: '' }] });
    expect(unsure.message).toBe('SESSION_EXPIRED');
    expect(unsure.sftkResent).toBe(true);
    const clean = await thrown({ bearer: [{ status: 401 }], tabs: [{ status: 401, ok: false, body: '' }, { status: 401, ok: false, body: '' }] });
    expect(clean.message).toBe('SESSION_EXPIRED');
    expect(clean.sftkResent).toBeUndefined();
  });
  it('a tab that errored and a later tab that refused with 400: the refusal is marked too', async () => {
    const e = await thrown({ bearer: [{ status: 401 }], tabs: [{ error: 'Failed to fetch' }, { status: 400, ok: false, body: '[{"message":"bad"}]' }] });
    expect(e.message).toBe('HTTP 400: bad');
    expect(e.sftkResent).toBe(true);
  });

  // the engine's line for it
  const eng = extractFunctions('background.js', [
    'executeProfileTransfer', 'sftkUnconfirmedRows', 'sftkIsUnconfirmed', 'sftkFailureMeansInTarget', 'sftkFileKeyPairs',
    '_runDupBypassFor', 'sftkRunStopLine', '_runStopReason', '_runNoteStop', 'sftkVanillaPayloadRules', 'sftkEffectiveLookupResolutions', 'sftkLookupDefaultStrategy', 'buildCopyFields', 'sftkFieldsFromError', 'sftkOrgKey',
    'sftkTruncValue', 'sftkBuildOwnerIndex', 'sftkMatchKey', 'sftkPathValue',
    'sftkPiiHashHex', 'sftkPiiMaskable', 'sftkPiiFormat', 'sftkPiiMaskValue',
    'sftkPiiRulesForObject', 'sftkPiiMaskRows', 'sftkPiiMaskAnchorMap', 'sftkRtaImageCount',
  ]);
  const SRC = 'https://src.my.salesforce.com', TGT = 'https://tgt.my.salesforce.com';
  const fld = (name, type, extra) => ({ name, label: name, type, createable: true, updateable: true, nillable: true, defaultValue: null, referenceTo: [], custom: false, length: 255, ...(extra || {}) });
  const DESC = { name: 'Account', fields: [fld('Id', 'id', { createable: false, updateable: false }), fld('Name', 'string', { nillable: false, nameField: true })] };
  const KEYS = ['API_VERSION', '_runCancelled', 'postRunProgress', 'sfQuery', 'sfQueryAll', 'sfRestGet', 'sfCollectionsCreate', 'sfCollectionsUpdate', 'sfCollectionsUpsert', 'sfBulkIngest', 'sfBulkQuery', 'sftkTransferFilesForNode'];
  beforeEach(() => {
    globalThis.API_VERSION = 'v62.0'; globalThis._runCancelled = false; globalThis.postRunProgress = () => {};
    const answer = (orgUrl, q) => {
      const out = orgUrl === TGT ? [] : (/FROM Account/.test(q) ? [{ Id: 'A1', Name: 'Acme' }] : []);
      return /SELECT COUNT\(\)/.test(q) ? { totalSize: out.length, records: [] } : { records: out, totalSize: out.length, serverTotal: out.length };
    };
    globalThis.sfQuery = async (o, s, q) => answer(o, q);
    globalThis.sfQueryAll = async (o, s, q) => answer(o, q);
    globalThis.sfRestGet = async (o, s, path) => (/Account\/describe/.test(path) ? DESC : { error: 'unexpected ' + path });
    globalThis.sfCollectionsUpdate = async (o, s, recs) => recs.map(() => ({ success: true }));
    globalThis.sfCollectionsUpsert = async () => { throw new Error('upsert not expected'); };
    globalThis.sfBulkIngest = async () => { throw new Error('bulk not expected'); };
    globalThis.sfBulkQuery = async () => { throw new Error('bulk query not expected'); };
    globalThis.sftkTransferFilesForNode = async () => ({ copied: 0 });
  });
  afterEach(() => { for (const k of KEYS) delete globalThis[k]; });
  const PROFILE = { id: 'p1', name: 'QA', batchSize: 1, tree: { objectType: 'Account', recordIds: ['A1'], children: [] } };

  it('the engine: a marked HTTP 403 is "NOT CONFIRMED … may or may not be in the target", with no writeRefused', async () => {
    globalThis.sfCollectionsCreate = async () => { throw Object.assign(new Error('HTTP 403: TotalRequests Limit exceeded.'), { sftkResent: true }); };
    const res = await eng.executeProfileTransfer(JSON.parse(JSON.stringify(PROFILE)), SRC, 'S', TGT, 'T');
    expect(res.summary.Account.writeRefused).toBeUndefined();
    expect(res.summary.Account.unconfirmed).toBe(1);
    const lines = res.errors.join('\n');
    expect(lines).toMatch(/NOT CONFIRMED written/);
    expect(lines).toMatch(/may or may not be in the target/);
    expect(lines).not.toMatch(/NOT written — Salesforce refused/);
  });
  it('the engine: the same 403 unmarked is still the clean refusal', async () => {
    globalThis.sfCollectionsCreate = async () => { throw new Error('HTTP 403: TotalRequests Limit exceeded.'); };
    const res = await eng.executeProfileTransfer(JSON.parse(JSON.stringify(PROFILE)), SRC, 'S', TGT, 'T');
    expect(res.summary.Account.writeRefused).toBe(true);
    expect(res.errors.join('\n')).toMatch(/NOT written — Salesforce refused the write call \(HTTP 403/);
  });
});

// ── I · sequences ────────────────────────────────────────────────────────────────────────────────────────────
describe('I. a sequence sends each step pointed at ITS target, without a fallback owner of another org', () => {
  const { sftkSeqRunProfiles } = extractFunctions('studio-sequences.js', ['sftkSeqRunProfiles'], { 'studio-builder.js': ['sftkOwnerFallbackForTarget'] });
  const T1 = 'https://t1.my.salesforce.com', T2 = 'https://t2.my.salesforce.com';
  const P = (name, targetOrg, fb) => ({ id: name, name, sourceOrg: 'https://s.my.salesforce.com', targetOrg, tree: { objectType: 'Account', children: [] },
    ownerMapping: { mode: 'match', fallbackUserId: fb, fallbackUserName: fb ? 'Fallback User' : null } });
  it('the reported case: profile P (target T1, a fallback user of T1) in a sequence into T2', () => {
    const p = P('P', T1, '005T1000000000A');
    const r = sftkSeqRunProfiles([p], { targetOrg: T2 });
    expect(r.run[0].ownerMapping).toMatchObject({ mode: 'match', fallbackUserId: null, fallbackUserName: null });
    expect(r.run[0].targetOrg).toBe(T2);
    expect(r.cleared).toEqual(['P']);
    // the saved profile is untouched
    expect(p.ownerMapping.fallbackUserId).toBe('005T1000000000A');
    expect(p.targetOrg).toBe(T1);
    expect(r.run[0]).not.toBe(p);
    expect(r.run[0].tree).not.toBe(p.tree);
  });
  it('a step whose own target IS the sequence’s keeps its fallback; a step with none is not named', () => {
    const r = sftkSeqRunProfiles([P('Same', T2, '005T2000000000B'), P('None', T1, null)], { targetOrg: T2 });
    expect(r.run[0].ownerMapping.fallbackUserId).toBe('005T2000000000B');
    expect(r.cleared).toEqual([]);
  });
  it('runSequence sends the clones, and the confirmation names the steps that run without their fallback', () => {
    const src = read('studio-sequences.js');
    const run = src.slice(src.indexOf('async function runSequence('));
    expect(run).toMatch(/type:\s+'SF_EXECUTE_SEQUENCE',\n[^\n]*\n\s+profiles:\s+sftkSeqRunProfiles\(profiles, seq\)\.run,/);
    const conf = src.slice(src.indexOf('function _seqConfirmRun('), src.indexOf('async function runSequence('));
    expect(conf).toContain('const noFallback = sftkSeqRunProfiles(profiles, seq).cleared;');
    expect(conf).toContain('Owner fallback not used for');
    expect(conf).toContain('${fbNote}`, needsCheckbox: true }');
  });
});

// ── J · the Toolkit topbar with a tool open ──────────────────────────────────────────────────────────────────
// No layout engine in the gate (see test/regress-1115-css.test.mjs): the arithmetic of the row from the sheet's own
// values and the widths the review measured in Chrome — the action row is 758 px with a tool open, 850 px with the
// tool's History button. Text cannot be measured here, so the label a button gives up is counted at a LOWER bound
// (5 px a character at the bar's 12 px font); the real saving is larger.
describe('J. with a tool open the action row ends inside the window from 780 px up', () => {
  const CSS = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const decl = (sel, prop) => {
    let v; const re = /([^{}]+)\{([^{}]*)\}/g; let m;
    while ((m = re.exec(CSS))) { if (!m[1].split(',').map(s => s.trim()).includes(sel)) continue; const d = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(m[2]); if (d) v = d[1].trim(); }
    return v;
  };
  const px = v => { const m = /^var\((--[\w-]+)\)$/.exec(v || ''); const t = m ? new RegExp(`${m[1]}:\\s*([\\d.]+)px`).exec(CSS)[1] : /^([\d.]+)px$/.exec(v)[1]; return +t; };
  const padX = px(decl('.app-topbar', 'padding').split(/\s+/)[1]);
  const floor = px(decl('.app-brand', 'min-width'));
  const margin = px(decl('.app-brand', 'margin-right'));
  const btnPad = px(decl('.app-topbar .dbg-btn', 'padding').split(/\s+/)[1]);
  const btnGap = px(decl('.app-topbar .dbg-btn', 'gap'));
  const ICON = 14, SQUARE = 28;
  const LABELS = { homeBtn: 'Home', sftkFeedBtn: 'Activity', dataStudioBtn: 'Data Studio', sftkTermsBtn: 'Licence' };
  const TOOL = 758;   // 2026-11-16: the tool's History button is gone — one row width, one rule
  // the icon-only rules: [{ max, history, ids }]
  const TOOL_OPEN = ':has(#homeBtn:not([style*="display:none"]):not([style*="display: none"]))';
  const rules = [...CSS.matchAll(/@media \(max-width: (\d+)px\) \{\s*\.app-topbar-actions(:has\([^{]*?\)) :is\(([^)]*)\) \{([^}]*)\}\s*\}/g)]
    .map(m => ({ max: +m[1], cond: m[2], ids: m[3].split(',').map(s => s.trim().replace(/^#/, '')), body: m[4] }));
  const saving = ids => ids.reduce((t, id) => t + (2 * btnPad + ICON + btnGap + 5 * LABELS[id].length - SQUARE), 0);
  const actionsAt = (width, row, history) => {
    const r = rules.find(x => width <= x.max && x.cond === TOOL_OPEN);
    return r ? row - saving(r.ids) : row;
  };

  it('the sheet has the one rule: a tool is open (the tool\'s History button is gone)', () => {
    expect(rules.map(r => r.cond)).toEqual([TOOL_OPEN]);
    expect(CSS).not.toContain('sftkThBtn');
    for (const r of rules) {
      expect(r.ids.sort()).toEqual(Object.keys(LABELS).sort());
      expect(r.body).toMatch(/width:\s*28px/);
      expect(r.body).toMatch(/font-size:\s*0/);      // the label is the button's own text node
      expect(r.body).toMatch(/padding:\s*0/);
    }
    // every button that loses its label is still named for a pointer and a screen reader
    const html = read('popup.html');
    for (const id of Object.keys(LABELS)) expect(new RegExp(`<button id="${id}"[^>]*\\btitle="[^"]+"`).test(html)).toBe(true);
  });
  it('the reported case: 800 px, tool open — before, the row ended 22 px past the window; now it ends inside the padding', () => {
    expect(padX + floor + margin + TOOL).toBe(822);                                   // the review's arithmetic, labels kept
    expect(padX + floor + margin + actionsAt(800, TOOL, false)).toBeLessThanOrEqual(800 - padX);
  });
  it('every width from 780 (the body minimum) to 1366 px', () => {
    for (const [row, history] of [[TOOL, false]]) {
      for (let w = 780; w <= 1366; w++) {
        const right = padX + floor + margin + actionsAt(w, row, history);
        if (right > w - padX) throw new Error(`the action row ends at ${right}px in a ${w}px window (row ${row}px)`);
      }
    }
  });
  it('where the whole row fits the labels stay: from 853 px; the home page is never touched', () => {
    expect(actionsAt(853, TOOL, false)).toBe(TOOL);
    for (const r of rules) expect(r.cond.startsWith(TOOL_OPEN)).toBe(true);
    // #homeBtn is shown by clearing its inline display and hidden with display none — what the selector reads
    const pj = read('popup.js');
    expect(pj).toContain("document.getElementById('homeBtn').style.display  = '';");
    expect(pj).toContain("document.getElementById('homeBtn').style.display = 'none';");
    expect(read('popup.html')).toMatch(/<button id="homeBtn"[^>]*style="display:none"/);
  });
});
