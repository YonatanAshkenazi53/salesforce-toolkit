# Chrome Web Store listing — Admin Toolkit for Salesforce 1.0.0

A NEW listing (the user's decision, 2026-09-26): version 1.0.0, name unchanged. Paste the
blocks below into the developer dashboard; the screenshots are in `dist/store-shots/`
(1280×800, taken from the packed build by `scripts/dev/live/screenshots.mjs`).

## Name
Admin Toolkit for Salesforce

## Summary (132 characters max)
Flows, data deployments between orgs, permission copies, Lightning page assignments, field cleanup and debug logs — from your open tabs.

## Description

Admin Toolkit for Salesforce works through the Salesforce tabs you already have open — no
separate login, no server in between. Nothing about your data leaves your browser except
to talk directly to your own orgs. Anything that can change something in Salesforce shows
you what it is about to do and asks first: a checkbox, a typed word for anything permanent,
and the org's name when the target is production. Where a tool reads the org back
afterwards it says "verified"; where it can only report what Salesforce answered, it says
that instead.

THE TOOLKIT (the popup)
• Flows — every flow with its versions. Delete the versions you tick (backup offered
  first; paused interviews and calling flows checked), back versions up as a file, restore
  a backup as a new Draft.
• Dependencies — what calls what, "what uses…" a field or value, blast radius, call
  chains, export. Flow switches turn record-triggered and scheduled flows off and back on
  at the version that was active. API versions move flows to a newer API version and
  verify what runs.
• Debugger — start a one-hour trace for a user, read logs line by line with automation
  analysis, compare two, open one in its own tab.
• Lightning Pages — every record page and its assignments (org default, app default,
  app + record type + profile); add, remove, deactivate, clone; "who sees what".
• Field Cleaner — everything that references a field, fixed automatically where it safely
  can be; replace the field with another one instead of removing it, copy its access and
  stored values; deprecate first; delete when nothing is left.
• Copy Permissions — one user's profile, role, permission sets and groups onto another,
  adding only.
• Flow Access — grant flows to permission sets in one action.

DATA STUDIO
• Connected Orgs — the orgs open in Chrome; rename, lock writes, treat an org as production.
• Data Deployment — a saved deployment opens on one page: both orgs are read, every
  record sorted into insert / changed / only in target / synced / needs a decision, nothing
  ticked for you. A whole tree in one run, parents first; lookups connect; record-triggered
  flows, validation rules and duplicate rules can be paused or bypassed for the run; retry
  the failed ones; an identity field makes matching exact across orgs.
• All open orgs — every deployment against every open org at a glance.
• History — every run with its counts, CSV/JSON export, and Roll back, which deletes
  what a run created and restores what it changed, then verifies.
• Org Compare — record counts of any objects between two orgs.
• Org health — one card per finding, each with its API cost first.

Everything stays on your PC (chrome.storage.local). No analytics, no account, no server.

## Category
Developer Tools

## Permission justifications (the dashboard asks for each)
- **cookies** — to read the Salesforce session cookie (`sid`) of the org tabs you already
  have open, so the extension can call the Salesforce APIs as you, without a separate login
  or a Connected App. It never reads cookies of any other site.
- **storage** — your saved deployments, History, settings and cached org reads, on this PC
  only (`chrome.storage.local`). Nothing is sent anywhere.
- **scripting** — to read the org's identity (which org, sandbox or production) from the
  open Salesforce tab, so writes to production can ask for the typed org name.
- **alarms** — to keep a long-running deployment's progress alive in the service worker.
- **Host permissions (salesforce.com, force.com, salesforce-setup.com and their
  `my.`/`develop.` variants)** — the Salesforce REST, Tooling, Metadata and Bulk APIs are
  called on the org's own domain; nothing else is contacted.

## Single purpose
Administering Salesforce orgs (flows, fields, pages, permissions, debug logs) and moving
records between Salesforce orgs, through the user's own open Salesforce sessions.

## Data usage disclosure
Does not collect or transmit user data. All data read from Salesforce stays in the
browser; the only network calls go to the user's own Salesforce orgs.

## Privacy policy
PRIVACY.md (ships in the package) already lists every storage key, including the ones added
since the last public copy (`sftk_orghealth`, `sftk_flow_run_paused`, `sftk_vr_run_paused`,
`sftk_terms_accepted`). Replace the public gist's text with the current PRIVACY.md so the two
read the same, and paste the gist URL into the dashboard's privacy-policy field.

## What's new (1.0.0)
The first public release — see the 1.0.0 section of CHANGELOG.md (the in-app What's New
renders it).
