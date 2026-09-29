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
    what: 'Flows switched off with ⏻ Flow switches (their active version is remembered on this PC) that are still off in the org.',
    calls: () => 1,
    async run(sess, ctx) {
      let remembered = {};
      try { remembered = ((await chrome.storage.local.get('sftk_flow_prev_active')).sftk_flow_prev_active || {})[ctx.orgKey] || {}; } catch (_) { remembered = {}; }
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
  _ohWire(ctx, total);
}

function _ohWire(ctx, total) {
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
    el.textContent = `For all ${OH_CARDS.length} checks: ${line.text}`;
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
