// owner 2026-11-20: "why we dont see this in needs a decision? shouldn't they be merged?" / "do both" — a name that
// only one org holds several times is listed on ⚠ Needs a decision, under the questions, with its merge.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';
const DP = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const { sftkDepOneSidedDups: dups } = extractFunctions('studio-deploy.js', ['sftkDepOneSidedDups']);
const key = r => r.matchKey;

describe('names only one org holds, more than once', () => {
  const scan = {
    missingInTarget: [
      { matchKey: 'PK 1', sourceId: 'a1' }, { matchKey: 'Solo', sourceId: 's1' },
      { matchKey: 'PK 1', sourceId: 'a2', dupKey: true }, { matchKey: 'PK 1', sourceId: 'a3', dupKey: true },
      { matchKey: 'Twice', sourceId: 'f1', forcedNew: true }, { matchKey: 'Twice', sourceId: 'f2' },
    ],
    onlyInTarget: [{ matchKey: 'Old', targetId: 't1' }, { matchKey: 'Old', targetId: 't2', dupKey: true }, { matchKey: 'One', targetId: 't9' }],
  };
  it('are read out of the two lists the scan filed them under, grouped by name, every copy kept', () => {
    expect(dups(scan, key)).toEqual([
      { name: 'PK 1', side: 'src', ids: ['a1', 'a2', 'a3'] },
      { name: 'Old', side: 'tgt', ids: ['t1', 't2'] },
    ]);
  });
  it('a name held once is no group; a record the user asked to insert as new is not a copy', () => {
    const names = dups(scan, key).map(g => g.name);
    expect(names).not.toContain('Solo');
    expect(names).not.toContain('Twice');
    expect(names).not.toContain('One');
  });
  it('no scan is no group', () => { expect(dups(null, key)).toEqual([]); });
});

describe('the tab', () => {
  it('lists them under the questions, on the tab of any object (a child too, 2026-11-22), filtered like the rows', () => {
    expect(DP).toContain("const oneSidedAll = tabDef.k === 'amb' ? sftkDepOneSidedDups(s, key).filter(g => !q || g.name.toLowerCase().includes(q)) : [];");
    expect(DP).toContain('${_depOneSidedHtml(p, oneSided, oneSidedAll.length)}');
  });
  it('says there is nothing to decide, and what a run does with the copies', () => {
    expect(DP).toContain('There is nothing to decide here: the other org has no record of the name.');
    expect(DP).toContain('none in ${there} — a run creates all ${n} there.');
    expect(DP).toContain('none in ${there} — a run leaves them as they are.');
  });
  it('the merge is the tab’s own: its picker, its confirmation, both orgs read again', () => {
    expect(DP).toContain('if (g) _depMergeCopies(p, g.side, g.name, g.ids, isRoot ? {} : { obj: cur.obj });');
  });
  it('an empty question list no longer says "nothing" over a list of copies', () => {
    expect(DP).toContain("(oneSided.length ? '' : `<div class=\"ds-dep-empty\">");
  });
  it('the warning above points at the tab', () => {
    expect(RC).toContain('names only one org holds are listed under them.');
    expect(RC).toContain('🔀 Show them with their merge</button>');
    expect(RC).toContain('data-dep-tab-go="amb" title="Opens the ⚠ Needs a decision tab of the Deploy page"');
  });
});

// owner 2026-11-20, on a CHILD object's card: "also im nor sure about whats written there any more." — its buttons
// were cut out of the sentences ("Or pair them by hand. pairs the 205 …"). A child card now has only the steps that apply.
describe('the warning on a child object', () => {
  it('has the two steps that apply to it, whole sentences, and no root-only button', async () => {
    const { extractFunction } = await import('./extract.mjs');
    const dupsHtml = extractFunction('studio-reconcile.js', 'sftkRecDupsHtml');
    globalThis.esc = s => String(s ?? ''); globalThis.orgLabel = u => String(u); globalThis.sftkMatchKeyLabel = k => String(k);
    const scan = { dupKeys: { rows: 2, keys: ['Mia'], examples: [{ key: 'Mia', src: ['1', '2'], tgt: [] }] }, missingInTarget: [{}, {}], onlyInTarget: [{}] };
    const html = dupsHtml(scan, { id: 'p', sourceOrg: 'S', targetOrg: 'T' }, 'Contact');
    expect(html).toContain('Merge them in Salesforce (the links above open each copy), then 🔄 Refresh state.');
    expect(html).toContain('✏ Change the matching rule</button>');
    expect(html).not.toContain('data-rec-dupfix');
    expect(html).not.toContain('data-dep-tab-go');
    expect((html.match(/<li>/g) || []).length).toBe(2);
  });
});
