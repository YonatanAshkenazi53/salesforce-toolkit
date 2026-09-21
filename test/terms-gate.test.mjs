// THE LICENCE GATE — "if they accept, they can use it. if not, than they
// can't" (user 2026-08-26).
//
// This tool deletes records, hard-deletes past the Recycle Bin, and writes
// to several orgs at once. The extension is free, so there is no purchase
// contract carrying that agreement — this gate IS the agreement. Which
// means the interesting tests are not "does the dialog render" but "can it
// be skipped", and "does it fail toward asking rather than toward assuming
// consent".
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const SRC = readFileSync(new URL('../sftk-terms.js', import.meta.url), 'utf8');
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

const F = extractFunctions('sftk-terms.js', [
  'sftkTermsVersion', 'sftkTermsKey', 'sftkTermsNeedsAccept',
  'sftkTermsRecord', 'sftkTermsPoints', 'sftkTermsEsc',
]);

const V = F.sftkTermsVersion();

describe('deciding whether to ask', () => {
  it('asks on a first run', () => {
    expect(F.sftkTermsNeedsAccept(undefined, V).needed).toBe(true);
    expect(F.sftkTermsNeedsAccept(undefined, V).reason).toBe('first run');
  });

  it('does NOT ask again once accepted at the current version', () => {
    const ok = F.sftkTermsNeedsAccept({ version: V, acceptedAt: '2026-08-26T10:00:00Z' }, V);
    expect(ok.needed).toBe(false);
    expect(ok.reason).toContain('2026-08-26');
  });

  it('asks again when the terms version moves up', () => {
    const r = F.sftkTermsNeedsAccept({ version: V - 1, acceptedAt: '2026-01-01T00:00:00Z' }, V);
    expect(r.needed).toBe(true);
    expect(r.reason).toContain('terms changed');
  });

  it('fails toward ASKING on anything malformed — never toward consent', () => {
    // Every one of these is a state where we cannot prove the person
    // agreed. Letting them through would be inventing consent.
    for (const bad of [null, 'yes', 42, [], {}, { version: V }, { acceptedAt: 'x' },
      { version: 'one', acceptedAt: 'x' }, { version: null, acceptedAt: 'x' },
      { version: V, acceptedAt: '' }]) {
      expect(F.sftkTermsNeedsAccept(bad, V).needed).toBe(true);
    }
  });

  it('always gives a reason, whichever way it decides', () => {
    for (const s of [undefined, {}, { version: V, acceptedAt: 'x' }]) {
      expect(typeof F.sftkTermsNeedsAccept(s, V).reason).toBe('string');
      expect(F.sftkTermsNeedsAccept(s, V).reason.length).toBeGreaterThan(5);
    }
  });

  it('a version it cannot read is a reason to ask, not to skip', () => {
    expect(F.sftkTermsNeedsAccept({ version: V, acceptedAt: 'x' }, undefined).needed).toBe(true);
    expect(F.sftkTermsNeedsAccept({ version: V, acceptedAt: 'x' }, 'latest').needed).toBe(true);
  });

  it('an acceptance from a NEWER build is honoured, not re-asked', () => {
    // A downgrade should not nag someone who has already agreed to more.
    expect(F.sftkTermsNeedsAccept({ version: V + 5, acceptedAt: 'x' }, V).needed).toBe(false);
  });
});

describe('what gets recorded', () => {
  it('records the version and the timestamp, and nothing else', () => {
    // Recording more than consent would itself be a privacy problem.
    const rec = F.sftkTermsRecord(V, '2026-08-26T10:00:00Z');
    expect(Object.keys(rec).sort()).toEqual(['acceptedAt', 'version']);
    expect(rec.version).toBe(V);
    expect(rec.acceptedAt).toBe('2026-08-26T10:00:00Z');
  });

  it('what it records is exactly what it accepts back', () => {
    const rec = F.sftkTermsRecord(V, '2026-08-26T10:00:00Z');
    expect(F.sftkTermsNeedsAccept(rec, V).needed).toBe(false);
  });

  it('uses one storage key, named in PRIVACY.md', () => {
    expect(F.sftkTermsKey()).toBe('sftk_terms_accepted');
    expect(read('PRIVACY.md')).toContain('sftk_terms_accepted');
  });
});

describe('what the dialog tells people', () => {
  const points = F.sftkTermsPoints().map(p => p.text).join(' ');

  it('names the consequences that actually matter', () => {
    expect(points).toMatch(/delete every record/i);
    expect(points).toMatch(/Recycle Bin/i);
    expect(points).toMatch(/backups/i);
    expect(points).toMatch(/production/i);
    expect(points).toMatch(/as is.{0,30}no warranty/i);
  });

  it('does not overclaim what masking does', () => {
    expect(points).toMatch(/pseudonymisation, not anonymisation/i);
  });

  it('disclaims affiliation with Salesforce', () => {
    expect(points).toMatch(/not affiliated with Salesforce/i);
  });

  it('says outright that ANY consequence, from BOTH apps and every component, is the user\u2019s (user 2026-09-03)', () => {
    expect(points).toMatch(/both the Toolkit and Data Studio, and every one of their components/);
    expect(points).toMatch(/Any consequence of using any of it is your responsibility/);
    // the checkbox the user must tick says the same thing, in the first person
    const gate = read('sftk-terms.js');
    expect(gate).toMatch(/I confirm that any consequence of\s+using Admin Toolkit for Salesforce/);
    expect(gate).toMatch(/is my responsibility, not the author/);
    expect(gate).toMatch(/including production/);
    // version 2 re-gates everyone who accepted the weaker v1 statement
    expect(V).toBe(2);
    expect(F.sftkTermsNeedsAccept({ version: 1, acceptedAt: '2026-08-26T00:00:00Z' }, V).needed).toBe(true);
    // and the document itself carries the same confirmation
    const eula = read('EULA.md');
    expect(eula).toContain('Version 2');
    expect(eula).toMatch(/By accepting this agreement you confirm that any consequence of using the\nSoftware/);
  });

  it('every point has an icon and real text', () => {
    for (const p of F.sftkTermsPoints()) {
      expect(p.icon.length).toBeGreaterThan(0);
      expect(p.text.length).toBeGreaterThan(40);
    }
  });
});

describe('the gate cannot be walked past', () => {
  it('every page that can start work carries it', () => {
    // A page that boots without the gate is a hole in the agreement.
    for (const f of ['popup.js', 'studio-core.js', 'apex-log-viewer.js']) {
      expect(read(f), f).toMatch(/if \(typeof sftkTermsGate === 'function' && !\(await sftkTermsGate\(\)\)\) return;/);
    }
  });

  it('every page LOADS it, before the scripts that would use it', () => {
    for (const f of ['popup.html', 'studio.html', 'apex-log-viewer.html']) {
      const html = read(f);
      expect(html, f).toContain('sftk-terms.js');
      expect(html.indexOf('sftk-terms.js'), f).toBeLessThan(html.indexOf('</body>'));
    }
  });

  it('the Studio gates BEFORE it touches storage or any org session', () => {
    const s = read('studio-core.js');
    const boot = s.slice(s.indexOf("document.addEventListener('DOMContentLoaded'"));
    const gate = boot.indexOf('sftkTermsGate');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(boot.indexOf('storageLoad()'));
    expect(gate).toBeLessThan(boot.indexOf('GET_SF_SESSION'));
  });

  it('the popup gates before it opens a session', () => {
    const s = read('popup.js');
    const boot = s.slice(s.indexOf("document.addEventListener('DOMContentLoaded'"));
    expect(boot.indexOf('sftkTermsGate')).toBeLessThan(boot.indexOf('initSession'));
  });

  it('declining leaves the page blocked and says nothing was changed', () => {
    expect(SRC).toContain('cannot be used without accepting');
    expect(SRC).toContain('Nothing has been changed in any of your orgs');
    // and a misclick is recoverable
    expect(SRC).toContain('Read the terms again');
  });

  it('Accept stays disabled until the box is ticked', () => {
    // An accept that can be clicked without reading is a weak record.
    expect(SRC).toMatch(/yes\.disabled = !cb\.checked/);
    expect(SRC).toMatch(/<button id="sftkTermsYes" disabled/);
  });

  it('storage failure does not silently record a consent that was not saved', () => {
    expect(SRC).toContain('you will be asked again next time');
  });
});

describe('the documents the gate points at', () => {
  // Markdown hard-wraps at ~80 columns, so a phrase assertion must not
  // depend on where a line happens to break.
  const flat = f => read(f).replace(/^\s*>\s?/gm, '').replace(/\s+/g, ' ');

  it('the EULA covers the clauses that carry the risk', () => {
    const e = flat('EULA.md');
    expect(e).toMatch(/AS IS/);
    expect(e).toMatch(/Limitation of liability/i);
    expect(e).toMatch(/not affiliated with, endorsed by/i);
    expect(e).toMatch(/backups/i);
    expect(e).toMatch(/pseudonymisation, not anonymisation/i);
    expect(e).toMatch(/Governing law/i);
  });

  it('the drafting note ("template, not legal advice, not reviewed by a lawyer") is NOT in the shipped EULA — it lives in a repo-only file', () => {
    // user 2026-09-14: "the first lines here are something that should never
    // come out to the end user"
    expect(flat('EULA.md')).not.toMatch(/not legal advice|reviewed by a lawyer/i);
    expect(flat('LEGAL_NOTES.md')).toMatch(/not been reviewed by a lawyer/i);
    expect(read('scripts/pack_store.py')).not.toContain('LEGAL_NOTES');
  });

  it('says plainly that paid tiers will not be sprung on people', () => {
    expect(flat('EULA.md')).toMatch(/will not start charging you for something you are already using/i);
  });

  it('the LICENSE is proprietary, not an open-source grant', () => {
    const l = flat('LICENSE');
    expect(l).toMatch(/All rights reserved/i);
    expect(l).toMatch(/NOT open source/i);
    expect(l).toMatch(/may NOT copy, modify, redistribute/i);
  });

  it('they SHIP, so the gate does not link to a 404', () => {
    const packer = read('scripts/pack_store.py');
    for (const doc of ['LICENSE', 'EULA.md', 'PRIVACY.md']) {
      expect(packer, doc).toContain(`'${doc}'`);
    }
    // …and the page that renders them ships too (.html/.js are copied by extension)
    expect(packer).toMatch(/ext in \('\.html', '\.css', '\.png'\)/);
    const legal = read('legal.html');
    expect(legal).toContain('<meta charset="utf-8">');
    expect(legal).toContain('<script src="legal.js"></script>');
    expect(legal).not.toMatch(/<script>[^]*?<\/script>/);   // no inline script under the extension CSP
  });

  it('PRIVACY.md covers what the Seeder does with data', () => {
    const p = flat('PRIVACY.md');
    expect(p).toMatch(/pseudonymisation, not anonymisation/i);
    expect(p).toContain('sftk_seed_pii');
    expect(p).toMatch(/field \*?names\*?, never field \*?values\*?/i);
  });
});

describe('the terms can be read AGAIN, any time (user 2026-09-03: "i want to read what it say")', () => {
  const TERMS = readFileSync(new URL('../sftk-terms.js', import.meta.url), 'utf8');
  const POPUP = readFileSync(new URL('../popup.html', import.meta.url), 'utf8');
  const CORE  = readFileSync(new URL('../studio-core.js', import.meta.url), 'utf8');

  it('a read-only view shows the same points and links, records nothing, and says what was accepted', () => {
    expect(TERMS).toContain('async function sftkTermsShow()');
    const view = TERMS.slice(TERMS.indexOf('async function sftkTermsShow()'));
    expect(view).toContain('sftkTermsPoints().map');
    expect(view).toContain("getURL('legal.html?doc=eula')");
    expect(view).toContain("getURL('legal.html?doc=privacy')");
    expect(view).toContain('You accepted version');
    expect(view).toContain('No acceptance is recorded');
    expect(view).not.toContain('chrome.storage.local.set');
  });

  it('is reachable from the popup top bar and from Data Studio\u2019s security modal', () => {
    expect(POPUP).toContain('id="sftkTermsBtn"');
    expect(TERMS).toContain("document.getElementById('sftkTermsBtn')");
    expect(CORE).toContain('data-dsaction="showTerms"');
    expect(CORE).toMatch(/case 'showTerms':\s*if \(typeof sftkTermsShow === 'function'\) sftkTermsShow\(\)/);
  });
});
