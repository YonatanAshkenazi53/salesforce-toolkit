import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const DV = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const SEC = readFileSync(new URL('../scripts/dev/video/sections.mjs', import.meta.url), 'utf8');

// User 2026-10-16: "make sure the reconcile window says it when we choose bulk api" — Bulk API 2.0
// has no header to bypass duplicate rules (background.js writes a Bypass run through Collections
// whatever the Engine says), and it takes no batch size or threads. The page must say so, not
// only the run's diagnostics afterwards.
const i = RC.indexOf('function sftkEngineNote(');
const note = new Function(RC.slice(i, RC.indexOf('\n}\n', i) + 3) + ' return sftkEngineNote;')();

describe('sftkEngineNote: what the Engine and the Duplicate rules choice mean together', () => {
  it('Bulk with rules respected: the rules run, Bypass would move the run to Collections', () => {
    const n = note({ apiMode: 'bulk' });
    expect(n.kind).toBe('info');
    expect(n.text).toContain('cannot bypass them');
    expect(n.text).toContain('Choosing Bypass moves the deployment to Collections calls');
  });
  it('Bulk with Bypass: a warning — the run is Collections after all, batch size and threads apply', () => {
    const n = note({ apiMode: 'bulk', duplicateRules: 'bypass' });
    expect(n.kind).toBe('warn');
    expect(n.text).toContain('written through synchronous Collections calls instead');
    expect(n.text).toContain('batch size and threads apply');
  });
  it('Auto with Bypass names the threshold the Bypass overrides', () => {
    expect(note({ duplicateRules: 'bypass' }).text).toContain('also at or above 2,000 records');
    expect(note({ duplicateRules: 'bypass', bulkThreshold: 500 }).text).toContain('also at or above 500 records');
  });
  it('nothing to say for Auto or Collections with rules respected', () => {
    expect(note({})).toBeNull();
    expect(note({ apiMode: 'auto' })).toBeNull();
    expect(note({ apiMode: 'sync' })).toBeNull();
    expect(note({ apiMode: 'sync', duplicateRules: 'bypass' })).toBeNull();
    expect(note(null)).toBeNull();
  });
});

describe('the Deploy view draws the note and keeps the inputs honest', () => {
  it('the note is rendered on the action bar from sftkEngineNote, escaped, warn-classed', () => {
    expect(DV).toContain('const n = sftkEngineNote(p); return n ? `<span id="dsDepEngineNote" class="ds-dep-enginenote${n.kind === \'warn\' ? \' ds-dep-enginenote-warn\' : \'\'}">${esc(n.text)}</span>` : \'\';');
  });
  it('batch size and threads are hidden only when the run really is Bulk (not for a Bypass run)', () => {
    expect(DV).toContain("${p.apiMode === 'bulk' && p.duplicateRules !== 'bypass'\n          ? `<span class=\"ds-dep-sub\"");
  });
  it('changing the duplicate-rules choice redraws the page, so the note follows it', () => {
    expect(DV).toContain("eid('dsDepDupRules')?.addEventListener('change', async e => { await sftkRecSetEngine(p, 'duplicateRules', e.target.value); renderDeploy(); });");
  });
  it('the walkthrough shows it on camera and puts the deployment’s own settings back', () => {
    expect(SEC).toContain("await choose('#dsDepApiMode', 'bulk', \"!!document.querySelector('#dsDepEngineNote') && !document.querySelector('#dsDepBatch')\");");
    expect(SEC).toContain("await choose('#dsDepDupRules', 'bypass', \"!!document.querySelector('#dsDepEngineNote.ds-dep-enginenote-warn') && !!document.querySelector('#dsDepBatch')\");");
    expect(SEC).toContain("await choose('#dsDepApiMode', eng0.apiMode,");
  });
});
