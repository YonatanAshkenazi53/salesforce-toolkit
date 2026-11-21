// Read only (nothing is saved): Pick Records › the matching rule › 💡 Try another rule — the depth asked, one field =
// counts in both orgs, three fields = most-specific-first rules graded live; Use carries the rule into the sentence.
// Rewritten 2026-11-21 on the sentence panel.
import { MQ_SENTENCE, MQ_FIELDS, MQ_TIERED, openRootMatching } from './_match-ui.mjs';
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  await openRootMatching(h);
  await h.eval(`document.getElementById('dsMatchSuggestBtn').click()`); await h.sleep(600);
  const box = () => h.eval(`(document.getElementById('dsMatchSuggestBox')?.innerText || '').split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ')`);
  const graded = () => h.waitFor("(() => { const els = [...document.querySelectorAll('[data-match-grade-out]')].slice(0, 3); return els.length > 0 && els.every(el => el.innerText && !/grading/i.test(el.innerText)); })()", 120000, 500);
  h.log('1. depth asked:', (await box()).slice(0, 300));
  await graded(); await h.sleep(300);
  h.log('1. one field, graded:', (await box()).slice(0, 1400));
  const has3 = await h.eval(`(() => { const r = document.querySelector('[data-match-depth="3"]'); if (!r) return false; r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  if (!has3) throw new Error('no depth of three fields is offered');
  await h.sleep(600);
  await graded(); await h.sleep(300);
  h.log('2. three fields, graded:', (await box()).slice(0, 1800));
  await h.eval(`(() => { document.getElementById('dsMatchSuggestBox').scrollIntoView({ block: 'start' }); return true; })()`); await h.sleep(300);
  await h.shot(h.shots + '/suggest-depth3.png');
  const before = await h.eval(MQ_FIELDS);
  await h.eval(`document.querySelector('[data-match-adopt]').click()`); await h.sleep(2500);
  h.log('3. after Use:', JSON.stringify({ before, fields: await h.eval(MQ_FIELDS), emptyFieldMatchesAlone: await h.eval(MQ_TIERED), sentence: await h.eval(MQ_SENTENCE) }));
  if ((await h.eval(MQ_FIELDS)).length < 2) throw new Error('Use did not carry a rule of several fields into the sentence');
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 3)')).slice(0, 300));
}
