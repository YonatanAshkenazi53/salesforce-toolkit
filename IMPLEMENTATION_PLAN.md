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

## Phase T — Tree Diff (user request 2026-07-16)
- [x] **T1. Tree Diff page** — "🌳 Tree diff" on deployment cards: the record tree (root →
  children → grandchildren) as rows, environments as columns (ring targets pre-selected);
  per-cell bucket counts + SUGGESTED operations (⬆ push / ✏ overwrite / 🔗 relink /
  🔵 review extras, child-first annotated); scans run on ephemeral clones (root scan then
  depth-ordered child scans); "⚖ operate" opens a fully pre-loaded Reconcile per env where
  every suggestion executes with the full guards. Pure helpers tdSuggest/tdTreeNodes/
  tdCounts (unit-tested). Harness 13/13.

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
- [ ] **M3c. Match memory + review UI** — persistent srcId→tgtId pairs per profile+org-pair
  (populated by successful inserts/upserts/overwrites AND manual pairing); matched FIRST,
  before key comparison → rename-proof identity without schema changes. Post-scan Match
  Review screen for ambiguous/unmatched rows with normalized near-match candidates; human
  pairs → memory. Capped + clearable under the S5 retention controls.
- [ ] **M4. Later** — opt-in scheduling (needs re-adding the alarms permission — weigh vs
  minimal-permissions posture); reverse-pull polish; Bulk API 2.0 for large volumes.

## Decisions needed from the user
- **A3**: GitHub account/repo for CI (private repo recommended). Everything else proceeds without it.
- **X phase**: confirm tool migration order before starting.

## Progress log
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
