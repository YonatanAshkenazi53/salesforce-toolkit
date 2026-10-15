// The sections of the walkthrough (walkthrough.mjs runs them in this order).
// Each: { id, title (the chapter), writes?, run(ctx), cleanup?(ctx) }.
// ctx = { h, rec, text, has, popup(tab), studio(hash), home() }.
//
// Most sections only read. The ones flagged `writes: true` use a tool for
// real, on FIXTURES only, and leave the org as they found it:
//   flow-switches  three fixture flows OFF, then ↩ Undo from the tool's History
//   api-versions   one fixture flow to the org's API version, then ↩ Undo
//   debugger       a trace on the running user, one save of a fixture Account
//                  that sets the recursion fixture off; the trace is stopped on
//                  camera, `cleanup` removes any trace flag left
//   fields         "Replace all" over the whole fixture (layout, Lightning page,
//                  flows), then the field itself DELETED; `cleanup` rebuilds the
//                  fixture from scratch (fixture.mjs) off camera
//   run            the whole fixture tree into trailheads4, then rolled back
// WRITES=0 leaves all four out. A confirmation that is opened only to show it
// is CANCELLED, never confirmed.
//
// Every caption states what the tool does and nothing more: when a tool
// changes, change its caption here with it.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { rebuildFieldCleanerFixture, removeIdentityField, restoreDuplicateName, removeVolume } from './fixture.mjs';

const J = JSON.stringify;
const FIXTURE = 'docs/fixtures/complex-deployment/profiles.json';
const DEMO = 'Accounts and everything under them';
const DEMO_VOL = 'Two thousand accounts';
const OLD_FIELD = 'SFTK_FC_Test_Status__c', NEW_FIELD = 'SFTK_FC_Test_Status2__c';
// the target is a Developer Edition org since 2026-10-15 (the Nonprofit Cloud trial expired)
const SRC_ORG = 'trailheads5', TGT_ORG = 'orgfarm-e2c4511b2b-dev-ed';
const SRC_URL = `https://${SRC_ORG}.my.salesforce.com`, TGT_URL = `https://${TGT_ORG}.develop.my.salesforce.com`;

// ── small helpers ──────────────────────────────────────────────────────────
// a Field Cleaner picker: focus, type, pick the item by API name
async function fcPick({ h, rec }, input, drop, api) {
  await h.eval(`(() => { const i = document.querySelector(${J(input)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await rec.fast(() => h.waitFor(`document.querySelectorAll('${drop} .fc-dd-item').length > 0`, 60000, 500));
  await rec.type(input, api, 28);
  await h.waitFor(`!!document.querySelector('${drop} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await rec.point(`${drop} .fc-dd-item[data-api="${api}"]`, 600);
  await h.eval(`(() => { const it = document.querySelector('${drop} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(900);
}
const nav = async ({ rec }, view) => { await rec.click(`.ds-nav-btn[data-view="${view}"]`, 1200); };
const waitScanned = ({ h, rec }) => rec.fast(() => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 600000, 1000));
const tick = ({ h }, sel) => h.eval(`(() => { const cb = document.querySelector(${J(sel)}); if (!cb) return false; if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
// an org treated as production asks for its name after the first confirmation
const prodGate = async ({ h }) => {
  await h.sleep(500);
  if (await h.eval(`!!document.querySelector('#sftkConfirmProd')`)) {
    await h.eval(`(() => { const i = document.querySelector('#sftkConfirmProd'); i.value = i.placeholder; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await h.eval(`document.querySelector('#sftkConfirmProdGo')?.click()`);
  }
};
// the Salesforce CLI, as JSON
const cliJson = (alias, args) => JSON.parse(execFileSync('sf', [...args, '-o', alias, '--json'], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
// any trace flag the Debugger chapter left on the running user (it stops the trace on camera; this is the net)
function clearTraceFlags(alias, log) {
  try {
    const me = cliJson(alias, ['org', 'display', 'user']).result;
    const q = cliJson(alias, ['data', 'query', '--use-tooling-api', '-q', `"SELECT Id FROM TraceFlag WHERE TracedEntityId = '${me.id}'"`]);
    const rows = (q.result && q.result.records) || [];
    for (const r of rows) cliJson(alias, ['data', 'delete', 'record', '--use-tooling-api', '-s', 'TraceFlag', '-i', r.Id]);
    log(`trace flags on ${alias}: ${rows.length} removed`);
  } catch (e) { log('trace flag cleanup:', (e && e.message) || e); }
}
// The one shared confirmation: read out, shown WHOLE (scrolled to its end — user
// 2026-10-09: "all the dialogs shown in the video are fully presented"),
// acknowledged, the production step typed (no word is typed elsewhere; the old word param is ignored, unless
// given), confirmed; then the production step if the org is treated as one.
async function confirmShared(c, { caption = '', hold = 0, word = null, flowBackupOff = false } = {}) {
  const { h, rec } = c;
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 120000, 400);
  await h.sleep(400);
  if (caption) await rec.say(caption, hold);
  await rec.reveal('.sftk-cf-host');
  if (flowBackupOff && await h.eval(`!!document.querySelector('#fcFlowBackup')?.checked`)) await rec.click('#fcFlowBackup', 500);   // no file download in a recording
  if (await c.has('#sftkConfirmAck')) { await rec.point('#sftkConfirmAck', 500); await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) a.click(); return true; })()`); await h.sleep(300); }
  await h.eval(`(() => { const b = document.querySelector('#sftkConfirmGo'); if (b) b.setAttribute('data-demo-go', '1'); return true; })()`);
  await rec.click('#sftkConfirmGo', 600);
  await prodGate(c);
  // gone, or no longer shown (a dialog that is hidden first and removed later — the Deploy run, 2026-10-10)
  await h.waitFor("(() => { const b = document.querySelector('#sftkConfirmGo[data-demo-go]'); return !b || !b.offsetParent; })()", 600000, 300);
}
// The Dependencies page above 150 flow versions does not start its scan by itself (it says
// what the scan costs and waits for you — the four extra fixture flows pushed the org over
// the line, 2026-10-10): the button is pressed on camera, and said once.
async function depScanGate(c, say = false) {
  const { h, rec } = c;
  await h.sleep(1500);
  const there = await h.eval(`(() => { const b = [...document.querySelectorAll('button')].find(b => /Scan dependencies/.test(b.textContent)); if (!b) return false; b.setAttribute('data-demo-depscan', '1'); return true; })()`);
  if (!there) return;
  if (say) await rec.say('Above a hundred and fifty flow versions the scan does not start by itself: the page says what it costs in API calls, and you start it.');
  await rec.click('[data-demo-depscan="1"]', 800);
}
// the shared confirmation (kept for old call sites: the acknowledgement only)
const typedConfirm = (c, word) => confirmShared(c, { word });
// ↩ Undo the newest change of the open tool, from the tool's own History (top bar)
async function undoInTool(c, caption) {
  const { h, rec } = c;
  await h.waitFor("document.querySelector('#sftkThBtn') && document.querySelector('#sftkThBtn').style.display !== 'none'", 30000, 500);
  await rec.click('#sftkThBtn', 900);
  await h.waitFor("document.querySelectorAll('#sftkThModalList .sftk-th-card').length > 0", 30000, 300);
  await rec.say(caption, 5500);
  const undo = '#sftkThModalList [data-th-undo]:not([disabled])';
  if (!(await c.has(undo))) throw new Error('the tool offers no undo for its newest change');
  await rec.click(undo, 600);
  await typedConfirm(c, 'UNDO');
  await rec.fast(() => h.waitFor("!!document.querySelector('#sftkThModalList .sftk-th-said')", 300000, 800));
  const said = await c.text('#sftkThModalList .sftk-th-said', 200);
  if (!/^Undone/.test(said)) throw new Error(`the undo was not verified: ${said}`);
  await rec.say('Undone.', 3800);
  await rec.click('#sftkThClose', 500);
}
// The video's own deployments: the fixture's whole Accounts tree (ten objects
// under Account — user 2026-10-09: "a more complex tree and deploy a lot of
// records"), plus two small ones for the lists. Imported through the product's
// own import.
async function ensureDemo(c) {
  const { h } = c;
  const all = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const pick = n => all.find(p => (p.profile || p).name === n);
  const base = JSON.parse(JSON.stringify(pick('SFTK CX — Accounts tree')));
  const prof = base.profile || base;
  prof.name = DEMO;
  // The direction is WRITTEN here, never left to the harness: the fixture file
  // names an org that no longer exists, and the harness then stands the logged-
  // in orgs in for it by LOGIN ORDER. On 2026-10-05 a changed login order made
  // the deployment run trailheads4 → trailheads5; it was stopped before it
  // wrote. The names are set, and checked again after the import.
  const list = [base, pick('SFTK CX — Campaigns'), pick('SFTK CX — Leads')].filter(Boolean).map(p => JSON.parse(JSON.stringify(p)));
  for (const p of list) { const q = p.profile || p; q.sourceOrg = SRC_URL; q.targetOrg = TGT_URL; }
  const file = join(resolve(process.env.REC_DIR || 'dist/video/rec'), 'demo-deployments.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(list));
  await h.importProfiles(file);
  const got = await h.eval(`(() => { const p = _profiles.find(p => p.name === ${J(DEMO)}); return p ? { id: p.id, src: p.sourceOrg || '', tgt: p.targetOrg || '' } : null; })()`);
  if (!got) throw new Error('the demo deployment could not be imported');
  if (!got.src.includes(SRC_ORG) || !got.tgt.includes(TGT_ORG)) throw new Error(`the demo deployment points ${got.src} → ${got.tgt}; it must be ${SRC_ORG} → ${TGT_ORG}`);
  return got.id;
}
// The volume deployment (user 2026-10-15: "thousands of them with fast forward … show how the numbers go
// up"): 2,000 of the source's 5,190 SFTK VOL accounts, accounts only (the Developer Edition target holds
// 5 MB), written in batches of 100 through the Collections API so the counter climbs on camera.
async function ensureVolumeDemo(c) {
  const { h } = c;
  const all = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const base = JSON.parse(JSON.stringify(all.find(p => (p.profile || p).name === 'SFTK VOL — Accounts')));
  const prof = base.profile || base;
  prof.name = DEMO_VOL;
  // SOQL LIKE knows only % and _ (a [01] class matched nothing, 2026-10-16): 00001–00999, 01000–01999, and 02000
  prof.tree.where = "Name LIKE 'SFTK VOL Account 00%' OR Name LIKE 'SFTK VOL Account 01%'";   // 00000–01999: exactly 2,000
  prof.tree.children = [];
  prof.apiMode = 'sync'; prof.batchSize = 100; prof.threads = 1;
  // bypass, as the fixture says: the target's standard Account duplicate rule BLOCKS these — their names fuzzy-match
  // each other (1,896 of 2,000 refused with DUPLICATES_DETECTED on 2026-10-16 with 'respect'); the run says it bypassed
  prof.duplicateRules = 'bypass';
  prof.sourceOrg = SRC_URL; prof.targetOrg = TGT_URL;
  const file = join(resolve(process.env.REC_DIR || 'dist/video/rec'), 'demo-volume.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify([base]));
  await h.importProfiles(file);
  const got = await h.eval(`(() => { const p = _profiles.find(p => p.name === ${J(DEMO_VOL)}); return p ? { id: p.id, src: p.sourceOrg || '', tgt: p.targetOrg || '' } : null; })()`);
  if (!got) throw new Error('the volume deployment could not be imported');
  if (!got.src.includes(SRC_ORG) || !got.tgt.includes(TGT_ORG)) throw new Error(`the volume deployment points ${got.src} → ${got.tgt}; it must be ${SRC_ORG} → ${TGT_ORG}`);
  return got.id;
}
// Before anything is written by a deployment: the page itself must say source → target as intended.
async function assertDirection({ h }) {
  const d = await h.eval(`(() => { const p = (typeof _reconcileProfile !== 'undefined' && _reconcileProfile) || null; return p ? { src: p.sourceOrg || '', tgt: p.targetOrg || '' } : null; })()`);
  if (!d || !d.src.includes(SRC_ORG) || !d.tgt.includes(TGT_ORG)) throw new Error(`the Deploy page is open ${d ? `${d.src} → ${d.tgt}` : 'on nothing'}; this chapter only ever writes ${SRC_ORG} → ${TGT_ORG}`);
}
async function openDemoScanned(c) {
  const { h } = c;
  if (!(await c.has('.ds-nav-btn'))) await c.studio('');
  const id = await ensureDemo(c);
  await h.eval(`window.runProfile(${J(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await waitScanned(c); await h.sleep(2000);
  return id;
}

export const SECTIONS = [
  // ───────────────────────────── the Toolkit ─────────────────────────────
  { id: 'home', title: 'Admin Toolkit', run: async c => {
    const { h, rec } = c;
    // the popup on a fresh profile: the licence gate is up, nothing behind it is loaded yet
    await h.navigate(`chrome-extension://${h.extId}/popup.html`);
    await h.sleep(1500);
    await rec.resume();
    await rec.say('Admin Toolkit for Salesforce. It runs in your browser, on the Salesforce session you already have open, and talks to your org and to nothing else.');
    if (await c.has('#sftkTermsCb')) {
      await rec.say('On the first start, before anything else, it asks you to accept its terms. The extension is open source under the Apache License 2.0, and the terms say plainly that the tool can change and delete data in your orgs, and that the consequences are yours.');
      await rec.reveal('#sftkTermsTitle');
      await rec.say('The full agreement and the privacy notes are one click away, and you can read them again any time from the Licence button in the top bar. We will not go through them here.');
      await rec.point('#sftkTermsCb', 600);
      await h.eval(`(() => { const cb = document.querySelector('#sftkTermsCb'); if (cb && !cb.checked) cb.click(); return true; })()`);
      await h.sleep(500);
      await rec.click('#sftkTermsYes', 1200);
    }
    await h.eval(`(() => { if (!window.__sftkTourKiller) window.__sftkTourKiller = setInterval(() => { const b = [...document.querySelectorAll('button, a')].find(b => /skip tour/i.test(b.textContent || '')); if (b) b.click(); }, 400); return true; })()`);
    await rec.fast(() => h.waitFor("!document.querySelector('#sftkTermsCb') && document.querySelectorAll('.home-card').length > 0 && !document.querySelector('.home-loading')", 60000, 500));
    await h.sleep(800);
    await rec.say('Accepted once, remembered. It has two parts: the Toolkit works on one org — flows, pages, fields, permissions — and Data Studio moves records between orgs.');
    await rec.point('.home-card[data-fid="flows"]', 900);
    await rec.point('.home-card[data-fid="fields"]', 900);
    // several orgs open: the Toolkit works on one at a time, says which, and switches
    const pickOrg = async part => {
      await rec.click('#homeOrgSelector', 900);
      await rec.fast(() => h.waitFor("document.querySelectorAll('#homeOrgDropdown .home-org-dd-item').length > 1", 20000, 400));
      await rec.pause(1200);
      const ok = await h.eval(`(() => { document.querySelectorAll('[data-demo-org]').forEach(x => x.removeAttribute('data-demo-org')); const it = [...document.querySelectorAll('#homeOrgDropdown .home-org-dd-item')].find(x => x.innerText.includes(${J(part)})); if (!it) return false; it.setAttribute('data-demo-org', '1'); return true; })()`);
      if (!ok) throw new Error(`${part} is not in the org list`);
      await rec.click('#homeOrgDropdown .home-org-dd-item[data-demo-org="1"]', 600);
      await h.waitFor(`(document.querySelector('#homeOrgSelector')?.innerText || '').includes(${J(part)})`, 30000, 400);
      await rec.pause(1000);
    };
    await rec.say('With several orgs open, the Toolkit works on one at a time. The card at the top says which one, and switches.');
    await pickOrg(TGT_ORG);
    await rec.say('Every tool now reads and writes that org, until you switch again. The same switch sits in the top bar of every tool.');
    await pickOrg(SRC_ORG);
    if (!(await c.text('#homeOrgSelector', 200)).includes(SRC_ORG)) throw new Error('could not switch back to the source org');
    // the rest of the top bar, one control at a time
    await rec.click('#dsWhatsNewTop', 1200);
    await rec.say('What’s New: the release notes, per version, inside the app.');
    await rec.reveal('#whatsNewContainer');
    if (await c.has('#homeBtn')) await rec.click('#homeBtn', 900);
    await rec.click('#sftkDarkToggle', 900);
    await rec.say('Dark mode.');
    await rec.click('#sftkDarkToggle', 900);
    await rec.say('A second press gives OLED black: pure black surfaces for OLED screens. One setting for both parts of the extension.');
    await rec.click('#sftkDarkToggle', 800);
    await rec.say('And back to light.');
    await rec.click('#sftkTermsBtn', 1000);
    await rec.say('The Licence button brings the agreement and the privacy notes back, any time.');
    await rec.reveal('#sftkTermsViewTitle');
    if (await c.has('#sftkTermsViewClose')) await rec.click('#sftkTermsViewClose', 600);
    await rec.point('#dataStudioBtn', 900);
    await rec.say('Data Studio opens in a tab of its own; its chapters come later, with its quick navigation and shortcuts.');
    await rec.say('Every tool reads first and shows what it found. A change is made only after one confirmation that says exactly what will happen, and every change is checked by reading the org again. That rule holds for every tool you will see; it is not repeated from here on.');
  } },

  { id: 'flows', title: 'Flows', run: async c => {
    const { h, rec } = c;
    await c.popup('flows');
    await rec.say('Flows. Every flow in the org, with all of its versions.');
    await rec.fast(() => h.waitFor("document.querySelectorAll('.flow-group').length > 0 && getComputedStyle(document.querySelector('#flowList')).display !== 'none'", 240000, 1000));
    await rec.pause(2500);
    await rec.type('#searchInput', 'SFTK');
    await rec.say('Search by name, then open a flow to see each version and which one is active.', 1500);
    await rec.click('.flow-group .flow-group-header', 1800);
    await rec.pause(2000);
    await rec.point('#modeToggle', 1200);
    await rec.say('Old versions can be backed up to a zip file, deleted in bulk, and restored from that backup later.', 5000);
  } },

  { id: 'dependencies', title: 'Dependencies', run: async c => {
    const { h, rec } = c;
    await c.popup('dependencies');
    await rec.say('Dependencies. The flows of the org as a tree: which flow calls which.');
    await depScanGate(c, true);
    await rec.fast(() => h.waitFor("!!document.querySelector('#depApiVerBtn') && document.querySelectorAll('.dep-node').length > 0", 300000, 1000));
    await rec.pause(3000);
    if (await c.has('.dep-filter-btn[data-type="RecordTriggeredFlow"]')) { await rec.click('.dep-filter-btn[data-type="RecordTriggeredFlow"]', 1500); await rec.say('Filter by kind, for example only record-triggered flows.', 3000); await rec.click('.dep-filter-btn[data-type="all"]', 1000); }
    if (await c.has('#depRefSearch')) {
      // User 2026-10-10 on the first cut: "i dont really see the example on the screen of what
      // uses this … didn't show how a full scan goes". So: the search ON camera, its partial
      // answer, the "Read them all" click, the wait, and the search again over everything.
      const results = () => h.eval(`(() => ({ partial: !!document.querySelector('#depRefRescan'), hits: document.querySelectorAll('.dep-ref-hit').length }))()`);
      const searchOnCamera = async () => {
        await rec.scrollTo('#depRefSearch', 'center');
        await rec.type('#depRefSearch', OLD_FIELD, 22);
        await rec.click('#depRefGo', 600);
        await rec.fast(() => h.waitFor("!!(document.querySelector('#depRefResults')?.innerText || '').trim()", 60000, 500).catch(() => {}));
        await h.sleep(600);
        await rec.scrollTo('#depRefResults', 'center');
        return results();
      };
      let st = await searchOnCamera();
      await rec.say(st.partial
        ? `“What uses this?” — a field name, and the flows that mention it. ${st.hits ? `${st.hits} so far, and` : 'None yet, and'} the answer says how much was actually read: not every flow version, so this is not a final answer.`
        : `“What uses this?” — a field name, and the flows that mention it. ${st.hits} flow version${st.hits === 1 ? '' : 's'}, from the versions read when this page opened — the answer always says how much was read.`);
      await rec.reveal('#depRefResults');
      // the full scan, on camera: every flow version's text read again
      await rec.scrollTo('#depRescanBtn', 'center');
      await rec.click('#depRescanBtn', 800);
      await rec.say('Rescan drops the stored data and reads the text of every flow version again. The status line counts them.');
      await rec.fast(async () => {
        await h.sleep(3000);
        await h.waitFor("(() => { const b = document.querySelector('#depRescanBtn'); return !!b && !b.disabled && !/rescanning/.test(b.textContent) && document.querySelectorAll('.dep-node').length > 0 && !!document.querySelector('#depRefSearch'); })()", 600000, 1000);
        await h.sleep(1500);
      });
      await rec.say('Read. The same search again, over everything just read.');
      st = await searchOnCamera();
      await rec.say(st.partial
        ? `${st.hits} flow version${st.hits === 1 ? '' : 's'} mention this field among those read; the rest are named as not searched.`
        : `Every flow version was read: ${st.hits} flow version${st.hits === 1 ? '' : 's'} mention this field, each with how many times. A click opens the flow.`);
      await rec.reveal('#depRefResults');
    }
    await rec.scrollTo('#depBulkBtn', 'center');
    await rec.point('#depBulkBtn', 900);
    await rec.point('#depApiVerBtn', 900);
    await rec.say('Two more tools live here: Flow switches and API versions. Both are next.', 3500);
  } },

  { id: 'flow-switches', title: 'Flow switches', writes: true, run: async c => {
    const { h, rec } = c;
    const PICKS = ['SFTK_FS_Test_Acc1', 'SFTK_FS_Test_Acc2', 'SFTK_FS_Test_Con1'];
    const rowsReady = "document.querySelectorAll('.dep-fb-cb').length > 0 || /could not|no flows|nothing/i.test(document.querySelector('#depFbBody, #depToolPanel')?.innerText || '')";
    const states = () => h.eval(`${J(PICKS)}.map(v => { const x = document.querySelector('.dep-fb-cb[value="' + v + '"]'); return x ? x.dataset.on : 'missing'; })`);
    await c.popup('dependencies');
    await depScanGate(c);
    await rec.fast(() => h.waitFor("!!document.querySelector('#depBulkBtn')", 300000, 1000));
    await rec.say('Flow switches. Before a data load you often want some automation out of the way, and back on afterwards.', 1200);
    await rec.click('#depBulkBtn', 800);
    await rec.fast(async () => { await h.waitFor(rowsReady, 300000, 1500); await h.sleep(1200); });
    const before = await states();
    if (before.some(s => s !== 'on')) throw new Error(`the three fixture flows must be ON before this chapter (they are: ${before.join(', ')})`);
    await rec.scrollTo(`.dep-fb-cb[value="${PICKS[0]}"]`, 'center');
    await rec.say('Every record-triggered flow of the org, grouped by object, and whether it is on. Tick the ones to switch.', 1200);
    for (const v of PICKS) { await rec.point(`.dep-fb-cb[value="${v}"]`, 550); await tick(c, `.dep-fb-cb[value="${v}"]`); }
    await rec.point('#depFbCount', 1000);
    await rec.click('#depFbOff', 600);
    await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 120000, 500);
    await rec.say('The confirmation names every flow and says what switching it off means. Then it asks you to acknowledge and confirm.', 5000);
    await typedConfirm(c, 'OFF');
    await rec.fast(() => h.waitFor("/switched (OFF|ON)|❌|stale/.test(document.querySelector('#depFbOut')?.innerText || '')", 600000, 1000));
    await rec.scrollTo('#depFbOut', 'center');
    await rec.say('Each flow is switched off and then read back from the org. The active versions are remembered, so switching on restores exactly those.', 6500);
    await undoInTool(c, 'The change is now in this tool’s History. Undo writes the earlier state back: here, the three flows on again.');
    // read the list again: the three flows must be ON
    await h.eval(`(() => { window.__sftkOldCb = document.querySelector('.dep-fb-cb'); document.querySelector('#depFbReload')?.click(); return true; })()`);
    await rec.fast(async () => { await h.waitFor("document.querySelectorAll('.dep-fb-cb').length > 0 && document.querySelector('.dep-fb-cb') !== window.__sftkOldCb", 300000, 1000); await h.sleep(1200); });
    const after = await states();
    if (after.some(s => s !== 'on')) throw new Error(`after the undo the fixture flows are: ${after.join(', ')}`);
    await rec.scrollTo(`.dep-fb-cb[value="${PICKS[0]}"]`, 'center');
    await rec.say('All three are on again.', 3500);
  } },

  { id: 'api-versions', title: 'API versions', writes: true, run: async c => {
    const { h, rec } = c;
    const row = '.dep-av-pick[value="SFTK_AV_Test_A"]';
    await c.popup('dependencies');
    await depScanGate(c);
    await rec.fast(() => h.waitFor("!!document.querySelector('#depApiVerBtn')", 300000, 1000));
    await rec.say('API versions. A flow keeps the API version it was saved with, so an upgraded org can still be running old flow behaviour.', 1200);
    await rec.click('#depApiVerBtn', 800);
    await rec.fast(async () => { await h.waitFor("document.querySelectorAll('.dep-av-pick').length > 0 || /could not|no flows|nothing/i.test(document.querySelector('#depAvOut')?.innerText || '')", 300000, 1500); await h.sleep(1500); });
    const label = await h.eval(`(document.querySelector(${J(row)})?.closest('label')?.innerText || '')`);
    if (!/behind/.test(label)) throw new Error(`the fixture flow SFTK_AV_Test_A must be behind the org's release before this chapter (it reads: ${label.slice(0, 80)})`);
    await rec.scrollTo(row, 'center');
    await rec.say('Each flow with the version it is pinned to, and how far that is behind the release this org runs.', 5000);
    await rec.point(row, 700); await tick(c, row);
    const target = await h.eval(`(() => { const s = document.querySelector('#depAvTarget'); if (!s || !s.options.length) return ''; s.value = s.options[0].value; s.dispatchEvent(new Event('change', { bubbles: true })); return s.options[0].textContent.trim(); })()`);
    await rec.point('#depAvTarget', 1100);
    await rec.say(`Pick the flows and the version to move them to. Here: one flow, to ${target ? `API ${target}` : 'the org’s release'}.`, 4500);
    await rec.click('#depAvApply', 600);
    await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 120000, 500);
    await rec.say('Changing the version deploys a new version of the flow. Where the flow is active, the tool activates the new one.', 6500);
    await typedConfirm(c, 'CHANGE');
    await rec.fast(() => h.waitFor("/refused the package|changed across/.test(document.querySelector('#depAvLog')?.innerText || '')", 600000, 1500));
    await rec.scrollTo('#depAvLog', 'center');
    await rec.say('Done: the new version is the active one.', 4500);
    await undoInTool(c, 'This too is in the tool’s History. Undo makes the previous version the active one again.');
  } },

  { id: 'debugger', title: 'Debugger', writes: true,
    cleanup: async ({ h }) => { clearTraceFlags('npc', (...a) => h.log(...a)); },
    run: async c => {
      const { h, rec } = c;
      const me = cliJson('npc', ['org', 'display', 'user']).result;
      await c.popup('debugger');
      await h.waitFor("!!document.querySelector('#adbgUserInput')", 60000, 500);
      await rec.say('The Debugger: a trace on one user, that user’s Apex logs as they arrive, and an analysis of each log — what ran, how often, and what it cost.');
      await h.eval(`(() => { const i = document.querySelector('#adbgUserInput'); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
      await rec.fast(() => h.waitFor("document.querySelectorAll('#adbgUserDrop .adbg-uopt').length > 0", 60000, 500));
      const mine = `#adbgUserDrop .adbg-uopt[data-id="${me.id}"]`;
      await h.waitFor(`!!document.querySelector(${J(mine)})`, 60000, 500);
      await rec.click(mine, 600);
      await rec.remask();   // the picked name leaves the field's focus: the mask covers it
      await h.sleep(400);
      await rec.say('Pick the user and a debug level, then Start. The trace runs for an hour, or until you stop it.');
      await rec.point('#adbgProfile', 900);
      await rec.click('#adbgStartBtn', 800);
      await rec.fast(() => h.waitFor("document.querySelector('#adbgStopBtn').style.display !== 'none' || /Error/.test(document.querySelector('#adbgStatusCell')?.innerText || '')", 90000, 500));
      if (await h.eval("document.querySelector('#adbgStopBtn').style.display === 'none'")) throw new Error(`the trace did not start: ${await c.text('#adbgStatusCell', 200)}`);
      await rec.say('Tracing. Now something happens in the org: a record is saved, and a trigger on it updates the record again — which fires the trigger again.');
      await rec.fast(async () => {
        const acc = cliJson('npc', ['data', 'query', '-q', `"SELECT Id FROM Account WHERE Name = 'SFTK PK Account 1' LIMIT 1"`]).result.records[0];
        cliJson('npc', ['data', 'update', 'record', '-s', 'Account', '-i', acc.Id, '-v', '"SFTK_Dbg_Count__c=0"']);
        await h.sleep(4000);
      });
      await rec.click('#adbgRefreshBtn', 800);
      await rec.fast(() => h.waitFor("document.querySelectorAll('#adbgLogList .adbg-badge-new').length > 0", 60000, 1000));
      await h.sleep(800);
      if (await c.has('#adbgLogList .adbg-badge-loop')) await rec.point('#adbgLogList .adbg-badge-loop', 1200);
      await rec.say('The new log carries a LOOP badge before it is even opened: the same automation ran more than once inside one transaction.');
      // the biggest NEW log (one save can leave a flow's small log beside the Apex one)
      const picked = await h.eval(`(() => {
        const rows = [...document.querySelectorAll('#adbgLogList .adbg-log-row')].map(r => { const t = r.innerText.replace(/\\s+/g, ' '); const m = /([0-9.]+) ?(KB|MB|B)\\b/.exec(t) || [0, '0', 'B']; return { r, isNew: !!r.querySelector('.adbg-badge-new'), kb: parseFloat(m[1]) * (m[2] === 'MB' ? 1024 : m[2] === 'KB' ? 1 : 1 / 1024) }; });
        const fresh = rows.filter(x => x.isNew); const best = (fresh.length ? fresh : rows).sort((a, b) => b.kb - a.kb)[0];
        if (!best) return false; best.r.setAttribute('data-demo-pick', '1'); return true; })()`);
      if (!picked) throw new Error('no log row to open');
      await rec.click('[data-demo-pick="1"] .adbg-row-op', 800);
      // a big log can take a while to arrive, and the list may redraw under the click (v6 take
      // 2026-10-10 timed out at 60 s): wait longer, and click the row once more if nothing opened
      const opened = () => h.eval("!!document.querySelector('#adbgLogView') && !document.querySelector('#adbgDetail .adbg-detail-loading')");
      await rec.fast(async () => {
        await h.waitFor("!!document.querySelector('#adbgLogView') && !document.querySelector('#adbgDetail .adbg-detail-loading')", 120000, 500).catch(() => {});
        if (!(await opened())) {
          await h.eval(`(() => { const r = document.querySelector('[data-demo-pick="1"] .adbg-row-op') || document.querySelector('#adbgLogList .adbg-log-row .adbg-row-op'); if (r) r.click(); return !!r; })()`);
          await h.waitFor("!!document.querySelector('#adbgLogView') && !document.querySelector('#adbgDetail .adbg-detail-loading')", 120000, 500);
        }
      });
      await h.sleep(800);
      if (await c.has('.adbg-loop-banner')) await rec.scrollTo('.adbg-loop-banner', 'center');
      await rec.say('Opened: the recursion is named at the top. The trigger fired five times on one save, and the analysis shows the chain.');
      if (await c.has('.adbg-analysis-sum')) {
        await rec.click('.adbg-analysis-sum', 900);
        await rec.say('The analysis: every query and DML statement, the governor limits and how close they came, the slowest units, and each piece of automation with how many times it ran.');
        await rec.reveal('.adbg-analysis-body');
        await rec.click('.adbg-analysis-sum', 600);   // folded again: the log gets the screen
      }
      await rec.scrollTo('#adbgLogFilter', 'center');
      await rec.type('#adbgLogFilter', 'counting up', 70);
      await rec.say('A search keeps only the matching lines: here the trigger’s own debug line, once per pass.');
      await h.eval(`(() => { const i = document.querySelector('#adbgLogFilter'); if (i) { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`);
      // the view redraws after a pause: the count waits for the whole log to be back (a take counted the 7 search hits as "all")
      await h.waitFor("document.querySelectorAll('#adbgLogView .adbg-log-line').length > 50", 15000, 200).catch(() => {});
      await h.sleep(600);
      // one rendered line = one .adbg-log-line (innerText split in two per line and doubled every count — v7 take)
      const shownLines = () => h.eval(`[...document.querySelectorAll('#adbgLogView .adbg-log-line')].filter(e => getComputedStyle(e).display !== 'none').length`);
      const all = await shownLines();
      await rec.click('.adbg-log-cat[data-cat="soqldml"]', 900);
      await rec.say(`One-click filters. Only the queries and the DML: ${await shownLines()} lines of ${all}.`);
      await rec.click('.adbg-log-cat[data-cat="nonoise"]', 900);
      const quiet = await shownLines();
      await rec.say(`Hide noise drops the lines nobody reads — heap, statement and limit chatter. ${all} lines become ${quiet}; what is left is what happened.`);
      await rec.reveal('#adbgLogView');
      await rec.click('.adbg-log-cat[data-cat=""]', 600);
      if (await c.has('.adbg-det-actions')) {
        await rec.scrollTo('.adbg-det-actions', 'center');
        await rec.click('#adbgCopyReportBtn', 900);
        const copied = /Copied/.test(await h.eval(`document.querySelector('#adbgCopyReportBtn')?.textContent || ''`));
        await rec.say(copied
          ? 'Copy Report puts the analysis on the clipboard as text — the button says Copied — ready to paste into a ticket or a chat.'
          : 'Copy Report puts the analysis on the clipboard as text, ready to paste into a ticket or a chat.');
        await rec.point('#adbgDlReportBtn', 700); await rec.point('#adbgDlBtn', 700);
        await rec.say('Report dot m d downloads the same analysis as a Markdown file; Raw dot log downloads the log exactly as Salesforce returned it.');
      }
      // an error: anonymous Apex that throws, as the traced user — the log shows the exception
      await rec.say('Now an error. A piece of Apex that divides by zero runs in the org.');
      await rec.fast(async () => {
        const apexFile = `${process.env.TEMP || '.'}/sftk-video-${Date.now()}.apex`;
        writeFileSync(apexFile, "System.debug('SFTK video: about to divide by zero'); Integer zero = 0; Integer boom = 10 / zero; System.debug(boom);");
        try { cliJson('npc', ['apex', 'run', '-f', apexFile]); } catch (_) { /* the run fails on purpose; the log is what matters */ }
        await h.sleep(4000);
      });
      const rowsBefore = await h.eval("document.querySelectorAll('#adbgLogList .adbg-log-row').length");
      await rec.click('#adbgRefreshBtn', 800);
      await rec.fast(() => h.waitFor(`document.querySelectorAll('#adbgLogList .adbg-log-row').length > ${rowsBefore}`, 60000, 1000).catch(() => {}));
      await h.sleep(800);
      // the row with Salesforce's own verdict ("Divide by 0") — waited for (it arrives after the refresh), found by id
      const errId = await rec.fast(async () => {
        for (let i = 0; i < 12; i++) {
          const id = await h.eval(`(() => { const r = [...document.querySelectorAll('#adbgLogList .adbg-log-row')].find(r => r.querySelector('.adbg-row-fail') || /Divide by 0|Exception|FATAL/i.test(r.innerText)); return r ? r.dataset.id : ''; })()`);
          if (id) return id;
          await h.eval(`document.querySelector('#adbgRefreshBtn')?.click()`); await h.sleep(5000);
        }
        return '';
      });
      if (errId) {
        const rowSel = `#adbgLogList .adbg-log-row[data-id="${errId}"]`;
        await rec.point(rowSel, 600);
        // opened, and checked: the view must show the divide-by-zero log, not the one before
        await rec.fast(async () => {
          for (let i = 0; i < 3; i++) {
            await h.eval(`(() => { const r = document.querySelector(${J(rowSel)}); const op = r && (r.querySelector('.adbg-row-op') || r); if (op) op.click(); return !!op; })()`);
            const ok = await h.waitFor("!!document.querySelector('#adbgLogView') && !document.querySelector('#adbgDetail .adbg-detail-loading') && /Divide by 0|MathException|FATAL_ERROR/.test(document.querySelector('#adbgDetail')?.innerText || '')", 40000, 500).then(() => true).catch(() => false);
            if (ok) break;
          }
        });
        await h.sleep(800);
        await rec.say('The new log. The header counts the exception, and the Errors filter keeps only the lines that matter: the exception, and where it was thrown.');
        await rec.scrollTo('#adbgLogFilter', 'center');
        await rec.click('.adbg-log-cat[data-cat="errors"]', 900);
        await rec.reveal('#adbgLogView');
        await rec.say(`${await shownLines()} lines: the exception itself. Nothing else to read through.`);
        await rec.click('.adbg-log-cat[data-cat=""]', 600);
      }
      // the search across every log in the list
      await rec.scrollTo('#adbgXSearch', 'center');
      await rec.type('#adbgXSearch', 'counting up', 70);
      await rec.click('#adbgXSearchBtn', 800);
      await rec.say('Search across all logs reads every log in the list and marks the ones that contain the words, with how many lines match.');
      await rec.fast(() => h.waitFor("!/Searching/.test(document.querySelector('#adbgLogCount')?.innerText || '')", 300000, 1000).catch(() => {}));
      await h.sleep(800);
      if (await c.has('.adbg-badge-xhit')) await rec.point('.adbg-badge-xhit', 1000);
      await rec.say(`${await h.eval("document.querySelectorAll('#adbgLogList .adbg-row-xhit').length")} logs mention the trigger’s debug line — the loop logs, and none of the others.`);
      await rec.click('#adbgXSearchClear', 600);
      // the log in a tab of its own: one picture of that tab goes into the recording
      await rec.click('#adbgNewTabBtn', 2500);
      const viewer = (await h.cdp('Target.getTargets', {}, null)).targetInfos.find(t => t.type === 'page' && /apex-log-viewer\.html/.test(t.url));
      if (viewer) {
        const { sessionId } = await h.cdp('Target.attachToTarget', { targetId: viewer.targetId, flatten: true }, null);
        await rec.fast(async () => { for (let i = 0; i < 30; i++) { const r = await h.cdp('Runtime.evaluate', { expression: 'document.body ? document.body.innerText.length : 0', returnByValue: true }, sessionId); if (r.result.value > 200) break; await h.sleep(500); } });
        const title = (await h.cdp('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId)).result.value;
        rec.state.pages.push({ t: (rec.state.frames.at(-1) || { t: 0 }).t + 1, url: viewer.url, title });
        await rec.frameFrom(sessionId, 300);
        await rec.say('The same log in a tab of its own, with every control, for a long read.');
        await h.cdp('Target.closeTarget', { targetId: viewer.targetId }, null);
        await rec.resume(); await h.sleep(800);
      }
      // two logs side by side
      if ((await h.eval("document.querySelectorAll('#adbgLogList .adbg-cb').length")) >= 2) {
        for (const i of [0, 1]) { await rec.point(`#adbgLogList .adbg-log-row:nth-of-type(${i + 1}) .adbg-row-ck`, 500); await h.eval(`(() => { const cb = document.querySelectorAll('#adbgLogList .adbg-cb')[${i}]; if (cb && !cb.checked) cb.click(); return true; })()`); await h.sleep(400); }
        if (await h.eval("document.querySelector('#adbgCompareBtn')?.style.display !== 'none'")) {
          await rec.click('#adbgCompareBtn', 800);
          await rec.fast(() => h.waitFor("!document.querySelector('#adbgDetail .adbg-detail-loading')", 60000, 500));
          await rec.say('Tick two logs and Compare sets them side by side: duration, queries, rows, DML, exceptions, the peak limit — and which run did better.');
          await rec.reveal('#adbgDetail');
        }
        await h.eval(`(() => { document.querySelectorAll('#adbgLogList .adbg-cb').forEach(cb => { if (cb.checked) cb.click(); }); return true; })()`); await h.sleep(400);
      }
      // purge: the confirmation is shown, and cancelled
      await rec.click('#adbgPurgeOldBtn', 1500);
      if (await c.has('#sftkConfirmGo')) {
        await rec.say('Purge removes the logs older than a day — after this confirmation. Cancelled here.');
        await rec.reveal('.sftk-cf-host');
        await rec.click('#sftkConfirmCancel', 800);
      } else await rec.say('Purge removes the logs older than a day. This org has none that old.');
      await rec.click('#adbgStopBtn', 800);
      await rec.fast(() => h.waitFor("document.querySelector('#adbgStartBtn').style.display !== 'none'", 60000, 500));
      await rec.say('Stop ends the trace, and the tool reads the org back to be sure it is really gone.');
    } },
  { id: 'pages', title: 'Lightning Pages', writes: true, run: async c => {
    const { h, rec } = c;
    const PAGE = /SFTK LP Test Account Page/i;
    const acc = cliJson('npc', ['data', 'query', '-q', `"SELECT Id FROM Account WHERE Name = 'SFTK PK Account 1' LIMIT 1"`]).result.records[0];
    // one picture of an Account record page in Salesforce, in a tab of its own
    const recordFrame = async (caption) => {
      // A brand-new browser session each time (a new browser context, logged in through a fresh
      // frontdoor URL from the CLI): Lightning keeps page assignments in its session caches, and a
      // tab in the old session drew the old page even after the change (dry runs 2026-10-10).
      // The frontdoor URL carries a session id: it is never logged.
      const path = `/lightning/r/Account/${acc.Id}/view`;
      const fd = cliJson('npc', ['org', 'open', '--url-only']).result.url;
      const { browserContextId } = await h.cdp('Target.createBrowserContext', {}, null);
      const { targetId } = await h.cdp('Target.createTarget', { url: `${fd}${fd.includes('?') ? '&' : '?'}retURL=${encodeURIComponent(path)}`, browserContextId }, null);
      const { sessionId } = await h.cdp('Target.attachToTarget', { targetId, flatten: true }, null);
      await rec.fast(async () => {
        await h.cdp('Page.enable', {}, sessionId).catch(() => {});
        for (let i = 0; i < 90; i++) {
          const r = await h.cdp('Runtime.evaluate', { expression: "(/\/lightning\/r\/Account\//.test(location.href) && document.body) ? document.body.innerText.length : 0", returnByValue: true }, sessionId).catch(() => ({ result: { value: 0 } }));
          if (r.result.value > 1500) break; await h.sleep(1000);
        }
        await h.sleep(5000);   // the record page draws its components after the shell
        // the "Slack in Salesforce" promo popover, if it is up, is closed first
        await h.cdp('Runtime.evaluate', { expression: `(() => { const pop = [...document.querySelectorAll('section, div')].find(e => e.children.length < 12 && /Slack in Salesforce/.test(e.innerText || '') && e.querySelector('button')); const b = (pop && (pop.querySelector('.slds-popover__close, button[title*="lose" i], button[aria-label*="lose" i], button[aria-label*="ismiss" i]') || pop.querySelector('button'))) || document.querySelector('.slds-popover__close'); if (b) b.click(); return !!b; })()`, returnByValue: true }, sessionId).catch(() => {});
        await h.sleep(600);
      });
      rec.state.pages.push({ t: (rec.state.frames.at(-1) || { t: 0 }).t + 1, url: `https://${SRC_ORG}.lightning.force.com${path}`, title: 'SFTK PK Account 1 | Salesforce' });
      await rec.frameFrom(sessionId, 300);
      await rec.say(caption);
      await h.cdp('Target.closeTarget', { targetId }, null).catch(() => {});
      await h.cdp('Target.disposeBrowserContext', { browserContextId }, null).catch(() => {});
      await rec.resume(); await h.sleep(600);
    };
    const openFixturePage = async () => {
      await rec.fast(() => h.waitFor("document.querySelectorAll('.lp-row').length > 0", 240000, 1000));
      await h.eval(`(() => { const i = document.querySelector('#lpSearch'); if (i && i.value !== 'SFTK') { i.value = 'SFTK'; i.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`);
      await h.sleep(900);
      const findRow = `([...document.querySelectorAll('.lp-row')].find(x => ${PAGE}.test(x.querySelector('.lp-row-name')?.textContent || '')))`;
      let open = false;
      for (let i = 0; i < 5 && !open; i++) {
        if (!(await h.eval(`(() => { const r = ${findRow}; if (!r) return false; document.querySelectorAll('[data-demo-row]').forEach(x => x.removeAttribute('data-demo-row')); r.setAttribute('data-demo-row', '1'); return true; })()`))) { await h.sleep(1500); continue; }
        await rec.point('.lp-row[data-demo-row="1"]', 700);
        await h.eval(`(() => { const r = ${findRow}; if (r) r.click(); return !!r; })()`);
        open = await h.waitFor("!!document.querySelector('#lpDetailBody') && !!document.querySelector('#lpDetailBody').offsetParent", 6000, 300).then(() => true).catch(() => false);
      }
      if (!open) throw new Error('the fixture page detail did not open');
      await rec.fast(() => h.waitFor("!!document.querySelector('#lpDetailBody .lp-status-bar')", 180000, 1000));
      await h.sleep(600);
    };

    await c.popup('pages');
    await rec.say('Lightning Pages. Every record page of the org, and where each one is assigned.');
    await rec.fast(() => h.waitFor("document.querySelectorAll('.lp-row').length > 0", 240000, 1000));
    await rec.pause(1500);
    await rec.type('#lpSearch', 'SFTK');
    await openFixturePage();
    await rec.say('A page’s assignments, read from Salesforce each time: the org default, an app default, or an app with a record type and a profile. This test page has none yet, so nobody sees it.');
    await recordFrame('An Account in this org today, in the Learning Home app: the standard record page, with its tabs, related lists and activity.');
    // the assignment, for real: the app default of the app the users work in (an org default would be
    // beaten there by the app's own default page — the first dry run showed the same page twice)
    const APP = 'Learning Home', PROFILE = 'System Administrator';
    await rec.click('.lp-atab[data-tab="artp"]', 700);
    await rec.say(`The most specific assignment: an app, record types and a profile. The ${APP} app, every record type, and the ${PROFILE} profile — the person about to open the record. It beats the org default and the app default.`);
    const tick = async (listSel, cls, text) => {
      const ok = await h.eval(`(() => { const it = [...document.querySelectorAll(${J(listSel + ' .lp-app-item, ' + listSel + ' .lp-multi-item')})].find(x => ${J(text)} ? new RegExp(${J(text)}, 'i').test(x.innerText) : true); if (!it) return false; document.querySelectorAll('[data-demo-tick]').forEach(e => e.removeAttribute('data-demo-tick')); it.setAttribute('data-demo-tick', '1'); return true; })()`);
      if (!ok) throw new Error(`"${text}" is not offered in ${listSel}`);
      await rec.point('[data-demo-tick="1"]', 600);
      await h.eval(`(() => { const cb = document.querySelector('[data-demo-tick="1"] input[type=checkbox]'); if (cb && !cb.checked) cb.click(); return true; })()`);
      await h.sleep(500);
    };
    await tick('#lpARTPAppList', 'lp-artp-app-cb', APP);
    if (await c.has('#lpARTPRTAll')) { await rec.point('#lpARTPRTAll', 600); await h.eval(`(() => { const cb = document.querySelector('#lpARTPRTAll'); if (cb && !cb.checked) cb.click(); return true; })()`); await h.sleep(500); }
    await tick('#lpARTPProfileList', 'lp-artp-profile-cb', PROFILE);
    await rec.click('#lpAddBtnARTP', 800);
    await confirmShared(c, { caption: 'The confirmation lists every combination it will write: one per app, record type and profile.' });
    // the error box is always in the page, empty: wait for TEXT in either (dry run 2026-10-10)
    await rec.fast(() => h.waitFor("!!document.querySelector('#lpResultNote') || !!(document.querySelector('#lpAddErrARTP')?.innerText || '').trim()", 180000, 500));
    await h.sleep(800);
    if (await c.has('#lpResultNote')) {
      await rec.scrollTo('#lpResultNote', 'center');
      const note = (await c.text('#lpResultNote', 160)) || 'Assigned.';
      const refused = await h.eval(`(() => { const e = [...document.querySelectorAll('.lp-add-err, .error-banner')].find(x => x.offsetParent !== null && /could not be assigned/.test(x.innerText)); return e ? e.innerText.replace(/\\s+/g, ' ').slice(0, 300) : ''; })()`);
      await rec.say(refused ? `${note} One combination Salesforce refused — the Person Account record type cannot take a business page — and the tool says so in Salesforce’s own words.` : note);
    }
    else throw new Error(`the assignment failed: ${await c.text('#lpAddErrARTP', 300)}`);
    await recordFrame('The same Account now, in the same app: the test page — a highlights panel and the details, nothing else — because the Toolkit just assigned it.');
    await rec.point('#lpOpenSfBtn', 900);
    await rec.say('“Open in Salesforce” opens the page in the Lightning App Builder.');
    // who sees what
    await rec.click('#lpBackBtn', 900);
    await rec.fast(() => h.waitFor("!!document.querySelector('#lpProfileMapBtn')", 60000, 500));
    await rec.click('#lpProfileMapBtn', 800);
    await rec.say('“Who sees what?” reads every assignment of the org and answers per object and profile: which page each profile gets, and through which rule.');
    await rec.fast(() => h.waitFor("document.querySelectorAll('.lp-wsw-card').length > 0 && !document.querySelector('#lpWswLoad')", 600000, 1000));
    await h.sleep(800);
    // the Account card first (the list is long): then a short way down it
    await h.eval(`(() => { const c = [...document.querySelectorAll('.lp-wsw-card')].find(x => /^Account|Account Record Page/.test((x.querySelector('.lp-wsw-card-hdr') || x).innerText.trim())); if (c) c.setAttribute('data-demo-card', '1'); return !!c; })()`);
    if (await c.has('[data-demo-card="1"]')) await rec.scrollTo('[data-demo-card="1"]', 'start');
    await rec.say(`One card per object. The Account card now lists the test page for ${PROFILE} inside ${APP}, next to the org default and the other assignments.`);
    await rec.scrollBy(null, 420); await rec.scrollBy(null, 420);
    if (await c.has('details.lp-od-users')) {
      await rec.scrollTo('details.lp-od-users', 'center');
      await h.eval(`(() => { const d = document.querySelector('details.lp-od-users'); d.open = true; d.dispatchEvent(new Event('toggle')); return true; })()`);
      await rec.fast(() => h.waitFor("!/Loading users/.test(document.querySelector('details.lp-od-users')?.innerText || '')", 120000, 500));
      await rec.say('“Show users” lists the people behind a row.');
    }
    // what a user sees
    await rec.click('#lpBackBtn', 900);
    await rec.fast(() => h.waitFor("!!document.querySelector('#lpUserLensBtn')", 60000, 500));
    await rec.click('#lpUserLensBtn', 800);
    await rec.say('“What a user sees” goes the other way: pick one user, and get the page they land on for each object, and which assignment won.');
    await rec.fast(() => h.waitFor("document.querySelectorAll('#lpUlList .lp-row').length > 0", 120000, 500));
    await rec.type('#lpUlSearch', 'Test A', 60);
    await rec.click('#lpUlSearchBtn', 800);
    await rec.fast(() => h.waitFor("[...document.querySelectorAll('#lpUlList .lp-row')].some(r => /Test A/.test(r.innerText))", 120000, 500));
    await h.eval(`(() => { const r = [...document.querySelectorAll('#lpUlList .lp-row')].find(r => /Test A/.test(r.innerText)); if (r) r.setAttribute('data-demo-row', '1'); return !!r; })()`);
    await rec.click('#lpUlList .lp-row[data-demo-row="1"]', 800);
    await rec.fast(() => h.waitFor("!!document.querySelector('#lpUlBack')", 120000, 500));
    await h.sleep(800);
    await rec.say('Per object: the page, and the rule that chose it — and why the others lost.');
    await rec.reveal('#lpDetailBody');
    // removed again
    await rec.click('#lpUlBack', 700);
    await rec.fast(() => h.waitFor("!!document.querySelector('#lpBackBtn')", 60000, 500));
    await rec.click('#lpBackBtn', 900);
    await openFixturePage();
    const rm = '.lp-asgn-row[data-kind="artp"] .lp-rm-btn';
    if (!(await c.has(rm))) throw new Error('the assignment row has no remove button');
    await rec.scrollTo(rm, 'center');
    await rec.click(rm, 800);
    await confirmShared(c, { caption: 'Remove takes the assignments away again — every combination — confirmed, then checked against the org.' });
    await rec.fast(() => h.waitFor("!!document.querySelector('#lpResultNote')", 180000, 500));
    await h.sleep(800);
    // the remove took every combination with it? what is left is said, not assumed
    for (let i = 0; i < 6 && await c.has('.lp-asgn-row[data-kind="artp"] .lp-rm-btn'); i++) {
      await h.eval(`document.querySelector('.lp-asgn-row[data-kind="artp"] .lp-rm-btn').click()`);
      await confirmShared(c, {});
      await rec.fast(() => h.waitFor("!!document.querySelector('#lpResultNote')", 180000, 500)); await h.sleep(800);
    }
    await rec.say('Assign, remove, deactivate or clone a page from here. Every change is confirmed once and then read back from the org.');
  } },

  { id: 'fields', title: 'Field Cleaner', writes: true,
    cleanup: async ({ h }) => {
      rebuildFieldCleanerFixture('npc', (...a) => h.log(...a));
      // the values the chapter copied into the replacement field go again, so the next recording copies them again
      try {
        const q = cliJson('npc', ['data', 'query', '-q', `"SELECT Id FROM Account WHERE SFTK_FC_Test_Status2__c != null"`]).result.records || [];
        for (const r of q) cliJson('npc', ['data', 'update', 'record', '-s', 'Account', '-i', r.Id, '-v', '"SFTK_FC_Test_Status2__c="']);
        h.log(`copied values cleared from ${q.length} record(s)`);
      } catch (e) { h.log('clearing the copied values:', (e && e.message) || e); }
    },
    run: async c => {
      const { h, rec } = c;
      const settled = "!document.querySelector('#sftkConfirmGo') && !document.querySelector('.fc-fix-btn[disabled]') && !document.querySelector('.fc-fix-all[disabled]')";
      // off camera: eight fixture accounts get a value in the old field, so there is something to copy
      await rec.fast(async () => {
        const ids = (cliJson('npc', ['data', 'query', '-q', `"SELECT Id FROM Account WHERE Name LIKE 'SFTK PK Account%' ORDER BY Name LIMIT 8"`]).result.records || []).map(r => r.Id);
        ids.forEach((id, i) => { try { cliJson('npc', ['data', 'update', 'record', '-s', 'Account', '-i', id, '-v', `"${OLD_FIELD}=${i % 3 === 0 ? 'Closed' : i % 3 === 1 ? 'Reviewed' : 'New'}"`]); } catch (_) {} });
        h.log(`seeded ${ids.length} account(s) with a value in ${OLD_FIELD}`);
      });
      const flowBtn = (name, swap, way) => `.fc-fix-pair[data-type="Flow"][data-name="${name}"] .fc-fix-btn[data-swap="${swap}"]${way ? `[data-way="${way}"]` : ''}`;
      const cardText = async name => (await h.eval(`(() => { const p = document.querySelector('.fc-fix-pair[data-type="Flow"][data-name="${name}"]'); const card = p && p.closest('.fc-flow-card'); return card ? card.innerText.replace(/\\s+/g, ' ').trim() : ''; })()`)).slice(0, 220);
      const flowsLeft = () => h.eval(`document.querySelectorAll('.fc-fix-pair[data-type="Flow"]').length`);
      // one fix on one item: click, the confirmation shown whole and confirmed, the result waited for
      const fixOne = async (sel, caption) => {
        await rec.scrollTo(sel, 'center');
        await rec.click(sel, 600);
        await confirmShared(c, { caption, flowBackupOff: true });
        await rec.fast(() => h.waitFor(settled, 600000, 1000));
        await h.sleep(1200);
      };

      await c.popup('fields');
      await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
      await rec.say('Field Cleaner retires a field. It finds everything that uses the field; then, item by item, you either replace the field with another one or remove the references; and at the end you delete the field. Every step asks first.');
      await fcPick(c, '#fcObjInput', '#fcObjDrop', 'Account');
      await fcPick(c, '#fcFieldInput', '#fcFieldDrop', OLD_FIELD);
      await rec.fast(() => h.waitFor("!document.querySelector('#fcReplInput')?.disabled || !!document.querySelector('#fcReplNote .fc-repl-bad')", 60000, 500));
      await rec.say('The object, the field to retire, and the field that replaces it — same type.');
      if (await h.eval(`!!document.querySelector('#fcReplInput')?.disabled`)) throw new Error('the replacement picker is not available for the fixture field');
      await fcPick(c, '#fcReplInput', '#fcReplDrop', NEW_FIELD);
      await rec.click('#fcScanBtn', 800);
      await rec.fast(() => h.waitFor("/reference|Nothing references|No references|found|dependenc/i.test(document.querySelector('#fcResults')?.innerText || '') && !/scanning|⏳/i.test(document.querySelector('#fcScanBtn')?.innerText || '')", 600000, 1000));
      await h.sleep(2500);
      await rec.scrollTo('#fcResults');
      const nFlows = await flowsLeft();
      await rec.say(`The scan. Everything that mentions the field, in groups: ${nFlows} flows, the page layout, the Lightning page, who can see the field, and whether it still holds values. Nothing has changed yet.`);
      await rec.reveal(null);
      await rec.scrollTo('#fcResults');
      // the XML inspector on one flow: the flow's own definition with every reference marked
      const inspect = '.fc-inspect-btn[data-type="Flow"]';
      if (await c.has(inspect)) {
        await rec.scrollTo(inspect, 'center');
        await rec.click(inspect, 800);
        await rec.fast(() => h.waitFor("!!document.querySelector('.fc-xml-panel .fc-xml-hdr')", 60000, 500).catch(() => {}));
        if (await c.has('.fc-xml-panel .fc-xml-hdr')) {
          await rec.scrollTo('.fc-xml-panel .fc-xml-hdr', 'start');
          const badge = ((await c.text('.fc-xml-panel .fc-xml-hdr', 200)).replace(/\s+/g, ' ').match(/\d+ field refs?(?: · \d+ blocks? to remove)?/) || [''])[0];
          await rec.say(`The magnifier opens the flow’s XML as Salesforce stores it, with every place the field is used marked${badge ? ` — ${badge}` : ''}. That is what a Replace changes and what a Remove takes out.`);
          await rec.reveal('.fc-xml-panel');
          await rec.click(inspect, 600);
        }
      }
      // 1. access first: the people who can see the old field must see the new one
      if (await c.has('#fcFlsCopyBtn')) {
        await rec.scrollTo('#fcFlsCopyBtn', 'center');
        await rec.click('#fcFlsCopyBtn', 500);
        await confirmShared(c, { caption: 'First, access. Whoever can see the old field gets the same access to the new one. Access is only ever added.' });
        await rec.fast(() => h.waitFor("!document.querySelector('#fcFlsCopyBtn') && !document.querySelector('#sftkConfirmGo')", 120000, 500));
        await h.sleep(1200);
        await rec.say('Copied.');
      }
      // 2. the values in the records: Replace moves references; the data is its own step
      if (await c.has('#fcCopyCompare')) {
        await rec.scrollTo('#fcCopyCompare', 'center');
        await rec.say('Replace moves the places that mention the field. The values stored in the records are a separate step: Stored values compares the two fields, record by record.');
        await rec.click('#fcCopyCompare', 800);
        await rec.fast(() => h.waitFor("!!document.querySelector('#fcCopyGo') || /cannot be copied/.test(document.querySelector('.fc-copy')?.innerText || '')", 180000, 500));
        await h.sleep(600);
        if (await c.has('#fcCopyGo:not([disabled])')) {
          await rec.scrollTo('.fc-copy', 'center');
          const held = ((await h.eval(`(document.querySelector('.fc-copy')?.innerText || '')`)).match(/(\d+) records? holds? a value/) || [])[1];
          await rec.say(`${held ? `${held} records hold a value in the old field. ` : ''}The copy fills the new field where it is empty; a value already there is never overwritten unless you say so.`);
          await rec.reveal('.fc-copy');
          await rec.click('#fcCopyGo', 800);
          await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 120000, 400);
          await h.eval(`(() => { const cb = document.querySelector('#fcCopyCsv'); if (cb && cb.checked) cb.click(); return true; })()`);   // no file download in a recording
          await confirmShared(c, { caption: 'The confirmation counts the records and offers a receipt first: a CSV of every record with the value written and the value that was there.' });
          await rec.fast(() => h.waitFor("/copied|verified|failed|refused/i.test(document.querySelector('#fcCopyResult')?.innerText || '')", 300000, 500));
          await h.sleep(800);
          await rec.scrollTo('#fcCopyResult', 'center');
          await rec.say((await c.text('#fcCopyResult', 160)).replace(/\s+/g, ' ') || 'Copied.');
        } else {
          await rec.say((await c.text('.fc-copy', 160)).replace(/\s+/g, ' ') || 'Nothing to copy here.');
        }
      }
      // 3. REPLACE on ONE flow
      const one = 'SFTK FC Test Flow 2';
      if (await c.has(flowBtn(one, 1))) {
        await rec.scrollTo(flowBtn(one, 1), 'center');
        await rec.say('A flow is one card, with its versions. Three buttons: Replace the field; Remove it and keep the flow running; or Delete the versions and switch the flow off. First, Replace on this one flow.');
        await fixOne(flowBtn(one, 1), 'The confirmation is the plan: a new active version of the flow that uses the new field, then the old versions deleted. A backup zip is offered first — switched off for this recording.');
        await rec.scrollTo(`.fc-fix-pair[data-type="Flow"][data-name="${one}"]`, 'center');
        const okLine = (await h.eval(`(() => { const card = [...document.querySelectorAll('.fc-flow-card')].find(x => x.innerText.includes(${J(one)})); const ok = card && card.querySelector('.fc-item-ok'); return ok ? ok.innerText.replace(/\\s+/g, ' ').trim() : ''; })()`)).slice(0, 150);
        await rec.say(okLine ? `Done. The card says: ${okLine}` : 'Done. The card says which version runs now, and that the old versions are gone.');
      }
      h.log('flow group box after replace-one:', await h.eval(`(() => { const b = [...document.querySelectorAll('.fc-fix-allbox')].map(x => x.dataset.type + ':' + x.dataset.n + ' → ' + x.innerText.replace(/\\s+/g, ' ').slice(0, 100)); return b.join(' ‖ ') || '(none)'; })()`), '| pairs:', await h.eval(`[...document.querySelectorAll('.fc-fix-pair[data-type="Flow"]')].map(p => p.dataset.name).join(', ')`));
      // 3. REPLACE on MANY flows: the group button walks the flows one by one; Cancel stops it
      const allReplace = '.fc-fix-all[data-type="Flow"][data-swap="1"]';
      if (await c.has(allReplace) && (await flowsLeft()) >= 3) {
        await rec.scrollTo(allReplace, 'center');
        await rec.say(`Now many at once. "Replace in all ${await flowsLeft()} flows" walks the flows one by one. Each still shows its own confirmation, and Cancel in any of them stops the walk.`);
        await rec.click(allReplace, 600);
        for (let i = 0; i < 2; i++) {
          await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 120000, 400);
          const title = await c.text('.sftk-cf-title', 120);
          await confirmShared(c, { caption: i === 0 ? `${title}. The same plan as before, for this flow. Confirm.` : `${title}. Confirm again.`, flowBackupOff: true });
          await h.sleep(300);
          await h.sleep(400);
        }
        await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 120000, 400);
        await rec.say('The third one — Cancel. The walk stops here: two flows replaced, the rest untouched.');
        await rec.click('#sftkConfirmCancel', 800);
        await rec.fast(() => h.waitFor(settled, 600000, 1000));
        await h.sleep(1000);
      }
      h.log('flow group box after walk-cancel:', await h.eval(`(() => { const b = [...document.querySelectorAll('.fc-fix-allbox')].map(x => x.dataset.type + ':' + x.dataset.n + ' → ' + x.innerText.replace(/\\s+/g, ' ').slice(0, 100)); return b.join(' ‖ ') || '(none)'; })()`), '| pairs:', await h.eval(`[...document.querySelectorAll('.fc-fix-pair[data-type="Flow"]')].map(p => p.dataset.name).join(', ')`));
      // 4. REMOVE on ONE flow, the "flow off" way
      const offBtn = `.fc-fix-pair[data-type="Flow"] .fc-fix-btn[data-swap="0"][data-way="off"]`;
      if (await c.has(offBtn)) {
        const name = await h.eval(`document.querySelector(${J(offBtn)}).closest('.fc-fix-pair').dataset.name`);
        await rec.scrollTo(offBtn, 'center');
        await rec.say(`Remove, on one flow, the hard way: "Delete versions, flow off". For a flow nobody needs any more — the flow is switched off and every version that mentions the field is deleted.`);
        await fixOne(offBtn, 'The plan says exactly that, and offers the backup first.');
        await rec.scrollTo(`.fc-fix-pair[data-type="Flow"][data-name="${name}"]`, 'center').catch(() => {});
        await rec.say(`Done: ${name} is off, its versions gone.`);
      }
      // 5. REMOVE on MANY flows, the "keep running" way
      const allKeep = '.fc-fix-all[data-type="Flow"][data-swap="0"][data-way="keep"]';
      h.log('flow group box now:', await h.eval(`(() => { const b = [...document.querySelectorAll('.fc-fix-allbox')].map(x => x.dataset.type + ':' + x.dataset.n + ' → ' + x.innerText.replace(/\\s+/g, ' ').slice(0, 120)); return b.join(' ‖ ') || '(none)'; })()`), '| flows open:', await flowsLeft());
      if (await c.has(allKeep)) {
        const n = await flowsLeft();
        await rec.scrollTo(allKeep, 'center');
        await rec.say(`Remove on the remaining ${n} flows, the gentle way: "flows keep running". Each gets a new active version with the field taken out, and goes on working.`);
        await rec.click(allKeep, 600);
        for (let i = 0; i < n + 1; i++) {
          await rec.fast(() => h.waitFor(`!!document.querySelector('#sftkConfirmGo') || ${settled}`, 600000, 500));
          if (!(await c.has('#sftkConfirmGo'))) break;
          const title = await c.text('.sftk-cf-title', 120);
          await confirmShared(c, { caption: i === 0 ? `${title}: a new version without the field, the flow stays on.` : `${title}.`, flowBackupOff: true });
          await h.sleep(300);
          await h.sleep(400);
        }
        await rec.fast(() => h.waitFor(settled, 600000, 1000));
        await h.sleep(1200);
        const left = await flowsLeft();
        await rec.say(left
          ? `${n - left} done, each card saying which version runs now. ${left === 1 ? 'One was' : `${left} were`} refused before any dialog: there the field sits in a place the automatic remove never rewrites, and the card says so. Replace is the way for ${left === 1 ? 'that one' : 'those'}.`
          : 'All of them done, each card saying which version runs now.');
      }
      // 6. what is not a flow: the layout and the Lightning page, with "Everything at once"
      const every = '.fc-fix-every[data-swap="1"]';
      const walking = "[...document.querySelectorAll('#fcFixEvery button')].some(b => b.disabled)";
      if (await c.has(every)) {
        await rec.scrollTo('#fcFixEvery', 'center');
        const left = await flowsLeft();
        await rec.say(left ? `What is left: ${left} flow${left === 1 ? '' : 's'}, the page layout and the Lightning page. "Everything at once" walks them all the same way.` : 'What is left is not a flow: the page layout and the Lightning page. "Everything at once" walks them the same way.');
        await rec.click(every, 600);
        for (let i = 0; i < 12; i++) {
          await rec.fast(() => h.waitFor(`!!document.querySelector('#sftkConfirmGo') || !${walking}`, 600000, 500));
          if (!(await c.has('#sftkConfirmGo'))) break;
          const title = await c.text('.sftk-cf-title', 120);
          await confirmShared(c, { caption: /layout/i.test(title) ? 'The page layout: the new field takes the old field’s place. A restore point is saved first.' : /lightning|flexi|page/i.test(title) ? 'The Lightning page: its field component and its visibility rule move to the new field.' : `${title}.`, flowBackupOff: true });
          await h.sleep(300);
          await h.sleep(500);
        }
        await rec.fast(() => h.waitFor(`${settled} && !${walking}`, 600000, 1000));
        await h.sleep(1200);
      } else {
        for (const sel of ['.fc-fix-btn[data-type="Layout"][data-swap="1"]', '.fc-fix-btn[data-type="FlexiPage"][data-swap="1"]']) {
          if (await c.has(sel)) await fixOne(sel, /Layout/.test(sel) ? 'The page layout: the new field takes the old field’s place. A restore point is saved first.' : 'The Lightning page: its field component and its visibility rule move to the new field.');
        }
      }
      await rec.scrollTo('#fcResults');
      await rec.say('Every item done, and every card says what it is now.');
      await rec.reveal(null);
      // 7. the tool's own History
      if (await c.has('#fcToolHist summary')) {
        await rec.scrollTo('#fcToolHist', 'center');
        await rec.click('#fcToolHist summary', 900);
        await rec.say('Everything the tool changed is listed under the results, with what the org showed afterwards. A change with a way back has an Undo.');
      }
      // 8. the field itself
      await rec.scrollTo('#fcDeleteZone', 'center');
      await rec.say('Nothing uses the old field any more. Deprecate hides and renames it, with a one-click way back; Delete removes it.');
      const delOn = await h.eval(`(() => { const b = document.querySelector('#fcDelBtn'); return !!b && !b.disabled; })()`);
      if (delOn) {
        await rec.click('#fcDelBtn', 800);
        await confirmShared(c, { caption: 'The delete asks once more. The tool cannot undo it — Salesforce keeps a deleted field for fifteen days under Setup — and the confirmation says so.' });
        await rec.fast(() => h.waitFor("!!document.querySelector('.fc-success') || !!document.querySelector('.fc-error-msg')", 180000, 500));
        await h.sleep(1200);
        if (await c.has('.fc-success')) { await rec.scrollTo('.fc-success', 'center'); await rec.say('Deleted. The field is gone from the org.'); }
        else { await rec.scrollTo('.fc-error-msg', 'center'); await rec.say('Refused — and the tool says why, in Salesforce’s own words.'); }
      } else {
        await rec.say((await c.text('#fcDeleteNote', 200)) || 'The delete stays blocked until the blockers above are cleared.');
      }
    } },

  { id: 'copy-perms', title: 'Copy Permissions', writes: true,
    // the net: if the refused profile change somehow went through, Test B goes back on Identity User
    cleanup: async ({ h }) => {
      try {
        const b = cliJson('npc', ['data', 'query', '-q', `"SELECT Id, Profile.Name FROM User WHERE Name LIKE 'SFTK%Test B%' LIMIT 1"`]).result.records[0];
        if (b && b.Profile && b.Profile.Name !== 'Identity User') {
          const p = cliJson('npc', ['data', 'query', '-q', `"SELECT Id FROM Profile WHERE Name = 'Identity User' LIMIT 1"`]).result.records[0];
          cliJson('npc', ['data', 'update', 'record', '-s', 'User', '-i', b.Id, '-v', `"ProfileId=${p.Id}"`]);
          h.log('copy-perms cleanup: Test B put back on Identity User');
        } else h.log('copy-perms cleanup: Test B unchanged (Identity User)');
      } catch (e) { h.log('copy-perms cleanup:', (e && e.message) || e); }
    },
    run: async c => {
      const { h, rec } = c;
      await c.popup('copy-perms');
      await h.waitFor("!!document.querySelector('#ucSourceInput')", 60000, 500);
      await h.sleep(1200);
      await rec.say('Copy Permissions. Give one user what another user has: profile, role, permission sets, groups, user permissions, locale.');
      // the picker searches name, username, e-mail, alias AND profile — the administrator is found by profile, so no name is typed on camera
      const pick = async (P, typed, match) => {
        await rec.type(`#${P}Input`, typed, 40);
        await rec.fast(() => h.waitFor(`[...document.querySelectorAll('#${P}List .uc-drop-item')].some(e => !e.classList.contains('uc-drop-loading') && ${match}.test(e.innerText))`, 120000, 500));
        await h.eval(`(() => { const e = [...document.querySelectorAll('#${P}List .uc-drop-item')].find(e => ${match}.test(e.innerText)); if (e) e.click(); return !!e; })()`);
        await rec.remask();
        await h.sleep(900);
      };
      const previewReady = () => rec.fast(() => h.waitFor("!!document.querySelector('#ucProfileCb') || !!document.querySelector('.uc-ps-cb, .uc-grp-cb') || /nothing|no permission/i.test(document.querySelector('#ucPreview')?.innerText || '')", 120000, 500));
      // 1. a source whose licence the target does not have (user 2026-10-10: "how it copies a user
      //    without a matching license … and what occurs if we don't have this license")
      await pick('ucSource', 'System Admin', '/System Administrator/');
      await pick('ucTarget', 'Test B', '/Test B/');
      await previewReady();
      await h.sleep(1200);
      await rec.scrollTo('#ucPreview');
      await rec.say('First, a copy that cannot fully work: the source is an administrator on a Salesforce licence, the target a test user on an Identity licence.');
      if (await c.has('.uc-license-note')) {
        await rec.scrollTo('.uc-license-note', 'center');
        await rec.say('The profile row says it plainly: this would also change the licence, from Identity to Salesforce, and a licence slot must be free for that.');
      }
      if (await c.has('.uc-danger-label')) {
        await rec.scrollTo('.uc-danger-label', 'center');
        const n = await h.eval(`document.querySelectorAll('.uc-row-danger').length`);
        await rec.say(`${n} permission sets cannot be copied at all: each needs a licence the target does not have, and the badge on every row names the licence it needs.`);
        await rec.reveal('#ucPreview');
      }
      // only the profile stays ticked: the refusal is then the only thing that can happen
      await h.eval(`(() => { for (const cb of document.querySelectorAll('#ucPreview input[type=checkbox]')) { if (cb.id !== 'ucProfileCb' && cb.checked && !cb.disabled) { cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); } } return true; })()`);
      await h.sleep(500);
      await rec.scrollTo('#ucProfileCb', 'center');
      await rec.say('Only the profile is ticked. This org has no free Salesforce licence — so what happens when the licence is not there?');
      await rec.scrollTo('#ucCopyBtn', 'center');
      await rec.click('#ucCopyBtn', 800);
      await confirmShared(c, { caption: 'The confirmation names the user and the change.' });
      await rec.fast(() => h.waitFor("!!(document.querySelector('#ucResult')?.innerText || '').trim() && !/Copying/.test(document.querySelector('#ucCopyBtn')?.textContent || '')", 180000, 1000));
      await h.sleep(800);
      await rec.scrollTo('#ucResult', 'center');
      const res = await c.text('#ucResult', 300);
      h.log('copy result:', res);
      await rec.say(/error/i.test(res)
        ? 'Salesforce refuses, and the tool says so in Salesforce’s own words: no licence available. Nothing changed on the user — the preview is read again and still shows the Identity profile.'
        : 'Done — the profile changed, so a licence slot was free after all.');
      await rec.reveal('#ucResult');
      // 2. the everyday copy: one test user to another, on the same licence (shown, not run)
      await rec.say('Now the everyday case: one test user to another, on the same licence.');
      await pick('ucSource', 'Test A', '/Test A/');
      await previewReady();
      await h.sleep(1200);
      await rec.scrollTo('#ucPreview');
      await rec.say('It lists what the first user has that the second lacks — here the role — and what they already share. Tick what to copy.');
      await rec.reveal('#ucPreview');
      await rec.point('#ucCopyBtn', 1300);
      await rec.say('It asks once, reads the user back afterwards to confirm, and the copy is in this tool’s History with its Undo.');
    } },

  { id: 'flow-access', title: 'Flow Access', run: async c => {
    const { h, rec } = c;
    await c.popup('flow-access');
    await rec.say('Flow Access. Who is allowed to run which flow.');
    await rec.fast(() => h.waitFor("document.querySelectorAll('.fp-flow-cb').length > 0 && document.querySelectorAll('.fp-ps-cb').length > 0", 240000, 1000));
    await h.sleep(800);
    await rec.type('#fpFlowSearch', 'SFTK', 60);
    await h.sleep(700);
    const tickFirst = cls => h.eval(`(() => { const cb = [...document.querySelectorAll('.${cls}')].find(x => x.offsetParent && !x.checked); if (!cb) return false; cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await rec.point('.fp-flow-cb', 700); await tickFirst('fp-flow-cb');
    await rec.type('#fpPsSearch', 'SFTK', 60);
    await h.sleep(700);
    await rec.point('.fp-ps-cb', 700); await tickFirst('fp-ps-cb');
    await h.sleep(800);
    await rec.say('Pick flows on the left and profiles or permission sets on the right. The summary says what will be granted.', 5500);
    if (await c.has('#fpAssignBtn')) await rec.point('#fpAssignBtn', 1300);
    await rec.say('Granting is one confirmed change, and it is read back from the org.', 4000);
  } },

  // ───────────────────────────── Data Studio ─────────────────────────────
  { id: 'orgs', title: 'Data Studio — Connected Orgs', run: async c => {
    const { h, rec } = c;
    await c.studio('');
    await rec.say('Data Studio opens in its own tab. It works with every Salesforce org you have open in this browser.', 4500);
    await nav(c, 'orgs');
    await rec.fast(() => h.waitFor("document.querySelectorAll('.ds-org-row').length > 0", 30000, 500).catch(() => {}));
    await rec.point('.ds-org-row', 1200);
    await rec.say('Connected Orgs. Give an org a label, lock it against writes, or guard it like production: then every write asks you to type the org’s name.', 7000);
    // quick navigation: Ctrl+K from anywhere in Data Studio
    await rec.click('#dsCmdPaletteBtn', 900);
    await rec.fast(() => h.waitFor("!!document.querySelector('#dsCmdInput')", 20000, 300));
    await rec.say('Quick nav: Control K from anywhere. Type a view or a deployment, Enter opens it, Escape closes the box.');
    await rec.type('#dsCmdInput', 'hist', 90);
    if (await c.has('.ds-cmd-item')) await rec.point('.ds-cmd-item', 900);
    await h.eval(`(() => { const i = document.querySelector('#dsCmdInput'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
    await h.sleep(600);
    if (await c.has('#dsCmdInput')) await rec.click('#dsCmdPaletteBtn', 600);
  } },

  { id: 'builder', title: 'Building a deployment', run: async c => {
    const { h, rec } = c;
    if (!(await c.has('.ds-nav-btn'))) await c.studio('');
    await nav(c, 'profiles');
    await h.waitFor("!!document.querySelector('#dsNewProfile')", 60000, 500);
    await rec.say('Data Deployment moves records between orgs. It starts with a deployment: a definition you build once and run as often as you like.');
    await rec.click('#dsNewProfile', 900);
    await h.waitFor("!!document.querySelector('#dsProfileName')", 15000, 300); await h.sleep(500);
    await rec.type('#dsProfileName', 'Accounts and everything under them', 45);
    const src = await h.eval(`[...document.querySelectorAll('#dsProfileSrcOrg option')].find(o => /${SRC_ORG}/.test(o.value))?.value || ''`);
    const tgt = await h.eval(`[...document.querySelectorAll('#dsProfileTgtOrg option')].find(o => /${TGT_ORG}/.test(o.value))?.value || ''`);
    if (!src || !tgt) throw new Error('both orgs are not offered in the builder');
    await rec.point('#dsProfileSrcOrg', 600);
    await h.eval(`(() => { const s = document.querySelector('#dsProfileSrcOrg'); s.value = ${J(src)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await h.sleep(400);
    await rec.point('#dsProfileTgtOrg', 600);
    await h.eval(`(() => { const t = document.querySelector('#dsProfileTgtOrg'); t.value = ${J(tgt)}; t.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await h.sleep(400);
    await rec.say('A name, the source org and the target org — both open in this browser.');
    await rec.type('#dsRootObj', 'Account', 70); await h.sleep(1200);
    await rec.click('#dsSetRoot', 800);
    await h.waitFor("!!document.querySelector('#dsTreeArea') && /Account/.test(document.querySelector('#dsTreeArea').innerText)", 15000, 300);
    await rec.say('The root object. Under it, the builder lists every object that points at it — add the ones that belong with it.');
    await rec.fast(() => h.waitFor("document.querySelectorAll('[data-add-child]').length > 0", 90000, 1000));
    const add = async (path, obj, field) => {
      const sel = `[data-add-child="${path}"][data-rel-obj="${obj}"]${field ? `[data-rel-field="${field}"]` : ''}`;
      if (!(await c.has(sel))) return false;
      await rec.point(sel, 600);
      await h.eval(`(() => { const r = document.querySelector(${J(sel)}); r.querySelector('button').click(); return true; })()`);
      await h.sleep(1200); return true;
    };
    await add('', 'Contact', 'AccountId');
    await add('', 'Opportunity', 'AccountId');
    await add('', 'Case', 'AccountId');
    await rec.say('Contacts, Opportunities, Cases.');
    // a child of a child: line items under the opportunities (that node loads its own relationships)
    const nested = await rec.fast(() => h.waitFor("!![...document.querySelectorAll('[data-add-child]')].find(r => r.dataset.addChild !== '' && r.dataset.relObj === 'OpportunityLineItem')", 60000, 1000).then(() => true).catch(() => false));
    if (nested) {
      const path = await h.eval(`[...document.querySelectorAll('[data-add-child]')].find(r => r.dataset.addChild !== '' && r.dataset.relObj === 'OpportunityLineItem').dataset.addChild`);
      await add(path, 'OpportunityLineItem');
      await rec.say('And a child of a child: line items under the opportunities. A tree of any depth.');
    }
    await rec.scrollTo('#dsTreeArea');
    await rec.say('Saved, this becomes a deployment you can run, compare across orgs and export as a file. For the rest of this tour a prepared one is used: Accounts with ten objects under them.');
    await rec.click('#dsBuilderCancel', 900);   // nothing is saved here
    if (await c.has('#sftkConfirmGo')) await rec.click('#sftkConfirmGo', 600);
  } },

  // writes: the 🔀 Merge step merges the fixture's duplicate pair in trailheads5 for real;
  // the pair is put back off camera (fixture.mjs) so the next chapters see it again
  { id: 'deploy', title: 'Data Deployment', writes: true,
    cleanup: async ({ h }) => { restoreDuplicateName('npc', (...a) => h.log(...a)); },
    run: async c => {
    const { h, rec } = c;
    if (!(await c.has('.ds-nav-btn'))) await c.studio('');
    const id = await ensureDemo(c);
    await nav(c, 'profiles');
    await rec.fast(() => h.waitFor("document.querySelectorAll('.ds-profile-card').length > 0", 30000, 500));
    await rec.say('The saved deployments. Each is a root object, the objects under it, and how records are recognised in the other org.');
    await rec.point(`[data-dsaction="runProfile"][data-arg="${id}"]`, 1000);
    await h.eval(`window.runProfile(${J(id)})`);
    await h.sleep(1800);
    await rec.say('This one is Accounts with ten objects under them. Opening it goes to the Deploy page, which first reads both orgs. Nothing is written.');
    await rec.click('#dsDepScan, #dsDepRefresh', 500);
    await waitScanned(c);
    await h.sleep(2500);
    if (await c.has('#dsDepScanAll')) {
      await rec.scrollTo('#dsDepScanAll', 'center');
      await rec.click('#dsDepScanAll', 600);
      await rec.fast(() => h.waitFor("!document.querySelector('#dsDepScanAll') && ![...document.querySelectorAll('[data-dep-scan]')].some(b => b.disabled) && !document.querySelector('#dsDepRefresh')?.disabled", 900000, 1000));
      await h.sleep(2000);
    }
    await rec.scrollTo('.ds-dep-plan', 'center');
    await rec.say('The plan, object by object: how many records to insert, how many changed, how many exist only in the target, and how many are in sync. The children are read under the records of the scan above them.');
    await rec.reveal('.ds-dep-plan');
    await rec.scrollTo('#dsDepTree');
    await rec.say('The deployment as a tree: how each object hangs under its parent and how many records each org holds.', 5000);
    if (await c.has('[data-tree-scan]')) {
      await rec.click('[data-tree-scan]', 500);
      await rec.fast(async () => { await h.sleep(1500); await h.waitFor("![...document.querySelectorAll('[data-tree-scan]')].some(b => /⏳/.test(b.textContent))", 300000, 1000); await h.sleep(5000); });
      await rec.scrollTo('#dsDepTree');
      await rec.say('An object that was not read says “not counted yet”. Count it, and its numbers appear. Unknown is never shown as zero.', 6000);
    }
    if (await c.has('#dsDepOrder')) { await rec.scrollTo('#dsDepOrder'); await rec.say('“Start with parents first” lists what these records look up outside the deployment, and whether the target has it.', 6000); }
    await rec.scrollTo('#dsDepRecords');
    await rec.click('.ds-dep-tabs [data-dep-tab="ins"]', 900);
    await rec.say('Below, every record, in tabs. Nothing is ticked for you: only what you tick is written.', 5000);
    if (await c.has('.ds-dep-tabs [data-dep-tab="chg"]')) {
      await rec.click('.ds-dep-tabs [data-dep-tab="chg"]', 1200);
      if (await c.has('[data-dep-fields]')) {
        await rec.click('[data-dep-fields]', 500);
        await rec.fast(() => h.sleep(4500));
        await rec.say('A changed record opens side by side, field by field, read live from both orgs.', 5500);
        await h.closeModal();
        await h.eval(`(() => { const x = document.querySelector('[data-dsaction="closeModal"]'); if (x) x.click(); return true; })()`);
        await h.sleep(600);
      }
    }
    if (await c.has('.ds-dep-tabs [data-dep-tab="amb"]')) {
      await rec.click('.ds-dep-tabs [data-dep-tab="amb"]', 1200);
      if (await c.has('.ds-amb-group')) {
        await rec.scrollTo('.ds-dep-amb-intro');
        await rec.say('“Needs a decision”: two records share a name, so the scan never guesses. You say which record is which, one name at a time.', 6500);
        const picked = await h.eval(`(() => { const r = [...document.querySelectorAll('input[data-dep-amb-sel]')].find(x => x.value && x.value !== '__new__'); if (!r) return false; r.setAttribute('data-demo-amb', '1'); return true; })()`);
        if (picked) {
          await rec.point('input[data-demo-amb="1"]', 700);
          await h.eval(`(() => { const r = document.querySelector('input[data-demo-amb="1"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
          await h.sleep(600);
          await rec.click('[data-dep-amb-one]:not([disabled])', 1500);
          await rec.say('The answer is remembered for this pair of orgs. It is not a change in Salesforce.', 4500);
        }
        // 🔀 the copies in ONE org merged into one (user 2026-10-11: "so the user ends up with a
        // unique data and without dupes"; 2026-10-12: "ship it as 1.0") — a real write to trailheads5
        if (await c.has('[data-dep-amb-merge="src"]')) {
          await rec.scrollTo('[data-dep-amb-merge="src"]', 'center');
          await rec.say('And when the two copies live in one org by mistake, merge them. The copies are read live from that org.', 5500);
          await rec.click('[data-dep-amb-merge="src"]', 600);
          await rec.fast(() => h.waitFor("!!document.querySelector('.ds-merge-table')", 60000, 300));
          await h.sleep(800);
          await rec.say('Side by side. You choose the record that stays, and for every field that differs, the value it keeps — its own values are ticked.', 7500);
          const other = await h.eval(`(() => { const r = document.querySelector('tr[data-merge-field="BillingCity"] input[value="1"]') || document.querySelector('tr[data-merge-field] input[value="1"]'); if (!r) return false; r.setAttribute('data-demo-merge', '1'); return true; })()`);
          if (other) {
            await rec.point('input[data-demo-merge="1"]', 700);
            await h.eval(`(() => { const r = document.querySelector('input[data-demo-merge="1"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await rec.say('Here the first copy stays, with the city of the second.', 3500);
          }
          await rec.click('#dsMergeGo', 600);
          await rec.fast(() => h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 300));
          await h.sleep(800);
          await rec.say('The one confirmation: what is merged, what is written, and that a merge cannot be undone. Salesforce itself performs it.', 6500);
          const hist = await h.eval('_history.length');
          await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) a.click(); return true; })()`);
          await h.sleep(400);
          await rec.click('#sftkConfirmGo', 600);
          await prodGate(c);
          await rec.fast(() => h.waitFor(`_history.length > ${hist}`, 120000, 500));
          await waitScanned(c);
          await h.sleep(1200);
          await rec.scrollTo('.ds-dep-tabs', 'center');
          await rec.say('Done, and recorded in History. Both orgs are read again: the name is one record now, and the tab is empty.', 7500);
        }
      }
    }
    // what can be taken out of the way for a run (shown, then switched back off: this tour runs without them)
    if (await c.has('#dsDepRulePause')) {
      await rec.scrollTo('#dsRecRunBtn', 'center');
      await rec.say('Before a run, you can take the target’s automation out of the way, on just the objects being written.', 4500);
      const show = async (box, list, text, hold) => {
        if (!(await c.has(box))) return;
        await rec.click(box, 600);
        await rec.fast(() => h.waitFor(`(document.querySelector(${J(list)})?.innerText || '').trim().length > 20`, 60000, 500).catch(() => {}));
        await rec.scrollTo(list, 'center');
        await rec.say(text, hold);
        if (await h.eval(`!!document.querySelector(${J(box)})?.checked`)) { await h.eval(`document.querySelector(${J(box)}).click()`); await h.sleep(500); }
      };
      await show('#dsDepRulePause', '#dsDepRulePauseList', 'Pause validation rules. The page lists the active rules on these objects. They are switched off after you confirm and back on as soon as the writes end.', 7000);
      await show('#dsDepFlowPause', '#dsDepFlowPauseList', 'Pause record-triggered flows. They are switched off before the first write and back on at their exact versions afterwards, also when a run fails or is stopped.', 7000);
      if (await c.has('#dsDepDupRules')) {
        await rec.scrollTo('#dsDepDupRules', 'center');
        await rec.point('#dsDepDupRules', 1200);
        await rec.say('Duplicate rules: respect them, so a record a rule flags is not written and the run says so, or bypass them for this deployment.', 6500);
      }
    }
  } },

  // User 2026-10-06: "we didn't cover the external id field creation that should map
  // both orgs and how it works". The 🪪 identity field: created in both orgs on
  // camera, matched pairs stamped, the re-scan matches by it; cleanup deletes the
  // fields and the permission set again.
  { id: 'identity', title: 'The identity field', writes: true,
    cleanup: async ({ h }) => { removeIdentityField(['npc2', 'npc'], ['Account', 'Contact'], (...a) => h.log(...a)); },
    run: async c => {
    const { h, rec } = c;
    await openDemoScanned(c);
    await assertDirection(c);
    await rec.scrollTo('#dsDepTree');
    await rec.say('Records are matched between orgs by a field — here by Name. Names change, and two records can share one. The identity field makes the match exact.', 7500);
    await rec.click('#dsDepIdBtn', 800);
    await rec.fast(() => h.waitFor("!!document.querySelector('#dsIdGo')", 60000, 500));
    await h.sleep(800);
    await rec.say('One small field, SFTK underscore ID: on every target record it stores the Id of the source record it came from. The table says which org has it — neither, yet — and how many matched pairs the scan found.', 9500);
    await rec.point('#dsIdS', 800);
    await h.eval(`(() => { const s = document.querySelector('#dsIdS'); if (s && !s.disabled && !s.checked) s.click(); return true; })()`);
    await rec.say('Create it in the target, and in the source as well, so the identity travels when this org is a source for another one.', 6000);
    await rec.click('#dsIdGo', 600);
    await rec.fast(() => h.waitFor("document.querySelectorAll('#dsIdOut .ds-rec-card-line').length > 0", 300000, 1000));
    await h.sleep(1200);
    await rec.say('One metadata deploy per org: the field, plus a permission set that lets you see it.', 6500);
    const stamp = await h.eval(`(() => { const b = [...document.querySelectorAll('[data-id-stamp]')].find(b => /Account/.test(b.closest('tr')?.innerText || '')); return b ? b.innerText.trim() : ''; })()`);
    if (stamp) {
      await rec.point(`[data-id-stamp]`, 800);
      await rec.say(`${stamp.replace('🪪 ', '')} — the Accounts the scan already matched by Name get their source Id written once. From then on they match exactly, whatever their names do.`, 7500);
      await h.eval(`(() => { const b = [...document.querySelectorAll('[data-id-stamp]')].find(b => /Account/.test(b.closest('tr')?.innerText || '')); if (b) b.click(); return true; })()`);
      await rec.fast(() => h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 300));
      await h.sleep(600);
      await rec.say('The one confirmation, as for every write.', 4500);
      const hist = await h.eval('_history.length');
      await rec.click('#sftkConfirmGo', 600);
      await prodGate(c);
      await rec.fast(async () => { for (let i = 0; i < 120 && !(await h.eval(`_history.length > ${hist}`)); i++) await h.sleep(1000); await h.sleep(1500); });
      await rec.say('Done, and recorded in History with an undo — the field can be emptied again from there.', 5000);
    }
    await h.closeModal();
    await h.sleep(400);
    await rec.click('#dsDepRefresh', 600);
    await waitScanned(c);
    await h.sleep(1500);
    await rec.scrollTo('.ds-dep-plan', 'center');
    await rec.say('Now the stamped records match by their identity. New records a deployment creates are stamped as they are written — nothing more to do.', 7000);
  } },
  { id: 'run', title: 'Deploy and roll back', writes: true, run: async c => {
    const { h, rec } = c;
    if (!(await h.eval(`typeof _currentView !== 'undefined' && _currentView === 'deploy' && !!document.querySelector('.ds-dep-plan')`))) await openDemoScanned(c);
    // the children are read under the root's records first (a re-scan reads the root only — live 2026-10-10: 6 of ~40 records)
    if (await c.has('#dsDepScanAll')) {
      await rec.scrollTo('#dsDepScanAll', 'center');
      await rec.click('#dsDepScanAll', 600);
      await rec.fast(() => h.waitFor("!document.querySelector('#dsDepScanAll') && ![...document.querySelectorAll('[data-dep-scan]')].some(b => b.disabled) && !document.querySelector('#dsDepRefresh')?.disabled", 900000, 1000));
      await h.sleep(1500);
    }
    await rec.scrollTo('#dsDepRecords');
    await rec.say('Now a real deployment, of the whole tree. One button ticks every record the target lacks, in every object that was read — parents before their children.');
    await rec.scrollTo('#dsDepTickAll', 'center');
    await rec.click('#dsDepTickAll', 900);
    await rec.fast(() => h.waitFor("document.querySelectorAll('#dsDepRecords input[type=checkbox]:checked').length > 0", 30000, 300));
    let ticked = await h.eval(`(() => { let n = 0; for (const k of Object.keys(_recChildSel)) n += _recChildSel[k].push.size; return n + _recSel.push.size; })()`);
    // one fixture account stays out on purpose: the target's own validation rule refuses it (Retail
    // without a website) — its children then stay untickable, their parent not being on the way
    await rec.click('[data-dep-obj=""][data-dep-tab="ins"]', 500);
    ticked -= await h.eval(`(() => { let n = 0; for (const r of document.querySelectorAll('#dsDepList .ds-dep-row')) { if (/Americas/.test(r.innerText)) { const cb = r.querySelector('input[type=checkbox]:checked'); if (cb) { cb.click(); n++; } } } return document.querySelectorAll('#dsDepList input[type=checkbox]:checked').length; })()`);
    await rec.say('One account stays out on purpose: the target refuses it with a validation rule, and the run will say so.', 4500);
    await h.sleep(600);
    if (!ticked) throw new Error('nothing to insert in the fixture');
    await assertDirection(c);
    const nObjs = await h.eval('(_recSel.push.size ? 1 : 0) + Object.keys(_recChildSel).filter(k => _recChildSel[k].push.size).length');
    await rec.say(`${ticked} records across ${nObjs} objects are ticked. A child whose parent is also new is written after its parent, with the new parent’s id.`);
    // batches of five, one at a time: the write can be watched (two hundred is the default) — typed into
    // the setting itself, so the page shows the five the voice speaks of
    if (await c.has('#dsDepBatch')) {
      await rec.scrollTo('#dsDepBatch', 'center');
      await rec.type('#dsDepBatch', '5', 120);
      await h.eval(`(() => { const i = document.querySelector('#dsDepBatch'); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      await h.sleep(600);
      await rec.say('The batch size is a setting: two hundred by default. Five here, so each batch can be watched.');
    } else await h.eval("(async () => { await sftkRecSetEngine(_reconcileProfile, 'batchSize', '5'); return true; })()");
    await h.eval("(async () => { await sftkRecSetEngine(_reconcileProfile, 'threads', '1'); return true; })()");
    await rec.scrollTo('#dsRecRunBtn', 'center');
    await rec.say('A restore point is taken first, so the run can be rolled back.');
    const before = await h.eval('_history.length');
    await assertDirection(c);
    await rec.click('#dsRecRunBtn', 1500);
    for (let i = 0; i < 3; i++) {
      if (await c.has('#sftkConfirmGo')) await confirmShared(c, { caption: i === 0 ? 'One confirmation: what will be written, where, and in which order.' : '' });
      else if (await h.modalText()) {
        await h.eval(`(() => { const b = document.querySelector('#dsRecDelOk') || [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed|deploy|confirm/i.test(b.textContent)); if (b) b.click(); return !!b; })()`);
        await h.sleep(1500);
      } else break;
    }
    await rec.scrollTo('#dsRecProgress');
    await rec.say('The run, as it happens: object by object, parents first, in batches, with Salesforce’s answer for every record.');
    // real time, narrated — the write is the point (user 2026-10-09: "extend the time of the actual operation")
    const t0 = Date.now();
    const lines = [
      'Accounts first. Then the objects under them, in the order the tree needs.',
      'Every record gets Salesforce’s own answer. A refusal is named with its reason, and is never counted as done.',
      'A long run can be paused here. It stops after the batch in flight, and History offers to continue it later.',
    ];
    let k = 0;
    while ((await h.eval('_history.length')) <= before && Date.now() - t0 < 900000) {
      await h.sleep(1000);
      if (k < lines.length && Date.now() - t0 > 5000 + k * 9000) {
        if (k === 2 && await c.has('#dsRunPauseBtn')) await rec.point('#dsRunPauseBtn', 900);
        await rec.say(lines[k]); k++;
      }
    }
    if ((await h.eval('_history.length')) <= before) throw new Error('the deployment did not finish');
    await rec.pause(2500);
    await rec.fast(async () => { await h.sleep(5000); await h.waitFor("!document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000).catch(() => {}); });
    const last = await h.eval(`(() => { const e = _history[_history.length - 1] || {}; const s = Object.values(e.summary || {}); const sum = k => s.reduce((t, o) => t + (Number(o && o[k]) || 0), 0); return { status: e.status || '', inserted: sum('inserted'), failed: sum('insertedFailed') }; })()`);
    h.log('deployment result:', J(last));
    h.log('deployment errors:', await h.eval(`JSON.stringify(((_history[_history.length - 1] || {}).errors || []).slice(0, 12))`));
    await rec.say(last.status === 'success'
      ? `Done: ${last.inserted} records written. Afterwards both orgs are read again, so the page shows what is true now, not what was sent.`
      : `Finished: ${last.inserted} records written, ${last.failed} refused. A record the target refused is reported with Salesforce’s own reason, never counted as done. Both orgs are read again afterwards.`);

    await nav(c, 'history');
    await h.waitFor("!!document.querySelector('.ds-history-card, .ds-history-item')", 20000, 500);
    await rec.say('History keeps every run: what was written, per object, with links to the records, and a report by name.');
    if (!(await c.has('[data-dsaction="rollbackRun"]:not([disabled])'))) throw new Error('no rollback offered for the run');
    const rbBefore = await h.eval(`_history.filter(x => x.kind === 'rollback').length`);
    await rec.click('[data-dsaction="rollbackRun"]:not([disabled])', 800);
    await rec.say('Roll back opens a page of its own: what the run wrote, compared with the restore point.');
    await rec.fast(() => h.waitFor("!!document.querySelector('#dsRbGo') || !!document.querySelector('.ds-rec-card-bad')", 300000, 1000));
    await h.sleep(1500);
    if (!(await c.has('#dsRbGo'))) throw new Error('the rollback could not be prepared');
    await rec.scrollTo('.ds-dep-plan', 'center');
    await rec.say('It names every record it would delete or restore, child objects first, and what it leaves alone because someone changed it after the run.');
    await rec.reveal(null);
    await rec.scrollTo('#dsRbGo', 'center');
    await rec.click('#dsRbGo', 800);
    await confirmShared(c, { caption: 'The confirmation asks you to acknowledge.' });
    await rec.say('The rollback runs like a deployment: live, object by object.');
    const t1 = Date.now();
    while ((await h.eval(`_history.filter(x => x.kind === 'rollback').length`)) <= rbBefore && Date.now() - t1 < 900000) await h.sleep(1000);
    await h.sleep(2000);
    if ((await h.eval(`_history.filter(x => x.kind === 'rollback').length`)) <= rbBefore) throw new Error('the rollback did not finish');
    await rec.scrollTo('#dsRbResult', 'center');
    await rec.say('Rolled back. The records are in the target’s Recycle Bin.');
    if (await c.has('#dsRbOpenReport')) {
      await rec.click('#dsRbOpenReport', 1500);
      await rec.say('“Which records” lists every record the rollback touched, by name.');
      await rec.reveal(null);
    }
  } },

  // Two thousand records, written live: the counter climbs on camera (user 2026-10-15). Rolled back on
  // camera; a chapter that did not finish is cleaned off camera.
  { id: 'volume', title: 'Deploy at volume', writes: true,
    cleanup: async ({ h }) => { removeVolume('npc2', (...a) => h.log(...a)); },
    run: async c => {
    const { h, rec } = c;
    if (!(await c.has('.ds-nav-btn'))) await c.studio('');
    const id = await ensureVolumeDemo(c);
    await h.eval(`window.runProfile(${J(id)})`); await h.sleep(1500);
    await rec.say('The same page, at volume: a deployment of two thousand accounts the target does not have.');
    await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
    await waitScanned(c);
    await h.sleep(1500);
    await assertDirection(c);
    await rec.scrollTo('#dsDepTickAll', 'center');
    await rec.say('One button ticks them all.');
    await rec.click('#dsDepTickAll', 900);
    await rec.fast(() => h.waitFor("document.querySelectorAll('#dsDepRecords input[type=checkbox]:checked').length > 0", 30000, 300));
    const ticked = await h.eval('_recSel.push.size');
    if (ticked < 1900) throw new Error(`only ${ticked} records ticked`);
    await rec.scrollTo('#dsRecRunBtn', 'center');
    await rec.say(`${ticked.toLocaleString()} records ticked, in batches of one hundred, so the count can be watched.`);
    const before = await h.eval('_history.length');
    await rec.click('#dsRecRunBtn', 1500);
    for (let i = 0; i < 3; i++) {
      if (await c.has('#sftkConfirmGo')) await confirmShared(c, { caption: i === 0 ? 'The confirmation, with the numbers.' : '' });
      else if (await h.modalText()) {
        await h.eval(`(() => { const b = document.querySelector('#dsRecDelOk') || [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed|deploy|confirm/i.test(b.textContent)); if (b) b.click(); return !!b; })()`);
        await h.sleep(1500);
      } else break;
    }
    await rec.scrollTo('#dsRecProgress');
    await rec.say('Sped up here, but every number is a real write as it happens: records accepted by Salesforce, batch after batch.');
    const t0 = Date.now();
    await rec.fast(async () => { while ((await h.eval('_history.length')) <= before && Date.now() - t0 < 1200000) await h.sleep(500); }, { video: 12 });
    if ((await h.eval('_history.length')) <= before) throw new Error('the volume deployment did not finish');
    await rec.pause(1500);
    await rec.fast(async () => { await h.sleep(3000); await h.waitFor("!document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000).catch(() => {}); });
    const last = await h.eval(`(() => { const e = _history[_history.length - 1] || {}; const s = Object.values(e.summary || {}); const sum = k => s.reduce((t, o) => t + (Number(o && o[k]) || 0), 0); return { status: e.status || '', inserted: sum('inserted') || sum('created') || 0, failed: sum('insertedFailed') || 0 }; })()`);
    h.log('volume result:', J(last));
    h.log('volume entry:', await h.eval(`(() => { const e = _history[_history.length - 1] || {}; return JSON.stringify({ status: e.status, errors: (e.errors || []).slice(0, 5), notes: e.notes || e.note || null, summary: e.summary }); })()`));
    await rec.say(!last.failed
      ? `Done: ${Number(last.inserted).toLocaleString()} records written and read back from the target.`
      : `Finished: ${Number(last.inserted).toLocaleString()} written, ${last.failed} refused, each with Salesforce’s own reason.`);
    await nav(c, 'history');
    await h.waitFor("!!document.querySelector('.ds-history-card, .ds-history-item')", 20000, 500);
    if (!(await c.has('[data-dsaction="rollbackRun"]:not([disabled])'))) throw new Error('no rollback offered for the volume run');
    const rbBefore = await h.eval(`_history.filter(x => x.kind === 'rollback').length`);
    await rec.click('[data-dsaction="rollbackRun"]:not([disabled])', 800);
    await rec.say('And back: the same two thousand, rolled back.');
    await rec.fast(() => h.waitFor("!!document.querySelector('#dsRbGo') || !!document.querySelector('.ds-rec-card-bad')", 300000, 1000));
    await h.sleep(1200);
    if (!(await c.has('#dsRbGo'))) throw new Error('the volume rollback could not be prepared');
    await rec.scrollTo('#dsRbGo', 'center');
    await rec.click('#dsRbGo', 800);
    await confirmShared(c, { caption: '' });
    const t1 = Date.now();
    await rec.fast(async () => { while ((await h.eval(`_history.filter(x => x.kind === 'rollback').length`)) <= rbBefore && Date.now() - t1 < 1200000) await h.sleep(500); }, { video: 8 });
    if ((await h.eval(`_history.filter(x => x.kind === 'rollback').length`)) <= rbBefore) throw new Error('the volume rollback did not finish');
    await h.sleep(1500);
    await rec.scrollTo('#dsRbResult', 'center');
    await rec.say('Rolled back, and the target is as it was.');
  } },

  { id: 'ring', title: 'All open orgs', run: async c => {
    const { h, rec } = c;
    if (!(await c.has('.ds-nav-btn'))) await c.studio('');
    await ensureDemo(c);
    await nav(c, 'ring');
    await h.waitFor("!!document.querySelector('#dsRingSrc')", 60000, 500);
    await rec.say('All open orgs. One org is the source, and every other org you have open is measured against it.', 1500);
    await rec.point('#dsRingSrc', 900);
    const ok = await h.eval(`(() => { const s = document.querySelector('#dsRingSrc'); const o = [...s.options].find(o => (o.value + ' ' + o.textContent).includes(${J(SRC_ORG)})); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    if (!ok) throw new Error('the source org is not offered');
    await rec.fast(() => h.waitFor("!!document.querySelector('[data-ring-cell]')", 60000, 1000));
    await rec.pause(1500);
    await rec.say('Pick the source. Each deployment is a row, each other org a column: how far that org is from the source for that deployment.', 6000);
    if (await c.has('[data-ring-scanall]:not([disabled])')) {
      await rec.click('[data-ring-scanall]:not([disabled])', 600);
      await rec.fast(async () => { await h.sleep(2500); await h.waitFor("![...document.querySelectorAll('[data-ring-scanall]')].some(b => /⏳/.test(b.textContent)) && ![...document.querySelectorAll('[data-ring-cell]')].some(x => /⏳/.test(x.innerText))", 900000, 2000).catch(() => {}); await h.sleep(1500); });
      await rec.say('One Scan compares every deployment with every open org: records missing, changed, or only in the target. A scan changes nothing.', 6500);
    }
    if (await c.has('[data-ring-rec]')) { await rec.point('[data-ring-rec]', 1200); await rec.say('From a cell you open that deployment against that org, and fix it there.', 4000); }
  } },

  { id: 'history', title: 'History', run: async c => {
    const { h, rec } = c;
    if (!(await c.has('.ds-nav-btn'))) await c.studio('');
    await nav(c, 'history');
    await h.sleep(1500);
    await rec.say('History. Every deployment and every rollback, with what was written and what the org said afterwards.', 5500);
    if (await c.has('.ds-history-card')) { await rec.point('.ds-history-card', 1200); await rec.scrollBy(null, 400); }
    if (await c.has('#dsHistKitNote')) { await rec.scrollTo('#dsHistKitNote', 'center'); await rec.point('#dsHistKitNote', 1200); }
    await rec.say('A change made by a Toolkit tool is listed in that tool, with its own Undo. All of it stays on this computer, and you can export it.', 6000);
  } },

  { id: 'compare', title: 'Org Compare', run: async c => {
    const { h, rec } = c;
    if (!(await c.has('.ds-nav-btn'))) await c.studio('');
    await nav(c, 'compare');
    await h.waitFor("!!document.querySelector('#dsOCSrc')", 60000, 500);
    await rec.say('Org Compare. Pick two orgs and any objects, and count the difference.', 1500);
    const setOrg = (sel, part) => h.eval(`(() => { const s = document.querySelector(${J(sel)}); const o = [...s.options].find(o => o.value.includes(${J(part)})); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await rec.point('#dsOCSrc', 600); await setOrg('#dsOCSrc', SRC_ORG); await h.sleep(600);
    await rec.point('#dsOCTgt', 600); await setOrg('#dsOCTgt', TGT_ORG); await h.sleep(600);
    await rec.fast(() => h.waitFor("document.querySelectorAll('[data-oc-obj]').length > 5", 180000, 1000));
    if (await c.has('#dsOCSelNone')) await h.eval(`document.querySelector('#dsOCSelNone').click()`);
    for (const o of ['Account', 'Contact', 'Opportunity', 'Case']) {
      if (!(await c.has(`[data-oc-obj="${o}"]`))) continue;
      await rec.point(`[data-oc-obj="${o}"]`, 450);
      await tick(c, `[data-oc-obj="${o}"]`);
    }
    await rec.click('#dsOCRun', 800);
    await rec.fast(() => h.waitFor("document.querySelectorAll('.ds-oc-table tbody tr').length > 0 && !/comparing/.test(document.querySelector('#dsOCResults')?.innerText || '')", 600000, 2000));
    await h.sleep(800);
    await rec.scrollTo('#dsOCResults');
    await rec.say('Per object: how many records are in both orgs, missing from the target, or only in the target. Read-only.', 6000);
  } },

  { id: 'orghealth', title: 'Org health', run: async c => {
    const { h, rec } = c;
    if (!(await c.has('.ds-nav-btn'))) await c.studio('');
    await nav(c, 'orghealth');
    await h.waitFor("!!document.querySelector('[data-oh-card]')", 30000, 500);
    await h.sleep(2000);
    await rec.say('Org health. One org at a time, one card per finding. Nothing is read until you ask.', 4000);
    await rec.click('#dsOhAll', 1200);
    await rec.fast(() => h.waitFor("![...document.querySelectorAll('[data-oh-check]')].some(b => /checking/.test(b.textContent))", 300000, 1000));
    await h.sleep(1000);
    await rec.say('Licences at their cap, users who have not logged in, flows left switched off, and more. The page says how many API calls the checks used.', 7000);
    await rec.scrollBy(null, 600);
    await rec.pause(2500);
  } },

  { id: 'outro', title: 'Licence and privacy', run: async c => {
    const { h, rec } = c;
    if (!(await c.has('.ds-nav-btn'))) await c.studio('');
    if (await c.has('#sftkTermsBtn')) {
      await rec.click('#sftkTermsBtn', 1200);
      await rec.say('The licence agreement and the privacy notes are one click away, in the Toolkit and in Data Studio.', 5000);
      await h.eval(`document.querySelector('#sftkTermsViewClose')?.click()`);
      await h.sleep(600);
    }
    await c.home();
    await rec.say('Admin Toolkit for Salesforce. It reads before it writes, asks once, and checks the org afterwards.', 5500);
    await rec.say('Thank you for watching.', 3500);
  } },
];
