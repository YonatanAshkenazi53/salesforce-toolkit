// The confirm of ✂ / ⇄ pressed on a row shows what will change (user 2026-11-10, on a layout's confirm: "למה לא רואים
// פה מה מסירים מהxml?"). The preview is worked out before the dialog with the same pure transforms the fix runs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const fn = FC.slice(FC.indexOf('async function _fixPreviewHtml('), FC.indexOf('async function fixOne('));

describe('the row confirm carries a diff', () => {
  it('the preview exists and covers the five kinds the row fixes without a dialog of their own', () => {
    expect(fn.length).toBeGreaterThan(500);
    for (const t of ['Layout', 'FlexiPage', 'EmailTemplate', 'Report', 'ReportType']) expect(fn).toContain(`'${t}'`);
  });
  it('it uses the transforms the fix itself runs', () => {
    for (const f of ['removeFieldFromLayout(', 'sftkLayoutReplaceField(', 'removeFieldFromFlexiPage(', 'sftkFlexiReplaceField(',
      'sftkTplRemove(', 'sftkTplReplace(', 'sftkRptStripField(', 'sftkRptReplaceField(', 'sftkRtRemoveField(', 'sftkRtReplaceField(']) expect(fn).toContain(f);
  });
  it('it never writes: no PATCH, no deploy, no restore point', () => {
    expect(fn).not.toMatch(/SF_PATCH|SF_METADATA_DEPLOY|_snapshotFix|sftkWriteVerified|sftkHistoryBegin/);
  });
  it('the layout and the page are changed on a copy, not on what was read', () => {
    expect(fn).toContain('const after = JSON.parse(JSON.stringify(res.Metadata))');
  });
  it('a failed read gives no preview and does not stop the confirm', () => {
    expect(fn).toMatch(/catch \(_\) \{[^}]*\}\s*return '';/);
  });
  it('the confirm of a non-flow kind shows the preview', () => {
    expect(FC).toContain("previewHtml = await _fixPreviewHtml(type, componentId, componentName, swap);");
    expect(FC).toMatch(/: ''\}` : previewHtml,/);
  });
});
