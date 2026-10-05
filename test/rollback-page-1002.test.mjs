// ↩ Roll back is a page (campaign 4 phase 7). User 2026-10-02: "The rollback
// screen is not great. we should make it open a reconcile screen, like the
// deployment screen, with all the features there." / "there's no info on the
// operation, who got deleted, etc".
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const UN = read('studio-undo.js');
const RB = read('studio-rollback.js');
const CO = read('studio-core.js');
const HI = read('studio-history.js');
const HTML = read('studio.html');
const SU = read('sftk-undo.js');
const slice = (src, start, endMarker) => { const i = src.indexOf(start); return i < 0 ? '' : src.slice(i, src.indexOf(endMarker, i)); };

describe('the planner and the executor are DOM-free and drive through io', () => {
  const plan = slice(UN, 'async function sftkUndoBuildPlan(', '\nasync function sftkUndoExecute(');
  const exec = slice(UN, 'async function sftkUndoExecute(', '\nwindow.rollbackRun');
  it('exist, and the modal flow is gone', () => {
    expect(plan.length).toBeGreaterThan(1000);
    expect(exec.length).toBeGreaterThan(1000);
    expect(UN).not.toContain('function _sftkUndoPlanHtml(');
    expect(UN).not.toContain("id=\"dsUndoTyped\"");
    expect(UN).toContain("window.rollbackRun = function(runId) {");
    expect(UN).toContain("if (typeof window.openRollback === 'function') return window.openRollback(runId);");
  });
  it('touch no DOM: no eid(, document., showModal( inside them', () => {
    for (const fn of [plan, exec]) {
      expect(fn).not.toMatch(/\beid\(/);
      expect(fn).not.toMatch(/\bdocument\./);
      expect(fn).not.toContain('showModal(');
    }
  });
  it('the planner keeps the records, not only ids (now rows by id, person ids, keys)', () => {
    expect(plan).toContain('const nowById = new Map(); for (const r of nowRows) if (r && r.Id) nowById.set(r.Id, r);');
    expect(plan).toContain('nowById, personIds,');
    expect(plan).toContain("for (const it of plan) it.key = multiLeg ? `${it.objType} @ ${orgLabel(it.leg.orgUrl)}` : it.objType;");
    expect(plan).toContain('item.keptIds = scoped.created.slice();');
  });
  it('the executor honours picks (del / res / force), posts live-view events, and names every record it touched', () => {
    expect(exec).toContain("let created = pick ? item.scoped.created.filter(id => pick.del && pick.del.has(id)) : item.scoped.created.slice();");
    expect(exec).toContain("const changed = pick ? item.scoped.changed.filter(c => pick.res && pick.res.has(c.id)) : item.scoped.changed.slice();");
    expect(exec).toContain("progress({ phase: 'fetched', obj: `🗑 ${item.objType}`, count: w.created.length });");
    expect(exec).toContain("progress({ phase: 'batch', obj: `↩ ${item.objType}`");
    expect(exec).toContain("r.deletedRecords.push({ id: x.id, name: label(item, x.id) })");
    expect(exec).toContain("r.restoredRecords.push({ id: x.id, name: label(item, x.id), fields: fieldsOf.get(x.id) || [] })");
    expect(exec).toContain("'SF_COLLECTIONS_DELETE'");
    expect(exec).not.toContain('SF_HARD_DELETE');
  });
  it('the History entry carries the records by name, capped and said', () => {
    const fn = slice(SU, 'function sftkUndoResultSummary(', '\n}\n');
    expect(fn).toContain('deletedRecords: r.deletedRecords.slice(0, 5000)');
    expect(fn).toContain('restoredRecords: r.restoredRecords.slice(0, 5000)');
    expect(fn).toContain('recordsCapped: 5000');
    expect(SU).toContain('function sftkUndoRowLabel(row) {');
    expect(SU).toContain('createdLaterIds: [], changedLaterIds: []');
  });
});

describe('the page', () => {
  it('is a view, loaded by studio.html, opened by the History ↩ button and by 📋 Which records', () => {
    expect(HTML).toContain('<script src="studio-rollback.js"></script>');
    expect(CO).toContain("case 'rollback':  if (typeof window.renderRollback === 'function') window.renderRollback(); else renderHistory(); break;");
    expect(CO).toContain("rollback: 'renderRollback'");
    expect(CO).toContain("case 'rollbackReport':        window.openRollback?.(arg, { report: true }); break;");
    expect(HI).toContain('data-dsaction="rollbackReport" data-arg="${esc(run.id)}"');
    expect(RB).toContain('window.openRollback = async function(runId, opts) {');
    expect(RB).toContain('window.renderRollback = renderRollback;');
  });
  it('names every record under five buckets, with the reason', () => {
    for (const k of ["k: 'del'", "k: 'res'", "k: 'kept'", "k: 'later'", "k: 'gone'"]) expect(RB).toContain(k);
    expect(RB).toContain("note: 'created by the run → deleted (Recycle Bin)'");
    expect(RB).toContain('field(s) restored`');
    expect(RB).toContain("note: 'created after the run → left alone'");
    expect(RB).toContain("deleted since the restore point → not restored here (Recycle Bin, within 15 days)");
  });
  it('everything the run did is ticked by default; "delete anyway" is not; the user can untick', () => {
    expect(RB).toContain('me.sel[it.key] = { del: new Set(it.scoped.created), res: new Set(it.scoped.changed.map(c => c.id)), force: new Set() };');
    expect(RB).toContain("const set = kind === 'del' ? sel.del : kind === 'res' ? sel.res : sel.force;");
    expect(RB).toContain('if (cb.checked) set.add(id); else set.delete(id);');
  });
  it('ONE confirmation through the shared dialog: ROLLBACK, or the org name for production; then the live run view', () => {
    const go = slice(RB, 'async function _rbGo() {', '\n}\n');
    expect(go).toContain('const sure = await sftkConfirmDestructive({');
    expect(go).toContain("typedWord: ctx.prod ? '' : 'ROLLBACK',");
    expect(go).toContain('production: ctx.prod ? { label: ctx.typedWord } : null,');
    expect(go).toContain('progress: sftkRunProgressHandler(logEl)');
    expect(go).toContain('const res = await sftkUndoExecute(ctx, picks, io);');
    expect(go).toContain("window.openRollback(res.entry.id, { report: true })");
  });
  it('before ↔ now opens the field compare for a record to restore', () => {
    expect(RB).toContain('renderDriftCompareTable(r.before || {}, r.now || {}, fields, fields, {}, null, { selectable: false })');
  });
  it('the report names deleted / restored / failed records and links deleted ones to the Recycle Bin', () => {
    expect(RB).toContain("field: 'deletedRecords'");
    expect(RB).toContain("field: 'restoredRecords'");
    expect(RB).toContain("field: 'failedRecords'");
    expect(RB).toContain('/lightning/o/DeleteEvent/home');
    expect(RB).toContain('This rollback ran before History kept the records by name.');   // then the Recycle Bin is read: test/rollback-report-1005
  });
});
