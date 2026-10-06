// The QA batches (scripts/dev/qa/run.mjs). Each run: { name, script, env, timeoutMin }
// or { name, node: '<inline node code>' } for a restore step. Orgs: npc =
// trailheads5 (source, Toolkit fixtures), npc2 = trailheads4 (target).
// Every run that writes either undoes itself (UNDO=1, ROLLBACK) or is followed
// by a restore step — the orgs end as they began, apart from flow version numbers.
const L = 'scripts/dev/live/';
const restoreFc = { name: 'restore-field-cleaner-fixture', node: "import('./scripts/dev/video/fixture.mjs').then(m => { const r = m.restoreFieldCleanerFixture('npc', console.log); process.exit(r.failed.length ? 1 : 0); })", timeoutMin: 10 };

// Stored values: the fixture's "fill" path needs SFTK_FC_Test_Status2__c EMPTY on the
// records that hold a copyable value (a copy that was never undone leaves it filled)
const clearStatus2 = { name: 'clear-status2-values', node: "const {execFileSync}=require('node:child_process');const q=JSON.parse(execFileSync('sf',['data','query','-o','npc','--json','-q','\"SELECT Id FROM Account WHERE SFTK_FC_Test_Status2__c != null\"'],{shell:true,encoding:'utf8'}));let n=0;for(const r of q.result.records){execFileSync('sf',['data','update','record','-o','npc','-s','Account','-i',r.Id,'-v','\"SFTK_FC_Test_Status2__c=\"','--json'],{shell:true,encoding:'utf8'});n++;}console.log('cleared SFTK_FC_Test_Status2__c on '+n+' record(s)')", timeoutMin: 5 };
// after 🗑 Delete Field: the whole fixture from scratch (rebuild.sh deploys the field, the
// permission set and flow v1–v4 and runs the flow so failed interviews exist), then the
// second flow, the layout + Lightning page, the replacement field and the seed values
const rebuildFc = { name: 'rebuild-field-cleaner-fixture', node: "const {execSync}=require('node:child_process');const run=c=>{console.log('> '+c);execSync(c,{stdio:'inherit',shell:true});};run('bash docs/fixtures/field-cleaner-fixture/rebuild.sh npc');run('cd docs/fixtures/field-cleaner-fixture/flow2 && sf project deploy start -o npc --source-dir force-app --test-level NoTestRun');run('cd docs/fixtures/field-cleaner-fixture/replace && sf project deploy start -o npc --source-dir force-app --test-level NoTestRun');run('cd docs/fixtures/field-cleaner-fixture/surfaces && sf project deploy start -o npc --source-dir force-app --test-level NoTestRun');run('sf apex run -o npc -f docs/fixtures/field-cleaner-fixture/seed-pk.apex');console.log('rebuilt')", timeoutMin: 20 };

export const BATCHES = {
  // ── the Toolkit, on trailheads5 ──
  toolkit: [
    { name: 'dependencies-readonly', script: `${L}dependencies.mjs` },
    { name: 'flow-switches-off-undo', script: `${L}flow-switches.mjs`, env: { MODE: 'off', UNDO: '1' } },
    { name: 'flow-switches-cycle', script: `${L}flow-switches.mjs`, env: { MODE: 'cycle' } },
    { name: 'api-versions-change-undo', script: `${L}api-versions.mjs`, env: { UNDO: '1' } },   // all three fixture flows → the newest option, then Undo
    { name: 'lp-detail', script: `${L}lightning-pages.mjs`, env: { STEP: 'detail' } },
    { name: 'lp-orgdefault-remove', script: `${L}lightning-pages.mjs`, env: { STEP: 'cycle' } },
    { name: 'lp-appdefault', script: `${L}lightning-pages.mjs`, env: { STEP: 'appdefault' } },
    { name: 'lp-artp', script: `${L}lightning-pages.mjs`, env: { STEP: 'artp' } },
    { name: 'lp-deactivate', script: `${L}lightning-pages.mjs`, env: { STEP: 'deactivate' } },
    { name: 'lp-clone', script: `${L}lightning-pages.mjs`, env: { STEP: 'clone' } },
    { name: 'lp-users', script: `${L}lightning-pages.mjs`, env: { STEP: 'users' } },
    { name: 'lp-whosees', script: `${L}lightning-pages.mjs`, env: { STEP: 'whosees' }, timeoutMin: 25 },
    { name: 'fc-scan-only', script: `${L}field-cleaner.mjs`, env: { SCAN_ONLY: '1' } },
    { name: 'fr-scan', script: `${L}field-replace.mjs`, env: { STEP: 'scan' } },
    { name: 'fr-access-undo', script: `${L}field-replace.mjs`, env: { STEP: 'access', UNDO: '1' } },
    { name: 'fr-layout-undo', script: `${L}field-replace.mjs`, env: { STEP: 'layout', UNDO: '1' } },
    { name: 'fr-page-undo', script: `${L}field-replace.mjs`, env: { STEP: 'page', UNDO: '1' } },
    { name: 'fr-copy-compare', script: `${L}field-replace.mjs`, env: { STEP: 'copy', COMPARE_ONLY: '1' } },
    { name: 'fr-copy-fill-undo', script: `${L}field-replace.mjs`, env: { STEP: 'copy', UNDO: '1' } },
    { name: 'fr-report-count', script: `${L}field-replace.mjs`, env: { STEP: 'rptscan', COUNT_ONLY: '1' } },
    { name: 'fr-flow-keep', script: `${L}field-replace.mjs`, env: { STEP: 'flow', FLOW: 'SFTK FC Test Flow 2', WAY: 'keep' } },
    { name: 'fr-flow-off', script: `${L}field-replace.mjs`, env: { STEP: 'flow', FLOW: 'SFTK FC Test Flow', WAY: 'off' } },
    restoreFc,
    { name: 'fr-every-replace', script: `${L}field-replace.mjs`, env: { STEP: 'every' } , timeoutMin: 30 },
    { ...restoreFc, name: 'restore-field-cleaner-fixture-2' },
    { name: 'copy-perms-undo', script: `${L}copy-perms.mjs`, env: { UNDO: '1' } },
    { name: 'flow-access-undo', script: `${L}flow-access.mjs`, env: { UNDO: '1' } },
  ],
  // ── the Toolkit, second round: the tools the first batch did not reach, and the
  // destructive end of Field Cleaner (deprecate → undo; delete the field → rebuild) ──
  toolkit2: [
    { name: 'flows-backup-delete-restore', script: `${L}flows.mjs` },
    { name: 'debugger-trace-log-viewer', script: `${L}debugger.mjs` },
    { name: 'lp-orgdefault-set-remove', script: `${L}lightning-pages.mjs`, env: { STEP: 'cycle' } },
    clearStatus2,
    { name: 'fr-copy-fill-undo', script: `${L}field-replace.mjs`, env: { STEP: 'copy', UNDO: '1' } },
    { name: 'fc-deprecate-undo', script: `${L}field-cleaner.mjs`, env: { DEPRECATE: '1' } },
    { name: 'fc-remove-all-delete-field', script: `${L}field-cleaner.mjs`, env: { DELETE_FIELD: '1' }, timeoutMin: 30 },
    rebuildFc,
    { name: 'fc-scan-after-rebuild', script: `${L}field-cleaner.mjs`, env: { SCAN_ONLY: '1' } },
  ],
  // ── Data Studio, trailheads5 → trailheads4 ──
  studio: [
    { name: 'consistency', script: `${L}consistency.mjs`, timeoutMin: 30 },
    { name: 'deploy-tree', script: `${L}deploy-tree.mjs`, env: { SCAN_KIDS: '1' }, timeoutMin: 30 },
    { name: 'needs-decision', script: `${L}needs-decision.mjs` },
    { name: 'parents-first', script: `${L}parents-first.mjs`, timeoutMin: 30 },
    { name: 'retry-and-rollback', script: `${L}retry-and-rollback.mjs`, timeoutMin: 40 },
    { name: 'flowpause-run-rollback', script: `${L}flowpause.mjs`, timeoutMin: 40 },
    { name: 'vrpause-run-rollback', script: `${L}vrpause.mjs`, timeoutMin: 40 },
    { name: 'onepass-tree-rollback', script: `${L}onepass-tree.mjs`, timeoutMin: 60 },
    { name: 'rollback-report-bin', script: `${L}rollback-report.mjs` },
    { name: 'orghealth-ring', script: `${L}orghealth.mjs`, env: { RING: '1' }, timeoutMin: 20 },
  ],
  // ── Data Studio, second round ──
  studio2: [
    { name: 'connected-orgs-rename-lock-guard', script: `${L}connected-orgs.mjs` },
    { name: 'builder-crud-export-import', script: `${L}builder.mjs` },
    { name: 'allorgs-compare', script: `${L}allorgs-compare.mjs`, timeoutMin: 30 },
    { name: 'run-retry-rollback-history', script: `${L}retry-and-rollback.mjs`, env: { HISTORY: '1' }, timeoutMin: 40 },
    { name: 'identity-create-stamp-undo', script: `${L}identity.mjs`, timeoutMin: 30 },
    { name: 'engine-bulk-rollback', script: `${L}engine-options.mjs`, env: { STEP: 'bulk' }, timeoutMin: 40 },
    { name: 'engine-duplicate-rules', script: `${L}engine-options.mjs`, env: { STEP: 'dup' }, timeoutMin: 50 },
  ],
};
