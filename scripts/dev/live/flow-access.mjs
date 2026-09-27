// Live: 🔑 Flow Access (popup) — grant the fixture flow SFTK_AV_Test_A to the permission set
// SFTK_FC_Test_Access in trailheads5 (a Metadata deploy of <flowAccesses>), then CLI-verify.
//   FLOW="SFTK AV Test A"  PS="SFTK FC Test Access"  SCAN_ONLY=1
const dump = async (h, sel, n = 2500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
async function tick(h, cbClass, searchId, label) {
  await h.eval(`(() => { const i = document.querySelector('#${searchId}'); if (i) { i.value = ${JSON.stringify(label)}; i.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`);
  await h.sleep(700);
  return h.eval(`(() => { const rows = [...document.querySelectorAll('.${cbClass}')]; const c = rows.find(x => (x.closest('label, li, div')?.innerText || '').includes(${JSON.stringify(label)})); if (!c) return 'not found among ' + rows.length; c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return 'ticked ' + (c.closest('label, li, div')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 80); })()`);
}
export default async function (h) {
  await h.login('npc');
  await h.popup('flow-access');
  await h.watchErrors();
  await h.waitFor("document.querySelectorAll('.fp-flow-cb').length > 0 && document.querySelectorAll('.fp-ps-cb').length > 0", 240000, 1000);
  await h.sleep(800);
  h.log('counts:', await dump(h, '#fpFlowCount', 80), '/', await dump(h, '#fpPsCount', 80));
  h.log('flow:', await tick(h, 'fp-flow-cb', 'fpFlowSearch', process.env.FLOW || 'SFTK AV Test A'));
  h.log('permset:', await tick(h, 'fp-ps-cb', 'fpPsSearch', process.env.PS || 'SFTK FC Test Access'));
  await h.sleep(500);
  h.log('summary:', await dump(h, '#fpActionSummary', 300), '| assign:', await h.eval(`(() => { const b = document.querySelector('#fpAssignBtn'); return b.textContent.trim() + (b.disabled ? ' (off)' : ''); })()`));
  await h.eval(`document.querySelector('#fpAssignBtn').click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 300); await h.sleep(300);
  h.log('CONFIRM:', await h.eval(`(document.querySelector('#modalBox')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 800)`));
  await h.shot(h.shots + '/fa-confirm.png');
  if (process.env.SCAN_ONLY === '1') { await h.eval(`document.querySelector('#sftkConfirmCancel')?.click()`); h.log('SCAN_ONLY — cancelled'); return; }
  await h.eval(`document.querySelector('#sftkConfirmGo').click()`);
  await h.sleep(400);
  if (await h.eval(`!!document.querySelector('#sftkConfirmProd')`)) {
    h.log('TYPED GATE (production):', await dump(h, '#modalBox', 500));
    await h.eval(`(() => { const i = document.querySelector('#sftkConfirmProd'); i.value = i.placeholder; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await h.eval(`document.querySelector('#sftkConfirmProdGo')?.click()`);
  }
  await h.waitFor("/Assigned|assigned|failed/.test(document.querySelector('#modalBox')?.innerText || '') && !/Deploying/.test(document.querySelector('#fpActionSummary')?.innerText || '')", 300000, 1000);
  await h.sleep(800);
  h.log('RESULT:', await h.eval(`(document.querySelector('#modalBox')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 800)`));
  await h.shot(h.shots + '/fa-result.png');
}
