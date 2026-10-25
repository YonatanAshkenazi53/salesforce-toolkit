// Pick Records › Matching: choose Composite, add a second field — the switch is on, the key reads in labels.
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const id = await h.eval(`_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id`);
  await h.eval(`window.editProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.waitFor("!!document.querySelector('[data-records-btn=\"\"]')", 30000, 300);
  await h.eval(`document.querySelector('[data-records-btn=""]').click()`);
  await h.waitFor("!!document.querySelector('.ds-match-fold')", 60000, 300); await h.sleep(800);
  await h.eval(`(() => { const d = document.querySelector('.ds-match-fold'); d.open = true; return true; })()`);
  await h.eval(`(() => { const r = document.querySelector('input[name="dsMatchStrat"][value="composite"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await h.sleep(1500);
  const txt = () => h.eval(`(() => { const t = document.getElementById('dsMatchTiered'); return JSON.stringify({ tiered: t ? t.checked : 'no switch', readsAs: document.getElementById('dsMatchReadsAs')?.innerText || '', summary: document.querySelector('.ds-match-fold summary')?.innerText.split(String.fromCharCode(10)).join(' ') }); })()`);
  h.log('1. composite chosen:', await txt());
  // add a second and third field
  const added = await h.eval(`(() => { const sels = [...document.querySelectorAll('[data-match-comp]')]; const s = sels[1]; if (!s) return 'no slot'; const o = [...s.options].find(o => /Phone|BillingCity|AccountNumber|Site/.test(o.value)); if (!o) return 'no option'; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return o.value; })()`);
  await h.sleep(2500);
  h.log('2. added', added + ':', await txt());
  const added2 = await h.eval(`(() => { const sels = [...document.querySelectorAll('[data-match-comp]')]; const s = sels[2]; if (!s) return 'no slot'; const o = [...s.options].find(o => /Phone|BillingCity|AccountNumber|Site|Industry/.test(o.value) && !sels.slice(0, 2).some(x => x.value === o.value)); if (!o) return 'no option'; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return o.value; })()`);
  await h.sleep(2500);
  h.log('3. added', added2 + ':', await txt());
  await h.eval(`(() => { document.querySelector('.ds-match-cfg').scrollIntoView({ block: 'start' }); return true; })()`); await h.sleep(300);
  await h.shot('dist/qa/shots/tiered-panel.png');
  await h.eval(`(() => { const t = document.getElementById('dsMatchTiered'); t.checked = false; t.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await h.sleep(1200);
  h.log('4. switch off:', await txt());
  h.log('node.matching:', await h.eval(`JSON.stringify(_editingProfile?.tree?.matching || null)`));
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 3)')).slice(0, 300));
}
