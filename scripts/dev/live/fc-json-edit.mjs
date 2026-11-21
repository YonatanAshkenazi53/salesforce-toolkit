// LIVE, WRITES to an org and undoes it in the same run: ✎ Edit XML on a page layout and on a Lightning page in Field
// Cleaner's 🔍 (backlog 2026-11-08: "✎ Edit for the Tooling Metadata JSON kinds"). Per kind: open 🔍 → ✎ Edit XML →
//   1. malformed XML → the box says so, Deploy stays off;  2. ✓ Validate on a real edit (nothing written);
//   3. deploy the edit → the 🔍 opens again with the note, the CLI reads the change;  4. ↩ Undo in Activity → the CLI
//   reads the original back.
// The edit is a marker appended to the first section label (layout) or to the page's label (Lightning page).
// ORG / OBJ / FIELD pick the field (default npc · Account · SFTK_Live_Blk__c). KINDS=Layout,FlexiPage. DARK=1.
import { execSync } from 'node:child_process';
const ORG = process.env.ORG || 'npc', OBJ = process.env.OBJ || 'Account', FIELD = process.env.FIELD || 'SFTK_Live_Blk__c';
const KINDS = (process.env.KINDS || 'Layout,FlexiPage').split(',');
const MARK = ' sftk-edit';
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
const confirm = async h => { await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 20000, 200); await h.eval(`(() => { const a = document.getElementById('sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`); await h.sleep(300); await h.eval("document.getElementById('sftkConfirmGo').click()"); };
const dark = async (h, on) => { await h.eval(`(() => { if (!document.getElementById('noTrans')) { const st = document.createElement('style'); st.id = 'noTrans'; st.textContent = '*{transition:none!important}'; document.head.appendChild(st); } document.body.classList.toggle('sftk-dark', ${on}); return true; })()`); await h.sleep(350); };
const shot = async (h, name) => { await h.shot(h.shots + `/${name}.png`); if (process.env.DARK === '1') { await dark(h, true); await h.shot(h.shots + `/${name}-dark.png`); await dark(h, false); } };
// what the org holds, read by the CLI (Tooling): the label the edit touches
const cliLabel = (kind, id) => {
  try {
    const out = execSync(`sf data query --use-tooling-api -o ${ORG} --json -q "SELECT Metadata FROM ${kind} WHERE Id = '${id}'"`, { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const md = JSON.parse(out.slice(out.indexOf('{'))).result.records[0].Metadata;
    return kind === 'Layout' ? (md.layoutSections || []).map(s => s.label).join(' | ') : md.masterLabel;
  } catch (e) { return '? ' + String(e.message).split('\n')[0]; }
};
// the marker is appended — or, when a run was cut short and left it there, taken off (NOUNDO=1 then leaves the org clean)
const flip = b => b.endsWith(MARK) ? b.slice(0, -MARK.length) : b + MARK;
const editOf = (kind, xml) => kind === 'Layout'
  ? xml.replace(/(<layoutSections>[\s\S]*?<label>)([^<]*)(<\/label>)/, (m, a, b, c) => a + flip(b) + c)
  : xml.replace(/(<masterLabel>)([^<]*)(<\/masterLabel>)/, (m, a, b, c) => a + flip(b) + c);
const WHAT = { Layout: 'page layout', FlexiPage: 'Lightning page' };

export default async function (h) {
  await h.login(ORG); await h.popup('fields'); await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', OBJ);
  await pick(h, '#fcFieldInput', '#fcFieldDrop', FIELD);
  await h.eval(`document.querySelector('#fcScanBtn').click()`);
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000); await h.sleep(1500);
  const rows = await h.eval(`[...document.querySelectorAll('.fc-inspect-btn[data-id]')].map(b => ({ id: b.dataset.id, type: b.dataset.type || b.closest('[data-type]')?.dataset.type || '', name: b.dataset.name || b.closest('[data-name]')?.dataset.name || '' }))`);
  h.log('rows with 🔍:', JSON.stringify(rows.reduce((m, r) => { m[r.type] = (m[r.type] || 0) + 1; return m; }, {})));
  h.log('✎ on a flow is not offered:', await h.eval("typeof sftkMdJsonKindEditSpec === 'function' && sftkMdJsonKindEditSpec('Flow') === null"));
  for (const kind of KINDS) {
    const row = rows.find(r => r.type === kind);
    if (!row) { h.log(`── ${kind}: no row of this kind uses ${OBJ}.${FIELD} — skipped`); continue; }
    h.log(`── ${kind}: “${row.name}” ${row.id} · CLI before:`, cliLabel(kind, row.id));
    const panel = `document.getElementById('fcXml_${row.id}')`;
    await h.eval(`document.querySelector('.fc-inspect-btn[data-id="${row.id}"]').click()`);
    await h.waitFor(`!!${panel} && !!${panel}.querySelector('.fc-xml-hdr')`, 90000, 400);
    h.log('🔍 header buttons:', await h.eval(`[...${panel}.querySelectorAll('.fc-xml-hdr-actions button')].map(b => b.textContent.trim()).join(' · ')`));
    await h.eval(`${panel}.scrollIntoView({ block: 'start' })`); await h.sleep(300);
    await shot(h, `jed-${kind}-1-inspector`);
    await h.eval(`${panel}.querySelector('.fc-xml-edit-btn').click()`);
    await h.waitFor(`!!${panel}.querySelector('.fc-xml-ta') || !!document.querySelector('.fc-inline-error')`, 90000, 300);
    if (!(await h.eval(`!!${panel}.querySelector('.fc-xml-ta')`))) { h.log('the editor did not open:', await h.eval("document.querySelector('.fc-inline-error')?.innerText || ''")); continue; }
    const type = async text => { await h.eval(`(() => { const ta = ${panel}.querySelector('.fc-xml-ta'); ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await h.sleep(300); };
    const state = () => h.eval(`(() => { const p = ${panel}; return { state: p.querySelector('.fc-xml-ed-state')?.textContent, deployOff: p.querySelector('.fc-xml-ed-deploy')?.disabled, out: (p.querySelector('.fc-xml-ed-out')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 300) }; })()`);
    const orig = await h.eval(`${panel}.querySelector('.fc-xml-ta').value`);
    h.log('editor: ', orig.split('\n').length, 'lines · header:', (await h.eval(`${panel}.querySelector('.fc-xml-hdr-name').innerText`)).replace(/\s+/g, ' '), '· hint:', (await h.eval(`${panel}.querySelector('.fc-xml-ed-hint').innerText`)).slice(0, 160));
    await shot(h, `jed-${kind}-2-editor`);
    // 1. malformed
    await type(orig.replace('</fullName>', '</fullNam>'));
    h.log('1 malformed:', JSON.stringify(await state()));
    // 2. validate the real edit
    const edited = editOf(kind, orig);
    if (edited === orig) { h.log('no label to edit in this XML — skipped'); continue; }
    await type(edited);
    h.log('2 edit, before:', JSON.stringify(await state()));
    await h.eval(`${panel}.querySelector('.fc-xml-ed-validate').click()`);
    await h.waitFor(`/would accept|would refuse|could not be run/.test(${panel}.querySelector('.fc-xml-ed-out')?.innerText || '')`, 240000, 500);
    h.log('2 ✓ Validate:', JSON.stringify(await state()), '· CLI (nothing written):', cliLabel(kind, row.id));
    if (/would refuse|could not/.test((await state()).out)) { await shot(h, `jed-${kind}-3-refused`); continue; }
    // 3. deploy
    await h.eval(`${panel}.querySelector('.fc-xml-ed-deploy').click()`);
    await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 20000, 200);
    h.log('dialog:', (await h.eval(`document.querySelector('.sftk-confirm, [role=dialog]')?.innerText || ''`)).replace(/\s+/g, ' ').slice(0, 420));
    await shot(h, `jed-${kind}-3-dialog`);
    await confirm(h);
    await h.waitFor(`!!${panel}.querySelector('.fc-xml-ed-done') || /refused|accepted|Not deployed/.test(${panel}.querySelector('.fc-xml-ed-out')?.innerText || '')`, 300000, 500);
    await h.sleep(800);
    h.log('3 after deploy:', (await h.eval(`(${panel}.querySelector('.fc-xml-ed-done')?.innerText || ${panel}.querySelector('.fc-xml-ed-out')?.innerText || '').replace(/\\s+/g, ' ')`)).slice(0, 300), '· back in 🔍:', await h.eval(`!${panel}.querySelector('.fc-xml-ta') && [...${panel}.querySelectorAll('.fc-xml-hdr-actions button')].map(b => b.textContent.trim()).join(' · ')`));
    await h.eval(`${panel}.scrollIntoView({ block: 'start' })`); await h.sleep(300);
    await shot(h, `jed-${kind}-4-deployed`);
    h.log('CLI after the edit:', cliLabel(kind, row.id));
    // 4. undo
    if (process.env.NOUNDO === '1') { h.log('NOUNDO: left as deployed'); continue; }
    const ent = (await h.eval(`sftkHistoryAll().then(all => all.filter(e => e && e.kind === 'tool' && (e.profileName || '').startsWith('✎ XML edited — ${WHAT[kind]} ') && e.toolUndo && !('none' in e.toolUndo)).map(e => ({ id: e.id, name: e.profileName })))`))[0];
    h.log('Activity entry:', JSON.stringify(ent));
    if (ent) { const p = h.eval(`sftkHistoryUndo(${JSON.stringify(ent.id)}).then(r => JSON.stringify(r).slice(0, 260))`); await confirm(h); h.log('↩ undo →', await p); }
    h.log('CLI after undo:', cliLabel(kind, row.id));
    await h.eval(`(() => { const p = ${panel}; if (p && p.style.display !== 'none') p.querySelector('.fc-xml-close')?.click(); return true; })()`);
  }
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 3)')).slice(0, 300));
}
