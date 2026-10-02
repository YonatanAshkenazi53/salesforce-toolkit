// Field Cleaner's 🗑 Delete Field (user 2026-10-02: "deleted a field. dont see
// any history and rollback here" + the picker still offered the deleted field
// and a re-scan said "Could not locate this field in the Tooling API").
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const doDelete = FC.slice(FC.indexOf('async function doDelete(fieldId) {'), FC.indexOf('// ── XML Inspector'));

describe('🗑 Delete Field is journaled and the page forgets the field', () => {
  it('opens a History journal before the write and ends it on both outcomes', () => {
    expect(doDelete).toContain("sftkHistoryBegin({ tool: 'Field Cleaner', title: `🗑 Delete field — ${_selObj?.api}.${_selField?.api}`, orgUrl: _orgUrl })");
    expect(doDelete.indexOf('sftkHistoryBegin(')).toBeLessThan(doDelete.indexOf("type: 'SF_TOOLING_DELETE'"));
    expect(doDelete).toContain('sftkHistoryNote(j, { ok: !res.error, accepted: !res.error, verified: !res.error,');
    expect(doDelete).toContain('await sftkHistoryEnd(j, { undo: { none: res.error');
  });
  it('says honestly that there is no API undo, and where the 15-day way back is', () => {
    expect(doDelete).toContain('Salesforce has no API to undelete a custom field.');
    expect(doDelete).toContain('Deleted Fields → Undelete');
    expect(doDelete).toContain('_del__c — rename it');
  });
  it('drops the deleted field from the picker list', () => {
    expect(doDelete).toContain('_allFields = (_allFields || []).filter(f => f && f.api !== gone && f.name !== gone);');
  });
  it('a re-scan of a field the Toolkit deleted says so, with the date and the way back', () => {
    expect(FC).toContain('This field was deleted with the Toolkit on ${new Date(deleted.at).toLocaleString()}. Salesforce keeps it in Deleted Fields until about ${until}');
    expect(FC).toContain("const d = await chrome.storage.local.get('sftk_fc_deletion_log');");
  });
});
