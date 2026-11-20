// QA 1.1 finding 20: the list-view leg read only the first page of sobjects/<Object>/listviews.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const { fcListViewsAll: all } = extractFunctions('field-cleaner.js', ['fcListViewsAll']);
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const lv = n => ({ id: `00B${n}`, label: `View ${n}` });

describe('every page of an object’s list views is read', () => {
  it('one page: no further read', async () => {
    const asked = [];
    const r = await all({ done: true, listviews: [lv(1), lv(2)] }, p => { asked.push(p); return {}; });
    expect(r).toEqual({ views: [lv(1), lv(2)], error: '' });
    expect(asked).toEqual([]);
  });
  it('three pages: each next page is asked for by its own address, without the leading slash', async () => {
    const pages = {
      'services/data/v62.0/sobjects/Account/listviews?offset=25': { done: false, nextRecordsUrl: '/services/data/v62.0/sobjects/Account/listviews?offset=50', listviews: [lv(3)] },
      'services/data/v62.0/sobjects/Account/listviews?offset=50': { done: true, nextRecordsUrl: null, listviews: [lv(4), lv(5)] },
    };
    const asked = [];
    const r = await all({ done: false, nextRecordsUrl: '/services/data/v62.0/sobjects/Account/listviews?offset=25', listviews: [lv(1), lv(2)] },
      async p => { asked.push(p); return pages[p]; });
    expect(r.error).toBe('');
    expect(r.views.map(v => v.id)).toEqual(['00B1', '00B2', '00B3', '00B4', '00B5']);
    expect(asked).toEqual(Object.keys(pages));
  });
  it('a later page that fails: the views read so far are kept and the reason is said', async () => {
    const first = { done: false, nextRecordsUrl: '/x?offset=25', listviews: [lv(1)] };
    const refused = await all(first, async () => ({ error: 'HTTP 503' }));
    expect(refused.views).toEqual([lv(1)]);
    expect(refused.error).toMatch(/page 2 of the list of views: HTTP 503/);
    const thrown = await all(first, async () => { throw new Error('timed out'); });
    expect(thrown.error).toMatch(/page 2.*timed out/);
    const empty = await all(first, async () => ({ done: true }));
    expect(empty.error).toMatch(/page 2 of the list of views came back without views/);
  });
  it('“more to come” with no next page, or the same page again, is an incomplete list and never a loop', async () => {
    const none = await all({ done: false, listviews: [lv(1)] }, async () => ({}));
    expect(none.error).toMatch(/more views after the first 1 and gave no next page/);
    let calls = 0;
    const same = await all({ done: false, nextRecordsUrl: '/x?offset=25', listviews: [lv(1)] },
      async () => { calls++; return { done: false, nextRecordsUrl: '/x?offset=25', listviews: [lv(2)] }; });
    expect(calls).toBe(1);
    expect(same.views).toHaveLength(2);
    expect(same.error).toMatch(/gave no next page/);
  });
  it('the scan leg reads through it and reports a short list as not fully read', () => {
    const leg = FC.slice(FC.indexOf('// 1. List views'), FC.indexOf('// 2. Compact layouts'));
    expect(leg).toContain('await fcListViewsAll(lvRes,');
    expect(leg).toContain("if (all.error) miss('list views (the list is not complete)'");
    expect(leg).not.toContain('lvRes.listviews || []');
  });
});
