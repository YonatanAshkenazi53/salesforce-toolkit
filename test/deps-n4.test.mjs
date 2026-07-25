// N4c / N4d / N4e — the pure half of the dependency-map work.
//
// Everything under test is a top-level, column-0 function in dependency-map.js
// with no free variables, so extract.mjs can materialise it standalone.
// The cycle test is the important one: the transitive walkers run inside the
// popup, so an A→B→A subflow loop MUST terminate rather than hang the UI.
import { describe, it, expect } from 'vitest';
import { extractFunction } from './extract.mjs';

const depChain         = extractFunction('dependency-map.js', 'depChain');
const depDeadSubflows  = extractFunction('dependency-map.js', 'depDeadSubflows');
const depRefsMissingIn = extractFunction('dependency-map.js', 'depRefsMissingIn');
const depMissingNames  = extractFunction('dependency-map.js', 'depMissingNames');
const depReportMarkdown = extractFunction('dependency-map.js', 'depReportMarkdown');
const depReportCsv      = extractFunction('dependency-map.js', 'depReportCsv');

// The module stores the map child→parents: calledApiName -> [caller records].
const caller = (apiName, status = 'Active') =>
  ({ id: `id_${apiName}`, apiName, masterLabel: `${apiName} label`, status, processType: 'AutoLaunchedFlow' });

// A → B → C → D
const LINE = {
  B: [caller('A')],
  C: [caller('B')],
  D: [caller('C')],
};

describe('depChain (dependency-map.js) — transitive subflow chains', () => {
  it('walks DOWN the whole chain from a root', () => {
    const r = depChain(LINE, 'A', 'down', 6);
    expect(r.dir).toBe('down');
    expect(r.root.apiName).toBe('A');
    expect(r.root.children.map(c => c.apiName)).toEqual(['B']);
    expect(r.root.children[0].children.map(c => c.apiName)).toEqual(['C']);
    expect(r.root.children[0].children[0].children.map(c => c.apiName)).toEqual(['D']);
    expect(r.stats.nodes).toBe(4);
    expect(r.stats.deepest).toBe(3);
    expect(r.stats.cycles).toBe(0);
  });

  it('walks UP the whole chain from a leaf', () => {
    const r = depChain(LINE, 'D', 'up', 6);
    expect(r.dir).toBe('up');
    expect(r.root.children.map(c => c.apiName)).toEqual(['C']);
    expect(r.root.children[0].children.map(c => c.apiName)).toEqual(['B']);
    expect(r.root.children[0].children[0].children.map(c => c.apiName)).toEqual(['A']);
  });

  it('fans out to every sibling subflow', () => {
    const map = { X: [caller('Root')], Y: [caller('Root')], Z: [caller('Root')] };
    expect(depChain(map, 'Root', 'down', 6).root.children.map(c => c.apiName)).toEqual(['X', 'Y', 'Z']);
  });

  it('TERMINATES on a cycle (A calls B, B calls A) and flags it', () => {
    const cyc = { B: [caller('A')], A: [caller('B')] };
    const down = depChain(cyc, 'A', 'down', 20);
    // A → B → A(cycle, not expanded). Three nodes, no infinite recursion.
    expect(down.stats.nodes).toBe(3);
    expect(down.stats.cycles).toBe(1);
    const b = down.root.children[0];
    expect(b.apiName).toBe('B');
    expect(b.children[0].apiName).toBe('A');
    expect(b.children[0].cycle).toBe(true);
    expect(b.children[0].children).toEqual([]);
    // …and the same in the other direction.
    const up = depChain(cyc, 'A', 'up', 20);
    expect(up.stats.cycles).toBe(1);
    expect(up.stats.nodes).toBe(3);
  });

  it('TERMINATES on a three-node cycle (A→B→C→A)', () => {
    const cyc = { B: [caller('A')], C: [caller('B')], A: [caller('C')] };
    const r = depChain(cyc, 'A', 'down', 50);
    expect(r.stats.nodes).toBe(4);
    expect(r.stats.cycles).toBe(1);
  });

  it('TERMINATES on a self-call (A calls A)', () => {
    const r = depChain({ A: [caller('A')] }, 'A', 'down', 10);
    expect(r.stats.nodes).toBe(2);
    expect(r.root.children[0].cycle).toBe(true);
  });

  it('caps depth and flags the truncated node instead of pretending the chain ended', () => {
    const r = depChain(LINE, 'A', 'down', 2);
    const c = r.root.children[0].children[0];
    expect(c.apiName).toBe('C');
    expect(c.truncated).toBe(true);
    expect(c.children).toEqual([]);
    expect(r.stats.truncated).toBe(1);
    expect(r.maxDepth).toBe(2);
  });

  it('does not flag truncated when the capped node genuinely has no children', () => {
    const r = depChain({ B: [caller('A')] }, 'A', 'down', 1);
    expect(r.root.children[0].truncated).toBe(false);
    expect(r.stats.truncated).toBe(0);
  });

  it('a diamond (A→B, A→C, B→D, C→D) visits D on both branches without looping', () => {
    const map = { B: [caller('A')], C: [caller('A')], D: [caller('B'), caller('C')] };
    const r = depChain(map, 'A', 'down', 10);
    expect(r.root.children.map(c => c.apiName)).toEqual(['B', 'C']);
    expect(r.root.children[0].children[0].apiName).toBe('D');
    expect(r.root.children[1].children[0].apiName).toBe('D');
    expect(r.stats.cycles).toBe(0);
  });

  it('handles an unknown flow, junk input and a bad depth without throwing', () => {
    expect(depChain(LINE, 'Nope', 'down', 6).root.children).toEqual([]);
    expect(depChain(null, 'A', 'down', 6).root.apiName).toBe('A');
    expect(depChain(undefined, undefined, undefined, undefined).root.apiName).toBe('');
    expect(depChain(LINE, 'A', 'down', 0).maxDepth).toBe(6);   // falls back to the default
    expect(depChain(LINE, 'A', 'sideways', 6).dir).toBe('down');
  });

  it('ignores caller records with no apiName', () => {
    const map = { B: [{ masterLabel: 'orphan', status: 'Active' }, caller('A')] };
    expect(depChain(map, 'B', 'up', 6).root.children.map(c => c.apiName)).toEqual(['A']);
  });
});

describe('depDeadSubflows (dependency-map.js) — dead / missing / inactive subflow targets', () => {
  const map = {
    Sub_Live:     [caller('Parent_Active', 'Active')],
    Sub_Dead:     [caller('Parent_Draft', 'Draft'), caller('Parent_Obsolete', 'Obsolete')],
    Sub_Gone:     [caller('Parent_Active', 'Active')],
    Sub_Inactive: [caller('Parent_Active', 'Active')],
  };
  const flows = {
    Sub_Live:        [{ MasterLabel: 'Sub Live', Status: 'Obsolete', VersionNumber: 1 },
      { MasterLabel: 'Sub Live', Status: 'Active', VersionNumber: 2 }],
    Sub_Dead:        [{ MasterLabel: 'Sub Dead', Status: 'Active', VersionNumber: 1 }],
    Sub_Inactive:    [{ MasterLabel: 'Sub Inactive', Status: 'Draft', VersionNumber: 3 }],
    Parent_Active:   [{ MasterLabel: 'Parent Active', Status: 'Active', VersionNumber: 1 }],
    Parent_Draft:    [{ MasterLabel: 'Parent Draft', Status: 'Draft', VersionNumber: 1 }],
    Parent_Obsolete: [{ MasterLabel: 'Parent Obsolete', Status: 'Obsolete', VersionNumber: 1 }],
  };
  const res = depDeadSubflows(map, flows);

  it('flags a subflow whose every caller is inactive', () => {
    expect(res.dead.map(d => d.apiName)).toEqual(['Sub_Dead']);
    expect(res.dead[0].selfActive).toBe(true);
    expect(res.dead[0].status).toBe('Active');
    expect(res.dead[0].callers.map(c => c.apiName)).toEqual(['Parent_Draft', 'Parent_Obsolete']);
    expect(res.dead[0].reason).toMatch(/none of them Active/i);
  });

  it('does NOT flag a subflow that still has an Active caller', () => {
    expect(res.dead.map(d => d.apiName)).not.toContain('Sub_Live');
    expect(res.dead.map(d => d.apiName)).not.toContain('Sub_Inactive');
  });

  it('reports a subflow reference pointing at a flow that does not exist', () => {
    expect(res.missing.map(m => m.apiName)).toEqual(['Sub_Gone']);
    expect(res.missing[0].callers.map(c => c.apiName)).toEqual(['Parent_Active']);
  });

  it('reports a subflow reference pointing at a flow with NO Active version', () => {
    expect(res.inactiveTargets.map(m => m.apiName)).toEqual(['Sub_Inactive']);
    expect(res.inactiveTargets[0].status).toBe('Draft');
  });

  it('never double-counts a non-existent flow as "dead"', () => {
    expect(res.dead.map(d => d.apiName)).not.toContain('Sub_Gone');
  });

  it('counts everything it found', () => {
    expect(res.counts).toEqual({ subflowTargets: 4, dead: 1, missing: 1, inactiveTargets: 1 });
  });

  it('an inactive target with only inactive callers lands in BOTH buckets', () => {
    const r = depDeadSubflows(
      { S: [caller('P', 'Draft')] },
      { S: [{ MasterLabel: 'S', Status: 'Obsolete' }], P: [{ MasterLabel: 'P', Status: 'Draft' }] });
    expect(r.dead.map(d => d.apiName)).toEqual(['S']);
    expect(r.dead[0].selfActive).toBe(false);
    expect(r.inactiveTargets.map(d => d.apiName)).toEqual(['S']);
  });

  it('survives empty / junk input', () => {
    expect(depDeadSubflows(null, null).counts).toEqual({ subflowTargets: 0, dead: 0, missing: 0, inactiveTargets: 0 });
    expect(depDeadSubflows({}, {}).dead).toEqual([]);
  });
});

describe('depRefsMissingIn (dependency-map.js) — references vs another org\'s schema', () => {
  const refs = {
    objects: [
      { name: 'Account', ops: ['read'] },
      { name: 'Gone__c', ops: ['create'] },
      { name: 'Flaky__c', ops: ['read'] },
      { name: 'Never__c', ops: ['read'] },
    ],
    fields: [
      'Account.Name',          // present in target
      'Account.Nope__c',       // MISSING in target
      'Gone__c.Whatever__c',   // object itself missing
      'Account.Owner.Email',   // relationship traversal — cannot check
      '$Record.Foo__c',        // formula reference — cannot check
      'Flaky__c.X__c',         // describe errored — cannot check
      'Never__c.Y__c',         // never described — cannot check
      'NoDot',                 // no object context — cannot check
    ],
    subflows: [], apex: [], labels: [],
  };
  const describes = {
    Account: { fields: [{ name: 'Id' }, { name: 'Name' }] },
    Gone__c: null,                              // confirmed absent
    Flaky__c: { error: 'INVALID_SESSION_ID' },  // could not check
    // Never__c deliberately absent from the map
  };
  const r = depRefsMissingIn(refs, describes);

  it('names the objects that are genuinely absent in the target', () => {
    expect(r.missingObjects.map(o => o.name)).toEqual(['Gone__c']);
    expect(r.missingObjects[0].ops).toEqual(['create']);
  });

  it('names the fields that are absent in the target', () => {
    expect(r.missingFields.map(f => f.ref)).toEqual(['Account.Nope__c', 'Gone__c.Whatever__c']);
    expect(r.missingFields.find(f => f.ref === 'Gone__c.Whatever__c').reason).toMatch(/object itself is missing/i);
  });

  it('does NOT report a field that exists in the target', () => {
    expect(r.missingFields.map(f => f.ref)).not.toContain('Account.Name');
  });

  it('matches field names case-insensitively', () => {
    const x = depRefsMissingIn({ objects: [], fields: ['Account.NAME'] },
      { Account: { fields: [{ name: 'Name' }] } });
    expect(x.missingFields).toEqual([]);
  });

  it('keeps "could not check" strictly separate from "missing"', () => {
    expect(r.uncheckedObjects.map(o => o.name)).toEqual(['Flaky__c', 'Never__c']);
    expect(r.uncheckedObjects.find(o => o.name === 'Flaky__c').reason).toBe('INVALID_SESSION_ID');
    const un = r.uncheckedFields.map(f => f.ref);
    expect(un).toContain('Account.Owner.Email');
    expect(un).toContain('$Record.Foo__c');
    expect(un).toContain('Flaky__c.X__c');
    expect(un).toContain('Never__c.Y__c');
    expect(un).toContain('NoDot');
    // none of the unchecked ones leaked into the "would break" list
    for (const ref of un) expect(r.missingFields.map(f => f.ref)).not.toContain(ref);
  });

  it('explains WHY each unchecked reference could not be checked', () => {
    expect(r.uncheckedFields.find(f => f.ref === 'Account.Owner.Email').reason).toMatch(/relationship traversal/i);
    expect(r.uncheckedFields.find(f => f.ref === '$Record.Foo__c').reason).toMatch(/no resolvable object/i);
    expect(r.uncheckedFields.find(f => f.ref === 'NoDot').reason).toMatch(/no object context/i);
  });

  it('reports the tallies and the ok flag', () => {
    expect(r.checkedObjects).toEqual(['Account']);
    expect(r.breakCount).toBe(3);
    expect(r.uncheckedCount).toBe(7);
    expect(r.ok).toBe(false);
  });

  it('is ok when everything resolves', () => {
    const x = depRefsMissingIn(
      { objects: [{ name: 'Account', ops: ['read'] }], fields: ['Account.Name'] },
      { Account: { fields: [{ name: 'Name' }] } });
    expect(x.ok).toBe(true);
    expect(x.breakCount).toBe(0);
  });

  it('survives empty / junk input', () => {
    expect(depRefsMissingIn(null, null).ok).toBe(true);
    expect(depRefsMissingIn({}, {}).missingObjects).toEqual([]);
  });
});

describe('depMissingNames (dependency-map.js)', () => {
  it('returns the names absent from the target, case-insensitively and sorted', () => {
    expect(depMissingNames(['Zeta', 'Alpha', 'beta'], ['ALPHA', 'Gamma'])).toEqual(['Zeta', 'beta']);
  });
  it('de-duplicates and skips falsy entries', () => {
    expect(depMissingNames(['A', 'A', '', null, 'B'], [])).toEqual(['A', 'B']);
  });
  it('survives junk input', () => {
    expect(depMissingNames(null, null)).toEqual([]);
  });
});

// ── N4e — the exported report ────────────────────────────────────────────
const REPORT = {
  org: { url: 'https://acme.my.salesforce.com', label: 'acme.my.salesforce.com' },
  generatedAt: '2026-07-25T09:30:00.000Z',
  flowCount: 3,
  scanComplete: true,
  notes: ['Only ONE version per flow was analysed.'],
  dead: {
    dead: [{ apiName: 'Sub_Dead', masterLabel: 'Sub Dead', status: 'Active', selfActive: true,
      callers: [{ apiName: 'Parent_Draft', status: 'Draft' }], reason: 'Called by 1 flow(s) — none of them Active' }],
    missing: [{ apiName: 'Sub_Gone', callers: [{ apiName: 'Parent_Active', status: 'Active' }] }],
    inactiveTargets: [{ apiName: 'Sub_Inactive', status: 'Draft', callers: [] }],
    counts: { subflowTargets: 3, dead: 1, missing: 1, inactiveTargets: 1 },
  },
  chains: [{
    apiName: 'A', masterLabel: 'Flow A',
    down: { root: { apiName: 'A', status: 'Active', exists: true, selfActive: true, children: [
      { apiName: 'B', status: 'Draft', exists: true, selfActive: false, children: [
        { apiName: 'A', status: 'Active', exists: true, selfActive: true, cycle: true, children: [] }] }] } },
    up: { root: { apiName: 'A', exists: true, selfActive: true, children: [] } },
  }],
  blast: [{
    apiName: 'A', masterLabel: 'Flow A', status: 'Active',
    verdict: '⚠ 1 flow(s) call this as a subflow.',
    callers: [{ apiName: 'Root', masterLabel: 'Root', status: 'Active' }],
    refs: { objects: [{ name: 'Account', ops: ['read', 'update'] }], fields: ['Account.Name'], subflows: ['B'], apex: [], labels: [] },
  }],
  crossOrg: null,
};

describe('depReportMarkdown (dependency-map.js) — N4e export text', () => {
  const md = depReportMarkdown(REPORT);

  it('names the org and the timestamp in the file', () => {
    expect(md).toContain('# Flow dependency report');
    expect(md).toContain('acme.my.salesforce.com');
    expect(md).toContain('2026-07-25T09:30:00.000Z');
    expect(md).toContain('**Flows in scope:** 3');
  });

  it('carries the honesty notes through', () => {
    expect(md).toContain('Only ONE version per flow was analysed.');
    // "no Active caller" must never be printed as a verdict — the report has
    // to keep saying a flow can also be started by a button, Apex or REST.
    expect(md).toMatch(/not a verdict/i);
    expect(md).toMatch(/buttons, Apex, REST/);
  });

  it('renders the three subflow-health buckets with their counts', () => {
    expect(md).toContain('### 1.1 Dead subflows — no ACTIVE caller (1)');
    expect(md).toContain('Sub_Dead');
    expect(md).toContain('### 1.2 Subflow references pointing at a flow that does NOT exist (1)');
    expect(md).toContain('Sub_Gone');
    expect(md).toContain('### 1.3 Subflow references pointing at a flow with NO Active version (1)');
    expect(md).toContain('Sub_Inactive');
  });

  it('renders the chain as an indented tree and marks the cycle and the inactive hop', () => {
    expect(md).toContain('- A');
    expect(md).toContain('  - B');
    expect(md).toMatch(/no Active version/);
    expect(md).toMatch(/↻ cycle/);
  });

  it('renders the blast radius with ops', () => {
    expect(md).toContain('**Objects (1):** Account [read · update]');
    expect(md).toContain('**Calls subflows (1):** B');
  });

  it('says the cross-org diff was NOT run rather than omitting the section', () => {
    expect(md).toContain('## 4. Cross-org dependency diff');
    expect(md).toMatch(/Not run/);
  });

  it('renders the cross-org diff when it HAS been run, naming each breakage', () => {
    const withXo = depReportMarkdown({ ...REPORT, crossOrg: {
      target: { url: 'https://uat.my.salesforce.com', label: 'UAT' },
      notes: ['Custom labels are NOT compared.'],
      rows: [
        { apiName: 'A', masterLabel: 'Flow A', status: 'Active', presence: 'ok',
          missingObjects: [{ name: 'Widget__c', ops: ['read'] }],
          missingFields: [{ ref: 'Account.SLA__c', reason: 'field not present on that object in the comparison org' }],
          missingSubflows: ['B'], missingApex: [], apexChecked: true,
          uncheckedObjects: [], uncheckedFields: [], refsAvailable: true },
        { apiName: 'C', masterLabel: 'Flow C', status: 'Active', presence: 'missing',
          missingObjects: [], missingFields: [], missingSubflows: [], missingApex: [],
          apexChecked: false, uncheckedObjects: [], uncheckedFields: [], refsAvailable: true },
      ],
    } });
    expect(withXo).toContain('**Comparison org:** UAT');
    expect(withXo).toContain('Custom labels are NOT compared.');
    expect(withXo).toMatch(/2 of 2 flow\(s\) have a problem/);
    expect(withXo).toContain('Objects missing there: Widget__c');
    expect(withXo).toContain('Account.SLA__c');
    expect(withXo).toContain('Subflows missing there: B');
    expect(withXo).toContain('**Does not exist in the comparison org.**');
    expect(withXo).toMatch(/Apex references were NOT checked/);
  });

  it('shouts when the scan was incomplete', () => {
    expect(depReportMarkdown({ ...REPORT, scanComplete: false }))
      .toMatch(/metadata scan had NOT finished/i);
  });

  it('escapes pipes so a field name can never break the Markdown tables', () => {
    const md2 = depReportMarkdown({ ...REPORT, dead: { ...REPORT.dead,
      dead: [{ apiName: 'Weird|Name', status: 'Active', callers: [], reason: 'x' }] } });
    expect(md2).toContain('Weird\\|Name');
  });

  it('produces a usable document from an empty report instead of throwing', () => {
    const empty = depReportMarkdown({});
    expect(empty).toContain('# Flow dependency report');
    expect(empty).toContain('**Flows in scope:** unknown');
    expect(empty).toMatch(/No subflow relationships found/);
  });
});

describe('depReportCsv (dependency-map.js) — N4e tabular export', () => {
  const csv = depReportCsv(REPORT);
  const lines = csv.split('\r\n');

  it('starts with the header row', () => {
    expect(lines[0]).toBe('Section,Flow API Name,Flow Label,Status,Item,Detail');
  });

  it('carries the org and the timestamp', () => {
    expect(csv).toContain('Meta,,,,Org,acme.my.salesforce.com');
    expect(csv).toContain('Meta,,,,Generated,2026-07-25T09:30:00.000Z');
  });

  it('emits one row per subflow-health finding', () => {
    expect(csv).toMatch(/^Dead subflow,Sub_Dead,/m);
    expect(csv).toMatch(/^Missing subflow target,Sub_Gone,/m);
    expect(csv).toMatch(/^Inactive subflow target,Sub_Inactive,/m);
  });

  it('emits chain edges', () => {
    expect(csv).toContain('Chain edge');
    expect(csv).toContain('A calls B');
  });

  it('says the cross-org diff was not run', () => {
    expect(csv).toContain('Cross-org,,,,Not run,');
  });

  it('quotes cells containing commas or quotes', () => {
    const c = depReportCsv({ org: { label: 'Acme, Inc "HQ"' }, generatedAt: 't' });
    expect(c).toContain('"Acme, Inc ""HQ"""');
  });

  it('survives an empty report', () => {
    expect(depReportCsv({}).split('\r\n')[0]).toBe('Section,Flow API Name,Flow Label,Status,Item,Detail');
  });
});
