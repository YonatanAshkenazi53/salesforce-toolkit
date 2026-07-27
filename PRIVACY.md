# Privacy — Salesforce Toolkit

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
| `adbg_custom_profiles`, onboarding flags, `sftk_schema_version` | Debugger presets, first-run flags, storage schema version |

All of it is data **about your orgs, for you**, on your machine. Uninstalling the
extension deletes all of it.

## Permissions rationale

| Permission | Why |
|---|---|
| `cookies` | Read your existing Salesforce session cookie to authenticate API calls |
| `storage` | The local data inventory above |
| `activeTab` | Identify the org of the tab you invoked the popup or trace hotkey from |
| `scripting` | Fallback only: if a direct API call is rejected (401), retry it from inside the org's own tab context |
| `alarms` | Opt-in scheduled **read-only** drift checks (record-count queries) with a badge — no background writes, nothing leaves the browser |
| `host_permissions` (salesforce.com family) | The API calls themselves |

The extension exposes **no** web-accessible resources: ordinary websites cannot detect
it, probe its files, or interact with it in any way.
