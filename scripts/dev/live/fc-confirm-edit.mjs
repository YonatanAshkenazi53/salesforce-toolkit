// LIVE, WRITES to npc (and undoes): the 2026-11-08 asks "the remove all & replace all button … on top of the card"
// and "we can't edit here" — the ⚡ buttons on the 🔒 section's header, and the ✂ / ⇄ confirm with "✎ Edit the XML
// before deploying": on the demo field's validation rule SFTK_Live_VR (Contact) the proposal (switch off) is edited by
// hand in the dialog (the description changed too) → deployed → the CLI reads both → undo → the CLI reads the original.
// DARK=1 shoots the header and the dialog in dark too.
import { execSync } from 'node:child_process';
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
const dark = async (h, on) => { await h.eval(`(() => { if (!document.getElementById('noTrans')) { const st = document.createElement('style'); st.id = 'noTrans'; st.textContent = '*{transition:none!important}'; document.head.appendChild(st); } document.body.classList.toggle('sftk-dark', ${on ? 'true' : 'false'}); document.body.classList.remove('sftk-oled'); return true; })()`); await h.sleep(250); };
const shot2 = async (h, name) => { await h.shot(`${h.shots}/${name}.png`); if (process.env.DARK === '1') { await dark(h, true); await h.shot(`${h.shots}/${name}-dark.png`); await dark(h, false); } };
let VR = process.env.VR || 'SFTK_Live_VR';
const cliVr = () => { try { const out = execSync(`sf data query --use-tooling-api -o npc --json -q "SELECT Active, Description, ErrorMessage FROM ValidationRule WHERE ValidationName = '${VR}'"`, { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] }); const r = JSON.parse(out).result.records[0]; return `${VR}: active=${r.Active} · description="${r.Description}" · message="${r.ErrorMessage}"`; } catch (e) { return 'CLI failed: ' + String(e.stdout || e.message).slice(0, 200); } };
export default async function (h) {
  h.log('CLI before:', cliVr());
  await h.login('npc'); await h.popup('fields'); await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', 'Account');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', 'SFTK_Live_Blk__c');
  await h.waitFor("!document.querySelector('#fcReplInput')?.disabled || !!document.querySelector('#fcReplNote .fc-repl-bad')", 60000, 500);
  await pick(h, '#fcReplInput', '#fcReplDrop', 'SFTK_Live_Blk2__c');
  await h.eval(`document.querySelector('#fcScope [data-scope="blockers"]').click()`); await h.sleep(300);
  await h.eval(`document.querySelector('#fcScanBtn').click()`);
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000); await h.sleep(2500);
  // 1. the ⚡ buttons on the section header, not in the bar
  h.log('section header:', await h.eval(`(document.querySelector('#fcSectionBlockers .fc-section-hdr')?.innerText || '').replace(/\\s+/g, ' ')`));
  h.log('⚡ in the act fold:', await h.eval(`!!document.querySelector('details[data-fold="act"] #fcFixEvery')`), '| in the section header:', await h.eval(`!!document.querySelector('#fcSectionBlockers .fc-section-hdr #fcFixEvery')`));
  await h.eval(`document.querySelector('#fcSectionBlockers')?.scrollIntoView({ block: 'start' })`); await h.sleep(300);
  await shot2(h, 'cf-1-section-header');
  // 2. ✂ on the Contact validation rule, edited by hand in the dialog
  // the first validation rule row with a ✂ (an active rule — a rule the owner switched off by hand is not a blocker)
  const picked = await h.eval(`(() => { const p = [...document.querySelectorAll('.fc-del-pair[data-type="ValidationRule"]')].find(x => x.dataset.name === ${JSON.stringify(VR)} && x.querySelector('.fc-edit-btn[data-swap="0"]')) || [...document.querySelectorAll('.fc-del-pair[data-type="ValidationRule"]')].find(x => x.querySelector('.fc-edit-btn[data-swap="0"]')); return p ? { id: p.dataset.id, name: p.dataset.name } : null; })()`);
  if (!picked) throw new Error('no validation rule with ✂ in the list — every demo rule is switched off; put one back on first');
  const row = picked.id; VR = picked.name;
  h.log('row:', JSON.stringify(picked));
  await h.eval(`document.querySelector('.fc-del-pair[data-id="${row}"] .fc-edit-btn[data-swap="0"]').click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo') && !!document.querySelector('#fcCfEdit')", 60000, 300); await h.sleep(300);
  await h.eval(`(() => { document.getElementById('fcCfEdit').open = true; return true; })()`); await h.sleep(300);
  h.log('edit box state:', await h.eval(`document.querySelector('#fcCfEdit .fc-cf-edit-state')?.textContent`));
  // a bad edit: the Go button goes off
  await h.eval(`(() => { const ta = document.querySelector('#fcCfEdit .fc-cf-ta'); ta.value = ta.value.replace('</description>', '</descriptio>'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await h.sleep(200);
  h.log('malformed →', await h.eval(`document.querySelector('#fcCfEdit .fc-cf-edit-state')?.textContent`), '| Go disabled:', await h.eval(`document.getElementById('sftkConfirmGo')?.disabled`));
  // the real hand edit: the proposal (active → false) plus a changed description
  await h.eval(`(() => { const ta = document.querySelector('#fcCfEdit .fc-cf-ta'); ta.value = ta.value.replace('</descriptio>', '</description>').replace(/<description>[^<]*<\\/description>/, '<description>SFTK live demo, edited in the confirm dialog</description>'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await h.sleep(300);
  h.log('edited →', await h.eval(`document.querySelector('#fcCfEdit .fc-cf-edit-state')?.textContent`), '| Go disabled:', await h.eval(`document.getElementById('sftkConfirmGo')?.disabled`));
  await shot2(h, 'cf-2-dialog-edit');
  await h.eval(`(() => { const a = document.getElementById('sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } document.getElementById('sftkConfirmGo').click(); return true; })()`);
  await h.waitFor(`document.getElementById('fcItem_${row}')?.classList.contains('fc-item-fixed') || !!document.querySelector('#fcItem_${row} .fc-item-err')`, 240000, 800);
  h.log('result:', (await h.eval(`(document.getElementById('fcItem_${row}')?.innerText || '').replace(/\\s+/g, ' ')`)).slice(0, 300));
  h.log('CLI after:', cliVr());
  // undo
  const ent = (await h.eval(`sftkHistoryAll().then(all => all.filter(e => e && e.kind === 'tool' && /^✂ Validation Rules —/.test(e.profileName || '') && e.toolUndo && !('none' in e.toolUndo)).map(e => ({ id: e.id, name: e.profileName })))`))[0];
  h.log('History entry:', JSON.stringify(ent));
  if (ent) { const p = h.eval(`sftkHistoryUndo(${JSON.stringify(ent.id)}).then(r => JSON.stringify(r).slice(0, 160))`); await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 200); await h.eval(`(() => { const a = document.getElementById('sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } document.getElementById('sftkConfirmGo').click(); return true; })()`); h.log('↩ undo →', await p); }
  h.log('CLI after undo:', cliVr());
}
