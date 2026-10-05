# The walkthrough video

A scripted tour of every tool in the public build, recorded live against the two
trial orgs, with the captions burned into the picture. Nothing is downloaded or
installed: the recording is Chrome's own screencast and the encoder is Chrome's
own (canvas → MediaRecorder, H.264 + AAC in MP4), and the voice is Windows' own.

## Make it

```bash
npm run pack
```

```bash
SFTK_EXT=dist/store-staging SFTK_WINDOW=1600,800 REC_DIR=dist/video/rec node scripts/dev/headless-studio.mjs scripts/dev/video/walkthrough.mjs
```

```bash
REC_DIR=dist/video/rec OUT=dist/video/walkthrough.mp4 node scripts/dev/headless-studio.mjs scripts/dev/video/compose.mjs
```

The first command builds the public build, the second records it (about as long
as the tour takes, waits included), the third composes the video in real time.
Run them one after the other, never two at once: the harness closes any other
headless Chrome it started.

Out come two files in `dist/video/` (not in git):

| file | what |
|---|---|
| `walkthrough.mp4` | 1920×1080, captions burned in, chapter name on the left of the caption band |
| `walkthrough.chapters.txt` | `0:00 Title` lines to paste into the YouTube description |

## Look at it without playing it

```bash
VIDEO=dist/video/walkthrough.mp4 AT=5,60,120 node scripts/dev/headless-studio.mjs scripts/dev/video/peek.mjs
```

Saves a PNG of the picture at each of those seconds to the harness's screenshot folder.

## The files

| file | job |
|---|---|
| `recorder.mjs` | `makeRecorder(h, dir)`: one recording per `begin(dir)` … `end()` — screencast frames, captions (`say`), chapters, waiting stretches (`fast`), a ring around what is clicked (`click`, `point`), typing (`type`), and the mask |
| `sections.mjs` | the tour itself: one entry per tool, with its captions |
| `walkthrough.mjs` | logs in, runs the sections, lists what was recorded and what failed |
| `compose.mjs` | the sections in `order.json` order (or one recording) → MP4 and chapters |
| `voice.mjs` | the captions spoken into WAV files (Windows System.Speech, offline) |
| `fixture.mjs` | puts the Field Cleaner fixture back after its chapter (CLI deploys, no flow runs) |
| `peek.mjs` | frames of a finished video |
| `smoke.mjs` | a 15-second self-test of recorder and composer, no org needed |

## Rules the tour keeps

- **It reads, except where a tool is shown for real.** Four chapters use a tool
  end to end, on fixtures only, and leave the org as they found it: Flow switches
  (three fixture flows off, then ↩ Undo), API versions (one fixture flow to the
  org's version, then ↩ Undo), Field Cleaner (the fixture field replaced on its
  layout, Lightning page and flows; one change undone on camera; the fixture is
  redeployed off camera by `fixture.mjs`), and Deploy and roll back (two fixture
  accounts into the target, then rolled back). `WRITES=0` leaves all four out.
  A confirmation that is opened only to show it is cancelled.
- **A deployment only ever runs trailheads5 → trailheads4.** The demo deployments
  carry both org addresses themselves, and the chapter checks the Deploy page's
  own source and target again before it ticks anything and before it presses
  Deploy. (The fixture file names an org that no longer exists; the harness then
  stands the logged-in orgs in by login order — never rely on that.)
- **The Toolkit must be on the source org.** Every Toolkit chapter stops if the
  tool opened on another org.
- **A section stands alone.** Each is recorded into its own folder
  (`dist/video/rec/<id>/`). One that fails is logged, keeps the recording it had,
  and the tour goes on; the end of the log says `RECORDED:` and `FAILED:`.
  `ONLY=pages,deploy` records just those again, and the compose step joins them
  with the sections already there — so after a change to one tool, record that
  one section and compose.
- **No personal data in a frame.** The recorder rewrites every e-mail address and
  the running user's own name in the page before it is drawn. It changes the
  display of the throwaway headless profile only.
- **Waiting is shown as waiting.** A scan or a login is played eight times faster
  with a "sped up" badge, never cut out silently.
- **A caption states what the tool does and nothing more.** When a tool changes,
  change its caption in `sections.mjs` with it.

## The voice

Every caption is also spoken, and the speech is recorded into the same MP4 as its
audio track. The voice is one that is already on this PC — Windows' own
"Microsoft David" (male) by default — so nothing is installed and the text goes
nowhere. A caption stays, and the picture holds, until its sentence has been
spoken; that is why the narrated video runs a little longer than a silent one.

| setting | meaning |
|---|---|
| `VOICE=0` | compose a silent video |
| `VOICE_NAME="Microsoft Zira Desktop"` | another installed voice |
| `RATE=2` | faster speech (-10 … 10, default 1) |

The sentences are kept as WAV files in `dist/video/rec/voice/`, named by a hash of
text + voice + rate, so only a caption that changed is spoken again. To hear a
different voice (for example a recording of your own), replace those files: the
composer takes each sentence's length from its file.

## Captions: in the picture, or as a subtitle file — never both

The captions are burned into the picture, so the default run writes **no** `.srt`.
A subtitle file next to a video with the same name is loaded by most players on
their own and drawn over the burned-in text; YouTube's CC would do the same.

To publish with YouTube's own subtitles instead (viewers can switch them off, and
YouTube can translate them), compose the other variant:

```bash
CAPTIONS=track REC_DIR=dist/video/rec OUT=dist/video/walkthrough.mp4 node scripts/dev/headless-studio.mjs scripts/dev/video/compose.mjs
```

It writes `walkthrough-nocaptions.mp4` (no caption text in the picture) and
`walkthrough-nocaptions.srt`. Upload that pair, not the burned-in video.

## Uploading

The upload is done by hand: YouTube Studio → Create → Upload video, then paste the
chapters into the description. With the burned-in video, add no subtitle file.
