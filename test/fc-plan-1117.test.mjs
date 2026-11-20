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

describe('✂ on a Lightning page that names the field only in its description', () => {
  it('settles the row instead of sending the owner to App Builder', () => {
    const at = FC.indexOf('async function fixFlexiPage('); const f = FC.slice(at, at + 9000);
    expect(f).toContain("if (!leftRm.other && !leftRm.unknown && !leftRm.otherPage && !_flexiNamesBeyondText(beforeMetadata, _selObj.api, _selField.api)) {");
    expect(f).toContain("return '✅ Nothing uses the field here — Salesforce lists it because");
    expect(f.indexOf("return '✅ Nothing uses the field here")).toBeLessThan(f.indexOf('No direct field references found in'));
  });
});

describe('the scan and a Lightning page that names the field only in free text', () => {
  it('does not list it (owner 2026-11-17: "So why it showed when i rescaned")', () => {
    expect(FC).toContain('if (flexiPageReferencesField(r.value.Metadata, _selObj.api, _selField.api) && _flexiNamesBeyondText(r.value.Metadata, _selObj.api, _selField.api)\n');   // QA 1.1 finding 17 adds a third condition on the next line
  });
});

describe('↩ Undo all on the list’s header', () => {
  // owner 2026-11-18: "can we place the undo all button here?" (the header, next to the note of the last run)
  it('is drawn when the field has changes that can be undone, and presses the bar’s own button', () => {
    expect(FC).toContain('class="btn btn-secondary btn-sm fc-undoall-top"');
    expect(FC).toContain('↩ Undo all ${_undoAllN}</button>');
    expect(FC).toContain("if (_undoAllN !== list.length) { _undoAllN = list.length; _refreshFixEvery(); }");
    expect(FC).toContain("if (ev.target.closest?.('.fc-undoall-top')) { const b = eid('fcUndoAllBtn'); if (b) {");
  });
});

describe('↩ Undo — which ones', () => {
  // owner 2026-11-18: "can we make them also selectable. if i want to restore only some? and make the text more readable"
  const { fcUndoRowParts } = extractFunctions('field-cleaner.js', ['fcUndoRowParts']);
  const S = 'dlrs__LookupChild__c.SFTK_Pkg_Tag__c';
  it('a line reads kind · name · what was done, without the field every line is about', () => {
    expect(fcUndoRowParts(`✂ Paths — "SFTK Pkg Path — a key field of the step New" (${S} removed)`, S)).toEqual({ kind: '✂ Paths', name: 'SFTK Pkg Path — a key field of the step New', did: 'removed' });
    expect(fcUndoRowParts(`✂ Custom Setting Records — "SFTK Gap Set · PkgRef (Field_Name__c)" removed (${S})`, S)).toEqual({ kind: '✂ Custom Setting Records', name: 'SFTK Gap Set · PkgRef (Field_Name__c)', did: 'removed' });
    expect(fcUndoRowParts(`🗑 Apex Classes — "SFTK_Pkg_Class" deleted (${S})`, S)).toEqual({ kind: '🗑 Apex Classes', name: 'SFTK_Pkg_Class', did: 'deleted' });
    expect(fcUndoRowParts(`✂ Flow — SFTK Pkg Sub (${S} removed)`, S)).toEqual({ kind: '✂ Flow', name: 'SFTK Pkg Sub', did: 'removed' });
    expect(fcUndoRowParts('odd title', S)).toEqual({ kind: '', name: 'odd title', did: '' });
    expect(fcUndoRowParts(null, null)).toEqual({ kind: '', name: '', did: '' });
  });
  it('every change has its tick; only the ticked ones are undone, newest first; nothing ticked keeps the button off', () => {
    expect(FC).toContain('const picked = new Set(list.map(e => e.id));');
    expect(FC).toContain("if (go) { go.textContent = goText(); go.disabled = !picked.size || !(ack && ack.checked); }");
    expect(FC).toContain('if (!sure || !picked.size) return;');
    expect(FC).toContain('list = list.filter(e => picked.has(e.id));');
    expect(FC).toContain("ack?.addEventListener('change', () => setTimeout(sync, 0));");
  });
});

describe('the Setup link of a search layout', () => {
  it('opens Object Manager’s own Search Layouts page, not the address that draws an empty panel', () => {
    expect(FC).toContain("function fcSearchLayoutsPage() { return 'MySearchLayouts'; }");
    expect(FC).not.toMatch(/ObjectManager\/[^`']*\/SearchLayouts\/view/);
    expect(FC.split('${fcSearchLayoutsPage()}/view').length - 1).toBe(2);
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
    // owner 2026-11-17: "we just need to improve how this screen looks" — the ways are buttons, the chosen one lit
    expect(FC).toContain("${['replace', 'remove', 'delete'].map(k => { const o = r.opts.find(x => x.kind === k); return o ? b(k, o.label) : ''; }).join('')}${b('leave', 'Nothing is changed in this one — it stays for you')}");
    expect(FC).toContain("if (w) { set(Number(w.dataset.i), w.dataset.kind); sync(); return; }");
    expect(FC).toContain("const r = rows[i]; if (!r || (kind !== 'leave' && !r.opts.some(o => o.kind === kind))) return;");
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
    // ↩ Undo all draws the same full-size progress (owner 2026-11-17: "should look like the kitty when its removed")
    expect(FC).toContain("key: 'fc-undo-all', orgUrl: _orgUrl, total: list.length, unit: 'changes' }) : null;");
    expect(FC).not.toMatch(/key: 'fc-(undo-all|plan)'.*small: true/);
    expect(FC).toContain('_planReport(done, not, waiting, nLeft, stoppedAt);');
    expect(FC).toContain('try { renderUndoAll(); }');
  });
  // owner 2026-11-17: "we can forget about the old wizard as we dont need it anymore"
  it('is the only "all" button: on the list, and on each group for that group’s rows — the walk is gone', () => {
    expect(FC).toContain('class="btn btn-primary btn-sm fc-plan-btn"');
    expect(FC).toContain('class="btn btn-secondary btn-sm fc-plan-btn" data-type="${esc(type)}"');
    expect(FC).toContain("if (pl) { if (!pl.disabled) planEverything(_curFieldId, pl.dataset.type || ''); return; }");
    expect(FC).toContain('rows = _planRows().filter(r => !onlyType || r.type === onlyType);');
    for (const gone of ['fixEverything', 'fixAll(', 'fc-fix-every', 'fc-walk-', '_walkDeleteInstead', 'askdelete', 'fcWalkSaved', 'Pause — continue later', 'Skip this one']) expect(FC, gone).not.toContain(gone);
    expect(FC).toContain("try { chrome.storage.local.remove('sftk_fc_walk'); }");
    expect(CSS).toContain('#modalBox.sftk-cf-host.fc-plan-host { width: min(900px, 94vw) !important;');
  });
  it('the bulk links: what is left of the blockers can be set to Delete, a list left, the suggestion brought back', () => {
    expect(FC).toContain("if (b.dataset.bulk === 'delete') { if (r.sev === 'must' && r.pick === 'leave' && r.opts.some(o => o.kind === 'delete')) set(i, 'delete'); }");
    expect(FC).toContain("else if (r.sev === b.dataset.sev) set(i, b.dataset.bulk === 'reset' ? r.suggest : 'leave');");
    expect(FC).toContain('r.suggest = r.pick = fcPlanDefault(r.opts.map(o => o.kind), r.type, r.sev);');
  });
});

// owner 2026-11-20: "nums here are different. and we dont need it twice … so delete the upper one"
describe('a run counts once', () => {
  const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
  it('the line over the bar names the row; the count is the bar’s own line', () => {
    expect(FC).toContain('if (prog) prog.say(`${_PLAN_ICO[row.pick]} ${row.name}`);');
    expect(FC).toContain('if (prog) prog.say(`Undoing ${e.profileName}`);');
    expect(FC).not.toContain('${at} of ${todo.length}');
  });
});

// QA 1.1 (workflow wf_3e89570d, 2026-11-20), findings 1, 2, 13, 14: what a ⚡ run must never do without asking
describe('QA 1.1 — a run asks where the plan screen did not say it', () => {
  const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
  it('a dialog marked planAsk is never the plan’s to answer, whatever its items', () => {
    expect(fcPlanOwnsDialog({ planAsk: true, items: [{ label: 'My Flow v3' }] }, 'My Flow')).toBe(false);
    expect(fcPlanOwnsDialog({ planAsk: false, items: [{ label: 'My Flow v3' }] }, 'My Flow')).toBe(true);
  });
  it('a flow with paused or failed interviews, and a rule that would be switched off, are marked', () => {
    expect(FC).toContain("planAsk: type === 'Flow' && !!(flowPlan && flowPlan.interviews && flowPlan.interviews.length),");
    expect(FC).toContain("planAsk: vrChoice && vrMode === 'off',");
  });
  it('"Delete N old versions" is a delete: never picked by default', () => {
    expect(FC).toContain('data-swap="0" data-way="versions" title="Delete the old versions that still mention the field">');
    expect(FC).toContain("b.dataset.way === 'off' || b.dataset.way === 'versions') ? 'delete' : 'remove';");
    expect(fcPlanDefault(['delete'], 'Flow', 'must')).toBe('leave');
  });
  it('a flow with a place the fix never rewrites has no ✂ in the plan, with the reason', () => {
    expect(FC).toContain('if ((pv.remaining || []).length) return `the field also sits in ${pv.remaining.length} place');
  });
});
