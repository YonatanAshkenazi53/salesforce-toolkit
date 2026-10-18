// Live: the Deploy page's engine options, trailheads5 → trailheads4, each proved by
// what Salesforce did (CLI) and rolled back:
//   STEP=bulk   (default) Engine = "Async — Bulk API 2.0 job": the root Inserts of the
//               Accounts tree run as one Bulk job; History marks the object "via Bulk";
//               the CLI counts the records; ↩ Roll back.
//   STEP=dup    Duplicate rules: the fixture rule docs/fixtures/dup-rule-fixture
//               (Block on insert, standard Account matching rule) is deployed to the
//               target, and one near-duplicate target Account is created ("SFTK CX
//               Berlin Labs", Berlin; the source has "SFTK CX Berlin Lab", Berlin).
//               Respect → the insert of Berlin Lab FAILS with DUPLICATES_DETECTED, named
//               in the run log; Bypass → ↻ Retry failed → it lands (CLI). ↩ Roll back,
//               then the near-duplicate and the rule are removed again.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import retryAndRollback from './retry-and-rollback.mjs';
const NL = String.fromCharCode(10);
const lines = (s, n = 2500) => String(s || '').slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const cli = (alias, args) => JSON.parse(execFileSync('sf', [...args, '-o', alias, '--json'], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const tgtCx = () => (cli('npc2', ['data', 'query', '-q', `"SELECT Name FROM Account WHERE Name LIKE 'SFTK CX%' ORDER BY Name"`]).result.records || []).map(r => r.Name);
const NAME = 'SFTK CX — Accounts tree';

async function openScanned(h) {
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('fixture profile missing');
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  const dir = await h.eval("(() => { const p = _reconcileProfile; return p ? { src: p.sourceOrg || '', tgt: p.targetOrg || '' } : null; })()");
  if (!dir || !dir.src.includes('trailheads5') || !/orgfarm|dev-ed/.test(dir.tgt)) throw new Error(`wrong direction ${JSON.stringify(dir)}`);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000); await h.sleep(1500);
  return id;
}
async function setOption(h, sel, value) {
  await h.eval(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await h.sleep(1200);
  const now = await h.eval(`document.querySelector(${JSON.stringify(sel)})?.value`);
  const stored = await h.eval(`JSON.stringify({ apiMode: _reconcileProfile.apiMode, duplicateRules: _reconcileProfile.duplicateRules })`);
  h.log(`${sel} → ${now} · stored ${stored}`);
  if (now !== value) throw new Error(`${sel} did not take ${value}`);
}
async function tickRootInserts(h) {
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="ins"]')?.click()`); await h.sleep(800);
  await h.eval(`document.querySelector('[data-dep-bulk="all"]')?.click()`); await h.sleep(600);
  h.log('SUMMARY:', lines(await h.text('#dsDepSummary'), 300));
  h.log('ticked rows:', JSON.stringify(await h.eval("[...document.querySelectorAll('#dsDepList input[type=checkbox]:checked')].map(c => c.closest('.ds-dep-row')?.querySelector('.ds-dep-key')?.textContent?.trim() || c.value).slice(0, 12)")));
}
async function run(h) {
  const histBefore = await h.eval('_history.length');
  await h.click('#dsRecRunBtn'); await h.sleep(2500);
  for (let i = 0; i < 4; i++) {
    const m = await h.modalText(1500); if (!m) break;
    h.log('CONFIRM:', m.slice(0, 700));
    await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } const b = document.querySelector('#sftkConfirmGo') || [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed|deploy|confirm|ok/i.test(b.textContent) && !b.disabled); if (b) b.click(); return !!b; })()`);
    await h.sleep(2000);
  }
  let lastLog = '';
  for (let i = 0; i < 600; i++) {
    const t = await h.eval(`document.querySelector('#dsRecProgress')?.innerText || ''`); if (t) lastLog = t;
    if (await h.eval(`_history.length > ${histBefore}`)) break;
    await h.sleep(1000);
  }
  await h.sleep(3000);
  const e = JSON.parse(await h.eval("JSON.stringify((() => { const e = _history[_history.length - 1]; return { status: e.status, summary: e.summary, errors: (e.errors || []).slice(0, 6), failed: Object.values(e.summary || {}).flatMap(s => s.failedSourceIds || []), viaBulk: Object.values(e.summary || {}).some(s => s.viaBulk) }; })())"));
  h.log('RUN LOG:', lines(lastLog, 1500));
  h.log('HISTORY entry:', JSON.stringify(e).slice(0, 900));
  return e;
}

export default async function (h) {
  const step = process.env.STEP || 'bulk';
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const before = tgtCx();
  h.log(`CLI target CX accounts before (${before.length}):`, before.join('; '));

  if (step === 'bulk') {
    await openScanned(h);
    h.log('engine options offered:', JSON.stringify(await h.eval("[...document.querySelectorAll('#dsDepApiMode option')].map(o => o.value + ':' + o.text)")));
    await setOption(h, '#dsDepApiMode', 'bulk');
    h.log(`batch box disabled under Bulk: ${await h.eval("document.querySelector('#dsDepBatch')?.disabled")}`);
    await tickRootInserts(h);
    const e = await run(h);
    const after = tgtCx();
    h.log(`CLI target CX accounts after (${after.length}): +${after.length - before.length}`);
    if (!e.viaBulk) throw new Error('History does not mark the run as written via Bulk');
    if (after.length <= before.length) throw new Error('the Bulk run inserted nothing');
    await setOption(h, '#dsDepApiMode', 'auto').catch(() => {});
    process.env.SKIP_RUN = '1';
    await retryAndRollback(h);
    const back = tgtCx();
    h.log(`CLI target CX accounts after the rollback (${back.length}): ${back.length === before.length ? 'as before ✓' : 'DIFFERENT ❌'}`);
    if (back.length !== before.length) throw new Error('the rollback did not put the target back');
    return;
  }

  if (step === 'dup') {
    // the fixture: a blocking rule and one near-duplicate in the target
    // from inside the fixture folder — its own sfdx-project.json (the repo root has none)
    // by component name: source tracking otherwise answers "No local changes to deploy" after the rule was removed through the CLI
    const dep = JSON.parse(execFileSync('sf', ['project', 'deploy', 'start', '-o', 'npc2', '-m', 'DuplicateRule:Account.SFTK_QA_Block', '--test-level', 'NoTestRun', '--ignore-conflicts', '--json'], { cwd: 'docs/fixtures/dup-rule-fixture', shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    h.log(`rule deployed: ${dep.result?.status}`);
    if (dep.result?.status !== 'Succeeded') throw new Error('the duplicate-rule fixture did not deploy: ' + JSON.stringify(dep.result?.details?.componentFailures || dep.message || '').slice(0, 300));
    const twin = cli('npc2', ['data', 'create', 'record', '-s', 'Account', '-v', `"Name='SFTK CX Berlin Labs' BillingCity='Berlin' BillingCountry='Germany'"`]).result.id;
    h.log(`near-duplicate created in the target: ${twin}`);
    let twinDeleted = false, ruleRemoved = false;
    try {
      await openScanned(h);
      h.log('duplicate-rule options offered:', JSON.stringify(await h.eval("[...document.querySelectorAll('#dsDepDupRules option')].map(o => o.value + ':' + o.text)")));
      await setOption(h, '#dsDepDupRules', 'respect');
      await tickRootInserts(h);
      const e1 = await run(h);
      // the refusal is per record (summary[obj].failedSourceIds[].error) — it must say it was a duplicate rule
      const berlin = (e1.failed || []).find(f => f.label === 'SFTK CX Berlin Lab');
      // Salesforce's own text for a duplicate-rule block is the alert text ("Use one of these records?");
      // sftk-friendly-error.js keys on exactly that and History shows the plain-language line
      const dupErr = berlin && /DUPLICATES_DETECTED|duplicate rule|Use one of these records\?/i.test(berlin.error || '') ? berlin : null;
      h.log(`Respect: status ${e1.status} · Berlin Lab refused: ${!!berlin} → "${berlin ? berlin.error : ''}" · recognisable as a duplicate rule: ${!!dupErr}`);
      h.log('all refusals:', JSON.stringify((e1.failed || []).map(f => `${f.label}: ${f.error}`)));
      await h.eval(`document.querySelector('[data-view="history"]')?.click()`); await h.sleep(1200);
      await h.eval("document.querySelectorAll('.ds-history-card details').forEach(d => { d.open = true; })");
      const card = await h.eval("(document.querySelector('.ds-history-card')?.innerText || '').replace(/\\s+/g, ' ')");
      const friendly = /duplicate rule in the target org/i.test(card), raw = /Use one of these records\?/.test(card);
      h.log(`History card: plain-words duplicate line ${friendly} · raw Salesforce text ${raw} · hint ${/Bypass for this deployment/.test(card)}`);
      h.log('CARD (full):', card.slice(0, 1800));
      h.log('entry.errors:', JSON.stringify(e1.errors));
      if (!friendly && !raw) h.log('❌ the History card does not mention the duplicate block at all');
      const mid = tgtCx();
      h.log(`CLI target after Respect: Berlin Lab present: ${mid.includes('SFTK CX Berlin Lab')} (must be false)`);
      if (!dupErr || mid.includes('SFTK CX Berlin Lab')) throw new Error('Respect did not block the near-duplicate');
      // Bypass → retry the failed record
      await h.eval(`document.querySelector('[data-view="history"]')?.click()`); await h.sleep(1200);
      await h.eval(`document.querySelector('[data-dsaction="retryFailed"]').click()`);
      await h.waitFor("_currentView === 'deploy' && !!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000); await h.sleep(2000);
      await setOption(h, '#dsDepDupRules', 'bypass');
      h.log('SUMMARY (retry):', lines(await h.text('#dsDepSummary'), 300));
      const e2 = await run(h);
      const end = tgtCx();
      // Salesforce: the bypass header passes a rule set to ALERT; a rule set to BLOCK (this fixture)
      // still blocks (learned live 2026-10-06). The honest outcome: the record is still refused, the
      // refusal is recognisable as a duplicate rule whatever its alert text, and the run says why.
      const berlin2 = (e2.failed || []).find(f => f.label === 'SFTK CX Berlin Lab');
      h.log(`Bypass against a BLOCK rule: status ${e2.status} · Berlin Lab present: ${end.includes('SFTK CX Berlin Lab')} (must be false) · refusal: "${berlin2 ? berlin2.error : ''}"`);
      h.log('entry.errors (bypass run):', JSON.stringify(e2.errors));
      if (end.includes('SFTK CX Berlin Lab')) throw new Error('a Block rule was passed — not what Salesforce does; check the fixture');
      if (!berlin2 || !/DUPLICATES_DETECTED/.test(berlin2.error || '')) throw new Error('the refusal under Bypass is not recognisable as a duplicate rule: ' + (berlin2 ? berlin2.error : 'no refusal'));
      if (!(e2.errors || []).some(x => /set to Block still blocks/.test(x))) throw new Error('the run does not say that a Block rule cannot be bypassed');
      await setOption(h, '#dsDepDupRules', 'respect').catch(() => {});
      // roll back both runs, newest first
      process.env.SKIP_RUN = '1';
      await retryAndRollback(h);
      await h.eval(`document.querySelector('[data-view="history"]')?.click()`); await h.sleep(1200);
      if (await h.eval(`!!document.querySelector('[data-dsaction="rollbackRun"]:not([disabled])')`)) await retryAndRollback(h);
    } finally {
      // safety net: whatever this test inserted today and did not roll back goes (the History of a
      // throwaway profile cannot roll it back later — learned 2026-10-06, four times)
      try {
        const mine = (cli('npc2', ['data', 'query', '-q', `"SELECT Id, Name FROM Account WHERE (Name LIKE 'SFTK CX%' OR Name LIKE 'Person SFTK CX%') AND CreatedDate = TODAY"`]).result.records || []);
        for (const r of mine) cli('npc2', ['data', 'delete', 'record', '-s', 'Account', '-i', r.Id]);
        if (mine.length) h.log(`safety net: deleted ${mine.length} account(s) this test inserted today: ${mine.map(r => r.Name).join('; ')}`);
      } catch (e) { h.log('safety net failed: ' + String(e.stdout || e.message).slice(0, 200)); }
      try { cli('npc2', ['data', 'delete', 'record', '-s', 'Account', '-i', twin]); twinDeleted = true; }
      catch (e) { const t = String(e.stdout || e.message); if (/ENTITY_IS_DELETED|not found|does not exist/i.test(t)) twinDeleted = true; else h.log('twin delete failed: ' + t.slice(0, 200)); }
      // a destructive deploy — `sf project delete source` also deletes the fixture's LOCAL file (learned 2026-10-06)
      try {
        const dir = join(process.env.TEMP || '.', `sftk-dup-cleanup-${Date.now()}`); mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.xml'), '<?xml version="1.0" encoding="UTF-8"?><Package xmlns="http://soap.sforce.com/2006/04/metadata"><version>62.0</version></Package>');
        writeFileSync(join(dir, 'destructiveChanges.xml'), '<?xml version="1.0" encoding="UTF-8"?><Package xmlns="http://soap.sforce.com/2006/04/metadata"><types><members>Account.SFTK_QA_Block</members><name>DuplicateRule</name></types><version>62.0</version></Package>');
        cli('npc2', ['project', 'deploy', 'start', '--metadata-dir', dir, '--test-level', 'NoTestRun', '--ignore-warnings']); ruleRemoved = true;
      } catch (e) { h.log('rule removal failed: ' + String(e.stdout || e.message).slice(0, 300)); }
      const rules = (cli('npc2', ['data', 'query', '-q', `"SELECT DeveloperName FROM DuplicateRule WHERE DeveloperName = 'SFTK_QA_Block'"`]).result.records || []).length;
      const back = tgtCx();
      h.log(`cleanup: twin deleted ${twinDeleted} · rule removed ${ruleRemoved} (rules named SFTK_QA_Block left: ${rules}) · CLI target CX accounts (${back.length}): ${back.length === before.length ? 'as before ✓' : 'DIFFERENT ❌ ' + back.join('; ')}`);
      if (!twinDeleted || rules || back.length !== before.length) h.log('❌ cleanup incomplete');
    }
  }
}
