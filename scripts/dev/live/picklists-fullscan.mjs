// Live (campaign 3, phase 6): the picklist automation check reads EVERY active
// flow. Calls _pkValueLiteralScan in Data Studio with the real session (the same
// function the deactivate / bulk / sync wizards run) and prints what it read.
// Compare flowsFound with the CLI:
//   sf data query -o npc -q "SELECT COUNT() FROM FlowDefinitionView WHERE IsActive = true AND ProcessType IN ('AutoLaunchedFlow','Flow')"
//   OBJ (default Account) · VALUE (default Closed)
export default async function (h) {
  await h.login(process.env.ORG || 'npc'); await h.studio(''); await h.watchErrors();
  const obj = process.env.OBJ || 'Account', value = process.env.VALUE || 'Closed';
  const t0 = Date.now();
  const out = await h.eval(`(async () => {
    const sess = (_allSessions || []).find(s => /trailheads5/.test(s.orgUrl)) || (typeof getOrgSession === 'function' ? await getOrgSession('https://trailheads5.my.salesforce.com') : null);
    if (!sess) return 'no session';
    const progress = [];
    const r = await _pkValueLiteralScan({ obj: ${JSON.stringify(obj)}, orgUrl: sess.orgUrl, sid: sess.sid }, ${JSON.stringify(value)}, t => progress.push(t));
    return JSON.stringify({ scan: r.scan, notes: r.notes, hits: r.hits, progress });
  })()`);
  h.log(`SCAN (${((Date.now() - t0) / 1000).toFixed(1)} s):`, out);
}
