// The shared confirmation's production gate and required word (campaign 3, phase 2).
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction } from './extract.mjs';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'sftk-confirm.js'), 'utf8');
const sftkOrgWriteGate = extractFunction('sftk-confirm.js', 'sftkOrgWriteGate');

describe('sftkOrgWriteGate — which orgs need the typed name', () => {
  const orgs = {
    'https://prod.my.salesforce.com': { label: 'Prod', orgType: 'production', orgTypeAt: Date.now() },
    'https://sbx.my.salesforce.com': { label: 'Sandbox', orgType: 'sandbox', orgTypeAt: Date.now() },
    'https://trial.my.salesforce.com': { label: 'Trial', orgType: 'dev', guardAsProd: true },
    'https://plain.my.salesforce.com': { label: 'Plain', orgType: 'dev', orgTypeAt: Date.now() },
  };
  it('a production org, by its type', async () => {
    expect(await sftkOrgWriteGate('https://prod.my.salesforce.com', orgs)).toEqual({ production: true, label: 'Prod', why: 'production org' });
  });
  it('an org the user guarded as production, whatever its type', async () => {
    expect(await sftkOrgWriteGate('https://trial.my.salesforce.com', orgs)).toEqual({ production: true, label: 'Trial', why: 'guarded as production' });
  });
  it('a sandbox or dev org: no typed step', async () => {
    expect((await sftkOrgWriteGate('https://sbx.my.salesforce.com', orgs)).production).toBe(false);
    expect((await sftkOrgWriteGate('https://plain.my.salesforce.com', orgs)).production).toBe(false);
  });
  it('matches the lightning host to the my.salesforce.com entry', async () => {
    expect((await sftkOrgWriteGate('https://prod.lightning.force.com/lightning/page', orgs)).production).toBe(true);
    expect((await sftkOrgWriteGate('', orgs)).production).toBe(false);
  });
  it('an org it cannot classify is treated as PRODUCTION (fail closed), and says why', async () => {
    delete globalThis.chrome;   // no background to ask
    expect(await sftkOrgWriteGate('https://nobody.my.salesforce.com', orgs)).toEqual({ production: true, label: 'nobody', why: 'org type unknown — treated as production' });
  });
  it('a stale or missing type is re-read from the org through the background session and stored for both pages', async () => {
    const stored = [];
    const orgs2 = { 'https://old.my.salesforce.com': { label: 'Old', orgType: 'production', orgTypeAt: Date.now() - 30 * 864e5 } };
    globalThis.chrome = { runtime: { sendMessage: (msg, cb) => cb(msg.type === 'GET_ALL_SF_SESSIONS'
        ? { sessions: [{ orgUrl: 'https://old.my.salesforce.com', sid: 'S', label: 'Old' }] }
        : { records: [{ IsSandbox: true, OrganizationType: 'Enterprise Edition', TrialExpirationDate: null }] }) },
      storage: { local: { set: async v => { stored.push(v); }, get: async () => ({}) } } };
    const r = await sftkOrgWriteGate('https://old.my.salesforce.com', orgs2);
    expect(r).toEqual({ production: false, label: 'Old', why: 'sandbox' });
    expect(stored[0].sftk_orgs['https://old.my.salesforce.com'].orgType).toBe('sandbox');
    delete globalThis.chrome;
  });
  it('a fresh remembered type is trusted without asking', async () => {
    let asked = 0;
    globalThis.chrome = { runtime: { sendMessage: (msg, cb) => { asked++; cb({}); } }, storage: { local: { set: async () => {}, get: async () => ({}) } } };
    const orgs3 = { 'https://fresh.my.salesforce.com': { label: 'Fresh', orgType: 'dev', orgTypeAt: Date.now() } };
    expect((await sftkOrgWriteGate('https://fresh.my.salesforce.com', orgs3)).production).toBe(false);
    expect(asked).toBe(0);
    delete globalThis.chrome;
  });
});

describe('sftkConfirmDestructive — the production step and the required word', () => {
  it('accepts production: { label } and typedWord, and renders both pages\' classes', () => {
    expect(SRC).toMatch(/production = null,\s*typedWord = '',/);
    expect(SRC).toContain("const ds = !!document.getElementById('dsModalBox');");
    expect(SRC).toMatch(/head: 'ds-modal-header', body: 'ds-modal-body', foot: 'ds-modal-footer'/);
    expect(SRC).toMatch(/head: 'modal-header modal-danger', body: 'modal-body', foot: 'modal-footer'/);
  });
  it('Go stays off until the acknowledgement AND the word are given', () => {
    expect(SRC).toMatch(/const gateOff = rev\.needsCheckbox \|\| !!word;/);
    expect(SRC).toMatch(/const wordOk = !word \|\| \(document\.getElementById\('sftkConfirmWord'\)\?\.value \|\| ''\)\.trim\(\)\.toUpperCase\(\) === word\.toUpperCase\(\);/);
    expect(SRC).toMatch(/go\.disabled = !\(ackOk && wordOk\);/);
  });
  it('with production set, Go opens the typed-name step in the same dialog; Proceed needs the exact label; Cancel resolves false', () => {
    expect(SRC).toMatch(/addEventListener\('click', \(\) => \{ if \(prod\) askProduction\(\); else done\(true\); \}\);/);
    expect(SRC).toMatch(/inp\?\.addEventListener\('input', \(\) => \{ if \(go\) go\.disabled = inp\.value\.trim\(\) !== prod\.label; \}\);/);
    expect(SRC).toContain("document.getElementById('sftkConfirmProdCancel')?.addEventListener('click', () => done(false));");
    expect(SRC).toContain('is treated as a <strong>PRODUCTION</strong> org — what you change here affects real users now.');
  });
  it('the acknowledgement takes its own words through revOverride.ack (an undo is not "permanent")', () => {
    expect(SRC).toContain("${esc(rev.ack || 'I understand this is permanent')}");
    expect(SRC).toContain("ack: opts.revOverride.ack || ''");
  });
  it('the first step announces the coming production step', () => {
    expect(SRC).toContain('is treated as a PRODUCTION org — one more step asks for its name.');   // the red band at the top of the dialog (2026-10-07)
  });
});
