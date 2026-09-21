'use strict';
// ═════════════════════════════════════════════════════════════════════════
// sftk-flowbulk.js — bulk activate / deactivate for triggered flows.
// ═════════════════════════════════════════════════════════════════════════
// User 2026-08-30: "select and disable, activate flows in bulk, by object.
// basically should work only on triggered flows … also for scheduled flows,
// etc. we can build it upon flow dependency."
//
// The admin move this serves: before a big data load, switch off the
// record-triggered flows on the objects being loaded; load; switch them
// back on. Doing that by hand is one flow at a time in Setup, and the
// dangerous part is the way back: "activate" in Salesforce activates a
// VERSION, and activating the latest version when an older one was live is
// a silent behaviour change. So deactivation REMEMBERS the version that
// was active, and reactivation restores exactly that — falling back to the
// latest only when nothing is remembered, and saying so per flow.
//
// Mechanics: Tooling PATCH on FlowDefinition with
// {Metadata:{activeVersionNumber: N}} — 0 deactivates, N activates v N.
//
// Everything here is pure — arrays in, arrays out.

// The trigger kinds this feature touches. A flow with NO trigger (subflow,
// screen flow) is deliberately out: it has no on/off switch worth bulk-
// flipping, and "deactivate" on it mostly breaks callers.
function sftkFlowBulkKinds() {
  return {
    RecordBeforeSave: 'Before-save',
    RecordAfterSave: 'After-save',
    RecordBeforeDelete: 'Before-delete',
    Scheduled: 'Scheduled',
    PlatformEvent: 'Platform event',
  };
}

// Join the org's answers into one row per triggered flow:
//   viewRows — FlowDefinitionView: ApiName, Label, IsActive, TriggerType,
//              TriggerObjectOrEventLabel  (what triggers it, human label)
//   defRows  — Tooling FlowDefinition: Id, DeveloperName, NamespacePrefix.
//              PLAIN fields only: relationship traversal
//              (ActiveVersion.VersionNumber) proved unreliable live — every
//              flow rendered "not togglable" (user 2026-08-31 screenshot) —
//              and it is unnecessary, because…
//   versByApi — {apiName: {active, latest}} version numbers derived from
//              the Flow version query the caller already runs. One source
//              of truth instead of a second fragile one.
// A namespaced definition is indexed under BOTH its bare DeveloperName and
// ns__DeveloperName, so managed/feature flows still join. A flow the
// Tooling side cannot see keeps its row with defId null — shown but not
// togglable, with the reason, rather than silently missing.
function sftkFlowBulkRows(viewRows, defRows, versByApi) {
  const kinds = sftkFlowBulkKinds();
  const vers = versByApi || {};
  const defBy = new Map();
  for (const d of (defRows || [])) {
    if (!d || !d.DeveloperName) continue;
    defBy.set(d.DeveloperName, d);
    if (d.NamespacePrefix) defBy.set(`${d.NamespacePrefix}__${d.DeveloperName}`, d);
  }
  const out = [];
  for (const v of (viewRows || [])) {
    if (!v || !v.ApiName || !kinds[v.TriggerType]) continue;
    // LIVE (2026-09-03): FlowDefinitionView gives a managed flow's ApiName
    // WITHOUT its prefix and the NamespacePrefix separately — the canonical
    // key everywhere else is ns__Name, so build it here (a row that already
    // carries the prefix in ApiName is left as is).
    const apiName = (v.NamespacePrefix && !String(v.ApiName).startsWith(`${v.NamespacePrefix}__`))
      ? `${v.NamespacePrefix}__${v.ApiName}` : v.ApiName;
    const d = defBy.get(apiName);
    const ver = vers[apiName] || {};
    out.push({
      apiName,
      label: v.Label || apiName,
      managed: !!v.NamespacePrefix,
      kind: kinds[v.TriggerType],
      triggerType: v.TriggerType,
      object: v.TriggerObjectOrEventLabel || '',
      isActive: v.IsActive === true,
      defId: d ? d.Id : null,
      activeVersion: ver.active || null,
      latestVersion: ver.latest || null,
      // Version ids make every cell a LINK into that org's Flow Builder
      // (user 2026-09-01: "make the flows clickable that will open them
      // in the org").
      activeId: ver.activeId || null,
      latestId: ver.latestId || null,
    });
  }
  return out.sort((a, b) => a.object.localeCompare(b.object) || a.label.localeCompare(b.label));
}

// Group for display: record-triggered flows under their OBJECT — that is
// the axis the user works on ("switch off everything on Account") —
// scheduled and platform-event flows under their kind.
function sftkFlowBulkGroup(rows) {
  const by = new Map();
  for (const r of (rows || [])) {
    const key = /^Record/.test(r.triggerType) ? (r.object || '(unknown object)') : `⏰ ${r.kind}`;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(r);
  }
  return [...by.entries()].map(([group, flows]) => ({ group, flows }))
    .sort((a, b) => a.group.localeCompare(b.group));
}

// The plan, decided BEFORE anything is written:
//   mode 'deactivate' — only currently-active picks; remembers each one's
//     active version so the way back is exact.
//   mode 'activate'   — only currently-inactive picks; the remembered
//     version wins, latest is the disclosed fallback.
// remembered: { apiName: versionNumber } from the last deactivation.
// Returns { jobs: [{defId, apiName, label, version, from}],
//           skipped: [{apiName, why}], remember: {apiName: version} }
function sftkFlowBulkPlan(rows, pickedApiNames, mode, remembered) {
  const picked = new Set(pickedApiNames || []);
  const rem = remembered || {};
  const out = { jobs: [], skipped: [], remember: {} };
  for (const r of (rows || [])) {
    if (!picked.has(r.apiName)) continue;
    if (!r.defId) { out.skipped.push({ apiName: r.apiName, why: 'not visible to the Tooling API in this org — toggle it in Setup' }); continue; }
    if (mode === 'deactivate') {
      if (!r.isActive) { out.skipped.push({ apiName: r.apiName, why: 'already inactive' }); continue; }
      out.jobs.push({ defId: r.defId, apiName: r.apiName, label: r.label, version: 0, from: `v${r.activeVersion ?? '?'} active` });
      if (r.activeVersion) out.remember[r.apiName] = r.activeVersion;
      continue;
    }
    if (mode === 'activate') {
      if (r.isActive) { out.skipped.push({ apiName: r.apiName, why: 'already active' }); continue; }
      const remembered_v = rem[r.apiName];
      const version = remembered_v || r.latestVersion;
      if (!version) { out.skipped.push({ apiName: r.apiName, why: 'no version to activate' }); continue; }
      out.jobs.push({
        defId: r.defId, apiName: r.apiName, label: r.label, version,
        // The distinction the user must SEE: restoring what was live is
        // safe; activating the latest may run logic that was never live.
        from: remembered_v ? `restores v${remembered_v} (was active before the switch-off)`
          : `activates LATEST v${version} — no record of what was active before; this may differ from what previously ran`,
      });
    }
  }
  return out;
}

// The cross-org matrix (user 2026-08-30: "the flow activation and
// deactivation done here \u2014 under the feature cross org \u2026 Also the api
// version should be there"). Rows are the UNION of every org's triggered
// flows; each cell answers, for one org: present? on/off? which flow
// version runs, and which API VERSION it is pinned to \u2014 the two version
// facts an admin needs side by side before flipping anything. Absence is
// its own fact, never rendered as "off".
//   orgs:       [{ key, label }]
//   rowsByOrg:  { orgKey: sftkFlowBulkRows(...) }
//   apiVerByOrg:{ orgKey: { apiName: '58.0' } }  (governing version's API)
function sftkFlowBulkMatrix(orgs, rowsByOrg, apiVerByOrg) {
  const byName = new Map();
  for (const o of (orgs || [])) {
    for (const r of ((rowsByOrg || {})[o.key] || [])) {
      if (!byName.has(r.apiName)) {
        byName.set(r.apiName, { apiName: r.apiName, label: r.label, kind: r.kind,
          triggerType: r.triggerType, object: r.object, cells: {} });
      }
      const row = byName.get(r.apiName);
      row.label = row.label || r.label;
      row.cells[o.key] = {
        present: true, isActive: r.isActive, defId: r.defId,
        activeVersion: r.activeVersion, latestVersion: r.latestVersion,
        activeId: r.activeId || null, latestId: r.latestId || null,
        apiVersion: ((apiVerByOrg || {})[o.key] || {})[r.apiName] || null,
      };
    }
  }
  for (const row of byName.values()) {
    for (const o of (orgs || [])) {
      if (!row.cells[o.key]) row.cells[o.key] = { present: false };
    }
  }
  return [...byName.values()].sort((a, b) =>
    (a.object || '').localeCompare(b.object || '') || a.label.localeCompare(b.label));
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkFlowBulkKinds = sftkFlowBulkKinds;
  globalThis.sftkFlowBulkRows  = sftkFlowBulkRows;
  globalThis.sftkFlowBulkGroup = sftkFlowBulkGroup;
  globalThis.sftkFlowBulkPlan  = sftkFlowBulkPlan;
  globalThis.sftkFlowBulkMatrix = sftkFlowBulkMatrix;
}
