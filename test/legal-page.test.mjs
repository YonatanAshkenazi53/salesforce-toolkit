// legal.html — the shipped EULA / PRIVACY / LICENSE rendered as a page
// (user 2026-09-14: the raw .md opened as a source dump with broken punctuation).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const { sftkLegalParse, sftkLegalInline } = extractFunctions('legal.js', ['sftkLegalParse', 'sftkLegalInline']);

describe('the block parser', () => {
  it('reads headings, paragraphs (hard-wrapped), lists, quotes and tables', () => {
    const md = '# Title\n\nFirst line\ncontinues here.\n\n- one\n- two\n  wrapped\n\n1. a\n2. b\n\n> quoted\n> more\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n';
    const b = sftkLegalParse(md);
    expect(b.map(x => x.type)).toEqual(['h', 'p', 'list', 'list', 'quote', 'table']);
    expect(b[1].text).toBe('First line continues here.');
    expect(b[2].items).toEqual(['one', 'two wrapped']);
    expect(b[3].ordered).toBe(true);
    expect(b[4].text).toBe('quoted more');
    expect(b[5].rows).toEqual([['A', 'B'], ['1', '2']]);
  });

  it('never produces HTML — a tag in the source is just text', () => {
    const b = sftkLegalParse('<script>alert(1)</script> and <b>x</b>');
    expect(b).toEqual([{ type: 'p', text: '<script>alert(1)</script> and <b>x</b>' }]);
    expect(sftkLegalInline('<img src=x onerror=1>')).toEqual([{ t: 'text', s: '<img src=x onerror=1>' }]);
  });

  it('parses the three shipped documents into real structure', () => {
    for (const f of ['EULA.md', 'PRIVACY.md', 'LICENSE']) {
      const b = sftkLegalParse(read(f));
      expect(b.length, f).toBeGreaterThan(5);
    }
    // the two markdown documents have real headings; LICENSE is plain text
    for (const f of ['EULA.md', 'PRIVACY.md']) expect(sftkLegalParse(read(f)).some(x => x.type === 'h'), f).toBe(true);
    expect(sftkLegalParse(read('EULA.md'))[0]).toMatchObject({ type: 'h', level: 1 });
  });
});

describe('inline markup', () => {
  it('bold, em, code and http links; other link targets stay visible text', () => {
    expect(sftkLegalInline('a **b** *c* `d` [e](https://x.y) [f](mailto:x@y.z)')).toEqual([
      { t: 'text', s: 'a ' }, { t: 'b', s: 'b' }, { t: 'text', s: ' ' }, { t: 'i', s: 'c' }, { t: 'text', s: ' ' },
      { t: 'code', s: 'd' }, { t: 'text', s: ' ' }, { t: 'a', s: 'e', href: 'https://x.y' }, { t: 'text', s: ' ' },
      { t: 'text', s: 'f (mailto:x@y.z)' },
    ]);
    // a javascript: target never becomes a link either
    expect(sftkLegalInline('[f](javascript:alert(1))').some(x => x.t === 'a')).toBe(false);
  });
});

describe('the page itself', () => {
  const js = read('legal.js');
  it('builds the DOM node by node — no innerHTML (Trusted Types)', () => {
    const code = js.replace(/^[ 	]*\/\/.*$/gm, '');   // comments explain the rule; the code must obey it
    expect(code).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    expect(js).toContain('document.createTextNode');
  });
  it('links open safely and the doc is chosen by ?doc=', () => {
    expect(js).toContain("n.rel = 'noopener noreferrer'");
    expect(js).toContain("const SFTK_LEGAL_DOCS = { eula: 'EULA.md', privacy: 'PRIVACY.md', license: 'LICENSE' };");
  });
});
