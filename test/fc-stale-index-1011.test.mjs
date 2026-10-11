import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');

// User 2026-10-11, trailheads4: the Field Cleaner listed "SFTK FC Test Page" under Lightning
// Pages while its inspector said "no refs found" — the page's DESCRIPTION mentions the field's
// API name, and Salesforce's dependency index matches on text. Such an item has nothing to
// remove and must not keep Delete Field locked.
describe('an index entry with no real reference is settled, and says why', () => {
  it('the inspector marks a page/layout with zero refs as done with the reason', () => {
    expect(FC).toContain("if (!refCount && !delCount && fixable && type !== 'Flow' && type !== 'ApexClass' && type !== 'ApexTrigger') {");
    expect(FC).toContain("markFixed(componentId, '✅ Nothing uses the field here — Salesforce lists it because its description or another text mentions the field’s name. Nothing to remove.');");
  });
  it('a flow with no reference keeps its own path (the plan says so)', () => {
    expect(FC).toContain("markFixed(componentId, '✅ No version of this flow references the field any more');");
  });
});
