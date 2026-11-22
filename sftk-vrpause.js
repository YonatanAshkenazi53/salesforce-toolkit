// ── Pause validation rules during a deployment (campaign 4 phase 4) ────────
// User 2026-10-01: "maybe we should add a switch for validation rules" /
// "ofc we have to turn on validation rules … after deployment is done, in any
// case". Salesforce has a header that bypasses duplicate rules; validation
// rules have none. The only way is the sftk-flowpause.js way: an OPTION on the
// Deploy page, off by default:
//   1. list the ACTIVE validation rules on the objects the deployment writes,
//      in the TARGET org (rules from installed packages cannot be changed —
//      named, left alone), with each rule's own Metadata (one read per rule);
//   2. after the run's one confirmation, switch them OFF (Tooling PATCH of the
//      rule's Metadata with active:false), each re-read before it counts, and
//      remember them on this PC (`sftk_vr_run_paused`) BEFORE the run writes;
//   3. when the run ends — finished, failed or stopped — switch each back ON,
//      re-read, and forget it.
// If a rule cannot be confirmed off, the run does not start and the ones
// already off go back on. If the page closes mid-run, the memory stays and
// the Deploy page says which rules are still off, with the button.
//
// While the rules are off they are off for EVERY user of that org, not only
// for the Toolkit — the confirmation says so. Records written meanwhile are
// not validated later.
//
// Verified live 2026-10-03 (trailheads4): PATCH tooling/sobjects/ValidationRule
// /<Id> { Metadata: { …its own metadata, active: false } } → Active false on
// re-read; the same with active: true brings it back.
//
// Every write goes through sftkWriteVerified with a History journal; the
// confirmation is the run's own dialog (studio-reconcile.js runReconcile).

const SFTK_VRPAUSE_KEY = 'sftk_vr_run_paused';

function _sftkVpLit(v) { return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`; }

// A RULE FROM AN INSTALLED PACKAGE IS SWITCHED TOO (owner 2026-11-18/19, asked four times: "can we disable package
// validation rules and flows?" · "What about the package validations, etc. when doing data deployment" · "all").
// Read live 2026-11-19 (npc, the DLRS rule Not_42 — nothing was written):
//   · its Edit page in Setup locks every input EXCEPT Active — the subscriber may switch it;
//   · the Tooling API has no record of it to read or patch (GET → NOT_FOUND), so the way the org's own rules are
//     switched cannot work on it;
//   · the Metadata API reads it whole (ValidationRule "Object.ns__Rule") and ACCEPTS a check-only deploy of it with
//     <active>false</active>.
// So such a rule is listed with the others (marked pkg), read through readMetadata and switched by a deploy of
// itself with only <active> changed. The re-read that confirms the switch is the same Tooling query as for every rule.
//
// PURE. Which listed rules the Toolkit may switch: the org's own, and the rules of an installed package.
// rows: Tooling ValidationRule rows { Id, ValidationName, NamespacePrefix,
// ManageableState, EntityDefinition: { QualifiedApiName } }.
// → { own: [{ id, name, object }], managed: [label] }
function sftkVrPauseSelect(rows) {
  const own = [], managed = [];
  for (const r of (rows || [])) {
    if (!r || !r.Id || !r.ValidationName) continue;
    const object = (r.EntityDefinition && r.EntityDefinition.QualifiedApiName) || '';
    if (!object) continue;
    const ns = String(r.NamespacePrefix || '');
    if (ns) { own.push({ id: r.Id, name: `${ns}__${r.ValidationName}`, object, pkg: ns, fullName: `${object}.${ns}__${r.ValidationName}` }); continue; }
    // installed, yet without a namespace to name it by: it cannot be read through the Metadata API — named, left on
    if (r.ManageableState === 'installed') { managed.push(`${r.ValidationName} (${object})`); continue; }
    own.push({ id: r.Id, name: r.ValidationName, object });
  }
  own.sort((a, b) => a.object.localeCompare(b.object) || a.name.localeCompare(b.name));
  return { own, managed };
}

// The active validation rules on `objects` in the org of `sess`, each with its
// Metadata (needed to switch it). → { rules: [{ id, name, object, metadata }],
// managed: [label], calls } or throws.
async function sftkVrPauseList(sess, objects, send, opts) {
  const bg = typeof send === 'function' ? send : sendBg;
  const objs = [...new Set((objects || []).filter(Boolean))];
  if (!objs.length) return { rules: [], managed: [], calls: 0 };
  let calls = 1;
  const q = await bg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true, _silentError: true,
    query: `SELECT Id, ValidationName, NamespacePrefix, ManageableState, EntityDefinition.QualifiedApiName FROM ValidationRule WHERE Active = true AND EntityDefinition.QualifiedApiName IN (${objs.map(_sftkVpLit).join(',')})` });
  if (!q || q.error) throw new Error(`the org's validation rules could not be listed (${(q && q.error) || 'no answer'})`);
  const { own, managed } = sftkVrPauseSelect(q.records || []);
  const rules = [];
  // light: the names only, for the list on the page (2026-11-13: every automation is listed up front — one query,
  // not one read per rule). The definitions are read by sftkVrPauseHydrate just before a switch.
  if (opts && opts.light) return { rules: own.map(r => ({ ...r })), managed, calls, light: true };
  for (const r of own) {
    calls++;
    if (r.pkg) { rules.push({ ...r, xml: await _sftkVpReadPkg(sess, r, bg) }); continue; }
    const rec = await bg({ type: 'SF_TOOLING_GET', orgUrl: sess.orgUrl, sid: sess.sid, sobject: 'ValidationRule', id: r.id, _suppressError: true });
    if (!rec || rec.error || !rec.Metadata) throw new Error(`the definition of ${r.name} (${r.object}) could not be read (${(rec && rec.error) || 'no Metadata'}) — nothing would bring it back`);
    rules.push({ ...r, metadata: rec.Metadata });
  }
  return { rules, managed, calls };
}

// The definitions of rules listed light — read just before they are switched (nothing would bring a rule back
// without its definition). Mutates and returns the rules; throws naming the first rule that could not be read.
async function sftkVrPauseHydrate(sess, rules, send) {
  const bg = typeof send === 'function' ? send : sendBg;
  for (const r of (rules || [])) {
    if (r.metadata || r.xml) continue;
    if (r.pkg) { r.xml = await _sftkVpReadPkg(sess, r, bg); continue; }
    const rec = await bg({ type: 'SF_TOOLING_GET', orgUrl: sess.orgUrl, sid: sess.sid, sobject: 'ValidationRule', id: r.id, _suppressError: true });
    if (!rec || rec.error || !rec.Metadata) throw new Error(`the definition of ${r.name} (${r.object}) could not be read (${(rec && rec.error) || 'no Metadata'}) — nothing would bring it back`);
    r.metadata = rec.Metadata;
  }
  return rules;
}

// A packaged rule's definition, as readMetadata gives it: the inside of its <records>. Throws when it cannot be read.
async function _sftkVpReadPkg(sess, r, bg) {
  const a = await bg({ type: 'SF_MD_READ', orgUrl: sess.orgUrl, sid: sess.sid, mdType: 'ValidationRule', fullNames: [r.fullName], _suppressError: true });
  const xml = (a && !a.error) ? sftkVrPausePkgInner(a.text, r.fullName) : '';
  if (!xml) throw new Error(`the definition of ${r.name} (${r.object}) could not be read through the Metadata API (${(a && a.error) || 'it is not in the answer'}) — nothing would bring it back`);
  return xml;
}
// PURE. The inside of the <records> of `fullName` in a readMetadata answer ('' when it is not there).
function sftkVrPausePkgInner(text, fullName) {
  const src = String(text || ''), want = String(fullName || '').toLowerCase();
  const rx = /<(?:\w+:)?records\b[^>]*>([\s\S]*?)<\/(?:\w+:)?records>/g;
  for (let m; (m = rx.exec(src));) {
    const fn = /<(?:\w+:)?fullName>([^<]*)<\/(?:\w+:)?fullName>/.exec(m[1]);
    if (fn && fn[1].trim().toLowerCase() === want && /<(?:\w+:)?active>/.test(m[1])) return m[1];
  }
  return '';
}
// PURE. The two files that deploy a packaged rule as it was read, with only <active> set: its object's file holding
// that one rule (under its short name), and the package.xml naming it. → [{ name, text }]
function sftkVrPausePkgFiles(rule, active) {
  const full = String(rule.fullName || ''), dot = full.indexOf('.');
  const obj = full.slice(0, dot), short = full.slice(dot + 1);
  const inner = String(rule.xml || '')
    .replace(/<(\w+:)?fullName>[^<]*<\/(\w+:)?fullName>/, `<fullName>${short}</fullName>`)
    .replace(/<(\w+:)?active>[^<]*<\/(\w+:)?active>/, `<active>${active ? 'true' : 'false'}</active>`);
  return [
    { name: 'package.xml', text: `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata"><types><members>${full}</members><name>ValidationRule</name></types><version>62.0</version></Package>` },
    { name: `objects/${obj}.object`, text: `<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><validationRules>${inner}</validationRules></CustomObject>` },
  ];
}
// The message that switches one rule: a Tooling PATCH for the org's own, a deploy of itself for a packaged one.
function _sftkVpWriteMsg(rule, active) {
  if (rule.pkg) {
    const enc = new TextEncoder();
    // verified-by: _sftkVpSwitch's verifyAll re-read of Active (its only sender) — and, as a History undo step, the step's own re-read
    return { type: 'SF_METADATA_DEPLOY', zipBase64: sftkBuildStoredZip(sftkVrPausePkgFiles(rule, active).map(f => ({ name: f.name, data: enc.encode(f.text) }))) };
  }
  // verified-by: _sftkVpSwitch's verifyAll re-read of Active (its only sender) — and, as a History undo step, the step's own re-read
  return { type: 'SF_PATCH', path: `services/data/v62.0/tooling/sobjects/ValidationRule/${rule.id}`, body: _sftkVpBody(rule, active) };
}

async function _sftkVpMemory(mutate, orgKey) {
  let all = {};
  try { all = (await chrome.storage.local.get(SFTK_VRPAUSE_KEY))[SFTK_VRPAUSE_KEY] || {}; } catch (_) { all = {}; }
  if (typeof mutate === 'function') {
    all[orgKey] = mutate({ ...(all[orgKey] || {}) });
    if (!Object.keys(all[orgKey]).length) delete all[orgKey];
    try { await chrome.storage.local.set({ [SFTK_VRPAUSE_KEY]: all }); } catch (_) { /* the History entry still names them */ }
  }
  return all[orgKey] || {};
}

// What this PC remembers as paused by a run, still to be switched back on:
// { [ruleId]: { name, object, at } }.
async function sftkVrPausedLeftovers(orgUrl) {
  return _sftkVpMemory(null, sftkOrgKey(orgUrl));
}

function _sftkVpBody(rule, active) {
  const md = (typeof sftkMetaForPatch === 'function') ? sftkMetaForPatch(rule.metadata || {}) : { ...(rule.metadata || {}) };
  return { Metadata: { ...md, active: !!active } };
}

// PURE. After a switch-OFF pass: the rules that MAY be off although they were not confirmed off (QA 1.1, findings
// 62 and 63). They were dropped — not remembered, not restored, no leftover card — while off for every user:
//   · accepted by Salesforce, and the re-read failed or did not contain the rule (only a re-read that shows the
//     rule ON proves it is not off);
//   · a packaged rule whose deploy was submitted but not followed to its end (sfMetadataDeploy: "Deployment <id>
//     was submitted but its result could not be read … It MAY STILL FINISH") — Salesforce may still switch it off.
//   · any rule whose switch-off got NO CLEAR ANSWER (QA 1.1 regression run, finding 10): the request timed out
//     (background.js sfFetch: "Request timed out after 30 s"), the connection dropped after it was sent, the server
//     answered 5xx, or the background gave no response. Giving up on the answer does not cancel the request —
//     Salesforce may still apply it, even after a re-read that shows the rule ON. Only a definite refusal (HTTP 4xx,
//     a named Salesforce error) means nothing was switched. Switching back on a rule that never went off is harmless:
//     the switch-back sends the rule's own definition with active: true.
// results: sftkWriteVerifiedAll's, aligned with rules. → [rule]
function sftkVrPauseMaybeOff(rules, results) {
  return (rules || []).filter((r, k) => {
    const x = (results || [])[k];
    if (!x || x.ok) return false;
    if (x.accepted) return !(x.verified && x.detail && x.detail.isOn === true);
    const t = String(x.text || '');
    if (r.pkg && /was submitted|may still finish/i.test(t)) return true;
    if (/HTTP 4[0-9][0-9]/.test(t)) return false;
    return /timed out|timeout|failed to fetch|networkerror|network error|ERR_[A-Z_]+|connection|message port closed|context invalidated|no response|no answer|HTTP 5[0-9][0-9]/i.test(t);
  });
}

// One switch pass: active = wantOn for each rule, then ONE re-read of all of
// them. → { done: [rule], failed: [text], maybe: [rule] } — maybe (a switch-OFF pass only): not confirmed off, yet
// possibly off (sftkVrPauseMaybeOff).
async function _sftkVpSwitch(sess, rules, wantOn, journal, send) {
  const bg = typeof send === 'function' ? send : sendBg;
  // what the one re-read showed, by 15-character id (null: the org was not re-read, or could not be)
  let seen = null;
  // confirmed-by: runReconcile's confirmation (the ⏸ step is listed in it) or the Deploy page's ▶ Switch back on dialog
  const batch = await sftkWriteVerifiedAll(rules.map(r => ({
    describe: `${r.name} (${r.object})`,
    write: async () => {
      const a = await bg({ ..._sftkVpWriteMsg(r, wantOn), orgUrl: sess.orgUrl, sid: sess.sid, _silentError: true, _suppressError: true });
      // a deploy answers { success } or { error }; a PATCH answers its own shape — both are read by the verify below
      return (r.pkg && a && a.success === false && !a.error) ? { error: 'the deploy was not accepted' } : a;
    },
  })), {
    journal,
    verifyAll: async results => {
      // a switch-off that got no clear answer is re-read too: it may have gone through (sftkVrPauseMaybeOff)
      const unsure = wantOn ? [] : sftkVrPauseMaybeOff(rules, results);
      const ids = rules.filter((r, k) => results[k] && (results[k].accepted || unsure.includes(r))).map(r => r.id);
      if (!ids.length) return [];
      const q = await bg({ type: 'SF_QUERY_ALL', orgUrl: sess.orgUrl, sid: sess.sid, tooling: true, _silentError: true,
        query: `SELECT Id, Active FROM ValidationRule WHERE Id IN (${ids.map(_sftkVpLit).join(',')})` });
      if (!q || q.error) throw new Error((q && q.error) || 'no answer');
      const on = new Map((q.records || []).map(x => [String(x.Id).slice(0, 15), !!x.Active]));
      seen = on;
      return rules.map(r => {
        const isOn = on.get(String(r.id).slice(0, 15));
        return { ok: isOn === wantOn, detail: { isOn }, text: isOn === wantOn
          ? `${r.name} (${r.object}): switched ${wantOn ? 'back ON' : 'OFF'} — verified by re-reading the org`
          : `${r.name} (${r.object}): accepted, but the org still reads it ${isOn === undefined ? 'unknown' : isOn ? 'ON' : 'OFF'}` };
      });
    },
  });
  const maybe = wantOn ? [] : sftkVrPauseMaybeOff(rules, batch.results);
  // a switch-off Salesforce did not clearly answer: the line says it may have gone through, and what the org reads now
  const failed = [];
  batch.results.forEach((x, k) => {
    if (x.ok) return;
    if (x.accepted || !maybe.includes(rules[k])) { failed.push(x.text); return; }
    const isOn = seen ? seen.get(String(rules[k].id).slice(0, 15)) : undefined;
    failed.push(`${x.text} — it may still have gone through, so it is treated as possibly OFF (${isOn === undefined ? 'the org could not be re-read for it' : `the org reads it ${isOn ? 'ON' : 'OFF'} now`})`);
  });
  return { done: rules.filter((r, k) => batch.results[k] && batch.results[k].ok), failed, maybe };
}

// ⏸ Switch the rules off for a run. All must be confirmed off, or the ones that
// went off are switched back on at once and ok is false (the run must not start).
async function sftkVrPauseOff(sess, rules, send) {
  const orgKey = sftkOrgKey(sess.orgUrl);
  const journal = sftkHistoryBegin({ tool: 'Deploy', title: `⏸ ${rules.length} validation rule(s) paused for a deployment — ${orgLabel(sess.orgUrl)}`, orgUrl: sess.orgUrl });
  let r = { done: [], failed: [], maybe: [] };
  // every rule that is off or MAY be off: remembered, given an undo step, and switched back on if the run cannot start
  let touched = [];
  try {
    r = await _sftkVpSwitch(sess, rules, false, journal, send);
    touched = [...r.done, ...(r.maybe || [])];
    // remembered BEFORE the run writes — a closed tab must not lose them
    if (touched.length) await _sftkVpMemory(m => { for (const x of touched) m[x.id] = { name: x.name, object: x.object, at: new Date().toISOString(), ...(x.pkg ? { pkg: x.pkg, fullName: x.fullName } : {}) }; return m; }, orgKey);
  } finally {
    await sftkHistoryEnd(journal, {
      undo: touched.length ? { steps: touched.map(x => ({
        describe: `${x.name} (${x.object}): switch back ON`,
        // verified-by: sftkHistoryUndo runs this step through sftkWriteVerified with the re-read below
        msg: _sftkVpWriteMsg(x, true),
        verify: { query: `SELECT Active FROM ValidationRule WHERE Id = ${_sftkVpLit(x.id)}`, tooling: true, pick: 'records.0', field: 'Active', equals: true,
          text: { ok: `${x.name}: back ON — verified by re-reading the org`, bad: `${x.name}: accepted, but the org still reads it OFF` } },
      })), note: (r.maybe || []).length
        ? `the run switches them back on by itself when it ends — use this only if that did not happen. Not confirmed off, but possibly off: ${r.maybe.map(x => x.name).join(', ')}`
        : 'the run switches them back on by itself when it ends — use this only if that did not happen' } : { none: 'no validation rule was switched off' },
    });
  }
  if (r.failed.length) {
    // a rule that could not be switched back on here stays remembered: the Deploy page lists it as still OFF, with the button
    const back = touched.length ? await sftkVrPauseOn(sess, touched, send) : { done: [], failed: [] };
    return { ok: false, off: [], failed: r.failed, restored: back.done, restoreFailed: back.failed };
  }
  return { ok: true, off: r.done, failed: [] };
}

// ▶ Switch paused rules back on (the end of a run, or a leftover from a closed
// tab). A rule without its metadata (a leftover read from memory) is read first.
async function sftkVrPauseOn(sess, rules, send) {
  const bg = typeof send === 'function' ? send : sendBg;
  const orgKey = sftkOrgKey(sess.orgUrl);
  const lost = [], unread = [], goneIds = new Set();
  for (const r of rules) {
    if (r.metadata || r.xml) continue;
    // a packaged rule (remembered with its package and full name) is read through the Metadata API
    if (r.pkg && r.fullName) {
      try { r.xml = await _sftkVpReadPkg(sess, r, bg); }
      catch (e) { unread.push(`${r.name || r.id}: still OFF and still remembered — ${String((e && e.message) || e)}`); }
      continue;
    }
    const rec = await bg({ type: 'SF_TOOLING_GET', orgUrl: sess.orgUrl, sid: sess.sid, sobject: 'ValidationRule', id: r.id, _suppressError: true });
    if (rec && !rec.error && rec.Metadata) { r.metadata = rec.Metadata; continue; }
    // 2026-11-14: only a definite 404 / NOT_FOUND means the rule is gone. A 401, 5xx, network failure or no
    // answer used to be called "not found" too, and the rule was FORGOTTEN while still OFF org-wide (the
    // leftover card and its switch-back button vanished). Same fix as sftk-flowpause.js 2026-11-11: such a
    // rule is reported as still OFF and stays in the memory for the next try.
    const err = String((rec && rec.error) || '');
    if (/\bHTTP 404\b|NOT_FOUND|ENTITY_IS_DELETED/.test(err)) { goneIds.add(r.id); lost.push(`${r.name || r.id}: not found in the org any more — nothing to switch on`); }
    else unread.push(`${r.name || r.id}: still OFF and still remembered — it could not be read (${err || (rec ? 'no rule metadata in the answer' : 'no answer')})`);
  }
  const ready = rules.filter(r => r.metadata || r.xml);
  const journal = sftkHistoryBegin({ tool: 'Deploy', title: `▶ ${ready.length} validation rule(s) switched back on — ${orgLabel(sess.orgUrl)}`, orgUrl: sess.orgUrl });
  let r = { done: [], failed: [] };
  try {
    r = ready.length ? await _sftkVpSwitch(sess, ready, true, journal, send) : r;
    if (r.done.length || lost.length) await _sftkVpMemory(m => { for (const x of r.done) delete m[x.id]; for (const id of goneIds) delete m[id]; return m; }, orgKey);
  } finally {
    await sftkHistoryEnd(journal, { undo: { none: 'switching them off again is what the deployment option does — run it again, or deactivate the rule in Setup' }, errors: [...lost, ...unread] });
  }
  return { done: r.done, failed: [...r.failed, ...lost, ...unread] };
}

if (typeof window !== 'undefined') {
  window.sftkVrPauseList = sftkVrPauseList;
  window.sftkVrPauseHydrate = sftkVrPauseHydrate;
  window.sftkVrPauseOff = sftkVrPauseOff;
  window.sftkVrPauseOn = sftkVrPauseOn;
  window.sftkVrPausedLeftovers = sftkVrPausedLeftovers;
  window.sftkVrPausePkgFiles = sftkVrPausePkgFiles;
  window.sftkVrPauseMaybeOff = sftkVrPauseMaybeOff;
}
