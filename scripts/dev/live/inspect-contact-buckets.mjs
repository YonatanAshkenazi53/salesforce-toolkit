const dump = async (h, sel, n = 3000) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).replace(/\n+/g, ' | ');
export default async function (h) {
  await h.login('npc');
  await h.login('npc2');
  await h.studio('');
  // History: open every fold and read the errors + notes
  await h.eval(`document.querySelector('[data-view="history"]')?.click()`);
  await h.sleep(2000);
  await h.eval(`document.querySelectorAll('details').forEach(d => d.open = true)`);
  await h.sleep(500);
  h.log('HISTORY DETAILS:', await dump(h, '.ds-history-card, .ds-history-item, #dsMain', 5000));
  // Deploy page → Contact tab: where are the two Mias?
  const id = await h.eval(`_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id`);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`);
  await h.sleep(2000);
  // scan Contact only
  await h.eval(`(() => { const b = document.querySelector('[data-dep-scan="0"]'); if (b) b.click(); })()`);
  await h.waitFor(`(() => { const b = document.querySelector('[data-dep-scan="0"]'); return !b || (/Rescan/.test(b.textContent) && !b.disabled); })()`, 90000, 1000);
  await h.sleep(1000);
  for (const tab of ['ins', 'chg', 'link', 'same', 'ext']) {
    await h.eval(`document.querySelector('[data-dep-obj="0"][data-dep-tab="${tab}"]')?.click()`);
    await h.sleep(500);
    h.log(`CONTACT/${tab}:`, await dump(h, '#dsDepList', 1200));
  }
  h.log('NOTES CARD:', await dump(h, '.ds-dep-notes', 2500));
  h.log('SCAN dupKeys (root):', JSON.stringify(await h.eval(`(_reconcileProfile?.lastScan?.dupKeys || null)`)).slice(0, 400));
  h.log('SCAN dupKeys (Contact):', JSON.stringify(await h.eval(`(_reconcileProfile?.lastScan?.children?.['0']?.dupKeys || null)`)).slice(0, 400));
  h.log('Contact buckets sizes:', JSON.stringify(await h.eval(`(() => { const c = _reconcileProfile?.lastScan?.children?.['0'] || {}; return { miss: (c.missingInTarget||[]).length, chg: (c.changed||[]).length, ident: (c.identical||[]).length, only: (c.onlyInTarget||[]).length, link: (c.linkMismatch||[]).length, fetched: c.fetched, personContacts: c.personContacts, warnings: c.warnings }; })()`)).slice(0, 800));
}
