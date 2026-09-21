'use strict';
// ═════════════════════════════════════════════════════════════════════════
// sftk-identity.js — the 🪪 identity stamp: exact cross-org record matching.
// ═════════════════════════════════════════════════════════════════════════
// User 2026-08-29: "We need a more reliable way to match between records
// between environments … a couple of ways to match but it needs to be more
// reliable" — after duplicate names mis-matched and a managed object had
// no usable external ID.
//
// THE IDEA
// A record's own 18-character Salesforce Id is globally unique and never
// changes. So the tool deploys ONE small field — SFTK_ID__c, Text(18),
// External ID, unique — and writes the SOURCE record's Id into it on every
// record it creates in a target. From then on matching is EXACT: upsert on
// SFTK_ID__c. Renames don't break it, duplicate names don't confuse it,
// autonumbers don't mislead it. Records that already exist in the target
// get stamped once from a scan's matched pairs, then never need fuzzy
// matching again.
//
// This does not replace the other ways to match — it sits on top of them:
//   1. 🪪 SFTK_ID__c   — exact, once stamped (this file)
//   2. External ID      — exact, where the schema already has one
//   3. 🧠 Match memory  — learned pairs from previous runs
//   4. Name (+near-miss folding) — the fallback, with collisions excluded
// The ladder is only as reliable as its top rung, which is why this exists.
//
// Everything here is pure — string/array in, string/array out.

function sftkIdFieldName() { return 'SFTK_ID__c'; }

// The field, in Metadata-API CustomObject shape (objects/<Obj>.object).
// caseSensitive:true because 18-char Ids are case-sensitive by design;
// unique+externalId is what makes upsert possible on it.
function sftkIdFieldXml() {
  return [
    '    <fields>',
    `        <fullName>${sftkIdFieldName()}</fullName>`,
    '        <label>SFTK Identity</label>',
    '        <type>Text</type>',
    '        <length>18</length>',
    '        <externalId>true</externalId>',
    '        <unique>true</unique>',
    '        <caseSensitive>true</caseSensitive>',
    '        <required>false</required>',
    '        <description>Cross-org record identity written by Admin Toolkit for Salesforce: the Id of the record this row was copied from. Enables exact matching between environments. Safe to ignore in reports; do not edit by hand.</description>',
    '    </fields>',
  ].join('\n');
}

function sftkIdObjectFileXml() {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n'
    + sftkIdFieldXml() + '\n'
    + '</CustomObject>';
}

// Field-level security. A field deployed with no FLS is invisible even to
// admins in SOQL — the deploy "succeeds" and every later query says "No
// such column". The permission set carries the FLS, and the caller assigns
// it to the running user right after the deploy.
function sftkIdPermSetName() { return 'SFTK_Identity'; }

function sftkIdPermSetXml(objects) {
  const rows = [...new Set((objects || []).filter(Boolean))].sort().map(o => [
    '    <fieldPermissions>',
    `        <field>${o}.${sftkIdFieldName()}</field>`,
    '        <readable>true</readable>',
    '        <editable>true</editable>',
    '    </fieldPermissions>',
  ].join('\n'));
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n'
    + '    <label>SFTK Identity</label>\n'
    + '    <description>Grants read/write on the SFTK_ID__c identity field Admin Toolkit uses for exact cross-org record matching.</description>\n'
    + '    <hasActivationRequired>false</hasActivationRequired>\n'
    + rows.join('\n') + (rows.length ? '\n' : '')
    + '</PermissionSet>';
}

// The whole deploy for one org: [{name, text}] + package.xml, ready for
// the shared zip builder. One package = field(s) and FLS land together or
// not at all (deploys are all-or-nothing under rollbackOnError).
function sftkIdPackageFiles(objects, apiVersion) {
  const objs = [...new Set((objects || []).filter(Boolean))].sort();
  const files = objs.map(o => ({ name: `objects/${o}.object`, text: sftkIdObjectFileXml() }));
  files.push({ name: `permissionsets/${sftkIdPermSetName()}.permissionset`, text: sftkIdPermSetXml(objs) });
  const pkg = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <types>',
    ...objs.map(o => `        <members>${o}.${sftkIdFieldName()}</members>`),
    '        <name>CustomField</name>',
    '    </types>',
    '    <types>',
    `        <members>${sftkIdPermSetName()}</members>`,
    '        <name>PermissionSet</name>',
    '    </types>',
    `    <version>${apiVersion || '62.0'}</version>`,
    '</Package>',
  ].join('\n');
  return { files, packageXml: pkg };
}

// Backfill: the records that ALREADY exist in a target get their stamp
// from a scan's matched pairs — the one moment fuzzy matching is trusted,
// made permanent. Only identical+changed pairs qualify: both buckets carry
// a sourceId→targetId the scan actually verified.
// Which objects of a tree can get the field CREATED in one org: the probe
// said it is not there (or not visible), and Salesforce allows custom fields
// on the object (EntityDefinition.IsCustomizable; unknown counts as allowed —
// the deploy itself is the judge and reports a refusal).
//   objects: [{ obj, src:'yes'|'no'|'unknown', tgt:…, customizable:true|false|null }]
function sftkIdCreatable(objects, side) {
  const out = [];
  for (const o of (objects || [])) {
    if (!o || !o.obj || o[side] !== 'no' || o.customizable === false) continue;
    if (!out.includes(o.obj)) out.push(o.obj);
  }
  return out;
}

function sftkIdBackfillPairs(scan) {
  const out = [];
  const seen = new Set();
  for (const bucket of [scan && scan.identical, scan && scan.changed]) {
    for (const r of (bucket || [])) {
      if (!r || !r.sourceId || !r.targetId || seen.has(r.targetId)) continue;
      seen.add(r.targetId);
      out.push({ srcId: r.sourceId, tgtId: r.targetId });
    }
  }
  return out;
}

// The update payload for one backfill chunk.
function sftkIdStampPayload(objType, pairs) {
  return (pairs || [])
    .filter(p => p && p.srcId && p.tgtId)
    .map(p => ({ attributes: { type: objType }, Id: p.tgtId, [sftkIdFieldName()]: p.srcId }));
}

// Parse the running user's Id out of the version root's identity URL
// ("https://login.salesforce.com/id/00D…/005…"). One GET, no guessing —
// needed to assign the permission set to whoever ran the deploy.
function sftkIdUserFromIdentity(identityUrl) {
  const m = String(identityUrl || '').match(/\/id\/[A-Za-z0-9]{15,18}\/([A-Za-z0-9]{15,18})\s*$/);
  return m ? m[1] : null;
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkIdFieldName      = sftkIdFieldName;
  globalThis.sftkIdFieldXml       = sftkIdFieldXml;
  globalThis.sftkIdCreatable      = sftkIdCreatable;
  globalThis.sftkIdObjectFileXml  = sftkIdObjectFileXml;
  globalThis.sftkIdPermSetName    = sftkIdPermSetName;
  globalThis.sftkIdPermSetXml     = sftkIdPermSetXml;
  globalThis.sftkIdPackageFiles   = sftkIdPackageFiles;
  globalThis.sftkIdBackfillPairs  = sftkIdBackfillPairs;
  globalThis.sftkIdStampPayload   = sftkIdStampPayload;
  globalThis.sftkIdUserFromIdentity = sftkIdUserFromIdentity;
}
