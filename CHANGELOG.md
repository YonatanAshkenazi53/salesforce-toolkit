# What's New — Admin Toolkit for Salesforce

Everything that ships, newest first, in plain language.

This file is the single source of truth for release notes: the in-app **What's New**
page (Data Studio nav + Toolkit home) renders it directly, and the Chrome Web Store
listing's "what's new" text is copied from the newest section. Write the notes here,
with the code. The newest entry's version must always match `manifest.json` — the
test suite enforces it.

The public story starts at 1.0.0. Internal development history from before launch
lives in `CHANGELOG_HISTORY.md` (repo only, never shipped — the packer only ships
`CHANGELOG.md` itself; no leading underscore, Chrome refuses to load unpacked
extensions containing root files that start with `_`).

## 1.3.0 — 2026-08-13

The Sync Ring grows into a real multi-org sync tool: attached files are now part
of what "in sync" means, one source of truth now governs every deployment
automatically (with a clear warning and a one-click way back whenever it moves),
and every screen that shows sync status updates itself the moment fresher
information exists — no more stale checkmarks after a run.

### Added
- **Attached files are now part of staying in sync.** Turn on Files for an
  object and every scan compares attachments too — matching records with
  different files show exactly which files are missing, on which record, with
  a checkbox next to each one and a one-click "Move selected" that copies them
  straight across without running a full deploy. Files already on the target
  are never touched or duplicated; a second move is always a no-op. Records
  that were already in sync before you turned Files on get checked too, matched
  by their existing key — not just records from a fresh transfer.
- **A real "Synced" view.** Reconcile grows a fourth column alongside Insert /
  Changed / In target only: every record verified matching, with links to both
  copies, an "open as table" view showing live field values side by side, and
  (when Files is on) exactly which of those synced records still need a file.
- **Match-key grading, automatically.** Opening the key suggestions panel now
  grades the top candidates against live data in your source *and every
  target* — populated%, duplicate%, and a plain-language explanation of how
  the score is calculated — so the best key for a cross-org match is a
  measurement, not a guess.
- **Older run history moves to on-PC storage instead of disappearing.** History
  used to silently drop runs once you had more than 100 — now the oldest
  runs move to local browser storage automatically, stay listed (with an
  "archived" tag), and are included in a full export. Nothing is ever lost to
  the cap again.
- **Choose sync vs. async for large deploys, Inspector-style.** A new Engine
  control on the Run page lets you force every write through the fast async
  path (or force it off), and set the exact batch size per request — useful
  when a target org's automation needs smaller batches to avoid timing out.

### Changed
- **The source of truth is now dynamic, with a safety net.** When you change
  which org is the source of truth, every deployment that hasn't been
  explicitly pinned to a different org follows automatically — with a clear
  notice on any affected deployment ("this now flows from X, was Y") and a
  one-click way to keep the old source instead, or restore the previous
  source of truth entirely. Deployments you *have* pinned to a specific org
  say so plainly, instead of just looking out of sync.
- **Reconcile now asks which target, when there's more than one.** Opening
  Reconcile on a deployment with several targets shows each one's last-known
  status and lets you pick — instead of guessing which pair you're about to
  fix.
- **True black for OLED screens, everywhere.** The OLED toggle now reaches
  every surface — status badges, warning dialogs, the Apex log panel, and the
  standalone log viewer — instead of leaving a few components in regular dark
  mode.
- **Clearer Apex log viewer.** Insert/Update/Delete operations in a log are
  now color-coded so a delete can't hide in a wall of similar-looking lines,
  and the two download buttons are labeled for what they actually contain
  (the readable report vs. the raw log file) instead of both saying "Download."

### Fixed
- **Sync status now updates itself everywhere, immediately.** Running a
  transfer, moving a file, or comparing environments in Tree Diff used to
  leave the Sync Ring and other screens showing stale counts until you
  manually rescanned — every one of those now refreshes the moment fresher
  information exists, including a ring cell you just repaired by hand.
- **Field Cleaner now says when a dependency list might be incomplete**,
  instead of quietly showing a partial count as if it were the whole picture
  (Salesforce's own dependency index caps out on very large objects).
- Records with rich-text fields containing images copied from another org now
  come with a note explaining the image won't display until it's re-uploaded
  in the target — the text field copies correctly, but the image file itself
  can't cross orgs automatically.

## 1.2.0 — 2026-08-03

Built for teams and big orgs — and built on trust. Everything here went
through a full independent re-verification pass (dozens of audit runs over
the code), and everything found was fixed. Share your work, prove what ran,
know what an operation costs before you start it, and validate multi-org
deploys before a single record is written. Still no server — everything runs
in your browser, and nothing ever leaves it.

### Added
- **Share deployment profiles as files.** Export any deployment profile to JSON and a
  teammate imports it — field mappings, per-target overrides, and owner-matching rules
  intact. Machine-local state (scan results, learned match pairs, schedules) is stripped
  on export and the import says exactly what was removed. Imported profiles carry a
  provenance note and prompt a schema check against *your* orgs before first use.
- **Audit reports.** Every run in History can now be exported as JSON or CSV — timestamps,
  orgs, per-record outcomes, and failure details including the exact values that were
  rejected. A full-history export covers everything still retained (and says when your
  retention window means older runs are gone). CSVs are safe to open in Excel — cells
  that look like formulas are neutralized, and the export says so.
- **Every big operation now shows its price.** Before a deploy, sync plan, dependency
  scan, page audit, picklist sweep, readiness check, or field scan runs, you'll see
  "≈N API calls · org has R of M daily calls remaining" — measured against your org's
  real quota. If a run could exhaust the day's budget it warns you first (it never
  blocks), and afterwards the log shows what it actually used. Multi-org operations
  show each org's own meter, because each org has its own pool.
- **Professional mode.** A toggle in Data Studio settings that swaps the emoji labels
  for plain text, tightens spacing, and mutes the palette — for demos, screenshots, and
  anyone who prefers a quieter tool. Off by default; your current look is unchanged.
- **Dry run for multi-org deploys.** Before a fan-out writes anything, validate
  every ticked target in one pass — required fields, lookups, record types,
  restricted picklists, field lengths — with an honest three-state verdict per
  org: clean, issues found, or *could not check* (which is never called clean).
  The fan-out dialog also now states exactly what a run will do — which records,
  from which org, write mode, owner handling — before you start it.
- **Keyboard and screen-reader support.** Status updates and toasts are
  announced to assistive tech, every control shows a visible keyboard focus,
  Deploy Readiness result cards open from the keyboard, the welcome tour
  closes with Escape and keeps focus inside its card, screen readers get
  proper navigation landmarks, and animations respect your system's
  reduced-motion setting.

### Changed
- **A calmer, more consistent look.** One design system across the Toolkit and
  Data Studio: consistent buttons and spacing, shared view headers with live
  record counts, and crisp monochrome icons replacing emoji across the popup
  toolbar and Apex Debugger. Dark mode got a real contrast pass — destructive
  and warning actions are now readable on dark backgrounds.
- **One dark mode, not two.** The Data Studio's dark theme now uses the same
  cool blue-grey palette as the Toolkit popup — previously the two halves of
  the extension went dark into two different colour worlds.
- **The SOQL preview tells the truth.** The Deployment Builder's preview now
  shows the queries the engine actually runs — one per object, children scoped
  to their parent records — and explains that record Ids never cross orgs:
  lookups resolve through your match fields, upsert through your External ID.
- **Source of truth, everywhere.** Your ring's source org is preselected and
  locked where it must be, named on every screen that acts on it, and kept out
  of target lists — an org can never be its own target.
- **The popout window is gone.** The Toolkit now opens as a regular browser
  tab instead — the popout was unreliable and added nothing.

### Fixed
- **A dry run can no longer say "passed" when it couldn't check everything.**
  If part of a target was unreadable the result now says so and the ✓ validated
  marker is withheld — and that marker now vouches only for the exact profile,
  filters and write mode it actually validated.
- **Org detection got honest.** An org you logged out of no longer shows as
  open borrowing a sibling sandbox's session; and when the extension doesn't
  yet know which orgs are open, screens say nothing instead of guessing
  "not open" — previously a slow session check could disable every target in
  a fan-out.
- **Field Cleaner noise and keyboard fixes.** Salesforce's internal shadow
  objects (Feed/Share/History/ChangeEvent and `__MISSING LABEL__` rows) are
  hidden by default with an honest count and a "Show them" toggle. Enter can
  no longer silently replace the object you picked, and search results landing
  mid-navigation no longer move your position in the list.
- The Deployment Builder's header count now updates as you add and remove
  objects, the fan-out "Back" button keeps your target selection, removing an
  org also removes it from the sync ring instead of leaving a phantom source,
  and a batch of smaller fixes from the verification pass.

## 1.1.0 — 2026-07-29

Large orgs got dramatically faster. 1.0.1 stopped the Toolkit from doing work you
hadn't asked for; this release makes the work you *do* ask for cost a fraction of
what it used to.

### Changed
- **Scans are up to 25× fewer network round-trips.** Reading a thousand things used
  to mean a thousand separate requests to Salesforce, and the waiting was almost all
  overhead rather than actual work. Requests are now sent in batches of up to 25. In a
  1,600-flow org the dependency scan drops from 1,600 round-trips to about 160.
- **The dependency scan remembers what it already knows.** Previously every single
  Toolkit open rescanned the whole org from scratch. Now the map is saved per org, and
  reopening only fetches the flows that actually changed since last time — typically a
  handful, so a scan that took minutes finishes in about one request. The screen always
  tells you when the data was built and what was refreshed, so cached results are never
  passed off as freshly checked. Deleting a flow still verifies that flow live, so a
  cached answer can never make a delete look safe when it isn't.
- **"Who sees what?" in Lightning Pages** was re-describing the same object once per
  page — roughly 1,400 requests for 600 pages. It now asks about each object once and
  batches the rest: about 100 requests for the same work, and the page list itself
  renders smoothly no matter how many pages your org has.
- **Schema View** (Labs) compared only the first 500 active flows per org, and diffed
  two separately-truncated lists — which could invent flow differences that didn't
  exist. It now reads every flow and, if either side is incomplete, declines to show a
  comparison rather than show a wrong one.

### Fixed
- **Scan results no longer report a floor as a total.** Comparison buckets are capped at
  5,000 records; a 47,213-record difference displayed as "5,000". Every count now reads
  "5,000 of 47,213 shown", measured rather than estimated.
- **The multi-org Sync Plan now warns before writing from a capped list.** It disclosed
  its own display limit while staying silent about the larger one underneath — and the
  push checkbox is on by default, so "Add 5,000 of 5,000" could quietly leave tens of
  thousands of records unwritten.

## 1.0.1 — 2026-07-29

Everything here comes from testing against a large production org — the kind with
thousands of metadata items and several managed packages. Small orgs behave exactly
as before.

### Fixed
- **Field Cleaner now finds every object**, including managed-package ones. The object
  list was capped at 2,000 and cut off alphabetically, and because search only looked at
  what had already loaded, an object past the cutoff couldn't be found by typing at all —
  it looked like it didn't exist. The list now loads in full, and if your org is large
  enough that Salesforce still holds some back, typing 2+ characters searches the org
  directly. The picker also tells you when a list is incomplete or when matches are
  hidden, instead of quietly showing you part of the picture. Custom settings are now
  included too, and the field list no longer caps at 1,000.
- **Opening the Toolkit no longer takes minutes in a large org.** It was fetching the
  metadata of every single flow version before you'd asked for anything. Flows now load
  immediately, and in orgs with many flows the dependency scan waits for you to ask —
  telling you up front how many calls it needs and roughly how long it'll take. The scan
  itself is faster, can be stopped, and resumes where it left off. Anything that depends
  on scan data says so plainly rather than showing a blank answer.
- **Lightning Pages** did the same thing on tab open — one call per page, plus a
  one-at-a-time describe for every object — landing after the view already said it was
  done. Now it's size-aware, shows what it's doing while it runs, and can be stopped. Pages
  whose org-default status hasn't been checked show a clear "?" instead of a blank that
  looked like a real answer.
- **Lists no longer pretend to be complete.** Several places silently capped their
  results: the License Manager user list (100), the deployment builder's owner-fallback
  users (500), the debugger's user search (10), and orphan-record counts (2,000). Each now
  states its limit where you can see it. The builder issue was the most consequential —
  a saved fallback user who happened to fall outside the first 500 was treated as missing,
  which could quietly change how owners were assigned on a deployment.

## 1.0.0 — 2026-07-27

- Initial release.
