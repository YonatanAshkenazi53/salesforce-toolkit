// QA 1.1 finding 12: Flow Access and Copy Permissions never re-send a call to ANOTHER org after SESSION_EXPIRED.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const { sftkOrgKey } = extractFunctions('sftk-org-identity.js', ['sftkOrgKey']);
const { sftkFlowAccessRetryOk } = extractFunctions('flow-permissions.js', ['sftkFlowAccessRetryOk']);
const { sftkUserCopyRetryOk } = extractFunctions('user-copy.js', ['sftkUserCopyRetryOk']);

const SANDBOX = 'https://acme--uat.sandbox.my.salesforce.com';
const PROD = 'https://acme.my.salesforce.com';

for (const [name, ok, file, raw] of [
  ['Flow Access', sftkFlowAccessRetryOk, 'flow-permissions.js', 'sendBgRaw'],
  ['Copy Permissions', sftkUserCopyRetryOk, 'user-copy.js', 'bgRaw'],
]) {
  describe(`${name}: the call is sent again only to the same org`, () => {
    it('production\'s session is refused when the sandbox\'s session ended', () => {
      expect(ok(SANDBOX, 'dead', { orgUrl: PROD, sid: 'prodSid' }, sftkOrgKey)).toBe(false);
    });
    it('an unrelated org is refused', () => {
      expect(ok(SANDBOX, 'dead', { orgUrl: 'https://other.my.salesforce.com', sid: 's' }, sftkOrgKey)).toBe(false);
    });
    it('the same org with a new session is accepted, under any of its domains', () => {
      expect(ok(SANDBOX, 'dead', { orgUrl: SANDBOX, sid: 'new' }, sftkOrgKey)).toBe(true);
      expect(ok(SANDBOX, 'dead', { orgUrl: 'https://acme--uat.sandbox.lightning.force.com', sid: 'new' }, sftkOrgKey)).toBe(true);
    });
    it('the same dead session is not tried again', () => {
      expect(ok(SANDBOX, 'dead', { orgUrl: SANDBOX, sid: 'dead' }, sftkOrgKey)).toBe(false);
    });
    it('no answer, half an answer, no org of our own or no way to compare orgs: refused', () => {
      expect(ok(SANDBOX, 'dead', null, sftkOrgKey)).toBe(false);
      expect(ok(SANDBOX, 'dead', { error: 'No response' }, sftkOrgKey)).toBe(false);
      expect(ok(SANDBOX, 'dead', { orgUrl: SANDBOX }, sftkOrgKey)).toBe(false);
      expect(ok(SANDBOX, 'dead', { sid: 'new' }, sftkOrgKey)).toBe(false);
      expect(ok('', 'dead', { orgUrl: SANDBOX, sid: 'new' }, sftkOrgKey)).toBe(false);
      expect(ok(SANDBOX, 'dead', { orgUrl: SANDBOX, sid: 'new' }, null)).toBe(false);
    });
    it('the tool\'s own sender goes through the rule, and the session is replaced only inside it', () => {
      const src = read(file);
      expect(src).not.toContain('if (fresh?.sid && fresh?.orgUrl) {');
      const guard = src.indexOf(`if (${ok.name}(_orgUrl, msg.sid !== undefined ? msg.sid : _sid, fresh, typeof sftkOrgKey === 'function' ? sftkOrgKey : null)) {`);
      expect(guard).toBeGreaterThan(-1);
      const asked = src.lastIndexOf(`await ${raw}({ type: 'GET_SF_SESSION', activeTabUrl: _orgUrl });`, guard);
      expect(asked).toBeGreaterThan(-1);
      // the only place the module takes a session from GET_SF_SESSION is after the guard
      expect(src.split('_orgUrl = fresh.orgUrl;').length).toBe(2);
      expect(src.indexOf('_orgUrl = fresh.orgUrl;')).toBeGreaterThan(guard);
      expect(src.slice(guard).indexOf('return resp;')).toBeGreaterThan(-1);
    });
  });
}

describe('the page has the org key before either tool loads', () => {
  it('sftk-org-identity.js comes before user-copy.js and flow-permissions.js in popup.html', () => {
    const html = read('popup.html');
    const at = f => html.indexOf(`src="${f}"`);
    expect(at('sftk-org-identity.js')).toBeGreaterThan(-1);
    expect(at('sftk-org-identity.js')).toBeLessThan(at('user-copy.js'));
    expect(at('sftk-org-identity.js')).toBeLessThan(at('flow-permissions.js'));
  });
});
