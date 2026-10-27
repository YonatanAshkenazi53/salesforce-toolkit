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

### Open source
- Data Deployment › Needs a decision: a name with copies on either side offers 🔀 Merge first — the copies in the source, the copies in the target, or both sides one after the other with one re-read at the end. After the merge the name is unique and the pair lands under 🟢 Synced when its values are equal. Different records that share a name are still told apart by hand, below the merge offer.
- The extension is **open source under the Apache License 2.0** (the LICENSE file, and the Licence
  page inside the app). The agreement you accept on the first start is version 3: it says so, and
  keeps the one thing that did not change — what you do to your orgs is your responsibility.

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

- **✏ Values on the Deploy page.** Every Insert and Changed row opens the whole record: each writable field with the source's value (and the target's, on a Changed row) and a box for the value it is written with instead — one record, or one value for every ticked record of the list. Lookups are picked from the target org in the same dialog. Typed values are saved on the deployment per target org and written by ▶ Deploy; the run log and History say how many. A field the PII policy covers keeps its masked value.
- **🧾 Activity, in both top bars.** One feed of everything the Toolkit and Data Studio did, and when — grouped by day, then by the tool or deployment, with a search and an app filter. Undo, roll back and reports stay where each change lives; every group links there.
- **History, easier to use.** Each run says in one sentence what it did and what failed, and its actions sit in labelled groups: fix (continue, retry), undo (roll back, which records), open (deploy, profile), report.
- **🔒 Masked fields can be unmasked.** The "N masked" chip on an object opens the list of its masked fields, says in plain words what masking does (a pseudonym or empty — never the real value, the source untouched), and unmasks one field or all of them.
- **Parents synced, with the records.** The parents card lists, for each outside parent object, the aligned records — the source record, the target record it lands on, and the field they are matched by.
- **All open orgs shows its progress.** Scan names the deployment being scanned and marks that cell while it runs.
- **⚠ Needs a decision, redrawn.** Each shared name shows the two orgs side by side — the copies in the source, the copies in the target, each side with its own 🔀 Merge button — and, for each source copy, one sentence to complete: it is the same record as #1 in the target, a new record, or not decided yet. **🔀 Merge all** walks every name whose org holds copies, one merge at a time, each with its own picker and confirmation; Cancel stops the walk. The merge dialog says what a person picks by (oldest, most filled) and takes all of one copy's values with one click; how the merge is done folds away.
- **Connected Orgs** — the orgs open in Chrome; rename, lock writes, or treat an org as
  production everywhere.
- **Data Deployment** — a saved deployment (a root object, the objects under it, how a
  record is recognised in the other org) opens on the 🚀 Deploy page: both orgs are read,
  every record sorted into insert / changed / only in target / synced / needs a decision,
  nothing ticked for you. A whole tree goes in one run, parents first; lookups connect;
  record-triggered flows, validation rules and duplicate rules can be paused or bypassed
  for the run (and what cannot be bypassed is said); ↻ Retry failed; the 🪪 identity field
  makes matching exact across orgs. A long run can be ⏸ paused after the batch in flight and
  ▶ continued later with the records not reached; closing the tab mid-run asks first.
  One button ticks every record the target lacks, in every object read, parents before children.
  Where a name exists more than once in one org, 🔀 **Merge** makes it one record: you choose
  the record that stays and, for every field that differs, the value it keeps; the copies are
  merged into it (Salesforce's own merge for Accounts, Contacts, Leads and Cases; for other
  objects what hangs under a copy is moved first, then the copy deleted) and both orgs are read
  again. A merge cannot be undone — the dialog says so.
- **All open orgs** — every deployment against every open org at a glance.
- **History** — every run with its counts, exports as CSV or JSON, and ↩ Roll back, which
  deletes what a run created and restores what it changed, then verifies.
- **Org Compare** — record counts of any objects between two orgs, by name, external id or
  a field you choose.
- **Org health** — one card per finding, each with its API cost first.

### Known limits
- A Toolkit tool's changes are listed in that tool's History; Data Studio's History lists
  deployments and rollbacks.
- A rollback cannot undo automation that already ran; hard-deleted records cannot come
  back; a Draft flow rewritten in place by ⚙ API versions has no previous copy to restore.
- Bulk API 2.0 cannot bypass duplicate rules, and no API passes a rule set to Block.

