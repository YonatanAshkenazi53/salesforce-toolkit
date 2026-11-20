// Review of f0334a0 (2026-11-15) — Field Cleaner: the confirmed regressions and half-applied fixes, each proven by
// RUNNING the function (the real source, sliced out the way test/release-qa-1114-field-cleaner does), not by reading
// its text. The last block runs the behaviours that file only pinned as source text.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const FC = read('field-cleaner.js');
const NL = String.fromCharCode(10);

// an inner function of the FieldCleaner module (two-space indent, closes with "\n  }")
const nested = name => {
  const at = FC.indexOf(`\n  function ${name}(`) >= 0 ? FC.indexOf(`\n  function ${name}(`) : FC.indexOf(`\n  async function ${name}(`);
  if (at < 0) throw new Error(`not found in field-cleaner.js: ${name}`);
  return FC.slice(at + 1, FC.indexOf('\n  }\n', at + 1) + 4);
};

const S = extractFunctions('sftk-sweep.js', ['sftkSweepForms', 'sftkSweepHits', 'sftkSweepKindTable', 'sftkSweepSections', '_sftkSweepSectionAt',
  'sftkSweepKind', 'sftkSweepRun', 'sftkSweepJoinKind']);
const M = extractFunctions('sftk-mdapi.js', ['sftkFormulaDropField', '_sftkMdSwapToken', 'sftkMdIsOwnObj']);
const R = new Function('sftkMdIsOwnObj', `${read('sftk-fieldreplace.js')}\nreturn { sftkFlowReplaceField, sftkFlowResourceObjects };`)(M.sftkMdIsOwnObj);
const { sftkWriteVerified } = extractFunctions('sftk-write.js', ['sftkWriteVerified', '_sftkWriteVerifiedCore']);

// one sweep: files as [path, lines…] → { component: type } for every hit
const sweep = (obj, field, files) => {
  const r = S.sftkSweepRun(new Map(files.map(([p, ...lines]) => [p, lines.join(NL)])), S.sftkSweepForms(obj, field));
  const by = {};
  for (const h of r.hits) by[h.component] = { type: h.type, sev: h.sev, join: S.sftkSweepJoinKind(h.type) };
  return by;
};
const vr = (name, formula) => ['<validationRules>', `<fullName>${name}</fullName>`, '<active>true</active>', `<errorConditionFormula>${formula}</errorConditionFormula>`, '</validationRules>'];

// ── 1. sweep: a real blocker reached by a relationship, on Task / Event, or by a dynamic name is not demoted ────────
describe('1. sweep: relationship paths, Activity’s Task / Event and dynamic names stay what they were', () => {
  it('User.Region__c: Owner.Region__c in an Opportunity rule and CreatedBy.Region__c in a Case workflow rule are blockers that join', () => {
    const by = sweep('User', 'Region__c', [
      ['unpackaged/objects/Opportunity.object', '<CustomObject>', ...vr('Owner_Region', 'ISBLANK(Owner.Region__c)'), '</CustomObject>'],
      ['unpackaged/workflows/Case.workflow', '<Workflow>', '<rules>', '<fullName>By_Region</fullName>', '<active>true</active>', '<formula>CreatedBy.Region__c = "EU"</formula>', '</rules>', '</Workflow>'],
    ]);
    expect(by['Opportunity.Owner_Region']).toEqual({ type: 'ValidationRule', sev: 'blocker', join: 'ValidationRule' });
    expect(by['Case.By_Region']).toMatchObject({ type: 'WorkflowRule', sev: 'blocker', join: 'WorkflowRule' });
  });
  it('Activity.Region__c: Task’s own rule and workflow, Apex on Task and a trigger on Event are Activity’s', () => {
    const by = sweep('Activity', 'Region__c', [
      ['unpackaged/objects/Task.object', '<CustomObject>', ...vr('Need_Region', 'ISBLANK(Region__c)'), '</CustomObject>'],
      ['unpackaged/workflows/Event.workflow', '<Workflow>', '<rules>', '<fullName>Ev_Region</fullName>', '<active>true</active>', '<formula>ISBLANK(Region__c)</formula>', '</rules>', '</Workflow>'],
      ['unpackaged/classes/T.cls', 'public class T { void f(Task t){ t.Region__c = \'a\'; } }'],
      ['unpackaged/triggers/E.trigger', 'trigger E on Event (before insert) { for (Event e : Trigger.new) e.Region__c = null; }'],
    ]);
    expect(by['Task.Need_Region'].type).toBe('ValidationRule');
    expect(by['Event.Ev_Region'].type).toBe('WorkflowRule');
    expect(by.T).toMatchObject({ type: 'ApexClass', sev: 'blocker' });
    expect(by.E).toMatchObject({ type: 'ApexTrigger', sev: 'blocker' });
  });
  it('Account.Status__c: a __r path, a two-hop path, a Person Account file and a dynamic name in generic code', () => {
    const by = sweep('Account', 'Status__c', [
      ['unpackaged/objects/Contact.object', '<CustomObject>', '<fields>', '<fullName>Acct_Status__c</fullName>', '<formula>Parent_Account__r.Status__c</formula>', '</fields>', '</CustomObject>'],
      ['unpackaged/objects/Opportunity.object', '<CustomObject>', ...vr('Parent_Status', 'ISPICKVAL(Account.Parent.Status__c,"x")'), '</CustomObject>'],
      ['unpackaged/objects/PersonAccount.object', '<CustomObject>', ...vr('PA_Status', 'ISBLANK(Status__c)'), '</CustomObject>'],
      ['unpackaged/classes/H.cls', 'public class H { void f(SObject s){ s.put(\'Status__c\', 1); } }'],
      ['unpackaged/classes/P.cls', 'public class P { void f(Contact c){ String s = c.Parent_Link__r.Owner_Link__r.Status__c; } }'],
    ]);
    expect(by['Contact.Acct_Status__c'].type).not.toBe('SameNameOtherObject');
    expect(by['Opportunity.Parent_Status']).toMatchObject({ type: 'ValidationRule', sev: 'blocker' });
    expect(by['PersonAccount.PA_Status']).toMatchObject({ type: 'ValidationRule', sev: 'blocker' });
    expect(by.H).toMatchObject({ type: 'ApexClass', sev: 'blocker' });
    expect(by.P).toMatchObject({ type: 'ApexClass', sev: 'blocker' });
  });
  it('what the 2026-11-14 fix was for still holds: a bare name, or the file’s own object spelled out, is that object’s field', () => {
    const by = sweep('Account', 'Status__c', [
      ['unpackaged/objects/Contact.object', '<CustomObject>', ...vr('Need_Status', 'ISBLANK(Status__c)'), ...vr('Own_Spelled', 'ISBLANK(Contact.Status__c)'),
        ...vr('By_Type', '$ObjectType.Contact.Fields.Status__c.Label = "x"'), ...vr('Acct_Type', '$ObjectType.Account.Fields.Status__c.Label = "x"'), '</CustomObject>'],
      ['unpackaged/classes/C.cls', 'public class C { void f(Contact c) { c.Status__c = 1; } }'],
    ]);
    for (const c of ['Contact.Need_Status', 'Contact.Own_Spelled', 'Contact.By_Type', 'C']) expect(by[c]).toEqual({ type: 'SameNameOtherObject', sev: 'mention', join: null });
    expect(by['Contact.Acct_Type'].type).toBe('ValidationRule');
  });
});

// ── 2. sweep: the same-name rule also reaches quick actions, and a comment is not "naming the object" ──────────────
describe('2. sweep: another object’s quick action and a trigger that names the object only in a comment do not join', () => {
  const by = sweep('Account', 'Status__c', [
    ['unpackaged/quickActions/Contact.New_Thing.quickAction', '<QuickAction>', '<quickActionLayout>', '<field>Status__c</field>', '</quickActionLayout>', '</QuickAction>'],
    ['unpackaged/quickActions/Account.Own_Thing.quickAction', '<QuickAction>', '<quickActionLayout>', '<field>Status__c</field>', '</quickActionLayout>', '</QuickAction>'],
    ['unpackaged/quickActions/Global_Thing.quickAction', '<QuickAction>', '<quickActionLayout>', '<field>Status__c</field>', '</quickActionLayout>', '</QuickAction>'],
    ['unpackaged/triggers/CT.trigger', 'trigger CT on Contact (before insert){ /* copy to Account later */ for(Contact x:Trigger.new) x.Status__c=1; }'],
    ['unpackaged/triggers/CL.trigger', 'trigger CL on Contact (before insert){', '  // Account gets it later', '  for(Contact x:Trigger.new) x.Status__c=1;', '}'],
    ['unpackaged/triggers/AT.trigger', 'trigger AT on Account (before insert){ for(Account x:Trigger.new) x.Status__c=1; }'],
  ]);
  it('the proof cases', () => {
    expect(by['Contact.New_Thing']).toEqual({ type: 'SameNameOtherObject', sev: 'mention', join: null });
    expect(by.CT).toEqual({ type: 'SameNameOtherObject', sev: 'mention', join: null });
    expect(by.CL.type).toBe('SameNameOtherObject');
  });
  it('the object’s own action, a global action and code on the object keep their kind', () => {
    expect(by['Account.Own_Thing']).toMatchObject({ type: 'QuickAction', join: 'QuickAction' });
    expect(by.Global_Thing.type).toBe('QuickAction');
    expect(by.AT).toMatchObject({ type: 'ApexTrigger', sev: 'blocker' });
  });
  it('the kind says its code test is file-level', () => {
    expect(S.sftkSweepKindTable().SameNameOtherObject.why).toContain('a file-level test');
  });
});

// ── 3. layout undo: the second deploy without action lists, and a re-read that reads the lists the fix edits ────────
const HIST = read('sftk-history.js');
function loadHistory(store) {
  const names = ['sftkHistoryBegin', 'sftkHistoryEnd', 'sftkHistoryNote', 'sftkUndoVerifyEval', 'sftkHistoryUndo'];
  const chrome = { storage: { local: {
    get: async k => ({ [k]: store[k] }),
    set: async v => { Object.assign(store, JSON.parse(JSON.stringify(v))); },   // what History keeps is JSON
  } }, runtime: { sendMessage: (m, cb) => cb({}) } };
  const api = new Function('chrome', '_history', 'storageSaveHistory', 'sftkWriteVerified', 'sftkConfirmDestructive', 'sftkOrgWriteGate', 'sftkHistorySplit', 'sftkArchPut', 'console',
    `${HIST}\nreturn { ${names.join(', ')} };`)(chrome, undefined, undefined, sftkWriteVerified, undefined, undefined, undefined, undefined, { warn: () => {} });
  globalThis.sftkHistoryNote = api.sftkHistoryNote;   // sftkWriteVerified reaches it through the global
  return api;
}
const layoutStep = new Function(`const buildLayoutZip = (n, md, opts) => (opts && opts.skip ? 'NOACTIONS:' + [...opts.skip].join('+') : 'FULL') + ':' + n;
  const _rxEsc = s => String(s).replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
  ${nested('_layoutUndoStep')}\nreturn _layoutUndoStep;`)();

describe('3. layout undo run through sftkHistoryUndo', () => {
  const ORG = 'https://a.my.salesforce.com';
  // a layout fix as History holds it: the step goes through sftkHistoryEnd and storage, as in the app
  const prepare = async () => {
    const store = { sftk_history: [] };
    const H = loadHistory(store);
    const j = H.sftkHistoryBegin({ tool: 'Field Cleaner', title: '✂ Account Layout', orgUrl: ORG });
    await sftkWriteVerified({ describe: 'the fix', write: async () => ({}), verify: async () => ({ ok: true }), journal: j });
    await H.sftkHistoryEnd(j, { undo: { steps: [layoutStep('00h1', 'Account Layout', 'Account-Account Layout', { layoutSections: [] }, 'Account', 'Status__c')] } });
    return { H, store, id: j.id };
  };
  const sender = (deployAnswers, readText) => {
    const sent = [];
    const send = async m => {
      sent.push(m);
      if (m.type === 'GET_ALL_SF_SESSIONS') return { sessions: [{ orgUrl: ORG, sid: 'S1', label: 'A' }] };
      if (m.type === 'SF_METADATA_DEPLOY') return deployAnswers.shift();
      if (m.type === 'SF_MD_READ') return { text: readText };
      return {};
    };
    return { sent, send };
  };
  it('refused on its action lists → deployed again without them, accepted, verified (multilineLayoutFields counts)', async () => {
    const { H, store, id } = await prepare();
    const { sent, send } = sender([{ error: 'Layout: In field: ActionListContext - no such context' }, { success: true }],
      '<Layout><multilineLayoutFields>Status__c</multilineLayoutFields></Layout>');
    const log = [];
    const r = await H.sftkHistoryUndo(id, { send, confirm: false, onLog: l => log.push(l) });
    const deploys = sent.filter(m => m.type === 'SF_METADATA_DEPLOY');
    expect(deploys.map(m => m.zipBase64)).toEqual(['FULL:Account-Account Layout', 'NOACTIONS:platformActionList+quickActionList:Account-Account Layout']);
    expect(deploys.every(m => m.sid === 'S1' && m.orgUrl === ORG)).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.text).toBe('Undone — 1 step verified by re-reading the org');
    expect(log.some(l => l.includes('deploying it again without them'))).toBe(true);
    expect(store.sftk_history.find(e => e.id === id).toolUndo.done.ok).toBe(true);
  });
  it('accepted first time → one deploy; refused for another reason → one deploy, and the refusal is said', async () => {
    let p = await prepare();
    let s = sender([{ success: true }], '<Layout><layoutItems><field>Status__c</field></layoutItems></Layout>');
    expect((await p.H.sftkHistoryUndo(p.id, { send: s.send, confirm: false })).ok).toBe(true);
    expect(s.sent.filter(m => m.type === 'SF_METADATA_DEPLOY')).toHaveLength(1);
    p = await prepare();
    s = sender([{ error: 'INSUFFICIENT_ACCESS' }, { success: true }], '');
    const log = [];
    const r = await p.H.sftkHistoryUndo(p.id, { send: s.send, confirm: false, onLog: l => log.push(l) });
    expect(r.ok).toBe(false);
    expect(s.sent.filter(m => m.type === 'SF_METADATA_DEPLOY')).toHaveLength(1);
    expect(log.join(' ')).toContain('refused — INSUFFICIENT_ACCESS');
  });
  it('both deploys refused → the second refusal is the one said, and nothing is called undone', async () => {
    const p = await prepare();
    const s = sender([{ error: 'quick action X is not valid' }, { error: 'still refused' }], '');
    const log = [];
    const r = await p.H.sftkHistoryUndo(p.id, { send: s.send, confirm: false, onLog: l => log.push(l) });
    expect(r.ok).toBe(false);
    expect(log.join(' ')).toContain('refused — still refused');
  });
  it('the re-read: relatedObjects and multilineLayoutFields count; another object’s related-list column does not', () => {
    const H = loadHistory({});
    const v = layoutStep('00h1', 'L', 'Account-L', {}, 'Account', 'Status__c').verify;
    const ok = text => H.sftkUndoVerifyEval(v, { text }).ok;
    expect(ok('<Layout><relatedObjects>Status__c</relatedObjects></Layout>')).toBe(true);
    expect(ok('<Layout><multilineLayoutFields>Status__c</multilineLayoutFields></Layout>')).toBe(true);
    expect(ok('<Layout><miniLayout><fields>Status__c</fields></miniLayout></Layout>')).toBe(true);
    expect(ok('<Layout><layoutItems><field>Account.Status__c</field></layoutItems></Layout>')).toBe(true);
    expect(ok(`<Layout><relatedLists><fields>NAME</fields>${NL}<fields>Status__c</fields><relatedList>Contacts</relatedList></relatedLists></Layout>`)).toBe(false);
    expect(ok('<Layout><relatedLists><fields>Status__c</fields></relatedLists><layoutItems><field>Status__c</field></layoutItems></Layout>')).toBe(true);
    expect(ok('<Layout><fields>Status__c</multilineLayoutFields></Layout>')).toBe(false);
  });
});

// ── 4. inspector: a page named only in a component's display text is settled ───────────────────────────────────────
describe('4. _flexiNamesBeyondText: display text is free text, a column or a filter is not', () => {
  const T = new Function(`${nested('flexiPageReferencesField')}\n${nested('_flexiNamesBeyondText')}\nreturn { flexiPageReferencesField, _flexiNamesBeyondText };`)();
  const page = props => ({ description: '', flexiPageRegions: [{ itemInstances: [{ componentInstance: { componentName: 'x', componentInstanceProperties: props } }] }] });
  it('the proof case: a Rich Text component that says the name → not "still named" (and the scan’s own tester did list it)', () => {
    const md = page([{ name: 'richTextValue', value: '<p>Remember to fill Status__c before closing</p>' }]);
    expect(T.flexiPageReferencesField(md, 'Account', 'Status__c')).toBe(true);
    expect(T._flexiNamesBeyondText(md, 'Account', 'Status__c')).toBe(false);
  });
  it('a component title, label or header that says the name is display text too', () => {
    for (const name of ['title', 'label', 'cardTitle', 'relatedListLabel', 'header', 'decorators'])
      expect(T._flexiNamesBeyondText(page([{ name, value: 'About Status__c' }]), 'Account', 'Status__c')).toBe(false);
  });
  it('what a component READS still counts: a related-list column, a filter, a field component, a visibility rule', () => {
    expect(T._flexiNamesBeyondText(page([{ name: 'relatedListFieldAliases', value: 'NAME,Status__c' }]), 'Account', 'Status__c')).toBe(true);
    expect(T._flexiNamesBeyondText(page([{ name: 'filterJson', value: '{"field":"Status__c"}' }]), 'Account', 'Status__c')).toBe(true);
    expect(T._flexiNamesBeyondText(page([{ name: 'fieldApiName', value: 'Account.Status__c' }]), 'Account', 'Status__c')).toBe(true);
    expect(T._flexiNamesBeyondText(page([{ name: 'title', value: 'x' }, { name: 'richTextValue', value: 'Status__c' }, { name: 'columns', value: 'Status__c' }]), 'Account', 'Status__c')).toBe(true);
    const rule = page([]);
    rule.flexiPageRegions[0].itemInstances[0].componentInstance.visibilityRule = { criteria: [{ leftValue: '{!Record.Status__c}', operator: 'EQUAL', rightValue: 'x' }] };
    expect(T._flexiNamesBeyondText(rule, 'Account', 'Status__c')).toBe(true);
  });
  it('the page handed in is not changed', () => {
    const md = page([{ name: 'richTextValue', value: 'Status__c' }]);
    md.description = 'Status__c'; md.masterLabel = 'P';
    const before = JSON.stringify(md);
    T._flexiNamesBeyondText(md, 'Account', 'Status__c');
    expect(JSON.stringify(md)).toBe(before);
  });
});

// ── 5. runScan: a scan of the previous org paints nothing into the new org's page ──────────────────────────────────
describe('5. runScan across an org switch', () => {
  // The real runScan and resolveCustomFieldId; bg is the test's. switchOrg() does what init() does on a switch.
  const harness = bgImpl => new Function('bgImpl', `
    let _orgGen = 1, _selObj = { api: 'Account', durableId: 'Account' }, _selField = { api: 'Status__c' };
    let _scope = 'both', _mcdCapped = false, _scanProg = null, _rptScan, _orgSweep, _rtScanned, _everyNote, _lastScan, _resolveErr = '';
    const _orgUrl = 'u', _sid = 's', window = {};
    const painted = [];
    const el = { innerHTML: '', disabled: false, textContent: '' };
    const eid = () => el;
    const sftkCat = () => '', _scanProgHtml = () => '', _scanProgPaint = () => {}, _scanProgFound = () => {}, _scanMsg = () => {};
    const setInterval = () => 0, clearInterval = () => {};
    const fcScopeLegs = () => ({}), fcLooksCapped = () => false, fcSoqlLit = s => "'" + s + "'";
    const sftkFriendlyError = m => ({ message: String(m), hint: '' }), sftkOrgKey = x => x;
    const chrome = { storage: { local: { get: async () => ({}) } } };
    const showScanError = m => painted.push(m);
    const renderResults = async () => { painted.push('RESULTS'); };
    const scanFlexiPages = async () => [], scanReportTypes = async () => [], scanSupplemental = async () => [];
    const switchOrg = () => { _orgGen++; _selObj = null; _selField = null; };
    let calls = 0;
    const bg = m => bgImpl(m, ++calls, switchOrg);
    ${nested('deriveDevName')}
    ${nested('_pickOwnFieldRow')}
    ${nested('resolveCustomFieldId')}
    ${nested('runScan')}
    return { runScan, painted };`)(bgImpl);
  const found = { records: [{ Id: '00N000000000001', NamespacePrefix: null }] };
  it('a switch during the field lookup: no "Cannot read properties of null", no "could not locate"', async () => {
    const h = harness(async (m, n, switchOrg) => { if (n === 1) switchOrg(); return { records: [] }; });
    await h.runScan();
    expect(h.painted).toEqual([]);
  });
  it('a switch while the lookup fails: the failure is not painted either', async () => {
    const h = harness(async (m, n, switchOrg) => { if (n === 2) switchOrg(); return { error: 'INVALID_SESSION_ID' }; });
    await h.runScan();
    expect(h.painted).toEqual([]);
  });
  it('a switch during the dependency query: neither its error nor its results land', async () => {
    let h = harness(async (m, n, switchOrg) => { if (m.type === 'SF_QUERY') return found; switchOrg(); return { error: 'HTTP 500' }; });
    await h.runScan();
    expect(h.painted).toEqual([]);
    h = harness(async (m, n, switchOrg) => { if (m.type === 'SF_QUERY') return found; switchOrg(); return { records: [] }; });
    await h.runScan();
    expect(h.painted).toEqual([]);
  });
  it('a switch that makes the scan throw: the catch says nothing', async () => {
    const h = harness(async (m, n, switchOrg) => { switchOrg(); throw new Error('port closed'); });
    await h.runScan();
    expect(h.painted).toEqual([]);
  });
  it('with no switch every answer is still said: not found, could not scan, unexpected, results', async () => {
    let h = harness(async () => ({ records: [] }));
    await h.runScan();
    expect(h.painted).toHaveLength(1);
    expect(h.painted[0]).toContain('Could not locate this field');
    h = harness(async m => (m.type === 'SF_QUERY' ? found : { error: 'HTTP 500' }));
    await h.runScan();
    expect(h.painted[0]).toContain('Could not scan dependencies: HTTP 500');
    h = harness(async () => { throw new Error('port closed'); });
    await h.runScan();
    expect(h.painted).toEqual(['Unexpected error: port closed']);
    h = harness(async m => (m.type === 'SF_QUERY' ? found : { records: [] }));
    await h.runScan();
    expect(h.painted).toEqual(['RESULTS']);
  });
});

// ── 6. flows: a description that spells the merge field does not put the queried field back ─────────────────────────
const rmAt = FC.indexOf('  function removeFieldRefs(metadata, objApi, fieldApi, opts) {');
const RM_SRC = FC.slice(rmAt, FC.indexOf('}', FC.indexOf('    return changes;', rmAt)) + 1);
const F = new Function('deps', `const { sftkFormulaDropField, sftkFlowResourceObjects, sftkMdIsOwnObj } = deps;
  const _selField = { api: 'Region__c' };
  ${RM_SRC}
  return { removeFieldRefs };`)({ sftkFormulaDropField: M.sftkFormulaDropField, sftkFlowResourceObjects: R.sftkFlowResourceObjects, sftkMdIsOwnObj: M.sftkMdIsOwnObj });
describe('6. removeFieldRefs: only what the flow READS keeps a queried field', () => {
  const lookup = () => ({ name: 'Get_Account', label: 'Get Account', object: 'Account', filters: [], queriedFields: ['Id', 'Region__c'] });
  it('the proof case: the flow’s description says Get_Account.Region__c → the field goes (1), nothing is named as left', () => {
    const md = { description: 'Reads Get_Account.Region__c for the banner (old note)', recordLookups: [lookup()] };
    expect(F.removeFieldRefs(md, 'Account', 'Region__c', null)).toBe(1);
    expect(md.recordLookups[0].queriedFields).toEqual(['Id']);
    expect(F.removeFieldRefs.lastLeft.whole).toEqual([]);
  });
  it('an element’s description or label, an interview label and another lookup’s description do not count either', () => {
    const md = { interviewLabel: 'Get_Account.Region__c {!$Flow.CurrentDateTime}', label: 'Get_Account.Region__c',
      recordLookups: [lookup(), { name: 'Other', object: 'Contact', description: 'see {!Get_Account.Region__c}', filters: [], queriedFields: ['Id'] }],
      screens: [{ name: 'S1', label: 'Get_Account.Region__c', description: '{!Get_Account.Region__c}', fields: [] }] };
    expect(F.removeFieldRefs(md, 'Account', 'Region__c', null)).toBe(1);
    expect(md.recordLookups[0].queriedFields).toEqual(['Id']);
  });
  it('a screen’s display text that READS it still puts the field back (the 2026-11-14 case)', () => {
    const md = { description: 'x', recordLookups: [lookup()],
      screens: [{ name: 'S1', fields: [{ name: 'DT', fieldType: 'DisplayText', fieldText: '<p>{!Get_Account.Region__c}</p>' }] }] };
    expect(F.removeFieldRefs(md, 'Account', 'Region__c', null)).toBe(0);
    expect(md.recordLookups[0].queriedFields).toEqual(['Id', 'Region__c']);
    expect(F.removeFieldRefs.lastLeft.whole).toContainEqual(expect.objectContaining({ why: 'queried', via: 'Get_Account' }));
  });
});

// ── 7. behaviours test/release-qa-1114-field-cleaner pinned as source text only ────────────────────────────────────
describe('7a. _flowNamesThisField: the chain owner decides, and what cannot be told stays "yes"', () => {
  const FS = extractFunctions('sftk-flowsurgery.js', ['sftkFlowRefScan']);
  // Contact-triggered flow that reads the field through a relationship: the probe needs the chain's owner
  const flow = { start: { object: 'Contact', triggerType: 'RecordAfterSave' }, formulas: [{ name: 'F', dataType: 'String', expression: '{!$Record.Parent_Link__r.Region__c}' }] };
  const make = chainOwner => {
    const asked = [];
    const fn = new Function('sftkFlowRefScan', 'sftkFlowReplaceField', 'chainOwner', 'asked', `
      const _selObj = { api: 'Account' }, _selField = { api: 'Region__c' };
      const _xiIsRef = () => false;
      const _chainKey = (root, rels) => String(root).toLowerCase() + '|' + rels.map(r => String(r).toLowerCase()).join('.');
      const _chainOwner = async (root, rels) => { asked.push(root + '>' + rels.join('.')); return chainOwner(root, rels); };
      ${nested('_fieldStringTester')}
      ${nested('flowReferencesField')}
      ${nested('_flowNamesThisField')}
      ${nested('_flowProbeSaysThis')}
      return _flowNamesThisField;`)(FS.sftkFlowRefScan, R.sftkFlowReplaceField, chainOwner, asked);
    return { fn, asked };
  };
  it('the relationship leads to Account → this field', async () => {
    const t = make(async () => 'Account');
    expect(await t.fn(flow)).toBe(true);
    expect(t.asked).toEqual(['Contact>Parent_Link__r']);
  });
  it('the relationship leads to another object → not this field', async () => {
    expect(await make(async () => 'Campaign').fn(flow)).toBe(false);
  });
  it('the owner cannot be told (null), or the describe throws → still "yes", the safe direction', async () => {
    expect(await make(async () => null).fn(flow)).toBe(true);
    expect(await make(async () => { throw new Error('describe failed'); }).fn(flow)).toBe(true);
  });
  it('a flow that does not name the field at all → no, without asking anything', async () => {
    const t = make(async () => 'Account');
    expect(await t.fn({ start: { object: 'Contact' }, formulas: [{ name: 'F', expression: '{!$Record.Name}' }] })).toBe(false);
    expect(t.asked).toEqual([]);
  });
});

describe('7b. scanSupplemental: a matching-rule or field-update read that fails lands in unread', () => {
  // fcDepKey / fcReadError / fcAuraBundlesNaming: the scan's pure helpers since the QA 1.1 review (findings 16, 18, 19)
  const FE = extractFunctions('field-cleaner.js', ['fcAbsentFeatureError', 'fcDepKey', 'fcReadError', 'fcAuraBundlesNaming']);
  const run = (bg, legs) => new Function('bg', 'fcAbsentFeatureError', 'fcDepKey', 'fcReadError', 'fcAuraBundlesNaming', `
    const _orgUrl = 'u', _sid = 's', _selObj = { api: 'Account' }, _selField = { api: 'Status__c' };
    let _scanProg = null;
    const _scanMsg = () => {}, _scanProgFound = () => {}, _fieldTokenRe = () => /Status__c/i;
    ${nested('scanSupplemental')}
    return scanSupplemental;`)(bg, FE.fcAbsentFeatureError, FE.fcDepKey, FE.fcReadError, FE.fcAuraBundlesNaming)([], '00N000000000001AAA', legs);
  const LEGS = { matchingRules: true, workflowFieldUpdates: true };
  it('an error and an incomplete answer are both said, by leg', async () => {
    const hits = await run(async m => (/MatchingRuleItem/.test(m.query) ? { error: 'HTTP 500: boom' } : { records: [], incomplete: { got: 200, expected: 450 } }), LEGS);
    expect(hits).toHaveLength(0);
    const by = Object.fromEntries(hits.unread.map(u => [u.leg, u.why]));
    expect(by['matching rules']).toContain('HTTP 500: boom');
    expect(by['workflow field updates']).toContain('incomplete (200 of 450)');
  });
  it('answers that came back whole: the rule and the update are listed, nothing is unread', async () => {
    const hits = await run(async m => (/MatchingRuleItem/.test(m.query)
      ? { records: [{ Field: 'Account.Status__c', MatchingRuleId: '0JD1', MatchingRule: { MasterLabel: 'MR' } }] }
      : { records: [{ Id: '04Y1', Name: 'FU', FieldDefinitionId: 'Account.Status__c' }] }), LEGS);
    expect(hits.map(h => `${h.MetadataComponentType}:${h.MetadataComponentName}`)).toEqual(['MatchingRule:MR', 'WorkflowFieldUpdate:FU']);
    expect(hits.unread).toEqual([]);
  });
});

describe('7c. _snapshotFix and _sampleDataUsage, run', () => {
  it('_snapshotFix: the 26th restore point of one run does not push out the first', async () => {
    const now = Date.now();
    const store = { k: Array.from({ length: 25 }, (_, i) => ({ at: now - i * 1000, orgKey: 'u', name: `F v${i}` })) };
    const snap = new Function('store', `
      const SNAP_KEY = 'k', SNAP_CAP = 20, SNAP_RUN_MS = 24 * 3600 * 1000, _orgUrl = 'u', _selObj = { api: 'Account' }, _selField = { api: 'Status__c' };
      const sftkOrgKey = x => x, window = {}, renderSnapshotLog = () => {};
      const chrome = { storage: { local: { get: async () => ({ k: store.k }), set: async v => { store.k = v.k; } } } };
      ${nested('_snapTrim')}
      ${nested('_snapshotFix')}
      return _snapshotFix;`)(store);
    await snap('Flow', '301', 'F v26', 'F', { a: 1 });
    expect(store.k).toHaveLength(26);
    expect(store.k[0]).toMatchObject({ name: 'F v26', metadata: { a: 1 } });
    expect(store.k.map(x => x.name)).toContain('F v24');
  });
  it('_sampleDataUsage: 5,000 rows read is a partial sample; fewer is the whole table', async () => {
    const sample = async n => new Function('n', `
      let _dataVerdict = null; const _dataRun = 1, _orgUrl = 'u', _sid = 's';
      const eid = () => null, _renderDataVerdict = () => {}, sftkFriendlyError = m => ({ message: m });
      const bg = async () => ({ records: Array.from({ length: n }, () => ({ Status__c: null })) });
      ${nested('_sampleDataUsage')}
      return _sampleDataUsage('Account', 'Status__c', 1).then(() => _dataVerdict);`)(n);
    expect(await sample(5000)).toMatchObject({ total: 5000, filled: 0, sampled: true, partial: true });
    expect(await sample(1200)).toMatchObject({ total: 1200, sampled: true, partial: false });
  });
});
