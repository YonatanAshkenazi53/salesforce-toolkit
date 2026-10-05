// Live: Deploy page › 📦 This deployment (the object tree). Read-only: opens a
// deployment, scans the root (SCAN_KIDS=1 also scans every child), and shows
// the tree as text and as a screenshot.
//   PROFILE   deployment name (default: the CX fixture's Accounts tree)
//   SCAN_KIDS=1   press "Scan all" so every child has numbers too
const NL = String.fromCharCode(10);
const dump = async (h, sel, n = 3000) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);
export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/complex-deployment/profiles.json');
  const NAME = process.env.PROFILE || 'SFTK CX — Accounts tree';
  h.log('deployments:', JSON.stringify(await h.eval(`_profiles.map(p => p.name)`)));
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(NAME)})?.id`);
  if (!id) throw new Error('profile missing: ' + NAME);
  await h.eval(`window.runProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await waitScanned(h); await h.sleep(2500);
  if (process.env.SCAN_KIDS === '1') {
    const b = await h.eval(`(() => { const x = [...document.querySelectorAll('button')].find(b => /Scan all/.test(b.textContent)); if (x) x.click(); return x ? x.textContent.trim() : null; })()`);
    h.log('scan all:', b);
    await h.sleep(2000);
    await h.waitFor("![...document.querySelectorAll('button')].some(b => /⏳/.test(b.textContent))", 600000, 1500);
    await h.sleep(2500);
  }
  // identity + order data arrive after the first paint
  await h.waitFor("!/…/.test(document.querySelector('#dsDepTree')?.innerText || '…') || true", 20000, 1000);
  await h.sleep(6000);
  h.log('TREE:', await dump(h, '#dsDepTree', 4000));
  h.log('PLAN:', await dump(h, '.ds-dep-plan', 1500));
  // 🔎 Count on the first card that offers it (COUNT=0 skips): the card must then show both orgs' numbers
  if (process.env.COUNT !== '0') {
    const which = await h.eval(`(() => { const b = document.querySelector('[data-tree-scan]'); if (!b) return null; const n = b.closest('.ds-dtree-node').querySelector('.ds-dtree-name').innerText; b.click(); return n; })()`);
    h.log('counting:', which);
    if (which) {
      await h.sleep(1500);
      await h.waitFor("![...document.querySelectorAll('[data-tree-scan]')].some(b => /⏳/.test(b.textContent))", 300000, 1000);
      await h.sleep(6000);
      h.log('CARDS after the count:', JSON.stringify(await h.eval(`[...document.querySelectorAll('.ds-dtree-node')].slice(0, 3).map(n => n.innerText.split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' | '))`)));
      // a chip opens its own tab of that object
      const chip = await h.eval(`(() => { const c = document.querySelectorAll('.ds-dtree-node')[1]?.querySelector('[data-tree-tab]'); if (!c) return null; const t = c.innerText; c.click(); return t; })()`);
      await h.sleep(2500);
      h.log('clicked chip:', chip, '→ object:', await h.eval(`document.querySelector('.ds-dep-objbtn[aria-pressed="true"]')?.innerText`), '· tab:', await h.eval(`document.querySelector('.ds-dep-tabs [aria-selected="true"]')?.innerText`));
    }
  }
  await h.eval(`(() => { document.querySelector('#dsDepTree')?.scrollIntoView({ block: 'start' }); return true; })()`); await h.sleep(500);
  await h.shot(h.shots + '/dep-tree.png');
}
