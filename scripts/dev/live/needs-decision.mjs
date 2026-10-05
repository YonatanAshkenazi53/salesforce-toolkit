// Live: Deploy page › ⚠ Needs a decision, decided ONE NAME AT A TIME (user
// 2026-10-05: "i would like to be able to also fix them one by one. also the
// options … are not clear"). Nothing is written to Salesforce by this script:
// an answer is remembered in the deployment's match memory (this throwaway
// profile's storage), and both orgs are read again.
//
// Fixture: "SFTK CX Duplicate Name" — trailheads5 holds it twice (Haifa,
// Eilat), trailheads4 once (docs/fixtures/complex-deployment).
//   1. the group as drawn: every answer a sentence, the candidate's values in it
//   2. answer "same record as #1" for the first copy → 📌 Apply this one →
//      remembered at once, no re-read; the top button offers the re-read
//   3. take it back ("Not decided") → 📌 Apply this one → forgotten
//   4. answer again, then the top button → both orgs read again → the other
//      copy is an ordinary insert, the tab is empty
import { execSync } from 'node:child_process';
const NL = String.fromCharCode(10);
const dump = async (h, sel, n = 1800) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);
const mem = (h, id) => h.eval(`JSON.stringify((_profiles.find(p => p.id === ${JSON.stringify(id)}).matchMemory) || {})`);
const top = h => h.eval(`(() => { const b = document.querySelector('#dsDepAmbApply'); return b ? b.textContent + (b.disabled ? ' (off)' : '') : null; })()`);
const one = h => h.eval(`(() => { const b = document.querySelector('[data-dep-amb-one]'); return b ? b.textContent + (b.disabled ? ' (off)' : '') : null; })()`);
const choose = (h, idx, pick) => h.eval(`(() => {
  const ids = [...new Set([...document.querySelectorAll('input[data-dep-amb-sel]')].map(x => x.dataset.depAmbSel))];
  const radios = [...document.querySelectorAll('input[data-dep-amb-sel="' + ids[${idx}] + '"]')];
  const r = ${JSON.stringify(pick)} === 'first' ? radios.find(x => x.value && x.value !== '__new__') : radios.find(x => x.value === ${JSON.stringify(pick)});
  if (!r) return 'no such answer';
  r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true }));
  return r.closest('label').innerText.trim();
})()`);

export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Accounts tree';
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('fixture profile missing');
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await waitScanned(h); await h.sleep(2000);
  await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="amb"]')?.click() || document.querySelector('[data-dep-tab="amb"]')?.click()`);
  await h.sleep(1200);
  h.log('1. INTRO:', await dump(h, '.ds-dep-amb-intro', 1500));
  h.log('1. GROUP:', await dump(h, '.ds-amb-group', 1500));
  h.log('1. top button:', await top(h), '| group button:', await one(h));
  await h.eval(`(() => { document.querySelector('.ds-dep-amb-intro')?.scrollIntoView({ block: 'start' }); return true; })()`); await h.sleep(300);
  await h.shot(h.shots + '/nd-1-group.png');

  h.log('2. answering for the first copy:', await choose(h, 0, 'first'));
  h.log('2. top button:', await top(h), '| group button:', await one(h));
  await h.eval(`document.querySelector('[data-dep-amb-one]').click()`);
  await h.sleep(1500);
  h.log('2. after 📌 Apply this one — memory:', await mem(h, id));
  h.log('2. GROUP head:', await dump(h, '.ds-amb-ghd', 300));
  h.log('2. top button:', await top(h), '| group button:', await one(h), '| still on the tab (no re-read):', await h.eval(`document.querySelectorAll('.ds-amb-group').length`), 'group(s)');
  await h.eval(`(() => { document.querySelector('.ds-dep-amb-intro')?.scrollIntoView({ block: 'start' }); return true; })()`); await h.sleep(300);
  await h.shot(h.shots + '/nd-2-remembered.png');

  h.log('3. taking it back:', await choose(h, 0, ''));
  h.log('3. group button:', await one(h));
  await h.eval(`document.querySelector('[data-dep-amb-one]').click()`);
  await h.sleep(1500);
  h.log('3. after 📌 Apply this one — memory:', await mem(h, id));
  h.log('3. top button:', await top(h));

  h.log('4. answering again:', await choose(h, 0, 'first'), '| top button:', await top(h));
  await h.eval(`document.querySelector('#dsDepAmbApply').click()`);
  await h.sleep(2500);
  await waitScanned(h); await h.sleep(2500);
  h.log('4. memory:', await mem(h, id));
  h.log('4. PLAN after the re-read:', await dump(h, '.ds-dep-plan', 700));
  try {
    const t = execSync(`sf data query -o npc2 --json -q "SELECT Id, BillingCity FROM Account WHERE Name = 'SFTK CX Duplicate Name'"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    h.log('CLI trailheads4 — nothing was written:', JSON.stringify(JSON.parse(t.slice(t.indexOf('{'))).result.records.map(r => `${r.Id}:${r.BillingCity}`)));
  } catch (e) { h.log('CLI failed:', e.message.split(NL)[0]); }
}
