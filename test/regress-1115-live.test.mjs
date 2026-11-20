// The live re-check of 2026-11-15 — three product findings, each proven by RUNNING the real function.
//
//   1. Field Cleaner's full metadata scan listed a picklist whose DESCRIPTION names the scanned field as
//      'Formula & Roll-up Fields | formula' — a blocker that joined the list with "Delete formula or roll-up field".
//      Salesforce accepts the delete with it in place. Documentation text is a mention, never a blocker, never joined.
//   2. Flow Access kept the old grants on screen after an Undo run from Activity.
//   3. A Data Deployment dry run stopped midway: (a) the engine's notes spoke of a real run ("not inserted", "made
//      it into the target", "still to deploy"); (b) the headline counted only the records built when the stop came
//      ("0 of 13 … 13 not reached" with 35 selected).
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const NL = String.fromCharCode(10);

// ═══ 1. the sweep: a name in documentation text ═════════════════════════════════════════════════════════════════
const S = extractFunctions('sftk-sweep.js', ['sftkSweepForms', 'sftkSweepHits', 'sftkSweepKindTable', 'sftkSweepSections', '_sftkSweepSectionAt',
  'sftkSweepKind', 'sftkSweepRun', 'sftkSweepCompare', 'sftkSweepJoinKind', 'sftkSweepIdQuery', 'sftkSweepCsv']);
const FIELD = 'SFTK_FC_Test_Status__c';
const XML = '<?xml version="1.0" encoding="UTF-8"?>';
const run = files => S.sftkSweepRun(new Map(files.map(([p, ...lines]) => [p, lines.join(NL)])), S.sftkSweepForms('Account', FIELD));
// component → the list of { type, sev, section } its hits got (one per line that names the field)
const byComp = r => { const o = {}; for (const h of r.hits) (o[h.component] = o[h.component] || []).push({ type: h.type, sev: h.sev, section: h.section }); return o; };

const ACCOUNT = ['unpackaged/objects/Account.object', XML, '<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">',
  '    <fields>', `        <fullName>${FIELD}</fullName>`, `        <description>The status. ${FIELD} is this field itself.</description>`, '        <type>Picklist</type>', '    </fields>',
  // the live fixture: a picklist that only TALKS about the field, over two lines
  '    <fields>', '        <fullName>SFTK_FC_Test_Status2__c</fullName>',
  `        <description>Field Cleaner fixture: the same picklist as ${FIELD}`, `WITHOUT the value Closed (so a replace must map it). ${FIELD} stays.</description>`,
  `        <inlineHelpText>See ${FIELD}</inlineHelpText>`, `        <label>Copy of ${FIELD}</label>`, '        <type>Picklist</type>', '    </fields>',
  // a formula that both talks about it and USES it
  '    <fields>', '        <fullName>Shown__c</fullName>', `        <description>Shows ${FIELD} as text</description>`, `        <formula>TEXT(${FIELD})</formula>`, '        <type>Text</type>', '    </fields>',
  // description and formula on ONE line: a real mention on the line keeps the line's kind
  '    <fields>', '        <fullName>OneLine__c</fullName>', `        <description>uses ${FIELD}</description><formula>TEXT(${FIELD})</formula>`, '    </fields>',
  // a lookup filter that uses it, with a description that names it too
  '    <fields>', '        <fullName>Partner__c</fullName>', `        <description>filtered by ${FIELD}</description>`,
  '        <lookupFilter>', '            <filterItems>', `                <field>Account.${FIELD}</field>`, '                <operation>equals</operation>', '            </filterItems>', '        </lookupFilter>', '    </fields>',
  // validation rules: message / description only, a real formula, a real errorDisplayField
  '    <validationRules>', '        <fullName>Msg_Only</fullName>', `        <description>about ${FIELD}</description>`, '        <errorConditionFormula>ISBLANK(Name)</errorConditionFormula>',
  `        <errorMessage>Fill ${FIELD} first</errorMessage>`, '    </validationRules>',
  '    <validationRules>', '        <fullName>Real_Rule</fullName>', `        <errorConditionFormula>ISPICKVAL(${FIELD}, "Closed")</errorConditionFormula>`,
  `        <errorMessage>${FIELD} cannot be Closed</errorMessage>`, '    </validationRules>',
  '    <validationRules>', '        <fullName>Shown_At</fullName>', '        <errorConditionFormula>ISBLANK(Name)</errorConditionFormula>',
  `        <errorDisplayField>${FIELD}</errorDisplayField>`, '    </validationRules>',
  // buttons: a description only, and a URL that merges the field
  '    <webLinks>', '        <fullName>Doc_Link</fullName>', `        <description>opens the ${FIELD} guide</description>`, '        <masterLabel>Guide</masterLabel>', '    </webLinks>',
  '    <webLinks>', '        <fullName>Real_Link</fullName>', `        <url>/apex/x?s={!Account.${FIELD}}</url>`, '    </webLinks>',
  '</CustomObject>'];

describe('1. full metadata scan: a name that stands only in documentation text', () => {
  const r = run([ACCOUNT]);
  const by = byComp(r);
  it('the live fixture — a picklist whose description, help text and label name the field — is a mention, with a true reason', () => {
    const hits = by['Account.SFTK_FC_Test_Status2__c'];
    expect(hits.map(h => h.type)).toEqual(['DocText', 'DocText', 'DocText', 'DocText']);   // two description lines, help text, label
    expect(hits.every(h => h.sev === 'mention')).toBe(true);
    expect(hits.map(h => h.section)).toEqual(['named only in a description', 'named only in a description', 'named only in help text', 'named only in a label']);
    // never under "Formula & Roll-up Fields"
    expect((r.byType.CustomField.items || []).map(i => i.component)).not.toContain('Account.SFTK_FC_Test_Status2__c');
    expect(r.byType.DocText).toMatchObject({ label: 'Named only in descriptive text', sev: 'mention' });
    expect(r.byType.DocText.why).toMatch(/nothing stops the delete/);
  });
  it('the field’s own definition is still no use of itself, whatever its description says', () => {
    expect(by[`Account.${FIELD}`]).toBeUndefined();
  });
  it('a REAL reference in the same component is still a blocker: formula, lookup filter, rule formula, errorDisplayField, a button’s URL', () => {
    expect(by['Account.Shown__c']).toEqual([
      { type: 'DocText', sev: 'mention', section: 'named only in a description' },
      { type: 'CustomField', sev: 'blocker', section: 'formula' }]);
    expect(by['Account.OneLine__c']).toEqual([{ type: 'CustomField', sev: 'blocker', section: 'formula' }]);
    expect(by['Account.Partner__c'].map(h => h.type)).toEqual(['DocText', 'LookupFilter']);
    expect(by['Account.Real_Rule'].map(h => `${h.type}/${h.sev}`)).toEqual(['ValidationRule/blocker', 'DocText/mention']);
    expect(by['Account.Shown_At']).toEqual([{ type: 'ValidationRule', sev: 'blocker', section: null }]);
    expect(by['Account.Real_Link']).toEqual([{ type: 'WebLink', sev: 'blocker', section: null }]);
  });
  it('a validation rule named only in its description and error message, and a button named only in its description, are mentions', () => {
    expect(by['Account.Msg_Only']).toEqual([
      { type: 'DocText', sev: 'mention', section: 'named only in a description' },
      { type: 'DocText', sev: 'mention', section: 'named only in an error message' }]);
    expect(by['Account.Doc_Link']).toEqual([{ type: 'DocText', sev: 'mention', section: 'named only in a description' }]);
  });
  it('the other kinds of the sweep: workflow, flow, duplicate rule, custom metadata, approval process — text is a mention, a reference blocks', () => {
    const o = byComp(run([
      ['unpackaged/workflows/Account.workflow', XML, '<Workflow>', '<fieldUpdates>', '<fullName>Set_Other</fullName>', `<description>after ${FIELD} changes</description>`, '<field>Name</field>', '</fieldUpdates>',
        '<rules>', '<fullName>On_Status</fullName>', `<formula>ISCHANGED(${FIELD})</formula>`, '</rules>', '</Workflow>'],
      ['unpackaged/flows/Doc_Flow.flow', XML, '<Flow>', `<description>does not read ${FIELD}</description>`, `<label>About ${FIELD}</label>`, '</Flow>'],
      // a flow's interview label and help text take merge fields — they stay what they were
      ['unpackaged/flows/Real_Flow.flow', XML, '<Flow>', `<interviewLabel>{!$Record.${FIELD}}</interviewLabel>`, '<screens><fields>', `<helpText>{!$Record.${FIELD}}</helpText>`, '</fields></screens>', '</Flow>'],
      ['unpackaged/duplicateRules/Account.Dupes.duplicateRule', XML, '<DuplicateRule>', `<alertText>Same ${FIELD}?</alertText>`, `<description>by ${FIELD}</description>`, '</DuplicateRule>'],
      ['unpackaged/duplicateRules/Account.Real.duplicateRule', XML, '<DuplicateRule>', '<duplicateRuleFilter><duplicateRuleFilterItems>', `<field>${FIELD}</field>`, '</duplicateRuleFilterItems></duplicateRuleFilter>', '</DuplicateRule>'],
      ['unpackaged/customMetadata/Cfg.One.md', XML, '<CustomMetadata>', `<label>${FIELD} setup</label>`, '<values><field>Obj__c</field><value xsi:type="xsd:string">Account</value></values>', '</CustomMetadata>'],
      ['unpackaged/approvalProcesses/Account.Approve.approvalProcess', XML, '<ApprovalProcess>', `<description>when ${FIELD} is set</description>`, '<entryCriteria><criteriaItems>', `<field>Account.${FIELD}</field>`, '</criteriaItems></entryCriteria>', '</ApprovalProcess>'],
      // code is not metadata XML: a "<description>" inside a string is no documentation element
      ['unpackaged/classes/X.cls', `public class X { Account a; String s = '<description>${FIELD}</description>'; }`],
    ]));
    expect(o['Account.Set_Other'].map(h => h.type)).toEqual(['DocText']);
    expect(o['Account.On_Status']).toEqual([{ type: 'WorkflowRule', sev: 'blocker', section: null }]);
    expect(o.Doc_Flow.map(h => h.type)).toEqual(['DocText', 'DocText']);
    expect(o.Real_Flow.map(h => `${h.type}/${h.sev}`)).toEqual(['Flow/blocker', 'Flow/blocker']);
    expect(o['Account.Dupes'].map(h => h.section)).toEqual(['named only in an alert text', 'named only in a description']);
    expect(o['Account.Real']).toEqual([{ type: 'DuplicateRule', sev: 'blocker', section: null }]);
    expect(o['Cfg.One'].map(h => h.type)).toEqual(['DocText']);   // was a 🔒 Custom Metadata Record: the record names Account in a value
    expect(o['Account.Approve'].map(h => `${h.type}/${h.sev}`)).toEqual(['DocText/mention', 'ApprovalProcess/blocker']);
    expect(o.X).toEqual([{ type: 'ApexClass', sev: 'blocker', section: null }]);
  });
  it('a description in ANOTHER object’s file keeps the true reason (plain text), not "that object’s own field"', () => {
    const o = byComp(run([['unpackaged/objects/Contact.object', XML, '<CustomObject>', '<fields>', '<fullName>Note__c</fullName>', `<description>mirrors ${FIELD} of the account</description>`, '</fields>', '</CustomObject>']]));
    expect(o['Contact.Note__c']).toEqual([{ type: 'DocText', sev: 'mention', section: 'named only in a description' }]);
  });
  it('the kind never joins the fix list, and the CSV says nothing breaks', () => {
    expect(S.sftkSweepJoinKind('DocText')).toBeNull();
    const csv = S.sftkSweepCsv(r, 'Account', FIELD);
    const line = csv.split('\r\n').find(l => l.includes('SFTK_FC_Test_Status2__c') && l.includes('inlineHelpText'));
    expect(line).toContain('plain text only - nothing breaks');
    expect(line).not.toContain('must fix before the delete');
  });

  // _sweepJoin, the real function of field-cleaner.js, over the sweep's real result
  const FC = read('field-cleaner.js');
  const nested = name => {
    const at = FC.indexOf(`\n  async function ${name}(`);
    if (at < 0) throw new Error(`not found in field-cleaner.js: ${name}`);
    return FC.slice(at + 1, FC.indexOf('\n  }\n', at + 1) + 4);
  };
  it('_sweepJoin: the picklist does not join (no "Delete formula or roll-up field" row); the real formula, lookup filter and rules do', async () => {
    const lastScan = { deps: [] };
    const TYPE_CFG = Object.fromEntries(['CustomField', 'LookupFilter', 'ValidationRule', 'WebLink'].map(k => [k, { sev: 'blocker' }]));
    const join = new Function('_lastScan', '_selObj', '_selField', 'TYPE_CFG', 'sftkSweepJoinKind', 'sftkSweepIdQuery', 'bg', '_orgUrl', '_sid',
      `${nested('_sweepJoin')}\nreturn _sweepJoin;`)(lastScan, { api: 'Account' }, { api: FIELD }, TYPE_CFG, S.sftkSweepJoinKind, S.sftkSweepIdQuery,
      async () => { throw new Error('no Salesforce call is expected for these kinds'); }, 'https://x.my.salesforce.com', 'SID');
    const s = { result: run([ACCOUNT]) };
    S.sftkSweepCompare(s.result.byType, []);
    const n = await join(s);
    const joined = lastScan.deps.map(d => `${d.MetadataComponentType}|${d.MetadataComponentName}`).sort();
    expect(joined).toEqual(['CustomField|Account.OneLine__c', 'CustomField|Account.Shown__c', 'LookupFilter|Account.Partner__c',
      'ValidationRule|Account.Real_Rule', 'ValidationRule|Account.Shown_At', 'WebLink|Account.Real_Link']);
    expect(n).toBe(6);
    expect(joined.some(x => /Status2__c|Msg_Only|Doc_Link/.test(x))).toBe(false);
    // the lines a joined row carries are its real ones — the description line stays out
    const shown = lastScan.deps.find(d => d.MetadataComponentName === 'Account.Shown__c');
    expect(shown._sweepLines.map(l => l.text)).toEqual([`<formula>TEXT(${FIELD})</formula>`]);
    expect(s.result.byType.DocText.items.every(it => !it.joined)).toBe(true);
  });
});

// ═══ 2. Flow Access after an Undo from History ══════════════════════════════════════════════════════════════════
const { sftkWriteVerified } = extractFunctions('sftk-write.js', ['sftkWriteVerified', '_sftkWriteVerifiedCore']);
const FA = extractFunctions('flow-permissions.js', ['sftkFlowAccessOnUndo', 'sftkFlowAccessWireUndo']);

function loadHistory(env) {
  const names = ['sftkHistoryUndo', 'sftkHistoryUndoAnnounce', 'sftkHistoryNote'];
  const fn = new Function('chrome', 'document', 'sftkWriteVerified', 'sftkConfirmDestructive', 'sftkOrgWriteGate', 'console', `${read('sftk-history.js')}\nreturn { ${names.join(', ')} };`);
  const api = fn(env.chrome, env.document, sftkWriteVerified, env.sftkConfirmDestructive, async () => ({ production: false, label: 'A' }), { warn: () => {} });
  globalThis.sftkHistoryNote = api.sftkHistoryNote;   // sftkWriteVerified reaches it through the global
  return api;
}
const fakeStorage = initial => {
  const store = { sftk_history: initial };
  return { store, chrome: { storage: { local: { get: async k => ({ [k]: store[k] }), set: async v => { Object.assign(store, JSON.parse(JSON.stringify(v))); } } }, runtime: { sendMessage: (m, cb) => cb({}) } } };
};
const grantEntry = () => ({ id: 'e1', kind: 'tool', tool: 'Flow Access', profileName: '🔑 Flow access: 1 flow(s) → 1 permission set(s)', targetOrg: 'https://a.lightning.force.com', status: 'success',
  what: [{ ok: true, accepted: true, verified: true, text: 'granted' }],
  toolUndo: { steps: [{ describe: 'remove the grant', msg: { type: 'SF_DELETE', path: 'p' }, verify: { query: 'SELECT Id FROM SetupEntityAccess WHERE Id = \'x\'', pick: 'records', empty: true } }] } });

describe('2. Flow Access refreshes after an Undo run from the tool’s History', () => {
  afterEach(() => { delete globalThis.sftkHistoryNote; });
  const sessions = [{ orgUrl: 'https://a.my.salesforce.com', sid: 'S1', label: 'A' }];
  const send = async m => (m.type === 'GET_ALL_SF_SESSIONS' ? { sessions } : m.type === 'SF_QUERY' ? { records: [] } : {});

  it('sftkHistoryUndo says so on the page once its steps ran — with the tool, its tab and the org', async () => {
    const doc = new EventTarget(); const heard = [];
    doc.addEventListener('sftk:history-undone', ev => heard.push(ev.detail));
    const storage = fakeStorage([grantEntry()]);
    const H = loadHistory({ chrome: storage.chrome, document: doc, sftkConfirmDestructive: async () => true });
    const r = await H.sftkHistoryUndo('e1', { send });
    expect(r.text).toMatch(/^Undo/);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ tool: 'Flow Access', tab: 'flow-access', orgUrl: 'https://a.lightning.force.com', entryId: 'e1' });
    // by then History holds the undo, so a listener that re-reads sees the state after it
    expect(storage.store.sftk_history).toHaveLength(2);
  });
  it('an undo that was cancelled, or that could not start, says nothing', async () => {
    const doc = new EventTarget(); const heard = [];
    doc.addEventListener('sftk:history-undone', ev => heard.push(ev.detail));
    const storage = fakeStorage([grantEntry()]);
    const H = loadHistory({ chrome: storage.chrome, document: doc, sftkConfirmDestructive: async () => false });
    expect((await H.sftkHistoryUndo('e1', { send })).cancelled).toBe(true);
    expect((await H.sftkHistoryUndo('nope', { send })).ok).toBe(false);
    expect((await H.sftkHistoryUndo('e1', { send: async m => (m.type === 'GET_ALL_SF_SESSIONS' ? { sessions: [] } : {}) })).ok).toBe(false);
    expect(heard).toEqual([]);
  });
  it('a listener that throws does not turn a finished undo into a failed one; no page, no event', async () => {
    const doc = new EventTarget();
    doc.addEventListener('sftk:history-undone', () => { throw new Error('a broken listener'); });
    const H = loadHistory({ chrome: fakeStorage([grantEntry()]).chrome, document: { dispatchEvent() { throw new Error('boom'); } }, sftkConfirmDestructive: async () => true });
    expect((await H.sftkHistoryUndo('e1', { send })).text).toMatch(/^Undo/);
    expect(H.sftkHistoryUndoAnnounce({ tool: 'Flow Access', kind: 'tool' }, { ok: true }, { dispatchEvent() { throw new Error('boom'); } })).toBeNull();
    expect(H.sftkHistoryUndoAnnounce(null, { ok: true }, doc)).toBeNull();
  });

  it('the verdict: only a Flow Access undo, only once the tool was opened; a read under way is followed by another', () => {
    expect(FA.sftkFlowAccessOnUndo({ tool: 'Flow Access', ok: true }, { ready: true, loading: false })).toBe('reload');
    expect(FA.sftkFlowAccessOnUndo({ tool: 'Flow Access', ok: false }, { ready: true, loading: false })).toBe('reload');   // a partly-run undo changed the org too
    expect(FA.sftkFlowAccessOnUndo({ tool: 'Flow Access', ok: true }, { ready: true, loading: true })).toBe('after-load');
    expect(FA.sftkFlowAccessOnUndo({ tool: 'Field Cleaner', ok: true }, { ready: true, loading: false })).toBeNull();
    expect(FA.sftkFlowAccessOnUndo({ tool: 'Flow Access', ok: true }, { ready: false, loading: false })).toBeNull();
    expect(FA.sftkFlowAccessOnUndo(null, { ready: true })).toBeNull();
  });

  // the real module, on a page that is only stubs: how many times it reads the org
  const element = () => ({ style: {}, dataset: {}, innerHTML: '', title: '', classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [] });
  function loadFlowAccess() {
    const doc = new EventTarget(); const els = {};
    doc.getElementById = id => (els[id] = els[id] || element());
    doc.querySelector = () => null; doc.querySelectorAll = () => [];
    const reads = []; const waiting = [];
    const chrome = { runtime: { lastError: null, sendMessage: (m, cb) => {
      if (/FROM FlowDefinitionView/.test(String(m.query || ''))) { reads.push(m); waiting.push(() => cb({ error: 'the test ends the read here' })); return; }
      cb({ error: 'not expected' });
    } } };
    const mod = new Function('document', 'window', 'chrome', 'sftkFriendlyError', 'sftkCat', 'sftkCatSm', `${read('flow-permissions.js')}\nreturn FlowPermissions;`)(doc, {}, chrome, m => ({ message: String(m), hint: '' }), () => '', () => '');
    const settle = async () => { while (waiting.length) { waiting.shift()(); await new Promise(r => setTimeout(r, 0)); } await new Promise(r => setTimeout(r, 0)); };
    const undone = tool => doc.dispatchEvent(new CustomEvent('sftk:history-undone', { detail: { tool, ok: true } }));
    return { doc, mod, reads, waiting, settle, undone };
  }
  it('the open Flow Access tab re-reads the org when a Flow Access undo ends — and only then', async () => {
    const p = loadFlowAccess();
    p.undone('Flow Access');                       // before the tool was ever opened: nothing to refresh
    expect(p.reads).toHaveLength(0);
    p.mod.init(element(), 'https://a.my.salesforce.com', 'SID');
    expect(p.reads).toHaveLength(1);               // the first read of the tool
    await p.settle();
    p.undone('Field Cleaner');                     // another tool's undo
    await p.settle();
    expect(p.reads).toHaveLength(1);
    p.undone('Flow Access');                       // ours: the lists and chips are read again
    expect(p.reads).toHaveLength(2);
    expect(p.reads[1]).toMatchObject({ orgUrl: 'https://a.my.salesforce.com', sid: 'SID' });
    await p.settle();
    expect(p.reads).toHaveLength(2);
  });
  it('an undo that ends while a read is under way: that read is followed by ONE more, not run beside it', async () => {
    const p = loadFlowAccess();
    p.mod.init(element(), 'https://a.my.salesforce.com', 'SID');
    p.undone('Flow Access'); p.undone('Flow Access');
    expect(p.reads).toHaveLength(1);               // still the first read; nothing runs beside it
    await p.settle();
    expect(p.reads).toHaveLength(2);               // …and one more after it
    p.mod.init(element(), 'https://a.my.salesforce.com', 'SID2');   // a new session: the listener is not added twice
    await p.settle();
    const before = p.reads.length;
    p.undone('Flow Access');
    await p.settle();
    expect(p.reads.length).toBe(before + 1);
  });
});

// ═══ 3. a dry run stopped midway ════════════════════════════════════════════════════════════════════════════════
const eng = extractFunctions('background.js', [
  'executeProfileTransfer', 'sftkUnconfirmedRows', 'sftkIsUnconfirmed', 'sftkFailureMeansInTarget', '_runDupBypassFor', 'sftkRunStopLine', '_runStopReason', '_runNoteStop', 'sftkVanillaPayloadRules', 'sftkEffectiveLookupResolutions', 'sftkLookupDefaultStrategy', 'buildCopyFields', 'sftkFieldsFromError', 'sftkOrgKey',
  'sftkTruncValue', 'sftkBuildOwnerIndex', 'sftkQueueOwnerMap', 'sftkOwnerFallbackFor', 'sftkMatchKey', 'sftkPathValue',
  'sftkPiiHashHex', 'sftkPiiMaskable', 'sftkPiiFormat', 'sftkPiiMaskValue',
  'sftkPiiRulesForObject', 'sftkPiiMaskRows', 'sftkPiiMaskAnchorMap', 'sftkRtaImageCount',
  'sftkProbeToken', 'sftkProbeParseToken', 'sftkProbePoison', 'sftkProbeCompositeBody', 'sftkProbeParseRound', 'sftkProbeCascade', 'sftkProbeStatus', 'sftkProbeLimits',
]);
const SRC = 'https://src.my.salesforce.com', TGT = 'https://tgt.my.salesforce.com';
const fld = (name, label, type, extra) => Object.assign({ name, label, type, createable: true, updateable: true, nillable: true, defaultValue: null, referenceTo: [], custom: false, length: 255 }, extra || {});
const DESC = {
  Opportunity: { name: 'Opportunity', fields: [fld('Id', 'Opportunity ID', 'id', { createable: false, updateable: false }), fld('Name', 'Name', 'string', { nillable: false, nameField: true })] },
  OpportunityLineItem: { name: 'OpportunityLineItem', fields: [fld('Id', 'Line Item ID', 'id', { createable: false, updateable: false }), fld('Description', 'Line Description', 'string', { nameField: true }),
    fld('OpportunityId', 'Opportunity ID', 'reference', { referenceTo: ['Opportunity'], relationshipName: 'Opportunity' })] },
};
const ROWS = {
  Opportunity: [{ Id: 'O1', Name: 'Deal' }],
  OpportunityLineItem: [{ Id: 'L1', Description: 'a', OpportunityId: 'O1' }, { Id: 'L2', Description: 'b', OpportunityId: 'O1' }],
};
const WORLD = ['API_VERSION', '_runCancelled', '_runStopWhy', 'postRunProgress', 'sfQuery', 'sfQueryAll', 'sfRestGet', 'sfCollectionsCreate', 'sfCollectionsUpdate', 'sfCollectionsUpsert', 'sfCollectionsDelete', 'sfBulkIngest', 'sfBulkQuery', 'sfProbeComposite'];
function installWorld(opts = {}) {
  const composites = [];
  globalThis.API_VERSION = 'v62.0'; globalThis._runCancelled = false; globalThis.postRunProgress = () => {};
  const answer = (orgUrl, q) => {
    const obj = (/FROM (\w+)/.exec(q) || [])[1];
    let out = orgUrl === SRC ? (ROWS[obj] || []) : [];
    for (const m of q.matchAll(/(\w+) IN \(([^)]*)\)/g)) { const set = new Set([...m[2].matchAll(/'([^']+)'/g)].map(x => x[1])); out = out.filter(r => set.has(r[m[1]])); }
    if (/SELECT COUNT\(\)/.test(q)) return { totalSize: out.length, records: [] };
    return { records: out, totalSize: out.length, serverTotal: out.length };
  };
  globalThis.sfQuery = async (o, s, q) => answer(o, q);
  globalThis.sfQueryAll = async (o, s, q) => answer(o, q);
  globalThis.sfRestGet = async (o, s, path) => { const m = /sobjects\/(\w+)\/describe/.exec(path); if (m && opts.onDescribe) opts.onDescribe(m[1]); return (m && DESC[m[1]]) || { error: 'unexpected ' + path }; };
  for (const k of ['sfCollectionsCreate', 'sfCollectionsUpdate', 'sfCollectionsUpsert', 'sfCollectionsDelete', 'sfBulkIngest', 'sfBulkQuery']) globalThis[k] = async () => { throw new Error(`${k}: nothing may be written here`); };
  const halted = [{ errorCode: 'PROCESSING_HALTED', message: 'The transaction was rolled back since another operation in the same transaction failed.' }];
  globalThis.sfProbeComposite = async (o, s, body) => {
    composites.push(body);
    const subs = body.compositeRequest.filter(r => r.referenceId !== 'poison');
    return { compositeResponse: [...subs.map(sub => ({ referenceId: sub.referenceId, httpStatusCode: 400, body: halted })),
      { referenceId: 'poison', httpStatusCode: 400, body: [{ errorCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [Name]', fields: ['Name'] }] }] };
  };
  return composites;
}
const oppTree = (picks, probe) => ({ id: 'p1', name: 'opps', ...(probe ? { probe: true } : {}), tree: { objectType: 'Opportunity', recordIds: picks.Opportunity, children: [
  { objectType: 'OpportunityLineItem', field: 'OpportunityId', recordIds: picks.OpportunityLineItem, children: [] }] } });
const REAL_WORDS = /not inserted —|made it into the target|was inserted without|still to deploy|Continue from History|half-written/;

describe('3a. the engine’s notes inside a dry run say what WOULD happen', () => {
  afterEach(() => { for (const k of WORLD) delete globalThis[k]; });

  it('children whose parents are not in the run: "would not be inserted … not checked by the dry run"', async () => {
    installWorld();
    const r = await eng.executeProfileTransfer(oppTree({ Opportunity: ['O_GONE'], OpportunityLineItem: ['L1', 'L2'] }, true), SRC, 'S', TGT, 'T');
    const line = r.errors.find(e => /^⚠ OpportunityLineItem:/.test(e));
    expect(line).toBe('⚠ OpportunityLineItem: 2 selected record(s) would not be inserted — none of their Opportunity parent(s) would be written in this run (see Opportunity above); a record is never inserted without its parent. Not checked by the dry run: L1, L2');
    expect(r.errors.some(e => REAL_WORDS.test(e))).toBe(false);
  });
  it('the same selection in a REAL run keeps the real run’s words (nothing was written: no parent, no child)', async () => {
    installWorld();
    const r = await eng.executeProfileTransfer(oppTree({ Opportunity: ['O_GONE'], OpportunityLineItem: ['L1', 'L2'] }, false), SRC, 'S', TGT, 'T');
    expect(r.errors.find(e => /^⚠ OpportunityLineItem:/.test(e)))
      .toMatch(/^⚠ OpportunityLineItem: 2 selected record\(s\) not inserted — none of their Opportunity parent\(s\) made it into the target in this run/);
  });
  it('a dry run paused between objects: one stop line, in dry-run words — nothing "still to deploy", no ▶ Continue', async () => {
    const composites = installWorld({ onDescribe: obj => { if (obj === 'Opportunity') { globalThis._runCancelled = true; globalThis._runStopWhy = 'pause'; } } });
    const r = await eng.executeProfileTransfer(oppTree({ Opportunity: ['O1'], OpportunityLineItem: ['L1', 'L2'] }, true), SRC, 'S', TGT, 'T');
    const stops = r.errors.filter(e => /dry run (paused|cancelled|stopped)/.test(e));
    expect(stops).toEqual(['🧪 dry run paused before every record was checked — nothing was written, and the records it did not reach were not checked.']);
    expect(r.errors.some(e => REAL_WORDS.test(e))).toBe(false);
    expect(r.stopped).toBe('pause');
    expect(composites).toHaveLength(0);                      // nothing was sent after the stop
    expect(r.summary.OpportunityLineItem).toBeUndefined();   // never built: the page counts its records as never checked
  });
  it('cancelled and closed read the same way', async () => {
    for (const [why, word] of [['cancel', 'cancelled'], ['closed', 'stopped (the page was closed)']]) {
      installWorld({ onDescribe: () => { globalThis._runCancelled = true; globalThis._runStopWhy = why; } });
      const r = await eng.executeProfileTransfer(oppTree({ Opportunity: ['O1'], OpportunityLineItem: ['L1'] }, true), SRC, 'S', TGT, 'T');
      expect(r.errors.filter(e => /^🧪 dry run /.test(e) && /before every record was checked/.test(e))).toEqual([`🧪 dry run ${word} before every record was checked — nothing was written, and the records it did not reach were not checked.`]);
    }
  });
});

const REC = extractFunctions('studio-reconcile.js', ['sftkProbeLine', 'sftkProbeVerdict', 'sftkProbeReach']);
const { sftkProbeHint } = extractFunctions('studio-deploy.js', ['sftkProbeHint']);
const view = new Function('document', `${read('sftk-friendly-error.js')}\n${read('sftk-run-progress.js')}
return { sftkRunProgressNewState, sftkRunProgressReduce, sftkRunProgressCardText };`)(null);

describe('3b. a stopped dry run names the selected total and what was never checked', () => {
  // the live run: 35 selected (13 Opportunity + 22 under them); the stop came with only Opportunity built
  const expected = { Opportunity: 13, OpportunityLineItem: 20, OpportunityContactRole: 2 };
  const built = { Opportunity: { probed: 13, wouldWrite: 0, refused: 0, cascade: 0, unreached: 13, earlier: 0, sampledOf: 0 } };
  const totals = (byObj, reach) => {
    const t = Object.values(byObj).reduce((a, x) => ({ probed: a.probed + x.probed, would: a.would + x.wouldWrite, refused: a.refused + x.refused, cascade: a.cascade + x.cascade, unreached: a.unreached + x.unreached }),
      { probed: 0, would: 0, refused: 0, cascade: 0, unreached: 0 });
    return { ...t, unbuilt: reach.unbuiltTotal, selected: reach.selected };
  };

  it('what the run never built, per object', () => {
    const reach = REC.sftkProbeReach(built, expected, true);
    expect(reach.selected).toBe(35);
    expect(reach.unbuilt).toEqual({ OpportunityLineItem: 20, OpportunityContactRole: 2 });
    expect(reach.unbuiltTotal).toBe(22);
    expect(reach.lines.map(l => l.text)).toEqual([
      'OpportunityLineItem: none of the 20 selected record(s) was checked — the dry run stopped before them',
      'OpportunityContactRole: none of the 2 selected record(s) was checked — the dry run stopped before them']);
  });
  it('the headline: "0 of 35 selected … 35 never checked" — not "0 of 13 … 13 not reached"', () => {
    const reach = REC.sftkProbeReach(built, expected, true);
    const v = REC.sftkProbeVerdict(totals(built, reach), { incomplete: true, selected: reach.selected });
    expect(v.head).toBe('Dry run stopped before it finished');
    expect(v.verdict).toBe('0 of 35 selected record(s) would be written — 35 never checked');
    expect(v.verdict).not.toMatch(/of 13/);
  });
  it('stable: the same selection reads the same wherever the stop fell', () => {
    const at = byObj => { const reach = REC.sftkProbeReach(byObj, expected, true); return REC.sftkProbeVerdict(totals(byObj, reach), { incomplete: true, selected: reach.selected }).verdict; };
    const z = { probed: 0, wouldWrite: 0, refused: 0, cascade: 0, unreached: 0, earlier: 0, sampledOf: 0 };
    const nothingBuilt = at({});
    const oneBuilt = at(built);
    const twoBuilt = at({ ...built, OpportunityLineItem: { ...z, probed: 20, unreached: 20 } });
    const halfBuilt = at({ Opportunity: { ...z, probed: 13, unreached: 13 }, OpportunityLineItem: { ...z, probed: 7, unreached: 7 } });
    expect(new Set([nothingBuilt, oneBuilt, twoBuilt, halfBuilt])).toEqual(new Set(['0 of 35 selected record(s) would be written — 35 never checked']));
  });
  it('records that did get an answer before the stop are counted as they were', () => {
    const z = { probed: 0, wouldWrite: 0, refused: 0, cascade: 0, unreached: 0, earlier: 0, sampledOf: 0 };
    const byObj = { Opportunity: { ...z, probed: 13, wouldWrite: 10, refused: 1, cascade: 0, unreached: 2 }, OpportunityLineItem: { ...z, probed: 5, wouldWrite: 3, cascade: 2 } };
    const reach = REC.sftkProbeReach(byObj, expected, true);
    expect(reach.lines.map(l => l.text)).toEqual([
      'OpportunityLineItem: 15 of the 20 selected record(s) were never checked — the dry run stopped before them',
      'OpportunityContactRole: none of the 2 selected record(s) was checked — the dry run stopped before them']);
    const v = REC.sftkProbeVerdict(totals(byObj, reach), { incomplete: true, selected: reach.selected }).verdict;
    expect(v).toBe('13 of 35 selected record(s) would be written — 1 refused, 2 not checked (their parent would be refused), 19 never checked');
    // 13 + 1 + 2 + 19 = 35: every selected record is in the sentence once
  });
  it('a FINISHED dry run has nothing "never built": a sample’s rest and its other lines stay as they were', () => {
    const z = { probed: 0, wouldWrite: 0, refused: 0, cascade: 0, unreached: 0, earlier: 0, sampledOf: 0 };
    const done = { Opportunity: { ...z, probed: 13, wouldWrite: 13 }, OpportunityLineItem: { ...z, probed: 18, wouldWrite: 18 } };
    const reach = REC.sftkProbeReach(done, expected, false);
    expect(reach).toMatchObject({ selected: 35, unbuilt: {}, unbuiltTotal: 0, lines: [] });
    expect(REC.sftkProbeVerdict(totals(done, reach), { incomplete: false, selected: 35 }).verdict).toBe('every one of the 31 record(s) would be written');
    // a stopped run of a sampled object: the records beyond the sample are not "never checked"
    const sampled = REC.sftkProbeReach({ Account: { ...z, probed: 200, unreached: 200, sampledOf: 5000 } }, { Account: 5000 }, true);
    expect(sampled.unbuiltTotal).toBe(0);
    // …and a stopped run where every selected record was built keeps the engine's own count
    expect(REC.sftkProbeVerdict({ probed: 13, would: 0, refused: 0, cascade: 0, unreached: 13, unbuilt: 0, selected: 13 }, { incomplete: true, selected: 13 }).verdict).toBe('0 of 13 would be written — 13 not reached');
  });
  it('the per-object lines agree with it: 13 not reached + 20 + 2 never checked = 35', () => {
    // the built object's line is the engine's verdict; the unbuilt ones get theirs from sftkProbeReach, with the count
    const reach = REC.sftkProbeReach(built, expected, true);
    const lines = [REC.sftkProbeLine('Opportunity', built.Opportunity, 13).text, ...reach.lines.map(l => l.text)];
    expect(lines).toEqual(['Opportunity: 0 of 13 would be written, 13 not reached',
      'OpportunityLineItem: none of the 20 selected record(s) was checked — the dry run stopped before them',
      'OpportunityContactRole: none of the 2 selected record(s) was checked — the dry run stopped before them']);
    expect(built.Opportunity.unreached + reach.lines.reduce((t, l) => t + l.n, 0)).toBe(reach.selected);
  });
  it('the chip next to ▶ Deploy names both numbers', () => {
    const reach = REC.sftkProbeReach(built, expected, true);
    const h = sftkProbeHint({ status: 'failed', incomplete: true, totals: totals(built, reach) });
    expect(h.text).toBe('🧪 dry run stopped before it finished — 35 of 35 selected records never checked');
    expect(h.cls).toBe('ds-rec-tag-fail');
  });
  it('the run cards: an object the stop left unbuilt gets a card that says so; a built one adds what it lacks', () => {
    const T0 = 1_000_000;
    const st = view.sftkRunProgressNewState(T0);
    const ev = (dt, e) => view.sftkRunProgressReduce(st, e, T0 + dt);
    ev(0, { phase: 'start' });
    ev(10, { phase: 'node', obj: 'Opportunity' });
    ev(20, { phase: 'fetched', obj: 'Opportunity', count: 13, probe: true });
    ev(30, { phase: 'probeDone', obj: 'Opportunity', probed: 13, wouldWrite: 0, refused: 0, cascade: 0, unreached: 13 });
    ev(40, { phase: 'end' });
    expect(st.cards.has('0_OpportunityLineItem')).toBe(false);
    ev(50, { phase: 'probeUnbuilt', obj: 'OpportunityLineItem', n: 20 });
    const card = st.cards.get('0_OpportunityLineItem');
    const t = view.sftkRunProgressCardText(card, T0 + 60);
    expect(t).toMatchObject({ icon: '⚠', stateText: 'dry run stopped — not checked', numsText: '20 selected record(s) never checked', alive: false });
    expect(card.finished).toBe(true);
    // the card that had its verdict is unchanged…
    expect(view.sftkRunProgressCardText(st.cards.get('0_Opportunity'), T0 + 60).numsText).toBe('13 in the dry run · 0 would be written · 13 not reached');
    // …and a partly built object says both
    ev(70, { phase: 'probeDone', obj: 'Case', probed: 5, wouldWrite: 5, refused: 0, cascade: 0, unreached: 0 });
    ev(80, { phase: 'probeUnbuilt', obj: 'Case', n: 15 });
    const c = view.sftkRunProgressCardText(st.cards.get('0_Case'), T0 + 90);
    expect(c.icon).toBe('⚠');
    expect(c.stateText).toBe('dry run stopped — 15 never checked');
    expect(c.numsText).toBe('5 checked · 5 would be written · 15 more selected, never checked');
  });
});
