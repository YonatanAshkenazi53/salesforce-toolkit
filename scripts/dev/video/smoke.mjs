// A 15-second self-test of the recorder: Data Studio without an org, two
// captions, a chapter, a click, a "waiting" stretch. Then compose it:
//   REC_DIR=dist/video/smoke node scripts/dev/headless-studio.mjs scripts/dev/video/smoke.mjs
//   REC_DIR=dist/video/smoke OUT=dist/video/smoke.mp4 node scripts/dev/headless-studio.mjs scripts/dev/video/compose.mjs
import { resolve } from 'node:path';
import { makeRecorder } from './recorder.mjs';
export default async function (h) {
  const rec = makeRecorder(h, resolve(process.env.REC_DIR || 'dist/video/smoke'));
  await h.studio('');
  await rec.start();
  rec.chapter('Self-test');
  await rec.say('This is the recorder testing itself: Data Studio, with no org open.', 3000);
  await rec.click('.ds-nav-btn[data-view="history"]');
  await rec.say('A click is shown with a ring, because a headless browser has no mouse pointer.', 3000);
  await rec.fast(async () => { await h.sleep(6000); });
  await rec.click('.ds-nav-btn[data-view="orgs"]');
  await rec.say('The six seconds before this were marked as waiting and play eight times faster.', 3000);
  await rec.stop();
}
