// LIVE, WRITES to npc (its own throwaway fixture, docs/fixtures/fc-undo-all — deploy it first, see its README):
// the 2026-11-15 Field Cleaner round on Account.SFTK_UA_Field__c —
//   1. ✎ XML editor on the rule SFTK_UA_VR2: malformed → Validate/Deploy stay off; a formula Salesforce refuses →
//      ✓ Validate says so and the CLI reads the rule unchanged; a real edit → ✓ Validate accepts and writes nothing,
//      ⬆ Deploy writes it (the CLI reads the new message)
//   2. 🗑 on both rules: the dialog asks for no "permanent" tick; each fixed row carries ↩ Undo; with the last
//      listed blocker cleared Salesforce is asked and Delete Field unlocks, with no Re-scan pressed
//   3. ↩ Undo all (3 changes): one confirmation, the progress while it runs, the summary, the re-scan; the CLI reads
//      both rules back with the ORIGINAL message
// DARK=1 shoots each state in dark too. The fixture is removed by the caller (cleanup/ of the fixture folder).
import { execSync } from 'node:child_process';
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
const confirm = async h => {
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 200);
  const hadAck = await h.eval(`(() => { const a = document.getElementById('sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return !!a; })()`);
  await h.sleep(250);
  await h.eval(`document.getElementById('sftkConfirmGo').click()`);
  return hadAck;
};
const dark = async (h, on) => { await h.eval(`(() => { if (!document.getElementById('noTrans')) { const st = document.createElement('style'); st.id = 'noTrans'; st.textContent = '*{transition:none!important}'; document.head.appendChild(st); } document.body.classList.toggle('sftk-dark', ${on ? 'true' : 'false'}); document.body.classList.remove('sftk-oled'); return true; })()`); await h.sleep(300); };
const shot2 = async (h, name) => { await h.shot(`${h.shots}/${name}.png`); if (process.env.DARK === '1') { await dark(h, true); await h.shot(`${h.shots}/${name}-dark.png`); await dark(h, false); } };
const cli = () => {
  try {
    const out = execSync('sf data query --use-tooling-api -o npc --json -q "SELECT ValidationName, Active, ErrorMessage FROM ValidationRule WHERE ValidationName LIKE \'SFTK_UA_VR%\' ORDER BY ValidationName"', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out).result.records.map(r => `${r.ValidationName} active=${r.Active} msg="${r.ErrorMessage}"`).join(' | ') || '(none)';
  } catch (e) { return 'CLI read failed: ' + String(e.message).slice(0, 120); }
};
const must = (ok, what) => { if (!ok) throw new Error('FAILED: ' + what); };

export default async function (h) {
  h.log('CLI before:', cli());
  await h.login('npc'); await h.popup('fields'); await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', 'Account');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', 'SFTK_UA_Field__c');
  const scan = async () => { await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000); await h.sleep(1500); };
  await h.eval(`document.querySelector('#fcScope [data-scope="blockers"]')?.click()`); await h.sleep(300);
  await h.eval(`document.querySelector('#fcScanBtn').click()`); await h.sleep(500);
  await scan();
  const idOf = name => h.eval(`(() => { const p = [...document.querySelectorAll('.fc-del-pair[data-type="ValidationRule"], .fc-fix-pair[data-type="ValidationRule"]')].find(x => x.dataset.name === ${JSON.stringify(name)}); return p ? p.dataset.id : null; })()`);
  const id1 = await idOf('SFTK_UA_VR1'), id2 = await idOf('SFTK_UA_VR2');
  h.log('rows:', id1, id2, '| undo-all bar at start:', JSON.stringify(await h.text('#fcUndoAll')));
  must(id1 && id2, 'both rules are listed by the scan');

  if (process.env.SKIP_EDIT !== '1') {
  // ── 1. the ✎ XML editor: Validate, then Deploy ──
  const panel = `document.getElementById('fcXml_${id2}')`;
  await h.eval(`document.querySelector('.fc-inspect-btn[data-id="${id2}"]').click()`);
  await h.waitFor(`!!${panel} && !!${panel}.querySelector('.fc-xml-edit-btn')`, 60000, 400);
  await h.eval(`${panel}.querySelector('.fc-xml-edit-btn').click()`);
  await h.waitFor(`!!${panel}.querySelector('.fc-xml-ta')`, 10000, 200);
  const type = async text => { await h.eval(`(() => { const ta = ${panel}.querySelector('.fc-xml-ta'); ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await h.sleep(300); };
  const state = () => h.eval(`(() => { const p = ${panel}; return { state: p.querySelector('.fc-xml-ed-state')?.textContent, validateOff: p.querySelector('.fc-xml-ed-validate')?.disabled, deployOff: p.querySelector('.fc-xml-ed-deploy')?.disabled, out: (p.querySelector('.fc-xml-ed-out')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 500) }; })()`);
  const validate = async () => { await h.eval(`${panel}.querySelector('.fc-xml-ed-validate').click()`); await h.waitFor(`/would accept|would refuse|could not be run|Not checked/.test(${panel}.querySelector('.fc-xml-ed-out')?.innerText || '')`, 240000, 500); return state(); };
  const orig = await h.eval(`${panel}.querySelector('.fc-xml-ta').value`);
  let st = await state();
  h.log('1a untouched:', JSON.stringify(st));
  must(st.validateOff && st.deployOff, 'Validate and Deploy are off before any change');
  await type(orig.replace('</errorMessage>', '</errorMesage>'));
  st = await state(); h.log('1b malformed:', JSON.stringify(st));
  must(st.validateOff && st.deployOff && /Not well-formed/.test(st.state), 'malformed XML keeps Validate and Deploy off');
  await type(orig.replace(/<errorConditionFormula>[\s\S]*?<\/errorConditionFormula>/, '<errorConditionFormula>ISBLANK(SFTK_UA_No_Such_Field__c)</errorConditionFormula>'));
  st = await validate(); h.log('1c bad formula, ✓ Validate:', JSON.stringify(st));
  must(/would refuse/.test(st.out), 'Validate reports the refusal in Salesforce\'s words');
  await h.eval(`${panel}.scrollIntoView({ block: 'start' })`); await h.sleep(300);
  await shot2(h, 'ua-1-validate-refused');
  h.log('CLI after the refused validate:', cli());
  must(/SFTK_UA_VR2 active=true msg="SFTK UA fixture rule 2"/.test(cli()), 'a refused validate changed nothing');
  await type(orig.replace('SFTK UA fixture rule 2</errorMessage>', 'SFTK UA fixture rule 2 (edited)</errorMessage>'));
  st = await validate(); h.log('1d good edit, ✓ Validate:', JSON.stringify(st));
  must(/would accept/.test(st.out) && !st.deployOff, 'Validate accepts the good edit and leaves Deploy on');
  await shot2(h, 'ua-2-validate-accepted');
  must(/SFTK_UA_VR2 active=true msg="SFTK UA fixture rule 2"(?! \(edited)/.test(cli()), 'an accepted validate wrote nothing');
  await h.eval(`${panel}.querySelector('.fc-xml-ed-deploy').click()`);
  await confirm(h);
  await h.waitFor(`!!${panel}.querySelector('.fc-xml-ed-done') || /Deployed|refused|accepted|Not deployed/.test(${panel}.innerText || '')`, 240000, 500);
  h.log('1e after ⬆ Deploy:', (await h.eval(`(${panel}.innerText || '').replace(/\\s+/g, ' ').slice(0, 260)`)));
  h.log('CLI after the deploy:', cli());
  must(/SFTK_UA_VR2 active=true msg="SFTK UA fixture rule 2 \(edited\)"/.test(cli()), 'the deployed edit is in the org');
  await h.sleep(1500);
  h.log('undo-all bar after 1 change:', JSON.stringify((await h.text('#fcUndoAll')).replace(/\s+/g, ' ')));

  }
  // ── 2. 🗑 both rules: no tick, ↩ Undo on the row, Delete unlocks ──
  for (const [name, id] of [['SFTK_UA_VR1', id1], ['SFTK_UA_VR2', id2]]) {
    await h.eval(`document.querySelector('.fc-del-btn[data-id="${id}"]').click()`);
    await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 200);
    if (name === 'SFTK_UA_VR1') { h.log('delete dialog:', (await h.eval(`(document.getElementById('modalBox')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 420)`))); await shot2(h, 'ua-3-delete-dialog'); }
    const hadAck = await confirm(h);
    must(!hadAck, `the delete dialog of ${name} asks for no "permanent" tick`);
    await h.waitFor(`document.getElementById('fcItem_${id}')?.classList.contains('fc-item-fixed') || !!document.querySelector('#fcItem_${id} .fc-inline-err, #fcErr_${id}')`, 240000, 500);
    const row = await h.eval(`(() => { const it = document.getElementById('fcItem_${id}'); return { text: (it.innerText || '').replace(/\\s+/g, ' ').slice(0, 200), undo: !!it.querySelector('.fc-item-undo'), fixed: it.classList.contains('fc-item-fixed') }; })()`);
    h.log(`2 ${name} row:`, JSON.stringify(row));
    must(row.fixed && row.undo, `${name} is marked done and carries ↩ Undo`);
  }
  h.log('2 open fix buttons after the deletes:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.fc-fix-btn:not([disabled])')].map(b => (b.className + ' | ' + (b.dataset.type || '') + ' | ' + (b.dataset.name || '') + ' | ' + (b.textContent || '').trim()).slice(0, 110))`)));
  for (let i = 0; i < 22; i++) {
    const t = await h.eval(`({ off: document.getElementById('fcDelBtn')?.disabled, note: document.getElementById('fcDeleteNote')?.textContent || '', ask: (document.getElementById('fcAskBox')?.innerText || '').replace(/\s+/g, ' ').slice(0, 150) })`);
    h.log('2 waiting for the unlock:', JSON.stringify(t));
    if (t.off === false) break;
    await h.sleep(20000);
  }
  const zone = await h.eval(`(() => ({ delOff: document.getElementById('fcDelBtn')?.disabled, hdr: document.querySelector('.fc-blockers-hdr')?.textContent || '', note: document.getElementById('fcDeleteNote')?.textContent || '', ask: (document.getElementById('fcAskBox')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 260) }))()`);
  h.log('2 delete zone:', JSON.stringify(zone));
  await h.eval(`document.querySelector('.fc-delete-zone')?.scrollIntoView({ block: 'center' })`); await h.sleep(300);
  await shot2(h, 'ua-4-delete-unlocked');
  must(zone.delOff === false, 'Delete Field is unlocked once the last listed blocker is cleared and Salesforce accepts');
  must(!/manual blocker\(s\) remain|still marks/.test(zone.note + zone.ask), 'no message still counts the cleared blockers');
  h.log('CLI after the deletes:', cli());

  // ── 3. ↩ Undo all ──
  await h.eval(`document.getElementById('fcUndoAll')?.scrollIntoView({ block: 'center' })`); await h.sleep(300);
  const bar = (await h.text('#fcUndoAll')).replace(/\s+/g, ' ');
  h.log('3 bar:', JSON.stringify(bar));
  must(/3 changes made here for Account\.SFTK_UA_Field__c can be undone/.test(bar), 'the bar counts the 3 changes of this field');
  await shot2(h, 'ua-5-bar');
  await h.eval(`document.getElementById('fcUndoAllBtn').click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 30000, 200);
  h.log('3 dialog:', (await h.eval(`(document.getElementById('modalBox')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 700)`)));
  await shot2(h, 'ua-6-undo-all-dialog');
  await confirm(h);
  await h.waitFor("!!document.querySelector('#fcUndoAll .fc-undoall-run')", 20000, 100);
  const seen = [];
  let shotDone = false;
  for (let i = 0; i < 600; i++) {
    const t = await h.eval(`(() => { const r = document.querySelector('#fcUndoAll .fc-undoall-run'); return r ? (r.innerText || '').replace(/\\s+/g, ' ').slice(0, 300) : ''; })()`);
    if (t && t !== seen[seen.length - 1]) { seen.push(t); if (!shotDone && /Undoing 2 of 3/.test(t)) { shotDone = true; await h.eval(`document.getElementById('fcUndoAll')?.scrollIntoView({ block: 'center' })`); await shot2(h, 'ua-7-undo-all-running'); } }
    if (await h.eval("!!document.querySelector('#fcUndoAll .fc-undoall-done')")) break;
    await h.sleep(400);
  }
  seen.forEach((t, i) => h.log(`3 progress ${i + 1}:`, t));
  must(seen.some(t => /Undoing 1 of 3/.test(t)) && seen.some(t => /Undoing [23] of 3/.test(t)), 'the progress names the change being undone, N of 3');
  const done = (await h.text('#fcUndoAll')).replace(/\s+/g, ' ');
  h.log('3 summary:', done.slice(0, 500));
  must(/3 of 3 changes undone and verified/.test(done), 'all 3 changes were undone and verified');
  await h.sleep(1000); await scan();
  await h.eval(`document.getElementById('fcUndoAll')?.scrollIntoView({ block: 'start' })`); await h.sleep(300);
  await shot2(h, 'ua-8-undo-all-done');
  const back = [await idOf('SFTK_UA_VR1'), await idOf('SFTK_UA_VR2')];
  h.log('3 rows after the re-scan:', JSON.stringify(back), '| bar:', JSON.stringify((await h.text('#fcUndoAll')).replace(/\s+/g, ' ').slice(0, 200)));
  const end = cli();
  h.log('CLI after Undo all:', end);
  must(/SFTK_UA_VR1 active=true msg="SFTK UA fixture rule 1"/.test(end) && /SFTK_UA_VR2 active=true msg="SFTK UA fixture rule 2"(?! \(edited)/.test(end), 'both rules are back, active, with the original message');
  must(back[0] && back[1], 'the re-scan lists both rules again');
  h.log('✓ fc-undo-all: Validate, Deploy, delete without the tick, row Undo, Delete unlock, Undo all with progress — all as expected');
}
