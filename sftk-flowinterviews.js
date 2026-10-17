'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// sftk-flowinterviews.js — flow interviews (paused or failed runs) on the Flows
// page (user 2026-10-17: "add an option to delete flows … along with failed
// interview and rollback").
// ═══════════════════════════════════════════════════════════════════════════
// A paused interview is a user mid-flow whose progress would be lost; a failed
// one (InterviewStatus = Error) is only a saved error report. Either blocks the
// delete of its flow version (DEPENDENCY_EXISTS), so the Flows page shows them
// per flow, deletes them on request, and deletes them before a version delete.
// PURE where possible; the one write goes through sftkWriteVerifiedAll
// (sftk-write.js): every DELETE is confirmed by a re-read, never by its own
// answer. The kinds and the words come from sftk-flowsurgery.js.

// One read for the whole org — FlowInterview tables are small; the newest 2,000 is every one in practice.
const SFTK_FLOW_INTERVIEW_SOQL = 'SELECT Id, Name, InterviewLabel, InterviewStatus, CurrentElement, CreatedDate, FlowVersionViewId FROM FlowInterview ORDER BY CreatedDate DESC LIMIT 2000';

// PURE. The 15-character form of a version id — FlowVersionViewId carries that form (live 2026-09-22: the
// 18-character form matched nothing).
function sftkFlowId15(id) {
  const s = String(id || '');
  return s.length === 18 ? s.substring(0, 15) : s;
}

// PURE. Interviews grouped by the 15-character id of their version.
function sftkFlowInterviewsByVersion(interviews) {
  const out = {};
  for (const it of (Array.isArray(interviews) ? interviews : [])) {
    if (!it) continue;
    const k = sftkFlowId15(it.FlowVersionViewId);
    if (!k) continue;
    (out[k] = out[k] || []).push(it);
  }
  return out;
}

// PURE. The interviews of these versions (ids in either form), in the order of the versions.
function sftkFlowInterviewsFor(byVersion, versionIds) {
  const out = [];
  for (const id of (Array.isArray(versionIds) ? versionIds : [])) {
    const list = byVersion && byVersion[sftkFlowId15(id)];
    if (list) out.push(...list);
  }
  return out;
}

// PURE. The chip on a flow's row: "⏸ 1 paused · ✖ 4 failed" — '' when there is none.
function sftkFlowInterviewChip(kinds) {
  const k = kinds || {};
  const parts = [];
  if (k.paused) parts.push(`⏸ ${k.paused} paused`);
  if (k.failed) parts.push(`✖ ${k.failed} failed`);
  if (k.other) parts.push(`${k.other} other`);
  return parts.join(' · ');
}

// PURE. One interview as a line of a plan or a list: what it is, where it stopped, when.
function sftkFlowInterviewLine(it) {
  const failed = /^error$/i.test(String((it && it.InterviewStatus) || ''));
  const name = (it && (it.InterviewLabel || it.Name)) || '';
  const when = it && it.CreatedDate ? String(it.CreatedDate).slice(0, 10) : '';
  return `${failed ? 'failed' : 'paused'} run${name ? ` “${name}”` : ''}${it && it.CurrentElement ? ` at ${it.CurrentElement}` : ''}${when ? ` (${when})` : ''}`;
}

// Delete these interviews: one batch, one re-read (the write discipline, sftk-write.js); the journal gets
// a line per interview. Returns { deleted, failed, errors, failedIds }.
// confirmed-by: every caller confirms first — the Flows page's interviews dialog (deleteFlowInterviews)
// and onDeleteClick's interviews dialog followed by its final dialog (performDeletion)
async function sftkFlowInterviewsDelete({ send, orgUrl, sid, interviews, journal }) {
  const list = Array.isArray(interviews) ? interviews.filter(Boolean) : [];
  const out = { deleted: 0, failed: 0, errors: [], failedIds: new Set() };
  if (!list.length) return out;
  const batch = await sftkWriteVerifiedAll(list.map(it => ({
    describe: sftkFlowInterviewLine(it),
    write: () => send({ type: 'SF_REST_DELETE', orgUrl, sid, sobject: 'FlowInterview', id: it.Id, _suppressError: true }),
  })), {
    journal,   // history-by: the caller's journal — a deleted interview cannot be re-created
    verifyAll: async results => {
      const ids = list.filter((it, i) => results[i] && results[i].accepted).map(it => it.Id);
      if (!ids.length) return [];
      const lit = ids.map(x => `'${x}'`).join(',');
      const q = await send({ type: 'SF_REST_QUERY', orgUrl, sid, _suppressError: true, query: `SELECT Id FROM FlowInterview WHERE Id IN (${lit})` });
      if (!q || q.error) return null;
      const still = new Set((q.records || []).map(r => r.Id));
      return list.map(it => ({ ok: !still.has(it.Id), text: null }));
    },
  });
  list.forEach((it, i) => {
    const r = batch.results[i];
    if (r && r.ok) out.deleted++;
    else {
      out.failed++; out.failedIds.add(it.Id);
      out.errors.push(`${sftkFlowInterviewLine(it)}: ${(r && (r.text || (r.raw && r.raw.error))) || 'refused'}`);
    }
  });
  return out;
}

if (typeof globalThis !== 'undefined') {
  Object.assign(globalThis, { SFTK_FLOW_INTERVIEW_SOQL, sftkFlowId15, sftkFlowInterviewsByVersion, sftkFlowInterviewsFor,
    sftkFlowInterviewChip, sftkFlowInterviewLine, sftkFlowInterviewsDelete });
}
