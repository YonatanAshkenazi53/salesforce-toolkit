// sftk-relmap.js — the ONE answer to "which object does this relationship hop lead to" (2026-11-14).
//
// WHY this file exists: the same walk lived in five+ private copies (sftk-mdapi.js sftkRtEdit, _sftkMdSwapToken and
// the WorkflowFieldUpdate target; sftk-emailtpl.js _sftkTplForeign; field-cleaner.js flows and Lightning pages), each
// with its own map, Parent rule and globals. They drifted apart, and six review rounds of findings were one copy
// lacking what another had (PartnerAccount, CompanySigned, Parent on EmailMessage, $Profile…). Every caller now asks
// here; this file holds the UNION of what the copies knew. Pure, no dependencies — popup.html loads it before
// sftk-mdapi.js, sftk-emailtpl.js and field-cleaner.js; the tests load it through test/setup-relmap.mjs.
//
// The SAFE direction wins: when the object cannot be told from the name alone, the answer is null with the reason,
// and the caller leaves the reference alone and names that reason — it never guesses another object.

// Standard relationships whose object is FIXED and is not simply the relationship's own name. Asset / Quote map to
// themselves and are listed only because sftk-emailtpl.js listed them; any other standard hop is a lookup named for
// its object (Entitlement, Individual, PricebookEntry…), which sftkRelHop answers without a list.
const SFTK_REL = Object.freeze({
  owner: 'user', createdby: 'user', lastmodifiedby: 'user', manager: 'user', delegatedapprover: 'user', user: 'user',
  companysigned: 'user', activatedby: 'user',
  account: 'account', convertedaccount: 'account', partneraccount: 'account',
  contact: 'contact', convertedcontact: 'contact', reportsto: 'contact', customersigned: 'contact',
  billtocontact: 'contact', shiptocontact: 'contact',
  opportunity: 'opportunity', convertedopportunity: 'opportunity', lead: 'lead', case: 'case',
  campaign: 'campaign', contract: 'contract', order: 'order', product2: 'product2', pricebook2: 'pricebook2',
  recordtype: 'recordtype', profile: 'profile', userrole: 'userrole', queue: 'group',
  asset: 'asset', quote: 'quote',
  // 2026-11-15 (close-out review round 2): standard relationships NOT named for their object. Unlisted, the
  // fall-through of sftkRelHop read Case's Product as an object called "product", and a rule that really reads
  // Product2's field was left alone by the removers and demoted by the sweep.
  product: 'product2', assetprovidedby: 'account', assetservicedby: 'account', rootasset: 'asset',
  companyauthorizedby: 'user', customerauthorizedby: 'contact', syncedquote: 'quote', originalorder: 'order',
});

// Parent is a self-lookup on most objects (Account, Case, Campaign…). Where it is not: Case on CaseComment /
// EmailMessage; ANY object on Attachment / Note / FeedItem / FeedComment / EntitySubscription / ContentDocumentLink
// (null = cannot be told).
const SFTK_REL_PARENT = Object.freeze({
  casecomment: 'case', emailmessage: 'case',
  attachment: null, note: null, feeditem: null, feedcomment: null, entitysubscription: null, contentdocumentlink: null,
});

// The globals that name ONE object: $User.X is User's, $Profile.X Profile's, $UserRole.X UserRole's,
// $Organization.X Organization's.
const SFTK_REL_GLOBAL = Object.freeze({ $user: 'user', $profile: 'profile', $userrole: 'userrole', $organization: 'organization' });

// One hop of a relationship path, taken from curObj.
//   curObj: the lower-case object the path stands on, or null when it is not known (a formula whose host object was
//           not given) — only Parent / MasterRecord need it; every other hop names its own object.
//   hop:    one path segment, any case ('Owner', 'Parent', 'Lookup__r', 'Owner:User').
//   → { obj: 'user' }                 the object the hop leads to (lower case)
//     { obj: null, kind }             cannot be told — kind is the TRUE reason, for the caller's refusal text:
//        'custom'  a custom relationship (…__r): its object is not in its name
//        'poly'    What / Who, or Parent on an object whose Parent can be any object (Attachment, Note…)
//        'host'    Parent / MasterRecord while the object the path stands on is not known
function sftkRelHop(curObj, hop) {
  const cur = curObj ? String(curObj).toLowerCase() : null;
  const h = String(hop == null ? '' : hop).trim().toLowerCase();
  const colon = h.indexOf(':');                         // a typed polymorphic hop, Owner:User — the type names it
  if (colon >= 0) return h.slice(colon + 1) ? { obj: h.slice(colon + 1) } : { obj: null, kind: 'poly' };
  if (h === 'parent' || h === 'masterrecord') {
    if (!cur) return { obj: null, kind: 'host' };
    if (h === 'parent' && Object.prototype.hasOwnProperty.call(SFTK_REL_PARENT, cur)) {
      const p = SFTK_REL_PARENT[cur];
      return p ? { obj: p } : { obj: null, kind: 'poly' };
    }
    return { obj: cur };                                // a self-lookup: the same object
  }
  if (Object.prototype.hasOwnProperty.call(SFTK_REL, h)) return { obj: SFTK_REL[h] };
  if (/__r$/.test(h)) return { obj: null, kind: 'custom' };
  if (h === 'what' || h === 'who') return { obj: null, kind: 'poly' };
  // an empty hop (A..B) names no object: '' matches none, so the caller reads it as another object's — as every
  // copy did before; callers test `kind`, never a falsy obj, for "cannot be told"
  return { obj: h };                                   // a standard lookup named for its object (Asset, Entitlement…)
}

// Is the answer of sftkRelHop for this hop POSITIVELY known — not the fall-through "a standard lookup named for its
// object"? (2026-11-15, close-out review round 2.) That fall-through is safe for a remover (unknown → another
// object → left alone) but not for the sweep, where "another object" DEMOTES a blocker: CampaignMember's
// LeadOrContactOwner is User or Group, not an object of that name. known = a typed hop (Owner:User), a listed
// relationship, or Parent / MasterRecord standing on an object that is itself known (curKnown).
function sftkRelHopKnown(curObj, hop, curKnown) {
  const h = String(hop == null ? '' : hop).trim().toLowerCase();
  const colon = h.indexOf(':');
  if (colon >= 0) return !!h.slice(colon + 1);
  if (h === 'parent' || h === 'masterrecord') return !!curObj && curKnown !== false && !sftkRelHop(curObj, h).kind;
  return Object.prototype.hasOwnProperty.call(SFTK_REL, h);
}

// The object a lookup ID FIELD points at (a <targetObject> of a cross-object field update: OwnerId, AccountId,
// ParentId…), taken from curObj — the same answer as its relationship hop (OwnerId → Owner → User). A custom lookup
// field (Parent__c) does not tell its object: { obj: null, kind: 'custom' }.
function sftkRelLookupField(curObj, field) {
  const f = String(field == null ? '' : field).trim().toLowerCase();
  if (!f || /__c$/.test(f)) return { obj: null, kind: 'custom' };
  return sftkRelHop(curObj, f.replace(/id$/, ''));
}

// A whole path of hops from startObj (segs: the hops only, no field at the end) — stops at the first hop that
// cannot be told.  → { obj } | { obj: null, kind }
function sftkRelWalk(startObj, segs) {
  let cur = startObj ? String(startObj).toLowerCase() : null;
  for (const s of (segs || [])) {
    const r = sftkRelHop(cur, s);
    if (r.kind) return r;
    cur = r.obj;
  }
  return { obj: cur };
}

// The $ root of a merge path. segs: the lower-case segments in front of the field ('$setup', 'obj', …).
//   → null                              not a $ root (the caller reads it as its own variable / object)
//     { obj, from }                     the object the global stands on, and the index of the first hop after it:
//                                       $User / $Profile / $UserRole / $Organization (from 1), $Setup.Obj (from 2),
//                                       $ObjectType.Obj.Fields (from 3 — nothing may follow it)
//     { obj: null, global }             a global that names no object's field ($Label, $Api, a malformed
//                                       $Setup / $ObjectType) — global is its lower-case name, for the caller's rule
function sftkRelGlobal(segs) {
  const s = (segs || []).map(x => String(x).toLowerCase());
  const g = s[0];
  if (!g || g[0] !== '$') return null;
  if (Object.prototype.hasOwnProperty.call(SFTK_REL_GLOBAL, g)) return { obj: SFTK_REL_GLOBAL[g], from: 1 };
  if (g === '$setup') return s.length >= 2 ? { obj: s[1], from: 2 } : { obj: null, global: g };
  if (g === '$objecttype') return s.length === 3 && s[2] === 'fields' ? { obj: s[1], from: 3 } : { obj: null, global: g };
  return { obj: null, global: g };
}
