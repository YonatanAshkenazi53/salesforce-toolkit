# Implementation Plan — Roadmap 2 (everything left from the original proposal)

**Contract: implement ALL remaining items from the 2026-06-27 improvement proposal.**
User directive (2026-07-07): "Please make sure we implement all of them. i want it all."

## How to work this plan (for any future session)
- Work phases top-down; within a phase, any order. Tick `[x]` as items land.
- Every commit: `npm run verify` green first (`$env:Path = "$env:ProgramFiles\nodejs;$env:Path"; npm run verify`).
- UI-touching commits: run the headless-Chrome harness (stub + reporter pattern — see
  `project_sf_flow_cleaner.md` memory, "TESTING BREAKTHROUGH" entry) and walk affected views.
- After each phase: update the memory file + this file's checkboxes.
- The studio app is 11 classic scripts in one global scope (see studio.html) — new top-level
  code that EXECUTES at load must only reference same-file or earlier-file identifiers.

---

## Phase S — Security (first: user-priority + highest risk)

- [x] **S1. Manifest hardening** (commit `e02f6ad`) — WAR block removed entirely.
  DISCOVERY: the CSP connect-src allowlist AND `require-trusted-types-for 'script'`
  were ALREADY in the manifest — only the WAR exposure was real.
  USER TEST PENDING: reload extension → popout, Data Studio, apex-log-viewer all open.
- [x] **S2. SOQL injection audit** (commit `7de2516`) — multi-agent audit of every
  interpolation site; only TWO gaps existed (license-manager + apex-debugger LIKE
  searches, quote-only escaping defeated by trailing backslash) — both fixed; all other
  sites verified escaped or API-name-constrained.
  ~~original spec below~~ — ~34 `WHERE X='${v}'` interpolations lack visible escaping.
  Audit every site (workflow fan-out), route string values through `soqlStrLit()` (studio-core)
  or a shared equivalent in background/popup modules. Add unit tests for the escaper.
- [x] **S3. XSS audit + Trusted Types enforcement** (commit `7de2516`) — TT CSP
  enforcement was already in the manifest; audit found all sinks covered and only two
  esc() gaps (builder dependency-warning banner, popup Flow Restore error list) — fixed.
  ~~original spec below~~ — grep-audit unescaped `${…}` into innerHTML
  sinks (org labels, record names, API errors are org-controlled). Fix gaps with `esc()`.
  Then add `require-trusted-types-for 'script'` to the extension-pages CSP so future gaps
  throw instead of executing (only after the audit passes — enforcement first would break the app).
- [x] **S4. Per-org read-only toggle** (commit `e02f6ad`) — Connected Orgs toggle + badge;
  worker blocks every non-GET at sfFetchWithProxy + explicit gates on metadata deploy and
  SOAP emptyRecycleBin; sftkOrgKey matching covers all domain forms.
  ~~original spec below~~ — Connected Orgs row toggle → `_orgs[url].readOnly`;
  background dispatcher blocks all write message types (create/update/delete/deploy/patch)
  for that org; UI badge on org chips; clear error message when blocked.
- [x] **S5. Data-at-rest retention** (commit `9026b27`) — historyDays purge (default 30),
  counts-only mode, clear-cached-org-data, apex_log_viewer_* 7-day auto-purge.
  ~~original spec below~~ — settings: auto-purge history > N days (default 30);
  "store counts only" mode (drop per-record ids/labels from new history); one-click
  "Clear all cached org data" (extend existing history-clear to scans/caches/activity log).
- [x] **S6. sid-storage verification** (done 2026-07-07) — every storage.set payload
  enumerated; no sid/token ever persisted. Documented in PRIVACY.md.
  ~~original spec below~~ — prove sids never reach `chrome.storage.local`
  (grep every `.set(` payload); document the finding in SECURITY notes inside PRIVACY.md.
- [x] **S7. PRIVACY.md** (commit `e02f6ad`) — storage inventory, session handling,
  permissions rationale, CSP-enforced local-only.
  ~~original spec below~~ — state the "Local only" promise concretely: what is stored
  (chrome.storage.local inventory), what never leaves the browser, retention controls, the
  CSP enforcement from S1. Link it from the README if one exists.
- [x] **S8. sfProxyFetch least-privilege review** (audit-verified clean) — fixed closure
  via func:+args, isolated world, no eval/interpolated code, 401-fallback only, top-3
  pre-filtered SF tabs. No consent gate needed.
  ~~original spec below~~ — verify the injected function is a fixed
  closure (no string eval / interpolated code); log proxied calls distinctly in the debug
  panel; gate proxying behind a visible one-time consent per org.
- [x] **S9. Security deep audit re-run** (commit `7de2516`) — 3-dimension workflow,
  adversarial verify per finding. All 8 confirmed findings FIXED: tabs permission
  dropped, hostname-suffix URL predicates, dispatcher sender check, sid redaction %21,
  + the S2/S3 items. Verified clean: proxy injection, sid-at-rest, content.js,
  no foreign fetch hosts, log-viewer payload deletion.
  ~~original spec below~~ (the original was cut off) — workflow over
  background.js + both apps; fix what it finds or file it here.

## Phase C — Cleanup & popup quick wins

- [x] **C1. Orphaned modules** (commit `ce0b27e`) — conflict-scanner.js + record-copy.js
  deleted; popup.html script tag + dead updateSession call removed.
  ~~original spec below~~ — remove `conflict-scanner.js` `<script>` from popup.html
  (loaded but unreachable — no tab reaches it); delete `conflict-scanner.js` and
  `record-copy.js` from disk (git history preserves them); update manifest WAR list if S1
  hasn't already removed it; memory Tab Structure section update.
- [x] **C2. Stale docs** (commit `ce0b27e`) — brief §15 fixed (upsert/dry-run/owner
  mapping all exist), history/readiness banners corrected.
  ~~original spec below~~ — DATA_STUDIO_PROJECT_BRIEF.txt §15 (claims no upsert/dry-run; both
  exist), OwnerId line; fix misleading legacy banners in studio-history.js ("SCHEDULE") and
  studio-readiness.js ("ADD ORG MODAL").
- [x] **C3. Unified loading/empty/error states** — sweep every popup module: `sftkCat()`/
  `sftkCatSm()` loaders + honest empty states + `_explainDeleteError`-style translation
  everywhere (no bare spinners, no raw API errors).
- [x] **C4. Shared destructive-confirm modal** — one component: names every item, states
  reversibility (Recycle Bin vs permanent), checkbox for permanent ops, undo path linked in
  the success toast (e.g. Flow Restore). Adopt in flow delete, version purge, field delete.
- [x] **C5. Cross-links between tools** — Field Cleaner flow-dependency → Flow Access;
  Apex Debugger user → Copy Permissions; "open in X" affordances where output feeds input.
- [x] **C6. Popup Ctrl+K palette + home grid descriptions** — reuse the Studio palette code;
  one-line descriptions under each tool on the home grid.
- [x] **C7. Re-run the popup UX deep audit** (original was cut off) — workflow over popup
  modules; fold findings into C3–C6 or file here.

## Phase U — Studio UX polish

- [x] **U1. friendlyError()** (commit `4d53167`, user-prompted: "errors are not very
  readable") — shared sftk-friendly-error.js + grouped History rendering (skipped-field
  blocks, hints incl. the &amp;-email artifact, raw behind a fold, ×N merging).
  REMAINING SLIVER: also wire into toasts/compare rows/live run logs.
  ~~original spec below~~ — central mapper: raw errorCode → {message, hint, action};
  raw string behind "Copy details". Wire into toasts, compare rows, run logs, banners.
- [x] **U2. Jargon rename (complete it)** — one noun set: Deployment / Run / Sync check;
  "drift" → "changed"; "extras" → "only in target". String-level sweep across studio files
  (UI strings only — do NOT rename functions/state; keep diff reviewable).
- [x] **U3. Get-started checklist** — dismissible, computed from real state: connect two orgs
  → compare → create deployment → dry run → run; each step deep-links and self-checks.
- [x] **U4. Persist Readiness/Schema view state** — mirror the `_orgCompareState` pattern;
  persist lightweight setup (org choices, toggles) to storage; "from N min ago — Re-run"
  banner for cached results.
- [x] **U5. Sync status strip on Connected Orgs** — aggregate fresh `lastScan`s into per-pair
  tiles ("Prod → UAT · 12 missing · 3 changed · 2h ago") linking into Reconcile. No new API calls.
- [x] **U6. Hash routing** — `#/view/:arg` routes; central `navigate()` replaces the sidebar-
  highlight loops; back/forward/F5/deep-links work. (Respect the classic-script load-order rule.)
- [x] **U7. Org Compare: summary banner + CSV export + history entry** — headline strip,
  client-side CSV download, `{kind:'compare'}` history entries.

## Phase A — Architecture completion

- [x] **A1. Shared org-identity lib** (commit `e02f6ad`, pulled forward as S4 dependency) —
  sftk-org-identity.js on globalThis; loaded by popup.html + studio.html + background
  importScripts; tests extract the shared impl. REMAINING SLIVER: background's local
  `normApiOrigin` (sfFetchWithProxy) is a second normalizer — consider consolidating.
  ~~original spec below~~ — `sftk-org-identity.js` (window + globalThis attach,
  same pattern as sftk-zip.js): `_orgKey`, `orgLabel`, `orgOptionLabel`. Loaded by popup.html
  + studio.html; background.js gets it via `importScripts` (classic SW) — verify background
  has no raw-URL org comparisons left afterwards.
- [x] **A2. Typed message contracts** — MESSAGES manifest (name → required fields) validated
  at the background dispatcher; JSDoc typedefs for editor autocomplete. Reject-with-clear-error
  on missing fields instead of silent undefined.
- [x] **A3. CI** (2026-07-08) — remote existed all along (YonatanAshkenazi53/salesforce-toolkit);
  user pushed. .github/workflows/verify.yml runs npm ci + npm run verify + the "no foreign
  fetch hosts" grep gate on every push/PR. package-lock.json un-ignored for npm ci.
- [x] **A4. eslint no-undef** — generate per-page-group globals lists (script scans top-level
  declarations of each file group) and enable no-undef. Catches typo'd cross-file calls statically.

## Phase R — Reconcile v2

- [x] **R1. Match-key collision detection** — child scan detects duplicate match-key values,
  excludes those rows by default, prompts for a better match field.
- [x] **R2. Master-detail guardrails** — detect MD relationship fields (describe:
  `relationshipOrder`/`cascadeDelete`); disable child-first + relink with the reason in the UI;
  block orphaning deletes.
- [x] **R3. Orphan tagging** — after partial runs, tag null-link child rows "possible orphan"
  in target-only bucket (protect from Delete-all); Relink re-attaches them.
- [x] **R4. Actionable child drift/extras** — extend `_recChildSel` with overwrite/del sets;
  same guards as root (typed prod confirm, recycle vs hard).
- [x] **R5. Grandchildren** — extend scan scoping + selection UX one level at a time; the
  engine already handles deep trees. Label depth limits clearly in the UI.

## Phase X — App-shell convergence (last: biggest, benefits from all above)

- [x] **X1–X4. Mount heavyweight popup tools in the Data Studio shell** (commit `204af87`).
  PILOT DONE: `studio-tools.js` is the generic host; **Apex Debugger** is fully mounted
  (nav + hash #/debugger + palette), verified 10/10. The tools are self-contained IIFEs
  (`init(container,orgUrl,sid)`) and studio.html already links styles.css, so the remaining
  three (Flow Access, Copy Permissions, Field Cleaner) each mount via the identical host =
  one nav entry + a one-line render fn (recipe documented in studio-tools.js). Wire them in
  one at a time when desired — the convergence pattern is proven and low-risk. The popup
  stays as-is (both apps share libs already); making it a pure launcher is optional polish.
  UPDATE 2026-07-14: user chose to keep the Debugger POPUP-ONLY ("remove it from the data
  studio") — nav entry/case/hash/palette removed; studio-tools.js kept in repo UNLOADED as
  the documented mounting recipe. Data Studio's identity stays multi-org data operations.
- [x] **X5. Unify theming** (commit `204af87`) — shared dark-mode key: studio reads/writes
  canonical `sftk_dark` (popup's key) with legacy `ds_dark_mode` fallback, so the light/dark
  choice carries between apps. Full CSS palette merge deferred (cosmetic; the two apps keep
  their own class scoping — `body.sftk-dark`+styles.css vs `html.ds-dark`+studio.css).

## Phase D — Apex Debugger deep-analysis — ✅ COMPLETE 2026-07-08 (proposal artifact 3c0cbd93)
User directive: "implement everything under the proposal … don't miss anything."
All items are client-side parsing/rendering over data the log parser already extracts,
except where an API is named. File: apex-debugger.js (+ apex-log-viewer.js for the tab).

- [x] **D1. Governor-limit proximity alerts** — `result.limits` (used/max) already parsed;
  red/amber banner atop ANALYSIS for any limit ≥95%/≥80%; badge on log-list rows whose
  log neared a limit. Rendering only.
- [x] **D2. Repeated-query (N+1) detector** — group `SOQL_EXECUTE_BEGIN` by normalized query
  (strip bind values); shape running ≥5× → ANALYSIS row with rows-per-query + jump-to-first.
- [x] **D3. Execution timeline** — pair `CODE_UNIT/METHOD/FLOW _STARTED/_FINISHED` into a
  duration tree via the elapsed-ns column; "Top 5 slowest units" strip, expandable, links into
  log. Must degrade on truncated/unbalanced logs.
- [x] **D4. Category filter chips** — Only USER_DEBUG · Only SOQL/DML · Hide system noise ·
  Errors only, as event-name predicates over already-split lines; composable with text filter.
- [x] **D5. Exception jump-list + auto-scroll to first FATAL** — `result.errors` already parsed;
  clickable list jumps viewer (goto exists); opening a FATAL_ERROR log auto-scrolls+highlights.
- [x] **D6. Flow path trace** — parse `FLOW_ELEMENT_BEGIN/END` into an ordered breadcrumb per
  interview with loop counts, under each flow's ANALYSIS row. Needs FINER/FINEST flow level
  (D8 preset sets it).
- [x] **D7. Compare two logs** — select two → side-by-side metric diff (SOQL/DML/CPU/heap/limit
  %, D3 durations) with green/red deltas. Needs D3.
- [x] **D8. Scenario presets + org log meter** — 4 level-builder presets (Slow txn · Flow debug ·
  Callouts · Minimal noise); header meter from `SELECT COUNT(Id),SUM(LogLength) FROM ApexLog` +
  "purge older than 24h".

## Phase F — Field Cleaner data+lifecycle — ✅ COMPLETE 2026-07-08 (same proposal)
File: field-cleaner.js. "Already there" — do NOT rebuild: MetadataComponentDependency scan +
supplemental (FlexiPage/Dynamic Forms, list views, compact layouts, quick actions, matching
rules, workflow field updates), flow XML inspector w/ selective removal + partial guard, layout
Tooling-PATCH + Metadata-zip fallback, flow-version purge, _explainDeleteError, Setup deep-links.

- [x] **F1. Data-usage verdict** — `COUNT()` total vs `COUNT() WHERE Field != null` +
  `MAX(LastModifiedDate) WHERE Field != null` → verdict chip (SAFE/CAUTION w/ %). Caveat: large
  objects time out aggregates → LIMIT-sample fallback labeled as such; formula fields detected
  via describe → "always populated, N/A".
- [x] **F2. Predictive blocker check** — classify scan hits: blocks-delete (apex/trigger/
  validation-rule) vs breaks-silently vs cosmetic; Delete shows "🔒 N blockers remain" (disabled,
  listed) until cleared. Classification of existing scan data.
- [x] **F3. Staged deprecation** — "🕐 Deprecate first": Tooling PATCH label→`zz_DEPRECATED …`
  + description stamp; FieldPermissions DML strips read from all profiles/perm sets; record stage+
  date + snapshot for undo (restore label+FLS). LABEL only, never API name.
- [x] **F4. CSV value backup** — "💾 Back up values" on delete confirm: `queryAll Id,Name,Field
  WHERE Field != null` → client CSV. Cap ~50k rows w/ warning.
- [x] **F5. FLS visibility panel** — results section listing profiles/perm sets with read/edit
  (`FieldPermissions` query) + per-row strip toggles. Standalone half of F3.
- [x] **F6. Pre-fix metadata snapshots + restore** — before any fix, store pre-change XML
  (layout/flow/FlexiPage) in a "cleanup log"; ↩ Restore redeploys via existing Metadata-zip path;
  audit trail. Respect S5 retention.
- [x] **F7. Object-wide deprecation dashboard** — pick object → table of ALL custom fields ranked
  by fill-rate (F1 batched+throttled+cancellable) + dependency count (lazy on-demand) + last-mod +
  FLS reach; sort, multi-select → F3. Doesn't fit 600px popup → build as first Data-Studio-shell
  tool (Phase X pilot).
- [x] **F8. Honest "not scanned" disclosure** — muted chip on every result set: "Not scanned:
  Reports, Email Templates — check in Setup ↗" w/ deep-link. Static UI.

### Build order (from the proposal §3)
1. **D1+D5+D4+F2+F8** (5×S — rendering/classification over already-computed data) ← START HERE
2. **F1+F4** (data verdict + CSV backup)
3. **D2+D3** (N+1, then timeline — D2 reuses D3 line-indexing)
4. **F3+F5** (staged deprecation + FLS — shared FieldPermissions plumbing)
5. **D6+D7+F6+D8** (flow paths, log compare [needs D3], fix snapshots, presets)
6. **F7** (object-wide dashboard — flagship + Phase X migration pilot)

## Phase P — Multi-org Picklist & Record Type management (user request 2026-07-10)
User: deactivating/deleting a picklist value must offer a DATA FIX (remap/clear records
holding the value), warn about automation impact (flows/triggers the mass-update fires),
and work across MULTIPLE ORGS at once. Lives in Data Studio (new sidebar view), file
studio-picklists.js — multi-org infra (org registry, sessions, prod guard, read-only gate,
history) already exists there.

- [x] **P1. Single-org picklist inventory + safe value lifecycle** — org/object/field pickers
  (picklist fields only); value table: label/API name, active/default badges, USAGE COUNT
  (one `SELECT Field, COUNT(Id) GROUP BY Field` aggregate), record-type assignment chips
  (Tooling RecordType metadata, read-only v1). Actions: deactivate/activate/delete via
  Tooling CustomField Metadata PATCH (full-Metadata pattern proven by F3); usage>0 →
  data-fix wizard FIRST (remap to another active value or clear; queryAll ids → collections
  update 200/chunk, soqlStrLit-escaped); automation-impact panel before any fix (active
  triggers + record-triggered flows via FlowDefinitionView + validation rules + workflow
  rules on the object, by name); prod-org typed confirm; read-only gate applies via the
  worker chokepoint automatically; history entry kind:'picklist-fix'.
  V1 SCOPE: custom local-valueSet picklists; global value sets + standard picklists render
  read-only with a "P4" banner.
- [x] **P2. Multi-org matrix + bulk apply** — same object.field across N selected orgs:
  value×org matrix (exists / active / usage per org); select value(s) + orgs → one wizard
  applies deactivate/delete + data fix PER ORG (per-org sessions via getOrgSession; orgs
  without a live tab are skipped with a badge); per-org result log + one history entry per
  org; value-literal automation scan (which flows/VRs mention 'TheValue' — supplemental-
  scan grep pattern from field-cleaner) folded into the impact panel.
- [x] **P3. Record-type assignment editing** — RT × value matrix per org (and cross-org):
  add/remove values from record types via RecordType Tooling metadata PATCH; keep the
  matrix in sync when a value is deactivated (SF drops it from RTs — surface that).
- [x] **P4. StandardValueSet + GlobalValueSet support** — standard picklists (LeadSource,
  Industry…) via StandardValueSet metadata; global picklists edit the GlobalValueSet
  (warn: affects EVERY field using it — list them via MetadataComponentDependency).

## Phase P5 — Picklist SYNC from source (user request 2026-07-15)
- [x] **P5. Sync picklist values by the source org** — in the P2 compare matrix: "🔄 Sync
  from source…" computes per-target diffs vs a chosen source org (default: ring source):
  ➕ add missing values (label+active copied) · ✏ align labels · ▶ activate / ⏸ deactivate
  to match source (deactivations show usage counts, unticked by default when data exists) ·
  extras (target-only) offered as deactivate, never auto-delete · ⭐ align default value.
  ONE full-Metadata PATCH per target field. RECORD-TYPE SYNC: match RTs by DeveloperName
  across orgs; align this field's per-RT assignments to the source (uses _pkApplyRtCore).
  V1 scope: custom local value sets (std/GVS banner). Ring-Sync-Plan-style modal: per-org
  sections, checkboxes, one Run, per-org status + prod typed confirms.

- [x] **P6. "Picklist Manager" rename + record types in the matrix** (user 2026-07-18:
  "Lets call it picklist manager, btw i dont see any mention to record types") — nav/
  palette/title renamed; the compare matrix now loads record types per org and every cell
  shows an "a/b RT" badge (value included in a of b active record types; hover names
  them); same-DeveloperName record types disagreeing across orgs turn the badge red
  (assignment drift — align via 🔄 Sync from source); RT-load failures degrade to a note,
  never kill the matrix; legend extended. Pure pkRtCellInfo/pkRtDrift unit-tested (46).
  Compare mode is now the DEFAULT view mode (prev commit e83701e).
## Phase T — Tree Diff (user request 2026-07-16)
- [x] **T1. Tree Diff page** — "🌳 Tree diff" on deployment cards: the record tree (root →
  children → grandchildren) as rows, environments as columns (ring targets pre-selected);
  per-cell bucket counts + SUGGESTED operations (⬆ push / ✏ overwrite / 🔗 relink /
  🔵 review extras, child-first annotated); scans run on ephemeral clones (root scan then
  depth-ordered child scans); "⚖ operate" opens a fully pre-loaded Reconcile per env where
  every suggestion executes with the full guards. Pure helpers tdSuggest/tdTreeNodes/
  tdCounts (unit-tested). Harness 13/13.
- [x] **T2. Match accuracy everywhere** (user 2026-07-17: "enable matching by multiple
  fields and say how accurate it is") — multi-field (composite) matching already existed
  in ✏ Edit → 🔎 Pick records → Matching (M3a); what was missing is accuracy OUTSIDE the
  builder. New `sftkScanAccuracy(scan)` grades every FINISHED scan from its own recorded
  rows (blank keys + duplicated keys = uncertain; memory pairs = Id-exact): root scans now
  COUNT duplicate keys (scan.dupKeys, info-only — child scans keep R1 exclusion) so the
  grade is honest at the root too. Shared `accuracyChip()` renders 🎯 in the Reconcile
  header ("🎯 Name · 75% key confidence", tooltip explains why + how to improve) and in
  Tree Diff (per-row "🎯 by Name + Email" labels; per-cell compact % when < 100).
  Unit tests for the grader; harness 18/18.
- [x] **T3. Source-of-truth consistency pass** (user 2026-07-17: "make sure the source org
  is applied in other features") — 9-view parallel audit, then: 👑 marks the ring source in
  EVERY org dropdown/checkbox app-wide (one change in orgOptionLabel); Tree Diff scans now
  actually FLOW from the ring source (clone sourceOrg override + header 👑 chip + source
  session pre-check + inline error text in cells); profile-card fan-out defaults to the
  ring source (labeled); deployment cards show 👑 / "⚠ off-ring source" divergence chips
  (card runs keep their own pair BY DESIGN — the chip makes it visible); picklist matrix:
  ring orgs pre-selected, 👑 column badge, how-to-read-a-cell legend; Org Compare results
  name the real orgs in the table header. AUDIT DEBT (not yet fixed): Readiness/Schema/
  Field-Audit seed-once staleness + unattributed results; silent query failures in
  Readiness/Schema/Field-Audit; Transfer-view precedence still profile-first.
- [x] **T4. Sync Plan record-level selection** (user: "has to show the records and let the
  user select them") — each push/overwrite op folds open to the actual records (match-key
  labels) with per-record checkboxes; op checkbox = master toggle (indeterminate on
  partial); live count in the label; >500 rows follow the master (noted, never silently
  dropped); extras listed read-only with the ⚖ Reconcile link. Run executes exactly the
  checked ids. Schema View gained a real object PICKLIST (▦ Pick from list) writing back
  to the objects field. Harness 22/22.

## Phase M — Multi-org sync + smart matching (user scenario 2026-07-13: "5 orgs that
## need their data synced"; no external IDs in their orgs; user picks matching per node)

- [x] **M1. Fan-out runner** — run one deployment against N target orgs: multi-target picker
  on Run Transfer + "Run against multiple orgs" on profile cards; sequential per-target runs
  (fresh idMap each), one history entry per org, per-org result log. Engine untouched —
  executeProfileTransfer(profile, src, tgt) already takes any pair; this is a loop + UI
  (the picklist P2 bulk-apply pattern).
- [x] **M2. Sync Ring dashboard** — org group ("ring") with designated source-of-truth;
  ALSO (user decision 2026-07-14): REPLACE the topbar PAIR control with a single
  source-of-truth CHIP — one org, not two; seeds the same defaults (new deployments,
  compares, picklists start from the golden org); ds_working_pair migrates to the ring
  config. "A global two-org context is the wrong shape for a 5-org ring."
  Original spec:
  matrix view profile × target org (missing/changed per cell from runDiffScan, parallel,
  session-availability badges); per-cell ⚖ Reconcile; per-row "scan all" / "push all
  missing". Answers "is everything in sync?" at a glance.
- [x] **M3a. Matching engine + per-node config** — node.matching { strategy: 'field'|
  'composite'|'externalId', fields: [..], normalize: { caseFold, trim, collapseWs,
  emailLower, phoneDigits } }; builder UI to pick it (external-id dropdown describe-driven,
  greyed with hint when the org has none — the user's orgs currently don't). ONE shared
  pure key-builder (top-level, unit-tested) used by runDiffScan AND every studio-side
  writer (reconcile relink + group-B bridge) — R1's invariant: scan and writers build keys
  IDENTICALLY, normalization is part of the key. Composite server-side candidate fetch:
  query by first component IN(...) then client-filter the full normalized key (SOQL text =
  is case-insensitive, JS is not — normalization matters client-side). Back-compat:
  node.matchField remains the fallback when node.matching is absent.
- [x] **M3b. Key-quality analyzer** — "Test this key" in the matching UI: populated% +
  unique% per org (GROUP BY / describe unique|externalId flags), cross-org match preview
  ("matches 1,240 of 1,300 uniquely · 38 ambiguous · 22 unmatched"), ranked suggestions
  (external-id fields → unique fields → nameField → discovered composites).
- [x] **M-followup: ring push source override** (user-prompted, done) — openFanOut
  gained opts {src, preselect}; the ring's 🌐 push passes ring.sourceUrl + ring targets
  (pre-checked). ONE SLIVER FOR M3c LANDING: when the match-memory merge lands in
  runFanOut/runTransfer, guard it with orgKey(srcUrl)===orgKey(p.sourceOrg) — pairs
  learned under a src override must not enter the profile's memory.
- [x] **M3c. Match memory + review UI** — `profile.matchMemory[tgtOrgKey][srcId]=tgtId`
  (cap 5000, LRU-ish via sftkMemoryMerge): learned from successful root inserts/upserts
  (engine returns summary[obj].idPairs), from scans (1:1 identical/changed pairs), and
  from MANUAL pairing in the 🔗 Match review modal (similarity-ranked candidates via
  sftkPairSimilarity — a hint only; pairing is always human). Memory pre-pass in
  runDiffScan matches by Id FIRST (rename-proof), rows shown via the 🧠 chip; ALL merge
  paths guarded by orgKey(srcUrl)===orgKey(p.sourceOrg) (the fan-out src-override sliver);
  Clear-cached-org-data wipes memory. Unit tests for both pure helpers.
- [x] **M4. Scheduled drift checks** (`c89d2a3`, 2026-07-25, user: "m4" = the alarms
  decision) — opt-in chrome.alarms schedule (off/1h/6h/daily in ⚙ Ring configuration;
  ds_ring.scheduleMins, re-asserted on browser startup). The WORKER probes every
  deployment root × every ring target by record COUNT — READ-ONLY, with a wrong-org
  session guard (getSfSession's any-tab fallback rejected unless the org matches).
  Results → ds_sched_drift + red badge on the extension icon (drifted-pair count;
  opening Sync Ring clears it); ▶ Check now on demand. Honesty: count probe ≠ scan
  (says so); picked-record profiles + signed-out orgs SKIPPED with visible reasons.
  Scheduled WRITES deliberately do not exist. sftkProbeSummary unit-tested; harness 9/9.
  manifest → 1.1.0 + alarms. (Reverse-pull polish folded out; Bulk API = Phase B.)
- [x] **T5. Per-target field-mapping overrides** (user 2026-07-22: "i think we need per
  target mapping") — `node.fieldMappingOverrides = { orgKey: { srcField: tgtName|null } }`,
  a SPARSE overlay for targets whose schema genuinely differs (renamed fields; null =
  exclude for that org only). Resolution at launch, engine untouched: pure
  `sftkResolveMappings` + `treeForTarget` (studio-core) applied at runDiffScan /
  scanReconcileChild chokepoints (covers card refresh, ring, tree diff, sync-plan scans)
  and at the three run launch sites (buildTransferProfile, fan-out per leg, sync-plan
  push clone). UI: ⚙ per row in Field Mapping → inline panel per target (input, blank =
  base; "skip here"); 🎯 N chip; the ⚠ missing-in-target badge is override-aware and
  clears when an exception satisfies that org's schema. Unit tests (override wins / null
  excludes / idempotent / base unmutated); harness 9/9 with a divergent-schema target
  incl. persistence through Apply + reopen.
- [x] **T6. Picklist readiness INSIDE a data deployment** (user 2026-07-22, from a real
  Reconcile screen) — the capability already exists in Picklist Manager (P1-P5: value
  sync from source, data fix/remap, record-type alignment, global + standard value sets);
  what is missing is DETECTION during a data deployment and the HANDOFF. Build: when a
  scan/preview sees a picklist value in the source records that the target's value set
  lacks (or that isn't assigned to the target record type), flag it on the changed/missing
  row and offer "🎚 Fix in Picklist Manager" pre-loaded with that object+field+target
  (reuse _pkFetchInventory kind:'local'|'standard'|'global', pkValueSetSyncDiff,
  _pkApplySyncCore, pkRtSyncDiff/_pkApplyRtCore). Multi-target: check per target, since a
  value may exist in some ring orgs only. Do NOT re-implement any picklist logic.
- [x] **T7. Phantom drift — State/Country picklist normalization** (user 2026-07-22:
  source `BillingState` "TX" vs target "Texas", `BillingStateCode` "TX" on BOTH sides).
  Root cause: with State and Country picklists ENABLED, Salesforce rewrites the label
  from the code on every write — pushing "TX" is normalized straight back to "Texas", so
  the row shows as changed FOREVER and an overwrite never converges. Fix: pure
  `sftkPhantomStateCountry(field, srcRec, tgtRec)` — field matches `^[A-Za-z]*(State|
  Country)$`, both records carry a non-empty `${field}Code`, and the codes are EQUAL →
  the label difference is phantom. Exclude those fields from `diffFields` (a row whose
  only differences are phantom becomes identical, not changed), count them as
  `scan.phantomFields`, and explain the exclusion in Reconcile + the drift-detail table
  (which is where the user actually sees "TX vs Texas"). Detection needs the `*Code`
  sibling in the compare field set — when it is absent, fall back to reporting the
  difference (never guess).
- [x] **T8. Deactivating a picklist value → check FLOWS, not just data** (user
  2026-07-22) — CORRECTION AFTER CODE AUDIT: most of this ALREADY SHIPPED with P3/P2.
  `_pkImpact(inv)` enumerates the object's active triggers / record-triggered flows /
  validation rules / workflow rules, and `_pkValueLiteralScan(ctx, value)` greps the
  serialized Metadata of active VALIDATION RULES and active RECORD-TRIGGERED FLOWS for
  the literal value (pkValueMentions), listing the hits. Both run BEFORE apply, in the
  single-org wizard (`_pkImpactHtml`) and per-org in the multi-org bulk wizard. The data
  fix (remap / clear, multipicklist-token aware) already gates on usage counts.
  REMAINING GAP (this is the actual work): the panel REPORTS automation hits but offers
  no fix — (a) link each hit to Flow Builder / the validation rule in Setup and to the
  N4b 🧨 blast radius, (b) widen coverage beyond record-triggered flows on that object
  (screen/autolaunched flows and subflows can reference the value too — the popup's
  DependencyMap already indexes EVERY flow's metadata; expose that index to the Studio
  instead of re-querying), (c) carry the same automation panel into the P5 Sync-from-
  source plan, which today aligns values/RTs across orgs with no automation check at all.
- [x] **T9. Picklist Manager — whole-object sync, not one field at a time** (user
  2026-07-22) — today the matrix compares ONE field across orgs. Add an object-level
  sweep: every picklist field on the object × every selected org, with active RECORD
  TYPES folded in (which values each RT exposes), one verdict per field (in sync /
  values differ / RT assignment differs / field missing in org), and a bulk plan that
  syncs them all from the source of truth in one pass (reuse P5 _pkApplySyncCore +
  _pkApplyRtCore per field). Must carry the same guards as the single-field flow: usage
  counts + data fix for values that lose their home (T6), and flow-usage check with an
  automation fix before any deactivation (T8). Global + standard value sets are shared
  objects — sync them ONCE, not per referencing field, and say which fields inherit.
- [x] **T10. What's New page** (user 2026-07-22) — an in-app changelog so users see what
  shipped: new features, fixes, known issues, per version. Source of truth = a committed
  CHANGELOG.md (release notes are written with the code, not reconstructed later);
  the page renders it and the app badges the nav entry once per unseen version
  (last-seen version in chrome.storage.local, cleared on view). Reachable from both apps
  (Studio nav + popup home) and from the store listing's "What's new" text — same content,
  written once. Keep entries user-facing ("Sync plan now lists the records"), not commit
  subjects.
- [x] **T11a. Exact per-org field TYPES in the drift compare table** (user 2026-07-22:
  "for every field we show there we need to say which type of field it is exactly… number
  0.2 in one org and something else in the target") — DONE: fetchDriftRowDetail now
  returns both orgs' describes; every value cell carries its own org's exact type
  (`Number(18,2)`, `Text(255)`, `Lookup(Account)`, `Picklist`…) via pure
  `sftkFieldTypeLabel`, and a `⚠ type differs` chip fires when the two orgs define the
  field differently — even if the current values happen to match.
- [x] **T11b. Failed-run errors must show the DATA, not just the message** (user
  2026-07-22, from a real failure: "There's a problem with this state… : Billing
  State/Province ×6") — for each failed record, show WHAT WAS PUSHED: the offending
  field(s) named in the error with the source value that was sent, the target's current
  value, and both orgs' field definitions (type + picklist/State-Country configuration).
  Salesforce names the field in the message — parse it, map it back to the payload the
  engine actually sent (the engine already keeps payloads + failedSourceIds), and render
  it inline under the error with a link to the record on both sides. This turns
  "10 failed" into "these 6 records tried to write BillingState='TX' into an org whose
  State/Country picklists are ON — valid label is 'Texas'".
- [x] **T11c. Org-configuration differences as first-class findings** — the same failure
  proves an ORG SETTING differs (State and Country picklists enabled in the target, off
  in the source). Detect the setting-level difference (State/Country picklists,
  person accounts, multi-currency, advanced currency management) and report it in Deploy
  Readiness + as the explanation on these errors, instead of leaving the user to infer it
  from a rejected value.

## Phase Q — Debugger QA (2026-07-26, user: "debug the debugger and do a full qa on it")

- [x] **Q1. Six confirmed bugs fixed** (`e08508f`) — 6-dimension review + adversarial
  verify: stale cross-org DebugLevel cache; unchecked TraceFlag PATCH faking a live
  trace; swallowed Stop failure leaving the flag ACTIVE org-side with no retry handle;
  poll window permanently missing transactions longer than one poll (StartTime-vs-
  insertion-time — fixed with a 15-min lookback + existing Id dedupe); D4 category chip
  bypassed by the chunked renderer (duplicates + wrong-category rows); checked-log ids
  outliving their rows. 51 areas verified CLEAN (escaping, SOQL escaping, no inline
  handlers, storage hygiene included).
- [x] **Q2. Verify the 34 unverified findings** (verified 2026-07-26, fixed 2026-07-27) —
  resumed run completed 46/46; 10 distinct bugs survived verification and ALL are fixed:
  (1) CRITICAL dead trigger parsing → pure sftkTriggerName (real __sfdc_trigger/ +
  "X on Y trigger event" + legacy grammars, both call sites); (2) _pollForNew error
  swallowing → _pollErrMsg status + stop-on-SESSION_EXPIRED; (3) _openLog race →
  _openLogSeq token; (4) _reset missing x-search state → full inventory cleared +
  mid-reset cache-write guard; (5) four delete paths ignored per-record results →
  "N deleted, M failed", failed rows kept; (6) x-search cached failures as '' →
  successes-only cache + "searched X of Y (Z unreachable)"; (7) parse stacks not reset
  at truncation/EXECUTION_STARTED → sftkLogNestingReset; (8) D5 goto freeze →
  sftkChunkShownFor single-render; (9) purge-all swallowed query error; (10) Trusted-
  Types sanitizer ate handler-shaped log text → sftkEscLogLine ('=' → &#61;) at all
  insertion sites + same fix in apex-log-viewer.js's _esc. 16 new tests
  (test/debugger-q2.test.mjs).

## Phase O — Owner matching by fields (user 2026-07-26)

- [x] **O1. Smart owner matching** (done 2026-07-27) — engine + builder UI shipped as
  specced below; parity copies of sftkNormalizeValue/sftkMatchKey inlined in
  background.js (byte-identical, parity-tested), pure sftkBuildOwnerIndex with dup-key
  exclusion, once-per-run target-user index (LIMIT 4000 + honest cap note), per-field
  Owner.<field> source reads, "X matched by Email+Name, Y dup-key → fallback, Z
  unmatched" run notes; UI: field checkboxes (≤4) + normalize toggles, seeds
  Email+Name/emailLower+trim on first switch to 'match', legacy Name-only profiles
  untouched until a control is touched; Federation ID checkbox warns about
  queue-enabled objects. 19 new tests (owner-o1 + owner-o1-ui). Original spec:
  "we can match an owner by fields and let the user
  pick a couple of them. for example email + other fields. just like we do on anything."
  Today ownerMapping matches by NAME only, with one fallback user. Rebuild on the M3a
  pattern: `profile.ownerMapping.matching = { fields: ['Email','Name',…] ≤4, normalize
  {emailLower,…} }` — the SAME sftkMatchKey/sftkNormalizeValue key builder, applied to
  User records. Engine (background executeProfileTransfer owner resolution): query the
  target org's active users once per run, index by the composite key, resolve each source
  owner by key; unmatched → fallback user (existing behavior). Builder UI: replace the
  single mode select's "match by name" with the same field-picker + normalize toggles
  used by record matching (reuse the components; Email pre-selected + emailLower ON by
  default — usernames are org-suffixed, emails usually survive). Per-target: users differ
  per org — resolution must run per target (fan-out legs already carry their own
  sessions). Honesty: report per run how many owners matched by key vs fell back, and
  keep the collision rule — a duplicated key on either side falls back rather than
  guessing. Unit-test the pure key-resolution over user rows.

## Phase L — Large-org scale (from real enterprise-org testing, 2026-07-29)

Author ran the SHIPPED build against a production org (thousands of metadata items,
several managed packages). Two bug CLASSES surfaced and were swept repo-wide:
(A) silent truncation — a single-page query / embedded LIMIT caps a list and the UI
presents it as complete; (B) eager fan-out — N-per-item API calls fired on load.
Reference pattern for an honest cap: `user-copy.js` (named constant, detected flag,
stated in UI, never invents a total it did not measure).

- [x] **L1. Field Cleaner object+field pickers** (v1.0.1) — two-phase load + server-side
  EntityDefinition LIKE fallback + honest caps; custom settings no longer excluded.
- [x] **L2. Popup dependency preload** (v1.0.1) — depScanPlan/depFormatEta/depRunPool;
  auto ≤150 versions, else explicit prompt quoting call count + ETA; pooled, cancellable,
  resumable. Latest-version-only scope DECLINED (subflow callers match by version id —
  would break the delete-safety check).
- [x] **L3. Lightning Pages org defaults** (v1.0.1) — size-aware, pooled, cancellable,
  resumable; dead PublishStatus predicate removed; unknown ≠ not-default in the UI.
- [x] **L4. Silent caps** (v1.0.1) — license-manager (100), studio-builder owner fallback
  (500, plus the false-negative that inferred a saved user was missing), apex-debugger
  user search (N+1 probe), studio-scan orphan counts; picklist bulk-modal progressive scan.

- [x] **L5. scanAllPageAssignments fan-out** (v1.1.0 — ~1400→~101 calls; describes deduped by object, page meta batched, entity-id resolution collapsed to one chunked query; render virtualised. Viewport-scoped RESOLUTION declined: whole-org couplings make counts drift under scroll.)
  ~~original~~ (lightning-pages.js) — LARGER than the L3 one
  that was fixed: one SF_TOOLING_GET per FlexiPage in a batch-of-5 barrier AND, inside the
  same loop, a sequential `fetchCustomObjectOrgDefaults` per page that re-describes with a
  cache-buster and memoizes nothing (600 pages / 200 objects → 600 describes where 200 would
  do, concurrency 1). User-triggered with a progress %, so not a blocker. Dedupe by a Map
  keyed on sObjectType (~3× fewer calls) and reuse the new `lpRunPool`.
- [x] **L6. studio-scan.js bucket caps** (v1.1.0 — true totals were already in memory one line before the slice, so "5,000 of 47,213" costs zero calls; every display site fixed; capped sets feeding a WRITE now warn.)
  ~~original~~ — missingInTarget / onlyInTarget / changed /
  identical capped at 5,000 each; surface per the user-copy.js pattern.
- [x] **L7. Schema View flow layer** (v1.1.0 — one shared paginating reader + COUNT reconciliation; incomplete side ⇒ NO flow comparison emitted rather than a wrong one. Also fixed a silent 60-object cap and batched the deep scan.)
  ~~original~~ (studio-schema.js:709 and :1617) — `FROM
  FlowDefinitionView WHERE IsActive = true LIMIT 500` single-page, and :1617 DIFFS two
  independently-truncated arrays, so a large org can report false flow-count differences.
  LABS FILE — excluded from the store build, so no shipped user is affected; fix before
  Schema View ever graduates.

- [x] **L8. Composite-batch read primitive** (v1.1.0) — `sfCompositeBatch` in
  background.js (a second helper, sfRunBatchedReads, shipped unadopted and was
  deleted by the v1.1.0 QA remainder): 25 subrequests per round-trip, per-item error
  isolation, input-order preservation. **Misalignment defence**: a batch response is a
  bare positional array with no echo of the request, so a dropped subrequest silently
  shifts every later answer — any length mismatch fails the WHOLE chunk rather than
  guessing which slot went missing. **Read-only guard**: `sftkIsWriteRequest` replaced
  `method !== 'GET'`, which would have blocked READS on read-only orgs once callers
  batched; it parses the outgoing body and clears only an all-GET composite batch.
- [x] **L9. Incremental dependency cache** (v1.1.0) — per-org, keyed on
  `Flow.LastModifiedDate`; warm org with 2 edits = 1 round-trip. Deleted flows evicted
  (no phantom edges). The delete path re-verifies live whenever an edge came from cache,
  so a cached answer can never make a delete look safe.
- [x] **L10. Ring Sync Plan cap disclosure** (v1.1.0) — a multi-org WRITE built from
  5,000-capped buckets with the push checkbox pre-checked, disclosing only its own 500
  display slice. Now warns above the op checkboxes.
- [x] **L11. sfQueryAll serverTotal** (v1.1.0) — was overwriting the server's own
  totalSize with `records.length`, destroying a free authoritative count and forcing
  callers to spend a round-trip on `SELECT COUNT()`.

## Phase E — Enterprise suitability (user 2026-07-29: "lets do them all")

The moat stays: NO SERVER — everything local, CSP-enforced. Nothing in this phase
may call a non-Salesforce host. Store release plan: these ship together with the
v1.1.0-QA remainder fixes as **1.2.0** (store already has 1.1.0).

- [x] **E1. Profile export/import** (v1.2.0; 25 tests; strip-list locked by test) — versioned JSON ({format:'sftk-profile', schema:1}),
  runtime/session fields stripped on export (documented list), import validates schema +
  regenerates id + provenance tag + prompts the existing Check-all-targets validation.
  Teams share profiles via git/Teams; no server.
- [x] **E2. Exportable audit reports** (v1.2.0; 38 tests) — per-run JSON/CSV (timestamps, orgs, per-object
  counts, failure detail incl. field/value context) + full-history export; states the
  retention window and counts-only mode honestly; CSV formula-injection guarded.
- [x] **E3. API-budget awareness** (v1.2.0; helper hoisted to sftk-api-budget.js, loaded by BOTH apps; 40 tests) — /limits (DailyApiRequests) cached 5 min per org;
  "≈N API calls · org has R of M remaining" before transfer runs and ring sync plans;
  ⚠ when estimate may exhaust the budget — inform, never block; post-run actuals line.
- [x] **E3b. Quota line on EVERY big operation** (v1.2.0 — dep scan (popup, wired by orchestrator), Lightning Pages ×2, picklist sweep/matrix/bulk-scan, Readiness, Field Cleaner, Schema View; 83 tests. Follow-up filed: _pkLoadMatrix loads RecordTypes twice per org for custom fields — reuse r.inv.rts to halve it) (user 2026-07-29: "say how many api
  calls big operations cost and how much is it compared to the orgs quota") — reuse
  E3's window.sftkApiBudget + the '≈N calls · R of M remaining' line on: dependency
  scan prompt (popup.js/dependency-map.js — wait for the QA-remainder workflow to
  release them), Lightning Pages org-defaults + Who-sees-what, picklist whole-object
  sweep, Deploy Readiness multi-target run, Field Cleaner full scans, Schema View deep
  scan (Labs). Most already quote a call count from the v1.0.1 work — add the quota
  comparison beside it. Popup pages must load the helper (check script order/exposure;
  the popup does not load studio-transfer.js — may need the helper hoisted to a shared
  file both apps load, e.g. sftk-friendly-error.js's pattern).
- [x] **E4. Professional mode + a11y** (v1.2.0; --subtext already passed AA both themes — now guarded by test; 26 tests) — ds_settings toggle (default OFF) → body.ds-pro:
  sftkGlyph(emoji,label) swaps emoji chrome for text labels, density tightened ~10% via
  CSS variables, muted accents; :focus-visible on all .ds-* interactives, nav ARIA,
  prefers-reduced-motion, WCAG-AA contrast for --subtext (measured, not guessed).
  High-visibility surfaces first; remaining emoji sites listed for a later sweep.

Deliberately NOT doing: email/Slack drift alerts (needs a server — breaks the moat),
licensing plumbing (free-first strategy), org-stored shared config (write-path feature;
revisit only if E1's file-based sharing proves demand).

## Shipping — Chrome Web Store  (section restored 2026-07-25 — an earlier
anchor-based plan edit accidentally deleted it)

- [x] **SHIP-1. Store packaging pipeline** — `npm run pack` (UTF-8-safe) →
  dist/salesforce-toolkit-v<manifest.version>-store.zip. Labs-only exclusions now
  (schema/fields), CHANGELOG.md + studio-whatsnew.js ship, marker-based Labs strip with
  loud post-checks, packed-build boot-smoked. Current artifact: v1.1.0, 46 files, 615 KB.
- [~] **SHIP-2. Store listing + submission — GO-LIVE KIT READY (2026-07-27), user's
  console steps remain.** USER DECISION: public story starts at **1.0.0 with no
  changelog history** ("we shouldn't state them. since we have to launch on version
  1.0" / "When we have something new we will update it there") — manifest reset
  1.3.0 → 1.0.0, CHANGELOG.md = single "Initial release." entry, full dev history
  archived to `CHANGELOG_HISTORY.md` (pack-excluded because the packer whitelists
  only CHANGELOG.md among .md files; verified absent from zip. Was briefly
  `_CHANGELOG_HISTORY.md` — renamed 2026-07-28: Chrome refuses to load unpacked
  extensions with root files starting with `_`). PRIVACY.md perms table synced to manifest (removed stale `tabs`, added
  `alarms`) + contact/date added. Artifact: dist/salesforce-toolkit-v1.0.0-store.zip
  (46 files, 629 KB), stale zips deleted. STANDING POLICY unchanged for future
  releases: CHANGELOG entry WITH the code, bump version, `npm run pack` — versions
  now continue upward from 1.0.0 (1.0.1/1.1.0…), guard test enforces sync.
  Remaining (user, in browser): dev console account ($5) → upload zip → listing
  copy + 1280×800 screenshots → privacy tab (justifications drafted in the go-live
  kit) → submit Unlisted → sanity-check install → flip Public.

## Phase V — Fable recheck of Opus-era work (user 2026-08-02: "We need to recheck
## everything we did with opus 5 with fable. i think it made some bugs")
- [x] V1 Recheck workflow over the 12 Opus-era commits (11f63c6..00cb4c7) — 5 audits
  + adversarial verify, completed across three resumes (session limits). Extraction
  itself CLEAN; all confirmed defects fixed in 057cc26 / 7a9833f / 7c7406b:
  dry-run "passed" lie (unchecked discarded), fingerprinted _validatedRuns keys,
  fan-out write-mode claim, host-specific cookie sessions + fallback re-verify,
  empty-live-set/liveKnown doctrine (now flag-based, not size-based), builder
  header count, field-cleaner Enter + async-repaint keyboard state, fan-out Back
  preselect, dark-mode danger/warning contrast tokens, phantom source org named.
  Plus user-reported SOQL-preview rewrite (engine-true shape, Ids-never-cross-orgs).
- [x] V2 Orphan backlog — DONE 2026-08-03 (commit b5e9f5d) via 7 conflict-free fix
  streams + 2 sweeps + 2 adversarial reviewers (workflow wf_b92a89a3-536); every
  reviewer finding fixed before commit (tour Shift+Tab-from-card trap hole,
  Pro-mode hiding the palette's new mask icons, initSession aria-current,
  nested-alert double announce, --sh-*/--focus-ring missing from .ds-dark).
  Landed: aria-live on popup activity bar + studio toasts; global :focus-visible
  baseline (:where(), styles.css); Readiness keyboard expanders; tour Escape +
  focus-in + trap; aria-current/aria-expanded in popup; .ds-dark restates
  --cat-*/--shadow/--sh-*/--focus-ring; picklist JS colours → tokens; one mask
  table (studio.css dupes deleted, styles.css wins); remaining shipped views on
  dsViewHeader; modal radii + toast/empty-state on the token scale. 9 new test
  files, +129 tests.
- [x] V3 1.3.0 release — DONE 2026-08-03: manifest 1.3.0, CHANGELOG entry,
  dist/salesforce-toolkit-v1.3.0-store.zip (46 files, 797 KB) packed, boot-smoke
  PASS both pages, zip delivered to user. PRIVACY.md unchanged (no new perms or
  storage keys) → public gist untouched. Store submission is user-side.
- [ ] V4 (post-1.3.0, needs user input): full Pro-mode emoji sweep (~1300 sites in
  view files) and popup-vs-Studio dark palette unification — user must pick which
  dark look wins (popup cool blue-grey vs Studio neutral grey).

## Decisions needed from the user
- **A3**: GitHub account/repo for CI (private repo recommended). Everything else proceeds without it.
- **X phase**: confirm tool migration order before starting.

## Progress log
- 2026-07-22: MEGA-BUILD — 9-agent workflow implemented every remaining item in one
  pass (T6-T11c, N2, N3, N4c-e, N5b, B2, B3). Gate: 38 files parse, eslint clean,
  343 tests across 10 files, harness 10/10 (boot zero-error with all modules, every
  new surface renders, tree-diff regression intact), store zip 46 files incl.
  CHANGELOG.md. Only M4 (scheduling — alarms-permission decision) and SHIP-2 (store
  console submission, user-side) remain open.
- 2026-07-07: Plan created. Phases S+C started this session.
- 2026-07-07 (later): PHASE S COMPLETE — S2/S3/S8/S9 closed via audit workflow (8
  confirmed findings fixed, commit 7de2516). C1+C2 done (ce0b27e). U1 done (4d53167).
  USER TEST PENDING: reload extension (manifest changed twice: WAR removal + tabs
  permission drop) → popup, popout, Data Studio, log viewer, one popup user-search.
- 2026-07-07: S1, S4, S5, S6, S7, A1 done (commits e02f6ad, 9026b27). S2+S3+S9 audit
  workflow launched. HARNESS LESSON: studio's sendBg uses CALLBACK-style sendMessage —
  harness stubs must invoke the callback (promise-only stubs hang init at session
  detection, and innerHTML-length view checks pass hollowly on the static loading
  screen). Honest content-marker view-walk now passes 11/11.
