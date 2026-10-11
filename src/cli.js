import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Command } from 'commander';
import chalk from 'chalk';
import { select } from '@inquirer/prompts';

import { loadConfig, saveUserConfig } from './config.js';
import { assertFfmpegAvailable } from './utils/ffmpeg.js';
import { logger } from './utils/logger.js';
import { listAudioDevices } from './devices/enumerate.js';
import { loopbackSetupHelp, pickLoopback, pickMic } from './devices/loopback.js';
import { createSession, loadSession } from './pipeline/session.js';
import { recordSession } from './recorder/recorder.js';
import { wasapiBuilt, assertWasapiBuilt } from './recorder/wasapiCapture.js';
import { transcribeSession } from './pipeline/transcribeSession.js';
import { KNOWN_MODELS, validateModel, isModelDownloaded, ensureModel, isBuilt } from './transcriber/modelManager.js';
import { writeInsightsForSession } from './insights/groq.js';
import { importAudioFile } from './pipeline/importAudio.js';
import { LiveSession } from './pipeline/liveSession.js';

export async function run(argv) {
  const program = new Command();
  program
    .name('jamus')
    .description('Local meeting transcriber — records mic + system audio and writes a speaker-separated Markdown transcript.')
    .version('0.1.0');

  program
    .command('devices')
    .description('List audio input devices and check for a system-audio loopback source')
    .action(() => cmdDevices());

  program
    .command('record')
    .description('Record mic + system audio to a session (transcribe later)')
    .option('-t, --title <title>', 'meeting title')
    .option('--mic <device>', 'microphone device id/name')
    .option('--system <device>', 'system-audio (loopback) device id/name')
    .option('--mode <mode>', 'recording mode: dual | stereo', 'dual')
    .action((opts) => cmdRecord(opts));

  program
    .command('transcribe')
    .argument('<session>', 'session id, directory, or session.json path')
    .description('Transcribe a previously recorded session into Markdown + JSON')
    .option('-m, --model <model>', 'Whisper model')
    .option('--language <lang>', 'language code (or "auto")')
    .option('--me <name>', 'label for your own voice')
    .option('--others <name>', 'label for other participants')
    .option('--insights', 'also generate AI insights via Groq after transcribing')
    .action((sessionRef, opts) => cmdTranscribe(sessionRef, opts));

  program
    .command('run')
    .description('Record, then automatically transcribe when you stop')
    .option('-t, --title <title>', 'meeting title')
    .option('--mic <device>', 'microphone device id/name')
    .option('--system <device>', 'system-audio (loopback) device id/name')
    .option('--mode <mode>', 'recording mode: dual | stereo', 'dual')
    .option('-m, --model <model>', 'Whisper model')
    .option('--language <lang>', 'language code (or "auto")')
    .option('--me <name>', 'label for your own voice')
    .option('--others <name>', 'label for other participants')
    .option('--insights', 'also generate AI insights via Groq after transcribing')
    .option('--live', 'show the transcript (and rolling summary) in the terminal as it happens')
    .action((opts) => cmdRun(opts));

  program
    .command('transcribe-file')
    .argument('<path>', 'path to an audio file (mp3, m4a, wav, etc.)')
    .description('Transcribe an existing audio/voice recording into Markdown')
    .option('-t, --title <title>', 'title for the transcript')
    .option('-m, --model <model>', 'Whisper model')
    .option('--language <lang>', 'language code (or "auto")')
    .option('--me <name>', 'speaker label')
    .option('--max-segment-seconds <n>', 'cap subtitle cue length in seconds (default: unbounded, natural pauses only)')
    .option('--insights', 'also generate AI insights via Groq')
    .action((filePath, opts) => cmdTranscribeFile(filePath, opts));

  program
    .command('insights')
    .argument('<session>', 'session id, directory, or session.json path')
    .description('Generate AI insights (Groq) for an already-transcribed session')
    .action((sessionRef) => cmdInsights(sessionRef));

  program
    .command('models')
    .description('List Whisper models and download status')
    .option('--list', 'list known models (default action)')
    .option('--download <name>', 'pre-download a model so it is ready offline')
    .action((opts) => cmdModels(opts));

  await program.parseAsync(argv);
}

// ---------------------------------------------------------------- devices
function cmdDevices() {
  assertFfmpegAvailable();
  const { platform, backend, devices } = listAudioDevices();
  logger.info(chalk.bold(`\nAudio input devices  ${chalk.dim(`(${platform} / ${backend})`)}\n`));

  if (devices.length === 0) {
    logger.warn('No audio input devices found. Is FFmpeg installed and are devices connected?');
  } else {
    for (const d of devices) {
      const tag =
        d.kind === 'loopback' ? chalk.green('[loopback]') : d.kind === 'mic' ? chalk.cyan('[mic]') : chalk.dim('[input]');
      logger.info(`  ${tag} ${d.name}`);
    }
  }

  logger.info('');
  if (os.platform() === 'win32') {
    // On Windows, system audio is captured via WASAPI loopback — no device needed.
    if (wasapiBuilt()) {
      logger.success('System audio: captured automatically via WASAPI loopback of your default output device.');
      logger.dim('  No Stereo Mix or virtual cable required. Just pick your microphone when recording.');
    } else {
      logger.warn('WASAPI loopback recorder not built yet — run:  npm run build:wasapi');
    }
    return;
  }
  const loop = pickLoopback(devices);
  if (loop) {
    logger.success(`System-audio loopback available: "${loop.name}"`);
  } else {
    logger.warn('No system-audio loopback detected.\n');
    logger.dim(loopbackSetupHelp());
  }
}

// ---------------------------------------------------------------- record
async function cmdRecord(opts) {
  const cfg = loadConfig();
  assertFfmpegAvailable();
  const session = await startRecording(cfg, opts);
  logger.success(`Saved session "${session.id}".`);
  logger.dim(`Transcribe it later with:  jamus transcribe ${session.id}`);
}

// ---------------------------------------------------------------- transcribe
async function cmdTranscribe(sessionRef, opts) {
  const cfg = loadConfig();
  assertFfmpegAvailable();
  const session = loadSession(cfg, sessionRef);
  const labels = {
    me: opts.me || cfg.labels.me,
    participants: opts.others || cfg.labels.participants,
  };
  const model = validateModel(opts.model || cfg.model);
  await transcribeSession(cfg, session, {
    model,
    language: opts.language || cfg.language,
    labels,
  });
  await maybeInsights(cfg, session, opts);
}

// ---------------------------------------------------------------- run
async function cmdRun(opts) {
  if (opts.live) return cmdRunLive(opts);

  const cfg = loadConfig();
  assertFfmpegAvailable();
  const session = await startRecording(cfg, opts);
  const labels = {
    me: opts.me || cfg.labels.me,
    participants: opts.others || cfg.labels.participants,
  };
  const model = validateModel(opts.model || cfg.model);
  if (!isModelDownloaded(model)) {
    logger.dim(`Model "${model}" is not downloaded yet — it will be fetched now (first run only).`);
  }
  await transcribeSession(cfg, session, {
    model,
    language: opts.language || cfg.language,
    labels,
  });
  await maybeInsights(cfg, session, opts);
}

// ---------------------------------------------------------------- run --live
async function cmdRunLive(opts) {
  const cfg = loadConfig();
  assertFfmpegAvailable();
  const { mic } = await resolveDevices(cfg, { ...opts, system: 'wasapi' });

  logger.info('');
  logger.info(chalk.bold(`Live recording "${opts.title || 'Untitled meeting'}"`));
  logger.dim(`  mic    → ${mic}`);
  logger.dim('  system → WASAPI loopback (default output device)');
  logger.info('');
  logger.success('Recording… transcript appears below as people speak. Press Enter (or Ctrl+C) to stop.\n');

  let printedCount = 0;
  const live = new LiveSession(cfg, { title: opts.title, mic }, {
    onTranscript: (timeline) => {
      for (let i = printedCount; i < timeline.length; i++) {
        const t = timeline[i];
        logger.info(`${chalk.dim(`[${formatClock(t.start)}]`)} ${chalk.bold(t.speaker)}: ${t.text}`);
      }
      printedCount = timeline.length;
    },
    onSummary: (text) => {
      logger.info(chalk.dim('\n───── Live summary ─────'));
      logger.info(text);
      logger.info(chalk.dim('────────────────────────\n'));
    },
    onStatus: (msg) => logger.dim(msg),
  });

  await live.start();
  await waitForStop();
  const result = await live.stop({ insights: !!opts.insights });
  logger.success(`\nSaved: jamus transcribe ${result.id}   (or just re-open it in the app)`);
}

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// ---------------------------------------------------------------- transcribe-file
async function cmdTranscribeFile(filePath, opts) {
  const cfg = loadConfig();
  const labels = {
    me: opts.me || cfg.labels.me,
    participants: cfg.labels.participants,
  };
  const model = validateModel(opts.model || cfg.model);
  const session = await importAudioFile(cfg, filePath, {
    title: opts.title,
    model,
    language: opts.language || cfg.language,
    labels,
    maxSegmentSeconds: opts.maxSegmentSeconds ? Number(opts.maxSegmentSeconds) : undefined,
  });
  await maybeInsights(cfg, session, opts);
}

// ---------------------------------------------------------------- insights
async function cmdInsights(sessionRef) {
  const cfg = loadConfig();
  const session = loadSession(cfg, sessionRef);
  await writeInsightsForSession(cfg, session);
}

/** Generate insights if requested (--insights) or enabled in config, swallowing errors softly. */
async function maybeInsights(cfg, session, opts) {
  if (!opts.insights && !cfg.groq?.enabled) return;
  try {
    await writeInsightsForSession(cfg, session);
  } catch (err) {
    logger.warn(`Insights skipped: ${err.message}`);
  }
}

// ---------------------------------------------------------------- models
async function cmdModels(opts) {
  const cfg = loadConfig();
  if (opts.download) {
    const name = validateModel(opts.download);
    ensureModel(name);
    logger.success(`Model "${name}" is ready.`);
    return;
  }
  logger.info(chalk.bold('\nWhisper models\n'));
  logger.info(`  whisper.cpp built: ${isBuilt() ? chalk.green('yes') : chalk.red('no — run `npm run build:whisper`')}`);
  logger.info('');
  for (const m of KNOWN_MODELS) {
    const here = isModelDownloaded(m);
    const mark = here ? chalk.green('✔ downloaded') : chalk.dim('– not downloaded');
    const def = m === cfg.model ? chalk.yellow('  (default)') : '';
    logger.info(`  ${m.padEnd(16)} ${mark}${def}`);
  }
  logger.dim('\nModels download automatically on first transcription, or pre-fetch with: jamus models --download <name>');
}

// ---------------------------------------------------------------- helpers

/** Resolve devices (flags → saved config → interactive), create + run a recording session. */
async function startRecording(cfg, opts) {
  const { mic, system } = await resolveDevices(cfg, opts);
  const session = createSession(cfg, {
    title: opts.title || 'Untitled meeting',
    mic,
    system,
    mode: opts.mode || cfg.recordMode,
  });

  logger.info('');
  logger.info(chalk.bold(`Recording "${session.title}"`));
  logger.dim(`  mic    → ${mic}`);
  logger.dim(`  system → ${system === 'wasapi' ? 'WASAPI loopback (default output device)' : system}`);
  logger.dim(`  files  → ${path.relative(process.cwd(), session.dir)}`);
  logger.info('');

  return recordSession(cfg, session, { waitForStop });
}

/** Choose mic + system devices, persisting interactive choices for next time. */
async function resolveDevices(cfg, opts) {
  const { devices } = listAudioDevices();

  let mic = opts.mic || cfg.devices.mic;
  let system = opts.system || cfg.devices.system;
  let chose = false;

  if (!mic) {
    const def = pickMic(devices);
    mic = await pickDevice('Select your MICROPHONE (your voice):', devices, def?.id);
    chose = true;
  }
  if (!system) {
    if (os.platform() === 'win32') {
      // Windows: capture system audio via WASAPI loopback of the default output device.
      // No virtual device / Stereo Mix needed.
      assertWasapiBuilt();
      system = 'wasapi';
    } else {
      const loop = pickLoopback(devices);
      if (!loop && devices.every((d) => !d.isLoopbackCandidate)) {
        logger.warn('No system-audio loopback detected.\n');
        logger.dim(loopbackSetupHelp());
        throw new Error('Set up a system-audio loopback (see above), then run "jamus devices" to confirm.');
      }
      system = await pickDevice('Select your SYSTEM-AUDIO loopback (other speakers):', devices, loop?.id);
      chose = true;
    }
  }

  if (chose && process.stdin.isTTY) {
    saveUserConfig({ devices: { mic, system } });
    logger.dim(`Saved device choices to ${path.join(os.homedir(), '.jamus', 'config.json')}`);
  }
  return { mic, system };
}

async function pickDevice(message, devices, defaultId) {
  if (devices.length === 0) throw new Error('No audio input devices available.');
  return select({
    message,
    default: defaultId,
    choices: devices.map((d) => ({
      name: `${d.name}${d.isLoopbackCandidate ? ' (loopback)' : d.kind === 'mic' ? ' (mic)' : ''}`,
      value: d.id,
    })),
  });
}

/** Resolve when the user presses Enter or hits Ctrl+C. */
function waitForStop() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const done = () => {
      rl.close();
      process.off('SIGINT', done);
      resolve();
    };
    rl.on('line', done);
    process.once('SIGINT', done);
  });
}
