// Read-only: the stored-values line of Field Cleaner for several Account fields in npc, to compare with the CLI's own COUNT.
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
const verdict = async h => { await h.waitFor("!!document.querySelector('#fcDataVerdict') && !document.querySelector('#fcDataVerdict').classList.contains('fc-data-loading')", 120000, 500); return (await h.eval(`document.querySelector('#fcDataVerdict').innerText`)).replace(/\s+/g, ' ').trim(); };
export default async function (h) {
  await h.login('npc');
  await h.popup('fields');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', 'Account');
  const fields = await h.eval(`(() => { const i = document.querySelector('#fcFieldInput'); i.focus(); i.dispatchEvent(new Event('focus')); return [...document.querySelectorAll('#fcFieldDrop .fc-dd-item')].map(x => x.dataset.api); })()`);
  h.log('custom fields offered:', fields.join(', '));
  for (const f of ['SFTK_Live_Blk__c', 'Active__c', 'SFTK_Dbg_Count__c', 'CustomerPriority__c', 'SLAExpirationDate__c']) {
    if (!fields.includes(f)) { h.log(f, '— not offered, skipped'); continue; }
    await pick(h, '#fcFieldInput', '#fcFieldDrop', f);
    await h.eval(`document.querySelector('#fcScope [data-scope="mentions"]')?.click()`); await h.sleep(300);
    await h.eval(`document.querySelector('#fcScanBtn').click()`);
    h.log(`${f} →`, await verdict(h));
    await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000);
  }
}
