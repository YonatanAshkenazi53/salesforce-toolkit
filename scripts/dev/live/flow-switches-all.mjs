// Live (read-only): ⏻ Flow switches lists EVERY flow the org has, not only the
// triggered kinds (user 2026-11-08, after a colleague "didn't see many flows").
// Counts the rows against FlowDefinitionView's own count (pass it as EXPECT=<n>
// from `sf data query -q "SELECT COUNT() FROM FlowDefinitionView" -o npc`),
// prints the groups, ticks one screen flow and one record-triggered flow,
// opens the Switch OFF confirmation to read the ⚠ warning, and cancels.
// Then ⚙ API versions: its row count against the same number.
//   ORG=npc  EXPECT=138  DARK=1 (a dark screenshot of each view)
const dump = async (h, sel, n = 3000) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
// the toggle cycles light → dark → OLED, so the class is set, not clicked
const setDark = async (h, on) => { await h.eval(`document.body.classList.toggle('sftk-dark', ${on ? 'true' : 'false'}); document.body.classList.remove('sftk-oled'); true`); await h.sleep(on ? 1000 : 500); };
async function darkShot(h, name) {
  if (process.env.DARK !== '1') return;
  await setDark(h, true);
  await h.shot(h.shots + `/${name}-dark.png`);
  await setDark(h, false);
}
export default async function (h) {
  const expect = Number(process.env.EXPECT || 0);
  await h.login(process.env.ORG || 'npc');
  await h.popup('flows');
  await h.watchErrors();
  if (process.env.SCAN !== '0') {
    // the dependency scan first, so the panel can show which flow calls which
    await h.waitFor("typeof metadataScanState !== 'undefined' && metadataScanState !== 'none'", 120000, 500);
    const offered = await h.eval("(() => { const b = [...document.querySelectorAll('button')].find(b => /Scan dependencies/.test(b.textContent)); if (b) b.click(); return !!b; })()");
    h.log('dependency scan:', offered ? 'offered and pressed' : `state ${await h.eval('metadataScanState')}`);
    await h.waitFor("typeof metadataScanState !== 'undefined' && metadataScanState !== 'scanning' && metadataScanState !== 'none'", 600000, 1000);
    h.log('dependency scan:', await h.eval('metadataScanState'), JSON.stringify(await h.eval("(() => { const s = DependencyMap.getScanStatus(); return { complete: s.complete, done: s.done, total: s.total }; })()")));
  }
  await h.eval("setFlowView('switches')");
  await h.waitFor("(document.getElementById('flowToolHost')?.innerText || '').length > 20", 60000, 500);
  await h.waitFor("document.querySelectorAll('.dep-fb-cb').length > 0 || /could not|no flows/i.test(document.querySelector('#depFbBody')?.innerText || '')", 300000, 1500);
  await h.sleep(1500);
  const rows = await h.eval(`document.querySelectorAll('.dep-fb-cb').length`);
  const groups = await h.eval(`(() => { const m = {}; document.querySelectorAll('.dep-fb-cb').forEach(c => { m[c.dataset.grp] = (m[c.dataset.grp] || 0) + 1; }); return m; })()`);
  h.log('SWITCHES rows:', rows, expect ? `(FlowDefinitionView says ${expect}) ${rows === expect ? 'MATCH' : 'MISMATCH'}` : '');
  h.log('summary line:', await dump(h, '.dep-tool-sum', 300));
  h.log('groups:', JSON.stringify(groups));
  h.log('group order:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.dep-list-grp-name')].map(e => e.textContent)`)));
  h.log('notes:', await dump(h, '.dep-tool-note', 600));
  await h.shot(h.shots + '/fs-all-panel.png');
  await darkShot(h, 'fs-all-panel');

  // subflow links: the dep-test chain (Account Trigger → L1 → L2 → L3 → L4)
  const chips = await h.eval(`[...document.querySelectorAll('.dep-fb-cb')].filter(c => /SFTK_Dep_Test/.test(c.value)).map(c => c.value + ' :: ' + [...c.closest('.dep-list-row').querySelectorAll('.dep-fb-sub')].map(b => b.textContent.trim() + ' [' + b.dataset.names + ']').join(' '))`);
  h.log('subflow chips:', JSON.stringify(chips));
  const tickedBySub = await h.eval(`(() => {
    const row = [...document.querySelectorAll('.dep-fb-cb')].find(c => c.value === 'SFTK_Dep_Test_Account_Trigger')?.closest('.dep-list-row');
    const b = row && [...row.querySelectorAll('.dep-fb-sub')].find(x => /calls/.test(x.textContent));
    if (!b) return 'no calls chip';
    b.click();
    return [...document.querySelectorAll('.dep-fb-cb')].filter(c => c.checked).map(c => c.value);
  })()`);
  h.log('after clicking "calls" on Account Trigger, ticked:', JSON.stringify(tickedBySub), '| count line:', await dump(h, '#depFbCount', 120));
  await h.eval(`[...document.querySelectorAll('.dep-fb-cb')].find(c => c.value === 'SFTK_Dep_Test_L1')?.closest('.dep-list-row')?.scrollIntoView({ block: 'center' })`);
  await h.sleep(300);
  await h.shot(h.shots + '/fs-all-subflows.png');
  await darkShot(h, 'fs-all-subflows');
  await h.eval(`document.querySelectorAll('.dep-fb-cb').forEach(c => { if (c.checked) { c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); } })`);

  // one own screen flow + one own subflow + one record-triggered flow → the OFF
  // confirmation names what breaks for the first two and nothing for the third.
  // PICK=a,b,c names them (default: npc's own three).
  const names = (process.env.PICK || 'FL_Account_Case_Origin_Screen_Flow,SFTK_AV_Test_A,SFTK_Dbg_Loop').split(',');
  const picked = await h.eval(`(() => {
    const out = [];
    for (const n of ${JSON.stringify(names)}) {
      const c = [...document.querySelectorAll('.dep-fb-cb')].find(x => x.value === n);
      if (!c) { out.push(n + ' — NOT IN THE LIST'); continue; }
      if (c.disabled) { out.push(n + ' — locked'); continue; }
      c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); out.push(c.value + ' @ ' + c.dataset.grp + ' on=' + c.dataset.on);
    }
    return out;
  })()`);
  h.log('ticked:', JSON.stringify(picked), '| count line:', await dump(h, '#depFbCount', 120));
  // the kind groups, scrolled into view
  await h.eval(`[...document.querySelectorAll('.dep-list-grp-name')].find(e => /Screen flow/.test(e.textContent))?.closest('.dep-list-grp')?.scrollIntoView({ block: 'start' })`);
  await h.sleep(400);
  await h.shot(h.shots + '/fs-all-kinds.png');
  await darkShot(h, 'fs-all-kinds');
  const confirmOnce = async (name) => {
    await h.eval(`document.querySelector('#depFbOff')?.click()`);
    await h.waitFor("!!document.querySelector('#sftkConfirmGo') || /nothing|none of|already/i.test(document.querySelector('#depFbOut')?.innerText || '')", 120000, 500);
    await h.sleep(500);
    h.log('CONFIRM:', await dump(h, '#modalBox', 2500));
    await h.shot(h.shots + `/${name}.png`);
    await h.eval(`document.querySelector('#sftkConfirmCancel')?.click()`);
    await h.sleep(500);
    h.log('cancelled — nothing written');
  };
  await confirmOnce('fs-all-confirm');
  if (process.env.DARK === '1') {
    await setDark(h, true);
    await confirmOnce('fs-all-confirm-dark');
    await setDark(h, false);
  }

  // ⚙ API versions: the same count
  await h.eval("setFlowView('apiver')");
  await h.sleep(800);
  await h.eval(`document.querySelector('#depAvGo')?.click()`);
  await h.waitFor("document.querySelectorAll('.dep-av-pick').length > 0 || /could not|failed/i.test(document.querySelector('#depAvOut')?.innerText || '')", 300000, 1500);
  await h.sleep(1000);
  const av = await h.eval(`document.querySelectorAll('.dep-av-pick').length`);
  h.log('API VERSIONS rows:', av, expect ? `(FlowDefinitionView says ${expect}) ${av === expect ? 'MATCH' : 'MISMATCH'}` : '');
  h.log('api summary:', (await dump(h, '#depAvOut', 400)));
  await h.shot(h.shots + '/fs-all-apiver.png');
  await darkShot(h, 'fs-all-apiver');
}
