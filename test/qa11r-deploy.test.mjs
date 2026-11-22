// QA 1.1 regression run, the Deploy page's two findings.
// #8  — a name whose other-org copy is paired from match memory was listed as "none in <other org>".
// #16 — the button on the root object's duplicate-names card opened the tab of whichever object was on screen.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunction, extractFunctions } from './extract.mjs';
const DP = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const { sftkDepOneSidedDups: dups } = extractFunctions('studio-deploy.js', ['sftkDepOneSidedDups']);
const key = r => r.matchKey;

describe('#8 — a one-sided name with a copy that is already paired', () => {
  // three "Acme" in the source, one in the target; the user answered the first one, the scan paired it from memory
  const scan = {
    missingInTarget: [{ matchKey: 'Acme', sourceId: 's2', dupKey: true }, { matchKey: 'Acme', sourceId: 's3', dupKey: true },
      { matchKey: 'Lone', sourceId: 'l1', dupKey: true }, { matchKey: 'Lone', sourceId: 'l2', dupKey: true }],
    onlyInTarget: [{ matchKey: 'Old', targetId: 't2', dupKey: true }, { matchKey: 'Old', targetId: 't3', dupKey: true }],
    identical: [{ matchKey: 'Acme', sourceId: 's1', targetId: 't1', viaMemory: true }],
    changed: [{ matchKey: 'Old', sourceId: 'o1', targetId: 'o9', fields: ['Phone'], viaMemory: true }, { matchKey: 'Old', sourceId: 'o2', targetId: 'o8', fields: ['Fax'] },
      { matchKey: 'Other', sourceId: 'x1', targetId: 'x2', fields: ['Fax'] }],
  };
  it('the group carries how many records of the name the scan paired; a name with none carries nothing', () => {
    expect(dups(scan, key)).toEqual([
      { name: 'Acme', side: 'src', ids: ['s2', 's3'], paired: 1 },
      { name: 'Lone', side: 'src', ids: ['l1', 'l2'] },
      { name: 'Old', side: 'tgt', ids: ['t2', 't3'], paired: 2 },
    ]);
    expect('paired' in dups(scan, key)[1]).toBe(false);
  });
  it('a paired record is counted once, and a row without both ids is not a pair', () => {
    const s = { missingInTarget: [{ matchKey: 'A', sourceId: '1' }, { matchKey: 'A', sourceId: '2' }],
      identical: [{ matchKey: 'A', sourceId: '3', targetId: 't' }, { matchKey: 'A', sourceId: '4' }, null], changed: [{ matchKey: 'A', sourceId: '3', targetId: 't', fields: [] }] };
    expect(dups(s, key)[0].paired).toBe(1);
  });

  const draw = () => {
    globalThis.esc = s => String(s ?? ''); globalThis.orgLabel = u => String(u);
    return extractFunction('studio-deploy.js', '_depOneSidedHtml');
  };
  const p = { sourceOrg: 'SRC', targetOrg: 'TGT' };
  it('the line of such a name does not say the other org has none', () => {
    const html = draw()(p, dups(scan, key), 3);
    expect(html).toContain('<b>2 copies in SRC</b> have no pair in TGT — a run creates all 2 there, beside the 1 of this name already paired.');
    expect(html).toContain('<b>2 copies in TGT</b> have no pair in SRC — a run leaves them as they are. 2 of this name are already paired.');
    expect(html).toContain('<b>2 copies in SRC</b>, none in TGT — a run creates all 2 there.');   // "Lone": nothing paired, the old line is true
    expect(html).not.toContain('the other org has no record of the name');
    expect(html).toContain('There is nothing to decide here: the other org has no unpaired record of the name.');
    expect(html).not.toContain('that only one org holds, more than once');
  });
  it('one paired record reads in the singular', () => {
    const html = draw()(p, [{ name: 'Old', side: 'tgt', ids: ['t2', 't3'], paired: 1 }], 1);
    expect(html).toContain('1 of this name is already paired.');
  });
  it('with nothing paired and the whole list on screen, the sentences are the ones there before', () => {
    const html = draw()(p, [{ name: 'Lone', side: 'src', ids: ['l1', 'l2'] }, { name: 'Gone', side: 'tgt', ids: ['g1', 'g2'] }], 2);
    expect(html).toContain('<b>2 names that only one org holds, more than once.</b> There is nothing to decide here: the other org has no record of the name.');
    expect(html).toContain('<b>2 copies in SRC</b>, none in TGT — a run creates all 2 there.');
    expect(html).toContain('<b>2 copies in TGT</b>, none in SRC — a run leaves them as they are.');
  });
  it('a list cut short does not vouch for the names it does not show', () => {
    const html = draw()(p, [{ name: 'Lone', side: 'src', ids: ['l1', 'l2'] }], 60);
    expect(html).not.toContain('the other org has no record of the name');
    expect(html).toContain('<b>60 names with more than one copy in one org and no record left to pair in the other.</b>');
  });
  it('when the scan cut its lists of paired records, no line says the other org has none', () => {
    const html = draw()(p, [{ name: 'Lone', side: 'src', ids: ['l1', 'l2'], pairsCut: true }, { name: 'Gone', side: 'tgt', ids: ['g1', 'g2'], pairsCut: true }], 2);
    expect(DP).toContain("if (oneSidedAll.length && ['changed', 'identical'].some(b => sftkScanBucketInfo(s, b).capped)) oneSidedAll.forEach(g => { g.pairsCut = true; });");
    expect(html).not.toContain('none in');
    expect(html).not.toContain('the other org has no record of the name');
    expect(html).toContain('<b>2 copies in SRC</b> have no pair in TGT — a run creates all 2 there.');
    expect(html).toContain('<b>2 copies in TGT</b> have no pair in SRC — a run leaves them as they are.');
  });
  it('a pair filed under a differing link counts as paired too', () => {
    const s = { onlyInTarget: [{ matchKey: 'A', targetId: 't2' }, { matchKey: 'A', targetId: 't3' }], linkMismatch: [{ matchKey: 'A', sourceId: 's1', targetId: 't1' }] };
    expect(dups(s, key)[0].paired).toBe(1);
  });
});

describe('#16 — the button of the root card opens the root object', () => {
  const at = DP.indexOf("document.querySelectorAll('[data-dep-tab-go]')");
  const body = DP.slice(at, DP.indexOf("eid('dsDepBack')", at));
  it('selects the root object and the tab, then draws', () => {
    expect(at).toBeGreaterThan(-1);
    expect(body).toContain("_depObjPath = ''; _depTab = b.dataset.depTabGo; _depFilter = '';");
    expect(body).toContain("renderDeploy().then(() => eid('dsDepRecords')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));");
  });
  it('run with a child object on screen: the click leaves the root object, the asked tab and no filter, and draws once', async () => {
    const btn = { dataset: { depTabGo: 'amb' }, addEventListener(ev, fn) { this.fn = fn; } };
    const doc = { querySelectorAll: sel => (sel === '[data-dep-tab-go]' ? [btn] : []), querySelector: () => { throw new Error('the handler looked for a tab button'); } };
    let draws = 0, scrolled = 0;
    const read = new Function('document', 'eid', 'renderDeploy',
      `let _depObjPath = '0', _depTab = 'ins', _depFilter = 'acme';\n${body}\nreturn () => ({ o: _depObjPath, t: _depTab, f: _depFilter });`)(
      doc, () => ({ scrollIntoView() { scrolled++; } }), () => { draws++; return Promise.resolve(); });
    btn.fn();
    await Promise.resolve(); await Promise.resolve();
    expect(read()).toEqual({ o: '', t: 'amb', f: '' });
    expect(draws).toBe(1);
    expect(scrolled).toBe(1);
  });
  it('no longer looks for a tab button that names an object (none does) or clicks the tab on screen', () => {
    expect(body).not.toContain('[data-dep-obj=""]');
    expect(body).not.toContain('.click()');
    expect(DP).toContain('<button role="tab" data-dep-tab="${t.k}" aria-selected=');   // the tab buttons carry no data-dep-obj
  });
});
