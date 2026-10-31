'use strict';
// ✏ Values — the dialog on the Deploy page where a record (or every selected
// record) is given the values it is written with (user 2026-10-27: "change the
// whole record fields and deploy them as the user selected … along with
// lookups … one or many"). Every writable field of the object, the source's
// value beside it (and the target's, on a Changed row), a box to type the value
// that is written instead; lookups are picked from the target org, right here.
// The storage and the write-time rules are in sftk-valueedit.js; lookup picks
// go to the same place as the 🔗 lookups panel (node.lookupOverrides).

// p: the deployment (for a child object a VIEW rooted at that node; node is the
// real tree node, so a pick lands on the saved tree). srcIds: one id or many.
// tgtId: the paired target record on a Changed row, else null. mode: 'ins'|'chg'.
async function sftkOpenValueEditor(p, obj, node, srcIds, tgtId, label, mode, onSaved, opts) {
  const ids = [...new Set((Array.isArray(srcIds) ? srcIds : [srcIds]).filter(Boolean))];
  if (!ids.length || !node) return;
  const many = ids.length > 1;
  const srcL = orgLabel(p.sourceOrg), tgtL = orgLabel(p.targetOrg);
  showModal(`<div class="ds-modal-header">${many ? `✏ One value for all ${ids.length.toLocaleString()} selected ${esc(obj)} records` : `▸ Record · ${esc(obj)} · ${esc(label || ids[0])}`}
      <span class="ds-dc-modal-sub">${many
        ? `a value typed here is written to EVERY one of the ${ids.length.toLocaleString()} records, the same value on each — a field left empty keeps each record's own value; a lookup picked here points every record at that one ${esc(tgtL)} record`
        : `every writable field and lookup — what this record is written with in ${esc(tgtL)}: a value typed here replaces the source's, a record picked here is where the lookup points`}</span>
      <button class="ds-btn ds-btn-xs ds-dc-modal-close" data-dsaction="closeModal" title="Close">✕</button></div>
    <div class="ds-modal-body ds-dc-modal-body"><div id="dsValEdHost" class="ds-ve"><div class="ds-drift-compare-loading">Reading the fields…</div></div></div>`);
  const host = eid('dsValEdHost');
  if (!host) return;
  const all = _buildAllSessions();
  const srcSess = _resolveSession(p.sourceOrg, all), tgtSess = _resolveSession(p.targetOrg, all);
  if (!srcSess || !srcSess.sid) { host.innerHTML = `<div class="ds-drift-compare-err">⚠ Open ${esc(srcL)} in a Chrome tab to read the record's fields.</div>`; return; }
  const desc = await describe(obj, srcSess.orgUrl, srcSess.sid);
  if (!host.isConnected) return;
  if (!desc || !Array.isArray(desc.fields)) { host.innerHTML = `<div class="ds-drift-compare-err">⚠ ${esc(obj)} could not be described in ${esc(srcL)}.</div>`; return; }
  const fm = node.fieldMappings || {};
  const fields = sftkValEditFields(desc.fields, fm, mode);
  const tf = f => (fm[f] !== undefined && fm[f] !== null && fm[f] !== '') ? fm[f] : f;
  const lkpCfg = node.lookupResolutions || {};

  // the source record's own values (one record), and the target's on a Changed row
  const q = async (sess, id, cols) => {
    const r = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid, query: `SELECT ${['Id', ...cols].join(',')} FROM ${obj} WHERE Id = '${id}'` });
    return (r && !r.error && r.records && r.records[0]) || null;
  };
  let srcRec = null, tgtRec = null;
  if (!many) {
    const plain = fields.filter(f => !f.reference).map(f => f.name);
    const refs = fields.filter(f => f.reference && f.relationshipName && !(f.refTo.length > 1)).map(f => `${f.relationshipName}.Name`);
    const refIds = fields.filter(f => f.reference).map(f => f.name);   // the lookup's own id too — the landing line needs it
    srcRec = await q(srcSess, ids[0], [...plain, ...refIds, ...refs]);
    if (!srcRec) srcRec = await q(srcSess, ids[0], [...plain, ...refIds]);   // a related object without a Name field — read without the lookups' names
    if (tgtId && tgtSess && tgtSess.sid) { const tp = [...new Set(plain.map(tf))]; tgtRec = await q(tgtSess, tgtId, [...tp, ...refs]); if (!tgtRec) tgtRec = await q(tgtSess, tgtId, tp); }
    if (!host.isConnected) return;
  }
  const val = v => (v === null || v === undefined || v === '') ? '<span class="ds-dc-empty">empty</span>' : `<span class="ds-dc-v" title="${esc(String(v))}">${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}</span>`;
  const relName = f => { const rel = srcRec && f.relationshipName && srcRec[f.relationshipName]; return rel && rel.Name != null ? rel.Name : null; };
  const tgtRel = f => { const rel = tgtRec && f.relationshipName && tgtRec[f.relationshipName]; return rel && rel.Name != null ? rel.Name : null; };
  const hint = t => t === 'date' ? 'YYYY-MM-DD' : t === 'datetime' ? '2026-10-27T09:30:00Z' : t === 'boolean' ? 'true / false' : (t === 'double' || t === 'currency' || t === 'int' || t === 'percent') ? 'a number' : 'type a value…';
  const ovOf = id => sftkValOvGet(node, p.targetOrg, id);
  // for many records the box shows a value only when every record carries the same one
  const sameOv = f => { const vs = ids.map(id => ovOf(id)); if (!vs.every(o => f.name in o)) return undefined; const first = vs[0][f.name]; return vs.every(o => JSON.stringify(o[f.name]) === JSON.stringify(first)) ? first : undefined; };
  const lkpOf = id => (typeof sftkLkpOvGet === 'function') ? sftkLkpOvGet(node, p.targetOrg, id) : {};
  const sameLkp = f => { const vs = ids.map(id => lkpOf(id)[f.name] || ''); return vs.every(v => v === vs[0]) ? vs[0] : (vs.some(Boolean) ? '__mixed__' : ''); };
  const nameOf = id => (typeof _lkpNameCache !== 'undefined' && _lkpNameCache.get(id)) || id;
  // the picked record, said under the field (user 2026-10-31: "see it selected under the field and not using the red needle")
  const pickLine = (field, id, name) => `<span class="ds-ve-lkp-pick">✓ points at <b>${esc(name)}</b> <span class="ds-dep-muted">${esc(id)}</span></span> <button class="ds-btn ds-btn-xs" data-ve-lkp-clear="${esc(field)}" title="Forget this pick — the lookup is matched by name again">✕ back to matching by name</button>`;
  const matchLine = field => `<span class="ds-dep-muted">matched by ${esc((lkpCfg[field] && lkpCfg[field].matchField) || 'Name')} in ${esc(tgtL)}</span>`;

  const row = f => {
    const cur = f.reference ? sameLkp(f) : sameOv(f);
    const edited = f.reference ? !!cur : cur !== undefined;
    const isNull = !f.reference && cur === null;
    const cls = `ds-ve-row${edited ? ' ds-ve-row-on' : ''}${isNull ? ' ds-ve-null-on' : ''}`;
    const srcCell = many ? '' : `<td class="ds-ve-src">${f.reference ? (relName(f) != null ? `${val(relName(f))}<div class="ds-dep-muted">${esc(String(srcRec[f.name] || ''))}</div>` : val(srcRec ? srcRec[f.name] : null)) : val(srcRec ? srcRec[f.name] : null)}</td>`;
    const tgtCell = many || !tgtId ? '' : `<td class="ds-ve-tgt">${f.reference ? (tgtRel(f) != null ? val(tgtRel(f)) : val(tgtRec ? tgtRec[tf(f.name)] : null)) : val(tgtRec ? tgtRec[tf(f.name)] : null)}</td>`;
    const refObj = f.reference ? ((lkpCfg[f.name] && lkpCfg[f.name].matchObject) || f.refTo[0] || '') : '';
    const editor = f.reference
      ? `<div class="ds-ve-lkp" data-ve-lkp="${esc(f.name)}" data-ve-refobj="${esc(refObj)}" data-ve-srcname="${esc(relName(f) == null ? '' : String(relName(f)))}">
          ${refObj ? `<input type="search" class="ds-input ds-input-sm ds-ve-lkp-in${cur && cur !== '__mixed__' ? ' ds-ve-lkp-in-on' : ''}" value="${cur && cur !== '__mixed__' ? esc(nameOf(cur)) : ''}" placeholder="🔍 pick a ${esc(refObj)} in ${esc(tgtL)}…" aria-label="Pick the ${esc(refObj)} this lookup points at"><div class="ds-lkpo-results ds-ve-lkp-res" style="display:none"></div>` : ''}
          <div class="ds-ve-lkp-cur">${cur === '__mixed__' ? '<span class="ds-dep-muted">different picks per record</span>' : cur ? pickLine(f.name, cur, nameOf(cur)) : matchLine(f.name)}</div>
          ${!many && refObj && relName(f) != null ? `<div class="ds-ve-land" data-ve-land="${esc(f.name)}"${cur ? ' style="display:none"' : ''}>⏳ where it lands in ${esc(tgtL)}…</div>` : ''}
        </div>`
      : `<div class="ds-ve-edit"><input type="text" class="ds-input ds-input-sm ds-ve-in" data-ve-field="${esc(f.name)}" data-ve-type="${esc(f.type)}" value="${isNull || cur === undefined ? '' : esc(typeof cur === 'object' ? JSON.stringify(cur) : String(cur))}" placeholder="${isNull ? 'written empty' : esc(f.picklist ? 'pick a value (API name is written)…' : hint(f.type))}" ${f.picklist ? `list="dsVeList_${esc(f.name)}"` : ''} aria-label="The value ${esc(f.label)} is written with" ${isNull ? 'disabled' : ''}>
          ${f.picklist ? `<datalist id="dsVeList_${esc(f.name)}">${f.picklist.map(v => `<option value="${esc(v.value)}" label="${esc(v.label === v.value ? v.label : `${v.label} · API ${v.value}`)}">`).join('')}</datalist>` : ''}
          <button class="ds-btn ds-btn-xs ds-ve-null${isNull ? ' ds-btn-primary' : ''}" data-ve-null="${esc(f.name)}" title="${isNull ? 'Written empty — click to type a value instead' : 'Write this field empty'}">∅</button>
          <button class="ds-btn ds-btn-xs ds-ve-clear" data-ve-clear="${esc(f.name)}" title="Keep the source's value" ${edited ? '' : 'style="visibility:hidden"'}>✕</button>
          <div class="ds-ve-err" data-ve-err="${esc(f.name)}"></div></div>`;
    return `<tr class="${cls}" data-ve-row="${esc(f.name)}" data-ve-search="${esc((f.label + ' ' + f.name).toLowerCase())}"><th scope="row">${esc(f.label)}<div class="ds-dep-muted">${esc(f.name)}${f.name !== tf(f.name) ? ` → ${esc(tf(f.name))}` : ''} · ${esc(f.reference ? `lookup (${f.refTo.join(' / ')})` : f.type)}</div></th>${srcCell}${tgtCell}<td class="ds-ve-cell">${editor}</td></tr>`;
  };
  // what a person looks for first: the typed fields, then the fields the source holds a value in, then the rest
  const has = f => { if (f.reference ? !!sameLkp(f) : sameOv(f) !== undefined) return 2; if (!srcRec) return 0; const v = f.reference && f.relationshipName ? (relName(f) != null || srcRec[f.name]) : srcRec[f.name]; return v !== null && v !== undefined && v !== '' ? 1 : 0; };
  fields.sort((a, b) => (b.nameField - a.nameField) || (has(b) - has(a)) || a.label.localeCompare(b.label));
  const nEdited = fields.filter(f => f.reference ? !!sameLkp(f) : sameOv(f) !== undefined).length;
  const piiNote = p.piiPolicy && Object.values(p.piiPolicy).some(Boolean) ? ' A field the PII policy covers keeps its masked value — the policy wins.' : '';
  host.innerHTML = `
    <div class="ds-ve-tools"><input type="search" id="dsVeFilter" class="ds-input ds-input-sm" placeholder="🔍 find a field…" aria-label="Find a field"><span class="ds-dep-muted">${fields.length.toLocaleString()} writable field${fields.length === 1 ? '' : 's'}${many ? ` · a value typed here is written for all ${ids.length.toLocaleString()} records` : ''}</span><span class="ds-dep-sp"></span><label class="ds-ve-onlyedited"><input type="checkbox" id="dsVeOnly" ${nEdited ? '' : 'disabled'}> only my typed values (${nEdited})</label></div>
    <div class="ds-merge-wrap ds-ve-wrap"><table class="ds-merge-table ds-ve-table"><thead><tr><th>Field</th>${many ? '' : `<th>${esc(srcL)} <span class="ds-dep-muted">source</span></th>`}${many || !tgtId ? '' : `<th>${esc(tgtL)} <span class="ds-dep-muted">target now</span></th>`}<th>written as <span class="ds-dep-muted">(empty box = the source's value)</span></th></tr></thead>
      <tbody>${fields.map(row).join('') || `<tr><td colspan="4" class="ds-dep-muted">No writable field.</td></tr>`}</tbody></table></div>
    <div class="ds-ve-foot"><button class="ds-btn ds-btn-sm ds-btn-primary" id="dsVeSave">💾 Save values</button><button class="ds-btn ds-btn-sm" data-dsaction="closeModal">Cancel</button><span class="ds-dep-sp"></span><button class="ds-btn ds-btn-xs" id="dsVeClearAll" ${nEdited ? '' : 'disabled'}>✕ Clear every typed value</button></div>
    <div class="ds-dep-muted ds-ve-note">Typed values are written to ${esc(tgtL)} by ▶ Deploy (${mode === 'chg' ? 'the update' : 'the insert'}). ${esc(srcL)} is not changed, so after the run a record with a typed value differs from its source and is listed under 🟡 Changed until the orgs agree.${piiNote} Lookup picks are saved at once; typed values when you press Save.</div>`;

  // ── find a field; only the typed ones ──
  const filt = () => {
    const t = (eid('dsVeFilter')?.value || '').trim().toLowerCase(), only = !!eid('dsVeOnly')?.checked;
    host.querySelectorAll('tr[data-ve-row]').forEach(tr => { tr.style.display = (t && !tr.dataset.veSearch.includes(t)) || (only && !tr.classList.contains('ds-ve-row-on')) ? 'none' : ''; });
  };
  eid('dsVeFilter')?.addEventListener('input', filt);
  eid('dsVeOnly')?.addEventListener('change', filt);
  // opened on one field (a row's ✏ in the record compare): find it, and put the cursor in its box
  const focus = opts && opts.focus;
  if (focus) { const fi = eid('dsVeFilter'); if (fi) { fi.value = focus; filt(); } host.querySelector(`input[data-ve-field="${CSS.escape(focus)}"], [data-ve-lkp="${CSS.escape(focus)}"] input`)?.focus(); }
  const mark = tr => { const inp = tr.querySelector('.ds-ve-in'); const on = tr.classList.contains('ds-ve-null-on') || (inp && inp.value.trim() !== ''); tr.classList.toggle('ds-ve-row-on', on); const x = tr.querySelector('.ds-ve-clear'); if (x) x.style.visibility = on ? '' : 'hidden'; };
  host.querySelectorAll('.ds-ve-in').forEach(inp => inp.addEventListener('input', () => { const tr = inp.closest('tr'); tr.querySelector('.ds-ve-err').textContent = ''; mark(tr); }));
  host.querySelectorAll('[data-ve-null]').forEach(b => b.addEventListener('click', () => {
    const tr = b.closest('tr'), inp = tr.querySelector('.ds-ve-in'), on = !tr.classList.contains('ds-ve-null-on');
    tr.classList.toggle('ds-ve-null-on', on); inp.disabled = on; if (on) inp.value = ''; inp.placeholder = on ? 'written empty' : hint(inp.dataset.veType);
    b.classList.toggle('ds-btn-primary', on); b.title = on ? 'Written empty — click to type a value instead' : 'Write this field empty';
    mark(tr);
  }));
  host.querySelectorAll('[data-ve-clear]').forEach(b => b.addEventListener('click', () => {
    const tr = b.closest('tr'), inp = tr.querySelector('.ds-ve-in');
    tr.classList.remove('ds-ve-null-on'); inp.disabled = false; inp.value = ''; inp.placeholder = hint(inp.dataset.veType);
    tr.querySelector('.ds-ve-null').classList.remove('ds-btn-primary'); tr.querySelector('.ds-ve-err').textContent = '';
    mark(tr);
  }));

  // ── lookups: picked from the target org, saved at once, for every record of the dialog ──
  const saveNode = async () => { if (!p.ephemeral && typeof storageSaveProfiles === 'function') await storageSaveProfiles(); };
  host.querySelectorAll('[data-ve-lkp]').forEach(box => {
    const field = box.dataset.veLkp, refObj = box.dataset.veRefobj;
    const inp = box.querySelector('.ds-ve-lkp-in'), res = box.querySelector('.ds-ve-lkp-res');
    if (!inp || !res) return;
    let timer = null;
    // a pick, from the search results or from the landing line: saved at once for every record of the dialog
    const wireHits = el => el.querySelectorAll('[data-ve-hit]').forEach(h => h.addEventListener('click', async () => {
      for (const id of ids) sftkLkpOvSet(node, p.targetOrg, id, field, h.dataset.veHit);
      if (typeof _lkpNameCache !== 'undefined') _lkpNameCache.set(h.dataset.veHit, h.textContent);
      await saveNode();
      box.querySelector('.ds-ve-lkp-cur').innerHTML = pickLine(field, h.dataset.veHit, h.textContent);
      box.closest('tr').classList.add('ds-ve-row-on');
      wireClear(box);
      const landEl = box.querySelector('[data-ve-land]'); if (landEl) landEl.style.display = 'none';   // a pick beats the name bridge
      res.style.display = 'none'; inp.value = h.textContent; inp.classList.add('ds-ve-lkp-in-on');
      showToast(`📌 ${field} → ${h.textContent} for ${many ? `${ids.length.toLocaleString()} records` : 'this record'} — saved.`, 'success', 4000);
      if (typeof onSaved === 'function') onSaved();
    }));
    const run = async () => {
      if (!tgtSess || !tgtSess.sid) { res.style.display = ''; res.innerHTML = `<div class="ds-drift-compare-err">⚠ Open ${esc(tgtL)} in a Chrome tab to pick from it.</div>`; return; }
      const term = inp.value.trim();
      const like = term ? ` WHERE Name LIKE '%${(typeof sftkLkpSoqlLike === 'function') ? sftkLkpSoqlLike(term) : term.replace(/['\\%_]/g, c => '\\' + c)}%'` : '';
      res.style.display = ''; res.innerHTML = '<div class="ds-drift-compare-loading">Searching…</div>';
      const r = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, query: `SELECT Id, Name FROM ${refObj}${like} ORDER BY Name LIMIT 8` });
      if (!box.isConnected) return;
      if (!r || r.error) { res.innerHTML = `<div class="ds-drift-compare-err">⚠ ${esc((r && r.error) || 'search failed')}</div>`; return; }
      const recs = r.records || [];
      res.innerHTML = recs.length ? recs.map(x => `<button class="ds-lkpo-hit" data-ve-hit="${esc(x.Id)}" title="${esc(x.Id)}">${esc(x.Name != null ? x.Name : x.Id)}</button>`).join('')
        : `<div class="ds-drift-compare-empty">No ${esc(refObj)} record matches ${term ? `“${esc(term)}”` : 'that'} in ${esc(tgtL)}.</div>`;
      wireHits(res);
    };
    inp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 300); });
    inp.addEventListener('focus', () => { if (res.style.display === 'none') run(); });
    wireClear(box);
    // where the lookup lands when nothing is picked — the engine's name bridge, previewed (folded in from the
    // 🔗 lookups panel, user 2026-10-31: "values and lookups can become one view"): the target record(s) that
    // carry the source parent's name — one (it lands there), several (the first wins — pick to be sure), none (empty)
    const land = box.querySelector('[data-ve-land]');
    if (land && tgtSess && tgtSess.sid && box.dataset.veSrcname) (async () => {
      const nm = box.dataset.veSrcname;
      const r = await sendBg({ type: 'SF_QUERY', tooling: false, orgUrl: tgtSess.orgUrl, sid: tgtSess.sid, _suppressError: true, query: `SELECT Id, Name FROM ${refObj} WHERE Name = '${nm.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' LIMIT 5` });
      if (!land.isConnected) return;
      if (!r || r.error) { land.remove(); return; }
      const recs = r.records || [];
      if (recs.length === 1) {
        if (typeof _lkpNameCache !== 'undefined') _lkpNameCache.set(recs[0].Id, recs[0].Name);
        land.innerHTML = `✓ lands on <b>${esc(recs[0].Name)}</b> — the one ${esc(refObj)} named so in ${esc(tgtL)}`;
      } else if (recs.length) {
        land.className = 'ds-ve-land ds-ve-land-bad';
        land.innerHTML = `⚠ ${recs.length}${recs.length === 5 ? '+' : ''} ${esc(refObj)} records named “${esc(nm)}” in ${esc(tgtL)} — the first wins; pick one to be sure: ${recs.map(x => `<button class="ds-lkpo-hit" data-ve-hit="${esc(x.Id)}" title="${esc(x.Id)}">${esc(x.Name)}</button>`).join('')}`;
        wireHits(land);
      } else {
        // a parent this same run inserts is connected after insert (the engine's late link) — not empty
        const parentId = srcRec ? srcRec[field] : null;
        const inTree = typeof collectTreeObjects === 'function' && p.tree && collectTreeObjects(p.tree).has(refObj);
        const insertedToo = inTree && p.tree && p.tree.objectType === obj && refObj === obj && parentId && ((p.lastScan && p.lastScan.missingInTarget) || []).some(r => (r && r.sourceId ? r.sourceId : r) === parentId);
        if (insertedToo) land.innerHTML = `✓ <b>${esc(nm)}</b> is inserted by this run too — the lookup is connected after insert`;
        else if (inTree) { land.className = 'ds-ve-land'; land.innerHTML = `ℹ no ${esc(refObj)} named “${esc(nm)}” in ${esc(tgtL)} yet — ${esc(refObj)} is part of this deployment: inserted in the same run it is connected after insert, otherwise pick one here or the lookup lands empty`; }
        else { land.className = 'ds-ve-land ds-ve-land-bad'; land.innerHTML = `⚠ no ${esc(refObj)} named “${esc(nm)}” in ${esc(tgtL)} — the lookup lands EMPTY unless you pick one`; }
      }
    })();
  });
  function wireClear(box) {
    box.querySelectorAll('[data-ve-lkp-clear]').forEach(b => b.addEventListener('click', async () => {
      const field = b.dataset.veLkpClear;
      for (const id of ids) if (typeof sftkLkpOvClear === 'function') sftkLkpOvClear(node, p.targetOrg, id, field);
      await saveNode();
      box.querySelector('.ds-ve-lkp-cur').innerHTML = matchLine(field);
      const inp0 = box.querySelector('.ds-ve-lkp-in'); if (inp0) { inp0.value = ''; inp0.classList.remove('ds-ve-lkp-in-on'); }
      const landEl = box.querySelector('[data-ve-land]'); if (landEl) landEl.style.display = '';
      const tr = box.closest('tr'); if (tr) tr.classList.remove('ds-ve-row-on');
      if (typeof onSaved === 'function') onSaved();
    }));
  }

  // ── Save: every box is checked against its field's type before anything is stored ──
  eid('dsVeSave')?.addEventListener('click', async () => {
    const picks = [], bad = [];
    host.querySelectorAll('tr[data-ve-row]').forEach(tr => {
      const inp = tr.querySelector('.ds-ve-in'); if (!inp) return;
      const field = inp.dataset.veField;
      if (tr.classList.contains('ds-ve-null-on')) { picks.push([field, null]); return; }
      const text = inp.value.trim();
      if (text === '') { picks.push([field, undefined]); return; }
      const r = sftkMergeCoerce(inp.dataset.veType, text);
      if (!r.ok) { bad.push(field); tr.querySelector('.ds-ve-err').textContent = `needs ${r.error}`; tr.style.display = ''; return; }
      picks.push([field, r.value]);
    });
    if (bad.length) { showToast(`${bad.length} value${bad.length === 1 ? ' does' : 's do'} not fit ${bad.length === 1 ? 'its' : 'their'} field: ${bad.join(', ')} — see the row.`, 'error', 7000); return; }
    let n = 0;
    for (const id of ids) for (const [field, v] of picks) { if (v === undefined) sftkValOvClear(node, p.targetOrg, id, field); else { sftkValOvSet(node, p.targetOrg, id, field, v); n++; } }
    await saveNode();
    closeModal();
    const per = picks.filter(x => x[1] !== undefined).length;
    showToast(per ? `✏ ${per} value${per === 1 ? '' : 's'} saved for ${many ? `${ids.length.toLocaleString()} records` : (label || 'this record')} — written by ▶ Deploy.` : `No typed value left for ${many ? 'these records' : (label || 'this record')} — the source's values are written.`, 'success', 5000);
    if (typeof onSaved === 'function') onSaved();
  });
  eid('dsVeClearAll')?.addEventListener('click', async () => {
    for (const id of ids) sftkValOvClear(node, p.targetOrg, id);
    await saveNode();
    closeModal();
    showToast(`Every typed value removed for ${many ? `${ids.length.toLocaleString()} records` : (label || 'this record')} — the source's values are written.`, 'success', 5000);
    if (typeof onSaved === 'function') onSaved();
  });
}
