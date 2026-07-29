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
