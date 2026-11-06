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
        : `every writable field and lookup, with the value this record is written with in ${esc(tgtL)} — change any box and it is saved as you type; a record picked for a lookup is where it points`}</span>
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
  let readErr = '';   // why the source record could not be read — said on the page, never shown as "empty" (2026-11-05)
  // columns the org refused for the running user ("No such column 'X'": describe lists a field the user cannot
  // query — screenshot 2026-11-07, SFTK_Dbg_Count__c). They are dropped and the read is tried again, and named.
  const unreadable = [];
  const q = async (sess, id, cols) => {
    let use = [...cols];
    for (let attempt = 0; attempt < 8; attempt++) {
      const r = await sendBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl: sess.orgUrl, sid: sess.sid, _suppressError: true, query: `SELECT ${['Id', ...use].join(',')} FROM ${obj} WHERE Id = '${id}'` });
      const bad = r && r.error ? /No such column '([^']+)'/i.exec(String(r.error)) : null;
      if (bad && use.some(c => c.toLowerCase() === bad[1].toLowerCase())) {
        use = use.filter(c => c.toLowerCase() !== bad[1].toLowerCase());
        if (!unreadable.some(u => u.toLowerCase() === bad[1].toLowerCase())) unreadable.push(bad[1]);
        continue;
      }
      if (!r || r.error) { readErr = (r && r.error) ? String(r.error) : 'no answer'; return null; }
      readErr = (r.records && r.records[0]) ? '' : 'the record is not there (deleted, or not visible to you)';
      return (r.records && r.records[0]) || null;
    }
    readErr = 'too many of its fields could not be read';
    return null;
  };
  const isUnread = name => unreadable.some(u => u.toLowerCase() === String(name).toLowerCase());
  // Record Type (user 2026-11-07: "we dont show record type for records, i want to be able to edit them too"):
  // the source's by name, and a pick among the target's — stored as RecordTypeId, which the engine writes as-is
  // (a record without a pick lands on the target's type of the same API name, as before).
  const rtInfos = (desc.recordTypeInfos || []).filter(r => r && r.recordTypeId);
  const hasRt = rtInfos.some(r => !r.master);
  let tgtRts = [];
  if (hasRt && tgtSess && tgtSess.sid) {
    const td = await describe(obj, tgtSess.orgUrl, tgtSess.sid);
    if (!host.isConnected) return;
    tgtRts = ((td && td.recordTypeInfos) || []).filter(r => r && r.recordTypeId && r.available !== false);
  }
  const rtCols = hasRt ? ['RecordTypeId', 'RecordType.Name', 'RecordType.DeveloperName'] : [];
  let srcRec = null, tgtRec = null;
  if (!many) {
    const plain = fields.filter(f => !f.reference).map(f => f.name);
    const refs = fields.filter(f => f.reference && f.relationshipName && !(f.refTo.length > 1)).map(f => `${f.relationshipName}.Name`);
    const refIds = fields.filter(f => f.reference).map(f => f.name);   // the lookup's own id too — the landing line needs it
    srcRec = await q(srcSess, ids[0], [...plain, ...refIds, ...refs, ...rtCols]);
    if (!srcRec) srcRec = await q(srcSess, ids[0], [...plain, ...refIds, ...rtCols]);   // a related object without a Name field — read without the lookups' names
    if (tgtId && tgtSess && tgtSess.sid) { const tp = [...new Set(plain.map(tf))]; tgtRec = await q(tgtSess, tgtId, [...tp, ...refs, ...rtCols]); if (!tgtRec) tgtRec = await q(tgtSess, tgtId, [...tp, ...rtCols]); }
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

  // one record: the box holds the value that IS written — the typed one, else the source's, as text
  // (user via a colleague 2026-11-05: "when I click a record I see an empty record; I want to see every value
  // of the record that will be created and change any field"). Many records: the box is the one value for all.
  const asText = v => (v === null || v === undefined) ? '' : typeof v === 'boolean' ? String(v) : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const srcText = f => (!many && srcRec) ? asText(srcRec[f.name]) : '';
  const row = f => {
    const cur = f.reference ? sameLkp(f) : sameOv(f);
    const edited = f.reference ? !!cur : cur !== undefined;
    const isNull = !f.reference && cur === null;
    const boxText = isNull ? '' : cur !== undefined ? asText(cur) : srcText(f);
    // a field empty in the source is marked ∅ from the start — it IS written empty — and a typed value lifts the mark
    // (user 2026-11-07: "by default זה יסומן בתור ריק אלא אם כן המשתמש אמר אחרת. כמובן שאפשר לתת לו לבטל ולהכניס ערך")
    const unread = !many && isUnread(f.name);   // the org refused this column for the running user: not "empty", unknown
    const dflEmpty = !many && !f.reference && !isNull && cur === undefined && !!srcRec && srcText(f) === '' && !unread;
    const boxHint = isNull ? 'written empty' : dflEmpty ? 'empty' : unread ? 'could not be read for your user — type a value, or leave it' : many ? esc(f.picklist ? 'pick a value (API name is written)…' : hint(f.type)) : (srcText(f) ? '' : 'type a value, or leave it empty');
    const cls = `ds-ve-row${edited ? ' ds-ve-row-on' : ''}${isNull ? ' ds-ve-null-on' : ''}${dflEmpty ? ' ds-ve-empty-dfl' : ''}`;
    const srcCell = many ? '' : `<td class="ds-ve-src">${unread ? '<span class="ds-dc-empty" title="The org refused this column for your user — the value is unknown, not empty">not readable</span>' : f.reference ? (relName(f) != null ? `${val(relName(f))}<div class="ds-dep-muted">${esc(String(srcRec[f.name] || ''))}</div>` : val(srcRec ? srcRec[f.name] : null)) : val(srcRec ? srcRec[f.name] : null)}</td>`;
    const tgtCell = many || !tgtId ? '' : `<td class="ds-ve-tgt">${f.reference ? (tgtRel(f) != null ? val(tgtRel(f)) : val(tgtRec ? tgtRec[tf(f.name)] : null)) : val(tgtRec ? tgtRec[tf(f.name)] : null)}</td>`;
    const refObj = f.reference ? ((lkpCfg[f.name] && lkpCfg[f.name].matchObject) || f.refTo[0] || '') : '';
    const editor = f.reference
      ? `<div class="ds-ve-lkp" data-ve-lkp="${esc(f.name)}" data-ve-refobj="${esc(refObj)}" data-ve-srcname="${esc(relName(f) == null ? '' : String(relName(f)))}">
          ${refObj ? `<input type="search" class="ds-input ds-input-sm ds-ve-lkp-in${cur && cur !== '__mixed__' ? ' ds-ve-lkp-in-on' : ''}" value="${cur && cur !== '__mixed__' ? esc(nameOf(cur)) : ''}" placeholder="🔍 pick a ${esc(refObj)} in ${esc(tgtL)}…" aria-label="Pick the ${esc(refObj)} this lookup points at"><div class="ds-lkpo-results ds-ve-lkp-res" style="display:none"></div>` : ''}
          <div class="ds-ve-lkp-cur">${cur === '__mixed__' ? '<span class="ds-dep-muted">different picks per record</span>' : cur ? pickLine(f.name, cur, nameOf(cur)) : matchLine(f.name)}</div>
          ${!many && refObj && relName(f) != null ? `<div class="ds-ve-land" data-ve-land="${esc(f.name)}"${cur ? ' style="display:none"' : ''}>⏳ where it lands in ${esc(tgtL)}…</div>` : ''}
        </div>`
      : `<div class="ds-ve-edit"><input type="text" class="ds-input ds-input-sm ds-ve-in" data-ve-field="${esc(f.name)}" data-ve-type="${esc(f.type)}" data-ve-src="${esc(srcText(f))}"${unread ? ' data-ve-unread="1"' : ''} value="${esc(boxText)}" placeholder="${boxHint}" ${f.picklist ? `list="dsVeList_${esc(f.name)}"` : ''} aria-label="The value ${esc(f.label)} is written with" ${isNull ? 'disabled' : ''}>
          ${f.picklist ? `<datalist id="dsVeList_${esc(f.name)}">${f.picklist.map(v => `<option value="${esc(v.value)}" label="${esc(v.label === v.value ? v.label : `${v.label} · API ${v.value}`)}">`).join('')}</datalist>` : ''}
          <button class="ds-btn ds-btn-xs ds-ve-null${isNull || dflEmpty ? ' ds-btn-primary' : ''}" data-ve-null="${esc(f.name)}" title="${isNull ? 'Written empty — click to type a value instead' : dflEmpty ? 'Empty in the source, written empty — type a value instead' : 'Write this field empty'}">∅</button>
          <button class="ds-btn ds-btn-xs ds-ve-clear" data-ve-clear="${esc(f.name)}" title="${many ? 'Keep each record\'s own value' : 'Back to the source\'s value'}" ${edited ? '' : 'style="visibility:hidden"'}>✕</button>
          <div class="ds-ve-err" data-ve-err="${esc(f.name)}"></div></div>`;
    return `<tr class="${cls}" data-ve-row="${esc(f.name)}" data-ve-search="${esc((f.label + ' ' + f.name).toLowerCase())}"><th scope="row">${esc(f.label)}<div class="ds-dep-muted">${esc(f.name)}${f.name !== tf(f.name) ? ` → ${esc(tf(f.name))}` : ''} · ${esc(f.reference ? `lookup (${f.refTo.join(' / ')})` : f.type)}</div></th>${srcCell}${tgtCell}<td class="ds-ve-cell">${editor}</td></tr>`;
  };
  // what a person looks for first: the typed fields, then the fields the source holds a value in, then the rest
  const has = f => { if (f.reference ? !!sameLkp(f) : sameOv(f) !== undefined) return 2; if (!srcRec) return 0; const v = f.reference && f.relationshipName ? (relName(f) != null || srcRec[f.name]) : srcRec[f.name]; return v !== null && v !== undefined && v !== '' ? 1 : 0; };
  fields.sort((a, b) => (b.nameField - a.nameField) || (has(b) - has(a)) || a.label.localeCompare(b.label));
  const nEdited = fields.filter(f => f.reference ? !!sameLkp(f) : sameOv(f) !== undefined).length;
  // the Record Type row: the source's type by name; a pick among the target's types, else the type of the same API name
  const rtRow = () => {
    if (!hasRt) return '';
    const picks = ids.map(id => ovOf(id).RecordTypeId);
    const cur = picks.every(v => v === picks[0]) ? picks[0] : '__mixed__';
    const srcRt = srcRec && srcRec.RecordType ? srcRec.RecordType : null;
    const srcDev = srcRt ? srcRt.DeveloperName : '';
    const same = srcDev ? tgtRts.find(r => r.developerName === srcDev) : null;
    const dflText = many ? 'each record’s own type, by API name'
      : srcDev ? (same ? `the same type in ${tgtL}: ${same.name}` : `⚠ ${tgtL} has no record type named ${srcDev} — written with its default type`)
      : `${tgtL}’s default type`;
    const opts = tgtRts.map(r => `<option value="${esc(r.recordTypeId)}" ${cur === r.recordTypeId ? 'selected' : ''}>${esc(r.name)} (${esc(r.developerName)})${r.master ? ' — Master' : ''}</option>`).join('');
    return `<tr class="ds-ve-row ds-ve-rt${cur && cur !== '__mixed__' ? ' ds-ve-row-on' : ''}" data-ve-row="RecordTypeId" data-ve-search="record type recordtypeid"><th scope="row">Record Type<div class="ds-dep-muted">RecordTypeId · the type of the same API name, unless you pick one</div></th>${many ? '' : `<td class="ds-ve-src">${val(srcRt ? `${srcRt.Name} (${srcRt.DeveloperName})` : (srcRec && !srcRec.RecordTypeId ? 'Master' : null))}</td>`}${many || !tgtId ? '' : `<td class="ds-ve-tgt">${val(tgtRec && tgtRec.RecordType ? `${tgtRec.RecordType.Name} (${tgtRec.RecordType.DeveloperName})` : null)}</td>`}<td class="ds-ve-cell"><div class="ds-ve-edit">
        <select class="ds-select ds-select-sm ds-ve-rt-sel" data-ve-rt="1" aria-label="The record type this record is written with in ${esc(tgtL)}">${cur === '__mixed__' ? '<option value="__mixed__" selected>different picks per record</option>' : ''}<option value=""${cur ? '' : ' selected'}>${esc(dflText)}</option>${opts}</select>
        <button class="ds-btn ds-btn-xs ds-ve-clear" data-ve-rt-clear="1" title="Back to the type of the same API name"${cur ? '' : ' style="visibility:hidden"'}>✕</button>
      </div></td></tr>`;
  };
  const piiNote = p.piiPolicy && Object.values(p.piiPolicy).some(Boolean) ? ' A field the PII policy covers keeps its masked value — the policy wins.' : '';
  host.innerHTML = `
    <div class="ds-ve-tools"><input type="search" id="dsVeFilter" class="ds-input ds-input-sm" placeholder="🔍 find a field…" aria-label="Find a field"><span class="ds-dep-muted">${fields.length.toLocaleString()} writable field${fields.length === 1 ? '' : 's'}${many ? ` · a value typed here is written for all ${ids.length.toLocaleString()} records` : ''}</span><span class="ds-dep-sp"></span><label class="ds-ve-onlyedited"><input type="checkbox" id="dsVeOnly" ${nEdited ? '' : 'disabled'}> only my changed values (${nEdited})</label></div>
    <div class="ds-merge-wrap ds-ve-wrap"><table class="ds-merge-table ds-ve-table"><thead><tr><th>Field</th>${many ? '' : `<th>${esc(srcL)} <span class="ds-dep-muted">source</span></th>`}${many || !tgtId ? '' : `<th>${esc(tgtL)} <span class="ds-dep-muted">target now</span></th>`}<th>written as <span class="ds-dep-muted">${many ? '(empty box = each record keeps its own value)' : '(the source\'s value unless you change it)'}</span></th></tr></thead>
      <tbody>${rtRow()}${fields.map(row).join('') || `<tr><td colspan="4" class="ds-dep-muted">No writable field.</td></tr>`}</tbody></table></div>
    ${!many && unreadable.length ? `<div class="ds-dep-muted ds-ve-note">⚠ ${unreadable.length} field${unreadable.length === 1 ? '' : 's'} could not be read for your user — ${esc(unreadable.join(', '))} — so ${unreadable.length === 1 ? 'its box shows' : 'their boxes show'} "not readable", not empty; a value typed there is still written.</div>` : ''}
    ${!many && readErr ? `<div class="ds-drift-compare-err" id="dsVeReadErr">⚠ This record could not be read from ${esc(srcL)}: ${esc(readErr)}. The source column and the boxes are EMPTY because of that, not because the record is — a value typed here is still written, but check the record in ${esc(srcL)} first.</div>` : ''}
    <div class="ds-ve-foot">${many ? `<button class="ds-btn ds-btn-sm ds-btn-primary" id="dsVeSave">💾 Save values</button><button class="ds-btn ds-btn-sm" data-dsaction="closeModal">Cancel</button>` : `<button class="ds-btn ds-btn-sm ds-btn-primary" data-dsaction="closeModal">Close</button><span class="ds-dep-muted" id="dsVeStatus">${nEdited ? `✏ ${nEdited} changed value${nEdited === 1 ? '' : 's'} — saved` : 'saved as you type'}</span>`}<span class="ds-dep-sp"></span><button class="ds-btn ds-btn-xs" id="dsVeClearAll" ${nEdited ? '' : 'disabled'}>${many ? '✕ Clear every typed value' : '✕ Back to the source on every field'}</button></div>
    <div class="ds-dep-muted ds-ve-note">${many ? 'Typed values are' : 'A changed value is'} written to ${esc(tgtL)} by ▶ Deploy (${mode === 'chg' ? 'the update' : 'the insert'}).${many ? '' : ' A field empty in the source is marked ∅ and written empty; type a value to write one instead.'} ${esc(srcL)} is not changed, so after the run a record with a changed value differs from its source and is listed under 🟡 Changed until the orgs agree.${piiNote} ${many ? 'Lookup picks are saved at once; typed values when you press Save.' : 'Everything here is saved as you type — close the dialog whenever you like, nothing is lost.'}</div>`;

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
  const changedBox = inp => many ? inp.value.trim() !== '' : inp.value.trim() !== String(inp.dataset.veSrc || '');
  // the ∅ mark a source-empty field carries by default: on while the box is empty and no explicit "written empty" is set
  const emptyDfl = tr => {
    if (many || !srcRec) return;
    const inp = tr.querySelector('.ds-ve-in'), b = tr.querySelector('.ds-ve-null'); if (!inp || !b) return;
    const explicit = tr.classList.contains('ds-ve-null-on');
    const on = !explicit && !inp.dataset.veUnread && String(inp.dataset.veSrc || '') === '' && inp.value.trim() === '';
    tr.classList.toggle('ds-ve-empty-dfl', on);
    if (explicit) return;
    b.classList.toggle('ds-btn-primary', on); b.title = on ? 'Empty in the source, written empty — type a value instead' : 'Write this field empty';
    inp.placeholder = on ? 'empty' : inp.dataset.veUnread ? 'could not be read for your user — type a value, or leave it' : (String(inp.dataset.veSrc || '') === '' ? 'type a value, or leave it empty' : hint(inp.dataset.veType));
  };
  const mark = tr => { const inp = tr.querySelector('.ds-ve-in'); const on = tr.classList.contains('ds-ve-null-on') || (inp && changedBox(inp)); tr.classList.toggle('ds-ve-row-on', on); const x = tr.querySelector('.ds-ve-clear'); if (x) x.style.visibility = on ? '' : 'hidden'; emptyDfl(tr); };
  // ── one record: saved as you type (debounced), on blur, and flushed when the dialog closes ──
  const timers = new Map();
  const saveRow = async tr => {
    if (many) return;
    const inp = tr.querySelector('.ds-ve-in'); if (!inp) return;
    const field = inp.dataset.veField, err = tr.querySelector('.ds-ve-err');
    const text = inp.value.trim(), st = String(inp.dataset.veSrc || '');
    let v;
    if (tr.classList.contains('ds-ve-null-on')) v = null;
    else if (text === st) v = undefined;           // the source's value: no change kept
    else if (text === '') v = null;                // a value the source has, cleared: written empty
    else { const r = sftkMergeCoerce(inp.dataset.veType, text); if (!r.ok) { err.textContent = `needs ${r.error} — not saved`; return; } v = r.value; }
    err.textContent = '';
    if (v === undefined) sftkValOvClear(node, p.targetOrg, ids[0], field); else sftkValOvSet(node, p.targetOrg, ids[0], field, v);
    await saveNode();
    const n = Object.keys(sftkValOvGet(node, p.targetOrg, ids[0])).length;
    const stEl = eid('dsVeStatus'); if (stEl) stEl.textContent = n ? `✏ ${n} changed value${n === 1 ? '' : 's'} — saved` : 'saved as you type';
    const only = eid('dsVeOnly'); if (only) { only.disabled = !n && !host.querySelector('.ds-ve-lkp-in-on'); only.parentElement.lastChild.textContent = ` only my changed values (${n})`; }
    const ca = eid('dsVeClearAll'); if (ca) ca.disabled = !n;
    if (typeof onSaved === 'function') onSaved();
  };
  const queueSave = (tr, now) => { clearTimeout(timers.get(tr)); if (now) { timers.delete(tr); saveRow(tr); } else timers.set(tr, setTimeout(() => { timers.delete(tr); saveRow(tr); }, 400)); };
  const flush = () => { for (const tr of [...timers.keys()]) queueSave(tr, true); };
  if (!many) {
    (eid('dsModalBox') || host).querySelectorAll('[data-dsaction="closeModal"]').forEach(b => b.addEventListener('click', flush, true));
    document.addEventListener('keydown', function onEsc(e) { if (e.key === 'Escape') flush(); if (!host.isConnected) document.removeEventListener('keydown', onEsc); }, true);
  }
  host.querySelectorAll('.ds-ve-in').forEach(inp => {
    inp.addEventListener('input', () => { const tr = inp.closest('tr'); tr.querySelector('.ds-ve-err').textContent = ''; mark(tr); queueSave(tr); });
    inp.addEventListener('change', () => queueSave(inp.closest('tr'), true));
  });
  host.querySelectorAll('[data-ve-null]').forEach(b => b.addEventListener('click', () => {
    const tr = b.closest('tr'), inp = tr.querySelector('.ds-ve-in'), on = !tr.classList.contains('ds-ve-null-on');
    if (on && tr.classList.contains('ds-ve-empty-dfl')) { inp.focus(); return; }   // already empty by default: the ∅ is where a value is typed instead
    tr.classList.toggle('ds-ve-null-on', on); inp.disabled = on; if (on) inp.value = ''; inp.placeholder = on ? 'written empty' : hint(inp.dataset.veType);
    b.classList.toggle('ds-btn-primary', on); b.title = on ? 'Written empty — click to type a value instead' : 'Write this field empty';
    if (!on && !many) inp.value = String(inp.dataset.veSrc || '');   // back from "empty": the source's value again
    mark(tr); queueSave(tr, true);
  }));
  host.querySelectorAll('[data-ve-clear]').forEach(b => b.addEventListener('click', () => {
    const tr = b.closest('tr'), inp = tr.querySelector('.ds-ve-in');
    tr.classList.remove('ds-ve-null-on'); inp.disabled = false; inp.value = many ? '' : String(inp.dataset.veSrc || ''); inp.placeholder = many ? hint(inp.dataset.veType) : (inp.value ? '' : 'empty in the source — type a value, or leave it empty');
    tr.querySelector('.ds-ve-null').classList.remove('ds-btn-primary'); tr.querySelector('.ds-ve-err').textContent = '';
    mark(tr); queueSave(tr, true);
  }));

  // ── lookups: picked from the target org, saved at once, for every record of the dialog ──
  const saveNode = async () => { if (!p.ephemeral && typeof storageSaveProfiles === 'function') await storageSaveProfiles(); };
  // ── the record type: a pick is saved at once for every record of the dialog, like a lookup ──
  const rtStatus = () => { if (many) return; const n = Object.keys(sftkValOvGet(node, p.targetOrg, ids[0])).length; const stEl = eid('dsVeStatus'); if (stEl) stEl.textContent = n ? `✏ ${n} changed value${n === 1 ? '' : 's'} — saved` : 'saved as you type'; const ca = eid('dsVeClearAll'); if (ca) ca.disabled = !n; };
  host.querySelectorAll('[data-ve-rt]').forEach(sel => sel.addEventListener('change', async () => {
    const v = sel.value === '__mixed__' ? null : sel.value, tr = sel.closest('tr');
    if (v === null) return;
    for (const id of ids) { if (v) sftkValOvSet(node, p.targetOrg, id, 'RecordTypeId', v); else sftkValOvClear(node, p.targetOrg, id, 'RecordTypeId'); }
    await saveNode();
    sel.querySelector('option[value="__mixed__"]')?.remove();
    tr.classList.toggle('ds-ve-row-on', !!v); const x = tr.querySelector('[data-ve-rt-clear]'); if (x) x.style.visibility = v ? '' : 'hidden';
    rtStatus();
    showToast(v ? `🪪 Record type → ${sel.selectedOptions[0].textContent} for ${many ? `${ids.length.toLocaleString()} records` : 'this record'} — saved.` : '🪪 Record type: the type of the same API name again — saved.', 'success', 4000);
    if (typeof onSaved === 'function') onSaved();
  }));
  host.querySelectorAll('[data-ve-rt-clear]').forEach(b => b.addEventListener('click', () => { const sel = b.closest('tr').querySelector('[data-ve-rt]'); if (sel) { sel.value = ''; sel.dispatchEvent(new Event('change')); } }));
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
    if (many) closeModal();
    else {
      host.querySelectorAll('tr[data-ve-row]').forEach(tr => {
        const inp = tr.querySelector('.ds-ve-in'); if (!inp) return;
        tr.classList.remove('ds-ve-null-on'); inp.disabled = false; inp.value = String(inp.dataset.veSrc || ''); tr.querySelector('.ds-ve-null').classList.remove('ds-btn-primary'); tr.querySelector('.ds-ve-err').textContent = ''; mark(tr);
      });
      const stEl = eid('dsVeStatus'); if (stEl) stEl.textContent = 'saved as you type';
      const ca = eid('dsVeClearAll'); if (ca) ca.disabled = true;
    }
    showToast(`Every changed value removed for ${many ? `${ids.length.toLocaleString()} records` : (label || 'this record')} — the source's values are written.`, 'success', 5000);
    if (typeof onSaved === 'function') onSaved();
  });
}
