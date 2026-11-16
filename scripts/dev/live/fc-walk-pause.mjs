// LIVE, NO ORG WRITE (every dialog is paused or skipped): ✂ Remove all can be paused and continued from the same
// item — also after the window was closed (owner 2026-11-16: "we need a way to close the window and continue from the
// same place if we want later on … when we do a remove all").
//   1  Remove all → the first item's dialog says "item 1 of N" → pause           → the bar: paused at 1 of N, ▶ Continue
//   2  the page is opened again and the field scanned again                       → the bar is still there
//   3  ▶ Continue → no "which ones?" question, the SAME first item → Skip         → item 2 → pause
//   4  ▶ Continue → item 2 again (the skipped one is not asked twice) → pause      → ✕ End → nothing remembered
// Fixture: docs/fixtures/packaged-object-fixture. ORG=npc2 by default.
const ORG = process.env.ORG || 'npc2';
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
async function openAndScan(h) {
  await h.popup('fields');
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', 'dlrs__LookupChild__c');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', 'SFTK_Pkg_Tag__c');
  await h.eval(`document.querySelector('#fcScope [data-scope="both"]')?.click()`); await h.sleep(600);
  await h.eval(`(() => { document.querySelector('#fcScanBtn').click(); return true; })()`);
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000);
  await h.sleep(1500);
}
const dark = async (h, on) => { await h.eval(`(() => { document.body.classList.toggle('sftk-dark', ${on}); return true; })()`); await h.sleep(300); };
const both = async (h, name) => { await h.shot(h.shots + '/' + name + '.png'); await dark(h, true); await h.shot(h.shots + '/' + name + '-dark.png'); await dark(h, false); };
const dialog = h => h.eval(`(() => { const b = document.getElementById('modalBox'); const c = document.getElementById('sftkConfirmCancel'); return { pos: b?.querySelector('.fc-walk-pos')?.textContent || '', cancel: c?.textContent.trim() || '', stop: document.getElementById('fcWalkStop')?.textContent || '', item: (b?.querySelector('.sftk-cf-item-label, .sftk-cf-items li, .sftk-cf-list li')?.textContent || '').trim().slice(0, 80), title: (b?.innerText || '').replace(/\\s+/g, ' ').replace(/^.*?item \\d+ of \\d+\\s*/, '').trim().slice(0, 90) }; })()`);
const waitDialog = h => h.waitFor("!!document.getElementById('sftkConfirmCancel')", 120000, 300);
const pause = async h => { await h.eval(`(() => { const s = document.getElementById('fcWalkStop'); if (s) s.click(); else document.getElementById('sftkConfirmCancel').click(); return true; })()`); await h.waitFor("!document.getElementById('sftkConfirmCancel') && !!document.querySelector('.fc-every-paused')", 60000, 300); await h.sleep(400); };
const bar = h => h.eval(`(document.querySelector('.fc-every-paused')?.innerText || '').replace(/\\s+/g, ' ').trim()`);
const saved = h => h.eval(`chrome.storage.local.get('sftk_fc_walk').then(r => r.sftk_fc_walk || null)`);

export default async function (h) {
  await h.login(ORG);
  await h.popup('fields');
  await h.watchErrors();
  await h.eval(`chrome.storage.local.remove('sftk_fc_walk').then(() => true)`);
  await openAndScan(h);

  // 1 — start, pause on the first item
  await h.eval(`(() => { document.querySelector('.fc-fix-every[data-swap="0"]').click(); return true; })()`);
  await h.waitFor("!!document.getElementById('fcScopeAll') || !!document.getElementById('sftkConfirmCancel')", 30000, 200);
  // SCOPE=must walks only what blocks the delete — there the first item is one with no ✂ (Skip is offered)
  const SCOPE_BTN = process.env.SCOPE === 'must' ? 'fcScopeMust' : 'fcScopeAll';
  if (await h.eval(`!!document.getElementById('fcScopeAll')`)) await h.eval(`(() => { document.getElementById('${SCOPE_BTN}').click(); return true; })()`);
  await waitDialog(h); await h.sleep(500);
  const d1 = await dialog(h);
  h.log('1 first dialog:', JSON.stringify(d1));
  if (!/item 1 of \d+/.test(d1.pos)) throw new Error('FAILED: the dialog must say where the walk is — ' + d1.pos);
  if (!/Pause/.test(d1.cancel) && !/pause/.test(d1.stop)) throw new Error('FAILED: the dialog must offer the pause — ' + JSON.stringify(d1));
  await both(h, 'walk-1-dialog');
  await pause(h);
  const b1 = await bar(h), s1 = await saved(h);
  h.log('1 bar:', b1, '· saved:', JSON.stringify(s1 && { swap: s1.swap, scope: s1.scope, at: s1.at, total: s1.total, skipped: s1.skipped.length }));
  if (!/paused.*at item 1 of/.test(b1) || !s1 || s1.at !== 1) throw new Error('FAILED: paused at item 1, remembered');
  await h.eval(`document.querySelector('.fc-every-paused').scrollIntoView({ block: 'center' })`);
  await both(h, 'walk-2-paused');

  // 2 — the window is closed and opened again
  await openAndScan(h);
  await h.waitFor("!!document.querySelector('.fc-every-paused')", 30000, 300);
  h.log('2 after reopening:', await bar(h));

  // 3 — continue: no scope question, the same item; skip it; pause on the next
  await h.eval(`(() => { document.querySelector('.fc-walk-continue').click(); return true; })()`);
  await waitDialog(h); await h.sleep(500);
  if (await h.eval(`!!document.getElementById('fcScopeAll')`)) throw new Error('FAILED: a continued walk must not ask the scope again');
  const d3 = await dialog(h);
  h.log('3 continued on:', JSON.stringify(d3));
  if (!/item 1 of/.test(d3.pos) || d3.title !== d1.title) throw new Error('FAILED: Continue must open the item the walk was paused on');
  if (d3.cancel !== 'Skip this one') { h.log('NOTE: the first item has no Skip — pausing instead'); await pause(h); }
  else {
    await h.eval(`(() => { document.getElementById('sftkConfirmCancel').click(); return true; })()`);
    await h.waitFor(`(() => { const p = document.querySelector('#modalBox .fc-walk-pos'); return !!p && /item 2 of/.test(p.textContent); })()`, 120000, 300);
    await h.sleep(500);
    const d3b = await dialog(h);
    h.log('3 after Skip:', JSON.stringify(d3b));
    await pause(h);
    const b3 = await bar(h);
    h.log('3 bar:', b3);
    if (!/at item 2 of/.test(b3) || !/1 skipped by you/.test(b3)) throw new Error('FAILED: paused at item 2 with one skipped — ' + b3);

    // 4 — continue again: item 2, the skipped one is not asked twice
    await h.eval(`(() => { document.querySelector('.fc-walk-continue').click(); return true; })()`);
    await waitDialog(h); await h.sleep(500);
    const d4 = await dialog(h);
    h.log('4 continued on:', JSON.stringify(d4));
    if (d4.title !== d3b.title || !/item 2 of/.test(d4.pos)) throw new Error('FAILED: the second Continue must open item 2, not the skipped item 1');
    await pause(h);
  }
  await h.eval(`(() => { document.querySelector('.fc-walk-end').click(); return true; })()`);
  await h.waitFor("!document.querySelector('.fc-every-paused')", 10000, 200);
  if (await saved(h)) throw new Error('FAILED: ✕ End must forget the walk');
  const hist = await h.eval(`chrome.storage.local.get('sftk_history').then(r => (r.sftk_history || []).length)`);
  if (hist) throw new Error('FAILED: this script must not have changed the org — history has ' + hist);
  h.log(`✓ fc-walk-pause on ${ORG}: paused at 1, survived a reopen, continued on the same item, skip not asked twice, End forgets; no org write`);
}
