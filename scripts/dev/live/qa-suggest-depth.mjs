// Pick Records › Matching › 💡 Suggestions: the depth asked, one field = counts in both orgs, three
// fields = most-specific-first keys graded live; Use carries the tiers.
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const id = await h.eval(`_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id`);
  await h.eval(`window.editProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.waitFor("!!document.querySelector('[data-records-btn=\"\"]')", 30000, 300);
  await h.eval(`document.querySelector('[data-records-btn=""]').click()`);
  await h.waitFor("!!document.querySelector('.ds-match-fold')", 60000, 300); await h.sleep(800);
  await h.eval(`(() => { document.querySelector('.ds-match-fold').open = true; return true; })()`);
  await h.eval(`document.getElementById('dsMatchSuggestBtn').click()`); await h.sleep(600);
  const box = () => h.eval(`(document.getElementById('dsMatchSuggestBox')?.innerText || '').split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ')`);
  const graded = () => h.waitFor("[...document.querySelectorAll('[data-match-grade-out]')].slice(0, 3).every(el => el.innerText && !/grading/i.test(el.innerText))", 120000, 500);
  h.log('1. depth asked:', (await box()).slice(0, 300));
  await graded(); await h.sleep(300);
  h.log('1. one field, graded:', (await box()).slice(0, 1400));
  await h.eval(`(() => { const r = document.querySelector('[data-match-depth="3"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await h.sleep(600);
  await graded(); await h.sleep(300);
  h.log('2. three fields, graded:', (await box()).slice(0, 1800));
  await h.eval(`(() => { document.getElementById('dsMatchSuggestBox').scrollIntoView({ block: 'start' }); return true; })()`); await h.sleep(300);
  await h.shot('dist/qa/shots/suggest-depth3.png');
  await h.eval(`document.querySelector('[data-match-adopt]').click()`); await h.sleep(2500);
  h.log('3. after Use:', await h.eval(`JSON.stringify({ tiered: document.getElementById('dsMatchTiered')?.checked, readsAs: document.getElementById('dsMatchReadsAs')?.innerText.slice(0, 160), matching: _editingProfile?.tree?.matching })`));
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 3)')).slice(0, 300));
}
