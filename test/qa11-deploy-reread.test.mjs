// QA 1.1 finding 55: a failed read of the automation lists is tried again when the page is drawn again (Rescan).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const DEP = readFileSync(new URL('../studio-deploy.js', import.meta.url), 'utf8');
const { sftkDepPauseNeedsRead: needs } = extractFunctions('studio-deploy.js', ['sftkDepPauseNeedsRead']);
const key = 'https://t.my.salesforce.com|Account,Contact';

describe('when the page reads an automation list from the org', () => {
  it('never read, or another target / object set: read', () => {
    expect(needs({ on: false, key: '', list: null, error: '' }, key)).toBe(true);
    expect(needs({ on: true, key: 'https://other|Account', list: { rules: [] }, error: '' }, key)).toBe(true);
    expect(needs(null, key)).toBe(true);
  });
  it('read and listed: only painted', () => {
    expect(needs({ on: true, key, list: { rules: [] }, error: '' }, key)).toBe(false);
  });
  it('a read in flight is not started twice', () => {
    expect(needs({ on: true, key, list: null, error: '' }, key)).toBe(false);
  });
  it('the last read failed: read again', () => {
    expect(needs({ on: true, key, list: null, error: 'Target is not open in a Chrome tab' }, key)).toBe(true);
  });
});

describe('the three lists use it', () => {
  it('flows, validation rules and duplicate rules', () => {
    expect(DEP).toContain('if (sftkDepPauseNeedsRead(_depFlowPause, key)) load(); else paint();');
    expect(DEP).toContain('if (sftkDepPauseNeedsRead(_depRulePause, key)) load(); else paint();');
    expect(DEP).toContain('if (!sftkDepPauseNeedsRead(_depDupePause, key)) { _depPausePaint(p); return; }');
  });
  it('a new read starts clean, so the error line goes when the read succeeds', () => {
    expect(DEP).toContain("_depFlowPause = { on: true, all: !!(box && box.checked), key, list: null, error: '' };");
    expect(DEP).toContain("_depRulePause = { on: true, all: !!(box && box.checked), key, list: null, error: '' };");
    expect(DEP).toContain("_depDupePause = { on: true, key, list: null, error: '' };");
  });
  it('Rescan draws the page again, which is what the line on the panel promises', () => {
    const i = DEP.indexOf('function _depRescan(');
    expect(i).toBeGreaterThan(-1);
    expect(DEP.slice(i, DEP.indexOf('\n}\n', i))).toContain('renderDeploy(');
    expect(DEP).toContain('press 🔄 Rescan to read them again.');
  });
});
