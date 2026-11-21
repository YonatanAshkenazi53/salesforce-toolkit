// LIVE (npc → npc2, the Accounts-tree fixture). Nothing is kept in an org: the one fixture Individual of each org is
// given a first name by CLI for the run and put back; the dry run is Salesforce's own rolled-back write.
// backlog 2026-11-08: "A composite key for a parent OUTSIDE the deployment … harness: Individual matched by
// LastName + FirstName, a dry run links the Contacts by it".
//   1. the parent row's ✏ → Composite → Last Name + First Name → 🧪 Test this key → Use → both orgs read again →
//      the row says "matched by LastName + FirstName"
//   2. the saved lookup resolution carries matchFields
//   3. 🧪 Dry run of the Contacts to insert: the engine's lookup line names the key and how many resolved
//   4. the target's Individual gets ANOTHER first name by CLI → the same dry run resolves none (the key is whole)
// DARK=1 shoots the dialog in dark too.
import { execSync } from 'node:child_process';
const NL = String.fromCharCode(10);
const dump = async (h, sel, n = 1500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 400000, 1000);
const dark = async (h, on) => { await h.eval(`(() => { if (!document.getElementById('noTrans')) { const st = document.createElement('style'); st.id = 'noTrans'; st.textContent = '*{transition:none!important}'; document.head.appendChild(st); } document.documentElement.classList.toggle('ds-dark', ${on}); return true; })()`); await h.sleep(500); };
const q = (org, soql) => { const t = execSync(`sf data query -o ${org} --json -q "${soql}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); return JSON.parse(t.slice(t.indexOf('{'))).result.records; };
const setFirst = (org, id, v) => execSync(`sf data update record -o ${org} -s Individual -i ${id} -v "FirstName=${v == null ? '' : `'${v}'`}" --json`, { stdio: 'ignore' });
const IND = "SELECT Id, FirstName, LastName FROM Individual WHERE LastName = 'SFTK CX Individual'";

export default async function (h) {
  const s0 = q('npc', IND), t0 = q('npc2', IND);
  if (s0.length !== 1 || t0.length !== 1) throw new Error(`the fixture needs exactly one "SFTK CX Individual" in each org (npc ${s0.length}, npc2 ${t0.length})`);
  h.log('Individual before — npc:', JSON.stringify(s0[0].FirstName), '· npc2:', JSON.stringify(t0[0].FirstName));
  const restore = () => { try { setFirst('npc', s0[0].Id, s0[0].FirstName); setFirst('npc2', t0[0].Id, t0[0].FirstName); } catch (e) { h.log('RESTORE FAILED:', e.message.split(NL)[0]); } };
  try {
    setFirst('npc', s0[0].Id, 'Dana'); setFirst('npc2', t0[0].Id, 'Dana');
    await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
    await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
    const id = await h.eval(`_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id`);
    if (!id) throw new Error('fixture profile missing');
    await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
    await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
    await waitScanned(h); await h.sleep(2000);
    await h.waitFor("!!document.querySelector('[data-dep-pmatch-edit=\"Individual\"]')", 240000, 1000);
    const row = () => h.eval(`(document.querySelector('[data-dep-pmatch-edit="Individual"]')?.parentElement?.innerText || '').replace(/\\s+/g, ' ').slice(0, 220)`);
    h.log('parent row before:', await row());
    // 1. the dialog
    await h.eval(`(() => { const b = document.querySelector('[data-dep-pmatch-edit="Individual"]'); b.closest('details') && (b.closest('details').open = true); b.click(); return true; })()`);
    await h.waitFor("!!document.querySelector('input[name=\"dsPmStrat\"][value=\"composite\"]')", 60000, 300);
    h.log('Composite offered:', await h.eval(`!document.querySelector('input[name="dsPmStrat"][value="composite"]').disabled`));
    await h.eval(`(() => { const r = document.querySelector('input[name="dsPmStrat"][value="composite"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await h.sleep(400);
    const pickSel = async (sel, v) => h.eval(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); if (!s || ![...s.options].some(o => o.value === ${JSON.stringify(v)})) return false; s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    h.log('first field LastName:', await pickSel('#dsDepPmatchSel', 'LastName')); await h.sleep(300);
    // "Use this key" with one field under Composite is refused
    await h.eval(`document.querySelector('#dsDepPmatchGo').click()`); await h.sleep(600);
    h.log('one field under Composite → dialog still open:', await h.eval(`!!document.querySelector('#dsDepPmatchGo')`), '·', (await h.eval(`[...document.querySelectorAll('.ds-toast, .toast, [class*="toast"]')].map(e => e.innerText.trim()).filter(Boolean).pop() || ''`)).replace(/\s+/g, ' ').slice(0, 120));
    h.log('second field FirstName:', await pickSel('[data-pm-more="0"]', 'FirstName')); await h.sleep(400);
    h.log('target line:', await h.text('#dsPmTgt'), '· a third select offered:', await h.eval(`!!document.querySelector('[data-pm-more="1"]')`));
    await h.eval(`document.querySelector('#dsPmTest').click()`);
    await h.waitFor("!/testing/.test(document.querySelector('#dsPmTest')?.textContent || '') && (document.querySelector('#dsPmOut')?.innerText || '').length > 20", 240000, 800);
    h.log('🧪 test this key:', await dump(h, '#dsPmOut', 500));
    await h.shot(h.shots + '/pc-1-dialog.png');
    if (process.env.DARK === '1') { await dark(h, true); await h.shot(h.shots + '/pc-1-dialog-dark.png'); await dark(h, false); }
    await h.eval(`document.querySelector('#dsDepPmatchGo').click()`);
    await h.waitFor("!!document.querySelector('#dsDepRefresh')?.disabled", 30000, 200).catch(() => h.log('the re-read was not seen starting'));
    await waitScanned(h); await h.sleep(2500);
    await h.waitFor("!!document.querySelector('[data-dep-pmatch-edit=\"Individual\"]')", 240000, 1000);
    await h.sleep(4000);
    h.log('parent row after:', await row());
    // 2. what was saved
    h.log('saved resolution:', await h.eval(`JSON.stringify((function f(n) { for (const [k, v] of Object.entries(n.lookupResolutions || {})) if (v && v.matchObject === 'Individual') return (n.objectType || n.childSObject) + '.' + k + ' → ' + JSON.stringify(v); for (const c of (n.children || [])) { const r = f(c); if (r) return r; } return null; })(_profiles.find(p => p.id === ${JSON.stringify(id)}).tree))`));
    // 3. the dry run of the Contacts to insert
    const dry = async tag => {
      await h.eval(`(() => { const b = [...document.querySelectorAll('[data-dep-obj][data-dep-tab="ins"]')].find(x => /Contact/.test(x.textContent)); if (b) b.click(); return !!b; })()`); await h.sleep(900);
      await h.eval(`(() => { const b = [...document.querySelectorAll('[data-dep-bulk="all"]')].find(x => x.offsetParent && !x.disabled); if (b) b.click(); return !!b; })()`); await h.sleep(600);
      h.log(tag, 'selected:', (await h.text('#dsDepSummary')).replace(/\s+/g, ' ').slice(0, 160));
      if (await h.eval("document.querySelector('#dsRecProbeBtn').disabled")) { h.log(tag, 'Dry run is off — nothing to check'); return; }
      await h.click('#dsRecProbeBtn');
      await h.sleep(2500);
      for (let i = 0; i < 3; i++) { if (!(await h.modalText(100))) break; await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } const b = document.querySelector('#sftkConfirmGo') || [...document.querySelectorAll('#dsModalBox button')].find(b => /dry run|proceed|run/i.test(b.textContent)); if (b) b.click(); return true; })()`); await h.sleep(2000); }
      let last = '', stable = 0, log = '';
      for (let i = 0; i < 180 && stable < 8; i++) { await h.sleep(1000); log = await h.eval(`document.querySelector('#dsRecProgress')?.innerText || ''`); if (log === last && log) stable++; else { stable = 0; last = log; } }
      const lines = log.split(NL).map(x => x.trim()).filter(x => /IndividualId|Individual\./.test(x));
      h.log(tag, 'engine lines about the lookup:', lines.length ? lines.join(' ‖ ').slice(0, 700) : '(none — every lookup resolved, the engine speaks only of the ones it could not)');
      h.log(tag, 'verdict:', (await h.eval(`(document.querySelector('.ds-dep-probe-hint')?.innerText || [...document.querySelectorAll('#dsRecProgress .ds-prog-row')].map(e => e.innerText).filter(t => /would|refus|accept|dry run/i.test(t)).pop() || '')`)).replace(/\s+/g, ' ').slice(0, 260));
    };
    await dry('3. same first name in both orgs —');
    // 4. the key is whole: another first name in the target → not this parent
    setFirst('npc2', t0[0].Id, 'Other');
    h.log('target Individual first name is now "Other" (CLI)');
    await h.eval(`document.querySelector('#dsDepRefresh').click()`);
    await h.waitFor("!!document.querySelector('#dsDepRefresh')?.disabled", 30000, 200).catch(() => {});
    await waitScanned(h); await h.sleep(5000);
    h.log('parent row with a different first name in the target:', await row());
    await dry('4. different first name in the target —');
    h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 4)')).slice(0, 500));
  } finally {
    restore();
    h.log('Individual after — npc:', JSON.stringify(q('npc', IND)[0].FirstName), '· npc2:', JSON.stringify(q('npc2', IND)[0].FirstName));
  }
}
