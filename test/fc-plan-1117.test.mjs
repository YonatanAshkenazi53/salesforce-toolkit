// owner 2026-11-17: "About the remove all or replace all. maybe our approach was wrong. maybe we should'nt do the
// replace and remove wizard. or at least give an option to do it all in one shot instead of selection. which means we
// do the selection. what can be removed without ruining the component will be removed. what cannot be removed will
// be deleted" · "lets do what you suggested" · "what if i want one component field ref removed and another component
// i would like to delete entirely" — ⚡ All at once: one screen with every open row and the way the tool picked,
// each row changeable, one confirmation, one run, a report. The walk stays as "one by one".
// Live: scripts/dev/live/fc-plan.mjs on npc2 (packaged-object fixture) — 30 rows planned (18 removed, 1 deleted,
// 11 left); RUN=3 DEL=1: a lookup filter, a field set, a flow and a field update done with no second question, then
// ↩ Undo all: 4 of 4 undone.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const FC = read('field-cleaner.js'), CF = read('sftk-confirm.js'), CSS = read('styles.css');
const { fcPlanDefault, fcPlanCounts, fcPlanCountsText, fcPlanOwnsDialog } = extractFunctions('field-cleaner.js', ['fcPlanDefault', 'fcPlanCounts', 'fcPlanCountsText', 'fcPlanOwnsDialog']);

describe('what the tool picks for a row', () => {
  it('replace where the row can take the replacement, else remove', () => {
    expect(fcPlanDefault(['replace', 'remove', 'delete'], 'ValidationRule', 'must')).toBe('replace');
    expect(fcPlanDefault(['remove', 'delete'], 'DuplicateRule', 'must')).toBe('remove');
    expect(fcPlanDefault(['remove'], 'Layout', 'later')).toBe('remove');
  });
  it('delete only for a blocker of a kind that holds no logic of its own', () => {
    for (const t of ['FieldSet', 'WebLink', 'WorkflowFieldUpdate', 'WorkflowAlert', 'WorkflowOutboundMessage']) expect(fcPlanDefault(['delete'], t, 'must'), t).toBe('delete');
  });
  it('never picks deletion for automation, code or a rule — that is left for the owner to choose on the row', () => {
    for (const t of ['Flow', 'ApexClass', 'ApexTrigger', 'ApexPage', 'LightningComponentBundle', 'AuraDefinitionBundle', 'ValidationRule', 'WorkflowRule', 'DuplicateRule', 'MatchingRule', 'ApprovalProcess', 'SharingCriteriaRule', 'RestrictionRule', 'CustomField', 'AssignmentRule', 'EntitlementProcess']) {
      expect(fcPlanDefault(['delete'], t, 'must'), t).toBe('leave');
    }
  });
  it('never picks deletion for something that does not block the delete', () => {
    expect(fcPlanDefault(['delete'], 'FieldSet', 'later')).toBe('leave');
    expect(fcPlanDefault(['delete'], 'ListView', 'later')).toBe('leave');
    expect(fcPlanDefault([], 'ListView', 'later')).toBe('leave');
    expect(fcPlanDefault(null, 'x', 'must')).toBe('leave');
  });
});

describe('the plan in numbers', () => {
  it('counts each way, and what runs', () => {
    const c = fcPlanCounts(['replace', 'remove', 'remove', 'delete', 'leave', 'nonsense']);
    expect(c).toEqual({ replace: 1, remove: 2, delete: 1, leave: 2, run: 4 });
    expect(fcPlanCountsText(c)).toBe('1 replaced · 2 removed · 1 deleted · 2 left for you');
    expect(fcPlanCountsText(fcPlanCounts([]))).toBe('nothing to do');
    expect(fcPlanCounts(['leave']).run).toBe(0);
  });
});

describe('which confirmations the plan answers', () => {
  it('only the ones that name the row it is working on', () => {
    expect(fcPlanOwnsDialog({ items: [{ label: 'My Rule', sub: 'validation rule' }] }, 'My Rule')).toBe(true);
    expect(fcPlanOwnsDialog({ items: [{ label: 'My Flow v3' }, { label: 'My Flow v12' }] }, 'My Flow')).toBe(true);
  });
  it('not another component, not the flow’s paused interviews, not a dialog without items', () => {
    expect(fcPlanOwnsDialog({ items: [{ label: 'Other Rule' }] }, 'My Rule')).toBe(false);
    expect(fcPlanOwnsDialog({ items: [{ label: 'My Flow v3' }, { label: 'Interview 0001' }] }, 'My Flow')).toBe(false);
    expect(fcPlanOwnsDialog({ items: [{ label: 'My Flow vNext' }] }, 'My Flow')).toBe(false);
    expect(fcPlanOwnsDialog({ items: [{ label: 'My Rule 2' }] }, 'My Rule')).toBe(false);
    expect(fcPlanOwnsDialog({ items: [{ label: 'Account.Field__c' }] }, 'My Rule')).toBe(false);
    expect(fcPlanOwnsDialog({ items: [] }, 'My Rule')).toBe(false);
    expect(fcPlanOwnsDialog({}, 'My Rule')).toBe(false);
    expect(fcPlanOwnsDialog({ items: [{ label: '' }] }, '')).toBe(false);
  });
});

describe('a confirmation given once for a plan', () => {
  it('is asked first; only true or false answers without the dialog', () => {
    expect(CF).toContain('function sftkConfirmPlanned(fn) { _sftkConfirmPlanned = typeof fn === \'function\' ? fn : null; }');
    expect(CF).toContain('if (v === true || v === false) return Promise.resolve(v);');
  });
  it('the run hands it in for its own rows only, and always takes it back', () => {
    expect(FC).toContain('sftkConfirmPlanned(opts => (_planRun && fcPlanOwnsDialog(opts, _planRun.name)) ? true : undefined);');
    const run = FC.slice(FC.indexOf('async function _planExecute('), FC.indexOf('function _planReport('));
    expect(run).toMatch(/finally \{\s*sftkConfirmPlanned\(null\);/);
    expect(FC.split('sftkConfirmPlanned(').length - 1).toBe(2);
  });
});

describe('the plan', () => {
  it('is confirmed once, through the same confirmation as everything else (a production org types its name)', () => {
    const p = FC.slice(FC.indexOf('async function planEverything('), FC.indexOf('function _planOutcome('));
    expect(p).toContain('const sure = await sftkConfirmDestructive({');
    expect(p).toContain('production: gate.production ? { label: gate.label } : null,');
    expect(p).toContain('if (!sure) return;');
  });
  it('every row runs through the row’s own engine — the plan writes nothing itself', () => {
    const run = FC.slice(FC.indexOf('async function _planExecute('), FC.indexOf('function _planReport('));
    expect(run).toContain('await fixOne(row.type, row.id, row.name, fieldId, opt.swap, opt.way);');
    expect(run).not.toMatch(/SF_METADATA_DEPLOY|SF_TOOLING_|SF_REST_|bg\(/);
  });
  it('a row’s ways are the buttons it shows; each row has its own choice and Leave', () => {
    expect(FC).toContain("p.querySelectorAll('.fc-fix-btn:not([disabled]):not(.fc-xml-fix)')");
    expect(FC).toContain('<option value="leave"${r.pick === \'leave\' ? \' selected\' : \'\'}>Leave it for me</option>');
  });
  it('a running flow is read before the plan is shown; no zip per flow in the run', () => {
    expect(FC).toContain('const no = await _planFlowNo(flows[i]);');
    expect(FC).toContain('let wantBackup = !_planRun;');
  });
  it('the run can be stopped after the item in work, and ends with a report and ↩ Undo all', () => {
    expect(FC).toContain('if (_planRun.stop) break;');
    expect(FC).toContain('class="btn btn-secondary btn-sm fc-plan-stop"');
    // owner 2026-11-17: "while it does its job, dont forget our awsome progress bar and kitty animation"
    expect(FC).toContain("prog = sftkProgress(host.querySelector('.fc-plan-run-prog'), {");
    expect(FC).toContain('if (prog) prog.count(at, todo.length);');
    expect(FC).toContain('_planReport(done, not, waiting, nLeft, stoppedAt);');
    expect(FC).toContain('try { renderUndoAll(); }');
  });
  it('is the first button of the bar; the walk stays next to it as "one by one"', () => {
    expect(FC).toContain('class="btn btn-primary btn-sm fc-plan-btn"');
    expect(FC).toContain("${n >= 2 ? 'or one by one' : '⚡ Everything at once'}");
    expect(FC).toContain('class="btn btn-secondary btn-sm fc-fix-every" data-swap="1"');
    expect(CSS).toContain('#modalBox.sftk-cf-host.fc-plan-host { width: min(920px, 94vw) !important;');
  });
});
