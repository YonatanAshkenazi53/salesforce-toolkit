// owner 2026-11-20: "when i click hide noise here nothing happens" — a short DEBUG-level log: its bulk is the
// governor-limits block, which was not counted as noise, so the button hid nothing and said nothing.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const SRC = readFileSync(new URL('../apex-debugger.js', import.meta.url), 'utf8');
const i = SRC.indexOf('  function _logNoiseMask(lines) {');
const mask = new Function(SRC.slice(i, SRC.indexOf('\n  }\n', i) + 4) + '; return _logNoiseMask;')();

const LOG = [
  '68.0 APEX_CODE,DEBUG;APEX_PROFILING,INFO',
  'Execute Anonymous: System.debug(1);',
  '17:45:19.33 (33231203)|USER_INFO|[EXTERNAL]|005|me@x.com|(GMT+02:00) Israel Standard Time (Asia/Jerusalem)|GMT+02:00',
  '17:45:19.33 (33248013)|EXECUTION_STARTED',
  '17:45:19.33 (33786508)|USER_DEBUG|[1]|DEBUG|probe',
  '17:45:19.46 (46376520)|CUMULATIVE_LIMIT_USAGE',
  '17:45:19.46 (46376520)|LIMIT_USAGE_FOR_NS|(default)|',
  '  Number of SOQL queries: 1 out of 100',
  '  Number of query rows: 1 out of 50000',
  '',
  '17:45:19.46 (46376520)|CUMULATIVE_LIMIT_USAGE_END',
  '',
  '17:45:19.46 (46400000)|CODE_UNIT_FINISHED|execute_anonymous_apex',
  '17:45:19.46 (46410000)|EXECUTION_FINISHED',
];

describe('what Hide noise hides', () => {
  it('the limits block from its first line to its END line, with its indented rows', () => {
    const m = mask(LOG);
    expect(m.slice(0, 5)).toEqual([false, false, false, false, false]);   // header, user info, the debug line stay
    expect(m.slice(5, 11)).toEqual([true, true, true, true, true, true]);
    expect(m.slice(12)).toEqual([false, false]);                           // the block is closed: what follows stays
  });
  it('the blank line right after the block goes with it; nothing else does', () => {
    expect(mask(LOG)[11]).toBe(true);
    expect(mask(LOG).filter(Boolean).length).toBe(7);
  });
  it('the high-volume events, and a line that continues one', () => {
    expect(mask(['10:00:00.1 (1)|HEAP_ALLOCATE|[5]|Bytes:4', '10:00:00.1 (2)|USER_DEBUG|[6]|DEBUG|a', 'second line of the debug', '10:00:00.1 (3)|VARIABLE_ASSIGNMENT|[7]|x|"long', 'value"']))
      .toEqual([true, false, false, true, true]);
  });
  it('a multi-line debug message is never hidden', () => {
    expect(mask(['10:00:00.1 (2)|USER_DEBUG|[6]|DEBUG|{', '  "a": 1', '}'])).toEqual([false, false, false]);
  });
  it('nothing read is nothing hidden', () => { expect(mask(null)).toEqual([]); });
});

describe('the button says what it did', () => {
  it('a count when lines were hidden, a plain sentence when the log has none', () => {
    expect(SRC).toContain("const noise = cat === 'nonoise' ? _logNoiseMask(st.lines) : null;");
    expect(SRC).toContain('lines hidden: the limits and profiling blocks, heap, statement and system-method lines.');
    expect(SRC).toContain("'This log has no noise lines to hide: no limits or profiling block, no heap, statement or system-method lines.'");
    expect(SRC).toContain('if (noise ? noise[i] : (cat && !_logMatchesCat(line, cat))) continue;');
  });
});
