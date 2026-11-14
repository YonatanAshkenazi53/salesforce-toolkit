// FIELD CLEANER MATRIX — flows and Process Builder (owner 2026-11-14: "from every metadata type test a full delete
// and a partial remove where the field appears one time in the xml and where it appears a couple of times").
//
// How the tool treats a flow (nothing here is re-implemented — every function is lifted from the product files):
//   · the flow is read as the Tooling API's Metadata (JSON, the Flow XML element for element)
//   · ✂  removeFieldRefs (field-cleaner.js) takes the field out of that JSON, in place
//   · ⇄  sftkFlowReplaceField (sftk-fieldreplace.js) points every reference at the new field
//   · buildFlowXml / buildFlowZip serialize it back to flows/<Name>.flow and it is deployed as a new ACTIVE version
//   · sftkFlowSurgeryPlan (sftk-flowsurgery.js) says which versions are rewritten and which are deleted
//   · a flow has no "delete the component" spec: 🗑 is "Delete versions · flow off" (the plan's activeMode 'delete')
//   · a Process Builder process (ProcessType Workflow) is listed as a flow, never rewritten, and deleted as a whole
// The fixtures below are written as Metadata API XML (.flow-meta.xml) and turned into the Tooling shape by parseFlow,
// a test-side reader: repeatable elements become arrays, everything else an object or a string.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const FC = read('field-cleaner.js');

const OBJ = 'Account', F = 'Region__c', NF = 'Territory__c';

// ── the product code ───────────────────────────────────────────────────────────────────────────────────────────
const M = extractFunctions('sftk-mdapi.js', ['sftkFormulaDropField', '_sftkMdSwapToken', 'sftkMdDeleteSpec', '_sftkMdDeleteTable',
  'sftkMdEditWays', 'sftkMdCodeWays', 'sftkMdPackageFiles', 'sftkMdRecordFileXml', 'sftkMdFindElement', 'sftkMdEscape', '_sftkPkgXml', 'sftkMdDestructiveFiles']);
const S = extractFunctions('sftk-flowsurgery.js', ['sftkFlowSurgeryPlan', 'sftkFlowSurgeryLines', 'sftkFlowPlanRows', 'sftkFlowCardLines',
  'sftkFlowInterviewKinds', 'sftkFlowInterviewWords', 'sftkFlowRefScan', 'sftkFlowRefWhere', 'sftkFlowRefPreview', 'sftkFlowReachable']);
const R = new Function(`${read('sftk-fieldreplace.js')}\nreturn { sftkFlowReplaceField, sftkFlowResourceObjects };`)();
const B = extractFunctions('sftk-flowbulk.js', ['sftkFlowKindOf', 'sftkFlowBulkKinds']);

// a function of the tool's closure (two-space indent, closes with "\n  }")
const nested = name => {
  const at = FC.indexOf(`\n  function ${name}(`);
  if (at < 0) throw new Error(`not found in field-cleaner.js: ${name}`);
  return FC.slice(at + 1, FC.indexOf('\n  }', at + 1) + 4);
};
const constBlock = (header, closer) => {
  const at = FC.indexOf(header);
  if (at < 0) throw new Error(`not found in field-cleaner.js: ${header}`);
  return FC.slice(at, FC.indexOf(closer, at) + closer.length);
};
// the remover itself has nested functions of its own — lifted the way test/flow-decisions-1110 does it
const rmAt = FC.indexOf('  function removeFieldRefs(metadata, objApi, fieldApi, opts) {');
const rmStop = FC.indexOf('    return changes;', rmAt);
const RM_SRC = FC.slice(rmAt, FC.indexOf('}', rmStop) + 1);

const T = new Function('deps', `
  const { sftkFlowRefScan, sftkFormulaDropField, sftkMdDeleteSpec, sftkMdEditWays, sftkMdCodeWays } = deps;
  let _selObj = { api: '${OBJ}' }, _selField = { api: '${F}' }, _replField = null, _flowVerInfo = {}, _flowCards = [];
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const _replOn = () => !!_replField;                    // harness state: is a replacement field chosen
  const _lxBuildStoredZip = entries => entries;          // the zip container is not under test — its entries are
  const TYPE_CFG = {}, TYPE_CFG_DEFAULT = {};
  ${constBlock("  const _LX_SKIP = new Set(", ');')}
  ${constBlock('  const _XI_IS_DELETABLE = {', '\n  };')}
  ${nested('_lxEsc')}
  ${nested('_lxValueToLines')}
  ${nested('buildFlowXml')}
  ${nested('buildFlowPackageXml')}
  ${nested('buildFlowZip')}
  ${nested('_xiIsRef')}
  ${nested('_fieldStringTester')}
  ${nested('flowReferencesField')}
  ${nested('_collectDeletableNodes')}
  ${nested('_removeSelectedFlowBlocks')}
  ${nested('_flowCardsOf')}
  ${nested('_fixBtnsHtml')}
  ${RM_SRC}
  return { buildFlowXml, buildFlowPackageXml, buildFlowZip, flowReferencesField, _fieldStringTester, _removeSelectedFlowBlocks, removeFieldRefs,
    cardsOf(rows, verInfo) { _flowVerInfo = verInfo; _flowCards = _flowCardsOf(rows); return _flowCards; },
    buttons(id, name, replaceTo) { _replField = replaceTo ? { api: replaceTo } : null; try { return _fixBtnsHtml('Flow', id, name); } finally { _replField = null; } } };
`)({ sftkFlowRefScan: S.sftkFlowRefScan, sftkFormulaDropField: M.sftkFormulaDropField, sftkMdDeleteSpec: M.sftkMdDeleteSpec, sftkMdEditWays: M.sftkMdEditWays, sftkMdCodeWays: M.sftkMdCodeWays });

// ── test-side helpers ──────────────────────────────────────────────────────────────────────────────────────────
// Flow elements that repeat (the Tooling API returns them as arrays, also when there is one)
const ARR = new Set(['actionCalls', 'assignments', 'choices', 'collectionProcessors', 'constants', 'decisions', 'dynamicChoiceSets',
  'formulas', 'loops', 'processMetadataValues', 'recordCreates', 'recordDeletes', 'recordLookups', 'recordUpdates', 'screens', 'subflows',
  'textTemplates', 'variables', 'waits', 'rules', 'conditions', 'filters', 'inputAssignments', 'outputAssignments', 'queriedFields',
  'assignmentItems', 'fields', 'inputParameters', 'outputParameters', 'scheduledPaths', 'choiceReferences', 'dataTypeMappings']);
const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function parseFlow(xml) {
  const re = /<\?[^>]*\?>|<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>|([^<]+)/g;
  const stack = [{ tag: '#doc', kids: [], text: '' }];
  let m;
  while ((m = re.exec(xml))) {
    if (m[0].startsWith('<?')) continue;
    if (m[4] != null) { stack[stack.length - 1].text += m[4]; continue; }
    if (m[3]) continue;                                                       // <x/> — nothing in it
    if (!m[1]) { stack.push({ tag: m[2], kids: [], text: '' }); continue; }
    const n = stack.pop();
    if (n.tag !== m[2]) throw new Error(`fixture XML: </${m[2]}> closes <${n.tag}>`);
    let v;
    if (!n.kids.length) v = unesc(n.text.trim());
    else { v = {}; for (const [k, x] of n.kids) { if (ARR.has(k)) (v[k] = v[k] || []).push(x); else v[k] = x; } }
    stack[stack.length - 1].kids.push([n.tag, v]);
  }
  if (stack.length !== 1) throw new Error('fixture XML: an element is not closed');
  return stack[0].kids[0][1];
}
// every tag closes, in order, exactly one root
function wellFormed(xml) {
  const re = /<\?[^>]*\?>|<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>/g;
  const st = []; let roots = 0, m;
  while ((m = re.exec(xml))) {
    if (m[0].startsWith('<?') || m[3]) continue;
    if (!m[1]) { if (!st.length) roots++; st.push(m[2]); } else if (st.pop() !== m[2]) return false;
  }
  return st.length === 0 && roots === 1;
}
const clone = x => JSON.parse(JSON.stringify(x));
const word = api => new RegExp(`(?<![A-Za-z0-9_])${api}(?![A-Za-z0-9_])`);
const count = (text, api) => (text.match(new RegExp(word(api).source, 'g')) || []).length;
// every line of `after` is a line of `before`, in the same order — nothing was added, moved or rewritten
const onlyLinesGone = (before, after) => { const b = before.split('\n'); let i = 0; for (const l of after.split('\n')) { while (i < b.length && b[i] !== l) i++; if (i >= b.length) return false; i++; } return true; };
// "1 AND (2 OR 3)" with n conditions: every number names a condition, every condition is named
const logicFits = (logic, n) => { const nums = [...new Set((String(logic).match(/\d+/g) || []).map(Number))].sort((a, b) => a - b); return nums.length === n && nums.every((x, i) => x === i + 1); };

const HEAD = (label, processType) => `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>62.0</apiVersion>
    <description>Matrix fixture.</description>
    <interviewLabel>${label} {!$Flow.CurrentDateTime}</interviewLabel>
    <label>${label}</label>
    <processMetadataValues><name>BuilderType</name><value><stringValue>LightningFlowBuilder</stringValue></value></processMetadataValues>
    <processMetadataValues><name>CanvasMode</name><value><stringValue>AUTO_LAYOUT_CANVAS</stringValue></value></processMetadataValues>
    <processType>${processType}</processType>
    <status>Active</status>`;
const flowXml = (label, processType, body) => `${HEAD(label, processType)}\n${body}\n</Flow>`;
// the Start of a record-triggered flow on Account
const startRT = (target, filters = '', logic = 'and') => `    <start>
        <locationX>50</locationX><locationY>0</locationY>
        <connector><targetReference>${target}</targetReference></connector>${filters ? `
        <filterLogic>${logic}</filterLogic>${filters}` : ''}
        <object>Account</object>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
        <triggerType>RecordAfterSave</triggerType>
    </start>`;
const startPlain = target => `    <start>
        <locationX>50</locationX><locationY>0</locationY>
        <connector><targetReference>${target}</targetReference></connector>
    </start>`;
const filter = (field, value = 'EMEA', op = 'EqualTo') => `
        <filters><field>${field}</field><operator>${op}</operator><value><stringValue>${value}</stringValue></value></filters>`;
const cond = (left, value = 'EMEA', op = 'EqualTo') => `
            <conditions><leftValueReference>${left}</leftValueReference><operator>${op}</operator><rightValue><stringValue>${value}</stringValue></rightValue></conditions>`;
const condRef = (left, right) => `
            <conditions><leftValueReference>${left}</leftValueReference><operator>EqualTo</operator><rightValue><elementReference>${right}</elementReference></rightValue></conditions>`;
const rule = (name, logic, conds, target = 'Done') => `
        <rules>
            <name>${name}</name>
            <conditionLogic>${logic}</conditionLogic>${conds}
            <connector><targetReference>${target}</targetReference></connector>
            <label>${name}</label>
        </rules>`;
const decision = (name, rules, dflt = 'Done') => `    <decisions>
        <name>${name}</name>
        <label>${name}</label>
        <locationX>176</locationX><locationY>300</locationY>
        <defaultConnector><targetReference>${dflt}</targetReference></defaultConnector>
        <defaultConnectorLabel>Default Outcome</defaultConnectorLabel>${rules}
    </decisions>`;
const item = (to, ref, str) => `
        <assignmentItems><assignToReference>${to}</assignToReference><operator>Assign</operator><value>${ref ? `<elementReference>${ref}</elementReference>` : `<stringValue>${str}</stringValue>`}</value></assignmentItems>`;
const assignment = (name, items, target) => `    <assignments>
        <name>${name}</name>
        <label>${name}</label>
        <locationX>176</locationX><locationY>500</locationY>${items}${target ? `
        <connector><targetReference>${target}</targetReference></connector>` : ''}
    </assignments>`;
const inAssign = (field, ref, str) => `
        <inputAssignments><field>${field}</field><value>${ref ? `<elementReference>${ref}</elementReference>` : `<stringValue>${str}</stringValue>`}</value></inputAssignments>`;
const DONE = assignment('Done', item('note', null, 'done'));
const NOTE = '    <variables><name>note</name><dataType>String</dataType><isCollection>false</isCollection><isInput>false</isInput><isOutput>false</isOutput></variables>';
const ACCT = '    <variables><name>acct</name><dataType>SObject</dataType><isCollection>false</isCollection><isInput>true</isInput><isOutput>false</isOutput><objectType>Account</objectType></variables>';
const CON = '    <variables><name>con</name><dataType>SObject</dataType><isCollection>false</isCollection><isInput>true</isInput><isOutput>false</isOutput><objectType>Contact</objectType></variables>';

// ✂ on a fixture: the real remover on the Tooling shape, the real serializer, the real preview
function cut(xml, opts) {
  const before = parseFlow(xml), after = clone(before);
  const n = T.removeFieldRefs(after, OBJ, F, opts || null);
  return { before, after, n, xmlBefore: T.buildFlowXml(before), xml: T.buildFlowXml(after),
    preview: S.sftkFlowRefPreview(before, after, T._fieldStringTester()) };
}
// the whole promise of a clean ✂: the product's own test and a plain whole-word search agree the field is gone,
// the XML still parses and reads back to the same metadata, and nothing but removed lines differs
function expectClean(r) {
  expect(T.flowReferencesField(r.after)).toBe(false);
  expect(r.xml).not.toMatch(word(F));
  expect(r.preview.remaining).toEqual([]);
  expect(wellFormed(r.xml)).toBe(true);
  expect(parseFlow(r.xml)).toEqual(parseFlow(T.buildFlowXml(clone(r.after))));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('the harness reads a flow the way the tool does', () => {
  const xml = flowXml('RT', 'AutoLaunchedFlow', [startRT('Done', filter(F) + filter('Type', 'Customer')), DONE, NOTE].join('\n'));
  it('the fixture round-trips through the product serializer: same metadata, well-formed, one file per flow', () => {
    const md = parseFlow(xml);
    expect(md.start.filters).toHaveLength(2);
    expect(md.start.object).toBe('Account');
    const out = T.buildFlowXml(md);
    expect(wellFormed(out)).toBe(true);
    expect(parseFlow(out)).toEqual(md);
    expect(out).toContain('<apiVersion>62.0</apiVersion>');
  });
  it('the product’s mention test sees the field, and not a longer or shorter name', () => {
    expect(T.flowReferencesField(parseFlow(xml))).toBe(true);
    expect(T.flowReferencesField(parseFlow(xml.replace(/Region__c/g, 'Sub_Region__c')))).toBe(false);
    expect(T.flowReferencesField(parseFlow(xml.replace(/Region__c/g, 'Region__cx')))).toBe(false);
  });
  it('a field name typed into a description or a label is not a reference', () => {
    const md = parseFlow(flowXml('Region__c flow', 'AutoLaunchedFlow', [startRT('Done'), DONE, NOTE].join('\n')).replace('Matrix fixture.', 'Reads Account.Region__c'));
    expect(md.description).toContain(F);
    expect(T.flowReferencesField(md)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('FULL DELETE — a flow', () => {
  it('a flow has no component delete spec and no XML edit ways: it is handled version by version', () => {
    expect(M.sftkMdDeleteSpec('Flow')).toBeNull();
    expect(M.sftkMdEditWays('Flow')).toBeNull();
    expect(M.sftkMdPackageFiles('Flow', 'My_Flow', '<label>x</label>')).toBeNull();
  });
  it('the card of a flow that runs on the field offers ✂ keep-running and 🗑 flow-off; ⇄ only with a replacement chosen', () => {
    const cards = T.cardsOf([{ MetadataComponentId: '301000000000003AAA', MetadataComponentName: 'My Flow' }, { MetadataComponentId: '301000000000001AAA', MetadataComponentName: 'My Flow' }],
      { '301000000000003': { defId: '300000000000001AAA', num: 3, status: 'Active', pb: false }, '301000000000001': { defId: '300000000000001AAA', num: 1, status: 'Obsolete', pb: false } });
    expect(cards).toHaveLength(1);
    expect(cards[0].primaryId).toBe('301000000000003AAA');
    expect(cards[0].versions.map(v => v.num)).toEqual([3, 1]);
    expect(cards[0].pb).toBe(false);
    const html = T.buttons(cards[0].primaryId, 'My Flow', '');
    expect(html).toContain('data-way="keep"'); expect(html).toContain('✂ Remove · flow keeps running');
    expect(html).toContain('data-way="off"'); expect(html).toContain('🗑 Delete versions · flow off');
    expect(html).not.toContain('⇄ Replace');
    const html2 = T.buttons(cards[0].primaryId, 'My Flow', NF);
    expect(html2).toContain('⇄ Replace'); expect(html2).toContain('data-swap="1"');
  });
  it('a flow whose active version does not use the field offers only "Delete N old versions"', () => {
    const cards = T.cardsOf([{ MetadataComponentId: '301000000000002AAA', MetadataComponentName: 'Old' }, { MetadataComponentId: '301000000000001AAA', MetadataComponentName: 'Old' }],
      { '301000000000002': { defId: '300000000000002AAA', num: 2, status: 'Obsolete' }, '301000000000001': { defId: '300000000000002AAA', num: 1, status: 'Draft' } });
    const html = T.buttons(cards[0].primaryId, 'Old', NF);
    expect(html).toContain('🗑 Delete 2 old versions');
    expect(html).not.toContain('✂'); expect(html).not.toContain('⇄');
  });
  it('🗑 flow off: the plan switches the flow off, checks it, then deletes the active version and every version that mentions the field', () => {
    const p = S.sftkFlowSurgeryPlan([{ Id: 'v4', VersionNumber: 4, Status: 'Active' }, { Id: 'v3', VersionNumber: 3, Status: 'Obsolete' }, { Id: 'v2', VersionNumber: 2, Status: 'Obsolete' }], ['v4', 'v2'], { activeMode: 'delete' });
    expect(p.mode).toBe('active-delete');
    expect(p.steps.map(s => s.kind)).toEqual(['deactivate', 'verify-inactive', 'delete-versions']);
    expect(p.steps[2].versions.slice().sort()).toEqual(['v2', 'v4']);
    expect(p.cleanInactive).toBe(1);
    expect(p.expectNew).toBeNull();
    expect(S.sftkFlowPlanRows(p, 0, null).map(r => r.k)).toEqual(['Switch off', 'Delete', 'Result', 'Backup']);
    expect(S.sftkFlowSurgeryLines(p, 0, null).join(' ')).toContain('THE FLOW STOPS RUNNING');
  });
  it('the redeploy of a flow is flows/<ApiName>.flow with a Flow package — the same file a restore puts back', () => {
    const md = parseFlow(flowXml('RT', 'AutoLaunchedFlow', [startRT('Done'), DONE, NOTE].join('\n')));
    const files = T.buildFlowZip('My_Flow', md);
    expect(files.map(f => f.name)).toEqual(['package.xml', 'flows/My_Flow.flow']);
    const pkg = new TextDecoder().decode(files[0].data);
    expect(pkg).toContain('<members>My_Flow</members>'); expect(pkg).toContain('<name>Flow</name>');
    expect(wellFormed(pkg)).toBe(true);
    expect(wellFormed(new TextDecoder().decode(files[1].data))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('VERSIONS — the active one is rewritten, the old ones that mention the field are deleted', () => {
  // three versions of one flow, read the way fixFlowPlan reads them: which mention the field is the product's own test
  const withField = flowXml('RT', 'AutoLaunchedFlow', [startRT('Done', filter(F) + filter('Type', 'Customer')), DONE, NOTE].join('\n'));
  const clean = flowXml('RT', 'AutoLaunchedFlow', [startRT('Done', filter('Type', 'Customer')), DONE, NOTE].join('\n'));
  const refs = byId => Object.keys(byId).filter(id => T.flowReferencesField(parseFlow(byId[id])));
  const V = (id, num, status) => ({ Id: id, VersionNumber: num, Status: status });

  it('active v3 and old v1 mention it, v2 never did → a new v4, then v3 and v1 go, v2 stays', () => {
    const referencing = refs({ a3: withField, o2: clean, o1: withField });
    expect(referencing.sort()).toEqual(['a3', 'o1']);
    const p = S.sftkFlowSurgeryPlan([V('a3', 3, 'Active'), V('o2', 2, 'Obsolete'), V('o1', 1, 'Obsolete')], referencing);
    expect(p.mode).toBe('active');
    expect(p.expectNew).toBe(4);
    expect(p.steps.map(s => s.kind)).toEqual(['redeploy', 'verify-active', 'delete-versions']);
    expect(p.toDelete.map(v => v.num).sort()).toEqual([1, 3]);
    expect(p.cleanInactive).toBe(1);
    expect(S.sftkFlowPlanRows(p, 0, null)[0]).toEqual({ k: 'Deploy', text: 'a new v4 from v3, without the field · verified active before anything is deleted' });
    expect(S.sftkFlowPlanRows(p, 0, null, { swapTo: NF })[0].text).toContain(`references → ${NF}`);
  });
  it('only old versions mention it → they are deleted, no new version, the active one is not touched', () => {
    const p = S.sftkFlowSurgeryPlan([V('a3', 3, 'Active'), V('o2', 2, 'Obsolete'), V('o1', 1, 'Obsolete')], refs({ a3: clean, o2: withField, o1: withField }));
    expect(p.mode).toBe('inactive-only');
    expect(p.steps.map(s => s.kind)).toEqual(['delete-versions']);
    expect(p.toDelete.map(v => v.id).sort()).toEqual(['o1', 'o2']);
    expect(p.toDelete.some(v => v.status === 'Active')).toBe(false);
  });
  it('a draft newer than the active version is saved over by the redeploy: it is not deleted afterwards, and the plan says so', () => {
    const p = S.sftkFlowSurgeryPlan([V('d4', 4, 'Draft'), V('a3', 3, 'Active')], refs({ d4: withField, a3: withField }));
    expect(p.mode).toBe('active');
    expect(p.expectNew).toBe(4);
    expect(p.overwrite.num).toBe(4);
    expect(p.toDelete.map(v => v.id)).toEqual(['a3']);
    expect(S.sftkFlowSurgeryLines(p, 0, null)[0]).toContain('over the draft v4');
  });
  it('no version mentions it → nothing to do; paused interviews on a version that goes are deleted first', () => {
    expect(S.sftkFlowSurgeryPlan([V('a1', 1, 'Active')], refs({ a1: clean })).steps).toEqual([]);
    const p = S.sftkFlowSurgeryPlan([V('a1', 1, 'Active')], ['a1']);
    const kinds = S.sftkFlowInterviewKinds([{ InterviewStatus: 'Paused' }, { InterviewStatus: 'Error' }]);
    expect(S.sftkFlowPlanRows(p, kinds, null).find(r => r.k === 'Interviews').text).toContain('2 on those versions are deleted first');
  });
  it('the card says per version what happens before anything runs', () => {
    const c = S.sftkFlowCardLines([{ num: 3, status: 'Active' }, { num: 1, status: 'Obsolete' }], {});
    expect(c.hasActive).toBe(true);
    expect(c.lines.map(l => l.vers)).toEqual(['v3 · Active', 'v1 · not active']);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('RECORD-TRIGGERED FLOW — Start entry conditions', () => {
  it('ONE mention: one of two entry conditions → that filter goes, the other and everything else stay', () => {
    const r = cut(flowXml('RT', 'AutoLaunchedFlow', [startRT('Done', filter(F) + filter('Type', 'Customer')), DONE, NOTE].join('\n')));
    expect(count(r.xmlBefore, F)).toBe(1);
    expect(r.n).toBe(1);
    const want = clone(r.before); want.start.filters.splice(0, 1);
    expect(r.after).toEqual(want);
    expect(r.after.start.filters.map(f => f.field)).toEqual(['Type']);
    expect(r.after.start.filterLogic).toBe('and');
    expect(onlyLinesGone(r.xmlBefore, r.xml)).toBe(true);
    expect(r.xmlBefore.split('\n').length - r.xml.split('\n').length).toBe(7);   // the <filters> block: 7 lines
    expectClean(r);
    expect(r.preview.removed).toEqual([expect.objectContaining({ kind: 'Start (entry conditions)', where: 'filter condition 1', what: 'Region__c = EMEA' })]);
    expect(r.preview.emptied).toEqual([]);
  });
  it('SEVERAL mentions: entry condition + $Record in a decision + $Record__Prior + a field value + a yes/no formula → all five in one pass', () => {
    const r = cut(flowXml('RT', 'AutoLaunchedFlow', [
      startRT('Check', filter(F) + filter('Type', 'Customer')),
      decision('Check', rule('Changed', 'and', cond('$Record.Region__c') + condRef('$Record.Name', '$Record__Prior.Region__c') + cond('$Record.Industry', 'Banking'), 'Stamp')),
      `    <recordUpdates>
        <name>Stamp</name>
        <label>Stamp</label>
        <locationX>176</locationX><locationY>400</locationY>
        <connector><targetReference>Done</targetReference></connector>${inAssign('Region__c', null, 'APAC')}${inAssign('Description', null, 'stamped')}
        <inputReference>$Record</inputReference>
    </recordUpdates>`,
      DONE, NOTE,
      '    <formulas><name>IsBig</name><dataType>Boolean</dataType><expression>AND(ISBLANK({!$Record.Region__c}), {!$Record.AnnualRevenue} &gt; 1000)</expression></formulas>',
    ].join('\n')));
    expect(count(r.xmlBefore, F)).toBe(5);
    expect(r.n).toBe(5);
    expect(r.after.start.filters.map(f => f.field)).toEqual(['Type']);
    expect(r.after.decisions[0].rules[0].conditions.map(c => c.leftValueReference)).toEqual(['$Record.Industry']);
    expect(r.after.decisions[0].rules[0].conditionLogic).toBe('and');
    expect(r.after.recordUpdates[0].inputAssignments.map(a => a.field)).toEqual(['Description']);
    expect(r.after.formulas[0].expression).toBe('{!$Record.AnnualRevenue} > 1000');
    expect(r.xml).toContain('<expression>{!$Record.AnnualRevenue} &gt; 1000</expression>');
    // everything the fix did not have to touch is as it was
    const want = clone(r.before);
    want.start.filters.splice(0, 1); want.decisions[0].rules[0].conditions.splice(0, 2); want.recordUpdates[0].inputAssignments.splice(0, 1);
    want.formulas[0].expression = '{!$Record.AnnualRevenue} > 1000';
    expect(r.after).toEqual(want);
    expectClean(r);
    expect(r.preview.removed).toHaveLength(5);
    expect(r.preview.emptied).toEqual([]);
  });
  // PRODUCT BUG: removeFieldRefs strips a <filters> of Start / Get / Update / Delete Records without looking at the
  // element's <filterLogic>. With a numbered logic ("1 AND (2 OR 3)") the logic still names condition 3 of two —
  // Salesforce refuses the new version. The decisions of the same function leave a numbered logic alone on purpose.
  it.skip('PRODUCT BUG: a numbered filterLogic on Start is left consistent (renumbered, or the element is left alone and reported)', () => {
    const r = cut(flowXml('RT', 'AutoLaunchedFlow', [startRT('Done', filter('Type', 'Customer') + filter(F) + filter('Industry', 'Banking'), '1 AND (2 OR 3)'), DONE, NOTE].join('\n')));
    expect(logicFits(r.after.start.filterLogic, r.after.start.filters.length)).toBe(true);
  });
  // PRODUCT BUG: the field is the ONLY entry condition → the condition goes and the flow now fires on every save of
  // the object (and <filterLogic>and</filterLogic> stays behind with no <filters>). A decision outcome that rests on
  // the field alone is refused by the same function; here nothing is refused and the preview's "emptied" (the
  // warning of the confirm) does not list it either — NEEDS_SOMETHING has no 'filters'.
  it.skip('PRODUCT BUG: the only entry condition of Start is not taken out silently (left and reported, or named as emptied)', () => {
    const r = cut(flowXml('RT', 'AutoLaunchedFlow', [startRT('Done', filter(F)), DONE, NOTE].join('\n')));
    const leftAlone = r.n === 0 && r.preview.remaining.length === 1;
    const warned = r.preview.emptied.length === 1 && r.after.start.filterLogic === undefined;
    expect(leftAlone || warned).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('DECISIONS', () => {
  const wrap = rules => flowXml('RT', 'AutoLaunchedFlow', [startRT('Check'), decision('Check', rules), DONE, NOTE].join('\n'));
  it('ONE mention: one of two conditions of an AND outcome → the condition goes, the outcome and its connector stay', () => {
    const r = cut(wrap(rule('Is_EMEA', 'and', cond('$Record.Region__c') + cond('$Record.Type', 'Customer'))));
    expect(count(r.xmlBefore, F)).toBe(1);
    expect(r.n).toBe(1);
    const want = clone(r.before); want.decisions[0].rules[0].conditions.splice(0, 1);
    expect(r.after).toEqual(want);
    expect(r.after.decisions[0].rules[0].connector.targetReference).toBe('Done');
    expect(onlyLinesGone(r.xmlBefore, r.xml)).toBe(true);
    expectClean(r);
    expect(r.preview.removed).toEqual([expect.objectContaining({ kind: 'Decision', name: 'Check', where: 'outcome “Is_EMEA” → condition 1', what: '$Record.Region__c EqualTo “EMEA”' })]);
  });
  it('ONE mention, REFUSED: the outcome rests on the field alone → nothing changes, and the preview names it as by hand', () => {
    const r = cut(wrap(rule('Is_EMEA', 'and', cond('$Record.Region__c'))));
    expect(r.n).toBe(0);
    expect(r.after).toEqual(r.before);
    expect(r.xml).toBe(r.xmlBefore);
    expect(r.preview.removed).toEqual([]);
    expect(r.preview.remaining).toEqual([expect.objectContaining({ kind: 'Decision', name: 'Check', where: 'outcome “Is_EMEA” → condition 1', value: '$Record.Region__c' })]);
    // the run refuses on exactly this: no change → "Couldn't auto-remove … Nothing was deleted"
    expect(FC).toContain("Couldn't auto-remove the field from the active v");
  });
  it('ONE mention, REFUSED: a numbered logic "1 AND (2 OR 3)" is not renumbered by the tool → left whole and reported', () => {
    const r = cut(wrap(rule('Mixed', '1 AND (2 OR 3)', cond('$Record.Type', 'Customer') + cond('$Record.Region__c') + cond('$Record.Industry', 'Banking'))));
    expect(r.n).toBe(0);
    expect(r.after).toEqual(r.before);
    expect(logicFits(r.after.decisions[0].rules[0].conditionLogic, 3)).toBe(true);
    expect(r.preview.remaining).toHaveLength(1);
  });
  it('SEVERAL mentions: left side, right side and a second outcome → every condition of the field goes, logic words kept', () => {
    const r = cut(wrap(
      rule('A', 'and', cond('$Record.Region__c') + condRef('$Record.BillingCountry', '$Record.Region__c') + cond('$Record.Type', 'Customer')) +
      rule('B', 'or', cond('$Record.Industry', 'Banking') + cond('$Record__Prior.Region__c', 'APAC'), 'Done')));
    expect(count(r.xmlBefore, F)).toBe(3);
    expect(r.n).toBe(3);
    expect(r.after.decisions[0].rules.map(x => x.conditions.map(c => c.leftValueReference))).toEqual([['$Record.Type'], ['$Record.Industry']]);
    expect(r.after.decisions[0].rules.map(x => x.conditionLogic)).toEqual(['and', 'or']);
    expect(onlyLinesGone(r.xmlBefore, r.xml)).toBe(true);
    expectClean(r);
  });
  it('SEVERAL mentions, one cannot go: the outcome that can lose it does, the one that rests on it stays — and the preview says exactly which (the confirm reads "field stays locked")', () => {
    const r = cut(wrap(rule('A', 'and', cond('$Record.Region__c') + cond('$Record.Type', 'Customer')) + rule('B', 'and', cond('$Record.Region__c', 'APAC'))));
    expect(r.n).toBe(1);
    expect(r.after.decisions[0].rules[0].conditions).toHaveLength(1);
    expect(r.after.decisions[0].rules[1]).toEqual(r.before.decisions[0].rules[1]);
    expect(T.flowReferencesField(r.after)).toBe(true);
    expect(r.preview.removed).toHaveLength(1);
    expect(r.preview.remaining).toEqual([expect.objectContaining({ where: 'outcome “B” → condition 1' })]);
    expect(wellFormed(r.xml)).toBe(true);
  });
  it('the third way (chosen in the confirm): the outcome that rests on the field goes as a whole; the default outcome takes its records', () => {
    const out = [];
    const r = cut(wrap(rule('A', 'and', cond('$Record.Region__c') + cond('$Record.Type', 'Customer')) + rule('B', 'and', cond('$Record.Region__c', 'APAC') + condRef('$Record.Name', '$Record.Region__c'))), { dropOutcomes: true, out });
    expect(r.n).toBe(3);
    expect(r.after.decisions[0].rules.map(x => x.name)).toEqual(['A']);
    expect(r.after.decisions[0].defaultConnector.targetReference).toBe('Done');
    expect(out).toEqual([expect.objectContaining({ decision: 'Check', outcome: 'B', led: 'Done' })]);
    expectClean(r);
  });
  it('the third way on a decision whose only outcome rests on the field: the decision goes and Start points at where its default led', () => {
    const r = cut(wrap(rule('Only', 'and', cond('$Record.Region__c'))), { dropOutcomes: true, out: [] });
    expect(r.after.decisions).toEqual([]);
    expect(r.after.start.connector.targetReference).toBe('Done');
    expect(r.xml).not.toContain('<decisions>');
    expect(r.xml).not.toContain('>Check<');
    expect([...S.sftkFlowReachable(r.after)]).toEqual(['Done']);
    expectClean(r);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('ASSIGNMENTS', () => {
  const wrap = (...els) => flowXml('Auto', 'AutoLaunchedFlow', [startPlain('Set'), ...els, DONE, NOTE, ACCT].join('\n'));
  it('ONE mention: one of two assignment lines writes the field → that line goes', () => {
    const r = cut(wrap(assignment('Set', item('acct.Region__c', null, 'EMEA') + item('acct.Description', null, 'x'), 'Done')));
    expect(count(r.xmlBefore, F)).toBe(1);
    expect(r.n).toBe(1);
    const want = clone(r.before); want.assignments[0].assignmentItems.splice(0, 1);
    expect(r.after).toEqual(want);
    expect(onlyLinesGone(r.xmlBefore, r.xml)).toBe(true);
    expectClean(r);
    expect(r.preview.removed).toEqual([expect.objectContaining({ kind: 'Assignment', name: 'Set', where: 'assignment line 1' })]);
    expect(r.preview.emptied).toEqual([]);
  });
  it('ONE mention, the only line: it goes, the assignment is left empty — the preview warns that Salesforce will likely refuse (then nothing is deleted)', () => {
    const r = cut(wrap(assignment('Set', item('acct.Region__c', null, 'EMEA'), 'Done')));
    expect(r.n).toBe(1);
    expect(r.after.assignments[0].assignmentItems).toEqual([]);
    expect(r.preview.emptied).toEqual([expect.objectContaining({ kind: 'Assignment', name: 'Set', part: 'assignmentItems' })]);
    expect(wellFormed(r.xml)).toBe(true);
    expect(r.xml).not.toMatch(word(F));
  });
  it('SEVERAL mentions: written in one line, read in another, and again in a second assignment → all three lines go', () => {
    const r = cut(wrap(
      assignment('Set', item('acct.Region__c', null, 'EMEA') + item('note', 'acct.Region__c') + item('acct.Description', null, 'x'), 'Set2'),
      assignment('Set2', item('note', 'acct.Name') + item('acct.Region__c', 'acct.BillingCountry'), 'Done')));
    expect(count(r.xmlBefore, F)).toBe(3);
    expect(r.n).toBe(3);
    expect(r.after.assignments.find(a => a.name === 'Set').assignmentItems.map(i => i.assignToReference)).toEqual(['acct.Description']);
    expect(r.after.assignments.find(a => a.name === 'Set2').assignmentItems.map(i => i.assignToReference)).toEqual(['note']);
    expect(onlyLinesGone(r.xmlBefore, r.xml)).toBe(true);
    expectClean(r);
    expect(r.preview.emptied).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('GET RECORDS', () => {
  const lookup = (inner, object = 'Account', logic = 'and') => `    <recordLookups>
        <name>Find</name>
        <label>Find</label>
        <locationX>176</locationX><locationY>134</locationY>
        <assignNullValuesIfNoRecordsFound>false</assignNullValuesIfNoRecordsFound>
        <connector><targetReference>Done</targetReference></connector>
        <filterLogic>${logic}</filterLogic>${inner}
        <getFirstRecordOnly>true</getFirstRecordOnly>
        <object>${object}</object>
    </recordLookups>`;
  const wrap = l => flowXml('Auto', 'AutoLaunchedFlow', [startPlain('Find'), l, DONE, NOTE].join('\n'));
  it('ONE mention: a filter condition (one of two) → it goes', () => {
    const r = cut(wrap(lookup(filter('Name', 'Acme', 'StartsWith') + filter(F))));
    expect(count(r.xmlBefore, F)).toBe(1);
    expect(r.n).toBe(1);
    const want = clone(r.before); want.recordLookups[0].filters.splice(1, 1);
    expect(r.after).toEqual(want);
    expect(onlyLinesGone(r.xmlBefore, r.xml)).toBe(true);
    expectClean(r);
    expect(r.preview.removed).toEqual([expect.objectContaining({ kind: 'Get Records', name: 'Find', where: 'filter condition 2' })]);
  });
  it('ONE mention: a queried field → that one name goes, the other queried fields stay', () => {
    const r = cut(wrap(lookup(`${filter('Name', 'Acme')}
        <queriedFields>Id</queriedFields>
        <queriedFields>Region__c</queriedFields>
        <queriedFields>Name</queriedFields>`)));
    expect(r.n).toBe(1);
    expect(r.after.recordLookups[0].queriedFields).toEqual(['Id', 'Name']);
    expect(onlyLinesGone(r.xmlBefore, r.xml)).toBe(true);
    expect(r.xmlBefore.split('\n').length - r.xml.split('\n').length).toBe(1);
    expectClean(r);
  });
  it('SEVERAL mentions: a filter, a queried field and an output assignment → all three go in one pass', () => {
    const r = cut(wrap(lookup(`${filter('Name', 'Acme') + filter(F)}
        <outputAssignments><assignToReference>note</assignToReference><field>Region__c</field></outputAssignments>
        <outputAssignments><assignToReference>note</assignToReference><field>Name</field></outputAssignments>
        <queriedFields>Id</queriedFields>
        <queriedFields>Region__c</queriedFields>`)));
    expect(count(r.xmlBefore, F)).toBe(3);
    expect(r.n).toBe(3);
    expect(r.after.recordLookups[0].filters.map(f => f.field)).toEqual(['Name']);
    expect(r.after.recordLookups[0].outputAssignments.map(a => a.field)).toEqual(['Name']);
    expect(r.after.recordLookups[0].queriedFields).toEqual(['Id']);
    expect(onlyLinesGone(r.xmlBefore, r.xml)).toBe(true);
    expectClean(r);
  });
  it('SEVERAL mentions, one cannot go: "sort by the field" is not rewritten → the filter goes, the sort stays and is reported', () => {
    const r = cut(wrap(lookup(`${filter('Name', 'Acme') + filter(F)}
        <sortField>Region__c</sortField>
        <sortOrder>Asc</sortOrder>`)));
    expect(r.n).toBe(1);
    expect(r.after.recordLookups[0].sortField).toBe(F);
    expect(T.flowReferencesField(r.after)).toBe(true);
    expect(r.preview.remaining).toEqual([expect.objectContaining({ kind: 'Get Records', name: 'Find', value: F, where: 'sortField' })]);
  });
  it.skip('PRODUCT BUG: a numbered filterLogic on Get Records is left consistent after ✂', () => {
    const r = cut(wrap(lookup(filter('Name', 'Acme') + filter(F) + filter('Type', 'Customer'), 'Account', '1 AND (2 OR 3)')));
    expect(logicFits(r.after.recordLookups[0].filterLogic, r.after.recordLookups[0].filters.length)).toBe(true);
  });
  // PRODUCT BUG: refMatches() accepts the BARE name and any "….Region__c" whatever object the element works on.
  // ✂ on Account.Region__c also strips Contact.Region__c from a Get Records on Contact, and con.Region__c from an
  // assignment on a Contact variable. ⇄ Replace (sftkFlowReplaceField) tells them apart — see the REPLACE block.
  it.skip('PRODUCT BUG: ✂ on Account.Region__c leaves the same-named field of ANOTHER object alone', () => {
    const r = cut(flowXml('Auto', 'AutoLaunchedFlow', [startPlain('Find'),
      lookup(filter('LastName', 'Smith') + filter(F), 'Contact'),
      assignment('Done', item('con.Region__c', null, 'EMEA') + item('acct.Region__c', null, 'EMEA') + item('note', null, 'x')), NOTE, ACCT, CON].join('\n')));
    expect(r.after.recordLookups[0].filters.map(f => f.field)).toEqual(['LastName', F]);                                   // Contact.Region__c
    expect(r.after.assignments[0].assignmentItems.map(i => i.assignToReference)).toEqual(['con.Region__c', 'note']);       // only acct.Region__c went
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('UPDATE RECORDS', () => {
  const update = inner => `    <recordUpdates>
        <name>Upd</name>
        <label>Upd</label>
        <locationX>176</locationX><locationY>134</locationY>
        <connector><targetReference>Done</targetReference></connector>${inner}
        <object>Account</object>
    </recordUpdates>`;
  const wrap = u => flowXml('Auto', 'AutoLaunchedFlow', [startPlain('Upd'), u, DONE, NOTE, ACCT].join('\n'));
  it('ONE mention: one of two field values sets the field → that value goes', () => {
    const r = cut(wrap(update(`
        <filterLogic>and</filterLogic>${filter('Type', 'Customer')}${inAssign('Description', null, 'x')}${inAssign(F, null, 'EMEA')}`)));
    expect(count(r.xmlBefore, F)).toBe(1);
    expect(r.n).toBe(1);
    const want = clone(r.before); want.recordUpdates[0].inputAssignments.splice(1, 1);
    expect(r.after).toEqual(want);
    expect(onlyLinesGone(r.xmlBefore, r.xml)).toBe(true);
    expectClean(r);
    expect(r.preview.removed).toEqual([expect.objectContaining({ kind: 'Update Records', name: 'Upd', where: 'field value 2', what: 'Region__c = EMEA' })]);
  });
  it('ONE mention, the only field value: it goes and the element is named as left with nothing to set', () => {
    const r = cut(wrap(update(`
        <filterLogic>and</filterLogic>${filter('Type', 'Customer')}${inAssign(F, null, 'EMEA')}`)));
    expect(r.n).toBe(1);
    expect(r.preview.emptied).toEqual([expect.objectContaining({ kind: 'Update Records', name: 'Upd', part: 'inputAssignments' })]);
    expect(wellFormed(r.xml)).toBe(true);
  });
  it('SEVERAL mentions: a filter (one of two) and a field value (one of two) → both go, the element still filters and still sets', () => {
    const r = cut(wrap(update(`
        <filterLogic>and</filterLogic>${filter(F) + filter('Type', 'Customer')}${inAssign(F, null, 'APAC')}${inAssign('Description', null, 'x')}`)));
    expect(count(r.xmlBefore, F)).toBe(2);
    expect(r.n).toBe(2);
    expect(r.after.recordUpdates[0].filters.map(f => f.field)).toEqual(['Type']);
    expect(r.after.recordUpdates[0].inputAssignments.map(a => a.field)).toEqual(['Description']);
    expect(onlyLinesGone(r.xmlBefore, r.xml)).toBe(true);
    expectClean(r);
    expect(r.preview.emptied).toEqual([]);
  });
  it('SEVERAL mentions, one cannot go: the field copied INTO another field (the value side) is not taken out → reported as remaining', () => {
    const r = cut(wrap(update(`
        <filterLogic>and</filterLogic>${filter('Type', 'Customer')}${inAssign(F, null, 'APAC')}${inAssign('Description', 'acct.Region__c')}`)));
    expect(r.n).toBe(1);
    expect(r.after.recordUpdates[0].inputAssignments).toEqual([{ field: 'Description', value: { elementReference: 'acct.Region__c' } }]);
    expect(r.preview.remaining).toEqual([expect.objectContaining({ kind: 'Update Records', name: 'Upd', where: 'field value 1', value: 'acct.Region__c' })]);
  });
  it.skip('PRODUCT BUG: a numbered filterLogic on Update Records is left consistent after ✂', () => {
    const r = cut(wrap(update(`
        <filterLogic>1 AND (2 OR 3)</filterLogic>${filter('Type', 'Customer') + filter(F) + filter('Industry', 'Banking')}${inAssign('Description', null, 'x')}`)));
    expect(logicFits(r.after.recordUpdates[0].filterLogic, r.after.recordUpdates[0].filters.length)).toBe(true);
  });
  // PRODUCT BUG (same root as the Start one): the only filter of an Update / Delete Records goes without a word —
  // the element would act on EVERY record of the object if Salesforce took it; "emptied" does not name it.
  it.skip('PRODUCT BUG: the only filter of an Update Records is not taken out silently', () => {
    const r = cut(wrap(update(`
        <filterLogic>and</filterLogic>${filter(F)}${inAssign('Description', null, 'x')}`)));
    const leftAlone = r.n === 0 && r.preview.remaining.length === 1;
    const warned = r.preview.emptied.some(e => e.name === 'Upd');
    expect(leftAlone || warned).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('CREATE RECORDS', () => {
  const create = (name, inner, target = 'Done') => `    <recordCreates>
        <name>${name}</name>
        <label>${name}</label>
        <locationX>176</locationX><locationY>134</locationY>
        <connector><targetReference>${target}</targetReference></connector>${inner}
        <object>Account</object>
    </recordCreates>`;
  const wrap = (...c) => flowXml('Auto', 'AutoLaunchedFlow', [startPlain('New1'), ...c, DONE, NOTE].join('\n'));
  it('ONE mention: one of three field values → it goes', () => {
    const r = cut(wrap(create('New1', inAssign('Name', null, 'Acme') + inAssign(F, null, 'EMEA') + inAssign('Type', null, 'Customer'))));
    expect(count(r.xmlBefore, F)).toBe(1);
    expect(r.n).toBe(1);
    expect(r.after.recordCreates[0].inputAssignments.map(a => a.field)).toEqual(['Name', 'Type']);
    expect(onlyLinesGone(r.xmlBefore, r.xml)).toBe(true);
    expectClean(r);
    expect(r.preview.removed).toEqual([expect.objectContaining({ kind: 'Create Records', name: 'New1', where: 'field value 2' })]);
  });
  it('ONE mention, the only field value: the create is named as left with nothing to set', () => {
    const r = cut(wrap(create('New1', inAssign(F, null, 'EMEA'))));
    expect(r.n).toBe(1);
    expect(r.preview.emptied).toEqual([expect.objectContaining({ kind: 'Create Records', name: 'New1', part: 'inputAssignments' })]);
  });
  it('SEVERAL mentions: two creates each set the field → both values go, each create keeps its other values', () => {
    const r = cut(wrap(create('New1', inAssign('Name', null, 'Acme') + inAssign(F, null, 'EMEA'), 'New2'), create('New2', inAssign(F, null, 'APAC') + inAssign('Name', null, 'Beta'))));
    expect(count(r.xmlBefore, F)).toBe(2);
    expect(r.n).toBe(2);
    expect(r.after.recordCreates.map(c => c.inputAssignments.map(a => a.field))).toEqual([['Name'], ['Name']]);
    expect(onlyLinesGone(r.xmlBefore, r.xml)).toBe(true);
    expectClean(r);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('DELETE RECORDS', () => {
  const del = inner => flowXml('Auto', 'AutoLaunchedFlow', [startPlain('Del'), `    <recordDeletes>
        <name>Del</name>
        <label>Del</label>
        <locationX>176</locationX><locationY>134</locationY>
        <connector><targetReference>Done</targetReference></connector>
        <filterLogic>and</filterLogic>${inner}
        <object>Account</object>
    </recordDeletes>`, DONE, NOTE].join('\n'));
  it('ONE mention: one of two filters → it goes (the delete is wider now: the preview names the condition that went)', () => {
    const r = cut(del(filter(F) + filter('Type', 'Prospect')));
    expect(r.n).toBe(1);
    expect(r.after.recordDeletes[0].filters.map(f => f.field)).toEqual(['Type']);
    expect(onlyLinesGone(r.xmlBefore, r.xml)).toBe(true);
    expectClean(r);
    expect(r.preview.removed).toEqual([expect.objectContaining({ kind: 'Delete Records', name: 'Del', where: 'filter condition 1' })]);
  });
  it('SEVERAL mentions: two filters on the field, one on another → both go', () => {
    const r = cut(del(filter(F, 'EMEA', 'NotEqualTo') + filter('Type', 'Prospect') + filter(F, 'APAC', 'NotEqualTo')));
    expect(r.n).toBe(2);
    expect(r.after.recordDeletes[0].filters.map(f => f.field)).toEqual(['Type']);
    expectClean(r);
  });
  it.skip('PRODUCT BUG: the only filter of a Delete Records is not taken out silently (it would delete every record of the object)', () => {
    const r = cut(del(filter(F)));
    const leftAlone = r.n === 0 && r.preview.remaining.length === 1;
    const warned = r.preview.emptied.some(e => e.name === 'Del');
    expect(leftAlone || warned).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('FORMULAS', () => {
  const formula = (name, type, expr) => `    <formulas><name>${name}</name><dataType>${type}</dataType><expression>${expr}</expression></formulas>`;
  const wrap = (...f) => flowXml('RT', 'AutoLaunchedFlow', [startRT('Done'), DONE, NOTE, ...f].join('\n'));
  it('ONE mention: a yes/no formula with another test → the field’s operand goes, the formula still tests something', () => {
    const r = cut(wrap(formula('Ok', 'Boolean', 'AND(ISBLANK({!$Record.Region__c}), {!$Record.Name} = &quot;Acme&quot;)')));
    expect(count(r.xmlBefore, F)).toBe(1);
    expect(r.n).toBe(1);
    expect(r.after.formulas[0].expression).toBe('{!$Record.Name} = "Acme"');
    const want = clone(r.before); want.formulas[0].expression = '{!$Record.Name} = "Acme"';
    expect(r.after).toEqual(want);
    expectClean(r);
    expect(r.preview.removed).toEqual([expect.objectContaining({ kind: 'Formula', name: 'Ok', where: 'its formula text' })]);
  });
  it('ONE mention, REFUSED: the formula is all about the field → left as it is and reported', () => {
    const r = cut(wrap(formula('Ok', 'Boolean', 'ISBLANK({!$Record.Region__c})')));
    expect(r.n).toBe(0);
    expect(r.after).toEqual(r.before);
    expect(r.preview.remaining).toEqual([expect.objectContaining({ kind: 'Formula', name: 'Ok', where: 'its formula text' })]);
  });
  it('ONE mention, REFUSED: a text formula is never rewritten', () => {
    const r = cut(wrap(formula('Txt', 'String', '{!$Record.Region__c} &amp; &quot; region&quot;')));
    expect(r.n).toBe(0);
    expect(r.xml).toBe(r.xmlBefore);
    expect(r.preview.remaining).toHaveLength(1);
  });
  it('SEVERAL mentions in one yes/no formula → every operand of the field goes in one pass', () => {
    const r = cut(wrap(formula('Ok', 'Boolean', 'AND({!$Record.Region__c} = &quot;EMEA&quot;, NOT(ISBLANK({!$Record.Region__c})), {!$Record.AnnualRevenue} &gt; 1000)')));
    expect(count(r.xmlBefore, F)).toBe(2);
    expect(r.n).toBe(2);
    expect(r.after.formulas[0].expression).toBe('{!$Record.AnnualRevenue} > 1000');
    expectClean(r);
  });
  it('SEVERAL mentions across formulas, one cannot go: the yes/no one is rewritten, the text one stays and is reported', () => {
    const r = cut(wrap(formula('Ok', 'Boolean', 'AND(ISBLANK({!$Record.Region__c}), {!$Record.Name} = &quot;Acme&quot;)'), formula('Txt', 'String', 'UPPER({!$Record.Region__c})')));
    expect(r.n).toBe(1);
    expect(r.after.formulas[1]).toEqual(r.before.formulas[1]);
    expect(r.preview.remaining).toEqual([expect.objectContaining({ name: 'Txt' })]);
  });
  it('a longer field name that ends with the same letters is not touched', () => {
    const r = cut(wrap(formula('Ok', 'Boolean', 'AND(ISBLANK({!$Record.Sub_Region__c}), {!$Record.Name} = &quot;Acme&quot;)')));
    expect(r.n).toBe(0);
    expect(r.xml).toBe(r.xmlBefore);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('SCREEN FLOW — screen components', () => {
  const input = (name, ref) => `
        <fields>
            <name>${name}</name>
            <fieldType>ObjectProvided</fieldType>
            <isRequired>false</isRequired>
            <objectFieldReference>${ref}</objectFieldReference>
        </fields>`;
  const screen = (name, fields, target = 'Done') => `    <screens>
        <name>${name}</name>
        <label>${name}</label>
        <locationX>176</locationX><locationY>134</locationY>
        <allowBack>true</allowBack>
        <allowFinish>true</allowFinish>
        <allowPause>false</allowPause>
        <connector><targetReference>${target}</targetReference></connector>${fields}
        <showFooter>true</showFooter>
        <showHeader>true</showHeader>
    </screens>`;
  const wrap = (...s) => flowXml('Screen', 'Flow', [startPlain('Edit'), ...s, DONE, NOTE, ACCT].join('\n'));
  it('ONE mention: a record field on the screen (one of two) → the component goes, the other stays', () => {
    const r = cut(wrap(screen('Edit', input('Name_In', 'acct.Name') + input('Region_In', 'acct.Region__c'))));
    expect(count(r.xmlBefore, F)).toBe(1);
    expect(r.n).toBe(1);
    expect(r.after.screens[0].fields.map(f => f.name)).toEqual(['Name_In']);
    const want = clone(r.before); want.screens[0].fields.splice(1, 1);
    expect(r.after).toEqual(want);
    expect(onlyLinesGone(r.xmlBefore, r.xml)).toBe(true);
    expectClean(r);
    expect(r.preview.removed).toEqual([expect.objectContaining({ kind: 'Screen', name: 'Edit', where: 'a screen component' })]);
  });
  it('ONE mention inside a section column → found two levels down, the section and its other field stay', () => {
    const r = cut(wrap(screen('Edit', `
        <fields>
            <name>Edit_Section1</name>
            <fieldType>RegionContainer</fieldType>
            <fields>
                <name>Edit_Section1_Column1</name>
                <fieldType>Region</fieldType>
                <fields><name>Name_In</name><fieldType>ObjectProvided</fieldType><isRequired>false</isRequired><objectFieldReference>acct.Name</objectFieldReference></fields>
                <fields><name>Region_In</name><fieldType>ObjectProvided</fieldType><isRequired>false</isRequired><objectFieldReference>acct.Region__c</objectFieldReference></fields>
            </fields>
            <isRequired>false</isRequired>
            <regionContainerType>SectionWithoutHeader</regionContainerType>
        </fields>`)));
    expect(r.n).toBe(1);
    expect(r.after.screens[0].fields[0].fields[0].fields.map(f => f.name)).toEqual(['Name_In']);
    expect(onlyLinesGone(r.xmlBefore, r.xml)).toBe(true);
    expectClean(r);
  });
  it('SEVERAL mentions: the field on two screens → both components go', () => {
    const r = cut(wrap(screen('Edit', input('Name_In', 'acct.Name') + input('Region_In', 'acct.Region__c'), 'Confirm'), screen('Confirm', input('Region_Again', 'acct.Region__c') + input('Type_In', 'acct.Type'))));
    expect(count(r.xmlBefore, F)).toBe(2);
    expect(r.n).toBe(2);
    expect(r.after.screens.map(s => s.fields.map(f => f.name))).toEqual([['Name_In'], ['Type_In']]);
    expect(onlyLinesGone(r.xmlBefore, r.xml)).toBe(true);
    expectClean(r);
  });
  it('SEVERAL mentions, one cannot go: a display text that merges the field is not rewritten → the input goes, the text is reported', () => {
    const r = cut(wrap(screen('Edit', `${input('Region_In', 'acct.Region__c')}
        <fields>
            <name>Shown</name>
            <fieldText>&lt;p&gt;Region: {!acct.Region__c}&lt;/p&gt;</fieldText>
            <fieldType>DisplayText</fieldType>
        </fields>`)));
    expect(r.n).toBe(1);
    expect(r.after.screens[0].fields.map(f => f.name)).toEqual(['Shown']);
    expect(T.flowReferencesField(r.after)).toBe(true);
    expect(r.preview.remaining).toEqual([expect.objectContaining({ kind: 'Screen', name: 'Edit', where: 'a screen component' })]);
    expect(wellFormed(r.xml)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('AUTOLAUNCHED FLOW — actions, subflows, loops', () => {
  it('SEVERAL mentions: an action input, a subflow input and an assignment → all three go, the action and the subflow stay', () => {
    const r = cut(flowXml('Auto', 'AutoLaunchedFlow', [startPlain('Post'),
      `    <actionCalls>
        <name>Post</name>
        <label>Post</label>
        <locationX>176</locationX><locationY>134</locationY>
        <actionName>chatterPost</actionName>
        <actionType>chatterPost</actionType>
        <connector><targetReference>Sub</targetReference></connector>
        <inputParameters><name>subjectNameOrId</name><value><elementReference>acct.Id</elementReference></value></inputParameters>
        <inputParameters><name>text</name><value><elementReference>acct.Region__c</elementReference></value></inputParameters>
    </actionCalls>`,
      `    <subflows>
        <name>Sub</name>
        <label>Sub</label>
        <locationX>176</locationX><locationY>250</locationY>
        <connector><targetReference>Done</targetReference></connector>
        <flowName>Other_Flow</flowName>
        <inputAssignments><name>region</name><value><elementReference>acct.Region__c</elementReference></value></inputAssignments>
        <inputAssignments><name>accountId</name><value><elementReference>acct.Id</elementReference></value></inputAssignments>
    </subflows>`,
      assignment('Done', item('note', 'acct.Region__c') + item('note', null, 'x')), NOTE, ACCT].join('\n')));
    expect(count(r.xmlBefore, F)).toBe(3);
    expect(r.n).toBe(3);
    expect(r.after.actionCalls[0].inputParameters.map(p => p.name)).toEqual(['subjectNameOrId']);
    expect(r.after.subflows[0].inputAssignments.map(p => p.name)).toEqual(['accountId']);
    expect(r.after.assignments[0].assignmentItems).toHaveLength(1);
    expect(onlyLinesGone(r.xmlBefore, r.xml)).toBe(true);
    expectClean(r);
  });
  it('ONE mention the tool does not take out at all (a text template) → no change, reported, and the run refuses with "Nothing was deleted"', () => {
    const r = cut(flowXml('Auto', 'AutoLaunchedFlow', [startPlain('Done'), DONE, NOTE, ACCT,
      '    <textTemplates><name>Body</name><isViewedAsPlainText>true</isViewedAsPlainText><text>Region is {!acct.Region__c}</text></textTemplates>'].join('\n')));
    expect(r.n).toBe(0);
    expect(r.xml).toBe(r.xmlBefore);
    expect(r.preview.remaining).toEqual([expect.objectContaining({ kind: 'Text Template', name: 'Body', where: 'its text' })]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('the 🔍 inspector’s "remove selected": only the ticked blocks go', () => {
  it('two of three blocks ticked → exactly those two, the third still there', () => {
    const md = parseFlow(flowXml('Auto', 'AutoLaunchedFlow', [startRT('Set', filter(F) + filter('Type', 'Customer')),
      assignment('Set', item('$Record.Region__c', null, 'EMEA') + item('note', '$Record.Region__c') + item('note', null, 'x'), 'Done'), DONE, NOTE].join('\n')));
    // blocks are numbered in document order of the metadata: start filter (0), then the two assignment lines (1, 2)
    const n = T._removeSelectedFlowBlocks(md, new Set([0, 2]));
    expect(n).toBe(2);
    expect(md.start.filters.map(f => f.field)).toEqual(['Type']);
    expect(md.assignments[0].assignmentItems.map(i => i.assignToReference)).toEqual(['$Record.Region__c', 'note']);
    expect(T.flowReferencesField(md)).toBe(true);
    expect(wellFormed(T.buildFlowXml(md))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('⇄ REPLACE — every mention becomes the new field', () => {
  it('record-triggered: entry condition, decision (both sides), queried field, sort field, formula (twice) → seven places, nothing removed, numbered logic untouched', () => {
    const before = parseFlow(flowXml('RT', 'AutoLaunchedFlow', [
      startRT('Check', filter(F) + filter('Type', 'Customer'), '1 AND 2'),
      decision('Check', rule('A', '1 AND (2 OR 3)', cond('$Record.Region__c') + condRef('$Record.Name', '$Record__Prior.Region__c') + cond('$Record.Industry', 'Banking'), 'Find')),
      `    <recordLookups>
        <name>Find</name>
        <label>Find</label>
        <locationX>176</locationX><locationY>134</locationY>
        <connector><targetReference>Done</targetReference></connector>
        <filterLogic>and</filterLogic>${filter('Name', 'Acme')}
        <object>Account</object>
        <queriedFields>Id</queriedFields>
        <queriedFields>Region__c</queriedFields>
        <sortField>Region__c</sortField>
        <sortOrder>Asc</sortOrder>
    </recordLookups>`,
      DONE, NOTE,
      '    <formulas><name>Txt</name><dataType>String</dataType><expression>{!$Record.Region__c} &amp; &quot; / &quot; &amp; {!Find.Region__c}</expression></formulas>',
    ].join('\n')));
    const after = clone(before);
    const res = R.sftkFlowReplaceField(after, OBJ, F, NF);
    expect(res.skipped).toEqual([]); expect(res.needs).toEqual([]);
    expect(res.changed.reduce((n, c) => n + c.n, 0)).toBe(count(T.buildFlowXml(before), F));
    expect(res.changed.reduce((n, c) => n + c.n, 0)).toBe(7);
    const xml = T.buildFlowXml(after);
    expect(xml).not.toMatch(word(F));
    expect(count(xml, NF)).toBe(7);
    expect(T.flowReferencesField(after)).toBe(false);
    // the swap is the ONLY difference: put the old name back and the file is the one we started from
    expect(xml.replace(new RegExp(NF, 'g'), F)).toBe(T.buildFlowXml(before));
    expect(after.start.filterLogic).toBe('1 AND 2');
    expect(after.decisions[0].rules[0].conditionLogic).toBe('1 AND (2 OR 3)');
    expect(wellFormed(xml)).toBe(true);
  });
  it('screen flow: record variable in two screen components and an assignment → all three; the same name on a Contact variable is left alone and said', () => {
    const before = parseFlow(flowXml('Screen', 'Flow', [startPlain('Edit'),
      `    <screens>
        <name>Edit</name>
        <label>Edit</label>
        <locationX>176</locationX><locationY>134</locationY>
        <connector><targetReference>Done</targetReference></connector>
        <fields><name>R1</name><fieldType>ObjectProvided</fieldType><objectFieldReference>acct.Region__c</objectFieldReference></fields>
        <fields><name>R2</name><fieldType>ObjectProvided</fieldType><objectFieldReference>con.Region__c</objectFieldReference></fields>
        <fields><name>T1</name><fieldText>&lt;p&gt;{!acct.Region__c}&lt;/p&gt;</fieldText><fieldType>DisplayText</fieldType></fields>
    </screens>`,
      assignment('Done', item('note', 'acct.Region__c')), NOTE, ACCT, CON].join('\n')));
    const after = clone(before);
    const res = R.sftkFlowReplaceField(after, OBJ, F, NF);
    expect(res.changed.reduce((n, c) => n + c.n, 0)).toBe(3);
    expect(after.screens[0].fields.map(f => f.objectFieldReference || f.fieldText)).toEqual([`acct.${NF}`, 'con.Region__c', `<p>{!acct.${NF}}</p>`]);
    expect(after.assignments[0].assignmentItems[0].value.elementReference).toBe(`acct.${NF}`);
    expect(res.skipped).toEqual([expect.objectContaining({ value: 'con.Region__c', why: 'other', object: 'Contact' })]);
    expect(count(T.buildFlowXml(after), F)).toBe(1);
  });
  it('a Get Records on ANOTHER object with the same field name is not swapped', () => {
    const before = parseFlow(flowXml('Auto', 'AutoLaunchedFlow', [startPlain('Find'), `    <recordLookups>
        <name>Find</name>
        <label>Find</label>
        <locationX>176</locationX><locationY>134</locationY>
        <connector><targetReference>Done</targetReference></connector>
        <filterLogic>and</filterLogic>${filter(F)}
        <object>Contact</object>
    </recordLookups>`, DONE, NOTE].join('\n')));
    const after = clone(before);
    const res = R.sftkFlowReplaceField(after, OBJ, F, NF);
    expect(res.changed).toEqual([]);
    expect(after).toEqual(before);
    expect(res.skipped).toEqual([expect.objectContaining({ why: 'other', object: 'Contact' })]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('PROCESS BUILDER — told apart, never rewritten, deleted as a whole', () => {
  // the shape Salesforce returns for a process: processType Workflow, myVariable_current, a criteria node as a decision
  const PB_INNER = `<fullName>Account_Region_Process</fullName>
    <apiVersion>62.0</apiVersion>
    <decisions>
        <processMetadataValues><name>index</name><value><numberValue>0.0</numberValue></value></processMetadataValues>
        <name>myDecision</name>
        <label>myDecision</label>
        <locationX>50</locationX><locationY>0</locationY>
        <defaultConnectorLabel>default</defaultConnectorLabel>
        <rules>
            <name>myRule_1</name>
            <conditionLogic>and</conditionLogic>
            <conditions>
                <processMetadataValues><name>inputDataType</name><value><stringValue>String</stringValue></value></processMetadataValues>
                <processMetadataValues><name>leftHandSideType</name><value><stringValue>Picklist</stringValue></value></processMetadataValues>
                <leftValueReference>myVariable_current.Region__c</leftValueReference>
                <operator>EqualTo</operator>
                <rightValue><stringValue>EMEA</stringValue></rightValue>
            </conditions>
            <connector><targetReference>myRule_1_A1</targetReference></connector>
            <label>Is EMEA</label>
        </rules>
    </decisions>
    <interviewLabel>Account_Region_Process-1_InterviewLabel</interviewLabel>
    <label>Account Region Process</label>
    <processMetadataValues><name>ObjectType</name><value><stringValue>Account</stringValue></value></processMetadataValues>
    <processMetadataValues><name>ObjectVariable</name><value><elementReference>myVariable_current</elementReference></value></processMetadataValues>
    <processMetadataValues><name>OldObjectVariable</name><value><elementReference>myVariable_old</elementReference></value></processMetadataValues>
    <processMetadataValues><name>TriggerType</name><value><stringValue>onAllChanges</stringValue></value></processMetadataValues>
    <processType>Workflow</processType>
    <recordUpdates>
        <name>myRule_1_A1</name>
        <label>Stamp</label>
        <locationX>100</locationX><locationY>200</locationY>
        <filterLogic>and</filterLogic>
        <filters><field>Id</field><operator>EqualTo</operator><value><elementReference>myVariable_current.Id</elementReference></value></filters>
        <inputAssignments><field>Region__c</field><value><stringValue>APAC</stringValue></value></inputAssignments>
        <object>Account</object>
    </recordUpdates>
    <startElementReference>myDecision</startElementReference>
    <status>Active</status>
    <variables><name>myVariable_current</name><dataType>SObject</dataType><isCollection>false</isCollection><isInput>true</isInput><isOutput>true</isOutput><objectType>Account</objectType></variables>
    <variables><name>myVariable_old</name><dataType>SObject</dataType><isCollection>false</isCollection><isInput>true</isInput><isOutput>false</isOutput><objectType>Account</objectType></variables>`;
  const PB_ROWS = [{ MetadataComponentId: '301000000000022AAA', MetadataComponentName: 'Account Region Process' }, { MetadataComponentId: '301000000000021AAA', MetadataComponentName: 'Account Region Process' }];
  const PB_INFO = { '301000000000022': { defId: '300000000000009AAA', num: 2, status: 'Active', pb: true }, '301000000000021': { defId: '300000000000009AAA', num: 1, status: 'Obsolete', pb: true } };

  it('it is found like a flow: the scan’s mention test sees the field in its criteria and its action', () => {
    const md = parseFlow(`<Flow>${PB_INNER}</Flow>`);
    expect(md.processType).toBe('Workflow');
    expect(T.flowReferencesField(md)).toBe(true);
    expect(S.sftkFlowRefScan(md, T._fieldStringTester()).map(h => h.value)).toEqual(['myVariable_current.Region__c', 'Region__c']);
  });
  it('told apart by ProcessType: Workflow is "Process Builder" — and the card is marked pb', () => {
    expect(B.sftkFlowKindOf('', 'Workflow')).toBe('Process Builder');
    expect(B.sftkFlowKindOf('', 'AutoLaunchedFlow')).toBe('Autolaunched (no trigger)');
    expect(B.sftkFlowKindOf('', 'Flow')).toBe('Screen flow');
    expect(B.sftkFlowKindOf('RecordAfterSave', 'AutoLaunchedFlow')).toBe('After-save');
    // the line of _loadFlowVersionInfo that decides it, run as written
    const m = /_flowVerInfo\[String\(v\.Id\)\.substring\(0, 15\)\] = \{[^\n]*?pb: ([^\n]+?) \};/.exec(FC);
    expect(m).toBeTruthy();
    const isPb = new Function('v', `return (${m[1]});`);
    expect(isPb({ ProcessType: 'Workflow' })).toBe(true);
    expect(isPb({ ProcessType: 'AutoLaunchedFlow' })).toBe(false);
    expect(isPb({ ProcessType: 'Flow' })).toBe(false);
    const cards = T.cardsOf(PB_ROWS, PB_INFO);
    expect(cards).toHaveLength(1);
    expect(cards[0].pb).toBe(true);
    expect(cards[0].active.num).toBe(2);
  });
  // PRODUCT BUG: only ProcessType 'Workflow' is marked pb. The two other Process Builder kinds — an invocable
  // process (InvocableProcess) and a platform-event process (CustomEvent), which sftkFlowKindOf itself calls
  // "Process Builder (…)" — pass for a flow, so their card gets ✂ / ⇄ and the remover would rewrite and redeploy them.
  it.skip('PRODUCT BUG: an invocable process and a platform-event process are Process Builder too', () => {
    const m = /_flowVerInfo\[String\(v\.Id\)\.substring\(0, 15\)\] = \{[^\n]*?pb: ([^\n]+?) \};/.exec(FC);
    const isPb = new Function('v', `return (${m[1]});`);
    expect(B.sftkFlowKindOf('', 'InvocableProcess')).toContain('Process Builder');
    expect(B.sftkFlowKindOf('', 'CustomEvent')).toContain('Process Builder');
    expect(isPb({ ProcessType: 'InvocableProcess' })).toBe(true);
    expect(isPb({ ProcessType: 'CustomEvent' })).toBe(true);
  });
  it('✂ and ⇄ are NOT offered: the card has one button, 🗑 Delete process — also with a replacement field chosen', () => {
    const cards = T.cardsOf(PB_ROWS, PB_INFO);
    for (const repl of ['', NF]) {
      const html = T.buttons(cards[0].primaryId, cards[0].name, repl);
      expect((html.match(/<button/g) || []).length).toBe(1);
      expect(html).toContain('🗑 Delete process'); expect(html).toContain('data-way="delete"');
      expect(html).not.toContain('✂'); expect(html).not.toContain('⇄');
    }
    expect(M.sftkMdEditWays('ProcessBuilder')).toBeNull();
    expect(M.sftkMdEditWays('Flow')).toBeNull();
    // a ✂ walk that reaches a process turns into the delete question, with this reason
    expect(FC).toContain('a Process Builder process is not rewritten here');
  });
  it('FULL DELETE: the spec is a Flow under flows/*.flow; the restore point is the process’s own XML, redeployable', () => {
    expect(M.sftkMdDeleteSpec('ProcessBuilder')).toEqual({ type: 'ProcessBuilder', mdType: 'Flow', folder: 'flows', suffix: 'flow', what: 'Process Builder process' });
    const files = M.sftkMdPackageFiles('ProcessBuilder', 'Account_Region_Process', PB_INNER);
    expect(files.map(f => f.name)).toEqual(['package.xml', 'flows/Account_Region_Process.flow']);
    expect(files[0].text).toContain('<members>Account_Region_Process</members>');
    expect(files[0].text).toContain('<name>Flow</name>');
    expect(files[0].text).not.toContain('ProcessBuilder');
    expect(files[1].text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata"')).toBe(true);
    expect(files[1].text).not.toContain('<fullName>');
    expect(wellFormed(files[1].text)).toBe(true);
    // the restore point is the process as it was: the same metadata, the field's criteria and action in it
    const back = parseFlow(files[1].text), was = parseFlow(`<Flow>${PB_INNER}</Flow>`); delete was.fullName;
    expect(back).toEqual(was);
  });
  it('FULL DELETE: every version goes through the Tooling API (switched off first when it runs) — no destructive manifest is built for a process', () => {
    const cards = T.cardsOf(PB_ROWS, PB_INFO);
    expect(cards[0].versions.map(v => v.id)).toEqual(['301000000000022AAA', '301000000000021AAA']);   // what plan.pb.versions carries
    expect(FC).toContain("pb: { defId, devName, versions: card.versions.slice(), active: !!card.active }");
    expect(FC).toContain('(plan.patch || plan.pb) ? null : _zipOf(sftkMdDestructiveFiles([[spec.mdType, fullName]]))');
    expect(FC).toContain("body: { Metadata: { activeVersionNumber: 0 } }");
    // were a manifest built for the spec's type, it would name the Flow, never "ProcessBuilder"
    const d = M.sftkMdDestructiveFiles([[M.sftkMdDeleteSpec('ProcessBuilder').mdType, 'Account_Region_Process']]);
    expect(d.map(f => f.name)).toEqual(['package.xml', 'destructiveChangesPost.xml']);
    expect(d[1].text).toContain('<members>Account_Region_Process</members>\n        <name>Flow</name>');
    expect(d[0].text).not.toContain('<types>');
  });
});
