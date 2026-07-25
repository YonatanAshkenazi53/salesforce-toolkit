'use strict';
// ═════════════════════════════════════════════════════════════════════════
// sftk-flow-xml.js — Flow Tooling-JSON → Metadata-API XML (N1)
// ═════════════════════════════════════════════════════════════════════════
// User request 2026-07-18: "delete deploy and backup of flows, please do it
// in XML." Serializes a Flow's Tooling `Metadata` JSON into the exact XML the
// Metadata API retrieves/deploys (package.xml + flows/<ApiName>.flow inside
// a zip = deployable via Workbench or `sf project deploy start --metadata-dir`).
//
// Ordering: elements are emitted in ALPHABETICAL key order — the order
// Salesforce's own retrieve emits — with array items kept in their original
// sequence. null/undefined values are omitted (Tooling JSON pads absent
// optional elements with null; the Metadata API wants them absent).
//
// Classic script, top-level column-0 pure functions (test/extract.mjs).

function sftkXmlEscape(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// One JSON value → XML lines. `name` = element name, `depth` = indent level.
function sftkXmlNode(name, value, depth) {
  if (value === null || value === undefined) return '';
  const pad = '    '.repeat(depth);
  if (Array.isArray(value)) {
    return value.map(v => sftkXmlNode(name, v, depth)).join('');
  }
  if (typeof value === 'object') {
    const inner = Object.keys(value).sort()
      .map(k => sftkXmlNode(k, value[k], depth + 1)).join('');
    if (!inner) return '';
    return `${pad}<${name}>\n${inner}${pad}</${name}>\n`;
  }
  return `${pad}<${name}>${sftkXmlEscape(value)}</${name}>\n`;
}

// Full .flow document from a Tooling Flow.Metadata JSON object.
function sftkFlowToXml(meta) {
  const body = Object.keys(meta || {}).sort()
    .map(k => sftkXmlNode(k, meta[k], 1)).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<Flow xmlns="http://soap.sforce.com/2006/04/metadata">\n`
    + body
    + `</Flow>\n`;
}

// package.xml for a set of Flow members (mdapi deploy manifest).
function sftkFlowPackageXml(apiNames, apiVersion) {
  const members = [...new Set(apiNames)].sort()
    .map(n => `        <members>${sftkXmlEscape(n)}</members>\n`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n`
    + `    <types>\n${members}        <name>Flow</name>\n    </types>\n`
    + `    <version>${sftkXmlEscape(apiVersion || '62.0')}</version>\n`
    + `</Package>\n`;
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkXmlEscape = sftkXmlEscape;
  globalThis.sftkXmlNode = sftkXmlNode;
  globalThis.sftkFlowToXml = sftkFlowToXml;
  globalThis.sftkFlowPackageXml = sftkFlowPackageXml;
}
