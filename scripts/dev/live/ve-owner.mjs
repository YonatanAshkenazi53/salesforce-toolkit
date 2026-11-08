// Read-only on the orgs: ▸ record on the Accounts-tree fixture — the Owner row (user 2026-11-08: "we need to show
// ownerid and to make sure user can select queues or users"): the source owner, the default said in words, the
// search over npc2's queues (SFTK Test Queue takes Account) and active users, a queue picked and stored as the
// value OwnerId, then a user, then cleared. DARK=1 shoots the dialog in dark too. No deploy.
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const id = await h.eval(`_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id`);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000); await h.sleep(2000);
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="ins"]')?.click()`); await h.sleep(1000);
  const rid = await h.eval(`(() => { const r = [...document.querySelectorAll('#dsDepList .ds-dep-row')].find(x => x.querySelector('[data-dep-vals]')); return r ? r.querySelector('[data-dep-vals]').dataset.depVals : null; })()`);
  h.log('row id:', rid);
  await h.eval(`document.querySelector('[data-dep-vals="${rid}"]').click()`);
  await h.waitFor("!!document.querySelector('#dsValEdHost tr[data-ve-row=\"OwnerId\"]')", 60000, 500); await h.sleep(800);
  const row = () => h.eval(`(() => { const tr = document.querySelector('#dsValEdHost tr[data-ve-row="OwnerId"]'); return tr ? { pos: [...tr.parentElement.children].indexOf(tr), src: tr.querySelector('.ds-ve-src')?.innerText, tgt: tr.querySelector('.ds-ve-tgt')?.innerText, cur: tr.querySelector('.ds-ve-lkp-cur')?.innerText, on: tr.classList.contains('ds-ve-row-on') } : null; })()`);
  h.log('Owner row:', JSON.stringify(await row()));
  await h.eval(`document.querySelector('#dsValEdHost tr[data-ve-row="OwnerId"]').scrollIntoView({ block: 'center' })`); await h.sleep(200);
  await h.shot(h.shots + '/ve-owner-1.png');
  // the search: queues that take Account, then active users
  await h.eval(`(() => { const i = document.querySelector('#dsValEdHost .ds-ve-own-in'); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor("document.querySelectorAll('#dsValEdHost .ds-ve-own-res [data-ve-own-hit]').length > 0", 60000, 400); await h.sleep(400);
  h.log('results:', JSON.stringify(await h.eval(`[...document.querySelectorAll('#dsValEdHost .ds-ve-own-res > *')].map(x => x.innerText.replace(/\\s+/g, ' ')).slice(0, 10)`)));
  await h.shot(h.shots + '/ve-owner-2-search.png');
  if (process.env.DARK === '1') { await h.eval(`document.documentElement.classList.toggle('ds-dark', true)`); await h.sleep(600); await h.shot(h.shots + '/ve-owner-2-search-dark.png'); await h.eval(`document.documentElement.classList.toggle('ds-dark', false)`); }
  // pick the queue
  const queueHit = await h.eval(`(() => { const b = [...document.querySelectorAll('#dsValEdHost .ds-ve-own-res [data-ve-own-hit]')].find(x => /👥/.test(x.textContent)); if (!b) return null; b.click(); return b.dataset.veOwnName; })()`);
  await h.sleep(900);
  h.log('picked queue:', queueHit, '| stored =', JSON.stringify(await h.eval(`sftkValOvGet(_reconcileProfile.tree, _reconcileProfile.targetOrg, '${rid}')`)), '| row:', JSON.stringify(await row()));
  await h.shot(h.shots + '/ve-owner-3-queue.png');
  // then a user
  await h.eval(`(() => { const i = document.querySelector('#dsValEdHost .ds-ve-own-in'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor("[...document.querySelectorAll('#dsValEdHost .ds-ve-own-res [data-ve-own-hit]')].some(x => /👤/.test(x.textContent))", 60000, 400); await h.sleep(300);
  const userHit = await h.eval(`(() => { const b = [...document.querySelectorAll('#dsValEdHost .ds-ve-own-res [data-ve-own-hit]')].find(x => /👤/.test(x.textContent)); if (!b) return null; b.click(); return b.dataset.veOwnName; })()`);
  await h.sleep(900);
  h.log('picked user:', userHit, '| stored =', JSON.stringify(await h.eval(`sftkValOvGet(_reconcileProfile.tree, _reconcileProfile.targetOrg, '${rid}')`)));
  h.log('status line:', await h.eval(`document.querySelector('#dsVeStatus')?.textContent`));
  // and back
  await h.eval(`document.querySelector('#dsValEdHost [data-ve-own-clear]').click()`); await h.sleep(900);
  h.log('after ✕: stored =', JSON.stringify(await h.eval(`sftkValOvGet(_reconcileProfile.tree, _reconcileProfile.targetOrg, '${rid}')`)), '| row:', JSON.stringify(await row()));
  await h.shot(h.shots + '/ve-owner-4-cleared.png');
}
