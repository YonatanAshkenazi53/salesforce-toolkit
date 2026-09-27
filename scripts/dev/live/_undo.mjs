// Live helper: ↩ Undo the newest tool entry in Data Studio › History
// (campaign 3, phase 3). Opens studio.html#/history in the SAME headless
// session (the org sessions carry over), reads the newest tool card, clicks
// its ↩ Undo, walks the shared dialog (ack + the word UNDO, then the typed
// org name when the target is treated as production and TYPE_IT=1), and
// reports the toast and the two newest cards. Returns the toast text.
const dump = async (h, sel, n = 2500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');

export async function undoNewest(h, opts = {}) {
  h.log('── ↩ UNDO (Data Studio › History) ──');
  await h.studio('#/history');
  await h.eval(`document.querySelector('[data-view="history"]')?.click()`);
  await h.waitFor("!!document.querySelector('.ds-history-card-tool') || /No transfers yet|No runs match/.test(document.querySelector('#dsMain, body')?.innerText || '')", 60000, 500);
  await h.sleep(800);
  const cards = await h.eval(`[...document.querySelectorAll('.ds-history-card-tool')].slice(0, 3).map(c => c.innerText.replace(/\\s+/g, ' ').slice(0, 400))`);
  h.log('tool cards (newest first):', JSON.stringify(cards, null, 0));
  if (!cards.length) { h.log('no tool card — nothing to undo'); return ''; }
  const btn = await h.eval(`(() => { const b = document.querySelector('.ds-history-card-tool [data-dsaction="undoTool"]'); return b ? b.textContent.trim() + (b.disabled ? ' (off: ' + b.title + ')' : '') : null; })()`);
  h.log('undo button:', btn);
  if (!btn || btn.includes('(off')) return '';
  await h.eval(`document.querySelector('.ds-history-card-tool [data-dsaction="undoTool"]').click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo') || /Log in to|no longer/.test([...document.querySelectorAll('.ds-toast')].map(t => t.innerText).join(' '))", 60000, 500);
  await h.sleep(500);
  if (!(await h.eval(`!!document.querySelector('#sftkConfirmGo')`))) { h.log('no dialog — toast:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-toast')].map(t => t.innerText)`))); return ''; }
  h.log('UNDO DIALOG:', await dump(h, '#dsModalBox', 1800));
  await h.shot(h.shots + '/undo-dialog.png');
  if (opts.cancel) { await h.eval(`document.querySelector('#sftkConfirmCancel')?.click()`); h.log('cancelled on purpose'); return 'cancelled'; }
  await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } const i = document.querySelector('#sftkConfirmWord'); if (i) { i.value = 'UNDO'; i.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`);
  await h.sleep(300);
  h.log('Go enabled:', await h.eval(`!document.querySelector('#sftkConfirmGo')?.disabled`));
  await h.eval(`document.querySelector('#sftkConfirmGo')?.click()`);
  await h.sleep(600);
  if (await h.eval(`!!document.querySelector('#sftkConfirmProd')`)) {
    h.log('TYPED GATE (production):', await dump(h, '#dsModalBox', 600));
    if (process.env.TYPE_IT === '1' || opts.typeIt) {
      await h.eval(`(() => { const i = document.querySelector('#sftkConfirmProd'); i.value = i.placeholder; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await h.sleep(200);
      await h.eval(`document.querySelector('#sftkConfirmProdGo')?.click()`);
    } else { h.log('TYPE_IT not set — cancelling at the typed gate'); await h.eval(`document.querySelector('#sftkConfirmProdCancel')?.click()`); return 'cancelled at typed gate'; }
  }
  await h.waitFor("/Undone|Undo ran|Undo cancelled|Log in to|cannot|no longer/.test([...document.querySelectorAll('.ds-toast')].map(t => t.innerText).join(' '))", 300000, 800);
  await h.sleep(1200);
  const toast = await h.eval(`[...document.querySelectorAll('.ds-toast')].map(t => t.innerText.replace(/\\s+/g, ' ')).join(' || ')`);
  h.log('UNDO TOAST:', toast);
  h.log('cards after:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-history-card-tool')].slice(0, 2).map(c => c.innerText.replace(/\\s+/g, ' ').slice(0, 500))`), null, 0));
  await h.shot(h.shots + '/undo-after.png');
  return toast;
}
