// The two QA orgs by their sf CLI alias, never by a URL typed into a script.
// WHY (2026-11-15): the trailheads5 / trailheads4 trials expired and a dozen live scripts still named them — a
// select that found no option, a guard that matched no org, a scan that never started. The alias is the stable
// name; the URL behind it is whatever `sf org display` says today.
//   SFTK_NPC_URL / SFTK_NPC2_URL (SFTK_<ALIAS>_URL) override the CLI, for a run against another pair.
import { execFileSync } from 'node:child_process';
const cache = {};
export function orgUrl(alias) {
  if (cache[alias]) return cache[alias];
  let url = process.env[`SFTK_${String(alias).toUpperCase()}_URL`];
  if (!url) {
    const out = execFileSync('sf', ['org', 'display', '-o', alias, '--json'], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] });
    url = JSON.parse(out.slice(out.indexOf('{'))).result.instanceUrl;
  }
  return (cache[alias] = new URL(url).origin);
}
// 'orgfarm-xxxx-dev-ed' — the part of the host the extension's labels and option texts carry
export const orgKey = alias => new URL(orgUrl(alias)).hostname.split('.')[0];
