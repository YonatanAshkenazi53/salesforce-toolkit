// Read only (nothing is saved): Pick Records › the matching rule — change the rule inside the fold, the fold must stay
// open after the re-render; fold it by hand, change again — it must stay folded.
// Rewritten 2026-11-21 on the sentence panel (the Single / Composite / External ID radios are gone).
import { MQ_SENTENCE, mqAdd, mqRemove, openRootMatching } from './_match-ui.mjs';
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  await openRootMatching(h, 'SFTK CX — Accounts tree', false);
  const state = async () => (await h.eval(`(() => { const d = document.querySelector('.ds-match-fold'); return d ? (d.open ? 'open' : 'folded') : 'no fold'; })()`)) + ' · ' + (await h.eval(MQ_SENTENCE)).slice(0, 120);
  h.log('0. as opened:', await state());
  await h.eval(`(() => { const d = document.querySelector('.ds-match-fold'); if (!d.open) d.open = true; return true; })()`); await h.sleep(300);
  h.log('1. unfolded by hand:', await state());
  const added = await h.eval(mqAdd('Phone|Website|Type|Industry'));
  await h.sleep(1500);
  h.log('2. after adding', added + ':', await state());
  if (!(await state()).startsWith('open')) throw new Error('the fold collapsed after a change of the rule');
  await h.eval(`(() => { document.querySelector('.ds-match-fold').open = false; return true; })()`); await h.sleep(300);
  const removed = await h.eval(mqRemove(1));
  await h.sleep(1500);
  h.log('3. folded by hand, then took the field out (' + removed + '):', await state());
  if (!(await state()).startsWith('folded')) throw new Error('a hand-folded fold opened on its own');
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 3)')).slice(0, 300));
  h.log('✓ the Matching fold keeps its state across re-renders');
}
