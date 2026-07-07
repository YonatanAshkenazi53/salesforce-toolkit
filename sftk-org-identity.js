// ── Shared org-identity key (popup + Data Studio + service worker) ───────────
// One org appears under several domain forms:
//   https://acme-dev.develop.my.salesforce.com
//   https://acme-dev.develop.lightning.force.com
//   https://acme-dev.develop.my.salesforce-setup.com
// Raw-string equality falsely treats these as different orgs. Everything that
// compares two org URLs MUST compare sftkOrgKey(a) === sftkOrgKey(b) instead.
//
// Loaded as a classic script in popup.html and studio.html (attaches to
// globalThis === window) and via importScripts() in background.js.

function sftkOrgKey(orgUrl) {
  if (!orgUrl) return '';
  let host;
  try { host = new URL(orgUrl).hostname; }
  catch { host = String(orgUrl).replace(/^https?:\/\//, '').replace(/\/.*$/, ''); }
  return host
    .replace(/\.my\.salesforce-setup\.com$/, '')
    .replace(/\.salesforce-setup\.com$/, '')
    .replace(/\.my\.salesforce\.com$/, '')
    .replace(/\.lightning\.force\.com$/, '')
    .replace(/\.my\.site\.com$/, '')
    .replace(/\.salesforce\.com$/, '')
    .replace(/\.force\.com$/, '')
    .toLowerCase();
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkOrgKey = sftkOrgKey;
}
