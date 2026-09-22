const SHOTS = process.env.LOCALAPPDATA + '/Temp/sftk-headless-shots/';
export default async function (h) {
  await h.login('npc');
  await h.studio('');
  const id = await h.eval(`_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id`);
  if (!id) throw new Error('fixture profile not imported — run hs_import first');

  // 1. Deploy page with the target offline: Read both orgs must refuse plainly
  await h.eval(`window.runProfile(${JSON.stringify(id)})`);
  await h.sleep(2000);
  await h.click('#dsDepScan');
  await h.sleep(4000);
  h.log('after Read (target offline):', (await h.eval(`document.querySelector('.ds-dep-page, #dsMain, main')?.innerText || ''`)).slice(0, 500).replace(/\n+/g, ' | '));
  h.log('toasts:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-toast, .toast, [class*=toast]')].map(t => t.innerText.slice(0, 160))`)));
  await h.shot(SHOTS + 'deploy-read-offline.png');

  // 2. Builder: record picker on the root (source-only reads, no scan yet)
  await h.eval(`openProfileBuilder(_profiles.find(p => p.id === ${JSON.stringify(id)}))`);
  await h.sleep(2500);
  await h.clickText('/Records/', '.ds-tree-node');
  await h.waitFor("!!document.querySelector('#dsRecList')", 20000);
  await h.sleep(1500);
  h.log('picker rows:', await h.eval(`document.querySelectorAll('#dsRecList input[type=checkbox]').length`), '| head:', (await h.modalText(500)));
  await h.click('#dsRecAll'); await h.sleep(300);
  h.log('after All:', await h.text('#dsRecNote'));
  await h.click('#dsRecNone'); await h.sleep(300);
  await h.shot(SHOTS + 'picker-root.png');
  await h.closeModal();

  // 3. Fields & mapping on Contact (describe of the source; target offline → must say so, not crash)
  await h.clickText('/Fields/', '.ds-tree-children .ds-tree-node');
  await h.sleep(3500);
  h.log('fields modal:', await h.modalText(700));
  await h.shot(SHOTS + 'fields-contact.png');
  await h.closeModal();

  // 4. Preview counts on the root
  await h.clickText('/Preview/', '.ds-tree-node');
  await h.sleep(5000);
  h.log('preview:', await h.modalText(900));
  await h.shot(SHOTS + 'preview-root.png');
  await h.closeModal();

  // 5. Lookup resolution rows on the root: what the builder offers for ParentId (self-lookup)
  h.log('root lookup rows:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-tree-node .ds-lkp-rows')].slice(0,1).map(e => e.innerText.replace(/\\s+/g, ' ').slice(0, 400))`)));
  await h.clickText('/Cancel/', '.ds-view-header, .ds-bld-actions, body');
  await h.sleep(800);

  // 6. Identity dialog from the Deploy page (source online, target offline)
  await h.eval(`window.runProfile(${JSON.stringify(id)})`);
  await h.sleep(1500);
  const idBtn = await h.eval(`!!document.querySelector('#dsDepIdBtn')`);
  h.log('identity button present without a scan:', idBtn);
}
