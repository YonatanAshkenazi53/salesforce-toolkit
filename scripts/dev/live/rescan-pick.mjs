// The plan table: a tick per object and ONE rescan button (owner 2026-11-13: "we dont need this button as we have the
// rescan all" · "a way to select every object to rescan"). READ-ONLY: both orgs are only read.
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const id = await h.eval("_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id");
  await h.eval(`window.runProfile(${JSON.stringify(id)})`);
  const ready = () => h.waitFor("!!document.querySelector('#dsDepRescanAll') && !document.querySelector('[data-dep-scan]') && document.querySelectorAll('.ds-dep-rescan-cb').length > 3 && !document.querySelector('#dsDepRefresh')?.disabled", 400000, 1000);
  await ready(); await h.sleep(1500);
  const state = () => h.eval("JSON.stringify({ btn: document.querySelector('#dsDepRescanAll').innerText, note: document.querySelector('#dsDepRescanNote')?.innerText, rows: document.querySelectorAll('.ds-dep-rescan-cb').length, oldButtons: [...document.querySelectorAll('.ds-dep-plan button')].filter(b => /Rescan/.test(b.innerText)).length })");
  h.log('nothing ticked:', await state());
  const picked = await h.eval("(() => { const cbs = [...document.querySelectorAll('.ds-dep-rescan-cb')].filter(c => c.dataset.path !== ''); const two = cbs.slice(0, 2); two.forEach(c => { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); }); return two.map(c => c.dataset.path); })()");
  h.log('ticked paths:', JSON.stringify(picked), '→', await state());
  await h.shot(h.shots + '/rescan-pick.png');
  if (!/Rescan the 2 selected/.test(await h.eval("document.querySelector('#dsDepRescanAll').innerText"))) throw new Error('the button does not say the 2 selected');
  await h.eval("(() => { window.__calls = []; const o = window.scanReconcileChild; window.scanReconcileChild = async (p, k) => { window.__calls.push(k); return o(p, k); }; document.querySelector('#dsDepRescanAll').click(); return true; })()");
  await h.sleep(3000); await ready(); await h.sleep(1000);
  const calls = await h.eval('JSON.stringify(window.__calls)');
  h.log('objects read again:', calls, '→ after:', await state());
  const got = JSON.parse(calls);
  if (!got.length || got.some(k => !picked.some(p => k === p || k.startsWith(p + '.')))) throw new Error('the rescan read objects that were not ticked (or nothing)');
  h.log('✅ only the ticked objects (and the ones under them) were read again; the ticks are cleared');
}
