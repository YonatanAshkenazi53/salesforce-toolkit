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
// QA 1.1 (finding 30): a custom field has two more spellings the one name missed. A lookup or master-detail
// Parent__c is written Parent__r wherever a path goes THROUGH it (SOQL, a formula, a merge field, an LWC
// template), and a Contact field Level__c is Level__pc on Account when person accounts are on. Both are names
// of this field, so they are searched too: `names` lists every spelling, `re` / `reG` match any of them, `pc`
// matches the person-account one alone. `fieldType` (the field's data type, "Lookup(Account)" / "reference" /
// "Text(80)") is optional: a type that is plainly no relationship drops the __r spelling; unknown keeps it.
function sftkSweepForms(objApi, fieldApi, fieldType) {
  const f = String(fieldApi || '').trim();
  const o = String(objApi || '').trim();
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const custom = /__c$/i.test(f);
  const stem = f.replace(/__c$/i, '');
  const ty = String(fieldType || '');
  const rel = custom && (!ty || /lookup|master|reference|hierarchy/i.test(ty));
  const pcName = custom && o.toLowerCase() === 'contact' ? stem + '__pc' : '';
  const names = [f, ...(rel ? [stem + '__r'] : []), ...(pcName ? [pcName] : [])];
  const any = `(?<![A-Za-z0-9_])(?:${names.map(esc).join('|')})(?![A-Za-z0-9_])`;
  return {
    object: o,
    field: f,
    names,
    re: new RegExp(any, 'i'),
    reG: new RegExp(any, 'gi'),
    pc: pcName ? new RegExp(`(?<![A-Za-z0-9_])${esc(pcName)}(?![A-Za-z0-9_])`, 'i') : null,
    qualified: new RegExp(`(?<![A-Za-z0-9_])${esc(o)}\\.${esc(f)}(?![A-Za-z0-9_])`, 'i'),
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
// 2026-11-18 (owner: "and add all the 4"): data integration rules (CleanDataService — field mappings), Embedded
// Service configuration (pre-chat fields), home page components (HTML) and s-controls (code) are READ: each can
// hold a field's name.
function _sftkSweepSkip() {
  return new Set([
  'StaticResource', 'Document', 'ContentAsset', 'SiteDotCom', 'Certificate', 'InstalledPackage',
  'Settings', 'ManagedContentType', 'Audience', 'LightningBolt',
  'Package', 'Portal', 'Letterhead', 'WaveDataflow', 'WaveDataset', 'WaveLens',
  'WaveRecipe', 'WaveTemplateBundle', 'WaveXmd', 'DiscoveryAIModel', 'DiscoveryGoal', 'DiscoveryStory',
  'ExternalDataSource', 'ExternalServiceRegistration', 'NamedCredential', 'ExternalCredential',
  'SamlSsoConfig', 'AuthProvider', 'ConnectedApp', 'RemoteSiteSetting', 'CspTrustedSite',
  'CorsWhitelistOrigin', 'Group', 'Queue', 'Role', 'Territory2', 'Territory2Model', 'Territory2Rule',
  'Territory2Type', 'Community', 'NetworkBranding', 'BrandingSet', 'UserCriteria', 'TopicsForObjects',
  'ChatterExtension', 'Skill', 'LiveChatAgentConfig', 'LiveChatButton', 'LiveChatDeployment',
  'LiveChatSensitiveDataRule', 'PresenceUserConfig', 'PresenceDeclineReason', 'ServiceChannel',
  'ServicePresenceStatus', 'QueueRoutingConfig', 'CustomSite', 'CustomTab', 'CustomApplication',
  'AppMenu', 'HomePageLayout', 'CustomPageWebLink', 'ProfilePasswordPolicy',
  'ProfileSessionSetting', 'MutingPermissionSet', 'PermissionSetGroup', 'PlatformCachePartition',
  'EventDelivery', 'EventSubscription', 'EclairGeoData', 'OauthCustomScope',
  'EmailServicesFunction', 'MyDomainDiscoverableLogin', 'LightningExperienceTheme', 'LightningMessageChannel',
  'NotificationTypeConfig', 'ProfileSearchLayouts', 'CustomNotificationType', 'ApexEmailNotifications',
  'IframeWhiteListUrlSettings', 'RedirectWhitelistUrl', 'StandardValueSet', 'StandardValueSetTranslation',
  'GlobalValueSetTranslation', 'TimeSheetTemplate', 'CallCenter', 'DataCategoryGroup', 'Layout_Translation',
  ]);
}
// A static resource the text scan can read (owner 2026-11-17: "All of them please"): the retrieve leaves the kind
// out because most are images, fonts and zips. A script, style sheet, JSON, XML or plain-text one of the org's own,
// up to 1 MB, is read through the REST API instead. PURE.
//   rec: { ContentType, BodyLength, NamespacePrefix }
function sftkSweepTextResource(rec) {
  if (!rec || rec.NamespacePrefix) return false;
  const n = Number(rec.BodyLength);
  if (!(n > 0) || n > 1000000) return false;   // 1 MB: a bigger text file is a bundled library, not the org's own script
  return /^(text\/|application\/(javascript|x-javascript|json|xml|ecmascript)\b)|\+(json|xml)\b/i.test(String(rec.ContentType || '').trim());
}
// QA 1.1 (finding 34): the line under a finished scan that says what it did NOT read. It named static resources
// (the org's own text ones are read since 2026-11-17) and left out five skipped kinds that can hold a field's
// name. One sentence, kept beside the skip list it describes. PURE.
function sftkSweepNotRead() {
  return 'Kinds not read: binary static resources (images, fonts, zips, or a file over 1 MB), documents, content and site assets, '
    + 'settings, certificates, territory assignment rules, Experience audiences, CRM Analytics dataflows and recipes, '
    + 'muting permission sets, and anything installed from a managed package.';
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
  PlatformEventChannelMember: { label: 'Change Data Capture channels', sev: 'mention', why: 'the channel sends the field with every change event (an enriched field) — nothing stops the delete (check-only, live 2026-11-17); the events no longer carry it' },
  StaticResource:         { label: 'Static Resources', sev: 'mention', why: 'a script or data file names the field as text — nothing stops the delete, the page that loads the file breaks where it reads the field' },
  // 2026-11-18 (owner: "and add all the 4") — none was put to a delete live; each is said as what it is: a mention
  CleanDataService:       { label: 'Data integration rules', sev: 'mention', why: 'the rule maps the field to a data service — the mapping breaks when the field is gone' },
  EmbeddedServiceConfig:  { label: 'Embedded Service (chat) configuration', sev: 'mention', why: 'the chat or messaging setup names the field (a pre-chat field) — the form loses it' },
  HomePageComponent:      { label: 'Home page components', sev: 'mention', why: 'the component’s HTML names the field as text — it breaks where it reads it' },
  Scontrol:               { label: 'S-controls', sev: 'mention', why: 'the s-control’s code names the field as text — it breaks where it reads it' },
  ExperienceBundle:       { label: 'Experience Cloud pages', sev: 'mention', why: 'the page or component names the field as text — it breaks where it reads it' },
  CustomLabel:            { label: 'Custom Labels', sev: 'mention', why: 'a label’s text holds the field’s name — nothing stops the delete' },
  // Agentforce, 2026-11-21. A field's name stands in these as prose only — an action's description and the
  // descriptions inside its schema.json, a topic's scope and instructions. None was put to a delete live: npc2
  // refuses the deploy of an action ("An unexpected error occurred"), so no fixture exists.
  GenAiFunction:          { label: 'Agentforce actions', sev: 'mention', why: 'the action’s description or its input / output schema names the field as text — nothing stops the delete; the agent is then told about a field that is gone' },
  GenAiPlugin:            { label: 'Agentforce topics', sev: 'mention', why: 'the topic’s scope or instructions name the field as text — nothing stops the delete; the agent is then told about a field that is gone' },
  GenAiPlannerBundle:     { label: 'Agentforce agents', sev: 'mention', why: 'the agent’s plan names the field as text — nothing stops the delete' },
  Bot:                    { label: 'Bots', sev: 'mention', why: 'a dialog, a variable or a message of the bot names the field — it breaks where it reads it' },
  DocText:                { label: 'Named only in descriptive text', sev: 'mention', why: 'the name stands only in a description, help text, label or message of the component, or in a comment of its code — plain text Salesforce does not read as a reference; nothing stops the delete and nothing breaks, the text just goes stale' },
  SameNameOtherObject:    { label: 'Same name, another object', sev: 'mention', why: 'a component of another object holds a field of the same API name by its bare name or under that object’s own name, or code that names this object nowhere in its file (a file-level test) holds it — most likely that object’s own field, not this one; it does not join the list, and Salesforce’s own delete check decides' },
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
  // 2026-11-15 (live re-check): a picklist whose DESCRIPTION said "the same picklist as SFTK_FC_Test_Status__c
  // WITHOUT the value Closed" came back as 'Formula & Roll-up Fields | formula' — a 🔒 that joined the list with
  // "Delete formula or roll-up field" and was counted in the delete zone; Salesforce accepts the delete with it in
  // place. Documentation text is no reference in any kind. docOnly() → the phrase for the hit when EVERY mention
  // of the field on the hit's line stands inside a documentation element, else null. Those elements are leaves, so
  // the tag that opens last before a mention is the element holding it (a description may run over several lines).
  // Narrow on purpose: a flow's help text, interview label and screen error message take merge fields (a real
  // reference) — only a flow's description and label are plain; a validation rule's errorMessage is plain (its
  // errorDisplayField and formula are not); a duplicate rule's alertText is plain. Kept inside this function (not
  // a helper beside it) so every caller and test that slices sftkSweepKind alone keeps working.
  const docOnly = () => {
    if (!hit || !forms || !forms.field) return null;
    const s = String(text || '');
    // code and markup are not metadata XML — a "<description>" there is no documentation element; their
    // -meta.xml companions are
    const xml = /\.xml$/i.test(p) || /^\s*<\?xml/.test(s) || /^(objects|workflows|sharingRules|matchingRules|duplicateRules|assignmentRules|autoResponseRules|escalationRules|approvalProcesses|flows|flexipages|customMetadata|quickActions|restrictionRules)$/.test(dir);
    if (!xml || (/^(classes|triggers|pages|components|lwc|aura|email|experiences|staticresources)$/.test(dir) && !/-meta\.xml$/i.test(p))) return null;
    // a translation file IS labels and help text: its kind already says the translated text goes with the field
    if (dir === 'objectTranslations' || dir === 'translations') return null;
    const tags = { description: 'a description', label: 'a label' };
    if (dir !== 'flows') Object.assign(tags, { inlineHelpText: 'help text', masterLabel: 'a label', pluralLabel: 'a label' });
    if (dir === 'duplicateRules') tags.alertText = 'an alert text';
    if (dir === 'objects') { const sec = secAt(); if (sec && sec.tag === 'validationRules') tags.errorMessage = 'an error message'; }
    const from = Number(hit.offset) || 0;
    let to = s.indexOf('\n', from); if (to < 0) to = s.length;
    // every spelling the sweep searched for (Field__c, Field__r, Field__pc), where the forms carry them
    const re = forms.reG ? new RegExp(forms.reG.source, 'gi')
      : new RegExp(`(?<![A-Za-z0-9_])${String(forms.field).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'gi');
    const line = s.slice(from, to);
    let phrase = null;
    for (let m; (m = re.exec(line));) {
      const at = from + m.index;
      const lt = s.lastIndexOf('<', at);
      const open = lt < 0 ? null : /^<([A-Za-z][A-Za-z0-9_]*)>/.exec(s.slice(lt, at + 1));   // a plain opening tag, closed before the mention
      // inside a tag, after a closing tag, in a comment or CDATA, or in an element that is not documentation:
      // one real mention on the line keeps the line's kind
      if (!open || !Object.prototype.hasOwnProperty.call(tags, open[1])) return null;
      phrase = phrase || tags[open[1]];
    }
    return phrase ? `named only in ${phrase}` : null;
  };
  const raw = () => {
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
    case 'staticresources': return K('StaticResource', base);
    case 'cleanDataServices': return K('CleanDataService', base);
    case 'EmbeddedServiceConfig': return K('EmbeddedServiceConfig', base);
    case 'homePageComponents': return K('HomePageComponent', base);
    case 'scontrols': return K('Scontrol', base);
    case 'platformEventChannelMembers': return K('PlatformEventChannelMember', base);
    // Agentforce (owner 2026-11-19: "what about agentforce components like … actions"). An action is a folder
    // (its -meta.xml and the input / output schema.json), so is an agent's plan and a bot; a topic is one file.
    // File shapes read 2026-11-21 from Salesforce's public sample app (trailheadapps/coral-cloud).
    // QA 1.1 #18: the folder names the component only when there IS a folder. A Metadata API retrieve returns a bot
    // as ONE file, bots/<Name>.bot — seg[1] is then the file itself and the bot was listed as "<Name>.bot".
    // QA 1.1 #21: at the API version the scan retrieves, an agent's plan may be the older type GenAiPlanner and
    // arrive under genAiPlanners/ — the same group, and the same "an agent acts on this text" rule below.
    case 'genAiFunctions': return K('GenAiFunction', seg.length > 2 ? seg[1] : base, seg.slice(2).join('/'));
    case 'genAiPlugins': return K('GenAiPlugin', base);
    case 'genAiPlanners':
    case 'genAiPlannerBundles': return K('GenAiPlannerBundle', seg.length > 2 ? seg[1] : base, seg.slice(2).join('/'));
    case 'bots': return K('Bot', seg.length > 2 ? seg[1] : base, seg.slice(2).join('/'));
    default: return K('Other', `${dir} › ${base}`);
  }
  };
  const k = raw();
  if (!k) return k;   // the field's own definition is no use of it, whatever the line
  // An agent ACTS on the text of its action, topic and plan: the description is what the planner reads to choose and
  // fill the action. A field named there is not "descriptive text nothing reads" (2026-11-21).
  if (k.type === 'GenAiFunction' || k.type === 'GenAiPlugin' || k.type === 'GenAiPlannerBundle') return k;
  const doc = docOnly();
  if (!doc) return k;
  const D = T.DocText;
  return { ...k, type: 'DocText', label: D.label, sev: D.sev, why: D.why, section: doc };
}

// Every hit of every file, classified and grouped. `files`: Map(path → text).
// → { hits: [{ path, line, text, type, label, sev, why, component, section }],
//     byType: { type: { label, sev, why, items: [{ component, section, path, lines: [{line, text}] }] } },
//     filesRead, filesWithHits }
function sftkSweepRun(files, forms) {
  const hits = [];
  let filesWithHits = 0;
  // 2026-11-14 (release QA): the bare-name grep cannot tell WHICH object a name belongs to. Status__c, Type__c,
  // Amount__c live on many objects, so a validation rule, formula, list view, workflow or Apex class of ANOTHER
  // object that names its OWN same-named field came back 🔒, joined the list as a blocker, kept Delete Field locked,
  // and a ✂ walk then offered to delete that unrelated component. The safe direction: such a hit is 👀 "same name,
  // another object" (never joined, never a blocker) unless the line names OUR object's field qualified
  // ("Account.Status__c"). Hiding a real blocker here costs nothing — Salesforce's own check-only delete still
  // refuses and names it; listing a false one leads to deleting the wrong component. Kept inside this function so
  // every caller that slices sftkSweepRun alone keeps working.
  const objName = String((forms && forms.object) || '');
  const objLc = objName.toLowerCase();
  // 2026-11-15 (review of f0334a0): that guard asked for the literal "<Object>.<Field>" and nothing else, so it also
  // demoted REAL blockers — a field reached through a relationship name (Owner.Region__c, Parent_Account__r.Status__c,
  // Account.Parent.Status__c), an Activity field in Task / Event files and code, a Person Account file, and a dynamic
  // 'Field__c' in generic SObject code. Now: Task / Event files are Activity's own and PersonAccount is Account's own;
  // in another object's file only a BARE name (or one spelled with that file's own object name) is demoted — a
  // relationship path keeps its kind, as this text scan cannot resolve it; code "names the object" also by Task /
  // Event / PersonAccount, a quoted bare field name or a path of two hops keeps its kind, and a comment no longer
  // counts as naming the object. The code test stays FILE-level (the object's name anywhere in the code): the kind's
  // why says so.
  const escRx = x => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 2026-11-15 (second review): a CUSTOM field of Task, Event or Activity is one field of the Activity family
  // whichever of the three was picked (the removers' listOwn rule in sftkMdEditField) — with Task picked, an Event
  // rule or the Activity object's own formula was called "Event's own field of this name", which is untrue.
  const actFam = /__c$/i.test(String((forms && forms.field) || '')) && /^(task|event|activity)$/.test(objLc);
  const ALIAS = { activity: ['Task', 'Event'], account: ['PersonAccount'],   // their files and code hold the object's own fields
    ...(actFam ? { [objLc]: ['Task', 'Event', 'Activity'] } : {}) };
  const isOwn = o => {
    const c = String(o || '').toLowerCase();
    if (!c || !objLc) return false;
    if (c === objLc || (ALIAS[objLc] || []).some(a => a.toLowerCase() === c)) return true;
    return typeof sftkMdIsOwnObj === 'function' && sftkMdIsOwnObj(o, objName);   // the removers' rule, where the page has it
  };
  const objWord = objName ? new RegExp(`(?<![A-Za-z0-9_])(?:${[objName, ...(ALIAS[objLc] || [])].map(escRx).join('|')})(?![A-Za-z0-9_])`, 'i') : null;
  // QA 1.1 (finding 30): a mention is any spelling the sweep searched for — a line that only holds Field__r had
  // no mention at all and was demoted as another object's field
  const fieldG = forms && forms.field ? (forms.reG ? new RegExp(forms.reG.source, 'gi') : new RegExp(`(?<![A-Za-z0-9_])${escRx(forms.field)}(?![A-Za-z0-9_])`, 'gi')) : null;
  // Field__pc is a Contact custom field seen from Account, and nothing else is spelled that way: a line that
  // holds it names OUR field, whichever file it is in and whether or not the code says "Contact"
  const pcOurs = line => !!(forms && forms.pc && forms.pc.test(String(line || '')));
  // every mention of the field on a line, with the dotted path written before it ("Owner", "Account.Parent", "")
  const mentions = line => {
    const out = [];
    if (!fieldG) return out;
    const t = String(line || '');
    fieldG.lastIndex = 0;
    for (let m; (m = fieldG.exec(t));) {
      const pre = /((?:[$A-Za-z0-9_]+\.)+)$/.exec(t.slice(0, m.index));
      out.push({ path: pre ? pre[1].slice(0, -1) : '', before: t[m.index - 1] || '', after: t[m.index + m[0].length] || '' });
    }
    return out;
  };
  // In ANOTHER object's file: does the line name the field through something that may lead to OUR object?
  const pathMayBeOurs = (line, owner) => mentions(line).some(x => {
    if (!x.path) return false;                                                 // bare: the file's own object's field
    const ot = /^\$ObjectType\.([A-Za-z0-9_]+)\.Fields$/i.exec(x.path);
    if (ot) return isOwn(ot[1]);                                               // $ObjectType.Contact.Fields.X is Contact's
    // "Contact.X" in Contact's own file; $Source (a lookup filter's own record) and $Record are the file's object
    // too (2026-11-15 second review: a Contact lookup filter's $Source.Status__c joined as Account's blocker)
    if (/^(?:\$source|\$record)$/i.test(x.path) || x.path.toLowerCase() === String(owner).toLowerCase()) return false;
    // 2026-11-15 (close-out review): "any other path is kept" also kept the paths the shared resolver CAN tell —
    // $User.X is User's, $Profile.X Profile's, $Setup.Conf__c.X the setting's, Owner.X User's — so a Contact rule
    // reading $User.Region__c joined the list as a blocker of Account.Region__c, which it is not. The path is walked
    // by sftk-relmap.js (as fieldUpdateMayBeOurs does): demoted only when it ENDS on a known other object; a hop
    // that cannot be told (Lookup__r, What / Who, a $ global that names no object) is kept, the safe direction.
    if (typeof sftkRelHop !== 'function' || typeof sftkRelGlobal !== 'function') return true;
    const segs = x.path.split('.').filter(Boolean);
    let from = String(owner).toLowerCase(), hops = segs;
    if (segs[0] && segs[0][0] === '$') {
      const g = sftkRelGlobal(segs);
      if (!g || !g.obj) return true;
      from = g.obj; hops = segs.slice(g.from);
    }
    // 2026-11-15 (close-out review round 2): the walk answers every unlisted standard hop as "a lookup named for
    // its object" — safe for a remover, the UNSAFE direction here: CampaignMember's LeadOrContactOwner is User,
    // Case's Product was Product2, and a rule that really read the picked field was demoted with an untrue reason.
    // Demoted only when the hop the path ENDS on is positively known (sftkRelHopKnown); anything else is kept.
    let cur = from, known = true;
    for (const hop of hops) {
      const r = sftkRelHop(cur, hop);
      if (r.kind || !r.obj) return true;
      known = typeof sftkRelHopKnown === 'function' && sftkRelHopKnown(cur, hop, known);
      cur = r.obj;
    }
    return known ? isOwn(cur) : true;
  });
  // The TRUE reason of a demotion in another object's file: the file's own field when the line names it bare (or
  // by $Source / $Record / the file's object); a field reached through a path that ends on a third object
  // ($User.X, Owner.X) is not "Contact's own" (2026-11-15 close-out review).
  const otherNote = (line, owner) => {
    const ms = mentions(line);
    const own = x => !x.path || /^(?:\$source|\$record)$/i.test(x.path) || x.path.toLowerCase() === String(owner).toLowerCase()
      || (/^\$ObjectType\.([A-Za-z0-9_]+)\.Fields$/i.exec(x.path) || [])[1]?.toLowerCase() === String(owner).toLowerCase();
    return !ms.length || ms.some(own) ? `${owner}’s own field of this name` : `a field of this name on another object, not ${objName}’s (the path leads elsewhere)`;
  };
  // In code that never names the object: a dynamic 'Field__c' / "Field__c", or a path that goes through a
  // RELATIONSHIP. 2026-11-15 (second review): "two or more hops" also kept this.con.Status__c and the LWC wire shape
  // this.rec.fields.Status__c.value — a variable, `this` and `.fields.` / `.data.` are no relationship. A hop counts
  // when it ends in __r, or is a capitalised name after the variable (Owner, Account, Parent).
  const codeMayBeOurs = line => mentions(line).some(x => {
    if ((x.before === "'" || x.before === '"') && x.after === x.before) return true;
    const segs = x.path.split('.').filter(Boolean);
    if (segs[0] && segs[0].toLowerCase() === 'this') segs.shift();
    return segs.some((g, i) => /__r$/i.test(g) || (i > 0 && /^[A-Z]/.test(g) && !/^(fields|data)$/i.test(g)));
  });
  // 2026-11-15 (close-out review): three blind regexes cut from a "/*" INSIDE a string literal — the Accept header
  // '*/*' — to the next "*/" anywhere later in the file, and with it the code that names the object: a real Apex
  // blocker was demoted as "the code never names Account". One walk, left to right: a '…' / "…" literal that
  // closes on its own line is copied whole (its text may name the object: dynamic SOQL), and only outside one do
  // /* … */, <!-- … --> and // start a comment. A quote with no partner on its line (an apostrophe in markup text)
  // is plain text. "://" is a URL, as before.
  const noComments = t => {
    const s = String(t || '');
    let out = '', i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "'" || ch === '"') {
        let j = i + 1;
        while (j < s.length && s[j] !== ch && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
        if (j < s.length && s[j] === ch) { out += s.slice(i, j + 1); i = j + 1; continue; }
        out += ch; i++; continue;
      }
      if (ch === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); out += ' '; i = e < 0 ? s.length : e + 2; continue; }
      if (ch === '<' && s.startsWith('<!--', i)) { const e = s.indexOf('-->', i + 4); out += ' '; i = e < 0 ? s.length : e + 3; continue; }
      if (ch === '/' && s[i + 1] === '/' && s[i - 1] !== ':') { const e = s.indexOf('\n', i); i = e < 0 ? s.length : e; continue; }
      out += ch; i++;
    }
    return out;
  };
  const ownerOf = (p, text) => {   // the object an object-shaped file belongs to, or null when its path does not say
    const seg = String(p || '').replace(/^unpackaged\//, '').split('/');
    const base = (seg[seg.length - 1] || '').replace(/\.[^.]+$/, '');
    switch (seg[0]) {
      case 'objects': case 'workflows': case 'sharingRules': case 'matchingRules': case 'assignmentRules': case 'autoResponseRules': case 'escalationRules': return base;
      // quickActions (2026-11-15): "Contact.New_Thing" carries its object the same way — it joined the list for
      // Account's field of the same name; a global action has no dot and stays unowned
      case 'duplicateRules': case 'approvalProcesses': return base.includes('.') ? base.split('.')[0] : null;
      // 2026-11-15 (second review): a create action that lives on one object but makes a record of ANOTHER names
      // its <targetObject>'s fields (Contact.New_Account → Account's) — the remover's own rule (sftkMdEditField
      // QuickAction: targetObject, else the host). The name prefix alone demoted Account's real blocker.
      case 'quickActions': {
        const tgt = /<targetObject>\s*([^<\s]+)\s*<\/targetObject>/i.exec(String(text || ''));
        return tgt ? tgt[1] : (base.includes('.') ? base.split('.')[0] : null);
      }
      default: return null;
    }
  };
  const CODE = new Set(['ApexClass', 'ApexTrigger', 'ApexPage', 'ApexComponent', 'LightningComponentBundle']);
  // QA 1.1 (finding 32): a field named only inside a comment of Apex or of an LWC's JavaScript was an Apex / LWC
  // blocker and joined the list with cut and replace; Salesforce compiles no comment and accepts the delete.
  // blankComments() is the file with every comment character turned into a space — same length, same line
  // breaks — so a hit's offset still points at its line and a /* … */ opened lines earlier is seen. Strings are
  // copied whole as in noComments(); a JavaScript template literal may run over lines. Visualforce is left out on
  // purpose: a page evaluates {!…} wherever it stands, an HTML or script comment included.
  const COMMENTED = new Set(['ApexClass', 'ApexTrigger', 'LightningComponentBundle']);
  const blankComments = t => {
    const s = String(t || '');
    const blank = x => x.replace(/[^\n]/g, ' ');
    let out = '', i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "'" || ch === '"') {
        let j = i + 1;
        while (j < s.length && s[j] !== ch && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
        if (j < s.length && s[j] === ch) { out += s.slice(i, j + 1); i = j + 1; continue; }
        out += ch; i++; continue;
      }
      if (ch === '`') {
        let j = i + 1;
        while (j < s.length && s[j] !== '`') j += s[j] === '\\' ? 2 : 1;
        j = Math.min(j, s.length - 1);
        out += s.slice(i, j + 1); i = j + 1; continue;
      }
      if (ch === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); const to = e < 0 ? s.length : e + 2; out += blank(s.slice(i, to)); i = to; continue; }
      if (ch === '/' && s[i + 1] === '/' && s[i - 1] !== ':') { const e = s.indexOf('\n', i); const to = e < 0 ? s.length : e; out += blank(s.slice(i, to)); i = to; continue; }
      out += ch; i++;
    }
    return out;
  };
  // true = the hit's line names the field only inside a comment
  const commentOnly = (blanked, h) => {
    if (!fieldG) return false;
    const from = Number(h.offset) || 0;
    let to = blanked.indexOf('\n', from); if (to < 0) to = blanked.length;
    fieldG.lastIndex = 0;
    const live = fieldG.test(blanked.slice(from, to));
    fieldG.lastIndex = 0;
    return !live;
  };
  const DT = sftkSweepKindTable().DocText;
  // QA 1.1 (finding 31): a file whose PATH names no object still belongs to one. A Contact record-triggered flow's
  // $Record.Status__c and a Contact record page's Record.Status__c came back as blockers of Account.Status__c
  // ("must go or change before the delete - by hand"); Contact's layout, a report column Contact.Status__c and a
  // permission line Contact.Status__c as its mentions. fileObj() → the OTHER object whose own field the line names,
  // or null (keep the kind). Narrow on purpose — only the spellings that can mean nothing else:
  //   flow        the <start> object, and every mention written $Record.X / $Record__Prior.X (a Get Records on our
  //               object inside a Contact flow names the field bare, beside <object>Account</object>: kept)
  //   page        <sobjectType>, and every mention written Record.X
  //   layout      the object before the first "-" of the file name, a bare field item (not a related-list column,
  //               which is another object's field)
  //   report, permission set, profile    every mention written Object.X with one plain object name before it
  const fileObj = (p, text, h, k) => {
    const seg = String(p || '').replace(/^unpackaged\//, '').split('/');
    const ms = mentions(h.text);
    if (!ms.length) return null;
    const foreign = o => (o && !isOwn(o) ? o : null);
    const tagIn = (s, tag) => (new RegExp('<' + tag + '>\\s*([^<\\s]+)\\s*</' + tag + '>', 'i').exec(String(s || '')) || [])[1] || '';
    switch (seg[0]) {
      case 'flows': {
        const st = /<start>[\s\S]*?<\/start>/i.exec(String(text || ''));
        const fo = foreign(st && tagIn(st[0], 'object'));
        return fo && ms.every(x => /^\$Record(?:__Prior)?$/i.test(x.path)) ? fo : null;
      }
      case 'flexipages': {
        const fo = foreign(tagIn(text, 'sobjectType'));
        return fo && ms.every(x => /^Record$/i.test(x.path)) ? fo : null;
      }
      case 'layouts': {
        if (k.type !== 'Layout') return null;
        const base = seg[seg.length - 1] || '';
        const o = base.includes('-') ? base.slice(0, base.indexOf('-')) : '';
        const fo = foreign({ caseclose: 'Case', caseinteraction: 'Case' }[o.toLowerCase()] || o);   // Case's two special layouts hold Case's fields
        return fo && ms.every(x => !x.path) ? fo : null;
      }
      case 'reports': case 'permissionsets': case 'profiles': {
        // "FK_$Contact.X" in a report is Contact's too; a relationship name (…__r) or a longer path is not told here
        const objs = ms.map(x => (/^[A-Za-z0-9_$]+$/.test(x.path) && !/__r$/i.test(x.path) ? foreign(x.path.replace(/^.*\$/, '')) : null));
        return objs.every(Boolean) ? objs[0] : null;
      }
      default: return null;
    }
  };
  const ON = sftkSweepKindTable().SameNameOtherObject;
  const other = (k, note) => ({ ...k, type: 'SameNameOtherObject', label: ON.label, sev: ON.sev, why: ON.why, section: note });
  // 2026-11-15 (second review): a cross-object field update writes the PARENT's field by its bare name, with
  // <targetObject>AccountId</targetObject> beside it — in Contact's workflow file that is Account's field, not
  // Contact's. True = the update's target is, or may be, our object (a custom lookup cannot be told here: kept,
  // as a relationship path is); false = no target, or one that leads to another object.
  const fieldUpdateMayBeOurs = (text, h, owner) => {
    const sec = _sftkSweepSectionAt(sftkSweepSections(text), h.offset);
    const tg = sec && /<targetObject>\s*([^<\s]+)\s*<\/targetObject>/i.exec(String(text).slice(sec.start, sec.end));
    if (!tg) return false;
    if (typeof sftkRelLookupField !== 'function') return true;
    const r = sftkRelLookupField(String(owner).toLowerCase(), tg[1]);
    return !r || !r.obj ? true : isOwn(r.obj);
  };
  for (const [path, text] of files) {
    if (/package\.xml$/.test(path)) continue;
    const lines = sftkSweepHits(text, forms);
    if (!lines.length) continue;
    let any = false;
    const owner = ownerOf(path, text);
    const codeNamesObj = !objWord || objWord.test(noComments(text));
    let blanked = null;   // the file with its comments blanked, made on the first code hit
    let fo = null;
    for (const h of lines) {
      let k = sftkSweepKind(path, text, h, forms);
      if (!k) continue;
      const qualified = !!(forms && forms.qualified && forms.qualified.test(h.text));
      if (k.type === 'DocText') { /* 2026-11-15: plain text — already 👀 with its own true reason, not "another object's field" */ }
      else if (COMMENTED.has(k.type) && commentOnly(blanked == null ? (blanked = blankComments(text)) : blanked, h)) k = { ...k, type: 'DocText', label: DT.label, sev: DT.sev, why: DT.why, section: 'named only in a code comment' };
      else if (pcOurs(h.text)) { /* the person-account spelling is ours for certain: it keeps its kind */ }
      else if (objLc && owner && !isOwn(owner) && !qualified && !pathMayBeOurs(h.text, owner)
        && !(k.type === 'WorkflowFieldUpdate' && fieldUpdateMayBeOurs(text, h, owner))) k = other(k, otherNote(h.text, owner));
      else if (objLc && !owner && CODE.has(k.type) && !codeNamesObj && !codeMayBeOurs(h.text)
        // the hit line itself naming the object ("for (Account a : …) a.Region__c") is never "the code never names it"
        && !objWord.test(noComments(h.text))) k = other(k, `the code never names ${objName}`);
      else if (objLc && !owner && !qualified && (fo = fileObj(path, text, h, k))) k = other(k, `${fo}’s own field of this name`);
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
  // QA 1.1 (finding 29): the "start of the other" allowance also matched two DIFFERENT components — the scan's
  // AccountServiceTest hid the sweep's AccountService, Check_Status_Closed hid Check_Status — and a blocker the
  // scan had missed was shown nowhere. A scan name that is a plain API name (identifier characters and dots only)
  // now matches by equality alone; the allowance is kept for what it was written for, a name with a suffix or a
  // label, and there the shorter name must end where a word of the longer one ends.
  const names = {};
  for (const x of (scanItems || [])) {
    const ty = alias[x.type] || x.type;
    (names[ty] = names[ty] || []).push({ n: norm(x.name), loose: !/^[A-Za-z0-9_.]+$/.test(String(x.name || '')) });
  }
  const starts = (long, short) => short.length >= 6 && long.startsWith(short) && long[short.length] === '_';
  const matches = (ty, k) => (names[ty] || []).some(({ n, loose }) => n === k || (loose && (starts(n, k) || starts(k, n))));
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
  // QA 1.1 (finding 11): the cells are org content (a line of a template, a label, Apex). A spreadsheet runs a
  // cell that starts with = + - @ (or a tab / CR before one) as a formula: "=HYPERLINK(…)" from a template author
  // became a live link, and an Apex line "+ ',Status__c FROM Account';" showed #NAME? instead of the code. Such a
  // cell gets a leading apostrophe, which a spreadsheet reads as "this is text"; then the usual quoting.
  const cell = v => {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [['field', 'kind', 'severity', 'component', 'section', 'path', 'line', 'text', 'in the scan list', 'joined the list']];
  for (const [type, t] of Object.entries((result && result.byType) || {})) {
    for (const it of t.items) {
      for (const l of it.lines) rows.push([`${objApi}.${fieldApi}`, `${t.label} (${type})`, t.sev === 'blocker' ? 'must fix before the delete' : (type === 'DocText' ? 'plain text only - nothing breaks' : 'breaks after the delete'), it.component, it.section || '', l.file ? `${it.path} › ${l.file}` : it.path, l.line, String(l.text || '').trim(), it.inScan ? 'yes' : 'no', it.joined ? 'yes' : 'no']);
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
// QA 1.1 (finding 36): Name / DeveloperName carry no namespace, so the org's own Utils and an installed package's
// ns.Utils both matched and the caller took the first row — the joined row could carry the packaged class's id,
// which nobody can read or edit. The sweep only reads the org's own components, so the row with no namespace is
// the right one; when only a packaged one exists the lookup finds nothing and the hit stays in the sweep's box.
function sftkSweepIdQuery(kind, component) {
  const q = s => String(s).replace(/'/g, "\\'");
  const name = String(component || '').includes('/') ? component.slice(component.lastIndexOf('/') + 1) : component;
  if (kind === 'ApexClass' || kind === 'ApexTrigger' || kind === 'ApexPage' || kind === 'ApexComponent') return `SELECT Id FROM ${kind} WHERE Name = '${q(name)}' AND NamespacePrefix = null`;
  if (kind === 'LightningComponentBundle') return `SELECT Id FROM LightningComponentBundle WHERE DeveloperName = '${q(name)}' AND NamespacePrefix = null`;
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
  globalThis.sftkSweepNotRead = sftkSweepNotRead;
}
