// ⏻ FLOW SWITCHES — bulk activate/deactivate for triggered flows (user
// 2026-08-30: "select and disable, activate flows in bulk, by object …
// only on triggered flows … also for scheduled flows … built upon flow
// dependency"). The part worth testing hard is the way BACK: Salesforce
// activates a VERSION, and blindly activating the latest can run logic
// that was never live — so deactivation remembers, reactivation restores.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const DEP = readFileSync(new URL('../dependency-map.js', import.meta.url), 'utf8');

const F = extractFunctions('sftk-flowbulk.js', [
  'sftkFlowBulkKinds', 'sftkFlowBulkRows', 'sftkFlowBulkGroup', 'sftkFlowBulkPlan',
  'sftkFlowBulkMatrix',
]);

const VIEW = [
  { ApiName: 'Route', Label: 'Route to ESA', IsActive: true, TriggerType: 'RecordAfterSave', TriggerObjectOrEventLabel: 'Case' },
  { ApiName: 'Guard', Label: 'Guard', IsActive: true, TriggerType: 'RecordBeforeSave', TriggerObjectOrEventLabel: 'Case' },
  { ApiName: 'Nightly', Label: 'Nightly Sync', IsActive: false, TriggerType: 'Scheduled', TriggerObjectOrEventLabel: '' },
  { ApiName: 'Screen1', Label: 'A screen flow', IsActive: true, TriggerType: null },
  { ApiName: 'Sub1', Label: 'A subflow', IsActive: true, TriggerType: '' },
  { ApiName: 'Orphan', Label: 'No def', IsActive: true, TriggerType: 'RecordAfterSave', TriggerObjectOrEventLabel: 'Lead' },
];
// PLAIN definition fields only — the ActiveVersion.VersionNumber Tooling
// traversal failed live (2026-08-31: every flow rendered "not togglable"),
// so version numbers now ride in from the Flow query as versByApi.
const DEFS = [
  { Id: '300A', DeveloperName: 'Route' },
  { Id: '300B', DeveloperName: 'Guard' },
  { Id: '300C', DeveloperName: 'Nightly' },
];
const VERS = {
  Route: { active: 3, latest: 5 },
  Guard: { active: 1, latest: 1 },
  Nightly: { active: null, latest: 7 },
};
const ROWS = F.sftkFlowBulkRows(VIEW, DEFS, VERS);

describe('which flows this touches', () => {
  it('covers record-triggered, scheduled and platform-event kinds', () => {
    const kinds = F.sftkFlowBulkKinds();
    expect(Object.keys(kinds).sort()).toEqual(
      ['PlatformEvent', 'RecordAfterSave', 'RecordBeforeDelete', 'RecordBeforeSave', 'Scheduled']);
  });

  it('excludes screen flows and subflows — they have no switch worth flipping', () => {
    expect(ROWS.map(r => r.apiName)).not.toContain('Screen1');
    expect(ROWS.map(r => r.apiName)).not.toContain('Sub1');
  });

  it('keeps a flow the Tooling API cannot see — visible but not togglable', () => {
    // Silently dropping it would read as "this org has no such flow".
    const orphan = ROWS.find(r => r.apiName === 'Orphan');
    expect(orphan).toBeTruthy();
    expect(orphan.defId).toBe(null);
  });

  it('joins the active and latest version numbers per flow', () => {
    const route = ROWS.find(r => r.apiName === 'Route');
    expect(route.activeVersion).toBe(3);
    expect(route.latestVersion).toBe(5);
    expect(route.defId).toBe('300A');
  });

  it('a managed row as FlowDefinitionView REALLY returns it (ApiName without prefix + NamespacePrefix) keys as ns__Name', () => {
    // Live shape 2026-09-03: { ApiName: 'CompleteApplication', NamespacePrefix: 'PgmApps' }.
    const rows = F.sftkFlowBulkRows(
      [{ ApiName: 'CompleteApplication', NamespacePrefix: 'PgmApps', Label: 'Complete Application', IsActive: true, TriggerType: 'RecordAfterSave', TriggerObjectOrEventLabel: 'Application' }],
      [{ Id: '300P', DeveloperName: 'CompleteApplication', NamespacePrefix: 'PgmApps' }],
      { PgmApps__CompleteApplication: { active: 1, latest: 1 } });
    expect(rows[0].apiName).toBe('PgmApps__CompleteApplication');
    expect(rows[0].defId).toBe('300P');
    expect(rows[0].activeVersion).toBe(1);
    expect(rows[0].managed).toBe(true);
  });

  it('a namespaced definition still joins its prefixed ApiName', () => {
    // Managed/feature flows arrive as ns__Name in FlowDefinitionView while
    // the definition carries DeveloperName + NamespacePrefix separately.
    const rows = F.sftkFlowBulkRows(
      [{ ApiName: 'acme__Foo', Label: 'Foo', IsActive: true, TriggerType: 'RecordAfterSave', TriggerObjectOrEventLabel: 'Account' }],
      [{ Id: '300N', DeveloperName: 'Foo', NamespacePrefix: 'acme' }],
      { acme__Foo: { active: 2, latest: 2 } });
    expect(rows[0].defId).toBe('300N');
    expect(rows[0].activeVersion).toBe(2);
  });
});

describe('grouping — the axis the admin works on', () => {
  it('record-triggered flows group by OBJECT, scheduled by kind', () => {
    const groups = F.sftkFlowBulkGroup(ROWS);
    const names = groups.map(g => g.group);
    expect(names).toContain('Case');
    expect(names).toContain('Lead');
    expect(names.some(n => n.includes('Scheduled'))).toBe(true);
    expect(groups.find(g => g.group === 'Case').flows).toHaveLength(2);
  });
});

describe('the plan — decided before anything flips', () => {
  it('deactivation takes only ACTIVE flows and remembers their versions', () => {
    const plan = F.sftkFlowBulkPlan(ROWS, ['Route', 'Guard', 'Nightly', 'Orphan'], 'deactivate', {});
    expect(plan.jobs.map(j => j.apiName).sort()).toEqual(['Guard', 'Route']);
    expect(plan.jobs.every(j => j.version === 0)).toBe(true);
    // THE memory: what was live, per flow, so the way back is exact.
    expect(plan.remember).toEqual({ Route: 3, Guard: 1 });
    expect(plan.skipped.find(x => x.apiName === 'Nightly').why).toBe('already inactive');
    expect(plan.skipped.find(x => x.apiName === 'Orphan').why).toContain('Tooling API');
  });

  it('reactivation restores the REMEMBERED version, not the latest', () => {
    const plan = F.sftkFlowBulkPlan(ROWS, ['Nightly'], 'activate', { Nightly: 4 });
    expect(plan.jobs[0].version).toBe(4);
    expect(plan.jobs[0].from).toContain('restores v4');
  });

  it('falls back to LATEST only when nothing is remembered — and says so', () => {
    // Activating latest can run logic that was never live; the plan line
    // must carry that warning, per flow.
    const plan = F.sftkFlowBulkPlan(ROWS, ['Nightly'], 'activate', {});
    expect(plan.jobs[0].version).toBe(7);
    expect(plan.jobs[0].from).toContain('LATEST');
    expect(plan.jobs[0].from).toContain('may differ from what previously ran');
  });

  it('never activates what is already active', () => {
    const plan = F.sftkFlowBulkPlan(ROWS, ['Route'], 'activate', {});
    expect(plan.jobs).toEqual([]);
    expect(plan.skipped[0].why).toBe('already active');
  });

  it('an unpicked flow is untouched, junk input plans nothing', () => {
    expect(F.sftkFlowBulkPlan(ROWS, [], 'deactivate', {}).jobs).toEqual([]);
    expect(F.sftkFlowBulkPlan(null, ['Route'], 'deactivate', {}).jobs).toEqual([]);
  });
});

describe('the panel keeps the project laws', () => {
  it('flips via the documented Tooling PATCH, one flow at a time', () => {
    expect(DEP).toMatch(/tooling\/sobjects\/FlowDefinition\/\$\{j\.defId\}/);
    expect(DEP).toMatch(/Metadata: \{ activeVersionNumber: j\.version \}/);
  });

  it('states the org-wide consequence BEFORE deactivating', () => {
    // In-panel typed gate (audit 2026-09-12): the consequence is the first
    // line of the confirmation, not a browser confirm() string.
    expect(DEP).toContain('automation <strong>stops for EVERYONE</strong> in this org');
    expect(DEP).toContain('never retroactively processed');
  });

  it('remembers versions only for flows the org CONFIRMED were flipped', () => {
    // A failed flip must not overwrite the memory of what was truly active.
    expect(DEP).toMatch(/const okNames = new Set\(done\.map\(j => j\.apiName\)\)/);
  });

  it('forgets a remembered version once the flow is back on', () => {
    expect(DEP).toMatch(/for \(const j of done\) delete m\[j\.apiName\]/);
  });

  it('admits the result list is stale after flipping', () => {
    expect(DEP).toContain('This table is now stale');
    expect(DEP).toContain('id="depFbReload"');   // …and offers the reload right there (2026-09-14)
  });

  it('the compare-screen push previews current \u2192 new before writing', () => {
    const SCAN = readFileSync(new URL('../studio-scan.js', import.meta.url), 'utf8');
    expect(SCAN).toContain('data-dcp-cur');
    expect(SCAN).toContain('data-dcp-new');
    expect(SCAN).toMatch(/will point at/);
    expect(SCAN).toMatch(/Update \$\{picks\.length\} field\(s\) on this target record\?/);
  });
});

// ── Clickable flows (user 2026-09-01: "make the flows clickable that will
// open them in the org") — every state cell opens THAT org's Flow Builder;
// the label opens the first org that has the flow. ──────────────────────
describe('flows are clickable, per org', () => {
  it('rows and matrix cells carry the version ids a link needs', () => {
    const rows = F.sftkFlowBulkRows(VIEW, DEFS, { Route: { active: 3, latest: 5, activeId: '301A', latestId: '301B' } });
    const route = rows.find(r => r.apiName === 'Route');
    expect(route.activeId).toBe('301A');
    expect(route.latestId).toBe('301B');
    const m = F.sftkFlowBulkMatrix([{ key: 'o1', label: 'One' }], { o1: rows }, {});
    expect(m.find(r => r.apiName === 'Route').cells.o1.activeId).toBe('301A');
  });

  it('one URL builder serves both panels, and never guesses a URL', () => {
    expect(DEP).toContain('function depFlowOpenUrl(orgUrl, versionId, defId)');
    expect(DEP).toContain('flowBuilder.app?flowId=');
    expect(DEP).toContain('flowBuilder.app?flowDefId=');
    // no id at all → no link, rather than a link to an error page
    const fn = DEP.slice(DEP.indexOf('function depFlowOpenUrl'), DEP.indexOf('function depWireOpenLinks'));
    expect(fn).toContain("if (defId) return");
    expect(fn.trim().endsWith("return '';\n  }") || fn.includes("return '';")).toBe(true);
  });

  it('cells and labels in BOTH panels open through the popup’s tabs convention', () => {
    expect(DEP).toContain('function depWireOpenLinks(container)');
    expect(DEP).toMatch(/chrome\.tabs\.create\(\{ url \}\)/);
    // switches: cell + label
    expect(DEP).toMatch(/class="dep-fb-open" data-open-url=/);
    // api versions: cell + label
    expect(DEP).toMatch(/const openUrl = depFlowOpenUrl\(o\.orgUrl, c\.id, null\)/);
    expect(DEP).toContain('const avLabelUrl = r =>');
    expect((DEP.match(/depWireOpenLinks\((body|out)\)/g) || []).length).toBe(2);
  });
});


// 2026-09-14 (user: "the user can select flows who are inactive here")
describe('selection knows each flow\'s state', () => {
  const panel = DEP.slice(DEP.indexOf('function renderFlowBulkMatrix(body)'), DEP.indexOf('async function runFlowBulk(body, mode)'));
  it('every checkbox carries on/off, and the group buttons pick by state', () => {
    expect(panel).toContain('data-on="${fbStateOf(f)}"');
    expect(panel).toContain('data-want="on"');
    expect(panel).toContain('data-want="off"');
    expect(panel).toMatch(/c\.dataset\.grp === b\.dataset\.grp && c\.dataset\.on === b\.dataset\.want/);
  });
  it('the action buttons count only what they would switch, and are disabled at zero', () => {
    expect(panel).toContain("off.disabled = !nOn;");
    expect(panel).toContain("on.disabled = !nOff;");
    expect(panel).toContain('Switch OFF (${nOn} ON selected)');
    expect(panel).toContain('Switch ON (${nOff} OFF selected)');
  });
  it('a run acts only on the ticked flows in the right state', () => {
    const run = DEP.slice(DEP.indexOf('async function runFlowBulk(body, mode)'), DEP.indexOf('async function applyFlowBulk('));
    expect(run).toContain("const want = mode === 'deactivate' ? 'on' : 'off';");
    expect(run).toContain("c.checked && c.dataset.on === want");
  });
});
