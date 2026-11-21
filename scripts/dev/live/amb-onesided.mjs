// Read only (a scan, no write): ⚠ Needs a decision lists the names only ONE org holds more than once, under the
// questions, each with its merge (owner 2026-11-20: "why we dont see this in needs a decision? shouldn't they be
// merged?"). The merge button is NOT pressed here. Light and dark.
const dump = async (h, sel, n = 1200) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Accounts tree';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('fixture profile missing');
  // ALL=1: every Account of the source, no children — the org's own duplicate names come into the scan (in this throwaway browser profile only)
  if (process.env.ALL === '1') h.log('all records:', await h.eval(`(() => { const p = _profiles.find(x => x.id === ${JSON.stringify(id)}); p.tree.recordIds = []; p.tree.where = "Name LIKE 'SFTK%'"; p.tree.children = []; delete p.lastScan; return p.tree.objectType; })()`));
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000); await h.sleep(2000);
  h.log('warning:', await dump(h, '.ds-rec-dups', 700));
  h.log('"Show them" in the warning:', await h.eval("!!document.querySelector('.ds-rec-dups [data-dep-tab-go=\"amb\"]')"));
  await h.eval(`(document.querySelector('.ds-rec-dups [data-dep-tab-go="amb"]') || document.querySelector('[data-dep-obj=""][data-dep-tab="amb"]') || document.querySelector('[data-dep-tab="amb"]')).click()`);
  await h.sleep(1500);
  h.log('tab selected:', await h.eval("document.querySelector('.ds-dep-tabs [aria-selected=\"true\"]')?.innerText.replace(/\\s+/g, ' ')"));
  h.log('groups:', await h.eval("document.querySelectorAll('.ds-amb-one').length"), '· merge buttons:', await h.eval("document.querySelectorAll('[data-dep-dup-merge]').length"));
  h.log('ONE-SIDED:', await dump(h, '.ds-amb-onesided', 1300));
  await h.eval("document.querySelector('.ds-amb-onesided')?.scrollIntoView({ block: 'start' })"); await h.sleep(400);
  // a hidden headless page does not run CSS transitions to their end: switch them off so a theme flip is drawn as it ends
  await h.eval("(() => { const st = document.createElement('style'); st.textContent = '* { transition: none !important; }'; document.head.appendChild(st); return true; })()");
  await h.eval("document.querySelector('.ds-rec-dup-more')?.setAttribute('open', '')");
  h.log('WHAT TO DO:', await dump(h, '.ds-rec-dup-fix', 900));
  for (const dark of [false, true]) {
    await h.eval(`document.documentElement.classList.toggle('ds-dark', ${dark})`); await h.sleep(400);
    await h.shot(h.shots + `/amb-onesided-${dark ? 'dark' : 'light'}.png`);
  }
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 3)')).slice(0, 300));
}
