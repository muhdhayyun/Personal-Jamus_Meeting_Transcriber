// Hard-coded stand-in for the Electron preload bridge (electron/preload.cjs).
//
// The real renderer (electron/renderer/renderer.js) talks to `window.jamus`. In the desktop app
// that's backed by the Whisper/WASAPI engine; here it's backed by fictional, hard-coded data so
// the exact same UI can run in a browser as a no-install demo. Nothing is recorded or uploaded.
//
// KEEP IN SYNC with electron/preload.cjs: every method exposed there needs a counterpart here.
(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (sec) => `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(Math.floor(sec % 60))}`;

  // ---- tiny event bus for the push-style callbacks (onStatus, onLiveTranscript, ...) ----------
  const listeners = { status: [], transcript: [], summary: [], audioSource: [] };
  const on = (kind) => (cb) => {
    listeners[kind].push(cb);
    return () => { listeners[kind] = listeners[kind].filter((f) => f !== cb); };
  };
  const emit = (kind, payload) => listeners[kind].slice().forEach((f) => f(payload));

  // ---- settings (kept in memory + localStorage so toggles survive a refresh) -----------------
  const DEFAULT_SETTINGS = {
    model: 'large-v3-turbo',
    language: 'auto',
    labels: { me: 'Me', participants: 'Participants' },
    devices: { mic: 'Demo Microphone', system: 'wasapi' },
    maxSentencesPerTurn: 6,
    storage: { maxRecordingsGB: 20 },
    groq: { enabled: false, apiKey: '', model: 'llama-3.3-70b-versatile', sections: ['summary', 'actionItems', 'keyDecisions', 'topicsQuestions'] },
    live: { enabled: true, segmentSeconds: 12, summaryProvider: 'ollama', summaryIntervalSec: 45, ollama: { model: 'llama3.1:8b', url: 'http://127.0.0.1:11434' } },
    systemAudio: { mode: 'all', process: null },
  };
  const merge = (a, b) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b || {})) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a[k] || {}, v) : v;
    }
    return out;
  };
  let settings = DEFAULT_SETTINGS;
  try { settings = merge(DEFAULT_SETTINGS, JSON.parse(localStorage.getItem('jamus-demo-settings') || '{}')); } catch { /* storage blocked */ }

  // ---- fictional meetings --------------------------------------------------------------------
  const turn = (t, who, text) => `**[${stamp(t)}] ${who}:** ${text}`;
  const transcriptMd = (title, date, dur, turns) =>
    [`# ${title}`, '', `- **Date:** ${date}`, `- **Duration:** ${stamp(dur)}`, '- **Model:** large-v3-turbo', '- **Speakers:** Me, Participants', '', '---', '', ...turns.flatMap((t) => [turn(...t), ''])].join('\n');

  const meetings = [
    {
      id: 'demo-product-sync', title: 'Weekly product sync', date: '2026-10-08', startedAt: '2026-10-08T09:00:00Z',
      durationSec: 754, hasAudio: true,
      transcript: transcriptMd('Weekly product sync', '2026-10-08', 754, [
        [3, 'Me', 'Okay, let’s start with the onboarding numbers. Did the new checklist move the activation rate?'],
        [11, 'Participants', 'It did. Activation went from 41 percent to 52 percent over the last two weeks, mostly because people finish the first project.'],
        [29, 'Me', 'That’s bigger than I expected. Is it consistent across both signup sources?'],
        [38, 'Participants', 'Mostly. Referral signups improved more than organic ones, so we should double-check that before calling it a win.'],
        [61, 'Me', 'Agreed. Let’s keep the experiment running another week. What’s blocking the mobile release?'],
        [74, 'Participants', 'Two things: the push notification permission screen, and a layout bug on smaller Android phones. Design has a fix for the second one.'],
        [102, 'Me', 'Then I’ll own the notification copy, and we ship on Thursday if the Android fix lands by Wednesday night.'],
        [118, 'Participants', 'Works for me. I’ll send the fix for review tomorrow morning.'],
      ]),
      insights: [
        '## Summary', 'The new onboarding checklist lifted activation from 41% to 52%. The team will extend the experiment one more week to confirm the effect holds across signup sources, and is aiming to ship the mobile release on Thursday.', '',
        '## Action items', '- **Me:** write the push-notification permission copy.', '- **Participants:** send the small-screen Android layout fix for review tomorrow morning.', '',
        '## Key decisions', '- Keep the onboarding experiment running one more week.', '- Ship the mobile release Thursday, provided the Android fix lands by Wednesday night.', '',
        '## Topics & open questions', '- Why referral signups improved more than organic ones.', '- Whether the activation gain holds beyond two weeks.',
      ].join('\n'),
    },
    {
      id: 'demo-customer-interview', title: 'Customer interview: onboarding flow', date: '2026-10-06', startedAt: '2026-10-06T14:30:00Z',
      durationSec: 1180, hasAudio: true,
      transcript: transcriptMd('Customer interview: onboarding flow', '2026-10-06', 1180, [
        [5, 'Me', 'Thanks for making time. Could you walk me through what you did when you first opened the app?'],
        [16, 'Participants', 'I skipped the tutorial, honestly. I clicked around until I found where to import my spreadsheet.'],
        [34, 'Me', 'What made you skip it?'],
        [41, 'Participants', 'It looked long. If it had a progress bar or told me it was two minutes, I probably would have stayed.'],
        [67, 'Me', 'That’s useful. Was there a point where you felt stuck?'],
        [76, 'Participants', 'Yes, the column mapping. I wasn’t sure which of my columns was the date and the preview didn’t help.'],
        [105, 'Me', 'So a clearer preview would help more than extra instructions.'],
        [113, 'Participants', 'Exactly. Show me what the result will look like before I commit.'],
      ]),
      insights: [
        '## Summary', 'The customer skipped the tutorial because it looked long, then got stuck mapping spreadsheet columns. A time estimate on the tutorial and a clearer preview of the imported data would likely have kept them engaged.', '',
        '## Action items', '- Add a time estimate or progress bar to the tutorial.', '- Improve the column-mapping preview so the result is visible before confirming.', '',
        '## Key decisions', '- Prioritise the import preview over adding more tutorial content.', '',
        '## Topics & open questions', '- Does a shorter tutorial change the skip rate?', '- Which columns do users most often mis-map?',
      ].join('\n'),
    },
    {
      id: 'demo-study-group', title: 'Study group: RNN revision', date: '2026-10-03', startedAt: '2026-10-03T18:00:00Z',
      durationSec: 905, hasAudio: false,
      transcript: transcriptMd('Study group: RNN revision', '2026-10-03', 905, [
        [4, 'Me', 'Quick recap: why do plain RNNs struggle with long sequences?'],
        [12, 'Participants', 'Vanishing gradients. The signal from early steps shrinks as it’s multiplied through every time step during backpropagation.'],
        [33, 'Me', 'And that’s what LSTM gates are meant to fix, right?'],
        [40, 'Participants', 'Right. The cell state gives gradients a more direct path, and the gates decide what to keep or forget.'],
        [71, 'Me', 'Okay. And where do GRUs sit compared to that?'],
        [79, 'Participants', 'Fewer gates, fewer parameters, often similar accuracy. A good default when you want something lighter.'],
      ]),
      insights: '',
    },
  ];

  // ---- the "live" demo conversation ----------------------------------------------------------
  const LIVE_SCRIPT = [
    [2, 'Me', 'Alright, let’s kick off. The goal today is to agree on what goes into the beta launch.'],
    [8, 'Participants', 'Sounds good. I think we have to include the sharing feature, otherwise testers can’t collaborate.'],
    [17, 'Me', 'Fair. How much work is it to get sharing stable?'],
    [23, 'Participants', 'About a week if we limit it to read-only links first and add editing later.'],
    [34, 'Me', 'Read-only first works. What about the billing page?'],
    [40, 'Participants', 'Beta is free, so I’d cut billing from this release entirely.'],
    [49, 'Me', 'Agreed, let’s cut billing and revisit it after the beta.'],
    [57, 'Participants', 'One risk: the import tool still fails on very large files. We should at least show a clear error.'],
    [68, 'Me', 'Good call. I’ll take the error message, and you take read-only sharing.'],
    [76, 'Participants', 'Deal. Let’s aim for a build to testers in two weeks.'],
  ];
  const LIVE_SUMMARIES = [
    [3, '## Live summary\n- The team is deciding what goes into the beta launch.\n- Read-only sharing is proposed as the collaboration feature.'],
    [6, '## Live summary\n- Beta scope: read-only sharing is in, editing comes later.\n- Billing is being cut from this release.'],
    [10, '## Live summary\n- **Scope:** read-only sharing in; billing cut until after the beta.\n- **Risk:** import fails on very large files, so show a clear error.\n- **Owners:** Me — error message; Participants — read-only sharing.\n- **Target:** build to testers in two weeks.'],
  ];

  let live = null; // { title, startedAt, timer, shown }

  // ---- which apps are "making sound" (animated so the picker's level meters move) -------------
  const APPS = [
    { name: 'Spotify.exe', label: 'Spotify', base: 0.55, rhythm: 1.7 },
    { name: 'ms-teams.exe', label: 'Microsoft Teams', base: 0.4, rhythm: 0.9 },
    { name: 'chrome.exe', label: 'Google Chrome', base: 0.25, rhythm: 0.5 },
    { name: 'Discord.exe', label: 'Discord', base: 0, rhythm: 1 },
  ];
  const appLevels = () => {
    const t = Date.now() / 1000;
    return APPS.map((a) => {
      const wave = a.base ? Math.max(0, a.base * (0.55 + 0.45 * Math.sin(t * a.rhythm) * Math.sin(t * 2.3 + a.rhythm)) ) : 0;
      return { name: a.name, label: a.label, pids: [1000 + a.name.length], active: a.base > 0, peak: +wave.toFixed(4) };
    });
  };

  const find = (id) => meetings.find((m) => m.id === id);
  const view = (m) => ({
    id: m.id, title: m.title, date: m.date, startedAt: m.startedAt, durationSec: m.durationSec,
    hasAudio: m.hasAudio, hasTranscript: true, hasInsights: !!m.insights,
  });
  const fakeInsights = (title) => [
    '## Summary', `Key points from “${title}”, generated for the demo.`, '',
    '## Action items', '- Follow up on the open items discussed.', '',
    '## Key decisions', '- Decisions made in the meeting appear here.', '',
    '## Topics & open questions', '- Open questions raised during the discussion.',
  ].join('\n');
  const addMeeting = (m) => { meetings.unshift(m); return m; };
  const today = () => new Date().toISOString().slice(0, 10);

  function startLiveTimers() {
    const timeline = [];
    const sampleTimer = setInterval(() => {
      const t = (Date.now() - live.startedAt) / 1000;
      let changed = false;
      while (live.shown < LIVE_SCRIPT.length && LIVE_SCRIPT[live.shown][0] <= t) {
        const [start, speaker, text] = LIVE_SCRIPT[live.shown++];
        timeline.push({ start, speaker, text });
        changed = true;
      }
      if (changed) {
        live.timeline = timeline.slice();
        emit('transcript', live.timeline);
        const s = LIVE_SUMMARIES.filter(([n]) => n <= live.shown).pop();
        if (s && s[1] !== live.lastSummary) { live.lastSummary = s[1]; emit('summary', s[1]); }
      }
    }, 500);
    live.timer = sampleTimer;
  }

  window.jamus = {
    status: async () => ({ platform: 'win32', ffmpeg: true, whisperBuilt: true, wasapiBuilt: true, modelDownloaded: true, model: settings.model, storage: { usedGB: 3.4, capGB: settings.storage.maxRecordingsGB } }),
    listDevices: async () => [
      { id: 'Demo Microphone', name: 'Demo Microphone (USB)', isLoopbackCandidate: false },
      { id: 'Laptop Array Mic', name: 'Laptop Array Microphone', isLoopbackCandidate: false },
      { id: 'Speakers Loopback', name: 'Speakers (loopback)', isLoopbackCandidate: true },
    ],
    listAudioApps: async () => { await sleep(60); return appLevels(); },

    getSettings: async () => JSON.parse(JSON.stringify(settings)),
    saveSettings: async (partial) => {
      settings = merge(settings, partial);
      try { localStorage.setItem('jamus-demo-settings', JSON.stringify(settings)); } catch { /* storage blocked */ }
      return true;
    },

    listMeetings: async () => meetings.map(view),
    getMeeting: async (id) => {
      const m = find(id);
      if (!m) throw new Error('Meeting not found.');
      return { meeting: view(m), transcript: m.transcript, insights: m.insights || '' };
    },
    renameMeeting: async (id, title) => { const m = find(id); if (m) { m.title = title; m.transcript = m.transcript.replace(/^# .*/, '# ' + title); } return true; },
    deleteAudio: async (id) => { const m = find(id); if (m) m.hasAudio = false; return { freed: 0, count: 0 }; },
    deleteAllAudio: async () => { meetings.forEach((m) => { m.hasAudio = false; }); return { freed: 3.4 * 1024 * 1024 * 1024, count: meetings.length }; },
    openTranscripts: async () => true,

    // Batch recording isn't used by the UI (live mode is), but keep the bridge complete.
    startRecording: async () => ({}),
    stopRecording: async () => ({}),
    cancelRecording: async () => true,

    generateInsights: async (id) => {
      emit('status', 'Generating insights…');
      await sleep(1400);
      const m = find(id);
      if (m && !m.insights) m.insights = fakeInsights(m.title);
      emit('status', null);
      return true;
    },

    importPick: async () => [{ name: 'Product-demo-call.mp3', path: 'demo://sample' }],
    importRun: async ({ files }) => {
      emit('status', 'Importing & transcribing…');
      await sleep(1800);
      const f = files[0];
      const m = addMeeting({
        id: 'demo-import-' + Date.now(), title: f.title, date: today(), startedAt: new Date().toISOString(), durationSec: 312, hasAudio: true, insights: '',
        transcript: transcriptMd(f.title, today(), 312, [
          [2, 'Speaker', 'Welcome everyone. Today I’ll walk through the new dashboard and what changed this quarter.'],
          [19, 'Speaker', 'The biggest update is the live filters, which let you slice results without leaving the page.'],
          [44, 'Speaker', 'Imported audio is transcribed as a single speaker, since there is only one audio source to work from.'],
        ]),
      });
      emit('status', null);
      return { ids: [m.id] };
    },
    openDropin: async () => true,

    liveStatus: async () => ({ enabled: true, provider: 'ollama', ollamaOk: true, segmentSeconds: 12 }),
    startLive: async ({ title }) => {
      if (live) throw new Error('Already recording.');
      live = { title, startedAt: Date.now(), shown: 0, timeline: [], lastSummary: '' };
      startLiveTimers();
      // Mirror the real recorder's "did the app attach?" report (see wasapiCapture.js).
      const rule = settings.systemAudio || { mode: 'all', process: null };
      if (rule.mode !== 'all' && rule.process) {
        setTimeout(() => emit('audioSource', { mode: rule.mode === 'only' ? 'include' : 'exclude', target: rule.process, attached: true, pid: 4242 }), 350);
      }
      await sleep(300);
      return { id: 'demo-live', title };
    },
    stopLive: async ({ insights } = {}) => {
      if (!live) throw new Error('Not recording.');
      const l = live; live = null; clearInterval(l.timer);
      emit('status', 'Finishing transcript…');
      await sleep(1200);
      const dur = Math.max(30, Math.round((Date.now() - l.startedAt) / 1000));
      const turns = (l.timeline.length ? l.timeline : LIVE_SCRIPT.slice(0, 3).map(([start, who, text]) => ({ start, speaker: who, text })))
        .map((t) => [t.start, t.speaker, t.text]);
      const m = addMeeting({
        id: 'demo-live-' + Date.now(), title: l.title, date: today(), startedAt: new Date().toISOString(), durationSec: dur, hasAudio: true,
        transcript: transcriptMd(l.title, today(), dur, turns), insights: insights ? fakeInsights(l.title) : '',
      });
      emit('status', null);
      return { id: m.id };
    },
    cancelLive: async () => { if (live) { clearInterval(live.timer); live = null; } return true; },

    onStatus: on('status'),
    onLiveTranscript: on('transcript'),
    onLiveSummary: on('summary'),
    onAudioSource: on('audioSource'),
  };
})();
