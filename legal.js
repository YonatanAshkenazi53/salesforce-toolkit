// ── legal.html — renders EULA.md / PRIVACY.md / LICENSE as a real page ───────
// The gate used to link straight at the .md files. Chrome shows those raw,
// without a charset, so every "—" and "·" came out as mojibake and the page
// read like a source dump (user 2026-09-14). This page fetches the same
// shipped files and builds the DOM node by node: no innerHTML at all, which
// also keeps it inside the extension's Trusted Types policy.

// PURE. A small, strict markdown-to-blocks parser covering exactly what the
// three documents use: # / ## / ### headings, paragraphs, "- " lists,
// "1. " lists, "> " quotes, pipe tables, and inline **bold**, *em*, `code`,
// [text](url). Anything else is a paragraph of plain text — never HTML.
function sftkLegalParse(md) {
  const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [], list = null, quote = [], table = null;
  const flushPara = () => { if (para.length) { blocks.push({ type: 'p', text: para.join(' ') }); para = []; } };
  const flushList = () => { if (list) { blocks.push(list); list = null; } };
  const flushQuote = () => { if (quote.length) { blocks.push({ type: 'quote', text: quote.join(' ') }); quote = []; } };
  const flushTable = () => { if (table) { blocks.push(table); table = null; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); flushTable(); };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { flushAll(); continue; }
    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) { flushAll(); blocks.push({ type: 'h', level: m[1].length, text: m[2] }); continue; }
    if ((m = /^>\s?(.*)$/.exec(line))) { flushPara(); flushList(); flushTable(); quote.push(m[1]); continue; }
    if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) { flushPara(); flushQuote(); flushTable(); if (!list || list.ordered) { flushList(); list = { type: 'list', ordered: false, items: [] }; } list.items.push(m[1]); continue; }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { flushPara(); flushQuote(); flushTable(); if (!list || !list.ordered) { flushList(); list = { type: 'list', ordered: true, items: [] }; } list.items.push(m[1]); continue; }
    if (/^\|.*\|$/.test(line)) {
      flushPara(); flushList(); flushQuote();
      const cells = line.slice(1, -1).split('|').map(c => c.trim());
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;          // the header rule
      if (!table) table = { type: 'table', rows: [] };
      table.rows.push(cells); continue;
    }
    if (quote.length) { quote.push(line); continue; }                  // lazy quote continuation
    if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += ' ' + line.trim(); continue; }
    flushList(); flushQuote(); flushTable();
    para.push(line.trim());
  }
  flushAll();
  return blocks;
}

// PURE. Inline markdown → [{ t: 'text'|'b'|'i'|'code'|'a', s, href? }].
// Only http(s) links become links; anything else stays visible text.
function sftkLegalInline(text) {
  const out = [];
  const re = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0, m;
  const s = String(text == null ? '' : text);
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ t: 'text', s: s.slice(last, m.index) });
    if (m[2] !== undefined) out.push({ t: 'b', s: m[2] });
    else if (m[4] !== undefined) out.push({ t: 'i', s: m[4] });
    else if (m[6] !== undefined) out.push({ t: 'code', s: m[6] });
    else if (m[8] !== undefined) {
      const href = m[9];
      if (/^https?:\/\//i.test(href)) out.push({ t: 'a', s: m[8], href });
      else out.push({ t: 'text', s: `${m[8]} (${href})` });
    }
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ t: 'text', s: s.slice(last) });
  return out;
}

// DOM, node by node — no innerHTML.
function sftkLegalRender(host, blocks) {
  while (host.firstChild) host.removeChild(host.firstChild);
  const inline = (el, text) => {
    for (const part of sftkLegalInline(text)) {
      if (part.t === 'text') { el.appendChild(document.createTextNode(part.s)); continue; }
      const tag = part.t === 'b' ? 'strong' : part.t === 'i' ? 'em' : part.t === 'code' ? 'code' : 'a';
      const n = document.createElement(tag);
      n.textContent = part.s;
      if (part.t === 'a') { n.href = part.href; n.target = '_blank'; n.rel = 'noopener noreferrer'; }
      el.appendChild(n);
    }
  };
  for (const b of blocks) {
    if (b.type === 'h') { const h = document.createElement(`h${b.level}`); inline(h, b.text); host.appendChild(h); }
    else if (b.type === 'p') { const p = document.createElement('p'); inline(p, b.text); host.appendChild(p); }
    else if (b.type === 'quote') { const q = document.createElement('blockquote'); const p = document.createElement('p'); inline(p, b.text); q.appendChild(p); host.appendChild(q); }
    else if (b.type === 'list') {
      const l = document.createElement(b.ordered ? 'ol' : 'ul');
      for (const it of b.items) { const li = document.createElement('li'); inline(li, it); l.appendChild(li); }
      host.appendChild(l);
    } else if (b.type === 'table') {
      const t = document.createElement('table');
      b.rows.forEach((row, i) => {
        const tr = document.createElement('tr');
        for (const c of row) { const cell = document.createElement(i === 0 ? 'th' : 'td'); inline(cell, c); tr.appendChild(cell); }
        t.appendChild(tr);
      });
      host.appendChild(t);
    }
  }
}

const SFTK_LEGAL_DOCS = { eula: 'EULA.md', privacy: 'PRIVACY.md', license: 'LICENSE' };

async function sftkLegalBoot() {
  const host = document.getElementById('doc');
  if (!host) return;
  const key = (new URLSearchParams(location.search).get('doc') || 'eula').toLowerCase();
  const file = SFTK_LEGAL_DOCS[key] || SFTK_LEGAL_DOCS.eula;
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.doc === (SFTK_LEGAL_DOCS[key] ? key : 'eula')));
  try {
    const res = await fetch(file);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    sftkLegalRender(host, sftkLegalParse(text));
    const h = host.querySelector('h1');
    if (h) document.title = `${h.textContent} — Admin Toolkit for Salesforce`;
  } catch (e) {
    while (host.firstChild) host.removeChild(host.firstChild);
    const p = document.createElement('p');
    p.className = 'err';
    p.textContent = `This document could not be loaded (${e && e.message ? e.message : e}). It ships with the extension as ${file}.`;
    host.appendChild(p);
  }
}

if (typeof document !== 'undefined' && document.getElementById) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sftkLegalBoot);
  else sftkLegalBoot();
}
if (typeof globalThis !== 'undefined') {
  globalThis.sftkLegalParse = sftkLegalParse;
  globalThis.sftkLegalInline = sftkLegalInline;
}
