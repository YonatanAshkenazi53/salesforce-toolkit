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
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
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
