// Loads sftk-sweep.js as a plain script (it sets globalThis.*) so the zip
// reader can run under Node's own DecompressionStream in the sweep test.
await import('../sftk-sweep.js');
export const sftkUnzip = globalThis.sftkUnzip;
