// LIVE: ⚡ All at once (owner 2026-11-17: "give an option to do it all in one shot instead of selection … what can be
// removed without ruining the component will be removed. what cannot be removed will be deleted" · "what if i want
// one component field ref removed and another component i would like to delete entirely").
//   default      NO ORG WRITE: the plan is opened, read, one row changed, closed with ✕
//   RUN=<n>      WRITES: every row but the first n that can be replaced or removed is set to "Leave it for me", the
//                plan is run, the report read, and ↩ Undo all takes every change back (UNDO=0 keeps them)
//   DEL=1        with RUN: the rows the tool itself set to Delete stay in too
// Fixture: docs/fixtures/packaged-object-fixture. ORG=npc2 by default; OBJ / FIELD / REPL override.
const ORG = process.env.ORG || 'npc2', OBJ = process.env.OBJ || 'dlrs__LookupChild__c', FIELD = process.env.FIELD || 'SFTK_Pkg_Tag__c';
const REPL = process.env.REPL || '', RUN = Number(process.env.RUN || 0), TAG = process.env.TAG || 'plan';
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
const dark = async (h, on) => { await h.eval(`(() => { document.body.classList.toggle('sftk-dark', ${on}); return true; })()`); await h.sleep(300); };
const both = async (h, name) => { await h.shot(h.shots + '/' + name + '.png'); await dark(h, true); await h.shot(h.shots + '/' + name + '-dark.png'); await dark(h, false); };
const plan = h => h.eval(`(() => [...document.querySelectorAll('.fc-plan-row')].map(r => ({ name: r.querySelector('.fc-plan-name').textContent, kind: r.querySelector('.fc-plan-kind').textContent, pick: r.dataset.pick, opts: [...r.querySelectorAll('.fc-plan-way')].map(o => o.dataset.kind).join('/'), why: '' })))()`);
const go = h => h.eval(`(() => { const g = document.getElementById('sftkConfirmGo'); return { text: g ? g.textContent.trim() : '', off: !!(g && g.disabled), sum: (document.getElementById('fcPlanSum') || {}).textContent || '' }; })()`);
const histLen = h => h.eval(`chrome.storage.local.get('sftk_history').then(r => (r.sftk_history || []).length)`);

export default async function (h) {
  await h.login(ORG);
  await h.popup('fields');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', OBJ);
  await pick(h, '#fcFieldInput', '#fcFieldDrop', FIELD);
  if (REPL) await pick(h, '#fcReplInput', '#fcReplDrop', REPL);
  await h.eval(`(() => { const b = document.querySelector('#fcScope [data-scope="both"]'); if (b) b.click(); return true; })()`); await h.sleep(600);
  await h.eval(`(() => { document.querySelector('#fcScanBtn').click(); return true; })()`);
  await h.waitFor("!document.querySelector('#fcScanBtn').disabled", 600000, 1000);
  await h.sleep(RUN ? 20000 : 12000);   // the ✂ pre-check reads every row after the scan
  const hist0 = await histLen(h);

  await h.eval(`(() => { document.getElementById('fcFixEvery').scrollIntoView({ block: 'center' }); return true; })()`);
  h.log('bar:', await h.eval(`document.getElementById('fcFixEvery').innerText.replace(/\\s+/g, ' ')`));
  await both(h, TAG + '-0-bar');
  await h.eval(`(() => { document.querySelector('.fc-plan-btn').click(); return true; })()`);
  await h.waitFor("!!document.querySelector('.fc-plan-row')", 300000, 500);
  await h.sleep(600);
  const rows = await plan(h);
  for (const r of rows) h.log(`  ${r.pick.padEnd(8)} ${r.kind} · ${r.name} [${r.opts}]${r.why ? ' — ' + r.why : ''}`);
  const g0 = await go(h);
  h.log('plan:', rows.length, 'rows ·', g0.sum, '· button:', g0.text);
  if (!rows.length || !/^⚡ Run \d/.test(g0.text)) throw new Error('FAILED: the plan must list the rows and say how many changes run');
  if (rows.some(r => r.pick === 'delete' && !/Field Sets|Buttons|Field Updates|Email Alerts|Outbound/.test(r.kind))) throw new Error('FAILED: automation and code are never picked for deletion by the tool');
  await both(h, TAG + '-1-plan');

  // one row changed by hand: the numbers and the button follow
  const i = rows.findIndex(r => r.pick !== 'leave');
  await h.eval(`(() => { document.querySelector('.fc-plan-row[data-i="${i}"] .fc-plan-way[data-kind="leave"]').click(); return true; })()`);
  const g1 = await go(h);
  h.log('after leaving one row:', g1.sum, '·', g1.text);
  if (g1.text === g0.text) throw new Error('FAILED: the button must follow the rows');

  // the bulk links: Delete what is left → every left blocker that can be deleted; Suggested → back
  const bulk = async k => { await h.eval(`(() => { const b = document.querySelector('.fc-plan-link[data-bulk="${k}"]'); if (b) b.click(); return true; })()`); return go(h); };
  h.log('Delete what is left:', (await bulk('delete')).sum, '· Suggested:', (await bulk('reset')).sum);
  if (!RUN) {
    await h.eval(`(() => { document.getElementById('sftkConfirmX').click(); return true; })()`);
    await h.sleep(800);
    if ((await histLen(h)) !== hist0) throw new Error('FAILED: closing the plan must change nothing');
    h.log(`✓ fc-plan on ${ORG}: ${rows.length} rows planned, one changed, closed with ✕; no org write`);
    return;
  }
  // RUN: only the first n rows that can be replaced or removed stay in
  await h.eval(`(() => { let n = 0; document.querySelectorAll('.fc-plan-row').forEach(row => { const first = row.querySelector('.fc-plan-way').dataset.kind; const want = (${process.env.DEL === '1'} && row.dataset.pick === 'delete') ? 'delete' : (first !== 'leave' && first !== 'delete' && n < ${RUN}) ? (n++, first) : 'leave'; row.querySelector('.fc-plan-way[data-kind="' + want + '"]').click(); }); return true; })()`);
  h.log('run:', JSON.stringify(await go(h)));
  await both(h, TAG + '-2-chosen');
  await h.eval(`(() => { document.getElementById('sftkConfirmGo').click(); return true; })()`);
  await h.waitFor("!!document.querySelector('.fc-plan-prog') || !!document.getElementById('fcPlanRepClose')", 60000, 200);
  await h.sleep(9000);
  await both(h, TAG + '-3-running');
  let asked = 0;
  for (let t = 0; t < 900; t++) {
    if (await h.eval(`!!document.getElementById('fcPlanRepClose')`)) break;
    if (await h.eval(`!!document.getElementById('sftkConfirmCancel')`)) {
      asked++;
      h.log('A DIALOG OPENED:', await h.eval(`(document.querySelector('.sftk-cf-title') || {}).textContent || ''`));
      await h.eval(`(() => { document.getElementById('sftkConfirmCancel').click(); return true; })()`);
    }
    await h.sleep(1000);
  }
  await h.sleep(500);
  h.log('report:', await h.eval(`document.querySelector('.fc-plan-rep').innerText.replace(/\\s+/g, ' ').slice(0, 1500)`));
  await both(h, TAG + '-4-report');
  if (asked) throw new Error('FAILED: the run asked again ' + asked + ' time(s)');
  await h.eval(`(() => { document.getElementById('fcPlanRepClose').click(); return true; })()`);
  await h.sleep(500);
  await h.eval(`(() => { document.getElementById('fcFixEvery').scrollIntoView({ block: 'center' }); return true; })()`);
  h.log('bar after:', await h.eval(`document.getElementById('fcFixEvery').innerText.replace(/\\s+/g, ' ')`));
  await both(h, TAG + '-5-after');
  const fixed = await h.eval(`[...document.querySelectorAll('#fcResults .fc-item-fixed')].map(e => e.querySelector('.fc-item-name').textContent + ' → ' + ((e.querySelector('.fc-item-ok') || {}).textContent || '').slice(0, 90))`);
  for (const f of fixed) h.log('  done:', f);
  h.log('history entries made:', (await histLen(h)) - hist0);
  if (process.env.UNDO === '0') return;
  // ↩ Undo all takes every change of the run back (the list is scanned again afterwards)
  await h.waitFor("!!document.getElementById('fcUndoAllBtn')", 60000, 300);
  h.log('undo-all bar:', await h.eval(`document.getElementById('fcUndoAll').innerText.replace(/\s+/g, ' ')`));
  await h.eval(`(() => { document.getElementById('fcUndoAllBtn').click(); return true; })()`);
  await h.waitFor("!!document.getElementById('sftkConfirmGo')", 30000, 200);
  await h.sleep(400);
  await h.eval(`(() => { const a = document.getElementById('sftkConfirmAck'); if (a && !a.checked) a.click(); document.getElementById('sftkConfirmGo').click(); return true; })()`);
  await h.waitFor("!!document.querySelector('#fcUndoAll .fc-undoall-done')", 900000, 1000);
  const und = await h.eval(`document.getElementById('fcUndoAll').innerText.replace(/\s+/g, ' ')`);
  h.log('undo all:', und);
  if (!new RegExp(fixed.length + ' of ' + fixed.length + ' change').test(und)) throw new Error('FAILED: every change of the run must be undone — ' + und);
  h.log(`✓ fc-plan RUN on ${ORG}: ${fixed.length} done without a second question, then undone`);
}
