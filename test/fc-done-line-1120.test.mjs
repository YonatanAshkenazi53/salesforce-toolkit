// owner 2026-11-20: "can we make the success line more satisfying to look at" — the done line of a Field Cleaner row
// is a chip for the verb, plain words for what happened and a small "verified in the org" mark.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const { fcDoneParts: p } = extractFunctions('field-cleaner.js', ['fcDoneParts']);

describe('a done label in its parts', () => {
  it('verb, what happened, verified', () => {
    expect(p('✅ Deleted — the Apex class is gone — verified by re-reading the org')).toEqual({ verb: 'Deleted', detail: 'the Apex class is gone', verified: true });
    expect(p('✅ Removed — the filter had no other condition — the whole lookup filter is removed; the lookup field and its data stay — verified by re-reading the org'))
      .toEqual({ verb: 'Removed', detail: 'the filter had no other condition — the whole lookup filter is removed; the lookup field and its data stay', verified: true });
  });
  it('a label with no short verb is all detail under Done; a bare label is Done', () => {
    expect(p('✅ No version of this flow references the field any more')).toEqual({ verb: 'Done', detail: 'No version of this flow references the field any more', verified: false });
    expect(p('✅ Done')).toEqual({ verb: 'Done', detail: '', verified: false });
    expect(p('')).toEqual({ verb: 'Done', detail: '', verified: false });
  });
  it('an undone row keeps "put back" and its verified mark', () => {
    expect(p('↩ Undone — put back, verified by re-reading the org')).toEqual({ verb: 'Undone', detail: 'put back', verified: true });
    expect(p('↩ Undone — the class is back — verified by re-reading the org')).toEqual({ verb: 'Undone', detail: 'the class is back', verified: true });
  });
});

describe('the row draws them', () => {
  it('chip, detail, mark — escaped; the full label is kept for the run report', () => {
    expect(FC).toContain('<span class="fc-item-ok" data-label="${esc(label)}">${_okHtml(label)}${extraLinksHtml}</span>');
    expect(FC).toContain("(item.querySelector('.fc-item-ok')?.dataset.label || 'Done').replace(/^✅\\s*/, '').trim()");
    expect(FC).toContain("esc(same ? 'Nothing to do' : p.verb)");
    expect(FC).toContain('<span class="fc-ok-what">${esc(p.detail)}</span>');
  });
  it('colours come from the theme tokens, so dark follows; motion is optional', () => {
    expect(CSS).toContain('background: var(--c-good-bg); color: var(--c-good-fg); border: 1px solid var(--c-good-border); }');
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce) { .fc-ok-tick { animation: none; } }');
    expect(CSS).not.toContain('.fc-item-fixed { opacity: .65; }');
  });
});
