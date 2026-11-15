// Org Health, release QA 2026-11-14.
// 1. "Lightning pages assigned to nobody" counted FlexiPage.Metadata.pageAssignments — a key that does not
//    exist (read live 2026-10-04) — so every Home / App page and every page assigned through a Lightning app
//    came out "assigned to nobody". The card now reads the apps' own overrides (the Lightning Pages tool's
//    source), never judges a page with no object, and says "could not be checked" when the apps went unread.
// 2. "Flows pinned below the org's release" called every namespaced flow packaged, so in your own namespaced
//    dev / packaging org every flow was skipped and the card gave the good tone. Packaged is now decided by
//    ManageableState (sftkFlowIsLocked); a namespace with no readable state keeps the card off the good tone.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const F = 'studio-orghealth.js';
const SRC = readFileSync(new URL('../studio-orghealth.js', import.meta.url), 'utf8');
const OH = extractFunctions(F, ['sftkOhApiVerVerdict', 'sftkOhReadProblem', 'sftkOhAppIndex', 'sftkOhAppCount',
  'sftkOhPageState', 'sftkOhPagesVerdict', 'sftkOhPageDescribeVerdict'],
{ 'sftk-apiver.js': ['sftkApiVerNum', 'sftkApiVerLag', 'sftkFlowIsLocked'] });

describe('1. pages — app assignments are read from the Lightning apps, Home / App pages are not judged', () => {
  const app = (id, label) => ({ Id: id, DeveloperName: label, Label: label });
  const read = (meta) => ({ ok: true, body: { Metadata: meta } });
  const appsAnswer = { records: [app('02u1', 'Sales'), app('02u2', 'Service')] };
  const reads = [
    read({ actionOverrides: [{ actionName: 'View', type: 'Flexipage', content: 'Acct_App_Page', pageOrSobjectType: 'Account' }], profileActionOverrides: [] }),
    read({ actionOverrides: [], profileActionOverrides: [{ actionName: 'View', type: 'Flexipage', content: 'ns__Case_RT_Page', pageOrSobjectType: 'Case', profile: 'Admin', recordType: 'Case.Support' }] }),
  ];

  it('the reported inputs: a Home page with no object is NOT "unassigned"', () => {
    const st = OH.sftkOhPageState({ metaOk: true, assignments: 0, appsOk: true, needsProbe: false, probe: null });
    expect(st.state).toBe('notjudged');
  });

  it('the reported inputs: a record page assigned only as an app default is "assigned"', () => {
    const idx = OH.sftkOhAppIndex(appsAnswer, reads);
    expect(idx.ok).toBe(true);
    expect(OH.sftkOhAppCount(idx, 'Acct_App_Page')).toBe(1);
    expect(OH.sftkOhAppCount(idx, 'Case_RT_Page')).toBe(1);          // app + record type + profile, namespaced content
    expect(OH.sftkOhAppCount(idx, 'Other_Page')).toBe(0);
    const probe = OH.sftkOhPageDescribeVerdict({ actionOverrides: [] }, '0M0000000000001', 'Acct_App_Page', []);
    const st = OH.sftkOhPageState({ metaOk: true, assignments: OH.sftkOhAppCount(idx, 'Acct_App_Page'), appsOk: idx.ok, needsProbe: true, probe });
    expect(st.state).toBe('assigned');
  });

  it('unassigned only when the describe AND every app answered; an unread app makes it "could not be checked"', () => {
    const probe = { answered: true, isDefault: false };
    expect(OH.sftkOhPageState({ metaOk: true, assignments: 0, appsOk: true, needsProbe: true, probe }).state).toBe('unassigned');
    const part = OH.sftkOhAppIndex(appsAnswer, [reads[0], { ok: false, error: 'HTTP 500' }]);
    expect(part.ok).toBe(false);
    expect(part.error).toContain('1 of 2 Lightning app(s) could not be read (Service)');
    const st = OH.sftkOhPageState({ metaOk: true, assignments: 0, appsOk: part.ok, appsError: part.error, needsProbe: true, probe });
    expect(st.state).toBe('unread');
    expect(st.why).toContain('app assignments could not be read');
    const noList = OH.sftkOhAppIndex({ error: 'INVALID_SESSION_ID' }, []);
    expect(noList.ok).toBe(false);
    expect(OH.sftkOhPageState({ metaOk: true, assignments: 0, appsOk: noList.ok, appsError: noList.error, needsProbe: true, probe }).state).toBe('unread');
    // a missing appsOk is never taken as "every app answered"
    expect(OH.sftkOhPageState({ metaOk: true, assignments: 0, needsProbe: true, probe }).state).toBe('unread');
    // a pager that lost rows is a failed list, not an empty one
    expect(OH.sftkOhAppIndex({ records: [], incomplete: { expected: 3, got: 0 } }, []).ok).toBe(false);
  });

  it('the verdict never lists a Home / App page as assigned to nobody, nor counts it as checked', () => {
    const v = OH.sftkOhPagesVerdict([
      { label: 'Home', type: 'HomePage', state: 'notjudged' },
      { label: 'Acct', type: 'RecordPage', object: 'Account', state: 'assigned' },
    ], 0);
    expect(v.headline).not.toContain('assigned to nobody');
    expect(v.headline).toBe('Every one of the 1 Lightning page(s) checked is assigned somewhere');
    expect(v.lines.join('|')).toContain('1 Home / App page(s) not judged');
    const only = OH.sftkOhPagesVerdict([{ label: 'Home', type: 'HomePage', state: 'notjudged' }], 0);
    expect(only.tone).not.toBe('good');
    expect(only.tone).not.toBe('warn');
    expect(only.headline).toContain('not judged');
  });

  it('the card reads the Lightning apps and no longer counts pageAssignments', () => {
    expect(SRC).not.toContain('pageAssignments) ||');
    expect(SRC).toContain("SELECT Id, DeveloperName, Label FROM CustomApplication WHERE UiType = 'Lightning'");
    expect(SRC).toContain('services/data/v62.0/tooling/sobjects/CustomApplication/${encodeURIComponent(a.Id)}');
    expect(SRC).toContain('assignments: sftkOhAppCount(appIndex, x.page.DeveloperName), appsOk: appIndex.ok, appsError: appIndex.error, probe');
  });
});

describe('2. apiver — a namespace alone is not packaged', () => {
  const max = { version: '66.0', num: 66, label: "Spring '26" };
  it('the reported input: your own namespaced flow 16 releases behind is listed, never a good all-clear', () => {
    const v = OH.sftkOhApiVerVerdict(max, [{ ApiVersion: 50, ManageableState: 'unmanaged', Definition: { DeveloperName: 'Old_Flow', NamespacePrefix: 'myns' } }]);
    expect(v.tone).toBe('warn');
    expect(v.lines[0]).toBe('Old_Flow — API 50 · 16 releases behind');
    expect(v.lines.join('|')).not.toContain('installed packages');
  });
  it('the state on the definition is read too; packaging-org states stay yours', () => {
    const v = OH.sftkOhApiVerVerdict(max, [
      { ApiVersion: 50, Definition: { DeveloperName: 'Rel', NamespacePrefix: 'myns', ManageableState: 'released' } },
      { ApiVersion: 40, ManageableState: 'installed', Definition: { DeveloperName: 'Pkg', NamespacePrefix: 'npsp' } },
    ]);
    expect(v.headline).toContain('1 active flow(s) pinned');
    expect(v.lines.join('|')).toContain('Rel — API 50');
    expect(v.lines.join('|')).not.toContain('Pkg —');
    expect(v.lines.join('|')).toContain('1 active flow(s) come from installed packages');
  });
  it('the reported input with NO state read: the namespace fallback skips it but the card says so — NOT an all-clear', () => {
    const v = OH.sftkOhApiVerVerdict(max, [{ ApiVersion: 50, Definition: { DeveloperName: 'Old_Flow', NamespacePrefix: 'myns' } }]);
    expect(v.tone).toBe('warn');
    expect(v.headline).toContain('NOT an all-clear');
    expect(v.lines.join('|')).toContain('did not say whether they are installed from a package');
    expect(v.lines.join('|')).not.toContain('come from installed packages');
  });
  it('the card query selects ManageableState on the flow and its definition', () => {
    expect(SRC).toContain("SELECT Id, ApiVersion, Status, ManageableState, Definition.DeveloperName, Definition.NamespacePrefix, Definition.ManageableState FROM Flow WHERE Status = 'Active'");
  });
});
