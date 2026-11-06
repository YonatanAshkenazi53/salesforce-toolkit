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
    + `<${metadataType} xmlns="http://soap.sforce.com/2006/04/metadata">`
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
  for (const v of sftkMdChildren(innerXml, 'values')) {
    const val = (sftkMdChildText(v.innerXml, 'value') || '').trim().toLowerCase();
    if (val === f || val === `${o}.${f}`) out.push(sftkMdChildText(v.innerXml, 'field') || '?');
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
