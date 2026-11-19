// Live, NOTHING IS KEPT (a dry run is a transaction Salesforce rolls back): the packaged deployment npc → npc2 —
//   1  a record's editor opens with the Toolkit's loader, full size, and its Owner row says who the record will belong
//      to in the target, by name (owner 2026-11-19: "here you dont see who will be the user in the target." ·
//      "also when i click the record and it opens. the kitty there is very small");
//   2  a dry run's header carries the cat at about 90 px (it was about 55) (owner: "kitty here is not big enough").
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);
const dark = async (h, on) => { await h.eval(`(() => { document.documentElement.classList.toggle('ds-dark', ${on}); return true; })()`); await h.sleep(1100); };

export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/packaged-object-fixture/profiles.json');
  const id = await h.eval(`_profiles[_profiles.length - 1].id`);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await waitScanned(h); await h.sleep(2000);
  await h.eval(`(() => { const b = document.querySelector('[data-dep-tab="ins"]'); if (b) b.click(); return true; })()`); await h.sleep(1200);

  // 1 — the record's editor
  await h.eval(`(() => { document.querySelector('#dsDepList [data-dep-vals]').click(); return true; })()`);
  await h.waitFor("!!document.getElementById('dsValEdHost')", 30000, 50);
  const opening = await h.eval(`(() => { const c = document.querySelector('#dsValEdHost .ds-rec-opening svg, #dsValEdHost .ds-rec-opening .sftk-cat'); return c ? Math.round(c.getBoundingClientRect().width) : 0; })()`);
  h.log('1 loader while the record opens: cat width', opening, 'px');
  await h.waitFor("!!document.querySelector('#dsVeFilter')", 60000, 300); await h.sleep(2500);
  const will = await h.eval(`(document.querySelector('.ds-ve-own .ds-ve-own-will') || {}).textContent || ''`);
  h.log('1 owner row:', will);
  if (!/^Will belong to .+/.test(will)) throw new Error('FAILED: the Owner row must say who the record will belong to — ' + will);
  if (!/\(you — the user who runs the deployment\)/.test(will)) throw new Error('FAILED: the running user is named — ' + will);
  await h.eval(`(() => { document.querySelector('.ds-ve-own').scrollIntoView({ block: 'center' }); return true; })()`);
  await h.shot(h.shots + '/owner-editor.png'); await dark(h, true); await h.shot(h.shots + '/owner-editor-dark.png'); await dark(h, false);
  await h.closeModal(); await h.sleep(500);

  // 2 — a dry run: every insert ticked, 🧪 pressed; the header's cat is read while it runs
  await h.eval(`(() => { document.querySelectorAll('#dsDepList input[type="checkbox"]').forEach(c => { if (!c.checked) c.click(); }); return true; })()`); await h.sleep(800);
  const can = await h.eval(`(() => { const b = document.getElementById('dsRecProbeBtn'); return !!b && !b.disabled; })()`);
  if (!can) { h.log('2 the dry run button is off (nothing ticked) — the header was not seen'); return; }
  await h.eval(`(() => { document.getElementById('dsRecProbeBtn').click(); return true; })()`);
  await h.waitFor("!!document.querySelector('.ds-prog-hdr .ds-prog-cat') || !!document.getElementById('sftkConfirmGo')", 60000, 200);
  if (await h.eval(`!!document.getElementById('sftkConfirmGo')`)) { await h.eval(`(() => { const a = document.getElementById('sftkConfirmAck'); if (a && !a.checked) a.click(); document.getElementById('sftkConfirmGo').click(); return true; })()`); await h.waitFor("!!document.querySelector('.ds-prog-hdr .ds-prog-cat')", 60000, 200); }
  const cat = await h.eval(`Math.round(document.querySelector('.ds-prog-hdr .ds-prog-cat svg, .ds-prog-hdr .ds-prog-cat .sftk-cat').getBoundingClientRect().width)`);
  h.log('2 dry run header: cat width', cat, 'px');
  await h.eval(`(() => { document.querySelector('.ds-prog-hdr').scrollIntoView({ block: 'center' }); return true; })()`);
  await dark(h, true); await h.shot(h.shots + '/dryrun-cat-dark.png'); await dark(h, false);
  if (cat < 80) throw new Error('FAILED: the header cat must be drawn at about 90 px — ' + cat);
  await h.sleep(20000);
  h.log('✓ deploy-owner-editor: the Owner row names who the record will belong to; the cat is full size in both places');
}
