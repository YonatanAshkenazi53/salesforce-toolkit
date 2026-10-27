'use strict';
// ✏ Typed values (user 2026-10-27: "make all the fields editable in every
// operation. change or insert. along with lookups. so users can edit them and
// align data" / "one or many"): on the Deploy page a record — or every selected
// record — can be given the values it is WRITTEN with, field by field, in place
// of the source's. Stored on the deployment's tree node, per target org and
// source record: node.valueOverrides[orgKey][srcId][srcField] = value (null =
// write empty). The engine (background.js, insert payloads) and the overwrite
// (studio-reconcile.js) apply them last but for the identity stamp; a field the
// PII policy covers keeps its masked value, and the run says so.
//
// Pure: no DOM, no storage — the dialog lives in studio-valueedit.js. The org
// key comes from sftk-org-identity.js (sftkOrgKey), like the lookup picks.

function sftkValOvBucket(node, tgtOrgUrl) {
  const all = node && node.valueOverrides;
  if (!all || typeof all !== 'object') return null;
  const want = sftkOrgKey(tgtOrgUrl);
  for (const [k, v] of Object.entries(all)) {
    if (sftkOrgKey(k) === want && v && typeof v === 'object') return v;
  }
  return null;
}

// { srcField: value } for one source record ({} when none).
function sftkValOvGet(node, tgtOrgUrl, srcId) {
  const b = sftkValOvBucket(node, tgtOrgUrl);
  return (b && b[srcId] && typeof b[srcId] === 'object') ? b[srcId] : {};
}

// Write one value (null writes the field empty; undefined clears the override).
// Reuses the org's bucket whatever spelling its key was stored under.
function sftkValOvSet(node, tgtOrgUrl, srcId, field, value) {
  if (!node || !srcId || !field) return;
  if (value === undefined) return sftkValOvClear(node, tgtOrgUrl, srcId, field);
  if (!node.valueOverrides || typeof node.valueOverrides !== 'object') node.valueOverrides = {};
  const all = node.valueOverrides;
  const want = sftkOrgKey(tgtOrgUrl);
  let key = Object.keys(all).find(k => sftkOrgKey(k) === want);
  if (!key) key = want;
  const bucket = all[key] = (all[key] && typeof all[key] === 'object') ? all[key] : {};
  const rec = bucket[srcId] = (bucket[srcId] && typeof bucket[srcId] === 'object') ? bucket[srcId] : {};
  rec[field] = value;
}

// Remove one override (or, with no field, every override of that record) and
// prune what it leaves empty — a node with no typed values carries no key.
function sftkValOvClear(node, tgtOrgUrl, srcId, field) {
  const all = node && node.valueOverrides;
  if (!all || typeof all !== 'object') return;
  const want = sftkOrgKey(tgtOrgUrl);
  for (const k of Object.keys(all)) {
    if (sftkOrgKey(k) !== want) continue;
    const bucket = all[k];
    if (bucket && bucket[srcId] && typeof bucket[srcId] === 'object') {
      if (field) delete bucket[srcId][field]; else delete bucket[srcId];
      if (bucket[srcId] && !Object.keys(bucket[srcId]).length) delete bucket[srcId];
    }
    if (bucket && typeof bucket === 'object' && !Object.keys(bucket).length) delete all[k];
  }
  if (!Object.keys(all).length) delete node.valueOverrides;
}

// How many records of this node carry typed values for that target org, and how many values.
function sftkValOvCount(node, tgtOrgUrl) {
  const b = sftkValOvBucket(node, tgtOrgUrl) || {};
  let values = 0;
  for (const r of Object.values(b)) values += Object.keys(r || {}).length;
  return { records: Object.keys(b).length, values };
}

// Apply one record's typed values to its write payload, under the mapped
// target names. fm = the node's fieldMappings (null = excluded field).
//   allowed: Set of target field names the target can take (null = unknown, keep all)
//   isMasked(srcField): true when the PII policy covers the field — the policy wins
// → { used, masked, skipped: [srcField…] }
function sftkValOvApply(payload, overrides, fm, allowed, isMasked) {
  const out = { used: 0, masked: 0, skipped: [] };
  if (!payload || !overrides || typeof overrides !== 'object') return out;
  const m = fm || {};
  for (const [sf, v] of Object.entries(overrides)) {
    if (sf in m && m[sf] === null) { out.skipped.push(sf); continue; }
    const tf = (m[sf] !== undefined && m[sf] !== null && m[sf] !== '') ? m[sf] : sf;
    if (allowed && !allowed.has(tf)) { out.skipped.push(sf); continue; }
    if (typeof isMasked === 'function' && isMasked(sf)) { out.masked++; continue; }
    payload[tf] = v;
    out.used++;
  }
  return out;
}

// The fields a person may type a value for, from the SOURCE describe:
// mode 'ins' → createable, 'chg' → updateable; never system, audit, owner,
// record type, formula, auto-number, compound or binary fields; never a field
// the mapping excludes. Lookups are listed too (picked, not typed).
//   → [{ name, label, type, reference, refTo, relationshipName, nameField, picklist: [{ value, label }] | null, length }]
function sftkValEditFields(descFields, fm, mode) {
  const NEVER = new Set(['Id', 'CreatedDate', 'CreatedById', 'LastModifiedDate', 'LastModifiedById', 'SystemModstamp',
    'IsDeleted', 'OwnerId', 'RecordTypeId', 'LastActivityDate', 'LastViewedDate', 'LastReferencedDate', 'MasterRecordId', 'Jigsaw', 'JigsawCompanyId']);
  const m = fm || {};
  const out = [];
  for (const f of (descFields || [])) {
    if (!f || !f.name || NEVER.has(f.name)) continue;
    if (mode === 'chg' ? !f.updateable : !f.createable) continue;
    if (f.calculated || f.autoNumber) continue;
    if (['address', 'location', 'base64', 'anyType', 'complexvalue', 'json'].includes(f.type)) continue;
    if (f.name in m && m[f.name] === null) continue;
    out.push({
      name: f.name, label: f.label || f.name, type: f.type || 'string',
      reference: f.type === 'reference', refTo: (f.referenceTo || []).slice(), relationshipName: f.relationshipName || '',
      nameField: !!f.nameField,
      // value = the API name that is written; label = what a person sees in Salesforce (user 2026-10-27: both shown)
      picklist: (f.type === 'picklist' || f.type === 'multipicklist') ? (f.picklistValues || []).filter(v => v && v.active !== false).map(v => ({ value: v.value, label: v.label != null && v.label !== '' ? v.label : v.value })) : null,
      length: f.length || 0,
    });
  }
  out.sort((a, b) => (b.nameField - a.nameField) || a.label.localeCompare(b.label));
  return out;
}

// One sentence for a typed value in a list or a badge.
function sftkValOvText(v) {
  if (v === null || v === undefined || v === '') return '(empty)';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v);
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}
