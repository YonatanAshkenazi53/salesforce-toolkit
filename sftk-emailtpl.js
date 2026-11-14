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
  // classic templates spell the user who receives / sends it Receiving_User / Sending_User (2026-11-14)
  if (o.toLowerCase() === 'user' && new RegExp(`(?<![A-Za-z0-9_])(Receiving_User|Sending_User)\\.${esc(f)}(?![A-Za-z0-9_])`, 'i').test(text)) return true;
  return false;
}

// Is the name at text[at] another object's field? (2026-11-14) A classic or Lightning merge field always names its
// object — "{!Contact.X__c}", "{{{Contact.X__c}}}" — so a ONE-segment qualifier that is not objApi (nor, for the people
// objects, Recipient / receivingUser / sendingUser / Sender, and for User the classic Receiving_User / Sending_User —
// the scan's own rule in sftkTplNamesField) names a same-named field of another object, which ✂ / ⇄ must leave alone.
// A longer path (Opportunity.Account.X__c) and a bare name count as before.
// vf (the Visualforce Markup): the qualifier is a variable, so the chain is resolved instead — relatedTo is the
// relatedToType object, recipient the recipientType one, each further hop a standard relationship (Account → Account,
// Owner / CreatedBy / LastModifiedBy / Manager → User, ReportsTo → Contact, Parent / MasterRecord → the same object),
// $ObjectType.Obj.Fields.X is Obj's. What the markup alone cannot tell — a custom relationship (…__r), a polymorphic
// What / Who, any other variable (an <apex:repeat var>), a type attribute that is missing — answers 'unknown'.
//   → true (another object's), false (this object's), 'unknown' (vf only)
function _sftkTplForeign(text, at, objApi, vf) {
  const o = String(objApi || '').trim().toLowerCase();
  if (!o) return false;
  const before = text.slice(Math.max(0, at - 200), at);
  if (vf) {
    const q = /(?:^|[^A-Za-z0-9_.$])((?:[$A-Za-z_][A-Za-z0-9_]*\.)+)$/.exec(before);
    if (!q) return false;                                                   // a bare name: as before
    const seg = q[1].slice(0, -1).split('.').map(x => x.toLowerCase());
    const attr = n => { const a = new RegExp(`\\b${n}\\s*=\\s*["']([A-Za-z0-9_]+)["']`, 'i').exec(text); return a ? a[1].toLowerCase() : null; };
    if (seg[0] === '$objecttype') return seg.length === 3 && seg[2] === 'fields' ? seg[1] !== o : 'unknown';
    let cur = seg[0] === 'relatedto' ? attr('relatedToType') : seg[0] === 'recipient' ? attr('recipientType') : null;
    if (!cur) return 'unknown';
    const alias = { owner: 'user', createdby: 'user', lastmodifiedby: 'user', manager: 'user', reportsto: 'contact' };
    for (const h of seg.slice(1)) {
      if (/__r$/.test(h) || h === 'what' || h === 'who') return 'unknown';
      if (h === 'parent' || h === 'masterrecord') continue;
      cur = alias[h] || h;
    }
    return cur !== o;
  }
  const q = /(?:^|[^A-Za-z0-9_.])([A-Za-z_][A-Za-z0-9_]*)\.$/.exec(before);
  if (!q) return false;
  const x = q[1].toLowerCase();
  if (x === o) return false;
  if (['contact', 'lead', 'user'].includes(o) && ['recipient', 'receivinguser', 'sendinguser', 'sender'].includes(x)) return false;
  if (o === 'user' && ['receiving_user', 'sending_user'].includes(x)) return false;
  return true;
}

// ⇄ the field's API name renamed in every text field, whole word, the spelling of the new name as given. With objApi,
// another object's field of the same name ("{!Contact.X__c}" when the field is Account.X__c, "{!relatedTo.Account.X__c}"
// in a Contact's Visualforce template) is left as it is; a Visualforce mention whose object the markup cannot tell is
// refused with the reason (2026-11-14).
//   → { rec (the changed fields only), n (places), fields: [k…] } or { rec: {}, n: 0, fields: [], refused }
function sftkTplReplace(rec, fieldApi, newField, objApi) {
  const re = _sftkTplRx(fieldApi, 'gi'), nf = String(newField || '').trim();
  const out = {}, fields = [];
  let n = 0;
  if (!re || !nf) return { rec: out, n, fields };
  for (const k of sftkTplTextFields()) {
    const v = rec && rec[k];
    if (typeof v !== 'string' || !v) continue;
    let c = 0, unk = null;
    const t = v.replace(re, (m, at, str) => {
      const fo = objApi ? _sftkTplForeign(str, at, objApi, k === 'Markup') : false;
      if (fo === 'unknown') { if (!unk) { const b = str.lastIndexOf('{', at); unk = str.slice(b < 0 ? at : b, at + m.length); } return m; }
      if (fo) return m;
      c++; return nf;
    });
    if (unk) return { rec: {}, n: 0, fields: [], refused: `the Visualforce markup reaches ${String(fieldApi).trim()} through “${unk}” — which object's field that is cannot be told from the markup, so ⇄ will not rename it; ✎ Edit the markup instead` };
    if (c) { out[k] = t; n += c; fields.push(k); }
  }
  return { rec: out, n, fields };
}

// ✂ every merge field that names the field, taken out: "{!Account.X}", "{{{Account.X}}}", "{!relatedTo.X}" — the
// braces and their content go, the text around them stays. A plain mention outside a merge field is left alone.
// With objApi, a merge field that names only another object's field of the same name stays (2026-11-14) — in a
// Visualforce Markup too, its chain resolved (relatedTo.Account.X__c is Account's); a Visualforce mention whose object
// the markup cannot tell is refused with the reason.
// In a Visualforce Markup a component bound to the field (<apex:outputField value="{!relatedTo.X__c}"/>, either quote)
// goes whole — value="" is markup Visualforce will not save — and an attribute that is the binding alone anywhere else
// (an <apex:repeat value=…>, a rendered=…) is refused with the reason: nothing is half-written (2026-11-14).
//   → { rec, n, fields } or { rec: {}, n: 0, fields: [], refused }
function sftkTplRemove(rec, fieldApi, objApi) {
  const f = String(fieldApi || '').trim();
  const out = {}, fields = [];
  let n = 0;
  if (!f) return { rec: out, n, fields };
  const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\{\\{\\{[^{}]*?(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])[^{}]*?\\}\\}\\}|\\{![^{}]*?(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])[^{}]*?\\}`, 'gi');
  const word = new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`, 'gi');
  const w1 = `(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`;
  const bound = `(?:"\\{![^{}"]*?${w1}[^{}"]*\\}"|'\\{![^{}']*?${w1}[^{}']*\\}')`;
  const cmpRe = new RegExp(`<apex:(?:outputField|inputField|outputText)\\b[^>]*?\\bvalue\\s*=\\s*${bound}[^>]*?\\/>`, 'gi');
  const attrRe = new RegExp(`=\\s*${bound}`, 'gi');
  const why = m => `the Visualforce markup reaches ${f} through “${m}” — which object's field that is cannot be told from the markup, so ✂ will not take it out; ✎ Edit the markup instead`;
  // the mentions in m (at its offset in str): 'own' if any is this object's field, else 'unknown' if any cannot be told, else 'foreign'
  const owner = (m, at, str, vf) => {
    if (!objApi) return 'own';
    const ws = [...m.matchAll(word)].map(w => _sftkTplForeign(str, at + w.index, objApi, vf));
    return ws.includes(false) ? 'own' : ws.includes('unknown') ? 'unknown' : 'foreign';
  };
  for (const k of sftkTplTextFields()) {
    const v = rec && rec[k];
    if (typeof v !== 'string' || !v) continue;
    const vf = k === 'Markup';
    let c = 0, t = v, unk = null;
    if (vf) {
      t = t.replace(cmpRe, (m, ...a) => { const at = a[a.length - 2], str = a[a.length - 1], w = owner(m, at, str, true); if (w === 'own') { c++; return ''; } if (w === 'unknown') unk = unk || m; return m; });
      if (unk) return { rec: {}, n: 0, fields: [], refused: why(unk) };
      for (const a of t.matchAll(attrRe)) {
        const w = owner(a[0], a.index, t, true);
        if (w === 'own') return { rec: {}, n: 0, fields: [], refused: `the Visualforce markup binds a component's attribute to ${f} — ✂ cannot take it out without breaking the markup; ✎ Edit the markup instead` };
        if (w === 'unknown') return { rec: {}, n: 0, fields: [], refused: why(a[0].replace(/^=\s*/, '')) };
      }
    }
    t = t.replace(re, (m, at, str) => {
      const w = owner(m, at, str, vf);
      if (w === 'unknown') { unk = unk || m; return m; }
      if (w === 'foreign') return m;                                        // only another object's field named in it: left as it is
      c++; return '';
    });
    if (unk) return { rec: {}, n: 0, fields: [], refused: why(unk) };
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
