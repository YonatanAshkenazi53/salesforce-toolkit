// Live, read-only: Deploy page › "✓ Tick every insert" (user 2026-10-15). Scans the fixture
// deployment with every child, presses the button, and reports what got ticked per object.
// Nothing is written: ticking is a selection, Deploy is never pressed.
//   node scripts/dev/headless-studio.mjs scripts/dev/live/tick-every.mjs
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const id = await h.eval(`_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id`);
  if (!id) throw new Error('fixture profile missing');
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await waitScanned(h); await h.sleep(1500);
  h.log('1. before scan-all — button:', await h.eval(`document.querySelector('#dsDepTickAll')?.textContent || 'none'`), '| note:', await h.eval(`!!document.querySelector('#dsDepScanAll')`));
  if (await h.eval(`!!document.querySelector('#dsDepScanAll')`)) {
    await h.eval(`document.querySelector('#dsDepScanAll').click()`);
    await h.waitFor("!document.querySelector('#dsDepScanAll') && ![...document.querySelectorAll('[data-dep-scan]')].some(b => b.disabled) && !document.querySelector('#dsDepRefresh')?.disabled", 900000, 1000);
    await h.sleep(1500);
  }
  h.log('2. after scan-all — button:', await h.eval(`document.querySelector('#dsDepTickAll')?.textContent || 'none'`));
  const before = await h.eval(`(() => { let n = _recSel.push.size; for (const k of Object.keys(_recChildSel)) n += _recChildSel[k].push.size; return n; })()`);
  await h.eval(`document.querySelector('#dsDepTickAll').click()`); await h.sleep(1500);
  const per = await h.eval(`(() => { const o = { '': _recSel.push.size }; for (const k of Object.keys(_recChildSel)) o[k] = _recChildSel[k].push.size; return JSON.stringify(o); })()`);
  h.log('3. ticked before:', before, '| after, per object path:', per);
  h.log('3. summary line:', (await h.eval(`(document.querySelector('.ds-dep-sum, #dsDepSummary')?.innerText || document.querySelector('.ds-dep-foot')?.innerText || '').replace(/\\s+/g, ' ')`)).slice(0, 200));
  h.log('3. toast:', (await h.eval(`(document.querySelector('.ds-toast, .toast')?.innerText || '')`)).slice(0, 160));
  const errs = await h.eval(`(window.__sftkErrors || []).slice(0, 3)`);
  h.log('page errors:', JSON.stringify(errs));
}
