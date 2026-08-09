// ── Friendly error translation (shared: popup + Data Studio) ─────────────────
// Turns raw run-error strings ("update: contact: Email: invalid email address:
// b.levy@expressl&amp;t.net") into { kind, type, phase, object, message, hint,
// fields, raw } so the UI can render plain language with the raw text kept
// for copy/paste. Top-level functions so test/extract.mjs can unit-test them.

// Decode the handful of HTML entities that show up in org data that was
// HTML-escaped by an earlier bad copy (the "expressl&amp;t.net" emails).
function sftkDecodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function sftkFriendlyError(raw) {
  // Phase prefixes our run composers prepend ("update: …", "push: …").
  // Inside the function so test extraction gets a self-contained unit.
  const SFTK_ERR_PHASES = {
    push:    'inserting into the target',
    insert:  'inserting into the target',
    update:  'updating target records',
    updsrc:  'updating source records',
    delete:  'deleting from the target',
    pull:    'copying into the source',
    relink:  'relinking lookups',
    connect: 'reconnecting children',
    scan:    'scanning',
    'dry-run': 'validating',
  };
  let s = String(raw ?? '').trim();
  const kind = s.includes('⚠') ? 'note' : 'error';
  s = s.replace(/^[⚠❌✖✕x]\s*/i, '').trim();

  // "(×17)" duplicate-count suffix — preserve, strip for parsing.
  let count = 1;
  const xm = s.match(/\s*\(×(\d+)\)\s*$/);
  if (xm) { count = parseInt(xm[1], 10); s = s.slice(0, xm.index).trim(); }

  // Leading phase prefix.
  let phase = null;
  const pm = s.match(/^(push|insert|update|updSrc|delete|pull|relink|connect|scan|dry-run)\s*:\s*/i);
  if (pm) { phase = SFTK_ERR_PHASES[pm[1].toLowerCase()] || pm[1]; s = s.slice(pm[0].length); }
  s = s.replace(/^[⚠❌]\s*/, '').trim();   // composers sometimes double-mark

  // Leading object token ("contact: …") — a single lowercase-ish word followed
  // by a colon that is NOT itself a field-error prefix like "Email:".
  let object = null;
  const om = s.match(/^([A-Za-z0-9_]+__c|[a-z][a-z0-9_]*)\s*:\s+/);
  if (om) { object = om[1]; s = s.slice(om[0].length); }

  const out = { kind, type: 'generic', phase, object, message: s, hint: null, fields: null, count, raw: String(raw) };

  // ── Structured note: skipped mapped fields ────────────────────────────────
  let m = s.match(/skipped \d+ mapped field\(?s?\)? that no longer exist[^:]*:\s*(.+?)(?:\s+—\s+open.*)?$/i);
  if (m) {
    out.type = 'skipped-fields';
    out.fields = m[1].split(/,\s*/).map(f => ({ field: f.trim(), reason: 'no longer exists in the source org' }));
    out.message = `${out.fields.length} mapped field${out.fields.length !== 1 ? 's' : ''} skipped — deleted from the source org`;
    out.hint = 'Open ✏ Edit → Fields & mapping and remove the stale entries (🧹 button).';
    return out;
  }
  m = s.match(/skipped \d+ mapped field\(?s?\)? the target org can'?t accept:\s*(.+?)(?:\s+—\s+open.*)?$/i);
  if (m) {
    out.type = 'skipped-fields';
    out.fields = m[1].split(/,\s*(?=[A-Za-z0-9_]+\s*→)/).map(pair => {
      const pm2 = pair.match(/^(.+?)\s*→\s*(.+?)\s*\((.+)\)\s*$/);
      return pm2
        ? { field: pm2[1].trim() === pm2[2].trim() ? pm2[1].trim() : `${pm2[1].trim()} → ${pm2[2].trim()}`, reason: pm2[3].trim() }
        : { field: pair.trim(), reason: '' };
    });
    out.message = `${out.fields.length} mapped field${out.fields.length !== 1 ? 's' : ''} skipped — the target org can't accept them`;
    out.hint = 'These columns were left out for every record (State/Country picklist fields only exist where that feature is enabled; read-only fields can never be written). Open ✏ Edit → Fields & mapping to tidy the list.';
    return out;
  }

  // ── Field-level failures ──────────────────────────────────────────────────
  m = s.match(/^([A-Za-z0-9_]+)\s*:\s*invalid email address:\s*(.+)$/i) || s.match(/invalid email address:\s*(.+)$/i);
  if (m) {
    const val = m[2] || m[1];
    out.type = 'bad-value';
    out.message = `Email "${val}" isn't a valid address, so Salesforce rejected the whole record`;
    if (/&(amp|lt|gt|quot|#39);/.test(val)) {
      out.hint = `The address contains HTML-escaped text ("&amp;" instead of "&") — leftover from an earlier copy. Fix the record's Email in the source org to "${sftkDecodeEntities(val)}", or exclude Email from the field mapping.`;
    } else {
      out.hint = 'Fix the address on the source record, or exclude Email from the field mapping.';
    }
    return out;
  }
  m = s.match(/No such column '([^']+)'/i);
  if (m) {
    out.type = 'missing-field';
    out.message = `Field ${m[1]} doesn't exist ${/target/i.test(s) ? 'in the target org' : 'on this object'}`;
    out.hint = 'Usually a stale field mapping — open ✏ Edit → Fields & mapping and remove or remap it.';
    return out;
  }
  m = s.match(/REQUIRED_FIELD_MISSING[^[]*\[([^\]]*)\]/i) || s.match(/Required fields? (?:are|is) missing:?\s*\[?([^\]]*)\]?/i);
  if (m) {
    out.type = 'required-missing';
    out.message = `Required field${m[1].includes(',') ? 's' : ''} ${m[1]} ${m[1].includes(',') ? 'are' : 'is'} empty in the target org`;
    // The MOST COMMON cause when the missing field is a lookup: the records
    // it should point at don't exist in the target yet, so name-matching
    // resolved nothing and the field landed empty (user 2026-08-09: 401
    // Step Orders failed because Procedure Definitions weren't deployed
    // first). Lead with the deploy-order fix; the mapping advice stays for
    // genuinely unmapped data fields.
    out.hint = m[1].endsWith('__c') || /Id$/.test(m[1].trim())
      ? 'If this is a lookup, the records it points at usually don\'t exist in the target yet — deploy the referenced object FIRST (parents before children), or hand-pick targets via the 🔗 panel in Reconcile. For a plain data field: map it from a source field, or relax the requirement in the target.'
      : 'The target org requires these fields. Map them from a source field, or relax the requirement in the target.';
    return out;
  }
  if (/FIELD_CUSTOM_VALIDATION_EXCEPTION/i.test(s)) {
    out.type = 'validation-rule';
    const msg = s.replace(/^.*FIELD_CUSTOM_VALIDATION_EXCEPTION[,:]?\s*/i, '').replace(/:\s*\[.*\]$/, '');
    out.message = `A validation rule in the target org rejected the record${msg ? `: “${msg}”` : ''}`;
    out.hint = 'Fix the data to satisfy the rule, or temporarily deactivate the validation rule while migrating.';
    return out;
  }
  if (/DUPLICATES_DETECTED/i.test(s)) {
    out.type = 'duplicate';
    out.message = 'The target org\'s duplicate rules matched an existing record and blocked the write';
    out.hint = 'Use Upsert with an external-id match field, or relax the duplicate rule during migration.';
    return out;
  }
  if (/INSUFFICIENT_ACCESS/i.test(s)) {
    out.type = 'permission';
    out.message = 'Your user doesn\'t have permission for this write in the target org';
    out.hint = 'Check object/field permissions (and sharing rules for cross-reference records) for your user.';
    return out;
  }
  if (/INVALID_CROSS_REFERENCE_KEY/i.test(s)) {
    out.type = 'bad-lookup';
    out.message = 'A lookup on the record points at something that doesn\'t exist in the target org';
    out.hint = 'Transfer the parent records first (child-first order handles this), or clear the lookup from the mapping.';
    return out;
  }
  m = s.match(/STRING_TOO_LONG[,:]?\s*(.*?)(?::\s*\[([^\]]*)\])?$/i);
  if (m) {
    out.type = 'bad-value';
    out.message = `A value is too long for its target field${m[2] ? ` (${m[2]})` : ''}`;
    out.hint = 'The target field is shorter than the source field — shorten the data or widen the target field.';
    return out;
  }
  if (/UNABLE_TO_LOCK_ROW/i.test(s)) {
    out.type = 'transient';
    out.message = 'The record was locked by another operation in the target org';
    out.hint = 'Transient — ↻ Retry failed usually succeeds.';
    return out;
  }
  if (/CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY/i.test(s)) {
    out.type = 'automation';
    const tail = s.replace(/^.*CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY[,:]?\s*/i, '');
    out.message = `An automation (trigger or flow) in the target org failed while saving${tail ? `: ${tail}` : ''}`;
    out.hint = 'The failure is inside the target org\'s own automation — check its flows/triggers for this object.';
    return out;
  }
  if (/SESSION_EXPIRED|INVALID_SESSION_ID/i.test(s)) {
    out.type = 'session';
    out.message = 'The org session expired mid-run';
    out.hint = 'Open the org in a Chrome tab to refresh the session, then ↻ Retry failed.';
    return out;
  }
  return out;
}

if (typeof globalThis !== 'undefined') {
  globalThis.sftkFriendlyError = sftkFriendlyError;
  globalThis.sftkDecodeEntities = sftkDecodeEntities;
}
