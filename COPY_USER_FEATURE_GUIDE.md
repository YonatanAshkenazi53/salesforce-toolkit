# Implementation Guide — Copy User Profile, Permission Sets, Public Groups & User Settings

This guide tells another Claude exactly how to build the "Copy User" feature that already ships in the Salesforce Toolkit Chrome extension. Follow it top-to-bottom and you will end up with a working module that copies any combination of: **Profile**, **Permission Sets**, **Public Groups**, **User Permissions** (Marketing User / Flow User / etc. checkboxes), and **Locale + Timezone** from one Salesforce user to another.

> Audience: a Claude doing the implementation in another codebase (could be a Chrome extension, a web app, an LWC, an Apex Lightning page — the data model is the same, only the UI plumbing changes).

---

## 1. What the feature does — in plain English

The user picks **two active Salesforce users** (source + target) from a searchable dropdown.
The app loads what the source has assigned and what the target already has, then shows a 3-state preview per item:

- **Can be copied** — checked by default
- **Already assigned to target** — shown as confirmation, no action
- **Incompatible** (e.g. permission set requires a different user license than the target's) — shown as a warning, not assignable

The user picks any subset and clicks **Copy Selected**. The app writes the diff to Salesforce and reports what landed plus any failures.

---

## 2. Authentication model

The reference implementation runs in a Chrome MV3 extension and reuses the user's existing Salesforce session via `chrome.cookies` — no OAuth, no stored password. If you're building this elsewhere (an LWC, an Apex page, a SaaS web app), use whatever auth you already have. **Everything below assumes you have a session id (`sid`) and an org base URL (`orgUrl`) and can call Salesforce REST.**

The REST base path used throughout: `services/data/v62.0/` (bump as appropriate).

---

## 3. The five categories — data model + SOQL + writes

For each category I'm giving you: the **read query** (to show the preview), the **write call** (to actually copy), and the **gotchas**. Copy-paste-able.

### 3a. Profile

**Read** — already loaded with the user search query, no extra call needed:
```sql
SELECT Id, Name, Username,
       Profile.Id, Profile.Name,
       Profile.UserLicense.Id, Profile.UserLicense.Name,
       UserType
FROM User
WHERE IsActive = true
ORDER BY Name
```

**Write** — single PATCH on the target user:
```
PATCH /services/data/v62.0/sobjects/User/{targetUserId}
Body: { "ProfileId": "<sourceUser.Profile.Id>" }
```

**Gotcha — license change warning.** Changing a profile can implicitly change the user's *license* (e.g. Salesforce → Salesforce Platform). Detect this before the user clicks Copy:

```js
const srcLicense = sourceUser.Profile.UserLicense.Name;
const tgtLicense = targetUser.Profile.UserLicense.Name;
if (srcLicense !== tgtLicense) {
  // Show a warning: "⚠️ This also changes the license from <tgt> → <src>.
  // Make sure a license slot is available."
}
```

**Gotcha — same profile.** If both users are on the same profile, disable the checkbox and show a "same" badge — don't do a no-op PATCH that could fail.

### 3b. Permission Sets

**Read source's permission sets:**
```sql
SELECT PermissionSetId,
       PermissionSet.Label, PermissionSet.Name,
       PermissionSet.LicenseId, PermissionSet.License.Name,
       PermissionSet.IsCustom
FROM PermissionSetAssignment
WHERE AssigneeId = '<sourceUserId>'
  AND PermissionSet.IsOwnedByProfile = false      -- ★ critical
ORDER BY PermissionSet.Label
```

**Read target's permission sets** (just the ids, to bucket source's into "copy" vs "already assigned"):
```sql
SELECT PermissionSetId
FROM PermissionSetAssignment
WHERE AssigneeId = '<targetUserId>'
  AND PermissionSet.IsOwnedByProfile = false
```

**Bucket them in JS:**
```js
const targetPermSetIds = new Set(tgtRecords.map(r => r.PermissionSetId));
const targetLicenseId  = targetUser.Profile.UserLicense.Id;

const assignable   = [];   // copy these
const alreadyHas   = [];   // show as ✓ confirmation
const incompatible = [];   // license mismatch — warn, can't copy

for (const psa of sourcePermSets) {
  const ps = psa.PermissionSet;
  if (targetPermSetIds.has(psa.PermissionSetId)) {
    alreadyHas.push(psa);
  } else if (ps.LicenseId && targetLicenseId && ps.LicenseId !== targetLicenseId) {
    incompatible.push(psa);
  } else {
    assignable.push(psa);
  }
}
```

**Write — one POST per assignable permission set (Salesforce doesn't allow bulk via the standard REST endpoint):**
```
POST /services/data/v62.0/sobjects/PermissionSetAssignment
Body: { "AssigneeId": "<targetUserId>", "PermissionSetId": "<psId>" }
```

**Gotchas:**
- `IsOwnedByProfile = false` filters out the "phantom" permission set that every profile has. Skip this filter and you'll try to copy the source's profile-permset and Salesforce will reject it.
- Permission sets are license-gated. A `Salesforce CRM User`-licensed permission set can't be assigned to a `Salesforce Platform` user. Always pre-check `LicenseId`.
- Loop sequentially with `await` so error messages map cleanly to a specific perm set name.

### 3c. Public Groups

**Read source's group memberships** (`Group.Type = 'Regular'` filters to *public* groups — excludes queues, roles, role-and-subordinates):
```sql
SELECT GroupId, Group.Name
FROM GroupMember
WHERE UserOrGroupId = '<sourceUserId>'
  AND Group.Type = 'Regular'
```

**Read target's:**
```sql
SELECT GroupId
FROM GroupMember
WHERE UserOrGroupId = '<targetUserId>'
  AND Group.Type = 'Regular'
```

**Bucket: same idea as permission sets — `assignable` vs `alreadyMember`. No license check needed.**

**Write — one POST per group:**
```
POST /services/data/v62.0/sobjects/GroupMember
Body: { "GroupId": "<groupId>", "UserOrGroupId": "<targetUserId>" }
```

**Gotcha:** `UserOrGroupId` is the same field whether the assignee is a user or a child group. We always pass the target user id.

### 3d. User Permissions (Marketing User / Flow User / Service Cloud User / etc.)

These are the boolean checkboxes on the User detail page. They live as `UserPermissions*` fields directly on the `User` object, but **the available set varies by org** (feature licenses, enabled features). You **must** discover them at runtime, not hardcode.

**Step 1 — discover which `UserPermissions*` fields exist in *this* org:**
```
GET /services/data/v62.0/sobjects/User/describe
```
Then in JS:
```js
const userPermFields = describe.fields
  .filter(f =>
    typeof f.name === 'string' &&
    f.name.startsWith('UserPermissions') &&
    f.type === 'boolean' &&
    f.updateable !== false
  )
  .map(f => ({ name: f.name, label: f.label }))
  .sort((a, b) => a.label.localeCompare(b.label));
```

**Step 2 — read both users' values** (build the SELECT dynamically from the discovered list):
```js
const fieldList = userPermFields.map(f => f.name).join(',');
// SELECT UserPermissionsMarketingUser, UserPermissionsKnowledgeUser, ... FROM User WHERE Id = '...'
```

**Step 3 — bucket each field:**
```js
const toEnable  = []; // src=true,  tgt=false  → can flip ON
const toDisable = []; // src=false, tgt=true   → can flip OFF
const sameOn    = []; // both true             → confirmation
// (both false → don't even show — noise)
```

**Step 4 — write.** Don't PATCH one at a time. Collect every checked permission into a single `userPatch` object and send **one PATCH** alongside the locale fields (see 3e). Halves the API calls and keeps the user record consistent.

```js
const userPatch = {};
for (const cb of document.querySelectorAll('.uc-userperm-cb:checked')) {
  userPatch[cb.dataset.field] = cb.dataset.target === 'true';
}
```

### 3e. Locale & Timezone

Just four `User` fields:

| Field                | Label          |
|----------------------|----------------|
| `LocaleSidKey`       | Locale         |
| `LanguageLocaleKey`  | Language       |
| `TimeZoneSidKey`     | Timezone       |
| `EmailEncodingKey`   | Email Encoding |

**Read** both users with one query each, then for each field compare and bucket: same → muted, different → checkbox checked by default.

**Write — fold into the same `userPatch` from 3d:**
```js
for (const cb of document.querySelectorAll('.uc-field-cb:checked')) {
  userPatch[cb.dataset.field] = sourceUserFields[cb.dataset.field];
}

if (Object.keys(userPatch).length > 0) {
  await PATCH(`services/data/v62.0/sobjects/User/${targetUser.Id}`, userPatch);
}
```

---

## 4. UX flow — the order things happen

1. **On mount:** kick off `loadAllUsers()` (the active-user SOQL) and `loadUserPermFields()` (the User describe) in parallel. Both populate immediately even before the user touches anything — by the time they click the picker, the list is ready.
2. **Render two pickers** (📤 Copy FROM, 📥 Copy TO) with a search input that filters `allUsers` client-side. Match against `Name`, `Username`, and `Profile.Name`. Cap dropdown to 50 visible results with a "showing 50 of N — keep typing" footer.
3. **Disable picking the same user on the other side** — exclude the chosen "other" user from each filter.
4. **When both users are selected**, immediately fire `loadAndPreview()` which runs the six SOQL queries in 3a-e in sequence (or use `Promise.all` for the four reads on the two users — they don't depend on each other).
5. **Render the preview** with the three buckets (Can be copied / Already assigned / Incompatible) per category.
6. **Section toggles** — a top-level "What to copy" group with one checkbox per category (Profile / Permission Sets / Public Groups / User Permissions / Locale & Timezone) plus an "All" master. Unchecking a category hides its preview section but keeps the loaded data so re-checking is instant (no re-fetch).
7. **Copy Selected button** does the writes in this order:
   1. Profile PATCH (separate call — license change is high-stakes, surface its error alone)
   2. Permission set POSTs (sequential, accumulate errors with the perm set name)
   3. Group member POSTs (sequential, accumulate errors with the group name)
   4. **One combined User PATCH** for user permissions + locale/tz
8. **After the writes:**
   - If all four buckets were empty → "Nothing was selected to copy."
   - If no errors → green toast: `✅ Done! profile updated · 3 permission sets assigned · added to 2 groups · 4 user permissions updated · locale & timezone updated.`
   - If any errors → keep the green tally for successes and append a list of failures.
9. **Then re-run `loadAndPreview()`** so the just-assigned items move from "Can be copied" → "Already assigned" and the user can see their work landed.

---

## 5. Edge cases / gotchas you will hit

- **Session expired retry.** Wrap your background message helper so that if a call returns `error: 'SESSION_EXPIRED'` (or a 401 in non-extension contexts), you refresh the session once and re-issue the call before bubbling the error.
- **Already assigned permission sets** — Salesforce returns a `DUPLICATE_VALUE` error if you try to re-POST. Filtering with the `targetPermSetIds` set prevents this.
- **Profile change cascade.** Some user permissions are *granted by the profile* and re-evaluate on profile change. Do Profile **first**, then re-read the target's user perms before computing the diff if you want pixel-perfect preview. The reference implementation skips this and re-shows the preview after the whole copy completes; that's usually fine.
- **`IsActive = true` filter.** Inactive users can't be assigned anything anyway, and they're noise in the picker.
- **`PermissionSet.IsOwnedByProfile = false`.** Every profile has a hidden permset behind it. Without this filter you see weird "Profile: X" rows.
- **Permission set group membership.** Permission set *groups* don't appear directly on `PermissionSetAssignment` — their child permsets do (via the group's expansion). If you want to show the group rather than the constituent permsets, query `PermissionSetGroupId` as well and present the group name. The reference implementation shows the leaf permsets — simpler and matches Setup.
- **Custom Permissions (`SetupEntityAccess` / `CustomPermission`)** are *not* covered here. If the target's profile doesn't grant the custom permission, copying the permission set that does grant it is enough. Don't try to write `SetupEntityAccess` rows by hand — let permsets do that.
- **Role.** Note we do **not** copy `UserRoleId`. Role changes are organizational decisions; if you want to add this, add a separate "Role" section with a confirmation step. Don't bundle it into "All".
- **License/CRUD permissions on `PermissionSetAssignment` and `GroupMember`.** The running user needs "Manage Users" (`PermissionsManageUsers`). Detect this from the running user's `Profile.PermissionsManageUsers` or just catch the resulting 403 and show a clear error.

---

## 6. Minimal skeleton (vanilla JS, framework-agnostic)

If you've read sections 1–5 you basically have the spec. Here's the skeleton wired up — adapt the `apiGet/apiPatch/apiPost` calls to whatever HTTP helper you use.

```js
const USER_COPY = (() => {
  let sourceUser = null, targetUser = null;
  let sourcePermSets = [], targetPermSetIds = new Set();
  let sourceGroups = [], targetGroupIds = new Set();
  let sourceUserFields = {}, targetUserFields = {};
  let userPermFields = [], sourceUserPerms = {}, targetUserPerms = {};

  async function init() {
    const [users, describe] = await Promise.all([
      apiQuery(`SELECT Id,Name,Username,Profile.Id,Profile.Name,
                       Profile.UserLicense.Id,Profile.UserLicense.Name,UserType
                FROM User WHERE IsActive=true ORDER BY Name`),
      apiGet('services/data/v62.0/sobjects/User/describe'),
    ]);
    renderPickers(users.records);
    userPermFields = describe.fields
      .filter(f => f.name.startsWith('UserPermissions') &&
                   f.type === 'boolean' && f.updateable !== false)
      .map(f => ({ name: f.name, label: f.label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  async function loadAndPreview() {
    const fieldList = userPermFields.map(f => f.name).join(',');
    const [sps, tps, sf, tf, sg, tg, sp, tp] = await Promise.all([
      apiQuery(`SELECT PermissionSetId,PermissionSet.Label,PermissionSet.Name,
                       PermissionSet.LicenseId,PermissionSet.License.Name
                FROM PermissionSetAssignment
                WHERE AssigneeId='${sourceUser.Id}'
                  AND PermissionSet.IsOwnedByProfile=false
                ORDER BY PermissionSet.Label`),
      apiQuery(`SELECT PermissionSetId FROM PermissionSetAssignment
                WHERE AssigneeId='${targetUser.Id}'
                  AND PermissionSet.IsOwnedByProfile=false`),
      apiQuery(`SELECT LocaleSidKey,LanguageLocaleKey,TimeZoneSidKey,EmailEncodingKey
                FROM User WHERE Id='${sourceUser.Id}'`),
      apiQuery(`SELECT LocaleSidKey,LanguageLocaleKey,TimeZoneSidKey,EmailEncodingKey
                FROM User WHERE Id='${targetUser.Id}'`),
      apiQuery(`SELECT GroupId,Group.Name FROM GroupMember
                WHERE UserOrGroupId='${sourceUser.Id}' AND Group.Type='Regular'`),
      apiQuery(`SELECT GroupId FROM GroupMember
                WHERE UserOrGroupId='${targetUser.Id}' AND Group.Type='Regular'`),
      fieldList
        ? apiQuery(`SELECT ${fieldList} FROM User WHERE Id='${sourceUser.Id}'`)
        : Promise.resolve({ records: [{}] }),
      fieldList
        ? apiQuery(`SELECT ${fieldList} FROM User WHERE Id='${targetUser.Id}'`)
        : Promise.resolve({ records: [{}] }),
    ]);
    sourcePermSets   = sps.records;
    targetPermSetIds = new Set(tps.records.map(r => r.PermissionSetId));
    sourceUserFields = sf.records[0] || {};
    targetUserFields = tf.records[0] || {};
    sourceGroups     = sg.records;
    targetGroupIds   = new Set(tg.records.map(r => r.GroupId));
    sourceUserPerms  = sp.records[0] || {};
    targetUserPerms  = tp.records[0] || {};
    renderPreview();
  }

  async function executeCopy() {
    const opts = getOptions();
    const errors = [];

    // 1. Profile
    if (opts.profile && getCheckbox('ucProfileCb')) {
      const r = await apiPatch(
        `services/data/v62.0/sobjects/User/${targetUser.Id}`,
        { ProfileId: sourceUser.Profile.Id });
      if (r.error) errors.push(`Profile: ${r.error}`);
    }

    // 2. Permission sets
    if (opts.permSets) {
      for (const psId of checkedValues('.uc-ps-cb', 'psid')) {
        const r = await apiPost('services/data/v62.0/sobjects/PermissionSetAssignment',
          { AssigneeId: targetUser.Id, PermissionSetId: psId });
        if (r.error) errors.push(`Permset ${psId}: ${r.error}`);
      }
    }

    // 3. Public groups
    if (opts.groups) {
      for (const gId of checkedValues('.uc-grp-cb', 'groupid')) {
        const r = await apiPost('services/data/v62.0/sobjects/GroupMember',
          { GroupId: gId, UserOrGroupId: targetUser.Id });
        if (r.error) errors.push(`Group ${gId}: ${r.error}`);
      }
    }

    // 4. User permissions + locale (one combined PATCH)
    const userPatch = {};
    if (opts.userPerms) {
      for (const cb of document.querySelectorAll('.uc-userperm-cb:checked')) {
        userPatch[cb.dataset.field] = cb.dataset.target === 'true';
      }
    }
    if (opts.settings) {
      for (const cb of document.querySelectorAll('.uc-field-cb:checked')) {
        userPatch[cb.dataset.field] = sourceUserFields[cb.dataset.field];
      }
    }
    if (Object.keys(userPatch).length) {
      const r = await apiPatch(
        `services/data/v62.0/sobjects/User/${targetUser.Id}`, userPatch);
      if (r.error) errors.push(`User PATCH: ${r.error}`);
    }

    reportResult(errors);
    await loadAndPreview();   // refresh the buckets
  }

  return { init };
})();
```

---

## 7. Testing checklist

- [ ] Source and target both on Salesforce-licensed Standard User profile → all categories should be copyable (or already-same).
- [ ] Source on Salesforce, target on Salesforce Platform → permission set list shows "Incompatible license" for any Salesforce-only permsets.
- [ ] Source has 5 permsets, target already has 3 of them → preview shows 2 in "Can be copied" + 3 in "Already assigned".
- [ ] Same profile both sides → profile checkbox is disabled with a "same" badge.
- [ ] Profile change to one with a different license → the orange license warning appears.
- [ ] Target is in 2 of the source's 4 public groups → preview shows 2/2 split.
- [ ] User permissions: source has Marketing User on, target doesn't → preview shows it under "Can be enabled" checked by default.
- [ ] User permissions: target has Knowledge User on but source doesn't → preview shows it under "Can be disabled", **unchecked** by default (so unticking nothing = no destructive change).
- [ ] Locale source = `en_US`, target = `en_GB` → checkbox checked by default. If both `en_US` → muted with "same" badge.
- [ ] Run with nothing checked → "Nothing was selected to copy." (no API calls).
- [ ] Run twice in a row → second run should report "0 permission sets assigned" because the first run moved everything to "already assigned".
- [ ] Session expiry mid-copy → silent re-auth, copy continues.
- [ ] Running user lacks "Manage Users" → all writes fail with a clear permission error, no partial state.

---

## 8. Mental model summary

> Three categories are **child sObjects** of the target user (`PermissionSetAssignment`, `GroupMember`) — copying = POSTing rows with `UserOrGroupId / AssigneeId = targetUser.Id`.
>
> Two categories live **on the User row itself** (`ProfileId`, the `UserPermissions*` booleans, the four `*Key` locale fields) — copying = a PATCH.
>
> The whole feature is: read both, diff into three buckets, write the "can be copied" bucket. Everything else is UX polish.

That's it. Read this top-to-bottom, port the SOQL and the endpoints into your stack, and you'll have a working clone of the feature in a day.
