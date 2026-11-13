// Quick nav offers Activity and opens it (owner 2026-11-13: "activity is missing from quick nav"). READ-ONLY.
export default async function (h) {
  await h.login('npc'); await h.studio(''); await h.watchErrors();
  await h.eval("(() => { document.querySelector('#dsCmdPaletteBtn').click(); return true; })()"); await h.sleep(500);
  await h.eval("(() => { const i = document.querySelector('#dsCmdInput'); i.value = 'activ'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()"); await h.sleep(400);
  h.log('palette rows for "activ":', JSON.stringify(await h.eval("[...document.querySelectorAll('.ds-cmd-item-label')].map(e => e.innerText)")));
  await h.eval("(() => { document.querySelector('[data-cmd-view=\"__activity\"]').click(); return true; })()"); await h.sleep(1500);
  await h.shot(h.shots + '/quicknav-activity.png');
}
