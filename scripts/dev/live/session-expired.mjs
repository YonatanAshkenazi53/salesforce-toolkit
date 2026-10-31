// Live, read-only: what the pages say when an org's session has EXPIRED (pre-ship QA
// 2026-10-31). Both orgs are logged in, the Deploy page scanned once, then the source org's
// session cookie is replaced by garbage (CDP Network.setCookie — the org itself is untouched)
// and the scan is pressed again: the page must say which org to sign in to again, in words,
// not a raw 401. Then the Toolkit: the Flows list on the same dead session.
const NL = String.fromCharCode(10);
const flat = s => String(s || '').split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);

export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const id = await h.eval(`_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id`);
  const src = await h.eval(`_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.sourceOrg`);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await waitScanned(h); await h.sleep(800);
  h.log('1. scanned once; plan rows:', await h.eval(`document.querySelectorAll('.ds-dep-plan tr').length`));
  // kill the source session: the sid cookie on both of the org's hosts becomes garbage
  const host = new URL(src).hostname, lightning = host.replace('.my.salesforce.com', '.lightning.force.com');
  for (const d of [host, lightning]) {
    const r = await h.cdp('Network.setCookie', { name: 'sid', value: 'expired-by-the-qa-script', domain: d, path: '/', secure: true, httpOnly: true });   // the page session has the Network domain; the browser target does not
    h.log(`2. sid replaced on ${d}:`, JSON.stringify(r));
  }
  // the page is reloaded, as when a person comes back later: the extension reads the (dead) cookie afresh
  await h.studio(''); await h.sleep(1500);
  h.log('2b. after reload — org strip:', flat(await h.eval(`(document.querySelector('.ds-topbar')?.innerText || '')`)).slice(0, 300));
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepRefresh') || document.querySelector('#dsDepScan'))?.click()`);
  await h.waitFor("!document.querySelector('#dsDepRefresh')?.disabled || !!document.querySelector('.ds-toast') || /sign in|log in|session|expired|open .* in a (Chrome )?tab/i.test(document.querySelector('#dsMain')?.innerText || '')", 120000, 500);
  await h.sleep(2500);
  h.log('3. TOASTS:', flat(await h.eval(`[...document.querySelectorAll('.ds-toast')].map(t => t.innerText).join(' || ')`)).slice(0, 800));
  h.log('3. PAGE (what the Deploy page says):', flat(await h.eval(`(document.querySelector('.ds-dep-plan, #dsDepList, .ds-rec-card-warn, #dsMain')?.innerText || '')`)).slice(0, 1200));
  h.log('3. raw 401/INVALID_SESSION shown to the user?', await h.eval(`/INVALID_SESSION_ID|401|Session expired or invalid/.test(document.body.innerText)`));
  // does the parents card settle (a word) or spin for good?
  await h.waitFor("!/checking|reading/.test(document.querySelector('#dsDepParentsChip')?.textContent || '')", 90000, 1000).catch(() => {});
  h.log('3b. parents chip after up to 90 s:', await h.eval(`document.querySelector('#dsDepParentsChip')?.textContent`), '| card:', flat(await h.eval(`(document.querySelector('#dsDepOrder')?.innerText || '')`)).slice(0, 300));
  await h.shot(h.shots + '/session-expired-studio.png');
  // the Toolkit on the dead session
  await h.popup('flows'); await h.sleep(4000);
  h.log('4. TOOLKIT banner / org pill:', flat(await h.eval(`(document.querySelector('#orgBadge, .org-pill, #orgPill, .info-banner, .error-banner')?.innerText || '')`)).slice(0, 300), '| body says sign in?', await h.eval(`/sign in|log in|session|expired/i.test(document.body.innerText)`));
  h.log('4. flows listed:', await h.eval(`document.querySelectorAll('.flow-group').length`), '| ERROR TEXT:', flat(await h.eval(`[...document.querySelectorAll('.error, .error-banner, .info-banner, [class*=error]')].map(e => e.innerText).join(' || ')`)).slice(0, 600));
  await h.shot(h.shots + '/session-expired-popup.png');
}
