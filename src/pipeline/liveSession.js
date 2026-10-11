import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSession, saveSession } from './session.js';
import { mergeTranscripts } from './merge.js';
import { writeMarkdown } from '../output/markdown.js';
import { writeSrt } from '../output/srt.js';
import { writeInsightsForSession } from '../insights/groq.js';
import { generateLiveSummary } from '../insights/liveSummary.js';
import { transcribeFile } from '../transcriber/whisper.js';
import { assertFfmpegAvailable } from '../utils/ffmpeg.js';
import { FfmpegCapture } from '../recorder/ffmpegProcess.js';
import { WasapiCapture, assertWasapiBuilt, systemAudioTarget } from '../recorder/wasapiCapture.js';
import { buildSegmentedCaptureArgs } from '../recorder/platform.js';
import { ManifestTailer, segmentFilePath } from '../live/segments.js';
import { ensureDir } from '../utils/fsx.js';
import { convertAudioTo16kMono, ensure16kMono, concatWavFiles, probeDuration } from '../utils/audio.js';
import { enforceStorageCap } from '../utils/storage.js';
import { logger } from '../utils/logger.js';

const isWin = os.platform() === 'win32';
const POLL_MS = 1200;

/**
 * Orchestrates a "live" recording: mic + system audio are captured as rolling
 * short segments (instead of one continuous file); each finalized segment is
 * transcribed on the GPU as soon as it lands, giving a near-real-time transcript
 * and periodic rolling summary while the meeting is still happening.
 *
 * On stop, the finalized segments are stitched into normal mic.wav/system.wav
 * files and the accumulated transcript is written out — so the resulting
 * session is indistinguishable from a normal (batch) recording afterward.
 */
export class LiveSession {
  constructor(cfg, { title, mic }, callbacks = {}) {
    this.cfg = cfg;
    this.callbacks = callbacks;
    this.title = title;
    this.mic = mic;

    this.micLive = [];   // [{start,end,text}] seconds, relative to mic-stream start
    this.sysLive = [];   // [{start,end,text}] seconds, relative to system-stream start
    this.micTotalMs = 0;
    this.sysTotalMs = 0;
    this.queue = [];
    this.processing = false;
    this.lastTimeline = [];
    this.lastSummaryKey = '';
    this.stopped = false;
  }

  async start() {
    assertFfmpegAvailable();
    if (!isWin) throw new Error('Live mode currently requires Windows (WASAPI system-audio capture).');
    assertWasapiBuilt();

    const cfg = this.cfg;
    const session = createSession(cfg, { title: this.title, mic: this.mic, system: 'wasapi', mode: 'live' });
    this.session = session;

    const segSeconds = cfg.live?.segmentSeconds || 12;
    this.segSeconds = segSeconds;
    this.micSegDir = ensureDir(path.join(session.dir, 'mic_segments'));
    this.sysSegDir = ensureDir(path.join(session.dir, 'sys_segments'));

    const micArgs = buildSegmentedCaptureArgs({
      deviceId: this.mic,
      outDir: this.micSegDir,
      segSeconds,
      sampleRate: cfg.audio.sampleRate,
      channels: cfg.audio.channels,
      codec: cfg.audio.codec,
      prefix: 'mic',
    });
    this.micCapture = new FfmpegCapture({ label: 'mic', args: micArgs });
    this.sysCapture = new WasapiCapture({
      label: 'system',
      segments: { outDir: this.sysSegDir, segSeconds },
      target: systemAudioTarget(cfg),
      onStatus: (info) => this.callbacks.onAudioSource?.(info),
    });

    const micStart = this.micCapture.start();
    const sysStart = this.sysCapture.start();
    session.offsets.systemMinusMicMs = sysStart - micStart;
    saveSession(session);

    await new Promise((r) => setTimeout(r, 500));
    this._assertAlive(this.micCapture, 'microphone');
    this._assertAlive(this.sysCapture, 'system audio (WASAPI loopback)');

    this.micTailer = new ManifestTailer(path.join(this.micSegDir, 'mic_segments.csv'), 'ffmpeg');
    this.sysTailer = new ManifestTailer(path.join(this.sysSegDir, 'segments.jsonl'), 'wasapi');

    this._pollTimer = setInterval(() => this._poll(), POLL_MS);

    const summaryIntervalSec = cfg.live?.summaryIntervalSec || 45;
    if ((cfg.live?.summaryProvider || 'off') !== 'off') {
      this._summaryTimer = setInterval(() => this._maybeSummarize().catch(() => {}), summaryIntervalSec * 1000);
    }

    return { id: session.id, title: session.title };
  }

  _assertAlive(capture, human) {
    if (capture.spawnError) throw new Error(`Failed to start ${human} capture: ${capture.spawnError.message}`);
    if (capture.proc && capture.proc.exitCode !== null && capture.proc.exitCode !== 0) {
      throw new Error(`${human} capture exited immediately (code ${capture.proc.exitCode}).\n${capture.stderr.trim() || '(no output)'}`);
    }
  }

  _poll() {
    for (const entry of this.micTailer.poll()) {
      this.micTotalMs += entry.durationMs;
      this.queue.push({ stream: 'mic', entry });
    }
    for (const entry of this.sysTailer.poll()) {
      this.sysTotalMs += entry.durationMs;
      this.queue.push({ stream: 'system', entry });
    }
    if (!this.processing) this._drainQueue();
  }

  async _drainQueue() {
    this.processing = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        try {
          await this._processSegment(job);
        } catch (err) {
          logger.debug(`[live] segment transcription failed: ${err.message}`);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  async _processSegment({ stream, entry }) {
    const dir = stream === 'mic' ? this.micSegDir : this.sysSegDir;
    const rawFile = segmentFilePath(dir, entry);
    let fileToTranscribe = rawFile;
    let tmp16 = null;

    if (stream === 'system') {
      // WASAPI segments are captured at the device's native mix rate — convert to 16k mono first.
      tmp16 = rawFile.replace(/\.wav$/i, '.16k.wav');
      const ok = convertAudioTo16kMono(rawFile, tmp16);
      if (!ok) return;
      fileToTranscribe = tmp16;
    }

    let segs = [];
    try {
      segs = await transcribeFile(fileToTranscribe, {
        model: this.cfg.model,
        language: this.cfg.language,
        vad: this.cfg.vad !== false,
      });
    } finally {
      if (tmp16) { try { fs.unlinkSync(tmp16); } catch { /* ignore */ } }
    }

    const offsetSec = entry.startMs / 1000;
    const mapped = segs.map((s) => ({ start: s.start + offsetSec, end: s.end + offsetSec, text: s.text }));
    if (stream === 'mic') this.micLive.push(...mapped);
    else this.sysLive.push(...mapped);

    this._recomputeAndEmit();
  }

  _recomputeAndEmit() {
    const timeline = mergeTranscripts({
      micSegments: this.micLive,
      systemSegments: this.sysLive,
      systemOffsetSec: (this.session.offsets?.systemMinusMicMs ?? 0) / 1000,
      labels: this.cfg.labels,
      coalesce: true,
      maxSentencesPerTurn: this.cfg.maxSentencesPerTurn,
    });
    this.lastTimeline = timeline;
    this.callbacks.onTranscript?.(timeline);
  }

  async _maybeSummarize() {
    const timeline = this.lastTimeline;
    if (!timeline.length) return;
    const transcriptText = timeline.map((t) => `${t.speaker}: ${t.text}`).join('\n');
    const key = `${timeline.length}:${transcriptText.length}`;
    if (key === this.lastSummaryKey) return; // nothing new since last summary
    this.lastSummaryKey = key;

    try {
      const summary = await generateLiveSummary({
        transcriptText,
        title: this.session.title,
        provider: this.cfg.live?.summaryProvider || 'ollama',
        ollama: this.cfg.live?.ollama,
        groq: this.cfg.groq,
      });
      this.callbacks.onSummary?.(summary);
    } catch (err) {
      this.callbacks.onStatus?.(`Live summary skipped: ${err.message}`);
    }
  }

  /** Wait until the transcription queue is empty (bounded, so stop() always resolves). */
  async _drainAndWait(timeoutMs = 20000) {
    const start = Date.now();
    // A couple more polls to catch manifest lines flushed right at process exit.
    for (let i = 0; i < 3; i++) {
      this._poll();
      await new Promise((r) => setTimeout(r, 300));
    }
    while ((this.queue.length || this.processing) && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async stop({ insights } = {}) {
    if (this.stopped) return { id: this.session.id };
    this.stopped = true;
    clearInterval(this._pollTimer);
    clearInterval(this._summaryTimer);

    this.callbacks.onStatus?.('Finalizing recording…');
    await Promise.all([this.micCapture.stop(), this.sysCapture.stop()]);

    this.callbacks.onStatus?.('Finishing live transcript…');
    await this._drainAndWait();

    const cfg = this.cfg;
    const session = this.session;
    const labels = cfg.labels;
    const speakers = [];
    if (this.micLive.length) speakers.push(labels.me);
    if (this.sysLive.length) speakers.push(labels.participants);
    if (!speakers.length) speakers.push(labels.me, labels.participants);

    const durationSec = Math.max(this.micTotalMs / 1000, this.sysTotalMs / 1000, this.lastTimeline.length ? this.lastTimeline[this.lastTimeline.length - 1].end : 0);

    writeMarkdown(cfg, { session, timeline: this.lastTimeline, model: cfg.model, durationSec, speakers });

    // Fine-grained (uncoalesced) timeline so subtitle timing stays accurate, same as the batch path.
    const srtTimeline = mergeTranscripts({
      micSegments: this.micLive,
      systemSegments: this.sysLive,
      systemOffsetSec: (session.offsets?.systemMinusMicMs ?? 0) / 1000,
      labels,
      coalesce: false,
    });
    writeSrt(cfg, { session, timeline: srtTimeline, speakerPrefix: this.micLive.length > 0 && this.sysLive.length > 0 });

    // Stitch finalized segments into normal session WAVs, then drop the segment folders.
    const micFiles = listSegmentFiles(this.micSegDir, 'mic_');
    const sysFiles = listSegmentFiles(this.sysSegDir, 'seg_');
    if (micFiles.length) concatWavFiles(micFiles, session.files.mic);
    if (sysFiles.length) {
      const combined = path.join(this.sysSegDir, '__combined.wav');
      if (concatWavFiles(sysFiles, combined)) {
        ensure16kMono(combined);
        fs.renameSync(combined, session.files.system);
      }
    }
    try { fs.rmSync(this.micSegDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(this.sysSegDir, { recursive: true, force: true }); } catch { /* ignore */ }

    session.results = {
      mic: { file: session.files.mic, bytes: fileSizeSafe(session.files.mic), durationSec: probeDuration(session.files.mic) },
      system: { file: session.files.system, bytes: fileSizeSafe(session.files.system), durationSec: probeDuration(session.files.system) },
    };
    saveSession(session);
    enforceStorageCap(cfg.resolved.recordings, cfg.storage?.maxRecordingsGB ?? 20);

    if (insights ?? cfg.groq?.enabled) {
      try {
        this.callbacks.onStatus?.('Generating insights…');
        await writeInsightsForSession(cfg, session);
      } catch (err) {
        this.callbacks.onStatus?.(`Insights skipped: ${err.message}`);
      }
    }
    this.callbacks.onStatus?.('Done.');
    return { id: session.id };
  }

  async cancel() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this._pollTimer);
    clearInterval(this._summaryTimer);
    try { await Promise.all([this.micCapture?.stop(), this.sysCapture?.stop()]); } catch { /* ignore */ }
  }
}

function listSegmentFiles(dir, prefix) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.startsWith(prefix) && f.endsWith('.wav'))
    .sort()
    .map((f) => path.join(dir, f));
}

function fileSizeSafe(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
