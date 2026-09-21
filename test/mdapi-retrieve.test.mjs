// SOAP METADATA API PRIMITIVES — retrieving configuration that cannot be
// queried (user 2026-08-22: "Also connected apps and their new types.
// named credentials, etc" / "Every metadata that is required for
// integration to run"). There is no REST retrieve, so this is the SOAP
// route, and the extraction TRANSPLANTS element bodies rather than parsing
// them: an MV3 worker has no DOMParser, and anything we do not interpret
// cannot be silently reinterpreted wrong.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const MD = readFileSync(new URL('../sftk-mdapi.js', import.meta.url), 'utf8');

const F = extractFunctions('sftk-mdapi.js', [
  'sftkMdFault', 'sftkMdUnescape', 'sftkMdEscape', 'sftkMdEnvelope',
  'sftkMdListBody', 'sftkMdReadBody', 'sftkMdFindElement', 'sftkMdChildText',
  'sftkMdExtractRecords', 'sftkMdExtractListed', 'sftkMdDeployable',
  'sftkMdRecordFileXml', 'sftkMdMissingFields', 'sftkMdListMax', 'sftkMdReadMax',
]);

// A response shaped like the real thing: prefixed envelope, repeated
// sibling elements, a self-closing nil, a DECOY <records> nested inside a
// record, and a record whose fullName is nil (Salesforce's way of saying
// "that component does not exist").
const SOAP = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
<soapenv:Body><readMetadataResponse><result>
<records xsi:type="NamedCredential">
  <fullName>Partner_API</fullName>
  <endpoint>https://api.partner.com/v2</endpoint>
  <parameters><parameterName>ClientId</parameterName><parameterValue>abc</parameterValue></parameters>
  <parameters><parameterName>Scope</parameterName><parameterValue>read</parameterValue></parameters>
  <password xsi:nil="true"/>
</records>
<records xsi:type="NamedCredential">
  <fullName>Nested_Case</fullName>
  <outer><records>DECOY</records></outer>
  <label>Has &amp; ampersand</label>
</records>
<records><fullName xsi:nil="true"/></records>
</result></readMetadataResponse></soapenv:Body></soapenv:Envelope>`;

describe('SOAP framing', () => {
  it('puts the session id in a Metadata-API SessionHeader', () => {
    const env = F.sftkMdEnvelope('00Dxx!SID', '<met:listMetadata/>');
    expect(env).toContain('xmlns:met="http://soap.sforce.com/2006/04/metadata"');
    expect(env).toContain('<met:sessionId>00Dxx!SID</met:sessionId>');
    expect(env).toContain('<soapenv:Body><met:listMetadata/></soapenv:Body>');
  });

  it('escapes a session id rather than letting it break the envelope', () => {
    expect(F.sftkMdEnvelope('a&b<c', '<x/>')).toContain('<met:sessionId>a&amp;b&lt;c</met:sessionId>');
  });

  it('honours Salesforce’s own per-call ceilings', () => {
    // These are the API's limits, not ours — exceeding them is an error,
    // so the body builders clamp and the caller chunks.
    expect(F.sftkMdListMax()).toBe(3);
    expect(F.sftkMdReadMax()).toBe(10);
    const many = Array.from({ length: 20 }, (_, i) => `T${i}`);
    expect((F.sftkMdListBody(many, '62.0').match(/<met:queries>/g) || [])).toHaveLength(3);
    expect((F.sftkMdReadBody('ConnectedApp', many).match(/<met:fullNames>/g) || [])).toHaveLength(10);
  });

  it('builds a listMetadata query with and without a folder', () => {
    const b = F.sftkMdListBody(['ConnectedApp', { type: 'Report', folder: 'MyFolder' }], '62.0');
    expect(b).toContain('<met:type>ConnectedApp</met:type>');
    expect(b).toContain('<met:folder>MyFolder</met:folder>');
    expect(b).toContain('<met:asOfVersion>62.0</met:asOfVersion>');
  });

  it('reads a SOAP fault with or without a namespace prefix', () => {
    expect(F.sftkMdFault('<soapenv:Fault><faultstring>INVALID_SESSION_ID</faultstring></soapenv:Fault>'))
      .toBe('INVALID_SESSION_ID');
    expect(F.sftkMdFault('<sf:Fault><sf:faultstring>No access</sf:faultstring></sf:Fault>'))
      .toBe('No access');
    // A successful response is not a fault.
    expect(F.sftkMdFault(SOAP)).toBe(null);
  });
});

describe('element extraction — the only structure we interpret', () => {
  it('finds an element’s exact extent, counting depth on its own tag', () => {
    const s = '<a><b>1<b>2</b></b></a>';
    const el = F.sftkMdFindElement(s, 'b', 0);
    expect(s.slice(el.bodyStart, el.bodyEnd)).toBe('1<b>2</b>');
  });

  it('treats a self-closing tag as PRESENT but empty, not as an opener', () => {
    // The dangerous failure: reading <password xsi:nil="true"/> as an
    // opening tag would swallow every sibling that follows it.
    const s = '<r><password xsi:nil="true"/><endpoint>keep</endpoint></r>';
    const el = F.sftkMdFindElement(s, 'password', 0);
    expect(el.bodyStart).toBe(el.bodyEnd);
    expect(s.slice(el.end)).toBe('<endpoint>keep</endpoint></r>');
  });

  it('refuses to guess at unbalanced XML rather than returning garbage', () => {
    expect(F.sftkMdFindElement('<a><b>oops</a>', 'b', 0)).toBe(null);
  });

  it('tolerates namespace prefixes on both open and close tags', () => {
    const el = F.sftkMdFindElement('<ns1:records><x>1</x></ns1:records>', 'records', 0);
    expect(el).not.toBe(null);
    expect('<ns1:records><x>1</x></ns1:records>'.slice(el.bodyStart, el.bodyEnd)).toBe('<x>1</x>');
  });

  it('does not match a tag whose name merely starts the same', () => {
    // <fullNames> must not be found when looking for <fullName>.
    const s = '<r><fullNames>plural</fullNames></r>';
    expect(F.sftkMdChildText(s, 'fullName')).toBe(null);
  });
});

describe('readMetadata records', () => {
  const out = F.sftkMdExtractRecords(SOAP);

  it('pulls each record and keeps repeated siblings intact', () => {
    expect(out.records.map(r => r.fullName)).toEqual(['Partner_API', 'Nested_Case']);
    expect((out.records[0].innerXml.match(/<parameters>/g) || [])).toHaveLength(2);
  });

  it('a nested same-name element does not split the record it lives in', () => {
    const nested = out.records.find(r => r.fullName === 'Nested_Case');
    expect(nested.innerXml).toContain('DECOY');
    // and it did not swallow the record that follows
    expect(nested.innerXml).not.toContain('xsi:nil');
  });

  it('a nil fullName is an ABSENCE, counted — never written under a guess', () => {
    // Salesforce answers readMetadata for a component that does not exist
    // with an empty record. Writing that to a package under an invented
    // name would deploy a blank component over a real one.
    expect(out.nameless).toBe(1);
    expect(out.records).toHaveLength(2);
  });

  it('carries values through UNTOUCHED — escaped text stays escaped', () => {
    const nested = out.records.find(r => r.fullName === 'Nested_Case');
    expect(nested.innerXml).toContain('Has &amp; ampersand');
  });

  it('unescapes only the values it reads AS TEXT', () => {
    expect(F.sftkMdUnescape('a &amp;lt; b')).toBe('a &lt; b');
    expect(F.sftkMdUnescape('&lt;tag&gt; &quot;q&quot; &apos;a&apos;')).toBe('<tag> "q" \'a\'');
  });
});

describe('the package file', () => {
  it('wraps the body in the metadata type and drops fullName', () => {
    // In a package the FILENAME carries identity; a fullName that disagrees
    // with it is a deploy error.
    const rec = F.sftkMdExtractRecords(SOAP).records[0];
    const file = F.sftkMdRecordFileXml('NamedCredential', rec.innerXml);
    expect(file).toContain('<NamedCredential xmlns="http://soap.sforce.com/2006/04/metadata">');
    expect(file).toContain('</NamedCredential>');
    expect(file).not.toContain('<fullName>');
    expect(file).toContain('https://api.partner.com/v2');
    expect(file.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });
});

describe('what did NOT come back — asked of the response, not of a rule', () => {
  it('reports a nil field and an absent field as missing, a present one as not', () => {
    // This is the honesty mechanism for secrets. If a future API version
    // starts returning a value, the UI must stop claiming it was withheld —
    // so the answer comes from the RESPONSE, never from a hard-coded list.
    const rec = F.sftkMdExtractRecords(SOAP).records[0];
    expect(F.sftkMdMissingFields(rec.innerXml, ['password', 'oauthToken', 'endpoint']))
      .toEqual(['password', 'oauthToken']);
  });

  it('an empty element counts as missing too', () => {
    expect(F.sftkMdMissingFields('<r><consumerSecret></consumerSecret></r>', ['consumerSecret']))
      .toEqual(['consumerSecret']);
  });
});

describe('listMetadata + managed-package safety', () => {
  const LIST = `<listMetadataResponse>
    <result><fullName>Mine</fullName><type>ConnectedApp</type><manageableState>unmanaged</manageableState></result>
    <result><fullName>acme__Theirs</fullName><type>ConnectedApp</type><namespacePrefix>acme</namespacePrefix><manageableState>installed</manageableState></result>
    <result><fullName>Locked</fullName><type>ConnectedApp</type><manageableState>installed</manageableState></result>
    <result><type>ConnectedApp</type></result>
  </listMetadataResponse>`;

  it('reads the component list, skipping entries with no name', () => {
    const listed = F.sftkMdExtractListed(LIST);
    expect(listed.map(l => l.fullName)).toEqual(['Mine', 'acme__Theirs', 'Locked']);
    expect(listed[1].namespacePrefix).toBe('acme');
  });

  it('refuses managed and installed components BY NAME, not by failing the deploy', () => {
    // One unmovable component would otherwise take the whole package down.
    const split = F.sftkMdDeployable(F.sftkMdExtractListed(LIST));
    expect(split.deployable.map(d => d.fullName)).toEqual(['Mine']);
    expect(split.skipped.map(s => s.name).sort()).toEqual(['Locked', 'acme__Theirs']);
    expect(split.skipped.find(s => s.name === 'acme__Theirs').why).toContain('acme');
    expect(split.skipped.find(s => s.name === 'Locked').why).toContain('installed');
  });
});

describe('the library keeps the project’s conventions', () => {
  it('exports on globalThis, with no module wrapper', () => {
    expect(MD).toContain('globalThis.sftkMdExtractRecords');
    expect(MD).not.toContain('module.exports');
  });

  it('states WHY it transplants instead of parsing', () => {
    // The reasoning is load-bearing: the next person must not "improve"
    // this into a parser that reinterprets values.
    expect(MD).toContain('no DOMParser');
    expect(MD).toContain('TRANSPLANT');
  });
});
