// Pick Records › Matching: pick a radio inside the fold — the fold must stay open after the re-render;
// fold it by hand, change again — it must stay folded.
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const id = await h.eval(`_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id`);
  await h.eval(`window.editProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.waitFor("!!document.querySelector('[data-records-btn=\"\"]')", 30000, 300);
  await h.eval(`document.querySelector('[data-records-btn=""]').click()`);
  await h.waitFor("!!document.querySelector('.ds-match-fold')", 60000, 300); await h.sleep(800);
  const state = () => h.eval(`(() => { const d = document.querySelector('.ds-match-fold'); const on = document.querySelector('input[name="dsMatchStrat"]:checked'); return (d ? (d.open ? 'open' : 'folded') : 'no fold') + ' · ' + (on ? on.value : '?') + ' · ' + (d?.querySelector('summary')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80); })()`);
  h.log('0. as opened:', await state());
  await h.eval(`(() => { const d = document.querySelector('.ds-match-fold'); if (!d.open) d.open = true; return true; })()`); await h.sleep(300);
  h.log('1. unfolded by hand:', await state());
  const other = await h.eval(`(() => { const on = document.querySelector('input[name="dsMatchStrat"]:checked'); const r = [...document.querySelectorAll('input[name="dsMatchStrat"]')].find(x => x !== on && !x.disabled); if (!r) return null; r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return r.value; })()`);
  await h.sleep(1500);
  h.log('2. after choosing', other + ':', await state());
  const s2 = await state(); if (!s2.startsWith('open')) throw new Error('the fold collapsed after a radio');
  await h.eval(`(() => { document.querySelector('.ds-match-fold').open = false; return true; })()`); await h.sleep(300);
  const back = await h.eval(`(() => { const on = document.querySelector('input[name="dsMatchStrat"]:checked'); const r = [...document.querySelectorAll('input[name="dsMatchStrat"]')].find(x => x !== on && !x.disabled); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return r.value; })()`);
  await h.sleep(1500);
  h.log('3. folded by hand, then chose', back + ':', await state());
  if (!(await state()).startsWith('folded')) throw new Error('a hand-folded fold opened on its own');
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 3)')).slice(0, 300));
  h.log('✓ the Matching fold keeps its state across re-renders');
}
