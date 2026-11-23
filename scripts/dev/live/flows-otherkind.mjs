// Read only. Under a kind tab of the Flows list a tree still shows whole; a flow of another kind in it is tagged and
// dimmed, and the tree says how many of its flows the tab counts (owner 2026-11-23). KIND=<tab> (default Flow = Screen).
export default async function (h) {
  await h.login(process.env.ORG || 'npc2'); await h.popup('flows'); await h.watchErrors?.();
  await h.eval("(() => { const st = document.createElement('style'); st.textContent = '* { transition: none !important; }'; document.head.appendChild(st); return true; })()");
  await h.waitFor("document.querySelectorAll('#flowList .flow-group').length > 0", 90000, 500).catch(() => {});
  await h.sleep(6000);
  const kind = process.env.KIND || 'Flow';
  h.log('All tab — guests:', await h.eval("document.querySelectorAll('#flowList .flow-otherkind-tag').length"));
  await h.eval(`document.querySelector('#flowTypeFilter .flow-type-btn[data-ftype="${kind}"]')?.click()`); await h.sleep(900);
  h.log('tab:', await h.eval("(document.querySelector('#flowTypeFilter .flow-type-btn.active')?.innerText || '').trim()"));
  h.log('rows:', await h.eval("document.querySelectorAll('#flowList .flow-group').length"), '· guests:', await h.eval("[...document.querySelectorAll('#flowList .flow-otherkind-tag')].map(e => e.innerText).join(' | ')"));
  h.log('tree badges:', await h.eval("[...document.querySelectorAll('#flowList .flow-tree-badge')].map(e => e.innerText).join(' || ')"));
  for (const dark of [false, true]) { await h.eval(`document.body.classList.toggle('sftk-dark', ${dark})`); await h.sleep(400); await h.shot(h.shots + `/flows-otherkind-${dark ? 'dark' : 'light'}.png`); }
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 3)')).slice(0, 300));
}
