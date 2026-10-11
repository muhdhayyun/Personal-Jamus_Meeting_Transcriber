const J = window.jamus;
const $ = (sel) => document.querySelector(sel);
const view = $('#view');
const statusBar = $('#statusBar');

// Apply the saved theme immediately to avoid a flash.
document.documentElement.dataset.theme = localStorage.getItem('jamus-theme') || 'light';
function applyTheme(t) {
  const theme = t === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('jamus-theme', theme);
  const btn = $('#themeBtn');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

let state = {
  meetings: [],
  activeId: null,
  recording: false,
  recTimer: null,
  recStart: 0,
  status: null,
  settings: null,
  liveTab: 'transcript',
  liveTimeline: [],
  liveSummary: '',
  liveUnsubs: [],
};

// ---------- helpers ----------
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function fmtDur(sec) {
  sec = Math.floor(sec || 0);
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
function inline(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>');
}

/** Render transcript/insights Markdown to HTML (with speaker-turn styling). */
function renderMarkdown(md, labels) {
  const me = labels?.me || 'Me';
  const lines = md.split(/\r?\n/);
  let html = '';
  let inList = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const turn = line.match(/^\*\*\[(.+?)\]\s+(.+?):\*\*\s*(.*)$/);
    if (turn) {
      closeList();
      const [, ts, who, txt] = turn;
      const cls = who === me ? 'me' : 'them';
      html += `<div class="turn"><span class="who ${cls}">${esc(who)}</span><span class="ts">${esc(ts)}</span><div class="txt">${inline(txt)}</div></div>`;
      continue;
    }
    if (/^###\s+/.test(line)) { closeList(); html += `<h3>${inline(line.replace(/^###\s+/, ''))}</h3>`; continue; }
    if (/^##\s+/.test(line)) { closeList(); html += `<h2>${inline(line.replace(/^##\s+/, ''))}</h2>`; continue; }
    if (/^#\s+/.test(line)) { closeList(); html += `<h1>${inline(line.replace(/^#\s+/, ''))}</h1>`; continue; }
    if (/^---+$/.test(line)) { closeList(); html += '<hr/>'; continue; }
    if (/^[-*]\s+/.test(line)) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`; continue; }
    if (line === '') { closeList(); continue; }
    closeList();
    html += `<p>${inline(line)}</p>`;
  }
  closeList();
  return html;
}

/** Render a live in-progress timeline ([{start,speaker,text}]) the same way the markdown turns look. */
function renderLiveTurns(timeline, labels) {
  const me = labels?.me || 'Me';
  if (!timeline.length) {
    return `<div class="live-placeholder">Listening… the transcript will appear here as people speak.</div>`;
  }
  return timeline.map((t) => {
    const cls = t.speaker === me ? 'me' : 'them';
    return `<div class="turn"><span class="who ${cls}">${esc(t.speaker)}</span><span class="ts">${esc(fmtDur(t.start))}</span><div class="txt">${inline(t.text)}</div></div>`;
  }).join('');
}

// ---------- data ----------
async function refreshMeetings() {
  state.meetings = await J.listMeetings();
  renderMeetingList();
}

function renderMeetingList() {
  const el = $('#meetingList');
  if (!state.meetings.length) {
    el.innerHTML = `<div style="color:var(--muted);font-size:12.5px;padding:10px 8px;">No meetings yet. Hit “New recording”.</div>`;
    return;
  }
  el.innerHTML = state.meetings.map((m) => `
    <div class="meeting-item ${m.id === state.activeId ? 'active' : ''}" data-id="${m.id}">
      <div class="mi-title">${esc(m.title)}</div>
      <div class="mi-meta">
        <span>${esc(m.date)}</span><span>·</span><span>${fmtDur(m.durationSec)}</span>
        ${m.hasInsights ? '<span class="badge">insights</span>' : m.hasTranscript ? '<span class="badge gray">transcript</span>' : ''}
      </div>
    </div>`).join('');
  el.querySelectorAll('.meeting-item').forEach((it) => it.addEventListener('click', () => openMeeting(it.dataset.id)));
}

// ---------- views ----------
function setStatus(msg) {
  if (!msg) { statusBar.classList.add('hidden'); return; }
  statusBar.textContent = msg;
  statusBar.classList.remove('hidden');
}

function renderEmpty() {
  state.activeId = null;
  renderMeetingList();
  const s = state.status;
  let warn = '';
  if (s) {
    const issues = [];
    if (!s.ffmpeg) issues.push('FFmpeg not found — install it (see README).');
    if (!s.whisperBuilt) issues.push('whisper.cpp not built — run <code>npm run build:whisper</code>.');
    if (!s.wasapiBuilt) issues.push('WASAPI recorder not built — run <code>npm run build:wasapi</code>.');
    if (issues.length) warn = `<div class="setup-warn"><strong>Setup needed:</strong><ul style="margin:6px 0 0 18px;">${issues.map((i) => `<li>${i}</li>`).join('')}</ul></div>`;
  }
  view.innerHTML = `${warn}
    <div class="empty">
      <div class="big">🎙️</div>
      <h2>Welcome to Jamus</h2>
      <p>Record a meeting and get a speaker-separated transcript — fully local.<br/>Your mic is “Me”, system audio is “Participants”.</p>
      <button class="btn primary" id="emptyRecord">＋ New recording</button>
    </div>`;
  $('#emptyRecord')?.addEventListener('click', openRecordPanel);
}

async function openRecordPanel() {
  state.activeId = null;
  renderMeetingList();
  const [devices, settings] = await Promise.all([
    J.listDevices().catch(() => []),
    J.getSettings().catch(() => state.settings),
  ]);
  state.settings = settings || state.settings;
  const mics = devices.filter((d) => !d.isLoopbackCandidate);
  const savedMic = state.settings?.devices?.mic;
  const today = new Date().toISOString().slice(0, 10);
  view.innerHTML = `
    <div style="max-width:520px;">
      <h1 style="font-size:22px;font-weight:700;margin-bottom:4px;">New recording</h1>
      <p style="color:var(--muted);font-size:13px;margin-bottom:20px;">System audio is captured automatically. Use headphones so your mic doesn't pick up the other speakers.</p>
      <div class="field">
        <label>Meeting title</label>
        <input type="text" id="recTitle" value="Meeting ${today}" />
      </div>
      <div class="field">
        <label>Microphone</label>
        <select id="recMic">${mics.map((m) => `<option value="${esc(m.id)}" ${m.id === savedMic ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
        ${mics.length ? '' : '<div class="hint" style="color:var(--warn)">No microphone detected.</div>'}
      </div>
      <div class="field" id="sysAudioField"></div>
      <button class="btn primary" id="startRec" data-mic-ok="${mics.length ? 'true' : 'false'}" ${mics.length ? '' : 'disabled'}>● Start recording</button>
    </div>`;
  $('#startRec')?.addEventListener('click', startRecording);
  startAudioPicker();
}

// ---------- system-audio source picker ----------
// Three modes: capture everything, capture ONLY one app, or block one app. The rule is saved
// the moment you change it, and the app list refreshes while this screen is open so the level
// meters show which app is actually making sound.
const SYS_MODES = [
  { id: 'all', label: 'Everything' },
  { id: 'only', label: 'Only one app' },
  { id: 'block', label: 'Block one app' },
];

function sysRule() {
  const sa = state.settings?.systemAudio || {};
  return { mode: sa.mode || 'all', process: sa.process || null };
}

async function saveSysRule(rule) {
  state.settings = { ...state.settings, systemAudio: rule };
  await J.saveSettings({ systemAudio: rule }).catch(() => {});
}

function startAudioPicker() {
  clearInterval(state.appPoll);
  state.apps = [];
  state.appsLoaded = false;
  paintAudioPicker();
  const tick = async () => {
    if (!$('#sysAudioField')) { clearInterval(state.appPoll); return; } // left this screen
    if (state.appPollBusy || sysRule().mode === 'all') return;
    state.appPollBusy = true;
    try {
      state.apps = await J.listAudioApps();
      state.appsError = null;
    } catch (e) {
      state.appsError = e.message;
    }
    state.appPollBusy = false;
    state.appsLoaded = true;
    paintAppList();
  };
  state.appPoll = setInterval(tick, 900);
  tick();
}

function paintAudioPicker() {
  const el = $('#sysAudioField');
  if (!el) return;
  const rule = sysRule();
  el.innerHTML = `
    <label>System audio</label>
    <div class="seg" role="radiogroup" aria-label="System audio source">
      ${SYS_MODES.map((m) => `<button type="button" class="seg-btn ${rule.mode === m.id ? 'active' : ''}" role="radio" aria-checked="${rule.mode === m.id}" data-sysmode="${m.id}">${m.label}</button>`).join('')}
    </div>
    <div id="sysAppList"></div>
    <div class="sys-summary" id="sysSummary"></div>`;
  el.querySelectorAll('[data-sysmode]').forEach((b) => b.addEventListener('click', async () => {
    await saveSysRule({ mode: b.dataset.sysmode, process: b.dataset.sysmode === 'all' ? rule.process : sysRule().process });
    paintAudioPicker();
    if (sysRule().mode !== 'all') startAudioPicker();
  }));
  paintAppList();
}

function paintAppList() {
  const list = $('#sysAppList');
  if (!list) return;
  const rule = sysRule();
  const summary = $('#sysSummary');
  const startBtn = $('#startRec');
  const micOk = !startBtn || startBtn.dataset.micOk !== 'false';

  if (rule.mode === 'all') {
    list.innerHTML = '';
    summary.className = 'sys-summary';
    summary.innerHTML = '🔊 Capturing everything you hear.';
    if (startBtn) startBtn.disabled = !micOk;
    return;
  }

  const apps = [...(state.apps || [])].sort((a, b) => (b.peak - a.peak) || a.label.localeCompare(b.label));
  const selected = rule.process;
  const running = apps.find((a) => a.name.toLowerCase() === (selected || '').toLowerCase());

  const rows = apps.map((a) => {
    const on = selected && a.name.toLowerCase() === selected.toLowerCase();
    const playing = a.peak > 0.003;
    const pct = Math.min(100, Math.round(Math.sqrt(a.peak) * 100));
    return `<button type="button" class="app-row ${on ? 'selected' : ''}" data-app="${esc(a.name)}">
      <span class="app-main"><span class="app-name">${esc(a.label)}</span><span class="app-proc">${esc(a.name)}</span></span>
      <span class="app-meter"><span class="app-meter-fill ${playing ? 'live' : ''}" style="width:${pct}%"></span></span>
      <span class="app-state ${playing ? 'live' : ''}">${playing ? 'Playing' : 'Silent'}</span>
    </button>`;
  });
  // The saved app may not be running right now — keep it visible so it's clear what's set.
  if (selected && !running) {
    rows.unshift(`<button type="button" class="app-row selected missing" data-app="${esc(selected)}">
      <span class="app-main"><span class="app-name">${esc(selected)}</span><span class="app-proc">not running</span></span>
      <span class="app-meter"></span><span class="app-state">Not running</span>
    </button>`);
  }
  list.innerHTML = rows.length
    ? rows.join('')
    : `<div class="hint">${state.appsError ? esc(state.appsError) : state.appsLoaded ? 'No apps with audio found. Start playing sound in the app, and it will appear here.' : 'Looking for apps…'}</div>`;
  list.querySelectorAll('[data-app]').forEach((b) => b.addEventListener('click', async () => {
    // Click the selected app again to clear it.
    const next = selected && b.dataset.app.toLowerCase() === selected.toLowerCase() ? null : b.dataset.app;
    await saveSysRule({ mode: rule.mode, process: next });
    paintAppList();
  }));

  const verb = rule.mode === 'only' ? 'Recording only' : 'Blocking';
  const need = rule.mode === 'only';
  if (!selected) {
    summary.className = 'sys-summary warn';
    summary.innerHTML = need ? '👆 Pick the app to record. Everything else will be ignored.' : '👆 Pick the app to block. Everything else is still recorded.';
  } else if (running) {
    summary.className = 'sys-summary ok';
    summary.innerHTML = rule.mode === 'only'
      ? `🎯 ${verb} <strong>${esc(running.label)}</strong>. Everything else you hear is ignored.`
      : `🔇 ${verb} <strong>${esc(running.label)}</strong>. Everything else is still recorded.`;
  } else {
    summary.className = 'sys-summary warn';
    summary.innerHTML = need
      ? `⚠ <strong>${esc(selected)}</strong> isn't running. Start it first, or pick another app. Recording is blocked until then.`
      : `⚠ <strong>${esc(selected)}</strong> isn't running, so nothing would be blocked. If it starts later, it will be recorded.`;
  }
  // "Only" needs a running app; "block" just needs a choice (a missing app only triggers the warning above).
  if (startBtn) startBtn.disabled = !micOk || !selected || (need && !running);
}

/** One line shown while recording: what system audio is being captured, confirmed by the recorder. */
function sourceBarHtml() {
  const rule = state.recRule || { mode: 'all', process: null };
  const att = state.audioSource;
  if (rule.mode === 'all') return '🔊 Capturing all system audio';
  if (att && att.attached === false) {
    return rule.mode === 'only'
      ? `⚠ <strong>${esc(rule.process)}</strong> isn't running`
      : `⚠ <strong>${esc(rule.process)}</strong> isn't running — nothing is being blocked, all system audio is recorded`;
  }
  if (att && att.attached) {
    return rule.mode === 'only'
      ? `🎯 Recording only <strong>${esc(rule.process)}</strong>`
      : `🔇 Blocking <strong>${esc(rule.process)}</strong> — everything else is recorded`;
  }
  return rule.mode === 'only' ? `🎯 Recording only ${esc(rule.process)}…` : `🔇 Blocking ${esc(rule.process)}…`;
}

function paintSourceBar() {
  const el = $('#recSource');
  if (!el) return;
  el.innerHTML = sourceBarHtml();
  el.classList.toggle('warn', /^⚠/.test(el.textContent));
}

async function startRecording() {
  const title = $('#recTitle').value.trim() || 'Untitled meeting';
  const mic = $('#recMic').value;
  $('#startRec').disabled = true;
  clearInterval(state.appPoll);
  state.recRule = sysRule();
  state.audioSource = null;
  setStatus('Starting…');
  try {
    await J.startLive({ title, mic });
  } catch (err) {
    setStatus(null);
    alert('Could not start recording:\n\n' + err.message);
    return openRecordPanel();
  }
  setStatus(null);
  state.recording = true;
  state.recStart = Date.now();
  state.liveTimeline = [];
  state.liveSummary = '';
  state.liveTab = 'transcript';
  renderRecording(title);
}

function renderRecording(title) {
  view.innerHTML = `
    <div class="recording-view">
      <div class="rec-header">
        <div class="pulse">●</div>
        <div class="timer" id="recTimerEl">00:00:00</div>
        <div class="rec-sub">Recording “${esc(title)}” — your mic + system audio</div>
        <div class="rec-source" id="recSource"></div>
        <div class="rec-actions">
          <button class="btn danger" id="stopRec">■ Stop &amp; finish</button>
          <button class="btn" id="cancelRec">Cancel</button>
        </div>
        <div class="tabs" style="margin:14px 0 0;">
          <div class="tab ${state.liveTab === 'transcript' ? 'active' : ''}" data-livetab="transcript"><span class="live-dot"></span>Live Transcript</div>
          <div class="tab ${state.liveTab === 'summary' ? 'active' : ''}" data-livetab="summary">Live Summary</div>
        </div>
      </div>
      <div class="rec-live" id="recLive"></div>
    </div>`;
  paintSourceBar();
  clearInterval(state.recTimer);
  state.recTimer = setInterval(() => {
    $('#recTimerEl').textContent = fmtDur((Date.now() - state.recStart) / 1000);
  }, 500);
  $('#stopRec').addEventListener('click', stopRecording);
  $('#cancelRec').addEventListener('click', cancelRecording);
  view.querySelectorAll('[data-livetab]').forEach((t) => t.addEventListener('click', () => {
    state.liveTab = t.dataset.livetab;
    view.querySelectorAll('[data-livetab]').forEach((x) => x.classList.toggle('active', x === t));
    paintLive();
  }));

  // Subscribe to live updates for the duration of this recording view.
  const labels = state.settings?.labels || { me: 'Me', participants: 'Participants' };
  state.liveUnsubs.push(J.onLiveTranscript((timeline) => { state.liveTimeline = timeline; if (state.liveTab === 'transcript') paintLive(); }));
  state.liveUnsubs.push(J.onLiveSummary((text) => { state.liveSummary = text; if (state.liveTab === 'summary') paintLive(); }));
  paintLive();

  function paintLive() {
    const el = $('#recLive');
    if (!el) return;
    if (state.liveTab === 'transcript') {
      el.innerHTML = `<div class="md">${renderLiveTurns(state.liveTimeline, labels)}</div>`;
    } else {
      el.innerHTML = state.liveSummary
        ? `<div class="md">${renderMarkdown(state.liveSummary, labels)}</div>`
        : `<div class="live-placeholder">Building a summary from the conversation so far — check back shortly.</div>`;
    }
  }
}

function unsubscribeLive() {
  state.liveUnsubs.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  state.liveUnsubs = [];
}

async function stopRecording() {
  clearInterval(state.recTimer);
  state.recording = false;
  $('#stopRec').disabled = true;
  $('#cancelRec').disabled = true;
  unsubscribeLive();
  const wantInsights = !!(state.settings?.groq?.enabled && state.settings?.groq?.apiKey);
  let result;
  try {
    result = await J.stopLive({ insights: wantInsights });
  } catch (err) {
    setStatus(null);
    alert('Finishing the recording failed:\n\n' + err.message);
    return renderEmpty();
  }
  setStatus(null);
  await refreshMeetings();
  if (result?.id) openMeeting(result.id);
}

async function cancelRecording() {
  clearInterval(state.recTimer);
  state.recording = false;
  unsubscribeLive();
  await J.cancelLive().catch(() => {});
  setStatus(null);
  renderEmpty();
}

async function openImport() {
  const picked = await J.importPick();
  if (!picked || !picked.length) return;
  const wantInsights = !!(state.settings?.groq?.enabled && state.settings?.groq?.apiKey);
  const stripExt = (n) => n.replace(/\.[^.]+$/, '');

  if (picked.length > 1) {
    if (!confirm(`Transcribe ${picked.length} files? Each becomes its own transcript, titled by filename.`)) return;
    setStatus('Importing…');
    let res;
    try { res = await J.importRun({ files: picked.map((f) => ({ path: f.path, title: stripExt(f.name) })), insights: wantInsights }); }
    catch (e) { setStatus(null); alert('Import failed:\n\n' + e.message); return renderEmpty(); }
    setStatus(null);
    await refreshMeetings();
    if (res?.ids?.length) openMeeting(res.ids[res.ids.length - 1]);
    return;
  }

  const f = picked[0];
  const defTitle = stripExt(f.name);
  state.activeId = null;
  renderMeetingList();
  view.innerHTML = `
    <div style="max-width:520px;">
      <h1 style="font-size:22px;font-weight:700;margin-bottom:4px;">Import recording</h1>
      <p style="color:var(--muted);font-size:13px;margin-bottom:20px;">${esc(f.name)} → transcribed as a single-speaker transcript.</p>
      <div class="field"><label>Title</label><input type="text" id="impTitle" value="${esc(defTitle)}" /></div>
      <button class="btn primary" id="impGo">Transcribe</button>
    </div>`;
  $('#impGo').addEventListener('click', async () => {
    $('#impGo').disabled = true;
    const title = $('#impTitle').value.trim() || defTitle;
    setStatus('Importing & transcribing…');
    let res;
    try { res = await J.importRun({ files: [{ path: f.path, title }], insights: wantInsights }); }
    catch (e) { setStatus(null); alert('Import failed:\n\n' + e.message); return renderEmpty(); }
    setStatus(null);
    await refreshMeetings();
    if (res?.ids?.[0]) openMeeting(res.ids[0]);
  });
}

async function openMeeting(id) {
  state.activeId = id;
  renderMeetingList();
  let data;
  try {
    data = await J.getMeeting(id);
  } catch (err) {
    return alert(err.message);
  }
  const { meeting, transcript, insights } = data;
  const labels = state.settings?.labels || { me: 'Me', participants: 'Participants' };
  renderDetail(meeting, transcript, insights, labels, 'transcript');
}

function renderDetail(meeting, transcript, insights, labels, tab) {
  const hasInsights = !!insights.trim();
  view.innerHTML = `
    <div class="detail-head">
      <div class="title-row">
        <h1>${esc(meeting.title)}</h1>
        <button class="icon-btn" id="renameBtn" title="Rename meeting">✎</button>
        ${meeting.hasAudio ? '<button class="icon-btn" id="delAudioBtn" title="Delete audio (keeps transcript)">🗑</button>' : ''}
      </div>
      <div class="detail-meta">
        <span>📅 ${esc(meeting.date)}</span>
        <span>⏱ ${fmtDur(meeting.durationSec)}</span>
        <span>${meeting.hasTranscript ? '📝 transcribed' : '⚠ not transcribed'}</span>
        <span>${meeting.hasAudio ? '🎵 audio kept' : '🎵 audio deleted'}</span>
      </div>
    </div>
    <div class="tabs">
      <div class="tab ${tab === 'transcript' ? 'active' : ''}" data-tab="transcript">Transcript</div>
      <div class="tab ${tab === 'insights' ? 'active' : ''}" data-tab="insights">Insights</div>
    </div>
    <div id="tabContent"></div>`;
  view.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    view.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    paintTab(t.dataset.tab, meeting, transcript, insights, labels);
  }));
  $('#renameBtn')?.addEventListener('click', () => startRename(meeting));
  $('#delAudioBtn')?.addEventListener('click', async () => {
    if (!confirm(`Delete the audio recording for “${meeting.title}”?\n\nThis frees disk space and keeps the transcript, but you won't be able to re-transcribe this meeting.`)) return;
    setStatus('Deleting audio…');
    await J.deleteAudio(meeting.id).catch((e) => alert(e.message));
    setStatus(null);
    await refreshMeetings();
    openMeeting(meeting.id);
  });
  paintTab(tab, meeting, transcript, insights, labels);
}

function startRename(meeting) {
  const head = document.querySelector('.detail-head');
  head.innerHTML = `<div class="rename-edit">
    <input id="renameInput" type="text" value="${esc(meeting.title)}" />
    <div class="actions"><button class="btn primary" id="renameSave">Save</button><button class="btn" id="renameCancel">Cancel</button></div>
  </div>`;
  const input = $('#renameInput');
  input.focus(); input.select();
  const save = async () => {
    const t = input.value.trim();
    if (!t) return;
    try { await J.renameMeeting(meeting.id, t); } catch (e) { return alert(e.message); }
    await refreshMeetings();
    openMeeting(meeting.id);
  };
  $('#renameSave').addEventListener('click', save);
  $('#renameCancel').addEventListener('click', () => openMeeting(meeting.id));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') openMeeting(meeting.id);
  });
}

function paintTab(tab, meeting, transcript, insights, labels) {
  const el = $('#tabContent');
  if (tab === 'transcript') {
    el.innerHTML = transcript.trim() ? `<div class="md">${renderMarkdown(transcript, labels)}</div>`
      : `<div class="insights-empty"><p>No transcript for this meeting.</p></div>`;
    return;
  }
  // insights tab
  if (insights.trim()) {
    el.innerHTML = `<div style="margin-bottom:12px;"><button class="btn" id="regen">↻ Regenerate</button></div><div class="md">${renderMarkdown(insights, labels)}</div>`;
  } else {
    const ready = !!(state.settings?.groq?.apiKey);
    el.innerHTML = `<div class="insights-empty">
      <p>No insights yet.</p>
      ${ready ? '' : '<p style="font-size:13px;">Add your Groq API key in <strong>Settings</strong> to enable insights.</p>'}
      <button class="btn primary" id="genIns" ${ready ? '' : 'disabled'}>✨ Generate insights</button>
    </div>`;
  }
  $('#genIns')?.addEventListener('click', () => doInsights(meeting.id));
  $('#regen')?.addEventListener('click', () => doInsights(meeting.id));
}

async function doInsights(id) {
  setStatus('Generating insights with Groq…');
  try {
    await J.generateInsights(id);
  } catch (err) {
    setStatus(null);
    return alert('Insights failed:\n\n' + err.message);
  }
  setStatus(null);
  await refreshMeetings();
  const data = await J.getMeeting(id);
  renderDetail(data.meeting, data.transcript, data.insights, state.settings?.labels, 'insights');
}

// ---------- settings ----------
async function openSettings() {
  state.settings = await J.getSettings();
  const s = state.settings;
  const st = state.status || {};
  const sections = s.groq?.sections || [];
  const sec = (k, label) => `<label class="check"><input type="checkbox" data-sec="${k}" ${sections.includes(k) ? 'checked' : ''}/> ${label}</label>`;
  const modelOpts = ['large-v3-turbo', 'large-v3', 'large-v2', 'medium.en', 'small.en', 'base.en', 'tiny.en']
    .map((m) => `<option value="${m}" ${s.model === m ? 'selected' : ''}>${m}</option>`).join('');
  $('#settingsBody').innerHTML = `
    <div class="section-title">Transcription</div>
    <div class="row">
      <div class="field"><label>Whisper model</label><select id="setModel">${modelOpts}</select></div>
      <div class="field"><label>Language</label><input type="text" id="setLang" value="${esc(s.language || 'auto')}" /></div>
    </div>
    <div class="row">
      <div class="field"><label>Your label</label><input type="text" id="setMe" value="${esc(s.labels?.me || 'Me')}" /></div>
      <div class="field"><label>Others label</label><input type="text" id="setOthers" value="${esc(s.labels?.participants || 'Participants')}" /></div>
    </div>
    <div class="field">
      <label>Break up long turns after (sentences)</label>
      <input type="number" id="setMaxSentences" min="1" max="50" value="${esc(s.maxSentencesPerTurn ?? 6)}" style="max-width:120px;" />
      <div class="hint">If one person talks for a while with no reply, the transcript starts a new paragraph after this many sentences instead of one long block.</div>
    </div>

    <div class="section-title">Storage</div>
    <div class="field">
      <label>Recording size cap (GB)</label>
      <input type="number" id="setCap" min="1" value="${esc(s.storage?.maxRecordingsGB ?? 20)}" />
      <div class="storage-bar"><div class="storage-fill" style="width:${st.storage ? Math.min(100, (st.storage.usedGB / (st.storage.capGB || 20)) * 100) : 0}%"></div></div>
      <div class="hint">${st.storage ? `Using ${st.storage.usedGB} GB of ${st.storage.capGB} GB. Oldest audio is cleared past the cap (transcripts kept).` : ''}</div>
      <button class="btn" id="delAllAudio" type="button" style="margin-top:10px;">🗑 Delete all recording audio</button>
      <div class="hint">Frees the most space. Transcripts &amp; insights are kept; meetings stay listed.</div>
    </div>

    <div class="section-title">System Audio</div>
    <div class="field">
      <div class="hint" style="margin:0;">Choose what Jamus hears (everything, only one app, or block one app) on the <strong>New recording</strong> screen, right before you record.</div>
    </div>

    <div class="section-title">Live Mode (while recording)</div>
    <div class="row">
      <div class="field">
        <label>Live summary provider</label>
        <select id="setLiveProvider">
          <option value="ollama" ${(s.live?.summaryProvider ?? 'ollama') === 'ollama' ? 'selected' : ''}>Ollama (local, free)</option>
          <option value="groq" ${s.live?.summaryProvider === 'groq' ? 'selected' : ''}>Groq (cloud)</option>
          <option value="off" ${s.live?.summaryProvider === 'off' ? 'selected' : ''}>Off</option>
        </select>
      </div>
      <div class="field"><label>Summary refresh (seconds)</label><input type="number" id="setLiveInterval" min="15" value="${esc(s.live?.summaryIntervalSec ?? 45)}" /></div>
    </div>
    <div class="row">
      <div class="field"><label>Ollama model</label><input type="text" id="setOllamaModel" value="${esc(s.live?.ollama?.model || 'llama3.1:8b')}" /></div>
      <div class="field"><label>Ollama URL</label><input type="text" id="setOllamaUrl" value="${esc(s.live?.ollama?.url || 'http://127.0.0.1:11434')}" /></div>
    </div>
    <div class="field"><label>Live segment length (seconds)</label><input type="number" id="setSegSeconds" min="5" max="60" value="${esc(s.live?.segmentSeconds ?? 12)}" />
      <div class="hint">Shorter = lower latency but slightly choppier sentence breaks; longer = smoother text, a bit more delay.</div>
    </div>

    <div class="section-title">AI Insights (Groq)</div>
    <div class="field toggle-row">
      <label style="margin:0;">Auto-generate insights after each meeting</label>
      <input type="checkbox" id="setGroqEnabled" ${s.groq?.enabled ? 'checked' : ''} />
    </div>
    <div class="field">
      <label>Groq API key</label>
      <input type="password" id="setGroqKey" value="${esc(s.groq?.apiKey || '')}" placeholder="gsk_..." />
      <div class="hint">Stored locally in ~/.jamus/config.json. Get a free key at console.groq.com. Note: the transcript is sent to Groq's servers.</div>
    </div>
    <div class="field"><label>Groq model</label><input type="text" id="setGroqModel" value="${esc(s.groq?.model || 'llama-3.3-70b-versatile')}" /></div>
    <div class="field">
      <label>Insights sections</label>
      <div class="checks">
        ${sec('summary', 'Summary')} ${sec('actionItems', 'Action items')} ${sec('keyDecisions', 'Key decisions')} ${sec('topicsQuestions', 'Topics & open questions')}
      </div>
    </div>`;
  $('#delAllAudio')?.addEventListener('click', async () => {
    if (!confirm("Delete the audio (.wav) for ALL meetings?\n\nFrees the most space. Transcripts and insights are kept and meetings stay listed, but you won't be able to re-transcribe any of them.")) return;
    const r = await J.deleteAllAudio().catch((e) => { alert(e.message); return null; });
    if (!r) return;
    alert(`Deleted audio from ${r.count} file(s) — freed ${(r.freed / 1024 / 1024 / 1024).toFixed(2)} GB.`);
    state.status = await J.status().catch(() => state.status);
    await refreshMeetings();
    openSettings(); // re-render with updated usage
  });
  $('#settingsSaved').textContent = '';
  $('#settingsModal').classList.remove('hidden');
}

async function saveSettings() {
  const sections = [...document.querySelectorAll('[data-sec]')].filter((c) => c.checked).map((c) => c.dataset.sec);
  const partial = {
    model: $('#setModel').value,
    language: $('#setLang').value.trim() || 'auto',
    labels: { me: $('#setMe').value.trim() || 'Me', participants: $('#setOthers').value.trim() || 'Participants' },
    maxSentencesPerTurn: Number($('#setMaxSentences').value) || 6,
    storage: { maxRecordingsGB: Number($('#setCap').value) || 20 },
    live: {
      summaryProvider: $('#setLiveProvider').value,
      summaryIntervalSec: Number($('#setLiveInterval').value) || 45,
      segmentSeconds: Number($('#setSegSeconds').value) || 12,
      ollama: {
        model: $('#setOllamaModel').value.trim() || 'llama3.1:8b',
        url: $('#setOllamaUrl').value.trim() || 'http://127.0.0.1:11434',
      },
    },
    groq: {
      enabled: $('#setGroqEnabled').checked,
      apiKey: $('#setGroqKey').value.trim(),
      model: $('#setGroqModel').value.trim() || 'llama-3.3-70b-versatile',
      sections,
    },
  };
  await J.saveSettings(partial);
  state.settings = await J.getSettings();
  $('#settingsSaved').textContent = 'Saved ✓';
  setTimeout(() => { $('#settingsModal').classList.add('hidden'); }, 600);
}

// ---------- wire up ----------
$('#recordBtn').addEventListener('click', () => (state.recording ? null : openRecordPanel()));
$('#importBtn').addEventListener('click', () => (state.recording ? null : openImport()));
$('#refreshBtn').addEventListener('click', refreshMeetings);
$('#settingsBtn').addEventListener('click', openSettings);
$('#themeBtn').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
applyTheme(document.documentElement.dataset.theme); // sync the toggle icon
$('#settingsClose').addEventListener('click', () => $('#settingsModal').classList.add('hidden'));
$('#settingsSave').addEventListener('click', saveSettings);

J.onAudioSource((info) => { state.audioSource = info; paintSourceBar(); });

J.onStatus((msg) => setStatus(msg && msg !== 'Done.' ? msg : null));

(async function init() {
  state.settings = await J.getSettings().catch(() => null);
  state.status = await J.status().catch(() => null);
  await refreshMeetings();
  renderEmpty();
})();
