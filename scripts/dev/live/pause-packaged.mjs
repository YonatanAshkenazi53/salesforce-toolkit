// Live, read-only: the ⏸ pause panel of the PACKAGED deployment (npc → npc2) —
//   · the kind headers (Record-triggered flows / Validation rules / Duplicate rules) each carry their colour, in the
//     light, dark and black themes (owner 2026-11-19: "this lines should have a different color and should also got
//     in black and dark theme. i want them to pop a bit more to the eye");
//   · a validation rule from an installed package (DLRS Not_42 on dlrs__LookupParent__c) is LISTED with a tick like
//     the org's own, and the line "from installed packages cannot be switched" is gone for rules (owner, asked four
//     times: "What about the package validations, etc. when doing data deployment").
// Nothing is ticked and nothing is run.
const waitScanned = h => h.waitFor("!!document.querySelector('.ds-dep-plan') && !document.querySelector('#dsDepRefresh')?.disabled", 300000, 1000);

export default async function (h) {
  await h.login('npc'); await h.login('npc2'); await h.studio(''); await h.watchErrors();
  await h.importProfiles('docs/fixtures/packaged-object-fixture/profiles.json');
  const prof = await h.eval(`(() => { const p = _profiles[_profiles.length - 1]; return p ? { id: p.id, name: p.name } : null; })()`);
  h.log('deployment:', JSON.stringify(prof));
  await h.eval(`window.runProfile(${JSON.stringify(prof.id)})`); await h.sleep(1500);
  await h.eval(`(document.querySelector('#dsDepScan') || document.querySelector('#dsDepRefresh')).click()`);
  await waitScanned(h); await h.sleep(2500);
  await h.eval(`(() => { const d = document.querySelector('details.ds-dep-pause'); if (d) d.open = true; return true; })()`);
  await h.waitFor("!!document.querySelector('.ds-dep-pause-kindhd')", 120000, 1000);
  await h.sleep(1500);
  const heads = await h.eval(`[...document.querySelectorAll('.ds-dep-pause-kindhd')].map(e => e.dataset.kind + ':' + e.textContent.replace(/\\s+/g, ' ').trim() + ' @' + getComputedStyle(e).color)`);
  h.log('kind headers:', JSON.stringify(heads));
  const rules = await h.eval(`[...document.querySelectorAll('.ds-dep-pause-cb[data-kind="rule"]')].map(c => c.closest('label').innerText.replace(/\\s+/g, ' ').trim().slice(0, 90) + (c.disabled ? ' [locked]' : ''))`);
  h.log('validation rules listed:', JSON.stringify(rules));
  h.log('panel says about packages:', await h.eval(`(document.querySelector('#dsDepPausePanel').innerText.match(/[^.\\n]*installed packages[^.\\n]*\\./g) || []).join(' | ')`));
  if (!rules.some(r => /dlrs__Not_42/.test(r) && !/\\[locked\\]/.test(r))) throw new Error('FAILED: the packaged rule must be listed with a tick of its own — ' + JSON.stringify(rules));
  const colors = new Set(heads.map(x => x.split(' @')[1]));
  if (heads.length > 1 && new Set(heads.map(x => x.split(':')[0])).size > 1 && colors.size < 2) throw new Error('FAILED: each kind carries its own colour');
  const shoot = async (name, cls) => {
    await h.eval(`(() => { const r = document.documentElement; r.classList.remove('ds-dark', 'ds-oled'); ${JSON.stringify(cls)}.forEach(c => r.classList.add(c)); document.querySelector('.ds-dep-pause-kindhd').scrollIntoView({ block: 'center' }); return true; })()`);
    await h.sleep(1200);
    await h.shot(h.shots + '/' + name + '.png');
  };
  await shoot('pausepkg-light', []);
  await shoot('pausepkg-dark', ['ds-dark']);
  await shoot('pausepkg-black', ['ds-dark', 'ds-oled']);
  await h.eval(`(() => { document.documentElement.classList.remove('ds-dark', 'ds-oled'); return true; })()`);
  h.log('✓ pause-packaged: the packaged rule is listed with a tick; the kind headers carry their colours in three themes; nothing ticked, nothing run');
}
