# Salesforce Toolkit — Development Guide
## How to safely work on Data Studio without breaking the popup

---

### File ownership map — never cross these lines

| Area | Edit ONLY these files |
|------|----------------------|
| **Popup** (the 420px extension popup) | `popup.html`, `popup.js`, `styles.css`, and the feature scripts: `dependency-map.js`, `conflict-scanner.js`, `lightning-pages.js`, `user-copy.js`, `license-manager.js`, `flow-permissions.js`, `field-cleaner.js`, `record-copy.js` |
| **Data Studio** (the full-page tab) | `studio.html`, `studio.js`, `studio.css` |
| **Both (shared — be careful)** | `background.js`, `debug-logger.js`, `manifest.json` |

### CSS namespacing — why they can't conflict

- `styles.css` — loaded **only** by `popup.html`. No prefix on class names.
- `studio.css` — loaded **only** by `studio.html`. All classes prefixed with `ds-`.

Because they're in completely separate HTML documents (popup is a browser-action popup, studio is a `chrome.tabs.create` tab), the CSS files can never reach each other. You can change `styles.css` freely without touching studio, and vice versa.

### background.js — the one shared danger zone

`background.js` is the service worker loaded by the extension itself (not by any HTML). Both the popup and the studio send messages to it. Rules:

1. **Never remove or rename an existing `case` in `dispatchMessage()`** — the popup depends on all of them.
2. **Adding new message types is always safe** — just add a new `case`.
3. **Changing `getSfSession()` or `getAllSfSessions()`** affects both popup and studio. Test both after any change.
4. **Changing `executeProfileTransfer()`** only affects the Data Studio. Safe to edit freely.
5. **Changing `buildCopyFields()`** only affects `executeProfileTransfer()`. Safe.

### How to test after changes

**Popup only changes (styles.css, popup.js, feature files):**
1. Go to `chrome://extensions`
2. Click the refresh ↺ icon on Salesforce Toolkit
3. Open the popup and test your feature
4. Quick check: click "🌐 Data" to confirm studio still opens

**Studio only changes (studio.css, studio.js, studio.html):**
1. Go to `chrome://extensions`
2. Click refresh ↺
3. Open the popup → click "🌐 Data"
4. Quick check: click a popup tab (Flows, Pages, etc.) to confirm popup still works

**background.js changes:**
1. Go to `chrome://extensions`
2. Click refresh ↺
3. Test BOTH: popup tabs AND Data Studio
4. Open the Service Worker console (`chrome://extensions` → Salesforce Toolkit → "Service Worker") and check for errors

### Storage keys — don't collide

| Key | Owner | Used by |
|-----|-------|---------|
| `sftk_profiles` | Data Studio | studio.js, background.js (alarms) |
| `sftk_history` | Data Studio | studio.js |
| `sftk_orgs` | Data Studio | studio.js |
| *(no prefix)* | Popup | popup.js (session state is in-memory only) |

Popup features do NOT persist to chrome.storage. All popup state is in-memory per session. Only Data Studio uses chrome.storage.local.

### Quick debugging reference

| Problem | Where to look |
|---------|---------------|
| Popup blank / broken | F12 on popup → Console |
| Studio blank / broken | F12 on studio tab → Console |
| API calls failing | `chrome://extensions` → Salesforce Toolkit → **Service Worker** → Console |
| Schedule not firing | Service Worker console, look for `[SFTK] Scheduled sync error` |
| Storage corrupt | Service Worker console: `chrome.storage.local.get(null, r => console.log(JSON.stringify(r,null,2)))` |
| CSS not applying | Hard refresh with Ctrl+Shift+R after extension reload |

---

### Terminology (use consistently across AI chats)

- **Org Map** = the visual data relationship tree for a single org (built in Profile Builder)
- **Profile** = a saved Org Map with a name, optional WHERE clauses, and optional schedule
- **Transfer** = one execution of a profile (source → target, creates records)
- **Data Studio** = the full-page tab (`studio.html`) — the multi-org data tool
- **Popup** = the 420px browser-action popup (`popup.html`) — the flow/user/field tools
- **Session** = the Salesforce `sid` cookie read from Chrome (no OAuth needed)
