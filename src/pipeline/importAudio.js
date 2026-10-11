import path from 'node:path';
import { createSession, saveSession } from './session.js';
import { transcribeSession } from './transcribeSession.js';
import { convertAudioTo16kMono, probeDuration } from '../utils/audio.js';
import { fileExists, fileSize } from '../utils/fsx.js';
import { assertFfmpegAvailable } from '../utils/ffmpeg.js';
import { logger } from '../utils/logger.js';

/**
 * Import an existing audio/voice file (phone memo, mp3, m4a, …), transcribe it as a
 * single-speaker recording, and produce a transcript that shows up like any meeting.
 *
 * The source is converted to the session's mic stream; there is no system stream, so the
 * transcript is single-speaker (labelled with `labels.me`).
 *
 * @returns {Promise<object>} the session.
 */
export async function importAudioFile(cfg, srcPath, { title, model, language, labels, maxSegmentSeconds } = {}) {
  assertFfmpegAvailable();
  if (!fileExists(srcPath)) throw new Error(`File not found: ${srcPath}`);

  const baseTitle = title || path.basename(srcPath, path.extname(srcPath)) || 'Imported recording';
  const session = createSession(cfg, { title: baseTitle, mic: 'imported', system: 'none', mode: 'import' });

  logger.step(`Converting "${path.basename(srcPath)}" to 16 kHz mono…`);
  const ok = convertAudioTo16kMono(srcPath, session.files.mic);
  if (!ok) {
    throw new Error('Could not read or convert that audio file. Make sure it is a real audio file FFmpeg can read.');
  }

  session.offsets.systemMinusMicMs = 0;
  session.results = {
    mic: { file: session.files.mic, bytes: fileSize(session.files.mic), durationSec: probeDuration(session.files.mic) },
    system: { file: session.files.system, bytes: 0, durationSec: 0 },
  };
  session.imported = { source: path.basename(srcPath) };
  saveSession(session);

  await transcribeSession(cfg, session, {
    model: model || cfg.model,
    language: language || cfg.language,
    labels: labels || cfg.labels,
    maxSegmentSeconds,
  });
  return session;
}
