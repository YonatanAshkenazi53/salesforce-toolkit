// Live, read-only: the Deploy page remembers what you ticked (2026-11-05: "I
// ticked 40 records, went to the parent, deployed it, came back — and all my
// ticks were gone"). Opens the CX fixture deployment on npc → npc2, scans,
// ticks three inserts on the root and two on a child, then: 🔄 Refresh (a new
// scan) → the ticks are back with the sentence; ‹ Back to deployments and open
// again → still there; the Data Studio page opened anew (disk) → still there.
// Nothing is deployed.
//   PROFILE   deployment name (default: the CX fixture's Accounts tree)
const NL = String.fromCharCode(10);
const dump = async (h, sel, n = 1200) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled && !document.querySelector('#dsDepScan')?.disabled", 300000, 1000);
const ticked = h => h.eval(`JSON.stringify({ root: [..._recSel.push].sort(), children: Object.fromEntries(Object.entries(_recChildSel).map(([k, s]) => [k, [...s.push].sort()])) })`);
const tickFirst = (h, n) => h.eval(`(() => { const cbs = [...document.querySelectorAll('[data-dep-push]')].filter(c => !c.disabled && !c.checked).slice(0, ${n}); cbs.forEach(c => { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); }); return cbs.map(c => c.dataset.depPush); })()`);
async function open(h, id) {
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.waitFor("!!document.querySelector('#dsDepScan') || !!document.querySelector('#dsDepRefresh')", 60000, 500);
}
async function goChild(h) {
  const k = await h.eval(`(() => { const b = [...document.querySelectorAll('.ds-dep-objbtn')].find(x => x.dataset.depObj && x.dataset.depObj !== ''); if (!b) return null; b.click(); return b.dataset.depObj; })()`);
  await h.sleep(1200);
  return k;
}

export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Accounts tree';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('profile missing: ' + NAME);
  await open(h, id);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await waitScanned(h); await h.sleep(2000);
  // the first child read too, so a child tick can be tested
  const scanAll = await h.eval(`(() => { const x = [...document.querySelectorAll('button')].find(b => /Scan all/.test(b.textContent)); if (x) x.click(); return !!x; })()`);
  if (scanAll) { await h.sleep(2000); await h.waitFor("![...document.querySelectorAll('button')].some(b => /⏳/.test(b.textContent))", 600000, 1500); await h.sleep(2000); }
  h.log('PLAN:', await dump(h, '.ds-dep-plan', 900));
  h.log('before any tick:', await ticked(h), '| note:', await dump(h, '#dsDepSelNote', 300) || '(none)');
  const rootIds = await tickFirst(h, 3);
  h.log('ticked on root:', JSON.stringify(rootIds), '| summary:', await dump(h, '#dsDepSummary', 300));
  const childKey = await goChild(h);
  const childIds = childKey ? await tickFirst(h, 2) : [];
  h.log(`ticked on child ${childKey}:`, JSON.stringify(childIds), '| summary:', await dump(h, '#dsDepSummary', 300));
  await h.sleep(600);   // the debounced disk write
  h.log('disk:', JSON.stringify(await h.eval(`chrome.storage.local.get('sftk_dep_sel').then(d => Object.fromEntries(Object.entries(d.sftk_dep_sel || {}).map(([k, v]) => [k, v.n])))`)));
  await h.shot(h.shots + '/dt-1-ticked.png');

  h.log('── 🔄 Refresh (a new scan) ──');
  await h.eval(`document.querySelector('#dsDepRefresh')?.click()`);
  await h.sleep(1500); await waitScanned(h); await h.sleep(2500);
  h.log('after refresh:', await ticked(h), '| note:', await dump(h, '#dsDepSelNote', 400) || '(none)', '| summary:', await dump(h, '#dsDepSummary', 300));
  await h.shot(h.shots + '/dt-2-after-refresh.png');

  h.log('── ‹ Back to deployments, open again ──');
  await h.eval(`document.querySelector('#dsDepBack')?.click()`); await h.sleep(1200);
  await open(h, id); await h.sleep(2000);
  h.log('after reopen:', await ticked(h), '| note:', await dump(h, '#dsDepSelNote', 400) || '(none)');

  h.log('── the Data Studio page opened anew (disk) ──');
  await h.studio(''); await h.sleep(2000);
  await open(h, id); await h.sleep(2500);
  h.log('after a fresh page:', await ticked(h), '| note:', await dump(h, '#dsDepSelNote', 400) || '(none)', '| summary:', await dump(h, '#dsDepSummary', 300));
  await h.shot(h.shots + '/dt-3-fresh-page.png');
  await h.eval("document.querySelector('#dsDarkToggle, #sftkDarkToggle')?.click()"); await h.sleep(1200);
  await h.shot(h.shots + '/dt-4-fresh-page-dark.png');

  h.log('── untick everything by hand: the memory is "nothing" ──');
  await h.eval(`(() => { document.querySelectorAll('[data-dep-push]:checked').forEach(c => { c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); }); return true; })()`);
  await h.sleep(800);
  h.log('root after untick:', await ticked(h), '| disk n:', JSON.stringify(await h.eval(`chrome.storage.local.get('sftk_dep_sel').then(d => Object.values(d.sftk_dep_sel || {}).map(v => v.n))`)));
}
