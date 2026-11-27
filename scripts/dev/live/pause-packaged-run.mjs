// Live, npc → npc2, WRITES and rolls back (owner, asked since 2026-11-18: "can we disable package validation rules
// and flows?" … 2026-11-27: "what about the package validation rule test").
// THE SWITCH OF A PACKAGE'S OWN VALIDATION RULE BY A RUN: on the packaged lookup tree the managed rule dlrs__Not_42
// refuses the update of one parent. Only that rule is ticked in the ⏸ panel; the run must switch it off in the
// target, write the update, and switch it back on. The CLI reads the rule's Active before, during and after.
// Then the run is rolled back and the CLI reads the target again.
import { execFileSync } from 'node:child_process';
const NL = String.fromCharCode(10);
const lines = (s, n = 2500) => String(s || '').slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const sf = args => { try { const out = execFileSync('sf', args, { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); return JSON.parse(out.slice(out.indexOf('{'))).result; } catch (_) { return null; } };
const count = soql => { const r = sf(['data', 'query', '-o', 'npc2', '--json', '-q', `"${soql}"`]); return r ? r.totalSize : '?'; };
const ruleActive = () => { const r = sf(['data', 'query', '-o', 'npc2', '-t', '--json', '-q', `"SELECT Active FROM ValidationRule WHERE ValidationName = 'Not_42' AND NamespacePrefix = 'dlrs'"`]); return r && r.records[0] ? String(r.records[0].Active) : '?'; };
const target = () => JSON.stringify({ parents: count('SELECT COUNT() FROM dlrs__LookupParent__c'), children: count('SELECT COUNT() FROM dlrs__LookupChild__c'), Not_42_active: ruleActive() });

export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/packaged-object-fixture/profiles.json');
  const NAME = 'SFTK Pkg — Lookup tree (DLRS)';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('fixture deployment missing');
  const idle = () => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled && !/⏳/.test(document.querySelector('#dsDepScanAll')?.textContent || '') && !/⏳/.test(document.querySelector('#dsDepRescanAll')?.textContent || '')", 600000, 1000);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`);
  await h.waitFor("!!document.querySelector('.ds-dep-plan')", 300000, 1000);
  await h.waitFor(`(() => { const n = [...document.querySelectorAll('.ds-dtree-node')]; return n.length > 0 && !n.some(x => /not counted yet/.test(x.innerText)); })()`, 600000, 1500).catch(() => {});
  await idle(); await h.sleep(1500);
  const dir = await h.eval("(() => { const p = _reconcileProfile; return p ? { src: p.sourceOrg, tgt: p.targetOrg } : null; })()");
  if (!dir || !dir.src.includes('c449e108c2') || !dir.tgt.includes('e2c4511b2b')) throw new Error('wrong direction: ' + JSON.stringify(dir));
  const objs = await h.eval(`[...document.querySelectorAll('[data-dep-obj]')].map(b => b.dataset.depObj).filter((v, i, a) => v !== undefined && a.indexOf(v) === i)`);
  for (const o of objs) for (const tab of ['ins', 'chg']) {
    await h.eval(`(() => { const b = document.querySelector('[data-dep-obj="${o}"][data-dep-tab="${tab}"]'); if (b) b.click(); })()`); await h.sleep(450);
    await h.eval(`(() => { const b = document.querySelector('[data-dep-bulk="all"]'); if (b && !b.disabled) b.click(); return true; })()`); await h.sleep(350);
  }
  h.log('selected:', lines(await h.text('#dsDepSummary'), 400));

  // ── the ⏸ panel: tick the package's rule and nothing else ──
  await h.eval(`(() => { const d = document.querySelector('details.ds-dep-pause'); if (d) d.open = true; return true; })()`);
  await h.waitFor("!!document.querySelector('.ds-dep-pause-cb')", 120000, 1000); await h.sleep(1500);
  const tabs = await h.eval(`[...document.querySelectorAll('[data-pause-tab]')].map(b => b.dataset.pauseTab)`);
  let ticked = [];
  for (const t of (tabs.length ? tabs : [''])) {
    if (t) { await h.eval(`document.querySelector('[data-pause-tab="${t}"]').click()`); await h.sleep(600); }
    const got = await h.eval(`(() => { const out = []; for (const cb of document.querySelectorAll('.ds-dep-pause-cb')) { const txt = cb.closest('label').innerText.replace(/\\s+/g, ' ').trim(); const want = cb.dataset.kind === 'rule' && /dlrs__Not_42/.test(txt); if (cb.checked !== want && !cb.disabled) cb.click(); } for (const cb of document.querySelectorAll('.ds-dep-pause-cb')) if (cb.checked) out.push(cb.dataset.kind + ': ' + cb.closest('label').innerText.replace(/\\s+/g, ' ').trim().slice(0, 110)); return out; })()`);
    ticked = ticked.concat(got);
  }
  h.log('ticked in the pause panel:', JSON.stringify(ticked));
  if (ticked.length !== 1 || !/dlrs__Not_42/.test(ticked[0])) throw new Error('FAILED: exactly the packaged rule must be ticked');
  await h.shot(h.shots + '/pausepkg-run-panel.png');
  const before = target(); h.log('CLI target before:', before);
  if (!/"Not_42_active":"true"/.test(before)) throw new Error('the packaged rule must be Active before the run');

  // ── the real run ──
  const hist = await h.eval('_history.length');
  if (await h.eval(`document.querySelector('#dsRecRunBtn')?.disabled`)) throw new Error('▶ Deploy is disabled');
  await h.click('#dsRecRunBtn'); await h.sleep(2500);
  for (let i = 0; i < 4; i++) { const m = await h.modalText(600); if (!m) break; h.log('confirm:', lines(m, 600)); await h.eval(`(() => { const b = document.querySelector('#dsRecDelOk') || [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed|deploy|continue/i.test(b.textContent)); if (b) b.click(); })()`); await h.sleep(2000); }
  const seen = [];
  for (let i = 0; i < 300 && !(await h.eval(`_history.length > ${hist}`)); i++) { const a = ruleActive(); if (seen[seen.length - 1] !== a) seen.push(a); await h.sleep(700); }
  await h.sleep(4000);
  h.log('Not_42 Active, as the CLI read it while the run went:', JSON.stringify(seen));
  const real = JSON.parse(await h.eval(`JSON.stringify((e => ({ status: e.status, summary: e.summary, errors: (e.errors || []).slice(0, 12) }))(_history[_history.length - 1]))`));
  h.log('run status:', real.status);
  for (const [o, s] of Object.entries(real.summary || {})) h.log('  ' + o + ':', JSON.stringify({ inserted: s.inserted, insertedFailed: s.insertedFailed, updated: s.updated, updatedFailed: s.updatedFailed, overwritten: s.overwritten, overwrittenFailed: s.overwrittenFailed }));
  h.log('run errors:', JSON.stringify(real.errors).slice(0, 1800));
  h.log('log lines about the rule:', await h.eval(`JSON.stringify([...document.querySelectorAll('.ds-prog-row')].map(x => x.innerText.replace(/\\s+/g, ' ').trim()).filter(t => /Not_42|validation rule|switched|restored|back on/i.test(t)).slice(0, 14))`));
  await h.shot(h.shots + '/pausepkg-run-log.png');
  const afterRun = target(); h.log('CLI target after the run:', afterRun);

  // ── roll the run back ──
  await h.eval(`navigateToView('history')`);
  await h.waitFor("!!document.querySelector('[data-dsaction=\"rollbackRun\"]:not([disabled])')", 30000, 500); await h.sleep(500);
  await h.eval(`document.querySelector('[data-dsaction="rollbackRun"]:not([disabled])').click()`);
  await h.waitFor("!!document.querySelector('#dsRbGo') || !!document.querySelector('.ds-rec-card-bad')", 300000, 1000); await h.sleep(1000);
  h.log('ROLL BACK plan:', lines(await h.text('#dsRbSummary'), 300));
  await h.eval(`document.querySelector('#dsRbGo').click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 20000, 300); await h.sleep(300);
  await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`); await h.sleep(300);
  const rb = await h.eval(`_history.filter(x => x.kind === 'rollback').length`);
  await h.eval(`document.querySelector('#sftkConfirmGo')?.click()`);
  for (let i = 0; i < 600 && !(await h.eval(`_history.filter(x => x.kind === 'rollback').length > ${rb}`)); i++) await h.sleep(1000);
  await h.sleep(2000);
  h.log('ROLL BACK result:', lines(await h.text('#dsRbResult'), 500));
  const after = target(); h.log('CLI target after the roll back:', after);
  const upd = real.summary && real.summary.dlrs__LookupParent__c ? (real.summary.dlrs__LookupParent__c.updated || 0) + (real.summary.dlrs__LookupParent__c.overwritten || 0) : 0;
  const ok = seen.includes('false') && /"Not_42_active":"true"/.test(afterRun) && upd >= 1 && after === before;
  h.log(ok ? '✓ the package rule was switched off for the run, the update it refused was written, the rule is Active again, the roll back restored the target'
           : '✗ NOT PROVEN — off seen: ' + seen.includes('false') + ' · active after: ' + /"Not_42_active":"true"/.test(afterRun) + ' · parent updates written: ' + upd + ' · target restored: ' + (after === before));
  if (!ok) process.exitCode = 1;
}
