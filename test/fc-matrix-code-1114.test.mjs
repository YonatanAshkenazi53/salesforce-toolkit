// The matrix, code family (user 2026-11-14: from every metadata type, a full delete and a partial remove where the
// field appears ONE time and where it appears A COUPLE of times). Apex class / trigger, Visualforce page / component,
// LWC, Aura, email templates (classic text, classic HTML, Lightning, Visualforce), and the kinds that are only
// deletable or only listed: entitlement process, service channel, custom-setting record, profiles / permission sets
// (field permissions), translations.
//
// What the tool OFFERS is what is tested: code has ⇄ (a whole-word rename) and ✎ (a hand edit), never ✂; an email
// template has ✂ / ⇄ / ✎ and no 🗑; an entitlement process and a service channel have 🗑 only; the rest is listed.
// Every function is the product's own, sliced out of its source file — nothing is re-implemented here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const M = extractFunctions('sftk-mdapi.js', [
  'sftkMdCodeReplace', 'sftkMdCodeHits', 'sftkMdCodeWays', 'sftkMdCodeSame', 'sftkMdEditWays', 'sftkMdEditField',
  'sftkMdDeleteSpec', '_sftkMdDeleteTable', 'sftkMdDestructiveFiles', 'sftkMdPackageFiles', 'sftkMdCodeFiles', 'sftkMdBundleFiles',
  '_sftkPkgXml', '_sftkApiVer', 'sftkMdEscape', 'sftkMdUnescape', 'sftkMdFindElement', 'sftkMdChildText', 'sftkMdChildren', 'sftkMdRecordFileXml',
  'sftkMdMentionsField', 'sftkMdWellFormed', 'sftkMdLeadMappingRemove', 'sftkMdLookupFilterRemove', '_sftkMdFieldIs', '_sftkMdRenameVal',
  '_sftkMdWalk', '_sftkMdSwapToken', 'sftkFormulaDropField', '_sftkMdHasLogic',
]);
const T = extractFunctions('sftk-emailtpl.js', ['sftkTplTextFields', '_sftkTplRx', 'sftkTplHits', 'sftkTplNamesField', 'sftkTplReplace', 'sftkTplRemove', 'sftkTplKind', '_sftkTplForeign']);
const S = extractFunctions('sftk-sweep.js', ['sftkSweepForms', 'sftkSweepHits', 'sftkSweepKindTable', 'sftkSweepSections', '_sftkSweepSectionAt', 'sftkSweepKind', 'sftkSweepRun', 'sftkSweepJoinKind', 'sftkSweepIdQuery', 'sftkSweepTypes', '_sftkSweepSkip', '_sftkSweepFolderKinds']);
const R = extractFunctions('sftk-fieldreplace.js', ['sftkFlsCopyPlan']);
// the Aura file names live in field-cleaner.js as a table (not a top-level function): the table itself is evaluated
const _af = FC.indexOf('const _AURA_FILE = ');
const AURA_FILE = new Function(`${FC.slice(_af, FC.indexOf('};', _af) + 2)}\nreturn _AURA_FILE;`)();

const OBJ = 'Account', F = 'SFTK_Mx__c', NF = 'SFTK_Mx2__c';
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// a plain whole-word search, any case — the bare name; it finds "Account.SFTK_Mx__c" too (the dot is not a word character)
const words = (text, name) => (String(text).match(new RegExp(`(?<![A-Za-z0-9_])${esc(name)}(?![A-Za-z0-9_])`, 'gi')) || []).length;
const qualified = (text, obj, name) => (String(text).match(new RegExp(`(?<![A-Za-z0-9_])${esc(obj)}\\.${esc(name)}(?![A-Za-z0-9_])`, 'gi')) || []).length;
// TYPE_CFG is a table inside field-cleaner.js: the row of a kind, as the source writes it
const cfgRow = type => { const m = FC.match(new RegExp(`^\\s{4}${type}:\\s*\\{[^\\n]*?fixable: (true|false), sev: '([a-z]+)'`, 'm')); return m ? { fixable: m[1] === 'true', sev: m[2] } : null; };
const fileOf = (files, name) => (files.find(f => f.name === name) || {}).text;
const destructive = (mdType, member) => {
  const f = M.sftkMdDestructiveFiles([[mdType, member]]);
  expect(f.map(x => x.name)).toEqual(['package.xml', 'destructiveChangesPost.xml']);
  expect(f[0].text).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n    <version>62.0</version>\n</Package>');
  expect(f[1].text).toBe(`<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n    <types>\n        <members>${member}</members>\n        <name>${mdType}</name>\n    </types>\n    <version>62.0</version>\n</Package>`);
  expect(M.sftkMdWellFormed(f[0].text)).toBeNull();
  expect(M.sftkMdWellFormed(f[1].text)).toBeNull();
  return f;
};
// ⇄ in code and the checks every case shares: n places, every other byte as it was, the old name gone, the new one there
const swap = (sources, n, filesChanged) => {
  const before = sources.map(s => ({ ...s }));
  const r = M.sftkMdCodeReplace(sources, F, NF);
  expect(r.n).toBe(n);
  expect(r.files).toBe(filesChanged);
  expect(sources).toEqual(before);                                        // the input is not written to
  r.sources.forEach((s, i) => {
    expect(s.path).toBe(before[i].path);
    expect(words(s.source, F)).toBe(0);
    expect(M.sftkMdCodeHits(s.source, F)).toEqual([]);                    // the product's own "still names the field"
    expect(words(s.source, NF)).toBe(s.n);
    // byte for byte: putting the old name back where the new one stands gives the original (spelling aside)
    expect(s.source.split(NF).join(F).toLowerCase()).toBe(before[i].source.toLowerCase());
    expect(s.source.length).toBe(before[i].source.length + s.n * (NF.length - F.length));
    if (!s.n) expect(s.source).toBe(before[i].source);
  });
  return r;
};
// ✂ is not offered for code: no way of the declarative editor, and the editor itself refuses, the text untouched
const noRemove = (type, text) => {
  expect(M.sftkMdCodeWays(type)).toEqual({ replace: true, edit: true, remove: false });
  expect(M.sftkMdEditWays(type)).toBeNull();
  const r = M.sftkMdEditField(type, text, OBJ, F, null);
  expect(r.refused).toBe('this kind is not edited here — 🗑 delete it, or edit it in Setup');
  expect(r.changed).toBe(false);
  expect(r.xml).toBe(text);
  expect(r.how).toEqual([]);
};

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Apex class
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
const CLS_ONE = `public with sharing class SftkMxOne {
    public static List<Account> hot() {
        return [SELECT Id, Name FROM Account WHERE SFTK_Mx__c = 'Hot' LIMIT 50];
    }
    // SFTK_Mx__cX and XSFTK_Mx__c and SFTK_Mx__city are other names
    public static String other(Account a) { return a.SFTK_Mx2_Old__c; }
}`;
const CLS_MANY = `public with sharing class SftkMxMany {
    static final String FIELD = 'Account.SFTK_Mx__c';
    public static void stamp(List<Account> rows) {
        for (Account a : rows) {
            if (a.SFTK_Mx__c == null) a.sftk_mx__c = 'New';   // both spellings
        }
        Schema.SObjectField f = Account.SFTK_Mx__c;
        Database.query('SELECT Id FROM Account WHERE SFTK_Mx__c != null');
    }
    // SFTK_Mx__cX is another field
}`;

describe('ApexClass', () => {
  it('🗑 full delete: classes/Name.cls, the destructive manifest names the class, the restore package is its source and meta', () => {
    expect(M.sftkMdDeleteSpec('ApexClass')).toEqual({ type: 'ApexClass', mdType: 'ApexClass', code: 'Body', folder: 'classes', suffix: 'cls', what: 'Apex class', tooling: 'ApexClass', metaTag: 'ApexClass' });
    destructive('ApexClass', 'SftkMxOne');
    const back = M.sftkMdCodeFiles('ApexClass', 'SftkMxOne', CLS_ONE, 62);
    expect(back.map(f => f.name)).toEqual(['package.xml', 'classes/SftkMxOne.cls', 'classes/SftkMxOne.cls-meta.xml']);
    expect(back[0].text).toContain('<members>SftkMxOne</members>\n        <name>ApexClass</name>');
    expect(back[1].text).toBe(CLS_ONE);                                   // the source byte for byte
    expect(back[2].text).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><status>Active</status></ApexClass>');
    expect(M.sftkMdWellFormed(back[2].text)).toBeNull();
    expect(M.sftkMdPackageFiles('ApexClass', 'SftkMxOne', CLS_ONE)).toBeNull();   // code is never packaged as a record
    expect(cfgRow('ApexClass')).toEqual({ fixable: false, sev: 'blocker' });
  });
  it('✂ is not offered — one mention or several, the editor refuses and the source is untouched', () => {
    noRemove('ApexClass', CLS_ONE);
    noRemove('ApexClass', CLS_MANY);
    expect(FC).toContain('✂ Remove is not offered for code — which line of a program goes is yours to decide, in ✎ Edit code.');
  });
  it('one mention: 🔍 marks its line; ⇄ renames that one place and nothing else', () => {
    expect(words(CLS_ONE, F)).toBe(1);
    expect(M.sftkMdCodeHits(CLS_ONE, F)).toEqual([{ line: 3, text: "        return [SELECT Id, Name FROM Account WHERE SFTK_Mx__c = 'Hot' LIMIT 50];" }]);
    const r = swap([{ path: 'classes/SftkMxOne.cls', file: 'SftkMxOne.cls', source: CLS_ONE }], 1, 1);
    expect(r.sources[0].source).toBe(CLS_ONE.replace("WHERE SFTK_Mx__c = 'Hot'", "WHERE SFTK_Mx2__c = 'Hot'"));
    expect(r.sources[0].source).toContain('// SFTK_Mx__cX and XSFTK_Mx__c and SFTK_Mx__city are other names');
    expect(r.sources[0].source).toContain('a.SFTK_Mx2_Old__c');
    expect(r.sources[0].file).toBe('SftkMxOne.cls');                      // what the caller put on a source rides along
    // the deploy that follows: the edited source, the meta as it was
    const dep = M.sftkMdCodeFiles('ApexClass', 'SftkMxOne', r.sources[0].source, 62);
    expect(dep[1].text).toBe(r.sources[0].source);
    expect(M.sftkMdCodeSame(dep[1].text, CLS_ONE)).toBe(false);
  });
  it('several mentions (a constant, an if, an assignment in another case, a token, a dynamic query): all five in one pass', () => {
    expect(words(CLS_MANY, F)).toBe(5);
    expect(qualified(CLS_MANY, OBJ, F)).toBe(2);
    expect(M.sftkMdCodeHits(CLS_MANY, F).map(h => h.line)).toEqual([2, 5, 7, 8]);
    const r = swap([{ path: 'classes/SftkMxMany.cls', source: CLS_MANY }], 5, 1);
    const out = r.sources[0].source;
    expect(out).toContain("static final String FIELD = 'Account.SFTK_Mx2__c';");
    expect(out).toContain("if (a.SFTK_Mx2__c == null) a.SFTK_Mx2__c = 'New';");     // the new name as given, whatever the old spelling
    expect(out).toContain('Schema.SObjectField f = Account.SFTK_Mx2__c;');
    expect(out).toContain("'SELECT Id FROM Account WHERE SFTK_Mx2__c != null'");
    expect(out).toContain('// SFTK_Mx__cX is another field');
    expect(qualified(out, OBJ, NF)).toBe(2);
  });
  it('✎ a hand edit is deployed as written; a no-op edit (line endings, trailing blanks) is no change', () => {
    const hand = CLS_ONE.replace(" WHERE SFTK_Mx__c = 'Hot'", '');
    expect(M.sftkMdCodeHits(hand, F)).toEqual([]);
    expect(M.sftkMdCodeSame(hand, CLS_ONE)).toBe(false);
    expect(M.sftkMdCodeSame(CLS_ONE.replace(/\n/g, '\r\n') + '  \r\n', CLS_ONE)).toBe(true);
    expect(M.sftkMdCodeFiles('ApexClass', 'SftkMxOne', hand, '62')[1].text).toBe(hand);
  });
  // PRODUCT BUG: ⇄ in code is a whole-word rename of the bare API name, so another object's field of the SAME name
  // ("Contact.SFTK_Mx__c", written out with its object) is renamed too when Account.SFTK_Mx__c is the field being
  // replaced. In a string (dynamic SOQL, a Schema lookup by name) Apex still compiles and breaks at run time.
  it.skip('PRODUCT BUG: ⇄ renames "Contact.SFTK_Mx__c" — another object\'s field of the same name — when replacing Account.SFTK_Mx__c', () => {
    const src = "public class X {\n  static String a = 'Account.SFTK_Mx__c';\n  static String c = 'Contact.SFTK_Mx__c';\n  Schema.SObjectField t = Contact.SFTK_Mx__c;\n}";
    const r = M.sftkMdCodeReplace([{ path: 'classes/X.cls', source: src }], F, NF);
    expect(r.sources[0].source).toContain("'Account.SFTK_Mx2__c'");
    expect(r.sources[0].source).toContain("'Contact.SFTK_Mx__c'");
    expect(r.sources[0].source).toContain('Contact.SFTK_Mx__c;');
    expect(r.n).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Apex trigger
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
const TRG_ONE = `trigger SftkMxTrg on Account (before insert, before update) {
    for (Account a : Trigger.new) {
        if (a.SFTK_Mx__c == 'Hot') a.Rating = 'Hot';
    }
}`;
const TRG_MANY = `trigger SftkMxTrgMany on Account (before update) {
    for (Account a : Trigger.new) {
        Account was = Trigger.oldMap.get(a.Id);
        if (a.SFTK_Mx__c != was.SFTK_Mx__c) {
            a.Description = 'SFTK_Mx__c changed';      // a text mention
        }
    }
}`;
describe('ApexTrigger', () => {
  it('🗑 full delete: triggers/Name.trigger, the manifest, the restore package', () => {
    expect(M.sftkMdDeleteSpec('ApexTrigger')).toEqual({ type: 'ApexTrigger', mdType: 'ApexTrigger', code: 'Body', folder: 'triggers', suffix: 'trigger', what: 'Apex trigger', tooling: 'ApexTrigger', metaTag: 'ApexTrigger' });
    destructive('ApexTrigger', 'SftkMxTrg');
    const back = M.sftkMdCodeFiles('ApexTrigger', 'SftkMxTrg', TRG_ONE, 61);
    expect(back.map(f => f.name)).toEqual(['package.xml', 'triggers/SftkMxTrg.trigger', 'triggers/SftkMxTrg.trigger-meta.xml']);
    expect(back[0].text).toContain('<members>SftkMxTrg</members>\n        <name>ApexTrigger</name>');
    expect(back[1].text).toBe(TRG_ONE);
    expect(back[2].text).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>61.0</apiVersion><status>Active</status></ApexTrigger>');
    expect(back[2].text).not.toContain('<label>');                        // a label on Apex is refused by Salesforce
    expect(cfgRow('ApexTrigger')).toEqual({ fixable: false, sev: 'blocker' });
  });
  it('✂ is not offered', () => { noRemove('ApexTrigger', TRG_ONE); noRemove('ApexTrigger', TRG_MANY); });
  it('one mention: ⇄ renames it', () => {
    expect(words(TRG_ONE, F)).toBe(1);
    const r = swap([{ path: 'triggers/SftkMxTrg.trigger', source: TRG_ONE }], 1, 1);
    expect(r.sources[0].source).toBe(TRG_ONE.replace('a.SFTK_Mx__c', 'a.SFTK_Mx2__c'));
  });
  it('several mentions (new value, old value, a text): all three in one pass', () => {
    expect(words(TRG_MANY, F)).toBe(3);
    expect(M.sftkMdCodeHits(TRG_MANY, F).map(h => h.line)).toEqual([4, 5]);
    const r = swap([{ path: 'triggers/SftkMxTrgMany.trigger', source: TRG_MANY }], 3, 1);
    expect(r.sources[0].source).toBe(TRG_MANY.split(F).join(NF));
  });
  // FIXED 2026-11-14 (it was): the -meta.xml of an Apex trigger is always written <status>Active</status> (sftkMdCodeFiles takes no
  // status; _codeRead in field-cleaner.js passes none). ⇄ / ✎ on an INACTIVE trigger — and the restore of a deleted
  // one — deploys it Active: a trigger that was switched off starts firing.
  it('an inactive trigger keeps <status>Inactive</status> through ⇄ / ✎ / restore', () => {
    const f = M.sftkMdCodeFiles('ApexTrigger', 'SftkMxTrg', TRG_ONE, 62, { status: 'Inactive' });
    expect(f[2].text).toContain('<status>Inactive</status>');
    expect(f[2].text).not.toContain('<status>Active</status>');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Visualforce page / component
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
const PAGE_ONE = `<apex:page standardController="Account">
    <apex:pageBlock title="Account">
        <apex:outputField value="{!Account.Name}"/>
        <apex:outputField value="{!Account.SFTK_Mx__c}"/>
    </apex:pageBlock>
</apex:page>`;
const PAGE_MANY = `<apex:page standardController="Account" extensions="SftkMxExt">
    <apex:form>
        <apex:inputField value="{!Account.SFTK_Mx__c}" rendered="{!NOT(ISBLANK(Account.SFTK_Mx__c))}"/>
        <apex:outputText value="{!IF(account.sftk_mx__c = 'Hot', 'H', 'C')}"/>
        <!-- SFTK_Mx__c is shown twice; SFTK_Mx__c_Old is not -->
    </apex:form>
</apex:page>`;
describe('ApexPage (Visualforce page)', () => {
  it('🗑 full delete: pages/Name.page, the manifest, the restore package with the page label', () => {
    expect(M.sftkMdDeleteSpec('ApexPage')).toEqual({ type: 'ApexPage', mdType: 'ApexPage', code: 'Markup', folder: 'pages', suffix: 'page', what: 'Visualforce page', tooling: 'ApexPage', metaTag: 'ApexPage' });
    destructive('ApexPage', 'SftkMxPage');
    const back = M.sftkMdCodeFiles('ApexPage', 'SftkMxPage', PAGE_ONE, 62, { label: 'SFTK Mx <Page> & more' });
    expect(back.map(f => f.name)).toEqual(['package.xml', 'pages/SftkMxPage.page', 'pages/SftkMxPage.page-meta.xml']);
    expect(back[1].text).toBe(PAGE_ONE);
    expect(back[2].text).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<ApexPage xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><label>SFTK Mx &lt;Page&gt; &amp; more</label></ApexPage>');
    expect(M.sftkMdWellFormed(back[2].text)).toBeNull();
    expect(cfgRow('ApexPage')).toEqual({ fixable: false, sev: 'blocker' });
  });
  it('✂ is not offered', () => { noRemove('ApexPage', PAGE_ONE); noRemove('ApexPage', PAGE_MANY); });
  it('one mention: ⇄ renames the binding, the markup stays well-formed', () => {
    expect(words(PAGE_ONE, F)).toBe(1);
    expect(M.sftkMdCodeHits(PAGE_ONE, F).map(h => h.line)).toEqual([4]);
    const r = swap([{ path: 'pages/SftkMxPage.page', source: PAGE_ONE }], 1, 1);
    expect(r.sources[0].source).toBe(PAGE_ONE.replace('{!Account.SFTK_Mx__c}', '{!Account.SFTK_Mx2__c}'));
    expect(M.sftkMdWellFormed(r.sources[0].source)).toBeNull();
  });
  it('several mentions (a value, a rendered formula, an IF in another case, a comment): all four in one pass', () => {
    expect(words(PAGE_MANY, F)).toBe(4);
    const r = swap([{ path: 'pages/SftkMxMany.page', source: PAGE_MANY }], 4, 1);
    const out = r.sources[0].source;
    expect(out).toContain('<apex:inputField value="{!Account.SFTK_Mx2__c}" rendered="{!NOT(ISBLANK(Account.SFTK_Mx2__c))}"/>');
    expect(out).toContain("{!IF(account.SFTK_Mx2__c = 'Hot', 'H', 'C')}");
    expect(out).toContain('<!-- SFTK_Mx2__c is shown twice; SFTK_Mx__c_Old is not -->');
    expect(M.sftkMdWellFormed(out)).toBeNull();
  });
  // FIXED 2026-11-14 (it was): the page's -meta.xml is rebuilt from the api version and the label alone. ⇄ / ✎ / the restore of a
  // deleted page deploy it without <availableInTouch>, <confirmationTokenRequired> and <description>: a page that was
  // "Available for Lightning Experience, Experience Builder sites, and the mobile app" comes back with the box unticked.
  it('a Visualforce page keeps availableInTouch / confirmationTokenRequired / description through ⇄ / ✎ / restore', () => {
    const f = M.sftkMdCodeFiles('ApexPage', 'SftkMxPage', PAGE_ONE, 62, { label: 'SFTK Mx', availableInTouch: true, confirmationTokenRequired: true, description: 'kept' });
    expect(f[2].text).toContain('<availableInTouch>true</availableInTouch>');
    expect(f[2].text).toContain('<confirmationTokenRequired>true</confirmationTokenRequired>');
    expect(f[2].text).toContain('<description>kept</description>');
  });
});

const CMP_ONE = `<apex:component>
    <apex:attribute name="acct" type="Account" description="the account"/>
    <b>{!acct.SFTK_Mx__c}</b>
</apex:component>`;
const CMP_MANY = `<apex:component controller="SftkMxCmpCtl">
    <apex:attribute name="acct" type="Account" description="shows SFTK_Mx__c"/>
    <apex:outputPanel rendered="{!acct.SFTK_Mx__c != null}">
        <apex:outputText value="{!acct.SFTK_Mx__c}"/>
    </apex:outputPanel>
</apex:component>`;
describe('ApexComponent (Visualforce component)', () => {
  it('🗑 full delete: components/Name.component, the manifest, the restore package', () => {
    expect(M.sftkMdDeleteSpec('ApexComponent')).toEqual({ type: 'ApexComponent', mdType: 'ApexComponent', code: 'Markup', folder: 'components', suffix: 'component', what: 'Visualforce component', tooling: 'ApexComponent', metaTag: 'ApexComponent' });
    destructive('ApexComponent', 'SftkMxCmp');
    const back = M.sftkMdCodeFiles('ApexComponent', 'SftkMxCmp', CMP_ONE, 62, { label: 'SFTK Mx Cmp' });
    expect(back.map(f => f.name)).toEqual(['package.xml', 'components/SftkMxCmp.component', 'components/SftkMxCmp.component-meta.xml']);
    expect(back[0].text).toContain('<members>SftkMxCmp</members>\n        <name>ApexComponent</name>');
    expect(back[1].text).toBe(CMP_ONE);
    expect(back[2].text).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<ApexComponent xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><label>SFTK Mx Cmp</label></ApexComponent>');
    expect(cfgRow('ApexComponent')).toEqual({ fixable: false, sev: 'blocker' });
  });
  it('✂ is not offered', () => { noRemove('ApexComponent', CMP_ONE); noRemove('ApexComponent', CMP_MANY); });
  it('one mention: ⇄ renames it', () => {
    expect(words(CMP_ONE, F)).toBe(1);
    const r = swap([{ path: 'components/SftkMxCmp.component', source: CMP_ONE }], 1, 1);
    expect(r.sources[0].source).toBe(CMP_ONE.replace('{!acct.SFTK_Mx__c}', '{!acct.SFTK_Mx2__c}'));
  });
  it('several mentions (a description, a rendered test, a value): all three in one pass', () => {
    expect(words(CMP_MANY, F)).toBe(3);
    const r = swap([{ path: 'components/SftkMxCmpMany.component', source: CMP_MANY }], 3, 1);
    expect(r.sources[0].source).toBe(CMP_MANY.split(F).join(NF));
    expect(M.sftkMdWellFormed(r.sources[0].source)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Lightning web component (js + html + css)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
const LWC_JS_ONE = `import { LightningElement, api, wire } from 'lwc';
import { getRecord, getFieldValue } from 'lightning/uiRecordApi';
import MX_FIELD from '@salesforce/schema/Account.SFTK_Mx__c';
import NAME_FIELD from '@salesforce/schema/Account.Name';

export default class SftkMx extends LightningElement {
    @api recordId;
    @wire(getRecord, { recordId: '$recordId', fields: [MX_FIELD, NAME_FIELD] }) account;
    get mx() { return getFieldValue(this.account.data, MX_FIELD); }
}`;
const LWC_HTML_NONE = `<template>
    <lightning-card title="Mx"><p class="slds-p-around_small">{mx}</p></lightning-card>
</template>`;
const LWC_CSS = '.mx { color: red; }';
const LWC_JS_MANY = `import { LightningElement, api, wire } from 'lwc';
import { getRecord } from 'lightning/uiRecordApi';
import MX_FIELD from '@salesforce/schema/Account.SFTK_Mx__c';
const FIELDS = ['Account.Name', 'Account.SFTK_Mx__c'];

export default class SftkMxMany extends LightningElement {
    @api recordId;
    @wire(getRecord, { recordId: '$recordId', fields: FIELDS }) account;
    get mx() { return this.account.data ? this.account.data.fields.SFTK_Mx__c.value : ''; }
    get one() { return MX_FIELD.fieldApiName; }
}`;
const LWC_HTML_MANY = `<template>
    <lightning-record-view-form record-id={recordId} object-api-name="Account">
        <lightning-output-field field-name="SFTK_Mx__c"></lightning-output-field>
        <lightning-output-field field-name="Name"></lightning-output-field>
    </lightning-record-view-form>
    <p>{account.data.fields.SFTK_Mx__c.value}</p>
</template>`;
describe('LightningComponentBundle (LWC)', () => {
  it('🗑 full delete: the manifest names the bundle; the restore package is every file under lwc/name/ plus the bundle meta', () => {
    expect(M.sftkMdDeleteSpec('LightningComponentBundle')).toEqual({ type: 'LightningComponentBundle', mdType: 'LightningComponentBundle', bundle: 'lwc', what: 'Lightning web component', tooling: 'LightningComponentBundle' });
    destructive('LightningComponentBundle', 'sftkMx');
    const res = [{ path: 'lwc/sftkMx/sftkMx.js', source: LWC_JS_ONE }, { path: 'lwc/sftkMx/sftkMx.html', source: LWC_HTML_NONE }, { path: 'lwc/sftkMx/sftkMx.css', source: LWC_CSS }, { path: 'lwc/sftkMx/utils/helper.js', source: 'export const x = 1;' }];
    const back = M.sftkMdBundleFiles('LightningComponentBundle', 'sftkMx', res, { apiVersion: 62, isExposed: true, masterLabel: 'SFTK Mx & co' });
    expect(back.map(f => f.name)).toEqual(['package.xml', 'lwc/sftkMx/sftkMx.js', 'lwc/sftkMx/sftkMx.html', 'lwc/sftkMx/sftkMx.css', 'lwc/sftkMx/utils/helper.js', 'lwc/sftkMx/sftkMx.js-meta.xml']);
    expect(back[0].text).toContain('<members>sftkMx</members>\n        <name>LightningComponentBundle</name>');
    expect(back[1].text).toBe(LWC_JS_ONE);
    expect(back[2].text).toBe(LWC_HTML_NONE);
    expect(back[3].text).toBe(LWC_CSS);
    expect(back[5].text).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><isExposed>true</isExposed><masterLabel>SFTK Mx &amp; co</masterLabel></LightningComponentBundle>');
    expect(M.sftkMdWellFormed(back[5].text)).toBeNull();
    expect(M.sftkMdPackageFiles('LightningComponentBundle', 'sftkMx', '')).toBeNull();
    expect(cfgRow('LightningComponentBundle')).toEqual({ fixable: false, sev: 'blocker' });
    // the whole-org sweep: a JS file of a bundle blocks (🔒), its HTML only mentions (👀); both join as the bundle
    const forms = S.sftkSweepForms(OBJ, F);
    expect(S.sftkSweepKind('unpackaged/lwc/sftkMx/sftkMx.js', LWC_JS_ONE, { offset: 0, text: '' }, forms)).toMatchObject({ type: 'LightningComponentBundle', sev: 'blocker', component: 'sftkMx', path: 'lwc/sftkMx/' });
    expect(S.sftkSweepKind('unpackaged/lwc/sftkMx/sftkMx.html', LWC_HTML_MANY, { offset: 0, text: '' }, forms)).toMatchObject({ type: 'LwcMarkup', sev: 'mention', component: 'sftkMx' });
    expect(S.sftkSweepJoinKind('LwcMarkup')).toBe('LightningComponentBundle');
    expect(S.sftkSweepIdQuery('LightningComponentBundle', 'sftkMx')).toBe("SELECT Id FROM LightningComponentBundle WHERE DeveloperName = 'sftkMx' AND NamespacePrefix = null");
  });
  it('✂ is not offered', () => { noRemove('LightningComponentBundle', LWC_JS_ONE); noRemove('LightningComponentBundle', LWC_JS_MANY); });
  it('one mention (the schema import): ⇄ renames it in the js; the html and the css come back byte for byte', () => {
    const src = [{ path: 'lwc/sftkMx/sftkMx.js', file: 'sftkMx.js', source: LWC_JS_ONE }, { path: 'lwc/sftkMx/sftkMx.html', file: 'sftkMx.html', source: LWC_HTML_NONE }, { path: 'lwc/sftkMx/sftkMx.css', file: 'sftkMx.css', source: LWC_CSS }];
    expect(src.reduce((n, s) => n + words(s.source, F), 0)).toBe(1);
    const r = swap(src, 1, 1);
    expect(r.sources[0].source).toBe(LWC_JS_ONE.replace('@salesforce/schema/Account.SFTK_Mx__c', '@salesforce/schema/Account.SFTK_Mx2__c'));
    expect(r.sources[1].source).toBe(LWC_HTML_NONE);
    expect(r.sources[2].source).toBe(LWC_CSS);
    expect(r.sources.map(s => s.n)).toEqual([1, 0, 0]);
    // the deploy: the whole bundle goes back, the unchanged files as they were
    const dep = M.sftkMdBundleFiles('LightningComponentBundle', 'sftkMx', r.sources.map(s => ({ path: s.path, source: s.source })), { apiVersion: '62.0', isExposed: false });
    expect(fileOf(dep, 'lwc/sftkMx/sftkMx.js')).toBe(r.sources[0].source);
    expect(fileOf(dep, 'lwc/sftkMx/sftkMx.html')).toBe(LWC_HTML_NONE);
    expect(fileOf(dep, 'lwc/sftkMx/sftkMx.js-meta.xml')).toContain('<isExposed>false</isExposed>');
  });
  it('several mentions over two files (the import, a field list, a data path; a field-name and a binding in the html): all five in one pass', () => {
    const src = [{ path: 'lwc/sftkMxMany/sftkMxMany.js', source: LWC_JS_MANY }, { path: 'lwc/sftkMxMany/sftkMxMany.html', source: LWC_HTML_MANY }, { path: 'lwc/sftkMxMany/sftkMxMany.css', source: LWC_CSS }];
    expect(words(LWC_JS_MANY, F)).toBe(3);
    expect(words(LWC_HTML_MANY, F)).toBe(2);
    const r = swap(src, 5, 2);
    expect(r.sources.map(s => s.n)).toEqual([3, 2, 0]);
    expect(r.sources[0].source).toBe(LWC_JS_MANY.split(F).join(NF));
    expect(r.sources[1].source).toBe(LWC_HTML_MANY.split(F).join(NF));
    expect(r.sources[1].source).toContain('<lightning-output-field field-name="SFTK_Mx2__c"></lightning-output-field>');
    expect(r.sources[2].source).toBe(LWC_CSS);
  });
  // FIXED 2026-11-14 (it was): the bundle's js-meta.xml is rebuilt from apiVersion, isExposed and masterLabel alone (sftkMdBundleFiles
  // knows no more; _codeRead reads the Tooling Metadata and passes only those plus description). ⇄ / ✎ / the restore of
  // a deleted component therefore deploy it WITHOUT <targets>, <targetConfigs> and <description>: a component exposed to
  // a record page loses where it may be placed (or Salesforce refuses the deploy because a page still uses it).
  it('an exposed LWC keeps its <targets> / <targetConfigs> / <description> through ⇄ / ✎ / restore', () => {
    const meta = { apiVersion: 62, isExposed: true, masterLabel: 'SFTK Mx', description: 'kept',
      targets: { target: ['lightning__RecordPage', 'lightning__AppPage'] },
      targetConfigs: '<targetConfig targets="lightning__RecordPage"><objects><object>Account</object></objects></targetConfig>' };
    const f = M.sftkMdBundleFiles('LightningComponentBundle', 'sftkMx', [{ path: 'lwc/sftkMx/sftkMx.js', source: LWC_JS_ONE }], meta);
    const m = fileOf(f, 'lwc/sftkMx/sftkMx.js-meta.xml');
    expect(m).toContain('<target>lightning__RecordPage</target>');
    expect(m).toContain('<target>lightning__AppPage</target>');
    expect(m).toContain('<description>kept</description>');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Aura bundle
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
const AURA_CMP_ONE = `<aura:component implements="force:hasRecordId">
    <aura:attribute name="account" type="Account"/>
    <span>{!v.account.SFTK_Mx__c}</span>
</aura:component>`;
const AURA_CTL_NONE = `({
    doInit : function(component, event, helper) { helper.load(component); }
})`;
const AURA_CMP_MANY = `<aura:component controller="SftkMxAuraCtl" implements="force:hasRecordId">
    <aura:attribute name="account" type="Account" default="{ 'sobjectType': 'Account', 'SFTK_Mx__c': '' }"/>
    <aura:if isTrue="{!v.account.SFTK_Mx__c == 'Hot'}">
        <lightning:input value="{!v.account.SFTK_Mx__c}" label="Mx"/>
    </aura:if>
</aura:component>`;
const AURA_CTL_MANY = `({
    save : function(component) {
        var a = component.get("v.account");
        if (!a.SFTK_Mx__c) { a.SFTK_Mx__c = 'New'; }
        component.set("v.account", a);
    }
})`;
const AURA_HLP_MANY = `({
    fields : function() { return ['Name', 'SFTK_Mx__c']; }
})`;
describe('AuraDefinitionBundle', () => {
  it('🗑 full delete: the manifest names the bundle; the restore package is every definition under aura/name/ plus the .cmp meta', () => {
    expect(M.sftkMdDeleteSpec('AuraDefinitionBundle')).toEqual({ type: 'AuraDefinitionBundle', mdType: 'AuraDefinitionBundle', bundle: 'aura', what: 'Aura component', tooling: 'AuraDefinitionBundle' });
    destructive('AuraDefinitionBundle', 'sftkMxAura');
    // the file of each definition, as field-cleaner.js names it from the Tooling DefType
    const defs = [['COMPONENT', AURA_CMP_ONE], ['CONTROLLER', AURA_CTL_NONE], ['HELPER', '({})'], ['STYLE', '.THIS {}'], ['DESIGN', '<design:component/>'], ['RENDERER', '({})'], ['DOCUMENTATION', '<aura:documentation/>'], ['SVG', '<svg/>']];
    const res = defs.map(([d, source]) => ({ path: AURA_FILE[d]('sftkMxAura'), source }));
    expect(res.map(r => r.path)).toEqual(['sftkMxAura.cmp', 'sftkMxAuraController.js', 'sftkMxAuraHelper.js', 'sftkMxAura.css', 'sftkMxAura.design', 'sftkMxAuraRenderer.js', 'sftkMxAura.auradoc', 'sftkMxAura.svg']);
    const back = M.sftkMdBundleFiles('AuraDefinitionBundle', 'sftkMxAura', res, { apiVersion: 62, description: 'SFTK <Mx>' });
    expect(back.map(f => f.name)).toEqual(['package.xml', ...res.map(r => `aura/sftkMxAura/${r.path}`), 'aura/sftkMxAura/sftkMxAura.cmp-meta.xml']);
    expect(back[0].text).toContain('<members>sftkMxAura</members>\n        <name>AuraDefinitionBundle</name>');
    expect(back[1].text).toBe(AURA_CMP_ONE);
    expect(back[back.length - 1].text).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<AuraDefinitionBundle xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><description>SFTK &lt;Mx&gt;</description></AuraDefinitionBundle>');
    expect(cfgRow('AuraDefinitionBundle')).toEqual({ fixable: false, sev: 'blocker' });
  });
  it('✂ is not offered', () => { noRemove('AuraDefinitionBundle', AURA_CMP_ONE); noRemove('AuraDefinitionBundle', AURA_CMP_MANY); });
  it('one mention (an expression in the markup): ⇄ renames it; the controller comes back byte for byte', () => {
    const src = [{ path: 'sftkMxAura.cmp', defType: 'COMPONENT', source: AURA_CMP_ONE }, { path: 'sftkMxAuraController.js', defType: 'CONTROLLER', source: AURA_CTL_NONE }];
    const r = swap(src, 1, 1);
    expect(r.sources[0].source).toBe(AURA_CMP_ONE.replace('{!v.account.SFTK_Mx__c}', '{!v.account.SFTK_Mx2__c}'));
    expect(r.sources[1].source).toBe(AURA_CTL_NONE);
    expect(r.sources[0].defType).toBe('COMPONENT');
    expect(M.sftkMdWellFormed(r.sources[0].source)).toBeNull();
  });
  it('several mentions over three files (a default, an if, a value; two in the controller; one in the helper): all six in one pass', () => {
    const src = [{ path: 'sftkMxAura.cmp', source: AURA_CMP_MANY }, { path: 'sftkMxAuraController.js', source: AURA_CTL_MANY }, { path: 'sftkMxAuraHelper.js', source: AURA_HLP_MANY }, { path: 'sftkMxAura.css', source: '.THIS { }' }];
    expect(src.map(s => words(s.source, F))).toEqual([3, 2, 1, 0]);
    const r = swap(src, 6, 3);
    expect(r.sources.map(s => s.n)).toEqual([3, 2, 1, 0]);
    expect(r.sources[0].source).toBe(AURA_CMP_MANY.split(F).join(NF));
    expect(r.sources[1].source).toContain("if (!a.SFTK_Mx2__c) { a.SFTK_Mx2__c = 'New'; }");
    expect(r.sources[2].source).toContain("['Name', 'SFTK_Mx2__c']");
    expect(r.sources[3].source).toBe('.THIS { }');
    const dep = M.sftkMdBundleFiles('AuraDefinitionBundle', 'sftkMxAura', r.sources.map(s => ({ path: s.path, source: s.source })), { apiVersion: 62 });
    expect(dep.map(f => f.name)).toEqual(['package.xml', 'aura/sftkMxAura/sftkMxAura.cmp', 'aura/sftkMxAura/sftkMxAuraController.js', 'aura/sftkMxAura/sftkMxAuraHelper.js', 'aura/sftkMxAura/sftkMxAura.css', 'aura/sftkMxAura/sftkMxAura.cmp-meta.xml']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Email templates — one EmailTemplate record for every kind; Subject / Body / HtmlValue / Markup are its texts
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
const tplChecks = (rec, r, n, fields) => {
  expect(r.n).toBe(n);
  expect(r.fields).toEqual(fields);
  expect(Object.keys(r.rec)).toEqual(fields);                             // only the changed texts are written
  const after = { ...rec, ...r.rec };
  for (const k of T.sftkTplTextFields()) if (!fields.includes(k)) expect(after[k]).toBe(rec[k]);
  for (const k of ['Id', 'Name', 'DeveloperName', 'TemplateType', 'UiType', 'RelatedEntityType']) expect(after[k]).toBe(rec[k]);
  return after;
};
const tplClean = after => {
  expect(T.sftkTplHits(after, F)).toEqual([]);
  expect(T.sftkTplNamesField(after, OBJ, F)).toBe(false);
  for (const k of T.sftkTplTextFields()) expect(words(after[k] || '', F)).toBe(0);
};

const TXT_ONE = { Id: '00X000000000001AAA', Name: 'Mx text one', DeveloperName: 'Mx_Text_One', TemplateType: 'text', UiType: 'Aloha', RelatedEntityType: null,
  Subject: 'Welcome {!Account.Name}', Body: 'Dear {!Contact.FirstName},\n\nYour tier is {!Account.SFTK_Mx__c}.\n\nThanks,\n{!User.Name}', HtmlValue: null, Markup: null };
const TXT_MANY = { Id: '00X000000000002AAA', Name: 'Mx text many', DeveloperName: 'Mx_Text_Many', TemplateType: 'text', UiType: 'Aloha', RelatedEntityType: null,
  Subject: 'Tier {!Account.SFTK_Mx__c} for {!Account.Name}',
  Body: 'Dear {!Contact.FirstName},\r\n\r\nYour tier is {!Account.SFTK_Mx__c} ({!NullValue(Account.SFTK_Mx__c, "none")}).\r\nOld tier: {!Account.sftk_mx__c}.\r\n{!Account.SFTK_Mx__c_Old}\r\n',
  HtmlValue: null, Markup: null };
describe('EmailTemplate — classic text', () => {
  it('🗑 is not offered: no delete spec, no package; the kind is ✂ / ⇄ / ✎ (fixable) and only mentions', () => {
    expect(M.sftkMdDeleteSpec('EmailTemplate')).toBeNull();
    expect(M.sftkMdPackageFiles('EmailTemplate', 'unfiled$public/Mx_Text_One', '')).toBeNull();
    expect(M.sftkMdCodeFiles('EmailTemplate', 'Mx_Text_One', '', 62)).toBeNull();
    expect(M.sftkMdEditWays('EmailTemplate')).toBeNull();                 // not the XML editor: its own path (REST), below
    expect(M.sftkMdCodeWays('EmailTemplate')).toBeNull();
    expect(cfgRow('EmailTemplate')).toEqual({ fixable: true, sev: 'silent' });
    expect(FC).toContain("if (type === 'EmailTemplate') label = (await fixEmailTemplate(componentId, componentName, swap)) || label;");
    expect(FC).toContain('const r = nf ? sftkTplReplace(rec, field, nf, famObj) : sftkTplRemove(rec, field, famObj);');   // 2026-11-15 round 2: the object is sftkMdFamObj(_selObj.api, field) — Task / Event custom field = Activity
    expect(FC).toContain('if (r.refused) {');
    expect(T.sftkTplKind(TXT_ONE)).toBe('classic text email template');
    // the whole-org sweep lists the file; it joins no list (the fix needs the record's id)
    expect(S.sftkSweepKind('unpackaged/email/unfiled$public/Mx_Text_One.email', TXT_ONE.Body, { offset: 0, text: '' }, S.sftkSweepForms(OBJ, F))).toMatchObject({ type: 'EmailTemplate', sev: 'mention', component: 'unfiled$public/Mx_Text_One' });
    expect(S.sftkSweepJoinKind('EmailTemplate')).toBeNull();
  });
  it('✂ one mention: the merge field goes out of the body, the words around it and the subject stay', () => {
    expect(T.sftkTplNamesField(TXT_ONE, OBJ, F)).toBe(true);
    expect(T.sftkTplHits(TXT_ONE, F)).toEqual([{ field: 'Body', line: 3, text: 'Your tier is {!Account.SFTK_Mx__c}.' }]);
    const after = tplChecks(TXT_ONE, T.sftkTplRemove(TXT_ONE, F), 1, ['Body']);
    expect(after.Body).toBe('Dear {!Contact.FirstName},\n\nYour tier is .\n\nThanks,\n{!User.Name}');
    expect(after.Subject).toBe('Welcome {!Account.Name}');
    tplClean(after);
  });
  it('✂ several mentions (the subject; three in the body, one inside a function, one in another case): all four in one pass', () => {
    expect(T.sftkTplHits(TXT_MANY, F).map(h => `${h.field}:${h.line}`)).toEqual(['Subject:1', 'Body:3', 'Body:4']);
    const after = tplChecks(TXT_MANY, T.sftkTplRemove(TXT_MANY, F), 4, ['Subject', 'Body']);
    expect(after.Subject).toBe('Tier  for {!Account.Name}');
    expect(after.Body).toBe('Dear {!Contact.FirstName},\r\n\r\nYour tier is  ().\r\nOld tier: .\r\n{!Account.SFTK_Mx__c_Old}\r\n');   // CRLF kept, the longer name kept
    tplClean(after);
  });
  it('⇄ several mentions: every one names the new field, the merge syntax as it was', () => {
    const after = tplChecks(TXT_MANY, T.sftkTplReplace(TXT_MANY, F, NF), 4, ['Subject', 'Body']);
    expect(after.Subject).toBe('Tier {!Account.SFTK_Mx2__c} for {!Account.Name}');
    expect(after.Body).toBe('Dear {!Contact.FirstName},\r\n\r\nYour tier is {!Account.SFTK_Mx2__c} ({!NullValue(Account.SFTK_Mx2__c, "none")}).\r\nOld tier: {!Account.SFTK_Mx2__c}.\r\n{!Account.SFTK_Mx__c_Old}\r\n');
    tplClean(after);
    expect(T.sftkTplNamesField(after, OBJ, NF)).toBe(true);
  });
  it('✂ is refused by its caller when the template names the field only as plain text (no merge field): n = 0, nothing changes', () => {
    const rec = { ...TXT_ONE, Body: 'Ask your admin about the field SFTK_Mx__c on Account.SFTK_Mx__c.' };
    const r = T.sftkTplRemove(rec, F);
    expect(r).toEqual({ rec: {}, n: 0, fields: [] });
    expect(FC).toContain('has no merge field that names ${field} in its subject, body, HTML or markup — the index lists it for a mention elsewhere. Open 🔍 to see the texts, or ⇄ Replace it.');
    expect(T.sftkTplReplace(rec, F, NF).n).toBe(2);                         // ⇄ does rename a plain mention
  });
  it('✂ with a merge field AND a plain mention: the merge field goes, the plain words are left and still read as a hit (by design)', () => {
    const rec = { ...TXT_ONE, Body: 'Tier {!Account.SFTK_Mx__c} (stored in SFTK_Mx__c).' };
    const after = tplChecks(rec, T.sftkTplRemove(rec, F), 1, ['Body']);
    expect(after.Body).toBe('Tier  (stored in SFTK_Mx__c).');
    expect(T.sftkTplHits(after, F).length).toBe(1);
  });
  it('no field, no new name, an empty record → nothing', () => {
    expect(T.sftkTplRemove(TXT_ONE, '')).toEqual({ rec: {}, n: 0, fields: [] });
    expect(T.sftkTplReplace(TXT_ONE, F, '')).toEqual({ rec: {}, n: 0, fields: [] });
    expect(T.sftkTplRemove(null, F)).toEqual({ rec: {}, n: 0, fields: [] });
  });
  // FIXED 2026-11-14 (it was): ✂ and ⇄ on a template work on the bare API name, so a merge field of ANOTHER object's field of the
  // same name ("{!Contact.SFTK_Mx__c}") is taken out / renamed too when Account.SFTK_Mx__c is the field being cleaned.
  // The scan's own test (sftkTplNamesField) does tie the name to the object; the fix does not.
  it('✂ / ⇄ leave "{!Contact.SFTK_Mx__c}" alone when the field is Account.SFTK_Mx__c (the object passed, as field-cleaner.js does)', () => {
    const rec = { ...TXT_ONE, Body: 'Account tier {!Account.SFTK_Mx__c}, contact tier {!Contact.SFTK_Mx__c}.' };
    expect(T.sftkTplRemove(rec, F, OBJ).rec.Body).toBe('Account tier , contact tier {!Contact.SFTK_Mx__c}.');
    expect(T.sftkTplReplace(rec, F, NF, OBJ).rec.Body).toBe('Account tier {!Account.SFTK_Mx2__c}, contact tier {!Contact.SFTK_Mx__c}.');
  });
});

const HTML_ONE = { Id: '00X000000000003AAA', Name: 'Mx html one', DeveloperName: 'Mx_Html_One', TemplateType: 'custom', UiType: 'Aloha', RelatedEntityType: null,
  Subject: 'Your account', Body: 'Hello {!Contact.FirstName}, see the HTML version.',
  HtmlValue: '<html>\n<head><style>p { color: #333; } .t { font-weight: bold; }</style></head>\n<body>\n<p>Hello {!Contact.FirstName},</p>\n<p class="t">Tier: {!Account.SFTK_Mx__c}</p>\n</body>\n</html>', Markup: null };
const HTML_MANY = { Id: '00X000000000004AAA', Name: 'Mx html many', DeveloperName: 'Mx_Html_Many', TemplateType: 'html', UiType: 'Aloha', RelatedEntityType: null,
  Subject: '{!Account.SFTK_Mx__c} account update',
  Body: 'Tier: {!Account.SFTK_Mx__c}\nName: {!Account.Name}',
  HtmlValue: '<table><tr><td>Tier</td><td>{!Account.SFTK_Mx__c}</td></tr>\n<tr><td>Name</td><td>{!Account.Name}</td></tr>\n<tr><td colspan="2"><a href="https://example.com/t?x={!URLENCODE(Account.SFTK_Mx__c)}">more</a></td></tr></table>', Markup: null };
describe('EmailTemplate — classic HTML (custom / with letterhead)', () => {
  it('🗑 is not offered; the kind reads as classic HTML', () => {
    expect(T.sftkTplKind(HTML_ONE)).toBe('classic HTML email template');
    expect(T.sftkTplKind(HTML_MANY)).toBe('classic HTML email template');
    expect(M.sftkMdDeleteSpec('EmailTemplate')).toBeNull();
  });
  it('✂ one mention (in the HTML): it goes, the tags and the CSS braces around it stay, still well-formed', () => {
    expect(T.sftkTplHits(HTML_ONE, F).map(h => `${h.field}:${h.line}`)).toEqual(['HtmlValue:5']);
    const after = tplChecks(HTML_ONE, T.sftkTplRemove(HTML_ONE, F), 1, ['HtmlValue']);
    expect(after.HtmlValue).toBe(HTML_ONE.HtmlValue.replace('{!Account.SFTK_Mx__c}', ''));
    expect(after.HtmlValue).toContain('<style>p { color: #333; } .t { font-weight: bold; }</style>');
    expect(after.HtmlValue).toContain('<p class="t">Tier: </p>');
    expect(M.sftkMdWellFormed(after.HtmlValue)).toBeNull();
    tplClean(after);
  });
  it('✂ several mentions (subject, text body, two in the HTML — one inside a link): all four in one pass', () => {
    const after = tplChecks(HTML_MANY, T.sftkTplRemove(HTML_MANY, F), 4, ['Subject', 'Body', 'HtmlValue']);
    expect(after.Subject).toBe(' account update');
    expect(after.Body).toBe('Tier: \nName: {!Account.Name}');
    expect(after.HtmlValue).toBe('<table><tr><td>Tier</td><td></td></tr>\n<tr><td>Name</td><td>{!Account.Name}</td></tr>\n<tr><td colspan="2"><a href="https://example.com/t?x=">more</a></td></tr></table>');
    expect(M.sftkMdWellFormed(after.HtmlValue)).toBeNull();
    tplClean(after);
  });
  it('⇄ several mentions: all four name the new field', () => {
    const after = tplChecks(HTML_MANY, T.sftkTplReplace(HTML_MANY, F, NF), 4, ['Subject', 'Body', 'HtmlValue']);
    expect(after.Subject).toBe('{!Account.SFTK_Mx2__c} account update');
    expect(after.Body).toBe(HTML_MANY.Body.split(F).join(NF));
    expect(after.HtmlValue).toBe(HTML_MANY.HtmlValue.split(F).join(NF));
    tplClean(after);
  });
});

const LEX_ONE = { Id: '00X000000000005AAA', Name: 'Mx lightning one', DeveloperName: 'Mx_Lex_One', TemplateType: 'custom', UiType: 'SFX', RelatedEntityType: 'Account',
  Subject: 'Hello {{{Recipient.FirstName}}}', Body: null,
  HtmlValue: '<html style="overflow-y: hidden;">\n<head><title></title></head>\n<body style="height: auto; min-height: auto;">Your tier: {{{Account.SFTK_Mx__c}}}<br />Owner: {{{Account.OwnerFullName}}}</body>\n</html>', Markup: null };
const LEX_MANY = { Id: '00X000000000006AAA', Name: 'Mx lightning many', DeveloperName: 'Mx_Lex_Many', TemplateType: 'custom', UiType: 'SFX', RelatedEntityType: 'Account',
  Subject: '{{{Account.SFTK_Mx__c}}} — {{{Account.Name}}}', Body: 'Tier {{{Account.SFTK_Mx__c}}}',
  HtmlValue: '<p>Tier: <b>{{{Account.SFTK_Mx__c}}}</b></p><p>Again: {{{Account.SFTK_Mx__c}}} / {{{Account.SFTK_Mx__c_Old}}}</p>', Markup: null };
describe('EmailTemplate — Lightning', () => {
  it('🗑 is not offered; the kind reads as Lightning; the scan ties the field to the template\'s related entity', () => {
    expect(T.sftkTplKind(LEX_ONE)).toBe('Lightning email template');
    expect(T.sftkTplNamesField(LEX_ONE, OBJ, F)).toBe(true);
    expect(T.sftkTplNamesField({ ...LEX_ONE, HtmlValue: '{{{Recipient.SFTK_Mx__c}}}', RelatedEntityType: 'Opportunity' }, OBJ, F)).toBe(false);   // a Contact's field of the same name
    expect(M.sftkMdDeleteSpec('EmailTemplate')).toBeNull();
  });
  it('✂ one mention: the triple-brace merge field goes whole (no stray brace), the others stay', () => {
    const after = tplChecks(LEX_ONE, T.sftkTplRemove(LEX_ONE, F), 1, ['HtmlValue']);
    expect(after.HtmlValue).toBe(LEX_ONE.HtmlValue.replace('{{{Account.SFTK_Mx__c}}}', ''));
    expect(after.HtmlValue).toContain('Your tier: <br />Owner: {{{Account.OwnerFullName}}}');
    expect((after.HtmlValue.match(/\{/g) || []).length).toBe((after.HtmlValue.match(/\}/g) || []).length);
    expect(after.Subject).toBe('Hello {{{Recipient.FirstName}}}');
    tplClean(after);
  });
  it('✂ several mentions (subject, text body, two in the HTML): all four in one pass, the longer name kept', () => {
    const after = tplChecks(LEX_MANY, T.sftkTplRemove(LEX_MANY, F), 4, ['Subject', 'Body', 'HtmlValue']);
    expect(after.Subject).toBe(' — {{{Account.Name}}}');
    expect(after.Body).toBe('Tier ');
    expect(after.HtmlValue).toBe('<p>Tier: <b></b></p><p>Again:  / {{{Account.SFTK_Mx__c_Old}}}</p>');
    tplClean(after);
  });
  it('⇄ several mentions: all four name the new field, the braces as they were', () => {
    const after = tplChecks(LEX_MANY, T.sftkTplReplace(LEX_MANY, F, NF), 4, ['Subject', 'Body', 'HtmlValue']);
    expect(after.Subject).toBe('{{{Account.SFTK_Mx2__c}}} — {{{Account.Name}}}');
    expect(after.HtmlValue).toBe('<p>Tier: <b>{{{Account.SFTK_Mx2__c}}}</b></p><p>Again: {{{Account.SFTK_Mx2__c}}} / {{{Account.SFTK_Mx__c_Old}}}</p>');
    tplClean(after);
  });
});

const VFT_ONE = { Id: '00X000000000007AAA', Name: 'Mx vf one', DeveloperName: 'Mx_Vf_One', TemplateType: 'visualforce', UiType: 'Aloha', RelatedEntityType: null,
  Subject: null, Body: null, HtmlValue: null,
  Markup: '<messaging:emailTemplate subject="Your account" recipientType="Contact" relatedToType="Account">\n<messaging:plainTextEmailBody >\nDear {!recipient.FirstName},\nTier: {!relatedTo.SFTK_Mx__c}\n</messaging:plainTextEmailBody>\n</messaging:emailTemplate>' };
const VFT_MANY = { Id: '00X000000000008AAA', Name: 'Mx vf many', DeveloperName: 'Mx_Vf_Many', TemplateType: 'visualforce', UiType: 'Aloha', RelatedEntityType: null,
  Subject: null, Body: null, HtmlValue: null,
  Markup: '<messaging:emailTemplate subject="Tier {!relatedTo.SFTK_Mx__c}" recipientType="Contact" relatedToType="Account">\n<messaging:htmlEmailBody >\n<p>Dear {!recipient.FirstName},</p>\n<p>Tier: {!relatedTo.SFTK_Mx__c}</p>\n<p>{!IF(ISBLANK(relatedTo.SFTK_Mx__c), "no tier", "tiered")}</p>\n</messaging:htmlEmailBody>\n</messaging:emailTemplate>' };
describe('EmailTemplate — Visualforce', () => {
  it('🗑 is not offered; the kind reads as Visualforce; relatedToType ties the field to the object', () => {
    expect(T.sftkTplKind(VFT_ONE)).toBe('Visualforce email template');
    expect(T.sftkTplNamesField(VFT_ONE, OBJ, F)).toBe(true);
    expect(T.sftkTplNamesField(VFT_ONE, 'Opportunity', F)).toBe(false);
    expect(M.sftkMdDeleteSpec('EmailTemplate')).toBeNull();
  });
  it('✂ one mention ({!relatedTo.X} in the text body): it goes from the Markup, the markup stays well-formed', () => {
    expect(T.sftkTplHits(VFT_ONE, F)).toEqual([{ field: 'Markup', line: 4, text: 'Tier: {!relatedTo.SFTK_Mx__c}' }]);
    const after = tplChecks(VFT_ONE, T.sftkTplRemove(VFT_ONE, F), 1, ['Markup']);
    expect(after.Markup).toBe(VFT_ONE.Markup.replace('{!relatedTo.SFTK_Mx__c}', ''));
    expect(after.Markup).toContain('Dear {!recipient.FirstName},\nTier: \n');
    expect(M.sftkMdWellFormed(after.Markup)).toBeNull();
    tplClean(after);
  });
  it('✂ several mentions (the subject attribute, a paragraph, an IF): all three in one pass', () => {
    const after = tplChecks(VFT_MANY, T.sftkTplRemove(VFT_MANY, F), 3, ['Markup']);
    expect(after.Markup).toBe('<messaging:emailTemplate subject="Tier " recipientType="Contact" relatedToType="Account">\n<messaging:htmlEmailBody >\n<p>Dear {!recipient.FirstName},</p>\n<p>Tier: </p>\n<p></p>\n</messaging:htmlEmailBody>\n</messaging:emailTemplate>');
    expect(M.sftkMdWellFormed(after.Markup)).toBeNull();
    tplClean(after);
  });
  it('⇄ several mentions: all three name the new field', () => {
    const after = tplChecks(VFT_MANY, T.sftkTplReplace(VFT_MANY, F, NF), 3, ['Markup']);
    expect(after.Markup).toBe(VFT_MANY.Markup.split(F).join(NF));
    expect(M.sftkMdWellFormed(after.Markup)).toBeNull();
    tplClean(after);
    expect(T.sftkTplNamesField(after, OBJ, NF)).toBe(true);
  });
  // FIXED 2026-11-14 (it was): in a Visualforce template a merge field is often the whole value of a component attribute that must
  // be a binding. ✂ takes the expression out and leaves value="" — Visualforce refuses to save an <apex:outputField>
  // (or <apex:repeat>) with an empty value, so the PATCH is refused and ✂ can never succeed on such a template; there
  // is no refusal with a reason up front, and no removal of the component that held the field.
  it('✂ on a Visualforce template never leaves <apex:outputField value=""/>: a bound outputField goes whole; a binding it cannot take out (<apex:repeat value=…>) is REFUSED with the reason', () => {
    const rec = { ...VFT_ONE, Markup: '<messaging:emailTemplate subject="x" recipientType="Contact" relatedToType="Account">\n<messaging:htmlEmailBody >\n<apex:outputField value="{!relatedTo.SFTK_Mx__c}"/>\n<apex:repeat value="{!relatedTo.SFTK_Mx__c}" var="v">{!v}</apex:repeat>\n</messaging:htmlEmailBody>\n</messaging:emailTemplate>' };
    const r = T.sftkTplRemove(rec, F);
    const out = r.n ? r.rec.Markup : rec.Markup;
    expect(out).not.toContain('<apex:outputField value=""/>');
    expect(out).not.toContain('<apex:repeat value=""');
    expect(r.refused).toMatch(/binds a component's attribute to SFTK_Mx__c/);
    expect(r.n).toBe(0);
    // the outputField alone: it goes whole, the markup stays well-formed
    const one = { ...VFT_ONE, Markup: rec.Markup.replace(/<apex:repeat[^]*?<\/apex:repeat>\n/, '') };
    const r1 = T.sftkTplRemove(one, F);
    expect(r1.refused).toBeUndefined();
    expect(r1.n).toBe(1);
    expect(r1.rec.Markup).toBe(one.Markup.replace('<apex:outputField value="{!relatedTo.SFTK_Mx__c}"/>', ''));
    expect(M.sftkMdWellFormed(r1.rec.Markup)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Entitlement process — 🗑 only (the shape of docs/fixtures/gap-kinds-fixture, as readMetadata returns it)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
const EP_ONE = '<fullName>sftk mx ep</fullName><SObjectType>Case</SObjectType><active>false</active><description>SFTK matrix. Safe to delete.</description><entryStartDateField>Case.CreatedDate</entryStartDateField>'
  + '<exitCriteriaFilterItems><field>Case.Status</field><operation>equals</operation><value>Closed</value></exitCriteriaFilterItems>'
  + '<milestones><milestoneCriteriaFilterItems><field>Case.SFTK_Mx__c</field><operation>equals</operation><value>Hot</value></milestoneCriteriaFilterItems><milestoneName>Close Case</milestoneName><minutesToComplete>60</minutesToComplete><useCriteriaStartTime>false</useCriteriaStartTime></milestones>'
  + '<name>sftk mx ep</name><versionMaster>552000000000001</versionMaster><versionNumber>1</versionNumber>';
const EP_MANY = '<fullName>sftk mx ep many</fullName><SObjectType>Case</SObjectType><active>true</active><entryStartDateField>Case.CreatedDate</entryStartDateField>'
  + '<exitCriteriaBooleanFilter>1 OR 2</exitCriteriaBooleanFilter>'
  + '<exitCriteriaFilterItems><field>Case.SFTK_Mx__c</field><operation>equals</operation><value>Done</value></exitCriteriaFilterItems>'
  + '<exitCriteriaFilterItems><field>Case.Status</field><operation>equals</operation><value>Closed</value></exitCriteriaFilterItems>'
  + '<milestones><milestoneCriteriaFilterItems><field>Case.SFTK_Mx__c</field><operation>equals</operation><value>Hot</value></milestoneCriteriaFilterItems><milestoneName>First Response</milestoneName><minutesToComplete>30</minutesToComplete><useCriteriaStartTime>false</useCriteriaStartTime></milestones>'
  + '<milestones><milestoneCriteriaFilterItems><field>Case.Priority</field><operation>equals</operation><value>High</value></milestoneCriteriaFilterItems><milestoneCriteriaFilterItems><field>Case.SFTK_Mx__c</field><operation>notEqual</operation><value>Cold</value></milestoneCriteriaFilterItems><milestoneName>Close Case</milestoneName><minutesToComplete>120</minutesToComplete><useCriteriaStartTime>true</useCriteriaStartTime></milestones>'
  + '<name>sftk mx ep many</name><versionNumber>1</versionNumber>';
describe('EntitlementProcess', () => {
  it('🗑 full delete: entitlementProcesses/<name>.entitlementProcess, the manifest, the restore package is the definition as read', () => {
    expect(M.sftkMdDeleteSpec('EntitlementProcess')).toEqual({ type: 'EntitlementProcess', mdType: 'EntitlementProcess', folder: 'entitlementProcesses', suffix: 'entitlementProcess', what: 'entitlement process' });
    destructive('EntitlementProcess', 'sftk mx ep');
    const back = M.sftkMdPackageFiles('EntitlementProcess', 'sftk mx ep', EP_ONE);
    expect(back.map(f => f.name)).toEqual(['package.xml', 'entitlementProcesses/sftk mx ep.entitlementProcess']);
    expect(back[0].text).toContain('<members>sftk mx ep</members>\n        <name>EntitlementProcess</name>');
    expect(back[1].text).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<EntitlementProcess xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">'
      + EP_ONE.replace('<fullName>sftk mx ep</fullName>', '') + '</EntitlementProcess>');
    expect(M.sftkMdWellFormed(back[1].text)).toBeNull();
    expect(words(back[1].text, F)).toBe(1);                               // the restore point still holds the field's criterion
    expect(cfgRow('EntitlementProcess')).toEqual({ fixable: false, sev: 'blocker' });
    expect(FC).toContain("add('EntitlementProcess', rec.fullName, (sftkMdChildText(rec.innerXml, 'name') || rec.fullName) + offTag(rec.innerXml));");
  });
  it('✂ / ⇄ are not offered — one mention: the scan sees it, the editor refuses, nothing changes', () => {
    expect(words(EP_ONE, F)).toBe(1);
    expect(M.sftkMdMentionsField(EP_ONE, 'Case', F)).toBe(true);
    expect(M.sftkMdEditWays('EntitlementProcess')).toBeNull();
    expect(M.sftkMdCodeWays('EntitlementProcess')).toBeNull();
    for (const nf of [null, NF]) {
      const r = M.sftkMdEditField('EntitlementProcess', EP_ONE, 'Case', F, nf);
      expect(r).toEqual({ xml: EP_ONE, changed: false, how: [], refused: 'this kind is not edited here — 🗑 delete it, or edit it in Setup' });
    }
  });
  it('✂ / ⇄ are not offered — several mentions (exit criteria + two milestones): refused as a whole, nothing half-done', () => {
    expect(words(EP_MANY, F)).toBe(3);
    expect(M.sftkMdMentionsField(EP_MANY, 'Case', F)).toBe(true);
    for (const nf of [null, NF]) {
      const r = M.sftkMdEditField('EntitlementProcess', EP_MANY, 'Case', F, nf);
      expect(r.refused).toBe('this kind is not edited here — 🗑 delete it, or edit it in Setup');
      expect(r.xml).toBe(EP_MANY);
      expect(r.changed).toBe(false);
    }
    const back = M.sftkMdPackageFiles('EntitlementProcess', 'sftk mx ep many', EP_MANY);
    expect(words(back[1].text, F)).toBe(3);
    expect(M.sftkMdWellFormed(back[1].text)).toBeNull();
  });
  it('a process on another field is not a mention', () => {
    expect(M.sftkMdMentionsField(EP_ONE.replace('Case.SFTK_Mx__c', 'Case.SFTK_Mx__c_Old'), 'Case', F)).toBe(false);
  });
  // FIXED 2026-11-14 (it was): a milestone's criteria can be a FORMULA (<milestoneCriteriaFormula>). The scan's mention test reads
  // <formula>, <errorConditionFormula>, <recordFilter> and <booleanFilter> only, so a process that names the field
  // only in a milestone formula is not listed — and the field's delete is then refused by Salesforce over a blocker
  // the scan never showed.
  it('a field named only in <milestoneCriteriaFormula> is a mention', () => {
    const xml = '<fullName>sftk mx ep f</fullName><SObjectType>Case</SObjectType><active>true</active><entryStartDateField>Case.CreatedDate</entryStartDateField>'
      + '<milestones><milestoneCriteriaFormula>ISPICKVAL(SFTK_Mx__c, &quot;Hot&quot;) &amp;&amp; NOT(IsClosed)</milestoneCriteriaFormula><milestoneName>Close Case</milestoneName><minutesToComplete>60</minutesToComplete><useCriteriaStartTime>false</useCriteriaStartTime></milestones>'
      + '<name>sftk mx ep f</name><versionNumber>1</versionNumber>';
    expect(words(xml, F)).toBe(1);
    expect(M.sftkMdMentionsField(xml, 'Case', F)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Service channel — 🗑 only; the field is its secondary routing priority, which readMetadata does not return
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
const SC_XML = '<fullName>SFTK_Mx_Channel</fullName><interactionComponent xsi:nil="true"/><label>SFTK Mx Channel</label><relatedEntityType>Case</relatedEntityType><secondaryRoutingPriorityFieldMappings/>';
describe('ServiceChannel', () => {
  it('🗑 full delete: serviceChannels/Name.serviceChannel, the manifest, the restore package', () => {
    expect(M.sftkMdDeleteSpec('ServiceChannel')).toEqual({ type: 'ServiceChannel', mdType: 'ServiceChannel', folder: 'serviceChannels', suffix: 'serviceChannel', what: 'service channel' });
    destructive('ServiceChannel', 'SFTK_Mx_Channel');
    const back = M.sftkMdPackageFiles('ServiceChannel', 'SFTK_Mx_Channel', SC_XML);
    expect(back.map(f => f.name)).toEqual(['package.xml', 'serviceChannels/SFTK_Mx_Channel.serviceChannel']);
    expect(back[0].text).toContain('<members>SFTK_Mx_Channel</members>\n        <name>ServiceChannel</name>');
    expect(back[1].text).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<ServiceChannel xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">'
      + SC_XML.replace('<fullName>SFTK_Mx_Channel</fullName>', '') + '</ServiceChannel>');
    expect(M.sftkMdWellFormed(back[1].text)).toBeNull();
    expect(cfgRow('ServiceChannel')).toEqual({ fixable: false, sev: 'blocker' });
    // the scan finds it by the field's ID on the record, and names it by its developer name — the delete's member
    expect(FC).toContain("if (String(c.SecRoutingPriorityField || '').slice(0, 15).toLowerCase() !== fid15) continue;");
    expect(FC).toContain("add('ServiceChannel', c.DeveloperName, c.MasterLabel || c.DeveloperName);");
  });
  it('✂ / ⇄ are not offered: no way in the editor, a refusal with the reason, the XML untouched', () => {
    expect(M.sftkMdEditWays('ServiceChannel')).toBeNull();
    expect(M.sftkMdCodeWays('ServiceChannel')).toBeNull();
    for (const nf of [null, NF]) expect(M.sftkMdEditField('ServiceChannel', SC_XML, 'Case', F, nf)).toEqual({ xml: SC_XML, changed: false, how: [], refused: 'this kind is not edited here — 🗑 delete it, or edit it in Setup' });
    expect(words(SC_XML, F)).toBe(0);                                     // its XML never names the field: one mention / several does not arise
    // the whole-org sweep does not retrieve the type at all
    expect(S.sftkSweepTypes([{ name: 'ServiceChannel', inFolder: false }, { name: 'ApexClass', inFolder: false }]).map(t => t.name)).toEqual(['ApexClass']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Custom-setting record — listed only (data, not metadata)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('CustomSettingRecord', () => {
  it('listed with ↗ Setup only: no 🗑, no ✂, no ⇄ — every engine says no', () => {
    expect(cfgRow('CustomSettingRecord')).toEqual({ fixable: false, sev: 'silent' });
    expect(M.sftkMdDeleteSpec('CustomSettingRecord')).toBeNull();
    expect(M.sftkMdEditWays('CustomSettingRecord')).toBeNull();
    expect(M.sftkMdCodeWays('CustomSettingRecord')).toBeNull();
    expect(M.sftkMdPackageFiles('CustomSettingRecord', 'SFTK_Mx_Set__c.Default', '<x/>')).toBeNull();
    expect(M.sftkMdCodeFiles('CustomSettingRecord', 'x', '', 62)).toBeNull();
    expect(M.sftkMdBundleFiles('CustomSettingRecord', 'x', [], {})).toBeNull();
    const r = M.sftkMdEditField('CustomSettingRecord', '<values><field>Field_Api__c</field><value xsi:type="xsd:string">Account.SFTK_Mx__c</value></values>', OBJ, F, null);
    expect(r.refused).toBe('this kind is not edited here — 🗑 delete it, or edit it in Setup');
    expect(r.changed).toBe(false);
    expect(FC).toContain("add('CustomSettingRecord', row.Id, `${st.Label || st.QualifiedApiName} · ${row.Name || row.Id} (${cols.join(', ')})`);");
    expect(FC).toContain("CustomSettingRecord: '/lightning/setup/CustomSettings/home',");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Profiles / permission sets (field permissions) and translations — listed by the whole-org sweep, nothing to do:
// Salesforce drops the line with the field
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
const PS_ONE = `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>SFTK matrix access. Safe to delete.</description>
    <fieldPermissions>
        <editable>true</editable>
        <field>Account.SFTK_Mx__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Account.SFTK_Mx__c_Old</field>
        <readable>true</readable>
    </fieldPermissions>
    <hasActivationRequired>false</hasActivationRequired>
    <label>SFTK Mx Access</label>
</PermissionSet>`;
const PROFILE_MANY = `<?xml version="1.0" encoding="UTF-8"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <custom>true</custom>
    <fieldPermissions>
        <editable>true</editable>
        <field>Account.SFTK_Mx__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Contact.SFTK_Mx__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <layoutAssignments>
        <layout>Account-Account Layout</layout>
    </layoutAssignments>
    <userLicense>Salesforce</userLicense>
</Profile>`;
const OT_ONE = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObjectTranslation xmlns="http://soap.sforce.com/2006/04/metadata">
    <fields>
        <label>Stufe</label>
        <name>SFTK_Mx__c</name>
    </fields>
    <fields>
        <label>Alt</label>
        <name>SFTK_Mx__c_Old</name>
    </fields>
</CustomObjectTranslation>`;
const OT_MANY = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObjectTranslation xmlns="http://soap.sforce.com/2006/04/metadata">
    <fields>
        <help>Siehe SFTK_Mx__c im Setup</help>
        <label>Stufe</label>
        <name>SFTK_Mx__c</name>
        <picklistValues>
            <masterLabel>Hot</masterLabel>
            <translation>Heiß</translation>
        </picklistValues>
    </fields>
    <validationRules>
        <errorMessage>SFTK_Mx__c ist Pflicht</errorMessage>
        <name>SFTK_Mx_Required</name>
    </validationRules>
</CustomObjectTranslation>`;
const TR_ONE = `<?xml version="1.0" encoding="UTF-8"?>
<Translations xmlns="http://soap.sforce.com/2006/04/metadata">
    <customLabels>
        <label>Bitte SFTK_Mx__c ausfüllen</label>
        <name>SFTK_Mx_Hint</name>
    </customLabels>
</Translations>`;
describe('Profiles and permission sets (field permissions)', () => {
  const forms = S.sftkSweepForms(OBJ, F);
  it('🗑 / ✂ / ⇄ are not offered: no engine knows the kind; the sweep says the line is dropped automatically', () => {
    for (const t of ['Profile', 'PermissionSet']) {
      expect(M.sftkMdDeleteSpec(t)).toBeNull();
      expect(M.sftkMdEditWays(t)).toBeNull();
      expect(M.sftkMdCodeWays(t)).toBeNull();
      expect(M.sftkMdPackageFiles(t, 'X', '')).toBeNull();
      expect(S.sftkSweepJoinKind(t)).toBeNull();                          // never joins the list of fixable places
      expect(S.sftkSweepKindTable()[t]).toMatchObject({ sev: 'mention', why: 'the field permission line is dropped automatically — nothing to do' });
      expect(cfgRow(t)).toBeNull();                                       // not a kind of the everyday list: the 👁 panel shows field access
      expect(M.sftkMdEditField(t, PS_ONE, OBJ, F, null).refused).toBe('this kind is not edited here — 🗑 delete it, or edit it in Setup');
    }
  });
  it('one mention (a permission set\'s fieldPermissions): one line listed, 👀, the longer name not counted', () => {
    const r = S.sftkSweepRun(new Map([['unpackaged/permissionsets/SFTK_Mx_Access.permissionset', PS_ONE], ['unpackaged/package.xml', '<Package>SFTK_Mx__c</Package>']]), forms);
    expect(Object.keys(r.byType)).toEqual(['PermissionSet']);
    expect(r.byType.PermissionSet).toMatchObject({ label: 'Permission Sets (field access)', sev: 'mention' });
    expect(r.byType.PermissionSet.items).toHaveLength(1);
    expect(r.byType.PermissionSet.items[0]).toMatchObject({ component: 'SFTK_Mx_Access', path: 'permissionsets/SFTK_Mx_Access.permissionset' });
    expect(r.byType.PermissionSet.items[0].lines).toEqual([{ line: 6, text: '<field>Account.SFTK_Mx__c</field>' }]);
    expect(r.filesWithHits).toBe(1);
    expect(M.sftkMdMentionsField(PS_ONE, OBJ, F)).toBe(true);
  });
  // QA 1.1 (finding 31): the second line is Contact.SFTK_Mx__c — Contact's own field of the same name, not
  // Account's. It was listed under Account's field as a second mention; now it is said as what it is.
  it('several mentions (a profile, two field permission lines): this object\'s line is the profile\'s item, Contact\'s line is Contact\'s own field', () => {
    const r = S.sftkSweepRun(new Map([['unpackaged/profiles/SFTK Mx Profile.profile', PROFILE_MANY]]), forms);
    expect(Object.keys(r.byType)).toEqual(['Profile', 'SameNameOtherObject']);
    expect(r.byType.Profile.items).toHaveLength(1);
    expect(r.byType.Profile.items[0].component).toBe('SFTK Mx Profile');
    expect(r.byType.Profile.items[0].lines.map(l => l.line)).toEqual([6]);
    expect(r.byType.SameNameOtherObject.items).toHaveLength(1);
    expect(r.byType.SameNameOtherObject.items[0]).toMatchObject({ component: 'SFTK Mx Profile', section: 'Contact’s own field of this name' });
    expect(r.byType.SameNameOtherObject.items[0].lines.map(l => l.line)).toEqual([11]);
    expect(r.hits.every(h => h.sev === 'mention')).toBe(true);
  });
  it('⇄ the access follows the field: whoever saw the old field gets the new one — created, raised, never lowered', () => {
    const P = (id, label, profile) => ({ Id: `0PS${id}`, Label: label, IsOwnedByProfile: !!profile, Profile: profile ? { Name: profile } : null });
    const oldRows = [
      { Id: '01k1', ParentId: '0PS1', PermissionsRead: true, PermissionsEdit: true, Parent: P(1, 'x', 'System Administrator') },
      { Id: '01k2', ParentId: '0PS2', PermissionsRead: true, PermissionsEdit: false, Parent: P(2, 'SFTK Mx Access') },
      { Id: '01k3', ParentId: '0PS3', PermissionsRead: true, PermissionsEdit: true, Parent: P(3, 'SFTK Mx Edit') },
      { Id: '01k4', ParentId: '0PS4', PermissionsRead: true, PermissionsEdit: false, Parent: P(4, 'SFTK Mx Same') },
      { Id: '01k5', ParentId: '0PS5', PermissionsRead: false, PermissionsEdit: false, Parent: P(5, 'No access') },
    ];
    const newRows = [
      { Id: '01n3', ParentId: '0PS3', PermissionsRead: true, PermissionsEdit: false },
      { Id: '01n4', ParentId: '0PS4', PermissionsRead: true, PermissionsEdit: true },
    ];
    const plan = R.sftkFlsCopyPlan(oldRows, newRows, OBJ, NF);
    expect(plan.create).toEqual([
      { who: 'System Administrator', kind: 'Profile', body: { ParentId: '0PS1', SobjectType: 'Account', Field: 'Account.SFTK_Mx2__c', PermissionsRead: true, PermissionsEdit: true } },
      { who: 'SFTK Mx Access', kind: 'Permission set', body: { ParentId: '0PS2', SobjectType: 'Account', Field: 'Account.SFTK_Mx2__c', PermissionsRead: true, PermissionsEdit: false } },
    ]);
    expect(plan.update).toEqual([{ who: 'SFTK Mx Edit', kind: 'Permission set', id: '01n3', parentId: '0PS3', before: { PermissionsRead: true, PermissionsEdit: false }, after: { PermissionsRead: true, PermissionsEdit: true } }]);
    expect(plan.same).toBe(1);
    // a formula as the new field: read access only
    const ro = R.sftkFlsCopyPlan(oldRows.slice(0, 1), [], OBJ, NF, { readOnly: true });
    expect(ro.create[0].body).toMatchObject({ PermissionsRead: true, PermissionsEdit: false });
  });
});

describe('Translations', () => {
  const forms = S.sftkSweepForms(OBJ, F);
  it('🗑 / ✂ / ⇄ are not offered: the translated labels go with the field', () => {
    for (const t of ['CustomObjectTranslation', 'Translations']) {
      expect(M.sftkMdDeleteSpec(t)).toBeNull();
      expect(M.sftkMdEditWays(t)).toBeNull();
      expect(M.sftkMdCodeWays(t)).toBeNull();
      expect(M.sftkMdPackageFiles(t, 'Account-de', '')).toBeNull();
      expect(S.sftkSweepJoinKind(t)).toBeNull();
      expect(S.sftkSweepKindTable()[t]).toMatchObject({ label: 'Translations', sev: 'mention' });
      expect(cfgRow(t)).toBeNull();
      expect(M.sftkMdEditField(t, OT_ONE, OBJ, F, null).refused).toBe('this kind is not edited here — 🗑 delete it, or edit it in Setup');
    }
  });
  it('one mention (the field\'s translated label): one line listed, 👀', () => {
    const r = S.sftkSweepRun(new Map([['unpackaged/objectTranslations/Account-de.objectTranslation', OT_ONE]]), forms);
    expect(Object.keys(r.byType)).toEqual(['CustomObjectTranslation']);
    expect(r.byType.CustomObjectTranslation).toMatchObject({ label: 'Translations', sev: 'mention', why: 'the field’s translated labels go with it' });
    expect(r.byType.CustomObjectTranslation.items).toHaveLength(1);
    expect(r.byType.CustomObjectTranslation.items[0]).toMatchObject({ component: 'Account-de', path: 'objectTranslations/Account-de.objectTranslation' });
    expect(r.byType.CustomObjectTranslation.items[0].lines).toEqual([{ line: 5, text: '<name>SFTK_Mx__c</name>' }]);
  });
  it('several mentions (help text, the name, a validation message; a custom label in the language file): every line, grouped by file', () => {
    const r = S.sftkSweepRun(new Map([['unpackaged/objectTranslations/Account-de.objectTranslation', OT_MANY], ['unpackaged/translations/de.translation', TR_ONE]]), forms);
    expect(Object.keys(r.byType).sort()).toEqual(['CustomObjectTranslation', 'Translations']);
    expect(r.byType.CustomObjectTranslation.items).toHaveLength(1);
    expect(r.byType.CustomObjectTranslation.items[0].lines.map(l => l.line)).toEqual([4, 6, 13]);   // "SFTK_Mx_Required" is another name
    expect(r.byType.Translations.items[0]).toMatchObject({ component: 'de' });
    expect(r.byType.Translations.items[0].lines).toEqual([{ line: 4, text: '<label>Bitte SFTK_Mx__c ausfüllen</label>' }]);
    expect(r.filesRead).toBe(2);
    expect(r.filesWithHits).toBe(2);
    expect(r.hits).toHaveLength(4);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The buttons a row of each kind gets — what "offered" means above, pinned to the source that draws them
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('what each kind is offered', () => {
  it('code: ⇄ Replace (when a replacement is picked) and 🗑 Delete; ✎ in 🔍; never ✂', () => {
    expect(FC).toContain("const codeWays = (knownKind && typeof sftkMdCodeWays === 'function') ? sftkMdCodeWays(type) : null;");
    expect(FC).toContain('if (!cfgT.fixable) return codeEdits + edits + del;');
    expect(FC).toContain("if (typeof sftkMdCodeWays === 'function' && sftkMdCodeWays(type)) return '⇄ replace · ✎ edit code · 🗑 delete';");
    expect(FC).toContain('const r = sftkMdCodeReplace(code.sources, field, nf);');
    expect(FC).toContain("const zipDel = plan.deployFiles ? _zipOf(plan.deployFiles) : (plan.patch || plan.pb) ? null : _zipOf(sftkMdDestructiveFiles([[spec.mdType, fullName]]));");
  });
  it('the table of ways agrees with the matrix above', () => {
    const offered = t => ({ del: !!M.sftkMdDeleteSpec(t), xml: M.sftkMdEditWays(t), code: M.sftkMdCodeWays(t) });
    for (const t of ['ApexClass', 'ApexTrigger', 'ApexPage', 'ApexComponent', 'LightningComponentBundle', 'AuraDefinitionBundle']) expect(offered(t)).toEqual({ del: true, xml: null, code: { replace: true, edit: true, remove: false } });
    for (const t of ['EntitlementProcess', 'ServiceChannel']) expect(offered(t)).toEqual({ del: true, xml: null, code: null });
    for (const t of ['EmailTemplate', 'CustomSettingRecord', 'Profile', 'PermissionSet', 'CustomObjectTranslation', 'Translations']) expect(offered(t)).toEqual({ del: false, xml: null, code: null });
  });
});
