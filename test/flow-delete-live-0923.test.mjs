// Flows tab — deleting a subflow chain, pinned from live runs (2026-09-23,
// trailheads2, fixture docs/fixtures/dep-test-flows: trigger → L1 → L2 → L3 → L4).
//
// What happened:
//   1. "Proceed anyway, ignore broken parents" on L4: Salesforce refused —
//      DEPENDENCY_EXISTS "referenced by at least one subflow element … L3" —
//      and the raw JSON was shown; worse, the tool had switched L4 OFF for the
//      attempt and left it off while reporting "0 deleted, 1 failed".
//   2. "Deactivate + delete selected parents" with all four parents ticked:
//      "4 deleted, 1 failed" — L4 (the selected child) went FIRST and was
//      refused while its parents still called it; the parents were then deleted.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunctions } from './extract.mjs';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'popup.js'), 'utf8');
const { sftkFriendlyError } = extractFunctions('sftk-friendly-error.js', ['sftkFriendlyError']);
const between = (a, b) => { const i = SRC.indexOf(a); expect(i, a).toBeGreaterThan(0); return SRC.slice(i, SRC.indexOf(b, i)); };

describe('onDeleteClick — the parents go first', () => {
  it('builds toDelete from the ticked parents, then the selected flows', () => {
    const fn = between('async function onDeleteClick(', 'async function performDeletion(');
    expect(fn).toContain('const toDelete = [...extraToDelete.filter(f => !selectedIdSet.has(f.Id))];');
    expect(fn).toMatch(/for \(const f of selected\) \{\s*if \(!toDelete\.find\(x => x\.Id === f\.Id\)\) toDelete\.push\(f\);/);
  });
});

describe('performDeletion — refused subflow references are retried once the callers are gone', () => {
  const fn = between('async function performDeletion(', 'function showResultToast(');
  it('retries DEPENDENCY_EXISTS / subflow-element failures while progress is made, before the toast', () => {
    expect(fn).toMatch(/const again = errors\.filter\(e => \/DEPENDENCY_EXISTS\|subflow element\/i\.test\(e\.msg\)\);/);
    expect(fn).toMatch(/if \(!again\.length \|\| !successes\.length\) break;/);
    expect(fn).toMatch(/Retrying: \$\{e\.flow\.MasterLabel\} v\$\{e\.flow\.VersionNumber\} \(its callers are gone now\)/);
    expect(fn).toMatch(/if \(!progressed\) break;/);
    expect(fn.indexOf('const again = errors.filter')).toBeLessThan(fn.indexOf('clearInterval(msgInterval);'));
  });
});

describe('deleteOneFlow — a refused delete does not leave the flow switched off silently', () => {
  it('switches the version back on and says so in the error', () => {
    const fn = between('async function deleteOneFlow(', 'async function performDeletion(');
    expect(fn).toMatch(/body: \{ Metadata: \{ activeVersionNumber: flow\.VersionNumber \} \}/);
    expect(fn).toContain("It was switched OFF for the attempt and is switched back ON.");
    expect(fn).toContain("could NOT be switched back on");
    expect(fn).toMatch(/throw new Error\(`\$\{e\.message \|\| e\}\$\{back\}`\);/);
  });
});

describe('the parents modal says why "Proceed anyway" may not work', () => {
  it('names the Salesforce rule and the order', () => {
    expect(SRC).toContain('Salesforce refuses to delete a flow while another flow\'s subflow element still calls it, so "Proceed anyway" only works once those parents no longer call it. Ticking a parent deletes the parents first, then the flow.');
  });
});

describe('friendly error — DEPENDENCY_EXISTS from a subflow element', () => {
  const LIVE = '[{"message":"This flow is referenced by at least one subflow element. Modify the subflow elements in the following flows: SFTK_Dep_Test_L3.","errorCode":"DEPENDENCY_EXISTS","fields":[]}]';
  it('reads as a sentence naming the calling flow, with the "Also delete" hint', () => {
    const fe = sftkFriendlyError(LIVE);
    expect(fe.type).toBe('flow-subflow-ref');
    expect(fe.message).toBe('Salesforce refuses to delete this flow: another flow still calls it as a subflow (SFTK_Dep_Test_L3)');
    expect(fe.hint).toMatch(/tick them under "Also delete"/);
  });
  it('several callers → plural', () => {
    const fe = sftkFriendlyError('[{"message":"This flow is referenced by at least one subflow element. Modify the subflow elements in the following flows: A_Flow, B_Flow.","errorCode":"DEPENDENCY_EXISTS"}]');
    expect(fe.message).toBe('Salesforce refuses to delete this flow: 2 flows still call it as a subflow (A_Flow, B_Flow)');
  });
  it('the flow-interview rule still wins for interview refusals', () => {
    expect(sftkFriendlyError('[{"message":"This flow version is referenced in a flow interview. : Flow Interview - 0Fo9k000000E7ZV.","errorCode":"DEPENDENCY_EXISTS"}]').type).toBe('flow-interview');
  });
});
