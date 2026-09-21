// Renders the Deploy view's REAL markup with the REAL stylesheet into a static
// page (repo root, so studio.css resolves) for a headless screenshot.
import vm from 'node:vm';
import { readFileSync, writeFileSync } from 'node:fs';
const ROOT = 'C:/Users/yonas/OneDrive/Desktop/Saleforce Toolkit/';
const src = f => readFileSync(ROOT + f, 'utf8');
function grab(file, name) { const s = src(file); const i = s.indexOf(`function ${name}(`); if (i < 0) throw new Error(name); return s.slice(i, s.indexOf('\n}\n', i) + 3); }
const [tab, objPath, dark] = [process.argv[2] || 'same', process.argv[3] || '', process.argv[4] === 'dark'];

const els = new Map();
const mkEl = id => ({ id, innerHTML: '', textContent: '', disabled: false, dataset: {}, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, scrollIntoView() {} });
let mainHtml = '';
const ctx = { console, Set, Map, Object, Number, String, Array, JSON, Math, Promise,
  _settings: { deployViewBeta: true }, storageSaveSettings: async () => {}, _currentView: 'deploy', _profiles: [], _recDeleteMode: 'recycle',
  _recSel: { push: new Set(), overwrite: new Set(), updSrc: new Set(), del: new Set(), pull: new Set() }, _recChildSel: {}, _reconcileProfile: null,
  window: { runProfile() {}, openReconcile() {}, sftkOrgLocked: () => false }, document: { querySelectorAll: () => [], querySelector: () => null },
  eid: id => { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); }, setMain: h => { mainHtml = h; },
  esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  dsIcon: () => '', SFTKOnboard: undefined,
  orgLabel: u => String(u).replace(/^https?:\/\//, '').split('.')[0], prodBadge: () => '', timeAgo: () => '2m ago',
  showToast() {}, showModal() {}, renderProfiles() {}, renderReconcile() {}, runReconcile() {}, scanReconcileChild: async () => ({}),
  sftkRecResetSelectionFor() {}, sftkRecScanFresh: () => true, sftkOpenDriftCompare() {}, renderLkpOverridePanel() {},
  _parentSyncVerdicts: { 'k|Campaign': { missing: 0, changed: 0, at: new Date(Date.now() - 120000).toISOString() }, 'k|Pricebook2': { missing: 3, changed: 1, at: new Date(Date.now() - 300000).toISOString() } }, sftkParentSyncKey: (a, b, o) => 'k|' + o,
  sftkParentGapSetGate() {}, sftkParentVerifyOne: async () => true, sftkOpenParentsFirst: async () => true, sftkRecWireDupFix() {}, sftkRecSetEngine: async () => 'auto',
  sftkOrgKey: u => String(u), sftkOpenIdentityModal() {},
  sftkIdStatusFor: async () => ({ srcOnline: true, tgtOnline: true, objects: [
    { pathKey: '', obj: 'Account', depth: 0, src: 'no', tgt: 'yes', customizable: true }, { pathKey: '0', obj: 'Contact', depth: 1, src: 'no', tgt: 'no', customizable: true }] }),

  sftkParentOrderFor: async () => ({ offline: false, objects: [
    { pathKey: '', obj: 'Account', depth: 0, parentObj: null, parents: [{ field: 'Primary_Campaign__c', refObj: 'Campaign', empty: false, required: false }, { field: 'Price_Book__c', refObj: 'Pricebook2', empty: false, required: false }] },
    { pathKey: '0', obj: 'Contact', depth: 1, parentObj: 'Account', parents: [{ field: 'Campaign__c', refObj: 'Campaign', empty: false, required: false }, { field: 'Region__c', refObj: 'Region__c', empty: true, required: true }] }] }),
  sftkLkpOvGet: () => ({}), sftkMatchKeyLabel: k => String(k), getNodeByPath: (r, k) => k.split('.').reduce((n, i) => n.children[Number(i)], r) };
vm.createContext(ctx);
for (const [f, n] of [['studio-scan.js', 'sftkBucketCapShipped'], ['studio-scan.js', 'sftkScanBucketInfo'], ['studio-scan.js', 'sftkBucketCountLabel'],
  ['studio-reconcile.js', 'sftkRecChildRowState'], ['studio-reconcile.js', 'sftkPaContactsLine'], ['studio-reconcile.js', 'sftkParentStepState'], ['studio-reconcile.js', 'sftkRecDupsHtml'], ['sftk-identity.js', 'sftkIdCreatable'], ['studio-core.js', 'dsViewHeader']]) vm.runInContext(grab(f, n), ctx);
vm.runInContext(src('studio-deploy.js').replace(/^'use strict';/, ''), ctx);

const N = ['Tara Moreno','Christopher Garcia','Angela Wong','Albert Hebert','Jeffrey Paul','Kathy Sexton','Noa Levi','Daniel Cohen','Maya Peretz','Omer Katz','Shira Avraham','Lior Friedman','Eden Shalom','Roni Azulay','Negev Solar','Carmel Wines','Galil Dairy','Jaffa Ports'];
const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
ctx._reconcileProfile = { id: 'p1', name: 'Account + Contacts', sourceOrg: 'https://trailheads2.my.salesforce.com', targetOrg: 'https://trailheads4.my.salesforce.com',
  tree: { objectType: 'Account', children: [{ childSObject: 'Contact', field: 'AccountId', children: [{ childSObject: 'Case', field: 'ContactId', children: [] }] }, { childSObject: 'Opportunity', field: 'AccountId', children: [] }] },
  lastScan: { status: 'success', runAt: 'T1', fetched: { src: 5058, tgt: 5058 }, compareFields: ['Name'],
    bucketCapNote: '⚠ This Account scan is TRUNCATED — in sync 5,000 of 5,052. Only the rows listed below exist in this result; the rest were never loaded.',
    bucketCaps: { cap: 5000, identical: { shown: 5000, total: 5052, capped: true, cap: 5000 } }, dupKeys: { rows: 4, keys: ['Negev Solar', 'Tara Moreno'], examples: [{ key: 'Negev Solar', src: ['001A', '001B'], tgt: ['001C', '001D'] }, { key: 'Tara Moreno', src: ['001E', '001F'], tgt: [] }] },
    missingInTarget: rows(4, i => ({ matchKey: N[14 + i], sourceId: 'S' + i })), changed: [{ matchKey: 'Noa Levi', sourceId: 'SC1', targetId: 'TC1', fields: ['Phone', 'PersonEmail', 'Description', 'Fax'] }],
    onlyInTarget: [], identical: rows(400, i => ({ matchKey: N[i % N.length] + (i >= N.length ? ' ' + i : ''), sourceId: 'SS' + i, targetId: 'TS' + i })),
    children: { '0': { status: 'success', rootRunAt: 'T1', objectType: 'Contact', fetched: { src: 31, tgt: 12 }, compareFields: ['LastName'], linkUpdateable: true,
      missingInTarget: [{ matchKey: 'Omer Katz', sourceId: 'K1', parentSrcId: 'S1', parentKeySrc: 'Carmel Wines' }, { matchKey: 'Shira Avraham', sourceId: 'K2', parentSrcId: 'SS1', parentKeySrc: 'Christopher Garcia' }, { matchKey: 'Lior Friedman', sourceId: 'K3', parentSrcId: 'ZZ', parentKeySrc: '?' }],
      changed: [{ matchKey: 'Eden Shalom', sourceId: 'K5', targetId: 'TK5', fields: ['Title'] }], onlyInTarget: [{ matchKey: 'Test Contact', targetId: 'TK6', orphan: true }],
      linkMismatch: [{ matchKey: 'Roni Azulay', sourceId: 'K8', targetId: 'TK8', parentKeySrc: 'Negev Solar', parentKeyTgt: 'Galil Dairy' }],
      identical: rows(10, i => ({ matchKey: N[i], sourceId: 'K9' + i, targetId: 'TK9' + i, personAccount: true })), personContacts: { src: 10, tgt: 10, synced: 10, waiting: 0, follows: 0, targetOnly: 0 } } } } };
vm.runInContext(`_depObjPath = ${JSON.stringify(objPath)}; _depTab = ${JSON.stringify(tab)}; _recSel.push.add('S1'); _recSel.push.add('S2');`, ctx);
await vm.runInContext('renderDeploy()', ctx);
vm.runInContext(`_depObjPath = ${JSON.stringify(objPath)}; _depTab = ${JSON.stringify(tab)};`, ctx);
await vm.runInContext('renderDeploy()', ctx);
await new Promise(r => setTimeout(r, 0));
await new Promise(r => setTimeout(r, 0));
let html = mainHtml.replace('<div id="dsDepTree"></div>', `<div id="dsDepTree">${els.get('dsDepTree').innerHTML}</div>`).replace('<div id="dsDepOrder"></div>', `<div id="dsDepOrder">${els.get('dsDepOrder').innerHTML}</div>`).replace('<details class="ds-rec-dups">', '<details class="ds-rec-dups" open>').replace('<div id="dsDepList"></div>', `<div id="dsDepList">${els.get('dsDepList').innerHTML}</div>`)
  .replace('<div class="ds-dep-summary" id="dsDepSummary"></div>', `<div class="ds-dep-summary" id="dsDepSummary">${els.get('dsDepSummary').innerHTML}</div>`)
  .replace('>▶ Deploy</button>', `>${els.get('dsRecRunBtn').textContent}</button>`).replace('id="dsRecRunBtn" disabled', 'id="dsRecRunBtn"');
writeFileSync(ROOT + '_preview_deploy.html', `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="studio.css"></head>
<body class="${dark ? 'sftk-dark dark' : ''}"><div id="app"><div class="ds-layout" style="display:flex"><main class="ds-main" id="dsMain" style="flex:1">${html}</main></div></div></body></html>`);
console.log('preview written');
