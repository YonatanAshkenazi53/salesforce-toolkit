// The walkthrough recorder — helpers for a harness script (headless-studio.mjs).
//
// What it records: the page's own screencast (DevTools Page.startScreencast,
// JPEG frames with their times), the captions the script speaks (rec.say),
// the chapters (rec.chapter) and the stretches that are only waiting
// (rec.fast) so the composer can play them faster. Everything lands in one
// folder: frames/000001.jpg … and manifest.json. compose.mjs turns that into
// an MP4 with the captions burned in, using Chrome's own encoder — nothing is
// downloaded or installed.
//
// Privacy: rec.mask() rewrites e-mail addresses (and any names passed in) in
// the page before they are drawn, so the recording never shows them. It
// touches the DISPLAY only, in this throwaway headless profile.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export function makeRecorder(h, dir, opts = {}) {
  const framesDir = join(dir, 'frames');
  const state = { t0: 0, frames: [], cues: [], chapters: [], fast: [], on: false, n: 0, names: opts.names || [] };
  const now = () => Date.now() - state.t0;
  const J = JSON.stringify;

  h.onEvent(m => {
    if (m.method !== 'Page.screencastFrame') return;
    // always acknowledge, or Chrome stops sending
    h.cdp('Page.screencastFrameAck', { sessionId: m.params.sessionId }, m.sessionId).catch(() => {});
    if (!state.on || m.sessionId !== h.session) return;
    const i = ++state.n;
    const file = String(i).padStart(6, '0') + '.jpg';
    try { writeFileSync(join(framesDir, file), Buffer.from(m.params.data, 'base64')); state.frames.push({ f: file, t: now() }); } catch (_) { /* a lost frame is a held frame */ }
  });

  const rec = {
    dir, state,
    async start() {
      try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      mkdirSync(framesDir, { recursive: true });
      // 1600×800 CSS px drawn at 1.2× = 1920×960 real pixels: the composer's page area, with no resampling
      const vp = opts.viewport || { width: 1600, height: 800, scale: 1.2 };
      try { await h.cdp('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.scale, mobile: false }); } catch (e) { h.log('viewport override failed:', e.message); }
      state.t0 = Date.now(); state.on = true;
      await rec.resume();
    },
    // after every navigation: the screencast and the page-side helpers belong to a document
    async resume() {
      // a screencast only delivers frames of the tab in front; an org login opens its own tab, so come back first
      try { await h.cdp('Page.bringToFront'); } catch (_) {}
      try { await h.cdp('Page.startScreencast', { format: 'jpeg', quality: 88, everyNthFrame: 2 }); } catch (_) {}
      await rec.mask();
    },
    async stop() {
      state.on = false;
      try { await h.cdp('Page.stopScreencast'); } catch (_) {}
      const manifest = { length: now(), frames: state.frames, cues: state.cues, chapters: state.chapters, fast: state.fast, viewport: opts.viewport || null };
      writeFileSync(join(dir, 'manifest.json'), J(manifest));
      h.log(`recording: ${state.frames.length} frames, ${(manifest.length / 1000).toFixed(0)} s, ${state.cues.length} captions, ${state.chapters.length} chapters → ${dir}`);
      return manifest;
    },
    // ── what the viewer reads ──
    async say(text, holdMs = 0) { state.cues.push({ t: now(), text: String(text) }); h.log('SAY:', text); if (holdMs) await h.sleep(holdMs); },
    hush() { state.cues.push({ t: now(), text: '' }); },
    chapter(title) { state.chapters.push({ t: now(), title: String(title) }); h.log('CHAPTER:', title); },
    // a stretch that is only waiting (a scan, a login): played faster by the composer
    async fast(fn) { const a = now(); try { return await fn(); } finally { const b = now(); if (b - a > 1500) state.fast.push({ a, b }); } },
    async pause(ms) { await h.sleep(ms); },

    // ── what the viewer sees happen ──
    // a ring around the element, so a click is visible in a recording without a mouse pointer
    async point(sel, ms = 900) {
      const ok = await h.eval(`(() => {
        const el = (typeof ${J(sel)} === 'string') ? document.querySelector(${J(sel)}) : null; if (!el) return false;
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        const r = el.getBoundingClientRect();
        const d = document.createElement('div');
        d.setAttribute('data-sftk-demo-ring', '1');
        d.style.cssText = 'position:fixed;left:' + (r.left - 6) + 'px;top:' + (r.top - 6) + 'px;width:' + (r.width + 12) + 'px;height:' + (r.height + 12) + 'px;border:3px solid #ff2d78;border-radius:10px;box-shadow:0 0 0 6px rgba(255,45,120,.22);z-index:2147483647;pointer-events:none;transition:opacity .25s';
        document.body.appendChild(d);
        setTimeout(() => { d.style.opacity = '0'; }, ${Math.max(200, ms - 250)});
        setTimeout(() => d.remove(), ${ms + 100});
        return true; })()`);
      if (ok) await h.sleep(ms);
      return ok;
    },
    async click(sel, after = 700) {
      const ok = await rec.point(sel, 800);
      if (!ok) { h.log('demo click: no element for', sel); return false; }
      await h.eval(`(() => { const el = document.querySelector(${J(sel)}); if (el) el.click(); return !!el; })()`);
      await h.sleep(after);
      return true;
    },
    // type into an input the way a person would (the tool's own input handlers fire)
    async type(sel, text, perChar = 55) {
      await rec.point(sel, 600);
      await h.eval(`(() => { const i = document.querySelector(${J(sel)}); if (!i) return false; i.focus(); i.dispatchEvent(new Event('focus')); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      for (let k = 1; k <= text.length; k++) {
        await h.eval(`(() => { const i = document.querySelector(${J(sel)}); if (!i) return false; i.value = ${J(text.slice(0, k))}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await h.sleep(perChar);
      }
      await h.sleep(350);
    },
    async scrollTo(sel, block = 'start') {
      await h.eval(`(() => { const el = document.querySelector(${J(sel)}); if (el) el.scrollIntoView({ block: ${J(block)}, behavior: 'auto' }); return !!el; })()`);
      await h.sleep(900);
    },
    async scrollBy(sel, px) {
      await h.eval(`(() => { const el = ${sel ? `document.querySelector(${J(sel)})` : 'document.scrollingElement'}; if (el) el.scrollBy({ top: ${px}, behavior: 'auto' }); return !!el; })()`);
      await h.sleep(900);
    },

    // ── privacy: e-mail addresses and given names never reach a frame ──
    async mask() {
      try {
        await h.eval(`(() => {
          if (window.__sftkDemoMask) return true;
          const names = ${J(state.names.filter(Boolean))};
          const mail = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g;
          const fix = s => {
            let out = s.replace(mail, m => m[0].toLowerCase() + '•••@example.com');
            for (const [from, to] of names) if (from && out.includes(from)) out = out.split(from).join(to);
            return out;
          };
          const walk = root => {
            const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let n; while ((n = w.nextNode())) { const v = n.nodeValue; if (v && v.length > 3) { const f = fix(v); if (f !== v) n.nodeValue = f; } }
            if (root.querySelectorAll) for (const el of root.querySelectorAll('[title], input, option')) {
              const t = el.getAttribute && el.getAttribute('title'); if (t) { const f = fix(t); if (f !== t) el.setAttribute('title', f); }
              if (el.tagName === 'INPUT' && el.type !== 'password' && el.value && el !== document.activeElement) { const f = fix(el.value); if (f !== el.value) el.value = f; }
            }
          };
          let busy = false;
          const run = nodes => { if (busy) return; busy = true; try { for (const n of nodes) walk(n.nodeType === 3 ? n.parentNode || n : n); } finally { busy = false; } };
          window.__sftkDemoMask = new MutationObserver(ms => run(ms.map(m => m.type === 'characterData' ? m.target : m.target)));
          window.__sftkDemoMask.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
          walk(document.documentElement);
          return true; })()`);
      } catch (_) { /* a page that cannot be scripted shows nothing of the tool anyway */ }
    },
  };
  return rec;
}
