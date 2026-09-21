'use strict';
// ═════════════════════════════════════════════════════════════════════════
// sftk-apiver.js — API versions: the org's, each flow's, and the whole
// subflow tree's, compared across orgs.
// ═════════════════════════════════════════════════════════════════════════
// User request 2026-08-22: "I want an ability to also compare api versions
// and change them of flows and their trees multi org" · "It should also
// compare the orgs api versions ofc. aand be updated when a new version is
// out".
//
// TWO DIFFERENT VERSIONS, AND CONFLATING THEM IS THE BUG THIS PREVENTS
//   · The ORG's API version is the release it runs (Winter '25 = 62.0). It
//     is a ceiling: nothing in that org can be saved above it.
//   · A FLOW's API version is the version its behaviour is pinned to. A
//     flow written years ago still runs at its old version, with that
//     version's semantics, in an org that has moved on.
// An org on a newer release therefore does NOT mean its flows are newer,
// and a flow that looks identical in two orgs can behave differently
// because its pinned version differs. That is exactly the drift this finds.
//
// "BE UPDATED WHEN A NEW VERSION IS OUT" — nothing here hard-codes a
// version or a release name. Both are READ from the org: GET
// /services/data/ answers with every version it supports AND Salesforce's
// own label for each ("Winter '25"). So the day an org upgrades, this
// reports the new number and the new name with no code change. A release
// name is only ever DERIVED when an org somehow answers without one.
//
// Classic script, top-level column-0 pure functions (test/extract.mjs).

// "v62.0" / "62.0" / 62 → 62. Returns null for anything unparseable rather
// than 0 — a version we could not read must never sort as "oldest".
function sftkApiVerNum(v) {
  const m = String(v == null ? '' : v).match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// Normalise the GET /services/data/ payload into newest-first rows.
// Salesforce ships its own label per version, so the release name is read,
// never computed, whenever it is there.
function sftkApiVerList(payload) {
  const arr = Array.isArray(payload) ? payload : (payload && payload.versions) || [];
  return arr
    .map(v => ({
      version: String((v && v.version) || '').trim(),
      label: String((v && v.label) || '').trim(),
      num: sftkApiVerNum(v && v.version),
    }))
    .filter(v => v.num != null)
    .sort((a, b) => b.num - a.num);
}

// The org's ceiling: the newest version it supports.
function sftkApiVerMax(payload) {
  const list = sftkApiVerList(payload);
  if (!list.length) return null;
  const top = list[0];
  return { version: top.version, num: top.num, label: top.label || sftkApiVerRelease(top.num) };
}

// Release name for a version number, DERIVED. Only used when an org
// answered without a label of its own — Salesforce's own words win.
// Anchored on 62.0 = Winter '25, then three releases a year in the order
// Winter, Spring, Summer, all carrying the same year.
function sftkApiVerRelease(num) {
  const n = sftkApiVerNum(num);
  if (n == null) return '';
  const off = Math.round(n) - 62;
  const year = 25 + Math.floor(off / 3);
  const season = ['Winter', 'Spring', 'Summer'][((off % 3) + 3) % 3];
  const yy = String(((year % 100) + 100) % 100).padStart(2, '0');
  return `${season} '${yy}`;
}

// How many releases a flow is behind its own org's ceiling. Three per
// year, so the count doubles as an age: 6 behind is two years old.
function sftkApiVerLag(flowVersion, orgMaxVersion) {
  const f = sftkApiVerNum(flowVersion);
  const o = sftkApiVerNum(orgMaxVersion);
  if (f == null || o == null) return null;
  return Math.max(0, Math.round(o) - Math.round(f));
}

// Collapse Tooling Flow rows (one per VERSION) into one row per flow.
// Both the ACTIVE version and the LATEST version are kept: they are often
// different, and upgrading the wrong one is a silent no-op — the flow that
// actually runs is the active one.
// records: [{ Id, MasterLabel, VersionNumber, Status, ApiVersion,
//             ProcessType, Definition: { DeveloperName } }]
// Locked = Salesforce will not let this org change it. `installed` is a
// managed-package component; `installedEditable` and every packaging-org state
// (released / beta / deprecated / unmanaged) stay editable in that org.
function sftkFlowIsLocked(r) {
  if (!r) return false;
  const st = r.ManageableState == null ? '' : String(r.ManageableState);
  if (st) return st === 'installed';
  return !!r.NamespacePrefix;
}

// Can THIS cell's API version be changed from here, before any target is
// chosen? One rule for the checkbox, the "select" buttons and the plan.
// Returns { ok, why }.
function sftkApiVerSelectable(cell) {
  if (!cell || cell.missing) return { ok: false, why: 'the flow does not exist in this org' };
  if (cell.managed) return { ok: false, why: 'installed from a managed package — its API version ships with the package and only the publisher can change it' };
  if (cell.status === 'InvalidDraft') return { ok: false, why: 'its only version is an invalid draft — Salesforce cannot save it until its errors are fixed in Flow Builder' };
  if (!cell.id) return { ok: false, why: 'Salesforce gave this flow version no record id, so it cannot be read or re-saved from here' };
  return { ok: true, why: '' };
}

function sftkFlowVerRows(records) {
  const by = new Map();
  for (const r of (records || [])) {
    if (!r) continue;
    const name = (r.Definition && r.Definition.DeveloperName) || r.MasterLabel;
    if (!name) continue;
    const cur = by.get(name) || {
      apiName: name, label: r.MasterLabel || name, processType: r.ProcessType || '',
      // A flow INSTALLED from a managed package is the package's to change —
      // the plan refuses it with that reason instead of attempting a deploy
      // the platform would reject. ManageableState is the platform's own
      // answer; a namespace alone is NOT (your own namespaced dev/packaging
      // org has a namespace on every flow you can edit), so the namespace is
      // only the fallback when the state could not be read.
      managed: sftkFlowIsLocked(r),
      active: null, latest: null, versions: 0,
    };
    if (sftkFlowIsLocked(r)) cur.managed = true;
    cur.versions++;
    const entry = {
      id: r.Id, versionNumber: Number(r.VersionNumber) || 0,
      apiVersion: r.ApiVersion == null ? null : String(r.ApiVersion),
      num: sftkApiVerNum(r.ApiVersion), status: r.Status || '',
      lastModified: r.LastModifiedDate == null ? null : String(r.LastModifiedDate),
    };
    if (r.Status === 'Active') cur.active = entry;
    if (!cur.latest || entry.versionNumber > cur.latest.versionNumber) cur.latest = entry;
    if (r.ProcessType && !cur.processType) cur.processType = r.ProcessType;
    by.set(name, cur);
  }
  return [...by.values()].sort((a, b) => a.apiName.localeCompare(b.apiName));
}

// The version that actually GOVERNS a flow's behaviour right now: the
// active version's, falling back to the latest when nothing is active
// (a draft-only flow governs nothing yet, but it is what would run).
function sftkFlowGoverningVer(row) {
  if (!row) return null;
  const e = row.active || row.latest;
  return e ? { apiVersion: e.apiVersion, num: e.num, status: e.status, versionNumber: e.versionNumber, id: e.id } : null;
}

// Build the multi-org matrix. orgs: [{key, label, maxVersion}] ·
// rowsByOrg: { orgKey: [flowVerRow] }. A flow ABSENT from an org is not
// drift of version — it is a different fact, and is reported as its own.
// Returns [{ apiName, label, cells: {orgKey: cell}, drift, versions, missingIn }]
function sftkFlowVerMatrix(orgs, rowsByOrg) {
  const names = new Set();
  for (const o of (orgs || [])) {
    for (const r of ((rowsByOrg || {})[o.key] || [])) names.add(r.apiName);
  }
  const out = [];
  for (const name of [...names].sort()) {
    const cells = {}; const seen = new Set(); const missingIn = [];
    let label = name, processType = '';
    for (const o of orgs) {
      const row = ((rowsByOrg || {})[o.key] || []).find(r => r.apiName === name);
      if (!row) { cells[o.key] = { missing: true }; missingIn.push(o.key); continue; }
      label = row.label || label;
      processType = processType || row.processType;
      const gov = sftkFlowGoverningVer(row);
      cells[o.key] = {
        managed: !!row.managed,
        apiVersion: gov ? gov.apiVersion : null,
        num: gov ? gov.num : null,
        status: gov ? gov.status : '',
        versionNumber: gov ? gov.versionNumber : null,
        id: gov ? gov.id : null,
        versions: row.versions,
        lag: gov ? sftkApiVerLag(gov.apiVersion, o.maxVersion) : null,
      };
      if (gov && gov.apiVersion) seen.add(String(gov.apiVersion));
    }
    out.push({
      apiName: name, label, processType, cells,
      // Drift is decided ONLY across orgs that HAVE the flow. Counting a
      // missing flow as a differing version would call every partial
      // rollout "drifted" and bury the real ones.
      versions: [...seen].sort(),
      drift: seen.size > 1,
      missingIn,
    });
  }
  return out;
}

// Roll a flow's whole SUBFLOW TREE up to one number: the OLDEST API
// version anywhere in it. A flow is only as current as the oldest thing it
// calls, so this is the number that answers "is this tree up to date?"
// (user: "and their trees").
// edges: { flowApiName: [calledFlowApiName, …] } · verOf: name → num|null
// Cycles are visited once, never followed twice — a subflow loop must not
// hang the roll-up.
function sftkFlowTreeRoll(rootName, edges, verOf) {
  const seen = new Set();
  let oldest = null; let unknown = 0; let count = 0;
  const walk = (name) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    count++;
    const v = verOf ? verOf(name) : null;
    if (v == null) unknown++;
    else if (oldest == null || v < oldest) oldest = v;
    for (const child of (((edges || {})[name]) || [])) walk(child);
  };
  walk(rootName);
  return { oldest, unknown, members: count, names: [...seen] };
}

// What a change would DO, per org, before anything is written. A target at
// or below the org's ceiling is applicable; above it is impossible and is
// named as such rather than attempted.
// Returns { applicable: [...], blocked: [{orgKey, why}], noop: [...] }
function sftkApiVerPlan(target, orgs, cells) {
  const t = sftkApiVerNum(target);
  const out = { applicable: [], blocked: [], noop: [] };
  for (const o of (orgs || [])) {
    const c = (cells || {})[o.key];
    const can = sftkApiVerSelectable(c);
    if (!can.ok) { out.blocked.push({ orgKey: o.key, why: can.why }); continue; }
    if (t == null) { out.blocked.push({ orgKey: o.key, why: 'no target version chosen' }); continue; }
    const ceiling = sftkApiVerNum(o.maxVersion);
    if (ceiling != null && t > ceiling) {
      out.blocked.push({ orgKey: o.key, why: `this org runs API ${o.maxVersion} — it cannot save a flow at ${target}` });
      continue;
    }
    if (c.num != null && c.num === t) { out.noop.push({ orgKey: o.key }); continue; }
    out.applicable.push({ orgKey: o.key, from: c.apiVersion, to: String(target), flowVersionId: c.id, status: c.status });
  }
  return out;
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkApiVerNum        = sftkApiVerNum;
  globalThis.sftkApiVerList       = sftkApiVerList;
  globalThis.sftkApiVerMax        = sftkApiVerMax;
  globalThis.sftkApiVerRelease    = sftkApiVerRelease;
  globalThis.sftkApiVerLag        = sftkApiVerLag;
  globalThis.sftkFlowVerRows      = sftkFlowVerRows;
  globalThis.sftkFlowIsLocked     = sftkFlowIsLocked;
  globalThis.sftkApiVerSelectable = sftkApiVerSelectable;
  globalThis.sftkFlowGoverningVer = sftkFlowGoverningVer;
  globalThis.sftkFlowVerMatrix    = sftkFlowVerMatrix;
  globalThis.sftkFlowTreeRoll     = sftkFlowTreeRoll;
  globalThis.sftkApiVerPlan       = sftkApiVerPlan;
}
