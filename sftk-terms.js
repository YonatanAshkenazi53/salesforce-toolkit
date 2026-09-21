'use strict';
// ═════════════════════════════════════════════════════════════════════════
// sftk-terms.js — the acceptance gate.
// ═════════════════════════════════════════════════════════════════════════
// User request 2026-08-26: "maybe we need the user to approve the usage of
// the tool is his own responsibility, if they accept, they can use it. if
// not, than they can't."
//
// This tool deletes records, hard-deletes past the Recycle Bin, overwrites
// fields and files across several orgs at once, and deploys metadata that
// changes how Flows behave. The person driving it has to have agreed, once,
// that those consequences are theirs. Since the extension is free there is
// no purchase contract to carry that agreement — this gate IS the
// agreement, so it must actually BLOCK rather than nag.
//
// What is recorded is deliberately minimal: the version accepted and when.
// No name, no email, no identifier, nothing transmitted — recording more
// than consent would itself be a privacy problem (see PRIVACY.md).
//
// Classic script, top-level column-0 pure functions (test/extract.mjs).

// Bump ONLY when EULA.md changes materially. Every bump re-gates every
// user, so a typo fix must not touch it.
//   v2 (2026-09-03): the acceptance statement now says outright that ANY
//   consequence of using BOTH the Toolkit and Data Studio, and every one of
//   their components, is the user's responsibility (user request).
function sftkTermsVersion() { return 2; }

// The storage key. One place, because three pages read it.
function sftkTermsKey() { return 'sftk_terms_accepted'; }

// Does this user have to accept right now? PURE — the caller supplies what
// storage held. Anything unreadable, malformed, or from a NEWER version
// than this build knows about means "ask again": the only safe direction to
// fail is toward asking, never toward assuming consent.
// stored: { version, acceptedAt } | undefined
function sftkTermsNeedsAccept(stored, currentVersion) {
  const want = Number(currentVersion);
  if (!Number.isFinite(want)) return { needed: true, reason: 'no terms version to check against' };
  if (!stored || typeof stored !== 'object') return { needed: true, reason: 'first run' };
  const have = Number(stored.version);
  if (!Number.isFinite(have)) return { needed: true, reason: 'the stored acceptance is unreadable' };
  if (!stored.acceptedAt) return { needed: true, reason: 'the stored acceptance has no date' };
  if (have < want) return { needed: true, reason: 'the terms changed since you accepted' };
  return { needed: false, reason: `accepted version ${have} on ${stored.acceptedAt}` };
}

// The record to store. PURE so the shape can be asserted, and so the
// timestamp is the caller's to supply rather than a hidden clock read.
function sftkTermsRecord(version, nowIso) {
  return { version: Number(version), acceptedAt: String(nowIso || '') };
}

// The headline points the gate must show. Kept here, in one list, so the
// dialog cannot drift away from what EULA.md section 3 actually says.
function sftkTermsPoints() {
  return [
    { icon: '🧩', text: 'This agreement covers <strong>both the Toolkit and Data Studio, and every one of their components</strong> — Field Cleaner, the flow tools, deployments, Reconcile, the Org Seeder, the debugger, everything. <strong>Any consequence of using any of it is your responsibility</strong>, not the author’s.' },
    { icon: '🗑', text: 'This tool can <strong>delete every record</strong> of an object you select, in every org you select — and can purge them past the Recycle Bin, where nothing can recover them.' },
    { icon: '✍', text: 'It can <strong>overwrite</strong> data, files and configuration in several orgs at once, and <strong>deploy metadata</strong> — Flows, Layouts, Lightning pages, permission sets, Custom Metadata, Custom Labels — which can change how your orgs behave.' },
    { icon: '💾', text: 'You are responsible for having your <strong>own verified backups</strong> before you run anything destructive. This is not a backup tool.' },
    { icon: '🎯', text: 'You choose the target orgs. Selecting a <strong>production</strong> org and confirming is your decision.' },
    { icon: '🎭', text: 'PII masking is <strong>pseudonymisation, not anonymisation</strong>. Whether you may copy personal data between orgs is your call, under the law that applies to you.' },
    { icon: '⚖', text: 'The software is provided <strong>“as is”, with no warranty</strong>, and our liability is limited. It is not affiliated with Salesforce, Inc.' },
  ];
}

// ── The gate itself ───────────────────────────────────────────────────
// Not pure: reads storage, paints DOM. Resolves TRUE only when the user
// has accepted. On decline it leaves the page blocked — "if not, then they
// can't" (user 2026-08-26) — with a way back, because a misclick should
// not brick the extension.
//
// Styling is entirely inline: this has to render identically on three
// pages with different stylesheets, and it must still work if a stylesheet
// failed to load. innerHTML flows through the Trusted Types policy that
// trusted-types-policy.js installs, so no sink is bypassed here.
function sftkTermsEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sftkTermsGate() {
  const key = sftkTermsKey();
  let stored;
  try {
    const r = await chrome.storage.local.get(key);
    stored = r && r[key];
  } catch (_) {
    // Storage unreadable — ask again rather than assume consent.
    stored = undefined;
  }
  const verdict = sftkTermsNeedsAccept(stored, sftkTermsVersion());
  if (!verdict.needed) return true;

  return new Promise(resolve => {
    const host = document.createElement('div');
    host.id = 'sftkTermsGate';
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-labelledby', 'sftkTermsTitle');
    host.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'background:rgba(10,12,16,.72)', 'backdrop-filter:blur(3px)',
      'display:flex', 'align-items:center', 'justify-content:center',
      'padding:16px', 'overflow:auto',
      'font-family:system-ui,-apple-system,"Segoe UI",sans-serif',
    ].join(';');

    const eulaUrl = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
      ? chrome.runtime.getURL('legal.html?doc=eula') : 'legal.html?doc=eula';
    const privUrl = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
      ? chrome.runtime.getURL('legal.html?doc=privacy') : 'legal.html?doc=privacy';

    const changed = /terms changed/.test(verdict.reason);
    host.innerHTML = `
      <div style="background:#fff;color:#181818;max-width:620px;width:100%;border-radius:10px;
                  box-shadow:0 18px 50px rgba(0,0,0,.4);padding:20px 22px;max-height:92vh;overflow:auto">
        <div id="sftkTermsTitle" style="font-size:17px;font-weight:700;margin-bottom:4px">
          ${changed ? 'The terms have changed' : 'Before you use Admin Toolkit for Salesforce'}
        </div>
        <div style="font-size:12.5px;opacity:.75;margin-bottom:12px">
          ${changed
            ? 'The agreement now states outright that any consequence of using both the Toolkit and Data Studio, and every one of their components, is your responsibility. Please read and accept the updated agreement to continue.'
            : 'This tool can permanently change and delete data in your Salesforce orgs. Please read this before you start.'}
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:1.45">
          ${sftkTermsPoints().map(p => `
            <div style="display:flex;gap:9px;align-items:flex-start">
              <span style="flex:0 0 auto;font-size:14px;line-height:1.3">${p.icon}</span>
              <span>${p.text}</span>
            </div>`).join('')}
        </div>
        <div style="margin-top:14px;padding:10px 12px;background:#f4f6f9;border-radius:6px;font-size:12.5px">
          Full terms: <a href="${sftkTermsEsc(eulaUrl)}" target="_blank" rel="noopener" style="color:#0b5cab">End User Licence Agreement</a>
          &nbsp;·&nbsp; <a href="${sftkTermsEsc(privUrl)}" target="_blank" rel="noopener" style="color:#0b5cab">Privacy</a>
        </div>
        <label style="display:flex;gap:8px;align-items:flex-start;margin-top:14px;font-size:13px;cursor:pointer">
          <input type="checkbox" id="sftkTermsCb" style="margin-top:3px;flex:0 0 auto">
          <span>I have read and accept the End User Licence Agreement. <strong>I confirm that any consequence of
          using Admin Toolkit for Salesforce — both the Toolkit and Data Studio, and every one of their
          components — is my responsibility, not the author’s</strong>: my data, my metadata, my backups, and
          every org I run it against, including production.</span>
        </label>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap">
          <button id="sftkTermsNo" style="padding:7px 14px;border:1px solid #c9cdd3;background:#fff;
            border-radius:5px;font-size:13px;cursor:pointer">Decline</button>
          <button id="sftkTermsYes" disabled style="padding:7px 16px;border:1px solid #0b5cab;
            background:#0b5cab;color:#fff;border-radius:5px;font-size:13px;cursor:pointer;opacity:.5">
            Accept and continue</button>
        </div>
      </div>`;
    document.body.appendChild(host);

    const cb = host.querySelector('#sftkTermsCb');
    const yes = host.querySelector('#sftkTermsYes');
    const no = host.querySelector('#sftkTermsNo');
    // The button stays dead until the box is ticked: an "Accept" that can be
    // clicked without reading is not much of a record of consent.
    cb.addEventListener('change', () => {
      yes.disabled = !cb.checked;
      yes.style.opacity = cb.checked ? '1' : '.5';
    });
    cb.focus();

    yes.addEventListener('click', async () => {
      yes.disabled = true;
      try {
        await chrome.storage.local.set({
          [key]: sftkTermsRecord(sftkTermsVersion(), new Date().toISOString()),
        });
      } catch (_) {
        // Could not record it. Let them through for THIS session — refusing
        // to run because storage is broken helps nobody — but say so, so the
        // repeat prompt next launch is not a mystery.
        alert('Your acceptance could not be saved, so you will be asked again next time.');
      }
      host.remove();
      resolve(true);
    });

    no.addEventListener('click', () => {
      host.innerHTML = `
        <div style="background:#fff;color:#181818;max-width:460px;width:100%;border-radius:10px;
                    box-shadow:0 18px 50px rgba(0,0,0,.4);padding:22px">
          <div style="font-size:16px;font-weight:700;margin-bottom:6px">Not accepted</div>
          <div style="font-size:13px;line-height:1.5">
            Admin Toolkit for Salesforce cannot be used without accepting the licence agreement.
            Nothing has been changed in any of your orgs.
          </div>
          <div style="font-size:12.5px;opacity:.75;margin-top:10px">
            You can close this window, or read the terms again if you declined by mistake.
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
            <button id="sftkTermsAgain" style="padding:7px 14px;border:1px solid #0b5cab;background:#fff;
              color:#0b5cab;border-radius:5px;font-size:13px;cursor:pointer">Read the terms again</button>
          </div>
        </div>`;
      host.querySelector('#sftkTermsAgain').addEventListener('click', () => {
        host.remove();
        sftkTermsGate().then(resolve);
      });
      // Deliberately NOT resolved here. A promise settles once: a
      // resolve(false) now would make "Read the terms again → Accept"
      // resolve into nothing, leaving the page blocked after a real
      // acceptance (audit 2026-09-12). Declining leaves the boot awaiting;
      // the re-shown gate is the only way forward.
    });
  });
}

// ── Read the terms again (read-only) ─────────────────────────────────
// The gate shows once; this shows the SAME points and links any time,
// with what was accepted and when, and only a Close button — nothing is
// re-recorded (user 2026-09-03: "i want to read what it say").
async function sftkTermsShow() {
  if (document.getElementById('sftkTermsView')) return;
  let stored = null;
  try { const r = await chrome.storage.local.get(sftkTermsKey()); stored = r && r[sftkTermsKey()]; } catch (_) { stored = null; }
  const eulaUrl = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
    ? chrome.runtime.getURL('legal.html?doc=eula') : 'legal.html?doc=eula';
  const privUrl = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
    ? chrome.runtime.getURL('legal.html?doc=privacy') : 'legal.html?doc=privacy';
  const accepted = stored && stored.acceptedAt
    ? `You accepted version ${sftkTermsEsc(stored.version)} on ${sftkTermsEsc(new Date(stored.acceptedAt).toLocaleString())}.`
    : 'No acceptance is recorded on this browser yet — the agreement will be shown before the next start.';
  const host = document.createElement('div');
  host.id = 'sftkTermsView';
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'true');
  host.setAttribute('aria-labelledby', 'sftkTermsViewTitle');
  host.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483646',
    'background:rgba(10,12,16,.6)', 'display:flex', 'align-items:center', 'justify-content:center',
    'padding:16px', 'overflow:auto', 'font-family:system-ui,-apple-system,"Segoe UI",sans-serif',
  ].join(';');
  host.innerHTML = `
    <div style="background:#fff;color:#181818;max-width:620px;width:100%;border-radius:10px;
                box-shadow:0 18px 50px rgba(0,0,0,.4);padding:20px 22px;max-height:92vh;overflow:auto">
      <div id="sftkTermsViewTitle" style="font-size:17px;font-weight:700;margin-bottom:4px">Licence agreement &amp; privacy</div>
      <div style="font-size:12.5px;opacity:.75;margin-bottom:12px">${accepted}</div>
      <div style="display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:1.45">
        ${sftkTermsPoints().map(p => `
          <div style="display:flex;gap:9px;align-items:flex-start">
            <span style="flex:0 0 auto;font-size:14px;line-height:1.3">${p.icon}</span>
            <span>${p.text}</span>
          </div>`).join('')}
      </div>
      <div style="margin-top:14px;padding:10px 12px;background:#f4f6f9;border-radius:6px;font-size:12.5px">
        Full text: <a href="${sftkTermsEsc(eulaUrl)}" target="_blank" rel="noopener" style="color:#0b5cab">End User Licence Agreement</a>
        &nbsp;·&nbsp; <a href="${sftkTermsEsc(privUrl)}" target="_blank" rel="noopener" style="color:#0b5cab">Privacy</a>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button id="sftkTermsViewClose" style="padding:7px 16px;border:1px solid #0b5cab;background:#0b5cab;color:#fff;
          border-radius:5px;font-size:13px;cursor:pointer">Close</button>
      </div>
    </div>`;
  document.body.appendChild(host);
  const close = () => host.remove();
  host.querySelector('#sftkTermsViewClose').addEventListener('click', close);
  host.addEventListener('click', e => { if (e.target === host) close(); });
  host.querySelector('#sftkTermsViewClose').focus();
}

// A page that carries a #sftkTermsBtn (the popup's top bar) gets it wired
// here, so no other file has to know this module exists.
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.getElementById('sftkTermsBtn');
    if (b) b.addEventListener('click', () => { sftkTermsShow(); });
  });
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkTermsVersion     = sftkTermsVersion;
  globalThis.sftkTermsKey         = sftkTermsKey;
  globalThis.sftkTermsNeedsAccept = sftkTermsNeedsAccept;
  globalThis.sftkTermsRecord      = sftkTermsRecord;
  globalThis.sftkTermsPoints      = sftkTermsPoints;
  globalThis.sftkTermsEsc         = sftkTermsEsc;
  globalThis.sftkTermsShow = sftkTermsShow;
  globalThis.sftkTermsGate        = sftkTermsGate;
}
