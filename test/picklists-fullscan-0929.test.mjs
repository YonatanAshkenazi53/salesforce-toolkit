// Campaign 3 phase 6 — the automation check before switching a picklist value
// off reads EVERY active flow (no FLOW_CAP), lists them in one query (the old
// record-triggered filter used a column FlowDefinitionView does not have), and
// reads the Metadata 25 flows per Tooling composite/batch call.
import { describe, it, expect, afterEach } from 'vitest';
import { extractFunctions } from './extract.mjs';

const { _pkValueLiteralScan } = extractFunctions('studio-picklists.js', ['_pkValueLiteralScan', 'pkValueMentions', 'pkAutomationUrl'], { 'studio-core.js': ['soqlStrLit'] });

const ORG = 'https://t.my.salesforce.com';
function world({ flows = 60, installed = 0, badItem = null, mention = 'F07' } = {}) {
  const calls = [];
  const defs = Array.from({ length: flows }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    const onAcc = i >= flows - 2;   // the LAST two listed are record-triggered on Account — they must be read FIRST
    return { ApiName: `F${n}`, Label: `Flow ${n}`, ProcessType: 'AutoLaunchedFlow', TriggerType: onAcc ? 'RecordAfterSave' : (i % 3 ? null : 'Scheduled'), TriggerObjectOrEventId: onAcc ? 'Account' : null,
      ActiveVersionId: `301F${n}`, ManageableState: 'unmanaged' };
  }).concat(Array.from({ length: installed }, (_, i) => ({ ApiName: `pkg__P${i}`, Label: `Pkg ${i}`, ProcessType: 'AutoLaunchedFlow', TriggerType: null, TriggerObjectOrEventId: null, ActiveVersionId: `pkg__P${i}-1`, ManageableState: 'installed' })));
  globalThis.sendBg = async msg => {
    calls.push(msg);
    const q = String(msg.query || '');
    if (/FROM ValidationRule/.test(q)) return { records: [] };
    if (/FROM FlowDefinitionView/.test(q)) return { records: defs };
    if (msg.type === 'SF_COMPOSITE_BATCH') return msg.subrequests.map(r => {
      const id = r.url.split('/').pop(), api = id.slice(3);
      if (api === badItem) return { ok: false, status: 403, body: undefined, error: 'no access' };
      return { ok: true, status: 200, body: { Id: id, Metadata: { decisions: [{ rules: [{ conditions: [{ rightValue: { stringValue: api === mention ? 'Closed' : 'Open' } }] }] }] } } };
    });
    return { error: 'unexpected ' + msg.type + ' ' + q };
  };
  return calls;
}
afterEach(() => { delete globalThis.sendBg; });
const ctx = { obj: 'Account', orgUrl: ORG, sid: 'S' };

describe('the automation check reads every active flow', () => {
  it('60 flows: all read in 3 batch calls, record-triggered on the object first, the one that names the value is found, nothing noted', async () => {
    const calls = world();
    const r = await _pkValueLiteralScan(ctx, 'Closed');
    const batches = calls.filter(c => c.type === 'SF_COMPOSITE_BATCH');
    expect(batches.map(b => b.subrequests.length)).toEqual([25, 25, 10]);
    expect(batches[0].subrequests.slice(0, 2).map(x => x.url)).toEqual(['tooling/sobjects/Flow/301F59', 'tooling/sobjects/Flow/301F60']);
    expect(r.scan).toMatchObject({ flowsScanned: 60, flowsFound: 60, triggeredN: 2, cap: null });
    expect(r.notes).toEqual([]);
    expect(r.hits).toEqual(['Flow: Flow 07']);
    expect(calls.some(c => /TriggerObjectOrEventApiName/.test(String(c.query || '')))).toBe(false);
    expect(calls.filter(c => /FROM Flow WHERE/.test(String(c.query || ''))).length).toBe(0);   // no per-flow query, no version query — the listing carries ActiveVersionId
  });
  it('a flow whose metadata cannot be read is named in the note, the rest still count', async () => {
    world({ badItem: 'F12' });
    const r = await _pkValueLiteralScan(ctx, 'Closed');
    expect(r.scan.flowsScanned).toBe(59);
    expect(r.notes).toEqual(["scanned 59 of 60 of this org's active flows — 1 returned no readable metadata and were NOT checked"]);
  });
  it('installed-package flows are counted and said, never requested (Salesforce does not expose their metadata — live 2026-09-29)', async () => {
    const calls = world({ installed: 3 });
    const r = await _pkValueLiteralScan(ctx, 'Closed');
    expect(r.scan).toMatchObject({ flowsScanned: 60, flowsFound: 60, installed: 3 });
    expect(calls.filter(c => c.type === 'SF_COMPOSITE_BATCH').flatMap(b => b.subrequests).some(x => /pkg__/.test(x.url))).toBe(false);
    expect(r.notes).toEqual(['3 active flow(s) come from installed packages — Salesforce does not expose their metadata, so they were NOT checked (they cannot be edited in this org either)']);
  });
});
