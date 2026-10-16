// Campaign 4 phase 2 (user 2026-10-01): "no more source of truth". A deployment
// is a SHAPE; the orgs are picked on the Deploy page from the orgs open in
// Chrome; the saved sourceOrg/targetOrg are only the LAST-USED pair. The Sync
// Ring is now "All open orgs". These pins keep the crown, the follow/pin target
// sets, the re-baseline sweep and the scheduled drift probe from coming back.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const root = new URL('../', import.meta.url);
const read = f => readFileSync(new URL(f, root), 'utf8');
// Code only: drop block comments, HTML comments and // line comments (a comment
// may name a retired thing to explain why it is gone).
const code = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const CORE = read('studio-core.js');
const BUILDER = read('studio-builder.js');
const RING = read('studio-ring.js');
const PROFILES = read('studio-profiles.js');
const HTML = read('studio.html');
const BG = read('background.js');

const studioFiles = readdirSync(root).filter(f => /^studio-.*\.js$/.test(f));

describe('the crown, the followers and the scheduled probe are gone from the code', () => {
  const targets = [...studioFiles, 'background.js'];
  for (const name of ['syncRingFollowers', 'dsSetSourceOfTruth', 'sftkRingRebaseline', 'SF_SET_RING_SCHEDULE', 'SF_RUN_RING_PROBE']) {
    it(`${name} appears nowhere in studio-*.js / background.js`, () => {
      const hits = targets.filter(f => code(read(f)).includes(name));
      expect(hits).toEqual([]);
    });
  }

  it('nothing reads or writes ds_ring / ds_sched_drift any more', () => {
    const hits = [...targets, 'studio.html'].filter(f => /ds_ring|ds_sched_drift/.test(code(read(f))));
    expect(hits).toEqual([]);
  });

  it('background.js has no ring alarm or probe left', () => {
    const c = code(BG);
    expect(c).not.toMatch(/RING_ALARM|setRingSchedule|runRingProbe/);
  });
});

describe('the Builder writes none of the retired ring fields', () => {
  it('no write of sourcePinned / targetOrgs / _srcCrownMoved', () => {
    const c = code(BUILDER);
    // The export strip list NAMES them (as quoted strings); nothing assigns them.
    expect(c).not.toMatch(/\.(sourcePinned|targetOrgs|_srcCrownMoved)\s*=[^=]/);
    expect(c).not.toMatch(/\b(sourcePinned|targetOrgs|_srcCrownMoved)\s*:/);
    expect(c).not.toMatch(/delete [\w.]+\.(sourcePinned|targetOrgs|_srcCrownMoved)/);
  });

  it('the export strip list names every retired field', () => {
    const { bldProfileRuntimeFields } = extractFunctions('studio-builder.js', ['bldProfileRuntimeFields']);
    const f = bldProfileRuntimeFields();
    for (const k of ['targetOrgs', 'sourcePinned', '_srcCrownMoved', '_ringOf', 'ringScans', 'ephemeral']) expect(f).toContain(k);
  });

  it('source and target are two plain selects; a new deployment defaults to the preferred source', () => {
    expect(BUILDER).toMatch(/<select id="dsProfileSrcOrg"/);
    expect(BUILDER).toMatch(/<select id="dsProfileTgtOrg"/);
    expect(BUILDER).toMatch(/sourceOrg: \(typeof currentSourceOrg === 'function' \? currentSourceOrg\(\)/);
    expect(BUILDER).not.toMatch(/data-bld-tgt|dsBldTgtMode|dsBldPromoteSrc|dsBldSrcUnlock|dsBldSrcMovedAck/);
  });
});

describe('the model in studio-core.js', () => {
  it('profileTargets returns only the default target, never itself', () => {
    const { profileTargets } = extractFunctions('studio-core.js', ['_orgKey', 'profileTargets'],
      { 'sftk-org-identity.js': ['sftkOrgKey'] });
    const A = 'https://a.my.salesforce.com', B = 'https://b.my.salesforce.com';
    expect(profileTargets({ sourceOrg: A, targetOrg: B, targetOrgs: [A, B, 'https://c.my.salesforce.com'] })).toEqual([B]);
    expect(profileTargets({ sourceOrg: A, targetOrg: A })).toEqual([]);
    expect(profileTargets(null)).toEqual([]);
  });

  it('sftkRingView is derived from sftkOpenOrgs, never persisted', () => {
    const i = CORE.indexOf('function sftkRingView()');
    expect(i).toBeGreaterThan(-1);
    const fn = CORE.slice(i, CORE.indexOf('\n}', i) + 2);
    expect(fn).toContain('sftkOpenOrgs()');
    expect(fn).not.toMatch(/chrome\.storage/);
  });

  it('the nav and palette call the page "All open orgs" but keep the view key', () => {
    expect(CORE).toMatch(/label: 'All open orgs',\s+view: 'ring'/);
    expect(HTML).toMatch(/data-view="ring"[\s\S]{0,300}All open orgs/);
  });
});

describe('the All open orgs page (studio-ring.js)', () => {
  it('has a source select over the open orgs with NOTHING pre-selected when the preferred source is not open', () => {
    expect(RING).toMatch(/<select id="dsRingSrc"/);
    expect(RING).toContain('function _ringActiveSource()');
    // the active source is '' unless the preferred source is among the open orgs…
    expect(RING).toMatch(/open\.some\(o => _orgKey\(o\.url\) === _orgKey\(src\)\) \? src : ''/);
    // …and then only the placeholder is selected, no org option carries `selected`.
    expect(RING).toContain(`\${src ? '' : '<option value="" selected disabled>— pick the source —</option>'}`);
    expect(RING).toMatch(/\$\{src && _orgKey\(o\.url\) === _orgKey\(src\) \? 'selected' : ''\}/);
  });

  it('changing the source goes through dsSetPreferredSource and nothing else', () => {
    expect(RING).toMatch(/dsRingSrc'\)\?\.addEventListener\('change'[^]{0,200}?await dsSetPreferredSource\(url\)/);
  });

  it('fewer than two open orgs: says so and stops', () => {
    expect(RING).toContain('Open at least two orgs in Chrome');
    expect(RING).toMatch(/if \(open\.length >= 2\) _ringRenderMatrix\(\)/);
  });

  it('the columns are the other open orgs', () => {
    const i = RING.indexOf('function _ringTargets()');
    const fn = RING.slice(i, RING.indexOf('\n}', i) + 2);
    expect(fn).toContain('sftkOpenOrgs()');
    expect(fn).toContain('_ringActiveSource()');
  });

  it('⚖ sets the pair on the SAVED deployment and opens Transfer on it: no ring_ clone', () => {
    const i = RING.indexOf('async function _ringOpenReconcile(');
    const fn = RING.slice(i, RING.indexOf('\n}', i) + 2);
    expect(fn).toContain('p.sourceOrg = src;');
    expect(fn).toContain('p.targetOrg = tgtUrl;');
    expect(fn).toContain('delete p.sourcePinned; delete p.targetOrgs; delete p._srcCrownMoved;');
    expect(fn).toContain('await storageSaveProfiles()');
    expect(fn).toContain('window.openReconcile(p.id);');
    expect(fn).not.toMatch(/ring_|_ringOf|ephemeral/);
  });

  it('the membership panel, scheduled drift panel and crown helpers are gone', () => {
    const c = code(RING);
    expect(c).not.toMatch(/ds-ring-cfg|ds-ring-cb|dsRingSched|dsRingProbeNow|_ringRenderSchedPanel|dsRingAdoptWp|dsRingRestoreCrown/);
    expect(c).not.toMatch(/chrome\.storage\.local\.(set|get)\([^)]*ds_ring/);
  });
});

describe('no crown / "source of truth" wording in what the user reads', () => {
  for (const [name, text] of [['studio-ring.js', RING], ['studio-builder.js', BUILDER], ['studio-profiles.js', PROFILES], ['studio.html', HTML]]) {
    it(`${name} shows no 👑, "source of truth" or "Sync Ring"`, () => {
      const c = code(text);
      expect(c).not.toContain('👑');
      expect(c).not.toMatch(/source of truth/i);
      expect(c).not.toMatch(/Sync Ring/);
    });
  }

  it('the deployment card shows source → target plainly, with the last-used title', () => {
    expect(PROFILES).toContain('title="last used pair — pick any open orgs on the Deploy page"');
    expect(code(PROFILES)).not.toMatch(/ds-profile-sot-diff|ring targets/);
  });
});

describe('step 4 — no pair clone: opening a deployment against another target moves its pair', () => {
  const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
  it('openReconcile never clones (`pair_`) and never shows a target chooser', () => {
    const i = RC.indexOf('window.openReconcile = function(profileId, targetUrl) {');
    const fn = RC.slice(i, RC.indexOf('\n};\n', i));
    expect(fn).not.toContain('pair_${Date.now()}');
    expect(fn).not.toContain('showModal(');
    expect(fn).toContain("if (targetUrl && _orgKey(targetUrl) !== _orgKey(p.targetOrg || '')) {");
    expect(fn).toContain('p.targetOrg = targetUrl;');
    expect(fn).toContain('delete p.sourcePinned; delete p.targetOrgs; delete p._srcCrownMoved;');
    expect(fn).toContain('_reconcileProfile = p;');
    expect(fn).toContain("showToast('Source and target must be two different orgs.'");
  });
});
