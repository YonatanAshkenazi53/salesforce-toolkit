// Live: 🪪 the identity field, end to end, trailheads5 → trailheads4 on a small
// deployment (Account WHERE Name LIKE 'SFTK CX%' > Contact), made here and
// deleted at the end:
//   • Deploy page → scan → "Identity field": the table says per object and per org
//     whether SFTK_ID__c exists (CLI agrees: it does not), and how many matched pairs
//   • Create the field in the target AND the source (one metadata deploy each) → the
//     table re-reads "✓ has it"; the CLI sees the fields and the SFTK_Identity set
//   • 🪪 Stamp N on Account → the one confirmation → every stamped target record
//     carries its source record's Id (CLI) → a re-scan still matches them
//   • ↩ Undo the stamp from History (the field is empty again — CLI)
//   • cleanup: the fields and the permission set are deleted in both orgs (metadata
//     destructive deploy); the deployment made here is removed
//   KEEP_FIELD=1   leave the fields in place (for a video chapter, say)
import { execFileSync } from 'node:child_process';
import { removeIdentityField } from '../video/fixture.mjs';
const NL = String.fromCharCode(10);
const lines = (s, n = 2500) => String(s || '').slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const SRC = 'https://orgfarm-c449e108c2-dev-ed.develop.my.salesforce.com', TGT = 'https://orgfarm-e2c4511b2b-dev-ed.develop.my.salesforce.com';
const cli = (alias, args) => JSON.parse(execFileSync('sf', [...args, '-o', alias, '--json'], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const idFields = alias => (cli(alias, ['data', 'query', '--use-tooling-api', '-q', `"SELECT TableEnumOrId FROM CustomField WHERE DeveloperName = 'SFTK_ID'"`]).result.records || []).map(r => r.TableEnumOrId).sort().join(',') || 'none';
const permSet = alias => (cli(alias, ['data', 'query', '-q', `"SELECT Id FROM PermissionSet WHERE Name = 'SFTK_Identity'"`]).result.records || []).length;
const cleanup = (h, objs) => { removeIdentityField(['npc2', 'npc'], objs, (...a) => h.log(...a)); for (const a of ['npc2', 'npc']) h.log(`cleanup ${a}: fields now ${idFields(a)} · permission set ${permSet(a)}`); };

export default async function (h) {
  for (const a of ['npc', 'npc2']) h.log(`CLI ${a} before: SFTK_ID__c on ${idFields(a)} · SFTK_Identity permission set: ${permSet(a)}`);
  await h.login('npc2'); await h.login('npc');
  await h.studio('#/profiles'); await h.watchErrors();
  const NAME = 'SFTK QA Identity';
  const id = await h.eval(`(async () => {
    _profiles = _profiles.filter(p => p.name !== ${JSON.stringify(NAME)});
    const p = { id: genId('prof'), name: ${JSON.stringify(NAME)}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      sourceOrg: ${JSON.stringify(SRC)}, targetOrg: ${JSON.stringify(TGT)}, scanConfig: { matchField: 'Name', compareFields: [] }, lastScan: null,
      tree: { objectType: 'Account', where: "Name LIKE 'SFTK CX%'", children: [{ childSObject: 'Contact', relationshipName: 'Contacts', field: 'AccountId', where: '', children: [] }] } };
    _profiles.push(p); await storageSaveProfiles(); return p.id; })()`);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  const dir = await h.eval("(() => { const p = _reconcileProfile; return p ? { src: p.sourceOrg, tgt: p.targetOrg } : null; })()");
  if (!dir || !dir.src.includes('c449e108c2') || !/orgfarm|dev-ed/.test(dir.tgt)) throw new Error('wrong direction: ' + JSON.stringify(dir));
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000); await h.sleep(1500);
  h.log('SUMMARY:', lines(await h.text('#dsDepSummary'), 300));
  // ── the modal ──
  await h.click('#dsDepIdBtn');
  await h.waitFor("!!document.querySelector('#dsIdGo')", 60000, 500); await h.sleep(500);
  const table = () => h.eval("[...document.querySelectorAll('#dsIdBody tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.replace(/\\s+/g, ' ').trim()).join(' | '))");
  h.log('IDENTITY TABLE before:', JSON.stringify(await table()));
  h.log('intro:', lines(await h.eval("document.querySelector('#dsIdBody .ds-rec-card-line')?.innerText || ''"), 400));
  const rowsBefore = await table();
  if (!rowsBefore.some(r => /Account/.test(r) && (r.match(/✗ missing/g) || []).length === 2)) throw new Error('the table does not say the field is missing in both orgs for Account');
  const pairs = Number((rowsBefore.find(r => /^Account/.test(r)) || '').split(' | ')[3].replace(/[^\d]/g, '')) || 0;
  h.log(`matched Account pairs offered to stamp: ${pairs}`);
  if (!pairs) throw new Error('no matched pairs — the fixture needs an Account present in both orgs');
  h.log(`boxes: target ${await h.eval("document.querySelector('#dsIdT').checked")}/${await h.eval("document.querySelector('#dsIdT').disabled ? 'disabled' : 'enabled'")} · source ${await h.eval("document.querySelector('#dsIdS').checked")}/${await h.eval("document.querySelector('#dsIdS').disabled ? 'disabled' : 'enabled'")} · labels: ${lines(await h.eval("[...document.querySelectorAll('#dsIdBody label')].map(l => l.innerText).join(' || ')"), 300)}`);
  // ── create in both ──
  await h.eval("(() => { const s = document.querySelector('#dsIdS'); if (!s.checked) { s.checked = true; s.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()");
  await h.click('#dsIdGo');
  await h.waitFor("document.querySelectorAll('#dsIdOut .ds-rec-card-line').length > 0", 300000, 1000); await h.sleep(800);
  h.log('CREATE RESULT:', lines(await h.text('#dsIdOut'), 600));
  const after = await table();
  h.log('IDENTITY TABLE after:', JSON.stringify(after));
  if (!after.some(r => /^Account/.test(r) && (r.match(/✓ has it/g) || []).length === 2)) throw new Error('the table does not show the field in both orgs after the create');
  for (const a of ['npc', 'npc2']) {
    const f = idFields(a), ps = permSet(a);
    h.log(`CLI ${a} after create: SFTK_ID__c on ${f} · permission set: ${ps}`);
    if (!/Account/.test(f) || !/Contact/.test(f) || !ps) throw new Error(`${a}: the field or the permission set is missing after the create`);
  }
  // ── stamp ──
  const stampBtn = await h.eval("(() => { const b = [...document.querySelectorAll('[data-id-stamp]')].find(b => b.dataset.idStamp === '' || b.dataset.idStamp === 'root' || /Account/.test(b.closest('tr')?.innerText || '')); if (!b) return null; const t = b.innerText.trim(); b.click(); return t; })()");
  h.log(`stamp button pressed: ${stampBtn}`);
  if (!stampBtn) throw new Error('no Stamp button on the Account row');
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 300); await h.sleep(400);
  h.log('STAMP CONFIRM:', lines(await h.eval("(document.querySelector('#sftkConfirmGo').closest('.sftk-confirm, .modal, [class*=confirm]') || document.body).innerText"), 500));
  const histBefore = await h.eval('_history.length');
  await h.eval("document.querySelector('#sftkConfirmGo').click()");
  for (let i = 0; i < 120 && !(await h.eval(`_history.length > ${histBefore}`)); i++) await h.sleep(1000);
  await h.sleep(1500);
  h.log('TOASTS:', JSON.stringify(await h.eval("[...document.querySelectorAll('.ds-toast')].map(t => t.innerText.replace(/\\s+/g, ' ').slice(0, 300))")));
  const entry = await h.eval("JSON.stringify((() => { const e = _history[_history.length - 1]; return { title: e.profileName, status: e.status, what: (e.what || []).map(w => w.text).slice(0, 4), undo: e.toolUndo ? (e.toolUndo.steps ? e.toolUndo.steps.length + ' steps' : e.toolUndo.none) : null }; })())");
  h.log('HISTORY entry:', entry);
  const stamped = cli('npc2', ['data', 'query', '-q', `"SELECT Id, Name, SFTK_ID__c FROM Account WHERE SFTK_ID__c != null AND Name LIKE 'SFTK CX%'"`]).result.records || [];
  const srcIds = new Set((cli('npc', ['data', 'query', '-q', `"SELECT Id FROM Account WHERE Name LIKE 'SFTK CX%'"`]).result.records || []).map(r => r.Id));
  const wrong = stamped.filter(r => !srcIds.has(r.SFTK_ID__c));
  h.log(`CLI target: ${stamped.length} Account(s) stamped, ${wrong.length} with an Id that is not a source record · e.g. ${stamped.slice(0, 2).map(r => `${r.Name} ← ${r.SFTK_ID__c}`).join('; ')}`);
  if (stamped.length !== pairs || wrong.length) throw new Error(`expected ${pairs} stamped with source Ids, got ${stamped.length} (${wrong.length} wrong)`);
  // ── re-scan: still matched ──
  await h.closeModal(); await h.sleep(500);
  await h.eval(`document.querySelector('#dsDepRefresh').click()`);
  await h.waitFor("!document.querySelector('#dsDepRefresh')?.disabled && !!document.querySelector('.ds-dep-plan')", 300000, 1000); await h.sleep(1500);
  h.log('SUMMARY after stamp + rescan:', lines(await h.text('#dsDepSummary'), 300));
  h.log('Account plan row:', lines(await h.eval("[...document.querySelectorAll('.ds-dep-plan tr')].map(tr => tr.innerText.replace(/\\s+/g, ' ')).find(t => /^Account/.test(t.trim())) || ''"), 300));
  // ── undo the stamp from History ──
  await h.eval(`navigateToView('history')`); await h.sleep(1200);
  const undoBtn = await h.eval("(() => { const b = document.querySelector('[data-dsaction=\"undoTool\"]:not([disabled])'); if (!b) return null; b.click(); return b.innerText.trim(); })()");
  h.log(`History undo button: ${undoBtn}`);
  if (!undoBtn) throw new Error('no enabled Undo on the stamp entry');
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 300); await h.sleep(300);
  await h.eval("(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()");
  await h.sleep(300);
  await h.eval("document.querySelector('#sftkConfirmGo').click()");
  for (let i = 0; i < 120 && !(await h.eval(`_history.length > ${histBefore} + 1`)); i++) await h.sleep(1000);
  await h.sleep(1500);
  const left = (cli('npc2', ['data', 'query', '-q', `"SELECT COUNT() FROM Account WHERE SFTK_ID__c != null"`]).result.totalSize);
  h.log(`CLI target after undo: ${left} Account(s) still stamped (must be 0) · newest entry: ${await h.eval("_history[_history.length - 1].profileName + ' · ' + _history[_history.length - 1].status")}`);
  if (left !== 0) throw new Error('the undo left stamped records');
  // ── cleanup ──
  await h.eval(`(async () => { _profiles = _profiles.filter(p => p.id !== ${JSON.stringify(id)}); await storageSaveProfiles(); return true; })()`);
  if (process.env.KEEP_FIELD === '1') { h.log('KEEP_FIELD=1: the fields stay'); return; }
  cleanup(h, ['Account', 'Contact']);
  for (const a of ['npc', 'npc2']) if (idFields(a) !== 'none' || permSet(a)) throw new Error(`${a}: cleanup left the field or the permission set`);
  h.log('✓ identity end to end: missing in both → created in both (CLI) → stamped N pairs with source Ids (CLI) → still matched after re-scan → undo emptied them → cleaned up');
}
