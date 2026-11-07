// A record type on Account in BOTH trial orgs, for the ▸ record dialog's Record Type row (2026-11-07). rt-demo-clean.mjs
// cannot delete them through the API (a record type is deleted by hand in Setup: deactivate, then Delete → replace with None).
import { writeFileSync, mkdirSync } from 'node:fs';
import { NS, sf, rep } from './lib.mjs';
const X = '<?xml version="1.0" encoding="UTF-8"?>\n';
for (const org of ['npc', 'npc2']) {
  const D = `rt_${org}/force-app/main/default/objects/Account/recordTypes`;
  mkdirSync(D, { recursive: true });
  for (const n of ['SFTK_Live_RT_A', 'SFTK_Live_RT_B']) writeFileSync(`${D}/${n}.recordType-meta.xml`, `${X}<RecordType ${NS}><fullName>${n}</fullName><active>true</active><description>SFTK live demo record type. Delete by hand in Setup (deactivate, then Delete).</description><label>SFTK Live ${n.slice(-1)}</label></RecordType>\n`);
  writeFileSync(`rt_${org}/sfdx-project.json`, JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], namespace: '', sourceApiVersion: '62.0' }));
  process.chdir(`rt_${org}`);
  rep(`${org}:`, await sf(['project', 'deploy', 'start', '--source-dir', 'force-app', '-o', org, '--ignore-conflicts', '--wait', '10']));
  process.chdir('..');
}
