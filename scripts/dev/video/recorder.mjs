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
import { speakOne, voiceSeconds } from './voice.mjs';

export function makeRecorder(h, dir, opts = {}) {
  const state = { dir, framesDir: join(dir, 'frames'), t0: 0, frames: [], cues: [], chapters: [], fast: [], pages: [], on: false, n: 0, names: opts.names || [], sized: false };
  const voiceDir = dir;   // the voice files live beside the sections (compose.mjs looks there too)
  const now = () => Date.now() - state.t0;
  const J = JSON.stringify;

  h.onEvent(m => {
    if (m.method !== 'Page.screencastFrame') return;
    // always acknowledge, or Chrome stops sending
    h.cdp('Page.screencastFrameAck', { sessionId: m.params.sessionId }, m.sessionId).catch(() => {});
    if (!state.on || m.sessionId !== h.session) return;
    const i = ++state.n;
    const file = String(i).padStart(6, '0') + '.jpg';
    // The frame's time is the browser's own capture time (metadata.timestamp, seconds since
    // the epoch), not the moment this handler ran: while a sentence was being synthesised the
    // handler could run seconds late, and every frame of that stretch was stamped late — the
    // picture then lagged the voice (user 2026-10-10: "the voice is not in sync").
    const ts = m.params.metadata && Number(m.params.metadata.timestamp);
    let t = now();
    if (Number.isFinite(ts) && ts > 1e9) { const cand = Math.round(ts * 1000 - state.t0); if (cand >= -2000 && cand <= t + 2000) t = Math.max(0, cand); }
    try { writeFileSync(join(state.framesDir, file), Buffer.from(m.params.data, 'base64')); state.frames.push({ f: file, t }); } catch (_) { /* a lost frame is a held frame */ }
  });

  const rec = {
    dir, state,
    // One recording = one folder (frames/ + manifest.json). The walkthrough makes
    // one per SECTION, so a single section can be recorded again on its own and
    // the composer joins whatever folders are there (order.json).
    async begin(toDir) {
      state.dir = toDir || dir; state.framesDir = join(state.dir, 'frames');
      try { rmSync(state.dir, { recursive: true, force: true }); } catch (_) {}
      mkdirSync(state.framesDir, { recursive: true });
      state.frames = []; state.cues = []; state.chapters = []; state.fast = []; state.pages = []; state.n = 0;
      if (!state.sized) {
        // 1600×727 CSS px drawn at 1.2× = 1920×872 real pixels: the composer's page area under
        // its browser frame (88 px), with no resampling
        const vp = opts.viewport || { width: 1600, height: 727, scale: 1.2 };
        try { await h.cdp('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.scale, mobile: false }); state.sized = true; } catch (e) { h.log('viewport override failed:', e.message); }
      }
      state.t0 = Date.now(); state.on = true;
      await rec.resume();
    },
    // after every navigation: the screencast and the page-side helpers belong to a document
    async resume() {
      // a screencast only delivers frames of the tab in front; an org login opens its own tab, so come back first
      try { await h.cdp('Page.bringToFront'); } catch (_) {}
      try { await h.cdp('Page.startScreencast', { format: 'jpeg', quality: 88, everyNthFrame: 2 }); } catch (_) {}
      await rec.mask();
      await rec.page();
    },
    // the address and title the composer's browser frame shows from now on — noted
    // whenever they changed (a view change inside the page moves the hash)
    async page() {
      try {
        const p = JSON.parse(await h.eval(`JSON.stringify({ url: location.href, title: document.title })`));
        const last = state.pages[state.pages.length - 1];
        if (!last || last.url !== p.url || last.title !== p.title) state.pages.push({ t: now(), ...p });
      } catch (_) {}
    },
    async end(extra) {
      state.on = false;
      try { await h.cdp('Page.stopScreencast'); } catch (_) {}
      const manifest = { length: now(), frames: state.frames, cues: state.cues, chapters: state.chapters, fast: state.fast, pages: state.pages, ...(extra || {}) };
      writeFileSync(join(state.dir, 'manifest.json'), J(manifest));
      h.log(`recording: ${state.frames.length} frames, ${(manifest.length / 1000).toFixed(0)} s, ${state.cues.length} captions → ${state.dir}`);
      return manifest;
    },
    start() { return rec.begin(dir); },
    stop() { return rec.end(); },
    // ── what the viewer reads ──
    // A caption, and the picture holds at least as long as the sentence takes to
    // say (user 2026-10-09: "feature show on the screen in sync with the voice and
    // subtitles"): the sentence is spoken now (voice.mjs, cached by text), its length
    // read, and only then does the script go on. A longer holdMs still wins.
    async say(text, holdMs = 0) {
      await rec.remask(); await rec.page();
      state.cues.push({ t: now(), text: String(text) }); h.log('SAY:', text);
      let hold = holdMs;
      if (opts.voice !== false && String(text).trim()) {
        try { const f = await speakOne(voiceDir, String(text)); if (f) hold = Math.max(hold, Math.round(voiceSeconds(f) * 1000) + 350); }
        catch (e) { h.log('voice while recording:', (e && e.message) || e); }
      }
      if (hold) await h.sleep(hold);
    },
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
      await rec.page();
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
    // A picture of ANOTHER tab (a log opened in a new tab), put into the recording as
    // one frame: the screencast only ever shows the tab in front.
    async frameFrom(sessionId, holdMs = 0) {
      try {
        await rec.maskIn(sessionId); await h.sleep(300);
        const r = await h.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88 }, sessionId);
        const i = ++state.n, file = String(i).padStart(6, '0') + '.jpg';
        writeFileSync(join(state.framesDir, file), Buffer.from(r.data, 'base64')); state.frames.push({ f: file, t: now() });
      } catch (e) { h.log('frameFrom:', (e && e.message) || e); }
      if (holdMs) await h.sleep(holdMs);
    },
    // Show ALL of a dialog or a page (user 2026-10-09: "if we need to scroll down, make
    // the scroll"): the scrollable box inside (or around) sel is scrolled to its end
    // in steps a viewer can follow. Returns false when nothing needed scrolling.
    async reveal(sel = null, step = 230, ms = 420) {
      const extra = await h.eval(`(() => {
        document.querySelectorAll('[data-sftk-reveal]').forEach(e => e.removeAttribute('data-sftk-reveal'));
        const root = ${sel ? `document.querySelector(${J(sel)})` : 'null'};
        const can = el => { if (!el || el.nodeType !== 1) return false; if (el === document.scrollingElement) return el.scrollHeight > el.clientHeight + 12;
          const cs = getComputedStyle(el); return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 12; };
        const cands = [];
        if (root) { cands.push(...root.querySelectorAll('*')); cands.push(root); let p = root.parentElement; while (p) { cands.push(p); p = p.parentElement; } }
        cands.push(document.scrollingElement);
        const el = cands.find(can); if (!el) return 0;
        el.setAttribute('data-sftk-reveal', '1'); el.scrollTop = 0;
        return el.scrollHeight - el.clientHeight; })()`);
      if (!extra) return false;
      await h.sleep(500);
      for (let i = 0; i < 60; i++) {
        const atEnd = await h.eval(`(() => { const el = document.querySelector('[data-sftk-reveal]'); if (!el) return true; el.scrollTop += ${step}; return el.scrollTop + el.clientHeight >= el.scrollHeight - 2; })()`);
        await h.sleep(ms);
        if (atEnd) break;
      }
      await h.sleep(600);
      await h.eval(`(() => { document.querySelectorAll('[data-sftk-reveal]').forEach(e => e.removeAttribute('data-sftk-reveal')); return 1; })()`);
      return true;
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
    // the mask again, now: a field that was typed into shows its real value until
    // it loses focus (the walk skips the active element), so the focus is dropped first
    async remask() {
      try { await h.eval(`(() => { if (document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) document.activeElement.blur(); if (window.__sftkDemoWalk) window.__sftkDemoWalk(); return true; })()`); } catch (_) {}
    },
    maskSource() {
      return `(() => {
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
          window.__sftkDemoWalk = () => walk(document.documentElement);
          walk(document.documentElement);
          return true; })()`;
    },
    async mask() {
      try { await h.eval(rec.maskSource()); } catch (_) { /* a page that cannot be scripted shows nothing of the tool anyway */ }
    },
    // the same mask inside another tab (a Salesforce record page, before its picture is taken)
    async maskIn(sessionId) {
      try { await h.cdp('Runtime.evaluate', { expression: rec.maskSource(), returnByValue: true }, sessionId); } catch (_) {}
    },
  };
  return rec;
}
