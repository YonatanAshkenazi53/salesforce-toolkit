# Handover — finish the backlog (written 2026-11-07, for the next model on this repo)

The owner (Yonas; public English name Jonathan) asked for this handover because the Fable
quota was running out mid-work. Read this file, then `docs/BACKLOG.md`, then the memory file
`C:\Users\yonas\.claude\projects\C--Users-yonas-OneDrive-Desktop-Saleforce-Toolkit\memory\project_sf_flow_cleaner.md`
(last entries of 2026-11-06/07). Everything below was true at commit `fa0eda7` on
`work/1.1-dryrun-pii` (pushed). Master is at 1.0.0 and moves ONLY on the owner's word.

## The standard the owner holds you to

- "כל מה שחייב להיות מוסר כדי להסיר שדה חייב להיות מחיק בלחיצת כפתור" — anything that must
  go before a field can be deleted is removable from the tool in one click, with a restore
  point and an undo. This is DONE for 🗑 Delete (every blocker kind, live-proven end to end).
- "תעשה הרבה qa ואיטרציות" — every UI ask: build → run it live in the harness (light AND dark
  screenshots) → critique → fix → repeat; stop only when it is really right. Then `npm run
  verify`, `py -3 -X utf8 scripts/pack_store.py`, commit, push. Never say done without the
  live proof and the CLI read-back.
- Every ask the owner fires in chat lands in `docs/BACKLOG.md` the same turn, and moves to
  Done only with its verification (live run, pinned test, or the owner's own hands).
- After any non-trivial change, append to the memory file (absolute dates).
- Honesty: say what was not tested; "does not reliably return" (never "does not cover") about
  the Tooling dependency index; a refused write is reported as refused.
- Never automate duplicate rules behind a run (the explicit 🗑 button exists because the owner
  asked for it by name; nothing else touches them). Never `taskkill chrome.exe` (the harness
  kills only its own `sftk-headless` processes). Never push master. Push the branch after
  every commit round. Commit messages quote the owner's words and end with the
  Co-Authored-By line the session reminder gives you.
- "Flow Cleaner" is not a tool name (the tab is Flows). Use "Jonathan" in public English text.

## Tooling you will use

- Live harness (headless Chrome + the unpacked extension + CLI sessions):
  `node scripts/dev/headless-studio.mjs <script.mjs>` — scripts export `default async (h)`;
  `h.login('npc')`, `h.popup('fields')` (Toolkit tab), `h.studio('')` (Data Studio),
  `h.eval(js)`, `h.waitFor(js, ms, every)`, `h.sleep`, `h.shot(h.shots + '/x.png')`, `h.log`,
  `h.watchErrors()`, `h.importProfiles(path)`. Screenshots land in
  `%LOCALAPPDATA%\Temp\sftk-headless-shots`. Each run is a FRESH browser profile: restore
  points and History live in that profile, so a delete and its undo must run in ONE script.
- Orgs: CLI aliases `npc` (orgfarm-c449e108c2, the demo/source org) and `npc2`
  (orgfarm-e2c4511b2b, the deploy target). Open one for the owner with the frontdoor URL in
  the personal Chrome profile (`--profile-directory=Default`); never print the URL.
- Gate: `npm run verify` (parse check + eslint globals + 3,691 vitest tests). Pack:
  `py -3 -X utf8 scripts/pack_store.py`. Plain `python` does not exist on this PC.
- Test pins are string pins on the source. Write test edits from a `.mjs` script file
  (`node fix.mjs`), never a shell one-liner: backslashes and backticks get eaten. OneDrive
  sometimes refuses a write right after a read (errno -4094) — wait 2 s and retry.
- Pure helpers live in `sftk-mdapi.js` and are unit-tested through `test/extract.mjs`
  (`extractFunctions(file, [names])`): a helper must be a top-level `function` with its closing
  brace at column 0 and no free module-level consts.

## The demo fixture in npc (leave it for the owner; clean only on his word)

`scripts/dev/live/demo/` — run from THAT folder (`cd scripts/dev/live/demo && node live-fix.mjs`):
`live-fix.mjs` + `live-fix2.mjs` + `live-fix3.mjs` + `live-fix4.mjs` build
`Account.SFTK_Live_Blk__c` (Email) with one of EVERY reference type: 26 blockers across 25
kinds and 9 mentions (`node scripts/dev/headless-studio.mjs scripts/dev/live/fc-demo-scan.mjs`
lists them). Also: a second Email field `SFTK_Live_Blk2__c` so ⇄ Replace is live, a checkbox
`SFTK_Live_Check__c`, `Lead.SFTK_Live_Blk__c` (+ assignment rule, lead mapping),
`Case.SFTK_Live_Blk__c` (+ escalation rule), two reports ("SFTK Live Report" private via the
Reports REST API, "SFTK Live Report (public)" via metadata), the permission set
`SFTK_Live_Access` (a field deployed through metadata has NO FLS for the admin — the Reports
API 404s on the column without it), two demo record types `SFTK_Live_RT_A/B` on Account in
BOTH orgs (visible through permission sets; `rt-demo.mjs`, `rt-demo2.mjs`; the Americas
Account is on type A in npc). Three Accounts hold a value in the field.
Undo, in this order: `live-clean4.mjs` → `live-clean2.mjs` → `live-clean.mjs`; the record
types cannot be deleted through the API (Setup: deactivate, Delete → replace with None, in
both orgs), delete the npc2 permission set `SFTK_Live_RT_Access`, set the Americas Account's
RecordTypeId back to null. The standard Account duplicate rule is never touched.
Re-running the builders is safe (each run adds one more Draft version of the Process Builder
process, which the cleanup removes by query).

## What shipped today (reuse it, do not rebuild it)

- Field Cleaner scan legs for every blocker the index never returns (`scanSupplemental`,
  `fcScopeLegs`), the Process Builder guard, inactive validation rules, lookup filters named
  by their field, the stored-values count audit (`runDataUsage`).
- The 🗑 delete engine: `sftk-mdapi.js` `_sftkMdDeleteTable()` / `sftkMdDeleteSpec(type)`,
  `sftkMdDestructiveFiles`, `sftkMdPackageFiles` (child inside its parent file, SHORT name,
  roots declare `xmlns:xsi` and `xmlns:xsd`), `sftkMdCodeFiles` (label only for ApexPage /
  ApexComponent), `sftkMdBundleFiles`, `_sftkApiVer` ("62.0"), `sftkMdLeadMappingRemove`,
  `sftkMdLookupFilterRemove`. `field-cleaner.js` `fixDelete` → `_deleteFullName` (Tooling
  FullName; FieldSet has none → `<Entity>.<DeveloperName>`; Matching/Duplicate rule by SOQL) →
  `_deleteRestorePlan` (SOAP read / Tooling source / LWC resources / Aura definitions; the
  specials: lookup filter = deploy the field without `<lookupFilter>`, lead mapping = deploy
  the edited XML, Process Builder = deactivate + delete every version) → `_snapshotFix('MdDelete')`
  → write → `gone()` (`_goneByQuery` retries: the Tooling index lags behind a destructive
  deploy) → History undo = `SF_METADATA_DEPLOY` of the saved files (or `SF_PATCH`). Buttons:
  `_fixBtnsHtml` (`fc-del-btn`, `data-way="delete"`), delete-only rows are `.fc-del-pair` (never
  walked by "Everything at once"), badge `fc-badge-del`, gate rows count down (`_afterDelete`).
  `background.js` `SF_METADATA_DEPLOY` takes `testLevel` (production Apex deletes).
- Deploy page: ▸ record marks source-empty fields ∅ by default, a Record Type row, unreadable
  columns dropped and named; the ticks-are-back card is gone; "🧪 Dry run".
- Live proofs: `scripts/dev/live/fc-delete-live.mjs` (`TYPES=a,b UNDO=1` — first kind back
  through ↩ Restore, second through History undo), `scripts/dev/live/fc-e2e-delete.mjs` (every
  🗑 + the flow off + Re-scan + Delete Field → the CLI finds no field; rebuild the fixture
  after), `scripts/dev/live/field-cleaner-blockers.mjs` (the scan legs), `ve-rt.mjs`,
  `ve-empty.mjs`, `fc-usage.mjs`.

## The backlog, in order, with the design already settled

Work each item to the standard: build → live in the harness (light + dark) → iterate →
`npm run verify` → pack → commit + push → BACKLOG row to Done with the proof → memory line.
Before every commit run the regression set: `npm run verify`,
`field-cleaner-blockers.mjs`, `fc-delete-live.mjs` on two kinds with `UNDO=1`, and after a
Field Cleaner change `fc-demo-scan.mjs` must still list 26 🔒 / 9 👀. After a Deploy-page
change: `scripts/dev/live/value-edit.mjs` with `NOWRITE=1`, `ve-rt.mjs`, `deploy-tree.mjs`,
`dryrun.mjs` (see each file's header). Dark mode is checked by toggling `#sftkDarkToggle`
(Toolkit) / `#dsDarkToggle` (Data Studio) and shooting again.

1. **✂ Remove / ⇄ Replace inside each declarative blocker, with the XML shown**
   (owner: "we try to remove, replace the field in the metadata items without breaking them.
   While showing XML"). Build a pure `sftkMdEditField(type, innerXml, obj, field, newField|null)`
   in `sftk-mdapi.js` → `{ xml, changed, how: [strings], refused: string|null }`, structure-driven:
   `<criteriaItems>` whose `<field>` is the field (bare or `Obj.Field`) → removed / renamed;
   list members (`fields`, `recipients/field`, `displayedFields/availableFields`,
   `filterItems`, `duplicateRuleFilterItems`, `matchingRuleItems/fieldName`, `mappingFields`)
   → removed / renamed; formula-ish text (`formula`, `errorConditionFormula`, `recordFilter`,
   a button's `url`) → token swap on Replace (boundaries: `(^|[^A-Za-z0-9_.])field(?![A-Za-z0-9_])`
   and the `Obj.Field` form), Remove refused there; a custom metadata `<values>` → nil / new.
   Post-conditions per type: ValidationRule Remove = `<active>false</active>` (a formula cannot
   lose a reference; inactive does not block, say so); WorkflowRule with no criteria and no
   formula left → refuse ("its only criterion is this field — delete it"); SharingCriteriaRule
   / MatchingRule with no items left → refuse; a rule entry (Assignment/AutoResponse/
   Escalation) that loses its last criterion → drop the entry, the last entry → refuse;
   WorkflowAlert with no recipient left and no ccEmails → refuse; a duplicate rule's filter
   emptied → drop `<duplicateRuleFilter>`; a lookup filter emptied → drop `<lookupFilter>`;
   ApprovalProcess entry criteria emptied → refuse (everything would enter); formula fields,
   buttons, scoping rules → Replace only. Wire a `fixEdit(type, id, name, swap)` next to
   `fixDelete` with the same read → snapshot → deploy → verify (re-read, `sftkMdMentionsField`
   says 0, or the new field is there) → History undo. Give those types `fixable: true` plus
   `edit: { remove, replace }` in `TYPE_CFG`, render ✂/⇄ only for the ways the type has, and
   keep "Everything at once" / "all N" walks from pressing a way a type lacks. Extend the 🔍
   inspector to every type the delete table knows (SOAP read → pretty XML), so the XML is on
   screen before and after. Tests: one pure test per type on fixture XML + wiring pins. Live:
   on the demo field, ✂ on every kind, then ⇄ with `SFTK_Live_Blk2__c` on every kind; CLI
   read-back; `fc-e2e-delete.mjs` still passes; rebuild the fixture.
2. **The XML editor** ("edit the XML and repush it to sf the way they want. Like a vscode"):
   the inspector becomes an editor — a textarea with the record XML (SOAP) or Metadata JSON
   (Tooling), a Deploy button through the same package deploy as 🗑, restore point + History
   undo, the deploy's component failures shown verbatim under the box. Live: edit a validation
   rule's formula, deploy, CLI reads it back, undo puts it back.
3. **The matching kit for parents and tree cards** (owner: "matching of parents selection
   should have all of the features from the pic above", "כולל ההמלצות", "allow to change
   matching for child's", "matching by field"): the Parents synced rows (`_depParentMatchEdit`
   in `studio-deploy.js`, today a single select) and every "matched by" on the This-deployment
   tree cards open the builder's Matching kit (`studio-builder-modals.js` ~line 1130: Single
   field / Composite / External ID, Match on source ↔ target, 🧪 Test this key, 💡 Suggestions,
   `sftkMatchSuggestionsOfDepth`). A parent's key lives in `node.lookupResolutions[field]`
   (`matchField` today; add `matchFields`/strategy and teach `buildLookupCompareMap` and the
   bridges in `background.js` to use a composite). Live on the Accounts-tree fixture
   (`docs/fixtures/complex-deployment/profiles.json`, npc → npc2 only).
4. **Scan everything on open; a changed key re-reads the object and its children; Rescan all;
   Refresh state does the same** (owner's words in BACKLOG). Opening a deployment reads every
   object (parents outside it included) without pressing Count/Scan; a changed matching field
   re-scans that object and its children only; "What the two orgs hold" gets a Rescan all
   button; the Deploy page's Refresh state scans everything.
5. **PII suggestions on the Deploy page** ("its kinda hard"): suggest the policy for ALL
   inserted records with a good example per field, show which record the example comes from,
   show the treated values inside ▸ record ("written as (treated)"), offer "Suggest for all"
   (every record of the deployment) and "Suggest for this record" from its editor. The engine
   is `sftk-pii.js` (persona per record, audit) — reuse it; the builder's suggestion rows are
   the starting point. Live on the Leads fixture; the audit must stay clean.
6. **Per-field before/after values in the History JSON export** (promised on r/salesforce,
   2026-11-03, to Muted_Jellyfish_6784; NOT shipped): the entry of an update run stores the
   old and new value per field (counts-only mode strips them); `histExportPayload` carries
   them; a test pins the shape; a live update run exports them.
7. **The 1.1 QA sweep** ("הרבה qa ואיטרציות על כל הדברים שעשינו בשביל 1.1", "ו-qa"): one row
   per 1.1.0 CHANGELOG bullet in `docs/QA-1.1.md` — what was run live (harness, light + dark),
   what was found, what was fixed, iterated until right. Cover ⇄ Replace on every fixable kind
   ("לכל המטאדאטה ב-Field Cleaner יש לנו גם פיצ'ר של replace") and the regression set above.
   Treat every finding as a bug to fix in the same sweep, with its own test pin.

Waiting for the owner's word (do not do these): the demo fixture clean-up, master
fast-forward, the 1.1.0 store submission (`dist/salesforce-toolkit-v1.1.0-store.zip`), the
LinkedIn post, and the question whether Paths / record-type picklist values / controlling
picklists / search layouts should be read as mentions. Older, not started: 1.1 walkthrough
video chapters (record in DARK, Activity chapter instead of History), delete-zone count
refresh after a fix, the dark-mode Cancel in `sftkConfirm`, the WhatsApp RTL bug.

## Pitfalls met today (so you do not meet them again)

- readMetadata answers use `xsi:nil` / `xsi:type="xsd:string"` with prefixes declared on the
  SOAP envelope — a package file must declare both on its root (done in the builders).
- A restored duplicate rule needs its OWN `<sortOrder>` = the count at delete time (the
  filter items carry a sortOrder first — use the last one).
- A Tooling PATCH of a CustomField's Metadata is refused ("insufficient access rights on
  cross-reference id"); deploy the field inside `objects/<Obj>.object` instead.
- `ScopingRule` is not in the CLI's source registry: deploy it as `RestrictionRule` with
  `<enforcementType>Scoping</enforcementType>`.
- `describe/compactLayouts` lists only ASSIGNED compact layouts; an object-scoped custom quick
  action is listed as `Account.X` (its describe takes the bare name); `MatchingRuleItem.Field`
  is the field's Id for a custom field; a deployed record type is invisible to the admin until
  a permission set grants it.
- The Tooling index lags a moment after a destructive deploy of code — re-read with retries.
- `SF_QUERY` on a field without FLS says "No such column"; the ▸ record dialog now drops such
  columns and names them.
- An Apex class refuses a `<label>` in its meta; `apiVersion` must be "62.0", not "62".
- A screenshot taken 1.2 s after the dark toggle can catch a `.btn` background mid-transition.
