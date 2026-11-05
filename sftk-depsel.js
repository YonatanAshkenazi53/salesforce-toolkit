'use strict';
// ✓ The Deploy page remembers what you ticked (2026-11-05, a colleague's first
// day with the tool: "I had ticked some 40 records from a ticket, remembered a
// parent was missing, went to the parent and deployed it, came back to the
// children — and all my ticks were gone").
//
// The ticks live in Sets the engine reads (_recSel / _recChildSel, studio-
// reconcile.js); every scan starts them from zero because a scan moves records
// between lists. This module packs them to plain ids per deployment and target
// org, and after the next scan puts back every tick whose record is STILL in
// the list it was ticked in — a record now in the target, or gone, is dropped
// and counted, never guessed back in. The page keeps the packed form in memory
// always and on disk unless counts-only mode is on (no record ids on disk).
//
// Pure: Sets and plain objects in, the same out. No DOM, no storage.

// The kinds of tick (the Sets' names), and the list each kind is made in with
// the id it carries. A function, not constants: the test extractor slices
// top-level functions, and a free constant would not travel with them.
function sftkDepSelKinds() {
  return {
    root: ['push', 'overwrite', 'updSrc', 'del', 'pull'],
    child: ['push', 'relink', 'overwrite', 'del'],
    from: {
      push: ['missingInTarget', 'sourceId'], overwrite: ['changed', 'sourceId'], updSrc: ['changed', 'sourceId'],
      del: ['onlyInTarget', 'targetId'], pull: ['onlyInTarget', 'targetId'], relink: ['linkMismatch', 'targetId'],
    },
  };
}

// One memory per deployment AND target org: the same deployment pointed at
// another org has its own ticks (the ids would not even exist there).
function sftkDepSelKey(profileId, targetOrgUrl) {
  const org = (typeof sftkOrgKey === 'function') ? sftkOrgKey(String(targetOrgUrl || '')) : String(targetOrgUrl || '');
  return `${profileId}|${org}`;
}

function sftkDepSelPack(recSel, childSel, savedAt) {
  const arr = s => (s instanceof Set) ? [...s] : Array.isArray(s) ? [...s] : [];
  const root = {};
  for (const k of sftkDepSelKinds().root) { const a = arr(recSel && recSel[k]); if (a.length) root[k] = a; }
  const children = {};
  for (const [path, sel] of Object.entries(childSel || {})) {
    const o = {};
    for (const k of sftkDepSelKinds().child) { const a = arr(sel && sel[k]); if (a.length) o[k] = a; }
    if (Object.keys(o).length) children[path] = o;
  }
  const packed = { root, children, savedAt: savedAt || Date.now() };
  packed.n = sftkDepSelCount(packed);
  return packed;
}

function sftkDepSelCount(packed) {
  if (!packed) return 0;
  let n = 0;
  for (const k of sftkDepSelKinds().root) n += ((packed.root || {})[k] || []).length;
  for (const o of Object.values(packed.children || {})) for (const k of sftkDepSelKinds().child) n += (o[k] || []).length;
  return n;
}

function sftkDepSelEmpty(recSel, childSel) {
  return sftkDepSelCount(sftkDepSelPack(recSel, childSel, 0)) === 0;
}

// Put the packed ticks back onto a scan. A tick comes back only when its record
// is still in the list it was ticked in; a child list counts only when it was
// read for THIS scan (status success, rootRunAt === scan.runAt) — a child not
// read yet is neither kept nor dropped: its path is returned under `unread`,
// for the page to try again once that child is scanned.
//   opts.root      false → leave the root alone (default true)
//   opts.children  an array of child paths to restore (default: every saved child)
//   → { recSel, childSel, kept, dropped, unread: [path] }
function sftkDepSelRestore(packed, scan, opts) {
  const o = opts || {};
  const recSel = { push: new Set(), overwrite: new Set(), updSrc: new Set(), del: new Set(), pull: new Set() };
  const childSel = {};
  let kept = 0, dropped = 0;
  const unread = [];
  if (!packed || !scan) return { recSel, childSel, kept, dropped, unread };
  const idsIn = (list, bucket, idField) => new Set(((list && Array.isArray(list[bucket])) ? list[bucket] : []).map(r => r && r[idField]).filter(Boolean));
  const take = (ids, list, k, into) => {
    if (!ids || !ids.length) return;
    const [bucket, idField] = sftkDepSelKinds().from[k];
    const have = idsIn(list, bucket, idField);
    for (const id of ids) { if (have.has(id)) { into.add(id); kept++; } else dropped++; }
  };
  if (o.root !== false) for (const k of sftkDepSelKinds().root) take((packed.root || {})[k], scan, k, recSel[k]);
  // a record cannot be both overwritten and used to update the source; the saved form never holds both, but a hand-edited one could
  for (const id of recSel.updSrc) if (recSel.overwrite.has(id)) recSel.updSrc.delete(id);
  for (const id of recSel.pull) if (recSel.del.has(id)) recSel.pull.delete(id);
  const want = Array.isArray(o.children) ? o.children : Object.keys(packed.children || {});
  for (const path of want) {
    const saved = (packed.children || {})[path];
    if (!saved) continue;
    const cs = scan.children && scan.children[path];
    const live = (cs && cs.status === 'success' && cs.rootRunAt === scan.runAt) ? cs : null;
    if (!live) { unread.push(path); continue; }
    const sel = { push: new Set(), relink: new Set(), overwrite: new Set(), del: new Set() };
    for (const k of sftkDepSelKinds().child) take(saved[k], live, k, sel[k]);
    if (sftkDepSelKinds().child.some(k => sel[k].size)) childSel[path] = sel;
  }
  return { recSel, childSel, kept, dropped, unread };
}

// The sentence on the page after a restore. Nothing to say when nothing was saved.
function sftkDepSelLine(kept, dropped) {
  if (!kept && !dropped) return '';
  const t = n => `${n.toLocaleString()} tick${n === 1 ? '' : 's'}`;
  const why = 'the records are no longer in the list they were ticked in (written since, or changed)';
  if (!dropped) return `✓ Your ${t(kept)} from before ${kept === 1 ? 'is' : 'are'} back.`;
  if (!kept) return `Your ${t(dropped)} from before ${dropped === 1 ? 'was' : 'were'} dropped — ${why}.`;
  return `✓ Your ${t(kept)} from before ${kept === 1 ? 'is' : 'are'} back · ${dropped.toLocaleString()} dropped — ${why}.`;
}

// The disk store: { key: packed }, the newest `max` deployments kept. An empty
// selection is a deliberate "nothing ticked" and is stored as such.
function sftkDepSelStorePut(store, key, packed, max) {
  const out = { ...(store && typeof store === 'object' ? store : {}) };
  out[key] = packed;
  const keys = Object.keys(out).sort((a, b) => ((out[b] && out[b].savedAt) || 0) - ((out[a] && out[a].savedAt) || 0));
  for (const k of keys.slice(max || 30)) delete out[k];
  return out;
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkDepSelKinds = sftkDepSelKinds;
  globalThis.sftkDepSelKey = sftkDepSelKey;
  globalThis.sftkDepSelPack = sftkDepSelPack;
  globalThis.sftkDepSelCount = sftkDepSelCount;
  globalThis.sftkDepSelEmpty = sftkDepSelEmpty;
  globalThis.sftkDepSelRestore = sftkDepSelRestore;
  globalThis.sftkDepSelLine = sftkDepSelLine;
  globalThis.sftkDepSelStorePut = sftkDepSelStorePut;
}
