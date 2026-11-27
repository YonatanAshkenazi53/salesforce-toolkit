// 2026-11-27, the owner on the Deploy page's automation panel, all objects stacked one under the other:
//   "i think this display can be better, it looks confusing. every object needs to be a tab."
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const D = read('studio-deploy.js'), C = read('studio.css');
describe('the automation panel shows one object at a time', () => {
  it('a tab per object that has automation; one object alone needs none', () => {
    expect(D).toContain('const tabs = withItems.length > 1 ? `<div class="ds-dep-pause-tabs" role="tablist" aria-label="Object">');
    expect(D).toContain('${withItems.filter(r => r.object === _depPauseTab).map(card).join(\'\')}');
    expect(D).not.toContain('${withItems.map(card).join(\'\')}');
  });
  it('the first object this run writes is the one shown, and a tab that is gone falls back', () => {
    expect(D).toContain("if (!withItems.some(r => r.object === _depPauseTab)) _depPauseTab = ((withItems.find(r => r.written) || withItems[0]) || {}).object || '';");
  });
  it('a tab is not one of the record list\'s object buttons (those switch the list)', () => {
    expect(D).toContain('class="ds-dep-pause-tab" data-pause-tab=');
    expect(D).not.toContain('ds-dep-objbtn ds-dep-pause-tab');
    expect(C).toContain('.ds-dep-pause-tab[aria-selected="true"]');
  });
  it('the ticks live in the run\'s state, not in the rows on screen — a hidden object keeps its ticks', () => {
    expect(D).toContain("host.querySelectorAll('[data-pause-tab]').forEach(b => b.addEventListener('click', () => { _depPauseTab = b.dataset.pauseTab; _depPausePaint(p); }));");
    expect(D).toContain('if (cb.checked) _depPauseSkip.delete(cb.dataset.key); else _depPauseSkip.add(cb.dataset.key);');
  });
});
