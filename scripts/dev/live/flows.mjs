// Live: the Flows tab end to end on one fixture flow — list, ⬇ Backup (a real
// download, caught through CDP), 🗑 Delete the Draft version (every gate:
// subflow check, the permanent-delete confirmation with its box), then
// 📥 Restore the same zip as a new Draft — the CLI tells the truth after each step.
//   FLOW=<API name>   the flow whose newest DRAFT version is used (default SFTK_AV_Test_C,
//                     docs/fixtures/apiver-fixture: Draft at API 58)
//   STEP=list         stop after the list (nothing written)
//   STEP=backup       list + backup only
//   ORG=npc           which org (default npc = trailheads5)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
const NL = String.fromCharCode(10);
const FLOW = process.env.FLOW || 'SFTK_AV_Test_C';
const ORG = process.env.ORG || 'npc';
const STEP = process.env.STEP || 'all';
const lines = (s, n = 2500) => String(s || '').slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');

// CLI truth: the versions of FLOW as the org holds them now
function cliVersions() {
  const out = execFileSync('sf', ['data', 'query', '-o', ORG, '--use-tooling-api', '--json', '-q',
    `"SELECT Id, VersionNumber, Status, ApiVersion FROM Flow WHERE Definition.DeveloperName = '${FLOW}' ORDER BY VersionNumber"`],
    { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return (JSON.parse(out).result.records || []).map(r => ({ id: r.Id, v: r.VersionNumber, status: r.Status, api: r.ApiVersion }));
}
const show = vs => vs.map(x => `v${x.v} ${x.status} API ${x.api}`).join(', ') || 'none';

export default async function (h) {
  await h.login(ORG);
  await h.popup('flows');
  await h.watchErrors();
  await h.waitFor("document.querySelector('#flowList') && document.querySelector('#flowList').style.display !== 'none' && document.querySelectorAll('.flow-group').length > 0", 240000, 1000);
  await h.sleep(1500);
  const groups = await h.eval("document.querySelectorAll('.flow-group').length");
  const subflowMarks = await h.eval("[...document.querySelectorAll('.flow-group .subflow-icon')].filter(e => e.textContent.trim() === '🔗').length");
  h.log(`LIST: ${groups} flow group(s), ${subflowMarks} with a 🔗 subflow mark`);
  // search narrows the list to the fixture flow
  await h.eval(`(() => { const i = document.querySelector('#searchInput'); i.value = ${JSON.stringify(FLOW.replace(/_/g, ' '))}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.sleep(800);
  let visible = await h.eval("[...document.querySelectorAll('.flow-group')].map(g => g.dataset.label)");
  if (!visible.length) {   // labels and API names differ in some fixtures — search by label words
    await h.eval(`(() => { const i = document.querySelector('#searchInput'); i.value = 'SFTK'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await h.sleep(800);
    visible = await h.eval("[...document.querySelectorAll('.flow-group')].map(g => g.dataset.label)");
  }
  h.log('SEARCH shows:', JSON.stringify(visible.slice(0, 8)));
  // the dependency scan has to finish first: a backup with the tree option and the delete's subflow check both read it
  await h.waitFor("typeof metadataScanState !== 'undefined' && metadataScanState !== 'scanning'", 300000, 1000);
  h.log(`dependency scan: ${await h.eval('metadataScanState')} · tree option ticked: ${await h.eval("!!document.querySelector('#backupWithSubflows')?.checked")}`);
  const before = cliVersions();
  h.log(`CLI before: ${FLOW} → ${show(before)}`);
  const draft = [...before].reverse().find(x => x.status === 'Draft');
  if (!draft) throw new Error(`${FLOW} has no Draft version to work on — fixture missing?`);
  // open the group that holds the Draft and read its rows
  const rowInfo = await h.eval(`(() => {
    const row = document.querySelector('.version-row[data-id="${draft.id}"]'); if (!row) return null;
    const group = row.closest('.flow-group'); const vc = group.querySelector('.versions-container'); vc.style.display = '';
    return { label: group.dataset.label, rows: [...group.querySelectorAll('.version-row')].map(r => r.innerText.replace(/\\s+/g, ' ').trim()) };
  })()`);
  if (!rowInfo) throw new Error(`the Draft version ${draft.id} is not in the list`);
  h.log(`GROUP "${rowInfo.label}":`, JSON.stringify(rowInfo.rows));
  if (STEP === 'list') return;

  // ── ⬇ Backup: a real download into a folder of ours ──
  const dlDir = resolve('dist/qa/downloads'); mkdirSync(dlDir, { recursive: true });
  await h.cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true }, null);
  const downloads = [];
  h.onEvent(m => { if (m.method === 'Browser.downloadProgress' && m.params.state === 'completed') downloads.push(m.params.guid); });
  await h.eval(`(() => { document.querySelector('.mode-btn[data-mode="backup"]').click(); return true; })()`);
  await h.sleep(500);
  await h.eval(`(() => { const cb = document.querySelector('.version-row[data-id="${draft.id}"] .version-checkbox'); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await h.sleep(400);
  h.log('selection summary:', await h.text('#selectionSummary'));
  for (const f of readdirSync(dlDir)) if (/^SF_Backup_.*\.zip$/.test(f)) rmSync(join(dlDir, f), { force: true });   // same name as last time otherwise
  const beforeFiles = new Set(readdirSync(dlDir));
  h.log(`backup button: "${await h.eval("document.querySelector('#backupBtn').textContent.trim()")}" disabled=${await h.eval("document.querySelector('#backupBtn').disabled")} shown=${await h.eval("document.querySelector('#backupBtn').style.display !== 'none'")}`);
  await h.click('#backupBtn');
  for (let i = 0; i < 120; i++) {
    if (await h.eval("!!document.querySelector('.toast-success, .toast-error') || !!document.querySelector('#modalConfirm')")) break;
    if (i % 10 === 9) h.log(`  waiting… progress: "${await h.eval("document.querySelector('#scanProgressText')?.innerText || ''")}" dialogs: ${JSON.stringify(h.dialogs.slice(-2))}`);
    await h.sleep(500);
  }
  if (await h.eval("!!document.querySelector('#modalConfirm')")) { h.log('BACKUP DIALOG:', lines(await h.text('#modalBox'))); await h.click('#modalConfirm'); await h.waitFor("!!document.querySelector('.toast-success, .toast-error')", 60000, 500); }
  h.log('BACKUP toast:', lines(await h.eval("[...document.querySelectorAll('.result-toast')].map(t => t.innerText).join(' | ')")));
  for (let i = 0; i < 60 && !downloads.length; i++) await h.sleep(500);
  h.log(`download events completed: ${downloads.length}`);
  await h.sleep(1000);
  const newFiles = readdirSync(dlDir).filter(f => !beforeFiles.has(f) && /\.zip$/i.test(f));
  if (!newFiles.length) throw new Error('no backup zip landed in ' + dlDir);
  const zip = join(dlDir, newFiles.sort((a, b) => statSync(join(dlDir, b)).mtimeMs - statSync(join(dlDir, a)).mtimeMs)[0]);
  h.log(`BACKUP FILE: ${zip} (${statSync(zip).size} bytes)`);
  if (STEP === 'backup') return;

  // ── 🗑 Delete the Draft version ──
  await h.eval(`(() => { document.querySelector('.mode-btn[data-mode="delete"]').click(); return true; })()`);
  await h.sleep(500);
  const ticked = await h.eval(`(() => { const cb = document.querySelector('.version-row[data-id="${draft.id}"] .version-checkbox'); if (!cb) return 'row gone'; if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); } return 'ticked'; })()`);
  h.log('delete mode, Draft row:', ticked, '·', await h.text('#selectionSummary'));
  await h.click('#deleteBtn');
  // the gates come in order; log each dialog and take the way through that keeps the walk honest
  for (let i = 0; i < 6; i++) {
    await h.waitFor("!!document.querySelector('#sftkConfirmGo') || !!document.querySelector('#modalConfirm') || !!document.querySelector('#modalBox .btn')", 90000, 500);
    await h.sleep(600);
    if (await h.eval("!!document.querySelector('#sftkConfirmGo')")) break;
    const text = lines(await h.text('#modalBox'));
    h.log(`GATE ${i + 1}:`, text);
    // the "scan before delete?" question: scan (the honest way); any other gate: its primary button
    const pressed = await h.eval(`(() => {
      const btns = [...document.querySelectorAll('#modalBox button')];
      const pick = btns.find(b => /scan now|scan first|run the scan|🔗 scan/i.test(b.innerText)) || btns.find(b => b.id === 'modalConfirm') || btns.find(b => /proceed|continue|delete/i.test(b.innerText) && !/cancel/i.test(b.innerText));
      if (!pick) return null; const t = pick.innerText.trim(); pick.click(); return t; })()`);
    h.log('  pressed:', pressed);
    if (!pressed) throw new Error('a gate with no button to press: ' + text);
    await h.sleep(800);
  }
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 120000, 500);
  await h.sleep(500);
  h.log('FINAL CONFIRM:', lines(await h.eval("(document.querySelector('#sftkConfirmGo').closest('.sftk-confirm, .modal, [class*=confirm]') || document.body).innerText")));
  const goDisabledBefore = await h.eval("document.querySelector('#sftkConfirmGo').disabled");
  await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
  const word = await h.eval("document.querySelector('#sftkConfirmWord') ? (document.querySelector('#sftkConfirmWord').placeholder || document.querySelector('#sftkConfirmWord').dataset.word || '') : ''");
  if (word) h.log('typed word asked:', word);
  h.log(`Go disabled before the box: ${goDisabledBefore}, after: ${await h.eval("document.querySelector('#sftkConfirmGo').disabled")}`);
  await h.click('#sftkConfirmGo');
  await h.waitFor("!document.querySelector('#sftkConfirmGo') && /deleted|failed/i.test(document.body.innerText)", 120000, 1000);
  await h.sleep(2500);
  h.log('AFTER DELETE page says:', lines(await h.eval("[...document.querySelectorAll('.result-toast, #modalBox, .deletion-summary, .result-summary')].map(e => e.innerText).join(' | ')"), 1500));
  const afterDel = cliVersions();
  h.log(`CLI after delete: ${show(afterDel)} — Draft v${draft.v} ${afterDel.some(x => x.id === draft.id) ? 'STILL THERE ❌' : 'gone ✓'}`);
  if (afterDel.some(x => x.id === draft.id)) throw new Error('the Draft version was not deleted');
  if (afterDel.length !== before.length - 1) throw new Error(`expected ${before.length - 1} versions, the org has ${afterDel.length}`);
  await h.closeModal().catch(() => {});

  // ── 📥 Restore the zip as a new Draft ──
  await h.eval(`(() => { document.querySelector('.mode-btn[data-mode="restore"]').click(); return true; })()`);
  await h.sleep(500);
  const { result: { objectId } } = await h.cdp('Runtime.evaluate', { expression: "document.querySelector('#restoreFileInput')" });
  await h.cdp('DOM.setFileInputFiles', { objectId, files: [zip] });
  await h.eval("(() => { document.querySelector('#restoreFileInput').dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
  await h.waitFor("document.querySelector('#restorePreview') && document.querySelector('#restorePreview').style.display !== 'none' && document.querySelector('#restorePreview').innerText.length > 20", 30000, 500);
  h.log('RESTORE PREVIEW:', lines(await h.text('#restorePreview'), 1200));
  await h.click('#restoreActionBtn');
  await h.waitFor("!!document.querySelector('#sftkConfirmGo') || !!document.querySelector('#modalConfirm') || /Restored|restored|new Draft/i.test(document.body.innerText)", 90000, 500);
  if (await h.eval("!!document.querySelector('#sftkConfirmGo')")) {
    h.log('RESTORE CONFIRM:', lines(await h.eval("(document.querySelector('#sftkConfirmGo').closest('.sftk-confirm, .modal, [class*=confirm]') || document.body).innerText")));
    await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
    await h.click('#sftkConfirmGo');
  } else if (await h.eval("!!document.querySelector('#modalConfirm')")) { h.log('RESTORE DIALOG:', lines(await h.text('#modalBox'))); await h.click('#modalConfirm'); }
  await h.waitFor("/Restored|restored|new Draft|failed|Failed/i.test(document.body.innerText) && !document.querySelector('#restoreActionBtn:disabled')", 180000, 1000);
  await h.sleep(2000);
  h.log('AFTER RESTORE page says:', lines(await h.eval("[...document.querySelectorAll('.result-toast, #modalBox, #restorePreview, #restorePanel')].map(e => e.innerText).join(' | ')"), 1500));
  const afterRes = cliVersions();
  const newest = afterRes[afterRes.length - 1];
  h.log(`CLI after restore: ${show(afterRes)}`);
  // the page and the org must agree (QA 2026-10-06: the page said "0 restored, 1 failed" while the CLI showed the new Draft)
  const pageSaid = await h.eval("document.body.innerText");
  const saidFailed = /(\d+) failed/.exec(pageSaid), saidRestored = /(\d+) restored/.exec(pageSaid);
  h.log(`page says restored ${saidRestored ? saidRestored[1] : '?'} · failed ${saidFailed ? saidFailed[1] : '?'}`);
  if (saidFailed && Number(saidFailed[1]) > 0 && afterRes.length === before.length) throw new Error('the page reports a failed restore but the org holds the restored Draft — a wrong claim');
  if (afterRes.length !== before.length) throw new Error(`expected ${before.length} versions after the restore, the org has ${afterRes.length}`);
  if (!newest || newest.status !== 'Draft') throw new Error('the restored version is not a Draft');
  if (String(newest.api) !== String(draft.api)) throw new Error(`the restored Draft is at API ${newest.api}, the backup was at ${draft.api}`);
  h.log(`✓ end to end: v${draft.v} Draft backed up, deleted, restored as v${newest.v} Draft at API ${newest.api}`);
}
