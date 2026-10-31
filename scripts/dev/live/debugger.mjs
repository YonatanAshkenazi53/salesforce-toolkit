// Live: the Apex Debugger end to end — pick the running user, Start Trace
// (TraceFlag checked with the CLI), make a log happen (one anonymous Apex
// block through the CLI as that same user), Refresh, open the log, open it in
// the standalone viewer tab, Stop Trace (TraceFlag gone — CLI), then the
// tool's History shows both entries.
//   ORG=npc          which org (default npc = trailheads5)
//   KEEP=1           leave the trace running (no Stop)
//   LOOP=1           instead of an anonymous block, save a fixture Account so the
//                    debug-loop fixture (docs/fixtures/debug-loop-fixture: a trigger
//                    that re-fires itself, two flows along) runs — the opened log
//                    must carry the LOOP badge and the Recursion banner
import { execFileSync } from 'node:child_process';
const NL = String.fromCharCode(10);
const ORG = process.env.ORG || 'npc';
const lines = (s, n = 2500) => String(s || '').slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
const cli = args => JSON.parse(execFileSync('sf', [...args, '--json'], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const traceFlags = userId => (cli(['data', 'query', '-o', ORG, '--use-tooling-api', '-q', `"SELECT Id, ExpirationDate, LogType FROM TraceFlag WHERE TracedEntityId = '${userId}'"`]).result.records || []);

export default async function (h) {
  const me = cli(['org', 'display', '-o', ORG]).result;
  const user = cli(['data', 'query', '-o', ORG, '-q', `"SELECT Id, Name FROM User WHERE Username = '${me.username}'"`]).result.records[0];
  h.log(`running user: ${user.Name} (${user.Id}) · TraceFlags before: ${traceFlags(user.Id).length}`);
  await h.login(ORG);
  await h.popup('debugger');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#adbgUserInput')", 120000, 500);
  await h.sleep(800);
  // the user box suggests on focus, filters on typing
  await h.eval("(() => { const i = document.querySelector('#adbgUserInput'); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()");
  await h.waitFor("document.querySelectorAll('#adbgUserDrop .adbg-uopt').length > 0", 60000, 500);
  h.log(`suggestions on focus: ${await h.eval("document.querySelectorAll('#adbgUserDrop .adbg-uopt').length")} user(s) · footer: ${await h.eval("document.querySelector('#adbgUserDrop .adbg-drop-more')?.innerText || '(none)'")}`);
  await h.eval(`(() => { const i = document.querySelector('#adbgUserInput'); i.value = ${JSON.stringify(user.Name.split(' ')[0])}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('#adbgUserDrop .adbg-uopt[data-id="${user.Id}"]')`, 60000, 500);
  await h.eval(`(() => { document.querySelector('#adbgUserDrop .adbg-uopt[data-id="${user.Id}"]').click(); return true; })()`);
  await h.sleep(1500);
  h.log(`picked: ${await h.eval("document.querySelector('#adbgUserInput').value")} · Start enabled: ${await h.eval("!document.querySelector('#adbgStartBtn').disabled")} · profile: ${await h.eval("document.querySelector('#adbgProfile')?.value || ''")}`);
  await h.waitFor("!/Loading/i.test(document.querySelector('#adbgLogList')?.innerText || '')", 60000, 500);
  const logsBefore = await h.eval("document.querySelectorAll('#adbgLogList .adbg-log-row').length");
  h.log(`logs listed before the trace: ${logsBefore} · count label: ${await h.eval("document.querySelector('#adbgLogCount')?.innerText || ''")}`);

  // ── Start Trace ──
  await h.click('#adbgStartBtn');
  await h.waitFor("document.querySelector('#adbgStopBtn').style.display !== 'none' || /Error/.test(document.querySelector('#adbgStatusCell')?.innerText || '')", 90000, 500);
  const status = await h.text('#adbgStatusCell');
  h.log('STATUS after Start:', lines(status));
  if (/Error/.test(status)) throw new Error('Start Trace failed: ' + status);
  const flags = traceFlags(user.Id);
  h.log(`CLI TraceFlags now: ${flags.length} → ${flags.map(f => `${f.LogType} until ${f.ExpirationDate}`).join(', ')}`);
  if (!flags.some(f => f.LogType === 'USER_DEBUG')) throw new Error('no USER_DEBUG TraceFlag in the org after Start Trace');

  // ── make a log: anonymous Apex as the same user — or, LOOP=1, one save that
  // sets the recursion fixture off (the trigger counts the field up to 5) ──
  const LOOP = process.env.LOOP === '1';
  const PROBE = LOOP ? 'SFTK_Dbg_Loop: counting up' : 'SFTK QA debugger probe';
  if (LOOP) {
    const acc = cli(['data', 'query', '-o', ORG, '-q', `"SELECT Id FROM Account WHERE Name = 'SFTK PK Account 1' LIMIT 1"`]).result.records[0];
    cli(['data', 'update', 'record', '-o', ORG, '-s', 'Account', '-i', acc.Id, '-v', '"SFTK_Dbg_Count__c=0"']);
    const after = cli(['data', 'query', '-o', ORG, '-q', `"SELECT SFTK_Dbg_Count__c FROM Account WHERE Id = '${acc.Id}'"`]).result.records[0].SFTK_Dbg_Count__c;
    h.log(`loop fixture fired: the counter went 0 → ${after} in one save (the trigger re-fired ${after} time(s))`);
    if (Number(after) < 5) throw new Error('the loop fixture did not recurse');
  } else {
    const apexFile = `${process.env.TEMP || '.'}/sftk-qa-${Date.now()}.apex`;
    (await import('node:fs')).writeFileSync(apexFile, "System.debug('SFTK QA debugger probe ' + Datetime.now()); Integer n = [SELECT COUNT() FROM Account LIMIT 5]; System.debug('accounts counted: ' + n);");
    const run = cli(['apex', 'run', '-o', ORG, '-f', apexFile]);
    h.log(`anonymous Apex: success=${run.result?.success} compiled=${run.result?.compiled} logs=${run.result?.logs ? 'yes' : 'no'}`);
  }
  await h.sleep(3000);
  await h.click('#adbgRefreshBtn');
  await h.waitFor(`document.querySelectorAll('#adbgLogList .adbg-log-row').length > ${logsBefore} || document.querySelectorAll('#adbgLogList .adbg-badge-new').length > 0`, 60000, 1000);
  const rows = await h.eval("[...document.querySelectorAll('#adbgLogList .adbg-log-row')].slice(0, 3).map(r => r.innerText.replace(/\\s+/g, ' ').trim().slice(0, 160))");
  h.log(`logs after refresh: ${await h.eval("document.querySelectorAll('#adbgLogList .adbg-log-row').length")} · newest rows:`, JSON.stringify(rows));

  // ── open the newest log ──
  // one save can leave several logs (a flow's own small one beside the Apex one) — open the biggest NEW one
  const sized = await h.eval("[...document.querySelectorAll('#adbgLogList .adbg-log-row')].map((r, i) => { const t = r.innerText.replace(/\\s+/g, ' '); const m = /([0-9.]+) ?(KB|MB|B)\\b/.exec(t) || [0, '0', 'B']; return { i, isNew: !!r.querySelector('.adbg-badge-new'), kb: parseFloat(m[1]) * (m[2] === 'MB' ? 1024 : m[2] === 'KB' ? 1 : 1 / 1024), t: t.slice(0, 60) }; })");
  const fresh = sized.filter(x => x.isNew);
  const best = (fresh.length ? fresh : sized).sort((a, b) => b.kb - a.kb)[0];
  h.log(`log rows: ${JSON.stringify(sized.slice(0, 4))} → opening #${best.i} (${best.kb.toFixed(1)} KB)`);
  await h.eval(`(() => { document.querySelectorAll('#adbgLogList .adbg-log-row')[${best.i}].click(); return true; })()`);
  await h.waitFor("!!document.querySelector('#adbgLogView') && document.querySelectorAll('#adbgLogView .adbg-ll, #adbgLogView [class*=adbg-line], #adbgLogView div').length > 3", 60000, 500);
  await h.sleep(800);
  const detail = await h.text('#adbgDetail');
  h.log('DETAIL header:', lines(detail, 900));
  const hasProbe = detail.includes(PROBE);
  h.log(`the log view shows our debug line: ${hasProbe}`);
  if (!hasProbe) throw new Error('the opened log does not contain the probe line — wrong log or the viewer dropped it');
  if (LOOP) {
    const badge = await h.eval("!!document.querySelector('#adbgLogList .adbg-log-row .adbg-badge-loop')");
    const banner = await h.eval("(document.querySelector('#adbgDetail .adbg-loop-banner')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 400)");
    const rows = await h.eval("[...document.querySelectorAll('#adbgDetail .adbg-auto-row')].map(r => r.innerText.replace(/\\s+/g, ' ').slice(0, 120))");
    h.log(`LOOP badge on the row: ${badge}`);
    h.log('RECURSION banner:', banner || '(none)');
    h.log('AUTOMATION rows:', JSON.stringify(rows.slice(0, 8)));
    const chip = await h.eval("!!document.querySelector('#adbgDetail .adbg-chip-loop')");
    const said = await h.eval("((document.querySelector('#adbgDetail')?.innerText || '').match(/[^.|]*(recursion|ran \d+ times|fired \d+ times|×\d+)[^.|]*/i) || [''])[0].trim().slice(0, 200)");
    h.log(`Recursion chip in the header: ${chip} · the analysis says: "${said}"`);
    if (!badge || !(banner || chip)) throw new Error('the Debugger did not flag the recursion');
    if (process.env.SHOT) {   // a picture of the flagged log, for the video planning
      await h.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }); await h.sleep(600);
      const r = await h.cdp('Page.captureScreenshot', { format: 'png' });
      (await import('node:fs')).writeFileSync(process.env.SHOT, Buffer.from(r.data, 'base64')); h.log('shot', process.env.SHOT);
    }
  }
  // the standalone viewer
  const tabsBefore = (await h.cdp('Target.getTargets', {}, null)).targetInfos.filter(t => t.type === 'page').length;
  await h.click('#adbgNewTabBtn');
  await h.sleep(3000);
  const targets = (await h.cdp('Target.getTargets', {}, null)).targetInfos.filter(t => t.type === 'page');
  const viewer = targets.find(t => /apex-log-viewer\.html/.test(t.url));
  h.log(`tabs: ${tabsBefore} → ${targets.length} · viewer tab: ${viewer ? viewer.url.replace(/key=.*/, 'key=…') : 'NOT OPENED'}`);
  if (!viewer) throw new Error('apex-log-viewer.html did not open');
  const { sessionId } = await h.cdp('Target.attachToTarget', { targetId: viewer.targetId, flatten: true }, null);
  for (let i = 0; i < 30; i++) {
    const r = await h.cdp('Runtime.evaluate', { expression: "document.body ? document.body.innerText.length : 0", returnByValue: true }, sessionId);
    if (r.result.value > 200) break; await h.sleep(500);
  }
  const vText = (await h.cdp('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, sessionId)).result.value;
  h.log(`VIEWER: ${vText.length} chars · shows the probe line: ${vText.includes(PROBE)} · title: ${(await h.cdp('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId)).result.value}`);
  if (!vText.includes(PROBE)) throw new Error('the standalone viewer does not show the log');

  if (process.env.KEEP === '1') { h.log('KEEP=1: trace left running'); return; }
  // ── Stop Trace ──
  await h.click('#adbgStopBtn');
  await h.waitFor("document.querySelector('#adbgStartBtn').style.display !== 'none' || /STILL ACTIVE|Couldn/.test(document.querySelector('#adbgStatusCell')?.innerText || '')", 60000, 500);
  h.log('STATUS after Stop:', lines(await h.text('#adbgStatusCell')) || '(empty — idle)');
  const after = traceFlags(user.Id);
  h.log(`CLI TraceFlags after Stop: ${after.length}`);
  if (after.some(f => f.LogType === 'USER_DEBUG' && new Date(f.ExpirationDate).getTime() > Date.now())) throw new Error('the USER_DEBUG TraceFlag is still in the org after Stop Trace');   // an expired flag from before is not the Toolkit's
  // the tool's History
  await h.click('#sftkThBtn');
  await h.waitFor("!!document.querySelector('#sftkThModalList')", 15000, 300);
  await h.sleep(500);
  const hist = await h.eval("[...document.querySelectorAll('#sftkThModalList .sftk-th-card')].slice(0, 3).map(c => c.innerText.replace(/\\s+/g, ' ').trim().slice(0, 220))");
  h.log('TOOL HISTORY (newest 3):', JSON.stringify(hist));
  if (!hist.some(c => /Trace stopped/.test(c)) || !hist.some(c => /Trace for/.test(c))) throw new Error('History lacks the trace entries');
  h.log('✓ end to end: trace started (CLI saw the flag), a log was made and shown in the tab and in the viewer, trace stopped (CLI saw it gone), History has both');
}
