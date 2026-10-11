import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The system-audio rule as {mode, process}. mode is 'all' (capture everything),
 * 'only' (capture just `process`) or 'block' (capture everything except `process`).
 *
 * Older configs only had {excludeProcess, enabled}; those map to 'block' / 'all'.
 */
export function systemAudioRule(cfg) {
  const sa = cfg.systemAudio || {};
  if (sa.mode === undefined) {
    return sa.excludeProcess && sa.enabled !== false
      ? { mode: 'block', process: sa.excludeProcess }
      : { mode: 'all', process: null };
  }
  if ((sa.mode === 'only' || sa.mode === 'block') && sa.process) return { mode: sa.mode, process: sa.process };
  return { mode: 'all', process: null };
}

/** The rule to hand to WasapiCapture, or null when everything should be captured. */
export function systemAudioTarget(cfg) {
  const rule = systemAudioRule(cfg);
  return rule.mode === 'all' ? null : rule;
}

/** Path to the compiled WASAPI loopback recorder. */
export function wasapiExePath() {
  return path.resolve(__dirname, '..', '..', 'native', 'wasapi-loopback.exe');
}

export function wasapiBuilt() {
  return fs.existsSync(wasapiExePath());
}

export function assertWasapiBuilt() {
  if (!wasapiBuilt()) {
    throw new Error(
      `The WASAPI loopback recorder is not built (missing ${wasapiExePath()}).\n` +
        `Build it once with:  npm run build:wasapi`
    );
  }
}

/**
 * Captures the default render endpoint via WASAPI loopback.
 * Mirrors the FfmpegCapture interface so the recorder can treat both uniformly.
 *
 * Pass either `outFile` (single continuous WAV, normal recordings) or `segments`
 * `{ outDir, segSeconds }` (rolling segments, used by live transcription).
 *
 * `target` (optional): `{ mode: 'block' | 'only', process }` where process is a name like
 * "Spotify.exe". 'block' leaves that app out and captures everything else; 'only' captures
 * just that app. Uses Windows' per-process loopback; one app (and its child-process tree)
 * per recording.
 *
 * `onStatus(info)` (optional) is called once the recorder reports whether the target really
 * attached: `{ mode: 'include'|'exclude', target, attached, pid }`.
 */
export class WasapiCapture {
  constructor({ label, outFile, segments, target, onStatus }) {
    this.label = label;
    this.outFile = outFile;
    this.segments = segments;
    this.target = target || null;
    this.onStatus = onStatus;
    this.attach = null; // last STATUS line from the recorder
    this.proc = null;
    this.startedAt = null;
    this.stderr = '';
    this._lineBuf = '';
    this._exited = new Promise((resolve) => (this._resolveExit = resolve));
  }

  start() {
    const args = this.segments
      ? ['--segments', this.segments.outDir, String(this.segments.segSeconds)]
      : [this.outFile];
    if (this.target) {
      args.unshift(this.target.mode === 'only' ? '--include-process' : '--exclude-process', this.target.process);
    }
    this.proc = spawn(wasapiExePath(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.startedAt = Date.now();

    this.proc.stderr.on('data', (d) => {
      const text = d.toString();
      this.stderr += text;
      this._scanStatus(text);
    });
    this.proc.on('error', (err) => {
      this.spawnError = err;
      this._resolveExit({ code: null, signal: null, error: err });
    });
    this.proc.on('close', (code, signal) => this._resolveExit({ code, signal }));
    return this.startedAt;
  }

  /** Pull the recorder's "[wasapi] STATUS {json}" line out of its stderr stream. */
  _scanStatus(chunk) {
    this._lineBuf += chunk;
    const lines = this._lineBuf.split(/\r?\n/);
    this._lineBuf = lines.pop(); // keep any partial trailing line
    for (const line of lines) {
      const m = line.match(/\[wasapi\] STATUS (\{.*\})/);
      if (!m) continue;
      try {
        this.attach = JSON.parse(m[1]);
        this.onStatus?.(this.attach);
      } catch { /* ignore a malformed line */ }
    }
  }

  /** The recorder stops cleanly when its stdin receives a line / closes. */
  async stop(timeoutMs = 4000) {
    if (!this.proc || this.proc.exitCode !== null) return this._exited;
    try {
      this.proc.stdin.write('\n');
      this.proc.stdin.end();
    } catch {
      // already closed
    }
    const killer = setTimeout(() => {
      try { this.proc.kill('SIGKILL'); } catch { /* gone */ }
    }, timeoutMs);
    const result = await this._exited;
    clearTimeout(killer);
    return result;
  }

  whenExited() {
    return this._exited;
  }
}

/**
 * Apps that currently have an audio session on the default output device, for the
 * "which app?" picker. Resolves to [{ name, label, pids, active, peak }]; `peak` is 0..1.
 * Rejects if the recorder isn't built or can't enumerate.
 */
export function listAudioApps() {
  assertWasapiBuilt();
  return new Promise((resolve, reject) => {
    execFile(wasapiExePath(), ['--list-audio-apps'], { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('Could not read the audio app list.'));
      }
    });
  });
}
