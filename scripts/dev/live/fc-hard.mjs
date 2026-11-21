// LIVE, WRITES to npc2 and undoes it in the same run: ✂ Remove on the HARDER fixture
// (docs/fixtures/packaged-object-fixture/hard-app — owner 2026-11-20: "I want to test on the field a remove from more
// complex metadata items. and to test remove with a few diferent refrences per xml or metadata type.").
// Field: dlrs__LookupChild__c.SFTK_Pkg_Tag__c. For every fixture item (name holds "Hard"):
//   BEFORE  the item's source, retrieved by the CLI
//   ✂       its own remove, from its row (STEP=list stops before this and only lists the rows and their buttons)
//   AFTER   retrieved again: no line names the field; every other line is as it was (a line diff)
//   ↩       Undo all → retrieved a third time: identical to BEFORE
// ONLY=<regex on the row name> narrows the set. Code (class, trigger) has no ✂ by design and is only listed.
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const ORG = 'npc2', OBJ = 'dlrs__LookupChild__c', FIELD = 'SFTK_Pkg_Tag__c';
const MEMBERS = ['ValidationRule:dlrs__LookupChild__c.SFTK_Hard_VR', 'CustomField:dlrs__LookupChild__c.SFTK_Hard_Formula__c', 'ListView:dlrs__LookupChild__c.SFTK_Hard_View',
  'Flow:SFTK_Hard_Flow', 'Layout:dlrs__LookupChild__c-SFTK Hard Layout', 'Layout:dlrs__LookupParent__c-SFTK Hard Parent Layout', 'Report:unfiled$public/SFTK_Hard_Report', 'FlexiPage:SFTK_Hard_Page'];
const TMP = join(process.env.LOCALAPPDATA, 'Temp', 'sftk-fc-hard');
// the items as the org holds them now → { relative path: text }
function retrieve(tag) {
  const dir = join(TMP, tag); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: '64.0' }));
  mkdirSync(join(dir, 'force-app'), { recursive: true });
  execSync(`sf project retrieve start -o ${ORG} ${MEMBERS.map(m => `-m "${m.replace(/\$/g, '\\$')}"`).join(' ')} --json`, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: 'bash' });
  const out = {};
  (function walk(d, rel) { for (const n of readdirSync(d)) { const p = join(d, n), r = rel ? rel + '/' + n : n; if (statSync(p).isDirectory()) walk(p, r); else out[r.replace(/^main\/default\//, '')] = readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); } })(join(dir, 'force-app'), '');
  return out;
}
const names = t => (t.match(new RegExp(FIELD, 'g')) || []).length;
// lines of `a` missing from `b`, and lines of `b` that `a` did not have (as multisets)
function lineDiff(a, b) {
  const count = t => { const m = new Map(); for (const l of t.split('\n').map(x => x.trim()).filter(Boolean)) m.set(l, (m.get(l) || 0) + 1); return m; };
  const A = count(a), B = count(b), gone = [], came = [];
  for (const [l, n] of A) { const d = n - (B.get(l) || 0); for (let i = 0; i < d; i++) gone.push(l); }
  for (const [l, n] of B) { const d = n - (A.get(l) || 0); for (let i = 0; i < d; i++) came.push(l); }
  return { gone, came };
}
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
const confirm = async (h, ms = 30000) => {
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", ms, 200);
  await h.eval(`(() => { const a = document.getElementById('sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
  await h.sleep(250);
  await h.eval(`document.getElementById('sftkConfirmGo').click()`);
};
// every row of the scan whose name holds "Hard": its kind, its id and the buttons it offers
const ROWS = `(() => { const seen = new Set(), out = [];
  for (const el of document.querySelectorAll('[data-id][data-type]')) {
    const row = el.closest('.fc-del-pair, .fc-fix-pair, .fc-dep-item, .fc-item, li, tr') || el.parentElement;
    const name = el.dataset.name || row?.dataset?.name || '';
    if (!/hard/i.test(name) || seen.has(el.dataset.id)) continue;
    seen.add(el.dataset.id);
    const scope = row || el;
    out.push({ id: el.dataset.id, type: el.dataset.type, name, buttons: [...new Set([...scope.querySelectorAll('button')].map(b => (b.textContent.trim().slice(0, 28) + (b.disabled ? ' (off)' : '')) + ' .' + [...b.classList].filter(c => /^fc-/.test(c)).join('.')))] });
  }
  return out; })()`;

export default async function (h) {
  const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;
  const before = retrieve('before');
  h.log('BEFORE (CLI):', Object.entries(before).map(([f, t]) => `${f.split('/').pop().replace(/-meta\.xml$/, '')} names the field ×${names(t)}`).join(' · '));
  await h.login(ORG); await h.popup('fields'); await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', OBJ);
  await pick(h, '#fcFieldInput', '#fcFieldDrop', FIELD);
  const scanDone = async () => { await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 900000, 1000); await h.sleep(2000); };
  await h.eval(`document.querySelector('#fcScanBtn').click()`); await h.sleep(500);
  await scanDone();
  // reports are read by their own scan (📊 Scan the reports… → ▶ Scan N reports)
  if (process.env.REPORTS !== '0' && await h.eval("!!document.querySelector('#fcRptCount')")) {
    await h.eval("document.querySelector('#fcRptCount').click()");
    await h.waitFor("!!document.querySelector('#fcRptGo') || /no reports|could not/i.test(document.querySelector('#fcRptScan')?.innerText || '')", 120000, 500).catch(() => {});
    if (await h.eval("!!document.querySelector('#fcRptGo')")) {
      await h.eval("document.querySelector('#fcRptGo').click()");
      await h.waitFor("!document.querySelector('#fcRptGo') && !/reading|scanning|…/i.test((document.querySelector('#fcRptScan')?.innerText || '').slice(0, 80))", 600000, 1500).catch(() => {});
      await h.sleep(2500);
    }
    h.log('REPORT SCAN:', (await h.text('#fcRptScan')).replace(/s+/g, ' ').slice(0, 300));
  }
  const rows = (await h.eval(ROWS)).filter(r => !ONLY || ONLY.test(r.name));
  for (const r of rows) h.log(`ROW ${r.type} “${r.name}” ${r.id} →`, r.buttons.join(' | '));
  if (process.env.STEP === 'list') return;
  // ── ✂ every item that offers one ──
  const done = [];
  for (const r of rows) {
    const sel = `[data-id="${r.id}"]`;
    const clicked = await h.eval(`(() => { const cands = [...document.querySelectorAll('button${sel}, [data-id="${r.id}"] button, .fc-fix-pair${sel} button, .fc-del-pair${sel} button')]; const row = document.querySelector('.fc-fix-pair${sel}, .fc-del-pair${sel}') || document.querySelector('${sel}')?.closest('.fc-fix-pair, .fc-del-pair, li'); const all = row ? [...row.querySelectorAll('button')] : cands; const b = all.find(b => /^✂/.test(b.textContent.trim()) && !b.disabled); if (!b) return ''; b.scrollIntoView({ block: 'center' }); b.click(); return b.textContent.trim().slice(0, 40); })()`);
    if (!clicked) { h.log(`✂ ${r.type} “${r.name}”: no ✂ offered — left as it is`); continue; }
    // a kind that asks HOW first (a validation rule: take the conditions out / switch off / edit) — the first way offered
    await h.sleep(900);
    await h.eval(`(() => { const w = document.querySelector('.fc-cf-way input[type=radio]:not(:disabled), [data-vr-way]:not(:disabled)'); if (w && !w.checked) { w.click(); } return true; })()`);
    try { await confirm(h, 60000); } catch (_) { h.log(`✂ ${r.type} “${r.name}”: no confirmation appeared —`, (await h.eval(`(document.getElementById('fcErr_${r.id}')?.innerText || document.querySelector('.fc-inline-error')?.innerText || '').slice(0, 300)`))); continue; }
    // the row settles: its text (and the error line under it) stops changing for six seconds
    { const read = () => h.eval(`(() => { const row = document.querySelector('.fc-fix-pair[data-id="${r.id}"], .fc-del-pair[data-id="${r.id}"]') || document.querySelector('[data-id="${r.id}"]')?.closest('li, .fc-dep-item, div'); return (row?.innerText || '') + '‖' + (document.getElementById('fcErr_${r.id}')?.innerText || '') + '‖' + (document.getElementById('fcMsg_${r.id}')?.innerText || ''); })()`);
      let last = await read(), still = 0;
      for (let i = 0; i < 150 && still < 6; i++) { await h.sleep(1000); const now = await read(); if (now === last && !/⏳|reading|deploying|working/i.test(now)) still++; else { still = 0; last = now; } } }
    const says = (await h.eval(`(() => { const row = document.querySelector('.fc-fix-pair[data-id="${r.id}"], .fc-del-pair[data-id="${r.id}"]') || document.querySelector('[data-id="${r.id}"]')?.closest('li, .fc-dep-item, div')?.parentElement; return ((row?.innerText || '') + ' ‖ ' + (document.getElementById('fcErr_${r.id}')?.innerText || '')).replace(/\\s+/g, ' ').slice(0, 330); })()`));
    h.log(`✂ ${r.type} “${r.name}” (${clicked}) →`, says);
    done.push(r);
    if (await h.eval("!!document.querySelector('#sftkConfirmGo')")) await h.eval("document.querySelector('.sftk-confirm-cancel, #sftkConfirmCancel')?.click()");
  }
  // ── AFTER ──
  const after = retrieve('after');
  let bad = 0;
  for (const [f, t0] of Object.entries(before)) {
    const t1 = after[f]; const short = f.split('/').pop().replace(/-meta\.xml$/, '');
    if (t1 == null) { h.log(`AFTER ${short}: NOT RETRIEVED (deleted?)`); bad++; continue; }
    const d = lineDiff(t0, t1), left = names(t1);
    const strayGone = d.gone.filter(l => !l.includes(FIELD));
    h.log(`AFTER ${short}: names the field ×${names(t0)} → ×${left} · ${d.gone.length} line(s) gone (${strayGone.length} of them do not name the field) · ${d.came.length} new line(s)`);
    if (strayGone.length) h.log('   gone, not naming the field:', JSON.stringify(strayGone.slice(0, 12)));
    if (d.came.length) h.log('   new:', JSON.stringify(d.came.slice(0, 12)));
    if (left) { bad++; h.log('   STILL NAMED:', JSON.stringify(t1.split('\n').filter(l => l.includes(FIELD)).map(l => l.trim()).slice(0, 6))); }
  }
  // ── ↩ Undo all ──
  h.log('undo-all bar:', (await h.text('#fcUndoAll')).replace(/\s+/g, ' ').slice(0, 160));
  const hasUndo = await h.eval(`(() => { const b = document.querySelector('#fcUndoAll button:not(:disabled)'); if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; })()`);
  if (hasUndo) {
    await confirm(h, 30000).catch(() => h.log('no confirmation for Undo all'));
    await h.waitFor("/undone|put back|restored|could not|failed/i.test(document.querySelector('#fcUndoAll')?.innerText || '') && !/undoing|…$/i.test((document.querySelector('#fcUndoAll')?.innerText || '').trim())", 600000, 1500).catch(() => {});
    await h.sleep(4000);
    await scanDone().catch(() => {});
    h.log('after ↩ Undo all:', (await h.text('#fcUndoAll')).replace(/\s+/g, ' ').slice(0, 400));
  } else h.log('NO ↩ Undo all button');
  const undone = retrieve('undone');
  let differ = 0;
  for (const [f, t0] of Object.entries(before)) {
    const short = f.split('/').pop().replace(/-meta\.xml$/, ''), d = lineDiff(t0, undone[f] || '');
    if (d.gone.length || d.came.length) { differ++; h.log(`UNDONE ${short}: DIFFERS from before — missing ${JSON.stringify(d.gone.slice(0, 8))} · extra ${JSON.stringify(d.came.slice(0, 8))}`); }
    else h.log(`UNDONE ${short}: identical to before`);
  }
  h.log(`SUMMARY: ${done.length} ✂ pressed · ${bad} item(s) still name the field after · ${differ} item(s) differ from before after the undo`);
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 4)')).slice(0, 500));
}
