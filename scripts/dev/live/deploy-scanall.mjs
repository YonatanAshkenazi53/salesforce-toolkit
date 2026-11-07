// Live, read-only in the orgs (npc → npc2, the Accounts-tree fixture): (user 2026-11-07) "i want to scan all the
// childrens and parents when i open the deployment, in case a diff matching field is selected, rescan the object and
// its childs", "i want a rescan all button here", "also the refresh state button should do what i just said".
//   1. open the deployment, press nothing → every card counted; the parents' alignment check runs
//   2. 🔄 Rescan all → every object read again (each child's runAt moves)
//   3. Contact's key changed from its card → Contact (and its children) read again, the other children not
const NL = String.fromCharCode(10);
const dump = async (h, sel, n = 1500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const dark = async (h, on) => { await h.eval(`(() => { if (!document.getElementById('noTrans')) { const st = document.createElement('style'); st.id = 'noTrans'; st.textContent = '*{transition:none!important}'; document.head.appendChild(st); } document.documentElement.classList.toggle('ds-dark', ${on}); return true; })()`); await h.sleep(500); };
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Accounts tree';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('fixture profile missing');
  const runAts = () => h.eval(`(() => { const p = _profiles.find(x => x.id === ${JSON.stringify(id)}); const ls = p && p.lastScan; return JSON.stringify({ root: ls && ls.runAt, kids: Object.fromEntries(Object.entries((ls && ls.children) || {}).map(([k, v]) => [k, v && v.runAt])) }); })()`);
  const notCounted = () => h.eval(`[...document.querySelectorAll('.ds-dtree-node')].filter(n => /not counted yet/.test(n.innerText)).map(n => n.querySelector('.ds-dtree-name')?.innerText.split(String.fromCharCode(10))[0])`);
  const idle = () => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled && !/⏳/.test(document.querySelector('#dsDepScanAll')?.textContent || '') && !/⏳/.test(document.querySelector('#dsDepRescanAll')?.textContent || '')", 600000, 1000);
  // 1. open — nothing pressed
  const t0 = Date.now();
  await h.eval(`window.runProfile(${JSON.stringify(id)})`);
  await h.waitFor("!!document.querySelector('.ds-dep-plan')", 300000, 1000);
  await h.waitFor(`(() => { const n = [...document.querySelectorAll('.ds-dtree-node')]; return n.length > 1 && !n.some(x => /not counted yet/.test(x.innerText)); })()`, 600000, 1500).catch(() => {});
  await idle(); await h.sleep(1500);
  h.log(`1 opened, nothing pressed — ${Math.round((Date.now() - t0) / 1000)} s; cards not counted:`, JSON.stringify(await notCounted()));
  h.log('  scans:', await runAts());
  h.log('  plan:', await dump(h, '.ds-dep-plan', 1400));
  await h.eval(`document.querySelector('#dsDepRescanAll')?.scrollIntoView({ block: 'center' })`); await h.sleep(400);
  await h.shot(h.shots + '/sa-1-open.png');
  await dark(h, true); await h.shot(h.shots + '/sa-1-open-dark.png'); await dark(h, false);
  // 2. 🔄 Rescan all
  const before2 = JSON.parse(await runAts());
  await h.eval(`document.querySelector('#dsDepRescanAll').click()`);
  await h.waitFor("!!document.querySelector('#dsDepRefresh')?.disabled", 30000, 200).catch(() => h.log('  (the re-read was not seen starting)'));
  await idle(); await h.sleep(1500);
  const after2 = JSON.parse(await runAts());
  const moved = o => Object.keys(o.kids).filter(k => before2.kids[k] !== o.kids[k]);
  h.log(`2 🔄 Rescan all — root re-read: ${before2.root !== after2.root}; children re-read: ${moved(after2).length} of ${Object.keys(after2.kids).length}`);
  // 3. Contact's key from its card → Contact and its children only
  const cKey = await h.eval(`(() => { const b = [...document.querySelectorAll('[data-tree-match]')].find(x => /^Contact/.test(x.closest('.ds-dtree-node')?.querySelector('.ds-dtree-name')?.innerText || '')); return b ? b.dataset.treeMatch : null; })()`);
  const before3 = JSON.parse(await runAts());
  await h.eval(`(() => { const d = document.querySelector('#dsDepTree details'); if (d) d.open = true; document.querySelector('[data-tree-match="${cKey}"]').click(); return true; })()`);
  await h.waitFor("!!document.querySelector('#dsMatchTestBtn')", 90000, 500);
  await h.eval(`(() => { const r = document.querySelector('input[name="dsMatchStrat"][value="composite"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await h.sleep(800);
  await h.eval(`(() => { const s = document.querySelector('[data-match-comp="1"]'); const o = [...s.options].find(x => x.value === 'Title') || [...s.options].find(x => x.value); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await h.sleep(800);
  await h.eval(`document.querySelector('#dsRecSave').click()`);
  await h.waitFor("!!document.querySelector('#dsDepRefresh')?.disabled", 30000, 200).catch(() => h.log('  (the re-read was not seen starting)'));
  await idle(); await h.sleep(1500);
  const after3 = JSON.parse(await runAts());
  const moved3 = Object.keys(after3.kids).filter(k => before3.kids[k] !== after3.kids[k]);
  h.log(`3 Contact (${cKey}) key changed — root re-read: ${before3.root !== after3.root}; children re-read: ${JSON.stringify(moved3)}`);
  h.log('  Contact card:', await h.eval(`(document.querySelector('[data-tree-match="${cKey}"]')?.closest('.ds-dtree-node')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 260)`));
  // 4. 🔄 Refresh state reads everything too
  const before4 = JSON.parse(await runAts());
  await h.eval(`document.querySelector('#dsDepRefresh').click()`);
  await h.waitFor("!!document.querySelector('#dsDepRefresh')?.disabled", 30000, 200).catch(() => {});
  await idle(); await h.sleep(1000);
  const after4 = JSON.parse(await runAts());
  h.log(`4 🔄 Refresh state — root re-read: ${before4.root !== after4.root}; children re-read: ${Object.keys(after4.kids).filter(k => before4.kids[k] !== after4.kids[k]).length} of ${Object.keys(after4.kids).length}`);
  await h.eval(`document.querySelector('#dsDepTree')?.scrollIntoView({ block: 'start' })`); await h.sleep(400);
  await h.shot(h.shots + '/sa-2-tree.png');
}
