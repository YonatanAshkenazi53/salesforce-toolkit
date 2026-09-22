// sftkMetaForPatch — every Tooling Metadata PATCH goes through it (live
// 2026-09-23: the Picklist Manager's deactivate sent the field's Metadata
// back as read, nulls and all, and Salesforce refused it with "Cannot
// deserialize instance of complexvalue from VALUE_NULL value null"; the same
// body with the nulls removed was accepted — proven by CLI on
// Account.SFTK_FC_Test_Status__c). The Field Cleaner's Deprecate / Undo
// deprecate PATCH the same shape and were never verified live.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sftkMetaForPatch = extractFunction('sftk-zip.js', 'sftkMetaForPatch');

describe('sftkMetaForPatch', () => {
  it('drops null keys at every depth and the read-only urls, keeps false / 0 / "" and array order', () => {
    const md = {
      label: 'X', description: null, lookupFilter: null, required: false, precision: 0, inlineHelpText: '',
      urls: { self: '/x' },
      valueSet: { controllingField: null, restricted: true, valueSettings: null,
        valueSetDefinition: { sorted: false, value: [
          { color: null, default: false, isActive: null, label: 'New', urls: null, valueName: 'New' },
          { color: null, default: false, isActive: false, label: 'Closed', valueName: 'Closed' },
        ] } },
    };
    const out = sftkMetaForPatch(md);
    expect(out).toEqual({
      label: 'X', required: false, precision: 0, inlineHelpText: '',
      valueSet: { restricted: true, valueSetDefinition: { sorted: false, value: [
        { default: false, label: 'New', valueName: 'New' },
        { default: false, isActive: false, label: 'Closed', valueName: 'Closed' },
      ] } },
    });
    expect(out.valueSet.valueSetDefinition.value.map(v => v.valueName)).toEqual(['New', 'Closed']);
  });
  it('never touches the input', () => {
    const md = { a: null, b: { c: null, d: 1 }, urls: {} };
    const copy = JSON.parse(JSON.stringify(md));
    sftkMetaForPatch(md);
    expect(md).toEqual(copy);
  });
  it('passes primitives and arrays of primitives through', () => {
    expect(sftkMetaForPatch(['a', null, 0])).toEqual(['a', null, 0].map(x => x));
    expect(sftkMetaForPatch('s')).toBe('s');
    expect(sftkMetaForPatch(undefined)).toBe(undefined);
  });
});

describe('every value-set / field / record-type PATCH goes through it', () => {
  it('studio-picklists.js: no raw "Metadata: md" body is left', () => {
    const src = readFileSync(join(root, 'studio-picklists.js'), 'utf8');
    expect(src.match(/body: \{ Metadata: md \}/g)).toBeNull();
    expect((src.match(/body: \{ Metadata: sftkMetaForPatch\(md\) \}/g) || []).length).toBe(5);
  });
  it('field-cleaner.js: Deprecate and Undo deprecate PATCH the cleaned copy; the restored description is "" not null', () => {
    const src = readFileSync(join(root, 'field-cleaner.js'), 'utf8');
    expect((src.match(/tooling\/sobjects\/CustomField\/\$\{(?:fieldId|dep\.fieldId)\}`,\s*body: \{ Metadata: sftkMetaForPatch\(md\) \}/g) || []).length).toBe(2);
    expect(src).toContain("description: dep.prevDesc || '' };");
    expect(src).not.toContain('description: dep.prevDesc || null');
  });
  it('the helper is shipped to both pages (sftk-zip.js is in popup.html and studio.html)', () => {
    for (const page of ['popup.html', 'studio.html']) {
      expect(readFileSync(join(root, page), 'utf8')).toMatch(/src="sftk-zip\.js"/);
    }
  });
});
