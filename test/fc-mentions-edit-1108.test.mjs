// The 👀 mentions get the ways too (user 2026-11-08: "why here we can't do anything? i want also email alerts,
// lightning email templates and classic email templates"): list views, compact layouts, quick actions and inactive
// validation rules through the XML edit engine; email templates (classic text / HTML, Lightning, Visualforce) through
// the EmailTemplate record's text fields. Pure helpers on hand-written shapes, plus the wiring pins.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../popup.html', import.meta.url), 'utf8');
const M = extractFunctions('sftk-mdapi.js', ['sftkMdEditField', 'sftkMdEditWays', 'sftkMdDeleteSpec', '_sftkMdDeleteTable', '_sftkMdFieldIs', '_sftkMdRenameVal', '_sftkMdWalk',
  '_sftkMdSwapToken', '_sftkMdHasLogic', 'sftkMdFindElement', 'sftkMdUnescape', 'sftkMdEscape', 'sftkMdChildText', 'sftkMdLeadMappingRemove', 'sftkMdMentionsField', 'sftkMdPackageFiles', '_sftkPkgXml', 'sftkMdRecordFileXml']);
const T = extractFunctions('sftk-emailtpl.js', ['sftkTplTextFields', '_sftkTplRx', 'sftkTplHits', 'sftkTplReplace', 'sftkTplRemove', 'sftkTplKind']);
const H = extractFunctions('sftk-history.js', ['sftkUndoVerifyEval', '_sftkHistPick']);
const O = 'Account', F = 'SFTK_Live_Blk__c', N = 'SFTK_Live_Blk2__c';
const rm = (t, x) => M.sftkMdEditField(t, x, O, F, null);
const rp = (t, x) => M.sftkMdEditField(t, x, O, F, N);

describe('the mention kinds in the XML engine', () => {
  it('are in the delete table with their ways; an inactive validation rule is a validation rule', () => {
    expect(M.sftkMdDeleteSpec('ListView')).toMatchObject({ parent: 'CustomObject', tag: 'listViews', what: 'list view', tooling: 'ListView' });
    expect(M.sftkMdDeleteSpec('CompactLayout')).toMatchObject({ parent: 'CustomObject', tag: 'compactLayouts', what: 'compact layout' });
    expect(M.sftkMdDeleteSpec('QuickAction')).toMatchObject({ folder: 'quickActions', suffix: 'quickAction', what: 'quick action' });
    expect(M.sftkMdDeleteSpec('ValidationRuleInactive')).toMatchObject({ mdType: 'ValidationRule', tag: 'validationRules' });
    expect(M.sftkMdEditWays('ListView')).toEqual({ remove: true, replace: true });
    expect(M.sftkMdEditWays('CompactLayout')).toEqual({ remove: true, replace: true });
    expect(M.sftkMdEditWays('QuickAction')).toEqual({ remove: true, replace: true });
    expect(M.sftkMdEditWays('ValidationRuleInactive')).toEqual({ remove: false, replace: true });
    // the package file of an inactive rule is the validation rule's
    const files = M.sftkMdPackageFiles('ValidationRuleInactive', 'Account.SFTK_Live_VR_Off', '<fullName>Account.SFTK_Live_VR_Off</fullName><active>false</active>');
    expect(files[0].text).toContain('<name>ValidationRule</name>');
    expect(files[1].name).toBe('objects/Account.object');
  });
  it('list view: ✂ takes the column and the filter out and keeps the rest; a numbered filter logic refuses ✂; ⇄ renames both', () => {
    const lv = `<fullName>Account.SFTK_Live_LV</fullName><columns>NAME</columns><columns>SFTK_Live_Blk__c</columns><columns>ACCOUNT.TYPE</columns><filterScope>Everything</filterScope><filters><field>ACCOUNT.TYPE</field><operation>equals</operation><value>Customer</value></filters><filters><field>SFTK_Live_Blk__c</field><operation>notEqual</operation><value></value></filters><label>SFTK Live LV</label>`;
    const r = rm('ListView', lv);
    expect(r.refused).toBeNull();
    expect(r.xml).toBe(`<fullName>Account.SFTK_Live_LV</fullName><columns>NAME</columns><columns>ACCOUNT.TYPE</columns><filterScope>Everything</filterScope><filters><field>ACCOUNT.TYPE</field><operation>equals</operation><value>Customer</value></filters><label>SFTK Live LV</label>`);
    expect(r.how[0]).toBe('1 column removed, 1 filter removed');
    const p = rp('ListView', lv);
    expect(p.xml).toContain('<columns>SFTK_Live_Blk2__c</columns>');
    expect(p.xml).toContain('<field>SFTK_Live_Blk2__c</field>');
    expect(p.xml).not.toMatch(/SFTK_Live_Blk__c/);
    expect(rm('ListView', lv + '<booleanFilter>1 AND 2</booleanFilter>').refused).toMatch(/filter logic numbers/);
    expect(rm('ListView', '<fullName>Account.X</fullName><columns>SFTK_Live_Blk__c</columns><label>x</label>').refused).toMatch(/only column/);
    expect(rm('ListView', '<fullName>Account.X</fullName><columns>NAME</columns>').refused).toMatch(/no column or filter/);
  });
  it('compact layout: ✂ takes the field out but not the last one; ⇄ renames it', () => {
    const cl = '<fullName>Account.SFTK_Live_CL</fullName><fields>Name</fields><fields>SFTK_Live_Blk__c</fields><label>SFTK Live CL</label>';
    expect(rm('CompactLayout', cl).xml).toBe('<fullName>Account.SFTK_Live_CL</fullName><fields>Name</fields><label>SFTK Live CL</label>');
    expect(rp('CompactLayout', cl).xml).toContain('<fields>SFTK_Live_Blk2__c</fields>');
    expect(rm('CompactLayout', '<fullName>Account.X</fullName><fields>SFTK_Live_Blk__c</fields><label>x</label>').refused).toMatch(/only field/);
  });
  it('quick action: ✂ takes the layout item and the predefined value out; ⇄ renames them', () => {
    const qa = '<fullName>Account.SFTK_Live_QA</fullName><fieldOverrides><field>SFTK_Live_Blk__c</field><formula>&quot;x&quot;</formula></fieldOverrides><label>SFTK Live QA</label><quickActionLayout><layoutSectionStyle>TwoColumnsLeftToRight</layoutSectionStyle><quickActionLayoutColumns><quickActionLayoutItems><emptySpace>false</emptySpace><field>Name</field><uiBehavior>Edit</uiBehavior></quickActionLayoutItems><quickActionLayoutItems><emptySpace>false</emptySpace><field>SFTK_Live_Blk__c</field><uiBehavior>Edit</uiBehavior></quickActionLayoutItems></quickActionLayoutColumns></quickActionLayout><type>Create</type>';
    const r = rm('QuickAction', qa);
    expect(r.refused).toBeNull();
    expect(r.xml).not.toMatch(/SFTK_Live_Blk__c/);
    expect(r.xml).toContain('<field>Name</field>');
    expect(r.how[0]).toBe('1 layout field removed, 1 predefined value removed');
    const p = rp('QuickAction', qa);
    expect((p.xml.match(/SFTK_Live_Blk2__c/g) || []).length).toBe(2);
  });
  it('an inactive validation rule: ⇄ swaps the formula, ✂ is refused (already inactive)', () => {
    const vr = '<fullName>Account.SFTK_Live_VR_Off</fullName><active>false</active><errorConditionFormula>ISBLANK(SFTK_Live_Blk__c)</errorConditionFormula><errorMessage>x</errorMessage>';
    expect(rp('ValidationRuleInactive', vr).xml).toContain('ISBLANK(SFTK_Live_Blk2__c)');
    expect(rm('ValidationRuleInactive', vr).refused).toMatch(/already inactive/);
  });
});

describe('email templates: the three storages through one record', () => {
  const classic = { TemplateType: 'text', UiType: 'Aloha', Subject: 'Hi {!Account.SFTK_Live_Blk__c}', Body: 'Hello {!Account.SFTK_Live_Blk__c}\nBye {!Account.Name}', HtmlValue: '', Markup: '' };
  const sfx = { TemplateType: 'custom', UiType: 'SFX', Subject: 's', Body: '', HtmlValue: '<p>Hello {{{Account.SFTK_Live_Blk__c}}} and {{{Account.Name}}}</p>', Markup: '' };
  const vf = { TemplateType: 'visualforce', UiType: 'Aloha', Subject: 's', Body: '', HtmlValue: '', Markup: '<messaging:emailTemplate><messaging:plainTextEmailBody>{!relatedTo.SFTK_Live_Blk__c}</messaging:plainTextEmailBody></messaging:emailTemplate>' };
  it('finds the lines, per field', () => {
    expect(T.sftkTplHits(classic, F)).toEqual([{ field: 'Subject', line: 1, text: 'Hi {!Account.SFTK_Live_Blk__c}' }, { field: 'Body', line: 1, text: 'Hello {!Account.SFTK_Live_Blk__c}' }]);
    expect(T.sftkTplHits(sfx, F).map(h => h.field)).toEqual(['HtmlValue']);
    expect(T.sftkTplHits(vf, F).map(h => h.field)).toEqual(['Markup']);
    expect(T.sftkTplHits(classic, 'SFTK_Live_Blk')).toEqual([]);   // not a whole word
  });
  it('⇄ renames the field inside every merge field, the rest byte for byte', () => {
    const r = T.sftkTplReplace(classic, F, N);
    expect(r.n).toBe(2); expect(r.fields).toEqual(['Subject', 'Body']);
    expect(r.rec.Body).toBe('Hello {!Account.SFTK_Live_Blk2__c}\nBye {!Account.Name}');
    expect(T.sftkTplReplace(sfx, F, N).rec.HtmlValue).toBe('<p>Hello {{{Account.SFTK_Live_Blk2__c}}} and {{{Account.Name}}}</p>');
    expect(T.sftkTplReplace(vf, F, N).rec.Markup).toContain('{!relatedTo.SFTK_Live_Blk2__c}');
  });
  it('✂ takes the whole merge field out — classic, Lightning and Visualforce braces alike — and leaves the other merge fields', () => {
    expect(T.sftkTplRemove(classic, F).rec.Body).toBe('Hello \nBye {!Account.Name}');
    expect(T.sftkTplRemove(sfx, F).rec.HtmlValue).toBe('<p>Hello  and {{{Account.Name}}}</p>');
    expect(T.sftkTplRemove(vf, F).rec.Markup).toBe('<messaging:emailTemplate><messaging:plainTextEmailBody></messaging:plainTextEmailBody></messaging:emailTemplate>');
    expect(T.sftkTplRemove({ Body: 'the field SFTK_Live_Blk__c is mentioned in prose' }, F).n).toBe(0);   // not a merge field: left alone
  });
  it('names the kind', () => {
    expect(T.sftkTplKind(classic)).toBe('classic text email template');
    expect(T.sftkTplKind(sfx)).toBe('Lightning email template');
    expect(T.sftkTplKind(vf)).toBe('Visualforce email template');
    expect(T.sftkTplKind({ TemplateType: 'html' })).toBe('classic HTML email template');
  });
  it('the undo of a template edit is verified on the record’s field, loosely', () => {
    const spec = { pick: '.', field: 'HtmlValue', equals: '<p>a</p>\r\n', loose: true };
    expect(H.sftkUndoVerifyEval(spec, { Id: 'x', HtmlValue: '<p>a</p>' }).ok).toBe(true);
    expect(H.sftkUndoVerifyEval(spec, { Id: 'x', HtmlValue: '<p>b</p>' }).ok).toBe(false);
  });
});

describe('the wiring in Field Cleaner', () => {
  it('a mention kind the engine knows gets ✂ / ⇄ / 🗑 and 🔍 like a blocker; a template has its own fix and inspector', () => {
    expect(FC).toContain("const knownKind = !cfgT.fixable && (cfgT.sev === 'blocker' || cfgT.sev === 'silent');");
    expect(FC).toContain("const canDel = !fixable && typeof sftkMdDeleteSpec === 'function' && (!!sftkMdDeleteSpec(type) || type === 'LookupFilter');");
    expect(FC).toContain("if ((type === 'MatchingRule' || type === 'DuplicateRule' || type === 'ListView') && looksLikeId) {");   // a list view's 00B id → Object.DeveloperName
    expect(FC).toContain("if (type === 'EmailTemplate') label = (await fixEmailTemplate(componentId, componentName, swap)) || label;");
    expect(FC).toContain("if (type === 'EmailTemplate') { await _tplInspect(componentId, componentName, panel, inspBtn); return; }");
    expect(FC).toContain("EmailTemplate:  { icon: '✉️', label: 'Email Templates',  fixable: true, sev: 'silent',");
    expect(HTML).toContain('<script src="sftk-emailtpl.js"></script>');
  });
  it('the template write: a PATCH of the changed text fields, a restore point that PATCHes them back, a loose re-read as the verify', () => {
    const fn = FC.slice(FC.indexOf('async function _tplDeploy(ctx, next, o) {'), FC.indexOf('async function fixEmailTemplate('));
    expect(fn).toContain("const r = await bg({ type: 'SF_PATCH', orgUrl: _orgUrl, sid: _sid, _suppressError: true, path, body: after });");
    expect(fn).toContain("const verifyBack = { msg: readMsg, pick: '.', field: changed[0], equals: before[changed[0]], loose: true };");
    expect(fn).toContain("await _snapshotFix('MdEdit', componentId, componentName, rec.DeveloperName || componentName, { type: 'EmailTemplate', mdType: 'EmailTemplate', what: kind, swapTo: o.swapTo || null, how: [o.how], patch: { path, body: before }, verify: verifyBack });");
    expect(fn).toContain("msg: { type: 'SF_PATCH', path, body: before },");
    expect(fn).toContain('if (a && !a.error && changed.every(k => sftkMdCodeSame(a[k], after[k]))) return { ok: true, text: null };');
  });
});
