// ── Shared stored-ZIP builder (Metadata API deploys) ─────────────────────────
// One implementation for every module that zip-deploys metadata (Field
// Cleaner's layout/flow fixes, Flow Permissions' permission-set grants).
// Previously each module carried its own byte-identical copy — a bug fixed
// in one silently survived in the other.
//
// Produces a STORED (uncompressed) ZIP as base64 — exactly what the
// Metadata REST deployRequest endpoint accepts. files: [{ name, data }]
// where data is a Uint8Array or a string.

function sftkCrc32(bytes) {
  if (!sftkCrc32._t) {
    sftkCrc32._t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      sftkCrc32._t[i] = c;
    }
  }
  let c = 0xFFFFFFFF;
  for (const b of bytes) c = sftkCrc32._t[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function sftkBuildStoredZip(files) {
  const localBlocks = [], centralRecs = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const enc = new TextEncoder();

  for (const file of files) {
    const name = enc.encode(file.name);
    const data = file.data instanceof Uint8Array ? file.data : enc.encode(String(file.data));
    const crc  = sftkCrc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 0x0314, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    localBlocks.push(local);
    centralRecs.push(central);
    offset += local.length;
  }

  const centralSize = centralRecs.reduce((s, r) => s + r.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const zip = new Uint8Array(offset + centralSize + eocd.length);
  let pos = 0;
  for (const b of localBlocks) { zip.set(b, pos); pos += b.length; }
  for (const r of centralRecs) { zip.set(r, pos); pos += r.length; }
  zip.set(eocd, pos);

  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < zip.length; i += CHUNK) {
    binary += String.fromCharCode(...zip.subarray(i, Math.min(i + CHUNK, zip.length)));
  }
  return btoa(binary);
}

// Read a STORED (uncompressed) zip built by sftkBuildStoredZip back into
// { name: Uint8Array } — used by flow Restore to open our own backup zips
// (N1). Walks local file headers from offset 0; compressed entries (method
// !== 0) throw — we never produce them, and foreign zips aren't our format.
function sftkReadStoredZip(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = {};
  let pos = 0;
  while (pos + 30 <= u8.length && dv.getUint32(pos, true) === 0x04034b50) {
    const method  = dv.getUint16(pos + 8, true);
    const size    = dv.getUint32(pos + 18, true);
    const nameLen = dv.getUint16(pos + 26, true);
    const extraLen = dv.getUint16(pos + 28, true);
    const name = new TextDecoder().decode(u8.subarray(pos + 30, pos + 30 + nameLen));
    if (method !== 0) throw new Error(`zip entry "${name}" is compressed — not a Toolkit backup zip`);
    const dataStart = pos + 30 + nameLen + extraLen;
    out[name] = u8.subarray(dataStart, dataStart + size);
    pos = dataStart + size;
  }
  if (!Object.keys(out).length) throw new Error('no zip entries found — not a Toolkit backup zip');
  return out;
}

if (typeof window !== 'undefined') {
  window.sftkCrc32 = sftkCrc32;
  window.sftkBuildStoredZip = sftkBuildStoredZip;
  window.sftkReadStoredZip = sftkReadStoredZip;
}
