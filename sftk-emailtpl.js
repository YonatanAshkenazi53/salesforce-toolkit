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

// Does this template name THIS object's field? (the everyday scan's test, 2026-11-10: "מה שלא ראיתי בסריקה זה email
// alerts, lightning email templates, classic email templates"). The field's API name must be in the text as a whole
// word AND tied to the object: written "Object.Field" ({!Account.X__c}, {{{Account.X__c}}}), or the template is
// about the object (Lightning: RelatedEntityType; Visualforce: relatedToType="Object"), or — for the people objects —
// written "Recipient.Field". A same-named field of another object does not count.
function sftkTplNamesField(rec, objApi, fieldApi) {
  if (!sftkTplHits(rec, fieldApi).length) return false;
  const o = String(objApi || '').trim(), f = String(fieldApi || '').trim();
  if (!o || !f) return false;
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const text = sftkTplTextFields().map(k => (rec && typeof rec[k] === 'string') ? rec[k] : '').join('\n');
  if (new RegExp(`(?<![A-Za-z0-9_])${esc(o)}\\.${esc(f)}(?![A-Za-z0-9_])`, 'i').test(text)) return true;
  if (String((rec && rec.RelatedEntityType) || '').toLowerCase() === o.toLowerCase()) return true;
  if (new RegExp(`relatedToType\\s*=\\s*["']${esc(o)}["']`, 'i').test(text)) return true;
  if (['contact', 'lead', 'user'].includes(o.toLowerCase()) && new RegExp(`(?<![A-Za-z0-9_])(recipient|receivingUser|sendingUser|Sender)\\.${esc(f)}(?![A-Za-z0-9_])`, 'i').test(text)) return true;
  return false;
}

// Is the name at text[at] another object's field? (2026-11-14) A classic or Lightning merge field always names its
// object — "{!Contact.X__c}", "{{{Contact.X__c}}}" — so a ONE-segment qualifier that is not objApi (nor, for the people
// objects, Recipient / receivingUser / sendingUser / Sender — the scan's own rule in sftkTplNamesField) names a
// same-named field of another object, which ✂ / ⇄ must leave alone. A longer path (Opportunity.Account.X__c) and a
// bare name count as before. The Visualforce Markup is not tested this way: there the qualifier is any variable.
function _sftkTplForeign(text, at, objApi) {
  const o = String(objApi || '').trim().toLowerCase();
  if (!o) return false;
  const q = /(?:^|[^A-Za-z0-9_.])([A-Za-z_][A-Za-z0-9_]*)\.$/.exec(text.slice(Math.max(0, at - 120), at));
  if (!q) return false;
  const x = q[1].toLowerCase();
  if (x === o) return false;
  if (['contact', 'lead', 'user'].includes(o) && ['recipient', 'receivinguser', 'sendinguser', 'sender'].includes(x)) return false;
  return true;
}

// ⇄ the field's API name renamed in every text field, whole word, the spelling of the new name as given. With objApi,
// another object's field of the same name ("{!Contact.X__c}" when the field is Account.X__c) is left as it is.
//   → { rec (the changed fields only), n (places), fields: [k…] }
function sftkTplReplace(rec, fieldApi, newField, objApi) {
  const re = _sftkTplRx(fieldApi, 'gi'), nf = String(newField || '').trim();
  const out = {}, fields = [];
  let n = 0;
  if (!re || !nf) return { rec: out, n, fields };
  for (const k of sftkTplTextFields()) {
    const v = rec && rec[k];
    if (typeof v !== 'string' || !v) continue;
    let c = 0;
    const t = v.replace(re, (m, at, str) => { if (objApi && k !== 'Markup' && _sftkTplForeign(str, at, objApi)) return m; c++; return nf; });
    if (c) { out[k] = t; n += c; fields.push(k); }
  }
  return { rec: out, n, fields };
}

// ✂ every merge field that names the field, taken out: "{!Account.X}", "{{{Account.X}}}", "{!relatedTo.X}" — the
// braces and their content go, the text around them stays. A plain mention outside a merge field is left alone.
// With objApi, a merge field that names only another object's field of the same name stays (2026-11-14).
// In a Visualforce Markup a component bound to the field (<apex:outputField value="{!relatedTo.X__c}"/>) goes whole —
// value="" is markup Visualforce will not save — and an attribute that is the binding alone anywhere else (an
// <apex:repeat value=…>, a rendered=…) is refused with the reason: nothing is half-written (2026-11-14).
//   → { rec, n, fields } or { rec: {}, n: 0, fields: [], refused }
function sftkTplRemove(rec, fieldApi, objApi) {
  const f = String(fieldApi || '').trim();
  const out = {}, fields = [];
  let n = 0;
  if (!f) return { rec: out, n, fields };
  const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\{\\{\\{[^{}]*?(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])[^{}]*?\\}\\}\\}|\\{![^{}]*?(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])[^{}]*?\\}`, 'gi');
  const word = new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`, 'gi');
  const bound = `"\\{![^{}"]*?(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])[^{}"]*\\}"`;
  const cmpRe = new RegExp(`<apex:(?:outputField|inputField|outputText)\\b[^>]*?\\bvalue\\s*=\\s*${bound}[^>]*?\\/>`, 'gi');
  const attrRe = new RegExp(`=\\s*${bound}`, 'i');
  for (const k of sftkTplTextFields()) {
    const v = rec && rec[k];
    if (typeof v !== 'string' || !v) continue;
    let c = 0, t = v;
    if (k === 'Markup') {
      t = t.replace(cmpRe, () => { c++; return ''; });
      if (attrRe.test(t)) return { rec: {}, n: 0, fields: [], refused: `the Visualforce markup binds a component's attribute to ${f} — ✂ cannot take it out without breaking the markup; ✎ Edit the markup instead` };
    }
    t = t.replace(re, (m, at, str) => {
      if (k !== 'Markup' && objApi) {
        // only another object's field named in it: left as it is
        const own = [...m.matchAll(word)].some(w => !_sftkTplForeign(str, at + w.index, objApi));
        if (!own) return m;
      }
      c++; return '';
    });
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
