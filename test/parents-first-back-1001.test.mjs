// Parents-first step: "‹ Back to <origin>" must always go somewhere.
// User 2026-10-01: "when i click back to account. nothing occurs" — the origin
// was an unsaved pair clone (🚀 Deploy with a non-primary target), not in
// _profiles, so the id lookup found nothing and the click was a no-op.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const DV = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const RC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const BU = readFileSync(new URL('../studio-builder.js', import.meta.url), 'utf8');
const PR = readFileSync(new URL('../studio-profiles.js', import.meta.url), 'utf8');
// source slices (these functions touch page globals, so no materializing)
const src = (file, name) => {
  const i = file.indexOf(`function ${name}(`);
  if (i < 0) return '';
  const j = file.indexOf('\n}\n', i);
  return file.slice(i, j + 3);
};

describe('parents-first: the way back exists for an unsaved origin', () => {
  it('both creators keep the origin object when it is ephemeral', () => {
    const re = /_parentOf: \{ profileId: p\.id, objType: [^}]*\.\.\.\(p\.ephemeral \? \{ profile: p \} : \{\}\) \}/;
    expect(RC).toMatch(re);
    expect(BU).toMatch(re);
  });
  it('the Deploy page resolves the origin by id, then by the kept object', () => {
    const fn = src(DV, '_depOrigin');
    expect(fn).toContain('_profiles.find(x => x.id === id)');
    expect(fn).toContain('p._parentOf.profile');
  });
  it('both Back buttons use the one resolver and never end in a no-op', () => {
    expect(DV).toMatch(/eid\('dsDepJourneyBack'\)\?\.addEventListener\('click', \(\) => _depGoOrigin\(p\)\)/);
    expect(DV).toMatch(/eid\('dsDepBackOrigin'\)\?\.addEventListener\('click', \(\) => _depGoOrigin\(p\)\)/);
    const go = src(DV, '_depGoOrigin');
    expect(go).toContain('window.openReconcile(orig.id)');             // saved origin
    expect(go).toContain('_reconcileProfile = orig');                   // unsaved origin, its scan kept
    expect(go).toContain("_currentView = 'profiles'; renderProfiles()"); // gone → the list
    expect(DV).not.toMatch(/if \(orig\) window\.openReconcile\(orig\.id\);\s*\}\);/);
  });
  it('the header Back link uses the same resolver', () => {
    expect(DV).toContain('const origin = _depOrigin(p);');
  });
  it('saving a parents-first step strips the kept origin object', () => {
    const at = PR.indexOf('window.saveEphemeralProfile');
    expect(PR.slice(at, at + 800)).toContain('delete p._parentOf.profile');
  });
});
