// Numbers in the apps' English text are always en-US (2026-11-15, owner decision).
//
// WHY: the UI is English only, yet ~250 sites called Number.prototype.toLocaleString() with no locale, so a German
// or Romanian browser showed "1.250 records" inside an English sentence (and 7 tests failed under LANG=de-DE / ro-RO).
// Every NUMBER site now passes 'en-US'. DATES are deliberately left on the browser's own locale - a date in the
// reader's format is a courtesy, a thousands separator that flips meaning is a bug.
//
// Part 1 scans the shipped root *.js: every toLocaleString / NumberFormat there must pass exactly 'en-US'. The only
// other calls allowed are the date sites listed below, by file + a code fragment of the line. This scan is what
// covers all ~250 sites.
// Part 2 is a spot check, not the cover: three real formatters run with the engine's default number locale forced
// to German and must still print '1,250'.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { extractFunction } from './extract.mjs';

const ROOT = new URL('../', import.meta.url);
const FILES = readdirSync(ROOT).filter(f => f.endsWith('.js'));
const read = f => readFileSync(new URL(f, ROOT), 'utf8');

// Date sites: `new Date(...).toLocaleString()` - out of scope, left exactly as they were.
const DATE_ALLOW = [
  ['apex-debugger.js',    'new Date(log.StartTime).toLocaleString()'],
  ['apex-debugger.js',    'new Date(meta.StartTime).toLocaleString()'],
  ['apex-debugger.js',    'new Date(l.StartTime).toLocaleString()'],
  ['apex-log-viewer.js',  'new Date(meta.StartTime).toLocaleString()'],
  ['debug-logger.js',     'new Date().toLocaleString()'],
  ['field-cleaner.js',    'new Date(deleted.at).toLocaleString()'],
  ['field-cleaner.js',    'new Date(s.at).toLocaleString()'],
  ['sftk-terms.js',       'new Date(stored.acceptedAt).toLocaleString()'],
  ['studio-readiness.js', 'new Date().toLocaleString()'],
  ['studio-rollback.js',  'new Date(iso).toLocaleString()'],
  ['studio-undo.js',      'new Date(e.at).toLocaleString()'],
];

// The rule is positive (review 2026-11-15): the first scan looked for three default-locale spellings on one line, so
// toLocaleString(navigator.language), (void 0), (loc), ("de-DE"), a call split over two lines, ?.toLocaleString?.(),
// ["toLocaleString"]() and Intl.NumberFormat in most spellings all passed. Now EVERY mention of toLocaleString in
// code must be exactly .toLocaleString('en-US') or .toLocaleString('en-US', {options}), or an allow-listed date
// site; every mention of NumberFormat must be Intl.NumberFormat('en-US'. Whole comment lines are not code.
const EN = /^\.toLocaleString\('en-US'\s*[,)]/;
const NF_EN = /^Intl\.NumberFormat\('en-US'\s*[,)]/;
function offendersIn(f, src) {
  const out = [];
  const lineOf = i => src.slice(0, i).split('\n').length;
  const lineText = i => src.slice(src.lastIndexOf('\n', i - 1) + 1, (src.indexOf('\n', i) + 1 || src.length + 1) - 1);
  const isComment = i => /^\s*(\/\/|\*|\/\*)/.test(lineText(i));
  for (const m of src.matchAll(/toLocaleString/g)) {
    if (isComment(m.index)) continue;
    if (src[m.index - 1] === '.' && EN.test(src.slice(m.index - 1, m.index + 40))) continue;
    const upTo = src.slice(0, m.index + 'toLocaleString'.length) + '()';
    if (src.startsWith('()', m.index + 'toLocaleString'.length) && DATE_ALLOW.some(([af, frag]) => af === f && upTo.endsWith(frag))) continue;
    out.push(`${f}:${lineOf(m.index)}  ${lineText(m.index).trim().slice(0, 140)}`);
  }
  for (const m of src.matchAll(/NumberFormat/g)) {
    if (isComment(m.index)) continue;
    if (src.slice(m.index - 5, m.index) === 'Intl.' && NF_EN.test(src.slice(m.index - 5, m.index + 40))) continue;
    out.push(`${f}:${lineOf(m.index)}  ${lineText(m.index).trim().slice(0, 140)}`);
  }
  return out;
}

describe('no number is formatted with the browser default locale', () => {
  it('scans more than a handful of files (the scan is not empty)', () => {
    expect(FILES.length).toBeGreaterThan(40);
    expect(FILES).toContain('sftk-run-progress.js');
  });

  it('every toLocaleString / NumberFormat in the root *.js passes en-US or is an allow-listed date site', () => {
    const offenders = FILES.flatMap(f => offendersIn(f, read(f)));
    expect(offenders, `number sites must pass 'en-US':\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the scan sees the en-US sites and the date sites it lets through (it is not vacuous)', () => {
    const all = FILES.map(read).join('\n');
    expect((all.match(/\.toLocaleString\('en-US'\)/g) || []).length).toBeGreaterThan(200);
    expect(offendersIn('x.js', "const a = n.toLocaleString('en-US');\nconst b = n.toLocaleString('en-US', { maximumFractionDigits: 1 });\nconst c = new Intl.NumberFormat('en-US').format(n);\n// a note about toLocaleString() and Intl.NumberFormat()\n")).toEqual([]);
    expect(offendersIn('debug-logger.js', 'x = ${new Date().toLocaleString()}')).toEqual([]);
  });

  it('the rule catches every other spelling of a browser-locale number', () => {
    const bad = [
      'n.toLocaleString()', 'n.toLocaleString(undefined)', 'n.toLocaleString([])',
      'n.toLocaleString(navigator.language)', 'n.toLocaleString(void 0)', 'n.toLocaleString(loc)', 'n.toLocaleString("de-DE")',
      "n.toLocaleString('en-GB')", 'n.toLocaleString(/* x */)', 'n.toLocaleString ()', 'n?.toLocaleString?.()', 'n["toLocaleString"]()',
      'n.toLocaleString(\n)', "n.toLocaleString('en-US' + x)", 'const f = n.toLocaleString; f.call(n)',
      'new Intl.NumberFormat(navigator.language).format(n)', 'new Intl.NumberFormat;', 'new Intl.NumberFormat().format(n)',
      'new Intl.NumberFormat(undefined).format(n)', 'const { NumberFormat } = Intl;',
      // a date call is let through only in its own file, as its own listed fragment
      'new Date(other).toLocaleString()', 'count.toLocaleString() // new Date().toLocaleString()',
    ];
    for (const line of bad) expect(offendersIn('x.js', `const v = ${line};\n`).length, line).toBeGreaterThan(0);
    expect(offendersIn('popup.js', 'x = new Date().toLocaleString()').length).toBe(1);   // listed for debug-logger.js, not here
  });

  it('the allow-list carries no stale entry', () => {
    for (const [f, frag] of DATE_ALLOW) expect(read(f), `${f}: ${frag}`).toContain(frag);
  });

  it('the allow-list is dates only', () => {
    for (const [, frag] of DATE_ALLOW) expect(frag.startsWith('new Date(')).toBe(true);
  });
});

describe('real formatters give 1,250 when the default locale is German', () => {
  // Proves independence rather than assuming the machine's locale: the default path of BOTH number formatters
  // (no argument, undefined, or an empty list) is rerouted to de-DE, so a formatter below that still relied on the
  // default would print "1.250". Only these three are run; every other site rests on the Part 1 scan.
  const origTLS = Number.prototype.toLocaleString;
  const OrigNF = Intl.NumberFormat;
  const germanDefault = () => {
    const dflt = loc => loc === undefined || (Array.isArray(loc) && loc.length === 0);
    Number.prototype.toLocaleString = function (loc, opts) { return origTLS.call(this, dflt(loc) ? 'de-DE' : loc, opts); };
    Intl.NumberFormat = function (loc, opts) { return new OrigNF(dflt(loc) ? 'de-DE' : loc, opts); };
  };
  afterEach(() => {
    Number.prototype.toLocaleString = origTLS;
    Intl.NumberFormat = OrigNF;
  });

  it('the stub really makes the default German (the control)', () => {
    germanDefault();
    expect((1250).toLocaleString()).toBe('1.250');
    expect((1250).toLocaleString([])).toBe('1.250');
    expect((1250).toLocaleString(undefined)).toBe('1.250');
    expect((1250).toLocaleString('en-US')).toBe('1,250');
  });

  it('sftkRunFmtN (sftk-run-progress.js)', () => {
    const { sftkRunFmtN } = new Function(`${read('sftk-run-progress.js')}\nreturn { sftkRunFmtN };`)();
    germanDefault();
    expect(sftkRunFmtN(1250)).toBe('1,250');
    expect(sftkRunFmtN('1234567')).toBe('1,234,567');
    expect(sftkRunFmtN('x')).toBe('?');
  });

  it('sftkFeedCounts (sftk-feed.js): the Activity line', () => {
    const { sftkFeedCounts } = new Function(`${read('sftk-feed.js')}\nreturn { sftkFeedCounts };`)();
    germanDefault();
    const txt = sftkFeedCounts({ kind: 'deploy', summary: { Account: { created: 1250, failed: 2500 } } });
    expect(txt).toContain('1,250');
    expect(txt).toContain('2,500');
    expect(txt).not.toMatch(/\d\.\d{3}/);
  });

  it('pkApiCostLine (studio-picklists.js): the API cost line', () => {
    const pkApiCostLine = extractFunction('studio-picklists.js', 'pkApiCostLine');
    germanDefault();
    expect(pkApiCostLine({ total: 1250, known: true }, null).text).toBe('≈1,250 API calls');
  });
});
