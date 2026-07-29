# Privacy — Admin Toolkit for Salesforce

**Effective date:** July 27, 2026 · **Contact:** yonash53@gmail.com

**The short version: everything stays in your browser.** No servers, no analytics, no
telemetry, no third-party services. The extension talks only to the Salesforce orgs you
have open, using the session you already have.

## Enforced, not just promised

The extension's Content-Security-Policy (`manifest.json → content_security_policy`)
restricts network access to:

```
connect-src 'self' https://*.salesforce.com https://*.force.com https://*.salesforce-setup.com
```

The browser itself blocks any request to any other host. There is no code path to send
data anywhere else — and even a bug (or a compromised dependency; there are none) could
not exfiltrate data past this policy.

## Your Salesforce session

- The extension reads your existing `sid` session cookie (via the `cookies` permission)
  to call the Salesforce REST/Tooling/Metadata APIs on your behalf — the same way the
  browser tab you already have open does.
- Session tokens are held **in memory only**. They are never written to
  `chrome.storage.local`, never logged in exported debug reports (a redaction pass
  strips sid/Bearer patterns at the single log chokepoint), and never sent anywhere
  except the Salesforce org they belong to.
- The extension stores **no passwords and no credentials** of any kind.

## What is stored locally (chrome.storage.local)

| Key | Contents |
|---|---|
| `sftk_profiles` | Your deployment configurations: org URLs, object trees, field mappings, scan results (record ids + match-key values of scanned records) |
| `sftk_history` | Run history (capped at 100 entries): counts, errors, record ids/labels for result links |
| `sftk_orgs` | Known org URLs with your labels, first/last-seen timestamps, cached org type (production/sandbox) |
| `sftk_sequences` | Saved multi-step deployment sequences |
| `ds_working_pair`, `ds_dark_mode`, `ds_activity_log` | UI preferences and view-usage timestamps |
| `apex_log_viewer_*` | Raw Apex log bodies handed to the log-viewer tab |
| `sftk_dep_cache` | Flow subflow-dependency map per org (flow version ids, API names, labels, version numbers, statuses) plus each version's `LastModifiedDate`, so reopening the popup re-reads only what changed. Capped at 3 orgs / 1.5 MB total, least-recently-used evicted; raw flow metadata is never stored |
| `ds_scans`, `ds_scan_results` | Saved comparison results: record ids and match-key values for the records a scan found on each side |
| `ds_ring`, `ds_connections`, `ds_stored_orgs` | Your multi-org setup: which orgs are grouped, which is the source of truth, your labels for them |
| `ds_sched_drift` | Latest scheduled drift-check result: per-org record counts and any errors |
| `ds_readiness_state`, `ds_settings` | Deploy-readiness selections and Data Studio preferences |
| `fc_fix_snapshots` | Field Cleaner undo data: the **full metadata** of flows, layouts and Lightning pages captured before it edits them, so a change can be rolled back |
| `fc_dep\|<org>\|<field>` | Cached field-dependency scan results per org and field |
| `sftk_hotkey_trace` | Active keyboard-shortcut trace: the org and the **name of the Salesforce user** being traced, plus its expiry |
| `sftk_active_run` | In-progress transfer state, so a run survives closing the window |
| `sftk_debug_enabled`, `sftk_debug_entries`, `sftk_debug_meta` | Debug mode: recent API calls with URLs and error text, for the exportable debug report. Session ids and bearer tokens are stripped before anything is written |
| `adbg_custom_profiles`, `adbg_log_font_px` | Debugger presets and reader font size |
| `sftk_dark`, `sftk_tour_*`, `ds_whatsnew_seen`, `sftk_ao_*`, `sftk_schema_version` | Theme, first-run flags, last-seen release, per-view options, storage schema version |

All of it is data **about your orgs, for you**, on your machine. Nothing in this
table is ever transmitted anywhere. Uninstalling the extension deletes all of it,
and **Data Studio → History → "Clear cached org data"** clears the org-data keys
above on demand.

A few short-lived values (an in-flight scan's progress, a pending modal's state)
are held in `chrome.storage.session`, which the browser discards when it closes.

## Permissions rationale

| Permission | Why |
|---|---|
| `cookies` | Read your existing Salesforce session cookie to authenticate API calls |
| `storage` | The local data inventory above |
| `scripting` | Fallback only: if a direct API call is rejected (401), retry it from inside the org's own tab context |
| `alarms` | Opt-in scheduled **read-only** drift checks (record-count queries) with a badge — no background writes, nothing leaves the browser |
| `host_permissions` (salesforce.com family) | The API calls themselves |

The extension exposes **no** web-accessible resources: ordinary websites cannot detect
it, probe its files, or interact with it in any way.
