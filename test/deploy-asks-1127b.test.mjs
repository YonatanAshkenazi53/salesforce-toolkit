// Owner 2026-11-27, four asks on the Deploy page (screenshots):
//  · "old icon is here as well. use something new" — the dry run's mark is the flask icon wherever the emoji is written
//  · "rescan should be placed here" — the Rescan button heads the column of rescan ticks
//  · "Should tick all records, both insert and updates"
//  · "how the user will know they are changing the matching field for parents?" · "if they found 0 parents i would
//    like to call it aligned"
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const DV = read('studio-deploy.js'), CORE = read('studio-core.js');
const fn = (src, name) => { const a = src.indexOf('function ' + name + '('); let d = 0, i = src.indexOf('{', a); for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; } return src.slice(a, i + 1); };

describe('every changed record of a scan (sftkDeployEveryChanged)', () => {
  const f = vm.runInNewContext('(' + fn(DV, 'sftkDeployEveryChanged') + ')');
  it('the root and every scanned child, by path', () => {
    expect(JSON.parse(JSON.stringify(f({ changed: [{ sourceId: 'a' }, { sourceId: '' }], children: { '0': { changed: [{ sourceId: 'c1' }, { sourceId: 'c2' }] }, '1': { changed: [] } } })))).toEqual({ '': ['a'], '0': ['c1', 'c2'] });
  });
  it('no scan, nothing', () => { expect(JSON.parse(JSON.stringify(f(null)))).toEqual({}); });
});

describe('the page', () => {
  it('the button names inserts and updates, and is offered when there are only updates', () => {
    expect(DV).toContain('${every.found || everyChgN ? `<div class="ds-rec-card-line"><button class="ds-btn ds-btn-xs" id="dsDepTickAll"');
    expect(DV).toContain("everyChgN ? `${nf(everyChgN)} to update` : ''");
  });
  it('Rescan is in the table head, and no longer a line of the card above', () => {
    expect(DV.split('id="dsDepRescanAll"').length - 1).toBe(1);
    expect(DV).not.toContain('dsDepRescanNote');
  });
  it('the parent match button says what it does, in both places', () => {
    expect(DV.split('✏ Change match field</button>').length - 1).toBe(2);
    expect(DV).not.toMatch(/data-dep-pmatch-edit="[^"]*" title="[^"]*">✏<\/button>/);
  });
  it('no parent record to pair reads as aligned, not as "0 records aligned"', () => {
    expect(DV).toContain("n === 0 ? ' · aligned (no record to pair)'");
    expect(DV).toContain("n === 0 ? '🔍 Check again' : '🔍 Check again to list them'");
  });
  it('the flask is drawn over the emoji, which stays in the text', () => {
    expect(CORE).toContain('const SFTK_FLASK_CH = ' + String.fromCharCode(39, 92) + 'u{1F9EA}' + String.fromCharCode(39) + ';');
    expect(CORE).toContain('s.innerHTML = `${dsIcon(\'flask\')}<span class="ds-flask-t">${SFTK_FLASK_CH}</span>`;');
    expect(CORE).toContain("p.closest('.ds-flask, script, style, textarea, option, title, [contenteditable]')");
    expect(read('studio.css')).toContain('.ds-flask-t {');
  });
});
