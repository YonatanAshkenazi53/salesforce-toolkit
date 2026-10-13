// AUDIT 2026-09-12 — the fourteen verified findings of the pre-1.4.3 bug +
// regression audit (HANDOVER.md §3), each pinned so it cannot quietly come
// back. Numbering follows the handover.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const BG  = read('background.js');
const DEP = read('dependency-map.js');
const PU  = read('popup.js');
const TM  = read('sftk-terms.js');
const FC  = read('field-cleaner.js');

// Slice a function body out of a source text: from its header to the next
// closing brace at the given indent (top-level = column 0).
// Comment lines stripped — several pins assert that a pattern is ABSENT
// from code, and the explanatory comments quote the old pattern.
const noComments = s => s.replace(/^[ 	]*\/\/.*$/gm, '');
const slice = (src, header, indent = '') => {
  const i = src.indexOf(header);
  if (i === -1) throw new Error(`not found: ${header}`);
  const end = src.indexOf(`\n${indent}}`, i);
  return src.slice(i, end + indent.length + 2);
};

// ════════════════════════════════════════════════════════════════════════
describe('1 · SESSION_EXPIRED retry is pinned to the message’s own org', () => {
  const fn = slice(BG, 'async function handleMessage(message)');

  it('never asks getSfSession (which falls back to ANY open org tab)', () => {
    expect(noComments(fn)).not.toContain('getSfSession(');
    expect(fn).toContain('sftkCookieSessFor(message.orgUrl)');
  });

  it('refuses the retry unless the org identity matches exactly', () => {
    expect(fn).toMatch(/sftkOrgKey\(fresh\.orgUrl\) === sftkOrgKey\(message\.orgUrl\)/);
    expect(fn).toContain('dispatchMessage({ ...message, sid: fresh.sid })');
    expect(fn).not.toContain('orgUrl: fresh.orgUrl');
  });

  it('never re-runs a message that has no orgUrl (transfer/sequence runners)', () => {
    expect(fn).toMatch(/message\.type !== 'GET_SF_SESSION' && message\.orgUrl\)/);
  });

  // Behavioural: materialise handleMessage with stubs for its collaborators.
  const build = (dispatch, cookieSess) => {
    const keySrc = slice(BG, 'function sftkOrgKey(orgUrl)');
    return new Function('dispatchMessage', 'sftkCookieSessFor',
      `${keySrc}\n${fn}\nreturn handleMessage;`)(dispatch, cookieSess);
  };
  const expiredThenOk = () => {
    const calls = [];
    const dispatch = async (m) => { calls.push(m); if (calls.length === 1) throw new Error('SESSION_EXPIRED'); return { ok: true, sid: m.sid, orgUrl: m.orgUrl }; };
    return { calls, dispatch };
  };

  it('retries once, same org, new sid — orgUrl untouched', async () => {
    const { calls, dispatch } = expiredThenOk();
    const h = build(dispatch, async () => ({ orgUrl: 'https://acme.my.salesforce.com', sid: 'NEW' }));
    const r = await h({ type: 'SF_PATCH', orgUrl: 'https://acme.lightning.force.com', sid: 'OLD', path: 'x', body: {} });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].orgUrl).toBe('https://acme.lightning.force.com');
    expect(calls[1].sid).toBe('NEW');
  });

  it('a session for a DIFFERENT org is never used — the write is not re-sent', async () => {
    const { calls, dispatch } = expiredThenOk();
    const h = build(dispatch, async () => ({ orgUrl: 'https://other.my.salesforce.com', sid: 'NEW' }));
    await expect(h({ type: 'SF_COLLECTIONS_CREATE', orgUrl: 'https://acme.my.salesforce.com', sid: 'OLD', records: [] }))
      .rejects.toThrow('SESSION_EXPIRED');
    expect(calls).toHaveLength(1);
  });

  it('no orgUrl on the message (a transfer) → no retry at all', async () => {
    const { calls, dispatch } = expiredThenOk();
    const h = build(dispatch, async () => ({ orgUrl: 'https://acme.my.salesforce.com', sid: 'NEW' }));
    await expect(h({ type: 'SF_EXECUTE_PROFILE_TRANSFER', srcOrgUrl: 'https://acme.my.salesforce.com', tgtOrgUrl: 'https://b.my.salesforce.com' }))
      .rejects.toThrow('SESSION_EXPIRED');
    expect(calls).toHaveLength(1);
  });

  it('the same (still-expired) sid is not retried', async () => {
    const { calls, dispatch } = expiredThenOk();
    const h = build(dispatch, async () => ({ orgUrl: 'https://acme.my.salesforce.com', sid: 'OLD' }));
    await expect(h({ type: 'SF_PATCH', orgUrl: 'https://acme.my.salesforce.com', sid: 'OLD' })).rejects.toThrow('SESSION_EXPIRED');
    expect(calls).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('2 · upsert-key injection leaves the 🪪 identity stamp alone', () => {
  it('skips injection when the upsert key IS the stamp field', () => {
    const fn = slice(BG, 'const sendChunk = async (i) =>', '      ');
    expect(fn).toMatch(/if \(useUpsert && upsertField && upsertField !== node\.stampField\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('3 + 5 · the completeness invariant covers EVERY engine read', () => {
  it('has one shared refusal, and it names the shortfall', () => {
    const { sftkIncompleteErr } = extractFunctions('background.js', ['sftkIncompleteErr']);
    const e = sftkIncompleteErr('Contact', 'child records', { expected: 900, got: 400 });
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toContain('Contact');
    expect(e.message).toContain('child records');
    expect(e.message).toContain('900');
    expect(e.message).toContain('400');
    expect(e.message).toContain('Nothing was written');
  });

  it('parent-scope prefetch refuses partial pages (both branches)', () => {
    const fn = slice(BG, 'async function getScopeIds(entry)', '  ');
    const hits = fn.match(/if \(r\.incomplete\) throw sftkIncompleteErr\(objType, 'parent scope', r\.incomplete, /g) || [];
    // …and the consequence names the CHILD skip, not a phantom parent write
    expect(fn).toContain('The child object that depends on this scope was SKIPPED');
    expect(hits.length).toBe(2);
  });

  it('picked-id chunks refuse partial pages', () => {
    const fn = slice(BG, 'const fetchByIdChunks = async ids =>', '      ');
    expect(fn).toContain("throw sftkIncompleteErr(objType, 'picked records', r.incomplete)");
  });

  it('child chunks refuse partial pages', () => {
    expect(BG).toContain("if (chunkRes.incomplete) throw sftkIncompleteErr(objType, 'child records', chunkRes.incomplete)");
  });

  it('the root read keeps its own refusal', () => {
    expect(BG).toContain('the source read came back INCOMPLETE');
  });

  it('the Seeder wipe refuses a partial Id list instead of reporting a full wipe', async () => {
    const fn = slice(BG, 'async function sftkWipeObject(');
    expect(fn).toMatch(/if \(q\.incomplete\) \{/);
    expect(fn).toContain('Nothing was deleted');
    // behavioural: 2 of 3 ids arrived → throw before any delete
    const deletes = [];
    const src = `${fn}\nreturn sftkWipeObject;`;
    const wipe = new Function('sfQueryAll', 'postRunProgress', 'sfHardDelete', 'sfCollectionsDelete', '_runCancelled', src)(
      async () => ({ records: [{ Id: 'a' }, { Id: 'b' }], incomplete: { expected: 3, got: 2 } }),
      () => {}, async ids => { deletes.push(ids); return {}; }, async ids => { deletes.push(ids); return []; }, false);
    await expect(wipe('https://t.my.salesforce.com', 's', 'Load__c', 'recycle')).rejects.toThrow('INCOMPLETE');
    expect(deletes).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('4 · a metadata deploy is never submitted twice', () => {
  const fn = slice(BG, 'async function sfMetadataDeploy(');

  it('polls through the proxy chokepoint, not a raw-sid fetch', () => {
    expect(fn).toContain("sfFetchWithProxy(orgUrl, sid, statusUrl, { method: 'GET' })");
    expect(fn).not.toMatch(/statusRes\.status === 401/);
  });

  it('a session loss mid-poll is its own, non-retryable error naming the job', () => {
    expect(fn).toMatch(/e\.message === 'SESSION_EXPIRED'\) \{\s*throw new Error\(`Session expired while waiting for deployment \$\{jobId\}/);
  });

  it('a 401 on the SUBMIT (nothing deployed yet) still retries normally', () => {
    expect(fn).toContain("if (deployRes.status === 401) throw new Error('SESSION_EXPIRED');");
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('6 · ⚙ Apply reads composite-batch items at the right depth', () => {
  const fn = slice(DEP, 'async function applyApiVerChange(', '  ');

  it('takes the record from item.body — the shape sfCompositeBatch returns', () => {
    expect(fn).toMatch(/const rec = \(it && it\.ok && it\.body && typeof it\.body === 'object'\) \? it\.body : null/);
    expect(noComments(fn)).not.toContain('.result ||');
  });

  it('…which is the same shape the scan reads and the batch runner emits', () => {
    expect(DEP).toMatch(/r\.ok && r\.body && typeof r\.body === 'object'\) \? r\.body\.Metadata/);
    const runner = slice(BG, 'async function sfCompositeBatch(');
    expect(runner).toMatch(/body: undefined/);          // the fail-all shape
    expect(runner).toContain('JSON.parse(res.body)');   // items parsed from the batch reply
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('7 · ⏻ Flow switches sit behind a typed confirmation', () => {
  const plan  = slice(DEP, 'async function runFlowBulk(body, mode)', '  ');
  const apply = slice(DEP, 'async function applyFlowBulk(out, mode, perOrg)', '  ');

  it('no browser confirm() anywhere near the write', () => {
    expect(noComments(plan)).not.toMatch(/\bconfirm\(/);
    expect(noComments(apply)).not.toMatch(/\bconfirm\(/);
  });

  it('the user types OFF or ON before the shared dialog’s Go enables', () => {
    // Campaign 3 phase 2: moved into the shared sftkConfirmDestructive
    // dialog (sftk-confirm.js) — the typed word is now that dialog's own gate.
    expect(plan).toContain("const word = mode === 'deactivate' ? 'OFF' : 'ON'");
    expect(plan).toContain('sftkConfirmDestructive(');
    expect(plan).not.toContain('typedWord');  // owner 2026-10-13: checkbox, not a typed ON/OFF
    expect(plan).toContain("ack: 'I understand and want to proceed'");
  });

  it('the write lives only past the gate', () => {
    expect(plan).not.toContain("type: 'SF_PATCH'");
    expect(apply).toContain("type: 'SF_PATCH'");
    expect(apply).toMatch(/if \(_fbBusy\) return;\s*_fbBusy = true;/);
  });

  it('the confirmation still says what switching OFF means', () => {
    expect(plan).toContain('stops for EVERYONE');
    expect(plan).toContain('never retroactively processed');
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('8 · “This org” has a session even when no dependency scan ran', () => {
  it('the tab render carries the sid and remembers it', () => {
    expect(DEP).toContain('function renderDependencyTreeTab(allFlows, container, orgUrl, sid)');
    expect(DEP).toContain('_lastSid = sid || _lastSid;');
  });

  it('both panels fall back to it', () => {
    const fb = slice(DEP, 'function renderFlowBulkPanel(mount, orgUrl)', '  ');
    const av = slice(DEP, 'function renderApiVerPanel(mount, orgUrl)', '  ');
    expect(fb).toContain("sid: _scanSid || _lastSid, label: `This org (${depHost(orgUrl)})`");
    expect(av).toContain("sid: _scanSid || _lastSid, label: `This org (${depHost(orgUrl)})`");
  });

  it('popup passes it at both call sites', () => {
    const hits = PU.match(/DependencyMap\.renderDependencyTreeTab\(allFlows, container, orgUrl, sid\)/g) || [];
    expect(hits.length).toBe(2);
    expect(PU).not.toMatch(/renderDependencyTreeTab\(allFlows, container, orgUrl\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('9 · 🔒 managed nodes follow the process-type filter', () => {
  it('the filter click dims managed nodes too', () => {
    expect(DEP).toMatch(/treeContainer\.querySelectorAll\('\.dep-managed-node'\)\.forEach\(node => \{\s*const pt = node\.dataset\.processType;\s*node\.classList\.toggle\('dep-dimmed'/);
  });

  it('a later async paint applies the stored filter', () => {
    const fn = slice(DEP, 'function paintManagedSection(host)', '  ');
    expect(fn).toMatch(/_depActiveFilter !== 'all' && \(f\.processType \|\| ''\) !== _depActiveFilter \? ' dep-dimmed' : ''/);
    expect(DEP).toContain("_depActiveFilter = activeFilter;");
    // reset on every render, so a stale filter never dims a fresh tree
    const render = slice(DEP, 'function renderDependencyTreeTab(allFlows, container, orgUrl, sid)', '  ');
    expect(render).toContain("_depActiveFilter = 'all';");
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('10 · Decline → Read again → Accept unblocks the page', () => {
  it('declining does NOT settle the gate promise', () => {
    const noBlock = TM.slice(TM.indexOf("no.addEventListener('click'"), TM.indexOf('async function sftkTermsShow'));
    expect(noComments(noBlock)).not.toContain('resolve(false)');
    expect(noBlock).toContain('sftkTermsGate().then(resolve)');
  });
  it('accepting still resolves true', () => {
    expect(TM).toContain('resolve(true)');
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('11 · a cookie refresh cannot boot past a declined gate', () => {
  it('the flag is set only after the gate passes', () => {
    const boot = PU.slice(PU.indexOf("document.addEventListener('DOMContentLoaded'"));
    expect(boot).toMatch(/if \(typeof sftkTermsGate === 'function' && !\(await sftkTermsGate\(\)\)\) return;\s*_termsOk = true;/);
    expect(PU).toContain('let _termsOk = false;');
  });
  it('the SF_SESSION_REFRESHED listener checks it before initSession', () => {
    const l = PU.slice(PU.indexOf("if (message.type === 'SF_SESSION_REFRESHED')"));
    expect(l.indexOf('if (!_termsOk) return;')).toBeGreaterThan(-1);
    expect(l.indexOf('if (!_termsOk) return;')).toBeLessThan(l.indexOf('initSession('));
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('12 · the XML inspector’s ✂ button does not keep Delete Field locked', () => {
  it('markFixed removes it', () => {
    const fn = slice(FC, 'function markFixed(componentId', '  ');
    expect(fn).toContain("xmlPanel.querySelector('.fc-xml-fix')?.remove()");
  });
  it('…because it IS counted as a fix button', () => {
    expect(FC).toContain('fc-fix-btn fc-xml-fix');
    expect(FC).toContain("document.querySelectorAll('.fc-fix-btn:not([disabled])')");
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('13 · delete-error guidance matches what is scanned now', () => {
  const fn = slice(FC, 'function _explainDeleteError(raw)', '  ');
  it('no longer claims reports are unscanned', () => {
    expect(fn).not.toMatch(/aren't scanned|aren\\'t scanned|"not scanned"/);
    expect(fn).not.toMatch(/\(a report,/);
  });
  it('names what the index may miss, consistent with the note', () => {
    expect(fn).toContain('email');
    expect(fn).toContain('criteria-based sharing rule');
    expect(FC).toContain('Email Templates and Approval Processes</strong> appear above only when that index reports');
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('14 · the fix confirm says a restore point exists where one is saved', () => {
  const fn = slice(FC, 'async function _fixOneRun(type, componentId', '  ');   // 2026-10-05: fixOne is the wrapper that carries the per-item choice (⇄ / ✂)
  it('branches on the types that snapshot first', () => {
    expect(fn).toContain("['Report', 'Layout', 'FlexiPage'].includes(type)");
    expect(fn).toContain('restore point');
    // and those really are the types that snapshot
    for (const t of ['Report', 'Layout', 'FlexiPage']) expect(FC).toContain(`_snapshotFix('${t}',`);
  });
  it('keeps the honest "no undo" for anything else', () => {
    expect(fn).toContain('There is no undo besides re-adding the field by hand.');
  });
});
