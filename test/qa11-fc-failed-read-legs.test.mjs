// QA 1.1 finding 19 — the list-view, quick-action, search-layout and parent-layout legs report a failed read as unread.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const { fcReadError: err, fcAbsentFeatureError: absent } = extractFunctions('field-cleaner.js', ['fcReadError', 'fcAbsentFeatureError']);

describe('what a read answered', () => {
  it('an answer is no error', () => {
    expect(err({ listviews: [] })).toBe('');
    expect(err({ text: '<x/>' })).toBe('');
    expect(err([], true)).toBe('');
    expect(err([{ name: 'Account.New_Deal' }], true)).toBe('');
  });
  it('the background’s { error }, or no answer at all, is one', () => {
    expect(err({ error: 'HTTP 503 Service Unavailable' })).toBe('HTTP 503 Service Unavailable');
    expect(err({ error: 'The request timed out' })).toBe('The request timed out');
    expect(err(null)).toBe('no answer');
    expect(err(undefined)).toBe('no answer');
    expect(err({ error: 'HTTP 403 Forbidden' }, true)).toBe('HTTP 403 Forbidden');
  });
  it('a list that did not come back as a list is one', () => {
    expect(err({}, true)).toBe('the answer was not a list');
  });
});

// the scan's own reporter, as scanSupplemental builds it
const mkMiss = unread => (leg, e) => { if (absent((e && e.message) || e)) return; const why = String((e && e.message) || e || 'no answer').replace(/\s+/g, ' ').slice(0, 160); if (!unread.some(u => u.leg === leg)) unread.push({ leg, why }); };
describe('a leg built the way the scan builds it', () => {
  const leg = (answer, unread) => { const miss = mkMiss(unread); try { if (err(answer)) throw new Error(err(answer)); return (answer.listviews || []).length; } catch (e) { miss('list views', e); return null; } };
  it('a refused read lands in the unread list instead of counting as no list views', () => {
    const unread = [];
    expect(leg({ error: 'HTTP 500 Internal Server Error' }, unread)).toBe(null);
    expect(unread).toEqual([{ leg: 'list views', why: 'HTTP 500 Internal Server Error' }]);
  });
  it('an object that has no list views at all is an empty answer, not a failed read', () => {
    const unread = [];
    leg({ error: 'HTTP 404 NOT_FOUND: The requested resource does not exist' }, unread);
    expect(unread).toEqual([]);
    expect(leg({ listviews: [] }, unread)).toBe(0);
  });
});

describe('the four legs', () => {
  const scan = FC.slice(FC.indexOf('  async function scanSupplemental('), FC.indexOf('  function _flexiNamesBeyondText('));
  it('list views: the list, and each view that could not be opened', () => {
    expect(scan).toContain('if (fcReadError(lvRes)) throw new Error(fcReadError(lvRes));');
    expect(scan).not.toContain("const lvs = lvRes?.listviews || [];");
    expect(scan).toContain("if (r.status !== 'fulfilled' || fcReadError(r.value)) { miss('list views (some could not be opened)',");
  });
  it('quick actions: the list — the describe of one action stays silent, a standard action answers 404 there', () => {
    expect(scan).toContain('if (fcReadError(qaRes, true)) throw new Error(fcReadError(qaRes, true));');
    expect(scan).not.toContain('(Array.isArray(qaRes) ? qaRes : [])');
    expect(scan).toContain("if (r.status !== 'fulfilled' || r.value?.error) return;\n          const d = r.value, qa = slice[j];");
  });
  it('search layouts and dependent picklists: the object’s metadata', () => {
    expect(scan).toContain("if (fcReadError(r)) throw new Error(fcReadError(r));\n      const rec = sftkMdExtractRecords(r.text).records.find(x => x.fullName === obj) || null;");
    expect(scan).toContain("} catch (e) { miss('search layouts and dependent picklists', e); }");
  });
  it('related lists: each parent layout that could not be opened', () => {
    expect(scan).toContain("if (fcReadError(g) || !g.Metadata) { miss('related lists on parent layouts (some could not be opened)',");
    expect(scan).not.toContain('if (!g || g.error || !g.Metadata) return;');
  });
});
