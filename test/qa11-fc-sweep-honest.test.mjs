// QA 1.1 findings 33, 35, 60 and 69 — the full metadata text scan never ends "all read" over something it did not
// read, its late rows never land on another field's scan, and a refused flow fix names only controls that exist.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');

// the real functions of field-cleaner.js (they live inside its closure), run over a stubbed Salesforce
const nested = name => {
  const at = FC.indexOf(`\n  async function ${name}(`);
  if (at < 0) throw new Error(`not found in field-cleaner.js: ${name}`);
  return FC.slice(at + 1, FC.indexOf('\n  }\n', at + 1) + 4);
};
function harness(over) {
  const env = {
    _orgUrl: 'https://x.my.salesforce.com', _sid: 'SID', _selObj: { api: 'Account' }, _selField: { api: 'Old__c' },
    FC_SWEEP_CHUNK: 5000, renderOrgSweep() {}, renderResults: async () => {}, _feText: x => String(x),
    setTimeout: fn => { fn(); return 0; },
    sftkSweepParseDescribe: x => x, sftkSweepTypes: x => x, sftkSweepParseList: x => x, sftkSweepOwn: () => true,
    sftkSweepTextResource: () => false, sftkSweepForms: () => [], _sweepScanItems: () => [],
    sftkSweepChunks: listed => [Object.entries(listed).map(([name, members]) => ({ name, members }))],
    sftkSweepRun: files => ({ byType: {}, hits: [], filesRead: files.size, filesWithHits: 0 }),
    sftkSweepCompare: () => ({ known: 0, fresh: 0 }),
    sftkBase64ToBytes: x => x, sftkUnzip: async () => new Map([['unpackaged/reports/A/r1.report', '<Report/>']]),
    TYPE_CFG: { ApexClass: { sev: 'blocker' } }, sftkSweepJoinKind: t => t,
    sftkSweepIdQuery: (kind, name) => `SELECT Id FROM ${kind} WHERE Name = '${name}'`,
    ...over,
  };
  return new Function('env', `with (env) {
    let _orgSweep = null, _lastScan = null, _sweepPkg = false;
    const _SWEEP_PKG_BOXES = new Set(['CustomObject', 'Workflow', 'SharingRules']);
    ${nested('_sweepJoin')}
    ${nested('_sweepPlan')}
    ${nested('_sweepRun')}
    return { plan: _sweepPlan, run: _sweepRun, join: _sweepJoin, sweep: () => _orgSweep, setScan: v => { _lastScan = v; }, scan: () => _lastScan };
  }`)(env);
}

// an org with one folder kind: Report, folders A and B, one report in each
const REPORT = [{ name: 'Report', how: 'folders', folderType: 'ReportFolder' }];
function org({ folderB, unfiled, status, types = REPORT } = {}) {
  return async msg => {
    if (msg.type === 'SF_MD_DESCRIBE') return { text: types };
    if (msg.type === 'SF_REST_GET') return { sobjects: [] };
    if (msg.type === 'SF_QUERY') return { records: [] };
    if (msg.type === 'SF_MD_LIST') {
      if (msg.mdType === 'ReportFolder') return { text: [{ fullName: 'A' }, { fullName: 'B' }] };
      if (msg.mdType === 'ApexClass') return { text: [{ fullName: 'One' }, { fullName: 'Two' }] };
      if (msg.folder === 'A') return { text: [{ fullName: 'A/r1' }] };
      if (msg.folder === 'B') return folderB !== undefined ? folderB : { text: [{ fullName: 'B/r2' }] };
      if (msg.folder === 'unfiled$public') return unfiled || { text: [] };
    }
    if (msg.type === 'SF_MD_RETRIEVE_START') return { id: '09S1' };
    if (msg.type === 'SF_MD_RETRIEVE_STATUS') return status || { done: true, status: 'Succeeded', zipBase64: 'UEs=', messages: [] };
    throw new Error(`unexpected call: ${msg.type}`);
  };
}
async function sweep(orgOver, envOver) {
  const h = harness({ bg: org(orgOver), ...envOver });
  await h.plan();
  const planned = { ...h.sweep(), notes: [...h.sweep().notes] };
  await h.run();
  return { s: h.sweep(), planned };
}

describe('finding 33 — a folder whose listing fails', () => {
  it('control: every folder listed and read ends done, with nothing to say', async () => {
    const { s } = await sweep();
    expect(s.total).toBe(4);   // two folders and a report in each
    expect(s.status).toBe('done');
    expect(s.notes).toEqual([]);
  });
  it('is named in a note before anything is read, and the scan does not end done', async () => {
    const { s, planned } = await sweep({ folderB: { error: 'REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.' } });
    expect(planned.status).toBe('ready');
    expect(planned.notes).toHaveLength(1);
    expect(planned.notes[0]).toContain('Report: the folder B could not be listed (REQUEST_LIMIT_EXCEEDED');
    expect(planned.notes[0]).toContain('NOT read');
    expect(s.done).toBe(s.total);   // everything that was COUNTED was read — which is why the count alone proves nothing
    expect(s.status).toBe('stopped');
  });
  it('no answer at all from the listing is the same', async () => {
    const { s } = await sweep({ folderB: null });
    expect(s.notes[0]).toContain('the folder B could not be listed (no answer)');
    expect(s.status).toBe('stopped');
  });
  it('the unfiled public folder: a failure is named; a kind that has no such folder is not a failure', async () => {
    const bad = await sweep({ unfiled: { error: 'The request timed out' } });
    expect(bad.s.notes[0]).toContain('Report: the unfiled public folder could not be listed (The request timed out)');
    expect(bad.s.status).toBe('stopped');
    const none = await sweep({ unfiled: { error: 'INVALID_TYPE: Cannot use: Report in this organization' } });
    expect(none.s.notes).toEqual([]);
    expect(none.s.status).toBe('done');
  });
  it('the box then says INCOMPLETE and why, not STOPPED (nobody stopped it) and not the green line', () => {
    expect(FC).toContain("${all ? '' : (s.stop ? ' — STOPPED' : ' — INCOMPLETE')}");
    expect(FC).toContain('failed, so what ${s.listMissed === 1 ? \'it holds\' : \'they hold\'} was never counted and NOT read (named below)');
  });
});

describe('finding 35 — a retrieve that was not really read', () => {
  it('a zip that cannot be opened is not counted as read: the scan ends short, with the note', async () => {
    const { s } = await sweep({}, { sftkUnzip: async () => { throw new Error('not a zip file'); } });
    expect(s.done).toBe(0);
    expect(s.total).toBe(4);
    expect(s.status).toBe('stopped');
    expect(s.reading).toBe(false);
    expect(s.notes.some(n => n.includes('the zip could not be read (not a zip file)') && n.includes('4 NOT read'))).toBe(true);
  });
  it('members Salesforce left out of a successful retrieve are named and not counted as read', async () => {
    const messages = [{ file: 'unpackaged/package.xml', problem: "Entity of type 'Report' named 'B/r2' cannot be found" }];
    const { s } = await sweep({ status: { done: true, status: 'Succeeded', zipBase64: 'UEs=', messages } });
    expect(s.leftOut).toBe(1);
    expect(s.done).toBe(3);
    expect(s.status).toBe('stopped');
    const note = s.notes.find(n => n.includes('Salesforce left 1 out of this retrieve'));
    expect(note).toContain('Report: ');   // the retrieve is named, though the line on screen was cleared by then
    expect(note).toContain("named 'B/r2' cannot be found");
    expect(note).toContain('NOT read');
  });
  it('more than three left out: the first three and the count of the rest', async () => {
    const messages = [1, 2, 3, 4, 5].map(i => ({ file: `f${i}`, problem: `p${i}` }));
    const { s } = await sweep({ status: { done: true, status: 'Succeeded', zipBase64: 'UEs=', messages } });
    const note = s.notes.find(n => n.includes('Salesforce left 5 out'));
    expect(note).toContain('f1: p1; f2: p2; f3: p3; and 2 more.');
    expect(note).not.toContain('f4');
    expect(s.done).toBe(0);   // never below zero
  });
});

describe('finding 60 — the join outlives its scan', () => {
  const result = () => ({ byType: { ApexClass: { items: [{ component: 'One', lines: [] }, { component: 'Two', lines: [] }] } } });
  it('control: with the scan still on screen the rows join it', async () => {
    const h = harness({ bg: async () => ({ records: [{ Id: '01p000000000001' }] }) });
    const a = { deps: [] };
    h.setScan(a);
    expect(await h.join({ result: result() })).toBe(2);
    expect(a.deps.map(d => d.RefMetadataComponentName)).toEqual(['Account.Old__c', 'Account.Old__c']);
  });
  it('another field was scanned meanwhile: its scan gets no row of the old field, and the lookups stop', async () => {
    const b = { deps: [{ MetadataComponentName: 'own row of B' }] };
    let calls = 0, h;
    h = harness({ bg: async () => { calls++; h.setScan(b); return { records: [{ Id: '01p000000000001' }] }; } });
    const a = { deps: [] };
    h.setScan(a);
    expect(await h.join({ result: result() })).toBe(0);
    expect(b.deps).toEqual([{ MetadataComponentName: 'own row of B' }]);
    expect(a.deps).toEqual([]);
    expect(calls).toBe(1);   // the second lookup would have gone to whatever org is picked now
  });
  it('another field was picked and its scan has not landed yet: nothing joins and nothing throws', async () => {
    let h;
    h = harness({ bg: async () => { h.setScan(null); return { records: [{ Id: '01p000000000001' }] }; } });
    h.setScan({ deps: [] });
    await expect(h.join({ result: result() })).resolves.toBe(0);
    expect(h.scan()).toBeNull();
  });
});

describe('finding 69 — a refused flow fix', () => {
  it('names the button on the card and Flow Builder, and no walk (there is none since 1.1)', () => {
    expect(FC).not.toContain('in a walk over all items');
    expect(FC).toContain("Nothing was deleted. Press 🗑 Delete versions · flow off on this flow, or open in Flow Builder to ${swapping ? 'change' : 'remove'} the field reference by hand.");
    // the button the message sends the user to is still on the flow's card
    expect(FC.split('🗑 Delete versions · flow off').length).toBeGreaterThan(2);
  });
});
