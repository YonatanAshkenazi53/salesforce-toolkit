// Deploy page: every card in About folds and is remembered; a parent row says its match field; the ✏ dialog
// lists fields; choosing one writes every lookup and re-reads. Then the popup's Field Cleaner history cards.
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const id = await h.eval(`_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id`);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`); await waitScanned(h);
  await h.waitFor("!!document.querySelector('details[data-fold=\"parents\"] .ds-ordstep') || !!document.querySelector('.ds-dep-parents-synced')", 120000, 500); await h.sleep(1500);
  const folds = () => h.eval(`JSON.stringify([...document.querySelectorAll('details.ds-dep-fold[data-fold]')].map(d => d.dataset.fold + ':' + (d.open ? 'open' : 'folded')))`);
  h.log('1. folds:', await folds());
  await h.eval(`(() => { document.querySelector('details[data-fold="tree"]').open = false; return true; })()`); await h.sleep(400);
  await h.eval(`document.getElementById('dsDepFoldAll').click()`); await h.sleep(400);
  h.log('2. after Fold all:', await folds(), '| remembered:', await h.eval('JSON.stringify(_settings.deployFolds)'));
  await h.eval(`document.getElementById('dsDepUnfoldAll').click()`); await h.sleep(400);
  const rows = await h.eval(`[...document.querySelectorAll('.ds-ordstep .ds-dep-pmatch')].map(x => x.innerText.replace(/\s+/g, ' ').trim()).slice(0, 4)`);
  h.log('3. parent rows say:', JSON.stringify(rows));
  await h.eval(`(() => { document.querySelector('details[data-fold="parents"]').scrollIntoView({ block: 'start' }); return true; })()`); await h.sleep(300);
  await h.shot('dist/qa/shots/parents-matchedby.png');
  const btn = await h.eval(`(() => { const b = [...document.querySelectorAll('[data-dep-pmatch-edit]')].find(x => x.dataset.depPmatchEdit === 'Product2') || [...document.querySelectorAll('[data-dep-pmatch-edit]')].find(x => x.dataset.depPmatchEdit === 'User') || document.querySelector('[data-dep-pmatch-edit]'); if (!b) return null; b.click(); return b.dataset.depPmatchEdit; })()`);
  await h.waitFor("!!document.getElementById('dsDepPmatchSel')", 60000, 300); await h.sleep(400);
  h.log('4. dialog for', btn + ':', (await h.eval("document.querySelector('#dsModalBox')?.innerText || ''")).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ').slice(0, 500));
  const opts = await h.eval(`[...document.querySelectorAll('#dsDepPmatchSel option')].map(o => o.textContent).slice(0, 6)`);
  h.log('4. options:', JSON.stringify(opts));
  await h.eval(`(() => { const s = document.getElementById('dsDepPmatchSel'); const o = [...s.options].find(o => /Ext|Code|Number|Id__c|Email/i.test(o.value)) || s.options[1]; s.value = o.value; return o.value; })()`);
  const chosen = await h.eval(`document.getElementById('dsDepPmatchSel').value`);
  await h.eval(`document.getElementById('dsDepPmatchGo').click()`);
  await h.sleep(2500); await waitScanned(h);
  await h.waitFor("!!document.querySelector('details[data-fold=\"parents\"] .ds-ordstep') || !!document.querySelector('.ds-dep-parents-synced')", 120000, 500); await h.sleep(1500);
  const after = await h.eval(`[...document.querySelectorAll('.ds-ordstep .ds-dep-pmatch')].map(x => x.innerText.replace(/\s+/g, ' ').trim()).filter(x => /${btn}/.test(x) || true).slice(0, 4)`);
  h.log('5. chose', chosen, '→ rows now:', JSON.stringify(after));
  h.log('5. saved on the deployment:', await h.eval(`JSON.stringify((() => { const p = _profiles.find(x => x.id === ${JSON.stringify(id)}); const out = []; (function walk(n) { if (!n) return; for (const [f, r] of Object.entries(n.lookupResolutions || {})) if (r.matchObject === ${JSON.stringify(btn)}) out.push((n.objectType || n.childSObject) + '.' + f + '=' + r.matchField); (n.children || []).forEach(walk); })(p.tree); return out; })())`));
  // put it back to Name so the fixture deployment stays as it was
  await h.eval(`(async () => { const p = _profiles.find(x => x.id === ${JSON.stringify(id)}); (function walk(n) { if (!n) return; for (const [f, r] of Object.entries(n.lookupResolutions || {})) if (r.matchObject === ${JSON.stringify(btn)}) r.matchField = 'Name'; (n.children || []).forEach(walk); })(p.tree); await storageSaveProfiles(); return true; })()`);
  // the popup's Field Cleaner history (any entries that exist)
  await h.popup('fields'); await h.sleep(1500);
  const cards = await h.eval(`[...document.querySelectorAll('.sftk-th-card')].slice(0, 2).map(c => c.innerText.replace(/\s+/g, ' ').trim().slice(0, 220))`);
  h.log('6. history cards:', JSON.stringify(cards));
  if (cards.length) { await h.eval(`document.querySelector('.sftk-th-card').scrollIntoView({ block: 'center' })`); await h.sleep(300); await h.shot('dist/qa/shots/history-cards.png'); }
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 3)')).slice(0, 300));
}
