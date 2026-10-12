// Store screenshots from the PUBLIC build, both orgs open, 1280×800 (the Chrome Web
// Store's size), light and dark: the Toolkit home, Flows, Dependencies, Lightning Pages,
// Field Cleaner results; Data Studio's Deploy page, History, Org Compare, Org health.
// Nothing is written to either org. Output: dist/store-shots/<n>-<name>[-dark].png
//   SFTK_EXT=dist/store-staging SFTK_WINDOW=1280,800 node scripts/dev/headless-studio.mjs scripts/dev/live/screenshots.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
export default async function (h) {
  const out = resolve('dist/store-shots'); mkdirSync(out, { recursive: true });
  let n = 0;
  const shot = async (name) => {
    await h.sleep(900);
    const r = await h.cdp('Page.captureScreenshot', { format: 'png' });
    const f = join(out, `${String(++n).padStart(2, '0')}-${name}.png`);
    writeFileSync(f, Buffer.from(r.data, 'base64')); h.log('shot', f);
  };
  const dark = async (on) => { const cur = await h.eval("document.documentElement.dataset.theme || ''"); if ((cur === 'dark') !== on) { await h.eval("(document.querySelector('#sftkDarkToggle') || document.querySelector('#dsDarkToggle'))?.click()"); await h.sleep(500); } };
  await h.login('npc2'); await h.login('npc');
  await h.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  // ── the Toolkit ──
  await h.popup('flows'); await h.watchErrors();
  await h.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await h.waitFor("document.querySelectorAll('.flow-group').length > 0", 240000, 1000);
  await h.eval("document.querySelector('#homeBtn')?.click()"); await h.sleep(800); await shot('toolkit-home');
  await h.eval("document.querySelector('[data-tab=\"flows\"]')?.click()"); await h.sleep(800);
  await h.eval("(() => { const g = [...document.querySelectorAll('.flow-group')].find(g => /SFTK Dep Test/.test(g.dataset.label)); if (g) g.querySelector('.flow-group-header').click(); return true; })()");
  await shot('toolkit-flows');
  await h.eval("document.querySelector('[data-tab=\"dependencies\"]')?.click()");
  // above 150 flow versions the page waits for "Scan dependencies (N calls)" (the extra fixture flows, 2026-10-10)
  await h.sleep(2500);
  await h.eval("(() => { const b = [...document.querySelectorAll('button')].find(b => /Scan dependencies/.test(b.textContent)); if (b) b.click(); return !!b; })()");
  await h.waitFor("!!document.querySelector('#depBulkBtn')", 240000, 1000); await h.sleep(1500); await shot('toolkit-dependencies');
  await h.eval("document.querySelector('#depBulkBtn').click()"); await h.waitFor("document.querySelectorAll('.dep-fb-cb').length > 0", 300000, 1000); await h.sleep(800); await shot('toolkit-flow-switches');
  await h.eval("document.querySelector('[data-tab=\"pages\"]')?.click()");
  await h.waitFor("document.querySelectorAll('.lp-row, [data-lp-id]').length > 0", 240000, 1000); await h.sleep(1200); await shot('toolkit-lightning-pages');
  await h.eval("document.querySelector('[data-tab=\"fields\"]')?.click()"); await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  const pick = async (inputSel, dropSel, api) => {
    await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
    await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
    await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
    await h.eval(`(() => { document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
    await h.sleep(800);
  };
  await pick('#fcObjInput', '#fcObjDrop', 'Account'); await pick('#fcFieldInput', '#fcFieldDrop', 'SFTK_FC_Test_Status__c');
  await h.click('#fcScanBtn');
  await h.waitFor("/dependencies on/.test(document.querySelector('#fcResults')?.innerText || '') && !/scanning|⏳/i.test(document.querySelector('#fcScanBtn')?.innerText || '')", 180000, 1000);
  await h.sleep(1500); await shot('toolkit-field-cleaner');
  await dark(true); await shot('toolkit-field-cleaner-dark'); await dark(false);
  // ── Data Studio ──
  await h.studio('#/profiles');
  await h.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  await h.eval("(async () => { for (const p of _profiles) { p.sourceOrg = 'https://trailheads5.my.salesforce.com'; p.targetOrg = 'https://trailheads4.my.salesforce.com'; } await storageSaveProfiles(); return true; })()");
  await h.eval("location.hash = '#/profiles'"); await h.sleep(1200); await shot('studio-deployments');
  const id = await h.eval("_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id");
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval("(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()");
  await h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000); await h.sleep(1500);
  await shot('studio-deploy');
  await h.eval("document.querySelector('#dsDepTree')?.scrollIntoView({ block: 'start' })"); await shot('studio-deploy-tree');
  await h.eval("document.querySelector('[data-dep-obj=\"\"][data-dep-tab=\"ins\"]')?.click()"); await h.sleep(600);
  await h.eval("document.querySelector('#dsDepRecords')?.scrollIntoView({ block: 'start' })"); await shot('studio-deploy-records');
  await h.eval("location.hash = '#/compare'"); await h.sleep(1200);
  await h.eval("(() => { const pick = (sel, re) => { const s = document.querySelector(sel); const o = [...s.options].find(o => re.test(o.value) || re.test(o.text)); if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); } }; pick('#dsOCSrc', /trailheads5/); pick('#dsOCTgt', /trailheads4/); return true; })()");
  await h.waitFor("document.querySelectorAll('[data-oc-obj]').length > 0", 120000, 1000); await h.sleep(400);
  await h.eval("document.querySelector('#dsOCSelNone')?.click(); for (const o of ['Account', 'Contact', 'Opportunity']) { const c = document.querySelector('[data-oc-obj=\"' + o + '\"]'); if (c && !c.checked) c.click(); }");
  await h.click('#dsOCRun'); await h.waitFor("!document.querySelector('#dsOCRun').disabled && !document.querySelector('.ds-oc-pending')", 300000, 1000); await h.sleep(800); await shot('studio-org-compare');
  await h.eval("location.hash = '#/orghealth'"); await h.sleep(1500);
  await h.eval("document.querySelector('#dsOhAll')?.click()"); await h.sleep(1500);
  await h.waitFor("![...document.querySelectorAll('[data-oh-check]')].some(b => /checking/.test(b.textContent))", 300000, 1000); await h.sleep(800); await shot('studio-org-health');
  await dark(true); await h.eval("location.hash = '#/orgs'"); await h.sleep(1200); await shot('studio-connected-orgs-dark'); await dark(false);
  h.log(`✓ ${n} screenshots in ${out}`);
}
