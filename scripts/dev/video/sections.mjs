// The sections of the walkthrough (walkthrough.mjs runs them in this order).
// Each: { id, title (the chapter), writes?, run(ctx), cleanup?(ctx) }.
// ctx = { h, rec, text, has, popup(tab), studio(hash), home() }.
//
// Most sections only read. The ones flagged `writes: true` use a tool for
// real, on FIXTURES only, and leave the org as they found it:
//   flow-switches  three fixture flows OFF, then ↩ Undo from the tool's History
//   api-versions   one fixture flow to the org's API version, then ↩ Undo
//   fields         the fixture field replaced on its layout, Lightning page
//                  and flows, one change undone on camera; `cleanup` then
//                  redeploys the fixture (fixture.mjs) off camera
//   run            two fixture accounts into trailheads4, then rolled back
// WRITES=0 leaves all four out. A confirmation that is opened only to show it
// is CANCELLED, never confirmed.
//
// Every caption states what the tool does and nothing more: when a tool
// changes, change its caption here with it.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { restoreFieldCleanerFixture, removeIdentityField } from './fixture.mjs';

const J = JSON.stringify;
const FIXTURE = 'docs/fixtures/complex-deployment/profiles.json';
const DEMO = 'Accounts and Contacts';
const OLD_FIELD = 'SFTK_FC_Test_Status__c', NEW_FIELD = 'SFTK_FC_Test_Status2__c';
const SRC_ORG = 'trailheads5', TGT_ORG = 'trailheads4';
const SRC_URL = `https://${SRC_ORG}.my.salesforce.com`, TGT_URL = `https://${TGT_ORG}.my.salesforce.com`;

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
// the shared confirmation with a typed word (OFF, CHANGE, UNDO…)
async function typedConfirm(c, word) {
  const { h, rec } = c;
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 120000, 400);
  await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) a.click(); return true; })()`);
  if (await c.has('#sftkConfirmWord')) await rec.type('#sftkConfirmWord', word, 140);
  await rec.click('#sftkConfirmGo', 600);
  await prodGate(c);
}
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
  await rec.say('Undone, and verified by reading the org again.', 3800);
  await rec.click('#sftkThClose', 500);
}
// The video's own deployments: Accounts with their Contacts (the fixture's big
// tree cut down to two objects, so every screen stays readable), plus two
// small ones for the lists. Imported through the product's own import.
async function ensureDemo(c) {
  const { h } = c;
  const all = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const pick = n => all.find(p => (p.profile || p).name === n);
  const base = JSON.parse(JSON.stringify(pick('SFTK CX — Accounts tree')));
  const prof = base.profile || base;
  prof.name = DEMO;
  prof.tree.children = (prof.tree.children || []).filter(ch => (ch.objectType || ch.childSObject) === 'Contact');
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
    await c.home();
    await rec.say('Admin Toolkit for Salesforce. It runs in your browser and uses the Salesforce session you already have open. It talks to your Salesforce org and to nothing else.', 5500);
    await rec.say('It has two parts. The Toolkit works on one org: flows, pages, fields, permissions. Data Studio moves records between orgs.', 5500);
    await rec.point('.home-card[data-fid="flows"]', 900);
    await rec.point('.home-card[data-fid="fields"]', 900);
    // several orgs open: the Toolkit works on one at a time, says which, and switches
    const pickOrg = async part => {
      await rec.click('#homeOrgSelector', 900);
      await rec.fast(() => h.waitFor("document.querySelectorAll('#homeOrgDropdown .home-org-dd-item').length > 1", 20000, 400));
      await rec.pause(1800);
      const ok = await h.eval(`(() => { document.querySelectorAll('[data-demo-org]').forEach(x => x.removeAttribute('data-demo-org')); const it = [...document.querySelectorAll('#homeOrgDropdown .home-org-dd-item')].find(x => x.innerText.includes(${J(part)})); if (!it) return false; it.setAttribute('data-demo-org', '1'); return true; })()`);
      if (!ok) throw new Error(`${part} is not in the org list`);
      await rec.click('#homeOrgDropdown .home-org-dd-item[data-demo-org="1"]', 600);
      await h.waitFor(`(document.querySelector('#homeOrgSelector')?.innerText || '').includes(${J(part)})`, 30000, 400);
      await rec.pause(1500);
    };
    await rec.say('With several orgs open, the Toolkit works on one at a time. The card at the top says which one, and switches.', 1500);
    await pickOrg(TGT_ORG);
    await rec.say('Every tool now reads and writes that org, until you switch again. The same switch is in the top bar of every tool.', 5000);
    await pickOrg(SRC_ORG);
    if (!(await c.text('#homeOrgSelector', 200)).includes(SRC_ORG)) throw new Error('could not switch back to the source org');
    await rec.say('Every tool reads first and shows what it found. A change is made only after one confirmation that says exactly what will happen.', 5000);
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
    await rec.fast(() => h.waitFor("!!document.querySelector('#depApiVerBtn') && document.querySelectorAll('.dep-node').length > 0", 300000, 1000));
    await rec.pause(3000);
    if (await c.has('.dep-filter-btn[data-type="RecordTriggeredFlow"]')) { await rec.click('.dep-filter-btn[data-type="RecordTriggeredFlow"]', 1500); await rec.say('Filter by kind, for example only record-triggered flows.', 3000); await rec.click('.dep-filter-btn[data-type="all"]', 1000); }
    if (await c.has('#depRefSearch')) {
      // The search answers only for the flow versions whose text it has read, and says so.
      // So: search; while the page says the scan is still running, wait and search again;
      // when it says the list came from the stored cache, press its "Read them all".
      const search = async () => {
        await h.eval(`(() => { const i = document.querySelector('#depRefSearch'); i.value = ${J(OLD_FIELD)}; document.querySelector('#depRefGo').click(); return true; })()`);
        await h.waitFor("!!document.querySelector('#depRefResults')?.innerText", 60000, 500).catch(() => {});
        await h.sleep(400);
        return h.eval(`(() => { const t = document.querySelector('#depRefResults')?.innerText || ''; return { partial: !!document.querySelector('#depRefRescan'), running: /still running/.test(t), hits: document.querySelectorAll('.dep-ref-hit').length }; })()`);
      };
      await rec.type('#depRefSearch', OLD_FIELD, 22);
      let st = await search();
      if (st.partial) {
        await rec.scrollTo('#depRefResults', 'center');
        await rec.say('The search says how much it actually read. Not every flow has been read yet, so this is not an answer.', 4500);
        await rec.fast(async () => {
          const end = Date.now() + 420000; let asked = false;
          while (st.partial && Date.now() < end) {
            if (!st.running && !asked) { asked = true; await h.eval(`document.querySelector('#depRefRescan')?.click()`); await h.sleep(4000); }
            else await h.sleep(3000);
            st = await search();
          }
        });
      }
      await rec.scrollTo('#depRefResults', 'center');
      await rec.say(st.partial ? '“What uses this?” Type a field or a component and see the flows that mention it.'
        : `“What uses this?” Every flow was read: ${st.hits} flow version${st.hits === 1 ? '' : 's'} mention this field.`, 5500);
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
    await rec.say('The confirmation names every flow and says what switching it off means. Then it asks you to type the word.', 5000);
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
    await rec.say('Read again from the org: all three are on.', 3500);
  } },

  { id: 'api-versions', title: 'API versions', writes: true, run: async c => {
    const { h, rec } = c;
    const row = '.dep-av-pick[value="SFTK_AV_Test_A"]';
    await c.popup('dependencies');
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
    await rec.say('Changing the version deploys a new version of the flow. Where the flow is active, the tool activates it and reads the org again to confirm what is running.', 6500);
    await typedConfirm(c, 'CHANGE');
    await rec.fast(() => h.waitFor("/refused the package|changed across/.test(document.querySelector('#depAvLog')?.innerText || '')", 600000, 1500));
    await rec.scrollTo('#depAvLog', 'center');
    await rec.say('Done: the new version is active, verified by re-reading the org.', 4500);
    await undoInTool(c, 'This too is in the tool’s History. Undo makes the previous version the active one again.');
  } },

  { id: 'debugger', title: 'Debugger', run: async c => {
    const { h, rec } = c;
    await c.popup('debugger');
    await h.waitFor("!!document.querySelector('#adbgUserInput')", 60000, 500);
    await rec.say('Debugger. Pick a user and a debug profile, then start a trace. The trace lasts one hour.', 1500);
    await rec.type('#adbgUserInput', 'SFTK', 60);
    await rec.fast(() => h.waitFor("document.querySelectorAll('.adbg-uopt').length > 0", 30000, 400).catch(() => {}));
    if (await c.has('.adbg-uopt')) await rec.click('.adbg-uopt', 1200);
    await rec.point('#adbgProfile', 1000);
    await rec.point('#adbgStartBtn', 1200);
    await rec.say('The Apex logs of that user are listed here. Open one to read it here, with a search.', 1500);
    await rec.fast(() => h.waitFor("document.querySelectorAll('.adbg-log-row').length > 0", 20000, 500).catch(() => {}));
    if (await c.has('.adbg-log-row')) {
      await rec.click('.adbg-log-row .adbg-row-op, .adbg-log-row', 800);
      await rec.fast(() => h.waitFor("!document.querySelector('#adbgDetail .adbg-detail-loading')", 60000, 500).catch(() => {}));
      await rec.pause(3500);
    } else await rec.pause(3000);
  } },

  { id: 'pages', title: 'Lightning Pages', run: async c => {
    const { h, rec } = c;
    await c.popup('pages');
    await rec.say('Lightning Pages. Every record page of the org, and where each one is assigned.');
    await rec.fast(() => h.waitFor("document.querySelectorAll('.lp-row').length > 0", 240000, 1000));
    await rec.pause(2500);
    await rec.type('#lpSearch', 'SFTK');
    await h.sleep(900);
    // the list redraws itself while it checks the org defaults, so the row is found again at every step
    const findRow = `([...document.querySelectorAll('.lp-row')].find(x => /SFTK[ _]LP/i.test(x.querySelector('.lp-row-name')?.textContent || '')) || document.querySelector('.lp-row'))`;
    let open = false;
    for (let i = 0; i < 5 && !open; i++) {
      if (!(await h.eval(`(() => { const r = ${findRow}; if (!r) return false; document.querySelectorAll('[data-demo-row]').forEach(x => x.removeAttribute('data-demo-row')); r.setAttribute('data-demo-row', '1'); return true; })()`))) throw new Error('no Lightning page row to open');
      await rec.point('.lp-row[data-demo-row="1"]', 700);
      await h.eval(`(() => { const r = ${findRow}; if (r) r.click(); return !!r; })()`);
      open = await h.waitFor("!!document.querySelector('#lpDetailBody') && !!document.querySelector('#lpDetailBody').offsetParent", 6000, 300).then(() => true).catch(() => false);
    }
    if (!open) throw new Error('the page detail did not open');
    await rec.fast(() => h.waitFor("!!document.querySelector('#lpDetailBody .lp-status-bar')", 180000, 1000));
    await rec.say('A page’s assignments, read from Salesforce each time: the org default, an app default, or an app with a record type and a profile.', 6000);
    if (await c.has('.lp-users-btn')) {
      await rec.click('.lp-users-btn', 800);
      await rec.fast(() => h.sleep(4000));
      await rec.say('“Show affected users” lists who actually gets this page.', 4000);
    }
    await rec.say('Assign, remove, deactivate or clone a page from here. Every change is confirmed once and then checked against the org.', 5500);
  } },

  { id: 'fields', title: 'Field Cleaner', writes: true,
    cleanup: async ({ h }) => { restoreFieldCleanerFixture('npc', (...a) => h.log(...a)); },
    run: async c => {
      const { h, rec } = c;
      const settled = "!document.querySelector('#sftkConfirmGo') && !document.querySelector('.fc-fix-btn[disabled]')";
      // the tool's confirmation for one fix: read it out, acknowledge, go
      const confirmFix = async ({ caption, hold = 5000, flow = false }) => {
        await rec.fast(() => h.waitFor("!!document.querySelector('#sftkConfirmGo') || !!document.querySelector('.fc-item-err')", 120000, 500));
        if (!(await c.has('#sftkConfirmGo'))) throw new Error(`no confirmation appeared: ${await c.text('.fc-item-err', 300)}`);
        if (caption) await rec.say(caption, hold);
        if (flow && await h.eval(`!!document.querySelector('#fcFlowBackup')?.checked`)) await rec.click('#fcFlowBackup', 500);   // no file download in a recording
        if (await c.has('#sftkConfirmAck')) { await rec.point('#sftkConfirmAck', 500); await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) a.click(); return true; })()`); await h.sleep(300); }
        await rec.click('#sftkConfirmGo', 600);
        await prodGate(c);
      };
      let fixed = 0;
      const fix = async (sel, opts, after) => {
        if (!(await c.has(sel))) return false;
        await rec.click(sel, 500);
        await confirmFix(opts);
        await rec.fast(() => h.waitFor(settled, 600000, 1000));
        await h.sleep(1500);
        fixed++;
        if (after) await rec.say(after.text, after.hold || 4500);
        return true;
      };

      await c.popup('fields');
      await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
      await rec.say('Field Cleaner, from start to finish: retiring a field by moving everything that uses it to its replacement.', 1500);
      await fcPick(c, '#fcObjInput', '#fcObjDrop', 'Account');
      await fcPick(c, '#fcFieldInput', '#fcFieldDrop', OLD_FIELD);
      await rec.fast(() => h.waitFor("!document.querySelector('#fcReplInput')?.disabled || !!document.querySelector('#fcReplNote .fc-repl-bad')", 60000, 500));
      await rec.say('Pick the object, the field, and a replacement field of the same type.', 1200);
      if (await h.eval(`!!document.querySelector('#fcReplInput')?.disabled`)) throw new Error('the replacement picker is not available for the fixture field');
      await fcPick(c, '#fcReplInput', '#fcReplDrop', NEW_FIELD);
      await rec.click('#fcScanBtn', 800);
      await rec.fast(() => h.waitFor("/reference|Nothing references|No references|found|dependenc/i.test(document.querySelector('#fcResults')?.innerText || '') && !/scanning|⏳/i.test(document.querySelector('#fcScanBtn')?.innerText || '')", 240000, 1000));
      await h.sleep(3000);
      await rec.scrollTo('#fcResults');
      await rec.say('The scan lists everything that mentions the field: layouts, flows, Lightning pages, and whether the field still holds data. Nothing has changed yet.', 6500);

      // 1. access: the people who can see the old field must see the new one
      if (await c.has('#fcFlsCopyBtn')) {
        await rec.scrollTo('#fcFlsCopyBtn', 'center');
        await rec.click('#fcFlsCopyBtn', 500);
        await confirmFix({ caption: 'First, access. The profiles and permission sets that can see the old field get the same access to the new one. Access is only added.', hold: 6000 });
        await rec.fast(() => h.waitFor("!document.querySelector('#fcFlsCopyBtn') && !document.querySelector('#sftkConfirmGo')", 120000, 500));
        await h.sleep(1200); fixed++;
        await rec.say('Copied, and verified by reading the org again.', 3500);
      }
      // 2. the layout and the Lightning page
      if (await c.has('.fc-fix-btn[data-type="Layout"][data-swap="1"]')) {
        await rec.scrollTo('.fc-fix-btn[data-type="Layout"][data-swap="1"]', 'center');
        await rec.say('Every item has its own buttons: Replace moves it to the new field, Remove takes the old field out.', 4500);
        await fix('.fc-fix-btn[data-type="Layout"][data-swap="1"]', { caption: 'Replace on the page layout: the new field takes the old field’s place. A restore point is saved first.' },
          { text: 'The layout now shows the new field.', hold: 3200 });
      }
      if (await c.has('.fc-fix-btn[data-type="FlexiPage"][data-swap="1"]')) {
        await rec.scrollTo('.fc-fix-btn[data-type="FlexiPage"][data-swap="1"]', 'center');
        await fix('.fc-fix-btn[data-type="FlexiPage"][data-swap="1"]', { caption: 'The same on the Lightning page: its field component and its visibility rule now use the new field.' });
      }
      // 3. the flows: a new active version that uses the new field
      let firstFlow = true;
      for (const name of ['SFTK FC Test Flow 2', 'SFTK FC Test Flow']) {
        const sel = `.fc-fix-btn[data-type="Flow"][data-name="${name}"][data-swap="1"]`;
        if (!(await c.has(sel))) continue;
        await rec.scrollTo(sel, 'center');
        if (firstFlow) await rec.say('A flow is one card. It says what happens to each of its versions, and gives you the choice: replace the field, remove it and keep the flow running, or delete the versions.', 7500);
        await fix(sel, { flow: true, hold: firstFlow ? 7500 : 4000,
          caption: firstFlow ? 'Replace on a flow. The confirmation states the exact plan: a new active version that uses the new field, then the old versions deleted. It offers a backup zip first, switched off for this recording.'
            : 'The second flow, the same way.' },
          firstFlow ? { text: 'The new version is active, verified by reading the org, and the old versions are gone. The card says which version runs now.', hold: 6000 } : null);
        firstFlow = false;
      }
      if (!fixed) throw new Error('nothing could be fixed — the fixture is not in place');
      // 4. what is left
      if (await c.has('#fcDeleteZone')) {
        await rec.scrollTo('#fcDeleteZone', 'center');
        await rec.say('Nothing uses the old field any more. Now it can be deleted, or deprecated first: hidden and renamed, with a one-click way back.', 6500);
      }
      // 5. the tool's own History, and one undo
      if (await c.has('#fcToolHist summary')) {
        await rec.scrollTo('#fcToolHist', 'center');
        await rec.click('#fcToolHist summary', 900);
        await rec.say('Everything Field Cleaner changed is listed here, under its results: what was written, and what the org showed afterwards.', 6000);
        const undo = '#fcToolHist [data-th-undo]:not([disabled])';
        if (await c.has(undo)) {
          await rec.click(undo, 600);
          await typedConfirm(c, 'UNDO');
          await rec.fast(() => h.waitFor("!!document.querySelector('#fcToolHist .sftk-th-said')", 300000, 800));
          await rec.scrollTo('#fcToolHist .sftk-th-said', 'center');
          await rec.say('A change that has a way back has an Undo. A deleted flow version cannot be re-created, which is why the backup is offered before it goes.', 7000);
        }
      }
      await rec.say('It can also copy the stored values of the old field to the new one, and read every report to find the ones Salesforce’s index does not list.', 6000);
    } },

  { id: 'copy-perms', title: 'Copy Permissions', run: async c => {
    const { h, rec } = c;
    await c.popup('copy-perms');
    await h.waitFor("!!document.querySelector('#ucSourceInput')", 60000, 500);
    await h.sleep(1200);
    await rec.say('Copy Permissions. Give one user what another user has.', 1200);
    const pick = async (P, name) => {
      await rec.type(`#${P}Input`, name, 40);
      await rec.fast(() => h.waitFor(`[...document.querySelectorAll('#${P}List .uc-drop-item')].some(e => !e.classList.contains('uc-drop-loading') && e.innerText.includes(${J(name)}))`, 120000, 500));
      await h.eval(`(() => { const e = [...document.querySelectorAll('#${P}List .uc-drop-item')].find(e => e.innerText.includes(${J(name)})); if (e) e.click(); return !!e; })()`);
      await h.sleep(900);
    };
    await pick('ucSource', 'Test A');
    await pick('ucTarget', 'Test B');
    await rec.fast(() => h.waitFor("!!document.querySelector('.uc-ps-cb, .uc-grp-cb, #ucProfileCb') || /nothing|no permission/i.test(document.querySelector('#ucPreview')?.innerText || '')", 120000, 500));
    await h.sleep(1200);
    await rec.scrollTo('#ucPreview');
    await rec.say('It lists what the first user has: profile, role, permission sets, groups. Tick what to copy.', 6000);
    await rec.point('#ucCopyBtn', 1300);
    await rec.say('It asks once, and reads the user back afterwards to confirm the copy. The copy is in this tool’s History, with its Undo.', 5500);
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
  } },

  { id: 'deploy', title: 'Data Deployment', run: async c => {
    const { h, rec } = c;
    if (!(await c.has('.ds-nav-btn'))) await c.studio('');
    const id = await ensureDemo(c);
    await nav(c, 'profiles');
    await rec.fast(() => h.waitFor("document.querySelectorAll('.ds-profile-card').length > 0", 30000, 500));
    await rec.say('Data Deployment. A deployment is a saved definition: a root object, the objects under it, and how records are recognised in the other org.', 6500);
    await rec.point(`[data-dsaction="runProfile"][data-arg="${id}"]`, 1000);
    await h.eval(`window.runProfile(${J(id)})`);
    await h.sleep(1800);
    await rec.say('This one is Accounts with their Contacts. Opening it goes to the Deploy page. First it reads both orgs. Nothing is written.', 1500);
    await rec.click('#dsDepScan, #dsDepRefresh', 500);
    await waitScanned(c);
    await h.sleep(2500);
    await rec.scrollTo('.ds-dep-plan', 'center');
    await rec.say('The plan: per object, how many records to insert, how many changed, how many exist only in the target, and how many are in sync.', 6500);
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
    await rec.say('One metadata deploy per org: the field, plus a permission set that lets you see it. The table is read again from both orgs.', 6500);
    const stamp = await h.eval(`(() => { const b = [...document.querySelectorAll('[data-id-stamp]')].find(b => /Account/.test(b.closest('tr')?.innerText || '')); return b ? b.innerText.trim() : ''; })()`);
    if (stamp) {
      await rec.point(`[data-id-stamp]`, 800);
      await rec.say(`${stamp.replace('🪪 ', '')} — the Accounts the scan already matched by Name get their source Id written once. From then on they match exactly, whatever their names do.`, 7500);
      await h.eval(`(() => { const b = [...document.querySelectorAll('[data-id-stamp]')].find(b => /Account/.test(b.closest('tr')?.innerText || '')); if (b) b.click(); return true; })()`);
      await rec.fast(() => h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 300));
      await h.sleep(600);
      await rec.say('The one confirmation, as for every write. Each stamped record is re-read afterwards.', 4500);
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
    await rec.say('Read again, the stamped records match by their identity. New records a deployment creates are stamped as they are written — nothing more to do.', 7000);
  } },
  { id: 'run', title: 'Deploy and roll back', writes: true, run: async c => {
    const { h, rec } = c;
    if (!(await h.eval(`typeof _currentView !== 'undefined' && _currentView === 'deploy' && !!document.querySelector('.ds-dep-plan')`))) await openDemoScanned(c);
    await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="ins"]')?.click()`);
    await h.sleep(1200);
    await rec.scrollTo('#dsDepRecords');
    // two fixture accounts the target accepts (one other fixture account is refused there on purpose, by a validation rule)
    const n = await h.eval(`(() => {
      const rows = [...document.querySelectorAll('#dsDepList .ds-dep-row')].filter(r => r.querySelector('input[data-dep-push]'));
      const want = [/Berlin Lab/, /Europe GmbH/, /Americas/];
      const picked = [];
      for (const re of want) { const r = rows.find(x => re.test(x.innerText) && !picked.includes(x)); if (r && picked.length < 2) picked.push(r); }
      for (const r of rows) { if (picked.length >= 2) break; if (!picked.includes(r)) picked.push(r); }
      for (const r of picked) { const cb = r.querySelector('input[data-dep-push]'); if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); } }
      return picked.length; })()`);
    if (!n) throw new Error('no record to insert in the fixture');
    await assertDirection(c);
    await rec.say(`Now a real deployment. ${n === 1 ? 'One record is' : 'Two records are'} ticked to insert into the target org.`, 4000);
    await rec.scrollTo('#dsRecRunBtn', 'center');
    await rec.say('A restore point is taken first, so the run can be rolled back.', 3500);
    const before = await h.eval('_history.length');
    await assertDirection(c);
    await rec.click('#dsRecRunBtn', 1500);
    for (let i = 0; i < 3; i++) {
      if (await c.has('#sftkConfirmGo')) {
        if (i === 0) await rec.say('One confirmation: what will be written, and where.', 3500);
        await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) a.click(); return true; })()`);
        await rec.click('#sftkConfirmGo', 1500);
      } else if (await h.modalText()) {
        await h.eval(`(() => { const b = document.querySelector('#dsRecDelOk') || [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed|deploy|confirm/i.test(b.textContent)); if (b) b.click(); return !!b; })()`);
        await h.sleep(1500);
      } else break;
    }
    await rec.say('The run is shown as it happens: each object, each batch, Salesforce’s answer for every record.', 1000);
    await rec.fast(async () => { const end = Date.now() + 600000; while (Date.now() < end && (await h.eval('_history.length')) <= before) await h.sleep(1000); });
    if ((await h.eval('_history.length')) <= before) throw new Error('the deployment did not finish');
    await rec.pause(2500);
    await rec.fast(async () => { await h.sleep(5000); await h.waitFor("!document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000).catch(() => {}); });
    const last = await h.eval(`(() => { const e = _history[_history.length - 1] || {}; const s = Object.values(e.summary || {}); const sum = k => s.reduce((t, o) => t + (Number(o && o[k]) || 0), 0); return { status: e.status || '', inserted: sum('inserted'), failed: sum('failed') + sum('insertedFailed') }; })()`);
    h.log('deployment result:', J(last));
    await rec.say(last.status === 'success'
      ? 'Done. Afterwards both orgs are read again, so the page shows what is true now, not what was sent.'
      : 'Finished, and not everything was accepted: a record the target refused is reported with Salesforce’s own reason, never counted as done. Both orgs are read again afterwards.', 5500);

    await nav(c, 'history');
    await h.waitFor("!!document.querySelector('.ds-history-card, .ds-history-item')", 20000, 500);
    await rec.say('History keeps every run: what was written, per object, with links to the records.', 5000);
    if (!(await c.has('[data-dsaction="rollbackRun"]:not([disabled])'))) throw new Error('no rollback offered for the run');
    const rbBefore = await h.eval(`_history.filter(x => x.kind === 'rollback').length`);
    await rec.click('[data-dsaction="rollbackRun"]:not([disabled])', 800);
    await rec.say('Roll back opens a page of its own. It reads the org again and compares it with the restore point.', 1000);
    await rec.fast(() => h.waitFor("!!document.querySelector('#dsRbGo') || !!document.querySelector('.ds-rec-card-bad')", 300000, 1000));
    await h.sleep(1500);
    if (!(await c.has('#dsRbGo'))) throw new Error('the rollback could not be prepared');
    await rec.scrollTo('.ds-dep-plan', 'center');
    await rec.say('It names every record it would delete or restore, and what it leaves alone because someone changed it after the run.', 6500);
    await rec.scrollTo('#dsRbGo', 'center');
    await rec.click('#dsRbGo', 800);
    await h.waitFor("!!document.querySelector('#sftkConfirmGo') || !!document.querySelector('#sftkConfirmProdGo')", 20000, 300);
    await rec.say('The confirmation asks for a typed word.', 800);
    await typedConfirm(c, 'ROLLBACK');
    await rec.fast(async () => { const end = Date.now() + 900000; while (Date.now() < end && (await h.eval(`_history.filter(x => x.kind === 'rollback').length`)) <= rbBefore) await h.sleep(1000); await h.sleep(2000); });
    if ((await h.eval(`_history.filter(x => x.kind === 'rollback').length`)) <= rbBefore) throw new Error('the rollback did not finish');
    await rec.scrollTo('#dsRbResult', 'center');
    await rec.say('Rolled back, and verified by reading the org again. The records are in the target’s Recycle Bin.', 5500);
    if (await c.has('#dsRbOpenReport')) {
      await rec.click('#dsRbOpenReport', 1500);
      await rec.say('“Which records” lists every record the rollback touched, by name.', 5000);
    }
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
