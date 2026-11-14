'use strict';
// ════════════════════════════════════════════════════════════════
// REPORT A PROBLEM — opens a prefilled GitHub issue form (2026-11-14)
// ════════════════════════════════════════════════════════════════
// Loaded by BOTH popup.html and studio.html. The topbar button (#sftkReportBtn)
// and the "Report a problem" row of each Quick nav call sftkReportOpen().
//
// PRIVACY CONTRACT — the URL carries ONLY:
//   version (manifest), browser + major version, OS family, UI language,
//   the app (Toolkit / Data Studio (Data Deployment)), the tool or view the user was in
//   (a label from OUR OWN list below — anything else becomes "Other"), theme.
// Nothing from the org: no org URL / My Domain, org id, user, record ids,
// object or field names, error text, session ids. Every value passes a
// whitelist or a strict pattern; a value that does not fit is dropped, never
// passed through. test/report-problem-1114.test.mjs holds this.
//
// The form itself is .github/ISSUE_TEMPLATE/bug_report.yml — the URL params
// are named after its field ids (GitHub prefills a form field from the query
// parameter named after its id).
//
// No network call is made here: the page only opens a github.com tab, and the
// user reads the form and decides whether to submit it. No new permission —
// chrome.tabs.create needs none to open a URL.
//
// The pure functions below are top-level functions with no free variables
// (test/extract.mjs materializes them in Node).

// The repository the issue goes to.
function sftkReportRepo() {
  return 'https://github.com/YonatanAshkenazi53/salesforce-toolkit';
}

// The ONLY labels 'where' may carry, per app. Keys are the view / tab ids the
// pages use; values are what lands in the issue.
function sftkReportWhereList() {
  return {
    toolkit: {
      home: 'Home', flows: 'Flows', dependencies: 'Flows', debugger: 'Debugger',
      pages: 'Lightning Pages', fields: 'Field Cleaner', 'copy-perms': 'Copy Permissions',
      licenses: 'Licenses', 'flow-access': 'Flow Access', whatsnew: "What's New",
      activity: 'Activity',
    },
    studio: {
      orgs: 'Connected Orgs', profiles: 'Data Deployment', deploy: 'Data Deployment',
      reconcile: 'Data Deployment', transfer: 'Data Deployment', ring: 'All open orgs',
      compare: 'Org Compare', orghealth: 'Org health', history: 'History',
      rollback: 'Roll back', whatsnew: "What's New", picklists: 'Picklist Manager',
      readiness: 'Deploy Readiness', schema: 'Schema View', fields: 'Field Audit',
      seed: 'Org Seeder', sequences: 'Sequences', activity: 'Activity',
    },
  };
}

// 'toolkit' | 'studio' → the dropdown option text in bug_report.yml.
function sftkReportAppLabel(app) {
  return app === 'studio' ? 'Data Studio (Data Deployment)' : 'Toolkit';
}

// A view / tab id (or one of our own labels) → a label from the list, else 'Other'.
function sftkReportWhereLabel(app, where) {
  const list = sftkReportWhereList()[app === 'studio' ? 'studio' : 'toolkit'];
  const key = String(where === null || where === undefined ? '' : where).trim();
  if (Object.prototype.hasOwnProperty.call(list, key)) return list[key];
  for (const k of Object.keys(list)) if (list[k] === key) return key;
  return 'Other';
}

// Browser name + major version from navigator.userAgentData brands (preferred)
// or the user-agent string. Only Chrome / Edge / Opera / Brave / Chromium /
// Other with a number — nothing else of the UA string is kept.
function sftkReportBrowser(brands, ua) {
  const list = Array.isArray(brands) ? brands : [];
  const find = re => list.find(b => b && re.test(String(b.brand || '')));
  const major = v => { const m = /^(\d{1,4})/.exec(String(v || '')); return m ? m[1] : ''; };
  const named = [[/Microsoft Edge/i, 'Edge'], [/Opera/i, 'Opera'], [/Brave/i, 'Brave'], [/Google Chrome/i, 'Chrome']];
  for (const [re, name] of named) {
    const b = find(re);
    if (b) return (name + ' ' + major(b.version)).trim();
  }
  const s = String(ua || '');
  let m = /\bEdg(?:e|A|iOS)?\/(\d{1,4})/.exec(s);
  if (m) return 'Edge ' + m[1];
  m = /\bOPR\/(\d{1,4})/.exec(s);
  if (m) return 'Opera ' + m[1];
  const cr = find(/Chromium/i);
  m = /\bChrome\/(\d{1,4})/.exec(s);
  if (m) return 'Chrome ' + m[1];
  if (cr) return ('Chromium ' + major(cr.version)).trim();
  return 'Other';
}

// OS family only — never a version or device name.
function sftkReportOs(platform, ua) {
  const s = String(platform || '') + ' ' + String(ua || '');
  if (/CrOS|Chrome OS/i.test(s)) return 'ChromeOS';
  if (/Android/i.test(s)) return 'Android';
  if (/Win/i.test(s)) return 'Windows';
  if (/Mac|iPhone|iPad/i.test(s)) return 'macOS';
  if (/Linux|X11/i.test(s)) return 'Linux';
  return 'Other';
}

// A BCP-47 tag such as en-US, he-IL — or nothing.
function sftkReportLanguage(lang) {
  const s = String(lang || '').trim();
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(s) ? s : '';
}

// The query string for the issue form: the allowed fields only, each
// whitelisted / pattern-checked and encodeURIComponent'ed.
// f = { app, where, version, browser, os, language, theme }
function sftkReportBuildUrl(f) {
  const o = f || {};
  const app = o.app === 'studio' ? 'studio' : 'toolkit';
  const version = /^\d{1,4}(?:\.\d{1,4}){0,3}$/.test(String(o.version || '')) ? String(o.version) : 'unknown';
  const browser = /^(?:Chrome|Edge|Opera|Brave|Chromium)(?: \d{1,4})?$|^Other$/.test(String(o.browser || '')) ? String(o.browser) : 'Other';
  const os = ['Windows', 'macOS', 'Linux', 'ChromeOS', 'Android', 'Other'].indexOf(o.os) >= 0 ? o.os : 'Other';
  const language = sftkReportLanguage(o.language);
  const theme = ['light', 'dark', 'oled'].indexOf(o.theme) >= 0 ? o.theme : '';
  const where = sftkReportWhereLabel(app, o.where);
  const params = [
    ['template', 'bug_report.yml'],
    ['title', '[' + version + '] ' + where + ': '],
    ['version', version],
    ['browser', browser],
    ['os', os],
    ['language', language],
    ['app', sftkReportAppLabel(app)],
    ['where', where],
    ['theme', theme],
  ].filter(p => p[1] !== '');
  return sftkReportRepo() + '/issues/new?'
    + params.map(p => p[0] + '=' + encodeURIComponent(p[1])).join('&');
}

// ── impure: read the environment, then build ─────────────────────
function sftkReportEnv() {
  let version = '';
  try { version = chrome.runtime.getManifest().version; } catch (_) { /* not an extension page */ }
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const uad = nav.userAgentData || null;
  const root = typeof document !== 'undefined' ? document : null;
  const has = c => !!root && (root.documentElement.classList.contains(c) || (root.body && root.body.classList.contains(c)));
  const theme = (has('sftk-oled') || has('ds-oled')) ? 'oled' : ((has('sftk-dark') || has('ds-dark')) ? 'dark' : 'light');
  return {
    version,
    browser: sftkReportBrowser(uad && uad.brands, nav.userAgent),
    os: sftkReportOs(uad && uad.platform, nav.userAgent),
    language: nav.language,
    theme,
  };
}

// Which app and which tool / view the user is on right now.
function sftkReportHere() {
  if (typeof document === 'undefined') return { app: 'toolkit', where: 'home' };
  if (document.querySelector('.ds-topbar')) {
    let v = '';
    try { v = typeof _currentView === 'string' ? _currentView : ''; } catch (_) { v = ''; }
    return { app: 'studio', where: v };
  }
  const open = Array.from(document.querySelectorAll('.tab-content')).find(el => el.style.display !== 'none');
  return { app: 'toolkit', where: open ? String(open.id || '').replace(/^tab-/, '') : 'home' };
}

// opts = { app, where } — either may be left out to use where the user is.
function sftkReportUrl(opts) {
  const here = sftkReportHere();
  const o = opts || {};
  return sftkReportBuildUrl(Object.assign(sftkReportEnv(), {
    app: o.app || here.app,
    where: o.where !== undefined ? o.where : here.where,
  }));
}

function sftkReportOpen(opts) {
  const url = sftkReportUrl(opts);
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.create === 'function') {
      chrome.tabs.create({ url });
      return url;
    }
  } catch (_) { /* fall through to window.open */ }
  window.open(url, '_blank', 'noopener');
  return url;
}

// Wire the topbar button in whichever page loaded this file.
function sftkReportBoot() {
  const btn = document.getElementById('sftkReportBtn');
  if (!btn || btn.dataset.sftkBound) return;
  btn.dataset.sftkBound = '1';
  btn.addEventListener('click', () => sftkReportOpen());
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sftkReportBoot);
  else sftkReportBoot();
}
