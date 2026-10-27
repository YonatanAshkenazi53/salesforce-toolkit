import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const DV = read('studio-deploy.js'), CSS = read('studio.css'), SEC = read('scripts/dev/video/sections.mjs');

// User 2026-10-21: "we do need to present dupes in both source and targets and offer to merge them.
// once they are merged and have no diff they should appear as synced". Needs a decision leads with
// the merge: every group shows its copies on both sides and a 🔀 Merge button per side that holds
// more than one, plus "Merge both sides"; the question (which record is which) stays under them
// for records that are different things with one name.
const groups = DV.slice(DV.indexOf('function _depAmbGroupsHtml('), DV.indexOf('// The deployment a parents-first step was opened FROM'));
const intro = DV.slice(DV.indexOf('function _depAmbIntro('), DV.indexOf('// The groups: one block per shared name'));
const flow = DV.slice(DV.indexOf('async function _depMergeCopies('), DV.indexOf('async function _depRescan('));
const wire = DV.slice(DV.indexOf("host.querySelectorAll('[data-dep-amb-merge]')"), DV.indexOf("host.querySelectorAll('[data-dep-amb-one]')"));

describe('the intro: merge first, then the question, and what a merge leads to', () => {
  it('says merge is the answer for copies, and where the pair lands after the re-read', () => {
    expect(intro).toContain('<b>Copies of the same record? Merge them.</b>');
    expect(intro).toContain('the pair is listed under 🟢 Synced when its values are equal, under 🟡 Changed when they still differ');
    expect(intro.indexOf('Copies of the same record? Merge them.')).toBeLessThan(intro.indexOf('Different records that share a name? Say which is which.'));
  });
  it('still says the answers never delete, and that a merge does, after its confirmation', () => {
    expect(intro).toContain('A merge deletes the copies it merges, after its own confirmation.');
    expect(intro).toContain('the copy that is left over is listed under 🔵 Only in ${tgtL}, where you can tick it for deletion.');
  });
});

// 2026-10-27 (user: "show the dupes in both orgs and offer to merge them"): the two orgs side by side, each
// column with its copies and its own merge button; "Merge both sides" between them; the question is a matrix.
describe('the group: the two orgs side by side, each with its copies and its merge button, the question below', () => {
  it('one button per side with copies, and both sides at once when both have them', () => {
    expect(groups).toMatch(/nSrc > 1 \? `<button[^`]*data-dep-amb-merge="src"[^`]*>🔀 Merge the \$\{nSrc\} copies in \$\{srcL\}<\/button>/);   // 2026-10-27: the same-record note may follow the button
    expect(groups).toMatch(/cands\.length > 1 \? `<button[^`]*data-dep-amb-merge="tgt"[^`]*>🔀 Merge the \$\{cands\.length\} copies in \$\{tgtL\}<\/button>/);
    expect(groups).toMatch(/nSrc > 1 && cands\.length > 1 \? `<div class="ds-amb-both"><button[^`]*data-dep-amb-merge="both"/);   // 2026-10-27: between the two columns
    expect(groups.match(/data-dep-amb-merge="/g).length).toBe(3);   // no second copy of a button on the side labels
    expect(groups).toContain('<div class="ds-amb-colfoot">${srcMerge}</div>');
    expect(groups).toContain('<div class="ds-amb-colfoot">${tgtMerge}</div>');
    expect(groups).toContain('<div class="ds-amb-cols">${srcCol}${tgtCol}</div>${bothMerge}');
    expect(groups.indexOf('${srcCol}${tgtCol}')).toBeLessThan(groups.indexOf('<div class="ds-amb-match">${matrix}</div>'));
    expect(groups).toContain("const oneRec = '<span class=\"ds-dep-muted\">one record — nothing to merge here</span>';");
  });
  it('copies that agree on every compared field are said to look like one record', () => {
    expect(groups).toContain("const noTell = tell => !(tell || []).some(x => x && x[1] !== '');");
    expect(groups).toContain('const sameTgt = cands.length > 1 && cands.every(t => noTell(candTell[t]));');
    expect(groups).toContain('const sameSrc = nSrc > 1 && rs.every(r => noTell(r.tell));');
    expect(groups).toContain('they agree on every compared field — they look like the same record</span>');
    expect(groups).toContain('${sameSrc ? sameNote : \'\'}');
    expect(groups).toContain('${sameTgt ? sameNote : \'\'}');
    expect(groups).toContain('they look like the same record; open them to be sure');
  });
  it('both sides are listed with their counts; the question stays on the source side', () => {
    expect(groups).toContain("<b>${tgtL}</b> <span class=\"ds-dep-muted\">target · ${cands.length} record${cands.length === 1 ? '' : 's'} of this name</span>");
    expect(groups).toContain("<b>${srcL}</b> <span class=\"ds-dep-muted\">source · ${nSrc} record${nSrc === 1 ? '' : 's'} of this name</span>");
    expect(groups).toContain('const question = `For each ${srcL} copy, say what it is in ${tgtL}:`;');
    // one sentence row per source copy: the copy, "is", a dropdown of sentences (2026-10-27: the grid was not understood)
    expect(groups).toContain('<span class="ds-amb-is">is</span>');
    expect(groups).toContain('<select class="ds-select ds-select-sm ds-amb-sel" data-dep-amb-sel="${esc(r.sourceId)}" aria-label="What this ${srcL} copy is in ${tgtL}">');
    expect(groups).toContain("{ v: '__new__', text: `a new record — not in ${orgLabel(p.targetOrg)} yet, create it there` }");
    expect(groups).toContain("{ v: '', text: 'not decided yet — it stays out of the deployment' }");
    expect(groups).toContain('data-dep-amb-sel="${esc(r.sourceId)}"');
  });
});

describe('the merge reports how it went; both sides run one after the other with one re-read', () => {
  it('_depMergeCopies: null when nothing was written, true/false after the run; the re-read can be left to the caller', () => {
    expect(flow).toContain('async function _depMergeCopies(p, side, name, ids, opts = {})');
    expect(flow).toContain('if (!choice) return null;');
    expect(flow).toContain('if (!ok) return null;');
    expect(flow).not.toMatch(/return showToast\(/);
    expect(flow).toContain('if (opts.rescan !== false) await _depRescan(p);');
    expect(flow).toContain('return !!(res && res.ok);');
  });
  it('"both": the source copies first, a cancelled first merge stops, then the target copies, then one re-read', () => {
    expect(wire).toContain("if (side !== 'both') return _depMergeCopies(p, side, name, side === 'src' ? srcIds : tgtIds);");
    expect(wire).toContain("const a = await _depMergeCopies(p, 'src', name, srcIds, { rescan: false });");
    expect(wire).toContain('if (a === null) return;');
    expect(wire).toContain("await _depMergeCopies(p, 'tgt', name, tgtIds, { rescan: false });");
    expect(wire.indexOf("'tgt', name, tgtIds")).toBeLessThan(wire.indexOf('await _depRescan(p);'));
    expect(wire.match(/await _depRescan\(p\);/g).length).toBe(1);
  });
});

describe('styles and the video', () => {
  it('the merge bar is styled', () => {
    expect(CSS).toContain('.ds-amb-mergebar {');
    expect(CSS).toContain('.ds-amb-mergebar .ds-amb-merge { margin-left: 0; }');
  });
  it('the deploy chapter says it in that order', () => {
    expect(SEC).toContain('Copies of the same record? Merge them. Different records? You say which is which, one name at a time.');
  });
});
