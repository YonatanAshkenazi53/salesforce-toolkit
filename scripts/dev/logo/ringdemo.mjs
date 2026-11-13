import { readFileSync, writeFileSync } from 'node:fs';
const src = readFileSync('debug-logger.js', 'utf8');
const i = src.indexOf('window.sftkRagdollRing = function');
const j = src.indexOf('window.sftkCatSvg = function', i);
const window = {};
eval(src.slice(i, j));
const ring = s => window.sftkRagdollRing(s);
const row = (cls, name) => `<section class="${cls}"><h2>${name}</h2><div class="row">${[340, 118, 63].map(s => `<figure>${ring(s)}<figcaption>${s}px</figcaption></figure>`).join('')}
  <div class="box">${ring(118)}<p>Comparing every flow’s pinned API version with this org’s release…</p><div class="bar"><i></i></div><small>2 of 4 · estimating…</small></div></div></section>`;
writeFileSync('docs/logo/ragdoll-loader.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ragdoll loader</title>
<style>
body{margin:0;font-family:system-ui,Segoe UI,sans-serif}
section{padding:22px 28px 30px}.light{background:#f3f4f7;color:#1c2330}.dark{background:#16181d;color:#e8eaee}
h2{font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;opacity:.6;margin:0 0 14px}
.row{display:flex;gap:34px;align-items:center;flex-wrap:wrap}figure{margin:0;text-align:center}figcaption{font-size:11px;opacity:.55;margin-top:6px}
.box{margin-left:24px;text-align:center;max-width:420px}.box p{font-weight:600;font-size:14px;margin:10px 0 12px}.box small{opacity:.6}
.bar{height:6px;border-radius:3px;background:rgba(128,128,128,.25);overflow:hidden;margin-bottom:8px}.bar i{display:block;height:100%;width:50%;background:#1b96ff;border-radius:3px}
.sftk-cat{display:inline-block}
.sftk-cat-ringcat .sftk-cat-ring{animation:sftk-cat-chase 1.7s cubic-bezier(.72,0,.28,1) infinite;transform-origin:32px 32px}
@keyframes sftk-cat-chase{from{transform:rotate(0deg)}to{transform:rotate(-360deg)}}
.sftk-cat-ringcat .sftk-cat-tail{animation:sftk-cat-tail 1.7s linear infinite}
@keyframes sftk-cat-tail{0%{stroke-dasharray:14.0 151}4%{stroke-dasharray:14.0 151}8%{stroke-dasharray:14.3 151}12%{stroke-dasharray:15.1 151}16%{stroke-dasharray:16.8 151}20%{stroke-dasharray:19.8 151}24%{stroke-dasharray:24.4 151}28%{stroke-dasharray:30.4 151}32%{stroke-dasharray:37.6 151}36%{stroke-dasharray:45.1 151}40%{stroke-dasharray:51.5 151}44%{stroke-dasharray:55.5 151}48%{stroke-dasharray:55.1 151}52%{stroke-dasharray:51.8 151}56%{stroke-dasharray:47.5 151}60%{stroke-dasharray:42.8 151}64%{stroke-dasharray:38.1 151}68%{stroke-dasharray:33.4 151}72%{stroke-dasharray:29.1 151}76%{stroke-dasharray:25.2 151}80%{stroke-dasharray:21.8 151}84%{stroke-dasharray:19.0 151}88%{stroke-dasharray:16.8 151}92%{stroke-dasharray:15.2 151}96%{stroke-dasharray:14.3 151}100%{stroke-dasharray:14.0 151}}
@media (prefers-reduced-motion:reduce){.sftk-cat-ringcat .sftk-cat-ring{animation:none}}
</style></head><body>${row('light', 'Light theme')}${row('dark', 'Dark theme')}</body></html>`);
