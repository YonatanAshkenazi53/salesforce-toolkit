// Live: do Org Compare, the Sync Ring and the Deploy page agree about the same data?
// Fixture: docs/fixtures/complex-deployment (profiles.json), trailheads5 → trailheads4.
//   1. Org Compare (whole objects, no profile filter): Account, Contact, Opportunity.
//   2. Sync Ring: scan the PROFILE deployment's cell for trailheads4 (missing / changed / extra).
//   3. Deploy page: the same deployment's scan (to insert / changed / only in target / synced).
// The Ring and the Deploy page share the profile's scope, so their numbers must agree;
// Org Compare has no filter, so its numbers are reported for the reader, not compared.
//   PROFILE = deployment name (default: the Accounts tree)
const dump = async (h, sel, n = 2000) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
async function setSelect(h, sel, match) {
  return h.eval(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); if (!s) return 'no select'; const o = [...s.options].find(o => o.value === ${JSON.stringify(match)}) || [...s.options].find(o => (o.textContent + ' ' + o.value).includes(${JSON.stringify(match)})); if (!o) return 'no option for ' + ${JSON.stringify(match)}; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return 'set ' + o.value; })()`);
}
export default async function (h) {
  await h.login('npc'); await h.login('npc2');
  await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Accounts tree';
  const pid = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  h.log('profile id:', pid);

  // ── 1. Org Compare ──
  if (process.env.SKIP_OC !== '1') {
  await h.eval(`document.querySelector('[data-view="compare"]')?.click()`);
  await h.waitFor("!!document.querySelector('#dsOCSrc')", 60000, 500); await h.sleep(500);
  h.log('src:', await setSelect(h, '#dsOCSrc', 'trailheads5'), '| tgt:', await setSelect(h, '#dsOCTgt', 'trailheads4'));
  await h.waitFor("document.querySelectorAll('[data-oc-obj]').length > 5", 180000, 1000); await h.sleep(500);
  await h.eval(`document.querySelector('#dsOCSelNone')?.click()`); await h.sleep(300);
  const ticked = await h.eval(`(() => { let n = 0; for (const o of ['Account', 'Contact', 'Opportunity']) { const c = document.querySelector('[data-oc-obj="' + o + '"]'); if (c) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); n++; } } return n; })()`);
  h.log('objects ticked:', ticked, '| count line:', await dump(h, '#dsOCObjCount', 120), '| strategy:', await h.eval(`document.querySelector('#dsOCStrategy')?.value`));
  await h.eval(`document.querySelector('#dsOCRun')?.click()`);
  await h.waitFor("document.querySelectorAll('.ds-oc-table tbody tr').length > 0 && !/comparing/.test(document.querySelector('#dsOCResults')?.innerText || '')", 600000, 2000);
  await h.sleep(800);
  h.log('ORG COMPARE:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-oc-table tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.replace(/\\s+/g, ' ').trim()).slice(0, 7).join(' / '))`)));
  await h.shot(h.shots + '/oc-results.png');
  }

  // ── 2. Sync Ring — needs a source of truth (topbar SOURCE) and at least one more org ticked ──
  h.log('SOURCE menu:', await setSelect(h, '#dsSotSel', 'trailheads5'));
  await h.sleep(1200);
  await h.eval(`document.querySelector('[data-view="ring"]')?.click()`);
  await h.waitFor("!!document.querySelector('#dsRingBody')", 60000, 500); await h.sleep(1000);
  h.log('ring orgs:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-ring-cb')].map(c => c.value + (c.checked ? '*' : '') + (c.disabled ? '(crown)' : ''))`)));
  const adopt = await h.eval(`(() => { const b = document.querySelector('#dsRingAdoptWp'); if (b) { b.click(); return 'adopted topbar SOURCE'; } return 'no adopt button'; })()`);
  h.log('adopt:', adopt); await h.sleep(1500);
  const tickedRing = await h.eval(`(() => { let n = 0; document.querySelectorAll('.ds-ring-cb').forEach(c => { if (!c.disabled && !c.checked && /trailheads4/.test(c.value)) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); n++; } }); return n; })()`);
  h.log('ring target ticked:', tickedRing);
  await h.waitFor("!!document.querySelector('[data-ring-cell]')", 60000, 1000); await h.sleep(1000);
  h.log('ring head:', await dump(h, '#dsRingBody', 500));
  const cellSel = `[data-ring-cell^="${pid}|"]`;
  h.log('cell before:', await h.eval(`document.querySelector(${JSON.stringify(cellSel)})?.innerText.replace(/\\s+/g, ' ')`));
  // the 🔎 in the cell scans this deployment against that target (no changes); ⚖ opens Reconcile
  const recBtn = await h.eval(`(() => { const b = document.querySelector('[data-ring-scan1^="' + ${JSON.stringify(pid)} + '|"]'); if (!b) return 'no scan button'; b.click(); return 'clicked ' + b.textContent.trim(); })()`);
  h.log('ring scan:', recBtn);
  await h.waitFor("!document.querySelector('[data-ring-scan1^=\"" + pid + "|\"]')?.disabled && !/not scanned|⏳/.test(document.querySelector(" + JSON.stringify(cellSel) + ")?.innerText || '')", 600000, 2000);
  await h.sleep(1000);
  const cell = await h.eval(`(() => { const c = document.querySelector(${JSON.stringify(cellSel)}); if (!c) return null; const t = c.querySelector('.ds-ring-counts'); return { text: c.innerText.replace(/\\s+/g, ' ').trim(), title: t ? t.title : '', m: c.querySelector('.ds-ring-m')?.textContent, ch: c.querySelector('.ds-ring-c')?.textContent, e: c.querySelector('.ds-ring-e')?.textContent, clean: !!c.querySelector('.ds-ring-clean') }; })()`);
  h.log('RING CELL:', JSON.stringify(cell));
  await h.shot(h.shots + '/ring.png');

  // ── 3. Deploy page ──
  await h.eval(`window.runProfile(${JSON.stringify(pid)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 600000, 1000);
  await h.sleep(1500);
  h.log('DEPLOY SUMMARY:', await dump(h, '#dsDepSummary', 600));
  h.log('DEPLOY per object:', JSON.stringify(await h.eval(`[...document.querySelectorAll('[data-dep-obj]')].filter(e => e.dataset.depTab === undefined || e.dataset.depTab === 'ins').map(e => (e.dataset.depObj || 'ROOT') + ': ' + e.innerText.replace(/\\s+/g, ' ').trim().slice(0, 80)).slice(0, 14)`)));
  h.log('DEPLOY root buckets:', JSON.stringify(await h.eval(`[...document.querySelectorAll('[data-dep-obj=""][data-dep-tab]')].map(e => e.dataset.depTab + '=' + e.innerText.replace(/\\s+/g, ' ').trim())`)));
  await h.shot(h.shots + '/deploy-scan.png');
}
