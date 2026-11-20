// No org is changed: Copy Permissions while its users load — one cat for the page, large and centred (owner
// 2026-11-20: "this one has two thinking kittens. we need one but make it bigger somehow and make it sit correctly").
// The loading state is brief, so the two lists are put back into it by hand with the page's own markup and CSS.
export default async function (h) {
  await h.login('npc'); await h.popup('copy-perms'); await h.sleep(2500);
  h.log('lists:', await h.eval("['ucSourceList','ucTargetList'].map(i => !!document.getElementById(i)).join(',')"));
  await h.eval(`(() => {
    document.getElementById('ucSourceList').innerHTML = '<div class="uc-drop-loading uc-drop-loading-one">' + window.sftkCatSvg('load', 96) + '<span>Loading this org’s users…</span></div>';
    document.getElementById('ucTargetList').innerHTML = '<div class="uc-drop-loading uc-drop-loading-quiet">The same list of users appears here.</div>';
    return true; })()`);
  h.log('cats on the page:', await h.eval("document.querySelectorAll('#ucSourceList svg, #ucTargetList svg').length"));
  for (const dark of [false, true]) {
    await h.eval(`document.body.classList.toggle('sftk-dark', ${dark})`); await h.sleep(400);
    await h.shot(h.shots + `/uc-one-cat-${dark ? 'dark' : 'light'}.png`);
  }
}
