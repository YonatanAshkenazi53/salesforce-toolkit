// LIVE, NO ORG WRITE (owner 2026-11-16): one top-bar button for what was done — Activity; under Field Cleaner only
// the changes of ONE field; from Activity, the Toolkit's changes are backed up WITH their undo, cleared, restored.
// Seeds seven Field Cleaner entries (five for one field, two newer for another) and one Flows entry into the headless
// profile's own storage. The backup file's text is caught from the download and handed back to the file picker.
const dark = async (h, on) => { await h.eval(`(() => { document.body.classList.toggle('sftk-dark', ${on}); return true; })()`); await h.sleep(300); };
const both = async (h, name) => { await h.shot(h.shots + '/' + name + '.png'); await dark(h, true); await h.shot(h.shots + '/' + name + '-dark.png'); await dark(h, false); };
const entry = (i, subj, tool) => ({ id: 'tool_seed_' + i, kind: 'tool', tool: tool || 'Field Cleaner', profileName: tool ? 'Flow switched off — SFTK Demo Flow' : `"SFTK_Demo_${i}" validation rule deleted (${subj})`, subject: tool ? '' : subj,
  targetOrg: 'https://example-dev-ed.develop.my.salesforce.com', startedAt: new Date(Date.UTC(2026, 10, 16, 9, i)).toISOString(), completedAt: new Date(Date.UTC(2026, 10, 16, 9, i, 5)).toISOString(),
  status: 'success', what: [{ ok: true, text: `"SFTK_Demo_${i}" — verified by re-reading the org` }],
  toolUndo: { steps: [{ label: 'put it back', method: 'POST', path: '/tooling/sobjects/ValidationRule', body: { FullName: 'Account.SFTK_Demo_' + i } }] } });
const SEED = [...[1, 2, 3, 4, 5].map(i => entry(i, 'Account.SFTK_Old__c')), entry(6, 'Account.SFTK_New__c'), entry(7, 'Account.SFTK_New__c'), entry(8, '', 'Flow switches')];

export default async function (h) {
  await h.login('npc');
  await h.popup('fields');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await h.eval(`chrome.storage.local.set({ sftk_history: ${JSON.stringify(SEED)} }).then(() => true)`);
  await h.waitFor("!!document.querySelector('#fcToolHist details')", 20000, 300);
  await h.eval(`(() => { const d = document.querySelector('#fcToolHist details'); d.open = true; d.scrollIntoView({ block: 'start' }); return true; })()`);
  await h.sleep(500);

  // 1 — the top bar: Activity only; under the tool: the field changed last, nothing else
  const top = await h.eval(`({ history: !!document.getElementById('sftkThBtn'), activity: !!document.getElementById('sftkFeedBtn') })`);
  if (top.history || !top.activity) throw new Error('FAILED: the top bar must show Activity and no History button — ' + JSON.stringify(top));
  const inl = await h.eval(`({ head: document.querySelector('#fcToolHist summary').textContent.trim(), cards: document.querySelectorAll('#fcToolHist .sftk-th-card').length, note: document.querySelector('#fcToolHist .sftk-th-note')?.textContent.trim(), acts: document.querySelectorAll('#fcToolHist [data-th-clear], #fcToolHist [data-th-backup]').length })`);
  h.log('under the tool:', JSON.stringify(inl));
  if (inl.cards !== 2 || !/SFTK_New__c/.test(inl.head) || inl.acts) throw new Error('FAILED: only the two changes of the field changed last belong under the tool');
  await both(h, 'th-1-one-field');

  // 2 — Activity → the Toolkit's changes
  await h.eval(`(() => { document.getElementById('sftkFeedBtn').click(); return true; })()`);
  await h.waitFor("!!document.querySelector('#sftkFeedManage')", 10000, 200);
  await h.sleep(600);
  await both(h, 'th-2-activity');
  await h.eval(`(() => { document.getElementById('sftkFeedManage').click(); return true; })()`);
  await h.waitFor("!!document.querySelector('#sftkThClear')", 10000, 200);
  await h.sleep(500);
  const undoN = () => h.eval(`document.querySelectorAll('#sftkThModalList [data-th-undo]:not([disabled])').length`);
  if (await undoN() !== 8) throw new Error('FAILED: the window lists the eight Toolkit changes with Undo — ' + await undoN());
  await both(h, 'th-3-window');

  // ⬇ Back up: catch the file's text instead of a download
  await h.eval(`(() => { window.__bk = null; const o = URL.createObjectURL; URL.createObjectURL = b => { b.text().then(t => { window.__bk = t; }); return o.call(URL, b); }; return true; })()`);
  await h.eval(`(() => { document.querySelector('#sftkThBackup').click(); return true; })()`);
  await h.waitFor('typeof window.__bk === "string"', 10000, 200);
  const file = JSON.parse(await h.eval('window.__bk'));
  h.log('backup:', file.format, 'v' + file.version, file.tab, file.count, 'entries · undo steps kept:', file.entries.every(e => e.toolUndo && e.toolUndo.steps.length === 1));
  if (file.count !== 8 || !file.entries.every(e => e.toolUndo)) throw new Error('FAILED: the backup must hold all eight with their undo');
  await h.sleep(500);
  h.log('note:', await h.eval(`document.querySelector('#sftkThModalNote')?.textContent`));

  // 🗑 Clear: the dialog, then the emptied window
  await h.eval(`(() => { document.querySelector('#sftkThClear').click(); return true; })()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo')", 10000, 200);
  await both(h, 'th-4-clear-dialog');
  h.log('dialog:', (await h.eval(`(document.querySelector('#modalBox')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 600)`)));
  if (!await h.eval(`document.querySelector('#sftkConfirmGo').disabled`)) throw new Error('FAILED: clearing changes that can still be undone must need the tick');
  await h.eval(`(() => { document.querySelector('#modalBox input[type=checkbox]').click(); return true; })()`);
  await h.sleep(300);
  await h.eval(`(() => { document.querySelector('#sftkConfirmGo').click(); return true; })()`);
  await h.sleep(1200);
  const left = await h.eval(`chrome.storage.local.get('sftk_history').then(r => (r.sftk_history || []).length)`);
  if (left !== 0) throw new Error('FAILED: entries left after the clear — ' + left);
  h.log('after clear: under the tool →', JSON.stringify(await h.eval(`(document.querySelector('#fcToolHist')?.innerText || '').trim()`)));

  // ⬆ Restore from Activity's window: hand the caught file to the picker the button opens
  await h.eval(`(() => { window.sftkToolHistoryManage(); return true; })()`);
  await h.waitFor("!!document.querySelector('#sftkThRestore')", 10000, 200);
  await h.sleep(400);
  await both(h, 'th-5-cleared-window');
  await h.eval(`(() => { const oc = HTMLInputElement.prototype.click; HTMLInputElement.prototype.click = function () { if (this.type !== 'file') return oc.call(this);
      const t = window.__bk; const dt = new DataTransfer(); dt.items.add(new File([t], 'toolkit-history-all-2026-11-16.json', { type: 'application/json' })); this.files = dt.files; this.dispatchEvent(new Event('change')); };
    document.querySelector('#sftkThRestore').click(); return true; })()`);
  await h.waitFor("document.querySelectorAll('#sftkThModalList .sftk-th-card').length === 8", 10000, 200);
  await h.sleep(400);
  h.log('after restore: undo offered on', await undoN(), '· note:', await h.eval(`document.querySelector('#sftkThModalNote')?.textContent`));
  if (await undoN() !== 8) throw new Error('FAILED: every restored change must offer its Undo again');
  await both(h, 'th-6-restored');

  // a wrong file says why
  await h.eval(`(() => { window.__bk = '{"hello":1}'; document.querySelector('#sftkThRestore').click(); return true; })()`);
  await h.sleep(800);
  const bad = await h.eval(`document.querySelector('#sftkThModalNote .sftk-th-note-bad')?.textContent || ''`);
  h.log('wrong file:', bad);
  if (!/not an Activity backup/.test(bad)) throw new Error('FAILED: a wrong file must be refused with a reason');
  await h.eval(`chrome.storage.local.set({ sftk_history: [] }).then(() => true)`);
  h.log('✓ tool-history-backup: one Activity button · one field under the tool · back up 8 → clear → restore 8 with undo · wrong file refused');
}
