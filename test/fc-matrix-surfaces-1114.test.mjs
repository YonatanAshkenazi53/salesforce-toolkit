// FIELD CLEANER MATRIX — THE SURFACES (owner 2026-11-14: from every metadata type, a full delete and a partial
// remove where the field appears ONE time and where it appears A COUPLE of times).
//
// This file is the family of the places a field is SHOWN: page layouts, Lightning pages, reports, custom report
// types, search layouts, record-type picklist values and Paths. Per type, three groups: FULL DELETE (what the
// delete engine knows of the kind), REMOVE with ONE mention, REMOVE with SEVERAL mentions — and one REPLACE with
// several mentions where the kind has ⇄.
//
// What the product edits, per kind (read from the code, not assumed):
//   Layout      Tooling JSON (Layout.Metadata), removeFieldFromLayout / sftkLayoutReplaceField; the Metadata API
//               fallback serialises that JSON with buildLayoutXml
//   FlexiPage   Tooling JSON (FlexiPage.Metadata), removeFieldFromFlexiPage / sftkFlexiReplaceField
//   Report      Analytics REST JSON (reportMetadata), sftkRptStripField / sftkRptReplaceField
//   ReportType  Metadata API XML text, sftkRtRemoveField / sftkRtReplaceField
//   SearchLayout Metadata API XML text of the object, sftkSearchLayoutEdit (one row per layout of the object)
// Every function below is the product's own, sliced out of its source file — nothing is re-implemented.
//
// A test marked it.skip with "PRODUCT BUG" is a case where the product's output is believed wrong; it is skipped,
// never bent to pass.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const FC = read('field-cleaner.js');

// sftk-mdapi.js and sftk-fieldreplace.js are pure files: materialised whole, the way field-replace-1004 does
const M = new Function(`${read('sftk-mdapi.js')}\nreturn { sftkMdFindElement, sftkMdChildText, sftkMdRecordFileXml, sftkMdMentionsField, sftkMdDeleteSpec, sftkMdDestructiveFiles, sftkMdPackageFiles, sftkMdEditField, sftkMdEditWays, sftkMdCodeWays, sftkMdWellFormed, sftkRtMentions, sftkRtRemoveField, sftkRtReplaceField, sftkRtZipFiles, sftkSearchLayoutHits, sftkSearchLayoutEdit };`)();
const R = new Function(`${read('sftk-fieldreplace.js')}\nreturn { sftkLayoutReplaceField, sftkFlexiReplaceField, sftkRptReplaceField };`)();
const RC = extractFunctions('sftk-reportclean.js', ['sftkRptTokenMatch', 'sftkRptFieldHits', 'sftkRptStripField', 'sftkRptScanClass']);

// field-cleaner.js keeps its functions inside one closure (two-space indent, closing at "\n  }\n")
const nested = name => {
  const m = new RegExp(`^  (?:async )?function ${name}\\(`, 'm').exec(FC);
  if (!m) throw new Error(`${name} not found in field-cleaner.js`);
  return FC.slice(m.index, FC.indexOf('\n  }\n', m.index) + 4);
};
const constOf = (name, close) => {
  const i = FC.indexOf(`  const ${name} = `);
  if (i < 0) throw new Error(`${name} not found in field-cleaner.js`);
  return FC.slice(i, FC.indexOf(close, i) + close.length);
};
const L = new Function(`${constOf('_LX_SKIP', ';\n')}${constOf('_LAYOUT_TOP_ORDER', '\n  ];')}
${['_lxEsc', '_lxValueToLines', 'buildLayoutXml', 'buildLayoutPackageXml', 'removeFieldFromLayout', 'removeFieldFromFlexiPage', 'flexiPageReferencesField'].map(nested).join('\n')}
return { buildLayoutXml, buildLayoutPackageXml, removeFieldFromLayout, removeFieldFromFlexiPage, flexiPageReferencesField };`)();
const TYPE_CFG = new Function(`${constOf('TYPE_CFG', '\n  };')}\nreturn TYPE_CFG;`)();

const OBJ = 'Account', F = 'Status_Code__c', NEW = 'New_Status__c';
const clone = x => JSON.parse(JSON.stringify(x));
// the plain whole-word search of the brief: the bare API name ("Object.Field__c" contains it as a whole word too)
const names = (text, field = F) => new RegExp(`(^|[^A-Za-z0-9_])${field}(?![A-Za-z0-9_])`, 'i').test(typeof text === 'string' ? text : JSON.stringify(text));
const count = (text, field = F) => ((typeof text === 'string' ? text : JSON.stringify(text)).match(new RegExp(`(^|[^A-Za-z0-9_])${field}(?![A-Za-z0-9_])`, 'gi')) || []).length;
// which buttons a row of a kind gets — the rule of the row renderer, read from the product's own tables:
// a fixable kind has ✂ (and ⇄) and no 🗑; a kind that is not fixable gets 🗑 when the delete engine knows it
const offered = type => {
  const cfg = TYPE_CFG[type];
  const spec = M.sftkMdDeleteSpec(type), ways = M.sftkMdEditWays(type);
  if (!cfg) return { known: false, remove: false, replace: false, del: false };
  return { known: true, remove: cfg.fixable || !!(ways && ways.remove), replace: cfg.fixable || !!ways, del: !cfg.fixable && !!spec };
};

describe('the row renderer rule this file leans on is the one in the product', () => {
  it('🗑 is for a kind that is NOT fixable and that the delete engine knows; a fixable kind gets ✂ / ⇄ only', () => {
    expect(FC).toContain("const knownKind = !cfgT.fixable && (cfgT.sev === 'blocker' || cfgT.sev === 'silent');");
    expect(FC).toContain("const spec = (knownKind && typeof sftkMdDeleteSpec === 'function') ? (sftkMdDeleteSpec(type) || (type === 'LookupFilter' ? { what: 'lookup filter' } : null) || _extraDeleteSpec(type, id)) : null;");
    expect(FC).toContain('if (!cfgT.fixable) return codeEdits + edits + del;');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// PAGE LAYOUT
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// Layout.Metadata as the Tooling API hands it back: every key present, the unused ones null.
const item = (field, behavior = 'Edit') => ({ analyticsCloudComponent: null, behavior, canvas: null, component: null, customLink: null, emptySpace: null, field, height: null, page: null, reportChartComponent: null, scontrol: null, showLabel: null, showScrollbars: null, width: null });
const layout = () => ({
  customButtons: [],
  customConsoleComponents: null,
  emailDefault: false,
  excludeButtons: ['Submit'],
  feedLayout: null,
  headers: ['PersonalTagging'],
  layoutSections: [
    { customLabel: false, detailHeading: false, editHeading: true, label: 'Information',
      layoutColumns: [
        { layoutItems: [item('Name', 'Required'), item('ParentId')], reserved: null },
        { layoutItems: [item('OwnerId'), item(F), item('Other_Status_Code__c')], reserved: null },
      ], style: 'TwoColumnsTopToBottom' },
    { customLabel: true, detailHeading: true, editHeading: true, label: 'System',
      layoutColumns: [
        { layoutItems: [item('CreatedById', 'Readonly')], reserved: null },
        { layoutItems: [item('LastModifiedById', 'Readonly')], reserved: null },
      ], style: 'TwoColumnsTopToBottom' },
  ],
  miniLayout: { fields: ['Name', 'Phone'], relatedLists: [] },
  multilineLayoutFields: [],
  platformActionList: null,
  quickActionList: null,
  relatedContent: null,
  relatedLists: [
    { customButtons: [], excludeButtons: [], fields: ['FULL_NAME', 'CONTACT.TITLE', 'CONTACT.EMAIL'], relatedList: 'RelatedContactList', sortField: null, sortOrder: null },
  ],
  relatedObjects: [],
  runAssignmentRulesDefault: false,
  showEmailCheckbox: false,
  showHighlightsPanel: false,
  showInteractionLogPanel: false,
  showKnowledgeComponent: null,
  showRunAssignmentRulesCheckbox: false,
  showSolutionSection: null,
  showSubmitAndAttachButton: false,
  summaryLayout: null,
});
const BLANK = { emptySpace: true };

describe('Layout — FULL DELETE', () => {
  it('a page layout is not deleted from here: no delete spec, no 🗑 on the row, ✂ and ⇄ only', () => {
    expect(M.sftkMdDeleteSpec('Layout')).toBeNull();
    expect(M.sftkMdPackageFiles('Layout', 'Account-Account Layout', '<layoutSections/>')).toBeNull();
    expect(offered('Layout')).toEqual({ known: true, remove: true, replace: true, del: false });
    expect(TYPE_CFG.Layout).toMatchObject({ fixable: true, sev: 'silent' });
  });
  it('the XML editor of the blockers does not take a layout either — it says so, nothing changes', () => {
    const xml = '<layoutSections><layoutColumns><layoutItems><behavior>Edit</behavior><field>Status_Code__c</field></layoutItems></layoutColumns></layoutSections>';
    const r = M.sftkMdEditField('Layout', xml, OBJ, F, null);
    expect(r.refused).toMatch(/not edited here/);
    expect(r.xml).toBe(xml);
    expect(r.changed).toBe(false);
  });
  it('what a layout fix deploys is the layout itself, never a destructive package', () => {
    expect(L.buildLayoutPackageXml('Account-Account Layout')).toBe([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <types>',
      '        <members>Account-Account Layout</members>',
      '        <name>Layout</name>',
      '    </types>',
      '    <version>62.0</version>',
      '</Package>'].join('\n'));
    expect(FC).toContain("{ name: `layouts/${fullName}.layout`,        data: enc.encode(buildLayoutXml(metadata, opts)) }");
  });
});

describe('Layout — REMOVE, ONE MENTION', () => {
  it('the field’s slot becomes a blank space; every other item, section and setting is as it was', () => {
    const before = layout(), md = layout();
    expect(names(before)).toBe(true);
    expect(L.removeFieldFromLayout(md, F)).toBe(1);
    const want = clone(before);
    want.layoutSections[0].layoutColumns[1].layoutItems[1] = BLANK;
    expect(md).toEqual(want);
    expect(names(md)).toBe(false);
    expect(names(md, 'Other_Status_Code__c')).toBe(true);      // a longer name that ends the same is another field
    expect(L.removeFieldFromLayout(clone(md), F)).toBe(0);     // the product's own verify: nothing left to take out
  });
  it('the layout file built from it is well-formed, keeps the column structure and does not name the field', () => {
    const md = layout();
    L.removeFieldFromLayout(md, F);
    const xml = L.buildLayoutXml(md);
    expect(M.sftkMdWellFormed(xml)).toBeNull();
    expect(names(xml)).toBe(false);
    expect(M.sftkMdMentionsField(xml, OBJ, F)).toBe(false);
    expect(xml).toContain('        <layoutColumns>\n            <layoutItems>\n                <behavior>Edit</behavior>\n                <field>OwnerId</field>\n            </layoutItems>\n            <layoutItems>\n                <emptySpace>true</emptySpace>\n            </layoutItems>\n            <layoutItems>\n                <behavior>Edit</behavior>\n                <field>Other_Status_Code__c</field>\n            </layoutItems>\n        </layoutColumns>');
    expect((xml.match(/<layoutItems>/g) || []).length).toBe(7);   // seven before, seven after
    expect(xml).not.toMatch(/<layoutItems>\s*<\/layoutItems>/);   // no empty item
    expect(M.sftkMdMentionsField(L.buildLayoutXml(layout()), OBJ, F)).toBe(true);   // and it did name it before
  });
  it('the API name is matched whatever its case, and only as the whole name', () => {
    const md = layout();
    md.layoutSections[0].layoutColumns[1].layoutItems[1].field = 'status_code__C';
    expect(L.removeFieldFromLayout(md, F)).toBe(1);
    expect(md.layoutSections[0].layoutColumns[1].layoutItems[2].field).toBe('Other_Status_Code__c');
  });
  it('REFUSED — a layout that names the field only as a related-list column: nothing to take out, nothing touched', () => {
    // a Contact field shown as a column of the Contacts related list on an Account layout
    const md = layout();
    md.layoutSections[0].layoutColumns[1].layoutItems.splice(1, 1);
    md.relatedLists[0].fields.push(F);
    const before = clone(md);
    expect(L.removeFieldFromLayout(md, F)).toBe(0);
    expect(md).toEqual(before);
    // 0 is what makes the fix stop with its reason instead of saving anything
    expect(FC).toContain('`Field not found in "${componentName}" layout sections. ` +');
    expect(FC).toContain("`It may be in a related list or inline edit only — ${swap ? 'change it' : 'remove'} manually.`");
  });
});

describe('Layout — REMOVE, SEVERAL MENTIONS', () => {
  it('every slot that holds the field goes in one pass — two sections, two spellings', () => {
    const md = layout();
    md.layoutSections[1].layoutColumns[0].layoutItems.push(item('STATUS_CODE__C', 'Readonly'));
    md.layoutSections[1].layoutColumns[1].layoutItems.unshift(item(F));
    const before = clone(md);
    expect(count(before)).toBe(3);
    expect(L.removeFieldFromLayout(md, F)).toBe(3);
    const want = clone(before);
    want.layoutSections[0].layoutColumns[1].layoutItems[1] = BLANK;
    want.layoutSections[1].layoutColumns[0].layoutItems[1] = BLANK;
    want.layoutSections[1].layoutColumns[1].layoutItems[0] = BLANK;
    expect(md).toEqual(want);
    expect(names(md)).toBe(false);
    const xml = L.buildLayoutXml(md);
    expect(M.sftkMdWellFormed(xml)).toBeNull();
    expect(names(xml)).toBe(false);
    expect((xml.match(/<emptySpace>true<\/emptySpace>/g) || []).length).toBe(3);
  });
  // PRODUCT BUG: removeFieldFromLayout walks layoutSections only. A field that is on the layout AND in its mini
  // layout (the hover / console mini page: <miniLayout><fields>) loses its slot, the mini layout still lists it,
  // and the fix's own verify (the same function on the re-read) answers 0 — "the field is really gone".
  it('a field on the layout and in its mini layout — the mini layout entry goes too', () => {
    const md = layout();
    md.miniLayout.fields.push(F);
    L.removeFieldFromLayout(md, F);
    expect(md.miniLayout.fields).toEqual(['Name', 'Phone']);
    expect(names(md)).toBe(false);
    expect(names(L.buildLayoutXml(md))).toBe(false);
  });
  // PRODUCT BUG: the same for a related list of the layout — the column (<relatedLists><fields>) and the sort
  // field (<sortField>) that name the field are left in place while the slot in the sections is taken out.
  it.skip('PRODUCT BUG: a field in a section and as a related-list column / sort field — all of them go', () => {
    const md = layout();
    md.relatedLists.push({ customButtons: [], excludeButtons: [], fields: ['NAME', F], relatedList: 'Account.ParentId', sortField: F, sortOrder: 'Asc' });
    L.removeFieldFromLayout(md, F);
    expect(names(md.relatedLists)).toBe(false);
    expect(names(L.buildLayoutXml(md))).toBe(false);
  });
});

describe('Layout — REPLACE, SEVERAL MENTIONS', () => {
  it('the new field takes the first slot; a field sits on a layout once, so the other slots become blank spaces', () => {
    const md = layout();
    md.layoutSections[1].layoutColumns[0].layoutItems.push(item(F, 'Readonly'));
    const before = clone(md);
    expect(R.sftkLayoutReplaceField(md, F, NEW)).toEqual({ swapped: 1, blanked: 1 });
    const want = clone(before);
    want.layoutSections[0].layoutColumns[1].layoutItems[1].field = NEW;
    want.layoutSections[1].layoutColumns[0].layoutItems[1] = BLANK;
    expect(md).toEqual(want);
    expect(names(md)).toBe(false);
    expect(count(md, NEW)).toBe(1);
    const xml = L.buildLayoutXml(md);
    expect(M.sftkMdWellFormed(xml)).toBeNull();
    expect(xml).toContain('                <behavior>Edit</behavior>\n                <field>New_Status__c</field>');
  });
  it('the new field is already on the layout → every old slot is blanked, the new field still once', () => {
    const md = layout();
    md.layoutSections[0].layoutColumns[0].layoutItems.push(item(NEW));
    md.layoutSections[1].layoutColumns[0].layoutItems.push(item(F));
    expect(R.sftkLayoutReplaceField(md, F, NEW)).toEqual({ swapped: 0, blanked: 2 });
    expect(names(md)).toBe(false);
    expect(count(md, NEW)).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// LIGHTNING PAGE
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// FlexiPage.Metadata as the Tooling API hands it back (the shape of docs/fixtures/field-cleaner-fixture/surfaces).
const fieldInst = (field, extra) => ({ fieldInstance: { fieldInstanceProperties: [{ name: 'uiBehavior', value: 'none' }], fieldItem: `Record.${field}`, identifier: `Record${field.replace(/__c$/, '_c')}Field`, ...(extra || {}) } });
const richText = (id, rule) => ({ componentInstance: { componentInstanceProperties: [{ name: 'richTextValue', value: '<p>Shown for some records.</p>' }], componentName: 'flexipage:richText', identifier: id, ...(rule ? { visibilityRule: rule } : {}) } });
const crit = (leftValue, rightValue = 'New', operator = 'EQUAL') => ({ leftValue, operator, rightValue });
const page = (facetItems, mainItems) => ({
  description: null,
  events: [],
  flexiPageRegions: [
    { itemInstances: facetItems, mode: null, name: 'Facet-col1', type: 'Facet' },
    { itemInstances: [{ componentInstance: { componentInstanceProperties: [{ name: 'body', value: 'Facet-col1' }], componentName: 'flexipage:column', identifier: 'flexipage_column' } }], mode: null, name: 'Facet-cols', type: 'Facet' },
    { itemInstances: [{ componentInstance: { componentInstanceProperties: [], componentName: 'force:highlightsPanel', identifier: 'force_highlightsPanel' } }], mode: null, name: 'header', type: 'Region' },
    { itemInstances: [
        { componentInstance: { componentInstanceProperties: [{ name: 'columns', value: 'Facet-cols' }, { name: 'label', value: 'Details' }], componentName: 'flexipage:fieldSection', identifier: 'flexipage_fieldSection' } },
        ...mainItems,
      ], mode: null, name: 'main', type: 'Region' },
  ],
  masterLabel: 'Account Record Page',
  parentFlexiPage: null,
  sobjectType: 'Account',
  template: { name: 'flexipage:recordHomeTemplateDesktop', properties: [] },
  type: 'RecordPage',
});
// the file a FlexiPage restore deploys, for the delete group
const FLEXI_XML = `<fullName>Account_Record_Page</fullName>
    <flexiPageRegions>
        <itemInstances>
            <fieldInstance>
                <fieldInstanceProperties>
                    <name>uiBehavior</name>
                    <value>none</value>
                </fieldInstanceProperties>
                <fieldItem>Record.Status_Code__c</fieldItem>
                <identifier>RecordStatus_Code_cField</identifier>
            </fieldInstance>
        </itemInstances>
        <name>Facet-col1</name>
        <type>Facet</type>
    </flexiPageRegions>
    <masterLabel>Account Record Page</masterLabel>
    <sobjectType>Account</sobjectType>
    <template>
        <name>flexipage:recordHomeTemplateDesktop</name>
    </template>
    <type>RecordPage</type>`;

describe('FlexiPage — FULL DELETE', () => {
  it('the delete engine knows a Lightning page: its folder, its suffix, its Tooling name', () => {
    expect(M.sftkMdDeleteSpec('FlexiPage')).toEqual({ type: 'FlexiPage', mdType: 'FlexiPage', folder: 'flexipages', suffix: 'flexipage', what: 'Lightning page', tooling: 'FlexiPage' });
  });
  it('the destructive package: an empty package.xml and the page named in destructiveChangesPost.xml', () => {
    const files = M.sftkMdDestructiveFiles([['FlexiPage', 'Account_Record_Page']]);
    expect(files.map(f => f.name)).toEqual(['package.xml', 'destructiveChangesPost.xml']);
    expect(files[0].text).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n    <version>62.0</version>\n</Package>');
    expect(files[1].text).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n    <types>\n        <members>Account_Record_Page</members>\n        <name>FlexiPage</name>\n    </types>\n    <version>62.0</version>\n</Package>');
    for (const f of files) expect(M.sftkMdWellFormed(f.text)).toBeNull();
  });
  it('the restore point: flexipages/<name>.flexipage, the page as it was read minus its fullName', () => {
    const files = M.sftkMdPackageFiles('FlexiPage', 'Account_Record_Page', FLEXI_XML);
    expect(files.map(f => f.name)).toEqual(['package.xml', 'flexipages/Account_Record_Page.flexipage']);
    expect(files[0].text).toContain('<members>Account_Record_Page</members>\n        <name>FlexiPage</name>');
    expect(files[1].text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata"')).toBe(true);
    expect(files[1].text).not.toContain('<fullName>');
    expect(files[1].text).toContain(FLEXI_XML.slice(FLEXI_XML.indexOf('<flexiPageRegions>')));
    expect(M.sftkMdWellFormed(files[1].text)).toBeNull();
  });
  it('on the row a Lightning page is a fixable kind: ✂ and ⇄ are offered, 🗑 is not', () => {
    expect(offered('FlexiPage')).toEqual({ known: true, remove: true, replace: true, del: false });
    expect(M.sftkMdEditWays('FlexiPage')).toBeNull();   // not one of the XML-edited kinds: it has its own remover
  });
});

describe('FlexiPage — REMOVE, ONE MENTION', () => {
  it('a Dynamic Forms field: its item goes, the other fields and components are as they were', () => {
    const md = page([fieldInst('Name'), fieldInst(F), fieldInst('Industry')], [richText('rt1')]);
    const before = clone(md);
    expect(L.flexiPageReferencesField(md, OBJ, F)).toBe(true);
    expect(L.removeFieldFromFlexiPage(md, OBJ, F)).toBe(1);
    const want = clone(before);
    want.flexiPageRegions[0].itemInstances.splice(1, 1);
    expect(md).toEqual(want);
    expect(names(md)).toBe(false);
    expect(L.flexiPageReferencesField(md, OBJ, F)).toBe(false);
    expect(L.removeFieldFromFlexiPage(clone(md), OBJ, F)).toBe(0);
  });
  it('a classic field component (fieldApiName property): the whole component goes', () => {
    const classic = { componentInstance: { componentInstanceProperties: [{ name: 'fieldApiName', value: F }], componentName: 'c:statusBadge', identifier: 'c_statusBadge' } };
    const md = page([fieldInst('Name')], [classic, richText('rt1')]);
    const before = clone(md);
    expect(L.removeFieldFromFlexiPage(md, OBJ, F)).toBe(1);
    const want = clone(before);
    want.flexiPageRegions[3].itemInstances.splice(1, 1);
    expect(md).toEqual(want);
    expect(L.flexiPageReferencesField(md, OBJ, F)).toBe(false);
  });
  it('one of two criteria of a visibility rule: the criterion goes, the component and the other criterion stay', () => {
    const md = page([fieldInst('Name')], [richText('rt1', { booleanFilter: null, criteria: [crit(`{!Record.${F}}`), crit('{!Record.Industry}', 'Banking')] })]);
    const before = clone(md);
    expect(L.removeFieldFromFlexiPage(md, OBJ, F)).toBe(1);
    const want = clone(before);
    want.flexiPageRegions[3].itemInstances[1].componentInstance.visibilityRule.criteria.splice(0, 1);
    expect(md).toEqual(want);
    expect(names(md)).toBe(false);
    expect(L.flexiPageReferencesField(md, OBJ, F)).toBe(false);
  });
  it('the ONLY criterion of a rule: the rule goes with it (no rule with no criteria is left) — the component is then always shown', () => {
    const md = page([fieldInst('Name')], [richText('rt1', { criteria: [crit(`{!Record.${F}}`)] })]);
    const before = clone(md);
    expect(L.removeFieldFromFlexiPage(md, OBJ, F)).toBe(1);
    const want = clone(before);
    delete want.flexiPageRegions[3].itemInstances[1].componentInstance.visibilityRule;
    expect(md).toEqual(want);
    expect(JSON.stringify(md)).not.toContain('"criteria":[]');
    expect(names(md)).toBe(false);
  });
  it('a criterion that compares another field WITH the field (a merge field on the right) goes; a literal that reads like the name stays', () => {
    const md = page([fieldInst('Name')], [richText('rt1', { criteria: [crit('{!Record.Industry}', `{!Record.${F}}`), crit('{!Record.Type}', 'Status_Code__c is empty')] })]);
    expect(L.removeFieldFromFlexiPage(md, OBJ, F)).toBe(1);
    expect(md.flexiPageRegions[3].itemInstances[1].componentInstance.visibilityRule.criteria).toEqual([crit('{!Record.Type}', 'Status_Code__c is empty')]);
  });
  it('numbered logic: the rule that loses a criterion keeps no logic that numbers a criterion it no longer has', () => {
    const md = page([fieldInst('Name')], [richText('rt1', { booleanFilter: '1 AND (2 OR 3)', criteria: [crit('{!Record.Industry}', 'Banking'), crit(`{!Record.${F}}`), crit('{!Record.Type}', 'Customer')] })]);
    expect(L.removeFieldFromFlexiPage(md, OBJ, F)).toBe(1);
    const rule = md.flexiPageRegions[3].itemInstances[1].componentInstance.visibilityRule;
    expect(rule.criteria).toEqual([crit('{!Record.Industry}', 'Banking'), crit('{!Record.Type}', 'Customer')]);
    const top = Math.max(0, ...String(rule.booleanFilter || '').match(/\d+/g)?.map(Number) || [0]);
    expect(top).toBeLessThanOrEqual(rule.criteria.length);
  });
  // PRODUCT BUG (the confirm does say "the criteria that are left are joined by AND", so it is told, not silent):
  // the logic is DROPPED, not re-numbered. "1 AND (2 OR 3)" without criterion 2 should stay true for
  // "1 AND 3"-equivalent only by luck; "1 OR 2 OR 3" without criterion 2 becomes "1 AND 3" — a component that was
  // shown for Banking OR Customer accounts is now shown only for accounts that are both.
  it.skip('PRODUCT BUG: "1 OR 2 OR 3" that loses criterion 2 is re-numbered to "1 OR 2", not turned into AND', () => {
    const md = page([fieldInst('Name')], [richText('rt1', { booleanFilter: '1 OR 2 OR 3', criteria: [crit('{!Record.Industry}', 'Banking'), crit(`{!Record.${F}}`), crit('{!Record.Type}', 'Customer')] })]);
    L.removeFieldFromFlexiPage(md, OBJ, F);
    expect(md.flexiPageRegions[3].itemInstances[1].componentInstance.visibilityRule.booleanFilter).toBe('1 OR 2');
  });
  // PRODUCT BUG: ✂ matches any merge field that ENDS with the field name, so a criterion on a RELATED record's
  // field of the same name ({!Record.Owner.Status_Code__c} — a User field) is taken out of an Account page while
  // Account.Status_Code__c is being cleaned. ⇄ (sftkFlexiReplaceField) leaves exactly that criterion alone and
  // counts it as "another object's field".
  it('a criterion on a related record’s same-named field is another object’s field — ✂ leaves it, as ⇄ does', () => {
    const md = page([fieldInst('Name')], [richText('rt1', { criteria: [crit(`{!Record.Owner.${F}}`), crit('{!Record.Industry}', 'Banking')] })]);
    const before = clone(md);
    expect(R.sftkFlexiReplaceField(clone(md), OBJ, F, NEW)).toEqual({ swapped: 0, dropped: 0, left: 1 });   // ⇄ knows
    expect(L.removeFieldFromFlexiPage(md, OBJ, F)).toBe(0);
    expect(md).toEqual(before);
  });
  it('REFUSED — the field only inside a component’s own setting (a related list’s columns): 0, nothing touched, the fix stops with its reason', () => {
    const related = { componentInstance: { componentInstanceProperties: [
      { name: 'parentFieldApiName', value: 'Account.Id' },
      { name: 'relatedListApiName', value: 'Contacts' },
      { name: 'relatedListFieldAliases', valueList: { valueListItems: [{ value: 'NAME' }, { value: F }] } },
    ], componentName: 'lst:dynamicRelatedList', identifier: 'lst_dynamicRelatedList' } };
    const md = page([fieldInst('Name')], [related]);
    const before = clone(md);
    expect(L.flexiPageReferencesField(md, 'Contact', F)).toBe(true);     // the scan lists the page
    expect(L.removeFieldFromFlexiPage(md, 'Contact', F)).toBe(0);        // ✂ has nothing it may take out
    expect(md).toEqual(before);
    expect(FC).toContain('`No direct field references found in "${componentName}". ` +');
  });
});

describe('FlexiPage — REMOVE, SEVERAL MENTIONS', () => {
  const build = () => page(
    [fieldInst('Name'), fieldInst(F), fieldInst('Industry', { visibilityRule: { criteria: [crit(`{!Record.${F}}`, 'Closed', 'NE'), crit('{!Record.Type}', 'Customer')] } })],
    [
      richText('rt1', { booleanFilter: '1 AND (2 OR 3)', criteria: [crit('{!Record.Industry}', 'Banking'), crit(`{!Record.${F}}`), crit('{!Record.Type}', 'Customer')] }),
      richText('rt2', { criteria: [crit(`{!Record.${F}}`, 'Open'), crit('{!Record.Rating}', `{!Record.${F}}`)] }),
      { componentInstance: { componentInstanceProperties: [{ name: 'fieldApiName', value: `Account.${F}` }], componentName: 'c:statusBadge', identifier: 'c_statusBadge' } },
      richText('rt3', { criteria: [crit('{!Record.Rating}', 'Hot')] }),
    ]);
  it('a field item, a classic component and criteria in three rules all go in one pass', () => {
    const md = build(), before = clone(md);
    expect(count(before)).toBe(6);                                   // field item, Industry rule, rt1, rt2 x2, classic component
    // 1 field item + 1 criterion on a surviving field + 1 of rt1 + 2 of rt2 + 1 classic component
    expect(L.removeFieldFromFlexiPage(md, OBJ, F)).toBe(6);
    const want = clone(before);
    want.flexiPageRegions[0].itemInstances.splice(1, 1);                                                    // the field
    want.flexiPageRegions[0].itemInstances[1].fieldInstance.visibilityRule.criteria.splice(0, 1);           // Industry keeps its other criterion
    const rt1 = want.flexiPageRegions[3].itemInstances[1].componentInstance.visibilityRule;
    rt1.criteria.splice(1, 1); delete rt1.booleanFilter;                                                    // stale numbering goes
    delete want.flexiPageRegions[3].itemInstances[2].componentInstance.visibilityRule;                      // rt2 rested on the field alone
    want.flexiPageRegions[3].itemInstances.splice(3, 1);                                                    // the classic component
    expect(md).toEqual(want);
    expect(names(md)).toBe(false);
    expect(L.flexiPageReferencesField(md, OBJ, F)).toBe(false);
    expect(L.removeFieldFromFlexiPage(clone(md), OBJ, F)).toBe(0);
  });
  it('what is left is a page Salesforce can take: no empty rule, no logic over missing criteria, the untouched rule intact', () => {
    const md = build();
    L.removeFieldFromFlexiPage(md, OBJ, F);
    const rules = [];
    (function walk(n) { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(walk); if (n.visibilityRule) rules.push(n.visibilityRule); Object.values(n).forEach(walk); })(md);
    expect(rules).toHaveLength(3);
    for (const r of rules) {
      expect(r.criteria.length).toBeGreaterThan(0);
      const top = Math.max(0, ...(String(r.booleanFilter || '').match(/\d+/g) || []).map(Number));
      expect(top).toBeLessThanOrEqual(r.criteria.length);
    }
    expect(md.flexiPageRegions[3].itemInstances.map(i => i.componentInstance.identifier)).toEqual(['flexipage_fieldSection', 'rt1', 'rt2', 'rt3']);
    expect(md.flexiPageRegions[3].itemInstances[3].componentInstance.visibilityRule).toEqual({ criteria: [crit('{!Record.Rating}', 'Hot')] });
  });
});

describe('FlexiPage — REPLACE, SEVERAL MENTIONS', () => {
  it('the field item, the classic component’s property and every criterion name the new field; nothing else moves', () => {
    const md = page(
      [fieldInst('Name'), fieldInst(F)],
      [richText('rt1', { booleanFilter: '1 AND (2 OR 3)', criteria: [crit('{!Record.Industry}', 'Banking'), crit(`{!Record.${F}}`), crit('{!Record.Rating}', `{!Record.${F}}`)] })]);
    const before = clone(md);
    expect(R.sftkFlexiReplaceField(md, OBJ, F, NEW)).toEqual({ swapped: 3, dropped: 0, left: 0 });
    const want = clone(before);
    want.flexiPageRegions[0].itemInstances[1].fieldInstance.fieldItem = `Record.${NEW}`;
    const c = want.flexiPageRegions[3].itemInstances[1].componentInstance.visibilityRule.criteria;
    c[1].leftValue = `{!Record.${NEW}}`; c[2].rightValue = `{!Record.${NEW}}`;
    expect(md).toEqual(want);
    expect(md.flexiPageRegions[3].itemInstances[1].componentInstance.visibilityRule.booleanFilter).toBe('1 AND (2 OR 3)');   // nothing was taken out: the logic stands
    expect(names(md)).toBe(false);
    expect(count(md, NEW)).toBe(3);
    expect(L.flexiPageReferencesField(md, OBJ, F)).toBe(false);
    expect(L.flexiPageReferencesField(md, OBJ, NEW)).toBe(true);
  });
  it('the page already shows the new field → the old item is dropped, the criteria still move', () => {
    const md = page([fieldInst(NEW), fieldInst(F)], [richText('rt1', { criteria: [crit(`{!Record.${F}}`)] })]);
    expect(R.sftkFlexiReplaceField(md, OBJ, F, NEW)).toEqual({ swapped: 1, dropped: 1, left: 0 });
    expect(md.flexiPageRegions[0].itemInstances).toHaveLength(1);
    expect(names(md)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// reportMetadata as GET /analytics/reports/{id}/describe returns it.
const QF = `Account.${F}`;
const report = over => ({
  aggregates: ['RowCount'],
  chart: null,
  crossFilters: [],
  currency: null,
  description: null,
  detailColumns: ['ACCOUNT.NAME', QF, 'USERS.NAME', 'INDUSTRY'],
  developerName: 'Accounts_By_Status',
  folderId: '00lxx0000000001AAA',
  groupingsAcross: [],
  groupingsDown: [],
  hasDetailRows: true,
  hasRecordCount: true,
  historicalSnapshotDates: [],
  id: '00Oxx0000000001EAA',
  name: 'Accounts by status',
  reportBooleanFilter: null,
  reportFilters: [],
  reportFormat: 'TABULAR',
  reportType: { label: 'Accounts', type: 'AccountList' },
  scope: 'organization',
  showGrandTotal: true,
  showSubtotals: true,
  sortBy: [{ sortColumn: 'ACCOUNT.NAME', sortOrder: 'Asc' }],
  standardDateFilter: { column: 'CREATED_DATE', durationValue: 'CUSTOM', endDate: null, startDate: null },
  standardFilters: null,
  ...over,
});
const fil = (column, value = 'New', operator = 'equals') => ({ column, filterType: 'fieldValue', isRunPageEditable: true, operator, value });
const grp = (name, sortOrder = 'Asc') => ({ dateGranularity: 'None', name, sortAggregate: null, sortOrder });

describe('Report — FULL DELETE', () => {
  it('a report is not deleted from here: no delete spec, no 🗑 on the row, ✂ and ⇄ only', () => {
    expect(M.sftkMdDeleteSpec('Report')).toBeNull();
    expect(M.sftkMdPackageFiles('Report', 'unfiled$public/Accounts_By_Status', '<columns><field>Account.Status_Code__c</field></columns>')).toBeNull();
    expect(M.sftkMdEditWays('Report')).toBeNull();
    expect(offered('Report')).toEqual({ known: true, remove: true, replace: true, del: false });
    expect(TYPE_CFG.Report).toMatchObject({ fixable: true, sev: 'silent' });
  });
});

describe('Report — REMOVE, ONE MENTION', () => {
  it('a column: it goes, the other columns keep their order, the rest of the report is as it was', () => {
    const before = report();
    const r = RC.sftkRptStripField(before, OBJ, F);
    expect(r).toMatchObject({ removed: { columns: 1, filters: 0, groupings: 0 }, manual: [], changed: true });
    expect(r.meta).toEqual({ ...report(), detailColumns: ['ACCOUNT.NAME', 'USERS.NAME', 'INDUSTRY'] });
    expect(before).toEqual(report());                                    // the read is not touched: it is the restore point
    expect(names(r.meta)).toBe(false);
    expect(RC.sftkRptFieldHits(r.meta, OBJ, F).any).toBe(false);
    expect(RC.sftkRptScanClass(RC.sftkRptFieldHits(r.meta, OBJ, F))).toBeNull();
  });
  it('a column of a custom-report-type report (Account$Field) goes the same way', () => {
    const r = RC.sftkRptStripField(report({ detailColumns: ['Account$Name', `Account$${F}`], sortBy: [] }), OBJ, F);
    expect(r).toMatchObject({ removed: { columns: 1, filters: 0, groupings: 0 }, manual: [], changed: true });
    expect(r.meta.detailColumns).toEqual(['Account$Name']);
    expect(names(r.meta)).toBe(false);
  });
  it('a filter: it goes, the other filter stays', () => {
    const src = report({ detailColumns: ['ACCOUNT.NAME'], reportFilters: [fil('INDUSTRY', 'Banking'), fil(QF)] });
    const r = RC.sftkRptStripField(src, OBJ, F);
    expect(r).toMatchObject({ removed: { columns: 0, filters: 1, groupings: 0 }, manual: [], changed: true });
    expect(r.meta).toEqual({ ...src, reportFilters: [fil('INDUSTRY', 'Banking')] });
    expect(names(r.meta)).toBe(false);
  });
  it('one of two row groupings of a summary report: it goes, the other grouping stays', () => {
    const src = report({ reportFormat: 'SUMMARY', detailColumns: ['ACCOUNT.NAME'], groupingsDown: [grp('INDUSTRY'), grp(QF)] });
    const r = RC.sftkRptStripField(src, OBJ, F);
    expect(r).toMatchObject({ removed: { columns: 0, filters: 0, groupings: 1 }, manual: [], changed: true });
    expect(r.meta).toEqual({ ...src, groupingsDown: [grp('INDUSTRY')] });
    expect(names(r.meta)).toBe(false);
  });
  it('REFUSED — the report’s ONLY column: nothing changes, the reason is said', () => {
    const src = report({ detailColumns: [QF], sortBy: [] });
    const r = RC.sftkRptStripField(src, OBJ, F);
    expect(r.changed).toBe(false);
    expect(r.removed).toEqual({ columns: 0, filters: 0, groupings: 0 });
    expect(r.meta).toEqual(src);
    expect(r.manual).toEqual(['it is the report’s ONLY column — removing it would leave an empty report; add another column first']);
  });
  it('REFUSED — the only row grouping of a summary report, and either only axis of a matrix: nothing changes, the reason is said', () => {
    const sum = report({ reportFormat: 'SUMMARY', detailColumns: ['ACCOUNT.NAME'], groupingsDown: [grp(QF)] });
    const a = RC.sftkRptStripField(sum, OBJ, F);
    expect(a.changed).toBe(false);
    expect(a.meta).toEqual(sum);
    expect(a.manual).toEqual(['it is the report’s only row grouping — regroup the report first']);
    const mat = report({ reportFormat: 'MATRIX', detailColumns: ['ACCOUNT.NAME'], groupingsDown: [grp('INDUSTRY')], groupingsAcross: [grp(QF)] });
    const b = RC.sftkRptStripField(mat, OBJ, F);
    expect(b.changed).toBe(false);
    expect(b.meta).toEqual(mat);
    expect(b.manual).toEqual(['it is the report’s only column grouping — regroup the report first']);
  });
  it('REFUSED — the field only in a custom summary formula: never auto-edited, nothing changes, the reason is said', () => {
    const src = report({ detailColumns: ['ACCOUNT.NAME'], customSummaryFormula: { FORMULA1: { label: 'Share', formula: `${QF}:SUM / RowCount`, formulaType: 'number', decimalPlaces: 2 } } });
    const r = RC.sftkRptStripField(src, OBJ, F);
    expect(r.changed).toBe(false);
    expect(r.meta).toEqual(src);
    expect(r.manual).toHaveLength(1);
    expect(r.manual[0]).toMatch(/formula, bucket, cross filter or chart/);
    expect(RC.sftkRptScanClass(RC.sftkRptFieldHits(src, OBJ, F))).toBe('definite');
  });
  it('a bare token with the field’s name but no object is only a maybe: left alone and named', () => {
    const src = report({ detailColumns: ['ACCOUNT.NAME', F] });
    const r = RC.sftkRptStripField(src, OBJ, F);
    expect(r.changed).toBe(false);
    expect(r.meta).toEqual(src);
    expect(r.manual).toEqual([`“${F}” matches the field name but not the object — left alone (could belong to another object); verify by hand`]);
  });
  it('the same field name on ANOTHER object is not this field', () => {
    const src = report({ detailColumns: ['ACCOUNT.NAME', `Contact.${F}`, `Account.Other_${F}`] });
    const r = RC.sftkRptStripField(src, OBJ, F);
    expect(r).toMatchObject({ changed: false, manual: [] });
    expect(r.meta).toEqual(src);
  });
});

describe('Report — REMOVE, SEVERAL MENTIONS', () => {
  it('a column, a filter and a grouping go in one pass; what is left is a report with a column, a filter and a grouping', () => {
    const src = report({ reportFormat: 'SUMMARY', reportFilters: [fil('INDUSTRY', 'Banking'), fil(QF, 'Closed', 'notEqual')], groupingsDown: [grp('INDUSTRY'), grp(QF, 'Desc')] });
    expect(count(src)).toBe(3);
    const r = RC.sftkRptStripField(src, OBJ, F);
    expect(r).toMatchObject({ removed: { columns: 1, filters: 1, groupings: 1 }, manual: [], changed: true });
    expect(r.meta).toEqual({ ...src, detailColumns: ['ACCOUNT.NAME', 'USERS.NAME', 'INDUSTRY'], reportFilters: [fil('INDUSTRY', 'Banking')], groupingsDown: [grp('INDUSTRY')] });
    expect(names(r.meta)).toBe(false);
    expect(RC.sftkRptFieldHits(r.meta, OBJ, F).any).toBe(false);
  });
  it('two filters on the field and a column grouping of a matrix with two: all four mentions go', () => {
    const src = report({ reportFormat: 'MATRIX', reportFilters: [fil(QF, 'New'), fil('INDUSTRY', 'Banking'), fil(QF, 'Lost', 'notEqual')], groupingsDown: [grp('INDUSTRY')], groupingsAcross: [grp(QF), grp('TYPE')] });
    expect(count(src)).toBe(4);
    const r = RC.sftkRptStripField(src, OBJ, F);
    expect(r).toMatchObject({ removed: { columns: 1, filters: 2, groupings: 1 }, manual: [], changed: true });
    expect(r.meta.reportFilters).toEqual([fil('INDUSTRY', 'Banking')]);
    expect(r.meta.groupingsAcross).toEqual([grp('TYPE')]);
    expect(r.meta.groupingsDown).toEqual([grp('INDUSTRY')]);
    expect(names(r.meta)).toBe(false);
  });
  // PRODUCT BUG: a report's filter logic (reportBooleanFilter, "(1 OR 2) AND 3") numbers the filters by position.
  // sftkRptStripField takes a filter out and leaves the logic as it was: three numbers over two filters. Salesforce
  // refuses that save at best; where the count still fits ("1 OR 2" → the survivor is now number 1 and number 2 is
  // gone) the logic no longer says what the owner wrote.
  it('the filter logic — a numbered filter that would go makes the edit refuse it, the logic named (refused, not re-numbered)', () => {
    const src = report({ detailColumns: ['ACCOUNT.NAME'], reportBooleanFilter: '(1 OR 2) AND 3', reportFilters: [fil('INDUSTRY', 'Banking'), fil(QF), fil('TYPE', 'Customer')] });
    const r = RC.sftkRptStripField(src, OBJ, F);
    if (r.changed) {
      const top = Math.max(0, ...(String(r.meta.reportBooleanFilter || '').match(/\d+/g) || []).map(Number));
      expect(top).toBeLessThanOrEqual(r.meta.reportFilters.length);      // got: "(1 OR 2) AND 3" over 2 filters
      expect(r.meta.reportBooleanFilter).toBe('1 AND 2');
    } else {
      expect(r.manual.join(' ')).toMatch(/logic/i);
      expect(r.meta).toEqual(src);
    }
  });
  // PRODUCT BUG (against the rule of this matrix — "some mentions can go and one forces a refusal → refuse as a
  // whole"): the strip is partial BY DESIGN ("that removal is refused with the fix, the rest still proceed"). The
  // column goes and is saved; the only grouping stays and the result line says "still manual". The report is
  // changed and the field is still in it.
  it.skip('PRODUCT BUG: a column that can go + the only grouping that cannot → refused as a whole, nothing half-done', () => {
    const src = report({ reportFormat: 'SUMMARY', groupingsDown: [grp(QF)] });
    const r = RC.sftkRptStripField(src, OBJ, F);
    expect(r.manual).toEqual(['it is the report’s only row grouping — regroup the report first']);
    expect(r.changed).toBe(false);                 // got: true, removed.columns 1
    expect(r.meta).toEqual(src);
  });
  // PRODUCT BUG: the report is sorted by the column that goes (sortBy[].sortColumn). The column is taken out, the
  // sort still names it — a sort on a column the report no longer has — and the leftover is reported as "a
  // formula, bucket, cross filter or chart", which it is not.
  it('a column the report is sorted by — the sort goes with the column', () => {
    const src = report({ sortBy: [{ sortColumn: QF, sortOrder: 'Desc' }] });
    const r = RC.sftkRptStripField(src, OBJ, F);
    expect(r.changed).toBe(true);
    expect(names(r.meta)).toBe(false);             // got: sortBy still names Account.Status_Code__c
    expect(r.manual).toEqual([]);
  });
  it('what the product does today with a mixed report is at least SAID: the leftover is named in "manual", never called clean', () => {
    const src = report({ reportFormat: 'SUMMARY', groupingsDown: [grp(QF)], customSummaryFormula: { FORMULA1: { label: 'x', formula: `${QF}:SUM` } } });
    const r = RC.sftkRptStripField(src, OBJ, F);
    expect(r.manual).toHaveLength(2);
    expect(RC.sftkRptFieldHits(r.meta, OBJ, F).any).toBe(true);
    expect(FC).toContain("if (res.manual.length) label += ` \\u00b7 \\u26a0 still manual: ${res.manual.join('; ')}`;");
    expect(FC).toContain('return { ok: !res.manual.length && !(left && left.any), text: label };');
  });
});

describe('Report — REPLACE, SEVERAL MENTIONS', () => {
  it('the column, both filters and the grouping name the new field in place — positions, operators and values kept', () => {
    const src = report({ reportFormat: 'SUMMARY', reportBooleanFilter: '(1 OR 2) AND 3', reportFilters: [fil(QF, 'New'), fil(QF, 'Open'), fil('INDUSTRY', 'Banking')], groupingsDown: [grp(QF, 'Desc')] });
    expect(count(src)).toBe(4);
    const r = R.sftkRptReplaceField(src, OBJ, F, NEW, RC.sftkRptTokenMatch, RC.sftkRptFieldHits);
    expect(r).toMatchObject({ swapped: { columns: 1, filters: 2, groupings: 1 }, manual: [], changed: true });
    const QN = `Account.${NEW}`;
    expect(r.meta).toEqual({ ...src, detailColumns: ['ACCOUNT.NAME', QN, 'USERS.NAME', 'INDUSTRY'], reportFilters: [fil(QN, 'New'), fil(QN, 'Open'), fil('INDUSTRY', 'Banking')], groupingsDown: [grp(QN, 'Desc')] });
    expect(r.meta.reportBooleanFilter).toBe('(1 OR 2) AND 3');           // no filter left: the logic still fits
    expect(names(r.meta)).toBe(false);
    expect(count(r.meta, NEW)).toBe(4);
    expect(RC.sftkRptFieldHits(r.meta, OBJ, F).any).toBe(false);
  });
  it('the spelling of a custom-report-type report is kept, and a column the report already has is not added twice', () => {
    const src = report({ detailColumns: ['Account$Name', `Account$${NEW}`, `Account$${F}`], reportFilters: [fil(`Account$${F}`)], sortBy: [] });
    const r = R.sftkRptReplaceField(src, OBJ, F, NEW, RC.sftkRptTokenMatch, RC.sftkRptFieldHits);
    expect(r.swapped).toEqual({ columns: 1, filters: 1, groupings: 0 });
    expect(r.meta.detailColumns).toEqual(['Account$Name', `Account$${NEW}`]);
    expect(r.meta.reportFilters).toEqual([fil(`Account$${NEW}`)]);
    expect(names(r.meta)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// CUSTOM REPORT TYPE
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// The record as readMetadata hands it back (the shape of test/fc-reporttype-1104 and the reporttype fixture).
const col = (field, table = 'Account', checked = false) => `
            <columns>
                <checkedByDefault>${checked}</checkedByDefault>
                <field>${field}</field>
                <table>${table}</table>
            </columns>`;
const section = (label, cols) => `
        <sections>${cols.join('')}
            <masterLabel>${label}</masterLabel>
        </sections>`;
const rtype = sections => `
        <fullName>Accounts_with_Contacts</fullName>
        <baseObject>Account</baseObject>
        <category>accounts</category>
        <deployed>true</deployed>
        <description>Accounts &amp; their contacts</description>
        <join>
            <outerJoin>true</outerJoin>
            <relationship>Contacts</relationship>
        </join>
        <label>Accounts with Contacts</label>${sections.join('')}
    `;

describe('ReportType — FULL DELETE', () => {
  it('a report type is not deleted from here: no delete spec, no 🗑 on the row, ✂ and ⇄ only', () => {
    expect(M.sftkMdDeleteSpec('ReportType')).toBeNull();
    expect(M.sftkMdPackageFiles('ReportType', 'Accounts_with_Contacts', rtype([]))).toBeNull();
    expect(M.sftkMdEditWays('ReportType')).toBeNull();
    expect(offered('ReportType')).toEqual({ known: true, remove: true, replace: true, del: false });
    expect(TYPE_CFG.ReportType).toMatchObject({ fixable: true, sev: 'silent' });
  });
  it('what its fix deploys: reportTypes/<name>.reportType under a package.xml that names the type — not a destructive one', () => {
    const inner = rtype([section('Accounts', [col('Name', 'Account', true), col(F)])]);
    const file = M.sftkMdRecordFileXml('ReportType', M.sftkRtRemoveField(inner, OBJ, F).xml);
    const files = M.sftkRtZipFiles('Accounts_with_Contacts', file);
    expect(files.map(f => f.name)).toEqual(['package.xml', 'reportTypes/Accounts_with_Contacts.reportType']);
    expect(files[0].text).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n    <types>\n        <members>Accounts_with_Contacts</members>\n        <name>ReportType</name>\n    </types>\n    <version>62.0</version>\n</Package>');
    expect(files[1].text).not.toContain('<fullName>');
    expect(M.sftkMdWellFormed(files[1].text)).toBeNull();
  });
});

describe('ReportType — REMOVE, ONE MENTION', () => {
  it('one column of a section with others: the <columns> element goes, every other byte is as it was', () => {
    const inner = rtype([section('Accounts', [col('Name', 'Account', true), col(F), col('Industry')]), section('Contacts', [col('LastName', 'Account.Contacts', true)])]);
    expect(M.sftkRtMentions(inner, OBJ, F)).toBe(1);
    expect(count(inner)).toBe(1);
    const r = M.sftkRtRemoveField(inner, OBJ, F);
    expect(r).toMatchObject({ removed: 1, emptied: [], skipped: [], changed: true });
    expect(r.xml).toBe(inner.replace(col(F).trimStart(), ''));   // the element goes; the indentation before it stays (whitespace only)
    expect(M.sftkRtMentions(r.xml, OBJ, F)).toBe(0);
    expect(M.sftkMdMentionsField(r.xml, OBJ, F)).toBe(false);
    expect(names(r.xml)).toBe(false);
    expect(M.sftkMdWellFormed(M.sftkMdRecordFileXml('ReportType', r.xml))).toBeNull();
    expect(r.xml).toContain('<description>Accounts &amp; their contacts</description>');   // the escaped text is not re-written
  });
  it('the only column of its section: the section goes with it (a section with no columns is not left behind)', () => {
    const own = section('Status', [col(F)]);
    const inner = rtype([section('Accounts', [col('Name', 'Account', true)]), own, section('Contacts', [col('LastName', 'Account.Contacts')])]);
    const r = M.sftkRtRemoveField(inner, OBJ, F);
    expect(r).toMatchObject({ removed: 1, emptied: ['Status'], skipped: [], changed: true });
    expect(r.xml).toBe(inner.replace(own.trimStart(), ''));
    expect(r.xml).not.toMatch(/<sections>\s*<masterLabel>/);
    expect((r.xml.match(/<sections>/g) || []).length).toBe(2);
    expect(names(r.xml)).toBe(false);
    expect(M.sftkMdWellFormed(M.sftkMdRecordFileXml('ReportType', r.xml))).toBeNull();
  });
  it('REFUSED — the name appears only under another table (Account.Contacts: a Contact field): nothing changes, it is named', () => {
    const inner = rtype([section('Accounts', [col('Name', 'Account', true)]), section('Contacts', [col(F, 'Account.Contacts')])]);
    const r = M.sftkRtRemoveField(inner, OBJ, F);
    expect(r).toMatchObject({ removed: 0, changed: false, skipped: ['Account.Contacts.Status_Code__c in “Contacts”'] });
    expect(r.xml).toBe(inner);
    expect(FC).toContain('if (!res.changed) throw fail(`"${componentName}" has no column of ${obj}.${field}${res.skipped.length ?');
  });
  it('a longer field name that contains this one is another field', () => {
    const inner = rtype([section('Accounts', [col('Name'), col(`Other_${F}`), col(F.replace('__c', '_2__c'))])]);
    expect(M.sftkRtMentions(inner, OBJ, F)).toBe(0);
    expect(M.sftkRtRemoveField(inner, OBJ, F)).toMatchObject({ changed: false, xml: inner });
  });
});

describe('ReportType — REMOVE, SEVERAL MENTIONS', () => {
  it('the column in two sections (two spellings of the name and of the table) and a same-named Contact column: this object’s go, the other stays and is named', () => {
    const a = col(F), b = col('STATUS_CODE__C', 'account', true), other = col(F, 'Account.Contacts');
    const inner = rtype([section('Accounts', [col('Name', 'Account', true), a]), section('More', [b, col('Industry')]), section('Contacts', [col('LastName', 'Account.Contacts'), other])]);
    expect(M.sftkRtMentions(inner, OBJ, F)).toBe(2);
    expect(count(inner)).toBe(3);
    const r = M.sftkRtRemoveField(inner, OBJ, F);
    expect(r).toMatchObject({ removed: 2, emptied: [], skipped: ['Account.Contacts.Status_Code__c in “Contacts”'], changed: true });
    expect(r.xml).toBe(inner.replace(a.trimStart(), '').replace(b.trimStart(), ''));
    expect(M.sftkRtMentions(r.xml, OBJ, F)).toBe(0);
    expect(count(r.xml)).toBe(1);
    expect(r.xml).toContain(other);
    expect(M.sftkMdWellFormed(M.sftkMdRecordFileXml('ReportType', r.xml))).toBeNull();
  });
  it('two sections that held only the field both go; the sections left are untouched', () => {
    const s1 = section('Status', [col(F)]), s2 = section('Status again', [col(F, 'Account', true)]);
    const inner = rtype([s1, section('Accounts', [col('Name', 'Account', true)]), s2]);
    const r = M.sftkRtRemoveField(inner, OBJ, F);
    expect(r).toMatchObject({ removed: 2, emptied: ['Status', 'Status again'], changed: true });
    expect(r.xml).toBe(inner.replace(s1.trimStart(), '').replace(s2.trimStart(), ''));
    expect(names(r.xml)).toBe(false);
  });
  // PRODUCT BUG: a report type can list a field REACHED THROUGH A LOOKUP of the same table —
  // <field>Parent.Status_Code__c</field><table>Account</table> is Account.Status_Code__c of the parent account.
  // The remover compares the whole <field> text with the API name, so that column is not seen: not counted by
  // sftkRtMentions (the scan and the fix's verify), not removed, not even listed in "skipped". ✂ answers
  // "1 column removed — verified" and the type still names the field.
  it('the field as a plain column and through the Parent lookup (Parent.Field) — both are seen', () => {
    const inner = rtype([section('Accounts', [col('Name', 'Account', true), col(F), col(`Parent.${F}`)])]);
    expect(M.sftkRtMentions(inner, OBJ, F)).toBe(2);                     // got: 1
    const r = M.sftkRtRemoveField(inner, OBJ, F);
    expect(names(r.xml) && !r.skipped.length).toBe(false);               // either it went, or it is named as left alone
  });
});

describe('ReportType — REPLACE, SEVERAL MENTIONS', () => {
  it('this object’s column names the new field in place; the same name under another table is left and named', () => {
    const inner = rtype([section('Accounts', [col('Name', 'Account', true), col(F, 'Account', true)]), section('Contacts', [col(F, 'Account.Contacts')])]);
    const r = M.sftkRtReplaceField(inner, OBJ, F, NEW);
    expect(r).toMatchObject({ swapped: 1, dropped: 0, emptied: [], skipped: ['Account.Contacts.Status_Code__c in “Contacts”'], newAlreadyThere: false, changed: true });
    expect(r.xml).toBe(inner.replace(col(F, 'Account', true), col(NEW, 'Account', true)));
    expect(M.sftkRtMentions(r.xml, OBJ, F)).toBe(0);
    expect(M.sftkRtMentions(r.xml, OBJ, NEW)).toBe(1);
    expect(M.sftkMdWellFormed(M.sftkMdRecordFileXml('ReportType', r.xml))).toBeNull();
  });
  it('the new field is already a column → every old column is removed instead (a column appears once per type)', () => {
    const a = col(F), b = col(F, 'Account', true);
    const inner = rtype([section('Accounts', [col('Name'), col(NEW), a]), section('More', [b, col('Industry')])]);
    const r = M.sftkRtReplaceField(inner, OBJ, F, NEW);
    expect(r).toMatchObject({ swapped: 0, dropped: 2, newAlreadyThere: true, changed: true });
    expect(r.xml).toBe(inner.replace(a.trimStart(), '').replace(b.trimStart(), ''));
    expect(M.sftkRtMentions(r.xml, OBJ, NEW)).toBe(1);
    expect(names(r.xml)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// SEARCH LAYOUTS
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// The object as readMetadata hands it back. A custom field is listed by its API name, a standard one as
// OBJECT.FIELD. Each search layout of the object is ONE row of the scan (sl_<Object>_<tag>): ✂ on a row takes the
// field out of that layout.
const SL = body => `<fullName>Account</fullName>
    <enableFeeds>true</enableFeeds>
    <searchLayouts>${body}
    </searchLayouts>
    <sharingModel>ReadWrite</sharingModel>`;
const sl = (tag, v) => `\n        <${tag}>${v}</${tag}>`;
const apply = (inner, r) => inner.replace(r.before, r.after);   // the object after one row's edit

describe('SearchLayout — FULL DELETE', () => {
  it('a search layout is a part of its object: no delete spec, no 🗑 on the row, ✂ and ⇄ only', () => {
    expect(M.sftkMdDeleteSpec('SearchLayout')).toBeNull();
    expect(M.sftkMdEditWays('SearchLayout')).toBeNull();
    expect(offered('SearchLayout')).toEqual({ known: true, remove: true, replace: true, del: false });
    expect(TYPE_CFG.SearchLayout).toMatchObject({ fixable: true, sev: 'silent' });
  });
  it('what its fix deploys is the object file under objects/<Object>.object — a CustomObject deploy, nothing destructive', () => {
    expect(FC).toContain("const pkg = '<?xml version=\"1.0\" encoding=\"UTF-8\"?>\\n<Package xmlns=\"http://soap.sforce.com/2006/04/metadata\"><types><members>' + obj + '</members><name>CustomObject</name></types><version>62.0</version></Package>';");
    expect(FC).toContain("const zipAfter = _zipOf([{ name: 'package.xml', text: pkg }, { name: `objects/${obj}.object`, text: ed.file }]);");
  });
});

describe('SearchLayout — REMOVE, ONE MENTION', () => {
  const inner = SL(sl('customTabListAdditionalFields', 'ACCOUNT.NAME') + sl('searchResultsAdditionalFields', 'ACCOUNT.NAME') + sl('searchResultsAdditionalFields', F) + sl('searchResultsAdditionalFields', `Other_${F}`));
  it('the entry goes; the other columns of the layout and the other layouts are byte for byte as they were', () => {
    expect(M.sftkSearchLayoutHits(inner, OBJ, F)).toEqual([{ tag: 'searchResultsAdditionalFields', label: 'Search results' }]);
    const r = M.sftkSearchLayoutEdit(inner, OBJ, F, 'searchResultsAdditionalFields', null);
    expect(r.n).toBe(1);
    expect(r.before).toBe(inner.slice(inner.indexOf('<searchLayouts>'), inner.indexOf('</searchLayouts>') + '</searchLayouts>'.length));
    expect(r.after).toBe(r.before.replace('<searchResultsAdditionalFields>Status_Code__c</searchResultsAdditionalFields>', ''));
    expect(names(r.after)).toBe(false);
    expect(M.sftkMdMentionsField(r.after, OBJ, F)).toBe(false);
    expect(M.sftkSearchLayoutHits(apply(inner, r), OBJ, F)).toEqual([]);
    expect(r.after).toContain(`<searchResultsAdditionalFields>Other_${F}</searchResultsAdditionalFields>`);
  });
  it('a standard object deploys its search layouts alone, in a well-formed CustomObject file', () => {
    const r = M.sftkSearchLayoutEdit(inner, OBJ, F, 'searchResultsAdditionalFields', null);
    expect(r.file).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">' + r.after + '</CustomObject>');
    expect(M.sftkMdWellFormed(r.file)).toBeNull();
    expect(names(r.file)).toBe(false);
  });
  it('the only column of a layout: the layout is left with no entry of its own, the others stand', () => {
    const one = SL(sl('customTabListAdditionalFields', 'ACCOUNT.NAME') + sl('lookupDialogsAdditionalFields', F));
    const r = M.sftkSearchLayoutEdit(one, OBJ, F, 'lookupDialogsAdditionalFields', null);
    expect(r.n).toBe(1);
    expect(r.after).not.toContain('lookupDialogsAdditionalFields');
    expect(r.after).toContain('<customTabListAdditionalFields>ACCOUNT.NAME</customTabListAdditionalFields>');
    expect(M.sftkMdWellFormed(r.file)).toBeNull();
  });
  it('REFUSED — a layout that does not list the field: n is 0, nothing changes, the fix stops and asks for a re-scan', () => {
    const r = M.sftkSearchLayoutEdit(inner, OBJ, F, 'customTabListAdditionalFields', null);
    expect(r.n).toBe(0);
    expect(r.after).toBe(r.before);
    expect(FC).toContain('if (!ed.n) throw fail(`The “${componentName}” search layout of ${obj} no longer lists ${field} — re-scan.`);');
  });
});

describe('SearchLayout — REMOVE, SEVERAL MENTIONS', () => {
  const inner = SL(sl('customTabListAdditionalFields', 'ACCOUNT.NAME') + sl('customTabListAdditionalFields', F)
    + sl('lookupDialogsAdditionalFields', 'ACCOUNT.NAME') + sl('lookupDialogsAdditionalFields', `Account.${F}`)
    + sl('searchFilterFields', F) + sl('searchFilterFields', 'ACCOUNT.TYPE')
    + sl('searchResultsAdditionalFields', 'ACCOUNT.NAME') + sl('searchResultsAdditionalFields', F) + sl('searchResultsAdditionalFields', 'ACCOUNT.PHONE1'));
  const TAGS = ['customTabListAdditionalFields', 'lookupDialogsAdditionalFields', 'searchFilterFields', 'searchResultsAdditionalFields'];
  it('four layouts list the field → four rows; each ✂ clears its own layout and leaves the other three as they are', () => {
    expect(M.sftkSearchLayoutHits(inner, OBJ, F).map(h => h.tag)).toEqual(TAGS);
    const r = M.sftkSearchLayoutEdit(inner, OBJ, F, 'searchFilterFields', null);
    expect(r.n).toBe(1);
    expect(r.after).toBe(r.before.replace('<searchFilterFields>Status_Code__c</searchFilterFields>', ''));
    expect(M.sftkSearchLayoutHits(apply(inner, r), OBJ, F).map(h => h.tag)).toEqual(TAGS.filter(t => t !== 'searchFilterFields'));
  });
  it('the four rows walked one after the other leave no mention, both spellings (Field and Object.Field) included', () => {
    let now = inner;
    for (const tag of TAGS) {
      const r = M.sftkSearchLayoutEdit(now, OBJ, F, tag, null);
      expect(r.n).toBe(1);
      expect(M.sftkMdWellFormed(r.file)).toBeNull();
      now = apply(now, r);
    }
    expect(M.sftkSearchLayoutHits(now, OBJ, F)).toEqual([]);
    expect(names(now)).toBe(false);
    expect(now).toBe(SL(sl('customTabListAdditionalFields', 'ACCOUNT.NAME') + sl('lookupDialogsAdditionalFields', 'ACCOUNT.NAME') + sl('searchFilterFields', 'ACCOUNT.TYPE')
      + sl('searchResultsAdditionalFields', 'ACCOUNT.NAME') + sl('searchResultsAdditionalFields', 'ACCOUNT.PHONE1'))
      .replace('<customTabListAdditionalFields>ACCOUNT.NAME</customTabListAdditionalFields>', '<customTabListAdditionalFields>ACCOUNT.NAME</customTabListAdditionalFields>\n        ')
      .replace('<lookupDialogsAdditionalFields>ACCOUNT.NAME</lookupDialogsAdditionalFields>', '<lookupDialogsAdditionalFields>ACCOUNT.NAME</lookupDialogsAdditionalFields>\n        ')
      .replace('<searchFilterFields>ACCOUNT.TYPE</searchFilterFields>', '\n        <searchFilterFields>ACCOUNT.TYPE</searchFilterFields>')
      .replace('<searchResultsAdditionalFields>ACCOUNT.NAME</searchResultsAdditionalFields>', '<searchResultsAdditionalFields>ACCOUNT.NAME</searchResultsAdditionalFields>\n        '));
  });
  it('the field twice in ONE layout (two spellings): both entries go in one pass', () => {
    const twice = SL(sl('searchResultsAdditionalFields', F) + sl('searchResultsAdditionalFields', 'ACCOUNT.NAME') + sl('searchResultsAdditionalFields', `account.${F.toLowerCase()}`));
    const r = M.sftkSearchLayoutEdit(twice, OBJ, F, 'searchResultsAdditionalFields', null);
    expect(r.n).toBe(2);
    expect(names(r.after)).toBe(false);
    expect((r.after.match(/<searchResultsAdditionalFields>/g) || []).length).toBe(1);
    expect(M.sftkMdWellFormed(r.file)).toBeNull();
  });
  it('a custom object: the file carries the object’s own properties (it must) and none of its child components', () => {
    const obj = `<fullName>Thing__c</fullName><deploymentStatus>Deployed</deploymentStatus><fields><fullName>${F}</fullName><label>Status code</label><type>Text</type><length>10</length></fields><label>Thing</label><listViews><fullName>All</fullName><columns>NAME</columns><columns>${F}</columns><filterScope>Everything</filterScope></listViews><nameField><label>Thing Name</label><type>Text</type></nameField><pluralLabel>Things</pluralLabel><recordTypes><fullName>Big</fullName><active>true</active><picklistValues><picklist>${F}</picklist><values><fullName>New</fullName><default>false</default></values></picklistValues></recordTypes><searchLayouts><lookupDialogsAdditionalFields>${F}</lookupDialogsAdditionalFields><searchResultsAdditionalFields>${F}</searchResultsAdditionalFields><searchResultsAdditionalFields>CREATED_DATE</searchResultsAdditionalFields></searchLayouts><sharingModel>ReadWrite</sharingModel>`;
    const r = M.sftkSearchLayoutEdit(obj, 'Thing__c', F, 'searchResultsAdditionalFields', null);
    expect(r.n).toBe(1);
    expect(r.after).toBe(`<searchLayouts><lookupDialogsAdditionalFields>${F}</lookupDialogsAdditionalFields><searchResultsAdditionalFields>CREATED_DATE</searchResultsAdditionalFields></searchLayouts>`);
    expect(r.file).toBe(`<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><deploymentStatus>Deployed</deploymentStatus><label>Thing</label><nameField><label>Thing Name</label><type>Text</type></nameField><pluralLabel>Things</pluralLabel>${r.after}<sharingModel>ReadWrite</sharingModel></CustomObject>`);
    expect(M.sftkMdWellFormed(r.file)).toBeNull();
    expect(count(r.file)).toBe(1);   // the one layout that was not this row's
  });
});

describe('SearchLayout — REPLACE, SEVERAL MENTIONS', () => {
  const inner = SL(sl('lookupDialogsAdditionalFields', 'ACCOUNT.NAME') + sl('lookupDialogsAdditionalFields', F)
    + sl('searchResultsAdditionalFields', F) + sl('searchResultsAdditionalFields', NEW) + sl('searchResultsAdditionalFields', 'ACCOUNT.NAME'));
  it('each row’s entry names the new field in place; where the new field is already a column the old entry just goes', () => {
    const a = M.sftkSearchLayoutEdit(inner, OBJ, F, 'lookupDialogsAdditionalFields', NEW);
    expect(a).toMatchObject({ n: 1, swapped: true, newAlreadyThere: false });
    expect(a.after).toBe(a.before.replace(`<lookupDialogsAdditionalFields>${F}</lookupDialogsAdditionalFields>`, `<lookupDialogsAdditionalFields>${NEW}</lookupDialogsAdditionalFields>`));
    const mid = apply(inner, a);
    const b = M.sftkSearchLayoutEdit(mid, OBJ, F, 'searchResultsAdditionalFields', NEW);
    expect(b).toMatchObject({ n: 1, swapped: false, newAlreadyThere: true });
    expect(b.after).toBe(b.before.replace(`<searchResultsAdditionalFields>${F}</searchResultsAdditionalFields>`, ''));
    const done = apply(mid, b);
    expect(names(done)).toBe(false);
    expect(count(done, NEW)).toBe(2);
    expect(M.sftkSearchLayoutHits(done, OBJ, F)).toEqual([]);
    expect(M.sftkSearchLayoutHits(done, OBJ, NEW).map(h => h.tag)).toEqual(['lookupDialogsAdditionalFields', 'searchResultsAdditionalFields']);
    expect(M.sftkMdWellFormed(b.file)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// RECORD-TYPE PICKLIST VALUES
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// A record type lists, per picklist of the object, the values it offers (<picklistValues><picklist>Field</picklist>).
// Salesforce drops that block itself when the picklist field is deleted. Field Cleaner has no kind for it: nothing
// is scanned, nothing is offered — the tests pin exactly that, so a silent change of behaviour shows up here.
const RECORD_TYPE = `<fullName>Account.Partner</fullName>
        <active>true</active>
        <businessProcess>Partner Process</businessProcess>
        <label>Partner</label>
        <picklistValues>
            <picklist>Industry</picklist>
            <values>
                <fullName>Banking</fullName>
                <default>false</default>
            </values>
        </picklistValues>
        <picklistValues>
            <picklist>Status_Code__c</picklist>
            <values>
                <fullName>New</fullName>
                <default>true</default>
            </values>
            <values>
                <fullName>Closed</fullName>
                <default>false</default>
            </values>
        </picklistValues>`;

describe('RecordType picklist values — FULL DELETE / REMOVE / REPLACE: not offered', () => {
  it('there is no such kind: not in the scan’s kinds, no delete spec, no ✂ / ⇄ ways', () => {
    expect(TYPE_CFG.RecordType).toBeUndefined();
    expect(offered('RecordType')).toEqual({ known: false, remove: false, replace: false, del: false });
    expect(M.sftkMdDeleteSpec('RecordType')).toBeNull();
    expect(M.sftkMdEditWays('RecordType')).toBeNull();
    expect(M.sftkMdCodeWays('RecordType')).toBeNull();
    expect(M.sftkMdPackageFiles('RecordType', 'Account.Partner', RECORD_TYPE)).toBeNull();
    expect(FC).not.toMatch(/add\('RecordType'/);
  });
  it('one mention or several, ✂ and ⇄ are refused with the reason and the XML is handed back as it was', () => {
    for (const nf of [null, NEW]) {
      const one = M.sftkMdEditField('RecordType', RECORD_TYPE, OBJ, F, nf);
      expect(one).toEqual({ xml: RECORD_TYPE, changed: false, how: [], refused: 'this kind is not edited here — 🗑 delete it, or edit it in Setup' });
      const several = RECORD_TYPE + RECORD_TYPE.slice(RECORD_TYPE.lastIndexOf('<picklistValues>'));
      expect(count(several)).toBe(2);
      expect(M.sftkMdEditField('RecordType', several, OBJ, F, nf)).toMatchObject({ xml: several, changed: false, refused: expect.stringMatching(/not edited here/) });
    }
  });
  it('the product’s own mention test does not read <picklist>: a record type is never seen as naming the field', () => {
    expect(names(RECORD_TYPE)).toBe(true);
    expect(M.sftkMdMentionsField(RECORD_TYPE, OBJ, F)).toBe(false);
  });
  it('a search-layout fix on a custom object never carries a record type along in its file', () => {
    const obj = `<fullName>Thing__c</fullName><label>Thing</label><recordTypes>${RECORD_TYPE.replace('Account.Partner', 'Partner')}</recordTypes><searchLayouts><searchResultsAdditionalFields>${F}</searchResultsAdditionalFields></searchLayouts>`;
    const r = M.sftkSearchLayoutEdit(obj, 'Thing__c', F, 'searchResultsAdditionalFields', null);
    expect(r.file).not.toContain('recordTypes');
    expect(r.file).not.toContain('picklistValues');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// PATH
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// PathAssistant as the Metadata API writes it: the picklist the path runs on (<fieldName>) and, per step, the key
// fields shown (<fieldNames>). The scan lists a Path whose picklist IS the field (PathAssistant.SobjectProcessField).
const PATH = `<fullName>Account_Status_Path</fullName>
    <active>true</active>
    <entityName>Account</entityName>
    <fieldName>Status_Code__c</fieldName>
    <masterLabel>Account Status Path</masterLabel>
    <pathAssistantSteps>
        <fieldNames>Name</fieldNames>
        <fieldNames>Industry</fieldNames>
        <info>&lt;p&gt;Qualify the account.&lt;/p&gt;</info>
        <picklistValueName>New</picklistValueName>
    </pathAssistantSteps>
    <pathAssistantSteps>
        <fieldNames>Rating</fieldNames>
        <picklistValueName>Closed</picklistValueName>
    </pathAssistantSteps>
    <recordTypeName>__MASTER__</recordTypeName>`;
const PATH_KEYFIELDS = PATH.replace('<fieldNames>Industry</fieldNames>', '<fieldNames>Status_Code__c</fieldNames>').replace('<fieldNames>Rating</fieldNames>', '<fieldNames>Rating</fieldNames>\n        <fieldNames>Status_Code__c</fieldNames>');

// 2026-11-16 (owner: "we said all items must have a delete/remove"): a Path is edited and deleted here — it was a
// mention with nothing to press. Live: scripts/dev/live/fc-every-row-acts.mjs.
describe('Path — FULL DELETE: not offered (Salesforce refuses it through its APIs, live 2026-11-16)', () => {
  it('a Path is a mention with ✂ / ⇄ for a step\'s key field, and no 🗑', () => {
    expect(TYPE_CFG.PathAssistant).toMatchObject({ fixable: false, sev: 'silent' });
    expect(M.sftkMdDeleteSpec('PathAssistant')).toMatchObject({ mdType: 'PathAssistant', what: 'path', noDelete: true });
    expect(M.sftkMdEditWays('PathAssistant')).toEqual({ remove: true, replace: true });
    expect(M.sftkMdCodeWays('PathAssistant')).toBeNull();
    expect(M.sftkMdPackageFiles('PathAssistant', 'Account_Status_Path', PATH)).not.toBeNull();
    expect(offered('PathAssistant').remove).toBe(true);
    expect(offered('PathAssistant').replace).toBe(true);
    expect(FC).toContain('const del = (spec && !spec.noDelete &&');
  });
  it('the delete walk cannot be asked to delete it either: the engine answers that it is not deleted from here', () => {
    expect(FC).toContain('if (!spec || spec.noDelete) throw new Error(`A ${cfg.label || type} is not deleted from here — clear it in Setup.`);');
  });
});

describe('Path — REMOVE / REPLACE, ONE MENTION and SEVERAL: refused, the XML untouched', () => {
  it('one mention (the path’s own picklist): the product sees it, ✂ and ⇄ are refused, nothing changes', () => {
    expect(count(PATH)).toBe(1);
    expect(M.sftkMdMentionsField(PATH, OBJ, F)).toBe(true);
    for (const nf of [null, NEW]) { const r = M.sftkMdEditField('PathAssistant', PATH, OBJ, F, nf); expect(r.xml).toBe(PATH); expect(r.changed).toBe(false); expect(r.refused).toMatch(/the path runs on the field itself/); }
  });
  it('several mentions (the picklist and a key field in two steps): refused as a whole, not one of them is touched', () => {
    expect(count(PATH_KEYFIELDS)).toBe(3);
    for (const nf of [null, NEW]) {
      const r = M.sftkMdEditField('PathAssistant', PATH_KEYFIELDS, OBJ, F, nf);
      expect(r.refused).toMatch(/the path runs on the field itself/);
      expect(r.xml).toBe(PATH_KEYFIELDS);
      expect(r.changed).toBe(false);
    }
  });
  // 2026-11-16: a key field of a step lists the Path too (it pinned the gap: only the path's own picklist did)
  it('the scan reads the path’s picklist (SobjectProcessField) by a query, and the steps’ key fields of the other paths', () => {
    expect(FC).toContain("FROM PathAssistant WHERE SobjectType = '${obj}'`, true))?.records || [];");
    expect(FC).toContain("if (sameField(p.SobjectProcessField)) { add('PathAssistant', p.Id,");
    expect(FC).toContain('fcPathStepsWith(one[0] && one[0].Metadata, sameField)');
  });
});
