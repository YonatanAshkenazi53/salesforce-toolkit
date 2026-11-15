// ⚙ API versions — release QA 2026-11-14: an ACTIVE flow that also has a
// NEWER Draft (active v3, Draft v4). The plan rewrote v3 and deployed it
// under the flow's name; Salesforce overwrites the latest inactive version
// in place, so the user's Draft v4 got v3's content, was then activated as
// if new, and Undo deleted it. Now: the plan refuses such a flow with the
// reason, and avVerifyAndActivate never takes a pre-existing version for new.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunctions } from './extract.mjs';

const F = extractFunctions('sftk-apiver.js', [
  'sftkApiVerNum', 'sftkApiVerLag', 'sftkFlowVerRows', 'sftkFlowGoverningVer',
  'sftkFlowVerMatrix', 'sftkApiVerPlan', 'sftkFlowIsLocked', 'sftkApiVerSelectable',
]);
const DEP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'dependency-map.js'), 'utf8');

const REC = (Id, VersionNumber, Status, ApiVersion) => ({ Id, VersionNumber, Status, ApiVersion, Definition: { DeveloperName: 'Route' } });
const ORGS = [{ key: 'a', label: 'A', maxVersion: '62.0' }];

describe('the plan refuses an active flow with a newer Draft', () => {
  const m = F.sftkFlowVerMatrix(ORGS, { a: F.sftkFlowVerRows([REC('301v3', 3, 'Active', '58.0'), REC('301v4', 4, 'Draft', '58.0')]) });
  const cell = m[0].cells.a;

  it('the cell names the newer inactive version', () => {
    expect(cell.versionNumber).toBe(3);
    expect(cell.newerInactive).toEqual({ versionNumber: 4, status: 'Draft' });
  });
  it('it is not selectable, with the reason', () => {
    const s = F.sftkApiVerSelectable(cell);
    expect(s.ok).toBe(false);
    expect(s.why).toContain('newer Draft version (v4)');
    expect(s.why).toContain('overwrite');
  });
  it('the plan blocks it and writes nothing', () => {
    const plan = F.sftkApiVerPlan('62.0', ORGS, m[0].cells);
    expect(plan.applicable).toEqual([]);
    expect(plan.blocked[0].why).toContain('v4');
  });
  it('an active flow whose latest IS the active one is still applicable, carrying its latest number', () => {
    const m2 = F.sftkFlowVerMatrix(ORGS, { a: F.sftkFlowVerRows([REC('301v2', 2, 'Obsolete', '58.0'), REC('301v3', 3, 'Active', '58.0')]) });
    expect(m2[0].cells.a.newerInactive).toBe(null);
    const plan = F.sftkApiVerPlan('62.0', ORGS, m2[0].cells);
    expect(plan.applicable).toHaveLength(1);
    expect(plan.applicable[0].latestVersion).toBe(3);
  });
  it('a draft-only flow stays selectable (it is rewritten in place on purpose)', () => {
    const m3 = F.sftkFlowVerMatrix(ORGS, { a: F.sftkFlowVerRows([REC('301v1', 1, 'Draft', '58.0')]) });
    expect(F.sftkApiVerSelectable(m3[0].cells.a).ok).toBe(true);
  });
});

describe('avVerifyAndActivate never takes a pre-existing Draft for a new version', () => {
  const start = DEP.indexOf('async function avVerifyAndActivate(');
  const body = DEP.slice(start, DEP.indexOf('async function applyApiVerChange(', start));
  const build = (records, patches) => new Function('depFlowVersions', 'sftkFlowVerRows', 'sftkApiVerNum', 'depBg', 'sftkWriteVerifiedAll',
    `${body}; return avVerifyAndActivate;`)(
    async () => ({ records }), F.sftkFlowVerRows, F.sftkApiVerNum,
    async (msg) => { patches.push(msg); return {}; },
    async () => { throw new Error('must not activate'); });

  it('Draft v4 overwritten with v3 content: a failure, nothing activated, no newId for Undo', async () => {
    const patches = [];
    const fn = build([REC('301v3', 3, 'Active', '58.0'), REC('301v4', 4, 'Draft', '62.0')], patches);
    const out = await fn({ orgUrl: 'x', sid: 'y', label: 'A' },
      [{ apiName: 'Route', wasActive: true, prevVersion: 3, prevLatest: 4, defId: '300x' }], '62.0', () => {}, null);
    expect(out).toHaveLength(1);
    expect(out[0].ok).toBe(false);
    expect(out[0].overwroteExisting).toBe(true);
    expect(out[0].newId).toBeUndefined();
    expect(out[0].text).toContain('overwrote the existing v4');
    expect(patches).toEqual([]);
  });

  it('a truly new v5 is still activated as before', async () => {
    const patches = [];
    let activated = false;
    const fn = new Function('depFlowVersions', 'sftkFlowVerRows', 'sftkApiVerNum', 'depBg', 'sftkWriteVerifiedAll',
      `${body}; return avVerifyAndActivate;`)(
      async () => ({ records: [REC('301v3', 3, 'Active', '58.0'), REC('301v4', 4, 'Obsolete', '58.0'), REC('301v5', 5, 'Draft', '62.0')] }),
      F.sftkFlowVerRows, F.sftkApiVerNum, async (m) => { patches.push(m); return {}; },
      async (items) => { activated = true; return { results: items.map(() => ({ ok: true, text: 'ok' })) }; });
    const out = await fn({ orgUrl: 'x', sid: 'y', label: 'A' },
      [{ apiName: 'Route', wasActive: true, prevVersion: 3, prevLatest: 4, defId: '300x' }], '62.0', () => {}, null);
    expect(activated).toBe(true);
    expect(out[0].newVersion).toBe(5);
  });

  it('the undo builder names an overwritten flow and never queues a delete for it', () => {
    const apply = DEP.slice(DEP.indexOf('async function applyApiVerChange('), DEP.indexOf('function buildReportObject('));
    expect(apply).toMatch(/if \(v && v\.overwroteExisting\) \{ undoSkipped\.push\(c\.apiName\); continue; \}/);
    expect(apply).toContain('prevLatest: j.latestVersion == null ? null : Number(j.latestVersion)');
  });
});
