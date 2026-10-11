// Electron main process (CommonJS). The core engine is ESM, so we load it via
// dynamic import() — this avoids Electron's ESM-main CJS-interop issues.
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const isWin = os.platform() === 'win32';
const imp = (rel) => import(pathToFileURL(path.join(__dirname, rel)).href);

let core = null;
let mainWindow = null;
let recordingState = null; // { cfg, session, stopResolver, donePromise } (batch/non-live recording)
let liveSessionInstance = null; // a LiveSession instance while a live recording is active

async function loadCore() {
  const [config, ffmpeg, enumerate, loopback, session, recorder, wasapi, transcribe, modelManager, groq, meetings, storage, importAudio, liveSession, liveSummary] =
    await Promise.all([
      imp('../src/config.js'),
      imp('../src/utils/ffmpeg.js'),
      imp('../src/devices/enumerate.js'),
      imp('../src/devices/loopback.js'),
      imp('../src/pipeline/session.js'),
      imp('../src/recorder/recorder.js'),
      imp('../src/recorder/wasapiCapture.js'),
      imp('../src/pipeline/transcribeSession.js'),
      imp('../src/transcriber/modelManager.js'),
      imp('../src/insights/groq.js'),
      imp('../src/pipeline/meetings.js'),
      imp('../src/utils/storage.js'),
      imp('../src/pipeline/importAudio.js'),
      imp('../src/pipeline/liveSession.js'),
      imp('../src/insights/liveSummary.js'),
    ]);
  core = {
    loadConfig: config.loadConfig,
    saveUserConfig: config.saveUserConfig,
    assertFfmpegAvailable: ffmpeg.assertFfmpegAvailable,
    listAudioDevices: enumerate.listAudioDevices,
    pickLoopback: loopback.pickLoopback,
    pickMic: loopback.pickMic,
    createSession: session.createSession,
    loadSession: session.loadSession,
    recordSession: recorder.recordSession,
    wasapiBuilt: wasapi.wasapiBuilt,
    systemAudioRule: wasapi.systemAudioRule,
    listAudioApps: wasapi.listAudioApps,
    assertWasapiBuilt: wasapi.assertWasapiBuilt,
    transcribeSession: transcribe.transcribeSession,
    isBuilt: modelManager.isBuilt,
    isModelDownloaded: modelManager.isModelDownloaded,
    writeInsightsForSession: groq.writeInsightsForSession,
    listMeetings: meetings.listMeetings,
    readTranscript: meetings.readTranscript,
    readInsights: meetings.readInsights,
    renameMeeting: meetings.renameMeeting,
    deleteMeetingAudio: meetings.deleteMeetingAudio,
    deleteAllAudio: meetings.deleteAllAudio,
    recordingsSize: storage.recordingsSize,
    importAudioFile: importAudio.importAudioFile,
    LiveSession: liveSession.LiveSession,
    isOllamaReachable: liveSummary.isOllamaReachable,
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f5f6fa',
    title: 'Jamus',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  await loadCore();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

function status(msg) {
  mainWindow?.webContents.send('status', msg);
}

// ---- status / devices --------------------------------------------------
ipcMain.handle('app:status', async () => {
  const cfg = core.loadConfig();
  let ffmpeg = true;
  try { core.assertFfmpegAvailable(); } catch { ffmpeg = false; }
  const usedBytes = core.recordingsSize(cfg.resolved.recordings);
  return {
    platform: os.platform(),
    ffmpeg,
    whisperBuilt: core.isBuilt(),
    wasapiBuilt: isWin ? core.wasapiBuilt() : true,
    modelDownloaded: core.isModelDownloaded(cfg.model),
    model: cfg.model,
    storage: {
      usedGB: +(usedBytes / 1024 / 1024 / 1024).toFixed(2),
      capGB: cfg.storage?.maxRecordingsGB ?? 20,
    },
  };
});

ipcMain.handle('devices:list', async () => core.listAudioDevices().devices);

// ---- settings ----------------------------------------------------------
ipcMain.handle('settings:get', async () => {
  const cfg = core.loadConfig();
  return { model: cfg.model, language: cfg.language, labels: cfg.labels, devices: cfg.devices, storage: cfg.storage, groq: cfg.groq, live: cfg.live, systemAudio: core.systemAudioRule(cfg) };
});

// Apps that currently have an audio session (for the system-audio picker).
ipcMain.handle('audio:apps', async () => {
  if (!isWin) return [];
  return core.listAudioApps();
});

ipcMain.handle('settings:save', async (_e, partial) => {
  core.saveUserConfig(partial);
  return true;
});

// ---- meetings ----------------------------------------------------------
ipcMain.handle('meetings:list', async () => core.listMeetings(core.loadConfig()));

ipcMain.handle('meeting:get', async (_e, id) => {
  const cfg = core.loadConfig();
  const m = core.listMeetings(cfg).find((x) => x.id === id);
  if (!m) throw new Error('Meeting not found.');
  return { meeting: m, transcript: core.readTranscript(m), insights: core.readInsights(m) };
});

ipcMain.handle('open:transcripts', async () => {
  await shell.openPath(core.loadConfig().resolved.transcripts);
});

ipcMain.handle('meeting:rename', async (_e, { id, title }) => {
  core.renameMeeting(core.loadConfig(), id, title);
  return true;
});

ipcMain.handle('audio:delete', async (_e, id) => core.deleteMeetingAudio(core.loadConfig(), id));
ipcMain.handle('audio:deleteAll', async () => core.deleteAllAudio(core.loadConfig()));

// ---- import existing audio ---------------------------------------------
ipcMain.handle('import:pick', async () => {
  const cfg = core.loadConfig();
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose audio file(s) to transcribe',
    defaultPath: cfg.resolved.dropin,
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio', extensions: ['mp3', 'm4a', 'wav', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma', 'mp4', 'webm', '3gp', 'amr', 'aiff', 'caf'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths.map((p) => ({ path: p, name: path.basename(p) }));
});

ipcMain.handle('import:run', async (_e, { files, insights }) => {
  const cfg = core.loadConfig();
  const ids = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    status(`Importing ${i + 1}/${files.length}: ${path.basename(f.path)}…`);
    const session = await core.importAudioFile(cfg, f.path, { title: f.title, model: cfg.model, language: cfg.language, labels: cfg.labels });
    if (insights ?? cfg.groq?.enabled) {
      try { status('Generating insights…'); await core.writeInsightsForSession(cfg, session); } catch (err) { status(`Insights skipped: ${err.message}`); }
    }
    ids.push(session.id);
  }
  status('Done.');
  return { ids };
});

ipcMain.handle('open:dropin', async () => {
  await shell.openPath(core.loadConfig().resolved.dropin);
});

// ---- recording ---------------------------------------------------------
ipcMain.handle('record:start', async (_e, { title, mic }) => {
  if (recordingState) throw new Error('Already recording.');
  if (liveSessionInstance) throw new Error('A live recording is already in progress.');
  const cfg = core.loadConfig();
  core.assertFfmpegAvailable();
  if (isWin) core.assertWasapiBuilt();

  const { devices } = core.listAudioDevices();
  const micId = mic || cfg.devices.mic || core.pickMic(devices)?.id;
  if (!micId) throw new Error('No microphone available.');

  let systemId;
  if (isWin) {
    systemId = 'wasapi';
  } else {
    const loop = core.pickLoopback(devices);
    if (!loop) throw new Error('No system-audio loopback device found (see README).');
    systemId = loop.id;
  }

  const session = core.createSession(cfg, { title, mic: micId, system: systemId, mode: cfg.recordMode });
  let stopResolver;
  const waitForStop = () => new Promise((r) => (stopResolver = r));
  const donePromise = core.recordSession(cfg, session, { waitForStop });
  await Promise.race([donePromise.then(() => 'done').catch(() => 'err'), new Promise((r) => setTimeout(r, 600))]);
  recordingState = { cfg, session, stopResolver, donePromise };
  return { id: session.id, title: session.title };
});

ipcMain.handle('record:stop', async (_e, { insights } = {}) => {
  if (!recordingState) throw new Error('Not recording.');
  const { cfg, session, stopResolver, donePromise } = recordingState;
  recordingState = null;

  status('Finalizing recording…');
  stopResolver?.();
  await donePromise;

  status(`Transcribing with ${cfg.model}…`);
  await core.transcribeSession(cfg, session, { model: cfg.model, language: cfg.language, labels: cfg.labels });

  if (insights ?? cfg.groq?.enabled) {
    try {
      status('Generating insights…');
      await core.writeInsightsForSession(cfg, session);
    } catch (err) {
      status(`Insights skipped: ${err.message}`);
    }
  }
  status('Done.');
  return { id: session.id };
});

ipcMain.handle('record:cancel', async () => {
  if (!recordingState) return false;
  const { stopResolver, donePromise } = recordingState;
  recordingState = null;
  stopResolver?.();
  try { await donePromise; } catch { /* ignore */ }
  return true;
});

// ---- insights ----------------------------------------------------------
ipcMain.handle('insights:generate', async (_e, id) => {
  const cfg = core.loadConfig();
  const session = core.loadSession(cfg, id);
  return core.writeInsightsForSession(cfg, session);
});

// ---- live recording (rolling transcript + summary while recording) -----
ipcMain.handle('live:status', async () => {
  const cfg = core.loadConfig();
  const provider = cfg.live?.summaryProvider || 'off';
  let ollamaOk = true;
  if (provider === 'ollama') ollamaOk = await core.isOllamaReachable(cfg.live?.ollama?.url);
  return { enabled: cfg.live?.enabled !== false, provider, ollamaOk, segmentSeconds: cfg.live?.segmentSeconds ?? 12 };
});

ipcMain.handle('live:start', async (_e, { title, mic }) => {
  if (recordingState) throw new Error('A recording is already in progress.');
  if (liveSessionInstance) throw new Error('Already recording.');
  const cfg = core.loadConfig();
  core.assertFfmpegAvailable();

  const { devices } = core.listAudioDevices();
  const micId = mic || cfg.devices.mic || core.pickMic(devices)?.id;
  if (!micId) throw new Error('No microphone available.');

  const inst = new core.LiveSession(cfg, { title, mic: micId }, {
    onTranscript: (timeline) => mainWindow?.webContents.send('live:transcript', timeline),
    onSummary: (text) => mainWindow?.webContents.send('live:summary', text),
    onStatus: (msg) => status(msg),
    onAudioSource: (info) => mainWindow?.webContents.send('live:audio-source', info),
  });
  const info = await inst.start();
  liveSessionInstance = inst;
  return info;
});

ipcMain.handle('live:stop', async (_e, { insights } = {}) => {
  if (!liveSessionInstance) throw new Error('Not recording.');
  const inst = liveSessionInstance;
  liveSessionInstance = null;
  return inst.stop({ insights });
});

ipcMain.handle('live:cancel', async () => {
  if (!liveSessionInstance) return false;
  const inst = liveSessionInstance;
  liveSessionInstance = null;
  await inst.cancel();
  return true;
});
