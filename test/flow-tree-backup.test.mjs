// FLOWS TAB — dependencies per flow and the whole-tree backup (user
// 2026-09-14: "this feature should also show dependencies and allow you to
// back up a full tree of flows and its subflows").
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunction } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const PU = read('popup.js');
const DEP = read('dependency-map.js');
const HTML = read('popup.html');
const depSubflowClosure = extractFunction('dependency-map.js', 'depSubflowClosure');

const caller = (apiName) => ({ apiName, masterLabel: apiName, status: 'Active' });

describe('depSubflowClosure — every subflow a flow reaches', () => {
  // A calls B and C; B calls D; D calls A (cycle); E is unrelated.
  const map = { B: [caller('A')], C: [caller('A')], D: [caller('B')], A: [caller('D')], F: [caller('E')] };

  it('walks transitively, excludes the roots, stops at cycles, sorts siblings', () => {
    const r = depSubflowClosure(map, ['A']);
    expect(r.names).toEqual(['B', 'C', 'D']);
    expect(r.truncated).toBe(false);
  });

  it('merges several roots without duplicates', () => {
    expect(depSubflowClosure(map, ['A', 'E']).names.sort()).toEqual(['B', 'C', 'D', 'F']);
  });

  it('a flow that calls nothing yields an empty tree', () => {
    expect(depSubflowClosure(map, ['C']).names).toEqual([]);
  });

  it('reports a hit cap instead of silently stopping', () => {
    const r = depSubflowClosure(map, ['A'], 2);
    expect(r.names).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it('survives junk', () => {
    expect(depSubflowClosure(null, null).names).toEqual([]);
    expect(depSubflowClosure({}, ['x']).names).toEqual([]);
  });
});

describe('the Flows tab shows what each flow calls, honestly', () => {
  const chip = PU.slice(PU.indexOf('function buildCallsChip(apiName, depMap)'), PU.indexOf('function buildVersionRow('));
  it('says "calls ?" for an unscanned flow — never "calls nothing"', () => {
    expect(chip).toContain("if (st.state !== 'scanned')");
    expect(chip).toContain("chip.textContent = '↘ calls ?';");
    expect(chip).toContain('what it calls is UNKNOWN (not none)');
  });
  it('counts direct calls and lists the whole tree in the tooltip', () => {
    expect(chip).toContain('chip.textContent = `↘ calls ${direct.length}`;');
    expect(chip).toContain('DependencyMap.subflowClosure([apiName])');
    expect(PU).toContain('const callsChip = buildCallsChip(apiName, depMap);');
  });
  it('the module exports the per-flow scan state and the closure', () => {
    expect(DEP).toContain('flowScanState: (apiName) => depFlowScanState(flowsByApiName[apiName] || [], _scannedIds),');
    expect(DEP).toContain('subflowClosure: (apiNames) => depSubflowClosure(dependencyMap, apiNames),');
  });
});

describe('the whole-tree backup', () => {
  const plan = PU.slice(PU.indexOf('function planTreeBackup(selected)'), PU.indexOf('function confirmTreeBackup('));
  const click = PU.slice(PU.indexOf('async function onBackupClick()'), PU.indexOf('downloadFlowBackupZip(flows, orgUrl,'));

  it('is an option in Backup mode only', () => {
    expect(HTML).toContain('id="backupWithSubflows"');
    expect(PU).toContain("treeOpt.style.display = currentMode === 'backup' ? '' : 'none';");
  });

  it('refuses to claim a whole tree when the scan has not read part of it', () => {
    expect(plan).toContain("(DependencyMap.flowScanState(a) || {}).state !== 'scanned'");
    expect(plan).toContain('return { blocked: unscanned };');
    expect(click).toContain('The tree is not known yet');
    expect(click).toContain('would silently miss subflows');
  });

  it('adds the active version of each reached subflow, else the newest', () => {
    expect(plan).toMatch(/versions\.find\(v => v\.Status === 'Active'\)\s*\|\| versions\.slice\(\)\.sort/);
  });

  it('names what could not be included instead of dropping it', () => {
    expect(plan).toContain('managed package — contents hidden by Salesforce, cannot be backed up');
    expect(plan).toContain("'not in this org'");
    expect(PU).toContain('Not included</strong> (said, not skipped silently)');
  });

  it('confirms the tree before downloading, and the zip says it is a tree', () => {
    expect(click).toContain('if (!(await confirmTreeBackup(selected, plan))) return;');
    expect(click).toContain('selected = selected.concat(plan.add);');
    expect(PU).toContain("`SF_Backup_${date}${treeMode ? '_tree' : ''}_${flows.length}flow");
    expect(PU).toContain('could not be read and are NOT in the zip');
    expect(PU).toContain('toast-error');
  });
});
