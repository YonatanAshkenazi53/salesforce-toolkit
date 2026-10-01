// ── Org health (campaign 3, phase 8) ─────────────────────────────────────
// The tools already know the answers; this page shows them together, for ONE
// org: one card per finding, each a jump into the tool that fixes it.
//
// The rules every card follows (the budget-first rule of the whole product):
//   · nothing is read until the user presses Check (or Check all);
//   · the card says what a check costs BEFORE it runs (≈N API calls, and the
//     org's remaining daily budget when the meter can be read);
//   · a result says WHEN it was computed and is kept on this PC per org
//     (chrome.storage `sftk_orghealth`, cleared by History → 🧹 Clear cached
//     org data), so the page opens on the last answers without reading;
//   · a check that fails says so — never "all good".
//
// A card is data (OH_CARDS below):
//   { id, icon, title, what,
//     calls(ctx) → number                       the estimate shown before Check
//     run(sess, ctx) → { tone: 'good'|'warn'|'bad', headline, lines: [text],
//                        fix?: { label, popupTab? | view? } } }
// ctx = { orgUrl, orgKey, input }. `lines` are plain text (escaped when painted),
// at most OH_MAX_LINES shown. `fix.popupTab` opens the Toolkit on that tab as a
// page (popup.html?tab=…), `fix.view` switches Data Studio to that view.
// Optional:
//   input: { label, placeholder, default }  a one-line text input on the card
//          (e.g. the object to check); its value is ctx.input, kept with the
//          result so the card says what it was computed for.
//   calls(ctx) may return a STRING formula ("2 + 1 per 100 fields") when the
//          exact count depends on what the org holds — still shown before Check.

const OH_STORE_KEY = 'sftk_orghealth';
const OH_MAX_LINES = 8;
let _ohOrg = '';          // the org this page is looking at
let _ohBusy = new Set();  // card ids checking right now
let _ohBudgetToken = 0;
const _ohInputs = {};     // cardId → the text in its input (cards with `input`)

function _ohCtx(card) {
  return { orgUrl: _ohOrg, orgKey: _orgKey(_ohOrg), input: card && card.input ? (_ohInputs[card.id] ?? card.input.default ?? '') : '' };
}

// PURE. The estimate a card shows: a number → "≈N API call(s)", a formula → "≈<formula>".
function sftkOhCallsText(n) {
  return typeof n === 'number' ? `≈${n} API call${n === 1 ? '' : 's'}` : `≈${String(n)} API calls`;
}

// PURE. The tone of a licence table: any licence at its cap → bad, any at
// 90 % or more → warn, else good. rows: [{ Name, TotalLicenses, UsedLicenses }].
function sftkOhLicenceVerdict(rows) {
  const list = (rows || []).filter(r => r && Number(r.TotalLicenses) > 0);
  const full = list.filter(r => Number(r.UsedLicenses) >= Number(r.TotalLicenses));
  const near = list.filter(r => Number(r.UsedLicenses) < Number(r.TotalLicenses) && Number(r.UsedLicenses) / Number(r.TotalLicenses) >= 0.9);
  const line = r => `${r.Name}: ${Number(r.UsedLicenses)} of ${Number(r.TotalLicenses)} used${Number(r.UsedLicenses) >= Number(r.TotalLicenses) ? ' — full' : ''}`;
  if (!list.length) return { tone: 'good', headline: 'No licence with seats to count', lines: [] };
  return {
    tone: full.length ? 'bad' : near.length ? 'warn' : 'good',
    headline: full.length ? `${full.length} licence type(s) at the cap — nobody new can be given them`
      : near.length ? `${near.length} licence type(s) at 90 % or more` : `Every licence type has seats free (${list.length} checked)`,
    lines: [...full, ...near].map(line),
  };
}

// PURE. Active users who have not logged in for 90 days (or never) — each of
// them holds a licence. rows: [{ Name, Username, LastLoginDate, Profile }].
function sftkOhIdleVerdict(rows, capped) {
  const list = rows || [];
  if (!list.length) return { tone: 'good', headline: 'Every active user logged in within the last 90 days', lines: [] };
  const when = r => r.LastLoginDate ? `last login ${String(r.LastLoginDate).slice(0, 10)}` : 'never logged in';
  const lic = r => (r.Profile && r.Profile.UserLicense && r.Profile.UserLicense.Name) ? ` · ${r.Profile.UserLicense.Name}` : '';
  return {
    tone: 'warn',
    headline: `${capped ? `${list.length}+` : list.length} active user(s) have not logged in for 90 days — each holds a licence`,
    lines: list.map(r => `${r.Name} (${r.Username}) — ${when(r)}${lic(r)}`),
  };
}

// PURE. Flows ⏻ Flow switches turned off and remembered, against what the org
// says now. remembered: { apiName: versionNumber }; activeNow: Map(apiName →
// bool) or null when the org could not be read.
function sftkOhFlowsOffVerdict(remembered, activeNow) {
  const names = Object.keys(remembered || {});
  if (!names.length) return { tone: 'good', headline: 'No flow is waiting to be switched back on (none switched off with ⏻ Flow switches)', lines: [] };
  const stillOff = names.filter(n => activeNow && activeNow.get(n) === false);
  const unknown = names.filter(n => !activeNow || !activeNow.has(n));
  const lines = [...stillOff.map(n => `${n} — off; ▶ Switch ON restores v${remembered[n]}`),
                 ...unknown.map(n => `${n} — not found in the org any more (deleted or renamed)`)];
  if (!stillOff.length && !unknown.length) return { tone: 'good', headline: `The ${names.length} flow(s) switched off earlier are active again`, lines: [] };
  return { tone: 'warn', headline: `${stillOff.length} flow(s) switched off with ⏻ Flow switches are still off`, lines };
}

// ── The four cards added after the first three (campaign 3, phase 8b) ─────
// Every judgement below is a PURE function of what was read (tests extract them);
// a read that failed never reaches them as "nothing found" — the card throws first.

// PURE. The object name a card may put into a URL or a SOQL FROM clause: an API
// name and nothing else. Returns the trimmed name or '' (never a partial).
function sftkOhObjectName(input) {
  const s = String(input == null ? '' : input).trim();
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(s) ? s : '';
}

// PURE. A failed/incomplete read of a list → the error text to throw, else ''.
// `incomplete` is background.js's own "the pager lost rows" marker.
function sftkOhReadProblem(r) {
  if (!r) return 'no answer';
  if (r.error) return String(r.error);
  if (r.incomplete) return `Salesforce says ${r.incomplete.expected} row(s) match but only ${r.incomplete.got} arrived`;
  return '';
}

// PURE. Active flows pinned 3+ releases below the org's own release.
// max: sftkApiVerMax(...) → { version, num, label }; records: Tooling Flow rows
// [{ ApiVersion, Definition: { DeveloperName, NamespacePrefix } }].
// Packaged flows (a namespace) are the publisher's to change — counted, never listed.
function sftkOhApiVerVerdict(max, records) {
  const list = Array.isArray(records) ? records : [];
  const own = list.filter(r => r && !(r.Definition && r.Definition.NamespacePrefix));
  const packaged = list.filter(r => r).length - own.length;
  const behind = [];
  let unreadable = 0;
  for (const r of own) {
    const lag = sftkApiVerLag(r.ApiVersion, max.version);
    if (lag == null) { unreadable++; continue; }
    if (lag >= 3) behind.push({ name: (r.Definition && r.Definition.DeveloperName) || r.Id || '(unnamed)', api: sftkApiVerNum(r.ApiVersion), lag });
  }
  behind.sort((a, b) => b.lag - a.lag || String(a.name).localeCompare(String(b.name)));
  const lines = behind.map(b => `${b.name} — API ${b.api} · ${b.lag} releases behind`);
  if (unreadable) lines.push(`${unreadable} active flow(s) have no readable API version — not judged`);
  if (packaged) lines.push(`${packaged} active flow(s) come from installed packages — only the publisher can change their API version, not counted`);
  const release = `${max.label || 'this release'}, API ${max.version}`;
  if (behind.length) {
    return { tone: 'warn', headline: `${behind.length} active flow(s) pinned 3 or more releases below this org's release (${release})`, lines };
  }
  if (unreadable) {
    return { tone: 'warn', headline: `No judged flow is 3 or more releases behind (${release}), but ${unreadable} could not be judged — NOT an all-clear`, lines };
  }
  return { tone: 'good', headline: own.length
    ? `No active flow of yours is 3 or more releases behind this org's release (${release}) — ${own.length} checked`
    : 'This org has no active flow of its own to check', lines };
}

// PURE. Normalise a SF_COMPOSITE_BATCH answer into one slot per requested path:
// { ok, body, error } for an item that was really answered, null for a slot the
// batch could not answer (a dead call, a short array, a batchError item) — the
// caller re-reads those one at a time, it never treats them as empty.
function sftkOhBatchItems(res, n) {
  const out = new Array(n).fill(null);
  if (!Array.isArray(res) || res.length !== n) return out;
  for (let i = 0; i < n; i++) {
    const it = res[i];
    if (!it || it.batchError) continue;
    out[i] = { ok: !!it.ok, body: it.body, error: it.ok ? undefined : (it.error || 'read failed') };
  }
  return out;
}

// PURE. The org-default verdict for ONE page out of ONE sObject describe — the
// matching of lightning-pages.js `lpOrgDefaultsFromDescribe` (a test pins that
// the two agree on the same payloads), plus the rule the Lightning Pages tool
// keeps in `_lpProbeFailed`: a describe that ERRORED or carried no actionOverrides
// array did not answer, and "did not answer" is never "not the org default".
// → { answered, isDefault, error }.
function sftkOhPageDescribeVerdict(descRes, pageId, devName, pages) {
  const res = descRes || { error: 'no describe result' };
  if (res.error || !Array.isArray(res.actionOverrides)) {
    return { answered: false, isDefault: false, error: String(res.error || 'the describe carried no action overrides') };
  }
  const all = Array.isArray(pages) ? pages : [];
  const devLower = String(devName || '').toLowerCase();
  const devShort = devLower.includes('-') ? devLower.split('-').slice(1).join('-') : devLower;
  const pidLower = String(pageId || '').toLowerCase();
  const hit = res.actionOverrides.some(o => {
    if ((o.name || '').toLowerCase() !== 'view') return false;
    if (!o.pageId) return false;
    const oPid = String(o.pageId).toLowerCase();
    const oPid15 = oPid.substring(0, 15);
    if (pidLower && (oPid === pidLower || oPid === pidLower.substring(0, 15) || pidLower.startsWith(oPid15))) return true;
    const matched = all.find(p => {
      const pId = String((p && p.Id) || '').toLowerCase();
      return pId === oPid || pId.startsWith(oPid15) || oPid.startsWith(pId.substring(0, 15));
    });
    if (!matched) return false;
    const mpDev = String(matched.DeveloperName || '').toLowerCase();
    return mpDev === devLower || mpDev === devShort;
  });
  return { answered: true, isDefault: hit, error: '' };
}

// PURE. One Lightning page → 'assigned' | 'unassigned' | 'unread'.
// { metaOk, metaError, assignments (count in the page's own metadata),
//   needsProbe (the page sits on an object, so its org-default must be looked up),
//   probe (sftkOhPageDescribeVerdict result, or null when no describe was read) }.
// 'unassigned' only when EVERY read that could show an assignment answered and
// found none — the same rule as the Lightning Pages tool's "Not assigned".
function sftkOhPageState(x) {
  const s = x || {};
  if (!s.metaOk) return { state: 'unread', why: `its assignments could not be read (${s.metaError || 'read failed'})` };
  if (Number(s.assignments) > 0) return { state: 'assigned', why: '' };
  if (!s.needsProbe) return { state: 'unassigned', why: '' };
  if (!s.probe) return { state: 'unread', why: "its object could not be described, so its org-default was not looked up" };
  if (s.probe.isDefault) return { state: 'assigned', why: '' };
  if (!s.probe.answered) return { state: 'unread', why: `its object's org-default check failed (${s.probe.error || 'no answer'})` };
  return { state: 'unassigned', why: '' };
}

// PURE. Lightning pages assigned to nobody. rows: [{ label, type, object, managed, state, why }]
// (state from sftkOhPageState); notJudged: pages of types that have no assignment
// concept here (Flow / Login pages), counted and said.
function sftkOhPagesVerdict(rows, notJudged) {
  const list = Array.isArray(rows) ? rows : [];
  const nobody = list.filter(r => r.state === 'unassigned').sort((a, b) => String(a.label).localeCompare(String(b.label)));
  const unread = list.filter(r => r.state === 'unread').sort((a, b) => String(a.label).localeCompare(String(b.label)));
  const kind = r => `${r.type || 'page'}${r.object ? ` · ${r.object}` : ''}${r.managed ? ' · from a package' : ''}`;
  // Several pages can share one label (live 2026-09-29: three "Account Record Page") — the API name tells them apart.
  const name = r => `${r.label}${r.devName && r.devName !== r.label ? ` [${r.devName}]` : ''}`;
  const lines = [
    ...nobody.map(r => `${name(r)} (${kind(r)}) — assigned to nobody`),
    ...unread.map(r => `${name(r)} (${kind(r)}) — could not be checked: ${r.why} — NOT known to be assigned`),
  ];
  if (notJudged) lines.push(`${notJudged} Flow / Login page(s) not judged — they are assigned outside this mechanism`);
  const read = list.length - unread.length;
  if (nobody.length) {
    return { tone: 'warn', headline: `${nobody.length} Lightning page(s) are assigned to nobody${unread.length ? `; ${unread.length} more could not be checked` : ''}`, lines };
  }
  if (unread.length) {
    return { tone: 'warn', headline: `No unassigned page found among the ${read} that were read, but ${unread.length} could not be checked — NOT an all-clear`, lines };
  }
  return { tone: 'good', headline: list.length ? `Every one of the ${list.length} Lightning page(s) checked is assigned somewhere` : 'This org has no Lightning page to check', lines };
}

// PURE. Picklists of ONE object compared across the Sync Ring's orgs.
// { obj, ringCount, usable (orgs read), skipped: [{ label, skip }],
//   rows: [{ field, label, verdict (pkFieldVerdict) }], cappedNames: [], rtNotes: [] }.
// Never "in sync" while an org, a field, or the record types went unread.
function sftkOhPicklistsVerdict(inp) {
  const i = inp || {};
  const obj = i.obj || 'the object';
  const ringCount = Number(i.ringCount) || 0;
  if (ringCount < 2) {
    return { tone: 'warn', headline: 'Needs 2+ open orgs',
      lines: ['Nothing was read — picklists are compared between the orgs open in Chrome. Open at least two, then check again.'] };
  }
  const skipped = i.skipped || [], rows = i.rows || [], usable = Number(i.usable) || 0;
  const lines = skipped.map(s => `${s.label} — ${s.skip} — NOT part of this check`);
  if (usable < 2) {
    return { tone: 'warn', headline: `Only ${usable} of the ${ringCount} ring orgs could be read — there is nothing to compare`, lines };
  }
  const rank = { missing: 0, values: 1, rts: 2 };
  const stat = r => (r.verdict && r.verdict.status) || '';
  const drifting = rows.filter(r => r.verdict && r.verdict.drifting)
    .sort((a, b) => (rank[stat(a)] - rank[stat(b)]) || String(a.field).localeCompare(String(b.field)));
  const unread = rows.filter(r => stat(r) === 'error' || stat(r) === 'insufficient' || (r.verdict && (r.verdict.erroredIn || []).length));
  const notComparable = rows.filter(r => stat(r) === 'notcomparable');
  const inSync = rows.filter(r => stat(r) === 'sync').length;
  const name = r => `${r.label || r.field} (${r.field})`;
  lines.push(...drifting.map(r => `${name(r)} — ${r.verdict.label}`));
  lines.push(...unread.map(r => `${name(r)} — could not be fully read: ${r.verdict.label || 'read failed'}${(r.verdict.erroredIn || []).length ? ` (${r.verdict.erroredIn.join(', ')})` : ''} — NOT known to be in sync`));
  const capped = i.cappedNames || [];
  if (capped.length) lines.push(`${capped.length} further picklist field(s) were not read (the sweep reads 25 at a time): ${capped.slice(0, 6).join(', ')}${capped.length > 6 ? '…' : ''}`);
  for (const n of (i.rtNotes || [])) lines.push(`record types: ${n}`);
  if (notComparable.length) lines.push(`${notComparable.length} picklist(s) use a shared or standard value set — not compared field by field`);
  const incomplete = skipped.length > 0 || unread.length > 0 || capped.length > 0 || (i.rtNotes || []).length > 0;
  if (drifting.length) {
    return { tone: 'warn', headline: `${drifting.length} picklist(s) on ${obj} drift between the ${usable} ring orgs read${incomplete ? ' — and the check is incomplete' : ''}`, lines };
  }
  if (incomplete) {
    return { tone: 'warn', headline: `No drift found in what could be read on ${obj}, but the check is incomplete — NOT an all-clear`, lines };
  }
  if (!rows.length) return { tone: 'good', headline: `${obj} has no picklist field in the ${usable} ring orgs read`, lines };
  if (!inSync) return { tone: 'warn', headline: `No picklist on ${obj} could be compared field by field`, lines };
  return { tone: 'good', headline: `All ${inSync} comparable picklist(s) on ${obj} are in sync across the ${usable} ring orgs`, lines };
}

// PURE. Why a custom field cannot have its filled rows counted (or '' when it can).
// f: a describe field. COUNT(field) is refused for long text, address and the like;
// formulas and auto-numbers are always "filled"; a checkbox is never empty.
function sftkOhFieldCountable(f) {
  if (!f) return 'not described';
  if (f.compoundFieldName) return 'part of a compound field';
  if (f.calculated) return 'formula';
  if (f.autoNumber) return 'auto-number';
  if (f.type === 'boolean') return 'checkbox (never empty)';
  if (f.filterable === false) return 'not filterable';
  if (f.aggregatable === false) return 'not aggregatable';
  if (['textarea', 'address', 'location', 'base64', 'encryptedstring', 'complexvalue', 'anyType'].includes(f.type)) return `${f.type} field`;
  return '';
}

// PURE. SELECT COUNT(f1) c0, COUNT(f2) c1 … FROM <obj>. Names come from the describe.
function sftkOhFillQuery(obj, names) {
  return `SELECT ${names.map((n, i) => `COUNT(${n}) c${i}`).join(', ')} FROM ${obj}`;
}

// PURE. MetadataComponentDependency is capped at 2,000 rows and stops silently:
// a full page may be a truncated one (Field Cleaner's fcLooksCapped rule).
function sftkOhLooksCapped(n) {
  const k = Number(n);
  return Number.isFinite(k) && k > 0 && k % 2000 === 0;
}

// PURE. Custom fields of ONE object with no data and no references.
// { obj, records (COUNT() of the object), custom (custom fields the org has),
//   fields: [{ name, label, type, state, filled, refs, why }] } where state is
//   'unused' (0 filled, 0 refs) | 'empty-referenced' | 'filled' | 'skipped' | 'unread'.
// hidden: fields the Tooling list has but the describe does not show (FLS).
function sftkOhFieldsVerdict(inp) {
  const i = inp || {};
  const obj = i.obj || 'the object';
  const fields = i.fields || [];
  const hidden = Number(i.hidden) || 0;
  if (Number(i.records) === 0) {
    return { tone: 'warn', headline: `${obj} has no records — every field is 0-filled, so none is listed as unused`,
      lines: [`${fields.length} custom field(s) not judged: with no data there is nothing to tell an unused field from a new one.`] };
  }
  const unused = fields.filter(f => f.state === 'unused').sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const unread = fields.filter(f => f.state === 'unread');
  const skipped = fields.filter(f => f.state === 'skipped').length;
  const refd = fields.filter(f => f.state === 'empty-referenced').length;
  const judged = fields.filter(f => f.state !== 'skipped' && f.state !== 'unread').length;
  const lines = [
    ...unused.map(f => `${f.name} (${f.label}, ${f.type}) — never filled, nothing references it`),
    ...unread.map(f => `${f.name} — could not be checked: ${f.why} — NOT known to be unused`),
  ];
  if (hidden) lines.push(`${hidden} custom field(s) exist in the org but the describe does not list them (field-level security) — not judged`);
  if (refd) lines.push(`${refd} more field(s) hold no data but are referenced — not listed`);
  if (skipped) lines.push(`${skipped} field(s) not judged (formula, auto-number, checkbox, long text and the like)`);
  const caveat = 'the dependency index does not cover Lightning pages, list views or reports — open Field Cleaner before deleting';
  const incomplete = unread.length > 0 || hidden > 0;
  if (unused.length) {
    return { tone: 'warn', headline: `${unused.length} custom field(s) on ${obj} hold no data and have no reference in the dependency index (${caveat})${incomplete ? '; some could not be checked' : ''}`, lines };
  }
  if (incomplete) {
    return { tone: 'warn', headline: `No unused custom field found among those checked on ${obj}, but some could not be checked — NOT an all-clear`, lines };
  }
  if (!Number(i.custom)) return { tone: 'good', headline: `${obj} has no custom fields`, lines };
  return { tone: 'good', headline: judged
    ? `Every one of the ${judged} custom field(s) judged on ${obj} holds data or is referenced`
    : `None of the ${i.custom} custom field(s) on ${obj} can have its data counted`, lines };
}

// Page types with no assignment concept in the Lightning Pages tool (its
// LP_TYPES_NO_ACTIVATION): they live in their own assignment worlds.
const OH_PAGES_NOT_JUDGED = new Set(['FlowPage', 'LoginPage']);

// N reads in one round-trip per `chunk` (SF_COMPOSITE_BATCH), the Lightning Pages
// tool's own _lpBatchRead shape: a slot the batch could not answer is re-read on
// its own, and a read that still fails comes back { ok:false, error } — never empty.
async function _ohBatchRead(sess, paths, chunk) {
  if (!paths.length) return [];
  const res = await sendBg({ type: 'SF_COMPOSITE_BATCH', orgUrl: sess.orgUrl, sid: sess.sid,
    subrequests: paths.map(p => ({ method: 'GET', url: p })), chunkSize: chunk, concurrency: 3 });
  const out = sftkOhBatchItems(res, paths.length);
  for (let i = 0; i < paths.length; i++) {
    if (out[i]) continue;
    const r = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid, path: paths[i], _silentError: true });
    out[i] = (r && r.error) ? { ok: false, body: undefined, error: r.error } : { ok: true, body: r, error: undefined };
  }
  return out;
}

// COUNT(field) for `names`, 50 per query. A query that fails is halved until the
// field that breaks it stands alone — that one is reported, the others still count.
async function _ohCountFilled(sess, obj, names, out) {
  if (!names.length) return;
  const r = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false, _silentError: true,
    query: sftkOhFillQuery(obj, names) });
  const problem = sftkOhReadProblem(r);
  const row = !problem && (r.records || [])[0];
  if (row) {
    names.forEach((n, i) => { const v = Number(row[`c${i}`]); if (Number.isFinite(v)) out.filled.set(n, v); else out.failed.set(n, 'the count came back empty'); });
    return;
  }
  if (/SESSION|REQUEST_LIMIT|LIMIT_EXCEEDED/i.test(problem)) throw new Error(problem);
  if (names.length === 1) { out.failed.set(names[0], problem); return; }
  const mid = names.length >> 1;
  await _ohCountFilled(sess, obj, names.slice(0, mid), out);
  await _ohCountFilled(sess, obj, names.slice(mid), out);
}

const OH_CARDS = [
  {
    id: 'licences', icon: '🔑', title: 'Licences at the cap',
    what: 'Every licence type with seats: how many are used. A full licence means nobody new can be given it.',
    calls: () => 1,
    async run(sess) {
      const r = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false, _silentError: true,
        query: 'SELECT Name, TotalLicenses, UsedLicenses FROM UserLicense WHERE TotalLicenses > 0 ORDER BY Name' });
      if (!r || r.error) throw new Error(r?.error || 'no answer');
      return { ...sftkOhLicenceVerdict(r.records || []), fix: { label: 'Open Licenses', popupTab: 'licenses' } };
    },
  },
  {
    id: 'idle', icon: '💤', title: 'Active users who stopped logging in',
    what: 'Active standard users (any licence) who have not logged in for 90 days, or never — each one holds a seat. Integration users, which never log in by design, are left out.',
    calls: () => 1,
    async run(sess) {
      const LIMIT = 200;
      const r = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false, _silentError: true,
        query: `SELECT Name, Username, LastLoginDate, Profile.UserLicense.Name FROM User WHERE IsActive = true AND UserType = 'Standard' AND (LastLoginDate = null OR LastLoginDate < LAST_N_DAYS:90) ORDER BY LastLoginDate ASC NULLS FIRST LIMIT ${LIMIT}` });
      if (!r || r.error) throw new Error(r?.error || 'no answer');
      // Integration licences (Analytics Cloud Integration, Salesforce Integration…)
      // belong to system users that never log in by design — live 2026-09-29 they
      // were half of the list. Left out, and said.
      const isIntegration = u => /integration/i.test(String((u.Profile && u.Profile.UserLicense && u.Profile.UserLicense.Name) || ''));
      const people = (r.records || []).filter(u => !isIntegration(u));
      const skipped = (r.records || []).length - people.length;
      const v = sftkOhIdleVerdict(people, (r.records || []).length >= LIMIT);
      if (skipped) v.lines = [...v.lines, `${skipped} user(s) on an integration licence not counted — they never log in by design`];
      return { ...v, fix: { label: 'Open Licenses', popupTab: 'licenses' } };
    },
  },
  {
    id: 'flowsoff', icon: '⏻', title: 'Flows left switched off',
    what: 'Flows switched off with ⏻ Flow switches, or paused by a deployment that did not finish, that are still off in the org (their active version is remembered on this PC).',
    calls: () => 1,
    async run(sess, ctx) {
      let remembered = {};
      try {
        const d = await chrome.storage.local.get(['sftk_flow_prev_active', 'sftk_flow_run_paused']);
        remembered = { ...((d.sftk_flow_prev_active || {})[ctx.orgKey] || {}) };
        // flows a deployment paused and never switched back on (closed tab)
        for (const [n, v] of Object.entries((d.sftk_flow_run_paused || {})[ctx.orgKey] || {})) remembered[n] = (v && v.version) || v;
      } catch (_) { remembered = {}; }
      const names = Object.keys(remembered);
      if (!names.length) return sftkOhFlowsOffVerdict({}, null);
      const lit = names.map(n => `'${String(n).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(',');
      const r = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false, _silentError: true,
        query: `SELECT ApiName, IsActive FROM FlowDefinitionView WHERE ApiName IN (${lit})` });
      if (!r || r.error) throw new Error(r?.error || 'no answer');
      const now = new Map((r.records || []).map(x => [x.ApiName, !!x.IsActive]));
      return { ...sftkOhFlowsOffVerdict(remembered, now), fix: { label: 'Open Flow switches', popupTab: 'dependencies' } };
    },
  },
  {
    id: 'apiver', icon: '🔢', title: 'Flows pinned below the org’s release',
    what: 'Your own active flows whose API version is 3 or more releases (about a year) behind the release this org runs. A flow keeps running with its old version’s behaviour. Flows from installed packages are not counted — only their publisher can change them.',
    calls: () => 2,
    async run(sess) {
      const v = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid, path: 'services/data/', _silentError: true });
      if (!v || v.error) throw new Error(v?.error || 'no answer');
      const max = sftkApiVerMax(v);
      if (!max) throw new Error('the org listed no API versions');
      const r = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true, _silentError: true,
        query: "SELECT Id, ApiVersion, Status, Definition.DeveloperName, Definition.NamespacePrefix FROM Flow WHERE Status = 'Active'" });
      const problem = sftkOhReadProblem(r);
      if (problem) throw new Error(problem);
      return { ...sftkOhApiVerVerdict(max, r.records || []), fix: { label: 'Open ⚙ API versions', popupTab: 'dependencies' } };
    },
  },
  {
    id: 'pages', icon: '📄', title: 'Lightning pages assigned to nobody',
    what: 'Lightning pages with no app, profile or record-type assignment and that are not their object’s org default. A page counts only when every read that could show an assignment answered; a page whose reads failed is listed as “could not be checked”, never as unassigned.',
    calls: () => '1 + 1 per 10 pages + 1 per 200 custom objects + 1 per 5 objects with record pages',
    async run(sess) {
      const q = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true, _silentError: true,
        query: 'SELECT Id,DeveloperName,MasterLabel,Type,EntityDefinitionId,ManageableState FROM FlexiPage ORDER BY MasterLabel' });
      const problem = sftkOhReadProblem(q);
      if (problem) throw new Error(problem);
      const all = (q.records || []).filter(p => p.Type !== 'UtilityBar');   // utility bars are out of the Lightning Pages tool
      const pages = all.filter(p => !OH_PAGES_NOT_JUDGED.has(p.Type));
      const notJudged = all.length - pages.length;
      // Pass 1 — each page's own metadata (its assignments), batched.
      const metaReads = await _ohBatchRead(sess, pages.map(p => `services/data/v62.0/tooling/sobjects/FlexiPage/${encodeURIComponent(p.Id)}`), 10);
      const metas = pages.map((p, i) => {
        const m = metaReads[i] && metaReads[i].ok ? (metaReads[i].body || {}) : null;
        const raw = m ? ((m.Metadata && m.Metadata.sobjectType) || p.EntityDefinitionId || null) : null;
        return { page: p, ok: !!m, error: metaReads[i] && metaReads[i].error, m, raw };
      });
      // Pass 2 — custom-object ids (01I…) → API names, one query per 200 ids.
      const ids = [...new Set(metas.filter(x => x.raw && /^01I/i.test(x.raw)).map(x => x.raw.substring(0, 15)))];
      const names = new Map();
      for (let i = 0; i < ids.length; i += 200) {
        const e = await sendBg({ type: 'SF_QUERY', orgUrl: sess.orgUrl, sid: sess.sid, tooling: false, _silentError: true,
          query: `SELECT DurableId, QualifiedApiName FROM EntityDefinition WHERE DurableId IN (${ids.slice(i, i + 200).map(soqlStrLit).join(',')})` });
        if (e && !e.error) for (const r of (e.records || [])) names.set(String(r.DurableId).substring(0, 15), r.QualifiedApiName);
        // a chunk that failed stays unresolved — those pages are "could not be checked"
      }
      const apiOf = x => !x.raw ? null : (/^01I/i.test(x.raw) ? (names.get(x.raw.substring(0, 15)) || null) : x.raw);
      // Pass 3 — one describe per distinct OBJECT (cache-busted, as the tool does), batched by 5.
      const objs = [...new Set(metas.filter(x => x.ok).map(apiOf).filter(Boolean))];
      const bust = Date.now();
      const descReads = await _ohBatchRead(sess, objs.map(o => `services/data/v62.0/sobjects/${encodeURIComponent(o)}/describe/?_=${bust}`), 5);
      const descOf = new Map(objs.map((o, i) => [o, descReads[i]]));
      const rows = metas.map(x => {
        const api = apiOf(x);
        const needsProbe = !!x.raw;
        let probe = null;
        if (needsProbe && api) {
          const d = descOf.get(api);
          const body = d && d.ok ? d.body : { error: (d && d.error) || 'describe not read' };
          probe = sftkOhPageDescribeVerdict(body, x.page.Id, (x.m && x.m.FullName) || x.page.DeveloperName, all);
        }
        const st = sftkOhPageState({ metaOk: x.ok, metaError: x.error, needsProbe,
          assignments: x.ok ? ((x.m.Metadata && x.m.Metadata.pageAssignments) || []).length : 0, probe });
        return { label: x.page.MasterLabel || x.page.DeveloperName, devName: x.page.DeveloperName || '', type: x.page.Type, object: api || (x.raw ? '(object not named)' : ''),
          managed: (x.page.ManageableState || 'unmanaged') !== 'unmanaged', state: st.state, why: st.why };
      });
      return { ...sftkOhPagesVerdict(rows, notJudged), fix: { label: 'Open Lightning Pages', popupTab: 'pages' } };
    },
  },
  {
    id: 'picklists', icon: '📋', title: 'Picklists drifting between your open orgs',
    what: 'One object’s picklist fields (up to 25) compared across every org open in Chrome — values, labels, active state, defaults and record-type assignments — the Picklist Manager’s own sweep, read-only. Every org compared must be open in a Chrome tab; an org that is not is named and the result is never “in sync”.',
    input: { label: 'Object', placeholder: 'Account', default: 'Account' },
    calls: () => {
      const n = (typeof _ring === 'object' && _ring && (_ring.orgs || []).length) || 0;
      return n >= 2 ? `${n} orgs × (2 + 2 per custom picklist field + 1 per record type, up to 25 fields and 8 record types)` : 0;
    },
    async run(sess, ctx) {
      const obj = sftkOhObjectName(ctx.input);
      if (!obj) throw new Error('type an object API name (for example Account or MyObject__c)');
      const ringUrls = (typeof _ring === 'object' && _ring && _ring.orgs) || [];
      const ringFix = { label: 'Open the All open orgs page', view: 'ring' };
      if (ringUrls.length < 2) return { ...sftkOhPicklistsVerdict({ obj, ringCount: ringUrls.length }), fix: ringFix };
      const orgs = await _pkSweepOpenOrgs(ringUrls, obj);
      const usable = orgs.filter(o => o.sess && o.desc);
      const skipped = orgs.filter(o => o.skip).map(o => ({ label: o.label, skip: o.skip }));
      const base = { obj, ringCount: ringUrls.length, usable: usable.length, skipped };
      const fix = { label: 'Open Picklist Manager', view: 'picklists' };
      if (usable.length < 2) return { ...sftkOhPicklistsVerdict(base), fix };
      const { srcOrg } = _pkSweepPickSource(usable);
      const allFields = _pkSweepFieldUnion(usable, srcOrg);
      const FIELD_CAP = 25;                                   // the sweep's own cap
      const fields = allFields.slice(0, FIELD_CAP);
      const cappedNames = allFields.slice(FIELD_CAP).map(f => f.name);
      const rtBundles = {};
      if (fields.length) {
        await Promise.all(usable.map(async o => {
          try { rtBundles[o.orgKey] = await _pkLoadRtBundle(o.sess, obj); }
          catch (e) { rtBundles[o.orgKey] = { rts: [], note: `record types unavailable (${e.message}) — RT drift NOT checked here` }; }
        }));
      }
      const rtNotes = usable.filter(o => rtBundles[o.orgKey] && rtBundles[o.orgKey].note).map(o => `${o.label} — ${rtBundles[o.orgKey].note}`);
      const rows = [];
      for (const f of fields) {
        const perOrg = [], perRts = [];
        await Promise.all(usable.map(async (o, oi) => {
          const r = await _pkSweepReadField(o, obj, f.name, rtBundles[o.orgKey]);
          perOrg[oi] = r.inv; perRts[oi] = r.rts;
        }));
        rows.push({ field: f.name, label: f.label, verdict: pkFieldVerdict(perOrg, perRts, f.name) });
      }
      return { ...sftkOhPicklistsVerdict({ ...base, rows, cappedNames, rtNotes }), fix };
    },
  },
  {
    id: 'fields', icon: '🧹', title: 'Custom fields with no data and no references',
    what: 'One object’s custom fields that no record fills and that nothing in the dependency index references. The index does not cover Lightning pages, list views or reports, so treat the list as candidates and check them in Field Cleaner before deleting. Formula, auto-number, checkbox and long-text fields cannot be counted and are not judged.',
    input: { label: 'Object', placeholder: 'Account', default: 'Account' },
    calls: () => '3 + 1 per 50 custom fields + 1 per 100 empty fields',
    async run(sess, ctx) {
      const obj = sftkOhObjectName(ctx.input);
      if (!obj) throw new Error('type an object API name (for example Account or MyObject__c)');
      const fix = { label: 'Open Field Cleaner', popupTab: 'fields' };
      const d = await sendBg({ type: 'SF_REST_GET', orgUrl: sess.orgUrl, sid: sess.sid, _silentError: true, path: `services/data/v62.0/sobjects/${obj}/describe` });
      if (!d || d.error) throw new Error(`${obj} could not be described — ${(d && d.error) || 'no answer'}`);
      // The CustomField ids (the dependency index is keyed by them). EntityDefinition.QualifiedApiName
      // stands for "TableEnumOrId = the API name (standard object) or the entity id (custom object)"
      // in ONE query — checked live on a standard and a custom object.
      const cf = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true, _silentError: true,
        query: `SELECT Id, DeveloperName, NamespacePrefix, TableEnumOrId FROM CustomField WHERE EntityDefinition.QualifiedApiName = ${soqlStrLit(obj)}` });
      const cfProblem = sftkOhReadProblem(cf);
      if (cfProblem) throw new Error(`the custom fields could not be listed — ${cfProblem}`);
      const idOf = new Map((cf.records || []).map(r => [`${r.NamespacePrefix ? `${r.NamespacePrefix}__` : ''}${r.DeveloperName}__c`, r.Id]));
      const customs = (d.fields || []).filter(f => f.custom);
      const described = new Set(customs.map(f => f.name));
      const hidden = [...idOf.keys()].filter(n => !described.has(n)).length;
      const total = await sendBg({ type: 'SF_REST_QUERY', orgUrl: sess.orgUrl, sid: sess.sid, _silentError: true, query: `SELECT COUNT() FROM ${obj}` });
      if (!total || total.error) throw new Error(`${obj} records could not be counted — ${(total && total.error) || 'no answer'}`);
      const records = Number(total.totalSize) || 0;
      const list = customs.map(f => ({ name: f.name, label: f.label, type: f.type, id: idOf.get(f.name) || '',
        state: 'unread', filled: null, refs: null, why: '', skip: idOf.has(f.name) ? sftkOhFieldCountable(f) : (sftkOhFieldCountable(f) || 'no CustomField record') }));
      list.forEach(f => { if (f.skip) { f.state = 'skipped'; f.why = f.skip; } });
      if (records === 0) return { ...sftkOhFieldsVerdict({ obj, records, custom: customs.length, fields: list, hidden }), fix };
      // fill counts — 50 per query
      const countable = list.filter(f => f.state === 'unread');
      const out = { filled: new Map(), failed: new Map() };
      for (let i = 0; i < countable.length; i += 50) await _ohCountFilled(sess, obj, countable.slice(i, i + 50).map(f => f.name), out);
      for (const f of countable) {
        if (out.filled.has(f.name)) { f.filled = out.filled.get(f.name); f.state = f.filled > 0 ? 'filled' : 'empty'; }
        else f.why = `its filled rows could not be counted — ${out.failed.get(f.name) || 'no answer'}`;
      }
      // references — only for the empty ones, 100 ids per query
      const empty = list.filter(f => f.state === 'empty');
      for (let i = 0; i < empty.length; i += 100) {
        const chunk = empty.slice(i, i + 100);
        const r = await sendBg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true, _silentError: true,
          query: `SELECT MetadataComponentName, MetadataComponentType, RefMetadataComponentId FROM MetadataComponentDependency WHERE RefMetadataComponentId IN (${chunk.map(f => soqlStrLit(f.id)).join(',')})` });
        const problem = sftkOhReadProblem(r) || (sftkOhLooksCapped((r.records || []).length) ? 'the dependency index answered with a full page (2,000 rows) and may be truncated' : '');
        if (problem) { chunk.forEach(f => { f.state = 'unread'; f.why = `its references could not be read — ${problem}`; }); continue; }
        const refs = new Map();
        for (const x of (r.records || [])) { const k = String(x.RefMetadataComponentId).substring(0, 15); refs.set(k, (refs.get(k) || 0) + 1); }
        for (const f of chunk) { f.refs = refs.get(String(f.id).substring(0, 15)) || 0; f.state = f.refs ? 'empty-referenced' : 'unused'; }
      }
      return { ...sftkOhFieldsVerdict({ obj, records, custom: customs.length, fields: list, hidden }), fix };
    },
  },
];

async function _ohLoad() {
  try { return (await chrome.storage.local.get(OH_STORE_KEY))[OH_STORE_KEY] || {}; } catch (_) { return {}; }
}
async function _ohSave(orgKey, cardId, result) {
  const all = await _ohLoad();
  all[orgKey] = { ...(all[orgKey] || {}), [cardId]: result };
  try { await chrome.storage.local.set({ [OH_STORE_KEY]: all }); } catch (_) { /* shown, just not kept */ }
}

function _ohCardHtml(card, res, ctx) {
  const busy = _ohBusy.has(card.id);
  const tone = res ? (res.error ? 'warn' : res.tone) : '';
  const cls = tone === 'good' ? ' ds-rec-card-good' : tone === 'warn' ? ' ds-rec-card-warn' : tone === 'bad' ? ' ds-rec-card-bad' : '';
  const n = card.calls(ctx);
  const input = card.input ? `<div class="ds-rec-card-line"><label>${esc(card.input.label)} <input class="ds-input ds-input-sm" data-oh-input="${esc(card.id)}" value="${esc(ctx.input)}" placeholder="${esc(card.input.placeholder || '')}" style="max-width:220px"></label></div>` : '';
  const lines = res ? (res.lines || []) : [];
  const body = !res ? '<div class="ds-rec-card-line ds-subtext">Not checked yet for this org — press Check.</div>'
    : `<div class="ds-rec-card-line"><b>${esc(res.error ? `Could not be checked — ${res.error}` : res.headline)}</b></div>
       ${lines.slice(0, OH_MAX_LINES).map(l => `<div class="ds-rec-card-line">· ${esc(l)}</div>`).join('')}
       ${lines.length > OH_MAX_LINES ? `<div class="ds-rec-card-line ds-subtext">… and ${lines.length - OH_MAX_LINES} more</div>` : ''}
       <div class="ds-rec-card-line ds-subtext">Checked ${esc(timeAgo(res.at))}${res.error ? ' — this is NOT an all-clear' : ''}</div>`;
  const fix = res && !res.error && res.fix && res.tone !== 'good'
    ? `<button class="ds-btn ds-btn-xs" data-oh-fix="${esc(card.id)}">${esc(res.fix.label)} ↗</button>` : '';
  return `<div class="ds-rec-card${cls}" data-oh-card="${esc(card.id)}">
    <div class="ds-rec-card-hd"><span class="ds-rec-card-ico">${window.sftkGlyph ? window.sftkGlyph(card.icon, '') : esc(card.icon)}</span><span class="ds-rec-card-title">${esc(card.title)}</span>
      <span class="ds-rec-card-hint">${esc(sftkOhCallsText(n))}</span></div>
    <div class="ds-rec-card-line ds-subtext">${esc(card.what)}</div>
    ${input}
    ${res && res.input ? `<div class="ds-rec-card-line ds-subtext">for ${esc(res.input)}</div>` : ''}
    ${body}
    <div class="ds-rec-card-line"><button class="ds-btn ds-btn-xs ds-btn-primary" data-oh-check="${esc(card.id)}" ${busy || !_ohOrg ? 'disabled' : ''}>${busy ? '⏳ checking…' : res ? '↻ Check again' : 'Check'}</button> ${fix}</div>
  </div>`;
}

async function renderOrgHealth() {
  const orgs = (typeof allMapOrgs === 'function' ? allMapOrgs() : []);
  const live = (typeof _liveOrgSet === 'function') ? _liveOrgSet() : null;
  if (!_ohOrg || !orgs.some(o => o.url === _ohOrg)) {
    const firstLive = orgs.find(o => !live || [...live].some(u => _orgKey(u) === _orgKey(o.url)));
    _ohOrg = firstLive ? firstLive.url : (orgs[0] ? orgs[0].url : '');
  }
  const ctx = _ohCtx(null);
  const stored = (await _ohLoad())[ctx.orgKey] || {};
  const est = OH_CARDS.map(c => c.calls(_ohCtx(c)));
  const total = est.reduce((t, n) => t + (typeof n === 'number' ? n : 0), 0);
  const plus = est.some(n => typeof n !== 'number') ? '+' : '';
  setMain(`${dsViewHeader({ icon: 'chart', title: `Org health`,
      subtitle: 'What the tools already know about one org, together — each card jumps into the tool that fixes it. Nothing is read until you press Check.',
      count: `${OH_CARDS.length} checks` })}
    <div class="ds-op-banner ds-op-banner-read">Read-only — this never modifies any data</div>
    <div class="ds-rec-card">
      <div class="ds-rec-card-hd"><span class="ds-rec-card-title">Org</span>
        <select id="dsOhOrg" class="ds-select ds-select-sm" style="max-width:340px">${orgs.map(o => `<option value="${esc(o.url)}" ${o.url === _ohOrg ? 'selected' : ''}>${esc(typeof orgOptionLabel === 'function' ? orgOptionLabel(o.url, o.label) : (o.label || o.url))}</option>`).join('')}</select>
        <button class="ds-btn ds-btn-sm ds-btn-primary" id="dsOhAll" ${!_ohOrg || _ohBusy.size ? 'disabled' : ''}>Check all</button></div>
      <div class="ds-rec-card-line" id="dsOhBudget">≈${total}${plus} API calls for all ${OH_CARDS.length} checks</div>
      ${!orgs.length ? '<div class="ds-rec-card-line">No org is connected yet — open one in a Salesforce tab.</div>' : ''}
    </div>
    <div id="dsOhCards">${OH_CARDS.map(c => _ohCardHtml(c, stored[c.id], _ohCtx(c))).join('')}</div>`);
  _ohWire(ctx, total, plus, est.filter(n => typeof n !== 'number').length);
}

function _ohWire(ctx, total, plus, plusN) {
  eid('dsOhOrg')?.addEventListener('change', e => { _ohOrg = e.target.value; renderOrgHealth(); });
  eid('dsOhAll')?.addEventListener('click', async () => {
    for (const c of OH_CARDS) await _ohCheck(c.id);
  });
  document.querySelectorAll('[data-oh-check]').forEach(b => b.addEventListener('click', () => _ohCheck(b.dataset.ohCheck)));
  document.querySelectorAll('[data-oh-input]').forEach(i => i.addEventListener('input', () => { _ohInputs[i.dataset.ohInput] = i.value.trim(); }));
  document.querySelectorAll('[data-oh-fix]').forEach(b => b.addEventListener('click', async () => {
    const res = ((await _ohLoad())[ctx.orgKey] || {})[b.dataset.ohFix];
    const fix = res && res.fix;
    if (!fix) return;
    if (fix.view) navigateToView(fix.view);
    else if (fix.popupTab) chrome.tabs.create({ url: chrome.runtime.getURL(`popup.html?tab=${encodeURIComponent(fix.popupTab)}`) });
  }));
  // the budget meter, after the estimate is already on screen
  const token = ++_ohBudgetToken;
  (async () => {
    if (!ctx.orgUrl || typeof window.sftkApiBudget !== 'function' || typeof window.sftkApiBudgetLine !== 'function') return;
    const sess = await getOrgSession(ctx.orgUrl);
    const budget = sess ? await window.sftkApiBudget(sess.orgUrl, sess.sid) : null;
    if (token !== _ohBudgetToken) return;
    const el = eid('dsOhBudget');
    if (!el) return;
    const line = window.sftkApiBudgetLine({ total, known: true }, [{ label: orgLabel(ctx.orgUrl), budget, calls: total }]);
    el.textContent = `For all ${OH_CARDS.length} checks${plus ? ` (${plusN} of them depend on what the org holds, so more than this)` : ''}: ${line.text.replace(/^≈(\d[\d,]*)/, plus ? '≈$1+' : '≈$1')}`;
    el.style.color = line.warn ? '#b45309' : '';
  })().catch(() => {});
}

async function _ohCheck(cardId) {
  const card = OH_CARDS.find(c => c.id === cardId);
  if (!card || _ohBusy.has(cardId) || !_ohOrg) return;
  const ctx = _ohCtx(card);
  const sess = await getOrgSession(ctx.orgUrl);
  if (!sess) { showToast(`${orgLabel(ctx.orgUrl)} is not open in a Chrome tab — open it, then check again`, 'warning', 6000); return; }
  _ohBusy.add(cardId);
  _ohRepaint(card, ctx);
  let result;
  try {
    const r = await card.run(sess, ctx);
    result = { ...r, at: new Date().toISOString(), ...(ctx.input ? { input: ctx.input } : {}) };
  } catch (e) {
    result = { error: (e && e.message) || String(e), at: new Date().toISOString() };
  }
  _ohBusy.delete(cardId);
  await _ohSave(ctx.orgKey, cardId, result);
  if (_currentView === 'orghealth' && _ohOrg === ctx.orgUrl) _ohRepaint(card, ctx, result);
}

async function _ohRepaint(card, ctx, result) {
  const host = document.querySelector(`[data-oh-card="${card.id}"]`);
  if (!host) return;
  const res = result || ((await _ohLoad())[ctx.orgKey] || {})[card.id];
  host.outerHTML = _ohCardHtml(card, res, _ohCtx(card));
  document.querySelector(`[data-oh-card="${card.id}"] [data-oh-input]`)?.addEventListener('input', e => { _ohInputs[card.id] = e.target.value.trim(); });
  const fresh = document.querySelector(`[data-oh-card="${card.id}"]`);
  fresh?.querySelector('[data-oh-check]')?.addEventListener('click', () => _ohCheck(card.id));
  fresh?.querySelector('[data-oh-fix]')?.addEventListener('click', () => {
    const fix = res && res.fix;
    if (!fix) return;
    if (fix.view) navigateToView(fix.view);
    else if (fix.popupTab) chrome.tabs.create({ url: chrome.runtime.getURL(`popup.html?tab=${encodeURIComponent(fix.popupTab)}`) });
  });
  const all = eid('dsOhAll');
  if (all) all.disabled = !_ohOrg || _ohBusy.size > 0;
}

if (typeof window !== 'undefined') window.renderOrgHealth = renderOrgHealth;
