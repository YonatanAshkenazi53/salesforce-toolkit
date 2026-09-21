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

// Salesforce accepts "62.0" and REJECTS "62" for a flow's apiVersion. The
// Tooling API hands the value back as a NUMBER, so a plain serialize emits
// the rejected form and the deploy fails with a message that does not
// mention the version at all. Field Cleaner learned this the hard way and
// special-cased it locally; it belongs here, where every caller gets it.
// Returns null for anything unreadable rather than a wrong guess.
function sftkFlowApiVersionStr(v) {
  const m = String(v == null ? '' : v).match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n.toFixed(1) : null;
}

// A COPY of a flow's Tooling metadata with its apiVersion changed. Pure:
// the caller's object is never mutated, so a failed deploy leaves nothing
// half-edited. Returns { meta, from, to } or { error }.
function sftkFlowSetApiVersion(meta, target) {
  const to = sftkFlowApiVersionStr(target);
  if (!to) return { error: `“${target}” is not a version Salesforce would accept` };
  if (!meta || typeof meta !== 'object') return { error: 'no flow metadata to change' };
  const from = sftkFlowApiVersionStr(meta.apiVersion);
  return { meta: { ...meta, apiVersion: to }, from, to };
}

// Full .flow document from a Tooling Flow.Metadata JSON object.
function sftkFlowToXml(meta) {
  const body = Object.keys(meta || {}).sort()
    .map(k => {
      // apiVersion is the one key whose SHAPE matters to Salesforce, not
      // just its value — "62" is rejected where "62.0" is accepted.
      if (k === 'apiVersion') {
        const v = sftkFlowApiVersionStr(meta[k]);
        return v == null ? '' : `    <apiVersion>${v}</apiVersion>\n`;
      }
      return sftkXmlNode(k, meta[k], 1);
    }).join('');
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
  globalThis.sftkFlowApiVersionStr = sftkFlowApiVersionStr;
  globalThis.sftkFlowSetApiVersion = sftkFlowSetApiVersion;
  globalThis.sftkFlowPackageXml = sftkFlowPackageXml;
}
