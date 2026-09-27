// Live: 🔑 Licenses (popup) — find the fixture user B, deactivate, then reactivate.
//   USER="SFTK Test B"   ACTION=deactivate|reactivate|cycle (default cycle)   SCAN_ONLY=1
const dump = async (h, sel, n = 2500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
async function search(h, name) {
  await h.eval(`(() => { const i = document.querySelector('#lmSearch'); i.value = ${JSON.stringify(name)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#lmSearchBtn')?.click(); return true; })()`);
  await h.waitFor("document.querySelectorAll('.lm-user-cb').length > 0 || /no user|nothing/i.test(document.querySelector('#lmUserList')?.innerText || '')", 120000, 500);
  await h.sleep(800);
  return h.eval(`[...document.querySelectorAll('.lm-user-cb')].map(c => c.dataset.id + ' :: ' + (c.closest('.lm-user-row, tr, div')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 140))`);
}
async function act(h, action) {
  const btnSel = action === 'deactivate' ? '#lmDeactivateBtn' : '#lmReactivateBtn';
  h.log('button:', await h.eval(`(() => { const b = document.querySelector(${JSON.stringify(btnSel)}); return b ? b.textContent.trim() + (b.disabled ? ' (off)' : '') + (getComputedStyle(b).display === 'none' ? ' (hidden)' : '') : 'missing'; })()`));
  await h.eval(`document.querySelector(${JSON.stringify(btnSel)})?.click()`);
  await h.sleep(1500);
  if (!(await h.eval(`!!document.querySelector('#sftkConfirmGo')`))) {
    h.log(`no modal after ${action} — hint:`, await dump(h, '#lmHint', 300), '| result:', await dump(h, '#lmResult', 300), '| toasts:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.toast, [class*=toast]')].map(t => t.innerText.replace(/\\s+/g, ' ').slice(0, 200))`)), '| rows:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.lm-user-cb')].map(c => (c.checked ? '[x] ' : '[ ] ') + (c.closest('.lm-user-row, tr, div')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 100))`)));
    return false;
  }
  await h.sleep(300);
  h.log(`CONFIRM (${action}):`, await h.eval(`(document.querySelector('#sftkConfirmGo')?.closest('.lm-modal, .modal, [class*=modal]')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 800)`));
  if (process.env.SCAN_ONLY === '1') { await h.eval(`document.querySelector('#sftkConfirmCancel')?.click()`); h.log('SCAN_ONLY — cancelled'); return false; }
  await h.eval(`document.querySelector('#sftkConfirmGo').click()`);
  await h.sleep(400);
  if (await h.eval(`!!document.querySelector('#sftkConfirmProd')`)) {
    await h.eval(`(() => { const i = document.querySelector('#sftkConfirmProd'); i.value = i.placeholder; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await h.eval(`document.querySelector('#sftkConfirmProdGo')?.click()`);
  }
  await h.waitFor("!!document.querySelector('#lmResult')?.innerText && !/⏳/.test(document.querySelector('#lmLoading')?.innerText || '')", 120000, 1000);
  await h.sleep(800);
  h.log(`RESULT (${action}):`, await dump(h, '#lmResult', 800));
  return true;
}
export default async function (h) {
  await h.login('npc');
  await h.popup('licenses');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#lmSearch')", 60000, 500); await h.sleep(1000);
  h.log('overview:', await dump(h, '#lmOverviewMeta, #lmOverviewBody', 400));
  const name = process.env.USER || 'SFTK Test B';
  // the list filters by Active by default — an inactive user shows only under the Inactive / All filter
  const filter = (process.env.ACTION || 'cycle').toLowerCase() === 'reactivate' ? 'inactive' : 'all';
  h.log('filter buttons:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.lm-filter-btn')].map(b => b.dataset.filter + (b.classList.contains('active') ? '*' : ''))`)), '→ clicking', filter);
  await h.eval(`document.querySelector('.lm-filter-btn[data-filter="${filter}"]')?.click()`); await h.sleep(500);
  const rows = await search(h, name);
  h.log('ROWS:', JSON.stringify(rows));
  const ticked = await h.eval(`(() => { const c = [...document.querySelectorAll('.lm-user-cb')].find(x => (x.closest('.lm-user-row, tr, div')?.innerText || '').includes(${JSON.stringify(name)})); if (!c) return 'none'; c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return c.dataset.id; })()`);
  h.log('ticked:', ticked, '| actions:', await dump(h, '#lmActions', 200));
  const action = (process.env.ACTION || 'cycle').toLowerCase();
  if (action === 'cycle') {
    if (!(await act(h, 'deactivate'))) return;
    await search(h, name);
    await h.eval(`(() => { const c = [...document.querySelectorAll('.lm-user-cb')].find(x => (x.closest('.lm-user-row, tr, div')?.innerText || '').includes(${JSON.stringify(name)})); if (c) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); } return !!c; })()`);
    h.log('after deactivate — rows:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.lm-user-cb')].map(c => (c.closest('.lm-user-row, tr, div')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 120))`)));
    await act(h, 'reactivate');
  } else await act(h, action);
  await h.shot(h.shots + '/lm-result.png');
}
