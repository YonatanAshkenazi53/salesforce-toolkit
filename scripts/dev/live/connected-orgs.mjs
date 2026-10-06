// Live: Data Studio › Connected Orgs end to end on trailheads5 —
//   • the row (connected, type badge), Rename → the new label shows, renamed back
//   • 🔒 Lock writes → a real write attempt (⏻ Flow switches OFF on the fixture flows)
//     is REFUSED by the service worker, the CLI shows the flows still active → unlock
//   • 🛑 Guard as production → the same write asks for the typed org name; cancelled
//     there, nothing written (CLI) → unguarded
// Nothing in the org changes. The extension's own storage ends as it began.
import { execFileSync } from 'node:child_process';
const NL = String.fromCharCode(10);
const lines = (s, n = 2500) => String(s || '').slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const fsStatus = () => (JSON.parse(execFileSync('sf', ['data', 'query', '-o', 'npc', '--use-tooling-api', '--json', '-q',
  `"SELECT Definition.DeveloperName, Status FROM Flow WHERE Definition.DeveloperName LIKE 'SFTK_FS_Test%' AND Status = 'Active'"`],
  { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).result.records || []).map(r => r.Definition.DeveloperName).sort().join(',');

async function rowFor(h, host) {
  return h.eval(`(() => { const r = [...document.querySelectorAll('.ds-org-row')].find(r => r.querySelector('.ds-org-row-url')?.innerText.includes(${JSON.stringify(host)})); return r ? r.innerText.replace(/\\s+/g, ' ').trim() : null; })()`);
}
async function press(h, host, action) {
  const ok = await h.eval(`(() => { const r = [...document.querySelectorAll('.ds-org-row')].find(r => r.querySelector('.ds-org-row-url')?.innerText.includes(${JSON.stringify(host)})); const b = r && r.querySelector('[data-dsaction="${action}"]'); if (!b) return false; b.click(); return true; })()`);
  if (!ok) throw new Error(`no ${action} button on the ${host} row`);
  await h.sleep(900);
}
// ⏻ Flow switches OFF on the fixture flows, up to the Go click; returns what the panel reports
async function tryFlowSwitchOff(h, { expectTyped }) {
  await h.popup('dependencies');
  await h.waitFor("!!document.querySelector('#depBulkBtn')", 240000, 1000);
  await h.sleep(800);
  await h.eval("document.querySelector('#depBulkBtn').click()");
  await h.waitFor("document.querySelectorAll('.dep-fb-cb').length > 0", 300000, 1000);
  await h.sleep(1000);
  const ticked = await h.eval("(() => { let n = 0; document.querySelectorAll('.dep-fb-cb').forEach(c => { if (/^SFTK_FS_Test/.test(c.value) && !c.disabled && !c.checked) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); n++; } }); return n; })()");
  h.log(`ticked ${ticked} fixture flow(s) · ${await h.text('#depFbCount')}`);
  await h.eval("document.querySelector('#depFbOff')?.click()");
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 120000, 500);
  await h.sleep(500);
  h.log('CONFIRM:', lines(await h.text('#modalBox'), 700));
  await h.eval("(() => { const i = document.querySelector('#sftkConfirmWord'); i.value = 'OFF'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  await h.sleep(300);
  await h.eval("document.querySelector('#sftkConfirmGo')?.click()");
  await h.sleep(800);
  const typed = await h.eval("!!document.querySelector('#sftkConfirmProd')");
  h.log(`typed org-name gate shown: ${typed} (expected ${expectTyped})`);
  if (typed !== expectTyped) throw new Error(`the typed gate ${typed ? 'appeared' : 'did not appear'}`);
  if (typed) {
    h.log('TYPED GATE:', lines(await h.text('#modalBox'), 600));
    const goDisabled = await h.eval("document.querySelector('#sftkConfirmProdGo')?.disabled");
    await h.eval("(() => { const i = document.querySelector('#sftkConfirmProd'); i.value = 'wrong name'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
    await h.sleep(300);
    h.log(`Go disabled empty: ${goDisabled} · with a wrong name: ${await h.eval("document.querySelector('#sftkConfirmProdGo')?.disabled")}`);
    await h.eval("document.querySelector('#sftkConfirmProdCancel')?.click()");
    await h.sleep(800);
    h.log('cancelled at the typed gate · dialog gone:', await h.eval("!document.querySelector('#sftkConfirmProd') && !document.querySelector('#sftkConfirmGo')"));
    return '(cancelled)';
  }
  await h.waitFor("/switched (OFF|ON)|❌|refused|read-only|locked|blocked/i.test(document.querySelector('#depFbOut')?.innerText || '')", 300000, 1000);
  await h.sleep(800);
  const out = lines(await h.text('#depFbOut'), 1500);
  h.log('REPORT:', out);
  return out;
}

export default async function (h) {
  const activeBefore = fsStatus();
  h.log('CLI: active fixture flows before:', activeBefore);
  await h.login('npc');
  await h.studio('#/orgs');
  await h.watchErrors();
  await h.waitFor("document.querySelectorAll('.ds-org-row').length > 0", 60000, 500);
  await h.sleep(1500);
  const host = 'trailheads5';
  h.log('HEADER:', lines(await h.eval("document.querySelector('.ds-view-header, .ds-vh, #dsMain h1')?.parentElement?.innerText || ''"), 300));
  h.log('ROW before:', await rowFor(h, host));
  const orgUrl = await h.eval(`(() => { const r = [...document.querySelectorAll('.ds-org-row')].find(r => r.querySelector('.ds-org-row-url')?.innerText.includes(${JSON.stringify(host)})); return r?.querySelector('[data-dsaction="editOrgLabel"]')?.dataset.arg || ''; })()`);
  const stored = await h.eval("new Promise(r => chrome.storage.local.get('sftk_orgs', d => r(d.sftk_orgs || {})))");
  const mine = stored[orgUrl] || {};
  h.log(`stored flags for ${orgUrl}: label=${mine.label || '(none)'} readOnly=${!!mine.readOnly} guardAsProd=${!!mine.guardAsProd}`);
  if (mine.readOnly || mine.guardAsProd) throw new Error('the org already carries a lock or guard — clear it first');

  // ── Rename ──
  await press(h, host, 'editOrgLabel');
  h.log('RENAME DIALOG:', lines(await h.text('#dsModalBox'), 300));
  await h.eval("(() => { const i = document.querySelector('#dsOrgLabelInput'); i.value = 'QA Label Test'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#dsOrgLabelSave').click(); return true; })()");
  await h.sleep(800);
  const renamed = await rowFor(h, host);
  h.log('ROW renamed:', renamed);
  if (!/QA Label Test/.test(renamed)) throw new Error('the new label is not shown');
  await press(h, host, 'editOrgLabel');
  await h.eval(`(() => { const i = document.querySelector('#dsOrgLabelInput'); i.value = ${JSON.stringify(mine.label || 'trailheads5')}; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#dsOrgLabelSave').click(); return true; })()`);
  await h.sleep(800);
  h.log('ROW renamed back:', await rowFor(h, host));

  // ── Lock writes → a write is refused ──
  await press(h, host, 'toggleReadOnly');
  h.log('TOAST:', lines(await h.eval("document.querySelector('.ds-toast, #dsToast')?.innerText || ''"), 300));
  const locked = await rowFor(h, host);
  h.log('ROW locked:', locked);
  if (!/writes locked/.test(locked)) throw new Error('the row does not say writes locked');
  const out = await tryFlowSwitchOff(h, { expectTyped: false });
  if (!/read-only|locked|blocked|❌/i.test(out)) throw new Error('the locked write was not refused: ' + out);
  const activeAfterLock = fsStatus();
  h.log('CLI: active fixture flows after the refused write:', activeAfterLock);
  if (activeAfterLock !== activeBefore) throw new Error('the lock did not hold — the org changed');
  await h.studio('#/orgs');
  await h.waitFor("document.querySelectorAll('.ds-org-row').length > 0", 60000, 500);
  await h.sleep(1000);
  await press(h, host, 'toggleReadOnly');
  h.log('ROW unlocked:', await rowFor(h, host));

  // ── Guard as production → the typed name ──
  await press(h, host, 'toggleGuardProd');
  const guarded = await rowFor(h, host);
  h.log('ROW guarded:', guarded);
  if (!/Guarded as production/.test(guarded)) throw new Error('the row does not say guarded');
  await tryFlowSwitchOff(h, { expectTyped: true });
  const activeAfterGuard = fsStatus();
  h.log('CLI: active fixture flows after the cancelled gate:', activeAfterGuard);
  if (activeAfterGuard !== activeBefore) throw new Error('the cancelled typed gate wrote something');
  await h.studio('#/orgs');
  await h.waitFor("document.querySelectorAll('.ds-org-row').length > 0", 60000, 500);
  await h.sleep(1000);
  await press(h, host, 'toggleGuardProd');
  const final = await rowFor(h, host);
  h.log('ROW final:', final);
  const after = await h.eval("new Promise(r => chrome.storage.local.get('sftk_orgs', d => r(d.sftk_orgs || {})))");
  const m2 = after[orgUrl] || {};
  h.log(`stored flags after: label=${m2.label || '(none)'} readOnly=${!!m2.readOnly} guardAsProd=${!!m2.guardAsProd}`);
  if (m2.readOnly || m2.guardAsProd || (m2.label || '') !== (mine.label || '')) throw new Error('the org flags did not return to their start');
  h.log('✓ end to end: rename shown and reverted; lock refused a real write (org unchanged); guard demanded the typed name and a cancel wrote nothing');
}
