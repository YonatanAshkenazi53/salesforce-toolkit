// Regressions of the release-QA commit f0334a0, found by an independent review — 2026-11-15.
//
// Flow Access (flow-permissions.js)
//  A. doAssign skipped every pair the module's _accessMap listed. That map is only as fresh as the last load: after a
//     History undo (or a change in Setup) the pair was skipped, nothing was sent, and the result said Salesforce had
//     accepted the write. The skip set is now read from the org right before the insert.
//  B. The insert is allOrNone:false, yet the result was all-or-nothing: any refused pair gave "0 assigned, 1 failed"
//     with grants sitting in the org. The result is now per pair.
//  C. A pair granted elsewhere since the read came back as "duplicate value" and was called a failure although the org
//     was as asked. A duplicate refusal now goes to the re-read, which decides.
//  D. The release tests only read the source text. These run the real insertFlowAccess / readFlowAccessRows /
//     doAssign (sliced out of the FlowPermissions IIFE) with the real sftk-write.js against an in-memory
//     SetupEntityAccess table.
//
// Lightning Pages (lightning-pages.js)
//  E. Clone Page refused an API name that only an installed package's page uses (ns__X has DeveloperName X; a deploy
//     of X makes a separate page). The real doClone runs here against a stubbed org.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunctions } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = f => readFileSync(join(root, f), 'utf8').replace(/\r\n/g, '\n');
const slice = (src, a, b) => {
  const i = src.indexOf(a); if (i < 0) throw new Error(`marker not found: ${a}`);
  const j = src.indexOf(b, i); if (j < 0) throw new Error(`end marker not found: ${b}`);
  return src.slice(i, j);
};

// ── Flow Access harness ────────────────────────────────────────────────────
const FP = rd('flow-permissions.js');
const FP_FNS = slice(FP, '  async function insertFlowAccess(pairs) {', '  // ── UI helpers');
const CHECK = extractFunctions('flow-permissions.js', ['sftkFlowAccessCheck']).sftkFlowAccessCheck;
// The real write discipline; History's note is recorded so the journal's sentence can be read.
const loadWrite = (sftkHistoryNote) => new Function('sftkHistoryNote', `${rd('sftk-write.js')}\nreturn sftkWriteVerified;`)(sftkHistoryNote);

const DUP = { statusCode: 'DUPLICATE_VALUE', message: 'duplicate value found: <unknown> duplicates value on record with id: <unknown>' };

// rows: the org's SetupEntityAccess table. opts:
//   refuse(record)      → an errors[] array to refuse that insert with
//   beforeCreate(org)   → runs when the insert arrives, before it is applied (someone else changing the org)
//   failRead            → the numbers (1-based) of the SetupEntityAccess reads that fail
//   throwCreate         → the numbers (1-based) of the insert calls that throw
//   rawCreate(msg)      → the insert's whole answer, as given
//   beforeRead(n, org)  → runs when read number n arrives, before it is answered
//   staleMap            → what the module's _accessMap holds (never refreshed by the stubbed loadData)
function build(rows = [], opts = {}) {
  const org = { rows: rows.map(r => ({ ...r })), nextId: 1 };
  const calls = { sent: [], reads: 0, creates: 0, modals: [], historyBegin: [], historyEnd: [], notes: [], loadData: 0 };
  const els = {};
  const sendBg = async (msg) => {
    calls.sent.push(msg);
    if (msg.type === 'SF_QUERY_ALL') {
      calls.reads++;
      if (opts.beforeRead) opts.beforeRead(calls.reads, org);
      if ((opts.failRead || []).includes(calls.reads)) return { error: 'HTTP 503: read failed' };
      const lists = [...msg.query.matchAll(/IN \(([^)]*)\)/g)].map(m => m[1].split(',').map(s => s.replace(/'/g, '').trim()));
      const [fl, pl] = lists;
      return { records: org.rows.filter(r => fl.includes(r.SetupEntityId) && pl.includes(r.ParentId)).map(r => ({ ...r })) };
    }
    if (msg.type === 'SF_COLLECTIONS_CREATE') {
      calls.creates++;
      if ((opts.throwCreate || []).includes(calls.creates)) throw new Error('HTTP 500: chunk failed');
      if (opts.rawCreate) return opts.rawCreate(msg);
      if (opts.beforeCreate) opts.beforeCreate(org);
      return msg.records.map(rec => {
        const no = opts.refuse && opts.refuse(rec);
        if (no) return { success: false, errors: no };
        if (org.rows.some(r => r.ParentId === rec.ParentId && r.SetupEntityId === rec.SetupEntityId)) return { success: false, errors: [DUP] };
        const id = `0J0${String(org.nextId++).padStart(4, '0')}`;
        org.rows.push({ Id: id, ParentId: rec.ParentId, SetupEntityId: rec.SetupEntityId });
        return { success: true, id, errors: [] };
      });
    }
    throw new Error(`unexpected message ${msg.type}`);
  };
  const env = {
    document: { getElementById: id => (els[id] ||= { id, disabled: false, textContent: '', innerHTML: '', addEventListener() {} }) },
    sftkCatSm: t => t,
    sftkHistoryBegin: o => { calls.historyBegin.push(o); return { o }; },
    sftkHistoryEnd: async (j, rec) => { calls.historyEnd.push(rec); },
    sftkWriteVerified: loadWrite((j, out, d) => calls.notes.push({ out, d })),
    sftkFlowAccessCheck: CHECK,
    sftkFriendlyError: raw => ({ message: String(raw), hint: '' }),
    loadData: async () => { calls.loadData++; },
    updateActionBar: () => {},
    showModal: html => calls.modals.push(html),
    closeModal: () => {},
    esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    sendBg,
    _orgUrl: 'https://acme.my.salesforce.com', _sid: 'SID',
    _accessMap: opts.staleMap || {},
  };
  const fns = new Function('env', `with (env) {\n${FP_FNS}\nreturn { insertFlowAccess, readFlowAccessRows, doAssign };\n}`)(env);
  const creates = () => calls.sent.filter(m => m.type === 'SF_COLLECTIONS_CREATE');
  const modal = () => calls.modals[calls.modals.length - 1] || '';
  const heading = () => (/<h2>([\s\S]*?)<\/h2>/.exec(modal()) || [])[1]?.trim();
  return { org, calls, fns, creates, modal, heading };
}

const flowA = { Id: '300A', MasterLabel: 'Flow A' };
const flowB = { Id: '300B', MasterLabel: 'Flow B' };
const set1 = { Id: '0PS1', Label: 'Set 1' };
const set2 = { Id: '0PS2', Label: 'Set 2' };
const has = (org, f, p) => org.rows.some(r => r.SetupEntityId === f.Id && r.ParentId === p.Id);

describe('A. the skip set comes from the org, not from the module\'s last load', () => {
  it('a grant the stale map still lists, but the org no longer has, is inserted', async () => {
    const h = build([], { staleMap: { '300A': [{ permSetId: '0PS1', label: 'Set 1', accessId: '0J0old' }] } });
    await h.fns.doAssign([flowA], [set1]);
    expect(h.creates()).toHaveLength(1);
    expect(h.creates()[0].records).toEqual([{ attributes: { type: 'SetupEntityAccess' }, ParentId: '0PS1', SetupEntityId: '300A' }]);
    expect(has(h.org, flowA, set1)).toBe(true);
    expect(h.heading()).toBe('1 Flow Assigned');
    expect(h.modal()).toContain('1 grant made');
    expect(h.calls.historyEnd[0].undo.steps).toHaveLength(1);
  });
  it('Assign → the row is removed behind the tool (History undo) → Assign again grants it again', async () => {
    const h = build();
    await h.fns.doAssign([flowA], [set1]);
    expect(h.org.rows).toHaveLength(1);
    h.org.rows.length = 0;                       // what the History undo does; nothing reloads Flow Access
    await h.fns.doAssign([flowA], [set1]);
    expect(h.creates()).toHaveLength(2);
    expect(has(h.org, flowA, set1)).toBe(true);
    expect(h.heading()).toBe('1 Flow Assigned');
    expect(h.modal()).not.toContain('does not show');
    expect(h.calls.notes[1].out.ok).toBe(true);
  });
  it('a read that fails before the write sends nothing, records nothing, and says so', async () => {
    const h = build([], { failRead: [1] });
    await h.fns.doAssign([flowA], [set1]);
    expect(h.creates()).toHaveLength(0);
    expect(h.calls.historyBegin).toHaveLength(0);
    expect(h.org.rows).toHaveLength(0);
    expect(h.heading()).toBe('Nothing was written');
    expect(h.modal()).toContain('could not be read, so nothing was written');
    expect(h.modal()).toContain('HTTP 503: read failed');
  });
  it('a selection that is already granted writes nothing and is not called an accepted write', async () => {
    const h = build([{ Id: '0J0x', ParentId: '0PS1', SetupEntityId: '300A' }]);   // the map is empty: the ORG says granted
    await h.fns.doAssign([flowA], [set1]);
    expect(h.creates()).toHaveLength(0);
    expect(h.calls.historyBegin).toHaveLength(0);
    expect(h.calls.notes).toHaveLength(0);
    expect(h.heading()).toBe('Already granted — nothing to do');
    expect(h.modal()).toContain('Nothing was written');
    expect(h.org.rows).toEqual([{ Id: '0J0x', ParentId: '0PS1', SetupEntityId: '300A' }]);
  });
  it('only the pairs the org lacks are inserted, and the undo covers only those', async () => {
    const h = build([{ Id: '0J0x', ParentId: '0PS1', SetupEntityId: '300A' }]);
    await h.fns.doAssign([flowA, flowB], [set1]);
    expect(h.creates()[0].records.map(r => r.SetupEntityId)).toEqual(['300B']);
    expect(h.heading()).toBe('2 Flows Assigned');
    expect(h.modal()).toContain('1 grant made, 1 already in place');
    const steps = h.calls.historyEnd[0].undo.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0].describe).toBe('Flow B → Set 1: remove flow access');
    expect(steps[0].msg.id).not.toBe('0J0x');
  });
});

describe('B. a partial insert is reported per pair', () => {
  const refuse2 = rec => (rec.ParentId === '0PS2' ? [{ statusCode: 'INSUFFICIENT_ACCESS', message: 'insufficient access rights on cross-reference id' }] : null);
  it('2 of 4 made: the heading counts them, both lists name their pairs, the undo is offered', async () => {
    const h = build([], { refuse: refuse2 });
    await h.fns.doAssign([flowA, flowB], [set1, set2]);
    expect(h.org.rows).toHaveLength(2);
    expect(h.heading()).toBe('2 of 4 grants made');
    const m = h.modal();
    expect(m).not.toContain('0 assigned');
    const assigned = m.slice(m.indexOf('Assigned:'), m.indexOf('Failed:'));
    const failed = m.slice(m.indexOf('Failed:'));
    expect(assigned).toContain('Flow A → Set 1');
    expect(assigned).toContain('Flow B → Set 1');
    expect(assigned).not.toContain('Set 2');
    expect(failed).toContain('<strong>Flow A → Set 2</strong>: insufficient access rights on cross-reference id');
    expect(failed).toContain('<strong>Flow B → Set 2</strong>: insufficient access rights on cross-reference id');
    expect(m).toContain('Undo in History removes the 2 grants this run created');
    expect(h.calls.historyEnd[0].undo.steps.map(s => s.describe)).toEqual(['Flow A → Set 1: remove flow access', 'Flow B → Set 1: remove flow access']);
    // History's sentence carries the true count too.
    expect(h.calls.notes[0].out.ok).toBe(false);
    expect(h.calls.notes[0].out.text).toContain('2 of 4 grant(s) are in the org after re-reading');
  });
  it('every pair refused for a real reason: 0 of N, Salesforce\'s reason, no undo, and no re-read is claimed', async () => {
    const h = build([], { refuse: () => [{ statusCode: 'INSUFFICIENT_ACCESS', message: 'no access' }] });
    await h.fns.doAssign([flowA], [set1]);
    expect(h.heading()).toBe('0 of 1 grant made');
    expect(h.modal()).toContain('<strong>Flow A → Set 1</strong>: no access');
    expect(h.modal()).not.toContain('Undo in History');
    expect(h.calls.reads).toBe(1);               // the read before the write only
    expect(h.calls.notes[0].out.accepted).toBe(false);
    expect(h.calls.historyEnd[0].undo.none).toBeTruthy();
  });
  it('rows created, then the re-read fails: said as created and not confirmed, with the undo built from the returned ids', async () => {
    const h = build([], { failRead: [2] });
    await h.fns.doAssign([flowA, flowB], [set1]);
    expect(h.org.rows).toHaveLength(2);
    expect(h.heading()).toBe('2 grants created — not confirmed');
    const m = h.modal();
    expect(m).toContain('treat this as unverified');
    expect(m).toContain('Created (not confirmed):');
    expect(m).toContain('Flow A → Set 1');
    expect(m).toContain('Flow B → Set 1');
    expect(m).not.toContain('Failed:');
    expect(m).not.toContain('0 assigned');
    const steps = h.calls.historyEnd[0].undo.steps;
    expect(steps.map(s => s.msg.id).sort()).toEqual(h.org.rows.map(r => r.Id).sort());
    expect(h.calls.notes[0].out.verified).toBe(false);
  });
  it('a created row the re-read does not show is a failure of that pair, and the undo still holds its id', async () => {
    // Flow B's row is gone again by the time the verify reads (read 2).
    const h = build([], { beforeRead: (n, org) => { if (n === 2) org.rows = org.rows.filter(r => r.SetupEntityId !== '300B'); } });
    await h.fns.doAssign([flowA, flowB], [set1]);
    expect(h.heading()).toBe('1 of 2 grants made');
    expect(h.modal()).toContain('<strong>Flow B → Set 1</strong>: Salesforce accepted it, but the org does not show this grant after re-reading');
    expect(h.calls.historyEnd[0].undo.steps).toHaveLength(2);
  });
});

describe('C. a pair granted elsewhere since the read is not a failure', () => {
  const addBehind = (f, p) => org => { if (!has(org, f, p)) org.rows.push({ Id: '0J0else', ParentId: p.Id, SetupEntityId: f.Id }); };
  it('every insert refused as a duplicate: the re-read decides, and the org being as asked is said as that', async () => {
    const h = build([], { beforeCreate: addBehind(flowA, set1) });
    await h.fns.doAssign([flowA], [set1]);
    expect(h.creates()).toHaveLength(1);         // it was tried — the read before it showed no grant
    expect(h.calls.reads).toBe(2);               // and re-read
    expect(h.heading()).toBe('Already granted — nothing to do');
    expect(h.modal()).not.toContain('duplicate value');
    expect(h.modal()).not.toContain('Failed');
    expect(h.calls.notes[0].out.ok).toBe(true);
    expect(h.calls.historyEnd[0].undo.none).toBeTruthy();   // this run created nothing: the other admin's row is never undone
  });
  it('one duplicate beside one real insert: assigned, with the one made and the one already there counted apart', async () => {
    const h = build([], { beforeCreate: addBehind(flowA, set1) });
    await h.fns.doAssign([flowA, flowB], [set1]);
    expect(h.heading()).toBe('2 Flows Assigned');
    expect(h.modal()).toContain('1 grant made, 1 already in place');
    const steps = h.calls.historyEnd[0].undo.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0].describe).toBe('Flow B → Set 1: remove flow access');
  });
  it('a duplicate refusal whose grant is NOT in the org after the re-read stays a failure', async () => {
    const h = build([], { refuse: () => [DUP] });   // Salesforce says duplicate, the table shows nothing
    await h.fns.doAssign([flowA], [set1]);
    expect(h.heading()).toBe('0 of 1 grant made');
    expect(h.modal()).toContain('<strong>Flow A → Set 1</strong>: duplicate value found');
  });
});

describe('D. insertFlowAccess and readFlowAccessRows, run', () => {
  const mk = n => Array.from({ length: n }, (_, i) => ({ key: `300F${i}|0PS1`, flowId: `300F${i}`, psId: '0PS1' }));
  it('SaveResults are mapped to pairs by position, and a duplicate refusal is marked', async () => {
    const h = build([{ Id: '0J0x', ParentId: '0PS1', SetupEntityId: '300F1' }], {
      refuse: rec => (rec.SetupEntityId === '300F2' ? [{ statusCode: 'FIELD_INTEGRITY_EXCEPTION', message: 'bad id' }] : null),
    });
    const r = await h.fns.insertFlowAccess(mk(4));
    expect(r.created.map(c => c.key)).toEqual(['300F0|0PS1', '300F3|0PS1']);
    for (const c of r.created) expect(h.org.rows.find(x => x.Id === c.id).SetupEntityId).toBe(c.key.split('|')[0]);
    expect(r.refused).toEqual({ '300F1|0PS1': DUP.message, '300F2|0PS1': 'bad id' });
    expect(r.duplicate).toEqual({ '300F1|0PS1': true });
  });
  it('chunks of 200; a later chunk that throws keeps the ids of the earlier one and never throws itself', async () => {
    const h = build([], { throwCreate: [2] });
    const r = await h.fns.insertFlowAccess(mk(250));
    expect(h.creates().map(m => m.records.length)).toEqual([200, 50]);
    expect(r.created).toHaveLength(200);
    expect(r.created[199].key).toBe('300F199|0PS1');
    expect(Object.keys(r.refused)).toHaveLength(50);
    expect(r.refused['300F200|0PS1']).toBe('HTTP 500: chunk failed');
    expect(r.duplicate).toEqual({});
  });
  it('nothing to insert sends nothing; an answer that is not a list, or a row without an id, is a refusal with a reason', async () => {
    const h = build();
    expect(await h.fns.insertFlowAccess([])).toEqual({ created: [], refused: {}, duplicate: {} });
    expect(h.creates()).toHaveLength(0);
    const e = build([], { rawCreate: () => ({ error: 'HTTP 401: SESSION_EXPIRED' }) });
    expect(await e.fns.insertFlowAccess(mk(2))).toEqual({ created: [], refused: { '300F0|0PS1': 'HTTP 401: SESSION_EXPIRED', '300F1|0PS1': 'HTTP 401: SESSION_EXPIRED' }, duplicate: {} });
    const odd = build([], { rawCreate: () => [{ success: true }, null] });
    expect(await odd.fns.insertFlowAccess(mk(2))).toEqual({ created: [], refused: { '300F0|0PS1': 'not accepted', '300F1|0PS1': 'not accepted' }, duplicate: {} });
  });
  it('readFlowAccessRows returns the org\'s rows for the selection and throws on an error', async () => {
    const h = build([{ Id: 'a', ParentId: '0PS1', SetupEntityId: '300A' }, { Id: 'b', ParentId: '0PS9', SetupEntityId: '300A' }]);
    expect(await h.fns.readFlowAccessRows([flowA, flowB], [set1, set2])).toEqual([{ Id: 'a', ParentId: '0PS1', SetupEntityId: '300A' }]);
    const bad = build([], { failRead: [1] });
    await expect(bad.fns.readFlowAccessRows([flowA], [set1])).rejects.toThrow(/could not be re-read — HTTP 503/);
  });
  it('doAssign after a later chunk failed: the 200 made are counted, the 50 are failed, the undo has 200 steps', async () => {
    const flows = Array.from({ length: 250 }, (_, i) => ({ Id: `300F${i}`, MasterLabel: `F${i}` }));
    const h = build([], { throwCreate: [2] });
    await h.fns.doAssign(flows, [set1]);
    expect(h.heading()).toBe('200 of 250 grants made');
    expect(h.modal()).toContain('…and 150 more');
    expect(h.modal()).toContain('HTTP 500: chunk failed');
    expect(h.calls.historyEnd[0].undo.steps).toHaveLength(200);
  });
});

// ── Clone Page ─────────────────────────────────────────────────────────────
const LP = rd('lightning-pages.js');
const LPF = extractFunctions('lightning-pages.js', ['lpPageIsPackaged', 'lpCloneNameTaken', 'lpCloneFindOwn', 'lpWhy']);
const DO_CLONE = (() => { const i = LP.indexOf('  async function doClone('); return LP.slice(i, LP.indexOf('\n  }\n', i) + 5); })();

function buildClone(pages, opts = {}) {
  const org = { pages: pages.map(p => ({ ...p })) };
  const calls = { sent: [], opened: [], historyEnd: [] };
  const allPages = [];
  const bg = async (msg) => {
    calls.sent.push(msg);
    if (msg.type === 'SF_QUERY') {
      if (opts.failQuery) return { error: 'HTTP 500: boom' };
      const name = /DeveloperName='([^']*)'/.exec(msg.query)[1].toLowerCase();
      return { records: org.pages.filter(p => p.DeveloperName.toLowerCase() === name).map(p => ({ ...p })) };
    }
    if (msg.type === 'SF_METADATA_DEPLOY') {
      if (!opts.deployMakesNothing) org.pages.push({ Id: '0M0new', DeveloperName: msg.zipBase64, MasterLabel: 'Copy', NamespacePrefix: null, ManageableState: 'unmanaged' });
      return { success: true };
    }
    throw new Error(`unexpected message ${msg.type}`);
  };
  const env = {
    ...LPF, bg, allPages,
    buildFlexiPageZip: m => m.FullName,          // the stub deploy reads the API name back from here
    sftkHistoryBegin: () => ({}),
    sftkHistoryEnd: async (j, rec) => { calls.historyEnd.push(rec); },
    sftkWriteVerified: loadWrite(() => {}),
    openDetail: async (page, err, note) => { calls.opened.push({ page, note }); },
    _orgUrl: 'https://acme.my.salesforce.com', _sid: 'SID',
  };
  const doClone = new Function('env', `with (env) {\n${DO_CLONE}\nreturn doClone;\n}`)(env);
  const run = name => doClone({ MasterLabel: 'Orig' }, { Metadata: { masterLabel: 'Orig' } }, [], 'Copy', name, false, {}, () => {});
  const deploys = () => calls.sent.filter(m => m.type === 'SF_METADATA_DEPLOY');
  return { org, calls, allPages, run, deploys };
}

describe('E. Clone Page: an installed package\'s page does not hold the API name', () => {
  const managed = { Id: '0M0pkg', DeveloperName: 'Account_Record_Page', MasterLabel: 'Packaged', NamespacePrefix: 'npsp', ManageableState: 'installed' };
  const own = { Id: '0M0own', DeveloperName: 'Account_Record_Page', MasterLabel: 'Mine', NamespacePrefix: null, ManageableState: 'unmanaged' };

  it('lpPageIsPackaged: only a namespace together with an installed state', () => {
    expect(LPF.lpPageIsPackaged(managed)).toBe(true);
    expect(LPF.lpPageIsPackaged({ NamespacePrefix: 'x', ManageableState: 'installedEditable' })).toBe(true);
    expect(LPF.lpPageIsPackaged(own)).toBe(false);
    expect(LPF.lpPageIsPackaged({ NamespacePrefix: 'myns', ManageableState: 'unmanaged' })).toBe(false);   // a namespaced org's own page
    expect(LPF.lpPageIsPackaged({ NamespacePrefix: 'myns', ManageableState: 'released' })).toBe(false);    // a packaging org's own page
    expect(LPF.lpPageIsPackaged({ ManageableState: 'installed' })).toBe(false);                             // namespace not read: the safe side
    expect(LPF.lpPageIsPackaged({ NamespacePrefix: 'npsp' })).toBe(false);                                  // state not read: the safe side
    expect(LPF.lpPageIsPackaged(null)).toBe(false);
  });
  it('lpCloneNameTaken: free beside a packaged page, taken by the org\'s own page (also beside a packaged one)', () => {
    expect(LPF.lpCloneNameTaken([managed], 'account_record_page')).toBe(false);
    expect(LPF.lpCloneNameTaken([own], 'account_record_page')).toBe(true);
    expect(LPF.lpCloneNameTaken([managed, own], 'Account_Record_Page')).toBe(true);
    expect(LPF.lpCloneNameTaken([{ DeveloperName: 'Account_Record_Page', NamespacePrefix: 'myns', ManageableState: 'unmanaged' }], 'Account_Record_Page')).toBe(true);
    expect(LPF.lpCloneNameTaken([{ DeveloperName: 'Account_Record_Page' }], 'Account_Record_Page')).toBe(true);   // nothing read about its package
  });
  it('the page list reads NamespacePrefix, so the dialog\'s check can tell the two apart', () => {
    expect(LP).toContain('SELECT Id,DeveloperName,MasterLabel,Type,EntityDefinitionId,ManageableState,NamespacePrefix ` +\n             `FROM FlexiPage ORDER BY MasterLabel`');
  });
  it('doClone deploys beside a packaged page of the same name and opens the NEW page, not the packaged one', async () => {
    const h = buildClone([managed]);
    await h.run('Account_Record_Page');
    expect(h.deploys()).toHaveLength(1);
    expect(h.calls.opened).toHaveLength(1);
    expect(h.calls.opened[0].page.Id).toBe('0M0new');
    expect(h.allPages.map(p => p.Id)).toEqual(['0M0new']);
  });
  it('doClone does not take the packaged page for the clone when the deploy made nothing', async () => {
    const h = buildClone([managed], { deployMakesNothing: true });
    await expect(h.run('Account_Record_Page')).rejects.toThrow(/not found after deploy/);
    expect(h.calls.opened).toHaveLength(0);
    expect(h.allPages).toHaveLength(0);
  });
  it('doClone still refuses the org\'s own page of that name, any case, before anything is written', async () => {
    for (const pages of [[own], [managed, own], [{ ...own, NamespacePrefix: 'myns' }]]) {
      const h = buildClone(pages);
      await expect(h.run('account_record_page')).rejects.toThrow('DUPLICATE_DEVELOPER_NAME');
      expect(h.deploys()).toHaveLength(0);
      expect(h.calls.historyEnd).toHaveLength(0);
    }
  });
  it('doClone refuses when the name check itself fails', async () => {
    const h = buildClone([], { failQuery: true });
    await expect(h.run('Fresh_Name')).rejects.toThrow(/Could not check whether the API name "Fresh_Name" is free .* nothing was written/);
    expect(h.deploys()).toHaveLength(0);
  });
  it('a free name clones as before', async () => {
    const h = buildClone([own]);
    await h.run('Fresh_Name');
    expect(h.deploys()).toHaveLength(1);
    expect(h.calls.opened[0].page.Id).toBe('0M0new');
  });
});
