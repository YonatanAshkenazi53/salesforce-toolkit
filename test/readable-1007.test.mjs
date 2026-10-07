import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const DEP = readFileSync(new URL('../dependency-map.js', import.meta.url), 'utf8');
const POP = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const SD = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const SR = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');

// User 2026-10-07 (History screenshot): "show better info than id that says nothing".
describe('Field Cleaner History lines name what was deleted', () => {
  it('flow versions by flow name, number and status; runs by label and state', () => {
    expect(FC).toContain("describe: (labelOf && labelOf[id]) || id,");
    expect(FC).toContain('Object.fromEntries(plan.toDelete.map(v => [v.id, `${flowName} v${v.num}${v.status ? ` (${v.status})` : \'\'} deleted`]))');
    expect(FC).toContain('Object.fromEntries(stale.map(v => [v.Id, `${flowName} v${v.VersionNumber}${v.Status ? ` (${v.Status})` : \'\'} deleted`]))');
    expect(FC).toContain("describe: runWords(it),");
    expect(FC).toContain("'failed' : 'paused'} flow run");
    expect(FC).not.toContain('describe: it.Id,');
  });
});

// User 2026-10-07: "if we hard delete records in any operation, rollback wont be available.
// we need to state it somewhere … before someone uses hard delete".
describe('Hard delete says that Roll back cannot undo it, before it is used', () => {
  it('next to the mode, on the change, and in the confirmation', () => {
    expect(SD).toContain('id="dsDepHardNote"');
    expect(SD).toContain('↩ Roll back cannot bring them back');
    expect(SD).toContain("showToast('🔥 Hard delete: deleted records cannot be brought back by ↩ Roll back — they skip the Recycle Bin.', 'warning', 7000);");
    expect(SR).toContain('↩ Roll back will not bring them back; switch Delete mode to Recycle Bin if you may need to.');
    expect(SR).toContain('cannot be recovered</strong>. ↩ Roll back will not bring them back.</div>');
  });
});

// User 2026-10-07: "can we also see who modified the flow? and also who created it? … created
// on date by, modified at date by … and make it more readable".
describe('Dependencies rows: created/modified by whom, as two lines', () => {
  it('both queries read the names; the row prints two lines with the keys', () => {
    expect(DEP).toContain('CreatedDate,CreatedBy.Name,LastModifiedDate,LastModifiedBy.Name FROM Flow');
    expect(POP).toContain("ApiVersion,CreatedDate,CreatedBy.Name,LastModifiedBy.Name';");
    expect(DEP).toContain('depDatesHtml(flow.CreatedDate, flow.LastModifiedDate, flow.CreatedBy && flow.CreatedBy.Name, flow.LastModifiedBy && flow.LastModifiedBy.Name)');
    expect(DEP).toContain('<span class="dep-node-date-k">created</span>');
    expect(DEP).toContain('<span class="dep-node-date-k">modified</span>');
  });
});
