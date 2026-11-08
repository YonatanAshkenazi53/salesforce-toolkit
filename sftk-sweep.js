'use strict';
/* global DecompressionStream */   // the browser's inflater (Chrome 103+), used by sftkUnzip
// ═════════════════════════════════════════════════════════════════════════
// sftk-sweep.js — the whole-org text sweep of Field Cleaner.
// ═════════════════════════════════════════════════════════════════════════
// User 2026-11-08: "תחשוב על זה שמורידים דרך vcs פרויקט שלם של סילספורס ואז
// מחפשים שם api של שדה. זה בדיוק מה שאני רוצה לעשות אבל לחלק את זה לדברים
// שחייב למחוק או לשנות כדי למחוק את השדה, ודברים שטוב לדעת כי הם יכולים
// להשבר אחר כך" — "זה חייב להיות ב-1.1".
//
// The everyday scan asks Salesforce's dependency index and reads a known set
// of kinds. This is the other way round: retrieve the org's own (unmanaged)
// metadata as one zip, read every text file, find the field's API name in
// every form it takes, and say for each hit which component holds it, where
// (file + line), and whether Salesforce will REFUSE the field's delete for
// it (🔒) or merely let it break later (👀). Everything here is pure except
// sftkUnzip, which inflates with the browser's DecompressionStream.

// ── 1. What the sweep looks for ───────────────────────────────────────────
// The field's name as it appears in metadata: bare (Field__c), qualified
// (Account.Field__c), as a flow's $Record.Field__c, in an LWC schema import
// (@salesforce/schema/Account.Field__c), in a formula or SOQL. One
// case-insensitive word-boundary regex covers them all: the bare name with
// no identifier character on either side.
function sftkSweepForms(objApi, fieldApi) {
  const f = String(fieldApi || '').trim();
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    object: String(objApi || '').trim(),
    field: f,
    re: new RegExp(`(?<![A-Za-z0-9_])${esc(f)}(?![A-Za-z0-9_])`, 'i'),
    reG: new RegExp(`(?<![A-Za-z0-9_])${esc(f)}(?![A-Za-z0-9_])`, 'gi'),
    qualified: new RegExp(`(?<![A-Za-z0-9_])${esc(String(objApi || ''))}\\.${esc(f)}(?![A-Za-z0-9_])`, 'i'),
  };
}

// Every line of `text` that names the field: [{ line (1-based), text, offset }].
function sftkSweepHits(text, forms) {
  const out = [];
  const s = String(text || '');
  if (!forms || !forms.re.test(s)) return out;
  let lineNo = 1, start = 0;
  for (let i = 0; i <= s.length; i++) {
    if (i === s.length || s[i] === '\n') {
      const line = s.slice(start, i);
      if (forms.re.test(line)) out.push({ line: lineNo, text: line.replace(/\r$/, '').trim().slice(0, 300), offset: start });
      lineNo++; start = i + 1;
    }
  }
  return out;
}

// ── 2. Which types the retrieve asks for ──────────────────────────────────
// From describeMetadata's list. Out: binary or bulky kinds a text sweep
// cannot use (static resources, documents, content, site assets), settings
// and certificates, installed packages, and the kinds that are only
// containers of others. Folder kinds (Report, Dashboard, EmailTemplate,
// Document) must be listed folder by folder; CustomObject's wildcard covers
// custom objects only — standard objects are named from the org's describe.
function _sftkSweepSkip() {
  return new Set([
  'StaticResource', 'Document', 'ContentAsset', 'SiteDotCom', 'Certificate', 'InstalledPackage',
  'Settings', 'EmbeddedServiceConfig', 'ManagedContentType', 'Audience', 'LightningBolt',
  'Package', 'Scontrol', 'Portal', 'Letterhead', 'WaveDataflow', 'WaveDataset', 'WaveLens',
  'WaveRecipe', 'WaveTemplateBundle', 'WaveXmd', 'DiscoveryAIModel', 'DiscoveryGoal', 'DiscoveryStory',
  'ExternalDataSource', 'ExternalServiceRegistration', 'NamedCredential', 'ExternalCredential',
  'SamlSsoConfig', 'AuthProvider', 'ConnectedApp', 'RemoteSiteSetting', 'CspTrustedSite',
  'CorsWhitelistOrigin', 'Group', 'Queue', 'Role', 'Territory2', 'Territory2Model', 'Territory2Rule',
  'Territory2Type', 'Community', 'NetworkBranding', 'BrandingSet', 'UserCriteria', 'TopicsForObjects',
  'ChatterExtension', 'Skill', 'LiveChatAgentConfig', 'LiveChatButton', 'LiveChatDeployment',
  'LiveChatSensitiveDataRule', 'PresenceUserConfig', 'PresenceDeclineReason', 'ServiceChannel',
  'ServicePresenceStatus', 'QueueRoutingConfig', 'CustomSite', 'CustomTab', 'CustomApplication',
  'AppMenu', 'HomePageLayout', 'HomePageComponent', 'CustomPageWebLink', 'ProfilePasswordPolicy',
  'ProfileSessionSetting', 'MutingPermissionSet', 'PermissionSetGroup', 'PlatformCachePartition',
  'EventDelivery', 'EventSubscription', 'EclairGeoData', 'OauthCustomScope', 'CleanDataService',
  'EmailServicesFunction', 'MyDomainDiscoverableLogin', 'LightningExperienceTheme', 'LightningMessageChannel',
  'NotificationTypeConfig', 'ProfileSearchLayouts', 'CustomNotificationType', 'ApexEmailNotifications',
  'IframeWhiteListUrlSettings', 'RedirectWhitelistUrl', 'StandardValueSet', 'StandardValueSetTranslation',
  'GlobalValueSetTranslation', 'TimeSheetTemplate', 'CallCenter', 'DataCategoryGroup', 'Layout_Translation',
  ]);
}
function _sftkSweepFolderKinds() { return { Report: 'ReportFolder', Dashboard: 'DashboardFolder', EmailTemplate: 'EmailFolder', Document: 'DocumentFolder' }; }

// describeMetadata's XML → [{ name, inFolder, directoryName, suffix }]
function sftkSweepParseDescribe(xml) {
  const out = [];
  for (const m of String(xml || '').matchAll(/<(?:[A-Za-z0-9_.-]+:)?metadataObjects>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?metadataObjects>/g)) {
    const b = m[1];
    const tag = n => { const x = b.match(new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${n}>([^<]*)<`)); return x ? x[1] : ''; };
    const name = tag('xmlName');
    if (!name) continue;
    out.push({ name, inFolder: tag('inFolder') === 'true', directoryName: tag('directoryName'), suffix: tag('suffix') });
  }
  return out;
}

// listMetadata's XML → [{ fullName, type, manageableState, namespacePrefix }]
function sftkSweepParseList(xml) {
  const out = [];
  for (const m of String(xml || '').matchAll(/<(?:[A-Za-z0-9_.-]+:)?result>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?result>/g)) {
    const b = m[1];
    const tag = n => { const x = b.match(new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${n}>([^<]*)<`)); return x ? x[1] : ''; };
    const fullName = tag('fullName');
    if (!fullName) continue;
    out.push({ fullName, type: tag('type'), manageableState: tag('manageableState'), namespacePrefix: tag('namespacePrefix') });
  }
  return out;
}

// The types worth sweeping, from the describe. Each: { name, how }
//   how: 'wildcard' (members: *), 'folders' (list the folders, then each
//   folder's members), 'named' (members must be listed — CustomObject's
//   standard objects ride in here from the caller).
function sftkSweepTypes(describeObjects) {
  const out = [];
  for (const d of (describeObjects || [])) {
    if (!d || !d.name || _sftkSweepSkip().has(d.name)) continue;
    if (_sftkSweepFolderKinds()[d.name]) { if (d.name !== 'Document') out.push({ name: d.name, how: 'folders', folderType: _sftkSweepFolderKinds()[d.name] }); continue; }
    if (d.inFolder) continue;
    out.push({ name: d.name, how: 'wildcard' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// A component that is the org's own: not installed from a managed package
// (the platform will not let the field's owner change those anyway).
function sftkSweepOwn(item) {
  if (!item) return false;
  const st = String(item.manageableState || '');
  if (st === 'installed' || st === 'released' || st === 'beta' || st === 'deprecated') return false;
  return true;
}

// Group the listed components into retrieves of at most `max` members each,
// never splitting a type's members below one retrieve unless it is bigger
// than `max` on its own. → [[{ name, members }], …]
function sftkSweepChunks(listedByType, max) {
  const cap = Math.max(50, Number(max) || 1500);
  const groups = [];
  let cur = [], n = 0;
  const flush = () => { if (cur.length) groups.push(cur); cur = []; n = 0; };
  for (const [name, members] of Object.entries(listedByType || {})) {
    const ms = (members || []).slice();
    if (!ms.length) continue;
    for (let i = 0; i < ms.length; i += cap) {
      const part = ms.slice(i, i + cap);
      if (n + part.length > cap) flush();
      cur.push({ name, members: part }); n += part.length;
    }
  }
  flush();
  return groups;
}

// ── 3. The zip ────────────────────────────────────────────────────────────
// A Metadata API retrieve zip: deflate entries with a central directory.
// Text files are decoded as UTF-8; binaries (by extension) are skipped.
function _sftkSweepBinary() { return /\.(png|jpe?g|gif|ico|svg|zip|jar|pdf|woff2?|ttf|eot|mp3|mp4|mov|docx?|xlsx?|pptx?|bin|class|resource)$/i; }
function sftkSweepIsText(path) { return !_sftkSweepBinary().test(String(path || '')); }

async function sftkUnzip(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // the end-of-central-directory record, searched from the back
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('not a zip file (no central directory)');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = new Map();
  const dec = new TextDecoder('utf-8');
  for (let k = 0; k < count && p + 46 <= u8.length; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || !sftkSweepIsText(name)) continue;
    const lNameLen = dv.getUint16(localOff + 26, true), lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = u8.subarray(dataStart, dataStart + csize);
    let text;
    if (method === 0) text = dec.decode(raw);
    else if (method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const buf = await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer();
      text = dec.decode(buf);
    } else continue;   // an unknown method: skipped, said by the caller through the counts
    files.set(name, text);
  }
  return files;
}

function sftkBase64ToBytes(b64) {
  const bin = atob(String(b64 || '').replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── 4. What a hit means ───────────────────────────────────────────────────
// Salesforce refuses the field's delete for these kinds (🔒). Everything else
// is 👀: the delete goes through and the component breaks or quietly drops
// the field. The judgement per kind is the same one Field Cleaner's scan
// uses (TYPE_CFG) — this table is the sweep's own copy, keyed by what the
// zip's path and the hit's section say.
function sftkSweepKindTable() {
  return {
  ApexClass:              { label: 'Apex Classes', sev: 'blocker' },
  ApexTrigger:            { label: 'Apex Triggers', sev: 'blocker' },
  ApexPage:               { label: 'Visualforce Pages', sev: 'blocker' },
  ApexComponent:          { label: 'Visualforce Components', sev: 'blocker' },
  LightningComponentBundle: { label: 'Lightning Web Components', sev: 'blocker' },
  LwcMarkup:              { label: 'LWC markup (HTML / CSS)', sev: 'mention', why: 'a web component’s HTML names the field only as text — the delete goes through and the component shows nothing there' },
  AuraDefinitionBundle:   { label: 'Aura Components', sev: 'mention', why: 'Aura markup and controllers hold the field as text — the delete goes through and the component breaks where it reads it' },
  Flow:                   { label: 'Flows', sev: 'blocker' },
  FlexiPage:              { label: 'Lightning Pages', sev: 'blocker' },
  CustomField:            { label: 'Formula & Roll-up Fields', sev: 'blocker' },
  LookupFilter:           { label: 'Lookup Filters', sev: 'blocker' },
  ValidationRule:         { label: 'Validation Rules', sev: 'blocker' },
  WebLink:                { label: 'Custom Buttons & Links', sev: 'blocker' },
  FieldSet:               { label: 'Field Sets', sev: 'blocker' },
  ListView:               { label: 'List Views', sev: 'mention', why: 'the column or filter is dropped from the view' },
  CompactLayout:          { label: 'Compact Layouts', sev: 'mention', why: 'the field is dropped from the compact layout' },
  RecordTypePicklist:     { label: 'Record-type picklist values', sev: 'mention', why: 'the record type’s value list for this field goes with the field' },
  SearchLayout:           { label: 'Search Layouts', sev: 'mention', why: 'the column is dropped from search results and lookup dialogs' },
  BusinessProcess:        { label: 'Business Processes', sev: 'mention', why: 'the stage list that uses this field is edited by the delete' },
  DependentPicklist:      { label: 'Dependent Picklists', sev: 'mention', why: 'this field controls or depends on another picklist — the dependency goes' },
  Layout:                 { label: 'Page Layouts', sev: 'mention', why: 'the field is dropped from the layout' },
  LayoutRelatedList:      { label: 'Related-list columns', sev: 'mention', why: 'the column is dropped from the related list on another object’s layout' },
  WorkflowRule:           { label: 'Workflow Rules', sev: 'blocker' },
  WorkflowFieldUpdate:    { label: 'Workflow Field Updates', sev: 'blocker' },
  WorkflowAlert:          { label: 'Email Alerts', sev: 'blocker' },
  WorkflowOutboundMessage: { label: 'Outbound Messages', sev: 'blocker' },
  ApprovalProcess:        { label: 'Approval Processes', sev: 'blocker' },
  SharingCriteriaRule:    { label: 'Sharing Rules (criteria)', sev: 'blocker' },
  MatchingRule:           { label: 'Matching Rules', sev: 'blocker' },
  DuplicateRule:          { label: 'Duplicate Rules', sev: 'blocker' },
  AssignmentRule:         { label: 'Assignment Rules', sev: 'blocker' },
  AutoResponseRule:       { label: 'Auto-Response Rules', sev: 'blocker' },
  EscalationRule:         { label: 'Escalation Rules', sev: 'blocker' },
  RestrictionRule:        { label: 'Scoping & Restriction Rules', sev: 'blocker' },
  CustomMetadataRecord:   { label: 'Custom Metadata Records', sev: 'blocker' },
  CustomMetadataText:     { label: 'Custom Metadata Records (text value)', sev: 'mention', why: 'a text value holds the field’s name — nothing stops the delete, whatever reads the value breaks' },
  LeadConvertSettings:    { label: 'Lead Field Mapping', sev: 'blocker' },
  Report:                 { label: 'Reports', sev: 'mention', why: 'the column, filter or grouping is dropped from the report' },
  ReportType:             { label: 'Report Types', sev: 'mention', why: 'the field is dropped from the report type’s layout' },
  Dashboard:              { label: 'Dashboards', sev: 'mention', why: 'a filter or component that names the field stops matching' },
  EmailTemplate:          { label: 'Email Templates', sev: 'mention', why: 'the merge field stops working in the template' },
  QuickAction:            { label: 'Quick Actions', sev: 'mention', why: 'the field is dropped from the action’s layout or predefined values' },
  PathAssistant:          { label: 'Paths', sev: 'mention', why: 'the key field is dropped from the path’s steps' },
  PermissionSet:          { label: 'Permission Sets (field access)', sev: 'mention', why: 'the field permission line is dropped automatically — nothing to do' },
  Profile:                { label: 'Profiles (field access)', sev: 'mention', why: 'the field permission line is dropped automatically — nothing to do' },
  CustomObjectTranslation: { label: 'Translations', sev: 'mention', why: 'the field’s translated labels go with it' },
  Translations:           { label: 'Translations', sev: 'mention', why: 'the translated text goes with the field' },
  ExperienceBundle:       { label: 'Experience Cloud pages', sev: 'mention', why: 'the page or component names the field as text — it breaks where it reads it' },
  CustomLabel:            { label: 'Custom Labels', sev: 'mention', why: 'a label’s text holds the field’s name — nothing stops the delete' },
  Other:                  { label: 'Other components', sev: 'mention', why: 'the component names the field — the delete goes through; what reads it may break' },
  };
}

// The depth-1 sections of an object-shaped file (objects/X.object,
// workflows/X.workflow, sharingRules, matchingRules, assignmentRules…):
// [{ tag, fullName, start, end }] — so a hit at an offset can be named by
// the sub-component that holds it, not just by the file.
function sftkSweepSections(text) {
  const s = String(text || '');
  const out = [];
  const root = s.match(/<([A-Za-z][A-Za-z0-9_]*)[^>]*>/);
  if (!root) return out;
  let i = root.index + root[0].length;
  const tagRe = /<\/?([A-Za-z][A-Za-z0-9_.-]*)(\s[^>]*?)?(\/?)>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g;
  tagRe.lastIndex = i;
  let depth = 0, open = null, m;
  while ((m = tagRe.exec(s))) {
    if (m[0].startsWith('<!--') || m[0].startsWith('<![CDATA[')) continue;
    const name = m[1], closing = m[0][1] === '/', selfClose = !!m[3];
    if (closing) {
      depth--;
      if (depth === 0 && open) { out.push({ tag: open.tag, start: open.start, end: m.index + m[0].length, fullName: null }); open = null; }
      if (depth < 0) break;   // the root closed
      continue;
    }
    if (selfClose) { if (depth === 0) out.push({ tag: name, start: m.index, end: m.index + m[0].length, fullName: null }); continue; }
    if (depth === 0) open = { tag: name, start: m.index };
    depth++;
  }
  for (const sec of out) {
    const body = s.slice(sec.start, sec.end);
    const fn = body.match(/<fullName>([^<]*)<\/fullName>/);
    sec.fullName = fn ? fn[1] : null;
  }
  return out;
}

function _sftkSweepSectionAt(sections, offset) {
  for (const sec of (sections || [])) if (offset >= sec.start && offset < sec.end) return sec;
  return null;
}

// A hit → { type, label, sev, why, component, section } from the zip path, the
// file's text and the hit's offset. `objApi`/`fieldApi` decide a few close
// calls (the field's own definition is not a hit on itself; a custom
// metadata value "Account.Field__c" blocks, a bare text value does not).
function sftkSweepKind(path, text, hit, forms) {
  const p = String(path || '').replace(/^unpackaged\//, '');
  const seg = p.split('/');
  const dir = seg[0] || '';
  const file = seg[seg.length - 1] || '';
  const base = file.replace(/\.[^.]+$/, '').replace(/-meta$/, '');
  const T = sftkSweepKindTable();
  const K = (type, component, section, pathOverride) => { const k = T[type] || T.Other; return { type, label: k.label, sev: k.sev, why: k.why || '', component: component || base, section: section || null, path: pathOverride || p, file: pathOverride ? file : null }; };
  const sections = () => sftkSweepSections(text);
  const secAt = () => _sftkSweepSectionAt(sections(), hit ? hit.offset : 0);
  switch (dir) {
    case 'classes': return K('ApexClass', base);
    case 'triggers': return K('ApexTrigger', base);
    case 'pages': return K('ApexPage', base);
    case 'components': return K('ApexComponent', base);
    case 'lwc': return /\.js$/.test(file) ? K('LightningComponentBundle', seg[1], null, `lwc/${seg[1]}/`) : K('LwcMarkup', seg[1], null, `lwc/${seg[1]}/`);
    case 'aura': return K('AuraDefinitionBundle', seg[1], null, `aura/${seg[1]}/`);
    case 'flows': return K('Flow', base);
    case 'flexipages': return K('FlexiPage', base);
    case 'layouts': {
      const sec = secAt();
      return sec && sec.tag === 'relatedLists' ? K('LayoutRelatedList', base.replace(/^[^-]+-/, ''), sec.fullName || 'related list') : K('Layout', base.replace(/^[^-]+-/, ''));
    }
    case 'objects': {
      const obj = base;
      const sec = secAt();
      if (!sec) return K('Other', obj);
      const name = sec.fullName || sec.tag;
      switch (sec.tag) {
        case 'fields': {
          const sameName = forms && forms.field && String(name).toLowerCase() === String(forms.field).toLowerCase();
          const own = sameName && String(obj).toLowerCase() === String(forms.object || '').toLowerCase();
          if (own) return null;   // the field's own definition is not a use of it
          if (sameName && hit && /<fullName>/i.test(hit.text)) return null;   // a field of the same name on another object: its name line is no use of ours
          const body = text.slice(sec.start, sec.end);
          if (/<lookupFilter>/.test(body) && forms && forms.re.test(body.slice(body.indexOf('<lookupFilter>')))) return K('LookupFilter', `${obj}.${name}`, 'lookup filter');
          if (/<controllingField>/.test(body) || /<valueSettings>/.test(body)) return K('DependentPicklist', `${obj}.${name}`, 'controlling field');
          return K('CustomField', `${obj}.${name}`, 'formula');
        }
        case 'validationRules': return K('ValidationRule', `${obj}.${name}`);
        case 'webLinks': return K('WebLink', `${obj}.${name}`);
        case 'fieldSets': return K('FieldSet', `${obj}.${name}`);
        case 'listViews': return K('ListView', `${obj}.${name}`);
        case 'compactLayouts': return K('CompactLayout', `${obj}.${name}`);
        case 'recordTypes': return K('RecordTypePicklist', `${obj}.${name}`, 'picklist values');
        case 'searchLayouts': return K('SearchLayout', obj, 'search layout');
        case 'businessProcesses': return K('BusinessProcess', `${obj}.${name}`);
        default: return K('Other', `${obj} › ${sec.tag}${sec.fullName ? ` › ${sec.fullName}` : ''}`);
      }
    }
    case 'workflows': {
      const sec = secAt(); const obj = base; const name = (sec && sec.fullName) || obj;
      const t = sec && sec.tag;
      if (t === 'rules') return K('WorkflowRule', `${obj}.${name}`);
      if (t === 'fieldUpdates') return K('WorkflowFieldUpdate', `${obj}.${name}`);
      if (t === 'alerts') return K('WorkflowAlert', `${obj}.${name}`);
      if (t === 'outboundMessages') return K('WorkflowOutboundMessage', `${obj}.${name}`);
      return K('Other', `${obj} › workflow${t ? ` › ${t}` : ''}`);
    }
    case 'approvalProcesses': return K('ApprovalProcess', base);
    case 'sharingRules': { const sec = secAt(); return K('SharingCriteriaRule', `${base}.${(sec && sec.fullName) || 'rule'}`); }
    case 'matchingRules': { const sec = secAt(); return K('MatchingRule', `${base}.${(sec && sec.fullName) || 'rule'}`); }
    case 'duplicateRules': return K('DuplicateRule', base);
    case 'assignmentRules': { const sec = secAt(); return K('AssignmentRule', `${base}.${(sec && sec.fullName) || 'rule'}`); }
    case 'autoResponseRules': { const sec = secAt(); return K('AutoResponseRule', `${base}.${(sec && sec.fullName) || 'rule'}`); }
    case 'escalationRules': { const sec = secAt(); return K('EscalationRule', `${base}.${(sec && sec.fullName) || 'rule'}`); }
    case 'restrictionRules': return K('RestrictionRule', base);
    case 'customMetadata': {
      // "Object.Field" blocks; so does a bare name beside a value that names the object (an Entity + Field pair,
      // the shape a Field Definition relationship is written in); a lone text value does not.
      const qualified = forms && forms.qualified && forms.qualified.test(hit ? hit.text : '');
      const objEsc = forms && forms.object ? forms.object.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
      const entityPair = !!objEsc && new RegExp('<value[^>]*>\\s*' + objEsc + '\\s*</value>', 'i').test(String(text || ''));
      return (qualified || entityPair) ? K('CustomMetadataRecord', base) : K('CustomMetadataText', base);
    }
    case 'LeadConvertSettings': return K('LeadConvertSettings', 'Lead field mapping');
    case 'settings': return /^LeadConvert/i.test(base) ? K('LeadConvertSettings', 'Lead field mapping') : K('Other', `${base} settings`);
    case 'reports': return K('Report', seg.slice(1).join('/').replace(/\.report$/, ''));
    case 'reportTypes': return K('ReportType', base);
    case 'dashboards': return K('Dashboard', seg.slice(1).join('/').replace(/\.dashboard$/, ''));
    case 'email': return K('EmailTemplate', seg.slice(1).join('/').replace(/\.email$/, ''));
    case 'quickActions': return K('QuickAction', base);
    case 'pathAssistants': return K('PathAssistant', base);
    case 'permissionsets': return K('PermissionSet', base);
    case 'profiles': return K('Profile', base);
    case 'objectTranslations': return K('CustomObjectTranslation', base);
    case 'translations': return K('Translations', base);
    case 'experiences': return K('ExperienceBundle', seg[1] || base, seg.slice(2).join('/'));
    case 'labels': return K('CustomLabel', base);
    default: return K('Other', `${dir} › ${base}`);
  }
}

// Every hit of every file, classified and grouped. `files`: Map(path → text).
// → { hits: [{ path, line, text, type, label, sev, why, component, section }],
//     byType: { type: { label, sev, why, items: [{ component, section, path, lines: [{line, text}] }] } },
//     filesRead, filesWithHits }
function sftkSweepRun(files, forms) {
  const hits = [];
  let filesWithHits = 0;
  for (const [path, text] of files) {
    if (/package\.xml$/.test(path)) continue;
    const lines = sftkSweepHits(text, forms);
    if (!lines.length) continue;
    let any = false;
    for (const h of lines) {
      const k = sftkSweepKind(path, text, h, forms);
      if (!k) continue;
      any = true;
      hits.push({ path: k.path, file: k.file || null, line: h.line, text: h.text, type: k.type, label: k.label, sev: k.sev, why: k.why, component: k.component, section: k.section });
    }
    if (any) filesWithHits++;
  }
  const byType = {};
  for (const h of hits) {
    const t = byType[h.type] = byType[h.type] || { label: h.label, sev: h.sev, why: h.why, items: [] };
    const key = `${h.component}|${h.section || ''}|${h.path}`;
    let it = t.items.find(x => x.key === key);
    if (!it) { it = { key, component: h.component, section: h.section, path: h.path, lines: [] }; t.items.push(it); }
    it.lines.push({ line: h.line, text: h.text, ...(h.file ? { file: h.file } : {}) });
  }
  return { hits, byType, filesRead: files.size, filesWithHits };
}

// The sweep against the everyday scan: which sweep items the scan already
// listed (same kind + name) and which are new. `scanItems`: [{ type, name }].
function sftkSweepCompare(byType, scanItems) {
  const alias = { ValidationRuleInactive: 'ValidationRule', ProcessBuilder: 'Flow', CustomMetadataText: 'CustomMetadataRecord', LwcMarkup: 'LightningComponentBundle', LayoutRelatedList: 'Layout' };
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  // the scan's names per kind, normalised; a scan name may carry a suffix ("SFTK_Live_Cmt.Ref (Field__c)")
  // or a label instead of the API name, so a match is: equal, or one the start of the other (≥ 6 chars)
  const names = {};
  for (const x of (scanItems || [])) {
    const ty = alias[x.type] || x.type;
    (names[ty] = names[ty] || []).push(norm(x.name));
  }
  const matches = (ty, k) => (names[ty] || []).some(n => n === k || (k.length >= 6 && n.startsWith(k)) || (n.length >= 6 && k.startsWith(n)));
  let known = 0, fresh = 0;
  for (const [type, t] of Object.entries(byType || {})) {
    const ty = alias[type] || type;
    for (const it of t.items) {
      const c = String(it.component || '');
      const cands = [...new Set([c, c.includes('.') ? c.slice(c.indexOf('.') + 1) : c, c.includes('/') ? c.slice(c.lastIndexOf('/') + 1) : c].map(norm))];
      it.inScan = cands.some(k => matches(ty, k));
      if (it.inScan) known++; else fresh++;
    }
  }
  return { known, fresh };
}

// The result as CSV (user 2026-11-08: "make sure the user can export this report as well"): one row per line
// that names the field — the kind, 🔒/👀, the component, where (path, line), the text, and whether the everyday
// scan had listed it / the list above took it in.
function sftkSweepCsv(result, objApi, fieldApi) {
  const cell = v => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = [['field', 'kind', 'severity', 'component', 'section', 'path', 'line', 'text', 'in the scan list', 'joined the list']];
  for (const [type, t] of Object.entries((result && result.byType) || {})) {
    for (const it of t.items) {
      for (const l of it.lines) rows.push([`${objApi}.${fieldApi}`, `${t.label} (${type})`, t.sev === 'blocker' ? 'must fix before the delete' : 'breaks after the delete', it.component, it.section || '', l.file ? `${it.path} › ${l.file}` : it.path, l.line, String(l.text || '').trim(), it.inScan ? 'yes' : 'no', it.joined ? 'yes' : 'no']);
    }
  }
  return rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
// The kinds whose fresh hits can JOIN Field Cleaner's list with the ways of their kind (✂ ⇄ ✎ 🗑): the ones a
// fix reaches by full name or by a Tooling id a name lookup gives. A flow, a Lightning page, a layout, a report
// or a Path needs the index's own ids and stays in the sweep's box; so does anything with no kind in the list.
function sftkSweepJoinKind(type) {
  const alias = { ValidationRuleInactive: 'ValidationRule', CustomMetadataText: 'CustomMetadataRecord', LwcMarkup: 'LightningComponentBundle' };
  const t = alias[type] || type;
  const ok = new Set(['ApexClass', 'ApexTrigger', 'ApexPage', 'ApexComponent', 'LightningComponentBundle', 'ValidationRule', 'WebLink', 'FieldSet',
    'CustomField', 'LookupFilter', 'WorkflowRule', 'WorkflowFieldUpdate', 'WorkflowAlert', 'WorkflowOutboundMessage', 'ApprovalProcess', 'SharingCriteriaRule',
    'MatchingRule', 'DuplicateRule', 'AssignmentRule', 'AutoResponseRule', 'EscalationRule', 'RestrictionRule', 'CustomMetadataRecord', 'LeadConvertSettings',
    'ListView', 'CompactLayout', 'QuickAction']);
  return ok.has(t) ? t : null;
}
// a code kind's Tooling id is found by name: the sobject and the name field
function sftkSweepIdQuery(kind, component) {
  const q = s => String(s).replace(/'/g, "\\'");
  const name = String(component || '').includes('/') ? component.slice(component.lastIndexOf('/') + 1) : component;
  if (kind === 'ApexClass' || kind === 'ApexTrigger' || kind === 'ApexPage' || kind === 'ApexComponent') return `SELECT Id FROM ${kind} WHERE Name = '${q(name)}'`;
  if (kind === 'LightningComponentBundle') return `SELECT Id FROM LightningComponentBundle WHERE DeveloperName = '${q(name)}'`;
  return null;
}

// Time left, from what has been done so far: a plain rate, in ms. null until
// something finished.
function sftkSweepEta(startedAt, doneUnits, totalUnits, now) {
  const t = (now == null ? Date.now() : now) - startedAt;
  if (!doneUnits || doneUnits <= 0 || t <= 0) return null;
  const left = Math.max(0, totalUnits - doneUnits);
  return Math.round((t / doneUnits) * left);
}
function sftkSweepFmtMs(ms) {
  if (ms == null) return '…';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return m < 60 ? `${m}m ${String(r).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkSweepForms = sftkSweepForms;
  globalThis.sftkSweepHits = sftkSweepHits;
  globalThis.sftkSweepParseDescribe = sftkSweepParseDescribe;
  globalThis.sftkSweepParseList = sftkSweepParseList;
  globalThis.sftkSweepTypes = sftkSweepTypes;
  globalThis.sftkSweepOwn = sftkSweepOwn;
  globalThis.sftkSweepChunks = sftkSweepChunks;
  globalThis.sftkSweepIsText = sftkSweepIsText;
  globalThis.sftkUnzip = sftkUnzip;
  globalThis.sftkBase64ToBytes = sftkBase64ToBytes;
  globalThis.sftkSweepSections = sftkSweepSections;
  globalThis.sftkSweepKind = sftkSweepKind;
  globalThis.sftkSweepRun = sftkSweepRun;
  globalThis.sftkSweepCompare = sftkSweepCompare;
  globalThis.sftkSweepCsv = sftkSweepCsv;
  globalThis.sftkSweepJoinKind = sftkSweepJoinKind;
  globalThis.sftkSweepIdQuery = sftkSweepIdQuery;
  globalThis.sftkSweepEta = sftkSweepEta;
  globalThis.sftkSweepFmtMs = sftkSweepFmtMs;
  globalThis.sftkSweepKindTable = sftkSweepKindTable;
}
