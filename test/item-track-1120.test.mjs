// owner 2026-11-20: "when we remove and undo. i want to see it fills up for every component that is currently
// removed in real time. one after one with the real time progress." — every item of a ⚡ run and of ↩ Undo all gets
// its own row with a three-part bar (read · change · verify) that follows the item's real calls to Salesforce.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const FC = read('field-cleaner.js'), PR = read('sftk-progress.js'), HI = read('sftk-history.js'), CSS = read('styles.css');
const { sftkStepOfCall: step, sftkCallIsRead: isRead } = extractFunctions('sftk-progress.js', ['sftkStepOfCall', 'sftkCallIsRead']);

describe('which part of an item a call belongs to', () => {
  it('a read before the first write is the reading; a write is the change; a read after it is the verifying', () => {
    expect(step('SF_MD_READ', 0)).toBe('read');
    expect(step('SF_TOOLING_GET', 0)).toBe('read');
    expect(step('SF_QUERY_ALL', 0)).toBe('read');
    expect(step('SF_METADATA_DEPLOY', 0)).toBe('write');
    expect(step('SF_PATCH', 1)).toBe('write');
    expect(step('SF_TOOLING_DELETE', 0)).toBe('write');
    expect(step('SF_COLLECTIONS_UPDATE', 0)).toBe('write');
    expect(step('SF_MD_READ', 1)).toBe('verify');
    expect(step('SF_REST_GET', 2)).toBe('verify');
  });
  it('a check-only deploy and a retrieve change nothing; a message that is not a call to Salesforce is no step', () => {
    expect(isRead('SF_METADATA_VALIDATE')).toBe(true);
    expect(isRead('SF_MD_RETRIEVE_START')).toBe(true);
    expect(step('GET_ALL_SF_SESSIONS', 0)).toBe('');
    expect(step('', 0)).toBe('');
  });
});

describe('the calls are told as they start', () => {
  it('by Field Cleaner’s own sender and by the undo’s sender', () => {
    expect(FC).toContain("function bgRaw(msg) {\n    if (typeof sftkBgNote === 'function') sftkBgNote(msg);");
    expect(HI).toContain("function _sftkHistSend(msg) {\n  if (typeof sftkBgNote === 'function') sftkBgNote(msg);");
    expect(PR).toContain('window.sftkBgNote = function (msg)');
  });
});

describe('a run draws one row per item', () => {
  it('⚡ All at once: the row opens with the item, ends with its result, and the tracker is closed with the run', () => {
    expect(FC).toContain('<ol class="sftk-it-list fc-plan-run-list"></ol>');
    expect(FC).toContain('if (track) track.start(`${_PLAN_ICO[row.pick]} ${row.name}`);');
    expect(FC).toContain("if (track) track.end(false, 'that way is no longer offered on the row'); continue; }");
    expect(FC).toContain('sftkConfirmPlanned(null);\n      if (track) track.close();');
  });
  it('↩ Undo all: the same rows', () => {
    expect(FC).toContain('if (track) track.start(`↩ ${e.profileName}`);');
    expect(FC).toContain("if (track) track.end(!!(r && r.ok), (r && r.text) || 'no answer');");
  });
  it('text is escaped; a refused row is red from the theme tokens; motion is optional', () => {
    expect(PR).toContain('<span class="sftk-it-name">${e2(label)}</span>');
    expect(PR).toContain(".textContent = (ok ? '✓ ' : '✕ ') + (text || (ok ? 'Done' : 'Not done'));");
    expect(CSS).toContain('.sftk-it-bad .sftk-it-line { color: var(--c-critical-fg);');
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce) { .sftk-it-seg.now { animation: none; } }');
  });
});
