// The flying ragdoll, LIVE in both apps (owner 2026-11-14): bursts of screenshots while something really loads —
// Field Cleaner's scan in the Toolkit, a read of both orgs on the Deploy page of Data Studio. READ-ONLY.
// The frames land in <shots>/loader-tk-NNN.png and loader-ds-NNN.png; scripts/dev/logo/frames2gif.py makes the GIFs.
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
const burst = async (h, name, n, stillThere) => {
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (!(await h.eval(stillThere))) break;
    await h.shot(`${h.shots}/${name}-${String(++k).padStart(3, '0')}.png`);
  }
  return k;
};
export default async function (h) {
  const DARK = process.env.DARK === '1';
  await h.login('npc2'); await h.login('npc');   // npc last: the Toolkit works on the org opened last
  // ── the Toolkit: Field Cleaner's scan ──
  await h.popup('fields');
  if (DARK) await h.eval("(() => { document.documentElement.setAttribute('data-theme', 'dark'); document.body.classList.add('dark'); return true; })()");
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', 'Account');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', process.env.FIELD || 'SFTK_FC_Test_Status__c');
  await h.eval(`(() => { document.querySelector('#fcScanBtn').click(); return true; })()`);
  await h.waitFor("!!document.querySelector('#fcResults .sftk-cat-ringcat')", 20000, 100);
  h.log('toolkit frames:', await burst(h, 'loader-tk', 36, "!!document.querySelector('#fcResults .sftk-cat-ringcat')"));
  // ── Data Studio: the Deploy page reads both orgs ──
  await h.studio('');
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const id = await h.eval("_profiles.find(p => p.name === 'SFTK CX — Accounts tree')?.id");
  if (DARK) await h.eval("(() => { if (typeof applyDarkMode === 'function') applyDarkMode(true); else document.documentElement.classList.add('ds-dark'); return true; })()");
  await h.eval(`window.runProfile(${JSON.stringify(id)})`);
  await h.waitFor("!!document.querySelector('#dsDepLoader .sftk-cat-ringcat')", 60000, 100);
  h.log('data studio frames:', await burst(h, 'loader-ds', 36, "!!document.querySelector('#dsDepLoader')"));
  h.log('loader text seen:', await h.eval("document.querySelector('#dsDepLoader')?.innerText || '(gone — the read finished)'"));
  await h.waitFor("!document.querySelector('#dsDepLoader')", 400000, 1000);
  h.log('✅ the loader is gone once both orgs are read');
}
