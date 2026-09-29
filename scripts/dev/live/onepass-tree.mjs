// Live (campaign 3, phase 4): the Accounts tree in ONE pass, then ↩ Roll back.
// run-accounts-tree.mjs ticks every Insert + Update row in every tab from the
// FIRST scan — with phase 4 that includes grandchildren (line items) whose
// parents are missing in the target — and runs once. The CX tree in the
// target is read by CLI right there (History lives in this throwaway browser
// profile, so the rollback must happen in the SAME session); then
// retry-and-rollback.mjs (SKIP_RUN=1) rolls the run back and the CLI reads
// the target again — it must be back where the E2E runbook expects it.
//   PROFILE, RUN_WAIT, SCAN_WAIT as in run-accounts-tree.mjs;  ROLLBACK=0 keeps the run
import { execSync } from 'node:child_process';
import runTree from './run-accounts-tree.mjs';
import retryAndRollback from './retry-and-rollback.mjs';

const count = soql => {
  try {
    const t = execSync(`sf data query -o npc2 --json -q "${soql}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(t.slice(t.indexOf('{'))).result.totalSize;
  } catch (e) { return `? (${e.message.split('\n')[0]})`; }
};
const cliTree = h => h.log('CLI TARGET:', JSON.stringify({
  accounts: count("SELECT COUNT() FROM Account WHERE Name LIKE 'SFTK CX%'"),
  contacts: count("SELECT COUNT() FROM Contact WHERE Account.Name LIKE 'SFTK CX%'"),
  opps: count("SELECT COUNT() FROM Opportunity WHERE Account.Name LIKE 'SFTK CX%'"),
  lineItemsUnderCxOpps: count("SELECT COUNT() FROM OpportunityLineItem WHERE Opportunity.Account.Name LIKE 'SFTK CX%'"),
}));

export default async function (h) {
  process.env.PASSES = '1';
  cliTree(h);
  await runTree(h);
  h.log('──────── one pass done ────────');
  cliTree(h);
  if (process.env.ROLLBACK === '0') return;
  process.env.SKIP_RUN = '1';
  await retryAndRollback(h);
  h.log('──────── rolled back ────────');
  cliTree(h);
}
