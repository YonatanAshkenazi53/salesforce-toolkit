// The matching rule in Pick Records, as the page draws it since 2026-11-20 (a sentence: "It has the same [field] and
// the same [field]"). Page-side expressions for the harness scripts, so one change of the panel is one change here.
//   [data-mq-field="i"]   the i-th field of the rule (a select; '' on i > 0 removes it)
//   .ds-mq-add            "+ and the same…" (a select: picking a value adds the field)
//   input[name=dsMqTiered] the question "a record with no <later field>: match it by <first> alone?" (1 = yes)
//   #dsMqForgive          ignore small differences (the normalize options as one switch)
//   #dsMatchLive          the live result; #dsMatchSuggestBtn 💡 Try another rule; #dsMatchTestBtn 📊 Full report

// "It has the same [Account Name (Name)] and the same [Phone (Phone)] [+ and the same…]"
export const MQ_SENTENCE = `[...document.querySelectorAll('.ds-mq-sentence > *')].map(e => e.tagName === 'SELECT' ? '[' + (e.selectedOptions[0]?.text || '') + ']' : e.innerText).join(' ').replace(/\\s+/g, ' ')`;
// the rule's fields, as API names
export const MQ_FIELDS = `[...document.querySelectorAll('.ds-mq-sentence [data-mq-field]:not(.ds-mq-add)')].map(s => s.value).filter(Boolean)`;
// add one field: the first option whose API name matches `rx` (a RegExp source), else the first option there is
export const mqAdd = rx => `(() => { const a = document.querySelector('.ds-mq-add'); if (!a) return 'no room for another field'; const os = [...a.options].filter(o => o.value); const o = os.find(o => new RegExp(${JSON.stringify(rx)}).test(o.value)) || os[0]; if (!o) return 'no option'; a.value = o.value; a.dispatchEvent(new Event('change', { bubbles: true })); return o.value; })()`;
// take the i-th field out (i > 0)
export const mqRemove = i => `(() => { const s = document.querySelector('.ds-mq-sentence [data-mq-field="${i}"]:not(.ds-mq-add)'); if (!s) return false; s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`;
// 'yes' | 'no' | 'not asked' (one field: the question is not drawn)
export const MQ_TIERED = `(() => { const on = document.querySelector('input[name="dsMqTiered"]:checked'); return on ? (on.value === '1' ? 'yes' : 'no') : 'not asked'; })()`;
export const mqSetTiered = yes => `(() => { const r = document.querySelector('input[name="dsMqTiered"][value="${yes ? 1 : 0}"]'); if (!r) return false; r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`;
// the live result box, on one line
export const MQ_LIVE = `(document.querySelector('#dsMatchLive')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 400)`;
// wait until the live result has landed (or 90 s)
export const mqLiveDone = h => h.waitFor("!!document.querySelector('#dsMatchLive .ds-mq-res') && !document.querySelector('#dsMatchLive .ds-mq-spin')", 90000, 400).catch(() => {});
// open Pick Records of the root object of a fixture deployment and unfold the rule
export async function openRootMatching(h, profileName = 'SFTK CX — Accounts tree', unfold = true) {
  const id = await h.eval(`_profiles.find(p => p.name === ${JSON.stringify(profileName)})?.id`);
  if (!id) throw new Error('fixture deployment missing: ' + profileName);
  await h.eval(`window.editProfile(${JSON.stringify(id)})`); await h.sleep(1500);
  await h.waitFor("!!document.querySelector('[data-records-btn=\"\"]')", 30000, 300);
  await h.eval(`document.querySelector('[data-records-btn=""]').click()`);
  await h.waitFor("!!document.querySelector('.ds-match-fold')", 60000, 300); await h.sleep(800);
  if (unfold) await h.eval(`(() => { const d = document.querySelector('.ds-match-fold'); if (!d.open) d.open = true; return true; })()`);
  return id;
}
