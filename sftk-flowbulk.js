'use strict';
// ═════════════════════════════════════════════════════════════════════════
// sftk-flowbulk.js — bulk activate / deactivate for every flow in the org.
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

// The trigger kinds with an on/off switch of their own. A flow with NO
// trigger (subflow, screen flow) was out until 2026-11-08; it is listed and
// switchable now (user: "צריך להציג את כל הפלואים"), and its confirmation
// says what switching it off breaks (sftkFlowBulkOffWarning).
function sftkFlowBulkKinds() {
  return {
    RecordBeforeSave: 'Before-save',
    RecordAfterSave: 'After-save',
    RecordBeforeDelete: 'Before-delete',
    Scheduled: 'Scheduled',
    PlatformEvent: 'Platform event',
  };
}

// The kind of ANY flow, in the admin's words (user 2026-11-08, after a
// colleague's first day with ⏻ Switches: "it should show all the flows, not
// only record-triggered"). A trigger names the kind first; a flow with no
// trigger is named by its process type. An unknown value is read out as it
// came, split into words — never dropped and never called something else.
function sftkFlowKindOf(triggerType, processType) {
  const kinds = sftkFlowBulkKinds();
  if (triggerType && kinds[triggerType]) return kinds[triggerType];
  const byProcess = {
    Flow: 'Screen flow',
    AutoLaunchedFlow: 'Autolaunched (no trigger)',
    Workflow: 'Process Builder',
    InvocableProcess: 'Process Builder (invocable)',
    CustomEvent: 'Process Builder (platform event)',
    Orchestrator: 'Orchestration',
    EvaluationFlow: 'Orchestration evaluation',
    Survey: 'Survey', SurveyEnrich: 'Survey',
    LoginFlow: 'Login flow',
    CheckoutFlow: 'Checkout flow',
    ContactRequestFlow: 'Contact request',
    ActionCadenceFlow: 'Sales cadence', ActionCadenceAutolaunchedFlow: 'Sales cadence',
    ActionCadenceStepFlow: 'Sales cadence step',
    Appointments: 'Appointments',
    FieldServiceMobile: 'Field Service mobile', FieldServiceWeb: 'Field Service web',
    PromptFlow: 'Prompt template',
    RoutingFlow: 'Omni-Channel routing',
    ApprovalWorkflow: 'Approval',
    DataCaptureFlow: 'Data capture',
    ManagedContentAuthoringWorkflow: 'Content authoring',
    IdentityUserRegistrationFlow: 'User registration',
    IndividualObjectLinkingFlow: 'Individual linking',
    TransactionSecurityFlow: 'Transaction security',
    UserProvisioningFlow: 'User provisioning',
    CustomerLifecycle: 'Customer lifecycle',
    Journey: 'Journey',
    LoyaltyManagementFlow: 'Loyalty',
    RecommendationStrategy: 'Recommendation strategy',
    CmsOrchestrator: 'CMS orchestration',
  };
  const words = s => String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim();
  if (triggerType) return `${words(triggerType)}-triggered`;
  if (processType && byProcess[processType]) return byProcess[processType];
  return processType ? words(processType) : 'Flow';
}

// Join the org's answers into one row per flow — EVERY flow the org lists
// (user 2026-11-08: "צריך להציג את כל הפלואים לא רק רקורד טריגר"):
//   viewRows — FlowDefinitionView: ApiName, Label, IsActive, TriggerType,
//              TriggerObjectOrEventLabel (what triggers it, human label),
//              TriggerObjectOrEventId (its API name — the fallback when a
//              packaged object's label does not come back)
//   defRows  — Tooling FlowDefinition: Id, DeveloperName, NamespacePrefix.
//              PLAIN fields only: relationship traversal
//              (ActiveVersion.VersionNumber) proved unreliable live — every
//              flow rendered "not togglable" (user 2026-08-31 screenshot) —
//              and it is unnecessary, because…
//   versByApi — {apiName: {active, latest, processType}} derived from the
//              Flow version query the caller already runs. One source of
//              truth instead of a second fragile one.
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
    if (!v || !v.ApiName) continue;
    // LIVE (2026-09-03): FlowDefinitionView gives a managed flow's ApiName
    // WITHOUT its prefix and the NamespacePrefix separately — the canonical
    // key everywhere else is ns__Name, so build it here (a row that already
    // carries the prefix in ApiName is left as is).
    const apiName = (v.NamespacePrefix && !String(v.ApiName).startsWith(`${v.NamespacePrefix}__`))
      ? `${v.NamespacePrefix}__${v.ApiName}` : v.ApiName;
    const d = defBy.get(apiName);
    const ver = vers[apiName] || {};
    const triggerType = v.TriggerType || '';
    const processType = ver.processType || v.ProcessType || '';
    out.push({
      apiName,
      label: v.Label || apiName,
      managed: !!v.NamespacePrefix,
      kind: sftkFlowKindOf(triggerType, processType),
      triggerType,
      // A trigger of one of the known kinds: the on/off switch the feature
      // was built for. Every other flow is listed and switchable too, and
      // its confirmation says what switching it off breaks.
      triggered: !!kinds[triggerType],
      processType,
      object: v.TriggerObjectOrEventLabel || v.TriggerObjectOrEventId || '',
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

// The group a row is shown under: a record-triggered flow under its OBJECT —
// that is the axis the user works on ("switch off everything on Account") —
// every other flow under its kind. Object groups carry no icon, kind groups
// do, so the two are told apart at a glance and sort after the objects.
function sftkFlowBulkGroupKey(r) {
  const t = String((r && r.triggerType) || '');
  if (/^Record/.test(t)) return (r.object || '(unknown object)');
  if (t === 'Scheduled') return '⏰ Scheduled';
  if (t === 'PlatformEvent') return '\u{1F4E1} Platform event';
  const k = String((r && r.kind) || 'Flow');
  if (/^Screen/.test(k)) return `\u{1F5A5} ${k}`;
  if (/^Autolaunched/.test(k)) return `⚙ ${k}`;
  if (/^Process Builder/.test(k)) return `\u{1F9E9} ${k}`;
  return `\u{1F539} ${k}`;
}
function sftkFlowBulkIsObjectGroup(key) {
  return !/^[⏰\u{1F4E1}\u{1F5A5}⚙\u{1F9E9}\u{1F539}]/u.test(String(key || ''));
}
// Object groups first, A to Z, then the kind groups A to Z.
function sftkFlowBulkGroupSort(a, b) {
  const ao = sftkFlowBulkIsObjectGroup(a), bo = sftkFlowBulkIsObjectGroup(b);
  if (ao !== bo) return ao ? -1 : 1;
  return String(a).localeCompare(String(b));
}
// What switching a flow OFF breaks when it has no trigger of its own — said
// in the confirmation, per flow, before anything flips. '' = nothing to add.
function sftkFlowBulkOffWarning(r) {
  if (!r || r.triggered) return '';
  const k = String(r.kind || '');
  if (/^Screen/.test(k)) return 'a screen flow: switching it off breaks every button, page, quick action and link that starts it';
  if (/^Autolaunched/.test(k)) return 'no trigger of its own: switching it off breaks every flow, Apex class, process, button or integration that calls it';
  if (/^Process Builder/.test(k)) return 'a Process Builder process: it is switched off as a whole';
  return `${k}: switching it off stops it for whatever starts it`;
}

function sftkFlowBulkGroup(rows) {
  const by = new Map();
  for (const r of (rows || [])) {
    const key = sftkFlowBulkGroupKey(r);
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(r);
  }
  return [...by.entries()].map(([group, flows]) => ({ group, flows }))
    .sort((a, b) => sftkFlowBulkGroupSort(a.group, b.group));
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
      out.jobs.push({ defId: r.defId, apiName: r.apiName, label: r.label, version: 0, from: `v${r.activeVersion ?? '?'} active`,
        // A flow without a trigger of its own: what switching it off breaks.
        warn: sftkFlowBulkOffWarning(r) });
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
          triggerType: r.triggerType, triggered: !!r.triggered, processType: r.processType || '',
          object: r.object, cells: {} });
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

// ── a filter over the tick lists (2026-11-05, a colleague's first day with the
// tool: "paste one flow name from the ticket, tick it, go down a line in the
// ticket, paste the next, tick it too") ─────────────────────────────────────
// The key a row is searched by: its label and its API name, lower-cased, with
// underscores read as spaces — so a pasted label finds the row whose API name
// was derived from it, and the other way round.
function sftkFlowFilterNorm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[_\s]+/g, ' ').trim();
}
function sftkFlowFilterKey(label, apiName) {
  return [sftkFlowFilterNorm(label), sftkFlowFilterNorm(apiName)].filter(Boolean).join(' | ');
}
// Every word of the term must be in the key, in any order: "status account"
// finds "Account Status Update". An empty term matches everything.
function sftkFlowFilterHit(term, key) {
  const t = sftkFlowFilterNorm(term);
  if (!t) return true;
  const k = sftkFlowFilterNorm(key);
  return t.split(' ').every(w => k.includes(w));
}
// The line under the box. A ticked row the filter hides STAYS ticked, and is
// said here — nothing is switched blind.
function sftkFlowFilterLine(term, shown, total, hiddenTicked) {
  if (!sftkFlowFilterNorm(term)) return '';
  const base = shown === 0 ? `No flow name or API name matches “${String(term).trim()}”` : `${shown} of ${total} shown`;
  return hiddenTicked ? `${base} · ${hiddenTicked} ticked flow${hiddenTicked === 1 ? '' : 's'} hidden by the filter — still counted below` : base;
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkFlowFilterNorm = sftkFlowFilterNorm;
  globalThis.sftkFlowFilterKey  = sftkFlowFilterKey;
  globalThis.sftkFlowFilterHit  = sftkFlowFilterHit;
  globalThis.sftkFlowFilterLine = sftkFlowFilterLine;
  globalThis.sftkFlowBulkKinds = sftkFlowBulkKinds;
  globalThis.sftkFlowBulkRows  = sftkFlowBulkRows;
  globalThis.sftkFlowBulkGroup = sftkFlowBulkGroup;
  globalThis.sftkFlowKindOf = sftkFlowKindOf;
  globalThis.sftkFlowBulkGroupKey = sftkFlowBulkGroupKey;
  globalThis.sftkFlowBulkIsObjectGroup = sftkFlowBulkIsObjectGroup;
  globalThis.sftkFlowBulkGroupSort = sftkFlowBulkGroupSort;
  globalThis.sftkFlowBulkOffWarning = sftkFlowBulkOffWarning;
  globalThis.sftkFlowBulkPlan  = sftkFlowBulkPlan;
  globalThis.sftkFlowBulkMatrix = sftkFlowBulkMatrix;
}
