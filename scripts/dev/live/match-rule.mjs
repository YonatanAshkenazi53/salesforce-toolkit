// Read only: Pick Records › the matching rule as one question (owner 2026-11-20: "i think our composite is too hard
// to understand and use. how can we make it better? a lot better."). Opens the picker of the fixture deployment,
// waits for the live result, adds a second field, flips the switches — light and dark. Nothing is saved, no org changes.
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const id = await h.eval(`_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id`);
  await h.eval(`window.editProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.waitFor("!!document.querySelector('[data-records-btn=\"\"]')", 30000, 300);
  await h.eval(`document.querySelector('[data-records-btn=""]').click()`);
  await h.waitFor("!!document.querySelector('.ds-match-fold')", 60000, 300); await h.sleep(600);
  h.log('fold summary:', await h.eval("document.querySelector('.ds-match-fold > summary').innerText.replace(/\\s+/g, ' ')"));
  await h.eval(`(() => { const d = document.querySelector('.ds-match-fold'); if (!d.open) d.open = true; return true; })()`);
  const live = async tag => {
    await h.waitFor("!!document.querySelector('#dsMatchLive .ds-mq-res') && !document.querySelector('#dsMatchLive .ds-mq-spin')", 90000, 400).catch(() => {});
    await h.sleep(400);
    h.log(tag, '·', await h.eval("(document.querySelector('#dsMatchLive')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 520)"));
  };
  const shoot = async name => {
    for (const dark of [false, true]) {
      await h.eval(`document.documentElement.classList.toggle('ds-dark', ${dark})`); await h.sleep(350);
      await h.shot(h.shots + `/match-rule-${name}-${dark ? 'dark' : 'light'}.png`);
    }
    await h.eval("document.documentElement.classList.remove('ds-dark')");
  };
  h.log('sentence:', await h.eval("[...document.querySelectorAll('.ds-mq-sentence > *')].map(e => e.tagName === 'SELECT' ? '[' + (e.selectedOptions[0]?.text || '') + ']' : e.innerText).join(' ')"));
  await live('1. as opened');
  await shoot('one');
  // wait for a recommendation, if the rule earned one
  await h.sleep(9000);
  h.log('recommendation:', await h.eval("document.querySelector('.ds-mq-reco')?.innerText.replace(/\\s+/g, ' ') || 'none'"));
  // add a second field through the "+ and the same…" select
  const added = await h.eval(`(() => { const a = document.querySelector('.ds-mq-add'); const o = [...a.options].find(o => /Phone|Website|Type|Industry/.test(o.text)) || a.options[1]; if (!o) return null; a.value = o.value; a.dispatchEvent(new Event('change', { bubbles: true })); return o.text; })()`);
  await h.sleep(1500);
  h.log('added:', added, '· sentence:', await h.eval("[...document.querySelectorAll('.ds-mq-sentence > *')].map(e => e.tagName === 'SELECT' ? '[' + (e.selectedOptions[0]?.text || '') + ']' : e.innerText).join(' ')"));
  h.log('empty-field question:', await h.eval("document.querySelector('.ds-mq-empty')?.innerText.replace(/\\s+/g, ' ') || 'none'"));
  await live('2. two fields');
  await h.eval("(() => { const f = document.querySelector('.ds-mq-fine'); if (f) f.open = true; const m = document.querySelector('.ds-mq-more'); if (m) m.open = true; return true; })()");
  await shoot('two');
  h.log('fold still open:', await h.eval("document.querySelector('.ds-match-fold').open"));
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 3)')).slice(0, 400));
}
