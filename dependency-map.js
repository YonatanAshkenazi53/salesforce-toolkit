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
// PURE. Salesforce stores Record-Triggered, Scheduled and Platform-Event flows
// as ProcessType 'AutoLaunchedFlow'; the TRIGGER tells them apart (Setup's own
// list shows "Autolaunched Flow" + Trigger "Record—Run After Save"). Values are
// those of FlowDefinitionView.TriggerType and of Metadata.start.triggerType.
function depResolveFlowType(processType, triggerType) {
  if (processType !== 'AutoLaunchedFlow') return processType;   // Prompt, Routing, Screen… keep their own name
  const t = String(triggerType || '');
  if (/^Record/i.test(t)) return 'RecordTriggeredFlow';           // Record—Run After Save / Before Save / Before Delete…
  if (t === 'Scheduled')     return 'ScheduledFlow';
  if (t === 'PlatformEvent') return 'PlatformEventFlow';
  return processType;
}

// PURE. Every subflow reachable from the given flows (transitively), for a
// whole-tree backup. The map is stored called → callers, so it is inverted
// once. Roots themselves are not returned; cycles simply stop; `cap` bounds
// the walk and is reported as `truncated` rather than silently applied.
function depSubflowClosure(dependencyMap, rootApiNames, cap) {
  const map = (dependencyMap && typeof dependencyMap === 'object') ? dependencyMap : {};
  const limit = Number(cap) > 0 ? Number(cap) : 500;
  const kids = {};
  for (const called of Object.keys(map)) {
    for (const p of (Array.isArray(map[called]) ? map[called] : [])) {
      const pn = p && p.apiName; if (!pn) continue;
      (kids[pn] = kids[pn] || new Set()).add(called);
    }
  }
  const roots = (Array.isArray(rootApiNames) ? rootApiNames : []).filter(Boolean);
  const seen = new Set(roots); const out = []; let truncated = false;
  const queue = roots.slice();
  while (queue.length) {
    const n = queue.shift();
    for (const c of (kids[n] ? [...kids[n]].sort() : [])) {
      if (seen.has(c)) continue;
      if (out.length >= limit) { truncated = true; break; }
      seen.add(c); out.push(c); queue.push(c);
    }
    if (truncated) break;
  }
  return { names: out, truncated };
}

// N4d / N4e — PURE helpers.
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
// How deep the Dependencies TREE is drawn. Loops cannot happen (each branch
// carries its own visited set); this only bounds a pathological tree.
const DEP_TREE_MAX_DEPTH = 25;

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
//   managedByApiName : apiName -> managed-package flow row ({ label, active })
//                      from FlowDefinitionView — the Tooling flow list never
//                      contains these, so without it every managed subflow
//                      target read as "missing" (reproduced on a real org
//                      2026-09-12). A managed target is neither missing nor
//                      dead: it exists, and its own callers inside the package
//                      are invisible to this map.
function depDeadSubflows(dependencyMap, flowsByApiName, managedByApiName) {
  const map = (dependencyMap && typeof dependencyMap === 'object') ? dependencyMap : {};
  const byName = (flowsByApiName && typeof flowsByApiName === 'object') ? flowsByApiName : {};
  const managed = (managedByApiName && typeof managedByApiName === 'object') ? managedByApiName : {};
  const dead = [], missing = [], inactiveTargets = [], managedTargets = [];

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

    if (!versions.length && managed[called]) {
      const m = managed[called] || {};
      managedTargets.push({ apiName: called, masterLabel: m.label || called, active: !!m.active,
        callers, activeCallerCount: activeCallers.length });
      continue;   // exists in a package — never "missing", never judged "dead"
    }
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
    dead, missing, inactiveTargets, managedTargets,
    counts: {
      subflowTargets: Object.keys(map).length,
      dead: dead.length,
      missing: missing.length,
      inactiveTargets: inactiveTargets.length,
      managed: managedTargets.length
    }
  };
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
  const mg = Array.isArray(dead.managedTargets) ? dead.managedTargets : [];
  if (mg.length) {
    push(`### 1.4 Subflow references into managed packages (${mg.length})`);
    push('');
    push('_These flows exist, but Salesforce hides their contents and their own callers inside the package — they are neither missing nor dead._');
    push('');
    push('| Referenced API name | Active in package | Called by |');
    push('| --- | --- | --- |');
    for (const x of mg) {
      push(`| ${esc(x.apiName)} | ${x.active ? 'yes' : 'NO'} | ${esc((x.callers || []).map(c => `${c.apiName} (${c.status || '?'})`).join(', ') || '—')} |`);
    }
    push('');
  }

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

  return L.join('\n');
}

// N4e — the tabular slices of the same report as one CSV. A `Section` column
// keeps dead subflows and chain edges in one greppable file instead of
// forcing two downloads. Pure.
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
  for (const x of (dead.managedTargets || [])) {
    add('Managed subflow target', x.apiName, x.masterLabel || '', x.active ? 'Active' : 'Inactive', 'In a managed package',
      `contents hidden by Salesforce | called by: ${(x.callers || []).map(c => `${c.apiName} (${c.status || '?'})`).join(', ') || 'unknown'}`);
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

  return rows.map(row => row.map(cell).join(',')).join('\r\n');
}

// ── Scan sizing (P1, batched in v1.1.0) ───────────────────────────────────────
// The dependency map needs ONE Tooling metadata READ per flow VERSION — the
// Flow tooling object is version-grained, so 400 definitions × 4 versions is
// 1600 reads. In v1.0.1 that was 1600 HTTP round-trips and the reported "first
// load takes a few minutes". Since v1.1.0 those reads travel in composite/batch
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
  // Concurrency is now BATCHES in flight, not single reads. 3 × 10 reads in
  // flight is the same pressure on the org as v1.0.1's 6 single reads, for a
  // tenth of the round-trips.
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

// ══ Batched metadata scan (v1.1.0) ═══════════════════════════════════════════
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
// A record with no Id yields an empty url, which the batch call reports as a
// failed item rather than silently shifting every later answer up one slot.
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
//   • 404           → covered. A metadata GET legitimately 404s for an obsolete
//                     version; retrying costs the same call and fails the same
//                     way. "Gone" is a real answer.
//   • other failure → NOT covered (QA 2026-07-29). A 403 (no permission on a
//                     managed-package flow), 400 or 500 means we do not KNOW
//                     what this version calls. Counting it as covered recorded
//                     it as calling NOTHING, which flows straight into
//                     depDeleteTrust: the map reports `complete`, the delete
//                     panel shows no callers, and the user deletes a flow that
//                     something still calls. Leaving it unread makes the scan
//                     honestly incomplete, and depDeleteTrust already refuses
//                     to call an incomplete map safe.
//   • batchError    → NOT covered. That is "the whole CALL died" (HTTP error on
//                     the batch endpoint, unreadable body, unalignable results),
//                     which is retryable as a unit — marking those 10 versions
//                     scanned would silently turn a transient 500 into a
//                     permanent hole in the map.
//   • undefined     → NOT covered. The batch was never dispatched (Stop).
// PURE. Has THIS flow's metadata actually been read? versions: the flow's
// version records; scannedIds: versions whose metadata GET settled (this
// session or restored from the cache). A flow with unscanned versions has
// UNKNOWN subflow calls — "Standalone" and "Calls no subflows" are claims
// the map cannot make about it (user 2026-09-03: "copy of test has a
// subflow and it wont show here. why?").
function depFlowScanState(versions, scannedIds) {
  const vs = Array.isArray(versions) ? versions.filter(v => v && v.Id) : [];
  const ids = scannedIds instanceof Set ? scannedIds : new Set(scannedIds || []);
  const scanned = vs.filter(v => ids.has(v.Id)).length;
  const total = vs.length;
  const state = total === 0 ? 'unscanned' : scanned === total ? 'scanned' : scanned === 0 ? 'unscanned' : 'partial';
  return { total, scanned, unscanned: total - scanned, state };
}

// PURE. The subflows ONE version calls, read back out of the map (edges are
// stored per called flow, so a version's own calls have to be gathered).
function depCallsOfVersion(dependencyMap, versionId) {
  const out = [];
  for (const [called, parents] of Object.entries(dependencyMap || {})) {
    if ((parents || []).some(p => p && p.id === versionId)) out.push(called);
  }
  return out.sort();
}

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
    // Only a success or a definitive 404 proves anything about this version.
    if (!r.ok && Number(r.status) !== 404) { out.unread.push(flow); continue; }
    // A 200 whose body carries no Metadata field proves NOTHING about what
    // this version calls (the general batch endpoint answers exactly like
    // this) — it is UNREAD, never "no subflows". Found 2026-09-14.
    if (r.ok && !(r.body && typeof r.body === 'object' && Object.prototype.hasOwnProperty.call(r.body, 'Metadata'))) {
      out.unread.push(flow); out.noMetadata = (out.noMetadata || 0) + 1; continue;
    }
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

// PURE. QA 2026-07-29 (F7) — the API version a QUERY's records were really
// served on. Every SOQL/Tooling query record echoes its own REST url in
// attributes.url ("/services/data/v62.0/tooling/sobjects/Flow/301…"), so the
// version the wire actually used is already in hand on every list query — no
// extra HTTP call and no scan needed. This is what lets the fully-warm-cache
// path (zero batches dispatched) still verify the version assumption the
// cache key is built on; before it, that check lived only inside the scan
// worker and could never fire on precisely the path that trusts the cache
// most. Returns '' (= nothing observable, do not judge) when no record
// carries a parseable url.
function depListApiVersion(records) {
  for (const r of (Array.isArray(records) ? records : [])) {
    const url = r && r.attributes && r.attributes.url;
    if (!url) continue;
    const m = /\/services\/data\/(v\d+(?:\.\d+)?)(?=[/?])/i.exec(String(url));
    if (m) return m[1].toLowerCase();
  }
  return '';
}

// PURE. QA 2026-07-29 (F2) — did the delete-path re-check's Flow list cover
// the WHOLE org? sfQueryAll reports the server's own total (serverTotal)
// alongside the rows it actually returned; a Tooling query can cap
// server-side even when pagination is followed to exhaustion. Treating a
// capped list as authoritative would make every version missing from it read
// as DELETED — evicting live edges and then stamping the re-check as
// complete. A capped list makes the whole re-check PARTIAL: evict nothing,
// stamp nothing, and say why. An unknown serverTotal is "no evidence of a
// cap", not "capped" — the caller keeps its other guards either way.
function depRecheckCoverage(gotCount, serverTotal) {
  const got = Math.max(0, Math.floor(Number(gotCount) || 0));
  const t = Number(serverTotal);
  if (!Number.isFinite(t) || t <= got) return { complete: true, got, missing: 0, reason: '' };
  return {
    complete: false,
    got,
    missing: t - got,
    reason: `the org returned ${got} of ${t} flow versions — the re-check could not complete, so nothing was evicted and cached edges remain unverified`
  };
}

// PURE. QA 2026-07-29 (F3) — cached edges carry the CALLING version's
// MasterLabel / VersionNumber / Status / ProcessType from when the cache was
// BUILT. Status in particular moves without the version's own metadata
// changing (activating v5 flips v4 to Obsolete), so a delete-dependency
// table rendered from cached edges can show a now-Active parent wearing a
// stale grey 'Draft' chip. Given a LIVE flow list, refresh those descriptive
// fields on every edge whose calling version (matched by Id) is in it; an
// edge whose caller is not in the live list is left untouched rather than
// blanked. Never mutates its input.
function depMapRefreshFields(map, liveFlows) {
  const src = (map && typeof map === 'object') ? map : {};
  const byId = new Map();
  for (const f of (Array.isArray(liveFlows) ? liveFlows : [])) {
    if (f && f.Id) byId.set(f.Id, f);
  }
  const out = {};
  for (const called of Object.keys(src)) {
    const parents = Array.isArray(src[called]) ? src[called] : [];
    out[called] = parents.map(p => {
      const f = p && byId.get(p.id);
      if (!f) return p;
      return {
        ...p,
        masterLabel: f.MasterLabel,
        apiName: f.ApiName != null ? f.ApiName : p.apiName,
        versionNumber: f.VersionNumber,
        status: f.Status,
        processType: f.ProcessType
      };
    });
  }
  return out;
}

// ══ Incremental dependency cache (v1.1.0) ════════════════════════════════════
// Before v1.1.0 nothing persisted: every popup open called reset() and rescanned
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
  // How long a live re-check keeps authorising deletes. Short enough that a
  // long-lived popup cannot answer from stale edges, long enough that deleting
  // several flows in a row does not re-query for each one. Declared inside the
  // function so the unit test can extract it standalone.
  const DEP_RECHECK_TTL_MS = 5 * 60 * 1000;
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
  // A re-check proves the cache was current AT THAT MOMENT, not forever
  // (QA 2026-07-29). Without an expiry, one re-check authorised every later
  // delete in the session — a popup left open for hours would still answer
  // "nothing calls this" from edges last proven that morning, while someone
  // else adds a caller. Deletes are irreversible; re-proving costs one query.
  const age = Math.max(0, (Number(s.now) || Date.now()) - Number(s.recheckedAt));
  if (age > DEP_RECHECK_TTL_MS) {
    return { safe: false, needsLiveRecheck: true,
      reason: `cached edges were last proven current ${depCacheAge(s.recheckedAt, s.now)} — too long ago to answer a delete, since a new caller could have been added since` };
  }
  return { safe: true, needsLiveRecheck: false,
    reason: `cached edges were re-checked against a live LastModifiedDate query ${depCacheAge(s.recheckedAt, s.now)}` };
}

const DependencyMap = (() => {
  let dependencyMap = {}; // subflowApiName -> [{ id, masterLabel, versionNumber, status, processType }]
  let flowsByApiName = {}; // apiName -> [flow records]
  // 🔒 Managed-package flows (user 2026-09-03: "where are the managed flows?").
  // The Tooling Flow object that feeds everything above NEVER returns them, and
  // the dependency index holds nothing for them either (live, both directions)
  // — so they are LISTED from FlowDefinitionView/FlowVersionView and their
  // dependencies are shown as UNKNOWN, never as "none". null = not read yet.
  let _managedFlows = null;
  // true when the tree was painted while the managed-flow list was still
  // loading — a managed subflow target then read "Not found" (user
  // 2026-09-18: the cached map paints instantly, the list lands later).
  let _treePaintedBeforeManaged = false;
  let _managedNote = '';
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
  // v1.1.0 — incremental cache state. _stamps is the LastModifiedDate the FLOW
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
  let _cacheDroppedRefs = false;    // the primed entry's 🧨 reference detail was dropped for size
  let _cacheState = 'none';         // 'none'|'miss'|'unusable'|'primed'|'disabled'
  let _cacheSaveNote = '';          // what the last write to storage did or refused to do
  let _apiMismatch = false;         // the version the batch really used ≠ the one we keyed on
  let _recheckedAt = 0;             // last live LastModifiedDate re-verification (delete path)
  // Org list for the ⚙ / ⏻ cross-org pickers, cached per popup session.
  let _lastOrgUrl = '';    // org the tab was last rendered for (context menu has no orgUrl)
  let _lastSid = '';       // …and its session — the ⚙/⏻ panels need one even when no scan ran (audit 2026-09-12)
  let _depActiveFilter = 'all';   // process-type filter, shared with the async-painted 🔒 section
  let _scanOrgUrl = '';    // org context the current map was scanned with…
  let _scanSid = '';       // …and its session

  const DEP_CHAIN_DEPTH   = 6;    // depth cap for depChain() in the UI
  const DEP_EXPORT_BLAST  = 200;  // max flows detailed in the exported report
  const DEP_EXPORT_CHAINS = 50;   // max chains detailed in the exported report
  // P1 — above this many flow VERSIONS TO READ the popup stops scanning on open
  // and asks first. Deliberately UNCHANGED at 150 in v1.1.0: batching made the
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
  // ── Persistent cache (v1.1.0) ────────────────────────────────────────────
  const DEP_CACHE_STORE   = 'sftk_dep_cache';  // ONE chrome.storage.local key
  const DEP_CACHE_SCHEMA  = 4;                 // bump on ANY shape change → old entries dropped (4: 2026-09-14, caches written by the blind general-endpoint reader are dropped)
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
    _managedFlows = null;   // per org — the previous org's managed flows must not survive a switch
    _managedNote = '';
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
    _cacheDroppedRefs = false;
    _cacheState = 'none';
    _cacheSaveNote = '';
    _apiMismatch = false;
    _recheckedAt = 0;
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
    // Remember the org context this map belongs to (cache key, delete re-check).
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

    // v1.1.0 — the pool's unit of work is a CHUNK of versions, delivered by one
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

      // QA 2026-07-29 (F1): the await above can span a reset() — an org switch
      // while this batch was in flight. Everything below writes MODULE state
      // (map absorption, _scannedIds, _apiMismatch, _scanDone, the progress
      // UI), so a superseded run must drop its answer HERE, not only after the
      // pool drains — or the previous org's batch lands in the new org's
      // dependency map. A user Stop (_scanAbort) deliberately does NOT drop
      // it: those versions really settled in THIS org and counting them is
      // the honest coverage number.
      if (myToken !== _runToken) return;

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
      // v1.1.0 — how much of `done` was READ and how much was REUSED. Every
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

  // The caveat every "no flow uses X" answer must carry while the org has
  // managed-package flows: their metadata is hidden by Salesforce, so the
  // answer is "none of the flows we could read", never "none".
  function managedCaveat() {
    if (_managedFlows === null) return 'managed-package flows have not been listed yet, so they are not included in this answer';
    if (!_managedFlows.length) return '';
    return `${_managedFlows.length} managed-package flow(s) are listed but their contents are hidden by Salesforce, so they were not searched`;
  }

  // Read the org's managed flows (REST, two steps — see depFlowVersions) and
  // paint the 🔒 section if the Dependencies tab is showing. Never throws.
  async function loadManagedFlows(orgUrl, sid) {
    const myToken = _runToken;
    let rows = [], note = '';
    try {
      const r = await depFlowVersions(orgUrl, sid);
      if (r && r.error) note = `managed-package flows could not be listed (${r.error})`;
      else {
        rows = sftkFlowVerRows((r && r.records) || []).filter(f => f.managed);
        if (r && r.note) note = r.note;
      }
    } catch (e) { note = `managed-package flows could not be listed (${e && e.message ? e.message : e})`; }
    if (myToken !== _runToken) return 0;   // the org changed under us
    _managedFlows = rows;
    _managedNote = note;
    const host = document.getElementById('depManagedSection');
    if (host) paintManagedSection(host);
    return rows.length;
  }

  function getManagedFlows() { return _managedFlows ? _managedFlows.slice() : null; }
  // Does the tree on screen call something "Not found" that the managed list
  // now knows? Only then is a repaint worth it.
  function treeStaleForManaged() {
    if (!_treePaintedBeforeManaged || !_managedFlows) return false;
    try { return depDeadSubflows(dependencyMap, flowsByApiName, depManagedMap()).managedTargets.length > 0; }
    catch (_) { return false; }
  }
  // apiName → managed row, for every place that decides whether a subflow
  // target EXISTS (tree, chains, dead-subflow report).
  function depManagedRow(apiName) {
    return (_managedFlows || []).find(f => f && f.apiName === apiName) || null;
  }
  function depManagedMap() {
    const out = {};
    for (const f of (_managedFlows || [])) if (f && f.apiName) out[f.apiName] = f;
    return out;
  }

  // One row per managed flow: label, namespace, type, status, API version —
  // and no link, because the platform gives its versions no record id.
  // YYYY-MM-DD in the user's own time zone; '' for anything unreadable.
  function depShortDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function depDatesHtml(createdIso, modifiedIso) {
    const c = depShortDate(createdIso), m = depShortDate(modifiedIso);
    if (!c && !m) return '';
    return `<span class="dep-node-dates" style="font-size:10.5px;color:var(--subtext,#706E6B);margin-left:4px" title="This version: created ${c || '?'} · last modified ${m || '?'}">${c ? `created ${c}` : ''}${c && m ? ' · ' : ''}${m ? `modified ${m}` : ''}</span>`;
  }

  function paintManagedSection(host) {
    const rows = _managedFlows;
    if (rows === null) {
      host.innerHTML = `<div class="dep-section-header dep-standalone-header">🔒 Managed package flows — reading…</div>`;
      return;
    }
    if (!rows.length) {
      host.innerHTML = `<div class="dep-section-header dep-standalone-header" title="${escHtml(_managedNote || 'FlowDefinitionView lists no installed-package flows in this org.')}">🔒 Managed package flows (0)${_managedNote ? ' — could not be listed' : ''}</div>`;
      return;
    }
    host.innerHTML = `<div class="dep-section-header dep-standalone-header" title="Flows installed by managed packages. Salesforce hides their contents from every API, so this tool cannot read what they call or which fields they use — their dependencies are UNKNOWN here, not empty.">🔒 Managed package flows (${rows.length}) <span style="font-weight:400;font-size:11px;opacity:.8">— contents hidden by Salesforce; dependencies unknown, not empty</span></div>`;
    const list = document.createElement('div');
    list.className = 'dep-children';
    list.style.display = 'none';
    for (const f of rows) {
      const gov = sftkFlowGoverningVer(f);
      const ns = String(f.apiName).split('__')[0];
      const el = document.createElement('div');
      el.className = 'dep-node dep-managed-node'
        + (_depActiveFilter !== 'all' && (f.processType || '') !== _depActiveFilter ? ' dep-dimmed' : '');
      el.dataset.processType = f.processType || '';
      el.innerHTML = `<span class="dep-node-icon">🔒</span> <span class="dep-node-name">${escHtml(f.label || f.apiName)}</span>`
        + ` <span class="badge dep-type-badge" title="Namespace of the installed package">${escHtml(ns)}</span>`
        + ` <span class="badge dep-type-badge">${escHtml(humanProcessType(f.processType))}</span>`
        + ` <span class="badge ${f.active ? 'badge-active' : 'badge-draft'}">${f.active ? 'Active' : (gov && gov.status) || 'Inactive'}</span>`
        + (gov && gov.apiVersion ? ` <span class="badge dep-type-badge" title="Pinned to Salesforce API ${escHtml(gov.apiVersion)} — the package's to change, not yours.">API ${escHtml(gov.apiVersion)}</span>` : '')
        + ` <span style="font-size:10.5px;color:var(--subtext,#706E6B)">v${escHtml(String((gov && gov.versionNumber) || '?'))}${gov && gov.lastModified && depShortDate(gov.lastModified) ? ` · modified ${escHtml(depShortDate(gov.lastModified))}` : ''} · contents hidden by Salesforce</span>`;
      list.appendChild(el);
    }
    host.appendChild(list);
    host.querySelector('.dep-section-header').addEventListener('click', () => {
      const isOpen = list.style.display !== 'none';
      list.style.display = isOpen ? 'none' : '';
    });
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
    _cacheDroppedRefs = false;

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

    // QA 2026-07-29 (F7): verify the API-version ASSUMPTION at load, not only
    // inside the scan worker. A fully-warm cache dispatches ZERO batches, so
    // the worker's wire check could never fire on exactly the path that
    // trusts the cache most. The flow list's own records echo the version
    // their request really went out on (attributes.url), so the comparison is
    // free. A mismatch means DEP_API_VERSION has drifted from the version
    // background.js actually uses — every stored entry is keyed on the wrong
    // assumption, so the cache is treated as cold: nothing primed, and
    // _apiMismatch also blocks any save until the constant is fixed.
    const wireVer = depListApiVersion(list);
    if (wireVer && wireVer !== DEP_API_VERSION) {
      _apiMismatch = true;
      _cacheState = 'unusable';
      _cacheNote = `this session's Salesforce reads use API ${wireVer} but this build's dependency cache is keyed to ${DEP_API_VERSION} — the stored cache was treated as cold and nothing will be cached, so this org is read live`;
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
    // Remembered so the 🧨 blast panel can name the REAL reason a restored
    // version has no reference detail (dropped for size at store time),
    // instead of blaming a metadata load that never happened (QA F5).
    _cacheDroppedRefs = !!entry.droppedRefs;
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
    // QA 2026-07-29 (F1): this function awaits storage I/O, and a reset() (org
    // switch) can land inside those awaits. Post-await it must not write the
    // superseded org's entry under the NEW org's state (_cacheKey is '' right
    // after a reset, so the write would land under a junk key) nor stamp
    // _cacheSaveNote into the new org's status line.
    const myToken = _runToken;
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
      if (myToken !== _runToken) return { stored: false, note: 'the org changed while the cache was being written' };
      if (store[_cacheKey]) {
        delete store[_cacheKey];
        await depStorageSet(DEP_CACHE_STORE, { v: DEP_CACHE_SCHEMA, orgs: store });
      }
      return { stored: false, note: fit.note };
    }

    const store = await readCacheStore();
    if (myToken !== _runToken) return { stored: false, note: 'the org changed while the cache was being written' };
    store[_cacheKey] = fit.entry;
    const bounded = depCacheEvictLru(store, {
      maxOrgs: DEP_CACHE_MAX_ORGS,
      maxBytes: DEP_CACHE_MAX_BYTES,
      keepKey: _cacheKey
    });
    const ok = await depStorageSet(DEP_CACHE_STORE, { v: DEP_CACHE_SCHEMA, orgs: bounded.store });
    if (myToken !== _runToken) return { stored: !!ok, note: 'the org changed while the cache was being written' };
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
        // DefinitionId rides along for popup.js (QA F4): versions this
        // re-check DISCOVERS get merged into its flow list, and its
        // deactivate-parent path cannot work without their DefinitionId.
        query: 'SELECT Id,MasterLabel,Definition.DeveloperName,DefinitionId,VersionNumber,Status,ProcessType,ApiVersion,LastModifiedDate FROM Flow',
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
    // QA 2026-07-29 (F2): a server-capped list is NOT authoritative. Without
    // this gate, every version the cap cut off would land in delta.deleted
    // below — its live edges evicted as "deleted" — and _recheckedAt would
    // then stamp the re-check as completed. Partial re-check = evict nothing,
    // stamp nothing, and tell the user why the check could not complete.
    const cov = depRecheckCoverage(live.length, res.serverTotal);
    if (!cov.complete) {
      return { ok: false, reason: cov.reason };
    }
    // QA 2026-07-29 (F7): the re-check list also echoes the wire version —
    // verify it here too, since this is the answer a PERMANENT delete trusts.
    const wireVer = depListApiVersion(live);
    if (wireVer && wireVer !== DEP_API_VERSION) {
      _apiMismatch = true;
      return { ok: false, reason: `the re-check ran on Salesforce API ${wireVer} but the cached map is keyed to ${DEP_API_VERSION}, so cached edges cannot be proven current` };
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

    // QA 2026-07-29 (F3): edges that SURVIVED the diff still carry the
    // calling version's Status/MasterLabel/VersionNumber/ProcessType from
    // cache-build time — and Status moves without the version's metadata
    // changing (activating v5 obsoletes v4). The delete-dependency table
    // renders straight from this map, so merge the live list's descriptive
    // fields in now, before anything below renders or persists them.
    dependencyMap = depMapRefreshFields(dependencyMap, live);

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
  function renderDependencyTreeTab(allFlows, container, orgUrl, sid) {
    container.innerHTML = '';
    _treePaintedBeforeManaged = (_managedFlows === null);
    _lastOrgUrl = orgUrl || _lastOrgUrl;
    _lastSid = sid || _lastSid;
    _depActiveFilter = 'all';
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
      const covWarn = (cov.full ? ''
        : `<b style="color:var(--warning,#DD7A01)"> — this search read the metadata text of ${cov.have} of ${cov.total} flow versions${isMetadataFetched() ? ' (the rest came from the stored dependency cache, which does not keep their text)' : `, and ${scanCaveat()}`}, so there may be more.</b>`)
        + (managedCaveat() ? `<b style="color:var(--warning,#DD7A01)"> 🔒 ${escHtml(managedCaveat())}.</b>` : '');
      refResults.innerHTML = hits.length
        ? `<div class="dep-ref-hdr">${hits.length} flow(s) mention “${escHtml(term)}” <span class="dep-ref-note">(literal, case-insensitive match in the flow's metadata)</span>${covWarn}</div>`
          + hits.map(h => {
            const f = byId[h.flowId];
            if (!f) return '';
            return `<div class="dep-ref-hit" data-id="${escHtml(f.Id)}" title="Open in Flow Builder">
              <span class="dep-node-name">${escHtml(f.MasterLabel)}</span>
              <span class="badge dep-type-badge">${escHtml(humanProcessType(f.ProcessType))}</span>
              <span class="badge ${f.Status === 'Active' ? 'badge-active' : 'badge-draft'}">${escHtml(f.Status || '')}</span>
              ${f.ApiVersion ? `<span class="badge dep-type-badge" title="Pinned to Salesforce API ${f.ApiVersion} \u2014 the flow keeps this version's behaviour regardless of the org's release. Compare and change it in \u2699 API versions.">API ${f.ApiVersion}</span>` : ''}
              <span class="dep-ref-count">×${h.count}</span>
            </div>`;
          }).join('')
        : `<div class="dep-ref-hdr">No flow that could be read mentions “${escHtml(term)}”${isMetadataFetched() ? '' : ` — but ${scanCaveat()}, so this search covered only part of the org`}.${managedCaveat() ? ` <b style="color:var(--warning,#DD7A01)">🔒 ${escHtml(managedCaveat())}.</b>` : ''}</div>`;
      refResults.querySelectorAll('.dep-ref-hit').forEach(row =>
        row.addEventListener('click', () =>
          chrome.tabs.create({ url: `${orgUrl}/builder_platform_interaction/flowBuilder.app?flowId=${row.dataset.id}` })));
    };
    document.getElementById('depRefGo')?.addEventListener('click', runRefSearch);
    document.getElementById('depRefSearch')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') runRefSearch();
      if (e.key === 'Escape') { e.target.value = ''; refResults.innerHTML = ''; }
    });

    // Lazy tools. Nothing here runs until the user asks for it: the ⚙ and ⏻
    // panels read other orgs only once opened.
    const toolsRow = document.createElement('div');
    toolsRow.className = 'dep-tools-row';
    toolsRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 8px 2px';
    toolsRow.innerHTML = `
      <button class="btn-small" id="depBulkBtn" title="Switch triggered flows off and back on in bulk, by object, in this org — record-triggered, scheduled and platform-event flows, with their active state and API version. Deactivation remembers each flow's active version so reactivation restores exactly what was running.">⏻ Flow switches</button>
      <button class="btn-small" id="depApiVerBtn" title="Compare the API version every flow in this org is pinned to with the release the org runs, and change it: one package, behind a typed CHANGE. Comparing alone changes nothing.">⚙ API versions</button>
      <button class="btn-small" id="depExportBtn" title="Download this dependency report as Markdown + CSV">⬇ Export report</button>
      <button class="btn-small" id="depRescanBtn" title="Drop this org's stored dependency data and read the flow list and every flow version again — use after editing flows in Flow Builder while this tab stayed open. Costs one read per flow version.">↻ Rescan</button>
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
    toolsRow.querySelector('#depApiVerBtn').addEventListener('click', () =>
      toggleTool('apiver', m => { renderApiVerPanel(m, orgUrl); }));
    toolsRow.querySelector('#depBulkBtn').addEventListener('click', () =>
      toggleTool('bulk', m => { renderFlowBulkPanel(m, orgUrl); }));
    toolsRow.querySelector('#depExportBtn').addEventListener('click', () =>
      exportReport(orgUrl, exportStatus));
    toolsRow.querySelector('#depRescanBtn').addEventListener('click', (e) => {
      if (typeof window.sftkRescanDependencies !== 'function') return;
      e.currentTarget.disabled = true;
      e.currentTarget.textContent = '⏳ rescanning…';
      window.sftkRescanDependencies();
    });

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
      // A flow whose metadata was never read has UNKNOWN calls — the badge
      // says so, so its place in "Standalone" is never read as "calls nothing".
      const sc = depFlowScanState(flowsByApiName[flow.ApiName] || [], _scannedIds);
      const scanBadge = sc.state === 'scanned' ? ''
        : sc.state === 'partial'
          ? `<span class="badge badge-obsolete" title="${sc.scanned} of ${sc.total} version(s) of this flow were read by the dependency scan. The other version(s) may call subflows this map does not know about.">⏳ ${sc.scanned}/${sc.total} versions scanned</span>`
          : '<span class="badge badge-obsolete" title="The dependency scan has not read this flow\'s metadata, so what it calls — and what calls it — is UNKNOWN here, not none. Run or resume the scan from the Flows tab (🔗 Scan dependencies).">⏳ not scanned — calls unknown</span>';

      // Every row says which version it shows, its API version, status and
      // dates (user 2026-09-13) — the same facts the 🔒 rows already carry.
      node.innerHTML = `
        <span class="dep-node-toggle">${hasChildren ? '▼' : '&nbsp;&nbsp;'}</span>
        <span class="dep-node-icon">${icon}</span>
        <span class="dep-node-name" title="Open in Salesforce">${escHtml(flow.MasterLabel)}</span>
        <span class="badge dep-type-badge">${escHtml(humanProcessType(flow.ProcessType))}</span>
        ${flow.VersionNumber ? `<span class="badge dep-type-badge" title="The version this row shows — the Active one, or the newest when none is active. Other versions are listed in 🔗 chains.">v${escHtml(String(flow.VersionNumber))}</span>` : ''}
        ${flow.ApiVersion ? `<span class="badge dep-type-badge" title="Pinned to Salesforce API ${flow.ApiVersion} \u2014 the flow keeps this version's behaviour regardless of the org's release. Compare and change it in \u2699 API versions.">API ${flow.ApiVersion}</span>` : ''}
        <span class="badge ${statusClass}">${flow.Status}</span>
        ${depDatesHtml(flow.CreatedDate, flow.LastModifiedDate)}
        ${scanBadge}
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

      if (hasChildren && visited.has(flow.ApiName)) {
        // A loop: this flow is already an ancestor in THIS chain. Say it —
        // an expand arrow with nothing under it reads as "calls nothing".
        const loop = document.createElement('div');
        loop.className = 'dep-deep-warning';
        loop.style.paddingLeft = `${(depth + 1) * 20 + 8}px`;
        loop.textContent = '↻ calls back into a flow already shown higher in this chain — a loop; not expanded again.';
        childContainer.appendChild(loop);
      } else if (hasChildren) {
        visited.add(flow.ApiName);

        // The per-branch `visited` set already makes a loop impossible, so
        // depth is drawn as deep as the org goes (the old cap of 3 hid real
        // subflows — user fixture 2026-09-21: trigger → L1 → L2 → L3 → L4).
        // The bound only protects the page from a pathological tree.
        if (depth >= DEP_TREE_MAX_DEPTH) {
          const warn = document.createElement('div');
          warn.className = 'dep-deep-warning';
          warn.style.paddingLeft = `${(depth + 1) * 20 + 8}px`;
          warn.textContent = `⚠️ This chain goes deeper than ${DEP_TREE_MAX_DEPTH} levels — the rest is not drawn here. Right-click the flow above → 🔗 chains to follow it.`;
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
              const mrow = versions.length ? null : depManagedRow(childApiName);
              const missingNode = document.createElement('div');
              missingNode.className = mrow ? 'dep-node dep-managed-node' : 'dep-node dep-missing';
              missingNode.style.paddingLeft = `${(depth + 1) * 20 + 8}px`;
              if (mrow) missingNode.dataset.processType = mrow.processType || '';
              missingNode.innerHTML = mrow
                ? `<span class="dep-node-icon">🔒</span> <span class="dep-node-name">${escHtml(mrow.label || childApiName)}</span> <span class="badge dep-type-badge" title="Namespace of the installed package">${escHtml(String(childApiName).split('__')[0])}</span> <span class="badge ${mrow.active ? 'badge-active' : 'badge-obsolete'}">${mrow.active ? 'Active' : 'Inactive'}</span> <span style="font-size:10.5px;color:var(--subtext,#706E6B)">managed package flow — exists here; its contents and what it calls are hidden by Salesforce${mrow.active ? '' : ' · called as a subflow but not Active'}</span>`
                : versions.length
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
      const unscannedHere = standaloneFlows.filter(f => depFlowScanState(flowsByApiName[f.ApiName] || [], _scannedIds).state !== 'scanned').length;
      standalone.innerHTML = `<div class="dep-section-header dep-standalone-header" title="Flows for which the scan found no subflow calls in either direction. A flow that was NOT scanned lands here too — its calls are unknown, not absent.">🏝 Standalone Flows (${standaloneFlows.length})${unscannedHere
        ? ` <span style="font-weight:400;font-size:11px;color:var(--warning,#DD7A01)">— ${unscannedHere} of them not scanned: their calls are unknown, not none</span>` : ''}</div>`;
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

    // 🔒 Managed package flows — always present (even while reading) so their
    // absence from the list above is never mistaken for "this org has none".
    const managedHost = document.createElement('div');
    managedHost.className = 'dep-section dep-standalone';
    managedHost.id = 'depManagedSection';
    paintManagedSection(managedHost);
    treeContainer.appendChild(managedHost);

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
        // 🔒 managed nodes live outside allNodes (painted later, async) —
        // dim them by query, and remember the filter for a later repaint.
        _depActiveFilter = activeFilter;
        treeContainer.querySelectorAll('.dep-managed-node').forEach(node => {
          const pt = node.dataset.processType;
          node.classList.toggle('dep-dimmed', !(activeFilter === 'all' || pt === activeFilter));
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

  // ── N4d — subflow chains (transitive, cycle-safe) ─────────────────────
  // Annotate a depChain() node tree with what this org actually contains, so
  // the panel and the export can both say "not found" / "no Active version".
  function annotateChain(node) {
    if (!node) return node;
    const rep = repFlowFor(node.apiName);
    const mrow = rep ? null : depManagedRow(node.apiName);
    node.managed = !!mrow;
    node.exists = !!rep || !!mrow;
    node.selfActive = rep
      ? !!(flowsByApiName[node.apiName] || []).some(v => v.Status === 'Active')
      : !!(mrow && mrow.active);
    node.status = rep ? rep.Status : (mrow ? (mrow.active ? 'Active' : 'Inactive') : node.status);
    node.masterLabel = rep ? rep.MasterLabel : (mrow ? mrow.label : node.masterLabel);
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
    else if (node.managed) flags.push(`<span class="badge dep-type-badge" title="Managed package flow — exists here; its contents and what it calls are hidden by Salesforce">🔒 managed · ${node.selfActive ? 'Active' : 'Inactive'} · contents hidden</span>`);
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
    const versions = (flowsByApiName[flow.ApiName] || []).slice().sort((a, b) => (Number(b.VersionNumber) || 0) - (Number(a.VersionNumber) || 0));
    const sc = depFlowScanState(versions, _scannedIds);
    // Per version: was it read, and what did it call? This is the evidence
    // behind the verdict below — a user who KNOWS the flow has a subflow can
    // see whether the map read the version that carries it.
    const versionRows = versions.map(v => {
      const read = _scannedIds.has(v.Id);
      const calls = read ? depCallsOfVersion(dependencyMap, v.Id) : null;
      return `<div class="dep-blast-item" style="font-size:11px">v${escHtml(String(v.VersionNumber || '?'))} <span class="badge ${v.Status === 'Active' ? 'badge-active' : v.Status === 'Obsolete' ? 'badge-obsolete' : 'badge-draft'}">${escHtml(v.Status || '')}</span> — ${read
        ? (calls.length ? `calls ${calls.map(escHtml).join(', ')}` : 'no subflow calls in its metadata')
        : '<b style="color:var(--warning,#DD7A01)">NOT scanned — calls unknown</b>'}</div>`;
    }).join('');
    const downEmptyText = sc.state === 'scanned'
      ? 'Calls no subflows — none of this flow\'s scanned versions contain a subflow element.'
      : `<b style="color:var(--warning,#DD7A01)">Unknown — ${sc.state === 'partial' ? `${sc.unscanned} of ${sc.total} versions of this flow were not read` : 'this flow\'s metadata has not been read'} by the dependency scan. Run or resume the scan in the Flows tab (🔗 Scan dependencies) and open this panel again.</b>`;
    const upEmptyText = isMetadataFetched()
      ? 'No flow calls this one.'
      : `<b style="color:var(--warning,#DD7A01)">No SCANNED flow calls this one — but ${scanCaveat()}, so an unscanned flow still might.</b>`;
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
        ${emptyDown ? `<div class="dep-blast-item">${downEmptyText}</div>`
    : (down.root.children || []).map(c => chainNodeHtml(c, 0)).join('')}
      </div>
      <div class="dep-blast-sec">
        <div class="dep-blast-sec-hdr">⬆ Called by (upstream) — ${up.stats.nodes - 1} node(s), ${up.stats.cycles} cycle(s)</div>
        ${emptyUp ? `<div class="dep-blast-item">${upEmptyText}</div>`
    : (up.root.children || []).map(c => chainNodeHtml(c, 0)).join('')}
      </div>
      <div class="dep-blast-sec">
        <div class="dep-blast-sec-hdr">🧾 This flow's versions — what the scan actually read</div>
        ${versionRows || '<div class="dep-blast-item">No versions loaded for this flow.</div>'}
      </div>`;
    document.body.appendChild(panel);
    panel.querySelector('.dep-blast-close').addEventListener('click', () => panel.remove());
    panel.querySelectorAll('[data-flow-id]').forEach(el => el.addEventListener('click', () =>
      chrome.tabs.create({ url: `${orgUrl}/builder_platform_interaction/flowBuilder.app?flowId=${el.dataset.flowId}` })));
  }

  // ── N4d — dead subflow detection panel ────────────────────────────────
  // 🧟 Subflow health: retired 2026-08-30 (user: "not a useful
  // feature"). depDeadSubflows stays — the export report still uses it.

  // ── ⏻ FLOW SWITCHES — bulk activate/deactivate, CROSS-ORG ────────────
  // User 2026-08-30: "select and disable, activate flows in bulk, by
  // object … only triggered … also scheduled" + "done here — under the
  // feature cross org … Also the api version should be there". So this is
  // a cross-org matrix: rows = flows grouped by object, columns = orgs,
  // each cell showing on/off, the flow version that runs, and the API
  // version it is pinned to. Flips apply to the flows you tick, in the
  // orgs you tick.
  //
  // The dangerous half is the way BACK: Salesforce activates a VERSION,
  // and blindly activating the latest can run logic that was never live.
  // Deactivation stores each flow's active version PER ORG
  // (sftk_flow_prev_active) and reactivation restores exactly that,
  // disclosing per flow when it must fall back to latest.
  let _fbState = null;   // { orgs:[{key,label,orgUrl,sid}], rowsByOrg, matrix, remembered:{orgKey:{}} }
  let _fbBusy = false;

  async function _fbRememberedAll() {
    try {
      const d = await chrome.storage.local.get('sftk_flow_prev_active');
      return d.sftk_flow_prev_active || {};
    } catch (_) { return {}; }
  }
  async function _fbRememberSave(orgKey, mutate) {
    try {
      const d = await chrome.storage.local.get('sftk_flow_prev_active');
      const all = d.sftk_flow_prev_active || {};
      all[orgKey] = mutate(all[orgKey] || {});
      await chrome.storage.local.set({ sftk_flow_prev_active: all });
    } catch (_) { /* best-effort — the plan disclosed the fallback */ }
  }

  // THIS ORG ONLY (user 2026-09-14: cross-org pickers here were confusing).
  // The matrix code below still takes a list of orgs; the list is now always
  // the org this popup is connected to.
  function renderFlowBulkPanel(mount, orgUrl) {
    const all = [{ orgUrl, sid: _scanSid || _lastSid, label: `This org (${depHost(orgUrl)})`, isCurrent: true }];
    _fbOrgsAll = all;
    mount.innerHTML = `
      <div class="dep-panel" style="padding:8px 10px">
        <div style="font-weight:600;margin-bottom:2px">⏻ Flow switches — ${escHtml(depHost(orgUrl))}</div>
        <div style="font-size:11.5px;opacity:.8;margin-bottom:6px">
          Record-triggered, scheduled and platform-event flows in this org, by object, with their
          on/off state, running flow version and pinned <strong>API version</strong>.
          <strong>Off</strong> stops that flow's automation for everyone in this org until reactivated —
          records created meanwhile are never retroactively processed.
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <span id="depFbProg" style="font-size:11.5px;opacity:.8"></span>
        </div>
        <div id="depFbBody" style="margin-top:8px"></div>
      </div>`;
    // Loads on open (user 2026-09-14: "why do we need the button? … load both
    // on load") — one org, a few read-only calls, quoted in the progress line.
    loadFlowBulk(mount);
  }
  let _fbOrgsAll = [];

  async function loadFlowBulk(mount) {
    const picked = _fbOrgsAll.filter(Boolean);
    const body = mount.querySelector('#depFbBody');
    const prog = mount.querySelector('#depFbProg');
    if (!picked.length) { body.innerHTML = depErrBox('No org', 'Connect to an org first.'); return; }
    // No Silent Waits: three list reads per org plus one versions page per
    // 100 flows, said before spending them.
    prog.textContent = `${picked.length} org(s): 3 read-only calls each, plus one per 100 flows…`;
    const orgs = []; const rowsByOrg = {}; const apiVerByOrg = {}; const notes = [];
    for (const o of picked) {
      const key = depOrgKey(o.orgUrl);
      prog.textContent = `reading ${o.label}…`;
      const [view, defs, vers] = await Promise.all([
        depBg({ type: 'SF_QUERY', tooling: false, orgUrl: o.orgUrl, sid: o.sid, _silentError: true,
          query: 'SELECT ApiName, Label, NamespacePrefix, IsActive, TriggerType, TriggerObjectOrEventLabel FROM FlowDefinitionView' }),
        // PLAIN fields only — the ActiveVersion.VersionNumber traversal
        // failed live and painted every flow "not togglable"; the Flow
        // query below already knows every version number.
        depBg({ type: 'SF_QUERY', tooling: true, orgUrl: o.orgUrl, sid: o.sid, _silentError: true,
          query: 'SELECT Id, DeveloperName, NamespacePrefix FROM FlowDefinition' }),
        depFlowVersions(o.orgUrl, o.sid),
      ]);
      if (view?.error) {
        notes.push(`${o.label}: could not be read (${view.error}) — shown as UNREAD, never as "has no flows".`);
        continue;
      }
      orgs.push({ key, label: o.label, orgUrl: o.orgUrl, sid: o.sid,
        // Definitions unreadable ⇒ states still show, switching is off for
        // this org — ONE note here instead of a ⚠ on every row.
        toolingDown: !!defs?.error });
      if (defs?.error) {
        notes.push(`${o.label}: flow definitions could not be read (${defs.error}) — states are shown, but switching is disabled for this org.`);
      }
      // ONE source of truth for versions: the Flow query. Active + latest
      // numbers AND the governing API version both come from it.
      const versByApi = {};
      apiVerByOrg[key] = {};
      if (!vers?.error) {
        for (const fr of sftkFlowVerRows(vers.records || [])) {
          versByApi[fr.apiName] = {
            active: fr.active ? fr.active.versionNumber : null,
            latest: fr.latest ? fr.latest.versionNumber : null,
            activeId: fr.active ? fr.active.id : null,
            latestId: fr.latest ? fr.latest.id : null,
          };
          const gov = sftkFlowGoverningVer(fr);
          if (gov && gov.apiVersion) apiVerByOrg[key][fr.apiName] = String(gov.apiVersion);
        }
      } else {
        notes.push(`${o.label}: flow versions could not be read (${vers.error}) — version and API columns stay UNKNOWN here.`);
      }
      rowsByOrg[key] = sftkFlowBulkRows(view.records || [], defs?.error ? [] : (defs.records || []), versByApi);
    }
    prog.textContent = '';
    if (!orgs.length) { body.innerHTML = depErrBox('No org could be read', notes.join(' ')); return; }
    const matrix = sftkFlowBulkMatrix(orgs, rowsByOrg, apiVerByOrg);
    if (!matrix.length) { body.innerHTML = depErrBox('No triggered flows', 'These orgs have no record-triggered, scheduled or platform-event flows.'); return; }
    _fbState = { orgs, rowsByOrg, matrix, remembered: await _fbRememberedAll(), notes };
    renderFlowBulkMatrix(body);
  }

  function renderFlowBulkMatrix(body) {
    const st = _fbState;
    const groups = new Map();
    for (const r of st.matrix) {
      const key = /^Record/.test(r.triggerType) ? (r.object || '(unknown object)')
        : r.triggerType === 'Scheduled' ? '\u23f0 Scheduled'
        : '\u{1F4E1} Platform event';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const isRecordGroup = g => !/^[\u23f0\u{1F4E1}]/u.test(g);
    const cell = (r, o) => {
      const c = r.cells[o.key];
      if (!c || !c.present) return '<span class="dep-list-state"><span class="dep-pill dep-pill-absent" title="This flow does not exist in this org \u2014 absence, not off.">not in this org</span></span>';
      const rem = (st.remembered[o.key] || {})[r.apiName];
      const api = c.apiVersion ? `<span class="dep-pill dep-pill-api" title="Pinned to Salesforce API ${escHtml(c.apiVersion)}">API ${escHtml(c.apiVersion)}</span>` : '';
      const state = c.isActive
        ? `<span class="dep-pill dep-pill-on" title="Active${c.activeVersion ? ` \u2014 version ${c.activeVersion} is running` : ''}">ON${c.activeVersion ? ` v${c.activeVersion}` : ''}</span>`
        : `<span class="dep-pill dep-pill-off" title="No active version \u2014 this flow's automation is not running">OFF</span>${rem
            ? `<span class="dep-pill dep-pill-hint" title="Switched off here \u2014 \u25b6 Switch ON restores v${escHtml(String(rem))}">\u21a9 v${escHtml(String(rem))}</span>`
            : (c.defId ? `<span class="dep-pill dep-pill-hint" title="No record of which version was active before \u2014 activating here uses the LATEST version, which may differ from what previously ran.">\u2192latest</span>` : '')}`;
      const url = depFlowOpenUrl(o.orgUrl, c.activeId || c.latestId, c.defId);
      const pills = `${state}${api}`;
      return `<span class="dep-list-state">${url
        ? `<span class="dep-fb-open" data-open-url="${escHtml(url)}" title="Open this flow in Flow Builder">${pills}</span>`
        : pills}</span>`;
    };
    // A flow's state in THIS org (single-org panel): 'on' | 'off' | 'absent'.
    // Selection and the action buttons key on it (user 2026-09-14: ticking an
    // OFF flow for "Deactivate" was a silent no-op).
    const fbStateOf = f => {
      const c = st.orgs.length ? f.cells[st.orgs[0].key] : null;
      return !c || !c.present ? 'absent' : (c.isActive ? 'on' : 'off');
    };
    // The label opens the flow in the first org that has it — "This org"
    // first, since that is the org the map is looking at.
    const labelUrl = f => {
      for (const o of st.orgs) {
        const c = f.cells[o.key];
        if (c && c.present) {
          const u = depFlowOpenUrl(o.orgUrl, c.activeId || c.latestId, c.defId);
          if (u) return { url: u, org: o.label };
        }
      }
      return null;
    };
    const nOnAll = st.matrix.filter(f => fbStateOf(f) === 'on').length;
    const nOffAll = st.matrix.filter(f => fbStateOf(f) === 'off').length;
    body.innerHTML = `
      <div class="dep-tool-sum">
        <strong>${st.matrix.length}</strong> triggered flow(s)
        <span class="dep-pill dep-pill-on">${nOnAll} ON</span>
        <span class="dep-pill dep-pill-off">${nOffAll} OFF</span>
        ${st.orgs.map(o => `<label class="dep-tool-apply" hidden title="${o.toolingDown ? 'Switching disabled \u2014 this org\u2019s flow definitions could not be read.' : 'Apply the switch in this org'}">
          <input type="checkbox" class="dep-fb-applyorg" value="${escHtml(o.key)}" ${o.toolingDown ? 'disabled' : 'checked'}>${escHtml(o.label)}</label>`).join('')}
        ${st.orgs.some(o => o.toolingDown) ? '<span class="dep-pill dep-pill-warn" title="This org\u2019s flow definitions could not be read \u2014 switching is disabled.">\u26a0 switching disabled</span>' : ''}
      </div>
      <div class="dep-list">
        ${[...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([g, flows]) => `
          <div class="dep-list-grp">
            <div class="dep-list-grp-hd">
              <span class="dep-list-grp-name">${escHtml(g)}</span>
              <span class="dep-list-grp-n">${flows.length}</span>
              <span class="dep-list-grp-acts">
                <button class="btn-small dep-fb-grp" data-grp="${escHtml(g)}" data-want="on" title="Tick every flow in this group that is currently ON (what \u23fb Switch OFF acts on)">all ON</button>
                <button class="btn-small dep-fb-grp" data-grp="${escHtml(g)}" data-want="off" title="Tick every flow in this group that is currently OFF (what \u25b6 Switch ON acts on)">all OFF</button>
              </span>
            </div>
            ${flows.map(f => `
              <label class="dep-list-row">
                <input type="checkbox" class="dep-fb-cb" value="${escHtml(f.apiName)}" data-grp="${escHtml(g)}" data-on="${fbStateOf(f)}">
                <span class="dep-list-name">
                  ${(() => { const lu = labelUrl(f); return lu
                    ? `<span class="dep-fb-open" data-open-url="${escHtml(lu.url)}" title="${escHtml(f.apiName)} \u2014 open in Flow Builder">${escHtml(f.label)}</span>`
                    : `<span title="${escHtml(f.apiName)}">${escHtml(f.label)}</span>`; })()}
                  ${isRecordGroup(g) ? `<span class="dep-list-kind">${escHtml(f.kind)}</span>` : ''}
                </span>
                ${st.orgs.map(o => cell(f, o)).join('')}
              </label>`).join('')}
          </div>`).join('')}
      </div>
      ${st.notes.length ? `<div class="dep-tool-note">${st.notes.map(n => `\u2139 ${escHtml(n)}`).join('<br>')}</div>` : ''}
      <div class="dep-tool-foot">
        <span id="depFbCount" class="dep-tool-count">0 selected</span>
        <span class="dep-tool-sp"></span>
        <button class="btn-small" id="depFbOff" disabled>\u23fb Switch OFF (0 ON selected)</button>
        <button class="btn-small dep-btn-primary" id="depFbOn" disabled>\u25b6 Switch ON (0 OFF selected)</button>
      </div>
      <div id="depFbOut" class="dep-tool-out"></div>`;
    depWireOpenLinks(body);
    const cbs = [...body.querySelectorAll('.dep-fb-cb')];
    // The two buttons say exactly what they would switch: only ticked flows
    // that are ON can be switched OFF, and only ticked OFF flows switched ON.
    // A ticked flow in the other state is simply not part of that action.
    const sync = () => {
      const picked = cbs.filter(c => c.checked);
      const nOn = picked.filter(c => c.dataset.on === 'on').length;
      const nOff = picked.filter(c => c.dataset.on === 'off').length;
      const el = body.querySelector('#depFbCount');
      if (el) el.textContent = `${picked.length} selected \u00b7 ${nOn} ON \u00b7 ${nOff} OFF`;
      const off = body.querySelector('#depFbOff'), on = body.querySelector('#depFbOn');
      if (off) { off.disabled = !nOn; off.textContent = `\u23fb Switch OFF (${nOn} ON selected)`; }
      if (on)  { on.disabled = !nOff; on.textContent = `\u25b6 Switch ON (${nOff} OFF selected)`; }
    };
    cbs.forEach(c => c.addEventListener('change', sync));
    body.querySelectorAll('.dep-fb-grp').forEach(b => b.addEventListener('click', () => {
      const mine = cbs.filter(c => c.dataset.grp === b.dataset.grp && c.dataset.on === b.dataset.want);
      const allTicked = mine.length > 0 && mine.every(c => c.checked);
      mine.forEach(c => { c.checked = !allTicked; });
      sync();
    }));
    body.querySelector('#depFbOff').addEventListener('click', () => runFlowBulk(body, 'deactivate'));
    body.querySelector('#depFbOn').addEventListener('click', () => runFlowBulk(body, 'activate'));
    sync();
  }

  async function runFlowBulk(body, mode) {
    if (_fbBusy || !_fbState) return;
    const st = _fbState;
    // Only the ticked flows this action can switch (the buttons count the same set).
    const want = mode === 'deactivate' ? 'on' : 'off';
    const picked = [...body.querySelectorAll('.dep-fb-cb')].filter(c => c.checked && c.dataset.on === want).map(c => c.value);
    const applyOrgs = [...body.querySelectorAll('.dep-fb-applyorg')].filter(c => c.checked).map(c => c.value);
    const out = body.querySelector('#depFbOut');
    if (!picked.length) { out.innerHTML = depErrBox('Nothing selected', 'Tick the flows to switch first.'); return; }
    if (!applyOrgs.length) { out.innerHTML = depErrBox('No org ticked', 'Tick, in the table header, the org(s) to apply the switch in.'); return; }

    // One plan PER ORG — each org has its own current state and its own
    // remembered versions, and the confirm shows them separately so a flip
    // in UAT is never mistaken for a flip in prod.
    const perOrg = [];
    for (const key of applyOrgs) {
      const org = st.orgs.find(o => o.key === key);
      if (!org) continue;
      const plan = sftkFlowBulkPlan(st.rowsByOrg[key] || [], picked, mode, st.remembered[key] || {});
      perOrg.push({ org, plan });
    }
    const totalJobs = perOrg.reduce((n, x) => n + x.plan.jobs.length, 0);
    if (!totalJobs) {
      out.innerHTML = depErrBox('Nothing to change',
        perOrg.flatMap(x => x.plan.skipped.map(k => `${x.org.label}: ${k.apiName} (${k.why})`)).join(' · ') || 'No eligible flow in the selection.');
      return;
    }
    // Typed confirmation, IN the panel — the same gate as ⚙ API versions'
    // CHANGE. A one-click OK on a browser confirm() was all that stood
    // between the user and stopping production automation (audit 2026-09-12).
    const orgN = perOrg.filter(x => x.plan.jobs.length).length;
    const word = mode === 'deactivate' ? 'OFF' : 'ON';
    const skips = perOrg.flatMap(x => x.plan.skipped.map(k => `${x.org.label}: ${k.apiName} (${k.why})`));
    out.innerHTML = `
      <div class="dep-blast-sec" style="border-left:3px solid var(--warn,#d97706);padding-left:8px">
        <div style="font-weight:700">Switch ${word} ${totalJobs} flow(s) in ${orgN === 1 ? 'this org' : `${orgN} org(s)`}?</div>
        <div style="margin-top:4px;font-size:12px">${mode === 'deactivate'
          ? 'Their automation <strong>stops for EVERYONE</strong> in this org until switched back on. Records created while off are never retroactively processed. Active versions are remembered, so \u25b6 Activate restores exactly them.'
          : 'Each flow is switched on at the version listed below, in every ticked org.'}</div>
        <div style="margin-top:6px;max-height:170px;overflow:auto;font-size:11.5px">
          ${perOrg.filter(x => x.plan.jobs.length).map(x => `
            <div style="margin:2px 0"><strong>${escHtml(x.org.label)}</strong>: ${x.plan.jobs.map(j => `${escHtml(j.label)} — ${escHtml(j.from)}`).join(' · ')}</div>`).join('')}
        </div>
        ${skips.length ? `<div style="margin-top:4px;font-size:11.5px;opacity:.8">Skipped: ${escHtml(skips.join(', '))}</div>` : ''}
        <div style="margin-top:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <span style="font-size:12px">Type <code>${word}</code> to confirm:</span>
          <input id="depFbConfirm" style="width:90px;padding:2px 4px" autocomplete="off">
          <button class="btn-small" id="depFbGo" disabled>\u23fb Switch ${word}</button>
          <button class="btn-small" id="depFbNo">Cancel</button>
        </div>
      </div>`;
    const inp = out.querySelector('#depFbConfirm');
    const go = out.querySelector('#depFbGo');
    inp.addEventListener('input', () => { go.disabled = inp.value.trim().toUpperCase() !== word; });
    out.querySelector('#depFbNo').addEventListener('click', () => { out.innerHTML = ''; });
    go.addEventListener('click', () => applyFlowBulk(out, mode, perOrg));
  }

  // The switch itself, org at a time — only ever reached through the typed
  // gate above.
  async function applyFlowBulk(out, mode, perOrg) {
    if (_fbBusy) return;
    _fbBusy = true;
    const report = [];
    for (const { org, plan } of perOrg) {
      // The one write discipline (sftk-write.js): every switch is a write +
      // a re-read, the re-read done ONCE for the whole batch (one
      // FlowDefinitionView query). A flow is "done" only when the org shows
      // it in the wanted state; anything else is named in `failed` and is
      // never remembered (live 2026-09-22 — the PATCH's answer used to be
      // reported as the switch).
      const wantOn = mode !== 'deactivate';
      let i = 0;
      const batch = await sftkWriteVerifiedAll(plan.jobs.map(j => ({
        describe: j.label,
        write: async () => {
          out.innerHTML = depSpin(`${org.label}: ${mode === 'deactivate' ? 'switching off' : 'switching on'} ${++i} / ${plan.jobs.length}…`);
          return depBg({ type: 'SF_PATCH', orgUrl: org.orgUrl, sid: org.sid, _silentError: true,
            path: `services/data/v62.0/tooling/sobjects/FlowDefinition/${j.defId}`,
            body: { Metadata: { activeVersionNumber: j.version } } });
        },
      })), {
        verifyAll: async results => {
          const names = plan.jobs.filter((j, k) => results[k] && results[k].accepted).map(j => j.apiName);
          if (!names.length) return [];
          const q = await depBg({ type: 'SF_QUERY', tooling: false, orgUrl: org.orgUrl, sid: org.sid, _silentError: true,
            query: `SELECT ApiName, ActiveVersionId, IsActive FROM FlowDefinitionView WHERE ApiName IN (${names.map(n => `'${String(n).replace(/'/g, "\\'")}'`).join(',')})` });
          if (!q || q.error) throw new Error((q && q.error) || 'no answer');
          const nowActive = new Map((q.records || []).map(r => [r.ApiName, !!r.ActiveVersionId]));
          return plan.jobs.map(j => {
            const isOn = nowActive.get(j.apiName);
            return { ok: isOn === wantOn, text: isOn === wantOn ? `${j.label}: switched ${wantOn ? 'ON' : 'OFF'} — verified by re-reading the org`
              : `${j.label}: the switch was accepted but the org still reads it ${isOn === undefined ? 'unknown (not listed)' : (isOn ? 'ON' : 'OFF')} — nothing to rely on here, check it in Setup` };
          });
        },
      });
      const done = plan.jobs.filter((j, k) => batch.results[k] && batch.results[k].ok);
      const failed = batch.results.filter(r => !r.ok).map(r => r.text);
      // Remember / forget only what THIS org confirmed — a failed flip must
      // not overwrite the memory of what was truly active.
      if (mode === 'deactivate' && Object.keys(plan.remember).length) {
        const okNames = new Set(done.map(j => j.apiName));
        await _fbRememberSave(org.key, m => {
          for (const [name, v] of Object.entries(plan.remember)) if (okNames.has(name)) m[name] = v;
          return m;
        });
      }
      if (mode === 'activate' && done.length) {
        await _fbRememberSave(org.key, m => { for (const j of done) delete m[j.apiName]; return m; });
      }
      if (done.length || failed.length) {
        report.push(`${done.length ? `✅ ${org.label}: ${done.length} switched ${mode === 'deactivate' ? 'OFF' : 'ON'} — verified by re-reading the org (${escHtml(done.map(j => j.label).join(', '))})` : ''}${failed.length ? `${done.length ? '<br>' : ''}❌ ${org.label}: ${escHtml(failed.join(' · '))}` : ''}`);
      }
    }
    _fbBusy = false;
    out.innerHTML = `
      <div class="dep-blast-sec"${report.some(r => r.includes('❌')) ? ' style="border-left:3px solid var(--warn,#d97706);padding-left:8px"' : ''}>
        ${report.join('<br>')}<br>
        <span style="opacity:.75">This table is now stale —</span>
        <button class="btn-small" id="depFbReload">↻ Reload the fresh state</button>
      </div>`;
    out.querySelector('#depFbReload')?.addEventListener('click', () => {
      const mount = out.closest('#depToolPanel');
      if (mount) loadFlowBulk(mount);
    });
  }

  // ── API VERSIONS, ACROSS ORGS ─────────────────────────────────────────
  // User 2026-08-22: "compare api versions and change them of flows and
  // their trees multi org" + "It should also compare the orgs api versions
  // ofc. aand be updated when a new version is out".
  //
  // Two versions live here and they are NOT the same thing. The ORG's
  // version is the release it runs — a ceiling. A FLOW's version is the
  // semantics it is pinned to, and an old flow keeps its old behaviour in
  // a fully upgraded org. Both are shown, side by side, because the whole
  // point is that one does not imply the other.
  //
  // Nothing is hard-coded: every version and every release NAME is read
  // from the org itself (GET /services/data/ ships both), so the day an
  // org upgrades this reports the new release with no code change.
  let _avState = null;   // { orgs, matrix, edges, generatedAt }
  let _avRunning = false;
  let _avCancel = false;

  // THIS ORG ONLY (user 2026-09-14). The compare/apply code below still takes
  // a list of orgs; it is now always the org this popup is connected to.
  function renderApiVerPanel(mount, orgUrl) {
    const all = [{ orgUrl, sid: _scanSid || _lastSid, label: `This org (${depHost(orgUrl)})`, online: true, isCurrent: true }];
    mount.innerHTML = `
      <div class="dep-panel" style="padding:8px 10px">
        <div style="font-weight:600;margin-bottom:4px">⚙ API versions — ${escHtml(depHost(orgUrl))}</div>
        <div style="font-size:11.5px;opacity:.8;margin-bottom:6px">
          Compares the version each flow is <strong>pinned to</strong> with the release this org runs. A flow keeps its own version until someone changes it, so an upgraded org can still be running years-old flow behaviour. Comparing changes nothing; ⚙ Apply, below the comparison, deploys a new flow version behind a typed <code>CHANGE</code>.
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <span id="depAvProg" style="font-size:11.5px;opacity:.8"></span>
        </div>
        <div id="depAvOut" style="margin-top:8px"></div>
      </div>`;
    _avOrgsAll = all;
    // Compares on open (user 2026-09-14) — one org, two list reads plus one
    // per 100 flows, quoted in the progress line; nothing is written.
    runApiVerCompare(mount);
  }

  let _avOrgsAll = [];

  // The Flow Builder URL for a flow in a given org. A version id opens
  // that exact version; a definition id opens the flow's latest; neither
  // → no link (never a guess at a URL that would land on an error page).
  function depFlowOpenUrl(orgUrl, versionId, defId) {
    const base = String(orgUrl || '').replace(/\/$/, '');
    if (!base) return '';
    if (versionId) return `${base}/builder_platform_interaction/flowBuilder.app?flowId=${encodeURIComponent(versionId)}`;
    if (defId) return `${base}/builder_platform_interaction/flowBuilder.app?flowDefId=${encodeURIComponent(defId)}`;
    return '';
  }
  // Wires every [data-open-url] inside a container to open in a new tab —
  // the popup's own convention (chrome.tabs.create), not target=_blank.
  function depWireOpenLinks(container) {
    container.querySelectorAll('[data-open-url]').forEach(el => {
      el.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        const url = el.dataset.openUrl;
        if (url) chrome.tabs.create({ url });
      });
    });
  }

  // Flow versions via the MODERN stack (user rule 2026-08-31 + the managed
  // flow that never appeared, 2026-09-01): REST FlowVersionView includes
  // MANAGED flows the Tooling Flow object omits, and carries ApiVersion,
  // status and the namespaced ApiName. Rows are mapped to the shape
  // sftkFlowVerRows already understands. Falls back to the Tooling query
  // (with a note) so an org that predates the view still answers.
  // LIVE FACTS (sf CLI, 2026-09-03): FlowVersionView REFUSES an unfiltered
  // query ("a filter on a reified column is required [FlowDefinitionViewId,
  // DurableId]"), so the one-shot read below used to fail silently and fall
  // back to Tooling — which returns ZERO managed flows (user: "I still dont
  // see the managed flows"). The read is therefore two steps: every
  // definition from FlowDefinitionView (no filter needed), then its versions
  // from FlowVersionView filtered by FlowDefinitionViewId, 100 definitions a
  // page. A managed definition's DurableId is 'ns__Name' and its versions'
  // DurableIds are 'ns__Name-N' — not record Ids — so those rows carry no Id
  // and never become a Flow Builder link that would 404.
  // apiName → FlowDefinitionView.TriggerType for EVERY definition the org
  // lists (managed or not) — the cheap, scan-independent source of "is this
  // record-triggered". Filled by depFlowVersions on every load.
  let _defTriggerByApiName = {};
  function getDefinitionTriggerMap() { return _defTriggerByApiName; }

  async function depFlowVersions(orgUrl, sid) {
    const defs = await depBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl, sid, _silentError: true,
      query: 'SELECT DurableId, ApiName, Label, NamespacePrefix, ManageableState, TriggerType, TriggerObjectOrEventLabel FROM FlowDefinitionView' });
    if (defs && !defs.error) {
      const isId = v => /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(String(v || ''));
      const defRows = (defs.records || []).filter(d => d && d.DurableId);
      const trigByDef = {};
      const trigByApi = {};
      for (const d of defRows) {
        const api = d.ApiName ? (d.NamespacePrefix ? `${d.NamespacePrefix}__${d.ApiName}` : d.ApiName) : null;
        trigByDef[d.DurableId] = d.TriggerType || null;
        if (api) trigByApi[api] = d.TriggerType || null;
      }
      _defTriggerByApiName = trigByApi;
      const out = [];
      let failed = null;
      for (let i = 0; i < defRows.length && !failed; i += 100) {
        const chunk = defRows.slice(i, i + 100);
        const inList = chunk.map(d => `'${String(d.DurableId).replace(/'/g, '')}'`).join(',');
        const vers = await depBg({ type: 'SF_QUERY_ALL', tooling: false, orgUrl, sid, _silentError: true,
          query: 'SELECT DurableId, FlowDefinitionViewId, ApiVersion, VersionNumber, Status, ProcessType, LastModifiedDate,'
            + ' FlowDefinitionView.ApiName, FlowDefinitionView.Label, FlowDefinitionView.NamespacePrefix, FlowDefinitionView.ManageableState'
            + ` FROM FlowVersionView WHERE FlowDefinitionViewId IN (${inList})` });
        if (!vers || vers.error) { failed = (vers && vers.error) || 'no response'; break; }
        for (const v of (vers.records || [])) {
          const d = v.FlowDefinitionView || {};
          const ns = d.NamespacePrefix || null;
          const api = d.ApiName ? (ns ? `${ns}__${d.ApiName}` : d.ApiName) : null;
          out.push({
            Id: isId(v.DurableId) ? v.DurableId : null,
            DefinitionId: isId(v.FlowDefinitionViewId) ? v.FlowDefinitionViewId : null,
            MasterLabel: d.Label || api,
            Definition: { DeveloperName: api },
            NamespacePrefix: ns,
            ManageableState: d.ManageableState || null,
            VersionNumber: v.VersionNumber, Status: v.Status,
            ApiVersion: v.ApiVersion,
            ProcessType: depResolveFlowType(v.ProcessType, trigByDef[v.FlowDefinitionViewId]),
            TriggerType: trigByDef[v.FlowDefinitionViewId] || null,
            LastModifiedDate: v.LastModifiedDate || null,
          });
        }
      }
      if (!failed) return { records: out };
      // fall through to Tooling — with the note, never silently
    }
    const tool = await depBg({ type: 'SF_QUERY', tooling: true, orgUrl, sid, _silentError: true,
      query: 'SELECT Id,MasterLabel,Definition.DeveloperName,VersionNumber,Status,ApiVersion,ProcessType FROM Flow' });
    if (tool?.error) return { error: tool.error };
    return { records: tool.records || [],
      note: 'read via the older Tooling API \u2014 managed-package flows may be missing from this org\u2019s list' };
  }

  // Read one org's ceiling from the org. No version string is assumed.
  async function avOrgMax(o) {
    const r = await depBg({ type: 'SF_REST_GET', orgUrl: o.orgUrl, sid: o.sid, _silentError: true,
      path: 'services/data/' });
    if (!r || r.error) return { error: String((r && r.error) || 'no response') };
    const max = sftkApiVerMax(r);
    return max || { error: 'the org listed no API versions' };
  }

  async function avFlows(o) {
    const r = await depFlowVersions(o.orgUrl, o.sid);
    if (!r || r.error) return { error: String((r && r.error) || 'no response') };
    return { rows: sftkFlowVerRows(r.records || []), note: r.note || null };
  }

  async function runApiVerCompare(mount) {
    if (_avRunning) { _avCancel = true; return; }
    const picked = _avOrgsAll.filter(Boolean);   // this org only
    const out = mount.querySelector('#depAvOut');
    const prog = mount.querySelector('#depAvProg');
    const btn = mount.querySelector('#depAvGo');
    if (!picked.length) { out.innerHTML = depErrBox('No org', 'Connect to an org first.'); return; }

    // No Silent Waits: two list reads per org plus one versions page per 100
    // flows, quoted before spending them.
    prog.textContent = `${picked.length} org(s): 2 read-only calls each, plus one per 100 flows…`;
    _avRunning = true; _avCancel = false;
    if (btn) btn.textContent = '⏹ Stop';
    const orgs = []; const rowsByOrg = {}; const notes = [];
    try {
      for (const o of picked) {
        if (_avCancel) break;
        const key = depOrgKey(o.orgUrl);
        prog.textContent = `reading ${o.label}…`;
        const max = await avOrgMax(o);
        if (max.error) notes.push(`${o.label}: could not read the org's release (${max.error}) — its lag column stays UNKNOWN.`);
        const f = await avFlows(o);
        if (f.error) { notes.push(`${o.label}: flows could not be read (${f.error}) — this org is shown as UNREAD, never as "has no flows".`); continue; }
        if (f.note) notes.push(`${o.label}: ${f.note}.`);
        orgs.push({ key, label: o.label, orgUrl: o.orgUrl, sid: o.sid,
          maxVersion: max.error ? null : max.version, release: max.error ? '' : max.label });
        rowsByOrg[key] = f.rows;
      }
      // Single-org (2026-09-14): one readable org is the whole comparison —
      // each flow's pinned version against this org's release.
      if (!orgs.length) {
        out.innerHTML = depErrBox('This org could not be read', notes.join(' ') || 'Open the org in a Chrome tab and try again.');
        return;
      }
      // parent → children, inverted from the map's child → parents shape,
      // so a tree can be rolled up from any root.
      const edges = {};
      for (const [child, parents] of Object.entries(dependencyMap || {})) {
        for (const p of (parents || [])) {
          const pn = p && (p.apiName || p.masterLabel);
          if (!pn) continue;
          (edges[pn] = edges[pn] || []).push(child);
        }
      }
      _avState = { orgs, matrix: sftkFlowVerMatrix(orgs, rowsByOrg), edges,
        rowsByOrg, notes, generatedAt: new Date().toISOString() };
      renderApiVerResult(out);
    } catch (e) {
      out.innerHTML = depErrBox('API version comparison failed', (e && e.message) || e);
    } finally {
      _avRunning = false;
      if (btn) btn.textContent = '🔍 Compare';
      prog.textContent = _avCancel ? 'stopped — partial result' : '';
    }
  }

  function renderApiVerResult(out) {
    const st = _avState;
    if (!st) return;
    const { orgs, matrix } = st;
    const drift = matrix.filter(r => r.drift);
    const verOfOrg = k => {
      const o = orgs.find(x => x.key === k);
      return o ? o.maxVersion : null;
    };
    // Org header row: the RELEASE each org runs, read from the org.
    const orgHdr = orgs.map(o => `
      <th style="text-align:left;padding:4px 8px;font-size:11.5px">
        ${escHtml(o.label)}<br>
        <span style="font-weight:400;opacity:.75">${o.maxVersion
          ? `API ${escHtml(o.maxVersion)}${o.release ? ` · ${escHtml(o.release)}` : ''}`
          : '<span title="the org did not answer with its version list">release UNKNOWN</span>'}</span>
      </th>`).join('');
    const orgVers = new Set(orgs.map(o => o.maxVersion).filter(Boolean));

    const cell = (r, o) => {
      const c = r.cells[o.key];
      if (!c || c.missing) return '<span class="dep-list-state"><span class="dep-pill dep-pill-absent" title="This flow does not exist in this org. That is absence, not version drift.">not in this org</span></span>';
      if (!c.apiVersion) return '<span class="dep-list-state"><span class="dep-pill dep-pill-warn" title="The flow exists but did not report an API version \u2014 UNKNOWN, never assumed current.">? unknown</span></span>';
      const lag = c.lag;
      const cls = lag === 0 ? 'dep-pill-ok' : (lag != null && lag >= 6) ? 'dep-pill-bad' : (lag != null && lag > 0) ? 'dep-pill-warn' : 'dep-pill-off';
      const managedChip = c.managed ? '<span class="dep-pill dep-pill-hint" title="Managed package flow \u2014 its API version ships with the package and cannot be changed here.">\ud83d\udd12 managed</span>' : '';
      const tip = `${c.status || 'no status'} v${c.versionNumber} \u00b7 API ${c.apiVersion}`
        + (lag == null ? ' \u00b7 lag UNKNOWN (this org\u2019s release could not be read)'
          : lag === 0 ? ' \u00b7 current for this org'
          : ` \u00b7 ${lag} release(s) behind this org (\u2248${(lag / 3).toFixed(1)} year(s))`);
      const openUrl = depFlowOpenUrl(o.orgUrl, c.id, null);
      const val = `API ${escHtml(c.apiVersion)}${lag ? ` \u00b7 ${lag} behind` : lag === 0 ? ' \u00b7 current' : ''}`;
      const pill = `<span class="dep-pill ${cls}" title="${escHtml(tip)}${openUrl ? ' \u2014 click to open in Flow Builder' : ''}">${val}</span>`;
      return `<span class="dep-list-state">${openUrl
        ? `<span data-open-url="${escHtml(openUrl)}">${pill}</span>`
        : pill}${managedChip}</span>`;
    };
    const avLabelUrl = r => {
      for (const o of orgs) {
        const c = r.cells[o.key];
        if (c && !c.missing && c.id) return { url: depFlowOpenUrl(o.orgUrl, c.id, null), org: o.label };
      }
      return null;
    };

    // Single-org: what matters is how far each flow sits behind THIS org's
    // release, not drift between orgs. `behind` drives the summary, the sort
    // and the "select" button; `drift` stays for the (now rare) multi-org case.
    const lagOf = r => Math.max(0, ...orgs.map(o => { const c = r.cells[o.key]; return (c && !c.missing && c.lag != null) ? c.lag : 0; }));
    const behind = matrix.filter(r => lagOf(r) > 0 || r.drift);
    const o0 = orgs[0];
    // Which rows can be changed from here at all (user 2026-09-21: "the user
    // must not be able to select flows that api version can't be modified").
    const canOf = r => { for (const o of orgs) { const s = sftkApiVerSelectable(r.cells[o.key]); if (s.ok) return s; } return sftkApiVerSelectable(r.cells[(orgs[0] || {}).key]); };
    const fixable = behind.filter(r => canOf(r).ok);
    const lockedBehind = behind.length - fixable.length;
    out.innerHTML = `
      <div class="dep-tool-sum">
        ${o0 ? `<span class="dep-pill dep-pill-api" title="The release this org runs, read from the org">${o0.maxVersion ? `runs API ${escHtml(o0.maxVersion)}${o0.release ? ` \u00b7 ${escHtml(o0.release)}` : ''}` : 'release UNKNOWN'}</span>` : ''}
        <strong>${matrix.length}</strong> flow(s)
        <span class="dep-pill ${behind.length ? 'dep-pill-warn' : 'dep-pill-ok'}">${behind.length} behind the org release</span>
        <span class="dep-pill dep-pill-ok">${matrix.length - behind.length} current</span>
        ${lockedBehind ? `<span class="dep-pill dep-pill-hint" title="Behind, but not yours to change: installed from a managed package, an invalid draft, or without a record id. They cannot be ticked.">\ud83d\udd12 ${lockedBehind} of those cannot be changed here</span>` : ''}
      </div>
      ${fixable.length && o0 && o0.maxVersion ? `<div class="dep-tool-suggest">
        <div><strong>${fixable.length} of your flows run on an older API version than this org (API ${escHtml(o0.maxVersion)}).</strong>
          <span class="dep-tool-count">Salesforce runs each flow with the behaviour of the version it was saved at, so old flows miss fixes and can behave differently from new ones. Updating saves a NEW version of each flow (and activates it where the flow is active) \u2014 try it in a sandbox first, and test the flows that matter.</span></div>
        <button class="btn-small dep-btn-primary" id="depAvUpdateAll" title="Ticks the ${fixable.length} flow(s) that are behind AND can be changed, sets the target to API ${escHtml(o0.maxVersion)}, and opens the confirmation. Nothing is written until you confirm there.">\u2699 Update all ${fixable.length} to API ${escHtml(o0.maxVersion)}\u2026</button>
      </div>` : ''}
      <div class="dep-list">
        ${[...matrix].sort((a, b) =>
            (lagOf(b) - lagOf(a))
            || (b.drift - a.drift)
            || (a.label || a.apiName).localeCompare(b.label || b.apiName)).map(r => {
          const roll = sftkFlowTreeRoll(r.apiName, st.edges, n => {
            const row = r.apiName === n ? r : matrix.find(x => x.apiName === n);
            if (!row) return null;
            const first = orgs.map(o => row.cells[o.key]).find(c => c && c.num != null);
            return first ? first.num : null;
          });
          const treeTip = roll.members <= 1
            ? 'This flow calls no subflows.'
            : `${roll.members} flow(s) in this tree; oldest API ${roll.oldest == null ? 'UNKNOWN' : roll.oldest}`
              + (roll.unknown ? ` \u00b7 ${roll.unknown} could not be read` : '');
          const isBehind = lagOf(r) > 0 || r.drift;
          const can = canOf(r);
          return `<label class="dep-list-row ${isBehind ? 'dep-list-row-drift' : ''}${can.ok ? '' : ' dep-list-row-locked'}"${can.ok ? '' : ` title="Cannot be changed here: ${escHtml(can.why)}"`}>
            <input type="checkbox" class="dep-av-pick" value="${escHtml(r.apiName)}" ${can.ok ? '' : 'disabled'}>
            <span class="dep-list-name">
              ${(() => { const lu = avLabelUrl(r); return lu
                ? `<span data-open-url="${escHtml(lu.url)}" title="Open in Flow Builder">${escHtml(r.label || r.apiName)}</span>`
                : escHtml(r.label || r.apiName); })()}
              <span class="dep-list-api">${escHtml(r.apiName)}</span>
              ${roll.members > 1 ? `<span class="dep-pill dep-pill-hint" title="${escHtml(treeTip)}">tree ${roll.members} \u00b7 oldest ${roll.oldest == null ? '?' : roll.oldest}</span>` : ''}
            </span>
            ${orgs.map(o => cell(r, o)).join('')}
          </label>`;
        }).join('')}
      </div>
      ${st.notes.length ? `<div class="dep-tool-note">${st.notes.map(n => `\u2139 ${escHtml(n)}`).join('<br>')}</div>` : ''}
      <div class="dep-tool-note">A version shown here is the <strong>governing</strong> one \u2014 the ACTIVE version where there is one, otherwise the latest. Upgrading a draft while an older version is active changes nothing at runtime.</div>
      <div class="dep-tool-foot">
        <button class="btn-small" id="depAvSelDrift" ${fixable.length ? '' : 'disabled'}>${fixable.length ? `\u2713 Select the ${fixable.length} behind` : (behind.length ? 'none of the flows behind can be changed here' : 'nothing behind')}</button>
        <button class="btn-small" id="depAvSelNone">\u2717 None</button>
        <span class="dep-tool-sp"></span>
        <span class="dep-tool-count">Set API version to</span>
        <select id="depAvTarget" class="btn-small">
          ${[...new Set(orgs.map(o => o.maxVersion).filter(Boolean))]
            .sort((a, b) => sftkApiVerNum(b) - sftkApiVerNum(a))
            .map(v => `<option value="${escHtml(v)}">${escHtml(v)} (this org's release)</option>`).join('')}
          ${[...new Set(matrix.flatMap(r => r.versions))].sort().reverse()
            .map(v => `<option value="${escHtml(v)}">${escHtml(v)}</option>`).join('')}
        </select>
        <button class="btn-small dep-btn-primary" id="depAvApply">\u2699 Change\u2026</button>
        <span id="depAvApplyProg" class="dep-tool-count"></span>
      </div>
      <div id="depAvApplyOut" class="dep-tool-out"></div>`;

    depWireOpenLinks(out);
    const tickFixable = () => out.querySelectorAll('.dep-av-pick').forEach(cb => {
      cb.checked = !cb.disabled && fixable.some(d => d.apiName === cb.value);
    });
    out.querySelector('#depAvSelDrift')?.addEventListener('click', tickFixable);
    // The suggestion is a SHORTCUT to the same confirmation, never past it.
    out.querySelector('#depAvUpdateAll')?.addEventListener('click', () => {
      tickFixable();
      const sel = out.querySelector('#depAvTarget');
      if (sel && o0 && o0.maxVersion) sel.value = o0.maxVersion;
      confirmApiVerChange(out);
      out.querySelector('#depAvApplyOut')?.scrollIntoView({ block: 'nearest' });
    });
    out.querySelector('#depAvSelNone')?.addEventListener('click', () => {
      out.querySelectorAll('.dep-av-pick').forEach(cb => { cb.checked = false; });
    });
    out.querySelector('#depAvApply')?.addEventListener('click', () => confirmApiVerChange(out));
  }

  // Applying a version change WRITES to every org it touches, and it is not
  // a cosmetic edit: Salesforce's own docs are explicit that flow behaviour
  // can differ between API versions. A deploy also creates a NEW flow
  // version and, for an active flow, activates it — the previous version
  // becomes Obsolete. Everything in that sentence is stated before anything
  // is written, per org, with the exact from→to per flow.
  function confirmApiVerChange(out) {
    const st = _avState;
    if (!st) return;
    const target = out.querySelector('#depAvTarget')?.value || '';
    const picked = [...out.querySelectorAll('.dep-av-pick')].filter(cb => cb.checked && !cb.disabled).map(cb => cb.value);
    const box = out.querySelector('#depAvApplyOut');
    if (!picked.length) { box.innerHTML = depErrBox('Nothing selected', 'Tick the flows to change first.'); return; }

    // Plan EVERY (flow, org) pair before showing a single number.
    const plans = [];
    for (const name of picked) {
      const row = st.matrix.find(r => r.apiName === name);
      if (!row) continue;
      plans.push({ apiName: name, label: row.label || name, plan: sftkApiVerPlan(target, st.orgs, row.cells) });
    }
    const writes = plans.reduce((n, p) => n + p.plan.applicable.length, 0);
    const noops = plans.reduce((n, p) => n + p.plan.noop.length, 0);
    const blocked = plans.flatMap(p => p.plan.blocked.map(b => ({ ...b, apiName: p.apiName })));
    const orgLbl = k => (st.orgs.find(o => o.key === k) || {}).label || k;

    if (!writes) {
      box.innerHTML = depErrBox('Nothing to change',
        `Every selected flow is already at ${target} in every org that can hold it`
        + (blocked.length ? `, and ${blocked.length} (flow, org) pair(s) cannot take it.` : '.'));
      return;
    }

    box.innerHTML = `
      <div class="dep-blast-sec" style="border-left:3px solid var(--warn,#d97706);padding-left:8px">
        <div style="font-weight:700">Change ${writes} flow version(s) to API ${escHtml(target)}?</div>
        <div style="margin-top:4px;font-size:12px">
          This <strong>writes to ${new Set(plans.flatMap(p => p.plan.applicable.map(a => a.orgKey))).size} org(s)</strong>. Each change deploys a <strong>new version</strong> of the flow. Where the flow is Active, the tool then <strong>activates the new version</strong> and re-reads the org to confirm what is running (the previous one becomes Obsolete once the new one is active) — if the activation is refused, the previous version stays active and the result says so. Salesforce documents that <strong>flow behaviour can differ between API versions</strong> — this is a functional change, not a label.
        </div>
        <div style="margin-top:4px;font-size:11.5px;opacity:.85">
          Each org is deployed as <strong>one package</strong>, all-or-nothing: if any flow in an org is rejected, none of that org's flows change. Other orgs are unaffected either way.
        </div>
        <div style="margin-top:6px;max-height:170px;overflow:auto;font-size:11.5px">
          ${plans.filter(p => p.plan.applicable.length).map(p => `
            <div style="margin:2px 0"><code>${escHtml(p.apiName)}</code> — ${p.plan.applicable
              .map(a => `${escHtml(orgLbl(a.orgKey))} ${escHtml(a.from || '?')}→${escHtml(a.to)}${a.status === 'Active' ? ' <strong>(active)</strong>' : ` (${escHtml(a.status || 'draft')})`}`)
              .join(' · ')}</div>`).join('')}
        </div>
        ${noops ? `<div style="margin-top:4px;font-size:11.5px;opacity:.8">ℹ ${noops} (flow, org) pair(s) are already at ${escHtml(target)} — skipped, not rewritten.</div>` : ''}
        ${blocked.length ? `<div style="margin-top:4px;font-size:11.5px;color:var(--warn,#d97706)">⚠ ${blocked.length} pair(s) cannot be changed: ${escHtml([...new Set(blocked.map(b => `${b.apiName} in ${orgLbl(b.orgKey)} — ${b.why}`))].slice(0, 4).join('; '))}${blocked.length > 4 ? '…' : ''}</div>` : ''}
        <div style="margin-top:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <span style="font-size:12px">Type <code>CHANGE</code> to confirm:</span>
          <input id="depAvConfirm" style="width:90px;padding:2px 4px" autocomplete="off">
          <button class="btn-small" id="depAvGo2" disabled>⚙ Apply</button>
          <button class="btn-small" id="depAvNo">Cancel</button>
        </div>
      </div>`;
    const inp = box.querySelector('#depAvConfirm');
    const go = box.querySelector('#depAvGo2');
    inp.addEventListener('input', () => { go.disabled = inp.value.trim().toUpperCase() !== 'CHANGE'; });
    box.querySelector('#depAvNo').addEventListener('click', () => { box.innerHTML = ''; });
    go.addEventListener('click', () => applyApiVerChange(out, plans, target));
  }

  // Applying the change, ORG AT A TIME.
  //
  // Two deliberate shapes here, both learned from this file's own history:
  //   · Reads go through SF_COMPOSITE_BATCH, never one SF_GET_METADATA per
  //     flow version. Fanning out per version is exactly what the scan was
  //     refactored away from, and the same reasoning applies to any bulk
  //     read this file makes.
  //   · Each org gets ONE package holding every flow it is changing, so an
  //     org takes one deploy rather than one per flow. The deploy runs with
  //     rollbackOnError, which makes that package ALL-OR-NOTHING for that
  //     org: either every flow moves or none does. That is the safer of the
  //     two failure modes (no half-migrated org) but it has to be SAID, so
  //     the confirmation says it and the log repeats it on failure.
  // Post-deploy truth per flow: which version is ACTIVE now, at which API.
  // changed: [{ apiName, wasActive, prevVersion, defId }]. Returns
  // [{ apiName, ok, text }] — ok only when the org itself shows the new
  // version at `target` as the governing one (active where it was active).
  async function avVerifyAndActivate(org, changed, target, say) {
    const want = sftkApiVerNum(target);
    const read = async () => {
      const r = await depFlowVersions(org.orgUrl, org.sid);
      if (!r || r.error) return null;
      const by = {};
      for (const row of sftkFlowVerRows(r.records || [])) by[row.apiName] = row;
      return by;
    };
    let by = await read();
    if (!by) return changed.map(c => ({ apiName: c.apiName, ok: false, text: `${c.apiName}: the package was accepted but the org could not be re-read to verify — treat this change as UNVERIFIED and check the flow in Flow Builder.` }));
    const out = [];
    const toActivate = [];
    for (const c of changed) {
      const row = by[c.apiName];
      const newest = row && row.latest;
      // A version that is NOT active (Draft, Obsolete…) is overwritten in
      // place by the deploy — no new version appears (live 2026-09-22: a
      // Draft at API 58 read API 67 afterwards, same v1, and was reported as
      // "nothing changed"). The org's re-read is the proof either way.
      if (newest && !c.wasActive && newest.versionNumber === c.prevVersion && newest.num === want) {
        out.push({ apiName: c.apiName, ok: true, text: `${c.apiName}: v${newest.versionNumber} (${newest.status || 'not active'}) was rewritten in place at API ${target} — Salesforce overwrites a version that is not active instead of adding one (verified by re-reading the org).` });
        continue;
      }
      if (!newest || newest.versionNumber <= c.prevVersion) {
        out.push({ apiName: c.apiName, ok: false, text: `${c.apiName}: no new version appeared after the deploy (latest is still v${c.prevVersion}${newest ? ` at API ${newest.apiVersion || '?'}` : ''}) — nothing changed for this flow.` });
        continue;
      }
      if (newest.num !== want) {
        out.push({ apiName: c.apiName, ok: false, text: `${c.apiName}: v${newest.versionNumber} was created but reads API ${newest.apiVersion || '?'}, not ${target} — check it in Flow Builder.` });
        continue;
      }
      if (c.wasActive && !(row.active && row.active.versionNumber === newest.versionNumber)) {
        if (!c.defId) out.push({ apiName: c.apiName, ok: false, text: `${c.apiName}: v${newest.versionNumber} at API ${target} was created but is NOT active, and its definition id is unknown so it could not be activated here — the running version is still v${row.active ? row.active.versionNumber : '?'} at API ${row.active ? row.active.apiVersion : '?'}. Activate v${newest.versionNumber} in Flow Builder.` });
        else toActivate.push({ c, newest });
        continue;
      }
      out.push({ apiName: c.apiName, ok: true, text: c.wasActive
        ? `${c.apiName}: v${newest.versionNumber} at API ${target} is ACTIVE (verified by re-reading the org).`
        : `${c.apiName}: v${newest.versionNumber} at API ${target} was created; the flow was not active before and is not active now (verified).` });
    }
    if (toActivate.length) {
      say('\u23FB', `${org.label}: activating ${toActivate.length} new version(s) — the org did not activate them on deploy (its "Deploy processes and flows as active" setting is off)…`);
      // The write discipline (sftk-write.js): the PATCHes are one write
      // batch, the re-read is ONE call for all of them (verifyAll), and
      // `ok` is only what the org shows afterward — never the PATCH answer.
      const actBatch = await sftkWriteVerifiedAll(toActivate.map(({ c, newest }) => ({
        describe: c.apiName,
        write: async () => {
          const r = await depBg({ type: 'SF_PATCH', orgUrl: org.orgUrl, sid: org.sid, _silentError: true,
            path: `services/data/v62.0/tooling/sobjects/FlowDefinition/${c.defId}`,
            body: { Metadata: { activeVersionNumber: newest.versionNumber } } });
          c.activateError = (r && r.error) ? String(r.error) : null;
          return r;
        },
      })), {
        verifyAll: async () => {
          by = await read();
          return toActivate.map(({ c, newest }) => {
            const row = by && by[c.apiName];
            const activeNow = row && row.active && row.active.versionNumber === newest.versionNumber && row.active.num === want;
            return { ok: !!activeNow, text: activeNow
              ? `${c.apiName}: v${newest.versionNumber} at API ${target} is now ACTIVE (activated here, then verified by re-reading the org).`
              : `${c.apiName}: v${newest.versionNumber} at API ${target} was created but could NOT be activated${c.activateError ? ` — ${c.activateError}` : ''}; the running version is still v${row && row.active ? row.active.versionNumber : '?'} at API ${row && row.active ? row.active.apiVersion : '?'}. Activate it in Flow Builder.` };
          });
        },
      });
      toActivate.forEach(({ c }, i) => out.push({ apiName: c.apiName, ok: actBatch.results[i].ok, text: actBatch.results[i].text }));
    }
    return out;
  }

  async function applyApiVerChange(out, plans, target) {
    const st = _avState;
    const box = out.querySelector('#depAvApplyOut');
    const prog = out.querySelector('#depAvApplyProg');
    const byOrg = new Map();
    for (const p of plans) {
      for (const a of p.plan.applicable) {
        if (!byOrg.has(a.orgKey)) byOrg.set(a.orgKey, []);
        byOrg.get(a.orgKey).push({ ...a, apiName: p.apiName });
      }
    }
    const lines = [];
    box.innerHTML = '<div class="dep-blast-sec" id="depAvLog" style="max-height:260px;overflow:auto"></div>';
    const log = box.querySelector('#depAvLog');
    const say = (icon, msg) => {
      lines.push(`${icon} ${escHtml(msg)}`);
      log.innerHTML = lines.slice(-300).join('<br>');
      log.scrollTop = log.scrollHeight;
    };
    let orgsOk = 0, orgsFailed = 0, flowsOk = 0, flowsWarn = 0;
    let n = 0;
    for (const [orgKey, jobs] of byOrg) {
      n++;
      const org = st.orgs.find(o => o.key === orgKey);
      prog.textContent = `org ${n} / ${byOrg.size}`;
      if (!org || !org.sid) { orgsFailed++; say('❌', `${orgKey}: no session for this org — nothing changed here`); continue; }

      // 0 — the package.xml version must be the ORG's API version. A package
      // stamped with the TARGET version rejects any property Salesforce added
      // after that version ("Property 'areMetricsLoggedToDataCloud' not valid
      // in version 62.0" — reproduced 2026-09-03). Unknown ⇒ read it again;
      // still unknown ⇒ this org is refused, never guessed.
      if (!org.maxVersion) {
        const mx = await avOrgMax(org);
        if (!mx.error && mx.version) org.maxVersion = mx.version;
      }
      if (!org.maxVersion) { orgsFailed++; say('❌', `${org.label}: the org's own API version could not be read, so the package cannot be stamped safely — nothing changed here.`); continue; }

      // 1 — batch-read every flow version this org is changing.
      say('\u{1F4D6}', `${org.label}: reading ${jobs.length} flow version(s)…`);
      let items = null;
      try {
        const resp = await depBg({
          type: 'SF_COMPOSITE_BATCH', orgUrl: org.orgUrl, sid: org.sid,
          subrequests: jobs.map(j => ({ method: 'GET', url: `tooling/sobjects/Flow/${j.flowVersionId || ''}` })),
          concurrency: 1, _silentError: true,
        });
        if (Array.isArray(resp)) items = resp;
        else if (resp && resp.error) { orgsFailed++; say('❌', `${org.label}: could not read the flows — ${resp.error}. Nothing changed here.`); continue; }
      } catch (e) {
        orgsFailed++; say('❌', `${org.label}: could not read the flows — ${(e && e.message) || e}. Nothing changed here.`); continue;
      }
      if (!items || items.length !== jobs.length) {
        orgsFailed++;
        say('❌', `${org.label}: the read came back with ${items ? items.length : 0} of ${jobs.length} flow(s) — refusing to deploy a partial package. Nothing changed here.`);
        continue;
      }

      // 2 — set the version on each, refusing the whole org if any one of
      // them cannot be read. A package missing a flow would silently leave
      // that flow behind while reporting success for the rest.
      const files = []; const members = []; const changed = []; let bad = null;
      for (let i = 0; i < jobs.length; i++) {
        const j = jobs[i];
        // SF_COMPOSITE_BATCH items are { ok, status, body } with the record
        // parsed into `body` (the scan reads them the same way) — not bare
        // records. Audit 2026-09-12: the old `.result || item` read made
        // every ⚙ Apply fail with "could not be read".
        const it = items[i];
        const rec = (it && it.ok && it.body && typeof it.body === 'object') ? it.body : null;
        const meta = rec && rec.Metadata;
        if (!meta) { bad = `${j.apiName} could not be read`; break; }
        const set = sftkFlowSetApiVersion(meta, target);
        if (set.error) { bad = `${j.apiName}: ${set.error}`; break; }
        const fullName = (rec.FullName || rec.fullName || j.apiName);
        const enc = new TextEncoder();
        files.push({ name: `flows/${fullName}.flow`, data: enc.encode(sftkFlowToXml(set.meta)) });
        members.push(fullName);
        changed.push({ apiName: j.apiName, from: set.from, to: set.to, status: j.status,
          wasActive: (rec.Status || j.status) === 'Active', prevVersion: Number(rec.VersionNumber) || 0,
          defId: rec.DefinitionId || null });
      }
      if (bad) { orgsFailed++; say('❌', `${org.label}: ${bad} — nothing changed in this org.`); continue; }

      // 3 — ONE package, ONE deploy, for this whole org.
      try {
        const enc = new TextEncoder();
        const zip = sftkBuildStoredZip([
          { name: 'package.xml', data: enc.encode(sftkFlowPackageXml(members, org.maxVersion)) },
          ...files,
        ]);
        // The write discipline (sftk-write.js): the deploy is the write,
        // avVerifyAndActivate (step 4) is the re-read — `ok` is only what
        // the org shows afterward, never the deploy's own answer.
        let verdicts = null;
        const wr = await sftkWriteVerified({
          describe: `${org.label}: deploy`,
          write: async () => depBg({ type: 'SF_METADATA_DEPLOY', orgUrl: org.orgUrl, sid: org.sid,
            zipBase64: zip, _silentError: true }),
          verify: async () => {
            say('\u{1F4E6}', `${org.label}: package accepted — ${changed.length} flow version(s) written at API ${target}. Verifying what is actually running now…`);
            // 4 — VERIFY. A deploy only CREATES a version. Whether it became the
            // active one depends on the org's "Deploy processes and flows as
            // active" setting, which this tool cannot see — so it re-reads the
            // versions, activates the new one where the flow WAS active (the ⏻
            // FlowDefinition primitive), re-reads again, and reports only what
            // the org confirms. Nothing here is assumed from the deploy result.
            const verdicts = await avVerifyAndActivate(org, changed, target, say);
            const okN = verdicts.filter(v => v.ok).length;
            return { ok: okN === verdicts.length, detail: verdicts };
          },
        });
        if (!wr.accepted) {
          orgsFailed++;
          say('❌', `${org.label}: deploy failed — ${(wr.raw && wr.raw.error) || 'no response'}. This package is all-or-nothing, so NONE of its ${jobs.length} flow(s) changed.`);
          continue;
        }
        verdicts = wr.detail;
        // The package was accepted: this org DID change. A flow whose
        // verification raised a warning is counted as such — not as an
        // unchanged org (live 2026-09-22: "2 flow(s) changed across 0 org(s);
        // 1 org(s) unchanged" after two flows had verifiably changed).
        orgsOk++;
        const okN = verdicts.filter(v => v.ok).length;
        flowsOk += okN; flowsWarn += verdicts.length - okN;
        for (const v of verdicts) say(v.ok ? '✅' : '⚠', `${org.label}: ${v.text}`);
      } catch (e) {
        orgsFailed++;
        say('❌', `${org.label}: deploy failed — ${(e && e.message) || e}. NONE of its flow(s) changed.`);
      }
    }
    prog.textContent = '';
    say('ℹ', `${flowsOk} flow(s) changed and verified${flowsWarn ? `, ${flowsWarn} with a warning above` : ''}, across ${orgsOk} org(s); ${orgsFailed} org(s) refused the package (unchanged). The table above is now STALE — reopen ⚙ API versions (or press ↻ Rescan) to re-read the org rather than trusting it.`);
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
      dead: depDeadSubflows(dependencyMap, flowsByApiName, depManagedMap()),
      chains,
      blast
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
          — ${report.flowCount} flow(s), ${report.chains.length} chain(s), ${report.dead.counts.dead} dead subflow(s).
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
        : `<div class="dep-blast-sec">${(_cacheDroppedRefs && _cachedIds.has(flow.Id))
          // QA 2026-07-29 (F5): this version was restored from the stored
          // cache, whose reference detail was dropped for size at store time.
          // Blaming a metadata load that never ran pointed the user at the
          // wrong fix — the detail comes back by re-reading, not by waiting.
          ? 'Reference details for this flow were not kept in this org\'s stored cache (too large to fit its storage budget) and this version was restored from that cache rather than re-read — rescan the dependencies to rebuild them.'
          : `Reference details unavailable for this flow (its metadata didn't load${isMetadataFetched() ? '' : ` — ${scanCaveat()}`}).`}</div>`}`;
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
    managedCaveat,
    loadManagedFlows,
    treeStaleForManaged,
    getManagedFlows,
    // Flows tab — dependencies per flow and the whole-tree backup (2026-09-14)
    flowScanState: (apiName) => depFlowScanState(flowsByApiName[apiName] || [], _scannedIds),
    subflowClosure: (apiNames) => depSubflowClosure(dependencyMap, apiNames),
    getDefinitionTriggerMap,                         // apiName → FlowDefinitionView.TriggerType (every definition)
    freshness,
    searchCoverage,
    // v1.1.0 — incremental cache + the destructive-path guarantee.
    primeFromCache,
    clearCache,
    deleteTrust,
    recheckForDelete,
    // N4d / N4e
    chainFor,                                        // apiName -> { down, up } annotated trees
    getDeadSubflows: () => depDeadSubflows(dependencyMap, flowsByApiName, depManagedMap()),
    buildReportObject,                               // plain data for depReportMarkdown/depReportCsv
    exportReport,                                    // downloads the .md + .csv
    showChainPanel,
    showBlastRadius
  };
})();
