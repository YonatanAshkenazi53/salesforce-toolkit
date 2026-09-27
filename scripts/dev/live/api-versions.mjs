// Live: ⚙ API versions (Dependencies tab) — pick the fixture flows
// (docs/fixtures/apiver-fixture: SFTK_AV_Test_A 60 Active, _B 62 Active, _C 58 Draft),
// choose a target API version, type CHANGE, apply, and report the log.
//   ORGS=npc[,npc2]   which orgs to log in (default npc only)
//   PICK=<regex>      which flow API names to tick (default ^SFTK_AV_Test)
//   TARGET=67.0       target API version option (default: the newest option offered)
//   SCAN_ONLY=1       stop after the confirmation text (nothing written)
const dump = async (h, sel, n = 2500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | ');
export default async function (h) {
  for (const o of (process.env.ORGS || 'npc').split(',')) await h.login(o.trim());
  await h.popup('dependencies');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#depApiVerBtn')", 240000, 1000);
  h.log('banner:', await dump(h, '#depNoDataBanner', 300));
  await h.sleep(800);
  await h.eval(`document.querySelector('#depApiVerBtn').click()`);
  // the panel reads every flow version of every org — wait for rows or a verdict
  await h.waitFor("document.querySelectorAll('.dep-av-pick').length > 0 || /could not|no flows|nothing/i.test(document.querySelector('#depAvOut')?.innerText || '')", 300000, 1500);
  await h.sleep(1500);
  const opts = await h.eval(`[...document.querySelectorAll('#depAvTarget option')].map(o => o.value + ':' + o.textContent.trim())`);
  h.log('target options:', JSON.stringify(opts));
  const pick = process.env.PICK || '^SFTK_AV_Test';
  const rows = await h.eval(`[...document.querySelectorAll('.dep-av-pick')].filter(c => new RegExp(${JSON.stringify(pick)}).test(c.value)).map(c => c.value + (c.disabled ? ' (LOCKED: ' + (c.closest('label')?.title || '') + ')' : '') + ' :: ' + (c.closest('label')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 220))`);
  h.log('fixture rows:', JSON.stringify(rows, null, 0));
  h.log('rows total:', await h.eval(`document.querySelectorAll('.dep-av-pick').length`), 'locked:', await h.eval(`document.querySelectorAll('.dep-av-pick[disabled]').length`));
  await h.shot(h.shots + '/apiver-panel.png');
  // tick only the fixture flows
  const ticked = await h.eval(`(() => { let n = 0; document.querySelectorAll('.dep-av-pick').forEach(c => { const want = new RegExp(${JSON.stringify(pick)}).test(c.value) && !c.disabled; if (c.checked !== want) { c.checked = want; c.dispatchEvent(new Event('change', { bubbles: true })); } if (want) n++; }); return n; })()`);
  h.log('ticked:', ticked);
  const target = process.env.TARGET || (opts.length ? opts[opts.length - 1].split(':')[0] : '');
  await h.eval(`(() => { const s = document.querySelector('#depAvTarget'); s.value = ${JSON.stringify(target)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
  h.log('target set to:', target, '→ select now reads', await h.eval(`document.querySelector('#depAvTarget')?.value`));
  h.log('apply button:', await h.eval(`(() => { const b = document.querySelector('#depAvApply'); return b ? b.textContent.trim() + (b.disabled ? ' (off)' : '') : null; })()`));
  await h.eval(`document.querySelector('#depAvApply')?.click()`);
  await h.waitFor("!!document.querySelector('#sftkConfirmGo') || /nothing to|no change|already/i.test(document.querySelector('#depAvApplyOut')?.innerText || '')", 120000, 500);
  await h.sleep(500);
  h.log('CONFIRM:', await dump(h, '#modalBox', 2500));
  await h.shot(h.shots + '/apiver-confirm.png');
  if (process.env.SCAN_ONLY === '1') { h.log('SCAN_ONLY — cancelling'); await h.eval(`document.querySelector('#sftkConfirmCancel')?.click()`); return; }
  const hasInp = await h.eval(`!!document.querySelector('#sftkConfirmWord')`);
  if (!hasInp) { h.log('no confirmation input — stopping'); return; }
  await h.eval(`(() => { const i = document.querySelector('#sftkConfirmWord'); i.value = 'CHANGE'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.sleep(300);
  h.log('Apply enabled:', await h.eval(`!document.querySelector('#sftkConfirmGo')?.disabled`));
  await h.eval(`document.querySelector('#sftkConfirmGo')?.click()`);
  await h.sleep(400);
  if (await h.eval(`!!document.querySelector('#sftkConfirmProd')`)) {
    h.log('TYPED GATE (production):', await dump(h, '#modalBox', 500));
    await h.eval(`(() => { const i = document.querySelector('#sftkConfirmProd'); i.value = i.placeholder; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await h.eval(`document.querySelector('#sftkConfirmProdGo')?.click()`);
  }
  // the last log line is the ℹ summary ("… changed and verified … refused the package …")
  await h.waitFor("/refused the package|changed across/.test(document.querySelector('#depAvLog')?.innerText || '')", 600000, 1500);
  await h.sleep(1000);
  h.log('LOG:', await dump(h, '#depAvLog', 4000));
  h.log('PROG:', await dump(h, '#depAvApplyProg', 100));
  await h.shot(h.shots + '/apiver-log.png');
}
