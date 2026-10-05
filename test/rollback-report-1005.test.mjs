// History › a rollback's "📋 Which records" (user 2026-10-05, on a rollback that
// ran before History kept the records by name: "when you click see which
// records, you dont see the list of records" / "it should open the reconcile
// deployment screen"). The report page showed counts and nothing else.
//
// A rollback deletes to the Recycle Bin, so the org can still name what it
// deleted for 15 days. When the entry has no names, the page reads them there.
// Live 2026-10-05 on trailheads5: 812 Accounts found of 812 counted; 380
// Contacts found of 1,250 counted — said as it is.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const RB = read('studio-rollback.js');
const F = extractFunctions('sftk-undo.js', ['sftkUndoBinQuery', 'sftkUndoBinAge', 'sftkUndoBinVerdict']);

describe('sftkUndoBinQuery — the Recycle Bin read of one object', () => {
  const q = F.sftkUndoBinQuery('Account', '2026-10-02T14:04:30.000Z', '2026-10-02T14:05:05.000Z', 'Name');
  it('asks for the object’s deleted records inside the rollback’s own time, two minutes either side', () => {
    expect(q.soql).toBe('SELECT Id, Name FROM Account WHERE IsDeleted = true AND SystemModstamp >= 2026-10-02T14:02:30Z AND SystemModstamp <= 2026-10-02T14:07:05Z ORDER BY SystemModstamp, Id');
    expect(q.from).toBe('2026-10-02T14:02:30Z');
    expect(q.to).toBe('2026-10-02T14:07:05Z');
    expect(q.tolMin).toBe(2);
  });
  it('an object without a name field is read by Id alone', () => {
    expect(F.sftkUndoBinQuery('Case', '2026-10-02T14:04:30Z', '2026-10-02T14:05:05Z', '').soql.startsWith('SELECT Id FROM Case WHERE')).toBe(true);
    expect(F.sftkUndoBinQuery('Case', '2026-10-02T14:04:30Z', '2026-10-02T14:05:05Z', 'CaseNumber').soql.startsWith('SELECT Id, CaseNumber FROM Case')).toBe(true);
    expect(F.sftkUndoBinQuery('Account', '2026-10-02T14:04:30Z', '2026-10-02T14:05:05Z', 'Id').soql.startsWith('SELECT Id FROM Account')).toBe(true);
  });
  it('nothing is built from text that is not an API name, or from an entry without times', () => {
    expect(F.sftkUndoBinQuery('Account @ trailheads5', '2026-10-02T14:04:30Z', '2026-10-02T14:05:05Z', 'Name')).toBe(null);
    expect(F.sftkUndoBinQuery("Account WHERE Name != ''", '2026-10-02T14:04:30Z', '2026-10-02T14:05:05Z', 'Name')).toBe(null);
    expect(F.sftkUndoBinQuery('Account', '', '2026-10-02T14:05:05Z', 'Name')).toBe(null);
    expect(F.sftkUndoBinQuery('Account', '2026-10-02T14:05:05Z', '2026-10-02T14:04:30Z', 'Name')).toBe(null);
    // a label field that is not an API name is dropped, not injected
    expect(F.sftkUndoBinQuery('Account', '2026-10-02T14:04:30Z', '2026-10-02T14:05:05Z', 'Name, (SELECT Id FROM Contacts)').soql.startsWith('SELECT Id FROM Account')).toBe(true);
  });
  it('the tolerance can be set, zero included', () => {
    const z = F.sftkUndoBinQuery('Account', '2026-10-02T14:04:30Z', '2026-10-02T14:05:05Z', 'Name', 0);
    expect(z.from).toBe('2026-10-02T14:04:30Z');
    expect(z.to).toBe('2026-10-02T14:05:05Z');
  });
});

describe('sftkUndoBinAge / sftkUndoBinVerdict — what the page may say', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  it('whole days since the rollback; unreadable time = unknown', () => {
    expect(F.sftkUndoBinAge('2026-10-02T14:05:05Z', now)).toBe(2);
    expect(F.sftkUndoBinAge('2026-09-01T00:00:00Z', now)).toBe(34);
    expect(F.sftkUndoBinAge('', now)).toBe(null);
  });
  it('same number = match; fewer and more are said with the difference; the count stays the truth', () => {
    expect(F.sftkUndoBinVerdict(812, 812).kind).toBe('match');
    const fewer = F.sftkUndoBinVerdict(380, 1250);
    expect(fewer.kind).toBe('fewer');
    expect(fewer.text).toContain('380 found; the rollback counted 1,250.');
    expect(fewer.text).toContain('The other 870 are no longer in the Recycle Bin');
    const more = F.sftkUndoBinVerdict(15, 12);
    expect(more.kind).toBe('more');
    expect(more.text).toContain('3 of these were deleted by something else in the same minutes');
    expect(F.sftkUndoBinVerdict(50000, 60000, true).kind).toBe('capped');
  });
});

describe('the report page', () => {
  const read1 = RB.slice(RB.indexOf('async function _rbBinRead('), RB.indexOf('function _rbRenderReport('));
  const page = RB.slice(RB.indexOf('function _rbRenderReport('));
  it('reads the Recycle Bin when names are missing — and only then, and not for a rollback older than the bin keeps', () => {
    expect(RB).toContain("function _rbNamesMissing(s) { return Number(s && s.deleted || 0) > ((s && s.deletedRecords) || []).length; }");
    expect(page).toContain('const tooOld = days !== null && days > 15;');
    expect(page).toContain('if (missing && !bin && !tooOld && me.objKey) { _rbBinRead(me.objKey); }');
  });
  it('the read is a read: queryAll through the generic GET, paged, capped, and nothing that writes', () => {
    expect(read1).toContain("let path = `services/data/v62.0/queryAll/?q=${encodeURIComponent(q.soql)}`;");
    expect(read1).toContain("type: 'SF_REST_GET'");
    expect(read1).toContain('res.nextRecordsUrl');
    expect(read1).toContain('if (st.rows.length >= SFTK_RB_BIN_CAP) { st.capped = true; break; }');
    for (const w of ['SF_COLLECTIONS', 'SF_PATCH', 'SF_REST_POST', 'DELETE', 'sftkWriteVerified']) expect(read1).not.toContain(w);
  });
  it('an abandoned page is not painted, and a failed or partial read lists nothing as if it were complete', () => {
    expect(read1).toContain('if (_rb !== me) return;');
    expect(read1).toContain("if (!res || res.error || !Array.isArray(res.records)) return fail('error'");
    expect(read1).toContain("if (!sess) return fail('nosession');");
    expect(page).toContain("const fromBin = missing && binNow && binNow.state === 'done';");
  });
  it('the page says where the list came from, for which minutes, and how it compares with the count', () => {
    expect(page).toContain('This list was read from the Recycle Bin of ${esc(orgLabel(org))} just now');
    expect(page).toContain('const v = sftkUndoBinVerdict(binNow.rows.length, s.deleted, !!binNow.capped);');
    expect(page).toContain('Reading the ${n(s.deleted)} deleted ${esc(me.objKey)} records from the Recycle Bin of ${esc(orgLabel(org))} instead (≈${n(sftkUndoReadQuote(s.deleted).calls + 1)} API calls, nothing is changed)');
    expect(page).toContain('open that org in a Chrome tab, then ${again}');
    expect(page).toContain('the Recycle Bin keeps a record for 15 days, so the ${n(s.deleted)} deleted records can no longer be named.');
  });
  it('the records card is always there (object bar, tabs, filter) — never "counts only" and a blank page', () => {
    expect(RB).not.toContain('counts only');
    expect(page).toContain("${!keys.length ? '' : `<div class=\"ds-rec-card ds-rb-records\">");
    expect(page).toContain("const tabs = _RB_REPORT_TABS.map(t => ({ ...t, n: t.count ? Math.max(Number(s[t.count] || 0), listOf(t.k).length) : listOf(t.k).length }));");
  });
  it('restored records that were not kept are counted, and the page says they cannot be read back', () => {
    expect(page).toContain('a restored record leaves no trace in the org to read them from');
  });
});

describe('counts-only mode keeps no record names — a rollback’s included', () => {
  it('the strip removes the rollback’s deleted and restored names too', () => {
    const CO = read('studio-core.js');
    const fn = CO.slice(CO.indexOf('function _historyStripCountsOnly('), CO.indexOf('// Phase 3 — the popup'));
    expect(fn).toContain('delete obj.deletedRecords; delete obj.restoredRecords; delete obj.recordsCapped;');
  });
});
