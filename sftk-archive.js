// ── Run-history archive (IndexedDB) ──────────────────────────────────────
// chrome.storage.local is a ~10MB quota shared by EVERYTHING the toolkit
// persists, and history entries (failed-id retry lists, per-object detail)
// are the fattest thing in it — "we can hit limits there very fast" (user
// 2026-08-11). Runs that fall off the hot cap are ARCHIVED here instead of
// deleted: IndexedDB is on-disk PC storage with a gigabytes-scale quota,
// needs no extension permission and no prompt, and — unlike a file in the
// Downloads folder — the History view can read it back and auto-display it.
// The hot tier (chrome.storage sftk_history) stays exactly as it was: the
// newest 100 runs, loaded synchronously at boot.
//
// Privacy contract: the user's retention setting means DELETE, not "keep a
// hidden copy" — sftkArchDeleteOlderThan runs alongside the hot-tier purge,
// and 🧹 Clear cached org data calls sftkArchClear. Counts-only mode strips
// entries BEFORE they are handed to sftkArchPut (same rows the hot tier
// stores).
'use strict';

// Pure: split a history list into { keep, overflow } at `cap` (default 100).
// Oldest entries overflow — the list is append-ordered, newest last.
function sftkHistorySplit(entries, cap) {
  const list = Array.isArray(entries) ? entries : [];
  const c = (typeof cap === 'number' && cap > 0) ? Math.floor(cap) : 100;
  if (list.length <= c) return { keep: list, overflow: [] };
  return { keep: list.slice(-c), overflow: list.slice(0, list.length - c) };
}

function _sftkArchOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('sftk_archive', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('runs')) {
        const st = db.createObjectStore('runs', { keyPath: 'id' });
        st.createIndex('startedAt', 'startedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function _sftkArchTx(mode, fn) {
  return _sftkArchOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('runs', mode);
    const out = fn(tx.objectStore('runs'));
    tx.oncomplete = () => { db.close(); resolve(out && out.result !== undefined ? out.result : out); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
    tx.onabort    = () => { db.close(); reject(tx.error); };
  }));
}

// Bulk archive. Entries without an id (very old runs predate genId stamping)
// get a synthetic, stable one so re-archiving the same entry overwrites
// instead of duplicating.
async function sftkArchPut(entries) {
  const list = (entries || []).filter(e => e && typeof e === 'object');
  if (!list.length) return 0;
  await _sftkArchTx('readwrite', st => {
    for (const e of list) {
      const rec = e.id ? e : { ...e, id: `arch_${e.startedAt || 'na'}_${e.profileName || 'run'}` };
      st.put(rec);
    }
  });
  return list.length;
}

async function sftkArchCount() {
  try { return await _sftkArchTx('readonly', st => st.count()); }
  catch (_) { return 0; }
}

// Newest-first page of archived runs strictly OLDER than `beforeStartedAt`
// (pass null for the first page). Cursor walks the startedAt index in 'prev'
// order so pagination is O(limit), not O(archive).
function sftkArchList(beforeStartedAt, limit) {
  const lim = (typeof limit === 'number' && limit > 0) ? limit : 50;
  return _sftkArchOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('runs', 'readonly');
    const idx = tx.objectStore('runs').index('startedAt');
    const range = beforeStartedAt ? IDBKeyRange.upperBound(beforeStartedAt, true) : null;
    const out = [];
    const cur = idx.openCursor(range, 'prev');
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c || out.length >= lim) { db.close(); resolve(out); return; }
      out.push(c.value);
      c.continue();
    };
    cur.onerror = () => { db.close(); reject(cur.error); };
  }));
}

// Retention purge — the user's "delete after N days" means the archive too.
async function sftkArchDeleteOlderThan(cutoffIso) {
  if (!cutoffIso) return 0;
  return _sftkArchOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('runs', 'readwrite');
    const idx = tx.objectStore('runs').index('startedAt');
    let n = 0;
    const cur = idx.openCursor(IDBKeyRange.upperBound(cutoffIso, true));
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return;
      c.delete(); n++;
      c.continue();
    };
    tx.oncomplete = () => { db.close(); resolve(n); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  }));
}

async function sftkArchClear() {
  try { await _sftkArchTx('readwrite', st => st.clear()); } catch (_) {}
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkHistorySplit        = sftkHistorySplit;
  globalThis.sftkArchPut             = sftkArchPut;
  globalThis.sftkArchCount           = sftkArchCount;
  globalThis.sftkArchList            = sftkArchList;
  globalThis.sftkArchDeleteOlderThan = sftkArchDeleteOlderThan;
  globalThis.sftkArchClear           = sftkArchClear;
}
