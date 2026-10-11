const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jamus', {
  status: () => ipcRenderer.invoke('app:status'),
  listDevices: () => ipcRenderer.invoke('devices:list'),

  listAudioApps: () => ipcRenderer.invoke('audio:apps'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),

  listMeetings: () => ipcRenderer.invoke('meetings:list'),
  getMeeting: (id) => ipcRenderer.invoke('meeting:get', id),
  renameMeeting: (id, title) => ipcRenderer.invoke('meeting:rename', { id, title }),
  deleteAudio: (id) => ipcRenderer.invoke('audio:delete', id),
  deleteAllAudio: () => ipcRenderer.invoke('audio:deleteAll'),
  openTranscripts: () => ipcRenderer.invoke('open:transcripts'),

  startRecording: (opts) => ipcRenderer.invoke('record:start', opts),
  stopRecording: (opts) => ipcRenderer.invoke('record:stop', opts),
  cancelRecording: () => ipcRenderer.invoke('record:cancel'),

  generateInsights: (id) => ipcRenderer.invoke('insights:generate', id),

  importPick: () => ipcRenderer.invoke('import:pick'),
  importRun: (opts) => ipcRenderer.invoke('import:run', opts),
  openDropin: () => ipcRenderer.invoke('open:dropin'),

  liveStatus: () => ipcRenderer.invoke('live:status'),
  startLive: (opts) => ipcRenderer.invoke('live:start', opts),
  stopLive: (opts) => ipcRenderer.invoke('live:stop', opts),
  cancelLive: () => ipcRenderer.invoke('live:cancel'),

  onStatus: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('status', handler);
    return () => ipcRenderer.removeListener('status', handler);
  },
  onLiveTranscript: (cb) => {
    const handler = (_e, timeline) => cb(timeline);
    ipcRenderer.on('live:transcript', handler);
    return () => ipcRenderer.removeListener('live:transcript', handler);
  },
  onAudioSource: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on('live:audio-source', handler);
    return () => ipcRenderer.removeListener('live:audio-source', handler);
  },
  onLiveSummary: (cb) => {
    const handler = (_e, text) => cb(text);
    ipcRenderer.on('live:summary', handler);
    return () => ipcRenderer.removeListener('live:summary', handler);
  },
});
