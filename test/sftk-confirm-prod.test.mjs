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
    'https://prod.my.salesforce.com': { label: 'Prod', orgType: 'production' },
    'https://sbx.my.salesforce.com': { label: 'Sandbox', orgType: 'sandbox' },
    'https://trial.my.salesforce.com': { label: 'Trial', orgType: 'dev', guardAsProd: true },
    'https://plain.my.salesforce.com': { label: 'Plain', orgType: 'dev' },
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
  it('matches the lightning host to the my.salesforce.com entry; an unknown org is not production and says so', async () => {
    expect((await sftkOrgWriteGate('https://prod.lightning.force.com/lightning/page', orgs)).production).toBe(true);
    expect(await sftkOrgWriteGate('https://nobody.my.salesforce.com', orgs)).toEqual({ production: false, label: 'nobody', why: 'org not remembered' });
    expect((await sftkOrgWriteGate('', orgs)).production).toBe(false);
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
  it('the first step announces the coming production step', () => {
    expect(SRC).toContain('is treated as a PRODUCTION org — one more step asks for its name.');
  });
});
