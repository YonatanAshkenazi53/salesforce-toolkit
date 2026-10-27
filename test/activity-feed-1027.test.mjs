// 🧾 Activity (user 2026-10-27: "history feed of everything you did and when … accessed from the
// topbar of both tools … and grouped"): the pure grouping behaves; both pages carry the button and
// load the file after the history store.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
// the tool→tab map is a const beside sftkHistoryToolTab, so the pure parts are materialised with it in scope
const slice = (src, name) => { const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(src); const end = src.indexOf('\n}', m.index); return src.slice(m.index, end + 2); };
const HS = read('sftk-history.js'), FS = read('sftk-feed.js');
const consts = HS.slice(HS.indexOf('const SFTK_TOOLKIT_TOOLS = {'), HS.indexOf('};', HS.indexOf('const SFTK_TOOLKIT_TOOLS = {')) + 2);
const names = ['sftkFeedWhat', 'sftkFeedCounts', 'sftkFeedDayLabel', 'sftkFeedGroups', 'sftkFeedTime'];
const F = new Function(`${consts}\n${slice(HS, 'sftkHistoryToolTab')}\n${names.map(n => slice(FS, n)).join('\n')}\nreturn { ${names.join(', ')} };`)();
void extractFunctions;

const NOW = Date.parse('2026-10-27T20:00:00');
const E = [
  { id: 'r1', kind: 'reconcile', profileName: 'SFTK CX — Accounts tree', startedAt: '2026-10-27T18:05:00', status: 'success', sourceOrg: 'https://trailheads5.my.salesforce.com', targetOrg: 'https://orgfarm.develop.my.salesforce.com', summary: { Account: { inserted: 3, insertedFailed: 1 } } },
  { id: 'r2', kind: 'rollback', profileName: '↩ Rollback of SFTK CX — Accounts tree', startedAt: '2026-10-27T18:20:00', status: 'success', sourceOrg: 'https://trailheads5.my.salesforce.com', targetOrg: 'https://orgfarm.develop.my.salesforce.com', summary: { Account: { deleted: 3 } } },
  { id: 't1', kind: 'tool', tool: 'Field Cleaner', profileName: '📦 Values — Account.A__c → B__c (12 records)', startedAt: '2026-10-26T09:00:00', status: 'success', targetOrg: 'https://trailheads4.my.salesforce.com', what: [{ ok: true }, { ok: true }] },
  { id: 't2', kind: 'tool', tool: 'Field Cleaner', profileName: '🗑 Field — Account.A__c', startedAt: '2026-10-26T09:30:00', status: 'partial', targetOrg: 'https://trailheads4.my.salesforce.com', what: [{ ok: true }, { ok: false }] },
  { id: 't3', kind: 'tool', tool: 'Merge', profileName: '🔀 Account "X": one copy merged', startedAt: '2026-10-27T18:30:00', status: 'success', targetOrg: 'https://trailheads5.my.salesforce.com', what: [] },
];

describe('what an entry is', () => {
  it('a Toolkit tool entry is Toolkit; a merge (no tool tab) and runs are Data Studio', () => {
    expect(F.sftkFeedWhat(E[2])).toMatchObject({ app: 'Toolkit', group: 'Field Cleaner', tab: 'fields' });
    expect(F.sftkFeedWhat(E[4])).toMatchObject({ app: 'Data Studio', group: 'Merge' });
    expect(F.sftkFeedWhat(E[0])).toMatchObject({ app: 'Data Studio', group: 'Data Deployment — SFTK CX — Accounts tree', icon: '🚀' });
    expect(F.sftkFeedWhat(E[1])).toMatchObject({ group: 'Rollback — SFTK CX — Accounts tree', icon: '↩' });
  });
  it('the counts in a line', () => {
    expect(F.sftkFeedCounts(E[0])).toBe('3 inserted · 1 failed');
    expect(F.sftkFeedCounts(E[1])).toBe('3 deleted');
    expect(F.sftkFeedCounts(E[2])).toBe('2 steps verified');
    expect(F.sftkFeedCounts(E[3])).toBe('1 of 2 steps verified');
    expect(F.sftkFeedCounts(E[4])).toBe('nothing written');
  });
});

describe('grouped: by day, then by the tool or deployment, newest first', () => {
  it('two days, the right groups, entries newest first', () => {
    const g = F.sftkFeedGroups(E, NOW, {});
    expect(g.n).toBe(5);
    expect(g.days.map(d => d.label)).toEqual(['Today', 'Yesterday']);
    expect(g.days[0].groups.map(x => x.name)).toEqual(['Merge', 'Rollback — SFTK CX — Accounts tree', 'Data Deployment — SFTK CX — Accounts tree']);
    expect(g.days[1].groups[0].entries.map(e => e.id)).toEqual(['t2', 't1']);
  });
  it('filters: by app and by text', () => {
    expect(F.sftkFeedGroups(E, NOW, { app: 'Toolkit' }).n).toBe(2);
    expect(F.sftkFeedGroups(E, NOW, { q: 'rollback' }).n).toBe(1);
    expect(F.sftkFeedGroups(E, NOW, { q: 'trailheads4' }).n).toBe(2);
  });
  it('an older day is dated', () => {
    expect(F.sftkFeedDayLabel('2026-10-20', NOW)).toMatch(/20/);
    expect(F.sftkFeedTime('2026-10-27T18:05:00')).toMatch(/18:05|6:05/);
  });
});

describe('both pages', () => {
  it('carry the 🧾 Activity button in the top bar and load the feed after the history store', () => {
    for (const f of ['popup.html', 'studio.html']) {
      const h = read(f);
      expect(h).toContain('id="sftkFeedBtn"');
      expect(h.indexOf('<script src="sftk-history.js">')).toBeLessThan(h.indexOf('<script src="sftk-feed.js">'));
      expect(h.indexOf('<script src="sftk-feed.js">')).toBeGreaterThan(0);
    }
    const F2 = read('sftk-feed.js');
    expect(F2).toContain("document.getElementById('sftkFeedBtn')?.addEventListener('click', open);");
    expect(F2).toContain('data-feed-tool');
    expect(F2).toContain('data-feed-studio="history"');
  });
});
