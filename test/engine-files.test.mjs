// W9 — FILES (ContentVersion) planner. The IO layer follows existing engine
// patterns and is flag-gated (no UI sets node.includeFiles yet); the LOGIC
// lives in the pure planner and is fully specified here: checksum
// idempotence per record, size ceiling with disclosure, link fan-out with
// first-publish + explicit extras, out-of-scope links counted never dropped.
import { describe, it, expect } from 'vitest';
import { extractFunctions } from './extract.mjs';

const eng = extractFunctions('background.js', ['sftkFilePlan', 'sftkB64FromBuffer']);

const file = (over) => Object.assign({
  verId: 'V1', docId: 'D1', title: 'spec.pdf', pathOnClient: 'spec.pdf',
  checksum: 'md5aaa', size: 1024, linkedTo: ['S1'],
}, over || {});
const IDMAP = { S1: 'T1', S2: 'T2', S3: 'T3' };

describe('sftkFilePlan — what the files pass will do', () => {
  it('creates on the mapped record with FirstPublishLocationId', () => {
    const plan = eng.sftkFilePlan([file()], {}, IDMAP, {});
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0].firstPublishTo).toBe('T1');
    expect(plan.creates[0].extraLinkTo).toEqual([]);
  });

  it('IDEMPOTENT: a record already holding the same checksum is skipped', () => {
    const plan = eng.sftkFilePlan([file()], { T1: ['md5aaa'] }, IDMAP, {});
    expect(plan.creates).toHaveLength(0);
    expect(plan.skippedExisting).toBe(1);
  });

  it('same title but DIFFERENT bytes (checksum) is copied — content wins over name', () => {
    const plan = eng.sftkFilePlan([file({ checksum: 'md5bbb' })], { T1: ['md5aaa'] }, IDMAP, {});
    expect(plan.creates).toHaveLength(1);
  });

  it('multi-link fan-out: first mapped record gets FirstPublish, the rest explicit links', () => {
    const plan = eng.sftkFilePlan([file({ linkedTo: ['S1', 'S2', 'S3'] })], {}, IDMAP, {});
    expect(plan.creates[0].firstPublishTo).toBe('T1');
    expect(plan.creates[0].extraLinkTo).toEqual(['T2', 'T3']);
  });

  it('partial idempotence: only the records LACKING the file get it', () => {
    const plan = eng.sftkFilePlan([file({ linkedTo: ['S1', 'S2'] })], { T1: ['md5aaa'] }, IDMAP, {});
    expect(plan.creates[0].firstPublishTo).toBe('T2');
    expect(plan.creates[0].extraLinkTo).toEqual([]);
  });

  it('size ceiling: oversized files are skipped WITH title+size, never silently', () => {
    const plan = eng.sftkFilePlan([file({ size: 99 * 1024 * 1024 })], {}, IDMAP, {});
    expect(plan.creates).toHaveLength(0);
    expect(plan.skippedSize).toEqual([{ title: 'spec.pdf', size: 99 * 1024 * 1024 }]);
  });

  it('links to records outside the run are COUNTED, and a file with no in-scope link is dropped', () => {
    const plan = eng.sftkFilePlan([file({ linkedTo: ['S_OUTSIDE'] })], {}, IDMAP, {});
    expect(plan.creates).toHaveLength(0);
    expect(plan.unmappedLinks).toBe(1);
  });

  it('tolerates garbage input', () => {
    expect(eng.sftkFilePlan(null, null, null, null).creates).toEqual([]);
    expect(eng.sftkFilePlan([{}, null], {}, {}, {}).creates).toEqual([]);
  });
});

describe('sftkB64FromBuffer — chunked encoder', () => {
  it('round-trips bytes (small)', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    expect(atob(eng.sftkB64FromBuffer(bytes.buffer)).split('').map(c => c.charCodeAt(0)))
      .toEqual([0, 1, 2, 250, 251, 255]);
  });
  it('survives buffers larger than one 32KB chunk', () => {
    const big = new Uint8Array(0x8000 * 2 + 17).map((_, i) => i % 256);
    const decoded = atob(eng.sftkB64FromBuffer(big.buffer));
    expect(decoded.length).toBe(big.length);
    expect(decoded.charCodeAt(0x8000 * 2 + 16)).toBe((0x8000 * 2 + 16) % 256);
  });
});
