// The sections of the walkthrough (walkthrough.mjs runs them in this order).
// Each: { id, title (the chapter), needsTarget?, writes?, run(ctx) }.
// ctx = { h, rec, text, has, popup(tab), studio(hash), home() }.
//
// Rule for every section: it only READS, except `run` (flagged writes: true),
// which deploys two fixture records into trailheads4 and rolls them back —
// the org ends as it started, and the section can be left out with WRITES=0.
// A confirmation opened to show it is CANCELLED, never confirmed.
const J = JSON.stringify;
const FIXTURE = 'docs/fixtures/complex-deployment/profiles.json';
const DEPLOYMENT = 'SFTK CX — Accounts tree';
const OLD_FIELD = 'SFTK_FC_Test_Status__c', NEW_FIELD = 'SFTK_FC_Test_Status2__c';

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
const cancelDialog = async ({ h }) => { await h.eval(`(() => { const c = document.querySelector('#sftkConfirmCancel') || [...document.querySelectorAll('#modalBox button, #dsModalBox button')].find(b => /cancel/i.test(b.textContent)); if (c) c.click(); return !!c; })()`); await h.sleep(700); };
const nav = async ({ h, rec }, view) => { await rec.click(`.ds-nav-btn[data-view="${view}"]`, 1200); };
const waitScanned = ({ h, rec }) => rec.fast(() => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 600000, 1000));

export const SECTIONS = [
  // ───────────────────────────── the Toolkit ─────────────────────────────
  { id: 'home', title: 'Admin Toolkit', run: async c => {
    const { h, rec } = c;
    await c.home();
    await rec.say('Admin Toolkit for Salesforce. It runs in your browser and uses the Salesforce session you already have open. It talks to your Salesforce org and to nothing else.', 5500);
    await rec.say('It has two parts. The Toolkit works on one org: flows, pages, fields, permissions. Data Studio moves records between orgs.', 5500);
    await rec.point('.home-card[data-fid="flows"]', 900);
    await rec.point('.home-card[data-fid="fields"]', 900);
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
      await rec.type('#depRefSearch', OLD_FIELD, 22);
      await rec.click('#depRefGo', 800);
      await rec.fast(() => h.waitFor("!!document.querySelector('#depRefResults')?.innerText", 60000, 500).catch(() => {}));
      if (await c.has('#depRefRescan')) {
        // the flow list came from the stored cache: the page says the search read nothing yet, and offers to read it all
        await rec.say('The search says how much it actually read. Here the list came from a stored cache, so it offers to read every flow first.', 4500);
        await rec.click('#depRefRescan', 800);
        await rec.fast(async () => { await h.sleep(3000); await h.waitFor("!!document.querySelector('#depRescanBtn') && !document.querySelector('#depRescanBtn').disabled && document.querySelectorAll('.dep-node').length > 0", 300000, 1000); await h.sleep(1500); });
        await h.eval(`(() => { const i = document.querySelector('#depRefSearch'); i.value = ${J(OLD_FIELD)}; document.querySelector('#depRefGo').click(); return true; })()`);
        await rec.fast(() => h.waitFor("!!document.querySelector('#depRefResults')?.innerText", 60000, 500).catch(() => {}));
      }
      await rec.scrollTo('#depRefResults', 'center');
      await rec.say('“What uses this?” Type a field or a component and see every flow that mentions it.', 5000);
    }
    if (await c.has('#depBulkBtn')) {
      await rec.click('#depBulkBtn', 1200);
      await rec.fast(() => h.waitFor("document.querySelectorAll('.dep-fb-cb').length > 0 || /could not|no flows|nothing/i.test(document.querySelector('#depFbBody, #depToolPanel')?.innerText || '')", 300000, 1500).catch(() => {}));
      await rec.say('Flow switches. Switch many flows off before a data load and back on afterwards. Each way asks you to type a word first, and every switch is checked against the org.', 6500);
    }
    if (await c.has('#depApiVerBtn')) {
      await rec.click('#depApiVerBtn', 1200);
      await rec.fast(() => h.waitFor("document.querySelectorAll('.dep-av-pick').length > 0 || /could not|no flows|nothing/i.test(document.querySelector('#depAvOut')?.innerText || '')", 300000, 1500).catch(() => {}));
      await rec.say('API versions. See which flows run on an old API version and move them to a newer one.', 5000);
    }
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
    const opened = await h.eval(`(() => { const r = [...document.querySelectorAll('.lp-row')].find(x => /SFTK[ _]LP/i.test(x.querySelector('.lp-row-name')?.textContent || '')) || document.querySelector('.lp-row'); if (!r) return false; r.setAttribute('data-demo-row', '1'); return true; })()`);
    if (!opened) throw new Error('no Lightning page row to open');
    await rec.click('.lp-row[data-demo-row="1"]', 800);
    await rec.fast(() => h.waitFor("!!document.querySelector('#lpDetailBody .lp-status-bar')", 180000, 1000));
    await rec.say('A page’s assignments, read from Salesforce each time: the org default, an app default, or an app with a record type and a profile.', 6000);
    if (await c.has('.lp-users-btn')) {
      await rec.click('.lp-users-btn', 800);
      await rec.fast(() => h.sleep(4000));
      await rec.say('“Show affected users” lists who actually gets this page.', 4000);
    }
    await rec.say('Assign, remove, deactivate or clone a page from here. Every change is confirmed once and then checked against the org.', 5500);
  } },

  { id: 'fields', title: 'Field Cleaner', run: async c => {
    const { h, rec } = c;
    await c.popup('fields');
    await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
    await rec.say('Field Cleaner. Before you delete a field, see everything that still uses it.', 1200);
    await fcPick(c, '#fcObjInput', '#fcObjDrop', 'Account');
    await fcPick(c, '#fcFieldInput', '#fcFieldDrop', OLD_FIELD);
    await rec.fast(() => h.waitFor("!document.querySelector('#fcReplInput')?.disabled || !!document.querySelector('#fcReplNote .fc-repl-bad')", 60000, 500));
    await rec.say('Optional: pick a replacement field of the same type. Then every reference can be moved to it instead of removed.', 1500);
    if (!(await h.eval(`!!document.querySelector('#fcReplInput')?.disabled`))) await fcPick(c, '#fcReplInput', '#fcReplDrop', NEW_FIELD);
    await rec.click('#fcScanBtn', 800);
    await rec.fast(() => h.waitFor("/reference|Nothing references|No references|found|dependenc/i.test(document.querySelector('#fcResults')?.innerText || '') && !/scanning|⏳/i.test(document.querySelector('#fcScanBtn')?.innerText || '')", 240000, 1000));
    await h.sleep(3000);
    await rec.scrollTo('#fcResults');
    await rec.say('The result: every layout, flow, Lightning page and report that mentions the field, and whether the field still holds data.', 6000);
    if (await c.has('.fc-flow-card')) {
      await rec.scrollTo('.fc-flow-card', 'center');
      await rec.say('A flow is one card. It says what happens to each version, and you choose: replace the field, remove it and keep the flow running, or delete the versions.', 7000);
      const btn = (await c.has('.fc-flow-card .fc-fix-btn[data-swap="1"]')) ? '.fc-flow-card .fc-fix-btn[data-swap="1"]' : '.fc-flow-card .fc-fix-btn';
      if (await c.has(btn)) {
        await rec.click(btn, 500);
        await rec.fast(() => h.waitFor("!!document.querySelector('#sftkConfirmGo') || !!document.querySelector('.fc-item-err')", 90000, 500).catch(() => {}));
        if (await c.has('#sftkConfirmGo')) {
          await rec.say('One confirmation states the exact plan: which version is deployed, which are deleted, and a backup of the old versions.', 6500);
          await rec.click('#sftkConfirmCancel', 600);
          await rec.say('Cancelled here, so nothing changed.', 2500);
        }
      }
    } else if (await c.has('.fc-fix-btn')) {
      await rec.point('.fc-fix-btn', 1200);
      await rec.say('Each item has its own button. Nothing changes until you confirm.', 4000);
    }
    await rec.scrollBy(null, 500);
    await rec.say('It can also copy the old field’s access and stored values to the new field, and read every report to find the ones Salesforce’s index does not list.', 6500);
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
    await rec.say('It asks once, and reads the user back afterwards to confirm the copy.', 4500);
  } },

  { id: 'flow-access', title: 'Flow Access', run: async c => {
    const { h, rec } = c;
    await c.popup('flow-access');
    await rec.say('Flow Access. Who is allowed to run which flow.');
    await rec.fast(() => h.waitFor("document.querySelectorAll('.fp-flow-cb').length > 0 && document.querySelectorAll('.fp-ps-cb').length > 0", 240000, 1000));
    await h.sleep(800);
    await rec.type('#fpFlowSearch', 'SFTK', 60);
    await h.sleep(700);
    const tick = cls => h.eval(`(() => { const cb = [...document.querySelectorAll('.${cls}')].find(x => x.offsetParent && !x.checked); if (!cb) return false; cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await rec.point('.fp-flow-cb', 700); await tick('fp-flow-cb');
    await rec.type('#fpPsSearch', 'SFTK', 60);
    await h.sleep(700);
    await rec.point('.fp-ps-cb', 700); await tick('fp-ps-cb');
    await h.sleep(800);
    await rec.say('Pick flows on the left and profiles or permission sets on the right. The summary says what will be granted.', 5500);
    if (await c.has('#fpAssignBtn')) await rec.point('#fpAssignBtn', 1300);
    await rec.say('Granting is one confirmed change, and it is read back from the org.', 4000);
  } },

  // ───────────────────────────── Data Studio ─────────────────────────────
  { id: 'orgs', title: 'Data Studio — Connected Orgs', needsTarget: true, run: async c => {
    const { h, rec } = c;
    await c.studio('');
    await rec.say('Data Studio opens in its own tab. It works with every Salesforce org you have open in this browser.', 4500);
    await nav(c, 'orgs');
    await rec.fast(() => h.waitFor("document.querySelectorAll('.ds-org-row').length > 0", 30000, 500).catch(() => {}));
    await rec.point('.ds-org-row', 1200);
    await rec.say('Connected Orgs. Give an org a label, lock it against writes, or guard it like production: then every write asks you to type the org’s name.', 7000);
  } },

  { id: 'deploy', title: 'Data Deployment', needsTarget: true, run: async c => {
    const { h, rec } = c;
    if (!(await c.has('.ds-nav-btn'))) await c.studio('');
    await h.importProfiles(FIXTURE);
    await nav(c, 'profiles');
    await rec.fast(() => h.waitFor("document.querySelectorAll('.ds-profile-card').length > 0", 30000, 500));
    await rec.say('Data Deployment. A deployment is a saved definition: a root object, the objects under it, and how records are recognised in the other org.', 6500);
    const id = await h.eval(`_profiles.find(p => p.name === ${J(DEPLOYMENT)})?.id`);
    if (!id) throw new Error('fixture deployment missing');
    await rec.point(`[data-dsaction="runProfile"][data-arg="${id}"]`, 1000);
    await h.eval(`window.runProfile(${J(id)})`);
    await h.sleep(1800);
    await rec.say('Opening one goes to the Deploy page. First it reads both orgs. Nothing is written.', 1500);
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
  } },

  { id: 'run', title: 'Deploy and roll back', needsTarget: true, writes: true, run: async c => {
    const { h, rec } = c;
    if (!(await h.eval(`typeof _currentView !== 'undefined' && _currentView === 'deploy' && !!document.querySelector('.ds-dep-plan')`))) {
      if (!(await c.has('.ds-nav-btn'))) await c.studio('');
      await h.importProfiles(FIXTURE);
      const id = await h.eval(`_profiles.find(p => p.name === ${J(DEPLOYMENT)})?.id`);
      await h.eval(`window.runProfile(${J(id)})`); await h.sleep(1500);
      await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
      await waitScanned(c); await h.sleep(2000);
    }
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
    await rec.say(`Now a real deployment. ${n === 1 ? 'One record is' : 'Two records are'} ticked to insert into the target org.`, 4000);
    await rec.scrollTo('#dsRecRunBtn', 'center');
    await rec.say('A restore point is taken first, so the run can be rolled back.', 3500);
    const before = await h.eval('_history.length');
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
    h.log('deployment result:', JSON.stringify(last));
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
    await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) a.click(); return true; })()`);
    await rec.say('The confirmation asks for a typed word.', 800);
    if (await c.has('#sftkConfirmWord')) await rec.type('#sftkConfirmWord', 'ROLLBACK', 90);
    await rec.click('#sftkConfirmGo', 800);
    if (await c.has('#sftkConfirmProd')) {
      await h.eval(`(() => { const i = document.querySelector('#sftkConfirmProd'); i.value = i.placeholder; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await h.eval(`document.querySelector('#sftkConfirmProdGo')?.click()`);
    }
    await rec.fast(async () => { const end = Date.now() + 900000; while (Date.now() < end && (await h.eval(`_history.filter(x => x.kind === 'rollback').length`)) <= rbBefore) await h.sleep(1000); await h.sleep(2000); });
    if ((await h.eval(`_history.filter(x => x.kind === 'rollback').length`)) <= rbBefore) throw new Error('the rollback did not finish');
    await rec.scrollTo('#dsRbResult', 'center');
    await rec.say('Rolled back, and verified by reading the org again. The records are in the target’s Recycle Bin.', 5500);
    if (await c.has('#dsRbOpenReport')) {
      await rec.click('#dsRbOpenReport', 1500);
      await rec.say('“Which records” lists every record the rollback touched, by name.', 5000);
    }
  } },

  { id: 'ring', title: 'All open orgs', needsTarget: true, run: async c => {
    const { h, rec } = c;
    if (!(await c.has('.ds-nav-btn'))) { await c.studio(''); await h.importProfiles(FIXTURE); }
    await nav(c, 'ring');
    await h.waitFor("!!document.querySelector('#dsRingBody')", 60000, 500);
    await rec.fast(() => h.waitFor("!!document.querySelector('[data-ring-cell]')", 60000, 1000).catch(() => {}));
    await rec.say('All open orgs. Every deployment against every other org you have open: how far each target is from the source.', 5500);
    if (await c.has('[data-ring-scan1]:not([disabled])')) {
      await rec.click('[data-ring-scan1]:not([disabled])', 600);
      await rec.fast(async () => { await h.sleep(2500); await h.waitFor("![...document.querySelectorAll('[data-ring-cell]')].some(x => /⏳/.test(x.innerText)) && ![...document.querySelectorAll('[data-ring-scan1]')].some(b => /⏳/.test(b.textContent))", 600000, 2000).catch(() => {}); });
      await rec.say('A scan compares one deployment with one target and fills in the counts: missing, changed, only in the target. Nothing is changed.', 6000);
    }
    if (await c.has('[data-ring-scantgt]')) await rec.point('[data-ring-scantgt]', 1300);
  } },

  { id: 'history', title: 'History', needsTarget: true, run: async c => {
    const { h, rec } = c;
    if (!(await c.has('.ds-nav-btn'))) await c.studio('');
    await nav(c, 'history');
    await h.sleep(1500);
    await rec.say('History. Every deployment and every rollback, with what was written and what the org said afterwards.', 5500);
    if (await c.has('.ds-history-card')) { await rec.point('.ds-history-card', 1200); await rec.scrollBy(null, 400); }
    await rec.say('A change made by a Toolkit tool is listed in that tool, with its own Undo. All of it stays on this computer, and you can export it.', 6000);
  } },

  { id: 'compare', title: 'Org Compare', needsTarget: true, run: async c => {
    const { h, rec } = c;
    if (!(await c.has('.ds-nav-btn'))) await c.studio('');
    await nav(c, 'compare');
    await h.waitFor("!!document.querySelector('#dsOCSrc')", 60000, 500);
    await rec.say('Org Compare. Pick two orgs and any objects, and count the difference.', 1500);
    const setOrg = (sel, part) => h.eval(`(() => { const s = document.querySelector(${J(sel)}); const o = [...s.options].find(o => o.value.includes(${J(part)})); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await rec.point('#dsOCSrc', 600); await setOrg('#dsOCSrc', 'trailheads5'); await h.sleep(600);
    await rec.point('#dsOCTgt', 600); await setOrg('#dsOCTgt', 'trailheads4'); await h.sleep(600);
    await rec.fast(() => h.waitFor("document.querySelectorAll('[data-oc-obj]').length > 5", 180000, 1000));
    if (await c.has('#dsOCSelNone')) await h.eval(`document.querySelector('#dsOCSelNone').click()`);
    for (const o of ['Account', 'Contact', 'Opportunity', 'Case']) {
      if (!(await c.has(`[data-oc-obj="${o}"]`))) continue;
      await rec.point(`[data-oc-obj="${o}"]`, 450);
      await h.eval(`(() => { const cb = document.querySelector('[data-oc-obj="${o}"]'); if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
    }
    await rec.click('#dsOCRun', 800);
    await rec.fast(() => h.waitFor("document.querySelectorAll('.ds-oc-table tbody tr').length > 0 && !/comparing/.test(document.querySelector('#dsOCResults')?.innerText || '')", 600000, 2000));
    await h.sleep(800);
    await rec.scrollTo('#dsOCResults');
    await rec.say('Per object: how many records are in both orgs, missing from the target, or only in the target. Read-only.', 6000);
  } },

  { id: 'orghealth', title: 'Org health', needsTarget: true, run: async c => {
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

  { id: 'outro', title: 'Licence and privacy', needsTarget: true, run: async c => {
    const { h, rec } = c;
    if (!(await c.has('.ds-nav-btn'))) await c.studio('');
    if (await c.has('#sftkTermsBtn')) {
      await rec.click('#sftkTermsBtn', 1200);
      await rec.say('The licence agreement and the privacy notes are one click away, in the Toolkit and in Data Studio.', 5000);
      await h.eval(`document.querySelector('#sftkTermsViewClose')?.click()`);
      await h.sleep(600);
    }
    await rec.say('Admin Toolkit for Salesforce. It reads before it writes, asks once, and checks the org afterwards.', 5500);
  } },
];
