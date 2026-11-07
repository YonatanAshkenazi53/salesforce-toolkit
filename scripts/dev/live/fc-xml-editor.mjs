// LIVE, WRITES to npc: the ✎ XML editor in Field Cleaner's 🔍 (user 2026-11-07: "give the user an ability to edit
// the XML and repush it to sf the way they want. Like a vscode"). On the demo field's validation rule SFTK_Live_VR:
//   1. malformed XML → the box says so, Deploy stays off;  2. a formula Salesforce refuses → its words under the box,
//   nothing changed;  3. a real edit of the formula → deployed, verified, the CLI reads it;  4. ↩ Undo in History
//   → the CLI reads the original back. DARK=1 shoots the editor in dark too.
import { execSync } from 'node:child_process';
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
const confirm = async h => { await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 20000, 200); await h.eval(`(() => { const a = document.getElementById('sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`); await h.sleep(200); await h.eval(`document.getElementById('sftkConfirmGo').click()`); };
const dark = async (h, on) => { await h.eval(`(() => { if (!document.getElementById('noTrans')) { const st = document.createElement('style'); st.id = 'noTrans'; st.textContent = '*{transition:none!important}'; document.head.appendChild(st); } document.body.classList.toggle('sftk-dark', ${on}); return true; })()`); await h.sleep(600); };
const cliFormula = () => { try { const out = execSync('sf data query --use-tooling-api -o npc --json -q "SELECT Metadata FROM ValidationRule WHERE ValidationName = \'SFTK_Live_VR\'"', { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] }); const j = JSON.parse(out.slice(out.indexOf('{'))); return (((j.result || {}).records || [])[0] || {}).Metadata?.errorConditionFormula; } catch (e) { return 'CLI failed: ' + String(e.message).slice(0, 200); } };
export default async function (h) {
  const VR = process.env.VR || 'SFTK_Live_VR';
  h.log('CLI before:', cliFormula());
  await h.login('npc');
  await h.popup('fields');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', 'Account');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', 'SFTK_Live_Blk__c');
  await h.eval(`document.querySelector('#fcScope [data-scope="blockers"]').click()`); await h.sleep(300);
  await h.eval(`document.querySelector('#fcScanBtn').click()`);
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000); await h.sleep(1500);
  const id = await h.eval(`(() => { const p = [...document.querySelectorAll('.fc-del-pair[data-type="ValidationRule"]')].find(x => x.dataset.name === ${JSON.stringify(VR)}); return p ? p.dataset.id : null; })()`);
  h.log('row id:', id);
  const panel = `document.getElementById('fcXml_${id}')`;
  const open = async () => {
    await h.eval(`document.querySelector('.fc-inspect-btn[data-id="${id}"]').click()`);
    await h.waitFor(`!!${panel} && !!${panel}.querySelector('.fc-xml-edit-btn')`, 60000, 400);
    await h.eval(`${panel}.querySelector('.fc-xml-edit-btn').click()`);
    await h.waitFor(`!!${panel}.querySelector('.fc-xml-ta')`, 10000, 200);
  };
  const type = async text => { await h.eval(`(() => { const ta = ${panel}.querySelector('.fc-xml-ta'); ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await h.sleep(300); };
  const state = () => h.eval(`(() => { const p = ${panel}; return { state: p.querySelector('.fc-xml-ed-state')?.textContent, deployOff: p.querySelector('.fc-xml-ed-deploy')?.disabled, out: (p.querySelector('.fc-xml-ed-out')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 600) }; })()`);
  await open();
  const orig = await h.eval(`${panel}.querySelector('.fc-xml-ta').value`);
  h.log('editor text:', orig.replace(/\n/g, ' ⏎ ').slice(0, 400));
  await h.eval(`${panel}.scrollIntoView({ block: 'start' })`); await h.sleep(300);
  await h.shot(h.shots + '/xed-1-open.png');
  // 1. malformed
  await type(orig.replace('</errorMessage>', '</errorMesage>'));
  h.log('1 malformed:', JSON.stringify(await state()));
  await h.shot(h.shots + '/xed-2-malformed.png');
  // 2. a formula Salesforce refuses (well-formed XML)
  await type(orig.replace(/<errorConditionFormula>[\s\S]*?<\/errorConditionFormula>/, '<errorConditionFormula>ISBLANK(SFTK_Live_Blk__c &amp;&amp;</errorConditionFormula>'));
  h.log('2 bad formula, before deploy:', JSON.stringify(await state()));
  await h.eval(`${panel}.querySelector('.fc-xml-ed-deploy').click()`);
  await confirm(h);
  await h.waitFor(`/refused|Deployed|accepted/.test(${panel}.querySelector('.fc-xml-ed-out')?.innerText || '')`, 180000, 500);
  h.log('2 bad formula, after deploy:', JSON.stringify(await state()));
  await h.shot(h.shots + '/xed-3-refused.png');
  if (process.env.DARK === '1') { await dark(h, true); await h.shot(h.shots + '/xed-3-refused-dark.png'); await dark(h, false); }
  h.log('CLI after the refused deploy:', cliFormula());
  // 3. a real edit
  const edited = orig.replace(/(<errorConditionFormula>)([\s\S]*?)(<\/errorConditionFormula>)/, (m, a, b, c) => `${a}${b.replace('FALSE', 'NOT(TRUE)')}${c}`).replace('<description>SFTK live demo, never fires</description>', '<description>SFTK live demo, never fires (edited in the XML editor)</description>');
  await type(edited);
  h.log('3 edit, before deploy:', JSON.stringify(await state()));
  await h.eval(`${panel}.querySelector('.fc-xml-ed-deploy').click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 20000, 200);
  h.log('dialog:', (await h.eval(`document.querySelector('.sftk-confirm, [role=dialog]')?.innerText || ''`)).replace(/\s+/g, ' ').slice(0, 600));
  await h.shot(h.shots + '/xed-4-dialog.png');
  if (process.env.DARK === '1') { await dark(h, true); await h.shot(h.shots + '/xed-4-dialog-dark.png'); await dark(h, false); }
  await confirm(h);
  await h.waitFor(`!!${panel}.querySelector('.fc-xml-ed-done') || /refused|accepted|Not deployed/.test(${panel}.querySelector('.fc-xml-ed-out')?.innerText || '')`, 180000, 500);
  h.log('3 edit, after deploy:', (await h.eval(`(${panel}.querySelector('.fc-xml-ed-done')?.innerText || ${panel}.querySelector('.fc-xml-ed-out')?.innerText || '').replace(/\\s+/g, ' ')`)).slice(0, 400));
  await h.eval(`${panel}.scrollIntoView({ block: 'start' })`); await h.sleep(300);
  await h.shot(h.shots + '/xed-5-deployed.png');
  if (process.env.DARK === '1') { await dark(h, true); await h.shot(h.shots + '/xed-5-deployed-dark.png'); await dark(h, false); }
  h.log('CLI after the edit:', cliFormula());
  // 4. undo through History
  const ent = (await h.eval(`sftkHistoryAll().then(all => all.filter(e => e && e.kind === 'tool' && /^✎ XML edited/.test(e.profileName || '') && e.toolUndo && !('none' in e.toolUndo)).map(e => ({ id: e.id, name: e.profileName })))`))[0];
  h.log('History entry:', JSON.stringify(ent));
  if (ent) { const p = h.eval(`sftkHistoryUndo(${JSON.stringify(ent.id)}).then(r => JSON.stringify(r).slice(0, 200))`); await confirm(h); h.log('↩ undo →', await p); }
  h.log('CLI after undo:', cliFormula());
}
