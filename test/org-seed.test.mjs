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
    expect(SEED).toContain("inp.value.trim() !== 'RESET'");
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
    expect(SEED).toContain('piiPolicy: saved.piiPolicy, piiSalt: saved.piiSalt');
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
    expect(SEED).toMatch(/await confirmTypedProd\(orgLabel\(t\), summary\)/);
    // the seed-only path confirms prod targets too, matching the fan-out
    expect(SEED).toMatch(/if \(!what\.wipe\) \{\s*\n\s*if \(!\(await prodConfirms\(\)\)\) return;/);
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
