// Live: the parents-first journey. Open a deployment, read the "Start with
// parents first" card, take its first actionable step (➕ Deploy X first or
// ⚖ Open & fix), deploy what that page offers, come back with the ‹ Back link,
// and report whether the card now shows that parent as aligned.
//   PROFILE = deployment name (default: the Accounts tree)
const dump = async (h, sel, n = 1500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).join(' | ');
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Accounts tree';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);
  // the parents card loads on its own (probes + verdicts); wait for the chip to settle
  await h.waitFor("!/⏳|checking|…$/.test(document.querySelector('#dsDepParentsChip')?.innerText || '') && !!document.querySelector('#dsDepOrder')?.innerText", 120000, 1000);
  await h.sleep(1500);
  h.log('PARENTS CARD (before):', await dump(h, '#dsDepOrder', 2500));
  h.log('chip:', await dump(h, '#dsDepParentsChip', 200));
  await h.shot(h.shots + '/parents-before.png');
  // first step with a button that opens a journey
  const step = await h.eval(`(() => {
    const b = [...document.querySelectorAll('#dsDepOrder button')].find(b => /Deploy .* first|Open & fix|Compare & fix/.test(b.textContent) && !b.disabled);
    if (!b) return null; const t = b.textContent.trim(); b.click(); return t; })()`);
  h.log('clicked step button:', JSON.stringify(step));
  if (!step) { h.log('no actionable parent step — nothing to test'); return; }
  await h.sleep(2500);
  await h.waitFor("!!document.querySelector('#dsDepBackOrigin') || !!document.querySelector('#dsRecJourneyBack') || !!document.querySelector('.ds-dep-journey')", 60000, 1000);
  h.log('journey page title:', await dump(h, '.ds-view-header', 300));
  h.log('journey banner:', await dump(h, '.ds-dep-journey', 400));
  // read it (it may scan itself when fresh), then select every insert and deploy
  const scanBtn = await h.eval(`!!document.querySelector('#dsDepScan')`);
  if (scanBtn) { await h.click('#dsDepScan'); }
  await h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);
  await h.sleep(1500);
  h.log('journey PLAN:', await dump(h, '.ds-dep-plan', 800));
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="ins"]')?.click()`); await h.sleep(400);
  await h.eval(`(() => { const b = document.querySelector('[data-dep-bulk="all"]'); if (b && !b.disabled) b.click(); })()`); await h.sleep(400);
  h.log('journey SUMMARY:', await dump(h, '#dsDepSummary', 300));
  const disabled = await h.eval(`document.querySelector('#dsRecRunBtn')?.disabled`);
  if (!disabled) {
    const histBefore = await h.eval('_history.length');
    await h.click('#dsRecRunBtn'); await h.sleep(2500);
    for (let i = 0; i < 3; i++) { const m = await h.modalText(300); if (!m) break; await h.eval(`(() => { const b = document.querySelector('#dsRecDelOk') || [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed/i.test(b.textContent)); if (b) b.click(); })()`); await h.sleep(2000); }
    for (let i = 0; i < 600; i++) { if (await h.eval(`_history.length > ${histBefore}`)) break; await h.sleep(1000); }
    await h.sleep(5000);
    await h.waitFor("!document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);
    h.log('journey run: newest History:', (await h.eval(`(_history[_history.length - 1] && (_history[_history.length - 1].profileName + ' · ' + _history[_history.length - 1].status)) || ''`)));
  } else h.log('journey: nothing selectable');
  // back to the origin
  const back = await h.eval(`(() => { const b = document.querySelector('#dsDepBackOrigin') || document.querySelector('#dsRecJourneyBack button, #dsRecJourneyBack'); if (b) { b.click(); return b.textContent.trim(); } return null; })()`);
  h.log('back link:', JSON.stringify(back));
  await h.sleep(3000);
  await h.waitFor("!!document.querySelector('#dsDepOrder')?.innerText", 120000, 1000);
  await h.waitFor("!/⏳|checking|…$/.test(document.querySelector('#dsDepParentsChip')?.innerText || '')", 120000, 1000);
  await h.sleep(1500);
  h.log('origin title:', await dump(h, '.ds-view-header', 200));
  h.log('PARENTS CARD (after):', await dump(h, '#dsDepOrder', 2500));
  h.log('chip after:', await dump(h, '#dsDepParentsChip', 200));
  await h.shot(h.shots + '/parents-after.png');
}
