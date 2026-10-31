// Live: Data Deployment's builder and list, end to end, with both orgs open —
// New Profile (name, orgs, root Account, child Contacts via the relationship
// list) → Save → card; ✏ Edit (rename) → card; ⧉ Clone → "Copy of"; ⬇ Export
// (a real download, read back: no session, no record ids); 🗑 Delete the clone
// (confirmation); ⬆ Import the file → a card again; a template opens the
// builder with a tree; everything made here is deleted at the end.
// Nothing in either org changes (describes only).
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
const NL = String.fromCharCode(10);
const NAME = 'SFTK QA Builder';
const lines = (s, n = 2500) => String(s || '').slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const cards = h => h.eval("[...document.querySelectorAll('.ds-profile-card')].map(c => c.querySelector('.ds-profile-card-name')?.innerText.trim())");
const cardBtn = (h, name, action) => h.eval(`(() => { const c = [...document.querySelectorAll('.ds-profile-card')].find(c => c.querySelector('.ds-profile-card-name')?.innerText.trim() === ${JSON.stringify(name)}); const b = c && (c.querySelector('[data-dsaction="${action}"]') || c.querySelector('[data-prof-export]')); if (!b) return false; b.click(); return true; })()`);
async function toProfiles(h) {
  await h.eval("location.hash = '#/profiles'"); await h.sleep(1200);
  await h.waitFor("!!document.querySelector('#dsNewProfile')", 30000, 500); await h.sleep(500);
}
async function deleteCard(h, name) {
  if (!(await cardBtn(h, name, 'deleteProfile'))) throw new Error(`no card "${name}" to delete`);
  await h.waitFor("!!document.querySelector('#dsConfirmDelete')", 15000, 300);
  h.log(`DELETE DIALOG (${name}):`, lines(await h.text('#dsModalBox'), 300));
  await h.click('#dsConfirmDelete'); await h.sleep(900);
}

export default async function (h) {
  await h.login('npc2'); await h.login('npc');
  await h.studio('#/profiles');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#dsNewProfile')", 60000, 500);
  await h.sleep(1000);
  const before = await cards(h);
  h.log(`cards before: ${before.length}`, JSON.stringify(before.slice(0, 6)));
  for (const n of before) if (n === NAME || n.startsWith(NAME) || n === `Copy of ${NAME}`) { h.log(`leftover "${n}" from an earlier run — deleting`); await deleteCard(h, n); }
  h.log('templates offered:', JSON.stringify(await h.eval("[...document.querySelectorAll('[data-tpl]')].map(b => b.innerText.trim())")));

  // ── New Profile ──
  await h.click('#dsNewProfile');
  await h.waitFor("!!document.querySelector('#dsProfileName')", 15000, 300); await h.sleep(500);
  h.log('BUILDER header:', lines(await h.eval("document.querySelector('#dsMain')?.innerText || ''"), 400));
  const orgs = await h.eval("[...document.querySelectorAll('#dsProfileSrcOrg option')].map(o => o.value + ' :: ' + o.text)");
  h.log('source options:', JSON.stringify(orgs));
  const src = await h.eval("[...document.querySelectorAll('#dsProfileSrcOrg option')].find(o => /c449e108c2/.test(o.value))?.value || ''");
  const tgt = await h.eval("[...document.querySelectorAll('#dsProfileTgtOrg option')].find(o => /e2c4511b2b/.test(o.value))?.value || ''");
  if (!src || !tgt) throw new Error('both orgs are not offered in the builder');
  await h.eval(`(() => { const n = document.querySelector('#dsProfileName'); n.value = ${JSON.stringify(NAME)}; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true }));
    const s = document.querySelector('#dsProfileSrcOrg'); s.value = ${JSON.stringify(src)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await h.sleep(400);
  await h.eval(`(() => { const t = document.querySelector('#dsProfileTgtOrg'); t.value = ${JSON.stringify(tgt)}; t.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await h.sleep(400);
  // root object through the autocomplete, as a user types it
  await h.eval("(() => { const i = document.querySelector('#dsRootObj'); i.focus(); i.value = 'Account'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  await h.sleep(1500);
  h.log('autocomplete shows:', JSON.stringify(await h.eval("[...document.querySelectorAll('#dsRootObjAC [role=option], #dsRootObjAC div')].slice(0, 5).map(o => o.innerText.trim())")));
  await h.click('#dsSetRoot');
  await h.waitFor("!!document.querySelector('#dsTreeArea') && /Account/.test(document.querySelector('#dsTreeArea').innerText)", 15000, 300);
  // child: Contacts, from the relationship list the builder loads
  await h.waitFor("document.querySelectorAll('[data-add-child]').length > 0 || /No child relationships/.test(document.querySelector('#dsTreeArea').innerText)", 90000, 1000);
  const rels = await h.eval("document.querySelectorAll('[data-add-child]').length");
  const added = await h.eval("(() => { const r = [...document.querySelectorAll('[data-add-child]')].find(r => r.dataset.relObj === 'Contact' && r.dataset.relField === 'AccountId'); if (!r) return null; r.querySelector('button').click(); return r.dataset.relName + ' via ' + r.dataset.relField; })()");
  h.log(`relationships offered: ${rels} · added child: ${added}`);
  if (!added) throw new Error('Contacts (AccountId) was not offered as a child of Account');
  await h.sleep(1200);
  h.log('TREE:', lines(await h.text('#dsTreeArea'), 600));
  h.log('header count:', lines(await h.eval("document.querySelector('.ds-vh-count, .ds-view-header-count, [class*=vh-count]')?.innerText || ''"), 100));
  await h.click('#dsBuilderSave');
  await h.sleep(1500);
  await toProfiles(h);
  let now = await cards(h);
  h.log(`cards after save: ${now.length} · has "${NAME}": ${now.includes(NAME)}`);
  if (!now.includes(NAME)) throw new Error('the saved deployment has no card');
  const stored = await h.eval(`new Promise(r => chrome.storage.local.get('sftk_profiles', d => r((d.sftk_profiles || []).find(p => p.name === ${JSON.stringify(NAME)}) || null)))`);
  h.log(`stored: root=${stored?.tree?.objectType} children=${(stored?.tree?.children || []).map(c => c.childSObject + '/' + c.relationshipName).join(',')} src=${stored?.sourceOrg} tgt=${stored?.targetOrg} match=${stored?.scanConfig?.matchField}`);
  if (stored?.tree?.objectType !== 'Account' || !(stored?.tree?.children || []).some(c => c.childSObject === 'Contact')) throw new Error('the stored tree is not Account > Contact');
  h.log('CARD:', lines(await h.eval(`(() => { const c = [...document.querySelectorAll('.ds-profile-card')].find(c => c.querySelector('.ds-profile-card-name')?.innerText.trim() === ${JSON.stringify(NAME)}); return c ? c.innerText : ''; })()`), 400));

  // ── Edit: rename ──
  if (!(await cardBtn(h, NAME, 'editProfile'))) throw new Error('no Edit button');
  await h.waitFor("!!document.querySelector('#dsProfileName')", 15000, 300); await h.sleep(500);
  h.log(`edit opens with name "${await h.eval("document.querySelector('#dsProfileName').value")}" and tree: ${lines(await h.text('#dsTreeArea'), 200)}`);
  await h.eval(`(() => { const n = document.querySelector('#dsProfileName'); n.value = ${JSON.stringify(NAME + ' 2')}; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await h.click('#dsBuilderSave'); await h.sleep(1200); await toProfiles(h);
  now = await cards(h);
  h.log(`after rename: has "${NAME} 2": ${now.includes(NAME + ' 2')} · old name gone: ${!now.includes(NAME)}`);
  if (!now.includes(NAME + ' 2') || now.includes(NAME)) throw new Error('the rename did not land on the card');
  const NAME2 = NAME + ' 2';

  // ── Clone ──
  if (!(await cardBtn(h, NAME2, 'cloneProfile'))) throw new Error('no Clone button');
  await h.sleep(1000);
  now = await cards(h);
  h.log(`after clone: has "Copy of ${NAME2}": ${now.includes('Copy of ' + NAME2)}`);
  if (!now.includes('Copy of ' + NAME2)) throw new Error('no clone card');

  // ── Export: a real download ──
  const dlDir = resolve('dist/qa/downloads'); mkdirSync(dlDir, { recursive: true });
  await h.cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true }, null);
  const had = new Set(readdirSync(dlDir));
  if (!(await cardBtn(h, NAME2, 'export'))) throw new Error('no Export button');
  let file = null;
  for (let i = 0; i < 40 && !file; i++) { await h.sleep(500); file = readdirSync(dlDir).find(f => !had.has(f) && /^sftk-profile-.*\.json$/.test(f)); }
  if (!file) throw new Error('no export file landed');
  const exported = JSON.parse(readFileSync(join(dlDir, file), 'utf8'));
  const text = JSON.stringify(exported);
  h.log(`EXPORT FILE: ${file} (${statSync(join(dlDir, file)).size} bytes) · keys: ${Object.keys(exported).join(',')}`);
  const leaks = ['sid', 'session', 'lastScan', 'matchMemory', 'piiSalt'].filter(k => new RegExp(`"${k}"`).test(text));
  const ids = (text.match(/\b001[0-9A-Za-z]{15}\b|\b003[0-9A-Za-z]{15}\b/g) || []).length;
  h.log(`export carries: session/scan/memory keys ${leaks.length ? leaks.join(',') : 'none'} · record ids ${ids}`);
  if (leaks.length || ids) throw new Error('the export carries machine-local or org-specific data');
  h.log('TOAST:', lines(await h.eval("document.querySelector('.ds-toast')?.innerText || ''"), 300));

  // ── Delete the clone ──
  await deleteCard(h, 'Copy of ' + NAME2);
  now = await cards(h);
  h.log(`after delete: clone gone: ${!now.includes('Copy of ' + NAME2)} · original kept: ${now.includes(NAME2)}`);
  if (now.includes('Copy of ' + NAME2) || !now.includes(NAME2)) throw new Error('delete removed the wrong card');

  // ── Import the exported file ──
  await h.eval("(() => { const orig = document.createElement.bind(document); window.__sftkInputs = []; document.createElement = t => { const el = orig(t); if (String(t).toLowerCase() === 'input') window.__sftkInputs.push(el); return el; }; return true; })()");
  await h.click('#dsImportProfile'); await h.sleep(500);
  const { result: { objectId } } = await h.cdp('Runtime.evaluate', { expression: "window.__sftkInputs.find(i => i.type === 'file')" });
  if (!objectId) throw new Error('the import did not open a file input');
  await h.cdp('DOM.setFileInputFiles', { objectId, files: [join(dlDir, file)] });
  await h.eval("(() => { const i = window.__sftkInputs.find(i => i.type === 'file'); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
  await h.waitFor("/Imported/.test(document.querySelector('#dsModalBox')?.innerText || '')", 15000, 300);
  h.log('IMPORT DIALOG:', lines(await h.text('#dsModalBox'), 600));
  await h.closeModal(); await h.sleep(600);
  now = await cards(h);
  const importedName = now.filter(n => n.startsWith(NAME2)).length;
  h.log(`after import: cards named like "${NAME2}": ${importedName} (original + import) · all: ${JSON.stringify(now.filter(n => n.includes(NAME)))}`);
  if (importedName < 2) throw new Error('the import made no card');

  // ── a template opens the builder with a tree ──
  const tpl = await h.eval("(() => { const b = document.querySelector('[data-tpl]'); if (!b) return null; const t = b.innerText.trim(); b.click(); return t; })()");
  if (tpl) {
    await h.waitFor("!!document.querySelector('#dsProfileName') && !!document.querySelector('#dsTreeArea')", 15000, 300); await h.sleep(600);
    h.log(`TEMPLATE "${tpl}": name "${await h.eval("document.querySelector('#dsProfileName').value")}" · tree: ${lines(await h.text('#dsTreeArea'), 300)}`);
    await h.click('#dsBuilderCancel'); await h.sleep(800); await toProfiles(h);
  } else h.log('no template buttons on the list');

  // ── clean up everything made here ──
  for (const n of (await cards(h)).filter(n => n.includes(NAME))) await deleteCard(h, n);
  const left = (await cards(h)).filter(n => n.includes(NAME));
  h.log(`cleanup: ${left.length} card(s) left with our name · total cards ${(await cards(h)).length} (was ${before.length})`);
  if (left.length) throw new Error('cleanup left cards behind');
  h.log('✓ end to end: new → save → card; edit; clone; export (clean file); delete; import; template; cleaned up');
}
