// Release QA 2026-11-14 — Copy Permissions: a running copy is pinned to the
// source / target pair the confirmation named.
//
// The run read the module's targetUser at the moment each write fired, and the
// chips' ✎ Change / ✕ stayed clickable during the run. ✎ Change sent the
// remaining assignments to another user (and built an undo that would put the
// first user's old profile on the second); ✕ nulled the target, the remaining
// writes failed, the finally threw on targetUser.Name, the undo was never
// recorded and the button stayed on "Copying…".
//
// These tests run the real executeCopy / runCopy / selectUser / clearUser
// source (sliced out of the UserCopy IIFE) against stubs, and act on the
// pickers in the middle of the writes.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'user-copy.js'), 'utf8');
const slice = (a, b) => {
  const i = SRC.indexOf(a); if (i < 0) throw new Error(`marker not found: ${a}`);
  const j = SRC.indexOf(b, i); if (j < 0) throw new Error(`end marker not found: ${b}`);
  return SRC.slice(i, j);
};
const COPY_FNS = slice('  async function executeCopy() {', '  // ── Helpers');
const PICK_FNS = slice('  async function selectUser(role, user) {', '  // ── Permission Set Groups');

function makeEl(id) {
  return { id, style: {}, innerHTML: '', textContent: '', disabled: false, value: '', checked: false,
    focus() {}, querySelector() { return { addEventListener() {} }; } };
}

function build({ onPsWrite } = {}) {
  const els = {};
  const chipButtons = [makeEl('change'), makeEl('clear')];
  const document = {
    getElementById: id => (els[id] ||= makeEl(id)),
    querySelectorAll: sel => {
      if (sel === '.uc-ps-cb:checked') return ['0PS1', '0PS2', '0PS3'].map(psid => ({ dataset: { psid }, closest: () => null }));
      if (sel === '.uc-chip-change, .uc-chip-clear') return chipButtons;
      return [];
    },
  };
  const calls = { writes: [], history: [], results: [], chipsDisabledDuringWrite: [] };
  const env = {
    document,
    getOptions: () => ({ permSets: true }),
    sftkOrgWriteGate: async () => ({ production: false }),
    sftkConfirmDestructive: async () => true,
    sftkCatSm: t => t,
    friendlyMsg: m => String(m),
    showResult: (html, isErr) => calls.results.push({ html, isErr }),
    loadAndPreview: async () => {},
    pickerIds: role => ({ pick: role + 'Pick', chip: role + 'Chip', input: role + 'Input' }),
    renderList: () => {}, renderBothLists: () => {},
    sftkHistoryBegin: o => ({ o }),
    sftkHistoryEnd: async (j, rec) => { calls.history.push(rec); },
    sftkWriteVerified: async ({ write, verify }) => { const raw = await write(); const v = await verify(); return { ok: v.ok, raw }; },
    sftkWriteVerifiedAll: async (items, { verifyAll }) => {
      const res = [];
      for (const it of items) {
        let raw;
        try { raw = await it.write(); res.push({ accepted: !!(raw && raw.id), raw }); }
        catch (e) { res.push({ accepted: false, raw: { error: e.message } }); }
      }
      let v = null;
      try { v = await verifyAll(res); } catch { v = null; }
      return { results: res.map((r, i) => ({ ok: !!(v && v[i] && v[i].ok), raw: r.raw })) };
    },
    bg: async msg => {
      if (msg.type === 'SF_REST_POST') {
        calls.writes.push(msg.body);
        calls.chipsDisabledDuringWrite.push(chipButtons.every(b => b.disabled));
        if (onPsWrite) await onPsWrite(calls.writes.length, api);
        return { id: '0Pa' + calls.writes.length };
      }
      if (msg.type === 'SF_QUERY') {
        return { records: ['0PS1', '0PS2', '0PS3'].map(PermissionSetId => ({ PermissionSetId })) };
      }
      return {};
    },
  };
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, `
    let sourceUser = null, targetUser = null, copyRunning = false;
    let _orgUrl = 'https://x.my.salesforce.com', _sid = 's';
    let sourcePermSets = [], sourceGroups = [], sourceUserFields = {};
    let orgSearch = { source: null, target: null };
    function esc(s) { return String(s ?? ''); }
    ${COPY_FNS}
    ${PICK_FNS}
    return {
      executeCopy, selectUser, clearUser,
      set: (s, t) => { sourceUser = s; targetUser = t; },
      setTargetRaw: t => { targetUser = t; },
      get: () => ({ sourceUser, targetUser, copyRunning }),
    };
  `);
  const api = factory(...names.map(n => env[n]));
  return { api, calls, els, chipButtons };
}

const ADA = { Id: '005A', Name: 'Ada', Profile: { Id: '00eA', Name: 'P' }, ProfileId: '00eA', UserRoleId: null };
const BOB = { Id: '005B', Name: 'Bob', Profile: { Id: '00eB', Name: 'P' }, ProfileId: '00eB', UserRoleId: null };
const SRCU = { Id: '005S', Name: 'Src', Profile: { Id: '00eS', Name: 'P' }, ProfileId: '00eS', UserRoleId: null };

describe('Copy Permissions — the run is pinned to the confirmed pair (2026-11-14)', () => {
  it('✕ on the target chip mid-run does nothing: every write goes to the confirmed target, the undo is recorded, the button comes back', async () => {
    const { api, calls, els } = build({ onPsWrite: async (n, a) => { if (n === 1) a.clearUser('target'); } });
    api.set(SRCU, ADA);
    await api.executeCopy();
    expect(calls.writes.map(w => w.AssigneeId)).toEqual(['005A', '005A', '005A']);
    expect(api.get().targetUser).toBe(ADA);
    expect(calls.history).toHaveLength(1);
    expect(calls.history[0].undo.steps).toHaveLength(3);
    expect(els.ucCopyBtn.disabled).toBe(false);
    expect(els.ucCopyBtn.textContent).toBe('📋 Copy Selected');
    expect(api.get().copyRunning).toBe(false);
  });

  it('✎ Change + picking someone else mid-run does nothing: no assignment reaches the new person', async () => {
    const { api, calls } = build({ onPsWrite: async (n, a) => { if (n === 1) await a.selectUser('target', BOB); } });
    api.set(SRCU, ADA);
    await api.executeCopy();
    expect(calls.writes.map(w => w.AssigneeId)).toEqual(['005A', '005A', '005A']);
    expect(api.get().targetUser).toBe(ADA);
  });

  it('even if the module target changes some other way mid-run, writes and undo stay on the snapshotted target', async () => {
    const { api, calls } = build({ onPsWrite: async (n, a) => { if (n === 1) a.setTargetRaw(BOB); } });
    api.set(SRCU, ADA);
    await api.executeCopy();
    expect(calls.writes.map(w => w.AssigneeId)).toEqual(['005A', '005A', '005A']);
    expect(calls.history[0].undo.steps).toHaveLength(3);
  });

  it('the chips are disabled while the writes run and enabled again afterwards', async () => {
    const { api, calls, chipButtons } = build();
    api.set(SRCU, ADA);
    await api.executeCopy();
    expect(calls.chipsDisabledDuringWrite).toEqual([true, true, true]);
    expect(chipButtons.every(b => !b.disabled)).toBe(true);
  });

  it('with no target picked, it says so and writes nothing', async () => {
    const { api, calls } = build();
    api.set(SRCU, null);
    await api.executeCopy();
    expect(calls.writes).toHaveLength(0);
    expect(calls.results.at(-1).isErr).toBe(true);
  });
});
