// Live: do Org Compare, the Sync Ring and the Deploy page agree about the same data?
// Fixture: docs/fixtures/complex-deployment (profiles.json), trailheads5 → trailheads4.
//   1. Org Compare (whole objects, no profile filter): Account, Contact, Opportunity.
//   2. All open orgs: scan the PROFILE deployment's cell for trailheads4 (missing / changed / extra).
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

  // ── 2. All open orgs (the ring page, redone 2026-10-01: a source select, one column per
  // other open org, the Scan button on the target column) — scan this deployment's cell ──
  await h.eval(`document.querySelector('[data-view="ring"]')?.click()`);
  await h.waitFor("!!document.querySelector('#dsRingSrc')", 60000, 500); await h.sleep(1000);
  h.log('SOURCE menu:', await setSelect(h, '#dsRingSrc', 'https://trailheads5.my.salesforce.com'));
  await h.sleep(1500);
  await h.waitFor("!!document.querySelector('[data-ring-cell]')", 60000, 1000); await h.sleep(1000);
  h.log('ring head:', await dump(h, '#dsRingBody', 500));
  const cellSel = `[data-ring-cell^="${pid}|"]`;
  h.log('cell before:', await h.eval(`document.querySelector(${JSON.stringify(cellSel)})?.innerText.replace(/\\s+/g, ' ')`));
  // the column's Scan button scans every deployment against trailheads4 (no changes)
  const recBtn = await h.eval(`(() => { const b = [...document.querySelectorAll('[data-ring-scantgt]')].find(b => /trailheads4/.test(b.dataset.ringScantgt) && !b.disabled); if (!b) return 'no scan button'; b.click(); return 'clicked ' + b.textContent.trim(); })()`);
  h.log('ring scan:', recBtn);
  await h.waitFor("!/scanning|⏳/i.test(document.querySelector(" + JSON.stringify(cellSel) + ")?.innerText || '') && /\\d/.test(document.querySelector(" + JSON.stringify(cellSel) + ")?.innerText || '')", 600000, 2000);
  await h.sleep(1000);
  const cell = await h.eval(`(() => { const c = document.querySelector(${JSON.stringify(cellSel)}); if (!c) return null; return { text: c.innerText.replace(/\\s+/g, ' ').trim(), drift: c.className }; })()`);
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
