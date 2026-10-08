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

## 1.0.0 — 2026-10-07

The first public release. Two tools in one extension, working through the Salesforce tabs
you already have open — no separate login, no server of ours in between. Anything that
changes something in Salesforce shows you what it is about to do and asks first; where a
tool reads the org back afterwards it says "verified", and where it can only report what
Salesforce answered, it says that instead.

### Toolkit (the popup)
- **Flows** — every flow with its versions; delete the versions you tick (with a backup
  offered first, paused interviews and calling flows checked), back up versions as a file,
  restore a backup as a new Draft.
- **Dependencies** — what calls what, "what uses…" a field or value, blast radius, call
  chains, an export. **⏻ Flow switches** turn record-triggered and scheduled flows off and
  back on at the version that was active. **⚙ API versions** move flows to a newer API
  version and verify what runs.
- **Debugger** — start a one-hour trace for a user, read the logs line by line with
  automation analysis, compare two, open one in its own tab.
- **Lightning Pages** — every record page and its assignments (org default, app default,
  app + record type + profile), add or remove them, deactivate, clone, and "who sees what".
- **Field Cleaner** — everything that references a field (flows, failed flow runs,
  permission sets, layouts, Lightning pages, reports), fixed automatically where it safely
  can be; **replace** the field with another one instead of removing it, copy its access
  and its stored values; deprecate first; delete when nothing is left.
- **Copy Permissions** — one user's profile, role, permission sets, groups and settings
  onto another, adding only.
- **Flow Access** — grant flows to permission sets in one action.

### Data Studio
- **Connected Orgs** — the orgs open in Chrome; rename, lock writes, or treat an org as
  production everywhere.
- **Data Deployment** — a saved deployment (a root object, the objects under it, how a
  record is recognised in the other org) opens on the 🚀 Deploy page: both orgs are read,
  every record sorted into insert / changed / only in target / synced / needs a decision,
  nothing ticked for you. A whole tree goes in one run, parents first; lookups connect;
  record-triggered flows, validation rules and duplicate rules can be paused or bypassed
  for the run (and what cannot be bypassed is said); ↻ Retry failed; the 🪪 identity field
  makes matching exact across orgs.
- **All open orgs** — every deployment against every open org at a glance.
- **History** — every run with its counts, exports as CSV or JSON, and ↩ Roll back, which
  deletes what a run created and restores what it changed, then verifies.
- **Org Compare** — record counts of any objects between two orgs, by name, external id or
  a field you choose.
- **Org health** — one card per finding, each with its API cost first.

### Fixed before the first cut (hand tests, 2026-10-07)
- Lightning Pages: "Finish the check" ran again and showed the same sentence, which read as a
  dead button. The strip now says it ran again, names the objects that cannot be described
  and why, and the button reads "Try again".
- Field Cleaner: the group button for flows offers both ways — "Remove from all N flows ·
  flows keep running" and "Delete versions · all N flows off" — like the cards do.
- Field Cleaner History: a deleted flow version is named ("SFTK FC Test Flow v17 (Active)
  deleted") and a deleted run by its label and state, not by a Salesforce id.
- Data Deployment: picking Hard delete says at once, next to the mode and in the
  confirmation, that ↩ Roll back cannot bring hard-deleted records back.
- Dependencies: every row shows who created the version and who last modified it, as two
  aligned lines ("created 2026-09-26 by …" / "modified …").
- The licence page is readable in dark mode; the EULA names the tools that ship.
- All open orgs: one 🔎 Scan for the page — every deployment against every open org, one
  after the other — instead of a button per column and one per cell. A cell keeps ⚖.
- Every dialog has one shape now, on both pages: the sentence as the title with facts chips,
  the stakes in a card coloured by severity (red permanent, amber a recorded write, blue
  reversible), a real list with a filter when it is long, and a pinned bar that keeps the
  acknowledgement or the typed word beside Cancel and Go — never scrolled away. Production is
  a red band in the same dialog. The gates, results and questions around the writes (paused
  interviews, subflow checks, active flows, backups, restores, rename / remove an org, clear
  history, exports, delete a deployment, the production step) share it.

### Known limits
- A Toolkit tool's changes are listed in that tool's History; Data Studio's History lists
  deployments and rollbacks.
- A rollback cannot undo automation that already ran; hard-deleted records cannot come
  back; a Draft flow rewritten in place by ⚙ API versions has no previous copy to restore.
- Bulk API 2.0 cannot bypass duplicate rules, and no API passes a rule set to Block.

