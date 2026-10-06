# What's New — Salesforce Toolkit

Everything that shipped, newest first, in plain language.

This file is the single source of truth for release notes: the in-app **What's New**
page (Data Studio nav + Toolkit home) renders it directly, and the Chrome Web Store
listing text is copied from the newest section. Write the notes here, with the code.

Versions below `1.0.0` are development milestones grouped by the day they landed —
they were never published to the store as separate releases.

## Development releases 1.3.0 – 1.5.0 (2026-07 → 2026-10), moved here on 2026-10-07

These were the in-app What's New sections of the developer builds before the first public
release. Their fixes and features are all in 1.0.0.

## 1.5.0 — 2026-09-21

### Changed — Data Deployment has one page now
- **🚀 Deploy replaces ▶ Run Transfer and ⚖ Reconcile.** Every deployment
  opens on one page: it reads both orgs, shows per object what is 🔴 to
  insert, 🟡 changed, 🔵 only in the target, ⇄ linked differently and
  🟢 synced (true totals, even when a list is truncated), and lists every
  object's records — children included. Nothing is selected until you select
  it, and only what you select is written. The deployment card, History
  (↻ Run again, ↻ Retry failed), Org Compare, the Sync Ring and the command
  palette all open this page. The engine underneath is the one that was
  already moving your records — it did not change.
- **↻ Retry failed ticks the failed records for you.** The ones still under
  🔴 Insert are selected; the ones under 🟡 Changed are counted and left for
  you to decide; anything the last scan cannot place is reported, not guessed.
- On the page: a visual tree of the deployment, "Start with parents first"
  for every object (checked on load when that is cheap), 🪪 identity field
  creation for the whole tree, 🔗 Match review, 💾 Save as deployment for a
  one-off pair, engine / batch size / threads, delete mode, and the
  📸 restore point switch.
- **More than 5,000 records in one list?** The page lists the first 5,000 and
  says so. Run what is listed, 🔄 Refresh state, and repeat.
- **Not on the new page:** the old 🧪 Dry Run (it could not see validation
  rules, triggers or duplicate rules, so a pass meant little — a real,
  rolled-back dry run is being built), the run-time record filter (select the
  records instead, or narrow the deployment), Upsert mode (match on an
  External ID and use 🟡 Changed → overwrite), and the API-call estimate.

### Added — watch a run as it happens
- **A live run view.** Every object being written gets a card: a percentage bar (failures as a red segment), records written / created / failed, elapsed time, records per second and an estimate of the time left, the current batch ("batch 7 of 25"), and for a Bulk API job its state plus how long since Salesforce last answered. Errors still stream in red as they land; the engine's information lines stay grey. Every page that runs a deployment shows the same view. Before this the Deploy page sat on "fetched — writing…" for a Bulk job's whole run.
- **Pick the orgs when you deploy.** The Deploy page opens with "Between which orgs": From and To lists that offer only the orgs open in Chrome. The deployment remembers the pair you used last; if one of those orgs is not open, nothing is pre-selected and the page says which org to open. Picking writes nothing. This is the first step of retiring the Sync Ring's "source of truth": a deployment is becoming a shape you run between any two open orgs.
- **Long record lists open up.** A list used to stop at 300 rows with a note to go filter. It now offers "Show 300 more" and "Show all", in place, keeping your scroll position; the filter still searches every row.
- **Roll back is a page, and it says who.** ↩ Roll back opens a page like Deploy: what the run did per object, every record by name under To delete · To restore · Kept · Left alone · Not restorable, with the reason for each; everything the run did is ticked, untick what should stay; one confirmation; the live run view; then a result with the verification. The History card's new "📋 Which records" opens the report: every record the rollback deleted, restored or could not touch, by name, deleted ones linking to the Recycle Bin. Also fixed: the Lightning case-history object (CaseHistory2) made the planner keep every Case, so Salesforce then refused to delete their Accounts and Contacts.
- **⏸ Pause validation rules during a run.** A second option next to the flow pause, off by default. Tick it and the page lists the active validation rules on the deployment's objects. The run switches off only the rules on the objects it actually writes, after its one confirmation, which names them and says they are off for every user of that org meanwhile. They come back on as soon as the writes end, also when the run fails or is stopped, each re-read before it counts. If the page closes mid-run, the Deploy page shows which rules are still off with one button to switch them back. Rules from installed packages cannot be switched and are named. The flow pause now narrows to the objects in use the same way.
- **"Needs a decision" replaces "Ambiguous", and it helps you decide.** Records that share a name are grouped under that name. The possible records in the target are numbered and shown with the values that differ between the copies, for example the city or the birthdate, and each source record gets one choice: which of those it is, or that it is new. Where one field proves a pair, the same value on exactly one copy on each side, the pair is filled in as a suggestion and the page says which field did it. Nothing is remembered until you press Apply, and one target record can never be claimed by two source records.
- **No more source of truth.** Deployments no longer follow a crowned org, and nothing re-points them when you change the source. The top bar now just shows which orgs are open in Chrome, and you pick the orgs on the Deploy page each time. The former Sync Ring page is now "All open orgs": choose one source and see every deployment against every other open org. A deployment's saved source and target are only the pair you used last; the scheduled drift check and the pinned or followed target sets are gone.

### Added — replace a field instead of removing it
- **Field Cleaner can move a field's references to another field.** Step 3, "Replace it with another field", is optional. Leave it empty and everything works as before. Pick a field and every automatic fix moves the reference instead of removing it: a flow keeps its conditions, assignments and filters and reads or writes the new field; a page layout keeps the slot; a Lightning page keeps the field component and its visibility rules; a report keeps its columns, filters and groupings. The list offers only fields of the same type on the same object (a lookup must point at the same object), and it warns before you start when the new field lacks a picklist value, is shorter, or cannot be written.
- **Only what is known to be this field is moved.** A field with the same name on another object is left exactly as it is and named. A reference that reaches the field through a lookup is moved only when the org's schema says the lookup points at this object. A mention whose object cannot be worked out is left alone and listed, so you can change it in Flow Builder.
- **Field access follows.** When a replacement is chosen, the page says how many profiles and permission sets can see the old field but not the new one, and 🔑 Copy access gives each the same access to the new field. Access is only added, never lowered. Each grant is re-read, and History can take all of them back.
- **Undo.** A layout, Lightning page or report swap can be undone from History, and each gets a restore point. A flow swap deploys a new version and deletes the old ones, as the remove fix does; the backup zip is how those come back.
- **You choose per item.** With a replacement field picked, every item in the list has two buttons: ⇄ Replace moves its reference to the new field, ✂ Remove takes the reference out. Replace one flow and just clean another; the "all" buttons come in both kinds too.
- **Everything at once.** Above the list, "Remove all N" (and "Replace all N" when a replacement field is picked) walks every fixable item, whatever its kind. Each item still asks before it changes anything, and Cancel in any dialog stops the walk.
- **A flow's decision is on its card.** A flow that runs on the field now has one button per way: "Remove · flow keeps running" saves a new active version without the field, and "Delete versions · flow off" switches the flow off and deletes the active version with the rest. The confirmation states the way you picked instead of asking again. Replace has nothing to choose: it saves a new active version that uses the new field. If the way you picked cannot work for that flow, it says so before any dialog and changes nothing.
- **A flow is one card.** Salesforce reports a flow once for every version that mentions the field, and the list used to show each version as its own row. A flow is now one card that says what will happen to each version: the active one gets a new version, a newer draft is saved over, old versions are deleted. When the fix is done the card says what happened: which version is active now, which versions were deleted, how many interviews went with them.
- **The stored values can be copied too.** Moving references does not move data, so after the scan a "Stored values" panel offers it. You press Compare (the button says how many API calls it costs), and it shows how many records already hold the same value in the new field, how many have it empty, how many hold something different, and how many cannot be copied and why (a value the new restricted picklist does not have, a text that is too long). By default only empty fields are filled; overwriting a different value is a box you tick. The copy shows a live count, can be stopped, saves a receipt CSV first, reports every record Salesforce refuses with its reason, and is confirmed by reading the records again. The old field is never changed. History can take a copy back for runs up to 1,000 records.

### Added — Field Cleaner can read every report itself
- **📊 Scan the reports.** Field Cleaner takes reports from Salesforce's dependency index, and in some orgs that index lists none. Under the results there is now a button that reads every report you can open and looks for the field itself. It first tells you how many reports there are and that each costs one API call, and only starts when you press again. It shows a live count and can be stopped. Reports that use the field join the list as ordinary Report rows, so ✂ Remove and ⇄ Replace work on them. Reports it could not read, or did not reach because you stopped it, are named as not checked. Reports that only other people can open are not read, and it says so. It never runs as part of the normal scan.

### Changed — Lightning Pages assigns pages the way Salesforce stores them
- **App Default and App + Record Type + Profile work.** They never did: every attempt was refused by Salesforce, because the tool wrote these assignments in the wrong place and named profiles and record types in a form Salesforce does not accept. Both are now written where Lightning App Builder writes them, and each one is re-read from the app before the tool says it is done.
- **An assignment does only what you asked.** Adding an app or profile assignment to an unassigned page also made that page the org-wide Desktop default, silently, in place of whatever page was the default. That extra write is gone.
- **The confirmation names what is replaced.** Before anything is written the tool reads what holds each slot now. If another page is the org default, or holds that app's slot, the dialog names it and asks you to acknowledge that it stops being shown there.
- **Deactivate means "remove every assignment", and says so.** Salesforce has no on/off switch for a Lightning page: a page is active exactly when something assigns it. The old Deactivate reset the object's Desktop org default whichever page held it, so deactivating a page that was only assigned in an app took the org default away from a different page. It now lists each assignment the page has, checks each again, and removes only those. The Activate button is gone; the Add Assignment form is how a page gets shown.
- **What you see is what the org answers.** After a write the page is read again from Salesforce. It used to be drawn from what the write was supposed to have done. An org default is confirmed by re-reading the object, with a short, counted wait while Salesforce catches up.
- **App-level assignments are finally visible.** The detail, the page list and "Who sees what?" read them from the Lightning apps themselves. Before, a page assigned only through an app was listed as "not activated".
- **Clone creates an unassigned copy.** "Copy assignments" was ticked by default and quietly moved every assignment from the original to the copy. It is now a separate, unticked choice called "Also move the original's assignments to the copy", it says the original stops being shown, and it goes through the confirmation (with the typed org name on production).
- **History undo for an org default is verified.** Undo puts the previous page back and re-reads the object to confirm it.
- **Honest limits.** The tool reads and changes the assignments of record pages. Home, App and other page types are activated in a different way that it does not read, so it no longer says "not activated" or "0 users" about them. A failed read is shown as unknown, never as "none". "Show affected users" shows an error with a retry when the query fails, instead of "No active users".

### Changed — a tool's history is in the tool
- **Field Cleaner's changes are listed in Field Cleaner.** Changes made by a Toolkit tool used to appear in Data Studio's History, between the deployments. Each tool now has its own History: a button in the Toolkit's top bar while the tool is open, with what was written, what the org showed, and Undo. Field Cleaner also lists its changes under its results.
- **Data Studio's History is about deployments again.** It lists deployments, rollbacks and Data Studio's own changes. One line says how many Toolkit changes there are and opens each tool on its list. The full export still includes everything.

### Changed — the deployment tree shows the relations and the numbers
- **Each object's card says how it hangs and how much it holds.** On the Deploy page, every card in "This deployment" now says which object it is under and through which field, how many records each org holds, and what is left to do, one chip per kind. A chip opens that list.
- **An object that was not read says so.** It reads "not counted yet — unknown, not zero" with a Count button that reads it in both orgs. Nothing is changed by a count.
- **The lines of the tree meet.** The root sits at the top and every connector joins its neighbour.
- **The identity field is no longer shown as two errors per object.** It is optional. A card mentions it only where an org has it, and the line under the tree says what it adds.

### Changed — "Needs a decision" can be settled one name at a time
- **Apply this one.** Every name on the ⚠ Needs a decision tab has its own Apply button. The answer is remembered right away, and both orgs are read again once, when you ask for it, instead of after every name. Choosing "Not decided" on a remembered record takes the answer back.
- **The answers are written out.** Instead of a dropdown of "#1 / #2", each record lists its answers as sentences that carry the values of the record they mean: "Same record as #1 (BillingCity: Haifa)", "Not there yet — create it as a new record", "Not decided — it stays out of the deployment".
- **Two copies of the same thing.** The tab says what to do with a true duplicate: say which copy is the same record, and after the re-read the left-over copy is listed under 🔵 Only in the target, where you can tick it for deletion. The tab itself never deletes.

### Fixed — "What uses…" no longer answers "nothing" about flows it did not read
- **The Dependencies search says how much it searched.** When the flow list came from the stored cache, the search had read no flow text in that session and still answered that no flow mentions the term. It now says how many flow versions were searched and how many were not, that this is not a "no", and offers to read them all.

### Fixed — Duplicate rules: what "Bypass" can and cannot do (QA 2026-10-06)
- Against a duplicate rule set to **Block**, a Bypass run said "records a rule would have
  flagged were written" while the rule blocked them all the same. Salesforce's bypass passes
  a rule set to Alert; no API passes a rule set to Block. The run now says exactly that, and a
  record refused by a rule with its own alert text is still recognised as a duplicate-rule
  block (the status code stays in the text), with the plain-language line in History.
- The per-run report file is named after the deployment ("sftk-run-SFTK_CX_Accounts_tree-…"),
  not after whichever object happened to come first.

### Fixed — the identity field's "Create" reported a success as a failure (QA 2026-10-06)
- 🪪 Create the field deployed `SFTK_ID__c` and its permission set in both orgs and then
  said "accepted by Salesforce, but could not be re-read on Account, Contact". The re-read
  was a data query of the new field, which you cannot run until the permission set is
  assigned a moment later. It now re-reads the field's definition; once the set is
  assigned it also checks that you can read the field, and says so if you still cannot.

### Fixed — History says "via Bulk" for a Deploy-page run that used Bulk API 2.0
- With Engine = "Async — Bulk API 2.0 job" the run went through one Bulk job (the org's
  job list shows it), but the History entry did not keep that fact, so the card and the
  CSV report never said so. They do now.

### Fixed — Org Compare: no "100%" while records are missing (QA 2026-10-06)
- Account read **100%** with 7 records missing from the target, Contact 100% with 6 —
  the rounded number said "nothing is missing". A row now reads 99.9% at most while
  anything is missing, and 0.1% at least while anything matched.
- Every row had two buttons both called "Deploy". 🚀 Deploy opens the Deploy page for
  that object; the other is now **📦 Save as deployment** — it writes nothing.

### Fixed — Flows: a restored backup was reported as failed (QA 2026-10-06)
- 📥 Restore deployed the Draft and then said "accepted by Salesforce, but the new
  Draft version could not be found on re-read" — every time, because the re-read
  asked Salesforce a question it refuses (filtering flows on their full name). The
  re-read now goes by the flow's developer name and only counts a Draft newer than
  every version the org held before the restore; the result says which version landed.

### Fixed — Field Cleaner: a way that cannot work is refused before you confirm it
- ✂ Remove · flow keeps running on a flow whose Assignment has the field as its only
  line was offered and confirmed, and then Salesforce refused the new version
  ("Required field is missing: assignmentItems") — nothing deleted, but a wasted
  round. The preview already knows which elements the fix would leave empty; the
  button now says so at once, names them, and points to 🗑 Delete versions · flow
  off, ⇄ Replace, or Flow Builder.
- The data verdict read "Empty on 99.9% of 8 of 10,266 records". It now says the two
  facts apart: "Empty on 99.9% of 10,266 records (8 hold a value)".

### Fixed — ↩ Undo says what it could not restore
- An undo that leaves something as it is (⚙ API versions: a Draft rewritten in place
  has no previous copy) said so in its dialog but not in its result — "Undone — 4 steps
  verified" read as the whole change taken back. The result and the undo's History
  entry now carry an ℹ line: "Not restored — …".

### Fixed — a rollback's "Which records" always lists the records
- **The deleted records are read from the Recycle Bin when History has no names.** A rollback that ran before History kept names, or with counts-only mode on, opened a report with counts and no list. The report now reads the records that rollback deleted from the org's Recycle Bin, which keeps them for 15 days, and lists them by name. It says where the list came from, for which minutes, and how it compares with the count. If the Recycle Bin holds fewer records than the rollback counted, it says how many cannot be named. Nothing is changed by the read.
- **Counts-only mode keeps no names from a rollback either.** The names a rollback deleted or restored stayed in History with counts-only mode on. They are now removed like every other record name.

### Removed — Pro mode and the in-app guidance
- **Pro mode** (Data Studio's "Pro" toggle, which swapped emoji for plain text) and the **in-app guidance** (the first-run tours and the pop-up help bubbles) are not in this release. A ? badge still shows its text as a plain tooltip.

### Changed — the Licence button is on both pages
- **Data Studio has the Licence button too.** The licence agreement and the privacy notes you accepted can be read again from the top bar of the Toolkit and of Data Studio.

### Changed — All open orgs: you scan a target
- **The Scan button moved to the targets.** It used to sit in the deployment column, under "from <source>", where it read as "scan the source". It now sits on each target org's column and compares every deployment with that org. The 🔎 in a cell still compares one deployment. Nothing is changed by a scan.

### Fixed
- **A rollback's progress rows say what happened to the records.** While a rollback was deleting, its progress row read "2 written · 2 created". It now reads "2 deleted", and "restored" for restored records.
- **"Remove from all flows" no longer runs a flow twice.** After a flow was fixed, the bulk button tried it again once for every other version in the list. Those versions were already deleted, so each row showed "Could not resolve the flow definition of this version" next to its success message. A flow is now handled once.
- **A flow with a draft on top is fixed correctly.** When a flow had a draft newer than its active version, Salesforce saved the corrected version over that draft instead of creating a new one. Field Cleaner then said "no new version appeared, nothing was deleted" and stopped, although the flow had already changed. It now knows this before it starts: the dialog names the draft, says its content will be replaced and offers the backup, the run recognises the version that was written, activates and verifies it, and finishes the clean-up.
- **Field Cleaner no longer says reports are always covered.** Reports come from Salesforce's dependency index, and in some orgs that index returns none through its API: two public reports that used a field were not listed. The note under the results now says so and points to the report scan and to "Where is this used?" on the field in Setup.
- **Lightning pages: visibility rules that use the field are really cleaned.** The fix looked for the rule under a name Salesforce does not use, so a rule that tested the field stayed in place while the page was reported as updated. Rules are now found, cleaned and re-read.
- **Counts read as counts.** A cell or tab used to say "5,000 of 9,899" when a list was long, which read as "4,899 are not synced". It now shows the true number, 9,899, and the list itself says how many of them it lists.
- **Deleting a field is in History, and the page forgets the field.** 🗑 Delete Field writes a History entry like every other tool, which says plainly that Salesforce has no API undo and where the 15-day way back is (Setup → Deleted Fields → Undelete). The deleted field leaves the picker; re-scanning one the Toolkit deleted says when it was deleted and until when it can be restored, instead of "Could not locate this field".
- **Field Mapping tells a closed org from an object it cannot read.** It said "not open — open it in a Chrome tab" about orgs that were open, when the real reason was that the object did not exist in them. Each side now says which it is.
- **Three things the run log and the ring got wrong.** When the source of truth has no object a deployment needs, the toast now says so in words and names the org it read, instead of quoting Salesforce's SOQL error about the wrong org. The run log keeps the engine's information lines (Bulk API chosen, person-account name parts, lookups resolved) grey instead of painting them red after a failure. The "names used by more than one record" line counts all of them, not just the five it shows.
- **⚠ Ambiguous says what it means.** The tab now opens with a plain explanation of why records land there and what each choice does. The choices read "📌 Same as #1" and "➕ New in <org>" instead of "pair with" and "insert as new", every row says how many records share the name on each side, and rows with several candidates wrap instead of pushing the page sideways.
- **A parents-first step always finds its way back.** "‹ Back to Account" did nothing when the deployment it was opened from was not a saved one (a target picked at 🚀 Deploy time, a Sync Ring cell). The step now remembers where it came from, and the button returns there with the scan intact.
- **The field compare dialog is dark in dark mode.** Its header, fold and footer bars and the value chips were painted light on a dark page (a variable the page never defines, and dark rules written for the Toolkit popup's theme class). They now follow Data Studio's own theme, OLED included.
- **Field Cleaner — the field delete works again.** Salesforce's Tooling API now refuses
  to delete a custom field ("insufficient access rights on cross-reference id") even
  when nothing references it; the Toolkit deletes it through the Metadata API instead
  and, when that refuses too, shows Salesforce's own reason. The "Field deleted" card
  stays on screen (it used to be wiped at once).
- **Field Cleaner — failed flow interviews are found and deleted.** The interview check
  looked them up by the long id and found none, so every flow version with a failed run
  was refused — and still shown as ✅ done with "Safe to delete". A refused version now
  keeps its ✂ button and says which interviews block it.
- **Field Cleaner — the flow fix dialog steers you right.** When the automatic fix would
  leave a flow element empty (Salesforce refuses such a version), "Keep the flow running"
  is no longer preselected and says why; a refusal quotes Salesforce and points at
  "Delete the active version too" or Flow Builder.
- **⚙ API versions — a Draft flow counts as changed.** Salesforce rewrites a version that
  is not active in place instead of adding one; the tool used to report "no new version
  appeared … nothing changed" for it. It now verifies the rewritten version at the new API.
  The closing line counts what happened ("3 flow(s) changed and verified, across 1 org(s)")
  instead of calling an org unchanged because one flow raised a warning.
- **⏻ Flow switches say only what the org confirms.** After switching flows off or on the
  tool re-reads the org; a flow Salesforce still reads the other way is reported as not
  switched (and is not remembered for ▶ Switch ON) instead of a ✅ taken from the request.
- **Deleting a flow that other flows call.** Salesforce refuses to delete a flow while another
  flow's subflow element still calls it. The delete now removes the ticked parents first and
  retries anything refused once its callers are gone; a refused delete switches the flow back
  on instead of leaving it off silently; the reason names the calling flows; the parents dialog
  explains the rule.
- **Picklist Manager and Field Cleaner metadata changes work again.** Salesforce refused every
  value-set, record-type and field PATCH ("Cannot deserialize instance of complexvalue from
  VALUE_NULL") because the metadata was sent back exactly as read, null keys included. They are
  stripped now. The data fix had already run — the tool said the metadata step failed.
- **Picklist Manager tells the truth about 🗑 Delete value.** Salesforce's API cannot delete a
  picklist value; it keeps it as inactive. The tool re-reads the field and says so, with the
  Setup path for deleting it for good, instead of "Value deleted". A value no record holds
  reads 0, not "not counted".
- **Picklist Manager, compare mode.** The bulk wizard's Apply waits for the automation check
  in every org (it could be clicked while "scanned 0 of 2 org(s)" was still on screen); a
  partial scan says "nothing that was scanned names this value" instead of "no flow"; a
  field the user cannot see is reported as possibly hidden by field-level security.
- **Field Cleaner — Deprecate first and Undo work again, and tell the truth.** A grant Salesforce
  refuses to strip (its own Slack Integration User permission set) no longer voids the whole
  step: it is named in the banner, the deprecation is recorded and Undo is offered. Undo
  re-creates the stripped grants (Salesforce deletes a field permission set to no access) and
  names anything it could not give back. The description is stamped once.
- **A scan no longer learns a match on an ambiguous key.** Two source records with the same
  key and one target: the Sync Ring's scan pinned one of them as "the" match, and the next
  scan counted the other as a confident insert — a duplicate waiting to happen, and the Ring
  and the Deploy page disagreeing (7 vs 8). Such keys stay flagged; Match Review can pin them.
- **Sequences ask before they write.** ▶ Run lists every step (object, children, insert or
  upsert), says that a sequence writes every matching record with no per-record selection,
  needs an acknowledgement, and asks for the org name when the target is production.
- **History says which sequence a run belongs to.** A sequence writes one card per step; each
  card now carries "🔗 step of …" and says that ↩ Roll back sequence undoes every step.
- **Copy Permissions asks before it writes.** 📋 Copy lists the profile change, permission sets,
  groups and user fields it is about to write to the target user and needs an acknowledgement.
- **Licenses says where a deactivated user went.** The list shows active users by default, so
  the result now points at the Inactive filter instead of the user just vanishing.
- **Lightning Pages says "Not assigned" instead of "Unknown".** Salesforce keeps no publish
  status for a Lightning page; a page's activation is its assignments. A page with none now
  reads "Not assigned — this page is not shown to anyone yet" with how to add one; "Unknown"
  is kept for the one case it is true, when the org-default check itself failed (with the reason).
- **Every change is read back from the org before it is called done.** Every write the
  extension makes — flows, fields, picklist values, permissions, licences, page assignments,
  deployments — now re-reads Salesforce afterwards and reports what the org shows, never what
  the request answered. A deployment's History carries ✓ per object when the written records
  were found again in the target, or ⚠ found/checked when they were not. A flow delete's result
  message no longer vanishes behind the list refresh; a field delete is no longer called refused
  because Salesforce keeps the deleted field's row for 15 days.
- **One confirmation everywhere, and the org name for production.** Every change now asks with
  the same dialog in the Toolkit and in Data Studio: what will change, what it means, an
  acknowledgement, the required word where one applies (CHANGE, OFF, RESET, ROLLBACK), and,
  when the target is a production org or one you guarded as production, its name typed exactly.
  An org whose type cannot be read is treated as production. Three actions that had no
  confirmation at all now ask: adding a Lightning page assignment, deleting debug logs one by
  one or by selection, and the Field Cleaner's strip, deprecate, undo and restore.
- **Every tool change is in History, with ↩ Undo.** A picklist value deactivated, a flow's API
  version changed, a flow switched off, a permission copied, a licence toggled, a page assigned,
  a trace flag set: each now has an entry on Data Studio's History page saying what was written
  and what the org showed afterwards, next to the deployments. ↩ Undo writes the earlier state
  back (the remembered flow version, the previous value set, the row that was created…), asks
  with the same dialog (the word UNDO, the org's name for production), re-reads the org before
  saying "undone", and records the undo as its own entry. Where a change cannot be reversed —
  a deleted flow version, a deleted debug log, a Draft rewritten in place — the entry says so
  in plain words instead of offering a button.
- **A whole record tree in one run.** A grandchild whose parent is missing in the target — a
  line item on a new Opportunity, a comment on a new Case — can now be ticked straight from the
  first scan. The run adds the missing parents and grandparents by itself (the plan says "+N
  added so the records below them have a parent"), writes every level parents first, and links
  each record to the id its parent just got. When a parent is refused, its children are not
  inserted without it, and the run names them instead of leaving them silently out.
- **Duplicate keys are listed, never guessed.** When both orgs hold the same match key more than
  once, the copies used to be paired arbitrarily — one "changed", the other in no list at all.
  They now appear under a new ⚠ Ambiguous tab on the Deploy page, each with the target records
  it could be: 📌 pair a copy with its target, or ➕ mark it as new, and both orgs are read again
  with your choice remembered. Copies that have no counterpart on the other side are ordinary
  inserts. The plan table and the Sync Ring show the count as ⚠N, and a ring cell with ambiguous
  records no longer reads as in sync.
- **The automation check reads every flow.** Before a picklist value is switched off, Picklist
  Manager searches the org's automation for anything that names it. It used to read only the
  first 40 active flows, one at a time, and could never list the record-triggered ones. It now
  reads every one of the org's own active flows, 25 at a time, record-triggered flows on the
  object first. Flows from installed packages are counted and named as not checked, because
  Salesforce does not expose them.
- **Org health.** A new Data Studio page (and a Home tile in the Toolkit) shows, for one org,
  what the tools already know, one card per finding, each with a button into the tool that fixes
  it: licences at the cap, active users who stopped logging in, flows left switched off, flows
  pinned years below the org's release, Lightning pages assigned to nobody, picklists drifting
  between the Sync Ring's orgs, and custom fields that no record fills and nothing references.
  Nothing is read until you press Check; every card shows its API cost first, every answer says
  when it was checked, and a check that could not finish says so instead of showing all-clear.
- **Copy Permissions copies the role too.** The role sits next to the profile in the options and
  the preview; it is named in the confirmation, written and re-read, and ↩ Undo in History puts
  the target's previous role back (or none). A source user with no role has nothing to copy —
  clearing a role is not offered from here.
- **Deploy with record-triggered flows paused.** A new option next to ▶ Deploy, off by default —
  deploying with every flow active stays the normal way. Ticked, it lists the active
  record-triggered flows on the deployment's objects in the target; the run's confirmation names
  them; they are switched off before the first write and back on at their exact versions as soon
  as the writes end, even when the run fails or is stopped, each switch re-read before it counts.
  If a flow will not switch off, the run does not start. If the page closes mid-run, the Deploy
  page and Org health say which flows are still off, with a button to switch them back on.
- **Writing into production always asks you to type the org name.** Until now
  only deletes did; an insert or overwrite into production from Reconcile ran
  on one click. One typed confirmation per org now names everything the run
  will do there — inserts, overwrites, re-links and deletes, children
  included — and an org whose type cannot be read is treated like production.
  The source org gets the same gate when a run writes back into it.
- **🎯 Pick records → Only needs-deploy** showed nothing when the records
  that need deploying were not in the first pages. They are now loaded by Id
  from the scan, and the picker offers 🔄 Refresh state when a run or a
  rollback changed the orgs after that scan.
- The Deploy page refreshes its state on its own after a run or a rollback,
  as the classic page did.
- On the Deploy page's tree the 🪪 identity chips name the org (trailheads2 ✗)
  instead of saying "source" / "target"; with Bulk API 2.0 selected the batch
  size and threads inputs disappear and a line says Bulk splits the job itself.
- **Children of a record that already exists in the target attach to it
  exactly.** They used to be attached by matching the parent's key again with
  one exact value — an order item lost its order once Order was told apart by
  a composite key. The scan's own parent pairing is used now; key matching is
  only the fallback.
- The builder's Lookup Resolution now lists lookups that point inside the
  deployment (an Account's parent Account, a Contact's ReportsTo) as
  informational rows: nothing to set, they travel.
- **"✓ All" selects the whole list.** Over a list of 5,000 the button selected
  the 300 rows painted on screen. It now selects every record in the list and
  says how many.
- **↩ Roll back no longer refuses because of a child object Salesforce will
  not let it query.** Such objects (an implementation restriction) are named
  and do not keep the parents; a child object that truly could not be read
  still keeps them, and the plan now offers "delete these anyway — I checked".
- **Bulk runs report their real errors.** Salesforce echoes uploaded values
  in its own spelling ("200000" back as "200000.0"), and the result rows of a
  Bulk API job never matched the uploaded records — every record read "no
  result row". Values are compared as values now.
- **Duplicate rules in the target can be bypassed for a deployment.** Bulk
  API 2.0 cannot bypass them, so a bypass run uses synchronous calls. A fuzzy
  name rule blocked 100 of 300 accounts in a test migration with nothing to
  do about it. Next to ▶ Deploy: Respect (default — flagged records fail and
  the run says so) or Bypass for this deployment.
- On the Deploy page: **🔎 Scan all** reads every unread child object in one
  click, 🔄 Refresh state re-reads the children it had read before, and the
  run log stays on the page after the post-run refresh.
- **Line items deploy.** Salesforce takes UnitPrice or TotalPrice on a line
  item, never both; a copied row carries both, so every line item used to be
  rejected. TotalPrice is now left out (the target computes it) and the run
  says so.
- **Records with an autonumber name (Case, Contract, Order) are told apart
  by what a person uses.** Their number is org-generated, so matching by it
  inserted them again on every run. With nothing configured they are now
  matched by their parent plus a subject-like field (Subject, Description),
  the scan says so, and the 🪪 identity field makes it exact.
- **Lookups keep their targets.** A lookup at an object outside the
  deployment (an Opportunity's price book, a Case's referral, a Contract's
  signer) with nothing configured is matched by Name in the target — the
  rule ← update always had; inserts used to drop it. Lookup Resolution shows
  this default and 🚫 Set null stays your choice. Objects that have no Name to
  match by are left empty, and the run says so.
- **Hierarchies arrive whole.** A lookup that points at the object itself
  (Account → parent Account, Contact → ReportsTo, a Case's parent Case, a
  Campaign's parent, an Asset's parent) or at another object in the same
  deployment used to be dropped without a word when the record it points at
  was created later in the same run — a 3-level account hierarchy arrived
  flat at level 2. Such lookups are now connected at the end of the run, and
  the run says how many it connected and which ones point at records that
  neither exist in the target nor were created (and what to do) — across
  every step of one Deploy run, not per step.
- **Price book entries (and other junction-like children whose Name is not
  unique) can be recognised.** When most rows of a child object share the
  same key, the scan re-keys by the records they point at (Product2 +
  Pricebook2) and says so; they used to fall out of every list.
- **Objects without a Name (contact roles, case comments, order items,
  campaign members) can be recognised.** A match key can now be the related
  records' names (Opportunity.Name + Contact.Name). When nothing is
  configured the scan picks that key from the object's definition and says so;
  it used to send `Name` regardless and fail with a raw HTTP 400. 💡 Suggestions
  offers the same key in the builder.
- **Same-name records in a child object are no longer invisible.** A child
  scan cannot tell two "Mia Schmidt" contacts apart, so it leaves both out
  of every list — that is still the rule, but the page now says so, names
  the keys, and tells you the fix (a second match field, or a rename).
- The Deploy page says up front when the source or the target is not open in a
  Chrome tab and keeps 🔄 Read disabled until it is, instead of failing on the
  click. Field Mapping no longer says "No connected orgs" when the only open
  org is the current tab's.
- The deployment builder's object tree was squeezed into a narrow column
  (a style from the new page's tree leaked into it).
- A scan that finished while the new page was open (after a run, or the first
  scan of a new org pair) did not repaint it.
- **A run that wrote every record no longer shows as "partial"** because of a
  note (a field skipped, a lookup resolved by name). Notes on the History card
  are amber, not red, and the hint for a skipped field now matches its reason
  — a field missing in the target says "create it or exclude it", not "clean
  up stale entries".

### Added
- **🛑 Guard as production** (Connected Orgs). Treat any org like production:
  every write asks you to type its name, hard delete is refused, the badge
  shows. For a full-copy or UAT sandbox — or to see the production gates
  before you have a production org.


### Added
- **📜 Read the licence again, any time.** The agreement you accepted on
  first start is one click away: the Licence button in the Toolkit top bar,
  or Data Studio → security → Licence & privacy. It shows the same points,
  the full EULA and privacy links, and the version and date you accepted.
- **Terms version 2.** The acceptance statement now says outright that any
  consequence of using both the Toolkit and Data Studio, and every one of
  their components, is your responsibility. Everyone is asked to accept it
  once more on the next start.
- **↩ Roll back a data deployment.** Before Run Transfer, fan-out, a
  sequence or a Reconcile run writes anything, Data Studio reads a
  **restore point** of every object the run can touch (📸 checkbox next to
  ▶ Deploy, on by default; the newest 10 runs keep one, on your PC).
  History then offers **↩ Roll back**: it re-reads the target, shows exactly
  what it will do — delete what the run created, restore what it overwrote,
  leave anything others created or edited *after* the run alone — together
  with the validation rules, duplicate rules, triggers and flows that could
  reject or re-fire, asks you to type ROLLBACK (the org name for production),
  writes, then re-reads to **verify** and records the result as its own
  History entry. Deletes go to the Recycle Bin, never a hard delete. A run
  that could not get a restore point (an object above the row limit, an
  incomplete read, restore points switched off) says so on its card instead
  of hiding the button. What a rollback cannot undo — automation that already
  ran, hard deletes, copied files, owner changes — is listed on the screen
  before you confirm.
- **Field Cleaner now lists Reports and Report Types** among a field’s
  dependencies — straight from Salesforce’s own dependency index (the one
  behind “Where is this used?”), so it costs nothing extra. Reports get a
  **✂ Remove** fix: a restore point is saved first, the field is stripped
  from columns, filters and groupings, edits that would break the report
  (its only column or grouping) are refused with the fix, formulas and
  buckets stay listed as manual, and the result is re-read to verify.
  Report types deep-link Setup — Salesforce exposes no modern API for
  editing their columns.
  Email Templates and Approval Processes are listed the same way whenever
  the index reports them — it is not guaranteed to for every one, and the
  Field Cleaner says so instead of implying they were checked.

### Added
- **⚙ API versions and ⏻ Flow switches now work on the org you are connected
  to, only.** The org pickers are gone: Compare shows how far each flow in
  this org is behind the org's release, and Flow switches lists this org's
  triggered flows. (User feedback: comparing against other orgs here was
  confusing.)
- **Lightning Pages: pages that share a label are told apart.** Nonprofit
  Cloud ships several pages called "Account Record Page"; the list showed
  them as identical rows. When labels collide the row now also shows the
  page's API name, and a page installed by a managed package is marked 🔒.
- **The licence agreement and privacy policy open as a proper page.** The
  links in the licence gate and the Licence button now open a rendered page
  with correct punctuation and headings, instead of the raw text file.
- **Flows tab: what each flow calls, and a whole-tree backup.** Every flow
  group shows "↘ calls N" with the subflows it calls (the full tree in the
  tooltip), or "calls ?" when the dependency scan has not read it. In
  ⬇ Backup mode, tick "+ the subflows they call (whole tree)" to back up the
  selected flows together with every subflow they reach, one zip, with the
  active version of each subflow. It says which subflows could not be
  included (managed packages, not in this org) and refuses to claim a whole
  tree when the scan has not read part of it.
- **Record-triggered, scheduled and platform-event flows are labelled as such
  everywhere, with or without a scan.** Salesforce stores them all as
  "Autolaunched" and only the trigger tells them apart; the Toolkit now reads
  that trigger for every flow on load, so the Flows tab, the Dependencies
  rows, the filter buttons and the 🔒 managed rows all say Record-Triggered
  where Setup's own list says "Record — Run After Save".
- **Dependencies: ↻ Rescan, and every row says which version it is.** The
  tools row has a Rescan button that drops the stored dependency data and
  reads the flow list and every version again — for a popped-out tab that
  stayed open while flows were edited in Flow Builder. Every flow row
  (standalone ones included) now shows the version it represents, its API
  version, status, and created / last-modified dates; managed-package rows
  show their last-modified date too. A subflow that lives in a managed
  package is now shown as a 🔒 node instead of "Not found".
- **Field Cleaner removes a field from flows version by version.** Every
  flow row now shows which version references the field (v3 · Active,
  v2 · Obsolete…). ✂ Remove reads every version first and states the exact
  plan before asking: if only inactive versions reference the field, just
  those versions are deleted; if the active version does, a new version
  without the reference is deployed, verified active by re-reading the org
  (activated by the tool if the org's deploy setting left it inactive), and
  only then is the replaced version deleted. Paused flow interviews on a
  version to be deleted are listed and deleted first, because Salesforce
  refuses the deletion while they exist. A backup zip of every deleted
  version is offered (ticked by default) and restorable from the Flows tool,
  and every deleted version also gets a 🧾 Cleanup history restore point.
  Nothing is deleted if the new version cannot be confirmed active.

### Removed
- **Data Studio: 🌳 Tree diff and 🌐 Multi-org fan-out are gone**, and so are
  the Sync Ring's "Push…" and "Sync plan…" buttons. Deploying to several
  orgs at once was confusing. The model is now: a deployment has a ring
  (its source and its targets, set in ✏ Edit); ▶ Run and ⚖ Reconcile ask
  which target this time and work on that one target. The Sync Ring keeps
  its drift matrix and its per-cell ⚖, which opens Reconcile for that
  target.

### Added
- **⚙ API versions: update everything that is behind, in one go.** When your
  flows run on an older API version than the org, the panel says how many
  and offers "Update all N to API x" — it ticks them, sets the target to this
  org's release and opens the usual confirmation; nothing is written before
  you confirm. Flows that cannot be changed from here can no longer be
  ticked, and the row says why: installed from a managed package (read from
  Salesforce's own ManageableState, not guessed from a namespace), an invalid
  draft, or a version without a record id.

### Added
- **🪪 Identity for a whole deployment, created for you.** The identity field
  (SFTK_ID__c) is what lets a record be recognised exactly across orgs. The
  Toolkit can now create it on every object of a deployment, in the target
  and optionally the source, together with the access you need to see it —
  production asks you to type its name first. Available from 🪪 Identity on
  the new Deploy view, and whenever 🪪 Stamp identity finds the field missing.
- **Field Cleaner shows what a flow fix will do before it does it.** For an
  active flow version it lists what comes out automatically, what cannot
  (Decisions and formulas are never rewritten for you — those keep the field
  locked), and what the fix would leave empty. You choose: keep the flow
  running on a new version, or switch it off and delete the active version
  too — or open it in Flow Builder with every location named.

### Fixed
- **Dependencies draws the whole subflow chain.** The tree stopped at three
  levels with "manual review recommended", hiding real subflows below that.
  It now follows a chain as deep as the org goes, and a flow that calls back
  into its own chain is labelled as a loop instead of showing an empty arrow.
- **↻ Retry failed is safe for child records.** Retrying failed child
  records whose parents had been written opened a run with the parent object
  unfiltered — it would have inserted every parent again. Those retries now
  open ⚖ Reconcile, which attaches the children to the parents that exist;
  a mixed retry leaves them out and says so.
- **Dependencies: managed subflows no longer flash "Not found".** When the
  map came from the cache, the tree painted before the managed-package list
  had loaded and never repainted.
- **Tool tabs opened before a Salesforce session exists** show the connect
  screen instead of crashing (Lightning Pages threw on a missing org).
- The Run page's buttons no longer overflow their card.
- ⚖ Reconcile: a child section with nothing to do is one line instead of
  four empty buckets two screens tall; child buckets size to their content.
- **🔒 Lock writes** (was "Read-only") on Connected Orgs now says what it
  is: a safety lock that stops every tool in the extension from writing to
  that org. ⚖ Reconcile shows a locked source or target up front, switches
  the ← controls off for a locked source, and ▶ Run refuses by name before
  anything is written.
- **⚖ Reconcile deletes fail closed.** When the Toolkit cannot confirm that
  the target is a sandbox or dev org, deletes now ask for the typed
  confirmation and hard delete is refused — the same rule production gets.
  Before, only a confirmed production org was guarded.
- **⚖ Reconcile child rows.** A changed child record now has the same
  "▸ fields" compare and 🔗 lookup hand-pick the root rows have, driven by
  the child's own object and mapping; picks made there are honoured by the
  run. The field-by-field compare opens in a wide window instead of inside
  the narrow column, values wrap there, and every value shows its full
  text on hover.
- **Person Accounts deploy.** Salesforce refuses the whole Name on a person
  account ("Unable to create/update fields: Name"), so every such insert
  failed. The engine and ⚖ Reconcile overwrites now send FirstName/LastName
  and leave Name out on those records, and the run says how many. A target
  without Person Accounts gets them as business accounts, and says so. The
  hidden Contact behind each Person Account, which Salesforce creates with
  the Account and refuses as an insert ("Cannot select a person account"),
  is never offered for insert, update or delete; a matched pair still shows
  under 🟢 Synced, tagged 👤, and the header says what happened to the rest.
- **History no longer offers ↩ Roll back for a run that wrote nothing.**
  When Salesforce confirmed every record failed, the button reads "Nothing
  to roll back". A run with an error, an unanswered write or no counts
  keeps the button — unknown is not nothing.
- **Data Deployment, from a live work session:** ⚖ Reconcile no longer
  pre-selects every missing and changed record — nothing is selected until
  you select it (✓ All per column selects a whole bucket on purpose). And
  the Run page counted child objects without the parent filter, so picking
  two parents could read "18 records"; children are now counted inside
  their parents' scope, the confirm shows the count by object, and a count
  SOQL cannot scope is shown as "≤ N", never as the number.
- **The Dependencies map finds subflows again.** The batched metadata read
  the scan moved to was answered by Salesforce with status 200 but without
  the flow's metadata, so every version counted as read with "calls no
  subflows" — the tree showed flows with subflows as Standalone, and ⚙
  Apply reported "could not be read". The read now goes to the Tooling
  batch endpoint, which returns the metadata, and a read that comes back
  without metadata now counts as NOT scanned (⏳) rather than as an answer.
  Use ↻ Rescan once after updating.
- **A retried call can no longer land in a different org.** When a session
  had just expired, the retry used to pick up whichever Salesforce tab was
  open — which could be another org — and re-send the call there. The retry
  now uses only the session of the org the call was made for, and gives up
  otherwise. A transfer is never re-run whole.
- **⚙ API versions — Apply works.** Every apply failed with "could not be
  read" because the flow read was unpacked at the wrong depth. Fixed and
  pinned by a test.
- **⏻ Flow switches ask you to type OFF or ON** in the panel before
  changing anything, the same way ⚙ API versions asks you to type CHANGE
  — a browser OK button is not enough to stop production automation.
- **⚙ / ⏻ work without a dependency scan.** In a large org where the scan
  was skipped, "This org" had no session and every call for it was refused.
- **A metadata deploy is never submitted twice.** If the session dropped
  while the tool was waiting for a deployment to finish, the whole request
  was retried — including the deploy. The wait now reports the job instead.
- **Partial reads are refused everywhere in the transfer engine** — child
  records, hand-picked records and parent scopes, not just the root read —
  and the Seeder wipe refuses a partial Id list rather than reporting a
  full wipe.
- **Seeder with SFTK_ID__c as the match key** no longer overwrites the
  identity stamp with the source row's copied value.
- **Licence gate:** declining, then "Read the terms again", then accepting
  now unblocks the page; and a session refresh can no longer boot a page
  whose licence was declined.
- **Field Cleaner:** "Delete Field" re-enables after a fix started from the
  XML inspector; the delete-error hint no longer says reports are unscanned;
  the confirm for report, layout and Lightning page fixes says a restore
  point is saved (it is) instead of "no undo".
- 🔒 managed flows in the Dependencies list now follow the process-type
  filter buttons.
- **Data Studio, from the re-review of the same audit:** the compare
  screen's per-field push now masks values under the deployment's PII
  policy and refuses a lookup whose match field is PII; an incomplete scan
  read no longer quietly re-runs as a scan without lookups; Run Transfer
  upserting on SFTK_ID__c now writes the identity stamp; a sync-plan job
  that pushes and overwrites takes one restore point and can roll back
  both (an overwrite-only job now takes one too); a fan-out counts as one
  run for the ten-run restore-point cap, so a large fan-out no longer
  evicts its own early legs; ✋ Cancel is available while the restore point
  is being read; retention marks the History cards whose restore point it
  removed; 🪪 Stamp identity and the Seeder's identity-field deploy treat an
  org of unknown type as production; a Custom Setting replace refuses to
  delete the target's rows on any partial or unresolvable read; and the
  rollback limits text now says exactly which later edits are kept.
- **Changing a flow’s API version now takes effect, and says what is running.**
  The deploy package is stamped with the org’s own API version (a package
  stamped with the target version was rejected by Salesforce for any newer
  flow property — reproduced with a check-only deploy). And because a deploy
  only creates a new version, the tool now activates it where the flow was
  active, re-reads the org, and reports the version that is actually running
  — never “activated” from the deploy result alone.
- **Managed-package flows really appear now** in ⚙ API versions and ⏻ Flow
  switches. Salesforce refuses to list flow versions without a filter, so
  the previous read had been failing quietly and falling back to the older
  API, which never returns managed flows. The list is now read per
  definition (one page per 100 flows); a managed flow shows its versions and
  API version with a 🔒 chip, and never gets a Flow Builder link that
  would break (the platform gives those versions no record id). The main
  Dependencies list shows them too, in their own 🔒 section — with the
  plain statement that Salesforce hides their contents from every API, so
  their dependencies are unknown, not empty, and "What uses…" says it could
  not search them.
- **Managed-package flows now appear** in ⚙ API versions and ⏻ Flow
  switches — the panels read the modern FlowVersionView, which includes
  them (the older API omitted them entirely). Their versions are marked
  🔒 managed and are never offered for change: they ship with the package.

### Changed
- **Org Seeder is not included in this release.** It is being hardened
  against larger orgs and will return once its test plan passes — a tool
  that can wipe and reseed whole orgs earns its place with testing, not
  promises. (Data Deployment, Reconcile and the Sync Ring are unaffected.)
- **⏻ Flow switches** and **⚙ API versions** got a visual overhaul:
  compact tables, differences first, clearer on/off and version chips —
  and Flow switches no longer depends on a Salesforce query that failed
  silently in some orgs (every flow falsely showed as not togglable).
- The **Org Seeder's target list** (dev build) now refreshes live sessions
  on every visit, so an org you just logged into appears immediately.

## 1.4.2 — 2026-08-30

### Added
- **⏻ Flow switches** (flow dependency map): switch record-triggered,
  scheduled and platform-event flows off and back on **in bulk, grouped by
  object** — the classic move around a big data load. Deactivation
  remembers each flow's active version, so reactivation restores exactly
  what was running — not blindly the latest — and says so per flow.
- **See before you overwrite.** Updating fields from the record comparison
  now confirms with each field's current value → new value — lookups
  included — before anything is written.

## 1.4.1 — 2026-08-29

The reliability release. Built after real-world runs at scale surfaced
matching and completeness gaps — every fix here makes the tool refuse to
guess rather than quietly be wrong.

### Added
- **🪪 Identity stamp — exact cross-org matching.** One click in the Org
  Seeder's Match key picker deploys a tiny `SFTK_ID__c` field (Text 18 ·
  External ID · unique) to the source and every target, with a permission
  set granting you access. Every deployed record is stamped with its source
  record's own Id — matching becomes exact, immune to renames, duplicate
  names and autonumbers. In Reconcile, **🪪 Stamp identity** makes a
  scan's matched pairs permanent, so records that already exist in the
  target never depend on fuzzy matching again.
- **Field compare, rebuilt.** The per-record comparison shows differences
  first, folds matching fields away, and every pushable row — **lookups
  included** — has a checkbox: tick fields and **✍ Update selected on
  target** writes just those onto that record. Lookups are re-pointed by
  matching the related record in the target; an ambiguous or missing match
  is that field's error, never a guess.
- **Lookups ride updates by default.** Reconcile's Overwrite now resolves
  and writes every safely-resolvable lookup (excluded fields still win), so
  lookup drift the scan flags can actually converge.
- **Match key column + 🔑 Find match keys** in the Org Seeder: see and
  choose the field every object matches on before seeding without deleting.
- **⚙ API versions across orgs** (flow dependency map): compare the version
  every flow is pinned to — and each org's own release — across several
  orgs; change them per flow, per org, with a typed confirmation.
- **Org Seeder configuration pass**: Custom Metadata records, Custom Labels
  (with translations) and Custom Settings seed alongside data, before it.
- **Licence gate.** First run asks you to accept the terms — the tool can
  delete data, and using it is your responsibility. Full EULA + privacy
  policy ship inside the extension.

### Fixed
- **Fetch completeness is now enforced.** If Salesforce says N records
  match but fewer arrive (a dropped page, records changing mid-read), the
  scan refuses to compare and the engine refuses to deploy — with the exact
  numbers. The Reconcile header now proves it: “read N of N source / M of M
  target”.
- **Duplicate names can no longer mis-link.** Everywhere a lookup is
  resolved by matching (engine bridge, Overwrite, per-field push), a value
  matching more than one target record is excluded and named — previously
  the first match silently won.
- **Invisible child records are disclosed.** Children whose parent link is
  blank can never appear in a parent-scoped scan; the scan now counts them
  and says exactly why they are absent.
- A failed count shows Salesforce's actual reason in the cell tooltip
  instead of a bare “?”.

## 1.4.0 — 2026-08-19

Battle-tested at scale: this release was hardened by a live ~1,900-record
load test across three orgs — bulk-upsert insert, update, and both arms in
one job, with every defect it surfaced fixed and regression-tested.

### Added
- **Live runs.** The multi-org run dialog now streams progress per target in
  real time: records read, batches written (updating in place), Bulk API job
  state, and ❌ error rows the moment Salesforce rejects a record — plus a
  ✋ Cancel that stops between batches. The Run Transfer page gets the same
  live error feed.
- **Engine controls everywhere.** Choose the write engine (Auto /
  Synchronous Collections / Async Bulk API 2.0), batch size, and new
  **parallel threads** (1–6) — on the Run page, the
  Reconcile action bar, and the multi-org run dialog. Controls that don't
  apply to Bulk jobs disable themselves and say why.
- **Honest upsert reporting.** Run cards and History now split the arms:
  "100 created · 1,750 updated" instead of lumping updates in as inserts.
- **Reconcile, readable at scale.** Child records group under collapsible
  parent headers with per-parent select-all and a live "n/N selected"
  count; repeated parent warnings collapse into one banner; child sections
  gained their own 🟢 Synced list with links into both orgs.
- **One source of truth.** The topbar SOURCE menu is now the single control:
  it lists every known org, crowns your pick, re-points deployments, keeps
  crown history with one-click restore, and automatically re-baselines
  every pair.
- **PII masking for Number fields.** SSN-type numbers now derive consistent
  fake digits instead of blanking — required-field and positive-amount
  automations in the target keep working, and joins survive.
- **Lightning Pages tells the truth about activation.** Page status now
  derives from the real signal — a page's assignments (org default, app,
  profile) — instead of a status field Salesforce doesn't actually return.
  Pages nobody can see show a new honest state, **Unassigned** ("no
  assignment points at this page — users never see it"): instant cleanup
  candidates. Utility bars are out of the list entirely — their activation
  lives in app definitions, and none of the page tooling applies to them.

### Fixed
- Very large hand-picked runs could die with "URI too long" (HTTP 431/414)
  and write nothing — reads are now chunked, and a transport backstop
  reroutes any oversized query safely through a POST body.
- A run can no longer report **success** over an object that failed
  wholesale, and informational engine notes no longer masquerade as errors
  ("1 error · 2 notes", not "3 errors").
- "In sync" now means the whole tree: child records, attached files, and
  failed file checks gate the verdict on every surface — Reconcile, ring
  cells, the target chooser, the home-page tiles, and the run dialog's
  per-target advice. Unverified is stated as unverified, never as clean.
- A child pointing at the wrong parent is one problem in one place (Link
  differs) — no longer double-counted as "changed" too.
- History's record-links list no longer presents its 200-link display cap
  as the write count.

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
- **Choose sync vs. async for large deploys.** A new Engine
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

## 1.3.0 — 2026-07-27

### Added
- **Standard picklists now show their values** in the Picklist Manager instead of a
  lock banner. Even when Salesforce won't hand over the value-set metadata (common in
  cookie sessions), you get the live value table from the org itself: active values,
  record counts per value, and 🔧 data fixes — only adding/deactivating values still
  happens in Setup. Name resolution also got smarter (Account.Type lives in the
  "AccountType" standard value set, Stage in "OpportunityStage" — the Toolkit now
  knows the naming rules).
- **Standard picklists join the multi-org matrix**: compare a standard field's values
  and per-org record counts across every open org side by side — no more flipping
  between Setup tabs to diff them by eye. The columns are read-only for bulk apply
  and sync (Salesforce owns those value sets), and the matrix says so.
- **Dry run now checks your actual data values** — the #1 reason a passing dry run
  still failed for real: restricted picklists in the target rejecting source values,
  State/Country picklist mismatches ("TX" vs "Texas"), and source text longer than
  the target field. All three are now caught before anything is written, with the
  offending values named. The dry run also lists the target's active validation
  rules, triggers and duplicate rules — the things that can only fire on a real
  write — so a green dry run is honest about what it could and couldn't test.
- **Match owners by the fields you choose**: deployment profiles can now match record
  owners between orgs by Email + Name (default), Username, Alias or Federation ID —
  with case/trim/email normalization — instead of display name only. Two target users
  sharing the same key is never guessed: those records go to your fallback user, and
  the run report says exactly how many owners matched, collided, or fell back.

### Fixed
- **Deep debugger QA, round 2 — ten more confirmed bugs fixed**, the big one being
  trigger analysis that silently never worked (the log parser expected a grammar
  Salesforce doesn't emit — trigger names now parse from real logs, including
  namespaced triggers). Also: live polling now says so when your session expires
  instead of spinning forever; fast log-switching can't render the wrong log anymore;
  deletes report per-log failures instead of claiming success; cross-log search no
  longer counts unreachable logs as "searched, no match" (and tells you how many it
  couldn't reach); truncated logs can't scramble the flow/DML nesting anymore;
  jumping to a line in a huge log no longer freezes the tab; and log lines that
  *look* like HTML event handlers are no longer silently eaten by the page's
  sanitizer — in both the debugger and the full-page log viewer.

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
