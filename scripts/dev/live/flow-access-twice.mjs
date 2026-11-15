// Live: 🔑 Flow Access — grant → ↩ Undo → grant AGAIN on the SAME page → ↩ Undo.
// WHY (2026-11-15): after an Undo from the tool's own 🧾 History the page still held the access map it loaded
// before the Undo, so the second Assign skipped the pair as "already granted", sent nothing and said Salesforce had
// accepted it. The second grant here is made WITHOUT reloading the page, and every step is read back by CLI:
// the flow row must come and go, description / label / field and object permissions must never move.
import { execFileSync } from 'node:child_process';
import { undoNewest } from './_undo.mjs';
const flat = s => String(s || '').replace(/\s+/g, ' ').trim();
const cliQ = q => { const t = execFileSync('sf', ['data', 'query', '-o', 'npc', '--json', '-q', `"${q}"`], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return JSON.parse(t.slice(t.indexOf('{'))).result.records || []; };
function readSet(apiName) {
  const ps = cliQ(`SELECT Id, Label, Description FROM PermissionSet WHERE Name = '${apiName}'`)[0];
  if (!ps) throw new Error('no permission set ' + apiName);
  return {
    description: ps.Description, label: ps.Label,
    fls: cliQ(`SELECT Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId = '${ps.Id}' ORDER BY Field`).map(r => `${r.Field} read=${r.PermissionsRead} edit=${r.PermissionsEdit}`),
    objects: cliQ(`SELECT SobjectType, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete FROM ObjectPermissions WHERE ParentId = '${ps.Id}' ORDER BY SobjectType`).map(r => `${r.SobjectType} r=${r.PermissionsRead} c=${r.PermissionsCreate} e=${r.PermissionsEdit} d=${r.PermissionsDelete}`),
    flowRows: cliQ(`SELECT SetupEntityId, SetupEntityType FROM SetupEntityAccess WHERE ParentId = '${ps.Id}' ORDER BY SetupEntityId`).filter(r => String(r.SetupEntityId).startsWith('300')).map(r => `${r.SetupEntityType}:${r.SetupEntityId}`),
  };
}
const kept = (a, b) => a.description === b.description && a.label === b.label && JSON.stringify(a.fls) === JSON.stringify(b.fls) && JSON.stringify(a.objects) === JSON.stringify(b.objects);
async function tick(h, cbClass, searchId, label) {
  await h.eval(`(() => { const i = document.querySelector('#${searchId}'); if (i) { i.value = ${JSON.stringify(label)}; i.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`);
  await h.sleep(700);
  return h.eval(`(() => { const rows = [...document.querySelectorAll('.${cbClass}')]; const c = rows.find(x => (x.closest('label, li, div')?.innerText || '').includes(${JSON.stringify(label)})); if (!c) return 'not found among ' + rows.length; if (!c.checked) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); } return 'ticked ' + (c.closest('label, li, div')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 80); })()`);
}
async function grant(h, round) {
  h.log(`── GRANT ${round} ──`);
  h.log('flow:', await tick(h, 'fp-flow-cb', 'fpFlowSearch', 'SFTK AV Test A'));
  h.log('permset:', await tick(h, 'fp-ps-cb', 'fpPsSearch', 'SFTK FC Test Access'));
  await h.sleep(500);
  h.log('summary:', flat(await h.text('#fpActionSummary')), '| assign:', await h.eval(`(() => { const b = document.querySelector('#fpAssignBtn'); return b.textContent.trim() + (b.disabled ? ' (off)' : ''); })()`));
  await h.eval(`document.querySelector('#fpAssignBtn').click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 300); await h.sleep(300);
  h.log('CONFIRM:', flat(await h.text('#modalBox')).slice(0, 600));
  await h.eval(`document.querySelector('#sftkConfirmGo').click()`);
  await h.sleep(400);
  if (await h.eval(`!!document.querySelector('#sftkConfirmProd')`)) {
    await h.eval(`(() => { const i = document.querySelector('#sftkConfirmProd'); i.value = i.placeholder; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await h.eval(`document.querySelector('#sftkConfirmProdGo')?.click()`);
  }
  await h.waitFor("!!document.querySelector('#modalCancel') && !document.querySelector('#sftkConfirmGo') && !document.querySelector('#sftkConfirmProd')", 300000, 1000);
  await h.sleep(800);
  const said = flat(await h.text('#modalBox')).slice(0, 800);
  h.log(`RESULT ${round}:`, said);
  await h.shot(`${h.shots}/fa2-result-${round}.png`);
  await h.eval(`document.querySelector('#modalCancel')?.click()`);
  return said;
}
export default async function (h) {
  const PS = 'SFTK_FC_Test_Access';
  const before = readSet(PS);
  h.log('CLI BEFORE:', JSON.stringify(before));
  await h.login('npc');
  await h.popup('flow-access');
  await h.watchErrors();
  await h.waitFor("document.querySelectorAll('.fp-flow-cb').length > 0 && document.querySelectorAll('.fp-ps-cb').length > 0", 240000, 1000);
  await h.sleep(800);
  const bad = [];
  const step = (ok, what) => { h.log(ok ? '✓' : '❌', what); if (!ok) bad.push(what); };
  for (const round of [1, 2]) {
    const said = await grant(h, round);
    const g = readSet(PS);
    h.log(`CLI AFTER GRANT ${round}:`, JSON.stringify(g));
    step(g.flowRows.length === before.flowRows.length + 1, `grant ${round}: one more flow row in the org`);
    step(kept(before, g), `grant ${round}: description, label, field and object permissions unchanged`);
    step(!/nothing to do|Nothing was written/i.test(said), `grant ${round}: the result does not say nothing was written`);
    const undoSaid = await undoNewest(h);   // ends on popup.html?tab=flow-access with the History list open — the page's access map predates the Undo
    const u = readSet(PS);
    h.log(`CLI AFTER UNDO ${round}:`, JSON.stringify(u));
    step(JSON.stringify(u) === JSON.stringify(before), `undo ${round}: the set is exactly as before (${undoSaid.slice(0, 120)})`);
    if (round === 1) {
      // stay on THIS page: close the History list and wait for the tool's own lists
      await h.eval(`(() => { if (typeof closeModal === 'function') closeModal(); return true; })()`);
      await h.sleep(600);
      h.log('modal still open:', await h.eval(`!!(document.querySelector('#modalBox') && document.querySelector('#modalBox').offsetParent)`), '| lists:', await h.eval(`document.querySelectorAll('.fp-flow-cb').length + ' flows / ' + document.querySelectorAll('.fp-ps-cb').length + ' sets'`));
      await h.waitFor("document.querySelectorAll('.fp-flow-cb').length > 0 && document.querySelectorAll('.fp-ps-cb').length > 0", 240000, 1000);
    }
  }
  if (bad.length) throw new Error('FAILED: ' + bad.join(' · '));
  h.log('ALL OK — grant, undo, grant again on the same page, undo; the set ends exactly as it began');
}
