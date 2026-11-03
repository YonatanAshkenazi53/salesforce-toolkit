// 🧪 DRY RUN (1.1, 2026-11-03) — a real write that Salesforce rolls back.
//
// The engine builds its REAL payloads, hands every chunk to one composite
// request (allOrNone:true, poison last) and reads Salesforce's per-record
// verdicts. Errors surface one level at a time: the first failing subrequest
// keeps its per-record body, the rest report PROCESSING_HALTED, so refused
// rows (and the children pointing at them) leave the next round.
import { describe, it, expect, afterEach } from 'vitest';
import { extractFunctions } from './extract.mjs';

const eng = extractFunctions('background.js', [
  'executeProfileTransfer', 'sftkRunStopLine', '_runStopReason', '_runNoteStop', 'sftkVanillaPayloadRules', 'sftkEffectiveLookupResolutions', 'sftkLookupDefaultStrategy', 'buildCopyFields', 'sftkFieldsFromError', 'sftkOrgKey',
  'sftkTruncValue', 'sftkBuildOwnerIndex', 'sftkMatchKey', 'sftkPathValue',
  'sftkPiiHashHex', 'sftkPiiMaskable', 'sftkPiiFormat', 'sftkPiiMaskValue',
  'sftkPiiRulesForObject', 'sftkPiiMaskRows', 'sftkPiiMaskAnchorMap', 'sftkRtaImageCount',
  'sftkProbeToken', 'sftkProbeParseToken', 'sftkProbePoison', 'sftkProbeCompositeBody', 'sftkProbeParseRound', 'sftkProbeCascade', 'sftkProbeStatus', 'sftkProbeLimits',
]);

// ── the pure helpers ─────────────────────────────────────────────────────
describe('tokens: keyed by the SOURCE id, resolved to a position only when sent', () => {
  it('round-trips', () => {
    const t = eng.sftkProbeToken('n2', '001000000000001AAA');
    expect(t).toBe('@{n2[#001000000000001AAA].id}');
    expect(eng.sftkProbeParseToken(t)).toEqual({ ref: 'n2', srcId: '001000000000001AAA' });
    expect(eng.sftkProbeParseToken('001000000000001AAA')).toBeNull();
    expect(eng.sftkProbeParseToken('@{n2[3].id}')).toBeNull();   // a resolved reference is not a token
  });
});

describe('the composite body', () => {
  const subs = () => ([
    { ref: 'n0', objType: 'Account', upsertField: null, rows: [{ srcId: 'A1', payload: { Name: 'Holding' } }, { srcId: 'A2', payload: { Name: 'Branch' } }] },
    { ref: 'n1', objType: 'Contact', upsertField: null, rows: [{ srcId: 'C1', payload: { LastName: 'Levi', AccountId: '@{n0[#A2].id}' } }] },
  ]);
  it('one subrequest per node, parents first, references resolved to positions, the poison last', () => {
    const b = eng.sftkProbeCompositeBody(subs(), 'v62.0');
    expect(b.allOrNone).toBe(true);
    expect(b.compositeRequest).toHaveLength(3);
    expect(b.compositeRequest[0]).toMatchObject({ method: 'POST', url: '/services/data/v62.0/composite/sobjects', referenceId: 'n0' });
    expect(b.compositeRequest[0].body).toEqual({ allOrNone: false, records: [{ attributes: { type: 'Account' }, Name: 'Holding' }, { attributes: { type: 'Account' }, Name: 'Branch' }] });
    expect(b.compositeRequest[1].body.records[0]).toEqual({ attributes: { type: 'Contact' }, LastName: 'Levi', AccountId: '@{n0[1].id}' });
    const poison = b.compositeRequest[2];
    expect(poison).toMatchObject({ method: 'POST', url: '/services/data/v62.0/sobjects/Account', referenceId: 'poison' });
    expect(poison.body.Name).toBeUndefined();   // no Name = REQUIRED_FIELD_MISSING, always
    expect(Object.keys(poison.body)).toEqual(['Description']);
  });
  it('an upsert node goes as a PATCH on the external-id resource', () => {
    const s = subs(); s[0].upsertField = 'Ext__c';
    const b = eng.sftkProbeCompositeBody(s, 'v62.0');
    expect(b.compositeRequest[0]).toMatchObject({ method: 'PATCH', url: '/services/data/v62.0/composite/sobjects/Account/Ext__c' });
  });
  it('after a row leaves, the references to the others still point at the right rows', () => {
    const s = subs(); s[0].rows.shift();   // A1 gone
    const b = eng.sftkProbeCompositeBody(s, 'v62.0');
    expect(b.compositeRequest[1].body.records[0].AccountId).toBe('@{n0[0].id}');
  });
});

describe('reading a round', () => {
  const subs = [
    { ref: 'n0', objType: 'Account', rows: [{ srcId: 'A1' }, { srcId: 'A2' }] },
    { ref: 'n1', objType: 'Contact', rows: [{ srcId: 'C1' }, { srcId: 'C2' }] },
    { ref: 'n2', objType: 'Case', rows: [{ srcId: 'K1' }] },
  ];
  const halted = [{ errorCode: 'PROCESSING_HALTED', message: 'The transaction was rolled back since another operation in the same transaction failed.' }];
  it('nothing fails but the poison: every row would be written', () => {
    const resp = { compositeResponse: [
      { referenceId: 'n0', httpStatusCode: 400, body: halted },
      { referenceId: 'n1', httpStatusCode: 400, body: halted },
      { referenceId: 'n2', httpStatusCode: 400, body: halted },
      { referenceId: 'poison', httpStatusCode: 400, body: [{ errorCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [Name]', fields: ['Name'] }] },
    ] };
    const r = eng.sftkProbeParseRound(subs, resp);
    expect(r.poisonFailed).toBe(true);
    expect(r.subs.map(x => x.state)).toEqual(['halted', 'halted', 'halted']);
    expect(r.persisted).toEqual([]);
  });
  it('the first failing subrequest keeps its per-record body; the rest are halted', () => {
    const resp = { compositeResponse: [
      { referenceId: 'n0', httpStatusCode: 400, body: halted },
      { referenceId: 'n1', httpStatusCode: 200, body: [
        { success: true, id: '@{n1[0].id}' },   // never a real id in a rolled-back round
        { success: false, errors: [{ statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'a Lab lead needs a Phone', fields: ['Phone'] }] },
      ] },
      { referenceId: 'n2', httpStatusCode: 400, body: halted },
      { referenceId: 'poison', httpStatusCode: 400, body: [{ errorCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [Name]' }] },
    ] };
    const r = eng.sftkProbeParseRound(subs, resp);
    expect(r.subs[1].state).toBe('failing');
    expect(r.subs[1].rows).toEqual([
      { i: 0, srcId: 'C1', state: 'ok' },
      { i: 1, srcId: 'C2', state: 'refused', errors: [{ statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'a Lab lead needs a Phone', fields: ['Phone'] }] },
    ]);
    expect(r.persisted).toEqual([]);
  });
  it('a flat round: rolled-back rows read as "would be written"', () => {
    const resp = { compositeResponse: [
      { referenceId: 'n0', httpStatusCode: 200, body: [
        { success: false, errors: [{ statusCode: 'ALL_OR_NONE_OPERATION_ROLLED_BACK', message: 'Record rolled back because not all records were valid and the request was using AllOrNone header' }] },
        { success: false, errors: [{ statusCode: 'STRING_TOO_LONG', message: 'Account Name: data value too large', fields: ['Name'] }] },
      ] },
    ] };
    const r = eng.sftkProbeParseRound([subs[0]], resp);
    expect(r.subs[0].state).toBe('failing');
    expect(r.subs[0].rows.map(x => x.state)).toEqual(['ok', 'refused']);
  });
  it('a real id on a success is reported as possibly persisted; an accepted poison too', () => {
    const resp = { compositeResponse: [
      { referenceId: 'n0', httpStatusCode: 200, body: [{ success: true, id: '001000000000001AAA' }, { success: true, id: '001000000000002AAA' }] },
      { referenceId: 'poison', httpStatusCode: 201, body: { id: '001000000000009AAA', success: true, errors: [] } },
    ] };
    const r = eng.sftkProbeParseRound([subs[0]], resp);
    expect(r.poisonFailed).toBe(false);
    expect(r.persisted).toEqual([
      { objType: 'Account', id: '001000000000001AAA', srcId: 'A1' }, { objType: 'Account', id: '001000000000002AAA', srcId: 'A2' },
      { objType: 'Account', id: '001000000000009AAA', srcId: null, poison: true },
    ]);
  });
  it('a subrequest refused as a whole is an error with Salesforce\'s words', () => {
    const resp = { compositeResponse: [
      { referenceId: 'n0', httpStatusCode: 400, body: [{ errorCode: 'INVALID_FIELD', message: 'No such column Foo__c on sobject of type Account' }] },
      { referenceId: 'poison', httpStatusCode: 400, body: halted },
    ] };
    const r = eng.sftkProbeParseRound([subs[0]], resp);
    expect(r.subs[0]).toMatchObject({ state: 'error', error: 'No such column Foo__c on sobject of type Account' });
  });
});

describe('the cascade: a child of a refused parent leaves with it', () => {
  it('transitively, by token, and says which rows it dropped', () => {
    const live = [
      { ref: 'n0', objType: 'Account', rows: [{ srcId: 'A1', payload: { Name: 'a' } }, { srcId: 'A2', payload: { Name: 'b' } }] },
      { ref: 'n1', objType: 'Contact', rows: [{ srcId: 'C1', payload: { AccountId: '@{n0[#A1].id}' } }, { srcId: 'C2', payload: { AccountId: '@{n0[#A2].id}' } }] },
      { ref: 'n2', objType: 'Case', rows: [{ srcId: 'K1', payload: { ContactId: '@{n1[#C1].id}' } }, { srcId: 'K2', payload: { ContactId: '@{n1[#C2].id}' } }] },
    ];
    const dropped = eng.sftkProbeCascade(live, { n0: ['A2'] });
    expect(live[0].rows.map(r => r.srcId)).toEqual(['A1']);
    expect(live[1].rows.map(r => r.srcId)).toEqual(['C1']);
    expect(live[2].rows.map(r => r.srcId)).toEqual(['K1']);
    expect(dropped).toEqual({ n1: ['C2'], n2: ['K2'] });
  });
});

describe('the verdict of a run', () => {
  it('success only when every probed record would be written and nothing else went wrong', () => {
    expect(eng.sftkProbeStatus({ byObj: { Account: { wouldWrite: 3, refused: 0, cascade: 0, unreached: 0 } }, refusedLines: 0 }, [])).toBe('success');
    expect(eng.sftkProbeStatus({ byObj: { Account: { wouldWrite: 2, refused: 1, cascade: 0, unreached: 0 } }, refusedLines: 1 }, ['Account: refused'])).toBe('partial');
    expect(eng.sftkProbeStatus({ byObj: { Account: { wouldWrite: 0, refused: 3, cascade: 0, unreached: 0 } }, refusedLines: 3 }, ['Account: x', 'Account: y', 'Account: z'])).toBe('failed');
    expect(eng.sftkProbeStatus({ byObj: { Account: { wouldWrite: 3, refused: 0, cascade: 0, unreached: 0 } }, refusedLines: 0 }, ['Account: the source read came back INCOMPLETE'])).toBe('partial');
    expect(eng.sftkProbeStatus({ byObj: { Account: { wouldWrite: 3 } }, persistedFound: 1 }, [])).toBe('failed');
    expect(eng.sftkProbeStatus({ byObj: {} }, ['🧪 dry run stopped: boom'])).toBe('failed');
  });
});

// ── the engine in probe mode ─────────────────────────────────────────────
const SRC = 'https://src.my.salesforce.com', TGT = 'https://tgt.my.salesforce.com';
const f = (name, label, type, extra) => Object.assign({ name, label, type, createable: true, updateable: true, nillable: true, defaultValue: null, referenceTo: [], custom: false, length: 255 }, extra || {});
const DESC = {
  Account: { name: 'Account', fields: [f('Id', 'Account ID', 'id', { createable: false, updateable: false }), f('Name', 'Account Name', 'string', { nillable: false, nameField: true })] },
  Contact: { name: 'Contact', fields: [f('Id', 'Contact ID', 'id', { createable: false, updateable: false }), f('LastName', 'Last Name', 'string', { nillable: false, nameField: true }),
    f('Phone', 'Phone', 'phone'), f('AccountId', 'Account ID', 'reference', { referenceTo: ['Account'], relationshipName: 'Account' })] },
  Case: { name: 'Case', fields: [f('Id', 'Case ID', 'id', { createable: false, updateable: false }), f('Subject', 'Subject', 'string', { nameField: true }),
    f('ContactId', 'Contact ID', 'reference', { referenceTo: ['Contact'], relationshipName: 'Contact' })] },
};
const SRC_ROWS = {
  Account: [{ Id: 'A1', Name: 'Holding' }],
  Contact: [{ Id: 'C1', LastName: 'Levi', Phone: '050', AccountId: 'A1' }, { Id: 'C2', LastName: 'Cohen', AccountId: 'A1' }],
  Case:    [{ Id: 'K1', Subject: 'Broken', ContactId: 'C1' }, { Id: 'K2', Subject: 'Late', ContactId: 'C2' }],
};
let calls, composites;
function installWorld(opts = {}) {
  calls = []; composites = [];
  globalThis.API_VERSION = 'v62.0'; globalThis._runCancelled = false; globalThis.postRunProgress = (e) => calls.push(['progress', e]);
  const answer = (orgUrl, q) => {
    const obj = (/FROM (\w+)/.exec(q) || [])[1];
    let out = orgUrl === SRC ? (SRC_ROWS[obj] || []) : [];
    for (const m of q.matchAll(/(\w+) IN \(([^)]*)\)/g)) {
      const set = new Set([...m[2].matchAll(/'([^']+)'/g)].map(x => x[1]));
      out = out.filter(r => set.has(r[m[1]]));
    }
    if (/SELECT COUNT\(\)/.test(q)) return { totalSize: out.length, records: [] };
    return { records: out, totalSize: out.length, serverTotal: out.length };
  };
  globalThis.sfQuery    = async (o, s, q) => { calls.push(['query', o, q]); return answer(o, q); };
  globalThis.sfQueryAll = async (o, s, q) => { calls.push(['queryAll', o, q]); return answer(o, q); };
  globalThis.sfRestGet  = async (o, s, path) => { const m = /sobjects\/(\w+)\/describe/.exec(path); return (m && DESC[m[1]]) || { error: 'unexpected ' + path }; };
  globalThis.sfCollectionsCreate = async () => { throw new Error('a dry run must never create'); };
  globalThis.sfCollectionsUpdate = async () => { throw new Error('a dry run must never update'); };
  globalThis.sfCollectionsUpsert = async () => { throw new Error('a dry run must never upsert'); };
  globalThis.sfCollectionsDelete = async () => { throw new Error('a dry run must never delete'); };
  globalThis.sfBulkIngest = async () => { throw new Error('bulk not expected'); };
  globalThis.sfBulkQuery  = async () => { throw new Error('bulk query not expected'); };
  // Salesforce, as observed: the first subrequest with a failing record keeps
  // its body, everything else is halted; with no failure, only the poison fails.
  const halted = [{ errorCode: 'PROCESSING_HALTED', message: 'The transaction was rolled back since another operation in the same transaction failed.' }];
  const refuse = typeof opts.refuse === 'function' ? opts.refuse : () => null;
  globalThis.sfProbeComposite = async (o, s, body) => {
    composites.push(JSON.parse(JSON.stringify(body)));
    const subs = body.compositeRequest.filter(r => r.referenceId !== 'poison');
    let failing = -1;
    const bodies = subs.map((sub, k) => {
      const recs = sub.body.records;
      const results = recs.map(r => { const why = refuse(sub, r); return why ? { success: false, errors: [why] } : { success: true, id: `@{${sub.referenceId}}` }; });
      if (failing === -1 && results.some(x => !x.success)) failing = k;
      return results;
    });
    const compositeResponse = subs.map((sub, k) => (k === failing)
      ? { referenceId: sub.referenceId, httpStatusCode: 200, body: bodies[k] }
      : { referenceId: sub.referenceId, httpStatusCode: 400, body: halted });
    compositeResponse.push({ referenceId: 'poison', httpStatusCode: 400, body: failing === -1
      ? [{ errorCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [Name]', fields: ['Name'] }] : halted });
    return { compositeResponse };
  };
}
afterEach(() => { for (const k of ['API_VERSION', '_runCancelled', 'postRunProgress', 'sfQuery', 'sfQueryAll', 'sfRestGet', 'sfCollectionsCreate', 'sfCollectionsUpdate', 'sfCollectionsUpsert', 'sfCollectionsDelete', 'sfBulkIngest', 'sfBulkQuery', 'sfProbeComposite']) delete globalThis[k]; });

const tree = (picks) => ({ id: 'p1', name: 'one pass', probe: true, tree: { objectType: 'Account', recordIds: picks.Account, children: [
  { objectType: 'Contact', field: 'AccountId', recordIds: picks.Contact, children: [
    { objectType: 'Case', field: 'ContactId', recordIds: picks.Case, children: [] }] }] } });

describe('the engine in probe mode', () => {
  it('a clean tree: ONE composite, parents first, children referencing them, every record would be written, nothing created', async () => {
    installWorld();
    const r = await eng.executeProfileTransfer(tree({ Account: ['A1'], Contact: ['C1', 'C2'], Case: ['K1', 'K2'] }), SRC, 'SID_S', TGT, 'SID_T');
    expect(composites).toHaveLength(1);
    const req = composites[0].compositeRequest;
    expect(req.map(x => x.referenceId)).toEqual(['n0', 'n1', 'n2', 'poison']);
    expect(req[1].body.records.map(x => x.AccountId)).toEqual(['@{n0[0].id}', '@{n0[0].id}']);
    expect(req[2].body.records.map(x => x.ContactId)).toEqual(['@{n1[0].id}', '@{n1[1].id}']);
    expect(r.status).toBe('success');
    expect(r.probe.rounds).toBe(1);
    expect(r.summary.Account).toMatchObject({ created: 0, failed: 0, probe: { probed: 1, wouldWrite: 1, refused: 0, cascade: 0, unreached: 0 } });
    expect(r.summary.Contact.probe).toMatchObject({ probed: 2, wouldWrite: 2 });
    expect(r.summary.Case.probe).toMatchObject({ probed: 2, wouldWrite: 2 });
    expect(r.summary.Account.targetRecords).toBeUndefined();
    expect(r.summary.Account.idPairs).toBeUndefined();
    expect(r.summary.Account.verified).toBeUndefined();   // nothing to re-read
    expect(r.errors.some(e => /Dry run limits/.test(e))).toBe(true);
    const done = calls.filter(c => c[0] === 'progress' && c[1].phase === 'probeDone').map(c => c[1].obj);
    expect(done).toEqual(['Account', 'Contact', 'Case']);
  });

  it('a refused child: round 2 goes without it and without its own children; the verdict names the record and the field value sent', async () => {
    installWorld({ refuse: (sub, r) => (sub.referenceId === 'n1' && !r.Phone)
      ? { statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'a Lab lead needs a Phone', fields: ['Phone'] } : null });
    const r = await eng.executeProfileTransfer(tree({ Account: ['A1'], Contact: ['C1', 'C2'], Case: ['K1', 'K2'] }), SRC, 'SID_S', TGT, 'SID_T');
    expect(composites).toHaveLength(2);
    expect(composites[1].compositeRequest[1].body.records.map(x => x.LastName)).toEqual(['Levi']);
    expect(composites[1].compositeRequest[2].body.records.map(x => x.Subject)).toEqual(['Broken']);
    expect(r.status).toBe('partial');
    expect(r.probe.rounds).toBe(2);
    expect(r.summary.Contact).toMatchObject({ failed: 1, probe: { probed: 2, wouldWrite: 1, refused: 1, cascade: 0 } });
    expect(r.summary.Contact.failedSourceIds).toEqual([{ id: 'C2', error: 'a Lab lead needs a Phone', label: 'Cohen', fields: [{ field: 'Phone', absent: true }] }]);
    expect(r.summary.Case.probe).toMatchObject({ probed: 2, wouldWrite: 1, refused: 0, cascade: 1 });
    expect(r.errors).toContain('Contact: a Lab lead needs a Phone');
    expect(r.errors.some(e => /Case: 2 record\(s\) in a transaction .* 1 would be written, 0 refused, 1 not checked \(their parent would be refused\)/.test(e))).toBe(true);
  });

  it('every parent refused: nothing would be written, the children are not checked, status failed', async () => {
    installWorld({ refuse: (sub) => sub.referenceId === 'n0' ? { statusCode: 'DUPLICATES_DETECTED', message: 'You\'re creating a duplicate record.' } : null });
    const r = await eng.executeProfileTransfer(tree({ Account: ['A1'], Contact: ['C1'], Case: ['K1'] }), SRC, 'SID_S', TGT, 'SID_T');
    expect(composites).toHaveLength(1);   // the failing sub was the first and its children all left — nothing to re-send
    expect(r.status).toBe('failed');
    expect(r.summary.Account.probe).toMatchObject({ refused: 1, wouldWrite: 0 });
    expect(r.summary.Contact.probe).toMatchObject({ cascade: 1 });
    expect(r.summary.Case.probe).toMatchObject({ cascade: 1 });
    expect(r.errors.some(e => /\[DUPLICATES_DETECTED\]/.test(e))).toBe(true);
  });

  it('a record Salesforce reports as written is re-read, deleted again and said out loud', async () => {
    installWorld();
    globalThis.sfProbeComposite = async () => ({ compositeResponse: [
      { referenceId: 'n0', httpStatusCode: 200, body: [{ success: true, id: '001000000000001AAA' }] },
      { referenceId: 'poison', httpStatusCode: 201, body: { id: '001000000000009AAA', success: true, errors: [] } },
    ] });
    const seen = [];
    globalThis.sfQueryAll = async (o, s, q) => {
      if (o === TGT && /FROM Account WHERE Id IN/.test(q)) return { records: [{ Id: '001000000000001AAA' }, { Id: '001000000000009AAA' }] };
      const obj = (/FROM (\w+)/.exec(q) || [])[1];
      let out = o === SRC ? (SRC_ROWS[obj] || []) : [];
      for (const m of q.matchAll(/(\w+) IN \(([^)]*)\)/g)) { const set = new Set([...m[2].matchAll(/'([^']+)'/g)].map(x => x[1])); out = out.filter(r => set.has(r[m[1]])); }
      return { records: out, totalSize: out.length, serverTotal: out.length };
    };
    globalThis.sfCollectionsDelete = async (o, s, ids) => { seen.push(ids); return ids.map(id => ({ id, success: true })); };
    const r = await eng.executeProfileTransfer({ id: 'p', name: 'x', probe: true, tree: { objectType: 'Account', recordIds: ['A1'], children: [] } }, SRC, 'S', TGT, 'T');
    expect(seen).toEqual([['001000000000001AAA', '001000000000009AAA']]);
    expect(r.status).toBe('failed');
    expect(r.errors.some(e => /2 record\(s\) from the dry run WERE written .* 2 deleted again/.test(e))).toBe(true);
  });

  it('two steps of one run share a ledger: a row that points at a record the first step creates is set aside, never refused, and no token crosses over', async () => {
    installWorld();
    const ledger = { idMap: {}, lateRefs: [], at: Date.now() };
    // step 1: the Contacts (as a flat root — their Account is in the target already in this scenario)
    const r1 = await eng.executeProfileTransfer({ id: 'p', name: 's1', probe: true, tree: { objectType: 'Contact', recordIds: ['C1', 'C2'], children: [] } }, SRC, 'S', TGT, 'T', ledger.idMap, ledger);
    expect(r1.summary.Contact.probe).toMatchObject({ probed: 2, wouldWrite: 2 });
    expect(ledger.idMap).toEqual({});                    // no token leaked into the real-id map
    expect(Object.keys(ledger.probeIds).sort()).toEqual(['C1', 'C2']);
    // step 2: the Cases, which point at those Contacts
    const r2 = await eng.executeProfileTransfer({ id: 'p', name: 's2', probe: true, tree: { objectType: 'Case', recordIds: ['K1', 'K2'], children: [] } }, SRC, 'S', TGT, 'T', ledger.idMap, ledger);
    expect(composites).toHaveLength(1);                  // step 2 had nothing left to send
    expect(r2.summary.Case.probe).toMatchObject({ probed: 2, wouldWrite: 0, refused: 0, earlier: 2 });
    expect(r2.errors.some(e => /Case: 2 record\(s\) .* 2 not checked \(they point at a record an earlier step of this run creates\)/.test(e))).toBe(true);
    expect(r2.status).toBe('partial');
  });

  it('a sample: only the first 200 of a big object go, and the run says so', async () => {
    installWorld();
    const many = Array.from({ length: 250 }, (_, i) => ({ Id: `A${String(i).padStart(3, '0')}`, Name: `Acc ${i}` }));
    const saved = SRC_ROWS.Account; SRC_ROWS.Account = many;
    try {
      const r = await eng.executeProfileTransfer({ id: 'p', name: 'x', probe: true, tree: { objectType: 'Account', where: '', children: [] } }, SRC, 'S', TGT, 'T');
      expect(composites[0].compositeRequest[0].body.records).toHaveLength(200);
      expect(r.summary.Account.probe).toMatchObject({ probed: 200, wouldWrite: 200, sampledOf: 250 });
      expect(r.errors.some(e => /a sample: the first 200 of 250/.test(e))).toBe(true);
    } finally { SRC_ROWS.Account = saved; }
  });
});
