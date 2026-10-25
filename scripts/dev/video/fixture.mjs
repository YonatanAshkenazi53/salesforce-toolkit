// Put the Field Cleaner fixture back after the walkthrough's Field Cleaner
// chapter replaced the field for real (docs/fixtures/field-cleaner-fixture).
// Metadata deploys only, through the Salesforce CLI:
//   • the layout and the Lightning page back on the old field (surfaces/)
//   • SFTK FC Test Flow 2 with its reference to the old field (flow2/)
//   • SFTK FC Test Flow: version file v3 (Active) and then v4 (a newer Draft)
//   • the field access the chapter copied to the replacement field, removed again
// The flows are NOT run, so no failed interviews are made and no flow-error
// e-mail is sent (rebuild.sh in the fixture folder does the full rebuild).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function restoreFieldCleanerFixture(alias = 'npc', log = () => {}) {
  const root = resolve('docs/fixtures/field-cleaner-fixture');
  const deploy = (cwd, dir) => execFileSync('sf', ['project', 'deploy', 'start', '-o', alias, '--source-dir', dir, '--test-level', 'NoTestRun', '--json'],
    { cwd, shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const done = [], failed = [];
  const step = (name, fn) => { try { fn(); done.push(name); } catch (e) { failed.push(`${name}: ${String((e && (e.stdout || e.message)) || e).slice(0, 300)}`); } };
  step('layout + Lightning page', () => deploy(join(root, 'surfaces'), 'force-app'));
  step('flow 2', () => deploy(join(root, 'flow2'), 'force-app'));
  const flows = join(root, 'base', 'force-app', 'main', 'default', 'flows');
  const file = join(flows, 'SFTK_FC_Test_Flow.flow-meta.xml');
  try {
    mkdirSync(flows, { recursive: true });
    for (const v of [3, 4]) step(`flow v${v}`, () => { copyFileSync(join(root, 'versions', `SFTK_FC_Test_Flow.v${v}.flow-meta.xml`), file); deploy(join(root, 'base'), 'force-app/main/default/flows'); });
  } finally { try { rmSync(file, { force: true }); } catch (_) {} }
  // the access the chapter copied to the replacement field: taken away again, so the
  // next recording is offered the same "copy access" step
  step('copied field access removed', () => {
    const q = JSON.parse(execFileSync('sf', ['data', 'query', '-o', alias, '--json', '-q', `"SELECT Id FROM FieldPermissions WHERE Parent.Name = 'SFTK_FC_Test_Access' AND SobjectType = 'Account' AND Field = 'Account.SFTK_FC_Test_Status2__c'"`],
      { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    for (const r of (q.result && q.result.records) || []) execFileSync('sf', ['data', 'delete', 'record', '-o', alias, '-s', 'FieldPermissions', '-i', r.Id, '--json'], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  });
  log(`Field Cleaner fixture on ${alias}: restored ${done.join(', ') || 'nothing'}${failed.length ? ` — FAILED ${failed.join(' ‖ ')}` : ''}`);
  return { done, failed };
}

// The Field Cleaner fixture rebuilt from scratch — after the chapter DELETED the
// field (rebuild.sh: field + permission set + four flow versions with their failed
// interviews; then flow 2, the four extra flows 3–6 (flows-extra/), the replacement field and the
// surfaces). Minutes.
export function rebuildFieldCleanerFixture(alias = 'npc', log = () => {}) {
  const root = resolve('docs/fixtures/field-cleaner-fixture');
  const sh = (cmd, cwd) => execFileSync(cmd, [], { cwd, shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const done = [], failed = [];
  const step = (name, fn) => { try { fn(); done.push(name); } catch (e) { failed.push(`${name}: ${String((e && (e.stdout || e.message)) || e).slice(0, 300)}`); } };
  step('rebuild.sh', () => sh(`bash "${root.replace(/\\/g, '/')}/rebuild.sh" ${alias}`, root));
  for (const part of ['flow2', 'flows-extra', 'replace', 'surfaces']) step(part, () => sh(`sf project deploy start -o ${alias} --source-dir force-app --test-level NoTestRun --json`, join(root, part)));
  log(`Field Cleaner fixture on ${alias}: rebuilt ${done.join(', ') || 'nothing'}${failed.length ? ` — FAILED ${failed.join(' ‖ ')}` : ''}`);
  return { done, failed };
}

// The 🪪 identity field (SFTK_ID__c on each object) and its permission set
// SFTK_Identity, deleted again from the orgs a chapter or a QA run created them in
// — one Metadata destructive deploy per org. Returns { done: [alias], failed: [text] }.
export function removeIdentityField(aliases, objects, log = () => {}) {
  const dir = join(process.env.TEMP || resolve('dist'), `sftk-id-cleanup-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.xml'), '<?xml version="1.0" encoding="UTF-8"?><Package xmlns="http://soap.sforce.com/2006/04/metadata"><version>62.0</version></Package>');
  writeFileSync(join(dir, 'destructiveChanges.xml'), '<?xml version="1.0" encoding="UTF-8"?><Package xmlns="http://soap.sforce.com/2006/04/metadata">'
    + `<types>${objects.map(o => `<members>${o}.SFTK_ID__c</members>`).join('')}<name>CustomField</name></types>`
    + '<types><members>SFTK_Identity</members><name>PermissionSet</name></types><version>62.0</version></Package>');
  const done = [], failed = [];
  for (const alias of aliases) {
    try {
      // a permission set cannot be deleted while it is assigned (live 2026-10-06) — the
      // assignments the tool made go first
      const q = JSON.parse(execFileSync('sf', ['data', 'query', '-o', alias, '--json', '-q', `"SELECT Id FROM PermissionSetAssignment WHERE PermissionSet.Name = 'SFTK_Identity'"`], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
      for (const r of (q.result && q.result.records) || []) execFileSync('sf', ['data', 'delete', 'record', '-o', alias, '-s', 'PermissionSetAssignment', '-i', r.Id, '--json'], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      execFileSync('sf', ['project', 'deploy', 'start', '-o', alias, '--metadata-dir', dir, '--test-level', 'NoTestRun', '--ignore-warnings', '--json'], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      done.push(alias);
    } catch (e) { failed.push(`${alias}: ${String((e && (e.stdout || e.message)) || e).slice(0, 300)}`); }
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  log(`identity field removed from ${done.join(', ') || 'nothing'}${failed.length ? ` — FAILED ${failed.join(' ‖ ')}` : ''}`);
  return { done, failed };
}

// The duplicate pair "SFTK CX Duplicate Name" of the complex-deployment fixture
// (seed-source.apex: Haifa / 1 and Eilat / 2), put back after a 🔀 Merge made it
// one record — the record that stayed gets Haifa / 1 again, the Eilat copy is
// inserted again, through the same DML options the seed uses (the org's
// duplicate rules stay as they are: the fixture carries duplicates on purpose).
// Returns { before, after } counts, or { failed }.
// The TARGET's copy of "SFTK CX Duplicate Name" (seed-target.apex: "Target twin" / 3) gets a
// second copy (Haifa / 1) so the deploy chapter can show 🔀 Merge both sides (user 2026-10-23);
// restoreTargetTwin puts the fixture's copy back to its values and removes every other copy.
function _dupNameApex(alias, lines, log, what, countQuery) {
  const dir = join(process.env.TEMP || resolve('dist'), `sftk-duptgt-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'run.apex');
  writeFileSync(file, ["Database.DMLOptions dmo = new Database.DMLOptions(); dmo.DuplicateRuleHeader.allowSave = true; dmo.DuplicateRuleHeader.runAsCurrentUser = true; dmo.optAllOrNone = true;", ...lines].join('\n'));
  try {
    execFileSync('sf', ['apex', 'run', '-o', alias, '--file', `"${file}"`, '--json'], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const q = JSON.parse(execFileSync('sf', ['data', 'query', '-o', alias, '--json', '-q', `"${countQuery || "SELECT Id, BillingCity, AnnualRevenue FROM Account WHERE Name = 'SFTK CX Duplicate Name' ORDER BY CreatedDate"}"`], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const after = ((q.result && q.result.records) || []).map(r => r.n != null ? `${r.n}` : r.expr0 != null ? `${r.expr0}` : `${r.Id}:${r.BillingCity || r.Phone || ''}/${r.AnnualRevenue == null ? '' : r.AnnualRevenue}`);
    log(`${what} on ${alias}: ${after.length} record(s) (${after.join(', ')})`);
    return { after };
  } catch (e) {
    const failed = String((e && (e.stdout || e.message)) || e).slice(0, 400);
    log(`${what} on ${alias}: FAILED — ${failed}`);
    return { failed };
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
}
export function seedTargetTwinCopy(alias = 'npc2', log = () => {}) {
  return _dupNameApex(alias, [
    "List<Account> have = [SELECT Id FROM Account WHERE Name = 'SFTK CX Duplicate Name' ORDER BY CreatedDate];",
    "if (have.isEmpty()) Database.insert(new Account(Name='SFTK CX Duplicate Name', Industry='Energy', BillingCity='Target twin', AnnualRevenue=3), dmo);",
    "if (have.size() < 2) Database.insert(new Account(Name='SFTK CX Duplicate Name', Industry='Energy', BillingCity='Haifa', AnnualRevenue=1), dmo);",
  ], log, 'Duplicate Name twin seeded');
}
export function restoreTargetTwin(alias = 'npc2', log = () => {}) {
  return _dupNameApex(alias, [
    "List<Account> have = [SELECT Id FROM Account WHERE Name = 'SFTK CX Duplicate Name' ORDER BY CreatedDate];",
    "if (have.isEmpty()) { Database.insert(new Account(Name='SFTK CX Duplicate Name', Industry='Energy', BillingCity='Target twin', AnnualRevenue=3), dmo); return; }",
    "have[0].Industry = 'Energy'; have[0].BillingCity = 'Target twin'; have[0].AnnualRevenue = 3; Database.update(have[0], dmo);",
    "if (have.size() > 1) { List<Account> gone = new List<Account>(); for (Integer i = 1; i < have.size(); i++) gone.add(have[i]); delete gone; }",
  ], log, 'Duplicate Name target copy restored');
}

// The ONE deployment of the video (user 2026-10-25: "only one example of data deployment … nothing twice"):
// accounts of the SFTK VOL blocks 000–006 and their contacts. Off camera the source blocks get what the
// matching chapter needs — a phone on every account and an account number on nine of ten (most specific
// first: 100% names, 90% numbers) — once, where they are still empty.
export function enrichVolBlocks(alias = 'npc', log = () => {}) {
  return _dupNameApex(alias, [
    "List<Account> accs = [SELECT Id, Name, Phone, AccountNumber FROM Account WHERE (Name LIKE 'SFTK VOL Account 000%' OR Name LIKE 'SFTK VOL Account 001%' OR Name LIKE 'SFTK VOL Account 002%' OR Name LIKE 'SFTK VOL Account 003%' OR Name LIKE 'SFTK VOL Account 004%' OR Name LIKE 'SFTK VOL Account 005%' OR Name LIKE 'SFTK VOL Account 006%') AND Phone = null];",
    "for (Account a : accs) { String n = a.Name.substring(a.Name.length() - 5); a.Phone = '03-555-' + n.substring(1); if (Math.mod(Integer.valueOf(n), 10) != 0) a.AccountNumber = 'VOL-' + n; }",
    "if (!accs.isEmpty()) Database.update(accs, dmo);",
    // the opportunities of block 000 point at one campaign the target does not have: the parent synced on camera
    "List<Campaign> cs = [SELECT Id FROM Campaign WHERE Name = 'SFTK VOL Campaign' LIMIT 1];",
    "Campaign cmp = cs.isEmpty() ? new Campaign(Name='SFTK VOL Campaign', IsActive=true, Type='Other') : cs[0];",
    "if (cs.isEmpty()) insert cmp;",
    "List<Opportunity> opps = [SELECT Id FROM Opportunity WHERE Name LIKE 'SFTK VOL Opp 000%' AND CampaignId = null];",
    "for (Opportunity o : opps) o.CampaignId = cmp.Id;",
    "if (!opps.isEmpty()) update opps;",
    "System.debug('enriched ' + accs.size() + ' accounts, ' + opps.size() + ' opportunities');",
  ], log, 'Volume blocks enriched', "SELECT COUNT(Id) n FROM Account WHERE Name LIKE 'SFTK VOL Account 00%' AND Phone != null");
}
// One account the target has and the source does not (🔵 In target only).
export function seedVolExtra(alias = 'npc2', log = () => {}) {
  return _dupNameApex(alias, [
    "List<Account> have = [SELECT Id FROM Account WHERE Name = 'SFTK VOL Account 000 Extra'];",
    "if (have.isEmpty()) Database.insert(new Account(Name='SFTK VOL Account 000 Extra', Industry='Energy', BillingCity='City 0', Phone='03-555-0000'), dmo);",
  ], log, 'Volume extra example', "SELECT Id, Phone FROM Account WHERE Name = 'SFTK VOL Account 000 Extra'");
}
// The campaigns the parents-first step wrote into the target (today's), gone again.
export function removeVolCampaigns(alias = 'npc2', log = () => {}) {
  return _dupNameApex(alias, [
    "delete [SELECT Id FROM Campaign WHERE CreatedDate = LAST_N_DAYS:1];",
  ], log, 'Campaigns written today removed', "SELECT COUNT(Id) n FROM Campaign");
}
// Two copies of one name inside block 000 — in the source Haifa / 1 and Eilat / 2; in the target "Target
// twin" / 3 and Haifa / 1 — so the one deployment shows ⚠ Needs a decision and 🔀 Merge both sides.
export const VOL_TWIN = 'SFTK VOL Account 000 Twin';
export function seedVolTwins(alias, side, log = () => {}) {
  const a = side === 'src' ? ["'Haifa', 1", "'Eilat', 2"] : ["'Target twin', 3", "'Haifa', 1"];
  return _dupNameApex(alias, [
    `List<Account> have = [SELECT Id, BillingCity, AnnualRevenue FROM Account WHERE Name = '${VOL_TWIN}' ORDER BY CreatedDate];`,
    `if (have.size() >= 2) return;`,
    `if (have.size() == 1) { have[0].Industry = 'Energy'; have[0].BillingCity = ${a[0].split(', ')[0]}; have[0].AnnualRevenue = ${a[0].split(', ')[1]}; Database.update(have[0], dmo); }`,
    `else Database.insert(new Account(Name='${VOL_TWIN}', Industry='Energy', BillingCity=${a[0].split(', ')[0]}, AnnualRevenue=${a[0].split(', ')[1]}, Phone='03-555-0900'), dmo);`,
    `Database.insert(new Account(Name='${VOL_TWIN}', Industry='Energy', BillingCity=${a[1].split(', ')[0]}, AnnualRevenue=${a[1].split(', ')[1]}, Phone='03-555-0900'), dmo);`,
  ], log, `Volume twins (${side})`, `SELECT Id, BillingCity, AnnualRevenue FROM Account WHERE Name = '${VOL_TWIN}' ORDER BY CreatedDate`);
}
// One account of block 000 present in the target with another phone: the 🟡 Changed example.
export function seedVolChanged(alias = 'npc2', log = () => {}) {
  return _dupNameApex(alias, [
    "List<Account> have = [SELECT Id FROM Account WHERE Name = 'SFTK VOL Account 00001'];",
    "if (have.isEmpty()) Database.insert(new Account(Name='SFTK VOL Account 00001', Industry='Energy', BillingCity='City 1', Phone='00-000-0000', AnnualRevenue=1000), dmo);",
  ], log, 'Volume changed example', "SELECT Id, Phone FROM Account WHERE Name = 'SFTK VOL Account 00001'");
}

export function restoreDuplicateName(alias = 'npc', log = () => {}) {
  const apex = [
    "Database.DMLOptions dmo = new Database.DMLOptions(); dmo.DuplicateRuleHeader.allowSave = true; dmo.DuplicateRuleHeader.runAsCurrentUser = true; dmo.optAllOrNone = true;",
    "List<Account> have = [SELECT Id, BillingCity, AnnualRevenue FROM Account WHERE Name = 'SFTK CX Duplicate Name' ORDER BY CreatedDate];",
    "if (have.size() >= 2) { System.debug('SFTK restore: nothing to do, ' + have.size()); return; }",
    "if (have.size() == 1) { have[0].Industry = 'Energy'; have[0].BillingCity = 'Haifa'; have[0].AnnualRevenue = 1; Database.update(have[0], dmo); }",
    "else Database.insert(new Account(Name='SFTK CX Duplicate Name', Industry='Energy', BillingCity='Haifa', AnnualRevenue=1), dmo);",
    "Database.insert(new Account(Name='SFTK CX Duplicate Name', Industry='Energy', BillingCity='Eilat', AnnualRevenue=2), dmo);",
  ].join('\n');
  const dir = join(process.env.TEMP || resolve('dist'), `sftk-dupname-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'restore.apex');
  writeFileSync(file, apex);
  const count = () => {
    const q = JSON.parse(execFileSync('sf', ['data', 'query', '-o', alias, '--json', '-q', "\"SELECT Id, BillingCity, AnnualRevenue FROM Account WHERE Name = 'SFTK CX Duplicate Name'\""],
      { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    return ((q.result && q.result.records) || []).map(r => `${r.Id}:${r.BillingCity}/${r.AnnualRevenue}`);
  };
  try {
    const before = count();
    execFileSync('sf', ['apex', 'run', '-o', alias, '--file', `"${file}"`, '--json'], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const after = count();
    log(`Duplicate Name pair on ${alias}: ${before.length} → ${after.length} (${after.join(', ')})`);
    return { before, after };
  } catch (e) {
    const failed = String((e && (e.stdout || e.message)) || e).slice(0, 400);
    log(`Duplicate Name pair on ${alias}: restore FAILED — ${failed}`);
    return { failed };
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
}

// The SFTK VOL records removed from an org (cleanup-volume.apex, 9,000 a run, until none
// is left). A finished volume chapter rolls its records back itself; this is for the chapter
// that did not finish. Returns the number removed, or { failed }.
export function removeVolume(alias = 'npc2', log = () => {}) {
  const count = () => {
    const q = JSON.parse(execFileSync('sf', ['data', 'query', '-o', alias, '--json', '-q', '"SELECT COUNT(Id) n FROM Account WHERE Name LIKE \'SFTK VOL Account %\'"'],
      { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const r = ((q.result && q.result.records) || [])[0] || {};
    return Number(r.n != null ? r.n : r.expr0) || 0;
  };
  try {
    let left = count(), removed = 0, rounds = 0;
    while (left > 0 && rounds < 6) {
      execFileSync('sf', ['apex', 'run', '-o', alias, '--file', 'docs/fixtures/complex-deployment/cleanup-volume.apex', '--json'], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const now = count(); removed += left - now; left = now; rounds++;
    }
    log(`volume records on ${alias}: ${removed} removed, ${left} left`);
    return removed;
  } catch (e) {
    const failed = String((e && (e.stdout || e.message)) || e).slice(0, 300);
    log(`volume records on ${alias}: cleanup FAILED — ${failed}`);
    return { failed };
  }
}
