# Admin Toolkit for Salesforce — what every tool does

Admin Toolkit for Salesforce runs inside your browser and works through the Salesforce tabs you already have open — no separate login, no server of ours in between. Nothing about your data leaves your browser except to talk directly to your own Salesforce orgs. Anything that can change something in Salesforce shows you what it's about to do and asks first — a checkbox, a typed word for anything permanent, and in Data Studio the org's name when the target is production. Where a tool reads the org back afterward, it says so; where it can only report what Salesforce answered, it says that instead.

## Toolkit (the popup)

### Flows
- Lists every flow in the org, grouped by name with each version, and shows a 🔗 mark when another flow calls it as a subflow. Read-only.
- 🗑 **Delete Selected** permanently removes the ticked flow versions. If any is Active it warns first and offers a backup; if paused runs are waiting on a version it offers to delete those too; if another flow still calls the one you're deleting, it shows you that calling flow and lets you delete it first, proceed anyway (Salesforce will refuse), or cancel. The final step needs an "I understand this is permanent" checkbox — Salesforce has no Recycle Bin for flow versions.
- ⬇ **Backup** downloads the selected version(s) as a file you could redeploy elsewhere, optionally including every flow it calls. 📥 **Restore** uploads a backup and redeploys it as a new Draft version — never turned on automatically; you activate it yourself in Flow Builder.
- Limit: a managed-package flow's contents can't be backed up (Salesforce hides them), and a flow another flow calls cannot be deleted until the caller is handled first.

### Dependencies
- A tree of every flow showing what calls what, a "what uses…" search for a field, object or value, 🧨 blast radius (what breaks if you touch this flow), and 🔗 chain (upstream and downstream, with loops detected). All read-only; an export downloads the same report as a file. Deleting a flow from here uses the same checks as the Flows tab, including a table of every flow that calls the one you're deleting.
- ⚙ **API versions** compares every flow's pinned API version to the org's own release. Pick flows and a target version, then type CHANGE to confirm; it deploys a new version (activating it if the flow was Active) or rewrites a Draft in place, then re-reads the org and reports what changed and verified versus what Salesforce refused.
- ⏻ **Flow switches** groups record-triggered and scheduled flows by object with an On/Off state. Turning flows off requires typing OFF and warns automation stops for everyone and records created while off aren't processed retroactively; it re-reads the org afterward and remembers which version was active so turning back on can restore it — or says honestly it can't if there's no record of it.
- Limit: this only knows what a flow's own saved metadata calls, not buttons, Apex, REST or scheduled starts; a managed flow's contents can't be searched.

### Debugger
- Pick a user and a debug profile (or build a custom one); **Start Trace** turns on Apex debug logging for that user for one hour, **Stop Trace** turns it off — both re-check with Salesforce rather than assuming the click worked.
- The log list refreshes automatically while tracing, can be searched across every log's full text, and two logs can be compared side by side. Opening a log shows a colour-coded, line-by-line view with automation analysis that flags repeated/looping flows or triggers and how close the transaction came to a governor limit.
- Copy or download a summary report, download the raw log file, and delete logs one at a time, in bulk, or everything older than 24 hours (larger deletes need a second click to confirm).
- Limit: a trace always lasts one hour before it needs restarting; the log list shows at most 200 logs at once; a very large log may be too big for the built-in viewer and needs the raw download instead.

### Lightning Pages
- Lists every Lightning page, grouped by type, with its assignment status. A Lightning page has no separate "active" switch in Salesforce — being assigned somewhere *is* what makes it active — so the tool says "Not assigned" plainly instead of guessing.
- The detail view shows every assignment (org default, per app, per app + record type + profile, desktop or mobile) and how many users each reaches. Adding or removing an assignment asks first, deploys the change, then re-reads the org to confirm it landed. You can also clone a page (with its layout and, optionally, its assignments) or deactivate one.
- "Who sees what?" is an org-wide, read-only audit of every page and how many users each assignment reaches. "What a user sees" picks one user and shows which page wins for a given object and why, following Salesforce's own precedence order — and says outright when something (like permission-set-based visibility) isn't part of this model.
- Limit: standard or managed pages can't be changed here; the tool points you to Lightning App Builder instead.

### Field Cleaner
- Pick an object and a field, and scan for everything that references it — flow versions, failed flow runs on those versions, permission sets, page layouts, Lightning pages, reports, and more — flagging what it can fix automatically versus what needs a person (Apex, validation rules). Read-only.
- It removes what it safely can: deletes inactive flow versions (offering a backup first); for an **active** version, it creates a replacement with the reference removed, verifies it's active, then removes the old one — or, if that would leave the flow broken, offers to delete the active version too, always showing the consequence first. It can also remove just the one piece of a flow's own definition that references the field.
- 🕐 **Deprecate first** renames the field's label and description to flag it and strips access, without deleting anything — fully reversible. 🗑 **Delete Field**, once everything else is cleared, deletes the field (recoverable for a short window, then gone for good); you can back up its current values to a CSV first.
- Limit: some references, like criteria-based sharing rules, can't be scanned by Salesforce's API at all, and the tool says so; picklist *values* are handled by Picklist Manager, not here.

### Copy Permissions
- Pick a source user and a target user, then choose what to copy: profile, permission sets, permission set groups, public groups, individual user permissions, and locale/timezone. Anything already matching is shown as such, so you don't overwrite it.
- Every planned change is listed and requires a checkbox before it writes anything; a profile change replaces the old one, but everything else only adds access — nothing is removed from the target user. It reports Salesforce's answer for each operation — what was assigned, what was refused and why.
- Limit: a permission set whose license doesn't match the target user's is shown but never force-assigned.

### Licenses
- Deactivate or reactivate one or more users at once (a dialog names everyone affected before you confirm). **Change License** reassigns a user's profile — which is how Salesforce ties a license — from a list grouped by license, and warns you to check a seat is free first.
- Reports success or failure per user from Salesforce's answer; after a deactivation it also tells you the user has moved to the Inactive filter, since the list shows active users by default.
- Limit: users are changed one at a time behind the scenes, so a large selection takes longer and partial failures are reported individually.

### Flow Access
- Pick one or more flows and one or more permission sets, see how many already have access, and grant them all in one action.
- It lists exactly what will be granted before writing (this always deploys a small metadata package, since a plain API write doesn't actually create this kind of access), then reloads the access list from the org so you can see the grant in place.
- Limit: this only grants access, with no revoke button; it covers screen and autolaunched flows, not record-triggered or scheduled flows; and it works with permission sets only, not permission set groups.

## Data Studio

### Connected Orgs
- Shows every Salesforce org you currently have open in a tab (and any you've had open before), with a connected / not-open status — no separate login, it rides your existing browser session.
- You can rename an org's label, forget an org the tool remembers, lock an org so nothing in the extension can write to it, and 🛑 **Guard as production** — treat any org as if it were production everywhere (typed confirmations, no hard deletes), even if Salesforce reports it as a sandbox. All of this is local to the extension; none of it touches Salesforce.
- Limit: a closed org can't have its real type (sandbox, production, trial) re-checked until you open it again.

### Data Deployment
- Build a reusable deployment — which object and related child records to move, and which field identifies a matching record between two orgs — from a template or from scratch, and import or export it as a file to share with a teammate (no passwords or org-specific record IDs travel with it).
- Chain several deployments into a **Sequence** that runs one after another against one org pair, so a later step can use records an earlier step just created. Running a Sequence lists every step and the stakes and requires an acknowledgement — plus the target org's name if it's production — before writing anything.
- Opening a deployment goes to the 🚀 **Deploy** page, which scans both orgs and sorts every record into 🔴 Insert (missing from target), 🟡 Changed (differs), 🔵 only in target, or 🟢 Synced — nothing is ticked for you. Lookups inside the same deployment connect automatically after insert; lookups outside it are matched by name, and you can hand-pick the right target record when a match is ambiguous or would land empty.
- A **Duplicate rules** setting decides whether the target's own duplicate-detection can block a record (Respect) or is bypassed (Bypass) — bypassing forces the run onto the slower Collections API rather than Bulk API 2.0, since Bulk can't skip duplicate rules at all. A separate Engine setting picks between quick Collections calls and one big Bulk job for large volumes.
- ↻ **Retry failed** re-opens a deployment with just the records that failed last time already ticked; History keeps Salesforce's answer for every record, and the run's own log names each refusal with Salesforce's text.
- A whole tree goes in one run: tick a grandchild (a line item on an Opportunity, a comment on a Case) and the parents it needs that are missing in the target come along automatically — the plan says how many were added — then everything is written parents first, each record linked to its new parent. If a parent is refused by Salesforce, its children are not inserted without it, and the run names them.
- Limit: a very large bucket is shown a page at a time, so a huge object can need more than one pass.

### Sync Ring
- Pick one org as the 👑 source of truth and tick other orgs into the ring; for every saved deployment you then see, at a glance, how far each ring org has drifted (missing, changed, or only-in-target counts) without opening each one individually. Opening a cell takes you straight to the 🚀 Deploy page for that pair to fix it.
- Drift can also be checked automatically on a schedule (counts only), with a badge on the extension icon when something has drifted. A record that looks like a duplicate of another is never auto-matched — it's flagged for you to pair by hand instead.
- Limit: the ring only checks a deployment's top-level object, not its child records — check those directly on the Deploy page.

### Picklist Manager
- In a single org: every value with its active state, usage count and record types, plus a wizard for deactivating or removing a value that first checks flows and validation rules mentioning it by name (an honest, partial check stating how many it actually scanned) before letting you remap or clear the records that hold it.
- Comparing across orgs: a matrix of every value's state per org and 🔄 **Sync from source** to bring targets in line — adding missing values, deactivating what's gone, and aligning labels, record types and the default, with "also deactivate extra values the target has" left unticked by default. Bulk actions apply the same change across every ticked org at once. Standard picklists and shared (global) value sets can be viewed and edited too; 🔄 Sync from source cannot write them.
- Every write is confirmed first, production targets require typing the org's name, and any Run button waits until every org's automation check finishes before it becomes clickable.
- Limit: Salesforce's own API cannot truly delete a picklist value — the tool re-reads afterward and reports plainly that it was kept inactive instead, with the exact Setup path to delete it for good by hand.

### History
- A log of every past deployment and sequence run: the org pair, per-object counts (created, updated, deleted, failed), and a status of success, partial, or failed. Filter by status or deployment, and export any run — or all of them — as CSV or JSON.
- ↩ **Roll back**, launched from a run's card, undoes it: typing ROLLBACK (or the org's name for production) deletes what the run created and restores what it overwrote to its prior values, then re-reads the target and only reports "verified" for what it actually confirmed gone or restored.
- Every change made by a Toolkit tool — a picklist value deactivated, a flow switched off or moved to a new API version, a permission copied, a licence toggled, a Lightning page assigned — has its own entry here too, saying what was written and what the org showed afterwards. ↩ **Undo** on that entry writes the earlier state back, asks with the same dialog (the word UNDO, and the org's name for production), re-reads the org before it says "undone", and records the undo as an entry of its own. When a change cannot be reversed, the entry says why instead of offering the button.
- Limit: a rollback cannot undo automation that already ran because of the original write — emails already sent, records other flows or triggers created, or owner changes all stay as they are; hard-deleted records can't come back; and only the most recent runs keep enough information to be rolled back at all.

### Org Compare
- Pick two orgs and any objects, standard or custom, and see a record-count difference for each — how many exist in both, are missing from the target, or exist only in the target — matched by name, an external ID, or a field you choose. Read-only; 🚀 Deploy next to any row jumps straight to a scoped deployment for that object.
- Limit: this compares a whole object at once, not just the records a particular deployment cares about, so its numbers won't match a deployment's own scan of the same object.

### Deploy Readiness
- Picks a source org and checks every ring target's schema against it before you migrate anything: missing or mismatched fields, picklist value gaps, missing record types, active validation and duplicate rules on the target, and org-level settings that can silently break a load (like State/Country picklists being on in one org and off in another). Only reads schema, never data.
- Every result states exactly which org pair and when it was checked; an inconclusive check is shown as unknown, never quietly counted as fine.
- Limit: this checks the *shape* of the data — fields, values, rules — not who can see or edit it.

### Schema View (Labs)
- An early preview: a visual map of how an org's objects relate to each other, optionally layered with which flows touch which objects, plus an on-demand overlay comparing that map against a second org. Read-only.
- Limit: an early preview that may not be fully reliable yet; a large org is capped to a portion of its objects unless you name the rest yourself.

### Field Audit (Labs)
- An early preview: ranks a chosen object's custom fields by how safe they'd likely be to delete — fill rate, who can see the field, how recently it changed, and how many other things depend on it — and can compare fill rates for the same field across your Sync Ring. Read-only; actually removing a field still happens in Field Cleaner.
- Limit: an early preview where a blank result on screen means "not measured," not "safe to delete" — it says so directly.
