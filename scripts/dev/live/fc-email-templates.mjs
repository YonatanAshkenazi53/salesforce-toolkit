// LIVE, WRITES to npc (and undoes): ⇄ Replace on the three demo email templates — classic text (SFTK_Live_Email),
// Lightning (SFTK_Live_EmailSFX), Visualforce (SFTK_Live_EmailVF) — through the EmailTemplate record (user 2026-11-08:
// "i want also email alerts, lightning email templates and classic email templates"). Then 🔍 on one, its ✎ editor
// opened, and every ⇄ undone through History; the CLI reads the texts before, after and after the undo.
// WAY=remove does ✂ instead. DARK=1 shoots the inspector in dark too.
import { execSync } from 'node:child_process';
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
const confirm = async h => { await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 200); await h.eval(`(() => { const a = document.getElementById('sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`); await h.sleep(200); await h.eval(`document.getElementById('sftkConfirmGo').click()`); };
const dark = async (h, on) => { await h.eval(`(() => { if (!document.getElementById('noTrans')) { const st = document.createElement('style'); st.id = 'noTrans'; st.textContent = '*{transition:none!important}'; document.head.appendChild(st); } document.body.classList.toggle('sftk-dark', ${on ? 'true' : 'false'}); document.body.classList.remove('sftk-oled'); return true; })()`); await h.sleep(250); };
const shot2 = async (h, name) => { await h.shot(`${h.shots}/${name}.png`); if (process.env.DARK === '1') { await dark(h, true); await h.shot(`${h.shots}/${name}-dark.png`); await dark(h, false); } };
const cli = () => { try { const out = execSync('sf data query -o npc --json -q "SELECT DeveloperName, Subject, Body, HtmlValue, Markup FROM EmailTemplate WHERE DeveloperName LIKE \'SFTK_Live_Email%\' ORDER BY DeveloperName"', { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] }); return JSON.parse(out).result.records.map(r => `${r.DeveloperName}: ${[r.Subject, r.Body, r.HtmlValue, r.Markup].filter(Boolean).join(' ¦ ').replace(/\s+/g, ' ').slice(0, 140)}`).join('\n      '); } catch (e) { return 'CLI failed: ' + String(e.stdout || e.message).slice(0, 200); } };
export default async function (h) {
  const swap = process.env.WAY !== 'remove';
  h.log('CLI before:\n      ' + cli());
  await h.login('npc'); await h.popup('fields'); await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', 'Account');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', 'SFTK_Live_Blk__c');
  await h.waitFor("!document.querySelector('#fcReplInput')?.disabled || !!document.querySelector('#fcReplNote .fc-repl-bad')", 60000, 500);
  await pick(h, '#fcReplInput', '#fcReplDrop', 'SFTK_Live_Blk2__c');
  await h.eval(`document.querySelector('#fcScope [data-scope="mentions"]').click()`); await h.sleep(300);
  await h.eval(`document.querySelector('#fcScanBtn').click()`);
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000); await h.sleep(2000);
  const rows = await h.eval(`[...document.querySelectorAll('.fc-fix-pair[data-type="EmailTemplate"]')].map(p => ({ id: p.dataset.id, name: p.dataset.name, btns: [...p.querySelectorAll('button')].map(b => b.textContent.trim()) }))`);
  h.log('template rows:', JSON.stringify(rows));
  if (!rows.length) throw new Error('no email template rows — the index did not list the demo templates');
  // 🔍 on the Lightning one, and its ✎ editor
  const sfx = rows.find(r => /SFX/.test(r.name)) || rows[0];
  const panel = `document.getElementById('fcXml_${sfx.id}')`;
  await h.eval(`document.querySelector('.fc-inspect-btn[data-id="${sfx.id}"]').click()`);
  await h.waitFor(`!!${panel}?.querySelector('.fc-xml-edit-btn')`, 60000, 400); await h.sleep(300);
  h.log('🔍 header:', (await h.eval(`(${panel}.querySelector('.fc-xml-hdr')?.innerText || '').replace(/\\s+/g, ' ')`)));
  h.log('🔍 hint:', (await h.eval(`(${panel}.querySelector('.fc-xml-hint')?.innerText || '').replace(/\\s+/g, ' ')`)));
  await h.eval(`${panel}.scrollIntoView({ block: 'start' })`); await h.sleep(300);
  await shot2(h, 'tpl-1-inspect');
  await h.eval(`${panel}.querySelector('.fc-xml-edit-btn').click()`);
  await h.waitFor(`!!${panel}.querySelector('.fc-tpl-ta')`, 10000, 200); await h.sleep(300);
  h.log('editor fields:', JSON.stringify(await h.eval(`[...${panel}.querySelectorAll('.fc-tpl-ta')].map(t => t.dataset.k + ':' + t.value.length)`)));
  await shot2(h, 'tpl-2-editor');
  await h.eval(`${panel}.querySelector('.fc-xml-ed-cancel').click()`); await h.sleep(800);
  await h.eval(`${panel}.querySelector('.fc-xml-close')?.click()`); await h.sleep(200);
  // ⇄ (or ✂) on each
  for (const r of rows) {
    const sel = swap ? `.fc-fix-pair[data-id="${r.id}"] .fc-fix-btn[data-swap="1"]` : `.fc-fix-pair[data-id="${r.id}"] .fc-fix-btn[data-swap="0"]`;
    await h.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
    await confirm(h);
    await h.waitFor(`document.getElementById('fcItem_${r.id}')?.classList.contains('fc-item-fixed') || !!document.querySelector('#fcItem_${r.id} .fc-item-err')`, 240000, 800);
    h.log(`${swap ? '⇄' : '✂'} ${r.name} →`, (await h.eval(`(document.getElementById('fcItem_${r.id}')?.innerText || '').replace(/\\s+/g, ' ')`)).slice(0, 260));
  }
  await h.eval(`document.querySelector('#fcGroup_EmailTemplate')?.scrollIntoView({ block: 'center' })`); await h.sleep(300);
  await shot2(h, 'tpl-3-after');
  h.log('CLI after:\n      ' + cli());
  // undo, newest first
  const ents = await h.eval(`sftkHistoryAll().then(all => all.filter(e => e && e.kind === 'tool' && /^(⇄|✂) Email template —/.test(e.profileName || '') && e.toolUndo && !('none' in e.toolUndo)).map(e => ({ id: e.id, name: e.profileName, at: e.at || e.startedAt || 0 })).sort((a, b) => b.at - a.at).slice(0, 3))`);
  h.log('History entries:', JSON.stringify(ents.map(e => e.name)));
  for (const ent of ents) { const p = h.eval(`sftkHistoryUndo(${JSON.stringify(ent.id)}).then(r => JSON.stringify(r).slice(0, 120))`); await confirm(h); h.log('↩', ent.name.slice(0, 60), '→', await p); }
  h.log('CLI after undo:\n      ' + cli());
}
