// Live, npc → npc2 (owner 2026-11-26: "Remember which source record became pair … + offering to stamp using the
// external id field functionality we have"). Fixture: docs/fixtures/identity-pairs (2 Accounts, 6 Contacts in the
// source; the deployment blends Contact first name, last name and e-mail, so NO name matches after a run).
//   A  🧠 memory, no identity field in the target:
//        scan → 2 Accounts + 6 Contacts under Insert → ▶ Deploy → the target holds blended names (CLI)
//        → 🔄 Rescan all → Contact: 0 under Insert, 6 recognised from memory
//   B  🪪 stamp (STAMP=1): Identity… → create the field in the target → 🪪 Stamp the Contact and Account pairs
//        → the memory is emptied → rescan → the same pairs, now by the identity field
//        → one more Contact in the source → ▶ Deploy → the new target record carries its source Id (CLI),
//        written by the run itself → memory emptied → rescan → 7 by the identity field, 0 under Insert
//   cleanup: the field and the permission set are removed from the target, the fixture's target records deleted
//   KEEP=1   leave the target as the run left it
import { execFileSync } from 'node:child_process';
import { removeIdentityField } from '../video/fixture.mjs';
const NL = String.fromCharCode(10);
const lines = (s, n = 2500) => String(s || '').slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const cli = (alias, args) => { const out = execFileSync('sf', [...args, '-o', alias, '--json'], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); return JSON.parse(out.slice(out.indexOf('{'))); };
const q = (alias, soql) => cli(alias, ['data', 'query', '-q', `"${soql}"`]).result.records || [];
const apex = (alias, file) => cli(alias, ['apex', 'run', '-f', file]).result.success;
const NAME = 'SFTK IP — identity pairs';
const dark = async (h, on) => { await h.eval(`(() => { document.documentElement.classList.toggle('ds-dark', ${on}); if (typeof applyDarkMode === 'function') applyDarkMode(${on}); return true; })()`); await h.sleep(400); };

export default async function (h) {
  const STAMP = process.env.STAMP === '1';
  // a run that stopped half way leaves the field behind: part A needs a target without it
  if ((cli('npc2', ['data', 'query', '--use-tooling-api', '-q', `"SELECT Id FROM CustomField WHERE DeveloperName = 'SFTK_ID'"`]).result.records || []).length) removeIdentityField(['npc2'], ['Account', 'Contact'], (...a) => h.log(...a));
  h.log('fixture: target cleaned', apex('npc2', 'docs/fixtures/identity-pairs/cleanup-target.apex'), '· source seeded', apex('npc', 'docs/fixtures/identity-pairs/seed-source.apex'));
  const srcCon = q('npc', "SELECT Id, FirstName, LastName FROM Contact WHERE Account.Name LIKE 'SFTK IP %' ORDER BY Title");
  h.log(`source: ${srcCon.length} Contacts — ${srcCon.map(c => c.FirstName + ' ' + c.LastName).join(', ')}`);
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/identity-pairs/profile.json');
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('fixture deployment missing');
  // an imported policy has no salt (it is machine-local): mint it as the builder does on open
  await h.eval(`(async () => { const p = _profiles.find(x => x.id === ${JSON.stringify(id)}); if (!p.piiSalt) { const b = new Uint8Array(16); crypto.getRandomValues(b); p.piiSalt = Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); await storageSaveProfiles(); } return true; })()`);
  const idle = () => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled && !/⏳/.test(document.querySelector('#dsDepScanAll')?.textContent || '') && !/⏳/.test(document.querySelector('#dsDepRescanAll')?.textContent || '')", 600000, 1000);
  const state = () => h.eval(`(() => { const p = _profiles.find(x => x.id === ${JSON.stringify(id)}); const ls = (p && p.lastScan) || {}; const one = s => s ? { ins: (s.missingInTarget || []).length, same: (s.identical || []).length, chg: (s.changed || []).length, extra: (s.onlyInTarget || []).length, memory: s.memoryMatched || 0, stamp: s.stampMatched || 0, field: s.stampField || null } : null;
    return JSON.stringify({ Account: one(ls), Contact: one((ls.children || {})['0']), remembered: Object.keys(((p && p.matchMemory) || {})[_orgKey(p.targetOrg)] || {}).length }); })()`);
  const rescan = async () => { await h.eval(`document.querySelector('#dsDepRescanAll').click()`); await h.waitFor("!!document.querySelector('#dsDepRefresh')?.disabled", 30000, 200).catch(() => {}); await idle(); await h.sleep(1500); return JSON.parse(await state()); };
  const forget = () => h.eval(`(async () => { const p = _profiles.find(x => x.id === ${JSON.stringify(id)}); delete p.matchMemory; await storageSaveProfiles(); return true; })()`);
  const tickInserts = async () => {
    const objs = await h.eval(`[...document.querySelectorAll('[data-dep-obj]')].map(b => b.dataset.depObj).filter((v, i, a) => v !== undefined && a.indexOf(v) === i)`);
    for (const o of objs) { await h.eval(`(() => { const b = document.querySelector('[data-dep-obj="${o}"][data-dep-tab="ins"]'); if (b) b.click(); })()`); await h.sleep(500); await h.eval(`(() => { const b = document.querySelector('[data-dep-bulk="all"]'); if (b && !b.disabled) b.click(); return true; })()`); await h.sleep(400); }
    return lines(await h.text('#dsDepSummary'), 300);
  };
  const deploy = async () => {
    const histBefore = await h.eval('_history.length');
    if (await h.eval(`document.querySelector('#dsRecRunBtn')?.disabled`)) throw new Error('▶ Deploy is disabled');
    await h.click('#dsRecRunBtn'); await h.sleep(2500);
    for (let i = 0; i < 4; i++) { const m = await h.modalText(500); if (!m) break; h.log('  DIALOG:', lines(m, 400)); await h.eval(`(() => { const b = document.querySelector('#dsRecDelOk') || [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed|deploy|continue/i.test(b.textContent)); if (b) b.click(); })()`); await h.sleep(2000); }
    for (let i = 0; i < 600; i++) { if (await h.eval(`_history.length > ${histBefore}`)) break; await h.sleep(1000); }
    await h.sleep(4000);
    const idLines = await h.eval(`[...document.querySelectorAll('[class*="ds-prog"]')].map(e => e.innerText.trim()).filter(t => /^(🧠|🪪)/.test(t) && t.length < 600).filter((t, i, a) => a.indexOf(t) === i)`);
    h.log('  RUN verdict:', lines(await h.text('.ds-prog-verdict'), 300));
    for (const l of idLines) h.log('  RUN says:', lines(l, 500));
    const e = JSON.parse(await h.eval(`JSON.stringify((e => ({ status: e.status, pairsKept: JSON.stringify(e).includes('idPairs') }))(_history[_history.length - 1] || {}))`));
    h.log(`  History entry: ${e.status} · pairs left inside the entry: ${e.pairsKept}`);
    if (e.status !== 'success') h.log('  ERRORS:', await h.eval(`JSON.stringify(((_history[_history.length - 1] || {}).errors || []).slice(0, 8)).slice(0, 1800)`), '| LOG:', lines(await h.eval(`[...document.querySelectorAll('.ds-prog-err')].map(e => e.innerText).join(String.fromCharCode(10))`), 1500));
    if (e.pairsKept) throw new Error('the History entry still carries idPairs');
    return idLines;
  };

  // ── A. memory ──
  await h.eval(`window.runProfile(${JSON.stringify(id)})`);
  await h.waitFor("!!document.querySelector('.ds-dep-plan')", 300000, 1000);
  await h.waitFor(`(() => { const n = [...document.querySelectorAll('.ds-dtree-node')]; return n.length > 1 && !n.some(x => /not counted yet/.test(x.innerText)); })()`, 600000, 1500).catch(() => {});
  await idle(); await h.sleep(1500);
  const dir = await h.eval("(() => { const p = _reconcileProfile; return p ? { src: p.sourceOrg, tgt: p.targetOrg } : null; })()");
  if (!dir || !dir.src.includes('c449e108c2') || !dir.tgt.includes('e2c4511b2b')) throw new Error('wrong direction: ' + JSON.stringify(dir));
  const s0 = JSON.parse(await state()); h.log('A1 first scan:', JSON.stringify(s0));
  if (s0.Account.ins !== 2 || s0.Contact.ins !== 6) throw new Error('the fixture is not 2 Accounts + 6 Contacts under Insert');
  h.log('A2 ticked:', await tickInserts());
  const said = await deploy();
  const tgtCon = q('npc2', "SELECT Id, FirstName, LastName FROM Contact WHERE Account.Name LIKE 'SFTK IP %' ORDER BY Title");
  const srcNames = new Set(srcCon.map(c => c.FirstName + ' ' + c.LastName));
  h.log(`A3 CLI target: ${tgtCon.length} Contacts, ${tgtCon.filter(c => srcNames.has(c.FirstName + ' ' + c.LastName)).length} with a source name (blended otherwise)`);
  if (tgtCon.length !== 6) throw new Error('expected 6 Contacts in the target');
  if (!said.some(l => /^🧠/.test(l))) throw new Error('the run did not say what it remembered');
  const s1 = await rescan(); h.log('A4 after 🔄 Rescan all:', JSON.stringify(s1));
  if (s1.Contact.ins !== 0 || s1.Contact.memory !== 6 || s1.Contact.same + s1.Contact.chg !== 6) throw new Error('the Contacts written by the run are not recognised from memory');
  if (s1.Account.ins !== 0) throw new Error('Accounts listed under Insert again');
  h.log('   tree lines:', JSON.stringify(await h.eval("[...document.querySelectorAll('.ds-dtree-idn')].map(e => e.closest('.ds-dtree-node').querySelector('.ds-dtree-name').innerText.split(String.fromCharCode(10))[0] + ': ' + e.innerText)")));
  await h.eval("document.querySelector('.ds-dtree-idn')?.scrollIntoView({ block: 'center' })"); await h.sleep(400);
  await h.shot(h.shots + '/ip-memory.png'); await dark(h, true); await h.shot(h.shots + '/ip-memory-dark.png'); await dark(h, false);
  h.log('✓ A: 6 blended Contacts recognised from memory; nothing under Insert');

  if (STAMP) {
    // ── B. stamp ──
    await h.click('#dsDepIdBtn');
    await h.waitFor("!!document.querySelector('#dsIdGo')", 60000, 500); await h.sleep(500);
    const table = () => h.eval("[...document.querySelectorAll('#dsIdBody tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.replace(/\\s+/g, ' ').trim()).join(' | '))");
    h.log('B1 identity table:', JSON.stringify(await table()));
    await h.eval("(() => { const s = document.querySelector('#dsIdS'); if (s && s.checked) { s.checked = false; s.dispatchEvent(new Event('change', { bubbles: true })); } const t = document.querySelector('#dsIdT'); if (t && !t.checked) { t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()");
    await h.click('#dsIdGo');
    for (let i = 0; i < 3; i++) { await h.sleep(1500); if (await h.eval("!!document.querySelector('#sftkConfirmGo')")) { await h.eval("(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } document.querySelector('#sftkConfirmGo').click(); return true; })()"); break; } }
    await h.waitFor("document.querySelectorAll('#dsIdOut .ds-rec-card-line').length > 0", 300000, 1000); await h.sleep(1000);
    h.log('B2 create:', lines(await h.text('#dsIdOut'), 500));
    h.log('   table:', JSON.stringify(await table()));
    for (const obj of ['Contact', 'Account']) {
      const histBefore = await h.eval('_history.length');
      const btn = await h.eval(`(() => { const b = [...document.querySelectorAll('[data-id-stamp]')].find(b => (b.closest('tr')?.innerText || '').replace(/^[^A-Za-z]+/, '').startsWith('${obj}')); if (!b) return null; const t = b.innerText.trim(); b.click(); return t; })()`);
      if (!btn) throw new Error(`no Stamp button on the ${obj} row`);
      await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 300); await h.sleep(400);
      await h.eval("document.querySelector('#sftkConfirmGo').click()");
      for (let i = 0; i < 120 && !(await h.eval(`_history.length > ${histBefore}`)); i++) await h.sleep(1000);
      await h.sleep(1500);
      h.log(`B3 ${obj}: pressed "${btn}"`);
      if (!(await h.eval("!!document.querySelector('#dsIdGo')"))) { await h.click('#dsDepIdBtn'); await h.waitFor("!!document.querySelector('#dsIdGo')", 60000, 500); await h.sleep(800); }
    }
    const srcIds = new Set(srcCon.map(c => c.Id));
    const stamped = q('npc2', "SELECT Id, SFTK_ID__c FROM Contact WHERE Account.Name LIKE 'SFTK IP %' AND SFTK_ID__c != null");
    h.log(`   CLI target: ${stamped.length} Contacts stamped, ${stamped.filter(r => !srcIds.has(r.SFTK_ID__c)).length} with an Id that is not their source record's`);
    if (stamped.length !== 6 || stamped.some(r => !srcIds.has(r.SFTK_ID__c))) throw new Error('the remembered pairs were not stamped');
    await h.closeModal(); await h.sleep(500);
    await forget();
    const s2 = await rescan(); h.log('B4 memory emptied, rescan:', JSON.stringify(s2));
    if (s2.Contact.ins !== 0 || s2.Contact.stamp !== 6 || s2.Account.stamp !== 2) throw new Error('the stamped records are not recognised by the identity field');
    await h.eval("document.querySelector('.ds-dtree-idn')?.scrollIntoView({ block: 'center' })"); await h.sleep(400);
    await h.shot(h.shots + '/ip-stamp.png'); await dark(h, true); await h.shot(h.shots + '/ip-stamp-dark.png'); await dark(h, false);
    // one more source Contact: the run itself must stamp it
    const alder = q('npc', "SELECT Id FROM Account WHERE Name = 'SFTK IP Alder'")[0].Id;
    const newId = cli('npc', ['data', 'create', 'record', '-s', 'Contact', '-v', `"AccountId=${alder} FirstName=Nia LastName=Brandt Title='SFTK IP 7'"`]).result.id;
    const s3 = await rescan(); h.log('B5 one more source Contact:', JSON.stringify(s3.Contact));
    if (s3.Contact.ins !== 1) throw new Error('the new Contact is not the one record under Insert');
    h.log('   ticked:', await tickInserts());
    const said2 = await deploy();
    const got = q('npc2', `SELECT Id, FirstName, LastName, SFTK_ID__c FROM Contact WHERE SFTK_ID__c = '${newId}'`);
    h.log(`B6 CLI target: ${got.length} Contact carrying the new source Id — named ${got.map(r => r.FirstName + ' ' + r.LastName).join(', ') || '—'} (source: Nia Brandt)`);
    if (got.length !== 1) throw new Error('the run did not stamp the record it created');
    if (!said2.some(l => /^🪪/.test(l) && /Contact/.test(l) && /carries/.test(l))) throw new Error('the run did not say it stamped');
    await forget();
    const s4 = await rescan(); h.log('B7 memory emptied, rescan:', JSON.stringify(s4));
    if (s4.Contact.ins !== 0 || s4.Contact.stamp !== 7) throw new Error('7 Contacts by the identity field expected');
    h.log('✓ B: stamped pairs and a record stamped by the run itself are recognised with an empty memory');
  }
  if (process.env.KEEP === '1') { h.log('KEEP=1: the target stays as it is'); return; }
  if (STAMP) removeIdentityField(['npc2'], ['Account', 'Contact'], (...a) => h.log(...a));
  h.log('cleanup: target', apex('npc2', 'docs/fixtures/identity-pairs/cleanup-target.apex'), '· source re-seeded', apex('npc', 'docs/fixtures/identity-pairs/seed-source.apex'));
}
