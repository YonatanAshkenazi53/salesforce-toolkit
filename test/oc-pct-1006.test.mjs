import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const SRC = readFileSync(new URL('../studio-compare.js', import.meta.url), 'utf8');
const start = SRC.indexOf('function sftkOcMatchPct(');
const fn = new Function(SRC.slice(start, SRC.indexOf('\n}\n', start) + 3) + ' return sftkOcMatchPct;')();

// QA 2026-10-06 (live): Org Compare said "100%" for Account with 7 missing and for
// Contact with 6 missing — a rounded number that means "nothing is missing".
describe('Org Compare: the match percentage never says 100 while something is missing', () => {
  it('is used for every row', () => {
    expect(SRC).toContain('const pct = sftkOcMatchPct(matched, missing, extras);');
    expect(SRC).not.toContain('Math.round(matched / denom * 100)');
  });
  it('the live numbers', () => {
    expect(fn(10075, 7, 812)).toBe(99.9);
    expect(fn(9868, 6, 5250)).toBe(99.9);
    expect(fn(86, 4, 6000)).toBe(96);
  });
  it('edges', () => {
    expect(fn(10, 0, 3)).toBe(100);
    expect(fn(0, 10, 0)).toBe(0);
    expect(fn(1, 9999, 0)).toBe(0.1);
    expect(fn(0, 0, 0)).toBe(100);
    expect(fn(0, 0, 5)).toBe(0);
    expect(fn(3, 1, 0)).toBe(75);
  });
});

// QA 2026-10-06: two buttons both called "Deploy" on every row — one opens the Deploy
// page, the other only saves a deployment. The second says what it does.
describe('Org Compare: the two row buttons are told apart', () => {
  it('🚀 Deploy opens the page; the saver is "Save as deployment"', () => {
    expect(SRC).toContain('data-oc-reconcile="${esc(r.name)}">🚀 Deploy</button>');
    expect(SRC).toContain('with this org pair and match field — nothing is written">📦 Save as deployment</button>');
    expect(SRC).not.toContain('>📦 Deploy</button>');
  });
});
