// LIVE, WRITES to npc2 then rolls back (user 2026-11-07, PII "its kinda hard"): on the Leads fixture, the Deploy page's
// 🎭 Suggest for all to insert (each example named by its record), Apply, ▸ record shows each covered field "written as"
// (treated), 🎭 Suggest PII for this record, then a REAL run under the policy (masking + audit lines, the CLI finds no
// real value in the target) and ↩ Roll back. The run and rollback steps are pii-v2.mjs's.
import { execSync } from 'node:child_process';
const SHOTS = process.env.LOCALAPPDATA + '/Temp/sftk-headless-shots/';
const NL = String.fromCharCode(10);
const dump = async (h, sel, n = 1200) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(NL).join(' | ');
const cli = soql => {
  try {
    const t = execSync(`sf data query -o npc2 --json -q "${soql}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(t.slice(t.indexOf('{'))).result.records;
  } catch (e) { return `? (${e.message.split(NL)[0]})`; }
};
const theme = async (h, dark) => { await h.eval(`(() => { if (!document.getElementById('noTrans')) { const st = document.createElement('style'); st.id = 'noTrans'; st.textContent = '*{transition:none!important}'; document.head.appendChild(st); } document.documentElement.classList.toggle('ds-dark', ${dark}); return true; })()`); await h.sleep(500); };
const shotBoth = async (h, name) => { await h.shot(SHOTS + name + '.png'); await theme(h, true); await h.shot(SHOTS + name + '-dark.png'); await theme(h, false); };

export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Leads';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('fixture profile missing');
  h.log('deployment:', NAME, '| CLI target leads before:', JSON.stringify(cli("SELECT COUNT() FROM Lead WHERE LastName LIKE 'SFTK CX%'")));
  // ── open: every object is read by itself (2026-11-08) ──
  await h.eval(`window.runProfile(${JSON.stringify(id)})`);
  await h.waitFor("!!document.querySelector('#dsDepPiiAll') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);
  await h.sleep(1000);
  h.log('PII LINE:', await dump(h, '#dsDepPiiAll', 200), '|', await h.eval("document.querySelector('#dsDepPiiAll')?.nextElementSibling?.innerText || ''"));
  // ── 🎭 Suggest for all to insert ──
  await h.eval("document.querySelector('#dsDepPiiAll').click()");
  await h.waitFor("!!document.querySelector('#dsPiiSugApply')", 120000, 500);
  await h.waitFor("![...document.querySelectorAll('#dsModalBox [data-pii-prev]')].some(c => /…/.test(c.textContent))", 60000, 500).catch(() => {});
  await h.sleep(500);
  h.log('SUGGEST HEADER:', await dump(h, '#dsModalBox .ds-modal-header', 200));
  h.log('SUGGEST EXAMPLES:', JSON.stringify(await h.eval("[...document.querySelectorAll('#dsModalBox [data-pii-prev]')].map(c => c.dataset.piiPrev + ': ' + c.innerText.split(String.fromCharCode(10)).join(' '))")));
  h.log('SUGGEST ROWS:', JSON.stringify(await h.eval("[...document.querySelectorAll('#dsModalBox .ds-pii-sug-row')].map(r => (r.querySelector('[data-pii-key]')?.checked ? '☑ ' : '☐ ') + r.innerText.split(String.fromCharCode(10)).join(' ').slice(0, 260))")));
  await shotBoth(h, 'piid-1-suggest');
  await h.click('#dsPiiSugApply');
  await h.waitFor("document.querySelector('#dsModal')?.style.display === 'none'", 20000, 300);
  await h.sleep(2500);
  h.log('saved policy:', await h.eval(`JSON.stringify((_profiles.find(p => p.id === ${JSON.stringify(id)}) || {}).piiPolicy)`));
  h.log('PII LINE after:', await h.eval("document.querySelector('#dsDepPiiAll')?.nextElementSibling?.innerText || ''"));
  // ── ▸ record: the treated values ──
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="ins"]')?.click()`); await h.sleep(800);
  await h.eval("document.querySelector('#dsDepList [data-dep-vals]').click()");
  await h.waitFor("document.querySelectorAll('#dsValEdHost tr[data-ve-row]').length > 0", 30000, 300);
  await h.waitFor("document.querySelectorAll('#dsValEdHost .ds-ve-pii').length > 0", 20000, 300).catch(() => {});
  await h.sleep(800);
  h.log('RECORD treated rows:', JSON.stringify(await h.eval("[...document.querySelectorAll('#dsValEdHost .ds-ve-pii')].map(d => d.closest('tr').querySelector('th').innerText.split(String.fromCharCode(10))[0] + ' — source: ' + (d.closest('tr').querySelector('.ds-ve-src')?.innerText || '') + ' — ' + d.innerText)")));
  await h.eval("document.querySelector('#dsValEdHost .ds-ve-pii')?.closest('tr')?.scrollIntoView({ block: 'center' })"); await h.sleep(300);
  await shotBoth(h, 'piid-2-record');
  // ── 🎭 Suggest for this record ──
  await h.eval("document.querySelector('#dsVePiiSug')?.click()");
  await h.waitFor("!!document.querySelector('#dsPiiSugApply')", 120000, 500).catch(() => {});
  await h.waitFor("![...document.querySelectorAll('#dsModalBox [data-pii-prev]')].some(c => /…/.test(c.textContent))", 60000, 500).catch(() => {});
  await h.sleep(800);
  h.log('ONE-RECORD HEADER:', await dump(h, '#dsModalBox .ds-modal-header', 200), '| rows:', await h.eval("document.querySelectorAll('#dsModalBox .ds-pii-sug-row').length"), '| first:', await h.eval("(document.querySelector('#dsModalBox .ds-pii-sug-row')?.innerText || '').split(String.fromCharCode(10)).join(' ').slice(0, 200)"));
  await h.shot(SHOTS + 'piid-3-one-record.png');
  await h.closeModal(); await h.sleep(1500);
  if (process.env.NOWRITE === '1') { h.log('NOWRITE: no run'); return; }
  // ── the real run under the policy ──
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="ins"]')?.click()`); await h.sleep(500);
  await h.eval(`(() => { const b = document.querySelector('[data-dep-bulk="all"]'); if (b && !b.disabled) b.click(); })()`); await h.sleep(400);
  h.log('SUMMARY:', await dump(h, '#dsDepSummary', 300));
  const histBefore = await h.eval('_history.length');
  await h.click('#dsRecRunBtn');
  await h.sleep(2000);
  for (let i = 0; i < 3; i++) {
    const m = await h.modalText(600); if (!m) break;
    await h.eval(`(() => { const a = document.querySelector('#sftkConfirmAck'); if (a && !a.checked) { a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); } const b = document.querySelector('#sftkConfirmGo') || [...document.querySelectorAll('#dsModalBox button')].find(b => /proceed|deploy/i.test(b.textContent) && !b.disabled); if (b) b.click(); return true; })()`);
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
  h.log('RUN LOG (PII/audit lines):', lastLog.split(NL).map(x => x.trim()).filter(x => /PII|mask|audit|🔎|🎭/i.test(x)).join(' | ').slice(0, 2000));
  const written = cli("SELECT FirstName, LastName, Email, Phone, Company FROM Lead WHERE Company LIKE 'SFTK CX%' AND CreatedDate = TODAY");   // the names are fabricated: found by Company
  h.log('CLI TARGET LEADS AFTER:', JSON.stringify(written));
  const src = (() => { try { const t = execSync(`sf data query -o npc --json -q "SELECT FirstName, LastName, Email, Phone FROM Lead WHERE LastName LIKE 'SFTK CX%'"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); return JSON.parse(t.slice(t.indexOf('{'))).result.records; } catch (_) { return []; } })();
  const real = new Set(src.flatMap(r => [r.Email, r.Phone]).filter(Boolean));
  const realNames = new Set(src.map(r => r.FirstName).filter(Boolean));
  const leak = Array.isArray(written) ? written.filter(r => real.has(r.Email) || real.has(r.Phone) || realNames.has(r.FirstName) || /SFTK CX Lead/.test(r.LastName || '')) : ['?'];
  h.log('SOURCE values compared:', real.size, '| LEAKED REAL VALUES:', leak.length, leak.length ? JSON.stringify(leak) : 'none');
  // ── ↩ Roll back ──
  await h.eval(`navigateToView('history')`);
  await h.waitFor("!!document.querySelector('[data-dsaction=\"rollbackRun\"]')", 20000, 500); await h.sleep(500);
  if (!(await h.eval(`!!document.querySelector('[data-dsaction="rollbackRun"]:not([disabled])')`))) { h.log('no Roll back available'); return; }
  await h.eval(`document.querySelector('[data-dsaction="rollbackRun"]:not([disabled])').click()`);
  await h.waitFor("!!document.querySelector('#dsRbGo') || !!document.querySelector('.ds-rec-card-bad')", 300000, 1000);
  await h.sleep(1000);
  await h.eval(`(() => { document.querySelectorAll('[data-rb-pick^="force|"]').forEach(c => { if (!c.checked) c.click(); }); return true; })()`);
  if (!(await h.eval(`!!document.querySelector('#dsRbGo') && !document.querySelector('#dsRbGo').disabled`))) { h.log('rollback Go disabled'); return; }
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
  h.log('CLI target leads after rollback:', JSON.stringify(cli("SELECT COUNT() FROM Lead WHERE Company LIKE 'SFTK CX%' AND CreatedDate = TODAY")));
}
