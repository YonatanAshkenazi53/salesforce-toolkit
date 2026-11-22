// Read only. The Flows list as the one view (owner 2026-11-22: "this should be the only tab, but should display
// dependecies, filters, package flows, and everything else the old dependecies had"): no Dependencies fold, the
// what-uses search narrows the list, 🧨 and ⛓ on each flow, the managed package flows at the end. Light and dark.
// TERM=<what to search> (default Account). Export and Rescan are NOT pressed.
export default async function (h) {
  await h.login(process.env.ORG || 'npc2'); await h.popup('flows'); await h.watchErrors?.();
  await h.eval("(() => { const st = document.createElement('style'); st.textContent = '* { transition: none !important; }'; document.head.appendChild(st); return true; })()");
  await h.waitFor("document.querySelectorAll('#flowList .flow-group').length > 0", 90000, 500).catch(() => {});
  await h.sleep(6000);
  const shots = async tag => { for (const dark of [false, true]) { await h.eval(`document.body.classList.toggle('sftk-dark', ${dark})`); await h.sleep(400); await h.shot(h.shots + `/flows-tools-${tag}-${dark ? 'dark' : 'light'}.png`); } };
  h.log('fold gone:', await h.eval("!document.getElementById('flowDepsFold') && !document.getElementById('depTreeContainer')"));
  h.log('tools:', await h.eval("[...document.querySelectorAll('#flowDepTools button, #flowDepTools input')].filter(e => e.offsetParent).map(e => e.id).join(' | ')"));
  h.log('rows:', await h.eval("document.querySelectorAll('#flowList .flow-group').length"), '· 🧨:', await h.eval("document.querySelectorAll('#flowList .flow-dep-btn').length"));
  h.log('managed:', await h.eval("(document.querySelector('#flowList .flow-managed > summary')?.innerText || 'NONE').replace(/\\s+/g, ' ')"), '· rows', await h.eval("document.querySelectorAll('#flowList .flow-managed-row').length"));
  await shots('list');
  // a version row's dates
  await h.eval("document.querySelector('#flowList .flow-group-header')?.click()"); await h.sleep(500);
  h.log('version row:', await h.eval("(document.querySelector('#flowList .version-row')?.innerText || '').replace(/\\s+/g, ' ')"));
  // what uses
  const term = process.env.TERM_USES || 'Account';
  await h.eval(`(() => { const i = document.getElementById('flowUsesInput'); i.value = ${JSON.stringify(term)}; document.getElementById('flowUsesGo').click(); return true; })()`); await h.sleep(1200);
  h.log('uses note:', await h.eval("(document.getElementById('flowUsesNote')?.innerText || '').replace(/\\s+/g, ' ')"));
  h.log('rows under the search:', await h.eval("document.querySelectorAll('#flowList .flow-group').length"), '· counts:', await h.eval("[...document.querySelectorAll('#flowList .flow-uses-count')].slice(0, 6).map(e => e.innerText).join(' ')"), '· empty:', await h.eval("(document.getElementById('emptyState')?.offsetParent ? document.getElementById('emptyState').innerText : '')"));
  await shots('uses');
  await h.eval("document.getElementById('flowUsesClear').click()"); await h.sleep(800);
  h.log('rows after clear:', await h.eval("document.querySelectorAll('#flowList .flow-group').length"));
  // blast radius and chain of the first flow
  await h.eval("document.querySelector('#flowList .flow-dep-btn')?.click()"); await h.sleep(800);
  h.log('blast panel:', await h.eval("(document.querySelector('.dep-blast-panel')?.innerText || 'NONE').replace(/\\s+/g, ' ').slice(0, 300)"));
  await h.eval("document.querySelectorAll('#flowList .flow-dep-btn')[1]?.click()"); await h.sleep(800);
  h.log('chain panel:', await h.eval("(document.querySelector('.dep-chain-panel')?.innerText || 'NONE').replace(/\\s+/g, ' ').slice(0, 300)"));
  await h.eval("document.querySelector('#flowList .flow-managed > summary')?.click()"); await h.sleep(400);
  await h.eval("document.querySelector('#flowList .flow-managed')?.scrollIntoView({ block: 'start' })"); await h.sleep(400);
  await shots('managed');
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 3)')).slice(0, 300));
}
