// Read only (nothing is saved): every step the video's matching chapter takes (scripts/dev/video/sections.mjs, the
// block after [data-records-btn]), without the recorder — so a change of the panel is caught here and not half way
// through a recording. Fails on the first selector that is not there or does not do what the narration says.
import { MQ_FIELDS, MQ_TIERED, mqAdd, mqRemove, mqLiveDone, openRootMatching } from './_match-ui.mjs';
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  await openRootMatching(h);
  const need = async (sel, what) => { if (!(await h.eval(`!!document.querySelector(${JSON.stringify(sel)})`))) throw new Error(`the chapter points at ${sel} (${what}) and it is not on the page`); h.log('✔', sel, '—', what); };
  await need('.ds-mq-q', 'the question');
  await need('[data-mq-field="0"]', 'the first field of the sentence');
  await mqLiveDone(h);
  await need('#dsMatchLive .ds-mq-res', 'the live result');
  await need('.ds-mq-add', '+ and the same…');
  const a1 = await h.eval(mqAdd('^AccountNumber$')); await h.sleep(1500);
  const a2 = await h.eval(mqAdd('^Phone$')); await h.sleep(1500);
  h.log('added:', a1, a2, '· fields:', JSON.stringify(await h.eval(MQ_FIELDS)));
  if (JSON.stringify(await h.eval(MQ_FIELDS)) !== JSON.stringify(['Name', 'AccountNumber', 'Phone'])) throw new Error('the sentence is not Name + AccountNumber + Phone');
  await need('.ds-mq-empty', 'the empty-field question');
  if ((await h.eval(MQ_TIERED)) !== 'yes') throw new Error('the narration says Yes is the answer shown; it is ' + (await h.eval(MQ_TIERED)));
  await need('#dsMqForgive', 'ignore small differences');
  await need('#dsMatchSuggestBtn', '💡 Try another rule');
  await h.eval("document.getElementById('dsMatchSuggestBtn').click()"); await h.sleep(800);
  await need('[data-match-depth="3"]', 'a depth of three fields');
  await need('#dsMatchSuggestBox', 'the suggestions box');
  await h.eval(`(() => { const r = document.querySelector('[data-match-depth="3"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await h.waitFor("(() => { const els = [...document.querySelectorAll('[data-match-grade-out]')].slice(0, 3); return els.length > 0 && els.every(el => el.innerText && !/grading/i.test(el.innerText)); })()", 180000, 500);
  h.log('✔ three-field rules graded');
  await h.eval(mqRemove(2)); await h.sleep(1000);
  await h.eval(mqRemove(1)); await h.sleep(1000);
  h.log('back to one field:', JSON.stringify(await h.eval(MQ_FIELDS)));
  if ((await h.eval(MQ_FIELDS)).length !== 1) throw new Error('the chapter could not get back to one field');
  await need('#dsMatchTestBtn', '📊 Full report');
  await h.eval("document.getElementById('dsMatchTestBtn').click()");
  await h.waitFor("(document.querySelector('#dsMatchTestResults')?.innerText || '').length > 20", 120000, 500);
  h.log('✔ #dsMatchTestResults:', (await h.eval("document.querySelector('#dsMatchTestResults').innerText.replace(/\\s+/g, ' ')")).slice(0, 220));
  await need('#dsRecSave', 'Save (the chapter presses it; this script does not)');
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 3)')).slice(0, 300));
  h.log('✓ every step of the matching chapter is there');
}
