// Live QA (2026-10-18), read-only: the Deploy page's layout in each state, with screenshots for review.
//   1. one org closed: the warning sits inside "About this deployment"; parents say they wait for both orgs
//   2. both open, the Accounts tree (a parent object missing in the target): the parents card shows
//   3. both open, the volume deployment (accounts only): parents ready → one line, no card
//   4. Fold all → every section folded; a fresh page load keeps them folded; Unfold all → all open
//   5. the org picker folds itself once the pair is set and both orgs are open
// Screenshots: dist/qa/shots/deploy-*.png
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const SHOTS = 'dist/qa/shots';
const SRC = 'https://trailheads5.my.salesforce.com', TGT = 'https://orgfarm-e2c4511b2b-dev-ed.develop.my.salesforce.com';
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);
const folds = h => h.eval(`JSON.stringify([...document.querySelectorAll('details.ds-dep-fold[data-fold]')].map(d => d.dataset.fold + (d.open ? ':open' : ':folded')))`);
const checks = [];
const check = (h, what, ok, extra = '') => { checks.push([what, ok]); h.log(ok ? '✓' : '❌', what, extra); };
async function open(h, name) {
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(name)})?.id`);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(2000);
}
export default async function (h) {
  mkdirSync(SHOTS, { recursive: true });
  const all = JSON.parse(readFileSync('docs/fixtures/complex-deployment/profiles.json', 'utf8'));
  const vol = JSON.parse(JSON.stringify(all.find(p => (p.profile || p).name === 'SFTK VOL — Accounts')));
  const vp = vol.profile || vol; Object.assign(vp, { name: 'QA states volume', sourceOrg: SRC, targetOrg: TGT }); vp.tree.where = "Name LIKE 'SFTK VOL Account 0070%'"; vp.tree.children = [];
  mkdirSync('dist/tmp', { recursive: true }); writeFileSync('dist/tmp/qa-states.json', JSON.stringify([vol]));

  // 1. only the source is open
  await h.login('npc'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  // the harness import re-points deployments to the orgs it sees logged in — put the real pair back
  await h.eval(`(async () => { for (const p of _profiles) if (/^SFTK (CX|VOL)/.test(p.name)) { p.sourceOrg = ${JSON.stringify(SRC)}; p.targetOrg = ${JSON.stringify(TGT)}; } _settings.deployFolds = {}; await storageSaveProfiles(); await storageSaveSettings(); return true; })()`);
  await open(h, 'SFTK CX — Accounts tree');
  const info1 = await h.eval(`(document.querySelector('.ds-dep-info')?.innerText || document.querySelector('.ds-dep-page')?.innerText || '').slice(0, 600)`);
  h.log('1. one org closed:', info1.replace(/\s+/g, ' ').slice(0, 400));
  // nothing read yet → the picker card says which org is closed; once read, the warning moves into About
  check(h, '1. the page says which org is closed', /not open|Only trailheads5 is open/.test(info1), '');
  await h.shot(`${SHOTS}/deploy-1-one-org-closed.png`);

  // 2. both open, a parent object missing
  await h.login('npc2'); await h.studio(''); await h.importProfiles('dist/tmp/qa-states.json');
  await h.eval(`(async () => { for (const p of _profiles) if (/^SFTK (CX|VOL)|^QA states/.test(p.name)) { p.sourceOrg = ${JSON.stringify(SRC)}; p.targetOrg = ${JSON.stringify(TGT)}; } await storageSaveProfiles(); return true; })()`);
  await open(h, 'SFTK CX — Accounts tree');
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`); await waitScanned(h);
  await h.waitFor("!/reading what each object points at/.test(document.querySelector('#dsDepOrder')?.innerText || '')", 120000, 1000).catch(() => {});
  await h.sleep(1500);
  const order2 = await h.eval(`document.querySelector('#dsDepOrder')?.innerText || ''`);
  h.log('2. parents:', order2.replace(/\s+/g, ' ').slice(0, 300));
  check(h, '2. a missing parent shows the parents card', /Start with parents first/.test(order2));
  check(h, '2. the order: About, tree, org picker, plan', await h.eval(`(() => { const p = document.querySelector('.ds-dep-page'); const at = s => { const e = p.querySelector(s); return e ? [...p.querySelectorAll('*')].indexOf(e) : -1; }; const a = at('.ds-dep-info'), t = at('#dsDepTree'), o = at('.ds-dep-orgs'), pl = at('.ds-dep-plan'); return a >= 0 && a < t && t < o && o < pl; })()`));
  check(h, '5. the org picker is folded by itself (pair set, both open)', await h.eval(`!document.querySelector('details.ds-dep-orgs')?.open`), await h.eval(`document.querySelector('details.ds-dep-orgs > summary')?.innerText || ''`));
  await h.shot(`${SHOTS}/deploy-2-parents-missing.png`);

  // 3. parents ready
  await open(h, 'QA states volume');
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`); await waitScanned(h);
  await h.waitFor("!/reading what each object points at/.test(document.querySelector('#dsDepOrder')?.innerText || '')", 120000, 1000).catch(() => {});
  await h.sleep(1500);
  const order3 = await h.eval(`document.querySelector('#dsDepOrder')?.innerHTML || ''`);
  h.log('3. parents:', order3.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300));
  h.log('3. note: the volume accounts look up Individual / Parent outside the deployment — if the line is a card, say which state it is in');
  await h.shot(`${SHOTS}/deploy-3-volume.png`);

  // 4. fold all, reload, unfold all
  await open(h, 'SFTK CX — Accounts tree'); await h.sleep(1500);
  await h.eval(`document.querySelector('#dsDepFoldAll').click()`); await h.sleep(800);
  const f1 = await folds(h); h.log('4. after Fold all:', f1);
  check(h, '4. Fold all folds every section', !/:open/.test(f1));
  await h.shot(`${SHOTS}/deploy-4-folded.png`);
  await h.studio(''); await open(h, 'SFTK CX — Accounts tree'); await h.sleep(2500);
  const f2 = await folds(h); h.log('4. after a fresh page load:', f2);
  check(h, '4. a fresh page load keeps them folded', !/:open/.test(f2));
  await h.eval(`document.querySelector('#dsDepUnfoldAll').click()`); await h.sleep(800);
  const f3 = await folds(h); h.log('4. after Unfold all:', f3);
  check(h, '4. Unfold all opens every section', !/:folded/.test(f3));
  await h.shot(`${SHOTS}/deploy-5-unfolded.png`);
  await h.eval(`(async () => { _profiles = _profiles.filter(p => p.name !== 'QA states volume'); _settings.deployFolds = {}; await storageSaveProfiles(); await storageSaveSettings(); return true; })()`);
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 5)')).slice(0, 500));
  if (checks.some(c => !c[1])) throw new Error('a layout check failed');
}
