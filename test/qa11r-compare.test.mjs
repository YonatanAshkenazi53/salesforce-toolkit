// QA 1.1 regression run, critic finding C1 (the studio-compare.js part):
// Org Compare's CSV wrote org text raw, so a cell opening with = + - @ was run
// as a formula by Excel / Sheets. The cell writer now guards it the same way
// histCsvEscape (studio-history.js) and sftkSweepCsv do.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'studio-compare.js'), 'utf8');
const cell = extractFunction('studio-compare.js', 'sftkOcCsvCell');
const histCell = extractFunction('studio-history.js', 'histCsvEscape');

describe('C1: Org Compare CSV cells cannot run as a formula', () => {
  it('prefixes an apostrophe to a cell that opens with = + - @, a tab or a carriage return', () => {
    expect(cell('=1+1')).toBe("'=1+1");
    expect(cell('+972 52 000')).toBe("'+972 52 000");
    expect(cell('-5')).toBe("'-5");
    expect(cell('@name')).toBe("'@name");
    expect(cell('\tx')).toBe("'\tx");
    expect(cell('\rx')).toBe('"\'\rx"');
  });

  it('guards first and quotes second, so a formula with quotes and commas stays one text cell', () => {
    expect(cell('=HYPERLINK("http://x.example","open")'))
      .toBe('"\'=HYPERLINK(""http://x.example"",""open"")"');
  });

  it('leaves ordinary cells as they were: numbers, empty, null, text with a sign inside', () => {
    expect(cell(42)).toBe('42');
    expect(cell(0)).toBe('0');
    expect(cell('')).toBe('');
    expect(cell(null)).toBe('');
    expect(cell(undefined)).toBe('');
    expect(cell('Account__c')).toBe('Account__c');
    expect(cell('a=b')).toBe('a=b');
    expect(cell('cannot tell')).toBe('cannot tell');
  });

  it('still quotes commas, quotes and line breaks, a lone carriage return included', () => {
    expect(cell('a,b')).toBe('"a,b"');
    expect(cell('say "hi"')).toBe('"say ""hi"""');
    expect(cell('a\nb')).toBe('"a\nb"');
    expect(cell('a\rb')).toBe('"a\rb"');
  });

  it('gives the same result as the History export guard for every case', () => {
    const cases = ['=1', '+1', '-1', '@a', '\ta', '\ra', 'a,b', 'a"b', 'a\r\nb', 'plain', '', null, undefined, 7,
      '=HYPERLINK("http://x.example","open")'];
    for (const c of cases) expect(cell(c)).toBe(histCell(c));
  });

  // The export itself, run for real: once with the shared cell writer in scope
  // and once alone (the inline fallback), on rows whose object name and detail
  // open with a formula character.
  const runExport = withHelper => {
    const blobs = [];
    const state = { srcOrgUrl: 'https://a.example', tgtOrgUrl: 'https://b.example', results: [
      { name: 'Account', error: '=HYPERLINK("http://x.example","open")' },
      { name: 'Contact', skipped: true, reason: '+972 52 000, no match field' },
      { name: '@Odd__c', matchField: 'Ext__c', srcCount: 2, tgtCount: 2, matched: 2, missing: 0, extras: 0,
        srcBlank: 0, tgtBlank: 0, matchPct: 100, note: '-5 left' },
      { name: 'Lead', status: 'pending', error: '=never exported' },
    ] };
    const env = {
      state, blobs,
      Blob: function (parts) { blobs.push(parts.join('')); },
      URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
      document: { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } },
    };
    new Function('env', `
      const { Blob, URL, document } = env;
      const _orgCompareState = env.state;
      const showToast = () => {}; const setTimeout = () => {};
      const orgLabel = u => u; const sftkLocalDay = () => '2026-01-01';
      const sftkOcRowStatus = ${extractFunction('studio-compare.js', 'sftkOcRowStatus').toString()};
      ${withHelper ? cell.toString() : ''}
      (${extractFunction('studio-compare.js', '_ocExportCsv').toString()})();
    `)(env);
    return blobs[0];
  };

  for (const withHelper of [true, false]) {
    it(`the exported file carries the guard in the object and detail columns (${withHelper ? 'shared cell writer' : 'function loaded alone'})`, () => {
      const lines = runExport(withHelper).split('\r\n');
      expect(lines).toHaveLength(4); // header + 3 rows, the pending row left out
      expect(lines[1]).toBe('Account,error,,,,,,,,,,"\'=HYPERLINK(""http://x.example"",""open"")"');
      expect(lines[2]).toBe('Contact,skipped,,,,,,,,,,"\'+972 52 000, no match field"');
      expect(lines[3]).toBe("'@Odd__c,clean,Ext__c,2,2,2,0,0,0,0,100,'-5 left");
      // no data cell of the file opens with a formula character
      for (const line of lines.slice(1)) expect(line).not.toMatch(/(^|,)"?[=+\-@]/);
    });
  }

  it('the export uses the guarded cell writer and no unguarded one of its own', () => {
    const start = src.indexOf('function _ocExportCsv()');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body).toContain("const cell = typeof sftkOcCsvCell === 'function' ? sftkOcCsvCell :");
    expect(body).toContain('].map(cell).join(\',\')');
    // the inline fallback (used when the function is loaded alone) carries the guard too
    expect(body).toContain('if (/^[=+\\-@\\t\\r]/.test(s)) s = "\'" + s;');
    expect(body).not.toContain('const s = v == null');
  });
});
