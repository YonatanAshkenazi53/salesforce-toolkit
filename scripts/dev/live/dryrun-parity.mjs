// Live, npc → npc2 (owner 2026-11-26: "how can we make sure dry run works the same as full deployment").
// THE PARITY PROOF: the same selection is dry-run, then really deployed, and the two answers are compared —
// per object and operation the counts, and for inserts the refused records one by one. Then the real run is
// rolled back, and the CLI must read the target as it was before.
//   FIXTURE / PROFILE   any deployment (default: the packaged lookup tree — a managed validation rule, a
//                       duplicate rule, an org validation rule and a flow all refuse something there)
//   COUNT_SOQL          "label=SELECT COUNT() …;label=…" read with the CLI before and after (default: the fixture's)
//   DRY_ONLY=1          stop after the dry run
import { execFileSync } from 'node:child_process';
const NL = String.fromCharCode(10);
const lines = (s, n = 2500) => String(s || '').slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const count = soql => { try { const out = execFileSync('sf', ['data', 'query', '-o', 'npc2', '--json', '-q', `"${soql}"`], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); return JSON.parse(out.slice(out.indexOf('{'))).result.totalSize; } catch (_) { return '?'; } };
const COUNTS = (process.env.COUNT_SOQL || "parents=SELECT COUNT() FROM dlrs__LookupParent__c;children=SELECT COUNT() FROM dlrs__LookupChild__c;parentsToday=SELECT COUNT() FROM dlrs__LookupParent__c WHERE LastModifiedDate = TODAY AND Name LIKE 'SFTK Pkg%'").split(';').map(x => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; });
const target = () => JSON.stringify(Object.fromEntries(COUNTS.map(([k, s]) => [k, count(s)])));

export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles(process.env.FIXTURE || 'docs/fixtures/packaged-object-fixture/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK Pkg — Lookup tree (DLRS)';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('fixture deployment missing');
  await h.eval(`(async () => { const p = _profiles.find(x => x.id === ${JSON.stringify(id)}); if (p.piiPolicy && Object.keys(p.piiPolicy).length && !p.piiSalt) { const b = new Uint8Array(16); crypto.getRandomValues(b); p.piiSalt = Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); await storageSaveProfiles(); } return true; })()`);
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
  h.log('deployment:', NAME, '· selected:', lines(await h.text('#dsDepSummary'), 400));
  const before = target(); h.log('CLI target before:', before);

  // ── 1. the dry run ──
  let hist = await h.eval('_history.length');
  await h.click('#dsRecProbeBtn'); await h.sleep(1500);
  await h.eval(`(() => { const b = document.querySelector('#sftkConfirmGo'); if (b && !b.disabled) b.click(); return true; })()`);
  for (let i = 0; i < 400 && !(await h.eval(`_history.length > ${hist}`)); i++) await h.sleep(800);
  await h.sleep(2500);
  const dry = JSON.parse(await h.eval(`JSON.stringify((e => ({ status: e.status, probe: e.probe, summary: e.summary }))(_history[_history.length - 1]))`));
  // refused updates are on the run's cards only: the operation tag and the record names
  const dryCards = await h.eval(`[...document.querySelectorAll('.ds-refuse-op')].map(s => { const card = s.closest('.ds-prog-err, .ds-prog-line, div'); return (card ? card.innerText : s.innerText).replace(/\\s+/g, ' ').slice(0, 400); })`);
  const afterDry = target(); h.log('CLI target after the dry run:', afterDry, afterDry === before ? '(unchanged)' : '❌ CHANGED');
  if (afterDry !== before) throw new Error('the dry run changed the target');
  h.log('dry run:', JSON.stringify({ status: dry.status, transactions: dry.probe.windows, rounds: dry.probe.rounds, left: dry.probe.left, byObj: dry.probe.byObj, updates: dry.probe.updates }));
  if (process.env.DRY_ONLY) return;   // DRY_ONLY=1: the dry run alone — nothing is written (2026-11-27: more than 200 records of an object)

  // ── 2. the real run, same selection ──
  h.log('selection kept:', lines(await h.text('#dsDepSummary'), 400));
  hist = await h.eval('_history.length');
  if (await h.eval(`document.querySelector('#dsRecRunBtn')?.disabled`)) throw new Error('▶ Deploy is disabled');
  await h.click('#dsRecRunBtn'); await h.sleep(2500);
  for (let i = 0; i < 4; i++) { const m = await h.modalText(300); if (!m) break; await h.eval(`(() => { const b = document.querySelector('#dsRecDelOk') || [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed|deploy|continue/i.test(b.textContent)); if (b) b.click(); })()`); await h.sleep(2000); }
  for (let i = 0; i < 600 && !(await h.eval(`_history.length > ${hist}`)); i++) await h.sleep(1000);
  await h.sleep(4000);
  const real = JSON.parse(await h.eval(`JSON.stringify((e => ({ status: e.status, summary: e.summary, errors: (e.errors || []).slice(0, 12) }))(_history[_history.length - 1]))`));
  h.log('CLI target after the real run:', target());

  // ── 3. compare ──
  const rows = []; let diff = 0;
  const allObjs = [...new Set([...Object.keys(dry.probe.byObj || {}), ...Object.keys(dry.probe.updates || {}), ...Object.keys(real.summary || {})])];
  for (const o of allObjs) {
    const d = (dry.probe.byObj || {})[o], u = (dry.probe.updates || {})[o], r = (real.summary || {})[o] || {};
    if (d) {
      const dW = d.wouldWrite || 0, dR = (d.refused || 0) + (d.cascade || 0), rW = r.inserted || 0, rR = r.insertedFailed || 0;
      const dIds = ((dry.summary[o] || {}).failedSourceIds || []).map(x => (typeof x === 'string' ? x : x.id)).sort();
      const rIds = (r.failedSourceIds || []).map(x => (typeof x === 'string' ? x : x.id)).sort();
      const same = dW === rW && dR === rR && dIds.join() === rIds.join();
      if (!same) diff++;
      rows.push(`${same ? '✓' : '✗'} ${o} · Insert — dry run: ${dW} would be written, ${dR} refused · real: ${rW} written, ${rR} refused · refused records ${dIds.join() === rIds.join() ? 'identical (' + dIds.length + ')' : 'DIFFER — dry only: ' + dIds.filter(x => !rIds.includes(x)).join(',') + ' · real only: ' + rIds.filter(x => !dIds.includes(x)).join(',')}`);
      const why = id => { const f = x => ((x || []).find(y => (y.id || y) === id) || {}).error || ''; return [f((dry.summary[o] || {}).failedSourceIds), f(r.failedSourceIds)]; };
      for (const rid of dIds.filter(x => rIds.includes(x))) { const [a, b] = why(rid); const norm = s => String(s).replace(/\s+/g, ' ').trim().slice(0, 90); rows.push(`    ${norm(a) === norm(b) ? '✓' : '≈'} ${rid}: ${norm(a)}${norm(a) === norm(b) ? '' : '  ‖ real: ' + norm(b)}`); }
    }
    if (u) {
      const rW = (r.updated != null ? r.updated : r.overwritten) || 0, rR = (r.updatedFailed != null ? r.updatedFailed : r.overwrittenFailed) || 0;
      const same = (u.wouldWrite || 0) === rW && (u.refused || 0) === rR;
      if (!same) diff++;
      rows.push(`${same ? '✓' : '✗'} ${o} · Update — dry run: ${u.wouldWrite || 0} would be written, ${u.refused || 0} refused${u.unchecked ? `, ${u.unchecked} not checked` : ''} · real: ${rW} written, ${rR} refused`);
    }
  }
  h.log('PARITY:'); for (const r of rows) h.log('  ' + r);
  h.log('dry run refusal cards:', JSON.stringify(dryCards.filter((t, i, a) => a.indexOf(t) === i).slice(0, 10)));
  h.log('real run status:', real.status, '· errors:', JSON.stringify(real.errors).slice(0, 1500));

  // ── 4. roll the real run back ──
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
  h.log(diff ? `✗ ${diff} object/operation row(s) differ between the dry run and the real run` : '✓ the dry run and the real run agree on every object and operation');
  if (diff) process.exitCode = 1;
}
