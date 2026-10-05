// Look inside a finished video: open it in headless Chrome, report its length
// and size, and save a PNG of the picture at each of the given seconds.
//   VIDEO=dist/video/walkthrough.mp4 AT=5,60,120 node scripts/dev/headless-studio.mjs scripts/dev/video/peek.mjs
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export default async function (h) {
  const file = resolve(process.env.VIDEO || 'dist/video/walkthrough.mp4');
  await h.cdp('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await h.navigate(pathToFileURL(file).href);
  await h.waitFor("document.querySelector('video') && document.querySelector('video').readyState >= 1", 30000);
  const meta = await h.eval(`(() => { const v = document.querySelector('video'); v.pause(); v.controls = false; v.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;background:#000'; return JSON.stringify({ duration: v.duration, w: v.videoWidth, h: v.videoHeight }); })()`);
  h.log('video:', file, meta);
  for (const s of String(process.env.AT || '3').split(',').map(Number).filter(n => n >= 0)) {
    await h.eval(`(async () => { const v = document.querySelector('video'); const p = new Promise(r => v.addEventListener('seeked', r, { once: true })); v.currentTime = ${s}; await p; return v.currentTime; })()`);
    await h.sleep(400);
    await h.shot(`${h.shots}/peek-${String(s).padStart(4, '0')}.png`);
  }
}
