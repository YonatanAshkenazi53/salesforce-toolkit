// QA: the upgrade a store user gets — 1.0.0 → 1.1.0 on ONE browser profile and ONE extension folder (so the same
// extension id and the same stored data). Driven by scripts/dev/qa/upgrade.mjs:
//   PHASE=seed    on the 1.0.0 files: accept the licence, open every page and tool on npc, import the fixture
//                 deployments, switch dark mode on — then write what the storage holds to STATE_FILE
//   PHASE=check   on the 1.1.0 files, same profile: the licence is NOT asked again, every stored key is still there,
//                 the deployments are still listed, every page and tool opens with no exception
// Read-only in Salesforce.
import { readFileSync, writeFileSync } from 'node:fs';
const PHASE = process.env.PHASE || 'seed';
const STATE = process.env.STATE_FILE;
const NL = String.fromCharCode(10);
const storage = h => h.eval(`new Promise(res => chrome.storage.local.get(null, all => res(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, JSON.stringify(v === undefined ? null : v).length])))))`);
const deployments = h => h.eval(`new Promise(res => chrome.storage.local.get(null, all => { const k = Object.keys(all).find(k => /profile/i.test(k) && Array.isArray(all[k])); res(k ? { key: k, names: all[k].map(p => p && p.name).filter(Boolean) } : { key: null, names: [] }); }))`);

async function tour(h, problems) {
  // Data Studio: every view the build has
  await h.studio();
  const views = await h.eval(`[...document.querySelectorAll('.ds-nav-btn[data-view]')].filter(b => b.offsetParent).map(b => b.dataset.view)`);
  for (const v of views) {
    await h.eval(`(() => { document.querySelector('.ds-nav-btn[data-view="${v}"]').click(); return true; })()`);
    await h.sleep(3500);
    const len = await h.eval(`(document.querySelector('.ds-view.active, .ds-main, main')?.innerText || document.body.innerText).trim().length`);
    h.log(`studio · ${v}: ${len} chars on screen`);
    if (len < 40) problems.push(`studio view ${v} is (nearly) empty`);
  }
  // Toolkit: every tab the build has
  await h.popup('flows');
  const tabs = await h.eval(`[...document.querySelectorAll('.tab-btn[data-tab]')].filter(b => b.offsetParent).map(b => b.dataset.tab)`);
  for (const t of tabs) {
    await h.popup(t);
    await h.sleep(6000);
    const info = await h.eval(`(() => { const p = document.querySelector('.tab-panel.active, .tab-content.active') || document.body; return { len: p.innerText.trim().length, rows: p.querySelectorAll('tr, .flow-row, .lp-row, .dep-row, .fp-row, li').length, err: (p.innerText.match(/Unknown message type|undefined is not|Cannot read prop[^|]*/g) || []).join(' ; ') }; })()`);
    h.log(`toolkit · ${t}: ${info.len} chars, ${info.rows} rows${info.err ? ' — ERROR TEXT: ' + info.err : ''}`);
    if (info.len < 40) problems.push(`toolkit tab ${t} is (nearly) empty`);
    if (info.err) problems.push(`toolkit tab ${t} shows: ${info.err}`);
  }
  return { views, tabs };
}

export default async function (h) {
  const problems = [];
  const ext = `chrome-extension://${h.extId}`;
  h.log(`PHASE ${PHASE} · manifest version ${await (async () => { await h.navigate(`${ext}/studio.html`); await h.sleep(1500); return h.eval('chrome.runtime.getManifest().version'); })()}`);
  await h.watchErrors();
  const gate = await h.eval("/I confirm that any consequence/.test(document.body.innerText)");
  h.log(`licence gate shown: ${gate}`);
  if (PHASE === 'check' && gate) problems.push('the licence is asked again after the upgrade');
  await h.login('npc');

  if (PHASE === 'seed') {
    await h.studio();
    await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
    const seen = await tour(h, problems);
    await h.popup('flows');
    await h.eval(`(() => { const b = document.querySelector('#sftkDarkToggle'); if (b) b.click(); return !!b; })()`);
    await h.sleep(800);
    const st = await storage(h), dep = await deployments(h);
    h.log(`storage: ${Object.keys(st).length} keys · deployments (${dep.key}): ${dep.names.length}`);
    writeFileSync(STATE, JSON.stringify({ keys: st, deployments: dep, seen, dark: await h.eval("document.body.classList.contains('sftk-dark')") }, null, 1));
  } else {
    const was = JSON.parse(readFileSync(STATE, 'utf8'));
    const st = await storage(h), dep = await deployments(h);
    const lost = Object.keys(was.keys).filter(k => !(k in st));
    h.log(`storage: ${Object.keys(st).length} keys now, ${Object.keys(was.keys).length} before · lost: ${lost.length ? lost.join(', ') : 'none'}`);
    // a cache may be rebuilt or dropped by design; settings, deployments, history and the licence must stay
    const mustKeep = lost.filter(k => !/cache|budget|meter|_ts$|lastSeen|session/i.test(k));
    if (mustKeep.length) problems.push(`stored keys gone after the upgrade: ${mustKeep.join(', ')}`);
    const gone = was.deployments.names.filter(n => !dep.names.includes(n));
    h.log(`deployments: ${dep.names.length} now, ${was.deployments.names.length} before · missing: ${gone.length ? gone.join(', ') : 'none'}`);
    if (gone.length) problems.push(`deployments missing after the upgrade: ${gone.join(', ')}`);
    const seen = await tour(h, problems);
    await h.popup('flows');
    const dark = await h.eval("document.body.classList.contains('sftk-dark')");
    h.log(`dark mode kept: ${dark} (was ${was.dark})`);
    if (was.dark && !dark) problems.push('dark mode was not kept');
    h.log(`views before → now: ${was.seen.views.join(',')} → ${seen.views.join(',')}`);
    h.log(`tabs before → now: ${was.seen.tabs.join(',')} → ${seen.tabs.join(',')}`);
    // the deployments list as the page draws it
    await h.studio('#/profiles'); await h.sleep(3000);
    const drawn = await h.eval(`(document.querySelector('.ds-view.active, main')?.innerText || '')`);
    const undrawn = was.deployments.names.filter(n => !drawn.includes(n));
    h.log(`deployments drawn on the page: ${was.deployments.names.length - undrawn.length} of ${was.deployments.names.length}`);
    if (undrawn.length) problems.push(`deployments not drawn after the upgrade: ${undrawn.join(', ')}`);
  }
  if (h.exceptions && h.exceptions.length) problems.push(`${h.exceptions.length} page exception(s)`);
  h.log(problems.length ? `❌ FAILED — ${problems.join(NL + '   · ')}` : `✅ ${PHASE} passed`);
}
