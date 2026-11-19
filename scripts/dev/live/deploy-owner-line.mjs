// Live, read-only: the record's compare window on the Deploy page names who owns the record in BOTH orgs (owner
// 2026-11-19: "when you click data deployment record and look for the owner field, we will not see who is the owner
// in the target" · "what about owners in the record?"). The Accounts-tree deployment (npc → npc2) is scanned, a tab
// that holds records present in both orgs is opened, and the first record's fields are opened. Nothing is written.
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);

export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const id = await h.eval(`_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id`);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await waitScanned(h); await h.sleep(1500);
  const tabs = await h.eval(`[...document.querySelectorAll('[data-dep-tab]')].map(b => b.dataset.depTab + ':' + b.textContent.replace(/\\s+/g, ' ').trim().slice(0, 30))`);
  h.log('tabs:', JSON.stringify(tabs));
  let opened = '';
  for (const t of [...new Set(tabs.map(x => x.split(':')[0]))]) {
    await h.eval(`(() => { const b = document.querySelector('[data-dep-tab="${t}"]'); if (b) b.click(); return true; })()`); await h.sleep(1200);
    if (await h.eval(`!!document.querySelector('#dsDepList [data-dep-fields]')`)) { opened = t; break; }
  }
  if (!opened) throw new Error('FAILED: no tab holds a record that exists in both orgs — nothing to compare');
  h.log('tab with records in both orgs:', opened);
  await h.eval(`(() => { document.querySelector('#dsDepList [data-dep-fields]').click(); return true; })()`);
  await h.waitFor("!!document.querySelector('.ds-dc-modal-body') && !document.querySelector('.ds-drift-compare-loading')", 120000, 500);
  await h.waitFor("(() => { const o = document.getElementById('dsDcOwner'); return !!o && !o.hidden; })()", 60000, 500);
  const line = await h.eval(`document.getElementById('dsDcOwner').textContent`);
  h.log('owner line:', line);
  if (!/^👤 Owner — .+ in .+ · .+ in .+\./.test(line)) throw new Error('FAILED: the line must name the owner in both orgs — ' + line);
  await h.shot(h.shots + '/owner-line.png');
  await h.eval(`(() => { document.documentElement.classList.add('ds-dark'); return true; })()`); await h.sleep(1200);
  await h.shot(h.shots + '/owner-line-dark.png');
  await h.eval(`(() => { document.documentElement.classList.remove('ds-dark'); return true; })()`);
  h.log('✓ deploy-owner-line: the compare window names the owner in both orgs; nothing written');
}
