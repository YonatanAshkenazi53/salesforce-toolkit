// Deploy page › ⚠ Needs a decision (user 2026-10-05, on this tab): "this screen
// is a lot better. but i would like to be able to also fix them one by one.
// also the options in the second screenshot are not clear. i think the user
// should select which record to keep and which of the dupes to delete. no?"
//
//   one by one   every name has its own 📌 Apply this one: the answer is
//                remembered at once (match memory), and both orgs are read
//                again once, when the user asks — not after every name;
//   the options  every answer is a sentence that carries the values of the
//                record it means, listed in the open (a dropdown only past 6);
//   duplicates   this tab decides which record IS which and never deletes;
//                the left-over copy is then under 🔵 Only in the target, where
//                deleting is already offered. The intro says so.
// Live 2026-10-05 (scripts/dev/live/needs-decision.mjs, both orgs): remember →
// take back → remember → re-read; trailheads4 unchanged (CLI).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const DV = read('studio-deploy.js');
const SC = read('studio-scan.js');
const M = extractFunctions('sftk-matching.js', ['sftkAmbTwice', 'sftkMemoryForget', 'sftkMemoryMerge']);
const groups = DV.slice(DV.indexOf('function _depAmbGroupsHtml('), DV.indexOf('// The deployment a parents-first step was opened FROM'));
const intro = DV.slice(DV.indexOf('function _depAmbIntro('), DV.indexOf('const SFTK_AMB_RADIO_MAX'));
const wire = DV.slice(DV.indexOf('const ambPending = () =>'), DV.indexOf("host.querySelectorAll('[data-dep-push]')"));

describe('sftkAmbTwice — one target record is one source record', () => {
  it('names the second record that claims a target already claimed', () => {
    expect(M.sftkAmbTwice([['s1', 't1'], ['s2', 't1']])).toBe('s2');
    expect(M.sftkAmbTwice([['s1', 't1'], ['s2', 't2'], ['s3', 't1']])).toBe('s3');
  });
  it('"new" and "not decided" can be said as often as needed', () => {
    expect(M.sftkAmbTwice([['s1', '__new__'], ['s2', '__new__'], ['s3', ''], ['s4', '']])).toBe('');
    expect(M.sftkAmbTwice([['s1', 't1'], ['s2', 't2']])).toBe('');
    expect(M.sftkAmbTwice(null)).toBe('');
  });
});

describe('sftkMemoryForget — a decision taken back', () => {
  it('drops only the named source ids and returns a new object', () => {
    const mem = { a: 't1', b: 't2', c: '__insert_as_new__' };
    const out = M.sftkMemoryForget(mem, ['b', 'zzz']);
    expect(out).toEqual({ a: 't1', c: '__insert_as_new__' });
    expect(mem).toEqual({ a: 't1', b: 't2', c: '__insert_as_new__' });
    expect(M.sftkMemoryForget(null, ['a'])).toEqual({});
    expect(M.sftkMemoryForget(mem, null)).toEqual(mem);
  });
  it('remember, forget, remember again ends with the pair', () => {
    let mem = M.sftkMemoryMerge({}, [['s1', 't1']]);
    mem = M.sftkMemoryForget(mem, ['s1']);
    expect(mem).toEqual({});
    expect(M.sftkMemoryMerge(mem, [['s1', 't1']])).toEqual({ s1: 't1' });
  });
  it('the page-side forget has the same guards as the learn and saves the deployments', () => {
    const fn = SC.slice(SC.indexOf('window.sftkForgetPairs = async function'), SC.indexOf('// "Refresh state"'));
    expect(fn).toContain('if (!p || p.ephemeral) return;');
    expect(fn).toContain('p.matchMemory[key] = sftkMemoryForget(p.matchMemory[key], srcIds);');
    expect(fn).toContain('await storageSaveProfiles();');
  });
});

describe('the answers are sentences, in the open', () => {
  it('each candidate answer carries that record’s telling values; "new" and "not decided" say what happens', () => {
    expect(groups).toContain("const tellText = tell => (tell || []).filter(x => x && x[1] !== '').map(x => `${x[0]}: ${x[1]}`).join(' · ');");
    // 2026-10-27: the sentences complete "<copy> is …" (the grid before them was not understood)
    expect(groups).toContain("text: `the same record as #${i + 1} in ${orgLabel(p.targetOrg)}${tellText(candTell[t]) ? ` (${tellText(candTell[t])})` : ''}");
    expect(groups).toContain("{ v: '__new__', text: `a new record — not in ${orgLabel(p.targetOrg)} yet, create it there` },");
    expect(groups).toContain("{ v: '', text: 'not decided yet — it stays out of the deployment' },");
    expect(groups).not.toContain('— decide —');
    expect(groups).not.toContain('it is #');
  });
  it('one sentence row per source copy: the copy, "is", a dropdown of the same sentences whatever the number of candidates', () => {
    expect(groups).toContain('<span class="ds-amb-is">is</span>');
    expect(groups).not.toContain('<input type="radio"');
    expect(groups).toContain('<option value="${esc(a.v)}" ${pick === a.v ? \'selected\' : \'\'}>${esc(a.text)}</option>');
  });
  it('every answer is escaped — a record value is text, never markup', () => {
    expect(groups).toContain('<option value="${esc(a.v)}" ${pick === a.v ? \'selected\' : \'\'}>${esc(a.text)}</option>');
    expect(groups).not.toMatch(/\$\{a\.text\}/);
  });
});

describe('one name at a time', () => {
  it('every group has its own button, live only while it has an answer that is not remembered yet', () => {
    expect(groups).toContain('const pending = rs.some(r => pickOf(r) !== memOf(r));');
    expect(groups).toContain('data-dep-amb-one="${esc(k)}" ${pending ? \'\' : \'disabled\'}');
    expect(groups).toContain('✓ remembered — takes effect when both orgs are read again');
  });
  it('it remembers at once and does NOT read the orgs again', () => {
    const i = wire.indexOf("host.querySelectorAll('[data-dep-amb-one]')");
    const one = wire.slice(i, wire.indexOf("eid('dsDepAmbApply')?.addEventListener('click'", i));
    expect(one).toContain('if (ambTwice(rs)) return;');
    expect(one).toContain('const lost = await ambSave(todo);');
    expect(one).toContain('repaint();');
    expect(one).not.toContain('_depRescan');
  });
  it('what is remembered is read back from the memory itself — it survives a reload, and a decision that was not kept is said', () => {
    expect(DV).toContain("const ambMemNow = () => ((_profiles.find(x => x.id === p.id) || p).matchMemory || {})[_orgKey(p.targetOrg || '')] || {};");
    expect(DV).toContain("const ambMem = r => { const v = ambMemNow()[r.sourceId]; return v === SFTK_MEM_NEW ? '__new__' : (v && (r.candidates || []).includes(v) ? v : ''); };");
    expect(wire).toContain('const lost = learn.filter(([sId, t]) => now[sId] !== t).length + forget.filter(sId => now[sId]).length;');
    expect(wire).toContain('this deployment is not a saved one, so it has no memory to keep them in. Nothing changed.');
  });
  it('"Not decided" on a remembered record forgets it', () => {
    expect(wire).toContain('const forget = recs.filter(r => !ambPick(r)).map(r => r.sourceId);');
    expect(wire).toContain('if (forget.length) await window.sftkForgetPairs?.(p.id, p.targetOrg, forget);');
  });
  it('the button above: applies what is still open and reads both orgs again — or only reads again when all is remembered', () => {
    expect(wire).toContain('📌 Apply ${nP.toLocaleString()} decision${nP === 1 ? \'\' : \'s\'} and read both orgs again');
    expect(wire).toContain('🔄 Read both orgs again — ${nK.toLocaleString()} remembered decision');
    const i = wire.indexOf("eid('dsDepAmbApply')?.addEventListener('click'");
    const all = wire.slice(i);
    expect(all).toContain('const lost = pend.length ? await ambSave(pend) : 0;');
    expect(all).toContain('if (lost) { ambNotKept(lost); repaint(); return; }');
    expect(all).toContain('await _depRescan(p);');
  });
});

describe('duplicates — this tab never deletes, and says where deleting is', () => {
  it('the intro explains the two steps', () => {
    expect(intro).toContain('<b>Nothing on this tab deletes by itself.</b> An answer only pairs records;');   // 2026-10-21: merge is offered first, and says it deletes
    expect(intro).toContain('the copy that is left over is listed under 🔵 Only in ${tgtL}, where you can tick it for deletion.');
    expect(intro).toContain('Decide one name at a time with <b>📌 Apply this one</b>');
  });
  it('nothing on this tab writes to Salesforce', () => {
    for (const w of ['SF_COLLECTIONS', 'sftkWriteVerified', 'runReconcile(', 'SF_REST_DELETE']) expect(wire).not.toContain(w);
  });
});

describe('styles', () => {
  it('the answers and the remembered mark are styled', () => {
    const CSS = read('studio.css');
    for (const c of ['.ds-amb-opts {', '.ds-amb-opt {', '.ds-amb-opt-on {', '.ds-amb-done {']) expect(CSS).toContain(c);
  });
});
