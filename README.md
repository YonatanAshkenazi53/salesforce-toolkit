# Admin Toolkit for Salesforce

A Chrome extension for Salesforce admins: retire fields safely, see what uses what, read
debug logs, assign Lightning pages, copy a user's permissions, and move data between orgs
with a plan you can read before anything is written. Everything runs in your browser against
the orgs you are already logged in to. Nothing leaves it.

Open source under the Apache License 2.0. First public release: 1.0.0.

## Two pages

**The Toolkit** (the popup, also a full tab) works on one org at a time:

- **Flows** — versions, backups, delete stale versions.
- **Dependencies** — what uses a field, a flow, a class; the subflow call chain; flow switches
  and API versions in bulk.
- **Debugger** — Apex debug logs opened, filtered and explained; noise hidden; two logs compared.
- **Lightning Pages** — assignments by app, record type and profile; who sees which page; what a
  given user sees.
- **Field Cleaner** — everything that uses a field, item by item: replace it with another field
  (references and stored values), remove it, deprecate it, then delete it.
- **Copy Permissions** — one user's profile, role, permission sets, groups and settings onto
  another, adding only; licence mismatches explained.
- **Flow Access** — grant flows to permission sets in one action.

**Data Studio** (its own tab) works across orgs:

- **Connected Orgs** — the orgs open in Chrome; lock writes, treat an org as production.
- **Data Deployment** — a saved deployment (a root object, the objects under it, how a record is
  recognised in the other org) read from both orgs and sorted into insert, changed, only in
  target, synced and needs a decision. Nothing is ticked for you. Trees go parents first,
  lookups connect, automation can be paused for the run, a long run can be paused and continued.
  Where a name exists twice in one org, Merge makes it one record, value by value.
- **All open orgs** — every deployment against every open org at a glance.
- **History** — every run with its counts and a roll back that deletes what a run created and
  restores what it changed, then verifies.
- **Org Compare** and **Org health**.

## How it treats your orgs

- Read-only until you press a button that writes, and every write has one confirmation that
  names what changes and whether it can be undone. An org you mark as production asks for its
  name as well.
- A write is never reported from the request alone: the org is read again and the receipt
  says what it showed.
- Every change lands in History with its undo, where one exists; where none exists the entry
  says so.
- No telemetry, no server. The only network calls go to your own Salesforce orgs. See
  [PRIVACY.md](PRIVACY.md) for every key the extension stores locally.

## Install

From the Chrome Web Store, or unpacked: clone this repository, open `chrome://extensions`,
switch on Developer mode and choose **Load unpacked** on the repository folder. The store build
is produced by `npm run pack` and leaves the developer-only tools out.

On the first start the extension asks you to accept its terms ([EULA.md](EULA.md)): the tool
can change and delete data in your orgs, and the consequences are yours.

## Development

```bash
npm install
npm run verify      # parse check, lint, every test
npm run pack        # the store zip under dist/
```

Classic scripts, no build step, no framework. Tests live in `test/` (vitest). The fixtures under
`docs/fixtures` seed two trial orgs with the data and metadata the live scripts and the
walkthrough video exercise; `docs/FEATURES.md` describes every feature as shipped, and
`CHANGELOG.md` is what the in-app What's New shows.

Contributions are welcome under the same licence: open an issue first for anything that writes
to an org, and keep the three rules above — read-only by default, one confirmation, verified by
re-reading.

Salesforce is a trademark of Salesforce, Inc. This project is not affiliated with, endorsed by
or supported by Salesforce, Inc.
