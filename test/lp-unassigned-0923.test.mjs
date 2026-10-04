// Lightning Pages — a page with no assignment is "Not assigned", not "Unknown".
//
// Live 2026-09-23: the fixture record page (deployed, never assigned) opened
// with "Unknown ⚠️ Could not determine assignments — status unknown for this
// page type". Salesforce keeps NO publish status for a FlexiPage (the Tooling
// field does not exist; a page's activation IS its assignments), so every
// untouched page read that way. Only a FAILED org-default probe is unknown.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lightning-pages.js'), 'utf8');
const between = (a, b) => { const i = SRC.indexOf(a); expect(i, a).toBeGreaterThan(0); return SRC.slice(i, SRC.indexOf(b, i)); };

describe('the org-default probe distinguishes "nothing found" from "could not look"', () => {
  it('records the failure reason and clears it on every probe', () => {
    expect(SRC).toContain('let _lpProbeFailed = null;');
    const fn = between('async function fetchCustomObjectOrgDefaults(', 'function lpOrgDefaultsFromDescribe');
    expect(fn).toMatch(/^\s*_lpProbeFailed = null;/m);
    expect(fn).toContain('_lpProbeFailed = (descErr && descErr.message) || String(descErr);');
  });
});

// 2026-10-04: the detail was rebuilt on what the org really answers (the org
// default from the describe, app-level assignments from the apps themselves —
// test/lp-assignments-1004). The words this file exists for are kept.
describe('openDetail — every read answered and found nothing → Unassigned; a failed read → unknown', () => {
  it('the status comes from the assignments, and a failed read makes it unknown, never "none"', () => {
    expect(SRC).toContain('const status = isRecordPage ? lpPageStatus(assignments, unknown.length > 0) : null;');
    expect(SRC).toContain("if (_lpProbeFailed) unknown.push(`the org default could not be read (${_lpProbeFailed})`);");
    expect(SRC).toContain('if (_appIndexErr) unknown.push(_appIndexErr);');
  });
});

describe('renderDetail — the words', () => {
  const fn = between('function renderDetail(page, metaRes, assignments, bodyEl, recordTypes = [], ctx = {}) {', '// ── Render user chips for an assignment row');
  it('status reads "Not assigned"', () => {
    expect(fn).toContain("const statusLabel = isActive ? 'Active' : 'Not assigned';");
    expect(fn).not.toContain("'Draft'");
  });
  it('the empty list says nobody sees the page and how to add an assignment; a failed read says unknown, never "not assigned"', () => {
    expect(fn).toContain("'No assignments — this page is not shown to anyone yet. Add one below: org default, app default, or app + record type + profile.'");
    expect(fn).toContain('treat this as unknown, not as “not assigned”');
    expect(fn).toContain('Unknown — a check failed');
    expect(SRC).not.toContain('status unknown for this page type');
  });
});
