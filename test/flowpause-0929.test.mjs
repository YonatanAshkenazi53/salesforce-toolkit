// ⏸ Pause record-triggered flows during a deployment (user 2026-09-29):
// an option on the Deploy page, off by default; the flows go off after the
// run's confirmation and back on at their exact versions when it ends.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction, extractFunctions } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');
const select = extractFunction('sftk-flowpause.js', 'sftkFlowPauseSelect');
const FP = extractFunctions('sftk-flowpause.js',
  ['_sftkFpLit', 'sftkFlowPauseSelect', 'sftkFlowPauseList', '_sftkFpMemory', 'sftkFlowPausedLeftovers', '_sftkFpSwitch', 'sftkFlowPauseOff', 'sftkFlowPauseOn'],
  { 'sftk-write.js': ['sftkWriteVerified', '_sftkWriteVerifiedCore', 'sftkWriteVerifiedAll'] });

const ORG = 'https://t.my.salesforce.com';
const DEFS = [
  { DurableId: '300A1', ApiName: 'Acc1', Label: 'Acc One', TriggerType: 'RecordAfterSave', TriggerObjectOrEventId: 'Account', ActiveVersionId: '301A1', ManageableState: 'unmanaged' },
  { DurableId: '300C1', ApiName: 'Con1', Label: 'Con One', TriggerType: 'RecordBeforeSave', TriggerObjectOrEventId: 'Contact', ActiveVersionId: '301C1', ManageableState: 'unmanaged' },
  { DurableId: '300X1', ApiName: 'Cx1', Label: 'Custom One', TriggerType: 'RecordAfterSave', TriggerObjectOrEventId: '01I000000000AAA', ActiveVersionId: '301X1', ManageableState: 'unmanaged' },
  { DurableId: '300P1', ApiName: 'pkg__P', Label: 'Pkg Flow', TriggerType: 'RecordAfterSave', TriggerObjectOrEventId: 'Account', ActiveVersionId: 'pkg__P-1', ManageableState: 'installed' },
  { DurableId: '300O1', ApiName: 'Opp1', Label: 'Opp One', TriggerType: 'RecordAfterSave', TriggerObjectOrEventId: 'Opportunity', ActiveVersionId: '301O1', ManageableState: 'unmanaged' },
];

describe('which flows are paused', () => {
  it('record-triggered flows on the deployment\'s objects only — custom objects by entity Id; installed-package flows named, left alone', () => {
    const idToObj = new Map([['Account', 'Account'], ['Contact', 'Contact'], ['01I000000000AAA', 'Thing__c']]);
    const r = select(DEFS, idToObj);
    expect(r.own.map(f => [f.apiName, f.object, f.defId])).toEqual([['Acc1', 'Account', '300A1'], ['Con1', 'Contact', '300C1'], ['Cx1', 'Thing__c', '300X1']]);
    expect(r.managed).toEqual(['Pkg Flow (Account)']);
  });
});

describe('list → off → on, through the write discipline', () => {
  let store, org, calls, failOff;
  beforeEach(() => {
    store = {}; calls = []; failOff = null;
    org = new Map([['Acc1', true], ['Con1', true]]);   // ApiName → active?
    globalThis.SFTK_FLOWPAUSE_KEY = 'sftk_flow_run_paused';
    globalThis.SFTK_RT_TRIGGERS = ['RecordAfterSave', 'RecordBeforeSave', 'RecordBeforeDelete'];
    globalThis.sftkOrgKey = u => String(u).replace(/^https?:\/\//, '');
    globalThis.orgLabel = u => 't';
    globalThis.sftkHistoryBegin = () => ({ kind: 'tool', what: [], errors: [] });
    globalThis.sftkHistoryEnd = async () => {};
    globalThis.sftkHistoryNote = () => {};
    globalThis.chrome = { storage: { local: { get: async k => ({ [k]: store[k] }), set: async v => { Object.assign(store, JSON.parse(JSON.stringify(v))); } } } };
  });
  afterEach(() => { for (const k of ['SFTK_FLOWPAUSE_KEY', 'SFTK_RT_TRIGGERS', 'sftkOrgKey', 'orgLabel', 'sftkHistoryBegin', 'sftkHistoryEnd', 'sftkHistoryNote', 'chrome']) delete globalThis[k]; });
  const send = async m => {
    calls.push(m);
    const q = String(m.query || '');
    if (/FROM FlowDefinitionView WHERE IsActive/.test(q)) return { records: DEFS };
    if (/FROM Flow WHERE Id IN/.test(q)) return { records: [{ Id: '301A1', VersionNumber: 3 }, { Id: '301C1', VersionNumber: 1 }] };
    if (m.type === 'SF_PATCH') {
      const def = m.path.split('/').pop(); const api = def === '300A1' ? 'Acc1' : 'Con1';
      const v = m.body.Metadata.activeVersionNumber;
      if (v === 0 && failOff === api) return {};            // accepted, but the org keeps it on
      org.set(api, v !== 0); return {};
    }
    if (/FROM FlowDefinitionView WHERE ApiName IN/.test(q)) return { records: [...org].map(([ApiName, on]) => ({ ApiName, ActiveVersionId: on ? '301x' : null })) };
    return { error: 'unexpected ' + m.type + ' ' + q };
  };
  const sess = { orgUrl: ORG, sid: 'S' };

  it('lists the flows with the version that is active now', async () => {
    const l = await FP.sftkFlowPauseList(sess, ['Account', 'Contact'], send);
    expect(l.flows).toEqual([{ apiName: 'Acc1', label: 'Acc One', defId: '300A1', object: 'Account', version: 3 }, { apiName: 'Con1', label: 'Con One', defId: '300C1', object: 'Contact', version: 1 }]);
    expect(l.managed).toEqual(['Pkg Flow (Account)']);
  });
  it('off: every flow confirmed off and remembered BEFORE the run writes; on: back at the exact version, forgotten', async () => {
    const { flows } = await FP.sftkFlowPauseList(sess, ['Account', 'Contact'], send);
    const off = await FP.sftkFlowPauseOff(sess, flows, send);
    expect(off.ok).toBe(true);
    expect([...org.values()]).toEqual([false, false]);
    expect(Object.keys(store.sftk_flow_run_paused['t.my.salesforce.com'])).toEqual(['Acc1', 'Con1']);
    expect(store.sftk_flow_run_paused['t.my.salesforce.com'].Acc1).toMatchObject({ version: 3, defId: '300A1' });
    const on = await FP.sftkFlowPauseOn(sess, off.off, send);
    expect(on.failed).toEqual([]);
    expect([...org.values()]).toEqual([true, true]);
    expect(calls.filter(c => c.type === 'SF_PATCH').slice(-2).map(c => c.body.Metadata.activeVersionNumber)).toEqual([3, 1]);
    expect(store.sftk_flow_run_paused['t.my.salesforce.com']).toBeUndefined();
  });
  it('a flow that will not go off: the run must not start, and the ones already off go straight back on', async () => {
    failOff = 'Con1';
    const { flows } = await FP.sftkFlowPauseList(sess, ['Account', 'Contact'], send);
    const off = await FP.sftkFlowPauseOff(sess, flows, send);
    expect(off.ok).toBe(false);
    expect(off.failed[0]).toMatch(/Con One \(Contact\): accepted, but the org still reads it ON/);
    expect(off.restored.map(f => f.apiName)).toEqual(['Acc1']);
    expect([...org.values()]).toEqual([true, true]);
    expect(store.sftk_flow_run_paused['t.my.salesforce.com']).toBeUndefined();
  });
});

describe('wired into the Deploy page and the run', () => {
  const DV = read('studio-deploy.js'), RC = read('studio-reconcile.js');
  it('an option, OFF by default — "or just deploy regularly with flows active"', () => {
    expect(DV).toContain("let _depFlowPause = { on: false, key: '', list: null, error: '' };");
    expect(DV).toContain('<input type="checkbox" id="dsDepFlowPause" ${_depFlowPause.on ? \'checked\' : \'\'}> ⏸ pause record-triggered flows</label>');
    expect(DV).toContain('if (!fp) return runReconcile(p, objType, buckets);');
  });
  it('the flows are in the run\'s ONE confirmation; they go off after it and before the first write; the run stops if they cannot', () => {
    expect(RC).toContain('if (delIds.length || pullIds.length || updSrcIds.length || anyChildAct || capWarnLines.length || _fp) {');
    expect(RC).toContain('⏸ <strong>Before the first write:</strong> switch OFF');
    expect(RC).toContain('Records written while they are off are <strong>never</strong> processed by these flows.');
    expect(RC).toContain('try { go = await opts.beforeWrites(tgtSess, log); }');
    expect(RC).toContain('if (!go) { if (runBtn) runBtn.disabled = false; window._sftkRunActive = false; return; }');
  });
  it('they come back on in a finally — a failed or stopped run switches them back too; leftovers get a banner', () => {
    // right after the last write (live 2026-09-29), and again in a finally if that never ran
    expect(RC).toContain('try { await opts.afterWrites(log); }');
    expect(DV).toContain('afterWrites: async log => {');
    expect(DV).toMatch(/\} finally \{\r?\n\s+\/\/ the safety net: a run that failed or stopped before its last write\r?\n\s+if \(paused && paused\.ok && paused\.off\.length\) \{\r?\n\s+const r = await resume\(\);/);
    expect(DV).toContain('if (back || !paused || !paused.ok || !paused.off.length) return back;');
    expect(DV).toContain('<div id="dsDepFlowLeft"></div>');
    expect(DV).toContain('▶ Switch them back on</button>');
    expect(read('studio.html').indexOf('src="sftk-flowpause.js"')).toBeLessThan(read('studio.html').indexOf('src="studio-deploy.js"'));
    expect(read('studio-orghealth.js')).toContain("for (const [n, v] of Object.entries((d.sftk_flow_run_paused || {})[ctx.orgKey] || {})) remembered[n] = (v && v.version) || v;");
  });
});
