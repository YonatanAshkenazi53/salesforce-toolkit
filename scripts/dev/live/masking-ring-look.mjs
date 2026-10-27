// Live, read-only: (1) the builder's "N masked" chip opens the masked-fields
// dialog (what masking does, unmask one or all) — a rule is put on the editing
// copy only, nothing is saved; (2) All open orgs › Scan shows which deployment
// is being scanned (user 2026-10-27). Screenshots, light and dark.
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const id = await h.eval(`_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id`);
  // the builder, with two masked Account fields on the editing copy
  await h.eval(`(() => { const b = document.querySelector('[data-dsaction="editProfile"][data-arg="${id}"]'); if (b) b.click(); else window.editProfile?.(${JSON.stringify(id)}); return true; })()`);
  await h.waitFor("typeof _editingProfile !== 'undefined' && !!_editingProfile && !!document.querySelector('[data-files-btn]')", 30000, 500);
  await h.eval(`(() => { _editingProfile.piiPolicy = { 'Account.Phone': { strategy: 'hash' }, 'Account.Description': { strategy: 'null' } }; refreshTree(); return true; })()`); await h.sleep(600);
  h.log('chip:', await h.eval(`document.querySelector('[data-pii-chip]')?.textContent?.trim()`));
  await h.eval(`document.querySelector('[data-pii-chip]')?.click()`); await h.sleep(1200);
  h.log('MASK DIALOG:', await h.modalText(900));
  await h.shot(h.shots + '/mask-1.png');
  await h.eval(`(() => { document.documentElement.classList.add('ds-dark'); return true; })()`); await h.sleep(300);
  await h.shot(h.shots + '/mask-2-dark.png');
  await h.eval(`document.querySelector('[data-pii-unmask]')?.click()`); await h.sleep(800);
  h.log('after one unmask — chip:', await h.eval(`document.querySelector('[data-pii-chip]')?.textContent?.trim()`), '| dialog rows:', await h.eval(`document.querySelectorAll('[data-pii-row]').length`));
  await h.closeModal();
  await h.eval(`(() => { document.documentElement.classList.remove('ds-dark'); return true; })()`);
  // All open orgs: Scan all, caught mid-way
  await h.eval(`navigateToView('ring')`); await h.waitFor("!!document.querySelector('#dsRingSrc')", 60000, 500); await h.sleep(800);
  // the source: trailheads5, picked like a person would
  await h.eval(`(() => { const s = document.querySelector('#dsRingSrc'); const o = [...s.options].find(x => /trailheads5/.test(x.textContent)); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return o.textContent; })()`);
  await h.waitFor("!!document.querySelector('[data-ring-scanall]')", 60000, 500); await h.sleep(800);
  await h.eval(`document.querySelector('[data-ring-scanall]')?.click()`); await h.sleep(4000);
  h.log('RING chip:', await h.eval(`document.querySelector('[data-ring-scanall]')?.textContent`), '| scanning cells:', await h.eval(`[...document.querySelectorAll('.ds-ring-cell')].filter(c => /scanning/.test(c.textContent)).length`));
  await h.shot(h.shots + '/ring-progress.png');
}
