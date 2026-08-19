// M1b — FAN-OUT DRY RUN.
//
// THE HOLE THIS CLOSES. runProfile() (studio-profiles.js) routes the main Run
// button into openFanOut() whenever a deployment has more than one target, so
// "fan out" is what Run MEANS for a multi-org deployment. runFanOut() called
// SF_EXECUTE_PROFILE_TRANSFER directly, while the entire dry-run validator
// lived inside runTransfer's `if (_transferDryRun)` block — closing over
// _transferSrc / _transferTgt / logRow / dryRunIssues. Net effect: adding a
// second target silently deleted the best safety feature in the product and
// sent the run straight to real writes across every org.
//
// The validator is now the top-level `sftkDryRunAgainst(profileTree, srcSess,
// tgtSess, log, ownerMapping) -> { issues, checked, unchecked }`. These tests
// pin:
//   1. WRITES NOTHING — at the source level, the set of message types the
//      dry-run path can send is a subset of the read-only whitelist. No
//      SF_EXECUTE_PROFILE_TRANSFER, no REST POST/PATCH, no storage write.
//   2. The validator's behaviour against a stubbed org pair: a clean target,
//      a dirty one, and the two "could not check" paths.
//   3. sftkFanoutDryVerdict — THREE states. "could not check" is never
//      folded into "clean".
//   4. sftkFanoutDrySummary — per-target line + honest grand total.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunctions } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TRANSFER = readFileSync(join(root, 'studio-transfer.js'), 'utf8');

// Slice a top-level function's source text (same invariant extract.mjs uses:
// top-level functions close with `}` at column 0).
function sourceOf(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(TRANSFER);
  if (!m) throw new Error(`top-level function ${name} not found`);
  const end = TRANSFER.indexOf('\n}', m.index);
  return TRANSFER.slice(m.index, end + 2);
}

// ══════════════════════════════════════════════════════════════════
// 1. WRITES NOTHING — the load-bearing claim, asserted from source
// ══════════════════════════════════════════════════════════════════
describe('the dry-run path writes nothing', () => {
  // Everything the extension can ask background.js to do. Only these three
  // read-only messages may appear anywhere in the dry-run path.
  const READ_ONLY = new Set(['SF_QUERY', 'SF_REST_GET', 'GET_ALL_SF_SESSIONS']);

  const typesIn = src => new Set(
    [...src.matchAll(/type:\s*'([A-Z_0-9]+)'/g)].map(m => m[1])
  );

  it('sftkDryRunAgainst sends ONLY SF_QUERY and SF_REST_GET', () => {
    const types = typesIn(sourceOf('sftkDryRunAgainst'));
    expect([...types].sort()).toEqual(['SF_QUERY', 'SF_REST_GET']);
    for (const t of types) expect(READ_ONLY.has(t)).toBe(true);
  });

  it('dryRunFanOut itself sends no messages at all — sessions come from getOrgSession', () => {
    const src = sourceOf('dryRunFanOut');
    expect([...typesIn(src)]).toEqual([]);
    expect(src).toContain('getOrgSession');     // → GET_ALL_SF_SESSIONS, a read
  });

  it('neither function can reach the write engine, REST writes, or history', () => {
    for (const name of ['sftkDryRunAgainst', 'dryRunFanOut']) {
      const src = sourceOf(name);
      for (const forbidden of [
        'SF_EXECUTE_PROFILE_TRANSFER', 'SF_REST_POST', 'SF_REST_PATCH',
        'SF_REST_DELETE', 'SF_BULK', 'SF_INSERT', 'SF_UPDATE', 'SF_UPSERT',
        '_history.push', 'storageSaveHistory', 'storageSaveProfiles',
        'chrome.storage',
      ]) {
        expect(src, `${name} must not reference ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('sendBg is only ever called with a read message inside the validator', () => {
    // Every sendBg({ ... }) literal in the validator opens with a type: line.
    const src = sourceOf('sftkDryRunAgainst');
    const calls = [...src.matchAll(/sendBg\(\{([\s\S]*?)\}\)/g)].map(m => m[1]);
    expect(calls.length).toBeGreaterThan(5);
    for (const c of calls) {
      const t = /type:\s*'([A-Z_0-9]+)'/.exec(c);
      expect(t, `sendBg call without a literal type: ${c.slice(0, 60)}`).toBeTruthy();
      expect(READ_ONLY.has(t[1])).toBe(true);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// 2. The validator against a stubbed org pair
// ══════════════════════════════════════════════════════════════════
// sftkDryRunAgainst is not pure (it calls sendBg + soqlStrLit), but both are
// free variables — so `new Function` resolves them off globalThis at call
// time and the test can drive the whole thing off a canned org pair.
const { sftkDryRunAgainst } = extractFunctions('studio-transfer.js',
  ['sftkDryRunAgainst'], { 'studio-core.js': ['soqlStrLit'] });

const SRC = { orgUrl: 'https://acme.my.salesforce.com', sid: 'SID_SRC' };
const TGT = { orgUrl: 'https://acme--qa.sandbox.my.salesforce.com', sid: 'SID_TGT' };

const fld = (name, extra) => ({
  name, type: 'string', createable: true, nillable: true,
  defaultValue: null, length: 255, ...extra,
});

// Source: Account with a required Name and an Industry picklist.
const SRC_ACCOUNT = { name: 'Account', fields: [
  fld('Id', { createable: false, type: 'id' }),
  fld('Name', { nillable: false }),
  fld('Industry', { type: 'picklist' }),
] };

function makeSendBg(opts = {}) {
  const sent = [];
  globalThis.sendBg = async msg => {
    sent.push(msg);
    if (msg.type === 'SF_REST_GET') {
      const isTgt = msg.orgUrl === TGT.orgUrl;
      if (isTgt && opts.targetDescribeFails) return { error: 'INSUFFICIENT_ACCESS' };
      if (isTgt) return opts.targetDescribe || SRC_ACCOUNT;
      return SRC_ACCOUNT;
    }
    // SF_QUERY
    const q = String(msg.query || '');
    if (/COUNT\(\)/.test(q)) {
      if (opts.countFails) return { error: 'MALFORMED_QUERY: no such column' };
      return { totalSize: opts.count ?? 3, records: [] };
    }
    if (/FROM ValidationRule|FROM ApexTrigger|FROM DuplicateRule/.test(q)) {
      return opts.automation || { records: [] };
    }
    if (/GROUP BY RecordType/.test(q)) return { error: 'no record types' };
    // the row samples (null-check + value preflight)
    return { records: opts.rows || [{ Id: '001', Name: 'Acme', Industry: 'Banking' }] };
  };
  return sent;
}

const noop = () => {};
afterEach(() => { delete globalThis.sendBg; });

describe('sftkDryRunAgainst — the extracted validator', () => {
  it('a clean pair: no issues, every object checked, nothing unchecked', async () => {
    makeSendBg();
    const r = await sftkDryRunAgainst({ objectType: 'Account' }, SRC, TGT, noop, null);
    expect(r).toEqual({ issues: 0, checked: 1, unchecked: 0 });
  });

  it('walks children — checked counts every node in the tree', async () => {
    makeSendBg();
    const tree = { objectType: 'Account', children: [{ childSObject: 'Contact', field: 'AccountId' }] };
    const r = await sftkDryRunAgainst(tree, SRC, TGT, noop, null);
    expect(r.checked).toBe(2);
    expect(r.issues).toBe(0);
  });

  it('a required target field with no source mapping is an issue, with the original message', async () => {
    const lines = [];
    makeSendBg({ targetDescribe: { name: 'Account', fields: [
      ...SRC_ACCOUNT.fields, fld('Region__c', { nillable: false }),
    ] } });
    const r = await sftkDryRunAgainst({ objectType: 'Account' }, SRC, TGT,
      (i, m, c) => lines.push([i, m, c]), null);
    expect(r.issues).toBe(1);
    expect(r.unchecked).toBe(0);
    expect(lines.some(([, m]) => m.includes('Region__c: required in target, but no source field is mapped to it'))).toBe(true);
  });

  it('a restricted picklist rejects sampled values — the original error text survives extraction', async () => {
    const lines = [];
    makeSendBg({
      targetDescribe: { name: 'Account', fields: [
        fld('Id', { createable: false, type: 'id' }),
        fld('Name', { nillable: false }),
        fld('Industry', { type: 'picklist', restrictedPicklist: true,
          picklistValues: [{ value: 'Technology', active: true }] }),
      ] },
      rows: [{ Id: '001', Name: 'Acme', Industry: 'Banking' }],
    });
    const r = await sftkDryRunAgainst({ objectType: 'Account' }, SRC, TGT,
      (i, m, c) => lines.push([i, m, c]), null);
    expect(r.issues).toBe(1);
    const msg = lines.map(l => l[1]).join('\n');
    expect(msg).toMatch(/restricted picklist in the target/);
    expect(msg).toMatch(/INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST/);
  });

  it('the owner-fallback sanity line is emitted BEFORE the tree walk, exactly as before', async () => {
    const lines = [];
    makeSendBg();
    await sftkDryRunAgainst({ objectType: 'Account' }, SRC, TGT,
      (i, m) => lines.push(m), { mode: 'match', fallbackUserId: '' });
    expect(lines[0]).toMatch(/^Owner matching is ON but no fallback user is picked/);
  });

  it('…and stays silent when a fallback user IS picked', async () => {
    const lines = [];
    makeSendBg();
    await sftkDryRunAgainst({ objectType: 'Account' }, SRC, TGT,
      (i, m) => lines.push(m), { mode: 'match', fallbackUserId: '005xx' });
    expect(lines.some(m => /Owner matching is ON/.test(m))).toBe(false);
  });

  it('lists the target automation a dry run CANNOT test, by name', async () => {
    const lines = [];
    makeSendBg({ automation: { records: [{ ValidationName: 'Acct_Region_Req', Name: 'AccountTrigger', DeveloperName: 'Acct_Dupes' }] } });
    await sftkDryRunAgainst({ objectType: 'Account' }, SRC, TGT, (i, m) => lines.push(m), null);
    const joined = lines.join('\n');
    expect(joined).toMatch(/target automation a dry run CANNOT test/);
    expect(joined).toMatch(/Acct_Region_Req/);
  });

  // ── the two "could not check" paths ──────────────────────────────
  it('a failed source query counts as unchecked, not as a checked-and-clean object', async () => {
    makeSendBg({ countFails: true });
    const r = await sftkDryRunAgainst({ objectType: 'Account' }, SRC, TGT, noop, null);
    expect(r.checked).toBe(0);
    expect(r.unchecked).toBe(1);
    expect(r.issues).toBe(1);
  });

  it('LATENT BUG PINNED: a failed TARGET describe still logs "all required fields present" — but is now counted as unchecked', async () => {
    // The pre-existing block fell back to requiredInTarget = [] when the
    // target describe failed, so Step 4 printed a green line for a check that
    // never ran. The extraction preserved that message verbatim (it is a
    // refactor, not a fix); the `unchecked` counter is what stops a caller
    // reporting the target as clean. Fixing the LINE is a separate change.
    const lines = [];
    makeSendBg({ targetDescribeFails: true });
    const r = await sftkDryRunAgainst({ objectType: 'Account' }, SRC, TGT,
      (i, m) => lines.push(m), null);
    expect(lines.some(m => /all required fields present/.test(m))).toBe(true);  // the bug
    expect(r.issues).toBe(0);
    expect(r.unchecked).toBe(1);                                               // the guard
  });
});

// ══════════════════════════════════════════════════════════════════
// 3. sftkFanoutDryVerdict — three states, never two
// ══════════════════════════════════════════════════════════════════
describe('sftkFanoutDryVerdict', () => {
  const { sftkFanoutDryVerdict } = extractFunctions('studio-transfer.js', ['sftkFanoutDryVerdict']);

  it('no open tab → skipped, and says nothing was checked', () => {
    const v = sftkFanoutDryVerdict({ skipped: true });
    expect(v.state).toBe('skipped');
    expect(v.detail).toMatch(/nothing was checked/);
  });

  it('a thrown error → could not check, never clean', () => {
    const v = sftkFanoutDryVerdict({ error: 'Session expired' });
    expect(v.state).toBe('unknown');
    expect(v.detail).toMatch(/Session expired/);
  });

  it('issues → dirty, with the count front and centre', () => {
    const v = sftkFanoutDryVerdict({ issues: 3, checked: 2, unchecked: 0 });
    expect(v.state).toBe('dirty');
    expect(v.label).toBe('3 issue(s)');
  });

  it('THE HOUSE RULE: zero issues but something unchecked is NOT clean', () => {
    const v = sftkFanoutDryVerdict({ issues: 0, checked: 1, unchecked: 1 });
    expect(v.state).toBe('unknown');
    expect(v.detail).toMatch(/NOT a clean result/);
  });

  it('nothing checked at all is NOT clean either', () => {
    const v = sftkFanoutDryVerdict({ issues: 0, checked: 0, unchecked: 0 });
    expect(v.state).toBe('unknown');
    expect(v.detail).toMatch(/NOT a clean result/);
  });

  it('dirty AND partially unchecked reports both', () => {
    const v = sftkFanoutDryVerdict({ issues: 2, checked: 1, unchecked: 3 });
    expect(v.state).toBe('dirty');
    expect(v.detail).toMatch(/3 object\(s\) could not be checked/);
  });

  it('clean only when something was checked and nothing went wrong', () => {
    const v = sftkFanoutDryVerdict({ issues: 0, checked: 2, unchecked: 0 });
    expect(v.state).toBe('clean');
    expect(v.label).toBe('clean');
    expect(v.detail).toMatch(/2 object\(s\) checked/);
  });

  it('a missing result is treated as skipped, never as clean', () => {
    expect(sftkFanoutDryVerdict(null).state).toBe('skipped');
  });
});

// ══════════════════════════════════════════════════════════════════
// 4. sftkFanoutDrySummary — per target, then the grand total
// ══════════════════════════════════════════════════════════════════
describe('sftkFanoutDrySummary', () => {
  const { sftkFanoutDrySummary, sftkFanoutDryVerdict } =
    extractFunctions('studio-transfer.js', ['sftkFanoutDryVerdict', 'sftkFanoutDrySummary']);

  const row = (label, res) => ({ label, issues: res.issues || 0, verdict: sftkFanoutDryVerdict(res) });

  it('reads exactly like the brief: "Development: 3 issue(s) · QA Sandbox: clean"', () => {
    const s = sftkFanoutDrySummary([
      row('Development', { issues: 3, checked: 2, unchecked: 0 }),
      row('QA Sandbox',  { issues: 0, checked: 2, unchecked: 0 }),
    ]);
    expect(s.per).toBe('Development: 3 issue(s) · QA Sandbox: clean');
  });

  it('the grand total keeps every state separate — clean never absorbs the rest', () => {
    const s = sftkFanoutDrySummary([
      row('Development', { issues: 3, checked: 2, unchecked: 0 }),
      row('QA Sandbox',  { issues: 0, checked: 2, unchecked: 0 }),
      row('UAT',         { issues: 0, checked: 1, unchecked: 1 }),
      row('Training',    { skipped: true }),
    ]);
    expect(s.tally).toEqual({ clean: 1, dirty: 1, unknown: 1, skipped: 1, issues: 3 });
    expect(s.total).toBe('1 clean · 1 with issues (3 total) · 1 could not be checked · 1 skipped');
  });

  it('sums issues across every dirty target', () => {
    const s = sftkFanoutDrySummary([
      row('A', { issues: 4, checked: 1 }),
      row('B', { issues: 7, checked: 1 }),
    ]);
    expect(s.tally.issues).toBe(11);
    expect(s.total).toBe('2 with issues (11 total)');
  });

  it('no targets → says so instead of implying success', () => {
    expect(sftkFanoutDrySummary([]).total).toBe('no targets');
    expect(sftkFanoutDrySummary(null).total).toBe('no targets');
  });
});

// ══════════════════════════════════════════════════════════════════
// 5. Honesty requirements that live in the UI strings
// ══════════════════════════════════════════════════════════════════
describe('the fan-out dialog tells the truth about dry runs', () => {
  it('the old "fan-out has no dry-run mode" claim is gone', () => {
    expect(TRANSFER).not.toContain('fan-out has no dry-run mode');
  });

  it('the dialog offers the action and calls it point-in-time', () => {
    expect(TRANSFER).toContain('🧪 Dry run all targets');
    expect(TRANSFER).toMatch(/point-in-time/);
  });

  it('the panel states that a dry run reads each target as it is right now', () => {
    expect(sourceOf('dryRunFanOut')).toMatch(/AS IT IS RIGHT NOW/);
  });

  it('a skipped target is announced, not silently dropped', () => {
    expect(sourceOf('dryRunFanOut')).toMatch(/skipped: true/);
  });

  it('the real run stays reachable after a dirty result — informs, never blocks', () => {
    const src = sourceOf('dryRunFanOut');
    expect(src).toContain('dsFanoutDryReal');
    expect(src).toMatch(/Nothing is blocked/);
  });

  it('an all-skipped run never shows the green banner — nothing checked is the headline', () => {
    const src = sourceOf('dryRunFanOut');
    // The "clean" banner is guarded on there being at least one clean target,
    // so N skipped + 0 checked can never render as success.
    expect(src).toMatch(/sum\.tally\.clean === 0[\s\S]*?Nothing was checked/);
    expect(src).toMatch(/allGood \? 'success' : 'warning'/);
  });
});

// ══════════════════════════════════════════════════════════════════
// 6. The single-target path is unchanged
// ══════════════════════════════════════════════════════════════════
describe('runTransfer still behaves identically for one target', () => {
  const runTransferSrc = (() => {
    const i = TRANSFER.indexOf('\nasync function runTransfer() {');
    return TRANSFER.slice(i, TRANSFER.indexOf('\n}\n', i));
  })();

  it('calls the extracted validator with the patched tree and the live org pair', () => {
    expect(runTransferSrc).toMatch(/sftkDryRunAgainst\(\s*[\r\n\s]*buildTransferProfile\(\)\.tree, _transferSrc, _transferTgt, logRow,/);
  });

  it('keeps the same header line, summary lines, toasts and _validatedRuns bookkeeping', () => {
    expect(runTransferSrc).toContain('DRY RUN — validating "${_transferProfile.name}" (nothing will be written)…');
    expect(runTransferSrc).toContain('Dry run found ${dryRunIssues} issue(s) — fix these before running the real transfer.');
    expect(runTransferSrc).toContain("showToast('Dry run passed ✓ — no field issues found', 'success', 4000)");
    expect(runTransferSrc).toContain('_validatedRuns.delete(_valKey())');
    expect(runTransferSrc).toContain('_validatedRuns.add(_valKey())');
    expect(runTransferSrc).toContain('_syncRunButtons()');
  });

  it('no longer carries its own copy of the validator', () => {
    expect(runTransferSrc).not.toContain('async function dryRunNode');
    expect(runTransferSrc).not.toContain('lookupResolutions');
  });

  // ── Fable recheck fix: the caller was the "lying caller" the validator's
  // contract comment warns about — it destructured `issues` alone, so a run
  // whose target describe failed (issues:0, unchecked:1) still printed
  // "Dry run passed" and lit the ✓ chip.
  it('HONEST CALLER: the three-state verdict gates the outcome — unchecked is no longer discarded', () => {
    expect(runTransferSrc).toMatch(/sftkFanoutDryVerdict\(dryRes\)/);
    expect(runTransferSrc).not.toMatch(/const \{ issues: dryRunIssues \} = await sftkDryRunAgainst/);
    // the incomplete path exists, warns, and refuses to mark validated
    expect(runTransferSrc).toContain('Dry run incomplete');
    expect(runTransferSrc).toMatch(/verdict\.state !== 'clean'[\s\S]*?_validatedRuns\.delete\(_valKey\(\)\)/);
    // "passed" and the ✓ add live ONLY in the else (clean) branch
    const passedIdx = runTransferSrc.indexOf("showToast('Dry run passed ✓");
    const incompleteIdx = runTransferSrc.indexOf('Dry run incomplete');
    expect(passedIdx).toBeGreaterThan(incompleteIdx);
  });
});

// ══════════════════════════════════════════════════════════════════
// 7. Honest counting — every node lands in exactly one bucket
// ══════════════════════════════════════════════════════════════════
describe('sftkDryRunAgainst counting (Fable recheck fixes)', () => {
  it('a failed source COUNT marks the WHOLE skipped subtree unchecked — never-visited children must not vanish from both counters', async () => {
    makeSendBg({ countFails: true });
    const tree = { objectType: 'Account', children: [
      { childSObject: 'Contact', field: 'AccountId', children: [
        { childSObject: 'Task', field: 'WhoId' },
      ] },
    ] };
    const r = await sftkDryRunAgainst(tree, SRC, TGT, noop, null);
    expect(r.checked).toBe(0);
    expect(r.unchecked).toBe(3);   // Account + Contact + Task, all unread
  });

  it('a failed target describe puts the node in ONE bucket — unchecked, never checked AND unchecked', async () => {
    makeSendBg({ targetDescribeFails: true });
    const r = await sftkDryRunAgainst({ objectType: 'Account' }, SRC, TGT, noop, null);
    expect(r.checked).toBe(0);
    expect(r.unchecked).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
// 8. _validatedRuns keys are payload-fingerprinted
// ══════════════════════════════════════════════════════════════════
// Pre-fix every surface keyed on profile|src|tgt alone, but each validates a
// DIFFERENT payload: the Transfer tab patches run-time node filters + the
// Upsert toggle in, the fan-out validates treeForTarget() in insert mode. A
// clean chip from one could vouch for a write the other never checked.
describe('_validatedRuns keys are payload-fingerprinted', () => {
  const { sftkValFingerprint } = extractFunctions('studio-transfer.js', ['sftkValFingerprint']);
  const tree = { objectType: 'Account', children: [{ childSObject: 'Case', field: 'AccountId' }] };

  it('is stable for an identical payload', () => {
    expect(sftkValFingerprint(tree, null))
      .toBe(sftkValFingerprint(JSON.parse(JSON.stringify(tree)), null));
  });

  it('ignores underscore UI state — folding a tree node does not un-validate a run', () => {
    const withMeta = { ...tree, _meta: { expanded: true } };
    expect(sftkValFingerprint(withMeta, null)).toBe(sftkValFingerprint(tree, null));
  });

  it('changes when the effective tree changes', () => {
    const filtered = { ...tree, where: "Name = 'Acme'" };
    expect(sftkValFingerprint(filtered, null)).not.toBe(sftkValFingerprint(tree, null));
  });

  it('separates insert from upsert — an insert validation cannot vouch for an upsert write', () => {
    expect(sftkValFingerprint(tree, 'External_Id__c')).not.toBe(sftkValFingerprint(tree, null));
  });

  it('_valKey embeds the fingerprint and normalizes org urls via _orgKey', () => {
    const src = sourceOf('_valKey');
    expect(src).toContain('sftkValFingerprint');
    expect(src).toContain('_orgKey(_transferSrc?.orgUrl');
    expect(src).toContain('_orgKey(_transferTgt?.orgUrl');
  });

  it('dryRunFanOut writes the same key shape for the per-target tree it validated, insert mode', () => {
    const src = sourceOf('dryRunFanOut');
    expect(src).toMatch(/valKey\s+=\s+`\$\{p\.id\}\|\$\{_orgKey\(srcUrl\)\}\|\$\{_orgKey\(tgtUrl\)\}\|\$\{sftkValFingerprint\(tree, null\)\}`/);
  });
});

// ══════════════════════════════════════════════════════════════════
// 9. The fan-out dialog tells the truth about write mode
// ══════════════════════════════════════════════════════════════════
describe('openFanOut write-mode claim', () => {
  const openFanOutSrc = (() => {
    const i = TRANSFER.indexOf('window.openFanOut = async function');
    if (i < 0) throw new Error('openFanOut not found');
    return TRANSFER.slice(i, TRANSFER.indexOf('\n};', i) + 3);
  })();

  it('states the SAVED write behavior — per-node upserts ride, the Transfer-tab toggle never does', () => {
    // The dialog once displayed _transferWriteMode as "Write mode",
    // promising upserts the engine never performed on fan-out. W1: per-node
    // upsert configs DO ride the saved profile, so the label counts them.
    expect(openFanOutSrc).toContain('upsertNodeCount');
    expect(openFanOutSrc).toMatch(/mode = \(p\.tree && p\.tree\.upsert && p\.tree\.upsert\.field\) \? 'upsert' : 'insert'/);
    expect(openFanOutSrc).toContain('applies to single-target runs only');
  });

  it('the ✓ chip reads the fingerprinted key for the per-target payload', () => {
    expect(openFanOutSrc).toContain('sftkValFingerprint');
    expect(openFanOutSrc).not.toContain('_validatedRuns.has(`${p.id}|${srcUrl}|${o.url}`)');
  });

  it("the noop-confirm Back path reopens with the user's ACTUAL ticks, not the defaults", () => {
    // Untick A, tick B+C, hit Run, get "Nothing to write", click Back —
    // reopening with the original opts silently reverted to A ticked.
    expect(openFanOutSrc).toMatch(/openFanOut\(profileId, \{ \.\.\.opts, preselect: targets \}\)/);
  });

  it('engine controls are reachable and persist to the profile', () => {
    // ▶ Run on a multi-target deployment goes straight to this dialog —
    // without these controls apiMode/batchSize had NO route on that path.
    expect(openFanOutSrc).toContain('id="dsFanoutApiMode"');
    expect(openFanOutSrc).toContain('id="dsFanoutBatchSize"');
    // same persistence contract as the Run page: profile-saved, auto/200
    // are the absent-key defaults so they delete rather than store
    expect(openFanOutSrc).toMatch(/if \(v === 'sync' \|\| v === 'bulk'\) p\.apiMode = v; else delete p\.apiMode;/);
    expect(openFanOutSrc).toMatch(/if \(n === 200\) delete p\.batchSize; else p\.batchSize = n;/);
  });
});

// ── Child-verdict law reaches the fan-out advice (user 2026-08-18: a7
// showed "in sync — nothing to write" over 1,850 never-pushed children) ──
describe('sftkFanoutTargetAdvice — children gate the clean verdict', () => {
  const advice = extractFunctions('studio-transfer.js',
    ['sftkFanoutTargetAdvice', 'sftkFanoutScanAge']).sftkFanoutTargetAdvice;
  const cleanScan = { missing: 0, changed: 0, extra: 0, runAt: new Date(Date.now() - 60000).toISOString(), status: 'success' };

  it('clean root + unscanned children → unknown, actionable, never "nothing to write"', () => {
    const a = advice(cleanScan, true, 'upsert', Date.now(), { need: 0, unscanned: 1 });
    expect(a.tone).toBe('unknown');
    expect(a.actionable).toBe(true);
    expect(a.headline).toContain('child records not checked here');
  });

  it('clean root + fresh child work → act, with the count', () => {
    const a = advice(cleanScan, true, 'upsert', Date.now(), { need: 1850, unscanned: 0 });
    expect(a.tone).toBe('act');
    expect(a.headline).toContain('1850 child record(s)');
  });

  it('clean root + fresh clean children (or no children) → clean, as before', () => {
    expect(advice(cleanScan, true, 'upsert', Date.now(), { need: 0, unscanned: 0 }).tone).toBe('clean');
    expect(advice(cleanScan, true, 'upsert', Date.now(), null).tone).toBe('clean');
    expect(advice(cleanScan, true, 'upsert', Date.now()).tone).toBe('clean');
  });
});
