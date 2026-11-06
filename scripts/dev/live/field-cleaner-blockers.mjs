// Live, read-only: Field Cleaner's blocker legs (2026-11-06). The npc fixture
// field Account.SFTK_Live_Blk__c (an Email field) is referenced by one of each
// blocker the dependency index never returns: an inactive workflow rule, a
// field update, an email alert, an outbound message, an inactive approval
// process, a criteria sharing rule, an inactive duplicate rule, an LWC schema
// import, a custom metadata record, a Lightning page, a draft Process Builder
// process and the lead field mapping — plus a layout and an email template
// (mentions). Scan 🔍 Everything → every one of them listed in its section;
// the Process Builder card carries the Setup note; 🔒 What blocks the delete
// → the same blockers from the cheap scan. Nothing written.
const NL = String.fromCharCode(10);
const dump = async (h, sel, n = 2500) => (await h.eval(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '')`)).slice(0, n).split(NL).map(x => x.trim()).filter(Boolean).join(' | ');
async function pick(h, inputSel, dropSel, api) {
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.focus(); i.dispatchEvent(new Event('focus')); return true; })()`);
  await h.waitFor(`document.querySelectorAll('${dropSel} .fc-dd-item').length > 0`, 60000, 500);
  await h.eval(`(() => { const i = document.querySelector(${JSON.stringify(inputSel)}); i.value = ${JSON.stringify(api)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await h.waitFor(`!!document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]')`, 30000, 300);
  await h.eval(`(() => { const it = document.querySelector('${dropSel} .fc-dd-item[data-api="${api}"]'); it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true; })()`);
  await h.sleep(800);
}
const groups = h => h.eval(`[...document.querySelectorAll('.fc-section')].map(s => ({ section: s.querySelector('.fc-section-title').textContent.slice(0, 2), n: s.querySelector('.fc-section-n').textContent, groups: [...s.querySelectorAll('.fc-group')].map(g => g.querySelector('.fc-group-label').textContent + ' ' + g.querySelector('.fc-group-count').textContent.trim() + ': ' + [...g.querySelectorAll('.fc-item-name')].map(i => i.textContent.trim()).join(' / ')) }))`);
async function scan(h, tag) {
  await h.eval(`(() => { document.querySelector('#fcScanBtn').click(); return true; })()`);
  await h.waitFor("!document.querySelector('#fcScanBtn')?.disabled", 600000, 1000);
  await h.sleep(1500);
  h.log(`── ${tag} ──`);
  for (const s of await groups(h)) { h.log(`${s.section} ${s.n}`); for (const g of s.groups) h.log('   ', g); }
  h.log('status:', await dump(h, '.fc-status-hd', 300) || await dump(h, '.fc-clean', 300));
  h.log('unread line:', await dump(h, '.fc-fact-warn', 600) || '(none)');
  h.log('blockers by hand:', await dump(h, '.fc-blockers', 800) || '(none)');
  h.log('PB note:', await dump(h, '.fc-pb-note', 300) || '(none)');
  h.log('delete button:', await h.eval(`(() => { const b = document.querySelector('#fcDeleteBtn, #fcDelFreeBtn'); return b ? b.textContent.trim() + (b.disabled ? ' (off)' : ' (ON)') : 'none'; })()`));
}
const EXPECT = {
  '🔒': ['Lightning Pages', 'Workflow Rules', 'Workflow Field Updates', 'Email Alerts', 'Outbound Messages', 'Approval Processes', 'Sharing Rules (criteria)', 'Duplicate Rules', 'Lightning Web Components', 'Custom Metadata Records', 'Lead Field Mapping', 'Flows'],
  '👀': ['Page Layouts', 'Email Templates'],
};

export default async function (h) {
  await h.login('npc');
  await h.popup('fields');
  await h.watchErrors();
  await h.waitFor("!!document.querySelector('#fcObjInput')", 60000, 500);
  await pick(h, '#fcObjInput', '#fcObjDrop', 'Account');
  await pick(h, '#fcFieldInput', '#fcFieldDrop', 'SFTK_Live_Blk__c');
  await h.eval(`document.querySelector('#fcScope [data-scope="both"]').click()`); await h.sleep(600);
  h.log('cost line:', await dump(h, '#fcApiCost', 300));
  await scan(h, 'scan: everything');
  const got = await groups(h);
  const missing = [];
  for (const [sec, labels] of Object.entries(EXPECT)) {
    const s = got.find(x => x.section === sec);
    for (const l of labels) if (!s || !s.groups.some(g => g.startsWith(l + ' '))) missing.push(`${sec} ${l}`);
  }
  h.log(missing.length ? `MISSING: ${missing.join(', ')}` : 'every expected group is listed in its section');
  h.log('note:', await dump(h, '.fc-howto', 1800));
  await h.shot(h.shots + '/fb-1-everything.png');
  const scrollTo = sel => h.eval(`(() => { document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'start' }); return true; })()`);
  await scrollTo('#fcSectionBlockers'); await h.sleep(500);
  await h.shot(h.shots + '/fb-1b-blockers-section.png');
  await scrollTo('#fcGroup_DuplicateRule'); await h.sleep(500);
  await h.shot(h.shots + '/fb-1c-blockers-section-2.png');
  await h.eval(`document.querySelector('.fc-howto')?.setAttribute('open', '')`); await scrollTo('.fc-howto'); await h.sleep(500);
  await h.shot(h.shots + '/fb-1d-note.png');
  await h.eval(`document.querySelector('#fcScope [data-scope="blockers"]').click()`); await h.sleep(600);
  h.log('cost line (blockers):', await dump(h, '#fcApiCost', 300));
  await scan(h, 'scan: what blocks the delete');
  await scrollTo('#fcSectionBlockers'); await h.sleep(500);
  await h.shot(h.shots + '/fb-2-blockers.png');
  await h.eval("document.querySelector('#sftkDarkToggle')?.click()"); await h.sleep(1200);
  await h.shot(h.shots + '/fb-3-blockers-dark.png');
  await scrollTo('.fc-blockers'); await h.sleep(500);
  await h.shot(h.shots + '/fb-4-gate-dark.png');
}
