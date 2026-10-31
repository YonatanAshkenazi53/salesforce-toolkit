export default async function (h) {
  await h.studio('');
  await h.eval(`navigateToView('history')`);
  await h.sleep(1500);
  await h.eval(`document.querySelectorAll('details').forEach(d => d.open = true)`);
  const raw = await h.eval(`(() => { const c = document.querySelector('.ds-history-card, .ds-history-item'); const d = c && c.querySelector('.ds-err-raw'); return d ? d.innerText : (c ? c.innerText.slice(-2500) : 'no card'); })()`);
  h.log('NEWEST RUN RAW LINES:', raw.replace(/\n+/g, ' | ').slice(0, 3000));
  h.log('bg version check — late-link code present in the loaded worker?', await h.eval(`(async () => { const r = await fetch(chrome.runtime.getURL('background.js')); const t = await r.text(); return t.includes('nodeLateRefs'); })()`));
}
