// Release QA 2026-11-14 — Field Cleaner: the twelve confirmed findings, one regression test (or more) each.
// Every fix goes the SAFE direction: say a failure instead of guessing, never report done when it is not.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const FC = read('field-cleaner.js');

// an inner function of the FieldCleaner module (two-space indent, closes with "\n  }")
const nested = name => {
  const at = FC.indexOf(`\n  function ${name}(`) >= 0 ? FC.indexOf(`\n  function ${name}(`) : FC.indexOf(`\n  async function ${name}(`);
  if (at < 0) throw new Error(`not found in field-cleaner.js: ${name}`);
  return FC.slice(at + 1, FC.indexOf('\n  }\n', at + 1) + 4);
};
const body = name => nested(name);

const S = extractFunctions('sftk-sweep.js', ['sftkSweepForms', 'sftkSweepHits', 'sftkSweepKindTable', 'sftkSweepSections', '_sftkSweepSectionAt',
  'sftkSweepKind', 'sftkSweepRun', 'sftkSweepJoinKind']);
const H = extractFunctions('sftk-history.js', ['sftkUndoVerifyEval', '_sftkHistPick']);
const M = extractFunctions('sftk-mdapi.js', ['sftkFormulaDropField', '_sftkMdSwapToken']);
const R = new Function(`${read('sftk-fieldreplace.js')}\nreturn { sftkFlowReplaceField, sftkFlowResourceObjects };`)();

// ── 1. the full metadata text scan: another object's same-named field is not a blocker ──────────────────────────
describe('1. sweep: a same-named field of ANOTHER object is 👀, never a 🔒 that joins the list', () => {
  const forms = S.sftkSweepForms('Account', 'Status__c');
  const NL = String.fromCharCode(10);
  // multi-line, as a retrieve writes them: a hit is placed by the offset of its line
  const CONTACT = ['<CustomObject>', '<validationRules>', '<fullName>Need_Status</fullName>', '<active>true</active>', '<errorConditionFormula>ISBLANK(Status__c)</errorConditionFormula>', '</validationRules>',
    '<validationRules>', '<fullName>Acct_Status</fullName>', '<errorConditionFormula>ISBLANK(Account.Status__c)</errorConditionFormula>', '</validationRules>',
    '<listViews>', '<fullName>Mine</fullName>', '<columns>Status__c</columns>', '</listViews>', '</CustomObject>'].join(NL);
  const ACCOUNT = ['<CustomObject>', '<validationRules>', '<fullName>Own_Rule</fullName>', '<errorConditionFormula>ISBLANK(Status__c)</errorConditionFormula>', '</validationRules>', '</CustomObject>'].join(NL);
  const r = S.sftkSweepRun(new Map([
    ['unpackaged/objects/Contact.object', CONTACT],
    ['unpackaged/objects/Account.object', ACCOUNT],
    ['unpackaged/classes/C.cls', 'public class C { void f(Contact c) { c.Status__c = 1; } }'],
    ['unpackaged/classes/A.cls', 'public class A { void f(Account a) { a.Status__c = 1; } }'],
    ['unpackaged/workflows/Contact.workflow', ['<Workflow>', '<fieldUpdates>', '<fullName>FU</fullName>', '<field>Status__c</field>', '</fieldUpdates>', '</Workflow>'].join(NL)],
  ]), forms);
  it('the proof case: Contact.Need_Status and class C are no longer ValidationRule / ApexClass blockers', () => {
    const other = r.byType.SameNameOtherObject;
    expect(other).toMatchObject({ sev: 'mention' });
    expect(other.items.map(i => i.component).sort()).toEqual(['C', 'Contact.FU', 'Contact.Mine', 'Contact.Need_Status']);
    expect(S.sftkSweepJoinKind('SameNameOtherObject')).toBeNull();   // never joins the fix list
  });
  it('what does name OUR field stays a blocker: the own object, a qualified Account.Status__c, code that names Account', () => {
    expect(r.byType.ValidationRule.items.map(i => i.component).sort()).toEqual(['Account.Own_Rule', 'Contact.Acct_Status']);
    expect(r.byType.ApexClass.items.map(i => i.component)).toEqual(['A']);
    expect(r.byType.ValidationRule.sev).toBe('blocker');
    expect(r.hits.filter(h => h.sev === 'blocker').every(h => !/Need_Status|^C$/.test(h.component))).toBe(true);
  });
});

// ── 2. restore points: never pushed out by the run that made them, capped per org ─────────────────────────────────
describe('2. restore points: a flow with more than 20 versions keeps every one; one org never evicts another', () => {
  const _snapTrim = new Function(`${nested('_snapTrim')}\nreturn _snapTrim;`)();
  const now = 1_000_000_000_000, DAY = 24 * 3600 * 1000;
  it('25 points of one fix run (25 deleted flow versions) are all kept', () => {
    const list = Array.from({ length: 25 }, (_, i) => ({ at: now - i * 1000, orgKey: 'a', name: `F v${25 - i}` }));
    const k = _snapTrim(list, 20, now, DAY);
    expect(k.list).toHaveLength(25);
    expect(k.dropped).toBe(0);
  });
  it('older points are capped per org: org B’s fixes do not push out org A’s', () => {
    const oldA = Array.from({ length: 20 }, (_, i) => ({ at: now - 2 * DAY - i, orgKey: 'a' }));
    const oldB = Array.from({ length: 30 }, (_, i) => ({ at: now - 2 * DAY - i, orgKey: 'b' }));
    const k = _snapTrim([...oldB, ...oldA], 20, now, DAY);
    expect(k.list.filter(x => x.orgKey === 'a')).toHaveLength(20);
    expect(k.list.filter(x => x.orgKey === 'b')).toHaveLength(20);
    expect(k.dropped).toBe(10);
  });
  it('_snapshotFix keeps through _snapTrim, never a bare slice of one shared array', () => {
    const fn = body('_snapshotFix');
    expect(fn).toContain('_snapTrim(list, cap, Date.now(), SNAP_RUN_MS)');
    expect(fn).not.toContain('list.slice(0, cap)');
  });
});

// ── 3. the inspector does not settle a Lightning page that still names the field inside a longer value ──────────────
describe('3. inspector: a page named only inside a longer value is not "Nothing uses the field here"', () => {
  const T = new Function(`${nested('flexiPageReferencesField')}\n${nested('_flexiNamesBeyondText')}\nreturn { flexiPageReferencesField, _flexiNamesBeyondText };`)();
  it('the proof case: relatedListFieldAliases "NAME,Status__c" still names the field', () => {
    const md = { flexiPageRegions: [{ itemInstances: [{ componentInstance: { componentInstanceProperties: [{ name: 'relatedListFieldAliases', value: 'NAME,Status__c' }] } }] }] };
    expect(T._flexiNamesBeyondText(md, 'Account', 'Status__c')).toBe(true);
  });
  it('a page whose DESCRIPTION alone names it is still settled (the 2026-10-11 case)', () => {
    expect(T._flexiNamesBeyondText({ description: 'Shows Status__c', masterLabel: 'P', flexiPageRegions: [] }, 'Account', 'Status__c')).toBe(false);
  });
  it('the settle is guarded by it', () => {
    expect(FC).toContain("const stillNamed = type === 'FlexiPage' && _flexiNamesBeyondText(meta, _selObj?.api, _selField?.api);");
    expect(FC).toContain("        if (!stillNamed) markFixed(componentId, '✅ Nothing uses the field here");
  });
});

// ── 4. a scan leg that fails is said ─────────────────────────────────────────────────────────────────────────────
describe('4. matching rules, field updates and Lightning pages: a failed read is unread, not "none found"', () => {
  it('matching rules and workflow field updates go through sfQ (throws on error / incomplete → miss())', () => {
    const sup = FC.slice(FC.indexOf('// 4. Matching rules'), FC.indexOf("} catch (e) { miss('workflow field updates', e); }"));
    expect(sup).toContain('const mriRes = await sfQ(');
    expect(sup).toContain('const wfRes = await sfQ(');
    expect(sup).not.toContain('if (!mriRes?.error)');
  });
  it('scanFlexiPages names a page it could not read, and an incomplete page list', async () => {
    const src = nested('scanFlexiPages');
    const run = new Function('bg', 'flexiPageReferencesField', 'fcAbsentFeatureError', 'eid', `
      const _orgUrl = 'u', _sid = 's', _selObj = { api: 'Account' }, _selField = { api: 'Status__c' };
      ${src}
      return scanFlexiPages;`);
    const bg = async m => m.type === 'SF_QUERY_ALL'
      ? { records: [{ Id: '0M01', DeveloperName: 'Good' }, { Id: '0M02', DeveloperName: 'Bad', MasterLabel: 'Bad Page' }], incomplete: { got: 2, expected: 3 } }
      : m.id === '0M02' ? { error: 'HTTP 500: boom' } : { Metadata: {} };
    const hits = await run(bg, () => false, () => false, () => null)([]);
    expect(hits).toHaveLength(0);
    expect(hits.unread).toHaveLength(1);
    expect(hits.unread[0].leg).toBe('Lightning pages (2 could not be read)');
    expect(hits.unread[0].why).toContain('Bad Page: HTTP 500: boom');
    expect(hits.unread[0].why).toContain('incomplete (2 of 3)');
  });
});

// ── 5. the field's Id is the picked field's, not a packaged namesake's ─────────────────────────────────────────────
describe('5. resolveCustomFieldId reads NamespacePrefix and takes only the matching row', () => {
  const pick = new Function(`${nested('_pickOwnFieldRow')}\nreturn _pickOwnFieldRow;`)();
  const rows = [{ Id: '00Npkg', NamespacePrefix: 'ns' }, { Id: '00Nown', NamespacePrefix: null }];
  it('Foo__c → the org’s own row, wherever it sits in the answer', () => {
    expect(pick(rows, 'Foo__c')).toBe('00Nown');
    expect(pick([...rows].reverse(), 'Foo__c')).toBe('00Nown');
  });
  it('ns__Foo__c → the package’s row; an answer with only the other namespace gives nothing', () => {
    expect(pick(rows, 'ns__Foo__c')).toBe('00Npkg');
    expect(pick([rows[0]], 'Foo__c')).toBeNull();
  });
  it('every attempt selects NamespacePrefix and none takes records[0] blindly', () => {
    const fn = body('resolveCustomFieldId');
    expect(fn.match(/SELECT Id, NamespacePrefix FROM CustomField/g)).toHaveLength(4);
    expect(fn).not.toMatch(/records\[0\]\.Id/);
  });
});

// ── 6. an org switch resets the picker and everything below it ─────────────────────────────────────────────────────
describe('6. init() on an org switch drops the previous org’s objects, selection, scan and running loops', () => {
  const init = body('init');
  it('resets the per-org state and bumps the org generation', () => {
    for (const s of ['_orgGen++;', '_objectsLoaded = false;', '_allObjects = [];', '_objSearchDone.clear();', '_objSearchTried.clear();', '_selObj = null;', 'resetFieldAndBelow();'])
      expect(init).toContain(s);
  });
  it('answers asked of the old org drop themselves: the object list, its top-up, the field list and a running scan', () => {
    expect(FC.match(/if \(gen !== _orgGen\) return;/g).length).toBeGreaterThanOrEqual(4);
    expect(body('topUpObjects')).toContain('if (gen !== _orgGen) return;');
    expect(body('selectObject')).toContain('if (gen !== _orgGen) return;');
    expect(body('runScan')).toContain('if (gen !== _orgGen) return;');
  });
});

// ── 7 / 11. the History undo of a layout fix is a deploy, and it is re-read ───────────────────────────────────────
describe('7 + 11. layout undo: a Metadata deploy of the layout as it was, verified by readMetadata', () => {
  const step = new Function(`const buildLayoutZip = (n, md) => 'ZIP:' + n + ':' + JSON.stringify(md);
    const _rxEsc = s => String(s).replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    ${nested('_layoutUndoStep')}\nreturn _layoutUndoStep;`)();
  it('with a full name: SF_METADATA_DEPLOY + a readMetadata re-read that needs the field back', () => {
    const s = step('00h1', 'Account Layout', 'Account-Account Layout', { layoutSections: [] }, 'Account', 'Status__c');
    expect(s.msg.type).toBe('SF_METADATA_DEPLOY');
    expect(s.msg.zipBase64).toContain('ZIP:Account-Account Layout:');
    expect(s.verify.msg).toEqual({ type: 'SF_MD_READ', mdType: 'Layout', fullNames: ['Account-Account Layout'] });
    expect(H.sftkUndoVerifyEval(s.verify, { text: '<layoutItems><field>Status__c</field></layoutItems>' }).ok).toBe(true);
    expect(H.sftkUndoVerifyEval(s.verify, { text: '<layoutItems><field>Name</field></layoutItems>' }).ok).toBe(false);
  });
  it('without one: the PATCH stays, but it is re-read (never verify: null again)', () => {
    const s = step('00h1', 'L', '', { a: 1 }, 'Account', 'Status__c');
    expect(s.msg.type).toBe('SF_PATCH');
    expect(s.verify.path).toBe('services/data/v62.0/tooling/sobjects/Layout/00h1');
    expect(H.sftkUndoVerifyEval(s.verify, { Metadata: { a: 1 } }).ok).toBe(true);
    expect(body('fixLayout')).toContain('_layoutUndoStep(componentId, componentName, fullName, beforeMetadata, _selObj.api, _selField.api)');
    expect(body('fixLayout')).not.toContain('verify: null');
  });
});

// ── 8. a partial sample never says "never" or SAFE ────────────────────────────────────────────────────────────────
describe('8. data check: a sample that reached its limit is not the whole table', () => {
  const render = v => {
    const el = { className: '', innerHTML: '' };
    new Function('el', 'v', `const eid = () => el; let _dataVerdict = v; const _copyState = 1; const renderCopyValues = () => {};
      const _relAge = () => 'a year ago';
      ${nested('_renderDataVerdict')}\n_renderDataVerdict();`)(el, v);
    return el.innerHTML;
  };
  it('5,000 rows read, none holds a value: no SAFE, no "never"', () => {
    const h = render({ filled: 0, total: 5000, lastIso: null, sampled: true, partial: true, fillPct: 0 });
    expect(h).not.toContain('SAFE');
    expect(h).not.toContain('never');
    expect(h).toContain('unknown (only a sample was read)');
    expect(h).toContain('SAMPLE ONLY');
  });
  it('a sample under the limit IS the table: SAFE and "never" still hold', () => {
    const h = render({ filled: 0, total: 1200, lastIso: null, sampled: true, partial: false, fillPct: 0 });
    expect(h).toContain('SAFE');
    expect(h).toContain('never');
  });
  it('_sampleDataUsage marks a sample that reached its LIMIT as partial', () => {
    expect(body('_sampleDataUsage')).toContain('partial: rows.length >= 5000');
  });
});

// ── 9 / 10. flows: a queried field read elsewhere stays; another object's namesake is not "still mentions" ──────────
const rmAt = FC.indexOf('  function removeFieldRefs(metadata, objApi, fieldApi, opts) {');
const RM_SRC = FC.slice(rmAt, FC.indexOf('}', FC.indexOf('    return changes;', rmAt)) + 1);
const F9 = new Function('deps', `const { sftkFormulaDropField, sftkFlowResourceObjects } = deps;
  const _selField = { api: 'Region__c' };
  ${RM_SRC}
  ${nested('_flowLeftWhy')}
  ${nested('_flowProbeSaysThis')}
  return { removeFieldRefs, _flowLeftWhy, _flowProbeSaysThis };`)({ sftkFormulaDropField: M.sftkFormulaDropField, sftkFlowResourceObjects: R.sftkFlowResourceObjects });
const screenFlow = (lookupObj, name) => ({
  recordLookups: [{ name, label: name.replace('_', ' '), object: lookupObj, filterLogic: 'and', storeOutputAutomatically: true,
    filters: [{ field: 'Region__c', operator: 'EqualTo', value: { stringValue: 'x' } }, { field: 'Name', operator: 'EqualTo', value: { stringValue: 'y' } }],
    queriedFields: ['Id', 'Region__c'] }],
  screens: [{ name: 'S1', fields: [{ name: 'DT', fieldType: 'DisplayText', fieldText: `<p>{!${name}.Region__c}</p>` }] }],
});

describe('9. ✂ keeps a queried field that a merge field still reads through the lookup', () => {
  it('the proof case: the filter goes, queriedFields keeps Region__c, and the lookup is named as left', () => {
    const md = screenFlow('Account', 'Get_Account');
    const n = F9.removeFieldRefs(md, 'Account', 'Region__c', null);
    expect(n).toBe(1);   // the filter condition only
    expect(md.recordLookups[0].queriedFields).toEqual(['Id', 'Region__c']);
    expect(F9.removeFieldRefs.lastLeft.whole).toContainEqual(expect.objectContaining({ why: 'queried', via: 'Get_Account' }));
    expect(F9._flowLeftWhy(F9.removeFieldRefs.lastLeft)).toContain('{!Get_Account.Region__c} is read elsewhere');
  });
  it('with nothing else reading it, the queried field goes as before', () => {
    const md = screenFlow('Account', 'Get_Account');
    md.screens = [];
    expect(F9.removeFieldRefs(md, 'Account', 'Region__c', null)).toBe(2);
    expect(md.recordLookups[0].queriedFields).toEqual(['Id']);
  });
});

describe('10. a version that names only another object’s same-named field does not count for this one', () => {
  const probe = md => R.sftkFlowReplaceField(JSON.parse(JSON.stringify(md)), 'Account', 'Region__c', 'SFTK_Owner_Probe__c');
  it('Get_Contact.Region__c alone → not this field; Get_Account.Region__c → this field', () => {
    expect(F9._flowProbeSaysThis(probe(screenFlow('Contact', 'Get_Contact')))).toBe(false);
    expect(F9._flowProbeSaysThis(probe(screenFlow('Account', 'Get_Account')))).toBe(true);
  });
  it('a probe that places nothing on another object keeps the name-only "yes" (the safe direction)', () => {
    expect(F9._flowProbeSaysThis({ changed: [], skipped: [], needs: [] })).toBe(true);
    expect(F9._flowProbeSaysThis({ changed: [], skipped: [{ why: 'other' }, { why: 'unknown' }], needs: [] })).toBe(true);
  });
  it('the plan, the ✂ re-read and the old-version purge all ask the object-aware test', () => {
    expect(body('fixFlowPlan')).toContain('if (await _flowNamesThisField(read.Metadata)) referencing.push(v.Id);');
    expect(body('fixFlowExecute')).toContain('if (out.stillMentions && !swapping && check && check.Metadata) out.stillMentions = await _flowNamesThisField(check.Metadata);');
    expect(body('purgeOldFlowVersions')).toContain('if (!(await _flowNamesThisField(read.Metadata))) continue;');
  });
});

// ── 12. ✂ keep with outcomes: the plain way that would be refused is not offered ───────────────────────────────────
describe('12. flow ✂ keep on a flow with outcomes: the likely-refused plain way is refused up front or not offered', () => {
  it('clearing the card’s keep for the outcomes dialog still runs the refusal check', () => {
    expect(FC).toContain('const plainOff = keepAsked && !swap && replaceLikelyRefused;');
    expect(FC).toContain("if (plainOff && (pvO.empty || (pvO.emptied || []).length > 0)) preset = 'replace';");
    const i = FC.indexOf("if (plainOff && (pvO.empty");
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(FC.indexOf('if (preset === \'replace\' && !swap && replaceLikelyRefused) {'));
  });
  it('the dialog shows the plain way disabled, with why', () => {
    const html = new Function('fp', `const esc = s => String(s == null ? '' : s);
      ${nested('_flowChoiceHtml')}\nreturn _flowChoiceHtml(fp, 'F', true, '');`)({
      plainOff: true, builderUrl: null,
      plan: { active: { num: 3 }, expectNew: 4 },
      preview: { removed: [{ kind: 'Assignment', name: 'A1', where: 'x', what: 'y' }], remaining: [], emptied: [{ kind: 'Assignment', name: 'A1', where: 'x' }] },
      previewOutcomes: { outcomes: [{ outcomeLabel: 'O', decisionLabel: 'D' }], remaining: [], disconnected: [], emptied: [] },
    });
    expect(html).toContain('<input type="radio" name="fcActiveMode" value="replace" disabled>');
    expect(html).toContain('Salesforce refuses a version like that');
    expect(html).toContain('value="replace" data-outcomes="1">');   // the outcomes way stays offered
  });
});
