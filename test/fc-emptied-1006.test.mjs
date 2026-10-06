import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const SRC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');

// QA 2026-10-06 (live on trailheads5): "✂ Remove · flow keeps running" on SFTK FC Test Flow,
// whose Assignment has the field as its only line, was confirmed and then refused by
// Salesforce ("Required field is missing: assignmentItems"). The preview knows which
// elements the fix would leave empty — the button is refused BEFORE the dialog, like the
// other way that cannot work, and the message names the ways that do.
describe('Field Cleaner refuses "flow keeps running" up front when the fix would leave an element empty', () => {
  it('is checked right after the "nothing can be taken out" refusal, before any dialog', () => {
    const refuseNothing = SRC.indexOf("if (preset === 'replace' && !canReplace) {");
    const refuseEmpty = SRC.indexOf("if (preset === 'replace' && !swap && replaceLikelyRefused) {");
    const dialog = SRC.indexOf('const sure = await sftkConfirmDestructive({\n      title: `${swap ? \'Replace\' : \'Remove\'} field reference');
    expect(refuseNothing).toBeGreaterThan(0);
    expect(refuseEmpty).toBeGreaterThan(refuseNothing);
    expect(dialog).toBeGreaterThan(refuseEmpty);
  });
  it('names the emptied elements and the ways that work, and changes nothing', () => {
    expect(SRC).toContain('const names = pv.emptied.slice(0, 4).map(e => `${e.kind} “${e.label || e.name || \'?\'}” (${e.where})`).join(\', \');');
    expect(SRC).toContain('cannot work on "${componentName}": taking the field out leaves ${names} with nothing in it, and Salesforce refuses a version like that. Nothing was changed. Press 🗑 Delete versions · flow off, pick a replacement field and press ⇄ Replace, or change the flow in Flow Builder and press ✂ again.');
  });
  it('a ⇄ Replace is never refused for this reason — the reference moves, nothing is emptied', () => {
    expect(SRC).toContain("preset === 'replace' && !swap && replaceLikelyRefused");
  });
});
