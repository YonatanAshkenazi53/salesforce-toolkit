import vm from 'node:vm';
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
    // 2026-11-15 (owner): an unavailable way is not drawn greyed out — its reason sits in one folded line
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('not available');
    expect((html.match(/name="fcActiveMode"/g) || []).length).toBe(2);   // the outcomes way and switch-off
    expect(html).toContain('value="replace" data-outcomes="1">');   // the outcomes way stays offered
    const why = html.slice(html.indexOf('fc-opt-whynot'));
    expect(why).toContain('Why can’t the flow keep running?');
    expect(why).toContain('Salesforce refuses a version like that');
    expect(html).toContain('choose what happens to it');
  });
  it('when no way keeps the flow running: one card (switch off), both reasons folded, the heading says so', () => {
    const html = new Function('fp', `const esc = s => String(s == null ? '' : s);
      ${nested('_flowChoiceHtml')}\nreturn _flowChoiceHtml(fp, 'F', false, '');`)({
      builderUrl: null, plan: { active: { num: 3 }, expectNew: 4 },
      preview: { removed: [], remaining: [{ kind: 'Decision', name: 'D', where: 'x', value: 'v' }], emptied: [] },
      previewOutcomes: { empty: true, outcomes: [{ outcomeLabel: 'Is fixture', decisionLabel: 'Check Email', decisionGone: true }], remaining: [], disconnected: [], emptied: [] },
    });
    expect((html.match(/name="fcActiveMode"/g) || []).length).toBe(1);
    expect(html).toContain('name="fcActiveMode" value="delete"');
    expect(html).not.toContain('disabled');
    expect(html).toContain('the one way to clear it');
    const why = html.slice(html.indexOf('fc-opt-whynot'));
    expect(why).toContain('There is nothing the automatic fix can take out of this version.');
    expect(why).toContain('“Is fixture” of the decision “Check Email”');
  });
});

// 2026-11-15 (owner): after an edit in the ✎ editors — validate, then deploy. ✓ Validate is a check-only deploy.
describe('✓ Validate in the ✎ editors: the verdict of a check-only deploy', () => {
  const verdict = new Function('r', `const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    ${nested('_edValidateVerdict')}\nreturn _edValidateVerdict(r);`);
  it('accepted: says nothing was written', () => {
    const v = verdict({ success: true, checkOnly: true, failures: [] });
    expect(v.cls).toBe('fc-xml-ed-ok');
    expect(v.html).toContain('would accept');
    expect(v.html).toContain('nothing was written');
  });
  it('refused: Salesforce\'s own words, escaped, with the component named', () => {
    const v = verdict({ success: false, checkOnly: true, failures: [{ name: 'Account.R', type: 'ValidationRule', problem: 'Field <b>X__c</b> does not exist' }] });
    expect(v.cls).toBe('fc-xml-ed-err');
    expect(v.html).toContain('would refuse');
    expect(v.html).toContain('Account.R: Field &lt;b>X__c&lt;/b> does not exist');
  });
  it('a check that could not run is NOT called a refusal of the text', () => {
    for (const r of [{ error: 'Failed to fetch' }, null, { success: true }]) {
      const v = verdict(r);
      expect(v.cls).toBe('fc-xml-ed-err');
      expect(v.html).toContain('could not be run');
      expect(v.html).not.toContain('would accept');
    }
  });
  it('both metadata editors carry the button; the template editor (a record save) does not', () => {
    expect((FC.match(/class="btn btn-secondary btn-sm fc-xml-ed-validate"/g) || []).length).toBe(2);
  });
});

// 2026-11-15 (owner): "salesforce would accept the delete but i cant click the delete button" — the chips counted
// down to zero while the button's lock and Salesforce's answer box still counted the blockers of the scan.
describe('a cleared blocker is counted off the list the Delete button reads', () => {
  const count = new Function('list', 'type', `${nested('_afterDeleteCount')}\nreturn _afterDeleteCount(list, type);`);
  it('one less of that kind; a kind at zero leaves the list; other kinds untouched', () => {
    const l = [{ type: 'ValidationRule', label: 'VR', count: 2 }, { type: 'ApexClass', label: 'Apex', count: 1 }];
    expect(count(l, 'ValidationRule')).toEqual([{ type: 'ValidationRule', label: 'VR', count: 1 }, { type: 'ApexClass', label: 'Apex', count: 1 }]);
    expect(count(count(l, 'ValidationRule'), 'ValidationRule')).toEqual([{ type: 'ApexClass', label: 'Apex', count: 1 }]);
    expect(count(l, 'Layout')).toEqual(l);
    expect(count(null, 'X')).toEqual([]);
    expect(l[0].count).toBe(2);   // the scan's own list is not mutated
  });
  it('_afterDelete feeds it, then lets Salesforce\'s check unlock Delete when nothing listed is left', () => {
    const i = FC.indexOf('function _afterDelete(type) {'), body = FC.slice(i, FC.indexOf('function _afterDeleteCount', i));
    expect(body).toContain('_manualBlockers = _afterDeleteCount(_manualBlockers, type);');
    expect(body).toMatch(/if \(left === 0 && !_manualBlockers\.length\) \{[\s\S]*checkEnableDelete\(\);/);
    expect(body).not.toContain('press Re-scan');
  });
});

// 2026-11-15 (owner): "we dont have undo for anything there" — every fixed row carries ↩ Undo
describe('a fixed row offers ↩ Undo; a row that was only settled does not', () => {
  const changed = new Function('label', `${nested('_fixedRowChanged')}\nreturn _fixedRowChanged(label);`);
  it('tells a change from a settle', () => {
    expect(changed('✅ Done')).toBe(true);
    expect(changed('✅ Removed — verified by re-reading the org')).toBe(true);
    expect(changed('✅ Nothing uses the field here — Salesforce lists it because its description mentions the name')).toBe(false);
    expect(changed('✅ No version of this flow references the field any more')).toBe(false);
  });
  it('markFixed draws the button and opens this tool\'s History', () => {
    const i = FC.indexOf('  function markFixed('), body = FC.slice(i, i + 1800);
    expect(body).toContain('fc-item-undo');
    expect(body).toContain("window.sftkToolHistoryOpen('fields')");
  });
});

// 2026-11-15 (owner): undo all for a field, with progress; and no "permanent" tick where an undo exists
describe('↩ Undo all for one field', () => {
  const H = read('sftk-history.js');
  // the real file, whole, in its own context (it touches chrome / document only when a function runs)
  const mk = () => { const ctx = vm.createContext({ console, setTimeout, Date, URL }); vm.runInContext(H + ';this.__x = { sftkHistoryUndoableFor, sftkHistoryUndoMany };', ctx); return ctx.__x; };
  const E = (id, at, o = {}) => ({ id, kind: 'tool', tool: 'Field Cleaner', targetOrg: 'https://a.my.salesforce.com', profileName: `📋 Layout — "L${id}" (Account.Status__c removed)`, subject: 'Account.Status__c', startedAt: at, toolUndo: { steps: [{ describe: 'x' }] }, ...o });
  it('lists what can still be undone for the field, newest first', () => {
    const { sftkHistoryUndoableFor } = mk();
    const all = [
      E('1', '2026-11-15T10:00:00Z'), E('2', '2026-11-15T10:05:00Z'),
      E('3', '2026-11-15T10:06:00Z', { subject: 'Account.Other__c' }),                       // another field
      E('4', '2026-11-15T10:07:00Z', { toolUndo: { none: 'deleted flow versions' } }),       // no undo
      E('5', '2026-11-15T10:08:00Z', { toolUndo: { steps: [{}], done: { ok: true } } }),     // already undone
      E('6', '2026-11-15T10:09:00Z', { targetOrg: 'https://b.my.salesforce.com' }),          // another org
      E('7', '2026-11-15T10:10:00Z', { tool: 'Flows' }),                                     // another tool
      E('8', '2026-11-15T10:11:00Z', { undoOf: '1' }),                                       // itself an undo
      E('9', '2026-11-15T09:00:00Z', { subject: '', profileName: '🧩 FlexiPage — "P" (Account.Status__c removed)' }),   // before entries carried a subject
      E('10', '2026-11-15T09:01:00Z', { subject: '', profileName: '🧩 FlexiPage — "P" (Account.Status__c_Old removed)' }), // a longer name is not this field
    ];
    const got = sftkHistoryUndoableFor(all, { tool: 'Field Cleaner', orgUrl: 'https://A.my.salesforce.com/', subject: 'Account.Status__c' });
    expect(got.map(e => e.id)).toEqual(['2', '1', '9']);
    expect(sftkHistoryUndoableFor(all, { tool: 'Field Cleaner', orgUrl: 'https://a.my.salesforce.com', subject: '' })).toEqual([]);
  });
  it('runs them in order with no dialog of their own; a failure does not stop the rest; no session does', async () => {
    const { sftkHistoryUndoMany } = mk();
    const list = [E('a', '3'), E('b', '2'), E('c', '1')], calls = [], seen = [];
    const res = await sftkHistoryUndoMany(list, {
      undo: async (id, o) => { calls.push([id, o.confirm]); return id === 'b' ? { ok: false, text: 'Salesforce refused', entry: {} } : { ok: true, text: 'Undone', entry: {} }; },
      onStart: (i, n, e) => seen.push(`start ${i + 1}/${n} ${e.id}`), onEnd: (i, n, e, r) => seen.push(`end ${e.id} ${r.ok}`),
    });
    expect(calls).toEqual([['a', false], ['b', false], ['c', false]]);
    expect(res).toMatchObject({ total: 3, ran: 3, ok: 2, stopped: '' });
    expect(res.failed.map(f => [f.entry.id, f.text])).toEqual([['b', 'Salesforce refused']]);
    expect(seen).toEqual(['start 1/3 a', 'end a true', 'start 2/3 b', 'end b false', 'start 3/3 c', 'end c true']);
    const stop = await sftkHistoryUndoMany(list, { undo: async id => id === 'b' ? { ok: false, text: 'Log in to a in a Salesforce tab first — the undo writes there.' } : { ok: true, entry: {} } });
    expect(stop).toMatchObject({ total: 3, ran: 1, ok: 1 });
    expect(stop.stopped).toContain('Log in to');
    const thrown = await sftkHistoryUndoMany([E('z', '1')], { undo: async () => { throw new Error('boom'); } });
    expect(thrown.failed[0].text).toBe('boom');
  });
  it('the summary says what was undone, what was not, and what was never tried', () => {
    const sum = new Function('res', `${nested('_undoAllSummary')}\nreturn _undoAllSummary(res);`);
    expect(sum({ total: 3, ran: 3, ok: 3, failed: [], stopped: '' })).toBe('✅ 3 of 3 changes undone and verified by re-reading the org.');
    expect(sum({ total: 3, ran: 3, ok: 2, failed: [{}], stopped: '' })).toBe('⚠ 2 of 3 changes undone and verified by re-reading the org · 1 not undone.');
    expect(sum({ total: 3, ran: 1, ok: 1, failed: [], stopped: 'Log in to a first' })).toContain('2 not tried — Log in to a first');
  });
  it('Field Cleaner stamps its entries with the picked field and draws the bar above the results', () => {
    expect(FC).toContain("sftkHistorySubjectFor('Field Cleaner', _fcSubject);");
    expect(FC.indexOf('<div id="fcUndoAll"></div>')).toBeLessThan(FC.indexOf('<div id="fcResults"></div>'));
    expect(FC).toContain('sftkProgress(host.querySelector(\'.fc-undoall-prog\')');
  });
  it('deleting a blocker component asks for no "permanent" tick — it has a restore point and an undo', () => {
    expect(FC).toContain("revOverride: { html: special, needsCheckbox: false, cls: 'sftk-rev-newver' },");
  });
});

// 2026-11-15 (live, fc-undo-all.mjs): with both blocking rules deleted, an open ✂ on a list view kept Delete locked
describe('only what blocks holds the Delete button', () => {
  const split = new Function('btns', 'sevOf', `${nested('_openRowSplit')}\nreturn _openRowSplit(btns, sevOf);`);
  const sev = t => ({ Flow: 'blocker', FlexiPage: 'blocker', Layout: 'silent', ListView: 'later' }[t] || 'blocker');
  it('counts rows, not buttons, and a row that only might break is not a blocker', () => {
    expect(split([{ id: '1', type: 'ListView' }, { id: '1', type: 'ListView' }, { id: '2', type: 'Layout' }], sev)).toEqual({ blockers: 0, soft: 2 });
    expect(split([{ id: '1', type: 'Flow' }, { id: '2', type: 'Layout' }], sev)).toEqual({ blockers: 1, soft: 1 });
    expect(split([], sev)).toEqual({ blockers: 0, soft: 0 });
  });
  it('checkEnableDelete asks Salesforce as soon as no blocker is open', () => {
    const i = FC.indexOf('  function checkEnableDelete() {'), body = FC.slice(i, i + 3200);
    expect(body).toContain('if (open.blockers === 0 && blockerTotal === 0) {');
    expect(body).toContain('askSalesforce({ settle:');
  });
});

// 2026-11-16: a path on another picklist that shows the field as a key field of a step was not listed
describe('a path that shows the field as a key field of a step', () => {
  const steps = new Function('md', 'same', `${FC.slice(FC.indexOf('function fcPathStepsWith('), FC.indexOf('function fcAskVerdict('))}\nreturn fcPathStepsWith(md, same);`);
  const same = f => f === 'SFTK_Pkg_Tag__c';
  it('names the steps that hold it, and only those', () => {
    const md = { fieldName: 'Stage__c', pathAssistantSteps: [
      { fieldNames: ['SFTK_Pkg_Tag__c'], picklistValueName: 'New' },
      { fieldNames: ['Other__c'], picklistValueName: 'Working' },
      { fieldNames: ['Other__c', 'SFTK_Pkg_Tag__c'], picklistValueName: 'Done' },
      { info: 'no fields', picklistValueName: 'Closed' }] };
    expect(steps(md, same)).toEqual(['New', 'Done']);
    expect(steps({ pathAssistantSteps: [{ fieldNames: 'SFTK_Pkg_Tag__c', picklistValueName: 'One' }] }, same)).toEqual(['One']);   // one field comes as a string
    expect(steps(null, same)).toEqual([]);
    expect(steps({}, same)).toEqual([]);
  });
  it('the scan reads the steps of a path that does not run on the field', () => {
    const i = FC.indexOf("msg('Scanning Paths…');"), body = FC.slice(i, i + 1600);
    expect(body).toContain('fcPathStepsWith(one[0] && one[0].Metadata, sameField)');
    expect(body).toContain("} catch (e) { miss('Paths', e); }");
  });
});
