// LIVE, WRITES to npc2 (and rolls back): the packaged-object proof of Data Deployment (user 2026-11-08: "גם דיפלוי
// של דאטה צריך לתמוך באובייקטים חבילתיים" and "צריך ליצור אובייקט חבילתי… ולבדוק"). The DLRS test objects
// dlrs__LookupParent__c → dlrs__LookupChild__c, the fixture records of npc (3 parents, 6 children, two of them red):
//   1. the deployment scanned, every insert ticked; the ⏸ panel with validation rules on — the target's stricter
//      rule SFTK_Pkg_Red_Needs_Tag ("no red child") listed under the packaged object
//   2. ▸ record on one red child: the Owner row offers npc2's queue "SFTK Test Queue" (it takes the packaged
//      object) — picked for every child (the many-records editor)
//   3. ▶ Deploy with the rule paused → the CLI counts the records in npc2 and reads the children's OwnerId (the
//      queue); the rule is back on
//   4. ROLLBACK (default on): the run's rollback from History → the CLI counts 0
//   DARK=1 shoots the panel and the editor in dark too. SCAN_ONLY=1 stops before Deploy.
import { execSync } from 'node:child_process';
import retryAndRollback from './retry-and-rollback.mjs';
const NL = String.fromCharCode(10);
const dump = async (h, sel, n = 1500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 400000, 1000);
const dark = async (h, on) => { await h.eval(`(() => { if (!document.getElementById('noTrans')) { const st = document.createElement('style'); st.id = 'noTrans'; st.textContent = '*{transition:none!important}'; document.head.appendChild(st); } document.documentElement.classList.toggle('ds-dark', ${on ? 'true' : 'false'}); return true; })()`); await h.sleep(250); };
const shot = async (h, name) => { await h.shot(`${h.shots}/${name}.png`); if (process.env.DARK === '1') { await dark(h, true); await h.shot(`${h.shots}/${name}-dark.png`); await dark(h, false); } };
const cli = (q, org = 'npc2') => { try { return JSON.parse(execSync(`sf data query -o ${org} --json -q "${q}"`, { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] })).result.records; } catch (e) { return [{ error: String(e.stdout || e.message).slice(0, 200) }]; } };
const state = h => {
  const p = cli("SELECT COUNT() FROM dlrs__LookupParent__c WHERE Name LIKE 'SFTK Pkg Parent%'");
  const c = cli("SELECT Name, dlrs__Color__c, OwnerId, Owner.Name FROM dlrs__LookupChild__c WHERE Name LIKE 'SFTK Pkg Child%' ORDER BY Name");
  const vr = cli("SELECT Active FROM ValidationRule WHERE ValidationName = 'SFTK_Pkg_Red_Needs_Tag' AND EntityDefinition.QualifiedApiName = 'dlrs__LookupChild__c'".replace(/"/g, '\\"'), 'npc2 --use-tooling-api');
  h.log('npc2 — parents:', JSON.stringify(p && p[0] && p[0].expr0 != null ? p[0].expr0 : p), '| children:', JSON.stringify((c || []).map(x => `${x.Name} ${x.dlrs__Color__c} → ${x.Owner ? x.Owner.Name : x.OwnerId}`)), '| VR active:', JSON.stringify(vr && vr[0] ? vr[0].Active : vr));
};
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/packaged-object-fixture/profiles.json');
  const id = await h.eval(`_profiles.find(p => p.name === 'SFTK Pkg — Lookup tree (DLRS)')?.id`);
  if (!id) throw new Error('fixture profile missing');
  state(h);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await waitScanned(h); await h.sleep(2000);
  h.log('PLAN:', await dump(h, '.ds-dep-plan', 900));
  // every insert of both objects
  const objs = await h.eval(`[...document.querySelectorAll('[data-dep-obj]')].map(b => b.dataset.depObj).filter((v, i, a) => v !== undefined && a.indexOf(v) === i)`);
  for (const o of objs) {
    await h.eval(`(() => { const b = document.querySelector('[data-dep-obj="${o}"][data-dep-tab="ins"]'); if (b) b.click(); })()`); await h.sleep(500);
    await h.eval(`(() => { const b = document.querySelector('[data-dep-bulk="all"]'); if (b && !b.disabled) b.click(); return true; })()`); await h.sleep(400);
  }
  h.log('SUMMARY:', await dump(h, '#dsDepSummary', 300));
  // ⏸ validation rules on → the packaged object's rule in the panel
  await h.eval(`(() => { const b = document.querySelector('#dsDepRulePause'); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await h.waitFor("(() => { const t = document.querySelector('#dsDepPausePanel')?.innerText || ''; return t.length > 20 && !/⏳/.test(t); })()", 90000, 500); await h.sleep(500);
  h.log('PANEL:', await dump(h, '#dsDepPausePanel', 900));
  await h.eval(`document.querySelector('#dsDepPausePanel')?.scrollIntoView({ block: 'center' })`); await h.sleep(300);
  await shot(h, 'pkg-1-panel');
  // ▸ record on the children (the many-records editor) → the Owner row → the queue
  await h.eval(`(() => { const b = document.querySelector('[data-dep-obj="dlrs__LookupChild__c"][data-dep-tab="ins"]'); if (b) b.click(); })()`); await h.sleep(800);
  const many = await h.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Set one value on the \\d+ selected/.test(x.textContent) && !x.disabled); if (!b) return null; b.click(); return b.textContent.trim(); })()`);
  h.log('many-records editor opened:', many);
  await h.waitFor("!!document.querySelector('#dsValEdHost tr[data-ve-row=\"OwnerId\"]')", 60000, 500); await h.sleep(600);
  h.log('Owner row:', await h.eval(`(() => { const tr = document.querySelector('#dsValEdHost tr[data-ve-row="OwnerId"]'); return tr ? tr.innerText.replace(/\\s+/g, ' ').slice(0, 300) : null; })()`));
  await h.eval(`(() => { const i = document.querySelector('#dsValEdHost .ds-ve-own-in'); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor("[...document.querySelectorAll('#dsValEdHost .ds-ve-own-res [data-ve-own-hit]')].some(x => /👥/.test(x.textContent))", 60000, 400); await h.sleep(300);
  h.log('owner results:', JSON.stringify(await h.eval(`[...document.querySelectorAll('#dsValEdHost .ds-ve-own-res > *')].map(x => x.innerText.replace(/\\s+/g, ' ')).slice(0, 8)`)));
  await shot(h, 'pkg-2-owner-search');
  const q = await h.eval(`(() => { const b = [...document.querySelectorAll('#dsValEdHost .ds-ve-own-res [data-ve-own-hit]')].find(x => /👥/.test(x.textContent)); if (!b) return null; b.click(); return b.dataset.veOwnName; })()`);
  await h.sleep(900);
  h.log('queue picked:', q, '| row:', await h.eval(`(document.querySelector('#dsValEdHost tr[data-ve-row="OwnerId"] .ds-ve-lkp-cur')?.innerText || '').replace(/\\s+/g, ' ')`));
  await shot(h, 'pkg-3-owner-queue');
  const save = await h.eval(`(() => { const b = document.getElementById('dsVeSave'); if (b) { b.click(); return 'saved'; } const c = document.querySelector('[data-dsaction="closeModal"]'); if (c) { c.click(); return 'closed'; } return 'no button'; })()`);
  h.log('editor:', save); await h.sleep(1200);
  if (process.env.SCAN_ONLY === '1') { h.log('SCAN_ONLY — stopping before Deploy'); return; }
  // ▶ Deploy
  const histBefore = await h.eval('_history.length');
  await h.click('#dsRecRunBtn'); await h.sleep(2500);
  for (let i = 0; i < 4; i++) {
    const m = await h.modalText(1500); if (!m) break;
    h.log('CONFIRM:', m.slice(0, 1800));
    if (i === 0) await shot(h, 'pkg-4-confirm');
    await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } const b = document.querySelector('#sftkConfirmGo'); if (b) b.click(); return true; })()`);
    await h.sleep(2000);
  }
  let lastLog = '';
  for (let i = 0; i < 300; i++) {
    const t = await h.eval(`document.querySelector('#dsRecProgress')?.innerText || ''`); if (t) lastLog = t;
    if (await h.eval(`_history.slice(${histBefore}).some(x => x.kind !== 'tool')`)) break;
    await h.sleep(1000);
  }
  await h.waitFor("/rule\\(s\\) back on|could NOT be switched back/.test([...document.querySelectorAll('.ds-toast')].map(t => t.innerText).join(' ') + (document.querySelector('#dsRecProgress')?.innerText || ''))", 120000, 500).catch(() => {});
  await h.sleep(1500);
  h.log('RUN LOG:', lastLog.split(NL).filter(x => /⏸|▶|rule|Insert|✅|❌|owner|Owner/i.test(x)).join(' | ').slice(0, 2000));
  h.log('HISTORY (newest):', JSON.stringify(await h.eval(`(() => { const x = _history[_history.length - 1]; return x && { kind: x.kind, name: x.profileName, status: x.status, what: (x.what || []).map(w => w.text).slice(0, 10) }; })()`)));
  await shot(h, 'pkg-5-after');
  state(h);
  if (process.env.ROLLBACK === '0') return;
  // the run's rollback — the same History → ↩ Roll back walk the other live scripts use (same session: the
  // History entry lives in this browser profile)
  process.env.SKIP_RUN = '1'; process.env.PROFILE = 'SFTK Pkg — Lookup tree (DLRS)';
  await retryAndRollback(h);
  h.log('──────── rolled back ────────');
  state(h);
}
