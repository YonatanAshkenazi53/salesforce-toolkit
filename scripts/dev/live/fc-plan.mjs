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
  // the tool's Activity window: everything that acts is on top, a card can be deleted (asked on the card)
  await h.eval(`(() => { window.sftkToolHistoryOpen('fields'); return true; })()`);
  await h.waitFor("!!document.querySelector('#sftkThModalList .sftk-th-card')", 30000, 200);
  await h.sleep(400);
  h.log('activity:', await h.eval(`document.getElementById('sftkThCount').textContent + ' | top buttons: ' + [...document.querySelectorAll('.sftk-th-tools button')].filter(b => b.style.display !== 'none').map(b => b.textContent.trim()).join(' · ')`));
  await both(h, TAG + '-7-activity');
  await h.eval(`(() => { document.querySelector('#sftkThModalList [data-th-del]').click(); return true; })()`);
  await h.sleep(300);
  h.log('delete asks:', await h.eval(`(document.querySelector('.sftk-th-ask') || {}).textContent || ''`));
  await both(h, TAG + '-8-activity-delete');
  await h.eval(`(() => { document.querySelector('[data-th-del-no]').click(); return true; })()`);
  await h.eval(`(() => { const f = document.getElementById('sftkThFind'); f.value = 'lookup'; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.sleep(400);
  h.log('filter "lookup":', await h.eval(`document.getElementById('sftkThCount').textContent`));
  await h.eval(`(() => { document.getElementById('sftkThClose').click(); return true; })()`);
  await h.sleep(400);
  if (process.env.UNDO === '0') return;
  // ↩ Undo all takes every change of the run back (the list is scanned again afterwards)
  await h.waitFor("!!document.getElementById('fcUndoAllBtn')", 60000, 300);
  // the header carries ↩ Undo all too; it is the one pressed here
  await h.waitFor("!!document.querySelector('.fc-undoall-top')", 30000, 300);
  await h.eval(`(() => { document.getElementById('fcFixEvery').scrollIntoView({ block: 'center' }); return true; })()`);
  h.log('header:', await h.eval(`document.getElementById('fcFixEvery').innerText.replace(/\s+/g, ' ')`));
  await both(h, TAG + '-9-header-undo');
  h.log('undo-all bar:', await h.eval(`document.getElementById('fcUndoAll').innerText.replace(/\s+/g, ' ')`));
  await h.eval(`(() => { document.querySelector('.fc-undoall-top').click(); return true; })()`);
  await h.waitFor("!!document.getElementById('sftkConfirmGo')", 30000, 200);
  await h.sleep(400);
  // which ones: every change has its tick; the button follows
  const us = () => h.eval(`(() => ({ count: document.getElementById('fcUsCount').textContent, go: document.getElementById('sftkConfirmGo').textContent.trim(), off: document.getElementById('sftkConfirmGo').disabled, rows: [...document.querySelectorAll('.fc-us-row')].map(r => r.innerText.replace(/\s+/g, ' ').trim()) }))()`);
  const u0 = await us();
  h.log('undo dialog:', u0.count, '·', u0.go, '· rows:', JSON.stringify(u0.rows));
  await both(h, TAG + '-10-undo-dialog');
  await h.eval(`(() => { document.querySelector('.fc-us-tick').click(); return true; })()`);
  const u1 = await us();
  h.log('one unticked:', u1.count, '·', u1.go);
  if (u1.go === u0.go) throw new Error('FAILED: the button must say how many are ticked');
  await h.eval(`(() => { document.getElementById('fcUsNone').click(); document.getElementById('sftkConfirmAck').click(); return true; })()`);
  await h.sleep(200);
  const u2 = await us();
  h.log('none ticked, acknowledged:', u2.go, '· button off:', u2.off);
  if (!u2.off) throw new Error('FAILED: nothing ticked must keep the button off');
  await h.eval(`(() => { document.getElementById('sftkConfirmAck').click(); document.getElementById('fcUsAll').click(); return true; })()`);
  await h.eval(`(() => { const a = document.getElementById('sftkConfirmAck'); if (a && !a.checked) a.click(); document.getElementById('sftkConfirmGo').click(); return true; })()`);
  await h.waitFor("!!document.querySelector('#fcUndoAll .sftk-prog')", 30000, 100);
  await h.eval(`(() => { document.getElementById('fcUndoAll').scrollIntoView({ block: 'center' }); return true; })()`);
  await both(h, TAG + '-6-undoing');
  await h.waitFor("!!document.querySelector('#fcUndoAll .fc-undoall-done')", 900000, 1000);
  const und = await h.eval(`document.getElementById('fcUndoAll').innerText.replace(/\s+/g, ' ')`);
  h.log('undo all:', und);
  if (!new RegExp(fixed.length + ' of ' + fixed.length + ' change').test(und)) throw new Error('FAILED: every change of the run must be undone — ' + und);
  h.log(`✓ fc-plan RUN on ${ORG}: ${fixed.length} done without a second question, then undone`);
}
