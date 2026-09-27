// Live: Dependencies tab on the fixture tree SFTK_Dep_Test_Account_Trigger → L1 → L2 → L3 → L4
// (docs/fixtures/dep-test-flows): the tree under the trigger, 🧨 blast radius, 🔗 chains,
// the "What uses…" search, ⬇ Export — all read-only. With DELETE=1: right-click L4 →
// "Select this flow for deletion" → Flows tab → 🗑 Delete → the parents modal (L3 calls L4)
// → CHOICE=cancel|ignore|parents → the final confirmation → result toast, then CLI-verify.
//   ROOT=SFTK_Dep_Test_Account_Trigger  LEAF=SFTK_Dep_Test_L4  SEARCH=SFTK_Dep_Test_L4
const dump = async (h, sel, n = 2500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
const ctx = (h, api, itemId) => h.eval(`(() => { const n = document.querySelector('.dep-node[data-api-name=' + JSON.stringify(${JSON.stringify(api)}) + ']'); if (!n) return 'no node'; n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 })); const it = document.getElementById(${JSON.stringify(itemId)}); if (!it) return 'no menu item'; it.click(); return 'clicked'; })()`);
export default async function (h) {
  await h.login('npc');
  await h.popup('dependencies');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#depApiVerBtn') && document.querySelectorAll('.dep-node').length > 0", 300000, 1000);
  await h.sleep(1500);
  const ROOT = process.env.ROOT || 'SFTK_Dep_Test_Account_Trigger', LEAF = process.env.LEAF || 'SFTK_Dep_Test_L4';
  h.log('nodes:', await h.eval(`document.querySelectorAll('.dep-node').length`), 'banner:', await dump(h, '#depNoDataBanner', 200));
  // the fixture tree: expand everything under the root and list the chain
  const chain = await h.eval(`(() => { const root = document.querySelector('.dep-node[data-api-name=' + JSON.stringify(${JSON.stringify(ROOT)}) + ']'); if (!root) return 'ROOT NOT FOUND'; const out = [ (root.innerText || '').replace(/\\s+/g, ' ').slice(0, 160) ]; let c = root.nextElementSibling; const walk = (el, d) => { if (!el || d > 8) return; el.querySelectorAll(':scope > .dep-node, :scope > .dep-children > .dep-node').forEach(n => out.push('  '.repeat(d) + (n.dataset.apiName || '?') + ' :: ' + (n.innerText || '').replace(/\\s+/g, ' ').slice(0, 120))); }; if (c && c.classList.contains('dep-children')) { c.querySelectorAll('.dep-node').forEach(n => { let d = 0, p = n.parentElement; while (p && p !== c) { if (p.classList.contains('dep-children')) d++; p = p.parentElement; } out.push('  '.repeat(d + 1) + (n.dataset.apiName || '?') + ' :: ' + (n.innerText || '').replace(/\\s+/g, ' ').slice(0, 120)); }); const warn = c.querySelector('.dep-deep-warning'); if (warn) out.push('WARN: ' + warn.textContent); } return out; })()`);
  h.log('TREE:', JSON.stringify(chain));
  await h.shot(h.shots + '/dep-tree.png');
  // 🧨 blast radius of the trigger
  h.log('blast:', await ctx(h, ROOT, 'depCtxBlast'));
  await h.waitFor("!!document.querySelector('.dep-blast-panel')", 30000, 300); await h.sleep(800);
  h.log('BLAST:', await dump(h, '.dep-blast-panel', 1800));
  await h.shot(h.shots + '/dep-blast.png');
  // 🔗 chain of L2 (up and down)
  h.log('chain:', await ctx(h, 'SFTK_Dep_Test_L2', 'depCtxChain'));
  await h.waitFor("!!document.querySelector('.dep-chain-panel')", 30000, 300); await h.sleep(800);
  h.log('CHAIN L2:', await dump(h, '.dep-chain-panel', 1800));
  await h.shot(h.shots + '/dep-chain.png');
  await h.eval(`document.querySelector('.dep-blast-close')?.click()`);
  // 🔎 What uses…
  const term = process.env.SEARCH || LEAF;
  await h.eval(`(() => { const i = document.querySelector('#depRefSearch'); i.value = ${JSON.stringify(term)}; document.querySelector('#depRefGo').click(); return true; })()`);
  await h.waitFor("!!document.querySelector('#depRefResults')?.innerText", 30000, 300); await h.sleep(500);
  h.log('SEARCH', JSON.stringify(term) + ':', await dump(h, '#depRefResults', 800));
  await h.eval(`(() => { const i = document.querySelector('#depRefSearch'); i.value = 'Account'; document.querySelector('#depRefGo').click(); return true; })()`);
  await h.sleep(1200);
  h.log('SEARCH "Account":', await dump(h, '#depRefResults', 400));
  // ⬇ Export — headless has no download sink; the status text is what we can read
  await h.eval(`document.querySelector('#depExportBtn')?.click()`); await h.sleep(2500);
  h.log('EXPORT row:', await dump(h, '.dep-tools-row', 400));
  if (process.env.DELETE !== '1') return;

  // ── delete L4 through the Flows tab ──
  h.log('select for deletion:', await ctx(h, LEAF, 'depCtxSelect'));
  await h.waitFor("document.querySelector('.tab-btn[data-tab=\"flows\"]')?.classList.contains('active') || !!document.querySelector('#deleteBtn')", 60000, 500);
  await h.sleep(1500);
  h.log('selection summary:', await dump(h, '#selectionSummary, .selection-summary, #actionBar', 300));
  h.log('delete button:', await h.eval(`(() => { const b = document.querySelector('#deleteBtn'); return b ? b.textContent.trim() + (b.disabled ? ' (off)' : '') : null; })()`));
  await h.eval(`document.querySelector('#deleteBtn')?.click()`);
  const choice = (process.env.CHOICE || 'cancel').toLowerCase();
  // up to four modals: scan-before-delete, interviews, parents, the final confirmation
  for (let i = 0; i < 6; i++) {
    await h.sleep(1500);
    const m = await h.eval(`(() => { const o = document.querySelector('#modalOverlay'); const box = document.querySelector('#modalBox'); const vis = o && getComputedStyle(o).display !== 'none'; const go = document.querySelector('#sftkConfirmGo'); return { modal: vis ? (box?.innerText || '').replace(/\\s+/g, ' ').slice(0, 1200) : '', buttons: vis ? [...box.querySelectorAll('button')].map(b => (b.id || b.className) + ':' + b.textContent.trim() + (b.disabled ? '(off)' : '')) : [], final: !!go }; })()`);
    if (!m.modal && !m.final) { h.log('no modal open (', i, ')'); if (i >= 2) break; continue; }
    if (m.final) {
      h.log('FINAL CONFIRM:', await h.eval(`(document.querySelector('#sftkConfirmGo')?.closest('.sftk-confirm, [class*=confirm]')?.innerText || document.body.innerText).replace(/\\s+/g, ' ').slice(0, 900)`));
      if (choice === 'cancel') { await h.eval(`(() => { const c = [...document.querySelectorAll('button')].find(b => /cancel/i.test(b.textContent)); if (c) c.click(); return true; })()`); h.log('cancelled at the final confirmation'); return; }
      await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`); await h.sleep(300);
      h.log('Go enabled:', await h.eval(`!document.querySelector('#sftkConfirmGo')?.disabled`));
      await h.eval(`document.querySelector('#sftkConfirmGo')?.click()`);
      // deactivate → delete → 2 s victory → a toast (success) or a modal (errors)
      // deactivate → delete → re-read → (retry passes) → 2 s victory → a toast (success) or a modal (errors);
      // logged every 20 s so a slow or stuck run shows WHERE it is
      for (let t = 0; t < 540; t += 20) {
        const done = await h.eval(`!!document.querySelector('.result-toast') || (document.querySelector('#modalOverlay') && getComputedStyle(document.querySelector('#modalOverlay')).display !== 'none' && /Close/.test(document.querySelector('#modalBox')?.innerText || ''))`);
        if (done) break;
        h.log(`  …${t}s progress:`, await h.eval(`(document.querySelector('#progressStatus')?.innerText || '') + ' | ' + (document.querySelector('#progressLabel, .progress-label')?.innerText || '') + ' | modal: ' + ((document.querySelector('#modalOverlay') && getComputedStyle(document.querySelector('#modalOverlay')).display !== 'none') ? (document.querySelector('#modalBox')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 200) : 'none')`));
        await h.sleep(20000);
      }
      await h.sleep(800);
      h.log('TOAST:', await h.eval(`[...document.querySelectorAll('.result-toast')].map(e => e.innerText.replace(/\\s+/g, ' ').slice(0, 400)).join(' || ')`));
      h.log('RESULT MODAL:', await h.eval(`(() => { const o = document.querySelector('#modalOverlay'); return (o && getComputedStyle(o).display !== 'none') ? (document.querySelector('#modalBox')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 1200) : ''; })()`));
      await h.shot(h.shots + '/dep-delete-result.png');
      return;
    }
    h.log(`MODAL ${i}:`, m.modal); h.log('buttons:', JSON.stringify(m.buttons));
    if (m.buttons.some(b => b.startsWith('modalScan'))) { await h.eval(`document.querySelector('#modalScan').click()`); h.log('→ Scan now'); await h.sleep(4000); continue; }
    if (m.buttons.some(b => b.startsWith('modalConfirm'))) { await h.eval(`document.querySelector('#modalConfirm').click()`); h.log('→ interviews: confirm'); continue; }
    if (m.buttons.some(b => b.startsWith('proceedIgnoreBtn'))) {
      h.log('PARENTS TABLE:', await dump(h, '#depTableBody', 800));
      if (choice === 'cancel') { await h.eval(`document.querySelector('#modalCancel').click()`); h.log('→ Cancel at the parents modal'); return; }
      if (choice === 'ignore') { await h.eval(`document.querySelector('#proceedIgnoreBtn').click()`); h.log('→ Proceed anyway'); continue; }
      await h.eval(`(() => { document.querySelectorAll('.parent-del-cb').forEach(cb => { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }); return true; })()`); await h.sleep(300);
      h.log('deactivate+delete parents enabled:', await h.eval(`!document.querySelector('#deactivateDeleteBtn')?.disabled`));
      await h.eval(`document.querySelector('#deactivateDeleteBtn').click()`); h.log('→ Deactivate + delete parents'); continue;
    }
    if (m.buttons.some(b => b.startsWith('modalSkip'))) { await h.eval(`document.querySelector('#modalCancel')?.click()`); h.log('→ stale/unverified check offered — cancelled (never delete unverified)'); return; }
    h.log('unknown modal — cancelling'); await h.eval(`document.querySelector('#modalCancel')?.click()`); return;
  }
}
