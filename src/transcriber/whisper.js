import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertBuilt, ensureModel, binaryPath, modelPath, validateModel, ensureVadModel, vadModelPath } from './modelManager.js';
import { logger } from '../utils/logger.js';
import { fileExists, fileSize } from '../utils/fsx.js';

/**
 * Transcribe a single 16 kHz mono WAV with the local whisper.cpp binary.
 *
 * @returns {Promise<Array<{start:number,end:number,text:string}>>} segments in seconds.
 */
export async function transcribeFile(file, { model = 'large-v3', language = 'auto', vad = true, maxSegmentSeconds } = {}) {
  validateModel(model);
  if (!fileExists(file) || fileSize(file) === 0) {
    logger.warn(`Skipping transcription — empty or missing file: ${file}`);
    return [];
  }

  assertBuilt();
  ensureModel(model);

  const outBase = file.replace(/\.[^.]+$/, ''); // whisper writes <outBase>.json
  const args = [
    '-m', modelPath(model),
    '-f', file,
    '-l', language || 'auto',
    '-oj',                 // output JSON with timestamps/offsets
    '-of', outBase,
    '-np',                 // no progress prints
  ];

  // Voice Activity Detection: skip non-speech so Whisper doesn't hallucinate
  // filler text ("thank you", "thanks for watching") on silent/quiet audio.
  if (vad && ensureVadModel()) {
    args.push('--vad', '--vad-model', vadModelPath());
    // Force a cut once continuous speech exceeds this many seconds (still prefers a nearby
    // natural pause) — controls subtitle cue length; unset = whisper's natural, unbounded
    // segmentation (can run 10s+ with no pause).
    if (maxSegmentSeconds) args.push('--vad-max-speech-duration-s', String(maxSegmentSeconds));
  }

  const started = Date.now();
  await runBinary(binaryPath(), args);
  logger.debug(`whisper finished ${path.basename(file)} in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const jsonFile = `${outBase}.json`;
  const segments = parseWhisperJson(jsonFile);
  try { fs.unlinkSync(jsonFile); } catch { /* ignore */ }
  return segments;
}

function runBinary(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => reject(new Error(`Failed to run whisper-cli: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`whisper-cli exited with code ${code}.\n${stderr.trim()}`));
    });
  });
}

function parseWhisperJson(file) {
  if (!fs.existsSync(file)) {
    logger.warn(`No whisper output produced at ${file}`);
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const items = data.transcription ?? [];
    return items
      .map((it) => {
        // whisper.cpp JSON: offsets.from/to are milliseconds.
        const fromMs = it.offsets?.from ?? 0;
        const toMs = it.offsets?.to ?? fromMs;
        return { start: fromMs / 1000, end: toMs / 1000, text: cleanText(it.text) };
      })
      .filter((s) => s.text);
  } catch (err) {
    logger.warn(`Failed to parse whisper JSON ${file}: ${err.message}`);
    return [];
  }
}

function cleanText(t) {
  return String(t ?? '')
    .replace(/\[(BLANK_AUDIO|SILENCE|MUSIC|NOISE|INAUDIBLE).*?\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}
