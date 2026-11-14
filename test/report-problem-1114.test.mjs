// Report a problem + the store-review line (2026-11-14).
//
// What must hold:
//   1. the issue URL carries ONLY the allowed fields (version, browser, os, language, app,
//      where, theme + template/title) — nothing from the org, whatever is passed in
//   2. the URL params are the issue form's field ids (.github/ISSUE_TEMPLATE/bug_report.yml)
//   3. both pages load sftk-report.js, have the topbar button and a Quick nav row
//   4. What's New renders the review line as a safe http(s) link, and a javascript: link
//      in markdown is never rendered as a link
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunctions } from './extract.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(ROOT, f), 'utf8');

const R = extractFunctions('sftk-report.js', [
  'sftkReportRepo', 'sftkReportWhereList', 'sftkReportAppLabel', 'sftkReportWhereLabel',
  'sftkReportBrowser', 'sftkReportOs', 'sftkReportLanguage', 'sftkReportBuildUrl',
]);
const W = extractFunctions('studio-whatsnew.js', ['sftkWnEsc', 'sftkInlineMdToHtml', 'sftkWnReviewHtml']);

const ALLOWED = ['template', 'title', 'version', 'browser', 'os', 'language', 'app', 'where', 'theme'];
const SECRETS = [
  'https://acme-corp.my.salesforce.com', 'acme-corp', '00D5g000000AbCdEAL', '0015g00000XyZ12AAA',
  'jane.doe@acme.com', 'Account.Secret_Field__c', '00D5g!AQ0AQ.sessionid', 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
];

function paramsOf(url) {
  const u = new URL(url);
  return { u, keys: [...u.searchParams.keys()], p: u.searchParams };
}

describe('sftkReportBuildUrl — allowed fields only', () => {
  const base = { app: 'toolkit', where: 'fields', version: '1.1.0', browser: 'Chrome 131', os: 'Windows', language: 'en-US', theme: 'dark' };

  it('builds the issue-form URL with the allowed params and the title prefix', () => {
    const { u, keys, p } = paramsOf(R.sftkReportBuildUrl(base));
    expect(u.origin + u.pathname).toBe('https://github.com/YonatanAshkenazi53/salesforce-toolkit/issues/new');
    expect(keys.every(k => ALLOWED.includes(k))).toBe(true);
    expect(p.get('template')).toBe('bug_report.yml');
    expect(p.get('title')).toBe('[1.1.0] Field Cleaner: ');
    expect(p.get('app')).toBe('Toolkit');
    expect(p.get('where')).toBe('Field Cleaner');
    expect(p.get('browser')).toBe('Chrome 131');
    expect(p.get('theme')).toBe('dark');
  });

  it('Data Deployment views map to our own labels', () => {
    const { p } = paramsOf(R.sftkReportBuildUrl({ ...base, app: 'studio', where: 'deploy' }));
    expect(p.get('app')).toBe('Data Studio (Data Deployment)');
    expect(p.get('where')).toBe('Data Deployment');
    expect(p.get('title')).toBe('[1.1.0] Data Deployment: ');
  });

  it('nothing from the org gets through, whichever field it is placed in', () => {
    for (const s of SECRETS) {
      const url = R.sftkReportBuildUrl({
        app: s, where: s, version: s, browser: s, os: s, language: s, theme: s, title: s, body: s, org: s,
      });
      const decoded = decodeURIComponent(url);
      expect(decoded).not.toContain(s);
      const { keys, p } = paramsOf(url);
      expect(keys.every(k => ALLOWED.includes(k))).toBe(true);
      expect(p.get('where')).toBe('Other');
      expect(p.get('version')).toBe('unknown');
      expect(p.get('title')).toBe('[unknown] Other: ');
    }
  });

  it('every value is encodeURIComponent-ed and the URL stays far under 8,000 characters', () => {
    const url = R.sftkReportBuildUrl({ ...base, where: 'whatsnew' });
    expect(url).toContain(`where=${encodeURIComponent("What's New")}`);
    expect(url).toContain('where=What');
    expect(url).not.toMatch(/ /);
    const long = R.sftkReportBuildUrl({ ...base, where: 'x'.repeat(50000), language: 'y'.repeat(50000) });
    expect(long.length).toBeLessThan(1000);
  });

  it('browser, OS and language helpers keep only the family and major version', () => {
    expect(R.sftkReportBrowser([{ brand: 'Chromium', version: '131' }, { brand: 'Microsoft Edge', version: '131' }], '')).toBe('Edge 131');
    expect(R.sftkReportBrowser([{ brand: 'Google Chrome', version: '130' }], '')).toBe('Chrome 130');
    expect(R.sftkReportBrowser(null, 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/129.0.6668.1 Safari/537.36 Edg/129.0.1')).toBe('Edge 129');
    expect(R.sftkReportBrowser(null, 'Mozilla/5.0 (X11; Linux x86_64) Chrome/128.0.1.2 Safari/537.36')).toBe('Chrome 128');
    expect(R.sftkReportBrowser(null, 'Firefox/130')).toBe('Other');
    expect(R.sftkReportOs('Windows', '')).toBe('Windows');
    expect(R.sftkReportOs('', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macOS');
    expect(R.sftkReportOs('', 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)')).toBe('ChromeOS');
    expect(R.sftkReportLanguage('he-IL')).toBe('he-IL');
    expect(R.sftkReportLanguage('jane.doe@acme.com')).toBe('');
  });
});

describe('the issue form matches the URL', () => {
  const yml = read('.github/ISSUE_TEMPLATE/bug_report.yml');
  const ids = [...yml.matchAll(/^\s+id:\s*([A-Za-z0-9_-]+)\s*$/gm)].map(m => m[1]);

  it('has the fields, with what-happened required and the bug label', () => {
    for (const id of ['version', 'browser', 'os', 'language', 'app', 'where', 'theme', 'what-happened', 'expected', 'steps']) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(yml).toMatch(/labels:\s*\["bug"\]/);
    expect(yml).toMatch(/id: what-happened[\s\S]*?required: true/);
    expect(yml).toMatch(/type: markdown[\s\S]*do not paste client data/i);
    // the top block says a GitHub account is needed, and names the store's support tab as the other way
    expect(yml).toMatch(/type: markdown[\s\S]*free GitHub account[\s\S]*Support tab[\s\S]*- type: input/);
    // the placeholder names the exact texts sftkReportAppLabel prefills
    expect(R.sftkReportAppLabel('studio')).toBe('Data Studio (Data Deployment)');
    expect(yml).toContain(R.sftkReportAppLabel('toolkit') + ' / ' + R.sftkReportAppLabel('studio'));
  });

  it('every prefilled field is a text input — GitHub prefills inputs from the URL; a dropdown is not proven to take', () => {
    for (const id of ['version', 'browser', 'os', 'language', 'app', 'where', 'theme']) {
      const m = yml.match(new RegExp('- type: (\\w+)\\s*\\n\\s+id: ' + id + '\\s*\\n'));
      expect(m, id).toBeTruthy();
      expect(m[1], id).toBe('input');
    }
  });

  it('the feature form names the apps exactly as the bug form and the URL do', () => {
    const fr = read('.github/ISSUE_TEMPLATE/feature_request.yml');
    expect(fr).toContain('- ' + R.sftkReportAppLabel('toolkit'));
    expect(fr).toContain('- ' + R.sftkReportAppLabel('studio'));
    expect(fr).not.toMatch(/^\s+- Data Deployment\s*$/m);
  });

  it('every prefilled param is a field id of the form', () => {
    const { keys } = paramsOf(R.sftkReportBuildUrl({ app: 'studio', where: 'orgs', version: '1.1.0', browser: 'Chrome 131', os: 'Linux', language: 'en', theme: 'light' }));
    for (const k of keys) {
      if (k === 'template' || k === 'title') continue;
      expect(ids).toContain(k);
    }
  });

  it('a feature-request form and config exist', () => {
    expect(read('.github/ISSUE_TEMPLATE/feature_request.yml')).toMatch(/type: textarea/);
    expect(read('.github/ISSUE_TEMPLATE/config.yml')).toMatch(/blank_issues_enabled:/);
  });
});

describe('both apps carry the control', () => {
  for (const page of ['popup.html', 'studio.html']) {
    it(`${page} loads sftk-report.js before the scripts that use it and has the button`, () => {
      const h = read(page);
      const at = h.indexOf('<script src="sftk-report.js"></script>');
      expect(at).toBeGreaterThan(0);
      const user = page === 'popup.html' ? '<script src="popup.js"></script>' : '<script src="studio-core.js"></script>';
      expect(at).toBeLessThan(h.indexOf(user));
      // one short tooltip in both apps (design review 2026-11-14); the GitHub-account note lives in the aria-label and the form
      expect(h).toMatch(/<button id="sftkReportBtn"[^>]*title="Report a problem — prefilled GitHub issue \(nothing from your org\)"[^>]*><span[^>]*data-i="flag"/);
      // icon-only in both apps, pro mode included — no text label inside the button
      expect(h).toMatch(/<button id="sftkReportBtn"[^>]*><span[^>]*data-i="flag" aria-hidden="true"><\/span><\/button>/);
      // the accessible name is the fuller one: the action, the GitHub account, nothing from the org
      expect(h).toMatch(/<button id="sftkReportBtn"[^>]*aria-label="Report a problem — opens a prefilled GitHub issue; sending it needs a GitHub account; nothing from your org is included"/);
      // next to What's New
      expect(h.indexOf('id="sftkReportBtn"')).toBeGreaterThan(h.indexOf('id="dsWhatsNewTop"'));
    });
  }

  it('the flag glyph is in the shared mask table', () => {
    expect(read('styles.css')).toMatch(/^\[data-i="flag"\]\s*\{ --adbg-icon: url\("data:image\/svg\+xml,/m);
  });

  it('each Quick nav has a Report a problem row — one desc, search keywords, its own Help group in Data Studio', () => {
    const core = read('studio-core.js');
    const DESC = 'Report a bug — prefilled GitHub issue (GitHub account needed), nothing from your org';
    const KEYS = 'bug feedback issue support help github';
    expect(core).toContain(`{ i: 'flag',      label: 'Report a problem', view: '__report',  desc: '${DESC}', group: 'Help', keys: '${KEYS}' }`);
    expect(core).toMatch(/view === '__report'\) \{ if \(typeof sftkReportOpen === 'function'\) sftkReportOpen\(/);
    // the palette filter reads keys, and a grouped row opens its own header
    expect(core).toContain("|| (v.keys || '').includes(q)");
    expect(core).toContain("const want = v.group || 'Navigate';");
    // the grouped row is the last of CMD_VIEWS, so the Help header renders once, after the views
    const views = core.slice(core.indexOf('const CMD_VIEWS'), core.indexOf('const CMD_TOOLKIT'));
    const rows = views.split('\n').filter(l => /^\s*\{ i: '/.test(l));
    expect(rows[rows.length - 1]).toContain("view: '__report'");
    expect(rows.filter(l => l.includes('group:')).length).toBe(1);
    const pop = read('popup.js');
    expect(pop).toContain(`{ i: 'flag', label: 'Report a problem', desc: '${DESC}', keys: '${KEYS}', run: () => { if (typeof sftkReportOpen === 'function') sftkReportOpen(`);
    expect(pop).toContain("|| (i.keys || '').includes(ql)");
    for (const word of ['bug', 'feedback', 'support', 'issue', 'help']) expect(KEYS).toContain(word);
  });

  it('Data Studio keeps the report button icon-only in pro mode, and the flag pennant is filled', () => {
    const css = read('studio.css');
    expect(css).not.toMatch(/\.ds-pro \.ds-topbar \.sftk-report-btn \{ width: auto/);
    expect(css).toContain('.ds-pro .ds-topbar .sftk-report-btn .ds-glyph { display: inline-block; }');
    // the brand never wraps onto two lines when the topbar is tight
    expect(css).toMatch(/\.ds-brand \{[^}]*white-space: nowrap;/);
    expect(read('styles.css')).toMatch(/\[data-i="flag"\][^\n]*<path fill='black' d='M3\.6 2\.8h8\.6/);
  });

  it('opens with chrome.tabs.create, falls back to window.open with noopener, and needs no new permission', () => {
    const src = read('sftk-report.js');
    expect(src).toContain('chrome.tabs.create({ url })');
    expect(src).toContain("window.open(url, '_blank', 'noopener')");
    const perms = JSON.parse(read('manifest.json')).permissions || [];
    expect(perms).not.toContain('tabs');
  });

  it('the packer ships it (a root .js not on any exclude list)', () => {
    const pack = read('scripts/pack_store.py');
    expect(pack).not.toContain('sftk-report.js');
  });
});

describe('What\'s New — links and the review line', () => {
  it('renders an http(s) markdown link as a safe link', () => {
    const html = W.sftkInlineMdToHtml('See [the docs](https://example.com/a?b=1&c=2) now');
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('>the docs</a>');
  });

  it('a javascript: (or data:) link is NOT rendered as a link', () => {
    for (const bad of ['[click](javascript:alert(1))', '[x](JavaScript:alert(1))', '[x](data:text/html,<script>1</script>)', '[x](//evil.example)']) {
      const html = W.sftkInlineMdToHtml(bad);
      expect(html).not.toContain('<a ');
      expect(html).not.toContain('<script');
    }
  });

  it('a link text or url cannot break out of the attribute', () => {
    const html = W.sftkInlineMdToHtml('[<b>x</b>](https://example.com/"onmouseover="alert(1))');
    expect(html).not.toMatch(/<b>|onmouseover="/);
  });

  it('the review line shows for 1.1 only, links to the store listing, and can be dismissed', () => {
    const html = W.sftkWnReviewHtml('1.1.0', false);
    expect(html).toContain('Finding the Toolkit useful?');
    expect(html).toMatch(/<a href="https:\/\/chromewebstore\.google\.com\/detail\/admin-toolkit-for-salesforce\/hnlnanhfagbkhlgpmbndindielldfghk\/reviews" target="_blank" rel="noopener noreferrer"/);
    expect(html).toContain('data-wn-review-dismiss');
    expect(W.sftkWnReviewHtml('1.1.0', true)).toBe('');
    expect(W.sftkWnReviewHtml('1.2.0', false)).toBe('');
    expect(W.sftkWnReviewHtml('1.0.0', false)).toBe('');
    expect(W.sftkWnReviewHtml('', false)).toBe('');
  });

  it('the review line renders after the newest release card, not above the news', () => {
    const src = read('studio-whatsnew.js');
    expect(src).toContain("el.querySelector(':scope > section')");
    expect(src).toContain("first.insertAdjacentHTML('afterend', review)");
    expect(src).not.toContain('review + sftkWhatsNewBodyHtml(');
  });

  it('the dismiss key is named in PRIVACY.md', () => {
    expect(read('studio-whatsnew.js')).toContain("'ds_review_line_dismissed'");
    expect(read('PRIVACY.md')).toContain('ds_review_line_dismissed');
  });
});

describe('CHANGELOG and listing', () => {
  it('the 1.1 section has the Report a problem entry, without quotes or Hebrew', () => {
    const ch = read('CHANGELOG.md');
    const sec = ch.slice(ch.indexOf('## 1.1.0'), ch.indexOf('\n## ', ch.indexOf('## 1.1.0') + 5));
    const line = sec.split('\n').find(l => l.startsWith('- **Report a problem**'));
    expect(line).toBeTruthy();
    expect(line).not.toMatch(/[֐-׿]|“|"|owner/);
  });

  it('the up-front automation entry does not promise a duplicate rule is switched off', () => {
    const ch = read('CHANGELOG.md');
    const line = ch.split('\n').find(l => l.startsWith('- **Every automation on every object of the deployment, up front**'));
    expect(line).toBeTruthy();
    expect(line).not.toContain('a tick to switch it off for the run');
    expect(line).toContain('duplicate rules are never switched off');
    expect(line).toContain('bypass header');
    expect(line).not.toMatch(/[֐-׿]/);
  });

  it('the store listing has a 1.1 draft above the 1.0 text', () => {
    const doc = read('docs/store-listing.md');
    expect(doc.indexOf('# 1.1.0 — DRAFT')).toBeGreaterThan(-1);
    expect(doc.indexOf('# 1.0.0 listing')).toBeGreaterThan(doc.indexOf('# 1.1.0 — DRAFT'));
  });

  // the NEW IN 1.1 block of the draft, up to the next section header
  const newIn11 = () => {
    const doc = read('docs/store-listing.md');
    const start = doc.indexOf('NEW IN 1.1');
    expect(start).toBeGreaterThan(-1);
    return doc.slice(start, doc.indexOf('THE TOOLKIT', start));
  };

  it('NEW IN 1.1 does not list Activity — it shipped in 1.0.0', () => {
    const ch = read('CHANGELOG.md');
    expect(ch.slice(ch.indexOf('## 1.0.0'))).toMatch(/Activity/);
    expect(newIn11()).not.toMatch(/^• Activity/m);
    expect(newIn11()).not.toMatch(/CSV\/JSON export on each line/);
  });

  it('the pause-panel line never says a duplicate rule is switched off — the bypass header passes it', () => {
    const block = newIn11();
    const pause = block.slice(block.indexOf('• The pause panel'), block.indexOf('\n•', block.indexOf('• The pause panel') + 2));
    expect(pause).toMatch(/bypass header/);
    expect(pause).toMatch(/never switched off/);
    expect(pause).not.toMatch(/each with a tick\s+to switch it off/);
  });

  it('the dry-run line states its limits: inserts only, first 200 per object', () => {
    const block = newIn11();
    const dry = block.slice(block.indexOf('• Dry run'), block.indexOf('\n•', block.indexOf('• Dry run') + 2));
    expect(dry).toMatch(/selected inserts/);
    expect(dry).toMatch(/first 200 of each object/);
    expect(dry).not.toMatch(/selected records are written/);
    expect(dry).not.toMatch(/real records/);
  });
});
