import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const SRC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');

// QA 2026-10-06 (live, trailheads4): Engine = "Async — Bulk API 2.0 job" ran one ingest
// job (CLI: jobs/ingest, Account insert, JobComplete) but the Deploy page's History entry
// carried no `viaBulk`, so the card and the CSV never said "via Bulk" for such a run.
describe('a Deploy-page run keeps the engine fact (viaBulk) in its History entry', () => {
  it('reads it off the engine summary and writes it into the root object summary', () => {
    expect(SRC).toContain('if (s.viaBulk) counts.viaBulk = true;');
    const summaryAt = SRC.indexOf('inserted: counts.inserted, insertedFailed: counts.insertedFailed,');
    expect(summaryAt).toBeGreaterThan(0);
    const block = SRC.slice(summaryAt, summaryAt + 900);
    expect(block).toContain('...(counts.viaBulk ? { viaBulk: true } : {}),');
  });
  it('child objects keep it too', () => {
    expect(SRC).toContain('if (cSum.viaBulk) childCounts[obj].viaBulk = true;');
    expect(SRC).toContain('if (s2.viaBulk) childCounts[obj].viaBulk = true;');
    expect(SRC).toContain('if (rs.viaBulk) childCounts[rObj].viaBulk = true;');
    expect(SRC).toContain('inserted: c.created, insertedFailed: c.failed,\n          ...(c.viaBulk ? { viaBulk: true } : {}),');
  });
  it('History renders the tag off exactly that key', () => {
    const HIST = readFileSync(new URL('../studio-history.js', import.meta.url), 'utf8');
    expect(HIST).toContain('if (s.viaBulk)  parts.push(');
  });
});
