// Lightning Pages, release QA 2026-11-14.
// 1. bg()'s own SESSION_EXPIRED retry is pinned to the org the tab was opened on: GET_SF_SESSION falls back to any
//    open org tab, and the old retry took that org's session, re-sent the message (writes included) there, and
//    switched _orgUrl/_sid for the rest of the tab.
// 2+3. Clone Page refuses an API name that is already taken: the Metadata deploy is an upsert, so it used to
//    overwrite that page, the verify found it, and the tool said "created" with undo 'none'.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const F = extractFunctions('lightning-pages.js', ['lpSessionRetryOk', 'lpCloneNameTaken', 'lpPageIsPackaged'], { 'sftk-org-identity.js': ['sftkOrgKey'] });
const SRC = readFileSync(new URL('../lightning-pages.js', import.meta.url), 'utf8');
const inner = (name) => {
  const i = SRC.indexOf(`function ${name}(`);
  expect(i, name).toBeGreaterThan(0);
  return SRC.slice(i, SRC.indexOf('\n  }\n', i));
};

describe('1. the session retry never moves to another org', () => {
  const A = 'https://acme.my.salesforce.com';
  it('same org (any domain form) with a new sid is retried', () => {
    expect(F.lpSessionRetryOk(A, 'old', { orgUrl: 'https://acme.my.salesforce.com', sid: 'new' })).toBe(true);
    expect(F.lpSessionRetryOk(A, 'old', { orgUrl: 'https://acme.lightning.force.com', sid: 'new' })).toBe(true);
  });
  it('another org, the same dead sid, or a missing answer is refused', () => {
    expect(F.lpSessionRetryOk(A, 'old', { orgUrl: 'https://other.my.salesforce.com', sid: 'new' })).toBe(false);
    expect(F.lpSessionRetryOk(A, 'old', { orgUrl: 'https://acme--uat.sandbox.my.salesforce.com', sid: 'new' })).toBe(false);
    expect(F.lpSessionRetryOk(A, 'same', { orgUrl: A, sid: 'same' })).toBe(false);
    expect(F.lpSessionRetryOk(A, 'old', { orgUrl: A })).toBe(false);
    expect(F.lpSessionRetryOk(A, 'old', { sid: 'new' })).toBe(false);
    expect(F.lpSessionRetryOk(A, 'old', null)).toBe(false);
    expect(F.lpSessionRetryOk('', 'old', { orgUrl: A, sid: 'new' })).toBe(false);
  });
  it('bg() gates the retry and the _orgUrl/_sid switch on lpSessionRetryOk', () => {
    const b = inner('bg');
    const gate = b.indexOf('if (lpSessionRetryOk(_orgUrl,');
    expect(gate).toBeGreaterThan(0);
    expect(b.indexOf('_orgUrl = fresh.orgUrl;')).toBeGreaterThan(gate);
    expect(b).not.toMatch(/if \(fresh\?\.sid && fresh\?\.orgUrl\)/);
  });
});

describe('2+3. Clone Page refuses an API name that is already taken', () => {
  it('lpCloneNameTaken matches case-insensitively and only on DeveloperName', () => {
    const pages = [{ DeveloperName: 'Account_Record_Page_Copy', MasterLabel: 'X' }, { MasterLabel: 'No name' }, null];
    expect(F.lpCloneNameTaken(pages, 'Account_Record_Page_Copy')).toBe(true);
    expect(F.lpCloneNameTaken(pages, 'account_record_page_copy')).toBe(true);
    expect(F.lpCloneNameTaken(pages, 'Account_Record_Page_Copy2')).toBe(false);
    expect(F.lpCloneNameTaken(pages, 'X')).toBe(false);
    expect(F.lpCloneNameTaken(pages, '')).toBe(false);
    expect(F.lpCloneNameTaken(null, 'A')).toBe(false);
  });
  it('the dialog refuses from the loaded list before any confirmation or write', () => {
    const i = SRC.indexOf("getElementById('cloneConfirmBtn').addEventListener");
    const h = SRC.slice(i, SRC.indexOf('async function doClone(', i));
    const check = h.indexOf('if (lpCloneNameTaken(allPages, apiName))');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(h.indexOf('sftkConfirmDestructive'));
    expect(check).toBeLessThan(h.indexOf('doClone('));
  });
  it('doClone asks the org right before the deploy and refuses on a hit or on a failed check', () => {
    const d = inner('doClone');
    const q = d.indexOf("FROM FlexiPage WHERE DeveloperName='${newApiName}'`\n    });");
    const deploy = d.indexOf("type: 'SF_METADATA_DEPLOY'");
    expect(q).toBeGreaterThan(0);
    expect(q).toBeLessThan(deploy);
    expect(d.indexOf('sftkHistoryBegin')).toBeGreaterThan(q);
    expect(d).toMatch(/if \(!taken \|\| taken\.error\) throw new Error\(/);
    // 2026-11-15: was `(taken.records || []).length`, which pinned a defect — an installed package's page of the
    // same name refused a free API name. The hit is judged by lpCloneNameTaken (run in test/regress-1115-perms-pages).
    expect(d).toMatch(/if \(lpCloneNameTaken\(taken\.records, newApiName\)\) throw new Error\('DUPLICATE_DEVELOPER_NAME'\)/);
  });
});
