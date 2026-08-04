// PII MASKING v1 — DRY RUN + FAN-OUT DISCLOSURE (stream: pii-dryrun).
//
// The engine masks policy-covered fields at write time, so a dry run that
// validates RAW sample values lies twice: a raw value passing a restricted
// picklist proves nothing about the hashed string the run actually writes,
// and a raw anchor probing the target both leaks a covered value into a
// target-org query and predicts a match the masked-to-masked engine never
// makes. These tests pin:
//   1. Signature threading — sftkDryRunAgainst carries piiPolicy/piiSalt/
//      upsertField, and BOTH callers (runTransfer, dryRunFanOut) pass the
//      profile's own policy, the same way ownerMapping already rides.
//   2. The write-nothing invariant survives the additions — still only
//      SF_QUERY + SF_REST_GET (the existing fanout-dryrun suite pins this
//      too; re-asserted here so this stream fails on its own regressions).
//   3. Behaviour: per-object masking disclosure counts, masked-not-raw
//      value checks (restricted picklist, field length), match-key warnings
//      (lookup anchor, owner matching, upsert External-ID), and the
//      missing-salt hard error BEFORE any org call.
//   4. The fan-out "What this will do" grid's PII row, sourced from the
//      exact profile runFanOut sends (as saved, {...p} spread).
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunctions } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TRANSFER = readFileSync(join(root, 'studio-transfer.js'), 'utf8');

// Same source-slicing invariant as extract.mjs: top-level functions close
// with `}` at column 0.
function sourceOf(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(TRANSFER);
  if (!m) throw new Error(`top-level function ${name} not found`);
  const end = TRANSFER.indexOf('\n}', m.index);
  return TRANSFER.slice(m.index, end + 2);
}

// ══════════════════════════════════════════════════════════════════
// 1. Signature threading — the policy rides like ownerMapping does
// ══════════════════════════════════════════════════════════════════
describe('signature threading', () => {
  it('sftkDryRunAgainst takes piiPolicy, piiSalt and upsertField after ownerMapping', () => {
    expect(TRANSFER).toContain(
      'async function sftkDryRunAgainst(profileTree, srcSess, tgtSess, log, ownerMapping, piiPolicy, piiSalt, upsertField)');
  });

  it("runTransfer threads the profile's own policy + salt, and the External-ID only on Upsert runs", () => {
    const src = (() => {
      const i = TRANSFER.indexOf('\nasync function runTransfer() {');
      return TRANSFER.slice(i, TRANSFER.indexOf('\n}\n', i));
    })();
    expect(src).toContain('_transferProfile?.piiPolicy, _transferProfile?.piiSalt');
    expect(src).toContain("_transferWriteMode === 'upsert' ? (_transferUpsertField || null) : null");
  });

  it('dryRunFanOut threads the saved profile policy — and null for the External-ID (fan-out never upserts)', () => {
    const src = sourceOf('dryRunFanOut');
    expect(src).toMatch(/sftkDryRunAgainst\(tree, srcSess, tgtSess, line, p\.ownerMapping,\s*\r?\n\s*p\.piiPolicy, p\.piiSalt, null\)/);
  });
});

// ══════════════════════════════════════════════════════════════════
// 2. The write-nothing invariant survives the PII additions
// ══════════════════════════════════════════════════════════════════
describe('the dry run still writes nothing', () => {
  const typesIn = src => new Set([...src.matchAll(/type:\s*'([A-Z_0-9]+)'/g)].map(m => m[1]));

  it('sftkDryRunAgainst still sends ONLY SF_QUERY and SF_REST_GET', () => {
    expect([...typesIn(sourceOf('sftkDryRunAgainst'))].sort()).toEqual(['SF_QUERY', 'SF_REST_GET']);
  });

  it('the new PII helpers send no messages at all', () => {
    for (const name of ['sftkPiiPolicyCovers', 'sftkPiiRuleFor', 'sftkPiiDryPlan',
      'sftkPiiDryPlanLine', 'sftkPiiMaskSampleRows']) {
      const src = sourceOf(name);
      expect([...typesIn(src)], `${name} must send nothing`).toEqual([]);
      expect(src).not.toContain('sendBg');
      expect(src).not.toContain('chrome.storage');
    }
  });

  it('the honesty copy never uses the banned word — masked/pseudonymized only', () => {
    expect(TRANSFER).not.toMatch(/anonymi[sz]/i);
  });
});

// ══════════════════════════════════════════════════════════════════
// 3. The extracted validator against a stubbed org pair
// ══════════════════════════════════════════════════════════════════
const { sftkDryRunAgainst, sftkPiiPolicyCovers, sftkPiiRuleFor, sftkPiiDryPlan,
        sftkPiiDryPlanLine, sftkPiiMaskSampleRows } =
  extractFunctions('studio-transfer.js',
    ['sftkDryRunAgainst', 'sftkPiiPolicyCovers', 'sftkPiiRuleFor', 'sftkPiiDryPlan',
     'sftkPiiDryPlanLine', 'sftkPiiMaskSampleRows'],
    { 'studio-core.js': ['soqlStrLit'],
      'sftk-pii.js': ['sftkPiiHashHex', 'sftkPiiMaskable', 'sftkPiiFormat', 'sftkPiiMaskValue'] });

const SRC = { orgUrl: 'https://acme.my.salesforce.com', sid: 'SID_SRC' };
const TGT = { orgUrl: 'https://acme--seed.sandbox.my.salesforce.com', sid: 'SID_TGT' };
const SALT = 'ab12cd34ef56ab12cd34ef56ab12cd34';

const fld = (name, extra) => ({
  name, type: 'string', createable: true, nillable: true,
  defaultValue: null, length: 255, ...extra,
});

// Describe tables are keyed by object so source and target can differ per
// object — the masked-vs-raw tests hinge on exactly that difference.
function makeSendBg(opts = {}) {
  const sent = [];
  globalThis.sendBg = async msg => {
    sent.push(msg);
    if (msg.type === 'SF_REST_GET') {
      const isTgt = msg.orgUrl === TGT.orgUrl;
      const obj = /sobjects\/([^/]+)\/describe/.exec(msg.path || '')?.[1] || '?';
      const table = isTgt ? (opts.tgtDesc || {}) : (opts.srcDesc || {});
      return table[obj] || { name: obj, fields: [] };
    }
    const q = String(msg.query || '');
    if (/COUNT\(\)/.test(q)) return { totalSize: opts.count ?? 2, records: [] };
    if (/FROM ValidationRule|FROM ApexTrigger|FROM DuplicateRule/.test(q)) return { records: [] };
    if (/GROUP BY RecordType/.test(q)) return { error: 'no record types' };
    if (opts.onQuery) { const r = opts.onQuery(q, msg); if (r) return r; }
    return { records: opts.rows || [] };
  };
  return sent;
}

const noop = () => {};
afterEach(() => { delete globalThis.sendBg; });

describe('per-object masking disclosure', () => {
  it('logs "N field(s) masked before writing (M hashed, K set to null)" — a hash rule on a non-maskable type counts as nulled, never silently skipped', async () => {
    const lines = [];
    makeSendBg({
      srcDesc: { Account: { name: 'Account', fields: [
        fld('Id', { createable: false, type: 'id' }),
        fld('Name', { nillable: false }),
        fld('SSN__c', { length: 11 }),
        fld('Birth_Date__c', { type: 'date', length: 0 }),
      ] } },
      tgtDesc: { Account: { name: 'Account', fields: [
        fld('Id', { createable: false, type: 'id' }),
        fld('Name', { nillable: false }),
        fld('SSN__c', { length: 11 }),
        fld('Birth_Date__c', { type: 'date', length: 0 }),
      ] } },
      rows: [{ Id: '001', Name: 'Acme', SSN__c: '123-45-6789', Birth_Date__c: '1990-01-01' }],
    });
    const policy = {
      'Account.Name':         { strategy: 'hash' },
      'Account.SSN__c':       { strategy: 'hash' },
      'Account.Birth_Date__c': { strategy: 'hash' },   // date → nulled, disclosed
    };
    const r = await sftkDryRunAgainst({ objectType: 'Account' }, SRC, TGT,
      (i, m, c) => lines.push([i, m, c]), null, policy, SALT, null);
    expect(lines.some(([, m]) =>
      m === 'Account: 3 field(s) masked before writing (2 hashed, 1 set to null)')).toBe(true);
    expect(r).toEqual({ issues: 0, checked: 1, unchecked: 0 });
  });

  it('without a policy: no PII lines, identical result — the legacy path is untouched', async () => {
    const lines = [];
    makeSendBg({
      srcDesc: { Account: { name: 'Account', fields: [fld('Name', { nillable: false })] } },
      tgtDesc: { Account: { name: 'Account', fields: [fld('Name', { nillable: false })] } },
      rows: [{ Id: '001', Name: 'Acme' }],
    });
    const r = await sftkDryRunAgainst({ objectType: 'Account' }, SRC, TGT,
      (i, m) => lines.push(m), null);
    expect(r).toEqual({ issues: 0, checked: 1, unchecked: 0 });
    expect(lines.join('\n')).not.toMatch(/mask|PII/i);
  });
});

describe('masked-not-raw value checks', () => {
  // Source Industry is a plain string; the target made it a RESTRICTED
  // picklist. The raw sample value 'Banking' IS in the target's value set —
  // so a raw check passes while the real run writes a hash and dies.
  const picklistOpts = () => ({
    srcDesc: { Account: { name: 'Account', fields: [
      fld('Id', { createable: false, type: 'id' }),
      fld('Industry', { length: 40 }),
    ] } },
    tgtDesc: { Account: { name: 'Account', fields: [
      fld('Id', { createable: false, type: 'id' }),
      fld('Industry', { type: 'picklist', restrictedPicklist: true, length: 40,
        picklistValues: [{ value: 'Banking', active: true }] }),
    ] } },
    rows: [{ Id: '001', Industry: 'Banking' }],
  });

  it('CONTROL: without the policy the raw value passes the restricted picklist', async () => {
    makeSendBg(picklistOpts());
    const r = await sftkDryRunAgainst({ objectType: 'Account' }, SRC, TGT, noop, null);
    expect(r.issues).toBe(0);
  });

  it('a hash rule on that field is an issue naming the field — and the finding shows the masked value, never the raw one', async () => {
    const lines = [];
    makeSendBg(picklistOpts());
    const r = await sftkDryRunAgainst({ objectType: 'Account' }, SRC, TGT,
      (i, m, c) => lines.push([i, m, c]), null,
      { 'Account.Industry': { strategy: 'hash' } }, SALT, null);
    expect(r.issues).toBe(1);
    const bad = lines.find(([, m]) => /restricted picklist in the target/.test(m));
    expect(bad).toBeTruthy();
    expect(bad[1]).toMatch(/^Account\.Industry: restricted picklist in the target — this field is masked by the PII policy/);
    expect(bad[1]).toMatch(/INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST/);
    expect(bad[1]).not.toContain('Banking');   // the raw value never leaks into the log
    expect(bad[2]).toBe('ds-prog-err');
    expect(lines.some(([, m]) => m === 'Account: 1 field(s) masked before writing (1 hashed, 0 set to null)')).toBe(true);
  });

  const lengthOpts = () => ({
    srcDesc: { Account: { name: 'Account', fields: [fld('Nickname__c', { length: 255 })] } },
    tgtDesc: { Account: { name: 'Account', fields: [fld('Nickname__c', { length: 10 })] } },
    rows: [{ Id: '001', Nickname__c: 'Bob' }],
  });

  it('CONTROL: the 3-char raw value fits the 10-char target field', async () => {
    makeSendBg(lengthOpts());
    const r = await sftkDryRunAgainst({ objectType: 'Account' }, SRC, TGT, noop, null);
    expect(r.issues).toBe(0);
  });

  it('hashed, the value formats to the SOURCE length (255) and exceeds the target — STRING_TOO_LONG, with masked-aware advice', async () => {
    const lines = [];
    makeSendBg(lengthOpts());
    const r = await sftkDryRunAgainst({ objectType: 'Account' }, SRC, TGT,
      (i, m) => lines.push(m), null,
      { 'Account.Nickname__c': { strategy: 'hash' } }, SALT, null);
    expect(r.issues).toBe(1);
    const msg = lines.find(m => /STRING_TOO_LONG/.test(m));
    expect(msg).toMatch(/These are the MASKED values the PII policy writes/);
  });
});

describe('match-key warnings — ds-prog-warn, never issues', () => {
  const lookupOpts = (probe) => ({
    srcDesc: {
      Contact: { name: 'Contact', fields: [
        fld('Id', { createable: false, type: 'id' }),
        fld('LastName'),
        fld('AccountId', { type: 'reference' }),
      ] },
      Account: { name: 'Account', fields: [fld('Name')] },
    },
    tgtDesc: {
      Contact: { name: 'Contact', fields: [
        fld('Id', { createable: false, type: 'id' }),
        fld('LastName'),
        fld('AccountId', { type: 'reference' }),
      ] },
    },
    rows: [{ Id: '003x', LastName: 'Smith', AccountId: '001A' }],
    onQuery: q => {
      if (/FROM Account WHERE Id IN/.test(q)) return { records: [{ Id: '001A', Name: 'Acme Corp' }] };
      if (/FROM Account WHERE Name IN/.test(q)) return probe || { records: [{ Id: '001T' }] };
      return null;
    },
  });
  const tree = { objectType: 'Contact',
    lookupResolutions: { AccountId: { strategy: 'match', matchObject: 'Account', matchField: 'Name' } } };

  it('a hash-covered lookup anchor warns about salt-bound matching, probes masked-to-masked, and never sends the raw anchor to the target', async () => {
    const lines = [];
    const sent = makeSendBg(lookupOpts());
    const r = await sftkDryRunAgainst(tree, SRC, TGT,
      (i, m, c) => lines.push([i, m, c]), null,
      { 'Account.Name': { strategy: 'hash' } }, SALT, null);
    const warn = lines.find(([, m]) => /Contact\.AccountId: resolves by matching Account\.Name/.test(m));
    expect(warn).toBeTruthy();
    expect(warn[1]).toMatch(/only matches targets seeded with the same salt/);
    expect(warn[2]).toBe('ds-prog-warn');
    expect(r.issues).toBe(0);                                  // a warning, not an issue
    // The probe ran, against MASKED values only: no target-org query may
    // carry the raw anchor value.
    const tgtQueries = sent.filter(m => m.type === 'SF_QUERY' && m.orgUrl === TGT.orgUrl);
    expect(tgtQueries.some(m => /FROM Account WHERE Name IN/.test(m.query))).toBe(true);
    for (const m of tgtQueries) expect(m.query).not.toContain('Acme Corp');
  });

  it('a null-covered anchor warns that the engine skips the bridge — and the probe is skipped too', async () => {
    const lines = [];
    const sent = makeSendBg(lookupOpts());
    await sftkDryRunAgainst(tree, SRC, TGT, (i, m) => lines.push(m), null,
      { 'Account.Name': { strategy: 'null' } }, SALT, null);
    expect(lines.some(m => /"null" rule collapses every anchor/.test(m))).toBe(true);
    expect(sent.some(m => m.type === 'SF_QUERY' && /FROM Account WHERE Name IN/.test(String(m.query)))).toBe(false);
  });

  it('owner matching on a masked User field warns once, before the tree walk', async () => {
    const lines = [];
    makeSendBg({
      srcDesc: { Account: { name: 'Account', fields: [fld('Name')] } },
      tgtDesc: { Account: { name: 'Account', fields: [fld('Name')] } },
      rows: [{ Id: '001', Name: 'Acme' }],
    });
    const r = await sftkDryRunAgainst({ objectType: 'Account' }, SRC, TGT,
      (i, m, c) => lines.push([i, m, c]),
      { mode: 'match', matching: { fields: ['Name'] }, fallbackUserId: '005xx' },
      { 'User.Name': { strategy: 'hash' } }, SALT, null);
    const warn = lines.find(([, m]) => /^Owner matching uses User\.Name, which this policy masks/.test(m));
    expect(warn).toBeTruthy();
    expect(warn[2]).toBe('ds-prog-warn');
    expect(r.issues).toBe(0);
  });

  it('an Upsert whose External-ID is masked warns — every row would insert as new against an unmasked target', async () => {
    const lines = [];
    makeSendBg({
      srcDesc: { Account: { name: 'Account', fields: [fld('External_Key__c')] } },
      tgtDesc: { Account: { name: 'Account', fields: [fld('External_Key__c')] } },
      rows: [{ Id: '001', External_Key__c: 'K-1' }],
    });
    await sftkDryRunAgainst({ objectType: 'Account' }, SRC, TGT,
      (i, m) => lines.push(m), null,
      { 'Account.External_Key__c': { strategy: 'hash' } }, SALT, 'External_Key__c');
    expect(lines.some(m => /^Upsert matches on Account\.External_Key__c, which this policy masks/.test(m))).toBe(true);

    // …and stays silent on an insert run (upsertField null).
    const lines2 = [];
    makeSendBg({
      srcDesc: { Account: { name: 'Account', fields: [fld('External_Key__c')] } },
      tgtDesc: { Account: { name: 'Account', fields: [fld('External_Key__c')] } },
      rows: [{ Id: '001', External_Key__c: 'K-1' }],
    });
    await sftkDryRunAgainst({ objectType: 'Account' }, SRC, TGT,
      (i, m) => lines2.push(m), null,
      { 'Account.External_Key__c': { strategy: 'hash' } }, SALT, null);
    expect(lines2.some(m => /Upsert matches on/.test(m))).toBe(false);
  });
});

describe('missing salt — the engine\'s hard error, surfaced before any target work', () => {
  it('policy without salt: 1 issue, whole tree unchecked, ZERO org calls, and the exact engine message', async () => {
    const lines = [];
    const sent = makeSendBg();
    const tree = { objectType: 'Account', children: [
      { childSObject: 'Contact', field: 'AccountId', children: [{ childSObject: 'Task', field: 'WhoId' }] },
    ] };
    const r = await sftkDryRunAgainst(tree, SRC, TGT,
      (i, m, c) => lines.push([i, m, c]), null,
      { 'Account.Name': { strategy: 'hash' } }, null, null);
    expect(r).toEqual({ issues: 1, checked: 0, unchecked: 3 });
    expect(sent.length).toBe(0);   // BEFORE any target work — nothing was sent anywhere
    expect(lines[0][1]).toBe('PII policy has no salt — open the deployment in the builder once');
    expect(lines[0][2]).toBe('ds-prog-err');
  });

  it('the message is byte-identical to the engine\'s throw in background.js', () => {
    const bg = readFileSync(join(root, 'background.js'), 'utf8');
    expect(bg).toContain('PII policy has no salt — open the deployment in the builder once');
    expect(sourceOf('sftkDryRunAgainst')).toContain('PII policy has no salt — open the deployment in the builder once');
  });
});

// ══════════════════════════════════════════════════════════════════
// 4. The pure helpers mirror the engine's rule resolution
// ══════════════════════════════════════════════════════════════════
describe('sftkPiiDryPlan / sftkPiiDryPlanLine', () => {
  const fields = [
    fld('Name'),
    fld('Email__c', { type: 'email', length: 80 }),
    fld('Birthdate', { type: 'date', length: 0 }),
    fld('OwnerId', { type: 'reference' }),
    fld('Status__c', { type: 'picklist' }),
  ];

  it('classifies per the library: hash+maskable → hashed, hash on date/picklist → nulled, fixed → fixed', () => {
    const plan = sftkPiiDryPlan({
      'Account.Name':       { strategy: 'hash' },
      'Account.Email__c':   { strategy: 'hash' },
      'Account.Birthdate':  { strategy: 'hash' },     // date → nulled
      'Account.Status__c':  { strategy: 'fixed', value: 'Seeded' },
    }, 'Account', fields);
    expect(plan.counts).toEqual({ hashed: 2, nulled: 1, fixed: 1 });
    expect(plan.total).toBe(4);
    expect(plan.fields.Name.action).toBe('hashed');
    expect(plan.fields.Birthdate.action).toBe('nulled');
    expect(plan.fields.Status__c.action).toBe('fixed');
  });

  it('matches API names case-insensitively, like the engine', () => {
    const plan = sftkPiiDryPlan({ 'ACCOUNT.name': { strategy: 'hash' } }, 'Account', fields);
    expect(plan.fields.Name.action).toBe('hashed');
  });

  it('excludes engine-resolved fields and fields absent from the describe — their rules cannot change what lands', () => {
    expect(sftkPiiDryPlan({ 'Account.OwnerId': { strategy: 'null' } }, 'Account', fields)).toBe(null);
    expect(sftkPiiDryPlan({ 'Account.Ghost__c': { strategy: 'hash' } }, 'Account', fields)).toBe(null);
  });

  it('returns null for an uncovered object, and the covers-gate agrees', () => {
    const policy = { 'Contact.Email': { strategy: 'hash' } };
    expect(sftkPiiDryPlan(policy, 'Account', fields)).toBe(null);
    expect(sftkPiiPolicyCovers(policy, 'Account')).toBe(false);
    expect(sftkPiiPolicyCovers(policy, 'Contact')).toBe(true);
    expect(sftkPiiRuleFor(policy, 'contact', 'EMAIL')).toEqual({ strategy: 'hash' });
  });

  it('the disclosure line reads exactly as specified — "fixed" appears only when present', () => {
    expect(sftkPiiDryPlanLine('Account', { counts: { hashed: 2, nulled: 1, fixed: 0 }, total: 3 }))
      .toBe('Account: 3 field(s) masked before writing (2 hashed, 1 set to null)');
    expect(sftkPiiDryPlanLine('Account', { counts: { hashed: 1, nulled: 0, fixed: 2 }, total: 3 }))
      .toBe('Account: 3 field(s) masked before writing (1 hashed, 0 set to null, 2 fixed)');
  });
});

describe('sftkPiiMaskSampleRows', () => {
  const plan = {
    fields: {
      Email__c: { rule: { strategy: 'hash' }, desc: fld('Email__c', { type: 'email', length: 80 }) },
    },
  };

  it('is deterministic (same salt, same value → same masked row) and lands on masked.invalid', async () => {
    const rows = [{ Id: '1', Email__c: 'jane@real.com', Name: 'Jane' }];
    const [a] = await sftkPiiMaskSampleRows(rows, plan, SALT);
    const [b] = await sftkPiiMaskSampleRows(rows, plan, SALT);
    expect(a.Email__c).toBe(b.Email__c);
    expect(a.Email__c).toMatch(/@masked\.invalid$/);
    expect(a.Name).toBe('Jane');           // uncovered fields untouched
    expect(a.Id).toBe('1');
  });

  it('passes empty values through untouched — the library\'s kept branch', async () => {
    const [r] = await sftkPiiMaskSampleRows([{ Email__c: '' }], plan, SALT);
    expect(r.Email__c).toBe('');
  });
});

// ══════════════════════════════════════════════════════════════════
// 5. The fan-out dialog's PII row — sourced from what actually runs
// ══════════════════════════════════════════════════════════════════
describe('openFanOut PII row', () => {
  const openFanOutSrc = (() => {
    const i = TRANSFER.indexOf('window.openFanOut = async function');
    if (i < 0) throw new Error('openFanOut not found');
    return TRANSFER.slice(i, TRANSFER.indexOf('\n};', i) + 3);
  })();

  it('the "What this will do" grid has a PII row with the two spec\'d labels', () => {
    expect(openFanOutSrc).toContain('<span>PII</span>');
    expect(openFanOutSrc).toContain('field(s) masked before writing');
    expect(openFanOutSrc).toContain("'no masking configured'");
  });

  it("SOURCE PIN: the row reads p.piiPolicy — the saved profile's policy, not the Transfer tab's state", () => {
    expect(openFanOutSrc).toContain('p.piiPolicy');
    expect(openFanOutSrc).not.toContain('_transferProfile?.piiPolicy');
  });

  it('VERIFIED, NOT ASSUMED: runFanOut sends the profile as saved ({...p} spread), so the policy rides every leg', () => {
    expect(sourceOf('runFanOut')).toContain(
      "profile: (typeof treeForTarget === 'function' && p.tree) ? { ...p, tree: treeForTarget(p.tree, tgtUrl) } : p");
  });

  it('a policy without its salt is disclosed in the row — the engine hard-fails every leg on it', () => {
    expect(openFanOutSrc).toContain('no salt yet');
    expect(openFanOutSrc).toContain('p.piiSalt');
  });
});

// ══════════════════════════════════════════════════════════════════
// Adversarial-review fixes (2026-08-04): the reconcile write paths
// honor the policy — reconcileOverwrite was THE confirmed leak (raw
// SF_COLLECTIONS_UPDATE bypassing the engine).
// ══════════════════════════════════════════════════════════════════
describe('reconcile surfaces are fail-closed on PII', () => {
  const RECONCILE = readFileSync(join(root, 'studio-reconcile.js'), 'utf8');

  it('reconcileOverwrite masks through the shared library with the salt hard-error in front', () => {
    const i = RECONCILE.indexOf('async function reconcileOverwrite(');
    const src = RECONCILE.slice(i, RECONCILE.indexOf('\n}', i));
    expect(src).toContain("throw new Error('PII policy has no salt — open the deployment in the builder once')");
    expect(src).toMatch(/await sftkPiiMaskValue\(v, descByLower\[sf\.toLowerCase\(\)\]/);
    // an UPDATE writes the null explicitly — leaving the field unchanged
    // would preserve raw PII a pre-policy seed planted in the target
    expect(src).toMatch(/p\[tf\] = m\.value == null \? null : m\.value/);
    // History labels never carry a raw name for a covered record
    expect(src).toContain('piiNameCovered ? tgtId :');
  });

  it('relink skips objects whose parent match key is policy-covered instead of leaking anchors into target SOQL', () => {
    expect(RECONCILE).toContain('piiCoveredAnchor');
    expect(RECONCILE).toMatch(/skipped so raw values never reach the target org/);
  });

  it('the dry-run plan separates unwritable covered fields and the caller warns (compound-Name trap)', () => {
    const TRANSFER2 = readFileSync(join(root, 'studio-transfer.js'), 'utf8');
    expect(TRANSFER2).toMatch(/desc\.createable === false\) \{ unwritable\.push\(desc\.name\); continue; \}/);
    expect(TRANSFER2).toContain('which the payload never sends (not createable in the source)');
  });
});
