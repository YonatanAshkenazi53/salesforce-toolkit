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

- [ ] **S1. Manifest hardening**
  - Remove the `web_accessible_resources` block (pages open via `chrome.tabs.create`, which
    needs no WAR). Verify popup popout, Data Studio, and apex-log-viewer all still open.
  - Add `content_security_policy.extension_pages` with `connect-src` allowlist:
    `'self' https://*.salesforce.com https://*.force.com https://*.salesforce-setup.com`
    (verify against every fetch host in background.js first). Browser then *enforces* "Local only".
- [ ] **S2. SOQL injection audit** — ~34 `WHERE X='${v}'` interpolations lack visible escaping.
  Audit every site (workflow fan-out), route string values through `soqlStrLit()` (studio-core)
  or a shared equivalent in background/popup modules. Add unit tests for the escaper.
- [ ] **S3. XSS audit + Trusted Types enforcement** — grep-audit unescaped `${…}` into innerHTML
  sinks (org labels, record names, API errors are org-controlled). Fix gaps with `esc()`.
  Then add `require-trusted-types-for 'script'` to the extension-pages CSP so future gaps
  throw instead of executing (only after the audit passes — enforcement first would break the app).
- [ ] **S4. Per-org read-only toggle** — Connected Orgs row toggle → `_orgs[url].readOnly`;
  background dispatcher blocks all write message types (create/update/delete/deploy/patch)
  for that org; UI badge on org chips; clear error message when blocked.
- [ ] **S5. Data-at-rest retention** — settings: auto-purge history > N days (default 30);
  "store counts only" mode (drop per-record ids/labels from new history); one-click
  "Clear all cached org data" (extend existing history-clear to scans/caches/activity log).
- [ ] **S6. sid-storage verification** — prove sids never reach `chrome.storage.local`
  (grep every `.set(` payload); document the finding in SECURITY notes inside PRIVACY.md.
- [ ] **S7. PRIVACY.md** — state the "Local only" promise concretely: what is stored
  (chrome.storage.local inventory), what never leaves the browser, retention controls, the
  CSP enforcement from S1. Link it from the README if one exists.
- [ ] **S8. sfProxyFetch least-privilege review** — verify the injected function is a fixed
  closure (no string eval / interpolated code); log proxied calls distinctly in the debug
  panel; gate proxying behind a visible one-time consent per org.
- [ ] **S9. Re-run the security deep audit** (the original was cut off) — workflow over
  background.js + both apps; fix what it finds or file it here.

## Phase C — Cleanup & popup quick wins

- [ ] **C1. Orphaned modules** — remove `conflict-scanner.js` `<script>` from popup.html
  (loaded but unreachable — no tab reaches it); delete `conflict-scanner.js` and
  `record-copy.js` from disk (git history preserves them); update manifest WAR list if S1
  hasn't already removed it; memory Tab Structure section update.
- [ ] **C2. Stale docs** — DATA_STUDIO_PROJECT_BRIEF.txt §15 (claims no upsert/dry-run; both
  exist), OwnerId line; fix misleading legacy banners in studio-history.js ("SCHEDULE") and
  studio-readiness.js ("ADD ORG MODAL").
- [ ] **C3. Unified loading/empty/error states** — sweep every popup module: `sftkCat()`/
  `sftkCatSm()` loaders + honest empty states + `_explainDeleteError`-style translation
  everywhere (no bare spinners, no raw API errors).
- [ ] **C4. Shared destructive-confirm modal** — one component: names every item, states
  reversibility (Recycle Bin vs permanent), checkbox for permanent ops, undo path linked in
  the success toast (e.g. Flow Restore). Adopt in flow delete, version purge, field delete.
- [ ] **C5. Cross-links between tools** — Field Cleaner flow-dependency → Flow Access;
  Apex Debugger user → Copy Permissions; "open in X" affordances where output feeds input.
- [ ] **C6. Popup Ctrl+K palette + home grid descriptions** — reuse the Studio palette code;
  one-line descriptions under each tool on the home grid.
- [ ] **C7. Re-run the popup UX deep audit** (original was cut off) — workflow over popup
  modules; fold findings into C3–C6 or file here.

## Phase U — Studio UX polish

- [ ] **U1. friendlyError()** — central mapper: raw errorCode → {message, hint, action};
  raw string behind "Copy details". Wire into toasts, compare rows, run logs, banners.
- [ ] **U2. Jargon rename (complete it)** — one noun set: Deployment / Run / Sync check;
  "drift" → "changed"; "extras" → "only in target". String-level sweep across studio files
  (UI strings only — do NOT rename functions/state; keep diff reviewable).
- [ ] **U3. Get-started checklist** — dismissible, computed from real state: connect two orgs
  → compare → create deployment → dry run → run; each step deep-links and self-checks.
- [ ] **U4. Persist Readiness/Schema view state** — mirror the `_orgCompareState` pattern;
  persist lightweight setup (org choices, toggles) to storage; "from N min ago — Re-run"
  banner for cached results.
- [ ] **U5. Sync status strip on Connected Orgs** — aggregate fresh `lastScan`s into per-pair
  tiles ("Prod → UAT · 12 missing · 3 changed · 2h ago") linking into Reconcile. No new API calls.
- [ ] **U6. Hash routing** — `#/view/:arg` routes; central `navigate()` replaces the sidebar-
  highlight loops; back/forward/F5/deep-links work. (Respect the classic-script load-order rule.)
- [ ] **U7. Org Compare: summary banner + CSV export + history entry** — headline strip,
  client-side CSV download, `{kind:'compare'}` history entries.

## Phase A — Architecture completion

- [ ] **A1. Shared org-identity lib** — `sftk-org-identity.js` (window + globalThis attach,
  same pattern as sftk-zip.js): `_orgKey`, `orgLabel`, `orgOptionLabel`. Loaded by popup.html
  + studio.html; background.js gets it via `importScripts` (classic SW) — verify background
  has no raw-URL org comparisons left afterwards.
- [ ] **A2. Typed message contracts** — MESSAGES manifest (name → required fields) validated
  at the background dispatcher; JSDoc typedefs for editor autocomplete. Reject-with-clear-error
  on missing fields instead of silent undefined.
- [ ] **A3. CI** — REQUIRES USER: create a GitHub repo (private) + push. Then Actions workflow
  running `npm run verify` on every push. Add the S1 "no foreign fetch hosts" grep gate here.
- [ ] **A4. eslint no-undef** — generate per-page-group globals lists (script scans top-level
  declarations of each file group) and enable no-undef. Catches typo'd cross-file calls statically.

## Phase R — Reconcile v2

- [ ] **R1. Match-key collision detection** — child scan detects duplicate match-key values,
  excludes those rows by default, prompts for a better match field.
- [ ] **R2. Master-detail guardrails** — detect MD relationship fields (describe:
  `relationshipOrder`/`cascadeDelete`); disable child-first + relink with the reason in the UI;
  block orphaning deletes.
- [ ] **R3. Orphan tagging** — after partial runs, tag null-link child rows "possible orphan"
  in target-only bucket (protect from Delete-all); Relink re-attaches them.
- [ ] **R4. Actionable child drift/extras** — extend `_recChildSel` with overwrite/del sets;
  same guards as root (typed prod confirm, recycle vs hard).
- [ ] **R5. Grandchildren** — extend scan scoping + selection UX one level at a time; the
  engine already handles deep trees. Label depth limits clearly in the UI.

## Phase X — App-shell convergence (last: biggest, benefits from all above)

- [ ] **X1–X4. Migrate heavyweight popup tools into the Data Studio shell** as sidebar
  sections, one tool per commit: Field Cleaner → Flow Access → Apex Debugger → Copy
  Permissions. The popup becomes a fast launcher + current-org quick actions.
  Prereqs: A1 (shared org identity), C4 (shared confirm), U1 (friendlyError).
- [ ] **X5. Unify theming** — one dark-mode key + one palette shared by launcher and Studio.

## Decisions needed from the user
- **A3**: GitHub account/repo for CI (private repo recommended). Everything else proceeds without it.
- **X phase**: confirm tool migration order before starting.

## Progress log
- 2026-07-07: Plan created. Phases S+C started this session.
