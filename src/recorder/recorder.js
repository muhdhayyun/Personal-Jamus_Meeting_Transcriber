import os from 'node:os';
import { buildCaptureArgs } from './platform.js';
import { FfmpegCapture } from './ffmpegProcess.js';
import { WasapiCapture, systemAudioTarget } from './wasapiCapture.js';
import { saveSession } from '../pipeline/session.js';
import { logger } from '../utils/logger.js';
import { probeDuration, ensure16kMono } from '../utils/audio.js';
import { fileSize } from '../utils/fsx.js';
import { enforceStorageCap } from '../utils/storage.js';

const isWin = os.platform() === 'win32';

/**
 * Record a session's two audio sources (mic + system) in parallel.
 *
 * On Windows the system stream is captured via WASAPI loopback (no Stereo Mix /
 * virtual cable needed). On other platforms it uses an FFmpeg loopback device.
 * The mic stream always uses FFmpeg.
 *
 * `waitForStop` resolves when the user wants to stop (Enter / Ctrl+C).
 */
export async function recordSession(cfg, session, { waitForStop }) {
  const { sampleRate, channels, codec } = cfg.audio;

  const mic = new FfmpegCapture({
    label: 'mic',
    args: buildCaptureArgs({ deviceId: session.devices.mic, outFile: session.files.mic, sampleRate, channels, codec }),
  });

  const systemViaWasapi = isWin && session.devices.system === 'wasapi';
  const system = systemViaWasapi
    ? new WasapiCapture({ label: 'system', outFile: session.files.system, target: systemAudioTarget(cfg) })
    : new FfmpegCapture({
        label: 'system',
        args: buildCaptureArgs({ deviceId: session.devices.system, outFile: session.files.system, sampleRate, channels, codec }),
      });

  // Start as close together as possible, then record the wall-clock skew for alignment.
  const micStart = mic.start();
  const systemStart = system.start();
  session.offsets.systemMinusMicMs = systemStart - micStart;

  // Surface immediate failures (bad device, permissions, missing binary).
  await new Promise((r) => setTimeout(r, 400));
  assertAlive(mic, 'microphone');
  assertAlive(system, systemViaWasapi ? 'system audio (WASAPI loopback)' : 'system audio');

  logger.success('Recording… speak normally. Press Enter (or Ctrl+C) to stop.');

  await waitForStop();

  logger.step('Finalizing recording…');
  await Promise.all([mic.stop(), system.stop()]);

  // WASAPI captures at the device sample rate; normalize to 16 kHz mono for Whisper.
  if (systemViaWasapi) ensure16kMono(session.files.system);

  session.results = {
    mic: summarize(session.files.mic, mic),
    system: summarize(session.files.system, system),
  };

  saveSession(session);

  // Keep the recordings directory under the configured size cap (delete oldest).
  enforceStorageCap(cfg.resolved.recordings, cfg.storage?.maxRecordingsGB ?? 20);

  return session;
}

function assertAlive(capture, human) {
  if (capture.spawnError) {
    throw new Error(`Failed to start ${human} capture: ${capture.spawnError.message}`);
  }
  if (capture.proc && capture.proc.exitCode !== null && capture.proc.exitCode !== 0) {
    throw new Error(
      `${human} capture exited immediately (code ${capture.proc.exitCode}).\n` +
        `Details:\n${capture.stderr.trim() || '(no output)'}\n` +
        `Check the device with "jamus devices".`
    );
  }
}

function summarize(file, capture) {
  const bytes = fileSize(file);
  const duration = probeDuration(file);
  if (bytes === 0 || duration === 0) {
    logger.warn(`No audio captured on the ${capture.label} stream (${file}). ` + (capture.stderr.trim() || ''));
  }
  return { file, bytes, durationSec: duration };
}
