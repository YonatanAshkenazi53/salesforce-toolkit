// QA 1.1 regression run, lane "depmap": finding #23 (text that sent the user to a Dependencies view that is now a fold
// on the Flows page) and the dependency-map.js part of C1 (the Flows dependency report CSV wrote org text raw).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunction } from './extract.mjs';
const SRC = readFileSync(new URL('../dependency-map.js', import.meta.url), 'utf8');
const depReportCsv = extractFunction('dependency-map.js', 'depReportCsv');
const histCsvEscape = extractFunction('studio-history.js', 'histCsvEscape');

describe('C1: the Flows dependency report CSV does not hand a spreadsheet a formula', () => {
  const report = {
    org: { label: '=cmd|x' }, generatedAt: 't', flowCount: 3,
    notes: ['+1 more', 'plain note'],
    dead: {
      dead: [{ apiName: 'Sub_A', masterLabel: '=HYPERLINK("http://x.example","open")', status: 'Draft', reason: 'r', callers: [] }],
      inactiveTargets: [{ apiName: 'Sub_B', masterLabel: '@name', status: '-', callers: [] }],
      managedTargets: [{ apiName: 'ns__Sub_C', masterLabel: '\tTabbed', active: true, callers: [] }],
    },
    chains: [{ apiName: 'Main', masterLabel: '-5', down: { root: { apiName: 'Main', children: [{ apiName: 'Sub_A' }] } } }],
  };
  const lines = depReportCsv(report).split('\r\n');

  it('a cell that starts with = + - @ or a tab gets a leading apostrophe; quoting is kept', () => {
    expect(lines.find(l => l.startsWith('Meta,,,,Org,'))).toBe("Meta,,,,Org,'=cmd|x");
    expect(lines).toContain("Meta,,,,Limit,'+1 more");
    expect(lines.find(l => l.startsWith('Dead subflow,Sub_A,'))).toContain(`,"'=HYPERLINK(""http://x.example"",""open"")",Draft,`);
    expect(lines.find(l => l.startsWith('Inactive subflow target,Sub_B,'))).toContain(",'@name,'-,No Active version,");
    expect(lines.find(l => l.startsWith('Managed subflow target,'))).toContain(",'\tTabbed,Active,");
    expect(lines.find(l => l.startsWith('Chain edge,'))).toBe("Chain edge,Main,'-5,,Main calls Sub_A,");
  });
  it('no cell of the file starts with a formula character', () => {
    for (const l of lines) for (const c of l.split(',')) expect(c).not.toMatch(/^"?[=+\-@\t\r]/);
  });
  it('an ordinary cell is written as before, and the rule is the one of the History export', () => {
    expect(lines[0]).toBe('Section,Flow API Name,Flow Label,Status,Item,Detail');
    expect(lines).toContain('Meta,,,,Limit,plain note');
    expect(lines).toContain('Meta,,,,Flows in scope,3');
    expect(depReportCsv({ org: { label: 'Acme, Inc "HQ"' } })).toContain('"Acme, Inc ""HQ"""');
    for (const v of ['=1+1', '+972 52', '-5', '@x', 'a=b', 'x-1', '']) {
      const got = depReportCsv({ org: { label: v || 'unknown' } }).split('\r\n')[1].split(',').pop();
      expect(got).toBe(histCsvEscape(v || 'unknown'));
    }
  });
});

describe('#23: the Switches panel names the place where the scan is run', () => {
  it('no on-screen string sends the user to a Dependencies view or tab', () => {
    const strings = SRC.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).map(l => l.replace(/\/\/.*$/, ''));
    for (const l of strings) expect(l).not.toMatch(/(in|on|to) the Dependencies (view|tab)/);
  });
  it('the empty subflow note points at the Flows view and its scan button', () => {
    expect(SRC).toContain('come from the dependency scan — run it on the 🗂 Flows view (🔗 Scan dependencies) to see them here.');
    expect(SRC).toContain('Subflow links appear when the dependency scan finishes.');
  });
});
