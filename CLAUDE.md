# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Jamus is a local, privacy-first meeting transcriber (inspired by Jamie). It records the
microphone and system audio as **two separate streams**, transcribes each locally with
whisper.cpp, and merges them into a speaker-separated Markdown transcript — no cloud STT,
no API keys required for the core feature. Optional cloud features (Groq for post-meeting
insights) are opt-in and clearly separated from the local path.

Three ways to run it, all sharing the same `src/` engine:
- **CLI** (`bin/jamus.js` → `src/cli.js`)
- **Electron desktop app** (`electron/`)
- **Packaged standalone executable** (`electron-builder`, produces `release/win-unpacked/Jamus.exe`)

There is no test suite in this repo.

## Commands

```bash
npm install              # JS deps (also vendors the whisper.cpp source via nodejs-whisper)
npm run build             # one-time: compiles whisper.cpp (CMake/MSVC) + the WASAPI recorder (csc.exe)
npm run build:whisper      # whisper.cpp only (CPU)
npm run build:whisper:cuda # whisper.cpp with CUDA/cuBLAS (needs the NVIDIA CUDA Toolkit installed)
npm run build:wasapi       # native Windows WASAPI loopback recorder only

npm run app               # launch the Electron desktop app (via scripts/start-app.mjs)
npm start                 # CLI entrypoint (node bin/jamus.js)
node bin/jamus.js devices              # list audio devices / check system-audio capture readiness
node bin/jamus.js run [--live]         # record + transcribe; --live streams transcript/summary to the terminal
node bin/jamus.js transcribe <session> # transcribe an already-recorded session
node bin/jamus.js transcribe-file <path> # import/transcribe an existing audio file (phone memo, mp3, etc.)
node bin/jamus.js insights <session>   # generate Groq insights for a session
node bin/jamus.js models               # list Whisper models / download status

npm run package            # electron-builder --dir → release/win-unpacked/Jamus.exe (unpacked, no installer)
npm run package:installer   # electron-builder --win nsis → a real Windows installer
```

Prerequisites that aren't npm-installable: **FFmpeg** on PATH (or `vendor/ffmpeg/` — see
below), and on Windows a **C++ toolchain** (VS Build Tools) to compile whisper.cpp. Live-mode
summaries additionally want a local **Ollama** server (`ollama pull llama3.1:8b`) or a Groq API key.

## Architecture

### The core trick: speaker separation without diarization
Jamus never runs a diarization model. Instead it captures **two physically separate audio
sources** — the microphone and the system's audio output — as independent files, transcribes
each independently, tags every segment with its source ("Me" vs "Participants"), then merges
by timestamp (`src/pipeline/merge.js`). This is exact by construction, not probabilistic.

`coalesceTurns` in `merge.js` (used by both the batch path and live mode's incremental
`_recomputeAndEmit`) merges consecutive same-speaker Whisper segments into one turn, but caps
each turn at `config.maxSentencesPerTurn` (default 6, user-settable) sentences — otherwise one
person talking for minutes with no reply renders as a single unreadable wall of text under one
timestamp. The cap only decides when to *start a new turn*; it never splits mid-segment, so
sentences stay intact.

### Platform split: Windows is the only fully-supported OS
- **Mic capture** (`src/recorder/platform.js`, `ffmpegProcess.js`): cross-platform via FFmpeg
  (`dshow` / `avfoundation` / `pulse`).
- **System-audio capture** is Windows-only in practice: a from-scratch **WASAPI loopback
  recorder** written in C# (`native/WasapiLoopbackRecorder.cs`), compiled with the `csc.exe`
  that ships with Windows (no .NET SDK/NuGet needed — see `scripts/build-wasapi.mjs`). It
  supports two modes: a single continuous WAV (`wasapi-loopback.exe out.wav`, used by normal
  recordings) and **segmented** rolling WAVs (`wasapi-loopback.exe --segments <dir> <secs>`,
  used by live mode), each mode writing a manifest of exact per-segment timing.
  macOS/Linux would need a loopback device (BlackHole / PulseAudio monitor) and are not wired
  into the app UI — `src/devices/loopback.js` has the groundwork but live mode and the
  Electron app assume Windows/WASAPI.

### Whisper is driven directly, not through the `nodejs-whisper` wrapper
`nodejs-whisper` (an npm dependency) is used **only** to vendor the whisper.cpp source tree
and its model-download scripts (see `whisperRoot()` in `src/transcriber/modelManager.js`,
which resolves `node_modules/nodejs-whisper/cpp/whisper.cpp`). The wrapper's own JS API is
never called — it restricts model names in ways that block `large-v3`. Instead
`src/transcriber/whisper.js` spawns the compiled `whisper-cli` binary directly, so any
ggml model whisper.cpp supports is available. `npm run build:whisper[:cuda]` compiles that
vendored tree with CMake; the compiled binary and downloaded `.bin` models live under
`node_modules/nodejs-whisper/cpp/whisper.cpp/{build,models}/` (gitignored, machine-specific).

### Two recording pipelines, deliberately kept separate
- **Batch** (`src/recorder/recorder.js` + `src/pipeline/transcribeSession.js`): record to one
  `mic.wav`/`system.wav`, then transcribe both files once, at the end. This is what the CLI's
  `record`/`run`/`transcribe` commands use, and it's the stable, low-risk path.
- **Live** (`src/pipeline/liveSession.js`): captures rolling short segments (both mic and
  system, via the segmented modes above) and transcribes each one on the GPU as it completes,
  emitting incremental timeline/summary updates via callbacks — used by the Electron app's
  live tabs and `jamus run --live`. A serialized queue (`_drainQueue`) ensures only one
  whisper-cli process runs at a time. On stop, finalized segments are concatenated
  (`concatWavFiles` in `src/utils/audio.js`) back into normal `mic.wav`/`system.wav` and the
  accumulated transcript is written — so a finished live session is indistinguishable from a
  batch one afterward (same rename/delete-audio/insights features apply via
  `src/pipeline/meetings.js`).

These two pipelines intentionally don't share a code path: if live mode has a bug, CLI/batch
recording is unaffected. Session metadata (`session.json`) and output paths
(`src/pipeline/session.js`) are shared by both.

### Electron process model
- `electron/main.cjs` is **CommonJS**, not ESM — the rest of the app (`src/**`) is ESM. Main
  loads the core engine via dynamic `import()` at startup (`loadCore()`), because Electron's
  ESM-as-main entrypoint has a CJS-interop bug that crashes on some dependency shapes (dayjs).
  Don't convert `main.cjs` to `.mjs`/ESM without re-testing that.
- `electron/preload.cjs` exposes a narrow `window.jamus` API via `contextBridge`
  (`contextIsolation: true`, `nodeIntegration: false`).
- `electron/renderer/renderer.js` is plain browser JS (no framework/bundler) driving
  `index.html` by string-templating into a single `#view` container.
- **Gotcha:** some terminals (notably VS Code's) set `ELECTRON_RUN_AS_NODE=1`, which makes
  `electron.exe` behave as plain Node and silently fail to open a window. `npm run app` goes
  through `scripts/start-app.mjs`, which explicitly strips that env var before spawning
  Electron — always launch via that script, not `electron electron/main.cjs` directly.

### Config cascade
`src/config.js` deep-merges `config/default.json` with `~/.jamus/config.json` (user overrides,
written by Settings/`saveUserConfig`). Resolved absolute paths (models/recordings/transcripts/
dropin dirs) are computed once into `cfg.resolved`. Per-tool env var overrides also exist
(`JAMUS_FFMPEG`, `JAMUS_FFPROBE` in `src/utils/ffmpeg.js`).

### Packaging (electron-builder)
`asar: false` is deliberate — it avoids having to rewrite file-system paths for native binaries
(`whisper-cli.exe`, `wasapi-loopback.exe`, bundled FFmpeg) that can't run from inside an asar
archive. `vendor/ffmpeg/` (gitignored, populate it yourself with `ffmpeg.exe`/`ffprobe.exe`) is
bundled so the packaged app needs no FFmpeg install; `src/utils/ffmpeg.js`'s discovery order is
PATH → env override → `vendor/ffmpeg` → a few common install locations. The packaged app is
several GB because it embeds the CUDA runtime, whisper.cpp, and the Whisper model — that's
expected, not a packaging bug.

### Two independent LLM integrations — don't conflate them
- **Groq** (`src/insights/groq.js`): post-meeting insights (Summary/Action Items/Key
  Decisions/Topics) written to `<session-id>.insights.md`. Cloud, opt-in, needs an API key.
- **Ollama or Groq** (`src/insights/liveSummary.js`): the *live*, rolling "what's happened so
  far" summary during an in-progress recording. Defaults to a local Ollama server
  (`http://127.0.0.1:11434`, no key, no cloud) with Groq as an alternate provider. Different
  prompt, different call site (`LiveSession._maybeSummarize`), different config block
  (`cfg.live`) — these are two separate features that happen to both be "AI insights."

### Output formats: Markdown (readable) vs SRT (accurately timed)
Every transcription (`transcribeSession.js` batch path and `LiveSession.stop()`) writes two
files from the *same* underlying Whisper segments, built two different ways:
- `.md` (`src/output/markdown.js`) uses the **coalesced** timeline (`mergeTranscripts(...,
  coalesce: true)`) — multi-sentence turns, good for reading a conversation.
- `.srt` (`src/output/srt.js`) uses the **uncoalesced** timeline (`coalesce: false`) — one cue
  per raw Whisper segment, because subtitle timing needs to track the audio closely; reusing
  the coalesced multi-sentence turns would produce very long, slow-changing captions. Speaker
  prefixes (`"Me: ..."`) are only added when both mic and system streams have content — a
  single-speaker import (e.g. transcribing an mp4) gets plain, unprefixed captions.

### System-audio source: everything / only one app / block one app
`config.systemAudio` is `{ mode: 'all' | 'only' | 'block', process: "Spotify.exe" | null }`.
`systemAudioRule(cfg)` in `wasapiCapture.js` normalizes it (and maps the legacy
`{excludeProcess, enabled}` shape to `block`/`all`); `systemAudioTarget(cfg)` returns `null` for
"capture everything", used by both `recorder.js` and `liveSession.js`. `'only'` records just that
app and ignores everything else; `'block'` records everything except that app.

It's chosen on the **New recording** screen (not in Settings): a mode switch plus a live list of
apps that currently have an audio session, with level meters, so you click an app instead of
typing `Spotify.exe`. The list comes from `wasapi-loopback.exe --list-audio-apps` (Windows audio
session API: `IAudioSessionManager2` on the default render endpoint, grouped by process name,
peak sampled for ~160 ms), exposed as `listAudioApps()` / the `audio:apps` IPC and polled about
once a second while the picker is open. The rule is saved the moment it changes. `settings:get`
**must** return `systemAudio` — it once didn't, so the UI never saw the saved app and any Settings
save wiped it.

Threaded through `WasapiCapture` as `--exclude-process <name>` / `--include-process <name>` flags
(`<name>` may be `pid:1234`). `native/WasapiLoopbackRecorder.cs` uses Windows' **process loopback
API** (`ActivateAudioInterfaceAsync` on the virtual device path `"VAD\Process_Loopback"` with
`AUDIOCLIENT_ACTIVATION_PARAMS`, `PROCESS_LOOPBACK_MODE_INCLUDE_/EXCLUDE_TARGET_PROCESS_TREE`,
Windows 10 2004+/Windows 11 only) instead of the normal `IMMDevice`-endpoint loopback. A name
resolves to the longest-running matching PID (the likely tree root). Only one app per recording
(an OS API constraint), and a browser is one app — individual tabs can't be separated.

On start the recorder writes `[wasapi] STATUS {mode,target,attached,pid}` to stderr;
`WasapiCapture` parses it and `LiveSession` forwards it (`onAudioSource` → `live:audio-source`)
so the recording screen shows what is actually happening. If the app isn't running: `only` mode
refuses to start (capturing everything would silently record apps you left out); `block` mode
captures everything and the UI says plainly that nothing is being blocked.

Two non-obvious interop requirements this code path depends on — both cost real debugging time,
don't remove either:
- The `IActivateAudioInterfaceCompletionHandler` implementation (`LoopbackActivationHandler`)
  must **also** implement the empty marker interface `IAgileObject` (GUID
  `94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90`). Without it, `ActivateAudioInterfaceAsync` rejects the
  call synchronously with `E_ILLEGAL_METHOD_CALL` (0x8000000E) — no callback ever fires.
- The process-loopback virtual client does **not** implement `GetMixFormat` (returns
  `E_NOTIMPL`) — there's no single "real" endpoint format to report. `BuildProcessLoopbackAudioSetup`
  supplies a fixed IEEE-float/48kHz/stereo `WAVEFORMATEX` instead of querying one; the normal
  endpoint-loopback path (`BuildAudioSetup`) is unaffected and still queries the real device format.

### Storage model
`recordings/<session-id>/` holds `session.json` + audio; `transcripts/<session-id>.md`
(+ `.insights.md`) holds output. The storage cap (`src/utils/storage.js`,
`enforceStorageCap`) deletes only `.wav` files from the oldest sessions once over the
configured GB limit — it never deletes `session.json` or transcripts, so capped meetings
stay visible in the app (just without re-transcribable audio).
