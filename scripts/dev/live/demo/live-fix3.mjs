// FLS for the demo: the admin's profile cannot see a field deployed through metadata, so a permission set grants it (live-clean2 removes it).
import { ORG, sf, soql, deploySrc } from './lib.mjs';
console.log('G5', (await deploySrc('deploy live5 (permset)', 'live5')).status);
const a = await sf(['org', 'assign', 'permset', '-o', ORG, '--name', 'SFTK_Live_Access']);
console.log('assigned:', JSON.stringify(a.result || a).slice(0, 200));
const existing = await soql("SELECT Id FROM Report WHERE Name = 'SFTK Live Report'");
if (existing.length) console.log('report: already there', existing[0].Id);
else { const r = await sf(['api', 'request', 'rest', '/services/data/v62.0/analytics/reports', '--method', 'POST', '--body', '@live4-report.json', '-o', ORG]); console.log('report:', r.reportMetadata ? r.reportMetadata.id : JSON.stringify(r).slice(0, 300)); }
