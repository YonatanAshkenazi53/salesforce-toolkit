// sftk-cmdt.js — Custom Metadata Type records as deployable metadata.
//
// WHY THIS EXISTS
// Custom Metadata records look like rows and query like rows, but they are
// NOT rows: the REST sObject API will not create them. They travel only as
// metadata, in a package, through the Metadata API deploy the toolkit
// already uses for Flows and Layouts. Custom Settings, by contrast, ARE
// rows — they just carry a polymorphic SetupOwnerId that no ordinary
// lookup bridge can resolve. Both matter for seeding because automation
// READS them: seed data into an org whose CMDT rows are missing and the
// validation rules, flows and Apex that gate that data behave differently
// than they did in the source (user 2026-08-22: "they may be essential for
// seeding operation").
//
// Everything here is pure — string in, string out — so the package a seed
// would deploy can be asserted in tests without touching an org.

// XML text escaping. Deliberately escapes both quote forms: CMDT values are
// free text and a stray " inside an attribute-free element is harmless, but
// staying strict keeps the output safe if a caller ever inlines it.
function sftkCmdtEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// A CMDT type's API name minus the __mdt suffix — the half that prefixes
// every record's fullName ("Country_Setting__mdt" → "Country_Setting").
function sftkCmdtTypeName(objectApi) {
  return String(objectApi || '').replace(/__mdt$/i, '');
}

// fullName for one record: "<Type>.<DeveloperName>".
function sftkCmdtFullName(objectApi, developerName) {
  return `${sftkCmdtTypeName(objectApi)}.${String(developerName || '')}`;
}

// Salesforce's soap type for a field, as <value xsi:type="…"> demands.
// Anything unrecognised falls back to string — the value still deploys and
// Salesforce coerces it, which beats refusing to carry the field at all.
function sftkCmdtXsiType(fieldType) {
  switch (String(fieldType || '').toLowerCase()) {
    case 'boolean': return 'xsd:boolean';
    case 'int': return 'xsd:int';
    case 'double': case 'currency': case 'percent': return 'xsd:double';
    case 'date': return 'xsd:date';
    case 'datetime': return 'xsd:dateTime';
    default: return 'xsd:string';
  }
}

// Which fields of a CMDT type carry data, and how each one's value must be
// read out of SOQL. Relationship fields are the subtle case: the row holds
// an Id, but the deploy wants the RELATED record's api name, so the query
// has to traverse. Fields we cannot traverse are returned in `unsupported`
// so the caller can say so instead of silently dropping them.
// Returns { fields: [{ name, type, soql, xsi }], unsupported: [{name, why}] }
function sftkCmdtFieldPlan(describe) {
  // Fields that are the RECORD's identity or Salesforce's own bookkeeping.
  // Carrying them into <values> is rejected by the deploy; DeveloperName
  // and MasterLabel travel separately as fullName/label. Declared INSIDE
  // the function so it stays self-contained and testable on its own.
  const skip = new Set([
    'Id', 'DeveloperName', 'MasterLabel', 'Label', 'Language',
    'NamespacePrefix', 'QualifiedApiName', 'SystemModstamp',
    'CreatedDate', 'CreatedById', 'LastModifiedDate', 'LastModifiedById',
    'IsDeleted', 'IsProtected',
  ]);
  const out = { fields: [], unsupported: [] };
  for (const f of ((describe && describe.fields) || [])) {
    if (!f || !f.name || skip.has(f.name)) continue;
    if (f.type === 'reference') {
      const rel = f.relationshipName;
      const refs = f.referenceTo || [];
      if (!rel) { out.unsupported.push({ name: f.name, why: 'relationship has no traversable name' }); continue; }
      // EntityDefinition / FieldDefinition relationships store a schema api
      // name; a relationship to another CMDT type stores that record's
      // developer name. Both are stable across orgs — Ids are not.
      const schemaRef = refs.some(r => /^(EntityDefinition|FieldDefinition)$/i.test(r));
      const mdtRef = refs.some(r => /__mdt$/i.test(r));
      if (!schemaRef && !mdtRef) {
        out.unsupported.push({ name: f.name, why: `points at ${refs.join('/') || 'an unknown object'} — no cross-org name to carry` });
        continue;
      }
      out.fields.push({
        name: f.name, type: 'reference', xsi: 'xsd:string',
        soql: `${rel}.${schemaRef ? 'QualifiedApiName' : 'DeveloperName'}`,
      });
      continue;
    }
    if (f.calculated) { out.unsupported.push({ name: f.name, why: 'formula field — computed in the target' }); continue; }
    out.fields.push({ name: f.name, type: f.type, xsi: sftkCmdtXsiType(f.type), soql: f.name });
  }
  return out;
}

// Pull one planned field's value out of a SOQL row, following the traversal
// the plan chose. A missing relationship parent reads as null, not as the
// literal string "undefined".
function sftkCmdtReadValue(row, planField) {
  const path = String(planField.soql || planField.name).split('.');
  let v = row;
  for (const seg of path) {
    if (v == null || typeof v !== 'object') return null;
    v = v[seg];
  }
  return v === undefined ? null : v;
}

// One <values> block. A null deploys as xsi:nil — that is how a CMDT field
// is explicitly BLANK, and it matters: omitting the block instead leaves
// whatever the target already had, which would make a re-seed non-idempotent.
function sftkCmdtValueXml(fieldName, value, xsiType) {
  const inner = (value == null || value === '')
    ? '<value xsi:nil="true"/>'
    : `<value xsi:type="${xsiType || 'xsd:string'}">${sftkCmdtEsc(value)}</value>`;
  return `    <values>\n        <field>${sftkCmdtEsc(fieldName)}</field>\n        ${inner}\n    </values>`;
}

// The .md file for one record.
function sftkCmdtRecordXml(objectApi, row, plan) {
  const label = row && (row.MasterLabel || row.Label || row.DeveloperName) || '';
  const body = ((plan && plan.fields) || [])
    .map(pf => sftkCmdtValueXml(pf.name, sftkCmdtReadValue(row, pf), pf.xsi))
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata"'
      + ' xmlns:xsd="http://www.w3.org/2001/XMLSchema"'
      + ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `    <label>${sftkCmdtEsc(label)}</label>`,
    '    <protected>false</protected>',
    body,
    '</CustomMetadata>',
  ].filter(l => l !== '').join('\n');
}

// package.xml naming every record being deployed. One <types> block —
// CustomMetadata members are "Type.Record", so several types coexist here.
function sftkCmdtPackageXml(members, apiVersion) {
  const list = [...new Set((members || []).filter(Boolean))].sort();
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <types>',
    ...list.map(m => `        <members>${sftkCmdtEsc(m)}</members>`),
    '        <name>CustomMetadata</name>',
    '    </types>',
    `    <version>${sftkCmdtEsc(apiVersion || '62.0')}</version>`,
    '</Package>',
  ].join('\n');
}

// The SOQL that feeds the plan. DeveloperName and MasterLabel are always
// read — they ARE the record's identity in the package.
function sftkCmdtSoql(objectApi, plan) {
  const cols = ['Id', 'DeveloperName', 'MasterLabel',
    ...((plan && plan.fields) || []).map(f => f.soql)];
  return `SELECT ${[...new Set(cols)].join(', ')} FROM ${objectApi}`;
}

// The whole package for one type's rows: [{name, text}] ready for the zip
// builder, plus the members list so a caller can merge several types.
function sftkCmdtBuildFiles(objectApi, rows, plan) {
  const files = [], members = [];
  for (const row of (rows || [])) {
    if (!row || !row.DeveloperName) continue;
    const full = sftkCmdtFullName(objectApi, row.DeveloperName);
    members.push(full);
    files.push({ name: `customMetadata/${full}.md`, text: sftkCmdtRecordXml(objectApi, row, plan) });
  }
  return { files, members };
}

// ── Custom Labels ──────────────────────────────────────────────────────
// Labels are the third piece of configuration that seeded data leans on:
// flows and Apex compare against them, and screens render them. Like CMDT
// they are metadata, not rows — but they are read through the Tooling API
// (as ExternalString) and deployed as ONE file holding every label, so
// they get their own builders rather than being bent into the CMDT shape.

// The SOQL that reads labels. Tooling API — ExternalString IS the Custom
// Label object; there is no REST sObject for it.
function sftkLabelSoql() {
  return 'SELECT Id, Name, MasterLabel, Value, Language, Category, IsProtected, NamespacePrefix'
    + ' FROM ExternalString';
}

// Managed-package labels cannot be deployed into another org — the
// namespace is owned by the package, and the deploy is rejected. Filtering
// them here (rather than letting the deploy fail wholesale) keeps one
// unmovable label from taking the whole package down with it.
function sftkLabelDeployable(rows) {
  const out = { deployable: [], skipped: [] };
  for (const r of (rows || [])) {
    if (!r || !r.Name) continue;
    if (r.NamespacePrefix) { out.skipped.push({ name: r.Name, why: `belongs to managed package ${r.NamespacePrefix}` }); continue; }
    out.deployable.push(r);
  }
  return out;
}

// One <labels> block inside CustomLabels.labels.
function sftkLabelXml(row) {
  const cats = String((row && row.Category) || '').trim();
  return [
    '    <labels>',
    `        <fullName>${sftkCmdtEsc(row.Name)}</fullName>`,
    ...(cats ? [`        <categories>${sftkCmdtEsc(cats)}</categories>`] : []),
    `        <language>${sftkCmdtEsc(row.Language || 'en_US')}</language>`,
    `        <protected>${row.IsProtected ? 'true' : 'false'}</protected>`,
    `        <shortDescription>${sftkCmdtEsc(row.MasterLabel || row.Name)}</shortDescription>`,
    `        <value>${sftkCmdtEsc(row.Value == null ? '' : row.Value)}</value>`,
    '    </labels>',
  ].join('\n');
}

// The whole labels file. Every label in a deploy shares this ONE file —
// that is the Metadata API's shape for CustomLabels, not a choice here.
function sftkLabelsFileXml(rows) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">',
    ...(rows || []).map(sftkLabelXml),
    '</CustomLabels>',
  ].join('\n');
}

// package.xml for any mix of metadata types: { CustomMetadata: [...],
// CustomLabel: [...] }. Types with no members are omitted, so one builder
// serves a labels-only, CMDT-only or combined deploy.
function sftkMetaPackageXml(typesMap, apiVersion) {
  const blocks = [];
  for (const name of Object.keys(typesMap || {}).sort()) {
    const list = [...new Set((typesMap[name] || []).filter(Boolean))].sort();
    if (!list.length) continue;
    blocks.push('    <types>',
      ...list.map(m => `        <members>${sftkCmdtEsc(m)}</members>`),
      `        <name>${sftkCmdtEsc(name)}</name>`,
      '    </types>');
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    ...blocks,
    `    <version>${sftkCmdtEsc(apiVersion || '62.0')}</version>`,
    '</Package>',
  ].join('\n');
}

// ── Custom Label translations ──────────────────────────────────────────
// A label's translated values are NOT part of the label — Salesforce keeps
// them in a different metadata type (Translations), one file per language,
// and reads them through a different Tooling object
// (ExternalStringLocalization). Deploying labels alone silently leaves a
// multi-language org half-seeded: the English text arrives, every other
// language falls back to it and looks correct while being wrong. So the
// translations travel in the same package, keyed by language.

// Tooling SOQL for label translations. ExternalStringId ties each row back
// to the label it translates; the caller joins on it because the Tooling
// object exposes no traversal to the label's Name.
function sftkLabelTransSoql() {
  return 'SELECT Id, ExternalStringId, Language, Value FROM ExternalStringLocalization';
}

// Group translation rows by language and resolve each row's label NAME
// through a { labelId: name } map. Rows whose label is not in the deploy
// are dropped — a translation without its label is not deployable — and
// counted so the caller can say how many.
// Returns { byLang: { lang: [{name, value}] }, orphaned }
function sftkLabelTransGroup(rows, nameById) {
  const byLang = {}; let orphaned = 0;
  for (const r of (rows || [])) {
    if (!r || !r.Language) continue;
    const name = (nameById || {})[r.ExternalStringId];
    if (!name) { orphaned++; continue; }
    (byLang[r.Language] = byLang[r.Language] || []).push({ name, value: r.Value == null ? '' : r.Value });
  }
  for (const lang of Object.keys(byLang)) byLang[lang].sort((a, b) => a.name.localeCompare(b.name));
  return { byLang, orphaned };
}

// One <lang>.translation file. Only the customLabels section is written —
// this package deploys labels, and a Translations file that also claimed
// field or picklist translations would overwrite them with nothing.
function sftkLabelTransFileXml(entries) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Translations xmlns="http://soap.sforce.com/2006/04/metadata">',
    ...(entries || []).map(e => [
      '    <customLabels>',
      `        <label>${sftkCmdtEsc(e.value)}</label>`,
      `        <name>${sftkCmdtEsc(e.name)}</name>`,
      '    </customLabels>',
    ].join('\n')),
    '</Translations>',
  ].join('\n');
}

// Same export convention as sftk-pii.js: a plain global assignment, so the
// file loads as a classic script in studio.html with no module wrapper.
if (typeof globalThis !== 'undefined') {
  globalThis.sftkCmdtEsc           = sftkCmdtEsc;
  globalThis.sftkCmdtTypeName      = sftkCmdtTypeName;
  globalThis.sftkCmdtFullName      = sftkCmdtFullName;
  globalThis.sftkCmdtXsiType       = sftkCmdtXsiType;
  globalThis.sftkCmdtFieldPlan     = sftkCmdtFieldPlan;
  globalThis.sftkCmdtReadValue     = sftkCmdtReadValue;
  globalThis.sftkCmdtValueXml      = sftkCmdtValueXml;
  globalThis.sftkCmdtRecordXml     = sftkCmdtRecordXml;
  globalThis.sftkCmdtPackageXml    = sftkCmdtPackageXml;
  globalThis.sftkCmdtSoql          = sftkCmdtSoql;
  globalThis.sftkCmdtBuildFiles    = sftkCmdtBuildFiles;
  globalThis.sftkLabelSoql         = sftkLabelSoql;
  globalThis.sftkLabelDeployable   = sftkLabelDeployable;
  globalThis.sftkLabelXml          = sftkLabelXml;
  globalThis.sftkLabelsFileXml     = sftkLabelsFileXml;
  globalThis.sftkMetaPackageXml    = sftkMetaPackageXml;
  globalThis.sftkLabelTransSoql    = sftkLabelTransSoql;
  globalThis.sftkLabelTransGroup   = sftkLabelTransGroup;
  globalThis.sftkLabelTransFileXml = sftkLabelTransFileXml;
}
