import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunction } from './extract.mjs';
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const LP = readFileSync(new URL('../lightning-pages.js', import.meta.url), 'utf8');
const lpOdSummary = extractFunction('lightning-pages.js', 'lpOdSummary');

// User 2026-10-07: "here we have remove but we dont have remove flow keep running for all".
describe('Field Cleaner: the group button for flows offers both ways', () => {
  it('two buttons, one per way, each walking fixOne with the way chosen', () => {
    expect(FC).toContain('data-type="Flow" data-swap="0" data-way="keep"');
    expect(FC).toContain('data-type="Flow" data-swap="0" data-way="off"');
    expect(FC).toContain('✂ Remove from all ${n} ${noun} · flows keep running');
    expect(FC).toContain('🗑 Delete versions · all ${n} ${noun} off');
    expect(FC).toContain("fixAll(t, _curFieldId, swap, all.dataset.way || '').finally(() => {");   // the walk's end redraws the group buttons (2026-10-10)
    expect(FC).toContain("async function fixAll(type, fieldId, swap, way = '')");
    expect(FC).toContain('await fixOne(type, it.id, it.name, fieldId, swap, way)');
  });
});

// User 2026-10-07: "the button here doesn't do anything when i click it" — Finish the check
// re-ran the four failed describes, they failed again, and the strip read exactly as before.
describe('Lightning Pages: a repeated org-default check says it ran, and names what failed', () => {
  const base = { pagesDone: 65, pagesTotal: 65, objectsDone: 36, objectsTotal: 40, objectsFailed: 4, unresolved: 5 };
  it('the first finish names the failed objects and why', () => {
    const s = lpOdSummary({ ...base, status: 'done', attempts: 1, failedObjects: [{ name: 'ApplicationFormEvalSection', why: 'INVALID_TYPE' }] }, null);
    expect(s).toContain('4 object describes failed.');
    expect(s).toContain('Could not be described: ApplicationFormEvalSection (INVALID_TYPE).');
    expect(s).not.toContain('Tried again');
  });
  it('a second run says so, and the button offers "Try again"', () => {
    const s = lpOdSummary({ ...base, status: 'done', attempts: 2, failedObjects: [] }, null);
    expect(s.startsWith('Tried again just now (run 2) — the same result. ')).toBe(true);
    expect(LP).toContain("(st.attempts > 1 ? 'Try again' : 'Finish the check')");
    expect(LP).toContain('_odState.attempts = (_odState.attempts || 0) + 1;');
    expect(LP).toContain("_odNoteFailedObject(apiName, (descRes && descRes.error) || 'no answer')");
  });
  it('a clean finish still renders nothing', () => {
    expect(lpOdSummary({ pagesDone: 40, pagesTotal: 40, objectsDone: 12, objectsTotal: 12, status: 'done', attempts: 1 }, null)).toBe('');
  });
});
