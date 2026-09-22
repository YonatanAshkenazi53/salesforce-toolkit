// Live: Picklist Manager (Data Studio), single-org mode, on the fixture picklist
// Account.SFTK_FC_Test_Status__c (New / Reviewed / Closed; 5 Accounts hold Closed, 3 Reviewed —
// scratchpad seed-pk.apex). Load the inventory, then one action through the wizard.
//   ORG=npc            org alias to log in (its label is matched in the org select)
//   OBJ=Account FIELD=SFTK_FC_Test_Status__c
//   ACTION=none|toggle|delete|fix   (default none = inventory only)
//   VALUE=Closed       the value the action is for
//   FIX=remap|clear|skip  TARGET=New   the data-fix choice inside the wizard
const dump = async (h, sel, n = 2500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
async function setSelect(h, sel, match) {
  return h.eval(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); if (!s) return 'no select'; const o = [...s.options].find(o => o.value === ${JSON.stringify(match)}) || [...s.options].find(o => (o.textContent + ' ' + o.value).includes(${JSON.stringify(match)})); if (!o) return 'no option for ' + ${JSON.stringify(match)} + ' among ' + [...s.options].map(o => o.value).slice(0, 8).join(','); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return 'set ' + o.value; })()`);
}
async function rows(h) {
  return h.eval(`[...document.querySelectorAll('#dsPkBody .ds-pk-row')].map(r => (r.dataset.pkVal || '?') + (r.classList.contains('ds-pk-row-inactive') ? ' [inactive]' : '') + ' records=' + (r.querySelector('.ds-pk-count')?.textContent || r.querySelector('.ds-pk-uncounted')?.textContent || '?') + ' rts=' + [...r.querySelectorAll('.ds-pk-rt')].map(e => e.textContent).join('/') + ' btns=' + [...r.querySelectorAll('button')].map(b => b.textContent.trim()).join('|'))`);
}
export default async function (h) {
  await h.login(process.env.ORG || 'npc');
  await h.studio('');
  await h.watchErrors();
  await h.eval(`document.querySelector('[data-view="picklists"]')?.click()`);
  await h.waitFor("!!document.querySelector('[data-pk-mode=\"single\"]')", 60000, 500);
  h.log('mode buttons:', JSON.stringify(await h.eval(`[...document.querySelectorAll('[data-pk-mode]')].map(b => b.dataset.pkMode + (b.classList.contains('ds-btn-primary') || b.classList.contains('active') ? '*' : ''))`)));
  await h.eval(`document.querySelector('[data-pk-mode="single"]')?.click()`);   // the view opens in the mode last used — compare by default
  await h.waitFor("!!document.querySelector('#dsPkOrg')", 60000, 500);
  await h.sleep(800);
  h.log('org options:', JSON.stringify(await h.eval(`[...document.querySelectorAll('#dsPkOrg option')].map(o => o.textContent.trim() + '=' + o.value)`)));
  h.log('org:', await setSelect(h, '#dsPkOrg', process.env.ORG === 'npc2' ? 'trailheads4' : 'trailheads2'));
  await h.waitFor("document.querySelectorAll('#dsPkObj option').length > 2", 120000, 500);
  h.log('object:', await setSelect(h, '#dsPkObj', process.env.OBJ || 'Account'));
  await h.waitFor("document.querySelectorAll('#dsPkField option').length > 1 && !/Loading/.test(document.querySelector('#dsPkField')?.innerText || '')", 120000, 500);
  h.log('field:', await setSelect(h, '#dsPkField', process.env.FIELD || 'SFTK_FC_Test_Status__c'));
  await h.sleep(400);
  h.log('cost line:', await dump(h, '#dsPkConfig', 400));
  await h.eval(`document.querySelector('#dsPkLoad')?.click()`);
  await h.waitFor("document.querySelectorAll('#dsPkBody .ds-pk-row').length > 0 || /could not|failed|error/i.test(document.querySelector('#dsPkBody')?.innerText || '')", 180000, 1000);
  await h.sleep(2500);   // usage counts + record types load after the values
  h.log('SUMMARY:', await dump(h, '#dsPkBody .ds-pk-summary', 600));
  h.log('NOTES:', JSON.stringify(await h.eval(`[...document.querySelectorAll('#dsPkBody .ds-pk-note')].map(e => e.innerText)`)));
  h.log('ROWS:', JSON.stringify(await rows(h), null, 0));
  await h.shot(h.shots + '/pk-inventory.png');
  const action = (process.env.ACTION || 'none').toLowerCase();
  if (action === 'none') return;
  const value = process.env.VALUE || 'Closed';
  const attr = action === 'toggle' ? 'data-pk-toggle' : action === 'delete' ? 'data-pk-del' : 'data-pk-fix';
  const clicked = await h.eval(`(() => { const r = document.querySelector('#dsPkBody .ds-pk-row[data-pk-val=' + JSON.stringify(${JSON.stringify(value)}) + ']'); if (!r) return 'no row'; const b = r.querySelector('[' + ${JSON.stringify(attr)} + ']'); if (!b) return 'no button ' + ${JSON.stringify(attr)}; b.click(); return 'clicked ' + b.textContent.trim(); })()`);
  h.log('action:', action, 'on', value, '→', clicked);
  // an automation scan (T8) runs in a modal before the wizard itself appears
  await h.sleep(1500);
  h.log('interim modal:', await dump(h, '#dsModalBox', 400));
  await h.waitFor("!!document.querySelector('#dsPkGo')", 240000, 1000);
  await h.sleep(800);
  const wiz = await h.eval(`(() => { const box = document.querySelector('#dsPkGo')?.closest('#dsModalBox, .ds-modal, [class*=modal]'); return box ? box.innerText.replace(/\\s+/g, ' ').slice(0, 1600) : '(no wizard: ' + [...document.querySelectorAll('.ds-toast, [class*=toast]')].map(t => t.innerText).join(' | ') + ')'; })()`);
  h.log('WIZARD:', wiz);
  await h.shot(h.shots + '/pk-wizard.png');
  if (!(await h.eval(`!!document.querySelector('#dsPkGo')`))) return;
  const fix = (process.env.FIX || 'remap').toLowerCase();
  h.log('fix modes offered:', JSON.stringify(await h.eval(`[...document.querySelectorAll('input[name="dsPkFixMode"]')].map(r => r.value + (r.checked ? '*' : '') + (r.disabled ? '(off)' : ''))`)));
  await h.eval(`(() => { const r = document.querySelector('input[name="dsPkFixMode"][value=' + JSON.stringify(${JSON.stringify(fix)}) + ']'); if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } return !!r; })()`);
  if (fix === 'remap') h.log('remap target:', await setSelect(h, '#dsPkRemapTarget', process.env.TARGET || 'New'));
  await h.sleep(300);
  h.log('Go:', await h.eval(`(() => { const b = document.querySelector('#dsPkGo'); return b.textContent.trim() + (b.disabled ? ' (off)' : ''); })()`));
  const before = await h.eval(`document.querySelector('#dsPkBody .ds-pk-row')`) ? await h.eval(`(() => { window.__pkOld = document.querySelector('#dsPkBody .ds-pk-row'); return true; })()`) : null;
  await h.eval(`document.querySelector('#dsPkGo').click()`);
  // typed production confirm, if the org is guarded
  await h.sleep(1500);
  const typed = await h.eval(`(() => { const i = document.querySelector('#dsProdConfirmInput'); return i ? (i.placeholder || 'typed input') : ''; })()`);
  if (typed) {
    h.log('TYPED GATE (org name to type):', JSON.stringify(typed), '| modal:', await dump(h, '#dsModalBox', 600));
    if (process.env.TYPE_IT === '1') {
      await h.eval(`(() => { const i = document.querySelector('#dsProdConfirmInput'); i.value = i.placeholder; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await h.sleep(300);
      h.log('Proceed enabled after typing:', await h.eval(`!document.querySelector('#dsProdGo')?.disabled`));
      await h.eval(`document.querySelector('#dsProdGo')?.click()`);
    } else { h.log('TYPE_IT not set — cancelling at the typed gate'); await h.eval(`document.querySelector('#dsProdCancel')?.click()`); return; }
  }
  // done = the inventory re-rendered (new row elements) or an error toast
  await h.waitFor("(document.querySelector('#dsPkBody .ds-pk-row') && document.querySelector('#dsPkBody .ds-pk-row') !== window.__pkOld) || /❌/.test([...document.querySelectorAll('.ds-toast, [class*=toast]')].map(t => t.innerText).join(' '))", 300000, 1000);
  await h.sleep(3000);
  h.log('TOASTS:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-toast, [class*=toast]')].map(t => t.innerText.replace(/\\s+/g, ' ').slice(0, 300))`)));
  h.log('ROWS after:', JSON.stringify(await rows(h), null, 0));
  h.log('NOTES after:', JSON.stringify(await h.eval(`[...document.querySelectorAll('#dsPkBody .ds-pk-note')].map(e => e.innerText)`)));
  h.log('HISTORY newest:', await h.eval(`(() => { const x = (typeof _history !== 'undefined' && _history[0]) || null; return x ? JSON.stringify(x).slice(0, 500) : '(none)'; })()`));
  await h.shot(h.shots + '/pk-after.png');
}
