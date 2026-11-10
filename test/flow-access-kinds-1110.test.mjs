// Flow Access lists the flows a person can be given — decided by "has no trigger", not by a list of known triggers
// (2026-11-10, the packaged-metadata audit: the old blocklist let a before-delete record-triggered flow through).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const F = extractFunctions('flow-permissions.js', ['sftkFlowIsAssignable']);
const SRC = readFileSync(new URL('../flow-permissions.js', import.meta.url), 'utf8');
const ok = (ProcessType, TriggerType) => F.sftkFlowIsAssignable({ ProcessType, TriggerType });

describe('sftkFlowIsAssignable', () => {
  it('a screen flow and an autolaunched flow without a trigger', () => {
    expect(ok('Flow', null)).toBe(true);
    expect(ok('AutoLaunchedFlow', null)).toBe(true);
    expect(ok('AutoLaunchedFlow', '')).toBe(true);
  });
  it('anything that starts by itself is not — the known triggers and one nobody has heard of', () => {
    for (const t of ['RecordBeforeSave', 'RecordAfterSave', 'RecordBeforeDelete', 'Scheduled', 'PlatformEvent', 'DataCloudDataChange', 'SomethingNew2027']) expect(ok('AutoLaunchedFlow', t)).toBe(false);
  });
  it('other process types are not', () => {
    expect(ok('Workflow', null)).toBe(false);
    expect(F.sftkFlowIsAssignable(null)).toBe(false);
  });
});

describe('what is left out is said', () => {
  it('no list of trigger kinds is left in the tool, and the count of self-running flows is shown', () => {
    expect(SRC).not.toContain('BLOCKED_TRIGGERS = new Set');
    expect(SRC).toContain('_selfRunning = (fdvRes.records || []).length - assignable.length;');
    expect(SRC).toContain('start by themselves, so nobody is given access to them');
  });
});
