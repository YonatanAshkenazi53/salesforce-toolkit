// LIVE, WRITES to npc2 and cleans up after itself (owner 2026-11-13: "we need a feature to apply pii for all selected
// records"). On docs/fixtures/pii-fixture (six Leads): tick every insert → 🎭 Disguise the N selected → one Apply →
// a real run → the target read by CLI holds no source value in a covered field. Then the update path: a real value is
// planted by CLI in a covered field the source holds empty, the record is updated "source wins", and the CLI reads the
// field empty. The Leads this script wrote are deleted at the end (by Company, CLI).
// NOWRITE=1 stops after Apply (no run). PROFILE_FILE / PROFILE pick another deployment for the window alone.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const SHOTS = process.env.LOCALAPPDATA + '/Temp/sftk-headless-shots/';
const NL = String.fromCharCode(10);
const one = s => String(s || '').split(NL).join(' | ');
const cli = (org, soql) => { const t = execSync(`sf data query -o ${org} --json -q "${soql}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); return JSON.parse(t.slice(t.indexOf('{'))).result.records; };
const theme = async (h, dark) => { await h.eval(`(() => { if (!document.getElementById('noTrans')) { const st = document.createElement('style'); st.id = 'noTrans'; st.textContent = '*{transition:none!important}'; document.head.appendChild(st); } document.documentElement.classList.toggle('ds-dark', ${dark}); return true; })()`); await h.sleep(350); };
const shotBoth = async (h, name) => { await theme(h, false); await h.shot(SHOTS + name + '.png'); await theme(h, true); await h.shot(SHOTS + name + '-dark.png'); await theme(h, false); };
const FIELDS = ['FirstName', 'LastName', 'Email', 'Phone', 'MobilePhone', 'Street', 'City', 'SFTK_PII_Card__c', 'SFTK_PII_SSN__c', 'SFTK_PII_IBAN__c', 'SFTK_PII_National_Id__c', 'SFTK_PII_Tax_Id__c', 'SFTK_PII_Passport__c', 'SFTK_PII_Birthdate__c', 'SFTK_PII_Salary__c', 'SFTK_PII_Note__c'];

async function confirmAndWait(h, histBefore) {
  await h.sleep(2000);
  for (let i = 0; i < 3; i++) {
    const m = await h.modalText(600); if (!m) break;
    await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } const b = document.querySelector('#sftkConfirmGo') || [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed|deploy/i.test(b.textContent)); if (b) b.click(); return true; })()`);
    await h.sleep(2000);
  }
  let lastLog = '';
  for (let i = 0; i < 240; i++) {
    const t = await h.eval(`document.querySelector('#dsRecProgress')?.innerText || ''`);
    if (t) lastLog = t;
    if (await h.eval(`_history.length > ${histBefore}`)) break;
    await h.sleep(1000);
  }
  await h.sleep(2000);
  return lastLog;
}

export default async function (h) {
  const FILE = process.env.PROFILE_FILE || 'docs/fixtures/pii-fixture/profiles.json', NAME = process.env.PROFILE || 'SFTK PII — Leads';
  const FIXTURE = NAME === 'SFTK PII — Leads';
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles(FILE);
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('fixture profile missing');
  // the fixture filters by LastName, which the suggestions disguise: FILTER=company reads by a field they leave alone
  if (FIXTURE && process.env.FILTER === 'company') await h.eval(`(() => { const p = _profiles.find(p => p.id === ${JSON.stringify(id)}); p.tree.where = "Company = 'SFTK PII Co'"; return true; })()`);
  if (FIXTURE) h.log('CLI target Leads of the fixture before:', cli('npc2', "SELECT Id FROM Lead WHERE Company = 'SFTK PII Co'").length);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`);
  await h.waitFor("!!document.querySelector('#dsDepPiiSel') && !document.querySelector('#dsDepRefresh')?.disabled && !!document.querySelector('#dsDepTickAll')", 300000, 1000);
  await h.sleep(1000);
  const btn = () => h.eval("(() => { const b = document.querySelector('#dsDepPiiSel'); return b.innerText + (b.disabled ? ' [off]' : ' [on]'); })()");
  h.log('BUTTON, nothing selected:', await btn(), '| policy before:', await h.eval(`JSON.stringify((_profiles.find(p => p.id === ${JSON.stringify(id)}) || {}).piiPolicy || {})`));
  await h.click('#dsDepTickAll'); await h.sleep(800);
  h.log('BUTTON, every insert ticked:', await btn(), '| SUMMARY:', one(await h.text('#dsDepSummary')));
  await h.eval("document.querySelector('.ds-dep-actionbar').scrollIntoView({ block: 'end' })"); await h.sleep(300);
  await shotBoth(h, 'piisel-1-bar');
  // ── 🎭 the window, fed every selected record of every object ──
  await h.click('#dsDepPiiSel');
  await h.waitFor("!!document.querySelector('#dsPiiSugApply')", 180000, 500);
  await h.waitFor("![...document.querySelectorAll('#dsModalBox [data-pii-prev]')].some(c => /^…$/.test(c.textContent.trim()))", 90000, 500).catch(() => {});
  await h.sleep(500);
  h.log('WINDOW HEADER:', one(await h.text('#dsModalBox .ds-modal-header')));
  h.log('WINDOW LEAD:', one(await h.text('#dsModalBox .ds-pii-sug-lead')));
  h.log('OBJECTS:', JSON.stringify(await h.eval("[...document.querySelectorAll('#dsModalBox .ds-pii-sug-obj-hd')].map(e => e.innerText.split(String.fromCharCode(10)).join(' '))")));
  h.log('ROWS:', JSON.stringify(await h.eval("[...document.querySelectorAll('#dsModalBox .ds-pii-sug-row')].map(r => (r.querySelector('[data-pii-key]')?.checked ? '☑ ' : '☐ ') + r.querySelector('[data-pii-key]').dataset.piiKey + ' → ' + r.querySelector('select').selectedOptions[0].textContent.trim())")));
  // KEEP_EMAIL=1: the match field stays as it is, so the next scan recognises what was written (the update check needs it)
  if (process.env.KEEP_EMAIL === '1') await h.eval("(() => { const cb = document.querySelector('#dsModalBox [data-pii-key=\"Lead.Email\"]'); if (cb && cb.checked) cb.click(); return true; })()");
  h.log('APPLY BUTTON:', await h.text('#dsPiiSugApply'));
  await shotBoth(h, 'piisel-2-window');
  await h.click('#dsPiiSugApply');
  await h.waitFor("document.querySelector('#dsModal')?.style.display === 'none'", 20000, 300);
  await h.sleep(3000);
  const policy = JSON.parse(await h.eval(`JSON.stringify((_profiles.find(p => p.id === ${JSON.stringify(id)}) || {}).piiPolicy || {})`));
  const covered = Object.keys(policy).map(k => k.slice(k.indexOf('.') + 1));
  h.log('SAVED POLICY:', covered.length, 'field(s):', covered.join(', '));
  h.log('stored copy carries it:', await h.eval(`new Promise(r => chrome.storage.local.get(null, all => r(JSON.stringify(all).includes(${JSON.stringify(covered[0] || '~none~')}))))`));
  // the selection survives the redraw? if not, tick again — the chip is what is checked here
  if (!(await h.eval("!document.querySelector('#dsRecRunBtn').disabled"))) { await h.click('#dsDepTickAll'); await h.sleep(800); }
  h.log('BUTTON after Apply:', await btn(), '| SUMMARY:', one(await h.text('#dsDepSummary')));
  await h.eval("document.querySelector('.ds-dep-actionbar').scrollIntoView({ block: 'end' })"); await h.sleep(300);
  await shotBoth(h, 'piisel-3-chip');
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 3)')).slice(0, 300));
  if (process.env.NOWRITE === '1' || !FIXTURE) { h.log('no run (NOWRITE or not the fixture)'); return; }

  // ── the real run under the policy ──
  let histBefore = await h.eval('_history.length');
  await h.click('#dsRecRunBtn');
  const log1 = await confirmAndWait(h, histBefore);
  h.log('HISTORY (PII):', await h.eval("(() => { const e = _history[0] || {}; const t = JSON.stringify(e); const out = []; const re = /(🔎|🔒|🎭)[^\"]{0,330}/g; let m; while ((m = re.exec(t)) && out.length < 6) out.push(m[0]); return out.join(' || ') + ' | summary: ' + JSON.stringify(e.summary || {}).slice(0, 500); })()"));
  h.log('RUN LOG (PII lines):', log1.split(NL).map(x => x.trim()).filter(x => /PII|mask|audit|🔎|🎭|🔒/i.test(x)).join(' | ').slice(0, 1800));
  const src = cli('npc', `SELECT Id, ${FIELDS.join(', ')} FROM Lead WHERE LastName LIKE 'SFTK PII%'`);
  const tgt = cli('npc2', `SELECT Id, ${FIELDS.join(', ')} FROM Lead WHERE Company = 'SFTK PII Co'`);
  h.log('CLI: source', src.length, 'Leads · target', tgt.length, 'Leads');
  const leaks = [], open = [];
  for (const f of FIELDS) {
    const real = new Set(src.map(r => r[f]).filter(v => v != null && v !== '').map(String));
    const same = tgt.filter(r => r[f] != null && real.has(String(r[f]))).length;
    if (covered.some(c => c.toLowerCase() === f.toLowerCase())) { if (same) leaks.push(`${f}: ${same} (${JSON.stringify(tgt.filter(r => r[f] != null && real.has(String(r[f]))).map(r => r[f]))})`); } else if (same) open.push(`${f}: ${same}`);
  }
  h.log('COVERED FIELDS HOLDING A SOURCE VALUE IN THE TARGET:', leaks.length ? leaks.join(', ') : 'none');
  h.log('fields NOT under the policy that hold the source value (as they should):', open.join(', ') || 'none');

  // ── the update path: a covered field the source holds empty is written empty ──
  // a covered text field that exactly one source Lead holds empty, and exactly one target Lead too: that one is its twin
  const PF = ['SFTK_PII_Passport__c', 'SFTK_PII_Tax_Id__c', 'SFTK_PII_SSN__c', 'SFTK_PII_Card__c', 'SFTK_PII_IBAN__c'].find(f => covered.includes(f) && src.filter(r => r[f] == null).length === 1 && tgt.filter(r => r[f] == null).length === 1);
  if (!PF) h.log('update check skipped — no covered field that one Lead alone holds empty');
  else {
    const twin = tgt.filter(r => r[PF] == null);
    {
      execSync(`sf data update record -o npc2 -s Lead -i ${twin[0].Id} -v "${PF}='REAL-PLANTED-1'" --json`, { stdio: 'ignore' });
      h.log('planted by CLI in the target:', PF, JSON.stringify(cli('npc2', `SELECT ${PF} FROM Lead WHERE Id = '${twin[0].Id}'`)));
      await h.eval(`navigateToView('deploy')`).catch(() => {}); await h.sleep(500);
      await h.eval(`window.runProfile(${JSON.stringify(id)})`);
      await h.waitFor("!!document.querySelector('#dsDepRescanAll') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000); await h.sleep(800);
      await h.click('#dsDepRescanAll');
      await h.sleep(3000);
      await h.waitFor("!document.querySelector('#dsDepRefresh')?.disabled && !!document.querySelector('[data-dep-obj=\"\"][data-dep-tab=\"chg\"]')", 300000, 1000); await h.sleep(1500);
      h.log('PLAN ROW after rescan:', one(await h.eval("document.querySelector('.ds-dep-plan tbody tr')?.innerText || ''")));
      h.log('SCAN SAYS:', await h.eval("(document.body.innerText.split(String.fromCharCode(10)).find(l => /PII policy disguises/.test(l)) || 'no line about the policy').slice(0, 700)"));
      await h.eval("(() => { const e = [...document.querySelectorAll('*')].reverse().find(x => x.children.length === 0 && /PII policy disguises/.test(x.textContent)); if (e) e.scrollIntoView({ block: 'center' }); return !!e; })()"); await h.sleep(300);
      await shotBoth(h, 'piisel-4-rescan');
      if (process.env.KEEP_EMAIL !== '1') { h.log('the match field is disguised — no second run (it would insert the six again)'); } else {
      await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="chg"]')?.click()`); await h.sleep(1000);
      await h.eval(`(() => { const b = [...document.querySelectorAll('[data-dep-bulk="all"]')].find(x => x.offsetParent && !x.disabled); if (b) b.click(); return !!b; })()`); await h.sleep(600);
      h.log('SUMMARY (update):', one(await h.text('#dsDepSummary')), '|', await btn());
      if (await h.eval("document.querySelector('#dsRecRunBtn').disabled")) h.log('nothing selected for the update — check skipped');
      else {
        histBefore = await h.eval('_history.length');
        await h.click('#dsRecRunBtn');
        const log2 = await confirmAndWait(h, histBefore);
        h.log('UPDATE LOG (PII lines):', log2.split(NL).map(x => x.trim()).filter(x => /PII|mask|🔒|empty/i.test(x)).join(' | ').slice(0, 900));
        h.log('CLI: the planted field now:', JSON.stringify(cli('npc2', `SELECT ${PF} FROM Lead WHERE Id = '${twin[0].Id}'`)));
      }
      }
    }
  }
  // ── clean up what this script wrote ──
  const mine = cli('npc2', "SELECT Id FROM Lead WHERE Company = 'SFTK PII Co'");
  if (mine.length) {
    const f = process.env.LOCALAPPDATA + '/Temp/sftk-pii-selected-cleanup.apex';
    writeFileSync(f, "delete [SELECT Id FROM Lead WHERE Company = 'SFTK PII Co'];");
    execSync(`sf apex run -o npc2 -f "${f}" --json`, { stdio: 'ignore' });
  }
  h.log('CLI target Leads of the fixture after cleanup:', cli('npc2', "SELECT Id FROM Lead WHERE Company = 'SFTK PII Co'").length);
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 3)')).slice(0, 300));
}
