// The matrix (user 2026-11-14: "from every metadata type test a full delete and a partial remove where the field
// appears ONE time in the xml and where it appears A COUPLE of times") — the object family:
// FieldSet, ListView, CompactLayout, QuickAction, CustomMetadataRecord, LeadConvertSettings (lead field mapping),
// AssignmentRule, AutoResponseRule, EscalationRule, ApprovalProcess.
// Per type: 🗑 the full delete (spec, destructive manifest, the restore file), ✂ with one mention, ✂ with several
// mentions (all in one pass, or refused as a whole), ⇄ with several mentions. The REAL functions of sftk-mdapi.js,
// on the inner XML readMetadata returns (one line, alphabetical children, fullName first).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const FC = readFileSync(new URL('../field-cleaner.js', import.meta.url), 'utf8');
const M = extractFunctions('sftk-mdapi.js', ['sftkMdEditField', 'sftkFormulaDropField', 'sftkMdEditWays', '_sftkMdFieldIs', '_sftkMdRenameVal', '_sftkMdWalk',
  '_sftkMdSwapToken', '_sftkMdHasLogic', 'sftkMdFindElement', 'sftkMdUnescape', 'sftkMdEscape', 'sftkMdChildText', 'sftkMdChildren', 'sftkMdLeadMappingRemove',
  'sftkMdLeadMappingsFor', 'sftkMdValuesHolding', 'sftkMdMentionsField', 'sftkMdPackageFiles', 'sftkMdDestructiveFiles', 'sftkMdDeleteSpec', '_sftkMdDeleteTable',
  '_sftkPkgXml', 'sftkMdRecordFileXml', 'sftkMdWellFormed']);

const F = 'SFTK_Live_Blk__c', N = 'SFTK_Live_Blk2__c';
const rm = (t, x, o = 'Account') => M.sftkMdEditField(t, x, o, F, null);
const rp = (t, x, o = 'Account') => M.sftkMdEditField(t, x, o, F, N);

// ── the checks ───────────────────────────────────────────────────────────────
// the API name as a whole word, any spelling ("Object.Field__c" and the bare "Field__c" alike), any case
const word = f => new RegExp(`(^|[^A-Za-z0-9_])${f}(?![A-Za-z0-9_])`, 'i');
const count = (xml, f) => (xml.match(new RegExp(`(^|[^A-Za-z0-9_])${f}(?![A-Za-z0-9_])`, 'gi')) || []).length;
// a strict tag-balance check of the test's own, next to the product's sftkMdWellFormed
function strict(xml) {
  const stack = [];
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+="[^"<>]*")*)\s*(\/?)>/g;
  let m, last = 0;
  const textOk = t => !/[<>]/.test(t) && !/&(?!(?:amp|lt|gt|quot|apos|#\d+);)/.test(t);
  while ((m = re.exec(xml))) {
    if (!textOk(xml.slice(last, m.index))) return `bad text before offset ${m.index}`;
    last = re.lastIndex;
    if (m[4]) continue;
    if (!m[1]) { stack.push(m[2]); continue; }
    const open = stack.pop();
    if (open !== m[2]) return `<${open}> closed by </${m[2]}>`;
  }
  if (!textOk(xml.slice(last))) return 'bad text at the end';
  return stack.length ? `<${stack[stack.length - 1]}> never closed` : null;
}
const sound = xml => { expect(M.sftkMdWellFormed(xml)).toBeNull(); expect(strict(xml)).toBeNull(); };
// after ✂: no place names the field — the product's own mention test and the plain whole-word search
const gone = (xml, o = 'Account') => { expect(M.sftkMdMentionsField(xml, o, F)).toBe(false); expect(word(F).test(xml)).toBe(false); };
// a refusal changes nothing and says nothing was done
const refusedWhole = (r, before, why) => { expect(r.refused).toMatch(why); expect(r.xml).toBe(before); expect(r.changed).toBe(false); expect(r.how).toEqual([]); };
// ✂ done: exactly `expected` is left, it is sound, the field is gone
const removed = (r, before, expected, o = 'Account') => {
  expect(r.refused).toBeNull(); expect(r.changed).toBe(true);
  expect(expected).not.toBe(before);
  expect(r.xml).toBe(expected);
  sound(r.xml); gone(r.xml, o);
};
// ⇄ done: `n` places name the new field, none the old, and the rest is byte for byte
const swapped = (r, before, n, o = 'Account') => {
  expect(r.refused).toBeNull(); expect(r.changed).toBe(true);
  gone(r.xml, o); sound(r.xml);
  expect(count(r.xml, N)).toBe(n);
  expect(count(before, F)).toBe(n);                       // the fixture names the field n times, all of them swapped
  expect(r.xml.split(N).join(F)).toBe(before);
};
// numbered logic never points past the items it numbers: every <box> that has a booleanFilter has enough <item>s
const logicConsistent = (xml, box, item) => {
  for (const b of (box ? M.sftkMdChildren(xml, box).map(c => c.innerXml) : [xml])) {
    const bf = M.sftkMdChildText(b, 'booleanFilter');
    if (!bf) continue;
    const max = Math.max(...(bf.match(/\d+/g) || ['0']).map(Number));
    expect(M.sftkMdChildren(b, item).length).toBeGreaterThanOrEqual(max);
  }
};
const HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"';
const manifest = (type, member) => `${HEAD}<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n    <types>\n        <members>${member}</members>\n        <name>${type}</name>\n    </types>\n    <version>62.0</version>\n</Package>`;
const EMPTY_PKG = `${HEAD}<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n    <version>62.0</version>\n</Package>`;
// 🗑: the row is a known kind (not "fixable" by the classic path, a blocker or a mention), the engine has a spec,
// the delete is an empty package + destructiveChangesPost naming the member, and the restore file puts it back
function fullDelete(type, mdType, fullName, inner, o) {
  expect(FC).toMatch(new RegExp(`^\\s*${type}:\\s*\\{[^\\n]*fixable: false, sev: '${o.sev}'`, 'm'));
  const spec = M.sftkMdDeleteSpec(type);
  expect(spec).toMatchObject({ type, mdType, folder: o.folder, suffix: o.suffix, what: o.what });
  if (o.parent) expect(spec).toMatchObject({ parent: o.parent, tag: o.tag }); else expect(spec.parent).toBeUndefined();
  const del = M.sftkMdDestructiveFiles([[spec.mdType, fullName]]);
  expect(del).toEqual([{ name: 'package.xml', text: EMPTY_PKG }, { name: 'destructiveChangesPost.xml', text: manifest(mdType, fullName) }]);
  sound(del[1].text.replace(HEAD, ''));
  const back = M.sftkMdPackageFiles(type, fullName, inner);
  expect(back.map(f => f.name)).toEqual(['package.xml', o.file]);
  expect(back[0].text).toBe(manifest(mdType, fullName));
  expect(back[1].text).toBe(o.restore);
  sound(back[1].text.replace(HEAD, ''));
  return spec;
}

describe('the wiring every case below leans on', () => {
  it('a known kind gets ✂ / ⇄ from its ways and 🗑 from its spec; the lead mapping’s 🗑 is its ✂', () => {
    expect(FC).toContain("const knownKind = !cfgT.fixable && (cfgT.sev === 'blocker' || cfgT.sev === 'silent');");
    expect(FC).toContain("const ways = (knownKind && typeof sftkMdEditWays === 'function') ? sftkMdEditWays(type) : null;");
    expect(FC).toContain("const del = (spec && !(ways && ways.remove && type === 'LeadConvertSettings')) ?");
    expect(FC).toContain("const zipDel = plan.deployFiles ? _zipOf(plan.deployFiles) : (plan.patch || plan.pb) ? null : _zipOf(sftkMdDestructiveFiles([[spec.mdType, fullName]]));");
    expect(FC).toContain('const ed = sftkMdEditField(type, rec.innerXml, obj, field, nf);');
    for (const t of ['FieldSet', 'ListView', 'CompactLayout', 'QuickAction', 'CustomMetadataRecord', 'LeadConvertSettings', 'AssignmentRule', 'AutoResponseRule', 'EscalationRule', 'ApprovalProcess']) {
      expect(M.sftkMdEditWays(t), t).toEqual({ remove: true, replace: true });
    }
  });
});

// ── FieldSet ─────────────────────────────────────────────────────────────────
describe('FieldSet', () => {
  const row = (f, tag = 'displayedFields') => `<${tag}><field>${f}</field><isFieldManaged>false</isFieldManaged><isRequired>false</isRequired></${tag}>`;
  const head = '<fullName>Account.SFTK_Live_FS</fullName><availableFields><field>Industry</field><isFieldManaged>false</isFieldManaged><isRequired>false</isRequired></availableFields>';
  const tail = '<description>SFTK live demo</description>' + row('Name') + row('Owner.Name') + '<label>SFTK Live FS</label>';
  it('🗑 full delete: a child of the object file, destructive member Object.FieldSet', () => {
    const inner = head + tail;
    fullDelete('FieldSet', 'FieldSet', 'Account.SFTK_Live_FS', inner, { sev: 'blocker', parent: 'CustomObject', tag: 'fieldSets', folder: 'objects', suffix: 'object', what: 'field set',
      file: 'objects/Account.object', restore: `${HEAD}<CustomObject ${NS}><fieldSets><fullName>SFTK_Live_FS</fullName>${inner.replace('<fullName>Account.SFTK_Live_FS</fullName>', '')}</fieldSets></CustomObject>` });
  });
  it('✂ one mention: a displayed field among others goes, the others stay', () => {
    const before = head + '<description>SFTK live demo</description>' + row('Name') + row(F) + row('Owner.Name') + '<label>SFTK Live FS</label>';
    const r = rm('FieldSet', before);
    removed(r, before, head + tail);
    expect(r.how).toEqual(['field set: the field taken out']);
  });
  it('✂ one mention: an AVAILABLE field (not displayed), written Object.Field', () => {
    const before = head + row(`Account.${F}`, 'availableFields') + tail;
    removed(rm('FieldSet', before), before, head + tail);
  });
  it('✂ one mention, the set’s only field: the set is left empty (a field set may list nothing), nothing else moves', () => {
    const before = '<fullName>Account.SFTK_Live_FS</fullName><description>SFTK live demo</description>' + row(F) + '<label>SFTK Live FS</label>';
    removed(rm('FieldSet', before), before, '<fullName>Account.SFTK_Live_FS</fullName><description>SFTK live demo</description><label>SFTK Live FS</label>');
  });
  // 2026-11-15 (second review): this test pinned a defect — it kept `Parent.<field>` in an ACCOUNT field set as
  // "the parent account's field, not this one". Parent on Account is a self-lookup: that entry names this very
  // field (Salesforce refuses the field's delete while it is listed), so ✂ left it behind and still said done.
  // It now goes with the others (test/regress-1115-refix.test.mjs); a path through ANOTHER object (Owner.) stays.
  it('✂ several mentions: displayed and available, both spellings, and the self-lookup path — all go in one pass; a longer name and a path through another object stay', () => {
    const others = row('SFTK_Live_Blk__c_Old__c') + row(`Owner.${F}`);   // not this field: a longer name, and the owner USER's field (a path)
    const before = head + row(F, 'availableFields') + '<description>SFTK live demo</description>' + row('Name') + row(`Account.${F}`) + row(`Parent.${F}`) + others + row(`account.${F.toLowerCase()}`) + '<label>SFTK Live FS</label>';
    const r = rm('FieldSet', before);
    expect(r.refused).toBeNull();
    expect(r.xml).toBe(head + '<description>SFTK live demo</description>' + row('Name') + others + '<label>SFTK Live FS</label>');
    sound(r.xml);
    expect(r.how).toEqual(['field set: the field taken out']);
  });
  it('✂ on a set that does not list the field is refused, nothing changed', () => {
    refusedWhole(rm('FieldSet', head + tail), head + tail, /does not list the field/);
  });
  it('⇄ several mentions: every one names the new field, in its own spelling', () => {
    const before = head + row(F, 'availableFields') + '<description>SFTK live demo</description>' + row('Name') + row(`Account.${F}`) + '<label>SFTK Live FS</label>';
    const r = rp('FieldSet', before);
    swapped(r, before, 2);
    expect(r.xml).toContain(`<availableFields><field>${N}</field>`);
    expect(r.xml).toContain(`<displayedFields><field>Account.${N}</field>`);
    expect(r.how).toEqual([`field set: the field now ${N}`]);
  });
});

// ── ListView ─────────────────────────────────────────────────────────────────
describe('ListView', () => {
  const flt = (f, op = 'equals', v = 'x') => `<filters><field>${f}</field><operation>${op}</operation><value>${v}</value></filters>`;
  const col = f => `<columns>${f}</columns>`;
  const lv = (cols, filters, logic) => `<fullName>Account.SFTK_Live_LV</fullName>${logic ? `<booleanFilter>${logic}</booleanFilter>` : ''}${cols}<filterScope>Everything</filterScope>${filters}<label>SFTK Live LV</label><sharedTo><allInternalUsers></allInternalUsers></sharedTo>`;
  it('🗑 full delete: a child of the object file, destructive member Object.View', () => {
    const inner = lv(col('ACCOUNT.NAME') + col(F), flt(F));
    fullDelete('ListView', 'ListView', 'Account.SFTK_Live_LV', inner, { sev: 'silent', parent: 'CustomObject', tag: 'listViews', folder: 'objects', suffix: 'object', what: 'list view',
      file: 'objects/Account.object', restore: `${HEAD}<CustomObject ${NS}><listViews><fullName>SFTK_Live_LV</fullName>${inner.replace('<fullName>Account.SFTK_Live_LV</fullName>', '')}</listViews></CustomObject>` });
  });
  it('✂ one mention, a column: the column goes — even under a numbered filter logic, which does not number columns', () => {
    const filters = flt('ACCOUNT.TYPE', 'equals', 'Customer') + flt('ACCOUNT.INDUSTRY', 'notEqual', 'Banking');
    const before = lv(col('ACCOUNT.NAME') + col(F) + col('ACCOUNT.TYPE'), filters, '1 OR 2');
    const r = rm('ListView', before);
    removed(r, before, lv(col('ACCOUNT.NAME') + col('ACCOUNT.TYPE'), filters, '1 OR 2'));
    logicConsistent(r.xml, null, 'filters');
    expect(r.how).toEqual(['1 column removed']);
  });
  it('✂ one mention, a filter (no numbered logic): the filter goes, the other filter and the columns stay', () => {
    const before = lv(col('ACCOUNT.NAME'), flt('ACCOUNT.TYPE', 'equals', 'Customer') + flt(F, 'notEqual', ''));
    const r = rm('ListView', before);
    removed(r, before, lv(col('ACCOUNT.NAME'), flt('ACCOUNT.TYPE', 'equals', 'Customer')));
    expect(r.how).toEqual(['1 filter removed']);
  });
  it('✂ one mention, the view’s ONLY filter: the view simply shows everything in its scope', () => {
    const before = lv(col('ACCOUNT.NAME'), flt(`Account.${F}`, 'equals', 'x'));
    removed(rm('ListView', before), before, lv(col('ACCOUNT.NAME'), ''));
  });
  it('✂ one mention, a filter under numbered logic: refused — the numbers would point at the wrong filters', () => {
    const before = lv(col('ACCOUNT.NAME'), flt('ACCOUNT.TYPE') + flt(F) + flt('ACCOUNT.INDUSTRY'), '1 AND (2 OR 3)');
    refusedWhole(rm('ListView', before), before, /filter logic numbers its filters/);
  });
  it('✂ one mention, the view’s only column and no filter: refused, with the ways that work', () => {
    const before = lv(col(F), '');
    refusedWhole(rm('ListView', before), before, /only column .*Replace it, or .* delete the view/);
  });
  it('✂ several mentions: a column and two filters — all three go in one pass, the rest byte for byte', () => {
    const before = lv(col('ACCOUNT.NAME') + col(F) + col('CORE.USERS.ALIAS'), flt(F, 'notEqual', '') + flt('ACCOUNT.TYPE', 'equals', 'Customer') + flt(`Account.${F}`, 'contains', 'vip'));
    const r = rm('ListView', before);
    removed(r, before, lv(col('ACCOUNT.NAME') + col('CORE.USERS.ALIAS'), flt('ACCOUNT.TYPE', 'equals', 'Customer')));
    expect(r.how).toEqual(['1 column removed, 2 filters removed']);
  });
  it('✂ several mentions, one under numbered logic: refused as a whole — the column is NOT taken out on its own', () => {
    const before = lv(col('ACCOUNT.NAME') + col(F), flt('ACCOUNT.TYPE') + flt(F), '1 OR 2');
    const r = rm('ListView', before);
    refusedWhole(r, before, /filter logic numbers its filters/);
    expect(r.xml).toContain(col(F));
  });
  it('✂ on a view that names the field nowhere is refused', () => {
    const before = lv(col('ACCOUNT.NAME'), flt('ACCOUNT.TYPE'));
    refusedWhole(rm('ListView', before), before, /no column or filter/);
  });
  it('⇄ several mentions: the column and both filters name the new field — numbered logic is no obstacle', () => {
    const before = lv(col('ACCOUNT.NAME') + col(F), flt(F, 'notEqual', '') + flt('ACCOUNT.TYPE') + flt(`Account.${F}`, 'contains', 'vip'), '1 AND (2 OR 3)');
    const r = rp('ListView', before);
    swapped(r, before, 3);
    logicConsistent(r.xml, null, 'filters');
    expect(r.xml).toContain(`<field>Account.${N}</field>`);
    expect(r.how).toEqual([`1 column now ${N}, 2 filters now ${N}`]);
  });
});

// ── CompactLayout ────────────────────────────────────────────────────────────
describe('CompactLayout', () => {
  const cl = fields => `<fullName>Account.SFTK_Live_CL</fullName>${fields.map(f => `<fields>${f}</fields>`).join('')}<label>SFTK Live CL</label>`;
  it('🗑 full delete: a child of the object file, destructive member Object.Layout', () => {
    const inner = cl(['Name', F]);
    fullDelete('CompactLayout', 'CompactLayout', 'Account.SFTK_Live_CL', inner, { sev: 'silent', parent: 'CustomObject', tag: 'compactLayouts', folder: 'objects', suffix: 'object', what: 'compact layout',
      file: 'objects/Account.object', restore: `${HEAD}<CustomObject ${NS}><compactLayouts><fullName>SFTK_Live_CL</fullName><fields>Name</fields><fields>${F}</fields><label>SFTK Live CL</label></compactLayouts></CustomObject>` });
  });
  it('✂ one mention: the field goes from the middle of the list, the order of the others is kept', () => {
    const before = cl(['Name', 'Phone', F, 'OwnerId']);
    const r = rm('CompactLayout', before);
    removed(r, before, cl(['Name', 'Phone', 'OwnerId']));
    expect(r.how).toEqual(['1 field removed']);
  });
  it('✂ one mention, the layout’s only field: refused — a compact layout needs a field', () => {
    const before = cl([F]);
    refusedWhole(rm('CompactLayout', before), before, /only field .*Replace it, or .* delete the compact layout/);
  });
  it('✂ several mentions (both spellings in one list): all go in one pass', () => {
    // Setup lets a field in once; the list is still walked whole, so a file that names it twice is cleaned in one go
    const before = cl([F, 'Name', `Account.${F}`, 'Phone']);
    const r = rm('CompactLayout', before);
    removed(r, before, cl(['Name', 'Phone']));
    expect(r.how).toEqual(['2 fields removed']);
  });
  it('✂ several mentions that are ALL the layout has: refused as a whole', () => {
    const before = cl([F, `Account.${F}`]);
    refusedWhole(rm('CompactLayout', before), before, /only field/);
  });
  it('✂ on a layout that does not list the field (a longer name is not it) is refused', () => {
    const before = cl(['Name', 'SFTK_Live_Blk__c_Old__c']);
    refusedWhole(rm('CompactLayout', before), before, /does not list the field/);
  });
  it('⇄ several mentions: every one names the new field', () => {
    const before = cl([F, 'Name', `Account.${F}`]);
    const r = rp('CompactLayout', before);
    swapped(r, before, 2);
    expect(r.xml).toBe(cl([N, 'Name', `Account.${N}`]));
    expect(r.how).toEqual([`2 fields now ${N}`]);
  });
});

// ── QuickAction ──────────────────────────────────────────────────────────────
describe('QuickAction', () => {
  const item = f => `<quickActionLayoutItems><emptySpace>false</emptySpace><field>${f}</field><uiBehavior>Edit</uiBehavior></quickActionLayoutItems>`;
  const ovr = (f, formula) => `<fieldOverrides><field>${f}</field><formula>${formula}</formula></fieldOverrides>`;
  const qa = (overrides, col1, col2) => `<fullName>Account.SFTK_Live_QA</fullName>${overrides}<label>SFTK Live QA</label><optionsCreateFeedItem>false</optionsCreateFeedItem><quickActionLayout><layoutSectionStyle>TwoColumnsLeftToRight</layoutSectionStyle><quickActionLayoutColumns>${col1}</quickActionLayoutColumns><quickActionLayoutColumns>${col2}</quickActionLayoutColumns></quickActionLayout><type>Update</type>`;
  it('🗑 full delete: a file of its own, destructive member Object.Action', () => {
    const inner = qa(ovr(F, '&quot;x&quot;'), item('Name') + item(F), item('Phone'));
    fullDelete('QuickAction', 'QuickAction', 'Account.SFTK_Live_QA', inner, { sev: 'silent', folder: 'quickActions', suffix: 'quickAction', what: 'quick action',
      file: 'quickActions/Account.SFTK_Live_QA.quickAction', restore: `${HEAD}<QuickAction ${NS}>${inner.replace('<fullName>Account.SFTK_Live_QA</fullName>', '')}</QuickAction>` });
  });
  it('✂ one mention, a layout item: the item goes, the columns and the other items stay', () => {
    const before = qa('', item('Name') + item(F), item('Phone'));
    const r = rm('QuickAction', before);
    removed(r, before, qa('', item('Name'), item('Phone')));
    expect(r.how).toEqual(['1 layout field removed']);
  });
  it('✂ one mention, a predefined value OF the field: the override goes, the layout stays', () => {
    const before = qa(ovr('Description', '&quot;from the action&quot;') + ovr(F, 'TEXT(TODAY())'), item('Name'), item('Phone'));
    const r = rm('QuickAction', before);
    removed(r, before, qa(ovr('Description', '&quot;from the action&quot;'), item('Name'), item('Phone')));
    expect(r.how).toEqual(['1 predefined value removed']);
  });
  it('✂ one mention, the only item of its column: the column stays, empty — as Salesforce writes an empty column', () => {
    const before = qa('', item('Name'), item(F));
    removed(rm('QuickAction', before), before, qa('', item('Name'), ''));
  });
  it('✂ several mentions: the layout item and the predefined value go in one pass', () => {
    const before = qa(ovr(F, '&quot;x&quot;') + ovr('Description', '&quot;y&quot;'), item('Name') + item(`Account.${F}`), item('Phone'));
    const r = rm('QuickAction', before);
    removed(r, before, qa(ovr('Description', '&quot;y&quot;'), item('Name'), item('Phone')));
    expect(r.how).toEqual(['1 layout field removed, 1 predefined value removed']);
  });
  it('✂ on an action that names the field nowhere is refused', () => {
    const before = qa(ovr('Description', '&quot;y&quot;'), item('Name'), item('Phone'));
    refusedWhole(rm('QuickAction', before), before, /neither the action.s layout nor its predefined values name the field/);
  });
  it('⇄ several mentions: the layout item and the predefined value name the new field', () => {
    const before = qa(ovr(F, '&quot;x&quot;'), item('Name') + item(F), item('Phone'));
    const r = rp('QuickAction', before);
    swapped(r, before, 2);
    expect(r.how).toEqual([`1 layout field now ${N}, 1 predefined value now ${N}`]);
  });
  // FIXED 2026-11-14 (was a product bug): a predefined value of ANOTHER field whose <formula> reads this field
  // (<fieldOverrides><field>Description</field><formula>Account.SFTK_Live_Blk__c</formula></fieldOverrides>) is
  // not seen by the QuickAction case of sftkMdEditField (sftk-mdapi.js: items(li.xml, 'fieldOverrides', 'field') looks
  // at <field> only). ✂ answers "1 layout field removed" and ⇄ "1 layout field now …" while the formula still names
  // the old field — and fixEdit's re-read check (_editStillNames) uses the same blind engine, so it says "verified".
  // Expected: ⇄ swaps the token in the formula too; ✂ refuses (a formula cannot lose a reference) or drops that override.
  it('✂ several mentions — a layout item AND another field’s predefined-value formula that reads the field: refused as a whole', () => {
    const before = qa(ovr('Description', `&quot;was &quot; &amp; Account.${F}`), item('Name') + item(F), item('Phone'));
    const r = rm('QuickAction', before);
    // a formula cannot lose a reference: the whole edit is refused — never "done" with the formula still naming the field
    refusedWhole(r, before, /predefined value.s formula names the field/);
  });
  it('⇄ several mentions — the predefined-value formula that reads the field names the new field too', () => {
    const before = qa(ovr('Description', `&quot;was &quot; &amp; Account.${F}`), item('Name') + item(F), item('Phone'));
    swapped(rp('QuickAction', before), before, 2);
  });
  it('a predefined-value formula is the ONLY mention — the scan sees it and ⇄ swaps it', () => {
    const before = qa(ovr('Description', `Account.${F}`), item('Name'), item('Phone'));
    expect(M.sftkMdMentionsField(before, 'Account', F)).toBe(true);     // the product's own mention test sees it
    swapped(rp('QuickAction', before), before, 1);
  });
});

// ── CustomMetadataRecord ─────────────────────────────────────────────────────
describe('CustomMetadataRecord', () => {
  const val = (f, v) => `<values><field>${f}</field><value xsi:type="xsd:string">${v}</value></values>`;
  const nil = f => `<values><field>${f}</field><value xsi:nil="true"/></values>`;
  const cmt = values => `<fullName>SFTK_Live_Cmt.Ref</fullName><label>Ref</label><protected>false</protected>${values}`;
  const holding = (xml, o = 'Account') => M.sftkMdValuesHolding(xml, o, F);
  it('🗑 full delete: deployed and deleted as CustomMetadata, a file of its own', () => {
    const inner = cmt(val('Entity__c', 'Account') + val('Field__c', F));
    const spec = fullDelete('CustomMetadataRecord', 'CustomMetadata', 'SFTK_Live_Cmt.Ref', inner, { sev: 'blocker', folder: 'customMetadata', suffix: 'md', what: 'custom metadata record',
      file: 'customMetadata/SFTK_Live_Cmt.Ref.md', restore: `${HEAD}<CustomMetadata ${NS}><label>Ref</label><protected>false</protected>${val('Entity__c', 'Account')}${val('Field__c', F)}</CustomMetadata>` });
    expect(spec.tooling).toBeUndefined();   // no Tooling row: the scan's own full name is the member
  });
  it('✂ one mention, a bare name next to its object: the value is emptied (nil), the record and its other values stay', () => {
    const before = cmt(val('Entity__c', 'Account') + val('Field__c', F) + val('Note__c', 'keep me'));
    expect(holding(before)).toEqual(['Field__c']);
    const r = rm('CustomMetadataRecord', before);
    removed(r, before, cmt(val('Entity__c', 'Account') + nil('Field__c') + val('Note__c', 'keep me')));
    expect(holding(r.xml)).toEqual([]);
    expect(r.how).toEqual(['1 value emptied']);
    // the nil value is valid in the file the deploy sends: the wrapper declares xsi
    const file = M.sftkMdPackageFiles('CustomMetadataRecord', 'SFTK_Live_Cmt.Ref', r.xml)[1].text;
    expect(file).toContain('xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"');
    expect(file).toContain('<values><field>Field__c</field><value xsi:nil="true"/></values>');
  });
  it('✂ one mention, written Object.Field (a Field Definition relationship): emptied', () => {
    const before = cmt(val('Field__c', `Account.${F}`) + val('Active__c', 'true'));
    expect(holding(before)).toEqual(['Field__c']);
    const r = rm('CustomMetadataRecord', before);
    removed(r, before, cmt(nil('Field__c') + val('Active__c', 'true')));
    expect(holding(r.xml)).toEqual([]);
  });
  it('✂ several mentions: three values hold the field, in both spellings — all emptied in one pass, the others byte for byte', () => {
    const before = cmt(val('Entity__c', 'Account') + val('Source_Field__c', F) + val('Target_Field__c', `Account.${F}`) + val('Fallback_Field__c', F.toLowerCase()) + val('Other_Field__c', 'Industry'));
    expect(holding(before)).toEqual(['Source_Field__c', 'Target_Field__c', 'Fallback_Field__c']);
    const r = rm('CustomMetadataRecord', before);
    removed(r, before, cmt(val('Entity__c', 'Account') + nil('Source_Field__c') + nil('Target_Field__c') + nil('Fallback_Field__c') + val('Other_Field__c', 'Industry')));
    expect(holding(r.xml)).toEqual([]);
    expect(r.how).toEqual(['3 values emptied']);
  });
  it('✂ on a record no value of which holds the field (another object’s Object.Field, a longer name) is refused', () => {
    const before = cmt(val('Field__c', `Lead.${F}`) + val('Note__c', 'SFTK_Live_Blk__c_Old__c'));
    expect(holding(before)).toEqual([]);
    refusedWhole(rm('CustomMetadataRecord', before), before, /no value of the record holds the field/);
  });
  it('⇄ several mentions: each value names the new field in the spelling it had; the xsi:type stays', () => {
    const before = cmt(val('Entity__c', 'Account') + val('Source_Field__c', F) + val('Target_Field__c', `Account.${F}`));
    const r = rp('CustomMetadataRecord', before);
    swapped(r, before, 2);
    expect(r.xml).toBe(cmt(val('Entity__c', 'Account') + val('Source_Field__c', N) + val('Target_Field__c', `Account.${N}`)));
    expect(holding(r.xml)).toEqual([]);
    expect(M.sftkMdValuesHolding(r.xml, 'Account', N)).toEqual(['Source_Field__c', 'Target_Field__c']);
    expect(r.how).toEqual([`2 values now ${N}`]);
  });
  // FIXED 2026-11-14 (was a product bug): the scan (sftkMdValuesHolding) knows that a bare "Field__c" next to Entity__c = Lead is LEAD's field,
  // not Account's — but the CustomMetadataRecord case of sftkMdEditField (sftk-mdapi.js, _sftkMdFieldIs(v, objApi,
  // fieldApi)) takes every bare name. A record that maps Lead's field of the same API name AND holds
  // "Account.SFTK_Live_Blk__c" is rightly listed for Account (one value) — and ✂ / ⇄ then also empties / renames
  // Lead's value. Same-named fields on Lead and Account are the usual case (lead conversion).
  const mixed = cmt(val('Entity__c', 'Lead') + val('Field__c', F) + val('Copy_To__c', `Account.${F}`));
  it('✂ leaves another object’s same-named field the scan does not count', () => {
    expect(holding(mixed)).toEqual(['Copy_To__c']);                    // what the scan lists for Account
    expect(holding(mixed, 'Lead')).toEqual(['Field__c']);              // and that one is Lead's
    const r = rm('CustomMetadataRecord', mixed);
    expect(r.xml).toBe(cmt(val('Entity__c', 'Lead') + val('Field__c', F) + nil('Copy_To__c')));
    expect(r.how).toEqual(['1 value emptied']);
  });
  it('⇄ leaves another object’s same-named field the scan does not count', () => {
    const r = rp('CustomMetadataRecord', mixed);
    expect(r.xml).toBe(cmt(val('Entity__c', 'Lead') + val('Field__c', F) + val('Copy_To__c', `Account.${N}`)));
  });
});

// ── LeadConvertSettings (lead field mapping) ─────────────────────────────────
describe('LeadConvertSettings', () => {
  const line = (i, o) => `<mappingFields><inputField>${i}</inputField><outputField>${o}</outputField></mappingFields>`;
  const om = (out, lines) => `<objectMapping><inputObject>Lead</inputObject>${lines}<outputObject>${out}</outputObject></objectMapping>`;
  const lcs = maps => `<fullName>LeadConvertSettings</fullName><allowOwnerChange>true</allowOwnerChange>${maps}<opportunityCreationOptions>VisibleOptional</opportunityCreationOptions>`;
  const maps = (xml, o) => M.sftkMdLeadMappingsFor(xml, o, F);
  it('🗑 is not offered: the mapping is part of the org’s one settings record — its "delete" is the ✂ of the field’s line, deployed as the edited file', () => {
    expect(FC).toMatch(/^\s*LeadConvertSettings:\s*\{[^\n]*fixable: false, sev: 'blocker'/m);
    const spec = M.sftkMdDeleteSpec('LeadConvertSettings');
    expect(spec).toMatchObject({ mdType: 'LeadConvertSettings', folder: 'LeadConvertSettings', suffix: 'LeadConvertSetting', what: 'lead field mapping', edit: 'leadMapping' });
    expect(FC).toContain("const del = (spec && !(ways && ways.remove && type === 'LeadConvertSettings')) ?");   // no 🗑 button
    expect(FC).toContain("if (spec.edit === 'leadMapping') {");                                                    // the delete path edits
    expect(FC).toContain('deployFiles: sftkMdPackageFiles(type, fullName, res.xml), removed: res.removed,');
    // what that path deploys: the settings without the line — never a destructive manifest
    const before = lcs(om('Account', line(F, 'Industry') + line('Company', 'Name')));
    const res = M.sftkMdLeadMappingRemove(before, 'Lead', F);
    expect(res.removed).toBe(1);
    const files = M.sftkMdPackageFiles('LeadConvertSettings', 'LeadConvertSettings', res.xml);
    expect(files.map(f => f.name)).toEqual(['package.xml', 'LeadConvertSettings/LeadConvertSettings.LeadConvertSetting']);
    expect(files[0].text).toBe(manifest('LeadConvertSettings', 'LeadConvertSettings'));
    expect(files[1].text).toBe(`${HEAD}<LeadConvertSettings ${NS}><allowOwnerChange>true</allowOwnerChange>${om('Account', line('Company', 'Name'))}<opportunityCreationOptions>VisibleOptional</opportunityCreationOptions></LeadConvertSettings>`);
    sound(files[1].text.replace(HEAD, ''));
  });
  it('✂ one mention, the Lead side: the line goes, the other lines and the settings stay', () => {
    const before = lcs(om('Account', line('Company', 'Name') + line(F, 'Sic')) + om('Contact', line('Email', 'Email')));
    expect(maps(before, 'Lead')).toHaveLength(1);
    const r = rm('LeadConvertSettings', before, 'Lead');
    removed(r, before, lcs(om('Account', line('Company', 'Name')) + om('Contact', line('Email', 'Email'))), 'Lead');
    expect(maps(r.xml, 'Lead')).toEqual([]);
    expect(r.how).toEqual(['1 mapping line removed, the other lines kept']);
  });
  it('✂ one mention, the target side (the Account field a Lead field converts into): that line goes', () => {
    const before = lcs(om('Account', line('Company', 'Name') + line('Rating', F)) + om('Contact', line('Email', 'Email')));
    expect(maps(before, 'Account')).toEqual([{ inputObject: 'Lead', outputObject: 'Account', inputField: 'Rating', outputField: F }]);
    const r = rm('LeadConvertSettings', before, 'Account');
    removed(r, before, lcs(om('Account', line('Company', 'Name')) + om('Contact', line('Email', 'Email'))));
    expect(maps(r.xml, 'Account')).toEqual([]);
  });
  it('✂ one mention, the object’s only line: the objectMapping is KEPT, empty — that is how Salesforce clears a mapping', () => {
    const before = lcs(om('Account', line(F, 'Sic')) + om('Contact', line('Email', 'Email')));
    const r = rm('LeadConvertSettings', before, 'Lead');
    removed(r, before, lcs(om('Account', '') + om('Contact', line('Email', 'Email'))), 'Lead');
    expect(r.xml).toContain('<objectMapping><inputObject>Lead</inputObject><outputObject>Account</outputObject></objectMapping>');
  });
  it('✂ several mentions: one Lead field mapped into Account, Contact and Opportunity — all three lines go in one pass', () => {
    const before = lcs(om('Account', line('Company', 'Name') + line(F, 'Sic')) + om('Contact', line(F, 'Department') + line('Email', 'Email')) + om('Opportunity', line(F, 'NextStep')));
    expect(maps(before, 'Lead')).toHaveLength(3);
    const r = rm('LeadConvertSettings', before, 'Lead');
    removed(r, before, lcs(om('Account', line('Company', 'Name')) + om('Contact', line('Email', 'Email')) + om('Opportunity', '')), 'Lead');
    expect(maps(r.xml, 'Lead')).toEqual([]);
    expect(r.how).toEqual(['3 mapping lines removed, the other lines kept']);
  });
  it('✂ is object-aware: Account’s field goes; the SAME API name on Lead’s side of another line and on Contact stays', () => {
    const before = lcs(om('Account', line('Rating', F)) + om('Contact', line(F, 'Department') + line('Email', F)));
    const r = rm('LeadConvertSettings', before, 'Account');
    expect(r.refused).toBeNull();
    expect(r.xml).toBe(lcs(om('Account', '') + om('Contact', line(F, 'Department') + line('Email', F))));
    sound(r.xml);
    expect(maps(r.xml, 'Account')).toEqual([]);
    expect(maps(r.xml, 'Lead')).toHaveLength(1);       // Lead's own field of that name is still mapped
    expect(maps(r.xml, 'Contact')).toHaveLength(1);    // and Contact's
    expect(r.how).toEqual(['1 mapping line removed, the other lines kept']);
  });
  it('✂ / ⇄ when no line carries the field is refused', () => {
    const before = lcs(om('Account', line('Company', 'Name')) + om('Contact', line(F, 'Department')));
    refusedWhole(rm('LeadConvertSettings', before, 'Account'), before, /no mapping line carries the field/);
    refusedWhole(rp('LeadConvertSettings', before, 'Opportunity'), before, /no mapping line carries the field/);
  });
  it('⇄ several mentions: the Lead field in three mappings becomes the new field in each', () => {
    const before = lcs(om('Account', line('Company', 'Name') + line(F, 'Sic')) + om('Contact', line(F, 'Department')) + om('Opportunity', line(F, 'NextStep')));
    const r = rp('LeadConvertSettings', before, 'Lead');
    swapped(r, before, 3, 'Lead');
    expect(maps(r.xml, 'Lead')).toEqual([]);
    expect(M.sftkMdLeadMappingsFor(r.xml, 'Lead', N)).toHaveLength(3);
    expect(r.how).toEqual([`3 mapping lines now ${N}`]);
  });
  it('⇄ is object-aware: only the side that belongs to the object is renamed', () => {
    const before = lcs(om('Account', line(F, F)));                     // Lead.F → Account.F, the usual same-named pair
    const r = rp('LeadConvertSettings', before, 'Account');
    expect(r.xml).toBe(lcs(om('Account', line(F, N))));
    expect(rp('LeadConvertSettings', before, 'Lead').xml).toBe(lcs(om('Account', line(N, F))));
  });
});

// ── AssignmentRule / AutoResponseRule / EscalationRule ───────────────────────
// A rule is read through its container (AssignmentRules "Lead" → <assignmentRule>), so the inner XML carries the
// rule's SHORT name; the delete and the restore name it Object.Rule.
const RULES = [
  { type: 'AssignmentRule', obj: 'Lead', name: 'SFTK_Live_AR', parent: 'AssignmentRules', tag: 'assignmentRule', folder: 'assignmentRules', what: 'assignment rule',
    pre: '<assignedTo>sftk_queue</assignedTo><assignedToType>Queue</assignedToType>', post: '<template>unfiled$public/SFTK_Live_Tpl</template>' },
  { type: 'AutoResponseRule', obj: 'Case', name: 'SFTK_Live_RR', parent: 'AutoResponseRules', tag: 'autoResponseRule', folder: 'autoResponseRules', what: 'auto-response rule',
    pre: '', post: '<senderEmail>support@sftk.invalid</senderEmail><senderName>Support</senderName><template>unfiled$public/SFTK_Live_Tpl</template>' },
  { type: 'EscalationRule', obj: 'Case', name: 'SFTK_Live_ER', parent: 'EscalationRules', tag: 'escalationRule', folder: 'escalationRules', what: 'escalation rule',
    pre: '', mid: '<businessHoursSource>Case</businessHoursSource>', post: '<escalationAction><minutesToEscalation>60</minutesToEscalation><notifyCaseOwner>false</notifyCaseOwner></escalationAction><escalationStartTime>CaseCreation</escalationStartTime>' },
];
describe.each(RULES)('$type', ({ type, obj, name, parent, tag, folder, what, pre, mid, post }) => {
  const crit = (f, v = 'x') => `<criteriaItems><field>${f}</field><operation>equals</operation><value>${v}</value></criteriaItems>`;
  // one entry: Salesforce's own child order — the filter logic, (escalation: business hours), the criteria, the rest, a formula last
  const entry = (crits, o = {}) => `<ruleEntry>${pre}${o.logic ? `<booleanFilter>${o.logic}</booleanFilter>` : ''}${mid || ''}${crits}${type === 'EscalationRule' ? post + (o.formula ? `<formula>${o.formula}</formula>` : '') : (o.formula ? `<formula>${o.formula}</formula>` : '') + post}</ruleEntry>`;
  const rule = entries => `<fullName>${name}</fullName><active>true</active>${entries}`;
  const OF = `${obj}.${F}`;
  const other = crit(`${obj}.Status`, 'New'), other2 = crit(`${obj}.Description`, 'vip');
  const rmR = x => rm(type, x, obj), rpR = x => rp(type, x, obj);
  const valid = xml => {
    logicConsistent(xml, 'ruleEntry', 'criteriaItems');
    // no entry is left with nothing to test
    for (const e of M.sftkMdChildren(xml, 'ruleEntry')) expect(/<criteriaItems>|<formula>/.test(e.innerXml)).toBe(true);
  };

  it('🗑 full delete: destructive member Object.Rule of the rule’s own type; the restore file is the container with the one rule', () => {
    const inner = rule(entry(crit(OF) + other));
    fullDelete(type, type, `${obj}.${name}`, inner, { sev: 'blocker', parent, tag, folder, suffix: folder, what,
      file: `${folder}/${obj}.${folder}`, restore: `${HEAD}<${parent} ${NS}><${tag}><fullName>${name}</fullName><active>true</active>${entry(crit(OF) + other)}</${tag}></${parent}>` });
    expect(FC).toContain("const _RULE_CONTAINERS = { AssignmentRule: ['AssignmentRules', 'assignmentRule'], AutoResponseRule: ['AutoResponseRules', 'autoResponseRule'], EscalationRule: ['EscalationRules', 'escalationRule'] };");
  });
  it('✂ one mention, a criterion next to another in its entry: the criterion goes, the entry and the others stay', () => {
    const before = rule(entry(other + crit(OF)) + entry(other2));
    expect(M.sftkMdMentionsField(before, obj, F)).toBe(true);
    const r = rmR(before);
    removed(r, before, rule(entry(other) + entry(other2)), obj);
    valid(r.xml);
    expect(r.how).toEqual(['rule entries: the field’s criteria removed, 2 entries kept']);
  });
  it('✂ one mention, its entry’s ONLY criterion: the entry is dropped (it would match every record), the other entries stay', () => {
    const before = rule(entry(other) + entry(crit(OF)) + entry(other2));
    const r = rmR(before);
    removed(r, before, rule(entry(other) + entry(other2)), obj);
    valid(r.xml);
    expect(r.how).toEqual(['rule entries: the field’s criteria removed; 1 entry whose only criterion it was dropped, 2 entries kept']);
  });
  it('✂ one mention, the only criterion of the rule’s only entry: refused — the rule would do nothing', () => {
    const before = rule(entry(crit(OF)));
    refusedWhole(rmR(before), before, /every entry of the rule hangs on this field/);
  });
  it('✂ one mention under the entry’s numbered filter logic: refused, nothing renumbered behind the user’s back', () => {
    const before = rule(entry(other + crit(OF) + other2, { logic: '1 AND (2 OR 3)' }) + entry(other2));
    refusedWhole(rmR(before), before, /filter logic numbers its criteria/);
  });
  it('✂ one mention in an entry’s formula: refused — a formula cannot lose a reference', () => {
    const before = rule(entry('', { formula: `ISBLANK(${F}) &amp;&amp; ISPICKVAL(Status, &quot;New&quot;)` }) + entry(other));
    expect(M.sftkMdMentionsField(before, obj, F)).toBe(true);
    refusedWhole(rmR(before), before, /formula names the field/);
  });
  it('✂ several mentions: two criteria in one entry, a whole entry of its own, both spellings — all go in one pass; an entry with its own numbered logic is untouched', () => {
    const logicEntry = entry(other + other2, { logic: '1 OR 2' });
    const before = rule(entry(crit(OF, 'a') + other + crit(F, 'b')) + entry(crit(OF.toLowerCase(), 'c')) + logicEntry);
    const r = rmR(before);
    removed(r, before, rule(entry(other) + logicEntry), obj);
    valid(r.xml);
    expect(r.how).toEqual(['rule entries: the field’s criteria removed; 1 entry whose only criterion it was dropped, 2 entries kept']);
  });
  it('✂ several mentions, one of them in a formula entry: refused as a whole — the removable criterion stays too', () => {
    const before = rule(entry(crit(OF) + other) + entry('', { formula: `LEN(${OF}) &gt; 3` }));
    const r = rmR(before);
    refusedWhole(r, before, /formula names the field/);
    expect(r.xml).toContain(crit(OF));
  });
  it('✂ several mentions, one of them under numbered logic: refused as a whole — in either order', () => {
    const plain = entry(crit(OF) + other), numbered = entry(other + crit(OF), { logic: '1 OR 2' });
    refusedWhole(rmR(rule(plain + numbered)), rule(plain + numbered), /filter logic numbers its criteria/);
    refusedWhole(rmR(rule(numbered + plain)), rule(numbered + plain), /filter logic numbers its criteria/);
  });
  it('✂ several mentions that are every entry’s only criterion: refused as a whole', () => {
    const before = rule(entry(crit(OF, 'a')) + entry(crit(F, 'b')));
    refusedWhole(rmR(before), before, /every entry of the rule hangs on this field/);
  });
  it('✂ on a rule no entry of which names the field (another object’s same-named field is not it) is refused', () => {
    const before = rule(entry(crit(`Owner.${F}`) + other));
    refusedWhole(rmR(before), before, /no rule entry names the field/);
  });
  it('⇄ several mentions: criteria, a numbered-logic entry and a formula — every one names the new field', () => {
    const before = rule(entry(crit(OF) + other) + entry(other + crit(F), { logic: '1 OR 2' }) + entry('', { formula: `ISBLANK(${F}) || LEN(${OF}) &gt; 3` }));
    const r = rpR(before);
    swapped(r, before, 4, obj);
    valid(r.xml);
    expect(r.xml).toContain(`<formula>ISBLANK(${N}) || LEN(${obj}.${N}) &gt; 3</formula>`);
    expect(r.how).toEqual([`rule entries: 4 references now ${N}`]);
  });
});

// ── ApprovalProcess ──────────────────────────────────────────────────────────
describe('ApprovalProcess', () => {
  const OF = `Account.${F}`;
  const crit = (f, v = 'x') => `<criteriaItems><field>${f}</field><operation>equals</operation><value>${v}</value></criteriaItems>`;
  const other = crit('Account.Type', 'Customer'), other2 = crit('Account.Industry', 'Banking');
  const criteria = (crits, o = {}) => `<entryCriteria>${o.logic ? `<booleanFilter>${o.logic}</booleanFilter>` : ''}${crits}${o.formula ? `<formula>${o.formula}</formula>` : ''}</entryCriteria>`;
  const step = (n, stepCriteria) => `<approvalStep><allowDelegate>false</allowDelegate><assignedApprover><approver><name>approver@sftk.invalid</name><type>user</type></approver><whenMultipleApprovers>FirstResponse</whenMultipleApprovers></assignedApprover>${stepCriteria ? `${stepCriteria}<ifCriteriaNotMet>ApproveRecord</ifCriteriaNotMet>` : ''}<label>Step ${n}</label><name>Step_${n}</name></approvalStep>`;
  const ap = (pageFields, steps, entry) => `<fullName>Account.SFTK_Live_AP</fullName><active>false</active><allowRecall>false</allowRecall><allowedSubmitters><type>owner</type></allowedSubmitters><approvalPageFields>${pageFields.map(f => `<field>${f}</field>`).join('')}</approvalPageFields>${steps}<enableMobileDeviceAccess>false</enableMobileDeviceAccess>${entry}<finalApprovalRecordLock>true</finalApprovalRecordLock><finalRejectionRecordLock>false</finalRejectionRecordLock><label>SFTK Live AP</label><processOrder>1</processOrder><recordEditability>AdminOnly</recordEditability><showApprovalHistory>false</showApprovalHistory>`;
  const valid = xml => logicConsistent(xml, 'entryCriteria', 'criteriaItems');
  it('🗑 full delete: a file of its own, destructive member Object.Process', () => {
    const inner = ap(['Name', F], step(1), criteria(crit(OF)));
    fullDelete('ApprovalProcess', 'ApprovalProcess', 'Account.SFTK_Live_AP', inner, { sev: 'blocker', folder: 'approvalProcesses', suffix: 'approvalProcess', what: 'approval process',
      file: 'approvalProcesses/Account.SFTK_Live_AP.approvalProcess', restore: `${HEAD}<ApprovalProcess ${NS}>${inner.replace('<fullName>Account.SFTK_Live_AP</fullName>', '')}</ApprovalProcess>` });
  });
  it('✂ one mention, a field of the approval page: it goes, the other page fields and the criteria stay', () => {
    const before = ap(['Name', F, 'Owner'], step(1), criteria(other));
    expect(M.sftkMdMentionsField(before, 'Account', F)).toBe(true);
    const r = rm('ApprovalProcess', before);
    removed(r, before, ap(['Name', 'Owner'], step(1), criteria(other)));
    expect(r.how).toEqual(['criteria and page fields: 1 reference removed']);
  });
  it('✂ one mention, an entry criterion next to another: the criterion goes, the process still has its entry criteria', () => {
    const before = ap(['Name', 'Owner'], step(1), criteria(other + crit(OF)));
    const r = rm('ApprovalProcess', before);
    removed(r, before, ap(['Name', 'Owner'], step(1), criteria(other)));
    valid(r.xml);
  });
  it('✂ one mention, a STEP’s criterion next to another: it goes, the step keeps its other criterion', () => {
    const before = ap(['Name'], step(1, criteria(crit(OF) + other2)) + step(2), criteria(other));
    const r = rm('ApprovalProcess', before);
    removed(r, before, ap(['Name'], step(1, criteria(other2)) + step(2), criteria(other)));
    valid(r.xml);
  });
  it('✂ one mention, the ONLY entry criterion: refused — every record could enter the process', () => {
    const before = ap(['Name', 'Owner'], step(1), criteria(crit(OF)));
    refusedWhole(rm('ApprovalProcess', before), before, /only entry criterion .*EVERY record could enter/);
  });
  it('✂ one mention under numbered filter logic: refused', () => {
    const before = ap(['Name'], step(1), criteria(other + crit(OF) + other2, { logic: '1 AND (2 OR 3)' }));
    refusedWhole(rm('ApprovalProcess', before), before, /filter logic numbers them/);
  });
  it('✂ one mention in the entry-criteria formula: refused', () => {
    const before = ap(['Name'], step(1), criteria('', { formula: `NOT(ISBLANK(${F})) &amp;&amp; AnnualRevenue &gt; 100` }));
    expect(M.sftkMdMentionsField(before, 'Account', F)).toBe(true);
    refusedWhole(rm('ApprovalProcess', before), before, /formula that names the field/);
  });
  it('✂ several mentions: a page field, an entry criterion and two step criteria — all four go in one pass; a numbered step that does not use the field is untouched', () => {
    const numberedStep = step(3, criteria(other + other2, { logic: '1 OR 2' }));
    const before = ap(['Name', F, 'Owner'], step(1, criteria(crit(OF, 'a') + other2)) + step(2, criteria(other + crit(F, 'b'))) + numberedStep, criteria(other + crit(OF, 'c')));
    const r = rm('ApprovalProcess', before);
    removed(r, before, ap(['Name', 'Owner'], step(1, criteria(other2)) + step(2, criteria(other)) + numberedStep, criteria(other)));
    valid(r.xml);
    expect(r.how).toEqual(['criteria and page fields: 4 references removed']);
  });
  it('✂ several mentions, one the only entry criterion: refused as a whole — the page field is NOT taken out on its own', () => {
    const before = ap(['Name', F], step(1, criteria(crit(OF) + other2)), criteria(crit(OF)));
    const r = rm('ApprovalProcess', before);
    refusedWhole(r, before, /only entry criterion/);
    expect(r.xml).toContain(`<field>${F}</field></approvalPageFields>`);
  });
  it('✂ several mentions, one under a step’s numbered logic: refused as a whole', () => {
    const before = ap(['Name', F], step(1, criteria(crit(OF) + other2, { logic: '1 OR 2' })), criteria(other + crit(OF)));
    refusedWhole(rm('ApprovalProcess', before), before, /filter logic numbers them/);
  });
  it('✂ several mentions, one in a formula: refused as a whole', () => {
    const before = ap(['Name', F], step(1, criteria(crit(OF) + other2)), criteria('', { formula: `LEN(${OF}) &gt; 3` }));
    refusedWhole(rm('ApprovalProcess', before), before, /formula that names the field/);
  });
  it('✂ on a process that names the field nowhere is refused', () => {
    const before = ap(['Name'], step(1), criteria(other));
    refusedWhole(rm('ApprovalProcess', before), before, /no criterion or page field names the field/);
  });
  it('⇄ several mentions: page field, numbered entry criteria, a step criterion and a step formula — every one names the new field', () => {
    const before = ap(['Name', F], step(1, criteria(crit(OF) + other2)) + step(2, criteria('', { formula: `ISBLANK(${F}) || LEN(${OF}) &gt; 3` })), criteria(other + crit(OF), { logic: '1 OR 2' }));
    const r = rp('ApprovalProcess', before);
    swapped(r, before, 5);
    valid(r.xml);
    expect(r.xml).toContain(`<approvalPageFields><field>Name</field><field>${N}</field></approvalPageFields>`);
    expect(r.xml).toContain(`<formula>ISBLANK(${N}) || LEN(Account.${N}) &gt; 3</formula>`);
    expect(r.how).toEqual([`criteria and page fields: 5 references now ${N}`]);
  });
  // FIXED 2026-11-14 (was a product bug): a User-lookup field can be the APPROVER of a step
  // (<assignedApprover><approver><name>SFTK_Live_Blk__c</name><type>relatedUserField</type></approver>). Neither the
  // ApprovalProcess case of sftkMdEditField (sftk-mdapi.js: it walks <entryCriteria> and <approvalPageFields> only)
  // nor sftkMdMentionsField (no <name> under <approver>) reads it. With the field also on the approval page, ✂ says
  // "1 reference removed" and ⇄ "1 reference now …" while the step still routes to the old field; with the approver
  // as the only mention the scan does not list the process at all.
  const approverStep = `<approvalStep><allowDelegate>false</allowDelegate><assignedApprover><approver><name>${F}</name><type>relatedUserField</type></approver><whenMultipleApprovers>FirstResponse</whenMultipleApprovers></assignedApprover><label>Step 1</label><name>Step_1</name></approvalStep>`;
  it('✂ several mentions — a page field AND the step’s approver (relatedUserField): refused as a whole', () => {
    const before = ap(['Name', F], approverStep, criteria(other));
    const r = rm('ApprovalProcess', before);
    // a step cannot lose its approver: the whole edit is refused — never half
    refusedWhole(r, before, /a step.s approver is this field/);
  });
  it('⇄ several mentions — the step’s approver (relatedUserField) names the new field too', () => {
    const before = ap(['Name', F], approverStep, criteria(other));
    swapped(rp('ApprovalProcess', before), before, 2);
  });
  it('the approver is the only mention — the product’s mention test sees the process', () => {
    expect(M.sftkMdMentionsField(ap(['Name'], approverStep, criteria(other)), 'Account', F)).toBe(true);
  });
});
