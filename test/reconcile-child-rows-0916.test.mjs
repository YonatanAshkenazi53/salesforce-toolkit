import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// 2026-09-16 — user: "On child records who are changed you can't open them
// and see their lookups" + "you can't see the field values because it's too
// small". Child changed rows get ▸ fields and 🔗 like the root; the compare
// opens in a wide modal for both.
const RC  = readFileSync(new URL('../studio-reconcile.js', import.meta.url), 'utf8');
const SC  = readFileSync(new URL('../studio-scan.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../studio.css', import.meta.url), 'utf8');

describe('the field compare opens wide, for root and child rows', () => {
  it('one shared opener, used by the root handler and the child handler', () => {
    expect(RC).toContain('async function sftkOpenDriftCompare(prof, obj, srcId, tgtId, srcFields, tgtFields, keyLabel, fallbackFields, editable)');   // 2026-10-27: editable from a Changed row
    const root = RC.slice(RC.indexOf("document.querySelectorAll('[data-rec-drift]')"), RC.indexOf("document.querySelectorAll('[data-recc-drift]')"));
    expect(root).toContain('sftkOpenDriftCompare(p, objType, srcId, tgtId,');
    const child = RC.slice(RC.indexOf("document.querySelectorAll('[data-recc-drift]')"), RC.indexOf("document.querySelectorAll('[data-recc-lkp]')"));
    expect(child).toContain('sftkOpenDriftCompare(v.prof, v.obj, srcId, tgtId,');
    expect(child).toContain('v.cs.compareFields || []');
  });
  it('the modal is wide and values wrap there; every value carries its full text on hover', () => {
    expect(CSS).toContain('.ds-modal-box:has(.ds-dc-modal-body) { max-width: 1100px;');
    expect(CSS).toContain('.ds-dc-modal-body .ds-dc-v { max-width: 46%; white-space: normal; word-break: break-word; }');
    expect(SC).toContain('class="ds-dc-v ds-dc-v-${side}" title="${esc(v)}"');
  });
  it('the opener wires the per-field push and repaints from live values', () => {
    const fn = RC.slice(RC.indexOf('async function sftkOpenDriftCompare('), RC.indexOf('function sftkLkpOvBucket('));
    expect(fn).toContain('sftkWireDriftCompare(body, prof, obj, srcId, tgtId, async () => {');
    expect(fn).toContain("if (!body.isConnected) return;");
  });
});

describe('child changed rows have ▸ fields and 🔗, driven by the child node', () => {
  it('the child drift row markup carries both controls and the lookup panel host', () => {
    const rows = RC.slice(RC.indexOf('const driftRows = (cs.changed || []).map(r => {'), RC.indexOf('const orphanN ='));
    expect(rows).toContain('data-recc-drift="${pathKey}" data-rec-pair="${esc(r.sourceId)}|${esc(r.targetId)}"');
    expect(rows).toContain('${lkpLinkC(pathKey, node, r.sourceId, r.targetId)}');
    expect(rows).toContain('data-lkp-expand-c="${pathKey}|${esc(r.sourceId)}"');
  });
  it('the child link counts the CHILD node\'s picks and the root handler leaves child links alone', () => {
    expect(RC).toContain('const n = Object.keys(sftkLkpOvGet(node, p.targetOrg, id)).length;');
    expect(RC).toContain("document.querySelectorAll('[data-rec-lkp]:not([data-recc-lkp])')");
  });
  it('the child view is rooted at the real node (not a clone), so picks persist with the profile', () => {
    expect(RC).toContain('prof: { ...p, tree: node, lastScan: cs }');
    expect(RC).toContain('renderLkpOverridePanel(v.prof, v.obj, srcId, expand, link.dataset.recLkpTgt || null);');
  });
  it('both child run clones hand the picks to the engine / overwrite', () => {
    expect(RC.split('lookupOverrides: a.node.lookupOverrides || {}').length - 1).toBe(1);   // cProfile; bProfile carries the scan's parent pairing too (2026-09-22)
    expect(RC).toContain('lookupOverrides: _att.overrides,');
  });
});
