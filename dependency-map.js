// Dependency Map module — builds and renders the subflow dependency map

// Extract every external reference from ONE flow's Metadata (N4a — blast
// radius). Walks the element types that name objects/fields explicitly, then
// sweeps the raw metadata text for $Record.Field / $Label.Name references
// (formulas, templates). Pure — unit-testable (top-level for extract.mjs).
function sftkFlowRefs(meta) {
  const objects = new Map();   // object → Set(ops)
  const fields = new Set(), subflows = new Set(), apex = new Set(), labels = new Set();
  if (!meta || typeof meta !== 'object') {
    return { objects: [], fields: [], subflows: [], apex: [], labels: [] };
  }
  const arr = x => Array.isArray(x) ? x : [];
  const addObj = (o, op) => { if (!o) return; if (!objects.has(o)) objects.set(o, new Set()); objects.get(o).add(op); };
  const addField = (obj, f) => { if (f) fields.add(obj ? `${obj}.${f}` : String(f)); };

  const st = meta.start || {};
  if (st.object) { addObj(st.object, 'trigger'); arr(st.filters).forEach(f => addField(st.object, f.field)); }
  for (const rl of arr(meta.recordLookups)) {
    addObj(rl.object, 'read');
    arr(rl.filters).forEach(f => addField(rl.object, f.field));
    arr(rl.queriedFields).forEach(f => addField(rl.object, f));
    arr(rl.outputAssignments).forEach(a => addField(rl.object, a.field));
  }
  for (const rc of arr(meta.recordCreates)) { addObj(rc.object, 'create'); arr(rc.inputAssignments).forEach(a => addField(rc.object, a.field)); }
  for (const ru of arr(meta.recordUpdates)) { addObj(ru.object, 'update'); arr(ru.filters).forEach(f => addField(ru.object, f.field)); arr(ru.inputAssignments).forEach(a => addField(ru.object, a.field)); }
  for (const rd of arr(meta.recordDeletes)) { addObj(rd.object, 'delete'); arr(rd.filters).forEach(f => addField(rd.object, f.field)); }
  for (const v of arr(meta.variables)) if (v.objectType) addObj(v.objectType, 'variable');
  for (const d of arr(meta.dynamicChoiceSets)) {
    if (d.object) { addObj(d.object, 'choice'); addField(d.object, d.displayField); addField(d.object, d.valueField); }
    if (d.picklistObject) { addObj(d.picklistObject, 'choice'); addField(d.picklistObject, d.picklistField); }
  }
  for (const sf of arr(meta.subflows)) if (sf.flowName) subflows.add(sf.flowName);
  for (const ac of arr(meta.actionCalls)) if (ac.actionName && /apex/i.test(ac.actionType || '')) apex.add(ac.actionName);
  for (const ap of arr(meta.apexPluginCalls)) if (ap.apexClass) apex.add(ap.apexClass);

  const txt = JSON.stringify(meta);
  let m;
  const recRe = /\$Record\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?)/g;
  while ((m = recRe.exec(txt))) addField(st.object || '$Record', m[1]);
  const labRe = /\$Label\.([A-Za-z0-9_]+)/g;
  while ((m = labRe.exec(txt))) labels.add(m[1]);

  return {
    objects: [...objects.entries()].map(([name, ops]) => ({ name, ops: [...ops].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    fields: [...fields].sort(),
    subflows: [...subflows].sort(),
    apex: [...apex].sort(),
    labels: [...labels].sort(),
  };
}

// ══════════════════════════════════════════════════════════════════════
// N4c / N4d / N4e — PURE helpers.
// Every function below is top-level, column-0 and references NO file-level
// state, so test/deps-n4.test.mjs can materialise each one standalone via
// test/extract.mjs. Keep them that way.
// ══════════════════════════════════════════════════════════════════════

// N4d — transitive subflow chain.
// `dependencyMap` is the flat index the module already builds:
//   calledApiName -> [{ id, apiName, masterLabel, status, processType, … }]
// dir 'down' → the subflows this flow calls, and what THEY call.
// dir 'up'   → the flows that call it, and what calls THEM.
// Cycle-safe: a node already on the current path is flagged `cycle` and NOT
// expanded, so A→B→A terminates instead of hanging the popup.
// Depth-capped: a node sitting at the cap that still has children is flagged
// `truncated` — the UI must say so rather than pretend the chain ends there.
function depChain(dependencyMap, apiName, dir, maxDepth) {
  const map = (dependencyMap && typeof dependencyMap === 'object') ? dependencyMap : {};
  const cap = (typeof maxDepth === 'number' && isFinite(maxDepth) && maxDepth > 0)
    ? Math.floor(maxDepth) : 6;
  const goDown = String(dir || 'down').toLowerCase() !== 'up';
  const rootName = String(apiName || '');

  // The map is stored child→parents; invert it once for the downstream walk.
  const kids = {};      // parentApiName -> [calledApiName]
  const known = {};     // apiName -> { masterLabel, status, processType } (from caller records)
  for (const called of Object.keys(map)) {
    const parents = Array.isArray(map[called]) ? map[called] : [];
    for (const p of parents) {
      const pn = p && p.apiName;
      if (!pn) continue;
      if (!kids[pn]) kids[pn] = [];
      if (kids[pn].indexOf(called) === -1) kids[pn].push(called);
      if (!known[pn]) {
        known[pn] = {
          masterLabel: p.masterLabel || pn,
          status: p.status || null,
          processType: p.processType || null
        };
      }
    }
  }

  const nextOf = (n) => {
    if (goDown) return (kids[n] || []).slice().sort();
    const out = [];
    for (const p of (Array.isArray(map[n]) ? map[n] : [])) {
      const pn = p && p.apiName;
      if (pn && out.indexOf(pn) === -1) out.push(pn);
    }
    return out.sort();
  };

  const stats = { nodes: 0, edges: 0, deepest: 0, cycles: 0, truncated: 0 };
  const build = (name, depth, path) => {
    const meta = known[name] || {};
    const node = {
      apiName: name,
      depth,
      masterLabel: meta.masterLabel || name,
      status: meta.status || null,
      processType: meta.processType || null,
      cycle: false,
      truncated: false,
      children: []
    };
    stats.nodes++;
    if (depth > stats.deepest) stats.deepest = depth;
    // Already an ancestor on THIS path → cycle. Flag and stop descending.
    if (path.indexOf(name) !== -1) { node.cycle = true; stats.cycles++; return node; }
    const nxt = nextOf(name);
    if (!nxt.length) return node;
    if (depth >= cap) { node.truncated = true; stats.truncated++; return node; }
    const nextPath = path.concat([name]);
    for (const c of nxt) { stats.edges++; node.children.push(build(c, depth + 1, nextPath)); }
    return node;
  };

  return {
    apiName: rootName,
    dir: goDown ? 'down' : 'up',
    maxDepth: cap,
    root: build(rootName, 0, []),
    stats
  };
}

// N4d — dead-subflow detection.
//   dependencyMap  : calledApiName -> [caller records]
//   flowsByApiName : apiName -> [flow version records ({ Status, MasterLabel, VersionNumber })]
// Returns three separate buckets, because they are three different problems:
//   dead            — the target EXISTS but no ACTIVE flow calls it
//   missing         — a subflow reference points at an API name that does not
//                     exist in this org at all (hard runtime failure)
//   inactiveTargets — the target exists but has NO Active version (also a hard
//                     runtime failure; the tree used to only mark "Not found")
// "No active caller" is NOT proof a flow is unused — buttons, Apex, REST and
// scheduled paths can start a flow too. Callers must say so in the UI.
function depDeadSubflows(dependencyMap, flowsByApiName) {
  const map = (dependencyMap && typeof dependencyMap === 'object') ? dependencyMap : {};
  const byName = (flowsByApiName && typeof flowsByApiName === 'object') ? flowsByApiName : {};
  const dead = [], missing = [], inactiveTargets = [];

  const callersOf = (arr) => {
    const out = [], seen = {};
    for (const p of (Array.isArray(arr) ? arr : [])) {
      const n = p && p.apiName;
      if (!n || seen[n]) continue;
      seen[n] = 1;
      out.push({ apiName: n, masterLabel: p.masterLabel || n, status: p.status || null });
    }
    return out.sort((a, b) => a.apiName.localeCompare(b.apiName));
  };

  for (const called of Object.keys(map).sort()) {
    const callers = callersOf(map[called]);
    const activeCallers = callers.filter(c => c.status === 'Active');
    const versions = Array.isArray(byName[called]) ? byName[called] : [];
    const activeVersion = versions.find(v => v && v.Status === 'Active') || null;

    if (!versions.length) {
      missing.push({ apiName: called, callers, activeCallerCount: activeCallers.length });
      continue;   // a flow that does not exist can't also be "dead"
    }
    const best = activeVersion || versions[versions.length - 1] || {};
    if (!activeVersion) {
      inactiveTargets.push({
        apiName: called,
        masterLabel: best.MasterLabel || called,
        status: best.Status || 'Unknown',
        callers,
        activeCallerCount: activeCallers.length
      });
    }
    if (!activeCallers.length) {
      dead.push({
        apiName: called,
        masterLabel: best.MasterLabel || called,
        status: best.Status || 'Unknown',
        selfActive: !!activeVersion,
        callers,
        reason: callers.length
          ? `Called by ${callers.length} flow(s) — none of them Active`
          : 'Referenced as a subflow but the calling flow could not be identified'
      });
    }
  }

  return {
    dead, missing, inactiveTargets,
    counts: {
      subflowTargets: Object.keys(map).length,
      dead: dead.length,
      missing: missing.length,
      inactiveTargets: inactiveTargets.length
    }
  };
}

// N4c — compare ONE flow's references against another org's schema.
//   refs              : sftkFlowRefs(meta) output
//   describesByObject : { ObjectApiName: { fields:[{name}] }   → described OK
//                       , ObjectApiName: null                  → confirmed ABSENT in target
//                       , ObjectApiName: { error: 'why' }      → could NOT be checked
//                       , (key absent)                         → was never described }
// The three "could not check" cases are kept separate from real misses on
// purpose — reporting an unchecked object as "missing" would be a lie.
function depRefsMissingIn(refs, describesByObject) {
  const r = (refs && typeof refs === 'object') ? refs : {};
  const d = (describesByObject && typeof describesByObject === 'object') ? describesByObject : {};
  const objects = Array.isArray(r.objects) ? r.objects : [];
  const fieldRefs = Array.isArray(r.fields) ? r.fields : [];

  const idx = {};   // lowercased object name -> { state, fields?, reason? }
  for (const key of Object.keys(d)) {
    const v = d[key];
    const lk = String(key).toLowerCase();
    if (v === null) { idx[lk] = { state: 'absent' }; continue; }
    if (!v || typeof v !== 'object') { idx[lk] = { state: 'unchecked', reason: 'no describe returned' }; continue; }
    if (v.error) { idx[lk] = { state: 'unchecked', reason: String(v.error) }; continue; }
    const fset = {};
    for (const f of (Array.isArray(v.fields) ? v.fields : [])) {
      const n = f && (f.name || f.Name || f.QualifiedApiName);
      if (n) fset[String(n).toLowerCase()] = 1;
    }
    idx[lk] = { state: 'ok', fields: fset };
  }

  const missingObjects = [], missingFields = [], uncheckedObjects = [], uncheckedFields = [];
  const checkedObjects = [];

  for (const o of objects) {
    const name = o && o.name;
    if (!name) continue;
    const ops = Array.isArray(o.ops) ? o.ops : [];
    const e = idx[String(name).toLowerCase()];
    if (!e) { uncheckedObjects.push({ name: String(name), ops, reason: 'not described in the comparison org' }); continue; }
    if (e.state === 'absent') { missingObjects.push({ name: String(name), ops }); continue; }
    if (e.state === 'unchecked') { uncheckedObjects.push({ name: String(name), ops, reason: e.reason || 'describe failed' }); continue; }
    checkedObjects.push(String(name));
  }

  for (const raw of fieldRefs) {
    const ref = String(raw || '');
    if (!ref) continue;
    const dot = ref.indexOf('.');
    if (dot < 1) { uncheckedFields.push({ ref, reason: 'no object context on this reference' }); continue; }
    const objPart = ref.slice(0, dot);
    const rest = ref.slice(dot + 1);
    if (objPart.charAt(0) === '$') { uncheckedFields.push({ ref, reason: 'formula/template reference with no resolvable object' }); continue; }
    if (rest.indexOf('.') !== -1) { uncheckedFields.push({ ref, reason: 'relationship traversal — needs the related object to resolve' }); continue; }
    const e = idx[objPart.toLowerCase()];
    if (!e) { uncheckedFields.push({ ref, reason: `${objPart} was not described in the comparison org` }); continue; }
    if (e.state === 'absent') { missingFields.push({ ref, object: objPart, field: rest, reason: 'the object itself is missing in the comparison org' }); continue; }
    if (e.state === 'unchecked') { uncheckedFields.push({ ref, reason: `${objPart} could not be described: ${e.reason || 'unknown'}` }); continue; }
    if (!e.fields[rest.toLowerCase()]) {
      missingFields.push({ ref, object: objPart, field: rest, reason: 'field not present on that object in the comparison org' });
    }
  }

  const byName = (a, b) => String(a.name || a.ref || '').localeCompare(String(b.name || b.ref || ''));
  missingObjects.sort(byName); missingFields.sort(byName);
  uncheckedObjects.sort(byName); uncheckedFields.sort(byName);

  return {
    missingObjects, missingFields, uncheckedObjects, uncheckedFields,
    checkedObjects: checkedObjects.sort(),
    breakCount: missingObjects.length + missingFields.length,
    uncheckedCount: uncheckedObjects.length + uncheckedFields.length,
    ok: (missingObjects.length + missingFields.length) === 0
  };
}

// N4c — which of `names` are absent from `presentNames` (case-insensitive).
// Used for subflow targets and Apex class names in the comparison org.
function depMissingNames(names, presentNames) {
  const have = {};
  for (const n of (Array.isArray(presentNames) ? presentNames : [])) {
    if (n) have[String(n).toLowerCase()] = 1;
  }
  const out = [];
  for (const n of (Array.isArray(names) ? names : [])) {
    if (!n) continue;
    const s = String(n);
    if (!have[s.toLowerCase()] && out.indexOf(s) === -1) out.push(s);
  }
  return out.sort();
}

// N4e — render the whole dependency report as Markdown. Pure so the exact
// text is unit-testable. Every section degrades to an explicit "not run" /
// "none" line rather than silently vanishing.
function depReportMarkdown(report) {
  const r = (report && typeof report === 'object') ? report : {};
  const org = r.org || {};
  const L = [];
  const push = s => L.push(s);
  const esc = v => String(v === null || v === undefined ? '' : v)
    .replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

  push('# Flow dependency report');
  push('');
  push(`- **Org:** ${esc(org.label || org.url || 'unknown')}`);
  if (org.url) push(`- **Org URL:** ${esc(org.url)}`);
  push(`- **Generated:** ${esc(r.generatedAt || '')}`);
  push(`- **Flows in scope:** ${r.flowCount === undefined || r.flowCount === null ? 'unknown' : r.flowCount}`);
  if (r.scanComplete === false) {
    push('- **⚠ The metadata scan had NOT finished when this was exported** — every section below is incomplete.');
  }
  push('');
  const notes = Array.isArray(r.notes) ? r.notes : [];
  if (notes.length) {
    push('> **Limits of this report**');
    for (const n of notes) push(`> - ${esc(n)}`);
    push('');
  }

  // ── 1. dead subflows ────────────────────────────────────────────────
  const dead = r.dead || {};
  const dl = Array.isArray(dead.dead) ? dead.dead : [];
  const ml = Array.isArray(dead.missing) ? dead.missing : [];
  const il = Array.isArray(dead.inactiveTargets) ? dead.inactiveTargets : [];
  push('## 1. Dead subflows & broken subflow references');
  push('');
  push(`### 1.1 Dead subflows — no ACTIVE caller (${dl.length})`);
  push('');
  push('_A flow with no Active caller is a **candidate**, not a verdict: buttons, Apex, REST, packaged code and scheduled paths can all start a flow without a parent flow._');
  push('');
  if (!dl.length) {
    push('_None — every flow called as a subflow has at least one Active caller._');
  } else {
    push('| Subflow | Its own status | Callers | Why it looks dead |');
    push('| --- | --- | --- | --- |');
    for (const x of dl) {
      const cs = (x.callers || []).map(c => `${c.apiName} (${c.status || '?'})`).join(', ') || '—';
      push(`| ${esc(x.apiName)} | ${esc(x.status)} | ${esc(cs)} | ${esc(x.reason)} |`);
    }
  }
  push('');
  push(`### 1.2 Subflow references pointing at a flow that does NOT exist (${ml.length})`);
  push('');
  if (!ml.length) push('_None._');
  else {
    push('| Referenced API name | Called by |');
    push('| --- | --- |');
    for (const x of ml) {
      push(`| ${esc(x.apiName)} | ${esc((x.callers || []).map(c => `${c.apiName} (${c.status || '?'})`).join(', ') || '—')} |`);
    }
  }
  push('');
  push(`### 1.3 Subflow references pointing at a flow with NO Active version (${il.length})`);
  push('');
  if (!il.length) push('_None._');
  else {
    push('| Referenced API name | Best version status | Called by |');
    push('| --- | --- | --- |');
    for (const x of il) {
      push(`| ${esc(x.apiName)} | ${esc(x.status)} | ${esc((x.callers || []).map(c => `${c.apiName} (${c.status || '?'})`).join(', ') || '—')} |`);
    }
  }
  push('');

  // ── 2. chains ───────────────────────────────────────────────────────
  const chains = Array.isArray(r.chains) ? r.chains : [];
  push(`## 2. Subflow chains (${chains.length})`);
  push('');
  const walk = (node, indent, acc) => {
    if (!node) return acc;
    const bits = [];
    if (node.status) bits.push(node.status);
    if (node.exists === false) bits.push('NOT FOUND in this org');
    else if (node.exists === true && node.selfActive === false) bits.push('no Active version');
    if (node.cycle) bits.push('↻ cycle — already higher in this chain, not expanded');
    if (node.truncated) bits.push('… deeper levels not expanded (depth cap reached)');
    acc.push(`${'  '.repeat(indent)}- ${node.apiName}${bits.length ? ` — _${bits.join('; ')}_` : ''}`);
    for (const c of (node.children || [])) walk(c, indent + 1, acc);
    return acc;
  };
  if (!chains.length) push('_No subflow relationships found in this org._');
  for (const ch of chains) {
    push(`### ${esc(ch.masterLabel || ch.apiName)} (\`${esc(ch.apiName)}\`)`);
    push('');
    push('**Calls (downstream):**');
    push('');
    const dAcc = walk(ch.down && ch.down.root, 0, []);
    if (dAcc.length <= 1) push('_Calls no subflows._');
    else for (const s of dAcc) push(s);
    push('');
    push('**Called by (upstream):**');
    push('');
    const uAcc = walk(ch.up && ch.up.root, 0, []);
    if (uAcc.length <= 1) push('_No flow calls this one._');
    else for (const s of uAcc) push(s);
    push('');
  }

  // ── 3. blast radius ─────────────────────────────────────────────────
  const blast = Array.isArray(r.blast) ? r.blast : [];
  push(`## 3. Blast radius — what each flow touches (${blast.length})`);
  push('');
  if (!blast.length) push('_No flow reference data available._');
  for (const b of blast) {
    push(`### ${esc(b.masterLabel || b.apiName)} — ${esc(b.status)}`);
    push('');
    if (b.verdict) { push(esc(b.verdict)); push(''); }
    const refs = b.refs || {};
    const secs = [
      ['Called by', (b.callers || []).map(c => `${c.masterLabel || c.apiName} (${c.status || '?'})`)],
      ['Objects', (refs.objects || []).map(o => `${o.name} [${(o.ops || []).join(' · ')}]`)],
      ['Fields', (refs.fields || []).slice()],
      ['Calls subflows', (refs.subflows || []).slice()],
      ['Apex actions', (refs.apex || []).slice()],
      ['Custom labels', (refs.labels || []).slice()]
    ];
    let any = false;
    for (const s of secs) {
      const items = s[1] || [];
      if (!items.length) continue;
      any = true;
      push(`- **${s[0]} (${items.length}):** ${esc(items.join(', '))}`);
    }
    if (!any) push('_No object/field/subflow/apex/label references captured for this version._');
    push('');
  }

  // ── 4. cross-org diff ───────────────────────────────────────────────
  const xo = r.crossOrg;
  push('## 4. Cross-org dependency diff');
  push('');
  if (!xo) {
    push('_Not run — open the Dependencies tab and use 🔀 Cross-org diff to compare against another org._');
    push('');
    return L.join('\n');
  }
  const tgt = xo.target || {};
  const rows = Array.isArray(xo.rows) ? xo.rows : [];
  push(`- **Comparison org:** ${esc(tgt.label || tgt.url || 'unknown')}`);
  if (tgt.url) push(`- **Comparison org URL:** ${esc(tgt.url)}`);
  push(`- **Flows compared:** ${rows.length}`);
  push('- **Read-only:** nothing was written to either org.');
  push('');
  for (const n of (Array.isArray(xo.notes) ? xo.notes : [])) push(`> ⚠ ${esc(n)}`);
  if ((xo.notes || []).length) push('');
  const bad = rows.filter(x => x.presence !== 'ok' || (x.missingObjects || []).length
    || (x.missingFields || []).length || (x.missingSubflows || []).length || (x.missingApex || []).length);
  push(`### 4.1 Summary — ${bad.length} of ${rows.length} flow(s) have a problem in the comparison org`);
  push('');
  push('| Flow | In target | Active there | Missing objects | Missing fields | Missing subflows | Missing Apex |');
  push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const x of rows) {
    push(`| ${esc(x.apiName)} | ${x.presence === 'missing' ? 'NO' : 'yes'} | ${x.presence === 'ok' ? 'yes' : (x.presence === 'inactive' ? 'NO' : '—')} | ${(x.missingObjects || []).length} | ${(x.missingFields || []).length} | ${(x.missingSubflows || []).length} | ${x.apexChecked === false ? 'not checked' : (x.missingApex || []).length} |`);
  }
  push('');
  push('### 4.2 Detail');
  push('');
  if (!bad.length) push('_Every compared flow exists, is Active, and all of its checked references resolve in the comparison org._');
  for (const x of bad) {
    push(`#### ${esc(x.masterLabel || x.apiName)} (\`${esc(x.apiName)}\`)`);
    push('');
    if (x.presence === 'missing') push('- ❌ **Does not exist in the comparison org.**');
    else if (x.presence === 'inactive') push('- ⚠ **Exists but has no Active version in the comparison org.**');
    else push('- ✅ Exists and is Active in the comparison org.');
    if ((x.missingObjects || []).length) push(`- ❌ Objects missing there: ${esc(x.missingObjects.map(o => o.name).join(', '))}`);
    if ((x.missingFields || []).length) push(`- ❌ Fields missing there: ${esc(x.missingFields.map(f => `${f.ref} (${f.reason})`).join('; '))}`);
    if ((x.missingSubflows || []).length) push(`- ❌ Subflows missing there: ${esc(x.missingSubflows.join(', '))}`);
    if (x.apexChecked === false) push('- ⚠ Apex references were NOT checked in the comparison org.');
    else if ((x.missingApex || []).length) push(`- ❌ Apex missing there: ${esc(x.missingApex.join(', '))}`);
    if ((x.uncheckedObjects || []).length) push(`- ⚠ Objects that could NOT be checked: ${esc(x.uncheckedObjects.map(o => `${o.name} (${o.reason})`).join('; '))}`);
    if ((x.uncheckedFields || []).length) push(`- ⚠ Field references that could NOT be checked: ${esc(x.uncheckedFields.map(f => `${f.ref} (${f.reason})`).join('; '))}`);
    if (x.refsAvailable === false) push('- ⚠ This flow\'s metadata never loaded, so NO references were compared for it.');
    push('');
  }
  return L.join('\n');
}

// N4e — the tabular slices of the same report as one CSV. A `Section` column
// keeps dead subflows, chain edges and the cross-org diff in one greppable
// file instead of forcing three downloads. Pure.
function depReportCsv(report) {
  const r = (report && typeof report === 'object') ? report : {};
  const cell = (v) => {
    const s = (v === null || v === undefined) ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [['Section', 'Flow API Name', 'Flow Label', 'Status', 'Item', 'Detail']];
  const add = (a, b, c, d, e, f) => rows.push([a, b, c, d, e, f]);

  const org = r.org || {};
  add('Meta', '', '', '', 'Org', org.label || org.url || 'unknown');
  add('Meta', '', '', '', 'Generated', r.generatedAt || '');
  add('Meta', '', '', '', 'Flows in scope', r.flowCount === undefined || r.flowCount === null ? 'unknown' : r.flowCount);
  if (r.scanComplete === false) add('Meta', '', '', '', 'WARNING', 'Metadata scan had not finished — report is incomplete');
  for (const n of (Array.isArray(r.notes) ? r.notes : [])) add('Meta', '', '', '', 'Limit', n);

  const dead = r.dead || {};
  for (const x of (dead.dead || [])) {
    add('Dead subflow', x.apiName, x.masterLabel || '', x.status || '', 'No active caller',
      `${x.reason} | callers: ${(x.callers || []).map(c => `${c.apiName} (${c.status || '?'})`).join(', ') || 'none'}`);
  }
  for (const x of (dead.missing || [])) {
    add('Missing subflow target', x.apiName, '', 'Not found', 'Referenced flow does not exist',
      `called by: ${(x.callers || []).map(c => `${c.apiName} (${c.status || '?'})`).join(', ') || 'unknown'}`);
  }
  for (const x of (dead.inactiveTargets || [])) {
    add('Inactive subflow target', x.apiName, x.masterLabel || '', x.status || '', 'No Active version',
      `called by: ${(x.callers || []).map(c => `${c.apiName} (${c.status || '?'})`).join(', ') || 'unknown'}`);
  }

  const edges = (node, root, dir, acc) => {
    if (!node) return acc;
    for (const c of (node.children || [])) {
      acc.push([root, node.apiName, c.apiName, dir, c.cycle ? 'cycle' : (c.truncated ? 'truncated' : '')]);
      edges(c, root, dir, acc);
    }
    return acc;
  };
  for (const ch of (Array.isArray(r.chains) ? r.chains : [])) {
    const acc = [];
    edges(ch.down && ch.down.root, ch.apiName, 'calls', acc);
    edges(ch.up && ch.up.root, ch.apiName, 'called by', acc);
    for (const e of acc) {
      add('Chain edge', e[0], ch.masterLabel || '', '', `${e[1]} ${e[3]} ${e[2]}`, e[4]);
    }
  }

  const xo = r.crossOrg;
  if (!xo) {
    add('Cross-org', '', '', '', 'Not run', 'No comparison org was selected');
  } else {
    const tgt = xo.target || {};
    add('Cross-org', '', '', '', 'Comparison org', tgt.label || tgt.url || 'unknown');
    for (const n of (Array.isArray(xo.notes) ? xo.notes : [])) add('Cross-org', '', '', '', 'Limit', n);
    for (const x of (Array.isArray(xo.rows) ? xo.rows : [])) {
      const lbl = x.masterLabel || '';
      if (x.presence === 'missing') add('Cross-org', x.apiName, lbl, x.status || '', 'Missing in target', 'No flow with this API name in the comparison org');
      else if (x.presence === 'inactive') add('Cross-org', x.apiName, lbl, x.status || '', 'Inactive in target', 'Exists but has no Active version there');
      for (const o of (x.missingObjects || [])) add('Cross-org', x.apiName, lbl, x.status || '', 'Missing object', `${o.name} [${(o.ops || []).join(' · ')}]`);
      for (const f of (x.missingFields || [])) add('Cross-org', x.apiName, lbl, x.status || '', 'Missing field', `${f.ref} — ${f.reason}`);
      for (const s of (x.missingSubflows || [])) add('Cross-org', x.apiName, lbl, x.status || '', 'Missing subflow', s);
      if (x.apexChecked === false) add('Cross-org', x.apiName, lbl, x.status || '', 'Apex NOT checked', 'Apex class list could not be read in the comparison org');
      else for (const a of (x.missingApex || [])) add('Cross-org', x.apiName, lbl, x.status || '', 'Missing Apex', a);
      for (const o of (x.uncheckedObjects || [])) add('Cross-org', x.apiName, lbl, x.status || '', 'Object NOT checked', `${o.name} — ${o.reason}`);
      for (const f of (x.uncheckedFields || [])) add('Cross-org', x.apiName, lbl, x.status || '', 'Reference NOT checked', `${f.ref} — ${f.reason}`);
      if (x.refsAvailable === false) add('Cross-org', x.apiName, lbl, x.status || '', 'No references compared', 'This flow\'s metadata never loaded during the scan');
    }
  }

  return rows.map(row => row.map(cell).join(',')).join('\r\n');
}

// ── Scan sizing (P1) ──────────────────────────────────────────────────────────
// buildDependencyMap costs exactly ONE Tooling metadata GET per flow VERSION —
// the Flow tooling object is version-grained, so 400 definitions × 4 versions is
// 1600 GETs. That is the reported "first load takes a few minutes" in a large
// enterprise org. Above autoMax the popup must NOT scan on open.
// Pure — the numbers the UI quotes and the pool that does the work both come
// from here, so an estimate can never drift from the real cost.
function depScanPlan(versionCount, opts) {
  const o = opts || {};
  const num = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  const autoMax     = Number.isFinite(o.autoMax) && o.autoMax >= 0 ? o.autoMax : 150;
  const concurrency = num(o.concurrency, 6);
  // Wall-clock per metadata GET as seen by the pool. 300 ms is the default
  // until a completed scan measures the real figure for this org/session.
  const msPerCall   = num(o.msPerCall, 300);
  const versions    = Math.max(0, Math.floor(Number(versionCount) || 0));
  const calls       = versions;   // one GET per version — no batching server-side
  const estMs       = Math.round((calls * msPerCall) / concurrency);
  return {
    versions, calls, concurrency, msPerCall, autoMax,
    auto: versions <= autoMax,
    measured: !!(Number.isFinite(o.msPerCall) && o.msPerCall > 0),
    estMs,
    estLabel: depFormatEta(estMs)
  };
}

// Human ETA for a scan. Deliberately hedged ("about") — it is an estimate, and
// the UI states the call count next to it so the user has the hard number too.
function depFormatEta(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 1)  return 'under a second';
  if (s < 60) return `about ${s}s`;
  const m = Math.floor(s / 60), rem = s % 60;
  return rem ? `about ${m}m ${rem}s` : `about ${m}m`;
}

// Rolling concurrency pool (P1). Replaces the old batch-of-10 + Promise.all
// barrier, which drained to zero every 10 items and let one slow GET stall the
// other nine. `limit` workers stay in flight until the queue empties.
//   opts.shouldStop — polled before each item; a true return stops the pool and
//                     reports stopped:true rather than pretending completion.
//   opts.onProgress — (done, total) after every settled item, monotonic.
// Results keep INPUT order regardless of completion order. `complete` is decided
// by the count alone, not by `stopped` — a Stop pressed after the last item
// settled still leaves every item covered, and calling that partial would
// under-report coverage just as dishonestly as over-reporting it.
async function depRunPool(items, worker, opts) {
  const list = Array.isArray(items) ? items : [];
  const o = opts || {};
  const total = list.length;
  const limit = Math.max(1, Math.min(Math.floor(o.concurrency) || 6, total || 1));
  const onProgress = typeof o.onProgress === 'function' ? o.onProgress : null;
  const shouldStop = typeof o.shouldStop === 'function' ? o.shouldStop : null;
  const results = new Array(total);
  let next = 0, done = 0, stopped = false;

  async function runner() {
    for (;;) {
      if (shouldStop && shouldStop()) { stopped = true; return; }
      const i = next++;
      if (i >= total) return;
      try { results[i] = await worker(list[i], i); }
      catch (_) { results[i] = undefined; }   // a failed item is still a done item
      done++;
      if (onProgress) onProgress(done, total);
    }
  }

  const runners = [];
  for (let k = 0; k < limit; k++) runners.push(runner());
  await Promise.all(runners);
  return { results, done, total, stopped, complete: done === total };
}

const DependencyMap = (() => {
  let dependencyMap = {}; // subflowApiName -> [{ id, masterLabel, versionNumber, status, processType }]
  let flowsByApiName = {}; // apiName -> [flow records]
  let triggerTypeMap = {};   // flowId -> triggerType string from Metadata.start.triggerType
  let triggerObjectMap = {}; // flowId -> SObject API name from Metadata.start.object
  // N4 — the metadata is already downloaded per flow; keep what it references
  // instead of throwing it away. refsByFlowId powers 🧨 blast radius,
  // metaTextByFlowId powers the "what uses…" reverse lookup.
  let refsByFlowId = {};     // flowId -> sftkFlowRefs(meta)
  let metaTextByFlowId = {}; // flowId -> JSON.stringify(meta)
  let metadataFetched = false;
  let fetchInProgress = false;
  let _runToken = 0;   // bumped on every reset() — invalidates in-flight scans
  // P1 — scan lifecycle. _scannedIds lets a cancelled scan RESUME instead of
  // re-paying for the versions it already fetched; _scanMsPerCall feeds the
  // next cost estimate the real measured latency of this org.
  let _scannedIds = new Set();  // flow version Ids whose metadata GET has settled
  let _scanAbort = false;       // user pressed Stop — distinct from a reset()
  let _scanDone = 0;            // versions settled so far…
  let _scanTotal = 0;           // …out of this many
  let _scanMsPerCall = 0;       // measured on the last COMPLETED scan (0 = unknown)
  // N4c — cross-org diff state. Org list is cached per popup session; the last
  // diff result is kept so the N4e export can include it without re-running.
  let _xoOrgs = null;      // [{ orgUrl, sid, label, online, stored }]
  let _xoResult = null;    // { target, rows, notes, generatedAt, scope }
  let _xoRunning = false;
  let _lastOrgUrl = '';    // org the tab was last rendered for (context menu has no orgUrl)
  let _scanOrgUrl = '';    // org context the current map was scanned with…
  let _scanSid = '';       // …and its session — the N4c diff describes here too

  const DEP_CHAIN_DEPTH   = 6;    // depth cap for depChain() in the UI
  const DEP_EXPORT_BLAST  = 200;  // max flows detailed in the exported report
  const DEP_EXPORT_CHAINS = 50;   // max chains detailed in the exported report
  const DEP_XO_FLOWS      = 200;  // max flows compared in one cross-org diff
  const DEP_XO_OBJECTS    = 60;   // max objects described in the comparison org
  // P1 — above this many flow VERSIONS the popup stops scanning on open and
  // asks first. 150 versions ≈ 7 s at the pool width below; 1600 ≈ 80 s.
  const DEP_SCAN_AUTO_MAX    = 150;
  const DEP_SCAN_CONCURRENCY = 6;   // metadata GETs in flight — enough to be fast,
                                    // low enough not to stampede the org's API limit

  function reset() {
    _runToken++;       // any in-flight buildDependencyMap is now superseded
    dependencyMap = {};
    flowsByApiName = {};
    triggerTypeMap = {};
    triggerObjectMap = {};
    refsByFlowId = {};
    metaTextByFlowId = {};
    metadataFetched = false;
    fetchInProgress = false;
    _scannedIds = new Set();
    _scanAbort = false;
    _scanDone = 0;
    _scanTotal = 0;
    _scanMsPerCall = 0;   // a per-call latency measured in the OLD org means nothing here
    _xoResult = null;   // a diff against the OLD org must never survive a switch
    _xoOrgs = null;
    _xoRunning = false;
    _scanOrgUrl = '';
    _scanSid = '';
  }

  async function buildDependencyMap(flows, orgUrl, sid, progressCallback) {
    if (metadataFetched) return dependencyMap;
    if (fetchInProgress) return dependencyMap;
    fetchInProgress = true;
    // Claim this run. If reset() is called again (e.g. loadFlows re-runs on an
    // org switch), _runToken changes and this scan stops — so a stale scan
    // never fires metadata GETs with the wrong org's flow IDs.
    const myToken = _runToken;

    _scanAbort = false;
    // A cancelled scan left partial results and a record of what it covered —
    // resume rather than re-pay for those versions. Only a fresh run (or a
    // reset()) starts the map from empty.
    const resuming = _scannedIds.size > 0;
    if (!resuming) dependencyMap = {};
    flowsByApiName = {};
    // Remember the org context this map belongs to — the N4c cross-org diff
    // needs to describe objects in THIS org too (see runCrossOrgDiff).
    _scanOrgUrl = orgUrl || '';
    _scanSid = sid || '';

    // Index flows by API name
    for (const f of flows) {
      if (!flowsByApiName[f.ApiName]) flowsByApiName[f.ApiName] = [];
      flowsByApiName[f.ApiName].push(f);
    }

    const total = flows.length;
    const todo = flows.filter(f => !_scannedIds.has(f.Id));
    const already = total - todo.length;
    _scanTotal = total;
    _scanDone = already;

    // No caller-supplied progress UI — fall back to the shared compact loading
    // cat in the Dependencies tab container so the scan is never completely
    // invisible. Any later render of that tab repaints the container, so this
    // cleans itself up.
    let fallbackMsgEl = null;
    if (!progressCallback) {
      const depContainer = document.getElementById('depTreeContainer');
      if (depContainer) {
        depContainer.innerHTML = sftkCatSm(`Scanning flow metadata… ${already} / ${total}`);
        fallbackMsgEl = depContainer.querySelector('.lp-robot-msg');
      }
    }

    // Stop on either a user cancel or a newer reset()/scan superseding this one.
    const shouldStop = () => _scanAbort || myToken !== _runToken;
    const startedAt = Date.now();

    const run = await depRunPool(todo, async (flow) => {
      try {
        const result = await chrome.runtime.sendMessage({
          type: 'SF_GET_METADATA',
          orgUrl,
          sid,
          id: flow.Id,
          // A metadata GET can legitimately 404 for a deleted / obsolete flow
          // version — buildDependencyMap skips those silently, so don't flag
          // them as hard errors in the debug log.
          _suppressError: true
        });
        if (result && !result.error && result.Metadata) {
          const meta = result.Metadata;
          const triggerType = meta.start?.triggerType || meta.triggerType || null;
          const triggerObj  = meta.start?.object || null;
          if (triggerType) triggerTypeMap[flow.Id]   = triggerType;
          if (triggerObj)  triggerObjectMap[flow.Id] = triggerObj;
          try {
            refsByFlowId[flow.Id] = sftkFlowRefs(meta);
            metaTextByFlowId[flow.Id] = JSON.stringify(meta);
          } catch (_) { /* refs are additive — never fail the map build */ }

          const subflows = meta.subflows || [];
          for (const sf of subflows) {
            const calledApiName = sf.flowName;
            if (!calledApiName) continue; // skip null/undefined/empty flowName refs
            if (!dependencyMap[calledApiName]) dependencyMap[calledApiName] = [];
            dependencyMap[calledApiName].push({
              id: flow.Id,
              masterLabel: flow.MasterLabel,
              apiName: flow.ApiName,
              versionNumber: flow.VersionNumber,
              status: flow.Status,
              processType: flow.ProcessType
            });
          }
        }
      } catch (e) {
        // Silently skip metadata fetch errors
      }
      // Marked covered even on error/404: retrying it on resume would cost the
      // same call and fail the same way.
      _scannedIds.add(flow.Id);
    }, {
      concurrency: DEP_SCAN_CONCURRENCY,
      shouldStop,
      onProgress: (n) => {
        _scanDone = already + n;
        if (progressCallback) progressCallback(_scanDone, total);
        else if (fallbackMsgEl) fallbackMsgEl.textContent = `Scanning flow metadata… ${_scanDone} / ${total}`;
      }
    });

    // Superseded by a newer reset()/scan — that run owns the module state now,
    // so don't touch fetchInProgress or the completion flag.
    if (myToken !== _runToken) return dependencyMap;

    fetchInProgress = false;
    if (run.complete) {
      metadataFetched = true;
      _scanAbort = false;
      // Feed the next estimate this org's real latency instead of the default.
      if (run.done > 0) {
        _scanMsPerCall = Math.round(((Date.now() - startedAt) * DEP_SCAN_CONCURRENCY) / run.done);
      }
    }
    return dependencyMap;
  }

  // Stop an in-flight scan WITHOUT discarding what it already learned. The
  // partial map stays readable, but metadataFetched stays false so every
  // consumer keeps printing its "scan has NOT finished" caveat, and the next
  // buildDependencyMap resumes from _scannedIds instead of restarting.
  function cancelScan() {
    if (!fetchInProgress) return false;
    _scanAbort = true;
    return true;
  }

  function getScanStatus() {
    return {
      running: fetchInProgress,
      complete: metadataFetched,
      aborted: _scanAbort && !metadataFetched,
      done: _scanDone,
      total: _scanTotal,
      msPerCall: _scanMsPerCall
    };
  }

  // Single source of truth for scan sizing — popup.js asks through here so the
  // quoted cost and the pool that pays it can never disagree.
  function scanPlan(versionCount) {
    return depScanPlan(versionCount, {
      autoMax: DEP_SCAN_AUTO_MAX,
      concurrency: DEP_SCAN_CONCURRENCY,
      msPerCall: _scanMsPerCall || undefined
    });
  }

  function getDependencyMap() { return dependencyMap; }
  function isMetadataFetched() { return metadataFetched; }

  // One accurate phrase behind every "why is this incomplete" caveat. Since P1
  // the scan can be running, stopped part-way, or never started at all (large
  // org, no auto-scan) — printing "still running" for the last two is a lie.
  function scanCaveat() {
    if (metadataFetched) return '';
    if (fetchInProgress)  return `the metadata scan is still running (${_scanDone} / ${_scanTotal})`;
    if (_scannedIds.size) return `the metadata scan was stopped at ${_scanDone} of ${_scanTotal} flow versions`;
    return 'the dependency scan has not been run for this org';
  }
  function getTriggerObjectMap() { return triggerObjectMap; }

  function getParentsForApiName(apiName) {
    return dependencyMap[apiName] || [];
  }

  function getFlowsByApiName() { return flowsByApiName; }

  // Render the dependency tree tab content
  function renderDependencyTreeTab(allFlows, container, orgUrl) {
    container.innerHTML = '';
    _lastOrgUrl = orgUrl || _lastOrgUrl;
    // A floating blast/chain panel from a previous render (possibly a previous
    // ORG) would otherwise survive the repaint and show stale data.
    document.querySelector('.dep-blast-panel')?.remove();

    const filterBar = document.createElement('div');
    filterBar.className = 'dep-filter-bar';
    filterBar.innerHTML = `
      <div class="dep-filter-buttons">
        <button class="dep-filter-btn active" data-type="all">All</button>
        <button class="dep-filter-btn" data-type="RecordTriggeredFlow">⚡ Record-Triggered</button>
        <button class="dep-filter-btn" data-type="Flow">🖥 Screen</button>
        <button class="dep-filter-btn" data-type="AutoLaunchedFlow">🔄 Auto-launched</button>
        <button class="dep-filter-btn" data-type="ScheduledFlow">📅 Scheduled</button>
      </div>
      <div class="dep-expand-btns">
        <button class="btn-small" id="expandAll">Expand All</button>
        <button class="btn-small" id="collapseAll">Collapse All</button>
      </div>
    `;
    container.appendChild(filterBar);

    // N4b — reverse lookup: field / object / label / any literal (e.g. a
    // picklist value) → every flow whose metadata mentions it.
    const refSearchRow = document.createElement('div');
    refSearchRow.className = 'dep-ref-search-row';
    refSearchRow.innerHTML = `
      <input type="text" id="depRefSearch" class="dep-ref-search"
        placeholder="🔎 What uses… a field API name, object, or value (e.g. SLA__c, Account, Gold)" autocomplete="off">
      <button class="btn-small" id="depRefGo">Search</button>`;
    container.appendChild(refSearchRow);
    const refResults = document.createElement('div');
    refResults.id = 'depRefResults';
    container.appendChild(refResults);

    const runRefSearch = () => {
      const term = (document.getElementById('depRefSearch')?.value || '').trim();
      if (!term) { refResults.innerHTML = ''; return; }
      const hits = searchReferences(term);
      const byId = {};
      for (const f of allFlows) byId[f.Id] = f;
      refResults.innerHTML = hits.length
        ? `<div class="dep-ref-hdr">${hits.length} flow(s) mention “${escHtml(term)}” <span class="dep-ref-note">(literal, case-insensitive match in the flow's metadata)</span>${isMetadataFetched() ? '' : `<b style="color:var(--warning,#DD7A01)"> — ${scanCaveat()}, so there may be more.</b>`}</div>`
          + hits.map(h => {
            const f = byId[h.flowId];
            if (!f) return '';
            return `<div class="dep-ref-hit" data-id="${escHtml(f.Id)}" title="Open in Flow Builder">
              <span class="dep-node-name">${escHtml(f.MasterLabel)}</span>
              <span class="badge dep-type-badge">${escHtml(f.ProcessType || '')}</span>
              <span class="badge ${f.Status === 'Active' ? 'badge-active' : 'badge-draft'}">${escHtml(f.Status || '')}</span>
              <span class="dep-ref-count">×${h.count}</span>
            </div>`;
          }).join('')
        : `<div class="dep-ref-hdr">No flow mentions “${escHtml(term)}”${isMetadataFetched() ? '' : ` — but ${scanCaveat()}, so this search covered only part of the org`}.</div>`;
      refResults.querySelectorAll('.dep-ref-hit').forEach(row =>
        row.addEventListener('click', () =>
          chrome.tabs.create({ url: `${orgUrl}/builder_platform_interaction/flowBuilder.app?flowId=${row.dataset.id}` })));
    };
    document.getElementById('depRefGo')?.addEventListener('click', runRefSearch);
    document.getElementById('depRefSearch')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') runRefSearch();
      if (e.key === 'Escape') { e.target.value = ''; refResults.innerHTML = ''; }
    });

    // N4c/N4d/N4e — lazy tools. Nothing here runs until the user asks for it:
    // the cross-org diff in particular fires describes against another org.
    const toolsRow = document.createElement('div');
    toolsRow.className = 'dep-tools-row';
    toolsRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 8px 2px';
    toolsRow.innerHTML = `
      <button class="btn-small" id="depDeadBtn" title="Flows called as a subflow that no ACTIVE flow calls, plus subflow calls pointing at missing or inactive flows">🧟 Subflow health</button>
      <button class="btn-small" id="depXoBtn" title="Read-only: compare these flows and their references against another org">🔀 Cross-org diff</button>
      <button class="btn-small" id="depExportBtn" title="Download this dependency report as Markdown + CSV">⬇ Export report</button>
      <span style="font-size:11px;color:var(--subtext,#706E6B)">Right-click a flow for 🧨 blast radius or 🔗 chains.</span>`;
    container.appendChild(toolsRow);

    const toolPanel = document.createElement('div');
    toolPanel.id = 'depToolPanel';
    container.appendChild(toolPanel);
    const exportStatus = document.createElement('div');
    exportStatus.id = 'depExportStatus';
    exportStatus.style.cssText = 'padding:2px 10px;font-size:11.5px';
    container.appendChild(exportStatus);

    let openTool = null;
    const toggleTool = (name, render) => {
      if (openTool === name) { openTool = null; toolPanel.innerHTML = ''; return; }
      openTool = name;
      toolPanel.innerHTML = '';
      render(toolPanel);
    };
    toolsRow.querySelector('#depDeadBtn').addEventListener('click', () =>
      toggleTool('dead', m => renderDeadPanel(m, orgUrl)));
    toolsRow.querySelector('#depXoBtn').addEventListener('click', () =>
      toggleTool('xo', m => { renderCrossOrgPanel(m, orgUrl); }));
    toolsRow.querySelector('#depExportBtn').addEventListener('click', () =>
      exportReport(orgUrl, exportStatus));

    // Build parent->children map using dependency map
    const childrenMap = {}; // parentApiName -> [child apiNames]
    const parentSet = new Set(); // apiNames that are parents
    const childSet = new Set(); // apiNames that are children (called as subflows)

    for (const [calledApiName, parents] of Object.entries(dependencyMap)) {
      childSet.add(calledApiName);
      for (const parent of parents) {
        parentSet.add(parent.apiName);
        if (!childrenMap[parent.apiName]) childrenMap[parent.apiName] = new Set();
        childrenMap[parent.apiName].add(calledApiName);
      }
    }

    // Group flows by MasterLabel for latest version display
    const flowsByLabel = {};
    for (const f of allFlows) {
      if (!flowsByLabel[f.MasterLabel]) flowsByLabel[f.MasterLabel] = [];
      flowsByLabel[f.MasterLabel].push(f);
    }

    // Get latest active version or highest version per label
    const representativeFlows = {};
    for (const [label, versions] of Object.entries(flowsByLabel)) {
      const active = versions.find(v => v.Status === 'Active');
      representativeFlows[label] = active || versions[versions.length - 1];
    }

    // Top-level flows = have children but are not children themselves (or are standalone)
    const rootFlows = Object.values(representativeFlows).filter(f => {
      const isParent = parentSet.has(f.ApiName);
      const isChild = childSet.has(f.ApiName);
      return isParent && !isChild;
    });

    const standaloneFlows = Object.values(representativeFlows).filter(f => {
      const isParent = parentSet.has(f.ApiName);
      const isChild = childSet.has(f.ApiName);
      return !isParent && !isChild;
    });

    const treeContainer = document.createElement('div');
    treeContainer.className = 'dep-tree-container';
    container.appendChild(treeContainer);

    let activeFilter = 'all';
    const allNodes = [];

    function getFlowIcon(processType) {
      switch (processType) {
        case 'RecordTriggeredFlow': return '⚡';
        case 'Flow': return '🖥';
        case 'AutoLaunchedFlow': return '🔄';
        case 'ScheduledFlow': return '📅';
        case 'PlatformEventFlow': return '🔁';
        default: return '🔄';
      }
    }

    function getStatusBadgeClass(status) {
      switch (status) {
        case 'Active': return 'badge-active';
        case 'Draft': return 'badge-draft';
        case 'Obsolete': return 'badge-obsolete';
        default: return 'badge-obsolete';
      }
    }

    function renderFlowNode(flow, depth, visited) {
      const node = document.createElement('div');
      node.className = 'dep-node';
      node.dataset.processType = flow.ProcessType || '';
      node.dataset.apiName = flow.ApiName;
      node.style.paddingLeft = `${depth * 20 + 8}px`;

      const icon = getFlowIcon(flow.ProcessType);
      const statusClass = getStatusBadgeClass(flow.Status);
      const hasChildren = childrenMap[flow.ApiName] && childrenMap[flow.ApiName].size > 0;

      node.innerHTML = `
        <span class="dep-node-toggle">${hasChildren ? '▼' : '&nbsp;&nbsp;'}</span>
        <span class="dep-node-icon">${icon}</span>
        <span class="dep-node-name" title="Open in Salesforce">${escHtml(flow.MasterLabel)}</span>
        <span class="badge dep-type-badge">${escHtml(flow.ProcessType || '')}</span>
        <span class="badge ${statusClass}">${flow.Status}</span>
      `;

      node.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showDepContextMenu(e, flow);
      });

      node.querySelector('.dep-node-name').addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.tabs.create({ url: `${orgUrl}/builder_platform_interaction/flowBuilder.app?flowId=${flow.Id}` });
      });

      allNodes.push(node);

      const childContainer = document.createElement('div');
      childContainer.className = 'dep-children';

      if (hasChildren && !visited.has(flow.ApiName)) {
        visited.add(flow.ApiName);

        if (depth >= 3) {
          const warn = document.createElement('div');
          warn.className = 'dep-deep-warning';
          warn.style.paddingLeft = `${(depth + 1) * 20 + 8}px`;
          warn.textContent = '⚠️ Dependency chain is deeper than 3 levels. Manual review recommended.';
          childContainer.appendChild(warn);
        } else {
          for (const childApiName of childrenMap[flow.ApiName]) {
            const childFlow = Object.values(representativeFlows).find(f => f.ApiName === childApiName);
            if (childFlow) {
              const childResult = renderFlowNode(childFlow, depth + 1, new Set(visited));
              // N4d — "Not found" was the only broken-target marker. A subflow
              // call at a flow that EXISTS but has no Active version fails at
              // runtime just as hard, so say so on the node itself.
              if (childFlow.Status !== 'Active') {
                const warn = document.createElement('span');
                warn.className = 'dep-inactive-target';
                warn.style.cssText = 'margin-left:6px;font-size:10.5px;color:var(--warning,#DD7A01)';
                warn.textContent = '⚠ called as a subflow but not Active';
                warn.title = 'A subflow call resolves to the Active version. With no Active version this call fails at runtime.';
                childResult.node.appendChild(warn);
              }
              childContainer.appendChild(childResult.node);
              if (childResult.children.children.length > 0 || childResult.children.childElementCount > 0) {
                childContainer.appendChild(childResult.children);
              }
            } else {
              // Not in representativeFlows — either the flow genuinely does not
              // exist, or it exists with no Active version (and lost the
              // MasterLabel key to a namesake). flowsByApiName tells them apart.
              const versions = flowsByApiName[childApiName] || [];
              const worst = versions[versions.length - 1];
              const missingNode = document.createElement('div');
              missingNode.className = 'dep-node dep-missing';
              missingNode.style.paddingLeft = `${(depth + 1) * 20 + 8}px`;
              missingNode.innerHTML = versions.length
                ? `<span class="dep-node-icon">⚠️</span> <span class="dep-node-name">${escHtml(childApiName)}</span> <span class="badge badge-obsolete">${escHtml((worst && worst.Status) || 'Inactive')}</span> <span style="font-size:10.5px;color:var(--warning,#DD7A01)">exists but has no Active version — this subflow call fails at runtime</span>`
                : `<span class="dep-node-icon">❓</span> <span class="dep-node-name">${escHtml(childApiName)}</span> <span class="badge badge-obsolete">Not found</span> <span style="font-size:10.5px;color:var(--subtext,#706E6B)">no flow with this API name in this org</span>`;
              childContainer.appendChild(missingNode);
            }
          }
        }

        const toggle = node.querySelector('.dep-node-toggle');
        toggle.style.cursor = 'pointer';
        toggle.addEventListener('click', (e) => {
          e.stopPropagation();
          const isOpen = childContainer.style.display !== 'none';
          childContainer.style.display = isOpen ? 'none' : '';
          toggle.textContent = isOpen ? '▶' : '▼';
        });
        node.addEventListener('click', () => {
          const isOpen = childContainer.style.display !== 'none';
          childContainer.style.display = isOpen ? 'none' : '';
          toggle.textContent = isOpen ? '▶' : '▼';
          highlightBranch(node, childContainer, !isOpen);
        });
      }

      return { node, children: childContainer };
    }

    function highlightBranch(node, children, on) {
      node.classList.toggle('dep-highlighted', on);
      children.querySelectorAll('.dep-node').forEach(n => n.classList.toggle('dep-highlighted', on));
    }

    // Render root flows
    if (rootFlows.length > 0) {
      const section = document.createElement('div');
      section.className = 'dep-section';
      section.innerHTML = '<div class="dep-section-header">Flow Hierarchies</div>';
      treeContainer.appendChild(section);

      for (const flow of rootFlows) {
        const { node, children } = renderFlowNode(flow, 0, new Set());
        section.appendChild(node);
        section.appendChild(children);
      }
    }

    // Standalone flows
    if (standaloneFlows.length > 0) {
      const standalone = document.createElement('div');
      standalone.className = 'dep-section dep-standalone';
      standalone.innerHTML = `<div class="dep-section-header dep-standalone-header">🏝 Standalone Flows (${standaloneFlows.length})</div>`;
      const standaloneList = document.createElement('div');
      standaloneList.className = 'dep-children';
      standaloneList.style.display = 'none';
      standalone.appendChild(standaloneList);

      standalone.querySelector('.dep-standalone-header').addEventListener('click', () => {
        const isOpen = standaloneList.style.display !== 'none';
        standaloneList.style.display = isOpen ? 'none' : '';
      });

      for (const flow of standaloneFlows) {
        const { node } = renderFlowNode(flow, 0, new Set());
        standaloneList.appendChild(node);
      }

      treeContainer.appendChild(standalone);
    }

    if (rootFlows.length === 0 && standaloneFlows.length === 0) {
      treeContainer.innerHTML = '<div class="empty-state">No subflow relationships found — all flows appear to be standalone.</div>';
    }

    // Filter functionality
    filterBar.querySelectorAll('.dep-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        filterBar.querySelectorAll('.dep-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeFilter = btn.dataset.type;
        allNodes.forEach(node => {
          const pt = node.dataset.processType;
          const match = activeFilter === 'all' || pt === activeFilter;
          node.classList.toggle('dep-dimmed', !match);
        });
      });
    });

    document.getElementById('expandAll').addEventListener('click', () => {
      treeContainer.querySelectorAll('.dep-children').forEach(c => c.style.display = '');
      treeContainer.querySelectorAll('.dep-node-toggle').forEach(t => {
        if (t.textContent.trim() === '▶') t.textContent = '▼';
      });
    });

    document.getElementById('collapseAll').addEventListener('click', () => {
      treeContainer.querySelectorAll('.dep-children').forEach(c => c.style.display = 'none');
      treeContainer.querySelectorAll('.dep-node-toggle').forEach(t => {
        if (t.textContent.trim() === '▼') t.textContent = '▶';
      });
    });
  }

  let contextMenu = null;
  function showDepContextMenu(e, flow) {
    if (contextMenu) contextMenu.remove();
    contextMenu = document.createElement('div');
    contextMenu.className = 'dep-context-menu';
    contextMenu.style.left = e.clientX + 'px';
    contextMenu.style.top = e.clientY + 'px';
    contextMenu.innerHTML = `
      <div class="dep-context-item" id="depCtxBlast">🧨 Blast radius — what this flow touches</div>
      <div class="dep-context-item" id="depCtxChain">🔗 Subflow chain — full up &amp; down tree</div>
      <div class="dep-context-item" id="depCtxSelect">Select this flow for deletion</div>`;
    document.body.appendChild(contextMenu);

    document.getElementById('depCtxBlast').addEventListener('click', () => {
      contextMenu.remove();
      contextMenu = null;
      showBlastRadius(flow);
    });
    document.getElementById('depCtxChain').addEventListener('click', () => {
      contextMenu.remove();
      contextMenu = null;
      showChainPanel(flow, _lastOrgUrl);
    });
    document.getElementById('depCtxSelect').addEventListener('click', () => {
      contextMenu.remove();
      contextMenu = null;
      // Switch to main tab and check this flow
      const event = new CustomEvent('selectFlowForDeletion', { detail: { flow } });
      document.dispatchEvent(event);
      document.querySelector('.tab-btn[data-tab="flows"]')?.click();
    });

    document.addEventListener('click', () => {
      if (contextMenu) { contextMenu.remove(); contextMenu = null; }
    }, { once: true });
  }

  function escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function getTriggerTypeMap() { return triggerTypeMap; }

  // ── N4 API ────────────────────────────────────────────────────────────
  function getRefsFor(flowId) { return refsByFlowId[flowId] || null; }

  // ── N4c/N4d/N4e shared plumbing ───────────────────────────────────────
  // popup.js loads AFTER this file, so sendBg/sftkFriendlyError only exist by
  // the time a user actually clicks something. Guarded, per the cross-file rule.
  function depBg(msg) {
    if (typeof sendBg === 'function') return sendBg(msg);
    return chrome.runtime.sendMessage(msg);
  }

  function depFriendly(raw) {
    if (typeof sftkFriendlyError === 'function') {
      try {
        const fe = sftkFriendlyError(raw);
        return fe && fe.hint ? `${fe.message} — ${fe.hint}` : (fe && fe.message) || String(raw || '');
      } catch (_) { /* fall through to the raw string */ }
    }
    return String(raw || 'Unknown error');
  }

  // sftkCatSm() drops its message straight into innerHTML, and some of these
  // messages carry an org-supplied label — escape before it ever gets there.
  function depSpin(msg) {
    const safe = escHtml(msg);
    return (typeof sftkCatSm === 'function') ? sftkCatSm(safe) : `<div class="dep-blast-sec">${safe}</div>`;
  }

  function depErrBox(title, raw) {
    return `<div class="dep-blast-sec" style="border-left:3px solid var(--danger,#EA001E);padding-left:8px">
      <div style="font-weight:700">${escHtml(title)}</div>
      <div style="margin-top:2px">${escHtml(depFriendly(raw))}</div>
      <div style="margin-top:2px;font-size:11px;color:var(--subtext,#706E6B)">Nothing was written to either org — this is a read-only report.</div>
    </div>`;
  }

  // The version of a flow the tree/report should speak about: the Active one
  // if there is one, otherwise the highest version we saw.
  function repFlowFor(apiName) {
    const vs = flowsByApiName[apiName] || [];
    if (!vs.length) return null;
    return vs.find(v => v.Status === 'Active') || vs[vs.length - 1];
  }

  function depOrgKey(url) {
    if (typeof sftkOrgKey === 'function') return sftkOrgKey(url);
    return String(url || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }

  function depHost(url) {
    try { return new URL(url).hostname; } catch (_) { return String(url || ''); }
  }

  function depStamp(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  }

  function depDownload(filename, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Org list for the N4c comparison picker — the same two sources the popup's
  // org switcher uses (live tab sessions + stored credentials).
  async function depLoadOrgs(currentOrgUrl) {
    if (_xoOrgs) return _xoOrgs;
    const [r, stored] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_ALL_SF_SESSIONS' }).catch(() => null),
      chrome.storage.local.get('ds_stored_orgs').then(d => d.ds_stored_orgs || []).catch(() => [])
    ]);
    const seen = new Set([depOrgKey(currentOrgUrl)]);
    const out = [];
    for (const s of ((r && r.sessions) || [])) {
      const k = depOrgKey(s.orgUrl);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push({ orgUrl: s.orgUrl, sid: s.sid, label: s.label || depHost(s.orgUrl), online: true });
    }
    for (const o of (stored || [])) {
      if (!o || !o.url || !o.sid) continue;
      const k = depOrgKey(o.url);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push({ orgUrl: o.url, sid: o.sid, label: o.label || o.username || depHost(o.url), online: false, stored: true });
    }
    _xoOrgs = out;
    return out;
  }

  // ── N4d — subflow chains (transitive, cycle-safe) ─────────────────────
  // Annotate a depChain() node tree with what this org actually contains, so
  // the panel and the export can both say "not found" / "no Active version".
  function annotateChain(node) {
    if (!node) return node;
    const rep = repFlowFor(node.apiName);
    node.exists = !!rep;
    node.selfActive = !!(flowsByApiName[node.apiName] || []).some(v => v.Status === 'Active');
    node.status = rep ? rep.Status : node.status;
    node.masterLabel = rep ? rep.MasterLabel : node.masterLabel;
    node.flowId = rep ? rep.Id : null;
    for (const c of (node.children || [])) annotateChain(c);
    return node;
  }

  function chainFor(apiName, depth) {
    const d = depth || DEP_CHAIN_DEPTH;
    const down = depChain(dependencyMap, apiName, 'down', d);
    const up = depChain(dependencyMap, apiName, 'up', d);
    annotateChain(down.root);
    annotateChain(up.root);
    return { down, up };
  }

  function chainNodeHtml(node, indent) {
    const pad = indent * 16 + 8;
    const flags = [];
    if (!node.exists) flags.push('<span class="badge badge-obsolete">Not found in this org</span>');
    else if (!node.selfActive) flags.push(`<span class="badge badge-obsolete" title="This subflow call fails at runtime">${escHtml(node.status || 'Inactive')} — no Active version</span>`);
    else flags.push('<span class="badge badge-active">Active</span>');
    if (node.cycle) flags.push('<span style="color:var(--warning,#DD7A01)">↻ cycle — already higher in this chain, not expanded</span>');
    if (node.truncated) flags.push(`<span style="color:var(--warning,#DD7A01)">… deeper levels NOT expanded (depth cap ${DEP_CHAIN_DEPTH})</span>`);
    let html = `<div class="dep-blast-item" style="padding-left:${pad}px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <span class="dep-node-name"${node.flowId ? ` data-flow-id="${escHtml(node.flowId)}" style="cursor:pointer"` : ''}>${escHtml(node.apiName)}</span>
      ${flags.join(' ')}</div>`;
    for (const c of (node.children || [])) html += chainNodeHtml(c, indent + 1);
    return html;
  }

  function showChainPanel(flow, orgUrl) {
    // Both panels dock to the same corner — only ever show one.
    document.querySelector('.dep-blast-panel')?.remove();
    const { down, up } = chainFor(flow.ApiName);
    const panel = document.createElement('div');
    panel.className = 'dep-blast-panel dep-chain-panel';
    panel.style.cssText = 'top:60px;right:16px;width:400px';
    const emptyDown = !(down.root.children || []).length;
    const emptyUp = !(up.root.children || []).length;
    panel.innerHTML = `
      <div class="dep-blast-hdr">
        🔗 ${escHtml(flow.MasterLabel)} — subflow chain
        <button class="btn-small dep-blast-close" title="Close">✖</button>
      </div>
      <div class="dep-blast-verdict" style="font-size:11.5px">
        Transitive, cycle-safe, capped at ${DEP_CHAIN_DEPTH} levels.
        Built from the <b>subflow calls found in each flow's scanned metadata</b> — it does not
        know about flows started from buttons, Apex, REST or scheduled paths.
        ${isMetadataFetched() ? '' : `<b style="color:var(--warning,#DD7A01)"> Incomplete — ${scanCaveat()}.</b>`}
      </div>
      <div class="dep-blast-sec">
        <div class="dep-blast-sec-hdr">⬇ Calls (downstream) — ${down.stats.nodes - 1} node(s), ${down.stats.cycles} cycle(s)</div>
        ${emptyDown ? '<div class="dep-blast-item">Calls no subflows.</div>'
    : (down.root.children || []).map(c => chainNodeHtml(c, 0)).join('')}
      </div>
      <div class="dep-blast-sec">
        <div class="dep-blast-sec-hdr">⬆ Called by (upstream) — ${up.stats.nodes - 1} node(s), ${up.stats.cycles} cycle(s)</div>
        ${emptyUp ? '<div class="dep-blast-item">No flow calls this one.</div>'
    : (up.root.children || []).map(c => chainNodeHtml(c, 0)).join('')}
      </div>`;
    document.body.appendChild(panel);
    panel.querySelector('.dep-blast-close').addEventListener('click', () => panel.remove());
    panel.querySelectorAll('[data-flow-id]').forEach(el => el.addEventListener('click', () =>
      chrome.tabs.create({ url: `${orgUrl}/builder_platform_interaction/flowBuilder.app?flowId=${el.dataset.flowId}` })));
  }

  // ── N4d — dead subflow detection panel ────────────────────────────────
  function renderDeadPanel(mount, orgUrl) {
    const res = depDeadSubflows(dependencyMap, flowsByApiName);
    const callerList = cs => (cs || []).length
      ? (cs || []).map(c => `${escHtml(c.apiName)} <span class="badge ${c.status === 'Active' ? 'badge-active' : 'badge-draft'}">${escHtml(c.status || '?')}</span>`).join(', ')
      : '<i>caller could not be identified</i>';
    const row = (apiName, badges, detail) => {
      const rep = repFlowFor(apiName);
      return `<div class="dep-ref-hit" style="display:block;cursor:${rep ? 'pointer' : 'default'}"${rep ? ` data-flow-id="${escHtml(rep.Id)}"` : ''}>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <span class="dep-node-name">${escHtml(apiName)}</span>${badges}
        </div>
        <div style="font-size:11px;color:var(--subtext,#706E6B);margin-top:2px">${detail}</div>
      </div>`;
    };
    const sec = (title, count, body) =>
      `<div class="dep-blast-sec"><div class="dep-blast-sec-hdr">${title} (${count})</div>${body}</div>`;

    mount.innerHTML = `
      <div class="dep-blast-verdict" style="border-top:1px solid var(--border,#DDDBDA)">
        <b>🧟 Subflow health</b> — ${res.counts.subflowTargets} flow(s) are referenced as a subflow somewhere.
        ${isMetadataFetched() ? '' : `<b style="color:var(--warning,#DD7A01)">These results are incomplete — ${scanCaveat()}.</b>`}
      </div>
      ${sec('💀 Dead subflows — no ACTIVE caller', res.counts.dead,
    res.dead.length
      ? `<div style="font-size:11px;color:var(--subtext,#706E6B);padding:0 0 4px 8px">
             This is a <b>candidate list, not a verdict</b>: buttons, Apex, REST, packaged code and
             scheduled paths can start a flow without any parent flow. Check those before deleting.</div>`
              + res.dead.map(d => row(d.apiName,
                `<span class="badge ${d.selfActive ? 'badge-active' : 'badge-obsolete'}">${escHtml(d.status)}</span>`,
                `${escHtml(d.reason)} — called by: ${callerList(d.callers)}`)).join('')
      : '<div class="dep-blast-item">None — every subflow target has at least one Active caller.</div>')}
      ${sec('❓ Subflow calls pointing at a flow that does NOT exist', res.counts.missing,
    res.missing.length
      ? res.missing.map(m => row(m.apiName, '<span class="badge badge-obsolete">Not found</span>',
        `No flow with this API name in this org — the call fails at runtime. Called by: ${callerList(m.callers)}`)).join('')
      : '<div class="dep-blast-item">None.</div>')}
      ${sec('⚠ Subflow calls pointing at a flow with NO Active version', res.counts.inactiveTargets,
    res.inactiveTargets.length
      ? res.inactiveTargets.map(m => row(m.apiName, `<span class="badge badge-obsolete">${escHtml(m.status)}</span>`,
        `The flow exists but has no Active version — the call fails at runtime. Called by: ${callerList(m.callers)}`)).join('')
      : '<div class="dep-blast-item">None.</div>')}`;

    mount.querySelectorAll('[data-flow-id]').forEach(el => el.addEventListener('click', () =>
      chrome.tabs.create({ url: `${orgUrl}/builder_platform_interaction/flowBuilder.app?flowId=${el.dataset.flowId}` })));
  }

  // ── N4c — cross-org dependency diff (READ ONLY) ───────────────────────
  async function renderCrossOrgPanel(mount, orgUrl) {
    mount.innerHTML = `<div class="dep-blast-verdict" style="border-top:1px solid var(--border,#DDDBDA)">
      ${depSpin('Detecting other orgs…')}</div>`;
    let orgs = [];
    try { orgs = await depLoadOrgs(orgUrl); }
    catch (e) { mount.innerHTML = depErrBox('Could not list your other orgs', e && e.message); return; }

    if (!orgs.length) {
      mount.innerHTML = `<div class="dep-blast-sec">No other org detected. Open a Salesforce tab for the
        comparison org, or add it under Connected Orgs in Data Studio, then reopen this panel.</div>`;
      return;
    }

    mount.innerHTML = `
      <div class="dep-blast-verdict" style="border-top:1px solid var(--border,#DDDBDA)">
        <b>🔀 Cross-org dependency diff</b> — read-only. For every flow here, does the same flow exist and
        run in another org, and do the objects, fields, subflows and Apex it references exist there?
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 12px">
        <select id="depXoSelect" style="flex:1;min-width:170px;padding:4px 6px;border:1px solid var(--border,#DDDBDA);border-radius:6px;font-size:12px;background:var(--card,#fff);color:var(--text,#181818)">
          ${orgs.map((o, i) => `<option value="${i}">${escHtml(o.label)} — ${escHtml(depHost(o.orgUrl))}${o.online ? '' : ' (stored credentials)'}</option>`).join('')}
        </select>
        <label style="font-size:11.5px;display:flex;align-items:center;gap:4px">
          <input type="checkbox" id="depXoActiveOnly" checked> Active flows only
        </label>
        <button class="btn-small" id="depXoRun">Compare</button>
      </div>
      <div id="depXoOut"></div>`;

    const out = mount.querySelector('#depXoOut');
    // A diff from earlier in this popup session survives panel toggling; reset()
    // clears it on an org switch so it can never describe the wrong org.
    if (_xoResult) renderCrossOrgResult(out, _xoResult, orgUrl);
    const runBtn = mount.querySelector('#depXoRun');
    runBtn.addEventListener('click', async () => {
      if (_xoRunning) return;
      const i = Number(mount.querySelector('#depXoSelect').value || 0);
      const activeOnly = !!mount.querySelector('#depXoActiveOnly').checked;
      runBtn.disabled = true;
      runBtn.textContent = 'Comparing…';
      try { await runCrossOrgDiff(orgs[i], { activeOnly }, out, orgUrl); }
      finally { runBtn.disabled = false; runBtn.textContent = 'Compare'; }
    });
  }

  async function runCrossOrgDiff(target, opts, out, orgUrl) {
    if (!target || !target.orgUrl || !target.sid) {
      out.innerHTML = depErrBox('That org has no usable session', 'No session id — open a Salesforce tab for it and re-scan.');
      return;
    }
    _xoRunning = true;
    const notes = [];
    try {
      // 1 ─ scope: one representative version per API name in THIS org.
      let scope = [];
      for (const apiName of Object.keys(flowsByApiName).sort()) {
        const f = repFlowFor(apiName);
        if (!f) continue;
        if (opts.activeOnly && f.Status !== 'Active') continue;
        scope.push(f);
      }
      if (opts.activeOnly) notes.push('Only flows with an Active version in this org were compared.');
      if (!scope.length) {
        out.innerHTML = '<div class="dep-blast-sec">No flows in scope — uncheck “Active flows only” to compare drafts too.</div>';
        return;
      }
      if (scope.length > DEP_XO_FLOWS) {
        notes.push(`Capped at the first ${DEP_XO_FLOWS} flows (of ${scope.length}) — the rest were NOT compared.`);
        scope = scope.slice(0, DEP_XO_FLOWS);
      }
      if (!isMetadataFetched()) notes.push(`Some flows had no references to compare — ${scanCaveat()}.`);

      // 2 ─ the comparison org's flows.
      out.innerHTML = depSpin(`Reading flows in ${target.label}…`);
      const tf = await depBg({
        type: 'SF_QUERY_ALL', orgUrl: target.orgUrl, sid: target.sid, tooling: true,
        query: 'SELECT Id,MasterLabel,Definition.DeveloperName,VersionNumber,Status FROM Flow'
      });
      if (!tf || tf.error) { out.innerHTML = depErrBox(`Could not read flows in ${target.label}`, tf && tf.error); return; }
      const tgtFlows = {};
      for (const rec of (tf.records || [])) {
        const an = (rec.Definition && rec.Definition.DeveloperName)
          || String(rec.MasterLabel || '').replace(/[^a-zA-Z0-9_]/g, '_');
        if (!an) continue;
        if (!tgtFlows[an]) tgtFlows[an] = { statuses: [], hasActive: false };
        tgtFlows[an].statuses.push(rec.Status);
        if (rec.Status === 'Active') tgtFlows[an].hasActive = true;
      }

      // 3 ─ the comparison org's Apex class names (optional probe).
      let apexNames = null;
      const ac = await depBg({
        type: 'SF_QUERY_ALL', orgUrl: target.orgUrl, sid: target.sid, tooling: true,
        query: 'SELECT Name FROM ApexClass', _silentError: true
      });
      if (ac && !ac.error) apexNames = (ac.records || []).map(x => x.Name).filter(Boolean);
      else notes.push(`Apex class list could not be read in ${target.label} — Apex references were NOT checked (${depFriendly(ac && ac.error)}).`);

      // 4 ─ describe every referenced object in the comparison org, cached.
      const objSet = new Set();
      for (const f of scope) {
        const refs = refsByFlowId[f.Id];
        if (!refs) continue;
        for (const o of (refs.objects || [])) if (o.name && o.name.indexOf('$') === -1) objSet.add(o.name);
      }
      let objs = [...objSet].sort();
      if (objs.length > DEP_XO_OBJECTS) {
        notes.push(`Capped at the first ${DEP_XO_OBJECTS} referenced objects (of ${objs.length}) — references to the rest were NOT checked.`);
        objs = objs.slice(0, DEP_XO_OBJECTS);
      }
      // Describe in BOTH orgs. Without the source pass, anything that is not a
      // real SObject (an Apex-defined variable type, say) 404s in the target and
      // would be reported as "missing there" — a lie. Only an object that
      // describes OK HERE can honestly be called missing over there.
      const describeIn = async (orgUrl2, sid2, o) => {
        const res = await depBg({
          type: 'SF_REST_GET', orgUrl: orgUrl2, sid: sid2, _silentError: true,
          path: `services/data/v62.0/sobjects/${encodeURIComponent(o)}/describe`
        });
        if (res && !res.error && Array.isArray(res.fields)) return { fields: res.fields };
        const msg = String((res && res.error) || 'no response');
        // A 404 / NOT_FOUND is a real answer ("absent"); anything else is "could not check".
        return /NOT_FOUND|404|does not exist|INVALID_TYPE/i.test(msg) ? null : { error: msg };
      };

      const describes = {};
      const canCheckHere = !!(_scanOrgUrl && _scanSid);
      if (!canCheckHere) {
        notes.push('This org\'s own schema could not be re-read, so a reference that is not a real SObject may show up as “missing in target”.');
      }
      for (let i = 0; i < objs.length; i += 5) {
        out.innerHTML = depSpin(`Describing objects in ${target.label}… ${i} / ${objs.length}`);
        await Promise.all(objs.slice(i, i + 5).map(async (o) => {
          const [here, there] = await Promise.all([
            canCheckHere ? describeIn(_scanOrgUrl, _scanSid, o) : Promise.resolve({ fields: [] }),
            describeIn(target.orgUrl, target.sid, o)
          ]);
          if (canCheckHere && here === null) {
            describes[o] = { error: 'not an SObject in this org either — probably an Apex-defined type, not compared' };
            return;
          }
          describes[o] = there;
        }));
      }

      // 5 ─ per-flow comparison (pure).
      const rows = [];
      const tgtFlowNames = Object.keys(tgtFlows);
      for (const f of scope) {
        const refs = refsByFlowId[f.Id] || null;
        const t = tgtFlows[f.ApiName];
        const cmp = refs ? depRefsMissingIn(refs, describes)
          : { missingObjects: [], missingFields: [], uncheckedObjects: [], uncheckedFields: [], checkedObjects: [] };
        rows.push({
          apiName: f.ApiName, masterLabel: f.MasterLabel, status: f.Status, flowId: f.Id,
          presence: !t ? 'missing' : (t.hasActive ? 'ok' : 'inactive'),
          targetStatuses: t ? t.statuses : [],
          refsAvailable: !!refs,
          missingObjects: cmp.missingObjects, missingFields: cmp.missingFields,
          uncheckedObjects: cmp.uncheckedObjects, uncheckedFields: cmp.uncheckedFields,
          missingSubflows: refs ? depMissingNames(refs.subflows, tgtFlowNames) : [],
          missingApex: (refs && apexNames) ? depMissingNames(refs.apex, apexNames) : [],
          apexChecked: !!apexNames
        });
      }
      notes.push('Custom labels, permissions, record types and picklist values are NOT compared here.');
      notes.push('Only the scanned version of each flow was compared — other versions may reference different fields.');

      _xoResult = {
        target: { url: target.orgUrl, label: target.label },
        rows, notes, generatedAt: new Date().toISOString(),
        scope: { activeOnly: !!opts.activeOnly, compared: rows.length, describedObjects: objs.length }
      };
      renderCrossOrgResult(out, _xoResult, orgUrl);
    } catch (e) {
      out.innerHTML = depErrBox('Cross-org diff failed', (e && e.message) || e);
    } finally {
      _xoRunning = false;
    }
  }

  function renderCrossOrgResult(out, res, orgUrl) {
    const rows = res.rows || [];
    const isBad = x => x.presence !== 'ok' || x.missingObjects.length || x.missingFields.length
      || x.missingSubflows.length || x.missingApex.length;
    const bad = rows.filter(isBad);
    const line = (icon, text) => `<div class="dep-blast-item">${icon} ${text}</div>`;
    const detail = x => {
      const bits = [];
      if (x.presence === 'missing') bits.push(line('❌', '<b>Does not exist in the comparison org.</b>'));
      else if (x.presence === 'inactive') bits.push(line('⚠', `<b>Exists but has no Active version there</b> (${escHtml((x.targetStatuses || []).join(', ') || 'unknown')}).`));
      if (x.missingObjects.length) bits.push(line('❌', `Objects missing there: ${escHtml(x.missingObjects.map(o => o.name).join(', '))}`));
      if (x.missingFields.length) bits.push(line('❌', `Fields missing there: ${escHtml(x.missingFields.map(f => f.ref).join(', '))}`));
      if (x.missingSubflows.length) bits.push(line('❌', `Subflows missing there: ${escHtml(x.missingSubflows.join(', '))}`));
      if (!x.apexChecked) bits.push(line('⚠', 'Apex references were <b>not checked</b> in the comparison org.'));
      else if (x.missingApex.length) bits.push(line('❌', `Apex missing there: ${escHtml(x.missingApex.join(', '))}`));
      if (!x.refsAvailable) bits.push(line('⚠', 'This flow\'s metadata never loaded, so <b>no references were compared</b> for it.'));
      if (x.uncheckedObjects.length) bits.push(line('⚠', `Objects that could NOT be checked: ${escHtml(x.uncheckedObjects.map(o => `${o.name} (${o.reason})`).join('; '))}`));
      if (x.uncheckedFields.length) bits.push(line('⚠', `References that could NOT be checked: ${escHtml(x.uncheckedFields.map(f => `${f.ref} (${f.reason})`).join('; '))}`));
      return bits.join('');
    };

    out.innerHTML = `
      <div class="dep-blast-verdict">
        <b>${bad.length}</b> of <b>${rows.length}</b> compared flow(s) have a problem in
        <b>${escHtml(res.target.label)}</b>. Read-only — nothing was written to either org.
        <div style="font-size:11px;color:var(--subtext,#706E6B);margin-top:3px">
          ${Number(res.scope.describedObjects) || 0} object(s) described in the comparison org · run at ${escHtml(res.generatedAt)}
        </div>
      </div>
      ${(res.notes || []).length ? `<div class="dep-blast-sec" style="border-left:3px solid var(--warning,#DD7A01);padding-left:8px">
        <div class="dep-blast-sec-hdr">What this diff did NOT check</div>
        ${res.notes.map(n => `<div class="dep-blast-item">${escHtml(n)}</div>`).join('')}</div>` : ''}
      <div class="dep-blast-sec">
        <div class="dep-blast-sec-hdr">Flows with a problem (${bad.length})</div>
        ${bad.length ? bad.map(x => `<div class="dep-ref-hit" style="display:block;cursor:pointer" data-flow-id="${escHtml(x.flowId)}">
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
              <span class="dep-node-name">${escHtml(x.masterLabel)}</span>
              <span class="badge ${x.status === 'Active' ? 'badge-active' : 'badge-draft'}">${escHtml(x.status || '')}</span>
              <span class="badge ${x.presence === 'ok' ? 'badge-active' : 'badge-obsolete'}">${x.presence === 'ok' ? 'in target' : (x.presence === 'inactive' ? 'inactive in target' : 'missing in target')}</span>
            </div>
            ${detail(x)}
          </div>`).join('')
    : '<div class="dep-blast-item">Every compared flow exists, is Active, and all of its checked references resolve in the comparison org.</div>'}
      </div>`;
    out.querySelectorAll('[data-flow-id]').forEach(el => el.addEventListener('click', () =>
      chrome.tabs.create({ url: `${orgUrl}/builder_platform_interaction/flowBuilder.app?flowId=${el.dataset.flowId}` })));
  }

  // ── N4e — export the whole report ─────────────────────────────────────
  // Assembles the plain data object; depReportMarkdown / depReportCsv (pure,
  // unit-tested) turn it into the two files.
  function buildReportObject(orgUrl) {
    const notes = [];
    if (!isMetadataFetched()) notes.push(`Flows whose metadata never loaded contribute nothing to this report — ${scanCaveat()}.`);
    notes.push('Only ONE version per flow (the Active one, else the highest) was analysed.');
    notes.push('Subflow relationships come from flow metadata only — flows started by buttons, Apex, REST, platform events or scheduled paths are invisible here.');
    notes.push('Custom labels, permissions, record types and picklist values are not analysed.');

    const apiNames = Object.keys(flowsByApiName).sort();
    const reps = [];
    for (const n of apiNames) { const f = repFlowFor(n); if (f) reps.push(f); }

    // Chains: every flow that calls a subflow but is not itself called (the
    // roots of the hierarchy) — that covers every edge at least once.
    const childSet = new Set(Object.keys(dependencyMap));
    const parentSet = new Set();
    for (const parents of Object.values(dependencyMap)) {
      for (const p of parents) if (p.apiName) parentSet.add(p.apiName);
    }
    let rootNames = [...parentSet].filter(n => !childSet.has(n)).sort();
    // Cycles have no root; make sure a purely cyclic cluster still appears.
    if (!rootNames.length) rootNames = [...childSet].sort();
    if (rootNames.length > DEP_EXPORT_CHAINS) {
      notes.push(`Chains capped at ${DEP_EXPORT_CHAINS} root flows (of ${rootNames.length}).`);
      rootNames = rootNames.slice(0, DEP_EXPORT_CHAINS);
    }
    const chains = rootNames.map(n => {
      const rep = repFlowFor(n);
      const c = chainFor(n);
      return { apiName: n, masterLabel: rep ? rep.MasterLabel : n, down: c.down, up: c.up };
    });

    // Blast radius: riskiest first (most callers), capped.
    let blastFlows = reps.slice().sort((a, b) =>
      (getParentsForApiName(b.ApiName).length - getParentsForApiName(a.ApiName).length)
      || String(a.MasterLabel || '').localeCompare(String(b.MasterLabel || '')));
    if (blastFlows.length > DEP_EXPORT_BLAST) {
      notes.push(`Blast-radius detail capped at ${DEP_EXPORT_BLAST} flows (of ${blastFlows.length}), most-called first.`);
      blastFlows = blastFlows.slice(0, DEP_EXPORT_BLAST);
    }
    const blast = blastFlows.map(f => {
      const callers = getParentsForApiName(f.ApiName);
      return {
        apiName: f.ApiName, masterLabel: f.MasterLabel, status: f.Status, processType: f.ProcessType,
        verdict: callers.length
          ? `⚠ ${callers.length} flow(s) call this as a subflow — deleting or deactivating it can break them.`
          : (f.Status === 'Active'
            ? '🟡 No flow calls this one. Still Active though — check buttons/pages that may launch it before deleting.'
            : '🟢 No flow calls this one and it is not Active — low-risk to delete.'),
        callers: callers.map(c => ({ apiName: c.apiName, masterLabel: c.masterLabel, status: c.status })),
        refs: refsByFlowId[f.Id] || null
      };
    });

    return {
      org: { url: orgUrl, label: depHost(orgUrl) },
      generatedAt: new Date().toISOString(),
      flowCount: reps.length,
      scanComplete: isMetadataFetched(),
      notes,
      dead: depDeadSubflows(dependencyMap, flowsByApiName),
      chains,
      blast,
      crossOrg: _xoResult
    };
  }

  function exportReport(orgUrl, statusEl) {
    try {
      const report = buildReportObject(orgUrl);
      const slug = (depOrgKey(orgUrl) || 'org').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40);
      // Org name + timestamp live in the FILENAME as well as inside both files.
      const base = `flow-dependency-report_${slug}_${depStamp(new Date())}`;
      const md = depReportMarkdown(report);
      const csv = depReportCsv(report);
      depDownload(`${base}.md`, md, 'text/markdown');
      depDownload(`${base}.csv`, csv, 'text/csv');
      if (statusEl) {
        statusEl.innerHTML = `<span style="color:var(--active-color,#2E844A)">✔ Downloaded <b>${escHtml(base)}.md</b> and <b>.csv</b></span>
          — ${report.flowCount} flow(s), ${report.chains.length} chain(s), ${report.dead.counts.dead} dead subflow(s)${report.crossOrg
  ? ', cross-org diff included'
  : '. <b>Cross-org diff NOT included</b> — it has not been run'}.
          <button class="btn-small" id="depReDlMd">↻ .md</button>
          <button class="btn-small" id="depReDlCsv">↻ .csv</button>
          <span style="color:var(--subtext,#706E6B)">(if the browser only saved one file)</span>`;
        statusEl.querySelector('#depReDlMd')?.addEventListener('click', () => depDownload(`${base}.md`, md, 'text/markdown'));
        statusEl.querySelector('#depReDlCsv')?.addEventListener('click', () => depDownload(`${base}.csv`, csv, 'text/csv'));
      }
      return base;
    } catch (e) {
      if (statusEl) statusEl.innerHTML = `<span style="color:var(--danger,#EA001E)">✖ Export failed: ${escHtml(depFriendly(e && e.message))}</span>`;
      return null;
    }
  }

  // Reverse lookup: which flows literally mention this term (field API name,
  // object, label, or any value like "Gold") anywhere in their metadata?
  function searchReferences(term) {
    const t = String(term || '').trim();
    if (!t) return [];
    const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const out = [];
    for (const [flowId, txt] of Object.entries(metaTextByFlowId)) {
      const n = (txt.match(re) || []).length;
      if (n) out.push({ flowId, count: n });
    }
    return out.sort((a, b) => b.count - a.count);
  }

  // 🧨 Blast radius panel — everything one flow touches + who calls IT,
  // ending in a plain-language delete/deactivate risk verdict.
  function showBlastRadius(flow) {
    document.querySelector('.dep-blast-panel')?.remove();
    const refs = refsByFlowId[flow.Id];
    const callers = getParentsForApiName(flow.ApiName);
    const verdict = callers.length
      ? `⚠ ${callers.length} flow(s) call this as a subflow — deleting or deactivating it can break them.`
      : (flow.Status === 'Active'
        ? '🟡 No flow calls this one. Still active though — check buttons/pages that may launch it before deleting.'
        : '🟢 No flow calls this one and it is not active — low-risk to delete.');
    const section = (title, items, fmt) => items && items.length
      ? `<div class="dep-blast-sec"><div class="dep-blast-sec-hdr">${title} (${items.length})</div>
          ${items.map(fmt || (x => `<div class="dep-blast-item">${escHtml(x)}</div>`)).join('')}</div>` : '';
    const panel = document.createElement('div');
    panel.className = 'dep-blast-panel';
    panel.innerHTML = `
      <div class="dep-blast-hdr">
        🧨 ${escHtml(flow.MasterLabel)}
        <span class="badge ${flow.Status === 'Active' ? 'badge-active' : 'badge-draft'}">${escHtml(flow.Status || '')}</span>
        <button class="btn-small dep-blast-chain" title="Show the full transitive subflow chain">🔗</button>
        <button class="btn-small dep-blast-close" title="Close">✖</button>
      </div>
      <div class="dep-blast-verdict">${verdict}</div>
      ${section('⬆ Called by', callers, c => `<div class="dep-blast-item">${escHtml(c.masterLabel)} <span class="badge ${c.status === 'Active' ? 'badge-active' : 'badge-draft'}">${escHtml(c.status || '')}</span></div>`)}
      ${refs ? `
        ${section('🗃 Objects', refs.objects, o => `<div class="dep-blast-item">${escHtml(o.name)} <span class="dep-blast-ops">${escHtml(o.ops.join(' · '))}</span></div>`)}
        ${section('🏷 Fields', refs.fields)}
        ${section('🔀 Calls subflows', refs.subflows)}
        ${section('⚙ Apex actions', refs.apex)}
        ${section('💬 Custom labels', refs.labels)}
        ${!refs.objects.length && !refs.fields.length && !refs.subflows.length && !refs.apex.length && !refs.labels.length
          ? '<div class="dep-blast-sec">No object/field/subflow/apex/label references found in this version\'s metadata.</div>' : ''}`
        : `<div class="dep-blast-sec">Reference details unavailable for this flow (its metadata didn't load${isMetadataFetched() ? '' : ` — ${scanCaveat()}`}).</div>`}`;
    document.body.appendChild(panel);
    panel.querySelector('.dep-blast-close').addEventListener('click', () => panel.remove());
    panel.querySelector('.dep-blast-chain').addEventListener('click', () => {
      panel.remove();
      showChainPanel(flow, _lastOrgUrl);
    });
  }

  return {
    reset,
    buildDependencyMap,
    getDependencyMap,
    getTriggerTypeMap,
    getTriggerObjectMap,
    isMetadataFetched,
    getParentsForApiName,
    getFlowsByApiName,
    renderDependencyTreeTab,
    getRefsFor,
    searchReferences,
    // P1 — scan sizing / lifecycle. popup.js goes through these instead of
    // touching depScanPlan directly so the pool width stays one constant.
    scanPlan,
    cancelScan,
    getScanStatus,
    // N4c / N4d / N4e
    chainFor,                                        // apiName -> { down, up } annotated trees
    getDeadSubflows: () => depDeadSubflows(dependencyMap, flowsByApiName),
    getCrossOrgResult: () => _xoResult,              // null until a diff has been run
    buildReportObject,                               // plain data for depReportMarkdown/depReportCsv
    exportReport,                                    // downloads the .md + .csv
    showChainPanel,
    showBlastRadius
  };
})();
