import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// 2026-09-18 — user screenshot: a Contact section with nothing to do painted
// four empty buckets about 700px tall each.
const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../studio.css', import.meta.url), 'utf8');

describe('an empty child section is one line, not two screens', () => {
  it('all four buckets empty → a strip, and both grids are hidden', () => {
    expect(RC).toContain('const kidAllEmpty = !(cs.missingInTarget || []).length && !(cs.linkMismatch || []).length');
    expect(RC).toContain('Nothing to do for ${esc(childObj)}');
    expect(RC.split('ds-rec-cols ds-rec-cols-child${kidEmptyCls}').length - 1).toBe(2);
  });
  it('the strip still says what was left out and what is synced', () => {
    expect(RC).toContain('sftkPaContactsLine(_pa, orgLabel(p.sourceOrg), orgLabel(p.targetOrg))');
    expect(RC).toContain('synced (listed below)');
  });
  it('child grids size to their content; the root grid keeps its viewport bound', () => {
    expect(CSS).toContain('.ds-rec-cols.ds-rec-cols-child { height: auto; align-items: start;');
    expect(CSS).toContain('.ds-rec-cols-child .ds-rec-col { max-height: clamp(220px, 52vh, 480px); }');
    expect(CSS).toContain('height: clamp(320px, calc(100vh - 360px), 700px);');
  });
});
