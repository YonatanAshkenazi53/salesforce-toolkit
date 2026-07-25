// T10 "What's New" — the pure half of studio-whatsnew.js.
//
// Two things must hold forever:
//   1. the markdown subset CHANGELOG.md uses parses into the right structure
//   2. NOTHING from that file reaches innerHTML unescaped (CSP/Trusted Types
//      make raw-markdown innerHTML illegal, so the renderer rebuilds HTML by
//      hand — these tests are what keep the escaping honest)
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction, extractFunctions } from './extract.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const {
  sftkWnEsc,
  sftkInlineMdToHtml,
  sftkWnSectionTone,
  sftkWnNewCount,
  sftkWhatsNewBodyHtml,
} = extractFunctions('studio-whatsnew.js', [
  'sftkWnEsc', 'sftkInlineMdToHtml', 'sftkWnSectionTone',
  'sftkWnNewCount', 'sftkWhatsNewBodyHtml',
]);
const sftkParseChangelog    = extractFunction('studio-whatsnew.js', 'sftkParseChangelog');
const sftkWhatsNewIsUnseen  = extractFunction('studio-whatsnew.js', 'sftkWhatsNewIsUnseen');

const SAMPLE = [
  '# What\'s New — Salesforce Toolkit',
  '',
  'Preamble prose that must never become a changelog entry.',
  '',
  '## 1.0.0 — 2026-07-25',
  '',
  '### Added',
  '- **Bulk API** for large writes.',
  '- Flow backups are `zip` artifacts',
  '  that you can deploy back into an org.',
  '',
  '### Known issues',
  '- Store builds skip `CHANGELOG.md`.',
  '',
  '## 0.9.0 — 2026-07-22',
  '',
  '### Fixed',
  '* Modals actually scroll.',
  '',
].join('\n');

describe('sftkParseChangelog — the changelog markdown subset', () => {
  const parsed = sftkParseChangelog(SAMPLE);

  it('splits on ## into versions, newest first, with version + date', () => {
    expect(parsed.map(v => v.version)).toEqual(['1.0.0', '0.9.0']);
    expect(parsed[0].date).toBe('2026-07-25');
    expect(parsed[1].date).toBe('2026-07-22');
  });

  it('ignores the H1 title and any preamble prose before the first version', () => {
    const allItems = parsed.flatMap(v => v.sections.flatMap(s => s.items)).join(' ');
    expect(allItems).not.toContain('Preamble prose');
    expect(parsed.some(v => v.version.includes("What's New"))).toBe(false);
  });

  it('groups bullets under their ### section', () => {
    expect(parsed[0].sections.map(s => s.title)).toEqual(['Added', 'Known issues']);
    expect(parsed[0].sections[0].items).toHaveLength(2);
    expect(parsed[0].sections[1].items).toEqual(['Store builds skip `CHANGELOG.md`.']);
  });

  it('folds an indented continuation line into the bullet above it', () => {
    expect(parsed[0].sections[0].items[1])
      .toBe('Flow backups are `zip` artifacts that you can deploy back into an org.');
  });

  it('accepts * bullets as well as -', () => {
    expect(parsed[1].sections[0].items).toEqual(['Modals actually scroll.']);
  });

  it('does NOT mistake ### for a version heading', () => {
    expect(sftkParseChangelog('### Added\n- x')).toEqual([]);
  });

  it('accepts keep-a-changelog bracket + hyphen headings', () => {
    const v = sftkParseChangelog('## [2.1.0] - 2026-08-01\n- thing');
    expect(v[0].version).toBe('2.1.0');
    expect(v[0].date).toBe('2026-08-01');
  });

  it('keeps a hyphenated prerelease version out of the date', () => {
    const v = sftkParseChangelog('## 1.1.0-beta.2 — 2026-08-09\n- thing');
    expect(v[0].version).toBe('1.1.0-beta.2');
    expect(v[0].date).toBe('2026-08-09');
  });

  it('handles a version heading with no date', () => {
    const v = sftkParseChangelog('## Unreleased\n### Added\n- soon');
    expect(v[0].version).toBe('Unreleased');
    expect(v[0].date).toBe('');
  });

  it('puts bullets that precede any ### into an untitled section', () => {
    const v = sftkParseChangelog('## 1.0.0 — 2026-01-01\n- loose bullet');
    expect(v[0].sections).toEqual([{ title: '', items: ['loose bullet'] }]);
  });

  it('survives empty / null input without throwing', () => {
    expect(sftkParseChangelog('')).toEqual([]);
    expect(sftkParseChangelog(null)).toEqual([]);
    expect(sftkParseChangelog(undefined)).toEqual([]);
  });
});

describe('the REAL CHANGELOG.md parses (a broken file would ship a blank page)', () => {
  const real = sftkParseChangelog(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'));

  it('has versions, each with a date and at least one populated section', () => {
    expect(real.length).toBeGreaterThan(0);
    for (const v of real) {
      expect(v.version, `version heading of ${JSON.stringify(v)}`).toMatch(/^\d+\.\d+\.\d+/);
      expect(v.date, `date of ${v.version}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(v.sections.length, `sections of ${v.version}`).toBeGreaterThan(0);
      for (const s of v.sections) expect(s.items.length, `${v.version} / ${s.title}`).toBeGreaterThan(0);
    }
  });

  it('newest section first, and it declares its known issues', () => {
    expect(real[0].version).toBe('1.0.0');
    expect(real[0].sections.map(s => s.title)).toContain('Known issues');
  });

  it('leaves no stray markdown bullet marker at the start of an item', () => {
    for (const v of real) for (const s of v.sections) for (const it of s.items) {
      expect(it, `${v.version} / ${s.title}`).not.toMatch(/^[-*]\s/);
    }
  });
});

describe('sftkWnEsc / sftkInlineMdToHtml — escaping is not optional', () => {
  it('escapes the four dangerous characters', () => {
    expect(sftkWnEsc('<a href="x">&</a>'))
      .toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    expect(sftkWnEsc(null)).toBe('');
    expect(sftkWnEsc(undefined)).toBe('');
  });

  it('renders **bold** and `code` as tags', () => {
    const html = sftkInlineMdToHtml('a **bold** and `code` here');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('>code</code>');
    expect(html).toContain('a ');
  });

  it('escapes markup INSIDE a bold run', () => {
    expect(sftkInlineMdToHtml('**<img src=x onerror=alert(1)>**'))
      .toBe('<strong>&lt;img src=x onerror=alert(1)&gt;</strong>');
  });

  it('escapes markup INSIDE a code span', () => {
    const html = sftkInlineMdToHtml('run `<script>alert(1)</script>` now');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes plain text around the markup', () => {
    const html = sftkInlineMdToHtml('<b>x</b> **y**');
    expect(html.startsWith('&lt;b&gt;x&lt;/b&gt; ')).toBe(true);
  });

  it('leaves an unterminated marker as literal text', () => {
    expect(sftkInlineMdToHtml('a ** dangling')).toBe('a ** dangling');
    expect(sftkInlineMdToHtml('a ` dangling')).toBe('a ` dangling');
  });

  it('handles empty input', () => {
    expect(sftkInlineMdToHtml('')).toBe('');
    expect(sftkInlineMdToHtml(null)).toBe('');
  });
});

describe('sftkWnSectionTone — every heading gets a treatment, none are dropped', () => {
  it('knows the standard keep-a-changelog headings', () => {
    expect(sftkWnSectionTone('Added').icon).toBe('✨');
    expect(sftkWnSectionTone('Fixed').icon).toBe('🔧');
    expect(sftkWnSectionTone('Changed').icon).toBe('🔁');
    expect(sftkWnSectionTone('Known issues').icon).toBe('⚠️');
    expect(sftkWnSectionTone('Removed').icon).toBe('🗑');
  });

  it('falls back to a neutral tone instead of returning nothing', () => {
    const t = sftkWnSectionTone('Something nobody planned for');
    expect(t.icon).toBeTruthy();
    expect(t.color).toBeTruthy();
  });
});

describe('sftkWnNewCount / sftkWhatsNewIsUnseen — the nav badge rule', () => {
  const versions = [{ version: '1.2.0' }, { version: '1.1.0' }, { version: '1.0.0' }];

  it('counts every version above the last-seen one', () => {
    expect(sftkWnNewCount(versions, '1.0.0')).toBe(2);
    expect(sftkWnNewCount(versions, '1.1.0')).toBe(1);
  });

  it('is 0 when the newest version is the one already seen', () => {
    expect(sftkWnNewCount(versions, '1.2.0')).toBe(0);
  });

  it('shows only the newest as new to a first-time user (no "12 new versions" wall)', () => {
    expect(sftkWnNewCount(versions, '')).toBe(1);
    expect(sftkWnNewCount(versions, null)).toBe(1);
    expect(sftkWnNewCount(versions, 'v-from-a-future-build')).toBe(1);
  });

  it('copes with no versions at all', () => {
    expect(sftkWnNewCount([], '1.0.0')).toBe(0);
    expect(sftkWnNewCount(null, '1.0.0')).toBe(0);
  });

  it('badges only when the newest differs from last-seen', () => {
    expect(sftkWhatsNewIsUnseen('1.2.0', '1.1.0')).toBe(true);
    expect(sftkWhatsNewIsUnseen('1.2.0', '1.2.0')).toBe(false);
    expect(sftkWhatsNewIsUnseen('1.2.0', '')).toBe(true);
    expect(sftkWhatsNewIsUnseen('', 'anything')).toBe(false);   // nothing parsed = nothing to badge
  });
});

describe('sftkWhatsNewBodyHtml — the rendered page', () => {
  const parsed = sftkParseChangelog(SAMPLE);

  it('renders every version, its date and its section headings', () => {
    const html = sftkWhatsNewBodyHtml(parsed, { seen: '0.9.0' });
    expect(html).toContain('1.0.0');
    expect(html).toContain('2026-07-25');
    expect(html).toContain('Added');
    expect(html).toContain('Known issues');
    expect(html).toContain('0.9.0');
  });

  it('marks unseen versions and only those', () => {
    const html = sftkWhatsNewBodyHtml(parsed, { seen: '0.9.0' });
    expect(html.match(/New for you/g)).toHaveLength(1);
    expect(sftkWhatsNewBodyHtml(parsed, { seen: '1.0.0' })).not.toContain('New for you');
  });

  it('never emits an attacker-controlled tag or inline handler', () => {
    const evil = sftkParseChangelog([
      '## <img src=x onerror=alert(1)> — "><script>alert(2)</script>',
      '### <svg onload=alert(3)>',
      '- <iframe src=javascript:alert(4)></iframe> and **<b>bold</b>**',
    ].join('\n'));
    const html = sftkWhatsNewBodyHtml(evil, { seen: '' });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('<iframe');
    // No inline handler INSIDE a tag. (`onload=` may survive as inert escaped
    // text between tags — `[^>]*` cannot cross the preceding `>`, so this only
    // fires on a real attribute.)
    expect(html).not.toMatch(/<[^>]*\son\w+\s*=/i);
    expect(html).toContain('&lt;iframe');
    // Belt and braces: the ONLY tags this renderer may ever emit.
    const tags = [...html.matchAll(/<\/?([a-z0-9]+)/gi)].map(m => m[1].toLowerCase());
    expect([...new Set(tags)].sort())
      .toEqual(['div', 'li', 'section', 'span', 'strong', 'ul']);
  });

  it('says so out loud when the file parsed to nothing, instead of rendering blank', () => {
    const html = sftkWhatsNewBodyHtml([], {});
    expect(html).toContain('nothing to show');
    expect(html.length).toBeGreaterThan(80);
  });

  it('renders the optional caveat note escaped', () => {
    const html = sftkWhatsNewBodyHtml(parsed, { seen: '', note: 'only <2> versions parsed' });
    expect(html).toContain('only &lt;2&gt; versions parsed');
  });

  it('tolerates malformed version objects rather than throwing', () => {
    expect(() => sftkWhatsNewBodyHtml([{}, { sections: null }, null], {})).not.toThrow();
    expect(sftkWhatsNewBodyHtml([{}], {})).toContain('Unversioned');
  });
});
