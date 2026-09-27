// ORG SEEDER — reset & seed whole targets from the source of truth
// (user 2026-08-19: "compare and deploy the whole source org data to
// targets… delete the targets data on objects you select… from one source
// to multiple targets"). Pins: dependency ordering, the wipe engine's
// counting + cancel + hard-delete routing, and the view's safety rails.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const SEED = readFileSync(new URL('../studio-seed.js', import.meta.url), 'utf8');
const BG   = readFileSync(new URL('../background.js', import.meta.url), 'utf8');

// ── The seed's PII layer (user 2026-08-20: whole-org seeds of objects with
// no saved deployment used to go out RAW and silent) ────────────────────
describe('seed-level PII policy', () => {
  const { sftkSeedPiiForObject, sftkSeedSampleFields } =
    extractFunctions('studio-seed.js', ['sftkSeedPiiForObject', 'sftkSeedSampleFields']);

  it('resolves an object\'s rules case-insensitively, and only its own', () => {
    globalThis._seedPii = { salt: 'abc', policy: {
      'Contact.Email': { strategy: 'pattern', pattern: 'email' },
      'contact.SSN__c': { strategy: 'pattern', pattern: 'il-id' },
      'Lead.Email': { strategy: 'hash' },
    } };
    const out = sftkSeedPiiForObject('Contact');
    expect(Object.keys(out).sort()).toEqual(['Contact.Email', 'contact.SSN__c']);
    expect(sftkSeedPiiForObject('Account')).toEqual({});
    delete globalThis._seedPii;
  });

  it('samples text AND number createable fields — both can hold identifiers', () => {
    const desc = { fields: [
      { name: 'Name', type: 'string', createable: true },
      { name: 'Email', type: 'email', createable: true },
      { name: 'Phone', type: 'phone', createable: true },
      { name: 'Bio__c', type: 'textarea', createable: true },
      { name: 'Site', type: 'url', createable: true },
      { name: 'Amount__c', type: 'currency', createable: true },
      { name: 'Born__c', type: 'date', createable: true },
      { name: 'Id', type: 'id', createable: false },
      { name: 'Formula__c', type: 'string', createable: false },
    ] };
    // Numbers included: an ID or a salary stored as a Number is just as
    // sensitive as one stored as Text (user 2026-08-21).
    expect(sftkSeedSampleFields(desc).map(f => f.name))
      .toEqual(['Name', 'Email', 'Phone', 'Bio__c', 'Site', 'Amount__c']);
  });

  it('the scan quotes its cost and ticks per object (No Silent Waits)', () => {
    expect(SEED).toMatch(/const calls = objs\.length \* 2/);
    expect(SEED).toContain('API call(s), roughly');
    expect(SEED).toContain('scanning ${o} —');
    expect(SEED).toContain('⏹ Stop scan');
    // and it reads VALUES, not just names
    expect(SEED).toMatch(/sftkPiiSuggest\(o, _seedDesc\[o\]\.fields \|\| \[\], compliance, samples\)/);
    expect(SEED).toMatch(/LIMIT 50/);
  });

  it('one salt covers the whole seed, minted the moment a rule exists', () => {
    expect(SEED).toMatch(/if \(!_seedPii\.salt && Object\.keys\(_seedPii\.policy\)\.length\)/);
    expect(SEED).toContain('crypto.getRandomValues(new Uint8Array(16))');
    expect(SEED).toMatch(/piiSalt: _seedPii\.salt \|\| saved\?\.piiSalt/);
    // seed rules merge OVER a saved deployment's own policy
    expect(SEED).toMatch(/\.\.\.\(saved\?\.piiPolicy \|\| \{\}\), \.\.\.sftkSeedPiiForObject\(obj\)/);
  });

  it('raw contactable fields are gated before any write, with a one-click fix', () => {
    expect(SEED).toContain('Contactable data will be copied RAW');
    expect(SEED).toMatch(/f\.type !== 'email' && f\.type !== 'phone'/);
    expect(SEED).toContain('dsSeedRawMask');
    expect(SEED).toContain('Continue with raw values');
    // unscanned objects are UNKNOWN, never assumed clean
    expect(SEED).toContain('their fields are <strong>UNKNOWN</strong>, not clean');
    // both write paths pass through the gate
    expect((SEED.match(/await sftkSeedRawPiiGate\(objs\)/g) || []).length).toBe(2);
  });

  it('the table states masked / suggested / not-scanned distinctly', () => {
    // the chips are the way IN to the suggestions, so they are buttons
    expect(SEED).toContain('masked</button>');
    expect(SEED).toContain('suggested</button>');
    expect(SEED).toContain('not scanned');
    expect(SEED).toContain('scan failed — UNKNOWN');
  });

  it('the load sweep quotes, ticks, fills live and can be stopped', () => {
    expect(SEED).toMatch(/if \(_seedLoading\) \{ _seedLoadCancel = true; return; \}/);
    expect(SEED).toContain("btn.textContent = '⏹ Stop'");
    expect(SEED).toMatch(/const planned = names\.length \* \(1 \+ targets\.length\)/);
    expect(SEED).toContain('read-only COUNT() calls, roughly');
    expect(SEED).toContain('counting ${row.name}');
    // the table renders BEFORE the counts land, then each cell is patched
    expect(SEED).toMatch(/srcCount: undefined, tgtCounts: \{\}/);
    expect(SEED).toContain('data-seed-cell=');
    expect(SEED).toMatch(/const paint = \(obj, key, v, why\)/);
    // A '?' carries Salesforce's OWN reason, so it is actionable rather
    // than a dead end (user 2026-08-22: "i have some with question mark").
    expect(SEED).toContain('function sftkSeedCountWhy');
    expect(SEED).toContain('does not exist in this org');
    expect(SEED).toContain('lacks read access in this org');
    expect(SEED).toMatch(/row\.srcWhy = sc\.why/);
    // pending and failed read differently — neither is ever 0
    expect(SEED).toContain('not counted yet');
    expect(SEED).toContain('treated as UNKNOWN');
    expect(SEED).toContain('the rest stay UNKNOWN');
  });

  it('runs show a real progress bar and refresh the counts they invalidated', () => {
    // A finished wipe LOOKED like it did nothing: no progress, and the table
    // still showed pre-run counts (user 2026-08-20).
    expect(SEED).toContain('dsSeedBarFill');
    expect(SEED).toMatch(/const totalSteps = Math\.max\(1, targets\.length \* order\.length \* perObject\)/);
    expect(SEED).toMatch(/const bar = \(label\)/);
    expect(SEED).toContain("bar(`${orgLabel(t)} · wiping ${o}`)");
    expect(SEED).toContain("bar(`${orgLabel(t)} · seeding ${o}`)");
    expect(SEED).toContain("bar(`${orgLabel(t)} · verifying`)");
    // post-run recount patches the very cells the run invalidated
    expect(SEED).toMatch(/row\.tgtCounts\[t\] = now;/);
    expect(SEED).toContain('done · counts above refreshed');
  });

  it('seeding without deleting warns before duplicating, and proves it after', () => {
    // "Seed targets" leaves target data alone — but only an object with a
    // match key can UPDATE instead of insert (user 2026-08-21).
    expect(SEED).toContain('(no delete)');
    expect(SEED).toMatch(/function sftkSeedMatchKeyFor\(obj, tgtUrl\)/);
    // pre-flight gate: no key + non-empty target = duplicates
    expect(SEED).toMatch(/if \(what\.seed && !what\.wipe\)/);
    expect(SEED).toContain('These objects would DUPLICATE');
    expect(SEED).toContain('cancelled before anything was written');
    // the target's OWN aggregate is the source of truth for dupes
    expect(SEED).toMatch(/GROUP BY \$\{keyField\} HAVING COUNT\(Id\) > 1/);
    expect(SEED).toContain('sftkSeedDupeReport');
    // and the verdict is stated in every case, including none and unknown
    expect(SEED).toContain('No duplicate key values in any target');
    expect(SEED).toContain('duplicate state is UNKNOWN, not clean');
    expect(SEED).toContain('no match key — duplicates cannot be identified');
  });

  it('an object missing in a target is a SKIP, and undeletable rows are explained', () => {
    expect(SEED).toMatch(/const notPresent = e =>/);
    expect(SEED).toContain('not present in this org — nothing to wipe');
    expect(SEED).toContain('cannot be deleted by any tool');
  });

  it('suggestions are reachable from the row chip, per object', () => {
    expect(SEED).toContain('data-seed-pii-open=');
    expect(SEED).toMatch(/function sftkSeedPiiModal\(onlyObj\)/);
    expect(SEED).toMatch(/onlyObj \? r\.name === onlyObj : \(_seedSel\.has\(r\.name\) && \(r\.pii \|\| \[\]\)\.length\)/);
    // an object with NO findings still opens, so a field can be added by hand
    expect(SEED).toMatch(/function sftkSeedMaskableFields\(obj\)/);
    expect(SEED).toContain('＋ Add a field by hand');
    expect(SEED).toContain('only suggested on person-shaped objects');
  });

  it('every suggestion previews REAL before → after, from the org itself', () => {
    // A strategy name means nothing without a value the user recognizes.
    expect(SEED).toMatch(/async function sftkSeedPiiPreview\(obj, field, strat\)/);
    expect(SEED).toMatch(/sftkPiiMaskValue\(src, desc, await sftkSeedEnsureSalt\(\), rule\)/);
    expect(SEED).toContain('data-seed-pii-prev=');
    expect(SEED).toContain('sg.sample = String(v)');
    // previews follow the dropdown
    expect(SEED).toMatch(/sel\.addEventListener\('change', \(\) => paintPrev\(sel\.dataset\.seedPiiStrat\)\)/);
    // and the header teaches with a concrete ת״ז example
    expect(SEED).toContain('039128053');
    expect(SEED).toContain('284617035');
  });

  it('⚖ opens Reconcile for ONE object against ONE target, even with no saved deployment', () => {
    expect(SEED).toMatch(/async function sftkSeedOpenReconcile\(obj, tgtUrl\)/);
    expect(SEED).toContain('data-seed-rec=');
    expect(SEED).toMatch(/const base = sftkSeedProfileFor\(obj, srcUrl, tgtUrl, \[\.\.\._seedSel\]\)/);
    // COMPARING always includes attached files, even when the seed-time
    // file toggle is off: a comparison that omits attachments reports
    // "in sync" for records whose files are missing (user 2026-08-22:
    // "don't see the files in the comparison").
    expect(SEED).toMatch(/tree: \{ \.\.\.base\.tree, includeFiles: true \}/);
    expect(SEED).toMatch(/id: `seedpair_\$\{Date\.now\(\)\}_\$\{obj\}`/);
    expect(SEED).toContain('_reconcileProfile = pair;');
    expect(SEED).toMatch(/saved \? \{ _ringOf: \{ profileId: saved\.id \} \} : \{\}/);
    // never against the source itself
    expect(SEED).toContain('nothing to reconcile against itself');
  });

  it('the modal never claims more than pseudonymization, and shows caveats', () => {
    expect(SEED).toContain('pseudonymization, not anonymization');
    expect(SEED).toContain('masked, never anonymized');
    // never the stronger claim as a CAPABILITY — only ever as a disclaimer
    expect(SEED).not.toMatch(/\banonymi[sz]es\b|fully anonymi[sz]ed/i);
    expect(SEED).toContain("What each pattern guarantees — and what it doesn't");
  });
});

describe('sftkSeedOrder — parents first, wipes reversed, cycles named', () => {
  const { sftkSeedOrder } = extractFunctions('studio-seed.js', ['sftkSeedOrder']);

  it('orders referenced objects before their children', () => {
    const r = sftkSeedOrder(['Child__c', 'Parent__c', 'Grand__c'],
      { Child__c: ['Parent__c'], Grand__c: ['Child__c'], Parent__c: [] });
    expect(r.order).toEqual(['Parent__c', 'Child__c', 'Grand__c']);
    expect(r.cycle).toEqual([]);
  });

  it('ignores references OUTSIDE the selection and self-references', () => {
    const r = sftkSeedOrder(['A__c', 'B__c'], { A__c: ['Account', 'A__c'], B__c: ['A__c'] });
    expect(r.order).toEqual(['A__c', 'B__c']);
  });

  it('a cycle keeps input order and is NAMED, never silently dropped', () => {
    const r = sftkSeedOrder(['X__c', 'Y__c', 'Z__c'],
      { X__c: ['Y__c'], Y__c: ['X__c'], Z__c: [] });
    expect(r.order).toEqual(['Z__c', 'X__c', 'Y__c']);
    expect(r.cycle).toEqual(['X__c', 'Y__c']);
  });
});

describe('sftkWipeObject — the delete engine', () => {
  const { sftkWipeObject } = extractFunctions('background.js', ['sftkWipeObject']);
  // The hard stub mirrors sfHardDelete's REAL return shape
  // { deleteResults, purgedOk, purgeErrors } — the first version of this
  // suite stubbed a phantom { ok, errors } matching the implementation's own
  // wrong assumption, so a total-failure-reporting bug passed the gate.
  // Stubs must copy the real contract, never the code under test.
  const install = (over = {}) => {
    globalThis._runCancelled = false;
    globalThis.postRunProgress = over.progress || (() => {});
    globalThis.sfQueryAll = async () => ({ records: Array.from({ length: over.n ?? 5 }, (_, i) => ({ Id: `D${i}` })) });
    globalThis.sfCollectionsDelete = over.del || (async (o, s, ids) => ids.map(() => ({ success: true })));
    globalThis.sfHardDelete = over.hard || (async (o, s, ids) => ({
      deleteResults: ids.map(id => ({ id, success: true, errors: [] })),
      purgedOk: ids.length, purgeErrors: [],
    }));
  };
  afterEach(() => {
    for (const k of ['_runCancelled', 'postRunProgress', 'sfQueryAll', 'sfCollectionsDelete', 'sfHardDelete'])
      delete globalThis[k];
  });

  it('recycle mode: collections delete, per-row counting, failures named', async () => {
    install({ n: 3, del: async (o, s, ids) => ids.map((id, i) =>
      i === 1 ? { success: false, errors: [{ message: 'ENTITY_IS_LOCKED' }] } : { success: true }) });
    const r = await sftkWipeObject('https://t.my.salesforce.com', 'sid', 'Load_Child__c', 'recycle');
    expect(r).toMatchObject({ deleted: 2, failed: 1, total: 3 });
    expect(r.errors.join('\n')).toContain('ENTITY_IS_LOCKED');
  });

  it('hard mode routes through sfHardDelete and counts the REAL result shape', async () => {
    let hardCalls = 0;
    install({ n: 4, hard: async (o, s, ids) => { hardCalls++; return {
      deleteResults: ids.map(id => ({ id, success: true, errors: [] })),
      purgedOk: ids.length, purgeErrors: [] }; } });
    const r = await sftkWipeObject('https://t.my.salesforce.com', 'sid', 'X__c', 'hard');
    expect(hardCalls).toBe(1);
    expect(r.deleted).toBe(4);
    expect(r.failed).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it('hard mode: per-row delete failures counted; purge shortfall disclosed as still-recoverable', async () => {
    install({ n: 3, hard: async (o, s, ids) => ({
      deleteResults: ids.map((id, i) => i === 0
        ? { id, success: false, errors: [{ message: 'DELETE_FAILED: in approval' }] }
        : { id, success: true, errors: [] }),
      purgedOk: 1, purgeErrors: ['insufficient access to purge'] }) });
    const r = await sftkWipeObject('https://t.my.salesforce.com', 'sid', 'X__c', 'hard');
    expect(r.deleted).toBe(2);
    expect(r.failed).toBe(1);
    const txt = r.errors.join('\n');
    expect(txt).toContain('DELETE_FAILED: in approval');
    expect(txt).toContain('could not be purged');
    expect(txt).toContain('remain in the Recycle Bin');
  });

  it('cancel between chunks stops honestly — partial count, explicit line', async () => {
    let calls = 0;
    install({ n: 450, del: async (o, s, ids) => { calls++; globalThis._runCancelled = true; return ids.map(() => ({ success: true })); } });
    const r = await sftkWipeObject('https://t.my.salesforce.com', 'sid', 'X__c', 'recycle');
    expect(calls).toBe(1);
    expect(r.deleted).toBe(200);
    expect(r.errors.join('\n')).toContain('cancelled after 200 of 450');
  });

  it('streams progress and error lines like any run', async () => {
    const evts = [];
    install({ n: 3, progress: e => evts.push(e.phase),
      del: async (o, s, ids) => ids.map(() => ({ success: false, errors: [{ message: 'nope' }] })) });
    await sftkWipeObject('https://t.my.salesforce.com', 'sid', 'X__c', 'recycle');
    expect(evts).toContain('fetched');
    expect(evts).toContain('batch');
    expect(evts).toContain('errs');
  });
});

describe('the view keeps the safety rails', () => {
  it('wipes demand the typed RESET confirmation with per-target counts', () => {
    // Campaign 3 phase 2: the typed word moved onto the shared confirm
    // dialog's own typedWord mechanism (sftk-confirm.js).
    expect(SEED).toMatch(/typedWord: 'RESET'/);
    expect(SEED).toContain('this DELETES data');
    expect(SEED).toContain('Master-detail children of deleted records cascade-delete too.');
  });

  it('the source of truth can never be a target', () => {
    expect(SEED).toMatch(/targets\.some\(t => _orgKey\(t\) === _orgKey\(currentSourceOrg\(\)\)\)/);
    expect(SEED).toContain('The source of truth can never be a target.');
  });

  it('wipes run children-first, seeds parents-first, cycles disclosed', () => {
    expect(SEED).toContain('[...order].reverse()');
    expect(SEED).toContain('Reference cycle between');
  });

  it('seeds inherit saved deployment config and bridge selected-object lookups', () => {
    expect(SEED).toMatch(/p\.tree\?\.objectType === obj/);
    // the saved profile's policy still rides — now merged under the seed's
    // own rules and one shared salt (see the seed-level PII suite)
    expect(SEED).toMatch(/\.\.\.\(saved\?\.piiPolicy \|\| \{\}\), \.\.\.sftkSeedPiiForObject\(obj\)/);
    expect(SEED).toMatch(/strategy: 'match', matchObject: ref, matchField: matchFieldOf\(ref\)/);
  });

  it('recycle is the default delete mode; counts honesty is stated', () => {
    expect(SEED).toContain("let _seedDelMode = 'recycle'");
    expect(SEED).toContain("Counts are live totals — equal counts don't prove equal DATA");
  });

  it('the wipe dispatcher begins a cancellable run and ALWAYS ends it', () => {
    expect(BG).toContain("case 'SFTK_WIPE_OBJECT': {");
    const i = BG.indexOf("case 'SFTK_WIPE_OBJECT': {");
    const block = BG.slice(i, i + 2200);
    expect(block).toContain("_beginRun('wipe')");
    expect(block).toMatch(/finally \{[\s\S]{0,400}_endRun\(\);/);
  });
});

// ── Seeder review wt02z57at — the two confirmed HIGHs stay fixed ─────────
describe('production and unknown-count rails on the destructive path', () => {
  it('the ENGINE refuses hard delete against production — belt below every view', () => {
    const i = BG.indexOf("case 'SFTK_WIPE_OBJECT': {");
    const block = BG.slice(i, i + 1400);
    expect(block).toContain("SELECT IsSandbox, TrialExpirationDate FROM Organization");
    expect(block).toContain('Hard delete is disabled against PRODUCTION orgs');
    expect(block).toMatch(/rec\.IsSandbox === false && !rec\.TrialExpirationDate/);
  });

  it('the view resolves org types and gates prod: hard refused, writes typed-confirmed', () => {
    expect(SEED).toMatch(/orgTypes\[t\] = await ensureOrgType\(t\)/);
    expect(SEED).toContain("_seedDelMode === 'hard' && prodTargets.length");
    expect(SEED).toContain('🔥 Hard delete is disabled against PRODUCTION orgs');
    // Campaign 3 phase 2: the per-org confirmTypedProd() loop became one
    // combined sftkConfirmDestructive production step (still gated by the
    // same prodTargets list, computed from ensureOrgType above).
    expect(SEED).toMatch(/production: \{ label: await prodLabelFor\(\) \}/);
    expect(SEED).toMatch(/sftkConfirmDestructive\(/);
    // The seed-only path gates raw PII, then the Custom Setting REPLACE
    // (it deletes the target's rows), then confirms prod targets. Order
    // matters: every gate must run before the first write, and prod is the
    // last thing standing between the user and it.
    expect(SEED).toMatch(/if \(!what\.wipe\) \{\s*\n\s*if \(what\.seed && !\(await sftkSeedRawPiiGate\(objs\)\)\) return;/);
    expect(SEED).toMatch(/if \(what\.config && !\(await sftkSeedCfgReplaceGate\(\)\)\) return;\s*\n\s*if \(prodTargets\.length\) \{/);
  });

  it('unknown counts stay UNKNOWN in the RESET dialog — never coerced to 0', () => {
    expect(SEED).not.toContain('tgtCounts?.[t] || 0');
    expect(SEED).toMatch(/if \(v == null\) unknown\+\+; else total \+= v;/);
    expect(SEED).toContain('UNKNOWN count — ALL of their rows will be deleted');
  });

  it('a target ticked after Load (no counts) can never reach the confirm', () => {
    expect(SEED).toContain('_seedLoadedTargets = new Set(targets);');
    expect(SEED).toMatch(/targets\.filter\(t => !_seedLoadedTargets\.has\(t\)\)/);
    expect(SEED).toContain('Counts were never loaded for');
  });
});

describe('run-loop honesty from the unverified review candidates', () => {
  it('✋ Cancel exists, posts the engine cancel, and gates every loop level', () => {
    expect(SEED).toContain('id="dsSeedCancel"');
    expect(SEED).toContain("_seedPort?.postMessage({ cmd: 'cancel' })");
    expect((SEED.match(/if \(_seedCancelled\)/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('a seed leg whose node died wholesale never prints ✅', () => {
    expect(SEED).toMatch(/const dead = result\.status && result\.status !== 'success';/);
    expect(SEED).toContain("run ${result.status}, see History");
  });

  it('Name bridges disclose the mis-link risk before writing', () => {
    expect(SEED).toContain('by Name — duplicate names can mis-link');
  });

  it('self-referencing lookups: idempotent reconnect pass with upsert, honest refusal without', () => {
    expect(SEED).toContain('running the reconnect pass (idempotent upsert)');
    expect(SEED).toContain('a second pass would duplicate rows');
    expect(SEED).toMatch(/selfBridge && !_seedCancelled/);
    expect(SEED).toMatch(/prof\.tree\.upsert\?\.field/);
  });
});

// ── Which key identifies a record? (user 2026-08-22: "in case we choose to
// seed without reseting, how do we know which key is selected for every
// object?") The key used to be derived silently inside the profile
// builder; nothing on screen said which field a run would match on. ────
describe('the match key is visible, choosable, and matches what runs', () => {
  const { sftkSeedKeyInfo, sftkSeedExtIdFields } =
    extractFunctions('studio-seed.js', ['sftkSeedKeyInfo', 'sftkSeedExtIdFields']);

  const setup = (desc, keys = {}, profiles = []) => {
    globalThis._seedDesc = desc;
    globalThis._seedKeys = keys;
    globalThis._profiles = profiles;
  };
  afterEach(() => {
    delete globalThis._seedDesc; delete globalThis._seedKeys; delete globalThis._profiles;
  });

  it('only counts External IDs that can actually be written', () => {
    setup({ Acc: { fields: [
      { name: 'Ext__c', externalId: true, createable: true },
      { name: 'Locked__c', externalId: true, createable: false },
      { name: 'Plain__c', externalId: false, createable: true },
    ] } });
    expect(sftkSeedExtIdFields('Acc')).toEqual(['Ext__c']);
  });

  it('reports UNKNOWN — never "no key" — for an object it has not read', () => {
    // Claiming "this object has no External ID" without having looked is
    // exactly the lie the whole project forbids.
    setup({});
    const info = sftkSeedKeyInfo('Acc');
    expect(info.unknown).toBe(true);
    expect(info.field).toBe(null);
    expect(info.source).toBe('not read yet');
  });

  it('auto-picks a sole External ID and calls it merge-safe', () => {
    setup({ Acc: { fields: [{ name: 'Ext__c', externalId: true, createable: true }] } });
    const info = sftkSeedKeyInfo('Acc');
    expect(info.field).toBe('Ext__c');
    expect(info.merge).toBe(true);
  });

  it('refuses to guess between several External IDs', () => {
    setup({ Acc: { fields: [
      { name: 'A__c', externalId: true, createable: true },
      { name: 'B__c', externalId: true, createable: true },
    ] } });
    const info = sftkSeedKeyInfo('Acc');
    expect(info.field).toBe(null);
    expect(info.candidates).toEqual(['A__c', 'B__c']);
    expect(info.source).toMatch(/pick one/);
  });

  it('says plainly when the object simply has no External ID', () => {
    setup({ Acc: { fields: [{ name: 'Name', externalId: false, createable: true }] } });
    const info = sftkSeedKeyInfo('Acc');
    expect(info.field).toBe(null);
    expect(info.merge).toBe(false);
    expect(info.source).toMatch(/no External ID/);
  });

  it('a saved deployment\u2019s key wins over the object\u2019s own guess, and is attributed', () => {
    setup(
      { Acc: { fields: [{ name: 'Ext__c', externalId: true, createable: true }] } },
      {},
      [{ name: 'Nightly', tree: { objectType: 'Acc', upsert: { field: 'Legacy__c' } } }],
    );
    const info = sftkSeedKeyInfo('Acc');
    expect(info.field).toBe('Legacy__c');
    expect(info.source).toContain('Nightly');
  });

  it('the user\u2019s explicit pick outranks everything, including a deployment', () => {
    setup(
      { Acc: { fields: [
        { name: 'Ext__c', externalId: true, createable: true },
        { name: 'Other__c', externalId: true, createable: true },
      ] } },
      { Acc: 'Other__c' },
      [{ name: 'Nightly', tree: { objectType: 'Acc', upsert: { field: 'Legacy__c' } } }],
    );
    const info = sftkSeedKeyInfo('Acc');
    expect(info.field).toBe('Other__c');
    expect(info.chosen).toBe(true);
    expect(info.merge).toBe(true);
  });

  it('honours a deliberate "no key" — insert-only is a valid choice', () => {
    setup({ Acc: { fields: [{ name: 'Ext__c', externalId: true, createable: true }] } },
      { Acc: '__none__' });
    const info = sftkSeedKeyInfo('Acc');
    expect(info.field).toBe(null);
    expect(info.merge).toBe(false);
    expect(info.source).toMatch(/you chose/);
  });

  it('the profile builder applies the SAME precedence the column shows', () => {
    // The column and the run must never disagree — that is the whole point
    // of showing it.
    const prof = SEED.slice(SEED.indexOf('function sftkSeedProfileFor'));
    expect(prof).toContain('const ov = _seedKeys[obj];');
    expect(prof).toMatch(/const auto = overridden\s*\n\s*\? \(ov !== '__none__' && extIds\.some\(f => f\.name === ov\) \? ov : null\)/);
    expect(prof).toMatch(/saved\?\.tree\?\.upsert\?\.field \|\| \(extIds\.length === 1 \? extIds\[0\]\.name : null\)/);
  });

  it('an explicit pick also discards a saved deployment\u2019s matching rule', () => {
    // Otherwise "no key" would still silently match on the old rule.
    const prof = SEED.slice(SEED.indexOf('function sftkSeedProfileFor'));
    expect(prof).toMatch(/\(!overridden && saved\?\.tree\?\.matching\) \? \{ matching: saved\.tree\.matching \}/);
  });

  it('the table renders the key per object and flags the insert-only case', () => {
    expect(SEED).toContain('>Match key</th>');
    expect(SEED).toContain('data-seed-key-open=');
    expect(SEED).toContain('none — inserts only');
    expect(SEED).toContain('sftkSeedKeyPicker(b.dataset.seedKeyOpen)');
  });

  it('saved picks load before the table can claim what a run will do', () => {
    expect(SEED).toMatch(/sftkSeedKeysLoad\(\)\.then\(\(\) => \{ if \(_seedRows\) sftkSeedRenderRows\(\); \}\)/);
  });

  it('the picker offers only External IDs — nothing else can drive an upsert', () => {
    const pick = SEED.slice(SEED.indexOf('async function sftkSeedKeyPicker'));
    const body = pick.slice(0, pick.indexOf('\n}\n'));
    expect(body).toContain('extIds.map(fname =>');
    expect(body).toContain('has no External ID field');
    // and it can read an object that was never scanned, rather than refusing
    expect(body).toContain("path: `/services/data/v62.0/sobjects/${obj}/describe`");
  });
});

// ── Files, archived rows, and the email history that needs both ────────
describe('files and archived rows are opt-in and disclosed', () => {
  const { sftkSeedIsArchivable } = extractFunctions('studio-seed.js', ['sftkSeedIsArchivable']);
  afterEach(() => { delete globalThis._seedDesc; });

  it('detects archivability from the describe, not from a hard-coded list', () => {
    globalThis._seedDesc = {
      Task: { fields: [{ name: 'IsArchived' }] },
      Account: { fields: [{ name: 'Name' }] },
    };
    expect(sftkSeedIsArchivable('Task')).toBe(true);
    expect(sftkSeedIsArchivable('Account')).toBe(false);
    expect(sftkSeedIsArchivable('NeverRead')).toBe(false);
  });

  it('the archived pass filters IsArchived = true — normal SOQL hides them', () => {
    expect(SEED).toContain("where: 'IsArchived = true'");
    // A distinct profile id: the archived leg is its own run in History.
    expect(SEED).toContain("idSuffix: '_arch'");
  });

  it('both toggles default OFF and are wired to re-render', () => {
    expect(SEED).toMatch(/let _seedFiles = false;/);
    expect(SEED).toMatch(/let _seedArchived = false;/);
    expect(SEED).toContain("eid('dsSeedFiles')?.addEventListener");
    expect(SEED).toContain("eid('dsSeedArchived')?.addEventListener");
  });

  it('files ride the engine pass, which fails closed under masking', () => {
    expect(SEED).toMatch(/\.\.\.\(_seedFiles \? \{ includeFiles: true \} : \{\}\)/);
    expect(SEED).toContain('(blocked by masking)');
    // the engine end of the contract, unchanged
    expect(BG).toContain('files NOT transferred — a PII policy is active');
  });

  it('email history is seedable, including the recipient junction', () => {
    expect(SEED).toContain("'EmailMessage'");
    expect(SEED).toContain('function sftkSeedInsertOnlyStd');
    expect(SEED).toMatch(/return \['EmailMessageRelation'\]/);
    // insert-only objects bypass the updateable requirement DELIBERATELY
    expect(SEED).toMatch(/&& \(s\.updateable \|\| insertOnly\.has\(s\.name\)\)/);
  });
});

// ── Custom Setting owners cannot be carried by Id ──────────────────────
describe('hierarchy custom setting owners resolve by NAME', () => {
  const { sftkSeedResolveOwner, sftkSeedSettingFlavour, sftkSeedSettingFields } =
    extractFunctions('studio-seed.js',
      ['sftkSeedResolveOwner', 'sftkSeedSettingFlavour', 'sftkSeedSettingFields']);

  const TGT = { orgId: '00Dtarget', profilesByName: { Admin: '00eTGT' }, usersByName: { 'a@b.com': '005TGT' } };

  it('maps the org-default row onto the TARGET org id', () => {
    const owners = { '00Dsource': { type: 'Organization', name: 'Organization' } };
    expect(sftkSeedResolveOwner('00Dsource', owners, TGT)).toEqual({ id: '00Dtarget', why: null });
  });

  it('matches a profile row by profile name', () => {
    const owners = { '00eSRC': { type: 'Profile', name: 'Admin' } };
    expect(sftkSeedResolveOwner('00eSRC', owners, TGT).id).toBe('00eTGT');
  });

  it('refuses to guess when the target has no such profile — and says which', () => {
    const owners = { '00eSRC': { type: 'Profile', name: 'Custom Sales' } };
    const r = sftkSeedResolveOwner('00eSRC', owners, TGT);
    expect(r.id).toBe(null);
    expect(r.why).toContain('Custom Sales');
  });

  it('matches users by username, and names the ones the target lacks', () => {
    const owners = { '005SRC': { type: 'User', name: 'a@b.com' }, '005X': { type: 'User', name: 'gone@b.com' } };
    expect(sftkSeedResolveOwner('005SRC', owners, TGT).id).toBe('005TGT');
    expect(sftkSeedResolveOwner('005X', owners, TGT).why).toContain('gone@b.com');
  });

  it('an unreadable owner is UNKNOWN, not silently dropped', () => {
    expect(sftkSeedResolveOwner('00eSRC', {}, TGT).why).toMatch(/not readable/);
    expect(sftkSeedResolveOwner('', {}, TGT).why).toMatch(/no SetupOwnerId/);
  });

  it('tells hierarchy from list by the presence of SetupOwnerId', () => {
    expect(sftkSeedSettingFlavour({ fields: [{ name: 'SetupOwnerId' }] })).toBe('hierarchy');
    expect(sftkSeedSettingFlavour({ fields: [{ name: 'Name' }] })).toBe('list');
  });

  it('never copies SetupOwnerId raw — that id belongs to the source org', () => {
    const fields = sftkSeedSettingFields({ fields: [
      { name: 'Id', createable: false },
      { name: 'Name', createable: true },
      { name: 'SetupOwnerId', createable: true },
      { name: 'Rate__c', createable: true },
      { name: 'CreatedById', createable: true },
    ] });
    expect(fields).toEqual(['Name', 'Rate__c']);
  });

  it('a row whose owner cannot be resolved is skipped and NAMED, never mis-owned', () => {
    const fn = SEED.slice(SEED.indexOf('async function sftkSeedCfgSyncSetting'));
    expect(fn).toMatch(/if \(!res\.id\) \{ out\.skipped\.push\(`\$\{r\.Id\}: \$\{res\.why\}`\); continue; \}/);
    expect(fn).toContain('not written - ');
  });
});

// ── Filling the Match key column (user 2026-08-22: "i still can't see by
// what field they are matched") — the column can only name a field once
// the object is DESCRIBED, and load-time counting never describes. ─────
describe('the match-key sweep makes the column answerable', () => {
  it('exists as one explicit, quoted, cancellable sweep', () => {
    expect(SEED).toContain('async function sftkSeedKeyScan');
    expect(SEED).toContain('dsSeedKeyScan');
    expect(SEED).toContain('Find match keys');
    expect(SEED).toMatch(/Read \$\{todo\.length\} object\(s\) to find their match keys/);
    expect(SEED).toContain('read-only call(s), roughly');
  });

  it('charges only for objects it has not already read', () => {
    // A re-run after a PII scan is nearly free, and the quote says so
    // instead of re-charging for work already done.
    expect(SEED).toMatch(/const todo = _seedRows\.map\(r => r\.name\)\.filter\(o => !_seedDesc\[o\]\)/);
    expect(SEED).toContain('was already read');
  });

  it('a describe that FAILS leaves the object UNKNOWN, never "no key"', () => {
    expect(SEED).toMatch(/if \(d\?\.error\) \{ failed\+\+; \} else \{ _seedDesc\[o\] = d; \}/);
    expect(SEED).toContain('Unread objects stay UNKNOWN');
  });

  it('reports the split at the end — with a key vs insert-only', () => {
    expect(SEED).toMatch(/const withKey = _seedRows\.filter/);
    expect(SEED).toMatch(/const noKey = _seedRows\.filter/);
    expect(SEED).toContain('those can only INSERT');
  });

  it('can be stopped mid-sweep, like every other long read', () => {
    expect(SEED).toMatch(/if \(_seedKeyScanning\) \{ _seedCancelled = true; return; \}/);
    expect(SEED).toContain("b.textContent = '\u{1F511} Find match keys'");
  });
});
