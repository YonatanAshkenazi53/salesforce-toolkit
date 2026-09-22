// Live: what exactly is in each bucket for one deployment — the engine's own answer
// (runDiffScan on the profile) next to what the Deploy page shows. Used to chase a
// count mismatch (Ring 7 missing vs Deploy 8 to insert, 2026-09-23).
//   PROFILE = deployment name (default: the Accounts tree)
const dump = async (h, sel, n = 2000) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
export default async function (h) {
  await h.login('npc'); await h.login('npc2');
  await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Accounts tree';
  const pid = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  h.log('profile id:', pid);
  // 1. the engine's answer, root only, as the Ring asks for it
  const eng = await h.eval(`(async () => { const p = _profiles.find(x => x.id === ${JSON.stringify(pid)}); const res = await runDiffScan({ ...p, ephemeral: true }); const nm = r => (r.sourceName || r.name || r.source?.Name || r.sourceRecord?.Name || r.targetName || r.target?.Name || JSON.stringify(r).slice(0, 80)); const pick = k => (res[k] || []).map(nm); return { keys: Object.keys(res), missing: pick('missingInTarget'), changed: pick('changed'), extra: pick('onlyInTarget'), same: pick('same') || pick('inSync'), counts: { missing: (res.missingInTarget||[]).length, changed: (res.changed||[]).length, extra: (res.onlyInTarget||[]).length, same: (res.same||res.inSync||[]).length, sourceTotal: res.sourceTotal ?? res.sourceCount ?? null, targetTotal: res.targetTotal ?? res.targetCount ?? null }, dupKeys: res.dupKeys || res.keyWarnings || null, row0: res.missingInTarget && res.missingInTarget[0] ? Object.keys(res.missingInTarget[0]) : null, matchMemory: (p.matchMemory && Object.keys(p.matchMemory).length) || 0 }; })()`);
  h.log('ENGINE (ring-style, ephemeral):', JSON.stringify(eng));
  // 2. the engine's answer with the profile as the Deploy page passes it (not ephemeral)
  const eng2 = await h.eval(`(async () => { const p = _profiles.find(x => x.id === ${JSON.stringify(pid)}); const res = await runDiffScan(p); const nm = r => (r.sourceName || r.name || r.source?.Name || r.sourceRecord?.Name || r.targetName || r.target?.Name || JSON.stringify(r).slice(0, 80)); return { missing: (res.missingInTarget||[]).map(nm), changed: (res.changed||[]).map(nm), extra: (res.onlyInTarget||[]).map(nm), matchMemoryAfter: (p.matchMemory && Object.keys(p.matchMemory).length) || 0, learned: (res.learnedPairs || []).length }; })()`);
  h.log('ENGINE (profile as-is):', JSON.stringify(eng2));
  // 3. the Deploy page
  await h.eval(`window.runProfile(${JSON.stringify(pid)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 600000, 1000);
  await h.sleep(1500);
  h.log('DEPLOY root buckets:', JSON.stringify(await h.eval(`[...document.querySelectorAll('[data-dep-obj=""][data-dep-tab]')].map(e => e.dataset.depTab + '=' + e.innerText.replace(/\\s+/g, ' ').trim())`)));
  for (const tab of ['ins', 'chg', 'ext']) {
    await h.eval(`document.querySelector('[data-dep-obj=""][data-dep-tab="${tab}"]')?.click()`); await h.sleep(600);
    h.log(`DEPLOY ${tab} rows:`, JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-dep-plan [data-dep-row], .ds-dep-plan .ds-dep-rec, .ds-dep-plan tbody tr, .ds-dep-plan .ds-rec-row')].map(r => r.innerText.replace(/\\s+/g, ' ').trim().slice(0, 90)).slice(0, 12)`)));
  }
  h.log('DEPLOY notes:', await dump(h, '.ds-dep-plan .ds-dep-note, .ds-dep-plan .ds-note, #dsDepNotes', 800));
  await h.shot(h.shots + '/bucket-dump.png');
}
