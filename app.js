/* ============================================================================
   app.js: the workshop board.

   One page, three ways to run it, one state object.

   1. Published as a claude.ai Artifact: `claude.use("sample")` is the AI
      brain (no API key), `claude.use("mcp")` reaches the Wispr Flow
      connector for the live transcript, `claude.use("db")` shares the
      register with everyone in the room, `claude.use("downloads")` saves
      the Excel export.
   2. Standalone (GitHub Pages, Vercel, a local file): an Anthropic API key
      in Settings, transcript via Wispr Flow dictation, the browser mic, a
      paste, or a JSON feed URL. localStorage keeps the state.
   3. Demo: a scripted transcript plays in so the whole loop can be tested
      before the room exists.

   Every capability is probed, never assumed. Absence degrades a feature; it
   never breaks the page.
   ========================================================================== */
(function () {
  'use strict';

  var SEED = window.SEED;
  var CFG = SEED;                      /* the active workshop template; swapped when a workshop loads */
  var MODE = { sb: false, role: 'local' }; /* 'local' | 'facilitator' | 'participant' */
  var SBA = function () { return !!(window.SB && SB.active); };
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var now = function () { return Date.now(); };
  var uid = function () { return Math.random().toString(36).slice(2, 9); };

  /* ------------------------------------------------------------- state -- */
  var DEFAULT_SETTINGS = {
    apiKey: '', model: 'claude-opus-5', pollSec: 60, minChars: 220,
    wisprMeetingId: '', wisprPollSec: 45, feedUrl: '', feedPollSec: 30,
    autoExtract: true, theme: '', facilitatorName: 'Facilitator'
  };

  var S = {
    opportunities: [], systems: JSON.parse(JSON.stringify(CFG.systems)),
    secondAI: [], revealed: false,
    agendaIdx: -1, blockDone: {},
    timer: { running: false, startedAt: 0, elapsedBefore: 0 },
    transcript: [], consumedChars: 0,
    settings: Object.assign({}, DEFAULT_SETTINGS),
    updatedAt: 0
  };

  var CAP = { sample: null, mcp: null, db: null, downloads: null, probed: false };
  var UI = { view: 'runsheet', opsMode: 'cards', filter: { fn: 'All', status: 'All', q: '' }, present: false, seq: 0 };
  var RUN = { extracting: false, speech: null, wisprTimer: null, feedTimer: null, extractTimer: null, demoTimer: null, demoIdx: 0, lastCount: 0, source: 'none', log: [] };

  /* ------------------------------------------------------ persistence -- */
  var SHARED_KEYS = ['opportunities', 'systems', 'secondAI', 'revealed', 'agendaIdx', 'blockDone', 'updatedAt'];
  function save() {
    S.updatedAt = now();
    if (SBA()) { try { localStorage.setItem('wos.settings', JSON.stringify(S.settings)); } catch (e) {} return; }
    try {
      var local = {}; Object.keys(S).forEach(function (k) { local[k] = S[k]; });
      localStorage.setItem('wos.state', JSON.stringify(local));
    } catch (e) { log('localStorage unavailable: ' + e.message); }
    scheduleDbWrite();
  }
  function load() {
    try {
      var raw = localStorage.getItem('wos.state');
      if (!raw) return;
      var o = JSON.parse(raw);
      Object.keys(o).forEach(function (k) { if (k in S) S[k] = o[k]; });
      S.settings = Object.assign({}, DEFAULT_SETTINGS, o.settings || {});
    } catch (e) { log('Could not load saved state: ' + e.message); }
    try { var st = localStorage.getItem('wos.settings'); if (st) S.settings = Object.assign({}, DEFAULT_SETTINGS, S.settings, JSON.parse(st)); } catch (e) {}
  }

  var dbWriteT = null, dbPending = false;
  function scheduleDbWrite() {
    if (!CAP.db) return;
    clearTimeout(dbWriteT);
    dbWriteT = setTimeout(function () {
      var body = {}; SHARED_KEYS.forEach(function (k) { body[k] = S[k]; });
      dbPending = true;
      CAP.db.doc('workshop/board').set(body).then(function () { dbPending = false; })
        .catch(function (e) { dbPending = false; log('db write failed: ' + (e && e.code)); });
    }, 900);
  }
  function subscribeDb() {
    if (!CAP.db) return;
    CAP.db.doc('workshop/board').onSnapshot(function (snap) {
      if (!snap.exists || snap.metadata.hasPendingWrites || dbPending) return;
      var d = snap.data();
      if (!d || !(d.updatedAt > S.updatedAt)) return;
      SHARED_KEYS.forEach(function (k) { if (k in d) S[k] = d[k]; });
      try { localStorage.setItem('wos.state', JSON.stringify(S)); } catch (e) {}
      render(); updateBadge();
    }, function (e) { log('db subscription ended: ' + (e && e.code)); });
  }

  /* ------------------------------------------------------- capabilities -- */
  function probeCapabilities() {
    if (!(window.claude && typeof window.claude.use === 'function')) { CAP.probed = true; setModeStatus(); return Promise.resolve(); }
    var names = ['sample', 'mcp', 'db', 'downloads'];
    return Promise.all(names.map(function (n) {
      return Promise.resolve(window.claude.use(n)).then(function (ns) { CAP[n] = ns || null; }).catch(function () { CAP[n] = null; });
    })).then(function () {
      CAP.probed = true; setModeStatus();
      if (CAP.db) subscribeDb();
      if (UI.view === 'settings' || UI.view === 'live') render();
    });
  }
  function isArtifact() { return !!(CAP.sample || CAP.mcp || CAP.db); }
  function serverAI() { return SBA() && SB.cfg && !!SB.cfg.serverAI; }
  function aiAvailable() { return !!(CAP.sample || serverAI() || (S.settings.apiKey && S.settings.apiKey.length > 10)); }
  function setModeStatus() {
    var bits = [];
    if (SBA()) bits.push((SB.org ? SB.org.name : 'Workshop') + ' · ' + (SB.role || 'member')); else bits.push(isArtifact() ? 'Artifact' : 'Standalone');
    bits.push(CAP.sample ? 'AI via Claude' : serverAI() ? 'AI via server' : (S.settings.apiKey ? 'AI via API key' : 'AI off'));
    if (CAP.db) bits.push('shared');
    $('#modeStatus').textContent = bits.join(' · ');
    setAiStatus(RUN.extracting ? 'busy' : (aiAvailable() ? 'idle' : 'off'));
  }
  function setAiStatus(state, text) {
    var dot = $('#aiDot');
    dot.className = 'dot' + (state === 'busy' ? ' dot--busy' : state === 'live' ? ' dot--live' : state === 'bad' ? ' dot--bad' : '');
    $('#aiStatus').textContent = text || ({ busy: 'AI reading…', live: 'AI listening', idle: 'AI ready', off: (SBA() ? 'AI off: server key missing, see Settings' : 'AI off: add a key or publish as an Artifact'), bad: 'AI error, see Live' })[state];
  }
  function setSrcStatus(state, text) {
    var dot = $('#srcDot');
    dot.className = 'dot' + (state === 'live' ? ' dot--live' : state === 'bad' ? ' dot--bad' : '');
    $('#srcStatus').textContent = text;
  }
  function log(msg) {
    var line = new Date().toLocaleTimeString('en-AU', { hour12: false }) + '  ' + msg;
    RUN.log.unshift(line); if (RUN.log.length > 80) RUN.log.length = 80;
    var el = $('#liveLog'); if (el) el.textContent = RUN.log.join('\n');
  }

  /* --------------------------------------------------------- transcript -- */
  /* Pasting the whole transcript again is the normal way to feed the board:
     keep only the part after what we already hold. */
  function trimOverlap(text) {
    var norm = function (x) { return String(x).replace(/\s+/g, ' ').trim(); };
    var all = norm(fullTranscript()), t = norm(text);
    if (!all || !t) return text;
    if (all.indexOf(t) >= 0) return '';
    var tail = all.slice(-1500);
    for (var n = Math.min(tail.length, t.length); n >= 60; n -= 20) {
      var probe = tail.slice(-n), i = t.indexOf(probe);
      if (i >= 0) return t.slice(i + n).trim();
    }
    return text;
  }
  function addTranscript(text, src) {
    text = String(text || '').trim();
    if (src !== 'demo' && src !== 'feed') text = trimOverlap(text);
    if (!text) { toast('Nothing new in that paste'); return; }
    S.transcript.push({ t: now(), text: text, src: src || 'manual' });
    if (S.transcript.length > 2000) S.transcript.shift();
    save();
    if (SBA()) SB.addTranscript(text, src || 'manual').catch(function () {});
    var feed = $('#feed');
    if (feed) { feed.insertAdjacentHTML('beforeend', feedItem(S.transcript[S.transcript.length - 1], true)); feed.scrollTop = feed.scrollHeight; }
    updateTiles();
    if (S.settings.autoExtract) scheduleExtract();
  }
  function fullTranscript() { return S.transcript.map(function (c) { return c.text; }).join('\n'); }
  function feedItem(c, isNew) {
    return '<div class="feed__item' + (isNew ? ' new' : '') + '"><time>' + new Date(c.t).toLocaleTimeString('en-AU', { hour12: false }) + ' · ' + esc(c.src) + '</time>' + esc(c.text) + '</div>';
  }

  /* ----------------------------------------------------------------- AI -- */
  var SCHEMA = {
    type: 'object', additionalProperties: false, required: ['opportunities'],
    properties: { opportunities: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['title', 'function', 'phase', 'surface', 'build', 'pain', 'direction', 'systems', 'quote', 'raisedBy', 'confidence'],
      properties: {
        title: { type: 'string' }, function: { type: 'string', enum: CFG.functionsTags },
        phase: { type: 'string' }, surface: { type: 'string', enum: CFG.surfaces.map(function (s) { return s.key; }) },
        build: { type: 'string', enum: CFG.buildTypes }, pain: { type: 'string' }, direction: { type: 'string' },
        systems: { type: 'array', items: { type: 'string' } }, quote: { type: 'string' }, raisedBy: { type: 'string' },
        confidence: { type: 'string', enum: ['High', 'Medium', 'Low'] }
      } } } }
  };

  function contextBlock() {
    return [
      'CLIENT: ' + CFG.client.name + ' (luxury watch and jewellery retail, UK listed). Workshop with eight people from Finance and Purchasing.',
      'NORTH STAR: ' + CFG.client.northStar + '.',
      'SCOPE: ' + CFG.client.scopeCriterion,
      'SYSTEMS IN PLAY: ' + S.systems.map(function (s) { return s.name + ' (' + s.category + ', connector: ' + s.connector + ')'; }).join('; ') + '.',
      'PROCESS PHASES (use these names exactly for "phase"): ' + CFG.phases.map(function (p) { return p.name; }).join(' | ') + '.',
      'CLAUDE SURFACES (pick one for "surface"): ' + CFG.surfaces.map(function (s) { return s.key + ' = ' + s.tell; }).join('; ') + '.',
      'BUILD TYPES: Skill = a written procedure Claude follows on demand; Scheduled task = a prompt that runs on a timer with connectors; Setup = connect a system or load a Project; Project = a standing context with instructions and files; Workflow redesign = the human steps change, Claude carries a stage.'
    ].join('\n');
  }

  function extractPrompt(windowText, existingTitles) {
    return [
      'You are listening to a live ideation workshop. Your job: spot moments where Claude could give this team hours back, and describe the concrete thing to build.',
      contextBlock(),
      'RULES:',
      '- Only propose when a real task, pain, volume or repeated artefact was actually stated in the transcript window. Never invent.',
      '- Do not repeat anything already on the board. Existing titles: ' + (existingTitles.length ? existingTitles.join(' | ') : '(none yet)') + '.',
      '- Prefer specific over generic. "Triage the AP mailbox every morning" beats "use AI for email".',
      '- Zero is a valid answer. Return at most three per window.',
      '- title: verb-led, at most twelve words. pain: one sentence in their words. direction: one or two sentences saying what Claude does, with the input and the output named. quote: a short verbatim fragment from the transcript. raisedBy: the speaker name if given, else "Room". Use Australian English.',
      'TRANSCRIPT WINDOW:',
      windowText,
      'Reply with only JSON of the form {"opportunities":[{"title":"","function":"Finance|Purchasing|Both|Org-wide","phase":"","surface":"","build":"","pain":"","direction":"","systems":[""],"quote":"","raisedBy":"","confidence":"High|Medium|Low"}]}'
    ].join('\n\n');
  }

  function secondPrompt(transcript, titles) {
    return [
      'You are the outside consultant at the end of a live ideation workshop. The room has raised its own list. Your job is the blind-spot layer: six to eight opportunities they did NOT raise, that follow from what they said, that Claude can carry.',
      contextBlock(),
      'ALREADY RAISED (do not repeat, do not lightly rephrase): ' + (titles.length ? titles.join(' | ') : '(nothing)'),
      'For every idea the mandatory field is "why": why the room did not raise it. If you cannot name the blind spot, it is not a blind spot; leave it out. Anchor each to a real comparator pattern. Give an honest confidence.',
      'TRANSCRIPT:',
      transcript,
      'Reply with only JSON: {"ideas":[{"title":"","function":"Finance|Purchasing|Both|Org-wide","phase":"","surface":"","build":"","what":"","why":"","lift":"","comparator":"","confidence":"High|Medium|Low"}]}'
    ].join('\n\n');
  }

  function askJSON(prompt, tier) {
    if (CAP.sample) {
      return CAP.sample.json(prompt, { modelTier: tier === 'complex' ? 'complex' : 'quick', cache: false });
    }
    if (serverAI()) return SB.api(tier === 'complex' ? 'second' : 'extract', prompt);
    var key = S.settings.apiKey;
    if (!key) return Promise.reject({ code: 'no_key', message: 'No API key' });
    var body = {
      model: S.settings.model || 'claude-opus-5', max_tokens: 6000,
      output_config: { effort: tier === 'complex' ? 'high' : 'low', format: { type: 'json_schema', schema: tier === 'complex' ? undefined : SCHEMA } },
      messages: [{ role: 'user', content: prompt }]
    };
    if (tier === 'complex') delete body.output_config.format;
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw { code: 'http_' + r.status, message: (j.error && j.error.message) || r.statusText }; return j; });
    }).then(function (j) {
      if (j.stop_reason === 'refusal') throw { code: 'refused', message: 'The model declined this window.' };
      var text = (j.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
      return parseLooseJSON(text);
    });
  }
  function parseLooseJSON(text) {
    try { return JSON.parse(text); } catch (e) {}
    var m = text.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) { try { return JSON.parse(m[1]); } catch (e) {} }
    var a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (e) {} }
    throw { code: 'invalid_json', message: 'No JSON in reply', text: text };
  }

  function scheduleExtract() {
    clearTimeout(RUN.extractTimer);
    var pending = fullTranscript().length - S.consumedChars;
    var wait = pending >= S.settings.minChars * 3 ? 1500 : S.settings.pollSec * 1000;
    RUN.extractTimer = setTimeout(function () { extractNow(false); }, wait);
  }

  function extractNow(force) {
    if (RUN.extracting) return Promise.resolve();
    var all = fullTranscript();
    var pending = all.length - S.consumedChars;
    if (!force && pending < S.settings.minChars) { scheduleExtract(); return Promise.resolve(); }
    if (pending <= 0) { toast('Nothing new to read'); return Promise.resolve(); }
    if (!aiAvailable()) { setAiStatus('off'); return Promise.resolve(); }
    var start = Math.max(0, S.consumedChars - 1200);
    var windowText = all.slice(start, Math.min(all.length, S.consumedChars + 14000));
    var consumedTo = Math.min(all.length, S.consumedChars + 14000);
    RUN.extracting = true; setAiStatus('busy'); updateTiles();
    log('Reading ' + (consumedTo - S.consumedChars) + ' new characters');
    return askJSON(extractPrompt(windowText, S.opportunities.map(function (o) { return o.title; })), 'quick')
      .then(function (j) {
        var list = (j && j.opportunities) || [];
        var added = 0;
        list.forEach(function (o) { if (addOpportunity(o, 'AI')) added++; });
        S.consumedChars = consumedTo;
        save();
        if (SBA()) SB.updateWorkshop({ consumed_chars: consumedTo }).catch(function () {});
        log('AI returned ' + list.length + ', added ' + added);
        if (added) toast('+' + added + ' idea' + (added > 1 ? 's' : '') + ' on the board');
        setAiStatus(RUN.source !== 'none' ? 'live' : 'idle');
      })
      .catch(function (e) {
        log('AI error: ' + (e && (e.code + ' ' + e.message)));
        setAiStatus('bad');
        if (e && e.code === 'not_granted') { CAP.sample = null; setModeStatus(); }
      })
      .then(function () { RUN.extracting = false; updateTiles(); if (S.settings.autoExtract) scheduleExtract(); });
  }

  function generateSecond() {
    if (!aiAvailable()) { toast('AI is off; showing the consultant list only'); return Promise.resolve(); }
    var t = fullTranscript(); if (t.length > 52000) t = t.slice(-52000);
    if (t.length < 400) { toast('Not enough transcript for an AI pass; consultant list only'); return Promise.resolve(); }
    setAiStatus('busy', 'AI writing the second viewpoint…');
    return askJSON(secondPrompt(t, S.opportunities.map(function (o) { return o.title; })), 'complex')
      .then(function (j) {
        var ideas = (j && j.ideas) || [];
        S.secondAI = ideas.map(function (i, n) { return Object.assign({ id: 'A' + (n + 1), fn: i.function || 'Both' }, i); });
        save(); log('Second viewpoint: ' + ideas.length + ' AI ideas');
        if (SBA()) SB.setAIIdeas(S.secondAI).catch(function () {});
        setAiStatus('idle');
      })
      .catch(function (e) { log('Second viewpoint error: ' + (e && (e.code + ' ' + e.message))); setAiStatus('bad'); });
  }

  /* ------------------------------------------------------ opportunities -- */
  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); }
  function nextId() {
    var max = 0; S.opportunities.forEach(function (o) { var n = parseInt(String(o.id).replace(/\D/g, ''), 10); if (n > max) max = n; });
    return 'O' + (max + 1);
  }
  function addOpportunity(o, source) {
    var t = norm(o.title); if (!t) return false;
    var dup = S.opportunities.some(function (x) { var y = norm(x.title); return y === t || (y.length > 12 && (y.indexOf(t) >= 0 || t.indexOf(y) >= 0)); });
    if (dup) return false;
    var phase = CFG.phases.some(function (p) { return p.name === o.phase; }) ? o.phase : (o.phase || 'Data foundations');
    var row = {
      title: o.title, fn: CFG.functionsTags.indexOf(o.function) >= 0 ? o.function : (o.fn || 'Both'),
      phase: phase, cluster: o.cluster || '', surface: o.surface || 'Claude Chat', build: o.build || 'Skill',
      pain: o.pain || '', direction: o.direction || '', systems: Array.isArray(o.systems) ? o.systems : String(o.systems || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      quote: o.quote || '', raisedBy: o.raisedBy || 'Room', owner: o.owner || '', notes: o.notes || '',
      status: o.status || 'Open', source: source || 'Room', confidence: o.confidence || 'Medium',
      votes: 0, value: null, ease: null, createdAt: now()
    };
    if (SBA()) { SB.insertOpportunity(row).catch(function () {}); return true; }
    row.id = nextId();
    S.opportunities.push(row);
    updateBadge(true);
    if (UI.view === 'opportunities' || UI.view === 'process') render();
    return true;
  }
  function pushOp(o, fields) {
    if (!SBA() || !o.uid) return;
    var patch = {}; fields.forEach(function (f) { patch[f] = o[f]; });
    SB.updateOpportunity(o.uid, patch).catch(function () {});
  }
  function pushSys(sys) { if (SBA() && sys.uid) SB.updateSystem(sys.uid, sys).catch(function () {}); }
  function findOp(id) { for (var i = 0; i < S.opportunities.length; i++) if (S.opportunities[i].id === id) return S.opportunities[i]; return null; }
  function updateBadge(bump) {
    var n = S.opportunities.filter(function (o) { return o.status !== 'Merged'; }).length;
    var b = $('#opBadge'); b.textContent = n; b.classList.toggle('badge--zero', n === 0);
    if (bump && n !== RUN.lastCount) { b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); }
    RUN.lastCount = n;
    $('#secondLock').textContent = S.revealed ? 'open' : 'locked';
    document.title = (n ? n + ' ideas · ' : '') + 'Ideation Board';
  }

  /* ------------------------------------------------------------ sources -- */
  function stopSources() {
    if (RUN.speech) { try { RUN.speech.stop(); } catch (e) {} RUN.speech = null; }
    clearInterval(RUN.wisprTimer); RUN.wisprTimer = null;
    clearInterval(RUN.feedTimer); RUN.feedTimer = null;
    clearTimeout(RUN.demoTimer); RUN.demoTimer = null;
    RUN.source = 'none'; setSrcStatus('', 'No transcript source'); setAiStatus(aiAvailable() ? 'idle' : 'off');
    render();
  }
  function startSpeech() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('This browser has no speech recognition. Use Chrome, or dictate with Wispr Flow.'); return; }
    stopSources();
    var r = new SR(); r.continuous = true; r.interimResults = true; r.lang = 'en-AU';
    var buf = '';
    r.onresult = function (ev) {
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) buf += ev.results[i][0].transcript + ' ';
      }
      if (buf.length > 260 || /[.?!]\s*$/.test(buf) && buf.length > 120) { addTranscript(buf, 'mic'); buf = ''; }
    };
    r.onerror = function (e) { log('mic: ' + e.error); if (e.error === 'not-allowed') { setSrcStatus('bad', 'Mic blocked'); RUN.source = 'none'; } };
    r.onend = function () { if (buf.trim()) { addTranscript(buf, 'mic'); buf = ''; } if (RUN.source === 'mic') { try { r.start(); } catch (e) {} } };
    try { r.start(); RUN.speech = r; RUN.source = 'mic'; setSrcStatus('live', 'Listening on the browser mic'); setAiStatus(aiAvailable() ? 'live' : 'off'); log('mic started'); } catch (e) { toast('Could not start the mic'); }
    render();
  }
  function startWispr() {
    if (!CAP.mcp) { toast('Wispr Flow is reachable only when this page is published as an Artifact with the Wispr Flow connector.'); return; }
    var id = S.settings.wisprMeetingId; if (!id) { toast('Pick a Wispr Flow meeting in Settings first'); return; }
    stopSources();
    RUN.source = 'wispr'; RUN.wisprOffset = 0; RUN.wisprSeen = '';
    setSrcStatus('live', 'Polling Wispr Flow'); setAiStatus(aiAvailable() ? 'live' : 'off');
    var poll = function () {
      CAP.mcp.callTool('Wispr Flow', 'get_meeting', { meeting_id: id, view_transcript: { start_char: RUN.wisprOffset, char_limit: 40000 } }, { cache: false })
        .then(function (res) {
          var p = res.payload || {};
          var text = pickTranscript(p);
          if (!text) { log('Wispr: no transcript text yet'); return; }
          if (text.length > RUN.wisprSeen.length && text.indexOf(RUN.wisprSeen) === 0) {
            var delta = text.slice(RUN.wisprSeen.length);
            RUN.wisprSeen = text; if (delta.trim()) addTranscript(delta, 'wispr');
          } else if (text !== RUN.wisprSeen) { RUN.wisprSeen = text; addTranscript(text, 'wispr'); }
          var cont = String(JSON.stringify(p)).match(/start_char["\s:=]+(\d+)/);
          if (cont && parseInt(cont[1], 10) > RUN.wisprOffset) { RUN.wisprOffset = parseInt(cont[1], 10); RUN.wisprSeen = ''; }
        })
        .catch(function (e) {
          log('Wispr: ' + (e && e.code) + ' ' + (e && e.message));
          if (e && (e.code === 'needs_reauth' || e.code === 'server_not_connected' || e.code === 'not_in_manifest')) { setSrcStatus('bad', 'Wispr Flow: ' + e.code); clearInterval(RUN.wisprTimer); RUN.source = 'none'; }
        });
    };
    poll(); RUN.wisprTimer = setInterval(poll, Math.max(30, S.settings.wisprPollSec) * 1000);
    render();
  }
  function pickTranscript(p) {
    if (!p) return '';
    if (typeof p === 'string') return p;
    if (typeof p.transcript === 'string') return p.transcript;
    if (p.transcript && typeof p.transcript.text === 'string') return p.transcript.text;
    if (p.transcript && typeof p.transcript.content === 'string') return p.transcript.content;
    var best = '';
    (function walk(o, d) { if (d > 4 || !o) return; Object.keys(o).forEach(function (k) { var v = o[k]; if (typeof v === 'string' && v.length > best.length && v.length > 200) best = v; else if (v && typeof v === 'object') walk(v, d + 1); }); })(p, 0);
    return best;
  }
  function listWisprMeetings() {
    if (!CAP.mcp) return Promise.resolve([]);
    return CAP.mcp.callTool('Wispr Flow', 'search_meetings', { limit: 12 }, { cache: false })
      .then(function (res) { var p = res.payload || {}; return p.meetings || []; })
      .catch(function (e) { log('Wispr list: ' + (e && e.code)); return []; });
  }
  function startFeed() {
    var url = S.settings.feedUrl; if (!url) { toast('Set a feed URL in Settings'); return; }
    stopSources(); RUN.source = 'feed'; RUN.feedSeen = {};
    setSrcStatus('live', 'Polling JSON feed'); setAiStatus(aiAvailable() ? 'live' : 'off');
    var poll = function () {
      fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + now(), { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
        var added = 0;
        (j.opportunities || []).forEach(function (o) { var k = o.id || norm(o.title); if (RUN.feedSeen[k]) return; RUN.feedSeen[k] = 1; if (addOpportunity(o, o.source || 'AI')) added++; });
        (j.transcript || []).forEach(function (c) { var k = c.id || c.t || norm(c.text || c); if (RUN.feedSeen['t' + k]) return; RUN.feedSeen['t' + k] = 1; addTranscript(c.text || c, 'feed'); });
        if (added) { save(); toast('+' + added + ' from feed'); }
      }).catch(function (e) { log('feed: ' + e.message); });
    };
    poll(); RUN.feedTimer = setInterval(poll, Math.max(10, S.settings.feedPollSec) * 1000);
    render();
  }
  function startDemo() {
    stopSources(); RUN.source = 'demo'; RUN.demoIdx = 0;
    setSrcStatus('live', 'Demo transcript playing'); setAiStatus(aiAvailable() ? 'live' : 'off');
    var step = function () {
      if (RUN.source !== 'demo') return;
      if (RUN.demoIdx >= CFG.demoTranscript.length) { log('demo finished'); setSrcStatus('', 'Demo finished'); RUN.source = 'none'; render(); return; }
      addTranscript(CFG.demoTranscript[RUN.demoIdx++], 'demo');
      RUN.demoTimer = setTimeout(step, 9000);
    };
    step(); render();
  }

  /* -------------------------------------------------------------- timer -- */
  function blockElapsed() { var t = S.timer; return t.elapsedBefore + (t.running ? now() - t.startedAt : 0); }
  function tickTimer() {
    var b = CFG.agenda[S.agendaIdx];
    var el = $('#nowTime'), nb = $('#nowBlock');
    if (!b) { el.textContent = '00:00'; nb.textContent = 'Not started'; return; }
    var ms = blockElapsed(), s = Math.floor(ms / 1000), m = Math.floor(s / 60);
    el.textContent = (m < 10 ? '0' : '') + m + ':' + ((s % 60) < 10 ? '0' : '') + (s % 60);
    el.classList.toggle('over', m >= b.mins);
    nb.textContent = (S.agendaIdx + 1) + '. ' + b.title + ' · ' + b.mins + ' min';
    $('#btnTimer').textContent = S.timer.running ? 'Pause' : 'Start timer';
  }
  function toggleTimer() {
    if (S.agendaIdx < 0) { gotoBlock(0); }
    var t = S.timer;
    if (t.running) { t.elapsedBefore += now() - t.startedAt; t.running = false; } else { t.startedAt = now(); t.running = true; }
    save(); tickTimer();
    if (SBA()) SB.updateWorkshop({ timer_running: t.running, timer_elapsed_ms: Math.round(t.elapsedBefore), block_started_at: t.running ? new Date(t.startedAt).toISOString() : null }).catch(function () {});
  }
  function gotoBlock(i) {
    if (S.agendaIdx >= 0 && i > S.agendaIdx) S.blockDone[CFG.agenda[S.agendaIdx].id] = true;
    S.agendaIdx = Math.max(0, Math.min(CFG.agenda.length - 1, i));
    S.timer = { running: true, startedAt: now(), elapsedBefore: 0 };
    save(); tickTimer();
    if (SBA()) SB.updateWorkshop({ current_block: S.agendaIdx, block_started_at: new Date(S.timer.startedAt).toISOString(), timer_running: true, timer_elapsed_ms: 0 }).catch(function () {});
    var b = CFG.agenda[S.agendaIdx];
    if (b.view && b.view !== UI.view) go(b.view); else render();
  }

  /* -------------------------------------------------------------- views -- */
  function go(view) {
    if (view === 'second' && UI.view !== 'second') UI.seq++;
    UI.view = view;
    $$('.navbtn').forEach(function (b) { if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    window.scrollTo(0, 0);
    render();
  }
  function render() {
    var root = $('#view');
    var fn = { runsheet: vRunsheet, systems: vSystems, process: vProcess, opportunities: vOpportunities, second: vSecond, live: vLive, settings: vSettings }[UI.view] || vRunsheet;
    root.innerHTML = fn();
    afterRender();
  }
  function afterRender() {
    if (UI.view === 'second' && S.revealed && window.ScrollCraft) {
      var root = $('#view');
      if (root.getAttribute('data-sc-mounted') !== String(UI.seq)) { root.setAttribute('data-sc-mounted', String(UI.seq)); window.ScrollCraft.mount(root); }
    }
    if (UI.view === 'live') { var f = $('#feed'); if (f) f.scrollTop = f.scrollHeight; updateTiles(); var lg = $('#liveLog'); if (lg) lg.textContent = RUN.log.join('\n'); }
    if (UI.view === 'settings') fillAdmin();
    if (UI.view === 'settings' && CAP.mcp) {
      listWisprMeetings().then(function (ms) {
        var sel = $('#wisprMeeting'); if (!sel) return;
        sel.innerHTML = '<option value="">Choose a meeting…</option>' + ms.map(function (m) { return '<option value="' + esc(m.id) + '"' + (m.id === S.settings.wisprMeetingId ? ' selected' : '') + '>' + esc(m.title || m.id) + ' · ' + new Date(m.start).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', hour12: false }) + (m.finalized ? '' : ' · live') + '</option>'; }).join('');
      });
    }
  }
  function head(title, lede, actions) {
    return '<div class="view__head"><div><h1>' + title + '</h1>' + (lede ? '<p>' + lede + '</p>' : '') + '</div><div class="row">' + (actions || '') + '</div></div>' + (window.HELP ? HELP.howtoHtml(UI.view) : '');
  }
  function chip(cls, txt) { if (txt == null || String(txt).trim() === '') return ''; var tip = window.HELP ? HELP.chipTip(cls, txt) : ''; return '<span class="chip ' + cls + '"' + (tip ? ' data-tip="' + esc(tip) + '"' : '') + '>' + esc(txt) + '</span>'; }
  function opCountFor(phaseName) { return S.opportunities.filter(function (o) { return o.phase === phaseName && o.status !== 'Merged'; }); }

  function vRunsheet() {
    var c = CFG.client;
    var total = CFG.agenda.reduce(function (a, b) { return a + b.mins; }, 0);
    var html = head('The 90 minutes', 'Facilitator view. The room sees the block title and the clock at the top; the questions are yours.',
      '<button class="btn btn--primary fac" data-action="start">' + (S.agendaIdx < 0 ? 'Start the session' : 'Restart from block 1') + '</button>');
    if (!guideDismissed()) {
      html += '<div class="card guide fac"><div><h3>New here? Three things to do first</h3><ol>' +
        '<li>Hover anything on this page for a plain-words note. Gold tag: for you. Green tag: the room sees it.</li>' +
        '<li>Open <b>Live capture</b> and press <b>Demo transcript</b>. Watch the Opportunities badge climb.</li>' +
        '<li>Come back here and press <b>Start the session</b> when the room is ready.</li></ol>' +
        '<div class="guide__steps"><button class="btn btn--sm btn--primary" data-action="openhelp">Open the full guide</button><button class="btn btn--sm" data-view="live">Try the demo</button></div></div>' +
        '<button class="btn btn--sm btn--ghost" data-action="dismissguide">Hide</button></div>';
    }
    if (SBA() && SB.ws) {
      html += '<div class="card joincard" data-who="room" data-tip="Show this to the room in block 1. Everyone opens the link on their phone, enters their email and this code, and gets a sign-in link by email."><div><div class="k">Join on your phone</div><div class="joincard__url">' + esc(participantLink()) + '</div></div><div><div class="k">Code</div><div class="joincard__code">' + esc(SB.ws.join_code) + '</div></div><div class="fac"><button class="btn btn--sm" data-action="copylink">Copy link</button></div></div>';
    }
    html += '<div class="frame-strip">' +
      '<div class="frame-cell" data-tip="' + esc(HELP.tips.other.frameNorth) + '" data-who="both"><div class="k">North star</div><div class="v">' + esc(c.northStar) + '</div></div>' +
      '<div class="frame-cell" data-tip="' + esc(HELP.tips.other.frameScope) + '" data-who="both"><div class="k">Scope test</div><div class="v">' + esc(c.scopeCriterion) + '</div></div>' +
      '<div class="frame-cell"><div class="k">The room</div><div class="v">' + c.headcount + ' people · Finance and Purchasing</div></div>' +
      '<div class="frame-cell"><div class="k">Plan</div><div class="v">' + CFG.agenda.length + ' blocks · ' + total + ' minutes</div></div></div>';
    html += '<div class="agenda">';
    CFG.agenda.forEach(function (b, i) {
      var cls = 'block' + (i === S.agendaIdx ? ' block--now' : '') + (S.blockDone[b.id] ? ' block--done' : '');
      html += '<div class="' + cls + '" data-block="' + i + '">' +
        '<div class="block__mins">' + b.mins + '<small>min</small></div>' +
        '<div class="block__body"><h3>' + (i + 1) + '. ' + esc(b.title) + '</h3><p class="block__say">' + esc(b.say) + '</p>' +
        '<ul class="block__ask">' + b.ask.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul></div>' +
        '<div class="block__ctl fac"><button class="btn btn--sm" data-action="goto" data-i="' + i + '">' + (i === S.agendaIdx ? 'Current' : 'Go') + '</button><button class="btn btn--sm btn--ghost" data-action="toggleask" data-i="' + i + '">Questions</button></div></div>';
    });
    html += '</div>';
    html += '<div class="card fac" style="margin-top:var(--sc-6)"><h2 style="margin-bottom:8px">Question bank</h2><p class="muted small" style="margin-bottom:8px">From the engagement field guide. The fourth group is the one that matters most today: it maps a sentence to a Claude surface.</p><div class="qbank">' +
      CFG.questionBank.map(function (g) { return '<details><summary>' + esc(g.group) + '</summary><ul>' + g.qs.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul></details>'; }).join('') + '</div></div>';
    return html;
  }

  function vSystems() {
    var html = head('What you touch', 'Assumed until the room confirms it. The connector column is the seam Claude has to cross.',
      '<button class="btn fac" data-action="addsystem">Add a system</button>');
    html += '<div class="grid grid--3">';
    S.systems.forEach(function (s) {
      html += '<div class="card sys" data-sys="' + esc(s.id) + '"><div><div class="sys__name">' + esc(s.name) + '</div><div class="sys__meta">' + chip('chip--st-' + s.status, s.status) + chip('', s.category) + chip('', s.usedBy) + '</div>' +
        '<div class="sys__note"><b>Claude reach:</b> ' + esc(s.connector) + '<br>' + esc(s.note) + '</div></div>' +
        '<div class="stack fac"><div class="seg" data-sysstatus="' + esc(s.id) + '">' + ['confirmed', 'assumed', 'unknown'].map(function (st) { return '<button aria-pressed="' + (s.status === st) + '" data-st="' + st + '">' + st[0].toUpperCase() + '</button>'; }).join('') + '</div><button class="btn btn--sm btn--ghost" data-action="editsystem" data-id="' + esc(s.id) + '">Edit</button></div></div>';
    });
    html += '</div>';
    return html;
  }

  function vProcess() {
    var html = head('Process walk', 'Phase by phase. The number is how many opportunities have landed on that phase: the heat map builds itself.', '');
    ['Finance', 'Purchasing', 'Both', 'Org-wide'].forEach(function (fn) {
      var ps = CFG.phases.filter(function (p) { return p.fn === fn; }); if (!ps.length) return;
      html += '<h2 style="margin:var(--sc-6) 0 var(--sc-3)">' + esc(fn === 'Both' ? 'Cross-cutting' : fn) + '</h2><div class="grid grid--2">';
      ps.forEach(function (p) {
        var ops = opCountFor(p.name);
        html += '<div class="card phase" data-phase="' + esc(p.id) + '"><div><h3>' + esc(p.name) + '</h3><p class="phase__what">' + esc(p.what) + '</p>' +
          '<ul class="phase__prompts fac">' + p.prompts.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul>' +
          (ops.length ? '<div class="phase__ops">' + ops.map(function (o) { return chip('chip--fn-' + o.fn, o.id + ' ' + o.title); }).join('') + '</div>' : '') +
          '<div class="row fac" style="margin-top:10px"><button class="btn btn--sm" data-action="newop" data-phase="' + esc(p.name) + '" data-fn="' + esc(p.fn) + '">Add opportunity here</button></div></div>' +
          '<div class="phase__count' + (ops.length ? '' : ' zero') + '">' + ops.length + '</div></div>';
      });
      html += '</div>';
    });
    return html;
  }

  function filteredOps() {
    var f = UI.filter, q = norm(f.q);
    return S.opportunities.filter(function (o) {
      if (f.fn !== 'All' && o.fn !== f.fn) return false;
      if (f.status !== 'All' && o.status !== f.status) return false;
      if (q && norm(o.title + ' ' + o.pain + ' ' + o.direction + ' ' + o.phase + ' ' + o.raisedBy).indexOf(q) < 0) return false;
      return true;
    }).sort(function (a, b) { return (b.votes - a.votes) || (a.createdAt - b.createdAt); });
  }
  function vOpportunities() {
    var ops = filteredOps();
    var html = head('Opportunities', 'Everything heard, tagged and editable. Click a title to rename it. Votes sort the list.',
      '<div class="seg part-hide" id="opsMode"><button aria-pressed="' + (UI.opsMode === 'cards') + '" data-m="cards">Cards</button><button aria-pressed="' + (UI.opsMode === 'table') + '" data-m="table">Table</button></div>' +
      (MODE.role === 'participant' ? '<span class="chip chip--dots" id="dotsLeft" data-tip="Dot votes you still have to spend. Press plus on an idea to spend one, minus to take it back." data-who="room">' + dotsLeft() + ' of ' + maxDots() + ' dots left</span><button class="btn btn--primary" data-action="newidea" data-tip="Add an idea of your own. It lands on the board for everyone with your name on it." data-who="room">Add an idea</button>' : '') +
      '<button class="btn fac" data-action="newop">Add</button><button class="btn part-hide' + (MODE.role === 'participant' ? '' : ' btn--primary') + '" data-action="export">Export Excel</button>' +
      '<button class="btn btn--ghost btn--sm fac" data-action="exportjson">JSON</button><button class="btn btn--ghost btn--sm fac" data-action="importjson">Import</button>');
    html += '<div class="toolbar"><div class="seg" id="fnFilter">' + ['All'].concat(CFG.functionsTags).map(function (f) { return '<button aria-pressed="' + (UI.filter.fn === f) + '" data-f="' + f + '">' + f + '</button>'; }).join('') + '</div>' +
      '<select id="stFilter"><option>All</option>' + CFG.statuses.map(function (s) { return '<option' + (UI.filter.status === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>' +
      '<input type="search" id="qFilter" placeholder="Search" value="' + esc(UI.filter.q) + '"><span class="muted small">' + ops.length + ' of ' + S.opportunities.length + '</span></div>';
    if (!S.opportunities.length) {
      html += '<div class="empty"><b>Nothing on the board yet.</b><br>Start a transcript source in Live capture, or add one by hand. Every idea lands here with a number.</div>';
      return html;
    }
    if (UI.opsMode === 'table') return html + opsTable(ops);
    html += '<div class="ops">' + ops.map(opCard).join('') + '</div>';
    return html;
  }
  function opCard(o) {
    return '<div class="op op--' + esc(o.status) + '" data-op="' + esc(o.id) + '"><div class="op__id">' + esc(o.id) + '</div><div>' +
      '<div class="op__title"' + (MODE.role === 'participant' ? '' : ' contenteditable="true" spellcheck="false" data-field="title"') + '>' + esc(o.title) + '</div>' +
      '<div class="op__meta">' + chip('chip--fn-' + o.fn, o.fn) + chip('', o.phase) + chip('', o.surface) + chip('', o.build) + chip('chip--status-' + o.status, o.status) + chip('chip--src-' + o.source, o.source === 'AI' ? 'AI heard it' : o.source) + (o.owner ? chip('', 'Owner: ' + o.owner) : '') + '</div>' +
      (o.pain ? '<p class="op__pain">' + esc(o.pain) + '</p>' : '') +
      (o.direction ? '<p class="op__dir"><b>' + esc(o.surface) + ':</b> ' + esc(o.direction) + '</p>' : '') +
      (o.quote ? '<p class="op__quote">“' + esc(o.quote) + '” ' + (o.raisedBy ? '· ' + esc(o.raisedBy) : '') + '</p>' : '') +
      '</div><div class="op__side">' + voteBox(o) +
      '<div class="row fac"><button class="btn btn--sm btn--ghost" data-action="edit" data-id="' + o.id + '">Edit</button>' + (o.status === 'Validated' ? '' : '<button class="btn btn--sm btn--ghost" data-action="validate" data-id="' + o.id + '">Validate</button>') + '</div></div></div>';
  }
  function maxDots() { return (SBA() && SB.ws && SB.ws.max_dots) || 3; }
  function dotsLeft() { var used = 0; S.opportunities.forEach(function (o) { used += o.myDots || 0; }); return Math.max(0, maxDots() - used); }
  function voteBox(o) {
    if (MODE.role === 'participant') {
      var mine = o.myDots || 0;
      return '<div class="vote"><button data-action="vote" data-id="' + o.id + '" data-d="-1" aria-label="Take a dot back"' + (mine ? '' : ' disabled') + '>−</button><span class="vote__n" data-tip="' + o.votes + ' dot' + (o.votes === 1 ? '' : 's') + ' from the room, ' + mine + ' of them yours." data-who="room">' + o.votes + '</span><button data-action="vote" data-id="' + o.id + '" data-d="1" aria-label="Add a dot"' + (dotsLeft() ? '' : ' disabled') + '>+</button></div>' + (mine ? '<span class="small muted">you: ' + mine + '</span>' : '');
    }
    if (MODE.role === 'facilitator') {
      var who = (o.voters && o.voters.length) ? 'Voted: ' + o.voters.join(', ') : 'No votes yet';
      return '<div class="vote"><span class="vote__n vote__n--big" data-tip="' + esc(who) + '" data-who="room">' + o.votes + '</span><span class="small muted">dots</span></div>';
    }
    return '<div class="vote"><button data-action="vote" data-id="' + o.id + '" data-d="-1" aria-label="Remove a vote">−</button><span class="vote__n">' + o.votes + '</span><button data-action="vote" data-id="' + o.id + '" data-d="1" aria-label="Add a vote">+</button></div>';
  }
  function sel(field, id, opts, val) { return '<select data-field="' + field + '" data-id="' + id + '">' + opts.map(function (v) { return '<option' + (v === val ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') + '</select>'; }
  function opsTable(ops) {
    var cols = ['ID', 'Title', 'Function', 'Phase', 'Surface', 'Build', 'Status', 'Pain', 'What Claude does', 'Systems', 'Raised by', 'Owner', 'Votes'];
    var rows = ops.map(function (o) {
      return '<tr data-op="' + o.id + '"><td>' + o.id + '</td><td contenteditable data-field="title">' + esc(o.title) + '</td>' +
        '<td>' + sel('fn', o.id, CFG.functionsTags, o.fn) + '</td><td>' + sel('phase', o.id, CFG.phases.map(function (p) { return p.name; }), o.phase) + '</td>' +
        '<td>' + sel('surface', o.id, CFG.surfaces.map(function (s) { return s.key; }), o.surface) + '</td><td>' + sel('build', o.id, CFG.buildTypes, o.build) + '</td><td>' + sel('status', o.id, CFG.statuses, o.status) + '</td>' +
        '<td contenteditable data-field="pain">' + esc(o.pain) + '</td><td contenteditable data-field="direction">' + esc(o.direction) + '</td><td contenteditable data-field="systems">' + esc(o.systems.join(', ')) + '</td>' +
        '<td contenteditable data-field="raisedBy">' + esc(o.raisedBy) + '</td><td contenteditable data-field="owner">' + esc(o.owner) + '</td><td class="tabnum">' + o.votes + '</td></tr>';
    }).join('');
    return '<div class="table-wrap"><table class="reg"><thead><tr>' + cols.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function vSecond() {
    if (!S.revealed) {
      return '<div class="locked"><h2>The second viewpoint</h2><p>Sealed until block 7. What we saw from outside, and for each one, why we think it did not come up.</p>' +
        '<div class="row fac" style="justify-content:center;margin-top:24px"><button class="btn btn--primary" data-action="reveal">Reveal</button><span class="muted small">' + (aiAvailable() ? 'Also asks Claude for blind spots from today’s transcript.' : 'AI is off, so this reveals the consultant list only.') + '</span></div></div>';
    }
    var raisedOps = S.opportunities.filter(function (o) { return o.status !== 'Merged' && o.status !== 'Parked'; });
    var raised = raisedOps.length;
    var byFn = {}; raisedOps.forEach(function (o) { byFn[o.fn] = (byFn[o.fn] || 0) + 1; });
    var ideas = CFG.blindSpots.concat(S.secondAI.map(function (i) { return Object.assign({}, i, { fromAI: true }); }));
    var html = '';
    html += '<section class="reveal" data-sc-act="pin" data-sc-span="2.6"><div class="sc-stage">' +
      '<div class="reveal__copy" data-sc-cue="0.02 0.34"><div class="reveal__eyebrow">In the last 90 minutes</div><div class="reveal__n" data-sc-count="0 ' + raised + '" data-sc-count-at="0.05 0.28">0</div><div class="reveal__k">ideas came from this room</div>' +
      '<div class="reveal__chips">' + CFG.functionsTags.map(function (f) { return byFn[f] ? chip('chip--fn-' + f, byFn[f] + ' ' + f) : ''; }).join('') + '</div></div>' +
      '<div class="reveal__copy" data-sc-cue="0.38 0.68"><div class="reveal__eyebrow">Now the second viewpoint</div><h2 data-sc-kinetic="lines">Here is what we saw<br>that you did not say.</h2></div>' +
      '<div class="reveal__copy" data-sc-cue="0.72 1"><div class="reveal__pair"><div><div class="reveal__k">Raised by you</div><div class="reveal__n">' + raised + '</div></div><div><div class="reveal__k">Seen from outside</div><div class="reveal__n" data-sc-count="0 ' + ideas.length + '" data-sc-count-at="0.74 0.92">0</div></div></div>' +
      '<p class="reveal__lede">Every idea below carries one line: why it did not come up. Keep scrolling to read them.</p></div>' +
      '</div></section>';
    html += '<div class="view__head" style="margin-top:var(--sc-6)"><div><h1>The second viewpoint</h1><p>' + CFG.blindSpots.length + ' prepared before today' + (S.secondAI.length ? ', ' + S.secondAI.length + ' written by Claude from the transcript' : '') + '. Promote the ones that land straight onto the board.</p></div>' +
      '<div class="row fac"><button class="btn btn--ghost btn--sm" data-action="regen">Ask Claude again</button><button class="btn btn--ghost btn--sm" data-action="reseal">Re-seal</button></div></div>';
    html += '<div class="grid grid--2" data-sc-in data-sc-stagger="70">';
    ideas.forEach(function (i) {
      html += '<div class="card idea"><div><div class="op__meta" style="margin:0 0 8px">' + chip('chip--fn-' + (i.fn || 'Both'), i.fn || 'Both') + chip('', i.surface) + chip('', i.build) + chip(i.fromAI ? 'chip--src-AI' : 'chip--src-Consultant', i.fromAI ? 'Claude, today' : 'Consultant') + chip('', i.confidence + ' confidence') + '</div><h3>' + esc(i.title) + '</h3></div>' +
        '<div class="idea__row"><span class="k">What</span><span>' + esc(i.what) + '</span></div>' +
        '<div class="idea__why"><b>Why you did not raise it:</b> ' + esc(i.why) + '</div>' +
        (i.lift ? '<div class="idea__row"><span class="k">Lift</span><span>' + esc(i.lift) + '</span></div>' : '') +
        (i.comparator ? '<div class="idea__row"><span class="k">Seen at</span><span>' + esc(i.comparator) + '</span></div>' : '') +
        '<div class="row fac"><button class="btn btn--sm" data-action="promote" data-id="' + esc(i.id) + '">Put it on the board</button></div></div>';
    });
    html += '</div>';
    return html;
  }

  function vLive() {
    var src = RUN.source;
    var html = head('Live capture', 'Facilitator only. Feed the transcript in, Claude reads it in windows and drops ideas onto the board with a number.', '');
    html += '<div class="tiles" style="margin-bottom:var(--sc-4)">' +
      '<div class="tile"><div class="n" id="tChars">0</div><div class="k">chars captured</div></div>' +
      '<div class="tile"><div class="n" id="tPending">0</div><div class="k">unread by AI</div></div>' +
      '<div class="tile"><div class="n" id="tOps">0</div><div class="k">on the board</div></div>' +
      '<div class="tile"><div class="n" id="tAI">0</div><div class="k">heard by AI</div></div></div>';
    html += '<div class="live"><div class="card stack"><div class="row spread"><h3>Sources</h3>' + (src !== 'none' ? '<button class="btn btn--sm btn--danger" data-action="stopsrc">Stop</button>' : '') + '</div>' +
      '<div class="mode">' +
      '<button data-action="src-mic" aria-pressed="' + (src === 'mic') + '">Browser mic<small>Chrome speech recognition. Free, rough, live.</small></button>' +
      '<button data-action="src-wispr" aria-pressed="' + (src === 'wispr') + '"' + (CAP.mcp ? '' : ' disabled') + '>Wispr Flow meeting<small>' + (CAP.mcp ? 'Polls the meeting recorder transcript via the connector.' : 'Needs the Artifact build with the Wispr Flow connector.') + '</small></button>' +
      '<button data-action="src-feed" aria-pressed="' + (src === 'feed') + '">JSON feed URL<small>A Claude Code or Cowork session writes ideas to a file; this polls it.</small></button>' +
      '<button data-action="src-demo" aria-pressed="' + (src === 'demo') + '">Demo transcript<small>Eight voices, one every nine seconds. Test the loop.</small></button></div>' +
      '<label class="field">Paste the transcript here (the whole thing each time is fine: only the new part is added). Wispr Flow dictation works here too. Ctrl or Cmd + Enter to add.<textarea id="manualBox" placeholder="Paste from the live notes, or dictate…"></textarea></label>' +
      '<div class="row"><button class="btn" data-action="addmanual">Add to transcript</button><button class="btn btn--primary" data-action="extract">Read now</button><label class="check"><input type="checkbox" id="autoExtract"' + (S.settings.autoExtract ? ' checked' : '') + '> Auto-read every ' + S.settings.pollSec + 's</label></div>' +
      '<div class="log" id="liveLog"></div></div>' +
      '<div class="card stack"><div class="row spread"><h3>Transcript</h3><button class="btn btn--sm btn--ghost" data-action="cleartranscript">Clear</button></div><div class="feed" id="feed">' + S.transcript.map(function (c) { return feedItem(c, false); }).join('') + '</div></div></div>';
    return html;
  }
  function updateTiles() {
    var all = fullTranscript().length;
    var set = function (id, v) { var el = $(id); if (el) el.textContent = v; };
    set('#tChars', all); set('#tPending', Math.max(0, all - S.consumedChars)); set('#tOps', S.opportunities.length); set('#tAI', S.opportunities.filter(function (o) { return o.source === 'AI'; }).length);
  }

  function vSettings() {
    var s = S.settings;
    var html = head('Settings', 'Kept in this browser only. The API key never syncs.', '');
    html += '<div class="settings">';
    if (window.SB && SB.user) html += settingsAccount();
    html += '<div class="card"><h3>How this page is running</h3><div class="kv">' +
      '<span class="k">Mode</span><span>' + (SBA() ? 'Connected to the shared backend as ' + esc(SB.role) : isArtifact() ? 'Published Artifact on claude.ai' : 'Standalone page, this browser only') + '</span>' +
      '<span class="k">AI brain</span><span>' + (CAP.sample ? 'Claude via the Artifact (the viewer’s own plan pays, no key)' : serverAI() ? 'Claude via the server. No key needed here.' : (s.apiKey ? 'Anthropic API from this browser' : 'Off. Add a key below, or set ANTHROPIC_API_KEY on the server.')) + '</span>' +
      '<span class="k">Wispr Flow</span><span>' + (CAP.mcp ? 'Connector reachable' : 'Not reachable from a standalone page. Dictate into Live capture instead, or use the feed.') + '</span>' +
      '<span class="k">Shared board</span><span>' + (SBA() ? 'Yes: every signed-in member sees the same board live' : CAP.db ? 'Yes: everyone with the link sees the same register' : 'No: this browser only. Export and share the file.') + '</span>' +
      '<span class="k">Excel export</span><span>' + (CAP.downloads ? 'Via the Artifact save prompt' : 'Direct browser download') + '</span></div></div>';
    if (SBA()) {
      html += '<div class="card stack"><h3>AI brain</h3>' + (serverAI()
        ? '<p>Claude runs on the server with a key nobody in the room can see. Nothing to add here.</p>'
        : '<p><b>The server has no Claude key yet.</b> In Vercel: Settings → Environment Variables → add <code>ANTHROPIC_API_KEY</code> for Production, then Deployments → Redeploy. Reload this page afterwards. Do not paste the key into this site.</p>') + '</div>';
    } else
    html += '<div class="card stack"><h3>AI brain (standalone)</h3><div class="field-row">' +
      '<label class="field">Anthropic API key<input type="password" id="setKey" value="' + esc(s.apiKey) + '" placeholder="sk-ant-…"></label>' +
      '<label class="field">Model<select id="setModel">' + ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-haiku-4-5'].map(function (m) { return '<option' + (s.model === m ? ' selected' : '') + '>' + m + '</option>'; }).join('') + '</select></label>' +
      '<label class="field">Read every (seconds)<input type="number" id="setPoll" min="20" value="' + s.pollSec + '"></label>' +
      '<label class="field">Minimum new characters before a read<input type="number" id="setMin" min="80" value="' + s.minChars + '"></label></div>' +
      '<p class="muted small">Browser calls to the API are fine for a facilitator’s own laptop. Do not ship this key to the room.</p></div>';
    html += '<div class="card stack"><h3>Wispr Flow meeting recorder</h3>' +
      (CAP.mcp ? '<label class="field">Meeting<select id="wisprMeeting"><option>Loading…</option></select></label><label class="field">Poll every (seconds, minimum 30)<input type="number" id="setWisprPoll" min="30" value="' + s.wisprPollSec + '"></label>' :
        '<p class="muted">Only reachable when this page is published as a claude.ai Artifact with the Wispr Flow connector declared. In standalone mode, open Wispr Flow, press record for the meeting, and dictate summaries into Live capture, or run a Claude session that polls the meeting and writes to the JSON feed.</p>') + '</div>';
    html += '<div class="card stack"><h3>JSON feed</h3><label class="field">Feed URL<input id="setFeed" value="' + esc(s.feedUrl) + '" placeholder="https://…/feed.json"></label><label class="field">Poll every (seconds)<input type="number" id="setFeedPoll" min="10" value="' + s.feedPollSec + '"></label>' +
      '<p class="muted small">Shape: {"opportunities":[{"id":"","title":"","function":"","phase":"","surface":"","build":"","pain":"","direction":"","systems":[],"quote":"","raisedBy":""}],"transcript":[{"t":0,"text":""}]}. Cross-origin hosts need CORS headers.</p></div>';
    html += '<div class="card stack"><h3>Appearance</h3><div class="row"><span class="muted small">Theme</span><div class="seg" id="themeSeg">' + [['', 'Light'], ['dark', 'Dark']].map(function (t) { return '<button aria-pressed="' + (s.theme === t[0]) + '" data-t="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div></div>' +
      '<p class="muted small">Presentation mode (P) hides everything marked facilitator-only and enlarges the type for the projector.</p></div>';
    html += '<div class="card stack"><h3>Danger</h3><div class="row"><button class="btn btn--danger" data-action="resetall">Reset the whole board</button><button class="btn btn--ghost" data-action="resetsystems">Reset systems to seed</button></div></div>';
    html += '<div class="row"><button class="btn btn--primary" data-action="savesettings">Save settings</button></div></div>';
    return html;
  }

  /* ------------------------------------------------------------- sheet -- */
  var SHEET = { id: null, kind: 'op' };
  function openSheet(kind, id) {
    SHEET.kind = kind; SHEET.id = id;
    var body = $('#sheetBody'), title = $('#sheetTitle');
    if (kind === 'idea') {
      title.textContent = 'Add an idea';
      body.innerHTML = '<label class="field">What is the task or the pain? One line.<input id="f_title" placeholder="Chasing invoice approvals every week"></label>' +
        '<label class="field">Whose is it?<select id="f_fn">' + CFG.functionsTags.map(function (x) { return '<option>' + esc(x) + '</option>'; }).join('') + '</select></label>' +
        '<label class="field">Tell us a bit more (optional)<textarea id="f_pain" placeholder="How often, how long, what goes wrong"></textarea></label>' +
        '<label class="field">What would you want Claude to do? (optional)<textarea id="f_direction"></textarea></label>';
      $('#sheetDelete').hidden = true;
    } else if (kind === 'op') {
      var o = id ? findOp(id) : { id: '', title: '', fn: 'Both', phase: CFG.phases[0].name, cluster: '', surface: 'Skill', build: 'Skill', pain: '', direction: '', systems: [], quote: '', raisedBy: '', owner: '', notes: '', status: 'Open' };
      if (!o) return;
      title.textContent = id ? 'Edit ' + id : 'New opportunity';
      var opt = function (list, v) { return list.map(function (x) { return '<option' + (x === v ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join(''); };
      body.innerHTML = '<label class="field">Title<input id="f_title" value="' + esc(o.title) + '"></label>' +
        '<div class="field-row"><label class="field">Function<select id="f_fn">' + opt(CFG.functionsTags, o.fn) + '</select></label><label class="field">Status<select id="f_status">' + opt(CFG.statuses, o.status) + '</select></label></div>' +
        '<label class="field">Process phase<select id="f_phase">' + opt(CFG.phases.map(function (p) { return p.name; }), o.phase) + '</select></label>' +
        '<div class="field-row"><label class="field">Claude surface<select id="f_surface">' + opt(CFG.surfaces.map(function (s) { return s.key; }), o.surface) + '</select></label><label class="field">Build<select id="f_build">' + opt(CFG.buildTypes, o.build) + '</select></label></div>' +
        '<label class="field">Pain, in their words<textarea id="f_pain">' + esc(o.pain) + '</textarea></label>' +
        '<label class="field">What Claude does (input and output)<textarea id="f_direction">' + esc(o.direction) + '</textarea></label>' +
        '<div class="field-row"><label class="field">Systems (comma separated)<input id="f_systems" value="' + esc(o.systems.join(', ')) + '"></label><label class="field">Cluster<input id="f_cluster" value="' + esc(o.cluster) + '"></label></div>' +
        '<div class="field-row"><label class="field">Raised by<input id="f_raisedBy" value="' + esc(o.raisedBy) + '"></label><label class="field">Owner<input id="f_owner" value="' + esc(o.owner) + '"></label></div>' +
        '<label class="field">Quote<input id="f_quote" value="' + esc(o.quote) + '"></label>' +
        '<label class="field">Notes<textarea id="f_notes">' + esc(o.notes) + '</textarea></label>';
      $('#sheetDelete').hidden = !id;
    } else {
      var s = id ? S.systems.filter(function (x) { return x.id === id; })[0] : { id: '', name: '', category: '', usedBy: '', connector: '', status: 'assumed', note: '' };
      title.textContent = id ? 'Edit system' : 'New system';
      body.innerHTML = '<label class="field">Name<input id="f_name" value="' + esc(s.name) + '"></label><div class="field-row"><label class="field">Category<input id="f_category" value="' + esc(s.category) + '"></label><label class="field">Used by<input id="f_usedBy" value="' + esc(s.usedBy) + '"></label></div>' +
        '<label class="field">Claude reach (connector)<input id="f_connector" value="' + esc(s.connector) + '"></label><label class="field">Note<textarea id="f_note">' + esc(s.note) + '</textarea></label>';
      $('#sheetDelete').hidden = !id;
    }
    $('#sheet').classList.add('open'); $('#sheet').setAttribute('aria-hidden', 'false'); $('#sheetBackdrop').classList.add('open');
    var first = body.querySelector('input,textarea'); if (first) first.focus();
  }
  function closeSheet() { $('#sheet').classList.remove('open'); $('#sheet').setAttribute('aria-hidden', 'true'); $('#sheetBackdrop').classList.remove('open'); }
  function saveSheet() {
    var v = function (id) { var el = $('#' + id); return el ? el.value.trim() : ''; };
    if (SHEET.kind === 'idea') {
      if (!v('f_title')) { toast('Give it a title'); return; }
      var name = (SB.user && (SB.user.user_metadata && SB.user.user_metadata.display_name)) || (SB.user && SB.user.email && SB.user.email.split('@')[0]) || 'Participant';
      addOpportunity({ title: v('f_title'), function: v('f_fn'), pain: v('f_pain'), direction: v('f_direction'), raisedBy: name, phase: 'Data foundations', surface: 'Claude Chat', build: 'Skill', confidence: 'Medium' }, 'Participant');
      closeSheet(); toast('On the board'); return;
    }
    if (SHEET.kind === 'op') {
      var data = { title: v('f_title'), function: v('f_fn'), status: v('f_status'), phase: v('f_phase'), surface: v('f_surface'), build: v('f_build'), pain: v('f_pain'), direction: v('f_direction'), systems: v('f_systems'), cluster: v('f_cluster'), raisedBy: v('f_raisedBy'), owner: v('f_owner'), quote: v('f_quote'), notes: v('f_notes') };
      if (!data.title) { toast('A title is needed'); return; }
      if (SHEET.id) {
        var o = findOp(SHEET.id);
        Object.assign(o, { title: data.title, fn: data.function, status: data.status, phase: data.phase, surface: data.surface, build: data.build, pain: data.pain, direction: data.direction, systems: data.systems.split(',').map(function (x) { return x.trim(); }).filter(Boolean), cluster: data.cluster, raisedBy: data.raisedBy, owner: data.owner, quote: data.quote, notes: data.notes });
        pushOp(o, ['title', 'fn', 'status', 'phase', 'surface', 'build', 'pain', 'direction', 'systems', 'cluster', 'raisedBy', 'owner', 'quote', 'notes']);
      } else { addOpportunity(data, 'Room'); }
    } else {
      var sd = { name: v('f_name'), category: v('f_category'), usedBy: v('f_usedBy'), connector: v('f_connector'), note: v('f_note') };
      if (!sd.name) { toast('A name is needed'); return; }
      if (SHEET.id) { var sys = S.systems.filter(function (x) { return x.id === SHEET.id; })[0]; Object.assign(sys, sd); pushSys(sys); }
      else if (SBA()) SB.insertSystem(Object.assign({ status: 'assumed' }, sd)).catch(function () {});
      else S.systems.push(Object.assign({ id: 's' + uid(), status: 'assumed' }, sd));
    }
    save(); closeSheet(); render(); updateBadge();
  }
  function deleteSheet() {
    if (SHEET.kind === 'op') { if (!confirm('Delete ' + SHEET.id + '? Consider Parked instead; deleted ideas leave no trace.')) return; var dop = findOp(SHEET.id); if (dop && SBA() && dop.uid) SB.deleteOpportunity(dop.uid).catch(function () {}); S.opportunities = S.opportunities.filter(function (o) { return o.id !== SHEET.id; }); }
    else { var dsys = S.systems.filter(function (x) { return x.id === SHEET.id; })[0]; if (dsys && SBA() && dsys.uid) SB.deleteSystem(dsys.uid).catch(function () {}); S.systems = S.systems.filter(function (s) { return s.id !== SHEET.id; }); }
    save(); closeSheet(); render(); updateBadge();
  }

  /* ------------------------------------------------------------- export -- */
  function exportXlsx() {
    if (!window.XLSX) { exportCsv(); return; }
    var wb = XLSX.utils.book_new();
    var opsRows = S.opportunities.map(function (o) {
      return { ID: o.id, Opportunity: o.title, Function: o.fn, 'Process phase': o.phase, Cluster: o.cluster, 'Claude surface': o.surface, 'Build type': o.build, Status: o.status,
        'Problem / pain': o.pain, 'What Claude does': o.direction, Systems: o.systems.join(', '), 'Source quote': o.quote, 'Raised by': o.raisedBy, Owner: o.owner, Source: o.source, Confidence: o.confidence, Votes: o.votes,
        'Value (client 1-5)': o.value == null ? '' : o.value, 'Ease (consultant 1-5)': o.ease == null ? '' : o.ease, Notes: o.notes, Captured: new Date(o.createdAt).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }) };
    });
    var ws1 = XLSX.utils.json_to_sheet(opsRows.length ? opsRows : [{ ID: '', Opportunity: '' }]);
    ws1['!cols'] = [6, 44, 11, 28, 16, 16, 16, 11, 50, 60, 24, 40, 14, 14, 10, 10, 6, 10, 10, 30, 20].map(function (w) { return { wch: w }; });
    XLSX.utils.book_append_sheet(wb, ws1, 'Opportunity Register');
    var ideas = CFG.blindSpots.concat(S.secondAI).map(function (i) { return { ID: i.id, Idea: i.title, Function: i.fn, 'Process phase': i.phase, 'Claude surface': i.surface, 'Build type': i.build, 'What it is': i.what, 'Why they did not raise it': i.why, 'How it lifts the north star': i.lift, Comparator: i.comparator, Confidence: i.confidence, Origin: i.id.charAt(0) === 'A' ? 'Claude, from the transcript' : 'Consultant, prepared' }; });
    var ws2 = XLSX.utils.json_to_sheet(ideas); ws2['!cols'] = [5, 44, 11, 28, 16, 16, 60, 60, 30, 30, 10, 22].map(function (w) { return { wch: w }; });
    XLSX.utils.book_append_sheet(wb, ws2, 'New Ideas');
    var ws3 = XLSX.utils.json_to_sheet(S.systems.map(function (s) { return { System: s.name, Category: s.category, 'Used by': s.usedBy, 'Claude reach': s.connector, Status: s.status, Note: s.note }; }));
    ws3['!cols'] = [18, 16, 20, 26, 10, 60].map(function (w) { return { wch: w }; });
    XLSX.utils.book_append_sheet(wb, ws3, 'Systems');
    var ws4 = XLSX.utils.json_to_sheet(CFG.phases.map(function (p) { return { Phase: p.name, Function: p.fn, 'What happens': p.what, '# opportunities': opCountFor(p.name).length }; }));
    ws4['!cols'] = [34, 11, 70, 14].map(function (w) { return { wch: w }; });
    XLSX.utils.book_append_sheet(wb, ws4, 'Lifecycle Map');
    var ws5 = XLSX.utils.aoa_to_sheet([['AI opportunity workshop: ' + CFG.client.name + ' Finance and Purchasing'], ['Exported', new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' })], ['North star', CFG.client.northStar], ['Scope criterion', CFG.client.scopeCriterion], [], ['Tabs', 'Opportunity Register (client-raised and AI-heard), New Ideas (the second viewpoint), Systems, Lifecycle Map'], ['Scoring', 'Client owns Value; consultant owns Ease. Fill the two columns in the register, then build the 2x2 in the prioritisation session.']]);
    ws5['!cols'] = [{ wch: 18 }, { wch: 100 }];
    XLSX.utils.book_append_sheet(wb, ws5, 'Read Me');
    var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    var name = 'WoS-AI-opportunities-' + new Date().toISOString().slice(0, 10) + '.xlsx';
    deliverFile(name, new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  }
  function exportCsv() {
    var cols = ['id', 'title', 'fn', 'phase', 'cluster', 'surface', 'build', 'status', 'pain', 'direction', 'systems', 'quote', 'raisedBy', 'owner', 'source', 'confidence', 'votes', 'notes'];
    var q = function (v) { v = Array.isArray(v) ? v.join('; ') : String(v == null ? '' : v); return '"' + v.replace(/"/g, '""') + '"'; };
    var lines = [cols.join(',')].concat(S.opportunities.map(function (o) { return cols.map(function (c) { return q(o[c]); }).join(','); }));
    toast('Spreadsheet library missing, exporting CSV instead');
    deliverFile('WoS-AI-opportunities-' + new Date().toISOString().slice(0, 10) + '.csv', new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }));
  }
  function deliverFile(name, blob) {
    if (CAP.downloads) { CAP.downloads.save({ filename: name, data: blob }).then(function () { toast('Saved ' + name); }).catch(function (e) { if (e && e.code !== 'declined') { log('download: ' + e.code); anchorDownload(name, blob); } }); return; }
    anchorDownload(name, blob);
  }
  function anchorDownload(name, blob) { var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000); toast('Exported ' + name); }
  function exportJson() { deliverFile('WoS-board-' + new Date().toISOString().slice(0, 10) + '.json', new Blob([JSON.stringify({ opportunities: S.opportunities, systems: S.systems, secondAI: S.secondAI, transcript: S.transcript }, null, 2)], { type: 'application/json' })); }
  function importJson() {
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json';
    inp.onchange = function () { var f = inp.files[0]; if (!f) return; f.text().then(function (t) { var j = JSON.parse(t); var n = 0; (j.opportunities || []).forEach(function (o) { if (addOpportunity(Object.assign({}, o, { function: o.fn || o.function }), o.source || 'Room')) n++; }); if (j.systems) S.systems = j.systems; save(); render(); toast('Imported ' + n + ' opportunities'); }).catch(function () { toast('That file did not parse'); }); };
    inp.click();
  }

  /* ------------------------------------------------------------- events -- */
  var toastT = null;
  function toast(msg) { var t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 2600); }

  function bind() {
    $('#navlist').addEventListener('click', function (e) { var b = e.target.closest('.navbtn'); if (b) go(b.dataset.view); });
    $('#btnTimer').addEventListener('click', toggleTimer);
    $('#btnNext').addEventListener('click', function () { gotoBlock(S.agendaIdx + 1); });
    $('#btnPresent').addEventListener('click', togglePresent);
    $('#sheetClose').addEventListener('click', closeSheet); $('#sheetBackdrop').addEventListener('click', closeSheet);
    $('#sheetSave').addEventListener('click', saveSheet); $('#sheetDelete').addEventListener('click', deleteSheet);
    $('#btnHelp').addEventListener('click', openHelp); $('#helpClose').addEventListener('click', closeHelp); $('#helpBackdrop').addEventListener('click', closeHelp);

    var view = $('#view');
    view.addEventListener('click', function (e) {
      var b = e.target.closest('[data-action]');
      if (b) { handleAction(b.dataset.action, b, e); return; }
      var nv = e.target.closest('[data-view]'); if (nv) { go(nv.dataset.view); return; }
      var seg;
      if ((seg = e.target.closest('#opsMode button'))) { UI.opsMode = seg.dataset.m; render(); return; }
      if ((seg = e.target.closest('#fnFilter button'))) { UI.filter.fn = seg.dataset.f; render(); return; }
      if ((seg = e.target.closest('#themeSeg button'))) { S.settings.theme = seg.dataset.t; applyTheme(); save(); render(); return; }
      if ((seg = e.target.closest('[data-sysstatus] button'))) { var sys = S.systems.filter(function (x) { return x.id === seg.parentNode.dataset.sysstatus; })[0]; if (sys) { sys.status = seg.dataset.st; save(); render(); pushSys(sys); } return; }
      var ph = e.target.closest('.phase'); if (ph && !e.target.closest('button,a')) { ph.classList.toggle('open'); return; }
      var blk = e.target.closest('.block'); if (blk && !e.target.closest('button')) { blk.classList.toggle('block--open'); }
    });
    view.addEventListener('change', function (e) {
      var t = e.target;
      if (t.id === 'stFilter') { UI.filter.status = t.value; render(); return; }
      if (t.id === 'autoExtract') { S.settings.autoExtract = t.checked; save(); if (t.checked) scheduleExtract(); return; }
      if (t.id === 'wisprMeeting') { S.settings.wisprMeetingId = t.value; save(); return; }
      if (t.tagName === 'SELECT' && t.dataset.field && t.dataset.id) { var o = findOp(t.dataset.id); if (o) { o[t.dataset.field] = t.value; save(); updateBadge(); pushOp(o, [t.dataset.field]); } }
    });
    view.addEventListener('input', function (e) { if (e.target.id === 'qFilter') { UI.filter.q = e.target.value; clearTimeout(UI.qT); UI.qT = setTimeout(function () { var v = $('#qFilter'); var pos = v.selectionStart; render(); var nv = $('#qFilter'); if (nv) { nv.focus(); nv.setSelectionRange(pos, pos); } }, 350); } });
    view.addEventListener('focusout', function (e) {
      var t = e.target; if (!t.dataset || !t.dataset.field || !t.isContentEditable) return;
      var row = t.closest('[data-op]'); if (!row) return; var o = findOp(row.dataset.op); if (!o) return;
      var val = t.textContent.trim();
      if (t.dataset.field === 'systems') o.systems = val.split(',').map(function (x) { return x.trim(); }).filter(Boolean); else o[t.dataset.field] = val;
      save(); pushOp(o, [t.dataset.field]);
      if (UI.pendingRender) { UI.pendingRender = false; setTimeout(render, 50); }
    });
    view.addEventListener('keydown', function (e) {
      if (e.target.id === 'manualBox' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleAction('addmanual'); }
      if (e.target.isContentEditable && e.key === 'Enter' && !e.shiftKey && e.target.classList.contains('op__title')) { e.preventDefault(); e.target.blur(); }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeSheet(); closeHelp(); return; }
      if (e.target.matches('input,textarea,select,[contenteditable]') || $('#sheet').classList.contains('open') || $('#help').classList.contains('open')) return;
      var map = { '1': 'runsheet', '2': 'systems', '3': 'process', '4': 'opportunities', '5': 'second', '6': 'live', '7': 'settings' };
      if (map[e.key]) { if ((UI.present || MODE.role === 'participant') && (e.key === '1' || e.key === '6' || e.key === '7')) return; go(map[e.key]); }
      else if (e.key === 'p' || e.key === 'P') togglePresent();
      else if (e.key === ' ') { e.preventDefault(); toggleTimer(); }
      else if (e.key === 'n' || e.key === 'N') gotoBlock(S.agendaIdx + 1);
    });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tickTimer(); });
  }

  function handleAction(a, b) {
    switch (a) {
      case 'start': gotoBlock(0); break;
      case 'goto': gotoBlock(parseInt(b.dataset.i, 10)); break;
      case 'toggleask': b.closest('.block').classList.toggle('block--open'); break;
      case 'addsystem': openSheet('sys', null); break;
      case 'editsystem': openSheet('sys', b.dataset.id); break;
      case 'newop': openSheet('op', null); if (b && b.dataset.phase) { $('#f_phase').value = b.dataset.phase; $('#f_fn').value = b.dataset.fn === 'Both' ? 'Both' : b.dataset.fn; } break;
      case 'edit': openSheet('op', b.dataset.id); break;
      case 'validate': var o = findOp(b.dataset.id); if (o) { o.status = 'Validated'; save(); render(); pushOp(o, ['status']); } break;
      case 'vote': var op = findOp(b.dataset.id); if (op) { if (SBA()) { if (op.uid) SB.vote(op.uid, parseInt(b.dataset.d, 10)); } else { op.votes = Math.max(0, op.votes + parseInt(b.dataset.d, 10)); save(); render(); } } break;
      case 'newidea': openSheet('idea', null); break;
      case 'export': exportXlsx(); break;
      case 'exportjson': exportJson(); break;
      case 'importjson': importJson(); break;
      case 'reveal': S.revealed = true; UI.seq++; save(); render(); updateBadge(); if (SBA()) SB.updateWorkshop({ revealed: true }).catch(function () {}); generateSecond().then(function () { UI.seq++; if (UI.view === 'second') render(); }); break;
      case 'regen': generateSecond().then(function () { UI.seq++; if (UI.view === 'second') render(); }); break;
      case 'reseal': S.revealed = false; save(); render(); updateBadge(); if (SBA()) SB.updateWorkshop({ revealed: false }).catch(function () {}); break;
      case 'copylink': copyText(participantLink()); break;
      case 'sendlink': authSendLink(); break;
      case 'joincode': authJoin(); break;
      case 'signout': SB.signOut(); break;
      case 'openws': location.href = location.pathname + '?w=' + encodeURIComponent(b.dataset.slug); break;
      case 'createws': adminCreateWorkshop(); break;
      case 'showtoken': SB.bridgeToken().then(function (t) { var el = $('#bridgeToken'); if (el) el.textContent = t; }); break;
      case 'copytoken': SB.bridgeToken().then(copyText); break;
      case 'promote': var idea = CFG.blindSpots.concat(S.secondAI).filter(function (i) { return i.id === b.dataset.id; })[0]; if (idea) { var ok = addOpportunity({ title: idea.title, function: idea.fn, phase: idea.phase, surface: idea.surface, build: idea.build, pain: '', direction: idea.what, systems: [], quote: '', raisedBy: idea.id.charAt(0) === 'A' ? 'Claude' : 'Consultant', notes: 'Why not raised: ' + idea.why, confidence: idea.confidence }, 'Consultant'); save(); toast(ok ? 'On the board' : 'Already on the board'); } break;
      case 'src-mic': startSpeech(); break;
      case 'src-wispr': startWispr(); break;
      case 'src-feed': startFeed(); break;
      case 'src-demo': startDemo(); break;
      case 'stopsrc': stopSources(); break;
      case 'addmanual': var box = $('#manualBox'); if (box && box.value.trim()) { addTranscript(box.value, S.settings.facilitatorName === 'Facilitator' ? 'dictation' : S.settings.facilitatorName); box.value = ''; } break;
      case 'extract': extractNow(true); break;
      case 'cleartranscript': if (confirm('Clear the captured transcript? The board stays.')) { S.transcript = []; S.consumedChars = 0; save(); render(); } break;
      case 'savesettings':
        var g = function (id) { var el = $('#' + id); return el ? el.value.trim() : null; };
        S.settings.apiKey = g('setKey') || ''; S.settings.model = g('setModel') || 'claude-opus-5';
        S.settings.pollSec = Math.max(20, parseInt(g('setPoll'), 10) || 60); S.settings.minChars = Math.max(80, parseInt(g('setMin'), 10) || 220);
        S.settings.feedUrl = g('setFeed') || ''; S.settings.feedPollSec = Math.max(10, parseInt(g('setFeedPoll'), 10) || 30);
        if ($('#setWisprPoll')) S.settings.wisprPollSec = Math.max(30, parseInt(g('setWisprPoll'), 10) || 45);
        if ($('#wisprMeeting')) S.settings.wisprMeetingId = $('#wisprMeeting').value;
        save(); setModeStatus(); toast('Settings saved'); break;
      case 'resetall': if (confirm('Reset everything on this board? Export first if you want to keep it.')) { localStorage.removeItem('wos.state'); location.reload(); } break;
      case 'openhelp': openHelp(); break;
      case 'dismissguide': try { localStorage.setItem('wos.guide', '1'); } catch (e) {} render(); break;
      case 'resetsystems': S.systems = JSON.parse(JSON.stringify(CFG.systems)); save(); toast('Systems reset'); break;
    }
  }
  function guideDismissed() { try { return !!localStorage.getItem('wos.guide'); } catch (e) { return false; } }
  function openHelp() { $('#helpBody').innerHTML = HELP.guideHtml(); $('#help').classList.add('open'); $('#help').setAttribute('aria-hidden', 'false'); $('#helpBackdrop').classList.add('open'); $('#helpBody').scrollTop = 0; }
  function closeHelp() { $('#help').classList.remove('open'); $('#help').setAttribute('aria-hidden', 'true'); $('#helpBackdrop').classList.remove('open'); try { localStorage.setItem('wos.seen', '1'); } catch (e) {} }
  function togglePresent() { UI.present = !UI.present; document.body.classList.toggle('present', UI.present); $('#btnPresent').textContent = UI.present ? 'Exit present' : 'Present'; if (UI.present && (UI.view === 'live' || UI.view === 'settings')) go('opportunities'); }
  function applyTheme() { var t = S.settings.theme; if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme'); try { if (t) localStorage.setItem('wos.theme', t); else localStorage.removeItem('wos.theme'); } catch (e) {} }

  /* ------------------------------------------------------ backend glue -- */
  function participantLink() { return location.origin + location.pathname + '?w=' + encodeURIComponent(SB.ws ? SB.ws.slug : ''); }
  function copyText(t) { if (!t) return; (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { toast('Copied'); }, function () { prompt('Copy this', t); }); }
  function renderSoon() {
    var a = document.activeElement;
    if (a && $('#view').contains(a) && a.matches('input,textarea,select,[contenteditable]')) { UI.pendingRender = true; return; }
    if ($('#sheet').classList.contains('open')) { UI.pendingRender = true; return; }
    render();
  }
  function applyData(p) {
    if (p.workshop) {
      var w = p.workshop;
      CFG = Object.assign({}, SEED, w.config || {});
      if (!CFG.blindSpots || p.second) CFG.blindSpots = CFG.blindSpots || [];
      $('#brandClient').textContent = (CFG.client && CFG.client.name) || w.title;
      S.agendaIdx = typeof w.current_block === 'number' ? w.current_block : -1;
      S.timer = { running: !!w.timer_running, startedAt: w.block_started_at ? Date.parse(w.block_started_at) : now(), elapsedBefore: Number(w.timer_elapsed_ms || 0) };
      S.revealed = !!w.revealed; S.consumedChars = w.consumed_chars || 0;
    }
    if (p.systems) S.systems = p.systems.map(function (r) { return { id: r.id, uid: r.id, name: r.name, category: r.category || '', usedBy: r.used_by || '', connector: r.connector || '', status: r.status, note: r.note || '' }; });
    if (p.opportunities) S.opportunities = p.opportunities;
    if (p.second) {
      var toIdea = function (r, n) { return { id: r.key || ('A' + (n + 1)), title: r.title, fn: r.fn, phase: r.phase, surface: r.surface, build: r.build, what: r.what, why: r.why, lift: r.lift, comparator: r.comparator, confidence: r.confidence, fromAI: r.origin === 'ai' }; };
      CFG.blindSpots = p.second.filter(function (r) { return r.origin === 'consultant'; }).map(toIdea);
      S.secondAI = p.second.filter(function (r) { return r.origin === 'ai'; }).map(toIdea);
    }
    if (p.transcript) S.transcript = p.transcript.map(function (c) { return { t: Date.parse(c.t) || now(), text: c.text, src: c.src || 'bridge' }; });
    updateBadge(true); tickTimer();
    if (!p.full) renderSoon(); else render();
    if (p.workshop && MODE.role === 'participant' && S.revealed && UI.view === 'second') {}
  }
  function authScreen(kind, slug, extra) {
    document.body.classList.add('auth');
    var j = SB.ls('wos.join') || {};
    var code = SB.param('code') || j.code || '';
    var html = '<div class="authcard card">';
    if (kind === 'loading') html += '<h2>Opening the workshop…</h2>';
    else if (kind === 'sent') html += '<h2>Check your email</h2><p class="muted">We sent a sign-in link to <b>' + esc(extra) + '</b>. Open it on this device and you land straight in the room. It can take a minute to arrive.</p>';
    else if (kind === 'join') html += '<h2>Enter the join code</h2><p class="muted">The facilitator has it on the screen.</p><label class="field">Your name<input id="a_name" value="' + esc(j.name || '') + '"></label><label class="field">Join code<input id="a_code" value="' + esc(code) + '" autocapitalize="characters"></label><div class="row"><button class="btn btn--primary" data-action="joincode">Join</button><button class="btn btn--ghost" data-action="signout">Sign out</button></div>';
    else html += '<h2>Sign in to the board</h2><p class="muted">No password. We email you a link.</p>' +
      '<label class="field">Your name<input id="a_name" value="' + esc(j.name || '') + '" placeholder="Priya"></label>' +
      '<label class="field">Work email<input id="a_email" type="email" placeholder="you@company.com" autocomplete="email"></label>' +
      (slug ? '<label class="field">Join code (on the screen)<input id="a_code" value="' + esc(code) + '"></label>' : '') +
      '<div class="row"><button class="btn btn--primary" data-action="sendlink">Email me a link</button></div><p class="small muted" id="a_msg"></p>';
    html += '</div>';
    $('#view').innerHTML = html;
    var f = $('#a_email') || $('#a_code'); if (f) f.focus();
  }
  function authSendLink() {
    var email = ($('#a_email') || {}).value || '', name = ($('#a_name') || {}).value || '', code = ($('#a_code') || {}).value || '';
    email = email.trim(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('That email does not look right'); return; }
    var slug = SB.param('w');
    $('#a_msg').textContent = 'Sending…';
    SB.sendLink(email, name.trim(), slug, code.trim()).then(function () { authScreen('sent', slug, email); }).catch(function (e) { $('#a_msg').textContent = 'Could not send: ' + (e.message || e); });
  }
  function authJoin() {
    var code = ($('#a_code') || {}).value || '', name = ($('#a_name') || {}).value || '';
    if (!code.trim()) { toast('Enter the code'); return; }
    authScreen('loading');
    SB.joinWithCode(SB.param('w'), code.trim(), name.trim()).then(enterWorkshop).catch(function (e) { toast(e.message || 'Wrong code'); authScreen('join', SB.param('w')); });
  }
  function enterWorkshop(r) {
    if (r && r.error) { if (r.error === 'join') { authScreen('join', SB.param('w')); return; } toast(r.error); authScreen('join', SB.param('w')); return; }
    document.body.classList.remove('auth');
    MODE.sb = true; MODE.role = SB.role;
    document.body.classList.toggle('participant', SB.role === 'participant');
    setModeStatus(); probeCapabilities();
    var start = SB.role === 'participant' ? 'opportunities' : (S.agendaIdx >= 0 && CFG.agenda[S.agendaIdx] ? CFG.agenda[S.agendaIdx].view : 'runsheet');
    go(start);
    var seen = false; try { seen = !!localStorage.getItem('wos.seen'); } catch (e) {}
    if (!seen && SB.role !== 'participant') openHelp();
  }
  function route() {
    var slug = SB.param('w');
    if (!SB.user) { authScreen('login', slug); return; }
    if (!slug) { document.body.classList.remove('auth'); MODE.sb = true; MODE.role = 'facilitator'; setModeStatus(); go('settings'); return; }
    authScreen('loading', slug);
    SB.openWorkshop(slug).then(enterWorkshop).catch(function (e) { toast(e.message || 'Could not open'); authScreen('join', slug); });
  }
  function settingsAccount() {
    var w = SB.ws;
    var h = '<div class="card stack"><h3>Account</h3><div class="kv"><span class="k">Signed in</span><span>' + esc(SB.user.email) + '</span><span class="k">Role</span><span>' + esc(SB.role || 'no workshop open') + '</span></div><div class="row"><button class="btn btn--ghost btn--sm" data-action="signout">Sign out</button></div></div>';
    if (w && SB.role === 'facilitator') {
      h += '<div class="card stack"><h3>This workshop: ' + esc(w.title) + '</h3>' +
        '<div class="kv"><span class="k">Participant link</span><span><code>' + esc(participantLink()) + '</code> <button class="btn btn--sm" data-action="copylink">Copy</button></span>' +
        '<span class="k">Join code</span><span><b>' + esc(w.join_code) + '</b></span>' +
        '<span class="k">Dots per person</span><span>' + w.max_dots + '</span>' +
        '<span class="k">Bridge token</span><span><code id="bridgeToken">hidden</code> <button class="btn btn--sm btn--ghost" data-action="showtoken" data-tip="Reveals the secret a Claude Code or Cowork session uses to post transcript and ideas into this workshop through /api/ingest. See docs/WISPR-BRIDGE.md.">Show</button> <button class="btn btn--sm btn--ghost" data-action="copytoken">Copy</button></span>' +
        '<span class="k">Workshop id</span><span><code>' + esc(w.id) + '</code></span></div>' +
        '<div id="membersList" class="small muted">Loading members…</div></div>';
    }
    h += '<div class="card stack" id="adminCard"><h3>Workshops</h3><div id="wsList" class="small muted">Loading…</div>' +
      '<details><summary style="cursor:pointer;font-weight:700">New workshop</summary><div class="stack" style="margin-top:10px">' +
      '<div class="field-row"><label class="field">Organisation<select id="n_org"><option value="">New organisation…</option></select></label><label class="field">New organisation name<input id="n_orgname" placeholder="Watches of Switzerland"></label></div>' +
      '<div class="field-row"><label class="field">Workshop title<input id="n_title" placeholder="Finance and Purchasing ideation"></label><label class="field">Client name shown on the board<input id="n_client" placeholder="Watches of Switzerland"></label></div>' +
      '<div class="field-row"><label class="field">Teams in the room (comma separated)<input id="n_fns" value="Finance, Purchasing"></label><label class="field">Join code<input id="n_code" value="' + esc(String(Math.floor(1000 + Math.random() * 9000))) + '"></label><label class="field">Dots per person<input id="n_dots" type="number" value="3" min="1" max="10"></label></div>' +
      '<label class="field">North star<input id="n_north" value="' + esc(SEED.client.northStar) + '"></label><label class="field">Scope test<input id="n_scope" value="' + esc(SEED.client.scopeCriterion) + '"></label>' +
      '<p class="small muted">Phases, run sheet, question bank, systems and the twelve prepared blind spots are copied from the Watches of Switzerland template. Edit them afterwards in the board.</p>' +
      '<div class="row"><button class="btn btn--primary" data-action="createws">Create workshop</button></div></div></details></div>';
    return h;
  }
  function fillAdmin() {
    if (!(window.SB && SB.user)) return;
    Promise.all([SB.listOrgs(), SB.listWorkshops()]).then(function (r) {
      var orgs = r[0], wss = r[1], sel = $('#n_org'), list = $('#wsList');
      if (sel) sel.innerHTML = '<option value="">New organisation…</option>' + orgs.map(function (o) { return '<option value="' + esc(o.id) + '">' + esc(o.name) + '</option>'; }).join('');
      if (list) list.innerHTML = wss.length ? '<table class="reg" style="min-width:0"><thead><tr><th>Workshop</th><th>Organisation</th><th>Code</th><th></th></tr></thead><tbody>' + wss.map(function (w) { var o = orgs.filter(function (x) { return x.id === w.org_id; })[0]; return '<tr><td>' + esc(w.title) + '</td><td>' + esc(o ? o.name : '') + '</td><td>' + esc(w.join_code) + '</td><td><button class="btn btn--sm" data-action="openws" data-slug="' + esc(w.slug) + '">Open</button></td></tr>'; }).join('') + '</tbody></table>' : 'No workshops yet. Create one below.';
    }).catch(function (e) { log('admin: ' + (e.message || e)); });
    if (SB.ws && SB.role === 'facilitator') SB.members().then(function (ms) {
      var el = $('#membersList'); if (!el) return;
      el.innerHTML = '<b>' + ms.length + ' member' + (ms.length === 1 ? '' : 's') + '</b>: ' + ms.map(function (m) { return esc(m.display_name || m.email || '?') + ' (' + m.role + ')'; }).join(', ');
    });
  }
  function adminCreateWorkshop() {
    var v = function (id) { var el = $('#' + id); return el ? el.value.trim() : ''; };
    var title = v('n_title'), client = v('n_client') || title; if (!title) { toast('Give the workshop a title'); return; }
    var slugify = function (t) { return t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + Math.random().toString(36).slice(2, 6); };
    var fns = v('n_fns').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    var cfg = JSON.parse(JSON.stringify(SEED));
    cfg.client = Object.assign({}, SEED.client, { name: client, short: client, functions: fns, northStar: v('n_north') || SEED.client.northStar, scopeCriterion: v('n_scope') || SEED.client.scopeCriterion });
    var tags = fns.concat(['Both', 'Org-wide']); cfg.functionsTags = tags;
    var orgP = v('n_org') ? Promise.resolve({ id: v('n_org') }) : (v('n_orgname') ? SB.createOrg(v('n_orgname'), slugify(v('n_orgname'))) : Promise.reject(new Error('Pick an organisation or name a new one')));
    orgP.then(function (org) { return SB.createWorkshop(org.id, { slug: slugify(title), title: title, joinCode: v('n_code') || '1234', maxDots: parseInt(v('n_dots'), 10) || 3 }, cfg); })
      .then(function (w) { toast('Created. Opening…'); location.href = location.pathname + '?w=' + encodeURIComponent(w.slug); })
      .catch(function (e) { toast(e.message || 'Could not create'); });
  }

  /* --------------------------------------------------------------- boot -- */
  load();
  applyTheme();
  $('#brandClient').textContent = CFG.client.name;
  bind();
  RUN.lastCount = S.opportunities.length;
  updateBadge(false);
  setInterval(tickTimer, 500); tickTimer();
  if (window.HELP) HELP.mount();
  function localBoot() {
    go(S.agendaIdx >= 0 && CFG.agenda[S.agendaIdx] ? CFG.agenda[S.agendaIdx].view : 'runsheet');
    setModeStatus();
    probeCapabilities();
    var seen = false; try { seen = !!localStorage.getItem('wos.seen'); } catch (e) {}
    if (window.HELP && !seen) openHelp();
    if (S.settings.autoExtract && fullTranscript().length > S.consumedChars) scheduleExtract();
  }
  if (window.SB) {
    SB.init().then(function (ok) {
      if (!ok) { localBoot(); return; }
      S.opportunities = []; S.transcript = []; S.secondAI = []; S.revealed = false; S.agendaIdx = -1; S.blockDone = {};
      SB.on('data', applyData); SB.on('toast', toast); SB.on('auth', route);
      route();
    }).catch(function () { localBoot(); });
  } else localBoot();

  window.WOS = { state: S, addTranscript: addTranscript, addOpportunity: addOpportunity, extractNow: extractNow, exportXlsx: exportXlsx };
})();
