// Read only, and NOTHING reaches Salesforce after the stub is on: what every tool says when the org answers
// REQUEST_LIMIT_EXCEEDED (backlog 2026-11-11: "Field Cleaner's data box kept loading until the script timed out —
// check what the tools say"). An org cannot be driven to its daily limit for a test, so the page's own channel to the
// background is answered here, for every Salesforce message, with the answer Salesforce gives at the limit.
// Per tool: the sentence shown, and whether anything is still spinning after WAIT seconds.
const LIMIT = 'HTTP 403: [{"message":"TotalRequests Limit exceeded.","errorCode":"REQUEST_LIMIT_EXCEEDED"}]';
const WAIT = Number(process.env.WAIT || 9) * 1000;
const STUB = `(() => {
  if (window.__sftkLimitStub) return true;
  const real = chrome.runtime.sendMessage.bind(chrome.runtime);
  window.__sftkLimitSeen = [];
  const fake = function (msg, ...rest) {
    if (msg && typeof msg.type === 'string' && /^SF_/.test(msg.type) && !/^SF_(RUN_|HISTORY|LEDGER)/.test(msg.type)) {
      window.__sftkLimitSeen.push(msg.type);
      const resp = { error: ${JSON.stringify(LIMIT)} };
      const cb = rest.find(x => typeof x === 'function');
      if (cb) { setTimeout(() => cb(resp), 120); return; }
      return new Promise(r => setTimeout(() => r(resp), 120));
    }
    return real(msg, ...rest);
  };
  try { chrome.runtime.sendMessage = fake; } catch (_) {}
  if (chrome.runtime.sendMessage !== fake) { try { Object.defineProperty(chrome.runtime, 'sendMessage', { value: fake, configurable: true }); } catch (_) {} }
  window.__sftkLimitStub = chrome.runtime.sendMessage === fake;
  return window.__sftkLimitStub;
})()`;
// what is on screen in `root`: the lines that speak of the limit, any raw code left showing, and what still spins
const LOOK = root => `(() => {
  const r = document.querySelector(${JSON.stringify(root)}) || document.body;
  const vis = e => !!(e && e.offsetParent !== null && e.getClientRects().length);
  const text = (r.innerText || '').split(String.fromCharCode(10)).map(s => s.trim()).filter(Boolean);
  const said = [...new Set(text.filter(l => /daily API calls|API limit|Limit exceeded|REQUEST_LIMIT/i.test(l)))].map(l => l.slice(0, 230));
  const raw = text.filter(l => /REQUEST_LIMIT_EXCEEDED|HTTP 403|\\[\\{"message"/.test(l)).length;
  const spin = [...r.querySelectorAll('.sftk-cat, .sftk-cat-sm, .sftk-cat-wrap, .spinner, .loading, [class*="spinner"], [class*="-loading"], [class*="loading-"], .ds-skel, [class*="skeleton"]')].filter(vis).map(e => (e.className + '').slice(0, 40) + ' “' + (e.innerText || '').trim().slice(0, 50) + '”');
  const toasts = [...document.querySelectorAll('.toast, .sftk-toast, .ds-toast, [class*="toast"]')].filter(vis).map(e => (e.innerText || '').trim().slice(0, 200)).filter(Boolean);
  return { said, raw, spin: [...new Set(spin)].slice(0, 5), toasts: [...new Set(toasts)].slice(0, 3), blank: text.length < 3 };
})()`;

export default async function (h) {
  const ORG = process.env.ORG || 'npc';
  const out = [];
  const report = (tool, v, seen) => { out.push({ tool, v }); h.log(`${v.said.length || v.toasts.some(t => /API/i.test(t)) ? '✔' : '✘'} ${tool}:`, JSON.stringify({ says: v.said.slice(0, 2), toasts: v.toasts.filter(t => /API|limit/i.test(t)).slice(0, 1), rawCodeLines: v.raw, stillSpinning: v.spin, calls: seen })); };
  // ── the Toolkit popup ──
  await h.login(ORG); await h.popup('licenses'); await h.watchErrors();
  await h.sleep(2500);
  h.log('stub on (popup):', await h.eval(STUB));
  for (const tab of ['flows', 'debugger', 'pages', 'fields', 'copy-perms', 'flow-access', 'licenses']) {
    await h.eval('window.__sftkLimitSeen = []');
    await h.eval(`(() => { const b = document.querySelector('.tab-btn[data-tab="${tab}"]'); if (b) b.click(); return !!b; })()`);
    await h.sleep(1200);
    // a tool that loaded before the stub (the tab the popup opened on) is asked again by its own reload control
    if (tab === 'licenses') await h.eval(`(() => { const b = [...document.querySelectorAll('#tab-licenses button')].find(b => /refresh|reload|load|🔄/i.test(b.textContent + (b.title || '')) && !b.disabled); if (b) b.click(); return !!b; })()`);
    if (tab === 'fields') {
      // the object picker reads the object list; type a name so the field list and the data box are asked too
      await h.eval(`(() => { const i = document.querySelector('#fcObjInput'); if (i) { i.focus(); i.dispatchEvent(new Event('focus')); i.value = 'Account'; i.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`);
    }
    await h.sleep(WAIT);
    report('popup · ' + tab, await h.eval(LOOK('body')), (await h.eval('[...new Set(window.__sftkLimitSeen)].length')) + ' kinds of call');
    if (process.env.SHOTS === '1') await h.shot(h.shots + `/limit-popup-${tab}.png`);
  }
  // ── Data Studio ──
  await h.login(process.env.ORG2 || 'npc2');
  await h.studio(''); await h.sleep(2000);
  await h.importProfiles('docs/fixtures/pii-fixture/profiles.json');
  const depId = await h.eval("_profiles.find(p => p.name === 'SFTK PII — Leads')?.id");
  h.log('stub on (studio):', await h.eval(STUB));
  const views = await h.eval(`[...document.querySelectorAll('.ds-nav-btn[data-view]')].map(b => b.dataset.view)`);
  h.log('studio views:', views.join(', '));
  for (const v of views) {
    await h.eval('window.__sftkLimitSeen = []');
    await h.eval(`(() => { const b = document.querySelector('.ds-nav-btn[data-view="${v}"]'); if (b) b.click(); return !!b; })()`);
    await h.sleep(1000);
    // press the view's own first "read the org" control, when it has one that is plainly that
    const pressed = await h.eval(`(() => { const b = [...document.querySelectorAll('#dsContent button, .ds-main button, main button')].find(b => b.offsetParent && !b.disabled && /(refresh|reload|scan|compare|load|check|run|read)/i.test(b.textContent.trim()) && !/deploy|delete|write|import|export|save/i.test(b.textContent)); if (b) b.click(); return b ? b.textContent.trim().slice(0, 30) : ''; })()`);
    if (pressed) h.log('   pressed:', pressed);
    await h.sleep(WAIT);
    report('studio · ' + v, await h.eval(LOOK('.ds-main, #dsContent, main')), (await h.eval('[...new Set(window.__sftkLimitSeen)].length')) + ' kinds of call');
    if (process.env.SHOTS === '1') await h.shot(h.shots + `/limit-studio-${v}.png`);
    await h.closeModal();
  }
  // the Deploy page of a deployment: its scan of both orgs
  await h.eval('window.__sftkLimitSeen = []');
  await h.eval(`window.runProfile(${JSON.stringify(depId)})`);
  await h.sleep(WAIT + 4000);
  report('studio · a deployment (scan)', await h.eval(LOOK('.ds-main, #dsContent, main')), (await h.eval('[...new Set(window.__sftkLimitSeen)].length')) + ' kinds of call');
  if (process.env.SHOTS === '1') await h.shot(h.shots + '/limit-studio-deployment.png');
  // an error box that carries the word "loading" in its class, and an SVG's animated class, are not spinners
  const bad = out.filter(o => o.v.spin.some(x => !/SVGAnimatedString|lp-robot-error/.test(x)) || o.v.raw);
  h.log('SUMMARY:', out.length, 'tools ·', out.filter(o => o.v.said.length).length, 'say it on the page ·', bad.length, 'still spin or show the raw code:', bad.map(o => o.tool).join(', ') || 'none');
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 4)')).slice(0, 500));
}
