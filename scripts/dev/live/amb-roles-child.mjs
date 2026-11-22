// Read only (a scan, no write). Owner 2026-11-22 on ⚠ Needs a decision:
//   "here we show the org names. but we dont say who is the source and who is the target"
//   "we dont see it in the needs a decision for the contact object."
// The root tab: every org named with its side. Then the child's card → its own tab, with the names one org holds
// more than once and their merge. The merge button is NOT pressed. Light and dark.
const dump = async (h, sel, n = 1200) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Accounts tree';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('fixture profile missing');
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000); await h.sleep(2500);
  await h.eval("(() => { const st = document.createElement('style'); st.textContent = '* { transition: none !important; }'; document.head.appendChild(st); return true; })()");
  const shots = async tag => { for (const dark of [false, true]) { await h.eval(`document.documentElement.classList.toggle('ds-dark', ${dark})`); await h.sleep(400); await h.shot(h.shots + `/amb-roles-${tag}-${dark ? 'dark' : 'light'}.png`); } };

  // 1 · the root tab
  await h.eval(`document.querySelector('[data-dep-tab="amb"]').click()`); await h.sleep(1500);
  h.log('ROOT role chips on the tab:', await h.eval("document.querySelectorAll('#dsDepList .ds-role').length"));
  h.log('ROOT intro:', await dump(h, '#dsDepList .ds-dep-amb-intro', 400));
  h.log('ROOT first group:', await dump(h, '#dsDepList .ds-amb-group', 600));
  h.log('attributes carrying markup:', await h.eval("[...document.querySelectorAll('#dsDepList [title], #dsDepList [aria-label]')].filter(e => /<span/.test((e.getAttribute('title') || '') + (e.getAttribute('aria-label') || ''))).length"));
  await h.eval("document.querySelector('#dsDepList')?.scrollIntoView({ block: 'start' })"); await h.sleep(400);
  await shots('root');

  // 2 · the child cards among the notes
  const cards = await h.eval("[...document.querySelectorAll('.ds-dep-childdup')].map(c => ({ head: c.querySelector('.ds-rec-dup-head')?.innerText, go: c.querySelector('[data-dep-tab-go]')?.dataset.depTabObj || null, rows: c.querySelector('.ds-rec-dup-rows')?.innerText.slice(0, 300) }))");
  h.log('CHILD CARDS:', JSON.stringify(cards));
  if (!cards.length) { h.log('no child object with a duplicated name in this scan'); return; }
  await h.eval("document.querySelector('.ds-dep-childdup [data-dep-tab-go]').click()"); await h.sleep(2000);
  h.log('object selected:', await h.eval("document.querySelector('.ds-dep-objbtn[aria-pressed=\"true\"]')?.innerText.replace(/\\s+/g, ' ')"));
  h.log('tab selected:', await h.eval("document.querySelector('.ds-dep-tabs [aria-selected=\"true\"]')?.innerText.replace(/\\s+/g, ' ')"));
  h.log('child rows:', await h.eval("document.querySelectorAll('#dsDepList .ds-dep-row-amb').length"), '· one-sided groups:', await h.eval("document.querySelectorAll('.ds-amb-one').length"), '· merge buttons:', await h.eval("document.querySelectorAll('[data-dep-dup-merge]').length"));
  h.log('CHILD TAB:', await dump(h, '#dsDepList', 1500));
  await h.eval("document.querySelector('#dsDepList')?.scrollIntoView({ block: 'start' })"); await h.sleep(400);
  await shots('child');
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 3)')).slice(0, 300));
}
