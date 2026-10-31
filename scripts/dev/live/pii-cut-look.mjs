// Live, read-only, on the PACKED build (SFTK_EXT=dist/store-staging): PII masking is cut from
// the first release (user 2026-10-31: "not good enough for the first release"). The builder
// shows no "Suggest PII masks" button and no "N masked" chip even when the editing copy
// carries a policy; an imported deployment loses its policy. Nothing is saved.
export default async function (h) {
  await h.login('npc2'); await h.studio(''); await h.watchErrors();
  h.log('SFTK_CUT:', JSON.stringify(await h.eval(`window.SFTK_CUT`)));
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const id = await h.eval(`_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id`);
  await h.eval(`(() => { const b = document.querySelector('[data-dsaction="editProfile"][data-arg="${id}"]'); if (b) b.click(); else window.editProfile?.(${JSON.stringify(id)}); return true; })()`);
  await h.waitFor("typeof _editingProfile !== 'undefined' && !!_editingProfile && !!document.querySelector('[data-files-btn]')", 30000, 500);
  h.log('header buttons:', await h.eval(`[...document.querySelectorAll('.ds-view-header .ds-btn, .ds-bld-head .ds-btn, #dsBldCheckTargets, #dsBldSuggestPii')].map(b => b.textContent.trim()).join(' | ')`));
  h.log('Suggest PII button present:', await h.eval(`!!document.querySelector('#dsBldSuggestPii')`));
  await h.eval(`(() => { _editingProfile.piiPolicy = { 'Account.Phone': { strategy: 'hash' } }; refreshTree(); return true; })()`); await h.sleep(600);
  h.log('masked chip present with a policy on the editing copy:', await h.eval(`!!document.querySelector('[data-pii-chip]')`));
  await h.shot(h.shots + '/pii-cut-builder.png');
}
