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

## 1.1.0 — 2026-11-04

### Data Studio
- **The Deploy page remembers your ticks.** Tick records, refresh, run, open another deployment and
  come back, or close the tab — what you ticked is still ticked. After every scan the page puts back
  each tick whose record is still in the list it was ticked in and drops the ones that are in the target
  by now (or gone). Ticks that come back are simply there; only a dropped tick gets a line, with why.
  Per deployment and target org; a child object not read yet keeps its ticks until it is read.
  Counts-only mode keeps the memory off the disk.
- **▸ record shows the values that are written.** For one record every box now holds the value the
  record is written with — the source's unless you change it — and every change is saved as you type:
  close the dialog or the tab whenever, nothing is lost. ✕ on a row goes back to the source's value,
  ∅ writes the field empty, and the footer counts the changed values. A field that is empty in the
  source carries the ∅ mark from the start — it is written empty — and a typed value lifts the mark.
  A record that could not be read from the source is said so, never shown as empty; a single field
  the org refuses for your user (describe lists it, the query says "No such column") is dropped from
  the read and shown as "not readable". The record type has a row of its own: the source's type by
  name, and a pick among the target's — a record without a pick lands on the target's type of the
  same API name, as before. The bulk dialog (one value for every ticked
  record) keeps its Save button.
- **🧪 Dry run** on the Deploy page, next to ▶ Deploy: a real write that Salesforce rolls back. The
  selected inserts go to the target in one transaction together with a record that always fails, so
  every validation rule, trigger, flow and duplicate rule runs on your real records — parents first,
  each child linked to its parent — and nothing is kept; the run re-reads the org to confirm. The live
  run view and History say, per object, how many would be written, how many Salesforce refused (with
  its own error and the values sent; the record opens in the source org) and how many were not checked
  because their parent would be refused. The selections stay for the ▶ Deploy that follows, and the
  action bar says "dry run passed" for as long as they are the ones checked. Limits, said in the
  dialog: the first 200 records of each object; deletes, updates and relinks are not part of it;
  ⏸ pauses are not applied; 🔗 lookups connected after insert and 📎 files are not checked.
- **🎭 PII treatments** in the deployment builder — seed a sandbox from a Full Copy without the
  real people in it. Suggest reads every object's fields, compliance classification and 200 real rows
  and proposes a treatment per field from what the values look like; each row shows two real values
  and what they become. Treatments fabricate values that look real and pass validation: names (Hebrew
  stays Hebrew), e-mails made from the fabricated name on a .invalid domain the Contacts of one Account
  share, phones in the same shape, Luhn-valid cards with the last four kept, IBANs, Israeli IDs, SSNs,
  streets, dates moved 1–180 days, free text with the PII inside it replaced — or a pseudonym, or
  empty. The same value always becomes the same fake (a key kept on this PC), the source org is never
  changed, and after the write the run reads a sample back and says whether anything still looks like
  PII outside the fields the policy fabricates.

### Toolkit
- **Field Cleaner's blocker list was put to the test — and fixed.** Every kind of reference a field can
  have was built in a test org and the field was deleted under it, to see what Salesforce really
  refuses. Two rows of the table were wrong: a Lightning page that holds the field *blocks* the delete
  (it was listed as a mention), an email template does *not* (it was listed as a blocker). And eleven
  kinds of blocker never show up in Salesforce's dependency index at all, so the scan now reads them
  itself: workflow rules (active or not), email alerts and outbound messages, approval processes
  (active or not), criteria-based sharing rules, duplicate rules with a filter on the field (active or
  not), Lightning web components that import the field, custom metadata records that point at it, the
  lead field mapping, and Lead/Case assignment, auto-response and escalation rules. A Process Builder
  process is listed under Flows and blocks like one, but is never rewritten here — its card points to
  Setup. Paths join the mentions: the delete goes through and the Path stays active on a field that no
  longer exists. When Salesforce still refuses, the error now names the kind it named. The note under
  the results says exactly what is read and what is not. Two mentions were being missed as well: a
  compact layout that no record type uses (Salesforce's describe lists only the assigned ones; every
  compact layout of the object is read now) and a custom quick action of the object (its name carries
  the object's prefix, which the scan took for a global action). A demo field carrying every reference
  type at once found four more: a matching rule on a custom field (Salesforce returns the field's Id,
  not its name), inactive validation rules (never returned by the index; they have a leg now, listed
  as a mention), lookup filters named "nf_Contact_00N…" (now named by their lookup field), and formula
  fields, custom buttons, lookup filters and field sets shown by their raw type name.
- **Every blocker can be deleted from Field Cleaner, in one click, with a way back.** Until now a
  blocker outside flows, layouts, Lightning pages and reports only had ↗ Setup. Each 🔒 item now
  carries 🗑 Delete: the component's full definition is read first and kept as a restore point, a
  destructive deploy removes it, a re-read proves it is gone, and ↩ Undo in History (or ↩ Restore
  points under the results) deploys it back as it was. Validation rules, workflow rules, field updates,
  email alerts, outbound messages, approval processes, sharing rules, matching rules, field sets,
  custom buttons, formula fields, scoping and restriction rules, Lightning pages, custom metadata
  records, Apex classes and triggers, Visualforce pages and components, Lightning web components and
  Aura components — each one deleted and put back live. The four that are not components of their own
  get the same button, their own way: a duplicate rule (deleted only from this button — nothing switches
  one off or edits one behind a run), the lead field mapping (only the line of this field goes, the
  settings and the other lines stay), a lookup filter (only the filter goes, the lookup field and its
  data stay) and a Process Builder process (every version goes, switched off first; Undo brings its
  latest version back, inactive). In a production org Salesforce may run the org's Apex tests before
  code goes; the tool asks for that only when Salesforce demands it. The status line counts "deletable
  here" apart from the true hand jobs.
- **✂ Remove and ⇄ Replace inside a blocker, with its XML on screen.** Deleting a whole validation rule
  to free one field is often too much. Every declarative blocker now also offers ✂ Remove and — once a
  replacement field is picked — ⇄ Replace, which change only the field's own places in the component:
  a criterion line, a recipient, a sent field, a field-set member, a filter condition, a mapping line,
  a custom metadata value, or the field's name inside a formula, a button URL or a record filter.
  Everything else is deployed back exactly as Salesforce returned it. The confirm shows the XML as it is
  and as it will be, line by line; 🔍 shows the whole XML with the field's lines marked and what each
  way would change. When what is left would not work — the field is a rule's only criterion, an alert's
  only recipient, or sits in a formula (✂ never cuts a formula; a validation rule is switched off
  instead, since an inactive rule does not block the delete) — the edit is refused before anything is
  written, with the reason and the way that does work. A restore point is kept and ↩ Undo in History
  deploys the original back. Duplicate rules keep 🗑 only: the tool never edits a duplicate rule's
  criteria. Assignment, auto-response and escalation rules are now read through their object's rules,
  which also makes their 🗑 restore point work.
- **✎ Edit the XML and deploy it back, from Field Cleaner's 🔍.** For every declarative blocker the XML the
  org holds opens in an editor box: change what you need and press Deploy. Nothing is sent until the
  text is well-formed (the box names the line that is not); the component's name cannot change; the
  confirm shows your change line by line; a restore point is kept; if Salesforce refuses the deploy its
  own words appear under the box and nothing changes; ↩ Undo in History deploys the previous XML.
- **Field Cleaner's "how much data is stored" line was audited** after the owner doubted it on a field
  deleted at work. Three ways it could be wrong are closed: a count that came back for an earlier pick
  could land under the next field; a formula field was counted as if it stored data (describe never
  says "formula"); a checkbox was "100% populated" on every org, since false is a value — a checkbox is
  now counted by how many records have it ticked, and says so.
- **Field Cleaner tells blockers from mentions, and scans either.** The results now come in two
  sections: 🔒 what must be cleared before Salesforce deletes the field, and 👀 the other mentions (the
  delete goes through, these break afterwards). A switch above Scan picks what to read: 🔍 Everything,
  🔒 What blocks the delete or 👀 Other mentions. A scan that read less says so, and a blocker is never
  hidden from the Delete button, only from the list.
- **A filter box on ⏻ Switches and ⚙ API versions.** Type or paste a flow name or API name and the
  list narrows as you type. A flow you ticked stays ticked when the filter hides it — the line under
  the box and the footer say how many ticked flows are hidden — and Enter with one flow left ticks it,
  so you can paste one name from a ticket, tick, paste the next, tick, and switch or change them all
  at once. The 🗂 Versions search matches the API name too.
- **Field Cleaner fixes custom report types.** Salesforce's dependency index does not list the report
  types whose columns carry a field, so the scan now reads every custom report type in the org and shows
  the ones with the field's column, with the same ✂ Remove and ⇄ Replace as a layout: the column is taken
  out (a section left with no columns goes with it) or pointed at the new field in place, a restore point
  is saved first, ↩ Undo puts the type back, and the change is verified by reading the type back. Reports
  built on the type lose the column, so the reports listed above come first.

## 1.0.0 — 2026-11-02

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

