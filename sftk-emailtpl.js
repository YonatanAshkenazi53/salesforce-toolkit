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
  // 2026-11-14 review 5: every mention written with a qualifier is resolved by _sftkTplForeign — the SAME rule ✂ / ⇄
  // apply — instead of the scan's own regexes, which offered a Contact / Lead field for {{{Sender.X__c}}} (always a
  // User) and an Opportunity template for {{{Opportunity.Account.X__c}}} (Account's). A qualified mention counts when it
  // is this object's; Recipient (a Contact, a Lead or a User) counts for those three, so the template is offered and the
  // fix refuses with the reason. A bare name, or a mention whose object cannot be told (a …__r hop), counts only when
  // the template is about the object (RelatedEntityType / relatedToType), as before.
  const vfT = String((rec && rec.TemplateType) || '').toLowerCase() === 'visualforce';
  const mk = rec && typeof rec.Markup === 'string' ? rec.Markup : '';
  const re = _sftkTplRx(f, 'gi');
  let loose = false;                                                        // a bare name, or one that cannot be told
  for (const k of sftkTplTextFields()) {
    const v = rec && rec[k];
    if (typeof v !== 'string' || !v) continue;
    const vf = k === 'Markup' || vfT;
    for (const m of v.matchAll(re)) {
      if (!/[A-Za-z0-9_]\.$/.test(v.slice(Math.max(0, m.index - 2), m.index))) { loose = true; continue; }
      const info = {};
      const fo = _sftkTplForeign(v, m.index, o, vf, k === 'Markup' ? v : mk, info);
      if (fo === false) return true;
      // a Visualforce recipient.X with no recipientType is still offered for the people objects, as before
      const vfRcp = vf && ['contact', 'lead', 'user'].includes(o.toLowerCase()) && /(?:^|[^A-Za-z0-9_.$])recipient\.[A-Za-z0-9_.]*$/i.test(v.slice(Math.max(0, m.index - 200), m.index));
      if (fo === 'unknown') { if (info.recipient || vfRcp) return true; loose = true; }
    }
  }
  if (!loose) return false;
  if (String((rec && rec.RelatedEntityType) || '').toLowerCase() === o.toLowerCase()) return true;
  return new RegExp(`relatedToType\\s*=\\s*["']${esc(o)}["']`, 'i').test(text);
}

// Is the name at text[at] another object's field? (2026-11-14) A classic or Lightning merge field always names its
// object — "{!Contact.X__c}", "{{{Contact.X__c}}}" — so a ONE-segment qualifier that is not objApi (nor, for the people
// objects, Recipient / receivingUser / sendingUser / Sender, and for User the classic Receiving_User / Sending_User —
// the scan's own rule in sftkTplNamesField) names a same-named field of another object, which ✂ / ⇄ must leave alone.
// A longer path (Opportunity.Account.X__c) is walked to the object it ends on (review 5); a bare name counts as before.
// vf (the Visualforce Markup): the qualifier is a variable, so the chain is resolved instead — relatedTo is the
// relatedToType object, recipient the recipientType one, each further hop a standard relationship of the shared map (sftk-relmap.js)
// (Account / PartnerAccount / ConvertedAccount → Account, Owner / CreatedBy / CompanySigned → User, ReportsTo /
// CustomerSigned → Contact, Parent / MasterRecord → the same object, Entitlement / Individual / PricebookEntry… → that
// object), $ObjectType.Obj.Fields.X is Obj's, $User.X
// User's, $Organization.X the Organization's, $Setup.Obj.X Obj's. What the markup alone cannot tell — a custom
// relationship (…__r), a polymorphic What / Who, Parent where it can be any object, any other variable (an <apex:repeat
// var>), a type attribute that is missing — answers 'unknown'.
// src: where relatedToType / recipientType are read (default: text) — a Visualforce template's Subject (or any other
// text field of it) holds Visualforce merge syntax too, its types declared in the Markup (2026-11-14 review 4).
//   → true (another object's), false (this object's), 'unknown' (cannot be told)
// info (optional, 2026-11-14 review 5): a classic / Lightning 'unknown' sets info.why (the TRUE reason, for the
// refusal text) and info.recipient (it is the polymorphic Recipient).
function _sftkTplForeign(text, at, objApi, vf, src, info) {
  const o = String(objApi || '').trim().toLowerCase();
  if (!o) return false;
  const before = text.slice(Math.max(0, at - 200), at);
  if (vf) {
    const q = /(?:^|[^A-Za-z0-9_.$])((?:[$A-Za-z_][A-Za-z0-9_]*\.)+)$/.exec(before);
    if (!q) return false;                                                   // a bare name: as before
    const seg = q[1].slice(0, -1).split('.').map(x => x.toLowerCase());
    const attr = n => { const a = new RegExp(`\\b${n}\\s*=\\s*["']([A-Za-z0-9_]+)["']`, 'i').exec(typeof src === 'string' ? src : text); return a ? a[1].toLowerCase() : null; };
    if (seg[0] === '$objecttype') return seg.length === 3 && seg[2] === 'fields' ? seg[1] !== o : 'unknown';
    // the other globals name their object, as _sftkMdSwapToken's whose() reads them (2026-11-14 review): $User.X is
    // User's, $Profile.X Profile's, $UserRole.X UserRole's, $Organization.X Organization's, $Setup.Obj.X Obj's;
    // anything else under a global ($Label, $Resource, $Api…) is never this object's field
    // A hop after the global ($User.Manager.X, $Setup.Obj.Owner.X) is followed through the shared map (sftk-relmap.js) from the
    // global's object, like relatedTo / recipient (2026-11-14 review: $User.Manager.X__c is User's own field).
    // The $ roots and every hop are resolved by the ONE shared resolver in sftk-relmap.js (sftkRelGlobal / sftkRelWalk,
    // 2026-11-14): this function kept a private copy of the map (with a SAME list of lookups named for their object,
    // which the shared rule covers — any standard hop not in the map is its own object) that drifted from the others.
    // A custom relationship (…__r), a polymorphic What / Who, or Parent on Attachment / Note… cannot be told from the
    // markup: 'unknown'.
    let cur = null, from = 1;
    const gl = sftkRelGlobal(seg);
    if (gl) {
      if (!gl.obj) return true;                                             // $Label, $Resource, $Api… — never this object's
      cur = gl.obj; from = gl.from;
    } else cur = seg[0] === 'relatedto' ? attr('relatedToType') : seg[0] === 'recipient' ? attr('recipientType') : null;
    if (!cur) return 'unknown';
    const r = sftkRelWalk(cur, seg.slice(from));
    if (r.kind) return 'unknown';
    // sftkMdIsOwnObj (sftk-mdapi.js, a page global loaded before this file), not !==: a Task / Event template's
    // {!relatedTo.Region__c} IS Activity.Region__c, as every other remover takes it — the literal compare called it
    // another object's, so ✂ / ⇄ of Activity.Region__c left it named and reported done (2026-11-14 review 6).
    return !sftkMdIsOwnObj(r.obj, o);
  }
  // classic / Lightning (2026-11-14 review 5): the WHOLE path is walked through the shared resolver, as the formula,
  // flow and Lightning page removers do — only a one-segment qualifier was read, so Opportunity.Account.X__c and
  // Opportunity.Owner.X__c counted as the field of every object at once. The root names its object: an object name, a
  // $ global, or a merge variable — Sender / sendingUser / receivingUser (classic Sending_User / Receiving_User) are
  // always the User who sends or receives it, never a Contact or Lead. Recipient can be a Contact, a Lead or a User:
  // when the path can end on objApi and on another object, which one owns the field cannot be told — 'unknown'.
  const q = /(?:^|[^A-Za-z0-9_.$])((?:[$A-Za-z_][A-Za-z0-9_]*\.)+)$/.exec(before);
  if (!q) return false;                                                     // a bare name: as before
  const seg = q[1].slice(0, -1).split('.').map(x => x.toLowerCase());
  const unknown = (why, rcp) => { if (info) { info.why = why; info.recipient = !!rcp; } return 'unknown'; };
  let starts, from = 1;
  const gl = sftkRelGlobal(seg);
  if (gl) {
    if (!gl.obj) return true;                                               // $Label, $Api… — never this object's
    starts = [gl.obj]; from = gl.from;
  } else if (['sender', 'sendinguser', 'receivinguser', 'sending_user', 'receiving_user'].includes(seg[0])) starts = ['user'];
  else if (seg[0] === 'recipient') starts = ['contact', 'lead', 'user'];
  else starts = [seg[0]];
  const ends = starts.map(s => sftkRelWalk(s, seg.slice(from)));
  const bad = ends.find(r => r.kind);
  if (bad) return unknown(bad.kind === 'custom' ? 'a custom relationship (…__r) does not name the object it leads to'
    : 'the path goes through a relationship that can lead to more than one object (What / Who, or a Parent that can be any object)');
  // own-object test through sftkMdIsOwnObj, as the Visualforce branch above (2026-11-14 review 6): {!Task.Region__c}
  // is Activity's field. Every end on objApi's own table → false; none → true; some (Recipient's three) → 'unknown'.
  const own = ends.filter(r => sftkMdIsOwnObj(r.obj, o)).length;
  if (!own) return true;
  if (own === ends.length) return false;
  return unknown('Recipient can be a Contact, a Lead or a User', true);
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
  // in a Visualforce template every text field (Subject too: "Case for {!relatedTo.X__c}") is read with the
  // Visualforce rules, the types from the Markup — the classic rule took relatedTo for another object (2026-11-14 review 4)
  const vfT = String((rec && rec.TemplateType) || '').toLowerCase() === 'visualforce';
  const mk = rec && typeof rec.Markup === 'string' ? rec.Markup : '';
  for (const k of sftkTplTextFields()) {
    const v = rec && rec[k];
    if (typeof v !== 'string' || !v) continue;
    let c = 0, unk = null, why = null;
    const vf = k === 'Markup' || vfT;
    const t = v.replace(re, (m, at, str) => {
      const info = {};
      const fo = objApi ? _sftkTplForeign(str, at, objApi, vf, k === 'Markup' ? str : mk, info) : false;
      if (fo === 'unknown') { if (!unk) { const b = str.lastIndexOf('{', at); unk = str.slice(b < 0 ? at : b, at + m.length); why = info.why || null; } return m; }
      if (fo) return m;
      c++; return nf;
    });
    // a classic / Lightning mention is refused with its own reason (Recipient's three objects, a …__r hop — review 5)
    if (unk && !vf) return { rec: {}, n: 0, fields: [], refused: `the template reaches ${String(fieldApi).trim()} through “${unk}” — ${why}, so which object's field that is cannot be told and ⇄ will not rename it; ✎ Edit the template instead` };
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
  // a Visualforce template's other text fields (Subject) are read with the Visualforce rules, the types from the
  // Markup (2026-11-14 review 4); src is where those types are read
  const vfT = String((rec && rec.TemplateType) || '').toLowerCase() === 'visualforce';
  const mk = rec && typeof rec.Markup === 'string' ? rec.Markup : '';
  // a classic / Lightning mention that cannot be told carries its own TRUE reason (review 5, 2026-11-14)
  let lastWhy = null;
  const whyOf = (m, vf) => vf || !lastWhy ? why(m) : `the template reaches ${f} through “${m}” — ${lastWhy}, so which object's field that is cannot be told and ✂ will not take it out; ✎ Edit the template instead`;
  const owner = (m, at, str, vf, src) => {
    if (!objApi) return 'own';
    const ws = [...m.matchAll(word)].map(w => {
      const info = {}, r = _sftkTplForeign(str, at + w.index, objApi, vf, src, info);
      if (r === 'unknown' && info.why) lastWhy = info.why;
      return r;
    });
    return ws.includes(false) ? 'own' : ws.includes('unknown') ? 'unknown' : 'foreign';
  };
  for (const k of sftkTplTextFields()) {
    const v = rec && rec[k];
    if (typeof v !== 'string' || !v) continue;
    const vf = k === 'Markup' || vfT;
    let c = 0, t = v, unk = null;
    if (k === 'Markup') {                                                   // components live in the Markup only
      t = t.replace(cmpRe, (m, ...a) => { const at = a[a.length - 2], str = a[a.length - 1], w = owner(m, at, str, true); if (w === 'own') { c++; return ''; } if (w === 'unknown') unk = unk || m; return m; });
      if (unk) return { rec: {}, n: 0, fields: [], refused: why(unk) };
      for (const a of t.matchAll(attrRe)) {
        const w = owner(a[0], a.index, t, true);
        if (w === 'own') return { rec: {}, n: 0, fields: [], refused: `the Visualforce markup binds a component's attribute to ${f} — ✂ cannot take it out without breaking the markup; ✎ Edit the markup instead` };
        if (w === 'unknown') return { rec: {}, n: 0, fields: [], refused: why(a[0].replace(/^=\s*/, '')) };
      }
    }
    t = t.replace(re, (m, at, str) => {
      const w = owner(m, at, str, vf, k === 'Markup' ? str : mk);
      if (w === 'unknown') { unk = unk || m; return m; }
      if (w === 'foreign') return m;                                        // only another object's field named in it: left as it is
      c++; return '';
    });
    if (unk) return { rec: {}, n: 0, fields: [], refused: whyOf(unk, vf) };
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
