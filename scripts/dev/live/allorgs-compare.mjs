// Live: Data Studio › All open orgs and › Org Compare, both orgs open, read-only.
//   All open orgs: the fixture deployments imported, trailheads5 picked as the
//   source, trailheads4 a column; the column's Scan button; the cells say what
//   they counted; ⚖ on a cell opens the Deploy page for that pair (direction
//   checked, nothing ticked, nothing run).
//   Org Compare: trailheads5 → trailheads4 on Account + Contact under the three
//   strategies (Auto / External Id / a typed field); each row's arithmetic is
//   checked (matched + missing = source count, the percentage follows); the CSV
//   export is a real download read back; 🚀 Deploy on a row opens the Deploy page
//   (nothing ticked, nothing run).
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const NL = String.fromCharCode(10);
const lines = (s, n = 2500) => String(s || '').slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const SRC = 'trailheads5', TGT = 'trailheads4';

async function deployPageDirection(h) {
  await h.waitFor("_currentView === 'deploy' && !!document.querySelector('.ds-dep-plan, #dsDepScan, #dsDepRefresh')", 120000, 1000);
  await h.sleep(1200);
  const d = await h.eval("(() => { const p = (typeof _reconcileProfile !== 'undefined' && _reconcileProfile) || null; return p ? { name: p.name, src: p.sourceOrg || '', tgt: p.targetOrg || '' } : null; })()");
  const ticked = await h.eval("document.querySelectorAll('.ds-dep-row input[type=checkbox]:checked, [data-dep-pick]:checked').length");
  h.log(`DEPLOY PAGE opened: ${JSON.stringify(d)} · ticked rows: ${ticked}`);
  if (!d || !d.src.includes(SRC) || !d.tgt.includes(TGT)) throw new Error('the Deploy page opened on the wrong pair');
  if (ticked) throw new Error('something is pre-ticked on the Deploy page');
}

export default async function (h) {
  await h.login('npc2'); await h.login('npc');
  await h.studio('#/profiles');
  await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  // the fixture may have been re-pointed by login order — every deployment must read SRC → TGT
  const fixed = await h.eval(`(async () => { let n = 0; for (const p of _profiles) { if (!(p.sourceOrg || '').includes(${JSON.stringify(SRC)}) || !(p.targetOrg || '').includes(${JSON.stringify(TGT)})) { p.sourceOrg = 'https://${SRC}.my.salesforce.com'; p.targetOrg = 'https://${TGT}.my.salesforce.com'; n++; } } if (n) await storageSaveProfiles(); return n; })()`);
  h.log(`deployments: ${await h.eval('_profiles.length')} · ${fixed} re-pointed to ${SRC} → ${TGT}`);

  // ── All open orgs ──
  await h.eval("location.hash = '#/ring'"); await h.sleep(1500);
  await h.waitFor("!!document.querySelector('#dsRingSrc')", 60000, 500); await h.sleep(1000);
  h.log('RING source options:', JSON.stringify(await h.eval("[...document.querySelectorAll('#dsRingSrc option')].map(o => o.text + (o.selected ? '*' : ''))")));
  await h.eval(`(() => { const s = document.querySelector('#dsRingSrc'); const o = [...s.options].find(o => /${SRC}/.test(o.value) || /${SRC}/.test(o.text)); if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); } return !!o; })()`);
  await h.sleep(2000);
  await h.waitFor("document.querySelectorAll('[data-ring-cell]').length > 0", 60000, 500);
  h.log('RING HEADER:', lines(await h.eval("document.querySelector('#dsMain')?.innerText || ''"), 500));
  const cellsBefore = await h.eval("[...document.querySelectorAll('[data-ring-cell]')].map(c => c.dataset.ringCell.split('|')[1].replace(/https?:\\/\\//, '') + ' → ' + c.innerText.replace(/\\s+/g, ' ').trim().slice(0, 80))");
  h.log(`cells before the scan (${cellsBefore.length}):`, JSON.stringify(cellsBefore.slice(0, 6)));
  const tgtBtn = await h.eval("(() => { const b = document.querySelector('[data-ring-scanall]:not([disabled])'); if (!b) return null; const t = b.innerText.trim(); b.click(); return t; })()");
  h.log(`the page's Scan button pressed: ${tgtBtn}`);
  if (!tgtBtn) throw new Error('no enabled Scan button on the page');
  await h.waitFor("![...document.querySelectorAll('[data-ring-cell]')].some(c => /scanning|…|⏳/i.test(c.innerText)) && [...document.querySelectorAll('[data-ring-cell]')].some(c => /\\d/.test(c.innerText))", 600000, 2000);
  await h.sleep(1500);
  const cellsAfter = await h.eval("[...document.querySelectorAll('[data-ring-cell]')].map(c => c.innerText.replace(/\\s+/g, ' ').trim().slice(0, 140))");
  h.log(`cells after the scan:`, JSON.stringify(cellsAfter));
  if (!cellsAfter.some(c => /\d/.test(c))) throw new Error('no cell shows a count after the scan');
  // a cell's ⚖ opens the Deploy page for that pair
  const rec = await h.eval(`(() => { const b = [...document.querySelectorAll('[data-ring-rec]')].find(b => /${TGT}/.test(b.dataset.ringRec) && !b.disabled); if (!b) return null; const t = b.dataset.ringRec; b.click(); return t; })()`);
  h.log(`cell ⚖ pressed: ${rec}`);
  if (!rec) throw new Error('no enabled ⚖ on a cell');
  await deployPageDirection(h);

  // ── Org Compare ──
  await h.eval("location.hash = '#/compare'"); await h.sleep(1500);
  await h.waitFor("!!document.querySelector('#dsOCRun')", 60000, 500); await h.sleep(800);
  await h.eval(`(() => { const s = document.querySelector('#dsOCSrc'), t = document.querySelector('#dsOCTgt'); const pick = (sel, re) => { const o = [...sel.options].find(o => re.test(o.value) || re.test(o.text)); if (o) { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); } return !!o; }; return pick(s, /${SRC}/) && pick(t, /${TGT}/); })()`);
  await h.sleep(800);
  h.log(`COMPARE orgs: ${await h.eval("document.querySelector('#dsOCSrc').selectedOptions[0]?.text")} → ${await h.eval("document.querySelector('#dsOCTgt').selectedOptions[0]?.text")}`);
  await h.waitFor("document.querySelectorAll('[data-oc-obj]').length > 0", 120000, 1000);
  await h.sleep(500);
  h.log(`objects offered: ${await h.eval("document.querySelectorAll('[data-oc-obj]').length")} · default ticked: ${await h.eval("document.querySelectorAll('[data-oc-obj]:checked').length")}`);
  await h.eval("document.querySelector('#dsOCSelNone')?.click()"); await h.sleep(300);
  for (const o of ['Account', 'Contact']) await h.eval(`(() => { const c = document.querySelector('[data-oc-obj="${o}"]'); if (c && !c.checked) c.click(); return !!c; })()`);
  await h.sleep(300);
  h.log(`ticked: ${JSON.stringify(await h.eval("[...document.querySelectorAll('[data-oc-obj]:checked')].map(c => c.dataset.ocObj)"))} · count label: ${await h.eval("document.querySelector('#dsOCObjCount')?.innerText || ''")}`);
  const strategies = [['auto', ''], ['extid', ''], ['custom', 'Name']];
  const rowsByStrategy = {};
  for (const [strat, field] of strategies) {
    await h.eval(`(() => { const s = document.querySelector('#dsOCStrategy'); s.value = ${JSON.stringify(strat)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
    if (field) await h.eval(`(() => { const i = document.querySelector('#dsOCCustomField'); i.value = ${JSON.stringify(field)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await h.sleep(300);
    h.log(`STRATEGY ${strat}: hint "${lines(await h.text('#dsOCStrategyHint'), 160)}" · custom box shown: ${await h.eval("document.querySelector('#dsOCCustomWrap')?.style.display !== 'none'")}`);
    await h.click('#dsOCRun');
    await h.waitFor("!document.querySelector('#dsOCRun').disabled && !document.querySelector('.ds-oc-pending')", 300000, 1000);
    await h.sleep(800);
    const rows = await h.eval("[...document.querySelectorAll('#dsOCResults tr')].filter(tr => tr.querySelector('td')).map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.replace(/\\s+/g, ' ').trim()))");
    rowsByStrategy[strat] = rows;
    for (const r of rows) {
      h.log(`  ROW ${strat}:`, r.slice(0, 7).join(' | '));
      if (r.length < 7) continue;   // an error or a skipped row
      const num = s => parseInt(String(s).replace(/[^\d]/g, ''), 10);
      const [srcN, tgtN, matched, missing, extras] = [1, 2, 3, 4, 5].map(i => num(r[i]));
      const pct = parseInt(r[6], 10);
      if (matched + missing !== srcN) throw new Error(`${r[0]}: matched ${matched} + missing ${missing} ≠ source ${srcN}`);
      if (matched + extras !== tgtN) throw new Error(`${r[0]}: matched ${matched} + only-in-target ${extras} ≠ target ${tgtN}`);
      const expectPct = srcN ? Math.round(matched / srcN * 100) : 100;
      if (Math.abs(pct - expectPct) > 1) throw new Error(`${r[0]}: shows ${pct}% but matched/source = ${expectPct}%`);
      if (pct === 100 && missing > 0) throw new Error(`${r[0]}: says 100% with ${missing} missing`);
    }
    h.log(`  summary strip: ${lines(await h.eval("document.querySelector('.ds-oc-summary, .ds-oc-strip, #dsOCResults .ds-oc-sum')?.innerText || ''"), 300)}`);
  }
  // the CSV export of the last run
  const dlDir = resolve('dist/qa/downloads'); mkdirSync(dlDir, { recursive: true });
  await h.cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true }, null);
  const had = new Set(readdirSync(dlDir));
  await h.click('#dsOCExportCsv');
  let f = null; for (let i = 0; i < 40 && !f; i++) { await h.sleep(500); f = readdirSync(dlDir).find(x => !had.has(x) && /\.csv$/.test(x)); }
  if (!f) throw new Error('the compare CSV did not download');
  const csv = readFileSync(join(dlDir, f), 'utf8').split(/\r?\n/).filter(Boolean);
  h.log(`CSV: ${f} · ${csv.length - 1} row(s) · header: ${csv[0].slice(0, 200)}`);
  if (csv.length - 1 < rowsByStrategy.custom.filter(r => r.length >= 7).length) throw new Error('the CSV has fewer rows than the table');
  // 🚀 Deploy from a row
  const buttons = await h.eval("[...document.querySelectorAll('#dsOCResults tr')].find(tr => tr.querySelector('[data-oc-reconcile]'))?.querySelectorAll('button').length");
  h.log(`buttons per row: ${buttons} (${JSON.stringify(await h.eval("[...(document.querySelector('#dsOCResults tr [data-oc-reconcile]')?.closest('tr')?.querySelectorAll('button') || [])].map(b => b.innerText.trim())"))})`);
  const obj = await h.eval("(() => { const b = document.querySelector('[data-oc-reconcile=\"Account\"]') || document.querySelector('[data-oc-reconcile]'); if (!b) return null; const o = b.dataset.ocReconcile; b.click(); return o; })()");
  h.log(`🚀 Deploy pressed on: ${obj}`);
  if (!obj) throw new Error('no Deploy button on a row');
  await deployPageDirection(h);
  h.log('✓ All open orgs scanned a column and opened the Deploy page from a cell; Org Compare ran three strategies with consistent rows, exported CSV, and opened the Deploy page from a row');
}
