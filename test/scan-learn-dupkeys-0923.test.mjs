// runDiffScan — auto-learned pairs never come from an ambiguous key.
//
// Live 2026-09-23 (fixture SFTK CX, two source Accounts named "SFTK CX
// Duplicate Name", one in the target): the Sync Ring scan paired one twin
// with the target and LEARNED that pair; the Deploy page scanned a minute
// later with that memory, found the other twin unmatched, and counted it as
// "to insert" — Ring 7 missing, Deploy 8, and the 8th insert would have
// created a duplicate. A pair on a key the scan itself lists in dupKeys is a
// guess; it stays a warning and is never learned.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'studio-scan.js'), 'utf8');

describe('runDiffScan — learnedPairs skip ambiguous keys', () => {
  it('a row is learnable only when its matchKey is not in _dupKeys', () => {
    expect(SRC).toContain('const learnable = r => r.sourceId && r.targetId && !_dupKeys.has(r.matchKey);');
    const i = SRC.indexOf('const learnable = r =>');
    const block = SRC.slice(i, i + 600);
    expect(block).toMatch(/for \(const r of identical\) \{\s*if \(learnable\(r\)\) learnedPairs\.push/);
    expect(block).toMatch(/for \(const r of changed\) \{\s*if \(learnable\(r\)\) learnedPairs\.push/);
    expect(block).not.toMatch(/if \(r\.sourceId && r\.targetId\) learnedPairs\.push/);
  });
  it('_dupKeys is the same set the scan reports as dupKeys (declared before the learn block)', () => {
    expect(SRC.indexOf('let _dupKeys = new Set();')).toBeGreaterThan(0);
    expect(SRC.indexOf('let _dupKeys = new Set();')).toBeLessThan(SRC.indexOf('const learnable = r =>'));
  });
});
