// QA 1.1 finding 44: the dry run is started with the same duplicate-rule choice as the real run (per object).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const DEP = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const REC = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const { sftkDepProbeOpts: opts } = extractFunctions('studio-deploy.js', ['sftkDepProbeOpts']);

describe('the dry run carries the duplicate-rule choice of the real run', () => {
  it('probe mode, the names a real run would pause, and the per-object bypass', () => {
    const paused = { rules: [], flows: [], rulesOn: true, flowsOn: true };
    const dupe = { objects: ['Contact'], rules: [{ label: 'Contact dupes', object: 'Contact' }], kept: ['Account dupes (Account)'] };
    expect(opts(paused, dupe)).toEqual({ probe: true, probePaused: paused, dupePause: dupe });
  });
  it('Respect (no choice) stays no choice', () => {
    expect(opts(null, null)).toEqual({ probe: true, probePaused: null, dupePause: null });
    expect(opts(null, undefined).dupePause).toBeNull();
  });
  it('the button builds it from the same function the real run uses, over the same written objects', () => {
    expect(DEP).toContain("eid('dsRecProbeBtn')?.addEventListener('click', () => runReconcile(p, objType,");
    expect(DEP).toContain('_depProbeOpts(p)));');
    const i = DEP.indexOf('function _depProbeOpts(p) {');
    const fn = DEP.slice(i, DEP.indexOf('\n}\n', i));
    expect(fn).toContain('const written = sftkDeployWrittenObjects(sftkDeployObjects(p.tree), _recSel, _recChildSel);');
    expect(fn).toContain('return sftkDepProbeOpts(_depProbePaused(p), _depDupePauseOpts(p, written));');
    // the real run
    expect(DEP).toContain('const dupePause = _depDupePauseOpts(p, writtenF);');
  });
  it('the engine profile of a dry run gets the objects, and a dry run asks its own confirmation only', () => {
    expect(REC).toContain('if (_dp && Array.isArray(_dp.objects)) pushProfile.dupBypassObjects = _dp.objects;');
    expect(REC).toContain('if (_dp && Array.isArray(_dp.objects)) bProfile.dupBypassObjects = _dp.objects;');
    // the confirmation that lists the bypass is the real run's branch — after the dry run's own
    expect(REC.indexOf('if (PROBE) {')).toBeLessThan(REC.indexOf('} else if (delIds.length || pullIds.length || updSrcIds.length || anyChildAct || capWarnLines.length || _fp || _vp || _dp) {'));
  });
});
