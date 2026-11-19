// No org is changed: the per-item progress of a ⚡ run, drawn on the real page with the real widget and CSS, light
// and dark (owner 2026-11-20: "i want to see it fills up for every component that is currently removed in real time.
// one after one with the real time progress"). The calls are told to the tracker by hand (sftkBgNote), the way
// field-cleaner's own sender tells them: two items finished, one refused, one in work at "changing".
export default async function (h) {
  await h.login('npc2'); await h.popup('fields'); await h.sleep(1500);
  await h.eval(`(() => {
    const res = document.getElementById('fcResults'); res.style.display = '';
    res.innerHTML = '<div id="fcPlanProg" class="fc-plan-run"><div class="fc-plan-run-prog"></div><ol class="sftk-it-list fc-plan-run-list"></ol><button class="btn btn-secondary btn-sm fc-plan-stop">⏹ Stop after this one</button></div>';
    const host = document.getElementById('fcPlanProg');
    const prog = sftkProgress(host.querySelector('.fc-plan-run-prog'), { what: 'Running 37 changes for Lookup Child · Pkg Tag…', total: 37, unit: 'changes' });
    const t = sftkItemTrack(host.querySelector('.sftk-it-list'));
    const call = type => sftkBgNote({ type });
    t.start('🗑 SFTK_Pkg_WF_Rule'); call('SF_MD_READ'); call('SF_METADATA_DEPLOY'); call('SF_MD_READ'); t.end(true, 'Deleted — verified in the org');
    t.start('✂ SFTK Pkg Flow'); call('SF_TOOLING_GET'); call('SF_METADATA_DEPLOY'); call('SF_QUERY'); t.end(true, 'Removed — verified in the org');
    t.start('✂ SFTK_Pkg_Class'); call('SF_TOOLING_GET'); call('SF_METADATA_DEPLOY'); t.end(false, 'Salesforce refused: Dependent class is invalid and needs recompilation');
    t.start('✂ SFTK_Pkg_Red_Needs_Tag'); call('SF_MD_READ'); call('SF_METADATA_DEPLOY');
    prog.count(3, 37); prog.say('✂ SFTK_Pkg_Red_Needs_Tag');
    window.__t = t; window.__call = call; host.scrollIntoView({ block: 'start' }); return true;
  })()`);
  await h.sleep(2600);
  h.log('row in work:', await h.eval(`document.querySelector('.sftk-it-now .sftk-it-line').textContent + ' | segs ' + [...document.querySelectorAll('.sftk-it-now .sftk-it-seg')].map(s => s.className.replace('sftk-it-seg', '').trim() || '-').join(',')`));
  await h.shot(h.shots + '/item-track-light.png');
  await h.eval(`(() => { document.body.classList.add('sftk-dark'); window.__call('SF_MD_READ'); return true; })()`); await h.sleep(900);
  h.log('after a read:', await h.eval(`document.querySelector('.sftk-it-now .sftk-it-line').textContent`));
  await h.shot(h.shots + '/item-track-dark.png');
}
