// Release QA 2026-11-14 — studio-transfer.js.
//
// 1. The dry run reads a CHILD inside its parents' scope (sftkChildCountWhere),
//    the way the preview count and the engine read it — never the whole child
//    table. A grandchild SOQL cannot scope is labelled an upper bound.
// 2. The Records preview trusts lastScan only when it is a scan of the pair
//    the RUN uses (the Transfer org chip can pick another ring target).
import { describe, it, expect, afterEach } from 'vitest';
import { extractFunctions } from './extract.mjs';

const { sftkDryRunAgainst } = extractFunctions('studio-transfer.js',
  ['sftkDryRunAgainst', 'sftkChildCountWhere'], { 'studio-core.js': ['soqlStrLit'] });
const { sftkRunPreviewScanFresh } = extractFunctions('studio-transfer.js', ['sftkRunPreviewScanFresh']);

const SRC = { orgUrl: 'https://acme.my.salesforce.com', sid: 'SID_SRC' };
const TGT = { orgUrl: 'https://acme--qa.sandbox.my.salesforce.com', sid: 'SID_TGT' };
const fld = (name, extra) => ({ name, type: 'string', createable: true, nillable: true, defaultValue: null, length: 255, ...extra });
const DESC = { fields: [fld('Id', { createable: false, type: 'id' }), fld('Name', { nillable: false })] };

function stub() {
  const queries = [];
  globalThis.sendBg = async msg => {
    if (msg.type === 'SF_REST_GET') return DESC;
    const q = String(msg.query || '');
    queries.push(q);
    if (/COUNT\(\)/.test(q)) return { totalSize: 2, records: [] };
    if (/FROM ValidationRule|FROM ApexTrigger|FROM DuplicateRule/.test(q)) return { records: [] };
    if (/GROUP BY RecordType/.test(q)) return { error: 'no record types' };
    return { records: [{ Id: '001', Name: 'Acme' }] };
  };
  return queries;
}
afterEach(() => { delete globalThis.sendBg; });

describe('dry run scopes children to their parents (2026-11-14)', () => {
  it('an unfiltered Contact under 2 picked Accounts is counted and sampled ONLY under them', async () => {
    const queries = stub();
    const tree = { objectType: 'Account', recordIds: ['001A', '001B'],
      children: [{ childSObject: 'Contact', field: 'AccountId' }] };
    const r = await sftkDryRunAgainst(tree, SRC, TGT, () => {}, null);
    expect(r.checked).toBe(2);
    const contactQs = queries.filter(q => /FROM Contact\b/.test(q));
    expect(contactQs.length).toBeGreaterThan(0);
    for (const q of contactQs) {
      expect(q, q).toContain("AccountId IN (SELECT Id FROM Account WHERE Id IN ('001A','001B'))");
    }
    expect(queries).not.toContain('SELECT COUNT() FROM Contact');
  });

  it('a child with its own filter keeps it AND the parent scope', async () => {
    const queries = stub();
    const tree = { objectType: 'Account', where: "Type = 'X'",
      children: [{ childSObject: 'Contact', field: 'AccountId', where: "Email != null" }] };
    await sftkDryRunAgainst(tree, SRC, TGT, () => {}, null);
    expect(queries).toContain("SELECT COUNT() FROM Contact WHERE (Email != null) AND AccountId IN (SELECT Id FROM Account WHERE Type = 'X')");
  });

  it('an unfiltered root keeps its children unscoped (the whole table IS the run)', async () => {
    const queries = stub();
    const tree = { objectType: 'Account', children: [{ childSObject: 'Contact', field: 'AccountId' }] };
    await sftkDryRunAgainst(tree, SRC, TGT, () => {}, null);
    expect(queries).toContain('SELECT COUNT() FROM Contact');
  });

  it('a grandchild SOQL cannot scope is said to be an upper bound, never shown as the count', async () => {
    stub();
    const lines = [];
    const tree = { objectType: 'Account', recordIds: ['001A'],
      children: [{ childSObject: 'Contact', field: 'AccountId',
        children: [{ childSObject: 'Case', field: 'ContactId' }] }] };
    await sftkDryRunAgainst(tree, SRC, TGT, (i, m) => lines.push(m), null);
    expect(lines.some(m => /^Case: cannot be limited to the records under its parent/.test(m))).toBe(true);
    expect(lines.some(m => m.startsWith('Case: ≤ 2 record(s)'))).toBe(true);
    expect(lines.some(m => m.startsWith('Contact: 2 record(s)'))).toBe(true);
  });
});

describe('Records preview freshness follows the run target (2026-11-14)', () => {
  const key = u => String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const P = { sourceOrg: 'https://src.my.salesforce.com', targetOrg: 'https://org1.my.salesforce.com',
    tree: { objectType: 'Account' } };
  const scan = { status: 'success', objectType: 'Account', sourceOrg: P.sourceOrg, targetOrg: P.targetOrg };

  it('a scan of org1 is fresh for a run into org1', () => {
    expect(sftkRunPreviewScanFresh(scan, P, P.sourceOrg, P.targetOrg, key)).toBe(true);
    expect(sftkRunPreviewScanFresh(scan, P, null, null, key)).toBe(true);
  });

  it('a scan of org1 is NOT fresh when the chip sends the run to org2', () => {
    expect(sftkRunPreviewScanFresh(scan, P, P.sourceOrg, 'https://org2.my.salesforce.com', key)).toBe(false);
  });

  it('the same org in another string form still matches (org key, not exact string)', () => {
    expect(sftkRunPreviewScanFresh(scan, P, P.sourceOrg, 'HTTPS://ORG1.my.salesforce.com/', key)).toBe(true);
  });

  it('an unstamped scan is trusted only for the profile own pair', () => {
    const bare = { status: 'success', objectType: 'Account' };
    expect(sftkRunPreviewScanFresh(bare, P, P.sourceOrg, P.targetOrg, key)).toBe(true);
    expect(sftkRunPreviewScanFresh(bare, P, P.sourceOrg, 'https://org2.my.salesforce.com', key)).toBe(false);
  });

  it('a failed scan or another root object is never fresh', () => {
    expect(sftkRunPreviewScanFresh({ ...scan, status: 'error' }, P, null, null, key)).toBe(false);
    expect(sftkRunPreviewScanFresh({ ...scan, objectType: 'Contact' }, P, null, null, key)).toBe(false);
  });
});
