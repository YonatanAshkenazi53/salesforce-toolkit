// Live, read-only: the filter box over ⏻ Switches and ⚙ API versions (2026-11-05,
// "paste one flow name from the ticket, tick it, paste the next"), and the 🗂
// Versions search by API name. Types a fixture flow's label, ticks it with
// Enter, types the next by API name, ticks it, clears the box: both ticks are
// still there and the footer says so. Light and dark shots. Nothing is written.
//   ORG=npc   (default npc; the flowswitch fixture SFTK_FS_Test_* must be deployed)
const dump = async (h, sel, n = 600) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
const type = async (h, sel, text) => h.eval(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const enter = async (h, sel) => h.eval(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
const shown = async (h, host) => h.eval(`[...document.querySelectorAll('${host} .dep-list-row:not(.dep-list-hid)')].map(r => (r.querySelector('input').value) + (r.querySelector('input').checked ? ' ✓' : ''))`);
const ticked = async (h, host) => h.eval(`[...document.querySelectorAll('${host} .dep-list-row input:checked')].map(i => i.value)`);
// the toggle cycles light → dark → OLED; click until the body carries (or no longer carries) sftk-dark
const dark = async (h, on) => { for (let i = 0; i < 3; i++) { const now = await h.eval(`document.body.classList.contains('sftk-dark')`); if (now === on) return; await h.eval("document.querySelector('#sftkDarkToggle')?.click()"); await h.sleep(900); } };

async function drill(h, { view, host, cbSel, label, api, tag }) {
  await h.eval(`setFlowView(${JSON.stringify(view)})`);
  await h.waitFor(`document.querySelectorAll('${host} ${cbSel}').length > 0`, 300000, 1500);
  await h.sleep(1000);
  const inSel = `${host} .dep-list-filter`;
  h.log(`── ${tag}: ${await h.eval(`document.querySelectorAll('${host} ${cbSel}').length`)} rows, filter box: ${await h.eval(`!!document.querySelector(${JSON.stringify(inSel)})`)}`);
  await type(h, inSel, label);
  h.log(`typed label "${label}":`, JSON.stringify(await shown(h, host)), '| line:', await dump(h, `${host} .dep-list-filter-n`));
  await enter(h, inSel);
  h.log('Enter →', JSON.stringify(await shown(h, host)));
  await type(h, inSel, api);
  h.log(`typed API "${api}":`, JSON.stringify(await shown(h, host)), '| line:', await dump(h, `${host} .dep-list-filter-n`));
  await enter(h, inSel);
  await type(h, inSel, 'sftk fs');
  h.log('typed "sftk fs":', JSON.stringify(await shown(h, host)), '| line:', await dump(h, `${host} .dep-list-filter-n`));
  await h.shot(h.shots + `/ff-${tag}-filtered.png`);
  await type(h, inSel, 'zzz nothing');
  h.log('no match:', '| line:', await dump(h, `${host} .dep-list-filter-n`), '| footer:', await dump(h, `${host} .dep-tool-foot`));
  await h.shot(h.shots + `/ff-${tag}-nomatch.png`);
  await type(h, inSel, '');
  h.log('cleared → ticked:', JSON.stringify(await ticked(h, host)), '| footer:', await dump(h, `${host} .dep-tool-foot`));
  await dark(h, true);
  await type(h, inSel, 'sftk fs');
  await h.shot(h.shots + `/ff-${tag}-filtered-dark.png`);
  await type(h, inSel, '');
  await dark(h, false);
}

export default async function (h) {
  await h.login(process.env.ORG || 'npc');
  await h.popup('flows');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#searchInput')", 60000, 500);
  // 🗂 Versions: the search matches the API name now
  await h.waitFor("document.querySelectorAll('#flowList .flow-group, #flowList [class*=group]').length > 0", 300000, 1500);
  await h.sleep(800);
  await type(h, '#searchInput', 'SFTK_FS_Test_Acc1');
  await h.sleep(300);
  h.log('Versions search by API name →', await dump(h, '#flowList', 300), '| empty:', await dump(h, '#emptyState', 200));
  await h.shot(h.shots + '/ff-versions-api.png');
  await type(h, '#searchInput', '');
  await drill(h, { view: 'switches', host: '#flowToolHost', cbSel: '.dep-fb-cb', label: 'SFTK FS Test Acc1', api: 'SFTK_FS_Test_Acc2', tag: 'switches' });
  await drill(h, { view: 'apiver', host: '#flowToolHost', cbSel: '.dep-av-pick', label: 'SFTK FS Test Acc1', api: 'SFTK_FS_Test_Acc2', tag: 'apiver' });
}
