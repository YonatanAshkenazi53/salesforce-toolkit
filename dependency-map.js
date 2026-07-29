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

// ── Scan sizing (P1, batched in v1.0.2) ───────────────────────────────────────
// The dependency map needs ONE Tooling metadata READ per flow VERSION — the
// Flow tooling object is version-grained, so 400 definitions × 4 versions is
// 1600 reads. In v1.0.1 that was 1600 HTTP round-trips and the reported "first
// load takes a few minutes". Since v1.0.2 those reads travel in composite/batch
// chunks (background.js sfCompositeBatch), so the same 1600 reads cost
// ceil(1600 / chunkSize) round-trips — 160 at chunkSize 10.
//
// `reads` and `calls` are therefore DIFFERENT numbers now and both are
// reported: `reads` is what the org is asked for, `calls` is what goes over the
// wire. Every ETA is derived from `calls`, because that is what actually takes
// the time. Above autoMax the popup must NOT scan on open.
//
// Pure — the numbers the UI quotes and the pool that does the work both come
// from here (via DependencyMap.scanPlan), so an estimate can never drift from
// the real cost. The chunker below (depScanChunks) uses the SAME clamping rule
// as sftkBatchChunks in background.js, so `calls` is the exact round-trip count,
// not a ratio.
function depScanPlan(versionCount, opts) {
  const o = opts || {};
  const num = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  const autoMax     = Number.isFinite(o.autoMax) && o.autoMax >= 0 ? o.autoMax : 150;
  // Concurrency is now BATCHES in flight, not single reads. 3 matches
  // sfRunBatchedReads' default; 3 × 10 reads in flight is the same pressure on
  // the org as v1.0.1's 6 single reads, for a tenth of the round-trips.
  const concurrency = num(o.concurrency, 3);
  // Reads per round-trip. 25 is the server's hard ceiling on subrequest COUNT
  // (sftkBatchChunks enforces it); flow Metadata bodies are large, so the
  // default here is 10 — the size background.js' own contract recommends for
  // full flow metadata.
  let chunkSize     = Math.floor(num(o.chunkSize, 10));
  if (chunkSize > 25) chunkSize = 25;
  // Wall-clock per BATCH round-trip as seen by the pool. composite/batch runs
  // its subrequests serially server-side, so a 10-read batch is roughly
  // 10 × server-time + one network round-trip ≈ 1200 ms. That is a default, not
  // a measurement — `measured` says which one this is, and the first completed
  // scan replaces it with the real figure for this org/session.
  const msPerCall   = num(o.msPerCall, 1200);
  const versions    = Math.max(0, Math.floor(Number(versionCount) || 0));
  const reads       = versions;                        // one metadata read per version
  const calls       = Math.ceil(reads / chunkSize);    // …but ceil(reads/chunk) round-trips
  const estMs       = Math.round((calls * msPerCall) / concurrency);
  return {
    versions, reads, chunkSize, calls, batches: calls, concurrency, msPerCall, autoMax,
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

// ══ Batched metadata scan (v1.0.2) ═══════════════════════════════════════════
// The unit of work the pool above now hands out is a CHUNK of flow versions, not
// a single one. Everything that decides what goes into a chunk, what a chunk's
// answer means, and whether the run covered the org lives here at column 0 so it
// is unit-testable without a service worker.

// PURE. Split the todo list into chunks of at most `size`. Deliberately the same
// clamping rule as background.js' sftkBatchChunks (1..25, junk → the default)
// so the plan's `calls` is the number of round-trips that really happen. Input
// ORDER is the contract: chunk k covers positions [k*size, k*size+len).
function depScanChunks(items, size) {
  const MAX = 25;
  const list = Array.isArray(items) ? items : [];
  let n = Math.floor(Number(size));
  if (!Number.isFinite(n) || n < 1) n = 10;
  if (n > MAX) n = MAX;
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

// PURE. One chunk of flow records → the subrequest array SF_COMPOSITE_BATCH
// wants. The url is deliberately version-LESS ("tooling/sobjects/Flow/301x"):
// sftkBatchSubUrl rewrites the version to background.js' API_VERSION, so this
// file never carries a second copy of the version string that could go stale.
// A record with no Id yields an empty url, which sfRunBatchedReads/… reports as
// a failed item rather than silently shifting every later answer up one slot.
function depBatchSubrequests(chunk) {
  return (Array.isArray(chunk) ? chunk : []).map(f => ({
    method: 'GET',
    url: `tooling/sobjects/Flow/${(f && f.Id) || ''}`
  }));
}

// PURE. Read one batch's per-item results back onto the flow records that were
// sent, positionally (the primitive guarantees input order and refuses to align
// a mismatched length at all).
//
// The one judgement call: which failures COUNT AS COVERED.
//   • ok            → covered, metadata handed back for absorption.
//   • item failure  → covered. A metadata GET legitimately 404s for an obsolete
//                     version; v1.0.1 marked those scanned because retrying
//                     costs the same call and fails the same way.
//   • batchError    → NOT covered. That is "the whole CALL died" (HTTP error on
//                     the batch endpoint, unreadable body, unalignable results),
//                     which is retryable as a unit — marking those 10 versions
//                     scanned would silently turn a transient 500 into a
//                     permanent hole in the map.
//   • undefined     → NOT covered. The batch was never dispatched (Stop).
function depBatchApply(chunk, items) {
  const list = Array.isArray(chunk) ? chunk : [];
  const res  = Array.isArray(items) ? items : [];
  const out = { metas: [], covered: [], unread: [], callFailed: false };
  for (let i = 0; i < list.length; i++) {
    const flow = list[i];
    if (!flow || !flow.Id) continue;
    const r = res[i];
    if (r === undefined || r === null) { out.unread.push(flow); continue; }
    if (r.batchError) { out.unread.push(flow); out.callFailed = true; continue; }
    out.covered.push(flow);
    const meta = (r.ok && r.body && typeof r.body === 'object') ? r.body.Metadata : null;
    if (meta) out.metas.push({ flow, meta });
  }
  return out;
}

// PURE. The honest verdict for a whole run. `complete` is decided by ITEM
// coverage, never by "every chunk was dispatched" — a run whose batches all
// went out but three of which came back as batchError has NOT covered the org.
function depScanOutcome(total, covered, stopped) {
  const t = Math.max(0, Math.floor(Number(total) || 0));
  const c = Math.min(t, Math.max(0, Math.floor(Number(covered) || 0)));
  return { total: t, done: c, missing: t - c, stopped: !!stopped, complete: c === t };
}

// PURE. The API version a batch subrequest actually went out with. Every result
// item echoes the normalised url background.js sent ("v62.0/tooling/…"), so the
// popup can VERIFY the version it assumed for the cache key instead of trusting
// a hard-coded copy of a constant that lives in another file.
function depApiVersionOf(url) {
  const m = /^\/?(?:services\/data\/)?(v\d+(?:\.\d+)?)(?=[/?]|$)/i.exec(String(url == null ? '' : url).trim());
  return m ? m[1].toLowerCase() : '';
}

// ══ Incremental dependency cache (v1.0.2) ════════════════════════════════════
// Before v1.0.2 nothing persisted: every popup open called reset() and rescanned
// the org from zero. The cache below stores the built map plus, per flow VERSION
// id, the LastModifiedDate the Flow list query returned for it. On the next open
// the (already paid for) list query is diffed against those stamps and only the
// difference is read.
//
// Why LastModifiedDate is the right key: the Tooling Flow object is
// version-grained and carries the standard audit fields. An ACTIVE/OBSOLETE
// version is immutable, so its stamp never moves; a DRAFT that someone edits
// gets a new stamp and is re-read. There is no state in which the metadata
// changed and the stamp did not.
//
// Everything here is PURE and column 0 — the storage I/O that uses it is inside
// the module below.

// PURE. Cache key. Org identity comes from sftkOrgKey (one org has several
// domain forms), and the API version is part of the key because a different
// version can return a differently-shaped Metadata payload.
function depCacheKey(orgKey, apiVersion) {
  const k = String(orgKey == null ? '' : orgKey).trim().toLowerCase();
  const v = String(apiVersion == null ? '' : apiVersion).trim().toLowerCase();
  if (!k || !v) return '';   // unidentifiable org / unknown version → do not cache
  return `${k}|${v}`;
}

// PURE. The delta that decides what this scan pays for.
//   added     — in the org, no stamp cached  → must be read
//   changed   — stamp moved                  → must be re-read, old edges dropped
//   unchanged — stamp identical              → cached edges stand, zero cost
//   deleted   — stamped but no longer in the org → EVICTED, never left behind as
//               a phantom "flow X is called by <deleted flow>" edge
// A missing or unreadable stamp on EITHER side counts as changed. That is the
// one direction that costs a re-read instead of trusting an unverified edge.
function depCacheDelta(flows, stamps) {
  const list = Array.isArray(flows) ? flows : [];
  const have = (stamps && typeof stamps === 'object') ? stamps : {};
  const added = [], changed = [], unchanged = [];
  const seen = new Set();
  for (const f of list) {
    const id = f && f.Id;
    if (!id) continue;
    if (seen.has(id)) continue;              // duplicate row — count it once
    seen.add(id);
    if (!Object.prototype.hasOwnProperty.call(have, id)) { added.push(id); continue; }
    const now  = f.LastModifiedDate == null ? '' : String(f.LastModifiedDate);
    const then = have[id] == null ? '' : String(have[id]);
    if (!now || !then || now !== then) changed.push(id);
    else unchanged.push(id);
  }
  const deleted = Object.keys(have).filter(id => !seen.has(id));
  return {
    added, changed, unchanged, deleted,
    todo:  added.concat(changed),            // what the scan must actually read
    stale: changed.concat(deleted)           // whose cached edges must be evicted
  };
}

// PURE. Drop every dependency edge contributed by `dropIds`. The map is
// calledApiName → [{ id: CALLING version, … }], so a deleted or edited version
// is removed from every parent list it appears in. A key whose last parent goes
// away is removed with it — an empty array and an absent key both mean "nothing
// calls this", and keeping the key would only grow the cache.
function depMapEvict(map, dropIds) {
  const src = (map && typeof map === 'object') ? map : {};
  const drop = dropIds instanceof Set ? dropIds : new Set(Array.isArray(dropIds) ? dropIds : []);
  const out = {};
  for (const called of Object.keys(src)) {
    const parents = Array.isArray(src[called]) ? src[called] : [];
    const kept = parents.filter(p => p && !drop.has(p.id));
    if (kept.length) out[called] = kept;
  }
  return out;
}

// PURE. The strict twin of depMapEvict, used when a map is RESTORED FROM
// STORAGE: keep only the edges whose calling version is on the proven-unchanged
// list, and drop everything else. depMapEvict removes a known-bad set; this
// removes everything not known-good, which is the right default for data that
// came off disk. An entry written by an older build, a half-written key, or a
// stamp that went missing can all leave an edge whose parent is in no delta
// bucket at all — and an edge nobody can vouch for is exactly the phantom
// dependency (or the false "this flow is still called") to refuse.
function depMapKeepOnly(map, keepIds) {
  const src = (map && typeof map === 'object') ? map : {};
  const keep = keepIds instanceof Set ? keepIds : new Set(Array.isArray(keepIds) ? keepIds : []);
  const out = {};
  for (const called of Object.keys(src)) {
    const parents = Array.isArray(src[called]) ? src[called] : [];
    const kept = parents.filter(p => p && keep.has(p.id));
    if (kept.length) out[called] = kept;
  }
  return out;
}

// PURE. Keep only the entries of a flowId-keyed object whose id is in `ids`.
// Used to carry the trigger-type / refs side-tables across a load without
// carrying anything belonging to a version that changed or vanished.
function depPickIds(obj, ids) {
  const src = (obj && typeof obj === 'object') ? obj : {};
  const keep = ids instanceof Set ? ids : new Set(Array.isArray(ids) ? ids : []);
  const out = {};
  for (const id of keep) {
    if (Object.prototype.hasOwnProperty.call(src, id)) out[id] = src[id];
  }
  return out;
}

// PURE. May this entry be believed at all? Every "no" is a REASON string the UI
// can print, because "the cache was ignored" with no explanation is how a user
// concludes the feature is broken.
function depCacheUsable(entry, opts) {
  const o = opts || {};
  const e = (entry && typeof entry === 'object') ? entry : null;
  if (!e) return { ok: false, reason: 'no dependency cache has been stored for this org yet' };
  if (Number(e.schema) !== Number(o.schema)) {
    return { ok: false, reason: `the stored cache has a different shape (schema ${e.schema == null ? '?' : e.schema}, this build writes ${o.schema}) — it was discarded rather than half-read` };
  }
  if (String(e.apiVersion || '') !== String(o.apiVersion || '')) {
    return { ok: false, reason: `the cache was built against Salesforce API ${e.apiVersion || '(unknown)'} and this session uses ${o.apiVersion || '(unknown)'} — metadata can differ between versions, so it was discarded` };
  }
  if (String(e.orgKey || '') !== String(o.orgKey || '')) {
    return { ok: false, reason: 'the stored cache belongs to a different org' };
  }
  if (!e.stamps || typeof e.stamps !== 'object' || !Object.keys(e.stamps).length) {
    return { ok: false, reason: 'the cache carries no per-version LastModifiedDate stamps, so nothing in it can be proven current' };
  }
  if (!e.map || typeof e.map !== 'object') {
    return { ok: false, reason: 'the cache carries no dependency map' };
  }
  const maxAge = Number(o.maxAgeMs);
  if (Number.isFinite(maxAge) && maxAge > 0) {
    const age = Number(o.now || 0) - Number(e.builtAt || 0);
    if (age > maxAge) {
      return { ok: false, reason: `the cache is ${Math.floor(age / 86400000)} days old, past the ${Math.round(maxAge / 86400000)}-day limit — it was discarded` };
    }
  }
  return { ok: true, reason: '' };
}

// PURE. UTF-8 byte length of a serialized value. chrome.storage.local's quota is
// counted in bytes of the JSON serialization, so the budget below is MEASURED
// with this rather than guessed from item counts. Written out longhand (no
// TextEncoder) so it stays a free-variable-less pure function.
function depJsonBytes(str) {
  const s = String(str == null ? '' : str);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

// PURE. Shrink ONE org's entry until it fits `maxBytes`, least-valuable part
// first, and say what was given up. The order is deliberate:
//   1. refs   — the 🧨 blast-radius detail. Rebuildable from a rescan, and its
//               absence is already rendered as "reference details unavailable".
//   2. trigger types/objects — cosmetic (the refined flow-type badge).
//   3. nothing. A TRUNCATED map is never stored: a missing edge reads exactly
//      like "nothing calls this flow", which is the false all-clear this whole
//      feature must not produce. Over budget → cache nothing and say so.
function depCacheFit(entry, opts) {
  const o = opts || {};
  const max = Number.isFinite(Number(o.maxBytes)) && Number(o.maxBytes) > 0 ? Number(o.maxBytes) : 900000;
  if (!entry || typeof entry !== 'object') {
    return { entry: null, bytes: 0, dropped: [], stored: false, note: 'there was nothing to cache' };
  }
  const size = x => depJsonBytes(JSON.stringify(x));
  const e = { ...entry };
  const dropped = [];
  let bytes = size(e);
  if (bytes <= max) return { entry: e, bytes, dropped, stored: true, note: '' };

  if (e.refs) {
    delete e.refs;
    e.droppedRefs = true;
    dropped.push('refs');
    bytes = size(e);
  }
  if (bytes <= max) {
    return { entry: e, bytes, dropped, stored: true,
      note: 'this org\'s reference detail (🧨 blast radius, "what uses…") was too large to cache — the dependency edges were kept, and the detail comes back on a rescan' };
  }

  if (e.triggerTypes || e.triggerObjects) {
    delete e.triggerTypes;
    delete e.triggerObjects;
    e.droppedTriggers = true;
    dropped.push('triggerTypes', 'triggerObjects');
    bytes = size(e);
  }
  if (bytes <= max) {
    return { entry: e, bytes, dropped, stored: true,
      note: 'this org\'s reference detail and refined flow types were too large to cache — the dependency edges were kept, and both come back on a rescan' };
  }

  return { entry: null, bytes, dropped: dropped.concat(['map']), stored: false,
    note: `this org's dependency map is ${Math.round(bytes / 1024)} KB, over the ${Math.round(max / 1024)} KB budget one org may use — NOTHING was cached (a part of a map is indistinguishable from "no dependencies"), so the next open scans again` };
}

// PURE. Bound the WHOLE cache: at most `maxOrgs` orgs and `maxBytes` in total,
// least-recently-used evicted first. `keepKey` (the org being written right now)
// is never evicted for being old — only for not fitting the budget alone.
//
// This is what stops a 1600-version org from crowding out sftk_profiles /
// sftk_history: the budget is this feature's OWN slice of chrome.storage.local,
// enforced before the write, so the cache can never grow into anyone else's
// room no matter how large the org is.
function depCacheEvictLru(store, opts) {
  const o = opts || {};
  const maxOrgs = Number.isFinite(Number(o.maxOrgs)) && Number(o.maxOrgs) > 0 ? Math.floor(Number(o.maxOrgs)) : 3;
  const budget  = Number.isFinite(Number(o.maxBytes)) && Number(o.maxBytes) > 0 ? Number(o.maxBytes) : 1500000;
  const keepKey = o.keepKey == null ? '' : String(o.keepKey);
  const src = (store && typeof store === 'object') ? store : {};

  const rows = Object.keys(src).map(k => ({
    key: k,
    lastUsed: Number(src[k] && src[k].lastUsed) || 0,
    bytes: depJsonBytes(JSON.stringify(src[k]))
  }));
  rows.sort((a, b) => {
    if (a.key === keepKey) return -1;
    if (b.key === keepKey) return 1;
    if (b.lastUsed !== a.lastUsed) return b.lastUsed - a.lastUsed;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;   // deterministic ties
  });

  const kept = {};
  const evicted = [];
  let used = 0;
  let count = 0;
  for (const r of rows) {
    if (used + r.bytes > budget || count >= maxOrgs) { evicted.push(r.key); continue; }
    kept[r.key] = src[r.key];
    used += r.bytes;
    count++;
  }
  return { store: kept, evicted, bytes: used, count };
}

// PURE. Age of the cached half of the map, in words. "Show when the cache was
// built" — but a wall-clock timestamp alone reads as precision the number does
// not have once it is days old, so it degrades to a date.
function depCacheAge(builtAt, now) {
  const t = Number(builtAt) || 0;
  const n = Number(now) || 0;
  if (!t) return 'at an unknown time';
  const ms = n - t;
  if (ms < 0) return 'in the future (the machine clock moved)';
  const min = Math.floor(ms / 60000);
  if (min < 1)  return 'less than a minute ago';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)  return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const d = new Date(t);
  const p = x => String(x).padStart(2, '0');
  const days = Math.floor(hr / 24);
  return `${days} day${days === 1 ? '' : 's'} ago (${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())})`;
}

// PURE. The one sentence that tells "fully scanned just now" apart from "mostly
// cached, N updated" apart from "stale/partial". Cached data is NEVER described
// as freshly verified: what IS claimed for it is exactly what was proven — the
// version's LastModifiedDate has not moved since the map was built.
//   state: { running, complete, total, done, fromCache, cacheBuiltAt, now }
function depScanFreshness(state) {
  const s = state || {};
  const total  = Math.max(0, Math.floor(Number(s.total) || 0));
  const done   = Math.max(0, Math.floor(Number(s.done) || 0));
  const cached = Math.min(done, Math.max(0, Math.floor(Number(s.fromCache) || 0)));
  const fresh  = done - cached;
  const when   = depCacheAge(s.cacheBuiltAt, s.now);

  if (s.running) {
    return { level: 'running', cached, fresh,
      text: `Dependency map is building… ${done} of ${total} flow versions covered${cached ? ` (${cached} of them reused from a cache built ${when}, ${fresh} read live so far)` : ''}.` };
  }
  if (!total) {
    return { level: 'none', cached: 0, fresh: 0,
      text: 'No flow versions are loaded, so there is no dependency data.' };
  }
  if (!s.complete) {
    if (!done) {
      return { level: 'none', cached: 0, fresh: 0,
        text: 'No dependency data has been collected for this org — nothing below is "no dependencies", it is "not looked at".' };
    }
    return { level: 'partial', cached, fresh,
      text: `Partial: ${done} of ${total} flow versions are covered (${fresh} read live, ${cached} reused from a cache built ${when}). The other ${total - done} were never read, so anything they call is unknown.` };
  }
  if (!cached) {
    return { level: 'fresh', cached: 0, fresh,
      text: `All ${total} flow versions were read from Salesforce just now.` };
  }
  if (!fresh) {
    return { level: 'cached', cached, fresh: 0,
      text: `No flow version has changed since the cache was built ${when} — all ${total} still carry the same LastModifiedDate, so the map was reused and nothing was re-read.` };
  }
  return { level: 'incremental', cached, fresh,
    text: `${fresh} of ${total} flow versions were re-read just now; the other ${cached} still carry the LastModifiedDate they had when the cache was built ${when}, so their dependencies are unchanged.` };
}

// PURE. TASK C — is this map safe to answer a PERMANENT delete with?
//
// "Nothing calls flow X" is not a property of X: it is a property of EVERY OTHER
// flow's metadata. So a cached edge set is only trustworthy if every cached
// version is provably unchanged, which needs (a) LastModifiedDate on the list
// query and (b) that list to be no older than this answer. Re-reading only the
// flows being deleted would prove nothing at all.
//
//   safe             — the answer may be given as-is
//   needsLiveRecheck — a live LastModifiedDate query (+ a scan of whatever moved)
//                      would make it safe; the caller runs that and asks again
// Anything that is neither safe nor fixable by a recheck falls through to the
// existing "the subflow check has no data" gate, which asks the user.
function depDeleteTrust(state) {
  const s = state || {};
  const cached = Math.max(0, Math.floor(Number(s.fromCache) || 0));
  if (!s.complete) {
    return { safe: false, needsLiveRecheck: false,
      reason: 'the dependency map is incomplete, so "nothing calls this flow" would be a guess' };
  }
  if (!cached) {
    return { safe: true, needsLiveRecheck: false,
      reason: 'every flow version in this org was read live in this session' };
  }
  if (s.apiMismatch) {
    return { safe: false, needsLiveRecheck: true,
      reason: 'the Salesforce API version this session uses is not the one the cached map was built against, so cached edges cannot be trusted' };
  }
  if (!s.stampsAvailable) {
    return { safe: false, needsLiveRecheck: true,
      reason: 'this org\'s Flow list did not return LastModifiedDate, so cached edges cannot be proven current' };
  }
  if (!s.recheckedAt) {
    return { safe: false, needsLiveRecheck: true,
      reason: `${cached} of the ${Math.max(0, Math.floor(Number(s.total) || 0))} flow versions in this map came from the stored cache and have not been re-checked against the org since this popup opened` };
  }
  return { safe: true, needsLiveRecheck: false,
    reason: `cached edges were re-checked against a live LastModifiedDate query ${depCacheAge(s.recheckedAt, s.now)}` };
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
  let _scanCalls = 0;           // batch round-trips this scan actually made
  let _scanUnread = 0;          // versions left unread because their CALL failed
  // v1.0.2 — incremental cache state. _stamps is the LastModifiedDate the FLOW
  // LIST query returned for every version in this org (the list is already paid
  // for, so this costs nothing); _cachedIds is the subset of the map whose edges
  // came from storage rather than from a read in this session — the distinction
  // every honesty check below is built on.
  let _stamps = {};                 // flowVersionId -> LastModifiedDate (this session's list)
  let _cachedIds = new Set();       // ids whose edges were restored, not read
  let _stampsAvailable = false;     // the list query really returned LastModifiedDate
  let _cacheKey = '';               // orgKey|apiVersion, '' = do not cache
  let _cacheBuiltAt = 0;            // when the restored half of the map was gathered
  let _cacheNote = '';              // why the cache was skipped / what was dropped
  let _cacheState = 'none';         // 'none'|'miss'|'unusable'|'primed'|'disabled'
  let _cacheSaveNote = '';          // what the last write to storage did or refused to do
  let _apiMismatch = false;         // the version the batch really used ≠ the one we keyed on
  let _recheckedAt = 0;             // last live LastModifiedDate re-verification (delete path)
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
  // P1 — above this many flow VERSIONS TO READ the popup stops scanning on open
  // and asks first. Deliberately UNCHANGED at 150 in v1.0.2: batching made the
  // same work cheaper, it did not make it free, and quietly raising the bar
  // would start doing hundreds of reads on open in orgs that used to be asked.
  // What did change is what the threshold is measured against — the DELTA the
  // scan must actually read, not the org's total size. A 1600-version org whose
  // cache is warm and has three edited drafts scans those three on open.
  const DEP_SCAN_AUTO_MAX    = 150;
  const DEP_SCAN_CONCURRENCY = 3;   // composite/batch round-trips in flight
  const DEP_SCAN_CHUNK       = 10;  // metadata reads per round-trip. 25 is the
                                    // server ceiling on COUNT, but flow Metadata
                                    // bodies are large — 10 is the size
                                    // background.js' own contract recommends for
                                    // full flow metadata. 3 × 10 in flight is the
                                    // same pressure v1.0.1's 6 single GETs applied.
  // ── Persistent cache (v1.0.2) ────────────────────────────────────────────
  const DEP_CACHE_STORE   = 'sftk_dep_cache';  // ONE chrome.storage.local key
  const DEP_CACHE_SCHEMA  = 1;                 // bump on ANY shape change → old entries dropped
  const DEP_CACHE_MAX_ORGS = 3;                // LRU: the orgs you actually work in
  // Budgets, in BYTES of the JSON that goes to storage and MEASURED with
  // depJsonBytes before every write — never estimated from entry counts.
  // chrome.storage.local is ~10 MB for this extension and is shared with
  // sftk_profiles / sftk_history / apex_log_viewer_* (see PRIVACY.md), so this
  // feature takes a hard 1.5 MB slice and never grows past it whatever the org
  // size. One org may use at most 900 KB of that slice.
  const DEP_CACHE_MAX_BYTES       = 1500000;
  const DEP_CACHE_ENTRY_MAX_BYTES = 900000;
  const DEP_CACHE_MAX_AGE_MS      = 30 * 24 * 60 * 60 * 1000;
  // The API version the cache is keyed on. background.js owns the real constant
  // and this file cannot import it, so this is an ASSUMPTION — and it is
  // verified, not trusted: depApiVersionOf() reads the version off the url the
  // batch primitive really sent and _apiMismatch drops the cache if they differ.
  const DEP_API_VERSION = 'v62.0';

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
    _scanCalls = 0;
    _scanUnread = 0;
    // Every cache field is org-scoped. Carrying one across a switch would let
    // the NEW org's map be judged fresh by the OLD org's stamps.
    _stamps = {};
    _cachedIds = new Set();
    _stampsAvailable = false;
    _cacheKey = '';
    _cacheBuiltAt = 0;
    _cacheNote = '';
    _cacheState = 'none';
    _cacheSaveNote = '';
    _apiMismatch = false;
    _recheckedAt = 0;
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
    // Not const: if the API-version check below invalidates the cached head
    // start, those versions stop counting as already covered.
    let already = total - todo.length;
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

    // v1.0.2 — the pool's unit of work is a CHUNK of versions, delivered by one
    // composite/batch round-trip. Same pool, same cancellation, same per-item
    // progress; a tenth of the HTTP calls. The chunker is the same one
    // DependencyMap.scanPlan() sizes with, so the call count the UI quoted is
    // the call count this loop makes.
    const chunks = depScanChunks(todo, DEP_SCAN_CHUNK);
    let covered = 0;       // versions this run actually settled
    let callsMade = 0;     // round-trips that came back with something
    let unread = 0;        // versions inside batches whose CALL failed

    const run = await depRunPool(chunks, async (chunk) => {
      let items = null;
      try {
        const resp = await depBg({
          type: 'SF_COMPOSITE_BATCH',
          orgUrl,
          sid,
          subrequests: depBatchSubrequests(chunk),
          chunkSize: DEP_SCAN_CHUNK,
          // One batch per message — the pool above owns the concurrency so its
          // Stop stays granular (checked before every round-trip).
          concurrency: 1,
          // A metadata read can legitimately 404 for a deleted / obsolete flow
          // version — the map skips those silently, so don't flag them as hard
          // errors in the debug log.
          _suppressError: true
        });
        // The dispatcher answers with the per-item ARRAY, or the usual { error }
        // envelope on a session/dispatch failure. An envelope means the whole
        // round-trip is unread — NOT ten empty flows.
        if (Array.isArray(resp)) { items = resp; callsMade++; }
      } catch (_) {
        items = null;   // treated as an unread batch below, never as "no subflows"
      }

      const applied = depBatchApply(chunk, items);
      // Verify the API version the subrequests really went out with against the
      // one the cache is keyed on. The primitive echoes the normalised url, so
      // this is an observation, not an assumption.
      if (items && items.length) {
        const seen = depApiVersionOf(items.find(r => r && r.url)?.url);
        if (seen && seen !== DEP_API_VERSION) _apiMismatch = true;
      }
      for (const { flow, meta } of applied.metas) absorbFlowMeta(flow, meta);
      for (const f of applied.covered) {
        if (!_scannedIds.has(f.Id)) { _scannedIds.add(f.Id); covered++; }
      }
      unread += applied.unread.length;

      // Progress is counted in VERSIONS, not batches, so the existing "n / m"
      // UI stays literally true. It can jump by up to DEP_SCAN_CHUNK — which is
      // the truth: those versions really did settle at the same instant.
      _scanDone = already + covered;
      if (progressCallback) progressCallback(_scanDone, total);
      else if (fallbackMsgEl) fallbackMsgEl.textContent = `Scanning flow metadata… ${_scanDone} / ${total}`;
    }, {
      concurrency: DEP_SCAN_CONCURRENCY,
      shouldStop
    });

    // Superseded by a newer reset()/scan — that run owns the module state now,
    // so don't touch fetchInProgress or the completion flag.
    if (myToken !== _runToken) return dependencyMap;

    fetchInProgress = false;
    _scanCalls = callsMade;

    // The version check paid off: the reads really went out against a different
    // API version than the one the cache was keyed on, so the edges restored
    // from that cache describe a version this session is not talking to. They
    // are dropped rather than blended into a map that would then look complete.
    // The versions go back on the todo list, so a resume re-reads them for real.
    if (_apiMismatch && _cachedIds.size) {
      const stale = [..._cachedIds];
      dependencyMap = depMapEvict(dependencyMap, stale);
      for (const id of stale) {
        _scannedIds.delete(id);
        delete triggerTypeMap[id];
        delete triggerObjectMap[id];
        delete refsByFlowId[id];
      }
      _cachedIds = new Set();
      _cacheBuiltAt = 0;
      _cacheState = 'unusable';
      _cacheNote = 'the stored map for this org was built against a different Salesforce API version than the one these reads used, so it was discarded — the versions it covered still need reading';
      already = Math.max(0, already - stale.length);
      await dropCacheEntry();
    }

    // Completeness is decided by VERSION coverage, never by "every batch was
    // dispatched": a run whose batches all went out but three of which came back
    // as batchError has not covered the org, and those versions stay out of
    // _scannedIds so a resume re-reads them.
    const outcome = depScanOutcome(total, already + covered, run.stopped);
    _scanDone = outcome.done;
    if (outcome.complete) {
      metadataFetched = true;
      _scanAbort = false;
      // Feed the next estimate this org's real latency instead of the default.
      // Measured per ROUND-TRIP now, because that is the unit depScanPlan's ETA
      // multiplies — measuring per version would quote a tenth of the truth.
      if (callsMade > 0) {
        _scanMsPerCall = Math.round(((Date.now() - startedAt) * DEP_SCAN_CONCURRENCY) / callsMade);
      }
    }
    // Persist whatever was covered — a partial map is worth resuming from, and
    // it is stored WITH stamps only for the versions actually read, so the next
    // open sees the rest as "never seen" and reads them. `unread` is kept for
    // the caveat text: those versions failed at the CALL level, not the item
    // level, so they are worth retrying.
    _scanUnread = unread;
    await saveCacheEntry(flows);
    return dependencyMap;
  }

  // One flow's Metadata → every side-table the map keeps. Split out of the pool
  // body so the batched and the delete-path re-verification scans absorb results
  // through exactly one piece of code.
  function absorbFlowMeta(flow, meta) {
    if (!flow || !flow.Id || !meta || typeof meta !== 'object') return;
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
      // A re-read of the SAME version must replace its edges, not duplicate
      // them — this runs again for every version the delta says changed.
      if (dependencyMap[calledApiName].some(p => p && p.id === flow.Id)) continue;
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
      msPerCall: _scanMsPerCall,
      // v1.0.2 — how much of `done` was READ and how much was REUSED. Every
      // caller that prints a coverage number gets the split, so "covered" can
      // never be quietly read as "verified just now".
      calls: _scanCalls,
      unread: _scanUnread,
      fromCache: _cachedIds.size,
      cacheBuiltAt: _cacheBuiltAt,
      cacheState: _cacheState,
      cacheNote: _cacheNote,
      cacheSaveNote: _cacheSaveNote,
      stampsAvailable: _stampsAvailable,
      apiMismatch: _apiMismatch,
      recheckedAt: _recheckedAt
    };
  }

  // The one sentence that says how fresh this map is — see depScanFreshness.
  function freshness() {
    return depScanFreshness({
      running: fetchInProgress,
      complete: metadataFetched,
      total: _scanTotal,
      done: _scanDone,
      fromCache: _cachedIds.size,
      cacheBuiltAt: _cacheBuiltAt,
      now: Date.now()
    });
  }

  // Single source of truth for scan sizing — popup.js asks through here so the
  // quoted cost and the pool that pays it can never disagree. `versionCount` is
  // the number of versions that still have to be READ, not the org's size: with
  // a warm cache those are different numbers and quoting the second would
  // promise a scan far larger than the one that runs.
  function scanPlan(versionCount) {
    return depScanPlan(versionCount, {
      autoMax: DEP_SCAN_AUTO_MAX,
      concurrency: DEP_SCAN_CONCURRENCY,
      chunkSize: DEP_SCAN_CHUNK,
      msPerCall: _scanMsPerCall || undefined
    });
  }

  // Versions still to read, after the cache and any partial scan. This is what
  // scanPlan should be sized with everywhere.
  function pendingCount(flows) {
    const list = Array.isArray(flows) ? flows : [];
    let n = 0;
    for (const f of list) if (f && f.Id && !_scannedIds.has(f.Id)) n++;
    return n;
  }

  function getDependencyMap() { return dependencyMap; }
  function isMetadataFetched() { return metadataFetched; }

  // What the reverse lookup ("what uses…") can actually see. The full metadata
  // TEXT of every flow is megabytes and is never cached, so after a cache-primed
  // load the literal search covers only the versions read in this session. A
  // search that silently covered 40 of 1600 versions and said "no flow mentions
  // X" would be the exact false negative this module exists to prevent.
  function searchCoverage() {
    const have = Object.keys(metaTextByFlowId).length;
    const total = _scanTotal || have;
    return { have, total, full: have >= total && metadataFetched };
  }

  // One accurate phrase behind every "why is this incomplete" caveat. Since P1
  // the scan can be running, stopped part-way, or never started at all (large
  // org, no auto-scan) — printing "still running" for the last two is a lie.
  function scanCaveat() {
    if (metadataFetched) return '';
    if (fetchInProgress)  return `the metadata scan is still running (${_scanDone} / ${_scanTotal})`;
    if (_scannedIds.size) return `the metadata scan was stopped at ${_scanDone} of ${_scanTotal} flow versions`;
    return 'the dependency scan has not been run for this org';
  }

  // ══ Persistent incremental cache ═══════════════════════════════════════════

  function depStorageGet(key) {
    return new Promise((resolve) => {
      try { chrome.storage.local.get([key], (o) => resolve((o && o[key]) || null)); }
      catch (_) { resolve(null); }
    });
  }

  function depStorageSet(key, value) {
    return new Promise((resolve) => {
      try { chrome.storage.local.set({ [key]: value }, () => resolve(!chrome.runtime.lastError)); }
      catch (_) { resolve(false); }
    });
  }

  // Read the whole cache object, tolerating anything that is not the shape we
  // wrote (a hand-edited or half-written key must never throw here).
  async function readCacheStore() {
    const raw = await depStorageGet(DEP_CACHE_STORE);
    if (!raw || typeof raw !== 'object' || Number(raw.v) !== DEP_CACHE_SCHEMA) return {};
    return (raw.orgs && typeof raw.orgs === 'object') ? raw.orgs : {};
  }

  // TASK B ENTRY POINT. Called by popup.js right after the flow LIST query —
  // which the popup already pays for — and BEFORE the scan is sized. Costs zero
  // HTTP round-trips: it reads chrome.storage.local and diffs it against the
  // list that is already in hand.
  //
  // Returns { used, cached, toScan, deleted, builtAt, reason } and, when it can,
  // leaves the module holding the cached map minus every stale edge and
  // _scannedIds seeded with the versions that need no read at all.
  async function primeFromCache(flows, orgUrl) {
    if (fetchInProgress || metadataFetched) {
      return { used: false, cached: 0, toScan: 0, deleted: 0, reason: 'a scan for this org is already running or finished' };
    }
    const myToken = _runToken;
    const list = Array.isArray(flows) ? flows : [];

    // Record this session's stamps first — they are what a later save writes and
    // what the delete-path re-check compares against, cache hit or miss.
    _stamps = {};
    _stampsAvailable = list.length > 0;
    for (const f of list) {
      if (!f || !f.Id) continue;
      const lmd = f.LastModifiedDate == null ? '' : String(f.LastModifiedDate);
      if (!lmd) _stampsAvailable = false;
      _stamps[f.Id] = lmd;
    }

    const orgKey = depOrgKey(orgUrl);
    _cacheKey = _stampsAvailable ? depCacheKey(orgKey, DEP_API_VERSION) : '';
    _cachedIds = new Set();
    _cacheBuiltAt = 0;

    if (!list.length) {
      _cacheState = 'none';
      _cacheNote = '';
      return { used: false, cached: 0, toScan: 0, deleted: 0, reason: 'no flow versions were loaded' };
    }
    if (!_stampsAvailable) {
      // Without a freshness field nothing can be proven unchanged, so nothing is
      // reused AND nothing is written. Degrading to "trust it anyway" here is
      // exactly the stale-data-as-fresh failure this must not have.
      _cacheState = 'disabled';
      _cacheNote = 'the Flow list did not return LastModifiedDate for every version, so no cached dependency data can be proven current — this org is read live every time and nothing is cached';
      return { used: false, cached: 0, toScan: list.length, deleted: 0, reason: _cacheNote };
    }
    if (!_cacheKey) {
      _cacheState = 'disabled';
      _cacheNote = 'this org could not be identified from its URL, so no dependency cache is kept for it';
      return { used: false, cached: 0, toScan: list.length, deleted: 0, reason: _cacheNote };
    }

    const store = await readCacheStore();
    if (myToken !== _runToken) {
      return { used: false, cached: 0, toScan: 0, deleted: 0, reason: 'the org changed while the cache was being read' };
    }
    const entry = store[_cacheKey];
    const usable = depCacheUsable(entry, {
      schema: DEP_CACHE_SCHEMA,
      apiVersion: DEP_API_VERSION,
      orgKey,
      now: Date.now(),
      maxAgeMs: DEP_CACHE_MAX_AGE_MS
    });
    if (!usable.ok) {
      _cacheState = entry ? 'unusable' : 'miss';
      _cacheNote = usable.reason;
      return { used: false, cached: 0, toScan: list.length, deleted: 0, reason: usable.reason };
    }

    const delta = depCacheDelta(list, entry.stamps);
    // EVICT FIRST, and keep only what is PROVEN. A version that was edited or
    // deleted must lose its cached edges before anything can read the map, or
    // "flow X is called by <a flow that no longer exists>" survives as a phantom
    // dependency. depMapKeepOnly goes further than "drop the stale ones": an
    // edge whose caller is in no delta bucket at all (older entry, half-written
    // key, missing stamp) is vouched for by nothing, so it goes too.
    const keep = new Set(delta.unchanged);
    dependencyMap    = depMapKeepOnly(entry.map, keep);
    triggerTypeMap   = depPickIds(entry.triggerTypes, keep);
    triggerObjectMap = depPickIds(entry.triggerObjects, keep);
    refsByFlowId     = depPickIds(entry.refs, keep);
    // Never cached (megabytes of raw metadata text) — searchCoverage() reports
    // the resulting gap instead of letting the literal search answer "no".
    metaTextByFlowId = {};
    _scannedIds = new Set(delta.unchanged);
    _cachedIds  = new Set(delta.unchanged);
    _scanTotal  = list.length;
    _scanDone   = delta.unchanged.length;
    _cacheBuiltAt = Number(entry.builtAt) || 0;
    _cacheState = 'primed';
    _cacheNote = [
      entry.droppedRefs ? 'reference detail (🧨 blast radius) was not cached for this org because of its size — it comes back on a rescan' : '',
      entry.droppedTriggers ? 'refined flow types were not cached for this org because of its size' : ''
    ].filter(Boolean).join('; ');

    return {
      used: true,
      cached: delta.unchanged.length,
      toScan: delta.todo.length,
      added: delta.added.length,
      changed: delta.changed.length,
      deleted: delta.deleted.length,
      builtAt: _cacheBuiltAt,
      reason: ''
    };
  }

  // Write this org's entry back, bounded twice: depCacheFit caps ONE org, then
  // depCacheEvictLru caps the whole feature. Nothing here can grow into another
  // feature's share of chrome.storage.local — the byte budget is measured on the
  // exact JSON that is about to be written, not guessed from entry counts.
  async function saveCacheEntry(flows) {
    _cacheSaveNote = '';
    if (!_cacheKey || !_stampsAvailable) return { stored: false, note: _cacheNote };
    if (_apiMismatch) {
      _cacheSaveNote = 'the Salesforce API version the batch really used is not the one this build expects, so nothing was cached for this org';
      return { stored: false, note: _cacheSaveNote };
    }
    if (!_scannedIds.size) return { stored: false, note: 'nothing has been scanned yet' };

    const list = Array.isArray(flows) ? flows : [];
    const stamps = {};
    for (const f of list) {
      if (!f || !f.Id) continue;
      if (!_scannedIds.has(f.Id)) continue;      // never stamp a version we did not cover
      const lmd = _stamps[f.Id];
      if (lmd) stamps[f.Id] = lmd;
    }
    if (!Object.keys(stamps).length) return { stored: false, note: 'nothing verifiable to cache' };

    const now = Date.now();
    const candidate = {
      schema: DEP_CACHE_SCHEMA,
      orgKey: depOrgKey(_scanOrgUrl),
      apiVersion: DEP_API_VERSION,
      // The cached HALF keeps its original build time: those versions really
      // were gathered then, and LastModifiedDate is what proves they still hold.
      builtAt: (_cachedIds.size && _cacheBuiltAt) ? _cacheBuiltAt : now,
      updatedAt: now,
      lastUsed: now,
      complete: metadataFetched,
      stamps,
      map: dependencyMap,
      triggerTypes: triggerTypeMap,
      triggerObjects: triggerObjectMap,
      refs: refsByFlowId
    };

    const fit = depCacheFit(candidate, { maxBytes: DEP_CACHE_ENTRY_MAX_BYTES });
    if (!fit.stored) {
      _cacheSaveNote = fit.note;
      // Drop any older entry for this org too — keeping a stale one next to a
      // map we refused to store is worse than having none.
      const store = await readCacheStore();
      if (store[_cacheKey]) {
        delete store[_cacheKey];
        await depStorageSet(DEP_CACHE_STORE, { v: DEP_CACHE_SCHEMA, orgs: store });
      }
      return { stored: false, note: fit.note };
    }

    const store = await readCacheStore();
    store[_cacheKey] = fit.entry;
    const bounded = depCacheEvictLru(store, {
      maxOrgs: DEP_CACHE_MAX_ORGS,
      maxBytes: DEP_CACHE_MAX_BYTES,
      keepKey: _cacheKey
    });
    const ok = await depStorageSet(DEP_CACHE_STORE, { v: DEP_CACHE_SCHEMA, orgs: bounded.store });
    if (!ok) {
      _cacheSaveNote = 'the dependency cache could not be written to local storage — the next open will scan again';
      return { stored: false, note: _cacheSaveNote };
    }
    _cacheSaveNote = [
      fit.note,
      bounded.evicted.filter(k => k !== _cacheKey).length
        ? `${bounded.evicted.filter(k => k !== _cacheKey).length} other org(s) were dropped from the cache to stay inside its ${Math.round(DEP_CACHE_MAX_BYTES / 1024)} KB budget`
        : ''
    ].filter(Boolean).join('; ');
    // The org we just wrote was evicted for not fitting the whole-cache budget.
    if (bounded.evicted.includes(_cacheKey)) {
      _cacheSaveNote = `this org's dependency map does not fit the ${Math.round(DEP_CACHE_MAX_BYTES / 1024)} KB the cache may use, so it was not stored`;
      return { stored: false, note: _cacheSaveNote };
    }
    return { stored: true, note: _cacheSaveNote, bytes: fit.bytes };
  }

  // Remove this org's stored entry, leaving every other org's alone.
  async function dropCacheEntry() {
    const store = await readCacheStore();
    const key = _cacheKey || depCacheKey(depOrgKey(_scanOrgUrl || _lastOrgUrl), DEP_API_VERSION);
    if (!key || !store[key]) return false;
    delete store[key];
    await depStorageSet(DEP_CACHE_STORE, { v: DEP_CACHE_SCHEMA, orgs: store });
    return true;
  }

  // Drop this org's cached entry. Exposed so a user who does not want the map
  // persisted (or who suspects it) can clear it without clearing everything.
  async function clearCache() {
    const dropped = await dropCacheEntry();
    if (!dropped) return false;
    _cacheState = 'none';
    _cacheNote = 'the stored dependency cache for this org was cleared';
    return true;
  }

  // ══ TASK C — the destructive path stays authoritative ══════════════════════
  // "Nothing calls this flow" is a claim about every OTHER flow's metadata, so a
  // single cached edge anywhere makes the whole answer only as current as the
  // cache. deleteTrust() says whether the answer may be given as-is; when it
  // says needsLiveRecheck, recheckForDelete() below makes it true again.

  function deleteTrust() {
    return depDeleteTrust({
      complete: metadataFetched,
      fromCache: _cachedIds.size,
      total: _scanTotal,
      stampsAvailable: _stampsAvailable,
      apiMismatch: _apiMismatch,
      recheckedAt: _recheckedAt,
      now: Date.now()
    });
  }

  // Re-establish authority before a PERMANENT delete, at the cost of ONE list
  // query plus a batched read of whatever actually moved.
  //
  //   1. Re-query the Flow list (Id + the same descriptive fields popup.js uses,
  //      plus LastModifiedDate). One paginated query.
  //   2. Diff it against the stamps backing the current map. Versions that
  //      changed lose their cached edges; versions that vanished are evicted;
  //      versions that appeared since this popup opened are NEW callers we have
  //      never read and are added to the todo.
  //   3. Read the difference through the same batched scan.
  //   4. Only if every one of those settled does _recheckedAt move — a partial
  //      re-check leaves the answer untrusted rather than "mostly checked".
  //
  // A failure at any step returns ok:false with a reason; the caller must then
  // ask the user rather than proceed on an unverified all-clear.
  async function recheckForDelete(orgUrl, sid, onProgress) {
    if (!metadataFetched) {
      return { ok: false, reason: 'the dependency map is not complete, so there is nothing to re-verify' };
    }
    const myToken = _runToken;
    let res;
    try {
      res = await depBg({
        type: 'SF_QUERY_ALL',
        orgUrl, sid, tooling: true,
        query: 'SELECT Id,MasterLabel,Definition.DeveloperName,VersionNumber,Status,ProcessType,LastModifiedDate FROM Flow',
        _suppressError: true
      });
    } catch (e) {
      return { ok: false, reason: `the re-check query failed (${depFriendly(e && e.message)})` };
    }
    if (!res || res.error) {
      return { ok: false, reason: `the re-check query failed (${depFriendly(res && res.error)})` };
    }
    if (myToken !== _runToken) {
      return { ok: false, reason: 'the org changed while the re-check was running' };
    }

    const live = (res.records || []).map(f => ({
      ...f,
      ApiName: f.Definition?.DeveloperName || String(f.MasterLabel || '').replace(/[^a-zA-Z0-9_]/g, '_')
    }));
    if (!live.length) {
      return { ok: false, reason: 'the re-check query returned no flow versions at all, which cannot be right for an org that just listed some' };
    }
    if (!live.every(f => f.LastModifiedDate)) {
      return { ok: false, reason: 'the re-check query did not return LastModifiedDate, so cached edges still cannot be proven current' };
    }

    const delta = depCacheDelta(live, _stamps);
    // Everything the delta calls stale loses its edges and its scanned mark, so
    // the scan below genuinely re-reads it.
    if (delta.stale.length) {
      dependencyMap = depMapEvict(dependencyMap, delta.stale);
      for (const id of delta.stale) {
        _scannedIds.delete(id);
        _cachedIds.delete(id);
        delete triggerTypeMap[id];
        delete triggerObjectMap[id];
        delete refsByFlowId[id];
        delete metaTextByFlowId[id];
        delete _stamps[id];
      }
    }
    for (const f of live) _stamps[f.Id] = String(f.LastModifiedDate);

    const before = { added: delta.added.length, changed: delta.changed.length, deleted: delta.deleted.length };
    if (delta.todo.length) {
      // Re-open the scan over the (usually tiny) difference. metadataFetched is
      // cleared first so nothing can read a half-updated map as complete.
      metadataFetched = false;
      _scanTotal = live.length;
      _scanDone  = _scannedIds.size;
      // A real callback (even a no-op) keeps buildDependencyMap from painting
      // its fallback loading cat over the Dependencies tab mid-delete.
      await buildDependencyMap(live, orgUrl, sid,
        typeof onProgress === 'function' ? onProgress : () => {});
      if (myToken !== _runToken) {
        return { ok: false, reason: 'the org changed while the re-check was running' };
      }
      if (!metadataFetched) {
        return { ok: false, ...before, reason: `${delta.todo.length} flow version(s) changed since this popup opened and could not all be re-read` };
      }
    } else {
      // Nothing to re-read, but versions may have been DELETED — the by-API-name
      // index still lists them until it is rebuilt from the live list.
      _scanTotal = live.length;
      _scanDone  = _scannedIds.size;
      flowsByApiName = {};
      for (const f of live) {
        if (!flowsByApiName[f.ApiName]) flowsByApiName[f.ApiName] = [];
        flowsByApiName[f.ApiName].push(f);
      }
      if (delta.deleted.length) await saveCacheEntry(live);
    }

    // Cached edges that survived the diff are now proven current AS OF NOW.
    _recheckedAt = Date.now();
    return { ok: true, ...before, flows: live, rescanned: delta.todo.length, reason: '' };
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
      // The literal index is the raw metadata TEXT, which is far too large to
      // cache — so after a cache-primed load it covers only the versions read in
      // THIS session. Saying "no flow mentions X" from a 40-of-1600 index would
      // be a false negative dressed as an answer.
      const cov = searchCoverage();
      const covWarn = cov.full ? ''
        : `<b style="color:var(--warning,#DD7A01)"> — this search read the metadata text of ${cov.have} of ${cov.total} flow versions${isMetadataFetched() ? ' (the rest came from the stored dependency cache, which does not keep their text)' : `, and ${scanCaveat()}`}, so there may be more.</b>`;
      refResults.innerHTML = hits.length
        ? `<div class="dep-ref-hdr">${hits.length} flow(s) mention “${escHtml(term)}” <span class="dep-ref-note">(literal, case-insensitive match in the flow's metadata)</span>${covWarn}</div>`
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
    pendingCount,
    cancelScan,
    getScanStatus,
    scanCaveat,
    freshness,
    searchCoverage,
    // v1.0.2 — incremental cache + the destructive-path guarantee.
    primeFromCache,
    clearCache,
    deleteTrust,
    recheckForDelete,
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
