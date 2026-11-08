// LIVE, WRITES to npc: the 2026-11-08 Field Cleaner round on the demo field Account.SFTK_Live_Blk__c —
//   1. the header folds and the gate's chips (shots, light + DARK=1)
//   2. 🔍 on the Apex class: every line marked, ⇄ and ✎ in the header; the ✎ editor open (shots)
//   3. 🔍 on the duplicate rule: the ✂ / ⇄ previews and ✎, like every other kind (shot)
//   4. ⇄ Replace on the LWC (code: a whole-word rename) → the CLI reads the new name, 0 of the old
//   5. ⇄ Replace on the duplicate rule (XML) → the CLI retrieve shows the new field in the filter
//   6. UNDO=1 (default): both undone through History, newest first → the CLI reads the originals back
// Nothing is written outside the SFTK_Live fixture.
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
const confirm = async h => {
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 200);
  await h.eval(`(() => { const a = document.getElementById('sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
  await h.sleep(200);
  await h.eval(`document.getElementById('sftkConfirmGo').click()`);
};
const dark = async (h, on) => { await h.eval(`(() => { if (!document.getElementById('noTrans')) { const st = document.createElement('style'); st.id = 'noTrans'; st.textContent = '*{transition:none!important}'; document.head.appendChild(st); } document.body.classList.toggle('sftk-dark', ${on ? 'true' : 'false'}); document.body.classList.remove('sftk-oled'); return true; })()`); await h.sleep(250); };
const shot2 = async (h, name) => { await h.shot(`${h.shots}/${name}.png`); if (process.env.DARK === '1') { await dark(h, true); await h.shot(`${h.shots}/${name}-dark.png`); await dark(h, false); } };
const walk = (d, out = []) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p, out); else out.push(p); } return out; };
const count = (text, w) => (String(text).match(new RegExp(`(?<![A-Za-z0-9_])${w}(?![A-Za-z0-9_])`, 'gi')) || []).length;
const cliLwc = h => {
  try {
    const out = execSync('sf data query --use-tooling-api -o npc --json -q "SELECT FilePath, Source FROM LightningComponentResource WHERE LightningComponentBundle.DeveloperName = \'sftkLiveBlk\'"', { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const recs = JSON.parse(out).result.records || [];
    return recs.map(r => `${r.FilePath.split('/').pop()}: old ${count(r.Source, 'SFTK_Live_Blk__c')} · new ${count(r.Source, 'SFTK_Live_Blk2__c')}`).join(' | ');
  } catch (e) { return 'CLI failed: ' + String(e.stdout || e.message).slice(0, 200); }
};
const cliDupe = h => {
  const dir = mkdtempSync(join(tmpdir(), 'sftk-dr-'));
  try { execSync(`sf project retrieve start -m "DuplicateRule:Account.SFTK_Live_DR" --target-metadata-dir "${dir}" --unzip -o npc --wait 10`, { stdio: 'pipe', shell: true }); } catch (e) { return 'CLI retrieve failed: ' + String(e.stdout || e.message).slice(0, 200); }
  const f = walk(dir).find(p => /SFTK_Live_DR\.duplicateRule/.test(p));
  if (!f) return 'file not found';
  const x = readFileSync(f, 'utf8');
  return `filter names old ${count(x, 'SFTK_Live_Blk__c')} · new ${count(x, 'SFTK_Live_Blk2__c')}`;
};
export default async function (h) {
  const UNDO = process.env.UNDO !== '0';
  h.log('CLI before — LWC:', cliLwc(h)); h.log('CLI before — dupe rule:', cliDupe(h));
  await h.login('npc');
  await h.popup('fields');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', 'Account');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', 'SFTK_Live_Blk__c');
  await h.waitFor("!document.querySelector('#fcReplInput')?.disabled || !!document.querySelector('#fcReplNote .fc-repl-bad')", 60000, 500);
  await pick(h, '#fcReplInput', '#fcReplDrop', 'SFTK_Live_Blk2__c');
  await h.eval(`document.querySelector('#fcScope [data-scope="blockers"]').click()`); await h.sleep(300);
  await h.eval(`document.querySelector('#fcScanBtn').click()`);
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000); await h.sleep(2500);
  // 1. the header folds and the gate
  h.log('⚡ row:', await h.eval(`(document.querySelector('#fcFixEvery')?.innerText || '').replace(/\\s+/g, ' ')`));
  h.log('folds:', JSON.stringify(await h.eval(`[...document.querySelectorAll('details.fc-fold')].map(d => ({ key: d.dataset.fold, open: d.open, sum: d.querySelector('.fc-fold-sum')?.textContent }))`)));
  h.log('group all-buttons:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-fix-allbox')].map(b => ({ type: b.dataset.type, n: b.dataset.n, btns: [...b.querySelectorAll('button')].map(x => x.textContent.trim()) }))`)));
  h.log('gate:', (await h.eval(`(document.querySelector('.fc-delete-zone')?.innerText || '').replace(/\\s+/g, ' ')`)).slice(0, 900));
  h.log('chips:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-blocker-chip')].map(c => ({ t: c.textContent.trim(), group: c.dataset.group, title: c.title }))`)).slice(0, 1500));
  await h.eval(`document.querySelector('#fcStatus')?.scrollIntoView({ block: 'start' })`); await h.sleep(300);
  await shot2(h, 'code-1-header-open');
  await h.eval(`document.querySelectorAll('details.fc-fold').forEach(d => { d.open = false; })`); await h.sleep(500);
  h.log('folded summaries:', JSON.stringify(await h.eval(`[...document.querySelectorAll('details.fc-fold')].map(d => ({ key: d.dataset.fold, sum: d.querySelector('.fc-fold-sum')?.textContent }))`)));
  await shot2(h, 'code-2-header-folded');
  await h.eval(`document.querySelectorAll('details.fc-fold').forEach(d => { d.open = d.dataset.fold !== 'further'; })`); await h.sleep(300);
  await h.eval(`document.querySelector('.fc-delete-zone')?.scrollIntoView({ block: 'center' })`); await h.sleep(300);
  await shot2(h, 'code-3-gate-chips');
  // a chip jumps to its group
  await h.eval(`document.querySelector('.fc-blocker-chip[data-type="ApexClass"]')?.click()`); await h.sleep(900);
  h.log('chip click → group flashed:', await h.eval(`!!document.querySelector('#fcGroup_ApexClass.fc-group-flash')`));
  // 2. 🔍 on the Apex class
  const rowOf = async type => h.eval(`(() => { const p = document.querySelector('.fc-del-pair[data-type="${type}"], .fc-fix-pair[data-type="${type}"]'); return p ? { id: p.dataset.id, name: p.dataset.name, btns: [...p.querySelectorAll('button')].map(b => b.textContent.trim()) } : null; })()`);
  const apex = await rowOf('ApexClass'); h.log('Apex row:', JSON.stringify(apex));
  const panel = id => `document.getElementById('fcXml_${id}')`;
  await h.eval(`document.querySelector('.fc-inspect-btn[data-id="${apex.id}"]').click()`);
  await h.waitFor(`!!${panel(apex.id)}?.querySelector('.fc-xml-edit-btn')`, 60000, 400); await h.sleep(300);
  h.log('Apex 🔍 header:', (await h.eval(`(${panel(apex.id)}.querySelector('.fc-xml-hdr')?.innerText || '').replace(/\\s+/g, ' ')`)));
  h.log('Apex 🔍 hint:', (await h.eval(`(${panel(apex.id)}.querySelector('.fc-xml-hint')?.innerText || '').replace(/\\s+/g, ' ')`)));
  h.log('Apex files:', JSON.stringify(await h.eval(`[...${panel(apex.id)}.querySelectorAll('.fc-code-file-hd')].map(x => x.innerText.replace(/\\s+/g, ' '))`)));
  await h.eval(`${panel(apex.id)}.scrollIntoView({ block: 'start' })`); await h.sleep(300);
  await shot2(h, 'code-4-apex-inspect');
  await h.eval(`${panel(apex.id)}.querySelector('.fc-xml-edit-btn').click()`);
  await h.waitFor(`!!${panel(apex.id)}.querySelector('.fc-code-ta')`, 10000, 200); await h.sleep(300);
  h.log('editor state:', await h.eval(`${panel(apex.id)}.querySelector('.fc-xml-ed-state')?.textContent`), '· deploy off:', await h.eval(`${panel(apex.id)}.querySelector('.fc-xml-ed-deploy')?.disabled`));
  await h.eval(`(() => { const ta = ${panel(apex.id)}.querySelector('.fc-code-ta'); ta.value = ta.value + '\\n// edited in the harness'; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await h.sleep(300);
  h.log('editor after a typed line:', await h.eval(`${panel(apex.id)}.querySelector('.fc-xml-ed-state')?.textContent`), '· deploy off:', await h.eval(`${panel(apex.id)}.querySelector('.fc-xml-ed-deploy')?.disabled`));
  await shot2(h, 'code-5-apex-editor');
  await h.eval(`${panel(apex.id)}.querySelector('.fc-xml-ed-cancel').click()`); await h.sleep(1500);
  await h.eval(`${panel(apex.id)}.querySelector('.fc-xml-close')?.click()`); await h.sleep(200);
  // 3. 🔍 on the duplicate rule
  const dupe = await rowOf('DuplicateRule'); h.log('Dupe row:', JSON.stringify(dupe));
  await h.eval(`document.querySelector('.fc-inspect-btn[data-id="${dupe.id}"]').click()`);
  await h.waitFor(`!!${panel(dupe.id)}?.querySelector('.fc-xml-edit-btn')`, 60000, 400); await h.sleep(300);
  h.log('Dupe 🔍 previews:', (await h.eval(`[...${panel(dupe.id)}.querySelectorAll('.fc-xml-prev-hd, .fc-xml-hint')].map(x => x.innerText.replace(/\\s+/g, ' ')).join(' ‖ ')`)).slice(0, 600));
  await h.eval(`${panel(dupe.id)}.scrollIntoView({ block: 'start' })`); await h.sleep(300);
  await shot2(h, 'code-6-dupe-inspect');
  await h.eval(`${panel(dupe.id)}.querySelector('.fc-xml-close')?.click()`); await h.sleep(200);
  // 4. ⇄ on the LWC
  const lwc = await rowOf('LightningComponentBundle'); h.log('LWC row:', JSON.stringify(lwc));
  await h.eval(`document.querySelector('.fc-del-pair[data-id="${lwc.id}"] .fc-edit-btn[data-way="code"]').click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 60000, 300);
  h.log('LWC dialog:', (await h.eval(`(document.querySelector('.sftk-confirm, [role=dialog]')?.innerText || '').replace(/\\s+/g, ' ')`)).slice(0, 700));
  await shot2(h, 'code-7-lwc-dialog');
  await confirm(h);
  await h.waitFor(`document.getElementById('fcItem_${lwc.id}')?.classList.contains('fc-item-fixed') || !!document.querySelector('#fcItem_${lwc.id} .fc-item-err')`, 240000, 800);
  h.log('LWC result:', (await h.eval(`(document.getElementById('fcItem_${lwc.id}')?.innerText || '').replace(/\\s+/g, ' ')`)).slice(0, 400));
  h.log('CLI after ⇄ — LWC:', cliLwc(h));
  h.log('gate after one fix:', (await h.eval(`(document.querySelector('.fc-delete-zone .fc-blockers')?.innerText || '').replace(/\\s+/g, ' ')`)).slice(0, 300));
  // 5. ⇄ on the duplicate rule
  await h.eval(`document.querySelector('.fc-del-pair[data-id="${dupe.id}"] .fc-edit-btn[data-swap="1"]').click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 60000, 300);
  h.log('Dupe dialog:', (await h.eval(`(document.querySelector('.sftk-confirm, [role=dialog]')?.innerText || '').replace(/\\s+/g, ' ')`)).slice(0, 500));
  await confirm(h);
  await h.waitFor(`document.getElementById('fcItem_${dupe.id}')?.classList.contains('fc-item-fixed') || !!document.querySelector('#fcItem_${dupe.id} .fc-item-err')`, 240000, 800);
  h.log('Dupe result:', (await h.eval(`(document.getElementById('fcItem_${dupe.id}')?.innerText || '').replace(/\\s+/g, ' ')`)).slice(0, 400));
  h.log('CLI after ⇄ — dupe rule:', cliDupe(h));
  await h.eval(`document.getElementById('fcItem_${lwc.id}')?.scrollIntoView({ block: 'center' })`); await h.sleep(300);
  await shot2(h, 'code-8-after');
  // 6. undo, newest first
  if (UNDO) {
    const ents = await h.eval(`sftkHistoryAll().then(all => all.filter(e => e && e.kind === 'tool' && /^⇄ (Lightning Web Components|Duplicate Rules) —/.test(e.profileName || '') && e.toolUndo && !('none' in e.toolUndo)).map(e => ({ id: e.id, name: e.profileName, at: e.at || e.startedAt || 0 })).sort((a, b) => b.at - a.at).slice(0, 2))`);
    h.log('History entries:', JSON.stringify(ents));
    for (const ent of ents) { const p = h.eval(`sftkHistoryUndo(${JSON.stringify(ent.id)}).then(r => JSON.stringify(r).slice(0, 300))`); await confirm(h); h.log('↩ undo', ent.name, '→', await p); }
    h.log('CLI after undo — LWC:', cliLwc(h)); h.log('CLI after undo — dupe rule:', cliDupe(h));
  }
}
