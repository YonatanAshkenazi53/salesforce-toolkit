// The matching field is said on every object row of the Builder (owner 2026-11-11: "no matching field? where did he go?").
// Opens the packaged-object deployment in the Builder, reads the chips, clicks one, checks the Matching window opens.
// READ-ONLY: nothing is saved.
export default async function (h) {
  await h.login('npc2'); await h.login('npc');
  await h.studio('#/profiles');
  await h.watchErrors();
  await h.importProfiles('docs/fixtures/packaged-object-fixture/profiles.json');
  const id = await h.eval("(_profiles.find(p => /SFTK Pkg/.test(p.name)) || {}).id || ''");
  if (!id) throw new Error('the packaged-object deployment was not imported');
  await h.eval(`window.editProfile(${JSON.stringify(id)})`);
  await h.waitFor("document.querySelectorAll('.ds-tree-match-chip').length > 0", 60000, 500); await h.sleep(1200);
  const chips = await h.eval("[...document.querySelectorAll('.ds-tree-match-chip')].map(b => b.innerText.replace(/\\s+/g, ' ').trim())");
  h.log('chips on the tree:', JSON.stringify(chips));
  await h.shot(h.shots + '/builder-match-chip.png');
  if (process.env.DARK === '1') { await h.eval("(() => { document.documentElement.classList.add('ds-dark'); return true; })()"); await h.sleep(400); await h.shot(h.shots + '/builder-match-chip-dark.png'); }
  if (chips.length < 2 || !chips.every(c => /^🔗 Matched by \S+/.test(c))) throw new Error('a row has no matching chip');
  await h.eval("(() => { document.querySelector('.ds-tree-match-chip').click(); return true; })()");
  await h.waitFor("/Pick Records/.test(document.body.innerText) && /Match on source/.test(document.body.innerText)", 60000, 500);
  h.log('window opened:', (await h.eval("(document.querySelector('.ds-modal, .modal, [role=dialog]')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 220)")));
  await h.shot(h.shots + '/builder-match-window.png');
  h.log('✅ every object row says its matching field, and the chip opens the Matching window');
}
