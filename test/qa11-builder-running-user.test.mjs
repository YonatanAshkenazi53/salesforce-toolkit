// QA 1.1 finding 64 — the running user's name was cached per org URL, so it survived a Login As / a new sign-in on the same org.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const VE = readFileSync(new URL('../studio-valueedit.js', import.meta.url), 'utf8');
const start = VE.indexOf('const _sftkVeMe = new Map();');
const end = VE.indexOf('\n}', VE.indexOf('async function sftkVeRunningUser(', start)) + 2;
const make = sendBg => new Function('sendBg', `${VE.slice(start, end)}\nreturn sftkVeRunningUser;`)(sendBg);

// the org answers with the user the session belongs to
const org = (bySid, calls) => async msg => { calls.push(msg); return bySid[msg.sid] || { error: 'INVALID_SESSION_ID' }; };
const ORG = 'https://acme.my.salesforce.com';

describe('the user who runs the deployment', () => {
  it('is read once for a session', async () => {
    const calls = [];
    const me = make(org({ A: { name: 'Admin A' } }, calls));
    expect(await me({ orgUrl: ORG, sid: 'A' })).toBe('Admin A');
    expect(await me({ orgUrl: ORG, sid: 'A' })).toBe('Admin A');
    expect(calls.length).toBe(1);
  });
  it('is read again when the same org carries another session — Login As, or a new sign-in', async () => {
    const calls = [];
    const me = make(org({ A: { name: 'Admin A' }, B: { name: 'User B' } }, calls));
    expect(await me({ orgUrl: ORG, sid: 'A' })).toBe('Admin A');
    expect(await me({ orgUrl: ORG, sid: 'B' })).toBe('User B');
    expect(await me({ orgUrl: ORG, sid: 'B' })).toBe('User B');
    expect(calls.map(c => c.sid)).toEqual(['A', 'B']);
    // back to the first user: the name is A's again, never the one remembered for B
    expect(await me({ orgUrl: ORG, sid: 'A' })).toBe('Admin A');
  });
  it('a new session whose name cannot be read says nothing — not the name of the user before it', async () => {
    const calls = [];
    const me = make(org({ A: { name: 'Admin A' } }, calls));
    expect(await me({ orgUrl: ORG, sid: 'A' })).toBe('Admin A');
    expect(await me({ orgUrl: ORG, sid: 'gone' })).toBe('');
  });
  it('two orgs keep their own names; no session, no read', async () => {
    const calls = [];
    const me = make(org({ A: { name: 'Admin A' }, T: { preferred_username: 't@x.example' } }, calls));
    expect(await me({ orgUrl: ORG, sid: 'A' })).toBe('Admin A');
    expect(await me({ orgUrl: 'https://other.my.salesforce.com', sid: 'T' })).toBe('t@x.example');
    expect(await me({ orgUrl: ORG, sid: 'A' })).toBe('Admin A');
    expect(await me(null)).toBe('');
    expect(await me({ orgUrl: ORG })).toBe('');
    expect(calls.length).toBe(2);
  });
});
