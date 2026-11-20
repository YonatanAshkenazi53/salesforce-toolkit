// Nothing is saved and no org changes: the Builder's Record owners row and the root-object suggestion list, on the
// real page, light and dark (owner 2026-11-20: "i want to use the owner from the source if possible, if not to allow
// selection of a fallback user or queue" / "i cant see the object name here").
export default async function (h) {
  await h.login('npc2'); await h.login('npc');
  await h.studio('#/profiles');
  await h.waitFor("!!document.querySelector('#dsNewProfile')", 60000, 500); await h.sleep(800);
  await h.click('#dsNewProfile');
  await h.waitFor("!!document.querySelector('#dsProfileName')", 15000, 300); await h.sleep(500);
  const pick = (id, rx) => h.eval(`(() => { const s = document.querySelector('${id}'); const o = [...s.options].find(o => ${rx}.test(o.value)); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  h.log('before a target — hint:', await h.eval("document.querySelector('#dsProfileOwnerHint')?.textContent"), '| picker:', await h.eval("[...document.querySelectorAll('#dsProfileOwnerFallback option')].map(o => o.text).join(' / ')"));
  await pick('#dsProfileSrcOrg', '/c449e108c2/'); await h.sleep(400);
  await pick('#dsProfileTgtOrg', '/e2c4511b2b/'); await h.sleep(3500);
  h.log('mode options:', JSON.stringify(await h.eval("[...document.querySelectorAll('#dsProfileOwnerMode option')].map(o => o.text)")));
  h.log('picker groups:', JSON.stringify(await h.eval("[...document.querySelectorAll('#dsProfileOwnerFallback optgroup')].map(g => g.label + ': ' + g.children.length)")));
  h.log('first options:', JSON.stringify(await h.eval("[...document.querySelectorAll('#dsProfileOwnerFallback option')].slice(0, 3).map(o => o.text)")));
  h.log('hint:', await h.eval("document.querySelector('#dsProfileOwnerHint')?.textContent"));
  await h.eval("(() => { const i = document.querySelector('#dsRootObj'); i.focus(); i.value = 'dlrs__LookupP'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  await h.sleep(1500);
  await h.eval("document.querySelector('.ds-builder-name-row').scrollIntoView({ block: 'start' })");
  const col = () => h.eval("(() => { const a = document.querySelector('.ds-autocomplete-item-api'); return a ? a.textContent + ' ' + getComputedStyle(a).color + ' on ' + getComputedStyle(document.querySelector('.ds-autocomplete-list')).backgroundColor : 'no suggestion'; })()");
  h.log('card heights:', JSON.stringify(await h.eval("[...document.querySelectorAll('.ds-builder-org-col')].map(c => Math.round(c.getBoundingClientRect().height))")));
  h.log('hover Email:', await h.eval("document.querySelector('[data-owner-help=Email]').title"));
  h.log('hover lowercase emails:', await h.eval("document.querySelector('[data-owner-help=emailLower]').title"));
  for (const dark of [false, true]) {
    await h.eval(`document.documentElement.classList.toggle('ds-dark', ${dark})`); await h.sleep(500);
    h.log(dark ? 'dark' : 'light', 'suggestion:', await col());
    await h.shot(h.shots + `/builder-owners-${dark ? 'dark' : 'light'}.png`);
  }
}
