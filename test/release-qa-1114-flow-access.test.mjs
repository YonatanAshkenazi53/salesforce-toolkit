// Flow Access, release QA 2026-11-14.
// 1. Packaged (NamespacePrefix) and group-owned (Type Group) permission sets are not offered: the old deploy by bare
//    Name made a stray unmanaged copy of a packaged set, and the verify then said "not yet granted".
// 2. The verify does its own SetupEntityAccess read that throws on failure: it used to call loadData(), which swallows
//    errors, so a failed re-read checked the pre-change map ("grants missing") and the undo offered nothing.
// 3. The grant is a SetupEntityAccess insert, never a PermissionSet deploy: Salesforce took a deploy holding only
//    <flowAccesses> + <label> as the whole set and wiped its description and field permissions.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const F = extractFunctions('flow-permissions.js', ['sftkFlowAccessLockedReason', 'sftkFlowAccessCheck']);
const SRC = readFileSync(new URL('../flow-permissions.js', import.meta.url), 'utf8');
const body = (name) => {
  const i = SRC.indexOf(`async function ${name}(`);
  expect(i, name).toBeGreaterThan(0);
  return SRC.slice(i, SRC.indexOf('\n  }\n', i));
};

describe('1. packaged and group permission sets are not offered', () => {
  it('the reason is said for a packaged set and a group set, none for a plain one', () => {
    expect(F.sftkFlowAccessLockedReason({ Name: 'Enablement_User', NamespacePrefix: 'force', Type: 'Regular' })).toMatch(/force package/);
    expect(F.sftkFlowAccessLockedReason({ Name: 'LookupRollupSummariesFull', NamespacePrefix: 'dlrs', Type: 'Regular' })).toMatch(/dlrs/);
    expect(F.sftkFlowAccessLockedReason({ Name: 'X', NamespacePrefix: null, Type: 'Group' })).toMatch(/permission set group/);
    expect(F.sftkFlowAccessLockedReason({ Name: 'Mine', NamespacePrefix: null, Type: 'Regular' })).toBeNull();
    expect(F.sftkFlowAccessLockedReason({ Name: 'Sess', NamespacePrefix: null, Type: 'Session' })).toBeNull();
    expect(F.sftkFlowAccessLockedReason(null)).toBeTruthy();
  });
  it('the query reads NamespacePrefix and Type, the list is filtered, and what is left out is counted', () => {
    expect(SRC).toMatch(/SELECT Id, Name, Label, NamespacePrefix, Type FROM PermissionSet/);
    expect(SRC).toContain('_permSets = allPs.filter(p => !sftkFlowAccessLockedReason(p));');
    expect(SRC).toContain('_psLocked = allPs.length - _permSets.length;');
    expect(SRC).toContain('sets from installed packages and the sets Salesforce keeps for permission set groups cannot be changed here');
    expect(SRC).toContain('_permSets.filter(p => _selPS.has(p.Id) && !sftkFlowAccessLockedReason(p))');
  });
});

describe('2. the verify reads the org itself and never judges a stale map', () => {
  const flows = [{ Id: '300A', MasterLabel: 'Flow A' }, { Id: '300B', MasterLabel: 'Flow B' }];
  const sets = [{ Id: '0PS1', Label: 'Set 1' }];
  it('sftkFlowAccessCheck: present rows are found with their ids, absent pairs are named', () => {
    const r = F.sftkFlowAccessCheck(flows, sets, [{ Id: '0J01', ParentId: '0PS1', SetupEntityId: '300A' }, { Id: '0J0x', ParentId: '0PS9', SetupEntityId: '300B' }]);
    expect(r.ok).toBe(false);
    expect(r.present).toEqual({ '300A|0PS1': '0J01' });
    expect(r.missing).toEqual(['Flow B → Set 1']);
    expect(r.missingKeys).toEqual(['300B|0PS1']);
    expect(F.sftkFlowAccessCheck(flows, sets, [{ Id: 'a', ParentId: '0PS1', SetupEntityId: '300A' }, { Id: 'b', ParentId: '0PS1', SetupEntityId: '300B' }]).ok).toBe(true);
  });
  it('the verify does not call loadData (which swallows errors); its own read throws on an error or an incomplete answer', () => {
    const d = body('doAssign');
    const verify = d.slice(d.indexOf('verify: async () => {'), d.indexOf('} finally {'));
    expect(verify).not.toContain('loadData');
    expect(verify).toContain('readFlowAccessRows(flows, permSets)');
    const read = body('readFlowAccessRows');
    expect(read).toMatch(/if \(!res \|\| res\.error\) throw new Error/);
    expect(read).toMatch(/if \(res\.incomplete\) throw new Error/);
  });
  it('a re-read that failed is said as unverified, never as grants missing', () => {
    const d = body('doAssign');
    expect(d).toMatch(/: !wr\.verified\s*\n\s*\? wr\.text/);
    expect(d).not.toContain('wr.detail.length');
  });
  it('the undo is built from the ids the insert returned, not from _accessMap', () => {
    const d = body('doAssign');
    const fin = d.slice(d.indexOf('} finally {'), d.indexOf('sftkHistoryEnd('));
    expect(fin).toContain('for (const c of ins.created)');
    expect(fin).not.toContain('_accessMap');
    expect(fin).toContain("msg: { type: 'SF_REST_DELETE', sobject: 'SetupEntityAccess', id: c.id }");
  });
});

describe('3. the grant inserts SetupEntityAccess rows and never deploys the permission set', () => {
  it('no PermissionSet deploy is left in the tool', () => {
    expect(SRC).not.toContain("type: 'SF_METADATA_DEPLOY'");
    expect(SRC).not.toContain('<flowAccesses>\',');
    expect(SRC).not.toMatch(/permissionsets\/\$\{/);
    expect(SRC).not.toContain('function buildPermSetXml');
  });
  it('the write inserts one row per new pair, skips pairs already granted, and keeps created ids through a failed chunk', () => {
    const ins = body('insertFlowAccess');
    expect(ins).toContain("type: 'SF_COLLECTIONS_CREATE'");
    expect(ins).toContain("attributes: { type: 'SetupEntityAccess' }, ParentId: p.psId, SetupEntityId: p.flowId");
    expect(ins).toMatch(/catch \(e\) \{ res = \{ error:/);
    const d = body('doAssign');
    expect(d).toContain('if (!before.has(key)) pairs.push(');
    expect(d).toContain('ins = await insertFlowAccess(pairs);');
  });
});
