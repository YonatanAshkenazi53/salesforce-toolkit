// LIVE, READ-ONLY (nothing is saved, nothing is written to an org): the Masked fields window of an object shows an
// example under EVERY masked field — a real value of the source, what Deploy writes instead, the record it comes
// from (owner 2026-11-15). The Leads fixture deployment, a policy set in memory on five fields (one of them a field
// with no value in the source), the window opened from the tree's 🔒 chip path. Screenshots light and dark.
const SHOTS = process.env.LOCALAPPDATA + '/Temp/sftk-headless-shots/';
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
  await h.eval(`window.editProfile(${JSON.stringify(id)})`);
  await h.waitFor("!!document.querySelector('#dsBuilderSave')", 20000, 300);
  await h.sleep(800);
  // a policy in memory only (the deployment is not saved)
  await h.eval(`(() => { bldPiiEnsureSalt(_editingProfile);
    for (const [f, t] of [['FirstName', 'first-name'], ['Email', 'email-person'], ['Company', 'company'], ['Phone', 'phone-keep'], ['Fax', 'phone-keep']]) bldPiiSetRule(_editingProfile, 'Lead', f, bldPiiRuleFromTreatment(t));
    bldOpenPiiListModal('Lead'); return true; })()`);
  await h.waitFor("document.querySelectorAll('#dsModalBox [data-pii-ex]').length === 5", 20000, 300);
  await h.waitFor("![...document.querySelectorAll('#dsModalBox [data-pii-ex]')].some(e => /reading an example/.test(e.textContent))", 60000, 400);
  const rows = await h.eval(`[...document.querySelectorAll('#dsModalBox .ds-pii-row')].map(r => (r.innerText || '').replace(/\\s+/g, ' ').slice(0, 260))`);
  rows.forEach(r => h.log('ROW:', r));
  const ex = await h.eval(`[...document.querySelectorAll('#dsModalBox [data-pii-ex]')].map(e => ({ key: e.dataset.piiEx, pair: !!e.querySelector('.ds-pii-prev-pair'), text: (e.innerText || '').replace(/\\s+/g, ' ').slice(0, 160) }))`);
  if (ex.length !== 5 || ex.some(e => !e.text)) throw new Error('FAILED: every masked field must carry an example or the reason there is none — ' + JSON.stringify(ex));
  if (ex.filter(e => e.pair).length < 3) throw new Error('FAILED: expected real examples for the fields the fixture leads hold — ' + JSON.stringify(ex));
  await shotBoth(h, 'pii-list-example');
  h.log('✓ pii-list-example:', ex.filter(e => e.pair).length, 'fields with a real example,', ex.filter(e => !e.pair).length, 'with a stated reason');
}
