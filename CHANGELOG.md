# What's New — Salesforce Toolkit

Everything that shipped, newest first, in plain language.

This file is the single source of truth for release notes: the in-app **What's New**
page (Data Studio nav + Toolkit home) renders it directly, and the Chrome Web Store
listing text is copied from the newest section. Write the notes here, with the code.

Versions below `1.0.0` are development milestones grouped by the day they landed —
they were never published to the store as separate releases.

## 1.2.0 — 2026-07-26

### Added
- **Trace hotkey**: press **Ctrl+Shift+L** on any Salesforce tab to start a 60-minute
  debug trace for *you* in that org — no popup needed. The extension icon shows **REC**
  while it runs; press the shortcut again (from anywhere) to stop. Rebind the key —
  including to Ctrl+D — at chrome://extensions/shortcuts.
- **Debugger QA pass**: six confirmed bugs fixed, including traces that could silently
  fail while looking live, a stopped trace that kept running in the org, and live
  polling missing exactly the slow transactions you were debugging.
- **What's New** moved out of the feature lists into a small 🎉 in both top bars.
- **Key testing across all targets**: 🧪 Test this key now grades every target org
  separately, and the Matching panel shows which field names the key uses per target.
- **Sync plan data fix**: deactivating a drifted value now offers the record fix
  (move/clear) inline, per org, before the picklist change applies.

### Notes
- The search toggles (Aa · .* · W) in the debugger now explain themselves with
  real examples on hover.

## 1.1.0 — 2026-07-25

### Added
- **Scheduled drift checks** (Sync Ring → ⚙ Ring configuration): Chrome can now
  check your ring in the background — hourly, every 6 hours, or daily — and put a
  red badge on the extension icon when record counts drift between the source of
  truth and any target. Opening the Sync Ring shows what drifted and clears the
  badge. Read-only by design: it never writes to any org, and it tells you exactly
  which orgs it could not check (not signed in, hand-picked record sets).
- **▶ Check now** button to run the same probe on demand.

### Added (picklists)
- **Data fix inside the multi-org sync plan**: when syncing values from the source
  would deactivate a value that records still hold, the plan row now offers the fix
  right there — move those records to a value that stays active, or clear the field —
  and won't let the deactivation be ticked without one. Fixes run first, per org,
  then the picklist change; the result line reports how many records were moved.

### Notes
- A count probe catches added/removed records, not value changes — run a 🔎 scan
  for those. This release adds the `alarms` permission to support scheduling.

## 1.0.0 — 2026-07-25

### Added
- **Big pushes now use the Bulk API.** Transfers above the size threshold switch to
  Bulk API 2.0 ingest automatically instead of grinding through record-by-record
  REST calls. The production-org guard, read-only orgs and every other safety check
  apply to bulk runs exactly as they do to normal ones — nothing gets a free pass.
- **Flow backups are deployable artifacts.** A flow backup is now a Metadata-API XML
  zip you can deploy straight back into an org (or into a *different* org), not a
  JSON blob that only this extension understood.
- **The drift compare names each org's exact field type.** Every value cell says what
  the field actually is *in that org* — `Number(18,2)`, `Text(255)`, `Lookup(Account)`,
  `Picklist` — and a **⚠ type differs** chip appears when the two orgs define the same
  field differently, even when the values happen to match today.
- **This page.** What's New now lives inside the app: Data Studio's sidebar and the
  Toolkit home page both open it, and the sidebar entry carries a dot until you've
  read the newest version.

### Changed
- **The Debugger's user box suggests users the moment you click it**, instead of
  making you type two characters before anything appears.

### Known issues
- **Store builds don't ship this changelog yet.** The release packager
  (`scripts/pack_store.py`) only packs `.js`, `.html`, `.css`, `.png` and
  `manifest.json`, so in a Chrome Web Store build this page reports that
  `CHANGELOG.md` could not be loaded instead of showing notes. Unpacked / developer
  installs render it normally.
- **Schema View and Field Audit are Labs previews** — early, incomplete, and stripped
  out of store builds entirely. If you don't see them in the sidebar, that's why.
- **History keeps the last 100 runs** and prunes anything older than the retention
  window (30 days by default, in Settings).
- **Every feature needs the org open in a Chrome tab.** The toolkit borrows your live
  browser session and never stores credentials, so an org you're not signed into is
  an org it can't reach.

## 0.9.0 — 2026-07-22

### Added
- **A deployment has TARGETS, plural.** The old "source org → target org" pair is gone.
  A deployment now declares a set of targets and runs against all of them.
- **Targets follow the Sync Ring unless you pin them.** By default a deployment tracks
  whatever orgs are in the ring, so adding an org to the ring grows every deployment
  that follows it. Pin a specific set in the builder when you want an exception.
- **Field Mapping went multi-target.** Pick which target you're validating against, and
  cross-target badges call out fields that resolve in some orgs but not others.
- **Per-target field-mapping overrides.** When one org renamed a field, override the
  mapping for that org alone instead of forking the whole deployment. `null` excludes
  the field for that target only.
- **🧪 Check all targets** in the Profile Builder — the multi-org answer to "will this
  actually land?", run against every target at once.
- **Deploy Readiness graduated out of Labs.** Rebuilt ring-first: it checks the source
  of truth against every ring target, attributes each result to the org it came from,
  and never reports a silent pass when a check couldn't run.
- **Chrome Web Store packaging.** A one-command Labs-free release zip, plus graceful
  degradation so a view whose code isn't in the build falls back to home instead of
  breaking the app.

### Fixed
- **The field-mapping cross-check now says which targets it ACTUALLY verified.** It used
  to imply full coverage; when an org can't be reached it now names the ones it skipped.
- **Org pick lists are readable again.** Builder targets, the Picklist Manager compare
  list and Readiness targets all shared one unstyled inline label that ran the org names
  together on a single line. They render as separated chip rows now.
- **Modals scroll.** Long dialogs were cut off at the bottom of the window with no way
  to reach the buttons.
- **The Sync plan speaks plainly** — the summary says what will be created, updated and
  skipped in words, not internal operation codes.

## 0.8.0 — 2026-07-18

### Added
- **A source of truth, everywhere.** One org is the 👑 source; every compare, scan and
  sync starts from it. It stopped being an item in the compare pick-list — it's a given,
  not a choice you re-make on every screen.
- **The Sync plan lets you choose the records you're about to push**, instead of an
  all-or-nothing run, and the object picker keeps the plan scoped to what you care about.
- **Picklist Manager** (renamed from the old picklist view) now shows **record types in
  the compare matrix**, and opens in *Compare across orgs* mode by default with your
  ring orgs already ticked.
- **Flow dependencies: 🧨 blast radius and "what uses this?"** — a forward view of
  everything a flow drags along, and a reverse lookup of everything that references it.

### Changed
- **Weak Inspect views moved to Labs.** Schema View and Field Audit were shipping as if
  finished; they're now labelled as early previews until they earn their way back.

### Fixed
- **The Debugger's A- / A / A+ buttons no longer collapse the log.** They were wired with
  an inline `onclick`, which the extension's Content Security Policy silently blocks —
  so the click fell through to the row and folded everything up.

## 0.7.0 — 2026-07-17

### Added
- **Sync Ring** — a dashboard for up to five orgs at once, with the source-of-truth chip
  replacing the old two-org pair bar.
- **Sync Plan** — every secondary org's operations on one page, so you can see the whole
  fan-out before anything runs.
- **Picklist sync from a source org** — push picklist values *and* record-type
  assignments from the source into the orgs that are missing them.
- **Tree Diff** — record-tree differences across environments, with suggested operations
  for closing each gap.
- **Smart matching.** Composite and normalized match keys, per-node configuration, and a
  key-quality analyzer that tells you when a key is too weak to trust.
- **Match memory + manual Match Review** — matches survive renames, and you can correct
  a bad match by hand instead of fighting the heuristic.
- **🎯 A match-accuracy grade on every scan**, shown where you're working rather than
  buried in a report.

### Fixed
- **Scans flow FROM the ring's source of truth**, not from the pair the deployment was
  originally created with.
- **Flow pushes default to the ring source too** — the source org wasn't preselected.
- **The ring config panel stopped snapping shut** after every org you ticked, and the
  double radio glyph is gone.

## 0.6.0 — 2026-07-13

### Added
- **Fan-out runner** — one deployment, N target orgs, one run.
- **Multi-org Picklist & Record-Type management** — compare and manage values across
  every connected org.
- **Reconcile v2** — safer child and grandchild sync, with the relationship structure
  respected instead of flattened.
- **Hash routing** (`#/compare` and friends) so Back, Forward, refresh and shared links
  all work, plus a get-started checklist and a sync-status strip on the landing page.
- **Ctrl+K command palette in the Toolkit popup** — the Studio had one; the popup, with
  more tools in it, didn't.
- **Cross-links between the two apps**, persisted view state, and CSV export from Org
  Compare.

### Changed
- **The background worker validates its own messages.** Typed message contracts fail
  fast and loudly on a missing field instead of half-running and reporting success.

## 0.5.0 — 2026-07-10

### Added
- **Picklist Manager** — values, live usage counts, and safe data fixes before you
  deactivate anything.
- **Field Audit** — ranks every custom field on an object by how safely it could be
  deleted: fill rate, who can see it, last write, and dependency counts on demand.
- **Field Cleaner snapshots** — a metadata snapshot before every fix, with one-click
  restore if the fix was wrong.
- **Apex Debugger deep analysis** — flow execution paths, log comparison, and governor
  limit metering with a purge control.
- **One shared destructive-confirm dialog** across the popup, so "are you sure?" means
  the same thing everywhere.

### Fixed
- **"Back to Toolkit" focuses the Toolkit you came from** instead of opening a new
  full-screen popout every time.
- **Twenty-odd popup state bugs** from a UX audit: empty states, stuck spinners, buttons
  that stayed disabled after a failure, and results that outlived the org they came from.
