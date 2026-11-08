'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// sftk-emailtpl.js — a field's places in an email template, and the three ways
// Field Cleaner has with them (user 2026-11-08: "why here we can't do anything?
// i want also email alerts, lightning email templates and classic email
// templates").
// ═══════════════════════════════════════════════════════════════════════════
// Every kind of template is ONE EmailTemplate record whose text lives in four
// updateable fields: Subject and Body (classic text), HtmlValue (classic HTML
// and Lightning — "{{{Account.X__c}}}"), Markup (Visualforce —
// "{!relatedTo.X__c}"). A merge field names the field as a whole word, bare or
// after an object or relation, so one whole-word search serves them all.
//   ⇄ Replace  — the field's API name renamed inside every merge field
//   ✂ Remove   — every merge field that names the field taken out of the text
//   ✎ Edit     — the fields as text boxes (field-cleaner.js)
// Pure: records in, records out — the PATCH lives in field-cleaner.js.

function sftkTplTextFields() { return ['Subject', 'Body', 'HtmlValue', 'Markup']; }

function _sftkTplRx(fieldApi, flags) {
  const f = String(fieldApi || '').trim();
  return f ? new RegExp(`(?<![A-Za-z0-9_])${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, flags || 'i') : null;
}

// The lines of each text field that name the field: [{ field, line, text }].
function sftkTplHits(rec, fieldApi) {
  const re = _sftkTplRx(fieldApi, 'i');
  const out = [];
  if (!re) return out;
  for (const k of sftkTplTextFields()) {
    const v = rec && rec[k];
    if (typeof v !== 'string' || !v) continue;
    v.split(/\r\n?|\n/).forEach((text, i) => { if (re.test(text)) out.push({ field: k, line: i + 1, text }); });
  }
  return out;
}

// ⇄ the field's API name renamed in every text field, whole word, the spelling of the new name as given.
//   → { rec (the changed fields only), n (places), fields: [k…] }
function sftkTplReplace(rec, fieldApi, newField) {
  const re = _sftkTplRx(fieldApi, 'gi'), nf = String(newField || '').trim();
  const out = {}, fields = [];
  let n = 0;
  if (!re || !nf) return { rec: out, n, fields };
  for (const k of sftkTplTextFields()) {
    const v = rec && rec[k];
    if (typeof v !== 'string' || !v) continue;
    let c = 0;
    const t = v.replace(re, () => { c++; return nf; });
    if (c) { out[k] = t; n += c; fields.push(k); }
  }
  return { rec: out, n, fields };
}

// ✂ every merge field that names the field, taken out: "{!Account.X}", "{{{Account.X}}}", "{!relatedTo.X}" — the
// braces and their content go, the text around them stays. A plain mention outside a merge field is left alone.
//   → { rec, n, fields }
function sftkTplRemove(rec, fieldApi) {
  const f = String(fieldApi || '').trim();
  const out = {}, fields = [];
  let n = 0;
  if (!f) return { rec: out, n, fields };
  const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\{\\{\\{[^{}]*?(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])[^{}]*?\\}\\}\\}|\\{![^{}]*?(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])[^{}]*?\\}`, 'gi');
  for (const k of sftkTplTextFields()) {
    const v = rec && rec[k];
    if (typeof v !== 'string' || !v) continue;
    let c = 0;
    const t = v.replace(re, () => { c++; return ''; });
    if (c) { out[k] = t; n += c; fields.push(k); }
  }
  return { rec: out, n, fields };
}

// The kind of template in words, from its record.
function sftkTplKind(rec) {
  const t = String((rec && rec.TemplateType) || '').toLowerCase(), ui = String((rec && rec.UiType) || '').toLowerCase();
  if (ui === 'sfx' || ui === 'sfx_sample') return 'Lightning email template';
  if (t === 'visualforce') return 'Visualforce email template';
  if (t === 'html' || t === 'custom') return 'classic HTML email template';
  return 'classic text email template';
}
