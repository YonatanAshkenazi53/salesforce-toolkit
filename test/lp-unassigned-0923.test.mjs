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

describe('openDetail — no status, no assignment, probe answered → Unassigned', () => {
  it('sets PublishStatus Unassigned only when every read answered and found nothing', () => {
    expect(SRC).toContain("} else if (!toolingStatus && assignments.length === 0 && !_lpProbeFailed) {");
    expect(SRC).toContain("page = { ...page, PublishStatus: 'Unassigned' };");
  });
});

describe('renderDetail — the words', () => {
  const fn = between('function renderDetail(page, metaRes, assignments, bodyEl, recordTypes = []) {', '// ── C5c: embedded-flow cross-links');
  it('status reads "Not assigned"', () => {
    expect(fn).toContain("const isUnassigned = normStatus === 'unassigned';");
    expect(fn).toMatch(/: isUnassigned \? 'Not assigned' : 'Draft';/);
  });
  it('the empty list says nobody sees the page and how to add an assignment; only a failed probe says unknown, with the reason', () => {
    const empty = SRC.slice(SRC.indexOf('const emptyMsg = !statusKnown'), SRC.indexOf('const emptyMsg = !statusKnown') + 900);
    expect(empty).toContain("'No assignments — this page is not shown to anyone yet. Add one below: org default, app default, or app + record type + profile.'");
    expect(empty).toContain("'⚠️ The org-default check failed' + (_lpProbeFailed ? ' (' + esc(_lpProbeFailed) + ')' : '') + ' — org-default assignments are unknown here; app and profile assignments were read and there are none.'");
    expect(SRC).not.toContain('status unknown for this page type');
  });
});
