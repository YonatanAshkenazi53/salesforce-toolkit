// sftk-mdapi.js — SOAP Metadata API primitives, pure.
//
// WHY SOAP AT ALL
// The toolkit deploys metadata over REST (POST …/metadata/deployRequest).
// There is no REST counterpart for RETRIEVE, so reading a Connected App or
// a Named Credential out of the source org means the SOAP Metadata API at
// /services/Soap/m/{version} — the same session id that authorizes REST
// works there, exactly as it already does for the partner-SOAP
// emptyRecycleBin call in background.js.
//
// WHY NOT PARSE THE XML
// An MV3 service worker has no DOMParser, and hand-rolling an XML parser
// good enough for arbitrary metadata is a bug farm. It is also unnecessary:
// a readMetadata response already CONTAINS the element body a package file
// needs. So these functions TRANSPLANT the inner XML verbatim instead of
// parsing and re-serialising it — nothing is interpreted, so nothing can be
// silently reinterpreted wrong. The only structure that must be understood
// is where one <records> element starts and ends, which is a depth count on
// a single known tag name.
//
// Everything here is pure — string in, string out — so a real org response
// can be pinned as a fixture and asserted without touching an org.

// Salesforce may answer with or without a namespace prefix (`<records>`,
// `<ns1:records>`, `<met:records>`). Every matcher below has to tolerate
// all three, so the prefix pattern lives in one place.
function sftkMdTagRe(tag, flags) {
  return new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}(\\s[^>]*)?>`, flags || '');
}

// A SOAP fault means the CALL failed — as opposed to a per-item error
// inside a successful response. Returned as a string so a caller can
// surface Salesforce's own words rather than inventing its own.
function sftkMdFault(text) {
  const m = String(text || '').match(/<(?:[A-Za-z0-9_.-]+:)?faultstring>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?faultstring>/);
  return m ? sftkMdUnescape(m[1].trim()) : null;
}

// XML text unescaping for the few values read as TEXT (fullName, error
// messages). Element bodies that get transplanted are never unescaped —
// they are re-emitted exactly as received.
function sftkMdUnescape(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');   // last: an escaped &amp;lt; must stay &lt;
}

function sftkMdEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// The SOAP envelope. The Metadata API wants its own namespace and, unlike
// the partner API, honours a CallOptions/DebuggingHeader we do not need.
function sftkMdEnvelope(sid, bodyXml) {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"'
    + ' xmlns:met="http://soap.sforce.com/2006/04/metadata">'
    + `<soapenv:Header><met:SessionHeader><met:sessionId>${sftkMdEscape(sid)}</met:sessionId></met:SessionHeader></soapenv:Header>`
    + `<soapenv:Body>${bodyXml}</soapenv:Body>`
    + '</soapenv:Envelope>';
}

// Salesforce's own per-call ceilings. Declared inside the functions that
// enforce them so each stays self-contained and testable on its own; the
// exported constants below are for callers that chunk.
function sftkMdListMax() { return 3; }   // listMetadata: 3 queries per call
function sftkMdReadMax() { return 10; }  // readMetadata: 10 fullNames per call

// listMetadata — "what components of this type exist?".
function sftkMdListBody(types, apiVersion) {
  const list = (types || []).filter(Boolean).slice(0, 3);
  return '<met:listMetadata>'
    + list.map(t => {
      const type = typeof t === 'string' ? t : t.type;
      const folder = typeof t === 'string' ? null : t.folder;
      return '<met:queries>'
        + (folder ? `<met:folder>${sftkMdEscape(folder)}</met:folder>` : '')
        + `<met:type>${sftkMdEscape(type)}</met:type>`
        + '</met:queries>';
    }).join('')
    + `<met:asOfVersion>${sftkMdEscape(apiVersion || '62.0')}</met:asOfVersion>`
    + '</met:listMetadata>';
}

function sftkMdReadBody(type, fullNames) {
  const names = (fullNames || []).filter(Boolean).slice(0, 10);
  return '<met:readMetadata>'
    + `<met:type>${sftkMdEscape(type)}</met:type>`
    + names.map(n => `<met:fullNames>${sftkMdEscape(n)}</met:fullNames>`).join('')
    + '</met:readMetadata>';
}

// Find one element's full extent by counting depth on its own tag name.
// Returns { start, bodyStart, bodyEnd, end } or null. Self-closing tags
// report an empty body rather than swallowing the rest of the document —
// that distinction is what keeps a nil-valued field from eating its
// siblings.
function sftkMdFindElement(text, tag, from) {
  const s = String(text || '');
  const openRe = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}(\\s[^>]*?)?(/)?>`, 'g');
  const closeRe = new RegExp(`</(?:[A-Za-z0-9_.-]+:)?${tag}\\s*>`, 'g');
  openRe.lastIndex = from || 0;
  const first = openRe.exec(s);
  if (!first) return null;
  if (first[2]) {
    // <records/> — present but empty.
    return { start: first.index, bodyStart: openRe.lastIndex, bodyEnd: openRe.lastIndex, end: openRe.lastIndex };
  }
  let depth = 1;
  let cursor = openRe.lastIndex;
  const bodyStart = cursor;
  while (depth > 0) {
    openRe.lastIndex = cursor;
    closeRe.lastIndex = cursor;
    const nextOpen = openRe.exec(s);
    const nextClose = closeRe.exec(s);
    if (!nextClose) return null;                 // unbalanced — refuse to guess
    if (nextOpen && nextOpen.index < nextClose.index) {
      if (!nextOpen[2]) depth++;
      cursor = openRe.lastIndex;
      continue;
    }
    depth--;
    cursor = closeRe.lastIndex;
    if (depth === 0) {
      return { start: first.index, bodyStart, bodyEnd: nextClose.index, end: cursor };
    }
  }
  return null;
}

// Read a direct child element's TEXT value out of an element body. Used
// only for fullName and error messages — never for values being carried.
function sftkMdChildText(body, tag) {
  const el = sftkMdFindElement(body, tag, 0);
  if (!el) return null;
  return sftkMdUnescape(String(body).slice(el.bodyStart, el.bodyEnd).trim());
}

// Pull every <records> element out of a readMetadata response, keeping its
// inner XML VERBATIM. A record whose fullName is absent is skipped and
// counted rather than written under a guessed name.
// Returns { records: [{ fullName, innerXml }], nameless }
function sftkMdExtractRecords(text) {
  const s = String(text || '');
  const out = { records: [], nameless: 0 };
  let cursor = 0;
  for (;;) {
    const el = sftkMdFindElement(s, 'records', cursor);
    if (!el) break;
    cursor = el.end;
    const inner = s.slice(el.bodyStart, el.bodyEnd);
    const fullName = sftkMdChildText(inner, 'fullName');
    // readMetadata answers for a name that does NOT exist with a record
    // carrying only a nil fullName — that is an ABSENCE, not a component.
    if (!fullName) { out.nameless++; continue; }
    out.records.push({ fullName, innerXml: inner });
  }
  return out;
}

// Pull the component list out of a listMetadata response.
function sftkMdExtractListed(text) {
  const s = String(text || '');
  const out = [];
  let cursor = 0;
  for (;;) {
    const el = sftkMdFindElement(s, 'result', cursor);
    if (!el) break;
    cursor = el.end;
    const inner = s.slice(el.bodyStart, el.bodyEnd);
    const fullName = sftkMdChildText(inner, 'fullName');
    if (!fullName) continue;
    out.push({
      fullName,
      type: sftkMdChildText(inner, 'type') || '',
      namespacePrefix: sftkMdChildText(inner, 'namespacePrefix') || '',
      manageableState: sftkMdChildText(inner, 'manageableState') || '',
    });
  }
  return out;
}

// A component that belongs to a managed package cannot be deployed into
// another org — the namespace is owned by the package. Filtering here, by
// NAME, keeps one unmovable component from failing the whole package.
function sftkMdDeployable(listed) {
  const out = { deployable: [], skipped: [] };
  for (const c of (listed || [])) {
    if (!c || !c.fullName) continue;
    if (c.namespacePrefix) {
      out.skipped.push({ name: c.fullName, why: `belongs to managed package ${c.namespacePrefix}` });
      continue;
    }
    if (c.manageableState && c.manageableState !== 'unmanaged') {
      out.skipped.push({ name: c.fullName, why: `manageable state “${c.manageableState}” — not editable in this org` });
      continue;
    }
    out.deployable.push(c);
  }
  return out;
}

// Turn one retrieved record into its package file. The inner XML is
// re-emitted UNTOUCHED apart from dropping <fullName>: in a package the
// file NAME carries the identity, and a stray fullName that disagrees with
// the filename is a deploy error.
function sftkMdRecordFileXml(metadataType, innerXml) {
  let body = String(innerXml || '');
  const fn = sftkMdFindElement(body, 'fullName', 0);
  if (fn) body = body.slice(0, fn.start) + body.slice(fn.end);
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + `<${metadataType} xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">`
    + body
    + `</${metadataType}>`;
}

// Does a retrieved record carry a value for a field Salesforce is known to
// blank on retrieve? Answering from the RESPONSE rather than from a rule
// keeps the disclosure honest across API versions: if a future release
// starts returning a secret, the UI stops claiming it was withheld.
// Returns the subset of `fields` that came back EMPTY or absent.
function sftkMdMissingFields(innerXml, fields) {
  const body = String(innerXml || '');
  const missing = [];
  for (const f of (fields || [])) {
    const el = sftkMdFindElement(body, f, 0);
    if (!el) { missing.push(f); continue; }
    const val = body.slice(el.bodyStart, el.bodyEnd).trim();
    if (!val || /^<[^>]*xsi:nil="true"/.test(val)) missing.push(f);
  }
  return missing;
}

// ── Custom report types ──────────────────────────────────────────────────
// A report type's columns live in <sections><columns><field>X</field>
// <table>Account</table></columns>…</sections>. The table names the object
// (Account) or a joined relationship (Account.Contacts) — so a column is
// THIS object's field only when its table IS the object; a same-named
// field under another table is left alone and named. Salesforce allows a
// column once per report type (live 2026-11-04: "Column X on table Account
// appears more than once" refused the deploy).
//
// sftkRtEdit walks every section's columns and lets `visit(field, table,
// sectionLabel)` answer 'keep', 'drop' or { rename }; a section whose last
// column was dropped is dropped with it (a section with no columns has
// nothing to offer a report builder). Everything not visited is re-emitted
// byte for byte.
function sftkRtEdit(innerXml, visit) {
  const s = String(innerXml || '');
  let out = '', cursor = 0;
  const stats = { dropped: 0, renamed: 0, seen: 0, emptied: [] };
  for (;;) {
    const sec = sftkMdFindElement(s, 'sections', cursor);
    if (!sec) break;
    const secBody = s.slice(sec.bodyStart, sec.bodyEnd);
    const label = sftkMdChildText(secBody, 'masterLabel') || '';
    let sb = '', c2 = 0, kept = 0, touched = false;
    for (;;) {
      const ce = sftkMdFindElement(secBody, 'columns', c2);
      if (!ce) break;
      const colXml = secBody.slice(ce.start, ce.end);
      const colBody = secBody.slice(ce.bodyStart, ce.bodyEnd);
      const field = sftkMdChildText(colBody, 'field') || '';
      const table = sftkMdChildText(colBody, 'table') || '';
      stats.seen++;
      const d = visit(field, table, label);
      sb += secBody.slice(c2, ce.start);
      if (d === 'drop') { stats.dropped++; touched = true; }
      else if (d && typeof d === 'object' && d.rename) {
        const fe = sftkMdFindElement(colBody, 'field', 0);
        const nb = colBody.slice(0, fe.bodyStart) + sftkMdEscape(d.rename) + colBody.slice(fe.bodyEnd);
        sb += colXml.slice(0, ce.bodyStart - ce.start) + nb + colXml.slice(ce.bodyEnd - ce.start);
        stats.renamed++; kept++; touched = true;
      } else { sb += colXml; kept++; }
      c2 = ce.end;
    }
    sb += secBody.slice(c2);
    out += s.slice(cursor, sec.start);
    if (kept === 0 && touched) stats.emptied.push(label);          // the section goes with its last column
    else out += s.slice(sec.start, sec.bodyStart) + sb + s.slice(sec.bodyEnd, sec.end);
    cursor = sec.end;
  }
  out += s.slice(cursor);
  return { xml: out, ...stats };
}

// How many columns of objApi.fieldApi the type has (0 = not referenced).
function sftkRtMentions(innerXml, objApi, fieldApi) {
  const f = String(fieldApi || '').toLowerCase(), o = String(objApi || '').toLowerCase();
  let n = 0;
  sftkRtEdit(innerXml, (field, table) => { if (field.toLowerCase() === f && table.toLowerCase() === o) n++; return 'keep'; });
  return n;
}

// ✂ Remove: the column goes; a same-named field under another table is
// listed in `skipped`, never touched.
function sftkRtRemoveField(innerXml, objApi, fieldApi) {
  const f = String(fieldApi || '').toLowerCase(), o = String(objApi || '').toLowerCase();
  const skipped = [];
  const r = sftkRtEdit(innerXml, (field, table, label) => {
    if (field.toLowerCase() !== f) return 'keep';
    if (table.toLowerCase() === o) return 'drop';
    skipped.push(`${table}.${field} in “${label}”`);
    return 'keep';
  });
  return { xml: r.xml, removed: r.dropped, emptied: r.emptied, skipped, changed: r.dropped > 0 };
}

// ⇄ Replace: the column names the new field in place. When the new field is
// already a column of the same table, the old column is removed instead
// (a column may appear once) and `newAlreadyThere` says so.
function sftkRtReplaceField(innerXml, objApi, fieldApi, newFieldApi) {
  const newAlreadyThere = sftkRtMentions(innerXml, objApi, newFieldApi) > 0;
  if (newAlreadyThere) {
    const rm = sftkRtRemoveField(innerXml, objApi, fieldApi);
    return { xml: rm.xml, swapped: 0, dropped: rm.removed, emptied: rm.emptied, skipped: rm.skipped, newAlreadyThere, changed: rm.changed };
  }
  const f = String(fieldApi || '').toLowerCase(), o = String(objApi || '').toLowerCase();
  const skipped = [];
  const r = sftkRtEdit(innerXml, (field, table, label) => {
    if (field.toLowerCase() !== f) return 'keep';
    if (table.toLowerCase() === o) return { rename: newFieldApi };
    skipped.push(`${table}.${field} in “${label}”`);
    return 'keep';
  });
  return { xml: r.xml, swapped: r.renamed, dropped: 0, emptied: r.emptied, skipped, newAlreadyThere, changed: r.renamed > 0 };
}

// The two files a report-type deploy needs (the zip builder lives in sftk-zip.js).
function sftkRtZipFiles(fullName, fileXml) {
  const pkg = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n'
    + '    <types>\n'
    + `        <members>${sftkMdEscape(fullName)}</members>\n`
    + '        <name>ReportType</name>\n'
    + '    </types>\n'
    + '    <version>62.0</version>\n'
    + '</Package>';
  return [{ name: 'package.xml', text: pkg }, { name: `reportTypes/${fullName}.reportType`, text: fileXml }];
}

// ── Field Cleaner's blocker legs (live-tested 2026-11-06, npc) ─────────────
// Salesforce refuses a field delete while an approval process, a sharing
// rule's criteria, a duplicate rule's filter, a lead field mapping or a
// Lead/Case assignment, auto-response or escalation rule still names the
// field — none of which the dependency index returns. They have no Tooling
// read, so the scan reads them through readMetadata and searches the XML
// with the helpers below. Every helper is pure: XML in, facts out.

// The repeated child elements of a container body, each with its fullName.
// A child without a fullName keeps its position as the name (1-based).
function sftkMdChildren(innerXml, tag) {
  const s = String(innerXml || '');
  const out = [];
  let cursor = 0, i = 0;
  for (;;) {
    const el = sftkMdFindElement(s, tag, cursor);
    if (!el) break;
    cursor = el.end; i++;
    const body = s.slice(el.bodyStart, el.bodyEnd);
    out.push({ fullName: sftkMdChildText(body, 'fullName') || String(i), innerXml: body });
  }
  return out;
}

// Does this XML name the field? True when a field-carrying element
// (criteria <field>, a matching <fieldName>, an outbound message's <fields>,
// a mapping's <inputField>/<outputField>) holds "Field__c" or
// "Object.Field__c", or when a formula-carrying element (<formula>,
// <errorConditionFormula>, <recordFilter>) mentions the field as a whole
// token. Case-insensitive, as Salesforce is.
function sftkMdMentionsField(innerXml, objApi, fieldApi) {
  const s = String(innerXml || '');
  const f = String(fieldApi || '').toLowerCase(), o = String(objApi || '').toLowerCase();
  if (!f) return false;
  const nameRe = /<(?:[A-Za-z0-9_.-]+:)?(field|fieldName|fields|inputField|outputField|leftValueReference)(?:\s[^>]*)?>([^<]*)<\//g;
  let m;
  while ((m = nameRe.exec(s))) {
    const v = sftkMdUnescape(m[2]).trim().toLowerCase();
    if (v === f || v === `${o}.${f}` || v.endsWith(`.${f}`)) return true;
  }
  const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tokenRe = new RegExp(`(^|[^a-z0-9_])${esc}([^a-z0-9_]|$)`, 'i');
  const formulaRe = /<(?:[A-Za-z0-9_.-]+:)?(formula|errorConditionFormula|recordFilter|booleanFilter)(?:\s[^>]*)?>([^<]*)<\//g;
  while ((m = formulaRe.exec(s))) {
    if (tokenRe.test(sftkMdUnescape(m[2]))) return true;
  }
  return false;
}

// The lead-conversion mappings that carry objApi.fieldApi: on the Lead side
// (inputField of a Lead mapping) or on the target side (outputField of the
// mapping whose outputObject is objApi). Returns [{ inputObject, outputObject,
// inputField, outputField }] — empty when the field is not mapped.
function sftkMdLeadMappingsFor(innerXml, objApi, fieldApi) {
  const f = String(fieldApi || '').toLowerCase(), o = String(objApi || '').toLowerCase();
  const out = [];
  for (const om of sftkMdChildren(innerXml, 'objectMapping')) {
    const inputObject = sftkMdChildText(om.innerXml, 'inputObject') || '';
    const outputObject = sftkMdChildText(om.innerXml, 'outputObject') || '';
    for (const mf of sftkMdChildren(om.innerXml, 'mappingFields')) {
      const inputField = sftkMdChildText(mf.innerXml, 'inputField') || '';
      const outputField = sftkMdChildText(mf.innerXml, 'outputField') || '';
      const onLead = inputObject.toLowerCase() === o && inputField.toLowerCase() === f;
      const onTarget = outputObject.toLowerCase() === o && outputField.toLowerCase() === f;
      if (onLead || onTarget) out.push({ inputObject, outputObject, inputField, outputField });
    }
  }
  return out;
}

// A custom metadata record's <values> that hold the field: a Field
// Definition relationship stores "Object.Field__c" (that one makes
// Salesforce refuse the delete); a text value may hold either spelling.
// Returns the names of the record's fields that hold it.
function sftkMdValuesHolding(innerXml, objApi, fieldApi) {
  const f = String(fieldApi || '').toLowerCase(), o = String(objApi || '').toLowerCase();
  const out = [];
  const vals = sftkMdChildren(innerXml, 'values').map(v => ({ field: sftkMdChildText(v.innerXml, 'field') || '?', val: (sftkMdChildText(v.innerXml, 'value') || '').trim() }));
  // A bare "Field__c" names a field of the object the record's OTHER value names (an Entity Definition
  // relationship stores "Account" in one field and "Field__c" in another). When that other value is a
  // DIFFERENT object, the bare name is not this object's field (found 2026-11-08: the demo record with
  // Entity__c = Account was listed as a blocker for Lead.SFTK_Live_Blk__c and Case.SFTK_Live_Blk__c).
  const STD = /^(account|contact|lead|case|opportunity|user|campaign|asset|contract|order|product2|task|event|individual|quote|solution)$/;
  const objLike = x => /^[a-z][a-z0-9_]*$/.test(x) && (STD.test(x) || /__(c|mdt|x|b|e)$/.test(x));
  const otherObj = vals.some(v => { const x = v.val.toLowerCase(); return x !== o && x !== f && objLike(x); });
  const ownObj = vals.some(v => v.val.toLowerCase() === o);
  for (const v of vals) {
    const val = v.val.toLowerCase();
    if (val === `${o}.${f}`) out.push(v.field);
    else if (val === f && (ownObj || !otherObj)) out.push(v.field);
  }
  return out;
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkMdChildren       = sftkMdChildren;
  globalThis.sftkMdMentionsField  = sftkMdMentionsField;
  globalThis.sftkMdLeadMappingsFor = sftkMdLeadMappingsFor;
  globalThis.sftkMdValuesHolding  = sftkMdValuesHolding;
  globalThis.sftkMdTagRe          = sftkMdTagRe;
  globalThis.sftkMdFault          = sftkMdFault;
  globalThis.sftkMdUnescape       = sftkMdUnescape;
  globalThis.sftkMdEscape         = sftkMdEscape;
  globalThis.sftkMdEnvelope       = sftkMdEnvelope;
  globalThis.sftkMdListBody       = sftkMdListBody;
  globalThis.sftkMdReadBody       = sftkMdReadBody;
  globalThis.sftkMdFindElement    = sftkMdFindElement;
  globalThis.sftkMdChildText      = sftkMdChildText;
  globalThis.sftkMdExtractRecords = sftkMdExtractRecords;
  globalThis.sftkMdExtractListed  = sftkMdExtractListed;
  globalThis.sftkMdDeployable     = sftkMdDeployable;
  globalThis.sftkMdRecordFileXml  = sftkMdRecordFileXml;
  globalThis.sftkMdMissingFields  = sftkMdMissingFields;
  globalThis.sftkMdListMax        = sftkMdListMax;
  globalThis.sftkMdReadMax        = sftkMdReadMax;
  globalThis.sftkRtEdit           = sftkRtEdit;
  globalThis.sftkRtMentions       = sftkRtMentions;
  globalThis.sftkRtRemoveField    = sftkRtRemoveField;
  globalThis.sftkRtReplaceField   = sftkRtReplaceField;
  globalThis.sftkRtZipFiles       = sftkRtZipFiles;
}

// ── 🗑 Delete a blocker, as a whole (user 2026-11-07: "כל מה שחייב להיות
// מוסר כדי להסיר שדה חייב להיות מחיק בלחיצת כפתור") ───────────────────────
// One engine for every kind Salesforce refuses the field delete for: the
// component is read first (its full definition is the restore point), then
// removed with a destructiveChanges deploy, then read again (gone = done).
// Undo deploys the saved definition back as a package. Pure: the table, the
// package.xml/destructiveChanges files, and the files that recreate a record.
//   parent/tag/folder/suffix: a child type lives inside its parent's file
//   (objects/Account.object holds <validationRules>); a top-level type has a
//   file of its own; code and bundles are recreated from their sources.
function _sftkMdDeleteTable() {
  return {
  ValidationRule:          { parent: 'CustomObject',     tag: 'validationRules',      folder: 'objects',           suffix: 'object',           what: 'validation rule',            tooling: 'ValidationRule' },
  FieldSet:                { parent: 'CustomObject',     tag: 'fieldSets',            folder: 'objects',           suffix: 'object',           what: 'field set',                  tooling: 'FieldSet' },
  WebLink:                 { parent: 'CustomObject',     tag: 'webLinks',             folder: 'objects',           suffix: 'object',           what: 'custom button or link',      tooling: 'WebLink' },
  CustomField:             { parent: 'CustomObject',     tag: 'fields',               folder: 'objects',           suffix: 'object',           what: 'formula or roll-up field',  tooling: 'CustomField' },
  WorkflowRule:            { parent: 'Workflow',         tag: 'rules',                folder: 'workflows',         suffix: 'workflow',         what: 'workflow rule',              tooling: 'WorkflowRule' },
  WorkflowFieldUpdate:     { parent: 'Workflow',         tag: 'fieldUpdates',         folder: 'workflows',         suffix: 'workflow',         what: 'field update',               tooling: 'WorkflowFieldUpdate' },
  WorkflowAlert:           { parent: 'Workflow',         tag: 'alerts',               folder: 'workflows',         suffix: 'workflow',         what: 'email alert',                tooling: 'WorkflowAlert' },
  WorkflowOutboundMessage: { parent: 'Workflow',         tag: 'outboundMessages',     folder: 'workflows',         suffix: 'workflow',         what: 'outbound message',           tooling: 'WorkflowOutboundMessage' },
  SharingCriteriaRule:     { parent: 'SharingRules',     tag: 'sharingCriteriaRules', folder: 'sharingRules',      suffix: 'sharingRules',     what: 'sharing rule' },
  AssignmentRule:          { parent: 'AssignmentRules',  tag: 'assignmentRule',       folder: 'assignmentRules',   suffix: 'assignmentRules',  what: 'assignment rule' },
  AutoResponseRule:        { parent: 'AutoResponseRules', tag: 'autoResponseRule',    folder: 'autoResponseRules', suffix: 'autoResponseRules', what: 'auto-response rule' },
  EscalationRule:          { parent: 'EscalationRules',  tag: 'escalationRule',       folder: 'escalationRules',   suffix: 'escalationRules',  what: 'escalation rule' },
  MatchingRule:            { parent: 'MatchingRules',    tag: 'matchingRules',        folder: 'matchingRules',     suffix: 'matchingRule',     what: 'matching rule' },
  ApprovalProcess:         { folder: 'approvalProcesses', suffix: 'approvalProcess',  what: 'approval process' },
  RestrictionRule:         { folder: 'restrictionRules', suffix: 'rule',              what: 'scoping or restriction rule', tooling: 'RestrictionRule' },
  CustomMetadataRecord:    { mdType: 'CustomMetadata',   folder: 'customMetadata',    suffix: 'md',               what: 'custom metadata record' },
  FlexiPage:               { folder: 'flexipages',       suffix: 'flexipage',         what: 'Lightning page',             tooling: 'FlexiPage' },
  ApexClass:               { code: 'Body',   folder: 'classes',    suffix: 'cls',       what: 'Apex class',            tooling: 'ApexClass',     metaTag: 'ApexClass' },
  ApexTrigger:             { code: 'Body',   folder: 'triggers',   suffix: 'trigger',   what: 'Apex trigger',          tooling: 'ApexTrigger',   metaTag: 'ApexTrigger' },
  ApexPage:                { code: 'Markup', folder: 'pages',      suffix: 'page',      what: 'Visualforce page',      tooling: 'ApexPage',      metaTag: 'ApexPage' },
  ApexComponent:           { code: 'Markup', folder: 'components', suffix: 'component', what: 'Visualforce component', tooling: 'ApexComponent', metaTag: 'ApexComponent' },
  LightningComponentBundle: { bundle: 'lwc',  what: 'Lightning web component', tooling: 'LightningComponentBundle' },
  AuraDefinitionBundle:    { bundle: 'aura', what: 'Aura component',           tooling: 'AuraDefinitionBundle' },
  // the three the user asked for by name ("צריך את כולם", 2026-11-07): a duplicate rule is deleted — and since
  // 2026-11-08 ("צריך להיות בכולם") edited — only from its own explicit buttons, the diff confirmed, a restore point
  // kept (the standing rule stays: nothing switches one off or edits one behind a run); the lead field mapping is
  // EDITED (its line goes, the settings stay); a Process Builder process is every version of a Flow
  DuplicateRule:           { folder: 'duplicateRules',   suffix: 'duplicateRule',     what: 'duplicate rule' },
  // the 👀 mentions (user 2026-11-08: "why here we can't do anything?"): a list view, a compact layout and a quick
  // action are edited and deleted like the blockers; an inactive validation rule is a validation rule
  ListView:                { parent: 'CustomObject',     tag: 'listViews',            folder: 'objects',           suffix: 'object',           what: 'list view',                  tooling: 'ListView' },
  CompactLayout:           { parent: 'CustomObject',     tag: 'compactLayouts',       folder: 'objects',           suffix: 'object',           what: 'compact layout',             tooling: 'CompactLayout' },
  QuickAction:             { folder: 'quickActions',     suffix: 'quickAction',       what: 'quick action',               tooling: 'QuickActionDefinition' },
  ValidationRuleInactive:  { mdType: 'ValidationRule',   parent: 'CustomObject',     tag: 'validationRules',      folder: 'objects',           suffix: 'object',           what: 'validation rule',            tooling: 'ValidationRule' },
  LeadConvertSettings:     { folder: 'LeadConvertSettings', suffix: 'LeadConvertSetting', what: 'lead field mapping', edit: 'leadMapping' },
  ProcessBuilder:          { mdType: 'Flow',             folder: 'flows',             suffix: 'flow',             what: 'Process Builder process' },
  };
}
// What the delete needs to know about a type; null = not deletable here
// (a duplicate rule stays a hand job on purpose; a lookup filter and the
// lead mapping are parts of something else and are edited, not deleted).
function sftkMdDeleteSpec(type) {
  const s = _sftkMdDeleteTable()[type];
  return s ? { type, mdType: s.mdType || type, ...s } : null;
}
function _sftkPkgXml(items) {
  const byType = new Map();
  for (const [t, m] of items) { if (!byType.has(t)) byType.set(t, []); byType.get(t).push(m); }
  let x = '<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n';
  for (const [t, ms] of byType) x += `    <types>\n${ms.map(m => `        <members>${sftkMdEscape(m)}</members>\n`).join('')}        <name>${sftkMdEscape(t)}</name>\n    </types>\n`;
  return x + '    <version>62.0</version>\n</Package>';
}
// The two files of a delete: an empty package and the destructive list,
// applied after it (destructiveChangesPost.xml, the same the CLI uses).
function sftkMdDestructiveFiles(items) {
  return [{ name: 'package.xml', text: _sftkPkgXml([]) }, { name: 'destructiveChangesPost.xml', text: _sftkPkgXml(items) }];
}
// The files that put one record back: its package.xml and the file the
// Metadata API expects for the type. A child type goes inside its parent's
// file with its SHORT name (Account.X is X inside objects/Account.object);
// a top-level type gets a file of its own. innerXml is what readMetadata
// returned, fullName and all.
function sftkMdPackageFiles(type, fullName, innerXml) {
  const s = sftkMdDeleteSpec(type);
  if (!s || s.code || s.bundle) return null;
  const mdType = s.mdType;
  if (s.parent) {
    const dot = fullName.indexOf('.');
    const obj = dot > 0 ? fullName.slice(0, dot) : fullName, short = dot > 0 ? fullName.slice(dot + 1) : fullName;
    let body = String(innerXml || '');
    const fn = sftkMdFindElement(body, 'fullName', 0);
    if (fn) body = body.slice(0, fn.start) + body.slice(fn.end);
    const file = '<?xml version="1.0" encoding="UTF-8"?>\n'
      + `<${s.parent} xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">`
      + `<${s.tag}><fullName>${sftkMdEscape(short)}</fullName>${body}</${s.tag}>`
      + `</${s.parent}>`;
    return [{ name: 'package.xml', text: _sftkPkgXml([[mdType, fullName]]) }, { name: `${s.folder}/${obj}.${s.suffix}`, text: file }];
  }
  return [{ name: 'package.xml', text: _sftkPkgXml([[mdType, fullName]]) }, { name: `${s.folder}/${fullName}.${s.suffix}`, text: sftkMdRecordFileXml(mdType, innerXml) }];
}
// The Metadata API wants a decimal api version ("62.0", never "62" — a Tooling record says 62).
function _sftkApiVer(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n.toFixed(1) : String(v || '62.0');
}
// The files that put a piece of code back: the source and its -meta.xml.
function sftkMdCodeFiles(type, name, source, apiVersion, extra) {
  const s = sftkMdDeleteSpec(type);
  if (!s || !s.code) return null;
  const meta = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + `<${s.metaTag} xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>${sftkMdEscape(_sftkApiVer(apiVersion))}</apiVersion>`
    + (s.metaTag === 'ApexClass' || s.metaTag === 'ApexTrigger' ? '<status>Active</status>' : '')
    + (extra && extra.label ? `<label>${sftkMdEscape(extra.label)}</label>` : '')
    + `</${s.metaTag}>`;
  return [
    { name: 'package.xml', text: _sftkPkgXml([[type, name]]) },
    { name: `${s.folder}/${name}.${s.suffix}`, text: String(source || '') },
    { name: `${s.folder}/${name}.${s.suffix}-meta.xml`, text: meta },
  ];
}
// The files that put a bundle back: every resource as it was, plus the
// bundle's -meta.xml. resources: [{ path, source }], paths like
// "lwc/x/x.js" (an LWC FilePath) or "x.cmp" (Aura, from its DefType).
function sftkMdBundleFiles(type, name, resources, meta) {
  const s = sftkMdDeleteSpec(type);
  if (!s || !s.bundle) return null;
  const files = [{ name: 'package.xml', text: _sftkPkgXml([[type, name]]) }];
  for (const r of (resources || [])) {
    const p = String(r.path || '');
    files.push({ name: p.startsWith(`${s.bundle}/`) ? p : `${s.bundle}/${name}/${p}`, text: String(r.source || '') });
  }
  const m = meta || {};
  const tag = type === 'LightningComponentBundle' ? 'LightningComponentBundle' : 'AuraDefinitionBundle';
  const metaFile = type === 'LightningComponentBundle' ? `${s.bundle}/${name}/${name}.js-meta.xml` : `${s.bundle}/${name}/${name}.cmp-meta.xml`;
  files.push({ name: metaFile, text: '<?xml version="1.0" encoding="UTF-8"?>\n'
    + `<${tag} xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>${sftkMdEscape(_sftkApiVer(m.apiVersion))}</apiVersion>`
    + (type === 'LightningComponentBundle' ? `<isExposed>${m.isExposed === true ? 'true' : 'false'}</isExposed>${m.masterLabel ? `<masterLabel>${sftkMdEscape(m.masterLabel)}</masterLabel>` : ''}` : (m.description ? `<description>${sftkMdEscape(m.description)}</description>` : ''))
    + `</${tag}>` });
  return files;
}
// ✂ The lead-conversion mapping lines that carry objApi.fieldApi go; every
// other line and the settings themselves stay. An objectMapping left with no
// mappingFields is kept as it is — that is exactly how Salesforce clears a
// mapping (live 2026-11-06: a deploy WITHOUT the objectMapping clears nothing).
function sftkMdLeadMappingRemove(innerXml, objApi, fieldApi) {
  const f = String(fieldApi || '').toLowerCase(), o = String(objApi || '').toLowerCase();
  const s = String(innerXml || '');
  let out = '', cursor = 0, removed = 0;
  for (;;) {
    const om = sftkMdFindElement(s, 'objectMapping', cursor);
    if (!om) break;
    const body = s.slice(om.bodyStart, om.bodyEnd);
    const inputObject = (sftkMdChildText(body, 'inputObject') || '').toLowerCase();
    const outputObject = (sftkMdChildText(body, 'outputObject') || '').toLowerCase();
    let nb = '', c2 = 0;
    for (;;) {
      const mf = sftkMdFindElement(body, 'mappingFields', c2);
      if (!mf) break;
      const mb = body.slice(mf.bodyStart, mf.bodyEnd);
      const inF = (sftkMdChildText(mb, 'inputField') || '').toLowerCase(), outF = (sftkMdChildText(mb, 'outputField') || '').toLowerCase();
      const hit = (inputObject === o && inF === f) || (outputObject === o && outF === f);
      nb += body.slice(c2, mf.start);
      if (hit) removed++; else nb += body.slice(mf.start, mf.end);
      c2 = mf.end;
    }
    nb += body.slice(c2);
    out += s.slice(cursor, om.bodyStart) + nb + s.slice(om.bodyEnd, om.end);
    cursor = om.end;
  }
  out += s.slice(cursor);
  return { xml: out, removed };
}

// ✂ A lookup field's <lookupFilter> goes; everything else of the field is
// re-emitted byte for byte. A deploy of the field without the element removes
// the filter (live 2026-11-07); the original XML puts it back.
function sftkMdLookupFilterRemove(innerXml) {
  const s = String(innerXml || '');
  const el = sftkMdFindElement(s, 'lookupFilter', 0);
  if (!el) return { xml: s, removed: 0 };
  return { xml: s.slice(0, el.start) + s.slice(el.end), removed: 1 };
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkMdDeleteSpec       = sftkMdDeleteSpec;
  globalThis.sftkMdDestructiveFiles = sftkMdDestructiveFiles;
  globalThis.sftkMdPackageFiles     = sftkMdPackageFiles;
  globalThis.sftkMdCodeFiles        = sftkMdCodeFiles;
  globalThis.sftkMdBundleFiles      = sftkMdBundleFiles;
  globalThis.sftkMdLeadMappingRemove = sftkMdLeadMappingRemove;
  globalThis.sftkMdLookupFilterRemove = sftkMdLookupFilterRemove;
}

// ── ✂ Remove / ⇄ Replace INSIDE a blocker, its XML kept whole (user
// 2026-11-07: "we try to remove, replace the field in the metadata items
// without breaking them. While showing XML") ────────────────────────────────
// The record's inner XML (what readMetadata returned) goes in; the same XML
// with only the field's own places changed comes out. Structure-driven:
// criteria items and list members are dropped (✂) or renamed (⇄) as whole
// elements; formula text gets a token swap on ⇄ and is never cut on ✂ (a
// formula cannot lose a reference and stay a formula). When what is left
// would no longer be a working component, the edit is REFUSED with the reason
// and the way that does work — nothing is deployed on a refusal.
// Returns { xml, changed, how: [strings], refused: string|null }.
function _sftkMdFieldIs(v, objApi, fieldApi) {
  const x = String(v == null ? '' : v).trim().toLowerCase(), f = String(fieldApi || '').toLowerCase(), o = String(objApi || '').toLowerCase();
  return !!f && (x === f || x === `${o}.${f}`);
}
// "Account.Old__c" → "Account.New__c", "Old__c" → "New__c": the spelling is kept.
function _sftkMdRenameVal(v, newField) {
  const s = String(v == null ? '' : v).trim();
  const d = s.lastIndexOf('.');
  return d >= 0 ? s.slice(0, d + 1) + newField : String(newField);
}
// Every <tag> element of xml, in order; visit(body) answers 'keep', 'drop' or
// { body } (the element's new inner XML). Everything else is re-emitted byte for byte.
function _sftkMdWalk(xml, tag, visit) {
  const s = String(xml || '');
  let out = '', cursor = 0, dropped = 0, changed = 0, kept = 0;
  for (;;) {
    const el = sftkMdFindElement(s, tag, cursor);
    if (!el) break;
    const body = s.slice(el.bodyStart, el.bodyEnd);
    const d = visit(body);
    out += s.slice(cursor, el.start);
    if (d === 'drop') dropped++;
    else if (d && typeof d === 'object') { out += s.slice(el.start, el.bodyStart) + d.body + s.slice(el.bodyEnd, el.end); changed++; kept++; }
    else { out += s.slice(el.start, el.end); kept++; }
    cursor = el.end;
  }
  return { xml: out + s.slice(cursor), dropped, changed, kept };
}
// A formula's references to the field — bare (Field__c) or Obj.Field__c —
// swapped for newField (or only counted when newField is null).
function _sftkMdSwapToken(text, objApi, fieldApi, newField) {
  const rx = x => String(x || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!fieldApi) return { text: String(text || ''), n: 0 };
  const re = new RegExp(`(^|[^A-Za-z0-9_.])((?:${rx(objApi)}\\.)?)${rx(fieldApi)}(?![A-Za-z0-9_])`, 'gi');
  let n = 0;
  const out = String(text || '').replace(re, (m, pre, ob) => { n++; return newField ? pre + ob + newField : m; });
  return { text: out, n };
}
// ✂ on a formula, as a SUGGESTION (user 2026-11-10, on a validation rule's confirm: "why can't we just remove the
// field reference instead of deactivation?" — "we need to let the user to edit it and suggest what to remove. if its
// the only field ref we can suggest to turn it off"). The formula is read as conditions joined by && / || / AND(…) /
// OR(…), nested as deep as they go; every condition that names the field is taken out whole, the others stay as
// written. What is left is a proposal — which conditions go changes when the rule fires, so the caller shows the
// diff and lets the user edit it. Text in quotes and comments is skipped when the brackets are counted.
//   → { mode: 'operand', text, n }   n conditions taken out, `text` is the formula that is left
//     { mode: 'whole', n }           every condition names the field: nothing would be left
//     { mode: 'none' }               the formula does not name the field
function sftkFormulaDropField(formula, objApi, fieldApi) {
  // the field named in the formula's own text — a comment or a quoted string that holds its name does not count
  const names = t => _sftkMdSwapToken(String(t).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""'), objApi, fieldApi, null).n > 0;
  // walk t outside quotes and comments; at(i, depth) may return a new index to jump to
  const scan = (t, at) => {
    let depth = 0, q = null;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '/' && t[i + 1] === '*') { const j = t.indexOf('*/', i + 2); i = j < 0 ? t.length : j + 1; continue; }
      if (c === '(') { depth++; continue; }
      if (c === ')') { depth--; if (at(i, depth, true) === false) return; continue; }
      const j = at(i, depth, false);
      if (j === false) return;
      if (typeof j === 'number') i = j;
    }
  };
  const split = (t, op) => {
    const parts = []; let start = 0;
    scan(t, (i, depth, close) => { if (!close && depth === 0 && t.startsWith(op, i)) { parts.push(t.slice(start, i)); start = i + op.length; return start - 1; } });
    parts.push(t.slice(start));
    return parts;
  };
  // does the bracket opened at `open` close at the very end of t?
  const wraps = (t, open) => { let end = -1; scan(t.slice(open), (i, depth, close) => { if (close && depth === 0) { end = open + i; return false; } }); return end === t.length - 1; };
  let n = 0;
  const some = (parts, op) => { const kept = parts.map(drop).filter(x => x != null); return kept.length ? kept.join(op) : null; };
  const drop = expr => {
    const t = String(expr).trim();
    if (!names(t)) return t;
    const ors = split(t, '||');
    if (ors.length > 1) return some(ors, ' || ');
    const ands = split(t, '&&');
    if (ands.length > 1) return some(ands, ' && ');
    const fn = /^(AND|OR)\s*\(/i.exec(t);
    if (fn && wraps(t, fn[0].length - 1)) {
      const kept = split(t.slice(fn[0].length, -1), ',').map(drop).filter(x => x != null);
      if (!kept.length) return null;
      if (kept.length > 1) return `${fn[1]}(${kept.join(', ')})`;
      return (split(kept[0], '||').length > 1 || split(kept[0], '&&').length > 1) ? `(${kept[0]})` : kept[0];
    }
    if (t[0] === '(' && wraps(t, 0)) { const r = drop(t.slice(1, -1)); return r == null ? null : `(${r})`; }
    n++;
    return null;   // one condition that uses the field
  };
  const src = String(formula || '');
  if (!names(src)) return { mode: 'none' };
  const text = drop(src);
  return text == null ? { mode: 'whole', n } : { mode: 'operand', text, n };
}
// Does a filter's logic (booleanFilter "1 AND (2 OR 3)") number its items?
// Taking an item out of a numbered filter would silently change its meaning.
function _sftkMdHasLogic(xml) {
  const el = sftkMdFindElement(xml, 'booleanFilter', 0);
  return !!el && String(xml).slice(el.bodyStart, el.bodyEnd).trim() !== '';
}
function sftkMdEditField(type, innerXml, objApi, fieldApi, newField) {
  const before = String(innerXml || '');
  const nf = newField ? String(newField) : null;
  const how = [];
  let xml = before, refused = null, off = false, suggested = false;
  const refuse = why => { if (!refused) refused = why; };
  const plural = (n, w, ws) => `${n} ${n === 1 ? w : (ws || `${w}s`)}`;
  const verb = nf ? `now ${nf}` : 'removed';
  // a criteria-like element whose <child> names the field: dropped or renamed
  const items = (src, tag, child) => {
    let n = 0;
    const r = _sftkMdWalk(src, tag, body => {
      const el = sftkMdFindElement(body, child, 0);
      if (!el) return 'keep';
      const v = sftkMdUnescape(body.slice(el.bodyStart, el.bodyEnd));
      if (!_sftkMdFieldIs(v, objApi, fieldApi)) return 'keep';
      n++;
      return nf ? { body: body.slice(0, el.bodyStart) + sftkMdEscape(_sftkMdRenameVal(v, nf)) + body.slice(el.bodyEnd) } : 'drop';
    });
    return { xml: r.xml, n, left: r.kept };
  };
  // a list member whose TEXT is the field (<fields>X</fields>)
  const texts = (src, tag) => {
    let n = 0;
    const r = _sftkMdWalk(src, tag, body => {
      if (/</.test(body) || !_sftkMdFieldIs(sftkMdUnescape(body), objApi, fieldApi)) return 'keep';
      n++;
      return nf ? { body: sftkMdEscape(_sftkMdRenameVal(sftkMdUnescape(body), nf)) } : 'drop';
    });
    return { xml: r.xml, n, left: r.kept };
  };
  // formula text: ⇄ swaps the token; ✂ only counts it (a formula is never cut)
  const formulas = (src, tag) => {
    let n = 0;
    const r = _sftkMdWalk(src, tag, body => {
      const s = _sftkMdSwapToken(body, objApi, fieldApi, nf);
      n += s.n;
      return (nf && s.n) ? { body: s.text } : 'keep';
    });
    return { xml: r.xml, n };
  };
  switch (type) {
    case 'ValidationRuleInactive':
    case 'ValidationRule': {
      const f = formulas(xml, 'errorConditionFormula');
      if (!f.n) { refuse('the rule’s formula does not name the field as a whole token — edit it in Setup'); break; }
      if (nf) { xml = f.xml; how.push(`formula: ${plural(f.n, 'reference')} ${verb}`); break; }
      const act = sftkMdFindElement(xml, 'active', 0);
      if (!act || xml.slice(act.bodyStart, act.bodyEnd).trim() !== 'true') { refuse('the rule is already inactive — an inactive rule does not block the delete; re-scan'); break; }
      // ✂ suggests the formula without the conditions that use the field; the rule stays on (user 2026-11-10)
      const fe = sftkMdFindElement(xml, 'errorConditionFormula', 0);
      const d = fe ? sftkFormulaDropField(sftkMdUnescape(xml.slice(fe.bodyStart, fe.bodyEnd)), objApi, fieldApi) : { mode: 'none' };
      if (d.mode === 'operand') {
        xml = xml.slice(0, fe.bodyStart) + sftkMdEscape(d.text) + xml.slice(fe.bodyEnd);
        suggested = true;
        how.push(`suggested: ${plural(d.n, 'condition')} that use${d.n === 1 ? 's' : ''} the field taken out of the formula — the rule stays active`);
        break;
      }
      // every condition uses the field: nothing would be left of the formula, so the suggestion is to switch it off
      xml = xml.slice(0, act.bodyStart) + 'false' + xml.slice(act.bodyEnd);
      off = true;
      how.push('suggested: switch the rule off — every condition of its formula uses the field, so nothing would be left');
      break;
    }
    case 'CustomField': {
      const f = formulas(xml, 'formula');
      const r = items(f.xml, 'summaryFilterItems', 'field');
      const sum = texts(r.xml, 'summarizedField');
      if (!nf && (f.n || sum.n)) { refuse(f.n ? 'a formula cannot lose a reference — ⇄ Replace it with another field, or 🗑 delete this formula field' : 'the roll-up sums this field — ⇄ Replace it, or 🗑 delete the roll-up field'); break; }
      if (!f.n && !r.n && !sum.n) { refuse('no formula, roll-up filter or summarized field names the field — edit it in Setup'); break; }
      xml = sum.xml;
      if (f.n) how.push(`formula: ${plural(f.n, 'reference')} ${verb}`);
      if (r.n) how.push(`roll-up filter: ${plural(r.n, 'criterion', 'criteria')} ${verb}`);
      if (sum.n) how.push(`summarized field ${verb}`);
      break;
    }
    case 'LookupFilter': {
      const lf = sftkMdFindElement(xml, 'lookupFilter', 0);
      if (!lf) { refuse('the field has no lookup filter any more — re-scan'); break; }
      const body = xml.slice(lf.bodyStart, lf.bodyEnd);
      const r = items(body, 'filterItems', 'field');
      if (!r.n) { refuse('no filter condition names the field — edit the filter in Setup'); break; }
      if (!nf && _sftkMdHasLogic(body)) { refuse('the filter’s logic numbers its conditions — taking one out changes what the others mean; edit it in Setup, or 🗑 remove the whole filter'); break; }
      if (!nf && r.left === 0) { xml = xml.slice(0, lf.start) + xml.slice(lf.end); how.push('the filter had no other condition — the whole lookup filter is removed; the lookup field and its data stay'); break; }
      xml = xml.slice(0, lf.bodyStart) + r.xml + xml.slice(lf.bodyEnd);
      how.push(`filter: ${plural(r.n, 'condition')} ${verb}${nf ? '' : `, ${plural(r.left, 'condition')} kept`}`);
      break;
    }
    case 'WebLink':
    case 'RestrictionRule': {
      const what = type === 'WebLink' ? 'URL' : 'record filter';
      const f = formulas(xml, type === 'WebLink' ? 'url' : 'recordFilter');
      if (!f.n) { refuse(`the ${what} does not name the field as a whole token — edit it in Setup`); break; }
      if (!nf) { refuse(type === 'WebLink' ? 'a URL cannot lose a merge field and keep working — ⇄ Replace it with another field, or 🗑 delete the button' : 'a record filter cannot lose a condition here — ⇄ Replace it with another field, or 🗑 delete the rule'); break; }
      xml = f.xml; how.push(`${what}: ${plural(f.n, 'reference')} ${verb}`);
      break;
    }
    case 'WorkflowFieldUpdate': {
      const fe = sftkMdFindElement(xml, 'field', 0);
      const target = !!fe && _sftkMdFieldIs(sftkMdUnescape(xml.slice(fe.bodyStart, fe.bodyEnd)), objApi, fieldApi);
      const f = formulas(xml, 'formula');
      if (!nf && target) { refuse('the field update WRITES to this field — ⇄ Replace points it at another field, or 🗑 delete the field update'); break; }
      if (!nf && f.n) { refuse('its formula cannot lose a reference — ⇄ Replace it, or 🗑 delete the field update'); break; }
      if (!target && !f.n) { refuse('neither its target nor its formula names the field — edit it in Setup'); break; }
      xml = f.xml;
      if (target) {
        const e2 = sftkMdFindElement(xml, 'field', 0);
        xml = xml.slice(0, e2.bodyStart) + sftkMdEscape(_sftkMdRenameVal(sftkMdUnescape(xml.slice(e2.bodyStart, e2.bodyEnd)), nf)) + xml.slice(e2.bodyEnd);
        how.push(`target field ${verb}`);
      }
      if (f.n) how.push(`formula: ${plural(f.n, 'reference')} ${verb}`);
      break;
    }
    case 'WorkflowRule':
    case 'SharingCriteriaRule': {
      const f = formulas(xml, 'formula');
      if (!nf && f.n) { refuse('its formula cannot lose a reference — ⇄ Replace it, or 🗑 delete it'); break; }
      const r = items(f.xml, 'criteriaItems', 'field');
      if (!r.n && !f.n) { refuse('no criterion names the field — edit it in Setup'); break; }
      if (!nf && r.n && _sftkMdHasLogic(xml)) { refuse('its filter logic numbers the criteria — taking one out changes what the others mean; ⇄ Replace, or edit it in Setup'); break; }
      if (!nf && r.left === 0 && !sftkMdFindElement(xml, 'formula', 0)) { refuse(`its only criterion is this field — with none left it would ${type === 'WorkflowRule' ? 'fire on every record' : 'share every record'}; ⇄ Replace it, or 🗑 delete it`); break; }
      xml = r.xml;
      if (r.n) how.push(`criteria: ${plural(r.n, 'line')} ${verb}${nf ? '' : `, ${plural(r.left, 'line')} kept`}`);
      if (f.n) how.push(`formula: ${plural(f.n, 'reference')} ${verb}`);
      break;
    }
    case 'MatchingRule': {
      const r = items(xml, 'matchingRuleItems', 'fieldName');
      if (!r.n) { refuse('no matching item names the field — edit it in Setup'); break; }
      if (!nf && _sftkMdHasLogic(xml)) { refuse('its filter logic numbers the items — ⇄ Replace, or edit it in Setup'); break; }
      if (!nf && r.left === 0) { refuse('its only matching item is this field — a matching rule needs at least one; ⇄ Replace it, or 🗑 delete it'); break; }
      xml = r.xml; how.push(`matching items: ${plural(r.n, 'item')} ${verb}${nf ? '' : `, ${plural(r.left, 'item')} kept`}`);
      break;
    }
    case 'WorkflowAlert': {
      const r = items(xml, 'recipients', 'field');
      if (!r.n) { refuse('no recipient is the field — edit the alert in Setup'); break; }
      if (!nf && r.left === 0 && !sftkMdFindElement(xml, 'ccEmails', 0)) { refuse('the field is the alert’s only recipient — an alert must send to someone; ⇄ Replace it with another email field, or 🗑 delete the alert'); break; }
      xml = r.xml; how.push(`recipients: ${plural(r.n, 'recipient')} ${verb}${nf ? '' : `, ${plural(r.left, 'recipient')} kept`}`);
      break;
    }
    case 'WorkflowOutboundMessage': {
      const r = texts(xml, 'fields');
      if (!r.n) { refuse('the message does not send the field — edit it in Setup'); break; }
      if (!nf && r.left === 0) { refuse('the field is the only one the message sends — ⇄ Replace it, or 🗑 delete the message'); break; }
      xml = r.xml; how.push(nf ? `fields sent: the field is ${verb}` : `fields sent: the field removed, ${plural(r.left, 'field')} still sent`);
      break;
    }
    case 'FieldSet': {
      let n = 0;
      for (const tag of ['displayedFields', 'availableFields']) { const r = items(xml, tag, 'field'); xml = r.xml; n += r.n; }
      if (!n) { refuse('the field set does not list the field — edit it in Setup'); break; }
      how.push(`field set: the field ${nf ? verb : 'taken out'}`);
      break;
    }
    case 'AssignmentRule':
    case 'AutoResponseRule':
    case 'EscalationRule': {
      let hits = 0, dropped = 0, logic = false, formulaCut = false;
      const r = _sftkMdWalk(xml, 'ruleEntry', body => {
        const f = formulas(body, 'formula');
        if (f.n && !nf) { formulaCut = true; return 'keep'; }
        const c = items(f.xml, 'criteriaItems', 'field');
        hits += c.n + f.n;
        if (!c.n && !f.n) return 'keep';
        if (!nf && _sftkMdHasLogic(body)) { logic = true; return 'keep'; }
        if (!nf && c.left === 0 && !sftkMdFindElement(body, 'formula', 0)) { dropped++; return 'drop'; }
        return { body: c.xml };
      });
      if (formulaCut) { refuse('a rule entry’s formula names the field — a formula cannot lose a reference; ⇄ Replace it, or edit the entry in Setup'); break; }
      if (logic) { refuse('a rule entry’s filter logic numbers its criteria — ⇄ Replace, or edit it in Setup'); break; }
      if (!hits) { refuse('no rule entry names the field — edit it in Setup'); break; }
      if (!nf && r.kept === 0) { refuse('every entry of the rule hangs on this field — with none left the rule does nothing; ⇄ Replace it, or 🗑 delete the rule'); break; }
      xml = r.xml;
      how.push(nf ? `rule entries: ${plural(hits, 'reference')} ${verb}` : `rule entries: the field’s criteria removed${dropped ? `; ${plural(dropped, 'entry', 'entries')} whose only criterion it was dropped` : ''}, ${plural(r.kept, 'entry', 'entries')} kept`);
      break;
    }
    case 'ApprovalProcess': {
      let hits = 0, emptied = false, logic = false, formulaCut = false;
      const r = _sftkMdWalk(xml, 'entryCriteria', body => {
        const f = formulas(body, 'formula');
        if (f.n && !nf) { formulaCut = true; return 'keep'; }
        const c = items(f.xml, 'criteriaItems', 'field');
        hits += c.n + f.n;
        if (!c.n && !f.n) return 'keep';
        if (!nf && _sftkMdHasLogic(body)) { logic = true; return 'keep'; }
        if (!nf && c.left === 0 && !sftkMdFindElement(body, 'formula', 0)) { emptied = true; return 'keep'; }
        return { body: c.xml };
      });
      const pages = _sftkMdWalk(r.xml, 'approvalPageFields', body => { const t = texts(body, 'field'); hits += t.n; return t.n ? { body: t.xml } : 'keep'; });
      if (formulaCut) { refuse('the entry criteria are a formula that names the field — ⇄ Replace it, or edit the process in Setup'); break; }
      if (logic) { refuse('the criteria’s filter logic numbers them — ⇄ Replace, or edit the process in Setup'); break; }
      if (emptied) { refuse('the field is the only entry criterion — with none left EVERY record could enter the process; ⇄ Replace it, or 🗑 delete the process'); break; }
      if (!hits) { refuse('no criterion or page field names the field — edit the process in Setup'); break; }
      xml = pages.xml; how.push(`criteria and page fields: ${plural(hits, 'reference')} ${verb}`);
      break;
    }
    case 'DuplicateRule': {
      const fl = sftkMdFindElement(xml, 'duplicateRuleFilter', 0);
      if (!fl) { refuse('the rule has no record filter — re-scan'); break; }
      const body = xml.slice(fl.bodyStart, fl.bodyEnd);
      const r = items(body, 'duplicateRuleFilterItems', 'field');
      if (!r.n) { refuse('no filter line names the field — edit it in Setup'); break; }
      if (!nf && _sftkMdHasLogic(body)) { refuse('the filter’s logic numbers its lines — ⇄ Replace, or edit it in Setup'); break; }
      if (!nf && r.left === 0) { xml = xml.slice(0, fl.start) + xml.slice(fl.end); how.push('the filter had no other line — the record filter is removed, the rule now checks every record'); break; }
      let i = 0;
      const ren = _sftkMdWalk(r.xml, 'duplicateRuleFilterItems', b => { i++; const so = sftkMdFindElement(b, 'sortOrder', 0); return so ? { body: b.slice(0, so.bodyStart) + String(i) + b.slice(so.bodyEnd) } : 'keep'; });
      xml = xml.slice(0, fl.bodyStart) + (nf ? r.xml : ren.xml) + xml.slice(fl.bodyEnd);
      how.push(`record filter: ${plural(r.n, 'line')} ${verb}${nf ? '' : `, ${plural(r.left, 'line')} kept`}`);
      break;
    }
    case 'ListView': {
      const c = texts(xml, 'columns');
      const fl = sftkMdFindElement(c.xml, 'filters', 0);
      const r = items(c.xml, 'filters', 'field');
      if (!c.n && !r.n) { refuse('no column or filter of the view names the field — edit it in Setup'); break; }
      if (!nf && r.n && _sftkMdHasLogic(xml)) { refuse('the view’s filter logic numbers its filters — ⇄ Replace, or edit it in Setup'); break; }
      if (!nf && c.n && !c.left && !fl) { refuse('the field is the view’s only column — ⇄ Replace it, or 🗑 delete the view'); break; }
      xml = r.xml;
      const bits = []; if (c.n) bits.push(`${plural(c.n, 'column')} ${verb}`); if (r.n) bits.push(`${plural(r.n, 'filter')} ${verb}`);
      how.push(bits.join(', '));
      break;
    }
    case 'CompactLayout': {
      const c = texts(xml, 'fields');
      if (!c.n) { refuse('the compact layout does not list the field — edit it in Setup'); break; }
      if (!nf && !c.left) { refuse('the field is the layout’s only field — ⇄ Replace it, or 🗑 delete the compact layout'); break; }
      xml = c.xml; how.push(`${plural(c.n, 'field')} ${verb}`);
      break;
    }
    case 'QuickAction': {
      const li = items(xml, 'quickActionLayoutItems', 'field');
      const fo = items(li.xml, 'fieldOverrides', 'field');
      if (!li.n && !fo.n) { refuse('neither the action’s layout nor its predefined values name the field — edit it in Setup'); break; }
      xml = fo.xml;
      const bits = []; if (li.n) bits.push(`${plural(li.n, 'layout field')} ${verb}`); if (fo.n) bits.push(`${plural(fo.n, 'predefined value')} ${verb}`);
      how.push(bits.join(', '));
      break;
    }
    case 'CustomMetadataRecord': {
      let n = 0;
      const r = _sftkMdWalk(xml, 'values', body => {
        const ve = sftkMdFindElement(body, 'value', 0);
        if (!ve) return 'keep';
        const v = sftkMdUnescape(body.slice(ve.bodyStart, ve.bodyEnd));
        if (!_sftkMdFieldIs(v, objApi, fieldApi)) return 'keep';
        n++;
        const open = body.slice(ve.start, ve.bodyStart);
        return { body: body.slice(0, ve.start) + (nf ? `${open}${sftkMdEscape(_sftkMdRenameVal(v, nf))}</value>` : '<value xsi:nil="true"/>') + body.slice(ve.end) };
      });
      if (!n) { refuse('no value of the record holds the field — edit it in Setup'); break; }
      xml = r.xml; how.push(`${plural(n, 'value')} ${nf ? verb : 'emptied'}`);
      break;
    }
    case 'LeadConvertSettings': {
      if (!nf) {
        const r = sftkMdLeadMappingRemove(xml, objApi, fieldApi);
        if (!r.removed) { refuse('no mapping line carries the field — re-scan'); break; }
        xml = r.xml; how.push(`${plural(r.removed, 'mapping line')} removed, the other lines kept`);
        break;
      }
      let n = 0;
      const o = String(objApi || '').toLowerCase();
      const r = _sftkMdWalk(xml, 'objectMapping', body => {
        const io = (sftkMdChildText(body, 'inputObject') || '').toLowerCase(), oo = (sftkMdChildText(body, 'outputObject') || '').toLowerCase();
        const m = _sftkMdWalk(body, 'mappingFields', mb => {
          let out = mb, hit = false;
          for (const [side, objOf] of [['inputField', io], ['outputField', oo]]) {
            const e = sftkMdFindElement(out, side, 0);
            if (e && objOf === o && _sftkMdFieldIs(sftkMdUnescape(out.slice(e.bodyStart, e.bodyEnd)), objApi, fieldApi)) { out = out.slice(0, e.bodyStart) + sftkMdEscape(nf) + out.slice(e.bodyEnd); hit = true; n++; }
          }
          return hit ? { body: out } : 'keep';
        });
        return m.changed ? { body: m.xml } : 'keep';
      });
      if (!n) { refuse('no mapping line carries the field — re-scan'); break; }
      xml = r.xml; how.push(`${plural(n, 'mapping line')} now ${nf}`);
      break;
    }
    default:
      refuse('this kind is not edited here — 🗑 delete it, or edit it in Setup');
  }
  if (refused) return { xml: before, changed: false, how: [], refused };
  // off: the edit switches a validation rule off; suggested: the edit is a proposal the user should read and may edit
  return { xml, changed: xml !== before, how, refused: null, off, suggested };
}
// Which ways a kind has: ✂ remove and/or ⇄ replace. Formula-ish kinds are
// Replace only; the rest can take the field out of their structure. null =
// not edited here (code, bundles, a whole Lightning page — 🗑 or Setup).
function sftkMdEditWays(type) {
  const t = {
    ValidationRule: 'rr', CustomField: 'r', LookupFilter: 'rr', WebLink: 'r', RestrictionRule: 'r', WorkflowFieldUpdate: 'r',
    WorkflowRule: 'rr', SharingCriteriaRule: 'rr', MatchingRule: 'rr', WorkflowAlert: 'rr', WorkflowOutboundMessage: 'rr', FieldSet: 'rr',
    AssignmentRule: 'rr', AutoResponseRule: 'rr', EscalationRule: 'rr', ApprovalProcess: 'rr', DuplicateRule: 'rr',
    CustomMetadataRecord: 'rr', LeadConvertSettings: 'rr',
    ListView: 'rr', CompactLayout: 'rr', QuickAction: 'rr', ValidationRuleInactive: 'r',
  }[type];
  return t ? { remove: t === 'rr', replace: true } : null;
}
// ⇄ in CODE (user 2026-11-08: "צריך להיות בכולם"): the field's API name, as a whole word, in every file of an
// Apex class or trigger, a Visualforce page or component, an LWC or an Aura bundle — "Object.Field" and the bare
// name alike, the rest of the line as the code wrote it. Pure: sources in, sources out.
//   sources: [{ path, source, … }] → { sources: [{ …, source, n }], n (places), files (files that changed) }
function sftkMdCodeReplace(sources, fieldApi, newField) {
  const f = String(fieldApi || '').trim(), nf = String(newField || '').trim();
  const escRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = f ? new RegExp(`(?<![A-Za-z0-9_])${escRx(f)}(?![A-Za-z0-9_])`, 'gi') : null;
  let n = 0, files = 0;
  const out = (sources || []).map(s => {
    let k = 0;
    const src = String(s.source == null ? '' : s.source);
    const text = re && nf ? src.replace(re, () => { k++; return nf; }) : src;
    if (k) { n += k; files++; }
    return { ...s, source: text, n: k };
  });
  return { sources: out, n, files };
}
// The lines of one source that name the field (whole word): [{ line (1-based), text }].
function sftkMdCodeHits(source, fieldApi) {
  const f = String(fieldApi || '').trim();
  if (!f) return [];
  const re = new RegExp(`(?<![A-Za-z0-9_])${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'i');
  const out = [];
  String(source == null ? '' : source).split(/\r\n?|\n/).forEach((text, i) => { if (re.test(text)) out.push({ line: i + 1, text }); });
  return out;
}
// The ways code has: ⇄ (a whole-word rename of the field's API name) and ✎ (an editor, file by file). Never ✂ —
// which line of a program goes is the owner's to decide, in ✎. null = not code.
function sftkMdCodeWays(type) {
  const s = sftkMdDeleteSpec(type);
  return s && (s.code || s.bundle) ? { replace: true, edit: true, remove: false } : null;
}
// Two sources read as the same text when only line endings and trailing blanks differ (Salesforce may hand back
// LF for CRLF, and trims a file's tail).
function sftkMdCodeSame(a, b) {
  const norm = s => String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
  return norm(a) === norm(b);
}

// Readable XML for the inspector and the edit dialog: one element per line,
// a leaf on one line with its text. Display only — never deployed.
function sftkMdPretty(xml) {
  const toks = String(xml || '').split(/(<[^>]+>)/).filter(t => t !== '');
  const out = [];
  let depth = 0, i = 0;
  const pad = () => '  '.repeat(depth);
  while (i < toks.length) {
    const t = toks[i];
    if (/^<\//.test(t)) { depth = Math.max(0, depth - 1); out.push(pad() + t); i++; continue; }
    if (/^<[A-Za-z]/.test(t) && !/\/>$/.test(t)) {
      const nx = toks[i + 1], nx2 = toks[i + 2];
      if (nx != null && !/^</.test(nx) && nx2 && /^<\//.test(nx2)) { out.push(pad() + t + nx + nx2); i += 3; continue; }   // a leaf's text exactly as it is (the editor deploys it)
      if (nx && /^<\//.test(nx)) { out.push(pad() + t + nx); i += 2; continue; }
      out.push(pad() + t); depth++; i++; continue;
    }
    if (/^</.test(t)) { out.push(pad() + t); i++; continue; }
    const txt = t.trim();
    if (txt) out.push(pad() + txt);
    i++;
  }
  return out.join('\n');
}
// Line diff (longest common subsequence) of two pretty texts:
// [{ op: ' ' | '-' | '+', line }].
function sftkMdLineDiff(a, b) {
  const A = String(a || '').split('\n'), B = String(b || '').split('\n');
  const n = A.length, m = B.length;
  if (n * m > 1000000) return [...A.map(line => ({ op: '-', line })), ...B.map(line => ({ op: '+', line }))];
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ op: ' ', line: A[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ op: '-', line: A[i] }); i++; }
    else { out.push({ op: '+', line: B[j] }); j++; }
  }
  while (i < n) out.push({ op: '-', line: A[i++] });
  while (j < m) out.push({ op: '+', line: B[j++] });
  return out;
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkMdEditField = sftkMdEditField;
  globalThis.sftkFormulaDropField = sftkFormulaDropField;
  globalThis.sftkMdEditWays  = sftkMdEditWays;
  globalThis.sftkMdPretty    = sftkMdPretty;
  globalThis.sftkMdLineDiff  = sftkMdLineDiff;
}

// Is this text well-formed XML (for the ✎ editor)? A tag-balance check, pure — the
// extension pages enforce Trusted Types, so DOMParser is not used for it. Returns
// null when it is, or the first problem with its line number.
function sftkMdWellFormed(text) {
  const s = String(text == null ? '' : text);
  const stack = [];
  const lineAt = i => s.slice(0, i).split('\n').length;
  const re = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|<|&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);)/g;
  let m;
  while ((m = re.exec(s))) {
    const t = m[0];
    if (t === '<') return `line ${lineAt(m.index)}: a “<” that does not open a tag (write &lt; for a literal one)`;
    if (t === '&') return `line ${lineAt(m.index)}: an “&” that is not an entity (write &amp; for a literal one)`;
    if (!m[2]) continue;                                   // CDATA, comment, processing instruction
    if (m[4]) continue;                                    // <x/>
    if (!m[1]) { stack.push({ name: m[2], at: m.index }); continue; }
    const open = stack.pop();
    if (!open) return `line ${lineAt(m.index)}: </${m[2]}> closes nothing`;
    if (open.name !== m[2]) return `line ${lineAt(m.index)}: <${open.name}> (line ${lineAt(open.at)}) is closed by </${m[2]}>`;
  }
  if (stack.length) { const o = stack[stack.length - 1]; return `line ${lineAt(o.at)}: <${o.name}> is never closed`; }
  return null;
}
if (typeof globalThis !== 'undefined') globalThis.sftkMdWellFormed = sftkMdWellFormed;
