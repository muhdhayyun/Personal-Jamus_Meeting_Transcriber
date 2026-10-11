# Changelog

All notable changes to Jamus are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/), and the project
adheres to [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`).

## [Unreleased]

### Added
- **SRT subtitle output**: every transcription now also writes a `.srt` file alongside the
  `.md` transcript (`transcripts/<session-id>.srt`) — accurately timed, one cue per speech
  segment, so you can caption an imported video (`jamus transcribe-file video.mp4`) or any
  recorded/live meeting.
- **Choose what Jamus hears, on the New recording screen**: capture everything, **only one app**
  (e.g. just your meeting app), or **block one app** (e.g. Spotify). Pick the app from a live list
  of apps that are making sound, with level meters, instead of typing `Spotify.exe`. The
  recording screen shows what is actually happening, and warns if the chosen app isn't running
  (in "only" mode recording refuses to start rather than capturing everything). Uses Windows'
  per-process loopback API (Windows 10 2004+ / Windows 11 only). One app at a time, and it can't
  isolate a single browser tab, which is an OS-level limitation, not an app one.
- **Long single-speaker turns now break into readable paragraphs**: transcripts start a new
  timestamped turn after N sentences (default 6, tunable in Settings → Transcription) instead of
  merging an uninterrupted monologue into one unreadable block.
- `CLAUDE.md` — guidance for Claude Code sessions working in this repo (commands, architecture,
  key gotchas: the CLI/live pipeline split, the CJS Electron main process, `ELECTRON_RUN_AS_NODE`,
  driving whisper.cpp directly instead of through the `nodejs-whisper` wrapper, etc.).

### Fixed
- The saved "exclude an app" setting never showed in the UI after a restart, and saving any other
  setting wiped it (`settings:get` didn't return `systemAudio`).

## [0.6.0] - 2026-07-21

Live transcription while recording, a rolling AI summary, and a standalone packaged executable.

### Added
- **Live Transcript tab**: while recording, audio is captured in rolling ~12s segments
  (instead of one file at the end) and each segment is transcribed on the GPU as soon as
  it's ready, so the transcript fills in during the meeting instead of only after you stop.
- **Live Summary tab**: a rolling "what's happened so far" summary (Ollama by default —
  local, free, unlimited; Groq optional) refreshed periodically during the recording, so
  you can catch up on a meeting without waiting for it to end.
- **Local LLM support (Ollama)**: new Settings → Live Mode section to pick the summary
  provider (Ollama/Groq/off), model, refresh interval, and segment length.
- **Standalone packaged executable** (`npm run package` → `release/win-unpacked/Jamus.exe`,
  via electron-builder) — bundles FFmpeg, the WASAPI recorder, whisper.cpp + models, and
  CUDA DLLs, so it runs without VS Code, Node, or any manual setup. A desktop shortcut is
  created automatically.
- **CLI `--live`** on `jamus run` — prints the transcript and rolling summary to the
  terminal as the meeting happens, for parity with the desktop app.
- Segmented capture support in the native WASAPI recorder (`--segments <dir> <seconds>`)
  and in FFmpeg mic capture, each with an exact per-segment timing manifest, so live and
  batch recording share the same underlying capture code.

### Notes
- Once a live recording stops, its segments are stitched into normal `mic.wav`/`system.wav`
  files and the accumulated transcript is saved — the resulting meeting is indistinguishable
  from a non-live recording afterward (same rename/delete-audio/insights features apply).
- Live mode requires Windows (WASAPI); the underlying batch recording path is unchanged
  and still used by `jamus record`/`transcribe` for CLI workflows.
- The packaged build is a few GB (bundles the Whisper model, CUDA runtime, and FFmpeg) —
  expected, since the goal is zero additional installs.

## [0.5.0] - 2026-06-01

### Added
- **Import existing audio** (phone memos, mp3/m4a/wav/…): converts any format and
  transcribes it as a single-speaker transcript that appears in the meeting list.
  - Desktop: "⤓ Import audio file" button (file picker, multi-select supported).
  - CLI: `jamus transcribe-file <path> [--title --model --me --insights]`.
- **Drop-In Recordings/** folder — drop files here; the app's import picker opens it
  by default. Contents are gitignored.

### Added
- **Delete audio** per meeting (🗑 next to the title) and **Delete all recording audio**
  (Settings → Storage) to free space. Transcripts, insights, and the meeting list are kept —
  only the `.wav` files are removed (you just can't re-transcribe afterward).

### Changed
- The storage cap now clears only the **audio** of the oldest recordings (keeping
  `session.json` + transcripts) instead of deleting whole meeting folders, so capped-out
  meetings still appear in the app.

### Added
- **Dark mode** toggle (🌙/☀️) in the sidebar; preference persists across launches.
- **Rename meeting** (✎ next to the title) — updates the title and the transcript/insights
  headings; file ids stay stable.

## [0.2.0] - 2026-06-01

Adds a desktop app, cloud insights, and storage management on top of the core engine.

### Added
- **Desktop UI (Electron, Jamie-style)**: sidebar meeting list, one-click record
  with live timer, transcript + insights tabs, and a settings panel. Run with `npm run app`.
- **AI insights via Groq** (cloud): generates Summary / Action Items / Key Decisions /
  Topics & Open Questions into `transcripts/<id>.insights.md`. Off by default; enable with
  an API key in Settings (stored locally). CLI: `jamus insights <session>` or `--insights`.
- **Recording storage cap** (default 20 GB) — oldest recordings auto-deleted past the cap.
- `scripts/start-app.mjs` launcher that clears `ELECTRON_RUN_AS_NODE` (set by some
  terminals/VS Code) so the GUI launches reliably.

### Notes
- Insights use a cloud API, so transcript text is sent to Groq's servers (not local).

## [0.1.0] - 2026-06-01

Initial working version — a fully local, CLI meeting transcriber.

### Added
- **Dual-source recording**: microphone (FFmpeg) + system audio, captured as
  separate 16 kHz mono WAV streams.
- **Zero-install system audio on Windows** via a custom WASAPI loopback recorder
  (`native/WasapiLoopbackRecorder.cs`, compiled with the built-in `csc.exe`) — no
  Stereo Mix or virtual cable required.
- **Local transcription** with `whisper.cpp` driven directly (`whisper-cli.exe`),
  supporting the full model list incl. `large-v3` / `large-v3-turbo`.
- **Speaker separation**: mic → "Me", system audio → "Participants", merged into one
  timestamped, chronological Markdown transcript.
- **CUDA/GPU build** (`npm run build:whisper:cuda`) — ~30× real-time on an
  RTX 4070 SUPER; cuBLAS DLLs auto-bundled next to the binary.
- **VAD (Silero)** on by default to stop Whisper hallucinating filler ("thank you")
  on silent/quiet audio.
- CLI commands: `devices`, `record`, `transcribe`, `run`, `models`.
- FFmpeg auto-discovery (PATH → env override → common install locations).
- Unique, timestamped transcript filenames (`<session-id>.md`) to prevent overwrites.

### Changed
- Default model set to `large-v3-turbo` (v3-family accuracy, much faster on CPU).

### Removed
- JSON sidecar output — transcripts are Markdown (`.md`) only.
