// LIVE, WRITES to npc: ✂ Remove / ⇄ Replace INSIDE the demo field's blockers (user 2026-11-07: "we try to
// remove, replace the field in the metadata items without breaking them. While showing XML").
//   WAY=remove|replace|both (default both: every ✂ first, then every ⇄ with REPL)
//   REPL=<field> the replacement picked before the scan (default SFTK_Live_Blk2__c)
//   TYPES=a,b    only these kinds          OBJ / FIELD  (default Account / SFTK_Live_Blk__c)
//   CLI=1        after the edits, the CLI retrieves every edited component and greps it (before any undo)
//   UNDO=1       in the SAME session (History lives in the browser profile) every edit is undone through
//                History, newest first, and the CLI reads the originals back
//   DARK=1       the inspector and the dialog shot in dark too
// Nothing is written outside the SFTK_Live fixture. Rebuild the fixture (scripts/dev/live/demo) if a run stops halfway.
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
const confirm = async h => { await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 20000, 200); await h.eval(`(() => { const a = document.getElementById('sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`); await h.sleep(200); await h.eval(`document.getElementById('sftkConfirmGo').click()`); };
// the headless page renders no frames between shots, so a CSS transition never ends: switched off for the shots
const dark = async (h, on) => { await h.eval(`(() => { if (!document.getElementById('noTrans')) { const st = document.createElement('style'); st.id = 'noTrans'; st.textContent = '*{transition:none!important}'; document.head.appendChild(st); } document.body.classList.toggle('sftk-dark', ${on}); return true; })()`); await h.sleep(600); };
const walk = (d, out = []) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p, out); else out.push(p); } return out; };
// one CLI retrieve of every component, then the field / the new field grepped per file
function cliRead(h, comps, tag) {
  if (!comps.length) return;
  const dir = mkdtempSync(join(tmpdir(), 'sftk-edit-'));
  const ms = [...new Set(comps.map(c => `-m "${c.mdType}:${c.fullName}"`))].join(' ');
  try { execSync(`sf project retrieve start ${ms} --target-metadata-dir "${dir}" --unzip -o npc --wait 10`, { stdio: 'pipe', shell: true }); } catch (e) { h.log('CLI retrieve failed:', String(e.stdout || e.message).slice(0, 400)); return; }
  const files = walk(dir).filter(f => !/package\.xml$/.test(f));
  for (const c of comps) {
    const short = c.fullName.includes('.') ? c.fullName.slice(c.fullName.indexOf('.') + 1) : c.fullName;
    const file = files.find(f => f.split(/[\\/]/).pop().startsWith(c.fullName + '.')) || files.find(f => f.includes(c.fullName.split('.')[0]) && readFileSync(f, 'utf8').includes(short)) || files.find(f => readFileSync(f, 'utf8').includes(`<fullName>${short}</fullName>`));
    if (!file) { h.log(`CLI ${tag}`, c.mdType, c.fullName, '→ file not found'); continue; }
    let x = readFileSync(file, 'utf8');
    // the component's own element when it lives inside its parent's file
    const at = x.indexOf(`<fullName>${short}</fullName>`);
    if (at > 0 && c.tag) { const open = x.lastIndexOf(`<${c.tag}>`, at), close = x.indexOf(`</${c.tag}>`, at); if (open >= 0 && close > at) x = x.slice(open, close); }
    const old = (x.match(new RegExp(`(?<![A-Za-z0-9_])${c.field}(?![A-Za-z0-9_])`, 'gi')) || []).length;
    const neu = c.swapTo ? (x.match(new RegExp(`(?<![A-Za-z0-9_])${c.swapTo}(?![A-Za-z0-9_])`, 'gi')) || []).length : 0;
    const active = (x.match(/<active>(true|false)<\/active>/) || [])[1];
    h.log(`CLI ${tag}`, c.mdType, c.fullName, `→ names ${c.field}: ${old}`, c.swapTo ? `· names ${c.swapTo}: ${neu}` : '', active ? `· active=${active}` : '');
  }
}
export default async function (h) {
  const OBJ = process.env.OBJ || 'Account', FIELD = process.env.FIELD || 'SFTK_Live_Blk__c', REPL = process.env.REPL === '-' ? '' : (process.env.REPL || 'SFTK_Live_Blk2__c');
  const WAY = process.env.WAY || 'both';
  const only = (process.env.TYPES || '').split(',').map(s => s.trim()).filter(Boolean);
  await h.login('npc');
  await h.popup('fields');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', OBJ);
  await pick(h, '#fcFieldInput', '#fcFieldDrop', FIELD);
  if (REPL) {
    await h.waitFor("!document.querySelector('#fcReplInput')?.disabled || !!document.querySelector('#fcReplNote .fc-repl-bad')", 60000, 500);
    await pick(h, '#fcReplInput', '#fcReplDrop', REPL);
  }
  // SCOPE=blockers|both|mentions (default blockers; the 👀 mention kinds need both or mentions)
  await h.eval(`document.querySelector('#fcScope [data-scope="${process.env.SCOPE || 'blockers'}"]').click()`); await h.sleep(300);
  await h.eval(`document.querySelector('#fcScanBtn').click()`);
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000); await h.sleep(1500);
  const rows = await h.eval(`[...document.querySelectorAll('.fc-del-pair, .fc-fix-pair')].map(p => ({ type: p.dataset.type, id: p.dataset.id, name: p.dataset.name, btns: [...p.querySelectorAll('button')].map(b => b.textContent.trim()) }))`);
  h.log(`rows: ${rows.length}`); for (const r of rows) h.log('   ', r.type, '·', r.name, '·', r.btns.join(' | '));
  h.log('gate:', await h.eval(`(document.querySelector('.fc-delete-zone .fc-blockers')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 700)`));
  await h.eval(`document.querySelector('#fcSectionBlockers')?.scrollIntoView({ block: 'start' })`); await h.sleep(400);
  await h.shot(h.shots + '/edit-0-buttons.png');
  // the inspector on three kinds (the XML, the marked lines, the ✂ and ⇄ previews)
  for (const t of (process.env.INSPECT || 'WorkflowOutboundMessage,ValidationRule,WorkflowRule').split(',').filter(Boolean)) {
    const ok = await h.eval(`(() => { const b = document.querySelector('.fc-inspect-btn[data-type="${t}"]'); if (!b) return false; b.click(); return true; })()`);
    if (!ok) { h.log('no 🔍 for', t); continue; }
    await h.waitFor(`(() => { const b = document.querySelector('.fc-inspect-btn[data-type="${t}"]'); const p = b && document.getElementById('fcXml_' + b.dataset.id); return !!p && !p.querySelector('.fc-xml-loading'); })()`, 60000, 400);
    const id = await h.eval(`document.querySelector('.fc-inspect-btn[data-type="${t}"]').dataset.id`);
    h.log(`🔍 ${t}:`, (await h.eval(`document.getElementById('fcXml_${id}').innerText`)).replace(/\s+/g, ' ').slice(0, 900));
    await h.eval(`document.getElementById('fcXml_${id}').scrollIntoView({ block: 'start' })`); await h.sleep(500);
    await h.shot(h.shots + `/edit-1-inspect-${t}.png`);
    if (process.env.DARK === '1') { await dark(h, true); await h.shot(h.shots + `/edit-1-inspect-${t}-dark.png`); await dark(h, false); }
    await h.eval(`document.getElementById('fcXml_${id}').querySelector('.fc-xml-close')?.click()`); await h.sleep(300);
  }
  const results = [];
  const run = async swap => {
    const sel = `.fc-edit-btn[data-swap="${swap ? 1 : 0}"]`;
    const todo = (await h.eval(`[...document.querySelectorAll('${sel}')].map(b => ({ type: b.dataset.type, id: b.dataset.id, name: b.dataset.name }))`)).filter(b => !only.length || only.includes(b.type));
    for (const b of todo) {
      const q = `${sel}[data-id="${b.id}"][data-type="${b.type}"]`;
      if (!(await h.eval(`!!document.querySelector('${q}')`))) { h.log('gone before its turn:', b.type, b.name); continue; }
      await h.eval(`document.querySelector('${q}').click()`);
      // a refusal is said on the row without a dialog; an edit opens the confirm with the XML diff
      await h.waitFor(`!!document.querySelector('#sftkConfirmGo') || !!document.getElementById('fcItem_${b.id}')?.querySelector('.fc-item-err')`, 60000, 300);
      const dlg = await h.eval(`!!document.querySelector('#sftkConfirmGo')`);
      if (dlg) {
        if (!results.some(r => r.dialog)) {
          h.log('dialog:', (await h.eval(`document.querySelector('.sftk-confirm, [role=dialog]')?.innerText || ''`)).replace(/\s+/g, ' ').slice(0, 700));
          await h.shot(h.shots + `/edit-2-dialog-${swap ? 'replace' : 'remove'}.png`);
          if (process.env.DARK === '1') { await dark(h, true); await h.shot(h.shots + `/edit-2-dialog-${swap ? 'replace' : 'remove'}-dark.png`); await dark(h, false); }
        }
        await confirm(h);
        await h.waitFor(`(() => { const it = document.getElementById('fcItem_${b.id}'); return !!it && (it.classList.contains('fc-item-fixed') || !!it.querySelector('.fc-item-err')); })()`, 300000, 500);
      }
      const out = await h.eval(`(() => { const it = document.getElementById('fcItem_${b.id}'); return { fixed: it.classList.contains('fc-item-fixed'), text: (it.querySelector('.fc-item-ok')?.innerText || [...it.querySelectorAll('.fc-item-err')].map(e => e.innerText).join(' / ') || it.innerText).replace(/\\s+/g, ' ').slice(0, 400) }; })()`);
      h.log(out.fixed ? '✅' : (dlg ? '❌' : '⛔'), swap ? '⇄' : '✂', b.type, b.name, '→', out.text);
      results.push({ ...b, swap, dialog: dlg, ...out });
      // a refused row keeps its buttons; clear the message so the next phase starts clean
      await h.eval(`document.getElementById('fcItem_${b.id}')?.querySelectorAll('.fc-item-err').forEach(e => e.remove())`);
      await h.sleep(400);
    }
  };
  const undone = new Set();
  const undoAll = async () => {
    const entries = (await h.eval(`sftkHistoryAll().then(all => all.filter(e => e && e.kind === 'tool' && /^[✂⇄]/.test(e.profileName || '')).map(e => ({ id: e.id, name: e.profileName })))`)).filter(e => !undone.has(e.id));
    entries.forEach(e => undone.add(e.id));
    h.log(`History undo: ${entries.length} entries`);
    for (const ent of entries) {
      const p = h.eval(`sftkHistoryUndo(${JSON.stringify(ent.id)}).then(r => JSON.stringify(r).slice(0, 300))`);
      await confirm(h);
      h.log('↩', ent.name.slice(0, 120), '→', await p);
    }
  };
  const snaps = async () => (await h.eval(`chrome.storage.local.get('fc_fix_snapshots').then(s => (s.fc_fix_snapshots || []).filter(x => x.type === 'MdEdit').map(x => ({ mdType: x.metadata.mdType, fullName: x.fullName, type: x.metadata.type, swapTo: x.metadata.swapTo })))`));
  const TAG = { ValidationRule: 'validationRules', CustomField: 'fields', WebLink: 'webLinks', FieldSet: 'fieldSets', WorkflowRule: 'rules', WorkflowFieldUpdate: 'fieldUpdates', WorkflowAlert: 'alerts', WorkflowOutboundMessage: 'outboundMessages', SharingCriteriaRule: 'sharingCriteriaRules', MatchingRule: 'matchingRules', AssignmentRule: 'assignmentRule', EscalationRule: 'escalationRule' };
  const cliComps = list => list.map(s => ({ mdType: s.mdType, fullName: s.fullName, field: FIELD, swapTo: s.swapTo, tag: TAG[s.mdType] }));
  const phase = async swap => {
    const before = (await snaps()).length;
    await run(swap);
    await h.eval(`document.querySelector('.fc-item-fixed')?.scrollIntoView({ block: 'start' })`); await h.sleep(400);
    await h.shot(h.shots + `/edit-3-after-${swap ? 'replace' : 'remove'}.png`);
    if (process.env.DARK === '1') { await h.eval(`document.querySelector('.fc-item-fixed .fc-xml-done')?.setAttribute('open', '')`); await dark(h, true); await h.shot(h.shots + `/edit-3-after-${swap ? 'replace' : 'remove'}-dark.png`); await dark(h, false); }
    h.log('gate after:', await h.eval(`(document.querySelector('.fc-delete-zone .fc-blockers')?.innerText || '(no blockers box)').replace(/\\s+/g, ' ').slice(0, 500)`));
    const mine = (await snaps()).slice(0, (await snaps()).length - before);
    if (process.env.CLI === '1') cliRead(h, cliComps(mine), swap ? '⇄ after' : '✂ after');
    if (process.env.UNDO === '1') { await undoAll(); if (process.env.CLI === '1') cliRead(h, cliComps(mine).map(c => ({ ...c, swapTo: null })), 'after undo'); }
  };
  if (WAY === 'remove' || WAY === 'both') await phase(false);
  if ((WAY === 'replace' || WAY === 'both') && REPL) {
    if (WAY === 'both' && process.env.UNDO === '1') {
      // a fresh scan after the undo: every row back with its buttons
      await h.eval(`document.querySelector('#fcScanBtn').click()`);
      await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000); await h.sleep(1500);
    }
    await phase(true);
  }
  return results.map(r => `${r.fixed ? 'OK' : r.dialog ? 'FAIL' : 'REFUSED'} ${r.swap ? '⇄' : '✂'} ${r.type} ${r.name}`);
}
