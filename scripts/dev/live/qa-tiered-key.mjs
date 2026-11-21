// Read only (nothing is saved): Pick Records › the matching rule — add a second and a third field: the question about a
// record with an empty later field appears, answered Yes (most specific first); the sentence reads in labels; No
// switches it off. Rewritten 2026-11-21 on the sentence panel.
import { MQ_SENTENCE, MQ_FIELDS, MQ_TIERED, MQ_LIVE, mqAdd, mqSetTiered, mqLiveDone, openRootMatching } from './_match-ui.mjs';
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  await openRootMatching(h);
  const txt = async () => JSON.stringify({ fields: await h.eval(MQ_FIELDS), emptyFieldMatchesAlone: await h.eval(MQ_TIERED), sentence: await h.eval(MQ_SENTENCE), question: await h.eval("document.querySelector('.ds-mq-empty')?.innerText.replace(/\\s+/g, ' ') || 'none'"), summary: await h.eval("(document.querySelector('.ds-match-fold summary')?.innerText || '').replace(/\\s+/g, ' ')") });
  h.log('1. as opened:', await txt());
  const added = await h.eval(mqAdd('Phone|BillingCity|AccountNumber|Site'));
  await h.sleep(2500);
  h.log('2. added', added + ':', await txt());
  if ((await h.eval(MQ_TIERED)) === 'not asked') throw new Error('two fields and the empty-field question is not asked');
  const added2 = await h.eval(mqAdd('Phone|BillingCity|AccountNumber|Site|Industry'));
  await h.sleep(2500);
  h.log('3. added', added2 + ':', await txt());
  await mqLiveDone(h);
  h.log('   live result:', await h.eval(MQ_LIVE));
  await h.eval(`(() => { document.querySelector('.ds-match-cfg').scrollIntoView({ block: 'start' }); return true; })()`); await h.sleep(300);
  await h.shot(h.shots + '/tiered-panel.png');
  await h.eval(mqSetTiered(false)); await h.sleep(1500);
  h.log('4. answered No:', await txt());
  if ((await h.eval(MQ_TIERED)) !== 'no') throw new Error('the answer did not stay on No');
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 3)')).slice(0, 300));
}
