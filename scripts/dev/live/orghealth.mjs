// Live (campaign 3, phase 8): Data Studio → Org health on ORG (default npc):
// the page opens on the stored answers without reading, then ✓ Check all runs
// every card; prints each card's text. Compare with the CLI (see the fixture
// README / the commit for the queries).
const dump = async (h, sel, n = 3000) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
export default async function (h) {
  // RING=1: both fixture orgs, trailheads5 as the source — the picklist card compares them.
  await h.login(process.env.ORG || 'npc'); if (process.env.RING === '1') await h.login('npc2');
  await h.studio('#/orghealth'); await h.watchErrors();
  if (process.env.RING === '1') {
    await h.eval(`(() => { _ring = { orgs: ['https://trailheads5.my.salesforce.com', 'https://trailheads4.my.salesforce.com'], sourceUrl: 'https://trailheads5.my.salesforce.com' }; _ohOrg = 'https://trailheads5.my.salesforce.com'; renderOrgHealth(); return true; })()`);
    await h.sleep(1500);
  }
  await h.waitFor("!!document.querySelector('[data-oh-card]')", 30000, 500);
  await h.sleep(2500);
  h.log('BEFORE CHECK:', await dump(h, '#dsMain', 1500));
  await h.eval(`document.querySelector('#dsOhAll')?.click()`);
  await h.sleep(1500);
  await h.waitFor("![...document.querySelectorAll('[data-oh-check]')].some(b => /checking/.test(b.textContent))", 300000, 1000);
  await h.sleep(1000);
  for (const id of await h.eval(`[...document.querySelectorAll('[data-oh-card]')].map(c => c.dataset.ohCard)`)) {
    h.log(`CARD ${id}:`, await dump(h, `[data-oh-card="${id}"]`, 1200));
  }
  h.log('BUDGET:', await dump(h, '#dsOhBudget', 300));
  await h.shot(h.shots + '/orghealth.png');
}
