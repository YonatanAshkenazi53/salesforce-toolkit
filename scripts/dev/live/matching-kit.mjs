// Live (npc → npc2, the Accounts-tree fixture; nothing is written to an org — only the deployment in this
// browser profile changes): the Matching kit on the Deploy page (user 2026-11-07: "matching of parents
// selection should have all of the features from the pic above", "כולל ההמלצות", "here we should also allow
// to change matching for child's", "matching by field").
//   1. a parent row's ✏ → 💡 Suggestions graded live, 🧪 Test this key, a suggestion used → both orgs read
//      again → the row says the new key
//   2. a tree card's ✏ matching → the object's own Matching kit (composite) → saved → read again → the card
//      says the new key
// PARENT=<obj> (default Individual), PFIELD=<field> to use (default: the first suggestion that is not Name)
const NL = String.fromCharCode(10);
const dump = async (h, sel, n = 1500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 400000, 1000);
const dark = async (h, on) => { await h.eval(`(() => { if (!document.getElementById('noTrans')) { const st = document.createElement('style'); st.id = 'noTrans'; st.textContent = '*{transition:none!important}'; document.head.appendChild(st); } document.documentElement.classList.toggle('ds-dark', ${on}); return true; })()`); await h.sleep(500); };
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Accounts tree';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('fixture profile missing');
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await waitScanned(h); await h.sleep(2000);
  await h.waitFor("!!document.querySelector('[data-dep-pmatch-edit]')", 240000, 1000);
  h.log('parent rows:', JSON.stringify(await h.eval(`[...document.querySelectorAll('[data-dep-pmatch-edit]')].map(b => b.dataset.depPmatchEdit + ' ← ' + (b.closest('li, tr, div')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 140))`)));
  const PARENT = process.env.PARENT || 'Individual';
  // 1. the parent's kit
  await h.eval(`(() => { const b = document.querySelector('[data-dep-pmatch-edit="${PARENT}"]'); b.closest('details') && (b.closest('details').open = true); b.click(); return true; })()`);
  await h.waitFor("!!document.querySelector('#dsPmSug')", 60000, 300);
  h.log('kit:', await dump(h, '#dsModalBox', 900));
  await h.eval(`document.querySelector('#dsPmSug').click()`);
  await h.waitFor("/Suggestions — graded|No single-field key/.test(document.querySelector('#dsPmOut')?.innerText || '')", 240000, 800);
  h.log('suggestions:', await dump(h, '#dsPmOut', 1500));
  await h.shot(h.shots + '/mk-1-parent-suggestions.png');
  await dark(h, true); await h.shot(h.shots + '/mk-1-parent-suggestions-dark.png'); await dark(h, false);
  const uses = await h.eval(`[...document.querySelectorAll('[data-pm-use]')].map(b => b.dataset.pmUse)`);
  const pf = process.env.PFIELD || uses.find(f => f !== 'Name') || uses[0];
  h.log('using:', pf, 'of', JSON.stringify(uses));
  if (await h.eval(`!!document.querySelector('[data-pm-use="${pf}"]')`)) await h.eval(`document.querySelector('[data-pm-use="${pf}"]').click()`);
  else await h.eval(`(() => { const s = document.querySelector('#dsDepPmatchSel'); s.value = ${JSON.stringify(pf)}; s.dispatchEvent(new Event('change')); return true; })()`);
  await h.eval(`document.querySelector('#dsPmTest').click()`);
  await h.waitFor("!/testing/.test(document.querySelector('#dsPmTest')?.textContent || '') && (document.querySelector('#dsPmOut')?.innerText || '').length > 20", 240000, 800);
  h.log('test this key:', await dump(h, '#dsPmOut', 900));
  await h.shot(h.shots + '/mk-2-parent-test.png');
  await h.eval(`document.querySelector('#dsDepPmatchGo').click()`);
  await h.waitFor("!!document.querySelector('#dsDepRefresh')?.disabled", 30000, 200).catch(() => h.log('the re-read was not seen starting'));
  await waitScanned(h); await h.sleep(2500);
  await h.waitFor(`!!document.querySelector('[data-dep-pmatch-edit="${PARENT}"]')`, 240000, 1000);
  h.log('the key now:', await h.eval(`JSON.stringify(sftkDeployParentMatchFields(_reconcileProfile.tree, { neededBy: [...(function f(n, o) { (n.children || []).forEach(c => f(c, o)); for (const [k, v] of Object.entries(n.lookupResolutions || {})) if (v && v.matchObject === ${JSON.stringify(PARENT)}) o.push({ obj: n.objectType || n.childSObject, field: k }); return o; })(_reconcileProfile.tree, [])] }))`));
  h.log('parent row after:', await h.eval(`(document.querySelector('[data-dep-pmatch-edit="${PARENT}"]')?.parentElement?.innerText || '').replace(/\\s+/g, ' ').slice(0, 200)`));
  // 2. a tree card's kit
  const cards = await h.eval(`[...document.querySelectorAll('[data-tree-match]')].map(b => b.dataset.treeMatch + ' ' + (b.closest('.ds-dtree-node')?.querySelector('.ds-dtree-name')?.innerText || '').trim())`);
  h.log('cards with ✏ matching:', JSON.stringify(cards));
  const target = process.env.CARD || (cards.find(c => / Contact/.test(c)) || cards[1] || cards[0] || '').split(' ')[0];
  await h.eval(`(() => { const d = document.querySelector('#dsDepTree details'); if (d) d.open = true; document.querySelector('[data-tree-match="${target}"]').click(); return true; })()`);
  await h.waitFor("!!document.querySelector('#dsMatchTestBtn')", 90000, 500);
  await h.eval(`document.querySelector('.ds-match-cfg')?.scrollIntoView({ block: 'start' })`); await h.sleep(400);
  await h.shot(h.shots + '/mk-3-card-kit.png');
  // composite: Name + the first other text field
  await h.eval(`(() => { const r = document.querySelector('input[name="dsMatchStrat"][value="composite"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await h.sleep(800);
  const comp = await h.eval(`(() => { const s = document.querySelector('[data-match-comp="1"]'); if (!s) return null; const o = [...s.options].find(x => x.value && /Email|Phone|Title|Department/.test(x.value)) || [...s.options].find(x => x.value); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return o.value; })()`);
  await h.sleep(800);
  h.log('composite with:', comp, '| reads as:', await dump(h, '#dsMatchReadsAs', 300));
  await h.shot(h.shots + '/mk-4-card-composite.png');
  await dark(h, true); await h.shot(h.shots + '/mk-4-card-composite-dark.png'); await dark(h, false);
  await h.eval(`document.querySelector('#dsRecSave').click()`);
  // the re-read starts once the window has closed: wait for it to start, then to end
  await h.waitFor("!!document.querySelector('#dsDepRefresh')?.disabled || /reading/.test(document.querySelector('#dsDepRefresh, #dsDepScan')?.textContent || '')", 30000, 200).catch(() => h.log('the re-read was not seen starting'));
  await waitScanned(h); await h.sleep(2500);
  h.log('card after:', await h.eval(`(document.querySelector('[data-tree-match="${target}"]')?.closest('.ds-dtree-node')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 300)`));
  h.log('the scan used:', await h.eval(`JSON.stringify(((_profiles.find(p => p.id === ${JSON.stringify(id)}).lastScan || {}).matching) || null)`));
  h.log('node.matching saved:', await h.eval(`JSON.stringify(getNodeByPath(_profiles.find(p => p.id === ${JSON.stringify(id)}).tree, ${JSON.stringify(target)})?.matching || null)`));
  await h.eval(`document.querySelector('#dsDepTree')?.scrollIntoView({ block: 'start' })`); await h.sleep(400);
  await h.shot(h.shots + '/mk-5-tree-after.png');
}
