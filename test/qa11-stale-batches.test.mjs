// QA 1.1 findings 72, 73: the release gate runs the All at once plan, and the Field Cleaner video chapter drives the 1.1 controls.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BATCHES } from '../scripts/dev/qa/batches.mjs';

const SEC = readFileSync(new URL('../scripts/dev/video/sections.mjs', import.meta.url), 'utf8');
const chapter = SEC.slice(SEC.indexOf("{ id: 'fields'"), SEC.indexOf("{ id: 'copy-perms'"));

describe('QA batches (72)', () => {
  it('no step runs the removed .fc-fix-every walk', () => {
    for (const [name, steps] of Object.entries(BATCHES)) for (const s of steps) {
      expect(s.name, name).not.toBe('fr-every-replace');
      expect(JSON.stringify(s.env || {}), `${name}/${s.name}`).not.toContain('"every"');
    }
  });
  it('the toolkit and qa11 batches run the All at once plan', () => {
    for (const b of ['toolkit', 'qa11']) {
      const step = BATCHES[b].find(s => s.name === 'fc-plan-all-at-once');
      expect(step, b).toBeTruthy();
      expect(step.script).toMatch(/fc-plan\.mjs$/);
    }
  });
});

describe('Field Cleaner video chapter (73)', () => {
  it('has no selector of a control 1.1 removed', () => {
    for (const gone of [/\.fc-fix-all(?![\w-])/, /\.fc-fix-every(?![\w-])/, /#fcToolHist/]) expect(chapter, String(gone)).not.toMatch(gone);
  });
  it('drives the All at once plan and fails instead of narrating work that did not run', () => {
    expect(chapter).toContain("'#fcFixEvery .fc-plan-btn'");
    expect(chapter).toMatch(/if \(!\(await c\.has\(planBtn\)\)\) throw new Error/);
    expect(chapter).toContain('#fcPlanRepClose');
  });
  it('says Activity, not History, for the tool\'s changes', () => {
    expect(SEC).not.toMatch(/tool’s History|kept in History/);
  });
});
