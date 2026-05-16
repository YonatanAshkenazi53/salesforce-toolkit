// ============================================================
// Encrypted Credential Vault — Data Studio
//
// Encrypts stored org passwords at rest with AES-256-GCM, using a key
// derived from a user passphrase via PBKDF2. The passphrase is never
// stored — a small "verifier" blob proves it's correct on unlock. The
// derived key lives in memory only and is cleared on lock / tab close.
//
//   SFTKVault.init()                  — load vault metadata from storage
//   SFTKVault.isEnabled()             — has the user set up a vault?
//   SFTKVault.isUnlocked()            — is the key in memory this session?
//   SFTKVault.setup(passphrase)       — first-time: create + unlock
//   SFTKVault.unlock(passphrase)      — derive key, verify passphrase
//   SFTKVault.lock()                  — clear the key from memory
//   SFTKVault.encrypt(plaintext)      — → base64 blob (iv + ciphertext)
//   SFTKVault.decrypt(blob)           — → plaintext (throws if locked/bad)
//   SFTKVault.disable(passphrase)     — verify + remove the vault
//   SFTKVault.changePassphrase(o, n)  — re-key (caller re-encrypts secrets)
//
// Self-contained — no dependency on either app's code.
// ============================================================
(function () {
  'use strict';
  if (window.SFTKVault) return; // singleton

  const META_KEY   = 'ds_vault_meta';   // { enabled, salt, verifier, iterations, createdAt }
  const ITERATIONS = 210000;            // PBKDF2 rounds (OWASP-aligned)
  const VERIFIER   = 'SFTK-VAULT-VERIFIER-v1';

  let _meta = null;   // vault metadata (loaded from storage)
  let _key  = null;   // CryptoKey — held in memory only while unlocked

  // ── base64 <-> ArrayBuffer ────────────────────────────────
  function abToB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64ToBytes(b64) {
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
  }

  // ── Key derivation ────────────────────────────────────────
  async function _deriveKey(passphrase, saltBytes) {
    const baseKey = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: ITERATIONS, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']);
  }

  // ── AES-GCM with a given key ──────────────────────────────
  async function _encWithKey(key, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
    const out = new Uint8Array(iv.length + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), iv.length);
    return abToB64(out.buffer);
  }
  async function _decWithKey(key, blob) {
    const all = b64ToBytes(blob);
    const iv  = all.slice(0, 12);
    const ct  = all.slice(12);
    const pt  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  }

  // ── Public API ────────────────────────────────────────────
  async function init() {
    try {
      const d = await chrome.storage.local.get(META_KEY);
      _meta = d[META_KEY] || null;
    } catch (_) { _meta = null; }
    return _meta;
  }

  function isEnabled()  { return !!(_meta && _meta.enabled); }
  function isUnlocked() { return !!_key; }

  // First-time setup — creates the vault and leaves it unlocked.
  async function setup(passphrase) {
    if (!passphrase || passphrase.length < 6) {
      throw new Error('Passphrase must be at least 6 characters.');
    }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key  = await _deriveKey(passphrase, salt);
    const verifier = await _encWithKey(key, VERIFIER);
    _meta = {
      enabled: true,
      salt: abToB64(salt.buffer),
      verifier,
      iterations: ITERATIONS,
      createdAt: new Date().toISOString()
    };
    _key = key;
    await chrome.storage.local.set({ [META_KEY]: _meta });
  }

  // Unlock — derives the key and checks it against the stored verifier.
  async function unlock(passphrase) {
    if (!_meta || !_meta.enabled) throw new Error('Vault is not set up.');
    const key = await _deriveKey(passphrase, b64ToBytes(_meta.salt));
    let ok = false;
    try { ok = (await _decWithKey(key, _meta.verifier)) === VERIFIER; }
    catch (_) { ok = false; }
    if (!ok) throw new Error('Incorrect passphrase.');
    _key = key;
  }

  function lock() { _key = null; }

  async function encrypt(plaintext) {
    if (!_key) throw new Error('Vault is locked.');
    if (plaintext == null || plaintext === '') return plaintext;
    return _encWithKey(_key, String(plaintext));
  }
  async function decrypt(blob) {
    if (!_key) throw new Error('Vault is locked.');
    if (blob == null || blob === '') return blob;
    return _decWithKey(_key, blob);
  }

  // Disable — verifies the passphrase, then removes the vault metadata.
  // The caller must first decrypt all stored secrets back to plaintext.
  async function disable(passphrase) {
    await unlock(passphrase); // throws on wrong passphrase
    _meta = null;
    _key  = null;
    await chrome.storage.local.remove(META_KEY);
  }

  // Change passphrase — re-keys the vault. The caller must re-save (and thus
  // re-encrypt) all stored secrets afterwards, since encrypt() now uses the
  // new key.
  async function changePassphrase(oldPass, newPass) {
    await unlock(oldPass); // throws on wrong old passphrase
    if (!newPass || newPass.length < 6) {
      throw new Error('New passphrase must be at least 6 characters.');
    }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key  = await _deriveKey(newPass, salt);
    const verifier = await _encWithKey(key, VERIFIER);
    _meta = { ..._meta, salt: abToB64(salt.buffer), verifier, iterations: ITERATIONS };
    _key  = key;
    await chrome.storage.local.set({ [META_KEY]: _meta });
  }

  window.SFTKVault = {
    init, isEnabled, isUnlocked, setup, unlock, lock,
    encrypt, decrypt, disable, changePassphrase,
  };
})();
