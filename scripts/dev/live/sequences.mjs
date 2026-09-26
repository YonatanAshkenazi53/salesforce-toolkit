// Live: 🔗 Sequences — a two-step sequence of fixture deployments (Leads, then Campaigns —
// CampaignMember needs the Leads first), trailheads5 → trailheads4: the run confirmation,
// the run itself, the result. Then CLI-verify the target. Reset the target afterwards with
// cleanup.apex + seed-target.apex (docs/fixtures/complex-deployment/README.md).
//   STEPS="SFTK CX — Leads,SFTK CX — Campaigns"   profile names, in order
//   SCAN_ONLY=1   stop at the confirmation (nothing written)
const dump = async (h, sel, n = 2500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
export default async function (h) {
  await h.login('npc'); await h.login('npc2');
  await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const names = (process.env.STEPS || 'SFTK CX — Leads,SFTK CX — Campaigns').split(',').map(x => x.trim());
  const made = await h.eval(`(async () => { const ids = ${JSON.stringify(names)}.map(n => _profiles.find(p => p.name === n)?.id); if (ids.some(x => !x)) return 'missing profile: ' + JSON.stringify(ids); const seq = { id: 'seq_live_' + Date.now(), name: 'SFTK CX live sequence', sourceOrg: 'https://trailheads5.my.salesforce.com', targetOrg: 'https://trailheads4.my.salesforce.com', steps: ids, createdAt: new Date().toISOString() }; _sequences = (_sequences || []).filter(s => s.name !== seq.name); _sequences.push(seq); await storageSaveSequences(); if (typeof renderProfiles === 'function') renderProfiles(); return seq.id; })()`);
  h.log('sequence:', made);
  if (!String(made).startsWith('seq_')) return;
  await h.eval(`document.querySelector('[data-view="profiles"]')?.click()`);
  await h.waitFor(`!!document.querySelector('[data-seq-run="${made}"]')`, 60000, 500); await h.sleep(500);
  h.log('card:', await h.eval(`document.querySelector('[data-seq-run="${made}"]')?.closest('.ds-seq-card, [class*=seq]')?.innerText.replace(/\\s+/g, ' ').slice(0, 300)`));
  h.log('run button:', await h.eval(`(() => { const b = document.querySelector('[data-seq-run="${made}"]'); return b.textContent.trim() + (b.disabled ? ' (off)' : ''); })()`));
  await h.eval(`document.querySelector('[data-seq-run="${made}"]').click()`);
  await h.waitFor("!!document.querySelector('#dsSeqGo') || !!document.querySelector('#seqRunBody')", 60000, 500);
  await h.sleep(500);
  const gate = await h.eval(`!!document.querySelector('#dsSeqGo')`);
  h.log('CONFIRM shown:', gate, '|', await dump(h, '#dsModalBox', 1500));
  if (!gate) { h.log('❌ NO CONFIRMATION — the run started on the click'); return; }
  h.log('Go before ack:', await h.eval(`document.querySelector('#dsSeqGo')?.disabled ? 'disabled' : 'ENABLED'`));
  await h.shot(h.shots + '/seq-confirm.png');
  if (process.env.SCAN_ONLY === '1') { await h.eval(`document.querySelector('#dsSeqNo')?.click()`); h.log('SCAN_ONLY — cancelled'); return; }
  await h.eval(`(() => { const a = document.querySelector('#dsSeqAck'); a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await h.sleep(300);
  h.log('Go after ack:', await h.eval(`document.querySelector('#dsSeqGo')?.disabled ? 'disabled' : 'enabled'`));
  await h.eval(`document.querySelector('#dsSeqGo')?.click()`);
  await h.sleep(1500);
  if (await h.eval(`!!document.querySelector('#dsProdConfirmInput')`)) { h.log('TYPED GATE:', await dump(h, '#dsModalBox', 400)); await h.eval(`document.querySelector('#dsProdCancel')?.click()`); return; }
  await h.waitFor("!!document.querySelector('#seqRunClose') && !document.querySelector('#seqRunClose')?.disabled", 900000, 2000);
  await h.sleep(1000);
  h.log('RUN LOG:', await dump(h, '#dsSeqRunLog', 3000));
  h.log('RESULT:', await dump(h, '#seqRunBody', 1500));
  await h.shot(h.shots + '/seq-result.png');
  await h.eval(`document.querySelector('#seqRunClose')?.click()`); await h.sleep(500);
  await h.eval(`document.querySelector('[data-view="history"]')?.click()`); await h.sleep(1500);
  h.log('HISTORY newest:', await dump(h, '.ds-history-card, .ds-history-item', 600));
  if (process.env.ROLLBACK !== '1') return;
  // ↩ Roll back sequence — the newest History entry (same session: History lives in the profile's storage)
  await h.waitFor("!!document.querySelector('[data-dsaction=\"rollbackRun\"]:not([disabled])')", 20000, 500);
  await h.eval(`document.querySelector('[data-dsaction="rollbackRun"]:not([disabled])').click()`);
  await h.waitFor("!!document.querySelector('#dsUndoTyped') || (!!document.querySelector('#dsUndoPlan')?.innerText && !document.querySelector('#dsUndoGo'))", 300000, 1000);
  await h.sleep(1000);
  h.log('ROLLBACK PLAN:', await dump(h, '#dsUndoPlan', 4000));
  const forced = await h.eval(`(() => { let n = 0; document.querySelectorAll('[data-undo-force]').forEach(c => { c.checked = true; n++; }); return n; })()`);
  h.log('force boxes:', forced);
  const word = await h.eval(`(document.querySelector('#dsUndoTyped')?.placeholder || '')`);
  h.log('typed word asked:', JSON.stringify(word));
  if (!word) return;
  await h.eval(`(() => { const i = document.querySelector('#dsUndoTyped'); i.value = ${JSON.stringify(word)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.sleep(300);
  const rbBefore = await h.eval(`_history.filter(x => x.kind === 'rollback').length`);
  await h.eval(`document.querySelector('#dsUndoGo')?.click()`);
  for (let i = 0; i < 600; i++) { if (await h.eval(`_history.filter(x => x.kind === 'rollback').length > ${rbBefore}`)) break; await h.sleep(1000); }
  await h.sleep(2000);
  h.log('ROLLBACK LOG:', await dump(h, '#dsUndoLog', 2500));
  await h.shot(h.shots + '/seq-rollback.png');
  await h.eval(`(() => { if (typeof closeModal === 'function') closeModal(); return true; })()`); await h.sleep(500);
  await h.eval(`document.querySelector('[data-view="history"]')?.click()`); await h.sleep(1500);
  h.log('HISTORY after rollback:', await dump(h, '.ds-history-card, .ds-history-item', 700));
}
