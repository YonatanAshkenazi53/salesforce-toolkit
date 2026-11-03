// PII v2, live (1.1, 2026-11-04): the Leads fixture (3 Leads in the source,
// none in the target) through the builder's Suggest PII treatments modal —
// 200 real rows read, a treatment per field, two real values and what they
// become — the 🎭 chooser on one field, Save, then a REAL deployment of the
// Leads into npc2 under the policy, the run's masking and audit lines, the
// written values read by CLI (never the real ones), and ↩ Roll back so the
// target ends as it began. Screenshots light and dark.
import { execSync } from 'node:child_process';
const SHOTS = process.env.LOCALAPPDATA + '/Temp/sftk-headless-shots/';
const dump = async (h, sel, n = 1200) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).replace(/\n+/g, ' | ');
const cli = soql => {
  try {
    const t = execSync(`sf data query -o npc2 --json -q "${soql}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(t.slice(t.indexOf('{'))).result.records;
  } catch (e) { return `? (${e.message.split('\n')[0]})`; }
};
const theme = async (h, dark) => { await h.eval(`(() => { if (typeof applyDarkMode === 'function') applyDarkMode(${dark}); else document.documentElement.classList.toggle('ds-dark', ${dark}); return true; })()`); await h.sleep(400); };
const shotBoth = async (h, name) => { await h.shot(SHOTS + name + '.png'); await theme(h, true); await h.shot(SHOTS + name + '-dark.png'); await theme(h, false); };

export default async function (h) {
  await h.login('npc');
  await h.login('npc2');
  await h.studio('');
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Leads';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('fixture profile missing');
  h.log('deployment:', NAME);
  h.log('CLI target leads before:', JSON.stringify(cli("SELECT COUNT() FROM Lead WHERE LastName LIKE 'SFTK CX%'")));

  // ── the builder: Suggest PII treatments ──
  await h.eval(`window.editProfile(${JSON.stringify(id)})`);
  await h.waitFor("!!document.querySelector('#dsBuilderSave')", 20000, 300);
  await h.sleep(800);
  h.log('suggest button:', await h.eval(`!!document.querySelector('#dsBldSuggestPii')`));
  await h.click('#dsBldSuggestPii');
  await h.waitFor("document.querySelectorAll('#dsModalBox [data-pii-treat]').length > 0", 60000, 500);
  await h.waitFor("![...document.querySelectorAll('#dsModalBox [data-pii-prev]')].some(e => e.textContent.trim() === '…')", 30000, 500);
  await h.sleep(500);
  h.log('SUGGEST MODAL:', await h.modalText(2500));
  h.log('rows:', JSON.stringify(await h.eval(`[...document.querySelectorAll('#dsModalBox .ds-pii-sug-row')].map(r => ({ key: r.querySelector('[data-pii-key]')?.dataset.piiKey, ticked: r.querySelector('[data-pii-key]')?.checked, treat: r.querySelector('[data-pii-treat]')?.value, prev: r.querySelector('[data-pii-prev]')?.innerText.slice(0, 160) }))`)));
  await shotBoth(h, 'pii-1-suggest');
  // the match key stays as it is; the name part and the e-mail are fabricated
  await h.eval(`(() => { const cb = document.querySelector('#dsModalBox [data-pii-key="Lead.LastName"]'); if (cb) cb.checked = false;
    const set = (k, v) => { const s = document.querySelector('#dsModalBox [data-pii-treat="' + k + '"]'); const c = document.querySelector('#dsModalBox [data-pii-key="' + k + '"]'); if (s) { s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); } if (c) c.checked = true; };
    set('Lead.FirstName', 'first-name'); set('Lead.Email', 'email-person'); set('Lead.Company', 'company'); return true; })()`);
  await h.sleep(1500);
  h.log('rows after choosing:', JSON.stringify(await h.eval(`[...document.querySelectorAll('#dsModalBox .ds-pii-sug-row')].filter(r => r.querySelector('[data-pii-key]')?.checked).map(r => ({ key: r.querySelector('[data-pii-key]')?.dataset.piiKey, treat: r.querySelector('[data-pii-treat]')?.value, prev: r.querySelector('[data-pii-prev]')?.innerText.slice(0, 160) }))`)));
  await h.click('#dsPiiSugApply');
  await h.sleep(800);
  h.log('toast:', (await h.eval(`[...document.querySelectorAll('.ds-toast')].map(t => t.innerText).join(' || ')`)).slice(0, 300));
  h.log('policy now:', await h.eval(`JSON.stringify(_editingProfile.piiPolicy)`));

  // ── Fields & mapping: the 🎭 chooser on one field ──
  await h.eval(`(() => { const b = document.querySelector('[data-map-btn]'); if (b) b.click(); return !!b; })()`);
  await h.waitFor("!!document.querySelector('#dsFmList .ds-fm-row')", 30000, 500);
  await h.sleep(800);
  h.log('mask buttons:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-fm-mask-btn')].slice(0, 12).map(b => ({ f: b.dataset.mask, on: b.classList.contains('ds-fm-mask-on'), disabled: b.disabled }))`)));
  await h.eval(`(() => { const b = document.querySelector('.ds-fm-mask-btn[data-mask="Email"]'); if (b) b.click(); return !!b; })()`);
  await h.waitFor("!!document.querySelector('#dsPiiFieldTreat')", 20000, 300);
  await h.waitFor("!/…/.test(document.querySelector('#dsPiiFieldPrev')?.textContent || '…')", 20000, 300);
  await h.sleep(400);
  h.log('FIELD MODAL:', await h.modalText(1200));
  await shotBoth(h, 'pii-2-field');
  await h.click('#dsPiiFieldApply');
  await h.sleep(600);
  await h.closeModal();
  await h.sleep(300);
  h.log('tree chips:', (await h.eval(`[...document.querySelectorAll('[data-pii-chip]')].map(b => b.innerText).join(' | ')`)).slice(0, 200));
  await h.click('#dsBuilderSave');
  await h.sleep(1500);
  h.log('saved policy:', await h.eval(`JSON.stringify((_profiles.find(p => p.id === ${JSON.stringify(id)}) || {}).piiPolicy)`));
  h.log('salt present:', await h.eval(`typeof (_profiles.find(p => p.id === ${JSON.stringify(id)}) || {}).piiSalt === 'string'`));

  // ── the real run under the policy ──
  await h.eval(`window.runProfile(${JSON.stringify(id)})`);
  await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 120000, 1000);
  await h.sleep(1500);
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="ins"]')?.click()`); await h.sleep(500);
  await h.eval(`(() => { const b = document.querySelector('[data-dep-bulk="all"]'); if (b && !b.disabled) b.click(); })()`); await h.sleep(400);
  h.log('SUMMARY:', await dump(h, '#dsDepSummary', 300));
  const histBefore = await h.eval('_history.length');
  await h.click('#dsRecRunBtn');
  await h.sleep(2000);
  for (let i = 0; i < 3; i++) {
    const m = await h.modalText(600); if (!m) break;
    h.log('MODAL:', m.slice(0, 500));
    await h.eval(`(() => { const b = document.querySelector('#sftkConfirmGo') || [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed|deploy/i.test(b.textContent) && !b.disabled); if (b) b.click(); })()`);
    await h.sleep(2000);
  }
  let lastLog = '';
  for (let i = 0; i < 240; i++) {
    const t = await h.eval(`document.querySelector('#dsRecProgress')?.innerText || ''`);
    if (t) lastLog = t;
    if (await h.eval(`_history.length > ${histBefore}`)) break;
    await h.sleep(1000);
  }
  await h.sleep(2000);
  h.log('RUN LOG:', lastLog.split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ').slice(0, 4000));
  const entry = await h.eval(`JSON.stringify(_history[_history.length - 1], (k, v) => k === 'errors' ? v.filter(e => /PII|mask|🔎|audit/i.test(e)) : v)`);
  h.log('HISTORY ENTRY (PII lines):', entry.slice(0, 3000));
  await h.sleep(5000);
  await h.waitFor("!document.querySelector('#dsDepRefresh')?.disabled", 120000, 1000);
  await h.eval(`(() => { const el = document.querySelector('#dsRecProgress'); if (el) el.scrollIntoView({ block: 'start' }); return true; })()`);
  await h.sleep(500);
  await shotBoth(h, 'pii-3-run');
  // what landed — the real values must not be there
  const written = cli("SELECT FirstName, LastName, Email, Company FROM Lead WHERE LastName LIKE 'SFTK CX%'");
  h.log('CLI TARGET LEADS AFTER:', JSON.stringify(written));
  const realEmails = ['omer@sftk-cx-prospect.example', 'tal@sftk-cx-prospect.example'];
  const leak = Array.isArray(written) ? written.filter(r => realEmails.includes(r.Email) || r.FirstName === 'Omer' || r.FirstName === 'Tal') : ['?'];
  h.log('LEAKED REAL VALUES:', leak.length, leak.length ? JSON.stringify(leak) : 'none');

  // ── ↩ Roll back ──
  await h.eval(`navigateToView('history')`);
  await h.waitFor("!!document.querySelector('[data-dsaction=\"rollbackRun\"]')", 20000, 500); await h.sleep(500);
  h.log('HISTORY CARD:', await dump(h, '.ds-history-card', 1500));
  await shotBoth(h, 'pii-4-history');
  const rbOk = await h.eval(`!!document.querySelector('[data-dsaction="rollbackRun"]:not([disabled])')`);
  h.log('Roll back available:', rbOk);
  if (!rbOk) return;
  await h.eval(`document.querySelector('[data-dsaction="rollbackRun"]:not([disabled])').click()`);
  await h.waitFor("!!document.querySelector('#dsRbGo') || !!document.querySelector('.ds-rec-card-bad')", 300000, 1000);
  await h.sleep(1000);
  await h.eval(`(() => { document.querySelectorAll('[data-rb-pick^="force|"]').forEach(c => { if (!c.checked) c.click(); }); return true; })()`);
  const goOn = await h.eval(`!!document.querySelector('#dsRbGo') && !document.querySelector('#dsRbGo').disabled`);
  h.log('Go enabled:', goOn);
  if (!goOn) return;
  await h.eval(`document.querySelector('#dsRbGo').click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo') || !!document.querySelector('#sftkConfirmProdGo')", 20000, 300);
  await h.sleep(300);
  await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
  await h.sleep(300);
  await h.eval(`document.querySelector('#sftkConfirmGo')?.click()`);
  const rbBefore = await h.eval(`_history.filter(x => x.kind === 'rollback').length`);
  for (let i = 0; i < 300; i++) { if (await h.eval(`_history.filter(x => x.kind === 'rollback').length > ${rbBefore}`)) break; await h.sleep(1000); }
  await h.sleep(2000);
  h.log('ROLLBACK RESULT:', await dump(h, '#dsRbResult', 600));
  h.log('CLI target leads after rollback:', JSON.stringify(cli("SELECT COUNT() FROM Lead WHERE LastName LIKE 'SFTK CX%'")));
}
