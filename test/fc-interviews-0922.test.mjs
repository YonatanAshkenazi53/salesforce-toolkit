// Field Cleaner — flow interviews and refused version deletes, pinned from a
// live run (2026-09-22, fixture flow SFTK_FC_Test_Flow, trailheads2).
//
// What happened: "Delete the active version too" switched the flow off and
// deleted v4, then Salesforce refused v1–v3 with DEPENDENCY_EXISTS naming five
// failed interviews — interviews the tool's own check had NOT found, because
// FlowInterview.FlowVersionViewId matches the 15-character id only and the
// query used 18-character ids. The row was then marked ✅ anyway and the delete
// zone read "All dependencies resolved. Safe to delete." Three pins:
//   1. the interview query asks for both id forms; the skip set is 15-char safe;
//   2. a fix with refused versions / interviews is NOT marked done — it throws,
//      the ✂ button comes back, the inline error says what remains;
//   3. the raw DEPENDENCY_EXISTS text reads as a sentence with the interview ids.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunctions } from './extract.mjs';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'field-cleaner.js'), 'utf8');
const { sftkFriendlyError } = extractFunctions('sftk-friendly-error.js', ['sftkFriendlyError']);

const LIVE_RAW = '[{"message":"This flow version is referenced in a flow interview. Remove or update that reference, then try again. : Flow Interview - 0Fo9k000000E7WH. This flow version is referenced in a flow interview. Remove or update that reference, then try again. : Flow Interview - 0Fo9k000000E7Xt. This flow version is referenced in a flow interview. Remove or update that reference, then try again. : Flow Interview - 0Fo9k000000E7WH.","errorCode":"DEPENDENCY_EXISTS","fields":[]}]';

describe('flow interviews — the lookup', () => {
  it('queries FlowVersionViewId with the 15- and 18-character forms of every version id', () => {
    const i = SRC.indexOf('async function _flowInterviewsFor(');
    const fn = SRC.slice(i, SRC.indexOf('async function _deleteFlowInterviews', i));
    expect(fn).toMatch(/s\.length === 18 \? \[s, s\.substring\(0, 15\)\] : \[s\]/);
    expect(fn).toMatch(/FROM FlowInterview WHERE FlowVersionViewId IN \(\$\{lit\}\)/);
  });
  it('the versions whose interviews could not be deleted are skipped by 15-character id', () => {
    expect(SRC).toContain("out.failedVersionIds.add(String(it.FlowVersionViewId || '').substring(0, 15));");
    expect(SRC).toContain("if (skipIds && (skipIds.has(id) || skipIds.has(String(id).substring(0, 15)))) { out.skipped++; continue; }");
  });
});

describe('flow fix outcome — refused versions are not "done"', () => {
  it('throws (button back, inline error) when any version or interview was refused, before markFixed', () => {
    const i = SRC.indexOf('const stuck = (r.failed || 0) + (r.skipped || 0) + (r.interviewsFailed || 0);');
    expect(i).toBeGreaterThan(0);
    const after = SRC.slice(i, i + 700);
    expect(after).toMatch(/if \(stuck\) \{/);
    expect(after).toMatch(/Not finished: \$\{bits\.join\(' · '\)\}/);
    expect(after).toMatch(/The field stays locked until every version that references it is gone/);
    expect(after).toMatch(/throw e;/);
    // the ✅ label and the sibling marking come only after the throw
    expect(after.indexOf('throw e;')).toBeLessThan(after.indexOf('label = `✅ ${bits.join'));
    expect(SRC.indexOf('const stuck = (r.failed')).toBeLessThan(SRC.indexOf('_markFlowSiblings(componentId, r.defId, label, doneLinks);'));
  });
  it('the refused-version line says "still blocking", never "may still block", and repeats no error', () => {
    expect(SRC).toContain("version(s) couldn't be deleted — still blocking the field delete${r.errors.length ? ` (${[...new Set(r.errors)].join('; ')})` : ''}");
    expect(SRC).not.toContain('may still block the field delete');
  });
});

describe('friendly error — DEPENDENCY_EXISTS from a flow interview', () => {
  it('reads as one sentence naming the distinct interview ids, with the Setup hint', () => {
    const fe = sftkFriendlyError(LIVE_RAW);
    expect(fe.type).toBe('flow-interview');
    expect(fe.message).toBe('Salesforce refuses to delete this flow version: 2 paused or failed flow interviews still reference it (0Fo9k000000E7WH, 0Fo9k000000E7Xt)');
    expect(fe.hint).toMatch(/Paused And Failed Flow Interviews/);
    expect(fe.kind).toBe('error');
  });
  it('one interview → singular', () => {
    const fe = sftkFriendlyError('[{"message":"This flow version is referenced in a flow interview. : Flow Interview - 0Fo9k000000E7ZV.","errorCode":"DEPENDENCY_EXISTS","fields":[]}]');
    expect(fe.message).toBe('Salesforce refuses to delete this flow version: 1 paused or failed flow interview still references it (0Fo9k000000E7ZV)');
  });
  it('other DEPENDENCY_EXISTS texts are left to the generic path', () => {
    expect(sftkFriendlyError('[{"message":"in use by a layout","errorCode":"DEPENDENCY_EXISTS"}]').type).toBe('generic');
  });
});
