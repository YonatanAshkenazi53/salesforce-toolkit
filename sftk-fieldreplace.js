'use strict';
// ═════════════════════════════════════════════════════════════════════════
// sftk-fieldreplace.js — "Replace with another field" (Field Cleaner)
// ═════════════════════════════════════════════════════════════════════════
// User 2026-10-04: "what if we want to remove the old field and assign a new
// field instead with the same type?" … "i want to add the replace field
// feature".
//
// Field Cleaner REMOVES a field's references so the field can be deleted.
// Removing changes what a flow does (a condition or an assignment simply
// goes), and sometimes leaves an element with nothing in it, which
// Salesforce refuses. When the field is being retired in favour of another
// one, the honest fix is to point every reference at the new field instead:
// the flow keeps its logic, the layout keeps its slot, the report keeps its
// column.
//
// Everything here is PURE — JSON in, JSON out, no DOM, no network — so real
// org payloads can be pinned as tests. field-cleaner.js reads, confirms,
// writes through sftkWriteVerified and re-reads.
//
// One rule runs through all of it: a reference is swapped only when it is
// KNOWN to be this object's field. A same-named field on another object, or
// a reference whose object cannot be worked out, is left alone and named.

function _sftkFrLow(s) { return String(s == null ? '' : s).toLowerCase(); }

// ── 1. May `newF` stand in for `oldF`? ───────────────────────────────────
// oldF / newF: the two entries of the object's describe (`fields[]`), or
// null when the describe does not list the field (a field the user cannot
// see is simply absent). Returns { ok, blockers[], warnings[] } — a blocker
// means the swap is not offered; a warning is shown and the user decides.
function sftkFieldReplaceCompat(oldF, newF) {
  const out = { ok: true, blockers: [], warnings: [] };
  if (!oldF || !newF) {
    out.blockers.push(`${!oldF ? 'the field being replaced' : 'the replacement field'} is not in the object's describe — a field your user cannot see (no field-level security) is not listed, so its type cannot be checked`);
    out.ok = false;
    return out;
  }
  if (_sftkFrLow(oldF.name) === _sftkFrLow(newF.name)) out.blockers.push('it is the same field');
  if (String(oldF.type) !== String(newF.type)) {
    out.blockers.push(`different type: ${oldF.name} is ${oldF.type}, ${newF.name} is ${newF.type}`);
  } else if (oldF.type === 'reference') {
    const a = (oldF.referenceTo || []).map(_sftkFrLow).sort().join(','), b = (newF.referenceTo || []).map(_sftkFrLow).sort().join(',');
    if (a !== b) out.blockers.push(`they look up different objects: ${oldF.name} → ${(oldF.referenceTo || []).join(', ') || '?'}, ${newF.name} → ${(newF.referenceTo || []).join(', ') || '?'}`);
  }
  if (out.blockers.length) { out.ok = false; return out; }

  if ((newF.calculated || newF.updateable === false) && !(oldF.calculated || oldF.updateable === false)) {
    out.warnings.push(`${newF.name} cannot be written (${newF.calculated ? 'a formula' : 'read-only'}): anything that only READS the field is fine, but a flow that SETS it will be refused by Salesforce when the new version is saved`);
  }
  if (oldF.type === 'picklist' || oldF.type === 'multipicklist') {
    const vals = f => (f.picklistValues || []).filter(v => v && v.active !== false).map(v => String(v.value));
    const have = new Set(vals(newF).map(_sftkFrLow));
    const missing = vals(oldF).filter(v => !have.has(_sftkFrLow(v)));
    if (missing.length) {
      out.warnings.push(`${newF.name} has no value ${missing.map(v => `“${v}”`).join(', ')}: a condition that compares against ${missing.length === 1 ? 'it' : 'them'} will never be true${newF.restrictedPicklist ? ', and a flow that writes one will fail when it runs (restricted picklist)' : ''}`);
    }
  }
  if (Number(newF.length) > 0 && Number(oldF.length) > Number(newF.length)) {
    out.warnings.push(`${newF.name} is shorter (${newF.length} characters, ${oldF.name} has ${oldF.length}): longer values will not fit`);
  }
  if (oldF.type === 'textarea' && String(oldF.extraTypeInfo || '') !== String(newF.extraTypeInfo || '')) {
    out.warnings.push(`${oldF.name} is ${oldF.extraTypeInfo || 'a text area'}, ${newF.name} is ${newF.extraTypeInfo || 'a text area'}`);
  }
  const whole = f => Number(f.precision || 0) - Number(f.scale || 0);
  if (Number(oldF.precision) > 0 && (whole(newF) < whole(oldF) || Number(newF.scale || 0) < Number(oldF.scale || 0))) {
    out.warnings.push(`${newF.name} holds smaller numbers (${whole(newF)} digits + ${Number(newF.scale || 0)} decimals; ${oldF.name}: ${whole(oldF)} + ${Number(oldF.scale || 0)})`);
  }
  return out;
}

// ── 2. Flows ─────────────────────────────────────────────────────────────
// Which object does each record resource of a flow hold? Map of lower-cased
// resource name → object API name. Only what the metadata states outright:
// the triggering record, record variables, Get Records elements, loop
// variables over those, collection-processor items, and the global records.
function sftkFlowResourceObjects(metadata) {
  const md = metadata || {};
  const m = new Map();
  const set = (name, obj) => { if (name && obj) m.set(_sftkFrLow(name), String(obj)); };
  set('$User', 'User'); set('$Profile', 'Profile'); set('$Organization', 'Organization'); set('$UserRole', 'UserRole');
  const startObj = md.start && md.start.object;
  if (startObj) { set('$Record', startObj); set('$Record__Prior', startObj); }
  for (const v of (md.variables || [])) if (v && String(v.dataType) === 'SObject' && v.objectType) set(v.name, v.objectType);
  for (const el of (md.recordLookups || [])) if (el && el.object) set(el.name, el.object);
  const collObj = ref => { const root = String(ref || '').split('.')[0]; return m.get(_sftkFrLow(root)); };
  for (const el of (md.loops || [])) if (el && el.collectionReference) set(el.name, collObj(el.collectionReference));
  for (const el of (md.collectionProcessors || [])) if (el && el.collectionReference) set(`currentItem_${el.name}`, collObj(el.collectionReference));
  return m;
}

// Keys whose value is a BARE field name, owned by the element's own object.
const SFTK_FR_FIELD_KEYS = new Set(['field', 'queriedFields', 'sortField', 'displayField', 'valueField']);
// Text that cannot hold a dependency — the same list sftkFlowRefScan skips,
// so "what the scan reports" and "what the swap looks at" are one set.
const SFTK_FR_TEXT_KEYS = new Set(['description', 'label', 'interviewLabel', 'defaultConnectorLabel', 'fullName', 'processType', 'status']);

// Swap every reference to objApi.oldApi for newApi, IN PLACE.
//   opts.chainOwner(rootObject, [relationshipName, …]) → object API name |
//       null (cannot be resolved). Called for references that travel through
//       a relationship ($Record.Account.Field__c): whose field it is depends
//       on the org's schema, which only the caller can read. Without it (or
//       when it answers undefined) such a reference is reported in `needs`
//       and left alone — run once to collect the needs, resolve, run again.
// Returns
//   changed  [{ path, before, after, n }]   strings rewritten (n occurrences)
//   skipped  [{ path, value, why, object }] mentions left alone:
//            why 'other'   → the field of ANOTHER object (object names it)
//            why 'unknown' → the object could not be worked out
//   needs    [{ rootObj, rels }]            relationship chains to resolve
function sftkFlowReplaceField(metadata, objApi, oldApi, newApi, opts) {
  const out = { changed: [], skipped: [], needs: [] };
  const oldL = _sftkFrLow(oldApi), objL = _sftkFrLow(objApi);
  if (!metadata || !oldL || !newApi) return out;
  const res = sftkFlowResourceObjects(metadata);
  const chainOwner = opts && typeof opts.chainOwner === 'function' ? opts.chainOwner : null;
  const needKeys = new Set();
  // An identifier or a dotted path: $Record.Account.Field__c, acct.Field__c, Field__c
  const TOKEN = /[$A-Za-z_][\w$]*(?:\.[A-Za-z_]\w*)*/g;

  // The element a path sits in, and the object that element works on.
  const elementOf = path => {
    const top = path[0];
    if (Array.isArray(metadata[top]) && typeof path[1] === 'number') return metadata[top][path[1]] || null;
    return (metadata[top] && typeof metadata[top] === 'object') ? metadata[top] : null;
  };
  // { owner } | { unknown } | { need } for a dotted reference (segments without the field).
  const ownerOfPath = segs => {
    let root = segs[0], rels = segs.slice(1);
    let rootObj;
    if (_sftkFrLow(root) === '$setup') { rootObj = rels[0]; rels = rels.slice(1); if (!rootObj) return { unknown: true }; }
    else rootObj = res.get(_sftkFrLow(root)) || (_sftkFrLow(root) === objL && segs.length === 1 ? objApi : undefined);
    if (!rootObj) return { unknown: true };
    if (!rels.length) return { owner: rootObj };
    const ans = chainOwner ? chainOwner(rootObj, rels) : undefined;
    if (ans === undefined) {
      const k = `${_sftkFrLow(rootObj)}|${rels.map(_sftkFrLow).join('.')}`;
      if (!needKeys.has(k)) { needKeys.add(k); out.needs.push({ rootObj, rels }); }
      return { need: true };
    }
    return ans ? { owner: String(ans) } : { unknown: true };
  };
  // The object a BARE field name belongs to: the element's own object.
  const ownerOfBare = path => {
    const key = [...path].reverse().find(k => typeof k === 'string');
    if (!SFTK_FR_FIELD_KEYS.has(key)) return { unknown: true };
    const el = elementOf(path);
    if (!el) return { unknown: true };
    if (el.object) return { owner: String(el.object) };
    if (path[0] === 'start' && metadata.start && metadata.start.object) return { owner: String(metadata.start.object) };
    const ref = el.inputReference || el.collectionReference;
    if (ref) return ownerOfPath(String(ref).split('.'));
    return { unknown: true };
  };

  (function walk(v, path, parent, key) {
    if (v == null) return;
    if (typeof v === 'string') {
      if (!_sftkFrLow(v).includes(oldL)) return;
      let n = 0; const left = [];
      const after = v.replace(TOKEN, (tok) => {
        const segs = tok.split('.');
        const last = segs[segs.length - 1];
        if (_sftkFrLow(last) !== oldL) {
          // the field in the MIDDLE of a path cannot be judged — name it, leave it
          if (segs.slice(0, -1).some(s => _sftkFrLow(s) === oldL)) left.push({ why: 'unknown' });
          return tok;
        }
        const verdict = segs.length === 1 ? (tok === v ? ownerOfBare(path) : { unknown: true }) : ownerOfPath(segs.slice(0, -1));
        if (verdict.owner && _sftkFrLow(verdict.owner) === objL) { n++; return [...segs.slice(0, -1), newApi].join('.'); }
        left.push(verdict.owner ? { why: 'other', object: verdict.owner } : { why: verdict.need ? 'need' : 'unknown' });
        return tok;
      });
      for (const l of left) if (l.why !== 'need') out.skipped.push({ path, value: v, why: l.why, object: l.object || null });
      if (n) { parent[key] = after; out.changed.push({ path, before: v, after, n }); }
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, [...path, i], v, i)); return; }
    if (typeof v === 'object') for (const k of Object.keys(v)) { if (!SFTK_FR_TEXT_KEYS.has(k)) walk(v[k], [...path, k], v, k); }
  })(metadata, [], null, null);
  return out;
}

// ── 3. Page layouts ──────────────────────────────────────────────────────
// The new field takes the old field's slot. When the new field is already on
// the layout the old slot becomes a blank space instead (a field may sit on
// a layout once). opts.readOnly: the new field cannot be edited (a formula)
// — its item is marked Readonly, the only behaviour Salesforce accepts.
// Returns { swapped, blanked }.
function sftkLayoutReplaceField(metadata, oldApi, newApi, opts) {
  const o = _sftkFrLow(oldApi), n = _sftkFrLow(newApi);
  const items = [];
  for (const section of ((metadata && metadata.layoutSections) || [])) {
    for (const col of (section.layoutColumns || [])) {
      if (Array.isArray(col.layoutItems)) col.layoutItems.forEach((it, i) => items.push({ arr: col.layoutItems, i, it }));
    }
  }
  let hasNew = items.some(x => x.it && _sftkFrLow(x.it.field) === n);
  let swapped = 0, blanked = 0;
  for (const x of items) {
    if (!x.it || _sftkFrLow(x.it.field) !== o) continue;
    if (hasNew) { x.arr[x.i] = { emptySpace: true }; blanked++; continue; }
    x.it.field = newApi;
    if (opts && opts.readOnly) x.it.behavior = 'Readonly';
    hasNew = true; swapped++;
  }
  return { swapped, blanked };
}

// ── 4. Lightning pages ───────────────────────────────────────────────────
// Field components and visibility conditions that name THIS record's field
// (Record.Field, bare Field, Object.Field) are pointed at the new field. A
// field that travels through a relationship (Record.Parent__r.Field) belongs
// to another object and is left alone. When the page already shows the new
// field, the old field's component is dropped rather than shown twice.
// Returns { swapped, dropped, left }.
function sftkFlexiReplaceField(metadata, objApi, oldApi, newApi) {
  const o = _sftkFrLow(oldApi), obj = _sftkFrLow(objApi);
  const out = { swapped: 0, dropped: 0, left: 0 };
  // null = not a reference to the field; else the string with the field swapped
  const swap = str => {
    if (typeof str !== 'string') return null;
    const wrapped = /^\{!.*\}$/.test(str);
    const body = wrapped ? str.slice(2, -1) : str;
    const segs = body.split('.');
    if (_sftkFrLow(segs[segs.length - 1]) !== o) return null;
    const head = segs.slice(0, -1).map(_sftkFrLow).join('.');
    if (!(head === '' || head === 'record' || head === '$record' || head === 'objectrecord' || head === obj)) { out.left++; return null; }
    const body2 = [...segs.slice(0, -1), newApi].join('.');
    return wrapped ? `{!${body2}}` : body2;
  };
  const isNewRef = str => {
    if (typeof str !== 'string') return false;
    const body = /^\{!.*\}$/.test(str) ? str.slice(2, -1) : str;
    const segs = body.split('.');
    return segs.length <= 2 && _sftkFrLow(segs[segs.length - 1]) === _sftkFrLow(newApi);
  };
  const FIELD_PROPS = ['fieldApiName', 'field', 'fieldName'];
  // does the page already show the new field as a field component?
  let hasNew = false;
  (function look(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(look); return; }
    if (isNewRef(node.fieldItem)) hasNew = true;
    if (FIELD_PROPS.includes(node.name) && isNewRef(node.value)) hasNew = true;
    for (const k of Object.keys(node)) look(node[k]);
  })(metadata);

  // The rule lives under `visibilityRule` (what the Tooling API returns, read
  // live 2026-10-04); `componentVisibilityRule` is honoured too. A right-hand
  // side is only a field when it is written as a merge field ({!Record.X}).
  const visibility = inst => {
    for (const key of ['visibilityRule', 'componentVisibilityRule']) {
      const rule = inst && inst[key];
      for (const c of ((rule && rule.criteria) || [])) {
        const l = swap(c.leftValue); if (l != null) { c.leftValue = l; out.swapped++; }
        const isMerge = v => typeof v === 'string' && v.startsWith('{!');
        if (isMerge(c.rightValue)) { const r = swap(c.rightValue); if (r != null) { c.rightValue = r; out.swapped++; } }
        else if (c.rightValue && typeof c.rightValue === 'object' && isMerge(c.rightValue.value)) { const r = swap(c.rightValue.value); if (r != null) { c.rightValue.value = r; out.swapped++; } }
      }
    }
  };
  // true = drop this instance
  const fieldInstance = fi => {
    const s = swap(fi.fieldItem);
    if (s != null) { if (hasNew) { out.dropped++; return true; } fi.fieldItem = s; hasNew = true; out.swapped++; }
    visibility(fi);
    return false;
  };
  const componentInstance = ci => {
    let drop = false;
    for (const p of (Array.isArray(ci.componentInstanceProperties) ? ci.componentInstanceProperties : [])) {
      if (!FIELD_PROPS.includes(p.name)) continue;
      const s = swap(p.value);
      if (s == null) continue;
      if (hasNew) { drop = true; break; }
      p.value = s; hasNew = true; out.swapped++;
    }
    if (drop) { out.dropped++; return true; }
    visibility(ci);
    container(ci);
    return false;
  };
  function container(c) {
    if (!c || typeof c !== 'object') return;
    if (Array.isArray(c.componentInstances)) c.componentInstances = c.componentInstances.filter(ci => !componentInstance(ci));
    if (Array.isArray(c.itemInstances)) c.itemInstances = c.itemInstances.filter(item => {
      if (item.fieldInstance && fieldInstance(item.fieldInstance)) return false;
      if (item.componentInstance && componentInstance(item.componentInstance)) return false;
      return true;
    });
    if (Array.isArray(c.fieldInstances)) c.fieldInstances = c.fieldInstances.filter(fi => !fieldInstance(fi));
    if (Array.isArray(c.flexiPageRegions)) c.flexiPageRegions.forEach(container);
  }
  ((metadata && metadata.flexiPageRegions) || []).forEach(container);
  return out;
}

// ── 5. Reports ───────────────────────────────────────────────────────────
// Columns, filters and groupings that name Object.oldField (the 'definite'
// tokens of sftk-reportclean.js) name Object.newField instead. A column the
// report already has is not added twice. Formulas, buckets, cross filters
// and charts are never auto-edited — they are named as manual, like the
// remover does. tokenMatch is sftkRptTokenMatch (passed in: this file stays
// free of load-order assumptions).
// Returns { meta, swapped: {columns,filters,groupings}, manual[], changed }.
function sftkRptReplaceField(meta, objectApi, oldApi, newApi, tokenMatch, fieldHits) {
  const m = JSON.parse(JSON.stringify(meta || {}));
  const swapped = { columns: 0, filters: 0, groupings: 0 };
  const manual = [];
  const isHit = t => tokenMatch(t, objectApi, oldApi) === 'definite';
  // keep the token's own spelling (Account.Field / Account$Field / prefix!Account.Field)
  const re = t => String(t).slice(0, String(t).length - String(oldApi).length) + newApi;

  const cols = m.detailColumns || [];
  if (cols.some(isHit)) {
    const seen = new Set(cols.filter(c => !isHit(c)).map(_sftkFrLow));
    const next = [];
    for (const c of cols) {
      if (!isHit(c)) { next.push(c); continue; }
      const nc = re(c);
      swapped.columns++;
      if (!seen.has(_sftkFrLow(nc))) { seen.add(_sftkFrLow(nc)); next.push(nc); }
    }
    m.detailColumns = next;
  }
  for (const f of (m.reportFilters || [])) {
    if (f && isHit(f.column)) { f.column = re(f.column); swapped.filters++; }
  }
  for (const key of ['groupingsDown', 'groupingsAcross']) {
    const gs = m[key] || [];
    const names = new Set(gs.filter(g => g && !isHit(g.name)).map(g => _sftkFrLow(g.name)));
    for (const g of gs) {
      if (!g || !isHit(g.name)) continue;
      const nn = re(g.name);
      if (names.has(_sftkFrLow(nn))) { manual.push(`the report is already grouped by ${nn} — regroup it by hand`); continue; }
      names.add(_sftkFrLow(nn)); g.name = nn; swapped.groupings++;
    }
  }
  if (typeof fieldHits === 'function') {
    const hits = fieldHits(meta, objectApi, oldApi);
    if (hits.elsewhere) manual.push('it is referenced in a formula, bucket, cross filter or chart — those are never auto-edited; open the report to fix them');
    for (const p of [...new Set(hits.possible || [])]) manual.push(`“${p}” matches the field name but not the object — left alone (could belong to another object); verify by hand`);
  }
  return { meta: m, swapped, manual, changed: !!(swapped.columns || swapped.filters || swapped.groupings) };
}

// ── 6. Field access ──────────────────────────────────────────────────────
// Whoever could see or edit the old field should be able to see or edit the
// new one, or the swapped flow / layout shows them nothing. oldRows /
// newRows: FieldPermissions rows ({ Id, ParentId, PermissionsRead,
// PermissionsEdit, Parent… }) of the two fields. Access is only ever ADDED:
// a grant the new field already has is never lowered. opts.readOnly: the new
// field cannot be edited (a formula) — only read access is copied.
// Returns { create[], update[], same }.
function sftkFlsCopyPlan(oldRows, newRows, objApi, newApi, opts) {
  const ro = !!(opts && opts.readOnly);
  const byParent = new Map((newRows || []).filter(r => r && r.ParentId).map(r => [String(r.ParentId), r]));
  const out = { create: [], update: [], same: 0 };
  const who = r => (r.Parent && (r.Parent.IsOwnedByProfile ? ((r.Parent.Profile && r.Parent.Profile.Name) || r.Parent.Label) : r.Parent.Label)) || r.ParentId;
  for (const r of (oldRows || [])) {
    if (!r || !r.ParentId || !(r.PermissionsRead || r.PermissionsEdit)) continue;
    const wantRead = true, wantEdit = !!r.PermissionsEdit && !ro;
    const have = byParent.get(String(r.ParentId));
    const kind = r.Parent && r.Parent.IsOwnedByProfile ? 'Profile' : 'Permission set';
    if (!have) {
      out.create.push({ who: who(r), kind, body: { ParentId: r.ParentId, SobjectType: objApi, Field: `${objApi}.${newApi}`, PermissionsRead: wantRead, PermissionsEdit: wantEdit } });
    } else if ((wantRead && !have.PermissionsRead) || (wantEdit && !have.PermissionsEdit)) {
      out.update.push({ who: who(r), kind, id: have.Id, parentId: r.ParentId,
        before: { PermissionsRead: !!have.PermissionsRead, PermissionsEdit: !!have.PermissionsEdit },
        after: { PermissionsRead: true, PermissionsEdit: !!have.PermissionsEdit || wantEdit } });
    } else out.same++;
  }
  return out;
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkFieldReplaceCompat = sftkFieldReplaceCompat;
  globalThis.sftkFlowResourceObjects = sftkFlowResourceObjects;
  globalThis.sftkFlowReplaceField = sftkFlowReplaceField;
  globalThis.sftkLayoutReplaceField = sftkLayoutReplaceField;
  globalThis.sftkFlexiReplaceField = sftkFlexiReplaceField;
  globalThis.sftkRptReplaceField = sftkRptReplaceField;
  globalThis.sftkFlsCopyPlan = sftkFlsCopyPlan;
}
