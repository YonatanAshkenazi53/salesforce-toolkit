# The walkthrough video

A scripted tour of every tool in the public build, recorded live against the two
trial orgs, with the captions burned into the picture, inside a browser frame
drawn like Chrome's (tab strip and address bar with the page's real title and
address). The recording is Chrome's own screencast and the encoder is Chrome's
own (canvas → MediaRecorder, H.264 + AAC in MP4); the voice is Microsoft's neural
"Andrew" through the edge-tts package (installed 2026-10-09 with the user's
permission; the caption text goes to Microsoft's speech endpoint).

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
| `walkthrough.mp4` | 1920×1080: browser frame (88 px), the page (1920×872), the caption band with the chapter on the left |
| (optional) phone copies | `SCALE=0.6667 BITRATE=1200000 AUDIO_BITRATE=64000 ONLY=<chapters> OUT=…` — 720p, lighter sound; the whole tour at 720p is still ~39 MB (the sound is a third of it), so two parts (Toolkit chapters / Data Studio chapters, 22 MB + 17 MB) fit a 30 MB upload limit. Composing takes as long as the part runs |
| `walkthrough.chapters.txt` | `0:00 Title` lines to paste into the YouTube description |

## Look at it without playing it

```bash
VIDEO=dist/video/walkthrough.mp4 AT=5,60,120 node scripts/dev/headless-studio.mjs scripts/dev/video/peek.mjs
```

Saves a PNG of the picture at each of those seconds to the harness's screenshot folder.
`SNAP=95` on the compose step writes one PNG of the composed picture at that second
(`<out>-snap.png`) — the quickest look at the layout. `ONLY=debugger,builder` on the
compose step joins just those sections (a check of a chapter after re-recording it).

## The files

| file | job |
|---|---|
| `recorder.mjs` | `makeRecorder(h, dir)`: one recording per `begin(dir)` … `end()` — screencast frames, captions (`say`: spoken at once, and the picture holds for the sentence), chapters, waiting stretches (`fast`), a ring around what is clicked (`click`/`point`), typing (`type`), a dialog or page scrolled to its end (`reveal`), one picture of another tab (`frameFrom`), the page's title and address per stretch (for the frame), and the privacy mask (`mask`/`remask`) |
| `sections.mjs` | the tour itself: one entry per tool, with its captions |
| `walkthrough.mjs` | logs in, runs the sections, lists what was recorded and what failed |
| `compose.mjs` | the sections in `order.json` order (or one recording) → MP4 and chapters |
| `voice.mjs` | the captions spoken into MP3 files (edge-tts, Andrew) — `speakOne` while recording, `speakAll` at compose; `VOICE_ENGINE=sapi` for Windows' own offline voice |
| `fixture.mjs` | rebuilds the Field Cleaner fixture after its chapter deleted the field (`rebuildFieldCleanerFixture`), removes the identity field (`removeIdentityField`) |
| `peek.mjs` | frames of a finished video |
| `smoke.mjs` | a 15-second self-test of recorder and composer, no org needed |

## Rules the tour keeps

- **It reads, except where a tool is shown for real.** Six chapters use a tool
  end to end, on fixtures only, and leave the org as they found it: Flow switches
  (three fixture flows off, then ↩ Undo), API versions (one fixture flow to the
  org's version, then ↩ Undo), Debugger (a trace on the running user, one save of
  a fixture Account that sets the recursion fixture off, the trace stopped on
  camera), Field Cleaner ("Replace all" over the whole fixture, then the field
  itself deleted; the fixture is rebuilt off camera by `fixture.mjs`), the
  identity field (created in both orgs, removed again off camera), and Deploy and
  roll back (the whole fixture tree into the target, then rolled back).
  `WRITES=0` leaves them all out. A confirmation that is opened only to show it
  is cancelled.
- **Every dialog is shown whole.** The shared confirmation is scrolled to its end
  before it is confirmed (`confirmShared` in `sections.mjs`); long pages and the
  Debugger's analysis are scrolled through (`rec.reveal`).
- **The screen, the voice and the caption stay together.** `rec.say` speaks the
  sentence at recording time and holds the picture until it has been said, so an
  action never runs ahead of its sentence; the composer then has nothing to shift.
- **The write is shown in real time.** The deployment and the rollback of the
  Deploy chapter are not sped up: the viewer sees each object and batch land, with
  captions over the wait.
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
audio track. The voice is Microsoft's neural "en-US-AndrewNeural" through the
`edge_tts` Python package (user 2026-10-09: "less robotic", "like NotebookLM";
"lets go with andrew"). Python is called by its full path
(`C:/Users/yonas/AppData/Local/Python/pythoncore-3.14-64/python.exe` — the bare
`python` on this PC is the Store alias); `PY=` overrides it. A caption stays, and
the picture holds, until its sentence has been spoken.

| setting | meaning |
|---|---|
| `VOICE=0` | compose a silent video |
| `VOICE_NAME=en-US-BrianNeural` | another neural voice (`python -m edge_tts --list-voices`) |
| `RATE=+10%` | faster speech (edge-tts takes a signed percentage) |
| `VOICE_ENGINE=sapi` | Windows' own offline voice instead (`VOICE_NAME="Microsoft David Desktop"`, `RATE=1`) |
| `VOICE_ENGINE=piper` | a neural voice that runs on this PC: piper-tts with the Ryan model in `C:/Users/yonas/AppData/Local/piper-voices/` (installed 2026-10-10 with the user's permission when Microsoft's endpoint began refusing every request with 403). `PIPER_MODEL=` another model, `PIPER_LENGTH=1.1` slower |

The sentences are kept in `dist/video/rec/voice/` (MP3 + the subtitle file that
gives its length), named by a hash of engine + text + voice + rate, so only a
caption that changed is spoken again. To hear a different voice (for example a
recording of your own), replace those files: the composer takes each sentence's
length from its file.

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
