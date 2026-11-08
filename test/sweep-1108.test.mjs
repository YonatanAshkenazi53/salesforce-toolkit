// 🧭 THE WHOLE-ORG TEXT SWEEP (user 2026-11-08: "מורידים דרך vcs פרויקט שלם של
// סילספורס ואז מחפשים שם api של שדה… לחלק את זה לדברים שחייב למחוק או לשנות
// כדי למחוק את השדה, ודברים שטוב לדעת כי הם יכולים להשבר אחר כך").
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const S = extractFunctions('sftk-sweep.js', [
  'sftkSweepForms', 'sftkSweepHits', 'sftkSweepParseDescribe', 'sftkSweepParseList', 'sftkSweepTypes', 'sftkSweepOwn',
  'sftkSweepChunks', 'sftkSweepIsText', 'sftkSweepSections', '_sftkSweepSectionAt', 'sftkSweepKind', 'sftkSweepRun',
  'sftkSweepCompare', 'sftkSweepEta', 'sftkSweepFmtMs',
  '_sftkSweepSkip', '_sftkSweepFolderKinds', '_sftkSweepBinary', 'sftkSweepKindTable',
]);

const F = S.sftkSweepForms('Account', 'SFTK_Live_Blk__c');

describe('what it looks for', () => {
  it('the bare name as a word, in any form the metadata uses', () => {
    for (const s of ['SFTK_Live_Blk__c', 'Account.SFTK_Live_Blk__c', '$Record.SFTK_Live_Blk__c', '@salesforce/schema/Account.SFTK_Live_Blk__c', 'sftk_live_blk__c = true', '<field>SFTK_Live_Blk__c</field>'])
      expect(F.re.test(s), s).toBe(true);
    for (const s of ['SFTK_Live_Blk__c2', 'XSFTK_Live_Blk__c', 'SFTK_Live_Blk__r', 'SFTK_Live_Blk']) expect(F.re.test(s), s).toBe(false);
    expect(F.qualified.test('Account.SFTK_Live_Blk__c')).toBe(true);
    expect(F.qualified.test('Lead.SFTK_Live_Blk__c')).toBe(false);
  });
  it('every line that names it, with its number', () => {
    const hits = S.sftkSweepHits('a\nb SFTK_Live_Blk__c\nc\n  <field>Account.SFTK_Live_Blk__c</field>\n', F);
    expect(hits.map(h => h.line)).toEqual([2, 4]);
    expect(hits[1].text).toBe('<field>Account.SFTK_Live_Blk__c</field>');
    expect(S.sftkSweepHits('nothing here', F)).toEqual([]);
  });
});

describe('the plan', () => {
  const DESCRIBE = `<result><metadataObjects><directoryName>classes</directoryName><inFolder>false</inFolder><xmlName>ApexClass</xmlName></metadataObjects>
    <metadataObjects><directoryName>reports</directoryName><inFolder>true</inFolder><xmlName>Report</xmlName></metadataObjects>
    <metadataObjects><directoryName>staticresources</directoryName><inFolder>false</inFolder><xmlName>StaticResource</xmlName></metadataObjects>
    <metadataObjects><directoryName>documents</directoryName><inFolder>true</inFolder><xmlName>Document</xmlName></metadataObjects>
    <metadataObjects><directoryName>objects</directoryName><inFolder>false</inFolder><xmlName>CustomObject</xmlName></metadataObjects></result>`;
  it('reads describeMetadata and keeps the text kinds: wildcard, folders, no documents or static resources', () => {
    const d = S.sftkSweepParseDescribe(DESCRIBE);
    expect(d.map(x => x.name)).toEqual(['ApexClass', 'Report', 'StaticResource', 'Document', 'CustomObject']);
    const t = S.sftkSweepTypes(d);
    expect(t).toEqual([{ name: 'ApexClass', how: 'wildcard' }, { name: 'CustomObject', how: 'wildcard' }, { name: 'Report', how: 'folders', folderType: 'ReportFolder' }]);
  });
  it('reads listMetadata and tells the org’s own components from installed ones', () => {
    const l = S.sftkSweepParseList('<result><fullName>Foo</fullName><type>ApexClass</type><manageableState>unmanaged</manageableState></result><result><fullName>npsp__Bar</fullName><type>ApexClass</type><manageableState>installed</manageableState><namespacePrefix>npsp</namespacePrefix></result>');
    expect(l.map(x => x.fullName)).toEqual(['Foo', 'npsp__Bar']);
    expect(S.sftkSweepOwn(l[0])).toBe(true);
    expect(S.sftkSweepOwn(l[1])).toBe(false);
  });
  it('chunks the retrieves by member count, a big type split on its own', () => {
    const many = Array.from({ length: 120 }, (_, i) => `C${i}`);
    const g = S.sftkSweepChunks({ ApexClass: many, Layout: ['L1', 'L2'], Flow: [] }, 50);
    expect(g.length).toBe(3);
    expect(g[0]).toEqual([{ name: 'ApexClass', members: many.slice(0, 50) }]);
    expect(g[2].map(t => t.name)).toEqual(['ApexClass', 'Layout']);
    expect(g[2][0].members.length).toBe(20);
  });
  it('skips binaries by extension', () => {
    expect(S.sftkSweepIsText('classes/A.cls')).toBe(true);
    expect(S.sftkSweepIsText('staticresources/x.resource')).toBe(false);
    expect(S.sftkSweepIsText('lwc/a/a.png')).toBe(false);
  });
});

const OBJECT = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <fields>
        <fullName>SFTK_Live_Blk__c</fullName>
        <type>Text</type>
    </fields>
    <fields>
        <fullName>SFTK_Live_Formula__c</fullName>
        <formula>SFTK_Live_Blk__c &amp; "x"</formula>
    </fields>
    <fields>
        <fullName>SFTK_Live_Lk__c</fullName>
        <lookupFilter><filterItems><field>Contact.SFTK_Live_Blk__c</field></filterItems></lookupFilter>
    </fields>
    <listViews>
        <fullName>SFTK_Live_LV</fullName>
        <columns>SFTK_Live_Blk__c</columns>
    </listViews>
    <recordTypes>
        <fullName>RT_A</fullName>
        <picklistValues><picklist>SFTK_Live_Blk__c</picklist></picklistValues>
    </recordTypes>
    <searchLayouts>
        <searchResultsAdditionalFields>SFTK_Live_Blk__c</searchResultsAdditionalFields>
    </searchLayouts>
    <validationRules>
        <fullName>SFTK_Live_VR</fullName>
        <errorConditionFormula>ISBLANK(SFTK_Live_Blk__c)</errorConditionFormula>
    </validationRules>
    <webLinks>
        <fullName>SFTK_Live_Btn</fullName>
        <url>/x?f={!Account.SFTK_Live_Blk__c}</url>
    </webLinks>
</CustomObject>`;

describe('the sections of an object-shaped file', () => {
  it('splits the depth-1 children and names each by its fullName', () => {
    const secs = S.sftkSweepSections(OBJECT);
    expect(secs.map(s => `${s.tag}:${s.fullName}`)).toEqual([
      'fields:SFTK_Live_Blk__c', 'fields:SFTK_Live_Formula__c', 'fields:SFTK_Live_Lk__c', 'listViews:SFTK_Live_LV',
      'recordTypes:RT_A', 'searchLayouts:null', 'validationRules:SFTK_Live_VR', 'webLinks:SFTK_Live_Btn']);
    const off = OBJECT.indexOf('<columns>');
    expect(S._sftkSweepSectionAt(secs, off).fullName).toBe('SFTK_Live_LV');
  });
});

describe('what a hit means — 🔒 refuses the delete, 👀 breaks later', () => {
  const kindAt = (path, text, needle) => S.sftkSweepKind(path, text, { offset: text.indexOf(needle), text: needle, line: 1 }, F);
  it('the object file: the field’s own definition is no hit; formula, lookup filter, validation rule and button block; list view, record type and search layout do not', () => {
    expect(kindAt('unpackaged/objects/Account.object', OBJECT, '<type>Text</type>')).toBe(null);
    expect(kindAt('objects/Account.object', OBJECT, '&amp; "x"')).toMatchObject({ type: 'CustomField', sev: 'blocker', component: 'Account.SFTK_Live_Formula__c' });
    expect(kindAt('objects/Account.object', OBJECT, 'Contact.SFTK_Live_Blk__c')).toMatchObject({ type: 'LookupFilter', sev: 'blocker', component: 'Account.SFTK_Live_Lk__c' });
    expect(kindAt('objects/Account.object', OBJECT, '<columns>')).toMatchObject({ type: 'ListView', sev: 'mention', component: 'Account.SFTK_Live_LV' });
    expect(kindAt('objects/Account.object', OBJECT, '<picklist>')).toMatchObject({ type: 'RecordTypePicklist', sev: 'mention', component: 'Account.RT_A' });
    expect(kindAt('objects/Account.object', OBJECT, 'searchResultsAdditionalFields')).toMatchObject({ type: 'SearchLayout', sev: 'mention' });
    expect(kindAt('objects/Account.object', OBJECT, 'ISBLANK')).toMatchObject({ type: 'ValidationRule', sev: 'blocker', component: 'Account.SFTK_Live_VR' });
    expect(kindAt('objects/Account.object', OBJECT, '<url>')).toMatchObject({ type: 'WebLink', sev: 'blocker', component: 'Account.SFTK_Live_Btn' });
  });
  it('code, pages, flows, Lightning pages block; LWC blocks only through its JS import, Aura never', () => {
    expect(kindAt('classes/Foo.cls', 'x', 'x')).toMatchObject({ type: 'ApexClass', sev: 'blocker', component: 'Foo' });
    expect(kindAt('triggers/T.trigger', 'x', 'x').sev).toBe('blocker');
    expect(kindAt('pages/P.page', 'x', 'x').type).toBe('ApexPage');
    expect(kindAt('flows/F.flow', 'x', 'x')).toMatchObject({ type: 'Flow', sev: 'blocker' });
    expect(kindAt('flexipages/FP.flexipage', 'x', 'x').sev).toBe('blocker');
    expect(kindAt('lwc/sftkLive/sftkLive.js', 'x', 'x')).toMatchObject({ type: 'LightningComponentBundle', sev: 'blocker', component: 'sftkLive', path: 'lwc/sftkLive/', file: 'sftkLive.js' });
    expect(kindAt('lwc/sftkLive/sftkLive.html', 'x', 'x')).toMatchObject({ type: 'LwcMarkup', sev: 'mention', component: 'sftkLive' });
    expect(kindAt('aura/sftkAura/sftkAura.cmp', 'x', 'x')).toMatchObject({ type: 'AuraDefinitionBundle', sev: 'mention', path: 'aura/sftkAura/', file: 'sftkAura.cmp' });
    // a bundle's files merge into ONE item, each line named by its file
    const r = S.sftkSweepRun(new Map([['unpackaged/aura/sftkAura/sftkAura.cmp', 'SFTK_Live_Blk__c'], ['unpackaged/aura/sftkAura/sftkAuraController.js', 'x SFTK_Live_Blk__c']]), F);
    expect(r.byType.AuraDefinitionBundle.items.length).toBe(1);
    expect(r.byType.AuraDefinitionBundle.items[0].lines.map(l => l.file)).toEqual(['sftkAura.cmp', 'sftkAuraController.js']);
  });
  it('a layout mention, and a related-list column on another object’s layout', () => {
    const LAYOUT = '<Layout xmlns="x"><layoutSections><layoutColumns><layoutItems><field>SFTK_Live_Blk__c</field></layoutItems></layoutColumns></layoutSections><relatedLists><fields>SFTK_Live_Blk__c</fields><relatedList>RelatedAccountList</relatedList></relatedLists></Layout>';
    expect(kindAt('layouts/Account-SFTK Live Layout.layout', LAYOUT, '<field>')).toMatchObject({ type: 'Layout', sev: 'mention', component: 'SFTK Live Layout' });
    expect(kindAt('layouts/Contact-Contact Layout.layout', LAYOUT, '<fields>')).toMatchObject({ type: 'LayoutRelatedList', sev: 'mention', component: 'Contact Layout' });
  });
  it('workflow sections, rules and settings by their containers', () => {
    const WF = '<Workflow><alerts><fullName>A1</fullName><x>SFTK_Live_Blk__c</x></alerts><fieldUpdates><fullName>FU</fullName><field>SFTK_Live_Blk__c</field></fieldUpdates><rules><fullName>R1</fullName><criteriaItems><field>Account.SFTK_Live_Blk__c</field></criteriaItems></rules></Workflow>';
    expect(kindAt('workflows/Account.workflow', WF, '<x>')).toMatchObject({ type: 'WorkflowAlert', component: 'Account.A1' });
    expect(kindAt('workflows/Account.workflow', WF, '<field>SFTK')).toMatchObject({ type: 'WorkflowFieldUpdate', component: 'Account.FU' });
    expect(kindAt('workflows/Account.workflow', WF, 'criteriaItems')).toMatchObject({ type: 'WorkflowRule', component: 'Account.R1' });
    expect(kindAt('assignmentRules/Lead.assignmentRules', '<A><assignmentRule><fullName>AR</fullName><f>SFTK_Live_Blk__c</f></assignmentRule></A>', '<f>')).toMatchObject({ type: 'AssignmentRule', component: 'Lead.AR' });
    expect(kindAt('settings/LeadConvert.settings', 'x', 'x')).toMatchObject({ type: 'LeadConvertSettings', sev: 'blocker' });
  });
  it('a custom metadata record: "Object.Field" blocks, so does a bare name beside a value naming the object (an Entity + Field pair); a lone text value does not', () => {
    expect(kindAt('customMetadata/SFTK_Live_Cmt.Ref.md', 'x', '<value xsi:type="xsd:string">Account.SFTK_Live_Blk__c</value>')).toMatchObject({ type: 'CustomMetadataRecord', sev: 'blocker' });
    const PAIR = '<CustomMetadata><values><field>Entity__c</field><value xsi:type="xsd:string">Account</value></values><values><field>Field__c</field><value xsi:type="xsd:string">SFTK_Live_Blk__c</value></values></CustomMetadata>';
    expect(S.sftkSweepKind('customMetadata/SFTK_Live_Cmt.Ref.md', PAIR, { offset: PAIR.indexOf('SFTK_Live_Blk__c'), text: '<value xsi:type="xsd:string">SFTK_Live_Blk__c</value>', line: 1 }, F)).toMatchObject({ type: 'CustomMetadataRecord', sev: 'blocker' });
    expect(kindAt('customMetadata/SFTK_Live_Cmt.Txt.md', 'x', '<value xsi:type="xsd:string">SFTK_Live_Blk__c</value>')).toMatchObject({ type: 'CustomMetadataText', sev: 'mention' });
    expect(kindAt('LeadConvertSettings/LeadConvertSettings.leadConvertSettings', 'x', 'x')).toMatchObject({ type: 'LeadConvertSettings', sev: 'blocker' });
  });

  it('a field of the SAME NAME on another object is not a use of ours — unless its formula or filter names it', () => {
    const LEAD = '<CustomObject><fields><fullName>SFTK_Live_Blk__c</fullName><type>Text</type></fields><fields><fullName>Other__c</fullName><formula>SFTK_Live_Blk__c</formula></fields></CustomObject>';
    expect(S.sftkSweepKind('objects/Lead.object', LEAD, { offset: LEAD.indexOf('<fullName>SFTK'), text: '<fullName>SFTK_Live_Blk__c</fullName>', line: 1 }, F)).toBe(null);
    expect(S.sftkSweepKind('objects/Lead.object', LEAD, { offset: LEAD.indexOf('<formula>'), text: '<formula>SFTK_Live_Blk__c</formula>', line: 1 }, F)).toMatchObject({ type: 'CustomField', component: 'Lead.Other__c' });
  });
  it('reports, templates, permission sets, translations, experiences and the unknown are 👀 with a reason', () => {
    expect(kindAt('reports/SFTK/My_Report.report', 'x', 'x')).toMatchObject({ type: 'Report', sev: 'mention', component: 'SFTK/My_Report' });
    expect(kindAt('email/SFTK/Tpl.email', 'x', 'x')).toMatchObject({ type: 'EmailTemplate', component: 'SFTK/Tpl' });
    expect(kindAt('permissionsets/PS.permissionset', 'x', 'x')).toMatchObject({ type: 'PermissionSet', sev: 'mention' });
    expect(kindAt('objectTranslations/Account-he.objectTranslation', 'x', 'x').type).toBe('CustomObjectTranslation');
    expect(kindAt('experiences/Site1/views/home.json', 'x', 'x')).toMatchObject({ type: 'ExperienceBundle', component: 'Site1' });
    const o = kindAt('weird/Thing.thing', 'x', 'x');
    expect(o.type).toBe('Other'); expect(o.sev).toBe('mention'); expect(o.why.length).toBeGreaterThan(10);
  });
});

describe('the run, grouped, compared with the scan, timed', () => {
  it('groups hits by kind and component, with every line kept', () => {
    const files = new Map([
      ['unpackaged/package.xml', '<types><members>SFTK_Live_Blk__c</members></types>'],
      ['unpackaged/objects/Account.object', OBJECT],
      ['unpackaged/classes/Foo.cls', 'public class Foo { String f = Account.SFTK_Live_Blk__c; String g = \'SFTK_Live_Blk__c\'; }'],
      ['unpackaged/classes/Bar.cls', 'public class Bar {}'],
    ]);
    const r = S.sftkSweepRun(files, F);
    expect(r.filesRead).toBe(4);
    expect(r.filesWithHits).toBe(2);
    expect(Object.keys(r.byType).sort()).toEqual(['ApexClass', 'CustomField', 'ListView', 'LookupFilter', 'RecordTypePicklist', 'SearchLayout', 'ValidationRule', 'WebLink']);
    expect(r.byType.ApexClass.items[0].lines.length).toBe(1);   // one line, two mentions
    const cmp = S.sftkSweepCompare(r.byType, [{ type: 'ApexClass', name: 'foo' }, { type: 'ValidationRuleInactive', name: 'SFTK Live VR' }, { type: 'WebLink', name: 'SFTK_Live_Btn (url)' }]);
    expect(cmp.known).toBe(3);   // case, spaces, the inactive alias and a scan suffix do not keep a match apart
    expect(r.byType.WebLink.items[0].inScan).toBe(true);
    expect(r.byType.ValidationRule.items[0].inScan).toBe(true);
    expect(r.byType.ListView.items[0].inScan).toBe(false);
  });
  it('the time left is a plain rate; formatted for a human', () => {
    expect(S.sftkSweepEta(1000, 0, 10, 5000)).toBe(null);
    expect(S.sftkSweepEta(1000, 2, 10, 5000)).toBe(16000);
    expect(S.sftkSweepFmtMs(16000)).toBe('16s');
    expect(S.sftkSweepFmtMs(125000)).toBe('2m 05s');
    expect(S.sftkSweepFmtMs(null)).toBe('…');
  });
});

describe('the zip', () => {
  it('inflates a deflate zip and keeps the text files only', async () => {
    const { sftkUnzip } = await import('./_sweep-unzip-helper.mjs');
    const enc = new TextEncoder();
    const entries = [
      { name: 'unpackaged/classes/Foo.cls', data: enc.encode('class Foo { SFTK_Live_Blk__c }'), method: 8 },
      { name: 'unpackaged/package.xml', data: enc.encode('<Package/>'), method: 0 },
      { name: 'unpackaged/staticresources/x.png', data: new Uint8Array([1, 2, 3]), method: 0 },
    ];
    const zip = buildZip(entries);
    const files = await sftkUnzip(zip);
    expect([...files.keys()].sort()).toEqual(['unpackaged/classes/Foo.cls', 'unpackaged/package.xml']);
    expect(files.get('unpackaged/classes/Foo.cls')).toBe('class Foo { SFTK_Live_Blk__c }');
  });
});

// a tiny zip writer for the test: local headers + central directory, stored or deflated
function buildZip(entries) {
  const parts = [], central = [];
  let off = 0;
  const le16 = n => [n & 255, (n >> 8) & 255], le32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  for (const e of entries) {
    const name = new TextEncoder().encode(e.name);
    const comp = e.method === 8 ? new Uint8Array(deflateRawSync(Buffer.from(e.data))) : e.data;
    const local = new Uint8Array([...le32(0x04034b50), ...le16(20), ...le16(0), ...le16(e.method), ...le16(0), ...le16(0), ...le32(0), ...le32(comp.length), ...le32(e.data.length), ...le16(name.length), ...le16(0), ...name]);
    parts.push(local, comp);
    central.push(new Uint8Array([...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(0), ...le16(e.method), ...le16(0), ...le16(0), ...le32(0), ...le32(comp.length), ...le32(e.data.length), ...le16(name.length), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(off), ...name]));
    off += local.length + comp.length;
  }
  const cdStart = off, cd = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array([...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(entries.length), ...le16(entries.length), ...le32(cd), ...le32(cdStart), ...le16(0)]);
  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((n, a) => n + a.length, 0));
  let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}
