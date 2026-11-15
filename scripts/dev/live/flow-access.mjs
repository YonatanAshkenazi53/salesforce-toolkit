// Live: 🔑 Flow Access (popup) — grant the fixture flow SFTK_AV_Test_A to the permission set
// SFTK_FC_Test_Access on npc, then CLI-verify.
// WHY the CLI rows (2026-11-15): the grant used to be a Metadata deploy of a PARTIAL PermissionSet, which wiped the
// set's description and its field permissions. So the script reads the set by CLI before, after the grant and after
// the Undo — description, FieldPermissions, ObjectPermissions and the flow rows — and fails when anything but the
// flow row moved.
//   FLOW="SFTK AV Test A"  PS="SFTK FC Test Access"  SCAN_ONLY=1
import { execFileSync } from 'node:child_process';
import { undoNewest } from './_undo.mjs';   // UNDO=1: Data Studio › History › ↩ Undo the newest entry afterwards (TYPE_IT=1 for a guarded org)
const dump = async (h, sel, n = 2500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
async function tick(h, cbClass, searchId, label) {
  await h.eval(`(() => { const i = document.querySelector('#${searchId}'); if (i) { i.value = ${JSON.stringify(label)}; i.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`);
  await h.sleep(700);
  return h.eval(`(() => { const rows = [...document.querySelectorAll('.${cbClass}')]; const c = rows.find(x => (x.closest('label, li, div')?.innerText || '').includes(${JSON.stringify(label)})); if (!c) return 'not found among ' + rows.length; c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return 'ticked ' + (c.closest('label, li, div')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 80); })()`);
}
const cliQ = q => { const t = execFileSync('sf', ['data', 'query', '-o', 'npc', '--json', '-q', `"${q}"`], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return JSON.parse(t.slice(t.indexOf('{'))).result.records || []; };
// the permission set as the org holds it: what must NOT move (description, FLS, object rows) and what must (the flow rows)
function readSet(apiName) {
  const ps = cliQ(`SELECT Id, Label, Description FROM PermissionSet WHERE Name = '${apiName}'`)[0];
  if (!ps) return null;
  return {
    description: ps.Description, label: ps.Label,
    fls: cliQ(`SELECT Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId = '${ps.Id}' ORDER BY Field`).map(r => `${r.Field} read=${r.PermissionsRead} edit=${r.PermissionsEdit}`),
    objects: cliQ(`SELECT SobjectType, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete FROM ObjectPermissions WHERE ParentId = '${ps.Id}' ORDER BY SobjectType`).map(r => `${r.SobjectType} r=${r.PermissionsRead} c=${r.PermissionsCreate} e=${r.PermissionsEdit} d=${r.PermissionsDelete}`),
    // by the FlowDefinition key prefix (300), NOT by SetupEntityType = 'Flow': the grant is stored as type FlowDefinition
    flowRows: cliQ(`SELECT SetupEntityId, SetupEntityType FROM SetupEntityAccess WHERE ParentId = '${ps.Id}' ORDER BY SetupEntityId`).filter(r => String(r.SetupEntityId).startsWith('300')).map(r => `${r.SetupEntityType}:${r.SetupEntityId}`),
  };
}
const kept = (a, b) => a.description === b.description && a.label === b.label && JSON.stringify(a.fls) === JSON.stringify(b.fls) && JSON.stringify(a.objects) === JSON.stringify(b.objects);
export default async function (h) {
  const PS_API = (process.env.PS || 'SFTK FC Test Access').replace(/ /g, '_');
  const before = process.env.SCAN_ONLY === '1' ? null : readSet(PS_API);
  if (before) h.log('CLI BEFORE:', JSON.stringify(before));
  await h.login('npc');
  await h.popup('flow-access');
  await h.watchErrors();
  await h.waitFor("document.querySelectorAll('.fp-flow-cb').length > 0 && document.querySelectorAll('.fp-ps-cb').length > 0", 240000, 1000);
  await h.sleep(800);
  h.log('counts:', await dump(h, '#fpFlowCount', 80), '/', await dump(h, '#fpPsCount', 80));
  h.log('flow:', await tick(h, 'fp-flow-cb', 'fpFlowSearch', process.env.FLOW || 'SFTK AV Test A'));
  h.log('permset:', await tick(h, 'fp-ps-cb', 'fpPsSearch', process.env.PS || 'SFTK FC Test Access'));
  await h.sleep(500);
  h.log('summary:', await dump(h, '#fpActionSummary', 300), '| assign:', await h.eval(`(() => { const b = document.querySelector('#fpAssignBtn'); return b.textContent.trim() + (b.disabled ? ' (off)' : ''); })()`));
  await h.eval(`document.querySelector('#fpAssignBtn').click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 300); await h.sleep(300);
  h.log('CONFIRM:', await h.eval(`(document.querySelector('#modalBox')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 800)`));
  await h.shot(h.shots + '/fa-confirm.png');
  if (process.env.SCAN_ONLY === '1') { await h.eval(`document.querySelector('#sftkConfirmCancel')?.click()`); h.log('SCAN_ONLY — cancelled'); return; }
  await h.eval(`document.querySelector('#sftkConfirmGo').click()`);
  await h.sleep(400);
  if (await h.eval(`!!document.querySelector('#sftkConfirmProd')`)) {
    h.log('TYPED GATE (production):', await dump(h, '#modalBox', 500));
    await h.eval(`(() => { const i = document.querySelector('#sftkConfirmProd'); i.value = i.placeholder; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await h.eval(`document.querySelector('#sftkConfirmProdGo')?.click()`);
  }
  await h.waitFor("/Assigned|assigned|failed/.test(document.querySelector('#modalBox')?.innerText || '') && !/Deploying/.test(document.querySelector('#fpActionSummary')?.innerText || '')", 300000, 1000);
  await h.sleep(800);
  h.log('RESULT:', await h.eval(`(document.querySelector('#modalBox')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 800)`));
  await h.shot(h.shots + '/fa-result.png');
  const granted = readSet(PS_API);
  h.log('CLI AFTER THE GRANT:', JSON.stringify(granted));
  const grantOk = granted.flowRows.length === before.flowRows.length + 1, keptOk = kept(before, granted);
  h.log(grantOk ? '✓' : '❌', 'flow access granted (one more flow row)', '|', keptOk ? '✓' : '❌', 'description, label, field and object permissions unchanged');
  let undoOk = true;
  if (process.env.UNDO === '1') {
    await undoNewest(h);
    const undone = readSet(PS_API);
    h.log('CLI AFTER THE UNDO:', JSON.stringify(undone));
    undoOk = JSON.stringify(undone) === JSON.stringify(before);
    h.log(undoOk ? '✓' : '❌', 'after the Undo the set is exactly as before');
  }
  if (!grantOk || !keptOk || !undoOk) throw new Error('Flow Access changed more than the flow row, or the Undo did not put it back');
}
