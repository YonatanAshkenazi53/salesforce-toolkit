// Live helper: ↩ Undo the newest tool entry (campaign 3, phase 3).
//
// Since 2026-10-05 a change made by a TOOLKIT tool is listed in that tool
// (top bar › 🧾 History), not in Data Studio › History; a Data Studio tool's
// change is still on the History page. This helper finds the newest tool
// entry, goes to where it is shown, clicks its ↩ Undo, walks the shared
// dialog (ack + the word UNDO, then the typed org name when the target is
// treated as production and TYPE_IT=1), and reports what the page said.
// Returns that sentence ('' when there was nothing to undo).
const NL = String.fromCharCode(10);
const flat = s => String(s || '').split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const dump = async (h, sel, n = 2500) => flat(await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n);

async function walkDialog(h, opts, box) {
  h.log('UNDO DIALOG:', await dump(h, box, 1800));
  await h.shot(h.shots + '/undo-dialog.png');
  if (opts.cancel) { await h.eval(`document.querySelector('#sftkConfirmCancel')?.click()`); h.log('cancelled on purpose'); return 'cancelled'; }
  await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } const i = document.querySelector('#sftkConfirmWord'); if (i) { i.value = 'UNDO'; i.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`);
  await h.sleep(300);
  h.log('Go enabled:', await h.eval(`!document.querySelector('#sftkConfirmGo')?.disabled`));
  await h.eval(`document.querySelector('#sftkConfirmGo')?.click()`);
  await h.sleep(600);
  if (await h.eval(`!!document.querySelector('#sftkConfirmProd')`)) {
    h.log('TYPED GATE (production):', await dump(h, box, 600));
    if (process.env.TYPE_IT === '1' || opts.typeIt) {
      await h.eval(`(() => { const i = document.querySelector('#sftkConfirmProd'); i.value = i.placeholder; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await h.sleep(200);
      await h.eval(`document.querySelector('#sftkConfirmProdGo')?.click()`);
    } else { h.log('TYPE_IT not set — cancelling at the typed gate'); await h.eval(`document.querySelector('#sftkConfirmProdCancel')?.click()`); return 'cancelled at typed gate'; }
  }
  return null;
}

// A Toolkit tool's entry: the tool's own History (popup.html?tab=<tab>).
async function undoInTool(h, tab, opts) {
  h.log(`── ↩ UNDO (Toolkit › ${tab} › 🧾 History) ──`);
  await h.popup(tab);
  await h.waitFor("document.querySelector('#sftkThBtn') && document.querySelector('#sftkThBtn').style.display !== 'none'", 30000, 500);
  h.log('history button:', await h.eval(`document.querySelector('#sftkThBtn').textContent`));
  await h.eval(`document.querySelector('#sftkThBtn').click()`);
  await h.waitFor("document.querySelectorAll('#sftkThModalList .sftk-th-card').length > 0", 30000, 300);
  await h.sleep(400);
  h.log('tool cards (newest first):', JSON.stringify(await h.eval(`[...document.querySelectorAll('#sftkThModalList .sftk-th-card')].slice(0, 3).map(c => c.innerText.split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ').slice(0, 400))`)));
  const btn = await h.eval(`(() => { const b = document.querySelector('#sftkThModalList .sftk-th-card [data-th-undo]'); return b ? b.textContent.trim() + (b.disabled ? ' (off: ' + b.title + ')' : '') : null; })()`);
  h.log('undo button:', btn);
  if (!btn || btn.includes('(off')) return '';
  await h.eval(`document.querySelector('#sftkThModalList .sftk-th-card [data-th-undo]').click()`);
  // the list steps aside for the confirmation, and comes back with the sentence the undo ended with
  await h.waitFor("!!document.querySelector('#sftkConfirmGo') || !!document.querySelector('#sftkThModalList .sftk-th-said')", 60000, 500);
  await h.sleep(500);
  if (await h.eval(`!!document.querySelector('#sftkConfirmGo')`)) {
    const early = await walkDialog(h, opts, '#modalBox');
    if (early) return early;
  }
  await h.waitFor("!!document.querySelector('#sftkThModalList .sftk-th-said')", 300000, 800);
  await h.sleep(1000);
  const said = flat(await h.eval(`document.querySelector('#sftkThModalList .sftk-th-said')?.innerText || ''`));
  h.log('UNDO RESULT:', said);
  h.log('cards after:', JSON.stringify(await h.eval(`[...document.querySelectorAll('#sftkThModalList .sftk-th-card')].slice(0, 2).map(c => c.innerText.split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ').slice(0, 500))`)));
  await h.shot(h.shots + '/undo-after.png');
  return said;
}

// A Data Studio tool's entry: Data Studio › History.
async function undoInStudio(h, opts) {
  h.log('── ↩ UNDO (Data Studio › History) ──');
  await h.eval(`document.querySelector('[data-view="history"]')?.click()`);
  await h.waitFor("!!document.querySelector('.ds-history-card-tool') || /No transfers yet|No runs match/.test(document.querySelector('#dsMain, body')?.innerText || '')", 60000, 500);
  await h.sleep(800);
  const cards = await h.eval(`[...document.querySelectorAll('.ds-history-card-tool')].slice(0, 3).map(c => c.innerText.split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ').slice(0, 400))`);
  h.log('tool cards (newest first):', JSON.stringify(cards));
  if (!cards.length) { h.log('no tool card — nothing to undo'); return ''; }
  const btn = await h.eval(`(() => { const b = document.querySelector('.ds-history-card-tool [data-dsaction="undoTool"]'); return b ? b.textContent.trim() + (b.disabled ? ' (off: ' + b.title + ')' : '') : null; })()`);
  h.log('undo button:', btn);
  if (!btn || btn.includes('(off')) return '';
  await h.eval(`document.querySelector('.ds-history-card-tool [data-dsaction="undoTool"]').click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo') || /Log in to|no longer/.test([...document.querySelectorAll('.ds-toast')].map(t => t.innerText).join(' '))", 60000, 500);
  await h.sleep(500);
  if (!(await h.eval(`!!document.querySelector('#sftkConfirmGo')`))) { h.log('no dialog — toast:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-toast')].map(t => t.innerText)`))); return ''; }
  const early = await walkDialog(h, opts, '#dsModalBox');
  if (early) return early;
  await h.waitFor("/Undone|Undo ran|Undo cancelled|Log in to|cannot|no longer/.test([...document.querySelectorAll('.ds-toast')].map(t => t.innerText).join(' '))", 300000, 800);
  await h.sleep(1200);
  const toast = flat(await h.eval(`[...document.querySelectorAll('.ds-toast')].map(t => t.innerText).join(' || ')`));
  h.log('UNDO TOAST:', toast);
  h.log('cards after:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-history-card-tool')].slice(0, 2).map(c => c.innerText.split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ').slice(0, 500))`)));
  await h.shot(h.shots + '/undo-after.png');
  return toast;
}

export async function undoNewest(h, opts = {}) {
  // where the newest tool entry is shown: its Toolkit tab, or '' for Data Studio › History
  await h.studio('#/history');
  const where = await h.eval(`(async () => {
    const list = ((await chrome.storage.local.get('sftk_history')).sftk_history || []).filter(e => e && e.kind === 'tool');
    list.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
    if (!list.length) return null;
    return { tab: sftkHistoryToolTab(list[0]), tool: list[0].tool, title: list[0].profileName };
  })()`);
  if (!where) { h.log('── ↩ UNDO: no tool entry in History — nothing to undo ──'); return ''; }
  h.log('newest tool entry:', JSON.stringify(where));
  // a Toolkit entry must NOT be on the Data Studio page any more
  if (where.tab) h.log('Data Studio › History note:', await dump(h, '#dsHistKitNote', 400), '· tool cards listed there:', await h.eval(`document.querySelectorAll('.ds-history-card-tool').length`));
  return where.tab ? undoInTool(h, where.tab, opts) : undoInStudio(h, opts);
}
