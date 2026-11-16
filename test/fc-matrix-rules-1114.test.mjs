// The matrix of 2026-11-14 (user: "from every metadata type test a full delete and a partial remove where the field
// appears one time in the xml and where it appears a couple of times"). This file: the RULE family —
//   ValidationRule · ValidationRuleInactive · CustomField (formula, roll-up, default) · LookupFilter · WebLink ·
//   RestrictionRule (restriction and scoping rules).
// Per type: 🗑 the full delete (spec, folder, suffix, member, the destructive manifest, the restore file),
// ✂ with ONE mention, ✂ with SEVERAL mentions, and ⇄ with several mentions. Only the product's own functions
// run here (sliced out of sftk-mdapi.js); the XML is what readMetadata returns (test/fixtures/md-edit shapes).
// A case marked it.skip + "PRODUCT BUG" is one where the product's answer is believed wrong — see the comment on it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const M = extractFunctions('sftk-mdapi.js', ['sftkMdEditField', 'sftkFormulaDropField', 'sftkMdEditWays', '_sftkMdFieldIs', '_sftkMdRenameVal', '_sftkMdWalk',
  '_sftkMdSwapToken', '_sftkMdHasLogic', 'sftkMdFindElement', 'sftkMdUnescape', 'sftkMdEscape', 'sftkMdChildText', 'sftkMdLeadMappingRemove', 'sftkMdMentionsField',
  'sftkMdPackageFiles', 'sftkMdDeleteSpec', '_sftkMdDeleteTable', '_sftkPkgXml', 'sftkMdRecordFileXml', 'sftkMdDestructiveFiles', 'sftkMdLookupFilterRemove', 'sftkMdWellFormed']);

const F = 'SFTK_Live_Blk__c', N = 'SFTK_Live_Blk2__c';
const rm = (t, x, o = 'Account') => M.sftkMdEditField(t, x, o, F, null);
const rp = (t, x, o = 'Account') => M.sftkMdEditField(t, x, o, F, N);
// XML text as Salesforce escapes it
const e = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
// a plain whole-word search for the API name, any case — "Object.Field__c" and bare "Field__c" both hit
const names = x => new RegExp(`(?<![A-Za-z0-9_])${F}(?![A-Za-z0-9_])`, 'i').test(String(x));
const mentions = (x, o = 'Account') => M.sftkMdMentionsField(x, o, F);
const wellFormed = x => expect(M.sftkMdWellFormed(`<r>${x}</r>`)).toBeNull();
// nothing names the field any more: the product's own test and the plain search agree
const gone = (x, o = 'Account') => { expect(names(x)).toBe(false); expect(mentions(x, o)).toBe(false); wellFormed(x); };
// a refusal: the reason, and nothing half-done (the XML comes back byte for byte)
const refusedWhole = (r, before, why) => { expect(r.refused).toMatch(why); expect(r.xml).toBe(before); expect(r.changed).toBe(false); expect(r.how).toEqual([]); };
// after ⇄ nothing names the old field, and putting the old name back gives the input byte for byte
const swappedAll = (before, r, places) => {
  expect(r.refused).toBeNull(); expect(r.changed).toBe(true);
  expect(names(r.xml)).toBe(false);
  expect(r.xml.split(N).length - 1).toBe(places);
  expect(r.xml.split(N).join(F).toLowerCase()).toBe(before.toLowerCase());
  wellFormed(r.xml);
};
const PKG_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n';
const manifest = (type, member) => `${PKG_HEAD}    <types>\n        <members>${member}</members>\n        <name>${type}</name>\n    </types>\n    <version>62.0</version>\n</Package>`;
const EMPTY_PKG = `${PKG_HEAD}    <version>62.0</version>\n</Package>`;
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"';
// the two files of a delete, as fixDelete builds them: sftkMdDestructiveFiles([[spec.mdType, fullName]])
const destructive = (type, fullName) => { const s = M.sftkMdDeleteSpec(type); return M.sftkMdDestructiveFiles([[s.mdType, fullName]]); };

// ─────────────────────────────────────────────────────────────── ValidationRule
const vr = (formula, extra = '') => `<fullName>Account.SFTK_Live_VR</fullName><active>true</active><description>SFTK live demo</description><errorConditionFormula>${e(formula)}</errorConditionFormula>${extra}<errorMessage>SFTK live demo</errorMessage>`;

describe('ValidationRule', () => {
  describe('🗑 full delete', () => {
    it('the spec: a child of the object file, deleted by its "Object.Rule" name as a ValidationRule', () => {
      expect(M.sftkMdDeleteSpec('ValidationRule')).toEqual({ type: 'ValidationRule', mdType: 'ValidationRule', parent: 'CustomObject', tag: 'validationRules', folder: 'objects', suffix: 'object', what: 'validation rule', tooling: 'ValidationRule' });
      const f = destructive('ValidationRule', 'Account.SFTK_Live_VR');
      expect(f).toEqual([{ name: 'package.xml', text: EMPTY_PKG }, { name: 'destructiveChangesPost.xml', text: manifest('ValidationRule', 'Account.SFTK_Live_VR') }]);
    });
    it('the restore point: the rule inside objects/Account.object under its short name, everything else as read', () => {
      const x = vr('ISBLANK(SFTK_Live_Blk__c) && ISPICKVAL(Type, "Customer")');
      const f = M.sftkMdPackageFiles('ValidationRule', 'Account.SFTK_Live_VR', x);
      expect(f.map(y => y.name)).toEqual(['package.xml', 'objects/Account.object']);
      expect(f[0].text).toBe(manifest('ValidationRule', 'Account.SFTK_Live_VR'));
      expect(f[1].text).toBe(`<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject ${NS}><validationRules><fullName>SFTK_Live_VR</fullName>${x.replace('<fullName>Account.SFTK_Live_VR</fullName>', '')}</validationRules></CustomObject>`);
      expect(M.sftkMdWellFormed(f[1].text)).toBeNull();
    });
    it('offered: ✂ and ⇄ and 🗑', () => {
      expect(M.sftkMdEditWays('ValidationRule')).toEqual({ remove: true, replace: true });
      expect(FC).toContain("const canDel = !fixable && typeof sftkMdDeleteSpec === 'function' && (!!sftkMdDeleteSpec(type) || type === 'LookupFilter' || !!_extraDeleteSpec(type, id));");
    });
  });

  describe('✂ remove, ONE mention', () => {
    it('one condition of an AND(…) names the field: it goes, the other stays, the rule stays active', () => {
      const x = vr('AND(ISBLANK(SFTK_Live_Blk__c), ISPICKVAL(Type, "Customer"))');
      const r = rm('ValidationRule', x);
      expect(r.refused).toBeNull(); expect(r.changed).toBe(true);
      expect(r.xml).toBe(vr('ISPICKVAL(Type, "Customer")'));
      expect(r.suggested).toBe(true); expect(r.off).toBe(false);
      expect(r.how).toEqual(['1 condition that uses the field taken out of the formula — the rule stays active on its other conditions']);
      gone(r.xml);
    });
    it('one side of && names the field (written Object.Field on a child object\'s rule): it goes', () => {
      const x = vr('Account.SFTK_Live_Blk__c = \'x\' && NOT(ISBLANK(LastName))').replace('Account.SFTK_Live_VR', 'Contact.SFTK_Live_VR');
      const r = rm('ValidationRule', x);
      expect(r.xml).toBe(vr('NOT(ISBLANK(LastName))').replace('Account.SFTK_Live_VR', 'Contact.SFTK_Live_VR'));
      expect(r.how[0]).toMatch(/^1 condition that uses the field taken out/);
      gone(r.xml);
    });
    it('one side of || names the field, in lower case: it goes', () => {
      const x = vr('ISBLANK(Name) || LEN(sftk_live_blk__c) > 5');
      const r = rm('ValidationRule', x);
      expect(r.xml).toBe(vr('ISBLANK(Name)'));
      gone(r.xml);
    });
    it('the field is the ONLY condition: the formula cannot lose it — the rule is switched off, its formula untouched', () => {
      const x = vr('ISBLANK(SFTK_Live_Blk__c)');
      const r = rm('ValidationRule', x);
      expect(r.refused).toBeNull();
      expect(r.xml).toBe(x.replace('<active>true</active>', '<active>false</active>'));
      expect(r.off).toBe(true); expect(r.suggested).toBe(false);
      expect(r.how).toEqual(['the rule cannot work without the field — every condition of its formula uses it — so it has to be switched off']);
      wellFormed(r.xml);
      expect(names(r.xml)).toBe(true);   // by design: an inactive rule does not block the delete (it is listed again as ValidationRuleInactive)
    });
    it('only a constant would be left: switched off, and the reason says what would be left', () => {
      const x = vr('ISBLANK(SFTK_Live_Blk__c) && FALSE');
      const r = rm('ValidationRule', x);
      expect(r.xml).toBe(x.replace('<active>true</active>', '<active>false</active>'));
      expect(r.off).toBe(true); expect(r.how[0]).toMatch(/only “FALSE” would be left/);
    });
    it('a longer name that only CONTAINS the field is not the field: refused, nothing changed', () => {
      const x = vr('ISBLANK(SFTK_Live_Blk__cX) && ISBLANK(My_SFTK_Live_Blk__c)');
      refusedWhole(rm('ValidationRule', x), x, /does not name the field as a whole token/);
      refusedWhole(rp('ValidationRule', x), x, /does not name the field as a whole token/);
    });
  });

  describe('✂ remove, SEVERAL mentions', () => {
    it('two conditions of an AND(…) name it, a third does not: both go in one pass', () => {
      const x = vr('AND(ISBLANK(SFTK_Live_Blk__c), ISBLANK(Name), LEN(SFTK_Live_Blk__c) > 5)');
      const r = rm('ValidationRule', x);
      expect(r.xml).toBe(vr('ISBLANK(Name)'));
      expect(r.how).toEqual(['2 conditions that use the field taken out of the formula — the rule stays active on its other conditions']);
      expect(r.suggested).toBe(true);
      gone(r.xml);
    });
    it('nested: OR( field, AND(other, field), other ) — every condition of the field goes, the logic that is left is consistent', () => {
      const x = vr('OR(ISBLANK(SFTK_Live_Blk__c), AND(ISPICKVAL(Type, "Customer"), LEN(Account.SFTK_Live_Blk__c) > 5), ISBLANK(Name))');
      const r = rm('ValidationRule', x);
      expect(r.xml).toBe(vr('OR(ISPICKVAL(Type, "Customer"), ISBLANK(Name))'));
      expect(r.how[0]).toMatch(/^2 conditions/);
      gone(r.xml);
    });
    it('three mentions inside ONE condition (an IF) and one in another: the conditions go whole', () => {
      const x = vr('IF(SFTK_Live_Blk__c = "a", LEN(SFTK_Live_Blk__c), 0) > 3 && ISBLANK(Name) && NOT(ISBLANK(SFTK_Live_Blk__c))');
      const r = rm('ValidationRule', x);
      expect(r.xml).toBe(vr('ISBLANK(Name)'));
      expect(r.how[0]).toMatch(/^2 conditions/);
      gone(r.xml);
    });
    it('mixed && and ||, with brackets: the bracket that is left empty goes with its operator', () => {
      const x = vr('(ISBLANK(SFTK_Live_Blk__c) || SFTK_Live_Blk__c = "x") && ISBLANK(Name)');
      const r = rm('ValidationRule', x);
      expect(r.xml).toBe(vr('ISBLANK(Name)'));
      gone(r.xml);
    });
    it('every condition names it (three times): nothing can be left — switched off as a whole, the formula untouched', () => {
      const x = vr('AND(ISBLANK(SFTK_Live_Blk__c), LEN(SFTK_Live_Blk__c) > 5, Account.SFTK_Live_Blk__c <> "x")');
      const r = rm('ValidationRule', x);
      expect(r.xml).toBe(x.replace('<active>true</active>', '<active>false</active>'));
      expect(r.off).toBe(true); expect(r.how[0]).toMatch(/every condition of its formula uses it/);
    });
    it('the other parts of the rule come back byte for byte (description, message, an error field that is another field)', () => {
      const x = vr('ISBLANK(SFTK_Live_Blk__c) || ISBLANK(Phone) || ISBLANK(SFTK_Live_Blk__c)', '<errorDisplayField>Phone</errorDisplayField>');
      const r = rm('ValidationRule', x);
      expect(r.xml).toBe(vr('ISBLANK(Phone)', '<errorDisplayField>Phone</errorDisplayField>'));
      gone(r.xml);
    });
    // FIXED 2026-11-14 (was a product bug): a rule can show its error AT the field (<errorDisplayField>). ✂ and ⇄ only read
    // <errorConditionFormula>; the error field keeps naming the old field, and "changed" says nothing about it.
    // (The scan itself counts errorDisplayField as a mention: field-cleaner.js, eachMetadata('ValidationRule', … sameField(m.errorDisplayField)).)
    it('formula + <errorDisplayField> both name the field — ✂ leaves the error field pointing at it', () => {
      const x = vr('ISBLANK(SFTK_Live_Blk__c) && ISBLANK(Name)', '<errorDisplayField>SFTK_Live_Blk__c</errorDisplayField>');
      const r = rm('ValidationRule', x);
      expect(names(r.xml)).toBe(false);
    });
    it('formula + <errorDisplayField> both name the field — ⇄ renames the formula only', () => {
      const x = vr('ISBLANK(SFTK_Live_Blk__c) && ISBLANK(Name)', '<errorDisplayField>SFTK_Live_Blk__c</errorDisplayField>');
      const r = rp('ValidationRule', x);
      expect(r.xml).toBe(vr('ISBLANK(SFTK_Live_Blk2__c) && ISBLANK(Name)', '<errorDisplayField>SFTK_Live_Blk2__c</errorDisplayField>'));
    });
    // FIXED 2026-11-14 (was a product bug; now refused whole): on Account, Parent.Field__c is the SAME field (the parent account's). The token test only knows
    // "Field__c" and "Account.Field__c", so a mixed formula is done by half and reported as done.
    it('the field reached through a relationship (Parent.Field__c) next to a plain mention — ⇄ leaves the relationship one behind', () => {
      const x = vr('ISBLANK(SFTK_Live_Blk__c) && Parent.SFTK_Live_Blk__c = "x"');
      const r = rp('ValidationRule', x);
      expect(r.refused || !names(r.xml)).toBeTruthy();   // either every mention becomes the new field, or the edit is refused as a whole
    });
    it('the field reached through a relationship (Parent.Field__c) next to a plain mention — ✂ keeps the condition that still names it', () => {
      const x = vr('ISBLANK(SFTK_Live_Blk__c) && Parent.SFTK_Live_Blk__c = "x"');
      const r = rm('ValidationRule', x);
      expect(r.refused || r.off || !names(r.xml)).toBeTruthy();
    });
    // FIXED 2026-11-14 (was a product bug; now refused with the true reason): the field named only inside a /* comment */ — the rule was switched off, and the reason
    // given ("every condition of its formula uses it") was not true: no condition uses it. Now ✂ refuses with that true reason.
    it('the field only in a comment of the formula — ✂ is refused with the true reason (no condition uses it), the rule not switched off', () => {
      const x = vr('/* SFTK_Live_Blk__c used to be checked here */ ISBLANK(Name)');
      const r = rm('ValidationRule', x);
      expect(r.off).toBeFalsy();   // a refusal carries no "off"
      refusedWhole(r, x, /named only in a comment or quoted text of the formula — no condition uses it/);
    });
  });

  describe('⇄ replace, several mentions', () => {
    it('every spelling becomes the new field: bare, Object.Field, lower case; look-alikes and quoted text around it stay', () => {
      const x = vr('AND(ISBLANK(SFTK_Live_Blk__c), LEN(Account.SFTK_Live_Blk__c) > 5, sftk_live_blk__c <> "x", ISBLANK(SFTK_Live_Blk__cX))');
      const r = rp('ValidationRule', x);
      expect(r.xml).toBe(vr('AND(ISBLANK(SFTK_Live_Blk2__c), LEN(Account.SFTK_Live_Blk2__c) > 5, SFTK_Live_Blk2__c <> "x", ISBLANK(SFTK_Live_Blk__cX))'));
      expect(r.how).toEqual(['formula: 3 references now SFTK_Live_Blk2__c']);
      expect(r.off).toBe(false);
      expect(mentions(r.xml)).toBe(false); wellFormed(r.xml);
    });
    it('the rule is not switched off and nothing else moves', () => {
      const x = vr('SFTK_Live_Blk__c = SFTK_Live_Blk__c');
      swappedAll(x, rp('ValidationRule', x), 2);
    });
    // FIXED 2026-11-14 (was a gap): a custom-setting field is written $Setup.Setting__c.Field__c in every formula. The token
    // test refuses a name that follows a dot, so ⇄ never works for a field of a custom setting.
    it('a custom setting field ($Setup.Obj__c.Field__c) — ⇄ is refused as "does not name the field"', () => {
      const x = vr('$Setup.SFTK_Cfg__c.SFTK_Live_Blk__c = "x" && ISBLANK(Name)');
      const r = M.sftkMdEditField('ValidationRule', x, 'SFTK_Cfg__c', F, N);
      expect(r.refused).toBeNull();
      expect(r.xml).toBe(vr('$Setup.SFTK_Cfg__c.SFTK_Live_Blk2__c = "x" && ISBLANK(Name)'));
    });
  });
});

// ─────────────────────────────────────────────────────── ValidationRuleInactive
const vrOff = formula => vr(formula).replace('<active>true</active>', '<active>false</active>').replace('SFTK_Live_VR', 'SFTK_Live_VR_Off');

describe('ValidationRuleInactive (an inactive validation rule)', () => {
  it('🗑 full delete: it is a ValidationRule to Salesforce — same folder, suffix and manifest type', () => {
    expect(M.sftkMdDeleteSpec('ValidationRuleInactive')).toEqual({ type: 'ValidationRuleInactive', mdType: 'ValidationRule', parent: 'CustomObject', tag: 'validationRules', folder: 'objects', suffix: 'object', what: 'validation rule', tooling: 'ValidationRule' });
    const f = destructive('ValidationRuleInactive', 'Account.SFTK_Live_VR_Off');
    expect(f[0]).toEqual({ name: 'package.xml', text: EMPTY_PKG });
    expect(f[1]).toEqual({ name: 'destructiveChangesPost.xml', text: manifest('ValidationRule', 'Account.SFTK_Live_VR_Off') });
    const x = vrOff('ISBLANK(SFTK_Live_Blk__c)');
    const back = M.sftkMdPackageFiles('ValidationRuleInactive', 'Account.SFTK_Live_VR_Off', x);
    expect(back[0].text).toBe(manifest('ValidationRule', 'Account.SFTK_Live_VR_Off'));
    expect(back[1].name).toBe('objects/Account.object');
    expect(back[1].text).toContain('<validationRules><fullName>SFTK_Live_VR_Off</fullName><active>false</active>');
    expect(M.sftkMdWellFormed(back[1].text)).toBeNull();
  });
  it('✂ is NOT offered (an inactive rule does not block the delete); ⇄ is', () => {
    expect(M.sftkMdEditWays('ValidationRuleInactive')).toEqual({ remove: false, replace: true });
    expect(FC).toContain('if (!nf && !ways.remove) throw new Error(`A ${cfg.label || type} cannot lose the field and keep working — pick a replacement field above and press ⇄ Replace, or 🗑 delete it.`);');
  });
  it('✂, ONE mention: refused — already inactive — nothing changed', () => {
    const x = vrOff('ISBLANK(SFTK_Live_Blk__c) && ISBLANK(Name)');
    refusedWhole(rm('ValidationRuleInactive', x), x, /already inactive — an inactive rule does not block the delete/);
    refusedWhole(rm('ValidationRule', x), x, /already inactive/);   // the same rule reached as an active one that was switched off meanwhile
  });
  it('✂, SEVERAL mentions: refused as a whole, nothing changed', () => {
    const x = vrOff('AND(ISBLANK(SFTK_Live_Blk__c), ISBLANK(Name), LEN(Account.SFTK_Live_Blk__c) > 5)');
    refusedWhole(rm('ValidationRuleInactive', x), x, /already inactive/);
  });
  it('⇄, one and several mentions: every one becomes the new field, the rule stays inactive', () => {
    const one = vrOff('ISBLANK(SFTK_Live_Blk__c)');
    swappedAll(one, rp('ValidationRuleInactive', one), 1);
    const x = vrOff('AND(ISBLANK(SFTK_Live_Blk__c), ISBLANK(Name), LEN(Account.SFTK_Live_Blk__c) > 5, SFTK_Live_Blk__c <> "x")');
    const r = rp('ValidationRuleInactive', x);
    swappedAll(x, r, 3);
    expect(r.xml).toBe(vrOff('AND(ISBLANK(SFTK_Live_Blk2__c), ISBLANK(Name), LEN(Account.SFTK_Live_Blk2__c) > 5, SFTK_Live_Blk2__c <> "x")'));
    expect(r.xml).toContain('<active>false</active>');
    expect(r.how).toEqual(['formula: 3 references now SFTK_Live_Blk2__c']);
    expect(mentions(r.xml)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────── CustomField
const formulaField = formula => `<fullName>Account.SFTK_Live_Formula__c</fullName><externalId>false</externalId><formula>${e(formula)}</formula><formulaTreatBlanksAs>BlankAsZero</formulaTreatBlanksAs><label>SFTK Live Formula</label><required>false</required><type>Text</type><unique>false</unique>`;
// a roll-up summary on Account over Opportunity; the field under the knife lives on Opportunity
const rollup = (summarized, items, op = 'sum') => `<fullName>Account.SFTK_Live_Rollup__c</fullName><externalId>false</externalId><label>SFTK Live Rollup</label>${summarized ? `<summarizedField>${summarized}</summarizedField>` : ''}${items.map(([f, o, v]) => `<summaryFilterItems><field>${f}</field><operation>${o}</operation><value>${v}</value></summaryFilterItems>`).join('')}<summaryForeignKey>Opportunity.AccountId</summaryForeignKey><summaryOperation>${op}</summaryOperation><type>Summary</type>`;

describe('CustomField (formula field, roll-up summary, default value)', () => {
  describe('🗑 full delete', () => {
    it('the spec and the manifest: a CustomField, "Object.Field__c", inside the object file', () => {
      expect(M.sftkMdDeleteSpec('CustomField')).toEqual({ type: 'CustomField', mdType: 'CustomField', parent: 'CustomObject', tag: 'fields', folder: 'objects', suffix: 'object', what: 'formula or roll-up field', tooling: 'CustomField' });
      const f = destructive('CustomField', 'Account.SFTK_Live_Formula__c');
      expect(f).toEqual([{ name: 'package.xml', text: EMPTY_PKG }, { name: 'destructiveChangesPost.xml', text: manifest('CustomField', 'Account.SFTK_Live_Formula__c') }]);
    });
    it('the restore point of a formula field and of a roll-up: <fields> inside objects/Account.object', () => {
      const x = formulaField('SFTK_Live_Blk__c & " / " & Name');
      const f = M.sftkMdPackageFiles('CustomField', 'Account.SFTK_Live_Formula__c', x);
      expect(f.map(y => y.name)).toEqual(['package.xml', 'objects/Account.object']);
      expect(f[1].text).toBe(`<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject ${NS}><fields><fullName>SFTK_Live_Formula__c</fullName>${x.replace('<fullName>Account.SFTK_Live_Formula__c</fullName>', '')}</fields></CustomObject>`);
      const ru = rollup('Opportunity.SFTK_Live_Blk__c', [['Opportunity.StageName', 'equals', 'Closed Won']]);
      const g = M.sftkMdPackageFiles('CustomField', 'Account.SFTK_Live_Rollup__c', ru);
      expect(g[0].text).toBe(manifest('CustomField', 'Account.SFTK_Live_Rollup__c'));
      expect(g[1].text).toContain('<fields><fullName>SFTK_Live_Rollup__c</fullName><externalId>false</externalId>');
      expect(g[1].text).toContain('<summarizedField>Opportunity.SFTK_Live_Blk__c</summarizedField>');
      expect(M.sftkMdWellFormed(g[1].text)).toBeNull();
    });
    it('offered: ⇄ and 🗑 — ✂ is not (a formula cannot lose a reference)', () => {
      expect(M.sftkMdEditWays('CustomField')).toEqual({ remove: false, replace: true });
    });
  });

  describe('✂ remove, ONE mention', () => {
    it('formula field: refused with the ways that work, nothing changed', () => {
      const x = formulaField('SFTK_Live_Blk__c');
      refusedWhole(rm('CustomField', x), x, /a formula cannot lose a reference — ⇄ Replace it with another field, or 🗑 delete this formula field/);
    });
    it('roll-up that SUMS the field: refused, nothing changed', () => {
      const x = rollup('Opportunity.SFTK_Live_Blk__c', [['Opportunity.StageName', 'equals', 'Closed Won']]);
      refusedWhole(rm('CustomField', x, 'Opportunity'), x, /the roll-up sums this field — ⇄ Replace it, or 🗑 delete the roll-up field/);
    });
    it('roll-up whose FILTER names the field once: that criterion goes, everything else byte for byte (the engine; the ✂ button is not offered for this kind)', () => {
      const x = rollup('Opportunity.Amount', [['Opportunity.StageName', 'equals', 'Closed Won'], ['Opportunity.SFTK_Live_Blk__c', 'equals', 'x']]);
      const r = rm('CustomField', x, 'Opportunity');
      expect(r.refused).toBeNull(); expect(r.changed).toBe(true);
      expect(r.xml).toBe(rollup('Opportunity.Amount', [['Opportunity.StageName', 'equals', 'Closed Won']]));
      expect(r.how).toEqual(['roll-up filter: 1 criterion removed']);
      gone(r.xml, 'Opportunity');
    });
    it('a COUNT roll-up whose only filter names the field: the filter goes, a roll-up with no filter is left (valid)', () => {
      const x = rollup('', [['Opportunity.SFTK_Live_Blk__c', 'notEqual', '']], 'count');
      const r = rm('CustomField', x, 'Opportunity');
      expect(r.xml).toBe(rollup('', [], 'count'));
      expect(r.xml).not.toContain('<summaryFilterItems>');
      gone(r.xml, 'Opportunity');
    });
    it('a default value that names the field: not a place the engine edits — refused, nothing changed', () => {
      const x = '<fullName>Account.SFTK_Live_Def__c</fullName><defaultValue>SFTK_Live_Blk__c</defaultValue><externalId>false</externalId><label>SFTK Live Def</label><length>80</length><required>false</required><type>Text</type><unique>false</unique>';
      refusedWhole(rm('CustomField', x), x, /no formula, roll-up filter or summarized field names the field — edit it in Setup/);
      refusedWhole(rp('CustomField', x), x, /no formula, roll-up filter or summarized field names the field/);
    });
  });

  describe('✂ remove, SEVERAL mentions', () => {
    it('formula field naming it three times: refused as a whole', () => {
      const x = formulaField('IF(ISBLANK(SFTK_Live_Blk__c), "none", SFTK_Live_Blk__c & " / " & Account.SFTK_Live_Blk__c)');
      refusedWhole(rm('CustomField', x), x, /a formula cannot lose a reference/);
    });
    it('roll-up with TWO filter criteria on the field and one on another: both go in one pass, the third stays', () => {
      const x = rollup('Opportunity.Amount', [['Opportunity.SFTK_Live_Blk__c', 'notEqual', 'a'], ['Opportunity.StageName', 'equals', 'Closed Won'], ['Opportunity.SFTK_Live_Blk__c', 'notEqual', 'b']]);
      const r = rm('CustomField', x, 'Opportunity');
      expect(r.xml).toBe(rollup('Opportunity.Amount', [['Opportunity.StageName', 'equals', 'Closed Won']]));
      expect(r.how).toEqual(['roll-up filter: 2 criteria removed']);
      gone(r.xml, 'Opportunity');
    });
    it('roll-up that sums the field AND filters on it: the filter could go, the sum cannot — refused as a whole, nothing half-done', () => {
      const x = rollup('Opportunity.SFTK_Live_Blk__c', [['Opportunity.SFTK_Live_Blk__c', 'greaterThan', '0'], ['Opportunity.StageName', 'equals', 'Closed Won']]);
      refusedWhole(rm('CustomField', x, 'Opportunity'), x, /the roll-up sums this field/);
    });
  });

  describe('⇄ replace, several mentions', () => {
    it('formula field: every reference becomes the new field', () => {
      const x = formulaField('IF(ISBLANK(SFTK_Live_Blk__c), "none", SFTK_Live_Blk__c & " / " & Account.SFTK_Live_Blk__c)');
      const r = rp('CustomField', x);
      swappedAll(x, r, 3);
      expect(r.xml).toBe(formulaField('IF(ISBLANK(SFTK_Live_Blk2__c), "none", SFTK_Live_Blk2__c & " / " & Account.SFTK_Live_Blk2__c)'));
      expect(r.how).toEqual(['formula: 3 references now SFTK_Live_Blk2__c']);
      expect(mentions(r.xml)).toBe(false);
    });
    it('roll-up: the summed field and both filter criteria become the new field, "Opportunity." kept', () => {
      const x = rollup('Opportunity.SFTK_Live_Blk__c', [['Opportunity.SFTK_Live_Blk__c', 'greaterThan', '0'], ['Opportunity.StageName', 'equals', 'Closed Won'], ['Opportunity.SFTK_Live_Blk__c', 'lessThan', '9']]);
      const r = rp('CustomField', x, 'Opportunity');
      swappedAll(x, r, 3);
      expect(r.xml).toBe(rollup('Opportunity.SFTK_Live_Blk2__c', [['Opportunity.SFTK_Live_Blk2__c', 'greaterThan', '0'], ['Opportunity.StageName', 'equals', 'Closed Won'], ['Opportunity.SFTK_Live_Blk2__c', 'lessThan', '9']]));
      expect(r.how).toEqual(['roll-up filter: 2 criteria now SFTK_Live_Blk2__c', 'summarized field now SFTK_Live_Blk2__c']);
      expect(mentions(r.xml, 'Opportunity')).toBe(false);
    });
  });
});

// ──────────────────────────────────────────────────────────────── LookupFilter
// the filter lives inside a lookup field (Contact.SFTK_Live_Lk__c → Account); the field under the knife is Account's
const lookup = (items, logic = '') => `<fullName>Contact.SFTK_Live_Lk__c</fullName><deleteConstraint>SetNull</deleteConstraint><label>SFTK Live Lookup</label>${items == null ? '' : `<lookupFilter><active>true</active>${logic ? `<booleanFilter>${logic}</booleanFilter>` : ''}<errorMessage>SFTK live demo</errorMessage>${items.join('')}<infoMessage>SFTK live demo</infoMessage><isOptional>false</isOptional></lookupFilter>`}<referenceTo>Account</referenceTo><relationshipLabel>SFTK Live</relationshipLabel><relationshipName>SFTK_Live_Lk</relationshipName><required>false</required><trackFeedHistory>false</trackFeedHistory><type>Lookup</type>`;
const fi = (field, op, value, valueField) => `<filterItems><field>${field}</field><operation>${op}</operation>${valueField ? `<valueField>${valueField}</valueField>` : `<value>${value}</value>`}</filterItems>`;
const FLD = fi('Account.SFTK_Live_Blk__c', 'equals', 'x'), TYPE = fi('Account.Type', 'equals', 'Customer'), SRC = fi('Account.Id', 'equals', '', '$Source.AccountId');

describe('LookupFilter', () => {
  describe('🗑 full delete (of the filter — the lookup field and its data stay)', () => {
    it('no delete spec on purpose: the filter is a part of a CustomField; 🗑 is still offered, through a path of its own', () => {
      expect(M.sftkMdDeleteSpec('LookupFilter')).toBeNull();
      expect(FC).toContain(": type === 'LookupFilter' ? { type, mdType: 'CustomField', what: 'lookup filter', special: 'lookupFilter' }");
      expect(FC).toContain("return { files: sftkMdPackageFiles('CustomField', fullName, rec.innerXml), deployFiles: sftkMdPackageFiles('CustomField', fullName, res.xml),");
      expect(M.sftkMdEditWays('LookupFilter')).toEqual({ remove: true, replace: true });
    });
    it('what is deployed: the lookup field WITHOUT <lookupFilter>, as a CustomField in objects/Contact.object — no destructive manifest', () => {
      const x = lookup([TYPE, FLD], '1 OR 2');
      const res = M.sftkMdLookupFilterRemove(x);
      expect(res.removed).toBe(1);
      expect(res.xml).toBe(lookup(null));
      gone(res.xml);
      const dep = M.sftkMdPackageFiles('CustomField', 'Contact.SFTK_Live_Lk__c', res.xml);
      expect(dep.map(y => y.name)).toEqual(['package.xml', 'objects/Contact.object']);
      expect(dep[0].text).toBe(manifest('CustomField', 'Contact.SFTK_Live_Lk__c'));
      expect(dep[1].text).toBe(`<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject ${NS}><fields><fullName>SFTK_Live_Lk__c</fullName>${lookup(null).replace('<fullName>Contact.SFTK_Live_Lk__c</fullName>', '')}</fields></CustomObject>`);
      expect(M.sftkMdWellFormed(dep[1].text)).toBeNull();
      // the restore point is the field as it was, filter and all
      const back = M.sftkMdPackageFiles('CustomField', 'Contact.SFTK_Live_Lk__c', x);
      expect(back[1].text).toContain(`<lookupFilter><active>true</active><booleanFilter>1 OR 2</booleanFilter>`);
    });
    it('a field with no filter: nothing to remove', () => {
      expect(M.sftkMdLookupFilterRemove(lookup(null))).toEqual({ xml: lookup(null), removed: 0 });
    });
  });

  describe('✂ remove, ONE mention', () => {
    it('the field is the filter\'s ONLY condition: the whole filter goes (no empty <lookupFilter> is left), the lookup field stays', () => {
      const x = lookup([FLD]);
      const r = rm('LookupFilter', x);
      expect(r.refused).toBeNull(); expect(r.changed).toBe(true);
      expect(r.xml).toBe(lookup(null));
      expect(r.how).toEqual(['the filter had no other condition — the whole lookup filter is removed; the lookup field and its data stay']);
      gone(r.xml);
    });
    it('one of two conditions, no numbered logic: it goes, the other stays, the rest of the filter byte for byte', () => {
      const x = lookup([TYPE, FLD]);
      const r = rm('LookupFilter', x);
      expect(r.xml).toBe(lookup([TYPE]));
      expect(r.how).toEqual(['filter: 1 condition removed, 1 condition kept']);
      gone(r.xml);
    });
    it('written bare (Field__c) and in another case: the same', () => {
      const x = lookup([fi('sftk_live_blk__c', 'equals', 'x'), SRC]);
      const r = rm('LookupFilter', x);
      expect(r.xml).toBe(lookup([SRC]));
      gone(r.xml);
    });
    it('one of two conditions under numbered logic (1 AND 2): refused — taking one out would leave a dangling number — nothing changed', () => {
      const x = lookup([TYPE, FLD], '1 AND 2');
      refusedWhole(rm('LookupFilter', x), x, /the filter’s logic numbers its conditions — taking one out changes what the others mean; edit it in Setup, or 🗑 remove the whole filter/);
    });
    it('the filter does not name the field / the field has no filter: refused', () => {
      const x = lookup([TYPE, SRC]);
      refusedWhole(rm('LookupFilter', x), x, /no filter condition names the field/);
      refusedWhole(rm('LookupFilter', lookup(null)), lookup(null), /has no lookup filter any more — re-scan/);
    });
    // FIXED 2026-11-14 (was a gap): a field of the SOURCE object (the object the lookup field sits on) is written
    // $Source.Field__c in a lookup filter. Neither ✂ nor ⇄ reads that spelling: both are refused with
    // "no filter condition names the field", although one does.
    it('the field as $Source.Field__c (a field of the lookup\'s own object) — ⇄ is refused as "no filter condition names the field"', () => {
      const x = lookup([fi('Account.Name', 'equals', '', '$Source.SFTK_Live_Blk__c')]);
      const r = M.sftkMdEditField('LookupFilter', x, 'Contact', F, N);
      expect(r.refused).toBeNull();
      expect(r.xml).toBe(lookup([fi('Account.Name', 'equals', '', '$Source.SFTK_Live_Blk2__c')]));
    });
  });

  describe('✂ remove, SEVERAL mentions', () => {
    it('two conditions name the field, one does not: both go in one pass, the third stays', () => {
      const x = lookup([FLD, TYPE, fi('Account.SFTK_Live_Blk__c', 'notEqual', 'y')]);
      const r = rm('LookupFilter', x);
      expect(r.xml).toBe(lookup([TYPE]));
      expect(r.how).toEqual(['filter: 2 conditions removed, 1 condition kept']);
      gone(r.xml);
    });
    it('every condition names the field (twice): the whole filter goes', () => {
      const x = lookup([FLD, fi('SFTK_Live_Blk__c', 'notEqual', 'y')]);
      const r = rm('LookupFilter', x);
      expect(r.xml).toBe(lookup(null));
      expect(r.how[0]).toMatch(/the whole lookup filter is removed/);
      gone(r.xml);
    });
    it('two of three under numbered logic (1 AND (2 OR 3)): refused as a whole, nothing half-done', () => {
      const x = lookup([FLD, TYPE, fi('Account.SFTK_Live_Blk__c', 'notEqual', 'y')], '1 AND (2 OR 3)');
      refusedWhole(rm('LookupFilter', x), x, /the filter’s logic numbers its conditions/);
    });
    // FIXED 2026-11-14 (was a product bug): on a self-lookup (Account → Account) the SAME field is "Account.Field__c" on the looked-up
    // record and "$Source.Field__c" on the record being edited. ✂ takes out the condition whose <field> names it and
    // keeps the one whose <valueField> names it; the result still references the field and is reported as done.
    it('the field in a <field> and in another condition\'s <valueField> ($Source.) — ✂ leaves the second one', () => {
      const x = lookup([FLD, fi('Account.Type', 'equals', '', '$Source.SFTK_Live_Blk__c'), TYPE]).replace('Contact.SFTK_Live_Lk__c', 'Account.SFTK_Live_Lk__c');
      const r = rm('LookupFilter', x);
      expect(r.refused || !names(r.xml)).toBeTruthy();
    });
  });

  describe('⇄ replace, several mentions', () => {
    it('every condition that names the field names the new one — numbered logic and the other conditions untouched', () => {
      const x = lookup([FLD, TYPE, fi('SFTK_Live_Blk__c', 'notEqual', 'y')], '1 AND (2 OR 3)');
      const r = rp('LookupFilter', x);
      swappedAll(x, r, 2);
      expect(r.xml).toBe(lookup([fi('Account.SFTK_Live_Blk2__c', 'equals', 'x'), TYPE, fi('SFTK_Live_Blk2__c', 'notEqual', 'y')], '1 AND (2 OR 3)'));
      expect(r.how).toEqual(['filter: 2 conditions now SFTK_Live_Blk2__c']);
      expect(mentions(r.xml)).toBe(false);
    });
    // FIXED 2026-11-14 (was a product bug): the same self-lookup as above — ⇄ renames <field> and leaves <valueField>$Source.Field__c</valueField>.
    it('<field>Account.F</field> compared with <valueField>$Source.F</valueField> — ⇄ renames one side only', () => {
      const x = lookup([fi('Account.SFTK_Live_Blk__c', 'equals', '', '$Source.SFTK_Live_Blk__c')]).replace('Contact.SFTK_Live_Lk__c', 'Account.SFTK_Live_Lk__c');
      const r = rp('LookupFilter', x);
      expect(r.refused || !names(r.xml)).toBeTruthy();
    });
  });
});

// ───────────────────────────────────────────────────────────────────── WebLink
const link = url => `<fullName>Account.SFTK_Live_Btn</fullName><availability>online</availability><displayType>button</displayType><encodingKey>UTF-8</encodingKey><hasMenubar>false</hasMenubar><hasScrollbars>true</hasScrollbars><hasToolbar>false</hasToolbar><height>600</height><isResizable>true</isResizable><linkType>url</linkType><masterLabel>SFTK Live Btn</masterLabel><openType>newWindow</openType><position>none</position><protected>false</protected><showsLocation>false</showsLocation><showsStatus>false</showsStatus><url>${e(url)}</url>`;
const jsButton = body => `<fullName>Account.SFTK_Live_Js</fullName><availability>online</availability><displayType>button</displayType><linkType>javascript</linkType><masterLabel>SFTK Live Js</masterLabel><openType>onClickJavaScript</openType><protected>false</protected><url>${e(body)}</url>`;

describe('WebLink (custom button or link)', () => {
  describe('🗑 full delete', () => {
    it('the spec and the manifest: a WebLink, "Object.Button", inside the object file', () => {
      expect(M.sftkMdDeleteSpec('WebLink')).toEqual({ type: 'WebLink', mdType: 'WebLink', parent: 'CustomObject', tag: 'webLinks', folder: 'objects', suffix: 'object', what: 'custom button or link', tooling: 'WebLink' });
      expect(destructive('WebLink', 'Account.SFTK_Live_Btn')).toEqual([{ name: 'package.xml', text: EMPTY_PKG }, { name: 'destructiveChangesPost.xml', text: manifest('WebLink', 'Account.SFTK_Live_Btn') }]);
    });
    it('the restore point: <webLinks> inside objects/Account.object, the URL as read', () => {
      const x = link('https://example.invalid/?x={!Account.SFTK_Live_Blk__c}&y={!Account.Id}');
      const f = M.sftkMdPackageFiles('WebLink', 'Account.SFTK_Live_Btn', x);
      expect(f.map(y => y.name)).toEqual(['package.xml', 'objects/Account.object']);
      expect(f[0].text).toBe(manifest('WebLink', 'Account.SFTK_Live_Btn'));
      expect(f[1].text).toBe(`<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject ${NS}><webLinks><fullName>SFTK_Live_Btn</fullName>${x.replace('<fullName>Account.SFTK_Live_Btn</fullName>', '')}</webLinks></CustomObject>`);
      expect(f[1].text).toContain('?x={!Account.SFTK_Live_Blk__c}&amp;y={!Account.Id}</url>');
      expect(M.sftkMdWellFormed(f[1].text)).toBeNull();
    });
    it('offered: ⇄ and 🗑 — ✂ is not (a URL cannot lose a merge field)', () => {
      expect(M.sftkMdEditWays('WebLink')).toEqual({ remove: false, replace: true });
    });
  });
  it('✂, ONE mention: refused with the ways that work, nothing changed', () => {
    const x = link('https://example.invalid/?x={!Account.SFTK_Live_Blk__c}');
    refusedWhole(rm('WebLink', x), x, /a URL cannot lose a merge field and keep working — ⇄ Replace it with another field, or 🗑 delete the button/);
  });
  it('✂, SEVERAL mentions (a URL and a JavaScript button): refused as a whole', () => {
    const x = link('https://example.invalid/?x={!Account.SFTK_Live_Blk__c}&y={!URLENCODE(Account.SFTK_Live_Blk__c)}&z={!Account.Id}');
    refusedWhole(rm('WebLink', x), x, /a URL cannot lose a merge field/);
    const js = jsButton('{!REQUIRESCRIPT("/soap/ajax/62.0/connection.js")}\nvar v = "{!Account.SFTK_Live_Blk__c}";\nif (v < 5 && "{!JSENCODE(Account.SFTK_Live_Blk__c)}") { alert(v); }');
    refusedWhole(rm('WebLink', js), js, /a URL cannot lose a merge field/);
  });
  it('a URL that does not name the field as a whole token: refused, ✂ and ⇄', () => {
    const x = link('https://example.invalid/?x={!Account.SFTK_Live_Blk__cX}');
    refusedWhole(rm('WebLink', x), x, /the URL does not name the field as a whole token — edit it in Setup/);
    refusedWhole(rp('WebLink', x), x, /the URL does not name the field as a whole token/);
  });
  it('⇄, one mention: the merge field names the new field, every other property byte for byte', () => {
    const x = link('https://example.invalid/?x={!Account.SFTK_Live_Blk__c}');
    const r = rp('WebLink', x);
    expect(r.xml).toBe(link('https://example.invalid/?x={!Account.SFTK_Live_Blk2__c}'));
    expect(r.how).toEqual(['URL: 1 reference now SFTK_Live_Blk2__c']);
    expect(names(r.xml)).toBe(false); wellFormed(r.xml);
  });
  it('⇄, several mentions: every merge field becomes the new field — in a URL (the &amp; kept) and in a JavaScript button', () => {
    const x = link('https://example.invalid/?x={!Account.SFTK_Live_Blk__c}&y={!URLENCODE(Account.SFTK_Live_Blk__c)}&z={!Account.Id}&w={!Account.SFTK_Live_Blk__cX}');
    const r = rp('WebLink', x);
    expect(r.xml).toBe(link('https://example.invalid/?x={!Account.SFTK_Live_Blk2__c}&y={!URLENCODE(Account.SFTK_Live_Blk2__c)}&z={!Account.Id}&w={!Account.SFTK_Live_Blk__cX}'));
    expect(r.how).toEqual(['URL: 2 references now SFTK_Live_Blk2__c']);
    expect(names(r.xml)).toBe(false); wellFormed(r.xml);
    const js = jsButton('{!REQUIRESCRIPT("/soap/ajax/62.0/connection.js")}\nvar v = "{!Account.SFTK_Live_Blk__c}";\nif (v < 5 && "{!JSENCODE(Account.SFTK_Live_Blk__c)}") { alert(v); }\nvar q = "SELECT SFTK_Live_Blk__c FROM Account";');
    const j = rp('WebLink', js);
    swappedAll(js, j, 3);
    expect(j.xml).toBe(jsButton('{!REQUIRESCRIPT("/soap/ajax/62.0/connection.js")}\nvar v = "{!Account.SFTK_Live_Blk2__c}";\nif (v < 5 && "{!JSENCODE(Account.SFTK_Live_Blk2__c)}") { alert(v); }\nvar q = "SELECT SFTK_Live_Blk2__c FROM Account";'));
    expect(j.how).toEqual(['URL: 3 references now SFTK_Live_Blk2__c']);
  });
});

// ───────────────────────────────────────────── RestrictionRule (and scoping rules)
const rule = (kind, recordFilter, userCriteria = "$User.Username = 'nobody@sftk.invalid'") => `<fullName>SFTK_Live_${kind}</fullName><active>true</active><description>SFTK live demo</description><enforcementType>${kind}</enforcementType><masterLabel>SFTK Live ${kind}</masterLabel><recordFilter>${e(recordFilter)}</recordFilter><targetEntity>Account</targetEntity><userCriteria>${e(userCriteria)}</userCriteria><version>1</version>`;

describe.each([['Restrict', 'restriction rule'], ['Scoping', 'scoping rule']])('RestrictionRule — a %s rule (%s)', (kind) => {
  const full = `SFTK_Live_${kind}`;
  describe('🗑 full delete', () => {
    it('the spec and the manifest: a top-level RestrictionRule, by its own name', () => {
      expect(M.sftkMdDeleteSpec('RestrictionRule')).toEqual({ type: 'RestrictionRule', mdType: 'RestrictionRule', folder: 'restrictionRules', suffix: 'rule', what: 'scoping or restriction rule', tooling: 'RestrictionRule' });
      expect(destructive('RestrictionRule', full)).toEqual([{ name: 'package.xml', text: EMPTY_PKG }, { name: 'destructiveChangesPost.xml', text: manifest('RestrictionRule', full) }]);
    });
    it('the restore point: a file of its own, restrictionRules/<name>.rule, the fullName dropped, the rest as read', () => {
      const x = rule(kind, "SFTK_Live_Blk__c = 'x'");
      const f = M.sftkMdPackageFiles('RestrictionRule', full, x);
      expect(f.map(y => y.name)).toEqual(['package.xml', `restrictionRules/${full}.rule`]);
      expect(f[0].text).toBe(manifest('RestrictionRule', full));
      expect(f[1].text).toBe(`<?xml version="1.0" encoding="UTF-8"?>\n<RestrictionRule ${NS}>${x.replace(`<fullName>${full}</fullName>`, '')}</RestrictionRule>`);
      expect(f[1].text).toContain(`<enforcementType>${kind}</enforcementType>`);
      expect(M.sftkMdWellFormed(f[1].text)).toBeNull();
    });
    it('offered: ⇄ and 🗑 — ✂ is not (a record filter cannot lose its condition)', () => {
      expect(M.sftkMdEditWays('RestrictionRule')).toEqual({ remove: false, replace: true });
    });
  });
  it('✂, ONE mention: refused with the ways that work, nothing changed', () => {
    const x = rule(kind, "SFTK_Live_Blk__c = 'x'");
    refusedWhole(rm('RestrictionRule', x), x, /a record filter cannot lose a condition here — ⇄ Replace it with another field, or 🗑 delete the rule/);
  });
  it('✂, SEVERAL mentions: refused as a whole', () => {
    const x = rule(kind, "SFTK_Live_Blk__c = 'x' || Account.SFTK_Live_Blk__c = 'y'");
    refusedWhole(rm('RestrictionRule', x), x, /a record filter cannot lose a condition here/);
  });
  it('a record filter that does not name the field as a whole token: refused, ✂ and ⇄', () => {
    const x = rule(kind, "SFTK_Live_Blk__cX = 'x'");
    refusedWhole(rm('RestrictionRule', x), x, /the record filter does not name the field as a whole token — edit it in Setup/);
    refusedWhole(rp('RestrictionRule', x), x, /the record filter does not name the field as a whole token/);
  });
  it('⇄, one mention: the record filter names the new field, the user criteria and everything else byte for byte', () => {
    const x = rule(kind, "SFTK_Live_Blk__c = 'x'");
    const r = rp('RestrictionRule', x);
    expect(r.xml).toBe(rule(kind, "SFTK_Live_Blk2__c = 'x'"));
    expect(r.how).toEqual(['record filter: 1 reference now SFTK_Live_Blk2__c']);
    expect(names(r.xml)).toBe(false); expect(mentions(r.xml)).toBe(false); wellFormed(r.xml);
  });
  it('⇄, several mentions: every one becomes the new field', () => {
    const x = rule(kind, "SFTK_Live_Blk__c = 'x' || Account.SFTK_Live_Blk__c = $User.Department || sftk_live_blk__c = 'z'");
    const r = rp('RestrictionRule', x);
    swappedAll(x, r, 3);
    expect(r.xml).toBe(rule(kind, "SFTK_Live_Blk2__c = 'x' || Account.SFTK_Live_Blk2__c = $User.Department || SFTK_Live_Blk2__c = 'z'"));
    expect(r.how).toEqual(['record filter: 3 references now SFTK_Live_Blk2__c']);
    expect(mentions(r.xml)).toBe(false);
  });
  // FIXED 2026-11-14 (was a product bug): the field under the knife is a custom field of User. A rule names it in <userCriteria>
  // ($User.Field__c = …) and can name it in <recordFilter> too (… = $User.Field__c). Only <recordFilter> is read:
  //   · named in both → ⇄ renames the record filter, leaves the user criteria, and reports it as done;
  //   · named in the user criteria only → refused as "the record filter does not name the field".
  it('a User field in <recordFilter> AND <userCriteria> — ⇄ renames the record filter only', () => {
    const x = rule(kind, 'Region__c = $User.SFTK_Live_Blk__c', "$User.SFTK_Live_Blk__c = 'EMEA'");
    const r = M.sftkMdEditField('RestrictionRule', x, 'User', F, N);
    expect(r.refused || !names(r.xml)).toBeTruthy();
  });
  it('a User field in <userCriteria> only — ⇄ is refused as "the record filter does not name the field"', () => {
    const x = rule(kind, 'OwnerId = $User.Id', "$User.SFTK_Live_Blk__c = 'EMEA'");
    const r = M.sftkMdEditField('RestrictionRule', x, 'User', F, N);
    expect(r.refused).toBeNull();
    expect(r.xml).toBe(rule(kind, 'OwnerId = $User.Id', "$User.SFTK_Live_Blk2__c = 'EMEA'"));
  });
});
