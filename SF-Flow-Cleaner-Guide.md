# SF Flow Cleaner — Chrome Extension
## Complete Build Instructions + Chrome Web Store Publishing Guide

---

# PART 1 — CLAUDE CODE PROMPT

Copy and paste the following prompt into Claude Code to generate the full extension:

---

```
Build a Chrome Extension (Manifest V3) called "SF Flow Cleaner" for Salesforce.

═══════════════════════════════════════════════
FEATURE REQUIREMENTS
═══════════════════════════════════════════════

1. SESSION DETECTION
   - Inject a content script into Salesforce tabs (*.salesforce.com, *.lightning.force.com)
   - Extract the session token (sid) from cookies and the org base URL from window.location
   - Pass both to the popup via chrome.runtime messaging

2. FLOW LISTING — FETCH ALL FLOWS AND ALL VERSIONS
   - On load, fetch EVERY flow and EVERY version in the org using the Tooling API.
     Handle pagination via nextRecordsUrl so no flows are missed:
       GET /services/data/v62.0/tooling/query
       ?q=SELECT+Id,MasterLabel,ApiName,VersionNumber,Status,ProcessType,Description
          +FROM+Flow+ORDER+BY+MasterLabel+ASC,VersionNumber+ASC
     Keep fetching nextRecordsUrl until done. Store all results in memory.

   - Group versions by MasterLabel. Render one collapsible group per unique flow name.
     Default state: all groups collapsed.

   EACH FLOW GROUP renders as:
   ┌─────────────────────────────────────────────────────┐
   │ ☐  ▶  My Approval Flow          3 versions   🔗     │
   └─────────────────────────────────────────────────────┘
   - Left checkbox = "select ALL versions of this flow"
     Checking it checks all version rows inside. If some but not all versions are
     checked, show the checkbox in indeterminate state (−).
   - ▶ arrow = expand/collapse the version list
   - Version count badge (e.g. "3 versions")
   - 🔗 icon if this flow is used as a subflow (from dependency map)
   - Clicking anywhere on the row (except the checkbox) expands/collapses

   EACH VERSION ROW (visible when group is expanded):
   ┌──────────────────────────────────────────────────────┐
   │    ☐   v3  ● Active   Screen Flow                    │
   │    ☐   v2  ○ Obsolete  Screen Flow                   │
   │    ☐   v1  ○ Obsolete  Screen Flow                   │
   └──────────────────────────────────────────────────────┘
   - Individual checkbox for that specific version
   - Version number (v1, v2, v3...)
   - Status badge: Active (green filled ●), Draft (blue ●),
     Obsolete (gray ○), InvalidDraft (red ●)
   - ProcessType (Screen Flow, Auto-launched Flow, etc.)
   - Checking a version row updates the parent group checkbox state

3. UI CONTROLS
   TOOLBAR (sticky at top of popup):
   - Search bar: filters flow groups by name, live as you type (case-insensitive).
     Searching shows only matching groups, with all their versions visible.
     If a group has no versions matching the search, hide it entirely.
   - "Select All" button: checks every version of every currently visible flow group
   - "Deselect All" button: unchecks everything
   - Refresh (🔄) icon button: re-fetches all flows from the API

   SELECTION SUMMARY BAR (sticky above Delete button):
   - Shows live count: "X versions selected across Y flows"
   - Examples:
       "3 versions selected across 2 flows"
       "Nothing selected"
       "12 versions selected across 5 flows  (2 active ⚠️)"
   - If any selected version is Active, append " (N active ⚠️)" in orange

   DELETE BUTTON:
   - Large red button at the bottom: "🗑 Delete Selected (X)"
     where X is the total number of selected versions
   - Disabled and grayed out when nothing is selected
   - Enabled as soon as at least one version checkbox is checked

4. ACTIVE FLOW WARNING (CRITICAL FEATURE)
   When the user clicks "Delete Selected" and the selection includes any flow version
   with Status = 'Active':
   a. Show a modal warning dialog with:
      - A red warning icon and bold header: "⚠️ You are about to delete ACTIVE flows"
      - A list of all active flow names + version numbers about to be deleted
      - The message: "Deleting active flows may break automations, processes, or
        user-facing screens that depend on them. This action cannot be undone."
      - Two buttons: "Cancel" (gray) and "I understand, delete anyway" (red)
   b. If the user clicks Cancel → close modal, do nothing
   c. If the user clicks "I understand, delete anyway" → proceed with deletion
   d. If no active flows are selected → skip the warning and go straight to step 5

5. FLOW INTERVIEW CHECK + WARNING
   After the active flow warning (if any) is accepted:
   a. Query REST API:
      SELECT Id, Name FROM FlowInterview
      WHERE FlowVersionViewId IN ('<selected flow ids comma separated>')
   b. If interviews are found, show a second modal:
      - Header: "⚠️ Paused Flow Interviews Found"
      - Message: "X paused/waiting flow interviews will also be permanently deleted."
      - List of interview names (up to 10, then "+ N more")
      - Two buttons: "Cancel" and "Delete interviews + flows"
   c. If no interviews → skip this modal

6. SUBFLOW DETECTION + WARNING (CRITICAL FEATURE)
   After the interview check, before deletion, detect if any selected flow is used
   as a subflow by other flows that are NOT in the deletion set.

   a. METADATA FETCH — when the extension loads the flow list, for each flow fetch
      its full metadata via the Tooling API:
        GET /services/data/v62.0/tooling/sobjects/Flow/{id}
      The response contains a Metadata JSON object. Inside it, look for the
      "subflows" array:
        {
          "Metadata": {
            "subflows": [
              {
                "flowName": "My_Approval_Subflow",   <-- this is the API name of the called subflow
                "label": "Run Approval Process",
                "locationX": 176,
                "locationY": 398
              }
            ]
          }
        }
      The "flowName" field is the exact API name (DeveloperName) of the referenced
      subflow. This is fully reliable — no LIKE queries, no string hacks.

   b. BUILD REVERSE DEPENDENCY MAP — after fetching all metadata, build and cache
      a reverse lookup map in memory:
        dependencyMap = {
          "Subflow_API_Name": [
            { id, masterLabel, versionNumber, status },  // parent flow A
            { id, masterLabel, versionNumber, status },  // parent flow B
          ]
        }
      Key = the subflow's MasterLabel/API name. Value = array of parent flows that
      call it. This map is built once on load and reused for all checks.

   c. SCALE STRATEGY based on org size (detect by total flow count from initial query):
      - Under 50 flows: fetch all metadata upfront silently on load
      - 50–200 flows: fetch metadata lazily — only when the user clicks
        "Delete Selected", show a spinner: "🔍 Scanning for subflow dependencies…"
        and fetch metadata only for flows NOT in the deletion set that are Active
        or Draft (skip Obsolete — they can't be called)
      - Over 200 flows: show a "🔗 Scan Subflow Dependencies" button in the toolbar.
        If the user hasn't scanned, show a yellow banner when they try to delete:
        "Subflow dependency scan not run. Proceed without checking, or scan first?"

   d. FLOW LIST INDICATORS — show a 🔗 icon next to any flow version in the list
      that appears as a value in the dependencyMap (i.e. it is called by other flows).
      On hover, show a tooltip: "Used as subflow in: Parent Flow A (v2, Active),
      Parent Flow B (v1, Obsolete)"

   e. DEPENDENCY WARNING MODAL — if any flow being deleted appears in the
      dependencyMap AND has parent flows outside the deletion set, show a modal:
      - Header: "🔗 Subflow Dependencies Detected"
      - Intro: "Some flows you are deleting are called as subflows by other flows.
        Deleting them will break those parent flows."
      - A dependency table:
          | Flow Being Deleted  | Called By (Parent Flow)  | Parent Status |
          Each parent flow gets its own row with a status badge.
          Active parents get a red "⚠️ ACTIVE" badge.
      - Per-row checkbox: "Also deactivate + delete this parent flow"
        Checking a row adds that parent to the deletion queue. After checking,
        re-run the dependency check for newly added flows and update the table
        in place (to catch grandparent dependencies).
      - A "Select all parent flows" toggle at the top of the table.
      - Three buttons:
          "Cancel" (gray) — abort everything
          "Proceed anyway, ignore broken parents" (orange)
          "Deactivate + delete selected parents" (red, only enabled if rows are checked)

   f. DEACTIVATION — for any parent flow the user chooses to deactivate + delete:
      Step 1: Fetch its FlowDefinition record:
        SELECT Id, ActiveVersionId FROM FlowDefinition
        WHERE DeveloperName = '<flow API name>'
      Step 2: PATCH the FlowDefinition to remove the active version:
        PATCH /services/data/v62.0/tooling/sobjects/FlowDefinition/{FlowDefinitionId}
        Body: { "ActiveVersionId": null }
      Step 3: The flow is now inactive and can be safely deleted in the next step.

   g. RECURSIVE DEPTH — cap at 3 levels of parent traversal. If a newly added
      parent is itself a subflow of something else, include that grandparent in the
      table too (indented). Beyond 3 levels show:
      "⚠️ Dependency chain is deeper than 3 levels. Manual review recommended."

7. DELETION SEQUENCE + DANCING ROBOT ANIMATION
   a. When the user confirms deletion and the process begins, replace the Delete
      button area with a progress panel containing:

      1. A DANCING ROBOT built entirely from CSS/HTML (no images, no external assets):
         The robot is made of divs with border-radius and background colors.
         Structure:
           - Head: rounded square, two dot eyes, antenna on top
           - Body: rectangle with two small "screen" rectangles inside
           - Arms: two rectangles, rotate at the shoulder on alternating frames
             (left arm up when right arm down, like it's dancing)
           - Legs: two rectangles, alternate forward/back like a shuffle step
           - The whole robot bobs up and down with a subtle translateY animation

         CSS keyframe animations:
           @keyframes robotBob — translateY(0) to translateY(-6px), 0.5s ease-in-out infinite alternate
           @keyframes armLeft — rotate(-30deg) to rotate(60deg), 0.5s ease-in-out infinite alternate
           @keyframes armRight — rotate(30deg) to rotate(-60deg), 0.5s ease-in-out infinite alternate
           @keyframes legLeft — rotate(-15deg) to rotate(15deg), 0.5s ease-in-out infinite alternate
           @keyframes legRight — rotate(15deg) to rotate(-15deg), 0.5s ease-in-out infinite alternate

         Colors: robot body in #3498db (blue), eyes in #ecf0f1 (white),
         screen panels in #2ecc71 (green), joints in #2980b9 (darker blue)
         Size: approximately 80px tall, centered above the progress bar

      2. A fun status message that cycles every 1.5s through:
         "🗑 Deleting flows...", "⚡ Zapping obsolete versions...",
         "🤖 Robot doing the work...", "🧹 Cleaning up interviews...",
         "💨 Gone. Poof. Bye bye flows."

      3. A progress bar below the robot:
         - Full width of the popup
         - Animated fill from left to right as each item is deleted
         - Shows "X / Y deleted" text centered inside the bar
         - Bar color: starts #3498db, transitions to #2ecc71 when complete

      4. Current item label below the bar: "Deleting: [Flow Name] v3..."

   b. When deletion completes:
      - Robot does one final "victory" animation: spins 360deg once
        (@keyframes victory — rotate(0deg) to rotate(360deg), 0.6s ease-in-out once)
      - Status message changes to: "✅ All done! Robot needs a break."
      - Progress bar turns fully green
      - After 2 seconds, replace the whole panel with the success toast summary
        and auto-refresh the flow list

8. ERROR HANDLING
   - If session extraction fails: show "Could not detect Salesforce session.
     Make sure you have a Salesforce tab open and are logged in."
   - If API returns 401: show "Session expired. Please refresh your Salesforce tab."
   - If a flow deletion fails with CANNOT_DELETE_MANAGED_COMPONENT: show
     "Flow [name] is part of a managed package and cannot be deleted."
   - Show all errors inline without crashing the rest of the deletion batch

9. FLOW DEPENDENCY MAP VIEW
   A separate tab or panel in the popup called "🗺 Dependencies" that visualizes
   how flows call each other.

   a. DATA SOURCE — reuse the metadata already fetched in step 6 (the
      Metadata.subflows[] array from each flow's full metadata). Also parse
      the following from each flow's Metadata JSON:
        - "processMetadataValues" and "start.object" → identify trigger type
          and triggering object (e.g. "Account", "Opportunity")
        - "processType" → "AutoLaunchedFlow", "Flow" (Screen), "RecordTriggeredFlow", etc.
        - "subflows[].flowName" → the API name of each called subflow

   b. DEPENDENCY TREE — render a collapsible tree view (not a canvas/SVG graph,
      just indented HTML rows with connecting lines drawn via CSS borders):

      Example visual output:
      ┌──────────────────────────────────────────────────────────────┐
      │ ⚡ Account Update Trigger  [Record-Triggered] [Active]        │
      │  └──▶ 🔄 Approval Router Flow  [Auto-launched] [Active]      │
      │        └──▶ 🔄 Send Notification Flow  [Auto-launched] [Active]│
      │                                                              │
      │ 🖥 Onboarding Wizard  [Screen Flow] [Active]                 │
      │  └──▶ 🖥 Address Entry Sub-Screen  [Screen Flow] [Active]    │
      │  └──▶ 🖥 Payment Details Sub-Screen  [Screen Flow] [Draft]   │
      └──────────────────────────────────────────────────────────────┘

      Flow type icons:
        ⚡ = Record-Triggered Flow
        🔄 = Auto-launched Flow
        🖥 = Screen Flow
        📅 = Scheduled Flow
        🔁 = Platform Event Flow

      Each node shows: icon + flow name + [type badge] + [status badge]
      Clicking a node highlights all rows in that tree branch
      Clicking a node's name opens that flow in Salesforce Setup in a new tab:
        https://{orgUrl}/builder_platform_interaction/flowBuilder.app?flowId={id}

   c. ORPHAN FLOWS — flows that are not called by anything else AND do not call
      anything else are shown in a separate collapsed section: "🏝 Standalone Flows (N)"

   d. FILTER BAR — above the tree, a small filter bar with toggle buttons:
        [All] [Record-Triggered] [Screen] [Auto-launched] [Scheduled]
      Selecting a type highlights only nodes of that type in the tree
      (others are dimmed, not hidden, so the tree structure stays visible)

   e. EXPAND/COLLAPSE ALL — buttons to expand or collapse every node at once

   f. "Select for deletion" shortcut — right-clicking any node in the dependency
      tree shows a context menu: "Select this flow for deletion" which switches
      to the main tab with that flow's checkbox pre-checked

10. FLOW DEBUG STORY EXPORTER
    A separate tab in the popup called "📖 Debug Story" that takes raw Salesforce
    flow debug log output and exports it as a human-readable narrative.

    a. INPUT — a large textarea where the user pastes their raw flow debug log.
       The debug log is the text output from Salesforce's Flow Debug run, which
       looks like this (example):
         FLOW_START_INTERVIEW_BEGIN|...|My_Flow|My Flow
         FLOW_START_INTERVIEW_END|...|My_Flow
         FLOW_ELEMENT_BEGIN|...|Assignment|Set Account Name
         FLOW_ELEMENT_END|...|Assignment|Set Account Name
         FLOW_RULE_DETAIL|...|decision_1|Is Premium Customer?|true
         FLOW_ELEMENT_BEGIN|...|RecordCreate|Create Follow-Up Task
         FLOW_ELEMENT_END|...|RecordCreate|Create Follow-Up Task
         FLOW_SUBFLOW_DETAIL|...|Send_Notification_Flow|Send Notification
         FLOW_END|...

    b. PARSING — parse the log line by line. Each line is pipe-delimited.
       Recognize and handle these event types:
         FLOW_START_INTERVIEW_BEGIN  → "▶ Flow started: {flow label}"
         FLOW_START_INTERVIEW_END    → (skip, already covered by BEGIN)
         FLOW_ELEMENT_BEGIN          → track element type + label, push to stack
         FLOW_ELEMENT_END            → pop from stack, emit completed element line
         FLOW_RULE_DETAIL            → "  ↳ Condition '{label}' evaluated to: {result}"
         FLOW_ASSIGNMENT_DETAIL      → "  ✏ Set {variable} = {value}"
         FLOW_LOOP_DETAIL            → "  🔁 Loop iteration {n}: {variable} = {value}"
         FLOW_SUBFLOW_DETAIL         → "  📞 Called subflow: {subflow label}"
         FLOW_BULK_ELEMENT_BEGIN     → "  ⚡ Bulk operation started: {label}"
         FLOW_BULK_ELEMENT_END       → "  ⚡ Bulk operation completed: {label}"
         FLOW_END                    → "⏹ Flow finished"
         FLOW_START_SCHEDULED_PATHS  → "📅 Scheduled path triggered"
         FLOW_ACTIONCALL_DETAIL      → "  🎬 Action called: {action label} → result: {value}"
         FLOW_SCREEN_FIELD_DETAIL    → "  🖥 Screen field '{label}' value: {value}"

       Element type → human label mapping:
         Assignment     → "Assignment"
         Decision       → "Decision"
         RecordCreate   → "Create Record"
         RecordUpdate   → "Update Record"
         RecordDelete   → "Delete Record"
         RecordLookup   → "Get Records"
         Loop           → "Loop"
         Screen         → "Screen"
         ActionCall     → "Action"
         SubFlow        → "Subflow"
         Wait           → "Wait / Pause"

    c. OUTPUT FORMAT — render the parsed story as a nicely formatted narrative
       in a scrollable read-only panel below the textarea. Example output:

       ════════════════════════════════════════════
       📖 Flow Execution Story: "My Approval Flow"
       Ran at: 2024-03-15 14:32:07
       ════════════════════════════════════════════

       ▶ Flow started: My Approval Flow

         1. 📋 Assignment — "Set Account Name"
            ✏ Set {!AccountName} = "Acme Corp"
            ✏ Set {!IsActive} = true

         2. 🔀 Decision — "Is Premium Customer?"
            ↳ Condition "Is Premium Customer?" evaluated to: TRUE
            ↳ Took path: "Yes - Premium"

         3. 📝 Create Record — "Create Follow-Up Task"
            Created: Task

         4. 📞 Called subflow: "Send Notification Flow"
            ↳ Input: {!AccountId} = "001xx0000001234"

       ⏹ Flow finished
       ════════════════════════════════════════════
       Total elements executed: 4
       Subflows called: 1
       Records created: 1 | Updated: 0 | Deleted: 0 | Queried: 0

    d. EXPORT OPTIONS — two buttons below the story panel:
       - "📋 Copy to Clipboard" — copies the plain text story
       - "⬇ Download as .txt" — downloads "FlowStory_{flowName}_{date}.txt"

    e. ERROR HANDLING — if the pasted text doesn't look like a Salesforce flow
       debug log (no FLOW_ prefixed lines detected), show:
       "⚠️ This doesn't look like a Salesforce flow debug log.
        Paste the full debug output from Flow Builder's debug run."

    f. MULTI-FLOW LOGS — if the log contains multiple FLOW_START_INTERVIEW_BEGIN
       events (e.g. a flow that triggered a subflow which also logged), detect them
       all and render each as its own collapsible section in the story panel,
       indented to show nesting:
         ▶ My Approval Flow
           └── ▶ Send Notification Flow (called as subflow)

═══════════════════════════════════════════════
TECHNICAL REQUIREMENTS
═══════════════════════════════════════════════

MANIFEST (manifest.json):
- Manifest V3
- Permissions: ["cookies", "tabs", "scripting", "storage", "activeTab"]
- Host permissions: ["https://*.salesforce.com/*", "https://*.lightning.force.com/*", "https://*.my.salesforce.com/*"]
- Action: popup.html, default icon set
- Content script: content.js, matches ["https://*.salesforce.com/*", "https://*.lightning.force.com/*"]
- Background: service_worker: background.js

FILE STRUCTURE:
  manifest.json
  popup.html
  popup.js
  background.js
  content.js
  styles.css
  dependency-map.js   (feature 9 logic)
  debug-story.js      (feature 10 logic)
  icons/
    icon16.png
    icon48.png
    icon128.png

CONTENT SCRIPT (content.js):
- Listen for message {type: "GET_SF_SESSION"}
- Respond with {orgUrl: window.location.origin, sid: getCookie('sid')}
- getCookie reads document.cookie

BACKGROUND SERVICE WORKER (background.js):
- Handle all Salesforce API calls (avoids CORS issues in popup)
- Expose message handlers:
    SF_QUERY (Tooling API query)
    SF_TOOLING_DELETE (Tooling API delete)
    SF_REST_DELETE (REST API delete)
- Always inject Authorization: Bearer {sid} header
- Implement retry once on 5xx errors

POPUP (popup.js + popup.html):
- On load: find active Salesforce tab, send GET_SF_SESSION to content script
- Build the flow list UI dynamically
- All modals built in JS and injected into popup.html DOM
- Do not use any external libraries (vanilla JS only)

STYLES (styles.css):
- Dark sidebar theme matching Salesforce Lightning design
- Color palette:
    Background: #1a1a2e
    Card/panel: #16213e
    Accent: #0f3460
    Active badge: #2ecc71
    Draft badge: #3498db
    Obsolete badge: #7f8c8d
    Danger/red: #e74c3c
    Text: #ecf0f1
    Subtext: #95a5a6
- Smooth transitions on expand/collapse
- Sticky header with search bar and controls
- Responsive to 380px width (standard popup width)

ICON PLACEHOLDERS:
- Generate simple SVG-based PNG icons in blue/white with a "⚡" lightning bolt
  or just create 1px transparent PNGs as placeholders (real icons can be added later)

Generate ALL files completely with no placeholders or TODOs.
Every function must be fully implemented.
```

---

# PART 2 — CHROME WEB STORE: UPLOAD & APPROVAL GUIDE

---

## Step 1 — Prepare Your Extension Files

After Claude Code generates the extension:

1. **Test locally first:**
   - Open Chrome → `chrome://extensions`
   - Enable "Developer mode" (top right toggle)
   - Click "Load unpacked" → select your extension folder
   - Open a Salesforce tab and click the extension icon to verify it works

2. **Replace placeholder icons** with real PNG icons:
   - Required sizes: `16x16`, `48x48`, `128x128`
   - Use a tool like Canva, Figma, or icons8.com
   - Must be PNG format, no transparency issues
   - The 128x128 icon is what appears in the Chrome Web Store listing

3. **Create a ZIP file** of the extension folder:
   - On Mac: right-click folder → "Compress"
   - On Windows: right-click → "Send to" → "Compressed (zipped) folder"
   - Do NOT include `node_modules`, `.git`, or `.DS_Store` files
   - The ZIP should contain `manifest.json` at the root level (not inside a subfolder)

---

## Step 2 — Create a Chrome Web Store Developer Account

1. Go to: https://chrome.google.com/webstore/devconsole
2. Sign in with a Google account
3. Pay the **one-time $5 registration fee** (credit card required)
4. Accept the Developer Agreement

> **Tip:** Use a dedicated Google account for your extensions, not your personal Gmail.

---

## Step 3 — Create a New Item in the Developer Console

1. Go to: https://chrome.google.com/webstore/devconsole
2. Click **"+ New Item"** (top right)
3. Upload your `.zip` file
4. Chrome will validate the manifest — fix any errors flagged before continuing

---

## Step 4 — Fill In the Store Listing

Fill in all required fields:

### Required Fields

| Field | Recommended Value |
|---|---|
| **Name** | SF Flow Cleaner |
| **Summary** (132 chars) | Delete Salesforce flows and flow interviews in bulk. Safely manage all versions with active flow warnings. |
| **Description** | See template below |
| **Category** | Productivity |
| **Language** | English (add Hebrew if desired) |
| **Screenshots** | At least 1 required (1280×800 or 640×400 px) |
| **Icon** | 128×128 PNG |

### Description Template

```
SF Flow Cleaner helps Salesforce admins and developers clean up flow versions quickly and safely.

FEATURES:
• View all flows and every version in your org, grouped by flow name
• See status badges: Active, Draft, Obsolete at a glance
• Select individual versions or entire flows for bulk deletion
• Active flow protection: warns you before deleting any active flow version with a full list of affected flows
• Detects and deletes paused Flow Interviews before deleting their parent flows
• Progress tracking with per-item success/error summary
• Works automatically on any Salesforce Lightning tab — no configuration needed

PERMISSIONS USED:
• Cookies & Tabs: to detect your Salesforce session automatically
• Host access to *.salesforce.com: to call the Tooling API and REST API

This extension does NOT collect or transmit any data outside of your Salesforce org.
```

---

## Step 5 — Privacy & Permissions Justification

This is often the step that causes rejections. Be thorough.

### Privacy Tab — Required Fields

- **Single purpose description:**
  "This extension allows Salesforce users to view, select, and delete flow versions and flow interviews directly from a browser popup, without navigating to Setup."

- **Permission justifications** (Chrome will ask for each):

| Permission | Justification to provide |
|---|---|
| `cookies` | Required to read the Salesforce session token (sid cookie) to authenticate API calls to the user's org |
| `tabs` | Required to identify the active Salesforce tab and inject the content script that retrieves the org URL and session |
| `scripting` | Required to run a content script on Salesforce tabs to extract session information |
| `host_permissions (*.salesforce.com)` | Required to make authenticated API calls to the Salesforce Tooling API and REST API for listing and deleting flows and flow interviews |

- **Data usage disclosure:**
  Select: "This extension does not collect or use any user data"
  (The extension only sends API calls back to the user's own Salesforce org)

---

## Step 6 — Submit for Review

1. Complete all tabs: **Store Listing**, **Privacy practices**, **Distribution**
2. Under Distribution: set to "Public" (or "Unlisted" if you only want to share via direct link)
3. Click **"Submit for Review"**

---

## Step 7 — Review Timeline & What to Expect

| Scenario | Timeline |
|---|---|
| Standard first submission | 1–3 business days |
| If rejection triggers manual review | Up to 2 weeks |
| After fixing a rejection and resubmitting | 1–3 business days |

### Common Rejection Reasons (and how to avoid them)

**1. Overly broad permissions**
- If you request `<all_urls>` or broad host permissions, Chrome reviewers flag it
- Our manifest uses specific `*.salesforce.com` and `*.lightning.force.com` — this is correct ✅

**2. Missing privacy policy**
- For extensions that access user data (even locally), a privacy policy URL may be required
- Create a simple one-page privacy policy hosted on GitHub Pages or a free site like Carrd
- Sample text: *"SF Flow Cleaner does not collect, store, or transmit any personal data. All API calls are made directly between the user's browser and their own Salesforce organization."*

**3. Remote code execution**
- Never use `eval()` or load scripts from external URLs — our extension uses only local JS ✅

**4. Deceptive functionality**
- The description must match exactly what the extension does — be specific

**5. Screenshot quality**
- Screenshots must be 1280×800 or 640×400, no blurry/low-res images
- Take screenshots with the extension running on a real (or demo) Salesforce org

---

## Step 8 — After Approval

Once approved:
- Your extension gets a public URL: `https://chrome.google.com/webstore/detail/[your-id]`
- Share it with your team or make it public
- To update: bump the `version` in `manifest.json`, re-zip, and upload a new package in the Developer Console (updates go through a shorter review)

---

## Quick Reference Checklist

```
BEFORE SUBMITTING:
[ ] Tested locally via chrome://extensions with "Load unpacked"
[ ] Real 16x16, 48x48, 128x128 PNG icons (not placeholders)
[ ] ZIP file has manifest.json at root level
[ ] $5 developer account registration paid
[ ] Store listing: name, summary, description, category filled
[ ] At least 1 screenshot (1280x800 or 640x400)
[ ] Privacy practices tab completed
[ ] All permission justifications written
[ ] Privacy policy URL added (if required)
[ ] "Submit for Review" clicked

AFTER APPROVAL:
[ ] Test the installed version from the store
[ ] Share the store URL with your team
[ ] Note: future updates require re-submission (usually same-day approval)
```

---

*Generated for SF Flow Cleaner Chrome Extension — Salesforce Flow & Interview Manager*
