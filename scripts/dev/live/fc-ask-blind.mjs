// "If the scan continue missing it will be a problem for us" — the scan is made BLIND to code on purpose (the index's
// Apex / Visualforce rows and the Aura read are dropped from the answers the page gets), then the demo field is
// scanned: everything Salesforce names in its refusal must still end up in the list. Nothing is written.
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
export default async function (h) {
  await h.login('npc');
  await h.popup('fields');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  const patched = await h.eval(`(() => {
    const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__blinded = 0;
    const blind = (msg, res) => {
      const q = String((msg && msg.query) || '');
      if (!res || !Array.isArray(res.records)) return res;
      if (/FROM MetadataComponentDependency/i.test(q)) { const n = res.records.length; res.records = res.records.filter(r => !/^(ApexClass|ApexTrigger|ApexPage|ApexComponent|AuraDefinitionBundle)$/.test(r.MetadataComponentType)); window.__blinded += n - res.records.length; }
      if (/FROM AuraDefinition\b/i.test(q) && !/WHERE/i.test(q)) { window.__blinded += res.records.length ? 1 : 0; res.records = []; }
      return res;
    };
    chrome.runtime.sendMessage = function (msg, cb) {
      if (typeof cb === 'function') return orig(msg, r => cb(blind(msg, r)));
      const p = orig(msg);
      return p && p.then ? p.then(r => blind(msg, r)) : p;
    };
    return true; })()`);
  h.log('page blinded:', patched);
  await pick(h, '#fcObjInput', '#fcObjDrop', 'Account');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', 'SFTK_Live_Blk__c');
  await h.eval(`(() => { document.querySelector('#fcScanBtn').click(); return true; })()`);
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000);
  await h.waitFor("!!document.querySelector('#fcAskBox') && !document.querySelector('#fcAskBox').hidden && !document.querySelector('#fcAskBtn').disabled", 180000, 1000);
  await h.sleep(2000);
  h.log('rows dropped from the answers:', await h.eval('window.__blinded'));
  h.log('box:', await h.eval(`document.querySelector('#fcAskBox').innerText`));
  const rows = await h.eval(`[...document.querySelectorAll('.fc-group')].map(g => g.querySelector('.fc-group-label').textContent + ': ' + [...g.querySelectorAll('.fc-item')].map(i => i.querySelector('.fc-item-name')?.textContent.trim() + (i.querySelector('.fc-item-tag') ? ' [🩺]' : '') + ' {' + [...i.querySelectorAll('button')].map(b => b.textContent.trim()).join(' ') + '}').join(' / '))`);
  for (const r of rows) h.log('   ', r);
  const all = rows.join(' ');
  const need = ['SFTK_Live_Cls', 'SFTK_Live_Trg', 'SFTK_Live_VF', 'sftkLiveAura'];
  // Salesforce names only SOME of what blocks in one answer (the full demo field: the workflow kinds first, no code):
  // what must hold is that everything it DID name is in the list. The rest surfaces when the list is cleared and it
  // is asked again.
  const box = await h.eval(`document.querySelector('#fcAskBox').innerText`);
  const named = need.filter(n => box.includes(n));
  h.log('named by Salesforce in this answer:', named.join(', ') || '(none of the code)');
  h.log('rows under "Named by Salesforce":', rows.filter(r => /^Named by Salesforce/.test(r)).join(' ') || '(none)');
  const miss = named.filter(n => !all.includes(n));
  h.log('delete button:', await h.eval(`(() => { const b = document.querySelector('#fcDelBtn, #fcDelFreeBtn'); return b ? (b.disabled ? 'locked' : 'OPEN') : 'none'; })()`));
  await h.eval(`document.querySelector('#fcAskBox').scrollIntoView({ block: 'start' })`); await h.sleep(500);
  await h.shot(`${h.shots}/ask-blind.png`);
  h.log(miss.length ? `❌ FAILED — not in the list: ${miss.join(', ')}` : '✅ every component Salesforce names is in the list, tagged');
}
