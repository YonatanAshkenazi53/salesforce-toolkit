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

- **▸ record on the Deploy page.** Every Insert and Changed row opens the whole record — values and lookups in one editor: each writable field with the source's value (and the target's, on a Changed row) and a box for the value it is written with instead — one record, or one value for every ticked record of the list. Each lookup says where it lands in the target (the one record named like the source parent, several — the first wins, or none — empty) and is picked from the target org in the same dialog. Typed values are saved on the deployment per target org and written by ▶ Deploy; the run log and History say how many. A field the PII policy covers keeps its masked value.
- **🔗 Pair records by hand, redrawn.** The Match review says what a pair does (the record then shows under Changed or Synced instead of Insert), every candidate carries a bar, a % and a word for how alike the names are — the best of three measures: the start they share, the letter pairs in common, the words in common — with the three numbers on hover and "How the % is measured" in the dialog; both records open; a pair made here can be taken back; the memory line says how many pairs are remembered for the target org.
- **⚠ Needs a decision: merge first.** When a side holds copies, the per-copy "say what it is" question folds behind "Not copies but different records that share a name?" — merge above and skip it.
- **Flows page, drawn tighter.** The view strip and the Delete · Backup · Restore switch are sized to their words and share one row with the search; the restore drop zone is a card; the action button sits to the right. **Whole flow + subflows:** a flow that calls subflows offers "+ N subflows" — every version of the flow and of every flow down its subflow tree, selected in one click (on delete the parents go first and a subflow another flow still calls is flagged).
- **Deploy page: "Set one value on the N selected"** replaces "Edit the selected records" — it says what the bulk editor does, carries the count and sleeps at zero; the editor's header says that one value is written to every one of the N records.
- **Builder: "Check all targets" is gone.** A deployment is checked against every open org from All open orgs; the schema check stays in the import dialog, where a tree from another org needs it.
- **Plain words where codes were.** A scan on an expired session says which org to sign in to again instead of "SESSION_EXPIRED"; a merge that could not delete a copy says why in the sentence instead of "see the lines".
- **Field Cleaner: a flow fix can be undone from History.** The version that used the field comes back from its restore point as the active version (Salesforce numbers it anew); the fixed version stays as an obsolete version; the other deleted versions are under ↩ Restore points below the results, and the backup zip, when ticked, is on disk — the entry says all of it. The confirmation says that the way back exists.
- **"No undo" says why.** A disabled undo prints its reason next to the button — in Activity, in History and in a tool's own list — instead of a hover title only.
- **🔀 Merge, with many copies.** The copies are rows, not columns — twelve read like two: each row says what tells it apart (its values in the fields that differ), when it was made and changed, how many fields it has filled, with "oldest", "newest", "most filled" and the one ticked for you (the fullest, the oldest when they tie). Each field that differs lists its DISTINCT values, each with the copies that hold it — a lookup such as the owner shown by name — plus a value you type; the record that stays is marked on every field.
- **Parents first, visibly at work.** Each parent object's row carries a bar while its alignment is read — live on the one being read, quiet with "waiting · N ahead of it" on the rest — and the rows settle one by one as the checks finish; the card no longer looks frozen on first load.
- **🧾 Activity, in both top bars — the one history.** One feed of everything the Toolkit and Data Studio did, and when — grouped by day, then by the tool or deployment, with a search, an app filter and ⬇ Export all. Every line carries its actions: in Data Studio the run's fix · undo · open · report groups (roll back, retry, continue, which records, deploy, profile, report) and ↩ Undo of a tool's change; in the Toolkit ↩ Undo and ⬇ Report of a tool's change. History left Data Studio's sidebar; its full cards open from a group's "details".
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

