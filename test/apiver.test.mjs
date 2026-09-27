// API VERSIONS — the org's, each flow's, and the whole subflow tree's,
// compared across orgs (user 2026-08-22: "compare api versions and change
// them of flows and their trees multi org" · "It should also compare the
// orgs api versions ofc. aand be updated when a new version is out").
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const SRC = readFileSync(new URL('../sftk-apiver.js', import.meta.url), 'utf8');

const F = extractFunctions('sftk-apiver.js', [
  'sftkApiVerNum', 'sftkApiVerList', 'sftkApiVerMax', 'sftkApiVerRelease',
  'sftkApiVerLag', 'sftkFlowVerRows', 'sftkFlowGoverningVer',
  'sftkFlowVerMatrix', 'sftkFlowTreeRoll', 'sftkApiVerPlan',
  'sftkFlowIsLocked', 'sftkApiVerSelectable',
]);

// Salesforce's real /services/data/ shape — it ships the release NAME too.
const DATA = [
  { label: "Summer '24", url: '/services/data/v61.0', version: '61.0' },
  { label: "Winter '25", url: '/services/data/v62.0', version: '62.0' },
  { label: "Spring '25", url: '/services/data/v63.0', version: '63.0' },
];

describe('reading a version number', () => {
  it('accepts every shape a version arrives in', () => {
    expect(F.sftkApiVerNum('v62.0')).toBe(62);
    expect(F.sftkApiVerNum('62.0')).toBe(62);
    expect(F.sftkApiVerNum(62)).toBe(62);
    expect(F.sftkApiVerNum('63.0')).toBe(63);
  });

  it('an unreadable version is null — never 0', () => {
    // Sorting an unknown as "oldest" would report phantom drift and put a
    // real flow at the top of an "upgrade me" list on no evidence.
    expect(F.sftkApiVerNum(null)).toBe(null);
    expect(F.sftkApiVerNum('')).toBe(null);
    expect(F.sftkApiVerNum('unknown')).toBe(null);
  });
});

describe('the org’s own ceiling — read, never assumed', () => {
  it('takes the newest version the org itself reports', () => {
    // This is the whole "be updated when a new version is out" mechanism:
    // the day the org upgrades, this returns the new number with no code
    // change anywhere.
    const max = F.sftkApiVerMax(DATA);
    expect(max.version).toBe('63.0');
    expect(max.num).toBe(63);
  });

  it('prefers Salesforce’s OWN release name over any formula', () => {
    expect(F.sftkApiVerMax(DATA).label).toBe("Spring '25");
  });

  it('derives a name only when the org did not give one', () => {
    const max = F.sftkApiVerMax([{ version: '62.0' }]);
    expect(max.label).toBe("Winter '25");
  });

  it('sorts newest first regardless of the order received', () => {
    const list = F.sftkApiVerList([{ version: '58.0' }, { version: '63.0' }, { version: '60.0' }]);
    expect(list.map(v => v.num)).toEqual([63, 60, 58]);
  });

  it('survives an empty or malformed payload without inventing a version', () => {
    expect(F.sftkApiVerMax([])).toBe(null);
    expect(F.sftkApiVerMax(null)).toBe(null);
    expect(F.sftkApiVerList([{ version: 'garbage' }])).toEqual([]);
  });

  it('the derived release name walks the three-a-year cycle both ways', () => {
    expect(F.sftkApiVerRelease(62)).toBe("Winter '25");
    expect(F.sftkApiVerRelease(63)).toBe("Spring '25");
    expect(F.sftkApiVerRelease(64)).toBe("Summer '25");
    expect(F.sftkApiVerRelease(65)).toBe("Winter '26");
    expect(F.sftkApiVerRelease(61)).toBe("Summer '24");
    expect(F.sftkApiVerRelease(59)).toBe("Winter '24");
  });
});

describe('how far behind a flow is', () => {
  it('counts releases, which is also an age — three per year', () => {
    expect(F.sftkApiVerLag('56.0', '62.0')).toBe(6);
    expect(F.sftkApiVerLag('62.0', '62.0')).toBe(0);
  });

  it('never reports a negative lag, and never guesses at unknowns', () => {
    expect(F.sftkApiVerLag('64.0', '62.0')).toBe(0);
    expect(F.sftkApiVerLag(null, '62.0')).toBe(null);
    expect(F.sftkApiVerLag('62.0', null)).toBe(null);
  });
});

describe('collapsing flow versions into one row per flow', () => {
  const RECS = [
    { Id: 'a1', MasterLabel: 'Route', VersionNumber: 1, Status: 'Obsolete', ApiVersion: '55.0', ProcessType: 'AutoLaunchedFlow', Definition: { DeveloperName: 'Route_to_ESA' } },
    { Id: 'a2', MasterLabel: 'Route', VersionNumber: 2, Status: 'Active', ApiVersion: '58.0', ProcessType: 'AutoLaunchedFlow', Definition: { DeveloperName: 'Route_to_ESA' } },
    { Id: 'a3', MasterLabel: 'Route', VersionNumber: 3, Status: 'Draft', ApiVersion: '62.0', ProcessType: 'AutoLaunchedFlow', Definition: { DeveloperName: 'Route_to_ESA' } },
    { Id: 'b1', MasterLabel: 'Sessions', VersionNumber: 1, Status: 'Draft', ApiVersion: '61.0', Definition: { DeveloperName: 'Get_Sessions' } },
  ];

  it('keeps the ACTIVE and the LATEST version apart', () => {
    const rows = F.sftkFlowVerRows(RECS);
    const route = rows.find(r => r.apiName === 'Route_to_ESA');
    expect(route.active.apiVersion).toBe('58.0');
    expect(route.latest.apiVersion).toBe('62.0');
    expect(route.versions).toBe(3);
  });

  it('the GOVERNING version is the active one — that is what runs', () => {
    // Upgrading the latest draft while an older version is active is a
    // silent no-op: the org keeps running the old semantics.
    const rows = F.sftkFlowVerRows(RECS);
    const route = rows.find(r => r.apiName === 'Route_to_ESA');
    expect(F.sftkFlowGoverningVer(route).apiVersion).toBe('58.0');
    expect(F.sftkFlowGoverningVer(route).status).toBe('Active');
  });

  it('falls back to the latest when nothing is active', () => {
    const rows = F.sftkFlowVerRows(RECS);
    const sessions = rows.find(r => r.apiName === 'Get_Sessions');
    expect(sessions.active).toBe(null);
    expect(F.sftkFlowGoverningVer(sessions).apiVersion).toBe('61.0');
    expect(F.sftkFlowGoverningVer(sessions).status).toBe('Draft');
  });

  it('is sorted and ignores rows with no identity', () => {
    const rows = F.sftkFlowVerRows([...RECS, {}, { Id: 'x' }]);
    expect(rows.map(r => r.apiName)).toEqual(['Get_Sessions', 'Route_to_ESA']);
  });
});

describe('the multi-org matrix', () => {
  const ORGS = [
    { key: 'src', label: 'Source', maxVersion: '62.0' },
    { key: 'uat', label: 'UAT', maxVersion: '62.0' },
    { key: 'dev', label: 'Dev', maxVersion: '63.0' },
  ];
  const rowsByOrg = {
    src: F.sftkFlowVerRows([{ Id: 's', VersionNumber: 1, Status: 'Active', ApiVersion: '62.0', Definition: { DeveloperName: 'Route' } }]),
    uat: F.sftkFlowVerRows([{ Id: 'u', VersionNumber: 1, Status: 'Active', ApiVersion: '55.0', Definition: { DeveloperName: 'Route' } }]),
    dev: F.sftkFlowVerRows([{ Id: 'd', VersionNumber: 1, Status: 'Active', ApiVersion: '62.0', Definition: { DeveloperName: 'Other' } }]),
  };
  const m = F.sftkFlowVerMatrix(ORGS, rowsByOrg);

  it('flags a flow whose governing version differs between orgs', () => {
    const route = m.find(r => r.apiName === 'Route');
    expect(route.drift).toBe(true);
    expect(route.versions).toEqual(['55.0', '62.0']);
  });

  it('reports ABSENCE as its own fact, not as version drift', () => {
    // Calling a partial rollout "drifted" would bury the real drift.
    const route = m.find(r => r.apiName === 'Route');
    expect(route.missingIn).toEqual(['dev']);
    expect(route.cells.dev.missing).toBe(true);
    const other = m.find(r => r.apiName === 'Other');
    expect(other.drift).toBe(false);
    expect(other.missingIn.sort()).toEqual(['src', 'uat']);
  });

  it('lags are measured against EACH org’s own ceiling', () => {
    const route = m.find(r => r.apiName === 'Route');
    expect(route.cells.src.lag).toBe(0);
    expect(route.cells.uat.lag).toBe(7);
  });

  it('lists every flow found in any org, sorted', () => {
    expect(m.map(r => r.apiName)).toEqual(['Other', 'Route']);
  });
});

describe('rolling a subflow TREE up to one number', () => {
  const EDGES = { A: ['B', 'C'], B: ['D'], C: [], D: [] };
  const VERS = { A: 62, B: 58, C: 62, D: 61 };

  it('a tree is only as current as the OLDEST thing it calls', () => {
    const roll = F.sftkFlowTreeRoll('A', EDGES, n => VERS[n]);
    expect(roll.oldest).toBe(58);
    expect(roll.members).toBe(4);
  });

  it('counts what it could not read instead of ignoring it', () => {
    const roll = F.sftkFlowTreeRoll('A', EDGES, n => (n === 'D' ? null : VERS[n]));
    expect(roll.unknown).toBe(1);
    expect(roll.oldest).toBe(58);
  });

  it('a subflow cycle is walked once, never followed twice', () => {
    const cyc = { A: ['B'], B: ['A'] };
    const roll = F.sftkFlowTreeRoll('A', cyc, () => 62);
    expect(roll.members).toBe(2);
    expect(roll.names.sort()).toEqual(['A', 'B']);
  });

  it('a leaf with no edges is still a tree of one', () => {
    expect(F.sftkFlowTreeRoll('Z', {}, () => 60)).toMatchObject({ oldest: 60, members: 1 });
  });
});

describe('planning a change before writing one', () => {
  const ORGS = [
    { key: 'src', maxVersion: '62.0' },
    { key: 'old', maxVersion: '60.0' },
    { key: 'same', maxVersion: '62.0' },
    { key: 'gone', maxVersion: '62.0' },
  ];
  const CELLS = {
    src: { apiVersion: '55.0', num: 55, id: '301src', status: 'Active' },
    old: { apiVersion: '55.0', num: 55, id: '301old', status: 'Active' },
    same: { apiVersion: '62.0', num: 62, id: '301same', status: 'Active' },
    gone: { missing: true },
  };

  it('names what it will change, from and to', () => {
    const plan = F.sftkApiVerPlan('62.0', ORGS, CELLS);
    expect(plan.applicable).toEqual([
      { orgKey: 'src', from: '55.0', to: '62.0', flowVersionId: '301src', status: 'Active' },
    ]);
  });

  it('refuses an org whose release cannot hold the target — with the reason', () => {
    // An org on Spring '24 physically cannot save a flow at Winter '25.
    const plan = F.sftkApiVerPlan('62.0', ORGS, CELLS);
    expect(plan.blocked.find(b => b.orgKey === 'old').why).toContain('60.0');
  });

  it('an absent flow is blocked, not silently skipped', () => {
    const plan = F.sftkApiVerPlan('62.0', ORGS, CELLS);
    expect(plan.blocked.find(b => b.orgKey === 'gone').why).toContain('does not exist');
  });

  it('an org already at the target is a no-op, counted separately', () => {
    const plan = F.sftkApiVerPlan('62.0', ORGS, CELLS);
    expect(plan.noop).toEqual([{ orgKey: 'same' }]);
  });

  it('with no target chosen nothing is applicable', () => {
    const plan = F.sftkApiVerPlan(null, ORGS, CELLS);
    expect(plan.applicable).toEqual([]);
    expect(plan.blocked).toHaveLength(4);
  });
});

describe('the library states the distinction it exists to protect', () => {
  it('separates ORG version from FLOW version in its own header', () => {
    // These two get conflated constantly, and conflating them produces
    // confident wrong answers ("the org is upgraded, so the flows are").
    expect(SRC).toContain("The ORG's API version is the release it runs");
    expect(SRC).toContain("A FLOW's API version is the version its behaviour is pinned to");
  });

  it('hard-codes no version and no release name', () => {
    const body = SRC.slice(SRC.indexOf('function sftkApiVerNum'));
    expect(body).not.toMatch(/['"]v?6[0-9]\.0['"]/);
  });
});

// ── How the panel USES all of the above ────────────────────────────────
describe('the multi-org API version panel', () => {
  const DEP = readFileSync(new URL('../dependency-map.js', import.meta.url), 'utf8');
  const codeOnly = DEP.replace(/^\s*\/\/.*$/gm, '');

  it('reads each org’s release FROM the org, hard-coding nothing', () => {
    // "be updated when a new version is out" is only true if no version
    // string lives in this code path.
    expect(DEP).toContain("path: 'services/data/'");
    expect(DEP).toContain('sftkApiVerMax(r)');
    const panel = DEP.slice(DEP.indexOf('API VERSIONS, ACROSS ORGS'), DEP.indexOf('function renderCrossOrgResult'));
    expect(panel).not.toMatch(/['"]v?6[0-9]\.0['"]/);
  });

  it('asks for ApiVersion in the flow query', () => {
    expect(DEP).toMatch(/SELECT Id,MasterLabel,Definition\.DeveloperName,VersionNumber,Status,ApiVersion,ProcessType FROM Flow/);
  });

  it('an org that could not be read is UNREAD, never "has no flows"', () => {
    expect(DEP).toContain('never as "has no flows"');
    expect(DEP).toContain('its lag column stays UNKNOWN');
  });

  it('single-org (2026-09-14): the summary states the release THIS org runs, and lag is against it', () => {
    expect(DEP).toContain("runs API ${escHtml(o0.maxVersion)}");
    expect(DEP).toContain('behind the org release');
  });

  it('changing a version is gated: typed confirmation + behaviour warning', () => {
    // Campaign 3 phase 2: moved into the shared sftkConfirmDestructive dialog
    // (sftk-confirm.js) — the typed word is now that dialog's own gate.
    expect(DEP).toContain("typedWord: 'CHANGE'");
    expect(DEP).toContain('sftkConfirmDestructive(');
    expect(DEP).toContain('flow behaviour can differ between API versions');
    expect(DEP).toContain('this is a functional change, not a label');
    // and what a deploy actually DOES to an active flow
    expect(DEP).toContain('the previous one becomes Obsolete');
  });

  it('discloses that each org’s package is all-or-nothing', () => {
    // rollbackOnError makes it so; hiding that would let a user think a
    // partial failure left some flows changed.
    expect(DEP).toContain('all-or-nothing');
    expect(DEP).toContain("none of that org's flows change");
  });

  it('bulk reads go through the batch primitive, like the scan', () => {
    expect(codeOnly).toMatch(/type: 'SF_COMPOSITE_BATCH'[\s\S]{0,200}tooling\/sobjects\/Flow/);
    expect(codeOnly).not.toMatch(/type:\s*'SF_GET_METADATA'/);
  });

  it('refuses to deploy a package built from a partial read', () => {
    // A package missing a flow would leave it behind while reporting
    // success for the rest.
    expect(DEP).toContain('refusing to deploy a partial package');
  });

  it('tells the user the table is STALE after a change', () => {
    expect(DEP).toContain('is now STALE');
  });
});

describe('⚙ apply — what a checkOnly deploy against a real org taught us (2026-09-03)', () => {
  const DEP = readFileSync(new URL('../dependency-map.js', import.meta.url), 'utf8');
  const fn = DEP.slice(DEP.indexOf('async function avVerifyAndActivate'), DEP.indexOf('function renderCrossOrgResult'));

  it('stamps the package with the ORG\u2019s API version, and refuses rather than falls back to the target', () => {
    // package 62.0 + a flow carrying a 63.0 property → "Property … not valid in version 62.0"
    expect(fn).toContain('sftkFlowPackageXml(members, org.maxVersion)');
    expect(fn).not.toContain('org.maxVersion || target');
    expect(fn).toMatch(/if \(!org\.maxVersion\) \{ orgsFailed\+\+;/);
  });

  it('never says "activated" from the deploy result — it re-reads the org, activates where needed, and re-reads again', () => {
    expect(fn).toContain('const verdicts = await avVerifyAndActivate(org, changed, target, say)');
    expect(fn).not.toContain('(new version activated)');
    expect(fn).toMatch(/tooling\/sobjects\/FlowDefinition\/\$\{c\.defId\}/);
    expect(fn).toMatch(/Metadata: \{ activeVersionNumber: newest\.versionNumber \}/);
    expect(fn).toContain('verified by re-reading the org');
    expect(fn).toContain('treat this change as UNVERIFIED');
    expect(fn).toContain('could NOT be activated');
  });

  it('the confirmation no longer promises what the deploy alone cannot do', () => {
    expect(DEP).toContain('re-reads the org to confirm what is running');
    expect(DEP).not.toContain('where the flow is Active the new version is activated and the previous one becomes Obsolete');
  });
});


// 2026-09-14 (user: "you tell me what is wrong here") — the panel could change
// API versions but still called itself read-only, and "This org" did not say
// which org it was.
describe('the ⚙ panel tells the truth about writing, and names the current org', () => {
  const DEP = readFileSync(new URL('../dependency-map.js', import.meta.url), 'utf8');
  it('never says read-only', () => {
    const panel = DEP.slice(DEP.indexOf('function renderApiVerPanel(mount, orgUrl)'), DEP.indexOf('async function runApiVerCompare('));
    expect(panel).not.toMatch(/read-only/i);
    expect(panel).toContain('Comparing changes nothing');
    expect(DEP).not.toMatch(/id="depApiVerBtn" title="Read-only/);
  });
  it('the current org is named, not just "This org"', () => {
    expect(DEP).toContain('label: `This org (${depHost(orgUrl)})`, online: true, isCurrent: true');
    // single org: the "apply here" box is hidden and always on (2026-09-14 UI pass)
    expect(DEP).toContain("class=\"dep-fb-applyorg\" value=\"${escHtml(o.key)}\" ${o.toolingDown ? 'disabled' : 'checked'}");
  });
});

// 2026-09-14 (user: "you can still compare against other orgs" — that was
// what was wrong). ⚙ and ⏻ work on the connected org only; the org pickers
// and the org-list loader are gone.
describe('⚙ and ⏻ are single-org', () => {
  const DEP = readFileSync(new URL('../dependency-map.js', import.meta.url), 'utf8');
  it('no org picker, no org-list loader', () => {
    expect(DEP).not.toContain('dep-av-org');
    expect(DEP).not.toContain('dep-fb-org"');
    expect(DEP).not.toContain('depLoadOrgs(');
    expect(DEP).not.toContain('_xoOrgs');
    expect(DEP).not.toContain('Pick at least two orgs');
    expect(DEP).not.toContain('Not enough orgs could be read');   // the post-read two-org check went too (user screenshot 2026-09-14)
    expect(DEP).toContain("if (!orgs.length) {");
  });
  it('both panels build their org list from the connected org alone', () => {
    expect(DEP).toContain('const all = [{ orgUrl, sid: _scanSid || _lastSid, label: `This org (${depHost(orgUrl)})`, online: true, isCurrent: true }];');
    expect(DEP).toContain('const all = [{ orgUrl, sid: _scanSid || _lastSid, label: `This org (${depHost(orgUrl)})`, isCurrent: true }];');
    expect(DEP).toContain('const picked = _avOrgsAll.filter(Boolean);   // this org only');
    expect(DEP).toContain('const picked = _fbOrgsAll.filter(Boolean);');
  });
  it('the words say this org, not across orgs', () => {
    const ui = DEP.replace(/^[ 	]*\/\/.*$/gm, '');   // comments may tell the history; the UI must not
    expect(ui).not.toMatch(/Flow switches — across orgs|API versions across orgs|ACROSS ORGS/);
    expect(DEP).toContain('⏻ Flow switches — ${escHtml(depHost(orgUrl))}');
    expect(DEP).toContain('⚙ API versions — ${escHtml(depHost(orgUrl))}');
  });
});


// 2026-09-14 (user: "why do we need the compare button? … load both on load")
describe('⚙ and ⏻ load the moment they open', () => {
  const DEP = readFileSync(new URL('../dependency-map.js', import.meta.url), 'utf8');
  it('no Compare / Load flows buttons — the panels run on open', () => {
    expect(DEP).not.toContain('id="depAvGo"');
    expect(DEP).not.toContain('id="depFbLoad"');
    const av = DEP.slice(DEP.indexOf('function renderApiVerPanel(mount, orgUrl)'), DEP.indexOf('let _avOrgsAll'));
    expect(av).toContain('runApiVerCompare(mount);');
    const fb = DEP.slice(DEP.indexOf('function renderFlowBulkPanel(mount, orgUrl)'), DEP.indexOf('let _fbOrgsAll'));
    expect(fb).toContain('loadFlowBulk(mount);');
  });
  it('a switch run offers a one-click reload instead of pointing at a button that is gone', () => {
    expect(DEP).toContain('id="depFbReload"');
    expect(DEP).not.toContain('Press 🔍 Load flows again');
    expect(DEP).not.toContain('Compare again to re-read the orgs');
  });
});


// 2026-09-21 — user: "can we suggest the user to update them all in bulk to the
// latest?" / "the user must not be able to select flows that api version can't
// be modified like package flows, etc" / "check if there's more scenarios".
// Measured on trailheads2: 239 definitions, 177 ManageableState = installed.
describe('a flow that cannot be changed cannot be ticked', () => {
  const AVSRC = readFileSync(new URL('../sftk-apiver.js', import.meta.url), 'utf8');
  const DEP2 = readFileSync(new URL('../dependency-map.js', import.meta.url), 'utf8');
  it('locked = the platform says installed; a namespace alone is only the fallback', () => {
    expect(F.sftkFlowIsLocked({ ManageableState: 'installed', NamespacePrefix: 'npsp' })).toBe(true);
    expect(F.sftkFlowIsLocked({ ManageableState: 'unmanaged', NamespacePrefix: 'myns' })).toBe(false);   // your own namespaced org
    expect(F.sftkFlowIsLocked({ ManageableState: 'installedEditable', NamespacePrefix: 'x' })).toBe(false);
    expect(F.sftkFlowIsLocked({ ManageableState: 'released', NamespacePrefix: 'x' })).toBe(false);        // packaging org
    expect(F.sftkFlowIsLocked({ NamespacePrefix: 'npsp' })).toBe(true);                                   // state unread → fall back
    expect(F.sftkFlowIsLocked({})).toBe(false);
  });
  it('one rule says why: absent, managed, invalid draft, no record id', () => {
    expect(F.sftkApiVerSelectable({ missing: true }).ok).toBe(false);
    expect(F.sftkApiVerSelectable({ managed: true, id: '301x' }).why).toContain('managed package');
    expect(F.sftkApiVerSelectable({ status: 'InvalidDraft', id: '301x' }).why).toContain('invalid draft');
    expect(F.sftkApiVerSelectable({ status: 'Active', id: null }).why).toContain('no record id');
    expect(F.sftkApiVerSelectable({ status: 'Active', id: '301x' })).toEqual({ ok: true, why: '' });
    expect(F.sftkApiVerSelectable({ status: 'Obsolete', id: '301x' }).ok).toBe(true);   // a deactivated flow is still yours
  });
  it('the plan refuses with the same reasons', () => {
    const orgs = [{ key: 'a', maxVersion: '67.0' }];
    expect(F.sftkApiVerPlan('67.0', orgs, { a: { managed: true, id: '301', num: 60 } }).blocked[0].why).toContain('managed package');
    expect(F.sftkApiVerPlan('67.0', orgs, { a: { status: 'InvalidDraft', id: '301', num: 60 } }).blocked[0].why).toContain('invalid draft');
    expect(F.sftkApiVerPlan('67.0', orgs, { a: { status: 'Active', id: '301', num: 60, apiVersion: '60.0' } }).applicable).toHaveLength(1);
  });
  it('the read asks Salesforce for ManageableState on both views', () => {
    expect(DEP2).toContain('NamespacePrefix, ManageableState, TriggerType');
    expect(DEP2).toContain('FlowDefinitionView.ManageableState');
    expect(DEP2).toContain('ManageableState: d.ManageableState || null,');
    expect(AVSRC).toContain('managed: sftkFlowIsLocked(r),');
  });
  it('the row is disabled with its reason, and a disabled box is never read as ticked', () => {
    expect(DEP2).toContain("${can.ok ? '' : 'disabled'}>");
    expect(DEP2).toContain('Cannot be changed here: ${escHtml(can.why)}');
    expect(DEP2).toContain('.filter(cb => cb.checked && !cb.disabled)');
    expect(DEP2).toContain('cb.checked = !cb.disabled && fixable.some(d => d.apiName === cb.value);');
  });
  it('the bulk suggestion counts only what can be changed and goes THROUGH the confirmation', () => {
    expect(DEP2).toContain('const fixable = behind.filter(r => canOf(r).ok);');
    expect(DEP2).toContain('id="depAvUpdateAll"');
    const i = DEP2.indexOf("out.querySelector('#depAvUpdateAll')?.addEventListener('click', () => {");
    const h = DEP2.slice(i, i + 420);
    expect(h).toContain('tickFixable();');
    expect(h).toContain('sel.value = o0.maxVersion;');
    expect(h).toContain('confirmApiVerChange(out);');
    expect(h).not.toContain('applyApiVerChange(');
  });
});
