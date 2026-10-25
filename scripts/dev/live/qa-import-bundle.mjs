// The real ⬆ Import dialog fed the fixture bundle (six exports in one list) through CDP's file input.
import { resolve } from 'node:path';
export default async function (h) {
  await h.login('npc'); await h.studio(''); await h.watchErrors();
  const before = await h.eval('_profiles.length');
  // headless: a file input's click fires 'cancel' at once and the dialog removes it — keep the input in the page
  await h.eval("(() => { const o = HTMLInputElement.prototype.click; HTMLInputElement.prototype.click = function () { if (this.type === 'file') return; return o.call(this); }; window.importProfileFromFile(); HTMLInputElement.prototype.click = o; return true; })()"); await h.sleep(300);
  const doc = await h.cdp('DOM.getDocument', { depth: 1 });
  const q = await h.cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
  if (!q.nodeId) throw new Error('no file input');
  await h.cdp('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [resolve('docs/fixtures/complex-deployment/profiles.json')] });
  await h.waitFor("!!document.querySelector('#dsModalBox .ds-modal-header')", 15000, 200); await h.sleep(300);
  h.log('modal:', (await h.eval("document.querySelector('#dsModalBox')?.innerText || ''")).slice(0, 700).replace(/\n+/g, ' | '));
  const after = await h.eval('_profiles.length');
  h.log('profiles:', before, '→', after, '| names:', await h.eval("_profiles.slice(-6).map(p => p.name).join(' · ')"));
  if (after - before !== 6) throw new Error('expected 6 imported');
  h.log('page errors:', JSON.stringify(await h.eval('(window.__sftkErrors || []).slice(0, 3)')).slice(0, 300));
}
