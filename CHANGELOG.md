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

- **✂ on a validation rule: three ways, chosen in the dialog** (2026-11-10). ✂ Remove the field’s conditions — every condition that uses the field is taken out of the formula (through `&&`, `||`, `AND( )`, `OR( )` and `NOT( )`, nested; a rule may test several fields, and the same field more than once) and the rule stays active on the rest. ⏻ Switch the rule off — the formula stays as it is. ✎ Edit the rule myself — your text is what is deployed. The diff and the button follow the choice. When the rule cannot work without the field — every condition uses it, or only a bare TRUE / FALSE would be left — Remove is greyed out with the reason and the switch-off is preselected.
- **✂ / ⇄ show what will change before you confirm** (2026-11-10). The confirmation of a Remove or Replace on a page layout, a Lightning page, an email template, a report or a report type now carries the diff — the lines that go in red, the lines that come in green — worked out from the component as the org holds it right then. Blockers already showed theirs; a flow keeps its numbered plan.
- **Field Cleaner reads every email template** (2026-11-10). Salesforce's dependency index lists few templates, so the scan now reads the text of every one — classic text and HTML, Lightning, Visualforce — and lists those that name the field of this object, each with the email alerts that send it. One more API call per scan (paged on a large org).
- **⏸ The pause panel lists scheduled flows too** (2026-11-10). A schedule-triggered flow that starts on an object the deployment writes is listed under it, marked ⏰ and unticked — it runs on its clock, not on a write; tick it to keep it from firing mid-run. Works on packaged objects like every other kind.
- **🎭 The PII suggestion window reads at a glance** (2026-11-10). One line on top and the long explanation folded away; a bar that counts the ticked fields with ✓ Suggested / All / None; a card per object; each field is one row — tick, the field and why it is offered, what it is written as — with its examples under it. The Apply button says how many fields it applies to.
- **The Deploy page's actions sit with the orgs** (2026-11-10). 🎭 Suggest PII, the scan of every object and ✓ Tick every insert moved from under the table into the "Between which orgs" card. Scan all and Rescan all are one button: it reads every object, and says which ones were never read.
- **⏻ Flow switches shows the switch, not the API version** (2026-11-10: "אין צורך להציג שם גרסאת api"). Each row carries ON/OFF and the flow version that runs; the API version lives in ⚙ API versions.

### Data Studio
- **The matching section reads in layers** (2026-11-08: "זה גם צריך ui יותר טוב. זה מאוד לא ברור"): the key as one
  sentence on top — "Key · Account Name · Two records are the same when this field is equal on both sides" — with
  🧪 Test and 💡 Suggestions beside it; the strategy and its fields under it; Normalize and Most specific first
  folded under "Advanced" (open only when something is set); the suggestions as a table — key · score · a short
  reason · Use / Grade — with the grade's detail under each row, the depth sentence said once above the table,
  and the fields that add almost nothing named in ONE line instead of one sentence each.
- **⏸ The pause panel is three tabs** (2026-11-08: "צריך להראות רק אם מסמנים את המטאדאטה שרוצים לעצור… ולעשות 3
  טאבים עם פירוט מובן"): ⏸ Flows · ⏸ Validation rules · 🔁 Duplicate rules — a tab appears only when its option is
  on, carries its count ("2 of 3" once something is unticked), opens with one plain sentence on what the run does
  with that kind and when it comes back, then the objects this run writes with their items, "N of M ticked" and
  all / none per object; the one-line summary stays under the tabs. Live on npc2 (pause-panel.mjs, light + dark).
- **▸ record: the Owner row** (2026-11-08: "we need to show ownerid and to make sure user can select queues or
  users"). Right under Record Type: the source owner by name (👤 a user, 👥 a queue), what the run would write by
  default said in words (the owner mapping is off unless the deployment switched it on; a queue is never matched
  by name), and a search over the target's active users and — where the object can be queue-owned — the queues
  that take it. A pick is stored as the value OwnerId and written after the engine's own owner mapping, like any
  typed value; ✕ forgets it. Live on npc → npc2 (scripts/dev/live/ve-owner.mjs): "Account records cannot be owned
  by a queue — users only", a user picked and stored, cleared.
- **⏸ The pause panel: what this run switches off in the target, per object, with a tick on every item.**
  (2026-11-08: "צריך להציג למשתמש את מה שמכבים כשעושים דיפלוי עם אפשרות לבחור לפי האובייקטים" — flows,
  duplicate rules and validation rules.) With ⏸ pause flows, ⏸ pause validation rules or Duplicate rules =
  Bypass chosen, the Deploy page lists under each object the deployment writes to the record-triggered flows
  and validation rules that go off and the duplicate rules the bypass header passes; every item has a tick,
  each object has all / none, and the unticked stay exactly as they are. The confirmation names what is left
  on "by your choice", the duplicate-rule bypass is sent only for the objects ticked (the engine's header is
  per write), and an object with nothing to switch is said in one line. Live npc → npc2: Account's two flows
  off and back on, Contact's flow left on (CLI mid-run), Contact's duplicate rule respected, rollback clean.
- **🎭 PII suggestions on the Deploy page, with the record each example comes from.** "Suggest PII
  treatment for all N to insert" reads the very records the deployment inserts and proposes a treatment per
  field, each with real examples and the record they come from ("Omer → Lior, in Omer SFTK CX Lead One").
  ▸ record shows, under every field the policy covers, the value that is actually written ("🎭 written as
  Lior"), and offers the same suggestions for that one record.
- **The History export says what an update changed, field by field.** A run that updates records now keeps,
  for every field it changed, the value the target held just before the run and the value written; a
  run's JSON export lists them (`fieldChanges`: object, record, field, before, after). The first 200
  updated records per object are kept; a field under the PII policy keeps no "before"; counts-only mode
  keeps no values at all.
- **Opening a deployment reads every object in it.** No more "not counted yet" cards and Count buttons
  to press one by one: when a deployment opens, the root and every child are read in both orgs, parents
  before their children, and the parents outside the deployment are checked right after. 🔄 Rescan all
  (on "What the two orgs hold") and 🔄 Refresh state read every object again, read before or not. When
  you change how one object's records are matched, only that object and its children are read again.
- **The Matching kit everywhere on the Deploy page.** Every card of "This deployment" says how its records
  are matched and has ✏ matching, which opens that object's full Matching kit — single field, composite,
  external ID, 🧪 Test this key and 💡 Suggestions — right there. A parent outside the deployment gets its
  own kit too: single field or external ID, the field on both sides, suggestions graded on the live data
  of both orgs, and Test this key. (A key of several fields for a parent outside the deployment is not
  offered yet — the lookup that links a child to its parent matches one field; the dialog says so.)
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
- **Field Cleaner: the scan has a progress bar with the time left** (2026-11-08: "can we show a progress bar with
  estimation?"). Under the cat, one segment per leg of the scope (the index, Lightning pages, report types, list
  views… up to 17), filled as each leg ends, the current one pulsing; under it "Step 6 of 17 · quick actions ·
  about 17 s left · 20 places so far" — the time left from the legs already done and a weight per leg, said once
  two legs are behind. The "Act on everything" fold and the "How each item is fixed" fold are gone ("we dont need
  this one", "i dont think we need the act on everything").
- **Field Cleaner: the 👀 mentions get the ways too, the confirm is editable, the gate sits on top** (2026-11-08, the
  owner's hand test: "why here we can't do anything? i want also email alerts, lightning email templates and classic
  email templates", "we can't edit here", "the remove all & replace all button … on top of the card", "maybe it
  should be on top?", "what is the point of all this info").
  - **Email templates** — classic text and HTML, Lightning, Visualforce — get 🔍 (the subject, body, HTML and
    markup with the field's lines marked), ✂ Remove (every merge field that names the field taken out of the
    texts), ⇄ Replace (renamed inside them) and ✎ Edit texts, through the EmailTemplate record; a restore point
    puts the texts back, History undo verified by re-reading. Email alerts already had ✂ / ⇄.
  - **List views, compact layouts, quick actions and inactive validation rules** get ✂ / ⇄ / ✎ / 🗑 like the
    blockers (a view's column and filter, a numbered filter logic refusing ✂; a compact layout's field but not its
    last; an action's layout field and predefined value; an inactive rule's formula by ⇄).
  - **"✎ Edit the XML before deploying"** inside every ✂ / ⇄ confirm (and a code file's text in the code ⇄): the
    proposal in a box, well-formed or the button stays off, the name locked, and the deploy sends what the box holds.
  - **⚡ Everything at once** sits on the 🔒 section card's header (or the 👀 card's when no blockers are listed),
    not in the header bar; the **🔒 gate** (the chips, the Delete button) sits above the lists, and in the 👀 scope
    it is one sentence with a 🔍 Everything button instead of twelve chips saying "hidden".
  Live on npc: ⇄ on the three demo templates → the CLI reads the new merge field, undo → the originals; ⇄ on the
  list view (column + filter), the compact layout, the quick action and the inactive rule → CLI, undo; ✂ on a
  validation rule with a hand edit in the dialog → the CLI reads the edited description, undo → original.
- **Field Cleaner: every kind has its ways, and the page reads in one glance** (2026-11-08, the owner's hand test:
  "למה אין החלפה פה", "ועריכה של xml", "צריך להיות בכולם", "this section needs to improve… nobody will read it",
  "we need everything to support replace all, remove all", "we need a collapsable ui there like we did for parents").
  - **Code**: an Apex class or trigger, a Visualforce page or component, an LWC or an Aura bundle gets 🔍 with every
    file and the field's lines marked, **⇄ Replace** as a whole-word rename of the field's API name in every file
    (the diff of each changed file confirmed first), and **✎ Edit code** — one box per file, deployed back as the
    whole component. ✂ is not offered on code: which line of a program goes is yours, in ✎. In a production org the
    deploy runs the org's Apex tests when Salesforce asks for them. Restore point, History undo verified by
    re-reading the source (line endings aside).
  - **Duplicate rules** get ✂ / ⇄ / ✎ like every other declarative kind — your own click, the diff first, a restore
    point. Nothing switches a duplicate rule off or edits one behind a deployment (that rule stands).
  - **The 🔒 box under the results** is one header, one chip per kind (click → its group; the tooltip says its
    ways) and one sentence; the count follows every fix.
  - **⚡ Everything at once** and the group "… all N" buttons cover every kind with a way: ⇄ for all of them (code
    too), ✂ where the kind can lose the field; a Remove walk names the Replace-only kinds it left out. The two
    counts differ on purpose (live: Replace all 25 · Remove all 15).
  - **The header folds** into three sections — The field's data · Look further than the index · Act on everything —
    each with a one-line summary when folded, remembered.
  - The Reports row says the scan itself read every custom report type (it always did).
  Live on npc (scripts/dev/live/fc-code-edit.mjs): ⇄ on the LWC → the CLI reads the new import, 0 of the old; ⇄ on the
  duplicate rule → the retrieve shows the new field in the filter; both undone through History, the CLI reads the
  originals back.
- **Every long load shows the cat, a bar, the step and the time left** (2026-11-08: "when we scan these on
  enterprises it may take time. i want to show the animation and progress + estimation every loading that might
  take time"). One widget (sftk-progress.js) for three shapes of work — a fixed order of steps (one segment each),
  N of M items (a filling bar), or one long call (a sweeping bar, with how long it took last time in this org) —
  on the Flows list, the Dependencies scan (with Stop, in the tab and in the strip above the Flows list), ⏻ Flow
  switches and ⚙ API versions (the three list reads, then one versions page per 100 flows), Lightning Pages, Flow
  Access (three steps) and Copy Permissions (five steps). Nothing is estimated before it can be: the line says
  "estimating…", then the seconds so far, then the time left.
- **Flows › Versions: a flow tree is a card too** (2026-11-08: "this still looks bad, should look more like the
  other pages"): the flows the dependency map knows to call each other sit in one bordered card — the root, its
  subflows nested with a twig per level, "tick the whole tree" in the header (half-ticked when only some are),
  "🌳 tree · N flows · M levels deep" — in the list's own alphabetical order.
- **The packaged fixture has a tree of every flow kind** (2026-11-08: "scheduled triggered. screen flow with child
  screen flow, record triggered with subflows, record triggered with a scheduled path"): SFTK_Pkg_Screen →
  SFTK_Pkg_Screen_Child (a screen flow) → SFTK_Pkg_Screen_Leaf; SFTK_Pkg_Parent_Trigger on the packaged Lookup
  Parent with two subflows — the immediate path calls SFTK_Pkg_Path_Now_Sub, a scheduled path an hour later calls
  SFTK_Pkg_Path_Later_Sub → SFTK_Pkg_Path_Deep_Sub; next to the record-triggered and scheduled trees already there.
  Deployed to npc and npc2.
- **Field Cleaner: one scan, one list** (2026-11-08: "i dont think we need 3 tabs here. one tab is enough, but
  should be filtered by must and optional metadata references"). The 🔍 / 🔒 / 👀 scope switch is gone — every
  scan reads everything — and the two sections became one list with a filter row: All · 🔒 Must fix · 👀 Might
  break; each group carries its tag. The 👀 sentence in the gate says those kinds WERE read and what happens to
  them ("do we scan them as well?"); the ⚡ row says why ⇄ counts more than ✂ ("i can replace more than i can
  remove?": code, formulas, buttons and field updates can only swap the field, not lose it).
- **Full metadata text scan** (the whole-org sweep, renamed — "it scans a lot more than reports", "change it to
  full metadata text scan"): the offer says it is expensive and slow and what the cost is made of; pressing it only
  counts, and the exact API calls and time are shown before anything is read ("say how many api calls it will
  cost"). A hit the everyday scan already lists is not listed again ("this table should not list whats in the
  other sheet"); a fresh hit of a kind the list fixes — Apex, Visualforce, LWC, validation rules, buttons, field
  sets, formulas, workflow, approvals, sharing, matching and duplicate rules, Lead/Case rules, custom metadata,
  list views, compact layouts, quick actions — JOINS the list with the ✂ ⇄ ✎ 🗑 of its kind ("Can we do a remove
  and replace on them as well?"); the rest stay in the box, marked "by hand". ⬇ Export CSV writes every line that
  names the field ("make sure the user can export this report as well"). A retrieve that runs long says how long
  it has run ("stuck at 2 prcnt": Salesforce reports nothing until a retrieve lands).
- **A flow tree is a card** (2026-11-08: "לא רואים שזה עץ. פשוט צריך לעשות tick all ואפשרות לבחור"): in ⏻ Switches
  and ⚙ API versions a flow with subflows is drawn as a bordered card — a header with "tick the whole tree" (it
  follows the rows: half-ticked when only some are), "🌳 tree · N flows · M levels deep" (API versions: the oldest
  API in the tree), one line saying what switching the root does — and the subflows nested under the root with a
  twig per level; inside a card the chips name only flows outside it. The **Flows › Versions list scrolls again**
  ("אי אפשר לעשות סקרול למטה"): the view's wrapper did not carry the flex column, so the list grew past the tab and
  the flows below the fold could not be reached.
- **⏻ Flow switches and ⚙ API versions show the flows as a hierarchy** (2026-11-08: "we need to show it as
  hierarchy on load … both on switchers and api versions", "they look like a normal flow"). A flow that calls
  others has its callees nested under it with a connector, as soon as the dependency map knows the links; a subflow
  leaves its own kind-group for its caller's (so a record-triggered flow on an object shows its subflows under that
  object), each flow placed once — a shared subflow under its triggered caller before a plain autolaunched one. A
  subflow whose caller is not in the list carries an "↳ SUBFLOW" tag; the chips are grouped by direction. Live on
  npc: the four dep-test levels nested under their Account trigger, the packaged SFTK_Pkg_Sub under SFTK_Pkg_Child
  Trigger ("Lookup Child 2"), SFTK_Pkg_Sched_Sub under the scheduled flow.
- **⏻ Flow switches: the whole chain** (2026-11-08: "we need a way to select the whole tree or just some of them"):
  next to "↳ calls N" a dashed "⇊ whole chain down N" when the chain goes deeper than one level, and "⇈ every
  caller up N" next to "↰ called by"; the tooltip names every flow in order, a click ticks them all; nothing is
  switched until the button is pressed.
- **🧭 Field Cleaner's whole-org text sweep** (2026-11-08: "מורידים דרך vcs פרויקט שלם של סילספורס ואז מחפשים
  שם api של שדה… לחלק לדברים שחייב למחוק או לשנות ודברים שטוב לדעת"). Under the scan's results, one button
  reads the org's own metadata as a whole — the Metadata API lists every kind, then retrieves them a few
  hundred components at a time — and finds every text file that names the field. Each hit is shown with its
  component, file and line, sorted into 🔒 must go or change before the delete (the kinds Salesforce refuses
  the delete for) and 👀 will break or lose the field (search layouts, related-list columns, record-type
  picklist values, Aura markup, LWC HTML, templates, reports, translations, permission sets, profiles…),
  marked "in the list above" when the scan already lists it. The cost is said before anything is read
  (components, retrieves, API calls, a time estimate), a progress bar with the time left runs on the page,
  and Stop keeps what was read. Nothing is written. Not read: static resources, documents, content and site
  assets, settings, certificates, installed packages. Live on npc: 1,127 components in 5 retrieves, about a minute,
  29 🔒 / 57 👀 (44 of them profiles' field access), 52 of them not in the scan's list.
- **⏻ Flow switches lists every flow, not only the triggered kinds.** A colleague's first day with the tool
  (2026-11-08): scheduled, autolaunched and screen flows were missing from the list, which showed only
  record-triggered, scheduled and platform-event flows and read the org's flow list one page deep. The
  panel now reads every flow definition, every page of it: record-triggered flows stay grouped by object,
  every other flow sits under its kind (screen flows, autolaunched subflows, Process Builder, Omni-Channel
  routing, appointments, approvals…). A flow with no trigger can be switched too, and its line in the
  confirmation says what switching it off breaks. After the dependency scan each row shows "↳ calls N" and
  "↰ called by N"; a click ticks those flows as well, so a subflow goes off with its caller. A record-triggered
  flow on a packaged object whose label is missing groups under the object's API name. Live on npc: 138 of
  138 flows listed in ⏻ Switches and in ⚙ API versions.
- A long line in a confirmation's item list wraps instead of crushing the item's name to a sliver.
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

