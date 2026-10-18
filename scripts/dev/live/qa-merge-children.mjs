// Live QA (2026-10-18): Merge with children. Before the merge, three Contacts and one Opportunity are
// created under the copy that will be DELETED (the Eilat one); merge.mjs then merges the pair keeping
// Haifa, takes Eilat's city and types a custom revenue. Afterwards the CLI must show every child under
// the record that stayed. The children are deleted again; merge.mjs restores the pair.
// WRITES to trailheads5 (npc).
import { execFileSync } from 'node:child_process';
import merge from './merge.mjs';
const cli = args => JSON.parse(execFileSync('sf', [...args, '-o', 'npc', '--json'], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const q = s => cli(['data', 'query', '-q', `"${s}"`]).result.records || [];
const NAME = 'SFTK CX Duplicate Name';

export default async function (h) {
  const pair = q(`SELECT Id, BillingCity FROM Account WHERE Name = '${NAME}' ORDER BY CreatedDate`);
  const eilat = pair.find(r => r.BillingCity === 'Eilat');
  if (pair.length !== 2 || !eilat) throw new Error(`the fixture pair is not there (${pair.length}) — restoreDuplicateName first`);
  const made = [];
  for (const n of ['A', 'B', 'C']) made.push({ s: 'Contact', id: cli(['data', 'create', 'record', '-s', 'Contact', '-v', `"LastName='SFTK QA Merge Child ${n}' AccountId='${eilat.Id}'"`]).result.id });
  made.push({ s: 'Opportunity', id: cli(['data', 'create', 'record', '-s', 'Opportunity', '-v', `"Name='SFTK QA Merge Opp' AccountId='${eilat.Id}' StageName='Prospecting' CloseDate='2026-12-31'"`]).result.id });
  h.log('0. children created under the Eilat copy:', made.length);
  let err = null;
  try {
    await merge(h);
  } catch (e) { err = e; }
  const kids = q(`SELECT Id, AccountId, Account.Name, Account.BillingCity FROM Contact WHERE LastName LIKE 'SFTK QA Merge Child%'`);
  const opp = q(`SELECT Id, AccountId, Account.BillingCity FROM Opportunity WHERE Name = 'SFTK QA Merge Opp'`);
  const survivors = new Set([...kids, ...opp].map(r => r.AccountId));
  h.log('5. CLI children after the merge:', kids.length, 'contacts,', opp.length, 'opportunity — parents:', JSON.stringify([...survivors]), '·', [...kids, ...opp].map(r => r.Account && r.Account.BillingCity).join(','));
  const ok = kids.length === 3 && opp.length === 1 && survivors.size === 1 && !survivors.has(eilat.Id);
  h.log(ok ? '5. ✓ every child moved to the record that stayed' : '5. ❌ children were lost or left on the deleted copy');
  for (const m of made) { try { cli(['data', 'delete', 'record', '-s', m.s, '-i', m.id]); } catch (_) { /* gone with a failed merge */ } }
  h.log('6. children removed again');
  if (err) throw err;
  if (!ok) throw new Error('merge lost or misplaced children');
}
