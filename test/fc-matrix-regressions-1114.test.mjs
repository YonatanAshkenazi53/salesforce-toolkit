// FIELD CLEANER MATRIX — REGRESSIONS of the 2026-11-14 fixes (dbdc5e0), found by an independent review.
// Each case is the reviewer's scenario: the good behaviour from before the fix works again, and the defect the fix
// was for stays fixed (its own matrix test stays green). Other groups append their sections below.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

// ═══ sftk-mdapi.js ═════════════════════════════════════════════════════════════════════════════════════════
const M = new Function(`${read('sftk-mdapi.js')}\nreturn { sftkMdEditField, sftkMdMentionsField, sftkRtMentions, sftkRtRemoveField, sftkRtReplaceField };`)();
const col = (f, t) => `<columns><checkedByDefault>false</checkedByDefault><field>${f}</field><table>${t}</table></columns>`;
const rtype = (base, cols) => `<baseObject>${base}</baseObject><sections>${cols.join('')}<masterLabel>S</masterLabel></sections>`;
const vr = f => `<active>true</active><errorConditionFormula>${f}</errorConditionFormula><errorMessage>e</errorMessage>`;

describe('ReportType — a lookup column is counted and edited only when its path ends on the object being cleaned', () => {
  it('Account.Region__c on a Contact table is Account’s field: not counted, the plain column is removed, nothing refused', () => {
    const x = rtype('Contact', [col('Region__c', 'Contact'), col('Account.Region__c', 'Contact')]);
    expect(M.sftkRtMentions(x, 'Contact', 'Region__c')).toBe(1);
    const r = M.sftkRtRemoveField(x, 'Contact', 'Region__c');
    expect(r).toMatchObject({ removed: 1, viaLookup: [], changed: true });
    expect(r.xml).toBe(rtype('Contact', [col('Account.Region__c', 'Contact')]));
  });
  it('a type whose only column is Owner.Region__c (User’s field) is not a mention of Contact.Region__c', () => {
    expect(M.sftkRtMentions(rtype('Contact', [col('Owner.Region__c', 'Contact')]), 'Contact', 'Region__c')).toBe(0);
  });
  it('Owner.Region__c next to the plain column on Account: 1 mention, the plain column goes, Owner’s stays', () => {
    const x = rtype('Account', [col('Owner.Region__c', 'Account'), col('Region__c', 'Account')]);
    expect(M.sftkRtMentions(x, 'Account', 'Region__c')).toBe(1);
    const r = M.sftkRtRemoveField(x, 'Account', 'Region__c');
    expect(r).toMatchObject({ removed: 1, viaLookup: [], changed: true });
    expect(r.xml).toBe(rtype('Account', [col('Owner.Region__c', 'Account')]));
  });
  it('Parent.Region__c on Account IS this field: counted, removed by ✂, renamed in place by ⇄', () => {
    const x = rtype('Account', [col('Region__c', 'Account'), col('Parent.Region__c', 'Account')]);
    expect(M.sftkRtMentions(x, 'Account', 'Region__c')).toBe(2);
    const rm = M.sftkRtRemoveField(x, 'Account', 'Region__c');
    expect(rm).toMatchObject({ removed: 2, viaLookup: [] });
    expect(M.sftkRtMentions(rm.xml, 'Account', 'Region__c')).toBe(0);
    const rp = M.sftkRtReplaceField(x, 'Account', 'Region__c', 'Area__c');
    expect(rp).toMatchObject({ swapped: 2, viaLookup: [], changed: true });
    expect(rp.xml).toBe(rtype('Account', [col('Area__c', 'Account'), col('Parent.Area__c', 'Account')]));
  });
  it('a custom lookup (Lookup__r.Region__c) cannot be told: counted, never edited, named in viaLookup', () => {
    const x = rtype('Account', [col('Region__c', 'Account'), col('Thing__r.Region__c', 'Account')]);
    expect(M.sftkRtMentions(x, 'Account', 'Region__c')).toBe(2);
    const r = M.sftkRtRemoveField(x, 'Account', 'Region__c');
    expect(r.viaLookup).toEqual(['Account.Thing__r.Region__c in “S” (reached through a lookup)']);
    expect(r.xml).toContain('<field>Thing__r.Region__c</field>');
  });
});

describe('formulas — another object’s same-named field through a standard relationship is left alone, not refused', () => {
  const F = 'AND(ISPICKVAL(Region__c,"EU"), Account.Region__c = "X", Amount__c &gt; 1)';
  it('Contact validation rule: ✂ takes the one condition out, Account.Region__c stays', () => {
    const r = M.sftkMdEditField('ValidationRule', vr(F), 'Contact', 'Region__c', null);
    expect(r.refused).toBeNull();
    expect(r.how[0]).toMatch(/^1 condition/);
    expect(r.xml).toContain('Account.Region__c');
    expect(r.xml).not.toMatch(/ISPICKVAL\(Region__c/);
  });
  it('Contact validation rule: ⇄ renames the one plain reference, Account.Region__c stays', () => {
    const r = M.sftkMdEditField('ValidationRule', vr(F), 'Contact', 'Region__c', 'Area__c');
    expect(r.refused).toBeNull();
    expect(r.how).toEqual(['formula: 1 reference now Area__c']);
    expect(r.xml).toBe(vr(F.replace('ISPICKVAL(Region__c', 'ISPICKVAL(Area__c')));
  });
  it('Contact WebLink: ⇄ renames {!Contact.Region__c}, {!Account.Region__c} stays', () => {
    const r = M.sftkMdEditField('WebLink', '<url>{!Contact.Region__c}&amp;a={!Account.Region__c}</url>', 'Contact', 'Region__c', 'Area__c');
    expect(r.refused).toBeNull();
    expect(r.xml).toBe('<url>{!Contact.Area__c}&amp;a={!Account.Region__c}</url>');
  });
  it('Parent.Region__c on Account is this field: ⇄ renames it too (the matrix case stays fixed)', () => {
    const r = M.sftkMdEditField('ValidationRule', vr('ISBLANK(Region__c) &amp;&amp; Parent.Region__c = "x"'), 'Account', 'Region__c', 'Area__c');
    expect(r.refused).toBeNull();
    expect(r.xml).toBe(vr('ISBLANK(Area__c) &amp;&amp; Parent.Area__c = "x"'));
  });
  it('a custom lookup path (Thing__r.Region__c) is still refused whole, with the true reason', () => {
    const x = vr('ISBLANK(Region__c) &amp;&amp; Thing__r.Region__c = "x"');
    const r = M.sftkMdEditField('ValidationRule', x, 'Account', 'Region__c', 'Area__c');
    expect(r.refused).toMatch(/custom lookup/);
    expect(r.xml).toBe(x);
  });
});

describe('QuickAction — a predefined value copying the parent’s same-named field is not this field', () => {
  const layout = '<quickActionLayout><quickActionLayoutColumns><quickActionLayoutItems><field>Region__c</field></quickActionLayoutItems></quickActionLayoutColumns></quickActionLayout>';
  it('⇄ Contact.Region__c: the layout field and the predefined value’s target move, the formula Account.Region__c stays', () => {
    const x = `<fieldOverrides><field>Region__c</field><formula>Account.Region__c</formula></fieldOverrides>${layout}`;
    const r = M.sftkMdEditField('QuickAction', x, 'Contact', 'Region__c', 'Area__c');
    expect(r.refused).toBeNull();
    expect(r.how).toEqual(['1 layout field now Area__c, 1 predefined value now Area__c']);
    expect(r.xml).toContain('<formula>Account.Region__c</formula>');
  });
  it('✂ Contact.Region__c with another field’s value computed from Account.Region__c: the layout field is removed', () => {
    const x = `<fieldOverrides><field>Description</field><formula>Account.Region__c</formula></fieldOverrides>${layout}`;
    const r = M.sftkMdEditField('QuickAction', x, 'Contact', 'Region__c', null);
    expect(r.refused).toBeNull();
    expect(r.how).toEqual(['1 layout field removed']);
  });
});

describe('RestrictionRule — a bare name in the record filter is the target entity’s field', () => {
  it('⇄ User.Region__c renames $User.Region__c only, never Account’s Region__c', () => {
    const x = '<active>true</active><targetEntity>Account</targetEntity><recordFilter>Region__c = $User.Region__c</recordFilter><userCriteria>$User.IsActive = true</userCriteria>';
    const r = M.sftkMdEditField('RestrictionRule', x, 'User', 'Region__c', 'New__c');
    expect(r.refused).toBeNull();
    expect(r.xml).toContain('<recordFilter>Region__c = $User.New__c</recordFilter>');
    expect(r.how).toEqual(['record filter: 1 reference now New__c']);
  });
  it('⇄ Account.Region__c on the same rule renames the bare one only', () => {
    const x = '<active>true</active><targetEntity>Account</targetEntity><recordFilter>Region__c = $User.Region__c</recordFilter>';
    const r = M.sftkMdEditField('RestrictionRule', x, 'Account', 'Region__c', 'New__c');
    expect(r.xml).toContain('<recordFilter>New__c = $User.Region__c</recordFilter>');
  });
});

describe('formulas — $ObjectType.Obj.Fields.Field__c names this field', () => {
  it('⇄ renames it with the plain reference, so the deployed rule no longer names the field', () => {
    const x = '<active>true</active><errorConditionFormula>Region__c = &apos;x&apos; || $ObjectType.Account.Fields.Region__c.Label = &apos;y&apos;</errorConditionFormula><errorMessage>e</errorMessage>';
    const r = M.sftkMdEditField('ValidationRule', x, 'Account', 'Region__c', 'New__c');
    expect(r.refused).toBeNull();
    expect(r.xml).not.toMatch(/Region__c/);
    expect(r.how).toEqual(['formula: 2 references now New__c']);
  });
  it('$ObjectType of ANOTHER object is left alone', () => {
    const x = vr('Region__c = 1 || $ObjectType.Contact.Fields.Region__c.Label = &apos;y&apos;');
    const r = M.sftkMdEditField('ValidationRule', x, 'Account', 'Region__c', 'New__c');
    expect(r.xml).toContain('$ObjectType.Contact.Fields.Region__c');
    expect(r.how).toEqual(['formula: 1 reference now New__c']);
  });
});

describe('WorkflowRule — a time trigger as the only mention names the trigger as the reason', () => {
  it('✂ refuses with the time-trigger reason (⇄ is the way)', () => {
    const x = '<fullName>R1</fullName><active>true</active><criteriaItems><field>Account.Name</field><operation>notEqual</operation></criteriaItems><triggerType>onCreateOnly</triggerType><workflowTimeTriggers><offsetFromField>Account.Region__c</offsetFromField><timeLength>1</timeLength><workflowTimeTriggerUnit>Days</workflowTimeTriggerUnit></workflowTimeTriggers>';
    const r = M.sftkMdEditField('WorkflowRule', x, 'Account', 'Region__c', null);
    expect(r.refused).toMatch(/time trigger counts from this field — ⇄ Replace/);
    expect(r.xml).toBe(x);
  });
});

// ═══ field-cleaner.js ══════════════════════════════════════════════════════════════════════════════════════
// the tool's closure functions, sliced out the way fc-matrix-surfaces / fc-matrix-flows do
const FCJ = read('field-cleaner.js');
const fcNested = name => {
  const at = FCJ.indexOf(`\n  function ${name}(`);
  if (at < 0) throw new Error(`not found in field-cleaner.js: ${name}`);
  return FCJ.slice(at + 1, FCJ.indexOf('\n  }\n', at + 1) + 4);
};
const FR = new Function(`${read('sftk-fieldreplace.js')}\nreturn { sftkFlowResourceObjects };`)();
const FX = new Function('sftkFlowResourceObjects', `${['removeFieldFromFlexiPage', 'flexiPageReferencesField', 'removeFieldRefs', '_flowLeftWhy'].map(fcNested).join('\n')}
return { removeFieldFromFlexiPage, flexiPageReferencesField, removeFieldRefs, _flowLeftWhy };`)(FR.sftkFlowResourceObjects);
const fxRich = criteria => ({ componentInstance: { componentName: 'flexipage:richText', identifier: 'rt1', visibilityRule: { criteria } } });
const fxPage = (...items) => ({ flexiPageRegions: [{ name: 'main', itemInstances: items }] });
const fxField = { fieldInstance: { fieldItem: 'Record.Region__c' } };
const fxCrit = (left, right = 'EMEA') => ({ leftValue: left, operator: 'EQUAL', rightValue: right });
const fxClone = o => JSON.parse(JSON.stringify(o));
const critsOf = md => md.flexiPageRegions[0].itemInstances.find(i => i.componentInstance).componentInstance.visibilityRule.criteria;

describe('FlexiPage ✂ — a criterion through a self-lookup or $User names this field when its path ends on the object cleaned', () => {
  it('{!Record.Parent.Region__c} on Account IS Account.Region__c: both mentions go, and a re-run finds none left', () => {
    const md = fxPage(fxField, fxRich([fxCrit('{!Record.Parent.Region__c}'), fxCrit('{!Record.Industry}', 'Banking')]));
    expect(FX.removeFieldFromFlexiPage(md, 'Account', 'Region__c')).toBe(2);
    expect(critsOf(md)).toEqual([fxCrit('{!Record.Industry}', 'Banking')]);
    expect(FX.removeFieldFromFlexiPage(fxClone(md), 'Account', 'Region__c')).toBe(0);
    expect(FX.flexiPageReferencesField(md, 'Account', 'Region__c')).toBe(false);
  });
  it('{!Record.Owner.Region__c} on Account.Region__c is User’s field: left alone and tallied as another object’s', () => {
    const md = fxPage(fxRich([fxCrit('{!Record.Owner.Region__c}'), fxCrit('{!Record.Industry}')]));
    const out = {};
    expect(FX.removeFieldFromFlexiPage(md, 'Account', 'Region__c', out)).toBe(0);
    expect(out).toEqual({ other: 1, unknown: 0 });
    expect(critsOf(md)).toHaveLength(2);
  });
  it('{!$User.Region__c} is removed when User.Region__c is cleaned — the edit that worked before works again', () => {
    const md = fxPage(fxRich([fxCrit('{!$User.Region__c}'), fxCrit('{!$User.IsActive}', 'true')]));
    expect(FX.removeFieldFromFlexiPage(md, 'User', 'Region__c')).toBe(1);
    expect(critsOf(md)).toEqual([fxCrit('{!$User.IsActive}', 'true')]);
  });
  it('{!$User.Region__c} on Account.Region__c is another object’s field: left, counted as other', () => {
    const md = fxPage(fxField, fxRich([fxCrit('{!$User.Region__c}'), fxCrit('{!Record.Industry}')]));
    const out = {};
    expect(FX.removeFieldFromFlexiPage(md, 'Account', 'Region__c', out)).toBe(1);   // only the field component
    expect(out.other).toBe(1);
    expect(critsOf(md)).toHaveLength(2);
  });
  it('a custom lookup ({!Record.Thing__r.Region__c}) cannot be told: never edited, tallied unknown, the fix names it', () => {
    const md = fxPage(fxField, fxRich([fxCrit('{!Record.Thing__r.Region__c}'), fxCrit('{!Record.Industry}')]));
    const out = {};
    expect(FX.removeFieldFromFlexiPage(md, 'Account', 'Region__c', out)).toBe(1);
    expect(out.unknown).toBe(1);
    expect(critsOf(md)).toHaveLength(2);
    expect(FCJ).toContain('through a custom lookup left alone — whose field it is cannot be told from the page');
  });
});

describe('Flow ✂ — a chain through a relationship, or a flow resource with the field’s name, is not this field', () => {
  const asg = (...items) => ({ name: 'a', assignmentItems: items });
  const item = (to, ref) => ({ assignToReference: to, operator: 'Assign', value: ref ? { elementReference: ref } : { stringValue: 'x' } });
  it('$Record.Owner.Region__c on a Contact flow is User’s: left; $Record.Account.Region__c is Account’s: removed', () => {
    const m = { start: { object: 'Contact' }, assignments: [asg(item('v', '$Record.Owner.Region__c'), item('w', '$Record.Account.Region__c'))] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(1);
    expect(m.assignments[0].assignmentItems.map(i => i.value.elementReference)).toEqual(['$Record.Owner.Region__c']);
    expect(FX.removeFieldRefs.lastLeft.other).toEqual(['$Record.Owner.Region__c']);
  });
  it('$Record.Parent.Region__c on an Account flow is Account’s own field: removed', () => {
    const m = { start: { object: 'Account' }, assignments: [asg(item('v', '$Record.Parent.Region__c'))] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(1);
  });
  it('a custom lookup chain ($Record.Thing__r.Region__c) is never edited and is named as untellable', () => {
    const m = { start: { object: 'Account' }, assignments: [asg(item('v', '$Record.Thing__r.Region__c'))] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(0);
    expect(m.assignments[0].assignmentItems).toHaveLength(1);
    expect(FX._flowLeftWhy(FX.removeFieldRefs.lastLeft)).toMatch(/\$Record\.Thing__r\.Region__c reaches the field through a custom lookup/);
  });
  it('a flow variable named Region__c is not the field: an assignment to it stays', () => {
    const m = { variables: [{ name: 'Region__c', dataType: 'String' }], assignments: [asg(item('Region__c'))] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(0);
    expect(m.assignments[0].assignmentItems).toHaveLength(1);
  });
  it('a bare name under a key that holds a field is still the field (a Get Records queried field)', () => {
    const m = { recordLookups: [{ name: 'g', object: 'Account', queriedFields: ['Id', 'Region__c'] }] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(1);
    expect(m.recordLookups[0].queriedFields).toEqual(['Id']);
  });
});

describe('Flow ✂ — nothing taken out because the field is an element’s only filter: the refusal names that place', () => {
  it('the trigger’s only entry condition is named, not a decision / formula / variable default', () => {
    const m = { start: { object: 'Account', triggerType: 'RecordAfterSave', filters: [{ field: 'Region__c', operator: 'EqualTo', value: { stringValue: 'x' } }] } };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(0);
    expect(m.start.filters).toHaveLength(1);
    const why = FX._flowLeftWhy(FX.removeFieldRefs.lastLeft);
    expect(why).toMatch(/only condition of the trigger's entry condition \(Start\)/);
    expect(why).not.toMatch(/decision condition/);
    expect(FCJ).toContain('${_flowLeftWhy(removeFieldRefs.lastLeft)}');
  });
  it('a Get Records with numbered logic is named by its label', () => {
    const flt = (f, v) => ({ field: f, operator: 'EqualTo', value: { stringValue: v } });
    const m = { recordLookups: [{ name: 'g', label: 'Get Accts', object: 'Account', filterLogic: '1 AND (2 OR 3)', filters: [flt('Region__c', 'x'), flt('Name', 'y'), flt('Type', 'z')] }] };
    expect(FX.removeFieldRefs(m, 'Account', 'Region__c')).toBe(0);
    expect(FX._flowLeftWhy(FX.removeFieldRefs.lastLeft)).toMatch(/the filter of "Get Accts", whose numbered filter logic/);
  });
});

// ═══ sftk-emailtpl.js ══════════════════════════════════════════════════════════════════════════════════════
const TP = new Function(`${read('sftk-emailtpl.js')}\nreturn { sftkTplRemove, sftkTplReplace, sftkTplNamesField };`)();
const vfm = (head, body) => `<messaging:emailTemplate subject="x" ${head}>\n<messaging:htmlEmailBody >\n${body}\n</messaging:htmlEmailBody>\n</messaging:emailTemplate>`;

describe('EmailTemplate — a classic {!Receiving_User.X__c} is the User’s field', () => {
  const rec = { Body: 'Region: {!Receiving_User.Region__c}' };
  it('the scan ties it to User; ✂ takes it out, ⇄ renames it', () => {
    expect(TP.sftkTplNamesField(rec, 'User', 'Region__c')).toBe(true);
    expect(TP.sftkTplRemove(rec, 'Region__c', 'User')).toEqual({ rec: { Body: 'Region: ' }, n: 1, fields: ['Body'] });
    expect(TP.sftkTplReplace(rec, 'Region__c', 'Area__c', 'User')).toEqual({ rec: { Body: 'Region: {!Receiving_User.Area__c}' }, n: 1, fields: ['Body'] });
  });
  it('not a Contact’s or an Account’s field: left alone', () => {
    expect(TP.sftkTplRemove(rec, 'Region__c', 'Contact').n).toBe(0);
    expect(TP.sftkTplReplace(rec, 'Region__c', 'Area__c', 'Account').n).toBe(0);
  });
});

describe('EmailTemplate — Visualforce: a chain is resolved to its object; another object’s same-named field stays', () => {
  const m = vfm('recipientType="Contact" relatedToType="Contact"', '<apex:outputField value="{!relatedTo.Account.Region__c}"/> <apex:outputField value="{!relatedTo.Region__c}"/>\nTier {!relatedTo.Region__c} / {!relatedTo.Account.Region__c}');
  const rec = { Markup: m };
  it('cleaning Account.Region__c: only relatedTo.Account.Region__c goes or is renamed', () => {
    expect(TP.sftkTplNamesField(rec, 'Account', 'Region__c')).toBe(true);
    const r = TP.sftkTplRemove(rec, 'Region__c', 'Account');
    expect(r.n).toBe(2);
    expect(r.rec.Markup).toBe(m.replace('<apex:outputField value="{!relatedTo.Account.Region__c}"/>', '').replace(' / {!relatedTo.Account.Region__c}', ' / '));
    const p = TP.sftkTplReplace(rec, 'Region__c', 'New__c', 'Account');
    expect(p.n).toBe(2);
    expect(p.rec.Markup).toBe(m.split('relatedTo.Account.Region__c').join('relatedTo.Account.New__c'));
  });
  it('cleaning Contact.Region__c: only relatedTo.Region__c goes or is renamed', () => {
    const r = TP.sftkTplRemove(rec, 'Region__c', 'Contact');
    expect(r.n).toBe(2);
    expect(r.rec.Markup).toContain('{!relatedTo.Account.Region__c}');
    expect(r.rec.Markup).not.toMatch(/relatedTo\.Region__c/);
    const p = TP.sftkTplReplace(rec, 'Region__c', 'New__c', 'Contact');
    expect(p.rec.Markup).toBe(m.split('relatedTo.Region__c').join('relatedTo.New__c'));
  });
  it('Owner → User, $ObjectType.Obj.Fields.X → Obj, recipient → recipientType', () => {
    const o = { Markup: vfm('recipientType="Contact" relatedToType="Account"', '{!relatedTo.Owner.Region__c} {!$ObjectType.Account.Fields.Region__c.Label} {!recipient.Region__c}') };
    expect(TP.sftkTplRemove(o, 'Region__c', 'User').rec.Markup).toContain('\n {!$ObjectType.Account.Fields.Region__c.Label} {!recipient.Region__c}\n');
    expect(TP.sftkTplRemove(o, 'Region__c', 'Account').rec.Markup).toContain('\n{!relatedTo.Owner.Region__c}  {!recipient.Region__c}\n');
    expect(TP.sftkTplReplace(o, 'Region__c', 'X__c', 'Contact').rec.Markup).toContain('{!recipient.X__c}');
  });
  it('a custom relationship or an <apex:repeat> variable cannot be told: refused with the reason, nothing written', () => {
    const c = { Markup: vfm('relatedToType="Account"', 'Tier {!relatedTo.Region__c} {!relatedTo.Parent_Org__r.Region__c}') };
    const r = TP.sftkTplRemove(c, 'Region__c', 'Account');
    expect(r).toMatchObject({ n: 0, rec: {} });
    expect(r.refused).toMatch(/through “\{!relatedTo\.Parent_Org__r\.Region__c\}” — which object's field that is cannot be told/);
    expect(TP.sftkTplReplace(c, 'Region__c', 'X__c', 'Account').refused).toMatch(/cannot be told from the markup/);
    const v = { Markup: vfm('relatedToType="Account"', '<apex:repeat value="{!relatedTo.Contacts}" var="c"><apex:outputField value="{!c.Region__c}"/></apex:repeat>') };
    expect(TP.sftkTplRemove(v, 'Region__c', 'Account').refused).toMatch(/cannot be told/);
  });
});

describe('EmailTemplate — Visualforce: a single-quoted binding is a bound component too', () => {
  it('<apex:outputField value=\'{!relatedTo.X}\'/> goes whole, never value=\'\'', () => {
    const m = vfm('relatedToType="Account"', "<apex:outputField value='{!relatedTo.Region__c}'/>");
    const r = TP.sftkTplRemove({ Markup: m }, 'Region__c', 'Account');
    expect(r).toEqual({ rec: { Markup: m.replace("<apex:outputField value='{!relatedTo.Region__c}'/>", '') }, n: 1, fields: ['Markup'] });
    expect(r.rec.Markup).not.toContain("value=''");
  });
  it('a single-quoted <apex:repeat value=…> binding is refused, like the double-quoted one', () => {
    const m = vfm('relatedToType="Account"', "<apex:repeat value='{!relatedTo.Region__c}' var='v'>{!v}</apex:repeat>");
    const r = TP.sftkTplRemove({ Markup: m }, 'Region__c', 'Account');
    expect(r.n).toBe(0);
    expect(r.refused).toMatch(/binds a component's attribute to Region__c/);
  });
  it('another object’s field bound in an attribute is not this field: no refusal', () => {
    const m = vfm('relatedToType="Contact"', '<apex:repeat value="{!relatedTo.Account.Region__c}" var="v">{!v}</apex:repeat> {!relatedTo.Region__c}');
    const r = TP.sftkTplRemove({ Markup: m }, 'Region__c', 'Contact');
    expect(r.refused).toBeUndefined();
    expect(r.n).toBe(1);
    expect(r.rec.Markup).toContain('value="{!relatedTo.Account.Region__c}"');
  });
});
