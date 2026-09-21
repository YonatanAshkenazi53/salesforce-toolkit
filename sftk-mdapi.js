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

if (typeof globalThis !== 'undefined') {
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
}
