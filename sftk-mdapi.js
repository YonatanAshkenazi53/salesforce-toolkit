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
// visit(field, table, label, reach): reach(objApi) says whose field a column of objApi's table names —
// 'plain' (Field__c), 'this' (a lookup path that ends on objApi: Parent.Field__c on Account), 'other' (a path that ends
// on another object: Owner.Field__c is User's) or 'unknown' (a custom lookup, Parent__r.Field__c, whose object the XML
// does not tell); null when the column is not under objApi's own table (2026-11-14 review: Owner.Region__c on an
// Account table is User.Region__c, and counting it blocked the fix of the plain column).
// A column of ANOTHER table whose lookup path ends on objApi is objApi's field too: 'this' (2026-11-14 review 5 —
// Owner.Region__c on a Case table is User.Region__c, as every formula / flow / page remover reads it; the report-type
// code never saw it, so ✂ / ⇄ of User.Region__c failed with a false "has no column of User.Region__c"). Anything else
// on another table — a plain column, a path ending elsewhere or not told, a joined table (Account.Contacts, whose
// object its relationship name does not tell) — stays null: never counted, never edited.
// "objApi's own table" also takes Task and Event when objApi is Activity (sftkMdIsOwnObj).
function sftkRtEdit(innerXml, visit) {
  // Each hop is resolved by the ONE shared resolver, sftkRelWalk / sftkRelHop in sftk-relmap.js (2026-11-14): this
  // function kept a private copy of the map that drifted from the other copies. Parent on an EmailMessage type is Case
  // (review 4: ✂ dropped its Parent.Region__c column), on Attachment / Note… any object; a custom lookup (Lookup__r)
  // or a What / Who does not tell its object; any other standard lookup is named for its object (Asset, Entitlement…).
  const _reach = (field, table, objApi) => {
    const t = String(table || '').trim().toLowerCase();
    const segs = String(field).toLowerCase().split('.');
    segs.pop();
    if (!t || t.indexOf('.') >= 0) return null;
    if (!sftkMdIsOwnObj(t, objApi)) {
      if (!segs.length) return null;
      const x = sftkRelWalk(t, segs);
      return !x.kind && sftkMdIsOwnObj(x.obj, objApi) ? 'this' : null;
    }
    if (!segs.length) return 'plain';
    const r = sftkRelWalk(t, segs);
    if (r.kind) return 'unknown';
    return sftkMdIsOwnObj(r.obj, objApi) ? 'this' : 'other';
  };
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
      const d = visit(field, table, label, objApi => _reach(field, table, objApi));
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
// A column names the field plainly (<field>Field</field>) or REACHED THROUGH A LOOKUP of the
// table (<field>Parent.Field</field>). The lookup form was not seen at all, so ✂ answered
// "removed — verified" while the type still named the field (2026-11-14). Which object the
// lookup reaches cannot be told from the XML (Parent → this object, Owner → User), so the
// lookup form is counted when its path ends on this object (Parent → Account) or on an object the XML does not tell
// (Lookup__r); a path that ends on another object (Owner → User) is that object's field and not counted (2026-11-14
// review). The removers edit a path that ends on this object like a plain column; an unknown path is never edited —
// they name it in `viaLookup` (and `skipped`).
// The path may stand on ANOTHER table and end on this object (Owner.Region__c on a Case table is User.Region__c):
// counted and edited like the rest (2026-11-14 review 5) — sftkRtEdit's reach answers 'this' for it. A path of another
// table whose object is not told is that table's business and stays out of the count (null), as before.
function sftkRtMentions(innerXml, objApi, fieldApi) {
  const f = String(fieldApi || '').toLowerCase();
  let n = 0;
  sftkRtEdit(innerXml, (field, table, label, reach) => {
    const x = field.toLowerCase();
    if (!(x === f || x.endsWith('.' + f))) return 'keep';
    const how = reach(objApi);
    if (how === 'plain' || how === 'this' || how === 'unknown') n++;
    return 'keep';
  });
  return n;
}

// ✂ Remove: the column goes; a same-named field under another table is
// listed in `skipped`, never touched.
function sftkRtRemoveField(innerXml, objApi, fieldApi) {
  const f = String(fieldApi || '').toLowerCase();
  const skipped = [];
  const viaLookup = [];
  const r = sftkRtEdit(innerXml, (field, table, label, reach) => {
    const x = field.toLowerCase();
    if (!(x === f || x.endsWith('.' + f))) return 'keep';
    const how = reach(objApi);
    if (how === 'plain' || how === 'this') return 'drop';
    if (how === 'unknown') viaLookup.push(`${table}.${field} in “${label}” (reached through a lookup)`);
    else if (how === null && x === f) skipped.push(`${table}.${field} in “${label}”`);
    return 'keep';
  });
  return { xml: r.xml, removed: r.dropped, emptied: r.emptied, skipped: [...viaLookup, ...skipped], viaLookup, changed: r.dropped > 0 };
}

// ⇄ Replace: the column names the new field in place — a plain column (Field) and a lookup path that ends on this
// object (Parent.Field → Parent.NewField) alike. When the renamed column is already on the same table, the old one is
// removed instead (a column may appear once): `dropped` counts those, and `newAlreadyThere` says the PLAIN new field
// was already a column. One pass for both, so a Parent.Field column is renamed even when the plain new field is
// already there (review 2, 2026-11-14: it was dropped with the plain column, the parent's column lost).
// A column may appear once PER TABLE, so the columns already there are keyed by table: Owner.Region__c on a Case table
// (User's field, review 5 2026-11-14) is renamed against the Case table's columns, not this object's.
function sftkRtReplaceField(innerXml, objApi, fieldApi, newFieldApi) {
  const f = String(fieldApi || '').toLowerCase();
  const nf = String(newFieldApi || '').toLowerCase();
  const skipped = [];
  const viaLookup = [];
  const key = (table, field) => `${String(table).trim().toLowerCase()}|${String(field).toLowerCase()}`;
  // the columns already on each table: a column renamed onto one of them is dropped instead (a column appears once)
  const have = new Set();
  // a PLAIN column of the new field on this object's own table only: Parent.NewField is not its own column (2026-11-14)
  let newAlreadyThere = false;
  sftkRtEdit(innerXml, (field, table, label, reach) => {
    have.add(key(table, field));
    if (field.toLowerCase() === nf && reach(objApi) === 'plain') newAlreadyThere = true;
    return 'keep';
  });
  let dropped = 0;
  const onto = (table, to) => {
    if (have.has(key(table, to))) return null;
    have.add(key(table, to));
    return { rename: to };
  };
  const r = sftkRtEdit(innerXml, (field, table, label, reach) => {
    const x = field.toLowerCase();
    if (!(x === f || x.endsWith('.' + f))) return 'keep';
    const how = reach(objApi);
    if (how === 'plain' || how === 'this') {
      const d = onto(table, field.slice(0, field.length - f.length) + newFieldApi);
      if (!d) { dropped++; return 'drop'; }
      return d;
    }
    if (how === 'unknown') viaLookup.push(`${table}.${field} in “${label}” (reached through a lookup)`);
    else if (how === null && x === f) skipped.push(`${table}.${field} in “${label}”`);
    return 'keep';
  });
  return { xml: r.xml, swapped: r.renamed, dropped, emptied: r.emptied, skipped: [...viaLookup, ...skipped], viaLookup, newAlreadyThere, changed: r.renamed + dropped > 0 };
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
// a mapping's <inputField>/<outputField>, a workflow time trigger's
// <offsetFromField> — added 2026-11-14) holds "Field__c" or
// "Object.Field__c", or when a formula-carrying element (<formula>,
// <errorConditionFormula>, <recordFilter>) mentions the field as a whole
// token. Case-insensitive, as Salesforce is.
function sftkMdMentionsField(innerXml, objApi, fieldApi) {
  const s = String(innerXml || '');
  const f = String(fieldApi || '').toLowerCase(), o = String(objApi || '').toLowerCase();
  if (!f) return false;
  const nameRe = /<(?:[A-Za-z0-9_.-]+:)?(field|fieldName|fields|inputField|outputField|leftValueReference|offsetFromField)(?:\s[^>]*)?>([^<]*)<\//g;
  let m;
  while ((m = nameRe.exec(s))) {
    const v = sftkMdUnescape(m[2]).trim().toLowerCase();
    if (v === f || v === `${o}.${f}` || v.endsWith(`.${f}`)) return true;
  }
  // an approval step's approver can be a User lookup of the record (<approver><name>Field__c</name>
  // <type>relatedUserField</type>) — a targeted pattern, as <name> elsewhere is an API name, not a field (2026-11-14)
  const apRe = /<approver>\s*<name>([^<]*)<\/name>\s*<type>relatedUserField<\/type>/g;
  while ((m = apRe.exec(s))) {
    if (_sftkMdFieldIs(sftkMdUnescape(m[1]), o, f)) return true;   // the edit's own test (Task. / Event. for Activity, review 7)
  }
  const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tokenRe = new RegExp(`(^|[^a-z0-9_])${esc}([^a-z0-9_]|$)`, 'i');
  // an entitlement process's <milestoneCriteriaFormula> / <exitCriteriaFormula> too: MetadataComponentDependency
  // returns nothing for them, so this test is the scan's only eye on them (2026-11-14)
  const formulaRe = /<(?:[A-Za-z0-9_.-]+:)?(formula|errorConditionFormula|recordFilter|booleanFilter|milestoneCriteriaFormula|exitCriteriaFormula)(?:\s[^>]*)?>([^<]*)<\//g;
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
// detail = true → { hold, unclear }: hold = the record's fields that hold THIS object's field; unclear = fields holding
// a bare "Field__c" while the record names this object AND another one with no clear pairing — the scan still counts
// them (they may be this field: the plain call returns hold + unclear), the edit refuses rather than rename another
// object's field (2026-11-14 review 4).
// Pairing: a field value goes with the object value of the same prefix — Source_Field__c with Source_Object__c,
// Target_Field__c with Target_Object__c (…Field / …FieldName / …Field_API_Name against …Object / …SObject / …Entity…).
// A mapping record (Source_Object__c = Lead, Target_Object__c = Account, both fields Region__c) had both values renamed
// on ⇄ Account.Region__c — Lead's among them.
function sftkMdValuesHolding(innerXml, objApi, fieldApi, detail) {
  const f = String(fieldApi || '').toLowerCase(), o = String(objApi || '').toLowerCase();
  const out = [], unclear = [];
  const vals = sftkMdChildren(innerXml, 'values').map(v => ({ field: sftkMdChildText(v.innerXml, 'field') || '?', val: (sftkMdChildText(v.innerXml, 'value') || '').trim() }));
  // A bare "Field__c" names a field of the object the record's OTHER value names (an Entity Definition
  // relationship stores "Account" in one field and "Field__c" in another). When that other value is a
  // DIFFERENT object, the bare name is not this object's field (found 2026-11-08: the demo record with
  // Entity__c = Account was listed as a blocker for Lead.SFTK_Live_Blk__c and Case.SFTK_Live_Blk__c).
  const STD = /^(account|contact|lead|case|opportunity|user|campaign|asset|contract|order|product2|task|event|individual|quote|solution)$/;
  const objLike = x => /^[a-z][a-z0-9_]*$/.test(x) && (STD.test(x) || /__(c|mdt|x|b|e)$/.test(x));
  const otherObj = vals.some(v => { const x = v.val.toLowerCase(); return x !== o && x !== f && objLike(x); });
  const ownObj = vals.some(v => v.val.toLowerCase() === o);
  const fieldPre = n => { const m = /^(.*?)_?field(?:_?(?:api_?)?name)?$/.exec(String(n).toLowerCase().replace(/__c$/, '')); return m ? m[1] : null; };
  const objPre = n => { const m = /^(.*?)_?(?:s?object|entity)(?:_?(?:api_?)?(?:name|type))?$/.exec(String(n).toLowerCase().replace(/__c$/, '')); return m ? m[1] : null; };
  for (const v of vals) {
    const val = v.val.toLowerCase();
    if (val === `${o}.${f}`) { out.push(v.field); continue; }
    if (val !== f) continue;
    // the object value of the same prefix, when there is exactly one (Source_Field__c ↔ Source_Object__c)
    const pre = fieldPre(v.field);
    const pair = pre == null ? [] : [...new Set(vals.filter(w => w !== v && objPre(w.field) === pre && /^[a-z][a-z0-9_]*$/i.test(w.val)).map(w => w.val.toLowerCase()))];
    if (pair.length === 1) { if (pair[0] === o) out.push(v.field); continue; }
    if (ownObj && otherObj) unclear.push(v.field);
    if (ownObj || !otherObj) out.push(v.field);
  }
  return detail ? { hold: out.filter(x => !unclear.includes(x)), unclear } : out;
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
  ServiceChannel:          { folder: 'serviceChannels',   suffix: 'serviceChannel',   what: 'service channel' },   // 2026-11-11: its secondary routing priority field blocks, live
  EntitlementProcess:      { folder: 'entitlementProcesses', suffix: 'entitlementProcess', what: 'entitlement process' },   // 2026-11-11: blocks the delete, live
  RestrictionRule:         { folder: 'restrictionRules', suffix: 'rule',              what: 'scoping or restriction rule', tooling: 'RestrictionRule' },
  CustomMetadataRecord:    { mdType: 'CustomMetadata',   folder: 'customMetadata',    suffix: 'md',               what: 'custom metadata record' },
  CustomMetadataText:      { mdType: 'CustomMetadata',   folder: 'customMetadata',    suffix: 'md',               what: 'custom metadata record' },   // the same record, held as plain text (a mention, not a blocker)
  FlexiPage:               { folder: 'flexipages',       suffix: 'flexipage',         what: 'Lightning page',             tooling: 'FlexiPage' },
  ApexClass:               { code: 'Body',   folder: 'classes',    suffix: 'cls',       what: 'Apex class',            tooling: 'ApexClass',     metaTag: 'ApexClass' },
  ApexTrigger:             { code: 'Body',   folder: 'triggers',   suffix: 'trigger',   what: 'Apex trigger',          tooling: 'ApexTrigger',   metaTag: 'ApexTrigger' },
  // the same class / trigger, listed by Field Cleaner under 👀 when it names the field only inside a string
  // (dynamic SOQL, get('Field__c')) — owner 2026-11-18: "Go". Read, replaced, edited and deleted as the kinds above.
  ApexClassText:           { code: 'Body',   folder: 'classes',    suffix: 'cls',       what: 'Apex class',            tooling: 'ApexClass',     metaTag: 'ApexClass',   mdType: 'ApexClass' },
  ApexTriggerText:         { code: 'Body',   folder: 'triggers',   suffix: 'trigger',   what: 'Apex trigger',          tooling: 'ApexTrigger',   metaTag: 'ApexTrigger', mdType: 'ApexTrigger' },
  ApexPage:                { code: 'Markup', folder: 'pages',      suffix: 'page',      what: 'Visualforce page',      tooling: 'ApexPage',      metaTag: 'ApexPage' },
  ApexComponent:           { code: 'Markup', folder: 'components', suffix: 'component', what: 'Visualforce component', tooling: 'ApexComponent', metaTag: 'ApexComponent' },
  LightningComponentBundle: { bundle: 'lwc',  what: 'Lightning web component', tooling: 'LightningComponentBundle' },
  // the same bundle, listed by Field Cleaner under 👀 when it only NAMES the field as text (owner 2026-11-18: "why we
  // missed them?") — read, replaced, edited and deleted exactly as the kind above
  LwcText:                 { bundle: 'lwc',  what: 'Lightning web component', tooling: 'LightningComponentBundle', mdType: 'LightningComponentBundle' },
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
  // a path that shows the field as a key field of a step (owner 2026-11-16: "we said all items must have a
  // delete/remove"): EDITED here, never deleted — Salesforce refuses the delete of a path through its APIs. Live
  // 2026-11-16 (npc2): a destructive deploy and a Tooling DELETE both answer "insufficient access rights on
  // cross-reference id", for an active path, an inactive one, and one on a standard object. noDelete: no 🗑 is drawn.
  PathAssistant:           { mdType: 'PathAssistant',    folder: 'pathAssistants',    suffix: 'pathAssistant',    what: 'path',                       tooling: 'PathAssistant', noDelete: true },
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
//   extra: { status } for Apex (the Tooling Status: an Inactive trigger stays Inactive — a fixed "Active" switched a
//   trigger the admin had turned off back on, 2026-11-14; "Deleted" is never written back, a ⇄ / ✎ / restore must not
//   delete); { label, description, availableInTouch, confirmationTokenRequired } for Visualforce (what the page-meta
//   holds — left out, a deploy resets them to false / empty, 2026-11-14). Written in the schema's order.
function sftkMdCodeFiles(type, name, source, apiVersion, extra) {
  const s = sftkMdDeleteSpec(type);
  if (!s || !s.code) return null;
  const x = extra || {};
  const isApex = s.metaTag === 'ApexClass' || s.metaTag === 'ApexTrigger', isPage = s.metaTag === 'ApexPage';
  const meta = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + `<${s.metaTag} xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>${sftkMdEscape(_sftkApiVer(apiVersion))}</apiVersion>`
    + (isApex ? `<status>${x.status === 'Inactive' ? 'Inactive' : 'Active'}</status>` : '')
    + (isPage && typeof x.availableInTouch === 'boolean' ? `<availableInTouch>${x.availableInTouch}</availableInTouch>` : '')
    + (isPage && typeof x.confirmationTokenRequired === 'boolean' ? `<confirmationTokenRequired>${x.confirmationTokenRequired}</confirmationTokenRequired>` : '')
    + (!isApex && x.description ? `<description>${sftkMdEscape(x.description)}</description>` : '')
    + (!isApex && x.label ? `<label>${sftkMdEscape(x.label)}</label>` : '')
    + `</${s.metaTag}>`;
  return [
    { name: 'package.xml', text: _sftkPkgXml([[s.mdType || type, name]]) },   // the Metadata API's name: ApexClassText is an ApexClass
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
  // s.mdType: the kind's name in the Metadata API — LwcText (a 👀 row of Field Cleaner) is a LightningComponentBundle
  const files = [{ name: 'package.xml', text: _sftkPkgXml([[s.mdType || type, name]]) }];
  for (const r of (resources || [])) {
    const p = String(r.path || '');
    files.push({ name: p.startsWith(`${s.bundle}/`) ? p : `${s.bundle}/${name}/${p}`, text: String(r.source || '') });
  }
  const m = meta || {};
  // an LWC's <targets> and <targetConfigs> go back as they were: without them a redeploy un-exposes the component from
  // every page type (or is refused while a Lightning page still uses it), 2026-11-14. The Tooling Metadata gives
  // targetConfigs as base64 of the inner XML; a value that is already XML is kept as it is.
  const tcXml = v => {
    const t = String(v || '').trim();
    if (!t || !/^[A-Za-z0-9+/=\s]+$/.test(t)) return t;
    try { return new TextDecoder().decode(Uint8Array.from(atob(t.replace(/\s+/g, '')), ch => ch.charCodeAt(0))); } catch { return t; }
  };
  const targets = m.targets ? [].concat(m.targets.target != null ? m.targets.target : []).filter(Boolean) : [];
  const lwc = s.bundle === 'lwc';   // LightningComponentBundle, and its 👀 twin LwcText
  const tc = lwc ? tcXml(m.targetConfigs) : '';
  const lwcMeta = () => (m.description ? `<description>${sftkMdEscape(m.description)}</description>` : '')
    + `<isExposed>${m.isExposed === true ? 'true' : 'false'}</isExposed>${m.masterLabel ? `<masterLabel>${sftkMdEscape(m.masterLabel)}</masterLabel>` : ''}`
    + (tc ? `<targetConfigs>${tc}</targetConfigs>` : '')
    + (targets.length ? `<targets>${targets.map(t => `<target>${sftkMdEscape(t)}</target>`).join('')}</targets>` : '');
  const tag = lwc ? 'LightningComponentBundle' : 'AuraDefinitionBundle';
  const metaFile = lwc ? `${s.bundle}/${name}/${name}.js-meta.xml` : `${s.bundle}/${name}/${name}.cmp-meta.xml`;
  files.push({ name: metaFile, text: '<?xml version="1.0" encoding="UTF-8"?>\n'
    + `<${tag} xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>${sftkMdEscape(_sftkApiVer(m.apiVersion))}</apiVersion>`
    + (lwc ? lwcMeta() : (m.description ? `<description>${sftkMdEscape(m.description)}</description>` : ''))
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
// A qualified value (Obj.Field__c) is this field when Obj is objApi's own object through sftkMdIsOwnObj: a Task rule's
// <criteriaItems><field>Task.Region__c</field> / <offsetFromField>Task.Due__c</offsetFromField> IS Activity.Region__c.
// It compared `${o}.${f}` literally, so ✂ / ⇄ of an Activity field did nothing on those items while the scan
// (sftkMdMentionsField) and the formula path counted them (2026-11-14 review 7). One way only, as sftkMdIsOwnObj.
function _sftkMdFieldIs(v, objApi, fieldApi) {
  const x = String(v == null ? '' : v).trim().toLowerCase(), f = String(fieldApi || '').toLowerCase(), o = String(objApi || '').toLowerCase();
  if (!f) return false;
  if (x === f || x === `${o}.${f}`) return true;
  const d = x.indexOf('.');
  return d > 0 && x.slice(d + 1) === f && sftkMdIsOwnObj(x.slice(0, d), o);
}
// Is a component of object compObj (its <fullName>'s object, its <targetObject>, a report-type table…) on objApi's own
// fields? Activity is selectable as an object (the picker lists every EntityDefinition row), and a custom field defined
// on Activity IS a field of every Task and Event: Salesforce keeps no Activity validation rule, field update or action —
// they are Task's and Event's. Every own-object gate compared 'task' with 'activity' literally, so ✂ / ⇄ of
// Activity.Region__c refused a Task rule's bare Region__c with a false "Task's same-named field" (2026-11-14 review 5).
// One way only: cleaning Task.Region__c does not make an Event component its own. Not a relationship hop, so it is
// not in sftk-relmap.js's map; field-cleaner.js may call it as a page global (popup.html loads this file before it).
// PersonAccount is Account's own the same one way (2026-11-15): a Person Account compact layout / field set is stored
// under the PersonAccount prefix and holds Account's fields by bare name — the list-type host guard refused it with a
// false "PersonAccount's same-named field". Page layouts already read it so (field-cleaner.js LAYOUT_PREFIX_OBJECT).
// The prefix is from the Metadata API's naming, not checked against a live org.
function sftkMdIsOwnObj(compObj, objApi) {
  const c = String(compObj == null ? '' : compObj).trim().toLowerCase(), o = String(objApi == null ? '' : objApi).trim().toLowerCase();
  if (!c || !o) return false;
  return c === o || (o === 'activity' && (c === 'task' || c === 'event')) || (o === 'account' && c === 'personaccount');
}
// The object to ask sftkMdIsOwnObj about for a PICKED field (2026-11-15, close-out review round 2): a custom field
// picked on Task or Event is the one Activity field both hold, so its own-object question is asked of Activity
// (which owns Task and Event). Only __c: Subject on Task and on Event are two fields. One helper, because the rule
// lived inline in the removers and the flow probe / ⇄ swap were left without it — an Event flow holding
// Task.Region__c was marked "no version references the field any more".
function sftkMdFamObj(objApi, fieldApi) {
  const o = String(objApi == null ? '' : objApi).trim();
  return (/__c$/i.test(String(fieldApi == null ? '' : fieldApi).trim()) && /^(task|event)$/i.test(o)) ? 'Activity' : o;
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
// A formula's references to the field, swapped for newField (or only counted when newField is null). Whose field a
// reference names is read from the path in front of it, from ctxObj (the object the formula runs on; objApi when
// not given):
//   Field__c                         ctxObj's field — this field only when ctxObj is objApi
//   Obj.Field__c, $Setup.Obj.Field__c, $ObjectType.Obj.Fields.Field__c, $Obj.Field__c ($User…) — this field when Obj
//                                    is objApi (the $ObjectType form was missed: ⇄ deployed it unchanged, 2026-11-14)
//   Rel.Field__c, Rel.Rel2.Field__c  a relationship path, walked from ctxObj over the standard relationships whose
//                                    object is fixed (Parent → the same object, Owner → User, Account → Account…):
//                                    this field when it ends on objApi (swapped like a plain one), another object's
//                                    field when it ends elsewhere (left alone — Account.Region__c in a Contact rule is
//                                    Account's, 2026-11-14 review)
//   a custom lookup (Lookup__r.Field__c), a polymorphic What / Who, Parent where it can be any object (Attachment,
//                                    Note…), or Parent / MasterRecord when the formula's own object is not known
//                                    (no ctxObj) — whose field that is the text cannot tell: counted in rel (kind says
//                                    which of these, for a true refusal), never swapped; callers refuse when rel > 0
//                                    rather than deploy a half-done edit and report it done (2026-11-14)
// 2026-11-14 review 4: Parent / MasterRecord used to resolve against objApi when no ctxObj was given, so ⇄ on
// Account.Region__c in a Case rule renamed Parent.Region__c (Case's field) too — the callers now pass the host object
// (the <fullName>'s object part) and without one such a hop is 'cannot tell', never objApi. A standard hop missing from
// the map (Asset, Entitlement…) is a lookup named for its object, as in sftk-emailtpl.js review 3 — it used to refuse
// the whole edit as a "custom lookup", which was not the reason.
function _sftkMdSwapToken(text, objApi, fieldApi, newField, ctxObj) {
  const rx = x => String(x || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!fieldApi) return { text: String(text || ''), n: 0, rel: 0 };
  const o = String(objApi || '').toLowerCase(), ctx = String(ctxObj || objApi || '').toLowerCase(), known = !!ctxObj;
  // Every hop and $ root is resolved by the ONE shared resolver in sftk-relmap.js (sftkRelHop / sftkRelGlobal,
  // 2026-11-14): this function kept a private copy of the map that drifted from the other copies. Parent is the same
  // object on most, Case on CaseComment / EmailMessage, any object on Attachment / Note… (review 4).
  let kind = null;
  const cannot = k => { if (!kind) kind = k; return 'unknown'; };
  // 'this' | 'other' | 'unknown' for the path in front of the field ('' = bare)
  const whose = path => {
    const segs = path.toLowerCase().split('.').filter(Boolean);
    if (!segs.length) return sftkMdIsOwnObj(ctx, o) ? 'this' : 'other';   // a Task rule's bare X is Activity.X (review 5)
    const gl = sftkRelGlobal(segs);
    if (gl) {
      // a global that names no object ($Label, $Api…): only the old generic $Obj.Field__c form can be this field
      if (!gl.obj) return gl.global !== '$setup' && gl.global !== '$objecttype' && gl.global.slice(1) === o && segs.length === 1 ? 'this' : 'other';
      // a hop after the global ($User.Manager.X, $Setup.Obj.Owner.X) is followed like any other path — as
      // sftk-emailtpl.js already did; it used to be taken as another object's field whatever it ended on
      const r = sftkRelWalk(gl.obj, segs.slice(gl.from));
      if (r.kind) return cannot(r.kind);
      return sftkMdIsOwnObj(r.obj, o) ? 'this' : 'other';
    }
    if (segs.length === 1 && segs[0] === o) return 'this';
    // sure: cur is a known object — false only at the start, when the host was not given; a Parent / MasterRecord hop
    // from an object that is not known answers 'host' (cannot be told), every other hop names its own object
    let cur = ctx, i = 0, sure = known;
    if (segs[0] === ctx) { i = 1; sure = true; }      // Contact.Account.Field__c in a Contact formula
    for (; i < segs.length; i++) {
      const r = sftkRelHop(sure ? cur : null, segs[i]);   // Owner:User, Parent, Owner, Lookup__r, Entitlement…
      if (r.kind) return cannot(r.kind);
      cur = r.obj; sure = true;
    }
    return sftkMdIsOwnObj(cur, o) ? 'this' : 'other';
  };
  const re = new RegExp(`(?<![$A-Za-z0-9_.:])((?:[$A-Za-z0-9_]+[.:])*)${rx(fieldApi)}(?![A-Za-z0-9_])`, 'gi');
  let n = 0, rel = 0;
  const src = String(text || '');
  const out = src.replace(re, (m, path) => {
    const w = whose(path);
    if (w === 'unknown') { rel++; return m; }
    if (w !== 'this') return m;
    n++;
    return newField ? path + newField : m;
  });
  return kind ? { text: out, n, rel, kind } : { text: out, n, rel };
}
// ✂ on a formula, as a SUGGESTION (user 2026-11-10, on a validation rule's confirm: "why can't we just remove the
// field reference instead of deactivation?" — "we need to let the user to edit it and suggest what to remove. if its
// the only field ref we can suggest to turn it off"). The formula is read as conditions joined by && / || / AND(…) /
// OR(…), nested as deep as they go; every condition that names the field is taken out whole, the others stay as
// written. What is left is a proposal — which conditions go changes when the rule fires, so the caller shows the
// diff and lets the user edit it. Text in quotes and comments is skipped when the brackets are counted.
// A rule may test several fields, and this field several times: every one of its conditions goes. The rule can
// work without the field only when what is left still tests something — a formula left as a bare TRUE / FALSE
// would block every save or never fire, so that counts as nothing left (user 2026-11-10: "להסיר את הרפרנסים שלו
// במידה והולידציה יכולה לתפקד בלעדיו. אם לא אנחנו צריכים להגיד שהיא צריכה להכבות").
// namesFn (optional): the caller's own test for "this text names the field" — a flow formula writes
// {!$Record.Field__c}, which the object-aware default does not read.
// ctxObj (optional): the object the formula runs on, passed to _sftkMdSwapToken — without it a Parent. / MasterRecord.
// condition is not taken for this field (2026-11-14 review 4: a Case rule's Parent.Region__c was dropped on ✂ of
// Account.Region__c).
//   → { mode: 'operand', text, n }   n conditions taken out, `text` is the formula that is left
//     { mode: 'whole', n, why }      nothing would be left: why 'all' (every condition names the field) or
//                                    'constant' (only constants are left; `left` holds them)
//     { mode: 'none' }               the formula does not name the field
function sftkFormulaDropField(formula, objApi, fieldApi, namesFn, ctxObj) {
  // the field named in the formula's own text — a comment or a quoted string that holds its name does not count
  const names = t => (typeof namesFn === 'function' ? x => !!namesFn(x) : x => _sftkMdSwapToken(x, objApi, fieldApi, null, ctxObj).n > 0)(String(t).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""'));
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
    const not = /^NOT\s*\(/i.exec(t);
    if (not && wraps(t, not[0].length - 1)) { const r = drop(t.slice(not[0].length, -1)); return r == null ? null : `NOT(${r})`; }
    n++;
    return null;   // one condition that uses the field
  };
  const src = String(formula || '');
  if (!names(src)) return { mode: 'none' };
  const text = drop(src);
  if (text == null) return { mode: 'whole', n, why: 'all' };
  // does what is left still test anything? (a field, a function on one, $User… — not just TRUE / FALSE / numbers)
  const words = (text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""').match(/[A-Za-z_$][A-Za-z0-9_.$]*/g) || [])
    .filter(w => !/^(TRUE|FALSE|NULL|AND|OR|NOT)$/i.test(w));
  return words.length ? { mode: 'operand', text, n } : { mode: 'whole', n, why: 'constant', left: text };
}
// The search layouts of an object that list the field (user 2026-11-10: "also, what about search layouts?"). They
// live inside the object's own metadata (<searchLayouts>), one element per listed field; a custom field is written
// by its API name, a standard one as OBJECT.FIELD. Returns one hit per layout, in Setup's words.
function sftkSearchLayoutHits(objectInnerXml, objApi, fieldApi) {
  const NAMES = { customTabListAdditionalFields: 'Tab (recently viewed list)', lookupDialogsAdditionalFields: 'Lookup dialog', lookupPhoneDialogsAdditionalFields: 'Lookup dialog (phone)',
    lookupFilterFields: 'Lookup filter fields', lookupPhoneFilterFields: 'Lookup filter fields (phone)', searchFilterFields: 'Search filter fields', searchResultsAdditionalFields: 'Search results' };
  const box = sftkMdFindElement(String(objectInnerXml || ''), 'searchLayouts', 0);
  if (!box) return [];
  const body = String(objectInnerXml).slice(box.bodyStart, box.bodyEnd);
  const hits = [];
  for (const tag of Object.keys(NAMES)) {
    let cursor = 0, found = false;
    for (;;) {
      const el = sftkMdFindElement(body, tag, cursor);
      if (!el) break;
      if (_sftkMdFieldIs(sftkMdUnescape(body.slice(el.bodyStart, el.bodyEnd)), objApi, fieldApi)) found = true;
      cursor = el.end;
    }
    if (found) hits.push({ tag, label: NAMES[tag] });
  }
  return hits;
}
// The picklists of the object whose values DEPEND on the field (it is their controlling field). Live 2026-11-10 on
// npc: deleting the controlling field goes through, and the dependent picklist is left with no controlling field and
// no value settings — it offers every value from then on, and nothing says so.
function sftkDependentPicklists(objectInnerXml, fieldApi) {
  const f = String(fieldApi || '').toLowerCase();
  if (!f) return [];
  return sftkMdChildren(objectInnerXml, 'fields')
    .filter(c => String(sftkMdChildText(c.innerXml, 'controllingField') || '').trim().toLowerCase() === f)
    .map(c => c.fullName);
}
// ✂ / ⇄ on one search layout (2026-11-10). The field's entry in <tag> goes (✂) or names newField (⇄; when the new
// field is already listed there, the old entry just goes — a column appears once). Returns the <searchLayouts>
// element before and after, and the object FILE to deploy: a standard object takes its search layouts alone, a
// custom object must come with its own top-level properties (Salesforce: "Must specify a non-empty label"), so the
// file carries everything the read returned EXCEPT the child components, which deploy on their own and are left out.
//   → { n, before, after, file } — n = 0 when the layout does not list the field
function sftkSearchLayoutEdit(objectInnerXml, objApi, fieldApi, tag, newField) {
  const CHILDREN = ['fields', 'validationRules', 'listViews', 'webLinks', 'recordTypes', 'compactLayouts', 'fieldSets', 'businessProcesses', 'sharingReasons', 'indexes', 'fullName'];
  const src = String(objectInnerXml || '');
  const box = sftkMdFindElement(src, 'searchLayouts', 0);
  if (!box) return { n: 0, before: '', after: '', file: '' };
  const body = src.slice(box.bodyStart, box.bodyEnd);
  const nf = newField ? String(newField) : null;
  let hasNew = false;
  if (nf) for (let c = 0; ;) { const el = sftkMdFindElement(body, tag, c); if (!el) break; if (_sftkMdFieldIs(sftkMdUnescape(body.slice(el.bodyStart, el.bodyEnd)), objApi, nf)) hasNew = true; c = el.end; }
  let n = 0;
  const w = _sftkMdWalk(body, tag, inner => {
    if (!_sftkMdFieldIs(sftkMdUnescape(inner), objApi, fieldApi)) return 'keep';
    n++;
    return (nf && !hasNew) ? { body: sftkMdEscape(nf) } : 'drop';
  });
  const before = src.slice(box.start, box.end);
  const after = src.slice(box.start, box.bodyStart) + w.xml + src.slice(box.bodyEnd, box.end);
  let rest = src.slice(0, box.start) + after + src.slice(box.end);
  for (const t of CHILDREN) rest = _sftkMdWalk(rest, t, () => 'drop').xml;
  const custom = /__c$/i.test(String(objApi || ''));
  const file = '<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">' + (custom ? rest : after) + '</CustomObject>';
  return { n, before, after, file, swapped: !!(nf && !hasNew), newAlreadyThere: hasNew };
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
  // 2026-11-15 (close-out review): a CUSTOM field picked on Task or Event is ONE field, defined on Activity and
  // held by both. The list types knew it (listOwn); the rules, formulas, approvals, field updates and actions still
  // read the picked object one way — so with Task.Region__c picked the sweep listed an Event rule as a blocker
  // (true) and the remover refused it as "Event's same-named field, not this one" (untrue). Every own-object test
  // in this function asks for Activity instead, which owns Task and Event (sftkMdIsOwnObj). Only for __c:
  // Task.Subject and Event.Subject are two fields. objApi itself stays for the texts and the plain compares.
  const _act = v => /^(task|event|activity)$/i.test(String(v || '').trim());
  const ownApi = (/__c$/i.test(String(fieldApi || '')) && _act(objApi)) ? 'Activity' : objApi;
  const how = [];
  let xml = before, refused = null, off = false, suggested = false, unsure = false;
  const refuse = why => { if (!refused) refused = why; };
  // a refusal because WHOSE field a mention is cannot be told: the component may well still name the field, so the
  // result says so (unsure) — field-cleaner.js's "does it still name it?" probe used to read every refusal as "no", and
  // reported a hand edit still holding Partner__r.Region__c + a bare Region__c as done (2026-11-14 review 6)
  const cannotTell = why => { if (!refused) unsure = true; refuse(why); };
  const plural = (n, w, ws) => `${n} ${n === 1 ? w : (ws || `${w}s`)}`;
  const verb = nf ? `now ${nf}` : 'removed';
  // a criteria-like element whose <child> names the field: dropped or renamed; skip(body) true = not this object's
  // field whatever its name (a filter line on another <table>, 2026-11-14)
  // is(v): the caller's own "is this value the field" rule, where the plain one is not enough (a field set of another
  // object, 2026-11-15)
  const items = (src, tag, child, skip, is) => {
    let n = 0;
    const r = _sftkMdWalk(src, tag, body => {
      if (skip && skip(body)) return 'keep';
      const el = sftkMdFindElement(body, child, 0);
      if (!el) return 'keep';
      const v = sftkMdUnescape(body.slice(el.bodyStart, el.bodyEnd));
      if (!(is ? is(v) : _sftkMdFieldIs(v, ownApi, fieldApi))) return 'keep';
      n++;
      return nf ? { body: body.slice(0, el.bodyStart) + sftkMdEscape(_sftkMdRenameVal(v, nf)) + body.slice(el.bodyEnd) } : 'drop';
    });
    return { xml: r.xml, n, left: r.kept };
  };
  // a list member whose TEXT is the field (<fields>X</fields>)
  const texts = (src, tag) => {
    let n = 0;
    const r = _sftkMdWalk(src, tag, body => {
      if (/</.test(body) || !_sftkMdFieldIs(sftkMdUnescape(body), ownApi, fieldApi)) return 'keep';
      n++;
      return nf ? { body: sftkMdEscape(_sftkMdRenameVal(sftkMdUnescape(body), nf)) } : 'drop';
    });
    return { xml: r.xml, n, left: r.kept };
  };
  // the mapping lines (<objectMapping><mappingFields>) that carry the field: inputField when inputObject is this
  // object, outputField when outputObject is. ⇄ renames them; ✂ only counts them. Shared by the lead conversion
  // settings and a duplicate rule's cross-object match (2026-11-14).
  const mappings = src => {
    let n = 0;
    const o = String(objApi || '').toLowerCase();
    const r = _sftkMdWalk(src, 'objectMapping', body => {
      const io = (sftkMdChildText(body, 'inputObject') || '').toLowerCase(), oo = (sftkMdChildText(body, 'outputObject') || '').toLowerCase();
      const m = _sftkMdWalk(body, 'mappingFields', mb => {
        let out = mb, hit = false;
        for (const [side, objOf] of [['inputField', io], ['outputField', oo]]) {
          const e = sftkMdFindElement(out, side, 0);
          if (!e || objOf !== o || !_sftkMdFieldIs(sftkMdUnescape(out.slice(e.bodyStart, e.bodyEnd)), ownApi, fieldApi)) continue;
          n++;
          if (nf) { out = out.slice(0, e.bodyStart) + sftkMdEscape(nf) + out.slice(e.bodyEnd); hit = true; }
        }
        return hit ? { body: out } : 'keep';
      });
      return m.changed ? { body: m.xml } : 'keep';
    });
    return { xml: r.xml, n };
  };
  // formula text: ⇄ swaps the token; ✂ only counts it (a formula is never cut)
  // ctx: the object the formula runs on, when it is not objApi (a restriction rule's record filter runs on its
  // <targetEntity>). Otherwise the component's own object, the part of its <fullName> before the dot (Case.V → Case):
  // a bare Field__c and a Parent. / MasterRecord. hop are read from there, never assumed to be objApi (2026-11-14
  // review 4: ⇄ Account.Region__c renamed a Case rule's Parent.Region__c). No dot (a global action) = not known.
  const fullName = String(sftkMdChildText(before, 'fullName') || '');
  const host = fullName.indexOf('.') > 0 ? fullName.slice(0, fullName.indexOf('.')) : null;
  const sameObj = sftkMdIsOwnObj(host, ownApi);   // Task / Event are Activity's own (review 5, 2026-11-14)
  const formulas = (src, tag, ctx) => {
    let n = 0, rel = 0, kind = null;
    const r = _sftkMdWalk(src, tag, body => {
      const s = _sftkMdSwapToken(body, ownApi, fieldApi, nf, ctx || host);
      n += s.n; rel += s.rel; kind = kind || s.kind;
      return (nf && s.n) ? { body: s.text } : 'keep';
    });
    return { xml: r.xml, n, rel, kind };
  };
  // a path whose object cannot be told is never swapped (see _sftkMdSwapToken), so such a formula is refused whole
  // rather than deployed half-edited and reported done (2026-11-14); the text names the TRUE reason (review 4: an
  // unmapped standard hop was refused as a "custom lookup")
  // a list view, field set or compact layout lists fields of its OWN object (its <fullName>'s, Contact.X → Contact):
  // a bare Region__c in a Contact view is Contact's same-named field. The ListView / FieldSet / CompactLayout cases
  // matched it anyway, so ✂ of Account.Region__c stripped Contact's column, filter and field-set field (Salesforce
  // accepted it) and ⇄ rewrote them to a field Contact does not have (QA 2026-11-14). Same guard as errorDisplayField,
  // ApprovalProcess and QuickAction. A path written Account.Region__c from another object's component may well be this
  // field, so that one is refused as "cannot tell" (unsure), never as "nothing to edit". Host not known = unchanged.
  const reEsc = t => String(t || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A CUSTOM field picked on Task or Event is Activity's field, and the sibling's too (Salesforce defines it once, on
  // Activity): with Task picked, an Event view's bare Region__c was refused as "Event's same-named field", which is
  // untrue (2026-11-15). Only for __c: Task.Subject and Event.Subject are two fields. Since the close-out review
  // the same holds for every own-object test here (ownApi above), so sameObj already says it.
  const listOwn = sameObj;
  const notOwn = (n, what) => {
    if (!host || listOwn || !n) return false;
    if (new RegExp(`>\\s*${reEsc(objApi)}\\.${reEsc(fieldApi)}\\s*<`, 'i').test(before)) {
      cannotTell(`the ${host} ${what} names ${objApi}.${fieldApi} as a path from ${host}, and whether that reaches this field cannot be told here — edit it in Setup`);
    } else {
      refuse(`a ${host} ${what} holds ${host}’s fields, not this one — its ${fieldApi} is ${host}’s same-named field, so there is nothing of this field to edit`);
    }
    return true;
  };
  const relWhy = kind => kind === 'host'
    ? 'the formula also names a field of this name through Parent / MasterRecord, and the object the formula runs on is not known here, so whose field that is cannot be told — edit it in Setup'
    : kind === 'poly'
      ? 'the formula also names a field of this name through a lookup that can reach any object (What / Who, or Parent on this kind of record), so whose field that is cannot be told from the formula — edit it in Setup'
      : 'the formula also names a field of this name through a custom lookup (Lookup__r.Field__c), and which object that lookup reaches cannot be told from the formula — edit it in Setup';
  switch (type) {
    case 'ValidationRuleInactive':
    case 'ValidationRule': {
      const f = formulas(xml, 'errorConditionFormula');
      // a rule can show its error AT the field (<errorDisplayField>); the scan counts it, so ✂ / ⇄ must move it too,
      // or the deployed rule still names the field (2026-11-14). texts() renames it on ⇄ and drops it on ✂ —
      // with no errorDisplayField the error shows at the top of the page, which Salesforce accepts.
      // The display field is always a field of the rule's OWN object: it is touched only when that object (the
      // <fullName>'s, Account.Check → Account) is objApi — ⇄ of User.Region__c renamed an Account rule's
      // <errorDisplayField>Region__c</errorDisplayField>, Account's field (2026-11-14 review 4).
      const ed = sameObj ? texts(f.xml, 'errorDisplayField') : { xml: f.xml, n: 0 };
      const edWhat = nf ? `error location ${verb}` : 'error location moved to the top of the page';
      if (f.rel) { cannotTell(relWhy(f.kind)); break; }
      // another object's rule may name a bare token of this name: that is the rule's own object's same-named field,
      // not this one — the old text said the formula did not name it at all, which was not true (QA 2026-11-14)
      if (!f.n && !ed.n && host && !sameObj) {
        const fx0 = sftkMdChildText(xml, 'errorConditionFormula') || '';
        if (new RegExp(`(^|[^A-Za-z0-9_.$])${reEsc(fieldApi)}(?![A-Za-z0-9_])`, 'i').test(fx0)) { refuse(`the rule’s formula names ${fieldApi} as a field of the rule’s own object (${host}) — ${host}’s same-named field, not this one, so there is nothing of this field to edit`); break; }
      }
      if (!f.n && !ed.n) { refuse('the rule’s formula does not name the field as a whole token — edit it in Setup'); break; }
      if (nf) { xml = ed.xml; if (f.n) how.push(`formula: ${plural(f.n, 'reference')} ${verb}`); if (ed.n) how.push(edWhat); break; }
      if (!f.n) { xml = ed.xml; how.push(`${edWhat} — the formula does not use the field`); break; }
      const act = sftkMdFindElement(xml, 'active', 0);
      if (!act || xml.slice(act.bodyStart, act.bodyEnd).trim() !== 'true') { refuse('the rule is already inactive — an inactive rule does not block the delete; re-scan'); break; }
      // ✂ suggests the formula without the conditions that use the field; the rule stays on (user 2026-11-10)
      const fe = sftkMdFindElement(xml, 'errorConditionFormula', 0);
      const d = fe ? sftkFormulaDropField(sftkMdUnescape(xml.slice(fe.bodyStart, fe.bodyEnd)), ownApi, fieldApi, null, host) : { mode: 'none' };
      // the token sits only in a comment or quoted text: no condition uses it, so switching the rule off would be
      // done for a reason that is not true (2026-11-14). The text points to ✎ Edit, not ⇄: _sftkMdSwapToken renames
      // the token inside string literals and comments as well, so ⇄ would change the value the rule compares
      // (2026-11-14 review 6)
      if (d.mode === 'none') { refuse('the field is named only in a comment or quoted text of the formula — no condition uses it; ✎ Edit XML in 🔍 (or Setup) to change that text — ⇄ Replace would rename it inside the quotes too, which changes what the rule compares'); break; }
      if (d.mode === 'operand') {
        xml = xml.slice(0, fe.bodyStart) + sftkMdEscape(d.text) + xml.slice(fe.bodyEnd);
        if (ed.n) { xml = texts(xml, 'errorDisplayField').xml; }
        suggested = true;
        how.push(`${plural(d.n, 'condition')} that use${d.n === 1 ? 's' : ''} the field taken out of the formula — the rule stays active on its other conditions`);
        if (ed.n) how.push(edWhat);
        break;
      }
      // every condition uses the field: nothing would be left of the formula, so the suggestion is to switch it off
      xml = xml.slice(0, act.bodyStart) + 'false' + xml.slice(act.bodyEnd);
      off = true;
      how.push(d.why === 'constant'
        ? `the rule cannot work without the field — only “${d.left}” would be left of its formula — so it has to be switched off`
        : 'the rule cannot work without the field — every condition of its formula uses it — so it has to be switched off');
      if (ed.n) { xml = texts(xml, 'errorDisplayField').xml; how.push(edWhat); }
      break;
    }
    case 'CustomField': {
      const f = formulas(xml, 'formula');
      const r = items(f.xml, 'summaryFilterItems', 'field');
      const sum = texts(r.xml, 'summarizedField');
      if (!nf && (f.n || sum.n)) { refuse(f.n ? 'a formula cannot lose a reference — ⇄ Replace it with another field, or 🗑 delete this formula field' : 'the roll-up sums this field — ⇄ Replace it, or 🗑 delete the roll-up field'); break; }
      if (f.rel) { cannotTell(relWhy(f.kind)); break; }
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
      // a field of the lookup's OWN object is written <valueField>$Source.Field__c</valueField>. When that object is
      // objApi (a self-lookup, or a filter on the lookup's own object), such a condition names the field too: it is
      // dropped (✂) or renamed (⇄) like one whose <field> names it, never left behind (2026-11-14).
      const own = String(sftkMdChildText(xml, 'fullName') || '').split('.')[0].toLowerCase();
      const isSrc = v => sftkMdIsOwnObj(own, ownApi) && v.trim().toLowerCase() === `$source.${String(fieldApi || '').toLowerCase()}`;
      let hits = 0;
      const w = _sftkMdWalk(body, 'filterItems', it => {
        let out = it, hit = false;
        for (const [child, test] of [['field', v => _sftkMdFieldIs(v, ownApi, fieldApi)], ['valueField', isSrc]]) {
          const el = sftkMdFindElement(out, child, 0);
          if (!el) continue;
          const v = sftkMdUnescape(out.slice(el.bodyStart, el.bodyEnd));
          if (!test(v)) continue;
          hit = true;
          if (nf) out = out.slice(0, el.bodyStart) + sftkMdEscape(_sftkMdRenameVal(v, nf)) + out.slice(el.bodyEnd);
        }
        if (!hit) return 'keep';
        hits++;
        return nf ? { body: out } : 'drop';
      });
      const r = { xml: w.xml, n: hits, left: w.kept };
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
      // a restriction / scoping rule's record filter runs on its <targetEntity>: a bare Field__c there is THAT object's
      // field, so for a User field only $User.Field__c (and paths that end on User) count (2026-11-14 review)
      const target = type === 'RestrictionRule' ? (sftkMdChildText(xml, 'targetEntity') || objApi) : host;   // a WebLink runs on its own object (review 4)
      const f = formulas(xml, type === 'WebLink' ? 'url' : 'recordFilter', target);
      // a field of User is also named in the rule's <userCriteria> ($User.Field__c = …): read it too, or ⇄ deploys
      // the rule half-renamed and reports it done (2026-11-14)
      const u = (type === 'RestrictionRule' && String(objApi || '').toLowerCase() === 'user') ? formulas(f.xml, 'userCriteria', 'User') : { xml: f.xml, n: 0, rel: 0 };
      if (f.rel || u.rel) { cannotTell(relWhy(f.kind || u.kind)); break; }
      if (!f.n && !u.n) { refuse(`the ${what} does not name the field as a whole token — edit it in Setup`); break; }
      if (!nf) { refuse(type === 'WebLink' ? 'a URL cannot lose a merge field and keep working — ⇄ Replace it with another field, or 🗑 delete the button' : 'a record filter cannot lose a condition here — ⇄ Replace it with another field, or 🗑 delete the rule'); break; }
      xml = u.xml;
      if (f.n) how.push(`${what}: ${plural(f.n, 'reference')} ${verb}`);
      if (u.n) how.push(`user criteria: ${plural(u.n, 'reference')} ${verb}`);
      break;
    }
    case 'WorkflowFieldUpdate': {
      const fe = sftkMdFindElement(xml, 'field', 0);
      // the target is a field of the record the update writes: the update's OWN object (its <fullName>, Account.Upd →
      // Account), or on a cross-object update the parent its <targetObject> lookup reaches (AccountId → Account). It is
      // touched only when that object is objApi — ⇄ of User.Region__c renamed an Account update's
      // <field>Region__c</field> (2026-11-14 review 4). A custom lookup (Parent__c) does not tell its object: left alone.
      const lk = String(sftkMdChildText(xml, 'targetObject') || '').trim().toLowerCase();
      // ParentId follows the same Parent map as the formulas: Case on CaseComment / EmailMessage, any object (null =
      // cannot be told) on Attachment / Note / FeedItem…, the update's own object elsewhere — an EmailMessage update
      // with <targetObject>ParentId</targetObject> writes Case's field, not EmailMessage's (2026-11-14 review 4)
      // The lookup is resolved by the ONE shared resolver (sftkRelLookupField in sftk-relmap.js, 2026-11-14) — this
      // case kept its own small map, which took ReportsToId for an object "reportsto", ConvertedAccountId for
      // "convertedaccount" and WhatId / WhoId for objects "what" / "who"; the shared map knows them (Contact, Account,
      // cannot be told).
      const hl = host ? host.toLowerCase() : null;
      const wr = !lk ? (hl ? { obj: hl } : { obj: null, kind: 'host' }) : sftkRelLookupField(hl, lk);
      const writes = wr.kind ? null : wr.obj;
      const whyNot = wr.kind === 'host' ? 'the update’s own object is not known here'
        : wr.kind === 'poly' ? `its <targetObject> ${lk} can point at any object`
        : `its <targetObject> ${lk} is a custom lookup, which does not tell its object`;
      const tgtNames = !!fe && _sftkMdFieldIs(sftkMdUnescape(xml.slice(fe.bodyStart, fe.bodyEnd)), ownApi, fieldApi);
      const target = tgtNames && sftkMdIsOwnObj(writes, ownApi);   // a Task update writes Activity.X (review 5)
      const f = formulas(xml, 'formula');
      if (!nf && target) { refuse('the field update WRITES to this field — ⇄ Replace points it at another field, or 🗑 delete the field update'); break; }
      if (!nf && f.n) { refuse('its formula cannot lose a reference — ⇄ Replace it, or 🗑 delete the field update'); break; }
      if (tgtNames && !writes) { cannotTell(`the update writes a field of this name on a record whose object cannot be told here (${whyNot}) — edit it in Setup`); break; }
      if (!target && !f.n) { refuse(tgtNames ? `neither its target nor its formula names the field — the target is ${writes}’s same-named field` : 'neither its target nor its formula names the field — edit it in Setup'); break; }
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
      // a time-dependent rule counts its trigger FROM a date field (<workflowTimeTriggers><offsetFromField>): ⇄ moves
      // it too; ✂ cannot take it out (the trigger needs a base), so it refuses as a whole rather than drop the
      // criterion, leave the trigger on the field and report done (2026-11-14)
      const ot = texts(r.xml, 'offsetFromField');
      // the time trigger is tested first: when it is the only mention, its own reason is the true one (2026-11-14 review)
      if (!nf && ot.n) { refuse(`${!r.n && !f.n ? 'no criterion names the field, but its' : 'its'} time trigger counts from this field — ⇄ Replace it with another date field, or 🗑 delete it`); break; }
      if (!r.n && !f.n && !(nf && ot.n)) { refuse('no criterion names the field — edit it in Setup'); break; }
      if (!nf && r.n && _sftkMdHasLogic(xml)) { refuse('its filter logic numbers the criteria — taking one out changes what the others mean; ⇄ Replace, or edit it in Setup'); break; }
      if (!nf && r.left === 0 && !sftkMdFindElement(xml, 'formula', 0)) { refuse(`its only criterion is this field — with none left it would ${type === 'WorkflowRule' ? 'fire on every record' : 'share every record'}; ⇄ Replace it, or 🗑 delete it`); break; }
      xml = ot.xml;
      if (r.n) how.push(`criteria: ${plural(r.n, 'line')} ${verb}${nf ? '' : `, ${plural(r.left, 'line')} kept`}`);
      if (f.n) how.push(`formula: ${plural(f.n, 'reference')} ${verb}`);
      if (ot.n) how.push(`time trigger: ${plural(ot.n, 'base field')} ${verb}`);
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
      // A field set of ANOTHER object: its bare Region__c is that object's own field and stays; a spanning entry
      // (Account.Region__c in a Contact field set) is this field when its hops, walked from the field set's object by
      // the shared resolver (sftk-relmap.js), end on objApi — the host guard refused that as "cannot tell" where it
      // was edited before (2026-11-15). A hop the resolver cannot tell (Lookup__r, What / Who) refuses the whole edit
      // as unsure. Only here: a list view's column names are not relationship paths, a compact layout has none.
      // 2026-11-15 (second review): the object's OWN field set goes through the same resolver — its bare name is
      // this field, and a self-lookup entry (Parent.Region__c in an Account field set) is too; the plain test left
      // that entry in place while the edit was reported done.
      const other = !!host && !listOwn, f = String(fieldApi || '').toLowerCase();
      let n = 0, bare = 0, dim = null, fx = xml;
      const is = !host ? null : v => {
        const segs = String(v == null ? '' : v).trim().toLowerCase().split('.');
        if (!f || segs.pop() !== f) return false;
        if (!segs.length) { if (!other) return true; bare++; return false; }
        const r = sftkRelWalk(host, segs);
        if (r.kind) { dim = dim || r.kind; return false; }
        return sftkMdIsOwnObj(r.obj, ownApi);
      };
      for (const tag of ['displayedFields', 'availableFields']) { const r = items(fx, tag, 'field', null, is); fx = r.xml; n += r.n; }
      if (dim) { cannotTell(`the ${host} field set names a field of this name through ${dim === 'custom' ? 'a custom lookup (Lookup__r.Field__c), and which object that lookup reaches' : 'a lookup that can reach any object, and whose field that is'} cannot be told here — edit it in Setup`); break; }
      if (!n && bare) { refuse(`a ${host} field set holds ${host}’s fields, not this one — its ${fieldApi} is ${host}’s same-named field, so there is nothing of this field to edit`); break; }
      if (!n) { refuse('the field set does not list the field — edit it in Setup'); break; }
      xml = fx;
      how.push(`field set: the field ${nf ? verb : 'taken out'}${bare ? ` (${host}’s own ${fieldApi} is left as it is)` : ''}`);
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
      // the page fields and a relatedUserField approver are always fields of the process's OWN object (its <fullName>):
      // touched only when that object is objApi — ⇄ of User.Region__c renamed an Account process's page field
      // Region__c and reported it (2026-11-14 review 4)
      const pages = !sameObj ? { xml: r.xml } : _sftkMdWalk(r.xml, 'approvalPageFields', body => { const t = texts(body, 'field'); hits += t.n; return t.n ? { body: t.xml } : 'keep'; });
      // a step can route to a User lookup of the record (<approver><name>Field__c</name><type>relatedUserField</type>):
      // Salesforce blocks the field delete on it. ⇄ renames it; ✂ refuses as a whole — a step cannot lose its approver,
      // and taking out only the page field would report done while the step still names the field (2026-11-14)
      let apCut = false;
      const aps = !sameObj ? { xml: pages.xml } : _sftkMdWalk(pages.xml, 'approver', body => {
        if ((sftkMdChildText(body, 'type') || '').trim() !== 'relatedUserField') return 'keep';
        const t = texts(body, 'name');
        if (!t.n) return 'keep';
        hits += t.n;
        if (!nf) { apCut = true; return 'keep'; }
        return { body: t.xml };
      });
      if (apCut) { refuse('a step’s approver is this field — a step cannot lose its approver; ⇄ Replace it with another user field, or 🗑 delete the process'); break; }
      if (formulaCut) { refuse('the entry criteria are a formula that names the field — ⇄ Replace it, or edit the process in Setup'); break; }
      if (logic) { refuse('the criteria’s filter logic numbers them — ⇄ Replace, or edit the process in Setup'); break; }
      if (emptied) { refuse('the field is the only entry criterion — with none left EVERY record could enter the process; ⇄ Replace it, or 🗑 delete the process'); break; }
      if (!hits) { refuse('no criterion or page field names the field — edit the process in Setup'); break; }
      xml = aps.xml; how.push(`criteria and page fields: ${plural(hits, 'reference')} ${verb}`);
      break;
    }
    case 'DuplicateRule': {
      // a cross-object rule (a Lead rule matched against Contacts) maps fields in <duplicateRuleMatchRules><objectMapping>:
      // ⇄ renames them with the filter; ✂ cannot take a mapped field out of the match, so it refuses as a whole rather
      // than drop the filter line, leave the mapping and report done (2026-11-14)
      const mp = mappings(xml);
      if (!nf && mp.n) { refuse('the rule’s cross-object match maps this field — ⇄ Replace it, or 🗑 delete the rule'); break; }
      const fl = sftkMdFindElement(xml, 'duplicateRuleFilter', 0);
      if (!fl && !mp.n) { refuse('the rule has no record filter — re-scan'); break; }
      const body = fl ? xml.slice(fl.bodyStart, fl.bodyEnd) : '';
      // a filter line's object is its <table>: a line on ANOTHER table's same-named field (the current user's
      // User.Region__c) is not this field and stays as it is — the scan already reads <table> this way (2026-11-14)
      const o = String(objApi || '').toLowerCase();
      const r = items(body, 'duplicateRuleFilterItems', 'field', b => { const t = (sftkMdChildText(b, 'table') || '').trim().toLowerCase(); return !!t && t !== o; });
      if (!r.n && !mp.n) { refuse('no filter line names the field — edit it in Setup'); break; }
      if (!r.n) { xml = mp.xml; how.push(`cross-object match: ${plural(mp.n, 'mapping line')} ${verb}`); break; }
      if (!nf && _sftkMdHasLogic(body)) { refuse('the filter’s logic numbers its lines — ⇄ Replace, or edit it in Setup'); break; }
      if (!nf && r.left === 0) { xml = xml.slice(0, fl.start) + xml.slice(fl.end); how.push('the filter had no other line — the record filter is removed, the rule now checks every record'); break; }
      let i = 0;
      const ren = _sftkMdWalk(r.xml, 'duplicateRuleFilterItems', b => { i++; const so = sftkMdFindElement(b, 'sortOrder', 0); return so ? { body: b.slice(0, so.bodyStart) + String(i) + b.slice(so.bodyEnd) } : 'keep'; });
      xml = xml.slice(0, fl.bodyStart) + (nf ? r.xml : ren.xml) + xml.slice(fl.bodyEnd);
      how.push(`record filter: ${plural(r.n, 'line')} ${verb}${nf ? '' : `, ${plural(r.left, 'line')} kept`}`);
      if (mp.n) { xml = mappings(xml).xml; how.push(`cross-object match: ${plural(mp.n, 'mapping line')} ${verb}`); }
      break;
    }
    case 'ListView': {
      const c = texts(xml, 'columns');
      const fl = sftkMdFindElement(c.xml, 'filters', 0);
      const r = items(c.xml, 'filters', 'field');
      if (notOwn(c.n + r.n, 'list view')) break;
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
      if (notOwn(c.n, 'compact layout')) break;
      if (!c.n) { refuse('the compact layout does not list the field — edit it in Setup'); break; }
      if (!nf && !c.left) { refuse('the field is the layout’s only field — ⇄ Replace it, or 🗑 delete the compact layout'); break; }
      xml = c.xml; how.push(`${plural(c.n, 'field')} ${verb}`);
      break;
    }
    case 'PathAssistant': {
      // a step's <fieldNames> are bare field names of the path's own object, its <entityName>; the path's <fieldName>
      // is the picklist it RUNS on — that one is never taken out (a path without it is no path)
      const ent = String(sftkMdChildText(xml, 'entityName') || '').trim();
      if (ent && !sftkMdIsOwnObj(ent, ownApi)) { refuse(`the path is on ${ent} — its ${fieldApi} is ${ent}’s same-named field, so there is nothing of this field to edit`); break; }
      // a path that RUNS on the field is refused whole, key fields and all: with its steps cleaned it would still
      // stand on the field, and the row would read as cleared
      if (_sftkMdFieldIs(String(sftkMdChildText(xml, 'fieldName') || '').trim(), ownApi, fieldApi)) { refuse('the path runs on the field itself — its steps are that field’s values; delete the path or pick another field for it in Setup → Path Settings'); break; }
      const c = texts(xml, 'fieldNames');
      if (!c.n) { refuse('the path does not show the field in a step — edit it in Setup → Path Settings'); break; }
      xml = c.xml; how.push(`${plural(c.n, 'key field')} of the path’s steps ${verb}`);
      break;
    }
    case 'QuickAction': {
      // the layout and the predefined values hold fields of the record the action works on: its <targetObject> (a
      // Create / Log a Call action on Account makes a Contact / Task), else the action's own object (its <fullName>).
      // Only when that object is objApi are they this field — ✂ of Account.Region__c stripped Contact.Region__c from
      // Account.NewContact and reported it done (2026-11-14 review 4). Not known (no target, no host) = left alone.
      const tgt = String(sftkMdChildText(xml, 'targetObject') || host || '').trim();
      const own = sftkMdIsOwnObj(tgt, ownApi);   // a Log a Call action (Task) holds Activity's fields (review 5)
      const li = own ? items(xml, 'quickActionLayoutItems', 'field') : { xml, n: 0 };
      const fo = own ? items(li.xml, 'fieldOverrides', 'field') : { xml: li.xml, n: 0 };
      // a predefined value of ANOTHER field may compute from this one (<fieldOverrides><formula>): Salesforce counts it
      // as a reference, so ⇄ swaps the token and ✂ refuses as a whole — a formula cannot lose a reference, and dropping
      // only the layout item would deploy "done" with the field still named (2026-11-14)
      const fx = formulas(fo.xml, 'formula');
      if (fx.rel) { cannotTell(relWhy(fx.kind)); break; }
      if (!li.n && !fo.n && !fx.n) {
        // not known whose fields the layout holds: unsure only when a layout item / predefined value IS of this name
        // (2026-11-14 review 6)
        if (!own && !tgt && !refused && (items(xml, 'quickActionLayoutItems', 'field').n || items(xml, 'fieldOverrides', 'field').n)) unsure = true;
        refuse(own ? 'neither the action’s layout nor its predefined values name the field — edit it in Setup'
          : tgt ? `the action works on a ${tgt} record: its layout and predefined values hold ${tgt}’s fields, not this one — nothing of this field to edit`
          : 'the object the action works on is not known here, so whose fields its layout and predefined values hold cannot be told — edit it in Setup');
        break;
      }
      if (!nf && fx.n) { refuse('a predefined value’s formula names the field — a formula cannot lose a reference; ⇄ Replace it, or 🗑 delete the action'); break; }
      xml = fx.xml;
      const bits = []; if (li.n) bits.push(`${plural(li.n, 'layout field')} ${verb}`); if (fo.n) bits.push(`${plural(fo.n, 'predefined value')} ${verb}`);
      if (fx.n) bits.push(`${plural(fx.n, 'formula reference')} ${verb}`);
      how.push(bits.join(', '));
      break;
    }
    case 'CustomMetadataText':
    case 'CustomMetadataRecord': {
      let n = 0;
      // only the values the scan counts for THIS object: a bare "Field__c" next to Entity__c = Lead is Lead's
      // same-named field (lead conversion makes those common) and must stay as it is (2026-11-14)
      // A value is paired with the object value of the same prefix (Source_ / Target_); when the record names this
      // object and another and a bare value cannot be paired, it is refused rather than guessed (2026-11-14 review 4)
      const vr = sftkMdValuesHolding(xml, objApi, fieldApi, true);
      if (vr.unclear.length) { cannotTell(`the record names ${objApi} and another object, and which of them ${vr.unclear.join(', ')} belongs to cannot be told from the record — edit it in Setup`); break; }
      const hold = new Set(vr.hold.map(x => x.toLowerCase()));
      const r = _sftkMdWalk(xml, 'values', body => {
        const ve = sftkMdFindElement(body, 'value', 0);
        if (!ve) return 'keep';
        const v = sftkMdUnescape(body.slice(ve.bodyStart, ve.bodyEnd));
        if (!_sftkMdFieldIs(v, ownApi, fieldApi) || !hold.has((sftkMdChildText(body, 'field') || '?').toLowerCase())) return 'keep';
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
      const r = mappings(xml);
      if (!r.n) { refuse('no mapping line carries the field — re-scan'); break; }
      xml = r.xml; how.push(`${plural(r.n, 'mapping line')} now ${nf}`);
      break;
    }
    default:
      refuse('this kind is not edited here — 🗑 delete it, or edit it in Setup');
  }
  // unsure: refused because whose field a mention is cannot be told — the component may still name the field
  // (present only when true, so a plain refusal keeps its exact shape)
  if (refused) return unsure ? { xml: before, changed: false, how: [], refused, unsure } : { xml: before, changed: false, how: [], refused };
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
    CustomMetadataRecord: 'rr', CustomMetadataText: 'rr', LeadConvertSettings: 'rr',
    ListView: 'rr', CompactLayout: 'rr', QuickAction: 'rr', ValidationRuleInactive: 'r', PathAssistant: 'rr',
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
  globalThis.sftkSearchLayoutHits = sftkSearchLayoutHits;
  globalThis.sftkSearchLayoutEdit = sftkSearchLayoutEdit;
  globalThis.sftkDependentPicklists = sftkDependentPicklists;
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
