// QA 1.1 finding 11: an exported CSV cell that begins with = + - @ must not open as a formula.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

const S = extractFunctions('sftk-sweep.js', ['sftkSweepCsv']);

const csvOf = (texts, extra = {}) => S.sftkSweepCsv({ byType: {
  EmailTemplate: { label: 'Email Templates', sev: 'mention', items: [{ component: 'unfiled$public/T', path: 'email/unfiled$public/T.email', ...extra, lines: texts.map((text, i) => ({ line: i + 1, text })) }] },
} }, 'Account', 'Status__c');
// the "text" cell of each data row, read back the way a CSV reader does
const parse = csv => csv.split('\r\n').filter(Boolean).map(row => {
  const cells = []; let cur = '', q = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (q) { if (ch === '"' && row[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
});

describe('sftkSweepCsv — no cell is a formula', () => {
  it('a line that starts with = + - @ is written as text, with a leading apostrophe', () => {
    const lines = ['=HYPERLINK("http://x","y") {!Account.Status__c}', "+ ',Status__c FROM Account';", '- Status__c is read here', '@track Status__c;'];
    const rows = parse(csvOf(lines));
    expect(rows.length).toBe(5);
    rows.slice(1).forEach((r, i) => {
      expect(r.length).toBe(10);
      expect(r[7]).toBe("'" + lines[i]);          // the whole line is still there, after the apostrophe
    });
    for (const r of rows) for (const c of r) expect(/^[=+\-@\t\r]/.test(c), c).toBe(false);
  });
  it('the indentation of the line does not hide the leading sign', () => {
    expect(parse(csvOf(['      + Status__c']))[1][7]).toBe("'+ Status__c");
  });
  it('every column is covered: a component, a section or a path from the org', () => {
    const csv = S.sftkSweepCsv({ byType: { Other: { label: '=Kinds', sev: 'mention', items: [{ component: '=cmd', section: '@sec', path: '-dir/file', lines: [{ line: 3, text: 'Status__c', file: '+inner' }] }] } } }, '=Obj', 'F__c');
    const r = parse(csv)[1];
    expect(r[0]).toBe("'=Obj.F__c");
    expect(r[1]).toBe("'=Kinds (Other)");
    expect(r[3]).toBe("'=cmd");
    expect(r[4]).toBe("'@sec");
    expect(r[5]).toBe("'-dir/file › +inner");
    expect(r[6]).toBe('3');                       // a line number stays a number
  });
  it('an ordinary line is written exactly as before', () => {
    const csv = csvOf(['return a.Status__c, "x";', '<field>Account.Status__c</field>', 'a = Status__c - 1']);
    const rows = csv.split('\r\n');
    expect(rows[1].endsWith(',1,"return a.Status__c, ""x"";",no,no')).toBe(true);
    expect(rows[2].endsWith(',2,<field>Account.Status__c</field>,no,no')).toBe(true);
    expect(rows[3].endsWith(',3,a = Status__c - 1,no,no')).toBe(true);
  });
});
