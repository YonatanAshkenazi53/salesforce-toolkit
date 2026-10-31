// 2026-10-31 — the Field Cleaner's flow fix carries a real ↩ Undo in History (user: "do it"):
// the version that used the field is redeployed from its restore point as the active version,
// the way the Flows page's delete undoes itself; the note says what else exists (restore
// points under the results, the backup zip when one was ticked); a disabled undo shows its
// reason next to the button; the confirmation says the way back exists.
// Live 2026-10-31 on the fixture: the flow-off way deleted every version; Undo re-created the
// flow as v1 Active (CLI truth) — the proof is "an active version that is not the fixed one",
// never "a number above", because a re-created flow starts at v1 again.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const FC = read('field-cleaner.js');
const exec = FC.slice(FC.indexOf('async function fixFlowExecute(fp, opts)'), FC.indexOf('\n  }\n', FC.indexOf('out.undo = {')) + 4);

describe('fixFlowExecute: the undo statement', () => {
  it('is a real step when the version that was active went: redeploy its restore point as the active version', () => {
    expect(exec).toContain("const activeGone = !!(plan.active && (plan.toDelete.some(v => v.id === plan.active.id) || out.deactivated));");
    expect(exec).toContain("if (activeGone && act && act.Metadata && (out.deleted || out.deactivated)) {");
    expect(exec).toContain("const md = JSON.parse(JSON.stringify(act.Metadata)); delete md.fullName; md.status = 'Active';");
    expect(exec).toContain("msg: { type: 'SF_METADATA_DEPLOY', zipBase64: buildFlowZip(api, md) },");
    expect(exec).toContain("describe: `${flowName}: restore v${plan.active.num} — the version that used the field — as the active version`,");
  });
  it('is verified by an ACTIVE version that is not the fixed one — no version-number bound (a re-created flow starts at v1)', () => {
    expect(exec).toContain("const notFixed = out.newVersion ? ` AND VersionNumber != ${Number(out.newVersion)}` : '';");
    expect(exec).toContain("WHERE Definition.DeveloperName = '${safeApi}' AND Status = 'Active'${notFixed}`,");
    expect(exec).not.toContain('VersionNumber > ${above}');
    expect(exec).toMatch(/tooling: true, count: 1, retries: 4,/);
  });
  it('the note says what comes back and what else exists: the fixed version, the restore points, the interviews, the backup zip', () => {
    expect(exec).toContain("const zipNote = opts && opts.backup ? ' A backup zip of every deleted version was downloaded before the fix.' : '';");
    expect(exec).toContain("kept under ↩ Restore points below the Field Cleaner's results` : '', out.interviewsDeleted ? `${out.interviewsDeleted} deleted flow interview(s), which cannot be re-created` : ''].filter(Boolean).join('; ') || 'nothing else — one version was deleted'}. What comes back: v${plan.active.num}, the one that was active, as the active version (Salesforce numbers it anew)");
    expect(exec).toContain("; the fixed v${out.newVersion} stays as an obsolete version` : ''}.${zipNote}`,");
  });
  it('otherwise says why there is no undo, and where the metadata is', () => {
    expect(exec).toContain("out.undo = { none: `the flow versions that used the field were deleted, and a deleted flow version cannot be re-created (Salesforce keeps no Recycle Bin for them); their metadata is kept under ↩ Restore points below the Field Cleaner's results, from where a version can be put back as a draft.${zipNote}` };");
  });
});

describe('the confirmation and the disabled undo say it', () => {
  it('the flow confirmation says a restore point is kept and that Undo in History puts the active version back', () => {
    expect(FC).toContain('A restore point of each is kept first: ↩ Undo in History puts the version that was active back as the active version, and ↩ Restore points below the results hold every deleted version.');
    expect(FC).not.toContain('are deleted for good</strong>');
  });
  it('a disabled undo prints its reason next to the button — the feed, History, the tool list', () => {
    expect(read('sftk-feed.js')).toContain('${st.disabled && st.title ? `<span class="sftk-feed-why">${esc(st.title)}</span>` : \'\'}');
    expect(read('sftk-toolhistory.js')).toContain('${st.disabled && st.title ? `<span class="sftk-th-why">${esc(st.title)}</span>` : \'\'}');
    const H = read('studio-history.js');
    expect(H).toContain('${st.disabled && st.title ? `<span class="ds-hist-why">${esc(st.title)}</span>` : \'\'}');
    expect(H).toContain('${undoSt.disabled && undoSt.title ? `<span class="ds-hist-why">${esc(undoSt.title)}</span>` : \'\'}');
  });
});
